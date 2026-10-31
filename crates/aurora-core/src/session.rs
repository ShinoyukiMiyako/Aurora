//! 运行中的游戏：等它退出，收尾会话日志，判定崩溃并落盘诊断，记游玩时长；以及「同一时间只运行一个
//! 游戏」的占用槽 [`GameSlot`]。
//!
//! 收尾时的记账（游玩时长、崩溃报告）任何一项失败都不能吞掉「游戏已退出」这个事实：退出结果照常
//! 交出，记账失败作为 [`Finished::problems`] 一并交给上层如实上报。

use std::path::PathBuf;
use std::sync::{Mutex, MutexGuard};

use aurora_launch::logfile::SessionOutcome;
use aurora_launch::{
    GameSession, KillSwitch, LauncherLevel, LogSource, SessionClock, SessionLog, detect_crash,
};
use serde::{Deserialize, Serialize};

use crate::crashdiag::{CrashReport, read_tail_for_diagnosis, save_crash_report};
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

/// 收尾产物：退出结果，以及收尾记账中遇到的问题。
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

    /// 等游戏退出并收尾。只有等待进程本身失败才返回错误，此时退出码无从得知。
    pub async fn finish(self) -> Result<Finished> {
        let GameRun { info, session } = self;
        let end = session.wait().await?;
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
        let log_path = match end.log {
            Some(log) => match close_log(log, exited_at, &exit, outcome).await {
                Ok(path) => Some(path),
                Err(err) => {
                    problems.push(err);
                    None
                }
            },
            None => None,
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
            let mut crash = CrashReport::from_lines(&numbered);
            if let Err(err) = crash.join_suspects(&info.working_dir).await {
                problems.push(err);
            }
            crash.at = Some(exited_at);
            crash.exit_code = report.code;
            crash.session_started_at = log_path.as_ref().map(|_| info.clock.started_at());
            crash.java = Some(info.java.clone());
            crash.max_memory_mb = Some(info.max_memory_mb);
            crash.warnings = info.warnings.clone();
            if let Err(err) = save_crash_report(&info.version_dir, &crash).await {
                problems.push(err);
            }
        }

        Ok(Finished { exit, problems })
    }
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
        let session = aurora_launch::spawn(&command, clock, Some(log), None).unwrap();
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
        let finished = started.run.finish().await.unwrap();
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
        let finished = waiting.await.unwrap().unwrap();
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
        let finished = started.run.finish().await.unwrap();
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
        assert!(waiting.await.unwrap().unwrap().exit.killed);
        slot.release(ticket);
        assert!(slot.reserve("b").is_ok());
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
        let finished = started.run.finish().await.unwrap();
        assert_eq!(finished.exit.exit_code, Some(0));
        assert_eq!(finished.problems.len(), 1);
    }
}
