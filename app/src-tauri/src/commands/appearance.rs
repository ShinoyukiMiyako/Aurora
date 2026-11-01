//! 外观偏好：前端首帧渲染前读取，切换时写回配置。
//!
//! 出入参都是 `{ mode, accent, petals, panorama, reduce_motion }`（snake_case），取值见
//! aurora-core 的 appearance 模块。

use aurora_core::{Appearance, AppearancePatch};
use serde_json::Value;
use tauri::State;

use crate::commands::CommandError;
use crate::facade::Facade;

/// 读取外观偏好。只读内存，首帧前调用也不会被任何长任务挡住。
#[tauri::command]
pub async fn get_appearance(facade: State<'_, Facade>) -> Result<Appearance, CommandError> {
    Ok(facade.read().await.appearance())
}

/// 合并一次外观修改、落盘，返回合并后的完整偏好。
///
/// `patch` 只带要改的字段；未知字段或非法取值报 `invalid_argument`，什么都不改。
#[tauri::command]
pub async fn set_appearance(
    patch: Value,
    facade: State<'_, Facade>,
) -> Result<Appearance, CommandError> {
    set_appearance_with(&facade, patch).await
}

pub(crate) async fn set_appearance_with(
    facade: &Facade,
    patch: Value,
) -> Result<Appearance, CommandError> {
    // 自己反序列化而不交给 Tauri：非法取值也要走统一的 { code, message } 形状，前端才能按码处理。
    let patch: AppearancePatch = serde_json::from_value(patch)
        .map_err(|err| CommandError::invalid_argument(format!("外观设置不合法：{err}")))?;

    // 没存住时门面原样不动：否则之后读到的是一份重启即丢的外观，与前端回滚后的状态也对不上。
    facade
        .update(|aurora| Ok::<_, CommandError>(aurora.set_appearance(patch)))
        .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use aurora_core::{AccentColor, AppearanceMode, Aurora, AuroraConfig, ConfigStore};
    use serde_json::json;
    use std::path::Path;

    use crate::commands::error::code;

    fn facade_at(config_path: &Path, data_dir: &Path) -> Facade {
        let aurora = Aurora::open(
            AuroraConfig::default(),
            data_dir.to_path_buf(),
            config_path.to_path_buf(),
        )
        .unwrap();
        Facade::new(aurora)
    }

    #[tokio::test]
    async fn defaults_then_patch_roundtrips_through_config_file() {
        let dir = tempfile::tempdir().unwrap();
        let config_path = dir.path().join("config.json");
        let facade = facade_at(&config_path, dir.path());

        let initial = facade.read().await.appearance();
        assert_eq!(
            serde_json::to_value(initial).unwrap(),
            json!({
                "mode": "day",
                "accent": "sakura",
                "petals": true,
                "panorama": false,
                "reduce_motion": false
            })
        );

        let merged = set_appearance_with(&facade, json!({ "mode": "night", "accent": "moss" }))
            .await
            .unwrap();
        assert_eq!(merged.mode, AppearanceMode::Night);
        assert_eq!(merged.accent, AccentColor::Moss);
        assert!(merged.petals, "未给出的字段保持原值");

        // 落盘内容与返回值一致；重新载入的配置读出同一份外观。
        let reloaded = ConfigStore::at(&config_path).load().await.unwrap();
        assert_eq!(reloaded.appearance, merged);
        assert_eq!(facade.read().await.appearance(), merged);
    }

    #[tokio::test]
    async fn invalid_patch_is_rejected_and_changes_nothing() {
        let dir = tempfile::tempdir().unwrap();
        let config_path = dir.path().join("config.json");
        let facade = facade_at(&config_path, dir.path());

        for bad in [
            json!({ "accent": "pink" }),
            json!({ "mode": "Night" }),
            json!({ "reduceMotion": true }),
            json!({ "petals": "yes" }),
        ] {
            let err = set_appearance_with(&facade, bad.clone()).await.unwrap_err();
            assert_eq!(err.code, code::INVALID_ARGUMENT, "{bad} 应被拒绝");
        }
        assert_eq!(facade.read().await.appearance(), Appearance::default());
        assert!(!config_path.exists(), "被拒绝的修改不应落盘");
    }

    #[tokio::test]
    async fn failed_save_rolls_memory_back() {
        let dir = tempfile::tempdir().unwrap();
        // 让配置路径的「父目录」其实是个文件，原子写必然失败。
        let blocker = dir.path().join("not-a-dir");
        std::fs::write(&blocker, b"x").unwrap();
        let facade = facade_at(&blocker.join("config.json"), dir.path());

        let err = set_appearance_with(&facade, json!({ "panorama": true }))
            .await
            .unwrap_err();
        assert_eq!(err.code, code::IO);
        assert!(
            !facade.read().await.appearance().panorama,
            "没存住的修改不应留在内存里"
        );
    }
}
