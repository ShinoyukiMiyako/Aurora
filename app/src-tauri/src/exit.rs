//! 启动器正常退出（`RunEvent::Exit`）时的收尾：游戏还在跑时先让它的会话日志落盘，再等进行中的账户续期落盘，
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
    let facade = app.state::<Facade>();
    // 续期跑在独立任务里，进程一退就没了，新凭据来不及落盘。
    tauri::async_runtime::block_on(crate::commands::accounts::settle_renewals(
        &facade,
        crate::commands::accounts::RENEWALS_EXIT_DEADLINE,
    ));
    tauri::async_runtime::block_on(save_play_records(&facade, PLAY_RECORDS_DEADLINE));
    crate::window_state::flush_on_exit(app);
    // 安装程序拉起后进程随即退出，所以排在补写之后。
    crate::commands::updater::install_on_exit(app);
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
mod tests {
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
}
