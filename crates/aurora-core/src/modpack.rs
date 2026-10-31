//! 整合包导入为新实例。
//!
//! 来源有两种：平台上某整合包的一个版本（先下载到缓存目录），或用户选的本地 `.mrpack` / `.zip`。
//! 导入总是新建一个实例目录 `versions/<实例名>/`，按顺序：
//!
//! 1. 读清单、校验实例名并查重；CurseForge 包先把全部文件 id 换成下载地址——有作者禁止第三方分发
//!    的文件就在这一步整体报错，不先装几百 MB 游戏再告诉用户装不完。这一步不动游戏目录
//!    （[`Aurora::prepare_modpack`]），调用方可以在这之后占住实例名再往下走。
//! 2. 原子地建目录（同名即报错），写下带任务 id 的未完成标记（[`Aurora::import_modpack`] 从这里开始）。
//! 3. 装整合包要求的原版与加载器（与「安装版本」同一条路径，落在它们自然的版本目录里）。
//! 4. 在实例目录写一份以实例名为 id 的版本 JSON：有加载器时是加载器 JSON 的副本，原版时只
//!    `inheritsFrom` 原版。启动按 `inheritsFrom` 找客户端 jar，实例目录里不需要 jar。
//! 5. 实例强制隔离：整合包的 Mod 与配置只该出现在这个实例里。
//! 6. 下载远程文件、解出覆盖文件（覆盖文件在后，作者打进包里的配置压过下载来的默认值）。
//! 7. 写整合包信息，去掉未完成标记。
//!
//! 任何一步失败或取消，都按未完成标记删掉这个实例目录；标记里的任务 id 保证只删本次建的目录。
//! 原版与加载器的自然版本目录留着：它们是完整可用的版本，别的实例也可能在用。

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use aurora_download::DownloadTask;
use aurora_instance::{
    AURORA_META_DIR, IncompleteKind, IncompleteMarker, IsolationOverride, MarkerStore,
    VERSIONS_DIR, VersionSettings, VersionSettingsStore,
};
use aurora_modpack::{
    CurseForgeFileRef, PackArchive, PackFormat, PackLoader, PackLoaderKind, RemoteFiles,
};
use aurora_modplatform::{CurseForgeClient, CurseForgeFile, Platform};
use serde::{Deserialize, Serialize};

use crate::error::{CoreError, Result};
use crate::event::{CoreEvent, EventSink, emit};
use crate::facade::Aurora;
use crate::install::LoaderChoice;
use crate::instance_install::{MarkerSettlement, now_millis};
use crate::resources::{curseforge_download_url, is_safe_file_name};

/// 实例名的最大字符数：界面上要完整显示，路径也不宜过长。
pub const INSTANCE_NAME_MAX_CHARS: usize = 32;

/// 实例目录里的整合包信息文件名（在启动器元数据目录下）。
const MODPACK_INFO_FILE: &str = "modpack.json";
/// 整合包信息的格式版本；字段不兼容地变化时递增。
const MODPACK_INFO_SCHEMA: u32 = 1;
/// CurseForge 批量接口一次带多少个 id。接口文档没写上限，大整合包有四五百个文件，
/// 分批是为了让单个请求体与响应都保持在常规大小。
const CURSEFORGE_BATCH: usize = 200;

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
    fn directly_in_mods(key: &str) -> bool {
        key.strip_prefix("mods/")
            .is_some_and(|name| !name.is_empty() && !name.contains('/'))
    }
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
    /// 平台整合包下载到的缓存目录；本地文件为 `None`。
    cache_dir: Option<PathBuf>,
}

impl PreparedModpack {
    /// 导入后的实例名（也是版本 id）。
    pub fn name(&self) -> &str {
        &self.name
    }

    /// 不导入了：删掉平台整合包的下载缓存，本地文件不动。
    pub async fn discard(self) {
        remove_pack_cache(self.cache_dir.as_deref()).await;
    }
}

/// 下载来的包只是导入的中间产物；删不掉不影响任何实例，留日志即可。
async fn remove_pack_cache(dir: Option<&Path>) {
    let Some(dir) = dir else {
        return;
    };
    if let Err(err) = tokio::fs::remove_dir_all(dir).await {
        tracing::warn!(dir = %dir.display(), error = %err, "整合包下载缓存未能删除");
    }
}

impl Aurora {
    /// 预览本地整合包文件：只读清单与条目表，不解压。CurseForge 清单有远程文件时要问两个批量接口才
    /// 数得出 Mod、算得出下载量（导入同样要问），没配 API key 或断网时与导入报同样的错。
    pub async fn preview_modpack_file(&self, path: &Path) -> Result<ModpackPreview> {
        let archive = read_pack_blocking(path.to_path_buf()).await?;
        let remote = self.remote_facts(&archive.manifest.remote).await?;
        Ok(preview_of(&archive, remote))
    }

    /// 把整合包导入为新实例：[`Aurora::prepare_modpack`] 之后紧接 [`Aurora::import_modpack`]。
    /// 需要在建目录前占住实例名的调用方分开调用这两步。
    pub async fn install_modpack(
        &self,
        source: &ModpackSource,
        name: Option<&str>,
        task_id: &str,
        events: Option<&EventSink>,
    ) -> Result<ModpackInstallOutcome> {
        let prepared = self.prepare_modpack(source, name, events).await?;
        self.import_modpack(prepared, task_id, events).await
    }

    /// 导入的第一步：拿到整合包（平台整合包先下载到缓存目录）、读清单、定下实例名并查重，把远程
    /// 文件换成下载任务（CurseForge 禁止分发的文件在这里整体报错）。`name` 缺省用整合包自己的名字。
    ///
    /// 不动游戏目录。之后交给 [`Aurora::import_modpack`]，不导入了就 [`PreparedModpack::discard`]。
    pub async fn prepare_modpack(
        &self,
        source: &ModpackSource,
        name: Option<&str>,
        events: Option<&EventSink>,
    ) -> Result<PreparedModpack> {
        let (pack_path, cache_dir) = match source {
            ModpackSource::File { path } => (path.clone(), None),
            ModpackSource::Platform {
                platform,
                project_id,
                version_id,
            } => {
                let (pack, dir) = self
                    .download_platform_pack(*platform, project_id, version_id, events)
                    .await?;
                (pack, Some(dir))
            }
        };
        match self.read_prepared(source, name, &pack_path, events).await {
            Ok((name, archive, remote)) => Ok(PreparedModpack {
                source: source.clone(),
                name,
                pack_path,
                archive,
                remote,
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
            cache_dir,
        } = prepared;
        let outcome = self
            .import_into_new_dir(&archive, &pack_path, &source, name, remote, task_id, events)
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

    /// 读清单、定实例名并查重、把远程文件换成下载任务。
    async fn read_prepared(
        &self,
        source: &ModpackSource,
        name: Option<&str>,
        pack_path: &Path,
        events: Option<&EventSink>,
    ) -> Result<(String, PackArchive, Vec<RemoteDownload>)> {
        let archive = read_pack_blocking(pack_path.to_path_buf()).await?;
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
            .remote_downloads(&manifest.remote, &version_dir)
            .await?;
        tracing::debug!(%name, ?source, remote = remote.len(), "整合包导入已准备好");
        Ok((name, archive, remote))
    }

    #[allow(clippy::too_many_arguments)]
    async fn import_into_new_dir(
        &self,
        archive: &PackArchive,
        pack_path: &Path,
        source: &ModpackSource,
        name: String,
        remote: Vec<RemoteDownload>,
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
        remote: Vec<RemoteDownload>,
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

        let remote_files = remote.len();
        if remote_files > 0 {
            emit(
                events,
                CoreEvent::stage(format!("下载 {remote_files} 个整合包文件")),
            );
            self.download_remote(remote, events).await?;
        }

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
    async fn download_platform_pack(
        &self,
        platform: Platform,
        project_id: &str,
        version_id: &str,
        events: Option<&EventSink>,
    ) -> Result<(PathBuf, PathBuf)> {
        // 版本 id 要拼进缓存目录名。
        if !is_safe_file_name(version_id) {
            return Err(CoreError::InvalidProjectId {
                platform: platform.display_name(),
                project_id: format!("{project_id}/{version_id}"),
            });
        }
        let cache_root = self
            .config()
            .cache_directory
            .clone()
            .unwrap_or_else(|| self.data_dir().join("cache"));
        let platform_slug = match platform {
            Platform::Modrinth => "modrinth",
            Platform::CurseForge => "curseforge",
        };
        let dir = cache_root
            .join("modpacks")
            .join(format!("{platform_slug}-{version_id}"));
        let (file_name, task) = self
            .platform_file_task(platform, project_id, version_id, &dir)
            .await?;
        emit(events, CoreEvent::stage(format!("下载整合包 {file_name}")));
        let dest = task.dest.clone();
        let report = self
            .download_pool_reporting(events)
            .download_all(vec![task], None)
            .await?;
        if let Some(failure) = report.failures.into_iter().next() {
            return Err(failure.error.into());
        }
        Ok((dest, dir))
    }

    /// 把清单里的远程文件变成下载任务（落点都在实例目录下）。
    async fn remote_downloads(
        &self,
        remote: &RemoteFiles,
        version_dir: &Path,
    ) -> Result<Vec<RemoteDownload>> {
        match remote {
            RemoteFiles::Modrinth(files) => {
                let mut downloads = Vec::with_capacity(files.len());
                for file in files {
                    let Some((first, rest)) = file.urls.split_first() else {
                        return Err(aurora_modpack::Error::ManifestInvalid {
                            document: "modrinth.index.json",
                            reason: format!("{} 没有下载地址", file.path),
                        }
                        .into());
                    };
                    downloads.push(RemoteDownload {
                        task: DownloadTask::new(
                            first.clone(),
                            file.path.resolve_under(version_dir),
                        )
                        .with_sha1(file.sha1.clone())
                        .with_size(file.size),
                        fallbacks: rest.to_vec(),
                    });
                }
                Ok(downloads)
            }
            RemoteFiles::CurseForge(refs) if refs.is_empty() => Ok(Vec::new()),
            RemoteFiles::CurseForge(refs) => {
                let client = self.curseforge_client()?;
                curseforge_downloads(&client, refs, version_dir).await
            }
        }
    }

    /// 远程文件的落点与总字节数。Modrinth 清单自带；CurseForge 要多问两个批量接口，没配 API key 时
    /// 与导入一样报 key 缺失（该源被禁用），没有远程文件时不问。
    pub(crate) async fn remote_facts(&self, remote: &RemoteFiles) -> Result<RemoteFacts> {
        match remote {
            RemoteFiles::Modrinth(files) => Ok(RemoteFacts {
                destinations: files.iter().map(|f| f.path.as_str().to_owned()).collect(),
                bytes: Some(files.iter().map(|f| f.size).sum()),
            }),
            RemoteFiles::CurseForge(refs) if refs.is_empty() => Ok(RemoteFacts {
                destinations: Vec::new(),
                bytes: Some(0),
            }),
            RemoteFiles::CurseForge(refs) => {
                curseforge_remote_facts(&self.curseforge_client()?, refs).await
            }
        }
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

/// CurseForge 清单引用的文件与各自所属工程的大类。导入换下载任务、摘要与预览数 Mod 和算下载量都从这里
/// 取落点，保证「预先报的数」与「导入后真正落进去的」是同一条规则。
struct CurseForgeIndex {
    files: HashMap<u32, CurseForgeFile>,
    classes: HashMap<u32, Option<u32>>,
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
        let mut classes: HashMap<u32, Option<u32>> = HashMap::with_capacity(mod_ids.len());
        for chunk in mod_ids.chunks(CURSEFORGE_BATCH) {
            for project in client.get_mods(chunk).await? {
                classes.insert(project.id, project.class_id);
            }
        }
        Ok(Self { files, classes })
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
        let class_id = self.classes.get(&reference.project_id).copied().flatten();
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
}

/// 清单里的远程文件导入后落在哪、一共多大：平台摘要与本地预览据此数 Mod、报下载量。
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct RemoteFacts {
    /// 相对实例目录的落点，正斜杠分隔。
    pub(crate) destinations: Vec<String>,
    /// 总字节数；平台没给齐每个文件的大小时为 `None`，不拿缺了几项的和冒充总量。
    pub(crate) bytes: Option<u64>,
}

/// CurseForge 清单只有工程与文件 id：落点与大小经 [`CurseForgeIndex`] 向批量接口要。
pub(crate) async fn curseforge_remote_facts(
    client: &CurseForgeClient,
    refs: &[CurseForgeFileRef],
) -> Result<RemoteFacts> {
    let index = CurseForgeIndex::fetch(client, refs).await?;
    let mut destinations = Vec::with_capacity(refs.len());
    let mut bytes = Some(0u64);
    for reference in refs {
        let (file, sub) = index.locate(reference)?;
        destinations.push(format!("{sub}/{}", file.file_name));
        bytes = bytes
            .zip(file.file_length)
            .map(|(sum, length)| sum + length);
    }
    Ok(RemoteFacts {
        destinations,
        bytes,
    })
}

/// CurseForge 清单里的文件 id 换成下载任务：落点按 [`CurseForgeIndex::locate`]，没给下载地址的再问
/// download-url 端点；作者禁止第三方分发的文件汇总成一个错误。
async fn curseforge_downloads(
    client: &CurseForgeClient,
    refs: &[CurseForgeFileRef],
    version_dir: &Path,
) -> Result<Vec<RemoteDownload>> {
    let index = CurseForgeIndex::fetch(client, refs).await?;
    let mut downloads = Vec::with_capacity(refs.len());
    let mut blocked = Vec::new();
    for reference in refs {
        let (file, sub) = index.locate(reference)?;
        let dest = version_dir.join(sub).join(&file.file_name);
        let task = match file.to_download_task(&dest) {
            Some(task) => task,
            None => {
                match curseforge_download_url(
                    client,
                    reference.project_id,
                    reference.file_id,
                    &file.file_name,
                )
                .await
                {
                    Ok(url) => {
                        let mut task = DownloadTask::new(url, &dest);
                        if let Some(size) = file.file_length {
                            task = task.with_size(size);
                        }
                        if let Some(sha1) = file.sha1() {
                            task = task.with_sha1(sha1.to_owned());
                        }
                        task
                    }
                    Err(CoreError::FileDistributionBlocked { files }) => {
                        blocked.extend(files);
                        continue;
                    }
                    Err(other) => return Err(other),
                }
            }
        };
        downloads.push(RemoteDownload {
            task,
            fallbacks: Vec::new(),
        });
    }
    if !blocked.is_empty() {
        return Err(CoreError::FileDistributionBlocked { files: blocked });
    }
    Ok(downloads)
}

fn preview_of(archive: &PackArchive, remote: RemoteFacts) -> ModpackPreview {
    let manifest = &archive.manifest;
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
            remote.destinations.iter().map(String::as_str),
            archive.overrides.iter().map(|entry| entry.path.as_str()),
        ),
        remote_bytes: remote.bytes,
        override_files: archive.overrides.len(),
        override_bytes: archive.overrides_bytes,
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
            .install_modpack(&source, Some("现有"), "task-dup", None)
            .await
            .unwrap_err();
        aurora
            .install_modpack(&source, Some("RLCraft"), "task-1", None)
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

        let outcome = aurora
            .install_modpack(&ModpackSource::File { path: pack }, None, "task-f", None)
            .await
            .unwrap();
        assert_eq!(outcome.version_id, "测试包");
        let dir = outcome.version_dir;
        let json: serde_json::Value =
            serde_json::from_slice(&std::fs::read(dir.join("测试包.json")).unwrap()).unwrap();
        assert_eq!(json["id"], "测试包");
        assert_eq!(json["inheritsFrom"], "test");
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
            .install_modpack(&source, Some("从平台装"), "task-p", None)
            .await
            .unwrap();
        assert_eq!(outcome.modpack.platform, Some(Platform::Modrinth));
        assert_eq!(outcome.modpack.project_id.as_deref(), Some("proj"));
        assert_eq!(outcome.modpack.version_id.as_deref(), Some("pv1"));
        assert_eq!(
            std::fs::read(outcome.version_dir.join("options.txt")).unwrap(),
            b"fov:90"
        );
        let cache = tmp
            .path()
            .join("data")
            .join("cache")
            .join("modpacks")
            .join("modrinth-pv1");
        assert!(!cache.exists(), "下载缓存应在导入后删除");
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
        let cache = tmp
            .path()
            .join("data")
            .join("cache")
            .join("modpacks")
            .join("modrinth-pv2");

        let prepared = aurora.prepare_modpack(&source, None, None).await.unwrap();
        assert_eq!(prepared.name(), "测试包");
        assert!(cache.join("pack.mrpack").is_file(), "平台包应已下到缓存");
        assert!(
            !aurora.game_dir().join("versions").join("测试包").exists(),
            "准备一步不建实例目录"
        );
        prepared.discard().await;
        assert!(!cache.exists(), "放弃导入时删掉下载缓存");

        let err = aurora
            .prepare_modpack(&source, Some("a/b"), None)
            .await
            .unwrap_err();
        assert!(matches!(
            err,
            CoreError::InstanceNameInvalid {
                rule: InstanceNameRule::IllegalChar,
                ..
            }
        ));
        assert!(!cache.exists(), "准备失败也不留下载缓存");
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
            .install_modpack(&source, Some("taken"), "t2", None)
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
            .install_modpack(&source, Some("TEST"), "t3", None)
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
            .install_modpack(&source, Some("a/b"), "t4", None)
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

    /// CurseForge 文件按所属工程的大类落进对应目录；禁止分发的文件汇总报错。
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

        let downloads =
            curseforge_downloads(&client, &refs(&[(1, 11), (2, 22), (3, 33), (4, 44)]), dir)
                .await
                .unwrap();
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

        let err = curseforge_downloads(&client, &refs(&[(1, 11), (5, 55), (6, 66)]), dir)
            .await
            .unwrap_err();
        assert!(
            matches!(&err, CoreError::FileDistributionBlocked { files } if files == &["blocked-a.jar", "blocked-b.jar"]),
            "{err:?}"
        );

        let err = curseforge_downloads(&client, &refs(&[(9, 99)]), dir)
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

        let facts = curseforge_remote_facts(&client, &refs).await.unwrap();
        assert_eq!(
            facts.destinations,
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
        let facts = curseforge_remote_facts(&client, &refs[..2]).await.unwrap();
        assert_eq!(facts.destinations.len(), 2);
        assert_eq!(facts.bytes, None, "缺一个文件的大小就不报总量");

        let err = curseforge_remote_facts(&client, &refs).await.unwrap_err();
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
        let remote = curseforge_remote_facts(&client, refs).await.unwrap();
        let preview = preview_of(&archive, remote);
        assert_eq!(preview.remote_files, 3);
        assert_eq!(
            preview.mod_files, 3,
            "create 与 jei 是 Mod、材质包不是；覆盖层的 create 盖掉下载的那份，再加 kubejs-extra"
        );
        assert_eq!(preview.remote_bytes, Some(30), "每个文件 10 字节");
        assert_eq!(preview.override_files, 4);
        server.verify().await;
    }

    #[test]
    fn forge_versions_with_minecraft_prefix_are_trimmed() {
        assert_eq!(strip_minecraft_prefix("1.20.1-47.2.0", "1.20.1"), "47.2.0");
        assert_eq!(strip_minecraft_prefix("47.2.0", "1.20.1"), "47.2.0");
        assert_eq!(strip_minecraft_prefix("1.20.10-1", "1.20.1"), "1.20.10-1");
    }
}
