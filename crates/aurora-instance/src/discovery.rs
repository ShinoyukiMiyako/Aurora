//! `versions/` 目录扫描与版本发现。
//!
//! 约定每个版本占一个子目录，目录名即版本 id，版本 JSON 为 `<id>/<id>.json`（原版启动器约定）。扫描把
//! 每个 JSON 解析为 [`VersionJson`] 并探测其加载器，产出 [`DiscoveredVersion`]；解析不了的目录（缺 JSON
//! 或 JSON 损坏）不静默丢弃，而是作为 [`BrokenVersion`] 单独列出，供上层归入「出错」类展示。
//!
//! 加载器探测与版本类型都取自「独立 JSON」本身（不解继承链）：加载器 JSON 自带其加载器库与 mainClass，
//! 探测成立；`type` 字段一般由加载器从原版拷入。继承解析与可用性检查归 aurora-version / aurora-launch。
//!
//! 版本 JSON 动辄几十到几百 KB，实例列表、启动、Mod 命令都要读它。两处省力：
//! - 只关心一个版本的调用走 [`discover_version`]，不为两个布尔值把所有版本 JSON 全量读一遍；
//! - 解析结果按「文件路径 + 大小 + 修改时间」缓存在进程内，文件没动过就不再读盘反序列化；
//!   全量扫描在阻塞线程池上有界并发地解析，不占异步 worker。

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, LazyLock, Mutex};
use std::time::SystemTime;

use aurora_version::{LoaderInfo, VersionJson, detect_loaders};
use tokio::task::JoinSet;

use crate::VERSIONS_DIR;
use crate::error::{Error, Result};

/// 全量扫描同时在阻塞线程池上解析的版本数。版本 JSON 读取是磁盘 IO、反序列化是 CPU，
/// 8 路足以把常见的几十个实例摊开，又不至于把 tokio 的阻塞线程池占满挤掉其它文件操作。
const SCAN_CONCURRENCY: usize = 8;

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

/// 单个版本目录的解析结果。外层 `Result` 只承载真实 IO 故障，
/// 「缺 JSON / JSON 坏了」不是故障而是一条 `Broken` 记录。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum VersionProbe {
    /// `Found` 装箱：`DiscoveredVersion` 内嵌整份 `VersionJson`，与只有几十字节的 `Broken`
    /// 放在一个裸枚举里会让每次返回都按大的那个搬运。
    Found(Box<DiscoveredVersion>),
    Broken(BrokenVersion),
}

/// 扫描 `mc_dir/versions/` 并解析全部版本。`versions/` 不存在时返回空结果（全新 `.minecraft` 的正常态）。
///
/// 单个版本 JSON 缺失或损坏计入 `broken`，不影响其它版本；只有读取 `versions/` 目录本身或读取一个
/// 确实存在的 JSON 文件时发生真实 IO 故障才向上冒泡。
pub async fn discover_versions(mc_dir: &Path) -> Result<VersionScan> {
    let versions_dir = mc_dir.join(VERSIONS_DIR);
    let Some(names) = list_version_dirs(mc_dir).await? else {
        return Ok(VersionScan::default());
    };

    let mut probes = Vec::with_capacity(names.len());
    let mut pending = names.into_iter();
    let mut running = JoinSet::new();
    loop {
        while running.len() < SCAN_CONCURRENCY {
            let Some(id) = pending.next() else { break };
            let dir = versions_dir.clone();
            running.spawn_blocking(move || probe_version_blocking(&dir, id));
        }
        let Some(joined) = running.join_next().await else {
            break;
        };
        let probe = joined.map_err(|join| Error::Io {
            path: versions_dir.clone(),
            source: std::io::Error::other(format!("版本解析任务异常结束: {join}")),
        })??;
        probes.push(probe);
    }

    let mut scan = VersionScan::default();
    for probe in probes {
        match probe {
            VersionProbe::Found(version) => scan.versions.push(*version),
            VersionProbe::Broken(broken) => scan.broken.push(broken),
        }
    }
    // 稳定顺序：并发解析的完成顺序不确定，按 id 排序让结果对展示/测试都可复现。
    scan.versions.sort_unstable_by(|a, b| a.id.cmp(&b.id));
    scan.broken.sort_unstable_by(|a, b| a.id.cmp(&b.id));

    let live: HashSet<PathBuf> = scan
        .versions
        .iter()
        .map(|v| v.json_path.clone())
        .chain(scan.broken.iter().map(|b| json_path_of(&b.dir, &b.id)))
        .collect();
    prune_cache(&versions_dir, &live);
    Ok(scan)
}

/// 只解析指定 id 的那一个版本，不碰 `versions/` 下的其它目录。
///
/// 「我只关心这一个版本装没装、带不带加载器」的调用（隔离判定、mods 目录解析）必须走这里：
/// 走 [`discover_versions`] 会为了两个布尔值把所有版本 JSON 全量读一遍反序列化一遍，
/// 版本目录一多就是纯粹的浪费。
///
/// 版本目录不存在、缺 JSON、JSON 损坏一律返回 `Ok(None)`——与 `discover_versions(..).versions`
/// 里 `find(|v| v.id == id)` 的语义逐字一致（损坏版本本就不在 `versions` 里），调用方据此
/// 报「未安装」。只有真实 IO 故障才向上冒泡。
pub async fn discover_version(mc_dir: &Path, id: &str) -> Result<Option<DiscoveredVersion>> {
    match probe_version(mc_dir, id).await? {
        VersionProbe::Found(version) => Ok(Some(*version)),
        VersionProbe::Broken(_) => Ok(None),
    }
}

/// 解析 `mc_dir/versions/<id>/` 这一个版本目录，损坏时带回原因（实例列表要展示它）。
///
/// 目录本身不存在时同样是 `Broken(MissingJson)`：调用方若需要区分「没有这个目录」，先查目录。
pub async fn probe_version(mc_dir: &Path, id: &str) -> Result<VersionProbe> {
    let versions_dir = mc_dir.join(VERSIONS_DIR);
    let id = id.to_owned();
    tokio::task::spawn_blocking(move || probe_version_blocking(&versions_dir, id))
        .await
        .map_err(|join| Error::Io {
            path: mc_dir.join(VERSIONS_DIR),
            source: std::io::Error::other(format!("版本解析任务异常结束: {join}")),
        })?
}

/// 列出 `mc_dir/versions/` 下的版本目录名（跳过普通文件与点开头的隐藏项），按名升序。
/// `versions/` 不存在返回 `None`；其它 IO 故障向上冒泡。
pub async fn list_version_dirs(mc_dir: &Path) -> Result<Option<Vec<String>>> {
    let versions_dir = mc_dir.join(VERSIONS_DIR);
    let mut read = match tokio::fs::read_dir(&versions_dir).await {
        Ok(read) => read,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(source) => {
            return Err(Error::Io {
                path: versions_dir,
                source,
            });
        }
    };

    let mut names = Vec::new();
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
        // 点开头是启动器自身元数据目录（.petalfall）等，非游戏版本。
        if name.starts_with('.') {
            continue;
        }
        names.push(name);
    }
    names.sort_unstable();
    Ok(Some(names))
}

fn json_path_of(dir: &Path, id: &str) -> PathBuf {
    dir.join(format!("{id}.json"))
}

/// 进程内的解析缓存：版本 JSON 路径 -> 上次读到时的大小、修改时间与解析结果。
///
/// 大小或修改时间任一变化即视为文件被改过，重新解析；两者都不变时复用。键是绝对路径，换游戏目录、
/// 重命名实例都会自然落到新键上，旧键在下一次全量扫描时清掉。
static PARSE_CACHE: LazyLock<Mutex<HashMap<PathBuf, CachedParse>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

#[derive(Clone)]
struct CachedParse {
    len: u64,
    modified: SystemTime,
    outcome: ParseOutcome,
}

#[derive(Clone)]
enum ParseOutcome {
    Parsed(Arc<(VersionJson, Vec<LoaderInfo>)>),
    Invalid(String),
}

fn cache_lock() -> std::sync::MutexGuard<'static, HashMap<PathBuf, CachedParse>> {
    // 缓存里只有不变的解析结果，持锁线程 panic 也不会留下写了一半的条目，毒化后照常使用。
    PARSE_CACHE
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

fn prune_cache(versions_dir: &Path, live: &HashSet<PathBuf>) {
    cache_lock().retain(|path, _| !path.starts_with(versions_dir) || live.contains(path));
}

/// 全量扫描与单版本查询共用这一处，避免两条路径对「什么算损坏」各有一套判断而悄悄分叉。
fn probe_version_blocking(versions_dir: &Path, id: String) -> Result<VersionProbe> {
    let dir = versions_dir.join(&id);
    let json_path = json_path_of(&dir, &id);
    let jar_path = dir.join(format!("{id}.jar"));

    let meta = match std::fs::metadata(&json_path) {
        Ok(meta) => meta,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
            return Ok(VersionProbe::Broken(BrokenVersion {
                id,
                dir,
                reason: BrokenReason::MissingJson,
            }));
        }
        Err(source) => {
            return Err(Error::Io {
                path: json_path,
                source,
            });
        }
    };
    let modified = meta.modified().map_err(|source| Error::Io {
        path: json_path.clone(),
        source,
    })?;
    let len = meta.len();

    let cached = cache_lock()
        .get(&json_path)
        .filter(|entry| entry.len == len && entry.modified == modified)
        .map(|entry| entry.outcome.clone());
    let outcome = match cached {
        Some(outcome) => outcome,
        None => {
            let outcome = parse_version_file(&json_path)?;
            cache_lock().insert(
                json_path.clone(),
                CachedParse {
                    len,
                    modified,
                    outcome: outcome.clone(),
                },
            );
            outcome
        }
    };

    Ok(match outcome {
        ParseOutcome::Parsed(parsed) => {
            let (json, loaders) = parsed.as_ref();
            VersionProbe::Found(Box::new(DiscoveredVersion {
                id,
                dir,
                json_path,
                jar_path,
                json: json.clone(),
                loaders: loaders.clone(),
            }))
        }
        ParseOutcome::Invalid(reason) => VersionProbe::Broken(BrokenVersion {
            id,
            dir,
            reason: BrokenReason::Parse(reason),
        }),
    })
}

fn parse_version_file(json_path: &Path) -> Result<ParseOutcome> {
    let bytes = std::fs::read(json_path).map_err(|source| Error::Io {
        path: json_path.to_owned(),
        source,
    })?;
    let text = match std::str::from_utf8(&bytes) {
        Ok(text) => text,
        Err(err) => {
            return Ok(ParseOutcome::Invalid(format!(
                "版本 JSON 不是合法 UTF-8: {err}"
            )));
        }
    };
    Ok(match VersionJson::from_json_str(text) {
        Ok(json) => {
            let loaders = detect_loaders(&json);
            ParseOutcome::Parsed(Arc::new((json, loaders)))
        }
        Err(err) => ParseOutcome::Invalid(err.to_string()),
    })
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
        assert_eq!(list_version_dirs(tmp.path()).await.unwrap(), None);
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
        // 非法 UTF-8 要如实报出，不能被替换字符悄悄吞掉后再解析。
        let bad = mc.join("versions").join("bad-utf8");
        tokio::fs::create_dir_all(&bad).await.unwrap();
        tokio::fs::write(bad.join("bad-utf8.json"), b"{\"id\":\"\xff\"}")
            .await
            .unwrap();

        let scan = discover_versions(mc).await.unwrap();
        assert!(scan.versions.is_empty());
        let ids: Vec<&str> = scan.broken.iter().map(|b| b.id.as_str()).collect();
        assert_eq!(ids, vec!["bad-utf8", "broken", "no-json"]);

        assert_eq!(scan.broken[2].reason, BrokenReason::MissingJson);
        assert!(matches!(scan.broken[1].reason, BrokenReason::Parse(_)));
        match &scan.broken[0].reason {
            BrokenReason::Parse(reason) => assert!(reason.contains("UTF-8"), "{reason}"),
            other => panic!("应为解析失败，实际 {other:?}"),
        }
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
        assert_eq!(
            list_version_dirs(mc).await.unwrap(),
            Some(vec!["1.21".to_owned()])
        );
    }

    /// 单版本查询与全量扫描里 `find(id)` 的结果必须逐字一致——这是把隔离解析从全量扫描
    /// 换成单版本读取的全部前提。一旦两边对「什么算可用版本」有分歧，工作目录就会开始漂移。
    #[tokio::test]
    async fn discover_version_matches_full_scan_lookup() {
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

        let scan = discover_versions(mc).await.unwrap();
        for id in ["1.21", "fabric-loader-0.15.11-1.21"] {
            let from_scan = scan.versions.iter().find(|v| v.id == id).cloned();
            let single = discover_version(mc, id).await.unwrap();
            assert_eq!(single, from_scan, "{id} 的单版本查询与全量扫描结果不一致");
        }

        let fabric = discover_version(mc, "fabric-loader-0.15.11-1.21")
            .await
            .unwrap()
            .unwrap();
        assert!(fabric.has_mod_loader());
        assert!(fabric.is_release());
    }

    #[tokio::test]
    async fn discover_version_treats_missing_and_broken_as_absent() {
        let tmp = tempfile::tempdir().unwrap();
        let mc = tmp.path();

        assert!(discover_version(mc, "ghost").await.unwrap().is_none());

        tokio::fs::create_dir_all(mc.join("versions").join("no-json"))
            .await
            .unwrap();
        assert!(discover_version(mc, "no-json").await.unwrap().is_none());

        // 与全量扫描一致地归入 broken，因此单版本查询同样视为「未安装」而不是抛错。
        put_version(mc, "corrupt", "{ not json at all").await;
        assert!(discover_version(mc, "corrupt").await.unwrap().is_none());
        match probe_version(mc, "corrupt").await.unwrap() {
            VersionProbe::Broken(b) => assert!(matches!(b.reason, BrokenReason::Parse(_))),
            other => panic!("应为损坏，实际 {other:?}"),
        }
    }

    /// 文件被改写（大小变化）后缓存必须失效，读到的是新内容；内容不变时复用缓存结果。
    #[tokio::test]
    async fn parse_cache_is_invalidated_when_the_file_changes() {
        let tmp = tempfile::tempdir().unwrap();
        let mc = tmp.path();
        put_version(mc, "x", r#"{"id":"x","type":"release","mainClass":"m"}"#).await;

        let first = discover_version(mc, "x").await.unwrap().unwrap();
        assert!(first.is_release());
        let json_path = first.json_path.clone();
        assert!(cache_lock().contains_key(&json_path), "解析后应写入缓存");

        put_version(
            mc,
            "x",
            r#"{"id":"x","type":"snapshot","mainClass":"main"}"#,
        )
        .await;
        let second = discover_version(mc, "x").await.unwrap().unwrap();
        assert!(!second.is_release(), "文件改了却读到旧的缓存结果");
        assert_eq!(second.json.main_class.as_deref(), Some("main"));
    }

    /// 全量扫描后，已不存在的版本目录对应的缓存条目被清掉，别的游戏目录的条目不受影响。
    #[tokio::test]
    async fn full_scan_prunes_cache_entries_of_removed_versions() {
        let a = tempfile::tempdir().unwrap();
        let b = tempfile::tempdir().unwrap();
        put_version(a.path(), "keep", r#"{"id":"keep","mainClass":"m"}"#).await;
        put_version(a.path(), "gone", r#"{"id":"gone","mainClass":"m"}"#).await;
        put_version(b.path(), "other", r#"{"id":"other","mainClass":"m"}"#).await;
        discover_versions(a.path()).await.unwrap();
        discover_versions(b.path()).await.unwrap();

        let gone_json = a.path().join("versions").join("gone").join("gone.json");
        let other_json = b.path().join("versions").join("other").join("other.json");
        assert!(cache_lock().contains_key(&gone_json));

        tokio::fs::remove_dir_all(a.path().join("versions").join("gone"))
            .await
            .unwrap();
        let scan = discover_versions(a.path()).await.unwrap();
        assert_eq!(scan.versions.len(), 1);
        assert!(
            !cache_lock().contains_key(&gone_json),
            "删掉的版本仍留在缓存里"
        );
        assert!(
            cache_lock().contains_key(&other_json),
            "别的游戏目录的缓存被误删"
        );
    }

    /// 并发解析的数量超过并发上限时结果依然完整、有序。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn full_scan_beyond_concurrency_limit_is_complete_and_sorted() {
        let tmp = tempfile::tempdir().unwrap();
        let total = SCAN_CONCURRENCY * 3 + 1;
        for i in 0..total {
            let id = format!("v{i:02}");
            put_version(
                tmp.path(),
                &id,
                &format!(r#"{{"id":"{id}","type":"release","mainClass":"m"}}"#),
            )
            .await;
        }
        let scan = discover_versions(tmp.path()).await.unwrap();
        let ids: Vec<String> = scan.versions.iter().map(|v| v.id.clone()).collect();
        let expected: Vec<String> = (0..total).map(|i| format!("v{i:02}")).collect();
        assert_eq!(ids, expected);
    }
}
