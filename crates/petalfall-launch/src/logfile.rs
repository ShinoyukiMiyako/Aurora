//! 每次启动的会话日志：`versions/<id>/<元数据目录>/logs/latest.log`，滚动保留 [`KEEP_SESSIONS`] 份。
//!
//! 日志放在实例自己的版本目录而不是工作目录：关闭隔离时多个实例共用 `.minecraft` 根这一个工作目录，
//! 放在那里会让 A 实例的诊断读到 B 实例的日志。版本目录永远一实例一份，不随隔离开关漂移。
//!
//! 文件里既有启动器自己的阶段与告警，也有游戏的全部输出，每行带相对会话开始的毫秒偏移与来源：
//!
//! ```text
//! # petalfall-launch-log 1
//! # started_at 1798000000123
//! # instance 1.20.1-fabric
//! [+0.012] [launcher] 检查 Java
//! [+3.405] [game] [19:04:12] [main/INFO]: Loading Minecraft 1.20.1
//! ```
//!
//! 偏移而不是绝对时刻：人看日志时「启动后第几秒」比墙钟时刻更有用，而绝对时刻由头部的
//! `started_at` 加偏移还原，不需要时区换算。会话结束时追加一行 `# ended <时刻> <结局>`，日志页据此
//! 写「以崩溃结束」；没有这一行说明会话还在进行，或启动器在会话中途退出了。新一次启动开始时，上一份
//! `latest.log` 改名为 `<它的 started_at>.log`，崩溃报告据 `started_at` 找回当时那一份。

use std::io;
use std::path::{Path, PathBuf};
use std::time::{Instant, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tokio::io::{AsyncReadExt, AsyncSeekExt, AsyncWriteExt, BufWriter};

use crate::error::{LaunchError, Result};
use crate::redact::redact_access_tokens;

/// 实例元数据目录下存放会话日志的子目录名。
pub const LOGS_DIR: &str = "logs";
/// 最近一次会话的日志文件名。
pub const LATEST_LOG: &str = "latest.log";
/// 连同 `latest.log` 在内保留的会话日志份数。
pub const KEEP_SESSIONS: usize = 5;

/// 写缓冲：游戏启动期每秒能吐上千行，逐行落盘的系统调用开销比日志本身还大。
const WRITE_BUFFER_BYTES: usize = 8 * 1024;
/// 文件第一行，标明格式与版本；读到别的东西说明这不是本模块写出的文件。
const HEADER_MAGIC: &str = concat!("# ", petalfall_base::app_slug!(), "-launch-log 1");
const HEADER_STARTED_AT: &str = "# started_at ";
const HEADER_INSTANCE: &str = "# instance ";
const TRAILER_ENDED: &str = "# ended ";
/// 读头部时最多读这么多字节：三行头部再长也到不了这里，读多了是白读。
const HEADER_PROBE_BYTES: usize = 4 * 1024;
/// 数行号时的分块大小。
const COUNT_CHUNK_BYTES: usize = 64 * 1024;

/// 当前 Unix 毫秒。系统时钟早于纪元说明时钟坏了，如实报错，不拿 0 冒充一个时刻。
pub fn unix_millis() -> Result<u64> {
    let elapsed = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| LaunchError::ClockBeforeEpoch)?;
    Ok(u64::try_from(elapsed.as_millis()).expect("毫秒数在 u64 范围内"))
}

/// 一次会话的时钟：开始时取一次墙钟，之后全部按单调时钟累加，免得会话中途改系统时间让日志时刻倒流。
#[derive(Debug, Clone, Copy)]
pub struct SessionClock {
    started_at: u64,
    /// `origin` 那一刻距会话开始已过的毫秒：新开的会话为 0，接回的会话是关闭前后那段墙钟时长。
    /// 记成偏移而不是把 `origin` 往前推：单调时钟往回减可能越过它的起点。
    base: u64,
    origin: Instant,
}

impl SessionClock {
    /// 以当前时刻为会话开始。
    pub fn start() -> Result<Self> {
        Ok(Self {
            started_at: unix_millis()?,
            base: 0,
            origin: Instant::now(),
        })
    }

    /// 接着一次早已开始的会话（落樱关闭前启动、重新打开后接回的游戏）。此刻以前的时长只能按墙钟算，
    /// 之后照常按单调时钟累加。墙钟被调到会话开始之前时按刚开始算，不让时刻倒流。
    pub fn resume(started_at: u64) -> Result<Self> {
        Ok(Self {
            started_at,
            base: unix_millis()?.saturating_sub(started_at),
            origin: Instant::now(),
        })
    }

    /// 会话开始的 Unix 毫秒。
    pub fn started_at(&self) -> u64 {
        self.started_at
    }

    /// 此刻的 Unix 毫秒。
    pub fn now(&self) -> u64 {
        let elapsed =
            u64::try_from(self.origin.elapsed().as_millis()).expect("会话时长在 u64 范围内");
        self.started_at + self.base + elapsed
    }
}

/// 一行日志的来源。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LogSource {
    /// 启动器自己的阶段、告警与失败。
    Launcher,
    /// 游戏进程的 stdout / stderr。
    Game,
}

/// 启动器日志行的级别。游戏行不带级别：级别由读日志的一方按文本推断，与实时日志用同一条规则。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LauncherLevel {
    Info,
    Warn,
    Error,
}

/// 级别标记总在行首的时间与线程名之后，只看这么长的开头：正文里引用的 `[ERROR]` 不该把整行染红。
const LEVEL_MARK_PROBE_BYTES: usize = 120;

/// 推断一行游戏输出的级别。游戏输出没有结构化级别，按 log4j 布局里的标记认（`[main/WARN]`、
/// `[Render thread/ERROR]`），兼顾不走 log4j 的 `[WARN]` 写法与 JVM 直接打出的未捕获异常；
/// 认不出的一律算 info。
pub fn game_line_level(text: &str) -> LauncherLevel {
    const ERROR_MARKS: &[&str] = &["/ERROR]", "/FATAL]", "[ERROR]", "[FATAL]"];
    const WARN_MARKS: &[&str] = &["/WARN]", "[WARN]"];
    let head = &text[..text.floor_char_boundary(LEVEL_MARK_PROBE_BYTES)];
    if ERROR_MARKS.iter().any(|mark| head.contains(mark))
        || text.starts_with("Exception in thread ")
        || text.starts_with("Caused by: ")
    {
        LauncherLevel::Error
    } else if WARN_MARKS.iter().any(|mark| head.contains(mark)) {
        LauncherLevel::Warn
    } else {
        LauncherLevel::Info
    }
}

/// 一次会话怎么结束的。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SessionOutcome {
    /// 游戏自己正常退出。
    Exited,
    /// 游戏异常退出。
    Crashed,
    /// 玩家结束了游戏。
    Killed,
    /// 没进到游戏就失败了。
    Failed,
    /// 玩家取消了启动。
    Cancelled,
}

impl SessionOutcome {
    fn as_str(self) -> &'static str {
        match self {
            SessionOutcome::Exited => "exited",
            SessionOutcome::Crashed => "crashed",
            SessionOutcome::Killed => "killed",
            SessionOutcome::Failed => "failed",
            SessionOutcome::Cancelled => "cancelled",
        }
    }

    fn parse(text: &str) -> Option<Self> {
        [
            SessionOutcome::Exited,
            SessionOutcome::Crashed,
            SessionOutcome::Killed,
            SessionOutcome::Failed,
            SessionOutcome::Cancelled,
        ]
        .into_iter()
        .find(|outcome| outcome.as_str() == text)
    }
}

/// 会话日志末尾记下的结局。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct SessionEnded {
    pub at: u64,
    pub outcome: SessionOutcome,
}

/// 读回的一行日志。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct LogEntry {
    /// 这一行写入时的 Unix 毫秒。
    pub at: u64,
    pub source: LogSource,
    /// 只有启动器行有级别。
    pub level: Option<LauncherLevel>,
    pub text: String,
}

impl LogEntry {
    /// 展示用的级别：启动器行用记下的级别，游戏行按 [`game_line_level`] 推断。
    pub fn display_level(&self) -> LauncherLevel {
        self.level.unwrap_or_else(|| game_line_level(&self.text))
    }
}

/// 某实例会话日志所在目录：`<版本目录>/<元数据目录>/logs`。
pub fn logs_dir(version_dir: &Path) -> PathBuf {
    version_dir
        .join(petalfall_instance::PETALFALL_META_DIR)
        .join(LOGS_DIR)
}

/// 正在写的会话日志。
pub struct SessionLog {
    writer: BufWriter<tokio::fs::File>,
    path: PathBuf,
    started_at: u64,
    lines: u64,
}

impl SessionLog {
    /// 开一份新的会话日志：先把上一份 `latest.log` 改名归档、淘汰超出保留数的旧日志，再写头部。
    ///
    /// 「产生一份」与「淘汰一份」放在同一处，日志目录才不会只增不删。
    pub async fn create(logs_dir: &Path, instance_id: &str, started_at: u64) -> Result<Self> {
        tokio::fs::create_dir_all(logs_dir)
            .await
            .map_err(|source| io_error(logs_dir, source))?;
        let latest = logs_dir.join(LATEST_LOG);
        archive_latest(&latest, logs_dir).await?;
        prune_archives(logs_dir, KEEP_SESSIONS - 1).await?;

        let file = tokio::fs::File::create(&latest)
            .await
            .map_err(|source| io_error(&latest, source))?;
        let mut log = Self {
            writer: BufWriter::with_capacity(WRITE_BUFFER_BYTES, file),
            path: latest,
            started_at,
            lines: 0,
        };
        let header = format!(
            "{HEADER_MAGIC}\n{HEADER_STARTED_AT}{started_at}\n{HEADER_INSTANCE}{instance_id}\n"
        );
        log.write_raw(header.as_bytes()).await?;
        // 头部立刻落盘：会话进行中崩溃页、日志页就会来读这份文件，头部还在缓冲里时它看起来是一份坏日志。
        log.writer
            .flush()
            .await
            .map_err(|source| io_error(&log.path, source))?;
        Ok(log)
    }

    /// 文件路径（会话进行中恒为 `latest.log`）。
    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn started_at(&self) -> u64 {
        self.started_at
    }

    /// 已写入的日志行数（不含头部）。
    pub fn lines(&self) -> u64 {
        self.lines
    }

    /// 追加一行。`at` 早于会话开始（调用方时钟错用）按 0 偏移写，不让一行日志毁掉整份文件。
    pub async fn write(
        &mut self,
        at: u64,
        source: LogSource,
        level: Option<LauncherLevel>,
        text: &str,
    ) -> Result<()> {
        let line = encode_line(at.saturating_sub(self.started_at), source, level, text);
        self.write_raw(line.as_bytes()).await?;
        self.lines += 1;
        Ok(())
    }

    /// 把写缓冲落盘，文件保持打开。
    pub async fn flush(&mut self) -> Result<()> {
        self.writer
            .flush()
            .await
            .map_err(|source| io_error(&self.path, source))
    }

    /// 接着一份进行中的会话日志写：落樱在游戏运行中关闭、重新打开后接回那一局时用。返回日志与截掉的
    /// 字节数。
    ///
    /// 头部的 `started_at` 要对得上，日志也不能已经写下结局，否则说明这不是那一局还开着的日志。落樱被强行
    /// 结束时写缓冲只落了一部分，文件常停在某行中间：这半行截掉再续写，否则它会和续写的第一行粘成一行，
    /// 读回时整份日志都报格式错误。
    pub async fn reopen(path: &Path, started_at: u64) -> Result<(Self, u64)> {
        let header = read_header(path)
            .await?
            .ok_or_else(|| io_error(path, io::Error::from(io::ErrorKind::NotFound)))?;
        if header.started_at != started_at {
            return Err(LaunchError::LogNotResumable {
                path: path.to_owned(),
                reason: format!(
                    "头部记的会话开始于 {}，不是要接回的 {started_at}",
                    header.started_at
                ),
            });
        }
        let mut file = tokio::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .open(path)
            .await
            .map_err(|source| io_error(path, source))?;
        let len = file
            .metadata()
            .await
            .map_err(|source| io_error(path, source))?
            .len();
        let body_start = header.len as u64;
        file.seek(io::SeekFrom::Start(body_start))
            .await
            .map_err(|source| io_error(path, source))?;
        // 数完整的行，同时记下最后一个完整行的起点与终点：半行从终点截掉，结局行在最后一个完整行里。
        let mut lines = 0u64;
        let mut line_start = body_start;
        let mut last_line_start = body_start;
        let mut complete_end = body_start;
        let mut pos = body_start;
        let mut chunk = vec![0u8; COUNT_CHUNK_BYTES];
        loop {
            let n = file
                .read(&mut chunk)
                .await
                .map_err(|source| io_error(path, source))?;
            if n == 0 {
                break;
            }
            for (index, byte) in chunk[..n].iter().enumerate() {
                if *byte == b'\n' {
                    lines += 1;
                    last_line_start = line_start;
                    complete_end = pos + index as u64 + 1;
                    line_start = complete_end;
                }
            }
            pos += n as u64;
        }
        if complete_end > last_line_start {
            let probe =
                usize::try_from((complete_end - last_line_start).min(HEADER_PROBE_BYTES as u64))
                    .expect("探测长度在 usize 内");
            let mut last = vec![0u8; probe];
            file.seek(io::SeekFrom::Start(last_line_start))
                .await
                .map_err(|source| io_error(path, source))?;
            file.read_exact(&mut last)
                .await
                .map_err(|source| io_error(path, source))?;
            if last.starts_with(TRAILER_ENDED.as_bytes()) {
                return Err(LaunchError::LogNotResumable {
                    path: path.to_owned(),
                    reason: "这一局已经写下了结局".to_owned(),
                });
            }
        }
        let dropped = len - complete_end;
        if dropped > 0 {
            file.set_len(complete_end)
                .await
                .map_err(|source| io_error(path, source))?;
            tracing::warn!(path = %path.display(), dropped, "会话日志末尾有没写完的半行，截掉后续写");
        }
        file.seek(io::SeekFrom::End(0))
            .await
            .map_err(|source| io_error(path, source))?;
        Ok((
            Self {
                writer: BufWriter::with_capacity(WRITE_BUFFER_BYTES, file),
                path: path.to_owned(),
                started_at,
                lines,
            },
            dropped,
        ))
    }

    /// 写下结局，把缓冲落盘并关闭文件。会话结束时必须调用：缓冲里可能正是崩溃前最后那几行。
    pub async fn finish(mut self, at: u64, outcome: SessionOutcome) -> Result<PathBuf> {
        let trailer = format!("{TRAILER_ENDED}{at} {}\n", outcome.as_str());
        self.write_raw(trailer.as_bytes()).await?;
        self.writer
            .flush()
            .await
            .map_err(|source| io_error(&self.path, source))?;
        Ok(self.path)
    }

    async fn write_raw(&mut self, bytes: &[u8]) -> Result<()> {
        self.writer
            .write_all(bytes)
            .await
            .map_err(|source| io_error(&self.path, source))
    }
}

/// 把一行编码成文件格式。文本里的换行会破坏「一行一条」的约定，统一换成空格。
fn encode_line(
    offset_ms: u64,
    source: LogSource,
    level: Option<LauncherLevel>,
    text: &str,
) -> String {
    let tag = match (source, level) {
        (LogSource::Game, _) => "game",
        (LogSource::Launcher, None | Some(LauncherLevel::Info)) => "launcher",
        (LogSource::Launcher, Some(LauncherLevel::Warn)) => "launcher/warn",
        (LogSource::Launcher, Some(LauncherLevel::Error)) => "launcher/error",
    };
    let text = text.replace(['\r', '\n'], " ");
    format!(
        "[+{}.{:03}] [{tag}] {text}\n",
        offset_ms / 1000,
        offset_ms % 1000
    )
}

/// 解析一行日志；格式不对返回 `None`，由调用方决定怎么报。
fn decode_line(line: &str, started_at: u64) -> Option<LogEntry> {
    let rest = line.strip_prefix("[+")?;
    let (offset, rest) = rest.split_once("] [")?;
    let (secs, millis) = offset.split_once('.')?;
    if millis.len() != 3 {
        return None;
    }
    let offset_ms = secs.parse::<u64>().ok()? * 1000 + millis.parse::<u64>().ok()?;
    let (tag, text) = match rest.split_once("] ") {
        Some(pair) => pair,
        None => (rest.strip_suffix(']')?, ""),
    };
    let (source, level) = match tag {
        "game" => (LogSource::Game, None),
        "launcher" => (LogSource::Launcher, Some(LauncherLevel::Info)),
        "launcher/warn" => (LogSource::Launcher, Some(LauncherLevel::Warn)),
        "launcher/error" => (LogSource::Launcher, Some(LauncherLevel::Error)),
        _ => return None,
    };
    Some(LogEntry {
        at: started_at + offset_ms,
        source,
        level,
        text: text.to_owned(),
    })
}

/// 头部里的会话信息。
#[derive(Debug, Clone, PartialEq, Eq)]
struct Header {
    started_at: u64,
    /// 头部本身占的字节数，正文从这里开始。
    len: usize,
}

/// 读文件头部；文件不存在返回 `None`，头部不合格式报 [`LaunchError::LogFormat`]。
async fn read_header(path: &Path) -> Result<Option<Header>> {
    let mut file = match tokio::fs::File::open(path).await {
        Ok(file) => file,
        Err(err) if err.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(source) => return Err(io_error(path, source)),
    };
    let mut buf = vec![0u8; HEADER_PROBE_BYTES];
    let mut filled = 0;
    while filled < buf.len() {
        let n = file
            .read(&mut buf[filled..])
            .await
            .map_err(|source| io_error(path, source))?;
        if n == 0 {
            break;
        }
        filled += n;
    }
    parse_header(&buf[..filled])
        .map(Some)
        .ok_or_else(|| LaunchError::LogFormat {
            path: path.to_owned(),
            line: 0,
        })
}

fn parse_header(bytes: &[u8]) -> Option<Header> {
    let text = String::from_utf8_lossy(bytes);
    let mut len = 0;
    let mut lines = text.split_inclusive('\n');
    let magic = lines.next()?;
    if magic.trim_end() != HEADER_MAGIC {
        return None;
    }
    len += magic.len();
    let started = lines.next()?;
    let started_at = started
        .trim_end()
        .strip_prefix(HEADER_STARTED_AT)?
        .parse::<u64>()
        .ok()?;
    len += started.len();
    let instance = lines.next()?;
    if !instance.starts_with(HEADER_INSTANCE) || !instance.ends_with('\n') {
        return None;
    }
    len += instance.len();
    Some(Header { started_at, len })
}

/// 把上一份 `latest.log` 改名为 `<started_at>.log`。
///
/// 头部读不出来（上次写到一半断电、或文件被人改过）时按修改时刻命名：这份日志反正已经对不上任何
/// 崩溃报告了，但它仍是现场，不能因为头部坏了就删掉或挡住这次启动。
async fn archive_latest(latest: &Path, logs_dir: &Path) -> Result<()> {
    let started_at = match read_header(latest).await {
        Ok(None) => return Ok(()),
        Ok(Some(header)) => header.started_at,
        Err(LaunchError::LogFormat { .. }) => {
            let modified = tokio::fs::metadata(latest)
                .await
                .and_then(|meta| meta.modified())
                .map_err(|source| io_error(latest, source))?;
            let elapsed = modified
                .duration_since(UNIX_EPOCH)
                .map_err(|_| LaunchError::ClockBeforeEpoch)?;
            tracing::warn!(path = %latest.display(), "上一份会话日志头部不合格式，按修改时刻归档");
            u64::try_from(elapsed.as_millis()).expect("毫秒数在 u64 范围内")
        }
        Err(other) => return Err(other),
    };
    let target = logs_dir.join(format!("{started_at}.log"));
    tokio::fs::rename(latest, &target)
        .await
        .map_err(|source| io_error(&target, source))
}

/// 只保留最新的 `keep` 份归档（不含 `latest.log`）。只认 `<数字>.log`，别的文件不是本模块写的，不碰。
async fn prune_archives(logs_dir: &Path, keep: usize) -> Result<()> {
    let mut archives = list_archives(logs_dir).await?;
    archives.sort_unstable_by_key(|(started_at, _)| std::cmp::Reverse(*started_at));
    for (_, path) in archives.into_iter().skip(keep) {
        tokio::fs::remove_file(&path)
            .await
            .map_err(|source| io_error(&path, source))?;
    }
    Ok(())
}

async fn list_archives(logs_dir: &Path) -> Result<Vec<(u64, PathBuf)>> {
    let mut read = match tokio::fs::read_dir(logs_dir).await {
        Ok(read) => read,
        Err(err) if err.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(source) => return Err(io_error(logs_dir, source)),
    };
    let mut out = Vec::new();
    while let Some(entry) = read
        .next_entry()
        .await
        .map_err(|source| io_error(logs_dir, source))?
    {
        let name = entry.file_name();
        let Some(stem) = name.to_str().and_then(|n| n.strip_suffix(".log")) else {
            continue;
        };
        if let Ok(started_at) = stem.parse::<u64>() {
            out.push((started_at, entry.path()));
        }
    }
    Ok(out)
}

/// 找回某次会话的日志文件：还是 `latest.log` 就返回它，已归档则返回 `<started_at>.log`，
/// 已被淘汰返回 `None`。
pub async fn session_log_path(logs_dir: &Path, started_at: u64) -> Result<Option<PathBuf>> {
    let latest = logs_dir.join(LATEST_LOG);
    match read_header(&latest).await {
        Ok(Some(header)) if header.started_at == started_at => return Ok(Some(latest)),
        // 头部不合格式的 latest 认不出是哪一次会话，自然不是要找的那份；它在下次启动时按修改时刻归档。
        Ok(_) | Err(LaunchError::LogFormat { .. }) => {}
        Err(other) => return Err(other),
    }
    let archived = logs_dir.join(format!("{started_at}.log"));
    match tokio::fs::try_exists(&archived).await {
        Ok(true) => Ok(Some(archived)),
        Ok(false) => Ok(None),
        Err(source) => Err(io_error(&archived, source)),
    }
}

/// 读回的会话日志尾部。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LogTail {
    pub path: PathBuf,
    pub started_at: u64,
    /// 尾部的日志行，按文件顺序。
    pub entries: Vec<LogEntry>,
    /// `entries[0]` 在整份日志里的行号（从 1 起，不计头部）。
    pub first_line: u64,
    /// 整份日志的行数。
    pub total_lines: u64,
    /// 会话结局；会话还在进行或中途中断时为 `None`。
    pub ended: Option<SessionEnded>,
}

impl LogTail {
    /// 尾部之前被省略的行数。
    pub fn omitted(&self) -> u64 {
        self.first_line - 1
    }
}

/// 读会话日志的尾部：最多读末尾 `max_bytes` 字节、保留最后 `max_lines` 行。
///
/// 一份大整合包的会话日志能到几十 MB，而诊断与日志页都只关心最后那段。被截断处的半截行与文件末尾
/// 还没写完的半行都丢弃；截断点之前的行只数换行、不解析，用来给出准确的行号与「较早的 N 行已省略」。
///
/// 读出的每行都遮掉访问令牌：游戏输出写入前已经遮过，旧版本写下的日志却没有，日志页与诊断都从这里读。
pub async fn read_log_tail(path: &Path, max_bytes: u64, max_lines: usize) -> Result<LogTail> {
    let header = read_header(path)
        .await?
        .ok_or_else(|| LaunchError::LogFormat {
            path: path.to_owned(),
            line: 0,
        })?;
    let mut file = tokio::fs::File::open(path)
        .await
        .map_err(|source| io_error(path, source))?;
    let len = file
        .metadata()
        .await
        .map_err(|source| io_error(path, source))?
        .len();
    let body_start = header.len as u64;
    let tail_start = len.saturating_sub(max_bytes).max(body_start);

    // 截断点之前的行数。截断点正好落在行首时（前一字节是换行）没有半截行可丢。
    let mut skipped = 0u64;
    let mut cut_mid_line = false;
    if tail_start > body_start {
        file.seek(io::SeekFrom::Start(body_start))
            .await
            .map_err(|source| io_error(path, source))?;
        let mut remaining = tail_start - body_start;
        let mut chunk = vec![0u8; COUNT_CHUNK_BYTES];
        let mut last = b'\n';
        while remaining > 0 {
            let want = usize::try_from(remaining.min(COUNT_CHUNK_BYTES as u64))
                .expect("块大小在 usize 内");
            file.read_exact(&mut chunk[..want])
                .await
                .map_err(|source| io_error(path, source))?;
            skipped += chunk[..want].iter().filter(|b| **b == b'\n').count() as u64;
            last = chunk[want - 1];
            remaining -= want as u64;
        }
        cut_mid_line = last != b'\n';
    }

    file.seek(io::SeekFrom::Start(tail_start))
        .await
        .map_err(|source| io_error(path, source))?;
    let mut bytes =
        Vec::with_capacity(usize::try_from(len - tail_start).expect("尾部大小在 usize 内"));
    file.read_to_end(&mut bytes)
        .await
        .map_err(|source| io_error(path, source))?;
    // 截断点的半截行可能切开一个多字节字符，有损解码只影响被丢弃的那一行。
    let text = String::from_utf8_lossy(&bytes);
    let mut raw_lines: Vec<&str> = text.split('\n').collect();
    // 写出的每一行（含结局行）都以换行收尾，最后一段要么是末尾换行之后的空串，要么是还没写完的半行：
    // 会话进行中写缓冲按块落盘，文件常停在某行中间；启动器在会话中途退出也会留下这样的尾巴。
    // 半行可能连标签都没写全，按格式错误报出来会让整份日志读不出；写全了的也只是截断的正文。
    raw_lines.pop();
    let ended = match raw_lines
        .last()
        .and_then(|line| line.strip_prefix(TRAILER_ENDED))
    {
        Some(trailer) => {
            let parsed =
                trailer
                    .trim_end_matches('\r')
                    .split_once(' ')
                    .and_then(|(at, outcome)| {
                        Some(SessionEnded {
                            at: at.parse().ok()?,
                            outcome: SessionOutcome::parse(outcome)?,
                        })
                    });
            let ended = parsed.ok_or_else(|| LaunchError::LogFormat {
                path: path.to_owned(),
                line: skipped + raw_lines.len() as u64,
            })?;
            raw_lines.pop();
            Some(ended)
        }
        None => None,
    };
    let mut first_line = skipped + 1;
    if cut_mid_line && !raw_lines.is_empty() {
        raw_lines.remove(0);
        first_line += 1;
    }

    let mut entries = Vec::with_capacity(raw_lines.len().min(max_lines));
    let drop = raw_lines.len().saturating_sub(max_lines);
    for (index, raw) in raw_lines.iter().enumerate() {
        let line_no = first_line + index as u64;
        let mut entry =
            decode_line(raw.trim_end_matches('\r'), header.started_at).ok_or_else(|| {
                LaunchError::LogFormat {
                    path: path.to_owned(),
                    line: line_no,
                }
            })?;
        if index >= drop {
            redact_access_tokens(&mut entry.text);
            entries.push(entry);
        }
    }
    let total_lines = first_line - 1 + raw_lines.len() as u64;
    Ok(LogTail {
        path: path.to_owned(),
        started_at: header.started_at,
        entries,
        first_line: first_line + drop as u64,
        total_lines,
        ended,
    })
}

fn io_error(path: &Path, source: io::Error) -> LaunchError {
    LaunchError::Io {
        path: path.to_owned(),
        source,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn write_session(dir: &Path, started_at: u64, lines: &[&str]) -> PathBuf {
        let mut log = SessionLog::create(dir, "1.21-fabric", started_at)
            .await
            .unwrap();
        for (index, text) in lines.iter().enumerate() {
            log.write(started_at + index as u64 * 10, LogSource::Game, None, text)
                .await
                .unwrap();
        }
        log.finish(started_at + 60_000, SessionOutcome::Exited)
            .await
            .unwrap()
    }

    #[test]
    fn line_codec_round_trips_every_source_and_level() {
        let cases = [
            (LogSource::Launcher, None, Some(LauncherLevel::Info)),
            (
                LogSource::Launcher,
                Some(LauncherLevel::Info),
                Some(LauncherLevel::Info),
            ),
            (
                LogSource::Launcher,
                Some(LauncherLevel::Warn),
                Some(LauncherLevel::Warn),
            ),
            (
                LogSource::Launcher,
                Some(LauncherLevel::Error),
                Some(LauncherLevel::Error),
            ),
            (LogSource::Game, None, None),
        ];
        for (source, level, decoded_level) in cases {
            let line = encode_line(61_005, source, level, "Loading 42 mods: [x] y");
            assert!(line.starts_with("[+61.005] ["), "{line}");
            let entry = decode_line(line.trim_end(), 1_000).unwrap();
            assert_eq!(entry.at, 62_005);
            assert_eq!(entry.source, source);
            assert_eq!(entry.level, decoded_level);
            assert_eq!(entry.text, "Loading 42 mods: [x] y");
        }
        // 文本里的换行被抹平，空文本仍可往返。
        assert_eq!(
            encode_line(0, LogSource::Game, None, "a\r\nb"),
            "[+0.000] [game] a  b\n"
        );
        assert_eq!(decode_line("[+0.000] [game] ", 5).unwrap().text, "");
        assert_eq!(decode_line("[+0.000] [game]", 5).unwrap().text, "");
        assert!(decode_line("[+0.5] [game] x", 0).is_none());
        assert!(decode_line("[+1.000] [server] x", 0).is_none());
        assert!(decode_line("plain text", 0).is_none());
    }

    #[tokio::test]
    async fn rotation_keeps_latest_plus_four_archives() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("logs");
        for started_at in 1_000..1_007u64 {
            write_session(&dir, started_at, &["x"]).await;
        }
        let mut names: Vec<String> = std::fs::read_dir(&dir)
            .unwrap()
            .map(|e| e.unwrap().file_name().into_string().unwrap())
            .collect();
        names.sort();
        // 7 次启动之后：latest 是第 7 次，归档只留最近 4 份（1002..1005 之前的被淘汰）。
        assert_eq!(
            names,
            vec!["1002.log", "1003.log", "1004.log", "1005.log", "latest.log"]
        );
        let header = read_header(&dir.join(LATEST_LOG)).await.unwrap().unwrap();
        assert_eq!(header.started_at, 1_006);
    }

    #[tokio::test]
    async fn pruning_ignores_files_it_did_not_write() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("logs");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("notes.log"), "mine").unwrap();
        std::fs::write(dir.join("readme.txt"), "mine").unwrap();
        for started_at in 1..=8u64 {
            write_session(&dir, started_at, &["x"]).await;
        }
        assert!(dir.join("notes.log").exists());
        assert!(dir.join("readme.txt").exists());
        assert_eq!(list_archives(&dir).await.unwrap().len(), KEEP_SESSIONS - 1);
    }

    #[tokio::test]
    async fn corrupt_latest_is_archived_by_mtime_instead_of_blocking() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("logs");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join(LATEST_LOG), "not a session log\n").unwrap();
        write_session(&dir, 9_999_999_999_999, &["x"]).await;
        let archives = list_archives(&dir).await.unwrap();
        assert_eq!(archives.len(), 1);
        let content = std::fs::read_to_string(&archives[0].1).unwrap();
        assert_eq!(content, "not a session log\n", "坏头部的日志原样保留");
    }

    #[tokio::test]
    async fn session_log_path_follows_rotation() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("logs");
        write_session(&dir, 500, &["first"]).await;
        assert_eq!(
            session_log_path(&dir, 500).await.unwrap(),
            Some(dir.join(LATEST_LOG))
        );
        write_session(&dir, 600, &["second"]).await;
        assert_eq!(
            session_log_path(&dir, 500).await.unwrap(),
            Some(dir.join("500.log"))
        );
        assert_eq!(session_log_path(&dir, 400).await.unwrap(), None);
    }

    #[test]
    fn game_line_level_reads_log4j_marks_near_the_start_only() {
        let cases = [
            (
                "[19:32:11] [main/INFO]: Loading Minecraft 1.20.1",
                LauncherLevel::Info,
            ),
            (
                "[19:32:12] [main/WARN]: Mod sodium uses a deprecated API",
                LauncherLevel::Warn,
            ),
            (
                "[19:32:12] [Render thread/ERROR]: Reported exception",
                LauncherLevel::Error,
            ),
            (
                "[19:32:12] [main/FATAL]: Unrecoverable",
                LauncherLevel::Error,
            ),
            ("[WARN] Using incorrect mappings", LauncherLevel::Warn),
            (
                "Exception in thread \"main\" java.lang.RuntimeException",
                LauncherLevel::Error,
            ),
            (
                "Caused by: java.lang.NoClassDefFoundError: x",
                LauncherLevel::Error,
            ),
            (
                "	at net.minecraft.client.main.Main.main(Main.java:10)",
                LauncherLevel::Info,
            ),
            ("", LauncherLevel::Info),
        ];
        for (text, level) in cases {
            assert_eq!(game_line_level(text), level, "{text}");
        }
        // 标记出现在长正文深处：不是这一行自己的级别。
        let quoted = format!("[19:32:12] [main/INFO]: {} [ERROR] quoted", "x".repeat(200));
        assert_eq!(game_line_level(&quoted), LauncherLevel::Info);
        // 探测边界落在多字节字符中间也不能越界。
        let wide = "日".repeat(60);
        assert_eq!(game_line_level(&wide), LauncherLevel::Info);

        let game = LogEntry {
            at: 0,
            source: LogSource::Game,
            level: None,
            text: "[main/WARN]: x".into(),
        };
        assert_eq!(game.display_level(), LauncherLevel::Warn);
        let launcher = LogEntry {
            at: 0,
            source: LogSource::Launcher,
            level: Some(LauncherLevel::Error),
            text: "[main/WARN]: x".into(),
        };
        assert_eq!(launcher.display_level(), LauncherLevel::Error);
    }

    #[tokio::test]
    async fn running_session_is_identifiable_before_anything_is_flushed() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("logs");
        write_session(&dir, 500, &["first"]).await;
        // 新会话开着、一行都还没落盘：它的头部已经可读，上一份已归档。
        let _running = SessionLog::create(&dir, "1.21", 700).await.unwrap();
        assert_eq!(
            session_log_path(&dir, 700).await.unwrap(),
            Some(dir.join(LATEST_LOG))
        );
        assert_eq!(
            session_log_path(&dir, 500).await.unwrap(),
            Some(dir.join("500.log"))
        );
    }

    #[tokio::test]
    async fn corrupt_latest_does_not_hide_archived_sessions() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("logs");
        write_session(&dir, 500, &["first"]).await;
        write_session(&dir, 600, &["second"]).await;
        std::fs::write(dir.join(LATEST_LOG), "").unwrap();
        assert_eq!(session_log_path(&dir, 600).await.unwrap(), None);
        assert_eq!(
            session_log_path(&dir, 500).await.unwrap(),
            Some(dir.join("500.log"))
        );
    }

    #[tokio::test]
    async fn tail_reads_whole_small_log_with_absolute_times() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("logs");
        let mut log = SessionLog::create(&dir, "1.21", 10_000).await.unwrap();
        log.write(
            10_050,
            LogSource::Launcher,
            Some(LauncherLevel::Warn),
            "游戏路径含中文",
        )
        .await
        .unwrap();
        log.write(
            11_234,
            LogSource::Game,
            None,
            "[main/INFO]: Setting user: Steve",
        )
        .await
        .unwrap();
        assert_eq!(log.lines(), 2);
        let path = log.finish(70_000, SessionOutcome::Crashed).await.unwrap();

        let tail = read_log_tail(&path, 1 << 20, 100).await.unwrap();
        assert_eq!(tail.started_at, 10_000);
        assert_eq!(tail.first_line, 1);
        assert_eq!(tail.total_lines, 2);
        assert_eq!(tail.omitted(), 0);
        assert_eq!(
            tail.ended,
            Some(SessionEnded {
                at: 70_000,
                outcome: SessionOutcome::Crashed,
            })
        );
        assert_eq!(
            tail.entries,
            vec![
                LogEntry {
                    at: 10_050,
                    source: LogSource::Launcher,
                    level: Some(LauncherLevel::Warn),
                    text: "游戏路径含中文".into(),
                },
                LogEntry {
                    at: 11_234,
                    source: LogSource::Game,
                    level: None,
                    text: "[main/INFO]: Setting user: Steve".into(),
                },
            ]
        );
    }

    /// 旧版本写日志前不遮令牌（`SessionLog::write` 本身不遮，遮挡在游戏输出的读取任务里）：这样的日志读出来令牌也要遮掉，
    /// 同一行的其余内容与别的行照旧。
    #[tokio::test]
    async fn tail_hides_tokens_left_in_logs_written_before_redaction() {
        const TOKEN: &str =
            "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJvbGQtbG9nIn0.b2xkLWJ1aWxkLWZha2Utc2lnbmF0dXJl";
        const UUID: &str = "0123456789abcdef0123456789abcdef";
        let tmp = tempfile::tempdir().unwrap();
        let session = format!("[Client thread/INFO]: (Session ID is token:{TOKEN}:{UUID})");
        let args = format!("--username Steve --uuid {UUID} --accessToken {TOKEN}");
        let path = write_session(
            &tmp.path().join("logs"),
            0,
            &["[Client thread/INFO]: Setting user: Steve", &session, &args],
        )
        .await;
        assert!(std::fs::read_to_string(&path).unwrap().contains(TOKEN));

        let tail = read_log_tail(&path, 1 << 20, 100).await.unwrap();
        let got: Vec<&str> = tail.entries.iter().map(|e| e.text.as_str()).collect();
        assert_eq!(
            got,
            vec![
                "[Client thread/INFO]: Setting user: Steve".to_owned(),
                format!("[Client thread/INFO]: (Session ID is token:<已隐藏>:{UUID})"),
                format!("--username Steve --uuid {UUID} --accessToken <已隐藏>"),
            ]
        );
    }

    #[tokio::test]
    async fn tail_drops_cut_line_and_numbers_lines_from_file_start() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("logs");
        let texts: Vec<String> = (1..=300).map(|i| format!("line {i:04} 中文")).collect();
        let refs: Vec<&str> = texts.iter().map(String::as_str).collect();
        let path = write_session(&dir, 0, &refs).await;

        // 只读末尾 1000 字节：截断点在某行中间，那半行丢弃，行号仍按整份文件计。
        let tail = read_log_tail(&path, 1000, 10_000).await.unwrap();
        assert_eq!(tail.total_lines, 300);
        let last = tail.entries.last().unwrap();
        assert_eq!(last.text, "line 0300 中文");
        let first_no = tail.first_line;
        let expected_first = format!("line {first_no:04} 中文");
        assert_eq!(tail.entries[0].text, expected_first);
        assert_eq!(tail.first_line + tail.entries.len() as u64 - 1, 300);
        assert!(tail.omitted() > 0);

        // 行数上限比字节上限更紧时只留最后几行。
        let tail = read_log_tail(&path, 1 << 20, 3).await.unwrap();
        assert_eq!(tail.first_line, 298);
        assert_eq!(tail.omitted(), 297);
        let got: Vec<&str> = tail.entries.iter().map(|e| e.text.as_str()).collect();
        assert_eq!(
            got,
            vec!["line 0298 中文", "line 0299 中文", "line 0300 中文"]
        );
    }

    #[tokio::test]
    async fn unfinished_session_has_no_outcome() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("logs");
        let mut log = SessionLog::create(&dir, "1.21", 0).await.unwrap();
        log.write(5, LogSource::Game, None, "still running")
            .await
            .unwrap();
        // 不调 finish：模拟会话进行中被读取（这里手动落盘以便读到）。
        log.writer.flush().await.unwrap();
        let tail = read_log_tail(&dir.join(LATEST_LOG), 1 << 20, 10)
            .await
            .unwrap();
        assert_eq!(tail.ended, None);
        assert_eq!(tail.entries.len(), 1);
    }

    /// 写缓冲按块落盘，会话进行中（或启动器在会话中途退出后）文件末尾常停在某一行的半截。
    /// 读尾部时这半行不能让整份日志读不出来：已经完整落盘的行照常给出，行数不算半截行。
    #[tokio::test]
    async fn torn_last_line_of_a_running_session_is_dropped() {
        for torn in [
            "[+3",
            "[+3.405] [ga",
            "# end",
            "[+3.405] [game] [19:04:12] [main/IN",
        ] {
            let tmp = tempfile::tempdir().unwrap();
            let dir = tmp.path().join("logs");
            let mut log = SessionLog::create(&dir, "1.21", 0).await.unwrap();
            log.write(5, LogSource::Game, None, "first").await.unwrap();
            log.write(9, LogSource::Game, None, "second").await.unwrap();
            log.writer.flush().await.unwrap();
            let path = dir.join(LATEST_LOG);
            let mut content = std::fs::read(&path).unwrap();
            content.extend_from_slice(torn.as_bytes());
            std::fs::write(&path, content).unwrap();

            let tail = read_log_tail(&path, 1 << 20, 10)
                .await
                .unwrap_or_else(|err| panic!("{torn:?}: {err:?}"));
            let texts: Vec<&str> = tail.entries.iter().map(|e| e.text.as_str()).collect();
            assert_eq!(texts, vec!["first", "second"], "{torn:?}");
            assert_eq!(tail.total_lines, 2, "{torn:?}");
            assert_eq!(tail.ended, None, "{torn:?}");
        }
    }

    /// 只读末尾一段时截断点与半截尾行同在：两头都丢，中间完整的行照常给出。
    #[tokio::test]
    async fn torn_last_line_is_dropped_together_with_the_cut_first_line() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("logs");
        let mut log = SessionLog::create(&dir, "1.21", 0).await.unwrap();
        for i in 1..=50 {
            log.write(i, LogSource::Game, None, &format!("line {i:03}"))
                .await
                .unwrap();
        }
        log.writer.flush().await.unwrap();
        let path = dir.join(LATEST_LOG);
        let mut content = std::fs::read(&path).unwrap();
        content.extend_from_slice(b"[+0.051] [ga");
        std::fs::write(&path, content).unwrap();

        let tail = read_log_tail(&path, 200, 1_000).await.unwrap();
        assert_eq!(tail.entries.last().unwrap().text, "line 050");
        assert_eq!(tail.total_lines, 50);
        assert_eq!(tail.first_line + tail.entries.len() as u64 - 1, 50);
        assert_eq!(tail.entries[0].text, format!("line {:03}", tail.first_line));
    }

    #[tokio::test]
    async fn every_outcome_round_trips_through_the_trailer() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("logs");
        for (index, outcome) in [
            SessionOutcome::Exited,
            SessionOutcome::Crashed,
            SessionOutcome::Killed,
            SessionOutcome::Failed,
            SessionOutcome::Cancelled,
        ]
        .into_iter()
        .enumerate()
        {
            let log = SessionLog::create(&dir, "x", index as u64).await.unwrap();
            let path = log.finish(99, outcome).await.unwrap();
            let tail = read_log_tail(&path, 1 << 20, 10).await.unwrap();
            assert_eq!(tail.ended, Some(SessionEnded { at: 99, outcome }));
            assert_eq!(tail.total_lines, 0);
        }
    }

    #[tokio::test]
    async fn tail_of_log_with_no_lines_is_empty() {
        let tmp = tempfile::tempdir().unwrap();
        let path = write_session(&tmp.path().join("logs"), 7, &[]).await;
        let tail = read_log_tail(&path, 1 << 20, 10).await.unwrap();
        assert!(tail.entries.is_empty());
        assert_eq!(tail.total_lines, 0);
        assert_eq!(tail.first_line, 1);
    }

    #[tokio::test]
    async fn malformed_body_line_is_reported_with_its_number() {
        let tmp = tempfile::tempdir().unwrap();
        let path = write_session(&tmp.path().join("logs"), 7, &["ok"]).await;
        let mut content = std::fs::read_to_string(&path).unwrap();
        content.push_str("garbage\n");
        std::fs::write(&path, content).unwrap();
        let err = read_log_tail(&path, 1 << 20, 10).await.unwrap_err();
        assert!(
            matches!(&err, LaunchError::LogFormat { line, .. } if *line == 2),
            "{err:?}"
        );
    }

    #[test]
    fn session_clock_counts_forward_from_start() {
        let clock = SessionClock::start().unwrap();
        assert!(clock.started_at() > 1_700_000_000_000);
        assert!(clock.now() >= clock.started_at());
    }

    /// 接回的会话：开始时刻照旧，此刻按墙钟接上关闭期间的那段。
    #[test]
    fn resumed_clock_keeps_the_start_and_counts_the_gap() {
        let started_at = unix_millis().unwrap() - 90_000;
        let clock = SessionClock::resume(started_at).unwrap();
        assert_eq!(clock.started_at(), started_at);
        let elapsed = clock.now() - started_at;
        assert!((90_000..95_000).contains(&elapsed), "{elapsed}");
        // 墙钟早于会话开始时不倒流。
        let future = unix_millis().unwrap() + 60_000;
        let clock = SessionClock::resume(future).unwrap();
        assert!(clock.now() >= future);
    }

    /// 落樱在会话中途被强行结束：写缓冲只落了一部分，末尾停在半行。续写截掉半行再接着写，读回时行号连续、
    /// 结局照常。
    #[tokio::test]
    async fn reopen_drops_the_half_line_and_continues_the_same_session() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("logs");
        let mut log = SessionLog::create(&dir, "1.21", 1_000).await.unwrap();
        log.write(1_010, LogSource::Game, None, "first")
            .await
            .unwrap();
        log.write(1_020, LogSource::Game, None, "second")
            .await
            .unwrap();
        log.flush().await.unwrap();
        let path = log.path().to_owned();
        drop(log);
        let half = "[+0.030] [game] thi";
        let mut content = std::fs::read(&path).unwrap();
        content.extend_from_slice(half.as_bytes());
        std::fs::write(&path, content).unwrap();

        let (mut log, dropped) = SessionLog::reopen(&path, 1_000).await.unwrap();
        assert_eq!(dropped, half.len() as u64);
        assert_eq!(log.lines(), 2);
        log.write(
            5_000,
            LogSource::Launcher,
            Some(LauncherLevel::Info),
            "接回",
        )
        .await
        .unwrap();
        log.write(5_010, LogSource::Game, None, "third")
            .await
            .unwrap();
        let path = log.finish(6_000, SessionOutcome::Exited).await.unwrap();

        let tail = read_log_tail(&path, 1 << 20, 100).await.unwrap();
        let texts: Vec<&str> = tail.entries.iter().map(|e| e.text.as_str()).collect();
        assert_eq!(texts, ["first", "second", "接回", "third"]);
        assert_eq!(tail.total_lines, 4);
        assert_eq!(tail.entries[3].at, 5_010);
        assert_eq!(
            tail.ended,
            Some(SessionEnded {
                at: 6_000,
                outcome: SessionOutcome::Exited
            })
        );
    }

    #[tokio::test]
    async fn reopen_refuses_another_session_or_one_that_has_ended() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("logs");
        let mut log = SessionLog::create(&dir, "1.21", 1_000).await.unwrap();
        log.flush().await.unwrap();
        let path = log.path().to_owned();
        drop(log);
        let err = SessionLog::reopen(&path, 2_000)
            .await
            .err()
            .expect("别的会话应拒绝续写");
        assert!(
            matches!(&err, LaunchError::LogNotResumable { .. }),
            "{err:?}"
        );
        // 没写过正文的日志可以续写，行数为 0。
        let (log, dropped) = SessionLog::reopen(&path, 1_000).await.unwrap();
        assert_eq!((log.lines(), dropped), (0, 0));
        log.finish(3_000, SessionOutcome::Killed).await.unwrap();
        let err = SessionLog::reopen(&path, 1_000)
            .await
            .err()
            .expect("写下结局的应拒绝续写");
        assert!(
            matches!(&err, LaunchError::LogNotResumable { reason, .. } if reason.contains("结局")),
            "{err:?}"
        );
        let err = SessionLog::reopen(&dir.join("missing.log"), 1_000)
            .await
            .err()
            .expect("不存在的文件应报错");
        assert!(
            matches!(&err, LaunchError::Io { source, .. } if source.kind() == io::ErrorKind::NotFound),
            "{err:?}"
        );
    }
}
