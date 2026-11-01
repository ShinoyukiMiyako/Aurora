//! 整合包：预览本地整合包文件、不下载整包读平台整合包的清单摘要，把平台或本地整合包导入为新实例；
//! 认领用户手动下载的受限文件；把实例导出为 Modrinth `.mrpack`。

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use aurora_core::{
    is_safe_file_name, Aurora, BlockedFile, BundleReason, ClaimReport, EventSink, ExportBundledMod,
    ExportExtra, ExportMatch, GameSlot, ImportSelection, InstanceModpack, MarkerError,
    MarkerSettlement, ModpackExportOptions, ModpackExportOutcome, ModpackExportPreview,
    ModpackExportTarget, ModpackInstallOutcome, ModpackPreview, ModpackSource, ModpackSummary,
    PackFileAvailability, PackFileOrigin, PackFormat, PackLoader, PackModEntry,
};
use serde::{Deserialize, Serialize};
use serde_json::json;
use tauri::{AppHandle, Manager, State};

use crate::commands::discover::parse_platform;
use crate::commands::error::code;
use crate::commands::instances::{
    ensure_saves_settled_for_reading, ChainGuard, ExportedFiles, InstanceActivity, InstanceLocks,
};
use crate::commands::launch::RunningGame;
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
/// 不下载整包；服务器不支持范围读取、包不是可读的 zip 或缺清单时报 `remote_pack_unreadable`，
/// 清单用了解不开的压缩方式时报 `modpack_unsupported_compression`。
/// CurseForge 另问批量文件与批量工程两个接口，没配 API key 时报 CurseForge 源被禁用的同一个错误。
/// 整合包文件本身不允许启动器直接下载时，认领过就读暂存副本，没认领过报 `distribution_blocked`，
/// detail.files 里只有这个包。
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
/// 整合包要求的原版同时以 inherited 占住，启动、删除、改名、补全它报 `instance_busy`（detail.used_by 为实例名）；
/// 原版自己开着游戏时导入报 `instance_busy`（detail.id 为原版），这时写不动它的 natives。
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
    let reserved: Mutex<Option<(String, ChainGuard)>> = Mutex::new(None);
    let result = task
        .run(async {
            let prepared = aurora
                .prepare_modpack(&source, name, &selection, Some(events))
                .await?;
            // 导入把原版装进它的自然版本目录，导入出的实例又继承它；实例 JSON 要到原版装完才写出来，
            // 删除与改名动手时的依赖检查扫不到，所以这里按将要继承的 id 一并占住。
            let base = [prepared.base_version().to_owned()];
            let guard = match locks.acquire_with_bases(
                prepared.name(),
                InstanceActivity::Installing,
                &base,
            ) {
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

// ---------------------------------------------------------------- 导出整合包

/// 整合包名称的最大字符数：Modrinth 上整合包名的常见长度上限，界面输入框同一限制。
const EXPORT_NAME_MAX_CHARS: usize = 64;
/// 整合包版本号的最大字符数。
const EXPORT_VERSION_MAX_CHARS: usize = 32;
/// 简介的最大字符数。
const EXPORT_SUMMARY_MAX_CHARS: usize = 256;

/// 导出预览 DTO。
#[derive(Debug, Serialize)]
pub struct ModpackExportPreviewDto {
    pub name: String,
    pub version: String,
    pub minecraft: String,
    pub loader: Option<PackLoader>,
    pub indexed: Vec<ExportIndexedModDto>,
    pub bundled: Vec<ExportBundledModDto>,
    pub disabled: Vec<ExportBundledModDto>,
    pub extras: Vec<ExportExtraStatDto>,
    pub mod_skipped: Vec<String>,
    pub disabled_skipped: Vec<String>,
}

/// 只写进索引的 Mod。
#[derive(Debug, Serialize)]
pub struct ExportIndexedModDto {
    pub file_name: String,
    pub path: String,
    pub size: u64,
    pub project_id: String,
    pub version_id: String,
    pub title: Option<String>,
    pub matched_by: ExportMatch,
}

/// 文件要打包进去的 Mod。
#[derive(Debug, Serialize)]
pub struct ExportBundledModDto {
    pub file_name: String,
    pub path: String,
    pub size: u64,
    pub reason: BundleReason,
}

/// 一个额外项的文件数与字节数。
#[derive(Debug, Serialize)]
pub struct ExportExtraStatDto {
    pub extra: ExportExtra,
    pub files: u64,
    pub bytes: u64,
    pub default_selected: bool,
    pub skipped: Vec<String>,
}

/// 导出结果 DTO。
#[derive(Debug, Serialize)]
pub struct ModpackExportOutcomeDto {
    pub path: String,
    pub name: String,
    pub version: String,
    pub bytes: u64,
    pub indexed_files: usize,
    pub override_files: usize,
    pub bundled_mods: Vec<String>,
    pub disabled_mods: usize,
    pub skipped: Vec<String>,
}

/// 前端传来的导出选项。嵌套对象的键与 DTO 一样用 snake_case；写错的键直接失败，不被悄悄忽略。
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ModpackExportOptionsArg {
    /// 保存对话框给出的绝对路径，扩展名必须是 .mrpack。
    pub destination: String,
    pub name: String,
    pub version: String,
    #[serde(default)]
    pub summary: Option<String>,
    /// 额外项的 serde 名。
    pub extras: Vec<String>,
    pub include_disabled: bool,
}

/// 导出前的预览：能不能导出、默认名称与版本、哪些 Mod 走索引、哪些要打包、各额外项的大小。
/// 只读，不占实例锁、不登记任务；要联网问 Modrinth。
#[tauri::command]
pub async fn preview_modpack_export(
    id: String,
    facade: State<'_, Facade>,
) -> Result<ModpackExportPreviewDto, CommandError> {
    preview_modpack_export_with(&facade, &id).await
}

pub(crate) async fn preview_modpack_export_with(
    facade: &Facade,
    id: &str,
) -> Result<ModpackExportPreviewDto, CommandError> {
    let id = export_id(id)?;
    let aurora = facade.snapshot().await;
    Ok(export_preview_dto(aurora.preview_modpack_export(id).await?))
}

/// 长任务：把实例导出为 `.mrpack`。进度经 core-event 推送并带 `task_id`，可用 cancel_task 取消；
/// 失败或取消时不留临时文件，已有的同名目标文件不动。
///
/// 导出期间实例以「改动中」占住：游戏照常运行、Mod 照常可改（读的是此刻的文件），改名、补全、
/// 删除报 `instance_busy`。勾了存档时存档要先安定下来：游戏启动中、运行中，备份或恢复进行中，共用
/// 这份存档的别的实例开着游戏时都报 `instance_busy`，导出期间也不能启动这个实例。
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn export_modpack(
    app: AppHandle,
    task_id: String,
    id: String,
    options: ModpackExportOptionsArg,
    facade: State<'_, Facade>,
    tasks: State<'_, TaskRegistry>,
    locks: State<'_, InstanceLocks>,
    running: State<'_, RunningGame>,
    exports: State<'_, ExportedFiles>,
) -> Result<ModpackExportOutcomeDto, CommandError> {
    let events = CoreEventForwarder::to_app(&app, Some(task_id.clone()));
    let outcome = export_modpack_with(
        &facade,
        &tasks,
        &locks,
        running.slot(),
        &task_id,
        &id,
        options,
        events.sink(),
    )
    .await;
    events.finish().await;
    // 完成通知上的「打开所在文件夹」要定位它
    if let Ok(done) = &outcome {
        exports.record(Path::new(&done.path));
    }
    outcome
}

#[allow(clippy::too_many_arguments)]
pub(crate) async fn export_modpack_with(
    facade: &Facade,
    tasks: &TaskRegistry,
    locks: &InstanceLocks,
    game: &GameSlot,
    task_id: &str,
    id: &str,
    options: ModpackExportOptionsArg,
    events: &EventSink,
) -> Result<ModpackExportOutcomeDto, CommandError> {
    // 参数在占锁、登记任务之前全部校验：非法调用不该占用任务 id。
    let id = export_id(id)?;
    let (destination, options) = parse_export_options(options).await?;
    let _guard = locks.acquire(id, InstanceActivity::Modifying)?;
    let includes_saves = options.extras.contains(&ExportExtra::Saves);
    // 勾了存档时记下「存档正被整份读走」，恢复存档与启动游戏要等它读完；先记下再查，与那两边先占后查对称，
    // 两边同时发起时至少有一方会被挡住。被拒时记录随返回撤销。
    let _reading = includes_saves.then(|| locks.read_saves(id));
    let snapshot = facade.snapshot().await;
    // 没勾存档的导出不碰 saves，与运行和备份都兼容。勾了就要等存档安定下来，否则包里是半截的。
    if includes_saves {
        ensure_saves_settled_for_reading(&snapshot, locks, game, id).await?;
    }
    let task = tasks.register(task_id)?;
    let aurora = snapshot.with_cancel(task.token().clone());
    // 落点放在任务的 future 之外：取消宽限期满时 run 会丢弃 future，临时文件仍要在这里清掉。
    let target = ModpackExportTarget::new(destination);
    let result = task
        .run(async {
            Ok(aurora
                .export_modpack(id, &options, &target, Some(events))
                .await?)
        })
        .await;
    match result {
        Ok(outcome) => Ok(export_outcome_dto(outcome)),
        Err(err) => {
            target.discard().await;
            Err(err)
        }
    }
}

fn invalid_export_field(field: &str, rule: &str, message: impl Into<String>) -> CommandError {
    CommandError::invalid_argument(message).with_detail(json!({ "field": field, "rule": rule }))
}

fn export_id(id: &str) -> Result<&str, CommandError> {
    if id.trim().is_empty() {
        return Err(invalid_export_field("id", "empty", "实例 id 不能为空"));
    }
    Ok(id)
}

/// 名称与版本号：去掉首尾空白后非空、不超长、不含控制字符。
fn export_text(field: &str, label: &str, raw: &str, max: usize) -> Result<String, CommandError> {
    let value = raw.trim();
    if value.is_empty() {
        return Err(invalid_export_field(
            field,
            "empty",
            format!("{label}不能为空"),
        ));
    }
    if value.chars().count() > max {
        return Err(invalid_export_field(
            field,
            "too_long",
            format!("{label}最多 {max} 个字符"),
        ));
    }
    if value.chars().any(char::is_control) {
        return Err(invalid_export_field(
            field,
            "control_char",
            format!("{label}不能含控制字符"),
        ));
    }
    Ok(value.to_owned())
}

async fn parse_export_options(
    options: ModpackExportOptionsArg,
) -> Result<(PathBuf, ModpackExportOptions), CommandError> {
    let name = export_text("name", "名称", &options.name, EXPORT_NAME_MAX_CHARS)?;
    let version = export_text(
        "version",
        "版本号",
        &options.version,
        EXPORT_VERSION_MAX_CHARS,
    )?;
    let summary = match options.summary.as_deref().map(str::trim) {
        Some(summary) if summary.chars().count() > EXPORT_SUMMARY_MAX_CHARS => {
            return Err(invalid_export_field(
                "summary",
                "too_long",
                format!("简介最多 {EXPORT_SUMMARY_MAX_CHARS} 个字符"),
            ));
        }
        Some("") | None => None,
        Some(summary) => Some(summary.to_owned()),
    };
    let mut extras: Vec<ExportExtra> = Vec::with_capacity(options.extras.len());
    for raw in &options.extras {
        let Some(extra) = ExportExtra::parse(raw) else {
            return Err(
                CommandError::invalid_argument(format!("不认识的打包项 {raw}"))
                    .with_detail(json!({ "field": "extras", "rule": "unknown", "value": raw })),
            );
        };
        if !extras.contains(&extra) {
            extras.push(extra);
        }
    }
    let destination = export_destination(&options.destination).await?;
    Ok((
        destination,
        ModpackExportOptions {
            name,
            version,
            summary,
            extras,
            include_disabled: options.include_disabled,
        },
    ))
}

/// 目标路径来自系统保存对话框，这里仍按不可信输入校验：绝对路径、扩展名 .mrpack、父目录存在、
/// 自身不是已有的目录。
async fn export_destination(raw: &str) -> Result<PathBuf, CommandError> {
    let path = PathBuf::from(raw);
    if !path.is_absolute() {
        return Err(invalid_export_field(
            "destination",
            "relative",
            "导出位置必须是完整路径",
        ));
    }
    let is_mrpack = path
        .extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| e.eq_ignore_ascii_case("mrpack"));
    if !is_mrpack {
        return Err(invalid_export_field(
            "destination",
            "extension",
            "导出的文件扩展名必须是 .mrpack",
        ));
    }
    let parent_is_dir = match path.parent() {
        Some(parent) => tokio::fs::metadata(parent)
            .await
            .is_ok_and(|meta| meta.is_dir()),
        None => false,
    };
    if !parent_is_dir {
        return Err(invalid_export_field(
            "destination",
            "parent_missing",
            "导出位置所在的文件夹不存在",
        ));
    }
    if tokio::fs::metadata(&path)
        .await
        .is_ok_and(|meta| meta.is_dir())
    {
        return Err(invalid_export_field(
            "destination",
            "is_directory",
            "导出位置是一个已有的文件夹",
        ));
    }
    Ok(path)
}

fn export_preview_dto(preview: ModpackExportPreview) -> ModpackExportPreviewDto {
    let bundled = |m: ExportBundledMod| ExportBundledModDto {
        file_name: m.file_name,
        path: m.path,
        size: m.size,
        reason: m.reason,
    };
    ModpackExportPreviewDto {
        name: preview.name,
        version: preview.version,
        minecraft: preview.minecraft,
        loader: preview.loader,
        indexed: preview
            .indexed
            .into_iter()
            .map(|m| ExportIndexedModDto {
                file_name: m.file_name,
                path: m.path,
                size: m.size,
                project_id: m.project_id,
                version_id: m.version_id,
                title: m.title,
                matched_by: m.matched_by,
            })
            .collect(),
        bundled: preview.bundled.into_iter().map(bundled).collect(),
        disabled: preview.disabled.into_iter().map(bundled).collect(),
        extras: preview
            .extras
            .into_iter()
            .map(|s| ExportExtraStatDto {
                extra: s.extra,
                files: s.files,
                bytes: s.bytes,
                default_selected: s.default_selected,
                skipped: s.skipped,
            })
            .collect(),
        mod_skipped: preview.mod_skipped,
        disabled_skipped: preview.disabled_skipped,
    }
}

fn export_outcome_dto(outcome: ModpackExportOutcome) -> ModpackExportOutcomeDto {
    ModpackExportOutcomeDto {
        path: outcome.path.display().to_string(),
        name: outcome.name,
        version: outcome.version,
        bytes: outcome.bytes,
        indexed_files: outcome.indexed_files,
        override_files: outcome.override_files,
        bundled_mods: outcome.bundled_mods,
        disabled_mods: outcome.disabled_mods,
        skipped: outcome.skipped,
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

    /// 整合包要的原版自己开着游戏时，导入在建目录前以 instance_busy 拒绝，detail 说的是原版在运行：游戏映射着
    /// natives，放它过去的话写到 natives 才报 IO 错误，还要清理半成品。
    #[tokio::test]
    async fn import_onto_a_base_running_its_own_game_is_refused_before_creating_anything() {
        let dir = tempfile::tempdir().unwrap();
        let facade = facade_in(dir.path(), "http://127.0.0.1:9");
        let registry = TaskRegistry::default();
        let locks = InstanceLocks::default();
        let (sink, _rx) = tokio::sync::mpsc::unbounded_channel::<CoreEvent>();
        let pack = dir.path().join("pack.mrpack");
        write_vanilla_pack(&pack);
        let _game = locks.acquire("test", InstanceActivity::Running).unwrap();

        let err = install_modpack_with(
            &facade,
            &registry,
            &locks,
            "mp-base-running",
            file(&pack.display().to_string()),
            Some("周末联机"),
            None,
            &sink,
        )
        .await
        .unwrap_err();

        assert_eq!(err.code, code::INSTANCE_BUSY);
        assert_eq!(
            err.detail.unwrap(),
            serde_json::json!({ "id": "test", "activity": "running" })
        );
        assert!(!dir
            .path()
            .join(".minecraft")
            .join("versions")
            .join("周末联机")
            .exists());
        assert_eq!(locks.activity("周末联机"), None, "实例名的占用随之放开");
        assert_eq!(locks.activity("test"), Some(InstanceActivity::Running));
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

    /// 导入一个 Fabric 1.20.1 整合包：实例 JSON 还没写出来（原版还在下载）时，盘上已有的原版 1.20.1
    /// 就以「被使用」占着，删除、改名、补全它都以 instance_busy 拒绝，detail 指出正在用它的实例。
    /// 导入结束（这里是取消）后放开。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn importing_a_fabric_pack_holds_its_base_version_until_the_import_ends() {
        use crate::commands::instances::{
            delete_instance_with, list_instances_with, rename_instance_with, repair_instance_with,
        };

        let server = MockServer::start().await;
        let base = server.uri();
        Mock::given(method("GET"))
            .and(path("/manifest.json"))
            .respond_with(ResponseTemplate::new(200).set_body_string(format!(
                r#"{{"latest":{{"release":"1.20.1","snapshot":"1.20.1"}},
                    "versions":[{{"id":"1.20.1","type":"release","url":"{base}/1.20.1.json",
                    "time":"t","releaseTime":"t"}}]}}"#
            )))
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path("/1.20.1.json"))
            .respond_with(
                ResponseTemplate::new(200)
                    .set_body_string(r#"{"id":"1.20.1","type":"release","mainClass":"M"}"#)
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
        // 用户手里已有的原版实例：导入会把原版装进这个自然版本目录，导入出的实例也继承它。
        let vanilla = dir
            .path()
            .join(".minecraft")
            .join("versions")
            .join("1.20.1");
        std::fs::create_dir_all(&vanilla).unwrap();
        std::fs::write(
            vanilla.join("1.20.1.json"),
            r#"{"id":"1.20.1","type":"release","mainClass":"M"}"#,
        )
        .unwrap();
        let registry = std::sync::Arc::new(TaskRegistry::default());
        let locks = InstanceLocks::default();
        let pack = dir.path().join("fabric.mrpack");
        let mut writer = zip::ZipWriter::new(std::fs::File::create(&pack).unwrap());
        writer
            .start_file(
                "modrinth.index.json",
                zip::write::SimpleFileOptions::default(),
            )
            .unwrap();
        let index = serde_json::json!({
            "formatVersion": 1, "game": "minecraft", "versionId": "1.0.0", "name": "Fabric 包",
            "files": [], "dependencies": {"minecraft": "1.20.1", "fabric-loader": "0.15.0"}
        });
        writer.write_all(index.to_string().as_bytes()).unwrap();
        writer.finish().unwrap();
        let install = tokio::spawn({
            let (f, r, l) = (facade.clone(), registry.clone(), locks.clone());
            let source = file(&pack.display().to_string());
            async move {
                let (sink, _rx) = tokio::sync::mpsc::unbounded_channel::<CoreEvent>();
                install_modpack_with(&f, &r, &l, "mp-base", source, Some("导入中"), None, &sink)
                    .await
            }
        });
        let marker = aurora_core::MarkerStore::for_version_dir(
            &dir.path()
                .join(".minecraft")
                .join("versions")
                .join("导入中"),
        )
        .path()
        .to_path_buf();
        let deadline = Instant::now() + Duration::from_secs(10);
        while !marker.is_file() {
            assert!(Instant::now() < deadline, "导入没有建出实例目录");
            tokio::time::sleep(Duration::from_millis(10)).await;
        }

        let in_use =
            serde_json::json!({ "id": "1.20.1", "activity": "inherited", "used_by": "导入中" });
        assert_eq!(locks.activity("1.20.1"), Some(InstanceActivity::Inherited));
        let listed = list_instances_with(&facade, &locks).await.unwrap();
        let entry = listed.iter().find(|i| i.id == "1.20.1").unwrap();
        assert_eq!(entry.activity, Some(InstanceActivity::Inherited));
        assert_eq!(entry.used_by.as_deref(), Some("导入中"));
        let err = delete_instance_with(&facade, &locks, "1.20.1", NeverDispose)
            .await
            .unwrap_err();
        assert_eq!(err.code, code::INSTANCE_BUSY);
        assert_eq!(err.detail.unwrap(), in_use);
        let err = rename_instance_with(&facade, &locks, "1.20.1", "原版")
            .await
            .unwrap_err();
        assert_eq!(err.code, code::INSTANCE_BUSY);
        assert_eq!(err.detail.unwrap(), in_use);
        let (sink, _rx) = tokio::sync::mpsc::unbounded_channel::<CoreEvent>();
        let err = repair_instance_with(&facade, &registry, &locks, "r-base", "1.20.1", &sink)
            .await
            .unwrap_err();
        assert_eq!(err.code, code::INSTANCE_BUSY);
        assert_eq!(err.detail.unwrap(), in_use);
        assert!(!registry.is_running("r-base"));
        assert!(vanilla.join("1.20.1.json").is_file());

        assert!(registry.cancel("mp-base"));
        let err = install.await.unwrap().unwrap_err();
        assert_eq!(err.code, code::CANCELLED);
        assert_eq!(locks.activity("1.20.1"), None, "导入结束后基底放开");
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

    /// 平台整合包下载卡住时取消：立即以 cancelled 返回，事件都带本任务 id，任务注销，
    /// 游戏目录里没有建出实例。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn cancelling_a_stalled_platform_download_returns_at_once() {
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

        assert!(registry.cancel("mp-slow"));
        let err = install.await.unwrap().unwrap_err();
        forwarder.finish().await;

        assert_eq!(err.code, code::CANCELLED);
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

    // ---------------------------------------------------------------- 导出整合包

    const EXPORT_ID: &str = "导出用";

    /// 一个隔离的 Fabric 实例，mods 里一个没有卷宗的 jar（要按哈希问 Modrinth），config 里一个文件。
    fn export_instance(root: &Path) -> PathBuf {
        let dir = root.join(".minecraft").join("versions").join(EXPORT_ID);
        std::fs::create_dir_all(dir.join("mods")).unwrap();
        std::fs::create_dir_all(dir.join("config")).unwrap();
        std::fs::write(
            dir.join(format!("{EXPORT_ID}.json")),
            format!(
                r#"{{"id":"{EXPORT_ID}","inheritsFrom":"1.21.1","type":"release",
                    "mainClass":"net.fabricmc.loader.impl.launch.knot.KnotClient",
                    "libraries":[{{"name":"net.fabricmc:fabric-loader:0.16.9"}}]}}"#
            ),
        )
        .unwrap();
        std::fs::write(dir.join("mods").join("local.jar"), b"local jar bytes").unwrap();
        std::fs::write(dir.join("config").join("a.toml"), b"a = 1").unwrap();
        dir
    }

    fn export_args(destination: &Path) -> ModpackExportOptionsArg {
        ModpackExportOptionsArg {
            destination: destination.display().to_string(),
            name: " 樱花林 ".into(),
            version: "1.0.0".into(),
            summary: Some("  ".into()),
            extras: vec!["config".into(), "config".into()],
            include_disabled: false,
        }
    }

    fn part_files(dir: &Path) -> Vec<String> {
        std::fs::read_dir(dir)
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .filter(|n| n.ends_with(".part.mrpack"))
            .collect()
    }

    #[test]
    fn export_options_keep_nested_snake_case_keys_and_refuse_unknown_ones() {
        let parsed: ModpackExportOptionsArg = serde_json::from_value(serde_json::json!({
            "destination": "D:/a.mrpack", "name": "n", "version": "1",
            "extras": ["saves"], "include_disabled": true
        }))
        .unwrap();
        assert_eq!(parsed.summary, None);
        assert!(parsed.include_disabled);
        for bad in [
            serde_json::json!({"destination": "D:/a.mrpack", "name": "n", "version": "1",
                "extras": [], "includeDisabled": true}),
            serde_json::json!({"destination": "D:/a.mrpack", "name": "n", "version": "1",
                "extras": [], "include_disabled": true, "author": "x"}),
        ] {
            assert!(serde_json::from_value::<ModpackExportOptionsArg>(bad).is_err());
        }
    }

    /// 每条参数规则各报 invalid_argument 与对应的 field / rule；参数非法时不占实例、不占任务 id。
    #[tokio::test]
    async fn bad_export_arguments_are_rejected_before_locking_or_registering() {
        let dir = tempfile::tempdir().unwrap();
        let facade = facade_in(dir.path(), "http://127.0.0.1:9");
        export_instance(dir.path());
        let registry = TaskRegistry::default();
        let locks = InstanceLocks::default();
        let (sink, _rx) = tokio::sync::mpsc::unbounded_channel::<CoreEvent>();
        let good = dir.path().join("out.mrpack");
        std::fs::create_dir_all(dir.path().join("已有文件夹.mrpack")).unwrap();

        let with = |edit: &dyn Fn(&mut ModpackExportOptionsArg)| {
            let mut args = export_args(&good);
            edit(&mut args);
            args
        };
        let cases: Vec<(&str, ModpackExportOptionsArg, &str, &str)> = vec![
            (
                EXPORT_ID,
                with(&|a| a.name = " \t ".into()),
                "name",
                "empty",
            ),
            (
                EXPORT_ID,
                with(&|a| a.name = "樱".repeat(65)),
                "name",
                "too_long",
            ),
            (
                EXPORT_ID,
                with(&|a| a.name = "a\u{7}b".into()),
                "name",
                "control_char",
            ),
            (
                EXPORT_ID,
                with(&|a| a.version = "".into()),
                "version",
                "empty",
            ),
            (
                EXPORT_ID,
                with(&|a| a.version = "1".repeat(33)),
                "version",
                "too_long",
            ),
            (
                EXPORT_ID,
                with(&|a| a.version = "1.0\u{8}1".into()),
                "version",
                "control_char",
            ),
            (
                EXPORT_ID,
                with(&|a| a.summary = Some("字".repeat(257))),
                "summary",
                "too_long",
            ),
            (
                EXPORT_ID,
                with(&|a| a.extras = vec!["mods".into()]),
                "extras",
                "unknown",
            ),
            (
                EXPORT_ID,
                with(&|a| a.destination = "out.mrpack".into()),
                "destination",
                "relative",
            ),
            (
                EXPORT_ID,
                with(&|a| a.destination = dir.path().join("out.zip").display().to_string()),
                "destination",
                "extension",
            ),
            (
                EXPORT_ID,
                with(&|a| {
                    a.destination = dir
                        .path()
                        .join("没有这个文件夹")
                        .join("out.mrpack")
                        .display()
                        .to_string()
                }),
                "destination",
                "parent_missing",
            ),
            (
                EXPORT_ID,
                with(&|a| {
                    a.destination = dir.path().join("已有文件夹.mrpack").display().to_string()
                }),
                "destination",
                "is_directory",
            ),
            ("  ", export_args(&good), "id", "empty"),
        ];
        for (id, args, field, rule) in cases {
            let err = export_modpack_with(
                &facade,
                &registry,
                &locks,
                &GameSlot::default(),
                "ex-bad",
                id,
                args,
                &sink,
            )
            .await
            .unwrap_err();
            assert_eq!(err.code, code::INVALID_ARGUMENT, "{field}/{rule}");
            let detail = err.detail.unwrap();
            assert_eq!(detail["field"], field, "{field}/{rule}");
            assert_eq!(detail["rule"], rule, "{field}/{rule}");
            assert!(!registry.is_running("ex-bad"));
            assert_eq!(locks.activity(EXPORT_ID), None);
            // 没占任务 id：同一个 id 随后照常登记得上。
            drop(registry.register("ex-bad").unwrap());
        }
        let err = export_modpack_with(
            &facade,
            &registry,
            &locks,
            &GameSlot::default(),
            "ex-bad",
            EXPORT_ID,
            with(&|a| a.extras = vec!["config".into(), "Saves".into()]),
            &sink,
        )
        .await
        .unwrap_err();
        assert_eq!(err.detail.unwrap()["value"], "Saves");
        assert!(!good.exists());
    }

    /// 导出成功：DTO 字段按 snake_case 出线，名称与版本是去掉空白后的值，空白简介不写进清单；
    /// 预览同样能读出这个实例。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn export_writes_the_pack_and_reports_its_outcome() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/version_files"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({})))
            .mount(&server)
            .await;
        let dir = tempfile::tempdir().unwrap();
        let facade = facade_in(dir.path(), &server.uri());
        let instance = export_instance(dir.path());
        std::fs::write(instance.join("mods").join("con.jar"), b"reserved").unwrap();
        std::fs::write(instance.join("mods").join("aux.jar.disabled"), b"reserved").unwrap();
        std::fs::write(instance.join("config").join("nul.json"), b"reserved").unwrap();
        let registry = TaskRegistry::default();
        let locks = InstanceLocks::default();
        let (sink, _rx) = tokio::sync::mpsc::unbounded_channel::<CoreEvent>();

        let preview = preview_modpack_export_with(&facade, EXPORT_ID)
            .await
            .unwrap();
        let wire = serde_json::to_value(&preview).unwrap();
        assert_eq!(wire["name"], EXPORT_ID);
        assert_eq!(wire["version"], "1.0.0");
        assert_eq!(wire["minecraft"], "1.21.1");
        assert_eq!(
            wire["loader"],
            serde_json::json!({"kind": "fabric", "version": "0.16.9"})
        );
        assert_eq!(wire["bundled"][0]["file_name"], "local.jar");
        assert_eq!(wire["bundled"][0]["reason"], "unlisted");
        assert_eq!(wire["extras"][0]["extra"], "config");
        assert_eq!(wire["extras"][0]["files"], 1);
        assert_eq!(wire["extras"][0]["default_selected"], true);
        assert_eq!(
            wire["extras"][0]["skipped"],
            serde_json::json!(["config/nul.json"])
        );
        assert_eq!(wire["extras"][6]["extra"], "saves");
        assert_eq!(wire["extras"][6]["skipped"], serde_json::json!([]));
        assert_eq!(wire["mod_skipped"], serde_json::json!(["mods/con.jar"]));
        assert_eq!(
            wire["disabled_skipped"],
            serde_json::json!(["mods/aux.jar.disabled"])
        );

        let destination = dir.path().join("樱花林 1.0.0.mrpack");
        let outcome = export_modpack_with(
            &facade,
            &registry,
            &locks,
            &GameSlot::default(),
            "ex-ok",
            EXPORT_ID,
            export_args(&destination),
            &sink,
        )
        .await
        .unwrap();
        let wire = serde_json::to_value(&outcome).unwrap();
        assert_eq!(wire["path"], destination.display().to_string());
        assert_eq!(wire["name"], "樱花林");
        assert_eq!(wire["indexed_files"], 0);
        assert_eq!(wire["override_files"], 2);
        assert_eq!(wire["bundled_mods"], serde_json::json!(["local.jar"]));
        assert_eq!(wire["disabled_mods"], 0);
        assert_eq!(
            wire["bytes"],
            serde_json::json!(std::fs::metadata(&destination).unwrap().len())
        );
        assert!(part_files(dir.path()).is_empty());
        assert!(!registry.is_running("ex-ok"));
        assert_eq!(locks.activity(EXPORT_ID), None);
    }

    /// 平台迟迟不回时取消：立即以 cancelled 返回，目标与临时文件都不存在，任务与实例都放开。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn cancelling_while_modrinth_is_slow_returns_at_once() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/version_files"))
            .respond_with(
                ResponseTemplate::new(200)
                    .set_body_json(serde_json::json!({}))
                    .set_delay(Duration::from_secs(30)),
            )
            .mount(&server)
            .await;
        let dir = tempfile::tempdir().unwrap();
        let facade = std::sync::Arc::new(facade_in(dir.path(), &server.uri()));
        export_instance(dir.path());
        let registry = std::sync::Arc::new(TaskRegistry::default());
        let locks = InstanceLocks::default();
        let destination = dir.path().join("慢.mrpack");
        let export = tokio::spawn({
            let (f, r, l) = (facade.clone(), registry.clone(), locks.clone());
            let args = export_args(&destination);
            async move {
                let (sink, _rx) = tokio::sync::mpsc::unbounded_channel::<CoreEvent>();
                export_modpack_with(
                    &f,
                    &r,
                    &l,
                    &GameSlot::default(),
                    "ex-slow",
                    EXPORT_ID,
                    args,
                    &sink,
                )
                .await
            }
        });

        let deadline = Instant::now() + Duration::from_secs(10);
        while server.received_requests().await.unwrap().is_empty() {
            assert!(Instant::now() < deadline, "导出没有开始问 Modrinth");
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        assert_eq!(locks.activity(EXPORT_ID), Some(InstanceActivity::Modifying));

        assert!(registry.cancel("ex-slow"));
        let err = export.await.unwrap().unwrap_err();
        assert_eq!(err.code, code::CANCELLED);
        assert!(!destination.exists());
        assert!(part_files(dir.path()).is_empty());
        assert!(!registry.is_running("ex-slow"));
        assert_eq!(locks.activity(EXPORT_ID), None);
    }

    /// 导出占的是「改动中」：改名被拦并报 modifying，装 Mod（同为改动中）照常放行。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn export_holds_the_instance_as_modifying() {
        use crate::commands::instances::rename_instance_with;

        let server = MockServer::start().await;
        // 在取消之前都等不到回音，下面几步落在导出进行中不取决于它们跑得多快。
        Mock::given(method("POST"))
            .and(path("/version_files"))
            .respond_with(
                ResponseTemplate::new(200)
                    .set_body_json(serde_json::json!({}))
                    .set_delay(Duration::from_secs(30)),
            )
            .mount(&server)
            .await;
        let dir = tempfile::tempdir().unwrap();
        let facade = std::sync::Arc::new(facade_in(dir.path(), &server.uri()));
        let instance = export_instance(dir.path());
        let registry = std::sync::Arc::new(TaskRegistry::default());
        let locks = InstanceLocks::default();
        let export = tokio::spawn({
            let (f, r, l) = (facade.clone(), registry.clone(), locks.clone());
            let args = export_args(&dir.path().join("占用.mrpack"));
            async move {
                let (sink, _rx) = tokio::sync::mpsc::unbounded_channel::<CoreEvent>();
                export_modpack_with(
                    &f,
                    &r,
                    &l,
                    &GameSlot::default(),
                    "ex-hold",
                    EXPORT_ID,
                    args,
                    &sink,
                )
                .await
            }
        });
        let deadline = Instant::now() + Duration::from_secs(10);
        while server.received_requests().await.unwrap().is_empty() {
            assert!(Instant::now() < deadline, "导出没有开始问 Modrinth");
            tokio::time::sleep(Duration::from_millis(10)).await;
        }

        let err = rename_instance_with(&facade, &locks, EXPORT_ID, "改名")
            .await
            .unwrap_err();
        assert_eq!(err.code, code::INSTANCE_BUSY);
        assert_eq!(err.detail.unwrap()["activity"], "modifying");
        assert!(instance.is_dir());
        let installing_mod = locks
            .acquire(EXPORT_ID, InstanceActivity::Modifying)
            .expect("导出期间仍能改 Mod");
        drop(installing_mod);
        let Err(repair) = locks.acquire(EXPORT_ID, InstanceActivity::Repairing) else {
            panic!("导出期间补全应被拦下");
        };
        assert_eq!(repair.code, code::INSTANCE_BUSY);

        assert!(registry.cancel("ex-hold"));
        assert_eq!(export.await.unwrap().unwrap_err().code, code::CANCELLED);
        assert_eq!(locks.activity(EXPORT_ID), None);
    }

    /// 存档备份或恢复占着实例时导出报 instance_busy（activity 为 backing_up），不登记任务、不写文件；
    /// 被拒的那一次不留下「改动中」，备份结束后照常能导出。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn export_waits_for_a_world_backup_or_restore() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/version_files"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({})))
            .mount(&server)
            .await;
        let dir = tempfile::tempdir().unwrap();
        let facade = facade_in(dir.path(), &server.uri());
        export_instance(dir.path());
        let registry = TaskRegistry::default();
        let locks = InstanceLocks::default();
        let (sink, _rx) = tokio::sync::mpsc::unbounded_channel::<CoreEvent>();
        let destination = dir.path().join("备份中.mrpack");
        let with_saves = || {
            let mut args = export_args(&destination);
            args.extras = vec!["saves".into()];
            args
        };

        let backing_up = locks
            .acquire(EXPORT_ID, InstanceActivity::BackingUp)
            .unwrap();
        let err = export_modpack_with(
            &facade,
            &registry,
            &locks,
            &GameSlot::default(),
            "ex-backup",
            EXPORT_ID,
            with_saves(),
            &sink,
        )
        .await
        .unwrap_err();
        assert_eq!(err.code, code::INSTANCE_BUSY);
        assert_eq!(err.detail.unwrap()["activity"], "backing_up");
        assert!(!registry.is_running("ex-backup"));
        assert!(!destination.exists());
        assert!(server.received_requests().await.unwrap().is_empty());
        assert_eq!(locks.activity(EXPORT_ID), Some(InstanceActivity::BackingUp));

        // 没勾存档的导出不碰 saves，备份在做也照常：和先导出再备份一样可以并行。
        export_modpack_with(
            &facade,
            &registry,
            &locks,
            &GameSlot::default(),
            "ex-no-saves",
            EXPORT_ID,
            export_args(&destination),
            &sink,
        )
        .await
        .unwrap();
        assert!(destination.is_file());
        std::fs::remove_file(&destination).unwrap();

        drop(backing_up);
        assert_eq!(locks.activity(EXPORT_ID), None);

        export_modpack_with(
            &facade,
            &registry,
            &locks,
            &GameSlot::default(),
            "ex-after",
            EXPORT_ID,
            with_saves(),
            &sink,
        )
        .await
        .unwrap();
        assert!(destination.is_file());
    }

    /// 勾了存档时，游戏开着存档随时在写，包里会是半截：启动中、运行中报 instance_busy；没勾存档的导出不碰
    /// saves，与运行和备份都兼容。不隔离的实例还要看别的实例：占着游戏的实例也不隔离时共用这份存档。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn export_with_saves_waits_for_the_game() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/version_files"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({})))
            .mount(&server)
            .await;
        let dir = tempfile::tempdir().unwrap();
        let facade = facade_in(dir.path(), &server.uri());
        export_instance(dir.path());
        let game = dir.path().join(".minecraft");
        for id in ["共用甲", "共用乙"] {
            let version = game.join("versions").join(id);
            std::fs::create_dir_all(&version).unwrap();
            std::fs::write(
                version.join(format!("{id}.json")),
                format!(
                    r#"{{"id":"{id}","clientVersion":"1.21.1","type":"release","mainClass":"M"}}"#
                ),
            )
            .unwrap();
        }
        let registry = TaskRegistry::default();
        let locks = InstanceLocks::default();
        let (sink, _rx) = tokio::sync::mpsc::unbounded_channel::<CoreEvent>();
        let destination = dir.path().join("运行中.mrpack");
        let args = |saves: bool| {
            let mut args = export_args(&destination);
            if saves {
                args.extras = vec!["saves".into()];
            }
            args
        };

        for activity in [InstanceActivity::Launching, InstanceActivity::Running] {
            let held = locks.acquire(EXPORT_ID, activity).unwrap();
            let err = export_modpack_with(
                &facade,
                &registry,
                &locks,
                &GameSlot::default(),
                "ex-running",
                EXPORT_ID,
                args(true),
                &sink,
            )
            .await
            .unwrap_err();
            assert_eq!(err.code, code::INSTANCE_BUSY, "{activity:?}");
            assert_eq!(
                err.detail,
                Some(json!({ "id": EXPORT_ID, "activity": activity })),
            );
            assert!(!registry.is_running("ex-running"));
            assert!(!destination.exists());
            assert_eq!(locks.activity(EXPORT_ID), Some(activity));
            assert!(locks.reading_saves().is_empty(), "被拒时记录随之撤销");
            drop(held);
        }

        let running = locks.acquire(EXPORT_ID, InstanceActivity::Running).unwrap();
        export_modpack_with(
            &facade,
            &registry,
            &locks,
            &GameSlot::default(),
            "ex-no-saves",
            EXPORT_ID,
            args(false),
            &sink,
        )
        .await
        .unwrap();
        assert!(destination.is_file());
        std::fs::remove_file(&destination).unwrap();
        drop(running);

        let slot = GameSlot::default();
        let reservation = slot.reserve("共用甲").unwrap();
        let err = export_modpack_with(
            &facade,
            &registry,
            &locks,
            &slot,
            "ex-shared-game",
            "共用乙",
            args(true),
            &sink,
        )
        .await
        .unwrap_err();
        assert_eq!(err.code, code::INSTANCE_BUSY);
        assert_eq!(
            err.detail,
            Some(json!({ "id": "共用甲", "activity": "launching" }))
        );
        assert!(!destination.exists());
        drop(reservation);

        let writing = locks.write_saves(EXPORT_ID);
        let err = export_modpack_with(
            &facade,
            &registry,
            &locks,
            &GameSlot::default(),
            "ex-writing",
            EXPORT_ID,
            args(true),
            &sink,
        )
        .await
        .unwrap_err();
        assert_eq!(err.code, code::INSTANCE_BUSY);
        assert_eq!(
            err.detail,
            Some(json!({ "id": EXPORT_ID, "activity": "modifying" }))
        );
        assert!(err.message.contains("装数据包"), "{}", err.message);
        assert!(!destination.exists());
        drop(writing);
    }

    /// 不隔离的实例共用游戏目录的 saves：另一个不隔离的实例正在备份或恢复存档时，导出同样报 instance_busy，
    /// detail 指向那个实例，不登记任务、不写文件；隔离的实例在备份不挡。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn export_of_a_shared_instance_waits_for_another_shared_backup() {
        let dir = tempfile::tempdir().unwrap();
        let facade = facade_in(dir.path(), "http://127.0.0.1:9");
        export_instance(dir.path());
        let game = dir.path().join(".minecraft");
        for id in ["共用甲", "共用乙"] {
            let version = game.join("versions").join(id);
            std::fs::create_dir_all(&version).unwrap();
            std::fs::write(
                version.join(format!("{id}.json")),
                format!(
                    r#"{{"id":"{id}","clientVersion":"1.21.1","type":"release","mainClass":"M"}}"#
                ),
            )
            .unwrap();
        }
        std::fs::create_dir_all(game.join("saves").join("共用").join("region")).unwrap();
        std::fs::write(game.join("saves").join("共用").join("level.dat"), b"level").unwrap();
        let registry = TaskRegistry::default();
        let locks = InstanceLocks::default();
        let (sink, _rx) = tokio::sync::mpsc::unbounded_channel::<CoreEvent>();
        let destination = dir.path().join("共用 1.0.0.mrpack");
        let args = || {
            let mut args = export_args(&destination);
            args.extras = vec!["saves".into()];
            args
        };

        let backing_up = locks
            .acquire("共用甲", InstanceActivity::BackingUp)
            .unwrap();
        let err = export_modpack_with(
            &facade,
            &registry,
            &locks,
            &GameSlot::default(),
            "ex-shared",
            "共用乙",
            args(),
            &sink,
        )
        .await
        .unwrap_err();
        assert_eq!(err.code, code::INSTANCE_BUSY);
        assert_eq!(
            err.detail,
            Some(json!({ "id": "共用甲", "activity": "backing_up" }))
        );
        assert!(!registry.is_running("ex-shared"));
        assert!(!destination.exists());
        assert_eq!(locks.activity("共用乙"), None);
        drop(backing_up);

        let isolated = locks
            .acquire(EXPORT_ID, InstanceActivity::BackingUp)
            .unwrap();
        let outcome = export_modpack_with(
            &facade,
            &registry,
            &locks,
            &GameSlot::default(),
            "ex-shared",
            "共用乙",
            args(),
            &sink,
        )
        .await
        .unwrap();
        drop(isolated);
        assert_eq!(outcome.override_files, 1, "共用存档里的 level.dat");
        assert!(destination.is_file());
    }

    /// 前端要调的保存对话框授予在能力文件里。「在文件夹里选中」改走后端的 reveal_in_folder：opener 的
    /// reveal_item_in_dir 不受路径范围约束，页面里注入的脚本就能让资源管理器定位到任意路径，WebView 不拿它，
    /// 也不拿连它一起授予的 opener:default。
    #[test]
    fn capability_grants_the_save_dialog_but_not_reveal_in_folder() {
        let cap: serde_json::Value =
            serde_json::from_str(include_str!("../../capabilities/default.json")).unwrap();
        let granted: Vec<&str> = cap["permissions"]
            .as_array()
            .unwrap()
            .iter()
            .map(|p| p.as_str().unwrap())
            .collect();
        assert!(
            granted.contains(&"dialog:allow-save"),
            "能力文件缺少 dialog:allow-save"
        );
        for unneeded in ["opener:default", "opener:allow-reveal-item-in-dir"] {
            assert!(
                !granted.contains(&unneeded),
                "WebView 不该拿到 {unneeded}：它会放行不受路径范围约束的 reveal_item_in_dir"
            );
        }
    }
}
