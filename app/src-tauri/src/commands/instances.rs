//! 实例：列表、设置、内容、侧栏固定、新建（按实例名安装）、补全、删除、改名、打开文件夹、存档备份与恢复，
//! 以及新建页要的版本清单、加载器版本与所需 Java。
//!
//! 会改动实例目录的操作（新建、整合包导入、补全、改名、删除，启动与运行中的游戏，装、删、启停、
//! 更新、回滚 Mod 与装资源，以及备份、恢复、导出存档）经 [`InstanceLocks`] 互斥，冲突时报 `instance_busy`
//! 并在 detail 里带上正在做的事。Mod 与资源的改动彼此之间、与启动和运行中的游戏、与存档备份之间可以并行
//! （运行中改不了的文件由门面的占用探测把关），与其余操作互斥。

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use aurora_core::{
    is_safe_instance_id, Aurora, BackupKind, CoreError, DeletionPreview, Disposer, EventSink,
    GameSlot, IncompleteKind, IncompleteMarker, IncompleteOutcome, InstanceContent, InstanceError,
    InstanceInstallOutcome, InstanceRequest, InstanceSummary, InstanceVersion, IsolationOverride,
    JavaSelection, LevelInfo, LoaderChoice, LoaderKind, ManifestOverview, MarkerError,
    MarkerSettlement, PackEntry, Platform, PlaySummary, Readable, RecycleBin, RepairOutcome,
    Resolution, VersionSettings, WorldBackup, WorldBackupList, WorldEntry, WorldScope,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, State};
use tauri_plugin_opener::OpenerExt;

use crate::commands::launch::RunningGame;
use crate::commands::CommandError;
use crate::events::CoreEventForwarder;
use crate::facade::Facade;
use crate::tasks::{TaskHandle, TaskRegistry};

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
    /// 装、删、启停、更新、回滚 Mod，往实例里装资源包、光影、数据包，查更新时回写卷宗，写实例设置，
    /// 或为打开文件夹建出工作目录下的子目录。
    Modifying,
    /// 备份、恢复或导出存档；游戏退出后的自动备份由启动命令把「运行」转成它，备份完才释放。
    BackingUp,
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
            InstanceActivity::Modifying => "改动 Mod、资源或设置",
            InstanceActivity::BackingUp => "备份或恢复存档",
        }
    }

    /// 两件事能否同时在一个实例上进行。
    ///
    /// Mod、资源与设置的改动只往实例目录里加删、改写文件，彼此不冲突；游戏运行中仍允许改动，
    /// 被游戏占着的文件由门面在动手前探测并拒绝。改名、删除、新建、补全会挪走或重写整个目录，
    /// 与任何事都互斥，否则改动会按旧路径把目录重新建出来。
    ///
    /// 备份与恢复只碰 saves 下的一个存档与游戏目录里的备份区，和 Mod 改动不相交；游戏开着时存档随时在写，
    /// 打包出来的是半截，恢复则会被游戏下次保存覆盖，所以与启动、运行互斥。它与「运行」的兼容集合相同，
    /// 游戏退出后可以原地从「运行」转成它。
    fn compatible_with(self, other: Self) -> bool {
        use InstanceActivity::{BackingUp, Launching, Modifying, Running};
        matches!(
            (self, other),
            (Modifying, Modifying | Launching | Running | BackingUp)
                | (Launching | Running | BackingUp, Modifying)
        )
    }

    /// 同一实例上有几件事并行时，对外报哪一件：Mod 改动排在最后，界面关心的是启动、运行与备份。
    fn report_rank(self) -> u8 {
        match self {
            InstanceActivity::Modifying => 1,
            InstanceActivity::Installing
            | InstanceActivity::Repairing
            | InstanceActivity::Renaming
            | InstanceActivity::Deleting
            | InstanceActivity::Launching
            | InstanceActivity::Running
            | InstanceActivity::BackingUp => 0,
        }
    }
}

/// 一个实例上的全部占用。`next` 给每次占用发一个号，守卫凭号释放自己那一份。`ids` 记下每个键第一次占用时
/// 的原样 id：按活动找实例时要拿它去解析工作目录、写进 `instance_busy` 的 detail，不能用小写键代替。
#[derive(Default)]
struct LockTable {
    next: u64,
    held: HashMap<String, Vec<(u64, InstanceActivity)>>,
    ids: HashMap<String, String>,
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
        table
            .ids
            .entry(key.clone())
            .or_insert_with(|| id.to_owned());
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

    /// 此刻占着 `activity` 的实例（原样的 id）。
    pub fn holding(&self, activity: InstanceActivity) -> Vec<String> {
        let table = lock_table(&self.table);
        table
            .held
            .iter()
            .filter(|(_, holds)| holds.iter().any(|&(_, current)| current == activity))
            .map(|(key, _)| {
                table
                    .ids
                    .get(key)
                    .expect("有占用的键一定记着原样 id")
                    .clone()
            })
            .collect()
    }
}

/// 一次实例占用；丢弃即释放。
pub struct InstanceGuard {
    table: Arc<Mutex<LockTable>>,
    key: String,
    token: u64,
}

impl InstanceGuard {
    /// 改记正在做的事（启动成功后由「启动」转为「运行」，游戏退出后由「运行」转为「备份」）。只用于
    /// 兼容关系相同的两件事之间转换，所以不重新检查冲突。
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
                table.ids.remove(&self.key);
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

/// 实例领域的门面错误：依赖冲突单独成码，其余照通用映射（参数类问题在那里统一报 `invalid_argument`），
/// 并补上实例 id 等定位信息。
fn instance_error(err: CoreError) -> CommandError {
    let message = err.to_string();
    let (code, detail) = match &err {
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

/// 实例所来自的整合包。
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct InstanceModpackDto {
    /// modrinth / curseforge；从本地文件导入时为 null。
    pub platform: Option<Platform>,
    pub project_id: Option<String>,
    pub version_id: Option<String>,
    /// 整合包自己的名字与版本（实例名可以被改成别的）。
    pub name: String,
    pub version: Option<String>,
}

/// 新建某个游戏版本前要知道的 Java 与下载体积。
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct VersionRequirementsDto {
    pub java_major: u32,
    /// 全新下载的字节数（客户端、本机适用的库、资源索引与资源文件、日志配置），不含 Java 与加载器、
    /// 不扣除本地已有的文件；版本 JSON 有一项没标大小时为 null。
    pub download_bytes: Option<u64>,
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
    /// 支持哪些直达方式；继承链断了或 broken 时为 null。
    pub quick_play: Option<QuickPlaySupportDto>,
    /// 工作目录 mods/ 下的 Mod 文件数；broken 或设置读不出时为 null。
    pub mod_count: Option<u32>,
    /// 工作目录 saves/ 下的存档数（每个文件夹算一个）；何时为 null 同 mod_count。
    pub world_count: Option<u32>,
    /// 隔离的生效值；何时为 null 同 mod_count。
    pub isolated: Option<bool>,
    pub description: Option<String>,
    pub cover: Option<String>,
    /// 实例设置里的最大内存 MB；null 为跟随全局（或设置读不出）。
    pub memory_mb: Option<u32>,
    /// 实例设置文件读不出来的原因；此时 description、cover、memory_mb 为 null。
    pub settings_error: Option<String>,
    /// 从整合包导入的实例记下的整合包；不是整合包实例或记录读不出时为 null。
    pub modpack: Option<InstanceModpackDto>,
    /// 整合包记录读不出来的原因。
    pub modpack_error: Option<String>,
    /// 最近一次崩溃的 Unix 毫秒；没崩溃过或记录读不出时为 null。
    pub last_crash_at: Option<u64>,
    /// 崩溃记录读不出来的原因。
    pub last_crash_error: Option<String>,
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

/// 实例的版本支持哪些直达方式：进入存档（Quick Play，1.20 起）与加入服务器。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct QuickPlaySupportDto {
    pub singleplayer: bool,
    pub multiplayer: bool,
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
    /// 这个实例的存档备份所在目录。备份放在游戏目录下，不随实例删除。
    pub backups_dir: String,
    /// 这个实例名下的备份份数（各存档合计）。
    pub backup_count: u32,
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
    let (description, cover, memory_mb, settings_error) = match summary.settings {
        Readable::Read(settings) => (
            settings.description,
            settings.cover,
            settings.memory_mb,
            None,
        ),
        Readable::Unreadable(error) => (None, None, None, Some(error)),
    };
    let (modpack, modpack_error) = match summary.modpack {
        Readable::Read(modpack) => (
            modpack.map(|m| InstanceModpackDto {
                platform: m.platform,
                project_id: m.project_id,
                version_id: m.version_id,
                name: m.name,
                version: m.version,
            }),
            None,
        ),
        Readable::Unreadable(error) => (None, Some(error)),
    };
    let (last_crash_at, last_crash_error) = match summary.last_crash_at {
        Readable::Read(at) => (at, None),
        Readable::Unreadable(error) => (None, Some(error)),
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
        quick_play: None,
        mod_count: None,
        world_count: None,
        isolated: None,
        description,
        cover,
        memory_mb,
        settings_error,
        modpack,
        modpack_error,
        last_crash_at,
        last_crash_error,
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
            dto.quick_play = ready.quick_play.map(|support| QuickPlaySupportDto {
                singleplayer: support.singleplayer,
                multiplayer: support.multiplayer,
            });
            dto.mod_count = ready.mod_count;
            dto.world_count = ready.world_count;
            dto.isolated = ready.isolated;
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
        backups_dir: preview.backups_dir.display().to_string(),
        backup_count: preview.backup_count,
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
/// （detail.field 指出是哪一项），文件不变。改名、删除、新建、补全进行中报 `instance_busy`：
/// 设置文件在实例目录里，并发写会按旧路径把目录重新建出来。游戏运行中可以写，下次启动生效。
#[tauri::command]
pub async fn set_instance_settings(
    id: String,
    settings: Value,
    facade: State<'_, Facade>,
    locks: State<'_, InstanceLocks>,
) -> Result<InstanceSettingsDto, CommandError> {
    set_instance_settings_with(&facade, &locks, &id, settings).await
}

pub(crate) async fn set_instance_settings_with(
    facade: &Facade,
    locks: &InstanceLocks,
    id: &str,
    settings: Value,
) -> Result<InstanceSettingsDto, CommandError> {
    // 参数按 Value 收下再自己解析：交给 Tauri 反序列化的话，失败时前端拿到的是一句纯字符串，
    // 没有 code 可分支。
    let dto: InstanceSettingsDto = serde_json::from_value(settings).map_err(|err| {
        invalid_field("settings", "malformed", format!("实例设置格式不对：{err}"))
    })?;
    let _guard = locks.acquire(id, InstanceActivity::Modifying)?;
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

/// 删除前的预览：会一起删掉的存档、占用空间、依赖它的实例、它此刻在做的事，以及留下来的存档备份在哪、
/// 有几份。
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
/// `instance_has_dependents`；目录已不在时只清引用与记录、返回 `existed: false`。目录与引用都已清掉、
/// 只有游玩记录没清成时报 `play_records_failed`。
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
    let records = snapshot.forget_play_records(id).await;
    let refs = facade
        .update_if_changed(|aurora| aurora.forget_instance(id))
        .await;
    follow_up(refs, records, |err| {
        play_records_failed(err, "实例已删除", json!({ "id": id }))
    })?;
    Ok(DeleteOutcomeDto { existed })
}

/// 目录操作完成后的两步收尾：配置里的侧栏固定与当前选中、游玩记录。两步互不拦着，一步失败另一步照做：
/// 记录没跟上就不改引用的话，侧栏固定与当前选中会一直指着已经不在的实例，重试也只会报实例不存在。
/// 两步都失败时报引用的错误（界面上看得见的是它），记录的错误留在日志里，门面已记下待补。
/// 改名还有第三路（存档备份），见 [`follow_up_backups`]。
fn follow_up(
    refs: Result<bool, CoreError>,
    records: aurora_core::Result<()>,
    records_failed: impl FnOnce(CoreError) -> CommandError,
) -> Result<(), CommandError> {
    match (refs, records) {
        (Ok(_), Ok(())) => Ok(()),
        (Ok(_), Err(err)) => Err(records_failed(err)),
        (Err(refs), Ok(())) => Err(refs.into()),
        (Err(refs), Err(records)) => {
            tracing::error!(error = %records, "游玩记录也没能跟着改，已记下待补");
            Err(refs.into())
        }
    }
}

/// 改名、删除本身已经做完、只差游玩记录：单独成码，前端照成功处理（刷新列表、迁移界面状态）再提示。
fn play_records_failed(err: CoreError, done: &str, extra: Value) -> CommandError {
    let mut mapped = CommandError::from(err);
    mapped.code = code::PLAY_RECORDS_FAILED;
    mapped.message = format!("{done}，但游玩记录没能跟着改：{}", mapped.message);
    merge_detail(&mut mapped, extra);
    mapped
}

/// 改名收尾的第三路：存档备份目录跟着挪。与前两路互不拦着；只差它没挪成时报 `world_backups_not_moved`，
/// 前两路也有失败时报前两路的错误（侧栏、列表与统计是界面上马上看得见的），备份的错误只进日志。
fn follow_up_backups(
    earlier: Result<(), CommandError>,
    backups: aurora_core::Result<()>,
    not_moved: impl FnOnce(CoreError) -> CommandError,
) -> Result<(), CommandError> {
    match (earlier, backups) {
        (Ok(()), Ok(())) => Ok(()),
        (Ok(()), Err(err)) => Err(not_moved(err)),
        (Err(earlier), Ok(())) => Err(earlier),
        (Err(earlier), Err(backups)) => {
            tracing::error!(error = %backups, "存档备份也没能跟着改名");
            Err(earlier)
        }
    }
}

/// 改名已经做完、只差存档备份：单独成码，前端照成功处理（`renamed_to` 读 detail）再提示备份还留在旧名下。
/// detail.path 是留在旧名下的备份目录，覆盖下层错误自带的 path：用户要去的是那里。
fn world_backups_not_moved(
    err: CoreError,
    id: &str,
    new_name: &str,
    left_behind: &Path,
) -> CommandError {
    let mut mapped = CommandError::from(err);
    mapped.code = code::WORLD_BACKUPS_NOT_MOVED;
    mapped.message = format!(
        "实例已改名为「{new_name}」，但存档备份没能跟着挪：{}",
        mapped.message
    );
    merge_detail(
        &mut mapped,
        json!({
            "id": id,
            "renamed_to": new_name,
            "path": left_behind.display().to_string(),
        }),
    );
    mapped
}

/// 实例改名：目录、版本 JSON（文件名与 id）、jar、natives、游玩记录、存档备份、侧栏固定与当前选中一起改。
/// 新名字按命名规则校验（报 `invalid_argument`，detail.rule 为规则码）；实例在忙报 `instance_busy`。
/// 目录与引用都已改好、只有游玩记录没跟上时报 `play_records_failed`，只有存档备份没跟上时报
/// `world_backups_not_moved`，两者的 detail.renamed_to 都是新名字。
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
    // 备份没挪成时要告诉用户它留在哪：改名之前按旧名算好，此时还没有动任何东西。
    let old_backups = snapshot.instance_backups_dir(id).map_err(instance_error)?;
    snapshot
        .rename_instance_files(id, new_name)
        .await
        .map_err(instance_error)?;
    // 游玩记录以实例 id 为键，不跟着挪的话改名后的实例在列表与统计里就成了从没玩过。
    let records = snapshot.rename_play_records(id, new_name).await;
    // 备份按实例 id 分目录放，不跟着挪的话改名后的实例就看不到改名前的备份。
    let backups = snapshot.rename_world_backups(id, new_name).await;
    let refs = facade
        .update_if_changed(|aurora| aurora.rename_instance_refs(id, new_name))
        .await;
    let earlier = follow_up(refs, records, |err| {
        play_records_failed(
            err,
            &format!("实例已改名为「{new_name}」"),
            json!({ "id": id, "renamed_to": new_name }),
        )
    });
    follow_up_backups(earlier, backups, |err| {
        world_backups_not_moved(err, id, new_name, &old_backups)
    })?;
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

/// 新建这个游戏版本的实例要的 Java 主版本与全新下载体积。版本清单不带这两项，每个版本取一次
/// 版本 JSON 后在进程内缓存，版本列表按选中行逐个查询即可。
#[tauri::command]
pub async fn version_requirements(
    mc_version: String,
    facade: State<'_, Facade>,
) -> Result<VersionRequirementsDto, CommandError> {
    let aurora = facade.snapshot().await;
    let requirements = aurora.version_requirements(&mc_version).await?;
    Ok(VersionRequirementsDto {
        java_major: requirements.java_major,
        download_bytes: requirements.download_bytes,
    })
}

// ---------------------------------------------------------------- 打开文件夹

/// 用系统文件管理器打开一个文件夹。`target`：
/// - `game_dir`：游戏目录（不需要 `id`）；
/// - `data_dir`：启动器数据目录（配置、凭据、任务表所在，不需要 `id`）；
/// - `launcher_logs`：启动器自己的日志目录 `<数据目录>/logs`（不需要 `id`）；
/// - `instance`：实例目录 `versions/<id>`；
/// - `mods` / `saves` / `resourcepacks` / `shaderpacks` / `logs` / `screenshots`：实例工作目录下的子目录，
///   不存在时先建出来；建目录期间占住实例，改名、删除进行中报 `instance_busy`，免得按旧路径建出空目录；
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
    locks: State<'_, InstanceLocks>,
) -> Result<(), CommandError> {
    let path = folder_path(&facade, &locks, &target, id.as_deref(), world.as_deref()).await?;
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
    locks: &InstanceLocks,
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
            let id = require_id()?;
            let _guard = locks.acquire(id, InstanceActivity::Modifying)?;
            let resolved = aurora
                .resolve_working_dir(id)
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

// ---------------------------------------------------------------- 存档备份
//
// 备份放在游戏目录下的启动器元数据区，按实例与存档文件夹名分目录；不隔离、共用游戏目录 saves 的存档
// 归在共用的一份下，几个实例看到的是同一批备份。备份、恢复、导出是长任务，占住实例做「备份」：
// 与启动、运行、改名、删除、新建、补全互斥，只与 Mod 改动并行。列表与删除备份不碰存档本身，不占实例。

/// 一份存档备份。
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct WorldBackupDto {
    /// 备份文件名，恢复与删除凭它指定。
    pub file: String,
    /// auto：游戏退出后自动备份的；manual：手动备份的。
    pub kind: BackupKind,
    /// 备份时刻（Unix 毫秒）。
    pub created_at: u64,
    pub size_bytes: u64,
    /// 备份时 level.dat 里的存档名；读不出来时为 null。
    pub level_name: Option<String>,
}

/// 一个存档的全部备份。
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct WorldBackupListDto {
    pub world: String,
    /// instance：实例自己的存档；shared：共用游戏目录 saves 的存档，所有共用的实例看到的是同一份。
    pub scope: &'static str,
    /// 这个存档的备份目录。
    pub dir: String,
    /// 新的在前。
    pub backups: Vec<WorldBackupDto>,
    pub total_bytes: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct BackupResultDto {
    pub backup: WorldBackupDto,
    /// 这次顺带清理掉的旧自动备份份数。
    pub pruned: u32,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct RestoreResultDto {
    pub world: String,
    /// 原来的存档是否移进了回收站；恢复时存档文件夹已经不在则为 false。
    pub previous_in_recycle_bin: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ExportResultDto {
    pub path: String,
    pub size_bytes: u64,
}

fn world_backup_dto(backup: WorldBackup) -> WorldBackupDto {
    WorldBackupDto {
        file: backup.file,
        kind: backup.kind,
        created_at: backup.created_at,
        size_bytes: backup.size_bytes,
        level_name: backup.level_name,
    }
}

fn world_scope_key(scope: &WorldScope) -> &'static str {
    match scope {
        WorldScope::Instance(_) => "instance",
        WorldScope::Shared => "shared",
    }
}

fn world_backup_list_dto(list: WorldBackupList) -> WorldBackupListDto {
    WorldBackupListDto {
        scope: world_scope_key(&list.scope),
        world: list.world,
        dir: list.dir.display().to_string(),
        backups: list.backups.into_iter().map(world_backup_dto).collect(),
        total_bytes: list.total_bytes,
    }
}

/// 存档文件夹名与备份文件名都要拼进路径，和实例 id 用同一套路径安全规则。
fn check_path_segment(field: &str, value: &str, what: &str) -> Result<(), CommandError> {
    if is_safe_instance_id(value) {
        Ok(())
    } else {
        Err(invalid_field(
            field,
            "unsafe",
            format!("{what}不合法：{value:?}"),
        ))
    }
}

/// 长任务要在登记任务之前挡住不安全的实例 id；报法与门面一致（detail.field 为 id、reason 为 unsafe_id）。
fn check_instance_id(id: &str) -> Result<(), CommandError> {
    if is_safe_instance_id(id) {
        Ok(())
    } else {
        Err(instance_error(CoreError::from(InstanceError::InvalidId {
            id: id.to_owned(),
        })))
    }
}

fn check_world(world: &str) -> Result<(), CommandError> {
    check_path_segment("world", world, "存档文件夹名")
}

fn check_backup_file(file: &str) -> Result<(), CommandError> {
    check_path_segment("file", file, "备份文件名")
}

/// 导出位置来自系统保存对话框，这里先挡住词法上就不对的：父目录在不在、是否落在存档里面由门面判断。
fn check_export_dest(dest: &str) -> Result<PathBuf, CommandError> {
    let path = PathBuf::from(dest);
    if !path.is_absolute() {
        return Err(invalid_field(
            "dest",
            "not_absolute",
            format!("导出位置须是绝对路径：{dest}"),
        ));
    }
    let is_zip = path
        .extension()
        .is_some_and(|ext| ext.eq_ignore_ascii_case("zip"));
    if !is_zip {
        return Err(invalid_field(
            "dest",
            "not_zip",
            format!("导出文件须是 .zip：{dest}"),
        ));
    }
    Ok(path)
}

/// 共用存档的跨实例检查。实例锁只管自己这个实例，可游戏同时只跑一个：另一个也不隔离的实例正开着游戏时，
/// 它可能正打开着这份共用存档，打包会拿到半截、恢复会被它下次保存盖掉。
async fn ensure_shared_world_free(
    aurora: &Aurora,
    game: &GameSlot,
    id: &str,
) -> Result<(), CommandError> {
    let Some((other, running)) = game.occupant() else {
        return Ok(());
    };
    // 占着游戏的就是自己时，实例锁已经拦下了。
    if lock_key(&other) == lock_key(id) {
        return Ok(());
    }
    if aurora.world_scope(id).await.map_err(instance_error)? != WorldScope::Shared {
        return Ok(());
    }
    if aurora.world_scope(&other).await.map_err(instance_error)? != WorldScope::Shared {
        return Ok(());
    }
    let activity = if running {
        InstanceActivity::Running
    } else {
        InstanceActivity::Launching
    };
    Err(busy(&other, activity))
}

/// 启动前的共用存档检查，与 [`ensure_shared_world_free`] 方向相反：另一个也不隔离的实例正在备份、恢复或
/// 导出共用存档时，这个实例的游戏一起来就可能打开同一份存档，边写边打包得到的备份是半截的。
pub(crate) async fn ensure_shared_worlds_settled(
    aurora: &Aurora,
    locks: &InstanceLocks,
    id: &str,
) -> Result<(), CommandError> {
    let others: Vec<String> = locks
        .holding(InstanceActivity::BackingUp)
        .into_iter()
        .filter(|other| lock_key(other) != lock_key(id))
        .collect();
    // 没有别的实例在备份时不碰盘：每次启动都会经过这里。
    if others.is_empty() {
        return Ok(());
    }
    if aurora.world_scope(id).await.map_err(instance_error)? != WorldScope::Shared {
        return Ok(());
    }
    for other in others {
        if aurora.world_scope(&other).await.map_err(instance_error)? == WorldScope::Shared {
            return Err(busy(&other, InstanceActivity::BackingUp));
        }
    }
    Ok(())
}

/// 备份、恢复、导出这三个长任务要用的共享状态。
pub(crate) struct WorldTaskEnv<'a> {
    pub facade: &'a Facade,
    pub tasks: &'a TaskRegistry,
    pub locks: &'a InstanceLocks,
    pub game: &'a GameSlot,
}

/// 三个长任务共同的开头（参数已由调用方校验过）：占住实例，共用存档再查别的实例的游戏，最后登记任务、
/// 给快照挂上取消令牌。被拒绝的调用不占任务 id。
async fn begin_world_task<'a>(
    env: &WorldTaskEnv<'a>,
    task_id: &str,
    id: &str,
) -> Result<(InstanceGuard, TaskHandle<'a>, Aurora), CommandError> {
    let guard = env.locks.acquire(id, InstanceActivity::BackingUp)?;
    let snapshot = env.facade.snapshot().await;
    ensure_shared_world_free(&snapshot, env.game, id).await?;
    let task = env.tasks.register(task_id)?;
    let aurora = snapshot.with_cancel(task.token().clone());
    Ok((guard, task, aurora))
}

/// 手动备份一个存档（工作目录下 `saves/<world>`）。长任务：进度经 core-event 推送并带 `task_id`，可取消，
/// 取消后不留半截文件。备份完按保留策略清理旧的自动备份，手动备份不清理。
///
/// 游戏启动中或运行中报 `instance_busy`（detail.activity 为 launching / running）；共用存档在别的不隔离实例
/// 开着游戏时同样报 `instance_busy`，detail.id 为那个实例。存档不在报 `world_not_found`，被游戏打开着报
/// `world_in_use`。
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn backup_world(
    app: AppHandle,
    task_id: String,
    id: String,
    world: String,
    facade: State<'_, Facade>,
    tasks: State<'_, TaskRegistry>,
    locks: State<'_, InstanceLocks>,
    running: State<'_, RunningGame>,
) -> Result<BackupResultDto, CommandError> {
    let env = WorldTaskEnv {
        facade: &facade,
        tasks: &tasks,
        locks: &locks,
        game: running.slot(),
    };
    let events = CoreEventForwarder::to_app(&app, Some(task_id.clone()));
    let outcome = backup_world_with(&env, &task_id, &id, &world, events.sink()).await;
    events.finish().await;
    outcome
}

pub(crate) async fn backup_world_with(
    env: &WorldTaskEnv<'_>,
    task_id: &str,
    id: &str,
    world: &str,
    events: &EventSink,
) -> Result<BackupResultDto, CommandError> {
    check_instance_id(id)?;
    check_world(world)?;
    let (_guard, task, aurora) = begin_world_task(env, task_id, id).await?;
    let outcome = task
        .run(async {
            aurora
                .backup_world(id, world, BackupKind::Manual, Some(events))
                .await
                .map_err(instance_error)
        })
        .await?;
    Ok(BackupResultDto {
        backup: world_backup_dto(outcome.backup),
        pruned: outcome.pruned,
    })
}

/// 一个存档的全部备份，新的在前。只读，不占实例；存档文件夹已经不在了也照常列出。
#[tauri::command]
pub async fn list_world_backups(
    id: String,
    world: String,
    facade: State<'_, Facade>,
) -> Result<WorldBackupListDto, CommandError> {
    list_world_backups_with(&facade, &id, &world).await
}

pub(crate) async fn list_world_backups_with(
    facade: &Facade,
    id: &str,
    world: &str,
) -> Result<WorldBackupListDto, CommandError> {
    check_world(world)?;
    let aurora = facade.snapshot().await;
    let list = aurora
        .list_world_backups(id, world)
        .await
        .map_err(instance_error)?;
    Ok(world_backup_list_dto(list))
}

/// 用一份备份替换现在的存档：先解压到临时目录并确认 level.dat 读得出，再把现在的存档移入回收站、换上新的。
/// 长任务，可取消；取消或失败时现在的存档原样不动。占用规则与 `backup_world` 相同。备份不在报
/// `world_backup_not_found`，备份损坏或有越界条目报 `world_backup_corrupt`；原存档已进回收站、新的没放到位时报
/// `world_restore_incomplete`，detail.staged 为恢复出的副本。
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn restore_world_backup(
    app: AppHandle,
    task_id: String,
    id: String,
    world: String,
    file: String,
    facade: State<'_, Facade>,
    tasks: State<'_, TaskRegistry>,
    locks: State<'_, InstanceLocks>,
    running: State<'_, RunningGame>,
) -> Result<RestoreResultDto, CommandError> {
    let env = WorldTaskEnv {
        facade: &facade,
        tasks: &tasks,
        locks: &locks,
        game: running.slot(),
    };
    let events = CoreEventForwarder::to_app(&app, Some(task_id.clone()));
    let outcome = restore_world_backup_with(
        &env,
        &task_id,
        &id,
        &world,
        &file,
        RecycleBin,
        events.sink(),
    )
    .await;
    events.finish().await;
    outcome
}

pub(crate) async fn restore_world_backup_with(
    env: &WorldTaskEnv<'_>,
    task_id: &str,
    id: &str,
    world: &str,
    file: &str,
    disposer: impl Disposer + 'static,
    events: &EventSink,
) -> Result<RestoreResultDto, CommandError> {
    check_instance_id(id)?;
    check_world(world)?;
    check_backup_file(file)?;
    let (_guard, task, aurora) = begin_world_task(env, task_id, id).await?;
    let outcome = task
        .run(async {
            aurora
                .restore_world_backup(id, world, file, disposer, Some(events))
                .await
                .map_err(instance_error)
        })
        .await?;
    Ok(RestoreResultDto {
        world: outcome.world,
        previous_in_recycle_bin: outcome.previous_in_recycle_bin,
    })
}

/// 把一份备份移入回收站并从备份列表里去掉。可以从回收站找回，所以不需要确认。不占实例：只碰备份区，
/// 与同一存档的备份、恢复由门面按存档排队。备份不在报 `world_backup_not_found`。
#[tauri::command]
pub async fn delete_world_backup(
    id: String,
    world: String,
    file: String,
    facade: State<'_, Facade>,
) -> Result<(), CommandError> {
    delete_world_backup_with(&facade, &id, &world, &file, RecycleBin).await
}

pub(crate) async fn delete_world_backup_with(
    facade: &Facade,
    id: &str,
    world: &str,
    file: &str,
    disposer: impl Disposer + 'static,
) -> Result<(), CommandError> {
    check_world(world)?;
    check_backup_file(file)?;
    let aurora = facade.snapshot().await;
    aurora
        .delete_world_backup(id, world, file, disposer)
        .await
        .map_err(instance_error)
}

/// 把存档打包导出到 `dest`（系统保存对话框选的位置，已存在则覆盖）：zip 里是一层存档文件夹，解压进 saves
/// 就能直接用。长任务，可取消；占用规则与 `backup_world` 相同。`dest` 不是绝对路径、不是 .zip、父目录不在
/// 或落在这个存档里面时报 `invalid_argument`，detail.field 为 dest。
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn export_world(
    app: AppHandle,
    task_id: String,
    id: String,
    world: String,
    dest: String,
    facade: State<'_, Facade>,
    tasks: State<'_, TaskRegistry>,
    locks: State<'_, InstanceLocks>,
    running: State<'_, RunningGame>,
) -> Result<ExportResultDto, CommandError> {
    let env = WorldTaskEnv {
        facade: &facade,
        tasks: &tasks,
        locks: &locks,
        game: running.slot(),
    };
    let events = CoreEventForwarder::to_app(&app, Some(task_id.clone()));
    let outcome = export_world_with(&env, &task_id, &id, &world, &dest, events.sink()).await;
    events.finish().await;
    outcome
}

pub(crate) async fn export_world_with(
    env: &WorldTaskEnv<'_>,
    task_id: &str,
    id: &str,
    world: &str,
    dest: &str,
    events: &EventSink,
) -> Result<ExportResultDto, CommandError> {
    check_instance_id(id)?;
    check_world(world)?;
    let dest = check_export_dest(dest)?;
    let (_guard, task, aurora) = begin_world_task(env, task_id, id).await?;
    let outcome = task
        .run(async {
            aurora
                .export_world(id, world, &dest, Some(events))
                .await
                .map_err(instance_error)
        })
        .await?;
    Ok(ExportResultDto {
        path: outcome.path.display().to_string(),
        size_bytes: outcome.size_bytes,
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

    /// 上次关闭启动器时留下的整合包导入半成品：新进程里没有任务占着它，列表照常列出（整合包标记、结局停在
    /// 进行中、没有在做的事），名字一直占着；可以直接删除，删掉后同一个名字能重新导入或新建。
    #[tokio::test]
    async fn half_import_left_by_a_closed_launcher_is_listed_and_deletable() {
        let env = Env::new();
        let dir = env.game_dir().join("versions").join("RLCraft");
        aurora_core::MarkerStore::for_version_dir(&dir)
            .save(&IncompleteMarker::pending(
                IncompleteKind::Modpack {
                    task_id: "mp#9".into(),
                },
                1_761_800_000_000,
            ))
            .await
            .unwrap();
        let locks = InstanceLocks::default();

        let list = list_instances_with(&env.facade, &locks).await.unwrap();
        assert_eq!(list.len(), 1);
        let entry = &list[0];
        assert_eq!(entry.id, "RLCraft");
        assert_eq!(entry.status, "broken");
        assert_eq!(entry.activity, None);
        let incomplete = entry.incomplete.as_ref().unwrap();
        assert_eq!(
            (incomplete.kind, incomplete.outcome),
            ("modpack", "pending")
        );
        assert_eq!(incomplete.started_at, Some(1_761_800_000_000));

        let snapshot = env.facade.snapshot().await;
        assert!(snapshot.ensure_modpack_name_free("rlcraft").await.is_err());

        let deleted = delete_instance_with(&env.facade, &locks, "RLCraft", Remove)
            .await
            .unwrap();
        assert!(deleted.existed);
        assert!(!dir.exists());
        snapshot.ensure_modpack_name_free("RLCraft").await.unwrap();
        snapshot.check_new_instance_name("RLCraft").await.unwrap();
        assert!(list_instances_with(&env.facade, &locks)
            .await
            .unwrap()
            .is_empty());
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

    async fn switch_game_dir(env: &Env, game_dir: &Path) {
        env.facade
            .update(|aurora| {
                aurora.switch_game_directory(game_dir);
                Ok::<_, CommandError>(())
            })
            .await
            .unwrap();
    }

    /// 游玩记录按游戏目录分开：换到另一个游戏目录后同名实例从零算起；在那边改名、删除，不动原目录的记录。
    #[tokio::test]
    async fn play_records_are_kept_apart_per_game_directory() {
        let env = Env::new();
        env.vanilla("周末生存");
        let home = env.game_dir();
        let other = env.dir.path().join("另一个").join(".minecraft");
        let twin = other.join("versions").join("周末生存");
        std::fs::create_dir_all(&twin).unwrap();
        std::fs::write(
            twin.join("周末生存.json"),
            r#"{"id":"周末生存","type":"release","mainClass":"M"}"#,
        )
        .unwrap();
        // 只按实例 id 记的旧记录：读到时归到当时的当前游戏目录。
        write_playtime(
            &env,
            r#"{"format":1,"book":{
                "instances":{"周末生存":{"total_ms":5400000,"last_played_at":1761832800000}},
                "days":{"2026-10-30":{"instances":{"周末生存":5400000}}}}}"#,
        );
        let locks = InstanceLocks::default();
        let played = |list: &[InstanceDto]| {
            let entry = list.iter().find(|i| i.id == "周末生存").unwrap();
            (entry.playtime_min, entry.last_played_at)
        };
        let day = || aurora_core::PlayRange::parse("2026-10-30", "2026-10-30").unwrap();

        let list = list_instances_with(&env.facade, &locks).await.unwrap();
        assert_eq!(played(&list), (90, Some(1_761_832_800_000)));

        switch_game_dir(&env, &other).await;
        let list = list_instances_with(&env.facade, &locks).await.unwrap();
        assert_eq!(played(&list), (0, None), "另一个游戏目录里的同名实例不继承");
        let stats = env.facade.snapshot().await.play_stats(day()).await.unwrap();
        assert_eq!((stats.days.len(), stats.total_minutes), (0, 0));

        rename_instance_with(&env.facade, &locks, "周末生存", "改了名")
            .await
            .unwrap();
        delete_instance_with(&env.facade, &locks, "改了名", Remove)
            .await
            .unwrap();

        switch_game_dir(&env, &home).await;
        let list = list_instances_with(&env.facade, &locks).await.unwrap();
        assert_eq!(played(&list), (90, Some(1_761_832_800_000)));
        let stats = env.facade.snapshot().await.play_stats(day()).await.unwrap();
        assert_eq!(stats.total_minutes, 90);
        assert_eq!(stats.instances[0].version_id, "周末生存");
    }

    /// 游玩记录读不出来：改名、删除照样把文件与配置里的侧栏固定、当前选中改完（磁盘与门面都改），命令以
    /// play_records_failed 报告只差游玩记录没跟上，不假装一切正常，坏文件原样留着。
    #[tokio::test]
    async fn unreadable_play_records_do_not_hold_back_the_references() {
        let env = Env::new();
        let dir = env.vanilla("a");
        env.vanilla("留下");
        env.facade
            .update(|aurora| {
                aurora.set_sidebar_pins(vec!["a".into(), "留下".into()]);
                aurora.set_selected_version(Some("a".into()));
                Ok::<_, CommandError>(())
            })
            .await
            .unwrap();
        write_playtime(&env, "{ broken");
        let locks = InstanceLocks::default();

        let err = rename_instance_with(&env.facade, &locks, "a", "b")
            .await
            .unwrap_err();
        assert_eq!(err.code, code::PLAY_RECORDS_FAILED);
        assert!(
            err.message.starts_with("实例已改名为「b」"),
            "{}",
            err.message
        );
        assert!(err.message.contains("游玩记录"), "{}", err.message);
        let detail = err.detail.unwrap();
        assert_eq!(
            (&detail["id"], &detail["renamed_to"]),
            (&json!("a"), &json!("b"))
        );
        assert!(!detail["causes"].as_array().unwrap().is_empty());
        assert!(!dir.exists());
        assert!(env.game_dir().join("versions").join("b").is_dir());
        let saved = env.saved_config().await;
        assert_eq!(saved.sidebar_pins, vec!["b".to_owned(), "留下".to_owned()]);
        assert_eq!(saved.selected_version.as_deref(), Some("b"));
        assert_eq!(
            get_pins(&env).await,
            vec!["b".to_owned(), "留下".to_owned()]
        );
        assert_eq!((locks.activity("a"), locks.activity("b")), (None, None));

        let err = delete_instance_with(&env.facade, &locks, "b", Remove)
            .await
            .unwrap_err();
        assert_eq!(err.code, code::PLAY_RECORDS_FAILED);
        assert!(err.message.starts_with("实例已删除"), "{}", err.message);
        assert_eq!(err.detail.unwrap()["id"], "b");
        assert!(!env.game_dir().join("versions").join("b").exists());
        let saved = env.saved_config().await;
        assert_eq!(saved.sidebar_pins, vec!["留下".to_owned()]);
        assert_eq!(saved.selected_version, None);
        assert_eq!(get_pins(&env).await, vec!["留下".to_owned()]);
        assert_eq!(locks.activity("b"), None);
        assert_eq!(
            std::fs::read_to_string(env.dir.path().join(aurora_core::playtime::PLAYTIME_FILE))
                .unwrap(),
            "{ broken"
        );
    }

    /// 游玩记录文件被别的程序以只许读的方式占着（读得出、替换不了）：改名报 play_records_failed 之后，前端
    /// 随即重扫的实例列表照常列出，改了名的实例带着原来的时长；放开后记录补上落盘。
    #[cfg(windows)]
    #[tokio::test]
    async fn list_still_loads_while_the_play_records_cannot_be_replaced() {
        use std::os::windows::fs::OpenOptionsExt;

        const FILE_SHARE_READ: u32 = 1;
        let env = Env::new();
        env.vanilla("a");
        env.vanilla("留下");
        write_playtime(
            &env,
            r#"{"format":1,"book":{
                "instances":{"a":{"total_ms":600000,"last_played_at":1761800000000}},
                "days":{"2026-10-30":{"instances":{"a":600000}}}}}"#,
        );
        let path = env.dir.path().join(aurora_core::playtime::PLAYTIME_FILE);
        let locks = InstanceLocks::default();
        let played = |list: &[InstanceDto], id: &str| {
            let entry = list.iter().find(|i| i.id == id).unwrap();
            (entry.playtime_min, entry.last_played_at)
        };

        let held = std::fs::OpenOptions::new()
            .read(true)
            .share_mode(FILE_SHARE_READ)
            .open(&path)
            .unwrap();
        let list = list_instances_with(&env.facade, &locks).await.unwrap();
        assert_eq!(played(&list, "a"), (10, Some(1_761_800_000_000)));
        let err = rename_instance_with(&env.facade, &locks, "a", "b")
            .await
            .unwrap_err();
        assert_eq!(err.code, code::PLAY_RECORDS_FAILED);
        let list = list_instances_with(&env.facade, &locks).await.unwrap();
        assert_eq!(list.len(), 2);
        assert_eq!(played(&list, "b"), (10, Some(1_761_800_000_000)));
        assert_eq!(played(&list, "留下"), (0, None));
        drop(held);

        list_instances_with(&env.facade, &locks).await.unwrap();
        let saved: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        assert_eq!(saved["format"], 2);
        let ids: Vec<&String> = saved["directories"][0]["book"]["instances"]
            .as_object()
            .unwrap()
            .keys()
            .collect();
        assert_eq!(ids, vec!["b"]);
    }

    /// 配置存不下时改名报配置的错，游玩记录照样跟着新名字走：两步收尾互不拦着。
    #[tokio::test]
    async fn play_records_follow_the_rename_even_when_the_config_cannot_be_saved() {
        let env = Env::new();
        env.vanilla("a");
        env.facade
            .update(|aurora| {
                aurora.set_sidebar_pins(vec!["a".into()]);
                Ok::<_, CommandError>(())
            })
            .await
            .unwrap();
        write_playtime(
            &env,
            r#"{"format":1,"book":{
                "instances":{"a":{"total_ms":600000,"last_played_at":1761800000000}},
                "days":{"2026-10-30":{"instances":{"a":600000}}}}}"#,
        );
        let config = env.dir.path().join("config.json");
        std::fs::remove_file(&config).unwrap();
        std::fs::create_dir(&config).unwrap();
        let locks = InstanceLocks::default();

        let err = rename_instance_with(&env.facade, &locks, "a", "b")
            .await
            .unwrap_err();
        assert_eq!(err.code, common::IO);
        assert!(env.game_dir().join("versions").join("b").is_dir());
        let summaries = env.facade.snapshot().await.play_summaries().await.unwrap();
        assert_eq!(summaries.keys().collect::<Vec<_>>(), vec!["b"]);
        assert_eq!(summaries["b"].playtime_min, 10);
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
        let saved = set_instance_settings_with(
            &env.facade,
            &InstanceLocks::default(),
            "1.21.1",
            settings.clone(),
        )
        .await
        .unwrap();
        assert_eq!(serde_json::to_value(&saved).unwrap(), settings);

        let mut unknown = settings.clone();
        unknown["colour"] = json!("pink");
        let err =
            set_instance_settings_with(&env.facade, &InstanceLocks::default(), "1.21.1", unknown)
                .await
                .unwrap_err();
        assert_eq!(err.code, common::INVALID_ARGUMENT);
        assert_eq!(err.detail.unwrap()["field"], "settings");

        let mut bad_memory = settings.clone();
        bad_memory["memory_mb"] = json!(1000);
        let err = set_instance_settings_with(
            &env.facade,
            &InstanceLocks::default(),
            "1.21.1",
            bad_memory,
        )
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

        let err =
            set_instance_settings_with(&env.facade, &InstanceLocks::default(), "不存在", settings)
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

    /// 列表 DTO 带上整合包来源、最近崩溃、存档数、隔离生效值与自定内存；附属文件读不出时
    /// 只把原因放进对应的 *_error，其余字段照常给。
    #[test]
    fn instance_dto_carries_modpack_crash_worlds_isolation_and_memory() {
        let summary = |modpack, last_crash_at, settings| InstanceSummary {
            id: "整合包".into(),
            dir: PathBuf::from("versions/整合包"),
            version: InstanceVersion::Ready(aurora_core::ReadyVersion {
                mc_version: Some("1.21.1".into()),
                loaders: Vec::new(),
                release_type: Some("release".into()),
                is_release: true,
                java_major: Some(21),
                quick_play: Some(aurora_core::QuickPlaySupport {
                    singleplayer: true,
                    multiplayer: true,
                }),
                mod_count: Some(80),
                world_count: Some(3),
                isolated: Some(true),
            }),
            settings,
            incomplete: None,
            created_at: Some(1),
            modpack,
            last_crash_at,
        };
        let pack = aurora_core::InstanceModpack {
            schema: 1,
            format: aurora_core::PackFormat::Modrinth,
            platform: Some(Platform::Modrinth),
            project_id: Some("1KVo5zza".into()),
            version_id: Some("abc123".into()),
            name: "Fabulously Optimized".into(),
            version: Some("6.4.0".into()),
            minecraft: "1.21.1".into(),
            loader: None,
            remote_files: 80,
            override_files: 12,
            installed_at: 1,
        };
        let settings = VersionSettings {
            memory_mb: Some(6144),
            ..VersionSettings::default()
        };

        let dto = instance_dto(
            summary(
                Readable::Read(Some(pack)),
                Readable::Read(Some(1_700_000_000_000)),
                Readable::Read(settings),
            ),
            None,
            None,
        );
        let value = serde_json::to_value(&dto).unwrap();
        assert_eq!(
            value["modpack"],
            json!({
                "platform": "modrinth", "project_id": "1KVo5zza", "version_id": "abc123",
                "name": "Fabulously Optimized", "version": "6.4.0"
            })
        );
        assert_eq!(value["modpack_error"], json!(null));
        assert_eq!(value["last_crash_at"], json!(1_700_000_000_000_u64));
        assert_eq!(value["last_crash_error"], json!(null));
        assert_eq!(value["world_count"], json!(3));
        assert_eq!(value["isolated"], json!(true));
        assert_eq!(value["memory_mb"], json!(6144));
        assert_eq!(
            value["quick_play"],
            json!({ "singleplayer": true, "multiplayer": true })
        );

        let broken = instance_dto(
            summary(
                Readable::Unreadable("整合包记录坏了".into()),
                Readable::Unreadable("崩溃记录坏了".into()),
                Readable::Unreadable("设置坏了".into()),
            ),
            None,
            None,
        );
        assert_eq!(broken.modpack, None);
        assert_eq!(broken.modpack_error.as_deref(), Some("整合包记录坏了"));
        assert_eq!(broken.last_crash_at, None);
        assert_eq!(broken.last_crash_error.as_deref(), Some("崩溃记录坏了"));
        assert_eq!(broken.memory_mb, None);
        assert_eq!(broken.settings_error.as_deref(), Some("设置坏了"));
        // 设置读不出不影响直达支持：它只看版本 JSON。
        assert_eq!(
            broken.quick_play,
            Some(QuickPlaySupportDto {
                singleplayer: true,
                multiplayer: true,
            })
        );

        // 版本 JSON 坏了的实例说不出支持什么，给 null，入口按不可用处理。
        let mut missing_json = summary(
            Readable::Read(None),
            Readable::Read(None),
            Readable::Read(VersionSettings::default()),
        );
        missing_json.version = InstanceVersion::Broken(aurora_core::BrokenReason::MissingJson);
        let value = serde_json::to_value(instance_dto(missing_json, None, None)).unwrap();
        assert_eq!(value["status"], json!("broken"));
        assert_eq!(value["quick_play"], json!(null));
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
        let locks = InstanceLocks::default();

        assert_eq!(
            folder_path(facade, &locks, "game_dir", None, None)
                .await
                .unwrap(),
            env.game_dir()
        );
        assert_eq!(
            folder_path(facade, &locks, "data_dir", None, None)
                .await
                .unwrap(),
            env.dir.path()
        );
        // 启动器日志目录还没写过日志时也先建出来，资源管理器打得开。
        let logs = folder_path(facade, &locks, "launcher_logs", None, None)
            .await
            .unwrap();
        assert_eq!(logs, env.dir.path().join("logs"));
        assert!(logs.is_dir());
        assert_eq!(
            folder_path(facade, &locks, "launcher_logs", Some("1.21.1"), None)
                .await
                .unwrap(),
            logs,
            "不需要实例的目标忽略 id"
        );
        assert_eq!(
            folder_path(facade, &locks, "instance", Some("1.21.1"), None)
                .await
                .unwrap(),
            dir
        );
        // 原版正式版默认不隔离：mods 在游戏目录下，打开前建出来。
        let mods = folder_path(facade, &locks, "mods", Some("1.21.1"), None)
            .await
            .unwrap();
        assert_eq!(mods, env.game_dir().join("mods"));
        assert!(mods.is_dir());

        std::fs::create_dir_all(env.game_dir().join("saves").join("w1")).unwrap();
        assert_eq!(
            folder_path(facade, &locks, "world", Some("1.21.1"), Some("w1"))
                .await
                .unwrap(),
            env.game_dir().join("saves").join("w1")
        );
        let field = |err: CommandError| {
            assert_eq!(err.code, common::INVALID_ARGUMENT);
            let detail = err.detail.unwrap();
            (detail["field"].clone(), detail["reason"].clone())
        };
        let err = folder_path(facade, &locks, "world", Some("1.21.1"), Some("..\\x"))
            .await
            .unwrap_err();
        assert_eq!(field(err), (json!("world"), json!("unsafe")));
        let err = folder_path(facade, &locks, "world", Some("1.21.1"), Some("w9"))
            .await
            .unwrap_err();
        assert_eq!(field(err), (json!("world"), json!("not_found")));
        let err = folder_path(facade, &locks, "mods", None, None)
            .await
            .unwrap_err();
        assert_eq!(field(err), (json!("id"), json!("missing")));
        let err = folder_path(facade, &locks, "desktop", None, None)
            .await
            .unwrap_err();
        assert_eq!(field(err), (json!("target"), json!("unknown")));
        let err = folder_path(facade, &locks, "instance", Some("ghost"), None)
            .await
            .unwrap_err();
        assert_eq!(err.code, common::VERSION_NOT_INSTALLED);
    }

    /// 写设置、为打开文件夹建子目录都占住实例：改名或删除进行中报 instance_busy，什么都不写、不建；
    /// 游戏运行中照常可以。
    #[tokio::test]
    async fn settings_and_subfolders_wait_for_rename_and_delete_but_not_for_the_game() {
        let env = Env::new();
        let dir = env.vanilla("1.21.1");
        let locks = InstanceLocks::default();
        let settings = json!({
            "description": "改名途中写进来的", "cover": null, "isolation": "enabled",
            "memory_mb": null, "java": "auto", "jvm_args": "",
            "resolution": { "width": 854, "height": 480 }, "fullscreen": false
        });

        for activity in [InstanceActivity::Renaming, InstanceActivity::Deleting] {
            let held = locks.acquire("1.21.1", activity).unwrap();
            let expected = serde_json::to_value(activity).unwrap();
            let err = set_instance_settings_with(&env.facade, &locks, "1.21.1", settings.clone())
                .await
                .unwrap_err();
            assert_eq!(err.code, code::INSTANCE_BUSY);
            assert_eq!(err.detail.unwrap()["activity"], expected);
            let err = folder_path(&env.facade, &locks, "mods", Some("1.21.1"), None)
                .await
                .unwrap_err();
            assert_eq!(err.code, code::INSTANCE_BUSY);
            drop(held);
        }
        let description = || async {
            env.facade
                .snapshot()
                .await
                .instance_settings("1.21.1")
                .await
                .unwrap()
                .description
        };
        assert_eq!(description().await, None, "被拒绝的写入不改动设置");
        assert!(!env.game_dir().join("mods").exists());
        assert!(!dir.join("mods").exists());

        let _game = locks.acquire("1.21.1", InstanceActivity::Running).unwrap();
        set_instance_settings_with(&env.facade, &locks, "1.21.1", settings)
            .await
            .unwrap();
        assert_eq!(description().await.as_deref(), Some("改名途中写进来的"));
        // 隔离已开：mods 建在实例目录里。
        let mods = folder_path(&env.facade, &locks, "mods", Some("1.21.1"), None)
            .await
            .unwrap();
        assert_eq!(mods, dir.join("mods"));
        assert!(mods.is_dir());
        assert_eq!(locks.activity("1.21.1"), Some(InstanceActivity::Running));
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

    /// 备份只与 Mod 改动并行：与启动、运行、新建、补全、改名、删除和它自己两个方向都互斥；运行中的占用
    /// 可以原地转成备份（游戏退出后的自动备份），转过去之后照样挡住再次启动。
    #[test]
    fn backing_up_shares_the_instance_only_with_mod_changes() {
        use InstanceActivity::*;
        let exclusive = [
            Installing, Repairing, Renaming, Deleting, Launching, Running, BackingUp,
        ];
        let locks = InstanceLocks::default();
        assert_eq!(serde_json::to_value(BackingUp).unwrap(), "backing_up");

        let backup = locks.acquire("Pack", BackingUp).unwrap();
        for activity in exclusive {
            let err = locks.acquire("pack", activity).err().unwrap();
            assert_eq!(err.code, code::INSTANCE_BUSY, "{activity:?}");
            let detail = err.detail.unwrap();
            assert_eq!(detail["activity"], "backing_up", "{activity:?}");
            assert_eq!(detail["id"], "pack");
        }
        let mods = locks.acquire("PACK", Modifying).unwrap();
        assert_eq!(
            locks.activity("pack"),
            Some(BackingUp),
            "并行时报备份而不是改动"
        );
        drop(backup);
        assert_eq!(locks.activity("pack"), Some(Modifying));
        let again = locks.acquire("pack", BackingUp).unwrap();
        drop(again);
        drop(mods);

        for activity in exclusive {
            let held = locks.acquire("pack", activity).unwrap();
            let err = locks.acquire("pack", BackingUp).err().unwrap();
            assert_eq!(err.code, code::INSTANCE_BUSY, "{activity:?}");
            assert_eq!(
                err.detail.unwrap()["activity"],
                serde_json::to_value(activity).unwrap()
            );
            drop(held);
        }

        let game = locks.acquire("pack", Launching).unwrap();
        game.set_activity(Running);
        let mods = locks.acquire("pack", Modifying).unwrap();
        game.set_activity(BackingUp);
        assert_eq!(locks.activity("pack"), Some(BackingUp));
        let err = locks.acquire("pack", Launching).err().unwrap();
        assert_eq!(err.detail.unwrap()["activity"], "backing_up");
        drop(game);
        drop(mods);
        assert_eq!(locks.activity("pack"), None);
    }

    // ---- 存档备份的命令 ----

    /// 测试里不往用户回收站塞东西：记下交来的路径再删掉，文件与目录都收。
    #[derive(Clone, Default)]
    struct Recorder(Arc<Mutex<Vec<PathBuf>>>);

    impl Recorder {
        fn disposed(&self) -> Vec<PathBuf> {
            self.0.lock().unwrap().clone()
        }
    }

    impl Disposer for Recorder {
        fn dispose(&self, path: &Path) -> Result<(), InstanceError> {
            self.0.lock().unwrap().push(path.to_path_buf());
            let removed = if path.is_dir() {
                std::fs::remove_dir_all(path)
            } else {
                std::fs::remove_file(path)
            };
            removed.map_err(|source| InstanceError::Io {
                path: path.to_path_buf(),
                source,
            })
        }
    }

    /// gzip 的 CRC-32（IEEE 802.3，反射多项式）。
    fn crc32(data: &[u8]) -> u32 {
        let mut crc = !0u32;
        for &byte in data {
            crc ^= u32::from(byte);
            for _ in 0..8 {
                crc = if crc & 1 == 1 {
                    (crc >> 1) ^ 0xEDB8_8320
                } else {
                    crc >> 1
                };
            }
        }
        !crc
    }

    /// 只含 LevelName 的 level.dat：NBT 用 gzip 包一层，deflate 用不压缩的存储块（外壳不直接依赖压缩库）。
    fn level_dat(name: &str) -> Vec<u8> {
        let mut nbt = vec![10, 0, 0, 10, 0, 4];
        nbt.extend_from_slice(b"Data");
        nbt.extend_from_slice(&[8, 0, 9]);
        nbt.extend_from_slice(b"LevelName");
        nbt.extend_from_slice(&u16::try_from(name.len()).unwrap().to_be_bytes());
        nbt.extend_from_slice(name.as_bytes());
        nbt.extend_from_slice(&[0, 0]);
        let len = u16::try_from(nbt.len()).unwrap();
        let mut gz = vec![0x1f, 0x8b, 8, 0, 0, 0, 0, 0, 0, 0xff, 1];
        gz.extend_from_slice(&len.to_le_bytes());
        gz.extend_from_slice(&(!len).to_le_bytes());
        gz.extend_from_slice(&nbt);
        gz.extend_from_slice(&crc32(&nbt).to_le_bytes());
        gz.extend_from_slice(&u32::try_from(nbt.len()).unwrap().to_le_bytes());
        gz
    }

    #[tokio::test]
    async fn level_dat_fixture_is_readable_by_the_launcher() {
        let env = Env::new();
        env.isolated_world("生存", "新的世界");
        let content = env
            .facade
            .snapshot()
            .await
            .instance_content("生存")
            .await
            .unwrap();
        let worlds = content_dto(content).worlds;
        assert_eq!(worlds.len(), 1);
        assert_eq!(worlds[0].level_status, "ok", "{:?}", worlds[0].level_error);
        assert_eq!(worlds[0].name.as_deref(), Some("新的世界"));
    }

    /// 打包压不动的字节，让备份与恢复慢到能在中途取消。
    fn noise(len: usize, seed: u64) -> Vec<u8> {
        let mut state = seed | 1;
        (0..len)
            .map(|_| {
                state ^= state << 13;
                state ^= state >> 7;
                state ^= state << 17;
                state.to_le_bytes()[0]
            })
            .collect()
    }

    /// 在 `saves` 下放一个存档：level.dat、一个区域文件，以及游戏开着时才有的 session.lock。
    fn write_world(saves: &Path, world: &str, region: &[u8]) -> PathBuf {
        let dir = saves.join(world);
        std::fs::create_dir_all(dir.join("region")).unwrap();
        std::fs::create_dir_all(dir.join("datapacks")).unwrap();
        std::fs::write(dir.join("level.dat"), level_dat(world)).unwrap();
        std::fs::write(dir.join("region").join("r.0.0.mca"), region).unwrap();
        std::fs::write(dir.join("session.lock"), b"\xe2\x98\x83").unwrap();
        dir
    }

    impl Env {
        /// 隔离实例 `id`（实例目录下已有 saves），里面一个存档。
        fn isolated_world(&self, id: &str, world: &str) -> PathBuf {
            let dir = self.vanilla(id);
            write_world(&dir.join("saves"), world, b"region-v1")
        }

        /// 不隔离的原版实例 `id`，存档在游戏目录共用的 saves 里。
        fn shared_world(&self, id: &str, world: &str) -> PathBuf {
            self.vanilla(id);
            write_world(&self.game_dir().join("saves"), world, b"shared-v1")
        }

        fn backups_root(&self) -> PathBuf {
            self.game_dir()
                .join(concat!(".", aurora_base::app_slug!()))
                .join("backups")
        }
    }

    /// 存档命令的共享状态；游戏占用槽单独给，测试里按需占住。
    struct WorldEnv {
        registry: TaskRegistry,
        locks: InstanceLocks,
        game: GameSlot,
    }

    impl WorldEnv {
        fn new() -> Self {
            Self {
                registry: TaskRegistry::default(),
                locks: InstanceLocks::default(),
                game: GameSlot::default(),
            }
        }

        fn with<'a>(&'a self, env: &'a Env) -> WorldTaskEnv<'a> {
            WorldTaskEnv {
                facade: &env.facade,
                tasks: &self.registry,
                locks: &self.locks,
                game: &self.game,
            }
        }
    }

    fn sink() -> (EventSink, tokio::sync::mpsc::UnboundedReceiver<CoreEvent>) {
        tokio::sync::mpsc::unbounded_channel::<CoreEvent>()
    }

    fn zip_names(path: &Path) -> Vec<String> {
        let archive = zip::ZipArchive::new(std::fs::File::open(path).unwrap()).unwrap();
        let mut names: Vec<String> = archive.file_names().map(str::to_owned).collect();
        names.sort();
        names
    }

    /// 验收：游戏启动中、运行中备份、恢复、导出都报 instance_busy，detail.activity 指出是哪一种，不登记任务、
    /// 不动存档；Mod 改动占着实例时三者照常进行。
    #[tokio::test]
    async fn backup_restore_and_export_wait_for_the_game_but_not_for_mod_changes() {
        let env = Env::new();
        let world = env.isolated_world("生存", "新的世界");
        let w = WorldEnv::new();
        let (events, _rx) = sink();
        let dest = env.dir.path().join("导出.zip");
        let dest = dest.to_str().unwrap();

        for activity in [InstanceActivity::Launching, InstanceActivity::Running] {
            let held = w.locks.acquire("生存", activity).unwrap();
            let expected = serde_json::to_value(activity).unwrap();
            let errors = [
                backup_world_with(&w.with(&env), "t", "生存", "新的世界", &events)
                    .await
                    .unwrap_err(),
                restore_world_backup_with(
                    &w.with(&env),
                    "t",
                    "生存",
                    "新的世界",
                    "1761900000000-manual.zip",
                    Recorder::default(),
                    &events,
                )
                .await
                .unwrap_err(),
                export_world_with(&w.with(&env), "t", "生存", "新的世界", dest, &events)
                    .await
                    .unwrap_err(),
            ];
            for err in errors {
                assert_eq!(err.code, code::INSTANCE_BUSY);
                let detail = err.detail.unwrap();
                assert_eq!(detail["activity"], expected);
                assert_eq!(detail["id"], "生存");
            }
            assert!(!w.registry.is_running("t"));
            drop(held);
        }
        assert!(!env.backups_root().exists(), "被拒绝的备份不碰盘");
        assert!(!env.dir.path().join("导出.zip").exists());

        let _mods = w
            .locks
            .acquire("生存", InstanceActivity::Modifying)
            .unwrap();
        let made = backup_world_with(&w.with(&env), "bk", "生存", "新的世界", &events)
            .await
            .unwrap();
        assert_eq!(made.backup.kind, BackupKind::Manual);
        assert!(
            made.backup.file.ends_with("-manual.zip"),
            "{}",
            made.backup.file
        );
        assert_eq!(made.backup.level_name.as_deref(), Some("新的世界"));
        assert_eq!(made.pruned, 0);
        let dir = env
            .backups_root()
            .join("instances")
            .join("生存")
            .join("新的世界");
        let zip = dir.join(&made.backup.file);
        assert_eq!(
            made.backup.size_bytes,
            std::fs::metadata(&zip).unwrap().len()
        );
        let names = zip_names(&zip);
        for expected in [
            "新的世界/datapacks/",
            "新的世界/level.dat",
            "新的世界/region/",
            "新的世界/region/r.0.0.mca",
        ] {
            assert!(
                names.contains(&expected.to_owned()),
                "缺 {expected}：{names:?}"
            );
        }
        assert!(
            names
                .iter()
                .all(|n| n.starts_with("新的世界/") && !n.ends_with("session.lock")),
            "条目都在存档文件夹下，session.lock 不进备份：{names:?}"
        );
        assert!(!w.registry.is_running("bk"), "任务结束即注销");
        assert_eq!(
            w.locks.activity("生存"),
            Some(InstanceActivity::Modifying),
            "备份的占用已释放"
        );

        let listed = list_world_backups_with(&env.facade, "生存", "新的世界")
            .await
            .unwrap();
        assert_eq!(listed.scope, "instance");
        assert_eq!(listed.dir, dir.display().to_string());
        assert_eq!(listed.backups, vec![made.backup.clone()]);
        assert_eq!(listed.total_bytes, made.backup.size_bytes);

        let exported = export_world_with(&w.with(&env), "ex", "生存", "新的世界", dest, &events)
            .await
            .unwrap();
        assert_eq!(exported.path, dest);
        assert_eq!(exported.size_bytes, std::fs::metadata(dest).unwrap().len());
        assert!(zip_names(Path::new(dest)).contains(&"新的世界/level.dat".to_owned()));

        let disposer = Recorder::default();
        let restored = restore_world_backup_with(
            &w.with(&env),
            "rs",
            "生存",
            "新的世界",
            &made.backup.file,
            disposer.clone(),
            &events,
        )
        .await
        .unwrap();
        assert_eq!(restored.world, "新的世界");
        assert_eq!(disposer.disposed(), vec![world.clone()]);
    }

    /// 参数先于实例锁校验：游戏运行中传错参数报 invalid_argument 而不是 instance_busy，不登记任务。
    #[tokio::test]
    async fn bad_world_file_and_dest_are_rejected_before_locking() {
        let env = Env::new();
        env.isolated_world("生存", "新的世界");
        let w = WorldEnv::new();
        let (events, _rx) = sink();
        let _game = w.locks.acquire("生存", InstanceActivity::Running).unwrap();
        let inside = env.dir.path().join("x.zip");
        let inside = inside.to_str().unwrap();

        for world in ["", "..", "../生存", "a/b", r"a\b", ".hidden", "C:x"] {
            for err in [
                backup_world_with(&w.with(&env), "t", "生存", world, &events)
                    .await
                    .unwrap_err(),
                export_world_with(&w.with(&env), "t", "生存", world, inside, &events)
                    .await
                    .unwrap_err(),
                list_world_backups_with(&env.facade, "生存", world)
                    .await
                    .unwrap_err(),
                delete_world_backup_with(&env.facade, "生存", world, "1-auto.zip", Remove)
                    .await
                    .unwrap_err(),
            ] {
                assert_eq!(err.code, common::INVALID_ARGUMENT, "{world:?}");
                assert_eq!(err.detail.unwrap()["field"], "world", "{world:?}");
            }
        }
        for file in ["", "../index.json", "..", "a/b.zip", ".zip"] {
            let err = restore_world_backup_with(
                &w.with(&env),
                "t",
                "生存",
                "新的世界",
                file,
                Recorder::default(),
                &events,
            )
            .await
            .unwrap_err();
            assert_eq!(err.code, common::INVALID_ARGUMENT, "{file:?}");
            assert_eq!(err.detail.unwrap()["field"], "file", "{file:?}");
        }
        for id in ["../生存", "", ".hidden", r"a\b"] {
            let err = backup_world_with(&w.with(&env), "t", id, "新的世界", &events)
                .await
                .unwrap_err();
            assert_eq!(err.code, common::INVALID_ARGUMENT, "{id:?}");
            let detail = err.detail.unwrap();
            assert_eq!(
                (&detail["field"], &detail["reason"]),
                (&json!("id"), &json!("unsafe_id")),
                "{id:?}"
            );
            assert_eq!(w.locks.activity(id), None);
        }
        let relative =
            export_world_with(&w.with(&env), "t", "生存", "新的世界", "导出.zip", &events)
                .await
                .unwrap_err();
        assert_eq!(relative.code, common::INVALID_ARGUMENT);
        let detail = relative.detail.unwrap();
        assert_eq!(
            (&detail["field"], &detail["reason"]),
            (&json!("dest"), &json!("not_absolute"))
        );
        let txt = env.dir.path().join("导出.txt");
        let not_zip = export_world_with(
            &w.with(&env),
            "t",
            "生存",
            "新的世界",
            txt.to_str().unwrap(),
            &events,
        )
        .await
        .unwrap_err();
        let detail = not_zip.detail.unwrap();
        assert_eq!(
            (&detail["field"], &detail["reason"]),
            (&json!("dest"), &json!("not_zip"))
        );
        assert!(!w.registry.is_running("t"));
        assert_eq!(w.locks.activity("生存"), Some(InstanceActivity::Running));
    }

    /// 导出位置的其余规则由门面判断：父目录不在、落在存档自己里面都报 invalid_argument（field 为 dest）；
    /// 已有同名文件则覆盖（系统保存对话框已经问过）。
    #[tokio::test]
    async fn export_checks_the_destination_and_overwrites_an_existing_file() {
        let env = Env::new();
        let world = env.isolated_world("生存", "新的世界");
        let w = WorldEnv::new();
        let (events, _rx) = sink();
        for dest in [
            env.dir.path().join("不存在").join("a.zip"),
            world.join("region").join("自己.zip"),
        ] {
            let err = export_world_with(
                &w.with(&env),
                "ex",
                "生存",
                "新的世界",
                dest.to_str().unwrap(),
                &events,
            )
            .await
            .unwrap_err();
            assert_eq!(err.code, common::INVALID_ARGUMENT, "{}", dest.display());
            assert_eq!(err.detail.unwrap()["field"], "dest", "{}", dest.display());
            assert!(!dest.exists());
        }
        let dest = env.dir.path().join("导出.zip");
        std::fs::write(&dest, b"old").unwrap();
        let exported = export_world_with(
            &w.with(&env),
            "ex",
            "生存",
            "新的世界",
            dest.to_str().unwrap(),
            &events,
        )
        .await
        .unwrap();
        assert!(exported.size_bytes > 3);
        assert!(zip_names(&dest).contains(&"新的世界/region/r.0.0.mca".to_owned()));
        let missing = export_world_with(
            &w.with(&env),
            "ex",
            "生存",
            "没有这个",
            dest.to_str().unwrap(),
            &events,
        )
        .await
        .unwrap_err();
        assert_eq!(missing.code, common::WORLD_NOT_FOUND);
    }

    fn files_with_suffix(dir: &Path, suffix: &str) -> Vec<PathBuf> {
        let mut found = Vec::new();
        let mut stack = vec![dir.to_path_buf()];
        while let Some(current) = stack.pop() {
            let Ok(entries) = std::fs::read_dir(&current) else {
                continue;
            };
            for entry in entries.flatten() {
                let path = entry.path();
                if entry.file_name().to_string_lossy().ends_with(suffix) {
                    found.push(path.clone());
                }
                if path.is_dir() {
                    stack.push(path);
                }
            }
        }
        found
    }

    /// 打包压不动的大存档时取消：1000 ms 内以 cancelled 返回，.part 删掉，备份列表里没有半截，实例与任务都放开。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn cancelling_a_backup_returns_in_time_and_leaves_no_part_file() {
        let env = Env::new();
        let world = env.isolated_world("生存", "大存档");
        for i in 0..4 {
            std::fs::write(
                world.join("region").join(format!("r.{i}.0.mca")),
                noise(8 << 20, i + 1),
            )
            .unwrap();
        }
        let facade = env.facade.clone();
        let registry = Arc::new(TaskRegistry::default());
        let locks = InstanceLocks::default();
        let game = Arc::new(GameSlot::default());
        let (r, l, g) = (registry.clone(), locks.clone(), game.clone());
        let backup = tokio::spawn(async move {
            let ctx = WorldTaskEnv {
                facade: &facade,
                tasks: &r,
                locks: &l,
                game: &g,
            };
            let (events, _rx) = sink();
            backup_world_with(&ctx, "bk-big", "生存", "大存档", &events).await
        });

        let root = env.backups_root();
        let deadline = Instant::now() + Duration::from_secs(20);
        while files_with_suffix(&root, ".part").is_empty() {
            assert!(Instant::now() < deadline, "打包没有开始");
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        assert_eq!(locks.activity("生存"), Some(InstanceActivity::BackingUp));
        let cancelled_at = Instant::now();
        assert!(registry.cancel("bk-big"));
        let err = backup.await.unwrap().unwrap_err();
        let elapsed = cancelled_at.elapsed();

        assert_eq!(err.code, common::CANCELLED);
        assert!(elapsed < CANCEL_DEADLINE, "取消到返回耗时 {elapsed:?}");
        assert_eq!(files_with_suffix(&root, ".part"), Vec::<PathBuf>::new());
        assert_eq!(files_with_suffix(&root, ".zip"), Vec::<PathBuf>::new());
        assert!(!registry.is_running("bk-big"));
        assert_eq!(locks.activity("生存"), None);
        let listed = list_world_backups_with(&env.facade, "生存", "大存档")
            .await
            .unwrap();
        assert!(listed.backups.is_empty());
    }

    /// 按盘上布局直接放一份备份与它的索引（备份本体用不压缩的条目，解压时间主要花在建文件上）。
    fn plant_backup(env: &Env, id: &str, world: &str, file: &str, entries: &[(String, Vec<u8>)]) {
        use std::io::Write as _;
        let dir = env.backups_root().join("instances").join(id).join(world);
        std::fs::create_dir_all(&dir).unwrap();
        let zip_path = dir.join(file);
        let mut writer = zip::ZipWriter::new(std::fs::File::create(&zip_path).unwrap());
        let options = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Stored);
        for (name, bytes) in entries {
            writer
                .start_file(format!("{world}/{name}"), options)
                .unwrap();
            writer.write_all(bytes).unwrap();
        }
        writer.finish().unwrap();
        let size = std::fs::metadata(&zip_path).unwrap().len();
        let index = json!({
            "version": 1,
            "entries": [{
                "file": file, "kind": "manual", "created_at": 1_761_900_000_000_u64,
                "size_bytes": size, "level_name": world,
            }],
        });
        std::fs::write(dir.join("index.json"), index.to_string()).unwrap();
    }

    /// 解压一份文件很多的备份时取消：1000 ms 内以 cancelled 返回，临时目录删掉，现在的存档一个字节不动，
    /// 也没有交给回收站。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn cancelling_a_restore_returns_in_time_and_keeps_the_world() {
        let env = Env::new();
        let world = env.isolated_world("生存", "新的世界");
        let mut entries = vec![("level.dat".to_owned(), level_dat("新的世界"))];
        let chunk = noise(16 << 10, 7);
        entries.extend((0..3000).map(|i| (format!("region/r.{i}.mca"), chunk.clone())));
        plant_backup(
            &env,
            "生存",
            "新的世界",
            "1761900000000-manual.zip",
            &entries,
        );

        let facade = env.facade.clone();
        let registry = Arc::new(TaskRegistry::default());
        let locks = InstanceLocks::default();
        let game = Arc::new(GameSlot::default());
        let disposer = Recorder::default();
        let (r, l, g, d) = (
            registry.clone(),
            locks.clone(),
            game.clone(),
            disposer.clone(),
        );
        let restore = tokio::spawn(async move {
            let ctx = WorldTaskEnv {
                facade: &facade,
                tasks: &r,
                locks: &l,
                game: &g,
            };
            let (events, _rx) = sink();
            restore_world_backup_with(
                &ctx,
                "rs-big",
                "生存",
                "新的世界",
                "1761900000000-manual.zip",
                d,
                &events,
            )
            .await
        });

        let saves = world.parent().unwrap().to_path_buf();
        let staging = saves.join(format!("新的世界.{}-restore", aurora_base::brand::APP_SLUG));
        let deadline = Instant::now() + Duration::from_secs(20);
        while !staging.join("region").is_dir() {
            assert!(Instant::now() < deadline, "解压没有开始");
            tokio::time::sleep(Duration::from_millis(2)).await;
        }
        let cancelled_at = Instant::now();
        assert!(registry.cancel("rs-big"));
        let err = restore.await.unwrap().unwrap_err();
        let elapsed = cancelled_at.elapsed();

        assert_eq!(err.code, common::CANCELLED);
        assert!(elapsed < CANCEL_DEADLINE, "取消到返回耗时 {elapsed:?}");
        assert!(!staging.exists(), "临时目录应删掉");
        assert_eq!(
            std::fs::read(world.join("region").join("r.0.0.mca")).unwrap(),
            b"region-v1"
        );
        assert!(!world.join("region").join("r.1.mca").exists());
        assert!(disposer.disposed().is_empty(), "取消时不碰现在的存档");
        assert_eq!(locks.activity("生存"), None);
        assert!(!registry.is_running("rs-big"));
    }

    /// 恢复：现在的存档交给 disposer（生产环境是回收站），换上备份时的样子；备份不在报 world_backup_not_found。
    #[tokio::test]
    async fn restore_hands_the_current_world_to_the_disposer_and_puts_the_backup_back() {
        let env = Env::new();
        let world = env.isolated_world("生存", "新的世界");
        let level_before = std::fs::read(world.join("level.dat")).unwrap();
        let w = WorldEnv::new();
        let (events, _rx) = sink();
        let made = backup_world_with(&w.with(&env), "bk", "生存", "新的世界", &events)
            .await
            .unwrap();
        std::fs::write(world.join("region").join("r.0.0.mca"), b"region-v2").unwrap();
        std::fs::write(world.join("新加的.txt"), b"x").unwrap();
        std::fs::write(world.join("level.dat"), level_dat("改过的名字")).unwrap();

        let disposer = Recorder::default();
        let restored = restore_world_backup_with(
            &w.with(&env),
            "rs",
            "生存",
            "新的世界",
            &made.backup.file,
            disposer.clone(),
            &events,
        )
        .await
        .unwrap();
        assert_eq!(
            restored,
            RestoreResultDto {
                world: "新的世界".into(),
                previous_in_recycle_bin: true,
            }
        );
        assert_eq!(disposer.disposed(), vec![world.clone()]);
        assert_eq!(
            std::fs::read(world.join("region").join("r.0.0.mca")).unwrap(),
            b"region-v1"
        );
        assert_eq!(
            std::fs::read(world.join("level.dat")).unwrap(),
            level_before
        );
        assert!(!world.join("新加的.txt").exists());
        assert!(world.join("datapacks").is_dir(), "空目录也恢复出来");
        let saves = world.parent().unwrap();
        let names: Vec<String> = std::fs::read_dir(saves)
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(names, vec!["新的世界".to_owned()], "临时目录不留");
        assert_eq!(w.locks.activity("生存"), None);

        let err = restore_world_backup_with(
            &w.with(&env),
            "rs",
            "生存",
            "新的世界",
            "1-auto.zip",
            disposer.clone(),
            &events,
        )
        .await
        .unwrap_err();
        assert_eq!(err.code, common::WORLD_BACKUP_NOT_FOUND);
        assert_eq!(
            err.detail,
            Some(json!({ "id": "生存", "world": "新的世界", "file": "1-auto.zip" }))
        );
        assert_eq!(disposer.disposed().len(), 1, "找不到备份时不碰存档");
    }

    /// 存档被游戏打开着（session.lock 上有排他锁，外部启动器开的游戏也算）：备份报 world_in_use，不留任何文件。
    #[tokio::test]
    async fn backing_up_a_world_open_in_a_game_reports_world_in_use() {
        let env = Env::new();
        let world = env.isolated_world("生存", "新的世界");
        let w = WorldEnv::new();
        let (events, _rx) = sink();
        let session = std::fs::File::open(world.join("session.lock")).unwrap();
        session.lock().unwrap();

        let err = backup_world_with(&w.with(&env), "bk", "生存", "新的世界", &events)
            .await
            .unwrap_err();
        assert_eq!(err.code, common::WORLD_IN_USE);
        assert_eq!(
            err.detail.unwrap()["path"],
            json!(world.display().to_string())
        );
        assert_eq!(
            files_with_suffix(&env.backups_root(), ".zip"),
            Vec::<PathBuf>::new()
        );
        assert_eq!(
            files_with_suffix(&env.backups_root(), ".part"),
            Vec::<PathBuf>::new()
        );
        assert_eq!(w.locks.activity("生存"), None);

        session.unlock().unwrap();
        drop(session);
        backup_world_with(&w.with(&env), "bk", "生存", "新的世界", &events)
            .await
            .unwrap();
    }

    /// 删除备份：zip 交给 disposer，从列表里摘掉；再删一次报 world_backup_not_found。游戏运行中也能删（不占实例）。
    #[tokio::test]
    async fn deleting_a_backup_disposes_the_zip_and_drops_it_from_the_list() {
        let env = Env::new();
        env.isolated_world("生存", "新的世界");
        let w = WorldEnv::new();
        let (events, _rx) = sink();
        let first = backup_world_with(&w.with(&env), "bk", "生存", "新的世界", &events)
            .await
            .unwrap();
        let second = backup_world_with(&w.with(&env), "bk", "生存", "新的世界", &events)
            .await
            .unwrap();
        assert_ne!(first.backup.file, second.backup.file);

        let _game = w.locks.acquire("生存", InstanceActivity::Running).unwrap();
        let disposer = Recorder::default();
        delete_world_backup_with(
            &env.facade,
            "生存",
            "新的世界",
            &first.backup.file,
            disposer.clone(),
        )
        .await
        .unwrap();
        let listed = list_world_backups_with(&env.facade, "生存", "新的世界")
            .await
            .unwrap();
        assert_eq!(listed.backups, vec![second.backup.clone()]);
        assert_eq!(listed.total_bytes, second.backup.size_bytes);
        let dir = PathBuf::from(&listed.dir);
        assert_eq!(disposer.disposed(), vec![dir.join(&first.backup.file)]);
        assert!(!dir.join(&first.backup.file).exists());

        let err = delete_world_backup_with(
            &env.facade,
            "生存",
            "新的世界",
            &first.backup.file,
            disposer,
        )
        .await
        .unwrap_err();
        assert_eq!(err.code, common::WORLD_BACKUP_NOT_FOUND);
        assert_eq!(err.detail.unwrap()["file"], json!(first.backup.file));
    }

    /// 共用存档：另一个也不隔离的实例开着游戏时，备份报 instance_busy，detail.id 是那个实例；隔离实例自己的存档
    /// 不受影响。游戏放开后备份照常，共用这份存档的实例看到的是同一批备份。
    #[tokio::test]
    async fn shared_worlds_wait_for_another_shared_instance_in_game() {
        let env = Env::new();
        env.shared_world("甲", "共用");
        env.vanilla("乙");
        env.isolated_world("丙", "自己的");
        let w = WorldEnv::new();
        let (events, _rx) = sink();

        let loading = w.game.reserve("乙").unwrap();
        let err = backup_world_with(&w.with(&env), "bk", "甲", "共用", &events)
            .await
            .unwrap_err();
        assert_eq!(err.code, code::INSTANCE_BUSY);
        assert_eq!(
            err.detail,
            Some(json!({ "id": "乙", "activity": "launching" }))
        );
        assert!(!w.registry.is_running("bk"));
        assert_eq!(w.locks.activity("甲"), None, "被拒绝时实例占用随之放开");
        let err = restore_world_backup_with(
            &w.with(&env),
            "rs",
            "甲",
            "共用",
            "1-manual.zip",
            Recorder::default(),
            &events,
        )
        .await
        .unwrap_err();
        assert_eq!(err.detail.unwrap()["id"], "乙");

        backup_world_with(&w.with(&env), "bk", "丙", "自己的", &events)
            .await
            .unwrap();
        drop(loading);

        let made = backup_world_with(&w.with(&env), "bk", "甲", "共用", &events)
            .await
            .unwrap();
        let mine = list_world_backups_with(&env.facade, "甲", "共用")
            .await
            .unwrap();
        let theirs = list_world_backups_with(&env.facade, "乙", "共用")
            .await
            .unwrap();
        assert_eq!(mine.scope, "shared");
        assert_eq!(mine, theirs);
        assert_eq!(mine.backups, vec![made.backup]);
        assert_eq!(
            PathBuf::from(&mine.dir),
            env.backups_root().join("shared").join("共用")
        );
    }

    /// 反方向：另一个不隔离的实例正在备份共用存档时，不隔离的实例不能启动；隔离的照常，改动 Mod 不算。
    #[tokio::test]
    async fn launching_a_shared_instance_waits_for_another_shared_backup() {
        let env = Env::new();
        env.shared_world("甲", "共用");
        env.vanilla("乙");
        env.isolated_world("丙", "自己的");
        let locks = InstanceLocks::default();
        let aurora = env.facade.snapshot().await;
        ensure_shared_worlds_settled(&aurora, &locks, "乙")
            .await
            .unwrap();

        let backing = locks.acquire("甲", InstanceActivity::BackingUp).unwrap();
        let err = ensure_shared_worlds_settled(&aurora, &locks, "乙")
            .await
            .unwrap_err();
        assert_eq!(err.code, code::INSTANCE_BUSY);
        assert_eq!(
            err.detail,
            Some(json!({ "id": "甲", "activity": "backing_up" }))
        );
        ensure_shared_worlds_settled(&aurora, &locks, "丙")
            .await
            .unwrap();
        // 自己在备份时由实例锁挡，这里不重复报。
        ensure_shared_worlds_settled(&aurora, &locks, "甲")
            .await
            .unwrap();
        drop(backing);

        let isolated = locks.acquire("丙", InstanceActivity::BackingUp).unwrap();
        let modifying = locks.acquire("甲", InstanceActivity::Modifying).unwrap();
        ensure_shared_worlds_settled(&aurora, &locks, "乙")
            .await
            .unwrap();
        drop((isolated, modifying));
    }

    /// 按活动找实例时给出原样的 id（键是小写的），放开后不再列出。
    #[test]
    fn holders_are_reported_by_their_original_id() {
        let locks = InstanceLocks::default();
        let first = locks
            .acquire("Survival", InstanceActivity::BackingUp)
            .unwrap();
        let second = locks
            .acquire("survival", InstanceActivity::Modifying)
            .unwrap();
        let other = locks.acquire("创造", InstanceActivity::Running).unwrap();
        assert_eq!(
            locks.holding(InstanceActivity::BackingUp),
            vec!["Survival".to_owned()]
        );
        assert_eq!(
            locks.holding(InstanceActivity::Running),
            vec!["创造".to_owned()]
        );
        drop(first);
        assert!(locks.holding(InstanceActivity::BackingUp).is_empty());
        assert_eq!(
            locks.holding(InstanceActivity::Modifying),
            vec!["Survival".to_owned()],
            "同一个键还有占用时原样 id 不变"
        );
        drop((second, other));
        assert!(locks.holding(InstanceActivity::Modifying).is_empty());
        let again = locks
            .acquire("SURVIVAL", InstanceActivity::BackingUp)
            .unwrap();
        assert_eq!(
            locks.holding(InstanceActivity::BackingUp),
            vec!["SURVIVAL".to_owned()],
            "全部放开后再占用，按新的写法记"
        );
        drop(again);
    }

    /// 验收：改名后备份跟着新名字走，改名前的备份照常列出；删除实例的预览说明备份在哪、有几份，删除实例
    /// 不带走备份。
    #[tokio::test]
    async fn backups_follow_the_rename_and_outlive_the_instance() {
        let env = Env::new();
        env.isolated_world("a", "新的世界");
        let w = WorldEnv::new();
        let (events, _rx) = sink();
        let made = backup_world_with(&w.with(&env), "bk", "a", "新的世界", &events)
            .await
            .unwrap();

        rename_instance_with(&env.facade, &w.locks, "a", "b")
            .await
            .unwrap();
        let listed = list_world_backups_with(&env.facade, "b", "新的世界")
            .await
            .unwrap();
        assert_eq!(listed.backups, vec![made.backup.clone()]);
        let moved = env.backups_root().join("instances").join("b");
        assert_eq!(PathBuf::from(&listed.dir), moved.join("新的世界"));
        assert!(!env.backups_root().join("instances").join("a").exists());

        let preview = preview_dto(
            env.facade
                .snapshot()
                .await
                .deletion_preview("b")
                .await
                .unwrap(),
            None,
        );
        assert_eq!(preview.backup_count, 1);
        assert_eq!(PathBuf::from(&preview.backups_dir), moved);
        let json = serde_json::to_value(&preview).unwrap();
        assert_eq!(json["backup_count"], 1);

        delete_instance_with(&env.facade, &w.locks, "b", Remove)
            .await
            .unwrap();
        assert!(!env.game_dir().join("versions").join("b").exists());
        assert!(moved.join("新的世界").join(&made.backup.file).is_file());
    }

    /// 只差备份没挪成：报 world_backups_not_moved，detail.renamed_to 为新名字、path 为留在旧名下的备份目录，
    /// 目录与侧栏固定照样改好；游玩记录也没跟上时报游玩记录那一路。
    #[tokio::test]
    async fn backups_left_behind_by_a_rename_are_reported_with_their_place() {
        let env = Env::new();
        env.isolated_world("a", "新的世界");
        env.isolated_world("c", "新的世界");
        let w = WorldEnv::new();
        let (events, _rx) = sink();
        backup_world_with(&w.with(&env), "bk", "a", "新的世界", &events)
            .await
            .unwrap();
        backup_world_with(&w.with(&env), "bk", "c", "新的世界", &events)
            .await
            .unwrap();
        env.facade
            .update(|aurora| {
                aurora.set_sidebar_pins(vec!["a".into()]);
                Ok::<_, CommandError>(())
            })
            .await
            .unwrap();
        // 新名字下已经有一个同名的文件，备份目录挪不过去。
        let instances = env.backups_root().join("instances");
        std::fs::write(instances.join("b"), b"not a directory").unwrap();
        std::fs::write(instances.join("d"), b"not a directory").unwrap();

        let err = rename_instance_with(&env.facade, &w.locks, "a", "b")
            .await
            .unwrap_err();
        assert_eq!(err.code, code::WORLD_BACKUPS_NOT_MOVED);
        assert!(
            err.message
                .starts_with("实例已改名为「b」，但存档备份没能跟着挪："),
            "{}",
            err.message
        );
        let detail = err.detail.unwrap();
        assert_eq!(detail["id"], "a");
        assert_eq!(detail["renamed_to"], "b");
        assert_eq!(
            detail["path"],
            json!(instances.join("a").display().to_string())
        );
        assert!(env.game_dir().join("versions").join("b").is_dir());
        assert_eq!(env.saved_config().await.sidebar_pins, vec!["b".to_owned()]);
        assert!(instances
            .join("a")
            .join("新的世界")
            .join("index.json")
            .is_file());
        assert_eq!((w.locks.activity("a"), w.locks.activity("b")), (None, None));

        write_playtime(&env, "{ broken");
        let err = rename_instance_with(&env.facade, &w.locks, "c", "d")
            .await
            .unwrap_err();
        assert_eq!(
            err.code,
            code::PLAY_RECORDS_FAILED,
            "两路都失败时报游玩记录"
        );
        assert_eq!(err.detail.unwrap()["renamed_to"], "d");
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
