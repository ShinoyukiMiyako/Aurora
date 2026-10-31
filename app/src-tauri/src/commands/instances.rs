//! 实例：列表、设置、内容、侧栏固定、新建（按实例名安装）、补全、删除、改名、打开文件夹，以及新建页要的
//! 版本清单、加载器版本与所需 Java。
//!
//! 会改动实例目录的操作（新建、整合包导入、补全、改名、删除，启动与运行中的游戏，以及装、删、启停、
//! 更新、回滚 Mod 与装资源）经 [`InstanceLocks`] 互斥，冲突时报 `instance_busy` 并在 detail 里带上
//! 正在做的事。Mod 与资源的改动彼此之间、与启动和运行中的游戏之间可以并行（运行中改不了的文件由
//! 门面的占用探测把关），与其余操作互斥。

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use aurora_core::{
    is_safe_instance_id, Aurora, CoreError, DeletionPreview, Disposer, EventSink, IncompleteKind,
    IncompleteMarker, IncompleteOutcome, InstanceContent, InstanceError, InstanceInstallOutcome,
    InstanceRequest, InstanceSummary, InstanceVersion, IsolationOverride, JavaSelection, LevelInfo,
    LoaderChoice, LoaderKind, ManifestOverview, MarkerError, MarkerSettlement, PackEntry,
    PlaySummary, Readable, RecycleBin, RepairOutcome, Resolution, VersionSettings, WorldEntry,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, State};
use tauri_plugin_opener::OpenerExt;

use crate::commands::error::code as common_code;
use crate::commands::CommandError;
use crate::events::CoreEventForwarder;
use crate::facade::Facade;
use crate::tasks::TaskRegistry;

// 本领域的 instance_busy、instance_has_dependents、open_failed 与通用码一起登记在 error::code。
use crate::commands::error::code;

// ---------------------------------------------------------------- 实例互斥

/// 实例上正在进行的事。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum InstanceActivity {
    Installing,
    Repairing,
    Renaming,
    Deleting,
    // 由启动命令持有：launch_game 先占为 Launching，进程起来后转 Running，退出时释放。
    Launching,
    Running,
    /// 装、删、启停、更新、回滚 Mod，或往实例里装资源包、光影、数据包。
    Modifying,
}

impl InstanceActivity {
    fn label(self) -> &'static str {
        match self {
            InstanceActivity::Installing => "安装",
            InstanceActivity::Repairing => "补全文件",
            InstanceActivity::Renaming => "改名",
            InstanceActivity::Deleting => "删除",
            InstanceActivity::Launching => "启动",
            InstanceActivity::Running => "运行",
            InstanceActivity::Modifying => "改动 Mod 与资源",
        }
    }

    /// 两件事能否同时在一个实例上进行。
    ///
    /// Mod 与资源的改动只往工作目录里加删文件、写卷宗与历史，彼此不冲突；游戏运行中仍允许改动，
    /// 被游戏占着的文件由门面在动手前探测并拒绝。改名、删除、新建、补全会挪走或重写整个目录，
    /// 与任何事都互斥，否则改动会按旧路径把目录重新建出来。
    fn compatible_with(self, other: Self) -> bool {
        use InstanceActivity::{Launching, Modifying, Running};
        matches!(
            (self, other),
            (Modifying, Modifying | Launching | Running) | (Launching | Running, Modifying)
        )
    }

    /// 同一实例上有几件事并行时，对外报哪一件：Mod 改动排在最后，界面关心的是启动与运行。
    fn report_rank(self) -> u8 {
        match self {
            InstanceActivity::Modifying => 1,
            _ => 0,
        }
    }
}

/// 一个实例上的全部占用。`next` 给每次占用发一个号，守卫凭号释放自己那一份。
#[derive(Default)]
struct LockTable {
    next: u64,
    held: HashMap<String, Vec<(u64, InstanceActivity)>>,
}

/// 实例级互斥表（managed state）。键不分大小写：Windows 上 `ABC` 与 `abc` 是同一个目录。
#[derive(Default, Clone)]
pub struct InstanceLocks {
    table: Arc<Mutex<LockTable>>,
}

fn lock_table(table: &Mutex<LockTable>) -> std::sync::MutexGuard<'_, LockTable> {
    // 临界区里只有 HashMap 与 Vec 的增删查，真中毒说明程序已处于未知状态，直接崩。
    table.lock().expect("实例互斥表的锁已中毒")
}

impl InstanceLocks {
    /// 占住实例 `id` 做 `activity`；已有与它不兼容的事在做时报 `instance_busy`。返回的守卫被丢弃即释放。
    ///
    /// 守卫自带表的引用、不借用 `self`，可以存进别的状态里跨命令持有（运行中的游戏会话）。
    pub fn acquire(
        &self,
        id: &str,
        activity: InstanceActivity,
    ) -> Result<InstanceGuard, CommandError> {
        let key = lock_key(id);
        let mut table = lock_table(&self.table);
        if let Some(conflict) = table.held.get(&key).and_then(|holds| {
            holds
                .iter()
                .map(|&(_, current)| current)
                .find(|current| !activity.compatible_with(*current))
        }) {
            return Err(busy(id, conflict));
        }
        let token = table.next;
        table.next += 1;
        table
            .held
            .entry(key.clone())
            .or_default()
            .push((token, activity));
        tracing::debug!(id, ?activity, "占用实例");
        Ok(InstanceGuard {
            table: self.table.clone(),
            key,
            token,
        })
    }

    /// 实例此刻在做的事；有几件并行时报最值得界面知道的那一件。
    pub fn activity(&self, id: &str) -> Option<InstanceActivity> {
        lock_table(&self.table)
            .held
            .get(&lock_key(id))
            .and_then(|holds| {
                holds
                    .iter()
                    .map(|&(_, activity)| activity)
                    .min_by_key(|activity| activity.report_rank())
            })
    }
}

/// 一次实例占用；丢弃即释放。
pub struct InstanceGuard {
    table: Arc<Mutex<LockTable>>,
    key: String,
    token: u64,
}

impl InstanceGuard {
    /// 改记正在做的事（启动成功后由「启动」转为「运行」）。只用于兼容关系相同的两件事之间转换，
    /// 所以不重新检查冲突。
    pub fn set_activity(&self, activity: InstanceActivity) {
        let mut table = lock_table(&self.table);
        let hold = table
            .held
            .get_mut(&self.key)
            .and_then(|holds| holds.iter_mut().find(|(token, _)| *token == self.token))
            .expect("守卫存活期间它的占用一定还在表里");
        hold.1 = activity;
    }
}

impl Drop for InstanceGuard {
    fn drop(&mut self) {
        let mut table = lock_table(&self.table);
        if let Some(holds) = table.held.get_mut(&self.key) {
            holds.retain(|(token, _)| *token != self.token);
            if holds.is_empty() {
                table.held.remove(&self.key);
            }
        }
    }
}

fn lock_key(id: &str) -> String {
    id.to_lowercase()
}

fn busy(id: &str, activity: InstanceActivity) -> CommandError {
    CommandError::new(
        code::INSTANCE_BUSY,
        format!("实例 {id} 正在{}，请稍后再试", activity.label()),
    )
    .with_detail(json!({ "id": id, "activity": activity }))
}

// ---------------------------------------------------------------- 错误映射

/// 实例领域的门面错误：参数类问题报 `invalid_argument` 并在 detail 里给出字段与规则，依赖冲突单独成码，
/// 其余照通用映射，并补上实例 id 等定位信息。
fn instance_error(err: CoreError) -> CommandError {
    let message = err.to_string();
    let (code, detail) = match &err {
        CoreError::Instance(InstanceError::InvalidId { id }) => (
            common_code::INVALID_ARGUMENT,
            json!({ "field": "id", "reason": "unsafe_id", "id": id }),
        ),
        CoreError::Instance(InstanceError::InvalidName { name, violation }) => (
            common_code::INVALID_ARGUMENT,
            json!({ "field": "name", "rule": violation.code(), "name": name }),
        ),
        CoreError::Instance(InstanceError::InvalidSettings { field, reason }) => (
            common_code::INVALID_ARGUMENT,
            json!({ "field": field, "reason": reason }),
        ),
        CoreError::Instance(InstanceError::InvalidPins { reason, id }) => (
            common_code::INVALID_ARGUMENT,
            json!({ "field": "pins", "reason": reason.code(), "id": id }),
        ),
        CoreError::Instance(InstanceError::HasDependents { id, dependents }) => (
            code::INSTANCE_HAS_DEPENDENTS,
            json!({ "id": id, "dependents": dependents }),
        ),
        CoreError::Instance(
            InstanceError::NotRepairable { id, reason } | InstanceError::Broken { id, reason },
        ) => {
            let extra = json!({ "id": id, "reason": reason });
            let mut mapped = CommandError::from(err);
            merge_detail(&mut mapped, extra);
            return mapped;
        }
        CoreError::Instance(InstanceError::Recycle { path, reason }) => {
            let extra = json!({ "path": path.display().to_string(), "reason": reason });
            let mut mapped = CommandError::from(err);
            merge_detail(&mut mapped, extra);
            return mapped;
        }
        _ => return err.into(),
    };
    tracing::warn!(code, %message, "命令失败");
    CommandError::new(code, message).with_detail(detail)
}

fn merge_detail(err: &mut CommandError, extra: Value) {
    let Value::Object(extra) = extra else {
        unreachable!("detail 一律是对象");
    };
    match &mut err.detail {
        Some(Value::Object(existing)) => existing.extend(extra),
        _ => err.detail = Some(Value::Object(extra)),
    }
}

fn invalid_field(field: &str, reason: &str, message: impl Into<String>) -> CommandError {
    CommandError::invalid_argument(message).with_detail(json!({ "field": field, "reason": reason }))
}

// ---------------------------------------------------------------- DTO

/// 实例里探测到的加载器。
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct LoaderDto {
    /// fabric / quilt / forge / neoforge / optifine / liteloader。
    pub kind: &'static str,
    pub version: Option<String>,
}

/// 未完成标记里记下的安装内容。
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct InstallSpecDto {
    pub mc_version: String,
    pub loader: Option<String>,
    pub loader_version: Option<String>,
}

/// 未完成标记里记下的错误。
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct MarkerErrorDto {
    pub code: String,
    pub message: String,
}

/// 实例的未完成状态。
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct IncompleteDto {
    /// install（新建没装完）/ repair（补全没做完）/ modpack（整合包没导入完）/ unknown（标记文件读不出来）。
    pub kind: &'static str,
    /// pending（进行中，或启动器在进行中被关掉）/ failed / cancelled / unknown。
    pub outcome: &'static str,
    /// 开始时刻（Unix 毫秒）。
    pub started_at: Option<u64>,
    pub spec: Option<InstallSpecDto>,
    /// 失败原因；标记读不出来时 code 为 marker_unreadable。
    pub error: Option<MarkerErrorDto>,
}

/// 列表里的一个实例。
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct InstanceDto {
    pub id: String,
    /// ready：版本 JSON 可用；broken：缺失或损坏，见 broken_reason。
    pub status: &'static str,
    pub broken_reason: Option<String>,
    /// 原版版本号；识别不出或 broken 时为 null。
    pub mc_version: Option<String>,
    pub loaders: Vec<LoaderDto>,
    /// 版本 JSON 的 type（release / snapshot / old_beta / old_alpha）。
    pub release_type: Option<String>,
    pub is_release: bool,
    /// 需要的 Java 主版本；继承链断了或 broken 时为 null。
    pub java_major: Option<u32>,
    /// 工作目录 mods/ 下的 Mod 文件数；broken 或设置读不出时为 null。
    pub mod_count: Option<u32>,
    pub description: Option<String>,
    pub cover: Option<String>,
    /// 实例设置文件读不出来的原因；此时 description、cover 为 null。
    pub settings_error: Option<String>,
    pub incomplete: Option<IncompleteDto>,
    /// 实例目录的创建时刻（Unix 毫秒）。
    pub created_at: Option<u64>,
    /// 实例此刻在做的事；空闲为 null。
    pub activity: Option<InstanceActivity>,
    /// 累计游玩分钟（向下取整）；没玩过为 0。
    pub playtime_min: u64,
    /// 上次游玩结束的 Unix 毫秒；没玩过为 null。
    pub last_played_at: Option<u64>,
}

/// 实例设置。读写同一形状；写入时不认识的字段直接报错。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct InstanceSettingsDto {
    pub description: Option<String>,
    /// 封面预设 id（小写字母、数字、下划线）；null 时界面按默认规则推导。
    pub cover: Option<String>,
    /// follow_global / enabled / disabled。
    pub isolation: IsolationOverride,
    /// 最大内存 MB；null 跟随全局。
    pub memory_mb: Option<u32>,
    /// "auto" 或 java 可执行文件的绝对路径。
    pub java: JavaSelection,
    pub jvm_args: String,
    pub resolution: Resolution,
    pub fullscreen: bool,
}

impl From<VersionSettings> for InstanceSettingsDto {
    fn from(s: VersionSettings) -> Self {
        Self {
            description: s.description,
            cover: s.cover,
            isolation: s.isolation,
            memory_mb: s.memory_mb,
            java: s.java,
            jvm_args: s.jvm_args,
            resolution: s.resolution,
            fullscreen: s.fullscreen,
        }
    }
}

impl From<InstanceSettingsDto> for VersionSettings {
    fn from(s: InstanceSettingsDto) -> Self {
        Self {
            description: s.description,
            cover: s.cover,
            isolation: s.isolation,
            memory_mb: s.memory_mb,
            java: s.java,
            jvm_args: s.jvm_args,
            resolution: s.resolution,
            fullscreen: s.fullscreen,
        }
    }
}

/// 一个存档。
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct WorldDto {
    /// 存档文件夹名。
    pub dir_name: String,
    /// ok：level.dat 读出来了；missing：没有 level.dat；unreadable：读不出来，原因见 level_error。
    pub level_status: &'static str,
    pub level_error: Option<String>,
    /// 存档名（level.dat 的 LevelName）；读不出来时为 null，界面用文件夹名。
    pub name: Option<String>,
    /// survival / creative / adventure / spectator / hardcore。
    pub mode: Option<&'static str>,
    /// 最后游玩时刻（Unix 毫秒，来自 level.dat）。
    pub last_played: Option<i64>,
    pub size_bytes: u64,
    /// 文件夹修改时刻（Unix 毫秒）。
    pub modified_at: Option<u64>,
}

/// 一个资源包或光影包文件（或文件夹）。
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct PackDto {
    pub file_name: String,
    pub is_dir: bool,
    pub size_bytes: u64,
    pub modified_at: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ResourcePackDto {
    #[serde(flatten)]
    pub pack: PackDto,
    /// 在游戏里启用时的加载顺序（从 1 起）；未启用为 null。
    pub load_order: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ShaderPackDto {
    #[serde(flatten)]
    pub pack: PackDto,
    /// 是否为当前选用的光影。
    pub active: bool,
}

/// 实例的资源包、光影包与存档。
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct InstanceContentDto {
    pub resource_packs: Vec<ResourcePackDto>,
    pub shader_packs: Vec<ShaderPackDto>,
    pub worlds: Vec<WorldDto>,
}

/// 删除前的预览。
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct DeletionPreviewDto {
    pub id: String,
    /// 会随实例一起删掉的存档（实例目录里的；共用目录的存档不受影响）。
    pub worlds: Vec<WorldDto>,
    pub size_bytes: u64,
    pub file_count: u64,
    /// 依赖它的实例；非空时删除会报 instance_has_dependents。
    pub dependents: Vec<String>,
    /// 实例此刻在做的事；非空时删除会报 instance_busy。
    pub activity: Option<InstanceActivity>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct DeleteOutcomeDto {
    /// 目录原先是否存在；重复删除时为 false。
    pub existed: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct RenameOutcomeDto {
    /// 新的实例 id。
    pub id: String,
}

/// 装上的加载器。
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct InstalledLoaderDto {
    /// fabric / quilt / forge / neoforge。
    pub kind: &'static str,
    pub version: String,
}

/// 新建实例的结果。
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct InstallResultDto {
    pub id: String,
    pub mc_version: String,
    pub loader: Option<InstalledLoaderDto>,
    pub libraries: usize,
    pub assets: usize,
    pub natives: u32,
}

/// 补全的结果。
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct RepairResultDto {
    /// 是否按记下的安装内容重装（新建没装完的实例）。
    pub reinstalled: bool,
    pub libraries: usize,
    pub assets: usize,
    pub natives: u32,
}

/// 一个可选的加载器版本。
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct LoaderVersionDto {
    pub version: String,
    pub stable: bool,
}

/// 版本清单里的单个版本。
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ManifestVersionDto {
    pub id: String,
    /// release / snapshot / old_beta / old_alpha。
    pub release_type: String,
    pub release_time: String,
    /// 可以装在这个版本上的加载器（fabric / quilt / forge / neoforge 的子集，固定顺序）。
    pub loaders: Vec<&'static str>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct LatestDto {
    pub release: String,
    pub snapshot: String,
}

/// 拉不到支持列表的加载器。
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct LoaderErrorDto {
    pub loader: &'static str,
    pub message: String,
}

/// 版本清单与各版本支持的加载器。
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ManifestDto {
    pub latest: LatestDto,
    pub versions: Vec<ManifestVersionDto>,
    /// 拉不到、也没有缓存的加载器；它们不会出现在任何版本的 loaders 里。
    pub loader_errors: Vec<LoaderErrorDto>,
    /// 有数据来自离线缓存时，最旧那份缓存的时刻（Unix 毫秒）；全部新鲜时为 null。
    pub stale_since: Option<u64>,
    /// 退回缓存的原因。
    pub fetch_error: Option<String>,
}

fn loader_kind_key(kind: LoaderKind) -> &'static str {
    match kind {
        LoaderKind::Fabric => "fabric",
        LoaderKind::Quilt => "quilt",
        LoaderKind::Forge => "forge",
        LoaderKind::NeoForge => "neoforge",
        LoaderKind::OptiFine => "optifine",
        LoaderKind::LiteLoader => "liteloader",
    }
}

fn incomplete_dto(marker: Readable<IncompleteMarker>) -> IncompleteDto {
    match marker {
        Readable::Read(marker) => {
            let (kind, spec) = match marker.kind {
                IncompleteKind::Install { spec } => (
                    "install",
                    Some(InstallSpecDto {
                        mc_version: spec.mc_version,
                        loader: spec.loader,
                        loader_version: spec.loader_version,
                    }),
                ),
                IncompleteKind::Repair => ("repair", None),
                IncompleteKind::Modpack { .. } => ("modpack", None),
            };
            IncompleteDto {
                kind,
                outcome: match marker.outcome {
                    IncompleteOutcome::Pending => "pending",
                    IncompleteOutcome::Failed => "failed",
                    IncompleteOutcome::Cancelled => "cancelled",
                },
                started_at: Some(marker.started_at),
                spec,
                error: marker.error.map(|e| MarkerErrorDto {
                    code: e.code,
                    message: e.message,
                }),
            }
        }
        Readable::Unreadable(message) => IncompleteDto {
            kind: "unknown",
            outcome: "unknown",
            started_at: None,
            spec: None,
            error: Some(MarkerErrorDto {
                code: "marker_unreadable".to_owned(),
                message,
            }),
        },
    }
}

fn instance_dto(
    summary: InstanceSummary,
    activity: Option<InstanceActivity>,
    play: Option<&PlaySummary>,
) -> InstanceDto {
    let (description, cover, settings_error) = match summary.settings {
        Readable::Read(settings) => (settings.description, settings.cover, None),
        Readable::Unreadable(error) => (None, None, Some(error)),
    };
    let mut dto = InstanceDto {
        id: summary.id,
        status: "ready",
        broken_reason: None,
        mc_version: None,
        loaders: Vec::new(),
        release_type: None,
        is_release: false,
        java_major: None,
        mod_count: None,
        description,
        cover,
        settings_error,
        incomplete: summary.incomplete.map(incomplete_dto),
        created_at: summary.created_at,
        activity,
        playtime_min: play.map_or(0, |p| p.playtime_min),
        last_played_at: play.map(|p| p.last_played_at),
    };
    match summary.version {
        InstanceVersion::Ready(ready) => {
            dto.mc_version = ready.mc_version;
            dto.loaders = ready
                .loaders
                .into_iter()
                .map(|l| LoaderDto {
                    kind: loader_kind_key(l.kind),
                    version: l.version,
                })
                .collect();
            dto.release_type = ready.release_type;
            dto.is_release = ready.is_release;
            dto.java_major = ready.java_major;
            dto.mod_count = ready.mod_count;
        }
        InstanceVersion::Broken(reason) => {
            dto.status = "broken";
            dto.broken_reason = Some(aurora_core::broken_reason_text(&reason));
        }
    }
    dto
}

fn world_dto(world: WorldEntry) -> WorldDto {
    let (level_status, level_error, name, mode, last_played) = match world.level {
        LevelInfo::Read(level) => (
            "ok",
            None,
            level.name,
            level.mode.map(|m| m.as_str()),
            level.last_played,
        ),
        LevelInfo::Missing => ("missing", None, None, None, None),
        LevelInfo::Unreadable(error) => ("unreadable", Some(error), None, None, None),
    };
    WorldDto {
        dir_name: world.dir_name,
        level_status,
        level_error,
        name,
        mode,
        last_played,
        size_bytes: world.size_bytes,
        modified_at: world.modified_at,
    }
}

fn pack_dto(pack: PackEntry) -> PackDto {
    PackDto {
        file_name: pack.file_name,
        is_dir: pack.is_dir,
        size_bytes: pack.size_bytes,
        modified_at: pack.modified_at,
    }
}

fn content_dto(content: InstanceContent) -> InstanceContentDto {
    InstanceContentDto {
        resource_packs: content
            .resource_packs
            .into_iter()
            .map(|p| ResourcePackDto {
                pack: pack_dto(p.pack),
                load_order: p.load_order,
            })
            .collect(),
        shader_packs: content
            .shader_packs
            .into_iter()
            .map(|p| ShaderPackDto {
                pack: pack_dto(p.pack),
                active: p.active,
            })
            .collect(),
        worlds: content.worlds.into_iter().map(world_dto).collect(),
    }
}

fn preview_dto(preview: DeletionPreview, activity: Option<InstanceActivity>) -> DeletionPreviewDto {
    DeletionPreviewDto {
        id: preview.id,
        worlds: preview.worlds.into_iter().map(world_dto).collect(),
        size_bytes: preview.size_bytes,
        file_count: preview.file_count,
        dependents: preview.dependents,
        activity,
    }
}

fn install_result_dto(outcome: InstanceInstallOutcome) -> InstallResultDto {
    InstallResultDto {
        id: outcome.id,
        mc_version: outcome.mc_version,
        loader: outcome.loader.map(|l| InstalledLoaderDto {
            kind: l.choice.key(),
            version: l.version,
        }),
        libraries: outcome.libraries,
        assets: outcome.assets,
        natives: outcome.natives,
    }
}

fn repair_result_dto(outcome: RepairOutcome) -> RepairResultDto {
    RepairResultDto {
        reinstalled: outcome.reinstalled,
        libraries: outcome.libraries,
        assets: outcome.assets,
        natives: outcome.natives,
    }
}

fn manifest_dto(overview: ManifestOverview) -> ManifestDto {
    let ManifestOverview {
        manifest,
        loaders,
        loader_errors,
        stale_since,
        fetch_error,
    } = overview;
    ManifestDto {
        latest: LatestDto {
            release: manifest.latest.release,
            snapshot: manifest.latest.snapshot,
        },
        versions: manifest
            .versions
            .into_iter()
            .map(|v| ManifestVersionDto {
                loaders: loaders
                    .get(&v.id)
                    .map(|choices| choices.iter().map(|c| c.key()).collect())
                    .unwrap_or_default(),
                id: v.id,
                release_type: v.release_type,
                release_time: v.release_time,
            })
            .collect(),
        loader_errors: loader_errors
            .into_iter()
            .map(|(choice, message)| LoaderErrorDto {
                loader: choice.key(),
                message,
            })
            .collect(),
        stale_since,
        fetch_error,
    }
}

fn parse_loader_choice(name: &str) -> Result<LoaderChoice, CommandError> {
    LoaderChoice::from_key(name).ok_or_else(|| {
        invalid_field(
            "loader",
            "unknown",
            format!("未知加载器 {name}（支持 fabric/quilt/forge/neoforge）"),
        )
    })
}

// ---------------------------------------------------------------- 列表、设置、内容

/// 列出全部实例：版本、加载器、设置、未完成标记、Mod 文件数、创建时间与正在做的事一次给齐。
#[tauri::command]
pub async fn list_instances(
    facade: State<'_, Facade>,
    locks: State<'_, InstanceLocks>,
) -> Result<Vec<InstanceDto>, CommandError> {
    list_instances_with(&facade, &locks).await
}

pub(crate) async fn list_instances_with(
    facade: &Facade,
    locks: &InstanceLocks,
) -> Result<Vec<InstanceDto>, CommandError> {
    let aurora = facade.snapshot().await;
    let list = aurora.list_instances().await.map_err(instance_error)?;
    let plays = aurora.play_summaries().await?;
    Ok(list
        .into_iter()
        .map(|summary| {
            let activity = locks.activity(&summary.id);
            let play = plays.get(&summary.id);
            instance_dto(summary, activity, play)
        })
        .collect())
}

/// 读取实例设置；没有自定义过时为默认值。
#[tauri::command]
pub async fn get_instance_settings(
    id: String,
    facade: State<'_, Facade>,
) -> Result<InstanceSettingsDto, CommandError> {
    let aurora = facade.snapshot().await;
    Ok(aurora
        .instance_settings(&id)
        .await
        .map_err(instance_error)?
        .into())
}

/// 整份写入实例设置并返回写下的内容。字段缺失、多出或取值不合法报 `invalid_argument`
/// （detail.field 指出是哪一项），文件不变。
#[tauri::command]
pub async fn set_instance_settings(
    id: String,
    settings: Value,
    facade: State<'_, Facade>,
) -> Result<InstanceSettingsDto, CommandError> {
    set_instance_settings_with(&facade, &id, settings).await
}

pub(crate) async fn set_instance_settings_with(
    facade: &Facade,
    id: &str,
    settings: Value,
) -> Result<InstanceSettingsDto, CommandError> {
    // 参数按 Value 收下再自己解析：交给 Tauri 反序列化的话，失败时前端拿到的是一句纯字符串，
    // 没有 code 可分支。
    let dto: InstanceSettingsDto = serde_json::from_value(settings).map_err(|err| {
        invalid_field("settings", "malformed", format!("实例设置格式不对：{err}"))
    })?;
    let aurora = facade.snapshot().await;
    let settings = VersionSettings::from(dto);
    aurora
        .set_instance_settings(id, &settings)
        .await
        .map_err(instance_error)?;
    Ok(settings.into())
}

/// 实例的资源包、光影包与存档（从实例运行时的工作目录读）。
#[tauri::command]
pub async fn list_instance_content(
    id: String,
    facade: State<'_, Facade>,
) -> Result<InstanceContentDto, CommandError> {
    let aurora = facade.snapshot().await;
    Ok(content_dto(
        aurora.instance_content(&id).await.map_err(instance_error)?,
    ))
}

// ---------------------------------------------------------------- 侧栏固定

/// 侧栏固定的实例（按顺序），已不存在的不返回。
#[tauri::command]
pub async fn get_sidebar_pins(facade: State<'_, Facade>) -> Result<Vec<String>, CommandError> {
    let aurora = facade.snapshot().await;
    aurora.existing_sidebar_pins().await.map_err(instance_error)
}

/// 整份设置侧栏固定列表并落盘，返回写下的列表。超过 5 个、重复或含不存在的实例报 `invalid_argument`，
/// detail.reason 为 too_many / duplicate / not_found，detail.id 为出问题的实例。
#[tauri::command]
pub async fn set_sidebar_pins(
    pins: Vec<String>,
    facade: State<'_, Facade>,
) -> Result<Vec<String>, CommandError> {
    set_sidebar_pins_with(&facade, pins).await
}

pub(crate) async fn set_sidebar_pins_with(
    facade: &Facade,
    pins: Vec<String>,
) -> Result<Vec<String>, CommandError> {
    facade
        .snapshot()
        .await
        .validate_sidebar_pins(&pins)
        .await
        .map_err(instance_error)?;
    facade
        .update(|aurora| {
            aurora.set_sidebar_pins(pins.clone());
            Ok::<_, CommandError>(())
        })
        .await?;
    Ok(pins)
}

// ---------------------------------------------------------------- 新建与补全

/// 新建实例：把原版 `id`（可选叠加加载器）安装为名为 `target_name` 的实例。长任务：进度经 core-event
/// 推送并带 `task_id`，可经 `cancel_task(taskId)` 取消，取消后实例目录整个删掉。
///
/// 名称不合法（含不分大小写重名）、加载器未知、Forge / NeoForge 没给版本号时报 `invalid_argument`
/// 或 `loader_version_not_found`，此时不登记任务。失败时实例目录保留并记下失败原因（列表里显示为
/// 未完成，可经 `repair_instance` 重试）。
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn install_version(
    app: AppHandle,
    task_id: String,
    id: String,
    loader: Option<String>,
    loader_version: Option<String>,
    target_name: String,
    facade: State<'_, Facade>,
    tasks: State<'_, TaskRegistry>,
    locks: State<'_, InstanceLocks>,
) -> Result<InstallResultDto, CommandError> {
    let events = CoreEventForwarder::to_app(&app, Some(task_id.clone()));
    let outcome = install_version_with(
        &facade,
        &tasks,
        &locks,
        &task_id,
        InstallArgs {
            mc_version: id,
            loader,
            loader_version,
            target_name,
        },
        events.sink(),
    )
    .await;
    events.finish().await;
    crate::textures::refresh_on_success(&app, &outcome).await;
    outcome
}

/// `install_version` 的参数。
pub(crate) struct InstallArgs {
    pub mc_version: String,
    pub loader: Option<String>,
    pub loader_version: Option<String>,
    pub target_name: String,
}

pub(crate) async fn install_version_with(
    facade: &Facade,
    tasks: &TaskRegistry,
    locks: &InstanceLocks,
    task_id: &str,
    args: InstallArgs,
    events: &EventSink,
) -> Result<InstallResultDto, CommandError> {
    let request = InstanceRequest {
        mc_version: args.mc_version,
        loader: args
            .loader
            .as_deref()
            .map(parse_loader_choice)
            .transpose()?,
        loader_version: args.loader_version,
    };
    request.validate()?;
    let name = args.target_name;
    let aurora = facade.snapshot().await;
    aurora
        .check_new_instance_name(&name)
        .await
        .map_err(instance_error)?;
    let _guard = locks.acquire(&name, InstanceActivity::Installing)?;
    let task = tasks.register(task_id)?;
    let aurora = aurora.with_cancel(task.token().clone());
    let marker = aurora
        .create_instance_dir(&name, &request)
        .await
        .map_err(instance_error)?;
    let outcome = task
        .run(async {
            aurora
                .install_instance(&name, &request, Some(events))
                .await
                .map_err(instance_error)
        })
        .await;
    match outcome {
        Ok(outcome) => {
            aurora
                .settle_instance_marker(&name, marker, MarkerSettlement::Succeeded)
                .await
                .map_err(instance_error)?;
            Ok(install_result_dto(outcome))
        }
        Err(err) if err.is_cancelled() => {
            if let Err(abandon_err) = aurora.abandon_instance(&name).await {
                tracing::warn!(name, error = %abandon_err, "取消后删除实例目录失败，改为记下已取消");
                settle_quietly(&aurora, &name, marker, MarkerSettlement::Cancelled).await;
            }
            Err(err)
        }
        Err(err) => {
            settle_quietly(&aurora, &name, marker, failed(&err)).await;
            Err(err)
        }
    }
}

/// 补全实例：新建没装完的照当初的内容重装，其余按现有版本 JSON 补齐缺失文件。长任务，可取消；
/// 结局写进未完成标记（成功即清除）。
#[tauri::command]
pub async fn repair_instance(
    app: AppHandle,
    task_id: String,
    id: String,
    facade: State<'_, Facade>,
    tasks: State<'_, TaskRegistry>,
    locks: State<'_, InstanceLocks>,
) -> Result<RepairResultDto, CommandError> {
    let events = CoreEventForwarder::to_app(&app, Some(task_id.clone()));
    let outcome = repair_instance_with(&facade, &tasks, &locks, &task_id, &id, events.sink()).await;
    events.finish().await;
    crate::textures::refresh_on_success(&app, &outcome).await;
    outcome
}

pub(crate) async fn repair_instance_with(
    facade: &Facade,
    tasks: &TaskRegistry,
    locks: &InstanceLocks,
    task_id: &str,
    id: &str,
    events: &EventSink,
) -> Result<RepairResultDto, CommandError> {
    let _guard = locks.acquire(id, InstanceActivity::Repairing)?;
    let task = tasks.register(task_id)?;
    let aurora = facade.snapshot().await.with_cancel(task.token().clone());
    let (plan, marker) = aurora.begin_repair(id).await.map_err(instance_error)?;
    let outcome = task
        .run(async {
            aurora
                .repair_instance(id, &plan, Some(events))
                .await
                .map_err(instance_error)
        })
        .await;
    match outcome {
        Ok(outcome) => {
            aurora
                .settle_instance_marker(id, marker, MarkerSettlement::Succeeded)
                .await
                .map_err(instance_error)?;
            Ok(repair_result_dto(outcome))
        }
        Err(err) => {
            let settlement = if err.is_cancelled() {
                MarkerSettlement::Cancelled
            } else {
                failed(&err)
            };
            settle_quietly(&aurora, id, marker, settlement).await;
            Err(err)
        }
    }
}

fn failed(err: &CommandError) -> MarkerSettlement {
    MarkerSettlement::Failed(MarkerError {
        code: err.code.to_owned(),
        message: err.message.clone(),
    })
}

/// 失败与取消后记结局：这时要返回给前端的是任务本身的错误，记结局再失败只能留日志。
async fn settle_quietly(
    aurora: &Aurora,
    id: &str,
    marker: IncompleteMarker,
    settlement: MarkerSettlement,
) {
    if let Err(err) = aurora.settle_instance_marker(id, marker, settlement).await {
        tracing::error!(id, error = %err, "记录实例未完成标记失败");
    }
}

// ---------------------------------------------------------------- 删除与改名

/// 删除前的预览：会一起删掉的存档、占用空间、依赖它的实例与它此刻在做的事。
#[tauri::command]
pub async fn preview_instance_deletion(
    id: String,
    facade: State<'_, Facade>,
    locks: State<'_, InstanceLocks>,
) -> Result<DeletionPreviewDto, CommandError> {
    let aurora = facade.snapshot().await;
    let preview = aurora.deletion_preview(&id).await.map_err(instance_error)?;
    Ok(preview_dto(preview, locks.activity(&id)))
}

/// 把实例移入回收站，并从侧栏固定、当前选中与游玩记录里去掉它。实例在忙报 `instance_busy`，被依赖报
/// `instance_has_dependents`；目录已不在时只清引用与记录、返回 `existed: false`。
#[tauri::command]
pub async fn delete_instance(
    app: AppHandle,
    id: String,
    facade: State<'_, Facade>,
    locks: State<'_, InstanceLocks>,
) -> Result<DeleteOutcomeDto, CommandError> {
    let outcome = delete_instance_with(&facade, &locks, &id, RecycleBin).await;
    crate::textures::refresh_on_success(&app, &outcome).await;
    outcome
}

pub(crate) async fn delete_instance_with(
    facade: &Facade,
    locks: &InstanceLocks,
    id: &str,
    disposer: impl Disposer + 'static,
) -> Result<DeleteOutcomeDto, CommandError> {
    let _guard = locks.acquire(id, InstanceActivity::Deleting)?;
    let snapshot = facade.snapshot().await;
    let existed = snapshot
        .delete_instance_files(id, disposer)
        .await
        .map_err(instance_error)?;
    // 目录已不在（重复删除、在启动器外删掉）时也清：残留的记录会被之后新建的同名实例继承。
    snapshot
        .forget_play_records(id)
        .await
        .map_err(instance_error)?;
    facade
        .update_if_changed(|aurora| aurora.forget_instance(id))
        .await?;
    Ok(DeleteOutcomeDto { existed })
}

/// 实例改名：目录、版本 JSON（文件名与 id）、jar、natives、游玩记录、侧栏固定与当前选中一起改。
/// 新名字按命名规则校验（报 `invalid_argument`，detail.rule 为规则码）；实例在忙报 `instance_busy`。
#[tauri::command]
pub async fn rename_instance(
    app: AppHandle,
    id: String,
    new_name: String,
    facade: State<'_, Facade>,
    locks: State<'_, InstanceLocks>,
) -> Result<RenameOutcomeDto, CommandError> {
    let outcome = rename_instance_with(&facade, &locks, &id, &new_name).await;
    crate::textures::refresh_on_success(&app, &outcome).await;
    outcome
}

pub(crate) async fn rename_instance_with(
    facade: &Facade,
    locks: &InstanceLocks,
    id: &str,
    new_name: &str,
) -> Result<RenameOutcomeDto, CommandError> {
    let _old = locks.acquire(id, InstanceActivity::Renaming)?;
    // 新名字也要占住：改名进行中，别的命令不能抢先用这个名字新建实例。只改大小写时是同一个键。
    let _new = if lock_key(id) == lock_key(new_name) {
        None
    } else {
        Some(locks.acquire(new_name, InstanceActivity::Renaming)?)
    };
    let snapshot = facade.snapshot().await;
    snapshot
        .rename_instance_files(id, new_name)
        .await
        .map_err(instance_error)?;
    // 游玩记录以实例 id 为键，不跟着挪的话改名后的实例在列表与统计里就成了从没玩过。
    snapshot
        .rename_play_records(id, new_name)
        .await
        .map_err(instance_error)?;
    facade
        .update_if_changed(|aurora| aurora.rename_instance_refs(id, new_name))
        .await?;
    Ok(RenameOutcomeDto {
        id: new_name.to_owned(),
    })
}

// ---------------------------------------------------------------- 新建页的元数据

/// 版本清单，每个版本附带可安装的加载器。断网时退回上次的缓存，并给出缓存时刻与原因。
#[tauri::command]
pub async fn list_manifest(facade: State<'_, Facade>) -> Result<ManifestDto, CommandError> {
    let aurora = facade.snapshot().await;
    Ok(manifest_dto(aurora.manifest_overview().await?))
}

/// 某加载器对某游戏版本的全部可用版本，新的在前。
#[tauri::command]
pub async fn list_loader_versions(
    loader: String,
    mc_version: String,
    facade: State<'_, Facade>,
) -> Result<Vec<LoaderVersionDto>, CommandError> {
    let choice = parse_loader_choice(&loader)?;
    let aurora = facade.snapshot().await;
    Ok(aurora
        .list_loader_versions(choice, &mc_version)
        .await?
        .into_iter()
        .map(|v| LoaderVersionDto {
            version: v.version,
            stable: v.stable,
        })
        .collect())
}

/// 新建这个游戏版本的实例需要的 Java 主版本。
#[tauri::command]
pub async fn required_java(
    mc_version: String,
    facade: State<'_, Facade>,
) -> Result<u32, CommandError> {
    let aurora = facade.snapshot().await;
    Ok(aurora.required_java(&mc_version).await?)
}

// ---------------------------------------------------------------- 打开文件夹

/// 用系统文件管理器打开一个文件夹。`target`：
/// - `game_dir`：游戏目录（不需要 `id`）；
/// - `data_dir`：启动器数据目录（配置、凭据、任务表所在，不需要 `id`）；
/// - `launcher_logs`：启动器自己的日志目录 `<数据目录>/logs`（不需要 `id`）；
/// - `instance`：实例目录 `versions/<id>`；
/// - `mods` / `saves` / `resourcepacks` / `shaderpacks` / `logs` / `screenshots`：实例工作目录下的子目录，
///   不存在时先建出来；
/// - `world`：工作目录下 `saves/<world>`，必须已存在。
///
/// 路径一律在这里按实例 id 解析，前端不传路径。
#[tauri::command]
pub async fn open_folder(
    app: AppHandle,
    target: String,
    id: Option<String>,
    world: Option<String>,
    facade: State<'_, Facade>,
) -> Result<(), CommandError> {
    let path = folder_path(&facade, &target, id.as_deref(), world.as_deref()).await?;
    let text = path.to_str().ok_or_else(|| {
        CommandError::new(code::OPEN_FAILED, "文件夹路径含无法表示的字符")
            .with_detail(json!({ "path": path.display().to_string() }))
    })?;
    tracing::info!(path = text, "打开文件夹");
    app.opener().open_path(text, None::<&str>).map_err(|err| {
        tracing::warn!(path = text, error = %err, "打开文件夹失败");
        CommandError::new(code::OPEN_FAILED, format!("打开文件夹失败：{err}"))
            .with_detail(json!({ "path": text }))
    })
}

/// 工作目录下可直接打开的子目录。
const WORKING_SUBDIRS: [&str; 6] = [
    "mods",
    "saves",
    "resourcepacks",
    "shaderpacks",
    "logs",
    "screenshots",
];

pub(crate) async fn folder_path(
    facade: &Facade,
    target: &str,
    id: Option<&str>,
    world: Option<&str>,
) -> Result<PathBuf, CommandError> {
    let aurora = facade.snapshot().await;
    let require_id =
        || id.ok_or_else(|| invalid_field("id", "missing", format!("打开 {target} 需要实例 id")));
    match target {
        "game_dir" => {
            let dir = aurora.game_dir().to_path_buf();
            ensure_dir(&dir).await?;
            Ok(dir)
        }
        "data_dir" => {
            let dir = aurora.data_dir().to_path_buf();
            ensure_dir(&dir).await?;
            Ok(dir)
        }
        "launcher_logs" => {
            let dir = aurora.data_dir().join(crate::logging::LOGS_DIR);
            ensure_dir(&dir).await?;
            Ok(dir)
        }
        "instance" => Ok(aurora
            .existing_instance_dir(require_id()?)
            .await
            .map_err(instance_error)?),
        "world" => {
            let world = world
                .ok_or_else(|| invalid_field("world", "missing", "打开存档需要存档文件夹名"))?;
            if !is_safe_instance_id(world) {
                return Err(invalid_field(
                    "world",
                    "unsafe",
                    format!("存档文件夹名不合法：{world:?}"),
                ));
            }
            let resolved = aurora
                .resolve_working_dir(require_id()?)
                .await
                .map_err(instance_error)?;
            let dir = resolved.working_dir.join("saves").join(world);
            if !dir.is_dir() {
                return Err(invalid_field(
                    "world",
                    "not_found",
                    format!("存档 {world} 不存在"),
                ));
            }
            Ok(dir)
        }
        sub if WORKING_SUBDIRS.contains(&sub) => {
            let resolved = aurora
                .resolve_working_dir(require_id()?)
                .await
                .map_err(instance_error)?;
            let dir = resolved.working_dir.join(sub);
            ensure_dir(&dir).await?;
            Ok(dir)
        }
        other => Err(invalid_field(
            "target",
            "unknown",
            format!("不认识的文件夹类型 {other}"),
        )),
    }
}

async fn ensure_dir(dir: &Path) -> Result<(), CommandError> {
    tokio::fs::create_dir_all(dir).await.map_err(|source| {
        CommandError::from(aurora_core::BaseError::Io {
            path: dir.to_path_buf(),
            source,
        })
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::{TcpListener, TcpStream};
    use std::time::{Duration, Instant};

    use aurora_core::{AuroraConfig, ConfigStore, CoreEvent, DownloadSourcePolicy};
    use wiremock::matchers::{method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    use crate::commands::error::code as common;
    use crate::tasks::CANCEL_DEADLINE;

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

    fn leftovers(dir: &Path) -> Vec<String> {
        let mut found = Vec::new();
        let mut stack = vec![dir.to_path_buf()];
        while let Some(current) = stack.pop() {
            // 安装刚开始时游戏目录还没建出来。
            let Ok(entries) = std::fs::read_dir(&current) else {
                continue;
            };
            for entry in entries.flatten() {
                let path = entry.path();
                if path.is_dir() {
                    stack.push(path);
                } else {
                    let name = entry.file_name().to_string_lossy().into_owned();
                    if name.contains(".petalfall-tmp") || name.contains(".petalfall-part") {
                        found.push(path.display().to_string());
                    }
                }
            }
        }
        found
    }

    struct Env {
        dir: tempfile::TempDir,
        facade: Arc<Facade>,
    }

    impl Env {
        fn new() -> Self {
            Self::with(|a| a)
        }

        fn with(customize: impl FnOnce(Aurora) -> Aurora) -> Self {
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
            .unwrap();
            Self {
                facade: Arc::new(Facade::new(customize(aurora))),
                dir,
            }
        }

        fn game_dir(&self) -> PathBuf {
            self.dir.path().join(".minecraft")
        }

        fn version(&self, id: &str, json: &str) -> PathBuf {
            let dir = self.game_dir().join("versions").join(id);
            std::fs::create_dir_all(&dir).unwrap();
            std::fs::write(dir.join(format!("{id}.json")), json).unwrap();
            dir
        }

        fn vanilla(&self, id: &str) -> PathBuf {
            self.version(
                id,
                &format!(r#"{{"id":"{id}","type":"release","mainClass":"M"}}"#),
            )
        }

        async fn saved_config(&self) -> AuroraConfig {
            ConfigStore::at(self.dir.path().join("config.json"))
                .load()
                .await
                .unwrap()
        }
    }

    /// 测试里不往用户回收站塞东西：直接删掉。
    struct Remove;

    impl Disposer for Remove {
        fn dispose(&self, dir: &Path) -> Result<(), InstanceError> {
            std::fs::remove_dir_all(dir).map_err(|source| InstanceError::Io {
                path: dir.to_path_buf(),
                source,
            })
        }
    }

    fn args(name: &str) -> InstallArgs {
        InstallArgs {
            mc_version: "1.21.1".into(),
            loader: None,
            loader_version: None,
            target_name: name.into(),
        }
    }

    /// 端到端：install_version 在客户端 jar 下载卡住时被取消，1000 ms 内以 cancelled 返回，
    /// 新建到一半的实例目录整个删掉，期间推送的事件都带本任务的 task_id，任务与实例占用随之释放。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn cancel_task_stops_install_within_deadline_and_cleans_up() {
        let server = MockServer::start().await;
        let slow = stalling_server();
        Mock::given(method("GET"))
            .and(path("/manifest.json"))
            .respond_with(ResponseTemplate::new(200).set_body_string(format!(
                r#"{{"latest":{{"release":"slow","snapshot":"slow"}},
                    "versions":[{{"id":"slow","type":"release","url":"{}/slow.json",
                    "time":"t","releaseTime":"t"}}]}}"#,
                server.uri()
            )))
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path("/slow.json"))
            .respond_with(ResponseTemplate::new(200).set_body_string(format!(
                r#"{{"id":"slow","type":"release","mainClass":"net.minecraft.client.main.Main",
                    "downloads":{{"client":{{"sha1":"0000000000000000000000000000000000000000",
                    "size":1048576,"url":"{slow}/client.jar"}}}}}}"#
            )))
            .mount(&server)
            .await;

        let uri = server.uri();
        let env = Env::with(|a| a.with_manifest_url(format!("{uri}/manifest.json")));
        let registry = Arc::new(TaskRegistry::default());
        let locks = InstanceLocks::default();

        let delivered = Arc::new(Mutex::new(Vec::new()));
        let log = delivered.clone();
        let forwarder = CoreEventForwarder::spawn(Some("install-slow".into()), move |p| {
            log.lock().unwrap().push(p)
        });
        let sink = forwarder.sink().clone();
        let (f, r, l) = (env.facade.clone(), registry.clone(), locks.clone());
        let install = tokio::spawn(async move {
            let request = InstallArgs {
                mc_version: "slow".into(),
                ..args("慢慢装")
            };
            install_version_with(&f, &r, &l, "install-slow", request, &sink).await
        });

        // 等到客户端 jar 的临时文件已经写进 64 KiB，现场才算造好。
        let game_dir = env.game_dir();
        let deadline = Instant::now() + Duration::from_secs(10);
        while leftovers(&game_dir).is_empty() {
            assert!(Instant::now() < deadline, "客户端 jar 下载没有开始");
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        assert!(registry.is_running("install-slow"));
        assert_eq!(locks.activity("慢慢装"), Some(InstanceActivity::Installing));

        let cancelled_at = Instant::now();
        assert!(registry.cancel("install-slow"));
        let err = install.await.unwrap().unwrap_err();
        let elapsed = cancelled_at.elapsed();
        forwarder.finish().await;

        assert_eq!(err.code, common::CANCELLED);
        assert!(elapsed < CANCEL_DEADLINE, "取消到返回耗时 {elapsed:?}");
        assert!(
            leftovers(&game_dir).is_empty(),
            "残留：{:?}",
            leftovers(&game_dir)
        );
        assert!(
            !game_dir.join("versions").join("慢慢装").exists(),
            "取消后实例目录应删除"
        );
        assert!(!registry.is_running("install-slow"), "任务应已注销");
        assert_eq!(locks.activity("慢慢装"), None, "实例占用应已释放");

        let delivered = delivered.lock().unwrap();
        assert!(!delivered.is_empty(), "安装过程应推送过事件");
        assert!(delivered
            .iter()
            .all(|p| p.task_id.as_deref() == Some("install-slow")));
    }

    #[tokio::test]
    async fn install_rejects_bad_names_and_loaders_before_registering() {
        let env = Env::new();
        env.vanilla("Survival");
        let registry = TaskRegistry::default();
        let locks = InstanceLocks::default();
        let (sink, _rx) = tokio::sync::mpsc::unbounded_channel::<CoreEvent>();

        for (name, rule) in [
            ("CON", "reserved"),
            ("com1", "reserved"),
            ("生存 ", "reserved"),
            ("survival", "duplicate"),
            ("a/b", "illegal_char"),
            ("", "empty"),
            (".hidden", "leading_dot"),
        ] {
            let err = install_version_with(&env.facade, &registry, &locks, "t", args(name), &sink)
                .await
                .unwrap_err();
            assert_eq!(err.code, common::INVALID_ARGUMENT, "{name:?}");
            let detail = err.detail.unwrap();
            assert_eq!(detail["field"], "name", "{name:?}");
            assert_eq!(detail["rule"], rule, "{name:?}");
            assert!(!registry.is_running("t"));
        }

        let rift = InstallArgs {
            loader: Some("rift".into()),
            ..args("新的")
        };
        let err = install_version_with(&env.facade, &registry, &locks, "t", rift, &sink)
            .await
            .unwrap_err();
        assert_eq!(err.code, common::INVALID_ARGUMENT);
        assert_eq!(err.detail.unwrap()["field"], "loader");

        let forge = InstallArgs {
            loader: Some("forge".into()),
            ..args("新的")
        };
        let err = install_version_with(&env.facade, &registry, &locks, "t", forge, &sink)
            .await
            .unwrap_err();
        assert_eq!(err.code, common::LOADER_VERSION_NOT_FOUND);
        assert!(!env.game_dir().join("versions").join("新的").exists());
    }

    #[tokio::test]
    async fn install_into_a_busy_name_is_refused() {
        let env = Env::new();
        let registry = TaskRegistry::default();
        let locks = InstanceLocks::default();
        let (sink, _rx) = tokio::sync::mpsc::unbounded_channel::<CoreEvent>();
        let _held = locks.acquire("撞名", InstanceActivity::Renaming).unwrap();
        let err = install_version_with(&env.facade, &registry, &locks, "t", args("撞名"), &sink)
            .await
            .unwrap_err();
        assert_eq!(err.code, code::INSTANCE_BUSY);
        assert_eq!(err.detail.unwrap()["activity"], "renaming");
        assert!(!registry.is_running("t"));
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn failed_install_keeps_the_instance_with_a_failed_marker() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/manifest.json"))
            .respond_with(
                ResponseTemplate::new(200)
                    .set_body_string(r#"{"latest":{"release":"a","snapshot":"a"},"versions":[]}"#),
            )
            .mount(&server)
            .await;
        let uri = server.uri();
        let env = Env::with(|a| a.with_manifest_url(format!("{uri}/manifest.json")));
        let (sink, _rx) = tokio::sync::mpsc::unbounded_channel::<CoreEvent>();
        let err = install_version_with(
            &env.facade,
            &TaskRegistry::default(),
            &InstanceLocks::default(),
            "t",
            args("没装完"),
            &sink,
        )
        .await
        .unwrap_err();
        assert_eq!(err.code, common::INSTALL_FAILED);

        let list = list_instances_with(&env.facade, &InstanceLocks::default())
            .await
            .unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].id, "没装完");
        assert_eq!(list[0].status, "broken");
        let incomplete = list[0].incomplete.as_ref().unwrap();
        assert_eq!(incomplete.kind, "install");
        assert_eq!(incomplete.outcome, "failed");
        assert_eq!(incomplete.error.as_ref().unwrap().code, "install_failed");
        assert_eq!(incomplete.spec.as_ref().unwrap().mc_version, "1.21.1");
    }

    #[tokio::test]
    async fn repair_writes_then_clears_the_marker() {
        let env = Env::new();
        let dir = env.vanilla("1.21.1");
        let registry = TaskRegistry::default();
        let locks = InstanceLocks::default();
        let (sink, mut rx) = tokio::sync::mpsc::unbounded_channel::<CoreEvent>();

        let outcome = repair_instance_with(&env.facade, &registry, &locks, "r1", "1.21.1", &sink)
            .await
            .unwrap();
        assert!(!outcome.reinstalled);
        assert!(dir.is_dir());
        let list = list_instances_with(&env.facade, &locks).await.unwrap();
        assert_eq!(list[0].incomplete, None, "补全成功后标记清除");
        let mut saw_marker_stage = false;
        while let Ok(event) = rx.try_recv() {
            if let CoreEvent::Stage(message) = event {
                saw_marker_stage |= message.contains("补全");
            }
        }
        assert!(saw_marker_stage, "补全过程应推送阶段事件");

        // 补全失败（版本 JSON 引用了下不到的库）时标记留下并记为失败。
        env.version(
            "坏库",
            r#"{"id":"坏库","type":"release","mainClass":"M",
                "libraries":[{"name":"a:b:1","downloads":{"artifact":{"path":"a/b/1/b-1.jar",
                "sha1":"0000000000000000000000000000000000000000","size":1,
                "url":"http://127.0.0.1:9/b-1.jar"}}}]}"#,
        );
        let err = repair_instance_with(&env.facade, &registry, &locks, "r2", "坏库", &sink)
            .await
            .unwrap_err();
        assert_ne!(err.code, common::CANCELLED);
        let list = list_instances_with(&env.facade, &locks).await.unwrap();
        let broken = list.iter().find(|i| i.id == "坏库").unwrap();
        let incomplete = broken.incomplete.as_ref().unwrap();
        assert_eq!((incomplete.kind, incomplete.outcome), ("repair", "failed"));
        assert_eq!(incomplete.error.as_ref().unwrap().code, err.code);
        assert_eq!(locks.activity("坏库"), None);
    }

    #[tokio::test]
    async fn repair_of_a_running_instance_is_refused() {
        let env = Env::new();
        env.vanilla("1.21.1");
        let locks = InstanceLocks::default();
        let _running = locks.acquire("1.21.1", InstanceActivity::Running).unwrap();
        let (sink, _rx) = tokio::sync::mpsc::unbounded_channel::<CoreEvent>();
        let err = repair_instance_with(
            &env.facade,
            &TaskRegistry::default(),
            &locks,
            "r",
            "1.21.1",
            &sink,
        )
        .await
        .unwrap_err();
        assert_eq!(err.code, code::INSTANCE_BUSY);
    }

    #[tokio::test]
    async fn delete_removes_the_directory_and_prunes_pins_and_selection_on_disk() {
        let env = Env::new();
        let dir = env.vanilla("旧档");
        env.vanilla("留下");
        env.facade
            .update(|aurora| {
                aurora.set_sidebar_pins(vec!["旧档".into(), "留下".into()]);
                aurora.set_selected_version(Some("旧档".into()));
                Ok::<_, CommandError>(())
            })
            .await
            .unwrap();
        let locks = InstanceLocks::default();

        let preview = preview_dto(
            env.facade
                .snapshot()
                .await
                .deletion_preview("旧档")
                .await
                .unwrap(),
            locks.activity("旧档"),
        );
        assert!(preview.dependents.is_empty());
        assert_eq!(preview.activity, None);

        let outcome = delete_instance_with(&env.facade, &locks, "旧档", Remove)
            .await
            .unwrap();
        assert!(outcome.existed);
        assert!(!dir.exists());
        let saved = env.saved_config().await;
        assert_eq!(saved.sidebar_pins, vec!["留下".to_owned()]);
        assert_eq!(saved.selected_version, None);
        assert_eq!(
            get_pins(&env).await,
            vec!["留下".to_owned()],
            "门面里的配置同步更新"
        );

        let again = delete_instance_with(&env.facade, &locks, "旧档", Remove)
            .await
            .unwrap();
        assert!(!again.existed);
    }

    async fn get_pins(env: &Env) -> Vec<String> {
        env.facade
            .snapshot()
            .await
            .existing_sidebar_pins()
            .await
            .unwrap()
    }

    #[tokio::test]
    async fn delete_is_refused_while_running_or_depended_on() {
        let env = Env::new();
        let dir = env.vanilla("1.21.1");
        env.version(
            "fab",
            r#"{"id":"fab","inheritsFrom":"1.21.1","type":"release","mainClass":"K"}"#,
        );
        let locks = InstanceLocks::default();

        let err = delete_instance_with(&env.facade, &locks, "1.21.1", Remove)
            .await
            .unwrap_err();
        assert_eq!(err.code, code::INSTANCE_HAS_DEPENDENTS);
        assert_eq!(err.detail.unwrap()["dependents"], json!(["fab"]));

        let running = locks.acquire("FAB", InstanceActivity::Running).unwrap();
        let err = delete_instance_with(&env.facade, &locks, "fab", Remove)
            .await
            .unwrap_err();
        assert_eq!(err.code, code::INSTANCE_BUSY);
        assert_eq!(err.detail.unwrap()["activity"], "running");
        drop(running);
        assert!(dir.exists());
        delete_instance_with(&env.facade, &locks, "fab", Remove)
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn rename_syncs_directory_json_jar_pins_and_selection() {
        let env = Env::new();
        let dir = env.vanilla("1.21.1");
        std::fs::write(dir.join("1.21.1.jar"), b"jar").unwrap();
        env.facade
            .update(|aurora| {
                aurora.set_sidebar_pins(vec!["1.21.1".into()]);
                aurora.set_selected_version(Some("1.21.1".into()));
                Ok::<_, CommandError>(())
            })
            .await
            .unwrap();
        let locks = InstanceLocks::default();

        let outcome = rename_instance_with(&env.facade, &locks, "1.21.1", "生存")
            .await
            .unwrap();
        assert_eq!(outcome.id, "生存");
        let new_dir = env.game_dir().join("versions").join("生存");
        assert!(!dir.exists());
        assert_eq!(std::fs::read(new_dir.join("生存.jar")).unwrap(), b"jar");
        let json: Value =
            serde_json::from_slice(&std::fs::read(new_dir.join("生存.json")).unwrap()).unwrap();
        assert_eq!(json["id"], "生存");
        let saved = env.saved_config().await;
        assert_eq!(saved.sidebar_pins, vec!["生存".to_owned()]);
        assert_eq!(saved.selected_version.as_deref(), Some("生存"));
        assert_eq!(locks.activity("生存"), None);
        assert_eq!(locks.activity("1.21.1"), None);

        let list = list_instances_with(&env.facade, &locks).await.unwrap();
        assert_eq!(list[0].id, "生存");
        assert_eq!(list[0].mc_version.as_deref(), Some("1.21.1"));
    }

    fn write_playtime(env: &Env, json: &str) {
        std::fs::write(
            env.dir.path().join(aurora_core::playtime::PLAYTIME_FILE),
            json,
        )
        .unwrap();
    }

    /// 改名后游玩记录跟着新名字走，列表与统计都不再出现旧名；删掉后再建同名实例从零开始。
    #[tokio::test]
    async fn rename_and_delete_carry_or_drop_the_play_records() {
        let env = Env::new();
        env.vanilla("周末生存");
        // 周末生存玩过 90 分钟（10 月 30 日），另一个实例 10 分钟。
        write_playtime(
            &env,
            r#"{"format":1,"book":{
                "instances":{"周末生存":{"total_ms":5400000,"last_played_at":1761832800000},
                             "别的":{"total_ms":600000,"last_played_at":1761800000000}},
                "days":{"2026-10-30":{"instances":{"周末生存":5400000,"别的":600000}}}}}"#,
        );
        let locks = InstanceLocks::default();

        rename_instance_with(&env.facade, &locks, "周末生存", "生存服")
            .await
            .unwrap();
        let list = list_instances_with(&env.facade, &locks).await.unwrap();
        let renamed = list.iter().find(|i| i.id == "生存服").unwrap();
        assert_eq!(renamed.playtime_min, 90);
        assert_eq!(renamed.last_played_at, Some(1_761_832_800_000));
        let stats = env
            .facade
            .snapshot()
            .await
            .play_stats(aurora_core::PlayRange::parse("2026-10-30", "2026-10-30").unwrap())
            .await
            .unwrap();
        let ids: Vec<&str> = stats
            .instances
            .iter()
            .map(|i| i.version_id.as_str())
            .collect();
        assert_eq!(ids, vec!["生存服", "别的"]);
        assert_eq!(stats.total_minutes, 100);

        delete_instance_with(&env.facade, &locks, "生存服", Remove)
            .await
            .unwrap();
        env.vanilla("生存服");
        let list = list_instances_with(&env.facade, &locks).await.unwrap();
        let fresh = list.iter().find(|i| i.id == "生存服").unwrap();
        assert_eq!(fresh.playtime_min, 0, "同名新实例不继承被删实例的时长");
        assert_eq!(fresh.last_played_at, None);
        let summaries = env.facade.snapshot().await.play_summaries().await.unwrap();
        assert_eq!(summaries.keys().collect::<Vec<_>>(), vec!["别的"]);
    }

    /// 游玩记录读不出来时改名照样把文件改完，但命令报错，不假装一切正常。
    #[tokio::test]
    async fn rename_reports_unreadable_play_records() {
        let env = Env::new();
        let dir = env.vanilla("a");
        write_playtime(&env, "{ broken");
        let locks = InstanceLocks::default();
        let err = rename_instance_with(&env.facade, &locks, "a", "b")
            .await
            .unwrap_err();
        assert_eq!(err.code, common::INSTANCE_FAILED);
        assert!(!dir.exists());
        assert!(env.game_dir().join("versions").join("b").is_dir());
        assert_eq!(locks.activity("b"), None);
    }

    #[tokio::test]
    async fn rename_is_refused_while_running_and_for_invalid_names() {
        let env = Env::new();
        let dir = env.vanilla("a");
        env.vanilla("B");
        let locks = InstanceLocks::default();

        let running = locks.acquire("a", InstanceActivity::Running).unwrap();
        let err = rename_instance_with(&env.facade, &locks, "a", "c")
            .await
            .unwrap_err();
        assert_eq!(err.code, code::INSTANCE_BUSY);
        assert!(dir.exists());
        drop(running);

        // 目标名正被别的操作占着（比如正在新建同名实例）。
        let installing = locks.acquire("c", InstanceActivity::Installing).unwrap();
        let err = rename_instance_with(&env.facade, &locks, "a", "C")
            .await
            .unwrap_err();
        assert_eq!(err.code, code::INSTANCE_BUSY);
        drop(installing);
        assert_eq!(locks.activity("a"), None, "失败时已占的旧名也要释放");

        let err = rename_instance_with(&env.facade, &locks, "a", "b")
            .await
            .unwrap_err();
        assert_eq!(err.code, common::INVALID_ARGUMENT);
        assert_eq!(err.detail.unwrap()["rule"], "duplicate");
        let err = rename_instance_with(&env.facade, &locks, "../a", "x")
            .await
            .unwrap_err();
        assert_eq!(err.code, common::INVALID_ARGUMENT);
        assert_eq!(err.detail.unwrap()["reason"], "unsafe_id");
        assert!(dir.join("a.json").is_file());
    }

    #[tokio::test]
    async fn sidebar_pins_reject_a_sixth_entry_duplicates_and_unknown_ids() {
        let env = Env::new();
        let ids: Vec<String> = (1..=6).map(|i| format!("i{i}")).collect();
        for id in &ids {
            env.vanilla(id);
        }
        let reason = |err: CommandError| {
            assert_eq!(err.code, common::INVALID_ARGUMENT);
            let detail = err.detail.unwrap();
            assert_eq!(detail["field"], "pins");
            (detail["reason"].clone(), detail["id"].clone())
        };

        let err = set_sidebar_pins_with(&env.facade, ids.clone())
            .await
            .unwrap_err();
        assert_eq!(reason(err), (json!("too_many"), Value::Null));
        let err = set_sidebar_pins_with(&env.facade, vec!["i1".into(), "i1".into()])
            .await
            .unwrap_err();
        assert_eq!(reason(err), (json!("duplicate"), json!("i1")));
        let err = set_sidebar_pins_with(&env.facade, vec!["i1".into(), "ghost".into()])
            .await
            .unwrap_err();
        assert_eq!(reason(err), (json!("not_found"), json!("ghost")));
        assert!(
            env.saved_config().await.sidebar_pins.is_empty(),
            "失败时不落盘"
        );

        let five = ids[..5].to_vec();
        assert_eq!(
            set_sidebar_pins_with(&env.facade, five.clone())
                .await
                .unwrap(),
            five
        );
        assert_eq!(env.saved_config().await.sidebar_pins, five);
    }

    #[tokio::test]
    async fn settings_are_written_whole_and_unknown_or_invalid_fields_are_rejected() {
        let env = Env::new();
        env.vanilla("1.21.1");
        let settings = json!({
            "description": "和朋友的周末",
            "cover": "cherry_planks",
            "isolation": "enabled",
            "memory_mb": 6144,
            "java": "auto",
            "jvm_args": "-XX:+UseG1GC",
            "resolution": { "width": 1920, "height": 1080 },
            "fullscreen": false
        });
        let saved = set_instance_settings_with(&env.facade, "1.21.1", settings.clone())
            .await
            .unwrap();
        assert_eq!(serde_json::to_value(&saved).unwrap(), settings);

        let mut unknown = settings.clone();
        unknown["colour"] = json!("pink");
        let err = set_instance_settings_with(&env.facade, "1.21.1", unknown)
            .await
            .unwrap_err();
        assert_eq!(err.code, common::INVALID_ARGUMENT);
        assert_eq!(err.detail.unwrap()["field"], "settings");

        let mut bad_memory = settings.clone();
        bad_memory["memory_mb"] = json!(1000);
        let err = set_instance_settings_with(&env.facade, "1.21.1", bad_memory)
            .await
            .unwrap_err();
        assert_eq!(err.code, common::INVALID_ARGUMENT);
        assert_eq!(err.detail.unwrap()["field"], "memory_mb");

        let stored = env
            .facade
            .snapshot()
            .await
            .instance_settings("1.21.1")
            .await
            .unwrap();
        assert_eq!(stored.memory_mb, Some(6144), "非法写入不改动文件");

        let err = set_instance_settings_with(&env.facade, "不存在", settings)
            .await
            .unwrap_err();
        assert_eq!(err.code, common::VERSION_NOT_INSTALLED);
    }

    #[tokio::test]
    async fn list_reports_activity_and_lowercase_loader_kinds() {
        let env = Env::new();
        env.vanilla("1.21.1");
        env.version(
            "fab",
            r#"{"id":"fab","inheritsFrom":"1.21.1","type":"release",
                "mainClass":"net.fabricmc.loader.impl.launch.knot.KnotClient",
                "libraries":[{"name":"net.fabricmc:fabric-loader:0.16.10"}]}"#,
        );
        // fab 玩过 121 分 59 秒：分钟向下取整为 121；1.21.1 没玩过。
        std::fs::write(
            env.dir.path().join(aurora_core::playtime::PLAYTIME_FILE),
            r#"{"format":1,"book":{"instances":{"fab":{"total_ms":7319000,"last_played_at":1767225600000}},"days":{}}}"#,
        )
        .unwrap();
        let locks = InstanceLocks::default();
        let _guard = locks.acquire("fab", InstanceActivity::Launching).unwrap();
        let list = list_instances_with(&env.facade, &locks).await.unwrap();
        let fab = list.iter().find(|i| i.id == "fab").unwrap();
        assert_eq!(fab.activity, Some(InstanceActivity::Launching));
        assert_eq!(
            fab.loaders,
            vec![LoaderDto {
                kind: "fabric",
                version: Some("0.16.10".into())
            }]
        );
        assert_eq!(fab.mc_version.as_deref(), Some("1.21.1"));
        assert_eq!(fab.status, "ready");
        assert_eq!(fab.playtime_min, 121);
        assert_eq!(fab.last_played_at, Some(1_767_225_600_000));
        let vanilla = list.iter().find(|i| i.id == "1.21.1").unwrap();
        assert_eq!(vanilla.activity, None);
        assert_eq!(vanilla.mod_count, Some(0));
        assert_eq!(vanilla.playtime_min, 0);
        assert_eq!(vanilla.last_played_at, None);
    }

    /// 导入中断留下的整合包标记在列表里报为 modpack，而不是「标记读不出来」。
    #[tokio::test]
    async fn interrupted_modpack_import_lists_as_modpack_incomplete() {
        let env = Env::new();
        let dir = env.vanilla("整合包");
        aurora_core::MarkerStore::for_version_dir(&dir)
            .save(&IncompleteMarker::pending(
                IncompleteKind::Modpack {
                    task_id: "mp#1".into(),
                },
                1_700_000_000_000,
            ))
            .await
            .unwrap();
        let list = list_instances_with(&env.facade, &InstanceLocks::default())
            .await
            .unwrap();
        let pack = list.iter().find(|i| i.id == "整合包").unwrap();
        assert_eq!(
            pack.incomplete,
            Some(IncompleteDto {
                kind: "modpack",
                outcome: "pending",
                started_at: Some(1_700_000_000_000),
                spec: None,
                error: None,
            })
        );
    }

    #[tokio::test]
    async fn folder_paths_resolve_in_rust_and_reject_bad_input() {
        let env = Env::new();
        let dir = env.vanilla("1.21.1");
        let facade = &env.facade;

        assert_eq!(
            folder_path(facade, "game_dir", None, None).await.unwrap(),
            env.game_dir()
        );
        assert_eq!(
            folder_path(facade, "data_dir", None, None).await.unwrap(),
            env.dir.path()
        );
        // 启动器日志目录还没写过日志时也先建出来，资源管理器打得开。
        let logs = folder_path(facade, "launcher_logs", None, None)
            .await
            .unwrap();
        assert_eq!(logs, env.dir.path().join("logs"));
        assert!(logs.is_dir());
        assert_eq!(
            folder_path(facade, "launcher_logs", Some("1.21.1"), None)
                .await
                .unwrap(),
            logs,
            "不需要实例的目标忽略 id"
        );
        assert_eq!(
            folder_path(facade, "instance", Some("1.21.1"), None)
                .await
                .unwrap(),
            dir
        );
        // 原版正式版默认不隔离：mods 在游戏目录下，打开前建出来。
        let mods = folder_path(facade, "mods", Some("1.21.1"), None)
            .await
            .unwrap();
        assert_eq!(mods, env.game_dir().join("mods"));
        assert!(mods.is_dir());

        std::fs::create_dir_all(env.game_dir().join("saves").join("w1")).unwrap();
        assert_eq!(
            folder_path(facade, "world", Some("1.21.1"), Some("w1"))
                .await
                .unwrap(),
            env.game_dir().join("saves").join("w1")
        );
        let field = |err: CommandError| {
            assert_eq!(err.code, common::INVALID_ARGUMENT);
            let detail = err.detail.unwrap();
            (detail["field"].clone(), detail["reason"].clone())
        };
        let err = folder_path(facade, "world", Some("1.21.1"), Some("..\\x"))
            .await
            .unwrap_err();
        assert_eq!(field(err), (json!("world"), json!("unsafe")));
        let err = folder_path(facade, "world", Some("1.21.1"), Some("w9"))
            .await
            .unwrap_err();
        assert_eq!(field(err), (json!("world"), json!("not_found")));
        let err = folder_path(facade, "mods", None, None).await.unwrap_err();
        assert_eq!(field(err), (json!("id"), json!("missing")));
        let err = folder_path(facade, "desktop", None, None)
            .await
            .unwrap_err();
        assert_eq!(field(err), (json!("target"), json!("unknown")));
        let err = folder_path(facade, "instance", Some("ghost"), None)
            .await
            .unwrap_err();
        assert_eq!(err.code, common::VERSION_NOT_INSTALLED);
    }

    #[test]
    fn locks_are_case_insensitive_and_released_on_drop() {
        let locks = InstanceLocks::default();
        let guard = locks
            .acquire("Survival", InstanceActivity::Launching)
            .unwrap();
        let err = locks
            .acquire("survival", InstanceActivity::Deleting)
            .err()
            .unwrap();
        assert_eq!(err.code, code::INSTANCE_BUSY);
        assert_eq!(err.detail.unwrap()["activity"], "launching");
        guard.set_activity(InstanceActivity::Running);
        assert_eq!(locks.activity("SURVIVAL"), Some(InstanceActivity::Running));
        drop(guard);
        assert_eq!(locks.activity("Survival"), None);
        locks
            .acquire("survival", InstanceActivity::Deleting)
            .unwrap();
    }

    /// Mod 与资源改动彼此并行、与启动和运行并行，与改名、删除、新建、补全两个方向都互斥；
    /// 每个守卫只释放自己那一份，最后一份放掉后实例才空闲。
    #[test]
    fn modifying_is_shared_with_itself_and_the_running_game_but_excludes_the_rest() {
        use InstanceActivity::*;
        let exclusive = [Installing, Repairing, Renaming, Deleting];
        let locks = InstanceLocks::default();

        let first = locks.acquire("Pack", Modifying).unwrap();
        let second = locks.acquire("pack", Modifying).unwrap();
        assert_eq!(locks.activity("PACK"), Some(Modifying));
        for activity in exclusive {
            let err = locks.acquire("pack", activity).err().unwrap();
            assert_eq!(err.code, code::INSTANCE_BUSY, "{activity:?}");
            assert_eq!(err.detail.unwrap()["activity"], "modifying");
        }
        let game = locks.acquire("pack", Launching).unwrap();
        game.set_activity(Running);
        assert_eq!(
            locks.activity("pack"),
            Some(Running),
            "并行时报运行而不是改动"
        );
        let err = locks.acquire("pack", Launching).err().unwrap();
        assert_eq!(err.detail.unwrap()["activity"], "running");

        drop(first);
        drop(game);
        assert_eq!(locks.activity("pack"), Some(Modifying), "还剩一份改动");
        assert!(locks.acquire("pack", Renaming).is_err());
        drop(second);
        assert_eq!(locks.activity("pack"), None);

        for activity in exclusive {
            let held = locks.acquire("pack", activity).unwrap();
            let err = locks.acquire("pack", Modifying).err().unwrap();
            assert_eq!(err.code, code::INSTANCE_BUSY, "{activity:?}");
            drop(held);
        }
        let running = locks.acquire("pack", Running).unwrap();
        let modifying = locks.acquire("pack", Modifying).unwrap();
        drop(running);
        drop(modifying);
        assert_eq!(locks.activity("pack"), None);
    }

    #[test]
    fn manifest_versions_carry_their_loaders_in_fixed_order() {
        let manifest: aurora_core::VersionManifest = serde_json::from_str(
            r#"{"latest":{"release":"1.21.1","snapshot":"24w14a"},"versions":[
                {"id":"1.21.1","type":"release","url":"u","time":"t","releaseTime":"r1"},
                {"id":"24w14a","type":"snapshot","url":"u","time":"t","releaseTime":"r2"}]}"#,
        )
        .unwrap();
        let overview = ManifestOverview {
            manifest,
            loaders: HashMap::from([(
                "1.21.1".to_owned(),
                vec![LoaderChoice::Fabric, LoaderChoice::NeoForge],
            )]),
            loader_errors: vec![(LoaderChoice::Forge, "连不上".to_owned())],
            stale_since: Some(7),
            fetch_error: Some("断网".into()),
        };
        let dto = manifest_dto(overview);
        assert_eq!(dto.versions[0].loaders, vec!["fabric", "neoforge"]);
        assert!(dto.versions[1].loaders.is_empty());
        assert_eq!(dto.loader_errors[0].loader, "forge");
        assert_eq!(dto.stale_since, Some(7));
        assert_eq!(dto.latest.snapshot, "24w14a");
    }
}
