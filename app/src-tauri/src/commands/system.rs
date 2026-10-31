//! 系统：内存建议、首次启动、启动提示与连通性探测。

use aurora_core::folders::{ensure_game_dir, probe_dir, validate_game_dir, FirstRunBaseline};
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

/// 本次运行里首次启动向导第一步之前的目录记录（managed state）。第一次提交时取一次，之后的提交都从它出发。
#[derive(Default)]
pub struct FirstRunBaselineSlot(tokio::sync::Mutex<Option<FirstRunBaseline>>);

/// 首次启动第一步提交：校验并创建游戏目录、设为当前、收下勾选的其它启动器文件夹、标记向导完成，
/// 一次落盘。之后中途关掉窗口，下次打开也不再进向导。
///
/// 用户回到第一步改了再离开时会再提交一次：这一次替换上一次的选择，而不是叠加（见 [`FirstRunBaseline`]）。
#[tauri::command]
pub async fn complete_first_run(
    app: AppHandle,
    game_dir: String,
    extra_directories: Vec<NamedDirectoryDto>,
    facade: State<'_, Facade>,
    baseline: State<'_, FirstRunBaselineSlot>,
) -> Result<(), CommandError> {
    let outcome = complete_first_run_with(&facade, &baseline, &game_dir, extra_directories).await;
    crate::textures::refresh_on_success(&app, &outcome).await;
    outcome
}

pub(crate) async fn complete_first_run_with(
    facade: &Facade,
    baseline: &FirstRunBaselineSlot,
    game_dir: &str,
    extra_directories: Vec<NamedDirectoryDto>,
) -> Result<(), CommandError> {
    let game_dir = validate_game_dir(game_dir)?;
    let extras = extra_directories
        .into_iter()
        .map(parse_named_directory)
        .collect::<Result<Vec<_>, _>>()?;
    // 整个提交持有基线锁：两次提交不交错，基线也只在第一次提交建目录之前取一次。
    let mut slot = baseline.0.lock().await;
    let base = match slot.as_ref() {
        Some(base) => base.clone(),
        None => {
            let aurora = facade.snapshot().await;
            let current_exists = probe_dir(aurora.game_dir()).await;
            let base = aurora.first_run_baseline(current_exists);
            *slot = Some(base.clone());
            base
        }
    };
    // 建目录在拿写锁之前：盘慢或挂起时不连累其它命令。
    ensure_game_dir(&game_dir).await?;
    facade
        .update(|aurora| {
            aurora.complete_first_run(&base, game_dir, extras);
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
        /// 解析失败的原因（通常含行列）。
        error: String,
    },
    /// config.json 里有几项设置的取值这个版本不认识（多半是更新的版本写的）：只这几项按默认值启动，
    /// 其余设置照常读入；文件原样不动，用户改了任一设置后才按新值写回。
    ConfigFieldsReset {
        /// 按固定顺序（同核心的枚举字段登记表），至少一项。
        fields: Vec<ConfigFieldResetDto>,
    },
}

/// 一项退回默认的设置。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ConfigFieldResetDto {
    /// 字段在 config.json 里的位置，嵌套用点号连接：download_source、version_list_source、
    /// isolation_policy、appearance.mode、appearance.accent、after_launch、language。
    pub field: &'static str,
    /// 文件里写的原值。
    pub value: String,
}

/// 本次启动的提示（managed state）。启动后不再变化，查询多少次都返回同一份。
pub struct StartupNotices(Vec<StartupNoticeDto>);

impl StartupNotices {
    pub fn from_recovery(recovery: Option<ConfigRecovery>) -> Self {
        Self(
            recovery
                .into_iter()
                .map(|recovery| match recovery {
                    ConfigRecovery::Reset { preserved, error } => StartupNoticeDto::ConfigReset {
                        preserved_path: preserved.display().to_string(),
                        error,
                    },
                    ConfigRecovery::FieldsReset(resets) => StartupNoticeDto::ConfigFieldsReset {
                        fields: resets
                            .into_iter()
                            .map(|reset| ConfigFieldResetDto {
                                field: reset.field,
                                value: reset.value,
                            })
                            .collect(),
                    },
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

// ---- 连通性 ----

/// 下载用的源此刻连不连得上。前端在联网请求以连接类错误失败后、以及离线期间定时调用。
/// 要联网，在快照上进行，不占门面锁。
#[tauri::command]
pub async fn probe_network(facade: State<'_, Facade>) -> Result<bool, CommandError> {
    let aurora = facade.snapshot().await;
    Ok(aurora.probe_network().await?)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::error::code;
    use aurora_core::{Aurora, AuroraConfig, ConfigFieldReset, ConfigStore};

    #[test]
    fn config_recovery_becomes_a_config_reset_notice() {
        assert!(StartupNotices::from_recovery(None).0.is_empty());
        let notices = StartupNotices::from_recovery(Some(ConfigRecovery::Reset {
            preserved: std::path::PathBuf::from(r"C:\Data\config.json.broken-20261031-143025"),
            error: "invalid type: string \"eight\", expected usize at line 1 column 57".into(),
        }));
        assert_eq!(
            serde_json::to_value(&notices.0).unwrap(),
            serde_json::json!([{
                "kind": "config_reset",
                "preserved_path": r"C:\Data\config.json.broken-20261031-143025",
                "error": "invalid type: string \"eight\", expected usize at line 1 column 57"
            }])
        );
    }

    /// 字段级退回是一条提示，逐项带字段位置与原值（含空串），顺序原样保留。
    #[test]
    fn field_resets_become_one_config_fields_reset_notice() {
        let notices = StartupNotices::from_recovery(Some(ConfigRecovery::FieldsReset(vec![
            ConfigFieldReset {
                field: "appearance.mode",
                value: "dusk".into(),
            },
            ConfigFieldReset {
                field: "after_launch",
                value: String::new(),
            },
            ConfigFieldReset {
                field: "language",
                value: "fr-FR".into(),
            },
        ])));
        assert_eq!(
            serde_json::to_value(&notices.0).unwrap(),
            serde_json::json!([{
                "kind": "config_fields_reset",
                "fields": [
                    { "field": "appearance.mode", "value": "dusk" },
                    { "field": "after_launch", "value": "" },
                    { "field": "language", "value": "fr-FR" }
                ]
            }])
        );
    }

    /// 从盘上的文件一路到提示：降级后读到新版本的语言，提示报出原值，文件不动。
    #[tokio::test]
    async fn unknown_enum_value_on_disk_reaches_startup_notice() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config.json");
        let original = br#"{"language": "fr-FR", "first_run_completed": true}"#;
        std::fs::write(&path, original).unwrap();
        let (config, recovery) = ConfigStore::at(&path).load_or_preserve().await.unwrap();
        assert!(config.first_run_completed);
        let notices = StartupNotices::from_recovery(recovery);
        assert_eq!(
            serde_json::to_value(&notices.0).unwrap(),
            serde_json::json!([{
                "kind": "config_fields_reset",
                "fields": [{ "field": "language", "value": "fr-FR" }]
            }])
        );
        assert_eq!(std::fs::read(&path).unwrap(), original);
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
            &FirstRunBaselineSlot::default(),
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

    /// 回到第一步改了目录、取消了勾选再离开：第二次提交替换第一次，目录列表只有这一次的当前目录与勾选项。
    /// 第一次提交建出来的默认目录不被记成「其他游戏目录」，取消勾选的文件夹也不留着。
    #[tokio::test]
    async fn recommitting_first_run_replaces_the_previous_choice() {
        let dir = tempfile::tempdir().unwrap();
        let facade = facade_in(dir.path());
        let slot = FirstRunBaselineSlot::default();
        let default_dir = facade.read().await.game_dir().to_path_buf();
        assert!(!default_dir.exists());
        let official_path = r"C:\Users\p\AppData\Roaming\.minecraft";
        let hmcl = NamedDirectoryDto {
            name: "HMCL".into(),
            path: r"D:\HMCL\.minecraft".into(),
        };
        let official = NamedDirectoryDto {
            name: "官方启动器".into(),
            path: official_path.into(),
        };

        complete_first_run_with(
            &facade,
            &slot,
            &default_dir.display().to_string(),
            vec![hmcl, official.clone()],
        )
        .await
        .unwrap();
        assert!(default_dir.is_dir(), "第一次提交建出了默认目录");

        let petal = dir.path().join("Petal");
        complete_first_run_with(&facade, &slot, &petal.display().to_string(), vec![official])
            .await
            .unwrap();

        let listed: Vec<(String, std::path::PathBuf, bool)> = facade
            .snapshot()
            .await
            .game_directories()
            .await
            .into_iter()
            .map(|e| (e.name, e.path, e.is_current))
            .collect();
        assert_eq!(
            listed,
            vec![
                ("Petal".to_owned(), petal.clone(), true),
                (
                    "官方启动器".to_owned(),
                    std::path::PathBuf::from(official_path),
                    false
                ),
            ]
        );
        let saved = ConfigStore::at(dir.path().join("config.json"))
            .load()
            .await
            .unwrap();
        assert_eq!(saved.game_directory.as_deref(), Some(petal.as_path()));
        assert_eq!(saved.extra_game_directories.len(), 1);
        assert!(saved.first_run_completed);
    }

    /// 校验不过时什么都不写：不建目录、不改配置、仍是首次启动。
    #[tokio::test]
    async fn invalid_first_run_input_changes_nothing() {
        let dir = tempfile::tempdir().unwrap();
        let facade = facade_in(dir.path());
        let slot = FirstRunBaselineSlot::default();
        let good = dir.path().join("ok");

        let err = complete_first_run_with(&facade, &slot, "", Vec::new())
            .await
            .unwrap_err();
        assert_eq!(err.code, code::INVALID_GAME_DIRECTORY);
        assert_eq!(err.detail.unwrap()["problem"], "empty");

        let err = complete_first_run_with(
            &facade,
            &slot,
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
