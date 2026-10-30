//! `versions/` 目录扫描与版本发现。
//!
//! 约定每个版本占一个子目录，目录名即版本 id，版本 JSON 为 `<id>/<id>.json`（原版启动器约定）。扫描把
//! 每个 JSON 解析为 [`VersionJson`] 并探测其加载器，产出 [`DiscoveredVersion`]；解析不了的目录（缺 JSON
//! 或 JSON 损坏）不静默丢弃，而是作为 [`BrokenVersion`] 单独列出，供上层归入「出错」类展示。
//!
//! 加载器探测与版本类型都取自「独立 JSON」本身（不解继承链）：加载器 JSON 自带其加载器库与 mainClass，
//! 探测成立；`type` 字段一般由加载器从原版拷入。继承解析与可用性检查归 aurora-version / aurora-launch。

use std::path::{Path, PathBuf};

use aurora_version::{LoaderInfo, VersionJson, detect_loaders};

use crate::VERSIONS_DIR;
use crate::error::{Error, Result};

/// 一个成功解析的已安装版本。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DiscoveredVersion {
    /// 版本 id（等于文件夹名）。
    pub id: String,
    /// 版本目录 `versions/<id>`。
    pub dir: PathBuf,
    /// 版本 JSON 路径 `versions/<id>/<id>.json`。
    pub json_path: PathBuf,
    /// 客户端 jar 期望路径 `versions/<id>/<id>.jar`（此处不校验其是否存在）。
    pub jar_path: PathBuf,
    /// 解析出的版本 JSON。
    pub json: VersionJson,
    /// 探测到的加载器（可能多个，如 Forge + OptiFine）。
    pub loaders: Vec<LoaderInfo>,
}

impl DiscoveredVersion {
    /// 是否装有任一 Mod 加载器。
    pub fn has_mod_loader(&self) -> bool {
        !self.loaders.is_empty()
    }

    /// 是否为正式版（`type == "release"`）。未知 / 缺失一律按非正式版处理（隔离时更保守）。
    pub fn is_release(&self) -> bool {
        self.json.release_type.as_deref() == Some("release")
    }
}

/// 一个无法正常解析的版本目录及其原因。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BrokenVersion {
    pub id: String,
    pub dir: PathBuf,
    pub reason: BrokenReason,
}

/// 版本目录解析失败的原因。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BrokenReason {
    /// 目录内缺少 `<id>.json`。
    MissingJson,
    /// `<id>.json` 存在但内容非法（非 UTF-8 或反序列化失败），携带具体错误说明。
    Parse(String),
}

/// 一次 `versions/` 扫描的完整结果：成功版本与出错版本各自成列，均按 id 升序稳定排列。
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct VersionScan {
    pub versions: Vec<DiscoveredVersion>,
    pub broken: Vec<BrokenVersion>,
}

/// 扫描 `mc_dir/versions/` 并解析全部版本。`versions/` 不存在时返回空结果（全新 `.minecraft` 的正常态）。
///
/// 单个版本 JSON 缺失或损坏计入 `broken`，不影响其它版本；只有读取 `versions/` 目录本身或读取一个
/// 确实存在的 JSON 文件时发生真实 IO 故障才向上冒泡。
pub async fn discover_versions(mc_dir: &Path) -> Result<VersionScan> {
    let versions_dir = mc_dir.join(VERSIONS_DIR);
    let mut names = match collect_version_dir_names(&versions_dir).await? {
        Some(names) => names,
        None => return Ok(VersionScan::default()),
    };
    // 稳定顺序：read_dir 的返回序不确定，按 id 排序让结果对展示/测试都可复现。
    names.sort_unstable();

    let mut scan = VersionScan::default();
    for id in names {
        let dir = versions_dir.join(&id);
        let json_path = dir.join(format!("{id}.json"));
        let jar_path = dir.join(format!("{id}.jar"));

        let bytes = match tokio::fs::read(&json_path).await {
            Ok(bytes) => bytes,
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
                scan.broken.push(BrokenVersion {
                    id,
                    dir,
                    reason: BrokenReason::MissingJson,
                });
                continue;
            }
            Err(source) => {
                return Err(Error::Io {
                    path: json_path,
                    source,
                });
            }
        };

        let text = match std::str::from_utf8(&bytes) {
            Ok(text) => text,
            Err(err) => {
                scan.broken.push(BrokenVersion {
                    id,
                    dir,
                    reason: BrokenReason::Parse(format!("版本 JSON 不是合法 UTF-8: {err}")),
                });
                continue;
            }
        };

        match VersionJson::from_json_str(text) {
            Ok(json) => {
                let loaders = detect_loaders(&json);
                scan.versions.push(DiscoveredVersion {
                    id,
                    dir,
                    json_path,
                    jar_path,
                    json,
                    loaders,
                });
            }
            Err(err) => {
                scan.broken.push(BrokenVersion {
                    id,
                    dir,
                    reason: BrokenReason::Parse(err.to_string()),
                });
            }
        }
    }
    Ok(scan)
}

/// 收集 `versions_dir` 下的子目录名（跳过普通文件与点开头的隐藏项）。
/// 目录不存在返回 `None`；其它 IO 故障向上冒泡。
async fn collect_version_dir_names(versions_dir: &Path) -> Result<Option<Vec<String>>> {
    let mut read = match tokio::fs::read_dir(versions_dir).await {
        Ok(read) => read,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(source) => {
            return Err(Error::Io {
                path: versions_dir.to_owned(),
                source,
            });
        }
    };

    let mut names = Vec::new();
    while let Some(entry) = read.next_entry().await.map_err(|source| Error::Io {
        path: versions_dir.to_owned(),
        source,
    })? {
        let file_type = entry.file_type().await.map_err(|source| Error::Io {
            path: entry.path(),
            source,
        })?;
        if !file_type.is_dir() {
            continue;
        }
        let name = entry.file_name().to_string_lossy().into_owned();
        // 点开头是启动器自身元数据目录（.petalfall）等，非游戏版本。
        if name.starts_with('.') {
            continue;
        }
        names.push(name);
    }
    Ok(Some(names))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 在 versions/<id>/<id>.json 落一份 JSON。
    async fn put_version(mc: &Path, id: &str, json: &str) {
        let dir = mc.join("versions").join(id);
        tokio::fs::create_dir_all(&dir).await.unwrap();
        tokio::fs::write(dir.join(format!("{id}.json")), json)
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn missing_versions_dir_yields_empty() {
        let tmp = tempfile::tempdir().unwrap();
        let scan = discover_versions(tmp.path()).await.unwrap();
        assert!(scan.versions.is_empty());
        assert!(scan.broken.is_empty());
    }

    #[tokio::test]
    async fn discovers_vanilla_fabric_and_snapshot_with_correct_facts() {
        let tmp = tempfile::tempdir().unwrap();
        let mc = tmp.path();

        put_version(
            mc,
            "1.21",
            r#"{"id":"1.21","type":"release","mainClass":"net.minecraft.client.main.Main",
                "libraries":[{"name":"org.lwjgl:lwjgl:3.3.3"}]}"#,
        )
        .await;
        put_version(
            mc,
            "fabric-loader-0.15.11-1.21",
            r#"{"id":"fabric-loader-0.15.11-1.21","inheritsFrom":"1.21","type":"release",
                "mainClass":"net.fabricmc.loader.impl.launch.knot.KnotClient",
                "libraries":[{"name":"net.fabricmc:fabric-loader:0.15.11"}]}"#,
        )
        .await;
        put_version(
            mc,
            "24w14a",
            r#"{"id":"24w14a","type":"snapshot","mainClass":"net.minecraft.client.main.Main",
                "libraries":[]}"#,
        )
        .await;

        let scan = discover_versions(mc).await.unwrap();
        assert!(scan.broken.is_empty());
        // 按 id 升序：24w14a < 1.21 < fabric-...（数字/字母序）。
        let ids: Vec<&str> = scan.versions.iter().map(|v| v.id.as_str()).collect();
        assert_eq!(ids, vec!["1.21", "24w14a", "fabric-loader-0.15.11-1.21"]);

        let vanilla = scan.versions.iter().find(|v| v.id == "1.21").unwrap();
        assert!(!vanilla.has_mod_loader());
        assert!(vanilla.is_release());
        assert_eq!(
            vanilla.jar_path,
            mc.join("versions").join("1.21").join("1.21.jar")
        );

        let fabric = scan
            .versions
            .iter()
            .find(|v| v.id == "fabric-loader-0.15.11-1.21")
            .unwrap();
        assert!(fabric.has_mod_loader());
        assert_eq!(fabric.loaders[0].version.as_deref(), Some("0.15.11"));
        assert!(fabric.is_release());

        let snapshot = scan.versions.iter().find(|v| v.id == "24w14a").unwrap();
        assert!(!snapshot.has_mod_loader());
        assert!(!snapshot.is_release());
    }

    #[tokio::test]
    async fn missing_and_corrupt_json_go_to_broken() {
        let tmp = tempfile::tempdir().unwrap();
        let mc = tmp.path();

        // 目录存在但缺 <id>.json。
        tokio::fs::create_dir_all(mc.join("versions").join("no-json"))
            .await
            .unwrap();
        // <id>.json 存在但内容损坏。
        put_version(mc, "broken", "{ this is not json }").await;

        let scan = discover_versions(mc).await.unwrap();
        assert!(scan.versions.is_empty());
        assert_eq!(scan.broken.len(), 2);

        let no_json = scan.broken.iter().find(|b| b.id == "no-json").unwrap();
        assert_eq!(no_json.reason, BrokenReason::MissingJson);

        let broken = scan.broken.iter().find(|b| b.id == "broken").unwrap();
        assert!(matches!(broken.reason, BrokenReason::Parse(_)));
    }

    #[tokio::test]
    async fn dot_directories_are_skipped() {
        let tmp = tempfile::tempdir().unwrap();
        let mc = tmp.path();
        // 启动器元数据目录不应被当成版本。
        tokio::fs::create_dir_all(mc.join("versions").join(crate::AURORA_META_DIR))
            .await
            .unwrap();
        put_version(
            mc,
            "1.21",
            r#"{"id":"1.21","type":"release","mainClass":"m"}"#,
        )
        .await;

        let scan = discover_versions(mc).await.unwrap();
        assert_eq!(scan.versions.len(), 1);
        assert!(scan.broken.is_empty());
    }
}
