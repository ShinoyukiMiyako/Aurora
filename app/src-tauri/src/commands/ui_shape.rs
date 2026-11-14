//! 界面形状缓存：前端首帧渲染前读取，按它给晚到的数据先占位；数据落定后写回。
//!
//! 出入参都是 `{ recent_cards, repair_banner }`（snake_case），取值见 petalfall-core 的 ui_shape 模块。

use petalfall_core::{UiShape, UiShapePatch};
use serde_json::Value;
use tauri::State;

use crate::commands::CommandError;
use crate::facade::Facade;

/// 读取界面形状。只读内存，首帧前调用也不会被任何长任务挡住。
#[tauri::command]
pub async fn get_ui_shape(facade: State<'_, Facade>) -> Result<UiShape, CommandError> {
    Ok(facade.read().await.ui_shape())
}

/// 合并一次形状写回，返回合并后的完整形状。
///
/// `patch` 是只带要改的字段的对象；不是对象、带未知字段、字段给 `null`、类型不对或 `recent_cards` 越界都报
/// `invalid_argument`，什么都不改。
/// 形状没变时不落盘：前端每次数据落定都会写回，多数时候与上次相同。
#[tauri::command]
pub async fn set_ui_shape(
    patch: Value,
    facade: State<'_, Facade>,
) -> Result<UiShape, CommandError> {
    set_ui_shape_with(&facade, patch).await
}

pub(crate) async fn set_ui_shape_with(
    facade: &Facade,
    patch: Value,
) -> Result<UiShape, CommandError> {
    // 自己反序列化而不交给 Tauri：非法取值也要走统一的 { code, message } 形状，前端才能按码处理。
    // 先挡住非对象：serde 的结构体也收数组形式，`[3, true]` 会被按字段顺序读成一次合法的写回。
    if !patch.is_object() {
        return Err(CommandError::invalid_argument(format!(
            "界面形状不合法：patch 必须是对象，收到 {patch}"
        )));
    }
    let patch: UiShapePatch = serde_json::from_value(patch)
        .map_err(|err| CommandError::invalid_argument(format!("界面形状不合法：{err}")))?;

    // 没存住时门面原样不动，与外观的写法一致。
    let mut merged = None;
    facade
        .update_if_changed(|petalfall| {
            let changed = petalfall.set_ui_shape(patch);
            merged = Some(petalfall.ui_shape());
            changed
        })
        .await?;
    Ok(merged.expect("update_if_changed 总会调用改动闭包"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use petalfall_core::{ConfigStore, Petalfall, PetalfallConfig};
    use serde_json::json;
    use std::path::Path;

    use crate::commands::error::code;

    fn facade_at(config: PetalfallConfig, config_path: &Path, data_dir: &Path) -> Facade {
        let petalfall =
            Petalfall::open(config, data_dir.to_path_buf(), config_path.to_path_buf()).unwrap();
        Facade::new(petalfall)
    }

    #[tokio::test]
    async fn defaults_then_patch_roundtrips_through_config_file() {
        let dir = tempfile::tempdir().unwrap();
        let config_path = dir.path().join("config.json");
        let facade = facade_at(PetalfallConfig::default(), &config_path, dir.path());

        assert_eq!(
            serde_json::to_value(facade.read().await.ui_shape()).unwrap(),
            json!({ "recent_cards": 0, "repair_banner": false })
        );

        let merged = set_ui_shape_with(&facade, json!({ "recent_cards": 3 }))
            .await
            .unwrap();
        assert_eq!(
            serde_json::to_value(merged).unwrap(),
            json!({ "recent_cards": 3, "repair_banner": false })
        );
        let merged = set_ui_shape_with(&facade, json!({ "repair_banner": true }))
            .await
            .unwrap();
        assert_eq!(
            merged,
            UiShape {
                recent_cards: 3,
                repair_banner: true,
            },
            "未给出的字段保持原值"
        );

        // 落盘内容与返回值一致；重新载入的配置读出同一份形状。
        let reloaded = ConfigStore::at(&config_path).load().await.unwrap();
        assert_eq!(reloaded.ui_shape, merged);
        assert_eq!(facade.read().await.ui_shape(), merged);
    }

    /// 读的是门面里载入的那份配置。
    #[tokio::test]
    async fn reads_the_shape_loaded_with_the_config() {
        let dir = tempfile::tempdir().unwrap();
        let shape = UiShape {
            recent_cards: 6,
            repair_banner: true,
        };
        let config = PetalfallConfig {
            ui_shape: shape,
            ..PetalfallConfig::default()
        };
        let facade = facade_at(config, &dir.path().join("config.json"), dir.path());
        assert_eq!(facade.read().await.ui_shape(), shape);
    }

    #[tokio::test]
    async fn invalid_patch_is_rejected_and_changes_nothing() {
        let dir = tempfile::tempdir().unwrap();
        let config_path = dir.path().join("config.json");
        let facade = facade_at(PetalfallConfig::default(), &config_path, dir.path());

        for (bad, mentions) in [
            (json!({ "recent_cards": 7 }), "7"),
            (json!({ "recent_cards": 255, "repair_banner": true }), "255"),
            (json!({ "recent_cards": -1 }), "-1"),
            (json!({ "recent_cards": "3" }), "expected u8"),
            (json!({ "recentCards": 2 }), "recentCards"),
            (
                json!({ "repair_banner": true, "pack_rows": [] }),
                "pack_rows",
            ),
            (json!({ "repair_banner": "yes" }), "yes"),
            (json!({ "repair_banner": null }), "null"),
            (json!([3, true]), "必须是对象"),
            (json!([true]), "必须是对象"),
            (json!(null), "必须是对象"),
            (json!("recent_cards"), "必须是对象"),
        ] {
            let err = set_ui_shape_with(&facade, bad.clone()).await.unwrap_err();
            assert_eq!(err.code, code::INVALID_ARGUMENT, "{bad} 应被拒绝");
            assert!(
                err.message.starts_with("界面形状不合法：") && err.message.contains(mentions),
                "{bad}：{}",
                err.message
            );
        }
        assert_eq!(facade.read().await.ui_shape(), UiShape::default());
        assert!(!config_path.exists(), "被拒绝的修改不应落盘");
    }

    /// 写回与现值相同时不碰磁盘：配置文件根本写不进去也照常返回当前形状。
    #[tokio::test]
    async fn unchanged_shape_is_not_saved() {
        let dir = tempfile::tempdir().unwrap();
        let config_path = dir.path().join("config.json");
        let facade = facade_at(PetalfallConfig::default(), &config_path, dir.path());

        let same = set_ui_shape_with(
            &facade,
            json!({ "recent_cards": 0, "repair_banner": false }),
        )
        .await
        .unwrap();
        assert_eq!(same, UiShape::default());
        assert!(!config_path.exists(), "形状没变不应落盘");

        set_ui_shape_with(&facade, json!({ "recent_cards": 2 }))
            .await
            .unwrap();
        // 换掉文件内容：之后若有一次落盘，这段内容就会被整份改写。
        let marker = br#"{"download_concurrency": 7}"#;
        std::fs::write(&config_path, marker).unwrap();
        for patch in [
            json!({ "recent_cards": 2 }),
            json!({ "repair_banner": false }),
            json!({}),
        ] {
            let shape = set_ui_shape_with(&facade, patch.clone()).await.unwrap();
            assert_eq!(
                shape,
                UiShape {
                    recent_cards: 2,
                    repair_banner: false,
                },
                "{patch}"
            );
        }
        assert_eq!(
            std::fs::read(&config_path).unwrap(),
            marker,
            "形状没变的写回不该改写配置文件"
        );
    }

    #[tokio::test]
    async fn failed_save_rolls_memory_back() {
        let dir = tempfile::tempdir().unwrap();
        // 让配置路径的「父目录」其实是个文件，原子写必然失败。
        let blocker = dir.path().join("not-a-dir");
        std::fs::write(&blocker, b"x").unwrap();
        let facade = facade_at(
            PetalfallConfig::default(),
            &blocker.join("config.json"),
            dir.path(),
        );

        let err = set_ui_shape_with(&facade, json!({ "recent_cards": 4 }))
            .await
            .unwrap_err();
        assert_eq!(err.code, code::IO);
        assert_eq!(
            facade.read().await.ui_shape(),
            UiShape::default(),
            "没存住的修改不应留在内存里"
        );

        // 没变的写回不落盘，存不进去也不报错。
        assert_eq!(
            set_ui_shape_with(&facade, json!({ "recent_cards": 0 }))
                .await
                .unwrap(),
            UiShape::default()
        );
    }
}
