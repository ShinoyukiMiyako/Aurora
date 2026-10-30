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
//! 所有读写再经进程内一把锁串行，两次读改写不会交错丢更新。

use std::sync::{Mutex, MutexGuard, PoisonError};
use std::time::Duration;

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

    /// 装配微软登录客户端；门面快照挂了取消令牌时客户端也挂上。
    fn microsoft_auth(&self) -> MicrosoftAuth {
        let auth = MicrosoftAuth::new(self.http(), self.msa_client_id())
            .with_endpoints(self.msa_endpoints().clone());
        match self.cancel_token() {
            Some(token) => auth.with_cancel(token.clone()),
            None => auth,
        }
    }

    fn yggdrasil(&self, api_root: &str) -> YggdrasilClient {
        YggdrasilClient::new(self.http(), api_root)
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
        access_token: String,
        client_token: String,
        profile: GameProfile,
    ) -> Result<Account> {
        let skin = profile_skin_or_warn(client, &profile.id).await;
        let account = authlib_account(server, access_token, client_token, profile, skin);
        self.blocking(move |aurora| aurora.store_login(account))
            .await
    }

    /// 刷新账户信息：微软重走令牌链、外置刷新令牌，顺带更新名字与皮肤，返回更新后的记录。
    ///
    /// 服务器判定凭据失效（微软 `invalid_grant`、外置令牌被拒）时把账户落成「需要重新登录」并报
    /// [`AuthError::ReloginRequired`]；网络故障原样冒泡、状态不变。离线账户没有可刷新的凭据，原样返回。
    pub async fn refresh_account(&self, uuid: &str) -> Result<Account> {
        let lookup = uuid.to_owned();
        let account = self
            .blocking(move |aurora| aurora.find_account(&lookup))
            .await?
            .ok_or_else(|| AuthError::AccountNotFound(uuid.to_owned()))?;
        match &account.credentials {
            AccountCredentials::Microsoft(creds) => {
                self.refresh_microsoft(&account, &creds.refresh_token).await
            }
            AccountCredentials::AuthlibInjector(creds) => {
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
    pub async fn ensure_account_fresh(&self, account: &Account) -> Result<Account> {
        match &account.credentials {
            AccountCredentials::Microsoft(creds) => {
                if creds.minecraft_token_valid_at(unix_millis() / 1000) {
                    return Ok(account.clone());
                }
                self.refresh_microsoft(account, &creds.refresh_token).await
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
                self.refresh_authlib(account, creds).await
            }
            AccountCredentials::Offline => Ok(account.clone()),
        }
    }

    async fn refresh_microsoft(&self, account: &Account, refresh_token: &str) -> Result<Account> {
        match self.microsoft_auth().refresh_session(refresh_token).await {
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
            Err(AuthError::ReloginRequired) => self.expire(&account.uuid).await,
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
            Err(err) if is_rejected_token(&err) => return self.expire(&account.uuid).await,
            Err(err) => return Err(err.into()),
        };
        let skin = profile_skin_or_warn(&client, &account.uuid).await;
        let name = resp.selected_profile.map(|p| p.name);
        let uuid = account.uuid.clone();
        let api_root = creds.api_root.clone();
        self.blocking(move |aurora| {
            aurora.update_credential_account(&uuid, |stored| {
                stored.credentials = AccountCredentials::AuthlibInjector(YggdrasilCredentials {
                    api_root,
                    access_token: resp.access_token,
                    client_token: resp.client_token,
                });
                if let Some(name) = name {
                    stored.name = name;
                }
                stored.skin = skin;
                stored.status = AccountStatus::Ok;
                stored.last_verified_at = Some(unix_millis());
            })
        })
        .await
    }

    /// 把账户落成「需要重新登录」，然后报 [`AuthError::ReloginRequired`]。
    async fn expire(&self, uuid: &str) -> Result<Account> {
        let target = uuid.to_owned();
        let expired = self
            .blocking(move |aurora| {
                aurora.update_credential_account(&target, |stored| {
                    stored.status = AccountStatus::Expired;
                })
            })
            .await?;
        tracing::warn!(uuid = %expired.uuid, name = %expired.name, "账户凭据已被服务器判定失效，标记为需要重新登录");
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

    fn open_credentials(&self) -> Result<AccountManager<aurora_auth::DpapiCredentialStore>> {
        let store = aurora_auth::DpapiCredentialStore::at(self.data_dir().join(CREDENTIALS_FILE));
        Ok(AccountManager::load(store)?)
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
                AccountCredentials::AuthlibInjector(c) => assert_eq!(c.access_token, "bound-acc"),
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
