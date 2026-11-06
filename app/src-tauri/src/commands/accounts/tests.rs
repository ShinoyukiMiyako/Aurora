use super::*;
use std::path::Path;

use petalfall_core::{
    AccountCredentials, GameProfile, MicrosoftCredentials, PetalfallConfig, YggdrasilCredentials,
};
use serde_json::json;

fn open_petalfall(dir: &Path) -> Petalfall {
    let config = PetalfallConfig {
        msa_client_id: Some("test-client".into()),
        game_directory: Some(dir.join(".minecraft")),
        ..PetalfallConfig::default()
    };
    Petalfall::open(config, dir.to_path_buf(), dir.join("config.json")).unwrap()
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
            username: Some("sakuya@example.com".into()),
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
            "server_url": "https://skin.example/api/yggdrasil/",
            "username": "sakuya@example.com",
            "added_at": 1_700_000_000_123_u64,
            "status": "expired",
            "last_verified_at": 1_700_000_500_000_u64
        })
    );
    let text = value.to_string();
    for secret in ["SECRET-ACCESS", "SECRET-CLIENT", "2535400000000000"] {
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
    assert_eq!(value["server_url"], json!(null));
    assert_eq!(value["username"], json!(null));
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
    let facade = Facade::new(open_petalfall(dir.path()));
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
        username: "alice@example.com".into(),
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
    let petalfall = open_petalfall(dir.path());
    let saved = petalfall.add_offline_account("Marisa", None).unwrap();

    let found = find_account(&petalfall, &saved.uuid).await.unwrap();
    assert_eq!(found.uuid, saved.uuid);
    assert_eq!(found.name, "Marisa");
    assert_eq!(found.account_type, AccountType::Offline);

    let missing = find_account(&petalfall, "ffffffffffffffffffffffffffffffff")
        .await
        .unwrap_err();
    assert_eq!(missing.code, "AccountNotFound");
    assert!(missing.message.contains("ffffffffffffffffffffffffffffffff"));
}

/// 改配置的写者拿着门面写锁卡在落盘上时退出：关闸等轮换不经门面锁，照样立即返回，不跟着挂住。
/// 改回从门面快照上关闸，这里要等到写锁放开才返回。
#[tokio::test]
async fn exit_stops_rotations_while_the_facade_stays_locked() {
    let dir = tempfile::tempdir().unwrap();
    let facade = Facade::new(open_petalfall(dir.path()));
    let _writer = facade.hold_write_lock().await;

    let settled = tokio::time::timeout(
        Duration::from_secs(5),
        stop_rotations(&facade, Duration::from_secs(10)),
    )
    .await
    .expect("门面被占着时退出收尾挂住了");
    assert_eq!(settled, SettledRotations::Idle);
}

/// 设备码登录要落 DPAPI 账户库，只在 Windows 上跑。
#[cfg(windows)]
mod microsoft {
    use super::*;
    use std::sync::Arc;
    use std::time::Duration;

    use petalfall_core::MsaEndpoints;
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
        let petalfall = open_petalfall(dir).with_msa_endpoints(MsaEndpoints {
            oauth_base: server.uri(),
            xbl_authenticate: format!("{}/xbl", server.uri()),
            xsts_authorize: format!("{}/xsts", server.uri()),
            minecraft_base: server.uri(),
        });
        Arc::new(Facade::new(petalfall))
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

    /// 设备码轮询期间门面不被占用：读命令不用排队，写锁也能立即拿到。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn device_code_polling_does_not_hold_the_facade() {
        let server = pending_forever_server().await;
        let dir = tempfile::tempdir().unwrap();
        let facade = facade_against(&server, dir.path());
        let slot = Arc::new(MicrosoftLoginSlot::default());
        let login = start_login(&facade, &slot).await;

        // 服务端一直不给结果，轮询要是占着门面，读命令就等不到头。
        let config = tokio::time::timeout(
            Duration::from_secs(15),
            crate::commands::config::read_config(&facade),
        )
        .await
        .expect("轮询期间读命令被门面锁挡住了");
        assert!(config.has_client_id);
        assert!(facade.is_unlocked(), "轮询期间不应有人持有门面锁");

        assert!(slot.cancel());
        let outcome = login.await.unwrap();
        assert_eq!(outcome.unwrap_err().code, "cancelled");
    }

    /// 取消后 microsoft_login 以 cancelled 返回，且什么都没落库。服务端一直不给结果，只有取消能让登录结束。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn cancel_rejects_login_with_cancelled() {
        let server = pending_forever_server().await;
        let dir = tempfile::tempdir().unwrap();
        let facade = facade_against(&server, dir.path());
        let slot = Arc::new(MicrosoftLoginSlot::default());
        let login = start_login(&facade, &slot).await;

        assert!(slot.cancel(), "登录进行中，取消应返回 true");
        let outcome = tokio::time::timeout(Duration::from_secs(15), login)
            .await
            .expect("取消后登录应结束")
            .unwrap();
        let err = outcome.unwrap_err();
        assert_eq!(err.code, "cancelled", "实际错误：{err:?}");

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
        let first_outcome = tokio::time::timeout(Duration::from_secs(15), first)
            .await
            .expect("被顶替的登录应结束")
            .unwrap();
        assert_eq!(first_outcome.unwrap_err().code, "cancelled");
        assert!(!second.is_finished(), "新的一次不应被旧的收尾波及");

        assert!(slot.cancel());
        assert_eq!(second.await.unwrap().unwrap_err().code, "cancelled");
    }

    /// 设备码登录全链，Minecraft 令牌只有 60 秒：落库后马上就在提前续期的提前量里。
    async fn mount_short_lived_login(server: &MockServer) {
        Mock::given(method("POST"))
            .and(path("/devicecode"))
            .respond_with(ResponseTemplate::new(200).set_body_string(
                r#"{"device_code":"DEV","user_code":"WXYZ-1234",
                    "verification_uri":"https://microsoft.com/link","expires_in":900,"interval":1,
                    "message":"输入 WXYZ-1234"}"#,
            ))
            .mount(server)
            .await;
        Mock::given(method("POST"))
            .and(path("/token"))
            .respond_with(ResponseTemplate::new(200).set_body_string(
                r#"{"access_token":"AT","refresh_token":"rotated","expires_in":3600}"#,
            ))
            .mount(server)
            .await;
        for route in ["/xbl", "/xsts"] {
            Mock::given(method("POST"))
                .and(path(route))
                .respond_with(
                    ResponseTemplate::new(200).set_body_string(
                        r#"{"Token":"xbox","DisplayClaims":{"xui":[{"uhs":"uhs"}]}}"#,
                    ),
                )
                .mount(server)
                .await;
        }
        Mock::given(method("POST"))
            .and(path("/authentication/login_with_xbox"))
            .respond_with(
                ResponseTemplate::new(200)
                    .set_body_string(r#"{"access_token":"MC","expires_in":60}"#),
            )
            .mount(server)
            .await;
        Mock::given(method("GET"))
            .and(path("/minecraft/profile"))
            .respond_with(
                ResponseTemplate::new(200)
                    .set_body_string(r#"{"id":"0123456789abcdef0123456789abcdef","name":"Reimu"}"#),
            )
            .mount(server)
            .await;
    }

    /// 后台提前续期的每一次检查：续不了只记日志、不报给谁，下一次检查照常再试。服务故障交回「没续成」；服务
    /// 好了下一次就续上；凭据被判失效时记一条 warn、交回 `None`，账户落成要重新登录，再下一次就不续了。
    /// 单线程运行时：续期跑在它派生的任务里，日志也要收得到。
    #[tokio::test]
    async fn renew_ahead_check_only_logs_failures_and_the_next_check_tries_again() {
        let dir = tempfile::tempdir().unwrap();
        let healthy = MockServer::start().await;
        mount_short_lived_login(&healthy).await;
        let facade = facade_against(&healthy, dir.path());
        facade
            .snapshot()
            .await
            .microsoft_login(|_| {})
            .await
            .unwrap();
        let down = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/token"))
            .respond_with(ResponseTemplate::new(503).set_body_string("Service Unavailable"))
            .mount(&down)
            .await;
        let revoked = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/token"))
            .respond_with(
                ResponseTemplate::new(400)
                    .set_body_string(r#"{"error":"invalid_grant","error_description":"revoked"}"#),
            )
            .mount(&revoked)
            .await;
        let captured = crate::tests::Captured::new();
        let writer = captured.clone();
        let _guard = tracing::subscriber::set_default(
            tracing_subscriber::fmt()
                .with_ansi(false)
                .with_writer(move || writer.clone())
                .finish(),
        );

        assert_eq!(
            renew_ahead_once(&facade_against(&down, dir.path())).await,
            Some(AheadOutcome::Unreachable)
        );
        let Some(AheadOutcome::Renewed(renewed)) = renew_ahead_once(&facade).await else {
            panic!("服务恢复后的下一次检查应续上");
        };
        assert_eq!(renewed.name, "Reimu");
        // 续出来的令牌照样只有 60 秒，仍在提前量里，下一次检查还会续。
        assert_eq!(
            renew_ahead_once(&facade_against(&revoked, dir.path())).await,
            None
        );
        assert_eq!(
            renew_ahead_once(&facade).await,
            Some(AheadOutcome::NotNeeded),
            "已判定要重新登录的账户不再续"
        );

        let log = String::from_utf8(captured.0.lock().unwrap().clone()).unwrap();
        let warned = |needle: &str| {
            log.lines()
                .filter(|line| line.contains(needle))
                .all(|line| line.contains("WARN"))
                && log.contains(needle)
        };
        assert!(warned("后台提前续期因网络或登录服务故障没续成"), "{log}");
        assert!(warned("后台提前续期失败，下次检查或启动时再续"), "{log}");
        assert!(log.contains("已在后台提前续期当前微软账户的令牌"), "{log}");
        let accounts = facade.snapshot().await.accounts().unwrap();
        assert_eq!(accounts[0].status, AccountStatus::Expired);
    }
}
