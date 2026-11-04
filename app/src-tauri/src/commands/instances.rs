//! 实例：列表、设置、内容、侧栏固定、新建（按实例名安装）、补全、删除、改名、移到另一个游戏目录、打开文件夹、
//! 存档备份与恢复，以及新建页要的版本清单、加载器版本与所需 Java。
//!
//! 会改动实例目录的操作（新建、整合包导入、补全、改名、删除、移动，启动与运行中的游戏，装、删、启停、
//! 更新、回滚 Mod 与装资源，以及备份、恢复、导出存档与删除存档备份）经 [`InstanceLocks`] 互斥，冲突时报 `instance_busy`
//! 并在 detail 里带上正在做的事。Mod 与资源的改动彼此之间、与启动和运行中的游戏、与存档备份之间可以并行
//! （运行中改不了的文件由门面的占用探测把关），与其余操作互斥。启动到游戏退出、补全、导入整合包与移动期间，实例继承链上的
//! 基底版本（客户端 jar 与 natives 所在的原版，导入时还有它要写的加载器版本）以 inherited 一并占住，启动、删除、
//! 改名、移动、补全基底报 `instance_busy` 并带上正在用它的实例；基底自己开着游戏时，这几件事反过来被基底挡住。

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use petalfall_core::folders::validate_game_dir;
use petalfall_core::{
    is_safe_instance_id, BackupKind, CoreError, DeletionPreview, Disposer, EventSink, GameSlot,
    IncompleteKind, IncompleteMarker, IncompleteOutcome, InstanceContent, InstanceError,
    InstanceInstallOutcome, InstanceRequest, InstanceSummary, InstanceVersion, IsolationOverride,
    JavaSelection, LevelInfo, LoaderChoice, LoaderKind, ManifestOverview, MarkerError,
    MarkerSettlement, MoveFollowUp, MoveOutcome, MovePreview, MoveRecovery, MoveRequest, PackEntry,
    Petalfall, Platform, PlaySummary, Readable, RecycleBin, RepairOutcome, Resolution,
    TemplateInfo, TemplateOutcome, TemplateSkip, VersionSettings, WorldBackup, WorldBackupList,
    WorldEntry, WorldScope,
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
use crate::commands::error::{code, move_blocker_json};

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
    /// 删除存档备份，或为打开文件夹建出工作目录下的子目录。
    Modifying,
    /// 别的实例正以它为基底（在那个实例的 `inheritsFrom` 链上）：那个实例启动到游戏退出、补全、导入整合包
    /// 期间都要读写这里的客户端 jar 与 natives。导入还以同样的名义占住要写的加载器版本：不在继承链上，但实例
    /// JSON 抄自它。只经 [`InstanceLocks::acquire_with_bases`] 占，占用里记着是哪个实例在用。
    Inherited,
    /// 备份、恢复或导出存档；游戏退出后的自动备份由启动命令把「运行」转成它，备份完才释放，基底在转的时候
    /// 就放开（[`ChainGuard::into_backup`]）。
    BackingUp,
    /// 移到另一个游戏目录：整个实例目录连同它的存档备份挪走。继承链上的基底以 inherited 一并占住：要读它们的
    /// 版本 JSON 与客户端 jar 补到目标里。
    Moving,
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
            InstanceActivity::Inherited => "被其他实例使用",
            InstanceActivity::BackingUp => "备份或恢复存档",
            InstanceActivity::Moving => "移到另一个游戏目录",
        }
    }

    /// 两件事能否同时在一个实例上进行。
    ///
    /// Mod、资源与设置的改动只往实例目录里加删、改写文件，彼此不冲突；游戏运行中仍允许改动，
    /// 被游戏占着的文件由门面在动手前探测并拒绝。改名、删除、移动、新建、补全会挪走或重写整个目录，
    /// 与任何事都互斥，否则改动会按旧路径把目录重新建出来。被别的实例当作基底时，基底照样能改动、备份，
    /// 几个实例也可以同时以它为基底；挪走或重写它的目录则会让那些实例丢掉客户端 jar 与 natives。基底自己的
    /// 启动与运行也与基底占用互斥：游戏映射着 natives，补全或导入要重写它们时会写到一半报 IO 错误，提前报
    /// `instance_busy` 比让任务半路失败好。占用槽全局只跑一个游戏，「基底运行时启动加载器实例」本来就走不到，
    /// 被挡住的只有补全与导入。
    ///
    /// 备份与恢复只碰 saves 下的一个存档与游戏目录里的备份区，和 Mod 改动、基底占用都不相交；游戏开着时
    /// 存档随时在写，打包出来的是半截，恢复则会被游戏下次保存覆盖，所以与启动、运行互斥。它的兼容集合比
    /// 「运行」宽，游戏退出后可以原地从「运行」转成它。数据包写进存档目录，是改动里的例外，由
    /// [`InstanceLocks::write_saves`] 另记一笔，两边互相看。
    fn compatible_with(self, other: Self) -> bool {
        use InstanceActivity::{BackingUp, Inherited, Launching, Modifying, Running};
        matches!(
            (self, other),
            (
                Modifying,
                Modifying | Launching | Running | BackingUp | Inherited
            ) | (Launching | Running | BackingUp, Modifying)
                | (Inherited, Modifying | BackingUp | Inherited)
                | (BackingUp, Inherited)
        )
    }

    /// 同一实例上有几件事并行时，对外报哪一件：实例自己的事最要紧，界面关心的是启动、运行与备份；
    /// 它的 Mod 改动其次；被别的实例当作基底排在最后。
    fn report_rank(self) -> u8 {
        match self {
            InstanceActivity::Modifying => 1,
            InstanceActivity::Inherited => 2,
            InstanceActivity::Installing
            | InstanceActivity::Repairing
            | InstanceActivity::Renaming
            | InstanceActivity::Deleting
            | InstanceActivity::Launching
            | InstanceActivity::Running
            | InstanceActivity::BackingUp
            | InstanceActivity::Moving => 0,
        }
    }
}

/// 一份占用。`used_by` 只在 [`InstanceActivity::Inherited`] 时有：正以这个实例为基底的那个实例。
struct Hold {
    token: u64,
    activity: InstanceActivity,
    used_by: Option<String>,
}

/// 一个实例上的全部占用。`next` 给每次占用发一个号，守卫凭号释放自己那一份。`ids` 记下每个键第一次占用时
/// 的原样 id：按活动找实例时要拿它去解析工作目录、写进 `instance_busy` 的 detail，不能用小写键代替。
#[derive(Default)]
struct LockTable {
    next: u64,
    held: HashMap<String, Vec<Hold>>,
    ids: HashMap<String, String>,
    /// 存档正被整份读走的实例（导出整合包勾了存档），每份记下号与原样 id。与占用分开记：导出对外仍是
    /// 「改动中」，与备份兼容，只有要替换存档的恢复需要看它。
    saves_readers: HashMap<String, Vec<(u64, String)>>,
    /// 正往存档目录里写东西的实例（装数据包），记法同上。对外同样是「改动中」，备份、恢复与带存档的导出看它。
    saves_writers: HashMap<String, Vec<(u64, String)>>,
}

/// 存档正被做什么。
#[derive(Clone, Copy)]
enum SavesUse {
    Read,
    Write,
}

impl LockTable {
    fn saves_marks(&mut self, kind: SavesUse) -> &mut HashMap<String, Vec<(u64, String)>> {
        match kind {
            SavesUse::Read => &mut self.saves_readers,
            SavesUse::Write => &mut self.saves_writers,
        }
    }
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
        assert_ne!(
            activity,
            InstanceActivity::Inherited,
            "基底占用要记下使用者，只经 acquire_with_bases 占"
        );
        self.hold(id, activity, None)
    }

    /// 占住实例 `id` 做 `activity`，同时以它的名义占住继承链上的基底版本 `bases`
    /// （[`petalfall_core::Petalfall::inheritance_chain`] 的结果，或导入要写的自然版本目录）。
    ///
    /// 先占实例自己，再依次占基底；任一处冲突都报 `instance_busy`（基底被占时 detail 里的 id 是那个基底），
    /// 已占到的随返回的错误一起放开。基底里与 `id` 同名（链成环）或彼此重复（不分大小写）的只占一次。
    pub fn acquire_with_bases(
        &self,
        id: &str,
        activity: InstanceActivity,
        bases: &[String],
    ) -> Result<ChainGuard, CommandError> {
        let own = self.acquire(id, activity)?;
        self.hold_bases(own, id, activity, bases)
    }

    /// 同 [`InstanceLocks::acquire_with_bases`]，基底要读盘才知道（`chain` 读实例的继承链）：占住实例自己之后
    /// 才去读。实例正被安装、补全、改名或删除时它的版本 JSON 可能正被替换或挪走，先读的话报出来的会是读文件
    /// 的错误而不是 `instance_busy`；占住之后链也不会再被别的命令改掉。读链失败时实例自己的占用随错误放开。
    pub async fn acquire_with_chain(
        &self,
        id: &str,
        activity: InstanceActivity,
        chain: impl std::future::Future<Output = Result<Vec<String>, CommandError>>,
    ) -> Result<ChainGuard, CommandError> {
        let own = self.acquire(id, activity)?;
        let bases = chain.await?;
        self.hold_bases(own, id, activity, &bases)
    }

    fn hold_bases(
        &self,
        own: InstanceGuard,
        id: &str,
        activity: InstanceActivity,
        bases: &[String],
    ) -> Result<ChainGuard, CommandError> {
        let mut keys = HashSet::from([lock_key(id)]);
        let mut held = Vec::with_capacity(bases.len());
        for base in bases {
            if keys.insert(lock_key(base)) {
                held.push(self.hold(base, InstanceActivity::Inherited, Some(id))?);
            }
        }
        if !held.is_empty() {
            tracing::debug!(id, ?activity, ?bases, "占用实例连同它的基底版本");
        }
        Ok(ChainGuard { own, _bases: held })
    }

    fn hold(
        &self,
        id: &str,
        activity: InstanceActivity,
        used_by: Option<&str>,
    ) -> Result<InstanceGuard, CommandError> {
        let key = lock_key(id);
        let mut table = lock_table(&self.table);
        // 冲突有几处时报列表里也报的那一件（实例自己的事、modifying、inherited 依次），不随哪份占用先到而变，
        // 否则基底自己在运行时，被拒的删除会说成「正在被别的实例使用」，与界面上的状态对不上。
        if let Some(conflict) = table.held.get(&key).and_then(|holds| {
            holds
                .iter()
                .filter(|h| !activity.compatible_with(h.activity))
                .min_by_key(|h| h.activity.report_rank())
        }) {
            return Err(busy_by(id, conflict));
        }
        let token = table.next;
        table.next += 1;
        table.held.entry(key.clone()).or_default().push(Hold {
            token,
            activity,
            used_by: used_by.map(str::to_owned),
        });
        table
            .ids
            .entry(key.clone())
            .or_insert_with(|| id.to_owned());
        tracing::debug!(id, ?activity, used_by, "占用实例");
        Ok(InstanceGuard {
            table: self.table.clone(),
            key,
            token,
        })
    }

    /// `bases` 里第一个此刻容不下基底占用的基底，连同挡路的那件事：补全、重新安装加载器沿继承链依次占基底时，
    /// 就停在它上面报 `instance_busy`，报的也是这一份。实例列表用它让界面提前禁用入口。
    pub fn blocking_base(&self, bases: &[String]) -> Option<BaseBusyDto> {
        let table = lock_table(&self.table);
        bases.iter().find_map(|base| {
            let conflict = table
                .held
                .get(&lock_key(base))?
                .iter()
                .filter(|h| !InstanceActivity::Inherited.compatible_with(h.activity))
                .min_by_key(|h| h.activity.report_rank())?;
            Some(BaseBusyDto {
                id: base.clone(),
                activity: conflict.activity,
            })
        })
    }

    /// 实例此刻在做的事，同 [`InstanceLocks::occupancy`] 的前一半；只有用例单看它。
    #[cfg(test)]
    pub fn activity(&self, id: &str) -> Option<InstanceActivity> {
        self.occupancy(id).0
    }

    /// 实例此刻在做的事（有几件并行时报最值得界面知道的那一件）与正以它为基底的实例（有几个时报最早占到的
    /// 那个，与 instance_busy 报的是同一个；没被当作基底时为 `None`），在同一次查表里取出。实例列表与删除预览
    /// 用它：分两次查的话，两次之间别的命令占上或放开基底，就会报出「inherited 却没有 used_by」这类对不上的一对。
    pub fn occupancy(&self, id: &str) -> (Option<InstanceActivity>, Option<String>) {
        let table = lock_table(&self.table);
        let Some(holds) = table.held.get(&lock_key(id)) else {
            return (None, None);
        };
        let activity = holds
            .iter()
            .map(|h| h.activity)
            .min_by_key(|activity| activity.report_rank());
        (activity, holds.iter().find_map(|h| h.used_by.clone()))
    }

    /// 记下实例 `id` 的存档正被整份读走（导出整合包勾了存档）；返回的守卫被丢弃即撤销。恢复存档开始前经
    /// `ensure_saves_not_read` 看这份记录。
    ///
    /// 导出先记下、再查有没有备份或恢复在做；恢复先占 BackingUp、再看这份记录。两边都是先写自己的、再读对方的，
    /// 同一时刻发起时至少有一方会看到另一方，不会两边都放行。
    pub fn read_saves(&self, id: &str) -> SavesGuard {
        self.mark_saves(id, SavesUse::Read)
    }

    /// 记下实例 `id` 正往存档目录里写东西（装数据包）；返回的守卫被丢弃即撤销。备份、恢复与带存档的导出开始前
    /// 看这份记录，写法同 [`read_saves`](Self::read_saves)：先写自己的、再读对方的。
    pub fn write_saves(&self, id: &str) -> SavesGuard {
        self.mark_saves(id, SavesUse::Write)
    }

    fn mark_saves(&self, id: &str, kind: SavesUse) -> SavesGuard {
        let key = lock_key(id);
        let mut table = lock_table(&self.table);
        let token = table.next;
        table.next += 1;
        table
            .saves_marks(kind)
            .entry(key.clone())
            .or_default()
            .push((token, id.to_owned()));
        SavesGuard {
            table: self.table.clone(),
            key,
            token,
            kind,
        }
    }

    /// 此刻存档正被整份读走的实例（原样的 id，每个实例一次）。
    pub fn reading_saves(&self) -> Vec<String> {
        self.marked_saves(SavesUse::Read)
    }

    /// 此刻正往存档目录里写东西的实例（原样的 id，每个实例一次）。
    pub fn writing_saves(&self) -> Vec<String> {
        self.marked_saves(SavesUse::Write)
    }

    fn marked_saves(&self, kind: SavesUse) -> Vec<String> {
        lock_table(&self.table)
            .saves_marks(kind)
            .values()
            .filter_map(|marks| marks.first().map(|(_, id)| id.clone()))
            .collect()
    }

    /// 此刻占着 `activity` 的实例（原样的 id）。
    pub fn holding(&self, activity: InstanceActivity) -> Vec<String> {
        let table = lock_table(&self.table);
        table
            .held
            .iter()
            .filter(|(_, holds)| holds.iter().any(|h| h.activity == activity))
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
    /// 转向兼容集合不比原来窄的事，这时不会新出冲突，所以不重新检查。
    pub fn set_activity(&self, activity: InstanceActivity) {
        let mut table = lock_table(&self.table);
        let hold = table
            .held
            .get_mut(&self.key)
            .and_then(|holds| holds.iter_mut().find(|h| h.token == self.token))
            .expect("守卫存活期间它的占用一定还在表里");
        hold.activity = activity;
    }
}

/// 一份「存档正被读走或写入」的记录；丢弃即撤销。
pub struct SavesGuard {
    table: Arc<Mutex<LockTable>>,
    key: String,
    token: u64,
    kind: SavesUse,
}

impl Drop for SavesGuard {
    fn drop(&mut self) {
        let mut table = lock_table(&self.table);
        let all = table.saves_marks(self.kind);
        if let Some(marks) = all.get_mut(&self.key) {
            marks.retain(|(token, _)| *token != self.token);
            if marks.is_empty() {
                all.remove(&self.key);
            }
        }
    }
}

impl Drop for InstanceGuard {
    fn drop(&mut self) {
        let mut table = lock_table(&self.table);
        if let Some(holds) = table.held.get_mut(&self.key) {
            holds.retain(|h| h.token != self.token);
            if holds.is_empty() {
                table.held.remove(&self.key);
                table.ids.remove(&self.key);
            }
        }
    }
}

/// 一个实例连同它继承链上基底版本的占用：任务期间一起持有，丢弃即一起释放。
pub struct ChainGuard {
    own: InstanceGuard,
    _bases: Vec<InstanceGuard>,
}

impl ChainGuard {
    /// 改记实例自己正在做的事，基底的占用不变；约束同 [`InstanceGuard::set_activity`]。
    pub fn set_activity(&self, activity: InstanceActivity) {
        self.own.set_activity(activity);
    }

    /// 游戏退出、转去自动备份：实例自己原地转成「备份」，基底当即放开。自动备份只读实例自己的版本 JSON、设置与
    /// 存档，不碰基底的目录；基底留到备份做完的话，这段时间里基底启动不了。
    pub fn into_backup(self) -> InstanceGuard {
        self.own.set_activity(InstanceActivity::BackingUp);
        self.own
    }
}

fn lock_key(id: &str) -> String {
    id.to_lowercase()
}

/// 被一份占用挡住：被别的实例当作基底时说清是谁在用，detail 带上 `used_by`；其余同 [`busy`]。
fn busy_by(id: &str, conflict: &Hold) -> CommandError {
    match &conflict.used_by {
        Some(user) => CommandError::new(
            code::INSTANCE_BUSY,
            format!("实例 {id} 正在被实例 {user} 使用，请稍后再试"),
        )
        .with_detail(json!({ "id": id, "activity": conflict.activity, "used_by": user })),
        None => busy(id, conflict.activity),
    }
}

pub(crate) fn busy(id: &str, activity: InstanceActivity) -> CommandError {
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
    /// ready：版本 JSON 可用；broken：缺失或损坏，见 broken_reason。只说版本 JSON，安装写到一半时也是 ready：
    /// 判断能不能用要同时看 incomplete 为空。
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
    /// 工作目录 mods/ 下的 Mod 文件数；broken、设置或工作目录读不出时为 null。
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
    /// 实例目录的创建时刻（Unix 毫秒）；文件系统不记录或目录读不出时为 null。
    pub created_at: Option<u64>,
    /// 实例目录或工作目录读不出来的原因；此时 created_at 或 mod_count、world_count、isolated 为 null。
    pub dir_error: Option<String>,
    /// 实例此刻在做的事；空闲为 null。
    pub activity: Option<InstanceActivity>,
    /// 正以它为基底的实例（有几个时为最早占到的那个）；没有被别的实例当作基底时为 null。
    /// 非空时删除、改名、补全它会报 instance_busy。
    pub used_by: Option<String>,
    /// 继承链上此刻容不下基底占用的基底；非空时补全、重新安装加载器它会报 instance_busy。版本 JSON 用不了
    /// 的实例读不出链，补全也不占基底，为 null。
    pub base_busy: Option<BaseBusyDto>,
    /// 累计游玩分钟（向下取整）；没玩过为 0，游玩记录读不出时为 null。
    pub playtime_min: Option<u64>,
    /// 上次游玩结束的 Unix 毫秒；没玩过或游玩记录读不出时为 null。
    pub last_played_at: Option<u64>,
    /// 游玩记录读不出来的原因。
    pub play_error: Option<String>,
}

/// 挡着基底占用的基底：哪个版本、在做什么。形状与这时 `instance_busy` 的 detail 相同。
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct BaseBusyDto {
    pub id: String,
    pub activity: InstanceActivity,
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
    /// 正以它为基底的实例；含义同实例列表的 used_by。
    pub used_by: Option<String>,
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

/// 移到另一个游戏目录前的预检。字段含义同 [`MovePreview`]。
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct MovePreviewDto {
    pub id: String,
    /// 实例现在所在的游戏目录（当前目录）。
    pub source: String,
    pub target: String,
    /// 目标在游戏目录列表里的显示名；还没记录的文件夹按同一规则推出，移动成功后就以这个名字记进列表。
    pub target_name: String,
    /// 目标是否已是当前目录或已记录的额外目录。
    pub target_registered: bool,
    pub same_volume: bool,
    pub instance_bytes: u64,
    pub instance_files: u64,
    pub backup_bytes: u64,
    pub backup_count: u32,
    pub dependency_files: u64,
    pub dependency_bytes: u64,
    pub bases_to_copy: Vec<String>,
    pub reused_bases: Vec<String>,
    pub missing_in_source: u64,
    /// 要写进目标盘的字节，不含余量；含余量的要求见 insufficient_space 拦截项的 needed。
    pub required_bytes: u64,
    /// 目标盘剩余的字节。
    pub available_bytes: u64,
    pub isolated: bool,
    /// 形状同 instance_move_blocked 的 detail.blocker（`move_blocker_json`）；为空才能移。
    pub blockers: Vec<Value>,
}

/// 移动完成后没跟过去、要提示玩家的一项。
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum MoveFollowUpDto {
    /// 游玩记录没挪过去，已记下待补。
    PlayRecords { reason: String },
    /// 存档备份没挪过去，留在原游戏目录。
    WorldBackups { reason: String },
    /// 原游戏目录里的旧文件没删干净，下次启动再清。
    Cleanup { path: String, reason: String },
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct MoveOutcomeDto {
    pub id: String,
    pub source: String,
    pub target: String,
    /// 目标在游戏目录列表里的显示名。
    pub target_name: String,
    /// 目标是这次新记进游戏目录列表的。
    pub registered: bool,
    /// 为空即全部跟过去了。
    pub follow_ups: Vec<MoveFollowUpDto>,
}

/// 装上的加载器。
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct InstalledLoaderDto {
    /// fabric / quilt / forge / neoforge。
    pub kind: &'static str,
    pub version: String,
}

/// 默认设置里的一个文件。
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct TemplateFileDto {
    pub name: &'static str,
    pub size: u64,
}

/// 默认设置的现状。
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct TemplateInfoDto {
    pub present: bool,
    /// 按白名单顺序。
    pub files: Vec<TemplateFileDto>,
    /// 从哪个实例保存来的；文件是手放进数据目录的为 null。
    pub source_instance: Option<String>,
    /// 保存的时刻（Unix 毫秒）。
    pub saved_at: Option<u64>,
    /// 配置里是否开着「新建实例时沿用默认设置」。
    pub enabled: bool,
}

impl From<TemplateInfo> for TemplateInfoDto {
    fn from(info: TemplateInfo) -> Self {
        Self {
            present: info.present(),
            files: info
                .files
                .into_iter()
                .map(|file| TemplateFileDto {
                    name: file.name,
                    size: file.size,
                })
                .collect(),
            source_instance: info.source_instance,
            saved_at: info.saved_at,
            enabled: info.enabled,
        }
    }
}

/// 套默认设置的结果。
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum TemplateOutcomeDto {
    Applied {
        copied: Vec<&'static str>,
        kept: Vec<&'static str>,
    },
    Skipped {
        reason: TemplateSkip,
    },
}

impl From<TemplateOutcome> for TemplateOutcomeDto {
    fn from(outcome: TemplateOutcome) -> Self {
        match outcome {
            TemplateOutcome::Applied { copied, kept } => Self::Applied { copied, kept },
            TemplateOutcome::Skipped(reason) => Self::Skipped { reason },
        }
    }
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
    /// 套默认设置的结果；没请求套用时为 null。
    pub template: Option<TemplateOutcomeDto>,
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
    play: Readable<Option<&PlaySummary>>,
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
    let (playtime_min, last_played_at, play_error) = match play {
        Readable::Read(play) => (
            Some(play.map_or(0, |p| p.playtime_min)),
            play.map(|p| p.last_played_at),
            None,
        ),
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
        dir_error: summary.dir_error,
        activity,
        used_by: None,
        base_busy: None,
        playtime_min,
        last_played_at,
        play_error,
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
            dto.broken_reason = Some(petalfall_core::broken_reason_text(&reason));
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

/// 删除预览带上实例此刻的占用：它在做的事与正以它为基底的实例，删除确认据此提前说明为什么删不了。
fn preview_dto(preview: DeletionPreview, locks: &InstanceLocks) -> DeletionPreviewDto {
    let (activity, used_by) = locks.occupancy(&preview.id);
    DeletionPreviewDto {
        activity,
        used_by,
        id: preview.id,
        worlds: preview.worlds.into_iter().map(world_dto).collect(),
        size_bytes: preview.size_bytes,
        file_count: preview.file_count,
        dependents: preview.dependents,
        backups_dir: preview.backups_dir.display().to_string(),
        backup_count: preview.backup_count,
    }
}

fn move_preview_dto(
    preview: MovePreview,
    target_name: String,
    target_registered: bool,
) -> MovePreviewDto {
    MovePreviewDto {
        id: preview.id,
        source: preview.source_game_dir.display().to_string(),
        target: preview.target_game_dir.display().to_string(),
        target_name,
        target_registered,
        same_volume: preview.same_volume,
        instance_bytes: preview.instance_bytes,
        instance_files: preview.instance_files,
        backup_bytes: preview.backup_bytes,
        backup_count: preview.backup_count,
        dependency_files: preview.dependency_files,
        dependency_bytes: preview.dependency_bytes,
        bases_to_copy: preview.bases_to_copy,
        reused_bases: preview.reused_bases,
        missing_in_source: preview.missing_in_source,
        required_bytes: preview.required_bytes,
        available_bytes: preview.available_bytes,
        isolated: preview.isolated,
        blockers: preview.blockers.iter().map(move_blocker_json).collect(),
    }
}

fn move_follow_up_dto(follow_up: MoveFollowUp) -> MoveFollowUpDto {
    match follow_up {
        MoveFollowUp::PlayRecords(reason) => MoveFollowUpDto::PlayRecords { reason },
        MoveFollowUp::WorldBackups(reason) => MoveFollowUpDto::WorldBackups { reason },
        MoveFollowUp::Cleanup { path, reason } => MoveFollowUpDto::Cleanup {
            path: path.display().to_string(),
            reason,
        },
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
        template: outcome.template.map(TemplateOutcomeDto::from),
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
    let petalfall = facade.snapshot().await;
    let list = petalfall.list_instances().await.map_err(instance_error)?;
    // 游玩记录只是实例的附属信息：读不懂时每个实例带上原因，列表照常给出，界面写「读不到」而不是 0。
    let plays = match petalfall.play_summaries().await {
        Ok(plays) => Readable::Read(plays),
        Err(err) => {
            let reason = petalfall_base::error_with_causes(&err);
            tracing::warn!(error = %reason, "游玩记录读不出来");
            Readable::Unreadable(reason)
        }
    };
    Ok(list
        .into_iter()
        .map(|summary| {
            let (activity, used_by) = locks.occupancy(&summary.id);
            let base_busy = match &summary.version {
                InstanceVersion::Ready(ready) => locks.blocking_base(&ready.bases),
                InstanceVersion::Broken(_) => None,
            };
            let play = match &plays {
                Readable::Read(plays) => Readable::Read(plays.get(&summary.id)),
                Readable::Unreadable(reason) => Readable::Unreadable(reason.clone()),
            };
            InstanceDto {
                used_by,
                base_busy,
                ..instance_dto(summary, activity, play)
            }
        })
        .collect())
}

/// 读取实例设置；没有自定义过时为默认值。
#[tauri::command]
pub async fn get_instance_settings(
    id: String,
    facade: State<'_, Facade>,
) -> Result<InstanceSettingsDto, CommandError> {
    let petalfall = facade.snapshot().await;
    Ok(petalfall
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
    let petalfall = facade.snapshot().await;
    let settings = VersionSettings::from(dto);
    petalfall
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
    let petalfall = facade.snapshot().await;
    Ok(content_dto(
        petalfall
            .instance_content(&id)
            .await
            .map_err(instance_error)?,
    ))
}

// ---------------------------------------------------------------- 侧栏固定

/// 侧栏固定的实例（按顺序），已不存在或不在实例库里的不返回。
#[tauri::command]
pub async fn get_sidebar_pins(facade: State<'_, Facade>) -> Result<Vec<String>, CommandError> {
    let petalfall = facade.snapshot().await;
    petalfall
        .existing_sidebar_pins()
        .await
        .map_err(instance_error)
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
        .update(|petalfall| {
            petalfall.set_sidebar_pins(pins.clone());
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
///
/// `use_template`（前端传 `useTemplate`）为 true 时，装好后把默认设置补进实例，结果在出参的 `template`
/// 里。缺省按 false：旧任务表里重放的新建任务没有这个键，前端新入队的任务一律显式传。
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn install_version(
    app: AppHandle,
    task_id: String,
    id: String,
    loader: Option<String>,
    loader_version: Option<String>,
    target_name: String,
    use_template: Option<bool>,
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
            use_template: use_template.unwrap_or(false),
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
    pub use_template: bool,
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
        use_template: args.use_template,
    };
    request.validate()?;
    let name = args.target_name;
    let petalfall = facade.snapshot().await;
    petalfall
        .check_new_instance_name(&name)
        .await
        .map_err(instance_error)?;
    let _guard = locks.acquire(&name, InstanceActivity::Installing)?;
    let task = tasks.register(task_id)?;
    let petalfall = petalfall.with_cancel(task.token().clone());
    let marker = petalfall
        .create_instance_dir(&name, &request)
        .await
        .map_err(instance_error)?;
    let outcome = task
        .run(async {
            petalfall
                .install_instance(&name, &request, Some(events))
                .await
                .map_err(instance_error)
        })
        .await;
    match outcome {
        Ok(outcome) => {
            petalfall
                .settle_instance_marker(&name, marker, MarkerSettlement::Succeeded)
                .await
                .map_err(instance_error)?;
            Ok(install_result_dto(outcome))
        }
        Err(err) if err.is_cancelled() => {
            if let Err(abandon_err) = petalfall.abandon_instance(&name).await {
                tracing::warn!(name, error = %abandon_err, "取消后删除实例目录失败，改为记下已取消");
                settle_quietly(&petalfall, &name, marker, MarkerSettlement::Cancelled).await;
            }
            Err(err)
        }
        Err(err) => {
            settle_quietly(&petalfall, &name, marker, failed(&err)).await;
            Err(err)
        }
    }
}

/// 补全实例：新建没装完的照当初的内容重装，其余按现有版本 JSON 补齐缺失文件。长任务，可取消；
/// 结局写进未完成标记（成功即清除）。
///
/// `reinstall_loader`（前端传 `reinstallLoader`）为 true 时把版本 JSON 里读出的加载器原样重装一遍，版本号、
/// Mod、配置与存档不变；读不出能原样装回的内容时报 `instance_failed`。占用与补全相同。缺省按 false：
/// 旧任务表里重放的补全任务没有这个键。
#[tauri::command]
pub async fn repair_instance(
    app: AppHandle,
    task_id: String,
    id: String,
    reinstall_loader: Option<bool>,
    facade: State<'_, Facade>,
    tasks: State<'_, TaskRegistry>,
    locks: State<'_, InstanceLocks>,
) -> Result<RepairResultDto, CommandError> {
    let events = CoreEventForwarder::to_app(&app, Some(task_id.clone()));
    let outcome = if reinstall_loader.unwrap_or(false) {
        reinstall_loader_with(&facade, &tasks, &locks, &task_id, &id, events.sink()).await
    } else {
        repair_instance_with(&facade, &tasks, &locks, &task_id, &id, events.sink()).await
    };
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
    run_repair(facade, tasks, locks, task_id, id, false, events).await
}

pub(crate) async fn reinstall_loader_with(
    facade: &Facade,
    tasks: &TaskRegistry,
    locks: &InstanceLocks,
    task_id: &str,
    id: &str,
    events: &EventSink,
) -> Result<RepairResultDto, CommandError> {
    run_repair(facade, tasks, locks, task_id, id, true, events).await
}

async fn run_repair(
    facade: &Facade,
    tasks: &TaskRegistry,
    locks: &InstanceLocks,
    task_id: &str,
    id: &str,
    reinstall_loader: bool,
    events: &EventSink,
) -> Result<RepairResultDto, CommandError> {
    let petalfall = facade.snapshot().await;
    // 传统布局的加载器实例把客户端 jar 与 natives 补进继承链根的目录：补全期间基底不能被删、改名或补全。
    // 依赖检查只在删除、改名动手那一刻扫一次，挡不住补全中途的这些操作。
    let _guard = locks
        .acquire_with_chain(id, InstanceActivity::Repairing, async {
            petalfall
                .inheritance_chain(id)
                .await
                .map_err(instance_error)
        })
        .await?;
    let task = tasks.register(task_id)?;
    let petalfall = petalfall.with_cancel(task.token().clone());
    let begun = if reinstall_loader {
        petalfall.begin_loader_reinstall(id).await
    } else {
        petalfall.begin_repair(id).await
    };
    let (plan, marker) = begun.map_err(instance_error)?;
    let outcome = task
        .run(async {
            petalfall
                .repair_instance(id, &plan, Some(events))
                .await
                .map_err(instance_error)
        })
        .await;
    match outcome {
        Ok(outcome) => {
            petalfall
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
            settle_quietly(&petalfall, id, marker, settlement).await;
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
    petalfall: &Petalfall,
    id: &str,
    marker: IncompleteMarker,
    settlement: MarkerSettlement,
) {
    if let Err(err) = petalfall
        .settle_instance_marker(id, marker, settlement)
        .await
    {
        tracing::error!(id, error = %err, "记录实例未完成标记失败");
    }
}

// ---------------------------------------------------------------- 新实例的默认设置

/// 默认设置（模板）的现状：有哪些文件、从哪个实例保存来的、配置里开没开。
#[tauri::command]
pub async fn template_info(facade: State<'_, Facade>) -> Result<TemplateInfoDto, CommandError> {
    template_info_with(&facade).await
}

pub(crate) async fn template_info_with(facade: &Facade) -> Result<TemplateInfoDto, CommandError> {
    let petalfall = facade.snapshot().await;
    Ok(petalfall
        .template_info()
        .await
        .map_err(instance_error)?
        .into())
}

/// 把实例工作目录里的 options.txt、服务器列表等设置文件存成默认设置，整份替换旧的，返回新的状态。
///
/// 只读实例，但改名、删除、新建、补全期间实例目录会被挪走，所以以「改动」占住实例；游戏运行中可以
/// 保存，读的是此刻磁盘上的文件。实例里一个设置文件都没有时报 `template_source_empty`。
#[tauri::command]
pub async fn save_instance_as_template(
    id: String,
    facade: State<'_, Facade>,
    locks: State<'_, InstanceLocks>,
) -> Result<TemplateInfoDto, CommandError> {
    save_instance_as_template_with(&facade, &locks, &id).await
}

pub(crate) async fn save_instance_as_template_with(
    facade: &Facade,
    locks: &InstanceLocks,
    id: &str,
) -> Result<TemplateInfoDto, CommandError> {
    // 先于占锁校验：不安全的 id 不该在互斥表里留下一行，报错形状与门面的 InvalidId 相同。
    if !is_safe_instance_id(id) {
        return Err(CoreError::from(InstanceError::InvalidId { id: id.to_owned() }).into());
    }
    let _guard = locks.acquire(id, InstanceActivity::Modifying)?;
    let petalfall = facade.snapshot().await;
    Ok(petalfall
        .save_template_from_instance(id)
        .await
        .map_err(instance_error)?
        .into())
}

/// 清除默认设置；本来就没有也算成功。返回清除后的状态。
#[tauri::command]
pub async fn clear_template(facade: State<'_, Facade>) -> Result<TemplateInfoDto, CommandError> {
    clear_template_with(&facade).await
}

pub(crate) async fn clear_template_with(facade: &Facade) -> Result<TemplateInfoDto, CommandError> {
    let petalfall = facade.snapshot().await;
    Ok(petalfall
        .clear_template()
        .await
        .map_err(instance_error)?
        .into())
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
    let petalfall = facade.snapshot().await;
    let preview = petalfall
        .deletion_preview(&id)
        .await
        .map_err(instance_error)?;
    Ok(preview_dto(preview, &locks))
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
        .update_if_changed(|petalfall| petalfall.forget_instance(id))
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
    records: petalfall_core::Result<()>,
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
    backups: petalfall_core::Result<()>,
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
        .update_if_changed(|petalfall| petalfall.rename_instance_refs(id, new_name))
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

// ---------------------------------------------------------------- 移到另一个游戏目录

/// 把实例从当前游戏目录移到 `target` 前的预检，不写盘、不占实例：要搬多少、目标盘够不够、有没有拦着的问题。
/// `target` 可以是还没记录、甚至还不存在的文件夹；不是绝对路径或含 `!` 时报 `invalid_game_directory`。
#[tauri::command]
pub async fn preview_instance_move(
    id: String,
    target: String,
    facade: State<'_, Facade>,
) -> Result<MovePreviewDto, CommandError> {
    preview_instance_move_with(&facade, &id, &target).await
}

pub(crate) async fn preview_instance_move_with(
    facade: &Facade,
    id: &str,
    target: &str,
) -> Result<MovePreviewDto, CommandError> {
    let target = validate_game_dir(target)?;
    let snapshot = facade.snapshot().await;
    let preview = snapshot
        .preview_instance_move(id, &target)
        .await
        .map_err(instance_error)?;
    Ok(move_preview_dto(
        preview,
        snapshot.game_directory_name(&target),
        snapshot.is_known_game_directory(&target),
    ))
}

/// 把实例从当前游戏目录移到 `target`：实例目录、存档备份与游玩记录跟过去，目标缺的库、资源与基底版本从原目录
/// 补过去；原目录里的侧栏固定与当前选中去掉，目标还没记录时记进游戏目录列表。长任务：进度经 core-event 推送并带
/// `task_id`，提交开始之前可经 `cancel_task(taskId)` 取消，之后不再理会取消、照常成功返回。
///
/// 实例在忙报 `instance_busy`；执行前重新预检有拦着的问题报 `instance_move_blocked`（detail.blocker 同预检
/// 的一项）；跨盘复制读回比对不上报 `instance_move_verify_failed`，已回滚、原件没动。文件已经移好、只是配置没能
/// 落盘时报配置的错误，message 说明实例已在目标里，detail.moved_to 为目标目录。
#[tauri::command]
pub async fn move_instance(
    app: AppHandle,
    task_id: String,
    id: String,
    target: String,
    facade: State<'_, Facade>,
    tasks: State<'_, TaskRegistry>,
    locks: State<'_, InstanceLocks>,
) -> Result<MoveOutcomeDto, CommandError> {
    let events = CoreEventForwarder::to_app(&app, Some(task_id.clone()));
    let outcome = move_instance_with(
        &facade,
        &tasks,
        &locks,
        &task_id,
        &id,
        &target,
        events.sink(),
    )
    .await;
    events.finish().await;
    crate::textures::refresh_on_success(&app, &outcome).await;
    outcome
}

pub(crate) async fn move_instance_with(
    facade: &Facade,
    tasks: &TaskRegistry,
    locks: &InstanceLocks,
    task_id: &str,
    id: &str,
    target: &str,
    events: &EventSink,
) -> Result<MoveOutcomeDto, CommandError> {
    let target = validate_game_dir(target)?;
    let snapshot = facade.snapshot().await;
    // 基底的版本 JSON 与客户端 jar 要补到目标里：移动期间基底不能被删、改名或补全。
    let _guard = locks
        .acquire_with_chain(id, InstanceActivity::Moving, async {
            snapshot.inheritance_chain(id).await.map_err(instance_error)
        })
        .await?;
    let task = tasks.register(task_id)?;
    let petalfall = snapshot.with_cancel(task.token().clone());
    // 不走 TaskHandle::run：门面在提交开始前自己看令牌，提交一旦开始就要做完；宽限期满丢弃 future 只是不再等它，
    // 后台线程照样把目录挪过去，用户却收到「已取消」，实例也放开了，配置里的引用更没人去改。
    let outcome = petalfall
        .move_instance_files(
            &MoveRequest {
                id: id.to_owned(),
                source_game_dir: petalfall.game_dir().to_path_buf(),
                target_game_dir: target,
            },
            Some(events.clone()),
        )
        .await
        .map_err(instance_error)?;
    let mut applied = None;
    let saved = facade
        .update_if_changed(|petalfall| {
            let refs = apply_move_refs(
                petalfall,
                &outcome.id,
                &outcome.source_game_dir,
                &outcome.target_game_dir,
            );
            let changed = refs.changed;
            applied = Some(refs);
            changed
        })
        .await;
    let applied = applied.expect("update_if_changed 总会调用改动闭包");
    if let Err(err) = saved {
        return Err(move_refs_not_saved(err, &outcome, &applied.target_name));
    }
    Ok(MoveOutcomeDto {
        id: outcome.id,
        source: outcome.source_game_dir.display().to_string(),
        target: outcome.target_game_dir.display().to_string(),
        target_name: applied.target_name,
        registered: applied.registered,
        follow_ups: outcome
            .follow_ups
            .into_iter()
            .map(move_follow_up_dto)
            .collect(),
    })
}

/// 一次提交了的移动改在配置上的结果。
struct MovedRefs {
    changed: bool,
    /// 目标是这次新记进游戏目录列表的。
    registered: bool,
    target_name: String,
}

/// 移动提交后改配置：去掉 `source` 里对实例的引用；目标还不在游戏目录列表里就以推出的名字记进去，否则移过去的
/// 实例在哪个列表里都找不到。在门面的可变副本上现场判断，不用开工时的快照：移动期间玩家可能切换了当前目录，
/// 甚至切到了目标。
fn apply_move_refs(petalfall: &mut Petalfall, id: &str, source: &Path, target: &Path) -> MovedRefs {
    let forgot = petalfall.forget_moved_instance(id, source);
    let registered = !petalfall.is_known_game_directory(target);
    let target_name = petalfall.game_directory_name(target);
    if registered {
        petalfall.add_game_directory(target_name.clone(), target);
    }
    MovedRefs {
        changed: forgot || registered,
        registered,
        target_name,
    }
}

/// 文件与记录都已移好、只差配置没落盘：码照配置的错误，message 与 detail 说清实例已经在目标里，前端照成功
/// 刷新列表再提示。门面没换进这次改动，原目录的侧栏固定与当前选中还指着已经不在的它，目标也还没记进列表。
fn move_refs_not_saved(err: CoreError, outcome: &MoveOutcome, target_name: &str) -> CommandError {
    if !outcome.follow_ups.is_empty() {
        tracing::warn!(id = outcome.id, follow_ups = ?outcome.follow_ups, "移动后有没跟过去的项");
    }
    let target = outcome.target_game_dir.display().to_string();
    let mut mapped = CommandError::from(err);
    mapped.message = format!(
        "实例已移到「{target_name}」（{target}），但配置没能保存：{}",
        mapped.message
    );
    merge_detail(&mut mapped, json!({ "id": outcome.id, "moved_to": target }));
    mapped
}

/// 启动时在后台收尾上次中断的移动。
pub fn recover_moves_in_background(app: &AppHandle) {
    use tauri::Manager;
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        recover_moves(&app.state::<Facade>()).await;
    });
}

/// 结论与失败都只进日志：这时还没有界面能提示，而移动日志留着，下次启动会再收一次；为它拦住启动的话，
/// 启动器就打不开了。
pub(crate) async fn recover_moves(facade: &Facade) {
    let recoveries = match facade.snapshot().await.recover_instance_moves().await {
        Ok(recoveries) => recoveries,
        Err(err) => {
            tracing::error!(error = %err, "收尾中断的实例移动失败，下次启动再试");
            return;
        }
    };
    for recovery in recoveries {
        settle_move_recovery(facade, recovery).await;
    }
}

/// 只有 Completed 改配置，照正常移动的口径：命令当时在改配置之前就中断了。
async fn settle_move_recovery(facade: &Facade, recovery: MoveRecovery) {
    match recovery {
        MoveRecovery::RolledBack {
            id,
            source_game_dir,
            target_game_dir,
        } => tracing::info!(
            id,
            source = %source_game_dir.display(),
            target = %target_game_dir.display(),
            "中断的实例移动已回滚，实例留在原游戏目录"
        ),
        MoveRecovery::Completed(outcome) => {
            let mut registered = false;
            let saved = facade
                .update_if_changed(|petalfall| {
                    let refs = apply_move_refs(
                        petalfall,
                        &outcome.id,
                        &outcome.source_game_dir,
                        &outcome.target_game_dir,
                    );
                    registered = refs.registered;
                    refs.changed
                })
                .await;
            match saved {
                Ok(_) => tracing::info!(
                    id = outcome.id,
                    source = %outcome.source_game_dir.display(),
                    target = %outcome.target_game_dir.display(),
                    registered,
                    follow_ups = ?outcome.follow_ups,
                    "中断的实例移动已补完"
                ),
                Err(err) => tracing::error!(
                    id = outcome.id,
                    source = %outcome.source_game_dir.display(),
                    target = %outcome.target_game_dir.display(),
                    error = %err,
                    "中断的实例移动已补完，但配置没能保存"
                ),
            }
        }
        // 引用在交出 Completed 或执行结果的那一次已经改过；再改的话，原目录里此后新建的同名实例会被摘掉固定与选中。
        MoveRecovery::Settled {
            id,
            source_game_dir,
            target_game_dir,
        } => tracing::info!(
            id,
            source = %source_game_dir.display(),
            target = %target_game_dir.display(),
            "中断的实例移动早已迁完，这次清掉了残留"
        ),
        MoveRecovery::Deferred { id, reason } => {
            tracing::warn!(id, reason, "中断的实例移动这次收不了尾，下次启动再试")
        }
    }
}

// ---------------------------------------------------------------- 新建页的元数据

/// 版本清单，每个版本附带可安装的加载器。断网时退回上次的缓存，并给出缓存时刻与原因。
#[tauri::command]
pub async fn list_manifest(facade: State<'_, Facade>) -> Result<ManifestDto, CommandError> {
    let petalfall = facade.snapshot().await;
    Ok(manifest_dto(petalfall.manifest_overview().await?))
}

/// 某加载器对某游戏版本的全部可用版本，新的在前。
#[tauri::command]
pub async fn list_loader_versions(
    loader: String,
    mc_version: String,
    facade: State<'_, Facade>,
) -> Result<Vec<LoaderVersionDto>, CommandError> {
    let choice = parse_loader_choice(&loader)?;
    let petalfall = facade.snapshot().await;
    Ok(petalfall
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
    let petalfall = facade.snapshot().await;
    Ok(petalfall.required_java(&mc_version).await?)
}

/// 新建这个游戏版本的实例要的 Java 主版本与全新下载体积。版本清单不带这两项，每个版本取一次
/// 版本 JSON 后在进程内缓存，版本列表按选中行逐个查询即可。
#[tauri::command]
pub async fn version_requirements(
    mc_version: String,
    facade: State<'_, Facade>,
) -> Result<VersionRequirementsDto, CommandError> {
    let petalfall = facade.snapshot().await;
    let requirements = petalfall.version_requirements(&mc_version).await?;
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

/// 这次运行里导出存档、导出整合包写成的文件（managed state）。「打开所在文件夹」只放行这些与存档备份区里的路径。
/// 只在进程内有意义：重启后导出完成的通知已经不在，没有入口再要求定位它们。
#[derive(Default)]
pub struct ExportedFiles(Mutex<HashSet<PathBuf>>);

impl ExportedFiles {
    pub fn record(&self, path: &Path) {
        self.0
            .lock()
            .expect("导出记录的锁已中毒")
            .insert(path.to_path_buf());
    }

    fn contains(&self, path: &Path) -> bool {
        self.0.lock().expect("导出记录的锁已中毒").contains(path)
    }
}

/// 在系统文件管理器里定位并选中一个启动器自己产出的文件或文件夹：当前游戏目录存档备份区里的路径（备份列表给的
/// 目录、改名后没挪过来的旧备份目录），或这次运行里导出存档、导出整合包写成的文件。别的路径报 `invalid_argument`
/// （detail.reason 为 `relative` 或 `not_launcher_output`），系统打不开报 `open_failed`。
///
/// opener 插件的 reveal_item_in_dir 不受路径范围约束，授予前端的话，页面里注入的脚本就能让资源管理器定位到任意
/// 路径；所以前端不拿那条权限，改由这里按白名单放行。
#[tauri::command]
pub async fn reveal_in_folder(
    app: AppHandle,
    path: String,
    facade: State<'_, Facade>,
    exports: State<'_, ExportedFiles>,
) -> Result<(), CommandError> {
    let backups_root = facade.snapshot().await.world_backups_root();
    let target = reveal_target(&path, &backups_root, &exports)?;
    tracing::info!(path = %target.display(), "在文件管理器里定位");
    app.opener().reveal_item_in_dir(&target).map_err(|err| {
        tracing::warn!(path = %target.display(), error = %err, "在文件管理器里定位失败");
        CommandError::new(code::OPEN_FAILED, format!("打开所在文件夹失败：{err}"))
            .with_detail(json!({ "path": path }))
    })
}

/// 定位目标是否是启动器自己产出的路径。导出写成的文件按记下的原样比；备份区里的按真实路径比，挡住 `..` 与
/// 链接绕出备份区。路径或备份区不在时它不可能在备份区里。
fn reveal_target(
    path: &str,
    backups_root: &Path,
    exports: &ExportedFiles,
) -> Result<PathBuf, CommandError> {
    let target = PathBuf::from(path);
    if !target.is_absolute() {
        return Err(invalid_field(
            "path",
            "relative",
            format!("要定位的路径必须是绝对路径：{path}"),
        ));
    }
    if exports.contains(&target) {
        return Ok(target);
    }
    let not_ours = || {
        invalid_field(
            "path",
            "not_launcher_output",
            format!(
                "只能定位{}自己产出的文件：{path}",
                petalfall_base::brand::APP_NAME
            ),
        )
    };
    let (Some(real), Some(root)) = (
        existing_real_path(&target)?,
        existing_real_path(backups_root)?,
    ) else {
        return Err(not_ours());
    };
    if real.starts_with(&root) {
        Ok(target)
    } else {
        Err(not_ours())
    }
}

/// 真实路径；路径不在为 None，别的读取错误照实上报。
fn existing_real_path(path: &Path) -> Result<Option<PathBuf>, CommandError> {
    match std::fs::canonicalize(path) {
        Ok(real) => Ok(Some(real)),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(source) => Err(CommandError::from(petalfall_core::BaseError::Io {
            path: path.to_path_buf(),
            source,
        })),
    }
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
    let petalfall = facade.snapshot().await;
    let require_id =
        || id.ok_or_else(|| invalid_field("id", "missing", format!("打开 {target} 需要实例 id")));
    match target {
        "game_dir" => {
            let dir = petalfall.game_dir().to_path_buf();
            ensure_dir(&dir).await?;
            Ok(dir)
        }
        "data_dir" => {
            let dir = petalfall.data_dir().to_path_buf();
            ensure_dir(&dir).await?;
            Ok(dir)
        }
        "launcher_logs" => {
            let dir = petalfall.data_dir().join(crate::logging::LOGS_DIR);
            ensure_dir(&dir).await?;
            Ok(dir)
        }
        "instance" => Ok(petalfall
            .existing_instance_dir(require_id()?)
            .await
            .map_err(instance_error)?),
        "session_logs" => {
            let id = require_id()?;
            // 缺了要建出来：和工作子目录一样先占住实例，不然可能建进正在改名或删除的目录，留下一个空壳
            let _guard = locks.acquire(id, InstanceActivity::Modifying)?;
            let dir = petalfall
                .session_logs_dir(id)
                .await
                .map_err(instance_error)?;
            ensure_dir(&dir).await?;
            Ok(dir)
        }
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
            let resolved = petalfall
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
            let resolved = petalfall
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
        CommandError::from(petalfall_core::BaseError::Io {
            path: dir.to_path_buf(),
            source,
        })
    })
}

// ---------------------------------------------------------------- 存档备份
//
// 备份放在游戏目录下的启动器元数据区，按实例与存档文件夹名分目录；不隔离、共用游戏目录 saves 的存档
// 归在共用的一份下，几个实例看到的是同一批备份。备份、恢复、导出是长任务，占住实例做「备份」：
// 与启动、运行、改名、删除、新建、补全互斥，与 Mod 改动、被别的实例当作基底并行。它们只碰存档与备份区，
// 用不到基底的客户端 jar 与 natives，所以不占基底：基底这期间可以补全，删除与改名有依赖检查挡着。
// 列表不占实例；删除备份只碰备份区，以「改动」占住实例，挡开改名时挪走备份目录。

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
    petalfall: &Petalfall,
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
    if petalfall.world_scope(id).await.map_err(instance_error)? != WorldScope::Shared {
        return Ok(());
    }
    if petalfall
        .world_scope(&other)
        .await
        .map_err(instance_error)?
        != WorldScope::Shared
    {
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
    petalfall: &Petalfall,
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
    if petalfall.world_scope(id).await.map_err(instance_error)? != WorldScope::Shared {
        return Ok(());
    }
    for other in others {
        if petalfall
            .world_scope(&other)
            .await
            .map_err(instance_error)?
            == WorldScope::Shared
        {
            return Err(busy(&other, InstanceActivity::BackingUp));
        }
    }
    Ok(())
}

/// 导出整合包要把存档整份读走：本实例在启动、运行、备份或恢复，或共用这份存档的别的实例开着游戏、在备份或
/// 恢复时，存档随时在变，读到的是半截。调用方已占住自己并记下正在读存档，都是先写自己的、再读对方的。
pub(crate) async fn ensure_saves_settled_for_reading(
    petalfall: &Petalfall,
    locks: &InstanceLocks,
    game: &GameSlot,
    id: &str,
) -> Result<(), CommandError> {
    if let (
        Some(
            activity @ (InstanceActivity::Launching
            | InstanceActivity::Running
            | InstanceActivity::BackingUp),
        ),
        _,
    ) = locks.occupancy(id)
    {
        return Err(busy(id, activity));
    }
    ensure_shared_world_free(petalfall, game, id).await?;
    ensure_shared_worlds_settled(petalfall, locks, id).await?;
    ensure_saves_not_written(petalfall, locks, id).await
}

/// 装数据包写的是 `saves/<存档>/datapacks`：本实例或共用这份存档的实例在备份、恢复或把存档打进整合包时，写进去
/// 的文件会让打包读到半截、让恢复的改名就位失败。调用方已占住自己并记下正在写存档。
pub(crate) async fn ensure_saves_free_for_writing(
    petalfall: &Petalfall,
    locks: &InstanceLocks,
    id: &str,
) -> Result<(), CommandError> {
    if locks.occupancy(id).0 == Some(InstanceActivity::BackingUp) {
        return Err(busy(id, InstanceActivity::BackingUp));
    }
    ensure_shared_worlds_settled(petalfall, locks, id).await?;
    ensure_saves_not_read(petalfall, locks, id).await
}

/// 启动前的存档检查：别的不隔离实例在备份或恢复共用存档，或者本实例、共用这份存档的实例正把存档打进整合包时，
/// 游戏一起来就可能写这份存档。调用方已占住自己，导出那边先记下再查，两边至少有一方看得到对方。
pub(crate) async fn ensure_saves_free_for_launch(
    petalfall: &Petalfall,
    locks: &InstanceLocks,
    id: &str,
) -> Result<(), CommandError> {
    ensure_shared_worlds_settled(petalfall, locks, id).await?;
    ensure_saves_not_read(petalfall, locks, id).await
}

/// 恢复要替换存档：本实例，或共用这份存档的另一个不隔离实例，正在把存档打进整合包时报 instance_busy，
/// detail 指向导出的那个实例。导出对外是「改动中」，所以 activity 报 modifying，正文写明是在导出。
async fn ensure_saves_not_read(
    petalfall: &Petalfall,
    locks: &InstanceLocks,
    id: &str,
) -> Result<(), CommandError> {
    match saves_holder(petalfall, id, locks.reading_saves()).await? {
        Some(reader) => Err(saves_busy(
            &reader,
            format!("实例 {reader} 正在导出带存档的整合包，请稍后再试"),
        )),
        None => Ok(()),
    }
}

/// 备份、恢复、导出存档与带存档的导出整合包：本实例或共用这份存档的实例正在往存档里装数据包时报
/// instance_busy，detail 指向装数据包的那个实例。
async fn ensure_saves_not_written(
    petalfall: &Petalfall,
    locks: &InstanceLocks,
    id: &str,
) -> Result<(), CommandError> {
    match saves_holder(petalfall, id, locks.writing_saves()).await? {
        Some(writer) => Err(saves_busy(
            &writer,
            format!("实例 {writer} 正在往存档里装数据包，请稍后再试"),
        )),
        None => Ok(()),
    }
}

/// `marked` 里和实例 `id` 用同一份存档的那个实例：它自己，或者同为不隔离的实例。
async fn saves_holder(
    petalfall: &Petalfall,
    id: &str,
    marked: Vec<String>,
) -> Result<Option<String>, CommandError> {
    // 没有记录时不碰盘：每次恢复、备份都会经过这里。
    if marked.is_empty() {
        return Ok(None);
    }
    if let Some(own) = marked.iter().find(|m| lock_key(m) == lock_key(id)) {
        return Ok(Some(own.clone()));
    }
    if petalfall.world_scope(id).await.map_err(instance_error)? != WorldScope::Shared {
        return Ok(None);
    }
    for other in marked {
        if petalfall
            .world_scope(&other)
            .await
            .map_err(instance_error)?
            == WorldScope::Shared
        {
            return Ok(Some(other));
        }
    }
    Ok(None)
}

/// 导出整合包与装数据包对外都是「改动中」，所以 activity 报 modifying，正文写明在做什么。
fn saves_busy(id: &str, message: String) -> CommandError {
    CommandError::new(code::INSTANCE_BUSY, message)
        .with_detail(json!({ "id": id, "activity": InstanceActivity::Modifying }))
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
    replaces_saves: bool,
) -> Result<(InstanceGuard, TaskHandle<'a>, Petalfall), CommandError> {
    let guard = env.locks.acquire(id, InstanceActivity::BackingUp)?;
    let snapshot = env.facade.snapshot().await;
    ensure_shared_world_free(&snapshot, env.game, id).await?;
    // 备份与导出存档只读，可以和读存档的导出整合包并行；恢复要替换存档，得等它读完。
    if replaces_saves {
        ensure_saves_not_read(&snapshot, env.locks, id).await?;
    }
    ensure_saves_not_written(&snapshot, env.locks, id).await?;
    let task = env.tasks.register(task_id)?;
    let petalfall = snapshot.with_cancel(task.token().clone());
    Ok((guard, task, petalfall))
}

/// 手动备份一个存档（工作目录下 `saves/<world>`）。长任务：进度经 core-event 推送并带 `task_id`，可取消，
/// 取消后不留半截文件。自动备份开着时，备份完按保留策略清理旧的自动备份，手动备份不清理。
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
    let (_guard, task, petalfall) = begin_world_task(env, task_id, id, false).await?;
    let outcome = task
        .run(async {
            petalfall
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
    let petalfall = facade.snapshot().await;
    let list = petalfall
        .list_world_backups(id, world)
        .await
        .map_err(instance_error)?;
    Ok(world_backup_list_dto(list))
}

/// 用一份备份替换现在的存档：先解压到临时目录并确认 level.dat 读得出，再把现在的存档移入回收站、换上新的。
/// 长任务，解压期间可取消，取消或失败时现在的存档原样不动；开始换存档之后不再响应取消，换完才返回，结果按
/// 实际报。占用规则与 `backup_world` 相同。备份不在报 `world_backup_not_found`，备份损坏或有越界条目报
/// `world_backup_corrupt`；原存档已进回收站、新的没放到位时报 `world_restore_incomplete`，detail.staged 为恢复
/// 出的副本。
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
    let (_guard, _task, petalfall) = begin_world_task(env, task_id, id, true).await?;
    // 不走 TaskHandle::run：解压阶段自己看令牌，取消时很快停下；换存档一旦开始就停不下来了，宽限期满丢弃
    // future 只是不再等它，后台线程照样换完，用户却收到「已取消」，实例也放开了，半途就能启动游戏。
    // 新副本没能就位时也得照实报出它在哪，不能被 run 盖成取消。
    let outcome = petalfall
        .restore_world_backup(id, world, file, disposer, Some(events))
        .await
        .map_err(instance_error)?;
    Ok(RestoreResultDto {
        world: outcome.world,
        previous_in_recycle_bin: outcome.previous_in_recycle_bin,
    })
}

/// 把一份备份移入回收站并从备份列表里去掉。可以从回收站找回，所以不需要确认。只碰备份区，以「改动」占住实例：
/// 游戏运行中、备份进行中照常能删（与同一存档的备份、恢复由门面按存档排队），改名、删除实例、新建、补全进行中
/// 报 `instance_busy`。备份不在报 `world_backup_not_found`。
#[tauri::command]
pub async fn delete_world_backup(
    id: String,
    world: String,
    file: String,
    facade: State<'_, Facade>,
    locks: State<'_, InstanceLocks>,
) -> Result<(), CommandError> {
    delete_world_backup_with(&facade, &locks, &id, &world, &file, RecycleBin).await
}

pub(crate) async fn delete_world_backup_with(
    facade: &Facade,
    locks: &InstanceLocks,
    id: &str,
    world: &str,
    file: &str,
    disposer: impl Disposer + 'static,
) -> Result<(), CommandError> {
    check_world(world)?;
    check_backup_file(file)?;
    // 备份目录按实例名放，改名时整个挪走，挪的时候不看存档锁：不占住实例的话，这边删到一半，清单会按旧路径
    // 重新写出来，挪过去的清单里却还记着删掉的那份。
    let _guard = locks.acquire(id, InstanceActivity::Modifying)?;
    let petalfall = facade.snapshot().await;
    petalfall
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
    exports: State<'_, ExportedFiles>,
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
    // 完成通知上的「打开所在文件夹」要定位它
    if let Ok(done) = &outcome {
        exports.record(Path::new(&done.path));
    }
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
    let (_guard, task, petalfall) = begin_world_task(env, task_id, id, false).await?;
    let outcome = task
        .run(async {
            petalfall
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

    use petalfall_core::{
        ConfigStore, CoreEvent, DownloadSourcePolicy, MoveBlocker, PetalfallConfig,
    };
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

        fn with(customize: impl FnOnce(Petalfall) -> Petalfall) -> Self {
            let dir = tempfile::tempdir().unwrap();
            let config = PetalfallConfig {
                game_directory: Some(dir.path().join(".minecraft")),
                download_source: DownloadSourcePolicy::OfficialFirst,
                version_list_source: DownloadSourcePolicy::OfficialFirst,
                ..PetalfallConfig::default()
            };
            let petalfall = Petalfall::open(
                config,
                dir.path().to_path_buf(),
                dir.path().join("config.json"),
            )
            .unwrap();
            Self {
                facade: Arc::new(Facade::new(customize(petalfall))),
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

        async fn saved_config(&self) -> PetalfallConfig {
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
            use_template: false,
        }
    }

    /// 端到端：install_version 在客户端 jar 下载卡住时被取消，立即以 cancelled 返回，
    /// 新建到一半的实例目录整个删掉，期间推送的事件都带本任务的 task_id，任务与实例占用随之释放。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn cancel_task_stops_install_and_cleans_up() {
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

        assert!(registry.cancel("install-slow"));
        let err = install.await.unwrap().unwrap_err();
        forwarder.finish().await;

        assert_eq!(err.code, common::CANCELLED);
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

    /// 新建的成功路径：请求套用时出参 template 为 applied、模板文件落进实例；不请求时为 null、实例里一个
    /// 模板文件都没有。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn install_applies_the_template_only_when_asked() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/manifest.json"))
            .respond_with(ResponseTemplate::new(200).set_body_string(format!(
                r#"{{"latest":{{"release":"1.21.1","snapshot":"1.21.1"}},
                    "versions":[{{"id":"1.21.1","type":"release","url":"{}/1.21.1.json",
                    "time":"t","releaseTime":"t"}}]}}"#,
                server.uri()
            )))
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path("/1.21.1.json"))
            .respond_with(ResponseTemplate::new(200).set_body_string(
                r#"{"id":"1.21.1","type":"release","mainClass":"net.minecraft.client.main.Main"}"#,
            ))
            .mount(&server)
            .await;
        let uri = server.uri();
        let env = Env::with(|mut a| {
            a.set_isolation_policy(petalfall_core::IsolationPolicy::All);
            a.with_manifest_url(format!("{uri}/manifest.json"))
        });
        let template = env.dir.path().join("templates").join("default");
        std::fs::create_dir_all(&template).unwrap();
        std::fs::write(template.join("options.txt"), b"fov:90").unwrap();
        std::fs::write(template.join("servers.dat"), b"\x0a\x00\x00servers").unwrap();
        let registry = TaskRegistry::default();
        let locks = InstanceLocks::default();
        let (sink, _rx) = tokio::sync::mpsc::unbounded_channel::<CoreEvent>();

        let with = InstallArgs {
            use_template: true,
            ..args("沿用")
        };
        let result = install_version_with(&env.facade, &registry, &locks, "t1", with, &sink)
            .await
            .unwrap();
        assert_eq!(
            result.template,
            Some(TemplateOutcomeDto::Applied {
                copied: vec!["options.txt", "servers.dat"],
                kept: vec![],
            })
        );
        assert_eq!(
            serde_json::to_value(&result).unwrap()["template"],
            json!({ "status": "applied", "copied": ["options.txt", "servers.dat"], "kept": [] })
        );
        let dir = env.game_dir().join("versions").join("沿用");
        assert_eq!(std::fs::read(dir.join("options.txt")).unwrap(), b"fov:90");
        assert_eq!(
            std::fs::read(dir.join("servers.dat")).unwrap(),
            b"\x0a\x00\x00servers"
        );

        let result =
            install_version_with(&env.facade, &registry, &locks, "t2", args("不沿用"), &sink)
                .await
                .unwrap();
        assert_eq!(result.template, None);
        assert_eq!(
            serde_json::to_value(&result).unwrap()["template"],
            Value::Null
        );
        let dir = env.game_dir().join("versions").join("不沿用");
        assert!(dir.join("不沿用.json").is_file());
        assert!(!dir.join("options.txt").exists());
        assert!(!dir.join("servers.dat").exists());
    }

    #[test]
    fn skipped_template_serializes_with_its_reason() {
        for (reason, name) in [
            (TemplateSkip::Disabled, "disabled"),
            (TemplateSkip::Empty, "empty"),
            (TemplateSkip::SharedWorkingDir, "shared_working_dir"),
        ] {
            assert_eq!(
                serde_json::to_value(TemplateOutcomeDto::from(TemplateOutcome::Skipped(reason)))
                    .unwrap(),
                json!({ "status": "skipped", "reason": name })
            );
        }
    }

    /// 保存、读取、清除走完一轮：出参按白名单顺序列出文件，记下来源实例；清除两次都成功。
    /// 游戏运行中可以保存。
    #[tokio::test]
    async fn template_is_saved_from_an_instance_read_back_and_cleared() {
        let env = Env::new();
        env.vanilla("樱花生存");
        // 原版正式版默认不隔离，设置文件在游戏目录根下。
        std::fs::write(env.game_dir().join("servers.dat"), b"servers").unwrap();
        std::fs::write(env.game_dir().join("options.txt"), b"fov:90").unwrap();
        let locks = InstanceLocks::default();
        let _running = locks
            .acquire("樱花生存", InstanceActivity::Running)
            .unwrap();
        let before = template_info_with(&env.facade).await.unwrap();
        assert_eq!(
            serde_json::to_value(&before).unwrap(),
            json!({ "present": false, "files": [], "source_instance": null, "saved_at": null, "enabled": true })
        );

        let saved = save_instance_as_template_with(&env.facade, &locks, "樱花生存")
            .await
            .unwrap();
        assert!(saved.present);
        assert_eq!(
            saved.files,
            vec![
                TemplateFileDto {
                    name: "options.txt",
                    size: 6
                },
                TemplateFileDto {
                    name: "servers.dat",
                    size: 7
                },
            ]
        );
        assert_eq!(saved.source_instance.as_deref(), Some("樱花生存"));
        assert!(saved.saved_at.unwrap() > 1_700_000_000_000);
        assert_eq!(template_info_with(&env.facade).await.unwrap(), saved);
        assert_eq!(
            locks.activity("樱花生存"),
            Some(InstanceActivity::Running),
            "保存结束后只剩游戏的占用"
        );

        for _ in 0..2 {
            let cleared = clear_template_with(&env.facade).await.unwrap();
            assert!(!cleared.present);
            assert!(cleared.files.is_empty());
            assert_eq!(cleared.source_instance, None);
        }
        assert!(!env.dir.path().join("templates").join("default").exists());
    }

    #[tokio::test]
    async fn saving_a_template_waits_for_install_and_reports_missing_files() {
        let env = Env::new();
        env.vanilla("新装的");
        let locks = InstanceLocks::default();

        let installing = locks
            .acquire("新装的", InstanceActivity::Installing)
            .unwrap();
        let err = save_instance_as_template_with(&env.facade, &locks, "新装的")
            .await
            .unwrap_err();
        assert_eq!(err.code, code::INSTANCE_BUSY);
        let detail = err.detail.unwrap();
        assert_eq!(detail["activity"], "installing");
        assert_eq!(detail["id"], "新装的");
        drop(installing);

        let err = save_instance_as_template_with(&env.facade, &locks, "新装的")
            .await
            .unwrap_err();
        assert_eq!(err.code, code::TEMPLATE_SOURCE_EMPTY);
        assert_eq!(
            err.message,
            "实例 新装的 的游戏目录里还没有 options.txt 或服务器列表，进一次游戏后再保存"
        );
        let detail = err.detail.unwrap();
        assert_eq!(detail["id"], "新装的");
        assert_eq!(
            detail["files"],
            json!([
                "options.txt",
                "servers.dat",
                "optionsof.txt",
                "optionsshaders.txt"
            ])
        );
        assert!(!env.dir.path().join("templates").exists());
        assert_eq!(locks.activity("新装的"), None);

        let err = save_instance_as_template_with(&env.facade, &locks, "../x")
            .await
            .unwrap_err();
        assert_eq!(err.code, common::INVALID_ARGUMENT);
        let detail = err.detail.unwrap();
        assert_eq!(
            (&detail["field"], &detail["reason"], &detail["id"]),
            (&json!("id"), &json!("unsafe_id"), &json!("../x"))
        );
        assert_eq!(locks.activity("../x"), None);

        let err = save_instance_as_template_with(&env.facade, &locks, "不存在")
            .await
            .unwrap_err();
        assert_eq!(err.code, common::VERSION_NOT_INSTALLED);
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

    /// 实例目录里的 Fabric 实例，加载器的库声明了下载件、地址留空，盘上没有文件：补全只能报它补不回来。
    const LOST_LOADER_JSON: &str = r#"{"id":"FAB","type":"release","clientVersion":"1.21.1",
        "mainClass":"net.fabricmc.loader.impl.launch.knot.KnotClient",
        "libraries":[{"name":"net.fabricmc:fabric-loader:0.16.10","downloads":{"artifact":{
        "path":"net/fabricmc/fabric-loader/0.16.10/fabric-loader-0.16.10.jar","url":"",
        "sha1":"0000000000000000000000000000000000000000","size":4}}}]}"#;

    /// 走到重装第一步就停下的环境：版本清单里没有任何版本，报错前已推过「查找原版」，用它认出走的是重装。
    async fn env_with_empty_manifest(server: &MockServer) -> Env {
        Mock::given(method("GET"))
            .and(path("/manifest.json"))
            .respond_with(
                ResponseTemplate::new(200)
                    .set_body_string(r#"{"latest":{"release":"x","snapshot":"x"},"versions":[]}"#),
            )
            .mount(server)
            .await;
        let uri = server.uri();
        Env::with(|a| a.with_manifest_url(format!("{uri}/manifest.json")))
    }

    fn stage_messages(rx: &mut tokio::sync::mpsc::UnboundedReceiver<CoreEvent>) -> Vec<String> {
        let mut stages = Vec::new();
        while let Ok(event) = rx.try_recv() {
            if let CoreEvent::Stage(message) = event {
                stages.push(message);
            }
        }
        stages
    }

    /// 重新安装加载器失败时标记记成安装，内容是版本 JSON 里读出的那一份，版本号原样；实例不再占着。之后不带
    /// 参数的普通补全（修复实例、修复并启动、任务重试）照着标记接着重装，不退回按版本 JSON 补全。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_failed_loader_reinstall_leaves_what_to_put_back_in_the_marker() {
        let server = MockServer::start().await;
        let env = env_with_empty_manifest(&server).await;
        env.version("FAB", LOST_LOADER_JSON);
        let registry = TaskRegistry::default();
        let locks = InstanceLocks::default();
        let (sink, mut rx) = tokio::sync::mpsc::unbounded_channel::<CoreEvent>();

        let err = reinstall_loader_with(&env.facade, &registry, &locks, "r1", "FAB", &sink)
            .await
            .unwrap_err();
        assert_ne!(err.code, common::CANCELLED);
        assert_eq!(stage_messages(&mut rx), vec!["查找原版 1.21.1".to_owned()]);
        let list = list_instances_with(&env.facade, &locks).await.unwrap();
        let incomplete = list[0].incomplete.as_ref().unwrap();
        assert_eq!((incomplete.kind, incomplete.outcome), ("install", "failed"));
        assert_eq!(
            incomplete.spec,
            Some(InstallSpecDto {
                mc_version: "1.21.1".into(),
                loader: Some("fabric".into()),
                loader_version: Some("0.16.10".into()),
            })
        );
        assert_eq!(incomplete.error.as_ref().unwrap().code, err.code);
        assert_eq!(locks.activity("FAB"), None);

        repair_instance_with(&env.facade, &registry, &locks, "r2", "FAB", &sink)
            .await
            .unwrap_err();
        assert_eq!(stage_messages(&mut rx), vec!["查找原版 1.21.1".to_owned()]);
    }

    /// 普通补全查出加载器自带的库缺失后，再点一次补全不能原样失败：同一个命令这回走重装。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn repair_stuck_on_a_lost_loader_library_moves_on_to_reinstalling_it() {
        let server = MockServer::start().await;
        let env = env_with_empty_manifest(&server).await;
        env.version("FAB", LOST_LOADER_JSON);
        let registry = TaskRegistry::default();
        let locks = InstanceLocks::default();
        let (sink, mut rx) = tokio::sync::mpsc::unbounded_channel::<CoreEvent>();

        let first = repair_instance_with(&env.facade, &registry, &locks, "r1", "FAB", &sink)
            .await
            .unwrap_err();
        assert_eq!(first.code, code::LOADER_LIBRARY_MISSING);
        assert_eq!(
            stage_messages(&mut rx),
            vec!["补全实例 FAB 的文件".to_owned()]
        );
        let list = list_instances_with(&env.facade, &locks).await.unwrap();
        let incomplete = list[0].incomplete.as_ref().unwrap();
        assert_eq!((incomplete.kind, incomplete.outcome), ("repair", "failed"));
        assert_eq!(
            incomplete.error.as_ref().unwrap().code,
            code::LOADER_LIBRARY_MISSING
        );

        let second = repair_instance_with(&env.facade, &registry, &locks, "r2", "FAB", &sink)
            .await
            .unwrap_err();
        assert_ne!(second.code, code::LOADER_LIBRARY_MISSING);
        assert_eq!(stage_messages(&mut rx), vec!["查找原版 1.21.1".to_owned()]);
    }

    /// 重新安装加载器与补全同一把锁：游戏运行中、基底被占着时都报 instance_busy，被拒时不占任务 id，也不写标记。
    #[tokio::test]
    async fn reinstalling_the_loader_goes_through_the_instance_locks() {
        let env = Env::new();
        env.vanilla("1.20.1");
        let dir = env.version(
            "FAB",
            r#"{"id":"FAB","inheritsFrom":"1.20.1","type":"release","mainClass":"K",
                "libraries":[{"name":"net.fabricmc:fabric-loader:0.15.0"}]}"#,
        );
        let registry = TaskRegistry::default();
        let locks = InstanceLocks::default();
        let (sink, _rx) = tokio::sync::mpsc::unbounded_channel::<CoreEvent>();

        let running = locks.acquire("FAB", InstanceActivity::Running).unwrap();
        let err = reinstall_loader_with(&env.facade, &registry, &locks, "r1", "FAB", &sink)
            .await
            .unwrap_err();
        assert_eq!(err.code, code::INSTANCE_BUSY);
        assert_eq!(
            err.detail.unwrap(),
            json!({ "id": "FAB", "activity": "running" })
        );
        drop(running);

        let deleting = locks.acquire("1.20.1", InstanceActivity::Deleting).unwrap();
        let err = reinstall_loader_with(&env.facade, &registry, &locks, "r2", "FAB", &sink)
            .await
            .unwrap_err();
        assert_eq!(err.code, code::INSTANCE_BUSY);
        assert_eq!(
            err.detail.unwrap(),
            json!({ "id": "1.20.1", "activity": "deleting" })
        );
        drop(deleting);

        assert!(!registry.is_running("r1"));
        assert!(!registry.is_running("r2"));
        assert!(!petalfall_core::MarkerStore::for_version_dir(&dir)
            .path()
            .exists());
        assert_eq!(locks.activity("FAB"), None);
    }

    /// 没有能原样装回的加载器：报 instance_failed，原因写进 detail，实例不留标记、不留占用。
    #[tokio::test]
    async fn reinstalling_the_loader_of_a_vanilla_instance_is_refused() {
        let env = Env::new();
        let dir = env.vanilla("1.21.1");
        let registry = TaskRegistry::default();
        let locks = InstanceLocks::default();
        let (sink, _rx) = tokio::sync::mpsc::unbounded_channel::<CoreEvent>();

        let err = reinstall_loader_with(&env.facade, &registry, &locks, "r", "1.21.1", &sink)
            .await
            .unwrap_err();
        assert_eq!(err.code, common::INSTANCE_FAILED);
        assert_eq!(
            err.message,
            "实例 1.21.1 无法补全：没有装加载器，不需要重新安装"
        );
        assert_eq!(
            err.detail.unwrap()["reason"],
            json!("没有装加载器，不需要重新安装")
        );
        assert!(!petalfall_core::MarkerStore::for_version_dir(&dir)
            .path()
            .exists());
        assert_eq!(locks.activity("1.21.1"), None);
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

    /// 实例自己正被占着时补全先报 instance_busy，不先去读它的版本 JSON：安装途中 JSON 正被替换、一时读不出来时，
    /// 补全该说「正在安装」，而不是一个读文件的错误；被拒的补全不占任务 id。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn repairing_a_busy_instance_is_refused_before_its_chain_is_read() {
        let env = Env::new();
        std::fs::create_dir_all(
            env.game_dir()
                .join("versions")
                .join("装到 一半")
                .join("装到 一半.json"),
        )
        .unwrap();
        let registry = TaskRegistry::default();
        let locks = InstanceLocks::default();
        let installing = locks
            .acquire("装到 一半", InstanceActivity::Installing)
            .unwrap();
        let (sink, _rx) = tokio::sync::mpsc::unbounded_channel::<CoreEvent>();
        let err = repair_instance_with(&env.facade, &registry, &locks, "r", "装到 一半", &sink)
            .await
            .unwrap_err();
        assert_eq!(err.code, code::INSTANCE_BUSY, "{err:?}");
        assert_eq!(
            err.detail.unwrap(),
            json!({ "id": "装到 一半", "activity": "installing" })
        );
        assert!(!registry.is_running("r"));
        drop(installing);
    }

    /// 传统布局的加载器实例补全时把客户端 jar 与 natives 写进继承链根的目录：补全期间删除、改名基底都以
    /// instance_busy 拒绝（不是等扫盘发现依赖才拒），detail 指出是哪个实例在用它；列表里基底的
    /// activity 为 inherited。补全结束（这里是取消）后占用随之释放。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn repairing_a_loader_instance_holds_its_base_until_it_ends() {
        let slow = stalling_server();
        let env = Env::new();
        env.vanilla("1.20.1");
        env.version(
            "FAB",
            &format!(
                r#"{{"id":"FAB","inheritsFrom":"1.20.1","type":"release","mainClass":"K",
                    "libraries":[{{"name":"net.fabricmc:fabric-loader:0.15.0","downloads":{{"artifact":{{
                    "path":"net/fabricmc/fabric-loader/0.15.0/fabric-loader-0.15.0.jar",
                    "sha1":"0000000000000000000000000000000000000000","size":1048576,
                    "url":"{slow}/fabric-loader-0.15.0.jar"}}}}}}]}}"#
            ),
        );
        let registry = Arc::new(TaskRegistry::default());
        let locks = InstanceLocks::default();
        let repair = tokio::spawn({
            let (f, r, l) = (env.facade.clone(), registry.clone(), locks.clone());
            async move {
                let (sink, _rx) = tokio::sync::mpsc::unbounded_channel::<CoreEvent>();
                repair_instance_with(&f, &r, &l, "repair-fab", "FAB", &sink).await
            }
        });
        let game_dir = env.game_dir();
        let deadline = Instant::now() + Duration::from_secs(10);
        while leftovers(&game_dir).is_empty() {
            assert!(Instant::now() < deadline, "加载器库的下载没有开始");
            tokio::time::sleep(Duration::from_millis(10)).await;
        }

        assert_eq!(locks.activity("1.20.1"), Some(InstanceActivity::Inherited));
        let listed = list_instances_with(&env.facade, &locks).await.unwrap();
        let base = listed.iter().find(|i| i.id == "1.20.1").unwrap();
        assert_eq!(base.activity, Some(InstanceActivity::Inherited));
        assert_eq!(base.used_by.as_deref(), Some("FAB"));
        let fab = listed.iter().find(|i| i.id == "FAB").unwrap();
        assert_eq!(
            (fab.activity, fab.used_by.as_deref()),
            (Some(InstanceActivity::Repairing), None)
        );
        let preview = preview_dto(
            env.facade
                .snapshot()
                .await
                .deletion_preview("1.20.1")
                .await
                .unwrap(),
            &locks,
        );
        assert_eq!(
            (preview.activity, preview.used_by.as_deref()),
            (Some(InstanceActivity::Inherited), Some("FAB"))
        );
        let err = delete_instance_with(&env.facade, &locks, "1.20.1", Remove)
            .await
            .unwrap_err();
        assert_eq!(err.code, code::INSTANCE_BUSY);
        assert_eq!(
            err.detail.unwrap(),
            json!({ "id": "1.20.1", "activity": "inherited", "used_by": "FAB" })
        );
        assert_eq!(err.message, "实例 1.20.1 正在被实例 FAB 使用，请稍后再试");
        let err = rename_instance_with(&env.facade, &locks, "1.20.1", "原版")
            .await
            .unwrap_err();
        assert_eq!(err.code, code::INSTANCE_BUSY);
        assert!(game_dir.join("versions").join("1.20.1").is_dir());

        assert!(registry.cancel("repair-fab"));
        let err = repair.await.unwrap().unwrap_err();
        assert_eq!(err.code, common::CANCELLED);
        assert_eq!(locks.activity("1.20.1"), None, "补全结束后基底放开");
        assert_eq!(locks.activity("FAB"), None);
    }

    #[tokio::test]
    async fn delete_removes_the_directory_and_prunes_pins_and_selection_on_disk() {
        let env = Env::new();
        let dir = env.vanilla("旧档");
        env.vanilla("留下");
        env.facade
            .update(|petalfall| {
                petalfall.set_sidebar_pins(vec!["旧档".into(), "留下".into()]);
                petalfall.set_selected_version(Some("旧档".into()));
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
            &locks,
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
        petalfall_core::MarkerStore::for_version_dir(&dir)
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
            .update(|petalfall| {
                petalfall.set_sidebar_pins(vec!["1.21.1".into()]);
                petalfall.set_selected_version(Some("1.21.1".into()));
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
            env.dir.path().join(petalfall_core::playtime::PLAYTIME_FILE),
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
        assert_eq!(renamed.playtime_min, Some(90));
        assert_eq!(renamed.last_played_at, Some(1_761_832_800_000));
        let stats = env
            .facade
            .snapshot()
            .await
            .play_stats(petalfall_core::PlayRange::parse("2026-10-30", "2026-10-30").unwrap())
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
        assert_eq!(
            fresh.playtime_min,
            Some(0),
            "同名新实例不继承被删实例的时长"
        );
        assert_eq!(fresh.last_played_at, None);
        let summaries = env.facade.snapshot().await.play_summaries().await.unwrap();
        assert_eq!(summaries.keys().collect::<Vec<_>>(), vec!["别的"]);
    }

    async fn switch_game_dir(env: &Env, game_dir: &Path) {
        let current = env.facade.snapshot().await.probe_current_game_dir().await;
        env.facade
            .update(|petalfall| {
                petalfall.switch_game_directory(game_dir, &current);
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
        let day = || petalfall_core::PlayRange::parse("2026-10-30", "2026-10-30").unwrap();

        let list = list_instances_with(&env.facade, &locks).await.unwrap();
        assert_eq!(played(&list), (Some(90), Some(1_761_832_800_000)));

        switch_game_dir(&env, &other).await;
        let list = list_instances_with(&env.facade, &locks).await.unwrap();
        assert_eq!(
            played(&list),
            (Some(0), None),
            "另一个游戏目录里的同名实例不继承"
        );
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
        assert_eq!(played(&list), (Some(90), Some(1_761_832_800_000)));
        let stats = env.facade.snapshot().await.play_stats(day()).await.unwrap();
        assert_eq!(stats.total_minutes, 90);
        assert_eq!(stats.instances[0].version_id, "周末生存");
    }

    /// 游玩记录读不懂：实例列表照常出来，每个实例带上原因（含 JSON 的行列），时长是 null 而不是 0；
    /// 文件修好后下一次列表恢复。
    #[tokio::test]
    async fn unreadable_play_records_leave_the_list_loading() {
        let env = Env::new();
        env.vanilla("a");
        env.vanilla("b");
        write_playtime(&env, "{ broken");
        let locks = InstanceLocks::default();

        let list = list_instances_with(&env.facade, &locks).await.unwrap();

        let ids: Vec<&str> = list.iter().map(|i| i.id.as_str()).collect();
        assert_eq!(ids, vec!["a", "b"]);
        for entry in &list {
            assert_eq!(entry.playtime_min, None, "{}", entry.id);
            assert_eq!(entry.last_played_at, None, "{}", entry.id);
            let reason = entry.play_error.as_deref().unwrap();
            assert!(reason.contains("playtime.json"), "{reason}");
            assert!(reason.contains("line 1 column 3"), "{reason}");
        }
        let value = serde_json::to_value(&list[0]).unwrap();
        assert_eq!(value["playtime_min"], json!(null));

        write_playtime(
            &env,
            r#"{"format":1,"book":{"instances":{"a":{"total_ms":600000,"last_played_at":1761800000000}},"days":{}}}"#,
        );
        let list = list_instances_with(&env.facade, &locks).await.unwrap();
        assert_eq!(list[0].playtime_min, Some(10));
        assert_eq!(list[0].last_played_at, Some(1_761_800_000_000));
        assert_eq!(list[0].play_error, None);
        assert_eq!(list[1].playtime_min, Some(0));
        assert_eq!(list[1].last_played_at, None);
        assert_eq!(list[1].play_error, None);
    }

    /// 新版启动器写的游玩记录，旧版本读到时同样只是读不到时长，不让列表打不开。
    #[tokio::test]
    async fn play_records_from_a_newer_format_leave_the_list_loading() {
        let env = Env::new();
        env.vanilla("a");
        write_playtime(&env, r#"{"format":9,"directories":[]}"#);

        let list = list_instances_with(&env.facade, &InstanceLocks::default())
            .await
            .unwrap();

        assert_eq!(list[0].playtime_min, None);
        let reason = list[0].play_error.as_deref().unwrap();
        assert!(reason.contains("格式版本是 9"), "{reason}");
    }

    /// 游玩记录读不出来：改名、删除照样把文件与配置里的侧栏固定、当前选中改完（磁盘与门面都改），命令以
    /// play_records_failed 报告只差游玩记录没跟上，不假装一切正常，坏文件原样留着。
    #[tokio::test]
    async fn unreadable_play_records_do_not_hold_back_the_references() {
        let env = Env::new();
        let dir = env.vanilla("a");
        env.vanilla("留下");
        env.facade
            .update(|petalfall| {
                petalfall.set_sidebar_pins(vec!["a".into(), "留下".into()]);
                petalfall.set_selected_version(Some("a".into()));
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
            std::fs::read_to_string(env.dir.path().join(petalfall_core::playtime::PLAYTIME_FILE))
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
        let path = env.dir.path().join(petalfall_core::playtime::PLAYTIME_FILE);
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
        assert_eq!(played(&list, "a"), (Some(10), Some(1_761_800_000_000)));
        let err = rename_instance_with(&env.facade, &locks, "a", "b")
            .await
            .unwrap_err();
        assert_eq!(err.code, code::PLAY_RECORDS_FAILED);
        let list = list_instances_with(&env.facade, &locks).await.unwrap();
        assert_eq!(list.len(), 2);
        assert_eq!(played(&list, "b"), (Some(10), Some(1_761_800_000_000)));
        assert_eq!(played(&list, "留下"), (Some(0), None));
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
            .update(|petalfall| {
                petalfall.set_sidebar_pins(vec!["a".into()]);
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
            env.dir.path().join(petalfall_core::playtime::PLAYTIME_FILE),
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
        assert_eq!(fab.playtime_min, Some(121));
        assert_eq!(fab.last_played_at, Some(1_767_225_600_000));
        let vanilla = list.iter().find(|i| i.id == "1.21.1").unwrap();
        assert_eq!(vanilla.activity, None);
        assert_eq!(vanilla.mod_count, Some(0));
        assert_eq!(vanilla.playtime_min, Some(0));
        assert_eq!(vanilla.last_played_at, None);
    }

    /// 列表 DTO 带上整合包来源、最近崩溃、存档数、隔离生效值与自定内存；附属文件读不出时
    /// 只把原因放进对应的 *_error，其余字段照常给。
    #[test]
    fn instance_dto_carries_modpack_crash_worlds_isolation_and_memory() {
        let summary = |modpack, last_crash_at, settings| InstanceSummary {
            id: "整合包".into(),
            dir: PathBuf::from("versions/整合包"),
            version: InstanceVersion::Ready(petalfall_core::ReadyVersion {
                mc_version: Some("1.21.1".into()),
                loaders: Vec::new(),
                release_type: Some("release".into()),
                is_release: true,
                java_major: Some(21),
                quick_play: Some(petalfall_core::QuickPlaySupport {
                    singleplayer: true,
                    multiplayer: true,
                }),
                bases: Vec::new(),
                mod_count: Some(80),
                world_count: Some(3),
                isolated: Some(true),
            }),
            settings,
            incomplete: None,
            created_at: Some(1),
            dir_error: None,
            modpack,
            last_crash_at,
        };
        let pack = petalfall_core::InstanceModpack {
            schema: 1,
            format: petalfall_core::PackFormat::Modrinth,
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
            recommended_ram_mb: None,
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
            Readable::Read(None),
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
            Readable::Unreadable("游玩记录坏了".into()),
        );
        assert_eq!(broken.playtime_min, None);
        assert_eq!(broken.last_played_at, None);
        assert_eq!(broken.play_error.as_deref(), Some("游玩记录坏了"));
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
        missing_json.version = InstanceVersion::Broken(petalfall_core::BrokenReason::MissingJson);
        let value =
            serde_json::to_value(instance_dto(missing_json, None, Readable::Read(None))).unwrap();
        assert_eq!(value["status"], json!("broken"));
        assert_eq!(value["quick_play"], json!(null));
    }

    /// 导入中断留下的整合包标记在列表里报为 modpack，而不是「标记读不出来」。
    #[tokio::test]
    async fn interrupted_modpack_import_lists_as_modpack_incomplete() {
        let env = Env::new();
        let dir = env.vanilla("整合包");
        petalfall_core::MarkerStore::for_version_dir(&dir)
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
        // 崩溃页列的日志路径在这里，不在游戏自己的 logs 下；还没启动过时也先建出来，资源管理器打得开。
        let session_logs = folder_path(facade, &locks, "session_logs", Some("1.21.1"), None)
            .await
            .unwrap();
        assert_eq!(session_logs, dir.join(".petalfall").join("logs"));
        assert!(session_logs.is_dir());
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
            let err = folder_path(&env.facade, &locks, "session_logs", Some("1.21.1"), None)
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
        assert!(
            !dir.join(".petalfall").join("logs").exists(),
            "被拒绝时不在改名或删除中的实例里建目录"
        );

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

    /// 被当作基底：与基底自己的改动、备份以及别的实例对它的占用兼容；与挪走或重写目录的事互斥，与基底自己的
    /// 启动、运行也互斥（游戏映射着 natives，这时补全或导入要重写它们会中途报 IO 错误），两个方向都是。并行时报
    /// 基底自己的事，只剩基底占用时才报 inherited。
    /// 补全要沿继承链占基底，基底容不下这份占用时任务开工就失败：列表提前报出同一个基底与同一件事，界面据此禁用
    /// 入口。基底只是在改动或备份时不挡，链上几个基底都忙时报最近的那个，与依次占用时停下的位置一致。
    #[tokio::test]
    async fn listed_instances_report_the_base_that_would_refuse_their_repair() {
        use InstanceActivity::*;
        let env = Env::new();
        env.vanilla("1.20.1");
        env.version(
            "FAB",
            r#"{"id":"FAB","inheritsFrom":"1.20.1","type":"release","mainClass":"K"}"#,
        );
        env.version(
            "叠层",
            r#"{"id":"叠层","inheritsFrom":"fab","type":"release","mainClass":"K"}"#,
        );
        let locks = InstanceLocks::default();
        let listed = |id: &'static str| {
            let (facade, locks) = (env.facade.clone(), locks.clone());
            async move {
                let list = list_instances_with(&facade, &locks).await.unwrap();
                list.into_iter()
                    .find(|i| i.id == id)
                    .unwrap_or_else(|| panic!("列表里没有 {id}"))
                    .base_busy
            }
        };
        let busy = |id: &str, activity| {
            Some(BaseBusyDto {
                id: id.to_owned(),
                activity,
            })
        };

        assert_eq!(listed("FAB").await, None);
        assert_eq!(listed("叠层").await, None);

        let game = locks.acquire("1.20.1", Running).unwrap();
        assert_eq!(listed("FAB").await, busy("1.20.1", Running));
        assert_eq!(listed("叠层").await, busy("1.20.1", Running));
        assert_eq!(listed("1.20.1").await, None, "基底自己不算被自己挡着");
        let refused = locks
            .acquire_with_bases("FAB", Repairing, &["1.20.1".to_owned()])
            .err()
            .unwrap();
        assert_eq!(
            serde_json::to_value(listed("FAB").await).unwrap(),
            refused.detail.unwrap(),
            "与补全被拒时 detail 里的是同一份"
        );

        let nearer = locks.acquire("FAB", Repairing).unwrap();
        // id 是 inheritsFrom 的原样写法，与 instance_busy 的 detail 相同；查占用不分大小写。
        assert_eq!(listed("叠层").await, busy("fab", Repairing));
        drop(nearer);
        drop(game);

        for compatible in [Modifying, BackingUp] {
            let held = locks.acquire("1.20.1", compatible).unwrap();
            assert_eq!(listed("FAB").await, None, "{compatible:?}");
            drop(held);
        }
        let user = locks
            .acquire_with_bases("别的实例", Running, &["1.20.1".to_owned()])
            .unwrap();
        assert_eq!(listed("FAB").await, None, "基底可以同时被几个实例占着");
        drop(user);
    }

    #[test]
    fn inherited_bases_exclude_the_bases_own_game_and_directory_rewrites() {
        use InstanceActivity::*;
        let exclusive = [
            Installing, Repairing, Renaming, Deleting, Launching, Running,
        ];
        let locks = InstanceLocks::default();
        let bases = ["1.20.1".to_owned()];

        let fabric = locks.acquire_with_bases("Fabric", Running, &bases).unwrap();
        let quilt = locks
            .acquire_with_bases("Quilt", Repairing, &bases)
            .unwrap();
        assert_eq!(locks.activity("1.20.1"), Some(Inherited));
        assert_eq!(
            locks.activity("Fabric"),
            Some(Running),
            "实例自己照记它在做的事"
        );
        for activity in exclusive {
            let err = locks.acquire("1.20.1", activity).err().unwrap();
            assert_eq!(err.code, code::INSTANCE_BUSY, "{activity:?}");
            assert_eq!(
                err.detail.unwrap(),
                json!({ "id": "1.20.1", "activity": "inherited", "used_by": "Fabric" }),
                "{activity:?}"
            );
        }
        let backup = locks.acquire("1.20.1", BackingUp).unwrap();
        let modifying = locks.acquire("1.20.1", Modifying).unwrap();
        assert_eq!(
            locks.activity("1.20.1"),
            Some(BackingUp),
            "基底自己的事排在前面"
        );
        drop(backup);
        assert_eq!(locks.activity("1.20.1"), Some(Modifying));
        drop(modifying);

        drop(fabric);
        let err = locks.acquire("1.20.1", Deleting).err().unwrap();
        assert_eq!(err.detail.unwrap()["used_by"], "Quilt", "还有一个实例在用");
        drop(quilt);
        assert_eq!(locks.activity("1.20.1"), None);
        assert_eq!(locks.activity("Quilt"), None);

        // 反过来：基底正被挪走、重写，或者开着游戏时，以它为基底的占用被拒，实例自己已占到的一并放开。
        for activity in exclusive {
            let held = locks.acquire("1.20.1", activity).unwrap();
            let err = locks
                .acquire_with_bases("Fabric", Repairing, &bases)
                .err()
                .unwrap();
            assert_eq!(
                err.detail.unwrap(),
                json!({ "id": "1.20.1", "activity": activity }),
                "{activity:?}"
            );
            assert_eq!(locks.activity("Fabric"), None, "{activity:?}");
            drop(held);
        }
    }

    /// 基底与实例同名（链成环）或彼此只差大小写时只占一次；实例自己被占着时不去碰基底。
    #[test]
    fn bases_are_held_once_and_only_after_the_instance_itself() {
        use InstanceActivity::*;
        let locks = InstanceLocks::default();
        let bases = ["fabric".to_owned(), "Base".to_owned(), "BASE".to_owned()];
        let chain = locks
            .acquire_with_bases("Fabric", Launching, &bases)
            .unwrap();
        assert_eq!(
            locks.activity("fabric"),
            Some(Launching),
            "同名的基底不另占"
        );
        assert_eq!(lock_table(&locks.table).held[&lock_key("Fabric")].len(), 1);
        assert_eq!(lock_table(&locks.table).held[&lock_key("base")].len(), 1);
        assert_eq!(locks.activity("base"), Some(Inherited));
        drop(chain);
        assert!(lock_table(&locks.table).held.is_empty());

        let renaming = locks.acquire("Fabric", Renaming).unwrap();
        let err = locks
            .acquire_with_bases("Fabric", Launching, &bases)
            .err()
            .unwrap();
        assert_eq!(err.detail.unwrap()["activity"], "renaming");
        assert_eq!(locks.activity("base"), None);
        drop(renaming);
    }

    #[test]
    #[should_panic(expected = "基底占用要记下使用者")]
    fn inherited_is_only_taken_together_with_its_user() {
        let _ = InstanceLocks::default().acquire("1.20.1", InstanceActivity::Inherited);
    }

    /// 列表与删除预览里的 activity 和 used_by 必须是同一刻的：别的命令同时占上、放开基底时，不能报出
    /// 「inherited 却没有 used_by」或「有 used_by 却没有 activity」这样的一对，前端把它当作契约破了直接抛错，
    /// 整个实例列表就刷新失败。
    #[test]
    fn occupancy_reads_activity_and_user_at_the_same_moment() {
        use std::sync::atomic::{AtomicBool, Ordering};
        use InstanceActivity::*;
        let locks = InstanceLocks::default();
        let stop = Arc::new(AtomicBool::new(false));
        let churn = std::thread::spawn({
            let (locks, stop) = (locks.clone(), stop.clone());
            move || {
                let bases = ["1.20.1".to_owned()];
                while !stop.load(Ordering::Relaxed) {
                    drop(
                        locks
                            .acquire_with_bases("Fabric", Launching, &bases)
                            .unwrap(),
                    );
                }
            }
        });
        let (mut idle, mut used) = (0u32, 0u32);
        let deadline = Instant::now() + Duration::from_secs(3);
        while Instant::now() < deadline && (idle < 1_000 || used < 1_000) {
            match locks.occupancy("1.20.1") {
                (None, None) => idle += 1,
                (Some(Inherited), Some(user)) if user == "Fabric" => used += 1,
                torn => {
                    stop.store(true, Ordering::Relaxed);
                    panic!("activity 与 used_by 不是同一刻的：{torn:?}");
                }
            }
        }
        stop.store(true, Ordering::Relaxed);
        churn.join().unwrap();
        assert!(idle > 0 && used > 0, "两种状态都该看到过：{idle} / {used}");
    }

    /// 基底自己也在备份或改动时，被拒的删除、改名、补全报它自己的事，与列表里的 activity 一致，
    /// 不随哪一份占用先到而变：实例自己的事优先，其次 modifying，最后 inherited。
    #[test]
    fn busy_reports_the_same_activity_the_list_shows() {
        use InstanceActivity::*;
        let locks = InstanceLocks::default();
        let bases = ["1.20.1".to_owned()];
        let fabric = locks.acquire_with_bases("Fabric", Running, &bases).unwrap();
        let modifying = locks.acquire("1.20.1", Modifying).unwrap();
        let backup = locks.acquire("1.20.1", BackingUp).unwrap();
        for activity in [Deleting, Renaming, Repairing, Installing] {
            let err = locks.acquire("1.20.1", activity).err().unwrap();
            assert_eq!(locks.activity("1.20.1"), Some(BackingUp));
            assert_eq!(
                err.detail.unwrap(),
                json!({ "id": "1.20.1", "activity": "backing_up" }),
                "{activity:?}"
            );
            assert_eq!(err.message, "实例 1.20.1 正在备份或恢复存档，请稍后再试");
        }
        drop(backup);
        let err = locks.acquire("1.20.1", Deleting).err().unwrap();
        assert_eq!(
            err.detail.unwrap(),
            json!({ "id": "1.20.1", "activity": "modifying" })
        );
        drop(modifying);
        let err = locks.acquire("1.20.1", Deleting).err().unwrap();
        assert_eq!(
            err.detail.unwrap(),
            json!({ "id": "1.20.1", "activity": "inherited", "used_by": "Fabric" })
        );
        drop(fabric);
    }

    /// 实例自己的事里，备份只与 Mod 改动并行：与启动、运行、新建、补全、改名、删除和它自己两个方向都互斥；
    /// 运行中的占用可以原地转成备份（游戏退出后的自动备份），转过去之后照样挡住再次启动。
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

    /// 兼容矩阵是一张对称的表：新建、补全、改名、删除、移动与一切互斥；启动、运行只与改动并行；备份与改动、基底占用
    /// 并行；基底占用与改动、备份和它自己并行；改动除上面那五件之外都能并行。
    #[test]
    fn compatibility_matrix_is_the_symmetric_table() {
        use InstanceActivity::*;
        let all = [
            Installing, Repairing, Renaming, Deleting, Moving, Launching, Running, BackingUp,
            Modifying, Inherited,
        ];
        let table = |activity| -> &[InstanceActivity] {
            match activity {
                Installing | Repairing | Renaming | Deleting | Moving => &[],
                Launching | Running => &[Modifying],
                BackingUp => &[Modifying, Inherited],
                Inherited => &[BackingUp, Modifying, Inherited],
                Modifying => &[Launching, Running, BackingUp, Modifying, Inherited],
            }
        };
        for a in all {
            for b in all {
                assert_eq!(
                    a.compatible_with(b),
                    table(a).contains(&b),
                    "{a:?} 与 {b:?}"
                );
                assert_eq!(a.compatible_with(b), b.compatible_with(a), "{a:?} 与 {b:?}");
            }
        }
    }

    /// 基底的存档备份与别的实例以它为基底互不相干，两个方向都能并行：并行时报备份，used_by 照旧，备份放开后
    /// 回到 inherited。用它的实例退出后转去自动备份时基底当即放开：备份只碰实例自己的存档，基底这时要启动、补全都行。
    #[test]
    fn backing_up_a_base_coexists_with_the_instances_that_inherit_it() {
        use InstanceActivity::*;
        let locks = InstanceLocks::default();
        let bases = ["1.20.1".to_owned()];
        let inherited = (Some(Inherited), Some("Fabric".to_owned()));
        let backing_up = (Some(BackingUp), Some("Fabric".to_owned()));

        let fabric = locks.acquire_with_bases("Fabric", Running, &bases).unwrap();
        let backup = locks.acquire("1.20.1", BackingUp).unwrap();
        assert_eq!(locks.occupancy("1.20.1"), backing_up);
        let err = locks.acquire("1.20.1", Deleting).err().unwrap();
        assert_eq!(
            err.detail.unwrap(),
            json!({ "id": "1.20.1", "activity": "backing_up" }),
            "被拒时报备份本身，不带 used_by"
        );
        drop(backup);
        assert_eq!(locks.occupancy("1.20.1"), inherited);
        drop(fabric);

        let backup = locks.acquire("1.20.1", BackingUp).unwrap();
        let fabric = locks
            .acquire_with_bases("Fabric", Launching, &bases)
            .unwrap();
        assert_eq!(locks.occupancy("1.20.1"), backing_up);
        drop(backup);
        assert_eq!(locks.occupancy("1.20.1"), inherited);
        drop(fabric);
        assert_eq!(locks.occupancy("1.20.1"), (None, None));

        // 基底自己的游戏退出转成备份后，以它为基底的占用才进得来。
        let game = locks.acquire("1.20.1", Running).unwrap();
        assert!(locks
            .acquire_with_bases("Fabric", Repairing, &bases)
            .is_err());
        game.set_activity(BackingUp);
        let fabric = locks
            .acquire_with_bases("Fabric", Repairing, &bases)
            .unwrap();
        assert_eq!(locks.occupancy("1.20.1"), backing_up);
        drop(fabric);
        drop(game);
        assert_eq!(locks.occupancy("1.20.1"), (None, None));

        let chain = locks.acquire_with_bases("Fabric", Running, &bases).unwrap();
        let backup = chain.into_backup();
        assert_eq!(locks.activity("Fabric"), Some(BackingUp));
        assert_eq!(locks.holding(BackingUp), vec!["Fabric".to_owned()]);
        assert_eq!(locks.occupancy("1.20.1"), (None, None), "基底当即放开");
        drop(locks.acquire("1.20.1", Launching).unwrap());
        let err = locks.acquire("Fabric", Launching).err().unwrap();
        assert_eq!(err.detail.unwrap()["activity"], "backing_up");
        drop(backup);
        assert!(locks.holding(BackingUp).is_empty());
    }

    // ---- 存档备份的命令 ----

    /// 备份、恢复、导出存档不占基底：占住的只有实例自己，基底这期间照样能补全；基底的删除与改名由依赖检查挡着，
    /// 不靠实例锁。
    #[tokio::test]
    async fn world_tasks_leave_the_base_free() {
        let env = Env::new();
        env.vanilla("1.20.1");
        let instance = env.version(
            "织布",
            r#"{"id":"织布","inheritsFrom":"1.20.1","type":"release","mainClass":"K"}"#,
        );
        write_world(&instance.join("saves"), "新的世界", b"region-v1");
        let w = WorldEnv::new();

        let held = begin_world_task(&w.with(&env), "t", "织布", false)
            .await
            .unwrap();
        assert_eq!(w.locks.activity("织布"), Some(InstanceActivity::BackingUp));
        assert_eq!(w.locks.occupancy("1.20.1"), (None, None));
        drop(
            w.locks
                .acquire("1.20.1", InstanceActivity::Repairing)
                .unwrap(),
        );
        let err = delete_instance_with(&env.facade, &w.locks, "1.20.1", Remove)
            .await
            .unwrap_err();
        assert_eq!(err.code, code::INSTANCE_HAS_DEPENDENTS);
        let err = rename_instance_with(&env.facade, &w.locks, "1.20.1", "底座")
            .await
            .unwrap_err();
        assert_eq!(err.code, code::INSTANCE_HAS_DEPENDENTS);
        drop(held);
    }

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
                .join(concat!(".", petalfall_base::app_slug!()))
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

    /// 勾了存档的导出整合包会把整份 saves 读进包里，恢复却要替换存档：导出进行中恢复报 instance_busy，detail 指向
    /// 导出的实例、活动为 modifying，不登记任务、不动存档；只读存档的备份照常；导出结束后恢复不再被挡。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn restore_waits_for_an_export_that_packs_the_saves() {
        let server = MockServer::start().await;
        // 导出先按哈希向 Modrinth 查 Mod：把回音扣到用例放行，恢复和备份都落在导出进行中，
        // 不靠响应延迟。用例失败退出时放行端跟着丢弃，recv 出错，mock 的服务线程照样放开
        let (release_export, export_held) = std::sync::mpsc::channel::<()>();
        let export_held = std::sync::Mutex::new(export_held);
        Mock::given(method("POST"))
            .and(path("/version_files"))
            .respond_with(move |_request: &wiremock::Request| {
                let _ = export_held.lock().unwrap().recv();
                ResponseTemplate::new(200).set_body_json(json!({}))
            })
            .mount(&server)
            .await;
        let uri = server.uri();
        let env = Env::with(|petalfall| petalfall.with_platform_bases(&uri, &uri));
        env.vanilla("1.21.1");
        let instance = env.version(
            "织布",
            r#"{"id":"织布","inheritsFrom":"1.21.1","type":"release",
                "mainClass":"net.fabricmc.loader.impl.launch.knot.KnotClient",
                "libraries":[{"name":"net.fabricmc:fabric-loader:0.16.9"}]}"#,
        );
        std::fs::create_dir_all(instance.join("mods")).unwrap();
        std::fs::write(instance.join("mods").join("local.jar"), b"local jar bytes").unwrap();
        let world = write_world(&instance.join("saves"), "新的世界", b"region-v1");
        let w = WorldEnv::new();
        let (events, _rx) = sink();

        let facade = env.facade.clone();
        let locks = w.locks.clone();
        let export_tasks = Arc::new(TaskRegistry::default());
        let tasks = export_tasks.clone();
        let dest = env.dir.path().join("织布.mrpack");
        let options = crate::commands::modpack::ModpackExportOptionsArg {
            destination: dest.display().to_string(),
            name: "织布".into(),
            version: "1.0.0".into(),
            summary: None,
            extras: vec!["saves".into()],
            include_disabled: false,
        };
        let export = tokio::spawn(async move {
            let (events, _rx) = sink();
            crate::commands::modpack::export_modpack_with(
                &facade,
                &tasks,
                &locks,
                &GameSlot::default(),
                "ex",
                "织布",
                options,
                &events,
            )
            .await
        });
        let deadline = Instant::now() + Duration::from_secs(10);
        while !export_tasks.is_running("ex") {
            assert!(Instant::now() < deadline, "导出没有开始");
            tokio::time::sleep(Duration::from_millis(5)).await;
        }

        let err = restore_world_backup_with(
            &w.with(&env),
            "rs",
            "织布",
            "新的世界",
            "1761900000000-manual.zip",
            Recorder::default(),
            &events,
        )
        .await
        .unwrap_err();
        assert_eq!(err.code, code::INSTANCE_BUSY);
        assert_eq!(
            err.detail,
            Some(json!({ "id": "织布", "activity": "modifying" }))
        );
        assert!(!w.registry.is_running("rs"));
        assert_eq!(
            std::fs::read(world.join("region").join("r.0.0.mca")).unwrap(),
            b"region-v1"
        );
        // 备份只读存档，与导出并行无妨
        let made = backup_world_with(&w.with(&env), "bk", "织布", "新的世界", &events)
            .await
            .unwrap();
        assert_eq!(made.backup.kind, BackupKind::Manual);

        release_export.send(()).expect("mock 还在等放行");
        export.await.unwrap().unwrap();
        assert!(dest.is_file());
        let restored = restore_world_backup_with(
            &w.with(&env),
            "rs-after",
            "织布",
            "新的世界",
            &made.backup.file,
            Recorder::default(),
            &events,
        )
        .await
        .unwrap();
        assert_eq!(restored.world, "新的世界");
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
                delete_world_backup_with(
                    &env.facade,
                    &w.locks,
                    "生存",
                    world,
                    "1-auto.zip",
                    Remove,
                )
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

    /// 打包压不动的大存档时取消：以 cancelled 返回，.part 删掉，备份列表里没有半截，实例与任务都放开。
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
        assert!(registry.cancel("bk-big"));
        let err = backup.await.unwrap().unwrap_err();

        assert_eq!(err.code, common::CANCELLED);
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

    /// 解压一份文件很多的备份时取消：以 cancelled 返回，临时目录删掉，现在的存档一个字节不动，
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
        let staging = saves.join(format!(
            "新的世界.{}-restore",
            petalfall_base::brand::APP_SLUG
        ));
        let deadline = Instant::now() + Duration::from_secs(20);
        while !staging.join("region").is_dir() {
            assert!(Instant::now() < deadline, "解压没有开始");
            tokio::time::sleep(Duration::from_millis(2)).await;
        }
        assert!(registry.cancel("rs-big"));
        let err = restore.await.unwrap().unwrap_err();

        assert_eq!(err.code, common::CANCELLED);
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

    /// 处置存档时停住等测试放行：回收站收下一个大存档要好几秒，取消就落在这段时间里。放行后删掉存档；
    /// `squat` 为真时再在原处建出一个非空目录，让恢复出的副本改名就位失败。
    #[derive(Clone, Default)]
    struct HeldDisposer {
        entered: Arc<std::sync::atomic::AtomicBool>,
        release: Arc<std::sync::atomic::AtomicBool>,
        squat: bool,
    }

    impl Disposer for HeldDisposer {
        fn dispose(&self, path: &Path) -> Result<(), InstanceError> {
            use std::sync::atomic::Ordering::SeqCst;
            self.entered.store(true, SeqCst);
            let deadline = Instant::now() + Duration::from_secs(30);
            while !self.release.load(SeqCst) {
                assert!(Instant::now() < deadline, "测试一直没有放行");
                std::thread::sleep(Duration::from_millis(5));
            }
            let io = |source| InstanceError::Io {
                path: path.to_path_buf(),
                source,
            };
            std::fs::remove_dir_all(path).map_err(io)?;
            if self.squat {
                std::fs::create_dir_all(path.join("抢占")).map_err(io)?;
            }
            Ok(())
        }
    }

    /// 备份一个存档再改掉它，发起恢复，等恢复走到处置现在的存档时取消，过了取消时限才放行。
    /// 返回放行前任务是否已结束、那时实例的占用、任务的结果与现在的存档。
    async fn cancel_restore_mid_swap(
        env: &Env,
        disposer: HeldDisposer,
    ) -> (
        bool,
        Option<InstanceActivity>,
        Result<RestoreResultDto, CommandError>,
        PathBuf,
    ) {
        use std::sync::atomic::Ordering::SeqCst;
        let world = env.isolated_world("生存", "新的世界");
        let w = WorldEnv::new();
        let (events, _rx) = sink();
        let made = backup_world_with(&w.with(env), "bk", "生存", "新的世界", &events)
            .await
            .unwrap();
        std::fs::write(world.join("region").join("r.0.0.mca"), b"region-v2").unwrap();

        let facade = env.facade.clone();
        let registry = Arc::new(TaskRegistry::default());
        let locks = InstanceLocks::default();
        let game = Arc::new(GameSlot::default());
        let (r, l, g, d) = (
            registry.clone(),
            locks.clone(),
            game.clone(),
            disposer.clone(),
        );
        let file = made.backup.file;
        let restore = tokio::spawn(async move {
            let ctx = WorldTaskEnv {
                facade: &facade,
                tasks: &r,
                locks: &l,
                game: &g,
            };
            let (events, _rx) = sink();
            restore_world_backup_with(&ctx, "rs-swap", "生存", "新的世界", &file, d, &events).await
        });
        let deadline = Instant::now() + Duration::from_secs(20);
        while !disposer.entered.load(SeqCst) {
            assert!(Instant::now() < deadline, "恢复没有走到处置存档");
            tokio::time::sleep(Duration::from_millis(2)).await;
        }

        assert!(registry.cancel("rs-swap"));
        tokio::time::sleep(CANCEL_DEADLINE + Duration::from_millis(200)).await;
        let finished_early = restore.is_finished();
        let activity = locks.activity("生存");
        disposer.release.store(true, SeqCst);
        let outcome = restore.await.unwrap();
        assert_eq!(locks.activity("生存"), None);
        assert!(!registry.is_running("rs-swap"));
        (finished_early, activity, outcome, world)
    }

    /// 取消落在处置现在的存档之后：换存档已经停不下来，不能告诉用户取消了、放开实例让人在半途启动游戏。
    /// 一直等到换完，实例全程占着，结果按成功报（取消晚了一步）。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn cancelling_a_restore_mid_swap_waits_for_the_swap_to_finish() {
        let env = Env::new();
        let (finished_early, activity, outcome, world) =
            cancel_restore_mid_swap(&env, HeldDisposer::default()).await;

        assert!(!finished_early, "存档还没换完，任务不该先结束");
        assert_eq!(activity, Some(InstanceActivity::BackingUp));
        assert_eq!(
            outcome.unwrap(),
            RestoreResultDto {
                world: "新的世界".into(),
                previous_in_recycle_bin: true,
            }
        );
        assert_eq!(
            std::fs::read(world.join("region").join("r.0.0.mca")).unwrap(),
            b"region-v1"
        );
    }

    /// 取消之后才在就位那一步失败：这不是取消造成的，原存档已进回收站，恢复出的副本是用户唯一的新副本，
    /// 要照实报 world_restore_incomplete 并带上它的位置，不能被盖成 cancelled。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_restore_left_unplaced_after_cancel_still_reports_where_the_copy_is() {
        let env = Env::new();
        let disposer = HeldDisposer {
            squat: true,
            ..HeldDisposer::default()
        };
        let (_, _, outcome, world) = cancel_restore_mid_swap(&env, disposer).await;

        let err = outcome.unwrap_err();
        assert_eq!(err.code, common::WORLD_RESTORE_INCOMPLETE);
        let staged = world.parent().unwrap().join(format!(
            "新的世界.{}-restore",
            petalfall_base::brand::APP_SLUG
        ));
        assert_eq!(
            err.detail.unwrap()["staged"],
            json!(staged.display().to_string())
        );
        assert_eq!(
            std::fs::read(staged.join("region").join("r.0.0.mca")).unwrap(),
            b"region-v1"
        );
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

    /// 删除备份：zip 交给 disposer，从列表里摘掉；再删一次报 world_backup_not_found。游戏运行中也能删。
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
            &w.locks,
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
            &w.locks,
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

    /// 备份按实例名分目录放，改名时整个挪走：改名进行中删备份报 instance_busy，zip 不动；备份进行中不受影响。
    #[tokio::test]
    async fn deleting_a_backup_waits_for_a_rename_of_the_instance() {
        let env = Env::new();
        env.isolated_world("生存", "新的世界");
        let w = WorldEnv::new();
        let (events, _rx) = sink();
        let made = backup_world_with(&w.with(&env), "bk", "生存", "新的世界", &events)
            .await
            .unwrap();
        let file = made.backup.file;
        let disposer = Recorder::default();
        let delete = || {
            delete_world_backup_with(
                &env.facade,
                &w.locks,
                "生存",
                "新的世界",
                &file,
                disposer.clone(),
            )
        };

        let renaming = w.locks.acquire("生存", InstanceActivity::Renaming).unwrap();
        let err = delete().await.unwrap_err();
        assert_eq!(err.code, code::INSTANCE_BUSY);
        assert_eq!(err.detail.unwrap()["activity"], "renaming");
        assert!(disposer.disposed().is_empty());
        drop(renaming);

        let backing_up = w
            .locks
            .acquire("生存", InstanceActivity::BackingUp)
            .unwrap();
        delete().await.unwrap();
        assert_eq!(disposer.disposed().len(), 1);
        assert_eq!(
            w.locks.activity("生存"),
            Some(InstanceActivity::BackingUp),
            "删完放开自己那一份"
        );
        drop(backing_up);
    }

    /// 共用存档：另一个不隔离的实例在把存档打进整合包时，恢复同样报 instance_busy，detail 指向那个实例、活动为
    /// modifying；隔离实例自己的存档不受影响；导出读完后恢复不再被挡。
    #[tokio::test]
    async fn restoring_a_shared_world_waits_for_another_shared_export() {
        let env = Env::new();
        env.shared_world("甲", "共用");
        env.vanilla("乙");
        env.isolated_world("丙", "自己的");
        let w = WorldEnv::new();
        let (events, _rx) = sink();
        let ctx = w.with(&env);
        let restore = |id: &'static str, world: &'static str, task: &'static str| {
            restore_world_backup_with(
                &ctx,
                task,
                id,
                world,
                "1-manual.zip",
                Recorder::default(),
                &events,
            )
        };

        let reading = w.locks.read_saves("甲");
        let err = restore("乙", "共用", "rs").await.unwrap_err();
        assert_eq!(err.code, code::INSTANCE_BUSY);
        assert_eq!(
            err.detail,
            Some(json!({ "id": "甲", "activity": "modifying" }))
        );
        assert!(
            err.message.contains("导出带存档的整合包"),
            "{}",
            err.message
        );
        assert!(!w.registry.is_running("rs"));
        assert_eq!(w.locks.activity("乙"), None, "被拒绝时实例占用随之放开");
        let isolated = restore("丙", "自己的", "rs-iso").await.unwrap_err();
        assert_eq!(isolated.code, code::WORLD_BACKUP_NOT_FOUND);

        drop(reading);
        assert!(w.locks.reading_saves().is_empty());
        let after = restore("乙", "共用", "rs-after").await.unwrap_err();
        assert_eq!(after.code, code::WORLD_BACKUP_NOT_FOUND);
    }

    /// 数据包写进存档目录：本实例或共用这份存档的实例在装数据包时，备份、恢复、导出存档都报 instance_busy，
    /// detail 指向装数据包的实例，被拒时不占实例、不登记任务。隔离的实例不受影响。
    #[tokio::test]
    async fn world_tasks_wait_for_a_datapack_install() {
        let env = Env::new();
        env.shared_world("甲", "共用");
        env.vanilla("乙");
        env.isolated_world("丙", "自己的");
        let w = WorldEnv::new();
        let (events, _rx) = sink();
        let ctx = w.with(&env);
        let dest = env.dir.path().join("导出.zip");
        let dest = dest.to_str().unwrap();

        let writing = w.locks.write_saves("甲");
        for id in ["甲", "乙"] {
            let backup = backup_world_with(&ctx, "bk", id, "共用", &events)
                .await
                .unwrap_err();
            let restore = restore_world_backup_with(
                &ctx,
                "rs",
                id,
                "共用",
                "1-manual.zip",
                Recorder::default(),
                &events,
            )
            .await
            .unwrap_err();
            let export = export_world_with(&ctx, "ex", id, "共用", dest, &events)
                .await
                .unwrap_err();
            for err in [backup, restore, export] {
                assert_eq!(err.code, code::INSTANCE_BUSY, "{id}");
                assert_eq!(
                    err.detail,
                    Some(json!({ "id": "甲", "activity": "modifying" })),
                    "{id}"
                );
                assert!(err.message.contains("装数据包"), "{}", err.message);
            }
            assert_eq!(w.locks.activity(id), None, "被拒绝时实例占用随之放开");
        }
        assert!(!w.registry.is_running("bk"));
        backup_world_with(&ctx, "bk-iso", "丙", "自己的", &events)
            .await
            .unwrap();
        drop(writing);

        assert!(w.locks.writing_saves().is_empty());
        backup_world_with(&ctx, "bk-after", "乙", "共用", &events)
            .await
            .unwrap();
    }

    /// 反方向：备份或恢复在做，或者存档正被打进整合包时，装数据包等它们做完。隔离的实例在备份不挡，
    /// 记录随被拒的返回撤销。
    #[tokio::test]
    async fn datapack_writers_wait_for_world_tasks() {
        let env = Env::new();
        env.shared_world("甲", "共用");
        env.vanilla("乙");
        env.isolated_world("丙", "自己的");
        let locks = InstanceLocks::default();
        let petalfall = env.facade.snapshot().await;
        ensure_saves_free_for_writing(&petalfall, &locks, "乙")
            .await
            .unwrap();

        let backing = locks.acquire("甲", InstanceActivity::BackingUp).unwrap();
        for id in ["甲", "乙"] {
            let err = ensure_saves_free_for_writing(&petalfall, &locks, id)
                .await
                .unwrap_err();
            assert_eq!(err.code, code::INSTANCE_BUSY, "{id}");
            assert_eq!(
                err.detail,
                Some(json!({ "id": "甲", "activity": "backing_up" })),
                "{id}"
            );
        }
        ensure_saves_free_for_writing(&petalfall, &locks, "丙")
            .await
            .unwrap();
        drop(backing);

        let reading = locks.read_saves("乙");
        let err = ensure_saves_free_for_writing(&petalfall, &locks, "甲")
            .await
            .unwrap_err();
        assert_eq!(
            err.detail,
            Some(json!({ "id": "乙", "activity": "modifying" }))
        );
        assert!(
            err.message.contains("导出带存档的整合包"),
            "{}",
            err.message
        );
        drop(reading);
    }

    /// 「打开所在文件夹」只放行启动器自己产出的路径：存档备份区里的（按真实路径比，`..` 绕不出去），与这次运行里
    /// 导出写成的文件；别的路径报 invalid_argument（not_launcher_output），相对路径报 relative。
    #[test]
    fn reveal_accepts_only_launcher_outputs() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir
            .path()
            .join(".minecraft")
            .join(".petalfall")
            .join("backups");
        let backups = root.join("instances").join("生存").join("新的世界");
        std::fs::create_dir_all(&backups).unwrap();
        let config = dir.path().join("config.json");
        std::fs::write(&config, b"{}").unwrap();
        let exported = dir.path().join("分享").join("存档.zip");
        let exports = ExportedFiles::default();

        assert_eq!(
            reveal_target(backups.to_str().unwrap(), &root, &exports).unwrap(),
            backups
        );
        let escaped = root.join("..").join("..").join("..").join("config.json");
        for (path, reason) in [
            (escaped.display().to_string(), "not_launcher_output"),
            (config.display().to_string(), "not_launcher_output"),
            (exported.display().to_string(), "not_launcher_output"),
            ("分享/存档.zip".to_owned(), "relative"),
        ] {
            let err = reveal_target(&path, &root, &exports).unwrap_err();
            assert_eq!(err.code, common::INVALID_ARGUMENT, "{path}");
            assert_eq!(
                err.detail,
                Some(json!({ "field": "path", "reason": reason })),
                "{path}"
            );
        }

        exports.record(&exported);
        assert_eq!(
            reveal_target(exported.to_str().unwrap(), &root, &exports).unwrap(),
            exported
        );
        // 还没有任何备份时备份区不在，什么都不在它里面
        let missing_root = dir.path().join("另一个游戏目录").join("backups");
        let err = reveal_target(backups.to_str().unwrap(), &missing_root, &exports).unwrap_err();
        assert_eq!(err.detail.unwrap()["reason"], "not_launcher_output");
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
        let petalfall = env.facade.snapshot().await;
        ensure_shared_worlds_settled(&petalfall, &locks, "乙")
            .await
            .unwrap();

        let backing = locks.acquire("甲", InstanceActivity::BackingUp).unwrap();
        let err = ensure_shared_worlds_settled(&petalfall, &locks, "乙")
            .await
            .unwrap_err();
        assert_eq!(err.code, code::INSTANCE_BUSY);
        assert_eq!(
            err.detail,
            Some(json!({ "id": "甲", "activity": "backing_up" }))
        );
        ensure_shared_worlds_settled(&petalfall, &locks, "丙")
            .await
            .unwrap();
        // 自己在备份时由实例锁挡，这里不重复报。
        ensure_shared_worlds_settled(&petalfall, &locks, "甲")
            .await
            .unwrap();
        drop(backing);

        let isolated = locks.acquire("丙", InstanceActivity::BackingUp).unwrap();
        let modifying = locks.acquire("甲", InstanceActivity::Modifying).unwrap();
        ensure_shared_worlds_settled(&petalfall, &locks, "乙")
            .await
            .unwrap();
        drop((isolated, modifying));
    }

    /// 本实例或共用这份存档的实例正把存档打进整合包时不能启动：游戏一起来就可能写存档，包里是半截的。
    #[tokio::test]
    async fn launching_waits_for_an_export_that_reads_its_saves() {
        let env = Env::new();
        env.shared_world("甲", "共用");
        env.vanilla("乙");
        env.isolated_world("丙", "自己的");
        let locks = InstanceLocks::default();
        let petalfall = env.facade.snapshot().await;

        let reading = locks.read_saves("甲");
        for id in ["甲", "乙"] {
            let err = ensure_saves_free_for_launch(&petalfall, &locks, id)
                .await
                .unwrap_err();
            assert_eq!(err.code, code::INSTANCE_BUSY, "{id}");
            assert_eq!(
                err.detail,
                Some(json!({ "id": "甲", "activity": "modifying" })),
                "{id}"
            );
            assert!(
                err.message.contains("导出带存档的整合包"),
                "{}",
                err.message
            );
        }
        ensure_saves_free_for_launch(&petalfall, &locks, "丙")
            .await
            .unwrap();
        drop(reading);

        ensure_saves_free_for_launch(&petalfall, &locks, "甲")
            .await
            .unwrap();
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
            &w.locks,
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

    /// 一个什么都绑着的实例：改名（含只改大小写）时侧栏固定、当前选中、固定服务器的绑定、游玩记录与存档备份一起跟到
    /// 新名字，落到盘上；别的实例的绑定不动。删除时前四样清掉，备份留下。
    #[tokio::test]
    async fn rename_and_delete_keep_every_reference_in_step() {
        let env = Env::new();
        env.isolated_world("周末生存", "新的世界");
        env.vanilla("别的");
        write_playtime(
            &env,
            r#"{"format":1,"book":{
                "instances":{"周末生存":{"total_ms":5400000,"last_played_at":1761832800000}},
                "days":{"2026-10-30":{"instances":{"周末生存":5400000}}}}}"#,
        );
        let server = |address: &str, instance: &str| petalfall_core::PinnedServer {
            name: address.to_owned(),
            address: address.to_owned(),
            instance: Some(instance.to_owned()),
        };
        env.facade
            .update(|petalfall| {
                petalfall.set_sidebar_pins(vec!["周末生存".into(), "别的".into()]);
                petalfall.set_selected_version(Some("周末生存".into()));
                petalfall.set_pinned_servers(vec![
                    server("home.example", "周末生存"),
                    server("other.example", "别的"),
                ])?;
                Ok::<_, CommandError>(())
            })
            .await
            .unwrap();
        let w = WorldEnv::new();
        let (events, _rx) = sink();
        let made = backup_world_with(&w.with(&env), "bk", "周末生存", "新的世界", &events)
            .await
            .unwrap();

        for name in ["Weekend", "WEEKEND"] {
            rename_instance_with(
                &env.facade,
                &w.locks,
                &env.saved_config().await.selected_version.unwrap(),
                name,
            )
            .await
            .unwrap();
            let saved = env.saved_config().await;
            assert_eq!(saved.sidebar_pins, vec![name.to_owned(), "别的".to_owned()]);
            assert_eq!(saved.selected_version.as_deref(), Some(name));
            assert_eq!(saved.pinned_servers[0].instance.as_deref(), Some(name));
            assert_eq!(saved.pinned_servers[1].instance.as_deref(), Some("别的"));
            let summaries = env.facade.snapshot().await.play_summaries().await.unwrap();
            assert_eq!(summaries.keys().collect::<Vec<_>>(), vec![name]);
            assert_eq!(summaries[name].playtime_min, 90);
            let listed = list_world_backups_with(&env.facade, name, "新的世界")
                .await
                .unwrap();
            assert_eq!(listed.backups, vec![made.backup.clone()]);
        }

        delete_instance_with(&env.facade, &w.locks, "WEEKEND", Remove)
            .await
            .unwrap();
        let saved = env.saved_config().await;
        assert_eq!(saved.sidebar_pins, vec!["别的".to_owned()]);
        assert_eq!(saved.selected_version, None);
        assert_eq!(saved.pinned_servers[0].instance, None);
        assert_eq!(saved.pinned_servers[1].instance.as_deref(), Some("别的"));
        assert!(env
            .facade
            .snapshot()
            .await
            .play_summaries()
            .await
            .unwrap()
            .is_empty());
        assert!(env
            .backups_root()
            .join("instances")
            .join("WEEKEND")
            .join("新的世界")
            .join(&made.backup.file)
            .is_file());
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
            .update(|petalfall| {
                petalfall.set_sidebar_pins(vec!["a".into()]);
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
        let manifest: petalfall_core::VersionManifest = serde_json::from_str(
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

    // ---------------------------------------------------------------- 移到另一个游戏目录

    /// 移动与一切互斥，两个方向都是：别的事碰到正在移动的实例报 moving，移动碰到在忙的实例报那件事，被别的实例
    /// 当作基底时报 inherited 与使用者。移动以 inherited 占住继承链上的基底，基底这时只能改动、备份。
    #[tokio::test]
    async fn moving_excludes_everything_and_holds_its_bases_as_inherited() {
        use InstanceActivity::*;
        let others = [
            Installing, Repairing, Renaming, Deleting, Moving, Launching, Running, BackingUp,
            Modifying,
        ];
        let locks = InstanceLocks::default();
        assert_eq!(serde_json::to_value(Moving).unwrap(), "moving");

        let moving = locks.acquire("Pack", Moving).unwrap();
        for activity in others {
            let err = locks.acquire("pack", activity).err().unwrap();
            assert_eq!(err.code, code::INSTANCE_BUSY, "{activity:?}");
            assert_eq!(
                err.detail.unwrap(),
                json!({ "id": "pack", "activity": "moving" }),
                "{activity:?}"
            );
            assert_eq!(err.message, "实例 pack 正在移到另一个游戏目录，请稍后再试");
        }
        let err = locks
            .acquire_with_bases("Fabric", Launching, &["PACK".to_owned()])
            .err()
            .unwrap();
        assert_eq!(
            err.detail.unwrap(),
            json!({ "id": "PACK", "activity": "moving" })
        );
        assert_eq!(
            locks.activity("Fabric"),
            None,
            "被基底挡住时自己的占用一并放开"
        );
        drop(moving);

        for activity in others {
            let held = locks.acquire("pack", activity).unwrap();
            let err = locks.acquire("Pack", Moving).err().unwrap();
            assert_eq!(
                err.detail.unwrap()["activity"],
                serde_json::to_value(activity).unwrap(),
                "{activity:?}"
            );
            drop(held);
        }
        let user = locks
            .acquire_with_bases("Fabric", Running, &["pack".to_owned()])
            .unwrap();
        let err = locks.acquire("pack", Moving).err().unwrap();
        assert_eq!(
            err.detail.unwrap(),
            json!({ "id": "pack", "activity": "inherited", "used_by": "Fabric" })
        );
        drop(user);

        let chain = locks
            .acquire_with_chain("FAB", Moving, async {
                Ok::<_, CommandError>(vec!["1.20.1".to_owned()])
            })
            .await
            .unwrap();
        assert_eq!(locks.activity("fab"), Some(Moving));
        assert_eq!(
            locks.occupancy("1.20.1"),
            (Some(Inherited), Some("FAB".to_owned()))
        );
        for activity in [
            Installing, Repairing, Renaming, Deleting, Moving, Launching, Running,
        ] {
            let err = locks.acquire("1.20.1", activity).err().unwrap();
            assert_eq!(
                err.detail.unwrap(),
                json!({ "id": "1.20.1", "activity": "inherited", "used_by": "FAB" }),
                "{activity:?}"
            );
        }
        for activity in [Modifying, BackingUp] {
            drop(locks.acquire("1.20.1", activity).unwrap());
        }
        drop(chain);
        assert_eq!(locks.occupancy("1.20.1"), (None, None));
        assert_eq!(locks.activity("FAB"), None);
    }

    /// 还没记录、也还不存在的 `<临时目录>/新家/.minecraft`：显示名按叶子是 .minecraft 取上一级。
    fn new_home(env: &Env) -> PathBuf {
        env.dir.path().join("新家").join(".minecraft")
    }

    fn path_text(path: &Path) -> String {
        path.display().to_string()
    }

    /// 预检的每一种拦截项按 kind 出 JSON，带上各自的参数，顺序照门面给的；其余字段原样搬过来。
    #[test]
    fn move_preview_dto_carries_every_blocker_kind() {
        let preview = MovePreview {
            id: "生存".into(),
            source_game_dir: PathBuf::from(r"C:\Games\.minecraft"),
            target_game_dir: PathBuf::from(r"D:\新家\.minecraft"),
            same_volume: false,
            instance_bytes: 4_096,
            instance_files: 3,
            backup_bytes: 1_024,
            backup_count: 2,
            dependency_files: 17,
            dependency_bytes: 65_536,
            bases_to_copy: vec!["1.20.1".into()],
            reused_bases: vec!["1.19.4".into()],
            missing_in_source: 5,
            required_bytes: 70_656,
            available_bytes: 9,
            isolated: false,
            blockers: vec![
                MoveBlocker::SameDirectory,
                MoveBlocker::TargetInsideSource,
                MoveBlocker::NameTaken,
                MoveBlocker::HasDependents(vec!["fab".into()]),
                MoveBlocker::Links(vec![PathBuf::from("mods").join("link")]),
                MoveBlocker::BaseConflict(vec!["1.20.1".into()]),
                MoveBlocker::InsufficientSpace {
                    needed: 339_091_456,
                    available: 9,
                },
                MoveBlocker::Pending,
            ],
        };
        let json = serde_json::to_value(move_preview_dto(preview, "新家".into(), false)).unwrap();
        assert_eq!(
            json,
            json!({
                "id": "生存",
                "source": r"C:\Games\.minecraft",
                "target": r"D:\新家\.minecraft",
                "target_name": "新家",
                "target_registered": false,
                "same_volume": false,
                "instance_bytes": 4_096,
                "instance_files": 3,
                "backup_bytes": 1_024,
                "backup_count": 2,
                "dependency_files": 17,
                "dependency_bytes": 65_536,
                "bases_to_copy": ["1.20.1"],
                "reused_bases": ["1.19.4"],
                "missing_in_source": 5,
                "required_bytes": 70_656,
                "available_bytes": 9,
                "isolated": false,
                "blockers": [
                    { "kind": "same_directory" },
                    { "kind": "target_inside_source" },
                    { "kind": "name_taken" },
                    { "kind": "has_dependents", "dependents": ["fab"] },
                    { "kind": "links", "paths": [path_text(&PathBuf::from("mods").join("link"))] },
                    { "kind": "base_conflict", "bases": ["1.20.1"] },
                    { "kind": "insufficient_space", "needed": 339_091_456, "available": 9 },
                    { "kind": "pending" },
                ],
            })
        );
    }

    /// 执行前被拦下时 detail 是 `{ id, blocker }`，blocker 与预检里的一项同形。
    #[test]
    fn instance_move_blocked_carries_the_id_and_the_blocker() {
        let err = instance_error(CoreError::InstanceMoveBlocked {
            id: "1.20.1".into(),
            blocker: MoveBlocker::HasDependents(vec!["fab".into(), "叠层".into()]),
        });
        assert_eq!(err.code, code::INSTANCE_MOVE_BLOCKED);
        assert_eq!(
            err.detail.unwrap(),
            json!({
                "id": "1.20.1",
                "blocker": { "kind": "has_dependents", "dependents": ["fab", "叠层"] },
            })
        );
    }

    #[test]
    fn move_follow_ups_serialize_by_kind() {
        let follow_ups: Vec<MoveFollowUpDto> = [
            MoveFollowUp::PlayRecords("游玩记录读不出来".into()),
            MoveFollowUp::WorldBackups("备份目录被占用".into()),
            MoveFollowUp::Cleanup {
                path: PathBuf::from(r"C:\Games\.minecraft\.petalfall\moving\t1"),
                reason: "拒绝访问".into(),
            },
        ]
        .into_iter()
        .map(move_follow_up_dto)
        .collect();
        assert_eq!(
            serde_json::to_value(follow_ups).unwrap(),
            json!([
                { "kind": "play_records", "reason": "游玩记录读不出来" },
                { "kind": "world_backups", "reason": "备份目录被占用" },
                {
                    "kind": "cleanup",
                    "path": r"C:\Games\.minecraft\.petalfall\moving\t1",
                    "reason": "拒绝访问",
                },
            ])
        );
    }

    /// 真实门面上的预检：目标还不存在时按推出的名字报、没登记；目标就是当前目录时报 same_directory、已登记；
    /// 路径不合法在动手前报 invalid_game_directory。
    #[tokio::test]
    async fn move_preview_names_the_target_and_reports_its_registration() {
        let env = Env::new();
        let dir = env.vanilla("生存");
        let json_len = std::fs::metadata(dir.join("生存.json")).unwrap().len();
        let target = new_home(&env);

        let preview = preview_instance_move_with(&env.facade, "生存", &path_text(&target))
            .await
            .unwrap();
        assert_eq!(preview.id, "生存");
        assert_eq!(preview.source, path_text(&env.game_dir()));
        assert_eq!(preview.target, path_text(&target));
        assert_eq!(preview.target_name, "新家");
        assert!(!preview.target_registered);
        assert!(preview.same_volume);
        assert_eq!(
            (preview.instance_files, preview.instance_bytes),
            (1, json_len)
        );
        assert_eq!(preview.blockers, Vec::<Value>::new());
        assert!(!target.exists(), "预检不写盘");

        let same = preview_instance_move_with(&env.facade, "生存", &path_text(&env.game_dir()))
            .await
            .unwrap();
        assert!(same.target_registered);
        assert!(
            same.blockers.contains(&json!({ "kind": "same_directory" })),
            "{:?}",
            same.blockers
        );

        let err = preview_instance_move_with(&env.facade, "生存", "相对/路径")
            .await
            .unwrap_err();
        assert_eq!(err.code, code::INVALID_GAME_DIRECTORY);
        assert_eq!(err.detail.unwrap()["problem"], "not_absolute");
    }

    /// 正在运行的实例移不了：报 instance_busy 与 running，什么都没动，游戏的占用原样留着。
    #[tokio::test]
    async fn moving_a_running_instance_is_refused_before_anything_moves() {
        let env = Env::new();
        let dir = env.vanilla("生存");
        let target = new_home(&env);
        let (tasks, locks) = (TaskRegistry::default(), InstanceLocks::default());
        let (events, _rx) = sink();
        let game = locks.acquire("生存", InstanceActivity::Running).unwrap();

        let err = move_instance_with(
            &env.facade,
            &tasks,
            &locks,
            "mv",
            "生存",
            &path_text(&target),
            &events,
        )
        .await
        .unwrap_err();
        assert_eq!(err.code, code::INSTANCE_BUSY);
        assert_eq!(
            err.detail.unwrap(),
            json!({ "id": "生存", "activity": "running" })
        );
        assert!(dir.join("生存.json").is_file());
        assert!(!target.exists());
        assert_eq!(locks.activity("生存"), Some(InstanceActivity::Running));
        drop(game);

        let err = move_instance_with(&env.facade, &tasks, &locks, "mv", "生存", "", &events)
            .await
            .unwrap_err();
        assert_eq!(err.code, code::INVALID_GAME_DIRECTORY);
        assert_eq!(locks.activity("生存"), None, "路径不合法时不占实例");
    }

    /// 移到还没记录的文件夹：实例目录整个过去，原目录里它的侧栏固定与当前选中去掉、别的实例不动，目标以推出的
    /// 名字记进游戏目录列表，落到盘上、门面里同步，进度事件带着同盘的步骤表；再移一个过去时目标已在列表里，
    /// registered 为 false，列表不重复记。
    #[tokio::test]
    async fn move_carries_the_instance_and_settles_pins_selection_and_directories() {
        let env = Env::new();
        let dir = env.vanilla("生存");
        std::fs::write(dir.join("生存.jar"), b"client").unwrap();
        env.vanilla("留下");
        env.vanilla("也走");
        env.facade
            .update(|petalfall| {
                petalfall.set_sidebar_pins(vec!["生存".into(), "留下".into()]);
                petalfall.set_selected_version(Some("生存".into()));
                Ok::<_, CommandError>(())
            })
            .await
            .unwrap();
        let target = new_home(&env);
        let (tasks, locks) = (TaskRegistry::default(), InstanceLocks::default());
        let (events, mut rx) = sink();

        let outcome = move_instance_with(
            &env.facade,
            &tasks,
            &locks,
            "mv",
            "生存",
            &path_text(&target),
            &events,
        )
        .await
        .unwrap();
        assert_eq!(
            outcome,
            MoveOutcomeDto {
                id: "生存".into(),
                source: path_text(&env.game_dir()),
                target: path_text(&target),
                target_name: "新家".into(),
                registered: true,
                follow_ups: Vec::new(),
            }
        );
        let moved = target.join("versions").join("生存");
        assert_eq!(std::fs::read(moved.join("生存.jar")).unwrap(), b"client");
        assert!(moved.join("生存.json").is_file());
        assert!(!dir.exists());
        let home = vec![petalfall_core::NamedDirectory {
            name: "新家".into(),
            path: target.clone(),
        }];
        let saved = env.saved_config().await;
        assert_eq!(saved.sidebar_pins, vec!["留下".to_owned()]);
        assert_eq!(saved.selected_version, None);
        assert_eq!(saved.extra_game_directories, home);
        assert_eq!(
            &saved,
            env.facade.read().await.config(),
            "门面里的配置同步更新"
        );
        assert_eq!(
            (locks.activity("生存"), tasks.is_running("mv")),
            (None, false)
        );
        let mut plans = Vec::new();
        while let Ok(event) = rx.try_recv() {
            if let CoreEvent::Phase { plan, .. } = event {
                plans.push(plan);
            }
        }
        assert!(
            plans.contains(&vec![
                petalfall_core::InstallPhase::MoveDependencies,
                petalfall_core::InstallPhase::MoveCommit,
            ]),
            "{plans:?}"
        );
        let listed: Vec<String> = list_instances_with(&env.facade, &locks)
            .await
            .unwrap()
            .into_iter()
            .map(|i| i.id)
            .collect();
        assert_eq!(listed.len(), 2);
        assert!(!listed.contains(&"生存".to_owned()), "{listed:?}");

        let again = move_instance_with(
            &env.facade,
            &tasks,
            &locks,
            "mv2",
            "也走",
            &path_text(&target),
            &events,
        )
        .await
        .unwrap();
        assert_eq!(
            (again.target_name.as_str(), again.registered),
            ("新家", false)
        );
        assert!(target.join("versions").join("也走").is_dir());
        let saved = env.saved_config().await;
        assert_eq!(saved.extra_game_directories, home);
        assert_eq!(saved.sidebar_pins, vec!["留下".to_owned()]);
    }

    /// 目标里已有同名版本：预检列出 name_taken；执行报 instance_move_blocked，detail 带 id 与同形的拦截项；
    /// 两边都没动，实例与任务 id 随之放开。
    #[tokio::test]
    async fn a_name_taken_in_the_target_blocks_the_move_with_the_preview_shape() {
        let env = Env::new();
        let dir = env.vanilla("生存");
        let target = new_home(&env);
        let taken = target.join("versions").join("生存");
        std::fs::create_dir_all(&taken).unwrap();
        let theirs = r#"{"id":"生存","type":"release","mainClass":"Theirs"}"#;
        std::fs::write(taken.join("生存.json"), theirs).unwrap();
        let (tasks, locks) = (TaskRegistry::default(), InstanceLocks::default());
        let (events, _rx) = sink();

        let preview = preview_instance_move_with(&env.facade, "生存", &path_text(&target))
            .await
            .unwrap();
        assert_eq!(preview.blockers, vec![json!({ "kind": "name_taken" })]);

        let err = move_instance_with(
            &env.facade,
            &tasks,
            &locks,
            "mv",
            "生存",
            &path_text(&target),
            &events,
        )
        .await
        .unwrap_err();
        assert_eq!(err.code, code::INSTANCE_MOVE_BLOCKED);
        let detail = err.detail.unwrap();
        assert_eq!(detail["id"], "生存");
        assert_eq!(detail["blocker"], json!({ "kind": "name_taken" }));
        assert!(dir.join("生存.json").is_file());
        assert_eq!(
            std::fs::read_to_string(taken.join("生存.json")).unwrap(),
            theirs
        );
        assert_eq!(locks.activity("生存"), None);
        assert!(env.saved_config().await.extra_game_directories.is_empty());
        drop(tasks.register("mv").unwrap());
    }

    /// 文件已经移好、配置落不了盘（配置文件的位置被同名文件夹占着）：报配置的错误，message 说清实例已在目标里，
    /// detail.moved_to 为目标；门面不换进这次改动，实例照常放开。
    #[tokio::test]
    async fn a_move_whose_config_cannot_be_saved_says_the_instance_is_already_there() {
        let env = Env::new();
        let dir = env.vanilla("生存");
        env.facade
            .update(|petalfall| {
                petalfall.set_sidebar_pins(vec!["生存".into()]);
                Ok::<_, CommandError>(())
            })
            .await
            .unwrap();
        let config_path = env.dir.path().join("config.json");
        std::fs::remove_file(&config_path).unwrap();
        std::fs::create_dir_all(&config_path).unwrap();
        let target = new_home(&env);
        let (tasks, locks) = (TaskRegistry::default(), InstanceLocks::default());
        let (events, _rx) = sink();

        let err = move_instance_with(
            &env.facade,
            &tasks,
            &locks,
            "mv",
            "生存",
            &path_text(&target),
            &events,
        )
        .await
        .unwrap_err();
        assert_eq!(err.code, common::IO);
        let prefix = format!(
            "实例已移到「新家」（{}），但配置没能保存：",
            path_text(&target)
        );
        assert!(err.message.starts_with(&prefix), "{}", err.message);
        let detail = err.detail.unwrap();
        assert_eq!(detail["id"], "生存");
        assert_eq!(detail["moved_to"], path_text(&target));
        assert!(target
            .join("versions")
            .join("生存")
            .join("生存.json")
            .is_file());
        assert!(!dir.exists());
        let config = env.facade.read().await.config().clone();
        assert_eq!(config.sidebar_pins, vec!["生存".to_owned()]);
        assert!(config.extra_game_directories.is_empty());
        assert_eq!(locks.activity("生存"), None);
    }

    /// 启动收尾：没有中断的移动时什么都不改；提交已完成的照正常移动的口径改配置（原目录的固定与选中去掉、目标记进
    /// 列表），重复收尾不再改；回滚、推迟的不动配置，只清了残留的也不动：原目录里固定着、选中着的同名实例是此后新建的。
    #[tokio::test]
    async fn recovering_a_completed_move_settles_the_config_like_the_command() {
        let env = Env::new();
        env.vanilla("留下");
        env.facade
            .update(|petalfall| {
                petalfall.set_sidebar_pins(vec!["生存".into(), "留下".into()]);
                petalfall.set_selected_version(Some("生存".into()));
                Ok::<_, CommandError>(())
            })
            .await
            .unwrap();
        let before = env.saved_config().await;
        let target = new_home(&env);

        recover_moves(&env.facade).await;
        settle_move_recovery(
            &env.facade,
            MoveRecovery::RolledBack {
                id: "生存".into(),
                source_game_dir: env.game_dir(),
                target_game_dir: target.clone(),
            },
        )
        .await;
        settle_move_recovery(
            &env.facade,
            MoveRecovery::Settled {
                id: "生存".into(),
                source_game_dir: env.game_dir(),
                target_game_dir: target.clone(),
            },
        )
        .await;
        settle_move_recovery(
            &env.facade,
            MoveRecovery::Deferred {
                id: "生存".into(),
                reason: "目标盘不在".into(),
            },
        )
        .await;
        assert_eq!(env.saved_config().await, before);

        let completed = MoveRecovery::Completed(MoveOutcome {
            id: "生存".into(),
            source_game_dir: env.game_dir(),
            target_game_dir: target.clone(),
            follow_ups: vec![MoveFollowUp::PlayRecords("游玩记录读不出来".into())],
            token: "0".into(),
            forget_source_refs: true,
        });
        settle_move_recovery(&env.facade, completed.clone()).await;
        let saved = env.saved_config().await;
        assert_eq!(saved.sidebar_pins, vec!["留下".to_owned()]);
        assert_eq!(saved.selected_version, None);
        assert_eq!(
            saved.extra_game_directories,
            vec![petalfall_core::NamedDirectory {
                name: "新家".into(),
                path: target.clone(),
            }]
        );
        settle_move_recovery(&env.facade, completed).await;
        assert_eq!(env.saved_config().await, saved);
    }
}
