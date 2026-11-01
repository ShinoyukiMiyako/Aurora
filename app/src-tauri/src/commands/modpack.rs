//! 整合包：预览本地整合包文件、不下载整包读平台整合包的清单摘要，把平台或本地整合包导入为新实例；
//! 认领用户手动下载的受限文件。

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use aurora_core::{
    is_safe_file_name, Aurora, BlockedFile, ClaimReport, EventSink, ImportSelection,
    InstanceModpack, MarkerError, MarkerSettlement, ModpackInstallOutcome, ModpackPreview,
    ModpackSource, ModpackSummary, PackFileAvailability, PackFileOrigin, PackFormat, PackLoader,
    PackModEntry,
};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, State};

use crate::commands::discover::parse_platform;
use crate::commands::error::code;
use crate::commands::instances::{InstanceActivity, InstanceGuard, InstanceLocks};
use crate::commands::CommandError;
use crate::events::CoreEventForwarder;
use crate::facade::Facade;
use crate::tasks::TaskRegistry;

/// 前端传来的整合包来源：`{ kind: "platform", platform, project_id, version_id }` 或
/// `{ kind: "file", path }`（路径来自系统文件对话框）。
#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ModpackSourceArg {
    Platform {
        platform: String,
        project_id: String,
        version_id: String,
    },
    File {
        path: String,
    },
}

/// 本地整合包预览 DTO。
#[derive(Debug, Serialize)]
pub struct ModpackPreviewDto {
    pub format: PackFormat,
    pub name: String,
    pub version: Option<String>,
    pub summary: Option<String>,
    pub author: Option<String>,
    pub minecraft: String,
    pub loader: Option<PackLoader>,
    pub remote_files: usize,
    /// 导入后落进 mods/ 的 Mod 数，与平台摘要同一口径。
    pub mod_files: usize,
    /// 平台没给齐每个文件的大小时为 `null`。
    pub remote_bytes: Option<u64>,
    pub override_files: usize,
    pub override_bytes: u64,
    /// 导入后落进 mods/ 的每个文件；条数等于 `mod_files`。
    pub mods: Vec<PackModDto>,
    /// 不直接落进 mods/ 的可选文件（资源包、光影、配置）。
    pub optional_extras: Vec<PackModDto>,
    /// 要到 CurseForge 网页手动下载、还没认领到的文件；不为空时导入会以 distribution_blocked 失败。
    pub blocked_files: Vec<BlockedFileDto>,
}

/// 预览里列出的一个整合包文件。
#[derive(Debug, Serialize)]
pub struct PackModDto {
    /// 相对实例目录的落点，正斜杠分隔；取消勾选可选文件时原样放进 excludedOptional。
    pub path: String,
    pub file_name: String,
    pub origin: PackFileOrigin,
    pub optional: bool,
    pub project_id: Option<u32>,
    pub file_id: Option<u32>,
    pub availability: PackFileAvailability,
}

impl From<PackModEntry> for PackModDto {
    fn from(entry: PackModEntry) -> Self {
        Self {
            path: entry.path,
            file_name: entry.file_name,
            origin: entry.origin,
            optional: entry.optional,
            project_id: entry.project_id,
            file_id: entry.file_id,
            availability: entry.availability,
        }
    }
}

/// 一个要到 CurseForge 网页手动下载的文件。预览、distribution_blocked 错误的 detail.files 与认领命令的
/// 入参共用这一个形状：前端从错误或预览里拿到清单，原样交回认领。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BlockedFileDto {
    pub project_id: u32,
    pub file_id: u32,
    pub file_name: String,
    pub web_url: String,
    /// 相对实例目录的落点，正斜杠分隔，如 `mods/foo.jar`。
    pub destination: String,
    pub sha1: Option<String>,
    /// 平台的 fileFingerprint；0 表示平台没给。
    pub fingerprint: u64,
    pub size: Option<u64>,
}

impl From<&BlockedFile> for BlockedFileDto {
    fn from(file: &BlockedFile) -> Self {
        Self {
            project_id: file.project_id,
            file_id: file.file_id,
            file_name: file.file_name.clone(),
            web_url: file.web_url.clone(),
            destination: file.destination.clone(),
            sha1: file.sha1.clone(),
            fingerprint: file.fingerprint,
            size: file.size,
        }
    }
}

impl From<BlockedFileDto> for BlockedFile {
    fn from(file: BlockedFileDto) -> Self {
        Self {
            project_id: file.project_id,
            file_id: file.file_id,
            file_name: file.file_name,
            web_url: file.web_url,
            destination: file.destination,
            sha1: file.sha1,
            fingerprint: file.fingerprint,
            size: file.size,
        }
    }
}

/// 认领结果 DTO。
#[derive(Debug, Serialize)]
pub struct ClaimReportDto {
    pub claimed: Vec<ClaimedFileDto>,
    /// 没找到的文件 id，按入参顺序。
    pub missing: Vec<u32>,
}

/// 认领到的一个文件。
#[derive(Debug, Serialize)]
pub struct ClaimedFileDto {
    pub file_id: u32,
    /// 认领自哪个文件；之前已经认领过的给暂存位里的路径。
    pub source_path: String,
}

/// 平台整合包版本的清单摘要 DTO。
#[derive(Debug, Serialize)]
pub struct ModpackSummaryDto {
    pub format: PackFormat,
    pub name: String,
    pub version: Option<String>,
    pub minecraft: String,
    pub loader: Option<PackLoader>,
    /// 整合包文件本身的字节数。
    pub pack_bytes: u64,
    /// 导入时要另外下载的远程文件数。
    pub remote_files: usize,
    /// 导入后落进 mods/ 的 Mod 数，与本地预览同一口径；CurseForge 的远程文件按工程大类认。
    pub mod_files: usize,
    /// 远程文件总字节数；平台没给齐每个文件的大小时为 `null`。
    pub remote_bytes: Option<u64>,
    pub override_files: usize,
    pub override_bytes: u64,
}

/// 平台整合包某个版本的清单摘要（Mod 数、要下载的字节）。只按范围读包末尾的目录与清单条目，
/// 不下载整包；服务器不支持范围读取、包不是可读的 zip 或缺清单时报 `remote_pack_unreadable`。
/// CurseForge 另问批量文件与批量工程两个接口，没配 API key 时报 CurseForge 源被禁用的同一个错误。
#[tauri::command]
pub async fn summarize_platform_modpack(
    platform: String,
    project_id: String,
    version_id: String,
    facade: State<'_, Facade>,
) -> Result<ModpackSummaryDto, CommandError> {
    let platform = parse_platform(&platform)?;
    let project_id = non_blank("project_id", &project_id)?;
    let version_id = non_blank("version_id", &version_id)?;
    let aurora = facade.snapshot().await;
    Ok(summary_dto(
        aurora
            .summarize_platform_modpack(platform, project_id, version_id)
            .await?,
    ))
}

fn summary_dto(summary: ModpackSummary) -> ModpackSummaryDto {
    ModpackSummaryDto {
        format: summary.format,
        name: summary.name,
        version: summary.version,
        minecraft: summary.minecraft,
        loader: summary.loader,
        pack_bytes: summary.pack_bytes,
        remote_files: summary.remote_files,
        mod_files: summary.mod_files,
        remote_bytes: summary.remote_bytes,
        override_files: summary.override_files,
        override_bytes: summary.override_bytes,
    }
}

/// 整合包导入结果 DTO。
#[derive(Debug, Serialize)]
pub struct ModpackInstallOutcomeDto {
    /// 新实例的版本 id（即实例名）。
    pub version_id: String,
    pub version_dir: String,
    pub modpack: InstanceModpack,
}

/// 读本地整合包的清单与条目表，供导入前确认（不解压）。CurseForge 清单有远程文件时另问批量文件与
/// 批量工程两个接口来数 Mod、算下载量，没配 API key 时报 CurseForge 源被禁用的同一个错误。
#[tauri::command]
pub async fn preview_modpack(
    path: String,
    facade: State<'_, Facade>,
) -> Result<ModpackPreviewDto, CommandError> {
    preview_modpack_with(&facade, &path).await
}

pub(crate) async fn preview_modpack_with(
    facade: &Facade,
    path: &str,
) -> Result<ModpackPreviewDto, CommandError> {
    let path = non_blank("path", path)?;
    let aurora = facade.snapshot().await;
    Ok(preview_dto(
        aurora.preview_modpack_file(Path::new(path)).await?,
    ))
}

/// 长任务：把整合包导入为新实例。`name` 缺省用整合包自己的名字；`excluded_optional` 是取消勾选的
/// 可选文件（预览里的 `path`），缺省与空数组相同：前端旧任务日志里没有这个键，重试时原样传参。进度经
/// core-event 推送并带 `task_id`，可用 cancel_task 取消；失败或取消后不留半成品实例。
///
/// 实例名一定下来（平台整合包要先下载完才知道清单里的名字）就以「安装」占住，直到导入结束、半成品
/// 清理完：这期间启动、改名、删除这个实例都报 `instance_busy`，列表里它的 activity 为 installing。
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn install_modpack(
    app: AppHandle,
    task_id: String,
    source: ModpackSourceArg,
    name: Option<String>,
    excluded_optional: Option<Vec<String>>,
    facade: State<'_, Facade>,
    tasks: State<'_, TaskRegistry>,
    locks: State<'_, InstanceLocks>,
) -> Result<ModpackInstallOutcomeDto, CommandError> {
    let events = CoreEventForwarder::to_app(&app, Some(task_id.clone()));
    let outcome = install_modpack_with(
        &facade,
        &tasks,
        &locks,
        &task_id,
        source,
        name.as_deref(),
        excluded_optional,
        events.sink(),
    )
    .await;
    events.finish().await;
    crate::textures::refresh_on_success(&app, &outcome).await;
    outcome
}

#[allow(clippy::too_many_arguments)]
pub(crate) async fn install_modpack_with(
    facade: &Facade,
    tasks: &TaskRegistry,
    locks: &InstanceLocks,
    task_id: &str,
    source: ModpackSourceArg,
    name: Option<&str>,
    excluded_optional: Option<Vec<String>>,
    events: &EventSink,
) -> Result<ModpackInstallOutcomeDto, CommandError> {
    // 先解析全部入参再登记任务：参数非法不该占用任务 id。是不是包里的可选文件要读了包才知道，由准备
    // 一步判（不是的报 invalid_argument）。
    let source = parse_source(source)?;
    let selection = parse_selection(excluded_optional)?;
    let task = tasks.register(task_id)?;
    let aurora = facade.snapshot().await.with_cancel(task.token().clone());
    // 占用守卫与实例名放在导入的 future 之外：取消宽限期满时 run 会丢弃 future，实例名得一直占到下面
    // 按名字清理完半成品，否则清理前的空档里别的命令就能动这个目录。
    let reserved: Mutex<Option<(String, InstanceGuard)>> = Mutex::new(None);
    let result = task
        .run(async {
            let prepared = aurora
                .prepare_modpack(&source, name, &selection, Some(events))
                .await?;
            let guard = match locks.acquire(prepared.name(), InstanceActivity::Installing) {
                Ok(guard) => guard,
                Err(busy) => {
                    prepared.discard().await;
                    return Err(busy);
                }
            };
            // 准备阶段查重与占住之间，别的命令可能抢先建了同名实例；占住之后仍然空闲，名下之后出现的
            // 目录才能认定是这次导入建的，失败时才可以放心按名字删。
            if let Err(taken) = aurora.ensure_modpack_name_free(prepared.name()).await {
                prepared.discard().await;
                return Err(taken.into());
            }
            *reserved.lock().expect("整合包导入的占用槽锁已中毒") =
                Some((prepared.name().to_owned(), guard));
            Ok(aurora
                .import_modpack(prepared, task_id, Some(events))
                .await?)
        })
        .await;
    match result {
        Ok(outcome) => Ok(outcome_dto(outcome)),
        Err(err) => {
            let name = reserved
                .lock()
                .expect("整合包导入的占用槽锁已中毒")
                .as_ref()
                .map(|(name, _)| name.clone());
            if let Some(name) = name {
                discard_failed_import(&aurora, &name, task_id, &err).await;
            }
            Err(err)
        }
    }
}

/// 导入失败后按名字删掉半成品。导入自己的失败路径已经删过一次，这里兜住两种情况：取消宽限期满时
/// 导入的 future 被丢弃、清理代码没机会跑；删目录失败（文件被杀毒软件等占用）。还是删不掉就把未完成
/// 标记落成这次导入的结局，列表里显示导入已经失败或取消，而不是一直停在进行中，用户可以自己删。
/// 清理的问题只记日志：返回给前端的仍是导入本身的错误，用户要看到的是导入为什么没成。
async fn discard_failed_import(aurora: &Aurora, name: &str, task_id: &str, err: &CommandError) {
    let cleanup = match aurora.discard_modpack_import(name).await {
        Ok(true) => {
            tracing::info!(task_id, name, "已删除导入未完成的实例");
            return;
        }
        Ok(false) => return,
        Err(cleanup) => cleanup,
    };
    tracing::error!(task_id, name, error = %cleanup, "删除导入未完成的实例失败，改为记下导入的结局");
    let settlement = if err.is_cancelled() {
        MarkerSettlement::Cancelled
    } else {
        MarkerSettlement::Failed(MarkerError {
            code: err.code.to_owned(),
            message: err.message.clone(),
        })
    };
    if let Err(settle) = aurora
        .settle_modpack_import(name, task_id, settlement)
        .await
    {
        tracing::error!(task_id, name, error = %settle, "记录导入未完成标记失败");
    }
}

fn parse_selection(excluded: Option<Vec<String>>) -> Result<ImportSelection, CommandError> {
    let excluded_optional = excluded
        .unwrap_or_default()
        .into_iter()
        .map(|path| {
            let trimmed = path.trim();
            if trimmed.is_empty() {
                Err(CommandError::invalid_argument(
                    "excludedOptional 里有空路径",
                ))
            } else {
                Ok(trimmed.to_owned())
            }
        })
        .collect::<Result<Vec<_>, _>>()?;
    Ok(ImportSelection { excluded_optional })
}

/// 从用户选的文件夹里认领手动下载好的受限文件（`files` 取自预览或 distribution_blocked 错误的清单），
/// 校验通过的复制进暂存位，之后的导入直接用。只看文件夹顶层；不联网、不占实例，不是长任务。
/// 文件夹不存在或不是文件夹报 io，detail.path 为所选文件夹。
#[tauri::command]
pub async fn claim_blocked_files(
    folder: String,
    files: Vec<BlockedFileDto>,
    facade: State<'_, Facade>,
) -> Result<ClaimReportDto, CommandError> {
    claim_blocked_files_with(&facade, &folder, files).await
}

pub(crate) async fn claim_blocked_files_with(
    facade: &Facade,
    folder: &str,
    files: Vec<BlockedFileDto>,
) -> Result<ClaimReportDto, CommandError> {
    let folder = non_blank("folder", folder)?;
    if files.is_empty() {
        return Err(CommandError::invalid_argument("files 不能为空"));
    }
    let mut seen = HashSet::with_capacity(files.len());
    for file in &files {
        if !is_safe_file_name(&file.file_name) {
            return Err(CommandError::invalid_argument(format!(
                "file_name 不是单个文件名：{}",
                file.file_name
            )));
        }
        if !seen.insert(file.file_id) {
            return Err(CommandError::invalid_argument(format!(
                "file_id 重复：{}",
                file.file_id
            )));
        }
    }
    let files: Vec<BlockedFile> = files.into_iter().map(BlockedFile::from).collect();
    let aurora = facade.snapshot().await;
    Ok(claim_dto(
        aurora
            .claim_blocked_files(Path::new(folder), &files)
            .await?,
    ))
}

fn claim_dto(report: ClaimReport) -> ClaimReportDto {
    ClaimReportDto {
        claimed: report
            .claimed
            .into_iter()
            .map(|claimed| ClaimedFileDto {
                file_id: claimed.file_id,
                source_path: claimed.source.display().to_string(),
            })
            .collect(),
        missing: report.missing,
    }
}

/// 系统的下载文件夹（Windows 上是 FOLDERID_Downloads），受限文件清单选文件夹时默认定位到这里。
#[tauri::command]
pub async fn downloads_folder(app: AppHandle) -> Result<String, CommandError> {
    downloads_folder_from(app.path().download_dir())
}

fn downloads_folder_from(resolved: tauri::Result<PathBuf>) -> Result<String, CommandError> {
    resolved
        .map(|dir| dir.display().to_string())
        .map_err(|err| {
            CommandError::new(code::IO, "找不到系统的下载文件夹")
                .with_detail(serde_json::json!({ "causes": [err.to_string()] }))
        })
}

fn parse_source(source: ModpackSourceArg) -> Result<ModpackSource, CommandError> {
    match source {
        ModpackSourceArg::Platform {
            platform,
            project_id,
            version_id,
        } => Ok(ModpackSource::Platform {
            platform: parse_platform(&platform)?,
            project_id: non_blank("project_id", &project_id)?.to_owned(),
            version_id: non_blank("version_id", &version_id)?.to_owned(),
        }),
        ModpackSourceArg::File { path } => Ok(ModpackSource::File {
            path: PathBuf::from(non_blank("path", &path)?),
        }),
    }
}

fn non_blank<'a>(field: &str, value: &'a str) -> Result<&'a str, CommandError> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Err(CommandError::invalid_argument(format!("{field} 不能为空")));
    }
    Ok(trimmed)
}

fn preview_dto(preview: ModpackPreview) -> ModpackPreviewDto {
    ModpackPreviewDto {
        format: preview.format,
        name: preview.name,
        version: preview.version,
        summary: preview.summary,
        author: preview.author,
        minecraft: preview.minecraft,
        loader: preview.loader,
        remote_files: preview.remote_files,
        mod_files: preview.mod_files,
        remote_bytes: preview.remote_bytes,
        override_files: preview.override_files,
        override_bytes: preview.override_bytes,
        mods: preview.mods.into_iter().map(PackModDto::from).collect(),
        optional_extras: preview
            .optional_extras
            .into_iter()
            .map(PackModDto::from)
            .collect(),
        blocked_files: preview
            .blocked_files
            .iter()
            .map(BlockedFileDto::from)
            .collect(),
    }
}

fn outcome_dto(outcome: ModpackInstallOutcome) -> ModpackInstallOutcomeDto {
    ModpackInstallOutcomeDto {
        version_id: outcome.version_id,
        version_dir: outcome.version_dir.display().to_string(),
        modpack: outcome.modpack,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::{TcpListener, TcpStream};
    use std::time::{Duration, Instant};

    use aurora_core::{Aurora, AuroraConfig, CoreEvent, DownloadSourcePolicy, Platform};
    use wiremock::matchers::{method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    use crate::commands::error::code;
    use crate::tasks::CANCEL_DEADLINE;

    fn facade_in(dir: &Path, base: &str) -> Facade {
        let config = AuroraConfig {
            game_directory: Some(dir.join(".minecraft")),
            download_source: DownloadSourcePolicy::OfficialFirst,
            ..AuroraConfig::default()
        };
        let aurora = Aurora::open(config, dir.to_path_buf(), dir.join("config.json"))
            .unwrap()
            .with_platform_bases(base, base);
        Facade::new(aurora)
    }

    fn file(path: &str) -> ModpackSourceArg {
        ModpackSourceArg::File {
            path: path.to_owned(),
        }
    }

    #[test]
    fn source_arguments_deserialize_from_tagged_objects() {
        let platform: ModpackSourceArg = serde_json::from_value(serde_json::json!({
            "kind": "platform", "platform": "curseforge", "project_id": "394468", "version_id": "5000"
        }))
        .unwrap();
        assert_eq!(
            parse_source(platform).unwrap(),
            ModpackSource::Platform {
                platform: Platform::CurseForge,
                project_id: "394468".into(),
                version_id: "5000".into(),
            }
        );
        let local: ModpackSourceArg =
            serde_json::from_value(serde_json::json!({"kind": "file", "path": " D:/包.mrpack "}))
                .unwrap();
        assert_eq!(
            parse_source(local).unwrap(),
            ModpackSource::File {
                path: PathBuf::from("D:/包.mrpack")
            }
        );
        assert!(serde_json::from_value::<ModpackSourceArg>(
            serde_json::json!({"kind": "url", "url": "https://x"})
        )
        .is_err());

        for bad in [
            ModpackSourceArg::Platform {
                platform: "curse_forge".into(),
                project_id: "1".into(),
                version_id: "2".into(),
            },
            ModpackSourceArg::Platform {
                platform: "modrinth".into(),
                project_id: " ".into(),
                version_id: "2".into(),
            },
            file(""),
        ] {
            assert_eq!(parse_source(bad).unwrap_err().code, code::INVALID_ARGUMENT);
        }
    }

    #[tokio::test]
    async fn bad_arguments_are_rejected_before_registering() {
        let dir = tempfile::tempdir().unwrap();
        let facade = facade_in(dir.path(), "http://127.0.0.1:9");
        let registry = TaskRegistry::default();
        let (sink, _rx) = tokio::sync::mpsc::unbounded_channel::<CoreEvent>();
        let err = install_modpack_with(
            &facade,
            &registry,
            &InstanceLocks::default(),
            "mp",
            file("  "),
            None,
            None,
            &sink,
        )
        .await
        .unwrap_err();
        assert_eq!(err.code, code::INVALID_ARGUMENT);
        assert!(!registry.is_running("mp"));
    }

    /// 本地文件读不了或不是整合包时报对应的码与路径，任务随之注销。
    #[tokio::test]
    async fn unreadable_or_wrong_files_map_to_their_codes() {
        let dir = tempfile::tempdir().unwrap();
        let facade = facade_in(dir.path(), "http://127.0.0.1:9");
        let registry = TaskRegistry::default();
        let (sink, _rx) = tokio::sync::mpsc::unbounded_channel::<CoreEvent>();

        let missing = dir.path().join("不存在.mrpack");
        let err = install_modpack_with(
            &facade,
            &registry,
            &InstanceLocks::default(),
            "mp#1",
            file(&missing.display().to_string()),
            None,
            None,
            &sink,
        )
        .await
        .unwrap_err();
        assert_eq!(err.code, code::IO);
        assert_eq!(
            err.detail.unwrap()["path"],
            serde_json::json!(missing.display().to_string())
        );
        assert!(!registry.is_running("mp#1"));

        let jar = dir.path().join("mod.jar");
        std::fs::write(&jar, b"PK").unwrap();
        let err = preview_modpack_with(&facade, &jar.display().to_string())
            .await
            .unwrap_err();
        assert_eq!(err.code, code::MODPACK_UNSUPPORTED_EXTENSION);

        let garbage = dir.path().join("坏.zip");
        std::fs::write(&garbage, b"not a zip").unwrap();
        let err = preview_modpack_with(&facade, &garbage.display().to_string())
            .await
            .unwrap_err();
        assert_eq!(err.code, code::MODPACK_CORRUPT);
    }

    /// 导入失败后按任务 id 清掉它留下的半成品实例，别的任务的半成品不动。
    /// 还没定下实例名就失败的导入不碰游戏目录里的任何实例，哪怕别的目录带着整合包标记。
    #[tokio::test]
    async fn import_failing_before_reserving_a_name_touches_no_instance() {
        let dir = tempfile::tempdir().unwrap();
        let facade = facade_in(dir.path(), "http://127.0.0.1:9");
        let registry = TaskRegistry::default();
        let (sink, _rx) = tokio::sync::mpsc::unbounded_channel::<CoreEvent>();
        let versions = dir.path().join(".minecraft").join("versions");
        let other = versions.join("别人的");
        aurora_core::MarkerStore::for_version_dir(&other)
            .save(&aurora_core::IncompleteMarker::pending(
                aurora_core::IncompleteKind::Modpack {
                    task_id: "mp#2".to_owned(),
                },
                1,
            ))
            .await
            .unwrap();

        let missing = dir.path().join("missing.mrpack");
        let err = install_modpack_with(
            &facade,
            &registry,
            &InstanceLocks::default(),
            "mp#2",
            file(&missing.display().to_string()),
            None,
            None,
            &sink,
        )
        .await
        .unwrap_err();
        assert_eq!(err.code, code::IO);
        assert!(other.is_dir());
    }

    /// 只装原版 test、没有远程文件与覆盖文件的本地整合包。
    fn write_vanilla_pack(dest: &Path) {
        let mut writer = zip::ZipWriter::new(std::fs::File::create(dest).unwrap());
        writer
            .start_file(
                "modrinth.index.json",
                zip::write::SimpleFileOptions::default(),
            )
            .unwrap();
        let index = serde_json::json!({
            "formatVersion": 1, "game": "minecraft", "versionId": "1.0.0", "name": "测试包",
            "files": [], "dependencies": {"minecraft": "test"}
        });
        writer.write_all(index.to_string().as_bytes()).unwrap();
        writer.finish().unwrap();
    }

    /// 预览 DTO 带上 mod_files（snake_case），数的是落进 mods/ 的远程文件加上覆盖层 mods/ 下的 .jar。
    #[tokio::test]
    async fn preview_reports_the_mod_count_under_its_wire_name() {
        let dir = tempfile::tempdir().unwrap();
        let facade = facade_in(dir.path(), "http://127.0.0.1:9");
        let pack = dir.path().join("带 Mod.mrpack");
        let mut writer = zip::ZipWriter::new(std::fs::File::create(&pack).unwrap());
        let options = zip::write::SimpleFileOptions::default();
        writer.start_file("modrinth.index.json", options).unwrap();
        let index = serde_json::json!({
            "formatVersion": 1, "game": "minecraft", "versionId": "1.0.0", "name": "带 Mod",
            "dependencies": {"minecraft": "1.21.1"},
            "files": [{ "path": "mods/sodium.jar", "hashes": { "sha1": "a".repeat(40) },
                        "downloads": ["https://cdn.modrinth.com/sodium.jar"], "fileSize": 4096 }]
        });
        writer.write_all(index.to_string().as_bytes()).unwrap();
        for name in ["overrides/mods/extra.jar", "overrides/mods/notes.txt"] {
            writer.start_file(name, options).unwrap();
            writer.write_all(b"x").unwrap();
        }
        writer.finish().unwrap();

        let dto = preview_modpack_with(&facade, &pack.display().to_string())
            .await
            .unwrap();
        let wire = serde_json::to_value(&dto).unwrap();
        assert_eq!(wire["mod_files"], serde_json::json!(2));
        assert_eq!(wire["remote_bytes"], serde_json::json!(4096));
        assert_eq!(wire["override_files"], serde_json::json!(2));
    }

    /// 测试里走不到真正的删除：实例被占着时删除命令必须在动目录之前就拒绝。
    struct NeverDispose;

    impl aurora_core::Disposer for NeverDispose {
        fn dispose(&self, dir: &Path) -> Result<(), aurora_core::InstanceError> {
            panic!("导入中的实例不该被删除：{}", dir.display());
        }
    }

    /// 目标实例名正被别的事占着（例如同名改名进行中）时，导入在建目录前以 instance_busy 拒绝，
    /// 不留下实例目录，别人的占用原样保留。
    #[tokio::test]
    async fn import_into_a_busy_name_is_refused_before_creating_anything() {
        let dir = tempfile::tempdir().unwrap();
        let facade = facade_in(dir.path(), "http://127.0.0.1:9");
        let registry = TaskRegistry::default();
        let locks = InstanceLocks::default();
        let (sink, _rx) = tokio::sync::mpsc::unbounded_channel::<CoreEvent>();
        let pack = dir.path().join("pack.mrpack");
        write_vanilla_pack(&pack);
        let _held = locks.acquire("撞名", InstanceActivity::Renaming).unwrap();

        let err = install_modpack_with(
            &facade,
            &registry,
            &locks,
            "mp-busy",
            file(&pack.display().to_string()),
            Some(" 撞名 "),
            None,
            &sink,
        )
        .await
        .unwrap_err();

        assert_eq!(err.code, code::INSTANCE_BUSY);
        assert_eq!(
            err.detail.unwrap()["activity"],
            serde_json::json!("renaming")
        );
        assert!(!dir
            .path()
            .join(".minecraft")
            .join("versions")
            .join("撞名")
            .exists());
        assert!(!registry.is_running("mp-busy"));
        assert_eq!(locks.activity("撞名"), Some(InstanceActivity::Renaming));
    }

    /// 导入进行中实例名一直以「安装」占着：列表里 activity 为 installing，删除与改名报 instance_busy，
    /// 目录不动；取消后半成品删掉，占用随之释放。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn import_holds_the_instance_name_until_it_is_cleaned_up() {
        use crate::commands::instances::{
            delete_instance_with, list_instances_with, rename_instance_with,
        };

        let server = MockServer::start().await;
        let base = server.uri();
        Mock::given(method("GET"))
            .and(path("/manifest.json"))
            .respond_with(ResponseTemplate::new(200).set_body_string(format!(
                r#"{{"latest":{{"release":"test","snapshot":"test"}},
                    "versions":[{{"id":"test","type":"release","url":"{base}/test.json",
                    "time":"t","releaseTime":"t"}}]}}"#
            )))
            .mount(&server)
            .await;
        // 原版 JSON 迟迟不来：导入停在「实例目录已建好、游戏还没装完」的中途。
        Mock::given(method("GET"))
            .and(path("/test.json"))
            .respond_with(
                ResponseTemplate::new(200)
                    .set_body_string(r#"{"id":"test","type":"release","mainClass":"M"}"#)
                    .set_delay(Duration::from_secs(30)),
            )
            .mount(&server)
            .await;
        let dir = tempfile::tempdir().unwrap();
        let config = AuroraConfig {
            game_directory: Some(dir.path().join(".minecraft")),
            download_source: DownloadSourcePolicy::OfficialFirst,
            version_list_source: DownloadSourcePolicy::OfficialFirst,
            ..AuroraConfig::default()
        };
        let aurora = Aurora::open(
            config,
            dir.path().to_path_buf(),
            dir.path().join("config.json"),
        )
        .unwrap()
        .with_manifest_url(format!("{base}/manifest.json"));
        let facade = std::sync::Arc::new(Facade::new(aurora));
        let registry = std::sync::Arc::new(TaskRegistry::default());
        let locks = InstanceLocks::default();
        let pack = dir.path().join("pack.mrpack");
        write_vanilla_pack(&pack);
        let install = tokio::spawn({
            let (f, r, l) = (facade.clone(), registry.clone(), locks.clone());
            let source = file(&pack.display().to_string());
            async move {
                let (sink, _rx) = tokio::sync::mpsc::unbounded_channel::<CoreEvent>();
                install_modpack_with(&f, &r, &l, "mp-hold", source, Some("导入中"), None, &sink)
                    .await
            }
        });

        let instance = dir
            .path()
            .join(".minecraft")
            .join("versions")
            .join("导入中");
        let marker = aurora_core::MarkerStore::for_version_dir(&instance)
            .path()
            .to_path_buf();
        let deadline = Instant::now() + Duration::from_secs(10);
        while !marker.is_file() {
            assert!(Instant::now() < deadline, "导入没有建出实例目录");
            tokio::time::sleep(Duration::from_millis(10)).await;
        }

        assert_eq!(locks.activity("导入中"), Some(InstanceActivity::Installing));
        let listed = list_instances_with(&facade, &locks).await.unwrap();
        let entry = listed.iter().find(|i| i.id == "导入中").unwrap();
        assert_eq!(entry.activity, Some(InstanceActivity::Installing));
        let err = delete_instance_with(&facade, &locks, "导入中", NeverDispose)
            .await
            .unwrap_err();
        assert_eq!(err.code, code::INSTANCE_BUSY);
        assert_eq!(
            err.detail.unwrap()["activity"],
            serde_json::json!("installing")
        );
        let err = rename_instance_with(&facade, &locks, "导入中", "改名")
            .await
            .unwrap_err();
        assert_eq!(err.code, code::INSTANCE_BUSY);
        assert!(instance.is_dir());
        assert!(!dir
            .path()
            .join(".minecraft")
            .join("versions")
            .join("改名")
            .exists());

        assert!(registry.cancel("mp-hold"));
        let err = install.await.unwrap().unwrap_err();
        assert_eq!(err.code, code::CANCELLED);
        assert!(!instance.exists(), "取消后半成品应删掉");
        assert_eq!(locks.activity("导入中"), None);
    }

    /// 半成品里有文件被别的进程占着、删不掉：导入照样以取消返回、放开实例名，未完成标记落成「已取消」
    /// 而不是一直停在进行中；占用解除后能正常删除。
    #[cfg(windows)]
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn undeletable_half_import_is_settled_instead_of_left_pending() {
        use crate::commands::instances::{delete_instance_with, list_instances_with};
        use std::os::windows::fs::OpenOptionsExt;

        let server = MockServer::start().await;
        let base = server.uri();
        Mock::given(method("GET"))
            .and(path("/manifest.json"))
            .respond_with(ResponseTemplate::new(200).set_body_string(format!(
                r#"{{"latest":{{"release":"test","snapshot":"test"}},
                    "versions":[{{"id":"test","type":"release","url":"{base}/test.json",
                    "time":"t","releaseTime":"t"}}]}}"#
            )))
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path("/test.json"))
            .respond_with(
                ResponseTemplate::new(200)
                    .set_body_string(r#"{"id":"test","type":"release","mainClass":"M"}"#)
                    .set_delay(Duration::from_secs(30)),
            )
            .mount(&server)
            .await;
        let dir = tempfile::tempdir().unwrap();
        let config = AuroraConfig {
            game_directory: Some(dir.path().join(".minecraft")),
            download_source: DownloadSourcePolicy::OfficialFirst,
            version_list_source: DownloadSourcePolicy::OfficialFirst,
            ..AuroraConfig::default()
        };
        let aurora = Aurora::open(
            config,
            dir.path().to_path_buf(),
            dir.path().join("config.json"),
        )
        .unwrap()
        .with_manifest_url(format!("{base}/manifest.json"));
        let facade = std::sync::Arc::new(Facade::new(aurora));
        let registry = std::sync::Arc::new(TaskRegistry::default());
        let locks = InstanceLocks::default();
        let pack = dir.path().join("pack.mrpack");
        write_vanilla_pack(&pack);
        let install = tokio::spawn({
            let (f, r, l) = (facade.clone(), registry.clone(), locks.clone());
            let source = file(&pack.display().to_string());
            async move {
                let (sink, _rx) = tokio::sync::mpsc::unbounded_channel::<CoreEvent>();
                install_modpack_with(&f, &r, &l, "mp-locked", source, Some("删不掉"), None, &sink)
                    .await
            }
        });
        let instance = dir
            .path()
            .join(".minecraft")
            .join("versions")
            .join("删不掉");
        let marker = aurora_core::MarkerStore::for_version_dir(&instance);
        let deadline = Instant::now() + Duration::from_secs(10);
        while !marker.path().is_file() {
            assert!(Instant::now() < deadline, "导入没有建出实例目录");
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        // 不允许别人删除的打开方式：remove_dir_all 删不掉这个文件。
        let held = std::fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .share_mode(0)
            .open(instance.join("占着.log"))
            .unwrap();

        assert!(registry.cancel("mp-locked"));
        let err = install.await.unwrap().unwrap_err();
        assert_eq!(err.code, code::CANCELLED);
        assert!(instance.is_dir(), "文件被占着，半成品还在");
        assert_eq!(locks.activity("删不掉"), None, "导入结束后实例名放开");
        let listed = list_instances_with(&facade, &locks).await.unwrap();
        let entry = listed.iter().find(|i| i.id == "删不掉").unwrap();
        let incomplete = entry.incomplete.as_ref().expect("应带未完成标记");
        assert_eq!(incomplete.kind, "modpack");
        assert_eq!(incomplete.outcome, "cancelled");

        drop(held);
        let deleted = delete_instance_with(&facade, &locks, "删不掉", RemoveDir)
            .await
            .unwrap();
        assert!(deleted.existed);
        assert!(!instance.exists());
    }

    /// 测试里不往用户回收站塞东西：直接删掉。
    struct RemoveDir;

    impl aurora_core::Disposer for RemoveDir {
        fn dispose(&self, dir: &Path) -> Result<(), aurora_core::InstanceError> {
            std::fs::remove_dir_all(dir).map_err(|source| aurora_core::InstanceError::Io {
                path: dir.to_path_buf(),
                source,
            })
        }
    }

    /// 发出响应头与 64 KiB 后保持连接不再发送，模拟慢到卡住的下载源。
    fn stalling_server() -> String {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        std::thread::spawn(move || {
            for stream in listener.incoming().flatten() {
                std::thread::spawn(move || stall(stream));
            }
        });
        format!("http://{addr}")
    }

    fn stall(mut stream: TcpStream) {
        let mut head = Vec::new();
        let mut byte = [0u8; 1];
        while !head.ends_with(b"\r\n\r\n") {
            if stream.read(&mut byte).map_or(true, |n| n == 0) {
                return;
            }
            head.push(byte[0]);
        }
        let _ = stream
            .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 1048576\r\nConnection: close\r\n\r\n");
        let _ = stream.write_all(&[b'x'; 64 * 1024]);
        let _ = stream.flush();
        std::thread::sleep(Duration::from_secs(60));
    }

    /// 平台整合包下载卡住时取消：期限内以 cancelled 返回，事件都带本任务 id，任务注销，
    /// 游戏目录里没有建出实例。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn cancelling_a_stalled_platform_download_returns_within_deadline() {
        let server = MockServer::start().await;
        let slow = stalling_server();
        Mock::given(method("GET"))
            .and(path("/version/pv1"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "id": "pv1", "project_id": "proj", "name": "1.0", "version_number": "1.0",
                "version_type": "release", "date_published": "2026-01-01T00:00:00Z",
                "files": [{"hashes": {}, "url": format!("{slow}/pack.mrpack"),
                           "filename": "pack.mrpack", "primary": true, "size": 1048576}]
            })))
            .mount(&server)
            .await;
        let dir = tempfile::tempdir().unwrap();
        let facade = std::sync::Arc::new(facade_in(dir.path(), &server.uri()));
        let registry = std::sync::Arc::new(TaskRegistry::default());
        let delivered = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let log = delivered.clone();
        let forwarder =
            CoreEventForwarder::spawn(Some("mp-slow".into()), move |p| log.lock().unwrap().push(p));
        let sink = forwarder.sink().clone();
        let (f, r) = (facade.clone(), registry.clone());
        let install = tokio::spawn(async move {
            let source = ModpackSourceArg::Platform {
                platform: "modrinth".into(),
                project_id: "proj".into(),
                version_id: "pv1".into(),
            };
            install_modpack_with(
                &f,
                &r,
                &InstanceLocks::default(),
                "mp-slow",
                source,
                None,
                None,
                &sink,
            )
            .await
        });

        let deadline = Instant::now() + Duration::from_secs(10);
        while !delivered
            .lock()
            .unwrap()
            .iter()
            .any(|p| matches!(&p.event, crate::events::CoreEventKind::Download { bytes, .. } if *bytes > 0))
        {
            assert!(Instant::now() < deadline, "整合包下载没有开始");
            tokio::time::sleep(Duration::from_millis(10)).await;
        }

        let cancelled_at = Instant::now();
        assert!(registry.cancel("mp-slow"));
        let err = install.await.unwrap().unwrap_err();
        let elapsed = cancelled_at.elapsed();
        forwarder.finish().await;

        assert_eq!(err.code, code::CANCELLED);
        assert!(elapsed < CANCEL_DEADLINE, "取消到返回耗时 {elapsed:?}");
        assert!(!registry.is_running("mp-slow"));
        assert!(!dir.path().join(".minecraft").join("versions").exists());
        assert!(delivered
            .lock()
            .unwrap()
            .iter()
            .all(|p| p.task_id.as_deref() == Some("mp-slow")));
    }

    /// 预览 DTO 的 Mod 清单、其他可选文件与受限清单都按 snake_case 出线；可选 Mod 标 optional，覆盖层的 jar
    /// 标 override / bundled，Modrinth 文件没有工程与文件 id。
    #[tokio::test]
    async fn preview_lists_mods_and_optional_extras_on_the_wire() {
        let dir = tempfile::tempdir().unwrap();
        let facade = facade_in(dir.path(), "http://127.0.0.1:9");
        let pack = dir.path().join("可选.mrpack");
        let mut writer = zip::ZipWriter::new(std::fs::File::create(&pack).unwrap());
        let options = zip::write::SimpleFileOptions::default();
        writer.start_file("modrinth.index.json", options).unwrap();
        let file = |path: &str, optional: bool| {
            let mut entry = serde_json::json!({
                "path": path, "hashes": { "sha1": "a".repeat(40) },
                "downloads": [format!("https://cdn.modrinth.com/{path}")], "fileSize": 10
            });
            if optional {
                entry["env"] = serde_json::json!({"client": "optional", "server": "optional"});
            }
            entry
        };
        let index = serde_json::json!({
            "formatVersion": 1, "game": "minecraft", "versionId": "1.0.0", "name": "可选",
            "dependencies": {"minecraft": "1.21.1"},
            "files": [
                file("mods/optional-helper.jar", true),
                file("mods/sodium.jar", false),
                file("resourcepacks/optional-pack.zip", true),
            ]
        });
        writer.write_all(index.to_string().as_bytes()).unwrap();
        writer
            .start_file("overrides/mods/extra.jar", options)
            .unwrap();
        writer.write_all(b"x").unwrap();
        writer.finish().unwrap();

        let dto = preview_modpack_with(&facade, &pack.display().to_string())
            .await
            .unwrap();
        let wire = serde_json::to_value(&dto).unwrap();
        assert_eq!(wire["mod_files"], serde_json::json!(3));
        assert_eq!(
            wire["mods"],
            serde_json::json!([
                {"path": "mods/extra.jar", "file_name": "extra.jar", "origin": "override",
                 "optional": false, "project_id": null, "file_id": null, "availability": "bundled"},
                {"path": "mods/optional-helper.jar", "file_name": "optional-helper.jar",
                 "origin": "remote", "optional": true, "project_id": null, "file_id": null,
                 "availability": "download"},
                {"path": "mods/sodium.jar", "file_name": "sodium.jar", "origin": "remote",
                 "optional": false, "project_id": null, "file_id": null, "availability": "download"},
            ])
        );
        assert_eq!(
            wire["optional_extras"],
            serde_json::json!([
                {"path": "resourcepacks/optional-pack.zip", "file_name": "optional-pack.zip",
                 "origin": "remote", "optional": true, "project_id": null, "file_id": null,
                 "availability": "download"},
            ])
        );
        assert_eq!(wire["blocked_files"], serde_json::json!([]));
    }

    /// excludedOptional 里有空路径时在登记任务前拒绝；不是包里可选文件的路径由准备一步判成 invalid_argument，
    /// detail.path 指出是哪一个，任务随之注销、不建实例。缺省（旧任务日志重试）与空数组等价。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn excluded_optional_paths_are_validated() {
        let dir = tempfile::tempdir().unwrap();
        let facade = facade_in(dir.path(), "http://127.0.0.1:9");
        let registry = TaskRegistry::default();
        let (sink, _rx) = tokio::sync::mpsc::unbounded_channel::<CoreEvent>();
        let pack = dir.path().join("pack.mrpack");
        write_vanilla_pack(&pack);
        let source = || file(&pack.display().to_string());

        for blank in ["", "  "] {
            let err = install_modpack_with(
                &facade,
                &registry,
                &InstanceLocks::default(),
                "mp-blank",
                source(),
                None,
                Some(vec!["mods/a.jar".into(), blank.into()]),
                &sink,
            )
            .await
            .unwrap_err();
            assert_eq!(err.code, code::INVALID_ARGUMENT);
            assert_eq!(err.message, "excludedOptional 里有空路径");
            assert!(!registry.is_running("mp-blank"));
        }

        let err = install_modpack_with(
            &facade,
            &registry,
            &InstanceLocks::default(),
            "mp-required",
            source(),
            Some("必需"),
            Some(vec![" mods/core.jar ".into()]),
            &sink,
        )
        .await
        .unwrap_err();
        assert_eq!(err.code, code::INVALID_ARGUMENT);
        assert_eq!(
            err.detail.unwrap()["path"],
            serde_json::json!("mods/core.jar")
        );
        assert!(!registry.is_running("mp-required"));
        assert!(!dir
            .path()
            .join(".minecraft")
            .join("versions")
            .join("必需")
            .exists());

        assert_eq!(parse_selection(None).unwrap(), ImportSelection::default());
        assert_eq!(
            parse_selection(Some(Vec::new())).unwrap(),
            ImportSelection::default()
        );
    }

    /// `sha1` 是夹具内容的 SHA-1（本 crate 不依赖哈希库，按内容预先算好）。
    fn blocked_dto(file_id: u32, name: &str, sha1: &str, size: u64) -> BlockedFileDto {
        BlockedFileDto {
            project_id: 900_000 + file_id,
            file_id,
            file_name: name.to_owned(),
            web_url: format!("https://www.curseforge.com/minecraft/mc-mods/x/files/{file_id}"),
            destination: format!("mods/{name}"),
            sha1: Some(sha1.to_owned()),
            fingerprint: 0,
            size: Some(size),
        }
    }

    /// 认领命令先校验参数（文件夹为空、清单为空、文件名带路径成分、文件 id 重复都是 invalid_argument）；
    /// 文件夹不存在报 io 带 detail.path；找到的给出来源路径，没找到的按入参顺序列在 missing。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn claim_blocked_files_validates_and_reports_by_file_id() {
        let dir = tempfile::tempdir().unwrap();
        let facade = facade_in(dir.path(), "http://127.0.0.1:9");
        let downloads = dir.path().join("Downloads");
        std::fs::create_dir_all(&downloads).unwrap();
        std::fs::write(downloads.join("blocked-a.jar"), b"jar-a").unwrap();
        let a = blocked_dto(
            5_000_001,
            "blocked-a.jar",
            "ca16bb89ffa31a9c71fb59414f585c31f79383c2",
            5,
        );
        let b = blocked_dto(
            5_000_002,
            "blocked-b.jar",
            "7562836de93744b9abe78a5f343b67a70c15a3ba",
            5,
        );
        let folder = downloads.display().to_string();

        for (label, folder, files) in [
            ("空文件夹", " ".to_owned(), vec![a.clone()]),
            ("空清单", folder.clone(), Vec::new()),
            (
                "文件名带路径",
                folder.clone(),
                vec![BlockedFileDto {
                    file_name: "../evil.jar".into(),
                    ..a.clone()
                }],
            ),
            ("文件 id 重复", folder.clone(), vec![a.clone(), a.clone()]),
        ] {
            let err = claim_blocked_files_with(&facade, &folder, files)
                .await
                .unwrap_err();
            assert_eq!(err.code, code::INVALID_ARGUMENT, "{label}");
        }

        let gone = dir.path().join("不存在");
        let err = claim_blocked_files_with(&facade, &gone.display().to_string(), vec![a.clone()])
            .await
            .unwrap_err();
        assert_eq!(err.code, code::IO);
        assert_eq!(err.message, "选的文件夹不存在");
        assert_eq!(
            err.detail.unwrap()["path"],
            serde_json::json!(gone.display().to_string())
        );

        let report = claim_blocked_files_with(&facade, &folder, vec![b.clone(), a.clone()])
            .await
            .unwrap();
        let wire = serde_json::to_value(&report).unwrap();
        assert_eq!(
            wire,
            serde_json::json!({
                "claimed": [{
                    "file_id": 5_000_001,
                    "source_path": downloads.join("blocked-a.jar").display().to_string()
                }],
                "missing": [5_000_002]
            })
        );
        assert_eq!(
            std::fs::read(
                dir.path()
                    .join("cache")
                    .join("modpacks")
                    .join("claims")
                    .join("curseforge-5000001")
                    .join("blocked-a.jar")
            )
            .unwrap(),
            b"jar-a"
        );
    }

    /// 前端交回的清单按 snake_case 字段解析，与 distribution_blocked 的 detail.files 同一形状。
    #[test]
    fn blocked_file_dto_round_trips_its_wire_shape() {
        let wire = serde_json::json!({
            "project_id": 900_001, "file_id": 5_000_001, "file_name": "blocked-a.jar",
            "web_url": "https://www.curseforge.com/minecraft/mc-mods/blocked-a/files/5000001",
            "destination": "mods/blocked-a.jar", "sha1": null, "fingerprint": 0, "size": 1024
        });
        let dto: BlockedFileDto = serde_json::from_value(wire.clone()).unwrap();
        assert_eq!(dto.file_id, 5_000_001);
        assert_eq!(dto.size, Some(1024));
        assert_eq!(serde_json::to_value(&dto).unwrap(), wire);
        let core = BlockedFile::from(dto.clone());
        assert_eq!(BlockedFileDto::from(&core), dto);
    }

    /// 系统下载文件夹取不到时报 io，带固定文案与原因。
    #[test]
    fn downloads_folder_failure_is_an_io_error() {
        assert_eq!(
            downloads_folder_from(Ok(PathBuf::from("C:/Users/Player/Downloads"))).unwrap(),
            PathBuf::from("C:/Users/Player/Downloads")
                .display()
                .to_string()
        );
        let err = downloads_folder_from(Err(tauri::Error::UnknownPath)).unwrap_err();
        assert_eq!(err.code, code::IO);
        assert_eq!(err.message, "找不到系统的下载文件夹");
        assert_eq!(
            err.detail,
            Some(serde_json::json!({ "causes": ["unknown path"] }))
        );
    }
}
