//! 崩溃诊断与启动日志的读取。
//!
//! 规则匹配在 [`aurora_launch::analyze_lines`]。这里补门面才做得到的事：给每条线索配上整份日志里的行号
//! 与前两行上下文；把日志点名的 mod id 对到该实例 mods 目录里的具体文件（玩家没法拿一个 `sodium`
//! 字符串去停用文件）；保存每个实例最近一次的崩溃报告，并找回那一次的会话日志。
//!
//! 会话日志之外，崩溃时游戏自己写下的两份文件常常说得更清楚：JVM 死在原生代码里时写的
//! `hs_err_pid<pid>.log`（崩溃的帧、加载的 dll），以及游戏捕获异常后写进 `crash-reports/` 的崩溃报告
//! （Forge 还会在里面列出可疑的 Mod）。它们与会话日志一起参与扫描，每条线索记着来自哪份文件。
//!
//! 线索只是线索：混合加载器环境里一个 Mod 的报错常是另一个 Mod 缺失的连锁反应，所以文件名对不上时
//! 只报 mod id，不猜文件。

use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use aurora_launch::logfile::{LATEST_LOG, logs_dir};
use aurora_launch::{
    CrashCategory, ExitCodeNote, LogEntry, LogTail, SessionEnded, analyze_lines, exit_code_clue,
    explain_exit_code, extract_mod_ids, has_crash_marker, read_log_tail, session_log_path,
    suspected_mods,
};
use aurora_modplatform::{InstalledMod, scan_mods_dir};
use serde::{Deserialize, Serialize};
use tokio::io::AsyncReadExt;

use crate::error::Result;
use crate::facade::Aurora;
use crate::launch::LaunchWarning;
use crate::session::JavaUsed;

/// 每个实例最近一次崩溃报告的文件名，位于 `versions/<id>/<元数据目录>/`。
pub const CRASH_REPORT_FILE: &str = "last-crash.json";
/// 崩溃报告文件的格式版本；结构不兼容地变化时递增，旧文件读出即报错而不是被误读。
const CRASH_REPORT_FORMAT: u32 = 2;
/// 能读的格式版本。格式 2 只是在 1 上加了带默认值的字段（线索来源、扫描过的文件），1 照读。
const READABLE_FORMATS: [u32; 2] = [1, CRASH_REPORT_FORMAT];
/// 诊断时读日志末尾多少字节。崩溃报告本体（含系统信息与 Mod 列表）在百 KB 量级，取两倍余量，
/// 让读取与扫描的成本和日志总长脱钩。
const CRASH_LOG_TAIL_BYTES: u64 = 512 * 1024;
/// hs_err 与崩溃报告读开头多少字节：原因都写在开头（hs_err 的 Problematic frame、崩溃报告的异常与
/// 可疑 Mod），尾部是系统信息与 Mod 清单。
const CRASH_FILE_HEAD_BYTES: u64 = 512 * 1024;
/// 判断「在会话开始之后写下」时放宽的毫秒数：FAT / exFAT 的修改时间只精确到 2 秒。
const MTIME_SLACK_MS: u64 = 2000;
/// 游戏把崩溃报告写在工作目录下的这个目录里，文件名形如 `crash-2026-10-29_19.04.12-client.txt`。
const CRASH_REPORTS_DIR: &str = "crash-reports";
/// 日志页一次给出的最大行数，与界面内存里保留的行数一致。
pub const LAUNCH_LOG_MAX_LINES: usize = 5000;
/// 日志页读末尾多少字节；按每行平均两三百字节估，足够装下 [`LAUNCH_LOG_MAX_LINES`] 行。
const LAUNCH_LOG_TAIL_BYTES: u64 = 2 * 1024 * 1024;
/// 每条线索附带命中行之前的几行。
const CONTEXT_BEFORE: usize = 2;

/// 线索来自哪里。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CrashSource {
    /// 这次会话的日志。旧格式的报告里线索不带来源，那时只扫会话日志。
    #[default]
    SessionLog,
    /// `crash-reports/` 下游戏写的崩溃报告。
    CrashReport,
    /// JVM 错误日志 `hs_err_pid<pid>.log`。
    HsErr,
    /// 只凭退出码，不来自任何文件。
    ExitCode,
}

/// 参与扫描的一份文件。`kind` 不会是 [`CrashSource::ExitCode`]。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ScannedFile {
    pub kind: CrashSource,
    pub path: String,
}

/// 一条线索。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CrashClue {
    pub category: CrashCategory,
    /// 规则的中文说明，只用于日志文件与命令行；界面文案由前端按类别生成。
    pub summary: String,
    pub advice: String,
    /// 从日志提取的附加信息（缺失的 Mod id、class file version 等）。
    pub detail: Option<String>,
    /// 命中的那一行（过长已裁剪）；来源是退出码时为空。
    pub matched: String,
    /// 命中行在来源文件里的行号（从 1 起）；来源是退出码时为 0。
    pub line: u64,
    /// 命中行之前的至多两行，按顺序。
    pub context: Vec<String>,
    #[serde(default)]
    pub source: CrashSource,
}

/// 日志点名的一个 Mod。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CrashSuspect {
    pub mod_id: String,
    /// mods 目录里对得上的文件名；对不上为 `None`。
    pub file_name: Option<String>,
}

/// 一份崩溃报告。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CrashReport {
    /// 游戏退出的 Unix 毫秒；对一段任意文本做的诊断没有这个时刻。
    pub at: Option<u64>,
    pub exit_code: Option<i32>,
    /// 那一次会话日志的开始时刻，用来找回日志文件。
    pub session_started_at: Option<u64>,
    /// 那一次会话日志的路径；日志已被滚动淘汰时为 `None`。读报告时现找：存进文件的恒为 `None`，
    /// 日志滚动后存下的路径就会过期。
    pub log_path: Option<String>,
    pub diagnoses: Vec<CrashClue>,
    pub suspects: Vec<CrashSuspect>,
    pub java: Option<JavaUsed>,
    pub max_memory_mb: Option<u32>,
    pub warnings: Vec<LaunchWarning>,
    /// 退出码的说明；表外的码与没有退出码时为 `None`。读报告时按 `exit_code` 现算，存进文件的恒为
    /// `None`：说明文字改了，旧报告也该显示新的。
    #[serde(default)]
    pub exit_code_note: Option<ExitCodeNote>,
    /// 参与扫描的文件，按扫描顺序。会话日志一项与 `log_path` 同理读报告时现找、补在最前，
    /// 存进文件的只有崩溃报告与 hs_err。
    #[serde(default)]
    pub scanned_files: Vec<ScannedFile>,
}

/// 一个扫描来源：哪类文件、在哪（粘贴的文本与日志没能建立时没有路径）、按该文件行号编好的行。
pub(crate) struct ScanInput<'a> {
    pub source: CrashSource,
    pub path: Option<String>,
    pub lines: Vec<(&'a str, u64)>,
}

impl ScanInput<'_> {
    /// 整份文件文本按行编号，行号从 1 起。
    pub(crate) fn numbered(source: CrashSource, path: Option<String>, text: &str) -> ScanInput<'_> {
        ScanInput {
            source,
            path,
            lines: text
                .lines()
                .enumerate()
                .map(|(index, line)| (line, index as u64 + 1))
                .collect(),
        }
    }
}

impl CrashReport {
    /// 由若干来源得出线索与点名的 Mod（尚未对到文件）。来源按传入顺序扫，同一类别只留第一次命中：
    /// 会话日志在前，玩家在日志页看到的就是诊断页指的那一行。
    pub(crate) fn from_sources(inputs: &[ScanInput<'_>], exit_code: Option<i32>) -> Self {
        let mut diagnoses: Vec<CrashClue> = Vec::new();
        let mut marked = false;
        let mut suspected: Vec<String> = Vec::new();
        let mut named: Vec<String> = Vec::new();
        for input in inputs {
            let texts: Vec<&str> = input.lines.iter().map(|(text, _)| *text).collect();
            for diagnosis in analyze_lines(&texts) {
                if diagnoses.iter().any(|c| c.category == diagnosis.category) {
                    continue;
                }
                let index = diagnosis.line;
                diagnoses.push(CrashClue {
                    category: diagnosis.category,
                    summary: diagnosis.summary,
                    advice: diagnosis.advice,
                    detail: diagnosis.detail,
                    matched: diagnosis.matched,
                    line: input.lines[index].1,
                    context: texts[index.saturating_sub(CONTEXT_BEFORE)..index]
                        .iter()
                        .map(|line| (*line).to_owned())
                        .collect(),
                    source: input.source,
                });
            }
            marked |= texts.iter().any(|line| has_crash_marker(line));
            let joined = texts.join("\n");
            suspected.extend(suspected_mods(&joined));
            named.extend(extract_mod_ids(&joined));
        }
        // 没有任何崩溃迹象时不报 Mod：正常启动的日志同样会点名 Mod，照单端出来会让玩家去停用无辜的 Mod。
        // 只凭退出码的兜底线索不算迹象，所以这道门在补兜底之前判。
        let suspects = if diagnoses.is_empty() && !marked {
            Vec::new()
        } else {
            // 崩溃报告点名的可疑 Mod 是加载器按调用栈认出来的，排在从日志措辞里捞出的 id 之前。
            let mut ids: Vec<String> = Vec::new();
            for id in suspected.into_iter().chain(named) {
                if !ids.contains(&id) {
                    ids.push(id);
                }
            }
            ids.into_iter()
                .map(|mod_id| CrashSuspect {
                    mod_id,
                    file_name: None,
                })
                .collect()
        };
        if diagnoses.is_empty()
            && let Some(clue) = exit_code_clue(exit_code)
        {
            diagnoses.push(CrashClue {
                category: clue.category,
                summary: clue.summary,
                advice: clue.advice,
                detail: clue.detail,
                matched: String::new(),
                line: 0,
                context: Vec::new(),
                source: CrashSource::ExitCode,
            });
        }
        Self {
            at: None,
            exit_code,
            session_started_at: None,
            log_path: None,
            diagnoses,
            suspects,
            java: None,
            max_memory_mb: None,
            warnings: Vec::new(),
            exit_code_note: exit_code.and_then(explain_exit_code),
            scanned_files: inputs
                .iter()
                .filter_map(|input| {
                    input.path.as_ref().map(|path| ScannedFile {
                        kind: input.source,
                        path: path.clone(),
                    })
                })
                .collect(),
        }
    }

    /// 把点名的 Mod 对到 `<工作目录>/mods` 里的文件。mods 目录不存在（从没装过 Mod）不是错误。
    pub(crate) async fn join_suspects(&mut self, working_dir: &Path) -> Result<()> {
        if self.suspects.is_empty() {
            return Ok(());
        }
        let mods_dir = working_dir.join("mods");
        let exists =
            tokio::fs::try_exists(&mods_dir)
                .await
                .map_err(|source| aurora_base::Error::Io {
                    path: mods_dir.clone(),
                    source,
                })?;
        if !exists {
            return Ok(());
        }
        let mods = scan_mods_dir(&mods_dir).await?;
        for suspect in &mut self.suspects {
            suspect.file_name = file_for_mod_id(&mods, &suspect.mod_id);
        }
        Ok(())
    }
}

/// 拿 mod id 找磁盘文件：先认 jar 里声明的 mod id，没有元数据的 jar 再按文件名惯例认。
fn file_for_mod_id(mods: &[InstalledMod], mod_id: &str) -> Option<String> {
    mods.iter()
        .find(|m| {
            m.metadata
                .as_ref()
                .is_some_and(|meta| meta.mod_id.eq_ignore_ascii_case(mod_id))
        })
        .or_else(|| {
            mods.iter()
                .find(|m| m.metadata.is_none() && file_name_matches_mod_id(&m.file_name, mod_id))
        })
        .map(|m| m.file_name.clone())
}

/// 文件名是否以该 mod id 起头且后接分隔符（忽略大小写与 `.jar` / `.disabled` 后缀）。只认前缀加分隔符：
/// `api` 若能匹配 `fabric-api-*.jar`，玩家就会照着一个错误的文件下手。
fn file_name_matches_mod_id(file_name: &str, mod_id: &str) -> bool {
    let lower = file_name.to_ascii_lowercase();
    let stem = lower.strip_suffix(".disabled").unwrap_or(&lower);
    let stem = stem.strip_suffix(".jar").unwrap_or(stem);
    let Some(rest) = stem.strip_prefix(&mod_id.to_ascii_lowercase()) else {
        return false;
    };
    rest.is_empty() || rest.starts_with(['-', '_', '+', '.', ' '])
}

/// 读会话日志尾部供诊断。
pub(crate) async fn read_tail_for_diagnosis(path: &Path) -> Result<LogTail> {
    Ok(read_log_tail(path, CRASH_LOG_TAIL_BYTES, usize::MAX).await?)
}

/// 这一次崩溃时游戏留下的文件。
#[derive(Debug, Default, PartialEq, Eq)]
pub(crate) struct CrashFiles {
    pub hs_err: Option<PathBuf>,
    pub crash_report: Option<PathBuf>,
}

/// 文件修改时间的 Unix 毫秒。早于 1970 年的时间戳（文件系统或复制工具写坏的）按 0 算，它必然早于
/// 任何一次会话，结论与「不是这一次写的」一致。
fn modified_millis(meta: &std::fs::Metadata, path: &Path) -> Result<u64> {
    let modified = meta.modified().map_err(|source| aurora_base::Error::Io {
        path: path.to_path_buf(),
        source,
    })?;
    Ok(modified.duration_since(UNIX_EPOCH).map_or(0, |elapsed| {
        u64::try_from(elapsed.as_millis()).expect("毫秒数在 u64 范围内")
    }))
}

/// 读元数据；不存在为 `None`。
async fn metadata_if_exists(path: &Path) -> Result<Option<std::fs::Metadata>> {
    match tokio::fs::metadata(path).await {
        Ok(meta) => Ok(Some(meta)),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(source) => Err(aurora_base::Error::Io {
            path: path.to_path_buf(),
            source,
        }
        .into()),
    }
}

/// 找这一次会话留下的 hs_err 与崩溃报告。
///
/// hs_err 只认工作目录下文件名里 pid 与这次进程一致的那份：JVM 不会覆盖别的 pid 的旧文件，工作目录里
/// 常年躺着几份往日的 hs_err。pid 会被系统复用，所以还要求修改时间不早于会话开始。JVM 写不了工作目录时
/// 会退到系统临时目录，那里不扫：临时目录是所有程序共用的，按 pid 认很容易认错。崩溃报告取
/// `crash-reports/` 下会话开始后写下的最新一份。两个目录与文件不存在都不是错误。
pub(crate) async fn find_crash_files(
    working_dir: &Path,
    pid: Option<u32>,
    session_started_at: u64,
) -> Result<CrashFiles> {
    let since = session_started_at.saturating_sub(MTIME_SLACK_MS);
    let mut files = CrashFiles::default();
    if let Some(pid) = pid {
        let path = working_dir.join(format!("hs_err_pid{pid}.log"));
        if let Some(meta) = metadata_if_exists(&path).await?
            && meta.is_file()
            && modified_millis(&meta, &path)? >= since
        {
            files.hs_err = Some(path);
        }
    }

    let dir = working_dir.join(CRASH_REPORTS_DIR);
    let mut entries = match tokio::fs::read_dir(&dir).await {
        Ok(entries) => entries,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(files),
        Err(source) => return Err(aurora_base::Error::Io { path: dir, source }.into()),
    };
    let io_err = |source| aurora_base::Error::Io {
        path: dir.clone(),
        source,
    };
    let mut newest: Option<(u64, PathBuf)> = None;
    while let Some(entry) = entries.next_entry().await.map_err(io_err)? {
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if !(name.starts_with("crash-") && name.ends_with(".txt")) {
            continue;
        }
        let path = entry.path();
        let meta = entry
            .metadata()
            .await
            .map_err(|source| aurora_base::Error::Io {
                path: path.clone(),
                source,
            })?;
        if !meta.is_file() {
            continue;
        }
        let modified = modified_millis(&meta, &path)?;
        if modified >= since && newest.as_ref().is_none_or(|(best, _)| modified > *best) {
            newest = Some((modified, path));
        }
    }
    files.crash_report = newest.map(|(_, path)| path);
    Ok(files)
}

/// 读 hs_err 或崩溃报告的开头供诊断。它们由 JVM 与游戏按系统默认编码写，可能不是 UTF-8，按有损解码读。
pub(crate) async fn read_head_for_diagnosis(path: &Path) -> Result<String> {
    let io_err = |source| aurora_base::Error::Io {
        path: path.to_path_buf(),
        source,
    };
    let file = tokio::fs::File::open(path).await.map_err(io_err)?;
    let mut bytes = Vec::new();
    file.take(CRASH_FILE_HEAD_BYTES)
        .read_to_end(&mut bytes)
        .await
        .map_err(io_err)?;
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

fn crash_report_path(version_dir: &Path) -> PathBuf {
    version_dir
        .join(aurora_instance::AURORA_META_DIR)
        .join(CRASH_REPORT_FILE)
}

#[derive(Serialize, Deserialize)]
struct CrashReportFile<R = CrashReport> {
    format: u32,
    report: R,
}

/// 列表只要崩溃时刻：只反序列化这一项，不把线索与上下文行整份建出来。
#[derive(Deserialize)]
struct CrashMoment {
    at: Option<u64>,
}

/// 读实例目录里的崩溃报告文件；没有为 `None`，格式版本不对按解析失败报。
async fn load_crash_file<R: serde::de::DeserializeOwned>(version_dir: &Path) -> Result<Option<R>> {
    let path = crash_report_path(version_dir);
    let bytes = match tokio::fs::read(&path).await {
        Ok(bytes) => bytes,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(source) => return Err(aurora_base::Error::Io { path, source }.into()),
    };
    let file: CrashReportFile<R> =
        serde_json::from_slice(&bytes).map_err(|source| aurora_instance::Error::Json {
            context: "崩溃报告",
            path: path.clone(),
            source,
        })?;
    if !READABLE_FORMATS.contains(&file.format) {
        return Err(aurora_instance::Error::Json {
            context: "崩溃报告",
            path,
            source: serde::de::Error::custom(format!(
                "格式版本是 {}，当前只认 {READABLE_FORMATS:?}",
                file.format
            )),
        }
        .into());
    }
    Ok(Some(file.report))
}

/// 该实例最近一次崩溃的时刻（Unix 毫秒）；没崩溃过为 `None`。调用方负责先校验实例目录。
pub(crate) async fn last_crash_at(version_dir: &Path) -> Result<Option<u64>> {
    Ok(load_crash_file::<CrashMoment>(version_dir)
        .await?
        .and_then(|moment| moment.at))
}

/// 覆盖保存实例最近一次的崩溃报告。
pub(crate) async fn save_crash_report(version_dir: &Path, report: &CrashReport) -> Result<()> {
    let path = crash_report_path(version_dir);
    let mut stored = report.clone();
    stored.log_path = None;
    stored.exit_code_note = None;
    stored
        .scanned_files
        .retain(|file| file.kind != CrashSource::SessionLog);
    let bytes = serde_json::to_vec_pretty(&CrashReportFile {
        format: CRASH_REPORT_FORMAT,
        report: stored,
    })
    .map_err(|source| aurora_instance::Error::Json {
        context: "崩溃报告",
        path: path.clone(),
        source,
    })?;
    aurora_base::fs::atomic_write(&path, &bytes).await?;
    Ok(())
}

/// 最近一次启动的日志。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct LaunchLog {
    pub path: String,
    pub started_at: u64,
    /// 最后至多 [`LAUNCH_LOG_MAX_LINES`] 行。
    pub lines: Vec<LogEntry>,
    /// 更早被省略的行数。
    pub omitted: u64,
    /// 会话结局；会话还在进行或中途中断时为 `None`。
    pub ended: Option<SessionEnded>,
}

// 读崩溃记录与日志前的实例目录一律经 existing_instance_dir：它先拦下带路径成分的 id（否则
// `..\..\某目录` 能读出游戏目录之外的文件），再要求目录存在——对不存在的实例回「没有记录」会把
// 拼错的 id 伪装成正常的空状态。
impl Aurora {
    /// 该实例最近一次的崩溃报告；从没崩溃过为 `None`。
    pub async fn last_crash(&self, version_id: &str) -> Result<Option<CrashReport>> {
        let version_dir = self.existing_instance_dir(version_id).await?;
        let Some(mut report) = load_crash_file::<CrashReport>(&version_dir).await? else {
            return Ok(None);
        };
        if let Some(started_at) = report.session_started_at {
            report.log_path = session_log_path(&logs_dir(&version_dir), started_at)
                .await?
                .map(|p| p.display().to_string());
        }
        if let Some(path) = &report.log_path {
            report.scanned_files.insert(
                0,
                ScannedFile {
                    kind: CrashSource::SessionLog,
                    path: path.clone(),
                },
            );
        }
        report.exit_code_note = report.exit_code.and_then(explain_exit_code);
        Ok(Some(report))
    }

    /// 诊断一段日志文本（如玩家粘贴的崩溃报告），点名的 Mod 对到该实例当前的 mods 目录。不保存。
    pub async fn diagnose_crash(&self, version_id: &str, log_text: &str) -> Result<CrashReport> {
        let working_dir = self.resolve_working_dir(version_id).await?.working_dir;
        // 粘贴的文本不是磁盘上的文件，没有路径，也没有退出码。
        let input = ScanInput::numbered(CrashSource::SessionLog, None, log_text);
        let mut report = CrashReport::from_sources(&[input], None);
        report.join_suspects(&working_dir).await?;
        Ok(report)
    }

    /// 该实例最近一次启动的日志；从没启动过为 `None`。
    pub async fn last_launch_log(&self, version_id: &str) -> Result<Option<LaunchLog>> {
        let version_dir = self.existing_instance_dir(version_id).await?;
        let path = logs_dir(&version_dir).join(LATEST_LOG);
        let exists =
            tokio::fs::try_exists(&path)
                .await
                .map_err(|source| aurora_base::Error::Io {
                    path: path.clone(),
                    source,
                })?;
        if !exists {
            return Ok(None);
        }
        let tail = read_log_tail(&path, LAUNCH_LOG_TAIL_BYTES, LAUNCH_LOG_MAX_LINES).await?;
        Ok(Some(LaunchLog {
            path: tail.path.display().to_string(),
            started_at: tail.started_at,
            omitted: tail.omitted(),
            ended: tail.ended,
            lines: tail.entries,
        }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::AuroraConfig;
    use crate::error::CoreError;
    use aurora_launch::logfile::SessionOutcome;
    use aurora_launch::{LogSource, SessionLog};

    const FABRIC_MISSING_DEPENDENCY: &[&str] = &[
        "[19:32:11] [main/INFO]: Loading Minecraft 1.20.1 with Fabric Loader 0.15.7",
        "[19:32:12] [main/ERROR]: Incompatible mod set!",
        "net.fabricmc.loader.impl.FormattedException: Incompatible mod set!",
        "Exception in thread \"main\" java.lang.RuntimeException: Mod resolution failed",
        "\t - Mod 'Sodium' (sodium) 0.5.3 requires version 0.90.0 or later of fabric-api, which is missing!",
    ];

    const HEALTHY: &[&str] = &[
        "[19:30:02] [main/INFO]: Loading 42 mods:",
        "\t - Mod 'Sodium' (sodium) 0.5.3",
        "[19:30:11] [Render thread/INFO]: Setting user: Steve",
    ];

    fn numbered(lines: &[&'static str], first: u64) -> Vec<(&'static str, u64)> {
        lines
            .iter()
            .enumerate()
            .map(|(i, l)| (*l, first + i as u64))
            .collect()
    }

    /// 只有会话日志一个来源、没有退出码时的报告。
    fn session_only(lines: &[&'static str], first: u64) -> CrashReport {
        CrashReport::from_sources(
            &[ScanInput {
                source: CrashSource::SessionLog,
                path: None,
                lines: numbered(lines, first),
            }],
            None,
        )
    }

    fn aurora_at(root: &Path) -> Aurora {
        Aurora::for_test(
            AuroraConfig::default(),
            root.to_path_buf(),
            root.join(".minecraft"),
        )
    }

    fn put_version(root: &Path, id: &str) -> PathBuf {
        let dir = root.join(".minecraft").join("versions").join(id);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join(format!("{id}.json")),
            format!(r#"{{"id":"{id}","type":"release","mainClass":"m"}}"#),
        )
        .unwrap();
        dir
    }

    /// 一个只有 fabric.mod.json 的最小 jar。
    fn put_fabric_mod(mods_dir: &Path, file_name: &str, mod_id: &str) {
        use std::io::Write;
        std::fs::create_dir_all(mods_dir).unwrap();
        let file = std::fs::File::create(mods_dir.join(file_name)).unwrap();
        let mut zip = zip::ZipWriter::new(file);
        zip.start_file("fabric.mod.json", zip::write::SimpleFileOptions::default())
            .unwrap();
        write!(
            zip,
            r#"{{"schemaVersion":1,"id":"{mod_id}","version":"1.0.0","name":"{mod_id}"}}"#
        )
        .unwrap();
        zip.finish().unwrap();
    }

    #[test]
    fn clues_carry_absolute_line_numbers_and_two_lines_of_context() {
        let report = session_only(FABRIC_MISSING_DEPENDENCY, 120);
        assert_eq!(report.diagnoses.len(), 1);
        let clue = &report.diagnoses[0];
        assert_eq!(clue.category, CrashCategory::MissingDependency);
        assert_eq!(clue.detail.as_deref(), Some("fabric-api"));
        // 第一条命中「Incompatible mod set」的是输入的第 2 行，即日志第 121 行。
        assert_eq!(clue.line, 121);
        assert_eq!(clue.context, vec![FABRIC_MISSING_DEPENDENCY[0].to_owned()]);
        let ids: Vec<&str> = report.suspects.iter().map(|s| s.mod_id.as_str()).collect();
        assert_eq!(ids, vec!["sodium", "fabric-api"]);
    }

    #[test]
    fn context_is_capped_at_two_lines() {
        let lines = ["a", "b", "c", "java.lang.OutOfMemoryError: Java heap space"];
        let report = session_only(&lines, 1);
        assert_eq!(report.diagnoses[0].line, 4);
        assert_eq!(report.diagnoses[0].context, vec!["b", "c"]);
    }

    #[test]
    fn healthy_log_names_no_suspects() {
        let report = session_only(HEALTHY, 1);
        assert!(report.diagnoses.is_empty());
        assert!(report.suspects.is_empty());
    }

    #[test]
    fn file_name_join_requires_prefix_plus_separator() {
        assert!(file_name_matches_mod_id(
            "sodium-fabric-0.5.3.jar",
            "sodium"
        ));
        assert!(file_name_matches_mod_id("JEI_1.20.1-15.2.0.27.jar", "jei"));
        assert!(file_name_matches_mod_id("lithium.jar.disabled", "lithium"));
        assert!(!file_name_matches_mod_id("fabric-api-0.92.2.jar", "api"));
        assert!(!file_name_matches_mod_id("sodium-0.5.3.jar", "sod"));
    }

    #[tokio::test]
    async fn suspects_join_mod_ids_to_files_by_metadata_then_name() {
        let tmp = tempfile::tempdir().unwrap();
        let mods = tmp.path().join("mods");
        // 文件名与 mod id 毫无关系，只能靠 jar 里的元数据认出来。
        put_fabric_mod(&mods, "zz-renderer-5.jar", "sodium");
        // 不是 jar：没有元数据，按文件名惯例认。
        std::fs::write(mods.join("fabric-api-0.92.2.jar.disabled"), b"not a zip").unwrap();
        let mut report = session_only(FABRIC_MISSING_DEPENDENCY, 1);
        report.join_suspects(tmp.path()).await.unwrap();
        assert_eq!(
            report.suspects,
            vec![
                CrashSuspect {
                    mod_id: "sodium".into(),
                    file_name: Some("zz-renderer-5.jar".into()),
                },
                CrashSuspect {
                    mod_id: "fabric-api".into(),
                    file_name: Some("fabric-api-0.92.2.jar.disabled".into()),
                },
            ]
        );
    }

    #[tokio::test]
    async fn missing_mods_dir_leaves_suspects_unjoined() {
        let tmp = tempfile::tempdir().unwrap();
        let mut report = session_only(FABRIC_MISSING_DEPENDENCY, 1);
        report.join_suspects(tmp.path()).await.unwrap();
        assert!(report.suspects.iter().all(|s| s.file_name.is_none()));
    }

    #[tokio::test]
    async fn saved_report_round_trips_and_finds_its_log_after_rotation() {
        let tmp = tempfile::tempdir().unwrap();
        let aurora = aurora_at(tmp.path());
        let version_dir = put_version(tmp.path(), "1.20.1-fabric");
        assert_eq!(aurora.last_crash("1.20.1-fabric").await.unwrap(), None);

        let logs = logs_dir(&version_dir);
        let mut log = SessionLog::create(&logs, "1.20.1-fabric", 1_000)
            .await
            .unwrap();
        log.write(1_500, LogSource::Game, None, "boom")
            .await
            .unwrap();
        log.finish(2_000, SessionOutcome::Crashed).await.unwrap();

        let mut report = session_only(FABRIC_MISSING_DEPENDENCY, 1);
        report.at = Some(2_000);
        report.exit_code = Some(-1);
        report.session_started_at = Some(1_000);
        report.max_memory_mb = Some(4096);
        report.warnings = vec![LaunchWarning::GamePath];
        report.log_path = Some("不会被存下来".into());
        save_crash_report(&version_dir, &report).await.unwrap();

        let loaded = aurora.last_crash("1.20.1-fabric").await.unwrap().unwrap();
        assert_eq!(loaded.exit_code, Some(-1));
        assert_eq!(loaded.max_memory_mb, Some(4096));
        assert_eq!(loaded.warnings, vec![LaunchWarning::GamePath]);
        assert_eq!(loaded.diagnoses, report.diagnoses);
        assert_eq!(
            loaded.log_path,
            Some(logs.join(LATEST_LOG).display().to_string())
        );

        // 下一次启动把那份日志滚动成 1000.log，报告照样找得回来。
        SessionLog::create(&logs, "1.20.1-fabric", 9_000)
            .await
            .unwrap();
        let loaded = aurora.last_crash("1.20.1-fabric").await.unwrap().unwrap();
        assert_eq!(
            loaded.log_path,
            Some(logs.join("1000.log").display().to_string())
        );
    }

    #[tokio::test]
    async fn unknown_instance_is_an_error_not_an_empty_record() {
        let tmp = tempfile::tempdir().unwrap();
        let aurora = aurora_at(tmp.path());
        for err in [
            aurora.last_crash("ghost").await.unwrap_err(),
            aurora.last_launch_log("ghost").await.unwrap_err(),
            aurora.diagnose_crash("ghost", "x").await.unwrap_err(),
        ] {
            assert!(
                matches!(&err, CoreError::VersionNotInstalled { id } if id == "ghost"),
                "{err:?}"
            );
        }
    }

    /// 带路径成分的 id 在拼路径前就被拦下：游戏目录之外即便真有一份崩溃记录与日志也读不到。
    #[tokio::test]
    async fn unsafe_instance_id_is_rejected_before_touching_the_disk() {
        let tmp = tempfile::tempdir().unwrap();
        let aurora = aurora_at(tmp.path());
        put_version(tmp.path(), "1.21");
        let outside = tmp.path().join("outside");
        let report_path = crash_report_path(&outside);
        std::fs::create_dir_all(report_path.parent().unwrap()).unwrap();
        std::fs::write(&report_path, r#"{"format":1,"report":{}}"#).unwrap();
        std::fs::create_dir_all(logs_dir(&outside)).unwrap();
        std::fs::write(
            logs_dir(&outside).join(LATEST_LOG),
            "[+0.000] [game] secret\n",
        )
        .unwrap();

        for id in [r"..\..\outside", "../../outside", r"..\outside"] {
            for err in [
                aurora.last_crash(id).await.unwrap_err(),
                aurora.last_launch_log(id).await.unwrap_err(),
            ] {
                assert!(
                    matches!(&err, CoreError::Instance(crate::InstanceError::InvalidId { id: bad }) if bad == id),
                    "{id}：{err:?}"
                );
            }
        }
    }

    #[tokio::test]
    async fn corrupt_report_file_is_an_error() {
        let tmp = tempfile::tempdir().unwrap();
        let aurora = aurora_at(tmp.path());
        let version_dir = put_version(tmp.path(), "1.21");
        let path = crash_report_path(&version_dir);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, r#"{"format":99,"report":{}}"#).unwrap();
        assert!(aurora.last_crash("1.21").await.is_err());
        std::fs::write(&path, "{ broken").unwrap();
        assert!(aurora.last_crash("1.21").await.is_err());
    }

    #[tokio::test]
    async fn diagnose_crash_joins_against_the_instance_mods() {
        let tmp = tempfile::tempdir().unwrap();
        let aurora = aurora_at(tmp.path());
        put_version(tmp.path(), "1.20.1");
        // 原版正式版在默认隔离档位下共用 .minecraft 根。
        put_fabric_mod(
            &tmp.path().join(".minecraft").join("mods"),
            "s.jar",
            "sodium",
        );
        let report = aurora
            .diagnose_crash("1.20.1", &FABRIC_MISSING_DEPENDENCY.join("\n"))
            .await
            .unwrap();
        assert_eq!(report.at, None);
        assert_eq!(report.diagnoses[0].line, 2);
        assert_eq!(report.suspects[0].file_name.as_deref(), Some("s.jar"));
        // 粘贴的文本不是文件：没有参与扫描的文件，也没有退出码说明。
        assert!(report.scanned_files.is_empty());
        assert_eq!(report.exit_code_note, None);
        assert_eq!(report.diagnoses[0].source, CrashSource::SessionLog);
    }

    fn now_ms() -> u64 {
        aurora_launch::unix_millis().unwrap()
    }

    /// 写一个文件并把修改时间设为某个 Unix 毫秒。
    fn put_file_at(path: &Path, text: &str, mtime_ms: u64) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, text).unwrap();
        let file = std::fs::File::options().write(true).open(path).unwrap();
        file.set_modified(UNIX_EPOCH + std::time::Duration::from_millis(mtime_ms))
            .unwrap();
    }

    #[tokio::test]
    async fn find_crash_files_takes_only_this_sessions_files() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path();
        let started = now_ms();
        const MINUTE: u64 = 60_000;

        // 什么都没有：两个都找不到，也不是错误。
        assert_eq!(
            find_crash_files(dir, Some(4242), started).await.unwrap(),
            CrashFiles::default()
        );

        let ours = dir.join("hs_err_pid4242.log");
        put_file_at(&ours, "# A fatal error", started + 5_000);
        put_file_at(&dir.join("hs_err_pid99.log"), "old", started - 60 * MINUTE);
        let found = find_crash_files(dir, Some(4242), started).await.unwrap();
        assert_eq!(found.hs_err, Some(ours.clone()));
        // 别的 pid 的旧文件不认；pid 未知时不找。
        assert_eq!(
            find_crash_files(dir, Some(99), started)
                .await
                .unwrap()
                .hs_err,
            None
        );
        assert_eq!(
            find_crash_files(dir, None, started).await.unwrap().hs_err,
            None
        );
        // pid 对得上但写在会话开始前 10 分钟：pid 被复用了，不是这一次的。
        put_file_at(&ours, "# A fatal error", started - 10 * MINUTE);
        assert_eq!(
            find_crash_files(dir, Some(4242), started)
                .await
                .unwrap()
                .hs_err,
            None
        );
        // 2 秒的修改时间精度余量：恰在余量边上算，再早 1 毫秒不算。
        put_file_at(&ours, "x", started - MTIME_SLACK_MS);
        assert_eq!(
            find_crash_files(dir, Some(4242), started)
                .await
                .unwrap()
                .hs_err,
            Some(ours.clone())
        );
        put_file_at(&ours, "x", started - MTIME_SLACK_MS - 1);
        assert_eq!(
            find_crash_files(dir, Some(4242), started)
                .await
                .unwrap()
                .hs_err,
            None
        );

        let reports = dir.join(CRASH_REPORTS_DIR);
        put_file_at(
            &reports.join("crash-2026-10-31_11.00.00-client.txt"),
            "before",
            started - MINUTE,
        );
        put_file_at(
            &reports.join("crash-2026-10-31_12.00.01-client.txt"),
            "after 1",
            started + 1_000,
        );
        let newest = reports.join("crash-2026-10-31_12.00.03-client.txt");
        put_file_at(&newest, "after 2", started + 3_000);
        // 更晚但名字不像崩溃报告的，以及名字像但其实是目录的，都不算。
        put_file_at(&reports.join("notes.txt"), "x", started + 9_000);
        put_file_at(&reports.join("crash-a.log"), "x", started + 9_000);
        std::fs::create_dir_all(reports.join("crash-folder.txt")).unwrap();
        let found = find_crash_files(dir, Some(4242), started).await.unwrap();
        assert_eq!(found.crash_report, Some(newest));
        // 会话开始后一份都没有：不拿旧的凑数。
        assert_eq!(
            find_crash_files(dir, None, started + 60 * MINUTE)
                .await
                .unwrap()
                .crash_report,
            None
        );
    }

    #[tokio::test]
    async fn read_head_reads_lossily_and_stops_at_the_cap() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("hs_err_pid1.log");
        let mut bytes = b"# C  [ig9icd64.dll+0x1]\n\xff\xfe gbk\n".to_vec();
        bytes.resize(CRASH_FILE_HEAD_BYTES as usize + 4096, b'x');
        std::fs::write(&path, &bytes).unwrap();
        let head = read_head_for_diagnosis(&path).await.unwrap();
        assert!(head.starts_with("# C  [ig9icd64.dll+0x1]\n\u{FFFD}\u{FFFD} gbk\n"));
        // 两个非法字节各换成一个 3 字节的替换字符，其余原样：总长 = 上限 + 2 * (3 - 1)。
        assert_eq!(head.len(), CRASH_FILE_HEAD_BYTES as usize + 4);
        assert!(
            read_head_for_diagnosis(&tmp.path().join("missing.log"))
                .await
                .is_err()
        );
    }

    const HS_ERR: &str = "#\n\
        # A fatal error has been detected by the Java Runtime Environment:\n\
        #\n\
        #  EXCEPTION_ACCESS_VIOLATION (0xc0000005) at pc=0x00007ffb49f76a27, pid=4242, tid=6484\n\
        #\n\
        # JRE version: OpenJDK Runtime Environment (17.0.8+7) (build 17.0.8+7)\n\
        # Problematic frame:\n\
        # C  [ig9icd64.dll+0x57a41c]\n\
        #\n\
        Dynamic libraries:\n\
        0x00007ffb49000000 - 0x00007ffb4a9f6000 \tC:\\WINDOWS\\System32\\DriverStore\\FileRepository\\iigd_dch.inf_amd64_f1c2\\ig9icd64.dll\n";

    #[test]
    fn hs_err_frame_is_a_clue_numbered_by_its_own_file() {
        let session = numbered(HEALTHY, 300);
        let inputs = [
            ScanInput {
                source: CrashSource::SessionLog,
                path: Some(r"D:\mc\logs\latest.log".into()),
                lines: session,
            },
            ScanInput::numbered(
                CrashSource::HsErr,
                Some(r"D:\mc\hs_err_pid4242.log".into()),
                HS_ERR,
            ),
        ];
        let report = CrashReport::from_sources(&inputs, Some(-1_073_741_819));
        assert_eq!(report.diagnoses.len(), 1, "{:?}", report.diagnoses);
        let clue = &report.diagnoses[0];
        assert_eq!(clue.category, CrashCategory::IntelGraphicsDriver);
        assert_eq!(clue.source, CrashSource::HsErr);
        assert_eq!(clue.line, 8);
        assert_eq!(clue.detail.as_deref(), Some("ig9icd64.dll"));
        assert_eq!(
            clue.context,
            vec![
                "# JRE version: OpenJDK Runtime Environment (17.0.8+7) (build 17.0.8+7)",
                "# Problematic frame:"
            ]
        );
        // 规则命中了，退出码只给说明、不再兜底出 native_crash。
        assert_eq!(report.exit_code, Some(-1_073_741_819));
        assert_eq!(
            report.exit_code_note.as_ref().map(|n| n.hex.as_str()),
            Some("0xC0000005")
        );
        assert_eq!(
            report.scanned_files,
            vec![
                ScannedFile {
                    kind: CrashSource::SessionLog,
                    path: r"D:\mc\logs\latest.log".into(),
                },
                ScannedFile {
                    kind: CrashSource::HsErr,
                    path: r"D:\mc\hs_err_pid4242.log".into(),
                },
            ]
        );
        // hs_err 带着 JVM 致命错误头，崩溃迹象成立，会话日志里点名的 sodium 列为嫌疑。
        let ids: Vec<&str> = report.suspects.iter().map(|s| s.mod_id.as_str()).collect();
        assert_eq!(ids, vec!["sodium"]);
    }

    #[test]
    fn earlier_source_wins_a_category_and_later_sources_add_new_ones() {
        let session = [
            "[main/INFO]: Loading 42 mods",
            "[Render thread/ERROR]: java.lang.OutOfMemoryError: Java heap space",
        ];
        let crash_report = "---- Minecraft Crash Report ----\n\
            java.lang.OutOfMemoryError: Java heap space\n\
            Caused by: java.lang.UnsatisfiedLinkError: Failed to locate library: lwjgl.dll\n";
        let inputs = [
            ScanInput {
                source: CrashSource::SessionLog,
                path: None,
                lines: numbered(&session, 40),
            },
            ScanInput::numbered(
                CrashSource::CrashReport,
                Some("crash.txt".into()),
                crash_report,
            ),
        ];
        let report = CrashReport::from_sources(&inputs, Some(1));
        let found: Vec<(CrashCategory, CrashSource, u64)> = report
            .diagnoses
            .iter()
            .map(|c| (c.category, c.source, c.line))
            .collect();
        assert_eq!(
            found,
            vec![
                (CrashCategory::OutOfMemory, CrashSource::SessionLog, 41),
                (
                    CrashCategory::NativeLibraryMissing,
                    CrashSource::CrashReport,
                    3
                ),
            ]
        );
        // 退出码 1 只给说明。
        assert_eq!(
            report.exit_code_note.map(|n| n.kind),
            Some(aurora_launch::ExitCodeKind::GenericFailure)
        );
        // 没有路径的来源不进参与扫描的文件。
        assert_eq!(report.scanned_files.len(), 1);
        assert_eq!(report.scanned_files[0].kind, CrashSource::CrashReport);
    }

    #[test]
    fn exit_code_fallback_is_a_clue_but_not_a_crash_sign_for_suspects() {
        for (code, hex, kind) in [
            (
                -1_073_741_819,
                "0xC0000005",
                aurora_launch::ExitCodeKind::AccessViolation,
            ),
            (
                -1_073_740_791,
                "0xC0000409",
                aurora_launch::ExitCodeKind::StackBufferOverrun,
            ),
        ] {
            let report = CrashReport::from_sources(
                &[ScanInput {
                    source: CrashSource::SessionLog,
                    path: None,
                    lines: numbered(HEALTHY, 1),
                }],
                Some(code),
            );
            assert_eq!(report.diagnoses.len(), 1);
            let clue = &report.diagnoses[0];
            assert_eq!(clue.category, CrashCategory::NativeCrash);
            assert_eq!(clue.source, CrashSource::ExitCode);
            assert_eq!(clue.detail.as_deref(), Some(hex));
            assert_eq!((clue.line, clue.matched.as_str()), (0, ""));
            assert!(clue.context.is_empty());
            // 兜底线索与报告的退出码说明指的是同一个码。
            let note = report.exit_code_note.as_ref().expect("认得的退出码带说明");
            assert_eq!((note.code, note.hex.as_str(), note.kind), (code, hex, kind));
            // 正常加载日志里列出的 sodium 不因兜底线索变成嫌疑。
            assert!(report.suspects.is_empty());
        }
        let quiet = session_only(HEALTHY, 1);
        assert!(quiet.diagnoses.is_empty());
        assert_eq!(quiet.exit_code_note, None);
    }

    #[tokio::test]
    async fn suspected_mods_from_crash_report_join_to_mod_files() {
        let tmp = tempfile::tempdir().unwrap();
        put_fabric_mod(&tmp.path().join("mods"), "zz-flow-engine-0.5.jar", "create");
        let crash_report = "---- Minecraft Crash Report ----\n\
            Description: Ticking block entity\n\
            \n\
            java.lang.NullPointerException: boom\n\
            Suspected Mod: \n\
            \tCreate (create), Version: 0.5.1.f\n\
            \t\tIssue tracker URL: https://github.com/Creators-of-Create/Create/issues\n\
            \t\tat TRANSFORMER/create@0.5.1.f/com.simibubi.create.Foo.tick(Foo.java:10)\n\
            Stacktrace:\n";
        let session =
            ["[Render thread/ERROR]: Mixin apply failed sodium.mixins.json:X from mod sodium"];
        let inputs = [
            ScanInput {
                source: CrashSource::SessionLog,
                path: None,
                lines: numbered(&session, 1),
            },
            ScanInput::numbered(CrashSource::CrashReport, Some("c.txt".into()), crash_report),
        ];
        let mut report = CrashReport::from_sources(&inputs, Some(-1));
        report.join_suspects(tmp.path()).await.unwrap();
        // 崩溃报告点名的排在前，日志措辞里捞出的接在后。
        assert_eq!(
            report.suspects,
            vec![
                CrashSuspect {
                    mod_id: "create".into(),
                    file_name: Some("zz-flow-engine-0.5.jar".into()),
                },
                CrashSuspect {
                    mod_id: "sodium".into(),
                    file_name: None,
                },
            ]
        );
    }

    #[tokio::test]
    async fn format_1_report_reads_with_defaults() {
        let tmp = tempfile::tempdir().unwrap();
        let aurora = aurora_at(tmp.path());
        let version_dir = put_version(tmp.path(), "1.20.1");
        let path = crash_report_path(&version_dir);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(
            &path,
            r#"{"format":1,"report":{"at":2000,"exit_code":-1073740791,"session_started_at":null,"log_path":null,
                "diagnoses":[{"category":"out_of_memory","summary":"内存不足","advice":"调高内存","detail":null,
                  "matched":"java.lang.OutOfMemoryError: Java heap space","line":12,"context":["a","b"]}],
                "suspects":[{"mod_id":"sodium","file_name":null}],"java":null,"max_memory_mb":2048,"warnings":["game_path"]}}"#,
        )
        .unwrap();
        let report = aurora.last_crash("1.20.1").await.unwrap().unwrap();
        assert_eq!(report.warnings, vec![LaunchWarning::GamePath]);
        assert_eq!(report.diagnoses.len(), 1);
        assert_eq!(report.diagnoses[0].source, CrashSource::SessionLog);
        assert_eq!(report.diagnoses[0].line, 12);
        assert!(report.scanned_files.is_empty());
        let note = report.exit_code_note.expect("退出码说明按退出码现算");
        assert_eq!(note.hex, "0xC0000409");
        assert_eq!(note.kind, aurora_launch::ExitCodeKind::StackBufferOverrun);
        assert_eq!(last_crash_at(&version_dir).await.unwrap(), Some(2000));
    }

    #[tokio::test]
    async fn saved_report_keeps_crash_files_and_refinds_the_session_log() {
        let tmp = tempfile::tempdir().unwrap();
        let aurora = aurora_at(tmp.path());
        let version_dir = put_version(tmp.path(), "1.20.1");
        let logs = logs_dir(&version_dir);
        let log = SessionLog::create(&logs, "1.20.1", 1_000).await.unwrap();
        log.finish(2_000, SessionOutcome::Crashed).await.unwrap();

        let session_path = logs.join(LATEST_LOG).display().to_string();
        let inputs = [
            ScanInput {
                source: CrashSource::SessionLog,
                path: Some(session_path.clone()),
                lines: numbered(FABRIC_MISSING_DEPENDENCY, 1),
            },
            ScanInput::numbered(
                CrashSource::CrashReport,
                Some(r"E:\mc\crash-reports\crash-2026-10-29_19.04.12-client.txt".into()),
                "---- Minecraft Crash Report ----",
            ),
            ScanInput::numbered(
                CrashSource::HsErr,
                Some(r"E:\mc\hs_err_pid4242.log".into()),
                HS_ERR,
            ),
        ];
        let mut report = CrashReport::from_sources(&inputs, Some(-1_073_741_819));
        report.at = Some(2_000);
        report.session_started_at = Some(1_000);
        save_crash_report(&version_dir, &report).await.unwrap();

        // 落盘的是格式 2，会话日志一项与退出码说明不存。
        let stored: serde_json::Value =
            serde_json::from_slice(&std::fs::read(crash_report_path(&version_dir)).unwrap())
                .unwrap();
        assert_eq!(stored["format"], 2);
        assert_eq!(stored["report"]["exit_code_note"], serde_json::Value::Null);
        assert_eq!(
            stored["report"]["scanned_files"],
            serde_json::json!([
                { "kind": "crash_report", "path": r"E:\mc\crash-reports\crash-2026-10-29_19.04.12-client.txt" },
                { "kind": "hs_err", "path": r"E:\mc\hs_err_pid4242.log" }
            ])
        );

        let loaded = aurora.last_crash("1.20.1").await.unwrap().unwrap();
        let kinds: Vec<CrashSource> = loaded.scanned_files.iter().map(|f| f.kind).collect();
        assert_eq!(
            kinds,
            vec![
                CrashSource::SessionLog,
                CrashSource::CrashReport,
                CrashSource::HsErr
            ]
        );
        assert_eq!(loaded.scanned_files[0].path, session_path);
        assert_eq!(loaded.scanned_files[1..], report.scanned_files[1..]);
        assert_eq!(loaded.exit_code_note, report.exit_code_note);
        assert_eq!(loaded.diagnoses, report.diagnoses);
        let sources: Vec<CrashSource> = loaded.diagnoses.iter().map(|c| c.source).collect();
        assert_eq!(sources, vec![CrashSource::SessionLog, CrashSource::HsErr]);

        // 日志被滚动淘汰后，会话日志一项随之消失，崩溃文件照旧。
        std::fs::remove_dir_all(&logs).unwrap();
        let loaded = aurora.last_crash("1.20.1").await.unwrap().unwrap();
        let kinds: Vec<CrashSource> = loaded.scanned_files.iter().map(|f| f.kind).collect();
        assert_eq!(kinds, vec![CrashSource::CrashReport, CrashSource::HsErr]);
    }

    #[tokio::test]
    async fn last_launch_log_returns_tail_with_outcome() {
        let tmp = tempfile::tempdir().unwrap();
        let aurora = aurora_at(tmp.path());
        let version_dir = put_version(tmp.path(), "1.21");
        assert_eq!(aurora.last_launch_log("1.21").await.unwrap(), None);

        let mut log = SessionLog::create(&logs_dir(&version_dir), "1.21", 5_000)
            .await
            .unwrap();
        for i in 0..(LAUNCH_LOG_MAX_LINES + 3) {
            log.write(
                5_000 + i as u64,
                LogSource::Game,
                None,
                &format!("line {i}"),
            )
            .await
            .unwrap();
        }
        log.finish(99_000, SessionOutcome::Exited).await.unwrap();

        let got = aurora.last_launch_log("1.21").await.unwrap().unwrap();
        assert_eq!(got.started_at, 5_000);
        assert_eq!(got.lines.len(), LAUNCH_LOG_MAX_LINES);
        assert_eq!(got.omitted, 3);
        assert_eq!(got.lines[0].text, "line 3");
        assert_eq!(
            got.ended,
            Some(SessionEnded {
                at: 99_000,
                outcome: SessionOutcome::Exited,
            })
        );
    }
}
