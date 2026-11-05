//! 账户：离线账户、微软设备码登录（可取消）、外置登录三步（探测服务器、认证、多角色时选角色）、
//! 刷新账户信息与多账户读写。
//!
//! 绝不把含令牌的 [`Account`] 整体过 IPC，一律摘成不含令牌的 [`AccountDto`]。外置登录等待选角色
//! 期间的令牌只留在后端内存的 [`AuthlibPendingSlot`] 里，前端只拿到一个随机的待选 id。
//! 账户库读写是同步文件 IO 与 DPAPI 调用，一律放进阻塞线程池，不占异步工作线程，也不持门面锁。

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, MutexGuard, PoisonError};
use std::time::Duration;

use petalfall_core::{
    Account, AccountCredentials, AccountStatus, AccountType, AheadOutcome, AuthServerInfo,
    AuthlibLogin, AuthlibPending, CancellationToken, DeviceCodeResponse, Petalfall,
    SettledRenewals, TextureService, RENEW_AHEAD_CHECK_EVERY,
};
use serde::Serialize;
use tauri::{AppHandle, Manager, State};

use crate::commands::art::{skin_info_dto, SkinInfoDto};
use crate::commands::CommandError;
use crate::events::{self, CoreEventForwarder, DEVICE_CODE_EVENT};
use crate::facade::Facade;

/// 账户 DTO：不含任何 access/refresh 令牌。时间均为 Unix 毫秒。
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct AccountDto {
    pub uuid: String,
    pub name: String,
    pub account_type: AccountType,
    /// 外置登录的验证服务器名；其余类型为 null。
    pub auth_server: Option<String>,
    /// 外置登录的 API 根地址，可原样交回 `authlib_login` 的 server_url；其余类型为 null。
    pub server_url: Option<String>,
    /// 外置登录时填的账号（邮箱或用户名），重新登录时预填；其余类型、或这一项加入之前登录的记录为 null。
    pub username: Option<String>,
    pub added_at: u64,
    /// `ok` 或 `expired`（需要重新登录）。
    pub status: AccountStatus,
    /// 最近一次成功验证或续期的时刻；离线账户恒为 null。
    pub last_verified_at: Option<u64>,
}

pub(crate) fn account_dto(account: &Account) -> AccountDto {
    let (server_url, username) = match &account.credentials {
        AccountCredentials::AuthlibInjector(creds) => {
            (Some(creds.api_root.clone()), creds.username.clone())
        }
        AccountCredentials::Microsoft(_) | AccountCredentials::Offline => (None, None),
    };
    AccountDto {
        uuid: account.uuid.clone(),
        name: account.name.clone(),
        account_type: account.account_type,
        auth_server: account.auth_server.clone(),
        server_url,
        username,
        added_at: account.added_at,
        status: account.status,
        last_verified_at: account.last_verified_at,
    }
}

/// 微软设备码 DTO：经 [`DEVICE_CODE_EVENT`] 推给前端，展示待输入短码与验证网址。
#[derive(Debug, Serialize, Clone)]
pub struct DeviceCodeDto {
    pub user_code: String,
    pub verification_uri: String,
    pub expires_in: u64,
    pub interval: u64,
    pub message: String,
}

impl From<&DeviceCodeResponse> for DeviceCodeDto {
    fn from(device: &DeviceCodeResponse) -> Self {
        DeviceCodeDto {
            user_code: device.user_code.clone(),
            verification_uri: device.verification_uri.clone(),
            expires_in: device.expires_in,
            interval: device.interval,
            message: device.message.clone(),
        }
    }
}

/// 外置登录服务器探测结果 DTO。
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct AuthServerDto {
    pub api_root: String,
    pub server_name: String,
    pub host: String,
}

impl From<AuthServerInfo> for AuthServerDto {
    fn from(info: AuthServerInfo) -> Self {
        AuthServerDto {
            api_root: info.api_root,
            server_name: info.server_name,
            host: info.host,
        }
    }
}

/// 待选角色 DTO：角色 uuid、名字与皮肤（取不到皮肤时为 null，界面画剪影）。
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct AuthlibProfileDto {
    pub uuid: String,
    pub name: String,
    pub skin: Option<SkinInfoDto>,
}

/// 外置登录第一步的结果。
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum AuthlibLoginDto {
    /// 已登录并设为当前账户。
    LoggedIn { account: AccountDto },
    /// 账户下有多个角色：用 `pending_id` 与所选角色的 uuid 调 `select_authlib_profile`。
    SelectProfile {
        pending_id: String,
        server_name: String,
        profiles: Vec<AuthlibProfileDto>,
    },
}

// ---- managed state ----

/// 正在进行的微软登录：编号 + 取消令牌。同一时刻只有一个登录，新的一次顶替旧的。
#[derive(Default)]
pub struct MicrosoftLoginSlot {
    current: Mutex<Option<(u64, CancellationToken)>>,
    next_id: AtomicU64,
}

impl MicrosoftLoginSlot {
    fn lock(&self) -> MutexGuard<'_, Option<(u64, CancellationToken)>> {
        // 槽里只有编号与令牌，中毒不携带需要放弃的状态。
        self.current.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// 登记一次新登录；已有登录在进行时先取消它——用户点「重新获取代码」时前一个可能还没结束。
    fn begin(&self) -> (u64, CancellationToken) {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let token = CancellationToken::new();
        if let Some((old_id, old)) = self.lock().replace((id, token.clone())) {
            tracing::info!(superseded = old_id, "新的微软登录顶替了尚未结束的上一次");
            old.cancel();
        }
        (id, token)
    }

    /// 登录结束时注销；槽里已换成更新的一次时不动它。
    fn finish(&self, id: u64) {
        let mut slot = self.lock();
        if slot.as_ref().is_some_and(|(current, _)| *current == id) {
            *slot = None;
        }
    }

    /// 取消正在进行的登录，返回此刻是否有登录在进行。
    pub fn cancel(&self) -> bool {
        match self.lock().take() {
            Some((_, token)) => {
                token.cancel();
                true
            }
            None => false,
        }
    }
}

/// 外置登录等待选角色的会话。只保留最近一次：重新走第一步会覆盖它。
///
/// 待选 id 只在本进程内寻址一份内存数据，用自增序号即可；它的作用是让过期的选择（被更新的一次
/// 登录顶替之后才点「使用这个角色」）报错，而不是绑到别的账户上。
#[derive(Default)]
pub struct AuthlibPendingSlot {
    current: Mutex<Option<(String, AuthlibPending)>>,
    next_id: AtomicU64,
}

impl AuthlibPendingSlot {
    fn lock(&self) -> MutexGuard<'_, Option<(String, AuthlibPending)>> {
        // 中毒时槽里至多是一份完整写入的待选会话，没有半写状态需要放弃。
        self.current.lock().unwrap_or_else(PoisonError::into_inner)
    }

    fn store(&self, pending: AuthlibPending) -> String {
        let id = format!("authlib-{}", self.next_id.fetch_add(1, Ordering::Relaxed));
        *self.lock() = Some((id.clone(), pending));
        id
    }

    fn get(&self, id: &str) -> Option<AuthlibPending> {
        self.lock()
            .as_ref()
            .filter(|(current, _)| current == id)
            .map(|(_, pending)| pending.clone())
    }

    fn clear(&self, id: &str) {
        let mut slot = self.lock();
        if slot.as_ref().is_some_and(|(current, _)| current == id) {
            *slot = None;
        }
    }
}

// ---- 共用 ----

/// 在快照上的阻塞线程池里读写账户库。
pub(crate) async fn with_accounts<T: Send + 'static>(
    facade: &Facade,
    work: impl FnOnce(&Petalfall) -> petalfall_core::Result<T> + Send + 'static,
) -> Result<T, CommandError> {
    on_blocking_pool(facade.snapshot().await, work).await
}

/// 账户库读写在进程级锁内做同步文件 IO 与 DPAPI 调用：放在异步工作线程上，锁被别处的写入占着时
/// 会连同这个线程上的事件转发、取图一起卡住。
async fn on_blocking_pool<T: Send + 'static>(
    petalfall: Petalfall,
    work: impl FnOnce(&Petalfall) -> petalfall_core::Result<T> + Send + 'static,
) -> Result<T, CommandError> {
    let joined = tokio::task::spawn_blocking(move || work(&petalfall)).await;
    Ok(joined.map_err(petalfall_core::CoreError::from)??)
}

/// 整理用户填的验证服务器地址：去空白、没写协议头时补 `https://`，只接受 http 与 https。
pub(crate) fn normalize_server_url(input: &str) -> Result<String, CommandError> {
    let trimmed = input.trim();
    if trimmed.is_empty() {
        return Err(CommandError::invalid_argument("验证服务器地址为空"));
    }
    let with_scheme = if trimmed.contains("://") {
        trimmed.to_owned()
    } else {
        format!("https://{trimmed}")
    };
    let url = tauri::Url::parse(&with_scheme).map_err(|e| {
        CommandError::invalid_argument(format!("这不是一个有效的网址：{input}（{e}）"))
    })?;
    if !matches!(url.scheme(), "http" | "https") || url.host_str().is_none_or(str::is_empty) {
        return Err(CommandError::invalid_argument(format!(
            "这不是一个有效的网址：{input}"
        )));
    }
    Ok(url.to_string())
}

// ---- 命令 ----

/// 读取当前账户（可能没有）。
#[tauri::command]
pub async fn current_account(
    facade: State<'_, Facade>,
) -> Result<Option<AccountDto>, CommandError> {
    let current = with_accounts(&facade, |petalfall| petalfall.current_account()).await?;
    Ok(current.as_ref().map(account_dto))
}

/// 全部账户：微软与外置在前，离线在后。
#[tauri::command]
pub async fn list_accounts(facade: State<'_, Facade>) -> Result<Vec<AccountDto>, CommandError> {
    let accounts = with_accounts(&facade, |petalfall| petalfall.accounts()).await?;
    Ok(accounts.iter().map(account_dto).collect())
}

/// 添加一个离线账户并设为当前账户。用户名的软性告警经 core-event 推送（task_id 为 null）。
#[tauri::command]
pub async fn create_offline_account(
    app: AppHandle,
    name: String,
    facade: State<'_, Facade>,
) -> Result<AccountDto, CommandError> {
    let events = CoreEventForwarder::to_app(&app, None);
    let sink = events.sink().clone();
    let added = with_accounts(&facade, move |petalfall| {
        petalfall.add_offline_account(&name, Some(&sink))
    })
    .await;
    events.finish().await;
    Ok(account_dto(&added?))
}

/// 微软设备码登录：拿到设备码时经 [`DEVICE_CODE_EVENT`] 推给前端，随后轮询直至令牌换取完成、
/// 账户落库并成为当前账户。
///
/// 全程在门面快照上运行、不持门面锁。`cancel_microsoft_login` 或新的一次登录会让它在 1000 ms 内
/// 以 `cancelled` 返回。
#[tauri::command]
pub async fn microsoft_login(
    app: AppHandle,
    facade: State<'_, Facade>,
    slot: State<'_, MicrosoftLoginSlot>,
) -> Result<AccountDto, CommandError> {
    microsoft_login_with(&facade, &slot, move |device| {
        events::emit(&app, DEVICE_CODE_EVENT, DeviceCodeDto::from(device))
    })
    .await
}

pub(crate) async fn microsoft_login_with(
    facade: &Facade,
    slot: &MicrosoftLoginSlot,
    on_code: impl FnOnce(&DeviceCodeResponse) + Send,
) -> Result<AccountDto, CommandError> {
    // 先登记再做任何 await：取消紧跟在发起之后到达时，也要能找到这次登录。
    let (id, token) = slot.begin();
    let outcome = async {
        let petalfall = facade.snapshot().await.with_cancel(token);
        Ok(account_dto(&petalfall.microsoft_login(on_code).await?))
    }
    .await;
    slot.finish(id);
    outcome
}

/// 取消正在进行的微软登录，返回此刻是否有登录在进行（没有也不是错误）。
#[tauri::command]
pub async fn cancel_microsoft_login(
    slot: State<'_, MicrosoftLoginSlot>,
) -> Result<bool, CommandError> {
    Ok(slot.cancel())
}

/// 探测外置登录验证服务器：解析 API 地址并取元数据，总时限 10000 ms。
///
/// 地址格式不对报 `invalid_argument`；连不上或超时报 `Http`；连上了但不是验证服务器报
/// `NotYggdrasilServer`。
#[tauri::command]
pub async fn probe_auth_server(
    url: String,
    facade: State<'_, Facade>,
) -> Result<AuthServerDto, CommandError> {
    let url = normalize_server_url(&url)?;
    let petalfall = facade.snapshot().await;
    Ok(petalfall.probe_auth_server(&url).await?.into())
}

/// 外置登录第一步：账号密码认证。能确定角色就直接登录；账户下多个角色时返回待选列表。
#[tauri::command]
pub async fn authlib_login(
    server_url: String,
    username: String,
    password: String,
    facade: State<'_, Facade>,
    pending: State<'_, AuthlibPendingSlot>,
    textures: State<'_, TextureService>,
) -> Result<AuthlibLoginDto, CommandError> {
    authlib_login_with(
        &facade,
        &pending,
        &textures,
        &server_url,
        &username,
        &password,
    )
    .await
}

pub(crate) async fn authlib_login_with(
    facade: &Facade,
    pending_slot: &AuthlibPendingSlot,
    textures: &TextureService,
    server_url: &str,
    username: &str,
    password: &str,
) -> Result<AuthlibLoginDto, CommandError> {
    let server_url = normalize_server_url(server_url)?;
    let petalfall = facade.snapshot().await;
    match petalfall
        .authlib_login(&server_url, username, password)
        .await?
    {
        AuthlibLogin::LoggedIn(account) => Ok(AuthlibLoginDto::LoggedIn {
            account: account_dto(&account),
        }),
        AuthlibLogin::SelectProfile(pending) => {
            let refs = petalfall.authlib_profile_skins(&pending).await;
            let skins = textures.skin_infos(refs).await;
            let profiles = pending
                .profiles
                .iter()
                .zip(skins)
                .map(|(profile, skin)| AuthlibProfileDto {
                    uuid: profile.id.clone(),
                    name: profile.name.clone(),
                    skin: skin.as_ref().map(skin_info_dto),
                })
                .collect();
            let server_name = pending.server.server_name.clone();
            let pending_id = pending_slot.store(pending);
            Ok(AuthlibLoginDto::SelectProfile {
                pending_id,
                server_name,
                profiles,
            })
        }
    }
}

/// 外置登录第二步：把待选会话绑定到所选角色，落库并设为当前账户。
///
/// 待选 id 已失效（被更新的一次登录顶替或已用过）、或角色不在待选列表里，报 `invalid_argument`。
/// 绑定失败时待选会话保留，可以重试。
#[tauri::command]
pub async fn select_authlib_profile(
    pending_id: String,
    profile_uuid: String,
    facade: State<'_, Facade>,
    pending: State<'_, AuthlibPendingSlot>,
) -> Result<AccountDto, CommandError> {
    select_authlib_profile_with(&facade, &pending, &pending_id, &profile_uuid).await
}

pub(crate) async fn select_authlib_profile_with(
    facade: &Facade,
    pending_slot: &AuthlibPendingSlot,
    pending_id: &str,
    profile_uuid: &str,
) -> Result<AccountDto, CommandError> {
    let pending = pending_slot.get(pending_id).ok_or_else(|| {
        CommandError::invalid_argument("这次外置登录的角色选择已失效，请重新登录")
    })?;
    let profile = pending
        .profiles
        .iter()
        .find(|p| p.id == profile_uuid)
        .cloned()
        .ok_or_else(|| {
            CommandError::invalid_argument(format!("角色 {profile_uuid} 不在这次登录的角色列表里"))
        })?;
    let petalfall = facade.snapshot().await;
    let account = petalfall.select_authlib_profile(&pending, &profile).await?;
    pending_slot.clear(pending_id);
    Ok(account_dto(&account))
}

/// 刷新账户信息。微软账户续期令牌并更新名字与皮肤；外置账户先验证令牌，仍有效时只从会话服务器
/// 更新名字与皮肤、不轮换令牌，失效时才刷新令牌。凭据被判定失效时账户转为 `expired` 并报
/// `ReloginRequired`。离线账户没有可刷新的凭据，报 `invalid_argument`。
#[tauri::command]
pub async fn refresh_account(
    uuid: String,
    facade: State<'_, Facade>,
) -> Result<AccountDto, CommandError> {
    let lookup = uuid.clone();
    let account = with_accounts(&facade, move |petalfall| petalfall.find_account(&lookup))
        .await?
        .ok_or_else(|| {
            CommandError::from(petalfall_core::AuthError::AccountNotFound(uuid.clone()))
        })?;
    if account.account_type == AccountType::Offline {
        return Err(CommandError::invalid_argument(
            "离线账户没有可刷新的登录信息",
        ));
    }
    let petalfall = facade.snapshot().await;
    Ok(account_dto(&petalfall.refresh_account(&uuid).await?))
}

/// 切换当前账户。
#[tauri::command]
pub async fn set_current_account(
    uuid: String,
    facade: State<'_, Facade>,
) -> Result<(), CommandError> {
    with_accounts(&facade, move |petalfall| {
        petalfall.set_current_account(&uuid)
    })
    .await
}

/// 删除账户。
#[tauri::command]
pub async fn remove_account(uuid: String, facade: State<'_, Facade>) -> Result<(), CommandError> {
    with_accounts(&facade, move |petalfall| petalfall.remove_account(&uuid)).await
}

// ---- 供启动链使用 ----

/// 按 uuid 取出完整账户（含令牌，仅供启动时注入命令行，绝不过 IPC）。在阻塞线程池上查。
pub(crate) async fn find_account(
    petalfall: &Petalfall,
    uuid: &str,
) -> Result<Account, CommandError> {
    let lookup = uuid.to_owned();
    on_blocking_pool(petalfall.clone(), move |petalfall| {
        petalfall.find_account(&lookup)
    })
    .await?
    .ok_or_else(|| petalfall_core::AuthError::AccountNotFound(uuid.to_owned()).into())
}

/// 启动器打开时、以及开着期间每隔 [`RENEW_AHEAD_CHECK_EVERY`]，在后台给当前微软账户提前续期，点启动时不必
/// 先等令牌链（见 [`Petalfall::renew_current_ahead`]）。每一次检查见 [`renew_ahead_once`]。
pub fn renew_ahead_in_background(app: &AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let mut checks = tokio::time::interval(RENEW_AHEAD_CHECK_EVERY);
        // 睡眠唤醒后补查一次就够，错过的几次不必连着补。
        checks.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        loop {
            checks.tick().await;
            renew_ahead_once(&app.state::<Facade>()).await;
        }
    });
}

/// 后台提前续期的一次检查，交回结局供测试核对；续不了交回 `None`。每次都取门面的新快照：期间可能换了账户
/// 或数据目录。续不了只记日志、不中断定时，下一次检查照常再看：启动时还会再续一次，那里的失败才报给玩家。
pub(crate) async fn renew_ahead_once(facade: &Facade) -> Option<AheadOutcome> {
    match facade.snapshot().await.renew_current_ahead().await {
        Ok(outcome) => {
            if let AheadOutcome::Renewed(account) = &outcome {
                tracing::info!(uuid = %account.uuid, "已在后台提前续期当前微软账户的令牌");
            }
            Some(outcome)
        }
        Err(err) => {
            tracing::warn!(
                error = %err,
                causes = ?crate::commands::error::source_chain(&err),
                "后台提前续期失败，下次检查或启动时再续"
            );
            None
        }
    }
}

/// 退出前最多等这么久，让进行中的续期落盘。微软换发新令牌时不作废旧 refresh token，等不到也只是下次再续一遍；
/// 外置刷新会让旧令牌当场作废，等不到就要重新登录，但它是一两次请求，正常远用不了这么久。
pub const RENEWALS_EXIT_DEADLINE: Duration = Duration::from_secs(3);

/// 退出前（关窗、游戏启动后关闭、自更新拉起安装程序之前）等进行中的续期落盘，结果只进日志：退出路径上没有
/// 前端可以报错。不为此弹关窗确认：多数只是后台提前续期，等不到也不丢账户。
pub async fn settle_renewals(facade: &Facade, deadline: Duration) -> SettledRenewals {
    let settled = facade.snapshot().await.settle_renewals(deadline).await;
    match settled {
        SettledRenewals::Idle => {}
        SettledRenewals::Finished => tracing::info!("退出前等进行中的续期落了盘"),
        SettledRenewals::TimedOut => tracing::warn!(
            deadline_ms = deadline.as_millis() as u64,
            "退出前续期没在时限内跑完，随退出放弃：微软账户下次启动再续，外置账户若正在刷新令牌可能要重新登录"
        ),
    }
    settled
}

#[cfg(test)]
mod tests;
