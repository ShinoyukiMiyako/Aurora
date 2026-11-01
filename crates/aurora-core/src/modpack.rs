//! 整合包导入为新实例。
//!
//! 来源有两种：平台上某整合包的一个版本（先下载到缓存目录），或用户选的本地 `.mrpack` / `.zip`。
//! 导入总是新建一个实例目录 `versions/<实例名>/`，按顺序：
//!
//! 1. 读清单、去掉用户选择跳过的可选文件、校验实例名并查重；CurseForge 包先把全部文件 id 换成下载
//!    地址——有作者禁止第三方分发、用户也还没手动下载认领的文件就在这一步整体报错，不先装几百 MB 游戏再
//!    告诉用户装不完。这一步不动游戏目录（[`Aurora::prepare_modpack`]），调用方可以在这之后占住实例名再往下走。
//! 2. 原子地建目录（同名即报错），写下带任务 id 的未完成标记（[`Aurora::import_modpack`] 从这里开始）。
//! 3. 装整合包要求的原版与加载器（与「安装版本」同一条路径，落在它们自然的版本目录里）。
//! 4. 在实例目录写一份以实例名为 id 的版本 JSON：有加载器时是加载器 JSON 的副本，原版时只
//!    `inheritsFrom` 原版。启动按 `inheritsFrom` 找客户端 jar，实例目录里不需要 jar。
//! 5. 实例强制隔离：整合包的 Mod 与配置只该出现在这个实例里。
//! 6. 放入认领到的手动下载文件、下载远程文件、解出覆盖文件（覆盖文件在后，作者打进包里的配置压过
//!    下载来的默认值）。
//! 7. 写整合包信息，去掉未完成标记。
//!
//! 任何一步失败或取消，都按未完成标记删掉这个实例目录；标记里的任务 id 保证只删本次建的目录。
//! 原版与加载器的自然版本目录留着：它们是完整可用的版本，别的实例也可能在用。

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use aurora_download::{CredentialScope, DownloadCredential, DownloadTask};
use aurora_instance::{
    AURORA_META_DIR, IncompleteKind, IncompleteMarker, IsolationOverride, MarkerStore,
    VERSIONS_DIR, VersionSettings, VersionSettingsStore,
};
use aurora_modpack::{
    CurseForgeFileRef, ModrinthFile, PackArchive, PackFormat, PackLoader, PackLoaderKind,
    RemoteFiles,
};
use aurora_modplatform::{CurseForgeClient, CurseForgeFile, CurseForgeMod, Platform};
use serde::{Deserialize, Serialize};

use crate::blocked::{BlockedFile, CLAIMS_DIR, ClaimedCopy, PACK_CACHE_DIR, place_claimed};
use crate::error::{CoreError, Result};
use crate::event::{CoreEvent, EventSink, emit};
use crate::facade::Aurora;
use crate::install::LoaderChoice;
use crate::instance_install::{MarkerSettlement, now_millis, template_stage};
use crate::resources::{
    curseforge_download_url, is_safe_file_name, join_landing, task_for_file_url,
};

/// 实例名的最大字符数：界面上要完整显示，路径也不宜过长。
pub const INSTANCE_NAME_MAX_CHARS: usize = 32;

/// 实例目录里的整合包信息文件名（在启动器元数据目录下）。
const MODPACK_INFO_FILE: &str = "modpack.json";
/// 整合包信息的格式版本；字段不兼容地变化时递增。
const MODPACK_INFO_SCHEMA: u32 = 1;
/// CurseForge 批量接口一次带多少个 id。接口文档没写上限，大整合包有四五百个文件，
/// 分批是为了让单个请求体与响应都保持在常规大小。
const CURSEFORGE_BATCH: usize = 200;
/// 平台整合包的下载缓存放多久还没删就算残留。
const STALE_PACK_CACHE_AGE: Duration = Duration::from_secs(7 * 24 * 60 * 60);

// CurseForge 的资源大类 id（与发现页分类表同一来源：官方分类接口的真实响应）。
const CF_CLASS_RESOURCE_PACKS: u32 = 12;
const CF_CLASS_SHADERS: u32 = 6552;
const CF_CLASS_DATA_PACKS: u32 = 6945;
const CF_CLASS_MODS: u32 = 6;

/// 整合包从哪来。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ModpackSource {
    /// 平台上的一个整合包版本（Modrinth 版本 id / CurseForge 文件 id）。
    Platform {
        platform: Platform,
        project_id: String,
        version_id: String,
    },
    /// 本地 `.mrpack` / `.zip`。
    File { path: PathBuf },
}

/// 本地整合包文件的预览，供导入前确认。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ModpackPreview {
    pub format: PackFormat,
    pub name: String,
    pub version: Option<String>,
    pub summary: Option<String>,
    pub author: Option<String>,
    pub minecraft: String,
    pub loader: Option<PackLoader>,
    /// 要下载的远程文件数。
    pub remote_files: usize,
    /// 导入后落进 `mods/` 的 Mod 数，与平台摘要同一口径（见 `count_pack_mods`）。
    pub mod_files: usize,
    /// 远程文件总字节数；平台没给齐每个文件的大小时为 `None`。
    pub remote_bytes: Option<u64>,
    /// 包内自带的覆盖文件数。
    pub override_files: usize,
    /// 覆盖文件总字节数。
    pub override_bytes: u64,
    /// 导入后落进 `mods/` 的每个文件，与 `mod_files` 同一口径（`mods.len() == mod_files`）：同一落点只留
    /// 一份、覆盖层胜出，按路径不分大小写排序。
    pub mods: Vec<PackModEntry>,
    /// 不直接落进 `mods/` 的可选远程文件（资源包、光影、配置等），排序同上。
    pub optional_extras: Vec<PackModEntry>,
    /// 作者不允许启动器直接下载、暂存位里也还没有校验通过的副本的文件：导入前要用户手动下载。
    pub blocked_files: Vec<BlockedFile>,
}

/// 整合包里的一个文件从哪来。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum PackFileOrigin {
    /// 清单里的远程文件，导入时下载。
    Remote,
    /// 包里自带的覆盖文件。
    Override,
}

/// 整合包里的一个文件导入时怎么拿到。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum PackFileAvailability {
    /// 启动器直接下载。
    Download,
    /// 包里自带。
    Bundled,
    /// 作者不允许启动器直接下载，要用户手动下载。
    Blocked,
    /// 受限文件，但已经从下载文件夹认领到了校验通过的副本。
    Claimed,
}

/// 预览里列出的一个文件。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PackModEntry {
    /// 相对实例目录的落点，正斜杠分隔。
    pub path: String,
    pub file_name: String,
    pub origin: PackFileOrigin,
    /// 可选文件（mrpack 里 `env.client` 为 `optional`），导入时可以跳过。
    pub optional: bool,
    /// CurseForge 远程文件的工程与文件 id；Modrinth 文件与覆盖文件为 `None`。
    pub project_id: Option<u32>,
    pub file_id: Option<u32>,
    pub availability: PackFileAvailability,
}

/// 导入时用户的选择。
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ImportSelection {
    /// 跳过不装的可选文件，取清单里的落点写法。
    pub excluded_optional: Vec<String>,
}

/// 落点是否直接在 `mods/` 下（加载器只读这一层）。`key` 已转小写。
fn directly_in_mods(key: &str) -> bool {
    key.strip_prefix("mods/")
        .is_some_and(|name| !name.is_empty() && !name.contains('/'))
}

/// 整合包导入后落进 `mods/` 的 Mod 数，平台摘要与本地预览都用它：清单里落点直接在 `mods/` 下的远程
/// 文件（CurseForge 是工程大类为 Mod 的那些），加上覆盖层里直接在 `mods/` 下的 `.jar`。
///
/// 覆盖层的 `mods/` 里常带说明与配置，所以只认 `.jar`；子目录里的文件加载器不读，也不算。同一落点只算
/// 一次：覆盖文件会盖掉同名的下载文件，叠起来的几层覆盖也只留一份。比较不分大小写，与 Windows 上落盘
/// 的结果一致。`overrides` 给去掉覆盖层前缀之后、相对实例目录的路径。
pub(crate) fn count_pack_mods<'a>(
    remote: impl IntoIterator<Item = &'a str>,
    overrides: impl IntoIterator<Item = &'a str>,
) -> usize {
    let mut landed: HashSet<String> = HashSet::new();
    for path in remote {
        let key = path.to_lowercase();
        if directly_in_mods(&key) {
            landed.insert(key);
        }
    }
    for path in overrides {
        let key = path.to_lowercase();
        if directly_in_mods(&key) && key.ends_with(".jar") {
            landed.insert(key);
        }
    }
    landed.len()
}

/// 一次整合包导入的结果。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ModpackInstallOutcome {
    /// 新实例的版本 id（即实例名）。
    pub version_id: String,
    /// 新实例目录。
    pub version_dir: PathBuf,
    /// 写进实例的整合包信息。
    pub modpack: InstanceModpack,
}

/// 实例里记下的整合包信息（`<实例>/<元数据目录>/modpack.json`）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct InstanceModpack {
    pub schema: u32,
    pub format: PackFormat,
    /// 来自平台时的平台与工程、版本；来自本地文件时都为 `None`。
    pub platform: Option<Platform>,
    pub project_id: Option<String>,
    pub version_id: Option<String>,
    /// 整合包自己的名字与版本（实例名可以被用户改成别的）。
    pub name: String,
    pub version: Option<String>,
    pub minecraft: String,
    pub loader: Option<PackLoader>,
    pub remote_files: usize,
    pub override_files: usize,
    /// 导入完成的时刻（Unix 秒）。
    pub installed_at: u64,
}

/// 实例名不可用的原因。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum InstanceNameRule {
    /// 去掉首尾空白后为空。
    Empty,
    /// 超过 [`INSTANCE_NAME_MAX_CHARS`] 个字符。
    TooLong,
    /// 含 Windows 文件名不允许的字符、控制字符，或以点开头/结尾。
    IllegalChar,
    /// Windows 保留设备名（CON、NUL、COM1……）。
    Reserved,
    /// 与已有版本目录或本次要装的游戏版本同名（不区分大小写）。
    Duplicate,
}

impl InstanceNameRule {
    /// 给用户看的原因。
    pub fn describe(self) -> &'static str {
        match self {
            InstanceNameRule::Empty => "名字不能为空",
            InstanceNameRule::TooLong => "名字最多 32 个字符",
            InstanceNameRule::IllegalChar => {
                "不能含 \\ / : * ? \" < > | 与控制字符，也不能以点开头或结尾"
            }
            InstanceNameRule::Reserved => "这是 Windows 的保留名",
            InstanceNameRule::Duplicate => "已有同名的版本或实例",
        }
    }
}

/// 校验实例名的写法（不查重），返回去掉首尾空白后的名字。
pub fn validate_instance_name(raw: &str) -> std::result::Result<String, InstanceNameRule> {
    let name = raw.trim();
    if name.is_empty() {
        return Err(InstanceNameRule::Empty);
    }
    if name.chars().count() > INSTANCE_NAME_MAX_CHARS {
        return Err(InstanceNameRule::TooLong);
    }
    if name.chars().any(|c| {
        matches!(c, '\\' | '/' | ':' | '*' | '?' | '"' | '<' | '>' | '|') || c.is_control()
    }) {
        return Err(InstanceNameRule::IllegalChar);
    }
    // 结尾的点会被 Windows 悄悄去掉；开头的点是隐藏目录，也和启动器元数据目录同一种写法。
    if name.starts_with('.') || name.ends_with('.') {
        return Err(InstanceNameRule::IllegalChar);
    }
    let stem = name.split('.').next().unwrap_or(name).trim_end();
    let upper = stem.to_ascii_uppercase();
    let reserved = matches!(upper.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || ["COM", "LPT"].iter().any(|prefix| {
            upper
                .strip_prefix(prefix)
                .is_some_and(|n| n.len() == 1 && matches!(n.as_bytes()[0], b'1'..=b'9'))
        });
    if reserved {
        return Err(InstanceNameRule::Reserved);
    }
    Ok(name.to_owned())
}

/// 读实例里的整合包信息；不是从整合包导入的实例返回 `None`。
pub async fn read_instance_modpack(version_dir: &Path) -> Result<Option<InstanceModpack>> {
    let path = version_dir.join(AURORA_META_DIR).join(MODPACK_INFO_FILE);
    let bytes = match tokio::fs::read(&path).await {
        Ok(bytes) => bytes,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(source) => return Err(aurora_base::Error::Io { path, source }.into()),
    };
    serde_json::from_slice(&bytes)
        .map(Some)
        .map_err(|source| CoreError::JsonFileInvalid { path, source })
}

/// 一个要下载的远程文件；Modrinth 清单可以给多个地址，前一个失败换下一个。
#[derive(Debug)]
struct RemoteDownload {
    task: DownloadTask,
    fallbacks: Vec<String>,
}

/// 准备好、还没落盘的一次整合包导入：包已在本地、清单已读、实例名已定并查过重，游戏目录还没动。
///
/// 导入拆成准备与落盘两步，是为了让调用方在实例名定下之后、建目录之前占住这个名字：平台整合包
/// 要先下载下来才读得到清单里的名字，而目录一旦建出来，启动、改名、删除就都能看见它。
#[derive(Debug)]
pub struct PreparedModpack {
    source: ModpackSource,
    name: String,
    pack_path: PathBuf,
    archive: PackArchive,
    remote: Vec<RemoteDownload>,
    /// 认领到暂存位的受限文件：导入时复制进实例，不下载。
    claimed: Vec<ClaimedCopy>,
    /// 平台整合包下载到的缓存目录，只属于这一次导入；本地文件为 `None`。
    cache_dir: Option<PathBuf>,
}

/// 清单里的远程文件准备成的样子：要下载的，与认领到暂存位、直接复制的。
#[derive(Debug, Default)]
struct RemotePlan {
    downloads: Vec<RemoteDownload>,
    claimed: Vec<ClaimedCopy>,
}

impl PreparedModpack {
    /// 导入后的实例名（也是版本 id）。
    pub fn name(&self) -> &str {
        &self.name
    }

    /// 导入出的实例将继承的原版 id（客户端 jar 与 natives 所在的版本目录）：有加载器时实例 JSON 是
    /// 加载器 JSON 的副本，它的 `inheritsFrom` 就是这个原版；导入也正是把原版装在这个自然版本目录里。
    /// 调用方据此在导入期间占住它，不必等实例 JSON 写出来再扫。
    pub fn base_version(&self) -> &str {
        &self.archive.manifest.minecraft
    }

    /// 不导入了：删掉平台整合包的下载缓存，本地文件不动。
    pub async fn discard(self) {
        remove_pack_cache(self.cache_dir.as_deref()).await;
    }
}

/// 下载来的包只是导入的中间产物；删不掉不影响任何实例，留日志即可。下载在建目录之前就失败时目录不存在。
async fn remove_pack_cache(dir: Option<&Path>) {
    let Some(dir) = dir else {
        return;
    };
    if let Err(err) = tokio::fs::remove_dir_all(dir).await
        && err.kind() != std::io::ErrorKind::NotFound
    {
        tracing::warn!(dir = %dir.display(), error = %err, "整合包下载缓存未能删除");
    }
}

/// 清掉下载缓存根下的残留，认领暂存位不动。
///
/// 导入结束后缓存就删了；进程被杀、或取消宽限期满丢弃了导入，目录会留下来，而它只属于那一次导入，不会再有
/// 人接手。比 [`STALE_PACK_CACHE_AGE`] 老的才算残留：再慢的导入也用不了这么久，不会删到别的导入手里的包。
/// 与删缓存同理，清不掉不影响导入，留日志即可。
async fn sweep_stale_pack_caches(root: &Path, now: SystemTime) {
    let mut entries = match tokio::fs::read_dir(root).await {
        Ok(entries) => entries,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return,
        Err(err) => {
            tracing::warn!(dir = %root.display(), error = %err, "读不了整合包下载缓存目录，这次不清残留");
            return;
        }
    };
    loop {
        let entry = match entries.next_entry().await {
            Ok(Some(entry)) => entry,
            Ok(None) => return,
            Err(err) => {
                tracing::warn!(dir = %root.display(), error = %err, "读不了整合包下载缓存目录，这次不清残留");
                return;
            }
        };
        if entry.file_name() == CLAIMS_DIR {
            continue;
        }
        let dir = entry.path();
        let stale = match entry.metadata().await.and_then(|meta| meta.modified()) {
            Ok(modified) => now
                .duration_since(modified)
                .is_ok_and(|age| age > STALE_PACK_CACHE_AGE),
            Err(err) => {
                tracing::warn!(dir = %dir.display(), error = %err, "读不了残留缓存的修改时间，留着");
                false
            }
        };
        if stale && let Err(err) = tokio::fs::remove_dir_all(&dir).await {
            tracing::warn!(dir = %dir.display(), error = %err, "整合包下载缓存的残留未能删除");
        }
    }
}

impl Aurora {
    /// 预览本地整合包文件：只读清单与条目表，不解压。CurseForge 清单有远程文件时要问两个批量接口才
    /// 数得出 Mod、算得出下载量（导入同样要问），没配 API key 或断网时与导入报同样的错。
    ///
    /// CurseForge 包里没给下载地址的文件逐个问 download-url 端点，作者不允许直接下载的列进
    /// `blocked_files`，暂存位里已有校验通过副本的记为已认领，落点被覆盖层盖住的不用下载、也不列。受限文件
    /// 不让预览失败：用户要在这一步就看到要手动下载哪些。
    pub async fn preview_modpack_file(&self, path: &Path) -> Result<ModpackPreview> {
        let archive = read_pack_blocking(path.to_path_buf()).await?;
        let remote = self
            .remote_facts(&archive.manifest.remote, BlockedProbe::Probe)
            .await?;
        let covered = override_landings(&archive);
        let mut claimed = HashSet::new();
        let mut blocked = Vec::new();
        for item in remote.entries.iter().filter_map(|e| e.blocked.as_ref()) {
            if covered.contains(&item.destination.to_lowercase()) {
                continue;
            }
            if self.claimed_copy(item).await?.is_some() {
                claimed.insert(item.file_id);
            } else {
                blocked.push(item.clone());
            }
        }
        Ok(preview_of(&archive, remote, &claimed, blocked))
    }

    /// 把整合包导入为新实例：[`Aurora::prepare_modpack`] 之后紧接 [`Aurora::import_modpack`]。
    /// 需要在建目录前占住实例名的调用方分开调用这两步。
    pub async fn install_modpack(
        &self,
        source: &ModpackSource,
        name: Option<&str>,
        selection: &ImportSelection,
        task_id: &str,
        events: Option<&EventSink>,
    ) -> Result<ModpackInstallOutcome> {
        let prepared = self
            .prepare_modpack(source, name, selection, events)
            .await?;
        self.import_modpack(prepared, task_id, events).await
    }

    /// 导入的第一步：拿到整合包（平台整合包先下载到缓存目录）、读清单、去掉 `selection` 里跳过的可选
    /// 文件、定下实例名并查重，把远程文件换成下载任务（CurseForge 禁止分发、又没认领到副本的文件在这里
    /// 整体报错，认领到的改为从暂存位复制）。`name` 缺省用整合包自己的名字。
    ///
    /// 不动游戏目录。之后交给 [`Aurora::import_modpack`]，不导入了就 [`PreparedModpack::discard`]。
    pub async fn prepare_modpack(
        &self,
        source: &ModpackSource,
        name: Option<&str>,
        selection: &ImportSelection,
        events: Option<&EventSink>,
    ) -> Result<PreparedModpack> {
        let (pack_path, cache_dir) = match source {
            ModpackSource::File { path } => (path.clone(), None),
            ModpackSource::Platform {
                platform,
                project_id,
                version_id,
            } => {
                self.download_platform_pack(*platform, project_id, version_id, events)
                    .await?
            }
        };
        match self
            .read_prepared(source, name, selection, &pack_path, events)
            .await
        {
            Ok((name, archive, remote)) => Ok(PreparedModpack {
                source: source.clone(),
                name,
                pack_path,
                archive,
                remote: remote.downloads,
                claimed: remote.claimed,
                cache_dir,
            }),
            Err(err) => {
                remove_pack_cache(cache_dir.as_deref()).await;
                Err(err)
            }
        }
    }

    /// 导入的第二步：建实例目录、写下带 `task_id` 的未完成标记，装游戏与加载器、下载远程文件、
    /// 解出覆盖文件、写整合包信息。任何一步失败都删掉这个实例目录；任务被强行放弃（future 被丢弃）
    /// 或这里删不掉时，由调用方经 [`Aurora::discard_modpack_import`] 按实例名再清一次。平台整合包的
    /// 下载缓存不论成败都删掉。
    pub async fn import_modpack(
        &self,
        prepared: PreparedModpack,
        task_id: &str,
        events: Option<&EventSink>,
    ) -> Result<ModpackInstallOutcome> {
        let PreparedModpack {
            source,
            name,
            pack_path,
            archive,
            remote,
            claimed,
            cache_dir,
        } = prepared;
        let outcome = self
            .import_into_new_dir(
                &archive,
                &pack_path,
                &source,
                name,
                RemotePlan {
                    downloads: remote,
                    claimed,
                },
                task_id,
                events,
            )
            .await;
        remove_pack_cache(cache_dir.as_deref()).await;
        outcome
    }

    /// 删掉一次没成的导入留下的实例目录 `versions/<name>`，返回目录原先是否存在。
    ///
    /// 调用方从定下实例名起就占住这个名字，并在占住之后经 [`Aurora::ensure_modpack_name_free`] 确认过
    /// 名字仍然空闲：这期间名下出现的目录只可能是这次导入建的，所以不看未完成标记——标记可能还没
    /// 来得及写下，也可能读不出来，按标记找会漏掉这两种半成品。
    pub async fn discard_modpack_import(&self, name: &str) -> Result<bool> {
        let dir = self.instance_dir(name)?;
        match tokio::fs::metadata(&dir).await {
            Ok(meta) if meta.is_dir() => {}
            Ok(_) => return Ok(false),
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(false),
            Err(source) => return Err(aurora_base::Error::Io { path: dir, source }.into()),
        }
        remove_instance_dir(&dir).await?;
        Ok(true)
    }

    /// 半成品删不掉时（文件被占用）把它的未完成标记落成这次导入的结局：否则标记一直停在进行中，
    /// 列表里看不出导入其实已经结束。保留原标记的开始时刻；原标记读不出来时取此刻，新标记覆盖它。
    pub async fn settle_modpack_import(
        &self,
        name: &str,
        task_id: &str,
        settlement: MarkerSettlement,
    ) -> Result<()> {
        let dir = self.instance_dir(name)?;
        let started_at = match MarkerStore::for_version_dir(&dir).load().await {
            Ok(Some(marker)) => marker.started_at,
            Ok(None) => now_millis(),
            Err(err) => {
                tracing::warn!(dir = %dir.display(), error = %err, "导入半成品的未完成标记读不出来，改写一份新的");
                now_millis()
            }
        };
        let marker = IncompleteMarker::pending(
            IncompleteKind::Modpack {
                task_id: task_id.to_owned(),
            },
            started_at,
        );
        self.settle_instance_marker(name, marker, settlement).await
    }

    /// 读清单、去掉跳过的可选文件、定实例名并查重、把远程文件换成下载任务。
    async fn read_prepared(
        &self,
        source: &ModpackSource,
        name: Option<&str>,
        selection: &ImportSelection,
        pack_path: &Path,
        events: Option<&EventSink>,
    ) -> Result<(String, PackArchive, RemotePlan)> {
        let mut archive = read_pack_blocking(pack_path.to_path_buf()).await?;
        let skipped = archive
            .manifest
            .remote
            .exclude_optional(&selection.excluded_optional)?;
        let manifest = &archive.manifest;
        let requested = name.unwrap_or(&manifest.name);
        let name = validate_instance_name(requested).map_err(|rule| name_error(requested, rule))?;
        if name.eq_ignore_ascii_case(&manifest.minecraft) {
            return Err(name_error(&name, InstanceNameRule::Duplicate));
        }
        self.ensure_modpack_name_free(&name).await?;
        let version_dir = self.game_dir().join(VERSIONS_DIR).join(&name);

        emit(
            events,
            CoreEvent::stage(format!(
                "读取整合包 {}：{} 个远程文件，{} 个覆盖文件",
                manifest.name,
                manifest.remote.len(),
                archive.overrides.len()
            )),
        );
        let remote = self
            .remote_downloads(&manifest.remote, &override_landings(&archive), &version_dir)
            .await?;
        tracing::debug!(%name, ?source, remote = remote.downloads.len(), claimed = remote.claimed.len(), skipped, "整合包导入已准备好");
        Ok((name, archive, remote))
    }

    #[allow(clippy::too_many_arguments)]
    async fn import_into_new_dir(
        &self,
        archive: &PackArchive,
        pack_path: &Path,
        source: &ModpackSource,
        name: String,
        remote: RemotePlan,
        task_id: &str,
        events: Option<&EventSink>,
    ) -> Result<ModpackInstallOutcome> {
        let version_dir = self.game_dir().join(VERSIONS_DIR).join(&name);
        create_instance_dir(&version_dir, &name).await?;
        // 名字下还留着的记录属于在启动器之外被删掉的同名旧实例，与新建实例同一处理：放在目录建成之后，
        // 撞名时那份记录是现有实例的；清不掉不拦导入，改动已记下待补，在这个实例的第一局记下之前一定先补上。
        if let Err(err) = self.forget_play_records(&name).await {
            tracing::warn!(%name, error = %err, "清掉同名旧实例的游玩记录失败，已记下待补");
        }
        write_marker(&version_dir, task_id).await?;
        let populated = self
            .populate_instance(
                archive,
                pack_path,
                source,
                &name,
                &version_dir,
                remote,
                events,
            )
            .await;
        match populated {
            Ok(modpack) => Ok(ModpackInstallOutcome {
                version_id: name,
                version_dir,
                modpack,
            }),
            Err(err) => {
                if let Err(cleanup) = remove_instance_dir(&version_dir).await {
                    tracing::error!(dir = %version_dir.display(), error = %cleanup, "导入失败后未能删除半成品实例");
                }
                Err(err)
            }
        }
    }

    #[allow(clippy::too_many_arguments)]
    async fn populate_instance(
        &self,
        archive: &PackArchive,
        pack_path: &Path,
        source: &ModpackSource,
        name: &str,
        version_dir: &Path,
        remote: RemotePlan,
        events: Option<&EventSink>,
    ) -> Result<InstanceModpack> {
        let manifest = &archive.manifest;
        let loader = manifest.loader.as_ref();
        let loader_version =
            loader.map(|l| strip_minecraft_prefix(&l.version, &manifest.minecraft));
        let installed = self
            .install(
                &manifest.minecraft,
                loader.map(|l| loader_choice(l.kind)),
                loader_version,
                events,
            )
            .await?;
        let natural = installed
            .loader
            .as_ref()
            .map_or(installed.vanilla.id.as_str(), |l| l.id.as_str());
        // 原版或加载器的自然版本 id 与实例同名时，安装已经把它写进了实例目录，两者没法共存，按重名
        // 处理。失败清理会连它一起删掉：同名目录在建实例前不存在，一定是这次装出来的。
        if natural.eq_ignore_ascii_case(name) || installed.vanilla.id.eq_ignore_ascii_case(name) {
            return Err(name_error(name, InstanceNameRule::Duplicate));
        }
        self.materialize_version_json(
            name,
            version_dir,
            &installed.vanilla.id,
            installed.loader.is_some().then_some(natural),
        )
        .await?;

        VersionSettingsStore::for_version_dir(version_dir)
            .save(&VersionSettings {
                isolation: IsolationOverride::Enabled,
                ..VersionSettings::default()
            })
            .await?;
        // 版本目录里有 mods/ 时启动链路无论全局档位如何都按隔离处理，这一步让导入的实例
        // 在任何隔离设置下都只用自己目录里的 Mod。
        let mods_dir = version_dir.join("mods");
        tokio::fs::create_dir_all(&mods_dir)
            .await
            .map_err(|source| aurora_base::Error::Io {
                path: mods_dir,
                source,
            })?;

        if !remote.claimed.is_empty() {
            emit(
                events,
                CoreEvent::stage(format!("放入 {} 个手动下载的文件", remote.claimed.len())),
            );
            place_claimed(&remote.claimed).await?;
        }
        let downloads = remote.downloads.len();
        if downloads > 0 {
            emit(
                events,
                CoreEvent::stage(format!("下载 {downloads} 个整合包文件")),
            );
            self.download_remote(remote.downloads, events).await?;
        }
        // 跳过的可选文件已从清单里去掉，记的是这个实例实际装进来的远程文件数（含手动下载的）。
        let remote_files = manifest.remote.len();

        let override_files = archive.overrides.len();
        if override_files > 0 {
            emit(
                events,
                CoreEvent::stage(format!("解出 {override_files} 个覆盖文件")),
            );
            let pack = pack_path.to_path_buf();
            let entries = archive.overrides.clone();
            let dest = version_dir.to_path_buf();
            let cancel = self.cancel_token().cloned();
            tokio::task::spawn_blocking(move || {
                let is_cancelled = || cancel.as_ref().is_some_and(|t| t.is_cancelled());
                aurora_modpack::extract_overrides(&pack, &entries, &dest, &is_cancelled)
            })
            .await??;
        }

        // 覆盖文件之后才补：包里自带的 options.txt 是作者调好的，按只补缺的规则原样留着，缺的服务器列表
        // 之类由默认设置补上。导入的实例一律隔离，套不套只看配置这一道闸。失败与其他步骤一样让导入失败。
        let template = self.apply_template(name).await?;
        if let crate::template::TemplateOutcome::Applied { copied, .. } = &template
            && !copied.is_empty()
        {
            emit(events, CoreEvent::stage(template_stage(&template)));
        }

        let (platform, project_id, version_id) = match source {
            ModpackSource::Platform {
                platform,
                project_id,
                version_id,
            } => (
                Some(*platform),
                Some(project_id.clone()),
                Some(version_id.clone()),
            ),
            ModpackSource::File { .. } => (None, None, None),
        };
        let info = InstanceModpack {
            schema: MODPACK_INFO_SCHEMA,
            format: manifest.format,
            platform,
            project_id,
            version_id,
            name: manifest.name.clone(),
            version: manifest.version.clone(),
            minecraft: manifest.minecraft.clone(),
            loader: manifest.loader.clone(),
            remote_files,
            override_files,
            installed_at: SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map_err(CoreError::SystemClock)?
                .as_secs(),
        };
        let meta = version_dir.join(AURORA_META_DIR);
        let bytes = serde_json::to_vec_pretty(&info).map_err(CoreError::JsonSerialize)?;
        aurora_base::fs::atomic_write(meta.join(MODPACK_INFO_FILE), &bytes).await?;
        MarkerStore::for_version_dir(version_dir).clear().await?;
        emit(
            events,
            CoreEvent::stage(format!("整合包已导入为实例 {name}")),
        );
        Ok(info)
    }

    /// 在实例目录写以实例名为 id 的版本 JSON。
    async fn materialize_version_json(
        &self,
        name: &str,
        version_dir: &Path,
        vanilla_id: &str,
        loader_id: Option<&str>,
    ) -> Result<()> {
        let layout = self.layout();
        let json = match loader_id {
            // 复制原文而不是经模型重新序列化：加载器 JSON 里有模型不认识的字段，丢了就启动不了。
            Some(loader_id) => {
                let path = layout.version_json(loader_id);
                let bytes =
                    tokio::fs::read(&path)
                        .await
                        .map_err(|source| aurora_base::Error::Io {
                            path: path.clone(),
                            source,
                        })?;
                let mut value: serde_json::Value = serde_json::from_slice(&bytes)
                    .map_err(|source| CoreError::JsonFileInvalid { path, source })?;
                value["id"] = serde_json::Value::String(name.to_owned());
                value
            }
            None => {
                let path = layout.version_json(vanilla_id);
                let bytes =
                    tokio::fs::read(&path)
                        .await
                        .map_err(|source| aurora_base::Error::Io {
                            path: path.clone(),
                            source,
                        })?;
                let vanilla: serde_json::Value = serde_json::from_slice(&bytes)
                    .map_err(|source| CoreError::JsonFileInvalid { path, source })?;
                let mut value = serde_json::json!({ "id": name, "inheritsFrom": vanilla_id });
                // 版本类型决定按「非正式版」隔离的档位，跟原版走。
                if let Some(kind) = vanilla.get("type") {
                    value["type"] = kind.clone();
                }
                value
            }
        };
        let bytes = serde_json::to_vec_pretty(&json).map_err(CoreError::JsonSerialize)?;
        aurora_base::fs::atomic_write(version_dir.join(format!("{name}.json")), &bytes).await?;
        Ok(())
    }

    /// 不区分大小写地检查 `versions/` 下有没有同名目录；有就报与准备阶段相同的重名错误。
    ///
    /// 准备阶段已经查过一次；调用方占住实例名之后要再查一次：两次之间别的命令可能抢先建了同名实例，
    /// 而只有占住之后仍然空闲，名下的目录才能认定是这次导入建的（见 [`Aurora::discard_modpack_import`]）。
    pub async fn ensure_modpack_name_free(&self, name: &str) -> Result<()> {
        let versions = self.game_dir().join(VERSIONS_DIR);
        let mut entries = match tokio::fs::read_dir(&versions).await {
            Ok(entries) => entries,
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(()),
            Err(source) => {
                return Err(aurora_base::Error::Io {
                    path: versions,
                    source,
                }
                .into());
            }
        };
        let wanted = name.to_lowercase();
        while let Some(entry) =
            entries
                .next_entry()
                .await
                .map_err(|source| aurora_base::Error::Io {
                    path: versions.clone(),
                    source,
                })?
        {
            if entry.file_name().to_string_lossy().to_lowercase() == wanted {
                return Err(name_error(name, InstanceNameRule::Duplicate));
            }
        }
        Ok(())
    }

    /// 平台整合包下载到缓存目录，返回包路径与它所在的临时目录。
    ///
    /// 目录每次导入一个、名字带随机后缀：同一个版本同时导入两次时，先结束的一路删目录不能动另一路手里的包。
    /// 代价是下载失败后分片没有下一次来续传，当场连目录删掉。
    ///
    /// CurseForge 包本体也可能不允许启动器直接下载：这时报的受限清单里只有这个包，用户从网页下载、认领进
    /// 暂存位后，重新安装直接读暂存副本，不再向 CDN 要，也没有要删的临时目录（暂存副本留给下次用）。
    async fn download_platform_pack(
        &self,
        platform: Platform,
        project_id: &str,
        version_id: &str,
        events: Option<&EventSink>,
    ) -> Result<(PathBuf, Option<PathBuf>)> {
        // 版本 id 要拼进缓存目录名。
        if !is_safe_file_name(version_id) {
            return Err(CoreError::InvalidProjectId {
                platform: platform.display_name(),
                project_id: format!("{project_id}/{version_id}"),
            });
        }
        let root = self.cache_root().join(PACK_CACHE_DIR);
        let platform_slug = match platform {
            Platform::Modrinth => "modrinth",
            Platform::CurseForge => "curseforge",
        };
        let suffix = fastrand::u32(..);
        let dir = root.join(format!("{platform_slug}-{version_id}-{suffix:08x}"));
        let (file_name, task) = match self
            .platform_file_task(platform, project_id, version_id, &dir, "")
            .await
        {
            Ok(found) => found,
            Err(err) => {
                let (pack, staged) = self.claimed_instead_of(err).await?;
                emit(
                    events,
                    CoreEvent::stage(format!("使用手动下载的整合包 {}", pack.file_name)),
                );
                return Ok((staged, None));
            }
        };
        sweep_stale_pack_caches(&root, SystemTime::now()).await;
        emit(events, CoreEvent::stage(format!("下载整合包 {file_name}")));
        let dest = task.dest.clone();
        let failure = match self
            .download_pool_reporting(events)
            .download_all(vec![task], None)
            .await
        {
            Ok(report) => report.failures.into_iter().next().map(|f| f.error),
            Err(err) => Some(err),
        };
        if let Some(err) = failure {
            remove_pack_cache(Some(&dir)).await;
            return Err(err.into());
        }
        Ok((dest, Some(dir)))
    }

    /// 把清单里的远程文件变成下载任务（落点都在实例目录下）；CurseForge 的受限文件认领到了就从暂存位复制，
    /// 落点在 `covered`（见 [`override_landings`]）里的不用管。
    async fn remote_downloads(
        &self,
        remote: &RemoteFiles,
        covered: &HashSet<String>,
        version_dir: &Path,
    ) -> Result<RemotePlan> {
        match remote {
            RemoteFiles::Modrinth(files) => {
                let scope = self.curseforge_cdn_scope();
                let credential = modrinth_cdn_credential(files, &scope, || {
                    self.curseforge_credential(&self.curseforge_client()?)
                })?;
                let mut downloads = Vec::with_capacity(files.len());
                for file in files {
                    let Some((first, rest)) = file.urls.split_first() else {
                        return Err(aurora_modpack::Error::ManifestInvalid {
                            document: "modrinth.index.json",
                            reason: format!("{} 没有下载地址", file.path),
                        }
                        .into());
                    };
                    let mut task =
                        DownloadTask::new(first.clone(), file.path.resolve_under(version_dir))
                            .with_sha1(file.sha1.clone())
                            .with_size(file.size);
                    // 凭据自带作用域，换到备用地址后引擎照样逐跳判定，所以只要有一个地址在 CDN 上就挂。
                    if let Some(credential) = &credential
                        && file.urls.iter().any(|url| on_cdn(&scope, url))
                    {
                        task = task.with_credential(credential.clone());
                    }
                    downloads.push(RemoteDownload {
                        task,
                        fallbacks: rest.to_vec(),
                    });
                }
                Ok(RemotePlan {
                    downloads,
                    claimed: Vec::new(),
                })
            }
            RemoteFiles::CurseForge(refs) if refs.is_empty() => Ok(RemotePlan::default()),
            RemoteFiles::CurseForge(refs) => {
                let client = self.curseforge_client()?;
                self.curseforge_downloads(&client, refs, covered, version_dir)
                    .await
            }
        }
    }

    /// CurseForge 清单里的文件 id 换成下载任务：落点按 [`CurseForgeIndex::locate`]，没给下载地址的再问
    /// download-url 端点，任务都挂上 CDN 下载凭据。作者禁止第三方分发的文件，落点被覆盖层盖住的跳过，暂存位
    /// 里有校验通过的副本就改为复制；还有没认领到的就汇总成一个错误，只列这些。
    async fn curseforge_downloads(
        &self,
        client: &CurseForgeClient,
        refs: &[CurseForgeFileRef],
        covered: &HashSet<String>,
        version_dir: &Path,
    ) -> Result<RemotePlan> {
        let index = CurseForgeIndex::fetch(client, refs).await?;
        let credential = self.curseforge_credential(client)?;
        let mut plan = RemotePlan::default();
        let mut blocked = Vec::new();
        for reference in refs {
            let (file, sub) = index.locate(reference)?;
            let dest = version_dir.join(sub).join(&file.file_name);
            let task = match file.to_download_task(&dest) {
                Some(task) => task,
                None => {
                    match curseforge_download_url(client, reference.project_id, reference.file_id)
                        .await?
                    {
                        Some(url) => task_for_file_url(url, &dest, file),
                        None => {
                            let item = index.blocked(reference, file, sub)?;
                            if covered.contains(&item.destination.to_lowercase()) {
                                continue;
                            }
                            match self.claimed_copy(&item).await? {
                                Some(staged) => plan.claimed.push(ClaimedCopy { staged, dest }),
                                None => blocked.push(item),
                            }
                            continue;
                        }
                    }
                }
            };
            plan.downloads.push(RemoteDownload {
                task: task.with_credential(credential.clone()),
                fallbacks: Vec::new(),
            });
        }
        if !blocked.is_empty() {
            return Err(CoreError::FileDistributionBlocked { files: blocked });
        }
        Ok(plan)
    }

    /// 远程文件的落点与总字节数。Modrinth 清单自带；CurseForge 要多问两个批量接口，没配 API key 时
    /// 与导入一样报 key 缺失（该源被禁用），没有远程文件时不问。`probe` 决定要不要逐个探出受限文件。
    pub(crate) async fn remote_facts(
        &self,
        remote: &RemoteFiles,
        probe: BlockedProbe,
    ) -> Result<RemoteFacts> {
        match remote {
            RemoteFiles::Modrinth(files) => Ok(RemoteFacts {
                entries: files
                    .iter()
                    .map(|f| RemoteEntry {
                        destination: f.path.as_str().to_owned(),
                        optional: f.optional,
                        project_id: None,
                        file_id: None,
                        blocked: None,
                    })
                    .collect(),
                bytes: Some(files.iter().map(|f| f.size).sum()),
            }),
            RemoteFiles::CurseForge(refs) if refs.is_empty() => Ok(RemoteFacts {
                entries: Vec::new(),
                bytes: Some(0),
            }),
            RemoteFiles::CurseForge(refs) => {
                curseforge_remote_facts(&self.curseforge_client()?, refs, probe).await
            }
        }
    }

    fn curseforge_cdn_scope(&self) -> CredentialScope {
        #[cfg(test)]
        if let Some(scope) = self.injected_curseforge_cdn_scope() {
            return scope.clone();
        }
        CredentialScope::curseforge_cdn()
    }

    /// 批量下载远程文件；失败的文件有备用地址就换地址再下一轮。
    async fn download_remote(
        &self,
        mut pending: Vec<RemoteDownload>,
        events: Option<&EventSink>,
    ) -> Result<()> {
        let pool = self.download_pool_reporting(events);
        loop {
            let tasks = pending.iter().map(|r| r.task.clone()).collect();
            let report = pool.download_all(tasks, None).await?;
            if report.failures.is_empty() {
                return Ok(());
            }
            let mut failed: HashMap<PathBuf, aurora_download::Error> = report
                .failures
                .into_iter()
                .map(|f| (f.task.dest, f.error))
                .collect();
            let mut retry = Vec::new();
            for mut item in pending {
                let Some(error) = failed.remove(&item.task.dest) else {
                    continue;
                };
                if item.fallbacks.is_empty() {
                    return Err(error.into());
                }
                tracing::warn!(url = %item.task.url, error = %error, "整合包文件下载失败，换备用地址");
                item.task.url = item.fallbacks.remove(0);
                retry.push(item);
            }
            pending = retry;
        }
    }
}

fn on_cdn(scope: &CredentialScope, url: &str) -> bool {
    reqwest::Url::parse(url).is_ok_and(|url| scope.allows(&url))
}

/// Modrinth 清单文件要用的 CDN 凭据。别的启动器导出的 .mrpack 会把 CurseForge 上的 Mod 写成 forgecdn 地址，
/// 这类地址与平台下载一样不带 key 就回 401；清单里没有这类地址时不去要 key，没配 key 也照常导入。
///
/// 没配 key 时，每个文件都还有别的地址可换就只记日志（CDN 那个地址回 401 后换下一个）；有文件只能从 CDN
/// 下载就在这里报错，不先装几百 MB 游戏再告诉用户装不完。key 配了但不合法是用户要改的错，不在此列。
fn modrinth_cdn_credential(
    files: &[ModrinthFile],
    scope: &CredentialScope,
    resolve: impl FnOnce() -> Result<DownloadCredential>,
) -> Result<Option<DownloadCredential>> {
    let has_cdn_url = files
        .iter()
        .any(|file| file.urls.iter().any(|url| on_cdn(scope, url)));
    if !has_cdn_url {
        return Ok(None);
    }
    match resolve() {
        Ok(credential) => Ok(Some(credential)),
        Err(CoreError::ModPlatform(aurora_modplatform::Error::CurseForgeKeyMissing))
            if files
                .iter()
                .all(|file| file.urls.iter().any(|url| !on_cdn(scope, url))) =>
        {
            tracing::warn!(
                "整合包里有 CurseForge CDN 地址但没配下载密钥，这些地址会失败，改走备用地址"
            );
            Ok(None)
        }
        Err(err) => Err(err),
    }
}

/// CurseForge 清单引用的文件与各自所属工程的大类。导入换下载任务、摘要与预览数 Mod 和算下载量都从这里
/// 取落点，保证「预先报的数」与「导入后真正落进去的」是同一条规则。
struct CurseForgeIndex {
    files: HashMap<u32, CurseForgeFile>,
    /// 批量工程接口回的整份工程：落点要它的大类，受限文件的网页链接要它的 links 与 slug。
    projects: HashMap<u32, CurseForgeMod>,
}

impl CurseForgeIndex {
    /// 全部文件 id 走批量文件接口、去重后的工程 id 走批量工程接口，各一个请求（超过一批时分批）。
    async fn fetch(client: &CurseForgeClient, refs: &[CurseForgeFileRef]) -> Result<Self> {
        let file_ids: Vec<u32> = refs.iter().map(|r| r.file_id).collect();
        let mut files: HashMap<u32, CurseForgeFile> = HashMap::with_capacity(refs.len());
        for chunk in file_ids.chunks(CURSEFORGE_BATCH) {
            for file in client.get_files(chunk).await? {
                files.insert(file.id, file);
            }
        }
        let mut mod_ids: Vec<u32> = refs
            .iter()
            .map(|r| r.project_id)
            .collect::<HashSet<_>>()
            .into_iter()
            .collect();
        mod_ids.sort_unstable();
        let mut projects: HashMap<u32, CurseForgeMod> = HashMap::with_capacity(mod_ids.len());
        for chunk in mod_ids.chunks(CURSEFORGE_BATCH) {
            for project in client.get_mods(chunk).await? {
                projects.insert(project.id, project);
            }
        }
        Ok(Self { files, projects })
    }

    /// 清单引用的文件与它在实例里的落点目录（工程的大类决定落进哪个目录）。平台响应里没有这个文件报
    /// 版本不存在，文件名带路径成分报不安全：两者导入都装不了，预先报数时也不该装作没事。
    fn locate(&self, reference: &CurseForgeFileRef) -> Result<(&CurseForgeFile, &'static str)> {
        let file =
            self.files
                .get(&reference.file_id)
                .ok_or_else(|| CoreError::ModVersionNotFound {
                    platform: Platform::CurseForge.display_name(),
                    project_id: reference.project_id.to_string(),
                    version_id: reference.file_id.to_string(),
                })?;
        if !is_safe_file_name(&file.file_name) {
            return Err(CoreError::UnsafeFileName {
                platform: Platform::CurseForge.display_name(),
                file_name: file.file_name.clone(),
            });
        }
        let class_id = self
            .projects
            .get(&reference.project_id)
            .and_then(|project| project.class_id);
        let sub = match class_id {
            Some(CF_CLASS_RESOURCE_PACKS) => "resourcepacks",
            Some(CF_CLASS_SHADERS) => "shaderpacks",
            // 数据包在整合包里是给全局数据包类 Mod 加载的，放实例根下的 datapacks/。
            Some(CF_CLASS_DATA_PACKS) => "datapacks",
            Some(CF_CLASS_MODS) => "mods",
            other => {
                tracing::warn!(project_id = reference.project_id, class_id = ?other, file = %file.file_name, "整合包文件的工程大类不认识，按 Mod 处理");
                "mods"
            }
        };
        Ok((file, sub))
    }

    /// 把一个受限文件拼成清单项。网页链接要工程信息：批量工程接口没回这个工程时，拼不出能打开的页面，
    /// 与文件缺失一样报不存在。
    fn blocked(
        &self,
        reference: &CurseForgeFileRef,
        file: &CurseForgeFile,
        sub: &str,
    ) -> Result<BlockedFile> {
        let project = self.projects.get(&reference.project_id).ok_or_else(|| {
            CoreError::ModVersionNotFound {
                platform: Platform::CurseForge.display_name(),
                project_id: reference.project_id.to_string(),
                version_id: reference.file_id.to_string(),
            }
        })?;
        Ok(BlockedFile::new(
            project,
            file,
            join_landing(sub, &file.file_name),
        ))
    }
}

/// 读远程文件的事实时要不要逐个探出受限文件：本地预览要（用户在导入前就该知道要手动下载哪些），平台
/// 摘要不要（只为数 Mod、报下载量，不为它多发请求）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum BlockedProbe {
    Probe,
    Skip,
}

/// 清单里的远程文件导入后落在哪、一共多大：平台摘要与本地预览据此数 Mod、报下载量。
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct RemoteFacts {
    /// 清单顺序的每个远程文件。
    pub(crate) entries: Vec<RemoteEntry>,
    /// 总字节数；平台没给齐每个文件的大小时为 `None`，不拿缺了几项的和冒充总量。
    pub(crate) bytes: Option<u64>,
}

impl RemoteFacts {
    /// 相对实例目录的落点，正斜杠分隔。
    pub(crate) fn destinations(&self) -> impl Iterator<Item = &str> {
        self.entries.iter().map(|entry| entry.destination.as_str())
    }
}

/// 一个远程文件的事实。
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct RemoteEntry {
    /// 相对实例目录的落点，正斜杠分隔。
    pub(crate) destination: String,
    pub(crate) optional: bool,
    /// CurseForge 的工程与文件 id；Modrinth 文件为 `None`。
    pub(crate) project_id: Option<u32>,
    pub(crate) file_id: Option<u32>,
    /// 作者不允许启动器直接下载时的清单项；没探（[`BlockedProbe::Skip`]）或不受限为 `None`。
    pub(crate) blocked: Option<BlockedFile>,
}

/// CurseForge 清单只有工程与文件 id：落点与大小经 [`CurseForgeIndex`] 向批量接口要。`probe` 为
/// [`BlockedProbe::Probe`] 时，没给下载地址的文件再逐个问 download-url 端点，判定与导入相同。
pub(crate) async fn curseforge_remote_facts(
    client: &CurseForgeClient,
    refs: &[CurseForgeFileRef],
    probe: BlockedProbe,
) -> Result<RemoteFacts> {
    let index = CurseForgeIndex::fetch(client, refs).await?;
    let mut entries = Vec::with_capacity(refs.len());
    let mut bytes = Some(0u64);
    for reference in refs {
        let (file, sub) = index.locate(reference)?;
        let blocked = match probe {
            BlockedProbe::Probe if file.download_url.is_none() => {
                match curseforge_download_url(client, reference.project_id, reference.file_id)
                    .await?
                {
                    Some(_) => None,
                    None => Some(index.blocked(reference, file, sub)?),
                }
            }
            BlockedProbe::Probe | BlockedProbe::Skip => None,
        };
        entries.push(RemoteEntry {
            destination: join_landing(sub, &file.file_name),
            optional: false,
            project_id: Some(reference.project_id),
            file_id: Some(reference.file_id),
            blocked,
        });
        bytes = bytes
            .zip(file.file_length)
            .map(|(sum, length)| sum + length);
    }
    Ok(RemoteFacts { entries, bytes })
}

/// 覆盖文件的落点，已转小写，与 Windows 上落盘的结果一致。覆盖文件在下载之后解出，落点相同的远程文件
/// 反正会被盖掉，受限的那些不必让用户手动下载。
fn override_landings(archive: &PackArchive) -> HashSet<String> {
    archive
        .overrides
        .iter()
        .map(|entry| entry.path.as_str().to_lowercase())
        .collect()
}

fn file_name_of(path: &str) -> String {
    path.rsplit('/').next().unwrap_or(path).to_owned()
}

/// 预览里的 Mod 清单与其他可选文件。Mod 清单与 [`count_pack_mods`] 同一口径：直接落在 `mods/` 下的远程
/// 文件，加上覆盖层 `mods/` 下的 `.jar`；同一落点不分大小写只留一份，覆盖层胜出（它会盖掉下载来的那份）。
fn pack_entries(
    archive: &PackArchive,
    remote: &RemoteFacts,
    claimed: &HashSet<u32>,
) -> (Vec<PackModEntry>, Vec<PackModEntry>) {
    let mut mods: HashMap<String, PackModEntry> = HashMap::new();
    let mut extras = Vec::new();
    for entry in &remote.entries {
        let availability = match &entry.blocked {
            Some(item) if claimed.contains(&item.file_id) => PackFileAvailability::Claimed,
            Some(_) => PackFileAvailability::Blocked,
            None => PackFileAvailability::Download,
        };
        let item = PackModEntry {
            path: entry.destination.clone(),
            file_name: file_name_of(&entry.destination),
            origin: PackFileOrigin::Remote,
            optional: entry.optional,
            project_id: entry.project_id,
            file_id: entry.file_id,
            availability,
        };
        let key = entry.destination.to_lowercase();
        if directly_in_mods(&key) {
            mods.insert(key, item);
        } else if entry.optional {
            extras.push(item);
        }
    }
    for entry in &archive.overrides {
        let key = entry.path.as_str().to_lowercase();
        if directly_in_mods(&key) && key.ends_with(".jar") {
            mods.insert(
                key,
                PackModEntry {
                    path: entry.path.as_str().to_owned(),
                    file_name: file_name_of(entry.path.as_str()),
                    origin: PackFileOrigin::Override,
                    optional: false,
                    project_id: None,
                    file_id: None,
                    availability: PackFileAvailability::Bundled,
                },
            );
        }
    }
    let mut mods: Vec<PackModEntry> = mods.into_values().collect();
    mods.sort_by_cached_key(|entry| entry.path.to_lowercase());
    extras.sort_by_cached_key(|entry| entry.path.to_lowercase());
    (mods, extras)
}

fn preview_of(
    archive: &PackArchive,
    remote: RemoteFacts,
    claimed: &HashSet<u32>,
    blocked_files: Vec<BlockedFile>,
) -> ModpackPreview {
    let manifest = &archive.manifest;
    let (mods, optional_extras) = pack_entries(archive, &remote, claimed);
    ModpackPreview {
        format: manifest.format,
        name: manifest.name.clone(),
        version: manifest.version.clone(),
        summary: manifest.summary.clone(),
        author: manifest.author.clone(),
        minecraft: manifest.minecraft.clone(),
        loader: manifest.loader.clone(),
        remote_files: manifest.remote.len(),
        mod_files: count_pack_mods(
            remote.destinations(),
            archive.overrides.iter().map(|entry| entry.path.as_str()),
        ),
        remote_bytes: remote.bytes,
        override_files: archive.overrides.len(),
        override_bytes: archive.overrides_bytes,
        mods,
        optional_extras,
        blocked_files,
    }
}

async fn read_pack_blocking(path: PathBuf) -> Result<PackArchive> {
    Ok(tokio::task::spawn_blocking(move || aurora_modpack::read_pack(&path)).await??)
}

fn name_error(name: &str, rule: InstanceNameRule) -> CoreError {
    CoreError::InstanceNameInvalid {
        name: name.to_owned(),
        rule,
    }
}

fn loader_choice(kind: PackLoaderKind) -> LoaderChoice {
    match kind {
        PackLoaderKind::Fabric => LoaderChoice::Fabric,
        PackLoaderKind::Quilt => LoaderChoice::Quilt,
        PackLoaderKind::Forge => LoaderChoice::Forge,
        PackLoaderKind::NeoForge => LoaderChoice::NeoForge,
    }
}

/// 有的导出工具把 Forge 版本写成 `1.20.1-47.2.0`，安装器地址要的是不带 MC 前缀的部分。
fn strip_minecraft_prefix<'a>(version: &'a str, minecraft: &str) -> &'a str {
    version
        .strip_prefix(minecraft)
        .and_then(|rest| rest.strip_prefix('-'))
        .unwrap_or(version)
}

/// 原子地建实例目录：同名目录已存在（含并发导入抢先建好）即报重名。
async fn create_instance_dir(version_dir: &Path, name: &str) -> Result<()> {
    if let Some(parent) = version_dir.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(|source| aurora_base::Error::Io {
                path: parent.to_path_buf(),
                source,
            })?;
    }
    match tokio::fs::create_dir(version_dir).await {
        Ok(()) => Ok(()),
        Err(err) if err.kind() == std::io::ErrorKind::AlreadyExists => {
            Err(name_error(name, InstanceNameRule::Duplicate))
        }
        Err(source) => Err(aurora_base::Error::Io {
            path: version_dir.to_path_buf(),
            source,
        }
        .into()),
    }
}

async fn write_marker(version_dir: &Path, task_id: &str) -> Result<()> {
    let marker = IncompleteMarker::pending(
        IncompleteKind::Modpack {
            task_id: task_id.to_owned(),
        },
        now_millis(),
    );
    MarkerStore::for_version_dir(version_dir)
        .save(&marker)
        .await?;
    Ok(())
}

async fn remove_instance_dir(version_dir: &Path) -> Result<()> {
    tokio::fs::remove_dir_all(version_dir)
        .await
        .map_err(|source| {
            aurora_base::Error::Io {
                path: version_dir.to_path_buf(),
                source,
            }
            .into()
        })
}

#[cfg(test)]
mod tests {
    use std::io::Write;

    use super::*;
    use crate::config::AuroraConfig;
    use aurora_instance::{IsolationPolicy, discover_versions};
    use sha1::{Digest, Sha1};
    use wiremock::matchers::{method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    fn write_pack(dest: &Path, index: &serde_json::Value, entries: &[(&str, &[u8])]) {
        let mut writer = zip::ZipWriter::new(std::fs::File::create(dest).unwrap());
        let options = zip::write::SimpleFileOptions::default();
        writer.start_file("modrinth.index.json", options).unwrap();
        writer
            .write_all(&serde_json::to_vec(index).unwrap())
            .unwrap();
        for (name, bytes) in entries {
            writer.start_file(*name, options).unwrap();
            writer.write_all(bytes).unwrap();
        }
        writer.finish().unwrap();
    }

    fn index(dependencies: serde_json::Value) -> serde_json::Value {
        serde_json::json!({
            "formatVersion": 1, "game": "minecraft", "versionId": "1.0.0", "name": "测试包",
            "summary": "只用于测试", "files": [], "dependencies": dependencies
        })
    }

    /// 让 mock 提供一个「空壳」原版 test：版本 JSON 无下载、无库，安装只落版本 JSON。
    async fn mount_vanilla(server: &MockServer) {
        let base = server.uri();
        Mock::given(method("GET"))
            .and(path("/manifest.json"))
            .respond_with(ResponseTemplate::new(200).set_body_string(format!(
                r#"{{"latest":{{"release":"test","snapshot":"test"}},
                    "versions":[{{"id":"test","type":"release","url":"{base}/test.json",
                    "time":"t","releaseTime":"t"}}]}}"#
            )))
            .mount(server)
            .await;
        Mock::given(method("GET"))
            .and(path("/test.json"))
            .respond_with(ResponseTemplate::new(200).set_body_string(
                r#"{"id":"test","type":"release","mainClass":"net.minecraft.client.main.Main"}"#,
            ))
            .mount(server)
            .await;
    }

    /// 别的启动器导出的 .mrpack 会把 CurseForge 上的 Mod 写成 forgecdn 地址，读包时放行。这些任务要带上
    /// 与 CurseForge 包同一份下载凭据，否则 CDN 回 401、整个导入失败；只有 Modrinth 地址的任务不带。
    #[tokio::test]
    async fn forgecdn_files_in_a_modrinth_pack_carry_the_download_credential() {
        const EDGE: &str = "https://edge.forgecdn.net/files/3040/523/jei.jar";
        const MEDIA: &str = "https://mediafilez.forgecdn.net/files/3040/524/rei.jar";
        const CDN: &str = "https://cdn.modrinth.com/data/x/sodium.jar";
        let server = MockServer::start().await;
        let tmp = tempfile::tempdir().unwrap();
        let aurora = aurora(tmp.path(), &server).with_curseforge_key("pack-key");
        let file = |name: &str, urls: &[&str]| {
            let urls: Vec<String> = urls.iter().map(|url| (*url).to_owned()).collect();
            modrinth_file(&format!("mods/{name}"), &urls, b"x")
        };
        let remote = RemoteFiles::Modrinth(vec![
            file("jei.jar", &[EDGE]),
            file("sodium.jar", &[CDN]),
            file("rei.jar", &[CDN, MEDIA]),
        ]);

        let plan = aurora
            .remote_downloads(&remote, &HashSet::new(), Path::new("D:/mc/versions/包"))
            .await
            .unwrap();

        let carried: Vec<bool> = plan
            .downloads
            .iter()
            .map(|download| download.task.credential.is_some())
            .collect();
        assert_eq!(carried, vec![true, false, true]);
        let credential = plan.downloads[0].task.credential.as_ref().unwrap();
        assert_eq!(
            credential.realm(),
            aurora_download::CredentialRealm::CurseForge
        );
        assert!(credential.applies_to(&reqwest::Url::parse(MEDIA).unwrap()));
        assert!(!credential.applies_to(&reqwest::Url::parse(CDN).unwrap()));
        assert_eq!(plan.downloads[2].fallbacks, vec![MEDIA.to_owned()]);
    }

    fn aurora(root: &Path, server: &MockServer) -> Aurora {
        let mc = root.join("mc");
        let mut aurora = Aurora::for_test(AuroraConfig::default(), root.join("data"), mc)
            .with_manifest_url(format!("{}/manifest.json", server.uri()))
            .with_fabric_base(server.uri())
            .with_modrinth_base(server.uri())
            .with_curseforge_base(server.uri());
        // 全局不隔离：导入的实例仍必须隔离，验证的是实例自己的强制隔离。
        aurora.set_isolation_policy(IsolationPolicy::Disabled);
        aurora
    }

    fn sha1_hex(bytes: &[u8]) -> String {
        Sha1::digest(bytes)
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect()
    }

    #[test]
    fn instance_name_rules_cover_each_boundary() {
        let ok = |raw: &str, expected: &str| {
            assert_eq!(
                validate_instance_name(raw).as_deref(),
                Ok(expected),
                "{raw:?}"
            );
        };
        let bad = |raw: &str, rule: InstanceNameRule| {
            assert_eq!(validate_instance_name(raw), Err(rule), "{raw:?}");
        };
        ok("  我的整合包 1.0  ", "我的整合包 1.0");
        ok(&"樱".repeat(32), &"樱".repeat(32));
        ok("COM0", "COM0");
        ok("COM10", "COM10");
        ok("Console", "Console");
        ok("a.b", "a.b");
        bad("", InstanceNameRule::Empty);
        bad(" \t ", InstanceNameRule::Empty);
        bad(&"樱".repeat(33), InstanceNameRule::TooLong);
        for c in ['\\', '/', ':', '*', '?', '"', '<', '>', '|', '\u{7}'] {
            bad(&format!("a{c}b"), InstanceNameRule::IllegalChar);
        }
        bad(".hidden", InstanceNameRule::IllegalChar);
        bad("pack.", InstanceNameRule::IllegalChar);
        for reserved in [
            "CON", "prn", "Aux", "nul", "COM1", "com9", "LPT1", "lpt9", "con.txt", "NUL .x",
        ] {
            bad(reserved, InstanceNameRule::Reserved);
        }
    }

    #[test]
    fn random_names_from_allowed_characters_pass_unchanged() {
        let seed = fastrand::u64(..);
        let mut rng = fastrand::Rng::with_seed(seed);
        let alphabet: Vec<char> = "abcXYZ019 -_+()[]樱花林落樱整合包".chars().collect();
        for _ in 0..500 {
            let len = rng.usize(1..=INSTANCE_NAME_MAX_CHARS);
            let raw: String = (0..len)
                .map(|_| alphabet[rng.usize(..alphabet.len())])
                .collect();
            let name = raw.trim().to_owned();
            if name.is_empty() {
                continue;
            }
            assert_eq!(
                validate_instance_name(&raw),
                Ok(name.clone()),
                "seed {seed}: {raw:?}"
            );
        }
    }

    /// 本地原版整合包：实例目录、只继承原版的版本 JSON、强制隔离、覆盖文件分层、整合包信息全部落盘。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn local_vanilla_pack_becomes_an_isolated_instance_with_modpack_info() {
        let server = MockServer::start().await;
        mount_vanilla(&server).await;
        let tmp = tempfile::tempdir().unwrap();
        let pack = tmp.path().join("测试包.mrpack");
        write_pack(
            &pack,
            &index(serde_json::json!({"minecraft": "test"})),
            &[
                ("overrides/config/a.txt", b"config-a"),
                ("overrides/options.txt", b"lang:en_us"),
                ("client-overrides/options.txt", b"lang:zh_cn"),
                ("server-overrides/server.properties", b"motd=x"),
            ],
        );
        let aurora = aurora(tmp.path(), &server);
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();

        let outcome = aurora
            .install_modpack(
                &ModpackSource::File { path: pack.clone() },
                Some(" 我的整合包 "),
                &ImportSelection::default(),
                "task-1",
                Some(&tx),
            )
            .await
            .unwrap();

        let dir = aurora.game_dir().join("versions").join("我的整合包");
        assert_eq!(outcome.version_id, "我的整合包");
        assert_eq!(outcome.version_dir, dir);
        let json: serde_json::Value =
            serde_json::from_slice(&std::fs::read(dir.join("我的整合包.json")).unwrap()).unwrap();
        assert_eq!(
            json,
            serde_json::json!({"id": "我的整合包", "inheritsFrom": "test", "type": "release"})
        );
        assert_eq!(
            std::fs::read(dir.join("options.txt")).unwrap(),
            b"lang:zh_cn"
        );
        assert_eq!(
            std::fs::read(dir.join("config").join("a.txt")).unwrap(),
            b"config-a"
        );
        assert!(!dir.join("server.properties").exists());
        assert!(dir.join("mods").is_dir());
        let settings = VersionSettingsStore::for_version_dir(&dir)
            .load()
            .await
            .unwrap();
        assert_eq!(settings.isolation, IsolationOverride::Enabled);
        assert_eq!(
            MarkerStore::for_version_dir(&dir).load().await.unwrap(),
            None,
            "导入成功后未完成标记删除"
        );

        let info = read_instance_modpack(&dir)
            .await
            .unwrap()
            .expect("应写有整合包信息");
        assert_eq!(info, outcome.modpack);
        assert_eq!(info.schema, MODPACK_INFO_SCHEMA);
        assert_eq!(info.format, PackFormat::Modrinth);
        assert_eq!(info.platform, None);
        assert_eq!(info.name, "测试包");
        assert_eq!(info.version.as_deref(), Some("1.0.0"));
        assert_eq!(info.minecraft, "test");
        assert_eq!(info.loader, None);
        assert_eq!((info.remote_files, info.override_files), (0, 2));
        assert!(info.installed_at > 1_700_000_000);

        // 启动链路看到的是一个独立实例：被发现、无加载器、全局不隔离时工作目录仍是实例目录。
        let scan = discover_versions(aurora.game_dir()).await.unwrap();
        let found = scan
            .versions
            .iter()
            .find(|v| v.id == "我的整合包")
            .expect("实例应被发现");
        assert!(!found.has_mod_loader());
        assert!(found.is_release());
        assert_eq!(
            aurora
                .resolve_working_dir("我的整合包")
                .await
                .unwrap()
                .working_dir,
            dir
        );

        drop(tx);
        let mut stages = Vec::new();
        while let Some(event) = rx.recv().await {
            if let CoreEvent::Stage(stage) = event {
                stages.push(stage);
            }
        }
        assert!(
            stages.iter().any(|s| s == "整合包已导入为实例 我的整合包"),
            "{stages:?}"
        );
    }

    /// 包里自带的 options.txt 压过默认设置，包里没有的服务器列表由默认设置补上；配置里关掉时一个都不补。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn imported_instance_gets_missing_files_from_the_template() {
        let server = MockServer::start().await;
        mount_vanilla(&server).await;
        let tmp = tempfile::tempdir().unwrap();
        let pack = tmp.path().join("测试包.mrpack");
        write_pack(
            &pack,
            &index(serde_json::json!({"minecraft": "test"})),
            &[("overrides/options.txt", b"lang:en_us")],
        );
        let aurora = aurora(tmp.path(), &server);
        let servers: Vec<u8> = (0..fastrand::usize(1..2048))
            .map(|_| fastrand::u8(..))
            .collect();
        let template = aurora.template_dir();
        std::fs::create_dir_all(&template).unwrap();
        std::fs::write(template.join("options.txt"), b"fov:90").unwrap();
        std::fs::write(template.join("servers.dat"), &servers).unwrap();
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();

        let outcome = aurora
            .install_modpack(
                &ModpackSource::File { path: pack.clone() },
                Some("带模板"),
                &ImportSelection::default(),
                "task-t",
                Some(&tx),
            )
            .await
            .unwrap();
        drop(tx);
        let dir = outcome.version_dir;
        assert_eq!(
            std::fs::read(dir.join("options.txt")).unwrap(),
            b"lang:en_us"
        );
        assert_eq!(std::fs::read(dir.join("servers.dat")).unwrap(), servers);
        let mut stages = Vec::new();
        while let Some(event) = rx.recv().await {
            if let CoreEvent::Stage(stage) = event {
                stages.push(stage);
            }
        }
        assert!(
            stages
                .iter()
                .any(|s| s == "沿用默认设置：补上 servers.dat（已有的 options.txt 保留不动）"),
            "{stages:?}"
        );

        let mut off = Aurora::for_test(
            AuroraConfig {
                new_instance_template: false,
                ..AuroraConfig::default()
            },
            tmp.path().join("data"),
            tmp.path().join("mc"),
        )
        .with_manifest_url(format!("{}/manifest.json", server.uri()));
        off.set_isolation_policy(IsolationPolicy::Disabled);
        let outcome = off
            .install_modpack(
                &ModpackSource::File { path: pack },
                Some("不带模板"),
                &ImportSelection::default(),
                "task-u",
                None,
            )
            .await
            .unwrap();
        let dir = outcome.version_dir;
        assert_eq!(
            std::fs::read(dir.join("options.txt")).unwrap(),
            b"lang:en_us"
        );
        assert!(!dir.join("servers.dat").exists());
    }

    /// 同名旧实例在启动器之外被删掉后，名字下的游玩记录还留着；导入同名整合包得到的是一个没玩过的新实例。
    /// 撞上现有实例的导入被拦下，不动那个实例的记录。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn imported_instance_does_not_inherit_records_of_a_vanished_namesake() {
        let server = MockServer::start().await;
        mount_vanilla(&server).await;
        let tmp = tempfile::tempdir().unwrap();
        let pack = tmp.path().join("RLCraft.mrpack");
        write_pack(&pack, &index(serde_json::json!({"minecraft": "test"})), &[]);
        let aurora = aurora(tmp.path(), &server);
        let hour = 3_600_000;
        for id in ["RLCraft", "现有", "别的"] {
            crate::playtime::record_play(aurora.data_dir(), aurora.game_dir(), id, 0, 10 * hour)
                .await
                .unwrap();
        }
        std::fs::create_dir_all(aurora.game_dir().join("versions").join("现有")).unwrap();
        let source = ModpackSource::File { path: pack.clone() };

        aurora
            .install_modpack(
                &source,
                Some("现有"),
                &ImportSelection::default(),
                "task-dup",
                None,
            )
            .await
            .unwrap_err();
        aurora
            .install_modpack(
                &source,
                Some("RLCraft"),
                &ImportSelection::default(),
                "task-1",
                None,
            )
            .await
            .unwrap();

        let summaries = aurora.play_summaries().await.unwrap();
        assert_eq!(summaries.keys().collect::<Vec<_>>(), vec!["别的", "现有"]);
        assert_eq!(summaries["现有"].playtime_min, 600);
    }

    /// Fabric 整合包：实例版本 JSON 是加载器 JSON 的副本（id 换成实例名，仍继承原版），被识别为带加载器。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn fabric_pack_copies_the_loader_json_under_the_instance_name() {
        let server = MockServer::start().await;
        mount_vanilla(&server).await;
        Mock::given(method("GET"))
            .and(path("/v2/versions/loader/test/0.15.0/profile/json"))
            .respond_with(ResponseTemplate::new(200).set_body_string(
                r#"{"id":"fabric-loader-0.15.0-test","inheritsFrom":"test","type":"release",
                    "mainClass":"net.fabricmc.loader.impl.launch.knot.KnotClient",
                    "arguments":{"game":[],"jvm":["-DFabricMcEmu= net.minecraft.client.main.Main "]},
                    "libraries":[]}"#,
            ))
            .mount(&server)
            .await;
        let tmp = tempfile::tempdir().unwrap();
        let pack = tmp.path().join("fabric.mrpack");
        write_pack(
            &pack,
            &index(serde_json::json!({"minecraft": "test", "fabric-loader": "0.15.0"})),
            &[],
        );
        let aurora = aurora(tmp.path(), &server);

        let prepared = aurora
            .prepare_modpack(
                &ModpackSource::File { path: pack },
                None,
                &ImportSelection::default(),
                None,
            )
            .await
            .unwrap();
        // 导入前预告的基底就是写出的实例 JSON 继承的那个原版，调用方据此在导入期间占住它。
        let base = prepared.base_version().to_owned();
        assert_eq!(base, "test");
        let outcome = aurora
            .import_modpack(prepared, "task-f", None)
            .await
            .unwrap();
        assert_eq!(outcome.version_id, "测试包");
        let dir = outcome.version_dir;
        let json: serde_json::Value =
            serde_json::from_slice(&std::fs::read(dir.join("测试包.json")).unwrap()).unwrap();
        assert_eq!(json["id"], "测试包");
        assert_eq!(json["inheritsFrom"], base.as_str());
        assert_eq!(
            aurora.inheritance_chain("测试包").await.unwrap(),
            vec![base.clone()]
        );
        assert_eq!(
            json["mainClass"],
            "net.fabricmc.loader.impl.launch.knot.KnotClient"
        );
        assert_eq!(
            json["arguments"]["jvm"][0],
            "-DFabricMcEmu= net.minecraft.client.main.Main "
        );
        assert_eq!(
            outcome.modpack.loader,
            Some(PackLoader {
                kind: PackLoaderKind::Fabric,
                version: "0.15.0".into()
            })
        );
        let scan = discover_versions(aurora.game_dir()).await.unwrap();
        let found = scan.versions.iter().find(|v| v.id == "测试包").unwrap();
        assert!(found.has_mod_loader(), "加载器应能从实例 JSON 识别出来");
    }

    /// 平台整合包：先下载到缓存，导入后缓存删掉，整合包信息记下平台、工程与版本。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn platform_pack_is_downloaded_imported_and_its_cache_removed() {
        let server = MockServer::start().await;
        mount_vanilla(&server).await;
        let tmp = tempfile::tempdir().unwrap();
        let built = tmp.path().join("built.mrpack");
        write_pack(
            &built,
            &index(serde_json::json!({"minecraft": "test"})),
            &[("overrides/options.txt", b"fov:90")],
        );
        let bytes = std::fs::read(&built).unwrap();
        Mock::given(method("GET"))
            .and(path("/version/pv1"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "id": "pv1", "project_id": "proj", "name": "1.0.0", "version_number": "1.0.0",
                "version_type": "release", "date_published": "2026-01-01T00:00:00Z",
                "files": [{"hashes": {"sha1": sha1_hex(&bytes)},
                           "url": format!("{}/files/pack.mrpack", server.uri()),
                           "filename": "测试包 1.0.0.mrpack", "primary": true, "size": bytes.len()}]
            })))
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path("/files/pack.mrpack"))
            .respond_with(ResponseTemplate::new(200).set_body_bytes(bytes))
            .mount(&server)
            .await;
        let aurora = aurora(tmp.path(), &server);
        let source = ModpackSource::Platform {
            platform: Platform::Modrinth,
            project_id: "proj".into(),
            version_id: "pv1".into(),
        };

        let outcome = aurora
            .install_modpack(
                &source,
                Some("从平台装"),
                &ImportSelection::default(),
                "task-p",
                None,
            )
            .await
            .unwrap();
        assert_eq!(outcome.modpack.platform, Some(Platform::Modrinth));
        assert_eq!(outcome.modpack.project_id.as_deref(), Some("proj"));
        assert_eq!(outcome.modpack.version_id.as_deref(), Some("pv1"));
        assert_eq!(
            std::fs::read(outcome.version_dir.join("options.txt")).unwrap(),
            b"fov:90"
        );
        assert_eq!(
            pack_cache_entries(tmp.path()),
            Vec::<String>::new(),
            "下载缓存应在导入后删除"
        );
    }

    /// 准备一步不动游戏目录：名字已定、平台包已下到缓存，但实例目录还没建；放弃时缓存删掉。
    /// 准备失败（名字不合法）时同样不留缓存。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn prepare_leaves_the_game_dir_alone_and_discard_removes_the_cache() {
        let server = MockServer::start().await;
        let tmp = tempfile::tempdir().unwrap();
        let built = tmp.path().join("built.mrpack");
        write_pack(
            &built,
            &index(serde_json::json!({"minecraft": "test"})),
            &[],
        );
        let bytes = std::fs::read(&built).unwrap();
        Mock::given(method("GET"))
            .and(path("/version/pv2"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "id": "pv2", "project_id": "proj", "name": "1.0.0", "version_number": "1.0.0",
                "version_type": "release", "date_published": "2026-01-01T00:00:00Z",
                "files": [{"hashes": {"sha1": sha1_hex(&bytes)},
                           "url": format!("{}/files/pack.mrpack", server.uri()),
                           "filename": "pack.mrpack", "primary": true, "size": bytes.len()}]
            })))
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path("/files/pack.mrpack"))
            .respond_with(ResponseTemplate::new(200).set_body_bytes(bytes))
            .mount(&server)
            .await;
        let aurora = aurora(tmp.path(), &server);
        let source = ModpackSource::Platform {
            platform: Platform::Modrinth,
            project_id: "proj".into(),
            version_id: "pv2".into(),
        };

        let prepared = aurora
            .prepare_modpack(&source, None, &ImportSelection::default(), None)
            .await
            .unwrap();
        assert_eq!(prepared.name(), "测试包");
        let cache = prepared.cache_dir.clone().expect("平台包有下载缓存");
        assert!(
            cache.starts_with(tmp.path().join("data").join("cache").join("modpacks")),
            "{cache:?}"
        );
        assert!(cache.join("pack.mrpack").is_file(), "平台包应已下到缓存");
        assert!(
            !aurora.game_dir().join("versions").join("测试包").exists(),
            "准备一步不建实例目录"
        );
        prepared.discard().await;
        assert_eq!(
            pack_cache_entries(tmp.path()),
            Vec::<String>::new(),
            "放弃导入时删掉下载缓存"
        );

        let err = aurora
            .prepare_modpack(&source, Some("a/b"), &ImportSelection::default(), None)
            .await
            .unwrap_err();
        assert!(matches!(
            err,
            CoreError::InstanceNameInvalid {
                rule: InstanceNameRule::IllegalChar,
                ..
            }
        ));
        assert_eq!(
            pack_cache_entries(tmp.path()),
            Vec::<String>::new(),
            "准备失败也不留下载缓存"
        );
    }

    /// 挂上一个平台版本：`sha1` 是版本信息里声明的包哈希，`bytes` 是下载时真正回的内容。
    async fn mount_platform_pack(
        server: &MockServer,
        version_id: &str,
        sha1: &str,
        bytes: Vec<u8>,
    ) {
        let file = format!("/files/{version_id}.mrpack");
        Mock::given(method("GET"))
            .and(path(format!("/version/{version_id}")))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "id": version_id, "project_id": "proj", "name": "1.0.0", "version_number": "1.0.0",
                "version_type": "release", "date_published": "2026-01-01T00:00:00Z",
                "files": [{"hashes": {"sha1": sha1},
                           "url": format!("{}{file}", server.uri()),
                           "filename": "pack.mrpack", "primary": true, "size": bytes.len()}]
            })))
            .mount(server)
            .await;
        Mock::given(method("GET"))
            .and(path(file))
            .respond_with(ResponseTemplate::new(200).set_body_bytes(bytes))
            .mount(server)
            .await;
    }

    fn platform_source(version_id: &str) -> ModpackSource {
        ModpackSource::Platform {
            platform: Platform::Modrinth,
            project_id: "proj".into(),
            version_id: version_id.into(),
        }
    }

    /// `<缓存根>/modpacks` 下现有的条目名，排好序；目录还没建出来算没有。
    fn pack_cache_entries(root: &Path) -> Vec<String> {
        let dir = root.join("data").join("cache").join("modpacks");
        let Ok(entries) = std::fs::read_dir(dir) else {
            return Vec::new();
        };
        let mut names: Vec<String> = entries
            .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        names.sort();
        names
    }

    /// 同一个平台版本同时导入两次：先结束的一路删自己的缓存，另一路手里的包还在，照常导入完。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn concurrent_imports_of_one_platform_version_keep_their_own_cache() {
        let server = MockServer::start().await;
        mount_vanilla(&server).await;
        let tmp = tempfile::tempdir().unwrap();
        let built = tmp.path().join("built.mrpack");
        write_pack(
            &built,
            &index(serde_json::json!({"minecraft": "test"})),
            &[("overrides/options.txt", b"fov:90")],
        );
        let bytes = std::fs::read(&built).unwrap();
        mount_platform_pack(&server, "pv3", &sha1_hex(&bytes), bytes).await;
        let aurora = aurora(tmp.path(), &server);
        let source = platform_source("pv3");
        let none = ImportSelection::default();

        let (first, second) = tokio::join!(
            aurora.prepare_modpack(&source, Some("第一份"), &none, None),
            aurora.prepare_modpack(&source, Some("第二份"), &none, None),
        );
        let (first, second) = (first.unwrap(), second.unwrap());
        first.discard().await;
        let outcome = aurora
            .import_modpack(second, "task-second", None)
            .await
            .unwrap();

        assert_eq!(
            std::fs::read(outcome.version_dir.join("options.txt")).unwrap(),
            b"fov:90"
        );
        assert_eq!(
            pack_cache_entries(tmp.path()),
            Vec::<String>::new(),
            "两路都结束后不留缓存"
        );
    }

    /// 缓存目录只属于这一次导入，下载失败时没有下一次来接手，当场删掉。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn failed_pack_download_leaves_no_cache_behind() {
        let server = MockServer::start().await;
        let tmp = tempfile::tempdir().unwrap();
        // 回来的内容与声明的哈希对不上：下载走到了落盘这一步才失败，目录已经建出来了。
        mount_platform_pack(&server, "pv4", &"0".repeat(40), b"not the pack".to_vec()).await;
        let aurora = aurora(tmp.path(), &server);

        let err = aurora
            .prepare_modpack(
                &platform_source("pv4"),
                None,
                &ImportSelection::default(),
                None,
            )
            .await
            .unwrap_err();

        assert!(matches!(err, CoreError::Download(_)), "{err:?}");
        assert_eq!(pack_cache_entries(tmp.path()), Vec::<String>::new());
    }

    /// 被杀掉的进程留下的目录只有这一步能清掉；新近的目录可能正被别的导入用着，认领暂存位导入后也要留着。
    #[tokio::test]
    async fn sweeping_removes_only_stale_pack_caches() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("data").join("cache").join("modpacks");
        for dir in [
            "claims/curseforge-1",
            "modrinth-v1-0000beef",
            "curseforge-7-1234abcd",
        ] {
            std::fs::create_dir_all(root.join(dir)).unwrap();
            std::fs::write(root.join(dir).join("pack.zip"), b"x").unwrap();
        }

        sweep_stale_pack_caches(&root, SystemTime::now()).await;
        assert_eq!(
            pack_cache_entries(tmp.path()),
            vec!["claims", "curseforge-7-1234abcd", "modrinth-v1-0000beef"],
            "没过期的都留着"
        );

        let later = SystemTime::now() + STALE_PACK_CACHE_AGE + Duration::from_secs(60);
        sweep_stale_pack_caches(&root, later).await;
        assert_eq!(pack_cache_entries(tmp.path()), vec!["claims"]);
        assert!(root.join("claims/curseforge-1/pack.zip").is_file());
    }

    /// 下载平台整合包时顺手清残留：上一次被杀掉的进程留下的目录在这里消失，新近的目录不动。
    #[cfg(windows)]
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn downloading_a_platform_pack_sweeps_caches_left_by_a_killed_run() {
        use std::os::windows::fs::OpenOptionsExt;

        const FILE_WRITE_ATTRIBUTES: u32 = 0x100;
        const FILE_FLAG_BACKUP_SEMANTICS: u32 = 0x0200_0000;

        let server = MockServer::start().await;
        let tmp = tempfile::tempdir().unwrap();
        let built = tmp.path().join("built.mrpack");
        write_pack(
            &built,
            &index(serde_json::json!({"minecraft": "test"})),
            &[],
        );
        let bytes = std::fs::read(&built).unwrap();
        mount_platform_pack(&server, "pv5", &sha1_hex(&bytes), bytes).await;
        let root = tmp.path().join("data").join("cache").join("modpacks");
        let stale = root.join("modrinth-old-0000dead");
        let fresh = root.join("modrinth-new-0000beef");
        std::fs::create_dir_all(&stale).unwrap();
        std::fs::create_dir_all(&fresh).unwrap();
        // Windows 上打开目录要带这个标志。
        std::fs::OpenOptions::new()
            .access_mode(FILE_WRITE_ATTRIBUTES)
            .custom_flags(FILE_FLAG_BACKUP_SEMANTICS)
            .open(&stale)
            .unwrap()
            .set_modified(SystemTime::now() - STALE_PACK_CACHE_AGE - Duration::from_secs(60))
            .unwrap();
        let aurora = aurora(tmp.path(), &server);

        let prepared = aurora
            .prepare_modpack(
                &platform_source("pv5"),
                None,
                &ImportSelection::default(),
                None,
            )
            .await
            .unwrap();

        assert!(!stale.exists(), "残留应被清掉");
        assert!(fresh.is_dir(), "新近的目录可能正被别的导入用着");
        prepared.discard().await;
    }

    /// 还没有缓存目录时什么也不用清。
    #[tokio::test]
    async fn sweeping_a_missing_cache_root_is_a_no_op() {
        let tmp = tempfile::tempdir().unwrap();
        sweep_stale_pack_caches(&tmp.path().join("modpacks"), SystemTime::now()).await;
        assert!(!tmp.path().join("modpacks").exists());
    }

    /// 装游戏失败时整个实例目录删掉；同名（不区分大小写）与和游戏版本同名都在动手前拒绝，已有目录不动。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn failures_leave_no_half_instance_and_names_are_checked_first() {
        let server = MockServer::start().await;
        mount_vanilla(&server).await;
        let tmp = tempfile::tempdir().unwrap();
        let aurora = aurora(tmp.path(), &server);
        let versions = aurora.game_dir().join("versions");

        let missing = tmp.path().join("missing.mrpack");
        write_pack(
            &missing,
            &index(serde_json::json!({"minecraft": "no-such-version"})),
            &[("overrides/a.txt", b"a")],
        );
        let err = aurora
            .install_modpack(
                &ModpackSource::File { path: missing },
                Some("坏包"),
                &ImportSelection::default(),
                "t1",
                None,
            )
            .await
            .unwrap_err();
        assert!(matches!(err, CoreError::Install(_)), "{err:?}");
        assert!(!versions.join("坏包").exists());

        std::fs::create_dir_all(versions.join("Taken")).unwrap();
        std::fs::write(versions.join("Taken").join("keep.txt"), b"keep").unwrap();
        let pack = tmp.path().join("ok.mrpack");
        write_pack(&pack, &index(serde_json::json!({"minecraft": "test"})), &[]);
        let source = ModpackSource::File { path: pack };
        let err = aurora
            .install_modpack(
                &source,
                Some("taken"),
                &ImportSelection::default(),
                "t2",
                None,
            )
            .await
            .unwrap_err();
        assert!(
            matches!(&err, CoreError::InstanceNameInvalid { name, rule: InstanceNameRule::Duplicate } if name == "taken"),
            "{err:?}"
        );
        assert_eq!(
            std::fs::read(versions.join("Taken").join("keep.txt")).unwrap(),
            b"keep"
        );

        let err = aurora
            .install_modpack(
                &source,
                Some("TEST"),
                &ImportSelection::default(),
                "t3",
                None,
            )
            .await
            .unwrap_err();
        assert!(matches!(
            err,
            CoreError::InstanceNameInvalid {
                rule: InstanceNameRule::Duplicate,
                ..
            }
        ));
        assert!(
            !versions.join("test").exists(),
            "与游戏版本同名应在安装前拒绝"
        );

        let err = aurora
            .install_modpack(
                &source,
                Some("a/b"),
                &ImportSelection::default(),
                "t4",
                None,
            )
            .await
            .unwrap_err();
        assert!(matches!(
            err,
            CoreError::InstanceNameInvalid {
                rule: InstanceNameRule::IllegalChar,
                ..
            }
        ));
    }

    /// 按名字删半成品：标记读不出来、还没写下标记的都删得掉；名下没有目录时什么都不做；
    /// 别的实例原样留着；带路径成分的名字直接拒绝。
    #[tokio::test]
    async fn discard_by_name_removes_the_half_import_whatever_its_marker() {
        let tmp = tempfile::tempdir().unwrap();
        let server = MockServer::start().await;
        let aurora = aurora(tmp.path(), &server);
        let versions = aurora.game_dir().join("versions");
        let corrupt = MarkerStore::for_version_dir(&versions.join("标记坏了"));
        std::fs::create_dir_all(corrupt.path().parent().unwrap()).unwrap();
        std::fs::write(corrupt.path(), b"{").unwrap();
        std::fs::create_dir_all(versions.join("还没写标记")).unwrap();
        let ours = versions.join("正常的");
        std::fs::create_dir_all(&ours).unwrap();
        write_marker(&ours, "t1").await.unwrap();
        std::fs::create_dir_all(versions.join("邻居")).unwrap();

        for name in ["标记坏了", "还没写标记", "正常的"] {
            assert!(aurora.discard_modpack_import(name).await.unwrap(), "{name}");
            assert!(!versions.join(name).exists(), "{name}");
        }
        assert!(!aurora.discard_modpack_import("正常的").await.unwrap());
        assert!(versions.join("邻居").is_dir());
        assert!(matches!(
            aurora.discard_modpack_import("..\\邻居").await.unwrap_err(),
            CoreError::Instance(crate::InstanceError::InvalidId { .. })
        ));
    }

    /// 删不掉的半成品落成结局：保留原来的开始时刻；原标记读不出来时换成一份新的、读得出来的。
    #[tokio::test]
    async fn settling_a_half_import_records_its_outcome() {
        use aurora_instance::{IncompleteOutcome, MarkerError};

        let tmp = tempfile::tempdir().unwrap();
        let server = MockServer::start().await;
        let aurora = aurora(tmp.path(), &server);
        let versions = aurora.game_dir().join("versions");
        let dir = versions.join("删不掉");
        std::fs::create_dir_all(&dir).unwrap();
        MarkerStore::for_version_dir(&dir)
            .save(&IncompleteMarker::pending(
                IncompleteKind::Modpack {
                    task_id: "mp#1".into(),
                },
                1_700_000_000_000,
            ))
            .await
            .unwrap();
        let failure = MarkerError {
            code: "download_failed".into(),
            message: "下载失败".into(),
        };
        aurora
            .settle_modpack_import("删不掉", "mp#1", MarkerSettlement::Failed(failure.clone()))
            .await
            .unwrap();
        let marker = MarkerStore::for_version_dir(&dir)
            .load()
            .await
            .unwrap()
            .unwrap();
        assert_eq!(marker.outcome, IncompleteOutcome::Failed);
        assert_eq!(marker.started_at, 1_700_000_000_000);
        assert_eq!(marker.error, Some(failure));
        assert_eq!(
            marker.kind,
            IncompleteKind::Modpack {
                task_id: "mp#1".into()
            }
        );

        let broken = MarkerStore::for_version_dir(&versions.join("标记坏了"));
        std::fs::create_dir_all(broken.path().parent().unwrap()).unwrap();
        std::fs::write(broken.path(), b"{").unwrap();
        aurora
            .settle_modpack_import("标记坏了", "mp#2", MarkerSettlement::Cancelled)
            .await
            .unwrap();
        let marker = broken.load().await.unwrap().unwrap();
        assert_eq!(marker.outcome, IncompleteOutcome::Cancelled);
        assert!(marker.started_at > 1_700_000_000_000);
    }

    /// 导入写下的标记就是实例列表读的那一种：导入中断后列表认得出它是整合包导入，而不是报标记损坏。
    #[tokio::test]
    async fn import_marker_is_read_by_the_instance_marker_store() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("versions").join("导入中");
        std::fs::create_dir_all(&dir).unwrap();
        write_marker(&dir, "mp#3").await.unwrap();
        let marker = MarkerStore::for_version_dir(&dir)
            .load()
            .await
            .unwrap()
            .expect("应读到标记");
        assert_eq!(
            marker.kind,
            IncompleteKind::Modpack {
                task_id: "mp#3".into()
            }
        );
        assert_eq!(marker.outcome, aurora_instance::IncompleteOutcome::Pending);
        assert!(marker.started_at > 1_700_000_000_000);
    }

    /// 远程文件下载失败时换备用地址；没有备用地址的失败原样报出。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn remote_download_falls_back_to_the_next_url() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/good.jar"))
            .respond_with(ResponseTemplate::new(200).set_body_bytes(b"jar".to_vec()))
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path("/gone.jar"))
            .respond_with(ResponseTemplate::new(404))
            .mount(&server)
            .await;
        let tmp = tempfile::tempdir().unwrap();
        let aurora = aurora(tmp.path(), &server);
        let dest = tmp.path().join("inst").join("mods").join("a.jar");
        let item = |fallbacks: Vec<String>| RemoteDownload {
            task: DownloadTask::new(format!("{}/gone.jar", server.uri()), &dest)
                .with_sha1(sha1_hex(b"jar"))
                .with_size(3),
            fallbacks,
        };

        aurora
            .download_remote(vec![item(vec![format!("{}/good.jar", server.uri())])], None)
            .await
            .unwrap();
        assert_eq!(std::fs::read(&dest).unwrap(), b"jar");

        std::fs::remove_file(&dest).unwrap();
        let err = aurora
            .download_remote(vec![item(Vec::new())], None)
            .await
            .unwrap_err();
        assert!(matches!(err, CoreError::Download(_)), "{err:?}");
        assert!(!dest.exists());
    }

    fn modrinth_file(dest: &str, urls: &[String], bytes: &[u8]) -> ModrinthFile {
        ModrinthFile {
            path: aurora_modpack::SafeRelativePath::new(dest).unwrap(),
            urls: urls.to_vec(),
            sha1: sha1_hex(bytes),
            size: bytes.len() as u64,
            optional: false,
        }
    }

    /// 别的启动器导出的 .mrpack 会把 CurseForge 上的 Mod 写成 forgecdn 地址，读包也认这类主机：下载时与
    /// 平台下载一样要带密钥，否则 CDN 一律回 401。发往 CDN 的每个请求都带，发往别处的不带；CDN 拒绝密钥时
    /// 报 CredentialRejected（界面据此说明怎么换密钥），不混同于普通的 401。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn mrpack_files_on_the_curseforge_cdn_carry_the_download_key() {
        let cdn = MockServer::start().await;
        let other = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/cdn.jar"))
            .respond_with(ResponseTemplate::new(200).set_body_bytes(b"cdn-jar".to_vec()))
            .mount(&cdn)
            .await;
        Mock::given(method("GET"))
            .and(path("/locked.jar"))
            .respond_with(ResponseTemplate::new(401))
            .mount(&cdn)
            .await;
        Mock::given(method("GET"))
            .and(path("/mr.jar"))
            .respond_with(ResponseTemplate::new(200).set_body_bytes(b"mr-jar".to_vec()))
            .mount(&other)
            .await;
        let tmp = tempfile::tempdir().unwrap();
        let aurora = aurora(tmp.path(), &other)
            .with_curseforge_key("k")
            .with_curseforge_cdn_scope(aurora_download::CredentialScope::new(
                [format!("127.0.0.1:{}", cdn.address().port())],
                false,
            ));
        let inst = tmp.path().join("落樱 实例");
        let files = RemoteFiles::Modrinth(vec![
            modrinth_file(
                "mods/cdn.jar",
                &[format!("{}/cdn.jar", cdn.uri())],
                b"cdn-jar",
            ),
            modrinth_file(
                "mods/mr.jar",
                &[format!("{}/mr.jar", other.uri())],
                b"mr-jar",
            ),
        ]);

        let plan = aurora
            .remote_downloads(&files, &HashSet::new(), &inst)
            .await
            .unwrap();
        aurora.download_remote(plan.downloads, None).await.unwrap();

        assert_eq!(
            std::fs::read(inst.join("mods").join("cdn.jar")).unwrap(),
            b"cdn-jar"
        );
        assert_eq!(
            std::fs::read(inst.join("mods").join("mr.jar")).unwrap(),
            b"mr-jar"
        );
        let cdn_requests = cdn.received_requests().await.unwrap();
        assert!(!cdn_requests.is_empty());
        for request in &cdn_requests {
            assert_eq!(
                request
                    .headers
                    .get("x-api-key")
                    .map(|v| v.to_str().unwrap()),
                Some("k"),
                "{}",
                request.url
            );
        }
        for request in other.received_requests().await.unwrap() {
            assert!(
                request.headers.get("x-api-key").is_none(),
                "{}",
                request.url
            );
        }

        let locked = RemoteFiles::Modrinth(vec![modrinth_file(
            "mods/locked.jar",
            &[format!("{}/locked.jar", cdn.uri())],
            b"x",
        )]);
        let plan = aurora
            .remote_downloads(&locked, &HashSet::new(), &inst)
            .await
            .unwrap();
        let err = aurora
            .download_remote(plan.downloads, None)
            .await
            .unwrap_err();
        assert!(
            matches!(
                &err,
                CoreError::Download(aurora_download::Error::CredentialRejected { status: 401, .. })
            ),
            "{err:?}"
        );
    }

    /// 没有 CDN 地址时不要 key；有 CDN 地址时要 key，要不到时看文件还有没有别的路可走。
    #[test]
    fn mrpack_cdn_credential_is_required_only_when_a_file_has_no_other_url() {
        const CDN: &str = "https://edge.forgecdn.net/files/1/2/a.jar";
        const MODRINTH: &str = "https://cdn.modrinth.com/data/a/versions/b/a.jar";
        let scope = CredentialScope::curseforge_cdn();
        let file = |urls: &[&str]| {
            let urls: Vec<String> = urls.iter().map(|url| (*url).to_owned()).collect();
            modrinth_file("mods/a.jar", &urls, b"x")
        };
        let missing = || {
            Err(CoreError::ModPlatform(
                aurora_modplatform::Error::CurseForgeKeyMissing,
            ))
        };
        let key = || Ok(DownloadCredential::curseforge("k").unwrap());

        let no_cdn = [file(&[MODRINTH])];
        assert!(
            modrinth_cdn_credential(&no_cdn, &scope, || panic!("不该要 key"))
                .unwrap()
                .is_none()
        );

        let cdn_only = [file(&[MODRINTH]), file(&[CDN])];
        assert!(
            modrinth_cdn_credential(&cdn_only, &scope, key)
                .unwrap()
                .is_some()
        );
        assert!(matches!(
            modrinth_cdn_credential(&cdn_only, &scope, missing),
            Err(CoreError::ModPlatform(
                aurora_modplatform::Error::CurseForgeKeyMissing
            ))
        ));

        let with_fallback = [file(&[CDN, MODRINTH]), file(&[MODRINTH])];
        assert!(
            modrinth_cdn_credential(&with_fallback, &scope, missing)
                .unwrap()
                .is_none()
        );

        // key 配错了不等于没配，有备用地址也要让用户看见。
        let malformed = || {
            Err(CoreError::from(
                DownloadCredential::curseforge(" ").unwrap_err(),
            ))
        };
        assert!(matches!(
            modrinth_cdn_credential(&with_fallback, &scope, malformed),
            Err(CoreError::Download(
                aurora_download::Error::InvalidCredential { .. }
            ))
        ));
    }

    fn cf_file(id: u32, mod_id: u32, name: &str, url: Option<String>) -> serde_json::Value {
        serde_json::json!({
            "id": id, "modId": mod_id, "displayName": name, "fileName": name,
            "hashes": [{"value": "0f4a890d07402280686a518579fa9fa02309e315", "algo": 1}],
            "fileLength": 10, "downloadUrl": url
        })
    }

    fn cf_mod(id: u32, class_id: u32) -> serde_json::Value {
        serde_json::json!({"id": id, "name": "m", "slug": "m", "summary": "", "classId": class_id})
    }

    /// CurseForge 文件按所属工程的大类落进对应目录，每个任务都挂 CurseForge 下载凭据；禁止分发的文件汇总
    /// 报错，每项带工程、文件 id、网页链接与落点。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn curseforge_files_land_by_class_and_blocked_files_are_reported_together() {
        let server = MockServer::start().await;
        let uri = server.uri();
        Mock::given(method("POST"))
            .and(path("/v1/mods/files"))
            .respond_with(
                ResponseTemplate::new(200).set_body_json(serde_json::json!({"data": [
                    cf_file(11, 1, "sodium.jar", Some(format!("{uri}/f/11"))),
                    cf_file(22, 2, "faithful.zip", Some(format!("{uri}/f/22"))),
                    cf_file(33, 3, "bsl.zip", Some(format!("{uri}/f/33"))),
                    cf_file(44, 4, "pack.zip", Some(format!("{uri}/f/44"))),
                    cf_file(55, 5, "blocked-a.jar", None),
                    cf_file(66, 6, "blocked-b.jar", None),
                ]})),
            )
            .mount(&server)
            .await;
        Mock::given(method("POST"))
            .and(path("/v1/mods"))
            .respond_with(
                ResponseTemplate::new(200).set_body_json(serde_json::json!({"data": [
                    cf_mod(1, 6), cf_mod(2, 12), cf_mod(3, 6552), cf_mod(4, 6945),
                    cf_mod(5, 6), cf_mod(6, 6)
                ]})),
            )
            .mount(&server)
            .await;
        for file in [55u32, 66] {
            Mock::given(method("GET"))
                .and(path(format!(
                    "/v1/mods/{}/files/{file}/download-url",
                    file / 11
                )))
                .respond_with(ResponseTemplate::new(403))
                .mount(&server)
                .await;
        }
        let client = CurseForgeClient::new(aurora_base::http::build_client().unwrap(), "k")
            .with_base_url(&uri);
        let dir = Path::new("D:/mc/versions/包");
        let refs = |ids: &[(u32, u32)]| -> Vec<CurseForgeFileRef> {
            ids.iter()
                .map(|&(project_id, file_id)| CurseForgeFileRef {
                    project_id,
                    file_id,
                })
                .collect()
        };

        let tmp = tempfile::tempdir().unwrap();
        let aurora = aurora(tmp.path(), &server).with_curseforge_key("k");

        let plan = aurora
            .curseforge_downloads(
                &client,
                &refs(&[(1, 11), (2, 22), (3, 33), (4, 44)]),
                &HashSet::new(),
                dir,
            )
            .await
            .unwrap();
        assert!(plan.claimed.is_empty());
        let downloads = plan.downloads;
        for download in &downloads {
            let credential = download.task.credential.as_ref().expect("应带下载凭据");
            assert_eq!(
                credential.realm(),
                aurora_download::CredentialRealm::CurseForge
            );
        }
        let dests: Vec<_> = downloads.iter().map(|d| d.task.dest.clone()).collect();
        assert_eq!(
            dests,
            vec![
                dir.join("mods").join("sodium.jar"),
                dir.join("resourcepacks").join("faithful.zip"),
                dir.join("shaderpacks").join("bsl.zip"),
                dir.join("datapacks").join("pack.zip"),
            ]
        );
        assert_eq!(downloads[0].task.url, format!("{uri}/f/11"));
        assert_eq!(downloads[0].task.size, Some(10));
        assert_eq!(
            downloads[0].task.sha1.as_deref(),
            Some("0f4a890d07402280686a518579fa9fa02309e315")
        );

        let err = aurora
            .curseforge_downloads(
                &client,
                &refs(&[(1, 11), (5, 55), (6, 66)]),
                &HashSet::new(),
                dir,
            )
            .await
            .unwrap_err();
        let CoreError::FileDistributionBlocked { files } = &err else {
            panic!("实际：{err:?}");
        };
        assert_eq!(
            files
                .iter()
                .map(|f| (
                    f.project_id,
                    f.file_id,
                    f.file_name.as_str(),
                    f.web_url.as_str(),
                    f.destination.as_str()
                ))
                .collect::<Vec<_>>(),
            vec![
                (
                    5,
                    55,
                    "blocked-a.jar",
                    "https://www.curseforge.com/minecraft/mc-mods/m/files/55",
                    "mods/blocked-a.jar"
                ),
                (
                    6,
                    66,
                    "blocked-b.jar",
                    "https://www.curseforge.com/minecraft/mc-mods/m/files/66",
                    "mods/blocked-b.jar"
                ),
            ]
        );
        assert_eq!(
            files[0].sha1.as_deref(),
            Some("0f4a890d07402280686a518579fa9fa02309e315")
        );
        assert_eq!((files[0].fingerprint, files[0].size), (0, Some(10)));

        let err = aurora
            .curseforge_downloads(&client, &refs(&[(9, 99)]), &HashSet::new(), dir)
            .await
            .unwrap_err();
        assert!(
            matches!(err, CoreError::ModVersionNotFound { .. }),
            "{err:?}"
        );
    }

    /// 摘要与预览报的落点就是导入用的落点：同一批引用，各问一次批量文件与批量工程接口，按工程大类落目录、
    /// 大类不认识的按 Mod；大小逐个加总，有一个文件没给大小就不报总量；平台没回的文件与导入一样报不存在。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn curseforge_remote_facts_follow_the_import_landing_rules() {
        use wiremock::matchers::body_json;

        let server = MockServer::start().await;
        let uri = server.uri();
        let sized = |id: u32, mod_id: u32, name: &str, length: Option<u64>| {
            let mut file = cf_file(id, mod_id, name, Some(format!("{uri}/f/{id}")));
            file["fileLength"] = length.map_or(serde_json::Value::Null, Into::into);
            file
        };
        let files = serde_json::json!({"data": [
            sized(11, 1, "sodium.jar", Some(1_000_000)),
            sized(22, 2, "faithful.zip", Some(9_000_000)),
            sized(33, 3, "mystery.jar", Some(0)),
            sized(44, 1, "sodium-extra.jar", Some(u64::from(u32::MAX) + 1)),
        ]});
        Mock::given(method("POST"))
            .and(path("/v1/mods/files"))
            .and(body_json(serde_json::json!({"fileIds": [11, 22, 33, 44]})))
            .respond_with(ResponseTemplate::new(200).set_body_json(files))
            .expect(1)
            .mount(&server)
            .await;
        Mock::given(method("POST"))
            .and(path("/v1/mods"))
            .and(body_json(serde_json::json!({"modIds": [1, 2, 3]})))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({"data": [
                cf_mod(1, 6), cf_mod(2, 12),
                serde_json::json!({"id": 3, "name": "m", "slug": "m", "summary": "", "classId": 17}),
            ]})))
            .expect(1)
            .mount(&server)
            .await;
        let client = CurseForgeClient::new(aurora_base::http::build_client().unwrap(), "k")
            .with_base_url(&uri);
        let refs: Vec<CurseForgeFileRef> = [(1, 11), (2, 22), (3, 33), (1, 44)]
            .iter()
            .map(|&(project_id, file_id)| CurseForgeFileRef {
                project_id,
                file_id,
            })
            .collect();

        let facts = curseforge_remote_facts(&client, &refs, BlockedProbe::Skip)
            .await
            .unwrap();
        assert_eq!(
            facts.destinations().collect::<Vec<_>>(),
            [
                "mods/sodium.jar",
                "resourcepacks/faithful.zip",
                "mods/mystery.jar",
                "mods/sodium-extra.jar"
            ]
        );
        assert_eq!(facts.bytes, Some(10_000_000 + u64::from(u32::MAX) + 1));
        server.verify().await;
        server.reset().await;

        Mock::given(method("POST"))
            .and(path("/v1/mods/files"))
            .respond_with(
                ResponseTemplate::new(200).set_body_json(serde_json::json!({"data": [
                    sized(11, 1, "sodium.jar", Some(1_000_000)),
                    sized(22, 2, "faithful.zip", None),
                ]})),
            )
            .mount(&server)
            .await;
        Mock::given(method("POST"))
            .and(path("/v1/mods"))
            .respond_with(
                ResponseTemplate::new(200)
                    .set_body_json(serde_json::json!({"data": [cf_mod(1, 6), cf_mod(2, 12)]})),
            )
            .mount(&server)
            .await;
        let facts = curseforge_remote_facts(&client, &refs[..2], BlockedProbe::Skip)
            .await
            .unwrap();
        assert_eq!(facts.entries.len(), 2);
        assert_eq!(facts.bytes, None, "缺一个文件的大小就不报总量");

        let err = curseforge_remote_facts(&client, &refs, BlockedProbe::Skip)
            .await
            .unwrap_err();
        assert!(
            matches!(&err, CoreError::ModVersionNotFound { version_id, .. } if version_id == "33"),
            "{err:?}"
        );
    }

    #[test]
    fn pack_mod_count_takes_remote_files_and_override_jars_directly_in_mods() {
        let none: [&str; 0] = [];
        assert_eq!(count_pack_mods(none, none), 0);
        let remote = [
            "mods/sodium.jar",
            "Mods/Lithium.jar",
            "mods/notes.txt",
            "mods/old/legacy.jar",
            "mods/",
            "resourcepacks/faithful.zip",
            "config/mods/x.jar",
        ];
        assert_eq!(
            count_pack_mods(remote, none),
            3,
            "远程文件落在 mods/ 下就算"
        );
        let overrides = [
            "mods/extra.JAR",
            "mods/README.md",
            "mods/sodium.jar",
            "MODS/lithium.jar",
            "mods/cfg/x.jar",
            "config/extra.jar",
        ];
        assert_eq!(count_pack_mods(none, overrides), 3, "覆盖层只认 .jar");
        assert_eq!(
            count_pack_mods(remote, overrides),
            4,
            "覆盖文件盖掉同名下载文件，只算一次"
        );

        let seed = fastrand::u64(..);
        let mut rng = fastrand::Rng::with_seed(seed);
        let remote_count = rng.usize(0..300);
        let override_count = rng.usize(0..300);
        let remote: Vec<String> = (0..remote_count)
            .map(|i| format!("mods/remote-{i}.jar"))
            .collect();
        let overrides: Vec<String> = (0..override_count)
            .map(|i| format!("mods/override-{i}.jar"))
            .chain(remote.iter().take(rng.usize(0..=remote_count)).cloned())
            .collect();
        assert_eq!(
            count_pack_mods(
                remote.iter().map(String::as_str),
                overrides.iter().map(String::as_str)
            ),
            remote_count + override_count,
            "seed {seed}"
        );
    }

    fn write_curseforge_pack(dest: &Path, manifest: &serde_json::Value, entries: &[(&str, &[u8])]) {
        let mut writer = zip::ZipWriter::new(std::fs::File::create(dest).unwrap());
        let options = zip::write::SimpleFileOptions::default();
        writer.start_file("manifest.json", options).unwrap();
        writer
            .write_all(&serde_json::to_vec(manifest).unwrap())
            .unwrap();
        for (name, bytes) in entries {
            writer.start_file(*name, options).unwrap();
            writer.write_all(bytes).unwrap();
        }
        writer.finish().unwrap();
    }

    fn curseforge_manifest(files: serde_json::Value) -> serde_json::Value {
        serde_json::json!({
            "minecraft": { "version": "1.20.1", "modLoaders": [{ "id": "forge-47.2.0", "primary": true }] },
            "manifestType": "minecraftModpack", "manifestVersion": 1,
            "name": "本地 CF 包", "files": files, "overrides": "overrides"
        })
    }

    /// 本地 .mrpack 预览：Mod 数是清单里落进 mods/ 的远程文件加上两层覆盖里的 .jar，同一落点只算一次；
    /// 下载量是清单里的大小之和，整个预览不发任何请求。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn local_modrinth_preview_counts_remote_mods_and_override_jars() {
        let server = MockServer::start().await;
        let tmp = tempfile::tempdir().unwrap();
        let file = |path: &str, size: u64| {
            serde_json::json!({
                "path": path, "hashes": { "sha1": "a".repeat(40) },
                "downloads": [format!("https://cdn.modrinth.com/{path}")], "fileSize": size
            })
        };
        let mut manifest =
            index(serde_json::json!({"minecraft": "1.21.1", "fabric-loader": "0.16.10"}));
        manifest["files"] = serde_json::json!([
            file("mods/sodium.jar", 1_000_000),
            file("mods/lithium.jar", 600_000),
            file("resourcepacks/faithful.zip", 9_000_000),
        ]);
        let pack = tmp.path().join("本地.mrpack");
        write_pack(
            &pack,
            &manifest,
            &[
                ("overrides/mods/extra.jar", b"jar"),
                ("overrides/mods/README.md", b"read me"),
                ("overrides/mods/sodium.jar", b"patched"),
                ("overrides/mods/old/legacy.jar", b"old"),
                ("client-overrides/mods/extra.jar", b"client jar"),
                ("client-overrides/mods/zoom.jar", b"zoom"),
                ("overrides/config/sodium.json", b"{}"),
            ],
        );
        let aurora = aurora(tmp.path(), &server);

        let preview = aurora.preview_modpack_file(&pack).await.unwrap();
        assert_eq!(preview.format, PackFormat::Modrinth);
        assert_eq!(preview.remote_files, 3);
        assert_eq!(preview.mod_files, 4, "sodium、lithium、extra、zoom");
        assert_eq!(preview.remote_bytes, Some(10_600_000));
        assert_eq!(preview.override_files, 6, "两层里的 extra.jar 只留一份");
        assert_eq!(
            preview
                .mods
                .iter()
                .map(|m| (m.path.as_str(), m.origin, m.availability))
                .collect::<Vec<_>>(),
            vec![
                (
                    "mods/extra.jar",
                    PackFileOrigin::Override,
                    PackFileAvailability::Bundled
                ),
                (
                    "mods/lithium.jar",
                    PackFileOrigin::Remote,
                    PackFileAvailability::Download
                ),
                (
                    "mods/sodium.jar",
                    PackFileOrigin::Override,
                    PackFileAvailability::Bundled
                ),
                (
                    "mods/zoom.jar",
                    PackFileOrigin::Override,
                    PackFileAvailability::Bundled
                ),
            ]
        );
        assert_eq!(preview.mods.len(), preview.mod_files);
        assert!(preview.optional_extras.is_empty(), "资源包不是可选文件");
        assert!(preview.blocked_files.is_empty());
        assert!(server.received_requests().await.unwrap().is_empty());
    }

    /// 本地 CurseForge 包：没有远程文件时不问平台（也就不需要 API key），Mod 数只来自覆盖层；有远程文件时
    /// 按批量接口回的工程大类认，与覆盖层同名的 .jar 只算一次，下载量是平台给的大小之和。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn local_curseforge_preview_counts_mods_by_class_and_override_jars() {
        let server = MockServer::start().await;
        let tmp = tempfile::tempdir().unwrap();
        let overrides: &[(&str, &[u8])] = &[
            ("overrides/mods/kubejs-extra.jar", b"jar"),
            ("overrides/mods/create-0.5.1.jar", b"patched"),
            ("overrides/mods/notes.txt", b"notes"),
            ("overrides/config/create.toml", b"x=1"),
        ];
        let offline = tmp.path().join("offline.zip");
        write_curseforge_pack(
            &offline,
            &curseforge_manifest(serde_json::json!([])),
            overrides,
        );
        let preview = aurora(tmp.path(), &server)
            .preview_modpack_file(&offline)
            .await
            .unwrap();
        assert_eq!(preview.format, PackFormat::CurseForge);
        assert_eq!((preview.remote_files, preview.mod_files), (0, 2));
        assert_eq!(preview.remote_bytes, Some(0));
        assert!(server.received_requests().await.unwrap().is_empty());

        Mock::given(method("POST"))
            .and(path("/v1/mods/files"))
            .respond_with(
                ResponseTemplate::new(200).set_body_json(serde_json::json!({"data": [
                    cf_file(11, 1, "create-0.5.1.jar", None),
                    cf_file(22, 2, "jei-15.2.jar", None),
                    cf_file(33, 3, "create-textures.zip", None),
                ]})),
            )
            .expect(1)
            .mount(&server)
            .await;
        Mock::given(method("POST"))
            .and(path("/v1/mods"))
            .respond_with(
                ResponseTemplate::new(200).set_body_json(serde_json::json!({"data": [
                    cf_mod(1, 6), cf_mod(2, 6), cf_mod(3, 12)
                ]})),
            )
            .expect(1)
            .mount(&server)
            .await;
        let online = tmp.path().join("online.zip");
        write_curseforge_pack(
            &online,
            &curseforge_manifest(serde_json::json!([
                { "projectID": 1, "fileID": 11, "required": true },
                { "projectID": 2, "fileID": 22, "required": true },
                { "projectID": 3, "fileID": 33, "required": true }
            ])),
            overrides,
        );
        let archive = read_pack_blocking(online).await.unwrap();
        let RemoteFiles::CurseForge(refs) = &archive.manifest.remote else {
            panic!("应读出 CurseForge 清单");
        };
        let client = CurseForgeClient::new(aurora_base::http::build_client().unwrap(), "k")
            .with_base_url(server.uri());
        let remote = curseforge_remote_facts(&client, refs, BlockedProbe::Skip)
            .await
            .unwrap();
        let preview = preview_of(&archive, remote, &HashSet::new(), Vec::new());
        assert_eq!(preview.remote_files, 3);
        assert_eq!(
            preview.mod_files, 3,
            "create 与 jei 是 Mod、材质包不是；覆盖层的 create 盖掉下载的那份，再加 kubejs-extra"
        );
        assert_eq!(preview.remote_bytes, Some(30), "每个文件 10 字节");
        assert_eq!(preview.override_files, 4);
        assert_eq!(
            preview
                .mods
                .iter()
                .map(|m| (m.file_name.as_str(), m.origin, m.project_id, m.file_id))
                .collect::<Vec<_>>(),
            vec![
                ("create-0.5.1.jar", PackFileOrigin::Override, None, None),
                ("jei-15.2.jar", PackFileOrigin::Remote, Some(2), Some(22)),
                ("kubejs-extra.jar", PackFileOrigin::Override, None, None),
            ]
        );
        assert_eq!(preview.mods.len(), preview.mod_files);
        server.verify().await;
    }

    fn cf_file_with(
        id: u32,
        mod_id: u32,
        name: &str,
        url: Option<String>,
        bytes: &[u8],
    ) -> serde_json::Value {
        let mut file = cf_file(id, mod_id, name, url);
        file["hashes"] = serde_json::json!([{"value": sha1_hex(bytes), "algo": 1}]);
        file["fileLength"] = serde_json::json!(bytes.len());
        file
    }

    fn curseforge_vanilla_manifest(files: serde_json::Value) -> serde_json::Value {
        serde_json::json!({
            "minecraft": { "version": "test", "modLoaders": [] },
            "manifestType": "minecraftModpack", "manifestVersion": 1,
            "name": "受限包", "files": files, "overrides": "overrides"
        })
    }

    /// 本地 CurseForge 包在预览阶段就列出受限文件：没给下载地址的逐个问 download-url，回 403 的两个进
    /// blocked_files（工程、文件 id、网页链接与落点精确匹配，有 links 的用 websiteUrl，没有的按 slug 拼），
    /// 暂存位里已有校验通过副本的那个记为已认领、不进清单；给了下载地址的不问 download-url。预览本身不失败。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn local_curseforge_preview_lists_blocked_files_before_import() {
        let server = MockServer::start().await;
        let uri = server.uri();
        let claimed_bytes = b"claimed jar";
        Mock::given(method("POST"))
            .and(path("/v1/mods/files"))
            .respond_with(
                ResponseTemplate::new(200).set_body_json(serde_json::json!({"data": [
                    cf_file(11, 1, "jei.jar", Some(format!("{uri}/f/11"))),
                    cf_file(55, 5, "blocked-a.jar", None),
                    cf_file(66, 6, "blocked-b.jar", None),
                    cf_file_with(77, 7, "claimed.jar", None, claimed_bytes),
                ]})),
            )
            .expect(1)
            .mount(&server)
            .await;
        Mock::given(method("POST"))
            .and(path("/v1/mods"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({"data": [
                cf_mod(1, 6),
                {"id": 5, "name": "A", "slug": "a-slug", "summary": "", "classId": 6,
                 "links": {"websiteUrl": "https://www.curseforge.com/minecraft/mc-mods/blocked-a/"}},
                cf_mod(6, 6),
                cf_mod(7, 6),
            ]})))
            .expect(1)
            .mount(&server)
            .await;
        for (project, file) in [(5u32, 55u32), (6, 66), (7, 77)] {
            Mock::given(method("GET"))
                .and(path(format!(
                    "/v1/mods/{project}/files/{file}/download-url"
                )))
                .respond_with(ResponseTemplate::new(403))
                .expect(1)
                .mount(&server)
                .await;
        }
        Mock::given(method("GET"))
            .and(path("/v1/mods/1/files/11/download-url"))
            .respond_with(ResponseTemplate::new(500))
            .expect(0)
            .mount(&server)
            .await;
        let tmp = tempfile::tempdir().unwrap();
        let pack = tmp.path().join("local.zip");
        write_curseforge_pack(
            &pack,
            &curseforge_vanilla_manifest(serde_json::json!([
                { "projectID": 1, "fileID": 11, "required": true },
                { "projectID": 5, "fileID": 55, "required": true },
                { "projectID": 6, "fileID": 66, "required": true },
                { "projectID": 7, "fileID": 77, "required": true }
            ])),
            &[("overrides/mods/extra.jar", b"x")],
        );
        let aurora = aurora(tmp.path(), &server).with_curseforge_key("k");
        let slot = aurora
            .blocked_claims_dir()
            .join("curseforge-77")
            .join("claimed.jar");
        std::fs::create_dir_all(slot.parent().unwrap()).unwrap();
        std::fs::write(&slot, claimed_bytes).unwrap();

        let preview = aurora.preview_modpack_file(&pack).await.unwrap();
        let hash = Some("0f4a890d07402280686a518579fa9fa02309e315".to_owned());
        assert_eq!(
            preview.blocked_files,
            vec![
                BlockedFile {
                    project_id: 5,
                    file_id: 55,
                    file_name: "blocked-a.jar".into(),
                    web_url: "https://www.curseforge.com/minecraft/mc-mods/blocked-a/files/55"
                        .into(),
                    destination: "mods/blocked-a.jar".into(),
                    sha1: hash.clone(),
                    fingerprint: 0,
                    size: Some(10),
                },
                BlockedFile {
                    project_id: 6,
                    file_id: 66,
                    file_name: "blocked-b.jar".into(),
                    web_url: "https://www.curseforge.com/minecraft/mc-mods/m/files/66".into(),
                    destination: "mods/blocked-b.jar".into(),
                    sha1: hash,
                    fingerprint: 0,
                    size: Some(10),
                },
            ]
        );
        assert_eq!(
            preview
                .mods
                .iter()
                .map(|m| (m.file_name.as_str(), m.availability, m.file_id))
                .collect::<Vec<_>>(),
            vec![
                ("blocked-a.jar", PackFileAvailability::Blocked, Some(55)),
                ("blocked-b.jar", PackFileAvailability::Blocked, Some(66)),
                ("claimed.jar", PackFileAvailability::Claimed, Some(77)),
                ("extra.jar", PackFileAvailability::Bundled, None),
                ("jei.jar", PackFileAvailability::Download, Some(11)),
            ]
        );
        assert_eq!(preview.mod_files, 5);
        assert_eq!(preview.mods.len(), preview.mod_files);
        server.verify().await;
    }

    /// mrpack 里取消勾选的可选文件不进下载计划：准备好的任务里没有它们，导入时 CDN 也只收到必需文件的请求
    /// （清单只认 https 地址，准备好之后把任务地址换到本地 mock 再导入）；
    /// 预览里可选 Mod 在 Mod 清单里标为可选，资源包列在其他可选文件里；实例记下的远程文件数按剔除后的清单算。
    /// 不是可选文件的路径报 NotOptional。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn skipped_optional_files_are_left_out_of_the_download_plan() {
        let server = MockServer::start().await;
        mount_vanilla(&server).await;
        let uri = server.uri();
        let files: [(&str, &[u8], bool); 3] = [
            ("mods/core.jar", b"core", false),
            ("mods/optional-helper.jar", b"helper", true),
            ("resourcepacks/optional-pack.zip", b"pack!", true),
        ];
        let mut manifest = index(serde_json::json!({"minecraft": "test"}));
        manifest["files"] = files
            .iter()
            .map(|(file_path, bytes, optional)| {
                let name = file_path.rsplit('/').next().unwrap();
                let mut entry = serde_json::json!({
                    "path": file_path, "hashes": { "sha1": sha1_hex(bytes) },
                    "downloads": [format!("https://cdn.modrinth.com/data/x/{name}")],
                    "fileSize": bytes.len()
                });
                if *optional {
                    entry["env"] = serde_json::json!({"client": "optional", "server": "optional"});
                }
                entry
            })
            .collect();
        for (file_path, bytes, _) in &files {
            let name = file_path.rsplit('/').next().unwrap();
            Mock::given(method("GET"))
                .and(path(format!("/cdn/{name}")))
                .respond_with(ResponseTemplate::new(200).set_body_bytes(bytes.to_vec()))
                .mount(&server)
                .await;
        }
        let tmp = tempfile::tempdir().unwrap();
        let pack = tmp.path().join("可选.mrpack");
        write_pack(&pack, &manifest, &[]);
        let aurora = aurora(tmp.path(), &server);
        let source = ModpackSource::File { path: pack.clone() };

        let preview = aurora.preview_modpack_file(&pack).await.unwrap();
        assert_eq!(
            preview
                .mods
                .iter()
                .map(|m| (m.path.as_str(), m.optional))
                .collect::<Vec<_>>(),
            vec![("mods/core.jar", false), ("mods/optional-helper.jar", true)]
        );
        assert_eq!(
            preview
                .optional_extras
                .iter()
                .map(|m| (m.path.as_str(), m.optional, m.origin))
                .collect::<Vec<_>>(),
            vec![(
                "resourcepacks/optional-pack.zip",
                true,
                PackFileOrigin::Remote
            )]
        );

        let selection = ImportSelection {
            excluded_optional: vec![
                "mods/optional-helper.jar".into(),
                "resourcepacks/optional-pack.zip".into(),
            ],
        };
        let dir = aurora.game_dir().join("versions").join("可选");
        let mut prepared = aurora
            .prepare_modpack(&source, Some("可选"), &selection, None)
            .await
            .unwrap();
        assert_eq!(
            prepared
                .remote
                .iter()
                .map(|d| (d.task.dest.clone(), d.task.url.clone()))
                .collect::<Vec<_>>(),
            vec![(
                dir.join("mods").join("core.jar"),
                "https://cdn.modrinth.com/data/x/core.jar".to_owned()
            )]
        );
        assert!(
            prepared.remote.iter().all(|d| d.task.credential.is_none()),
            "Modrinth 文件不挂下载凭据"
        );
        for download in &mut prepared.remote {
            let name = download.task.url.rsplit('/').next().unwrap().to_owned();
            download.task.url = format!("{uri}/cdn/{name}");
        }

        let outcome = aurora
            .import_modpack(prepared, "task-o", None)
            .await
            .unwrap();
        let cdn: Vec<String> = server
            .received_requests()
            .await
            .unwrap()
            .iter()
            .map(|r| r.url.path().to_owned())
            .filter(|p| p.starts_with("/cdn/"))
            .collect();
        assert_eq!(cdn, vec!["/cdn/core.jar"]);
        assert_eq!(
            std::fs::read(dir.join("mods").join("core.jar")).unwrap(),
            b"core"
        );
        assert!(!dir.join("mods").join("optional-helper.jar").exists());
        assert!(!dir.join("resourcepacks").join("optional-pack.zip").exists());
        assert_eq!(outcome.modpack.remote_files, 1);

        let err = aurora
            .prepare_modpack(
                &source,
                Some("必需"),
                &ImportSelection {
                    excluded_optional: vec!["mods/core.jar".into()],
                },
                None,
            )
            .await
            .unwrap_err();
        assert!(
            matches!(&err, CoreError::Modpack(aurora_modpack::Error::NotOptional { path }) if path == "mods/core.jar"),
            "{err:?}"
        );
    }

    /// 受限文件的落点被覆盖层盖住时不用手动下载：覆盖文件在下载之后解出，手动下载的那份反正会被盖掉。
    /// 预览不列它、准备不报受限，导入后落点是包里自带的内容；落点比较不分大小写。别的受限文件照常报。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn blocked_files_covered_by_an_override_need_no_manual_download() {
        let server = MockServer::start().await;
        mount_vanilla(&server).await;
        Mock::given(method("POST"))
            .and(path("/v1/mods/files"))
            .respond_with(
                ResponseTemplate::new(200).set_body_json(serde_json::json!({"data": [
                    cf_file(55, 5, "Covered.jar", None),
                    cf_file(66, 6, "still-blocked.jar", None),
                ]})),
            )
            .mount(&server)
            .await;
        Mock::given(method("POST"))
            .and(path("/v1/mods"))
            .respond_with(
                ResponseTemplate::new(200)
                    .set_body_json(serde_json::json!({"data": [cf_mod(5, 6), cf_mod(6, 6)]})),
            )
            .mount(&server)
            .await;
        for (project, file) in [(5u32, 55u32), (6, 66)] {
            Mock::given(method("GET"))
                .and(path(format!(
                    "/v1/mods/{project}/files/{file}/download-url"
                )))
                .respond_with(ResponseTemplate::new(403))
                .mount(&server)
                .await;
        }
        let tmp = tempfile::tempdir().unwrap();
        let aurora = aurora(tmp.path(), &server).with_curseforge_key("k");
        let covered = serde_json::json!({ "projectID": 5, "fileID": 55, "required": true });
        let blocked = serde_json::json!({ "projectID": 6, "fileID": 66, "required": true });
        let bundled: &[(&str, &[u8])] = &[("overrides/mods/covered.jar", b"bundled jar")];
        let none = ImportSelection::default();

        // 只有被盖住的那个：预览不列、导入不拦。
        let pack = tmp.path().join("自带.zip");
        write_curseforge_pack(
            &pack,
            &curseforge_vanilla_manifest(serde_json::json!([covered])),
            bundled,
        );
        let preview = aurora.preview_modpack_file(&pack).await.unwrap();
        assert_eq!(preview.blocked_files, Vec::new());
        assert_eq!(
            preview
                .mods
                .iter()
                .map(|m| (m.file_name.as_str(), m.availability))
                .collect::<Vec<_>>(),
            vec![("covered.jar", PackFileAvailability::Bundled)]
        );
        let outcome = aurora
            .install_modpack(
                &ModpackSource::File { path: pack },
                Some("自带"),
                &none,
                "task-covered",
                None,
            )
            .await
            .unwrap();
        assert_eq!(
            std::fs::read(outcome.version_dir.join("mods").join("covered.jar")).unwrap(),
            b"bundled jar"
        );

        // 另一个没被盖住的文件照常报，清单里只有它。
        let pack = tmp.path().join("混合.zip");
        write_curseforge_pack(
            &pack,
            &curseforge_vanilla_manifest(serde_json::json!([covered, blocked])),
            bundled,
        );
        let preview = aurora.preview_modpack_file(&pack).await.unwrap();
        assert_eq!(
            preview
                .blocked_files
                .iter()
                .map(|f| f.file_id)
                .collect::<Vec<_>>(),
            vec![66]
        );
        let err = aurora
            .prepare_modpack(&ModpackSource::File { path: pack }, None, &none, None)
            .await
            .unwrap_err();
        let CoreError::FileDistributionBlocked { files } = err else {
            panic!("应报受限文件");
        };
        assert_eq!(
            files.iter().map(|f| f.file_id).collect::<Vec<_>>(),
            vec![66]
        );
    }

    /// 受限文件的完整流程：准备时报受限，只列没认领的那一个；从下载文件夹认领（浏览器改过名）后再准备不再
    /// 报受限，它不生成下载任务；导入后它落在 mods/ 下、内容与认领的文件相同，阶段里有「放入 1 个手动下载的
    /// 文件」，暂存副本与下载文件夹里的原文件都还在。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn claimed_blocked_files_are_copied_in_on_import() {
        let server = MockServer::start().await;
        mount_vanilla(&server).await;
        let uri = server.uri();
        let blocked_bytes = b"blocked jar bytes";
        Mock::given(method("POST"))
            .and(path("/v1/mods/files"))
            .respond_with(
                ResponseTemplate::new(200).set_body_json(serde_json::json!({"data": [
                    cf_file_with(11, 1, "jei.jar", Some(format!("{uri}/f/11")), b"jei"),
                    cf_file_with(55, 5, "blocked-a.jar", None, blocked_bytes),
                ]})),
            )
            .mount(&server)
            .await;
        Mock::given(method("POST"))
            .and(path("/v1/mods"))
            .respond_with(
                ResponseTemplate::new(200)
                    .set_body_json(serde_json::json!({"data": [cf_mod(1, 6), cf_mod(5, 6)]})),
            )
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path("/v1/mods/5/files/55/download-url"))
            .respond_with(ResponseTemplate::new(403))
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path("/f/11"))
            .respond_with(ResponseTemplate::new(200).set_body_bytes(b"jei".to_vec()))
            .mount(&server)
            .await;
        let tmp = tempfile::tempdir().unwrap();
        let pack = tmp.path().join("受限包.zip");
        write_curseforge_pack(
            &pack,
            &curseforge_vanilla_manifest(serde_json::json!([
                { "projectID": 1, "fileID": 11, "required": true },
                { "projectID": 5, "fileID": 55, "required": true }
            ])),
            &[],
        );
        let aurora = aurora(tmp.path(), &server).with_curseforge_key("k");
        let source = ModpackSource::File { path: pack };
        let none = ImportSelection::default();

        let err = aurora
            .prepare_modpack(&source, None, &none, None)
            .await
            .unwrap_err();
        let CoreError::FileDistributionBlocked { files } = err else {
            panic!("应报受限文件");
        };
        assert_eq!(
            files.iter().map(|f| f.file_id).collect::<Vec<_>>(),
            vec![55]
        );

        let downloads = tmp.path().join("Downloads");
        std::fs::create_dir_all(&downloads).unwrap();
        let renamed = downloads.join("blocked-a (1).jar");
        std::fs::write(&renamed, blocked_bytes).unwrap();
        let report = aurora
            .claim_blocked_files(&downloads, &files)
            .await
            .unwrap();
        assert_eq!(
            report.claimed,
            vec![crate::blocked::ClaimedFile {
                file_id: 55,
                source: renamed.clone(),
            }]
        );
        assert!(report.missing.is_empty());

        let dir = aurora.game_dir().join("versions").join("受限包");
        let prepared = aurora
            .prepare_modpack(&source, None, &none, None)
            .await
            .unwrap();
        assert_eq!(
            prepared
                .remote
                .iter()
                .map(|d| d.task.dest.clone())
                .collect::<Vec<_>>(),
            vec![dir.join("mods").join("jei.jar")]
        );
        assert_eq!(
            prepared
                .claimed
                .iter()
                .map(|c| c.dest.clone())
                .collect::<Vec<_>>(),
            vec![dir.join("mods").join("blocked-a.jar")]
        );
        prepared.discard().await;

        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
        let outcome = aurora
            .install_modpack(&source, None, &none, "task-c", Some(&tx))
            .await
            .unwrap();
        assert_eq!(
            std::fs::read(dir.join("mods").join("blocked-a.jar")).unwrap(),
            blocked_bytes
        );
        assert_eq!(
            std::fs::read(dir.join("mods").join("jei.jar")).unwrap(),
            b"jei"
        );
        assert_eq!(outcome.modpack.remote_files, 2);
        drop(tx);
        let mut stages = Vec::new();
        while let Some(event) = rx.recv().await {
            if let CoreEvent::Stage(stage) = event {
                stages.push(stage);
            }
        }
        assert!(
            stages.iter().any(|s| s == "放入 1 个手动下载的文件"),
            "{stages:?}"
        );
        assert!(
            aurora
                .blocked_claims_dir()
                .join("curseforge-55")
                .join("blocked-a.jar")
                .is_file(),
            "暂存副本导入后留着"
        );
        assert!(renamed.is_file(), "下载文件夹里的原文件不动");
    }

    /// CurseForge 整合包本体就不允许启动器直接下载：第一次导入报受限文件，清单里只有这个包；用户从网页
    /// 下载、认领进暂存位后再导入，直接用暂存副本，不再向 CDN 要包，暂存副本导入后留着。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn claimed_curseforge_pack_file_is_imported_without_downloading() {
        let server = MockServer::start().await;
        mount_vanilla(&server).await;
        let tmp = tempfile::tempdir().unwrap();
        let built = tmp.path().join("built.zip");
        write_curseforge_pack(
            &built,
            &curseforge_vanilla_manifest(serde_json::json!([])),
            &[("overrides/options.txt", b"fov:70")],
        );
        let pack_bytes = std::fs::read(&built).unwrap();
        Mock::given(method("GET"))
            .and(path("/v1/mods/700/files/7001"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "data": cf_file_with(7001, 700, "受限包-1.0.zip", None, &pack_bytes)
            })))
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path("/v1/mods/700/files/7001/download-url"))
            .respond_with(ResponseTemplate::new(403))
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path("/v1/mods/700"))
            .respond_with(
                ResponseTemplate::new(200)
                    .set_body_json(serde_json::json!({"data": cf_mod(700, 4471)})),
            )
            .mount(&server)
            .await;
        let aurora = aurora(tmp.path(), &server).with_curseforge_key("k");
        let source = ModpackSource::Platform {
            platform: Platform::CurseForge,
            project_id: "700".into(),
            version_id: "7001".into(),
        };
        let none = ImportSelection::default();

        let err = aurora
            .install_modpack(&source, Some("网页下的包"), &none, "task-b1", None)
            .await
            .unwrap_err();
        let CoreError::FileDistributionBlocked { files } = err else {
            panic!("应报受限文件：{err:?}");
        };
        assert_eq!(
            files
                .iter()
                .map(|f| (f.file_id, f.file_name.as_str(), f.destination.as_str()))
                .collect::<Vec<_>>(),
            vec![(7001, "受限包-1.0.zip", "受限包-1.0.zip")]
        );

        let downloads = tmp.path().join("下载 文件夹");
        std::fs::create_dir_all(&downloads).unwrap();
        let renamed = downloads.join("受限包-1.0 (1).zip");
        std::fs::write(&renamed, &pack_bytes).unwrap();
        let report = aurora
            .claim_blocked_files(&downloads, &files)
            .await
            .unwrap();
        assert_eq!(report.missing, Vec::<u32>::new());

        let outcome = aurora
            .install_modpack(&source, Some("网页下的包"), &none, "task-b2", None)
            .await
            .unwrap();
        assert_eq!(outcome.modpack.platform, Some(Platform::CurseForge));
        assert_eq!(outcome.modpack.version_id.as_deref(), Some("7001"));
        assert_eq!(
            std::fs::read(outcome.version_dir.join("options.txt")).unwrap(),
            b"fov:70"
        );
        assert!(
            aurora
                .blocked_claims_dir()
                .join("curseforge-7001")
                .join("受限包-1.0.zip")
                .is_file(),
            "暂存副本导入后留着"
        );
        assert!(renamed.is_file(), "下载文件夹里的原文件不动");
    }

    #[test]
    fn forge_versions_with_minecraft_prefix_are_trimmed() {
        assert_eq!(strip_minecraft_prefix("1.20.1-47.2.0", "1.20.1"), "47.2.0");
        assert_eq!(strip_minecraft_prefix("47.2.0", "1.20.1"), "47.2.0");
        assert_eq!(strip_minecraft_prefix("1.20.10-1", "1.20.1"), "1.20.10-1");
    }
}
