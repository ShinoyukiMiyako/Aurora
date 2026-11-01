//! 本地已装模组管理：扫描 `mods/` 目录、读取 jar 内元数据、启用/禁用切换。
//!
//! 支持四种元数据格式：Fabric 的 `fabric.mod.json`（jar 根）、Quilt 的 `quilt.mod.json`（jar 根）、
//! Forge 的 `META-INF/mods.toml`、NeoForge 的 `META-INF/neoforge.mods.toml`。启禁状态以文件名
//! `.disabled` 后缀表达（[`DISABLED_SUFFIX`] 是这条约定的唯一出处，上层一律引用它）。jar 即 zip，
//! 读取走 spawn_blocking 避免阻塞异步 worker。

use std::collections::{BTreeMap, HashSet};
use std::io::Read;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::error::{Error, Result};
use crate::model::ModLoader;

/// 元数据来源格式。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MetadataFormat {
    /// Fabric 的 `fabric.mod.json`。
    Fabric,
    /// Quilt 的 `quilt.mod.json`。
    QuiltModJson,
    /// Forge 的 `META-INF/mods.toml`。
    ForgeToml,
    /// NeoForge 的 `META-INF/neoforge.mods.toml`。
    NeoForgeToml,
}

/// 从 jar 解析出的模组元数据。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ModMetadata {
    /// 模组 id。
    pub mod_id: String,
    /// 展示名。
    pub name: Option<String>,
    /// 版本号（Forge/NeoForge 可能是 `${file.jarVersion}` 占位符，原样保留）。
    pub version: Option<String>,
    /// 描述。
    pub description: Option<String>,
    /// 作者列表。
    pub authors: Vec<String>,
    /// 声明的依赖 mod id 列表：Fabric 取 `depends` 的键，Forge/NeoForge 取
    /// `[[dependencies.<modid>]]` 中必需的项，Quilt 取 `quilt_loader.depends` 的非可选项。
    /// 含 `minecraft` / `fabricloader` / `java` 这类平台伪 mod——这里是依赖声明的原样索引，
    /// 要不要过滤由使用方按场景决定。
    #[serde(default)]
    pub depends: Vec<String>,
    /// 声明支持的 MC 版本约束原文（Fabric `depends.minecraft`、Forge/NeoForge 依赖里
    /// `minecraft` 的 `versionRange`、Quilt `minecraft` 依赖的 `versions`）；取不到为 `None`。
    #[serde(default)]
    pub minecraft_version: Option<String>,
    /// 描述文件声明的图标在 jar 内的条目路径（Fabric / Quilt 的 `icon`、Forge / NeoForge 的
    /// `logoFile`）；声明了多个尺寸时取最大的一张。没声明为 `None`。
    #[serde(default)]
    pub icon: Option<String>,
    /// 所属加载器。
    pub loader: ModLoader,
    /// 元数据来源格式。
    pub format: MetadataFormat,
}

/// 一个已装模组条目。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct InstalledMod {
    /// 磁盘路径。
    pub path: PathBuf,
    /// 磁盘上的文件名（可能带 `.disabled` 后缀）。
    pub file_name: String,
    /// 是否启用（无 `.disabled` 后缀）。
    pub enabled: bool,
    /// 文件字节数，取自目录枚举时顺带拿到的元数据，不额外 stat。
    pub size: u64,
    /// 文件修改时刻（UNIX 毫秒，早于纪元为负）。与 `size` 一起构成「这个文件变没变」的判据，
    /// 上层据此给 jar 内图标之类的派生资源做缓存失效。
    pub modified_ms: i64,
    /// 解析出的元数据；无可识别描述文件或不是合法 jar 时为 `None`。
    pub metadata: Option<ModMetadata>,
}

const FABRIC_DESCRIPTOR: &str = "fabric.mod.json";
const QUILT_DESCRIPTOR: &str = "quilt.mod.json";
const FORGE_DESCRIPTOR: &str = "META-INF/mods.toml";
const NEOFORGE_DESCRIPTOR: &str = "META-INF/neoforge.mods.toml";
/// 禁用态模组的文件名后缀：启禁以给文件名追加 / 去掉它实现，卷宗与历史的 join 键都是去掉它之后的名字。
pub const DISABLED_SUFFIX: &str = ".disabled";
/// 各格式里表示「原版游戏本体」的依赖 id，用来抽出 MC 版本约束。
const MINECRAFT_DEPENDENCY_ID: &str = "minecraft";

/// 文件名是否是（启用或禁用态的）模组 jar。
fn is_mod_file(name: &str) -> bool {
    let base = name.strip_suffix(DISABLED_SUFFIX).unwrap_or(name);
    base.ends_with(".jar")
}

/// 文件名是否为禁用态（带 `.disabled` 后缀）。
pub fn is_disabled(name: &str) -> bool {
    name.ends_with(DISABLED_SUFFIX)
}

/// 同时解析的 jar 数上限。
///
/// 单个 jar 的成本是「开文件 + 读完整份 zip 中央目录 + 解压一个小条目」，IO 与 CPU 各占一半，
/// 所以既不能按核数拉满（机械盘上并发开文件只会让磁头来回甩），也不能只开一路（整合包动辄上百个
/// jar，串行就是上百次首尾相接的随机读）。取核数并夹到 [4, 16]：下界保证双核机器也能重叠掉 IO 等待，
/// 上界避免在高核工作站上把阻塞线程池和磁盘队列同时打满。
fn scan_concurrency() -> usize {
    std::thread::available_parallelism()
        .map(|n| n.get())
        // 核数查不出来（受限容器）时按下界走：这只是并发度调优，不影响结果正确性。
        .unwrap_or(4)
        .clamp(4, 16)
}

/// 扫描 `mods/` 目录，返回所有模组条目（按文件名排序，结果稳定）。
///
/// 单个 jar 元数据解析失败不会中断整轮扫描：记 `warn` 日志并把该条以「无元数据」列出——一个损坏
/// 模组不应让整份列表瞎掉。目录本身不可读才向上冒泡。
///
/// 不带缓存的版本，等价于 `scan_mods_dir_cached(dir, None)`。能拿到缓存文件路径的调用方一律走
/// [`scan_mods_dir_cached`]：本函数每次都要把每个 jar 重开一遍。
pub async fn scan_mods_dir(dir: impl AsRef<Path>) -> Result<Vec<InstalledMod>> {
    scan_mods_dir_cached(dir, None).await
}

/// 扫描 `mods/` 目录，可选复用磁盘上的元数据缓存。
///
/// 缓存以「文件名 + 大小 + 修改时间」为判据，三者一致就直接复用上次的解析结果，不再开 zip。
/// mods 目录的变更频率极低（装/删 Mod 才变），所以稳态下这一轮的 zip 解析次数是 0。
/// `cache_path` 为 `None` 时退化成全量解析。解析失败的结果里，描述文件损坏这类确定性的照样缓存，
/// 打不开文件这类读盘故障不缓存（见 [`is_transient_read_failure`]），下一轮重新解析。
pub async fn scan_mods_dir_cached(
    dir: impl AsRef<Path>,
    cache_path: Option<&Path>,
) -> Result<Vec<InstalledMod>> {
    let dir = dir.as_ref().to_owned();

    // 目录枚举整个放进一次 spawn_blocking：Windows 上 std 的 DirEntry 会把 FindNextFileW 顺带返回的
    // 元数据缓存下来，file_type 与 metadata 都不再额外走一次系统调用。若改用 tokio::fs::read_dir，
    // 每个 entry 的 metadata() 都是一次独立的 spawn_blocking + stat，上百个 jar 就是上百次无谓往返。
    let candidates = {
        let dir = dir.clone();
        tokio::task::spawn_blocking(move || list_mod_candidates_blocking(&dir))
            .await
            .map_err(|source| Error::Base(aurora_base::Error::HashTaskJoin(source)))??
    };

    let cache = match cache_path {
        Some(path) => load_metadata_cache(path).await,
        None => ModMetadataCache::default(),
    };

    // 先按缓存判据分流：命中的直接定案，未命中的才排队去开 zip。
    // 候选项与解析结果成对留到最后——重建缓存要的是判据，而判据只在候选项上，
    // 不能为此往过 IPC 的 InstalledMod 上加字段。
    let mut resolved: Vec<Option<(ModCandidate, Option<ModMetadata>)>> =
        Vec::with_capacity(candidates.len());
    let mut pending: Vec<(usize, ModCandidate)> = Vec::new();
    for (index, candidate) in candidates.into_iter().enumerate() {
        match cache.hit(&candidate) {
            Some(metadata) => resolved.push(Some((candidate, metadata))),
            None => {
                resolved.push(None);
                pending.push((index, candidate));
            }
        }
    }

    let miss_count = pending.len();
    // 本轮读盘失败的文件：照常按无元数据列出，但不进缓存，下一轮重新解析。
    let mut transient: HashSet<String> = HashSet::new();
    let limit = scan_concurrency();
    let mut queue = pending.into_iter();
    let mut set: tokio::task::JoinSet<(usize, ModCandidate, Result<Option<ModMetadata>>)> =
        tokio::task::JoinSet::new();

    // 固定窗口的有界并发：先灌满 limit 个，之后每回收一个就补一个，全程在飞的任务数不超过 limit。
    for (index, candidate) in queue.by_ref().take(limit) {
        spawn_metadata_task(&mut set, index, candidate);
    }
    while let Some(joined) = set.join_next().await {
        let (index, candidate, outcome) =
            joined.map_err(|source| Error::Base(aurora_base::Error::HashTaskJoin(source)))?;
        let metadata = match outcome {
            Ok(metadata) => metadata,
            Err(error) => {
                let retry_next_scan = is_transient_read_failure(&error);
                tracing::warn!(
                    path = %candidate.path.display(),
                    error = %error,
                    retry_next_scan,
                    "解析模组元数据失败，按无元数据列出"
                );
                if retry_next_scan {
                    transient.insert(candidate.file_name.clone());
                }
                None
            }
        };
        resolved[index] = Some((candidate, metadata));
        if let Some((next_index, next_candidate)) = queue.next() {
            spawn_metadata_task(&mut set, next_index, next_candidate);
        }
    }

    // 每个下标都在上面两条路径之一里被填过，这里 expect 是对该不变量的断言而非兜底。
    let mut entries: Vec<(ModCandidate, Option<ModMetadata>)> = resolved
        .into_iter()
        .map(|slot| slot.expect("每个候选项要么命中缓存要么被解析，不存在空洞"))
        .collect();
    entries.sort_by(|a, b| a.0.file_name.cmp(&b.0.file_name));

    if let Some(path) = cache_path {
        // 按本轮实际结果重建缓存，顺带把已删除 jar 的旧条目清掉。内容没变就不写盘，避免每次进页面
        // 都白白 fsync 一次。
        let next = ModMetadataCache::build(
            entries
                .iter()
                .filter(|(candidate, _)| !transient.contains(&candidate.file_name)),
        );
        if next != cache {
            save_metadata_cache(path, &next).await;
        }
    }

    tracing::debug!(
        dir = %dir.display(),
        total = entries.len(),
        parsed = miss_count,
        cached = entries.len().saturating_sub(miss_count),
        "mods 目录扫描完成"
    );
    Ok(entries
        .into_iter()
        .map(|(candidate, metadata)| candidate.into_installed(metadata))
        .collect())
}

/// 这次解析失败是不是换个时机就可能好的读盘故障。
///
/// 打不开文件（被杀毒软件或别的启动器独占、权限一时不对、扫描途中被移走）属于这一类：把它当成「没有
/// 元数据」缓存下来，这个 jar 在文件被改动之前会一直显示为无元数据。zip 读出的 io 错误里，数据本身
/// 坏掉的三种（校验和不对、压缩流损坏、文件被截断）对同一份字节每次都一样，与描述文件内容损坏一样
/// 是确定性的结果，可以缓存。
///
/// 打开失败与 zip 读出的 io 错误按同一条线分：描述文件内容不对也会以 io 错误报出（mods.toml 不是合法
/// UTF-8 时报 `InvalidData`），只看错误类别的话，这个 jar 每一轮扫描都会被重开重解析。
fn is_transient_read_failure(error: &Error) -> bool {
    let source = match error {
        Error::Base(aurora_base::Error::Io { source, .. }) => source,
        Error::Zip {
            source: zip::result::ZipError::Io(source),
            ..
        } => source,
        _ => return false,
    };
    !matches!(
        source.kind(),
        std::io::ErrorKind::InvalidData
            | std::io::ErrorKind::InvalidInput
            | std::io::ErrorKind::UnexpectedEof
    )
}

/// 把一个待解析项投进阻塞线程池。任务把候选项一并带回，省得再按下标回查。
fn spawn_metadata_task(
    set: &mut tokio::task::JoinSet<(usize, ModCandidate, Result<Option<ModMetadata>>)>,
    index: usize,
    candidate: ModCandidate,
) {
    set.spawn_blocking(move || {
        let outcome = extract_metadata_blocking(&candidate.path);
        (index, candidate, outcome)
    });
}

/// 一个待解析的 jar。目录枚举阶段就把缓存判据一次取齐，后面不再回盘 stat。
#[derive(Debug, Clone)]
struct ModCandidate {
    path: PathBuf,
    file_name: String,
    enabled: bool,
    stamp: FileStamp,
}

impl ModCandidate {
    fn into_installed(self, metadata: Option<ModMetadata>) -> InstalledMod {
        InstalledMod {
            path: self.path,
            file_name: self.file_name,
            enabled: self.enabled,
            size: self.stamp.size,
            modified_ms: self.stamp.mtime_ms,
            metadata,
        }
    }
}

/// 缓存判据：文件大小与修改时间（UNIX 毫秒）。
///
/// 不用内容哈希：算哈希要把整个 jar 读一遍，而本缓存要省的恰恰就是读盘。大小加修改时间对
/// 「玩家换了个 Mod 版本」这种真实变更已经足够灵敏——同名、同字节数、同修改时间却内容不同的
/// jar，实际上只能靠人为构造。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
struct FileStamp {
    size: u64,
    mtime_ms: i64,
}

impl FileStamp {
    fn from_metadata(meta: &std::fs::Metadata) -> std::io::Result<Self> {
        Ok(Self {
            size: meta.len(),
            mtime_ms: unix_millis(meta.modified()?),
        })
    }
}

/// 把修改时刻换算成 UNIX 毫秒；早于纪元的坏时间戳记为负数。
///
/// 用有符号数如实表达而不是压成 0：压成 0 会让所有坏时间戳的文件共享同一个判据，替换文件后可能吃到
/// 别人的缓存。
fn unix_millis(time: std::time::SystemTime) -> i64 {
    match time.duration_since(std::time::UNIX_EPOCH) {
        Ok(after) => i64::try_from(after.as_millis()).unwrap_or(i64::MAX),
        Err(before) => i64::try_from(before.duration().as_millis())
            .map(|ms| -ms)
            .unwrap_or(i64::MIN),
    }
}

/// Mod 元数据缓存：文件名 -> （判据 + 上次解析结果）。
///
/// 这是纯派生数据，丢了最多是重解析一轮，所以读写一律不让错误冒泡（见 [`load_metadata_cache`] /
/// [`save_metadata_cache`]）——为了一份可以随时重建的缓存把整个 Mod 列表打挂，是得不偿失的。
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
struct ModMetadataCache {
    /// 缓存格式版本。元数据结构加了字段时提升它：旧缓存里的条目没有新字段，若照常命中，新字段会
    /// 一直是空值直到文件被改动——版本对不上就整份作废、全量重解析一轮。解析规则放宽时同样要提升：
    /// 解析失败也会按「无元数据」缓存，旧结果不作废，新规则对没改动过的 jar 永远不生效。
    #[serde(default)]
    schema: u32,
    entries: BTreeMap<String, CacheEntry>,
}

/// 当前缓存格式版本，见 [`ModMetadataCache::schema`]。
const CACHE_SCHEMA: u32 = 2;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
struct CacheEntry {
    stamp: FileStamp,
    /// 上次的解析结果。`None`（这个 jar 没有可识别的描述文件）同样要缓存，
    /// 否则每次扫描都得为它重开一次 zip——而没有描述文件的 jar 恰恰要把整份中央目录翻到底才能确定。
    metadata: Option<ModMetadata>,
}

impl ModMetadataCache {
    /// 判据完全一致才算命中，返回上次的解析结果。
    fn hit(&self, candidate: &ModCandidate) -> Option<Option<ModMetadata>> {
        let entry = self.entries.get(&candidate.file_name)?;
        (entry.stamp == candidate.stamp).then(|| entry.metadata.clone())
    }

    /// 按本轮扫描结果重建。只收本轮真实存在的文件，已删除 jar 的旧条目因此自动消失。
    fn build<'a>(
        entries: impl IntoIterator<Item = &'a (ModCandidate, Option<ModMetadata>)>,
    ) -> Self {
        Self {
            schema: CACHE_SCHEMA,
            entries: entries
                .into_iter()
                .map(|(candidate, metadata)| {
                    (
                        candidate.file_name.clone(),
                        CacheEntry {
                            stamp: candidate.stamp,
                            metadata: metadata.clone(),
                        },
                    )
                })
                .collect(),
        }
    }
}

/// 读缓存。文件缺失、损坏、读不出一律当空缓存——代价只是这一轮全量重解析，而不是整个列表报错。
async fn load_metadata_cache(path: &Path) -> ModMetadataCache {
    let bytes = match tokio::fs::read(path).await {
        Ok(bytes) => bytes,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
            return ModMetadataCache::default();
        }
        Err(error) => {
            tracing::warn!(path = %path.display(), %error, "读取 Mod 元数据缓存失败，本轮全量重解析");
            return ModMetadataCache::default();
        }
    };
    match serde_json::from_slice::<ModMetadataCache>(&bytes) {
        Ok(cache) if cache.schema == CACHE_SCHEMA => cache,
        Ok(stale) => {
            tracing::info!(
                path = %path.display(),
                found = stale.schema,
                expected = CACHE_SCHEMA,
                "Mod 元数据缓存格式已过期，本轮全量重解析"
            );
            ModMetadataCache::default()
        }
        Err(error) => {
            tracing::warn!(path = %path.display(), %error, "Mod 元数据缓存已损坏，本轮全量重解析");
            ModMetadataCache::default()
        }
    }
}

/// 写缓存。写失败只记日志：列表本身已经算好了，没必要因为存不下一份加速索引就让调用方拿到错误。
async fn save_metadata_cache(path: &Path, cache: &ModMetadataCache) {
    let bytes = match serde_json::to_vec(cache) {
        Ok(bytes) => bytes,
        Err(error) => {
            tracing::warn!(path = %path.display(), %error, "序列化 Mod 元数据缓存失败");
            return;
        }
    };
    if let Err(error) = aurora_base::fs::atomic_write(path, &bytes).await {
        tracing::warn!(path = %path.display(), %error, "写入 Mod 元数据缓存失败，下次扫描将全量重解析");
    }
}

/// 一次性枚举 mods 目录里的所有 jar（含禁用态），顺带取出缓存判据。
///
/// 同步实现：调用方已把它整个放进 spawn_blocking，这里再用 tokio::fs 只会多套一层无谓的异步。
fn list_mod_candidates_blocking(dir: &Path) -> Result<Vec<ModCandidate>> {
    let read_dir = std::fs::read_dir(dir).map_err(|source| {
        Error::Base(aurora_base::Error::Io {
            path: dir.to_owned(),
            source,
        })
    })?;

    let mut out = Vec::new();
    for entry in read_dir {
        let entry = entry.map_err(|source| {
            Error::Base(aurora_base::Error::Io {
                path: dir.to_owned(),
                source,
            })
        })?;
        let file_type = entry.file_type().map_err(|source| {
            Error::Base(aurora_base::Error::Io {
                path: entry.path(),
                source,
            })
        })?;
        if !file_type.is_file() {
            continue;
        }
        let file_name = entry.file_name().to_string_lossy().into_owned();
        if !is_mod_file(&file_name) {
            continue;
        }
        // 目录项读得出、元数据却读不出，属于目录级的 IO 故障，与上面 file_type 同等对待向上冒泡；
        // 不在这里降级成「不走缓存」，那会把真实故障压成一次永远慢的扫描。
        let meta = entry.metadata().map_err(|source| {
            Error::Base(aurora_base::Error::Io {
                path: entry.path(),
                source,
            })
        })?;
        let stamp = FileStamp::from_metadata(&meta).map_err(|source| {
            Error::Base(aurora_base::Error::Io {
                path: entry.path(),
                source,
            })
        })?;
        out.push(ModCandidate {
            enabled: !is_disabled(&file_name),
            path: entry.path(),
            file_name,
            stamp,
        });
    }
    Ok(out)
}

/// 读出 jar 内一个条目的全部字节（例如元数据里声明的图标）；jar 不是合法 zip 或条目不存在返回
/// `Ok(None)`，其余读取故障冒泡。
///
/// 每次调用打开、读完即关闭，不长期持有 jar 句柄：Windows 上被打开的文件不能改名或删除，常驻句柄会
/// 让启停、更新与移除失败。
pub async fn read_jar_entry(
    jar: impl AsRef<Path>,
    entry: impl Into<String>,
) -> Result<Option<Vec<u8>>> {
    let jar = jar.as_ref().to_owned();
    let entry = entry.into();
    tokio::task::spawn_blocking(move || {
        let file = std::fs::File::open(&jar).map_err(|source| {
            Error::Base(aurora_base::Error::Io {
                path: jar.clone(),
                source,
            })
        })?;
        let mut archive = match zip::ZipArchive::new(file) {
            Ok(archive) => archive,
            Err(zip::result::ZipError::InvalidArchive(_)) => return Ok(None),
            Err(source) => return Err(Error::Zip { path: jar, source }),
        };
        read_entry(&mut archive, &entry, &jar)
    })
    .await
    .map_err(|source| Error::Base(aurora_base::Error::HashTaskJoin(source)))?
}
/// 解析单个 jar 的模组元数据。无可识别描述文件或非合法 zip 返回 `Ok(None)`；描述文件存在但内容
/// 损坏返回 `Err`（不掩盖）。
pub async fn parse_mod_metadata(path: impl AsRef<Path>) -> Result<Option<ModMetadata>> {
    let path = path.as_ref().to_owned();
    tokio::task::spawn_blocking(move || extract_metadata_blocking(&path))
        .await
        .map_err(|source| Error::Base(aurora_base::Error::HashTaskJoin(source)))?
}

fn extract_metadata_blocking(path: &Path) -> Result<Option<ModMetadata>> {
    let file = std::fs::File::open(path).map_err(|source| {
        Error::Base(aurora_base::Error::Io {
            path: path.to_owned(),
            source,
        })
    })?;
    let mut archive = match zip::ZipArchive::new(file) {
        Ok(archive) => archive,
        // 不是合法 zip/jar（例如占位文件）：按「无元数据」处理，而非报错。
        Err(zip::result::ZipError::InvalidArchive(_)) => return Ok(None),
        Err(source) => {
            return Err(Error::Zip {
                path: path.to_owned(),
                source,
            });
        }
    };

    // 优先级：neoforge.mods.toml -> mods.toml -> quilt.mod.json -> fabric.mod.json。
    // quilt 排在 fabric 前是因为 Quilt 模组普遍额外附带一份 fabric.mod.json 兼容垫片（Quilt 加载器
    // 也能直接读 Fabric 描述文件），显式声明的 quilt.mod.json 才是这个 jar 的真实身份。
    if let Some(bytes) = read_entry(&mut archive, NEOFORGE_DESCRIPTOR, path)? {
        return parse_toml_metadata(
            &bytes,
            ModLoader::NeoForge,
            MetadataFormat::NeoForgeToml,
            path,
        );
    }
    if let Some(bytes) = read_entry(&mut archive, FORGE_DESCRIPTOR, path)? {
        return parse_toml_metadata(&bytes, ModLoader::Forge, MetadataFormat::ForgeToml, path);
    }
    if let Some(bytes) = read_entry(&mut archive, QUILT_DESCRIPTOR, path)? {
        return parse_quilt_metadata(&bytes, path);
    }
    if let Some(bytes) = read_entry(&mut archive, FABRIC_DESCRIPTOR, path)? {
        return parse_fabric_metadata(&bytes, path);
    }
    Ok(None)
}

/// 把 JSON 里的版本约束渲染成一句原文：字符串原样取；字符串数组按「或」语义用 ` || ` 连接
/// （Fabric 与 Quilt 的数组形态都是这个语义）。其余形态（Quilt 的 `{any:[...]}` 嵌套对象）
/// 无法压成一句话，返回 `None`——约束原文只用于展示，取不到就不展示，不编。
fn json_version_constraint(value: &serde_json::Value) -> Option<String> {
    match value {
        serde_json::Value::String(text) => Some(text.clone()),
        serde_json::Value::Array(items) => {
            let parts: Option<Vec<&str>> = items.iter().map(|item| item.as_str()).collect();
            let parts = parts?;
            if parts.is_empty() {
                None
            } else {
                Some(parts.join(" || "))
            }
        }
        _ => None,
    }
}

/// 从 zip 里读取指定条目的全部字节；条目不存在返回 `Ok(None)`。
fn read_entry(
    archive: &mut zip::ZipArchive<std::fs::File>,
    name: &str,
    path: &Path,
) -> Result<Option<Vec<u8>>> {
    match archive.by_name(name) {
        Ok(mut entry) => {
            let mut buf = Vec::new();
            entry.read_to_end(&mut buf).map_err(|source| Error::Zip {
                path: path.to_owned(),
                source: zip::result::ZipError::Io(source),
            })?;
            Ok(Some(buf))
        }
        Err(zip::result::ZipError::FileNotFound) => Ok(None),
        Err(source) => Err(Error::Zip {
            path: path.to_owned(),
            source,
        }),
    }
}

/// 描述文件里图标的两种写法：单个路径，或「尺寸 -> 路径」的映射（Fabric 与 Quilt 规范一致）。
#[derive(Debug, Deserialize)]
#[serde(untagged)]
enum JsonIcon {
    Path(String),
    Sized(BTreeMap<String, String>),
}

impl JsonIcon {
    /// 取一张图：映射形态取尺寸最大的那张——列表行只显示几十像素，但缩放大图比放大小图好看。
    /// 尺寸键不是数字的条目排在数字键之后再比字典序，不丢弃：它们仍是作者声明的合法图标。
    fn pick(self) -> Option<String> {
        let chosen = match self {
            JsonIcon::Path(path) => path,
            JsonIcon::Sized(map) => {
                map.into_iter()
                    .max_by(
                        |(a, _), (b, _)| match (a.parse::<u32>(), b.parse::<u32>()) {
                            (Ok(x), Ok(y)) => x.cmp(&y),
                            (Ok(_), Err(_)) => std::cmp::Ordering::Greater,
                            (Err(_), Ok(_)) => std::cmp::Ordering::Less,
                            (Err(_), Err(_)) => a.cmp(b),
                        },
                    )?
                    .1
            }
        };
        normalize_icon_entry(&chosen)
    }
}

/// 把描述文件里的图标路径归一成 zip 条目名：去掉开头的 `/` 与 `./`，空串视为没声明。
fn normalize_icon_entry(raw: &str) -> Option<String> {
    let trimmed = raw.trim().trim_start_matches("./").trim_start_matches('/');
    (!trimmed.is_empty()).then(|| trimmed.to_owned())
}

/// 把 JSON 描述文件整理成 serde_json 能读的严格 JSON，放行范围与 Fabric / Quilt 加载器对齐。
///
/// 两个加载器都用 Gson 派生的 JsonReader 读描述文件，它的字符串词法比 JSON 规范宽：字符串里的裸控制
/// 字符原样收下，`\'` 与「反斜杠 + 换行」算合法转义，文件开头的一个 BOM 跳过。真实 Mod 确实依赖这份
/// 宽容：Gradle 展开模板时会把源码里的 `\n` 变成真换行，判成损坏的话，游戏能加载的 Mod 在列表里就成了
/// 无元数据。
///
/// 只改写这几处，其余字节原样交给 serde_json，注释、尾逗号、单引号串这些加载器同样拒绝的写法继续报错。
/// 按字节走不会切开字符：UTF-8 多字节序列里不会出现 ASCII 字节。
fn loader_tolerant_json(bytes: &[u8]) -> Vec<u8> {
    let body = bytes.strip_prefix(b"\xEF\xBB\xBF").unwrap_or(bytes);
    let mut out = Vec::with_capacity(body.len());
    let mut in_string = false;
    let mut rest = body.iter().copied();
    while let Some(byte) = rest.next() {
        match byte {
            b'"' => {
                in_string = !in_string;
                out.push(byte);
            }
            // 反斜杠连带下一个字节一起处理：`\"` 不结束字符串，`\\` 后面的换行才是裸换行。
            b'\\' if in_string => match rest.next() {
                Some(b'\'') => out.push(b'\''),
                Some(b'\n') => out.extend_from_slice(br"\n"),
                Some(escaped) => out.extend_from_slice(&[b'\\', escaped]),
                None => out.push(byte),
            },
            0x00..=0x1F if in_string => {
                out.extend_from_slice(format!("\\u{byte:04x}").as_bytes());
            }
            _ => out.push(byte),
        }
    }
    out
}

/// `fabric.mod.json` 里作者可为字符串或 `{ "name": ... }` 对象。
#[derive(Debug, Deserialize)]
#[serde(untagged)]
enum FabricAuthor {
    Name(String),
    Detailed { name: String },
}

#[derive(Debug, Deserialize)]
struct FabricModJson {
    id: String,
    #[serde(default)]
    version: Option<String>,
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    description: Option<String>,
    #[serde(default)]
    authors: Vec<FabricAuthor>,
    /// mod id -> 版本约束（字符串或字符串数组）。用 BTreeMap 而非 HashMap，让依赖列表按字典序
    /// 稳定输出，避免同一个 jar 每次扫描得到不同顺序。
    #[serde(default)]
    depends: BTreeMap<String, serde_json::Value>,
    #[serde(default)]
    icon: Option<JsonIcon>,
}

fn parse_fabric_metadata(bytes: &[u8], path: &Path) -> Result<Option<ModMetadata>> {
    let tolerant = loader_tolerant_json(bytes);
    let raw: FabricModJson = serde_json::from_slice(&tolerant).map_err(|source| Error::Json {
        context: format!("fabric.mod.json in {}", path.display()),
        source,
    })?;
    let authors = raw
        .authors
        .into_iter()
        .map(|author| match author {
            FabricAuthor::Name(name) => name,
            FabricAuthor::Detailed { name } => name,
        })
        .collect();
    let minecraft_version = raw
        .depends
        .get(MINECRAFT_DEPENDENCY_ID)
        .and_then(json_version_constraint);
    // Fabric 的 depends 全是硬依赖，可选项走独立的 recommends/suggests 字段，这里不收。
    let depends = raw.depends.into_keys().collect();
    Ok(Some(ModMetadata {
        mod_id: raw.id,
        name: raw.name,
        version: raw.version,
        description: raw.description,
        authors,
        depends,
        minecraft_version,
        icon: raw.icon.and_then(JsonIcon::pick),
        loader: ModLoader::Fabric,
        format: MetadataFormat::Fabric,
    }))
}

#[derive(Debug, Deserialize)]
struct QuiltModJson {
    quilt_loader: QuiltLoader,
}

#[derive(Debug, Deserialize)]
struct QuiltLoader {
    id: String,
    #[serde(default)]
    version: Option<String>,
    #[serde(default)]
    metadata: Option<QuiltMetadata>,
    #[serde(default)]
    depends: Vec<QuiltDependency>,
}

#[derive(Debug, Deserialize)]
struct QuiltMetadata {
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    description: Option<String>,
    /// 键是贡献者名，值是角色（字符串或字符串数组）。作者名只取键。
    #[serde(default)]
    contributors: BTreeMap<String, serde_json::Value>,
    #[serde(default)]
    icon: Option<JsonIcon>,
}

/// `quilt_loader.depends` 条目的三种合法形态：裸 id 串、详细对象、以及「任选其一」的嵌套数组。
#[derive(Debug, Deserialize)]
#[serde(untagged)]
enum QuiltDependency {
    Id(String),
    Detailed {
        id: String,
        #[serde(default)]
        versions: Option<serde_json::Value>,
        #[serde(default)]
        optional: bool,
    },
    Alternatives(Vec<QuiltDependency>),
}

impl QuiltDependency {
    /// 展平成 `(id, 版本约束)` 追加到 `out`。
    ///
    /// 「任选其一」的嵌套组同样被拉平收下：本字段是依赖声明的索引而非安装计划，列全比漏列有用。
    /// `optional: true` 的项跳过，与 Forge 只收必需依赖保持一致。
    fn collect_required(&self, out: &mut Vec<(String, Option<String>)>) {
        match self {
            QuiltDependency::Id(id) => out.push((id.clone(), None)),
            QuiltDependency::Detailed {
                id,
                versions,
                optional,
            } => {
                if !*optional {
                    out.push((
                        id.clone(),
                        versions.as_ref().and_then(json_version_constraint),
                    ));
                }
            }
            QuiltDependency::Alternatives(items) => {
                for item in items {
                    item.collect_required(out);
                }
            }
        }
    }
}

/// Quilt 的依赖 id 允许带 maven group 前缀（`group:id`），比对时只看末段。
fn quilt_dependency_tail(declared: &str) -> &str {
    match declared.rsplit_once(':') {
        Some((_, tail)) => tail,
        None => declared,
    }
}

fn parse_quilt_metadata(bytes: &[u8], path: &Path) -> Result<Option<ModMetadata>> {
    let tolerant = loader_tolerant_json(bytes);
    let raw: QuiltModJson = serde_json::from_slice(&tolerant).map_err(|source| Error::Json {
        context: format!("quilt.mod.json in {}", path.display()),
        source,
    })?;
    let loader = raw.quilt_loader;

    let mut declared: Vec<(String, Option<String>)> = Vec::new();
    for dependency in &loader.depends {
        dependency.collect_required(&mut declared);
    }
    let minecraft_version = declared
        .iter()
        .find(|(id, _)| quilt_dependency_tail(id) == MINECRAFT_DEPENDENCY_ID)
        .and_then(|(_, constraint)| constraint.clone());
    let depends = declared.into_iter().map(|(id, _)| id).collect();

    let (name, description, authors, icon) = match loader.metadata {
        Some(metadata) => (
            metadata.name,
            metadata.description,
            metadata.contributors.into_keys().collect(),
            metadata.icon.and_then(JsonIcon::pick),
        ),
        None => (None, None, Vec::new(), None),
    };

    Ok(Some(ModMetadata {
        mod_id: loader.id,
        name,
        version: loader.version,
        description,
        authors,
        depends,
        minecraft_version,
        icon,
        loader: ModLoader::Quilt,
        format: MetadataFormat::QuiltModJson,
    }))
}

/// `mods.toml` 里 `authors` 的两种合法写法。
///
/// Forge 文档给的是逗号分隔的单字符串，但经 architectury 打包的模组会写成 TOML 数组
/// （DistantHorizons 的文件里甚至留了一句注释说明这是被 architectury 逼的），Forge 自己照读不误。
/// 这里必须两种都认：`toml::from_str` 是整份文件一起反序列化，单单一个 authors 字段类型对不上，
/// 整份 mods.toml 连同 modId / 版本 / 描述一起作废，模组在列表里会变成一条没名字的裸文件名。
#[derive(Debug, Deserialize)]
#[serde(untagged)]
enum TomlAuthors {
    One(String),
    Many(Vec<String>),
}

#[derive(Debug, Deserialize)]
struct ModsToml {
    #[serde(default)]
    mods: Vec<ModsTomlEntry>,
    /// 顶层作者（部分模组把 authors 写在顶层而非 `[[mods]]` 内）。
    #[serde(default)]
    authors: Option<TomlAuthors>,
    /// `[[dependencies.<modid>]]`：键是「声明这些依赖的那个 mod 的 id」，值是它的依赖数组。
    /// 一个 jar 里塞多个 mod 时会有多组。
    #[serde(default)]
    dependencies: BTreeMap<String, Vec<ModsTomlDependency>>,
}

#[derive(Debug, Deserialize)]
struct ModsTomlDependency {
    #[serde(rename = "modId")]
    mod_id: String,
    /// Forge 老写法。
    #[serde(default)]
    mandatory: Option<bool>,
    /// NeoForge 新写法：`required` / `optional` / `incompatible` / `discouraged`。
    #[serde(default, rename = "type")]
    kind: Option<String>,
    /// Maven 版本区间；NeoForge 侧默认空串表示「任意版本」。
    #[serde(default, rename = "versionRange")]
    version_range: Option<String>,
}

impl ModsTomlDependency {
    /// 是否必需依赖。
    ///
    /// NeoForge 的 `type` 优先（新写法，取值 required/optional/incompatible/discouraged），
    /// 回落到 Forge 的 `mandatory` 布尔；两者都没写时按 NeoForge 文档的默认值 `required` 处理——
    /// 该字段本就非必填，默认即必需。
    fn is_required(&self) -> bool {
        match self.kind.as_deref() {
            Some(kind) => kind.eq_ignore_ascii_case("required"),
            None => self.mandatory.unwrap_or(true),
        }
    }
}

#[derive(Debug, Deserialize)]
struct ModsTomlEntry {
    #[serde(rename = "modId")]
    mod_id: String,
    #[serde(default)]
    version: Option<String>,
    #[serde(default, rename = "displayName")]
    display_name: Option<String>,
    #[serde(default)]
    description: Option<String>,
    #[serde(default)]
    authors: Option<TomlAuthors>,
    /// 模组列表界面用的图标文件名，规范要求放在 jar 根目录。
    #[serde(default, rename = "logoFile")]
    logo_file: Option<String>,
}

fn parse_toml_metadata(
    bytes: &[u8],
    loader: ModLoader,
    format: MetadataFormat,
    path: &Path,
) -> Result<Option<ModMetadata>> {
    let text = std::str::from_utf8(bytes).map_err(|_| {
        Error::Base(aurora_base::Error::Io {
            path: path.to_owned(),
            source: std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "mods.toml 不是合法 UTF-8",
            ),
        })
    })?;
    let parsed: ModsToml = toml::from_str(text).map_err(|source| Error::Toml {
        context: format!("mods.toml in {}", path.display()),
        source,
    })?;

    // 取首个 [[mods]] 作为主模组。没有条目视为无可用元数据。
    let top_authors = parsed.authors;
    let dependencies = parsed.dependencies;
    let Some(entry) = parsed.mods.into_iter().next() else {
        return Ok(None);
    };
    let authors = split_authors(entry.authors.or(top_authors));

    // 依赖表以「声明方 mod id」为键。个别模组这里的大小写与 [[mods]] 的 modId 对不上（Forge 自身
    // 是精确匹配，这类文件在游戏里其实也不生效），我们放宽成大小写不敏感，尽量把依赖读出来。
    let declared: &[ModsTomlDependency] = match dependencies
        .iter()
        .find(|(owner, _)| owner.eq_ignore_ascii_case(&entry.mod_id))
    {
        Some((_, deps)) => deps,
        None => &[],
    };
    let minecraft_version = declared
        .iter()
        .find(|dep| dep.mod_id.eq_ignore_ascii_case(MINECRAFT_DEPENDENCY_ID))
        .and_then(|dep| dep.version_range.clone())
        // 空区间等于「任意版本」，等于没说，不如不给。
        .filter(|range| !range.trim().is_empty());
    let depends = declared
        .iter()
        .filter(|dep| dep.is_required())
        .map(|dep| dep.mod_id.clone())
        .collect();

    Ok(Some(ModMetadata {
        mod_id: entry.mod_id,
        name: entry.display_name,
        version: entry.version,
        description: entry.description,
        authors,
        depends,
        minecraft_version,
        icon: entry.logo_file.as_deref().and_then(normalize_icon_entry),
        loader,
        format,
    }))
}

/// 把 `"作者甲, 作者乙"` 或 `["作者甲", "作者乙"]` 归一成去空白、去空项的作者列表。
fn split_authors(raw: Option<TomlAuthors>) -> Vec<String> {
    let cleaned = |author: &str| -> Option<String> {
        let trimmed = author.trim();
        (!trimmed.is_empty()).then(|| trimmed.to_string())
    };
    match raw {
        None => Vec::new(),
        // 字符串形态只能靠逗号猜分隔，作者名里真有逗号也就只能认了——这是这种写法自带的歧义。
        Some(TomlAuthors::One(value)) => value.split(',').filter_map(cleaned).collect(),
        // 数组形态作者已经自己分好了，不再二次切分：再切一刀会把 "Doe, John" 拆成两个人。
        Some(TomlAuthors::Many(list)) => list.iter().filter_map(|a| cleaned(a)).collect(),
    }
}

/// 切换模组启用/禁用状态，返回切换后的新路径。
///
/// 启用即去掉 `.disabled` 后缀，禁用即追加。若已处于目标状态则无操作返回原路径；若目标文件名已存在
/// （同名启用与禁用副本冲突）返回 [`Error::ModStateConflict`]，避免覆盖。
pub async fn set_mod_enabled(path: impl AsRef<Path>, enabled: bool) -> Result<PathBuf> {
    let path = path.as_ref();
    let name = path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| {
            Error::Base(aurora_base::Error::Io {
                path: path.to_owned(),
                source: std::io::Error::new(std::io::ErrorKind::InvalidInput, "路径缺少文件名"),
            })
        })?;

    let target_name = if enabled {
        name.strip_suffix(DISABLED_SUFFIX)
            .unwrap_or(name)
            .to_string()
    } else if is_disabled(name) {
        name.to_string()
    } else {
        format!("{name}{DISABLED_SUFFIX}")
    };

    // 已是目标状态：不动，返回原路径。
    if target_name == name {
        return Ok(path.to_owned());
    }

    let target_path = path.with_file_name(&target_name);
    let exists = tokio::fs::try_exists(&target_path)
        .await
        .map_err(|source| {
            Error::Base(aurora_base::Error::Io {
                path: target_path.clone(),
                source,
            })
        })?;
    if exists {
        return Err(Error::ModStateConflict { path: target_path });
    }

    tokio::fs::rename(path, &target_path)
        .await
        .map_err(|source| {
            Error::Base(aurora_base::Error::Io {
                path: target_path.clone(),
                source,
            })
        })?;
    Ok(target_path)
}

/// 启用模组（去掉 `.disabled` 后缀）。
pub async fn enable_mod(path: impl AsRef<Path>) -> Result<PathBuf> {
    set_mod_enabled(path, true).await
}

/// 禁用模组（追加 `.disabled` 后缀）。
pub async fn disable_mod(path: impl AsRef<Path>) -> Result<PathBuf> {
    set_mod_enabled(path, false).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    /// 用给定条目写一个（deflate 压缩的）jar，读时会走真正的解压路径。
    fn build_jar(path: &Path, entries: &[(&str, &[u8])]) {
        let file = std::fs::File::create(path).unwrap();
        let mut zip = zip::ZipWriter::new(file);
        let options = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Deflated);
        for (name, data) in entries {
            zip.start_file(*name, options).unwrap();
            zip.write_all(data).unwrap();
        }
        zip.finish().unwrap();
    }

    #[tokio::test]
    async fn parses_fabric_mod_json() {
        let dir = tempfile::tempdir().unwrap();
        let jar = dir.path().join("sodium.jar");
        // 原始 str + as_bytes：byte-string 字面量不允许非 ASCII，这里描述含中文。
        let descriptor = r#"{
            "schemaVersion": 1,
            "id": "sodium",
            "version": "0.5.3",
            "name": "Sodium",
            "description": "渲染优化",
            "authors": ["jellysquid3", {"name": "IMS"}],
            "depends": {
                "fabricloader": ">=0.14.0",
                "minecraft": "~1.20.1",
                "java": ">=17"
            }
        }"#
        .as_bytes();
        build_jar(&jar, &[("fabric.mod.json", descriptor)]);

        let meta = parse_mod_metadata(&jar).await.unwrap().expect("应有元数据");
        assert_eq!(meta.mod_id, "sodium");
        assert_eq!(meta.name.as_deref(), Some("Sodium"));
        assert_eq!(meta.version.as_deref(), Some("0.5.3"));
        assert_eq!(meta.authors, vec!["jellysquid3", "IMS"]);
        assert_eq!(meta.loader, ModLoader::Fabric);
        assert_eq!(meta.format, MetadataFormat::Fabric);
        // BTreeMap 保证字典序，扫描结果稳定。
        assert_eq!(meta.depends, vec!["fabricloader", "java", "minecraft"]);
        assert_eq!(meta.minecraft_version.as_deref(), Some("~1.20.1"));
    }

    #[tokio::test]
    async fn fabric_minecraft_constraint_array_joins_as_or() {
        let dir = tempfile::tempdir().unwrap();
        let jar = dir.path().join("multi.jar");
        let descriptor = br#"{
            "id": "multi",
            "depends": {"minecraft": ["1.20.1", "1.20.2"]}
        }"#;
        build_jar(&jar, &[("fabric.mod.json", descriptor)]);

        let meta = parse_mod_metadata(&jar).await.unwrap().unwrap();
        assert_eq!(meta.minecraft_version.as_deref(), Some("1.20.1 || 1.20.2"));
        assert_eq!(meta.depends, vec!["minecraft"]);
    }

    #[tokio::test]
    async fn fabric_without_depends_yields_empty_declarations() {
        let dir = tempfile::tempdir().unwrap();
        let jar = dir.path().join("bare.jar");
        build_jar(&jar, &[("fabric.mod.json", br#"{"id":"bare"}"#)]);

        let meta = parse_mod_metadata(&jar).await.unwrap().unwrap();
        assert!(meta.depends.is_empty());
        assert_eq!(meta.minecraft_version, None);
    }

    #[tokio::test]
    async fn parses_forge_mods_toml() {
        let dir = tempfile::tempdir().unwrap();
        let jar = dir.path().join("jei.jar");
        let descriptor = r#"modLoader="javafml"
loaderVersion="[47,)"
license="MIT"

[[mods]]
modId="jei"
version="15.2.0.27"
displayName="Just Enough Items"
authors="mezz"
description="物品查看"

[[dependencies.jei]]
modId="forge"
mandatory=true
versionRange="[47,)"
ordering="NONE"
side="BOTH"

[[dependencies.jei]]
modId="minecraft"
mandatory=true
versionRange="[1.20.1,1.20.2)"

[[dependencies.jei]]
modId="patchouli"
mandatory=false
versionRange="[1.4,)"
"#
        .as_bytes();
        build_jar(&jar, &[("META-INF/mods.toml", descriptor)]);

        let meta = parse_mod_metadata(&jar).await.unwrap().expect("应有元数据");
        assert_eq!(meta.mod_id, "jei");
        assert_eq!(meta.name.as_deref(), Some("Just Enough Items"));
        assert_eq!(meta.version.as_deref(), Some("15.2.0.27"));
        assert_eq!(meta.authors, vec!["mezz"]);
        assert_eq!(meta.loader, ModLoader::Forge);
        assert_eq!(meta.format, MetadataFormat::ForgeToml);
        // mandatory=false 的 patchouli 不进依赖列表，声明顺序保持原样。
        assert_eq!(meta.depends, vec!["forge", "minecraft"]);
        assert_eq!(meta.minecraft_version.as_deref(), Some("[1.20.1,1.20.2)"));
    }

    #[tokio::test]
    async fn neoforge_dependency_type_supersedes_mandatory() {
        let dir = tempfile::tempdir().unwrap();
        let jar = dir.path().join("modern.jar");
        let descriptor = br#"modLoader="javafml"
loaderVersion="[1,)"
license="MIT"

[[mods]]
modId="modern"
version="1.0.0"

[[dependencies.modern]]
modId="neoforge"
type="required"
versionRange="[21.1.0,)"

[[dependencies.modern]]
modId="minecraft"
type="required"
versionRange="[1.21.1,1.22)"

[[dependencies.modern]]
modId="jade"
type="optional"

[[dependencies.modern]]
modId="optifine"
type="incompatible"

[[dependencies.modern]]
modId="fallbackdep"
versionRange="[1,)"
"#;
        build_jar(&jar, &[("META-INF/neoforge.mods.toml", descriptor)]);

        let meta = parse_mod_metadata(&jar).await.unwrap().unwrap();
        assert_eq!(meta.loader, ModLoader::NeoForge);
        // type=optional / incompatible 都不算必需；两者都没写时按 NeoForge 默认值 required 收下。
        assert_eq!(meta.depends, vec!["neoforge", "minecraft", "fallbackdep"]);
        assert_eq!(meta.minecraft_version.as_deref(), Some("[1.21.1,1.22)"));
    }

    #[tokio::test]
    async fn toml_empty_version_range_is_not_reported_as_constraint() {
        let dir = tempfile::tempdir().unwrap();
        let jar = dir.path().join("anyver.jar");
        let descriptor = br#"modLoader="javafml"
loaderVersion="[1,)"
license="MIT"

[[mods]]
modId="anyver"

[[dependencies.anyver]]
modId="minecraft"
type="required"
versionRange=""
"#;
        build_jar(&jar, &[("META-INF/neoforge.mods.toml", descriptor)]);

        let meta = parse_mod_metadata(&jar).await.unwrap().unwrap();
        assert_eq!(meta.depends, vec!["minecraft"]);
        // 空区间等于「任意版本」，不能当成一条真实约束报出去。
        assert_eq!(meta.minecraft_version, None);
    }

    #[tokio::test]
    async fn toml_dependencies_of_other_mods_are_ignored() {
        let dir = tempfile::tempdir().unwrap();
        let jar = dir.path().join("twin.jar");
        // 一个 jar 里两个 mod：只有主 mod（首个 [[mods]]）的依赖组算数。
        // 含中文，用原始 str + as_bytes（byte-string 字面量不允许非 ASCII）。
        let descriptor = r#"modLoader="javafml"
loaderVersion="[1,)"
license="MIT"

[[mods]]
modId="primary"

[[mods]]
modId="secondary"

[[dependencies.primary]]
modId="forge"
mandatory=true
versionRange="[47,)"

[[dependencies.secondary]]
modId="不该被收进来"
mandatory=true
"#
        .as_bytes();
        build_jar(&jar, &[("META-INF/mods.toml", descriptor)]);

        let meta = parse_mod_metadata(&jar).await.unwrap().unwrap();
        assert_eq!(meta.mod_id, "primary");
        assert_eq!(meta.depends, vec!["forge"]);
    }

    /// authors 写成 TOML 数组的 Forge 模组（architectury 打包出来的都是这样，
    /// 整合包里的 DistantHorizons 就是真实样本）。
    ///
    /// 断言刻意不止看 authors：这个字段类型对不上时 serde 会让整份文件反序列化失败，
    /// 于是 modId / 版本 / 描述 / 依赖全部一起丢，模组在列表里只剩一个裸文件名。
    /// 把整份元数据都钉住，才是这条回归真正要守的东西。
    #[tokio::test]
    async fn parses_forge_mods_toml_with_array_authors() {
        let dir = tempfile::tempdir().unwrap();
        let jar = dir.path().join("distanthorizons.jar");
        let descriptor = r#"modLoader = "javafml"
loaderVersion = "*"
license = "LGPL"

[[mods]]
    modId = "distanthorizons"
    version = "2.4.5-b"
    displayName = "Distant Horizons"
    authors = ["James Seibel", " Leonardo Amato ", "", "coolGi"]
    description = "远景渲染"

[[dependencies.distanthorizons]]
    modId = "forge"
    mandatory = true
    versionRange = "[0,)"

[[dependencies.distanthorizons]]
    modId = "minecraft"
    mandatory = true
    versionRange = "[1.20, 1.20.1,)"

[[dependencies.distanthorizons]]
    modId = "oculus"
    mandatory = false
    versionRange = "[1.8.0,)"
"#
        .as_bytes();
        build_jar(&jar, &[("META-INF/mods.toml", descriptor)]);

        let meta = parse_mod_metadata(&jar).await.unwrap().expect("应有元数据");
        assert_eq!(meta.mod_id, "distanthorizons");
        assert_eq!(meta.name.as_deref(), Some("Distant Horizons"));
        assert_eq!(meta.version.as_deref(), Some("2.4.5-b"));
        assert_eq!(meta.description.as_deref(), Some("远景渲染"));
        // 首尾空白剪掉、空串丢掉；已经分好的条目不再按逗号二次切分。
        assert_eq!(
            meta.authors,
            vec!["James Seibel", "Leonardo Amato", "coolGi"]
        );
        assert_eq!(meta.minecraft_version.as_deref(), Some("[1.20, 1.20.1,)"));
        // oculus 是 mandatory=false，不该进必需依赖。
        assert_eq!(meta.depends, vec!["forge", "minecraft"]);
        assert_eq!(meta.loader, ModLoader::Forge);
        assert_eq!(meta.format, MetadataFormat::ForgeToml);
    }

    /// 数组元素自带逗号时按一个人算，不再切开——与字符串形态的逗号语义刻意不同。
    #[tokio::test]
    async fn array_authors_keep_commas_inside_one_entry() {
        let dir = tempfile::tempdir().unwrap();
        let jar = dir.path().join("comma.jar");
        let descriptor = br#"modLoader="javafml"
loaderVersion="*"

[[mods]]
modId="comma"
authors=["Doe, John", "Ada"]
"#;
        build_jar(&jar, &[("META-INF/mods.toml", descriptor)]);

        let meta = parse_mod_metadata(&jar).await.unwrap().expect("应有元数据");
        assert_eq!(meta.authors, vec!["Doe, John", "Ada"]);
    }

    #[tokio::test]
    async fn parses_neoforge_mods_toml_with_multiple_authors() {
        let dir = tempfile::tempdir().unwrap();
        let jar = dir.path().join("jade.jar");
        let descriptor = br#"modLoader="javafml"
loaderVersion="[1,)"
license="MIT"

[[mods]]
modId="jade"
version="11.6.0"
displayName="Jade"
authors="Snownee, TrainGuys"
"#;
        build_jar(&jar, &[("META-INF/neoforge.mods.toml", descriptor)]);

        let meta = parse_mod_metadata(&jar).await.unwrap().expect("应有元数据");
        assert_eq!(meta.mod_id, "jade");
        assert_eq!(meta.name.as_deref(), Some("Jade"));
        assert_eq!(meta.version.as_deref(), Some("11.6.0"));
        assert_eq!(meta.authors, vec!["Snownee", "TrainGuys"]);
        assert_eq!(meta.loader, ModLoader::NeoForge);
        assert_eq!(meta.format, MetadataFormat::NeoForgeToml);
    }

    #[tokio::test]
    async fn parses_quilt_mod_json() {
        let dir = tempfile::tempdir().unwrap();
        let jar = dir.path().join("quiltmod.jar");
        let descriptor = r#"{
            "schema_version": 1,
            "quilt_loader": {
                "group": "com.example",
                "id": "example_mod",
                "version": "1.2.3",
                "metadata": {
                    "name": "Example Mod",
                    "description": "示例模组",
                    "contributors": {"Alice": "Owner", "Bob": ["Author"]}
                },
                "depends": [
                    "quilt_base",
                    {"id": "quilt_loader", "versions": ">=0.17.0"},
                    {"id": "minecraft", "versions": ">=1.20.1"},
                    {"id": "jade", "versions": "*", "optional": true}
                ]
            }
        }"#
        .as_bytes();
        build_jar(&jar, &[("quilt.mod.json", descriptor)]);

        let meta = parse_mod_metadata(&jar).await.unwrap().expect("应有元数据");
        assert_eq!(meta.mod_id, "example_mod");
        assert_eq!(meta.name.as_deref(), Some("Example Mod"));
        assert_eq!(meta.version.as_deref(), Some("1.2.3"));
        assert_eq!(meta.description.as_deref(), Some("示例模组"));
        assert_eq!(meta.authors, vec!["Alice", "Bob"]);
        assert_eq!(meta.loader, ModLoader::Quilt);
        assert_eq!(meta.format, MetadataFormat::QuiltModJson);
        // optional 的 jade 被跳过，裸串与详细对象都收下。
        assert_eq!(
            meta.depends,
            vec!["quilt_base", "quilt_loader", "minecraft"]
        );
        assert_eq!(meta.minecraft_version.as_deref(), Some(">=1.20.1"));
    }

    #[tokio::test]
    async fn quilt_handles_group_prefixed_ids_and_nested_alternatives() {
        let dir = tempfile::tempdir().unwrap();
        let jar = dir.path().join("nested.jar");
        let descriptor = br#"{
            "quilt_loader": {
                "group": "com.example",
                "id": "nested",
                "version": "0.1.0",
                "depends": [
                    [{"id": "org.quiltmc:quilt_base"}, "fabric"],
                    {"id": "com.mojang:minecraft", "versions": {"any": [">=1.20", "<1.21"]}}
                ]
            }
        }"#;
        build_jar(&jar, &[("quilt.mod.json", descriptor)]);

        let meta = parse_mod_metadata(&jar).await.unwrap().unwrap();
        // 嵌套「任选其一」组被拉平，id 原样保留（含 maven group 前缀）。
        assert_eq!(
            meta.depends,
            vec!["org.quiltmc:quilt_base", "fabric", "com.mojang:minecraft"]
        );
        // 带 group 前缀也能认出是 minecraft，但 {any:[...]} 对象压不成一句话，不编。
        assert_eq!(meta.minecraft_version, None);
        assert_eq!(meta.name, None);
        assert!(meta.authors.is_empty());
    }

    #[tokio::test]
    async fn quilt_descriptor_wins_over_fabric_compat_shim() {
        let dir = tempfile::tempdir().unwrap();
        let jar = dir.path().join("dual.jar");
        build_jar(
            &jar,
            &[
                (
                    "fabric.mod.json",
                    br#"{"id":"dual_fabric","name":"Dual"}"# as &[u8],
                ),
                (
                    "quilt.mod.json",
                    br#"{"quilt_loader":{"group":"com.example","id":"dual","version":"1.0.0"}}"#,
                ),
            ],
        );

        let meta = parse_mod_metadata(&jar).await.unwrap().unwrap();
        assert_eq!(meta.mod_id, "dual");
        assert_eq!(meta.loader, ModLoader::Quilt);
        assert_eq!(meta.format, MetadataFormat::QuiltModJson);
    }

    #[test]
    fn old_metadata_json_without_new_fields_still_loads() {
        // 卷宗/缓存里可能躺着新增字段之前写下的数据，serde default 必须兜住。
        let legacy = serde_json::json!({
            "mod_id": "sodium",
            "name": "Sodium",
            "version": "0.5.3",
            "description": null,
            "authors": ["jellysquid3"],
            "loader": "fabric",
            "format": "fabric"
        });
        let meta: ModMetadata = serde_json::from_value(legacy).unwrap();
        assert_eq!(meta.mod_id, "sodium");
        assert!(meta.depends.is_empty());
        assert_eq!(meta.minecraft_version, None);
        assert_eq!(meta.icon, None);
        assert_eq!(meta.format, MetadataFormat::Fabric);
    }

    #[tokio::test]
    async fn fabric_icon_path_and_sized_map_are_both_read() {
        let dir = tempfile::tempdir().unwrap();
        let single = dir.path().join("single.jar");
        build_jar(
            &single,
            &[(
                "fabric.mod.json",
                br#"{"id":"single","icon":"assets/single/icon.png"}"#,
            )],
        );
        let meta = parse_mod_metadata(&single).await.unwrap().unwrap();
        assert_eq!(meta.icon.as_deref(), Some("assets/single/icon.png"));

        // 映射形态取数字尺寸最大的那张；数字比较而不是字典序（"128" 在字典序里小于 "64"）。
        let sized = dir.path().join("sized.jar");
        build_jar(
            &sized,
            &[(
                "fabric.mod.json",
                br#"{"id":"sized","icon":{"64":"a/64.png","128":"/a/128.png","16":"a/16.png"}}"#,
            )],
        );
        let meta = parse_mod_metadata(&sized).await.unwrap().unwrap();
        assert_eq!(meta.icon.as_deref(), Some("a/128.png"));

        let blank = dir.path().join("blank.jar");
        build_jar(
            &blank,
            &[("fabric.mod.json", br#"{"id":"blank","icon":"  "}"#)],
        );
        assert_eq!(
            parse_mod_metadata(&blank).await.unwrap().unwrap().icon,
            None
        );
    }

    #[tokio::test]
    async fn quilt_and_toml_icons_are_read() {
        let dir = tempfile::tempdir().unwrap();
        let quilt = dir.path().join("q.jar");
        build_jar(
            &quilt,
            &[(
                "quilt.mod.json",
                br#"{"quilt_loader":{"id":"q","metadata":{"icon":"./assets/q/icon.png"}}}"#,
            )],
        );
        assert_eq!(
            parse_mod_metadata(&quilt)
                .await
                .unwrap()
                .unwrap()
                .icon
                .as_deref(),
            Some("assets/q/icon.png")
        );

        let forge = dir.path().join("f.jar");
        build_jar(
            &forge,
            &[(
                "META-INF/mods.toml",
                b"modLoader=\"javafml\"\nloaderVersion=\"*\"\n[[mods]]\nmodId=\"f\"\nlogoFile=\"f_logo.png\"\n",
            )],
        );
        assert_eq!(
            parse_mod_metadata(&forge)
                .await
                .unwrap()
                .unwrap()
                .icon
                .as_deref(),
            Some("f_logo.png")
        );
    }

    #[tokio::test]
    async fn read_jar_entry_returns_bytes_none_for_missing_and_non_zip() {
        let dir = tempfile::tempdir().unwrap();
        let jar = dir.path().join("icon.jar");
        build_jar(&jar, &[("assets/x/icon.png", b"\x89PNGfake")]);
        assert_eq!(
            read_jar_entry(&jar, "assets/x/icon.png").await.unwrap(),
            Some(b"\x89PNGfake".to_vec())
        );
        assert_eq!(
            read_jar_entry(&jar, "assets/x/none.png").await.unwrap(),
            None
        );

        let not_zip = dir.path().join("plain.jar");
        std::fs::write(&not_zip, b"plain").unwrap();
        assert_eq!(read_jar_entry(&not_zip, "a.png").await.unwrap(), None);

        // jar 本身不存在是真实 IO 故障，不能伪装成「没有图标」。
        let missing = dir.path().join("ghost.jar");
        assert!(matches!(
            read_jar_entry(&missing, "a.png").await.unwrap_err(),
            Error::Base(aurora_base::Error::Io { .. })
        ));
    }

    #[test]
    fn unix_millis_keeps_sign_for_times_before_epoch() {
        let epoch = std::time::UNIX_EPOCH;
        assert_eq!(unix_millis(epoch), 0);
        assert_eq!(
            unix_millis(epoch + std::time::Duration::from_millis(1_500)),
            1_500
        );
        assert_eq!(
            unix_millis(epoch - std::time::Duration::from_millis(1_500)),
            -1_500
        );
    }

    #[tokio::test]
    async fn jar_without_descriptor_yields_none() {
        let dir = tempfile::tempdir().unwrap();
        let jar = dir.path().join("nolib.jar");
        build_jar(&jar, &[("com/example/Lib.class", b"not-metadata")]);
        assert!(parse_mod_metadata(&jar).await.unwrap().is_none());
    }

    #[tokio::test]
    async fn non_zip_file_yields_none() {
        let dir = tempfile::tempdir().unwrap();
        let jar = dir.path().join("garbage.jar");
        tokio::fs::write(&jar, b"this is not a zip").await.unwrap();
        assert!(parse_mod_metadata(&jar).await.unwrap().is_none());
    }

    #[tokio::test]
    async fn malformed_fabric_descriptor_errors() {
        let dir = tempfile::tempdir().unwrap();
        let jar = dir.path().join("broken.jar");
        build_jar(&jar, &[("fabric.mod.json", b"{ this is not json ")]);
        let err = parse_mod_metadata(&jar).await.unwrap_err();
        assert!(matches!(err, Error::Json { .. }));
    }

    /// 三段 description 取自真实 Mod：源码或 gradle.properties 里写的是合法的 `\n`，构建时展开成了
    /// 真换行，jar 里的 fabric.mod.json 因此带裸换行，Fabric Loader 照常加载。
    #[tokio::test]
    async fn scan_reads_real_descriptors_with_raw_newlines() {
        let dir = tempfile::tempdir().unwrap();
        let cases = [
            (
                "BetterGrassify.jar",
                "bettergrass",
                "Gamers can finally touch grass!?\nOptiFine's Fancy and Fast better grass for \
                 Fabric!",
            ),
            (
                "entity_model_features.jar",
                "entity_model_features",
                "This is an expansion of the ETF mod, it adds support for OptiFine format Custom \
                 Entity Model (CEM) resource packs.\nWhile still allowing you to disable this to \
                 use a different model mod :)",
            ),
            (
                "entity_texture_features.jar",
                "entity_texture_features",
                "Adds support for resource-pack driven features for entity textures including \
                 some OptiFine features\nSupports OptiFine:\n - Random & Custom textures\n - \
                 Emissive textures\nWith more features such as:\n - Blinking textures\n - Player \
                 Skin support",
            ),
        ];
        for (file_name, id, description) in cases {
            // description 不做 JSON 转义：字符串里的换行写进文件就是裸字节，与 jar 里的形态一致。
            let descriptor = format!(
                r#"{{
  "schemaVersion": 1,
  "id": "{id}",
  "version": "1.0.0",
  "description": "{description}",
  "authors": [{{"name": "Traben", "contact": {{"homepage": "https://example.invalid"}}}}],
  "depends": {{"minecraft": ">=1.21"}}
}}"#
            );
            build_jar(
                &dir.path().join(file_name),
                &[("fabric.mod.json", descriptor.as_bytes())],
            );
        }

        let mods = scan_mods_dir(dir.path()).await.unwrap();

        assert_eq!(mods.len(), cases.len());
        for ((file_name, id, description), listed) in cases.iter().zip(&mods) {
            assert_eq!(listed.file_name, *file_name);
            let meta = listed
                .metadata
                .as_ref()
                .expect("Loader 能加载就不该无元数据");
            assert_eq!(meta.mod_id, *id);
            assert_eq!(meta.description.as_deref(), Some(*description));
            // description 之后的字段也读到了，说明裸换行没有打乱后面的解析。
            assert_eq!(meta.authors, vec!["Traben"]);
            assert_eq!(meta.minecraft_version.as_deref(), Some(">=1.21"));
        }
    }

    #[tokio::test]
    async fn quilt_description_with_raw_newline_parses() {
        let dir = tempfile::tempdir().unwrap();
        let jar = dir.path().join("multiline.jar");
        let descriptor = r#"{
            "quilt_loader": {
                "id": "multiline",
                "version": "1.0.0",
                "metadata": {
                    "name": "Multiline",
                    "description": "第一行
第二行"
                },
                "depends": [{"id": "minecraft", "versions": ">=1.21"}]
            }
        }"#
        .as_bytes();
        build_jar(&jar, &[("quilt.mod.json", descriptor)]);

        let meta = parse_mod_metadata(&jar).await.unwrap().expect("应有元数据");
        assert_eq!(meta.mod_id, "multiline");
        assert_eq!(meta.description.as_deref(), Some("第一行\n第二行"));
        assert_eq!(meta.minecraft_version.as_deref(), Some(">=1.21"));
    }

    /// 解析一份描述文件，`literal` 是 description 两个引号之间的原始内容，返回解析出的值。
    fn description_of_literal(literal: &str) -> Option<String> {
        let descriptor = format!(r#"{{"id":"probe","description":"{literal}","name":"after"}}"#);
        let meta = parse_fabric_metadata(descriptor.as_bytes(), Path::new("probe.jar"))
            .unwrap_or_else(|error| panic!("{literal:?} 应当能解析: {error}"))
            .expect("应有元数据");
        // 字符串之后的字段还读得到，才说明字符串的边界没有判错。
        assert_eq!(meta.name.as_deref(), Some("after"));
        meta.description
    }

    #[test]
    fn string_lexing_matches_loader_tolerance() {
        let cases = [
            ("回车换行", "a\r\nb", "a\r\nb"),
            ("制表符", "a\tb", "a\tb"),
            ("多字节字符紧贴裸换行", "落樱\n花瓣", "落樱\n花瓣"),
            ("单引号转义", r"It\'s", "It's"),
            ("反斜杠接换行", "a\\\nb", "a\nb"),
            ("转义的反斜杠后是裸换行", "a\\\\\nb", "a\\\nb"),
            (
                "转义的引号后是裸换行",
                "say \\\"hi\\\"\ndone",
                "say \"hi\"\ndone",
            ),
            ("合法转义原样解读", "a\\nb\\tc\\u00e9\\/", "a\nb\tcé/"),
        ];
        for (label, literal, expected) in cases {
            assert_eq!(
                description_of_literal(literal).as_deref(),
                Some(expected),
                "{label}"
            );
        }
    }

    #[test]
    fn every_control_character_survives_as_its_own_value() {
        for code in 0x00..=0x1F_u8 {
            let control = char::from(code);
            let expected = format!("a{control}b");
            assert_eq!(
                description_of_literal(&expected).as_deref(),
                Some(expected.as_str()),
                "控制字符 U+{code:04X}"
            );
        }
    }

    /// 随机拼出带各种裸字节与转义的字符串，解析结果必须逐字等于拼接时记下的值。种子固定，失败可复现。
    #[test]
    fn randomized_string_literals_round_trip() {
        let fragments = [
            ("\n", "\n"),
            ("\r\n", "\r\n"),
            ("\t", "\t"),
            ("\u{1}", "\u{1}"),
            ("\\\\", "\\"),
            ("\\\"", "\""),
            ("\\'", "'"),
            ("\\\n", "\n"),
            ("\\n", "\n"),
            ("\\u0041", "A"),
            ("落", "落"),
            ("a", "a"),
            ("{", "{"),
            ("//", "//"),
        ];
        let mut state: u64 = 0x9E37_79B9_7F4A_7C15;
        let mut next = move |bound: usize| {
            state ^= state << 13;
            state ^= state >> 7;
            state ^= state << 17;
            usize::try_from(state % u64::try_from(bound).unwrap()).unwrap()
        };
        for _ in 0..500 {
            let mut literal = String::new();
            let mut expected = String::new();
            for _ in 0..next(40) {
                let (raw, value) = fragments[next(fragments.len())];
                literal.push_str(raw);
                expected.push_str(value);
            }
            assert_eq!(
                description_of_literal(&literal).as_deref(),
                Some(expected.as_str()),
                "{literal:?}"
            );
        }
    }

    #[test]
    fn leading_bom_is_skipped_once_like_the_loader() {
        let meta = parse_fabric_metadata(b"\xEF\xBB\xBF{\"id\":\"bom\"}", Path::new("bom.jar"))
            .unwrap()
            .expect("应有元数据");
        assert_eq!(meta.mod_id, "bom");
    }

    /// 容忍只放到 Loader 也放行的那几处：这些写法 Loader 同样拒绝，字段也照旧严格，一律是 JSON 错误。
    #[test]
    fn everything_else_stays_strict() {
        let cases: [(&str, &[u8]); 16] = [
            ("尾逗号", br#"{"id":"x",}"#),
            ("块注释", b"{\"id\":\"x\" /* c */}"),
            ("行注释", b"{\"id\":\"x\" // c\n}"),
            ("单引号串", br"{'id':'x'}"),
            ("无引号键", br#"{id:"x"}"#),
            ("字符串外的控制字符", b"{\"id\":\"x\"\x01}"),
            ("未闭合的字符串", b"{\"id\":\"x"),
            ("反斜杠收尾", b"{\"id\":\"x\\"),
            ("未知转义", br#"{"id":"\q"}"#),
            ("反斜杠接制表符", b"{\"id\":\"a\\\tb\"}"),
            ("反斜杠接回车", b"{\"id\":\"a\\\rb\"}"),
            ("残缺的 unicode 转义", br#"{"id":"\u12"}"#),
            ("两个 BOM", b"\xEF\xBB\xBF\xEF\xBB\xBF{\"id\":\"x\"}"),
            ("缺 id", b"{\"description\":\"a\nb\"}"),
            ("id 类型不对", br#"{"id":1}"#),
            (
                "description 类型不对",
                b"{\"id\":\"x\",\"description\":[\"a\nb\"]}",
            ),
        ];
        for (label, descriptor) in cases {
            let outcome = parse_fabric_metadata(descriptor, Path::new("strict.jar"));
            assert!(
                matches!(outcome, Err(Error::Json { .. })),
                "{label}: {outcome:?}"
            );
        }
    }

    #[tokio::test]
    async fn scan_detects_enabled_and_disabled_and_skips_non_jar() {
        let dir = tempfile::tempdir().unwrap();
        let mods = dir.path();
        build_jar(
            &mods.join("sodium.jar"),
            &[("fabric.mod.json", br#"{"id":"sodium","name":"Sodium"}"#)],
        );
        build_jar(
            &mods.join("lithium.jar.disabled"),
            &[("fabric.mod.json", br#"{"id":"lithium","name":"Lithium"}"#)],
        );
        tokio::fs::write(mods.join("readme.txt"), b"hi")
            .await
            .unwrap();

        let scanned = scan_mods_dir(mods).await.unwrap();
        assert_eq!(scanned.len(), 2);
        // 大小随目录枚举一并带出，与磁盘上的真实字节数一致。
        assert_eq!(
            scanned[1].size,
            std::fs::metadata(mods.join("sodium.jar")).unwrap().len()
        );
        assert!(scanned[1].size > 0);
        // 按文件名排序：lithium.jar.disabled 在 sodium.jar 前。
        assert_eq!(scanned[0].file_name, "lithium.jar.disabled");
        assert!(!scanned[0].enabled);
        assert_eq!(scanned[0].metadata.as_ref().unwrap().mod_id, "lithium");
        assert_eq!(scanned[1].file_name, "sodium.jar");
        assert!(scanned[1].enabled);
    }

    #[tokio::test]
    async fn disable_then_enable_roundtrip() {
        let dir = tempfile::tempdir().unwrap();
        let jar = dir.path().join("sodium.jar");
        build_jar(&jar, &[("fabric.mod.json", br#"{"id":"sodium"}"#)]);

        let disabled = disable_mod(&jar).await.unwrap();
        assert_eq!(disabled.file_name().unwrap(), "sodium.jar.disabled");
        assert!(!tokio::fs::try_exists(&jar).await.unwrap());
        assert!(tokio::fs::try_exists(&disabled).await.unwrap());

        let enabled = enable_mod(&disabled).await.unwrap();
        assert_eq!(enabled, jar);
        assert!(tokio::fs::try_exists(&jar).await.unwrap());
    }

    #[tokio::test]
    async fn enabling_already_enabled_is_noop() {
        let dir = tempfile::tempdir().unwrap();
        let jar = dir.path().join("sodium.jar");
        build_jar(&jar, &[("fabric.mod.json", br#"{"id":"sodium"}"#)]);
        let same = enable_mod(&jar).await.unwrap();
        assert_eq!(same, jar);
    }

    #[tokio::test]
    async fn disable_conflict_when_target_exists() {
        let dir = tempfile::tempdir().unwrap();
        let jar = dir.path().join("sodium.jar");
        let disabled = dir.path().join("sodium.jar.disabled");
        build_jar(&jar, &[("fabric.mod.json", br#"{"id":"sodium"}"#)]);
        build_jar(&disabled, &[("fabric.mod.json", br#"{"id":"sodium"}"#)]);

        let err = disable_mod(&jar).await.unwrap_err();
        match err {
            Error::ModStateConflict { path } => {
                assert_eq!(path.file_name().unwrap(), "sodium.jar.disabled")
            }
            other => panic!("期望 ModStateConflict，得到 {other:?}"),
        }
        // 原文件仍在（未被覆盖）。
        assert!(tokio::fs::try_exists(&jar).await.unwrap());
    }

    // ===== 元数据缓存 =====

    /// 把 jar 的内容换成另一个 mod id，并强制改掉修改时间，模拟「玩家换了个版本」。
    ///
    /// 直接写 mtime 而不是 sleep：判据是毫秒级的，靠等待既慢又会在快盘上偶发同毫秒。
    fn rewrite_jar_with_mtime(path: &Path, mod_id: &str, mtime: std::time::SystemTime) {
        build_jar(
            path,
            &[(
                "fabric.mod.json",
                format!(r#"{{"id":"{mod_id}"}}"#).as_bytes(),
            )],
        );
        let file = std::fs::File::options().write(true).open(path).unwrap();
        file.set_modified(mtime).unwrap();
    }

    fn epoch_plus(secs: u64) -> std::time::SystemTime {
        std::time::UNIX_EPOCH + std::time::Duration::from_secs(secs)
    }

    #[tokio::test]
    async fn cache_file_is_written_and_reused_without_reopening_jars() {
        let dir = tempfile::tempdir().unwrap();
        let cache = dir.path().join("cache.json");
        let jar = dir.path().join("sodium.jar");
        rewrite_jar_with_mtime(&jar, "sodium", epoch_plus(1_000));

        let first = scan_mods_dir_cached(dir.path(), Some(&cache))
            .await
            .unwrap();
        assert_eq!(first.len(), 1);
        assert_eq!(first[0].metadata.as_ref().unwrap().mod_id, "sodium");
        assert!(cache.exists(), "首轮扫描必须落下缓存文件");

        // 把 jar 替换成一个根本打不开的空文件，但保持大小与 mtime 不变——判据没变就该吃缓存。
        // 若缓存失效，这里只会得到 metadata: None，断言立刻挂掉。
        let stamp = std::fs::metadata(&jar).unwrap();
        let (size, mtime) = (stamp.len(), stamp.modified().unwrap());
        std::fs::write(&jar, vec![0_u8; size as usize]).unwrap();
        std::fs::File::options()
            .write(true)
            .open(&jar)
            .unwrap()
            .set_modified(mtime)
            .unwrap();

        let second = scan_mods_dir_cached(dir.path(), Some(&cache))
            .await
            .unwrap();
        assert_eq!(
            second[0].metadata.as_ref().unwrap().mod_id,
            "sodium",
            "判据未变时必须复用缓存，而不是重开 zip"
        );
    }

    #[tokio::test]
    async fn cache_misses_when_mtime_changes() {
        let dir = tempfile::tempdir().unwrap();
        let cache = dir.path().join("cache.json");
        let jar = dir.path().join("mod.jar");

        rewrite_jar_with_mtime(&jar, "before", epoch_plus(1_000));
        let first = scan_mods_dir_cached(dir.path(), Some(&cache))
            .await
            .unwrap();
        assert_eq!(first[0].metadata.as_ref().unwrap().mod_id, "before");

        // 同一个文件名，换内容也换修改时间：必须重新解析，读出新的 mod id。
        rewrite_jar_with_mtime(&jar, "after", epoch_plus(2_000));
        let second = scan_mods_dir_cached(dir.path(), Some(&cache))
            .await
            .unwrap();
        assert_eq!(
            second[0].metadata.as_ref().unwrap().mod_id,
            "after",
            "修改时间变了就必须重新解析，不能吃旧缓存"
        );
    }

    #[tokio::test]
    async fn cache_drops_entries_for_deleted_jars() {
        let dir = tempfile::tempdir().unwrap();
        let cache = dir.path().join("cache.json");
        let keep = dir.path().join("keep.jar");
        let gone = dir.path().join("gone.jar");
        rewrite_jar_with_mtime(&keep, "keep", epoch_plus(1_000));
        rewrite_jar_with_mtime(&gone, "gone", epoch_plus(1_000));

        scan_mods_dir_cached(dir.path(), Some(&cache))
            .await
            .unwrap();
        std::fs::remove_file(&gone).unwrap();
        let after = scan_mods_dir_cached(dir.path(), Some(&cache))
            .await
            .unwrap();
        assert_eq!(after.len(), 1);

        let persisted: ModMetadataCache =
            serde_json::from_slice(&std::fs::read(&cache).unwrap()).unwrap();
        assert!(
            persisted.entries.contains_key("keep.jar"),
            "还在的 jar 必须留在缓存里"
        );
        assert!(
            !persisted.entries.contains_key("gone.jar"),
            "已删除的 jar 不该继续占着缓存"
        );
    }

    #[tokio::test]
    async fn corrupt_cache_falls_back_to_full_parse() {
        let dir = tempfile::tempdir().unwrap();
        let cache = dir.path().join("cache.json");
        std::fs::write(&cache, b"{ this is not json").unwrap();
        let jar = dir.path().join("mod.jar");
        rewrite_jar_with_mtime(&jar, "sodium", epoch_plus(1_000));

        let mods = scan_mods_dir_cached(dir.path(), Some(&cache))
            .await
            .unwrap();
        assert_eq!(
            mods[0].metadata.as_ref().unwrap().mod_id,
            "sodium",
            "缓存损坏只该退化成全量重解析，不该让整份列表报错"
        );
        // 坏缓存已被本轮结果覆盖。
        let rebuilt: ModMetadataCache =
            serde_json::from_slice(&std::fs::read(&cache).unwrap()).unwrap();
        assert!(rebuilt.entries.contains_key("mod.jar"));
        assert_eq!(rebuilt.schema, CACHE_SCHEMA);
    }

    #[tokio::test]
    async fn cache_with_stale_schema_is_ignored() {
        let dir = tempfile::tempdir().unwrap();
        let cache = dir.path().join("cache.json");
        let jar = dir.path().join("mod.jar");
        rewrite_jar_with_mtime(&jar, "fresh", epoch_plus(1_000));
        let meta = std::fs::metadata(&jar).unwrap();
        // 判据与磁盘完全一致、但格式版本过期的缓存：内容必须被无视，否则会读出缓存里的旧 mod id。
        let stale = serde_json::json!({
            "schema": 0,
            "entries": {
                "mod.jar": {
                    "stamp": {"size": meta.len(), "mtime_ms": 1_000_000},
                    "metadata": {
                        "mod_id": "stale", "name": null, "version": null, "description": null,
                        "authors": [], "loader": "fabric", "format": "fabric"
                    }
                }
            }
        });
        std::fs::write(&cache, serde_json::to_vec(&stale).unwrap()).unwrap();

        let mods = scan_mods_dir_cached(dir.path(), Some(&cache))
            .await
            .unwrap();
        assert_eq!(mods[0].metadata.as_ref().unwrap().mod_id, "fresh");
    }

    /// 严格解析时代把带裸换行的 jar 判成无元数据缓存了下来。jar 没变，判据就一直命中，
    /// 放宽解析后已有用户的这些 Mod 只能靠缓存版本作废才读得出来。
    #[tokio::test]
    async fn parse_failure_cached_before_tolerance_is_reparsed() {
        let dir = tempfile::tempdir().unwrap();
        let cache = dir.path().join("cache.json");
        let jar = dir.path().join("emf.jar");
        build_jar(
            &jar,
            &[(
                "fabric.mod.json",
                b"{\"id\":\"entity_model_features\",\"description\":\"a\nb\"}",
            )],
        );
        std::fs::File::options()
            .write(true)
            .open(&jar)
            .unwrap()
            .set_modified(epoch_plus(1_000))
            .unwrap();
        // schema 写死成放宽之前的 1，不引用常量：这个用例保护的就是这次版本提升。
        let legacy = serde_json::json!({
            "schema": 1,
            "entries": {
                "emf.jar": {
                    "stamp": {"size": std::fs::metadata(&jar).unwrap().len(), "mtime_ms": 1_000_000},
                    "metadata": null
                }
            }
        });
        std::fs::write(&cache, serde_json::to_vec(&legacy).unwrap()).unwrap();

        let mods = scan_mods_dir_cached(dir.path(), Some(&cache))
            .await
            .unwrap();

        let meta = mods[0]
            .metadata
            .as_ref()
            .expect("旧缓存里的失败结果不能再命中");
        assert_eq!(meta.mod_id, "entity_model_features");
        assert_eq!(meta.description.as_deref(), Some("a\nb"));
        let persisted: ModMetadataCache =
            serde_json::from_slice(&std::fs::read(&cache).unwrap()).unwrap();
        assert_eq!(persisted.schema, CACHE_SCHEMA);
        assert!(persisted.entries["emf.jar"].metadata.is_some());
    }

    /// 文件一时打不开（被别的程序独占）：本轮按无元数据列出，但不写进缓存，下一轮重新解析。
    #[cfg(windows)]
    #[tokio::test]
    async fn transient_open_failure_is_not_cached_and_retried_next_scan() {
        use std::os::windows::fs::OpenOptionsExt;

        let dir = tempfile::tempdir().unwrap();
        let cache = dir.path().join("cache.json");
        rewrite_jar_with_mtime(&dir.path().join("ok.jar"), "ok", epoch_plus(1_000));
        let locked = dir.path().join("locked.jar");
        rewrite_jar_with_mtime(&locked, "locked", epoch_plus(1_000));

        // 不放行任何共享：扫描时的打开以共享冲突失败，正是杀毒或别的启动器占着文件时的样子。
        let held = std::fs::OpenOptions::new()
            .read(true)
            .share_mode(0)
            .open(&locked)
            .unwrap();
        let first = scan_mods_dir_cached(dir.path(), Some(&cache))
            .await
            .unwrap();
        assert_eq!(first.len(), 2);
        assert_eq!(first[0].file_name, "locked.jar");
        assert!(first[0].metadata.is_none(), "打不开的这一轮按无元数据列出");
        assert_eq!(first[1].metadata.as_ref().unwrap().mod_id, "ok");
        let persisted: ModMetadataCache =
            serde_json::from_slice(&std::fs::read(&cache).unwrap()).unwrap();
        assert!(persisted.entries.contains_key("ok.jar"));
        assert!(
            !persisted.entries.contains_key("locked.jar"),
            "瞬时的读盘失败不能当成「没有元数据」缓存下来"
        );

        drop(held);
        let second = scan_mods_dir_cached(dir.path(), Some(&cache))
            .await
            .unwrap();
        assert_eq!(
            second[0].metadata.as_ref().unwrap().mod_id,
            "locked",
            "文件能打开之后的下一轮必须重新解析"
        );
        let persisted: ModMetadataCache =
            serde_json::from_slice(&std::fs::read(&cache).unwrap()).unwrap();
        assert_eq!(
            persisted.entries["locked.jar"]
                .metadata
                .as_ref()
                .map(|m| m.mod_id.as_str()),
            Some("locked")
        );
    }

    /// 描述文件本身坏了（同一份字节每次都解析失败）：照旧缓存成「无元数据」，不每轮都重开 zip。
    #[tokio::test]
    async fn deterministic_descriptor_corruption_is_still_cached() {
        let dir = tempfile::tempdir().unwrap();
        let cache = dir.path().join("cache.json");
        let broken = dir.path().join("broken.jar");
        build_jar(&broken, &[("fabric.mod.json", b"{ this is not json ")]);
        std::fs::File::options()
            .write(true)
            .open(&broken)
            .unwrap()
            .set_modified(epoch_plus(1_000))
            .unwrap();

        let mods = scan_mods_dir_cached(dir.path(), Some(&cache))
            .await
            .unwrap();
        assert!(mods[0].metadata.is_none());
        let persisted: ModMetadataCache =
            serde_json::from_slice(&std::fs::read(&cache).unwrap()).unwrap();
        let entry = persisted
            .entries
            .get("broken.jar")
            .expect("描述文件损坏是确定性的结果，应当缓存");
        assert_eq!(entry.metadata, None);
        assert_eq!(entry.stamp.size, std::fs::metadata(&broken).unwrap().len());
        assert_eq!(entry.stamp.mtime_ms, 1_000_000);
    }

    /// mods.toml 不是合法 UTF-8 也是描述文件内容坏了，与 JSON 写坏同属确定性的结果：缓存下来，
    /// 不能因为它报出来的是 io 错误就当成读盘故障、每一轮都重开这个 jar。
    #[tokio::test]
    async fn non_utf8_mods_toml_is_cached_like_other_descriptor_corruption() {
        let dir = tempfile::tempdir().unwrap();
        let cache = dir.path().join("cache.json");
        let broken = dir.path().join("gbk-toml.jar");
        build_jar(
            &broken,
            &[(
                FORGE_DESCRIPTOR,
                b"modLoader=\"javafml\"\n# \xd6\xd0\xce\xc4\n",
            )],
        );
        std::fs::File::options()
            .write(true)
            .open(&broken)
            .unwrap()
            .set_modified(epoch_plus(2_000))
            .unwrap();

        let mods = scan_mods_dir_cached(dir.path(), Some(&cache))
            .await
            .unwrap();
        assert_eq!(mods.len(), 1);
        assert!(mods[0].metadata.is_none());
        let persisted: ModMetadataCache =
            serde_json::from_slice(&std::fs::read(&cache).unwrap()).unwrap();
        let entry = persisted
            .entries
            .get("gbk-toml.jar")
            .expect("mods.toml 编码不对是确定性的结果，应当缓存");
        assert_eq!(entry.metadata, None);
        assert_eq!(entry.stamp.mtime_ms, 2_000_000);
    }

    #[test]
    fn only_os_level_read_failures_count_as_transient() {
        let io = |kind: std::io::ErrorKind| std::io::Error::new(kind, "x");
        let open = |kind| {
            Error::Base(aurora_base::Error::Io {
                path: PathBuf::from("a.jar"),
                source: io(kind),
            })
        };
        let zip_io = |kind| Error::Zip {
            path: PathBuf::from("a.jar"),
            source: zip::result::ZipError::Io(io(kind)),
        };
        // 打不开、读到一半被拒：换个时机可能就好。
        assert!(is_transient_read_failure(&open(
            std::io::ErrorKind::PermissionDenied
        )));
        assert!(is_transient_read_failure(&open(
            std::io::ErrorKind::NotFound
        )));
        assert!(is_transient_read_failure(&zip_io(
            std::io::ErrorKind::PermissionDenied
        )));
        assert!(is_transient_read_failure(&zip_io(
            std::io::ErrorKind::Other
        )));
        // 校验和不对、压缩流损坏、文件被截断：同一份字节每次都一样。
        assert!(!is_transient_read_failure(&zip_io(
            std::io::ErrorKind::InvalidData
        )));
        assert!(!is_transient_read_failure(&zip_io(
            std::io::ErrorKind::InvalidInput
        )));
        assert!(!is_transient_read_failure(&zip_io(
            std::io::ErrorKind::UnexpectedEof
        )));
        assert!(!is_transient_read_failure(&Error::Zip {
            path: PathBuf::from("a.jar"),
            source: zip::result::ZipError::UnsupportedArchive("x"),
        }));
        let json = serde_json::from_str::<serde_json::Value>("{").unwrap_err();
        assert!(!is_transient_read_failure(&Error::Json {
            context: "a.jar".to_owned(),
            source: json,
        }));
    }

    #[tokio::test]
    async fn concurrent_scan_keeps_order_and_isolates_broken_jars() {
        let dir = tempfile::tempdir().unwrap();
        // 数量刻意超过并发窗口上限，逼出「回收一个补一个」那条补位路径。
        for index in 0..40 {
            let path = dir.path().join(format!("mod{index:02}.jar"));
            build_jar(
                &path,
                &[(
                    "fabric.mod.json",
                    format!(r#"{{"id":"mod{index:02}"}}"#).as_bytes(),
                )],
            );
        }
        // 一个根本不是 zip 的文件：它该被列出来且 metadata 为 None，而不是让整轮扫描失败。
        std::fs::write(dir.path().join("broken.jar"), b"not a zip at all").unwrap();

        let mods = scan_mods_dir_cached(dir.path(), None).await.unwrap();
        assert_eq!(mods.len(), 41);

        let names: Vec<&str> = mods.iter().map(|m| m.file_name.as_str()).collect();
        let mut sorted = names.clone();
        sorted.sort_unstable();
        assert_eq!(names, sorted, "并发解析后顺序仍必须按文件名稳定排列");

        let broken = mods.iter().find(|m| m.file_name == "broken.jar").unwrap();
        assert!(broken.metadata.is_none(), "坏 jar 按无元数据列出");
        assert_eq!(
            mods.iter().filter(|m| m.metadata.is_some()).count(),
            40,
            "其余 40 个必须都解析成功，不能被那个坏文件带偏"
        );
        // 逐条核对身份，确保并发回收时没有把结果串到别的下标上。
        for index in 0..40 {
            let name = format!("mod{index:02}.jar");
            let item = mods.iter().find(|m| m.file_name == name).unwrap();
            assert_eq!(
                item.metadata.as_ref().unwrap().mod_id,
                format!("mod{index:02}"),
                "{name} 的元数据被串到了别的 jar 上"
            );
        }
    }
}
