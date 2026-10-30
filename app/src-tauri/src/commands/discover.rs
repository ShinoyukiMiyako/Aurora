//! 发现与安装：聚合搜索 Modrinth + CurseForge，把平台上的 Mod 版本装进实例。

use aurora_core::{
    AggregateResult, ModLoader, Platform, ResourceType, SearchHit, SearchQuery, SortField,
};
use serde::Serialize;
use tauri::{AppHandle, State};

use crate::commands::CommandError;
use crate::events::CoreEventForwarder;
use crate::facade::Facade;
use crate::tasks::TaskRegistry;

/// 聚合搜索里某平台的失败记录 DTO。
#[derive(Debug, Serialize)]
pub struct PlatformErrorDto {
    pub platform: Platform,
    pub message: String,
}

/// 聚合搜索结果 DTO。命中直接复用已 Serialize 的 [`SearchHit`]（不含任何令牌），
/// 单个平台的失败摊平成平台 + 文案，不影响另一平台的结果。
#[derive(Debug, Serialize)]
pub struct SearchResultDto {
    pub hits: Vec<SearchHit>,
    pub errors: Vec<PlatformErrorDto>,
}

/// 一次 Mod 安装结果 DTO。
#[derive(Debug, Serialize)]
pub struct ModInstallOutcomeDto {
    pub file_name: String,
    pub path: String,
    pub platform: Platform,
}

fn search_result_dto(result: AggregateResult) -> SearchResultDto {
    SearchResultDto {
        hits: result.hits,
        errors: result
            .errors
            .into_iter()
            .map(|e| PlatformErrorDto {
                platform: e.platform,
                message: e.error.to_string(),
            })
            .collect(),
    }
}

/// 聚合搜索 Modrinth + CurseForge。前端传字符串枚举，命令内构造 [`SearchQuery`]。
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn search_resources(
    query: Option<String>,
    resource_type: String,
    loaders: Vec<String>,
    game_versions: Vec<String>,
    sort: String,
    limit: u32,
    offset: u32,
    facade: State<'_, Facade>,
) -> Result<SearchResultDto, CommandError> {
    let search_query = SearchQuery {
        query,
        resource_type: parse_resource_type(&resource_type)?,
        loaders: loaders
            .iter()
            .map(|l| parse_mod_loader(l))
            .collect::<Result<_, _>>()?,
        game_versions,
        sort: parse_sort_field(&sort)?,
        limit,
        offset,
    };
    let aurora = facade.snapshot().await;
    Ok(search_result_dto(aurora.search(&search_query).await?))
}

/// 把某平台上的一个 Mod 版本安装到指定实例的 mods 目录。长任务：进度经 core-event 推送并带
/// `task_id`，可经 `cancel_task(taskId)` 取消。
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn install_mod(
    app: AppHandle,
    task_id: String,
    version_id: String,
    platform: String,
    project_id: String,
    mod_version_id: String,
    facade: State<'_, Facade>,
    tasks: State<'_, TaskRegistry>,
) -> Result<ModInstallOutcomeDto, CommandError> {
    let target_platform = parse_platform(&platform)?;
    let events = CoreEventForwarder::to_app(&app, Some(task_id.clone()));
    let outcome = async {
        let task = tasks.register(&task_id)?;
        let aurora = facade.snapshot().await.with_cancel(task.token().clone());
        task.run(async {
            Ok(aurora
                .install_mod(
                    &version_id,
                    target_platform,
                    &project_id,
                    &mod_version_id,
                    Some(events.sink()),
                )
                .await?)
        })
        .await
    }
    .await;
    events.finish().await;
    let outcome = outcome?;
    Ok(ModInstallOutcomeDto {
        file_name: outcome.file_name,
        path: outcome.path.display().to_string(),
        platform: outcome.platform,
    })
}

// 字符串取值统一用核心类型 serde 的 snake_case 表示，与出参 DTO 同一套命名。

fn parse_platform(name: &str) -> Result<Platform, CommandError> {
    match name {
        "modrinth" => Ok(Platform::Modrinth),
        "curseforge" => Ok(Platform::CurseForge),
        other => Err(CommandError::invalid_argument(format!(
            "未知资源平台 {other}（支持 modrinth/curseforge）"
        ))),
    }
}

fn parse_resource_type(name: &str) -> Result<ResourceType, CommandError> {
    match name {
        "mod" => Ok(ResourceType::Mod),
        "modpack" => Ok(ResourceType::Modpack),
        "resource_pack" => Ok(ResourceType::ResourcePack),
        "shader" => Ok(ResourceType::Shader),
        "data_pack" => Ok(ResourceType::DataPack),
        "plugin" => Ok(ResourceType::Plugin),
        other => Err(CommandError::invalid_argument(format!(
            "未知资源类型 {other}"
        ))),
    }
}

fn parse_mod_loader(name: &str) -> Result<ModLoader, CommandError> {
    match name {
        "fabric" => Ok(ModLoader::Fabric),
        "quilt" => Ok(ModLoader::Quilt),
        "forge" => Ok(ModLoader::Forge),
        "neoforge" => Ok(ModLoader::NeoForge),
        "liteloader" => Ok(ModLoader::LiteLoader),
        other => Err(CommandError::invalid_argument(format!(
            "未知加载器 {other}"
        ))),
    }
}

fn parse_sort_field(name: &str) -> Result<SortField, CommandError> {
    match name {
        "relevance" => Ok(SortField::Relevance),
        "downloads" => Ok(SortField::Downloads),
        "follows" => Ok(SortField::Follows),
        "newest" => Ok(SortField::Newest),
        "updated" => Ok(SortField::Updated),
        other => Err(CommandError::invalid_argument(format!(
            "未知排序字段 {other}"
        ))),
    }
}
