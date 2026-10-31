use super::*;
use std::path::Path;

use aurora_core::{
    AccountCredentials, AuroraConfig, GameProfile, MicrosoftCredentials, YggdrasilCredentials,
};
use serde_json::json;

fn open_aurora(dir: &Path) -> Aurora {
    let config = AuroraConfig {
        msa_client_id: Some("test-client".into()),
        game_directory: Some(dir.join(".minecraft")),
        ..AuroraConfig::default()
    };
    Aurora::open(config, dir.to_path_buf(), dir.join("config.json")).unwrap()
}

#[test]
fn account_dto_maps_metadata_and_never_carries_tokens() {
    let mut account = Account::new(
        "0123456789abcdef0123456789abcdef",
        "Sakuya",
        AccountCredentials::AuthlibInjector(YggdrasilCredentials {
            api_root: "https://skin.example/api/yggdrasil/".into(),
            access_token: "SECRET-ACCESS".into(),
            client_token: "SECRET-CLIENT".into(),
        }),
    );
    account.added_at = 1_700_000_000_123;
    account.status = AccountStatus::Expired;
    account.last_verified_at = Some(1_700_000_500_000);
    account.auth_server = Some("Example Skin".into());
    account.xuid = Some("2535400000000000".into());

    let value = serde_json::to_value(account_dto(&account)).unwrap();
    assert_eq!(
        value,
        json!({
            "uuid": "0123456789abcdef0123456789abcdef",
            "name": "Sakuya",
            "account_type": "authlib_injector",
            "auth_server": "Example Skin",
            "added_at": 1_700_000_000_123_u64,
            "status": "expired",
            "last_verified_at": 1_700_000_500_000_u64
        })
    );
    let text = value.to_string();
    for secret in [
        "SECRET-ACCESS",
        "SECRET-CLIENT",
        "2535400000000000",
        "skin.example",
    ] {
        assert!(!text.contains(secret), "DTO 泄露了 {secret}");
    }

    let microsoft = Account::new(
        "fedcba9876543210fedcba9876543210",
        "Reimu",
        AccountCredentials::Microsoft(MicrosoftCredentials {
            refresh_token: "SECRET-REFRESH".into(),
            minecraft_token: Some("SECRET-MC".into()),
            minecraft_expires_at: Some(0),
        }),
    );
    let value = serde_json::to_value(account_dto(&microsoft)).unwrap();
    assert_eq!(value["account_type"], json!("microsoft"));
    assert_eq!(value["status"], json!("ok"));
    assert_eq!(value["auth_server"], json!(null));
    assert_eq!(value["last_verified_at"], json!(null));
    assert!(!value.to_string().contains("SECRET-"));
}

#[test]
fn authlib_select_profile_dto_shape() {
    let dto = AuthlibLoginDto::SelectProfile {
        pending_id: "authlib-3".into(),
        server_name: "Example Skin".into(),
        profiles: vec![AuthlibProfileDto {
            uuid: "aa".repeat(16),
            name: "Alice".into(),
            skin: None,
        }],
    };
    assert_eq!(
        serde_json::to_value(dto).unwrap(),
        json!({
            "status": "select_profile",
            "pending_id": "authlib-3",
            "server_name": "Example Skin",
            "profiles": [{ "uuid": "aa".repeat(16), "name": "Alice", "skin": null }]
        })
    );
}

#[test]
fn normalize_server_url_adds_scheme_and_rejects_garbage() {
    assert_eq!(
        normalize_server_url("  littleskin.cn ").unwrap(),
        "https://littleskin.cn/"
    );
    assert_eq!(
        normalize_server_url("http://127.0.0.1:8080/api/yggdrasil").unwrap(),
        "http://127.0.0.1:8080/api/yggdrasil"
    );
    for bad in [
        "",
        "   ",
        "ftp://example.com",
        "https://",
        "file:///C:/x",
        "http://exa mple.com",
    ] {
        let err = normalize_server_url(bad).expect_err(bad);
        assert_eq!(
            err.code,
            crate::commands::error::code::INVALID_ARGUMENT,
            "{bad}"
        );
    }
}

#[test]
fn microsoft_login_slot_supersedes_and_finishes_only_its_own_login() {
    let slot = MicrosoftLoginSlot::default();
    assert!(!slot.cancel(), "没有登录时取消应返回 false");

    let (first_id, first) = slot.begin();
    let (second_id, second) = slot.begin();
    assert!(first.is_cancelled(), "新的一次登录应取消旧的");
    assert!(!second.is_cancelled());

    // 旧登录收尾不能把新登录从槽里抹掉，否则之后的取消找不到它。
    slot.finish(first_id);
    assert!(slot.cancel());
    assert!(second.is_cancelled());

    slot.finish(second_id);
    assert!(!slot.cancel());
}

#[tokio::test]
async fn select_authlib_profile_rejects_stale_id_and_unknown_profile() {
    let dir = tempfile::tempdir().unwrap();
    let facade = Facade::new(open_aurora(dir.path()));
    let slot = AuthlibPendingSlot::default();

    let stale = select_authlib_profile_with(&facade, &slot, "authlib-0", "aa")
        .await
        .unwrap_err();
    assert_eq!(stale.code, crate::commands::error::code::INVALID_ARGUMENT);

    let pending = AuthlibPending {
        server: AuthServerInfo {
            api_root: "https://skin.example/api/yggdrasil/".into(),
            server_name: "Example Skin".into(),
            host: "skin.example".into(),
        },
        access_token: "AT".into(),
        client_token: "CT".into(),
        profiles: vec![
            GameProfile {
                id: "a".repeat(32),
                name: "Alice".into(),
            },
            GameProfile {
                id: "b".repeat(32),
                name: "Bob".into(),
            },
        ],
    };
    let first = slot.store(pending.clone());
    let second = slot.store(pending);
    assert_ne!(first, second);

    // 被更新的一次登录顶替后，旧 id 不能绑到新会话上。
    let superseded = select_authlib_profile_with(&facade, &slot, &first, &"a".repeat(32))
        .await
        .unwrap_err();
    assert_eq!(
        superseded.code,
        crate::commands::error::code::INVALID_ARGUMENT
    );

    let unknown = select_authlib_profile_with(&facade, &slot, &second, &"c".repeat(32))
        .await
        .unwrap_err();
    assert_eq!(unknown.code, crate::commands::error::code::INVALID_ARGUMENT);
    assert!(unknown.message.contains(&"c".repeat(32)));
    assert!(slot.get(&second).is_some(), "选错角色不应丢掉待选会话");
}

/// 启动链取账户走阻塞线程池：单线程运行时里也照样取得到，查不到报 AccountNotFound 并带上 uuid。
#[tokio::test(flavor = "current_thread")]
async fn find_account_reads_the_store_off_the_async_thread() {
    let dir = tempfile::tempdir().unwrap();
    let aurora = open_aurora(dir.path());
    let saved = aurora.add_offline_account("Marisa", None).unwrap();

    let found = find_account(&aurora, &saved.uuid).await.unwrap();
    assert_eq!(found.uuid, saved.uuid);
    assert_eq!(found.name, "Marisa");
    assert_eq!(found.account_type, AccountType::Offline);

    let missing = find_account(&aurora, "ffffffffffffffffffffffffffffffff")
        .await
        .unwrap_err();
    assert_eq!(missing.code, "AccountNotFound");
    assert!(missing.message.contains("ffffffffffffffffffffffffffffffff"));
}

/// 设备码登录要落 DPAPI 账户库，只在 Windows 上跑。
#[cfg(windows)]
mod microsoft {
    use super::*;
    use std::sync::Arc;
    use std::time::{Duration, Instant};

    use aurora_core::MsaEndpoints;
    use wiremock::matchers::{method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    /// 用户一直没去网页上授权：设备码立即给出，令牌端点永远回 authorization_pending。
    async fn pending_forever_server() -> MockServer {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/devicecode"))
            .respond_with(ResponseTemplate::new(200).set_body_string(
                r#"{"device_code":"DEV","user_code":"WXYZ-1234",
                    "verification_uri":"https://microsoft.com/link","expires_in":900,"interval":1,
                    "message":"输入 WXYZ-1234"}"#,
            ))
            .mount(&server)
            .await;
        Mock::given(method("POST"))
            .and(path("/token"))
            .respond_with(ResponseTemplate::new(400).set_body_string(
                r#"{"error":"authorization_pending","error_description":"waiting"}"#,
            ))
            .mount(&server)
            .await;
        server
    }

    fn facade_against(server: &MockServer, dir: &Path) -> Arc<Facade> {
        let aurora = open_aurora(dir).with_msa_endpoints(MsaEndpoints {
            oauth_base: server.uri(),
            xbl_authenticate: format!("{}/xbl", server.uri()),
            xsts_authorize: format!("{}/xsts", server.uri()),
            minecraft_base: server.uri(),
        });
        Arc::new(Facade::new(aurora))
    }

    type LoginHandle = tokio::task::JoinHandle<Result<AccountDto, CommandError>>;

    /// 发起一次登录并等到设备码出现，再让轮询进入「回 pending 后按间隔等待」的状态。
    async fn start_login(facade: &Arc<Facade>, slot: &Arc<MicrosoftLoginSlot>) -> LoginHandle {
        let (code_tx, code_rx) = tokio::sync::oneshot::channel();
        let login_facade = facade.clone();
        let login_slot = slot.clone();
        let login = tokio::spawn(async move {
            microsoft_login_with(&login_facade, &login_slot, move |device| {
                code_tx
                    .send(device.user_code.clone())
                    .expect("测试一直在等设备码");
            })
            .await
        });
        let user_code = tokio::time::timeout(Duration::from_secs(5), code_rx)
            .await
            .expect("5 s 内应拿到设备码")
            .unwrap();
        assert_eq!(user_code, "WXYZ-1234");
        tokio::time::sleep(Duration::from_millis(100)).await;
        assert!(!login.is_finished(), "此刻应仍在轮询");
        login
    }

    /// 设备码轮询期间门面不被占用：读命令 50 ms 内返回，写锁也能立即拿到。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn device_code_polling_does_not_hold_the_facade() {
        let server = pending_forever_server().await;
        let dir = tempfile::tempdir().unwrap();
        let facade = facade_against(&server, dir.path());
        let slot = Arc::new(MicrosoftLoginSlot::default());
        let login = start_login(&facade, &slot).await;

        let started = Instant::now();
        let config = crate::commands::config::read_config(&facade).await;
        let elapsed = started.elapsed();
        assert!(
            elapsed < Duration::from_millis(50),
            "读命令耗时 {elapsed:?}"
        );
        assert!(config.has_client_id);
        assert!(facade.is_unlocked(), "轮询期间不应有人持有门面锁");

        assert!(slot.cancel());
        let outcome = login.await.unwrap();
        assert_eq!(outcome.unwrap_err().code, "cancelled");
    }

    /// 取消后 1000 ms 内 microsoft_login 以 cancelled 返回，且什么都没落库。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn cancel_rejects_login_with_cancelled_within_one_second() {
        let server = pending_forever_server().await;
        let dir = tempfile::tempdir().unwrap();
        let facade = facade_against(&server, dir.path());
        let slot = Arc::new(MicrosoftLoginSlot::default());
        let login = start_login(&facade, &slot).await;

        let started = Instant::now();
        assert!(slot.cancel(), "登录进行中，取消应返回 true");
        let outcome = tokio::time::timeout(Duration::from_millis(1000), login)
            .await
            .expect("取消后 1000 ms 内登录应结束")
            .unwrap();
        let elapsed = started.elapsed();
        let err = outcome.unwrap_err();
        assert_eq!(err.code, "cancelled", "实际错误：{err:?}");
        assert!(
            elapsed < Duration::from_millis(1000),
            "取消耗时 {elapsed:?}"
        );

        assert!(!slot.cancel(), "登录结束后槽应已清空");
        let accounts = facade.snapshot().await.accounts().unwrap();
        assert!(accounts.is_empty(), "取消的登录不应落库：{accounts:?}");
    }

    /// 「重新获取代码」：新的一次登录让上一次以 cancelled 结束，新的一次照常轮询。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn new_login_supersedes_previous_one() {
        let server = pending_forever_server().await;
        let dir = tempfile::tempdir().unwrap();
        let facade = facade_against(&server, dir.path());
        let slot = Arc::new(MicrosoftLoginSlot::default());

        let first = start_login(&facade, &slot).await;
        let second = start_login(&facade, &slot).await;
        let first_outcome = tokio::time::timeout(Duration::from_millis(1000), first)
            .await
            .expect("被顶替的登录应在 1000 ms 内结束")
            .unwrap();
        assert_eq!(first_outcome.unwrap_err().code, "cancelled");
        assert!(!second.is_finished(), "新的一次不应被旧的收尾波及");

        assert!(slot.cancel());
        assert_eq!(second.await.unwrap().unwrap_err().code, "cancelled");
    }
}
