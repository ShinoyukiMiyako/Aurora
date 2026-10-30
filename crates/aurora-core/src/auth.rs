//! 账户操作：离线账户创建、微软设备码登录与多账户读取。
//!
//! 微软登录的编排（设备码 -> 轮询 -> 令牌链 -> 落库）抽成与平台无关的 [`perform_microsoft_login`]，
//! 便于用注入端点的 [`MicrosoftAuth`] 与任意 [`CredentialStore`] 做 mock 测试。凭据的加密落盘只有
//! Windows（DPAPI）实现，故门面上「读写账户库」的方法用 `#[cfg(windows)]` 圈起；离线账户创建不依赖
//! 凭据库，跨平台可用。

use aurora_auth::{
    Account, AccountCredentials, AccountManager, AuthError, CredentialStore, DeviceCodeResponse,
    GameProfile, MicrosoftAuth, MicrosoftCredentials, MicrosoftSession, UsernameCheck,
    YggdrasilClient, YggdrasilCredentials, offline_account, validate_username,
};

use crate::error::Result;
use crate::event::{CoreEvent, EventSink, emit};
use crate::facade::Aurora;

/// 环境变量名：微软登录 client_id 的回落来源。
pub const MSA_CLIENT_ID_ENV: &str = "AURORA_MSA_CLIENT_ID";

/// 内置默认微软登录 client_id：Aurora 自有的 Azure AD 公共客户端应用（受支持账户类型＝个人 Microsoft 账户）。
///
/// 注意两点：1) 该应用须在 Azure「身份验证」里开启「允许公共客户端流」，设备码流才成立；
/// 2) 走完设备码/XBL/XSTS 后，若最终 `login_with_xbox` 换 Minecraft 令牌那步返 403，说明该应用尚未通过
/// aka.ms/mce-reviewappid 的 Mojang 审批（审批通过后此步即放行）。
/// 旧的 login.live 调试 id `00000000402B5328` 不适用本项目的 Azure AD v2 端点（报 AADSTS700016），已弃用。
/// 用户在 config.json 填 msa_client_id 或设环境变量 AURORA_MSA_CLIENT_ID 均可覆盖此默认。
pub const DEFAULT_MSA_CLIENT_ID: &str = "bf8c139d-45e9-48c0-b469-175e8234e516";

/// 走完微软设备码登录全链并把结果账户写入账户库。
///
/// 流程：请求设备码 -> `on_code` 回调（供 UI 展示 user_code 与验证网址）-> 轮询令牌 -> XBL/XSTS/
/// Minecraft/profile -> 组装账户 -> upsert 落库。返回落库后的账户。
pub async fn perform_microsoft_login<S: CredentialStore>(
    auth: &MicrosoftAuth,
    manager: &mut AccountManager<S>,
    on_code: impl FnOnce(&DeviceCodeResponse),
) -> Result<Account> {
    let device = auth.begin_device_code().await?;
    on_code(&device);
    let token = auth.poll_device_code(&device).await?;
    let session = auth.complete_login(&token).await?;
    let account = account_from_session(&session);
    manager.upsert(account.clone())?;
    Ok(account)
}

/// 用持久化的 refresh_token 静默续期微软账户：重跑 MSA 刷新 -> XBL/XSTS/Minecraft/profile 换新令牌，
/// 按 uuid upsert 回写账户库（轮换后的 refresh_token 与新 Minecraft 令牌一并落盘），返回续好的账户。
///
/// 不含「是否需要续期」的判断——由调用方（[`Aurora::ensure_microsoft_fresh`]）先查缓存有效期再决定是否调用。
pub async fn perform_microsoft_refresh<S: CredentialStore>(
    auth: &MicrosoftAuth,
    manager: &mut AccountManager<S>,
    refresh_token: &str,
) -> Result<Account> {
    let session = auth.refresh_session(refresh_token).await?;
    let account = account_from_session(&session);
    manager.upsert(account.clone())?;
    Ok(account)
}

/// 把一次微软会话摊平成可持久化的账户记录（缓存 Minecraft 令牌与到期时间，供下次免握手启动）。
fn account_from_session(session: &MicrosoftSession) -> Account {
    Account::new(
        session.profile.id.clone(),
        session.profile.name.clone(),
        AccountCredentials::Microsoft(MicrosoftCredentials {
            refresh_token: session.refresh_token.clone(),
            minecraft_token: Some(session.minecraft_token.clone()),
            minecraft_expires_at: Some(session.minecraft_expires_at),
        }),
    )
}

/// 走完 Authlib-Injector（Yggdrasil）用户名密码登录并把结果账户写入账户库。
///
/// 流程：`authenticate` -> 选定角色 -> 组装账户 -> upsert 落库。返回落库后的账户。
/// `api_root`（已由 [`resolve_api_root`](aurora_auth::yggdrasil::resolve_api_root) 解析）连同已
/// 构造的 `client` 一并传入，既复用同一 HTTP 客户端，也便于用 mock 认证端点做落库测试。
pub async fn perform_authlib_login<S: CredentialStore>(
    client: &YggdrasilClient,
    api_root: &str,
    manager: &mut AccountManager<S>,
    username: &str,
    password: &str,
) -> Result<Account> {
    let resp = client.authenticate(username, password, None).await?;
    let profile = select_profile(resp.available_profiles, resp.selected_profile)?;
    // api_root 单独持有：YggdrasilClient 内部的根地址不对外暴露，凭据需自带以供刷新/校验复用。
    let account = Account::new(
        profile.id,
        profile.name,
        AccountCredentials::AuthlibInjector(YggdrasilCredentials {
            api_root: api_root.to_owned(),
            access_token: resp.access_token,
            client_token: resp.client_token,
        }),
    );
    manager.upsert(account.clone())?;
    Ok(account)
}

/// 选定登录角色：优先服务端已选中角色，否则取可用角色列表首个。
///
/// 多角色账号的交互式选择（列出全部角色供用户点选）留待后续 UI；当前按「首个可用」自动定角色。
/// 账户下无任何角色时认证虽成功却无从组装档案，按协议不符冒泡为 [`AuthError::Response`]。
fn select_profile(
    available: Vec<GameProfile>,
    selected: Option<GameProfile>,
) -> Result<GameProfile> {
    selected
        .or_else(|| available.into_iter().next())
        .ok_or_else(|| {
            AuthError::Response {
                context: "Yggdrasil 认证",
                detail: "认证成功但账户下无可用角色，请先在验证服务器创建游戏角色".into(),
            }
            .into()
        })
}

impl Aurora {
    /// 解析微软登录 client_id：优先配置，其次环境变量，最后回落到内置默认（[`DEFAULT_MSA_CLIENT_ID`]），
    /// 保证正版登录开箱可用。返回 Result 仅为与调用点的 `?` 保持一致，实际恒为 Ok。
    pub(crate) fn msa_client_id(&self) -> Result<String> {
        Ok(self
            .config()
            .msa_client_id
            .clone()
            .or_else(|| {
                std::env::var(MSA_CLIENT_ID_ENV)
                    .ok()
                    .filter(|s| !s.is_empty())
            })
            .unwrap_or_else(|| DEFAULT_MSA_CLIENT_ID.to_owned()))
    }

    /// 创建一个离线账户（不落库，供离线启动即用即弃）。
    ///
    /// 用户名先过硬性校验（空/引号/超长直接报错），软性告警（含非标准字符）经事件通道上抛。
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
}

#[cfg(windows)]
impl Aurora {
    /// 打开当前数据目录下的加密账户库（DPAPI）。
    fn open_accounts(&self) -> Result<AccountManager<aurora_auth::DpapiCredentialStore>> {
        let store = aurora_auth::DpapiCredentialStore::at(self.data_dir().join("credentials.bin"));
        Ok(AccountManager::load(store)?)
    }

    /// 走微软设备码登录并把账户写入加密账户库，返回登录到的账户。
    pub async fn microsoft_login(
        &self,
        on_code: impl FnOnce(&DeviceCodeResponse),
    ) -> Result<Account> {
        let client_id = self.msa_client_id()?;
        let auth =
            MicrosoftAuth::new(self.http(), client_id).with_endpoints(self.msa_endpoints().clone());
        let mut manager = self.open_accounts()?;
        perform_microsoft_login(&auth, &mut manager, on_code).await
    }

    /// 确保要启动的微软账户持有有效 Minecraft 令牌：缓存令牌在当前时刻仍有效则原样返回（不联网、不开库）；
    /// 已过期或缺失则用 refresh_token 静默续期并回写账户库，返回续好的账户。非微软账户原样返回。
    ///
    /// refresh_token 也失效（满 90 天 / 被吊销）时，续期冒泡 [`aurora_auth::AuthError`]，由上层提示重新登录。
    pub async fn ensure_microsoft_fresh(&self, account: &Account) -> Result<Account> {
        let AccountCredentials::Microsoft(creds) = &account.credentials else {
            return Ok(account.clone());
        };
        // 现实时刻若早于 1970（时钟异常）取 0，令缓存判定为过期而走续期——宁可多刷新，不拿废令牌启动。
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        if creds.minecraft_token_valid_at(now) {
            return Ok(account.clone());
        }
        let client_id = self.msa_client_id()?;
        let auth =
            MicrosoftAuth::new(self.http(), client_id).with_endpoints(self.msa_endpoints().clone());
        let mut manager = self.open_accounts()?;
        perform_microsoft_refresh(&auth, &mut manager, &creds.refresh_token).await
    }

    /// 走 Authlib-Injector 用户名密码登录并把账户写入加密账户库，返回登录到的账户。
    ///
    /// `server_url` 为用户填写的第三方验证服务器地址：先经 `resolve_api_root` 解析出真正的 API
    /// 根地址（跟随重定向与 `X-Authlib-Injector-API-Location` 头），再据此构造 Yggdrasil 客户端
    /// 完成认证与落库。解析出的根地址随凭据一并存储，供后续刷新/校验与 javaagent 拼装复用。
    pub async fn authlib_login(
        &self,
        server_url: &str,
        username: &str,
        password: &str,
    ) -> Result<Account> {
        let api_root = aurora_auth::yggdrasil::resolve_api_root(&self.http(), server_url).await?;
        let client = YggdrasilClient::new(self.http(), &api_root);
        let mut manager = self.open_accounts()?;
        perform_authlib_login(&client, &api_root, &mut manager, username, password).await
    }

    /// 读取账户库中的全部账户。
    pub fn accounts(&self) -> Result<Vec<Account>> {
        Ok(self.open_accounts()?.accounts().to_vec())
    }

    /// 读取当前选中账户（若有）。
    pub fn current_account(&self) -> Result<Option<Account>> {
        Ok(self.open_accounts()?.current().cloned())
    }

    /// 切换当前账户。
    pub fn set_current_account(&self, uuid: &str) -> Result<()> {
        let mut manager = self.open_accounts()?;
        manager.set_current(uuid)?;
        Ok(())
    }

    /// 删除账户。
    pub fn remove_account(&self, uuid: &str) -> Result<()> {
        let mut manager = self.open_accounts()?;
        manager.remove(uuid)?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::error::CoreError;
    use aurora_auth::Result as AuthResult;
    use std::sync::{Arc, Mutex};
    use wiremock::matchers::{method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    /// 测试用不加密内存凭据库：验证登录编排的落库效果。
    #[derive(Default, Clone)]
    struct MemStore {
        bytes: Arc<Mutex<Option<Vec<u8>>>>,
    }

    impl CredentialStore for MemStore {
        fn load(&self) -> AuthResult<Option<Vec<u8>>> {
            Ok(self.bytes.lock().unwrap().clone())
        }
        fn save(&self, plaintext: &[u8]) -> AuthResult<()> {
            *self.bytes.lock().unwrap() = Some(plaintext.to_vec());
            Ok(())
        }
    }

    fn no_retry() -> aurora_base::retry::RetryPolicy {
        aurora_base::retry::RetryPolicy {
            max_attempts: 1,
            initial_delay: std::time::Duration::from_millis(1),
            max_delay: std::time::Duration::from_millis(1),
            multiplier: 1.0,
            jitter: false,
        }
    }

    fn auth_for(server: &MockServer) -> MicrosoftAuth {
        let client = aurora_base::http::build_client().unwrap();
        let endpoints = aurora_auth::MsaEndpoints {
            oauth_base: server.uri(),
            xbl_authenticate: format!("{}/xbl", server.uri()),
            xsts_authorize: format!("{}/xsts", server.uri()),
            minecraft_base: server.uri(),
        };
        MicrosoftAuth::new(client, "test-client-id")
            .with_endpoints(endpoints)
            .with_retry(no_retry())
    }

    async fn mount_full_login(server: &MockServer) {
        Mock::given(method("POST"))
            .and(path("/devicecode"))
            .respond_with(ResponseTemplate::new(200).set_body_string(
                r#"{"device_code":"DEV","user_code":"WXYZ-9999",
                    "verification_uri":"https://microsoft.com/link","expires_in":900,"interval":0,
                    "message":"输入 WXYZ-9999"}"#,
            ))
            .mount(server)
            .await;
        Mock::given(method("POST"))
            .and(path("/token"))
            .respond_with(ResponseTemplate::new(200).set_body_string(
                r#"{"access_token":"AT","refresh_token":"rotated-refresh","expires_in":3600}"#,
            ))
            .mount(server)
            .await;
        Mock::given(method("POST"))
            .and(path("/xbl"))
            .respond_with(ResponseTemplate::new(200).set_body_string(
                r#"{"Token":"xbl","DisplayClaims":{"xui":[{"uhs":"theuhs"}]}}"#,
            ))
            .mount(server)
            .await;
        Mock::given(method("POST"))
            .and(path("/xsts"))
            .respond_with(ResponseTemplate::new(200).set_body_string(
                r#"{"Token":"xsts","DisplayClaims":{"xui":[{"uhs":"theuhs"}]}}"#,
            ))
            .mount(server)
            .await;
        Mock::given(method("POST"))
            .and(path("/authentication/login_with_xbox"))
            .respond_with(ResponseTemplate::new(200).set_body_string(
                r#"{"access_token":"MC-TOKEN","expires_in":86400}"#,
            ))
            .mount(server)
            .await;
        Mock::given(method("GET"))
            .and(path("/minecraft/profile"))
            .respond_with(ResponseTemplate::new(200).set_body_string(
                r#"{"id":"0123456789abcdef0123456789abcdef","name":"AuroraPlayer"}"#,
            ))
            .mount(server)
            .await;
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn microsoft_login_persists_account_and_caches_token() {
        let server = MockServer::start().await;
        mount_full_login(&server).await;

        let store = MemStore::default();
        let mut manager = AccountManager::load(store.clone()).unwrap();
        let auth = auth_for(&server);

        let mut shown = None;
        let account = perform_microsoft_login(&auth, &mut manager, |dc| {
            shown = Some(dc.user_code.clone());
        })
        .await
        .unwrap();

        // 回调拿到了 user_code。
        assert_eq!(shown.as_deref(), Some("WXYZ-9999"));
        // 账户字段正确。
        assert_eq!(account.uuid, "0123456789abcdef0123456789abcdef");
        assert_eq!(account.name, "AuroraPlayer");
        match &account.credentials {
            AccountCredentials::Microsoft(c) => {
                assert_eq!(c.refresh_token, "rotated-refresh");
                assert_eq!(c.minecraft_token.as_deref(), Some("MC-TOKEN"));
                assert!(c.minecraft_expires_at.unwrap() > 0);
            }
            other => panic!("期望 Microsoft 凭据，得到 {other:?}"),
        }

        // 从同一份底层字节重载，账户与「当前」应还原。
        let reloaded = AccountManager::load(store).unwrap();
        assert_eq!(reloaded.accounts().len(), 1);
        assert_eq!(
            reloaded.current().unwrap().uuid,
            "0123456789abcdef0123456789abcdef"
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn microsoft_refresh_swaps_token_and_persists() {
        let server = MockServer::start().await;
        mount_full_login(&server).await; // 复用全链 mock；刷新走 /token(refresh) -> xbl/xsts/mc/profile

        let store = MemStore::default();
        let mut manager = AccountManager::load(store.clone()).unwrap();
        // 先塞一个同 uuid 的旧账户，Minecraft 令牌已过期（到期时刻=1）。
        manager
            .upsert(Account::new(
                "0123456789abcdef0123456789abcdef",
                "OldName",
                AccountCredentials::Microsoft(MicrosoftCredentials {
                    refresh_token: "old-refresh".into(),
                    minecraft_token: Some("OLD-MC".into()),
                    minecraft_expires_at: Some(1),
                }),
            ))
            .unwrap();
        let auth = auth_for(&server);

        let refreshed = perform_microsoft_refresh(&auth, &mut manager, "old-refresh")
            .await
            .unwrap();

        // 换到新 Minecraft 令牌与轮换后的 refresh_token；到期时刻推到未来。
        match &refreshed.credentials {
            AccountCredentials::Microsoft(c) => {
                assert_eq!(c.refresh_token, "rotated-refresh");
                assert_eq!(c.minecraft_token.as_deref(), Some("MC-TOKEN"));
                assert!(c.minecraft_expires_at.unwrap() > 1);
            }
            other => panic!("期望 Microsoft 凭据，得到 {other:?}"),
        }
        // 同 uuid 原地替换，未新增账户；重载后新令牌确已落盘（删掉 upsert 的落盘即挂）。
        assert_eq!(manager.accounts().len(), 1);
        let reloaded = AccountManager::load(store).unwrap();
        match &reloaded
            .find("0123456789abcdef0123456789abcdef")
            .unwrap()
            .credentials
        {
            AccountCredentials::Microsoft(c) => {
                assert_eq!(c.refresh_token, "rotated-refresh");
                assert_eq!(c.minecraft_token.as_deref(), Some("MC-TOKEN"));
            }
            other => panic!("期望 Microsoft 凭据，得到 {other:?}"),
        }
    }

    /// 构造指向 mock 服务器、关闭重试的 Yggdrasil 客户端。
    fn yggdrasil_client_for(api_root: &str) -> YggdrasilClient {
        let client = aurora_base::http::build_client().unwrap();
        YggdrasilClient::new(client, api_root).with_retry(no_retry())
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn authlib_login_persists_authlib_account() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/authserver/authenticate"))
            .respond_with(ResponseTemplate::new(200).set_body_string(
                r#"{"accessToken":"acc-tok","clientToken":"cli-tok",
                    "availableProfiles":[{"id":"aaaa1111aaaa1111aaaa1111aaaa1111","name":"Hero"}],
                    "selectedProfile":{"id":"aaaa1111aaaa1111aaaa1111aaaa1111","name":"Hero"}}"#,
            ))
            .mount(&server)
            .await;

        let api_root = format!("{}/", server.uri());
        let client = yggdrasil_client_for(&api_root);
        let store = MemStore::default();
        let mut manager = AccountManager::load(store.clone()).unwrap();

        let account =
            perform_authlib_login(&client, &api_root, &mut manager, "user@example.com", "pw")
                .await
                .unwrap();

        assert_eq!(account.uuid, "aaaa1111aaaa1111aaaa1111aaaa1111");
        assert_eq!(account.name, "Hero");
        assert_eq!(
            account.account_type,
            aurora_auth::AccountType::AuthlibInjector
        );
        match &account.credentials {
            AccountCredentials::AuthlibInjector(c) => {
                assert_eq!(c.api_root, api_root);
                assert_eq!(c.access_token, "acc-tok");
                assert_eq!(c.client_token, "cli-tok");
            }
            other => panic!("期望 AuthlibInjector 凭据，得到 {other:?}"),
        }

        // 从同一份底层字节重载，账户与「当前」应还原（首个账户自动成为当前）。
        let reloaded = AccountManager::load(store).unwrap();
        assert_eq!(reloaded.accounts().len(), 1);
        assert_eq!(
            reloaded.current().unwrap().uuid,
            "aaaa1111aaaa1111aaaa1111aaaa1111"
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn authlib_login_falls_back_to_first_available_profile() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/authserver/authenticate"))
            .respond_with(ResponseTemplate::new(200).set_body_string(
                r#"{"accessToken":"acc","clientToken":"cli",
                    "availableProfiles":[
                        {"id":"1111111111111111aaaaaaaaaaaaaaaa","name":"First"},
                        {"id":"2222222222222222bbbbbbbbbbbbbbbb","name":"Second"}],
                    "selectedProfile":null}"#,
            ))
            .mount(&server)
            .await;

        let api_root = format!("{}/", server.uri());
        let client = yggdrasil_client_for(&api_root);
        let mut manager = AccountManager::load(MemStore::default()).unwrap();

        let account = perform_authlib_login(&client, &api_root, &mut manager, "u", "p")
            .await
            .unwrap();

        // 无选中角色时定为第一个可用角色。
        assert_eq!(account.uuid, "1111111111111111aaaaaaaaaaaaaaaa");
        assert_eq!(account.name, "First");
    }

    #[test]
    fn select_profile_prefers_selected_over_available() {
        let available = vec![GameProfile {
            id: "aaaa".into(),
            name: "Available".into(),
        }];
        let selected = GameProfile {
            id: "zzzz".into(),
            name: "Selected".into(),
        };
        let chosen = select_profile(available, Some(selected)).unwrap();
        assert_eq!(chosen.id, "zzzz");
        assert_eq!(chosen.name, "Selected");
    }

    #[test]
    fn select_profile_errors_when_account_has_no_profile() {
        let err = select_profile(Vec::new(), None).unwrap_err();
        assert!(matches!(
            err,
            CoreError::Auth(AuthError::Response { context, .. }) if context == "Yggdrasil 认证"
        ));
    }

    #[test]
    fn offline_account_creation_validates_and_yields_stable_uuid() {
        let tmp = tempfile::tempdir().unwrap();
        let aurora = Aurora::for_test(
            crate::config::AuroraConfig::default(),
            tmp.path().to_path_buf(),
            tmp.path().to_path_buf(),
        );

        // 合法用户名 -> 稳定离线 UUID（与原版一致）。
        let account = aurora.create_offline_account("Steve", None).unwrap();
        assert_eq!(account.uuid, "5627dd98e6be3c21b8a8e92344183641");
        assert_eq!(account.account_type, aurora_auth::AccountType::Offline);

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
    fn client_id_falls_back_to_builtin_default() {
        let tmp = tempfile::tempdir().unwrap();
        let config = crate::config::AuroraConfig {
            msa_client_id: None,
            ..crate::config::AuroraConfig::default()
        };
        let aurora = Aurora::for_test(config, tmp.path().to_path_buf(), tmp.path().to_path_buf());
        // 未配置且无环境变量时回落到内置调试 client_id，保证正版登录开箱可用；删掉回落此断言即挂。
        if std::env::var(MSA_CLIENT_ID_ENV).is_err() {
            assert_eq!(aurora.msa_client_id().unwrap(), DEFAULT_MSA_CLIENT_ID);
        }
    }
}
