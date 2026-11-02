//! 游戏进程管理：spawn、stdout/stderr 捕获、日志落盘与批量转发、结束游戏、退出报告与崩溃判定。
//!
//! 用 `java.exe`（而非 `javaw.exe`，规避已知的输出重定向问题）启动，把 Java bin 目录塞进子进程 PATH
//! 头部（某些 natives 靠系统查找同目录 DLL）。两条输出流各由一个读取任务按字节逐行读出，汇入同一个
//! 无界通道；单个汇流任务负责三件事：写会话日志、留最近若干行供崩溃判定、按时间窗批量转发给上层。
//!
//! 读取任务绝不等待下游：管道一旦不被及时读空，JVM 的日志线程就会卡在写 stdout 上，游戏随之卡死。
//! 所以读取端只往无界通道里塞，慢的是写盘还是界面都只会让内存里多攒几行，不会反压到游戏。

use std::collections::VecDeque;
use std::path::{Path, PathBuf};
use std::process::{ExitStatus, Stdio};
use std::time::Duration;

use petalfall_base::error_with_causes;
use serde::{Deserialize, Serialize};
use tokio::io::{AsyncBufReadExt, AsyncRead, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::{mpsc, oneshot};
use tokio::task::JoinHandle;

use crate::command::LaunchCommand;
use crate::error::{LaunchError, Result};
use crate::log4j_xml::Log4jXmlDecoder;
use crate::logfile::{LauncherLevel, LogSource, SessionClock, SessionLog, SessionOutcome};
use crate::redact::redact_access_tokens;

/// 崩溃判定缓存的最近游戏输出行数。
pub const RECENT_LINE_CAPACITY: usize = 500;
/// 1.5.2 这一代的窗口关闭回调打这一行，然后 `System.exit(1)`：退出码 1 在这里是玩家关窗，不是出错。
const OLD_WINDOW_CLOSE_LINE: &str = "Someone is closing me!";
/// 批量转发的时间窗：带 Mod 的游戏启动期每秒上千行，逐行推给界面就是一场事件风暴。
pub const LOG_BATCH_INTERVAL: Duration = Duration::from_millis(100);
/// 时间窗内攒满这么多行就提前发出，免得单批过大。
pub const LOG_BATCH_MAX_LINES: usize = 200;
/// 进程退出后等两条输出流读完的时限。游戏或 Mod 拉起的辅助进程会继承输出管道，它不退出管道就不
/// 关闭；一直等下去的话退出报告永远出不来，占用槽与实例锁也一直放不掉。正常退出时管道里剩下的
/// 只有缓冲中的最后几行，远用不了这么久。
pub const OUTPUT_DRAIN_DEADLINE: Duration = Duration::from_secs(2);
/// 单行游戏输出最多保留的字节数，超出的部分丢弃、只记字节数。Mod 会打印几 MB 不带换行的转储，
/// 整段留着的话读取端、环形缓冲、会话日志与推给界面的批次都要背着它；正常的日志行远到不了这么长。
pub const MAX_LINE_BYTES: usize = 64 * 1024;

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
    /// 至多 [`MAX_LINE_BYTES`] 字节的原文；超出时末尾接上注明丢弃字节数的截断说明。
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

/// 会话结束的全部产物：退出报告，尚未关闭的会话日志（调用方还要追加收尾行再关闭），以及收尾不正常
/// 时的那次失败。
///
/// 收尾不正常也照样交出退出报告而不是只报错：游戏这一局确实结束了，上层还要据此记游玩时长、存
/// 这一局的崩溃报告、按玩家有没有点过结束给出结局，只拿到一个错误的话这些都无从做起。
pub struct SessionEnd {
    pub report: ExitReport,
    /// 收尾正常时保持打开交还调用方；收尾不正常时日志已在这里写完结局关闭，为 `None`。
    pub log: Option<SessionLog>,
    pub failure: Option<SessionFailure>,
}

/// 收尾不正常：等待游戏进程本身失败，或读取、汇流的后台任务异常结束。
#[derive(Debug)]
pub struct SessionFailure {
    /// 排在第一的那次失败；同时另有的失败只写进启动器日志。
    pub error: LaunchError,
    /// 已写下原因与结局并落盘的会话日志；没开日志、日志随汇流任务一起丢了、或收尾写入失败时为 `None`。
    pub log_path: Option<PathBuf>,
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
    /// 等待或后台任务失败时同样产出，失败放在 [`SessionEnd::failure`]。
    pub async fn wait(mut self) -> SessionEnd {
        let mut terminated_by_launcher = false;
        let status = loop {
            tokio::select! {
                status = self.child.wait() => break status,
                Some(ack) = self.kill_rx.recv() => {
                    // 先置位再结束：即便结束动作本身失败，这次意图也已记录，退出不会被误判成崩溃。
                    terminated_by_launcher = true;
                    let result = kill_child(&mut self.child);
                    // 回执发不出去只说明请求方不等了，不改变已经执行的事实。
                    let _ = ack.send(result);
                }
            }
        };
        let exited = Exited {
            status,
            terminated_by_launcher,
        };
        conclude(
            exited,
            self.clock,
            std::mem::take(&mut self.readers),
            self.pump,
            OUTPUT_DRAIN_DEADLINE,
        )
        .await
    }
}

/// 等进程退出的结果。等待本身可能失败，那时退出码无从得知。
struct Exited {
    status: std::io::Result<ExitStatus>,
    terminated_by_launcher: bool,
}

/// 进程等完之后收尾：读完（或限时结束）两条输出流、收回汇流任务、产出退出报告。等待的结果由调用方
/// 传入，与真实子进程无关，收尾的每条路径都能确定地测到。
///
/// 等待本身失败、或后台任务异常结束时同样走完收尾，会话日志写下原因与结局并落盘之后才交出失败：提前
/// 返回的话读取与汇流任务被扔在后台，日志缓冲里最后那几行与结局行都不会落盘。一切正常时日志保持打开
/// 交还调用方，由它追加退出行再关闭。
async fn conclude(
    exited: Exited,
    clock: SessionClock,
    readers: Vec<JoinHandle<()>>,
    pump: JoinHandle<PumpOutcome>,
    drain_deadline: Duration,
) -> SessionEnd {
    let drain = drain_readers(readers, drain_deadline).await;
    // 读取任务此时都已结束、发送端全部放掉，汇流任务一定会收尾。
    let (recent, mut log, pump_failure) = match pump.await {
        Ok(outcome) => (outcome.recent, outcome.log, None),
        // 会话日志在汇流任务手里，随它一起没了，无从收尾。
        Err(err) => (VecDeque::new(), None, Some(LaunchError::Join(err))),
    };
    if matches!(drain, Ok(false)) {
        // 等待失败时不知道游戏退没退，不说「已退出」。
        let lead = if exited.status.is_ok() {
            "游戏已退出，但"
        } else {
            ""
        };
        let text = format!(
            "{lead}输出管道在 {} 秒内没有关闭（多半是游戏拉起的进程还开着它），之后的输出不再记录",
            drain_deadline.as_secs()
        );
        tracing::warn!("{text}");
        if let Some(writer) = log.as_mut()
            && let Err(err) = writer
                .write(
                    clock.now(),
                    LogSource::Launcher,
                    Some(LauncherLevel::Warn),
                    &text,
                )
                .await
        {
            tracing::warn!(error = %err, "会话日志写入失败，本次会话停止写日志");
            log = None;
        }
    }
    let Exited {
        status,
        terminated_by_launcher,
    } = exited;
    let report = ExitReport {
        code: status.as_ref().ok().and_then(ExitStatus::code),
        success: status.as_ref().is_ok_and(ExitStatus::success),
        recent_lines: recent.into_iter().collect(),
        terminated_by_launcher,
    };
    // 等待本身的失败排第一：退出码因它而缺失，是这次收尾不正常的根由；后台任务的异常排在其后。
    let mut failures = status
        .err()
        .map(LaunchError::Wait)
        .into_iter()
        .chain(drain.err())
        .chain(pump_failure);
    let Some(failure) = failures.next() else {
        return SessionEnd {
            report,
            log,
            failure: None,
        };
    };
    for other in failures {
        tracing::error!(error = %error_with_causes(&other), "游戏会话收尾时另有失败");
    }
    let log_path = match log {
        Some(log) => settle_log_after_failure(log, clock.now(), &failure, &report).await,
        None => None,
    };
    SessionEnd {
        report,
        log: None,
        failure: Some(SessionFailure {
            error: failure,
            log_path,
        }),
    }
}

/// 收尾不正常时调用方拿不到会话日志，没人会再替它写结局：在这里写下原因与结局并落盘。结局与正常
/// 收尾时的判法一致：玩家结束的算结束，拿不到退出码按崩溃判定的规则算异常结束。返回落盘的路径，
/// 写不成时为 `None`。
async fn settle_log_after_failure(
    mut log: SessionLog,
    at: u64,
    failure: &LaunchError,
    report: &ExitReport,
) -> Option<PathBuf> {
    let code = report
        .code
        .map_or_else(|| "未知".to_owned(), |code| code.to_string());
    let text = format!("{}（退出码 {code}）", error_with_causes(failure));
    let outcome = if report.terminated_by_launcher {
        SessionOutcome::Killed
    } else if detect_crash(report) {
        SessionOutcome::Crashed
    } else {
        SessionOutcome::Exited
    };
    let settled = async move {
        log.write(at, LogSource::Launcher, Some(LauncherLevel::Error), &text)
            .await?;
        log.finish(at, outcome).await
    }
    .await;
    match settled {
        Ok(path) => Some(path),
        Err(err) => {
            tracing::warn!(error = %err, "会话日志收尾失败，这份日志缺少结局");
            None
        }
    }
}

/// 等读取任务读完各自的流，最多等 `deadline`；超时或有一个异常结束时，其余没读完的都结束掉，不留在
/// 后台占着管道。读取任务结束时放掉各自的发送端，汇流任务随之收尾。返回是否在时限内读完。
async fn drain_readers(readers: Vec<JoinHandle<()>>, deadline: Duration) -> Result<bool> {
    // 收回结果的读取任务立即移出：JoinHandle 交出结果之后再 await 会 panic。
    let mut pending = VecDeque::from(readers);
    let finished = tokio::time::timeout(deadline, async {
        while let Some(reader) = pending.front_mut() {
            let joined = reader.await;
            pending.pop_front();
            joined.map_err(LaunchError::Join)?;
        }
        Ok::<(), LaunchError>(())
    })
    .await;
    let mut result = match finished {
        Ok(Ok(())) => return Ok(true),
        Ok(Err(err)) => Err(err),
        Err(_elapsed) => Ok(false),
    };
    for reader in &pending {
        reader.abort();
    }
    for reader in pending {
        match reader.await {
            Ok(()) => {}
            Err(err) if err.is_cancelled() => {}
            Err(err) if result.is_ok() => result = Err(LaunchError::Join(err)),
            Err(err) => tracing::error!(error = %err, "游戏输出读取任务异常结束"),
        }
    }
    result
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

/// 启动游戏进程。`log` 为本次会话日志（打不开时为 `None`，游戏照常启动），进程起来后才取走：起不来时它还在
/// 调用方手里，由调用方写下失败与结局，写缓冲里这次启动的记录不会跟着丢。`forward` 接收批量转发的行。
pub fn spawn(
    command: &LaunchCommand,
    clock: SessionClock,
    log: &mut Option<SessionLog>,
    forward: Option<LogBatchSink>,
) -> Result<GameSession> {
    let mut cmd = Command::new(&command.program);
    cmd.args(&command.args);
    cmd.current_dir(&command.working_dir);
    // natives 目录进 PATH：LWJGL 2 用 String.getBytes() 把 OpenAL 的绝对路径交给 LoadLibraryA，
    // -Dfile.encoding=UTF-8 下路径含中文就对不上系统代码页，它最后才按裸文件名走系统搜索路径。
    // 这条路也没有的话，游戏不报错，直接进无声模式。
    let mut search_dirs: Vec<&Path> = command.program.parent().into_iter().collect();
    search_dirs.push(&command.natives_dir);
    cmd.env("PATH", prepend_path(&search_dirs));
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
    let pump = tokio::spawn(pump(line_rx, log.take(), forward));
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

/// 崩溃判定：启动器主动结束的一律不算；日志里有明确的崩溃标记算；旧版玩家关窗不算；否则看退出码，
/// 非 0 或拿不到退出码都算。
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
    let closed_by_player = report.code == Some(1)
        && report
            .recent_lines
            .iter()
            .any(|line| line.trim() == OLD_WINDOW_CLOSE_LINE);
    if closed_by_player {
        return false;
    }
    report.code != Some(0)
}

/// 逐行读一条输出流。按字节读、有损解码：JVM 的本地层（如致命错误头）按系统代码页输出，
/// 一个非 UTF-8 字节就会让按字符串读的读取端报错退出，从此没人读这条管道，游戏随之卡死。
/// 单行超过 [`MAX_LINE_BYTES`] 的部分边读边丢，读取照常往下走。stdout 上的 log4j XML 事件在这里还原成普通行，
/// 之后的会话日志、崩溃判定与界面拿到的都是还原后的文本。访问令牌也在这里遮掉（见 [`crate::redact`]）：
/// 这三处都从这一行往下拿，会话日志落在启动器自己的目录里，玩家会整份拿去发给别人。
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
        let mut lines = LineSplitter::new();
        let mut send = |mut text: String| {
            redact_access_tokens(&mut text);
            let line = LogLine {
                at: clock.now(),
                stream,
                text,
            };
            // 汇流任务只会在两个读取端都结束后才退出，这里发送失败说明它异常死掉了；
            // 继续读空管道，至少别让游戏卡住。
            if tx.send(line).is_err() {
                tracing::warn!(?stream, "游戏输出汇流任务已退出，丢弃后续输出");
            }
        };
        // 日志配置只把 XML 打到 stdout；stderr 上是 JVM 与未捕获异常的原文。
        let mut xml = (stream == LogStream::Stdout).then(Log4jXmlDecoder::new);
        let mut emit = |text: String| match xml.as_mut() {
            Some(decoder) => decoder.decode(text, &mut send),
            None => send(text),
        };
        loop {
            let chunk = match reader.fill_buf().await {
                Ok(chunk) => chunk,
                Err(err) => {
                    tracing::warn!(error = %err, ?stream, "读取游戏输出失败，停止读取这条流");
                    break;
                }
            };
            if chunk.is_empty() {
                break;
            }
            let consumed = chunk.len();
            lines.feed(chunk, &mut emit);
            reader.consume(consumed);
        }
        // 流尾没有换行的最后一段（以及读取出错前已经读到的半行）也是真实输出。
        if let Some(text) = lines.take_pending() {
            emit(text);
        }
    })
}

/// 把字节流切成行：去掉行尾的 `\r`，单行只留前 [`MAX_LINE_BYTES`] 字节，其余的只计数。
struct LineSplitter {
    /// 当前行已留下的字节。容量一次给足上限且从不越过，长行不会让它增长。
    kept: Vec<u8>,
    /// 当前行超出上限、没有留下的字节数。
    dropped: u64,
    /// 当前行末尾连续的 `\r` 个数（不论落在留下的还是丢掉的部分），行结束时它们不算正文。
    trailing_cr: u64,
    /// 当前行是否已经读到过字节；区分「空行」与「什么都没读到」。
    pending: bool,
}

impl LineSplitter {
    fn new() -> Self {
        Self {
            kept: Vec::with_capacity(MAX_LINE_BYTES),
            dropped: 0,
            trailing_cr: 0,
            pending: false,
        }
    }

    /// 喂一段字节；这段里每结束一行就交给 `emit` 一次。
    fn feed(&mut self, mut chunk: &[u8], emit: &mut impl FnMut(String)) {
        while let Some(newline) = chunk.iter().position(|&b| b == b'\n') {
            self.push(&chunk[..newline]);
            emit(self.finish_line());
            chunk = &chunk[newline + 1..];
        }
        self.push(chunk);
    }

    /// 流结束时还没收尾的半行。
    fn take_pending(&mut self) -> Option<String> {
        self.pending.then(|| self.finish_line())
    }

    fn push(&mut self, segment: &[u8]) {
        if segment.is_empty() {
            return;
        }
        self.pending = true;
        let crs = segment.iter().rev().take_while(|&&b| b == b'\r').count() as u64;
        self.trailing_cr = if crs == segment.len() as u64 {
            self.trailing_cr + crs
        } else {
            crs
        };
        if self.dropped > 0 {
            self.dropped += segment.len() as u64;
            return;
        }
        let room = MAX_LINE_BYTES - self.kept.len();
        let (keep, rest) = segment.split_at(room.min(segment.len()));
        self.kept.extend_from_slice(keep);
        if let Some(&first_dropped) = rest.first() {
            // 上限正好切在一个 UTF-8 字符中间时退到这个字符之前，免得留下的部分以替换符收尾；
            // 被退掉的字节一并算进丢弃数。不是合法 UTF-8 的（如按系统代码页输出的）不退。
            let mut cut = self.kept.len();
            let tail_start = cut.saturating_sub(3);
            if is_utf8_continuation(first_dropped)
                && let Some(lead) = self.kept[tail_start..]
                    .iter()
                    .rposition(|&b| !is_utf8_continuation(b))
                    .map(|offset| tail_start + offset)
                && utf8_width(self.kept[lead]).is_some_and(|width| lead + width > cut)
            {
                cut = lead;
            }
            self.dropped = (self.kept.len() - cut + rest.len()) as u64;
            self.kept.truncate(cut);
        }
    }

    fn finish_line(&mut self) -> String {
        // 行尾的 `\r` 全落在丢掉的部分里时，丢掉的其实只是换行符，这一行并没有超长。
        let dropped = self.dropped.saturating_sub(self.trailing_cr);
        if dropped == 0 {
            let in_kept = usize::try_from(self.trailing_cr - self.dropped)
                .expect("留下的 \\r 不超过留下的字节数");
            self.kept.truncate(self.kept.len() - in_kept);
        }
        let mut text = String::from_utf8_lossy(&self.kept).into_owned();
        if dropped > 0 {
            text.push_str(&truncation_note(dropped));
        }
        self.kept.clear();
        self.dropped = 0;
        self.trailing_cr = 0;
        self.pending = false;
        text
    }
}

fn is_utf8_continuation(byte: u8) -> bool {
    byte & 0xC0 == 0x80
}

/// 以 `lead` 开头的 UTF-8 多字节字符占几个字节；不是多字节字符的首字节时为 `None`。
fn utf8_width(lead: u8) -> Option<usize> {
    match lead {
        0xC2..=0xDF => Some(2),
        0xE0..=0xEF => Some(3),
        0xF0..=0xF4 => Some(4),
        _ => None,
    }
}

/// 超长行末尾的说明。会话日志、崩溃判定缓存与界面拿到的都是同一行文本，说明随行走，三处一致。
fn truncation_note(dropped: u64) -> String {
    format!(
        "…（这一行超过 {} KB，其余 {dropped} 字节没有记录）",
        MAX_LINE_BYTES / 1024
    )
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

/// 把 `dirs` 按顺序拼到现有 PATH 头部。
fn prepend_path(dirs: &[&Path]) -> std::ffi::OsString {
    let sep = if cfg!(windows) { ";" } else { ":" };
    let mut combined = std::ffi::OsString::new();
    for (index, dir) in dirs.iter().enumerate() {
        if index > 0 {
            combined.push(sep);
        }
        combined.push(dir.as_os_str());
    }
    if let Some(existing) = std::env::var_os("PATH") {
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

    /// 1.5.2 这一代玩家点窗口的叉，游戏打一行再以退出码 1 结束，日志里没有别的异常。
    #[test]
    fn closing_the_window_of_an_old_version_is_not_a_crash() {
        let closed = [
            "Someone is closing me!",
            "AL lib: (EE) alc_cleanup: 1 device not closed",
        ];
        assert!(!detect_crash(&report(Some(1), &closed, false)));
    }

    #[test]
    fn window_close_line_does_not_excuse_real_crashes() {
        // 崩溃画面也是这个窗口，玩家看完关掉时同样打这一行。
        let crashed = ["---- Minecraft Crash Report ----", "Someone is closing me!"];
        assert!(detect_crash(&report(Some(1), &crashed, false)));
        // 关窗只会以 1 结束，别的退出码说明进程是自己倒下的。
        assert!(detect_crash(&report(
            Some(-1_073_741_819),
            &["Someone is closing me!"],
            false
        )));
        assert!(detect_crash(&report(
            None,
            &["Someone is closing me!"],
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
    fn prepend_path_keeps_the_given_order_in_front() {
        let combined = prepend_path(&[Path::new("C:/java/bin"), Path::new("C:/mc/natives")]);
        let sep = if cfg!(windows) { ";" } else { ":" };
        assert!(
            combined
                .to_string_lossy()
                .starts_with(&format!("C:/java/bin{sep}C:/mc/natives"))
        );
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

    async fn read_lines(input: &'static [u8], stream: LogStream) -> Vec<String> {
        let (tx, mut rx) = mpsc::unbounded_channel();
        spawn_reader(input, stream, SessionClock::start().unwrap(), tx)
            .await
            .unwrap();
        let mut out = Vec::new();
        while let Some(line) = rx.recv().await {
            out.push(line.text);
        }
        out
    }

    /// 真实客户端走官方日志配置时 stdout 是 XML：还原成普通行后级别才认得出来。
    #[tokio::test]
    async fn stdout_xml_events_reach_the_pipeline_as_plain_lines() {
        let input = concat!(
            "  <log4j:Event logger=\"a\" timestamp=\"1\" level=\"ERROR\" thread=\"main\">
",
            "    <log4j:Message><![CDATA[Incompatible mods found!]]></log4j:Message>
",
            "  </log4j:Event>
",
        )
        .as_bytes();
        let lines = read_lines(input, LogStream::Stdout).await;
        assert_eq!(lines, vec!["[main/ERROR]: Incompatible mods found!"]);
        assert_eq!(crate::game_line_level(&lines[0]), LauncherLevel::Error);
    }

    #[tokio::test]
    async fn stderr_is_not_treated_as_xml() {
        let input = b"<log4j:Event logger=\"a\" level=\"INFO\" thread=\"main\">
";
        assert_eq!(
            read_lines(input, LogStream::Stderr).await,
            vec![r#"<log4j:Event logger="a" level="INFO" thread="main">"#]
        );
    }

    /// Mod 打印几 MB 不带换行的转储：这一行只留前 64 KB 并注明丢掉的字节数，后面的行照常读到。
    #[tokio::test]
    async fn overlong_line_is_capped_and_the_next_line_survives() {
        const LONG: usize = 5 * 1024 * 1024;
        let mut data = vec![b'x'; LONG];
        data.extend_from_slice(b"\r\nAFTER_LONG_LINE\r\n");
        let clock = SessionClock::start().unwrap();
        let (tx, mut rx) = mpsc::unbounded_channel();
        spawn_reader(std::io::Cursor::new(data), LogStream::Stdout, clock, tx)
            .await
            .unwrap();
        let mut lines = Vec::new();
        while let Ok(line) = rx.try_recv() {
            lines.push(line.text);
        }
        assert_eq!(lines.len(), 2);
        let note = "…（这一行超过 64 KB，其余 5177344 字节没有记录）";
        // 先比长度：修复前这一行有 5 MB，直接比内容会把整行打进失败信息。
        assert_eq!(lines[0].len(), 64 * 1024 + note.len());
        let (kept, tail) = lines[0].split_at(64 * 1024);
        assert!(kept.bytes().all(|b| b == b'x'));
        assert_eq!(tail, note);
        assert_eq!(lines[1], "AFTER_LONG_LINE");
    }

    fn split_all(chunks: &[&[u8]]) -> (Vec<String>, LineSplitter) {
        let mut splitter = LineSplitter::new();
        let mut out = Vec::new();
        for chunk in chunks {
            splitter.feed(chunk, &mut |text| out.push(text));
        }
        if let Some(text) = splitter.take_pending() {
            out.push(text);
        }
        (out, splitter)
    }

    /// `len` 个 `fill` 接上 `tail`，整串一次喂进去。
    fn split(fill: u8, len: usize, tail: &[u8]) -> Vec<String> {
        let mut bytes = vec![fill; len];
        bytes.extend_from_slice(tail);
        split_all(&[bytes.as_slice()]).0
    }

    #[test]
    fn splitter_cuts_exactly_at_the_cap() {
        let max = MAX_LINE_BYTES;
        let a = |len| "a".repeat(len);
        // 正好上限：整行留下，不加说明。
        assert_eq!(split(b'a', max, b"\n"), [a(max)]);
        // 多 1 字节：丢 1 字节。
        assert_eq!(split(b'a', max + 1, b"\n"), [a(max) + &truncation_note(1)]);
        // 越过上限的只有行尾的 \r：那是换行符，不算超长。
        assert_eq!(split(b'a', max, b"\r\n"), [a(max)]);
        assert_eq!(split(b'a', max, b"\r\r\n"), [a(max)]);
        // 行尾的 \r 跨在上限两侧：留下的那个也去掉。
        assert_eq!(split(b'a', max - 1, b"\r\r\r\n"), [a(max - 1)]);
        // 行中的 \r 是正文；空行照样是一行；流尾没有换行的半行也交出。
        assert_eq!(split(b'a', 1, b"\rb\n\n\r\nlast"), ["a\rb", "", "", "last"]);
        assert!(split(b'a', 0, b"").is_empty());
        assert_eq!(split(b'a', 0, b"\r"), [""]);
    }

    #[test]
    fn splitter_does_not_cut_a_utf8_char_in_half() {
        let max = MAX_LINE_BYTES;
        // 「中」从上限前 1 字节开始：整个字退到截断处之后，丢弃数是「中文」的 6 个字节。
        assert_eq!(
            split(b'a', max - 1, "中文\n".as_bytes()),
            ["a".repeat(max - 1) + &truncation_note(6)]
        );
        // 字正好在上限处收尾：一个字节都不多退。
        assert_eq!(
            split(b'a', max - 3, "中文\n".as_bytes()),
            ["a".repeat(max - 3) + "中" + &truncation_note(3)]
        );
        // 按系统代码页输出的 GBK 字节不是 UTF-8，不退，照常有损解码。
        assert_eq!(
            split(b'a', max - 1, b"\xd6\xd0\n"),
            ["a".repeat(max - 1) + "\u{FFFD}" + &truncation_note(1)]
        );
    }

    #[test]
    fn splitter_holds_at_most_the_cap_while_a_long_line_streams() {
        let mut splitter = LineSplitter::new();
        let capacity = splitter.kept.capacity();
        let mut out = Vec::new();
        let block = vec![b'z'; 8 * 1024];
        // 5 MB 分成 8 KB 一块送进来，和读取端从管道里拿到的形状一样。
        for _ in 0..640 {
            splitter.feed(&block, &mut |text| out.push(text));
        }
        assert!(out.is_empty(), "还没读到换行，不该交出行");
        assert_eq!(splitter.kept.len(), MAX_LINE_BYTES);
        assert_eq!(splitter.kept.capacity(), capacity, "长行不应让缓冲增长");
        assert_eq!(splitter.dropped, (640 * 8 * 1024 - MAX_LINE_BYTES) as u64);
        splitter.feed(b"\nnext\n", &mut |text| out.push(text));
        assert_eq!(out.len(), 2);
        assert!(out[0].ends_with(&truncation_note((640 * 8 * 1024 - MAX_LINE_BYTES) as u64)));
        assert_eq!(out[1], "next");
        assert!(splitter.kept.is_empty() && splitter.dropped == 0);
    }

    /// 与分块无关：同一串字节无论怎么切成块喂进去，切出的行都与按整行算出的结果相同。
    #[test]
    fn splitter_output_does_not_depend_on_chunk_boundaries() {
        let seed = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos() as u64
            | 1;
        let mut state = seed;
        let mut next = move |bound: usize| {
            state ^= state << 13;
            state ^= state >> 7;
            state ^= state << 17;
            (state % bound as u64) as usize
        };
        let max = MAX_LINE_BYTES;
        let mut stream = Vec::new();
        let mut expected = Vec::new();
        for _ in 0..40 {
            // 长度集中在上限附近，夹带多字节字符与行尾 \r。
            let len = match next(4) {
                0 => next(64),
                1 => max - 4 + next(8),
                2 => max + next(3 * max),
                _ => next(max),
            };
            let mut line: Vec<u8> = Vec::with_capacity(len + 8);
            while line.len() < len {
                if next(10) == 0 {
                    line.extend_from_slice("樱".as_bytes());
                } else {
                    line.push(b'a' + next(26) as u8);
                }
            }
            let crs = next(3);
            let body_len = line.len();
            line.extend(std::iter::repeat_n(b'\r', crs));
            expected.push(reference_line(&line[..body_len]));
            stream.extend_from_slice(&line);
            stream.push(b'\n');
        }
        let mut chunks = Vec::new();
        let mut rest = stream.as_slice();
        while !rest.is_empty() {
            let take = (1 + next(20_000)).min(rest.len());
            let (head, tail) = rest.split_at(take);
            chunks.push(head);
            rest = tail;
        }
        let (lines, _) = split_all(&chunks);
        assert_eq!(lines.len(), expected.len(), "seed {seed}");
        for (index, (got, want)) in lines.iter().zip(&expected).enumerate() {
            assert!(got == want, "seed {seed}：第 {index} 行不一致");
        }
    }

    /// 按整行直接算（测试数据都是合法 UTF-8）：留到上限以内最后一个字符边界，其余计入说明。
    fn reference_line(body: &[u8]) -> String {
        let text = std::str::from_utf8(body).unwrap();
        if text.len() <= MAX_LINE_BYTES {
            return text.to_owned();
        }
        let cut = text.floor_char_boundary(MAX_LINE_BYTES);
        format!(
            "{}{}",
            &text[..cut],
            truncation_note((text.len() - cut) as u64)
        )
    }

    /// 会话日志、崩溃判定缓存与推给界面的批次拿到的是同一行截断后的文本。
    #[tokio::test]
    async fn capped_line_reads_the_same_in_log_recent_and_forward() {
        let tmp = tempfile::tempdir().unwrap();
        let clock = SessionClock::start().unwrap();
        let log = SessionLog::create(tmp.path(), "t", clock.started_at())
            .await
            .unwrap();
        let mut data = vec![b'q'; MAX_LINE_BYTES * 3];
        data.extend_from_slice(b"\nTAIL\n");
        let (line_tx, line_rx) = mpsc::unbounded_channel();
        let (fwd_tx, mut fwd_rx) = mpsc::unbounded_channel();
        let reader = spawn_reader(
            std::io::Cursor::new(data),
            LogStream::Stdout,
            clock,
            line_tx,
        );
        let outcome = pump(line_rx, Some(log), Some(fwd_tx)).await;
        reader.await.unwrap();

        let expected = "q".repeat(MAX_LINE_BYTES) + &truncation_note((MAX_LINE_BYTES * 2) as u64);
        let mut forwarded = Vec::new();
        while let Ok(batch) = fwd_rx.try_recv() {
            forwarded.extend(batch.into_iter().map(|line| line.text));
        }
        assert_eq!(forwarded, [expected.clone(), "TAIL".to_owned()]);
        let recent: Vec<&str> = outcome.recent.iter().map(String::as_str).collect();
        assert_eq!(recent, [expected.as_str(), "TAIL"]);
        let path = outcome
            .log
            .unwrap()
            .finish(clock.now(), SessionOutcome::Exited)
            .await
            .unwrap();
        let tail = crate::logfile::read_log_tail(&path, 1 << 20, 10)
            .await
            .unwrap();
        let logged: Vec<&str> = tail.entries.iter().map(|e| e.text.as_str()).collect();
        assert_eq!(logged, [expected.as_str(), "TAIL"]);
    }

    /// 游戏输出里的令牌：1.7、1.8 原版在 stdout 上以 log4j XML 打会话 id，stderr 上是原样回显的启动参数。
    /// 会话日志文件、崩溃判定缓存与推给界面的批次里都只剩标记，同一行的其余内容照旧。
    #[tokio::test]
    async fn tokens_in_game_output_never_reach_log_recent_or_forward() {
        const TOKEN: &str = "eyJhbGciOiJIUzI1NiJ9.eyJ4dWlkIjoiMjUzNTQwMDAwMDAwMDAwMCIsInN1YiI6InBldGFsZmFsbCJ9.Zm9yLXRlc3RzLW9ubHktbm90LWEtcmVhbC1zaWduYXR1cmU";
        const UUID: &str = "0123456789abcdef0123456789abcdef";
        let tmp = tempfile::tempdir().unwrap();
        let clock = SessionClock::start().unwrap();
        let log = SessionLog::create(tmp.path(), "t", clock.started_at())
            .await
            .unwrap();
        let stdout = format!(
            "<log4j:Event logger=\"bao\" timestamp=\"1\" level=\"INFO\" thread=\"Client thread\">\n\
             <log4j:Message><![CDATA[(Session ID is token:{TOKEN}:{UUID})]]></log4j:Message>\n\
             </log4j:Event>\n"
        );
        let stderr =
            format!("args: --username Steve --uuid {UUID} --accessToken {TOKEN} --userType msa\n");
        let (line_tx, line_rx) = mpsc::unbounded_channel();
        let (fwd_tx, mut fwd_rx) = mpsc::unbounded_channel();
        let readers = [
            spawn_reader(
                std::io::Cursor::new(stdout.into_bytes()),
                LogStream::Stdout,
                clock,
                line_tx.clone(),
            ),
            spawn_reader(
                std::io::Cursor::new(stderr.into_bytes()),
                LogStream::Stderr,
                clock,
                line_tx,
            ),
        ];
        let outcome = pump(line_rx, Some(log), Some(fwd_tx)).await;
        for reader in readers {
            reader.await.unwrap();
        }

        let session = format!("[Client thread/INFO]: (Session ID is token:<已隐藏>:{UUID})");
        let args =
            format!("args: --username Steve --uuid {UUID} --accessToken <已隐藏> --userType msa");
        // 两条流各一个读取任务，谁先到汇流不定。
        let sorted = |mut lines: Vec<String>| {
            lines.sort();
            lines
        };
        let expected = sorted(vec![session, args]);
        let mut forwarded = Vec::new();
        while let Ok(batch) = fwd_rx.try_recv() {
            forwarded.extend(batch.into_iter().map(|line| line.text));
        }
        assert_eq!(sorted(forwarded), expected);
        assert_eq!(sorted(outcome.recent.iter().cloned().collect()), expected);
        let path = outcome
            .log
            .unwrap()
            .finish(clock.now(), SessionOutcome::Exited)
            .await
            .unwrap();
        // 读文件原文：读回会话日志时还会再遮一遍，那一遍挡不住写进磁盘的这一份。
        let raw = std::fs::read_to_string(&path).unwrap();
        assert!(!raw.contains(TOKEN), "{raw}");
        for line in &expected {
            assert!(raw.contains(line.as_str()), "{raw}");
        }
    }

    /// 一局会话的输出端：stdout 读一段内存里的字节，stderr 立即读完，会话日志写进临时目录。
    struct Output {
        _tmp: tempfile::TempDir,
        dir: std::path::PathBuf,
        clock: SessionClock,
        readers: Vec<JoinHandle<()>>,
        pump: JoinHandle<PumpOutcome>,
    }

    async fn output(stdout: &'static [u8]) -> Output {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().to_path_buf();
        let clock = SessionClock::start().unwrap();
        let log = SessionLog::create(&dir, "t", clock.started_at())
            .await
            .unwrap();
        let (tx, rx) = mpsc::unbounded_channel();
        let readers = vec![
            spawn_reader(stdout, LogStream::Stdout, clock, tx.clone()),
            spawn_reader(&b""[..], LogStream::Stderr, clock, tx),
        ];
        let pump_task = tokio::spawn(pump(rx, Some(log), None));
        Output {
            _tmp: tmp,
            dir,
            clock,
            readers,
            pump: pump_task,
        }
    }

    type Logged = (LogSource, Option<LauncherLevel>, String);

    async fn read_back(dir: &Path) -> (Vec<Logged>, Option<SessionOutcome>) {
        let tail =
            crate::logfile::read_log_tail(&dir.join(crate::logfile::LATEST_LOG), 1 << 20, 100)
                .await
                .unwrap();
        let lines = tail
            .entries
            .into_iter()
            .map(|e| (e.source, e.level, e.text))
            .collect();
        (lines, tail.ended.map(|ended| ended.outcome))
    }

    fn clean_exit() -> ExitStatus {
        #[cfg(unix)]
        use std::os::unix::process::ExitStatusExt;
        #[cfg(windows)]
        use std::os::windows::process::ExitStatusExt;
        ExitStatus::from_raw(0)
    }

    fn game(text: &str) -> Logged {
        (LogSource::Game, None, text.to_owned())
    }

    fn launcher_error(text: &str) -> Logged {
        (
            LogSource::Launcher,
            Some(LauncherLevel::Error),
            text.to_owned(),
        )
    }

    /// 正常退出：日志保持打开交还调用方，读到的行都在报告里。
    #[tokio::test]
    async fn conclude_hands_back_the_open_log_on_a_clean_exit() {
        let out = output(b"LINE_ONE\nLINE_TWO\n").await;
        let exited = Exited {
            status: Ok(clean_exit()),
            terminated_by_launcher: false,
        };
        let end = conclude(
            exited,
            out.clock,
            out.readers,
            out.pump,
            Duration::from_secs(5),
        )
        .await;
        assert!(end.failure.is_none(), "{:?}", end.failure);
        assert_eq!(end.report.code, Some(0));
        assert!(end.report.success);
        assert_eq!(end.report.recent_lines, ["LINE_ONE", "LINE_TWO"]);
        let log = end.log.expect("日志应保持打开交还调用方");
        assert_eq!(log.lines(), 2);
        // 结局由调用方写：此时文件里还没有结局行。
        drop(log);
        assert_eq!(read_back(&out.dir).await.1, None);
    }

    /// 版本 JSON 的日志配置让 stdout 走 XML：会话日志与崩溃判定缓存里都要是还原后的普通行。
    #[tokio::test]
    async fn xml_log_events_are_recorded_as_plain_lines() {
        let out = output(
            b"  <log4j:Event logger=\"FabricLoader\" timestamp=\"1\" level=\"ERROR\" thread=\"main\">\n    <log4j:Message><![CDATA[Incompatible mods found!]]></log4j:Message>\n  </log4j:Event>\nPLAIN\n",
        )
        .await;
        let exited = Exited {
            status: Ok(clean_exit()),
            terminated_by_launcher: false,
        };
        let end = conclude(
            exited,
            out.clock,
            out.readers,
            out.pump,
            Duration::from_secs(5),
        )
        .await;
        assert_eq!(
            end.report.recent_lines,
            ["[main/ERROR]: Incompatible mods found!", "PLAIN"]
        );
        end.log
            .expect("日志应保持打开交还调用方")
            .finish(out.clock.now(), SessionOutcome::Exited)
            .await
            .unwrap();
        assert_eq!(
            read_back(&out.dir).await.0,
            [
                game("[main/ERROR]: Incompatible mods found!"),
                game("PLAIN")
            ]
        );
    }

    /// 等待进程本身失败：照样读完输出、写下原因与结局并落盘，退出报告与那次失败一并交出。
    #[tokio::test]
    async fn wait_failure_still_settles_the_session_log() {
        let out = output(b"LINE_ONE\nLINE_TWO\n").await;
        let exited = Exited {
            status: Err(std::io::Error::other("句柄已失效")),
            terminated_by_launcher: false,
        };
        let end = conclude(
            exited,
            out.clock,
            out.readers,
            out.pump,
            Duration::from_secs(5),
        )
        .await;
        let failure = end.failure.expect("等待失败应交出失败");
        let LaunchError::Wait(source) = &failure.error else {
            panic!("应报等待失败：{:?}", failure.error);
        };
        assert_eq!(source.to_string(), "句柄已失效");
        assert_eq!(
            failure.log_path.as_deref(),
            Some(out.dir.join(crate::logfile::LATEST_LOG).as_path()),
            "应交出已落盘的会话日志"
        );
        assert!(end.log.is_none(), "日志已在收尾时关闭");
        // 退出码无从得知，读到的输出照样在报告里，供上层做崩溃判定。
        assert_eq!(end.report.code, None);
        assert!(!end.report.success);
        assert!(!end.report.terminated_by_launcher);
        assert_eq!(end.report.recent_lines, ["LINE_ONE", "LINE_TWO"]);
        let (lines, ended) = read_back(&out.dir).await;
        assert_eq!(
            lines,
            [
                game("LINE_ONE"),
                game("LINE_TWO"),
                launcher_error("等待游戏进程结束失败：句柄已失效（退出码 未知）"),
            ]
        );
        // 拿不到退出码按异常结束记，与崩溃判定的规则一致。
        assert_eq!(ended, Some(SessionOutcome::Crashed));
    }

    /// 玩家点过结束之后等待失败：结局记为玩家结束，不是崩溃。
    #[tokio::test]
    async fn wait_failure_after_a_kill_request_ends_as_killed() {
        let out = output(b"").await;
        let exited = Exited {
            status: Err(std::io::Error::other("句柄已失效")),
            terminated_by_launcher: true,
        };
        let end = conclude(
            exited,
            out.clock,
            out.readers,
            out.pump,
            Duration::from_secs(5),
        )
        .await;
        let failure = end.failure.expect("等待失败应交出失败");
        assert!(matches!(failure.error, LaunchError::Wait(_)), "{failure:?}");
        // 玩家点过结束这一事实随报告交出，上层据此记为结束而不是崩溃。
        assert!(end.report.terminated_by_launcher);
        let (lines, ended) = read_back(&out.dir).await;
        assert_eq!(
            lines,
            [launcher_error(
                "等待游戏进程结束失败：句柄已失效（退出码 未知）"
            )]
        );
        assert_eq!(ended, Some(SessionOutcome::Killed));
    }

    /// 读取任务异常结束：退出码照样记下，日志写下原因与结局，再报出异常。
    #[tokio::test]
    async fn crashed_reader_still_settles_the_session_log() {
        let out = output(b"LINE\n").await;
        let mut readers = out.readers;
        let crashed: JoinHandle<()> = tokio::spawn(async { panic!("模拟读取任务崩溃") });
        readers.push(crashed);
        let exited = Exited {
            status: Ok(clean_exit()),
            terminated_by_launcher: false,
        };
        let end = conclude(exited, out.clock, readers, out.pump, Duration::from_secs(5)).await;
        let failure = end.failure.expect("读取任务异常结束应交出失败");
        assert!(
            matches!(&failure.error, LaunchError::Join(join) if join.is_panic()),
            "{failure:?}"
        );
        assert_eq!(end.report.code, Some(0));
        let (lines, ended) = read_back(&out.dir).await;
        assert_eq!(lines.len(), 2, "{lines:?}");
        assert_eq!(lines[0], game("LINE"));
        let (source, level, text) = &lines[1];
        assert_eq!(
            (*source, *level),
            (LogSource::Launcher, Some(LauncherLevel::Error))
        );
        assert!(text.starts_with("游戏会话的后台任务异常结束："), "{text}");
        assert!(text.contains("模拟读取任务崩溃"), "{text}");
        assert!(text.ends_with("（退出码 0）"), "{text}");
        // 游戏自己是正常退出的。
        assert_eq!(ended, Some(SessionOutcome::Exited));
    }

    /// 一条流先读完、另一条被别的进程开着：限时到了只结束没读完的那个，已经收回的不再去等。
    #[tokio::test]
    async fn drain_deadline_with_one_stream_already_closed() {
        let held = std::sync::Arc::new(());
        let witness = held.clone();
        let readers = vec![
            tokio::spawn(async {}),
            tokio::spawn(async move {
                let _held = witness;
                std::future::pending::<()>().await;
            }),
        ];
        let drained = drain_readers(readers, Duration::from_millis(50))
            .await
            .unwrap();
        assert!(!drained);
        assert_eq!(
            std::sync::Arc::strong_count(&held),
            1,
            "没读完的读取任务应已结束"
        );
    }

    /// 一个读取任务异常结束：报出异常，另一个不留在后台继续占着管道。
    #[tokio::test]
    async fn drain_reports_a_crashed_reader_and_stops_the_rest() {
        let held = std::sync::Arc::new(());
        let witness = held.clone();
        let crashed: JoinHandle<()> = tokio::spawn(async { panic!("模拟读取任务崩溃") });
        let readers = vec![
            crashed,
            tokio::spawn(async move {
                let _held = witness;
                std::future::pending::<()>().await;
            }),
        ];
        let err = drain_readers(readers, Duration::from_secs(5))
            .await
            .unwrap_err();
        assert!(
            matches!(&err, LaunchError::Join(join) if join.is_panic()),
            "{err:?}"
        );
        assert_eq!(
            std::sync::Arc::strong_count(&held),
            1,
            "其余读取任务应已结束"
        );
    }

    #[cfg(windows)]
    fn command(program: &str, args: &[&str]) -> LaunchCommand {
        LaunchCommand {
            program: std::path::PathBuf::from(program),
            args: args.iter().map(|a| (*a).to_owned()).collect(),
            working_dir: std::env::temp_dir(),
            natives_dir: std::env::temp_dir().join("natives-on-path"),
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
            &mut Some(log),
            Some(fwd_tx),
        )
        .unwrap();
        let end = session.wait().await;
        assert!(end.failure.is_none(), "{:?}", end.failure);

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
            .finish(clock.now(), SessionOutcome::Crashed)
            .await
            .unwrap();
        let content = std::fs::read_to_string(path).unwrap();
        assert!(content.contains("[game] PETAL_HELLO"), "{content}");
    }

    /// LWJGL 2 按裸文件名找 OpenAL 时靠的是系统的 DLL 搜索路径，游戏进程的 PATH 里得有 natives 目录。
    #[cfg(windows)]
    #[tokio::test]
    async fn spawn_puts_natives_dir_on_the_game_path() {
        let clock = SessionClock::start().unwrap();
        let session = spawn(&cmd("echo PATH_IS=%PATH%"), clock, &mut None, None).unwrap();
        let end = session.wait().await;
        assert!(end.failure.is_none(), "{:?}", end.failure);

        let line = end
            .report
            .recent_lines
            .iter()
            .find_map(|l| l.strip_prefix("PATH_IS="))
            .expect("应打印 PATH")
            .to_owned();
        let natives = std::env::temp_dir().join("natives-on-path");
        assert!(
            line.split(';').any(|dir| dir == natives.to_string_lossy()),
            "PATH 里应有 natives 目录：{line}"
        );
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn kill_switch_ends_process_and_marks_termination() {
        let clock = SessionClock::start().unwrap();
        // ping 自身 30 次约 30 秒，足够在它退出前发出结束请求。
        let session = spawn(
            &command("ping", &["-n", "30", "127.0.0.1"]),
            clock,
            &mut None,
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
            &mut Some(log),
            None,
        )
        .unwrap();
        let started = std::time::Instant::now();
        let end = tokio::time::timeout(Duration::from_secs(15), session.wait())
            .await
            .expect("游戏进程退出后应在收尾时限内产出报告");
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
            .finish(clock.now(), SessionOutcome::Exited)
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
        let session = spawn(
            &command("cmd", &["/C", "type", &path]),
            clock,
            &mut None,
            None,
        )
        .unwrap();
        let end = session.wait().await;
        assert_eq!(end.report.recent_lines.len(), 2);
        assert!(end.report.recent_lines[0].contains('\u{FFFD}'));
        assert_eq!(end.report.recent_lines[1], "AFTER_BAD_BYTES");
    }
}
