//! 运行中的游戏：等它退出，收尾会话日志，判定崩溃并落盘诊断，记游玩时长；以及「同一时间只运行一个
//! 游戏」的占用槽 [`GameSlot`]。
//!
//! 收尾时的记账（游玩时长、崩溃报告）任何一项失败都不能吞掉「游戏已退出」这个事实：退出结果照常
//! 交出，记账失败作为 [`Finished::problems`] 一并交给上层如实上报。等待游戏进程本身失败也一样：这一局
//! 照样记时长、照崩溃判定存这一局的报告，否则界面拿去展示的是上一局的崩溃。

use std::path::PathBuf;
use std::sync::{Mutex, MutexGuard};

use aurora_launch::logfile::SessionOutcome;
use aurora_launch::{
    GameSession, KillSwitch, LauncherLevel, LogSource, SessionClock, SessionEnd, SessionLog,
    detect_crash,
};
use serde::{Deserialize, Serialize};

use crate::crashdiag::{
    CrashReport, CrashSource, ScanInput, find_crash_report, find_hs_err, read_head_for_diagnosis,
    read_tail_for_diagnosis, save_crash_report,
};
use crate::error::{CoreError, Result};
use crate::launch::LaunchWarning;

/// 这次启动实际用的 Java，崩溃诊断里「这次用的是 Java N」「32 位 Java」靠它。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct JavaUsed {
    pub major: u32,
    pub path: String,
    pub is_64bit: bool,
}

/// 启动编排交给运行中会话的上下文。
pub(crate) struct RunInfo {
    pub version_id: String,
    pub version_dir: PathBuf,
    pub working_dir: PathBuf,
    pub data_dir: PathBuf,
    /// 启动时的游戏目录：游玩记录按它分开记，游戏运行期间切换了游戏目录也记回启动时的那个。
    pub game_dir: PathBuf,
    pub clock: SessionClock,
    /// 进程起来的 Unix 毫秒，游玩时长从这里算起。
    pub running_since: u64,
    pub java: JavaUsed,
    pub max_memory_mb: u32,
    pub warnings: Vec<LaunchWarning>,
    pub pid: Option<u32>,
    /// 这一局以离线方式进单人，没有经过账户验证。
    pub offline: bool,
}

/// 一局运行中的游戏。
pub struct GameRun {
    info: RunInfo,
    session: GameSession,
}

/// 游戏退出的结果。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct GameExit {
    pub version_id: String,
    pub exit_code: Option<i32>,
    /// 退出码非 0、拿不到退出码或日志有崩溃标记，且不是玩家主动结束。
    pub crashed: bool,
    /// 玩家结束了游戏。
    pub killed: bool,
    /// 进程运行了多久。
    pub duration_ms: u64,
}

/// 收尾产物：退出结果，以及收尾中遇到的问题（等待进程或后台任务的失败排第一，其后是记账失败）。
pub struct Finished {
    pub exit: GameExit,
    pub problems: Vec<CoreError>,
}

impl GameRun {
    pub(crate) fn new(info: RunInfo, session: GameSession) -> Self {
        Self { info, session }
    }

    pub fn version_id(&self) -> &str {
        &self.info.version_id
    }

    pub fn pid(&self) -> Option<u32> {
        self.info.pid
    }

    /// 这一局是否以离线方式进单人（未经账户验证，只保证单人游戏）。
    pub fn offline(&self) -> bool {
        self.info.offline
    }

    pub fn running_since(&self) -> u64 {
        self.info.running_since
    }

    /// 结束游戏的句柄。
    pub fn kill_switch(&self) -> KillSwitch {
        self.session.kill_switch()
    }

    /// 等游戏退出并收尾。等待进程本身失败或后台任务异常结束时同样收尾：退出码无从得知时按拿不到
    /// 退出码判定崩溃，玩家点过结束的仍算结束，那次失败排在 [`Finished::problems`] 的第一项。
    pub async fn finish(self) -> Finished {
        let GameRun { info, session } = self;
        let end = session.wait().await;
        settle(info, end).await
    }
}

/// 按会话的结束产物收尾：写日志结局、记游玩时长、存崩溃报告。与真实子进程分开，等待失败的路径也能
/// 确定地测到。
async fn settle(info: RunInfo, end: SessionEnd) -> Finished {
    let exited_at = info.clock.now();
    let report = end.report;
    let killed = report.terminated_by_launcher;
    let crashed = detect_crash(&report);
    let outcome = if killed {
        SessionOutcome::Killed
    } else if crashed {
        SessionOutcome::Crashed
    } else {
        SessionOutcome::Exited
    };
    let exit = GameExit {
        version_id: info.version_id.clone(),
        exit_code: report.code,
        crashed,
        killed,
        duration_ms: exited_at.saturating_sub(info.running_since),
    };

    let mut problems = Vec::new();
    let log_path = match end.failure {
        // 收尾不正常时 aurora-launch 已在日志里写下原因与结局并关闭，这里只接着用它的路径。
        Some(failure) => {
            problems.push(CoreError::from(failure.error));
            failure.log_path
        }
        None => match end.log {
            Some(log) => match close_log(log, exited_at, &exit, outcome).await {
                Ok(path) => Some(path),
                Err(err) => {
                    problems.push(err);
                    None
                }
            },
            None => None,
        },
    };

    if let Err(err) = crate::playtime::record_play(
        &info.data_dir,
        &info.game_dir,
        &info.version_id,
        info.running_since,
        exited_at,
    )
    .await
    {
        problems.push(err);
    }

    if crashed {
        // 日志文件在就读文件尾部：崩溃报告本体常有几百行，退出时缓存的 500 行未必装得下。
        // 日志没能建立时退回到缓存的最近几行，那仍是这一局的现场。
        let tail = match &log_path {
            Some(path) => match read_tail_for_diagnosis(path).await {
                Ok(tail) => Some(tail),
                Err(err) => {
                    problems.push(err);
                    None
                }
            },
            None => None,
        };
        // 行号按整份日志计，日志页与诊断页对得上；没有日志文件时只能按缓存里的顺序编号。
        let numbered: Vec<(&str, u64)> = match &tail {
            Some(tail) => tail
                .entries
                .iter()
                .enumerate()
                .filter(|(_, e)| e.source == LogSource::Game)
                .map(|(index, e)| (e.text.as_str(), tail.first_line + index as u64))
                .collect(),
            None => report
                .recent_lines
                .iter()
                .enumerate()
                .map(|(index, line)| (line.as_str(), index as u64 + 1))
                .collect(),
        };
        // 游戏自己写下的崩溃报告与 JVM 错误日志：找不到是常态，找不了或读不了的只跳过那一份并如实上报。
        let started_at = info.clock.started_at();
        let found = [
            (
                CrashSource::CrashReport,
                find_crash_report(&info.working_dir, started_at).await,
            ),
            (
                CrashSource::HsErr,
                find_hs_err(&info.working_dir, info.pid, started_at).await,
            ),
        ];
        let mut extra: Vec<(CrashSource, String, String)> = Vec::new();
        for (source, path) in found {
            let path = match path {
                Ok(Some(path)) => path,
                Ok(None) => continue,
                Err(err) => {
                    problems.push(err);
                    continue;
                }
            };
            match read_head_for_diagnosis(&path).await {
                Ok(text) => extra.push((source, path.display().to_string(), text)),
                Err(err) => problems.push(err),
            }
        }
        let mut inputs = vec![ScanInput {
            source: CrashSource::SessionLog,
            path: log_path.as_ref().map(|path| path.display().to_string()),
            lines: numbered,
        }];
        inputs.extend(
            extra
                .iter()
                .map(|(source, path, text)| ScanInput::numbered(*source, Some(path.clone()), text)),
        );
        let mut crash = CrashReport::from_sources(&inputs, report.code);
        if let Err(err) = crash.join_suspects(&info.working_dir).await {
            problems.push(err);
        }
        crash.at = Some(exited_at);
        crash.session_started_at = log_path.as_ref().map(|_| info.clock.started_at());
        crash.java = Some(info.java.clone());
        crash.max_memory_mb = Some(info.max_memory_mb);
        crash.warnings = info.warnings.clone();
        if let Err(err) = save_crash_report(&info.version_dir, &crash).await {
            problems.push(err);
        }
    }

    Finished { exit, problems }
}

/// 同一时间只运行一个游戏的占用槽。从开始启动起就占着：两次启动同时走加载阶段，会争同一批文件下载、
/// 同一个实例目录。
#[derive(Default)]
pub struct GameSlot {
    state: Mutex<SlotState>,
}

#[derive(Default)]
struct SlotState {
    occupant: Option<Occupant>,
    next_id: u64,
}

struct Occupant {
    id: u64,
    version_id: String,
    /// 进程起来后才有；`None` 表示还在加载。
    kill: Option<KillSwitch>,
}

/// 槽已被占用。
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("{version_id} {}，同一时间只能运行一个游戏", if *.running { "正在运行" } else { "正在启动" })]
pub struct SlotBusy {
    pub version_id: String,
    /// 占用者已经跑起来（否则还在加载）。
    pub running: bool,
}

/// 加载阶段对槽的占用；丢弃即释放，启动失败、取消或 panic 都不会留下占用。
pub struct SlotReservation<'a> {
    slot: &'a GameSlot,
    id: u64,
    /// 转为运行中之后由凭据负责释放，丢弃时不再动槽。
    armed: bool,
}

/// 运行中占用的凭据，游戏退出后凭它释放。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SlotTicket(u64);

impl GameSlot {
    fn state(&self) -> MutexGuard<'_, SlotState> {
        // 临界区里只有字段赋值，不会 panic；真中毒说明程序已处于未知状态，直接崩。
        self.state.lock().expect("游戏占用槽的锁已中毒")
    }

    /// 为一次启动占住槽。
    pub fn reserve(&self, version_id: &str) -> std::result::Result<SlotReservation<'_>, SlotBusy> {
        let mut state = self.state();
        if let Some(occupant) = &state.occupant {
            return Err(SlotBusy {
                version_id: occupant.version_id.clone(),
                running: occupant.kill.is_some(),
            });
        }
        let id = state.next_id;
        state.next_id += 1;
        state.occupant = Some(Occupant {
            id,
            version_id: version_id.to_owned(),
            kill: None,
        });
        Ok(SlotReservation {
            slot: self,
            id,
            armed: true,
        })
    }

    /// 释放运行中的占用。凭据过期（槽已换了主人）时什么都不做。
    pub fn release(&self, ticket: SlotTicket) {
        let mut state = self.state();
        if state.occupant.as_ref().is_some_and(|o| o.id == ticket.0) {
            state.occupant = None;
        }
    }

    /// 当前占用者：`(版本 id, 是否已跑起来)`，加载中为 `false`；槽空着时为 `None`。
    ///
    /// 不隔离的实例共用同一份存档，备份或恢复共用存档前要知道是不是别的实例正开着游戏。
    pub fn occupant(&self) -> Option<(String, bool)> {
        self.state()
            .occupant
            .as_ref()
            .map(|o| (o.version_id.clone(), o.kill.is_some()))
    }

    /// 运行中游戏的结束句柄；没有游戏或还在加载时为 `None`。
    pub fn kill_switch(&self) -> Option<KillSwitch> {
        self.state().occupant.as_ref().and_then(|o| o.kill.clone())
    }
}

impl SlotReservation<'_> {
    /// 游戏进程已经起来：占用转为运行中，此后凭返回的凭据释放。
    pub fn occupy(mut self, kill: KillSwitch) -> SlotTicket {
        if let Some(occupant) = self.slot.state().occupant.as_mut()
            && occupant.id == self.id
        {
            occupant.kill = Some(kill);
        }
        self.armed = false;
        SlotTicket(self.id)
    }
}

impl Drop for SlotReservation<'_> {
    fn drop(&mut self) {
        if self.armed {
            self.slot.release(SlotTicket(self.id));
        }
    }
}

/// 追加退出行、写结局、关闭日志。
async fn close_log(
    mut log: SessionLog,
    exited_at: u64,
    exit: &GameExit,
    outcome: SessionOutcome,
) -> Result<PathBuf> {
    let code = exit
        .exit_code
        .map_or_else(|| "未知".to_owned(), |code| code.to_string());
    let (level, text) = match outcome {
        SessionOutcome::Killed => (LauncherLevel::Info, format!("游戏已结束（退出码 {code}）")),
        SessionOutcome::Crashed => (
            LauncherLevel::Error,
            format!("游戏异常退出（退出码 {code}）"),
        ),
        _ => (LauncherLevel::Info, format!("游戏已退出（退出码 {code}）")),
    };
    log.write(exited_at, LogSource::Launcher, Some(level), &text)
        .await?;
    Ok(log.finish(exited_at, outcome).await?)
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;
    use aurora_launch::logfile::{LATEST_LOG, logs_dir};
    use aurora_launch::{LaunchCommand, read_log_tail};
    use std::path::Path;

    struct Started {
        _tmp: tempfile::TempDir,
        root: PathBuf,
        version_dir: PathBuf,
        run: GameRun,
    }

    /// 绕开启动编排，直接把一条命令当作游戏跑起来。
    async fn start(program: &str, args: &[&str]) -> Started {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().to_path_buf();
        let version_dir = root.join("versions").join("1.21");
        let clock = SessionClock::start().unwrap();
        let log = SessionLog::create(&logs_dir(&version_dir), "1.21", clock.started_at())
            .await
            .unwrap();
        let command = LaunchCommand {
            program: PathBuf::from(program),
            args: args.iter().map(|a| (*a).to_owned()).collect(),
            working_dir: root.clone(),
        };
        let session = aurora_launch::spawn(&command, clock, &mut Some(log), None).unwrap();
        let info = RunInfo {
            version_id: "1.21".to_owned(),
            version_dir: version_dir.clone(),
            working_dir: root.clone(),
            data_dir: root.clone(),
            game_dir: root.clone(),
            clock,
            running_since: clock.now(),
            java: JavaUsed {
                major: 21,
                path: program.to_owned(),
                is_64bit: true,
            },
            max_memory_mb: 4096,
            warnings: Vec::new(),
            pid: session.id(),
            offline: false,
        };
        Started {
            _tmp: tmp,
            root,
            version_dir,
            run: GameRun::new(info, session),
        }
    }

    async fn outcome(version_dir: &Path) -> SessionOutcome {
        read_log_tail(&logs_dir(version_dir).join(LATEST_LOG), 1 << 20, 100)
            .await
            .unwrap()
            .ended
            .expect("收尾后应写下结局")
            .outcome
    }

    fn crash_saved(version_dir: &Path) -> bool {
        version_dir
            .join(aurora_instance::AURORA_META_DIR)
            .join(crate::crashdiag::CRASH_REPORT_FILE)
            .exists()
    }

    async fn played_ms(root: &Path) -> Option<u64> {
        let aurora = crate::facade::Aurora::for_test(
            crate::config::AuroraConfig::default(),
            root.to_path_buf(),
            root.to_path_buf(),
        );
        aurora
            .play_summaries()
            .await
            .unwrap()
            .get("1.21")
            .map(|s| s.last_played_at)
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn nonzero_exit_is_a_crash_with_its_code() {
        let started = start("cmd", &["/C", "exit 3"]).await;
        let finished = started.run.finish().await;
        assert!(finished.problems.is_empty(), "{:?}", finished.problems);
        assert_eq!(finished.exit.exit_code, Some(3));
        assert!(finished.exit.crashed);
        assert!(!finished.exit.killed);
        assert_eq!(outcome(&started.version_dir).await, SessionOutcome::Crashed);
        assert!(crash_saved(&started.version_dir));
        assert!(played_ms(&started.root).await.is_some());
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn player_kill_is_not_a_crash_but_still_counts_as_played() {
        let started = start("ping", &["-n", "30", "127.0.0.1"]).await;
        let kill = started.run.kill_switch();
        let waiting = tokio::spawn(started.run.finish());
        assert!(kill.kill().await.unwrap(), "进程还在跑，应结束成功");
        let finished = waiting.await.unwrap();
        assert!(finished.problems.is_empty(), "{:?}", finished.problems);
        assert!(finished.exit.killed);
        assert!(!finished.exit.crashed);
        assert_eq!(outcome(&started.version_dir).await, SessionOutcome::Killed);
        assert!(!crash_saved(&started.version_dir));
        assert!(played_ms(&started.root).await.is_some());
        // 进程已经退出后再结束：没有可结束的进程。
        assert!(!kill.kill().await.unwrap());
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn clean_exit_is_neither_crash_nor_kill() {
        let started = start("cmd", &["/C", "exit 0"]).await;
        let finished = started.run.finish().await;
        assert_eq!(finished.exit.exit_code, Some(0));
        assert!(!finished.exit.crashed);
        assert!(!finished.exit.killed);
        assert_eq!(outcome(&started.version_dir).await, SessionOutcome::Exited);
        assert!(!crash_saved(&started.version_dir));
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn slot_refuses_a_second_game_while_loading_and_while_running() {
        let slot = GameSlot::default();
        let loading = slot.reserve("a").unwrap();
        assert_eq!(
            slot.reserve("b").err(),
            Some(SlotBusy {
                version_id: "a".into(),
                running: false,
            })
        );
        assert!(slot.kill_switch().is_none(), "加载中没有可结束的进程");

        let started = start("ping", &["-n", "30", "127.0.0.1"]).await;
        let ticket = loading.occupy(started.run.kill_switch());
        assert_eq!(
            slot.reserve("b").err(),
            Some(SlotBusy {
                version_id: "a".into(),
                running: true,
            })
        );

        let waiting = tokio::spawn(started.run.finish());
        assert!(slot.kill_switch().unwrap().kill().await.unwrap());
        assert!(waiting.await.unwrap().exit.killed);
        slot.release(ticket);
        assert!(slot.reserve("b").is_ok());
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn occupant_reports_who_holds_the_slot_and_whether_it_runs() {
        let slot = GameSlot::default();
        assert_eq!(slot.occupant(), None);
        let loading = slot.reserve("共用存档").unwrap();
        assert_eq!(slot.occupant(), Some(("共用存档".to_owned(), false)));

        let started = start("ping", &["-n", "30", "127.0.0.1"]).await;
        let ticket = loading.occupy(started.run.kill_switch());
        assert_eq!(slot.occupant(), Some(("共用存档".to_owned(), true)));

        let waiting = tokio::spawn(started.run.finish());
        assert!(slot.kill_switch().unwrap().kill().await.unwrap());
        assert!(waiting.await.unwrap().exit.killed);
        slot.release(ticket);
        assert_eq!(slot.occupant(), None);

        // 加载阶段的占用被丢弃（启动失败、取消）后同样空出来。
        drop(slot.reserve("b").unwrap());
        assert_eq!(slot.occupant(), None);
    }

    #[test]
    fn dropped_reservation_frees_the_slot_and_stale_tickets_do_not() {
        let slot = GameSlot::default();
        drop(slot.reserve("a").unwrap());
        let current = slot.reserve("b").unwrap();
        // 上一位（id 0）的凭据不能释放现在的占用者。
        slot.release(SlotTicket(0));
        assert_eq!(
            slot.reserve("c").err().map(|busy| busy.version_id),
            Some("b".into())
        );
        drop(current);
        assert!(slot.reserve("c").is_ok());
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn bookkeeping_failure_is_reported_without_hiding_the_exit() {
        let started = start("cmd", &["/C", "exit 0"]).await;
        // 游玩记录损坏：退出结果照常交出，记账失败作为问题一并交出。
        std::fs::write(
            started.root.join(crate::playtime::PLAYTIME_FILE),
            "{ broken",
        )
        .unwrap();
        let finished = started.run.finish().await;
        assert_eq!(finished.exit.exit_code, Some(0));
        assert_eq!(finished.problems.len(), 1);
    }

    /// 等待失败后的现场：aurora-launch 已把读到的游戏输出与原因、结局写进会话日志并关闭。
    struct WaitFailed {
        _tmp: tempfile::TempDir,
        root: PathBuf,
        version_dir: PathBuf,
        info: RunInfo,
        end: SessionEnd,
    }

    async fn wait_failed(terminated_by_launcher: bool) -> WaitFailed {
        use aurora_launch::{ExitReport, LaunchError, SessionFailure};

        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().to_path_buf();
        let version_dir = root.join("versions").join("1.21");
        let clock = SessionClock::start().unwrap();
        let running_since = clock.now();
        let mut log = SessionLog::create(&logs_dir(&version_dir), "1.21", clock.started_at())
            .await
            .unwrap();
        let oom = "java.lang.OutOfMemoryError: Java heap space";
        log.write(clock.now(), LogSource::Game, None, oom)
            .await
            .unwrap();
        log.write(
            clock.now(),
            LogSource::Launcher,
            Some(LauncherLevel::Error),
            "等待游戏进程结束失败：句柄已失效（退出码 未知）",
        )
        .await
        .unwrap();
        let outcome = if terminated_by_launcher {
            SessionOutcome::Killed
        } else {
            SessionOutcome::Crashed
        };
        let log_path = log.finish(clock.now(), outcome).await.unwrap();
        let info = RunInfo {
            version_id: "1.21".to_owned(),
            version_dir: version_dir.clone(),
            working_dir: root.clone(),
            data_dir: root.clone(),
            game_dir: root.clone(),
            clock,
            running_since,
            java: JavaUsed {
                major: 21,
                path: "java".to_owned(),
                is_64bit: true,
            },
            max_memory_mb: 4096,
            warnings: Vec::new(),
            pid: None,
            offline: false,
        };
        let end = SessionEnd {
            report: ExitReport {
                code: None,
                success: false,
                recent_lines: vec![oom.to_owned()],
                terminated_by_launcher,
            },
            log: None,
            failure: Some(SessionFailure {
                error: LaunchError::Wait(std::io::Error::other("句柄已失效")),
                log_path: Some(log_path),
            }),
        };
        WaitFailed {
            _tmp: tmp,
            root,
            version_dir,
            info,
            end,
        }
    }

    async fn last_crash_of(root: &Path) -> Option<CrashReport> {
        crate::facade::Aurora::for_test(
            crate::config::AuroraConfig::default(),
            root.to_path_buf(),
            root.to_path_buf(),
        )
        .last_crash("1.21")
        .await
        .unwrap()
    }

    /// 等待进程本身失败：这一局照样记游玩时长、存下这一局的崩溃报告（从已落盘的会话日志诊断），
    /// 那次失败作为问题交出。否则界面按崩溃去读的是上一局的报告。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn wait_failure_still_records_play_and_saves_this_crash() {
        let failed = wait_failed(false).await;
        let finished = settle(failed.info, failed.end).await;

        assert_eq!(finished.exit.exit_code, None);
        assert!(finished.exit.crashed);
        assert!(!finished.exit.killed);
        assert_eq!(finished.problems.len(), 1, "{:?}", finished.problems);
        assert!(
            matches!(
                &finished.problems[0],
                CoreError::Launch(aurora_launch::LaunchError::Wait(_))
            ),
            "{:?}",
            finished.problems[0]
        );
        let crash = last_crash_of(&failed.root)
            .await
            .expect("应存下这一局的崩溃");
        assert_eq!(crash.exit_code, None);
        assert_eq!(
            crash
                .diagnoses
                .iter()
                .map(|clue| clue.category)
                .collect::<Vec<_>>(),
            [aurora_launch::CrashCategory::OutOfMemory]
        );
        assert!(crash.log_path.is_some(), "应能找回这一局的会话日志");
        assert!(played_ms(&failed.root).await.is_some());
        // 结局由 aurora-launch 写过一次，这里不再追加。
        assert_eq!(outcome(&failed.version_dir).await, SessionOutcome::Crashed);
    }

    /// 玩家点过结束之后等待失败：算玩家结束，不是崩溃，不存崩溃报告，时长照记。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn wait_failure_after_a_kill_is_a_kill_not_a_crash() {
        let failed = wait_failed(true).await;
        let finished = settle(failed.info, failed.end).await;

        assert!(finished.exit.killed);
        assert!(!finished.exit.crashed);
        assert_eq!(finished.problems.len(), 1, "{:?}", finished.problems);
        assert!(!crash_saved(&failed.version_dir));
        assert!(played_ms(&failed.root).await.is_some());
    }

    /// 落盘的崩溃报告本体（JSON）。
    fn saved_crash(version_dir: &Path) -> serde_json::Value {
        let bytes = std::fs::read(
            version_dir
                .join(aurora_instance::AURORA_META_DIR)
                .join(crate::crashdiag::CRASH_REPORT_FILE),
        )
        .unwrap();
        serde_json::from_slice::<serde_json::Value>(&bytes).unwrap()["report"].clone()
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn access_violation_without_log_clues_falls_back_to_a_native_crash() {
        let started = start("cmd", &["/C", "exit -1073741819"]).await;
        let finished = started.run.finish().await;
        assert!(finished.problems.is_empty(), "{:?}", finished.problems);
        assert_eq!(finished.exit.exit_code, Some(-1_073_741_819));
        let report = saved_crash(&started.version_dir);
        let clues = report["diagnoses"].as_array().unwrap();
        assert_eq!(clues.len(), 1, "{clues:?}");
        assert_eq!(clues[0]["category"], "native_crash");
        assert_eq!(clues[0]["source"], "exit_code");
        assert_eq!(clues[0]["detail"], "0xC0000005");
        assert_eq!(clues[0]["line"], 0);
        assert_eq!(clues[0]["matched"], "");
        // 说明按退出码现算，不存；会话日志一项读报告时现找，也不存。
        assert_eq!(report["exit_code_note"], serde_json::Value::Null);
        assert_eq!(report["scanned_files"], serde_json::json!([]));
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn crash_report_written_during_the_session_is_scanned() {
        let started = start("cmd", &["/C", "exit 1"]).await;
        let reports = started.root.join("crash-reports");
        std::fs::create_dir_all(&reports).unwrap();
        let path = reports.join("crash-2026-10-31_12.00.00-client.txt");
        std::fs::write(
            &path,
            "---- Minecraft Crash Report ----\nDescription: Unexpected error\n\njava.lang.OutOfMemoryError: Java heap space\n",
        )
        .unwrap();
        let finished = started.run.finish().await;
        assert!(finished.problems.is_empty(), "{:?}", finished.problems);
        let report = saved_crash(&started.version_dir);
        let clues = report["diagnoses"].as_array().unwrap();
        assert_eq!(clues.len(), 1, "{clues:?}");
        assert_eq!(clues[0]["category"], "out_of_memory");
        assert_eq!(clues[0]["source"], "crash_report");
        assert_eq!(clues[0]["line"], 4);
        assert_eq!(
            report["scanned_files"],
            serde_json::json!([{ "kind": "crash_report", "path": path.display().to_string() }])
        );
        assert_eq!(report["exit_code"], 1);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn unreadable_crash_files_become_problems_and_the_report_is_still_saved() {
        use std::os::windows::fs::OpenOptionsExt;

        // crash-reports 是个文件而不是目录：列目录失败。
        let started = start("cmd", &["/C", "exit 3"]).await;
        std::fs::write(started.root.join("crash-reports"), b"not a dir").unwrap();
        let finished = started.run.finish().await;
        assert_eq!(finished.problems.len(), 1, "{:?}", finished.problems);
        assert!(crash_saved(&started.version_dir));

        // hs_err 被别的进程独占打开：找得到、读不了，那一份跳过。
        let started = start("cmd", &["/C", "exit 3"]).await;
        let pid = started.run.pid().expect("进程已经起来");
        let hs_err = started.root.join(format!("hs_err_pid{pid}.log"));
        std::fs::write(&hs_err, "# C  [ig9icd64.dll+0x57a41c]\n").unwrap();
        let _held = std::fs::OpenOptions::new()
            .read(true)
            .share_mode(0)
            .open(&hs_err)
            .unwrap();
        let finished = started.run.finish().await;
        assert_eq!(finished.problems.len(), 1, "{:?}", finished.problems);
        assert!(crash_saved(&started.version_dir));
        let report = saved_crash(&started.version_dir);
        assert_eq!(report["scanned_files"], serde_json::json!([]));
        assert!(
            report["diagnoses"]
                .as_array()
                .unwrap()
                .iter()
                .all(|clue| clue["category"] != "intel_graphics_driver")
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn unlistable_crash_reports_do_not_drop_the_hs_err() {
        // 两份文件各自独立：列不出 crash-reports 只跳过崩溃报告，已找到的 JVM 错误日志照样参与扫描。
        let started = start("cmd", &["/C", "exit -1073741819"]).await;
        let pid = started.run.pid().expect("进程已经起来");
        std::fs::write(started.root.join("crash-reports"), b"not a dir").unwrap();
        let hs_err = started.root.join(format!("hs_err_pid{pid}.log"));
        std::fs::write(
            &hs_err,
            "# A fatal error has been detected by the Java Runtime Environment:\n#\n# C  [ig9icd64.dll+0x57a41c]\n",
        )
        .unwrap();
        let finished = started.run.finish().await;
        assert_eq!(finished.problems.len(), 1, "{:?}", finished.problems);
        let report = saved_crash(&started.version_dir);
        // 工作目录在实例目录之外（共享游戏目录），存的是绝对路径。
        let scanned = report["scanned_files"].as_array().unwrap();
        assert_eq!(scanned.len(), 1, "{scanned:?}");
        assert_eq!(scanned[0]["kind"], "hs_err");
        assert_eq!(scanned[0]["path"], hs_err.display().to_string());
        let clues = report["diagnoses"].as_array().unwrap();
        assert_eq!(clues.len(), 1, "{clues:?}");
        assert_eq!(clues[0]["category"], "intel_graphics_driver");
        assert_eq!(clues[0]["source"], "hs_err");
        assert_eq!(clues[0]["line"], 3);
        assert_eq!(clues[0]["detail"], "ig9icd64.dll");
    }
}
