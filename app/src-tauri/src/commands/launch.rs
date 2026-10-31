//! 启动与结束游戏、游戏退出监控、游玩统计。
//!
//! 同一时间只运行一个游戏，加载中也算占用：第二次 `launch_game` 返回 [`BUSY`]。前端会先按占用者所处
//! 阶段确认替换（加载中先取消、运行中先结束），这里是第二道防线。
//!
//! 启动的 `task_id` 只是取消句柄：加载阶段可经 `cancel_task` 取消，启动不进前端下载队列。阶段经
//! [`LAUNCH_PHASE_EVENT`] 推送，启动器日志与游戏输出一并经 [`GAME_LOG_EVENT`] 成批推送；进程起来后
//! 命令即返回，监控任务等它退出，收尾记账写完后先放开占用槽、再推 [`GAME_EXIT_EVENT`]——前端收到退出
//! 事件就可能立刻启动下一个实例。

use std::future::Future;
use std::time::Instant;

use aurora_core::{
    game_line_level, DownloadProgress, Finished, GameExit, GameRun, GameSlot, LaunchAccount,
    LaunchEvent, LaunchFailed, LaunchPhase, LaunchRequest, LaunchStage, LauncherLevel, LogLine,
    LogSource, PlayRange, PlayStats, SlotBusy, SlotTicket,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use tauri::{AppHandle, Manager, State};
use tokio::sync::mpsc;

use crate::commands::accounts::find_account;
use crate::commands::CommandError;
use crate::events::{self, GAME_LOG_EVENT};
use crate::facade::Facade;
use crate::tasks::TaskRegistry;

/// 启动阶段推进与阶段 3 的下载进度。
pub const LAUNCH_PHASE_EVENT: &str = "aurora://launch-phase";

/// 游戏进程退出（收尾记账已写完）。
pub const GAME_EXIT_EVENT: &str = "aurora://game-exit";

/// 已有游戏在加载或运行。
pub const BUSY: &str = "busy";

/// 运行中游戏的占用槽。与门面分列两个 managed state：会话生命周期独立于门面，启动后门面锁应立即可用。
#[derive(Default)]
pub struct RunningGame(GameSlot);

/// 启动成功：进程已经起来。
#[derive(Debug, Serialize)]
pub struct LaunchedDto {
    pub pid: Option<u32>,
}

/// 阶段 3 的下载进度。字段与 core-event 的下载进度一致。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct DownloadDto {
    pub total: u64,
    pub finished: u64,
    /// 实际传输字节（含重传，可能超过 `total_bytes`，画进度时要封顶）。
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

/// 监控一局游戏：收尾后先放开占用槽，再推退出事件。
async fn watch(
    version_id: String,
    finish: impl Future<Output = aurora_core::Result<Finished>>,
    release: impl FnOnce(),
    emit: impl FnOnce(GameExitDto),
) {
    let exit = settle(version_id, Instant::now(), finish).await;
    release();
    emit(exit);
}

fn spawn_watch(app: AppHandle, ticket: SlotTicket, run: GameRun) {
    let version_id = run.version_id().to_owned();
    tauri::async_runtime::spawn(async move {
        watch(
            version_id,
            run.finish(),
            || app.state::<RunningGame>().0.release(ticket),
            |exit| events::emit(&app, GAME_EXIT_EVENT, exit),
        )
        .await;
    });
}

/// 用哪个账户启动。
enum AccountArg {
    Stored(String),
    Offline(String),
}

/// 启动一个已安装版本。账户给 `account_uuid`（账户库里的账户）或 `offline_name`（临时离线账户）二者之一。
/// 内存、Java、JVM 参数与分辨率由后端按实例设置与全局设置解析。
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn launch_game(
    app: AppHandle,
    task_id: String,
    version_id: String,
    account_uuid: Option<String>,
    offline_name: Option<String>,
    facade: State<'_, Facade>,
    tasks: State<'_, TaskRegistry>,
    running: State<'_, RunningGame>,
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
    let reservation = running.0.reserve(&version_id).map_err(busy)?;
    let task = tasks.register(&task_id)?;
    let aurora = facade.snapshot().await.with_cancel(task.token().clone());

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

    let launched = task
        .run(async {
            let account = match account {
                AccountArg::Stored(uuid) => LaunchAccount::Stored(find_account(&aurora, &uuid)?),
                AccountArg::Offline(name) => LaunchAccount::Offline { name },
            };
            let request = LaunchRequest {
                version_id: version_id.clone(),
                account,
                launcher_version: app.package_info().version.to_string(),
                game_log: Some(log_tx),
            };
            aurora
                .launch(request, &events_tx)
                .await
                .map_err(launch_error)
        })
        .await;
    drop(events_tx);
    if let Err(err) = phases.await {
        tracing::error!(error = %err, "启动阶段转发任务异常结束");
    }
    let run = launched?;

    let pid = run.pid();
    let ticket = reservation.occupy(run.kill_switch());
    spawn_watch(app, ticket, run);
    Ok(LaunchedDto { pid })
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

/// 一段本地日期区间（两端都含）的游玩统计。
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

    #[tokio::test]
    async fn slot_is_released_before_the_exit_event_goes_out() {
        // 前端收到退出事件就可能立即启动下一个实例：放开占用槽必须先于推送。
        let order = std::cell::RefCell::new(Vec::new());
        watch(
            "1.21".into(),
            async {
                Ok(Finished {
                    exit: exit("1.21", Some(0), false, false),
                    problems: Vec::new(),
                })
            },
            || order.borrow_mut().push("release".to_owned()),
            |exit| {
                order
                    .borrow_mut()
                    .push(format!("emit {:?}", exit.exit_code))
            },
        )
        .await;
        assert_eq!(order.into_inner(), vec!["release", "emit Some(0)"]);
    }
}
