//! 整合包导入为新实例。
//!
//! 来源有两种：平台上某整合包的一个版本（先下载到缓存目录），或用户选的本地 `.mrpack` / `.zip`。
//! 导入总是新建一个实例目录 `versions/<实例名>/`，按顺序：
//!
//! 1. 读清单；CurseForge 包先把全部文件 id 换成下载地址——有作者禁止第三方分发的文件就在这一步
//!    整体报错，不先装几百 MB 游戏再告诉用户装不完。
//! 2. 校验实例名并原子地建目录（同名即报错），写下带任务 id 的未完成标记。
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
    AURORA_META_DIR, IsolationOverride, VERSIONS_DIR, VersionSettings, VersionSettingsStore,
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
use crate::resources::{curseforge_download_url, is_safe_file_name};

/// 实例名的最大字符数：界面上要完整显示，路径也不宜过长。
pub const INSTANCE_NAME_MAX_CHARS: usize = 32;

/// 实例目录里的整合包信息文件名（在启动器元数据目录下）。
const MODPACK_INFO_FILE: &str = "modpack.json";
/// 未完成标记文件名（在启动器元数据目录下）。
const INCOMPLETE_MARKER_FILE: &str = "incomplete.json";
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
    /// 远程文件总字节数；CurseForge 清单不带大小，为 `None`。
    pub remote_bytes: Option<u64>,
    /// 包内自带的覆盖文件数。
    pub override_files: usize,
    /// 覆盖文件总字节数。
    pub override_bytes: u64,
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

#[derive(Serialize, Deserialize)]
struct IncompleteMarker {
    kind: String,
    task_id: String,
}

const MARKER_KIND_MODPACK: &str = "modpack";

/// 一个要下载的远程文件；Modrinth 清单可以给多个地址，前一个失败换下一个。
#[derive(Debug)]
struct RemoteDownload {
    task: DownloadTask,
    fallbacks: Vec<String>,
}

impl Aurora {
    /// 预览本地整合包文件（只读清单与条目表，不解压、不触网）。
    pub async fn preview_modpack_file(&self, path: &Path) -> Result<ModpackPreview> {
        let archive = read_pack_blocking(path.to_path_buf()).await?;
        let manifest = &archive.manifest;
        let remote_bytes = match &manifest.remote {
            RemoteFiles::Modrinth(files) => Some(files.iter().map(|f| f.size).sum()),
            RemoteFiles::CurseForge(_) => None,
        };
        Ok(ModpackPreview {
            format: manifest.format,
            name: manifest.name.clone(),
            version: manifest.version.clone(),
            summary: manifest.summary.clone(),
            author: manifest.author.clone(),
            minecraft: manifest.minecraft.clone(),
            loader: manifest.loader.clone(),
            remote_files: manifest.remote.len(),
            remote_bytes,
            override_files: archive.overrides.len(),
            override_bytes: archive.overrides_bytes,
        })
    }

    /// 把整合包导入为新实例。`name` 缺省用整合包自己的名字；`task_id` 写进未完成标记，
    /// 供 [`Aurora::discard_incomplete_modpack`] 在任务被强行放弃后找回并清理。
    pub async fn install_modpack(
        &self,
        source: &ModpackSource,
        name: Option<&str>,
        task_id: &str,
        events: Option<&EventSink>,
    ) -> Result<ModpackInstallOutcome> {
        match source {
            ModpackSource::File { path } => {
                self.install_modpack_from(path, source, name, task_id, events)
                    .await
            }
            ModpackSource::Platform {
                platform,
                project_id,
                version_id,
            } => {
                let (pack, cache_dir) = self
                    .download_platform_pack(*platform, project_id, version_id, events)
                    .await?;
                let outcome = self
                    .install_modpack_from(&pack, source, name, task_id, events)
                    .await;
                // 下载来的包只是安装的中间产物；删不掉不影响已装好的实例，留日志即可。
                if let Err(err) = tokio::fs::remove_dir_all(&cache_dir).await {
                    tracing::warn!(dir = %cache_dir.display(), error = %err, "整合包下载缓存未能删除");
                }
                outcome
            }
        }
    }

    /// 删掉 `task_id` 这次导入留下的未完成实例，返回删掉的实例名。
    ///
    /// 导入在自己的失败路径上已经会清理；这个入口给「任务在取消宽限期后被强行放弃」的情况用：
    /// 那时导入的 future 已被丢弃，清理代码没机会跑。
    pub async fn discard_incomplete_modpack(&self, task_id: &str) -> Result<Option<String>> {
        let versions = self.game_dir().join(VERSIONS_DIR);
        let mut entries = match tokio::fs::read_dir(&versions).await {
            Ok(entries) => entries,
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(source) => {
                return Err(aurora_base::Error::Io {
                    path: versions,
                    source,
                }
                .into());
            }
        };
        while let Some(entry) =
            entries
                .next_entry()
                .await
                .map_err(|source| aurora_base::Error::Io {
                    path: versions.clone(),
                    source,
                })?
        {
            let dir = entry.path();
            if read_marker(&dir)
                .await?
                .is_some_and(|m| m.task_id == task_id)
            {
                remove_instance_dir(&dir).await?;
                return Ok(Some(entry.file_name().to_string_lossy().into_owned()));
            }
        }
        Ok(None)
    }

    async fn install_modpack_from(
        &self,
        pack_path: &Path,
        source: &ModpackSource,
        name: Option<&str>,
        task_id: &str,
        events: Option<&EventSink>,
    ) -> Result<ModpackInstallOutcome> {
        let archive = read_pack_blocking(pack_path.to_path_buf()).await?;
        let manifest = &archive.manifest;
        let requested = name.unwrap_or(&manifest.name);
        let name = validate_instance_name(requested).map_err(|rule| name_error(requested, rule))?;
        if name.eq_ignore_ascii_case(&manifest.minecraft) {
            return Err(name_error(&name, InstanceNameRule::Duplicate));
        }
        self.ensure_name_free(&name).await?;
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

        create_instance_dir(&version_dir, &name).await?;
        write_marker(&version_dir, task_id).await?;
        let populated = self
            .populate_instance(
                &archive,
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
        let marker = meta.join(INCOMPLETE_MARKER_FILE);
        tokio::fs::remove_file(&marker)
            .await
            .map_err(|source| aurora_base::Error::Io {
                path: marker,
                source,
            })?;
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

    /// 不区分大小写地检查 `versions/` 下有没有同名目录。
    async fn ensure_name_free(&self, name: &str) -> Result<()> {
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

/// CurseForge 清单里的文件 id 换成下载任务：批量取文件与所属工程（工程的大类决定落进哪个目录），
/// 没给下载地址的再问 download-url 端点；作者禁止第三方分发的文件汇总成一个错误。
async fn curseforge_downloads(
    client: &CurseForgeClient,
    refs: &[CurseForgeFileRef],
    version_dir: &Path,
) -> Result<Vec<RemoteDownload>> {
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

    let mut downloads = Vec::with_capacity(refs.len());
    let mut blocked = Vec::new();
    for reference in refs {
        let file = files
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
        let class_id = classes.get(&reference.project_id).copied().flatten();
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
    let marker = IncompleteMarker {
        kind: MARKER_KIND_MODPACK.to_owned(),
        task_id: task_id.to_owned(),
    };
    let bytes = serde_json::to_vec(&marker).map_err(CoreError::JsonSerialize)?;
    aurora_base::fs::atomic_write(
        version_dir
            .join(AURORA_META_DIR)
            .join(INCOMPLETE_MARKER_FILE),
        &bytes,
    )
    .await?;
    Ok(())
}

async fn read_marker(version_dir: &Path) -> Result<Option<IncompleteMarker>> {
    let path = version_dir
        .join(AURORA_META_DIR)
        .join(INCOMPLETE_MARKER_FILE);
    let bytes = match tokio::fs::read(&path).await {
        Ok(bytes) => bytes,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(source) => return Err(aurora_base::Error::Io { path, source }.into()),
    };
    let marker: IncompleteMarker = serde_json::from_slice(&bytes)
        .map_err(|source| CoreError::JsonFileInvalid { path, source })?;
    Ok((marker.kind == MARKER_KIND_MODPACK).then_some(marker))
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
        assert!(
            !dir.join(AURORA_META_DIR)
                .join(INCOMPLETE_MARKER_FILE)
                .exists()
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

    #[tokio::test]
    async fn discard_removes_only_the_instance_marked_by_that_task() {
        let tmp = tempfile::tempdir().unwrap();
        let server = MockServer::start().await;
        let aurora = aurora(tmp.path(), &server);
        let versions = aurora.game_dir().join("versions");
        for (name, task) in [("a", Some("t1")), ("b", Some("t2")), ("c", None)] {
            let dir = versions.join(name);
            std::fs::create_dir_all(&dir).unwrap();
            if let Some(task) = task {
                write_marker(&dir, task).await.unwrap();
            }
        }

        assert_eq!(
            aurora
                .discard_incomplete_modpack("t1")
                .await
                .unwrap()
                .as_deref(),
            Some("a")
        );
        assert!(!versions.join("a").exists());
        assert!(versions.join("b").exists());
        assert!(versions.join("c").exists());
        assert_eq!(aurora.discard_incomplete_modpack("t9").await.unwrap(), None);
        assert_eq!(
            read_instance_modpack(&versions.join("c")).await.unwrap(),
            None
        );
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

    #[test]
    fn forge_versions_with_minecraft_prefix_are_trimmed() {
        assert_eq!(strip_minecraft_prefix("1.20.1-47.2.0", "1.20.1"), "47.2.0");
        assert_eq!(strip_minecraft_prefix("47.2.0", "1.20.1"), "47.2.0");
        assert_eq!(strip_minecraft_prefix("1.20.10-1", "1.20.1"), "1.20.10-1");
    }
}
