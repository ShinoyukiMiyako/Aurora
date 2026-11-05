//! 启动器正常退出（`RunEvent::Exit`）时的收尾：游戏还在跑时先让它的会话日志落盘，再等进行中的外置令牌轮换落盘，
//! 补写游玩记录里还没落盘的改动与主窗口状态，最后按需拉起更新安装程序。
//!
//! 实例改名、删除时游玩记录没写进去的改动只记在进程内，之后哪次读写游玩记录时补上；没等到那一次就退出，
//! 它们就丢了，旧名下的时长从此不对应任何实例。所以退出前再补写一次。退出路径上没有前端可以报错，结果只进日志。

use std::time::Duration;

use tauri::{AppHandle, Manager};

use crate::commands::error::source_chain;
use crate::facade::Facade;

/// 退出时补写游玩记录最多等这么久。写的是一份很小的文件，正常是毫秒级；磁盘或杀毒软件卡住时不能让窗口
/// 关掉之后的进程一直挂着。
pub const PLAY_RECORDS_DEADLINE: Duration = Duration::from_secs(3);

/// 在 `RunEvent::Exit` 里调用。
pub fn on_exit(app: &AppHandle) {
    // 排在最前：游戏还在跑时会话日志缓冲里攒着最后的输出，越早落盘越好。
    crate::commands::launch::mark_on_exit(app);
    tauri::async_runtime::block_on(persist_before_exit(&app.state::<Facade>()));
    crate::window_state::flush_on_exit(app);
    // 安装程序拉起后进程随即退出，所以排在补写之后。
    crate::commands::updater::install_on_exit(app);
}

/// 进程结束前要做的落盘：等进行中的外置令牌轮换，再补写游玩记录。正常退出与自更新拉起安装程序之前
/// （[`crate::commands::updater::install_after_persisting`]）都走这里。续期跑在独立任务里，进程一退就没了，
/// 新令牌来不及落盘。两步各有时限，结果只进日志。
pub async fn persist_before_exit(facade: &Facade) {
    crate::commands::accounts::settle_rotations(
        facade,
        crate::commands::accounts::ROTATIONS_EXIT_DEADLINE,
    )
    .await;
    save_play_records(facade, PLAY_RECORDS_DEADLINE).await;
}

/// 退出时补写游玩记录的结局。
#[derive(Debug)]
pub enum PlayRecordsSave {
    /// 没有待补的改动，文件没碰。
    NothingPending,
    /// 待补的改动已写进文件。
    Saved,
    /// 写不进，改动随退出丢失。
    Failed,
    /// 超过时限还没写完，放弃等待。
    TimedOut,
}

/// 补写待补的游玩记录并记日志。在门面快照上做，不占着门面锁等磁盘。
pub async fn save_play_records(facade: &Facade, deadline: Duration) -> PlayRecordsSave {
    let saved = tokio::time::timeout(deadline, async {
        facade.snapshot().await.save_pending_play_records().await
    })
    .await;
    match saved {
        Ok(Ok(false)) => PlayRecordsSave::NothingPending,
        Ok(Ok(true)) => {
            tracing::info!("退出前补写了游玩记录里没落盘的改名、删除");
            PlayRecordsSave::Saved
        }
        Ok(Err(err)) => {
            tracing::error!(
                error = %err,
                causes = ?source_chain(&err),
                "退出前补写游玩记录失败，没落盘的改名、删除随退出丢失，旧名下的时长不再对应任何实例"
            );
            PlayRecordsSave::Failed
        }
        Err(_) => {
            tracing::error!(
                deadline_ms = deadline.as_millis() as u64,
                "退出前补写游玩记录超时，没落盘的改名、删除随退出丢失，旧名下的时长不再对应任何实例"
            );
            PlayRecordsSave::TimedOut
        }
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use std::path::Path;

    use petalfall_core::playtime::PLAYTIME_FILE;
    use petalfall_core::{Petalfall, PetalfallConfig};
    use serde_json::Value;

    use super::*;

    /// 数据目录在 `dir`、游戏目录取默认（数据目录下）的门面。
    fn facade_in(dir: &Path) -> Facade {
        Facade::new(
            Petalfall::open(
                PetalfallConfig::default(),
                dir.to_path_buf(),
                dir.join("config.json"),
            )
            .unwrap(),
        )
    }

    /// 只按实例 id 记的旧版本文件，读到时归到当前游戏目录，不必知道游戏目录的完整路径。
    const RECORDS: &str = r#"{"format":1,"book":{
        "instances":{
            "旧名":{"total_ms":7200000,"last_played_at":1761800000000},
            "删掉的":{"total_ms":600000,"last_played_at":1761700000000},
            "留下":{"total_ms":1800000,"last_played_at":1761600000000}},
        "days":{"2026-10-30":{"instances":{"旧名":7200000,"删掉的":600000,"留下":1800000}}}}}"#;

    fn saved_ids(path: &Path) -> Vec<String> {
        let saved: Value = serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
        assert_eq!(saved["format"], 2);
        saved["directories"][0]["book"]["instances"]
            .as_object()
            .unwrap()
            .keys()
            .cloned()
            .collect()
    }

    /// 改名、删除时游玩记录读不出来，改动只在进程内待补；文件恢复后启动器直接退出，退出流程把它们写进文件，
    /// 之后队列是空的。
    #[tokio::test]
    async fn exit_saves_pending_play_record_changes_and_empties_the_queue() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(PLAYTIME_FILE);
        let facade = facade_in(dir.path());
        std::fs::write(&path, "{ broken").unwrap();
        let petalfall = facade.snapshot().await;
        assert!(petalfall.rename_play_records("旧名", "新名").await.is_err());
        assert!(petalfall.forget_play_records("删掉的").await.is_err());
        std::fs::write(&path, RECORDS).unwrap();

        let outcome = save_play_records(&facade, PLAY_RECORDS_DEADLINE).await;
        assert!(matches!(outcome, PlayRecordsSave::Saved), "{outcome:?}");
        assert_eq!(saved_ids(&path), vec!["新名", "留下"]);
        let saved: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        let book = &saved["directories"][0]["book"];
        assert_eq!(book["instances"]["新名"]["total_ms"], 7_200_000);
        assert_eq!(book["days"]["2026-10-30"]["instances"]["新名"], 7_200_000);
        assert!(book["days"]["2026-10-30"]["instances"]
            .get("删掉的")
            .is_none());

        assert!(!facade
            .snapshot()
            .await
            .save_pending_play_records()
            .await
            .unwrap());
        assert!(matches!(
            save_play_records(&facade, PLAY_RECORDS_DEADLINE).await,
            PlayRecordsSave::NothingPending
        ));
    }

    /// 没有待补的改动时退出流程不碰文件：坏文件原样留着，也不因读它报错。
    #[tokio::test]
    async fn exit_with_nothing_pending_leaves_the_file_alone() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(PLAYTIME_FILE);
        let facade = facade_in(dir.path());
        let outcome = save_play_records(&facade, PLAY_RECORDS_DEADLINE).await;
        assert!(
            matches!(outcome, PlayRecordsSave::NothingPending),
            "{outcome:?}"
        );
        assert!(!path.exists());

        std::fs::write(&path, "{ broken").unwrap();
        let outcome = save_play_records(&facade, PLAY_RECORDS_DEADLINE).await;
        assert!(
            matches!(outcome, PlayRecordsSave::NothingPending),
            "{outcome:?}"
        );
        assert_eq!(std::fs::read(&path).unwrap(), b"{ broken");
    }

    /// 退出时文件仍替换不了：报失败而不是当成写好了，改动也没被丢出队列，放开后还能写进去。
    #[cfg(windows)]
    #[tokio::test]
    async fn exit_reports_a_failed_save_and_keeps_the_changes() {
        use std::os::windows::fs::OpenOptionsExt;

        const FILE_SHARE_READ: u32 = 1;
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(PLAYTIME_FILE);
        let facade = facade_in(dir.path());
        std::fs::write(&path, RECORDS).unwrap();
        let held = std::fs::OpenOptions::new()
            .read(true)
            .share_mode(FILE_SHARE_READ)
            .open(&path)
            .unwrap();
        let petalfall = facade.snapshot().await;
        assert!(petalfall.rename_play_records("旧名", "新名").await.is_err());

        let outcome = save_play_records(&facade, PLAY_RECORDS_DEADLINE).await;
        assert!(matches!(outcome, PlayRecordsSave::Failed), "{outcome:?}");
        assert_eq!(std::fs::read_to_string(&path).unwrap(), RECORDS);
        drop(held);

        assert!(facade
            .snapshot()
            .await
            .save_pending_play_records()
            .await
            .unwrap());
        assert_eq!(saved_ids(&path), vec!["删掉的", "新名", "留下"]);
    }

    /// 外置账户正在刷新令牌时退出：退出收尾等到新令牌落了盘才往下走。服务器那边旧令牌已经作废，
    /// 把等待从收尾里拿掉，重开读到的就是作废了的旧令牌，账户只能重新登录。
    #[cfg(windows)]
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn exit_waits_for_the_authlib_rotation_in_flight() {
        let dir = tempfile::tempdir().unwrap();
        let rotation = authlib_rotation_in_flight(dir.path()).await;
        assert_eq!(rotation.stored_token(), "stale");

        persist_before_exit(&rotation.facade).await;
        assert_eq!(rotation.stored_token(), "rotated");
    }

    /// 一次进行中的外置令牌刷新：刷新端点扣着回音，新令牌还没落盘。
    #[cfg(windows)]
    pub(crate) struct AuthlibRotation {
        pub(crate) facade: Facade,
        dir: std::path::PathBuf,
        _server: wiremock::MockServer,
    }

    #[cfg(windows)]
    impl AuthlibRotation {
        /// 重开门面读到的令牌：落了盘的才读得到。
        pub(crate) fn stored_token(&self) -> String {
            let reopened = Petalfall::open(
                PetalfallConfig::default(),
                self.dir.clone(),
                self.dir.join("config.json"),
            )
            .unwrap();
            match reopened.find_account(HERO).unwrap().unwrap().credentials {
                petalfall_core::AccountCredentials::AuthlibInjector(creds) => creds.access_token,
                other => panic!("期望外置凭据，得到 {other:?}"),
            }
        }
    }

    #[cfg(windows)]
    const HERO: &str = "1111111111111111aaaaaaaaaaaaaaaa";

    /// 在 `dir` 登录一个外置账户，再让它的令牌刷新停在等回音上（扣 1 秒），刷新请求发出后才返回。
    #[cfg(windows)]
    pub(crate) async fn authlib_rotation_in_flight(dir: &Path) -> AuthlibRotation {
        use serde_json::json;
        use wiremock::matchers::{method, path};
        use wiremock::{Mock, MockServer, ResponseTemplate};

        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "meta": { "serverName": "Petal Skin" },
                "skinDomains": ["127.0.0.1"]
            })))
            .mount(&server)
            .await;
        Mock::given(method("POST"))
            .and(path("/authserver/authenticate"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "accessToken": "stale", "clientToken": "cli",
                "availableProfiles": [ { "id": HERO, "name": "Hero" } ],
                "selectedProfile": { "id": HERO, "name": "Hero" }
            })))
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path(format!(
                "/sessionserver/session/minecraft/profile/{HERO}"
            )))
            .respond_with(ResponseTemplate::new(204))
            .mount(&server)
            .await;
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
                        "selectedProfile": { "id": HERO, "name": "Hero" }
                    }))
                    .set_delay(Duration::from_secs(1)),
            )
            .mount(&server)
            .await;

        let facade = facade_in(dir);
        let petalfall = facade.snapshot().await;
        let petalfall_core::AuthlibLogin::LoggedIn(account) = petalfall
            .authlib_login(&server.uri(), "hero@example.com", "pw")
            .await
            .unwrap()
        else {
            panic!("服务器替用户选定了角色，应直接登录");
        };
        // 不等它：刷新跑在核心的独立任务里，落不落盘与这个调用方无关。
        drop(tokio::spawn(async move {
            petalfall.ensure_account_fresh(&account).await
        }));
        tokio::time::timeout(Duration::from_secs(15), async {
            while !server
                .received_requests()
                .await
                .unwrap()
                .iter()
                .any(|r| r.url.path() == "/authserver/refresh")
            {
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        })
        .await
        .expect("15 秒内没等到刷新请求");
        AuthlibRotation {
            facade,
            dir: dir.to_path_buf(),
            _server: server,
        }
    }
}
