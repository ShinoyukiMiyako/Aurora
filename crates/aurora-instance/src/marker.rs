//! 实例的「未完成」标记。
//!
//! 新建实例与修复实例都是长任务，中途可能失败、被取消，或者启动器被直接关掉。开始时在
//! `versions/<id>/.petalfall/incomplete.json` 写一份标记，成功后删除；没删掉就说明文件不完整。
//! 标记里记下是哪一类操作、结局如何，界面据此给出「安装没有完成：原因」「补全被取消」这类说明，
//! 修复时也据此决定是重新安装还是只补文件。

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::AURORA_META_DIR;
use crate::error::{Error, Result};

const MARKER_FILE: &str = "incomplete.json";

/// 新建实例时要装的东西，修复一个没装完的实例时照此重新安装。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct InstallSpec {
    /// 原版版本号。
    pub mc_version: String,
    /// 加载器（`fabric` / `quilt` / `forge` / `neoforge`），原版为 `None`。
    pub loader: Option<String>,
    /// 加载器版本；`None` 时安装器自选推荐版（仅 Fabric / Quilt 支持）。
    pub loader_version: Option<String>,
}

/// 未完成的是哪一类操作。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum IncompleteKind {
    /// 新建实例的安装。
    Install { spec: InstallSpec },
    /// 对已有实例补全文件。
    Repair,
}

/// 操作的结局。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum IncompleteOutcome {
    /// 开始后还没有记下结局：正在进行，或者启动器在进行中被关掉了。
    Pending,
    /// 失败。
    Failed,
    /// 被取消。
    Cancelled,
}

/// 失败时记下的错误（码与原文，与命令返回给前端的一致）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MarkerError {
    pub code: String,
    pub message: String,
}

/// 标记文件的内容。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct IncompleteMarker {
    #[serde(flatten)]
    pub kind: IncompleteKind,
    pub outcome: IncompleteOutcome,
    /// 操作开始的时刻（Unix 毫秒）。
    pub started_at: u64,
    pub error: Option<MarkerError>,
}

impl IncompleteMarker {
    /// 一次刚开始的操作。
    pub fn pending(kind: IncompleteKind, started_at: u64) -> Self {
        Self {
            kind,
            outcome: IncompleteOutcome::Pending,
            started_at,
            error: None,
        }
    }
}

/// 标记文件的读写句柄。
#[derive(Debug, Clone)]
pub struct MarkerStore {
    path: PathBuf,
}

impl MarkerStore {
    /// `version_dir/.petalfall/incomplete.json`。
    pub fn for_version_dir(version_dir: &Path) -> Self {
        Self {
            path: version_dir.join(AURORA_META_DIR).join(MARKER_FILE),
        }
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    /// 读取标记；没有标记返回 `None`，标记损坏冒泡（损坏的标记同样说明实例不完整，不能当作没有）。
    pub async fn load(&self) -> Result<Option<IncompleteMarker>> {
        match tokio::fs::read(&self.path).await {
            Ok(bytes) => serde_json::from_slice(&bytes)
                .map(Some)
                .map_err(|source| Error::Json {
                    context: "未完成标记",
                    path: self.path.clone(),
                    source,
                }),
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(source) => Err(Error::Io {
                path: self.path.clone(),
                source,
            }),
        }
    }

    /// 原子写入标记。
    pub async fn save(&self, marker: &IncompleteMarker) -> Result<()> {
        let bytes = serde_json::to_vec_pretty(marker).map_err(|source| Error::Json {
            context: "未完成标记",
            path: self.path.clone(),
            source,
        })?;
        aurora_base::fs::atomic_write(&self.path, &bytes).await?;
        Ok(())
    }

    /// 删除标记；本来就没有也算成功。
    pub async fn clear(&self) -> Result<()> {
        match tokio::fs::remove_file(&self.path).await {
            Ok(()) => Ok(()),
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(source) => Err(Error::Io {
                path: self.path.clone(),
                source,
            }),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn install_marker() -> IncompleteMarker {
        IncompleteMarker::pending(
            IncompleteKind::Install {
                spec: InstallSpec {
                    mc_version: "1.21.1".into(),
                    loader: Some("fabric".into()),
                    loader_version: Some("0.16.10".into()),
                },
            },
            1_700_000_000_000,
        )
    }

    #[tokio::test]
    async fn save_load_clear_round_trip() {
        let tmp = tempfile::tempdir().unwrap();
        let store = MarkerStore::for_version_dir(tmp.path());
        assert_eq!(store.load().await.unwrap(), None);

        let mut marker = install_marker();
        store.save(&marker).await.unwrap();
        assert_eq!(store.load().await.unwrap(), Some(marker.clone()));

        marker.outcome = IncompleteOutcome::Failed;
        marker.error = Some(MarkerError {
            code: "download_failed".into(),
            message: "补全本体与库 阶段有 1/3 个文件下载失败".into(),
        });
        store.save(&marker).await.unwrap();
        assert_eq!(store.load().await.unwrap(), Some(marker));

        store.clear().await.unwrap();
        assert_eq!(store.load().await.unwrap(), None);
        // 再清一次也不报错。
        store.clear().await.unwrap();
    }

    #[test]
    fn serialized_shape_is_flat_with_kind_tag() {
        let value = serde_json::to_value(install_marker()).unwrap();
        assert_eq!(value["kind"], "install");
        assert_eq!(value["spec"]["mc_version"], "1.21.1");
        assert_eq!(value["outcome"], "pending");
        assert_eq!(value["error"], serde_json::Value::Null);

        let repair = IncompleteMarker::pending(IncompleteKind::Repair, 1);
        let value = serde_json::to_value(repair).unwrap();
        assert_eq!(value["kind"], "repair");
        assert!(value.get("spec").is_none());
    }

    #[tokio::test]
    async fn corrupt_marker_is_an_error_not_absent() {
        let tmp = tempfile::tempdir().unwrap();
        let store = MarkerStore::for_version_dir(tmp.path());
        tokio::fs::create_dir_all(store.path().parent().unwrap())
            .await
            .unwrap();
        tokio::fs::write(store.path(), b"{").await.unwrap();
        assert!(matches!(
            store.load().await.unwrap_err(),
            Error::Json {
                context: "未完成标记",
                ..
            }
        ));
    }
}
