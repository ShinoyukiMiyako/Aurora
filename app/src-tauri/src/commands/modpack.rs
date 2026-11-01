//! 整合包：预览本地整合包文件、不下载整包读平台整合包的清单摘要，把平台或本地整合包导入为新实例，
//! 把实例导出为 Modrinth `.mrpack`。

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use aurora_core::{
    Aurora, BundleReason, EventSink, ExportBundledMod, ExportExtra, ExportMatch, InstanceModpack,
    MarkerError, MarkerSettlement, ModpackExportOptions, ModpackExportOutcome,
    ModpackExportPreview, ModpackExportTarget, ModpackInstallOutcome, ModpackPreview,
    ModpackSource, ModpackSummary, PackFormat, PackLoader,
};
use serde::{Deserialize, Serialize};
use serde_json::json;
use tauri::{AppHandle, State};

use crate::commands::discover::parse_platform;
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

/// 长任务：把整合包导入为新实例。`name` 缺省用整合包自己的名字。进度经 core-event 推送并带
/// `task_id`，可用 cancel_task 取消；失败或取消后不留半成品实例。
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
        events.sink(),
    )
    .await;
    events.finish().await;
    crate::textures::refresh_on_success(&app, &outcome).await;
    outcome
}

pub(crate) async fn install_modpack_with(
    facade: &Facade,
    tasks: &TaskRegistry,
    locks: &InstanceLocks,
    task_id: &str,
    source: ModpackSourceArg,
    name: Option<&str>,
    events: &EventSink,
) -> Result<ModpackInstallOutcomeDto, CommandError> {
    // 先解析全部入参再登记任务：参数非法不该占用任务 id。
    let source = parse_source(source)?;
    let task = tasks.register(task_id)?;
    let aurora = facade.snapshot().await.with_cancel(task.token().clone());
    // 占用守卫与实例名放在导入的 future 之外：取消宽限期满时 run 会丢弃 future，实例名得一直占到下面
    // 按名字清理完半成品，否则清理前的空档里别的命令就能动这个目录。
    let reserved: Mutex<Option<(String, InstanceGuard)>> = Mutex::new(None);
    let result = task
        .run(async {
            let prepared = aurora.prepare_modpack(&source, name, Some(events)).await?;
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
    pub skipped: Vec<String>,
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
/// 删除报 `instance_busy`。
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
) -> Result<ModpackExportOutcomeDto, CommandError> {
    let events = CoreEventForwarder::to_app(&app, Some(task_id.clone()));
    let outcome = export_modpack_with(
        &facade,
        &tasks,
        &locks,
        &task_id,
        &id,
        options,
        events.sink(),
    )
    .await;
    events.finish().await;
    outcome
}

pub(crate) async fn export_modpack_with(
    facade: &Facade,
    tasks: &TaskRegistry,
    locks: &InstanceLocks,
    task_id: &str,
    id: &str,
    options: ModpackExportOptionsArg,
    events: &EventSink,
) -> Result<ModpackExportOutcomeDto, CommandError> {
    // 参数在占锁、登记任务之前全部校验：非法调用不该占用任务 id。
    let id = export_id(id)?;
    let (destination, options) = parse_export_options(options).await?;
    let _guard = locks.acquire(id, InstanceActivity::Modifying)?;
    let task = tasks.register(task_id)?;
    let aurora = facade.snapshot().await.with_cancel(task.token().clone());
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
            })
            .collect(),
        skipped: preview.skipped,
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
                install_modpack_with(&f, &r, &l, "mp-hold", source, Some("导入中"), &sink).await
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
                install_modpack_with(&f, &r, &l, "mp-locked", source, Some("删不掉"), &sink).await
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
            let err = export_modpack_with(&facade, &registry, &locks, "ex-bad", id, args, &sink)
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
        export_instance(dir.path());
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
        assert_eq!(wire["extras"][6]["extra"], "saves");

        let destination = dir.path().join("樱花林 1.0.0.mrpack");
        let outcome = export_modpack_with(
            &facade,
            &registry,
            &locks,
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

    /// 平台迟迟不回时取消：期限内以 cancelled 返回，目标与临时文件都不存在，任务与实例都放开。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn cancelling_while_modrinth_is_slow_returns_within_deadline() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/version_files"))
            .respond_with(
                ResponseTemplate::new(200)
                    .set_body_json(serde_json::json!({}))
                    .set_delay(Duration::from_secs(3)),
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
                export_modpack_with(&f, &r, &l, "ex-slow", EXPORT_ID, args, &sink).await
            }
        });

        let deadline = Instant::now() + Duration::from_secs(10);
        while server.received_requests().await.unwrap().is_empty() {
            assert!(Instant::now() < deadline, "导出没有开始问 Modrinth");
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        assert_eq!(locks.activity(EXPORT_ID), Some(InstanceActivity::Modifying));

        let cancelled_at = Instant::now();
        assert!(registry.cancel("ex-slow"));
        let err = export.await.unwrap().unwrap_err();
        let elapsed = cancelled_at.elapsed();
        assert_eq!(err.code, code::CANCELLED);
        assert!(elapsed < CANCEL_DEADLINE, "取消到返回耗时 {elapsed:?}");
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
        Mock::given(method("POST"))
            .and(path("/version_files"))
            .respond_with(
                ResponseTemplate::new(200)
                    .set_body_json(serde_json::json!({}))
                    .set_delay(Duration::from_secs(3)),
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
                export_modpack_with(&f, &r, &l, "ex-hold", EXPORT_ID, args, &sink).await
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

    /// 前端要调的保存对话框与「在文件夹里选中」两条插件权限写在能力文件里。
    #[test]
    fn capability_grants_the_save_dialog_and_reveal_in_folder() {
        let cap: serde_json::Value =
            serde_json::from_str(include_str!("../../capabilities/default.json")).unwrap();
        let granted: Vec<&str> = cap["permissions"]
            .as_array()
            .unwrap()
            .iter()
            .map(|p| p.as_str().unwrap())
            .collect();
        for needed in ["dialog:allow-save", "opener:allow-reveal-item-in-dir"] {
            assert!(granted.contains(&needed), "能力文件缺少 {needed}");
        }
    }
}
