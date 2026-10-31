//! 游戏进程管理：spawn、stdout/stderr 捕获、日志落盘与批量转发、结束游戏、退出报告与崩溃判定。
//!
//! 用 `java.exe`（而非 `javaw.exe`，规避已知的输出重定向问题）启动，把 Java bin 目录塞进子进程 PATH
//! 头部（某些 natives 靠系统查找同目录 DLL）。两条输出流各由一个读取任务按字节逐行读出，汇入同一个
//! 无界通道；单个汇流任务负责三件事：写会话日志、留最近若干行供崩溃判定、按时间窗批量转发给上层。
//!
//! 读取任务绝不等待下游：管道一旦不被及时读空，JVM 的日志线程就会卡在写 stdout 上，游戏随之卡死。
//! 所以读取端只往无界通道里塞，慢的是写盘还是界面都只会让内存里多攒几行，不会反压到游戏。

use std::collections::VecDeque;
use std::path::Path;
use std::process::Stdio;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tokio::io::{AsyncBufReadExt, AsyncRead, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::{mpsc, oneshot};
use tokio::task::JoinHandle;

use crate::command::LaunchCommand;
use crate::error::{LaunchError, Result};
use crate::logfile::{LauncherLevel, LogSource, SessionClock, SessionLog};

/// 崩溃判定缓存的最近游戏输出行数。
pub const RECENT_LINE_CAPACITY: usize = 500;
/// 批量转发的时间窗：带 Mod 的游戏启动期每秒上千行，逐行推给界面就是一场事件风暴。
pub const LOG_BATCH_INTERVAL: Duration = Duration::from_millis(100);
/// 时间窗内攒满这么多行就提前发出，免得单批过大。
pub const LOG_BATCH_MAX_LINES: usize = 200;
/// 进程退出后等两条输出流读完的时限。游戏或 Mod 拉起的辅助进程会继承输出管道，它不退出管道就不
/// 关闭；一直等下去的话退出报告永远出不来，占用槽与实例锁也一直放不掉。正常退出时管道里剩下的
/// 只有缓冲中的最后几行，远用不了这么久。
pub const OUTPUT_DRAIN_DEADLINE: Duration = Duration::from_secs(2);

/// 日志来源流。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LogStream {
    Stdout,
    Stderr,
}

/// 一行游戏输出。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LogLine {
    /// 读到这一行时的 Unix 毫秒。
    pub at: u64,
    pub stream: LogStream,
    pub text: String,
}

/// 批量转发的接收端：每次收到按时间顺序的一批行。
pub type LogBatchSink = mpsc::UnboundedSender<Vec<LogLine>>;

/// 进程结束报告。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ExitReport {
    /// 退出码（被信号杀死等无码情形为 `None`）。
    pub code: Option<i32>,
    /// 是否正常退出（退出码 0）。
    pub success: bool,
    /// 退出时缓存的最近若干行游戏输出。
    pub recent_lines: Vec<String>,
    /// 是否由启动器主动结束（经 [`KillSwitch`] 发出过结束请求）。主动结束的退出一律不算崩溃。
    #[serde(default)]
    pub terminated_by_launcher: bool,
}

/// 会话结束的全部产物：退出报告，以及尚未关闭的会话日志（调用方还要追加收尾行再关闭）。
pub struct SessionEnd {
    pub report: ExitReport,
    pub log: Option<SessionLog>,
}

/// 结束请求：附一条回执，让请求方拿到结束动作的真实成败。
type KillRequest = oneshot::Sender<Result<()>>;

/// 结束游戏的句柄，可克隆、可跨任务持有。会话本体留在等待退出的那一方手里。
#[derive(Clone)]
pub struct KillSwitch(mpsc::UnboundedSender<KillRequest>);

impl KillSwitch {
    /// 请求结束进程并等结束动作执行完毕。返回 `false` 表示会话已经结束，没有可结束的进程。
    pub async fn kill(&self) -> Result<bool> {
        let (ack_tx, ack_rx) = oneshot::channel();
        if self.0.send(ack_tx).is_err() {
            return Ok(false);
        }
        match ack_rx.await {
            Ok(result) => result.map(|()| true),
            // 等待方在收到请求后、回执前收尾离开，说明进程已经自己退出了。
            Err(_) => Ok(false),
        }
    }
}

/// 一次已启动的游戏会话。
pub struct GameSession {
    child: Child,
    clock: SessionClock,
    readers: Vec<JoinHandle<()>>,
    pump: JoinHandle<PumpOutcome>,
    kill_tx: mpsc::UnboundedSender<KillRequest>,
    kill_rx: mpsc::UnboundedReceiver<KillRequest>,
}

impl GameSession {
    /// 进程 id（尚未退出时可取）。
    pub fn id(&self) -> Option<u32> {
        self.child.id()
    }

    /// 结束游戏的句柄。
    pub fn kill_switch(&self) -> KillSwitch {
        KillSwitch(self.kill_tx.clone())
    }

    /// 等待进程退出，期间随时响应 [`KillSwitch`] 的结束请求；回收读取与汇流任务，产出退出报告。
    pub async fn wait(mut self) -> Result<SessionEnd> {
        let mut terminated_by_launcher = false;
        let status = loop {
            tokio::select! {
                status = self.child.wait() => break status.map_err(LaunchError::Wait)?,
                Some(ack) = self.kill_rx.recv() => {
                    // 先置位再结束：即便结束动作本身失败，这次意图也已记录，退出不会被误判成崩溃。
                    terminated_by_launcher = true;
                    let result = kill_child(&mut self.child);
                    // 回执发不出去只说明请求方不等了，不改变已经执行的事实。
                    let _ = ack.send(result);
                }
            }
        };
        let drained = drain_readers(std::mem::take(&mut self.readers)).await?;
        let mut outcome = self.pump.await.map_err(LaunchError::Join)?;
        if !drained {
            let text = format!(
                "游戏已退出，但输出管道在 {} 秒内没有关闭（多半是游戏拉起的进程还开着它），之后的输出不再记录",
                OUTPUT_DRAIN_DEADLINE.as_secs()
            );
            tracing::warn!("{text}");
            if let Some(writer) = outcome.log.as_mut()
                && let Err(err) = writer
                    .write(
                        self.clock.now(),
                        LogSource::Launcher,
                        Some(LauncherLevel::Warn),
                        &text,
                    )
                    .await
            {
                tracing::warn!(error = %err, "会话日志写入失败，本次会话停止写日志");
                outcome.log = None;
            }
        }
        Ok(SessionEnd {
            report: ExitReport {
                code: status.code(),
                success: status.success(),
                recent_lines: outcome.recent.into_iter().collect(),
                terminated_by_launcher,
            },
            log: outcome.log,
        })
    }
}

/// 等读取任务读完各自的流，最多等 [`OUTPUT_DRAIN_DEADLINE`]；超时就结束它们。读取任务结束时放掉
/// 各自的发送端，汇流任务随之收尾。返回是否在时限内读完。
async fn drain_readers(mut readers: Vec<JoinHandle<()>>) -> Result<bool> {
    let finished = tokio::time::timeout(OUTPUT_DRAIN_DEADLINE, async {
        for reader in &mut readers {
            reader.await.map_err(LaunchError::Join)?;
        }
        Ok::<(), LaunchError>(())
    })
    .await;
    match finished {
        Ok(result) => result.map(|()| true),
        Err(_elapsed) => {
            for reader in &readers {
                reader.abort();
            }
            for reader in readers {
                match reader.await {
                    Ok(()) => {}
                    Err(err) if err.is_cancelled() => {}
                    Err(err) => return Err(LaunchError::Join(err)),
                }
            }
            Ok(false)
        }
    }
}

/// 发出结束信号。进程恰好已经自己退出时，系统会拒绝结束一个已退出的进程，这不是失败。
fn kill_child(child: &mut Child) -> Result<()> {
    match child.start_kill() {
        Ok(()) => Ok(()),
        Err(err) => match child.try_wait() {
            Ok(Some(_)) => Ok(()),
            _ => Err(LaunchError::Kill(err)),
        },
    }
}

/// 启动游戏进程。`log` 为本次会话日志（打不开时传 `None`，游戏照常启动），`forward` 接收批量转发的行。
pub fn spawn(
    command: &LaunchCommand,
    clock: SessionClock,
    log: Option<SessionLog>,
    forward: Option<LogBatchSink>,
) -> Result<GameSession> {
    let mut cmd = Command::new(&command.program);
    cmd.args(&command.args);
    cmd.current_dir(&command.working_dir);
    if let Some(bin_dir) = command.program.parent() {
        cmd.env("PATH", prepend_path(bin_dir));
    }
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped());
    // 不继承 stdin：游戏不读控制台输入，避免子进程挂在管道上。
    cmd.stdin(Stdio::null());
    configure_no_window(&mut cmd);

    let mut child = cmd.spawn().map_err(|source| LaunchError::Spawn {
        program: command.program.clone(),
        source,
    })?;

    let (line_tx, line_rx) = mpsc::unbounded_channel::<LogLine>();
    let mut readers = Vec::new();
    if let Some(stdout) = child.stdout.take() {
        readers.push(spawn_reader(
            stdout,
            LogStream::Stdout,
            clock,
            line_tx.clone(),
        ));
    }
    if let Some(stderr) = child.stderr.take() {
        readers.push(spawn_reader(stderr, LogStream::Stderr, clock, line_tx));
    }
    let pump = tokio::spawn(pump(line_rx, log, forward));
    let (kill_tx, kill_rx) = mpsc::unbounded_channel();

    Ok(GameSession {
        child,
        clock,
        readers,
        pump,
        kill_tx,
        kill_rx,
    })
}

/// 抑制子进程的控制台窗口：java.exe 是控制台程序，即便三条流都已重定向，Windows 仍会给它开一个
/// 黑框。输出本就走管道与会话日志，那个窗口不承载任何信息。
#[cfg(windows)]
fn configure_no_window(cmd: &mut Command) {
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    cmd.creation_flags(CREATE_NO_WINDOW);
}

#[cfg(not(windows))]
fn configure_no_window(_cmd: &mut Command) {}

/// 崩溃判定：启动器主动结束的一律不算；日志里有明确的崩溃标记算；否则看退出码，非 0 或拿不到退出码都算。
///
/// 主动结束先行短路：Windows 上强制结束留下非 0 退出码、Unix 上被信号结束则没有退出码，两种表现
/// 都会命中后面的规则，而玩家点「结束游戏」不该收到一次崩溃指认。
pub fn detect_crash(report: &ExitReport) -> bool {
    if report.terminated_by_launcher {
        return false;
    }
    if report
        .recent_lines
        .iter()
        .any(|line| crate::crash::has_crash_marker(line))
    {
        return true;
    }
    report.code != Some(0)
}

/// 逐行读一条输出流。按字节读、有损解码：JVM 的本地层（如致命错误头）按系统代码页输出，
/// 一个非 UTF-8 字节就会让按字符串读的读取端报错退出，从此没人读这条管道，游戏随之卡死。
fn spawn_reader<R>(
    reader: R,
    stream: LogStream,
    clock: SessionClock,
    tx: mpsc::UnboundedSender<LogLine>,
) -> JoinHandle<()>
where
    R: AsyncRead + Unpin + Send + 'static,
{
    tokio::spawn(async move {
        let mut reader = BufReader::new(reader);
        let mut buf = Vec::new();
        loop {
            buf.clear();
            match reader.read_until(b'\n', &mut buf).await {
                Ok(0) => break,
                Ok(_) => {
                    while matches!(buf.last(), Some(b'\n' | b'\r')) {
                        buf.pop();
                    }
                    let line = LogLine {
                        at: clock.now(),
                        stream,
                        text: String::from_utf8_lossy(&buf).into_owned(),
                    };
                    // 汇流任务只会在两个读取端都结束后才退出，这里发送失败说明它异常死掉了；
                    // 继续读空管道，至少别让游戏卡住。
                    if tx.send(line).is_err() {
                        tracing::warn!(?stream, "游戏输出汇流任务已退出，丢弃后续输出");
                    }
                }
                Err(err) => {
                    tracing::warn!(error = %err, ?stream, "读取游戏输出失败，停止读取这条流");
                    break;
                }
            }
        }
    })
}

struct PumpOutcome {
    recent: VecDeque<String>,
    log: Option<SessionLog>,
}

/// 汇流：写会话日志、留最近若干行、按时间窗批量转发。两条输出流都关闭（进程退出）后结束。
async fn pump(
    mut rx: mpsc::UnboundedReceiver<LogLine>,
    mut log: Option<SessionLog>,
    mut forward: Option<LogBatchSink>,
) -> PumpOutcome {
    let mut recent = VecDeque::with_capacity(RECENT_LINE_CAPACITY);
    let mut batch: Vec<LogLine> = Vec::new();
    let mut ticker = tokio::time::interval(LOG_BATCH_INTERVAL);
    ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    loop {
        tokio::select! {
            line = rx.recv() => {
                let Some(line) = line else { break };
                if let Some(writer) = log.as_mut()
                    && let Err(err) = writer.write(line.at, LogSource::Game, None, &line.text).await
                {
                    // 磁盘满之类的问题不该打断游戏；这份日志从此不完整，停写并留一条告警。
                    tracing::warn!(error = %err, "会话日志写入失败，本次会话停止写日志");
                    log = None;
                }
                if recent.len() == RECENT_LINE_CAPACITY {
                    recent.pop_front();
                }
                recent.push_back(line.text.clone());
                if forward.is_some() {
                    batch.push(line);
                    if batch.len() >= LOG_BATCH_MAX_LINES {
                        flush_batch(&mut forward, &mut batch);
                    }
                }
            }
            _ = ticker.tick() => flush_batch(&mut forward, &mut batch),
        }
    }
    flush_batch(&mut forward, &mut batch);
    PumpOutcome { recent, log }
}

fn flush_batch(forward: &mut Option<LogBatchSink>, batch: &mut Vec<LogLine>) {
    if batch.is_empty() {
        return;
    }
    let lines = std::mem::take(batch);
    if let Some(tx) = forward
        && tx.send(lines).is_err()
    {
        // 上层不再关心实时日志（窗口已关），之后只写日志文件。
        *forward = None;
    }
}

/// 把 `bin_dir` 拼到现有 PATH 头部。
fn prepend_path(bin_dir: &Path) -> std::ffi::OsString {
    let mut combined = bin_dir.as_os_str().to_owned();
    if let Some(existing) = std::env::var_os("PATH") {
        let sep = if cfg!(windows) { ";" } else { ":" };
        combined.push(sep);
        combined.push(existing);
    }
    combined
}

#[cfg(test)]
mod tests {
    use super::*;

    fn report(code: Option<i32>, lines: &[&str], terminated_by_launcher: bool) -> ExitReport {
        ExitReport {
            code,
            success: code == Some(0),
            recent_lines: lines.iter().map(|l| (*l).to_owned()).collect(),
            terminated_by_launcher,
        }
    }

    #[test]
    fn detect_crash_by_exit_code() {
        assert!(!detect_crash(&report(Some(0), &["Stopping!"], false)));
        assert!(detect_crash(&report(Some(1), &["some output"], false)));
        assert!(detect_crash(&report(Some(-1), &[], false)));
        assert!(detect_crash(&report(None, &[], false)));
    }

    #[test]
    fn detect_crash_by_marker_even_on_clean_exit() {
        assert!(detect_crash(&report(
            Some(0),
            &["---- Minecraft Crash Report ----"],
            false
        )));
    }

    #[test]
    fn launcher_termination_is_never_a_crash() {
        // Windows 上强制结束留下非 0 退出码，Unix 上被信号结束没有退出码。
        assert!(!detect_crash(&report(Some(1), &[], true)));
        assert!(!detect_crash(&report(None, &[], true)));
    }

    #[test]
    fn launcher_termination_outranks_crash_marker() {
        assert!(!detect_crash(&report(
            Some(1),
            &["---- Minecraft Crash Report ----"],
            true
        )));
    }

    #[test]
    fn exit_report_without_termination_field_deserializes_as_not_terminated() {
        let parsed: ExitReport =
            serde_json::from_str(r#"{"code":1,"success":false,"recent_lines":[]}"#).unwrap();
        assert!(!parsed.terminated_by_launcher);
    }

    #[test]
    fn prepend_path_puts_bin_first() {
        let combined = prepend_path(Path::new("C:/java/bin"));
        assert!(combined.to_string_lossy().starts_with("C:/java/bin"));
    }

    #[tokio::test]
    async fn pump_batches_lines_and_keeps_last_recent() {
        let (tx, rx) = mpsc::unbounded_channel();
        let (fwd_tx, mut fwd_rx) = mpsc::unbounded_channel();
        let total = RECENT_LINE_CAPACITY + LOG_BATCH_MAX_LINES + 7;
        for i in 0..total {
            tx.send(LogLine {
                at: i as u64,
                stream: LogStream::Stdout,
                text: format!("line {i}"),
            })
            .unwrap();
        }
        drop(tx);
        let outcome = pump(rx, None, Some(fwd_tx)).await;

        // 环形缓冲只留最后 500 行。
        assert_eq!(outcome.recent.len(), RECENT_LINE_CAPACITY);
        assert_eq!(
            outcome.recent.front().unwrap(),
            &format!("line {}", total - RECENT_LINE_CAPACITY)
        );
        assert_eq!(
            outcome.recent.back().unwrap(),
            &format!("line {}", total - 1)
        );

        // 转发按批到达、每批不超过上限、全部行按顺序一行不少。
        let mut batches = Vec::new();
        while let Ok(batch) = fwd_rx.try_recv() {
            batches.push(batch);
        }
        assert!(batches.len() >= 2, "应拆成多批：{}", batches.len());
        assert!(
            batches
                .iter()
                .all(|b| !b.is_empty() && b.len() <= LOG_BATCH_MAX_LINES)
        );
        let all: Vec<u64> = batches.iter().flatten().map(|l| l.at).collect();
        assert_eq!(all, (0..total as u64).collect::<Vec<_>>());
    }

    #[cfg(windows)]
    fn command(program: &str, args: &[&str]) -> LaunchCommand {
        LaunchCommand {
            program: std::path::PathBuf::from(program),
            args: args.iter().map(|a| (*a).to_owned()).collect(),
            working_dir: std::env::temp_dir(),
        }
    }

    #[cfg(windows)]
    fn cmd(script: &str) -> LaunchCommand {
        command("cmd", &["/C", script])
    }

    // 真实子进程：打印一行并以 3 退出，验证落盘、转发、退出码与崩溃判定。
    #[cfg(windows)]
    #[tokio::test]
    async fn spawn_captures_output_logs_it_and_reports_exit_code() {
        let tmp = tempfile::tempdir().unwrap();
        let clock = SessionClock::start().unwrap();
        let log = SessionLog::create(tmp.path(), "t", clock.started_at())
            .await
            .unwrap();
        let (fwd_tx, mut fwd_rx) = mpsc::unbounded_channel();
        let session = spawn(
            &cmd("echo PETAL_HELLO & exit 3"),
            clock,
            Some(log),
            Some(fwd_tx),
        )
        .unwrap();
        let end = session.wait().await.unwrap();

        assert_eq!(end.report.code, Some(3));
        assert!(!end.report.success);
        assert!(!end.report.terminated_by_launcher);
        assert!(detect_crash(&end.report));
        assert!(
            end.report
                .recent_lines
                .iter()
                .any(|l| l.contains("PETAL_HELLO"))
        );

        let mut streamed = Vec::new();
        while let Ok(batch) = fwd_rx.try_recv() {
            streamed.extend(batch.into_iter().map(|l| l.text));
        }
        assert!(streamed.iter().any(|l| l.contains("PETAL_HELLO")));

        let log = end.log.expect("日志应保持打开交还调用方");
        assert_eq!(log.lines(), 1);
        let path = log
            .finish(clock.now(), crate::logfile::SessionOutcome::Crashed)
            .await
            .unwrap();
        let content = std::fs::read_to_string(path).unwrap();
        assert!(content.contains("[game] PETAL_HELLO"), "{content}");
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn kill_switch_ends_process_and_marks_termination() {
        let clock = SessionClock::start().unwrap();
        // ping 自身 30 次约 30 秒，足够在它退出前发出结束请求。
        let session = spawn(
            &command("ping", &["-n", "30", "127.0.0.1"]),
            clock,
            None,
            None,
        )
        .unwrap();
        let switch = session.kill_switch();
        let waiter = tokio::spawn(session.wait());
        tokio::time::sleep(Duration::from_millis(200)).await;
        assert!(
            switch.kill().await.unwrap(),
            "进程仍在运行时结束请求应被执行"
        );
        let end = tokio::time::timeout(Duration::from_secs(10), waiter)
            .await
            .expect("结束后应很快退出")
            .unwrap()
            .unwrap();
        assert!(end.report.terminated_by_launcher);
        assert!(!detect_crash(&end.report));
        // 会话结束后句柄还能用，只是报告没有可结束的进程。
        assert!(!switch.kill().await.unwrap());
    }

    /// 游戏拉起的辅助进程继承了输出管道、比游戏活得久：游戏退出后最多等收尾时限就产出退出报告，
    /// 不等那个进程退出；之前读到的输出照常交回，会话日志里记下输出被截断。
    #[cfg(windows)]
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn exit_is_reported_even_when_a_child_keeps_the_pipes_open() {
        let tmp = tempfile::tempdir().unwrap();
        let clock = SessionClock::start().unwrap();
        let log = SessionLog::create(tmp.path(), "t", clock.started_at())
            .await
            .unwrap();
        // start /b 拉起的 ping 继承 cmd 的标准输出，约 9 秒后才退出；cmd 自己立刻以 0 退出。
        let session = spawn(
            &cmd("echo BEFORE_EXIT & start /b ping -n 10 127.0.0.1 & exit 0"),
            clock,
            Some(log),
            None,
        )
        .unwrap();
        let started = std::time::Instant::now();
        let end = tokio::time::timeout(Duration::from_secs(15), session.wait())
            .await
            .expect("游戏进程退出后应在收尾时限内产出报告")
            .unwrap();
        let waited = started.elapsed();

        assert!(
            waited < OUTPUT_DRAIN_DEADLINE + Duration::from_secs(4),
            "等了 {waited:?}"
        );
        assert_eq!(end.report.code, Some(0));
        assert!(
            end.report
                .recent_lines
                .iter()
                .any(|l| l.contains("BEFORE_EXIT"))
        );
        let log = end.log.expect("日志应保持打开交还调用方");
        let path = log
            .finish(clock.now(), crate::logfile::SessionOutcome::Exited)
            .await
            .unwrap();
        let content = std::fs::read_to_string(path).unwrap();
        assert!(content.contains("[game] BEFORE_EXIT"), "{content}");
        assert!(content.contains("[launcher/warn]"), "{content}");
        assert!(content.contains("输出管道"), "{content}");
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn invalid_utf8_output_does_not_stop_the_reader() {
        let tmp = tempfile::tempdir().unwrap();
        let script = tmp.path().join("bytes.bin");
        // 一行 GBK 编码的「中文」，后面跟一行 ASCII：第二行必须照样读到。
        std::fs::write(&script, b"\xd6\xd0\xce\xc4\r\nAFTER_BAD_BYTES\r\n").unwrap();
        let clock = SessionClock::start().unwrap();
        let path = script.display().to_string();
        let session = spawn(&command("cmd", &["/C", "type", &path]), clock, None, None).unwrap();
        let end = session.wait().await.unwrap();
        assert_eq!(end.report.recent_lines.len(), 2);
        assert!(end.report.recent_lines[0].contains('\u{FFFD}'));
        assert_eq!(end.report.recent_lines[1], "AFTER_BAD_BYTES");
    }
}
