//! 材质源的选择：在候选游戏目录里找一个可信的原版客户端 jar。
//!
//! 只认没有继承（不是加载器版本）、类型为 release、jar 的 SHA-1 与版本 JSON 声明一致的版本：加载器
//! 版本的 jar 可能是空壳或被改过，快照的材质还没定稿，哈希不符说明文件被动过。按发布时间从新到旧，
//! 取第一个含 1.20 材质集标志的；一个都没有时退而取最新的、至少有扁平化方块路径的作降级源。

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::SystemTime;

use petalfall_instance::discover_versions;

use super::whitelist::{DEGRADED_SET_MARKER, FULL_SET_MARKER, jar_entry};

/// 打开 jar 的函数。生产就是 `File::open`；测试注入计数版本，验证请求路径不碰 jar。
pub type JarOpener = Arc<dyn Fn(&Path) -> std::io::Result<std::fs::File> + Send + Sync>;

pub fn default_opener() -> JarOpener {
    Arc::new(|path| std::fs::File::open(path))
}

/// 选中的材质源。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SelectedSource {
    pub version_id: String,
    pub jar: PathBuf,
    pub jar_sha1: String,
    /// 是否含完整的 1.20 材质集；否则是降级源，名单里缺的方块由前端画徽记。
    pub full: bool,
    /// jar 所在的候选游戏目录：方块的中文名到它的 assets 里按资源索引找。
    pub game_dir: PathBuf,
    /// 版本 JSON 里的资源索引 id；没有时方块名只有英文。
    pub asset_index: Option<String>,
}

/// jar 的 SHA-1 校验结果缓存，键为（路径、大小、修改时间）：三者都没变就不重算。
#[derive(Debug, Default)]
pub struct JarHashCache {
    entries: HashMap<PathBuf, (u64, SystemTime, String)>,
}

impl JarHashCache {
    async fn sha1(&mut self, jar: &Path) -> Result<String, String> {
        let meta = tokio::fs::metadata(jar)
            .await
            .map_err(|e| format!("读取 jar 元数据失败：{e}"))?;
        let modified = meta
            .modified()
            .map_err(|e| format!("读取 jar 修改时间失败：{e}"))?;
        if let Some((len, time, sha1)) = self.entries.get(jar)
            && *len == meta.len()
            && *time == modified
        {
            return Ok(sha1.clone());
        }
        let sha1 = petalfall_base::fs::sha1_hex(jar)
            .await
            .map_err(|e| format!("计算 jar 的 SHA-1 失败：{e}"))?;
        self.entries
            .insert(jar.to_owned(), (meta.len(), modified, sha1.clone()));
        Ok(sha1)
    }
}

/// 一个满足「无继承、release、有 jar 与声明哈希」的候选版本。
struct Candidate {
    id: String,
    release_time: String,
    jar: PathBuf,
    expected_sha1: String,
    /// 候选目录的先后（越小越优先），发布时间相同时用它定序。
    dir_rank: usize,
    game_dir: PathBuf,
    asset_index: Option<String>,
}

/// 在候选目录里选材质源。任何单个目录或版本读不了都只记 warn 并跳过，不影响其余候选。
pub async fn select_source(
    candidates: &[PathBuf],
    opener: &JarOpener,
    hashes: &mut JarHashCache,
) -> Option<SelectedSource> {
    let mut versions = Vec::new();
    for (dir_rank, dir) in candidates.iter().enumerate() {
        let scan = match discover_versions(dir).await {
            Ok(scan) => scan,
            Err(err) => {
                tracing::warn!(dir = %dir.display(), error = %err, "扫描候选游戏目录失败，跳过它");
                continue;
            }
        };
        for version in scan.versions {
            let json = &version.json;
            if json.inherits_from.is_some() || json.release_type.as_deref() != Some("release") {
                continue;
            }
            let (Some(release_time), Some(client)) = (
                json.release_time.clone(),
                json.downloads.as_ref().and_then(|d| d.client.as_ref()),
            ) else {
                continue;
            };
            match tokio::fs::try_exists(&version.jar_path).await {
                Ok(true) => {}
                Ok(false) => continue,
                Err(err) => {
                    tracing::warn!(version = %version.id, error = %err, "无法确认客户端 jar 是否存在，跳过该版本");
                    continue;
                }
            }
            versions.push(Candidate {
                id: version.id.clone(),
                release_time,
                jar: version.jar_path.clone(),
                expected_sha1: client.sha1.to_ascii_lowercase(),
                dir_rank,
                game_dir: dir.clone(),
                asset_index: json.asset_index.as_ref().map(|index| index.id.clone()),
            });
        }
    }
    // 官方版本 JSON 的 releaseTime 都是同一种带时区的 ISO 8601 写法（+00:00），字典序即时间序。
    versions.sort_by(|a, b| {
        b.release_time
            .cmp(&a.release_time)
            .then(a.dir_rank.cmp(&b.dir_rank))
    });

    let mut degraded = Vec::new();
    for candidate in &versions {
        let markers = match jar_markers(opener, &candidate.jar).await {
            Ok(markers) => markers,
            Err(reason) => {
                tracing::warn!(version = %candidate.id, jar = %candidate.jar.display(), %reason, "读取客户端 jar 失败，跳过该版本");
                continue;
            }
        };
        if markers.full {
            if verify(hashes, candidate).await {
                return Some(selected(candidate, true));
            }
        } else if markers.degraded {
            degraded.push(candidate);
        }
    }
    for candidate in degraded {
        if verify(hashes, candidate).await {
            return Some(selected(candidate, false));
        }
    }
    None
}

fn selected(candidate: &Candidate, full: bool) -> SelectedSource {
    SelectedSource {
        version_id: candidate.id.clone(),
        jar: candidate.jar.clone(),
        jar_sha1: candidate.expected_sha1.clone(),
        full,
        game_dir: candidate.game_dir.clone(),
        asset_index: candidate.asset_index.clone(),
    }
}

async fn verify(hashes: &mut JarHashCache, candidate: &Candidate) -> bool {
    match hashes.sha1(&candidate.jar).await {
        Ok(actual) if actual == candidate.expected_sha1 => true,
        Ok(actual) => {
            tracing::warn!(version = %candidate.id, expected = %candidate.expected_sha1, %actual, "客户端 jar 的 SHA-1 与版本 JSON 不符，跳过该版本");
            false
        }
        Err(reason) => {
            tracing::warn!(version = %candidate.id, %reason, "校验客户端 jar 失败，跳过该版本");
            false
        }
    }
}

struct Markers {
    full: bool,
    degraded: bool,
}

/// 只读 zip 中央目录，看两个标志文件在不在；读完即关闭，不长期持有 jar 句柄。
async fn jar_markers(opener: &JarOpener, jar: &Path) -> Result<Markers, String> {
    let opener = opener.clone();
    let jar = jar.to_owned();
    tokio::task::spawn_blocking(move || {
        let file = opener(&jar).map_err(|e| format!("打开 jar 失败：{e}"))?;
        let archive = zip::ZipArchive::new(file).map_err(|e| format!("不是合法的 zip：{e}"))?;
        Ok(Markers {
            full: archive
                .index_for_name(&jar_entry(FULL_SET_MARKER))
                .is_some(),
            degraded: archive
                .index_for_name(&jar_entry(DEGRADED_SET_MARKER))
                .is_some(),
        })
    })
    .await
    .map_err(|e| format!("后台任务异常结束：{e}"))?
}
