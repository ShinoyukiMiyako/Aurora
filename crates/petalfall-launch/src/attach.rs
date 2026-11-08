//! 接回落樱关闭前启动、此刻仍在运行的游戏进程。
//!
//! 落樱退出后游戏照跑（它是普通子进程，没有挂在作业对象上），但输出管道随落樱一起断了。重新打开时凭
//! 启动时记下的凭据 [`ProcessIdentity`] 找回那个进程：按 pid 打开、创建时刻逐位相等、映像路径相同、还没
//! 退出，四条都对上才算。pid 只在原进程彻底消失后才会被复用，新进程的创建时刻必然不同，这是防认错的
//! 主防线；映像路径再挡一道。接回后一直持有这个句柄，期间 pid 不会被复用，结束游戏也只对它操作。
//!
//! 没有了输出管道，接回的会话改为追读游戏自己写的 `logs/latest.log`：读到的新行与管道读到的行走同一条
//! 汇流，照样写会话日志、留最近几行供崩溃判定、批量推给界面。

use std::path::PathBuf;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tokio::sync::{mpsc, oneshot};
use tokio::task::JoinHandle;

use crate::error::Result;
use crate::logfile::{SessionClock, SessionLog};
use crate::process::{
    Exited, KillRequest, KillSwitch, LineSplitter, LogBatchSink, LogLine, LogMarker, LogStream,
    OUTPUT_DRAIN_DEADLINE, PumpOutcome, SessionEnd, conclude, pump,
};
use crate::redact::redact_access_tokens;

/// 查一次接回的进程退出没有的间隔。只是一次不阻塞的等待调用；退出时刻因此最多晚这么久，对游玩时长无关紧要。
pub const EXIT_POLL_INTERVAL: Duration = Duration::from_millis(250);
/// 追读游戏日志文件的间隔。
pub const TAIL_INTERVAL: Duration = Duration::from_millis(250);
/// 开始追读时往回找行首最多看这么多字节；再长的一行也到不了这里，找不到就丢掉开头那段残行。
const TAIL_SEEK_BACK_BYTES: u64 = 64 * 1024;
/// 每次从日志文件读多少字节。
const TAIL_READ_CHUNK: usize = 64 * 1024;

/// 认一个进程的凭据。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProcessIdentity {
    pub pid: u32,
    /// 系统记下的进程创建时刻（`FILETIME`，自 1601 年起的 100 纳秒数）。
    pub created: u64,
    /// 系统报告的进程映像路径。取的是系统自己的说法而不是启动命令里写的路径，前后两次比较才是同源的。
    pub exe: PathBuf,
}

/// 凭据对不上，不接回。
#[derive(Debug)]
pub enum Refusal {
    /// 没有这个 pid 的进程。
    Gone,
    /// 有这个 pid，但打不开（受保护的系统进程之类）：落樱自己拉起的游戏不会这样，不是它。
    Inaccessible(std::io::Error),
    /// 创建时刻不同：pid 已被别的进程复用。
    CreatedAt { found: u64 },
    /// 映像路径不同。
    Exe { found: PathBuf },
    /// 就是那个进程，但已经退出。
    Exited,
}

impl std::fmt::Display for Refusal {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Refusal::Gone => write!(f, "进程已不在"),
            Refusal::Inaccessible(err) => write!(f, "进程打不开（{err}），不是落樱启动的那一个"),
            Refusal::CreatedAt { found } => {
                write!(
                    f,
                    "进程的创建时刻是 {found}，与记录不同，pid 已被别的进程复用"
                )
            }
            Refusal::Exe { found } => {
                write!(f, "进程的程序是 {}，与记录不同", found.display())
            }
            Refusal::Exited => write!(f, "进程已经退出"),
        }
    }
}

/// 按凭据打开、核对过的进程。丢弃即关闭句柄。
pub struct AttachedProcess {
    identity: ProcessIdentity,
    #[cfg(windows)]
    handle: std::os::windows::io::OwnedHandle,
}

impl AttachedProcess {
    pub fn identity(&self) -> &ProcessIdentity {
        &self.identity
    }
}

/// 按凭据打开进程，四条都对上才交出句柄。
pub fn open_process(
    identity: &ProcessIdentity,
) -> Result<std::result::Result<AttachedProcess, Refusal>> {
    sys::open(identity)
}

/// 子进程的凭据。
pub(crate) fn identity_of_child(child: &tokio::process::Child) -> Result<ProcessIdentity> {
    sys::identity_of_child(child)
}

/// 一次接回的游戏会话。
pub struct AttachedSession {
    process: AttachedProcess,
    clock: SessionClock,
    readers: Vec<JoinHandle<()>>,
    stop_tail: Option<oneshot::Sender<()>>,
    pump: JoinHandle<PumpOutcome>,
    kill_tx: mpsc::UnboundedSender<KillRequest>,
    kill_rx: mpsc::UnboundedReceiver<KillRequest>,
    mark_tx: mpsc::UnboundedSender<crate::process::MarkRequest>,
}

/// 接回一个进程：起追读与汇流任务。`log` 是接着写的会话日志，`game_log_file` 是游戏自己的日志文件
/// （不存在时照样追读，游戏之后建出来就从头读起），`forward` 接收批量转发的行。
pub fn attach(
    process: AttachedProcess,
    clock: SessionClock,
    log: Option<SessionLog>,
    game_log_file: Option<PathBuf>,
    forward: Option<LogBatchSink>,
) -> AttachedSession {
    let (line_tx, line_rx) = mpsc::unbounded_channel::<LogLine>();
    let mut readers = Vec::new();
    let mut stop_tail = None;
    if let Some(path) = game_log_file {
        let (stop_tx, stop_rx) = oneshot::channel();
        readers.push(spawn_tail(path, clock, line_tx, stop_rx));
        stop_tail = Some(stop_tx);
    } else {
        drop(line_tx);
    }
    let (mark_tx, mark_rx) = mpsc::unbounded_channel();
    let pump = tokio::spawn(pump(line_rx, log, forward, mark_rx));
    let (kill_tx, kill_rx) = mpsc::unbounded_channel();
    AttachedSession {
        process,
        clock,
        readers,
        stop_tail,
        pump,
        kill_tx,
        kill_rx,
        mark_tx,
    }
}

impl AttachedSession {
    pub fn id(&self) -> u32 {
        self.process.identity.pid
    }

    pub fn identity(&self) -> &ProcessIdentity {
        &self.process.identity
    }

    /// 结束游戏的句柄。
    pub fn kill_switch(&self) -> KillSwitch {
        KillSwitch(self.kill_tx.clone())
    }

    /// 在会话日志里留说明并落盘的句柄。
    pub fn log_marker(&self) -> LogMarker {
        LogMarker {
            tx: self.mark_tx.clone(),
            clock: self.clock,
        }
    }

    /// 等进程退出，期间随时响应结束请求；退出后让追读把文件里剩下的行读完再收尾，产出与子进程会话同样的
    /// 退出报告。退出码由持有的句柄取得，接回的进程不是子进程也拿得到。
    pub async fn wait(mut self) -> SessionEnd {
        let mut terminated_by_launcher = false;
        let mut poll = tokio::time::interval(EXIT_POLL_INTERVAL);
        poll.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        let status = loop {
            tokio::select! {
                _ = poll.tick() => match sys::has_exited(&self.process) {
                    Ok(true) => break sys::exit_status(&self.process),
                    Ok(false) => {}
                    Err(err) => break Err(err),
                },
                Some(ack) = self.kill_rx.recv() => {
                    // 先置位再结束：即便结束动作本身失败，这次意图也已记录，退出不会被误判成崩溃。
                    terminated_by_launcher = true;
                    let result = sys::terminate(&self.process);
                    // 回执发不出去只说明请求方不等了，不改变已经执行的事实。
                    let _ = ack.send(result);
                }
            }
        };
        if let Some(stop) = self.stop_tail.take() {
            // 追读任务已经自己结束时收不到，那也就不用停了。
            let _ = stop.send(());
        }
        conclude(
            Exited {
                status,
                terminated_by_launcher,
            },
            self.clock,
            std::mem::take(&mut self.readers),
            self.pump,
            OUTPUT_DRAIN_DEADLINE,
        )
        .await
    }
}

/// 追读游戏的日志文件，逐行交给汇流。从开始追读时文件的最后一个行首读起：之前的内容是落樱关着时
/// 写下的，会话日志里不重复记。文件变短说明游戏把它滚动掉换了一份新的（跨午夜时会这样），从头读新的。
/// 收到停止信号后把文件里剩下的读完、交出没有换行的最后半行再结束。
fn spawn_tail(
    path: PathBuf,
    clock: SessionClock,
    tx: mpsc::UnboundedSender<LogLine>,
    mut stop: oneshot::Receiver<()>,
) -> JoinHandle<()> {
    tokio::spawn(async move {
        let mut send = |mut text: String| {
            redact_access_tokens(&mut text);
            let line = LogLine {
                at: clock.now(),
                stream: LogStream::LogFile,
                text,
            };
            if tx.send(line).is_err() {
                tracing::warn!("游戏输出汇流任务已退出，丢弃后续的日志文件内容");
            }
        };
        let mut tail = match TailState::start(&path).await {
            Ok(tail) => tail,
            Err(err) => {
                tracing::warn!(path = %path.display(), error = %err, "定位游戏日志文件的末尾失败，从头读起");
                TailState::from_start()
            }
        };
        let mut ticker = tokio::time::interval(TAIL_INTERVAL);
        ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        let mut failing = false;
        loop {
            // 停止信号的发送端被丢弃（会话没等完就被丢了）同样算停止。
            let stopping = tokio::select! {
                _ = ticker.tick() => false,
                _ = &mut stop => true,
            };
            match tail.read_new(&path, &mut send).await {
                Ok(()) => failing = false,
                Err(err) => {
                    // 文件被杀毒软件之类短暂占住时每一轮都会失败，只在开始失败时记一次。
                    if !failing {
                        tracing::warn!(path = %path.display(), error = %err, "读取游戏日志文件失败，稍后重试");
                    }
                    failing = true;
                }
            }
            if stopping {
                break;
            }
        }
        if let Some(text) = tail.lines.take_pending()
            && !tail.skip_first
        {
            send(text);
        }
    })
}

/// 追读的进度。
struct TailState {
    /// 下一次从文件的这个偏移读起。
    offset: u64,
    lines: LineSplitter,
    /// 开始追读的位置落在一行中间（往回没找到行首）：读到的第一行只是残行，丢掉。
    skip_first: bool,
}

impl TailState {
    fn from_start() -> Self {
        Self {
            offset: 0,
            lines: LineSplitter::new(),
            skip_first: false,
        }
    }

    /// 定位到文件此刻最后一个行首。文件还不存在时从头读：游戏之后建出来的每一行都是新的。
    async fn start(path: &std::path::Path) -> std::io::Result<Self> {
        use tokio::io::{AsyncReadExt, AsyncSeekExt};

        let mut file = match tokio::fs::File::open(path).await {
            Ok(file) => file,
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(Self::from_start()),
            Err(err) => return Err(err),
        };
        let len = file.metadata().await?.len();
        let back = len.min(TAIL_SEEK_BACK_BYTES);
        file.seek(std::io::SeekFrom::Start(len - back)).await?;
        let mut tail = vec![0u8; usize::try_from(back).expect("回看长度在 usize 内")];
        file.read_exact(&mut tail).await?;
        let (offset, skip_first) = match tail.iter().rposition(|b| *b == b'\n') {
            Some(index) => (len - back + index as u64 + 1, false),
            // 整段回看里没有换行：文件不到这么长时开头就是行首；否则落在一行中间。
            None if back == len => (0, false),
            None => (len, true),
        };
        Ok(Self {
            offset,
            lines: LineSplitter::new(),
            skip_first,
        })
    }

    /// 读完文件里新增的内容。
    async fn read_new(
        &mut self,
        path: &std::path::Path,
        send: &mut impl FnMut(String),
    ) -> std::io::Result<()> {
        use tokio::io::{AsyncReadExt, AsyncSeekExt};

        let mut file = match tokio::fs::File::open(path).await {
            Ok(file) => file,
            // 滚动的瞬间旧文件已改名、新文件还没建出来。
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(()),
            Err(err) => return Err(err),
        };
        let len = file.metadata().await?.len();
        if len < self.offset {
            // 换了一份新文件：旧文件没读完的半行随它去了。
            *self = Self::from_start();
        }
        if len == self.offset {
            return Ok(());
        }
        file.seek(std::io::SeekFrom::Start(self.offset)).await?;
        let mut chunk = vec![0u8; TAIL_READ_CHUNK];
        let mut remaining = len - self.offset;
        while remaining > 0 {
            let want =
                usize::try_from(remaining.min(TAIL_READ_CHUNK as u64)).expect("块大小在 usize 内");
            let n = file.read(&mut chunk[..want]).await?;
            if n == 0 {
                break;
            }
            let skip_first = &mut self.skip_first;
            self.lines.feed(&chunk[..n], &mut |text| {
                if std::mem::take(skip_first) {
                    return;
                }
                send(text);
            });
            self.offset += n as u64;
            remaining -= n as u64;
        }
        Ok(())
    }
}

#[cfg(windows)]
mod sys {
    use std::ffi::OsString;
    use std::os::windows::ffi::OsStringExt;
    use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
    use std::os::windows::process::ExitStatusExt;
    use std::path::PathBuf;
    use std::process::ExitStatus;

    use windows_sys::Win32::Foundation::{
        ERROR_ACCESS_DENIED, ERROR_INVALID_PARAMETER, FILETIME, HANDLE, WAIT_OBJECT_0, WAIT_TIMEOUT,
    };
    use windows_sys::Win32::System::Threading::{
        GetExitCodeProcess, GetProcessTimes, OpenProcess, PROCESS_NAME_WIN32,
        PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_SYNCHRONIZE, PROCESS_TERMINATE,
        QueryFullProcessImageNameW, TerminateProcess, WaitForSingleObject,
    };

    use super::{AttachedProcess, ProcessIdentity, Refusal};
    use crate::error::{LaunchError, Result};

    /// 映像路径的缓冲长度（UTF-16 单元）：长路径上限。
    const IMAGE_PATH_UNITS: usize = 32_768;
    /// 落樱自己 `TerminateProcess` 时给的退出码，与 `Child::start_kill` 一致。
    const KILLED_EXIT_CODE: u32 = 1;

    pub(super) fn identity_of_child(child: &tokio::process::Child) -> Result<ProcessIdentity> {
        let (Some(pid), Some(handle)) = (child.id(), child.raw_handle()) else {
            return Err(LaunchError::ProcessReaped);
        };
        identity_of(pid, handle).map_err(|source| LaunchError::Process { pid, source })
    }

    fn identity_of(pid: u32, handle: HANDLE) -> std::io::Result<ProcessIdentity> {
        Ok(ProcessIdentity {
            pid,
            created: creation_time(handle)?,
            exe: image_path(handle)?,
        })
    }

    pub(super) fn open(
        identity: &ProcessIdentity,
    ) -> Result<std::result::Result<AttachedProcess, Refusal>> {
        let pid = identity.pid;
        let access = PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SYNCHRONIZE | PROCESS_TERMINATE;
        // SAFETY: 只传值参数；返回的句柄立刻交给 OwnedHandle 管理关闭。
        let raw = unsafe { OpenProcess(access, 0, pid) };
        if raw.is_null() {
            let err = std::io::Error::last_os_error();
            return match err.raw_os_error().map(|code| code as u32) {
                Some(ERROR_INVALID_PARAMETER) => Ok(Err(Refusal::Gone)),
                Some(ERROR_ACCESS_DENIED) => Ok(Err(Refusal::Inaccessible(err))),
                _ => Err(LaunchError::Process { pid, source: err }),
            };
        }
        // SAFETY: raw 是刚打开、非空、归这里独占的进程句柄。
        let handle = unsafe { OwnedHandle::from_raw_handle(raw) };
        let process = AttachedProcess {
            identity: identity.clone(),
            handle,
        };
        let failed = |source| LaunchError::Process { pid, source };
        let created = creation_time(raw_of(&process)).map_err(failed)?;
        if created != identity.created {
            return Ok(Err(Refusal::CreatedAt { found: created }));
        }
        // 退出检查排在映像路径之前：进程退出后映像已卸掉，再查路径系统会报错。
        if has_exited(&process).map_err(failed)? {
            return Ok(Err(Refusal::Exited));
        }
        let exe = image_path(raw_of(&process)).map_err(failed)?;
        if !same_exe(&exe, &identity.exe) {
            return Ok(Err(Refusal::Exe { found: exe }));
        }
        Ok(Ok(process))
    }

    /// Windows 的路径不分大小写；两边都取自系统，正常情况下逐字相同。
    fn same_exe(a: &std::path::Path, b: &std::path::Path) -> bool {
        a.as_os_str().to_string_lossy().to_lowercase()
            == b.as_os_str().to_string_lossy().to_lowercase()
    }

    fn raw_of(process: &AttachedProcess) -> HANDLE {
        process.handle.as_raw_handle()
    }

    pub(super) fn has_exited(process: &AttachedProcess) -> std::io::Result<bool> {
        // SAFETY: 句柄在 process 存活期间有效。
        match unsafe { WaitForSingleObject(raw_of(process), 0) } {
            WAIT_OBJECT_0 => Ok(true),
            WAIT_TIMEOUT => Ok(false),
            _ => Err(std::io::Error::last_os_error()),
        }
    }

    /// 已退出进程的退出状态。只在 [`has_exited`] 为真之后调用：之前取到的是「仍在运行」的占位值。
    pub(super) fn exit_status(process: &AttachedProcess) -> std::io::Result<ExitStatus> {
        let mut code = 0u32;
        // SAFETY: 句柄有效，code 是可写的 u32。
        if unsafe { GetExitCodeProcess(raw_of(process), &mut code) } == 0 {
            return Err(std::io::Error::last_os_error());
        }
        Ok(ExitStatus::from_raw(code))
    }

    /// 结束进程。恰好已经自己退出时系统会拒绝结束，这不是失败。
    pub(super) fn terminate(process: &AttachedProcess) -> Result<()> {
        // SAFETY: 句柄有效，带 PROCESS_TERMINATE 权限打开。
        if unsafe { TerminateProcess(raw_of(process), KILLED_EXIT_CODE) } != 0 {
            return Ok(());
        }
        let err = std::io::Error::last_os_error();
        match has_exited(process) {
            Ok(true) => Ok(()),
            _ => Err(LaunchError::Kill(err)),
        }
    }

    fn creation_time(handle: HANDLE) -> std::io::Result<u64> {
        let mut created = FILETIME::default();
        let mut exited = FILETIME::default();
        let mut kernel = FILETIME::default();
        let mut user = FILETIME::default();
        // SAFETY: 四个出参都是可写的 FILETIME。
        let ok =
            unsafe { GetProcessTimes(handle, &mut created, &mut exited, &mut kernel, &mut user) };
        if ok == 0 {
            return Err(std::io::Error::last_os_error());
        }
        Ok((u64::from(created.dwHighDateTime) << 32) | u64::from(created.dwLowDateTime))
    }

    fn image_path(handle: HANDLE) -> std::io::Result<PathBuf> {
        let mut buf = vec![0u16; IMAGE_PATH_UNITS];
        let mut len = u32::try_from(buf.len()).expect("缓冲长度在 u32 内");
        // SAFETY: buf 可写 len 个 UTF-16 单元，成功后 len 是写入的单元数（不含结尾 0）。
        let ok = unsafe {
            QueryFullProcessImageNameW(handle, PROCESS_NAME_WIN32, buf.as_mut_ptr(), &mut len)
        };
        if ok == 0 {
            return Err(std::io::Error::last_os_error());
        }
        buf.truncate(len as usize);
        Ok(PathBuf::from(OsString::from_wide(&buf)))
    }
}

/// 落樱只发 Windows 版；其他平台能编译，接回一律报不支持。
#[cfg(not(windows))]
mod sys {
    use std::process::ExitStatus;

    use super::{AttachedProcess, ProcessIdentity, Refusal};
    use crate::error::{LaunchError, Result};

    fn unsupported(pid: u32) -> LaunchError {
        LaunchError::Process {
            pid,
            source: std::io::Error::new(
                std::io::ErrorKind::Unsupported,
                "只在 Windows 上支持接回游戏",
            ),
        }
    }

    pub(super) fn identity_of_child(child: &tokio::process::Child) -> Result<ProcessIdentity> {
        match child.id() {
            Some(pid) => Err(unsupported(pid)),
            None => Err(LaunchError::ProcessReaped),
        }
    }

    pub(super) fn open(
        identity: &ProcessIdentity,
    ) -> Result<std::result::Result<AttachedProcess, Refusal>> {
        Err(unsupported(identity.pid))
    }

    pub(super) fn has_exited(_process: &AttachedProcess) -> std::io::Result<bool> {
        Err(std::io::Error::new(
            std::io::ErrorKind::Unsupported,
            "只在 Windows 上支持接回游戏",
        ))
    }

    pub(super) fn exit_status(_process: &AttachedProcess) -> std::io::Result<ExitStatus> {
        Err(std::io::Error::new(
            std::io::ErrorKind::Unsupported,
            "只在 Windows 上支持接回游戏",
        ))
    }

    pub(super) fn terminate(process: &AttachedProcess) -> Result<()> {
        Err(unsupported(process.identity.pid))
    }
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;
    use crate::logfile::{LATEST_LOG, LogSource, SessionOutcome, read_log_tail};
    use std::io::Write;
    use std::path::Path;

    /// 拉起一个当作游戏的进程并取它的凭据；返回的子进程句柄留着，测试结束前不回收。
    fn spawn_game(program: &str, args: &[&str]) -> (tokio::process::Child, ProcessIdentity) {
        spawn_game_in(&std::env::temp_dir(), program, args)
    }

    fn spawn_game_in(
        dir: &Path,
        program: &str,
        args: &[&str],
    ) -> (tokio::process::Child, ProcessIdentity) {
        let child = tokio::process::Command::new(program)
            .args(args)
            .current_dir(dir)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .unwrap();
        let identity = identity_of_child(&child).unwrap();
        (child, identity)
    }

    fn opened(identity: &ProcessIdentity) -> AttachedProcess {
        match open_process(identity).unwrap() {
            Ok(process) => process,
            Err(refusal) => panic!("凭据对得上的进程应能接回：{refusal}"),
        }
    }

    fn append(path: &Path, text: &str) {
        let mut file = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(path)
            .unwrap();
        file.write_all(text.as_bytes()).unwrap();
    }

    #[tokio::test]
    async fn identity_names_the_spawned_program_and_reopens_the_same_process() {
        let (mut child, identity) = spawn_game("ping", &["-n", "30", "127.0.0.1"]);
        assert_eq!(identity.pid, child.id().unwrap());
        assert!(
            identity
                .exe
                .file_name()
                .is_some_and(|name| name.eq_ignore_ascii_case("PING.EXE")),
            "{identity:?}"
        );
        assert!(identity.created > 0);
        let process = opened(&identity);
        assert_eq!(process.identity(), &identity);
        child.kill().await.unwrap();
    }

    #[tokio::test]
    async fn mismatched_creation_time_or_program_is_refused() {
        let (mut child, identity) = spawn_game("ping", &["-n", "30", "127.0.0.1"]);
        let reused = ProcessIdentity {
            created: identity.created + 1,
            ..identity.clone()
        };
        assert!(matches!(
            open_process(&reused).unwrap(),
            Err(Refusal::CreatedAt { found }) if found == identity.created
        ));
        let other_exe = ProcessIdentity {
            exe: PathBuf::from(r"C:\Program Files\Java\bin\java.exe"),
            ..identity.clone()
        };
        assert!(matches!(
            open_process(&other_exe).unwrap(),
            Err(Refusal::Exe { found }) if found == identity.exe
        ));
        child.kill().await.unwrap();
    }

    #[tokio::test]
    async fn unknown_pid_is_gone_and_an_exited_process_is_refused() {
        let missing = ProcessIdentity {
            pid: u32::MAX - 3,
            created: 1,
            exe: PathBuf::from("java.exe"),
        };
        assert!(matches!(
            open_process(&missing).unwrap(),
            Err(Refusal::Gone)
        ));

        let (_child, identity) = spawn_game("cmd", &["/C", "ping -n 2 127.0.0.1 >nul"]);
        // 先接住句柄，进程对象在它退出后还在：这时再按同一份凭据接回，认得出是它，但它已经退出。
        let held = opened(&identity);
        let deadline = std::time::Instant::now() + Duration::from_secs(10);
        while !sys::has_exited(&held).unwrap() {
            assert!(std::time::Instant::now() < deadline, "cmd 迟迟没有退出");
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        assert!(matches!(
            open_process(&identity).unwrap(),
            Err(Refusal::Exited)
        ));
    }

    /// 接回的进程不是子进程，退出码照样拿得到，非 0 照常按崩溃判定。
    #[tokio::test]
    async fn attached_session_reports_the_real_exit_code() {
        let (_child, identity) = spawn_game("cmd", &["/C", "ping -n 2 127.0.0.1 >nul & exit 3"]);
        let session = attach(
            opened(&identity),
            SessionClock::start().unwrap(),
            None,
            None,
            None,
        );
        assert_eq!(session.id(), identity.pid);
        let end = tokio::time::timeout(Duration::from_secs(20), session.wait())
            .await
            .expect("进程退出后应很快产出报告");
        assert!(end.failure.is_none(), "{:?}", end.failure);
        assert_eq!(end.report.code, Some(3));
        assert!(!end.report.terminated_by_launcher);
        assert!(crate::process::detect_crash(&end.report));
    }

    #[tokio::test]
    async fn kill_through_the_attached_session_is_a_player_kill() {
        let (_child, identity) = spawn_game("ping", &["-n", "30", "127.0.0.1"]);
        let session = attach(
            opened(&identity),
            SessionClock::start().unwrap(),
            None,
            None,
            None,
        );
        let switch = session.kill_switch();
        let waiter = tokio::spawn(session.wait());
        assert!(switch.kill().await.unwrap(), "进程还在跑，应结束成功");
        let end = tokio::time::timeout(Duration::from_secs(10), waiter)
            .await
            .expect("结束后应很快退出")
            .unwrap();
        assert!(end.report.terminated_by_launcher);
        assert_eq!(end.report.code, Some(1));
        assert!(!crate::process::detect_crash(&end.report));
        assert!(!switch.kill().await.unwrap());
    }

    /// 接回后追读游戏的日志文件：接回之前写下的不重复记；之后追加的行、连同进程退出前最后写下的那一行，
    /// 都进了会话日志、最近行与转发。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn tail_feeds_new_lines_into_the_log_recent_and_forward() {
        let tmp = tempfile::tempdir().unwrap();
        let game_log = tmp.path().join("latest.log");
        append(&game_log, "[10:00:00] [main/INFO]: 落樱关着时写下的\n");
        let logs = tmp.path().join("logs");
        let clock = SessionClock::start().unwrap();
        let log = SessionLog::create(&logs, "1.21", clock.started_at())
            .await
            .unwrap();
        // 相对路径写进工作目录：带引号的路径经参数转义后 cmd 认不出来。
        let (_child, identity) = spawn_game_in(
            tmp.path(),
            "cmd",
            &[
                "/C",
                "ping -n 3 127.0.0.1 >nul& echo [10:00:09] [Render thread/ERROR]: last words>>latest.log& exit 1",
            ],
        );
        let (fwd_tx, mut fwd_rx) = mpsc::unbounded_channel();
        let session = attach(
            opened(&identity),
            clock,
            Some(log),
            Some(game_log.clone()),
            Some(fwd_tx),
        );
        // 等追读定位到文件末尾再追加。
        tokio::time::sleep(TAIL_INTERVAL * 2).await;
        append(
            &game_log,
            "[10:00:05] [main/INFO]: 接回之后 1\n[10:00:06] [main/WARN]: 接回之后 2\n",
        );
        let end = tokio::time::timeout(Duration::from_secs(20), session.wait())
            .await
            .expect("进程退出后应很快产出报告");
        assert!(end.failure.is_none(), "{:?}", end.failure);
        assert_eq!(end.report.code, Some(1));
        let expected = [
            "[10:00:05] [main/INFO]: 接回之后 1",
            "[10:00:06] [main/WARN]: 接回之后 2",
            "[10:00:09] [Render thread/ERROR]: last words",
        ];
        assert_eq!(end.report.recent_lines, expected);

        let mut forwarded = Vec::new();
        while let Ok(batch) = fwd_rx.try_recv() {
            for line in batch {
                assert_eq!(line.stream, LogStream::LogFile);
                forwarded.push(line.text);
            }
        }
        assert_eq!(forwarded, expected);

        let path = end
            .log
            .expect("日志应保持打开交还调用方")
            .finish(clock.now(), SessionOutcome::Crashed)
            .await
            .unwrap();
        assert_eq!(path, logs.join(LATEST_LOG));
        let tail = read_log_tail(&path, 1 << 20, 100).await.unwrap();
        let texts: Vec<&str> = tail.entries.iter().map(|e| e.text.as_str()).collect();
        assert_eq!(texts, expected);
        assert!(tail.entries.iter().all(|e| e.source == LogSource::Game));
    }

    async fn collect_new(tail: &mut TailState, path: &Path) -> Vec<String> {
        let mut got = Vec::new();
        tail.read_new(path, &mut |text| got.push(text))
            .await
            .unwrap();
        got
    }

    #[tokio::test]
    async fn tail_starts_at_the_last_line_start_and_finishes_a_line_in_progress() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("latest.log");
        append(&path, "done\npart");
        let mut tail = TailState::start(&path).await.unwrap();
        assert_eq!(tail.offset, 5);
        assert_eq!(collect_new(&mut tail, &path).await, Vec::<String>::new());
        append(&path, "ial\nnext\n");
        assert_eq!(collect_new(&mut tail, &path).await, ["partial", "next"]);
    }

    #[tokio::test]
    async fn tail_drops_the_fragment_when_no_line_start_is_in_reach() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("latest.log");
        let long = "x".repeat(usize::try_from(TAIL_SEEK_BACK_BYTES).unwrap() + 10);
        append(&path, &format!("head\n{long}"));
        let mut tail = TailState::start(&path).await.unwrap();
        assert!(tail.skip_first);
        append(&path, "tail of the long line\nnext\n");
        assert_eq!(collect_new(&mut tail, &path).await, ["next"]);
    }

    #[tokio::test]
    async fn tail_reads_a_rotated_file_from_the_top() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("latest.log");
        append(&path, "old one\nold two\n");
        let mut tail = TailState::start(&path).await.unwrap();
        append(&path, "half of old");
        assert_eq!(collect_new(&mut tail, &path).await, Vec::<String>::new());
        // 跨午夜时游戏把文件滚动掉、新建一份：变短了，从头读新的，旧文件的半行不拼上去。
        std::fs::write(&path, "new day\n").unwrap();
        assert_eq!(collect_new(&mut tail, &path).await, ["new day"]);
    }

    #[tokio::test]
    async fn tail_of_a_file_not_yet_created_reads_it_from_the_top_once_it_appears() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("latest.log");
        let mut tail = TailState::start(&path).await.unwrap();
        assert_eq!(collect_new(&mut tail, &path).await, Vec::<String>::new());
        append(&path, "first\n");
        assert_eq!(collect_new(&mut tail, &path).await, ["first"]);
    }
}
