//! 启动与结束游戏、游戏退出监控、游玩统计。
//!
//! 同一时间只运行一个游戏，加载中也算占用：第二次 `launch_game` 返回 [`BUSY`]。前端会先按占用者所处
//! 阶段确认替换（加载中先取消、运行中先结束），这里是第二道防线。
//!
//! 启动的 `task_id` 只是取消句柄：加载阶段可经 `cancel_task` 取消，启动不进前端下载队列。阶段经
//! [`LAUNCH_PHASE_EVENT`] 推送，启动器日志与游戏输出一并经 [`GAME_LOG_EVENT`] 成批推送；进程起来后
//! 命令即返回，监控任务等它退出，收尾记账写完后先放开占用槽、再推 [`GAME_EXIT_EVENT`]——前端收到退出
//! 事件就可能立刻启动下一个实例。开着自动备份时，实例占用在退出事件之前转成「备份」，把这次玩过的存档各
//! 备份一份后才放开，结果经 [`WORLD_BACKUP_EVENT`] 推送。

use std::future::Future;
use std::time::{Instant, SystemTime};

use aurora_core::{
    game_line_level, AutoBackupOutcome, DownloadProgress, Finished, GameExit, GameRun, GameSlot,
    LaunchAccount, LaunchEvent, LaunchFailed, LaunchPhase, LaunchRequest, LaunchStage,
    LauncherLevel, LogLine, LogSource, PlayRange, PlayStats, QuickPlay, SlotBusy, SlotReservation,
    SlotTicket,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use tauri::{AppHandle, Manager, State};
use tokio::sync::mpsc;

use crate::commands::accounts::find_account;
use crate::commands::error::code::BUSY;
use crate::commands::instances::{
    ensure_shared_worlds_settled, InstanceActivity, InstanceGuard, InstanceLocks,
};
use crate::commands::CommandError;
use crate::events::{self, GAME_LOG_EVENT};
use crate::facade::Facade;
use crate::tasks::TaskRegistry;

/// 启动阶段推进与阶段 3 的下载进度。
pub const LAUNCH_PHASE_EVENT: &str = "aurora://launch-phase";

/// 游戏进程退出（收尾记账已写完）。
pub const GAME_EXIT_EVENT: &str = "aurora://game-exit";

/// 游戏退出后的自动备份做完了。开着自动备份时每局都推，这次没进过存档也推（两个列表都空）：实例在备份期间
/// 记着 backing_up，前端要靠这条事件知道它已放开、重读实例列表。
pub const WORLD_BACKUP_EVENT: &str = "aurora://world-backup";

/// 运行中游戏的占用槽。与门面分列两个 managed state：会话生命周期独立于门面，启动后门面锁应立即可用。
#[derive(Default)]
pub struct RunningGame(GameSlot);

impl RunningGame {
    /// 槽本身：存档备份要看此刻是哪个实例在跑游戏。
    pub(crate) fn slot(&self) -> &GameSlot {
        &self.0
    }
}

/// 启动成功：进程已经起来。
#[derive(Debug, Serialize)]
pub struct LaunchedDto {
    pub pid: Option<u32>,
    /// 这一局以离线方式进单人（未经账户验证）。
    pub offline: bool,
}

/// 阶段 3 的下载进度。字段与 core-event 的下载进度一致。
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
    outcome: aurora_core::Result<AutoBackupOutcome>,
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

/// 等游戏退出并译成退出事件。等待本身失败时退出码无从得知，按「拿不到退出码」报崩溃——前端总要有
/// 一个结局才能离开运行态。
async fn settle(
    version_id: String,
    since: Instant,
    finish: impl Future<Output = aurora_core::Result<Finished>>,
) -> GameExitDto {
    match finish.await {
        Ok(Finished { exit, problems }) => {
            for problem in &problems {
                tracing::error!(version = %exit.version_id, error = %problem, "游戏收尾记账失败");
            }
            exit.into()
        }
        Err(err) => {
            tracing::error!(version = %version_id, error = %err, "等待游戏进程退出失败");
            GameExitDto {
                version_id,
                exit_code: None,
                crashed: true,
                killed: false,
                duration_ms: u64::try_from(since.elapsed().as_millis())
                    .expect("毫秒数在 u64 范围内"),
            }
        }
    }
}

/// 被监控的一局游戏：哪个实例、会话从何时算起（自动备份只挑这之后写过 level.dat 的存档）、它的实例占用。
struct Watched {
    version_id: String,
    session_started: SystemTime,
    instance: InstanceGuard,
}

/// 监控一局游戏：收尾后先放开占用槽，再推退出事件。
///
/// 关着自动备份时实例占用与占用槽一起放开。开着时实例占用先原地转成「备份」再放开占用槽：中间不留空档，
/// 备份期间实例不会被改名、删除或再次启动；退出事件照常先推（前端据此离开运行态），备份做完才放开实例、
/// 推备份事件。
async fn watch(
    facade: &Facade,
    watched: Watched,
    finish: impl Future<Output = aurora_core::Result<Finished>>,
    release_slot: impl FnOnce(),
    emit_exit: impl FnOnce(GameExitDto),
    emit_backup: impl FnOnce(WorldBackupEventDto),
) {
    let Watched {
        version_id,
        session_started,
        instance,
    } = watched;
    let exit = settle(version_id.clone(), Instant::now(), finish).await;
    let auto = facade.read().await.config().world_backup.auto;
    if !auto {
        drop(instance);
        release_slot();
        emit_exit(exit);
        return;
    }
    instance.set_activity(InstanceActivity::BackingUp);
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

/// 实例占用随进程寿命：游戏退出、收尾记账（与开着时的自动备份）做完后放开，删除、改名、补全在这期间被拒绝。
fn spawn_watch(
    app: AppHandle,
    ticket: SlotTicket,
    instance: InstanceGuard,
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
            || app.state::<RunningGame>().0.release(ticket),
            |exit| events::emit(&app, GAME_EXIT_EVENT, exit),
            |backup| events::emit(&app, WORLD_BACKUP_EVENT, backup),
        )
        .await;
    });
}

/// 启动前的两道占用：全局只跑一个游戏（[`BUSY`]），目标实例此刻没有在安装、补全、改名或删除
/// （`instance_busy`）。第二道失败时第一道的预留随返回值一起丢弃，不会把占用槽留在加载中。
fn reserve_launch<'a>(
    running: &'a RunningGame,
    locks: &InstanceLocks,
    version_id: &str,
) -> Result<(SlotReservation<'a>, InstanceGuard), CommandError> {
    let reservation = running.0.reserve(version_id).map_err(busy)?;
    let instance = locks.acquire(version_id, InstanceActivity::Launching)?;
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
    // 实例占用从这里一直持有到游戏退出。
    let (reservation, instance) = reserve_launch(&running, &locks, &version_id)?;
    let aurora = facade.snapshot().await;
    // 共用存档的实例：先占住自己再查别人，查完之后再有别的实例想备份共用存档，会被占用槽那一侧的检查挡住。
    ensure_shared_worlds_settled(&aurora, &locks, &version_id).await?;
    let task = tasks.register(&task_id)?;
    let aurora = aurora.with_cancel(task.token().clone());

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
    let (log_tx, mut log_rx) = mpsc::unbounded_channel::<Vec<LogLine>>();
    let log_app = app.clone();
    let log_version = version_id.clone();
    tauri::async_runtime::spawn(async move {
        while let Some(batch) = log_rx.recv().await {
            events::emit(&log_app, GAME_LOG_EVENT, game_log(&log_version, batch));
        }
    });

    // 在拉起进程之前取：这之后被写过 level.dat 的存档，就是这一局进过的存档。
    let session_started = SystemTime::now();
    let launched = task
        .run(async {
            let account = match account {
                AccountArg::Stored(uuid) => {
                    LaunchAccount::Stored(Box::new(find_account(&aurora, &uuid).await?))
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
                aurora.launch_offline_fallback(request, &events_tx).await
            } else {
                aurora.launch(request, &events_tx).await
            };
            launched.map_err(launch_error)
        })
        .await;
    drop(events_tx);
    if let Err(err) = phases.await {
        tracing::error!(error = %err, "启动阶段转发任务异常结束");
    }
    let run = launched?;

    let launched = LaunchedDto {
        pid: run.pid(),
        offline: run.offline(),
    };
    let ticket = reservation.occupy(run.kill_switch());
    instance.set_activity(InstanceActivity::Running);
    spawn_watch(app, ticket, instance, run, session_started);
    Ok(launched)
}

/// 结束运行中的游戏，等结束动作执行完才返回；退出结果经 [`GAME_EXIT_EVENT`] 推送。没有运行中的游戏时
/// 为空操作（加载中的启动用 `cancel_task` 取消）。
#[tauri::command]
pub async fn stop_game(running: State<'_, RunningGame>) -> Result<(), CommandError> {
    let Some(kill) = running.0.kill_switch() else {
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
    let aurora = facade.snapshot().await;
    Ok(aurora.play_stats(parsed).await?)
}

#[cfg(test)]
mod tests {
    use super::*;
    use aurora_core::{FailureCode, LaunchFailure, LogStream};
    use std::collections::BTreeMap;

    fn progress(total: u64, finished: u64) -> DownloadProgress {
        DownloadProgress {
            total,
            finished,
            bytes: finished * 100,
            total_bytes: Some(total * 100),
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
            aurora_core::CoreError::VersionNotInstalled { id: "ghost".into() },
        ));
        assert_eq!(core.code, "version_not_installed");
        let cancelled = launch_error(LaunchFailed::Core(aurora_core::CoreError::Download(
            aurora_core::DownloadError::Cancelled,
        )));
        assert!(cancelled.is_cancelled());
    }

    #[test]
    fn service_down_failure_carries_account_status_and_causes() {
        let mut params = BTreeMap::new();
        params.insert("account".to_owned(), json!("PetalPlayer"));
        params.insert("status".to_owned(), json!(503));
        let failure = LaunchFailure {
            code: FailureCode::AccountServiceDown,
            message: "刷新 PetalPlayer 的登录失败：微软登录服务暂时不可用（刷新令牌：HTTP 503）"
                .into(),
            params,
            source: Some(aurora_core::CoreError::Auth(
                aurora_core::AuthError::ServiceUnavailable {
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
                "causes": ["微软登录服务暂时不可用（刷新令牌：HTTP 503）"]
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

    #[test]
    fn launch_reserves_the_slot_and_the_instance_or_neither() {
        let running = RunningGame::default();
        let locks = InstanceLocks::default();

        // 实例正在安装：报 instance_busy，占用槽的预留随之放开，别的实例照常能启动。
        let installing = locks.acquire("生存", InstanceActivity::Installing).unwrap();
        let err = reserve_launch(&running, &locks, "生存").err().unwrap();
        assert_eq!(err.code, crate::commands::error::code::INSTANCE_BUSY);
        assert_eq!(err.detail.unwrap()["activity"], json!("installing"));
        drop(installing);

        let (reservation, instance) = reserve_launch(&running, &locks, "生存").unwrap();
        assert_eq!(locks.activity("生存"), Some(InstanceActivity::Launching));
        // 加载中：另一个实例拿不到占用槽，也不会被占住实例。
        let err = reserve_launch(&running, &locks, "创造").err().unwrap();
        assert_eq!(err.code, BUSY);
        assert_eq!(locks.activity("创造"), None);

        instance.set_activity(InstanceActivity::Running);
        assert_eq!(locks.activity("生存"), Some(InstanceActivity::Running));
        drop(reservation);
        drop(instance);
        assert_eq!(locks.activity("生存"), None);
        assert!(reserve_launch(&running, &locks, "创造").is_ok());
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
        let crashed = settle("1.21".into(), Instant::now(), async {
            Ok(Finished {
                exit: exit("1.21", Some(3), true, false),
                problems: Vec::new(),
            })
        })
        .await;
        assert_eq!(
            serde_json::to_value(&crashed).unwrap(),
            json!({ "version_id": "1.21", "exit_code": 3, "crashed": true, "killed": false, "duration_ms": 61_000 })
        );
        let killed = settle("1.21".into(), Instant::now(), async {
            Ok(Finished {
                exit: exit("1.21", Some(1), false, true),
                problems: vec![aurora_core::CoreError::PlatformUnsupported],
            })
        })
        .await;
        assert!(killed.killed && !killed.crashed);
    }

    #[tokio::test]
    async fn failed_wait_still_ends_the_session_as_a_crash() {
        let since = Instant::now() - std::time::Duration::from_millis(1_500);
        let exit = settle("1.21".into(), since, async {
            Err(aurora_core::CoreError::PlatformUnsupported)
        })
        .await;
        assert_eq!(exit.version_id, "1.21");
        assert_eq!(exit.exit_code, None);
        assert!(exit.crashed);
        assert!(!exit.killed);
        assert!(exit.duration_ms >= 1_500);
    }

    /// 游戏目录在临时目录下的门面，自动备份按 `auto` 开关。
    fn facade_in(dir: &std::path::Path, auto: bool) -> Facade {
        let config = aurora_core::AuroraConfig {
            game_directory: Some(dir.join(".minecraft")),
            world_backup: aurora_core::WorldBackupSettings {
                auto,
                ..aurora_core::WorldBackupSettings::default()
            },
            ..aurora_core::AuroraConfig::default()
        };
        Facade::new(
            aurora_core::Aurora::open(config, dir.to_path_buf(), dir.join("config.json")).unwrap(),
        )
    }

    fn finished(version_id: &str) -> aurora_core::Result<Finished> {
        Ok(Finished {
            exit: exit(version_id, Some(0), false, false),
            problems: Vec::new(),
        })
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
        let guard = locks.acquire("1.21", InstanceActivity::Running).unwrap();
        let order = std::cell::RefCell::new(Vec::new());
        watch(
            &facade,
            Watched {
                version_id: "1.21".into(),
                session_started: started,
                instance: guard,
            },
            async { finished("1.21") },
            || order.borrow_mut().push("release".to_owned()),
            |exit| {
                assert_eq!(locks.activity("1.21"), None, "退出事件之前实例已放开");
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
            .join(concat!(".", aurora_base::app_slug!()))
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
        let guard = locks.acquire("1.21", InstanceActivity::Launching).unwrap();
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
        assert_eq!(list.backups[0].kind, aurora_core::BackupKind::Auto);
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
        let guard = locks.acquire("1.21", InstanceActivity::Running).unwrap();
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

    /// 单个存档失败带着它的错误码进 failed；整场没能开始时 failed 只有一项，存档名为 `*`。
    #[test]
    fn auto_backup_failures_keep_their_codes() {
        let payload = world_backup_event(
            "生存",
            Ok(AutoBackupOutcome {
                backed_up: vec!["a".into()],
                failed: vec![(
                    "b".into(),
                    aurora_core::CoreError::WorldNotFound {
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
            Err(aurora_core::CoreError::VersionNotInstalled {
                id: "生存".into()
            }),
        );
        assert!(whole.backed_up.is_empty());
        assert_eq!(whole.failed.len(), 1);
        assert_eq!(whole.failed[0].world, "*");
        assert_eq!(whole.failed[0].error.code, "version_not_installed");
    }
}
