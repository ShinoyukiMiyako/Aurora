//! 账户：离线账户、微软设备码登录、外置登录、刷新与多账户读写。
//!
//! 账户分两个库：带凭据的（微软/外置）落 DPAPI 加密的 `credentials.bin`，离线账户落明文
//! `offline_accounts.json`（理由见 [`aurora_auth::offline_store`]）。对外的读取/切换/删除方法跨两库
//! 统一寻址；凭据加密只有 Windows 实现，非 Windows 上凭据库那一半恒为空，登录直接报不支持。
//!
//! 当前账户的仲裁只有一条规则：离线库里存着选中项时它就是全局当前账户。成立的前提是切到、登录到
//! 微软/外置账户时都会清掉离线选中项（[`Aurora::adopt_as_current`]），两个库的选择因此永远只有一处。
//!
//! 读写库的方法是同步的（文件极小、DPAPI 是同步系统调用），由异步上下文调用时要放进
//! `spawn_blocking`；本模块的异步方法自己这样做。登录、刷新这类要联网的流程先跑完网络、再开库写入：
//! 库实例打开时读入整库、写回时整库覆盖，跨十几分钟的设备码轮询持有它，期间别处的改动就会被盖掉。
//! 所有读写再经进程内一把锁串行，两次读改写不会交错丢更新。同一账户的续期另按账户排队
//! （`refresh_gate`），排在后面的一方以库里刚续出的凭据为准。续期会轮换凭据，跑在独立任务里，
//! 调用方被取消也照样跑完落盘（`renew_detached`）。
//!
//! 凭据库读不出来（换了机器或 Windows 用户、文件被改坏）时原文件改名留存、按空库继续，经过供启动提示取用
//! （[`Aurora::credential_recoveries`]）。

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, LazyLock, Mutex, MutexGuard, PoisonError};
use std::time::Duration;

use tokio::sync::{Mutex as AsyncMutex, OwnedMutexGuard};

use aurora_auth::{
    Account, AccountCredentials, AccountManager, AccountStatus, AuthError, DeviceCodeResponse,
    GameProfile, MicrosoftAuth, MicrosoftCredentials, MicrosoftSession, OfflineAccountStore,
    SkinRef, UsernameCheck, YggdrasilClient, YggdrasilCredentials, offline_account, unix_millis,
    validate_username,
};

use crate::error::Result;
use crate::event::{CoreEvent, EventSink, emit};
use crate::facade::Aurora;

/// 环境变量名：微软登录 client_id 的覆盖来源。
pub const MSA_CLIENT_ID_ENV: &str = "AURORA_MSA_CLIENT_ID";

/// 内置默认微软登录 client_id：启动器自有的 Azure AD 公共客户端应用（受支持账户类型为个人 Microsoft 账户）。
///
/// 两个前提：1) 该应用须在 Azure「身份验证」里开启「允许公共客户端流」，设备码流才成立；
/// 2) 走完设备码/XBL/XSTS 后，若最终 `login_with_xbox` 换 Minecraft 令牌那步返 403，说明该应用尚未通过
/// Mojang 的应用审批（审批通过后此步即放行）。
/// 用户在 config.json 填 msa_client_id 或设环境变量 [`MSA_CLIENT_ID_ENV`] 均可覆盖此默认。
pub const DEFAULT_MSA_CLIENT_ID: &str = "bf8c139d-45e9-48c0-b469-175e8234e516";

/// 离线账户库文件名，与 `config.json` 同挂在数据目录下。
pub const OFFLINE_ACCOUNTS_FILE: &str = "offline_accounts.json";

/// 凭据库文件名（DPAPI 加密），挂在数据目录下。
pub const CREDENTIALS_FILE: &str = "credentials.bin";

/// 读不出来的凭据库改名用的后缀前缀，后面接本地时间 `YYYYMMDD-HHMMSS`；与坏配置文件的留存同一种写法，
/// 用户在数据目录里一眼认得出是同一类现场。
const BROKEN_SUFFIX: &str = ".broken-";

/// 探测外置登录服务器（解析 API 地址 + 取元数据）的总时限。
pub const AUTH_SERVER_TIMEOUT: Duration = Duration::from_secs(10);

/// 角色选择列表里查询单个角色皮肤的时限。
pub const PROFILE_SKIN_TIMEOUT: Duration = Duration::from_millis(5000);

/// 账户库读写的进程内互斥。守护的是「读改写」这一段操作的串行性，本身不保护任何数据，
/// 所以中毒（持锁期间别的线程 panic）不携带任何需要放弃的状态，直接取回锁继续用。
static ACCOUNT_DB_LOCK: Mutex<()> = Mutex::new(());

fn lock_account_db() -> MutexGuard<'static, ()> {
    ACCOUNT_DB_LOCK
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
}

/// 每个账户一把续期闸：同一账户的续期（启动前的静默续期、账户页的手动刷新）一个接一个来。
///
/// 外置登录的刷新会让旧令牌当场作废，两次续期同时拿同一个旧令牌去刷，后到的一方必被服务器以
/// 「令牌无效」拒绝，账户就被误判成需要重新登录。排在后面的一方拿到闸后先重读库里的凭据，
/// 别人刚续出的新令牌直接接着用。键带上数据目录：闸管的是同一份凭据库里的同一个账户，另一个目录里
/// uuid 相同的账户令牌各是各的，不该排在一起。表项只增不删：一个进程里出现过的账户屈指可数。
static REFRESH_GATES: LazyLock<Mutex<HashMap<(PathBuf, String), Arc<AsyncMutex<()>>>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

/// 凭据库读不出来时做的处置：原文件改名留存，按空凭据库继续。供启动提示告诉用户。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CredentialRecovery {
    /// 原文件改名后的路径，内容原样未动：回到原来那台机器、原来那个 Windows 用户下，把它改回
    /// `credentials.bin` 就能找回账户。
    pub preserved: PathBuf,
    /// 读不出来的原因，含原因链。
    pub error: String,
}

/// 本进程里改名留存过的凭据库，按凭据库路径记。哪条命令先碰上坏文件都只处置这一次（改名之后就是
/// 空库），启动提示事后来这里取经过，不必赶在别的命令之前读。
#[cfg(windows)]
static CREDENTIAL_RECOVERIES: LazyLock<Mutex<HashMap<PathBuf, Vec<CredentialRecovery>>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

/// 表里只有已经发生过的事实，中毒不携带需要放弃的状态。
#[cfg(windows)]
fn credential_recoveries_at(path: &Path) -> Vec<CredentialRecovery> {
    CREDENTIAL_RECOVERIES
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .get(path)
        .cloned()
        .unwrap_or_default()
}

#[cfg(windows)]
fn record_credential_recovery(path: &Path, recovery: CredentialRecovery) {
    CREDENTIAL_RECOVERIES
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .entry(path.to_owned())
        .or_default()
        .push(recovery);
}

/// 把读不出来的凭据库改名到同目录下一个还没被占用的留存名（`credentials.bin.broken-<本地时间>`，
/// 同一秒里重名时追加 `-2`、`-3`），返回新路径。在账户库锁内调用。
///
/// 改名失败照实报错：这时按空库继续的话，下一次登录就会把用户的文件盖掉。
#[cfg(windows)]
fn preserve_unreadable_credentials(path: &Path) -> Result<PathBuf> {
    use chrono::{Datelike, Local, Timelike};
    let now = Local::now();
    let base = format!(
        "{}{BROKEN_SUFFIX}{:04}{:02}{:02}-{:02}{:02}{:02}",
        path.display(),
        now.year(),
        now.month(),
        now.day(),
        now.hour(),
        now.minute(),
        now.second()
    );
    let io_error = |path: &Path| {
        let path = path.to_owned();
        move |source| aurora_base::Error::Io { path, source }
    };
    let mut candidate = PathBuf::from(&base);
    let mut attempt = 1u32;
    // Windows 上的 rename 会顶掉已存在的目标，先确认留存名没被占用，不能覆盖上一份留存。
    while candidate.try_exists().map_err(io_error(&candidate))? {
        attempt += 1;
        candidate = PathBuf::from(format!("{base}-{attempt}"));
    }
    std::fs::rename(path, &candidate).map_err(io_error(path))?;
    Ok(candidate)
}

/// 错误连同它的原因链，用「：」接起来。凭据库读不出来的原因常在第二层（JSON 的行列）。
#[cfg(windows)]
fn error_with_causes(err: &dyn std::error::Error) -> String {
    let mut text = err.to_string();
    let mut cause = err.source();
    while let Some(inner) = cause {
        text.push('：');
        text.push_str(&inner.to_string());
        cause = inner.source();
    }
    text
}

/// 外置登录服务器的探测结果。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AuthServerInfo {
    /// 解析出的 API 根地址（以 `/` 结尾），后续登录与刷新都用它。
    pub api_root: String,
    /// 元数据里的服务器名；元数据没写时为 API 根地址的主机名。
    pub server_name: String,
    /// API 根地址的主机名。
    pub host: String,
}

/// 外置登录第一步（账号密码认证）的结果。
pub enum AuthlibLogin {
    /// 已绑定角色并落库，成为当前账户。
    LoggedIn(Account),
    /// 账户下有多个角色且服务器没有替用户选定：等用户选一个后调 [`Aurora::select_authlib_profile`]。
    SelectProfile(AuthlibPending),
}

/// 外置登录等待选择角色期间保留的会话。含令牌，只存在于后端内存，绝不交给前端。
#[derive(Clone)]
pub struct AuthlibPending {
    pub server: AuthServerInfo,
    pub access_token: String,
    pub client_token: String,
    pub profiles: Vec<GameProfile>,
    /// 这次登录填的账号，选完角色后随凭据落盘。
    pub username: String,
}

impl std::fmt::Debug for AuthlibPending {
    // 手写 Debug：派生出来的会把令牌原样打进日志。
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("AuthlibPending")
            .field("server", &self.server)
            .field("profiles", &self.profiles)
            .finish_non_exhaustive()
    }
}

/// 走完微软设备码登录的网络部分，返回一个尚未落库的账户。
///
/// 流程：请求设备码 -> `on_code` 回调（供 UI 展示 user_code 与验证网址）-> 轮询令牌 -> XBL/XSTS/
/// Minecraft/profile -> 组装账户。落库与「设为当前」由调用方在网络结束后再做。
pub async fn perform_microsoft_login(
    auth: &MicrosoftAuth,
    on_code: impl FnOnce(&DeviceCodeResponse),
) -> Result<Account> {
    let device = auth.begin_device_code().await?;
    on_code(&device);
    let token = auth.poll_device_code(&device).await?;
    let session = auth.complete_login(&token).await?;
    Ok(account_from_session(&session))
}

/// 把一次微软会话摊平成可持久化的账户记录（缓存 Minecraft 令牌与到期时间，供下次免握手启动）。
fn account_from_session(session: &MicrosoftSession) -> Account {
    Account {
        last_verified_at: Some(unix_millis()),
        skin: session.skin.clone(),
        xuid: session.xuid.clone(),
        ..Account::new(
            session.profile.id.clone(),
            session.profile.name.clone(),
            AccountCredentials::Microsoft(MicrosoftCredentials {
                refresh_token: session.refresh_token.clone(),
                minecraft_token: Some(session.minecraft_token.clone()),
                minecraft_expires_at: Some(session.minecraft_expires_at),
            }),
        )
    }
}

/// 组装一个刚验证过的外置登录账户。
fn authlib_account(
    server: &AuthServerInfo,
    username: &str,
    access_token: String,
    client_token: String,
    profile: GameProfile,
    skin: Option<SkinRef>,
) -> Account {
    Account {
        last_verified_at: Some(unix_millis()),
        auth_server: Some(server.server_name.clone()),
        skin,
        ..Account::new(
            profile.id,
            profile.name,
            AccountCredentials::AuthlibInjector(YggdrasilCredentials {
                api_root: server.api_root.clone(),
                access_token,
                client_token,
                username: Some(username.to_owned()),
            }),
        )
    }
}

/// 外置刷新被服务器以「令牌无效」拒绝，等同于凭据失效。
fn is_rejected_token(err: &AuthError) -> bool {
    matches!(err, AuthError::Yggdrasil { error, .. } if error == aurora_auth::yggdrasil::FORBIDDEN_OPERATION)
}

impl Aurora {
    /// 解析微软登录 client_id：优先配置，其次环境变量，最后回落到内置默认（[`DEFAULT_MSA_CLIENT_ID`]），
    /// 保证正版登录开箱可用。
    pub(crate) fn msa_client_id(&self) -> String {
        self.config()
            .msa_client_id
            .clone()
            .or_else(|| {
                std::env::var(MSA_CLIENT_ID_ENV)
                    .ok()
                    .filter(|s| !s.is_empty())
            })
            .unwrap_or_else(|| DEFAULT_MSA_CLIENT_ID.to_owned())
    }

    /// 装配不挂取消令牌的微软客户端。续期用它：令牌链一开跑就要走完，见 [`Aurora::renew_detached`]。
    fn msa_client(&self) -> MicrosoftAuth {
        MicrosoftAuth::new(self.http(), self.msa_client_id())
            .with_endpoints(self.msa_endpoints().clone())
    }

    /// 装配登录用的微软客户端；门面快照挂了取消令牌时客户端也挂上。
    fn microsoft_auth(&self) -> MicrosoftAuth {
        let auth = self.msa_client();
        match self.cancel_token() {
            Some(token) => auth.with_cancel(token.clone()),
            None => auth,
        }
    }

    fn yggdrasil(&self, api_root: &str) -> YggdrasilClient {
        YggdrasilClient::new(self.http(), api_root)
    }

    /// 排进这个账户的续期闸，见 [`REFRESH_GATES`]。
    async fn refresh_gate(&self, uuid: &str) -> OwnedMutexGuard<()> {
        let gate = {
            // 表里只有闸本身，中毒不携带需要放弃的状态。
            let mut gates = REFRESH_GATES.lock().unwrap_or_else(PoisonError::into_inner);
            gates
                .entry((self.data_dir().to_path_buf(), uuid.to_owned()))
                .or_insert_with(|| Arc::new(AsyncMutex::new(())))
                .clone()
        };
        gate.lock_owned().await
    }

    /// 在阻塞线程池上跑一段账户库读写，供异步流程调用。
    async fn blocking<T: Send + 'static>(
        &self,
        work: impl FnOnce(&Aurora) -> Result<T> + Send + 'static,
    ) -> Result<T> {
        let this = self.clone();
        tokio::task::spawn_blocking(move || work(&this)).await?
    }

    /// 就地造一个离线账户（不落库，供「给个名字直接开」的即用即弃场景）。
    ///
    /// 用户名先过硬性校验（空/引号/超长直接报错），软性告警（含非标准字符）经事件通道上抛。
    /// 要让账户在下次打开启动器时还在，用 [`Aurora::add_offline_account`]。
    pub fn create_offline_account(
        &self,
        name: &str,
        events: Option<&EventSink>,
    ) -> Result<Account> {
        let UsernameCheck { warnings } = validate_username(name)?;
        for warning in warnings {
            emit(events, CoreEvent::warning(warning));
        }
        Ok(offline_account(name)?)
    }

    /// 保存一个离线账户并把它设为当前账户，返回落库后的账户。
    ///
    /// 校验与告警走与 [`Aurora::create_offline_account`] 同一条路，保证两条入口对用户名的判定一致。
    /// 同名重复保存是幂等的。离线库的选中项在仲裁里优先，所以保存即成为全局当前账户。
    pub fn add_offline_account(&self, name: &str, events: Option<&EventSink>) -> Result<Account> {
        let UsernameCheck { warnings } = validate_username(name)?;
        for warning in warnings {
            emit(events, CoreEvent::warning(warning));
        }
        let _guard = lock_account_db();
        Ok(self.open_offline_accounts()?.add(name)?)
    }

    /// 全部账户：凭据库（微软/外置）在前，离线账户在后。
    pub fn accounts(&self) -> Result<Vec<Account>> {
        let _guard = lock_account_db();
        let mut accounts = self.credential_accounts()?;
        accounts.extend(self.open_offline_accounts()?.accounts());
        Ok(accounts)
    }

    /// 本进程里这个数据目录下凭据库读不出来、被改名留存的经过；没有过为空。
    ///
    /// 先打开一次凭据库：坏文件要是还没被哪条命令碰到，就在这一刻处置。启动提示调用它，不必赶在
    /// 账户列表之前。
    pub async fn credential_recoveries(&self) -> Result<Vec<CredentialRecovery>> {
        self.blocking(|aurora| {
            let _guard = lock_account_db();
            aurora.credential_recoveries_unlocked()
        })
        .await
    }

    /// 按 uuid 跨两库查账户（含令牌，供启动路径取用）。
    pub fn find_account(&self, uuid: &str) -> Result<Option<Account>> {
        let _guard = lock_account_db();
        self.find_account_unlocked(uuid)
    }

    /// 当前账户（若有），仲裁规则见模块文档。
    pub fn current_account(&self) -> Result<Option<Account>> {
        let _guard = lock_account_db();
        if let Some(account) = self.open_offline_accounts()?.current() {
            return Ok(Some(account));
        }
        self.credential_current()
    }

    /// 切换当前账户（uuid 属哪个库自动判定）。
    pub fn set_current_account(&self, uuid: &str) -> Result<()> {
        let _guard = lock_account_db();
        self.set_current_unlocked(uuid)
    }

    /// 删除账户（uuid 属哪个库自动判定）。
    ///
    /// 删掉凭据账户后补一次选中权回落：切到凭据账户时离线选中项已被清空，若删掉的又正是最后一个
    /// 凭据账户，两个库就会同时没有选中项——列表里明明还留着离线号，当前账户却是空的。回落到剩余
    /// 离线账户的第一个，与 [`OfflineAccountStore::remove`] 自身的回落语义一致。
    pub fn remove_account(&self, uuid: &str) -> Result<()> {
        let _guard = lock_account_db();
        let mut offline = self.open_offline_accounts()?;
        if offline.find(uuid).is_some() {
            return Ok(offline.remove(uuid)?);
        }
        self.credential_remove(uuid)?;
        if self.credential_current()?.is_none()
            && offline.current().is_none()
            && let Some(first) = offline.accounts().into_iter().next()
        {
            offline.set_current(&first.uuid)?;
        }
        Ok(())
    }

    /// 走微软设备码登录，账户落库并成为当前账户，返回落库后的账户。
    ///
    /// 同一 uuid 已存在时覆盖原记录（重新登录），加入时刻保留。快照挂了取消令牌时，取消在网络阶段
    /// 任一步生效并以 [`AuthError::Cancelled`] 返回，此时库不会被写入。
    pub async fn microsoft_login(
        &self,
        on_code: impl FnOnce(&DeviceCodeResponse),
    ) -> Result<Account> {
        Self::ensure_credential_store()?;
        let account = perform_microsoft_login(&self.microsoft_auth(), on_code).await?;
        self.blocking(move |aurora| aurora.store_login(account))
            .await
    }

    /// 探测外置登录服务器：按 authlib-injector 的 API 地址指示解析出 API 根地址并取元数据，
    /// 总时限 [`AUTH_SERVER_TIMEOUT`]。`server_url` 须已是带协议头的完整地址。
    pub async fn probe_auth_server(&self, server_url: &str) -> Result<AuthServerInfo> {
        let ali = aurora_auth::yggdrasil::prefetch_metadata(
            &self.http(),
            server_url,
            AUTH_SERVER_TIMEOUT,
        )
        .await?;
        let host = reqwest::Url::parse(&ali.api_root)
            .ok()
            .and_then(|url| url.host_str().map(str::to_owned))
            .ok_or_else(|| AuthError::Response {
                context: "外置登录服务器地址",
                detail: format!("解析出的 API 地址 {} 没有主机名", ali.api_root),
            })?;
        let server_name = ali
            .metadata
            .server_name()
            .map(str::to_owned)
            .unwrap_or_else(|| host.clone());
        Ok(AuthServerInfo {
            api_root: ali.api_root,
            server_name,
            host,
        })
    }

    /// 外置登录第一步：探测服务器、账号密码认证，能确定角色就直接落库并设为当前。
    ///
    /// - 服务器已替这个令牌选定角色：直接用它。
    /// - 没选定、账户下恰好一个角色：用刷新把令牌绑定到这个角色（未绑定的令牌进不了多人服务器）。
    /// - 没选定、多个角色：返回 [`AuthlibLogin::SelectProfile`]，等用户选。
    /// - 一个角色都没有：[`AuthError::YggdrasilNoProfile`]。
    ///
    /// 密码只在这一次请求里用，不落盘。
    pub async fn authlib_login(
        &self,
        server_url: &str,
        username: &str,
        password: &str,
    ) -> Result<AuthlibLogin> {
        Self::ensure_credential_store()?;
        let server = self.probe_auth_server(server_url).await?;
        let client = self.yggdrasil(&server.api_root);
        let resp = client.authenticate(username, password, None).await?;
        if let Some(profile) = resp.selected_profile {
            let account = self
                .finish_authlib(
                    &client,
                    &server,
                    username,
                    resp.access_token,
                    resp.client_token,
                    profile,
                )
                .await?;
            return Ok(AuthlibLogin::LoggedIn(account));
        }
        let pending = AuthlibPending {
            server,
            access_token: resp.access_token,
            client_token: resp.client_token,
            profiles: resp.available_profiles,
            username: username.to_owned(),
        };
        match pending.profiles.as_slice() {
            [] => Err(AuthError::YggdrasilNoProfile.into()),
            [only] => {
                let only = only.clone();
                Ok(AuthlibLogin::LoggedIn(
                    self.select_authlib_profile(&pending, &only).await?,
                ))
            }
            _ => Ok(AuthlibLogin::SelectProfile(pending)),
        }
    }

    /// 外置登录第二步：把等待中的令牌绑定到选中的角色，落库并设为当前账户。
    ///
    /// `profile` 必须取自 `pending.profiles`；服务器绑定后回报的角色与所选不符时报协议错误。
    pub async fn select_authlib_profile(
        &self,
        pending: &AuthlibPending,
        profile: &GameProfile,
    ) -> Result<Account> {
        Self::ensure_credential_store()?;
        let client = self.yggdrasil(&pending.server.api_root);
        let resp = client
            .refresh(
                &pending.access_token,
                Some(&pending.client_token),
                Some(profile),
            )
            .await?;
        let bound = resp.selected_profile.ok_or_else(|| AuthError::Response {
            context: "绑定外置登录角色",
            detail: "服务器没有回报绑定后的角色".into(),
        })?;
        if bound.id != profile.id {
            return Err(AuthError::Response {
                context: "绑定外置登录角色",
                detail: format!("请求绑定 {}，服务器回报的却是 {}", profile.id, bound.id),
            }
            .into());
        }
        self.finish_authlib(
            &client,
            &pending.server,
            &pending.username,
            resp.access_token,
            resp.client_token,
            bound,
        )
        .await
    }

    /// 等待选择的每个角色当前的皮肤，与 `pending.profiles` 一一对应，供角色列表画头像。
    ///
    /// 并发查询，每个角色限时 [`PROFILE_SKIN_TIMEOUT`]；取不到的记 warn 并为 None，界面画剪影。
    pub async fn authlib_profile_skins(&self, pending: &AuthlibPending) -> Vec<Option<SkinRef>> {
        let mut tasks = tokio::task::JoinSet::new();
        for (index, profile) in pending.profiles.iter().enumerate() {
            let client = self.yggdrasil(&pending.server.api_root);
            let id = profile.id.clone();
            tasks.spawn(async move {
                let skin = match tokio::time::timeout(
                    PROFILE_SKIN_TIMEOUT,
                    profile_skin_or_warn(&client, &id),
                )
                .await
                {
                    Ok(skin) => skin,
                    Err(_) => {
                        tracing::warn!(profile_id = %id, "查询外置角色皮肤超时，界面将回落到剪影");
                        None
                    }
                };
                (index, skin)
            });
        }
        let mut skins = vec![None; pending.profiles.len()];
        while let Some(joined) = tasks.join_next().await {
            match joined {
                Ok((index, skin)) => skins[index] = skin,
                Err(err) => tracing::warn!(error = %err, "查询外置角色皮肤的后台任务异常结束"),
            }
        }
        skins
    }

    /// 外置登录收尾：取角色皮肤（取不到只记 warn，不影响登录）、落库、设为当前。
    async fn finish_authlib(
        &self,
        client: &YggdrasilClient,
        server: &AuthServerInfo,
        username: &str,
        access_token: String,
        client_token: String,
        profile: GameProfile,
    ) -> Result<Account> {
        let skin = profile_skin_or_warn(client, &profile.id).await;
        let account = authlib_account(server, username, access_token, client_token, profile, skin);
        self.blocking(move |aurora| aurora.store_login(account))
            .await
    }

    /// 刷新账户信息，返回更新后的记录。
    ///
    /// - 微软：重走令牌链，名字与皮肤以这次取到的为准。
    /// - 外置：先校验令牌。仍有效就只从会话服务器更新角色名与皮肤，令牌不动：刷新会让旧令牌当场作废，
    ///   正在运行的游戏手里拿着的就是它，作废了游戏里进多人服务器会被判会话无效。校验判失效才刷新令牌。
    /// - 离线：没有可刷新的凭据，原样返回。
    ///
    /// 服务器判定凭据失效（微软刷新令牌被判需重登、外置令牌被拒）时把账户落成「需要重新登录」并报
    /// [`AuthError::ReloginRequired`]；网络故障原样冒泡、状态不变。
    ///
    /// 刷新跑在独立任务里：调用方被取消时以 [`AuthError::Cancelled`] 返回，刷新照样跑完落盘
    /// （见 [`Aurora::renew_detached`]）。
    pub async fn refresh_account(&self, uuid: &str) -> Result<Account> {
        let target = uuid.to_owned();
        self.renew_detached(uuid, |aurora| async move {
            aurora.refresh_account_now(&target).await
        })
        .await
    }

    async fn refresh_account_now(&self, uuid: &str) -> Result<Account> {
        let _gate = self.refresh_gate(uuid).await;
        let account = self.stored_account(uuid).await?;
        match &account.credentials {
            AccountCredentials::Microsoft(creds) => {
                self.refresh_microsoft(&account, &creds.refresh_token).await
            }
            AccountCredentials::AuthlibInjector(creds) => {
                let client = self.yggdrasil(&creds.api_root);
                if client
                    .validate(&creds.access_token, Some(&creds.client_token))
                    .await?
                {
                    return self.sync_authlib_profile(&client, &account).await;
                }
                self.refresh_authlib(&account, creds).await
            }
            AccountCredentials::Offline => Ok(account),
        }
    }

    /// 启动前确保账户凭据可用，返回可直接注入启动参数的账户。
    ///
    /// - 微软：缓存的 Minecraft 令牌仍有效则原样返回（不联网、不开库），否则用 refresh_token 续期并回写。
    /// - 外置：先向服务器校验令牌，有效则记一次验证时刻；无效则刷新令牌并回写。
    /// - 离线：原样返回。
    ///
    /// 续期被判定为凭据失效时账户落成「需要重新登录」并报 [`AuthError::ReloginRequired`]。
    ///
    /// 要联网时先排进这个账户的续期闸，再以库里此刻的记录为准：排队期间别处可能刚续过，
    /// 传进来的那份凭据已经作废。联网的部分跑在独立任务里：启动被取消时以 [`AuthError::Cancelled`]
    /// 返回，续期照样跑完落盘（见 [`Aurora::renew_detached`]）。
    pub async fn ensure_account_fresh(&self, account: &Account) -> Result<Account> {
        match &account.credentials {
            AccountCredentials::Microsoft(creds)
                if creds.minecraft_token_valid_at(unix_millis() / 1000) =>
            {
                return Ok(account.clone());
            }
            AccountCredentials::Offline => return Ok(account.clone()),
            AccountCredentials::Microsoft(_) | AccountCredentials::AuthlibInjector(_) => {}
        }
        let target = account.uuid.clone();
        self.renew_detached(&account.uuid, |aurora| async move {
            aurora.ensure_account_fresh_now(&target).await
        })
        .await
    }

    /// 在独立任务里跑一次续期（排闸、读库、联网、落盘一口气做完），调用方只等它的结果。
    ///
    /// 外置刷新与微软令牌链都会轮换凭据：请求一发出，服务器那边的旧凭据就可能作废，新凭据只在回音里。
    /// 续期要是跑在调用方的 future 里，启动被取消、命令层在宽限期满后丢掉 future 时，回音跟着被丢，
    /// 账户就只能重新登录。所以调用方被取消（快照上的取消令牌触发，或 future 被丢弃）时只是不再等，
    /// 续期照样跑完落盘；续期闸由任务自己持有，排在后面的续期等它落完盘才读库。令牌链因此不挂取消令牌。
    /// 已经取消了才来的续期不开始。
    async fn renew_detached<F>(
        &self,
        uuid: &str,
        renewal: impl FnOnce(Aurora) -> F,
    ) -> Result<Account>
    where
        F: std::future::Future<Output = Result<Account>> + Send + 'static,
    {
        if self.is_cancelled() {
            return Err(AuthError::Cancelled.into());
        }
        let task = tokio::spawn(renewal(self.clone()));
        let joined = match self.cancel_token() {
            Some(token) => match token.run_until_cancelled(task).await {
                Some(joined) => joined,
                None => {
                    tracing::info!(uuid, "续期的调用方已取消，续期在后台跑完并落盘");
                    return Err(AuthError::Cancelled.into());
                }
            },
            None => task.await,
        };
        joined?
    }

    async fn ensure_account_fresh_now(&self, uuid: &str) -> Result<Account> {
        let _gate = self.refresh_gate(uuid).await;
        let account = self.stored_account(uuid).await?;
        match &account.credentials {
            AccountCredentials::Microsoft(creds) => {
                if creds.minecraft_token_valid_at(unix_millis() / 1000) {
                    return Ok(account.clone());
                }
                self.refresh_microsoft(&account, &creds.refresh_token).await
            }
            AccountCredentials::AuthlibInjector(creds) => {
                let client = self.yggdrasil(&creds.api_root);
                if client
                    .validate(&creds.access_token, Some(&creds.client_token))
                    .await?
                {
                    let uuid = account.uuid.clone();
                    return self
                        .blocking(move |aurora| {
                            aurora.update_credential_account(&uuid, |stored| {
                                stored.last_verified_at = Some(unix_millis());
                                stored.status = AccountStatus::Ok;
                            })
                        })
                        .await;
                }
                self.refresh_authlib(&account, creds).await
            }
            AccountCredentials::Offline => Ok(account.clone()),
        }
    }

    /// 在阻塞线程池上按 uuid 取库里的账户，不存在即报 [`AuthError::AccountNotFound`]。
    async fn stored_account(&self, uuid: &str) -> Result<Account> {
        let lookup = uuid.to_owned();
        self.blocking(move |aurora| aurora.find_account(&lookup))
            .await?
            .ok_or_else(|| AuthError::AccountNotFound(uuid.to_owned()).into())
    }

    async fn refresh_microsoft(&self, account: &Account, refresh_token: &str) -> Result<Account> {
        match self.msa_client().refresh_session(refresh_token).await {
            Ok(session) => {
                let fresh = account_from_session(&session);
                let uuid = account.uuid.clone();
                self.blocking(move |aurora| {
                    aurora.update_credential_account(&uuid, |stored| {
                        // 整条替换但保留加入时刻；档案 uuid 不会变，名字与皮肤以这次取到的为准。
                        let added_at = stored.added_at;
                        *stored = Account { added_at, ..fresh };
                    })
                })
                .await
            }
            Err(AuthError::ReloginRequired) => self.expire(account).await,
            Err(err) => Err(err.into()),
        }
    }

    async fn refresh_authlib(
        &self,
        account: &Account,
        creds: &YggdrasilCredentials,
    ) -> Result<Account> {
        let client = self.yggdrasil(&creds.api_root);
        let resp = match client
            .refresh(&creds.access_token, Some(&creds.client_token), None)
            .await
        {
            Ok(resp) => resp,
            Err(err) if is_rejected_token(&err) => return self.expire(account).await,
            Err(err) => return Err(err.into()),
        };
        // 档案取不到（连不上、服务器出错）时皮肤保持原样，不因一次连不上就清掉；角色在服务器上
        // 已不存在时才清。
        let profile = match client.session_profile(&account.uuid).await {
            Ok(profile) => Some(profile),
            Err(err) => {
                tracing::warn!(uuid = %account.uuid, error = %err, "刷新令牌后取外置角色档案失败，皮肤保持原样");
                None
            }
        };
        let name = resp.selected_profile.map(|p| p.name);
        let uuid = account.uuid.clone();
        let api_root = creds.api_root.clone();
        let username = creds.username.clone();
        self.blocking(move |aurora| {
            aurora.update_credential_account(&uuid, |stored| {
                stored.credentials = AccountCredentials::AuthlibInjector(YggdrasilCredentials {
                    api_root,
                    access_token: resp.access_token,
                    client_token: resp.client_token,
                    username,
                });
                if let Some(name) = name {
                    stored.name = name;
                }
                match profile {
                    Some(Some(profile)) => stored.skin = profile.skin,
                    Some(None) => stored.skin = None,
                    None => {}
                }
                stored.status = AccountStatus::Ok;
                stored.last_verified_at = Some(unix_millis());
            })
        })
        .await
    }

    /// 令牌已校验有效：从会话服务器取角色名与皮肤写回，记一次验证时刻，令牌原样不动。
    ///
    /// 档案取不到（连不上、服务器出错）只记 warn，角色名与皮肤保持原样，不拿空值盖掉；角色在服务器上
    /// 已不存在（204）时没有皮肤可显示，皮肤清空、名字留着。
    async fn sync_authlib_profile(
        &self,
        client: &YggdrasilClient,
        account: &Account,
    ) -> Result<Account> {
        let profile = match client.session_profile(&account.uuid).await {
            Ok(profile) => Some(profile),
            Err(err) => {
                tracing::warn!(uuid = %account.uuid, error = %err, "取外置角色档案失败，角色名与皮肤保持原样");
                None
            }
        };
        let uuid = account.uuid.clone();
        self.blocking(move |aurora| {
            aurora.update_credential_account(&uuid, |stored| {
                match profile {
                    Some(Some(profile)) => {
                        if let Some(name) = profile.name {
                            stored.name = name;
                        }
                        stored.skin = profile.skin;
                    }
                    Some(None) => stored.skin = None,
                    None => {}
                }
                stored.status = AccountStatus::Ok;
                stored.last_verified_at = Some(unix_millis());
            })
        })
        .await
    }

    /// 把账户落成「需要重新登录」，然后报 [`AuthError::ReloginRequired`]。`rejected` 是这次续期
    /// 拿去用、被服务器拒绝的那份记录。
    ///
    /// 只在库里的凭据仍是被拒的那一份时才落：续期在网络上等回音的这段时间里用户可能已经重新登录，
    /// 库里换成了新凭据，被拒的只是旧的那份，新登录的账户不能跟着被标成失效。
    async fn expire(&self, rejected: &Account) -> Result<Account> {
        let target = rejected.uuid.clone();
        let rejected_credentials = rejected.credentials.clone();
        let (stored, expired) = self
            .blocking(move |aurora| {
                let mut expired = false;
                let stored = aurora.update_credential_account(&target, |stored| {
                    if stored.credentials == rejected_credentials {
                        stored.status = AccountStatus::Expired;
                        expired = true;
                    }
                })?;
                Ok((stored, expired))
            })
            .await?;
        if expired {
            tracing::warn!(uuid = %stored.uuid, name = %stored.name, "账户凭据已被服务器判定失效，标记为需要重新登录");
        } else {
            tracing::info!(uuid = %stored.uuid, name = %stored.name, "被拒的是重新登录之前的旧凭据，库里的新凭据不受影响，不标记失效");
        }
        Err(AuthError::ReloginRequired.into())
    }

    // ---- 以下在账户库锁内调用，自身不再加锁 ----

    fn open_offline_accounts(&self) -> Result<OfflineAccountStore> {
        Ok(OfflineAccountStore::load(
            self.data_dir().join(OFFLINE_ACCOUNTS_FILE),
        )?)
    }

    fn find_account_unlocked(&self, uuid: &str) -> Result<Option<Account>> {
        if let Some(account) = self.open_offline_accounts()?.find(uuid) {
            return Ok(Some(account));
        }
        Ok(self
            .credential_accounts()?
            .into_iter()
            .find(|a| a.uuid == uuid))
    }

    fn set_current_unlocked(&self, uuid: &str) -> Result<()> {
        let mut offline = self.open_offline_accounts()?;
        if offline.find(uuid).is_some() {
            return Ok(offline.set_current(uuid)?);
        }
        // 目标是微软/外置账户：先把凭据库那边的选择落定，成功后才清掉离线选中项——
        // 顺序反过来的话，凭据库那步失败就会留下「两个库都没选中」的空当。
        self.credential_set_current(uuid)?;
        Ok(offline.clear_current()?)
    }

    /// 把刚登录成功的账户写进凭据库并落定为当前账户，返回落库后的记录。
    fn store_login(&self, account: Account) -> Result<Account> {
        let _guard = lock_account_db();
        let stored = self.credential_upsert(account)?;
        self.adopt_as_current(&stored)?;
        Ok(stored)
    }

    /// 把账户落定为当前账户。
    ///
    /// 登录本身只往凭据库里 upsert，而当前账户的仲裁是「离线库存着选中项就赢」；不走这一步的话，
    /// 玩家选着某个离线账户时登录微软/外置，登完界面上的当前账户还是那个离线号，进游戏也是离线号。
    fn adopt_as_current(&self, account: &Account) -> Result<()> {
        self.set_current_unlocked(&account.uuid)
    }

    fn update_credential_account(
        &self,
        uuid: &str,
        change: impl FnOnce(&mut Account),
    ) -> Result<Account> {
        let _guard = lock_account_db();
        self.credential_update(uuid, change)
    }
}

#[cfg(all(test, windows))]
impl Aurora {
    /// 不走登录链，直接把账户写进凭据库并选为当前账户：启动等其它模块的门面级测试据此布置账户现场。
    pub(crate) fn store_account_for_test(&self, account: Account) -> Result<Account> {
        self.store_login(account)
    }
}

/// 取外置角色的皮肤；失败不影响登录与刷新，只记 warn 让界面回落。
async fn profile_skin_or_warn(client: &YggdrasilClient, profile_id: &str) -> Option<SkinRef> {
    match client.profile_skin(profile_id).await {
        Ok(skin) => skin,
        Err(err) => {
            tracing::warn!(profile_id, error = %err, "取外置角色皮肤失败，界面将回落到剪影");
            None
        }
    }
}

// ---- 凭据库（微软/外置）一侧的跨平台缝 ----
//
// 凭据加密只有 Windows(DPAPI) 实现。非 Windows 上「读」返回空、「改」报账户不存在——那里确实没有
// 任何凭据账户，这是如实回答而非兜底掩盖；登录则一开始就报不支持，不白跑一趟网络。

#[cfg(windows)]
impl Aurora {
    fn ensure_credential_store() -> Result<()> {
        Ok(())
    }

    /// 打开凭据库。文件读到了却还原不出来（换了机器或 Windows 用户、文件被改坏）时不报错：原文件改名留存，
    /// 按空库继续，经过记进本进程的留存表。离线账户在另一个库里，不受影响；微软与外置登录账户要重新登录。
    /// 读文件本身失败、改名失败仍然报错。
    fn open_credentials(&self) -> Result<AccountManager<aurora_auth::DpapiCredentialStore>> {
        let path = self.data_dir().join(CREDENTIALS_FILE);
        let err = match AccountManager::load(aurora_auth::DpapiCredentialStore::at(&path)) {
            Ok(manager) => return Ok(manager),
            Err(err) if err.is_unreadable_credentials() => err,
            Err(err) => return Err(err.into()),
        };
        let preserved = preserve_unreadable_credentials(&path)?;
        let error = error_with_causes(&err);
        tracing::error!(
            path = %path.display(),
            preserved = %preserved.display(),
            error = %error,
            "凭据库读不出来，已改名留存，按空凭据库继续；微软与外置登录账户需要重新登录"
        );
        record_credential_recovery(&path, CredentialRecovery { preserved, error });
        Ok(AccountManager::load(
            aurora_auth::DpapiCredentialStore::at(&path),
        )?)
    }

    fn credential_recoveries_unlocked(&self) -> Result<Vec<CredentialRecovery>> {
        self.open_credentials()?;
        Ok(credential_recoveries_at(
            &self.data_dir().join(CREDENTIALS_FILE),
        ))
    }

    fn credential_accounts(&self) -> Result<Vec<Account>> {
        Ok(self.open_credentials()?.accounts().to_vec())
    }

    fn credential_current(&self) -> Result<Option<Account>> {
        Ok(self.open_credentials()?.current().cloned())
    }

    fn credential_set_current(&self, uuid: &str) -> Result<()> {
        Ok(self.open_credentials()?.set_current(uuid)?)
    }

    fn credential_remove(&self, uuid: &str) -> Result<()> {
        Ok(self.open_credentials()?.remove(uuid)?)
    }

    fn credential_upsert(&self, account: Account) -> Result<Account> {
        Ok(self.open_credentials()?.upsert(account)?)
    }

    fn credential_update(&self, uuid: &str, change: impl FnOnce(&mut Account)) -> Result<Account> {
        Ok(self.open_credentials()?.update(uuid, change)?)
    }
}

#[cfg(not(windows))]
impl Aurora {
    fn ensure_credential_store() -> Result<()> {
        Err(crate::error::CoreError::PlatformUnsupported)
    }

    fn credential_recoveries_unlocked(&self) -> Result<Vec<CredentialRecovery>> {
        Ok(Vec::new())
    }

    fn credential_accounts(&self) -> Result<Vec<Account>> {
        Ok(Vec::new())
    }

    fn credential_current(&self) -> Result<Option<Account>> {
        Ok(None)
    }

    fn credential_set_current(&self, uuid: &str) -> Result<()> {
        Err(AuthError::AccountNotFound(uuid.to_owned()).into())
    }

    fn credential_remove(&self, uuid: &str) -> Result<()> {
        Err(AuthError::AccountNotFound(uuid.to_owned()).into())
    }

    fn credential_upsert(&self, _account: Account) -> Result<Account> {
        Err(crate::error::CoreError::PlatformUnsupported)
    }

    fn credential_update(&self, uuid: &str, _change: impl FnOnce(&mut Account)) -> Result<Account> {
        Err(AuthError::AccountNotFound(uuid.to_owned()).into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::error::CoreError;
    use aurora_auth::{AccountType, SkinModel};
    use serde_json::json;
    use wiremock::matchers::{body_partial_json, method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    /// 用同一个数据目录重开一个门面，等价于「关掉启动器再打开」。
    fn aurora_at(data_dir: &std::path::Path) -> Aurora {
        Aurora::for_test(
            crate::config::AuroraConfig {
                msa_client_id: Some("test-client-id".into()),
                ..crate::config::AuroraConfig::default()
            },
            data_dir.to_path_buf(),
            data_dir.to_path_buf(),
        )
    }

    fn msa_endpoints(server: &MockServer) -> aurora_auth::MsaEndpoints {
        aurora_auth::MsaEndpoints {
            oauth_base: server.uri(),
            xbl_authenticate: format!("{}/xbl", server.uri()),
            xsts_authorize: format!("{}/xsts", server.uri()),
            minecraft_base: server.uri(),
        }
    }

    const MS_UUID: &str = "0123456789abcdef0123456789abcdef";

    /// 挂上设备码、令牌、XBL、XSTS、Minecraft 登录与档案的全链 mock。
    async fn mount_full_login(server: &MockServer, refresh_status: u16) {
        Mock::given(method("POST"))
            .and(path("/devicecode"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "device_code": "DEV", "user_code": "WXYZ-9999",
                "verification_uri": "https://microsoft.com/link",
                "expires_in": 900, "interval": 1, "message": "输入 WXYZ-9999"
            })))
            .mount(server)
            .await;
        let token = if refresh_status == 200 {
            ResponseTemplate::new(200).set_body_json(json!({
                "access_token": "AT", "refresh_token": "rotated-refresh", "expires_in": 3600
            }))
        } else {
            ResponseTemplate::new(refresh_status).set_body_json(json!({
                "error": "invalid_grant", "error_description": "refresh token 已失效"
            }))
        };
        Mock::given(method("POST"))
            .and(path("/token"))
            .respond_with(token)
            .mount(server)
            .await;
        Mock::given(method("POST"))
            .and(path("/xbl"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "Token": "xbl", "DisplayClaims": { "xui": [ { "uhs": "theuhs" } ] }
            })))
            .mount(server)
            .await;
        Mock::given(method("POST"))
            .and(path("/xsts"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "Token": "xsts", "DisplayClaims": { "xui": [ { "uhs": "theuhs", "xid": "2535" } ] }
            })))
            .mount(server)
            .await;
        Mock::given(method("POST"))
            .and(path("/authentication/login_with_xbox"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "access_token": "MC-TOKEN", "expires_in": 86400
            })))
            .mount(server)
            .await;
        Mock::given(method("GET"))
            .and(path("/minecraft/profile"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "id": MS_UUID, "name": "PetalPlayer",
                "skins": [ { "id": "s", "state": "ACTIVE",
                    "url": "http://textures.minecraft.net/texture/abc", "variant": "SLIM" } ]
            })))
            .mount(server)
            .await;
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn microsoft_login_network_part_builds_a_verified_account() {
        let server = MockServer::start().await;
        mount_full_login(&server, 200).await;
        let tmp = tempfile::tempdir().unwrap();
        let aurora = aurora_at(tmp.path()).with_msa_endpoints(msa_endpoints(&server));

        let mut shown = None;
        let before = unix_millis();
        let account = perform_microsoft_login(&aurora.microsoft_auth(), |dc| {
            shown = Some(dc.user_code.clone());
        })
        .await
        .unwrap();

        assert_eq!(shown.as_deref(), Some("WXYZ-9999"));
        assert_eq!(account.uuid, MS_UUID);
        assert_eq!(account.name, "PetalPlayer");
        assert_eq!(account.status, AccountStatus::Ok);
        assert!(account.last_verified_at.unwrap() >= before);
        assert_eq!(account.xuid.as_deref(), Some("2535"));
        assert_eq!(account.skin.as_ref().unwrap().model, SkinModel::Slim);
        match &account.credentials {
            AccountCredentials::Microsoft(c) => {
                assert_eq!(c.refresh_token, "rotated-refresh");
                assert_eq!(c.minecraft_token.as_deref(), Some("MC-TOKEN"));
            }
            other => panic!("期望 Microsoft 凭据，得到 {other:?}"),
        }
        // 网络部分不碰账户库。
        assert!(!tmp.path().join(CREDENTIALS_FILE).exists());
    }

    #[test]
    fn offline_account_creation_validates_and_yields_stable_uuid() {
        let tmp = tempfile::tempdir().unwrap();
        let aurora = aurora_at(tmp.path());

        // 合法用户名 -> 稳定离线 UUID（与原版一致）。
        let account = aurora.create_offline_account("Steve", None).unwrap();
        assert_eq!(account.uuid, "5627dd98e6be3c21b8a8e92344183641");
        assert_eq!(account.account_type, AccountType::Offline);
        // 即用即弃：不落库。
        assert!(!tmp.path().join(OFFLINE_ACCOUNTS_FILE).exists());

        // 含非标准字符 -> 通过但发出告警事件。
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
        let _ = aurora.create_offline_account("玩家一", Some(&tx)).unwrap();
        drop(tx);
        let mut warned = false;
        while let Ok(ev) = rx.try_recv() {
            if matches!(ev, CoreEvent::Warning(_)) {
                warned = true;
            }
        }
        assert!(warned, "非标准字符用户名应发出告警事件");

        // 非法用户名（空）冒泡。
        assert!(matches!(
            aurora.create_offline_account("", None),
            Err(CoreError::Auth(_))
        ));
    }

    #[test]
    fn added_offline_accounts_survive_restart_with_selection() {
        let tmp = tempfile::tempdir().unwrap();
        {
            let aurora = aurora_at(tmp.path());
            aurora.add_offline_account("Steve", None).unwrap();
            aurora.add_offline_account("Alex", None).unwrap();
        }

        // 换一个门面实例重新读盘：账户与当前选中都必须还在（删掉 add 的落盘此断言即挂）。
        let restarted = aurora_at(tmp.path());
        let names: Vec<_> = restarted
            .accounts()
            .unwrap()
            .into_iter()
            .map(|a| a.name)
            .collect();
        assert_eq!(names, ["Steve", "Alex"]);
        assert_eq!(restarted.current_account().unwrap().unwrap().name, "Alex");
        assert!(tmp.path().join(OFFLINE_ACCOUNTS_FILE).is_file());
    }

    #[test]
    fn switching_and_removing_offline_accounts_moves_the_selection() {
        let tmp = tempfile::tempdir().unwrap();
        let aurora = aurora_at(tmp.path());
        let steve = aurora.add_offline_account("Steve", None).unwrap();
        let alex = aurora.add_offline_account("Alex", None).unwrap();

        aurora.set_current_account(&steve.uuid).unwrap();
        assert_eq!(
            aurora_at(tmp.path())
                .current_account()
                .unwrap()
                .unwrap()
                .uuid,
            steve.uuid
        );

        // 删掉当前选中项 -> 回落到剩下的第一个，且这一回落也要落盘。
        aurora.remove_account(&steve.uuid).unwrap();
        let restarted = aurora_at(tmp.path());
        assert_eq!(
            restarted.current_account().unwrap().unwrap().uuid,
            alex.uuid
        );
        assert!(restarted.find_account(&steve.uuid).unwrap().is_none());

        // 删光之后不再有当前账户。
        restarted.remove_account(&alex.uuid).unwrap();
        assert!(restarted.current_account().unwrap().is_none());
        assert!(restarted.accounts().unwrap().is_empty());
    }

    #[test]
    fn add_offline_account_validates_like_the_ephemeral_path() {
        let tmp = tempfile::tempdir().unwrap();
        let aurora = aurora_at(tmp.path());

        // 非法用户名冒泡，且一个字节都不落盘。
        assert!(matches!(
            aurora.add_offline_account("bad\"name", None),
            Err(CoreError::Auth(AuthError::InvalidUsername(_)))
        ));
        assert!(!tmp.path().join(OFFLINE_ACCOUNTS_FILE).exists());

        // 含非标准字符：保存成功，同时经事件通道发出告警。
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
        let saved = aurora.add_offline_account("玩家一", Some(&tx)).unwrap();
        drop(tx);
        assert_eq!(saved.name, "玩家一");
        assert!(matches!(rx.try_recv(), Ok(CoreEvent::Warning(_))));
        let found = aurora_at(tmp.path())
            .find_account(&saved.uuid)
            .unwrap()
            .expect("已保存的离线账户应能按 uuid 查到");
        assert_eq!(found.added_at, saved.added_at);
    }

    #[test]
    fn client_id_prefers_config_then_falls_back_to_builtin_default() {
        let tmp = tempfile::tempdir().unwrap();
        assert_eq!(aurora_at(tmp.path()).msa_client_id(), "test-client-id");

        let config = crate::config::AuroraConfig {
            msa_client_id: None,
            ..crate::config::AuroraConfig::default()
        };
        let aurora = Aurora::for_test(config, tmp.path().to_path_buf(), tmp.path().to_path_buf());
        // 未配置且无环境变量时回落到内置 client_id，保证正版登录开箱可用；删掉回落此断言即挂。
        if std::env::var(MSA_CLIENT_ID_ENV).is_err() {
            assert_eq!(aurora.msa_client_id(), DEFAULT_MSA_CLIENT_ID);
        }
    }

    #[test]
    fn pending_selection_debug_output_never_contains_tokens() {
        let pending = AuthlibPending {
            server: AuthServerInfo {
                api_root: "https://ls/api/yggdrasil/".into(),
                server_name: "LittleSkin".into(),
                host: "ls".into(),
            },
            access_token: "SECRET-ACCESS".into(),
            client_token: "SECRET-CLIENT".into(),
            profiles: vec![],
            username: "user@example.com".into(),
        };
        let text = format!("{pending:?}");
        assert!(text.contains("LittleSkin"));
        assert!(!text.contains("SECRET"));
    }

    // ---- 以下涉及凭据库（DPAPI），只在 Windows 上跑 ----

    #[cfg(windows)]
    mod credential {
        use super::*;

        /// 外置服务器：根地址给元数据，认证与刷新按参数返回。
        async fn mount_yggdrasil(server: &MockServer, authenticate: serde_json::Value) {
            Mock::given(method("GET"))
                .and(path("/"))
                .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                    "meta": { "serverName": "Petal Skin" },
                    "skinDomains": ["127.0.0.1"]
                })))
                .mount(server)
                .await;
            Mock::given(method("POST"))
                .and(path("/authserver/authenticate"))
                .respond_with(ResponseTemplate::new(200).set_body_json(authenticate))
                .mount(server)
                .await;
            Mock::given(method("GET"))
                .and(path(format!(
                    "/sessionserver/session/minecraft/profile/{HERO}"
                )))
                .respond_with(ResponseTemplate::new(204))
                .mount(server)
                .await;
        }

        const HERO: &str = "1111111111111111aaaaaaaaaaaaaaaa";
        const ALT: &str = "2222222222222222bbbbbbbbbbbbbbbb";
        const STILL_VALID: &str = "3333333333333333cccccccccccccccc";
        const PROFILE_DOWN: &str = "4444444444444444dddddddddddddddd";
        const ABANDONED_LAUNCH: &str = "5555555555555555eeeeeeeeeeeeeeee";
        const CANCELLED_REFRESH: &str = "6666666666666666ffffffffffffffff";
        const ROTATED_PROFILE_DOWN: &str = "7777777777777777aaaaaaaaaaaaaaaa";
        const SHARED_UUID: &str = "8888888888888888bbbbbbbbbbbbbbbb";

        fn logged_in(outcome: AuthlibLogin) -> Account {
            match outcome {
                AuthlibLogin::LoggedIn(account) => account,
                AuthlibLogin::SelectProfile(p) => panic!("期望直接登录，得到待选 {p:?}"),
            }
        }

        #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
        async fn microsoft_login_persists_and_takes_over_from_offline_selection() {
            let server = MockServer::start().await;
            mount_full_login(&server, 200).await;
            let tmp = tempfile::tempdir().unwrap();
            let aurora = aurora_at(tmp.path()).with_msa_endpoints(msa_endpoints(&server));
            let offline = aurora.add_offline_account("Steve", None).unwrap();

            let account = aurora.microsoft_login(|_| {}).await.unwrap();
            assert_eq!(account.uuid, MS_UUID);

            // 重开门面读盘：当前账户已换成刚登录的微软账户，离线号还在但不再被选中。
            // 把 store_login 里的 adopt_as_current 删掉，当前账户仍是 Steve，本断言即挂。
            let restarted = aurora_at(tmp.path());
            let current = restarted.current_account().unwrap().unwrap();
            assert_eq!(current.uuid, MS_UUID);
            assert_eq!(current.account_type, AccountType::Microsoft);
            assert_eq!(current.skin.unwrap().model, SkinModel::Slim);
            let all: Vec<_> = restarted
                .accounts()
                .unwrap()
                .into_iter()
                .map(|a| a.uuid)
                .collect();
            assert_eq!(all, [MS_UUID.to_owned(), offline.uuid.clone()]);

            // 反向再切回离线号仍然成立。
            restarted.set_current_account(&offline.uuid).unwrap();
            assert_eq!(
                aurora_at(tmp.path())
                    .current_account()
                    .unwrap()
                    .unwrap()
                    .uuid,
                offline.uuid
            );
        }

        #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
        async fn relogin_overwrites_record_but_keeps_added_at_and_clears_expired() {
            let server = MockServer::start().await;
            mount_full_login(&server, 200).await;
            let tmp = tempfile::tempdir().unwrap();
            let aurora = aurora_at(tmp.path()).with_msa_endpoints(msa_endpoints(&server));

            let first = aurora.microsoft_login(|_| {}).await.unwrap();
            aurora
                .open_credentials()
                .unwrap()
                .update(MS_UUID, |a| {
                    a.added_at = 1_000;
                    a.status = AccountStatus::Expired;
                })
                .unwrap();

            let again = aurora.microsoft_login(|_| {}).await.unwrap();
            assert_eq!(again.added_at, 1_000, "重新登录不该刷新加入时刻");
            assert_eq!(again.status, AccountStatus::Ok);
            assert!(again.last_verified_at.unwrap() >= first.last_verified_at.unwrap());
            assert_eq!(
                aurora.accounts().unwrap().len(),
                1,
                "同 uuid 覆盖而不是新增"
            );
        }

        #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
        async fn cancelled_microsoft_login_writes_nothing() {
            let server = MockServer::start().await;
            Mock::given(method("POST"))
                .and(path("/devicecode"))
                .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                    "device_code": "DEV", "user_code": "WXYZ-9999",
                    "verification_uri": "https://microsoft.com/link",
                    "expires_in": 900, "interval": 1
                })))
                .mount(&server)
                .await;
            Mock::given(method("POST"))
                .and(path("/token"))
                .respond_with(ResponseTemplate::new(400).set_body_json(json!({
                    "error": "authorization_pending", "error_description": "waiting"
                })))
                .mount(&server)
                .await;
            let tmp = tempfile::tempdir().unwrap();
            let token = crate::CancellationToken::new();
            let aurora = aurora_at(tmp.path())
                .with_msa_endpoints(msa_endpoints(&server))
                .with_cancel(token.clone());

            let trigger = token.clone();
            let err = aurora
                .microsoft_login(move |_| trigger.cancel())
                .await
                .unwrap_err();
            assert!(err.is_cancelled(), "得到 {err:?}");
            assert!(!tmp.path().join(CREDENTIALS_FILE).exists());
        }

        #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
        async fn refresh_that_requires_relogin_persists_expired() {
            let server = MockServer::start().await;
            mount_full_login(&server, 400).await;
            let tmp = tempfile::tempdir().unwrap();
            let aurora = aurora_at(tmp.path()).with_msa_endpoints(msa_endpoints(&server));
            let mut stale = Account::new(
                MS_UUID,
                "PetalPlayer",
                AccountCredentials::Microsoft(MicrosoftCredentials {
                    refresh_token: "dead-refresh".into(),
                    minecraft_token: Some("OLD".into()),
                    minecraft_expires_at: Some(1),
                }),
            );
            stale.last_verified_at = Some(7);
            aurora.store_login(stale.clone()).unwrap();

            // 启动路径：令牌过期 -> 续期 -> invalid_grant -> 需重登。
            let err = aurora.ensure_account_fresh(&stale).await.unwrap_err();
            assert!(matches!(err, CoreError::Auth(AuthError::ReloginRequired)));
            // 状态已落盘；删掉 expire 里的写库，本断言即挂。
            let stored = aurora_at(tmp.path())
                .find_account(MS_UUID)
                .unwrap()
                .unwrap();
            assert_eq!(stored.status, AccountStatus::Expired);
            assert_eq!(stored.last_verified_at, Some(7), "失败的续期不算一次验证");

            // 手动刷新同样落成失效。
            let err = aurora.refresh_account(MS_UUID).await.unwrap_err();
            assert!(matches!(err, CoreError::Auth(AuthError::ReloginRequired)));
        }

        /// 续期在网络上等回音的时候用户重新登录了同一个账户：旧 refresh token 随后被判失效，
        /// 但库里已换成新登录的凭据，新账户不能跟着被标成需要重新登录。
        /// 把 expire 里「凭据仍是被拒的那份」这一判断去掉，本用例即挂。
        #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
        async fn rejection_of_old_credentials_does_not_expire_a_fresh_relogin() {
            let server = MockServer::start().await;
            Mock::given(method("POST"))
                .and(path("/token"))
                .respond_with(
                    ResponseTemplate::new(400)
                        .set_body_json(json!({
                            "error": "invalid_grant", "error_description": "refresh token 已失效"
                        }))
                        .set_delay(Duration::from_millis(400)),
                )
                .mount(&server)
                .await;
            let tmp = tempfile::tempdir().unwrap();
            let aurora = aurora_at(tmp.path()).with_msa_endpoints(msa_endpoints(&server));
            let ms_account = |refresh: &str, expires_at: u64| {
                Account::new(
                    MS_UUID,
                    "PetalPlayer",
                    AccountCredentials::Microsoft(MicrosoftCredentials {
                        refresh_token: refresh.into(),
                        minecraft_token: Some("MC".into()),
                        minecraft_expires_at: Some(expires_at),
                    }),
                )
            };
            let stale = aurora.store_login(ms_account("dead-refresh", 1)).unwrap();

            // 等续期请求真正到了令牌端点（库里的旧凭据已经读出）才重新登录。按固定时延排先后的话，
            // 机器满载时读库会晚于重新登录，续期直接拿到新凭据、根本不发请求。
            let relogin = async {
                while server.received_requests().await.unwrap().is_empty() {
                    tokio::time::sleep(Duration::from_millis(10)).await;
                }
                let aurora = aurora.clone();
                let fresh = ms_account("new-refresh", u64::MAX);
                tokio::task::spawn_blocking(move || aurora.store_login(fresh))
                    .await
                    .unwrap()
                    .unwrap()
            };
            let (refreshed, _) = tokio::join!(aurora.ensure_account_fresh(&stale), relogin);
            let err = refreshed.unwrap_err();
            assert!(matches!(err, CoreError::Auth(AuthError::ReloginRequired)));

            let stored = aurora_at(tmp.path())
                .find_account(MS_UUID)
                .unwrap()
                .unwrap();
            assert_eq!(stored.status, AccountStatus::Ok, "新登录的账户被标成了失效");
            match &stored.credentials {
                AccountCredentials::Microsoft(c) => assert_eq!(c.refresh_token, "new-refresh"),
                other => panic!("期望 Microsoft 凭据，得到 {other:?}"),
            }
        }

        #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
        async fn expired_microsoft_token_is_refreshed_and_written_back() {
            let server = MockServer::start().await;
            mount_full_login(&server, 200).await;
            let tmp = tempfile::tempdir().unwrap();
            let aurora = aurora_at(tmp.path()).with_msa_endpoints(msa_endpoints(&server));
            let stale = Account::new(
                MS_UUID,
                "OldName",
                AccountCredentials::Microsoft(MicrosoftCredentials {
                    refresh_token: "old-refresh".into(),
                    minecraft_token: Some("OLD-MC".into()),
                    minecraft_expires_at: Some(1),
                }),
            );
            let stored = aurora.store_login(stale.clone()).unwrap();

            let fresh = aurora.ensure_account_fresh(&stored).await.unwrap();
            assert_eq!(fresh.name, "PetalPlayer");
            assert_eq!(fresh.added_at, stored.added_at);
            match &aurora_at(tmp.path())
                .find_account(MS_UUID)
                .unwrap()
                .unwrap()
                .credentials
            {
                AccountCredentials::Microsoft(c) => {
                    assert_eq!(c.refresh_token, "rotated-refresh");
                    assert_eq!(c.minecraft_token.as_deref(), Some("MC-TOKEN"));
                }
                other => panic!("期望 Microsoft 凭据，得到 {other:?}"),
            }

            // 令牌仍有效时不联网：把令牌端点改成拒绝也照样原样返回。
            server.reset().await;
            let valid = aurora.ensure_account_fresh(&fresh).await.unwrap();
            assert_eq!(valid, fresh);
            assert!(server.received_requests().await.unwrap().is_empty());
        }

        #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
        async fn authlib_login_with_selected_profile_persists_and_records_server_name() {
            let server = MockServer::start().await;
            mount_yggdrasil(
                &server,
                json!({
                    "accessToken": "acc", "clientToken": "cli",
                    "availableProfiles": [ { "id": HERO, "name": "Hero" } ],
                    "selectedProfile": { "id": HERO, "name": "Hero" }
                }),
            )
            .await;
            let tmp = tempfile::tempdir().unwrap();
            let aurora = aurora_at(tmp.path());

            let account = logged_in(
                aurora
                    .authlib_login(&server.uri(), "user@example.com", "pw")
                    .await
                    .unwrap(),
            );
            assert_eq!(account.uuid, HERO);
            assert_eq!(account.auth_server.as_deref(), Some("Petal Skin"));
            assert_eq!(account.account_type, AccountType::AuthlibInjector);
            // 会话服务器回 204：没有皮肤，登录照常成功。
            assert_eq!(account.skin, None);
            match &account.credentials {
                AccountCredentials::AuthlibInjector(c) => {
                    assert_eq!(c.api_root, format!("{}/", server.uri()));
                    assert_eq!(c.access_token, "acc");
                    assert_eq!(c.username.as_deref(), Some("user@example.com"));
                }
                other => panic!("期望外置凭据，得到 {other:?}"),
            }
            let current = aurora_at(tmp.path()).current_account().unwrap().unwrap();
            assert_eq!(current.uuid, HERO);
        }

        #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
        async fn authlib_multi_profile_waits_for_choice_then_binds_it() {
            let server = MockServer::start().await;
            mount_yggdrasil(
                &server,
                json!({
                    "accessToken": "acc", "clientToken": "cli",
                    "availableProfiles": [
                        { "id": HERO, "name": "Hero" }, { "id": ALT, "name": "Alt" }
                    ]
                }),
            )
            .await;
            // 绑定请求必须带上所选角色。
            Mock::given(method("POST"))
                .and(path("/authserver/refresh"))
                .and(body_partial_json(json!({
                    "accessToken": "acc", "clientToken": "cli",
                    "selectedProfile": { "id": ALT, "name": "Alt" }
                })))
                .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                    "accessToken": "bound-acc", "clientToken": "cli",
                    "selectedProfile": { "id": ALT, "name": "Alt" }
                })))
                .mount(&server)
                .await;
            let alt_textures = base64::Engine::encode(
                &base64::engine::general_purpose::STANDARD,
                json!({ "textures": { "SKIN": {
                    "url": "https://skins.example/alt.png", "metadata": { "model": "slim" }
                } } })
                .to_string(),
            );
            Mock::given(method("GET"))
                .and(path(format!(
                    "/sessionserver/session/minecraft/profile/{ALT}"
                )))
                .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                    "id": ALT, "name": "Alt",
                    "properties": [ { "name": "textures", "value": alt_textures } ]
                })))
                .mount(&server)
                .await;
            let tmp = tempfile::tempdir().unwrap();
            let aurora = aurora_at(tmp.path());

            let pending = match aurora.authlib_login(&server.uri(), "u", "p").await.unwrap() {
                AuthlibLogin::SelectProfile(pending) => pending,
                AuthlibLogin::LoggedIn(a) => panic!("多角色不该直接登录，却登录了 {}", a.name),
            };
            assert_eq!(pending.profiles.len(), 2);
            assert_eq!(pending.server.server_name, "Petal Skin");
            // 等待选择期间什么都没落库。
            assert!(aurora.accounts().unwrap().is_empty());

            // 角色列表的皮肤与角色一一对应：Hero 没有（204），Alt 是细臂皮肤。
            let skins = aurora.authlib_profile_skins(&pending).await;
            assert_eq!(
                skins,
                vec![
                    None,
                    Some(SkinRef {
                        url: "https://skins.example/alt.png".into(),
                        model: SkinModel::Slim,
                    })
                ]
            );

            let alt = pending.profiles[1].clone();
            let account = aurora.select_authlib_profile(&pending, &alt).await.unwrap();
            assert_eq!(account.uuid, ALT);
            assert_eq!(
                account.skin.as_ref().unwrap().url,
                "https://skins.example/alt.png"
            );
            match &account.credentials {
                AccountCredentials::AuthlibInjector(c) => {
                    assert_eq!(c.access_token, "bound-acc");
                    assert_eq!(c.username.as_deref(), Some("u"), "选角色后仍记下登录账号");
                }
                other => panic!("期望外置凭据，得到 {other:?}"),
            }
            assert_eq!(aurora.current_account().unwrap().unwrap().uuid, ALT);
        }

        #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
        async fn authlib_single_unbound_profile_is_bound_automatically() {
            let server = MockServer::start().await;
            mount_yggdrasil(
                &server,
                json!({
                    "accessToken": "acc", "clientToken": "cli",
                    "availableProfiles": [ { "id": HERO, "name": "Hero" } ]
                }),
            )
            .await;
            Mock::given(method("POST"))
                .and(path("/authserver/refresh"))
                .and(body_partial_json(
                    json!({ "selectedProfile": { "id": HERO } }),
                ))
                .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                    "accessToken": "bound", "clientToken": "cli",
                    "selectedProfile": { "id": HERO, "name": "Hero" }
                })))
                .expect(1)
                .mount(&server)
                .await;
            let tmp = tempfile::tempdir().unwrap();
            let account = logged_in(
                aurora_at(tmp.path())
                    .authlib_login(&server.uri(), "u", "p")
                    .await
                    .unwrap(),
            );
            assert_eq!(account.uuid, HERO);
            match &account.credentials {
                AccountCredentials::AuthlibInjector(c) => assert_eq!(c.access_token, "bound"),
                other => panic!("期望外置凭据，得到 {other:?}"),
            }
        }

        #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
        async fn authlib_account_without_profiles_is_a_dedicated_error() {
            let server = MockServer::start().await;
            mount_yggdrasil(
                &server,
                json!({ "accessToken": "acc", "clientToken": "cli", "availableProfiles": [] }),
            )
            .await;
            let tmp = tempfile::tempdir().unwrap();
            let err = aurora_at(tmp.path())
                .authlib_login(&server.uri(), "u", "p")
                .await
                .err()
                .expect("没有角色必须报错");
            assert!(matches!(
                err,
                CoreError::Auth(AuthError::YggdrasilNoProfile)
            ));
            assert!(!tmp.path().join(CREDENTIALS_FILE).exists());
        }

        #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
        async fn authlib_rejected_token_at_launch_marks_expired() {
            let server = MockServer::start().await;
            Mock::given(method("POST"))
                .and(path("/authserver/validate"))
                .respond_with(ResponseTemplate::new(403).set_body_json(json!({
                    "error": "ForbiddenOperationException", "errorMessage": "Invalid token."
                })))
                .mount(&server)
                .await;
            Mock::given(method("POST"))
                .and(path("/authserver/refresh"))
                .respond_with(ResponseTemplate::new(403).set_body_json(json!({
                    "error": "ForbiddenOperationException", "errorMessage": "Invalid token."
                })))
                .mount(&server)
                .await;
            let tmp = tempfile::tempdir().unwrap();
            let aurora = aurora_at(tmp.path());
            let info = AuthServerInfo {
                api_root: format!("{}/", server.uri()),
                server_name: "Petal Skin".into(),
                host: "127.0.0.1".into(),
            };
            let account = aurora
                .store_login(authlib_account(
                    &info,
                    "hero@example.com",
                    "acc".into(),
                    "cli".into(),
                    GameProfile {
                        id: HERO.into(),
                        name: "Hero".into(),
                    },
                    None,
                ))
                .unwrap();

            let err = aurora.ensure_account_fresh(&account).await.unwrap_err();
            assert!(matches!(err, CoreError::Auth(AuthError::ReloginRequired)));
            let stored = aurora_at(tmp.path()).find_account(HERO).unwrap().unwrap();
            assert_eq!(stored.status, AccountStatus::Expired);
        }

        /// 启动前的静默续期与账户页的手动刷新同时撞上同一个外置账户。外置刷新会让旧令牌当场作废：
        /// 两边都拿旧令牌去刷时后到的一方必被服务器拒绝，账户被误判成需要重新登录、启动随之失败。
        /// 续期按账户排队、后到的一方先重读库里的凭据之后，两边都成功，旧令牌只被刷一次。
        /// 去掉续期闸，本用例即挂。
        #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
        async fn concurrent_authlib_refreshes_do_not_burn_each_others_token() {
            let server = MockServer::start().await;
            mount_yggdrasil(&server, json!({})).await;
            let forbidden = || {
                ResponseTemplate::new(403).set_body_json(json!({
                    "error": "ForbiddenOperationException", "errorMessage": "Invalid token."
                }))
            };
            Mock::given(method("POST"))
                .and(path("/authserver/validate"))
                .and(body_partial_json(json!({ "accessToken": "stale" })))
                .respond_with(forbidden())
                .mount(&server)
                .await;
            Mock::given(method("POST"))
                .and(path("/authserver/validate"))
                .and(body_partial_json(json!({ "accessToken": "fresh" })))
                .respond_with(ResponseTemplate::new(204))
                .mount(&server)
                .await;
            // 头一次拿旧令牌刷新成功，但慢一拍，好让另一边在它返回前也发出请求；之后旧令牌作废。
            Mock::given(method("POST"))
                .and(path("/authserver/refresh"))
                .and(body_partial_json(json!({ "accessToken": "stale" })))
                .respond_with(
                    ResponseTemplate::new(200)
                        .set_body_json(json!({
                            "accessToken": "fresh", "clientToken": "cli",
                            "selectedProfile": { "id": HERO, "name": "Hero" }
                        }))
                        .set_delay(Duration::from_millis(300)),
                )
                .up_to_n_times(1)
                .mount(&server)
                .await;
            Mock::given(method("POST"))
                .and(path("/authserver/refresh"))
                .and(body_partial_json(json!({ "accessToken": "stale" })))
                .respond_with(forbidden())
                .mount(&server)
                .await;
            // 手动刷新排在后面时，拿到的是刚续出的新令牌：校验有效，不再轮换。
            Mock::given(method("POST"))
                .and(path("/authserver/refresh"))
                .and(body_partial_json(json!({ "accessToken": "fresh" })))
                .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                    "accessToken": "fresher", "clientToken": "cli",
                    "selectedProfile": { "id": HERO, "name": "Hero" }
                })))
                .expect(0)
                .mount(&server)
                .await;
            let tmp = tempfile::tempdir().unwrap();
            let aurora = aurora_at(tmp.path());
            let info = AuthServerInfo {
                api_root: format!("{}/", server.uri()),
                server_name: "Petal Skin".into(),
                host: "127.0.0.1".into(),
            };
            let account = aurora
                .store_login(authlib_account(
                    &info,
                    "hero@example.com",
                    "stale".into(),
                    "cli".into(),
                    GameProfile {
                        id: HERO.into(),
                        name: "Hero".into(),
                    },
                    None,
                ))
                .unwrap();

            let (launch, manual) = tokio::join!(
                aurora.ensure_account_fresh(&account),
                aurora.refresh_account(HERO)
            );
            let launch = launch.expect("启动前的续期不该被另一次刷新拖成需重登");
            let manual = manual.expect("手动刷新不该被另一次续期拖成需重登");
            for refreshed in [&launch, &manual] {
                match &refreshed.credentials {
                    AccountCredentials::AuthlibInjector(c) => assert_ne!(c.access_token, "stale"),
                    other => panic!("期望外置凭据，得到 {other:?}"),
                }
            }
            let stored = aurora_at(tmp.path()).find_account(HERO).unwrap().unwrap();
            assert_eq!(stored.status, AccountStatus::Ok);
            let stale_refreshes = server
                .received_requests()
                .await
                .unwrap()
                .into_iter()
                .filter(|r| {
                    r.url.path() == "/authserver/refresh"
                        && serde_json::from_slice::<serde_json::Value>(&r.body).unwrap()
                            ["accessToken"]
                            == "stale"
                })
                .count();
            assert_eq!(stale_refreshes, 1, "旧令牌只该被刷一次");
        }

        /// 刷新换了令牌，登录账号照旧留着：重新登录时还要拿它预填。
        #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
        async fn authlib_refresh_keeps_the_login_username() {
            let server = MockServer::start().await;
            mount_yggdrasil(&server, json!({})).await;
            Mock::given(method("POST"))
                .and(path("/authserver/validate"))
                .respond_with(ResponseTemplate::new(403).set_body_json(json!({
                    "error": "ForbiddenOperationException", "errorMessage": "Invalid token."
                })))
                .mount(&server)
                .await;
            Mock::given(method("POST"))
                .and(path("/authserver/refresh"))
                .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                    "accessToken": "fresh", "clientToken": "cli",
                    "selectedProfile": { "id": HERO, "name": "Hero" }
                })))
                .expect(1)
                .mount(&server)
                .await;
            let tmp = tempfile::tempdir().unwrap();
            let aurora = aurora_at(tmp.path());
            let info = AuthServerInfo {
                api_root: format!("{}/", server.uri()),
                server_name: "Petal Skin".into(),
                host: "127.0.0.1".into(),
            };
            aurora
                .store_login(authlib_account(
                    &info,
                    "hero@example.com",
                    "stale".into(),
                    "cli".into(),
                    GameProfile {
                        id: HERO.into(),
                        name: "Hero".into(),
                    },
                    None,
                ))
                .unwrap();

            aurora.refresh_account(HERO).await.unwrap();
            let stored = aurora_at(tmp.path()).find_account(HERO).unwrap().unwrap();
            match &stored.credentials {
                AccountCredentials::AuthlibInjector(c) => {
                    assert_eq!(c.access_token, "fresh");
                    assert_eq!(c.username.as_deref(), Some("hero@example.com"));
                }
                other => panic!("期望外置凭据，得到 {other:?}"),
            }
        }

        /// 手动刷新外置账户，令牌仍有效：只从会话服务器更新角色名与皮肤，令牌原样不动，一个刷新请求都不发。
        /// 刷新会让旧令牌当场作废，正在运行的游戏手里拿着的就是它。把手动刷新改回直接刷新，本用例即挂。
        #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
        async fn manual_authlib_refresh_with_valid_token_keeps_the_token() {
            let server = MockServer::start().await;
            Mock::given(method("POST"))
                .and(path("/authserver/validate"))
                .and(body_partial_json(
                    json!({ "accessToken": "acc", "clientToken": "cli" }),
                ))
                .respond_with(ResponseTemplate::new(204))
                .expect(1)
                .mount(&server)
                .await;
            let textures = base64::Engine::encode(
                &base64::engine::general_purpose::STANDARD,
                json!({ "textures": { "SKIN": {
                    "url": "https://skins.example/renamed.png", "metadata": { "model": "slim" }
                } } })
                .to_string(),
            );
            Mock::given(method("GET"))
                .and(path(format!(
                    "/sessionserver/session/minecraft/profile/{STILL_VALID}"
                )))
                .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                    "id": STILL_VALID, "name": "HeroRenamed",
                    "properties": [ { "name": "textures", "value": textures } ]
                })))
                .mount(&server)
                .await;
            Mock::given(method("POST"))
                .and(path("/authserver/refresh"))
                .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                    "accessToken": "rotated", "clientToken": "cli",
                    "selectedProfile": { "id": STILL_VALID, "name": "HeroRenamed" }
                })))
                .expect(0)
                .mount(&server)
                .await;
            let tmp = tempfile::tempdir().unwrap();
            let aurora = aurora_at(tmp.path());
            let info = AuthServerInfo {
                api_root: format!("{}/", server.uri()),
                server_name: "Petal Skin".into(),
                host: "127.0.0.1".into(),
            };
            let mut account = authlib_account(
                &info,
                "hero@example.com",
                "acc".into(),
                "cli".into(),
                GameProfile {
                    id: STILL_VALID.into(),
                    name: "Hero".into(),
                },
                None,
            );
            account.last_verified_at = Some(1);
            let before = aurora.store_login(account).unwrap();

            let refreshed = aurora.refresh_account(STILL_VALID).await.unwrap();
            assert_eq!(refreshed.name, "HeroRenamed");
            assert_eq!(
                refreshed.skin,
                Some(SkinRef {
                    url: "https://skins.example/renamed.png".into(),
                    model: SkinModel::Slim,
                })
            );
            assert_eq!(refreshed.credentials, before.credentials, "令牌不该被轮换");
            assert!(refreshed.last_verified_at.unwrap() > 1);
            let stored = aurora_at(tmp.path())
                .find_account(STILL_VALID)
                .unwrap()
                .unwrap();
            assert_eq!(stored, refreshed);
            let refreshes = server
                .received_requests()
                .await
                .unwrap()
                .into_iter()
                .filter(|r| r.url.path() == "/authserver/refresh")
                .count();
            assert_eq!(refreshes, 0, "令牌有效时不该发刷新请求");
        }

        /// 令牌有效、会话服务器却查不到档案（连不上）：照样算一次验证，角色名与皮肤保持原样，不拿空值盖掉。
        #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
        async fn manual_authlib_refresh_keeps_name_and_skin_when_profile_is_unavailable() {
            let server = MockServer::start().await;
            Mock::given(method("POST"))
                .and(path("/authserver/validate"))
                .respond_with(ResponseTemplate::new(204))
                .mount(&server)
                .await;
            Mock::given(method("GET"))
                .and(path(format!(
                    "/sessionserver/session/minecraft/profile/{PROFILE_DOWN}"
                )))
                .respond_with(ResponseTemplate::new(503))
                .mount(&server)
                .await;
            let tmp = tempfile::tempdir().unwrap();
            let aurora = aurora_at(tmp.path());
            let info = AuthServerInfo {
                api_root: format!("{}/", server.uri()),
                server_name: "Petal Skin".into(),
                host: "127.0.0.1".into(),
            };
            let skin = SkinRef {
                url: "https://skins.example/hero.png".into(),
                model: SkinModel::Wide,
            };
            let before = aurora
                .store_login(authlib_account(
                    &info,
                    "hero@example.com",
                    "acc".into(),
                    "cli".into(),
                    GameProfile {
                        id: PROFILE_DOWN.into(),
                        name: "Hero".into(),
                    },
                    Some(skin.clone()),
                ))
                .unwrap();

            let refreshed = aurora.refresh_account(PROFILE_DOWN).await.unwrap();
            assert_eq!(refreshed.name, "Hero");
            assert_eq!(refreshed.skin, Some(skin));
            assert_eq!(refreshed.credentials, before.credentials);
            assert!(refreshed.last_verified_at >= before.last_verified_at);
        }

        /// 令牌失效、刷新成功换了新令牌，会话服务器却查不到档案（连不上）：名字取刷新回音里的，皮肤保持原样，
        /// 不因一次连不上就把皮肤清掉。
        #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
        async fn rotated_authlib_refresh_keeps_skin_when_profile_is_unavailable() {
            let server = MockServer::start().await;
            Mock::given(method("POST"))
                .and(path("/authserver/validate"))
                .respond_with(ResponseTemplate::new(403).set_body_json(json!({
                    "error": "ForbiddenOperationException", "errorMessage": "Invalid token."
                })))
                .mount(&server)
                .await;
            Mock::given(method("POST"))
                .and(path("/authserver/refresh"))
                .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                    "accessToken": "rotated", "clientToken": "cli",
                    "selectedProfile": { "id": ROTATED_PROFILE_DOWN, "name": "HeroRenamed" }
                })))
                .expect(1)
                .mount(&server)
                .await;
            Mock::given(method("GET"))
                .and(path(format!(
                    "/sessionserver/session/minecraft/profile/{ROTATED_PROFILE_DOWN}"
                )))
                .respond_with(ResponseTemplate::new(503))
                .mount(&server)
                .await;
            let tmp = tempfile::tempdir().unwrap();
            let aurora = aurora_at(tmp.path());
            let info = AuthServerInfo {
                api_root: format!("{}/", server.uri()),
                server_name: "Petal Skin".into(),
                host: "127.0.0.1".into(),
            };
            let skin = SkinRef {
                url: "https://skins.example/hero.png".into(),
                model: SkinModel::Slim,
            };
            aurora
                .store_login(authlib_account(
                    &info,
                    "hero@example.com",
                    "acc".into(),
                    "cli".into(),
                    GameProfile {
                        id: ROTATED_PROFILE_DOWN.into(),
                        name: "Hero".into(),
                    },
                    Some(skin.clone()),
                ))
                .unwrap();

            let refreshed = aurora.refresh_account(ROTATED_PROFILE_DOWN).await.unwrap();
            assert_eq!(refreshed.name, "HeroRenamed");
            assert_eq!(refreshed.skin, Some(skin), "档案取不到时皮肤不该被清掉");
            let AccountCredentials::AuthlibInjector(creds) = &refreshed.credentials else {
                panic!("应仍是外置账户：{:?}", refreshed.credentials);
            };
            assert_eq!(creds.access_token, "rotated");
            let stored = aurora_at(tmp.path())
                .find_account(ROTATED_PROFILE_DOWN)
                .unwrap()
                .unwrap();
            assert_eq!(stored, refreshed);
        }

        #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
        async fn authlib_valid_token_records_verification_time() {
            let server = MockServer::start().await;
            Mock::given(method("POST"))
                .and(path("/authserver/validate"))
                .respond_with(ResponseTemplate::new(204))
                .mount(&server)
                .await;
            let tmp = tempfile::tempdir().unwrap();
            let aurora = aurora_at(tmp.path());
            let info = AuthServerInfo {
                api_root: format!("{}/", server.uri()),
                server_name: "Petal Skin".into(),
                host: "127.0.0.1".into(),
            };
            let mut account = authlib_account(
                &info,
                "hero@example.com",
                "acc".into(),
                "cli".into(),
                GameProfile {
                    id: HERO.into(),
                    name: "Hero".into(),
                },
                None,
            );
            account.last_verified_at = Some(1);
            let account = aurora.store_login(account).unwrap();

            let checked = aurora.ensure_account_fresh(&account).await.unwrap();
            assert!(checked.last_verified_at.unwrap() > 1);
            assert_eq!(
                aurora_at(tmp.path())
                    .find_account(HERO)
                    .unwrap()
                    .unwrap()
                    .last_verified_at,
                checked.last_verified_at
            );
        }

        /// 等到 mock 服务器收到发往 `endpoint` 的请求。
        async fn until_requested(server: &MockServer, endpoint: &str) {
            tokio::time::timeout(Duration::from_secs(15), async {
                while !server
                    .received_requests()
                    .await
                    .unwrap()
                    .iter()
                    .any(|r| r.url.path() == endpoint)
                {
                    tokio::time::sleep(Duration::from_millis(5)).await;
                }
            })
            .await
            .unwrap_or_else(|_| panic!("15 秒内没等到 {endpoint} 的请求"));
        }

        /// 续期闸只管同一份凭据库里的同一个账户：另一个数据目录里 uuid 相同的续期不该排在它后面。
        /// 闸只按 uuid 取的话，这里的第二次续期要等第一次的 30 秒走完。
        #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
        async fn renewals_in_different_data_dirs_do_not_queue_behind_each_other() {
            let slow = MockServer::start().await;
            Mock::given(method("POST"))
                .and(path("/token"))
                .respond_with(ResponseTemplate::new(200).set_delay(Duration::from_secs(30)))
                .mount(&slow)
                .await;
            let quick = MockServer::start().await;
            Mock::given(method("POST"))
                .and(path("/token"))
                .respond_with(ResponseTemplate::new(400).set_body_json(json!({
                    "error": "invalid_grant", "error_description": "refresh token 已失效"
                })))
                .mount(&quick)
                .await;
            let (slow_dir, quick_dir) =
                (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
            let held = aurora_at(slow_dir.path()).with_msa_endpoints(msa_endpoints(&slow));
            let other = aurora_at(quick_dir.path()).with_msa_endpoints(msa_endpoints(&quick));
            let stale = Account::new(
                SHARED_UUID,
                "PetalPlayer",
                AccountCredentials::Microsoft(MicrosoftCredentials {
                    refresh_token: "old-refresh".into(),
                    minecraft_token: None,
                    minecraft_expires_at: None,
                }),
            );
            held.store_login(stale.clone()).unwrap();
            other.store_login(stale.clone()).unwrap();

            let holder = {
                let stale = stale.clone();
                tokio::spawn(async move { held.ensure_account_fresh(&stale).await })
            };
            until_requested(&slow, "/token").await;
            let err =
                tokio::time::timeout(Duration::from_secs(10), other.ensure_account_fresh(&stale))
                    .await
                    .expect("另一个数据目录的续期被这道闸挡住了")
                    .unwrap_err();
            assert!(matches!(err, CoreError::Auth(AuthError::ReloginRequired)));
            holder.abort();
        }

        /// 等到库里的账户满足 `done`，超时即失败。续期在后台跑完落盘，调用方那时早已返回。
        async fn until_stored(
            data_dir: &std::path::Path,
            uuid: &str,
            done: impl Fn(&Account) -> bool,
        ) -> Account {
            let deadline = std::time::Instant::now() + Duration::from_secs(15);
            loop {
                let stored = aurora_at(data_dir).find_account(uuid).unwrap().unwrap();
                if done(&stored) {
                    return stored;
                }
                assert!(
                    std::time::Instant::now() < deadline,
                    "15 秒内续出的凭据没有写进凭据库：{:?}",
                    stored.credentials
                );
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        }

        fn stored_authlib_token(account: &Account) -> &str {
            match &account.credentials {
                AccountCredentials::AuthlibInjector(c) => &c.access_token,
                other => panic!("期望外置凭据，得到 {other:?}"),
            }
        }

        /// 外置令牌的刷新请求已经发出、回音还没到时启动被放弃：命令层在取消宽限期满后直接丢掉启动的
        /// future。服务器这边旧令牌已经作废，新令牌要是跟着被丢掉，账户就只能重新登录。续期放进独立任务
        /// 之后，丢掉的只是等待，新令牌照样写进凭据库。把续期挪回调用方的 future 里，本用例即挂。
        #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
        async fn abandoned_launch_still_persists_the_rotated_authlib_token() {
            let server = MockServer::start().await;
            mount_yggdrasil(&server, json!({})).await;
            Mock::given(method("POST"))
                .and(path("/authserver/validate"))
                .respond_with(ResponseTemplate::new(403).set_body_json(json!({
                    "error": "ForbiddenOperationException", "errorMessage": "Invalid token."
                })))
                .mount(&server)
                .await;
            Mock::given(method("POST"))
                .and(path("/authserver/refresh"))
                .and(body_partial_json(json!({ "accessToken": "stale" })))
                .respond_with(
                    ResponseTemplate::new(200)
                        .set_body_json(json!({
                            "accessToken": "rotated", "clientToken": "cli",
                            "selectedProfile": { "id": ABANDONED_LAUNCH, "name": "Hero" }
                        }))
                        .set_delay(Duration::from_millis(300)),
                )
                .expect(1)
                .mount(&server)
                .await;
            let tmp = tempfile::tempdir().unwrap();
            let aurora = aurora_at(tmp.path());
            let info = AuthServerInfo {
                api_root: format!("{}/", server.uri()),
                server_name: "Petal Skin".into(),
                host: "127.0.0.1".into(),
            };
            let account = aurora
                .store_login(authlib_account(
                    &info,
                    "hero@example.com",
                    "stale".into(),
                    "cli".into(),
                    GameProfile {
                        id: ABANDONED_LAUNCH.into(),
                        name: "Hero".into(),
                    },
                    None,
                ))
                .unwrap();

            let launch = {
                let aurora = aurora.clone();
                tokio::spawn(async move { aurora.ensure_account_fresh(&account).await })
            };
            until_requested(&server, "/authserver/refresh").await;
            launch.abort();
            assert!(launch.await.unwrap_err().is_cancelled());

            let stored = until_stored(tmp.path(), ABANDONED_LAUNCH, |a| {
                stored_authlib_token(a) != "stale"
            })
            .await;
            assert_eq!(stored_authlib_token(&stored), "rotated");
            assert_eq!(stored.status, AccountStatus::Ok);
        }

        /// 启动在微软令牌链续期途中被取消（令牌端点已经轮换了 refresh token，XBL 还没回音）：调用方立刻以
        /// 取消返回，续期在后台走完令牌链，轮换后的 refresh token 照样写进凭据库。原先取消令牌一路挂到
        /// 令牌链上，链在半途停下，轮换出的 refresh token 跟着丢了。
        #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
        async fn cancelled_launch_still_persists_the_rotated_microsoft_refresh_token() {
            let server = MockServer::start().await;
            mount_full_login(&server, 200).await;
            // 让 XBL 慢一拍：取消落在令牌端点轮换之后、整条链跑完之前。
            Mock::given(method("POST"))
                .and(path("/xbl"))
                .respond_with(
                    ResponseTemplate::new(200)
                        .set_body_json(json!({
                            "Token": "xbl", "DisplayClaims": { "xui": [ { "uhs": "theuhs" } ] }
                        }))
                        .set_delay(Duration::from_millis(400)),
                )
                .with_priority(1)
                .mount(&server)
                .await;
            let tmp = tempfile::tempdir().unwrap();
            let token = crate::CancellationToken::new();
            let aurora = aurora_at(tmp.path()).with_msa_endpoints(msa_endpoints(&server));
            let stale = aurora
                .store_login(Account::new(
                    MS_UUID,
                    "PetalPlayer",
                    AccountCredentials::Microsoft(MicrosoftCredentials {
                        refresh_token: "old-refresh".into(),
                        minecraft_token: Some("OLD-MC".into()),
                        minecraft_expires_at: Some(1),
                    }),
                ))
                .unwrap();

            let launch = {
                let snapshot = aurora.clone().with_cancel(token.clone());
                tokio::spawn(async move { snapshot.ensure_account_fresh(&stale).await })
            };
            until_requested(&server, "/xbl").await;
            token.cancel();
            let returned = tokio::time::timeout(Duration::from_millis(200), launch)
                .await
                .expect("取消后调用方应立刻返回，不等续期跑完")
                .unwrap();
            assert!(
                returned.as_ref().is_err_and(CoreError::is_cancelled),
                "{returned:?}"
            );

            let stored = until_stored(tmp.path(), MS_UUID, |a| {
                matches!(&a.credentials, AccountCredentials::Microsoft(c) if c.refresh_token != "old-refresh")
            })
            .await;
            match &stored.credentials {
                AccountCredentials::Microsoft(c) => {
                    assert_eq!(c.refresh_token, "rotated-refresh");
                    assert_eq!(c.minecraft_token.as_deref(), Some("MC-TOKEN"));
                }
                other => panic!("期望 Microsoft 凭据，得到 {other:?}"),
            }
        }

        /// 手动刷新被取消也一样：外置令牌刷新发出后调用方立刻以取消返回，新令牌照样落盘。
        /// 已经取消了才来的续期压根不发请求。
        #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
        async fn cancelled_manual_refresh_still_persists_and_precancelled_one_sends_nothing() {
            let server = MockServer::start().await;
            mount_yggdrasil(&server, json!({})).await;
            Mock::given(method("POST"))
                .and(path("/authserver/validate"))
                .respond_with(ResponseTemplate::new(403).set_body_json(json!({
                    "error": "ForbiddenOperationException", "errorMessage": "Invalid token."
                })))
                .mount(&server)
                .await;
            Mock::given(method("POST"))
                .and(path("/authserver/refresh"))
                .respond_with(
                    ResponseTemplate::new(200)
                        .set_body_json(json!({
                            "accessToken": "rotated", "clientToken": "cli",
                            "selectedProfile": { "id": CANCELLED_REFRESH, "name": "Hero" }
                        }))
                        .set_delay(Duration::from_millis(300)),
                )
                .expect(1)
                .mount(&server)
                .await;
            let tmp = tempfile::tempdir().unwrap();
            let aurora = aurora_at(tmp.path());
            let info = AuthServerInfo {
                api_root: format!("{}/", server.uri()),
                server_name: "Petal Skin".into(),
                host: "127.0.0.1".into(),
            };
            aurora
                .store_login(authlib_account(
                    &info,
                    "hero@example.com",
                    "stale".into(),
                    "cli".into(),
                    GameProfile {
                        id: CANCELLED_REFRESH.into(),
                        name: "Hero".into(),
                    },
                    None,
                ))
                .unwrap();

            let precancelled = crate::CancellationToken::new();
            precancelled.cancel();
            let err = aurora
                .clone()
                .with_cancel(precancelled)
                .refresh_account(CANCELLED_REFRESH)
                .await
                .unwrap_err();
            assert!(err.is_cancelled(), "{err:?}");
            assert!(server.received_requests().await.unwrap().is_empty());

            let token = crate::CancellationToken::new();
            let refresh = {
                let snapshot = aurora.clone().with_cancel(token.clone());
                tokio::spawn(async move { snapshot.refresh_account(CANCELLED_REFRESH).await })
            };
            until_requested(&server, "/authserver/refresh").await;
            token.cancel();
            let returned = tokio::time::timeout(Duration::from_millis(200), refresh)
                .await
                .expect("取消后调用方应立刻返回")
                .unwrap();
            assert!(
                returned.as_ref().is_err_and(CoreError::is_cancelled),
                "{returned:?}"
            );
            let stored = until_stored(tmp.path(), CANCELLED_REFRESH, |a| {
                stored_authlib_token(a) != "stale"
            })
            .await;
            assert_eq!(stored_authlib_token(&stored), "rotated");
        }

        /// 删掉最后一个凭据账户后，当前账户必须回落到还留着的离线号；凭据库里还有别的账户时，
        /// 选中权留在凭据库。把 remove_account 里那段回落删掉，本用例即挂。
        #[test]
        fn removing_the_last_credential_account_hands_the_selection_back_to_offline() {
            let tmp = tempfile::tempdir().unwrap();
            let aurora = aurora_at(tmp.path());
            let offline = aurora.add_offline_account("Alex", None).unwrap();

            let credential_account = |uuid: &str, name: &str| {
                aurora
                    .store_login(Account::new(
                        uuid,
                        name,
                        AccountCredentials::Microsoft(MicrosoftCredentials {
                            refresh_token: "r".into(),
                            minecraft_token: Some("MC".into()),
                            minecraft_expires_at: Some(u64::MAX),
                        }),
                    ))
                    .unwrap()
            };
            let first = credential_account(MS_UUID, "PetalPlayer");
            let second = credential_account("fedcba9876543210fedcba9876543210", "PetalBackup");

            aurora.remove_account(&second.uuid).unwrap();
            let after_first_removal = aurora.current_account().unwrap().unwrap();
            assert_eq!(after_first_removal.uuid, first.uuid);

            aurora.remove_account(&first.uuid).unwrap();
            let restarted = aurora_at(tmp.path());
            let current = restarted
                .current_account()
                .unwrap()
                .expect("删掉最后一个凭据账户后，剩下的离线账户必须接手当前账户");
            assert_eq!(current.uuid, offline.uuid);
            assert_eq!(current.account_type, AccountType::Offline);
        }

        /// 数据目录里留存下来的坏凭据库，按文件名排序。
        fn preserved_credentials(dir: &std::path::Path) -> Vec<std::path::PathBuf> {
            let prefix = format!("{CREDENTIALS_FILE}{BROKEN_SUFFIX}");
            let mut found: Vec<_> = std::fs::read_dir(dir)
                .unwrap()
                .map(|entry| entry.unwrap().path())
                .filter(|path| {
                    path.file_name()
                        .and_then(|name| name.to_str())
                        .is_some_and(|name| name.starts_with(&prefix))
                })
                .collect();
            found.sort();
            found
        }

        /// 三种读不出来的凭据库：空文件、随机字节（换了机器或 Windows 用户后的密文在这台机器上就是这样）、
        /// 能解密但解出来不是账户库。
        fn unreadable_credential_files(dir: &std::path::Path) -> Vec<(&'static str, Vec<u8>)> {
            use aurora_auth::CredentialStore as _;
            let mut noise = vec![0u8; fastrand::usize(1..=512)];
            fastrand::fill(&mut noise);
            let foreign = dir.join("foreign.bin");
            aurora_auth::DpapiCredentialStore::at(&foreign)
                .save(br#"{"accounts": "not-a-list"}"#)
                .unwrap();
            let not_a_database = std::fs::read(&foreign).unwrap();
            std::fs::remove_file(&foreign).unwrap();
            vec![
                ("空文件", Vec::new()),
                ("随机字节", noise),
                ("不是账户库", not_a_database),
            ]
        }

        /// credentials.bin 解不开或解出来不是账户库时，整个账户系统不能跟着不可用：原文件逐字节原样改名留存，
        /// 按空凭据库继续，离线账户照常列出、仍是当前账户，之后登录照常写进新的凭据库，留存的文件不受影响。
        /// 把 open_credentials 里的留存处置去掉，列账户就报错，本用例即挂。
        #[test]
        fn unreadable_credential_store_is_preserved_and_accounts_keep_working() {
            let scratch = tempfile::tempdir().unwrap();
            for (case, garbage) in unreadable_credential_files(scratch.path()) {
                let tmp = tempfile::tempdir().unwrap();
                let aurora = aurora_at(tmp.path());
                let steve = aurora.add_offline_account("Steve", None).unwrap();
                let credentials = tmp.path().join(CREDENTIALS_FILE);
                std::fs::write(&credentials, &garbage).unwrap();

                let listed: Vec<_> = aurora
                    .accounts()
                    .unwrap_or_else(|err| panic!("{case}：凭据库读不出来时离线账户也列不出：{err}"))
                    .into_iter()
                    .map(|a| a.uuid)
                    .collect();
                assert_eq!(listed, std::slice::from_ref(&steve.uuid), "{case}");
                assert_eq!(
                    aurora.current_account().unwrap().unwrap().uuid,
                    steve.uuid,
                    "{case}"
                );
                assert!(!credentials.exists(), "{case}：坏文件应已改名挪开");
                let preserved = preserved_credentials(tmp.path());
                assert_eq!(preserved.len(), 1, "{case}：只留存一份：{preserved:?}");
                assert_eq!(std::fs::read(&preserved[0]).unwrap(), garbage, "{case}");

                aurora
                    .store_login(Account::new(
                        MS_UUID,
                        "PetalPlayer",
                        AccountCredentials::Microsoft(MicrosoftCredentials {
                            refresh_token: "after-recovery".into(),
                            minecraft_token: None,
                            minecraft_expires_at: None,
                        }),
                    ))
                    .unwrap();
                let restarted = aurora_at(tmp.path());
                let stored = restarted.find_account(MS_UUID).unwrap().expect(case);
                match &stored.credentials {
                    AccountCredentials::Microsoft(c) => {
                        assert_eq!(c.refresh_token, "after-recovery", "{case}")
                    }
                    other => panic!("{case}：期望 Microsoft 凭据，得到 {other:?}"),
                }
                assert_eq!(restarted.accounts().unwrap().len(), 2, "{case}");
                assert_eq!(preserved_credentials(tmp.path()), preserved, "{case}");
                assert_eq!(std::fs::read(&preserved[0]).unwrap(), garbage, "{case}");
            }
        }

        /// 启动提示要的经过：留存路径与原因。不论是这次查询先碰上坏文件，还是账户列表先碰上，经过都在，
        /// 且只处置一次；之后再查还是同一份。去掉留存表的登记，本用例即挂。
        #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
        async fn credential_recoveries_report_the_preserved_file_once() {
            let scratch = tempfile::tempdir().unwrap();
            for (case, garbage) in unreadable_credential_files(scratch.path()) {
                for listed_first in [false, true] {
                    let tmp = tempfile::tempdir().unwrap();
                    let aurora = aurora_at(tmp.path());
                    assert!(aurora.credential_recoveries().await.unwrap().is_empty());
                    std::fs::write(tmp.path().join(CREDENTIALS_FILE), &garbage).unwrap();
                    if listed_first {
                        assert!(aurora.accounts().unwrap().is_empty(), "{case}");
                    }

                    let recoveries = aurora.credential_recoveries().await.unwrap();
                    let preserved = preserved_credentials(tmp.path());
                    assert_eq!(preserved.len(), 1, "{case}");
                    assert_eq!(recoveries.len(), 1, "{case}：{recoveries:?}");
                    assert_eq!(recoveries[0].preserved, preserved[0], "{case}");
                    let name = preserved[0].file_name().unwrap().to_str().unwrap();
                    let stamp = name
                        .strip_prefix(&format!("{CREDENTIALS_FILE}{BROKEN_SUFFIX}"))
                        .unwrap();
                    assert!(
                        stamp.len() == 15
                            && stamp.as_bytes()[8] == b'-'
                            && stamp.chars().filter(char::is_ascii_digit).count() == 14,
                        "{case}：留存名应带 YYYYMMDD-HHMMSS 的本地时间：{name}"
                    );
                    let expected_reason = if case == "不是账户库" {
                        "凭据反序列化失败"
                    } else {
                        "Windows DPAPI 解密失败"
                    };
                    assert!(
                        recoveries[0].error.starts_with(expected_reason),
                        "{case}：{}",
                        recoveries[0].error
                    );
                    if case == "不是账户库" {
                        assert!(
                            recoveries[0].error.contains("line 1"),
                            "原因链里应带 JSON 的行列：{}",
                            recoveries[0].error
                        );
                    }

                    assert_eq!(aurora.credential_recoveries().await.unwrap(), recoveries);
                    assert_eq!(preserved_credentials(tmp.path()), preserved);
                }
            }
        }

        /// 留存名已被占用（同一秒里又坏了一次）：另取 `-2`，先前那份不被顶掉。Windows 上的 rename 会
        /// 直接覆盖已存在的目标，去掉占用检查本用例即挂。
        #[test]
        fn preserving_never_overwrites_an_earlier_copy() {
            use chrono::{Datelike, Local, Timelike};
            let tmp = tempfile::tempdir().unwrap();
            let aurora = aurora_at(tmp.path());
            let credentials = tmp.path().join(CREDENTIALS_FILE);
            // 从现在起往后几秒的留存名都先占上，不论用例跑到哪一秒，头一个候选都已被占用。
            let start = Local::now();
            let occupied: Vec<_> = (0..3)
                .map(|offset| {
                    let at = start + chrono::Duration::seconds(offset);
                    let name = format!(
                        "{CREDENTIALS_FILE}{BROKEN_SUFFIX}{:04}{:02}{:02}-{:02}{:02}{:02}",
                        at.year(),
                        at.month(),
                        at.day(),
                        at.hour(),
                        at.minute(),
                        at.second()
                    );
                    let path = tmp.path().join(name);
                    std::fs::write(&path, format!("earlier {offset}")).unwrap();
                    path
                })
                .collect();
            std::fs::write(&credentials, b"broken again").unwrap();

            aurora.accounts().unwrap();
            let all = preserved_credentials(tmp.path());
            assert_eq!(all.len(), occupied.len() + 1, "{all:?}");
            for (offset, path) in occupied.iter().enumerate() {
                assert_eq!(
                    std::fs::read_to_string(path).unwrap(),
                    format!("earlier {offset}")
                );
            }
            let fresh = all.iter().find(|p| !occupied.contains(p)).unwrap();
            assert!(
                fresh.to_str().unwrap().ends_with("-2"),
                "头一个候选被占用时应追加 -2：{}",
                fresh.display()
            );
            assert_eq!(std::fs::read(fresh).unwrap(), b"broken again");
        }

        /// 读文件本身失败（这里是同名目录占着凭据库的位置）不是坏文件：照实报错，什么都不挪。
        #[test]
        fn credential_store_that_cannot_be_read_is_reported_not_moved() {
            let tmp = tempfile::tempdir().unwrap();
            let aurora = aurora_at(tmp.path());
            let credentials = tmp.path().join(CREDENTIALS_FILE);
            std::fs::create_dir(&credentials).unwrap();
            let err = aurora.accounts().unwrap_err();
            assert!(
                matches!(
                    &err,
                    CoreError::Auth(AuthError::Base(aurora_base::Error::Io { .. }))
                ),
                "{err:?}"
            );
            assert!(credentials.is_dir());
            assert!(preserved_credentials(tmp.path()).is_empty());
        }

        /// 当前账户原是凭据库里的账户：留存后没有当前账户，不擅自换成离线号。换了的话，下次点启动就用离线号
        /// 进了游戏，多人服务器进不去还不知道为什么；没有当前账户时启动会先让用户选。
        #[test]
        fn recovery_does_not_hand_the_selection_to_an_offline_account() {
            let tmp = tempfile::tempdir().unwrap();
            let aurora = aurora_at(tmp.path());
            let offline = aurora.add_offline_account("Alex", None).unwrap();
            aurora
                .store_login(Account::new(
                    MS_UUID,
                    "PetalPlayer",
                    AccountCredentials::Microsoft(MicrosoftCredentials {
                        refresh_token: "r".into(),
                        minecraft_token: None,
                        minecraft_expires_at: None,
                    }),
                ))
                .unwrap();
            assert_eq!(aurora.current_account().unwrap().unwrap().uuid, MS_UUID);
            std::fs::write(tmp.path().join(CREDENTIALS_FILE), b"moved from another PC").unwrap();

            assert!(aurora.current_account().unwrap().is_none());
            let listed: Vec<_> = aurora
                .accounts()
                .unwrap()
                .into_iter()
                .map(|a| a.uuid)
                .collect();
            assert_eq!(listed, [offline.uuid]);
        }

        /// 并发读改写不丢更新：多个线程同时往库里加不同账户，最后一个都不能少。
        /// 把账户库锁去掉，后写的整库覆盖会吞掉先写的那几条，本用例即挂。
        #[test]
        fn concurrent_logins_do_not_lose_each_other() {
            let tmp = tempfile::tempdir().unwrap();
            let aurora = aurora_at(tmp.path());
            std::thread::scope(|scope| {
                for i in 0..8u8 {
                    let aurora = aurora.clone();
                    scope.spawn(move || {
                        aurora
                            .store_login(Account::new(
                                format!("{i:032x}"),
                                format!("P{i}"),
                                AccountCredentials::Microsoft(MicrosoftCredentials {
                                    refresh_token: "r".into(),
                                    minecraft_token: None,
                                    minecraft_expires_at: None,
                                }),
                            ))
                            .unwrap();
                    });
                }
            });
            assert_eq!(aurora_at(tmp.path()).accounts().unwrap().len(), 8);
        }
    }
}
