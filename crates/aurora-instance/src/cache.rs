//! 版本列表哈希缓存与增量刷新。
//!
//! 全量解析所有版本 JSON（[`crate::discovery::discover_versions`]）不便宜。做法：先廉价列出 `versions/`
//! 下的文件夹名，对排序后的名单算 sha1；与上次持久化的哈希一致就复用上次的版本列表，仅当名单变动或
//! 强制刷新时才重新全量解析。哈希用 sha1（跨进程稳定），故不能用 `DefaultHasher`（其稳定性无保证）。
//!
//! 缓存文件落在游戏目录内的 `<mc_dir>/.petalfall/version-list-cache.json`，随该 `.minecraft` 走。

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use sha1::{Digest, Sha1};

use crate::error::{Error, Result};
use crate::{AURORA_META_DIR, VERSIONS_DIR};

const CACHE_FILE: &str = "version-list-cache.json";

/// 持久化的版本列表缓存。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct VersionListCache {
    /// 排序后版本 id 名单的 sha1（小写十六进制）。
    pub hash: String,
    /// 生成该哈希时的版本 id 名单（已排序），便于诊断与复用。
    pub ids: Vec<String>,
}

/// 对版本 id 名单算哈希：先排序（消除 read_dir 顺序影响），以 `\n` 分隔喂入 sha1。
///
/// Windows 文件夹名不含换行，`\n` 作分隔无歧义。
pub fn hash_version_ids(ids: &[String]) -> String {
    let mut sorted: Vec<&str> = ids.iter().map(String::as_str).collect();
    sorted.sort_unstable();

    let mut hasher = Sha1::new();
    for (index, id) in sorted.iter().enumerate() {
        if index > 0 {
            hasher.update(b"\n");
        }
        hasher.update(id.as_bytes());
    }
    base16ct::lower::encode_string(&hasher.finalize())
}

/// 由当前名单构建缓存（内部会排序 ids 后落存）。
pub fn build_cache(ids: &[String]) -> VersionListCache {
    let mut sorted = ids.to_vec();
    sorted.sort_unstable();
    let hash = hash_version_ids(&sorted);
    VersionListCache { hash, ids: sorted }
}

/// 判定是否需要全量重解析：强制、无缓存、或名单哈希变化时为 true。
pub fn needs_full_reload(
    current_ids: &[String],
    cached: Option<&VersionListCache>,
    force: bool,
) -> bool {
    if force {
        return true;
    }
    match cached {
        None => true,
        Some(cache) => cache.hash != hash_version_ids(current_ids),
    }
}

/// 廉价列出 `mc_dir/versions/` 下的版本文件夹名（不读取任何 JSON），已按 id 升序排列。
/// 目录不存在返回空 Vec。用于哈希比对，避免每次都走全量解析。
pub async fn list_version_ids(mc_dir: &Path) -> Result<Vec<String>> {
    let versions_dir = mc_dir.join(VERSIONS_DIR);
    let mut read = match tokio::fs::read_dir(&versions_dir).await {
        Ok(read) => read,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(source) => {
            return Err(Error::Io {
                path: versions_dir,
                source,
            });
        }
    };

    let mut ids = Vec::new();
    while let Some(entry) = read.next_entry().await.map_err(|source| Error::Io {
        path: versions_dir.clone(),
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
        if name.starts_with('.') {
            continue;
        }
        ids.push(name);
    }
    ids.sort_unstable();
    Ok(ids)
}

/// 版本列表缓存文件的读写句柄。
#[derive(Debug, Clone)]
pub struct VersionCacheStore {
    path: PathBuf,
}

impl VersionCacheStore {
    /// 默认路径：`mc_dir/.petalfall/version-list-cache.json`。
    pub fn new(mc_dir: &Path) -> Self {
        Self {
            path: mc_dir.join(AURORA_META_DIR).join(CACHE_FILE),
        }
    }

    /// 指定缓存文件路径（测试注入）。
    pub fn at(path: impl Into<PathBuf>) -> Self {
        Self { path: path.into() }
    }

    /// 缓存文件路径。
    pub fn path(&self) -> &Path {
        &self.path
    }

    /// 读取缓存；文件缺失返回 `None`；存在但损坏则冒泡（不静默重置）。
    pub async fn load(&self) -> Result<Option<VersionListCache>> {
        match tokio::fs::read(&self.path).await {
            Ok(bytes) => {
                let cache = serde_json::from_slice(&bytes).map_err(|source| Error::Json {
                    context: "版本列表缓存",
                    path: self.path.clone(),
                    source,
                })?;
                Ok(Some(cache))
            }
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(source) => Err(Error::Io {
                path: self.path.clone(),
                source,
            }),
        }
    }

    /// 原子写入缓存。
    pub async fn save(&self, cache: &VersionListCache) -> Result<()> {
        let bytes = serde_json::to_vec_pretty(cache).map_err(|source| Error::Json {
            context: "版本列表缓存",
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

    fn ids(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn hash_is_order_independent_and_content_sensitive() {
        let a = hash_version_ids(&ids(&["1.21", "1.20.1", "fabric-1.21"]));
        let b = hash_version_ids(&ids(&["fabric-1.21", "1.21", "1.20.1"]));
        assert_eq!(a, b, "排序后应与输入顺序无关");

        let c = hash_version_ids(&ids(&["1.21", "1.20.1"]));
        assert_ne!(a, c, "名单变化必须改变哈希");

        // sha1 十六进制固定 40 位。
        assert_eq!(a.len(), 40);
        assert!(a.chars().all(|ch| ch.is_ascii_hexdigit()));
    }

    #[test]
    fn empty_list_hashes_to_sha1_of_empty_input() {
        // 空名单 = 空字节输入，sha1 已知向量。
        assert_eq!(
            hash_version_ids(&[]),
            "da39a3ee5e6b4b0d3255bfef95601890afd80709"
        );
    }

    #[test]
    fn needs_reload_logic() {
        let current = ids(&["1.21", "1.20.1"]);
        let matching = build_cache(&current);
        // 强制永远刷新。
        assert!(needs_full_reload(&current, Some(&matching), true));
        // 名单未变 + 有缓存 -> 复用。
        assert!(!needs_full_reload(&current, Some(&matching), false));
        // 无缓存 -> 刷新。
        assert!(needs_full_reload(&current, None, false));
        // 名单变化 -> 刷新。
        let changed = ids(&["1.21"]);
        assert!(needs_full_reload(&changed, Some(&matching), false));
    }

    #[test]
    fn build_cache_sorts_ids() {
        let cache = build_cache(&ids(&["c", "a", "b"]));
        assert_eq!(cache.ids, ids(&["a", "b", "c"]));
        assert_eq!(cache.hash, hash_version_ids(&ids(&["a", "b", "c"])));
    }

    #[tokio::test]
    async fn list_version_ids_returns_only_sorted_dirs() {
        let tmp = tempfile::tempdir().unwrap();
        let versions = tmp.path().join("versions");
        tokio::fs::create_dir_all(versions.join("1.21")).await.unwrap();
        tokio::fs::create_dir_all(versions.join("1.20.1")).await.unwrap();
        tokio::fs::create_dir_all(versions.join(AURORA_META_DIR)).await.unwrap();
        // 一个普通文件不应计入。
        tokio::fs::write(versions.join("readme.txt"), b"x").await.unwrap();

        let listed = list_version_ids(tmp.path()).await.unwrap();
        assert_eq!(listed, ids(&["1.20.1", "1.21"]));
    }

    #[tokio::test]
    async fn list_version_ids_missing_dir_is_empty() {
        let tmp = tempfile::tempdir().unwrap();
        assert!(list_version_ids(tmp.path()).await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn cache_store_round_trip_and_missing_is_none() {
        let tmp = tempfile::tempdir().unwrap();
        let store = VersionCacheStore::new(tmp.path());
        assert_eq!(
            store.path(),
            tmp.path()
                .join(".petalfall")
                .join("version-list-cache.json")
        );

        // 缺失 -> None。
        assert!(store.load().await.unwrap().is_none());

        let cache = build_cache(&ids(&["1.21", "1.20.1"]));
        store.save(&cache).await.unwrap();

        let loaded = store.load().await.unwrap().unwrap();
        assert_eq!(loaded, cache);
    }

    #[tokio::test]
    async fn corrupt_cache_file_errors_not_none() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("cache.json");
        tokio::fs::write(&path, b"{ not valid json").await.unwrap();
        let store = VersionCacheStore::at(&path);

        let err = store.load().await.unwrap_err();
        match err {
            Error::Json { context, .. } => assert_eq!(context, "版本列表缓存"),
            other => panic!("期望 Json 错误，得到 {other:?}"),
        }
    }
}
