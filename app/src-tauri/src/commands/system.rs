//! 系统：内存建议、首次启动与启动提示。

use aurora_core::folders::{ensure_game_dir, validate_game_dir};
use aurora_core::{ConfigRecovery, MemoryAdvice, MemoryTier};
use serde::Serialize;
use tauri::{AppHandle, State};

use crate::commands::config::{parse_named_directory, NamedDirectoryDto};
use crate::commands::CommandError;
use crate::facade::Facade;

/// 设置页内存卡要的事实：物理内存总量、此刻空闲、推荐值按哪一档算、推荐值。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct MemoryAdviceDto {
    pub total_mb: u32,
    pub available_mb: u32,
    /// vanilla / modded / large_modpack。
    pub tier: MemoryTier,
    /// 自动分配此刻会给多少（MB），不超过物理内存一半。
    pub recommended_mb: u32,
}

impl From<MemoryAdvice> for MemoryAdviceDto {
    fn from(advice: MemoryAdvice) -> Self {
        Self {
            total_mb: advice.total_mb,
            available_mb: advice.available_mb,
            tier: advice.tier,
            recommended_mb: advice.recommended_mb,
        }
    }
}

/// 内存建议。给出 `versionId` 按该实例定档；不给按主页当前选中的实例，没有选中按原版。
/// 要扫版本目录，在快照上进行。
#[tauri::command]
pub async fn memory_advice(
    version_id: Option<String>,
    facade: State<'_, Facade>,
) -> Result<MemoryAdviceDto, CommandError> {
    let aurora = facade.snapshot().await;
    Ok(aurora.memory_advice(version_id.as_deref()).await?.into())
}

/// 首次启动向导是否还没走过第一步。
#[tauri::command]
pub async fn is_first_run(facade: State<'_, Facade>) -> Result<bool, CommandError> {
    Ok(facade.read().await.is_first_run())
}

/// 首次启动第一步提交：校验并创建游戏目录、设为当前、收下勾选的其它启动器文件夹、标记向导完成，
/// 一次落盘。之后中途关掉窗口，下次打开也不再进向导。
#[tauri::command]
pub async fn complete_first_run(
    app: AppHandle,
    game_dir: String,
    extra_directories: Vec<NamedDirectoryDto>,
    facade: State<'_, Facade>,
) -> Result<(), CommandError> {
    let outcome = complete_first_run_with(&facade, &game_dir, extra_directories).await;
    crate::textures::refresh_on_success(&app, &outcome).await;
    outcome
}

pub(crate) async fn complete_first_run_with(
    facade: &Facade,
    game_dir: &str,
    extra_directories: Vec<NamedDirectoryDto>,
) -> Result<(), CommandError> {
    let game_dir = validate_game_dir(game_dir)?;
    let extras = extra_directories
        .into_iter()
        .map(parse_named_directory)
        .collect::<Result<Vec<_>, _>>()?;
    // 建目录在拿写锁之前：盘慢或挂起时不连累其它命令。
    ensure_game_dir(&game_dir).await?;
    facade
        .update(|aurora| {
            aurora.complete_first_run(game_dir, extras);
            Ok::<_, CommandError>(())
        })
        .await
}

// ---- 启动提示 ----

/// 启动时发生、要让用户知道的事。前端启动后查询一次，按 `kind` 展示。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum StartupNoticeDto {
    /// config.json 读不出来：坏文件已改名留存，本次按默认配置启动（首次启动向导会重新出现）。
    ConfigReset {
        /// 坏文件改名后的绝对路径，原样保留着用户的内容。
        preserved_path: String,
        /// 解析失败的原因（含行列）。
        error: String,
    },
}

/// 本次启动的提示（managed state）。启动后不再变化，查询多少次都返回同一份。
pub struct StartupNotices(Vec<StartupNoticeDto>);

impl StartupNotices {
    pub fn from_recovery(recovery: Option<ConfigRecovery>) -> Self {
        Self(
            recovery
                .into_iter()
                .map(|recovery| StartupNoticeDto::ConfigReset {
                    preserved_path: recovery.preserved.display().to_string(),
                    error: recovery.error,
                })
                .collect(),
        )
    }
}

/// 本次启动的提示；没有时为空列表。
#[tauri::command]
pub async fn startup_notices(
    notices: State<'_, StartupNotices>,
) -> Result<Vec<StartupNoticeDto>, CommandError> {
    Ok(notices.0.clone())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::error::code;
    use aurora_core::{Aurora, AuroraConfig, ConfigStore};

    #[test]
    fn config_recovery_becomes_a_config_reset_notice() {
        assert!(StartupNotices::from_recovery(None).0.is_empty());
        let notices = StartupNotices::from_recovery(Some(ConfigRecovery {
            preserved: std::path::PathBuf::from(r"C:\Data\config.json.broken-20261031-143025"),
            error: "unknown variant `hide` at line 1 column 22".into(),
        }));
        assert_eq!(
            serde_json::to_value(&notices.0).unwrap(),
            serde_json::json!([{
                "kind": "config_reset",
                "preserved_path": r"C:\Data\config.json.broken-20261031-143025",
                "error": "unknown variant `hide` at line 1 column 22"
            }])
        );
    }

    fn facade_in(dir: &std::path::Path) -> Facade {
        Facade::new(
            Aurora::open(
                AuroraConfig::default(),
                dir.to_path_buf(),
                dir.join("config.json"),
            )
            .unwrap(),
        )
    }

    #[tokio::test]
    async fn complete_first_run_creates_dir_and_persists_once() {
        let dir = tempfile::tempdir().unwrap();
        let facade = facade_in(dir.path());
        assert!(facade.read().await.is_first_run());
        let game_dir = dir.path().join("Games").join(".minecraft");

        complete_first_run_with(
            &facade,
            &game_dir.display().to_string(),
            vec![NamedDirectoryDto {
                name: "HMCL".into(),
                path: "D:\\HMCL\\.minecraft".into(),
            }],
        )
        .await
        .unwrap();

        assert!(game_dir.is_dir());
        assert!(!facade.read().await.is_first_run());
        let saved = ConfigStore::at(dir.path().join("config.json"))
            .load()
            .await
            .unwrap();
        assert!(saved.first_run_completed);
        assert_eq!(saved.game_directory.as_deref(), Some(game_dir.as_path()));
        assert_eq!(saved.extra_game_directories.len(), 1);
        assert_eq!(saved.extra_game_directories[0].name, "HMCL");
    }

    /// 校验不过时什么都不写：不建目录、不改配置、仍是首次启动。
    #[tokio::test]
    async fn invalid_first_run_input_changes_nothing() {
        let dir = tempfile::tempdir().unwrap();
        let facade = facade_in(dir.path());
        let good = dir.path().join("ok");

        let err = complete_first_run_with(&facade, "", Vec::new())
            .await
            .unwrap_err();
        assert_eq!(err.code, code::INVALID_GAME_DIRECTORY);
        assert_eq!(err.detail.unwrap()["problem"], "empty");

        let err = complete_first_run_with(
            &facade,
            &good.display().to_string(),
            vec![NamedDirectoryDto {
                name: "".into(),
                path: "D:\\x".into(),
            }],
        )
        .await
        .unwrap_err();
        assert_eq!(err.code, code::INVALID_ARGUMENT);
        assert!(!good.exists(), "校验失败不应建目录");
        assert!(facade.read().await.is_first_run());
        assert!(!dir.path().join("config.json").exists());
    }

    #[tokio::test]
    async fn unknown_instance_in_memory_advice_is_version_not_installed() {
        let dir = tempfile::tempdir().unwrap();
        let aurora = facade_in(dir.path()).snapshot().await;
        let err: CommandError = aurora
            .memory_advice(Some("ghost"))
            .await
            .unwrap_err()
            .into();
        assert_eq!(err.code, code::VERSION_NOT_INSTALLED);

        let advice: MemoryAdviceDto = aurora.memory_advice(None).await.unwrap().into();
        let json = serde_json::to_value(advice).unwrap();
        assert_eq!(json["tier"], "vanilla");
        assert!(json["recommended_mb"].as_u64().unwrap() * 2 <= json["total_mb"].as_u64().unwrap());
    }
}
