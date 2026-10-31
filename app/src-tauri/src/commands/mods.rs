//! 实例内的 Mod：列表、启停、移除、更新检查与更新；下载页的版本列表、落位矩阵与安装计划。
//!
//! 改动 mods 目录的命令（启停、移除、更新）在后端再守一道「游戏运行中不许改」：门面在动第一个文件前
//! 探测占用，命中时这里报 [`MOD_FILE_BUSY`]，前端据此提示先关游戏，而不是把它当成普通 IO 故障。
//!
//! 这些命令还以「改动 Mod 与资源」占住实例（更新全程持有，启停与移除只占一瞬）：它们按实例名算好
//! 路径再写文件、卷宗与历史，同时被改名或删除的话会按旧路径把实例目录重新建出来。

use aurora_core::modversions::ModVersionList;
use aurora_core::{
    is_mod_file_busy, Aurora, BaseError, CoreError, EventSink, InstallPlan, InstalledSource,
    InstanceMatch, InstanceMod, ModLoader, ModVersionInfo, Platform, StarterGroup,
    StarterMissingReason, StarterMods, UpdateCandidate,
};
use serde::de::DeserializeOwned;
use serde::Serialize;
use serde_json::{json, Value};
use tauri::{AppHandle, State};

use crate::commands::discover::parse_resource_type;
use crate::commands::error::code::MOD_FILE_BUSY;
use crate::commands::instances::{InstanceActivity, InstanceLocks};
use crate::commands::CommandError;
use crate::events::CoreEventForwarder;
use crate::facade::Facade;
use crate::tasks::TaskRegistry;

/// 一次 Mod 更新的结果 DTO。
#[derive(Debug, Serialize)]
pub struct ModUpdateOutcomeDto {
    pub file_name: String,
    pub path: String,
    pub platform: Platform,
}

/// 列出指定实例已装 Mod（含禁用态、jar 元数据，以及卷宗 join 出的来源与图标）。
#[tauri::command]
pub async fn list_mods(
    version_id: String,
    facade: State<'_, Facade>,
) -> Result<Vec<InstanceMod>, CommandError> {
    let aurora = facade.snapshot().await;
    Ok(aurora.list_mods(&version_id).await?)
}

/// 启用/禁用指定实例里的某个 Mod，返回切换后的磁盘路径。
#[tauri::command]
pub async fn set_mod_enabled(
    version_id: String,
    file_name: String,
    enabled: bool,
    facade: State<'_, Facade>,
    locks: State<'_, InstanceLocks>,
) -> Result<String, CommandError> {
    set_mod_enabled_with(&facade, &locks, &version_id, &file_name, enabled).await
}

pub(crate) async fn set_mod_enabled_with(
    facade: &Facade,
    locks: &InstanceLocks,
    version_id: &str,
    file_name: &str,
    enabled: bool,
) -> Result<String, CommandError> {
    require_non_empty("file_name", file_name)?;
    let _guard = locks.acquire(version_id, InstanceActivity::Modifying)?;
    let aurora = facade.snapshot().await;
    let path = aurora
        .set_mod_enabled(version_id, file_name, enabled)
        .await
        .map_err(mods_error)?;
    Ok(path.display().to_string())
}

/// 从实例里移除一个 Mod 文件，并在变更历史里记一条移除事件。
#[tauri::command]
pub async fn remove_mod(
    version_id: String,
    file_name: String,
    facade: State<'_, Facade>,
    locks: State<'_, InstanceLocks>,
) -> Result<(), CommandError> {
    remove_mod_with(&facade, &locks, &version_id, &file_name).await
}

pub(crate) async fn remove_mod_with(
    facade: &Facade,
    locks: &InstanceLocks,
    version_id: &str,
    file_name: &str,
) -> Result<(), CommandError> {
    require_non_empty("file_name", file_name)?;
    let _guard = locks.acquire(version_id, InstanceActivity::Modifying)?;
    let aurora = facade.snapshot().await;
    aurora
        .remove_mod(version_id, file_name)
        .await
        .map_err(mods_error)
}

/// 检查该实例可更新的 Mod（无身份的文件先按哈希反查补身份）。反查到的身份会回写卷宗，所以与其它
/// Mod 改动一样占住实例：改名、删除进行中报 `instance_busy`，免得卷宗按旧路径写回、建出空目录。
#[tauri::command]
pub async fn check_updates(
    version_id: String,
    facade: State<'_, Facade>,
    locks: State<'_, InstanceLocks>,
) -> Result<Vec<UpdateCandidate>, CommandError> {
    check_updates_with(&facade, &locks, &version_id).await
}

pub(crate) async fn check_updates_with(
    facade: &Facade,
    locks: &InstanceLocks,
    version_id: &str,
) -> Result<Vec<UpdateCandidate>, CommandError> {
    let _guard = locks.acquire(version_id, InstanceActivity::Modifying)?;
    let aurora = facade.snapshot().await;
    Ok(aurora.check_updates(version_id).await?)
}

/// 把实例里的某个 Mod 换成同工程的 `mod_version_id`。长任务：进度经 core-event 推送并带 `task_id`，
/// 可经 `cancel_task(taskId)` 取消（只能打断下载阶段，落位一旦开始就走完）。旧文件改名为 `.old`
/// 保留，变更历史里可回滚。
///
/// 作为组合任务（全部更新）的一项调用时传 `step`（第几项，从 0 计），它原样标在这次调用的每条事件上；
/// 单独调用不传。
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn update_mod(
    app: AppHandle,
    task_id: String,
    step: Option<u32>,
    version_id: String,
    file_name: String,
    mod_version_id: String,
    facade: State<'_, Facade>,
    tasks: State<'_, TaskRegistry>,
    locks: State<'_, InstanceLocks>,
) -> Result<ModUpdateOutcomeDto, CommandError> {
    // 参数在登记任务、起事件转发之前校验：非法调用不该占用一个任务 id。
    validate_update_args(&file_name, &mod_version_id)?;
    let events = CoreEventForwarder::to_app_step(&app, Some(task_id.clone()), step);
    let outcome = update_mod_with(
        &facade,
        &tasks,
        &locks,
        &task_id,
        &version_id,
        &file_name,
        &mod_version_id,
        Some(events.sink()),
    )
    .await;
    events.finish().await;
    outcome
}

fn validate_update_args(file_name: &str, mod_version_id: &str) -> Result<(), CommandError> {
    require_non_empty("file_name", file_name)?;
    require_non_empty("mod_version_id", mod_version_id)
}

#[allow(clippy::too_many_arguments)]
pub(crate) async fn update_mod_with(
    facade: &Facade,
    tasks: &TaskRegistry,
    locks: &InstanceLocks,
    task_id: &str,
    version_id: &str,
    file_name: &str,
    mod_version_id: &str,
    events: Option<&EventSink>,
) -> Result<ModUpdateOutcomeDto, CommandError> {
    validate_update_args(file_name, mod_version_id)?;
    let _guard = locks.acquire(version_id, InstanceActivity::Modifying)?;
    let task = tasks.register(task_id)?;
    let aurora: Aurora = facade.snapshot().await.with_cancel(task.token().clone());
    let outcome = task
        .run(async {
            aurora
                .update_mod(version_id, file_name, mod_version_id, events)
                .await
                .map_err(mods_error)
        })
        .await?;
    Ok(ModUpdateOutcomeDto {
        file_name: outcome.file_name,
        path: outcome.path.display().to_string(),
        platform: outcome.platform,
    })
}

/// 某工程的版本列表。
#[derive(Debug, Serialize)]
pub struct ModVersionListDto {
    /// 发布时间倒序。
    pub versions: Vec<ModVersionInfo>,
    /// CurseForge 上文件太多、只翻到了页数上限（500 个文件）：更老的版本不在列表里。
    pub truncated: bool,
}

impl From<ModVersionList> for ModVersionListDto {
    fn from(list: ModVersionList) -> Self {
        Self {
            versions: list.versions,
            truncated: list.truncated,
        }
    }
}

/// 列出某工程的可用版本（按发布时间倒序）。`game_versions` / `loaders` 为空表示该维度不过滤。
#[tauri::command]
pub async fn list_mod_versions(
    platform: String,
    project_id: String,
    game_versions: Vec<String>,
    loaders: Vec<String>,
    facade: State<'_, Facade>,
) -> Result<ModVersionListDto, CommandError> {
    let platform = parse_platform(&platform)?;
    require_non_empty("project_id", &project_id)?;
    let loaders = loaders
        .iter()
        .map(|name| parse_loader(name))
        .collect::<Result<Vec<_>, _>>()?;
    let aurora = facade.snapshot().await;
    Ok(aurora
        .mod_version_list(platform, &project_id, &game_versions, &loaders)
        .await?
        .into())
}

/// 一个实例里已装 Mod 的平台来源；读不出卷宗或 mods 目录时带上与命令错误同形状的 `error`。
#[derive(Debug, Serialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum InstanceSourcesDto {
    Ready {
        version_id: String,
        sources: Vec<InstalledSource>,
    },
    Error {
        version_id: String,
        error: CommandError,
    },
}

/// 全部实例已装 Mod 的平台来源，一次取齐，按实例 id 排序（发现页结果卡的「已装入 n 个实例」）。
/// 只读卷宗与 mods 目录的文件名，不占实例锁：读的同时有人改 Mod，结果只是暂时过期，改完失效重取即对。
#[tauri::command]
pub async fn installed_sources(
    facade: State<'_, Facade>,
) -> Result<Vec<InstanceSourcesDto>, CommandError> {
    installed_sources_with(&facade).await
}

pub(crate) async fn installed_sources_with(
    facade: &Facade,
) -> Result<Vec<InstanceSourcesDto>, CommandError> {
    let aurora = facade.snapshot().await;
    let all = aurora.installed_mod_sources().await?;
    Ok(all
        .into_iter()
        .map(|instance| match instance.sources {
            Ok(sources) => InstanceSourcesDto::Ready {
                version_id: instance.version_id,
                sources,
            },
            Err(err) => InstanceSourcesDto::Error {
                version_id: instance.version_id,
                error: err.into(),
            },
        })
        .collect())
}

/// 某工程对全部已装实例的落位矩阵（兼容 / 可能可行 / 已安装 / 不兼容）。`mod_version_id` 给出时整个
/// 矩阵只按这一个版本判定。`resource_type` 决定判定口径：资源包、光影、数据包不看加载器。
#[tauri::command]
pub async fn match_instances(
    platform: String,
    project_id: String,
    resource_type: String,
    mod_version_id: Option<String>,
    facade: State<'_, Facade>,
) -> Result<Vec<InstanceMatch>, CommandError> {
    let platform = parse_platform(&platform)?;
    require_non_empty("project_id", &project_id)?;
    let resource_type = parse_resource_type(&resource_type)?;
    if let Some(id) = &mod_version_id {
        require_non_empty("mod_version_id", id)?;
    }
    let aurora = facade.snapshot().await;
    Ok(aurora
        .match_instances(
            platform,
            &project_id,
            resource_type,
            mod_version_id.as_deref(),
        )
        .await?)
}

/// 安装前的计划：主 Mod + 自动带上的必需前置（已装的标为已满足、不再下载），以及跳过项的说明。
#[tauri::command]
pub async fn plan_install(
    version_id: String,
    platform: String,
    project_id: String,
    mod_version_id: String,
    facade: State<'_, Facade>,
) -> Result<InstallPlan, CommandError> {
    let platform = parse_platform(&platform)?;
    require_non_empty("project_id", &project_id)?;
    require_non_empty("mod_version_id", &mod_version_id)?;
    let aurora = facade.snapshot().await;
    Ok(aurora
        .plan_install(&version_id, platform, &project_id, &mod_version_id)
        .await?)
}

/// 开局组合里一项能装的 Mod 与挑中的版本。
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct StarterModDto {
    pub group: StarterGroup,
    pub project_id: &'static str,
    pub name: &'static str,
    pub version: ModVersionInfo,
}

/// 开局组合里一项装不上的 Mod。
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct StarterMissingDto {
    pub group: StarterGroup,
    pub project_id: &'static str,
    pub name: &'static str,
    pub reason: StarterMissingReason,
}

/// 某加载器与 MC 版本的开局组合，两张表都按开局表的顺序，前置 API 在最前。
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct StarterModsDto {
    pub loader: ModLoader,
    pub mc_version: String,
    pub available: Vec<StarterModDto>,
    pub missing: Vec<StarterMissingDto>,
}

fn starter_mods_dto(loader: ModLoader, mc_version: String, mods: StarterMods) -> StarterModsDto {
    StarterModsDto {
        loader,
        mc_version,
        available: mods
            .available
            .into_iter()
            .map(|m| StarterModDto {
                group: m.entry.group,
                project_id: m.entry.project_id,
                name: m.entry.name,
                version: m.version,
            })
            .collect(),
        missing: mods
            .missing
            .into_iter()
            .map(|m| StarterMissingDto {
                group: m.entry.group,
                project_id: m.entry.project_id,
                name: m.entry.name,
                reason: m.reason,
            })
            .collect(),
    }
}

/// 新建实例确认步的开局 Mod：按加载器的开局表逐项查适配 `mc_version` 的版本，列出能装的与装不上的。
///
/// 加载器按 serde 名解析，认不出报 `invalid_argument`（detail.field = loader，reason = unknown），
/// LiteLoader 没有开局表（reason = unsupported）；MC 版本去掉首尾空白后为空同样报错
/// （field = mc_version，reason = empty）。某个工程在平台上不存在时只把它列为缺项，其他失败整体报错。
#[tauri::command]
pub async fn starter_mods(
    loader: String,
    mc_version: String,
    facade: State<'_, Facade>,
) -> Result<StarterModsDto, CommandError> {
    starter_mods_with(&facade, &loader, &mc_version).await
}

pub(crate) async fn starter_mods_with(
    facade: &Facade,
    loader: &str,
    mc_version: &str,
) -> Result<StarterModsDto, CommandError> {
    let parsed: ModLoader =
        serde_json::from_value(Value::String(loader.to_owned())).map_err(|_| {
            CommandError::invalid_argument(format!("未知加载器 {loader}"))
                .with_detail(json!({ "field": "loader", "reason": "unknown" }))
        })?;
    if parsed == ModLoader::LiteLoader {
        return Err(
            CommandError::invalid_argument("LiteLoader 没有开局 Mod 组合")
                .with_detail(json!({ "field": "loader", "reason": "unsupported" })),
        );
    }
    let mc_version = mc_version.trim();
    if mc_version.is_empty() {
        return Err(CommandError::invalid_argument("mc_version 不能为空")
            .with_detail(json!({ "field": "mc_version", "reason": "empty" })));
    }
    let aurora = facade.snapshot().await;
    let mods = aurora
        .starter_mods(parsed, mc_version)
        .await
        .map_err(mods_error)?;
    Ok(starter_mods_dto(parsed, mc_version.to_owned(), mods))
}

/// 门面错误 -> 命令错误；文件占用单独给 [`MOD_FILE_BUSY`]，正文取门面给出的那句中文原因。
pub(crate) fn mods_error(err: CoreError) -> CommandError {
    if is_mod_file_busy(&err) {
        if let CoreError::Base(BaseError::Io { path, source }) = &err {
            tracing::warn!(path = %path.display(), "Mod 文件被占用，拒绝改动");
            return CommandError::new(MOD_FILE_BUSY, source.to_string())
                .with_detail(json!({ "path": path.display().to_string() }));
        }
    }
    err.into()
}

fn require_non_empty(name: &str, value: &str) -> Result<(), CommandError> {
    if value.trim().is_empty() {
        return Err(CommandError::invalid_argument(format!("{name} 不能为空")));
    }
    Ok(())
}

/// 按核心类型的 serde 名解析：前端回传的就是出参里的序列化名，两边同一张表，不另写映射。
fn parse_serde_name<T: DeserializeOwned>(name: &str, what: &str) -> Result<T, CommandError> {
    serde_json::from_value(Value::String(name.to_owned()))
        .map_err(|_| CommandError::invalid_argument(format!("未知{what} {name}")))
}

fn parse_platform(name: &str) -> Result<Platform, CommandError> {
    parse_serde_name(name, "资源平台")
}

fn parse_loader(name: &str) -> Result<ModLoader, CommandError> {
    parse_serde_name(name, "加载器")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::error::code;
    use aurora_core::{
        AuroraConfig, HistoryEvent, IsolationPolicy, Ledger, LedgerEntry, ResourceType,
    };
    use std::path::{Path, PathBuf};

    const VERSION_ID: &str = "1.21";

    /// 一个全量隔离、已装 1.21 的门面；返回门面与该实例的 mods 目录。
    async fn facade_with_instance(root: &Path) -> (Facade, PathBuf) {
        let mc = root.join(".minecraft");
        let dir = mc.join("versions").join(VERSION_ID);
        tokio::fs::create_dir_all(dir.join("mods")).await.unwrap();
        tokio::fs::write(
            dir.join(format!("{VERSION_ID}.json")),
            format!(r#"{{"id":"{VERSION_ID}","type":"release","mainClass":"m"}}"#),
        )
        .await
        .unwrap();
        let mut aurora = Aurora::open(
            AuroraConfig::default(),
            root.to_path_buf(),
            root.join("config.json"),
        )
        .unwrap();
        aurora.set_game_dir(&mc);
        aurora.set_isolation_policy(IsolationPolicy::All);
        (Facade::new(aurora), dir.join("mods"))
    }

    #[test]
    fn parsers_accept_every_serialized_name_and_reject_others() {
        for platform in [Platform::Modrinth, Platform::CurseForge] {
            let name = serde_json::to_value(platform).unwrap();
            assert_eq!(parse_platform(name.as_str().unwrap()).unwrap(), platform);
        }
        for loader in [
            ModLoader::Fabric,
            ModLoader::Quilt,
            ModLoader::Forge,
            ModLoader::NeoForge,
            ModLoader::LiteLoader,
        ] {
            let name = serde_json::to_value(loader).unwrap();
            assert_eq!(parse_loader(name.as_str().unwrap()).unwrap(), loader);
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
        let err = parse_resource_type("resourcepack").unwrap_err();
        assert_eq!(err.code, code::INVALID_ARGUMENT);
        assert_eq!(err.message, "未知资源类型 resourcepack");
        let err = parse_platform("Modrinth").unwrap_err();
        assert_eq!(err.code, code::INVALID_ARGUMENT);
        assert_eq!(err.message, "未知资源平台 Modrinth");
        assert_eq!(parse_loader("").unwrap_err().code, code::INVALID_ARGUMENT);
    }

    /// 版本列表的出参是对象：前端据 truncated 在版本下拉里说明列表不全。
    #[test]
    fn version_list_serializes_with_truncation_flag() {
        let wire = serde_json::to_value(ModVersionListDto::from(ModVersionList {
            versions: Vec::new(),
            truncated: true,
        }))
        .unwrap();
        assert_eq!(wire, json!({ "versions": [], "truncated": true }));
    }

    /// 移除走完整链路：文件删掉、卷宗条目摘掉、历史里多一条移除事件。
    #[tokio::test]
    async fn remove_mod_deletes_file_and_writes_history() {
        let tmp = tempfile::tempdir().unwrap();
        let (facade, mods_dir) = facade_with_instance(tmp.path()).await;
        tokio::fs::write(mods_dir.join("sodium.jar"), b"jar")
            .await
            .unwrap();
        let aurora = facade.snapshot().await;
        let mut ledger = Ledger::default();
        ledger.upsert(LedgerEntry {
            file_name: "sodium.jar".to_owned(),
            platform: Platform::Modrinth,
            project_id: "AANobbMI".to_owned(),
            version_id: "v1".to_owned(),
            version_number: Some("0.5.3".to_owned()),
            title: Some("Sodium".to_owned()),
            icon_url: None,
            sha1: None,
            installed_at: 1_700_000_000,
            installed_as_dependency_of: None,
        });
        aurora.ledger_store(VERSION_ID).save(&ledger).await.unwrap();

        remove_mod_with(&facade, &InstanceLocks::default(), VERSION_ID, "sodium.jar")
            .await
            .unwrap();

        assert!(!mods_dir.join("sodium.jar").exists());
        assert!(aurora
            .ledger_store(VERSION_ID)
            .load()
            .await
            .unwrap()
            .entries
            .is_empty());
        let events = aurora.history(VERSION_ID).await.unwrap().events;
        assert_eq!(events.len(), 1);
        match &events[0] {
            HistoryEvent::Remove { files, .. } => assert_eq!(files, &vec!["sodium.jar".to_owned()]),
            other => panic!("期望移除事件，得到 {other:?}"),
        }
        // 门面锁在命令返回后已释放。
        assert!(facade.is_unlocked());
    }

    /// 空参数在碰门面之前就以 invalid_argument 拒绝；更新命令不登记任务。
    #[tokio::test]
    async fn invalid_arguments_are_rejected_before_registering_a_task() {
        let tmp = tempfile::tempdir().unwrap();
        let (facade, _) = facade_with_instance(tmp.path()).await;
        let tasks = TaskRegistry::default();

        let err = update_mod_with(
            &facade,
            &tasks,
            &InstanceLocks::default(),
            "t-1",
            VERSION_ID,
            "a.jar",
            " ",
            None,
        )
        .await
        .unwrap_err();
        assert_eq!(err.code, code::INVALID_ARGUMENT);
        assert_eq!(err.message, "mod_version_id 不能为空");
        assert!(!tasks.is_running("t-1"));

        let err = remove_mod_with(&facade, &InstanceLocks::default(), VERSION_ID, "")
            .await
            .unwrap_err();
        assert_eq!(err.code, code::INVALID_ARGUMENT);
        assert_eq!(err.message, "file_name 不能为空");
    }

    /// 来源不明的文件不能更新：门面拒绝如实上抛，任务随命令结束注销。
    #[tokio::test]
    async fn update_of_unidentified_file_fails_and_unregisters_the_task() {
        let tmp = tempfile::tempdir().unwrap();
        let (facade, mods_dir) = facade_with_instance(tmp.path()).await;
        tokio::fs::write(mods_dir.join("manual.jar"), b"x")
            .await
            .unwrap();
        let tasks = TaskRegistry::default();

        let err = update_mod_with(
            &facade,
            &tasks,
            &InstanceLocks::default(),
            "t-2",
            VERSION_ID,
            "manual.jar",
            "v2",
            None,
        )
        .await
        .unwrap_err();
        assert_eq!(err.code, code::IO);
        assert!(
            err.detail.as_ref().unwrap()["causes"][0]
                .as_str()
                .unwrap()
                .contains("没有平台来源记录"),
            "原因链里应带门面给出的拒绝原因：{:?}",
            err.detail
        );
        assert!(!tasks.is_running("t-2"));
    }

    /// 后端第二道防线：jar 被以不许删除的方式打开着（游戏在跑）时，移除与启停报 mod_file_busy，
    /// 文件原样不动。
    #[cfg(windows)]
    #[tokio::test]
    async fn busy_mod_file_maps_to_mod_file_busy() {
        use std::os::windows::fs::OpenOptionsExt;

        let tmp = tempfile::tempdir().unwrap();
        let (facade, mods_dir) = facade_with_instance(tmp.path()).await;
        let jar = mods_dir.join("sodium.jar");
        tokio::fs::write(&jar, b"jar").await.unwrap();
        let held = std::fs::OpenOptions::new()
            .read(true)
            .share_mode(0x1 | 0x2)
            .open(&jar)
            .unwrap();

        let err = remove_mod_with(&facade, &InstanceLocks::default(), VERSION_ID, "sodium.jar")
            .await
            .unwrap_err();
        assert_eq!(err.code, MOD_FILE_BUSY);
        assert!(err.message.contains("sodium.jar"), "正文：{}", err.message);
        assert_eq!(
            err.detail.as_ref().unwrap()["path"],
            jar.display().to_string()
        );
        let err = set_mod_enabled_with(
            &facade,
            &InstanceLocks::default(),
            VERSION_ID,
            "sodium.jar",
            false,
        )
        .await
        .unwrap_err();
        assert_eq!(err.code, MOD_FILE_BUSY);
        assert!(jar.exists());

        drop(held);
        remove_mod_with(&facade, &InstanceLocks::default(), VERSION_ID, "sodium.jar")
            .await
            .unwrap();
        assert!(!jar.exists());
    }

    /// 实例正在改名或删除时，启停、移除、更新都以 instance_busy 拒绝，文件与卷宗原样不动，更新不登记任务。
    #[tokio::test]
    async fn mod_changes_are_refused_while_the_instance_is_renamed_or_deleted() {
        let tmp = tempfile::tempdir().unwrap();
        let (facade, mods_dir) = facade_with_instance(tmp.path()).await;
        let jar = mods_dir.join("sodium.jar");
        tokio::fs::write(&jar, b"jar").await.unwrap();
        let tasks = TaskRegistry::default();
        let locks = InstanceLocks::default();

        for activity in [InstanceActivity::Renaming, InstanceActivity::Deleting] {
            let held = locks.acquire(VERSION_ID, activity).unwrap();
            let expected = serde_json::to_value(activity).unwrap();
            let err = set_mod_enabled_with(&facade, &locks, VERSION_ID, "sodium.jar", false)
                .await
                .unwrap_err();
            assert_eq!(err.code, code::INSTANCE_BUSY);
            assert_eq!(err.detail.unwrap()["activity"], expected);
            let err = remove_mod_with(&facade, &locks, VERSION_ID, "sodium.jar")
                .await
                .unwrap_err();
            assert_eq!(err.code, code::INSTANCE_BUSY);
            let err = update_mod_with(
                &facade,
                &tasks,
                &locks,
                "t-busy",
                VERSION_ID,
                "sodium.jar",
                "v2",
                None,
            )
            .await
            .unwrap_err();
            assert_eq!(err.code, code::INSTANCE_BUSY);
            assert!(!tasks.is_running("t-busy"));
            let err = check_updates_with(&facade, &locks, VERSION_ID)
                .await
                .unwrap_err();
            assert_eq!(err.code, code::INSTANCE_BUSY);
            assert_eq!(err.detail.unwrap()["activity"], expected);
            drop(held);
        }
        assert_eq!(tokio::fs::read(&jar).await.unwrap(), b"jar");
        assert!(!mods_dir.join("sodium.jar.disabled").exists());
        let aurora = facade.snapshot().await;
        assert!(aurora.history(VERSION_ID).await.unwrap().events.is_empty());
    }

    /// 游戏运行中照样能启停与移除（被游戏占着的文件另由占用探测拒绝）；命令结束后实例仍记为运行中。
    #[tokio::test]
    async fn mod_changes_are_allowed_while_the_game_runs() {
        let tmp = tempfile::tempdir().unwrap();
        let (facade, mods_dir) = facade_with_instance(tmp.path()).await;
        tokio::fs::write(mods_dir.join("a.jar"), b"a")
            .await
            .unwrap();
        tokio::fs::write(mods_dir.join("b.jar"), b"b")
            .await
            .unwrap();
        let locks = InstanceLocks::default();
        let _game = locks
            .acquire(VERSION_ID, InstanceActivity::Running)
            .unwrap();

        let path = set_mod_enabled_with(&facade, &locks, VERSION_ID, "a.jar", false)
            .await
            .unwrap();
        assert_eq!(PathBuf::from(path), mods_dir.join("a.jar.disabled"));
        remove_mod_with(&facade, &locks, VERSION_ID, "b.jar")
            .await
            .unwrap();
        assert!(!mods_dir.join("b.jar").exists());
        assert_eq!(locks.activity(VERSION_ID), Some(InstanceActivity::Running));
    }

    #[test]
    fn non_busy_errors_keep_their_regular_code() {
        let err = mods_error(CoreError::VersionNotInstalled {
            id: "ghost".to_owned(),
        });
        assert_eq!(err.code, code::VERSION_NOT_INSTALLED);
    }

    /// 一次给出全部实例的已装来源；卷宗坏掉的实例单独带上命令错误的形状，不拖垮整次调用。
    #[tokio::test]
    async fn installed_sources_report_every_instance_and_isolate_broken_ones() {
        let tmp = tempfile::tempdir().unwrap();
        let (facade, mods_dir) = facade_with_instance(tmp.path()).await;
        tokio::fs::write(mods_dir.join("sodium.jar.disabled"), b"jar")
            .await
            .unwrap();
        let aurora = facade.snapshot().await;
        let mut ledger = Ledger::default();
        for (file_name, project_id) in [("sodium.jar", "AANobbMI"), ("gone.jar", "P7dR8mSH")] {
            ledger.upsert(LedgerEntry {
                file_name: file_name.to_owned(),
                platform: Platform::Modrinth,
                project_id: project_id.to_owned(),
                version_id: "v1".to_owned(),
                version_number: None,
                title: None,
                icon_url: None,
                sha1: None,
                installed_at: 1_700_000_000,
                installed_as_dependency_of: None,
            });
        }
        aurora.ledger_store(VERSION_ID).save(&ledger).await.unwrap();

        let broken = aurora.game_dir().join("versions").join("broken");
        tokio::fs::create_dir_all(&broken).await.unwrap();
        tokio::fs::write(
            broken.join("broken.json"),
            r#"{"id":"broken","type":"release","mainClass":"m"}"#,
        )
        .await
        .unwrap();
        let broken_ledger = aurora.ledger_store("broken");
        tokio::fs::create_dir_all(broken_ledger.path().parent().unwrap())
            .await
            .unwrap();
        tokio::fs::write(broken_ledger.path(), b"{").await.unwrap();

        let all = serde_json::to_value(installed_sources_with(&facade).await.unwrap()).unwrap();
        assert_eq!(all[0]["status"], "ready");
        assert_eq!(all[0]["version_id"], VERSION_ID);
        assert_eq!(
            all[0]["sources"],
            json!([{ "platform": "modrinth", "project_id": "AANobbMI" }])
        );
        assert_eq!(all[1]["status"], "error");
        assert_eq!(all[1]["version_id"], "broken");
        assert_eq!(all[1]["error"]["code"], code::CONFIG_INVALID);
        assert_eq!(all.as_array().unwrap().len(), 2);
        assert!(facade.is_unlocked());
    }

    fn starter_facade(root: &Path, modrinth: &str) -> Facade {
        let aurora = Aurora::open(
            AuroraConfig::default(),
            root.to_path_buf(),
            root.join("config.json"),
        )
        .unwrap()
        .with_platform_bases(modrinth, modrinth);
        Facade::new(aurora)
    }

    /// 参数在联网之前校验：认不出的加载器、LiteLoader 与空的 MC 版本都报 invalid_argument。
    #[tokio::test]
    async fn starter_mods_rejects_bad_arguments_before_any_request() {
        let server = wiremock::MockServer::start().await;
        let tmp = tempfile::tempdir().unwrap();
        let facade = starter_facade(tmp.path(), &server.uri());
        for (loader, mc, field, reason) in [
            ("liteloader", "1.12.2", "loader", "unsupported"),
            ("vanilla", "1.21.1", "loader", "unknown"),
            ("Fabric", "1.21.1", "loader", "unknown"),
            ("", "1.21.1", "loader", "unknown"),
            ("fabric", "", "mc_version", "empty"),
            ("neoforge", " \t ", "mc_version", "empty"),
        ] {
            let err = starter_mods_with(&facade, loader, mc).await.unwrap_err();
            assert_eq!(err.code, code::INVALID_ARGUMENT, "{loader:?} {mc:?}");
            let detail = err.detail.unwrap();
            assert_eq!(detail["field"], field, "{loader:?} {mc:?}");
            assert_eq!(detail["reason"], reason, "{loader:?} {mc:?}");
        }
        assert!(server.received_requests().await.unwrap().is_empty());
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn starter_mods_lists_available_and_missing_in_table_order() {
        use wiremock::matchers::{method, path, query_param};
        use wiremock::{Mock, ResponseTemplate};

        let server = wiremock::MockServer::start().await;
        for (project, versions) in [
            ("P7dR8mSH", vec!["fapi"]),
            ("AANobbMI", vec!["sodium"]),
            ("gvQqBUqZ", vec!["lithium"]),
            ("uXXizFIs", vec![]),
            ("nmDcB62a", vec!["modernfix"]),
        ] {
            let body: Vec<Value> = versions
                .iter()
                .map(|id| {
                    json!({
                        "id": id, "project_id": project, "name": id, "version_number": "1.0.0",
                        "version_type": "release", "date_published": "2026-08-01T00:00:00Z",
                        "game_versions": ["1.21.1"], "loaders": ["neoforge"],
                        "files": [{"hashes": {"sha1": "00"}, "url": format!("https://cdn/{id}.jar"),
                            "filename": format!("{id}.jar"), "primary": true, "size": 64}]
                    })
                })
                .collect();
            Mock::given(method("GET"))
                .and(path(format!("/project/{project}/version")))
                .and(query_param("loaders", r#"["neoforge"]"#))
                .and(query_param("game_versions", r#"["1.21.1"]"#))
                .respond_with(ResponseTemplate::new(200).set_body_json(body))
                .mount(&server)
                .await;
        }
        let tmp = tempfile::tempdir().unwrap();
        let facade = starter_facade(tmp.path(), &server.uri());

        let dto = starter_mods_with(&facade, "neoforge", " 1.21.1 ")
            .await
            .unwrap();
        let wire = serde_json::to_value(&dto).unwrap();
        assert_eq!(wire["loader"], "neoforge");
        assert_eq!(wire["mc_version"], "1.21.1");
        let available: Vec<(&str, &str, &str)> = dto
            .available
            .iter()
            .map(|m| (m.project_id, m.name, m.version.version_id.as_str()))
            .collect();
        assert_eq!(
            available,
            vec![
                ("AANobbMI", "Sodium", "sodium"),
                ("gvQqBUqZ", "Lithium", "lithium"),
                ("nmDcB62a", "ModernFix", "modernfix"),
            ]
        );
        assert_eq!(wire["available"][0]["group"], "performance");
        assert_eq!(wire["available"][0]["version"]["file_name"], "sodium.jar");
        assert_eq!(
            wire["missing"],
            json!([{
                "group": "performance", "project_id": "uXXizFIs", "name": "FerriteCore",
                "reason": "no_version"
            }])
        );
        assert_eq!(server.received_requests().await.unwrap().len(), 4);
    }

    /// 平台连不上时整体报错，并照约定在 detail.network 里标明是连接失败。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn starter_mods_marks_network_failures() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        drop(listener);
        let tmp = tempfile::tempdir().unwrap();
        let facade = starter_facade(tmp.path(), &format!("http://127.0.0.1:{port}"));

        let err = starter_mods_with(&facade, "forge", "1.21.1")
            .await
            .unwrap_err();
        assert_eq!(err.code, code::MOD_PLATFORM_FAILED);
        assert_eq!(err.detail.unwrap()["network"], json!("connect"));
    }
}
