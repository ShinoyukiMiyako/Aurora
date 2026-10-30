//! 版本级设置持久化（描述 / 图标 / 收藏 / 分类 / 隔离覆盖）。
//!
//! 每个版本可以有一份用户覆盖自动识别结果的设置，落在 `versions/<id>/.petalfall/settings.json`，随版本目录
//! 走（隔离开启时该文件天然位于版本自己的工作目录内）。缺文件表示「未自定义」，返回默认值；文件存在但
//! 损坏则冒泡为错误（不静默重置，以免悄悄丢失用户的收藏/描述）。

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::AURORA_META_DIR;
use crate::error::{Error, Result};
use crate::isolation::IsolationOverride;

const SETTINGS_FILE: &str = "settings.json";

/// 一个版本的用户自定义设置。所有字段可选，缺省即「跟随自动识别 / 未收藏」。
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
pub struct VersionSettings {
    /// 自定义描述（覆盖自动识别的版本描述）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    /// 自定义图标标识（覆盖按加载器/版本类型推断的默认图标）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub icon: Option<String>,
    /// 是否收藏。
    #[serde(default, skip_serializing_if = "is_false")]
    pub favorite: bool,
    /// 自定义分类名（覆盖自动分组）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub category: Option<String>,
    /// 版本级隔离覆盖（默认跟随全局）。
    #[serde(default, skip_serializing_if = "IsolationOverride::is_follow_global")]
    pub isolation: IsolationOverride,
}

/// serde 跳过条件：布尔为 false 时不写入，保持配置文件精简。
fn is_false(value: &bool) -> bool {
    !*value
}

/// 版本设置文件的读写句柄。
#[derive(Debug, Clone)]
pub struct VersionSettingsStore {
    path: PathBuf,
}

impl VersionSettingsStore {
    /// 默认路径：`version_dir/.petalfall/settings.json`（`version_dir` 即 `versions/<id>`）。
    pub fn for_version_dir(version_dir: &Path) -> Self {
        Self {
            path: version_dir.join(AURORA_META_DIR).join(SETTINGS_FILE),
        }
    }

    /// 指定设置文件路径（测试注入）。
    pub fn at(path: impl Into<PathBuf>) -> Self {
        Self { path: path.into() }
    }

    /// 设置文件路径。
    pub fn path(&self) -> &Path {
        &self.path
    }

    /// 读取设置；文件缺失返回默认值；存在但损坏则冒泡。
    pub async fn load(&self) -> Result<VersionSettings> {
        match tokio::fs::read(&self.path).await {
            Ok(bytes) => serde_json::from_slice(&bytes).map_err(|source| Error::Json {
                context: "版本设置",
                path: self.path.clone(),
                source,
            }),
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
                Ok(VersionSettings::default())
            }
            Err(source) => Err(Error::Io {
                path: self.path.clone(),
                source,
            }),
        }
    }

    /// 原子写入设置。
    pub async fn save(&self, settings: &VersionSettings) -> Result<()> {
        let bytes = serde_json::to_vec_pretty(settings).map_err(|source| Error::Json {
            context: "版本设置",
            path: self.path.clone(),
            source,
        })?;
        aurora_base::fs::atomic_write(&self.path, &bytes).await?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_settings_serialize_to_empty_object() {
        // 全默认时所有字段都被跳过，得到空对象，配置文件保持精简。
        let json = serde_json::to_string(&VersionSettings::default()).unwrap();
        assert_eq!(json, "{}");
    }

    #[test]
    fn favorite_and_isolation_only_serialize_when_non_default() {
        let settings = VersionSettings {
            favorite: true,
            isolation: IsolationOverride::Enabled,
            description: Some("我的生存存档专用".into()),
            ..Default::default()
        };
        let value: serde_json::Value = serde_json::to_value(&settings).unwrap();
        assert_eq!(value["favorite"], serde_json::json!(true));
        assert_eq!(value["isolation"], serde_json::json!("enabled"));
        assert_eq!(value["description"], serde_json::json!("我的生存存档专用"));
        // 未设置的字段不出现。
        assert!(value.get("icon").is_none());
        assert!(value.get("category").is_none());
    }

    #[tokio::test]
    async fn missing_file_loads_default() {
        let tmp = tempfile::tempdir().unwrap();
        let store = VersionSettingsStore::for_version_dir(tmp.path());
        assert_eq!(
            store.path(),
            tmp.path().join(".petalfall").join("settings.json")
        );
        assert_eq!(store.load().await.unwrap(), VersionSettings::default());
    }

    #[tokio::test]
    async fn round_trip_preserves_values() {
        let tmp = tempfile::tempdir().unwrap();
        let store = VersionSettingsStore::for_version_dir(tmp.path());

        let settings = VersionSettings {
            description: Some("测试整合包".into()),
            icon: Some("Command_Block".into()),
            favorite: true,
            category: Some("整合包".into()),
            isolation: IsolationOverride::Disabled,
        };
        store.save(&settings).await.unwrap();

        assert_eq!(store.load().await.unwrap(), settings);
    }

    #[tokio::test]
    async fn corrupt_settings_file_errors() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("settings.json");
        tokio::fs::write(&path, b"{ broken").await.unwrap();
        let store = VersionSettingsStore::at(&path);

        let err = store.load().await.unwrap_err();
        match err {
            Error::Json { context, .. } => assert_eq!(context, "版本设置"),
            other => panic!("期望 Json 错误，得到 {other:?}"),
        }
    }
}
