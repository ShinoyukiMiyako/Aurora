//! 实例的 Mod 变更历史、回滚与备份占用。

use aurora_core::{HistoryEvent, RollbackCheck};
use tauri::State;

use crate::commands::instances::{InstanceActivity, InstanceLocks};
use crate::commands::mods::mods_error;
use crate::commands::CommandError;
use crate::facade::Facade;

/// 列出实例的全部变更事件（时间正序）。
#[tauri::command]
pub async fn list_history(
    version_id: String,
    facade: State<'_, Facade>,
) -> Result<Vec<HistoryEvent>, CommandError> {
    let aurora = facade.snapshot().await;
    Ok(aurora.history(&version_id).await?.events)
}

/// 逐条判断历史事件能否回滚，与 `list_history` 的顺序一一对齐。
#[tauri::command]
pub async fn rollback_checks(
    version_id: String,
    facade: State<'_, Facade>,
) -> Result<Vec<RollbackCheck>, CommandError> {
    let aurora = facade.snapshot().await;
    Ok(aurora.rollback_checks(&version_id).await?)
}

/// 回滚一条更新事件：旧文件从 `.old` 复原，新文件删除，历史追加一条回滚事件。回滚期间以
/// 「改动 Mod 与资源」占住实例，与改名、删除互斥。
#[tauri::command]
pub async fn rollback(
    version_id: String,
    event_id: String,
    facade: State<'_, Facade>,
    locks: State<'_, InstanceLocks>,
) -> Result<(), CommandError> {
    rollback_with(&facade, &locks, &version_id, &event_id).await
}

pub(crate) async fn rollback_with(
    facade: &Facade,
    locks: &InstanceLocks,
    version_id: &str,
    event_id: &str,
) -> Result<(), CommandError> {
    if event_id.trim().is_empty() {
        return Err(CommandError::invalid_argument("event_id 不能为空"));
    }
    let _guard = locks.acquire(version_id, InstanceActivity::Modifying)?;
    let aurora = facade.snapshot().await;
    aurora
        .rollback(version_id, event_id)
        .await
        .map_err(mods_error)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::error::code;
    use aurora_core::{Aurora, AuroraConfig, IsolationPolicy};

    #[tokio::test]
    async fn rollback_rejects_empty_event_id_and_unknown_version() {
        let tmp = tempfile::tempdir().unwrap();
        let mut aurora = Aurora::open(
            AuroraConfig::default(),
            tmp.path().to_path_buf(),
            tmp.path().join("config.json"),
        )
        .unwrap();
        aurora.set_game_dir(tmp.path());
        aurora.set_isolation_policy(IsolationPolicy::All);
        let facade = Facade::new(aurora);

        let err = rollback_with(&facade, &InstanceLocks::default(), "1.21", "")
            .await
            .unwrap_err();
        assert_eq!(err.code, code::INVALID_ARGUMENT);
        let err = rollback_with(&facade, &InstanceLocks::default(), "ghost", "1-001")
            .await
            .unwrap_err();
        assert_eq!(err.code, code::VERSION_NOT_INSTALLED);
    }

    /// 一次完整的「更新留底 -> 检查 -> 回滚」经命令层走通，事件序列化成前端约定的形状。
    #[tokio::test]
    async fn rollback_restores_backup_and_history_serializes_for_ipc() {
        let tmp = tempfile::tempdir().unwrap();
        let mc = tmp.path().join(".minecraft");
        let dir = mc.join("versions").join("1.21");
        let mods = dir.join("mods");
        tokio::fs::create_dir_all(&mods).await.unwrap();
        tokio::fs::write(
            dir.join("1.21.json"),
            r#"{"id":"1.21","type":"release","mainClass":"m"}"#,
        )
        .await
        .unwrap();
        tokio::fs::write(mods.join("a-2.jar"), b"new")
            .await
            .unwrap();
        tokio::fs::write(mods.join("a-1.jar.old"), b"old!")
            .await
            .unwrap();

        let mut aurora = Aurora::open(
            AuroraConfig::default(),
            tmp.path().to_path_buf(),
            tmp.path().join("config.json"),
        )
        .unwrap();
        aurora.set_game_dir(&mc);
        aurora.set_isolation_policy(IsolationPolicy::All);
        aurora
            .history_store("1.21")
            .append(HistoryEvent::Update {
                id: "200-001".to_owned(),
                at: 200,
                file_name: "a-2.jar".to_owned(),
                old_file: "a-1.jar".to_owned(),
                backup_file: None,
                from_version: "V1".to_owned(),
                to_version: "V2".to_owned(),
                title: None,
                from_version_number: None,
                to_version_number: None,
            })
            .await
            .unwrap();
        let facade = Facade::new(aurora);

        let size = facade.snapshot().await.backup_size("1.21").await.unwrap();
        assert_eq!(size, 4);
        let checks = facade
            .snapshot()
            .await
            .rollback_checks("1.21")
            .await
            .unwrap();
        assert!(checks[0].can_rollback);

        // 实例正在改名时回滚以 instance_busy 拒绝，文件不动；改名结束后照常回滚。
        let locks = InstanceLocks::default();
        let renaming = locks.acquire("1.21", InstanceActivity::Renaming).unwrap();
        let err = rollback_with(&facade, &locks, "1.21", "200-001")
            .await
            .unwrap_err();
        assert_eq!(err.code, code::INSTANCE_BUSY);
        assert!(mods.join("a-2.jar").exists());
        assert!(mods.join("a-1.jar.old").exists());
        drop(renaming);

        rollback_with(&facade, &locks, "1.21", "200-001")
            .await
            .unwrap();
        assert_eq!(
            tokio::fs::read(mods.join("a-1.jar")).await.unwrap(),
            b"old!"
        );
        assert!(!mods.join("a-2.jar").exists());

        let events = facade
            .snapshot()
            .await
            .history("1.21")
            .await
            .unwrap()
            .events;
        let json = serde_json::to_value(&events).unwrap();
        assert_eq!(json[0]["kind"], "update");
        assert_eq!(json[0]["from_version_number"], serde_json::Value::Null);
        assert_eq!(json[1]["kind"], "rollback");
        assert_eq!(json[1]["reverted_event"], "200-001");
    }
}
