//! 发现与安装：聚合搜索 Modrinth + CurseForge、工程详情，把平台上的 Mod 版本装进实例。

use aurora_core::{
    AggregateResult, EventSink, ModLoader, Platform, ProjectDetail, ResourceInstallOutcome,
    ResourceTarget, ResourceType, SearchCursor, SearchEntry, SearchQuery, SkippedPlatform,
    SortField,
};
use serde::Serialize;
use serde_json::Value;
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

/// 聚合搜索结果 DTO。条目直接复用已 Serialize 的 [`SearchEntry`]（合并卡带全部来源），
/// 单个平台的失败摊平成平台 + 文案，不影响另一平台的结果；没参与的平台与原因单列在 `skipped`。
#[derive(Debug, Serialize)]
pub struct SearchResultDto {
    pub hits: Vec<SearchEntry>,
    /// 参与平台报告的总数之和（合并前计数，界面写「约」）。
    pub total: u64,
    pub errors: Vec<PlatformErrorDto>,
    pub skipped: Vec<SkippedPlatform>,
    /// 下一页游标，原样回传给下一次搜索；`null` 表示到底。
    pub next_cursor: Option<SearchCursor>,
}

/// 单页条数上限：CurseForge 搜索接口的 pageSize 最大 50。
const MAX_SEARCH_LIMIT: u32 = 50;

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
        total: result.total,
        skipped: result.skipped,
        next_cursor: result.next_cursor,
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

/// 前端传来的一次搜索的全部条件（字符串枚举尚未解析）。
#[derive(Debug, Clone, Default)]
pub(crate) struct SearchArgs {
    pub query: Option<String>,
    pub resource_types: Vec<String>,
    pub category: Option<String>,
    pub platform: Option<String>,
    pub loaders: Vec<String>,
    pub game_versions: Vec<String>,
    pub sort: String,
    pub limit: u32,
    pub cursor: Option<Value>,
}

/// 校验并解析搜索条件。任何一项非法都整体报 `invalid_argument`，不发请求。
pub(crate) fn parse_search(
    args: SearchArgs,
) -> Result<(SearchQuery, Option<Platform>, Option<SearchCursor>), CommandError> {
    if args.limit == 0 || args.limit > MAX_SEARCH_LIMIT {
        return Err(CommandError::invalid_argument(format!(
            "每页条数须在 1 到 {MAX_SEARCH_LIMIT} 之间，收到 {}",
            args.limit
        )));
    }
    let category = args.category.map(|c| validate_category(&c)).transpose()?;
    let game_versions = args
        .game_versions
        .into_iter()
        .map(|v| {
            let v = v.trim().to_owned();
            if v.is_empty() || v.chars().any(char::is_control) {
                Err(CommandError::invalid_argument(
                    "游戏版本不能为空或含控制字符",
                ))
            } else {
                Ok(v)
            }
        })
        .collect::<Result<Vec<_>, _>>()?;
    let cursor = args
        .cursor
        .map(|raw| {
            serde_json::from_value::<SearchCursor>(raw)
                .map_err(|err| CommandError::invalid_argument(format!("翻页游标不合法：{err}")))
        })
        .transpose()?;
    let query = SearchQuery {
        // 空白搜索词等同于没有搜索词：两个平台都按热门浏览。
        query: args
            .query
            .map(|q| q.trim().to_owned())
            .filter(|q| !q.is_empty()),
        resource_types: args
            .resource_types
            .iter()
            .map(|t| parse_resource_type(t))
            .collect::<Result<_, _>>()?,
        category,
        loaders: args
            .loaders
            .iter()
            .map(|l| parse_mod_loader(l))
            .collect::<Result<_, _>>()?,
        game_versions,
        sort: parse_sort_field(&args.sort)?,
        limit: args.limit,
        offset: 0,
    };
    let platform = args.platform.as_deref().map(parse_platform).transpose()?;
    Ok((query, platform, cursor))
}

/// 分类键只能是 Modrinth 的小写连字符键；它会被拼进平台的过滤表达式，其余字符一律拒收。
fn validate_category(raw: &str) -> Result<String, CommandError> {
    let ok = !raw.is_empty()
        && raw.len() <= 64
        && raw
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-');
    if ok {
        Ok(raw.to_owned())
    } else {
        Err(CommandError::invalid_argument(format!(
            "分类键不合法：{raw}"
        )))
    }
}

/// 聚合搜索 Modrinth + CurseForge 一页。前端传字符串枚举，命令内构造 [`SearchQuery`]。
///
/// `resourceTypes` 为空表示全部类型；`category` 取 Modrinth 分类键；`platform` 为 `null` 表示两个
/// 平台都搜；`cursor` 首页传 `null`，之后原样回传上一页的 `next_cursor`。
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn search_resources(
    query: Option<String>,
    resource_types: Vec<String>,
    category: Option<String>,
    platform: Option<String>,
    loaders: Vec<String>,
    game_versions: Vec<String>,
    sort: String,
    limit: u32,
    cursor: Option<Value>,
    facade: State<'_, Facade>,
) -> Result<SearchResultDto, CommandError> {
    let (search_query, only, cursor) = parse_search(SearchArgs {
        query,
        resource_types,
        category,
        platform,
        loaders,
        game_versions,
        sort,
        limit,
        cursor,
    })?;
    let aurora = facade.snapshot().await;
    Ok(search_result_dto(
        aurora
            .search_page(&search_query, only, cursor.as_ref())
            .await?,
    ))
}

/// 工程详情：介绍正文、图库、支持的加载器与版本、最新版本、必需前置。
#[tauri::command]
pub async fn project_detail(
    platform: String,
    project_id: String,
    facade: State<'_, Facade>,
) -> Result<ProjectDetail, CommandError> {
    let platform = parse_platform(&platform)?;
    if project_id.trim().is_empty() {
        return Err(CommandError::invalid_argument("工程 id 不能为空"));
    }
    let aurora = facade.snapshot().await;
    Ok(aurora.project_detail(platform, &project_id).await?)
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

/// 一次资源安装结果 DTO。
#[derive(Debug, Serialize)]
pub struct ResourceInstallOutcomeDto {
    pub file_name: String,
    pub path: String,
    pub platform: Platform,
    pub resource_type: ResourceType,
    /// 数据包装进的存档；其余类型为 null。
    pub world: Option<String>,
}

fn resource_outcome_dto(outcome: ResourceInstallOutcome) -> ResourceInstallOutcomeDto {
    ResourceInstallOutcomeDto {
        file_name: outcome.file_name,
        path: outcome.path.display().to_string(),
        platform: outcome.platform,
        resource_type: outcome.resource_type,
        world: outcome.world,
    }
}

/// 把平台上的资源包、光影、数据包或 Mod 的一个版本装进实例里该类型的目录。长任务：进度经
/// core-event 推送并带 `task_id`，可经 `cancel_task(taskId)` 取消。
///
/// `world` 只对数据包有意义且必填（存档目录名）；`fileVersionId` 为 Modrinth 版本 id 或
/// CurseForge 文件 id。
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn install_resource(
    app: AppHandle,
    task_id: String,
    version_id: String,
    resource_type: String,
    world: Option<String>,
    platform: String,
    project_id: String,
    file_version_id: String,
    facade: State<'_, Facade>,
    tasks: State<'_, TaskRegistry>,
) -> Result<ResourceInstallOutcomeDto, CommandError> {
    let events = CoreEventForwarder::to_app(&app, Some(task_id.clone()));
    let outcome = install_resource_with(
        &facade,
        &tasks,
        &task_id,
        InstallResourceArgs {
            version_id: &version_id,
            resource_type: &resource_type,
            world: world.as_deref(),
            platform: &platform,
            project_id: &project_id,
            file_version_id: &file_version_id,
        },
        events.sink(),
    )
    .await;
    events.finish().await;
    outcome
}

/// [`install_resource`] 的入参（字符串枚举尚未解析）。
pub(crate) struct InstallResourceArgs<'a> {
    pub version_id: &'a str,
    pub resource_type: &'a str,
    pub world: Option<&'a str>,
    pub platform: &'a str,
    pub project_id: &'a str,
    pub file_version_id: &'a str,
}

pub(crate) async fn install_resource_with(
    facade: &Facade,
    tasks: &TaskRegistry,
    task_id: &str,
    args: InstallResourceArgs<'_>,
    events: &EventSink,
) -> Result<ResourceInstallOutcomeDto, CommandError> {
    // 先解析全部入参再登记任务：参数非法不该占用任务 id。
    let resource_type = parse_resource_type(args.resource_type)?;
    if matches!(resource_type, ResourceType::Modpack | ResourceType::Plugin) {
        return Err(CommandError::invalid_argument(format!(
            "{} 不能作为单个资源装进实例",
            args.resource_type
        )));
    }
    let platform = parse_platform(args.platform)?;
    let task = tasks.register(task_id)?;
    let aurora = facade.snapshot().await.with_cancel(task.token().clone());
    let target = ResourceTarget {
        version_id: args.version_id,
        resource_type,
        world: args.world,
    };
    let outcome = task
        .run(async {
            Ok(aurora
                .install_resource(
                    target,
                    platform,
                    args.project_id,
                    args.file_version_id,
                    Some(events),
                )
                .await?)
        })
        .await?;
    Ok(resource_outcome_dto(outcome))
}

// 字符串取值统一用核心类型 serde 的 snake_case 表示，与出参 DTO 同一套命名。

pub(crate) fn parse_platform(name: &str) -> Result<Platform, CommandError> {
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::error::code;

    // 前端会把出参里的枚举值原样回传（搜索结果的平台、已装 Mod 的加载器），入参解析必须认得
    // 出参的序列化名，两边任何一处改名都要让这条测试挂掉。
    #[test]
    fn parsers_accept_every_serialized_name() {
        for loader in [
            ModLoader::Fabric,
            ModLoader::Quilt,
            ModLoader::Forge,
            ModLoader::NeoForge,
            ModLoader::LiteLoader,
        ] {
            let name = serde_json::to_value(loader).unwrap();
            assert_eq!(parse_mod_loader(name.as_str().unwrap()).unwrap(), loader);
        }
        for platform in [Platform::Modrinth, Platform::CurseForge] {
            let name = serde_json::to_value(platform).unwrap();
            assert_eq!(parse_platform(name.as_str().unwrap()).unwrap(), platform);
        }
        for resource_type in [
            ResourceType::Mod,
            ResourceType::Modpack,
            ResourceType::ResourcePack,
            ResourceType::Shader,
            ResourceType::DataPack,
            ResourceType::Plugin,
        ] {
            let name = serde_json::to_value(resource_type).unwrap();
            assert_eq!(
                parse_resource_type(name.as_str().unwrap()).unwrap(),
                resource_type
            );
        }
        for sort in [
            SortField::Relevance,
            SortField::Downloads,
            SortField::Follows,
            SortField::Newest,
            SortField::Updated,
        ] {
            let name = serde_json::to_value(sort).unwrap();
            assert_eq!(parse_sort_field(name.as_str().unwrap()).unwrap(), sort);
        }
        assert_eq!(
            parse_mod_loader("neo_forge").unwrap_err().code,
            code::INVALID_ARGUMENT
        );
        assert_eq!(
            parse_platform("curse_forge").unwrap_err().code,
            code::INVALID_ARGUMENT
        );
    }

    fn facade_in(dir: &std::path::Path, base: &str) -> Facade {
        let config = aurora_core::AuroraConfig {
            game_directory: Some(dir.join(".minecraft")),
            isolation_policy: aurora_core::IsolationPolicy::All,
            ..aurora_core::AuroraConfig::default()
        };
        let aurora = aurora_core::Aurora::open(config, dir.to_path_buf(), dir.join("config.json"))
            .unwrap()
            .with_platform_bases(base, base);
        Facade::new(aurora)
    }

    /// 端到端：资源包经命令装进实例的 resourcepacks/，事件都带本任务 id，任务随之注销。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn install_resource_lands_pack_and_tags_events_with_task_id() {
        use wiremock::matchers::{method, path};
        use wiremock::{Mock, MockServer, ResponseTemplate};

        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/version/rp1"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "id": "rp1", "project_id": "faithful", "name": "32x", "version_number": "1.0",
                "version_type": "release", "date_published": "2026-01-01T00:00:00Z",
                "files": [{"hashes": {}, "url": format!("{}/Faithful.zip", server.uri()),
                           "filename": "Faithful.zip", "primary": true, "size": 4}]
            })))
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path("/Faithful.zip"))
            .respond_with(ResponseTemplate::new(200).set_body_bytes(b"pack".to_vec()))
            .mount(&server)
            .await;

        let dir = tempfile::tempdir().unwrap();
        let mc = dir.path().join(".minecraft");
        let version_dir = mc.join("versions").join("生存");
        std::fs::create_dir_all(&version_dir).unwrap();
        std::fs::write(
            version_dir.join("生存.json"),
            r#"{"id":"生存","type":"release","mainClass":"m"}"#,
        )
        .unwrap();
        let facade = facade_in(dir.path(), &server.uri());
        let registry = TaskRegistry::default();
        let delivered = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let log = delivered.clone();
        let forwarder =
            CoreEventForwarder::spawn(Some("rp#1".into()), move |p| log.lock().unwrap().push(p));

        let outcome = install_resource_with(
            &facade,
            &registry,
            "rp#1",
            InstallResourceArgs {
                version_id: "生存",
                resource_type: "resource_pack",
                world: None,
                platform: "modrinth",
                project_id: "faithful",
                file_version_id: "rp1",
            },
            forwarder.sink(),
        )
        .await
        .unwrap();
        forwarder.finish().await;

        assert_eq!(outcome.file_name, "Faithful.zip");
        assert_eq!(outcome.resource_type, ResourceType::ResourcePack);
        let landed = version_dir.join("resourcepacks").join("Faithful.zip");
        assert_eq!(std::path::PathBuf::from(&outcome.path), landed);
        assert_eq!(std::fs::read(&landed).unwrap(), b"pack");
        assert!(!registry.is_running("rp#1"));
        let delivered = delivered.lock().unwrap();
        assert!(!delivered.is_empty());
        assert!(delivered
            .iter()
            .all(|p| p.task_id.as_deref() == Some("rp#1")));
    }

    #[tokio::test]
    async fn install_resource_rejects_bad_type_before_registering() {
        let dir = tempfile::tempdir().unwrap();
        let facade = facade_in(dir.path(), "http://127.0.0.1:9");
        let registry = TaskRegistry::default();
        let (sink, _rx) = tokio::sync::mpsc::unbounded_channel();
        for resource_type in ["modpack", "plugin", "world"] {
            let err = install_resource_with(
                &facade,
                &registry,
                "t",
                InstallResourceArgs {
                    version_id: "x",
                    resource_type,
                    world: None,
                    platform: "modrinth",
                    project_id: "p",
                    file_version_id: "v",
                },
                &sink,
            )
            .await
            .unwrap_err();
            assert_eq!(err.code, code::INVALID_ARGUMENT, "{resource_type}");
            assert!(!registry.is_running("t"));
        }
    }

    fn args() -> SearchArgs {
        SearchArgs {
            sort: "relevance".into(),
            limit: 24,
            ..SearchArgs::default()
        }
    }

    #[test]
    fn search_args_map_to_query_platform_and_cursor() {
        let cursor = SearchCursor {
            modrinth: aurora_core::PlatformCursor {
                offset: 24,
                exhausted: false,
                total: Some(1240),
                absorbed: vec![],
            },
            curseforge: aurora_core::PlatformCursor {
                offset: 20,
                exhausted: false,
                total: Some(300),
                absorbed: vec!["238222".into()],
            },
        };
        let (query, platform, parsed_cursor) = parse_search(SearchArgs {
            query: Some("  sodium  ".into()),
            resource_types: vec!["mod".into(), "data_pack".into()],
            category: Some("semi-realistic".into()),
            platform: Some("modrinth".into()),
            loaders: vec!["neoforge".into()],
            game_versions: vec![" 1.21.1 ".into()],
            sort: "downloads".into(),
            limit: 24,
            cursor: Some(serde_json::to_value(&cursor).unwrap()),
        })
        .unwrap();
        assert_eq!(query.query.as_deref(), Some("sodium"));
        assert_eq!(
            query.resource_types,
            vec![ResourceType::Mod, ResourceType::DataPack]
        );
        assert_eq!(query.category.as_deref(), Some("semi-realistic"));
        assert_eq!(query.loaders, vec![ModLoader::NeoForge]);
        assert_eq!(query.game_versions, vec!["1.21.1".to_string()]);
        assert_eq!(query.sort, SortField::Downloads);
        assert_eq!(query.limit, 24);
        assert_eq!(platform, Some(Platform::Modrinth));
        assert_eq!(parsed_cursor, Some(cursor));
    }

    #[test]
    fn empty_types_and_blank_query_mean_all_and_none() {
        let (query, platform, cursor) = parse_search(SearchArgs {
            query: Some("   ".into()),
            ..args()
        })
        .unwrap();
        assert!(query.resource_types.is_empty());
        assert_eq!(query.effective_types().len(), 5);
        assert_eq!(query.query, None);
        assert_eq!(platform, None);
        assert_eq!(cursor, None);
    }

    #[test]
    fn search_args_reject_bad_limit_category_version_and_cursor() {
        for limit in [0, 51] {
            let err = parse_search(SearchArgs { limit, ..args() }).unwrap_err();
            assert_eq!(err.code, code::INVALID_ARGUMENT, "limit {limit}");
        }
        assert!(parse_search(SearchArgs {
            limit: 50,
            ..args()
        })
        .is_ok());
        assert!(parse_search(SearchArgs { limit: 1, ..args() }).is_ok());
        for category in ["", "Optimization", "a b", "x\"]\"", &"a".repeat(65)] {
            let err = parse_search(SearchArgs {
                category: Some(category.to_string()),
                ..args()
            })
            .unwrap_err();
            assert_eq!(err.code, code::INVALID_ARGUMENT, "分类 {category:?}");
        }
        let err = parse_search(SearchArgs {
            game_versions: vec!["  ".into()],
            ..args()
        })
        .unwrap_err();
        assert_eq!(err.code, code::INVALID_ARGUMENT);
        let err = parse_search(SearchArgs {
            cursor: Some(serde_json::json!({"modrinth": 3})),
            ..args()
        })
        .unwrap_err();
        assert_eq!(err.code, code::INVALID_ARGUMENT);
        let err = parse_search(SearchArgs {
            resource_types: vec!["world".into()],
            ..args()
        })
        .unwrap_err();
        assert_eq!(err.code, code::INVALID_ARGUMENT);
        let err = parse_search(SearchArgs {
            platform: Some("planetminecraft".into()),
            ..args()
        })
        .unwrap_err();
        assert_eq!(err.code, code::INVALID_ARGUMENT);
    }

    /// 出参里的跳过原因与平台名都能被前端原样理解：序列化名钉死。
    #[test]
    fn skipped_platform_serializes_with_snake_case_reason() {
        let skipped = SkippedPlatform {
            platform: Platform::CurseForge,
            reason: aurora_core::SkipReason::CategoryUnmapped,
        };
        assert_eq!(
            serde_json::to_value(skipped).unwrap(),
            serde_json::json!({"platform": "curseforge", "reason": "category_unmapped"})
        );
        for (reason, name) in [
            (aurora_core::SkipReason::Filtered, "filtered"),
            (aurora_core::SkipReason::KeyMissing, "key_missing"),
        ] {
            assert_eq!(serde_json::to_value(reason).unwrap(), name);
        }
    }
}
