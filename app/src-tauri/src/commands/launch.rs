//! 启动与结束游戏、游戏退出监控、游玩统计。
//!
//! 同一时间只运行一个游戏，加载中也算占用：第二次 `launch_game` 返回 [`BUSY`]。前端会先按占用者所处
//! 阶段确认替换（加载中先取消、运行中先结束），这里是第二道防线。
//!
//! 启动的 `task_id` 只是取消句柄：加载阶段可经 `cancel_task` 取消，启动不进前端下载队列。阶段经
//! [`LAUNCH_PHASE_EVENT`] 推送，启动器日志与游戏输出一并经 [`GAME_LOG_EVENT`] 成批推送；进程起来后
//! 命令即返回，监控任务等它退出，收尾记账写完后先放开占用槽、再推 [`GAME_EXIT_EVENT`]——前端收到退出
//! 事件就可能立刻启动下一个实例。开着自动备份时，实例占用在退出事件之前转成「备份」、基底随之放开，把这次
//! 玩过的存档各备份一份后才放开实例，结果经 [`WORLD_BACKUP_EVENT`] 推送。
//!
//! 游戏进程起来后写下接回记录（[`petalfall_core::reattach`]），收尾记账做完后删掉：落樱在游戏运行中关闭、
//! 再打开时，启动期间在后台按记录接回那一局（[`reattach_in_background`]），之后与这次启动的游戏一样被监控。
//! 前端开机时用 [`running_game`] 问此刻有没有在跑的游戏，渲染进程重载后也凭它找回运行态。落樱退出时先在
//! 会话日志里留一行说明并落盘（[`mark_on_exit`]）。

use std::future::Future;
use std::path::PathBuf;
use std::sync::{Mutex, MutexGuard};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use petalfall_base::error_with_causes;
use petalfall_core::{
    game_line_level, AccountType, AutoBackupOutcome, DownloadProgress, Finished, GameExit, GameRun,
    GameSlot, LaunchAccount, LaunchEvent, LaunchFailed, LaunchPhase, LaunchRequest, LaunchStage,
    LauncherLevel, LogLine, LogMarker, LogSource, Petalfall, PlayRange, PlayStats, QuickPlay,
    RecordLoad, RunningRecord, SlotBusy, SlotReservation, SlotTicket,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use tauri::{AppHandle, Manager, State};
use tokio::sync::mpsc;

use crate::commands::accounts::find_account;
use crate::commands::error::code::BUSY;
use crate::commands::instances::{
    ensure_saves_free_for_launch, ChainGuard, InstanceActivity, InstanceLocks,
};
use crate::commands::CommandError;
use crate::events::{self, GAME_LOG_EVENT};
use crate::facade::Facade;
use crate::tasks::TaskRegistry;

/// 启动阶段推进与阶段 3 的下载进度。
pub const LAUNCH_PHASE_EVENT: &str = "petalfall://launch-phase";

/// 游戏进程退出（收尾记账已写完）。
pub const GAME_EXIT_EVENT: &str = "petalfall://game-exit";

/// 游戏退出后的自动备份做完了。开着自动备份时每局都推，这次没进过存档也推（两个列表都空）：实例在备份期间
/// 记着 backing_up，前端要靠这条事件知道它已放开、重读实例列表。
pub const WORLD_BACKUP_EVENT: &str = "petalfall://world-backup";

/// 运行中游戏的占用槽，连同前端开机时要问的那一局的样子。与门面分列两个 managed state：会话生命周期独立于
/// 门面，启动后门面锁应立即可用。
pub struct RunningGame {
    slot: GameSlot,
    current: Mutex<Option<Current>>,
    /// 开机时的接回尝试做完了没有。前端开机就来问，要等它做完才答得准。
    startup_done: tokio::sync::watch::Sender<bool>,
    /// 开机时读不出的接回记录，只交给第一个来问的。
    broken_record: Mutex<Option<BrokenRecordDto>>,
}

/// 已经跑起来的那一局。
struct Current {
    ticket: SlotTicket,
    info: RunningGameInfoDto,
    marker: LogMarker,
    game_log_file: PathBuf,
}

impl Default for RunningGame {
    fn default() -> Self {
        Self {
            slot: GameSlot::default(),
            current: Mutex::new(None),
            startup_done: tokio::sync::watch::channel(false).0,
            broken_record: Mutex::new(None),
        }
    }
}

impl RunningGame {
    /// 槽本身：存档备份要看此刻是哪个实例在跑游戏。
    pub(crate) fn slot(&self) -> &GameSlot {
        &self.slot
    }

    fn current(&self) -> MutexGuard<'_, Option<Current>> {
        // 临界区里只有字段赋值与克隆，不会 panic；真中毒说明程序已处于未知状态，直接崩。
        self.current.lock().expect("运行中游戏的锁已中毒")
    }

    /// 进程起来、占用转为运行中之后记下这一局。
    fn set_running(&self, ticket: SlotTicket, run: &GameRun) {
        let account = run.account();
        *self.current() = Some(Current {
            ticket,
            info: RunningGameInfoDto {
                version_id: run.version_id().to_owned(),
                pid: run.pid(),
                started_at: run.started_at(),
                running_since: run.running_since(),
                offline: run.offline(),
                reattached: run.reattached(),
                account: RunningGameAccountDto {
                    uuid: account.uuid.clone(),
                    name: account.name.clone(),
                    account_type: account.account_type,
                },
            },
            marker: run.log_marker(),
            game_log_file: run.game_log_file(),
        });
    }

    /// 放开运行中的占用。凭据过期（槽已换了主人）时什么都不做。
    fn release(&self, ticket: SlotTicket) {
        {
            let mut current = self.current();
            if current.as_ref().is_some_and(|c| c.ticket == ticket) {
                *current = None;
            }
        }
        self.slot.release(ticket);
    }

    fn mark_startup_done(&self) {
        self.startup_done.send_replace(true);
    }

    fn broken_record(&self) -> MutexGuard<'_, Option<BrokenRecordDto>> {
        self.broken_record.lock().expect("接回记录的锁已中毒")
    }
}

/// 此刻在跑的那一局的账户。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct RunningGameAccountDto {
    pub uuid: String,
    pub name: String,
    pub account_type: AccountType,
}

/// 此刻已经跑起来的那一局。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct RunningGameInfoDto {
    pub version_id: String,
    pub pid: Option<u32>,
    /// 这次启动开始（会话日志开始）的 Unix 毫秒。
    pub started_at: u64,
    /// 游戏进程起来的 Unix 毫秒，游玩时长从这里算。
    pub running_since: u64,
    pub offline: bool,
    /// 落樱关闭前启动、这次打开后接回的；`false` 是这个落樱进程自己启动的。
    pub reattached: bool,
    pub account: RunningGameAccountDto,
}

/// 开机时读不出的接回记录。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct BrokenRecordDto {
    pub path: String,
    /// 改名留存到的路径；改名也失败（或文件本身就读不了）时为 `null`。
    pub moved_to: Option<String>,
    /// 读不出的原因原文。
    pub message: String,
}

/// [`running_game`] 的结果。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct RunningGameDto {
    pub game: Option<RunningGameInfoDto>,
    pub broken_record: Option<BrokenRecordDto>,
}

/// 启动成功：进程已经起来。
#[derive(Debug, Serialize)]
pub struct LaunchedDto {
    pub pid: Option<u32>,
    /// 这一局以离线方式进单人（未经账户验证）。
    pub offline: bool,
}

/// 阶段 3 的下载进度。字段与 core-event 的下载进度一致，只少传输量：启动过程不报它。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct DownloadDto {
    pub total: u64,
    pub finished: u64,
    /// 有效字节：已就绪的字节，不含重传；声明大小与实际不符时仍可能越过 `total_bytes`，画进度时要封顶。
    pub bytes: u64,
    /// 声明大小之和；有文件大小未知时为 `null`。
    pub total_bytes: Option<u64>,
    /// 瞬时速度，字节/秒。
    pub speed: u64,
}

impl From<DownloadProgress> for DownloadDto {
    fn from(p: DownloadProgress) -> Self {
        Self {
            total: p.total,
            finished: p.finished,
            bytes: p.bytes,
            total_bytes: p.total_bytes,
            speed: p.speed,
        }
    }
}

/// [`LAUNCH_PHASE_EVENT`] 的负载。`stage_index` 对应八阶段表，同一次启动内单调不减。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct LaunchPhaseDto {
    pub task_id: String,
    pub phase: LaunchPhase,
    pub stage_index: u8,
    /// 只有阶段 3 的进度快照带这一项。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub download: Option<DownloadDto>,
}

/// 一行日志。游戏行的级别按文本推断，与日志页读回会话日志时的规则一致。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct LogLineDto {
    /// Unix 毫秒。
    pub at: u64,
    pub source: LogSource,
    pub level: LauncherLevel,
    pub text: String,
}

/// [`GAME_LOG_EVENT`] 的负载：一批按发生顺序排列的日志行。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct GameLogDto {
    pub version_id: String,
    pub lines: Vec<LogLineDto>,
}

/// [`GAME_EXIT_EVENT`] 的负载。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct GameExitDto {
    pub version_id: String,
    pub exit_code: Option<i32>,
    /// 退出码非 0、拿不到退出码或日志有崩溃标记，且不是玩家结束的。
    pub crashed: bool,
    /// 玩家结束了游戏。
    pub killed: bool,
    pub duration_ms: u64,
}

impl From<GameExit> for GameExitDto {
    fn from(exit: GameExit) -> Self {
        let GameExit {
            version_id,
            exit_code,
            crashed,
            killed,
            duration_ms,
        } = exit;
        Self {
            version_id,
            exit_code,
            crashed,
            killed,
            duration_ms,
        }
    }
}

/// 一个没备份成的存档。
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct WorldBackupFailureDto {
    /// 存档文件夹名；整场自动备份都没能开始（例如实例的工作目录解析失败）时为 `*`。
    pub world: String,
    pub error: CommandError,
}

/// [`WORLD_BACKUP_EVENT`] 的负载。
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct WorldBackupEventDto {
    pub instance_id: String,
    /// 备份成的存档文件夹名。
    pub backed_up: Vec<String>,
    pub failed: Vec<WorldBackupFailureDto>,
}

/// 整场自动备份没能开始时，`failed` 里那一项的存档名。
const ALL_WORLDS: &str = "*";

/// 自动备份的结果译成事件负载。失败都记 error：自动备份是后台进行的，前端只拿到一条通知，排查要靠日志。
fn world_backup_event(
    instance_id: &str,
    outcome: petalfall_core::Result<AutoBackupOutcome>,
) -> WorldBackupEventDto {
    let (backed_up, failed) = match outcome {
        Ok(AutoBackupOutcome { backed_up, failed }) => {
            let failed = failed
                .into_iter()
                .map(|(world, err)| {
                    tracing::error!(instance = instance_id, world, error = %err, "自动备份存档失败");
                    WorldBackupFailureDto {
                        world,
                        error: CommandError::describe(&err),
                    }
                })
                .collect();
            (backed_up, failed)
        }
        Err(err) => {
            tracing::error!(instance = instance_id, error = %err, "游戏退出后的自动备份没能开始");
            let failure = WorldBackupFailureDto {
                world: ALL_WORLDS.to_owned(),
                error: CommandError::describe(&err),
            };
            (Vec::new(), vec![failure])
        }
    };
    WorldBackupEventDto {
        instance_id: instance_id.to_owned(),
        backed_up,
        failed,
    }
}

/// `launch_game` 的直达参数：启动后直接进入存档或加入服务器。前端键名 `quickPlay`，普通启动传 null。
///
/// 内部标签枚举叠 deny_unknown_fields 是有效的：serde_derive 1.0.228 先把 `kind` 从内容里取走，
/// 再按容器属性反序列化结构体变体，多出的字段照样报错。
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum QuickPlayArg {
    /// `world_dir_name` 是 saves 下的世界文件夹名。
    Singleplayer { world_dir_name: String },
    /// `address` 是玩家写的地址原文。
    Multiplayer { address: String },
}

impl From<QuickPlayArg> for QuickPlay {
    fn from(arg: QuickPlayArg) -> Self {
        match arg {
            QuickPlayArg::Singleplayer { world_dir_name } => {
                QuickPlay::Singleplayer { world_dir_name }
            }
            QuickPlayArg::Multiplayer { address } => QuickPlay::Multiplayer { address },
        }
    }
}

/// `play_stats` 的区间参数：两端都含的本地日期 `YYYY-MM-DD`。
#[derive(Debug, Deserialize)]
pub struct PlayRangeArg {
    pub from: String,
    pub to: String,
}

/// 把启动事件译成推给前端的负载。阶段事件之外的进度归到当前所在阶段。
struct PhaseTranslator {
    task_id: String,
    version_id: String,
    stage: LaunchStage,
}

#[derive(Debug, PartialEq, Eq)]
enum Outgoing {
    Phase(LaunchPhaseDto),
    Log(GameLogDto),
}

impl PhaseTranslator {
    fn new(task_id: String, version_id: String) -> Self {
        Self {
            task_id,
            version_id,
            stage: LaunchStage::CheckJava,
        }
    }

    fn translate(&mut self, event: LaunchEvent) -> Outgoing {
        match event {
            LaunchEvent::Stage(stage) => {
                self.stage = stage;
                Outgoing::Phase(self.phase(None))
            }
            LaunchEvent::Download(progress) => Outgoing::Phase(self.phase(Some(progress.into()))),
            LaunchEvent::Log { at, level, text } => Outgoing::Log(GameLogDto {
                version_id: self.version_id.clone(),
                lines: vec![LogLineDto {
                    at,
                    source: LogSource::Launcher,
                    level,
                    text,
                }],
            }),
        }
    }

    fn phase(&self, download: Option<DownloadDto>) -> LaunchPhaseDto {
        LaunchPhaseDto {
            task_id: self.task_id.clone(),
            phase: self.stage.phase(),
            stage_index: self.stage.index(),
            download,
        }
    }
}

/// 一批游戏输出转成日志行。级别只看文本不看来自哪条流：会话日志不记流，读回时也只能看文本。
fn game_log(version_id: &str, batch: Vec<LogLine>) -> GameLogDto {
    GameLogDto {
        version_id: version_id.to_owned(),
        lines: batch
            .into_iter()
            .map(|line| LogLineDto {
                at: line.at,
                source: LogSource::Game,
                level: game_line_level(&line.text),
                text: line.text,
            })
            .collect(),
    }
}

fn busy(err: SlotBusy) -> CommandError {
    let phase = if err.running { "running" } else { "loading" };
    CommandError::new(BUSY, err.to_string())
        .with_detail(json!({ "version_id": err.version_id, "phase": phase }))
}

/// 启动失败转成命令错误：可处理的失败用失败码，插值参数平铺进 `detail`，原因链放 `detail.causes`。
fn launch_error(err: LaunchFailed) -> CommandError {
    let failure = match err {
        LaunchFailed::Core(err) => return err.into(),
        LaunchFailed::Failure(failure) => failure,
    };
    let mut detail: Map<String, Value> = failure
        .params
        .iter()
        .map(|(key, value)| (key.clone(), value.clone()))
        .collect();
    let mut causes = Vec::new();
    let mut current = std::error::Error::source(&*failure);
    while let Some(cause) = current {
        causes.push(cause.to_string());
        current = cause.source();
    }
    if !causes.is_empty() {
        detail.insert("causes".to_owned(), json!(causes));
    }
    let code = failure.code.as_str();
    tracing::warn!(code, message = %failure.message, ?causes, "启动失败");
    CommandError::new(code, failure.message.clone()).with_detail(Value::Object(detail))
}

/// 等游戏退出并译成退出事件。等待进程本身失败时门面照样给出这一局的结局（退出码无从得知按崩溃判定，
/// 玩家点过结束的算结束），那次失败与记账失败一起只记进启动器日志：前端总要有一个结局才能离开运行态。
async fn settle(finish: impl Future<Output = Finished>) -> GameExitDto {
    let Finished { exit, problems } = finish.await;
    for problem in &problems {
        tracing::error!(version = %exit.version_id, error = %problem, "游戏收尾出现问题");
    }
    exit.into()
}

/// 被监控的一局游戏：哪个实例、会话从何时算起（自动备份只挑这之后写过 level.dat 的存档）、它连同基底的占用。
struct Watched {
    version_id: String,
    session_started: SystemTime,
    instance: ChainGuard,
}

/// 监控一局游戏：收尾后先放开占用槽，再推退出事件。
///
/// 关着自动备份时实例与基底的占用同占用槽一起放开。开着时实例自己的占用先原地转成「备份」、基底放开，再放开
/// 占用槽：中间不留空档，备份期间实例不会被改名、删除或再次启动，基底却能启动；退出事件照常先推（前端据此离开
/// 运行态），备份做完才放开实例、推备份事件。
async fn watch(
    facade: &Facade,
    watched: Watched,
    finish: impl Future<Output = Finished>,
    release_slot: impl FnOnce(),
    emit_exit: impl FnOnce(GameExitDto),
    emit_backup: impl FnOnce(WorldBackupEventDto),
) {
    let Watched {
        version_id,
        session_started,
        instance,
    } = watched;
    let exit = settle(finish).await;
    // 收尾记账做完才删：删在前面的话，这期间落樱退出，下次打开就既认不出这一局、也补不上它的记账。
    // 删不掉的记录指向一个已经退出的进程，下次打开时按「进程已退出」丢弃。
    if let Err(err) = facade.snapshot().await.remove_running_record().await {
        tracing::error!(version = %version_id, error = %err, "删除接回记录失败");
    }
    let auto = facade.read().await.config().world_backup.auto;
    if !auto {
        drop(instance);
        release_slot();
        emit_exit(exit);
        return;
    }
    let instance = instance.into_backup();
    release_slot();
    emit_exit(exit);
    // 不挂取消令牌：自动备份不是前端发起的任务，没有能取消它的入口。
    let outcome = facade
        .snapshot()
        .await
        .auto_backup_after_session(&version_id, session_started)
        .await;
    drop(instance);
    emit_backup(world_backup_event(&version_id, outcome));
}

/// 实例与它基底的占用随进程寿命：游戏退出、收尾记账做完后放开基底，开着自动备份时实例留到备份做完。删除、
/// 改名、补全它们在这期间被拒绝。
fn spawn_watch(
    app: AppHandle,
    ticket: SlotTicket,
    instance: ChainGuard,
    run: GameRun,
    session_started: SystemTime,
) {
    let version_id = run.version_id().to_owned();
    tauri::async_runtime::spawn(async move {
        let facade = app.state::<Facade>();
        watch(
            &facade,
            Watched {
                version_id,
                session_started,
                instance,
            },
            run.finish(),
            || app.state::<RunningGame>().release(ticket),
            |exit| events::emit(&app, GAME_EXIT_EVENT, exit),
            |backup| events::emit(&app, WORLD_BACKUP_EVENT, backup),
        )
        .await;
    });
}

/// 启动前的两道占用：全局只跑一个游戏（[`BUSY`]），目标实例此刻没有在安装、补全、改名或删除，
/// 它继承链上的基底版本也没有在做这几件事（`instance_busy`）。加载器实例的客户端 jar 与 natives 在
/// 基底的目录里，基底跟着实例一直占到游戏退出。后一道失败时前一道的预留随返回值一起丢弃，不会把
/// 占用槽留在加载中。
async fn reserve_launch<'a>(
    running: &'a RunningGame,
    locks: &InstanceLocks,
    petalfall: &Petalfall,
    version_id: &str,
) -> Result<(SlotReservation<'a>, ChainGuard), CommandError> {
    let reservation = running.slot.reserve(version_id).map_err(busy)?;
    let instance = locks
        .acquire_with_chain(version_id, InstanceActivity::Launching, async {
            Ok(petalfall.inheritance_chain(version_id).await?)
        })
        .await?;
    Ok((reservation, instance))
}

/// 用哪个账户启动。
enum AccountArg {
    Stored(String),
    Offline(String),
}

/// 启动一个已安装版本。账户给 `account_uuid`（账户库里的账户）或 `offline_name`（临时离线账户）二者之一。
/// 内存、Java、JVM 参数与分辨率由后端按实例设置与全局设置解析。`quick_play` 给出时启动后直接进入存档或
/// 加入服务器：版本不支持报 quick_play_unsupported（detail.version_id、mode），存档不在报 world_not_found，
/// 世界文件夹名过不了系统代码页报 world_name_unencodable（detail.version_id、world、char），
/// 地址写法不对报 invalid_argument（detail.address），都在校验游戏文件阶段报出。
///
/// `offline_fallback` 为真时以离线方式进单人：不刷新登录，用账户上次登录时的档案名进游戏。能否放行由
/// 后端凭这个账户上一次启动的失败判定，不能放行时报 `invalid_argument`（`detail.field` 为
/// `offlineFallback`，`detail.reason` 为拒绝原因）。取消、占用与互斥的语义与普通启动相同。
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn launch_game(
    app: AppHandle,
    task_id: String,
    version_id: String,
    account_uuid: Option<String>,
    offline_name: Option<String>,
    offline_fallback: bool,
    quick_play: Option<QuickPlayArg>,
    facade: State<'_, Facade>,
    tasks: State<'_, TaskRegistry>,
    running: State<'_, RunningGame>,
    locks: State<'_, InstanceLocks>,
) -> Result<LaunchedDto, CommandError> {
    let account = match (account_uuid, offline_name) {
        (Some(uuid), None) => AccountArg::Stored(uuid),
        (None, Some(name)) => AccountArg::Offline(name),
        _ => {
            return Err(CommandError::invalid_argument(
                "启动需提供 account_uuid 与 offline_name 二者之一",
            ))
        }
    };
    let petalfall = facade.snapshot().await;
    // 实例与它基底的占用从这里一直持有到游戏退出。
    let (reservation, instance) = reserve_launch(&running, &locks, &petalfall, &version_id).await?;
    // 共用存档的实例：先占住自己再查别人，查完之后再有别的实例想备份共用存档，会被占用槽那一侧的检查挡住。
    ensure_saves_free_for_launch(&petalfall, &locks, &version_id).await?;
    let task = tasks.register(&task_id)?;
    let petalfall = petalfall.with_cancel(task.token().clone());

    let (events_tx, mut events_rx) = mpsc::unbounded_channel::<LaunchEvent>();
    let phase_app = app.clone();
    let mut translator = PhaseTranslator::new(task_id.clone(), version_id.clone());
    let phases = tauri::async_runtime::spawn(async move {
        while let Some(event) = events_rx.recv().await {
            match translator.translate(event) {
                Outgoing::Phase(payload) => events::emit(&phase_app, LAUNCH_PHASE_EVENT, payload),
                Outgoing::Log(payload) => events::emit(&phase_app, GAME_LOG_EVENT, payload),
            }
        }
    });
    // 游戏输出的转发寿命随进程：管道关闭后汇流任务放掉发送端，循环自然结束，所以这里不 await。
    let (log_tx, log_rx) = mpsc::unbounded_channel::<Vec<LogLine>>();
    forward_game_log(&app, version_id.clone(), log_rx);

    // 在拉起进程之前取：这之后被写过 level.dat 的存档，就是这一局进过的存档。
    let session_started = SystemTime::now();
    let launched = task
        .run(async {
            let account = match account {
                AccountArg::Stored(uuid) => {
                    LaunchAccount::Stored(Box::new(find_account(&petalfall, &uuid).await?))
                }
                AccountArg::Offline(name) => LaunchAccount::Offline { name },
            };
            let request = LaunchRequest {
                version_id: version_id.clone(),
                account,
                launcher_version: app.package_info().version.to_string(),
                game_log: Some(log_tx),
                quick_play: quick_play.map(QuickPlay::from),
            };
            let launched = if offline_fallback {
                petalfall.launch_offline_fallback(request, &events_tx).await
            } else {
                petalfall.launch(request, &events_tx).await
            };
            launched.map_err(launch_error)
        })
        .await;
    drop(events_tx);
    if let Err(err) = phases.await {
        tracing::error!(error = %err, "启动阶段转发任务异常结束");
    }
    let run = launched?;
    if let Err(err) = save_record(&petalfall, &run, session_started).await {
        // 写不成不挡这一局：游戏照常运行、照常监控，只是落樱在这期间关掉的话，再打开时认不出它。
        let text = format!(
            "这一局的接回记录没写成（{}），游戏运行中关闭落樱后再打开将认不出这一局",
            error_with_causes(&err)
        );
        tracing::warn!(version = %version_id, "{text}");
        if let Err(mark_err) = run
            .log_marker()
            .mark(LauncherLevel::Warn, text.clone())
            .await
        {
            tracing::warn!(error = %mark_err, "会话日志里记不下接回记录没写成");
        }
        events::emit(
            &app,
            GAME_LOG_EVENT,
            launcher_line(&version_id, run.now(), LauncherLevel::Warn, text),
        );
    }

    let launched = LaunchedDto {
        pid: run.pid(),
        offline: run.offline(),
    };
    let ticket = reservation.occupy(run.kill_switch());
    running.set_running(ticket, &run);
    instance.set_activity(InstanceActivity::Running);
    spawn_watch(app, ticket, instance, run, session_started);
    Ok(launched)
}

/// 写下这一局的接回记录。
async fn save_record(
    petalfall: &Petalfall,
    run: &GameRun,
    session_started: SystemTime,
) -> petalfall_core::Result<()> {
    let backup_since = session_started
        .duration_since(UNIX_EPOCH)
        .map_err(petalfall_core::CoreError::SystemClock)?;
    let backup_since = u64::try_from(backup_since.as_millis()).expect("毫秒数在 u64 范围内");
    petalfall
        .save_running_record(&run.running_record(backup_since)?)
        .await
}

/// 一行启动器日志，推给前端。
fn launcher_line(version_id: &str, at: u64, level: LauncherLevel, text: String) -> GameLogDto {
    GameLogDto {
        version_id: version_id.to_owned(),
        lines: vec![LogLineDto {
            at,
            source: LogSource::Launcher,
            level,
            text,
        }],
    }
}

/// 此刻已经跑起来的那一局（这次启动的与开机接回的都算，还在加载的不算），连同开机时读不出的接回记录
/// （只交给第一次调用）。先等开机时的接回尝试做完，否则开机就来问的前端会错过接回的那一局。
#[tauri::command]
pub async fn running_game(running: State<'_, RunningGame>) -> Result<RunningGameDto, CommandError> {
    running_game_now(&running).await
}

async fn running_game_now(running: &RunningGame) -> Result<RunningGameDto, CommandError> {
    let mut done = running.startup_done.subscribe();
    done.wait_for(|done| *done).await.map_err(|_| {
        CommandError::new(
            crate::commands::error::code::INTERNAL,
            "开机接回的完成信号已经不在了",
        )
    })?;
    let game = running
        .current()
        .as_ref()
        .map(|current| current.info.clone());
    let broken_record = running.broken_record().take();
    Ok(RunningGameDto {
        game,
        broken_record,
    })
}

/// 开机时在后台按接回记录接回落樱关闭前启动、此刻仍在运行的游戏。在 setup 里调：前端加载要几百毫秒，这期间
/// 已经接回并占住槽，玩家抢先点启动也会被「正在运行」挡住。
pub fn reattach_in_background(app: &AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let running = app.state::<RunningGame>();
        if let Err(err) = reattach_recorded(&app).await {
            tracing::error!(error = %err, causes = ?crate::commands::error::source_chain(&err), "接回上次关闭前在跑的游戏失败");
        }
        running.mark_startup_done();
    });
}

/// 读接回记录、核对进程、接回并开始监控。记录读不出时留给 [`running_game`] 交给前端；进程已不在或对不上时
/// 删掉记录。文件本身读不了等意外的失败冒泡：记录留着，下次打开再试。
async fn reattach_recorded(app: &AppHandle) -> petalfall_core::Result<()> {
    let facade = app.state::<Facade>();
    let petalfall = facade.snapshot().await;
    let running = app.state::<RunningGame>();
    let record = match petalfall.load_running_record().await {
        Ok(RecordLoad::Missing) => return Ok(()),
        Ok(RecordLoad::Loaded(record)) => record,
        Ok(RecordLoad::Broken {
            path,
            moved_to,
            error,
        }) => {
            tracing::error!(path = %path.display(), moved_to = ?moved_to, error = %error_with_causes(&error), "接回记录读不出来，改名留存");
            *running.broken_record() = Some(BrokenRecordDto {
                path: path.display().to_string(),
                moved_to: moved_to.map(|path| path.display().to_string()),
                message: error_with_causes(&error),
            });
            return Ok(());
        }
        Err(err) => {
            // 文件在、却读不了（权限、磁盘）：没有移走，告诉前端这一局不会补记。
            *running.broken_record() = Some(BrokenRecordDto {
                path: petalfall.running_record_path().display().to_string(),
                moved_to: None,
                message: error_with_causes(&err),
            });
            return Err(err);
        }
    };
    let process = match record.open_process()? {
        Ok(process) => process,
        Err(refusal) => {
            tracing::info!(version = %record.instance_id, pid = record.process.pid, %refusal, "上次关闭前在跑的游戏没有接回");
            return petalfall.remove_running_record().await;
        }
    };
    let reservation = match running.slot.reserve(&record.instance_id) {
        Ok(reservation) => reservation,
        Err(busy) => {
            // 开机时还没有前端，没有谁能先占住槽；真走到这里说明装配顺序出了问题。记录留着，下次再接。
            tracing::error!(version = %record.instance_id, error = %busy, "开机接回时占用槽已被占着，不接回");
            return Ok(());
        }
    };
    let Some(instance) = hold_reattached(&app.state::<InstanceLocks>(), &petalfall, &record).await
    else {
        // 开机时不该有人占着实例；占不住就不接，记录留着，下次打开再试。
        return Ok(());
    };
    let (log_tx, log_rx) = mpsc::unbounded_channel::<Vec<LogLine>>();
    forward_game_log(app, record.instance_id.clone(), log_rx);
    let run = petalfall.reattach(&record, process, Some(log_tx)).await?;
    let ticket = reservation.occupy(run.kill_switch());
    running.set_running(ticket, &run);
    instance.set_activity(InstanceActivity::Running);
    tracing::info!(version = %record.instance_id, pid = record.process.pid, "接回了上次关闭前在跑的游戏");
    let session_started = UNIX_EPOCH + Duration::from_millis(record.backup_since);
    spawn_watch(app.clone(), ticket, instance, run, session_started);
    Ok(())
}

/// 接回的那一局占住实例与基底，与启动时一样防它在运行期间被改名、删除、补全。基底按当前游戏目录读继承链：
/// 记录里的游戏目录不是当前的、或继承链读不出（实例的版本 JSON 已经不在）时只占实例自己。连实例自己都占不住
/// 时为 `None`。
async fn hold_reattached(
    locks: &InstanceLocks,
    petalfall: &Petalfall,
    record: &RunningRecord,
) -> Option<ChainGuard> {
    let id = record.instance_id.as_str();
    if petalfall_core::folders::same_path(&record.game_dir, petalfall.game_dir()) {
        match locks
            .acquire_with_chain(id, InstanceActivity::Launching, async {
                Ok(petalfall.inheritance_chain(id).await?)
            })
            .await
        {
            Ok(guard) => return Some(guard),
            Err(err) => {
                tracing::warn!(version = id, error = %err.message, "接回的实例读不出继承链，只占实例自己");
            }
        }
    }
    match locks
        .acquire_with_chain(id, InstanceActivity::Launching, async { Ok(Vec::new()) })
        .await
    {
        Ok(guard) => Some(guard),
        Err(err) => {
            tracing::error!(version = id, error = %err.message, "接回的实例占不住，不接回");
            None
        }
    }
}

/// 落樱退出时给会话日志留说明最多等这么久。写的只是一行加一次落盘，正常是毫秒级；磁盘卡住时不能让窗口关掉
/// 之后的进程一直挂着。
pub const EXIT_MARK_DEADLINE: Duration = Duration::from_secs(2);

/// 落樱退出时游戏还在跑：在会话日志里留一行说明并把写缓冲落盘。不落盘的话缓冲里最后几行随进程没了，日志里也
/// 看不出从哪一刻起不再记录。在 `RunEvent::Exit` 里调，结果只进启动器日志。
pub fn mark_on_exit(app: &AppHandle) {
    let marked = app
        .state::<RunningGame>()
        .current()
        .as_ref()
        .map(|current| {
            (
                current.marker.clone(),
                current.game_log_file.clone(),
                current.info.version_id.clone(),
            )
        });
    let Some((marker, game_log, version)) = marked else {
        return;
    };
    let text = format!(
        "落樱已关闭，游戏仍在运行；之后的游戏输出不在这份日志里，见 {}。游戏结束前重新打开落樱会接回这一局",
        game_log.display()
    );
    match block_on_within(EXIT_MARK_DEADLINE, marker.mark(LauncherLevel::Warn, text)) {
        Ok(Ok(true)) => tracing::info!(version, "落樱退出时游戏仍在运行，会话日志已留下说明并落盘"),
        Ok(Ok(false)) => tracing::info!(version, "落樱退出时游戏仍在运行，这一局没有会话日志可写"),
        Ok(Err(err)) => {
            tracing::warn!(version, error = %err, "落樱退出时会话日志写入失败，缓冲里最后的输出随退出丢失")
        }
        Err(_) => tracing::warn!(
            version,
            deadline_ms = EXIT_MARK_DEADLINE.as_millis() as u64,
            "落樱退出时会话日志落盘超时，缓冲里最后的输出随退出丢失"
        ),
    }
}

/// 在运行时之外（`RunEvent::Exit` 的主线程上）限时等一个异步动作。计时器要在运行时里建：在外面建会因为
/// 找不到运行时直接 panic，退出钩子后面的补写游玩记录、退出时安装更新都跟着做不成。
fn block_on_within<F: Future>(
    deadline: Duration,
    work: F,
) -> Result<F::Output, tokio::time::error::Elapsed> {
    tauri::async_runtime::block_on(async move { tokio::time::timeout(deadline, work).await })
}

/// 把一批批游戏输出推给前端。寿命随汇流任务：会话结束后发送端放掉，循环自然结束。
fn forward_game_log(
    app: &AppHandle,
    version_id: String,
    mut rx: mpsc::UnboundedReceiver<Vec<LogLine>>,
) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        while let Some(batch) = rx.recv().await {
            events::emit(&app, GAME_LOG_EVENT, game_log(&version_id, batch));
        }
    });
}

/// 结束运行中的游戏，等结束动作执行完才返回；退出结果经 [`GAME_EXIT_EVENT`] 推送。没有运行中的游戏时
/// 为空操作（加载中的启动用 `cancel_task` 取消）。
#[tauri::command]
pub async fn stop_game(running: State<'_, RunningGame>) -> Result<(), CommandError> {
    let Some(kill) = running.slot.kill_switch() else {
        tracing::info!("结束游戏：没有运行中的游戏");
        return Ok(());
    };
    let killed = kill.kill().await?;
    tracing::info!(killed, "结束游戏");
    Ok(())
}

/// 当前游戏目录在一段本地日期区间（两端都含）的游玩统计。
#[tauri::command]
pub async fn play_stats(
    range: PlayRangeArg,
    facade: State<'_, Facade>,
) -> Result<PlayStats, CommandError> {
    let parsed = PlayRange::parse(&range.from, &range.to).ok_or_else(|| {
        CommandError::invalid_argument(format!(
            "统计区间 {} 至 {} 无效：日期须为 YYYY-MM-DD，且起点不晚于终点",
            range.from, range.to
        ))
        .with_detail(json!({ "from": range.from, "to": range.to }))
    })?;
    let petalfall = facade.snapshot().await;
    Ok(petalfall.play_stats(parsed).await?)
}

#[cfg(test)]
mod tests {
    use super::*;
    use petalfall_core::{FailureCode, LaunchFailure, LogStream};
    use std::collections::BTreeMap;

    fn progress(total: u64, finished: u64) -> DownloadProgress {
        DownloadProgress {
            total,
            finished,
            bytes: finished * 100,
            total_bytes: Some(total * 100),
            transferred: finished * 100,
            speed: 50,
        }
    }

    fn exit(version_id: &str, code: Option<i32>, crashed: bool, killed: bool) -> GameExit {
        GameExit {
            version_id: version_id.to_owned(),
            exit_code: code,
            crashed,
            killed,
            duration_ms: 61_000,
        }
    }

    #[test]
    fn translated_stage_index_never_goes_back_and_downloads_belong_to_stage_three() {
        let mut translator = PhaseTranslator::new("t-1".into(), "1.21".into());
        let script = vec![
            LaunchEvent::Stage(LaunchStage::CheckJava),
            LaunchEvent::Log {
                at: 5,
                level: LauncherLevel::Warn,
                text: "路径含中文".into(),
            },
            LaunchEvent::Stage(LaunchStage::VerifyFiles),
            LaunchEvent::Stage(LaunchStage::CompleteLibraries),
            LaunchEvent::Stage(LaunchStage::DownloadMissing),
            LaunchEvent::Download(progress(10, 3)),
            LaunchEvent::Download(progress(10, 10)),
            LaunchEvent::Stage(LaunchStage::ExtractNatives),
            LaunchEvent::Stage(LaunchStage::BuildArguments),
            LaunchEvent::Stage(LaunchStage::SpawnProcess),
            LaunchEvent::Stage(LaunchStage::Running),
        ];
        let mut indices = Vec::new();
        for event in script {
            if let Outgoing::Phase(payload) = translator.translate(event) {
                assert_eq!(payload.task_id, "t-1");
                if let Some(download) = &payload.download {
                    assert_eq!(payload.stage_index, 3);
                    assert_eq!(payload.phase, LaunchPhase::Downloading);
                    assert_eq!(download.total, 10);
                }
                indices.push(payload.stage_index);
            }
        }
        assert_eq!(indices, vec![0, 1, 2, 3, 3, 3, 4, 5, 6, 7]);
        assert!(indices.windows(2).all(|w| w[0] <= w[1]));
    }

    #[test]
    fn phase_payload_serializes_snake_case_and_omits_absent_download() {
        let mut translator = PhaseTranslator::new("t-9".into(), "1.21".into());
        let Outgoing::Phase(stage) =
            translator.translate(LaunchEvent::Stage(LaunchStage::DownloadMissing))
        else {
            panic!("阶段事件应译成阶段负载");
        };
        assert_eq!(
            serde_json::to_value(&stage).unwrap(),
            json!({ "task_id": "t-9", "phase": "downloading", "stage_index": 3 })
        );
        let Outgoing::Phase(download) = translator.translate(LaunchEvent::Download(progress(4, 1)))
        else {
            panic!("进度应译成阶段负载");
        };
        assert_eq!(
            serde_json::to_value(&download).unwrap(),
            json!({
                "task_id": "t-9",
                "phase": "downloading",
                "stage_index": 3,
                "download": { "total": 4, "finished": 1, "bytes": 100, "total_bytes": 400, "speed": 50 }
            })
        );
    }

    #[test]
    fn launcher_and_game_lines_share_one_shape() {
        let mut translator = PhaseTranslator::new("t".into(), "1.21".into());
        let launcher = translator.translate(LaunchEvent::Log {
            at: 1_700,
            level: LauncherLevel::Warn,
            text: "w".into(),
        });
        assert_eq!(
            launcher,
            Outgoing::Log(GameLogDto {
                version_id: "1.21".into(),
                lines: vec![LogLineDto {
                    at: 1_700,
                    source: LogSource::Launcher,
                    level: LauncherLevel::Warn,
                    text: "w".into(),
                }],
            })
        );
        let batch = game_log(
            "1.21",
            vec![
                LogLine {
                    at: 10,
                    stream: LogStream::Stdout,
                    text: "[main/INFO]: hi".into(),
                },
                LogLine {
                    at: 11,
                    stream: LogStream::Stderr,
                    text: "[Render thread/ERROR]: boom".into(),
                },
            ],
        );
        assert_eq!(
            serde_json::to_value(&batch).unwrap(),
            json!({
                "version_id": "1.21",
                "lines": [
                    { "at": 10, "source": "game", "level": "info", "text": "[main/INFO]: hi" },
                    { "at": 11, "source": "game", "level": "error", "text": "[Render thread/ERROR]: boom" }
                ]
            })
        );
    }

    /// 开机就来问的前端要等接回尝试做完；读不出的记录只交给第一次调用。
    #[tokio::test]
    async fn running_game_waits_for_the_startup_attempt_and_hands_the_broken_record_once() {
        let running = std::sync::Arc::new(RunningGame::default());
        *running.broken_record() = Some(BrokenRecordDto {
            path: "C:/Petalfall/running-game.json".into(),
            moved_to: Some("C:/Petalfall/running-game.broken.json".into()),
            message: "读不懂 running-game.json：missing field `pid`".into(),
        });
        let asking = tokio::spawn({
            let running = running.clone();
            async move { running_game_now(&running).await.unwrap() }
        });
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        assert!(!asking.is_finished(), "接回尝试做完之前不应作答");
        running.mark_startup_done();
        let first = asking.await.unwrap();
        assert_eq!(first.game, None);
        assert_eq!(
            first.broken_record.map(|broken| broken.moved_to),
            Some(Some("C:/Petalfall/running-game.broken.json".to_owned()))
        );
        let second = running_game_now(&running).await.unwrap();
        assert_eq!(second.broken_record, None);
    }

    /// 退出钩子跑在主线程上、不在运行时里：限时等待照样能用，超时如实报超时，而不是因为在运行时之外建计时器 panic。
    #[test]
    fn deadline_wait_works_outside_the_runtime_and_reports_the_timeout() {
        assert_eq!(
            block_on_within(Duration::from_secs(1), async { 42 }).unwrap(),
            42
        );
        assert!(block_on_within(Duration::from_millis(50), std::future::pending::<()>()).is_err());
    }

    /// 与前端 ipc/launch.ts 的 RunningGameDto 一致的键名与取值。
    #[test]
    fn running_game_payload_matches_the_frontend_contract() {
        let dto = RunningGameDto {
            game: Some(RunningGameInfoDto {
                version_id: "1.20.1-fabric".into(),
                pid: Some(4242),
                started_at: 1_798_000_000_123,
                running_since: 1_798_000_004_567,
                offline: false,
                reattached: true,
                account: RunningGameAccountDto {
                    uuid: "0123456789abcdef0123456789abcdef".into(),
                    name: "Steve".into(),
                    account_type: AccountType::AuthlibInjector,
                },
            }),
            broken_record: None,
        };
        assert_eq!(
            serde_json::to_value(&dto).unwrap(),
            json!({
                "game": {
                    "version_id": "1.20.1-fabric",
                    "pid": 4242,
                    "started_at": 1_798_000_000_123_u64,
                    "running_since": 1_798_000_004_567_u64,
                    "offline": false,
                    "reattached": true,
                    "account": {
                        "uuid": "0123456789abcdef0123456789abcdef",
                        "name": "Steve",
                        "account_type": "authlib_injector"
                    }
                },
                "broken_record": null
            })
        );
    }

    #[test]
    fn launch_failure_keeps_its_code_and_flattens_params() {
        let mut params = BTreeMap::new();
        params.insert("major".to_owned(), json!(21));
        params.insert("mc_version".to_owned(), json!("1.21"));
        let failure = LaunchFailure {
            code: FailureCode::JavaMissing,
            message: "找不到 Java 21".into(),
            params,
            source: None,
        };
        let err = launch_error(LaunchFailed::Failure(Box::new(failure)));
        assert_eq!(err.code, "java_missing");
        assert_eq!(err.message, "找不到 Java 21");
        assert_eq!(
            err.detail,
            Some(json!({ "major": 21, "mc_version": "1.21" }))
        );

        let core = launch_error(LaunchFailed::Core(
            petalfall_core::CoreError::VersionNotInstalled { id: "ghost".into() },
        ));
        assert_eq!(core.code, "version_not_installed");
        let cancelled = launch_error(LaunchFailed::Core(petalfall_core::CoreError::Download(
            petalfall_core::DownloadError::Cancelled,
        )));
        assert!(cancelled.is_cancelled());
    }

    /// 临时游戏目录上的门面：`versions` 里每项是 (id, inheritsFrom)。
    fn facade_with(dir: &std::path::Path, versions: &[(&str, Option<&str>)]) -> Facade {
        for (id, parent) in versions {
            let version_dir = dir.join(".minecraft").join("versions").join(id);
            std::fs::create_dir_all(&version_dir).unwrap();
            let mut body = json!({ "id": id, "type": "release", "mainClass": "M" });
            if let Some(parent) = parent {
                body["inheritsFrom"] = json!(parent);
            }
            std::fs::write(version_dir.join(format!("{id}.json")), body.to_string()).unwrap();
        }
        let config = petalfall_core::PetalfallConfig {
            game_directory: Some(dir.join(".minecraft")),
            ..petalfall_core::PetalfallConfig::default()
        };
        Facade::new(Petalfall::open(config, dir.to_path_buf(), dir.join("config.json")).unwrap())
    }

    /// 实例自己正被占着（安装、补全、改名、删除）时先报 instance_busy，不先去读它的版本 JSON：安装途中 JSON
    /// 正被替换、一时读不出来时，启动该说「正在安装」，而不是一个读文件的错误。没人占着时读不出来照实报错，
    /// 占用槽与实例占用一并放开。
    #[tokio::test]
    async fn a_busy_instance_is_reported_before_its_chain_is_read() {
        let dir = tempfile::tempdir().unwrap();
        // 版本 JSON 的位置被一个目录占着：读它必出 IO 错误，而不是「不存在」。
        std::fs::create_dir_all(
            dir.path()
                .join(".minecraft")
                .join("versions")
                .join("装到 一半")
                .join("装到 一半.json"),
        )
        .unwrap();
        let facade = facade_with(dir.path(), &[("生存", None)]);
        let petalfall = facade.snapshot().await;
        let running = RunningGame::default();
        let locks = InstanceLocks::default();

        let installing = locks
            .acquire("装到 一半", InstanceActivity::Installing)
            .unwrap();
        let err = reserve_launch(&running, &locks, &petalfall, "装到 一半")
            .await
            .err()
            .unwrap();
        assert_eq!(err.code, crate::commands::error::code::INSTANCE_BUSY);
        assert_eq!(
            err.detail.unwrap(),
            json!({ "id": "装到 一半", "activity": "installing" })
        );
        drop(installing);

        let err = reserve_launch(&running, &locks, &petalfall, "装到 一半")
            .await
            .err()
            .unwrap();
        assert_eq!(err.code, crate::commands::error::code::IO, "{err:?}");
        assert_eq!(locks.activity("装到 一半"), None);
        assert!(reserve_launch(&running, &locks, &petalfall, "生存")
            .await
            .is_ok());
    }

    #[test]
    fn service_down_failure_carries_account_status_and_causes() {
        let mut params = BTreeMap::new();
        params.insert("account".to_owned(), json!("PetalPlayer"));
        params.insert("status".to_owned(), json!(503));
        let failure = LaunchFailure {
            code: FailureCode::AccountServiceDown,
            message: "刷新 PetalPlayer 的登录失败：登录服务暂时不可用（刷新令牌：HTTP 503）".into(),
            params,
            source: Some(petalfall_core::CoreError::Auth(
                petalfall_core::AuthError::ServiceUnavailable {
                    step: "刷新令牌",
                    status: 503,
                },
            )),
        };
        let err = launch_error(LaunchFailed::Failure(Box::new(failure)));
        assert_eq!(err.code, "account_service_down");
        assert_eq!(
            err.detail,
            Some(json!({
                "account": "PetalPlayer",
                "status": 503,
                "causes": ["登录服务暂时不可用（刷新令牌：HTTP 503）"]
            }))
        );
    }

    #[test]
    fn launched_payload_says_whether_the_run_is_offline() {
        assert_eq!(
            serde_json::to_value(LaunchedDto {
                pid: Some(4242),
                offline: true,
            })
            .unwrap(),
            json!({ "pid": 4242, "offline": true })
        );
        assert_eq!(
            serde_json::to_value(LaunchedDto {
                pid: None,
                offline: false,
            })
            .unwrap(),
            json!({ "pid": null, "offline": false })
        );
    }

    #[test]
    fn quick_play_arg_parses_both_kinds_and_rejects_anything_else() {
        let world: QuickPlayArg = serde_json::from_value(
            json!({ "kind": "singleplayer", "world_dir_name": "New World" }),
        )
        .unwrap();
        assert_eq!(
            QuickPlay::from(world),
            QuickPlay::Singleplayer {
                world_dir_name: "New World".into()
            }
        );
        let server: QuickPlayArg = serde_json::from_value(
            json!({ "kind": "multiplayer", "address": "mc.example.com:25570" }),
        )
        .unwrap();
        assert_eq!(
            QuickPlay::from(server),
            QuickPlay::Multiplayer {
                address: "mc.example.com:25570".into()
            }
        );
        // 前端普通启动传 null。
        assert_eq!(
            serde_json::from_value::<Option<QuickPlayArg>>(Value::Null).unwrap(),
            None
        );

        for bad in [
            json!({ "kind": "realms", "realm_id": "1" }),
            json!({ "kind": "Singleplayer", "world_dir_name": "w" }),
            json!({ "world_dir_name": "w" }),
            json!({ "kind": "singleplayer" }),
            json!({ "kind": "multiplayer", "address": "a", "port": 25565 }),
            json!({ "kind": "singleplayer", "worldDirName": "w" }),
        ] {
            assert!(
                serde_json::from_value::<QuickPlayArg>(bad.clone()).is_err(),
                "{bad} 不该被接受"
            );
        }
    }

    #[tokio::test]
    async fn launch_reserves_the_slot_and_the_instance_or_neither() {
        let dir = tempfile::tempdir().unwrap();
        let facade = facade_with(dir.path(), &[("生存", None), ("创造", None)]);
        let petalfall = facade.snapshot().await;
        let running = RunningGame::default();
        let locks = InstanceLocks::default();

        // 实例正在安装：报 instance_busy，占用槽的预留随之放开，别的实例照常能启动。
        let installing = locks.acquire("生存", InstanceActivity::Installing).unwrap();
        let err = reserve_launch(&running, &locks, &petalfall, "生存")
            .await
            .err()
            .unwrap();
        assert_eq!(err.code, crate::commands::error::code::INSTANCE_BUSY);
        assert_eq!(err.detail.unwrap()["activity"], json!("installing"));
        drop(installing);

        let (reservation, instance) = reserve_launch(&running, &locks, &petalfall, "生存")
            .await
            .unwrap();
        assert_eq!(locks.activity("生存"), Some(InstanceActivity::Launching));
        // 加载中：另一个实例拿不到占用槽，也不会被占住实例。
        let err = reserve_launch(&running, &locks, &petalfall, "创造")
            .await
            .err()
            .unwrap();
        assert_eq!(err.code, BUSY);
        assert_eq!(locks.activity("创造"), None);

        instance.set_activity(InstanceActivity::Running);
        assert_eq!(locks.activity("生存"), Some(InstanceActivity::Running));
        drop(reservation);
        drop(instance);
        assert_eq!(locks.activity("生存"), None);
        assert!(reserve_launch(&running, &locks, &petalfall, "创造")
            .await
            .is_ok());
    }

    /// 加载器实例从启动到游戏退出都占着它继承的原版：补全、删除、改名原版都以 instance_busy 拒绝，
    /// detail 指出是哪个实例在用它。基底被占着做这几件事时，启动反过来被拒，占用槽一并放开。
    #[tokio::test]
    async fn a_running_loader_instance_holds_its_base_until_the_game_exits() {
        use crate::commands::instances::{
            delete_instance_with, rename_instance_with, repair_instance_with,
        };
        let dir = tempfile::tempdir().unwrap();
        let facade = facade_with(
            dir.path(),
            &[("1.20.1", None), ("Fabric 生存", Some("1.20.1"))],
        );
        let petalfall = facade.snapshot().await;
        let running = RunningGame::default();
        let locks = InstanceLocks::default();
        let tasks = TaskRegistry::default();
        let (sink, _rx) = mpsc::unbounded_channel::<petalfall_core::CoreEvent>();

        let (reservation, instance) = reserve_launch(&running, &locks, &petalfall, "Fabric 生存")
            .await
            .unwrap();
        instance.set_activity(InstanceActivity::Running);
        assert_eq!(locks.activity("1.20.1"), Some(InstanceActivity::Inherited));
        let in_use = json!({ "id": "1.20.1", "activity": "inherited", "used_by": "Fabric 生存" });
        let err = repair_instance_with(&facade, &tasks, &locks, "r", "1.20.1", &sink)
            .await
            .unwrap_err();
        assert_eq!(err.code, crate::commands::error::code::INSTANCE_BUSY);
        assert_eq!(err.detail.unwrap(), in_use);
        assert!(!tasks.is_running("r"), "被拒的补全不占任务 id");
        let err = rename_instance_with(&facade, &locks, "1.20.1", "原版")
            .await
            .unwrap_err();
        assert_eq!(err.detail.unwrap(), in_use);
        let err = delete_instance_with(&facade, &locks, "1.20.1", NeverDispose)
            .await
            .unwrap_err();
        assert_eq!(err.detail.unwrap(), in_use);

        // 游戏退出：实例与基底一起放开，补全原版照常进行。
        drop(reservation);
        drop(instance);
        assert_eq!(locks.activity("1.20.1"), None);
        assert_eq!(locks.activity("Fabric 生存"), None);
        let repaired = repair_instance_with(&facade, &tasks, &locks, "r", "1.20.1", &sink)
            .await
            .unwrap();
        assert!(!repaired.reinstalled);

        // 原版正在补全：启动以它为基底的实例被拒，detail 说的是原版在做什么，占用槽没被留下。
        let repairing = locks
            .acquire("1.20.1", InstanceActivity::Repairing)
            .unwrap();
        let err = reserve_launch(&running, &locks, &petalfall, "Fabric 生存")
            .await
            .err()
            .unwrap();
        assert_eq!(
            err.detail.unwrap(),
            json!({ "id": "1.20.1", "activity": "repairing" })
        );
        assert_eq!(
            locks.activity("Fabric 生存"),
            None,
            "实例自己的占用随之放开"
        );
        drop(repairing);
        assert!(reserve_launch(&running, &locks, &petalfall, "Fabric 生存")
            .await
            .is_ok());
    }

    /// 基底自己开着游戏时，补全以它为基底的实例在动文件之前报 instance_busy，detail 说的是基底在做什么；反过来
    /// 基底的启动在实例补全期间被拒，detail 指出是谁在用它，占用槽没被留下。互斥之前要等写到 natives 才报 IO 错误。
    #[tokio::test]
    async fn a_base_with_its_own_game_and_an_instance_on_top_of_it_exclude_each_other() {
        use crate::commands::instances::repair_instance_with;
        let dir = tempfile::tempdir().unwrap();
        let facade = facade_with(
            dir.path(),
            &[("1.20.1", None), ("Fabric 生存", Some("1.20.1"))],
        );
        let petalfall = facade.snapshot().await;
        let running = RunningGame::default();
        let locks = InstanceLocks::default();
        let tasks = TaskRegistry::default();
        let (sink, _rx) = mpsc::unbounded_channel::<petalfall_core::CoreEvent>();

        let (reservation, game) = reserve_launch(&running, &locks, &petalfall, "1.20.1")
            .await
            .unwrap();
        let err = repair_instance_with(&facade, &tasks, &locks, "r", "Fabric 生存", &sink)
            .await
            .unwrap_err();
        assert_eq!(err.code, crate::commands::error::code::INSTANCE_BUSY);
        assert_eq!(
            err.detail.unwrap(),
            json!({ "id": "1.20.1", "activity": "launching" })
        );
        assert!(!tasks.is_running("r"), "被拒的补全不占任务 id");
        assert_eq!(
            locks.activity("Fabric 生存"),
            None,
            "实例自己的占用随之放开"
        );
        game.set_activity(InstanceActivity::Running);
        let err = repair_instance_with(&facade, &tasks, &locks, "r", "Fabric 生存", &sink)
            .await
            .unwrap_err();
        assert_eq!(
            err.detail.unwrap(),
            json!({ "id": "1.20.1", "activity": "running" })
        );
        drop(reservation);
        drop(game);

        let repairing = locks
            .acquire_with_bases(
                "Fabric 生存",
                InstanceActivity::Repairing,
                &["1.20.1".to_owned()],
            )
            .unwrap();
        let err = reserve_launch(&running, &locks, &petalfall, "1.20.1")
            .await
            .err()
            .unwrap();
        assert_eq!(
            err.detail.unwrap(),
            json!({ "id": "1.20.1", "activity": "inherited", "used_by": "Fabric 生存" })
        );
        drop(repairing);
        assert!(
            reserve_launch(&running, &locks, &petalfall, "1.20.1")
                .await
                .is_ok(),
            "占用槽没被留下"
        );
    }

    /// 同一个原版上的两个加载器实例各自占着它，互不冲突；两边都结束后原版才放开。前端与占用槽保证
    /// 同一时间只跑一个游戏，这里各用一个占用槽，单看实例互斥这一层。
    #[tokio::test]
    async fn loader_instances_sharing_a_base_do_not_conflict() {
        use crate::commands::instances::delete_instance_with;
        let dir = tempfile::tempdir().unwrap();
        let facade = facade_with(
            dir.path(),
            &[
                ("1.20.1", None),
                ("fabric-loader-0.15.0-1.20.1", Some("1.20.1")),
                ("Fabric", Some("1.20.1")),
                // 叠在加载器版本上的传统布局：链上两层都占。
                ("OptiFabric", Some("fabric-loader-0.15.0-1.20.1")),
            ],
        );
        let petalfall = facade.snapshot().await;
        let locks = InstanceLocks::default();
        let (first_slot, second_slot) = (RunningGame::default(), RunningGame::default());

        let first = reserve_launch(&first_slot, &locks, &petalfall, "Fabric")
            .await
            .unwrap();
        let second = reserve_launch(&second_slot, &locks, &petalfall, "OptiFabric")
            .await
            .unwrap();
        assert_eq!(locks.activity("1.20.1"), Some(InstanceActivity::Inherited));
        assert_eq!(
            locks.activity("fabric-loader-0.15.0-1.20.1"),
            Some(InstanceActivity::Inherited)
        );
        let err = delete_instance_with(&facade, &locks, "1.20.1", NeverDispose)
            .await
            .unwrap_err();
        assert_eq!(
            err.detail.unwrap(),
            json!({ "id": "1.20.1", "activity": "inherited", "used_by": "Fabric" }),
            "先占到的那个实例被报出来"
        );
        let err =
            delete_instance_with(&facade, &locks, "fabric-loader-0.15.0-1.20.1", NeverDispose)
                .await
                .unwrap_err();
        assert_eq!(err.detail.unwrap()["used_by"], json!("OptiFabric"));

        drop(first);
        assert_eq!(
            locks.activity("1.20.1"),
            Some(InstanceActivity::Inherited),
            "另一个实例还在用"
        );
        drop(second);
        assert_eq!(locks.activity("1.20.1"), None);
        assert_eq!(locks.activity("fabric-loader-0.15.0-1.20.1"), None);
    }

    /// 自然加载器版本不进实例列表，占用照算：链上的实例启动时它被占住，查得到是谁在用，删除照样被挡；
    /// 列表里的原版基底照常带着 used_by。
    #[tokio::test]
    async fn loader_version_left_out_of_the_list_is_still_occupied_by_its_dependents() {
        use crate::commands::instances::{delete_instance_with, list_instances_with};
        const NATURAL: &str = "fabric-loader-0.15.0-1.20.1";
        let dir = tempfile::tempdir().unwrap();
        let facade = facade_with(
            dir.path(),
            &[("1.20.1", None), ("OptiFabric", Some(NATURAL))],
        );
        let natural_dir = dir.path().join(".minecraft").join("versions").join(NATURAL);
        std::fs::create_dir_all(&natural_dir).unwrap();
        std::fs::write(
            natural_dir.join(format!("{NATURAL}.json")),
            json!({
                "id": NATURAL, "inheritsFrom": "1.20.1", "type": "release",
                "mainClass": "net.fabricmc.loader.impl.launch.knot.KnotClient",
                "libraries": [{ "name": "net.fabricmc:fabric-loader:0.15.0" }]
            })
            .to_string(),
        )
        .unwrap();
        let petalfall = facade.snapshot().await;
        let locks = InstanceLocks::default();
        let slot = RunningGame::default();

        let launching = reserve_launch(&slot, &locks, &petalfall, "OptiFabric")
            .await
            .unwrap();

        let list = list_instances_with(&facade, &locks).await.unwrap();
        let ids: Vec<&str> = list.iter().map(|i| i.id.as_str()).collect();
        assert_eq!(ids, ["1.20.1", "OptiFabric"]);
        assert_eq!(list[0].used_by.as_deref(), Some("OptiFabric"));
        assert_eq!(
            locks.occupancy(NATURAL),
            (
                Some(InstanceActivity::Inherited),
                Some("OptiFabric".to_owned())
            )
        );
        let err = delete_instance_with(&facade, &locks, NATURAL, NeverDispose)
            .await
            .unwrap_err();
        assert_eq!(err.detail.unwrap()["used_by"], json!("OptiFabric"));

        drop(launching);
        assert_eq!(locks.occupancy(NATURAL), (None, None));
    }

    /// 测试里走不到真正的删除：基底被占着时删除命令必须在动目录之前就拒绝。
    struct NeverDispose;

    impl petalfall_core::Disposer for NeverDispose {
        fn dispose(&self, dir: &std::path::Path) -> Result<(), petalfall_core::InstanceError> {
            panic!("被占着的基底不该被删除：{}", dir.display());
        }
    }

    #[test]
    fn busy_names_the_occupant_and_its_phase() {
        let slot = GameSlot::default();
        let _loading = slot.reserve("1.20.1-fabric").unwrap();
        let err = busy(slot.reserve("1.21").err().unwrap());
        assert_eq!(err.code, BUSY);
        assert_eq!(
            err.detail,
            Some(json!({ "version_id": "1.20.1-fabric", "phase": "loading" }))
        );
    }

    #[tokio::test]
    async fn crash_and_kill_exits_map_to_the_event_payload() {
        let crashed = settle(async {
            Finished {
                exit: exit("1.21", Some(3), true, false),
                problems: Vec::new(),
            }
        })
        .await;
        assert_eq!(
            serde_json::to_value(&crashed).unwrap(),
            json!({ "version_id": "1.21", "exit_code": 3, "crashed": true, "killed": false, "duration_ms": 61_000 })
        );
        // 收尾出了问题（例如等待进程失败）也照门面给的结局推出去，玩家点过结束的仍是 killed。
        let killed = settle(async {
            Finished {
                exit: exit("1.21", None, false, true),
                problems: vec![petalfall_core::CoreError::PlatformUnsupported],
            }
        })
        .await;
        assert_eq!(
            serde_json::to_value(&killed).unwrap(),
            json!({ "version_id": "1.21", "exit_code": null, "crashed": false, "killed": true, "duration_ms": 61_000 })
        );
    }

    /// 游戏目录在临时目录下的门面，自动备份按 `auto` 开关。
    fn facade_in(dir: &std::path::Path, auto: bool) -> Facade {
        let config = petalfall_core::PetalfallConfig {
            game_directory: Some(dir.join(".minecraft")),
            world_backup: petalfall_core::WorldBackupSettings {
                auto,
                ..petalfall_core::WorldBackupSettings::default()
            },
            ..petalfall_core::PetalfallConfig::default()
        };
        Facade::new(
            petalfall_core::Petalfall::open(config, dir.to_path_buf(), dir.join("config.json"))
                .unwrap(),
        )
    }

    fn finished(version_id: &str) -> Finished {
        Finished {
            exit: exit(version_id, Some(0), false, false),
            problems: Vec::new(),
        }
    }

    /// 隔离实例 `id`（实例目录下已有 saves），里面放一个存档，level.dat 的修改时刻为 `modified`。
    fn world(dir: &std::path::Path, id: &str, world: &str, modified: SystemTime) {
        let version = dir.join(".minecraft").join("versions").join(id);
        std::fs::create_dir_all(&version).unwrap();
        std::fs::write(
            version.join(format!("{id}.json")),
            format!(r#"{{"id":"{id}","type":"release","mainClass":"M"}}"#),
        )
        .unwrap();
        let world = version.join("saves").join(world);
        std::fs::create_dir_all(world.join("region")).unwrap();
        std::fs::write(world.join("region").join("r.0.0.mca"), b"region").unwrap();
        let level = std::fs::File::create(world.join("level.dat")).unwrap();
        level.set_modified(modified).unwrap();
    }

    /// 关着自动备份：实例与占用槽在退出事件之前一起放开，不转成「备份」，也不推备份事件。前端收到退出事件
    /// 就可能立即启动下一个实例，放开必须先于推送。
    #[tokio::test]
    async fn without_auto_backup_everything_is_released_before_the_exit_event() {
        let dir = tempfile::tempdir().unwrap();
        let facade = facade_in(dir.path(), false);
        let started = SystemTime::now();
        world(
            dir.path(),
            "1.21",
            "新的世界",
            started + std::time::Duration::from_secs(60),
        );
        let locks = InstanceLocks::default();
        let guard = locks
            .acquire_with_bases("1.21", InstanceActivity::Running, &["原版".to_owned()])
            .unwrap();
        // 这一局的接回记录：收尾做完、放开占用槽之前就该删掉，下次打开落樱不再去认一个已经退出的进程。
        let record = dir.path().join(petalfall_core::reattach::RUNNING_GAME_FILE);
        std::fs::write(&record, b"{}").unwrap();
        let order = std::cell::RefCell::new(Vec::new());
        watch(
            &facade,
            Watched {
                version_id: "1.21".into(),
                session_started: started,
                instance: guard,
            },
            async { finished("1.21") },
            || {
                assert!(!record.exists(), "放开占用槽之前接回记录已删");
                order.borrow_mut().push("release".to_owned())
            },
            |exit| {
                assert_eq!(locks.activity("1.21"), None, "退出事件之前实例已放开");
                assert_eq!(locks.activity("原版"), None, "退出事件之前基底已放开");
                order
                    .borrow_mut()
                    .push(format!("exit {:?}", exit.exit_code))
            },
            |backup| order.borrow_mut().push(format!("backup {backup:?}")),
        )
        .await;
        assert_eq!(order.into_inner(), vec!["release", "exit Some(0)"]);
        assert_eq!(locks.activity("1.21"), None);
        let backups = dir
            .path()
            .join(".minecraft")
            .join(concat!(".", petalfall_base::app_slug!()))
            .join("backups");
        assert!(!backups.exists(), "关着自动备份不碰盘");
    }

    /// 开着自动备份：占用槽放开、退出事件推出时实例正在「备份」，只备份这一局写过 level.dat 的存档，
    /// 备份事件在退出事件之后，推出时实例已放开。
    #[tokio::test]
    async fn auto_backup_runs_after_the_exit_event_and_releases_the_instance_last() {
        let dir = tempfile::tempdir().unwrap();
        let facade = facade_in(dir.path(), true);
        let started = SystemTime::now();
        let hour = std::time::Duration::from_secs(3600);
        world(dir.path(), "1.21", "这局玩的", started + hour);
        world(dir.path(), "1.21", "上周玩的", started - hour);
        let locks = InstanceLocks::default();
        let guard = locks
            .acquire_with_bases("1.21", InstanceActivity::Launching, &[])
            .unwrap();
        guard.set_activity(InstanceActivity::Running);
        let order = std::cell::RefCell::new(Vec::new());
        let delivered = std::cell::RefCell::new(None);
        watch(
            &facade,
            Watched {
                version_id: "1.21".into(),
                session_started: started,
                instance: guard,
            },
            async { finished("1.21") },
            || {
                assert_eq!(locks.activity("1.21"), Some(InstanceActivity::BackingUp));
                order.borrow_mut().push("release")
            },
            |_| {
                assert_eq!(locks.activity("1.21"), Some(InstanceActivity::BackingUp));
                // 备份期间实例不能再次启动，Mod 改动照常。
                let err = locks
                    .acquire("1.21", InstanceActivity::Launching)
                    .err()
                    .unwrap();
                assert_eq!(err.detail.unwrap()["activity"], "backing_up");
                drop(locks.acquire("1.21", InstanceActivity::Modifying).unwrap());
                order.borrow_mut().push("exit")
            },
            |backup| {
                assert_eq!(locks.activity("1.21"), None, "推备份事件时实例已放开");
                order.borrow_mut().push("backup");
                *delivered.borrow_mut() = Some(backup);
            },
        )
        .await;
        assert_eq!(order.into_inner(), vec!["release", "exit", "backup"]);
        assert_eq!(locks.activity("1.21"), None);
        let payload = delivered.into_inner().unwrap();
        assert_eq!(payload.instance_id, "1.21");
        assert_eq!(payload.backed_up, vec!["这局玩的".to_owned()]);
        assert!(payload.failed.is_empty(), "{:?}", payload.failed);
        let list = facade
            .snapshot()
            .await
            .list_world_backups("1.21", "这局玩的")
            .await
            .unwrap();
        assert_eq!(list.backups.len(), 1);
        assert_eq!(list.backups[0].kind, petalfall_core::BackupKind::Auto);
        let untouched = facade
            .snapshot()
            .await
            .list_world_backups("1.21", "上周玩的")
            .await
            .unwrap();
        assert!(untouched.backups.is_empty());
    }

    /// 这一局没进过任何存档：照样推一条两个列表都空的备份事件，推时实例已放开，前端靠它重读实例的活动。
    #[tokio::test]
    async fn auto_backup_with_nothing_played_still_reports_the_release() {
        let dir = tempfile::tempdir().unwrap();
        let facade = facade_in(dir.path(), true);
        let started = SystemTime::now();
        world(
            dir.path(),
            "1.21",
            "旧档",
            started - std::time::Duration::from_secs(60),
        );
        let locks = InstanceLocks::default();
        let guard = locks
            .acquire_with_bases("1.21", InstanceActivity::Running, &[])
            .unwrap();
        let order = std::cell::RefCell::new(Vec::new());
        let delivered = std::cell::RefCell::new(None);
        watch(
            &facade,
            Watched {
                version_id: "1.21".into(),
                session_started: started,
                instance: guard,
            },
            async { finished("1.21") },
            || {},
            |_| order.borrow_mut().push("exit"),
            |backup| {
                assert_eq!(locks.activity("1.21"), None, "推备份事件时实例已放开");
                order.borrow_mut().push("backup");
                *delivered.borrow_mut() = Some(backup);
            },
        )
        .await;
        assert_eq!(order.into_inner(), vec!["exit", "backup"]);
        let payload = delivered.into_inner().unwrap();
        assert_eq!(payload.instance_id, "1.21");
        assert!(payload.backed_up.is_empty());
        assert!(payload.failed.is_empty());
        let list = facade
            .snapshot()
            .await
            .list_world_backups("1.21", "旧档")
            .await
            .unwrap();
        assert!(list.backups.is_empty(), "会话前写过的存档不备份");
    }

    /// 加载器实例退出后转去自动备份：备份只读实例自己的版本 JSON、设置与存档，基底在占用槽放开之前就放开，基底
    /// 这时能启动；实例自己一直占到备份做完。
    #[tokio::test]
    async fn auto_backup_frees_the_base_before_the_slot_and_holds_only_the_instance() {
        let dir = tempfile::tempdir().unwrap();
        let facade = facade_in(dir.path(), true);
        let started = SystemTime::now();
        world(
            dir.path(),
            "Fabric 生存",
            "这局玩的",
            started + std::time::Duration::from_secs(3600),
        );
        let locks = InstanceLocks::default();
        let guard = locks
            .acquire_with_bases(
                "Fabric 生存",
                InstanceActivity::Running,
                &["1.20.1".to_owned()],
            )
            .unwrap();
        let backed_up = std::cell::RefCell::new(None);
        watch(
            &facade,
            Watched {
                version_id: "Fabric 生存".into(),
                session_started: started,
                instance: guard,
            },
            async { finished("Fabric 生存") },
            || assert_eq!(locks.activity("1.20.1"), None, "放开占用槽时基底已放开"),
            |_| {
                assert_eq!(
                    locks.activity("Fabric 生存"),
                    Some(InstanceActivity::BackingUp)
                );
                assert_eq!(locks.occupancy("1.20.1"), (None, None));
                // 前端收到退出事件就可能启动基底，这时实例还在备份。
                drop(
                    locks
                        .acquire("1.20.1", InstanceActivity::Launching)
                        .unwrap(),
                );
            },
            |backup| {
                assert_eq!(locks.activity("Fabric 生存"), None);
                *backed_up.borrow_mut() = Some(backup.backed_up);
            },
        )
        .await;
        assert_eq!(
            backed_up.into_inner(),
            Some(vec!["这局玩的".to_owned()]),
            "备份事件要推出来"
        );
    }

    /// 单个存档失败带着它的错误码进 failed；整场没能开始时 failed 只有一项，存档名为 `*`。
    #[test]
    fn auto_backup_failures_keep_their_codes() {
        let payload = world_backup_event(
            "生存",
            Ok(AutoBackupOutcome {
                backed_up: vec!["a".into()],
                failed: vec![(
                    "b".into(),
                    petalfall_core::CoreError::WorldNotFound {
                        version_id: "生存".into(),
                        world: "b".into(),
                    },
                )],
            }),
        );
        assert_eq!(payload.backed_up, vec!["a".to_owned()]);
        assert_eq!(payload.failed.len(), 1);
        assert_eq!(payload.failed[0].world, "b");
        assert_eq!(payload.failed[0].error.code, "world_not_found");
        let json = serde_json::to_value(&payload).unwrap();
        assert_eq!(json["failed"][0]["error"]["code"], "world_not_found");
        assert_eq!(json["instance_id"], "生存");

        let whole = world_backup_event(
            "生存",
            Err(petalfall_core::CoreError::VersionNotInstalled {
                id: "生存".into()
            }),
        );
        assert!(whole.backed_up.is_empty());
        assert_eq!(whole.failed.len(), 1);
        assert_eq!(whole.failed[0].world, "*");
        assert_eq!(whole.failed[0].error.code, "version_not_installed");
    }
}
