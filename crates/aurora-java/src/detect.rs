//! Java 安装探测：托管目录 / 手动添加 / 注册表 / JAVA_HOME / 常见安装目录 / PATH 六路，
//! 产出 [`JavaInstallation`] 列表。
//!
//! 每条候选最终都要跑一次 `java -version` 才算数——只有能正常执行并解析出版本的才收录。
//! 六路探测只负责产出「候选可执行文件路径」，识别交给 [`probe_cached`]。
//!
//! 识别是这里最贵的一步：每次 `java -version` 都要拉起一个 JVM，实测单次 110-130 ms，机器上有几个
//! JDK 就串几次。所以三件事：未命中缓存的候选并发识别（[`MAX_PROBE_WORKERS`]）；识别结果按
//! 「路径 + 文件大小 + 修改时间」记进 [`ProbeCache`]，同一个 java 可执行文件没变就不再拉起 JVM；
//! 单次识别最多等 [`PROBE_TIMEOUT`]，挂住的 JVM 会被结束，不会拖住整轮探测。识别失败同样按指纹记下，
//! 在 [`FAILED_PROBE_RETRY_AFTER`] 内不再反复拉起同一个坏 Java。
//!
//! 注册表读取是 Windows 专属能力，经 [`RegistryReader`] 注入；非 Windows 平台的生产实现返回空，
//! 保证 crate 仍能在其它平台编译。

use std::collections::{BTreeMap, HashSet};
use std::ffi::{OsStr, OsString};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

use crate::error::{Error, Result};
use crate::registry::{RegistryHive, RegistryReader, VENDOR_KEYS, WindowsRegistry};
use crate::version::{JavaVersion, ProbedJava, parse_java_version_output};

/// Java 可执行文件名。Windows 下探测的是 `java.exe`。
#[cfg(windows)]
pub const JAVA_EXE: &str = "java.exe";
/// Java 可执行文件名（非 Windows）。
#[cfg(not(windows))]
pub const JAVA_EXE: &str = "java";

/// 托管运行时在数据目录下的根目录名：`<数据目录>/runtime/<主版本>/`。
///
/// 自动下载与设置页手动下载都装到这里；探测必须扫它，否则刚下好的运行时下次启动找不到，
/// 又会整套重下一遍。
pub const MANAGED_RUNTIME_DIR: &str = "runtime";

/// 未命中缓存的候选同时识别的上限。每个识别都是一个 JVM 进程，开太多会在机器上有一堆 JDK 时
/// 把 CPU 与内存瞬间顶满，反而拖慢启动器自身。
pub const MAX_PROBE_WORKERS: usize = 6;

/// 单次 `java -version` 的等待上限。正常 JVM 一百多毫秒就答完；超过这个时间的多半是坏掉的
/// 运行时或被安全软件拦住的进程，再等下去只会让设置页与启动一直转圈。
pub const PROBE_TIMEOUT: Duration = Duration::from_secs(10);

/// 识别失败的记录在指纹没变、并且距失败不到这么久时直接复用，不再拉起 JVM。
///
/// 一个挂住的 Java 每轮探测都要白等一个 [`PROBE_TIMEOUT`]；隔一段时间再试，是给「用户修好了
/// 运行时但文件没变」（例如补装了依赖的系统组件）留的余地。
pub const FAILED_PROBE_RETRY_AFTER: Duration = Duration::from_secs(600);

/// 等子进程结束时两次查询之间的间隔：足够短，让正常 JVM 答完后几乎立刻返回。
const PROBE_POLL_INTERVAL: Duration = Duration::from_millis(15);

/// 托管运行时根目录：`<数据目录>/runtime`。
pub fn managed_runtime_root(data_dir: &Path) -> PathBuf {
    data_dir.join(MANAGED_RUNTIME_DIR)
}

/// 一个 Java home 下的可执行文件路径：`<home>/bin/java(.exe)`。
pub fn java_exe_in_home(home: &Path) -> PathBuf {
    home.join("bin").join(JAVA_EXE)
}

/// 一条探测来源，供 UI 展示与排序偏好参考。序列化名与 IPC 出参一致。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DetectSource {
    /// 来自 Windows 注册表 JavaSoft/发行版键（HKLM 与 HKCU）。
    Registry,
    /// 来自常见安装目录扫描。
    CommonDir,
    /// 来自 PATH 环境变量。
    Path,
    /// 由本启动器下载安装到数据目录的运行时。
    Managed,
    /// 用户手动添加的 java 可执行文件。
    Manual,
    /// 来自 JAVA_HOME 环境变量。
    JavaHome,
}

/// 一个已探测并成功识别的 Java 安装。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct JavaInstallation {
    /// java 可执行文件的绝对路径。
    pub path: PathBuf,
    /// 归一后的版本号。
    pub version: JavaVersion,
    /// 是否 64 位。
    pub is_64bit: bool,
    /// 实现/厂商名。
    pub vendor: String,
    /// 探测来源。
    pub source: DetectSource,
    /// 缺失的运行时文件，相对 Java home、用 `/` 分隔（见 [`missing_runtime_files`]）；空表示完整。
    pub missing_files: Vec<String>,
}

impl JavaInstallation {
    /// 运行时文件是否齐全。不齐全的 Java 能答出版本，但游戏启动时会因找不到核心类库而失败。
    pub fn is_complete(&self) -> bool {
        self.missing_files.is_empty()
    }
}

/// 检查 java 可执行文件所在运行时缺了哪些关键文件，返回相对 home、用 `/` 分隔的路径。
///
/// home 取规范化路径的上两级（`<home>/bin/java.exe`），规范化失败就用原路径的上两级。规则：
/// 缺 `release` 记 `release`；9 及以上缺 `lib/modules` 记 `lib/modules`；8 及以下
/// `lib/rt.jar` 与 `jre/lib/rt.jar` 都没有时记 `lib/rt.jar`。这些都是 Mojang 运行时清单与主流
/// 发行版压缩包根目录里必有的文件，下载中断或被清理软件删过的运行时最常缺的就是它们。
///
/// 8 及以下的 JDK 自带一份 `jre/`，它的 `release` 只在 JDK 根目录：home 名为 `jre` 时上一级的
/// `release` 也算数，否则 `<JDK>/jre/bin/java.exe` 会被误判为不完整。
///
/// 完整性不进识别缓存，每次现查：用户补齐文件后应当立刻转回完整。
pub fn missing_runtime_files(exe: &Path, major: u32) -> Vec<String> {
    let resolved = std::fs::canonicalize(exe).unwrap_or_else(|_| exe.to_path_buf());
    let legacy = major <= 8;
    let Some(home) = resolved.parent().and_then(Path::parent) else {
        // 连 `<home>/bin` 这一层都没有，周围不可能有运行时。
        let core = if legacy { "lib/rt.jar" } else { "lib/modules" };
        return vec!["release".to_owned(), core.to_owned()];
    };

    let mut missing = Vec::new();
    if !has_release(home, legacy) {
        missing.push("release".to_owned());
    }
    if legacy {
        let rt_jar = home.join("lib").join("rt.jar").is_file()
            || home.join("jre").join("lib").join("rt.jar").is_file();
        if !rt_jar {
            missing.push("lib/rt.jar".to_owned());
        }
    } else if !home.join("lib").join("modules").is_file() {
        missing.push("lib/modules".to_owned());
    }
    missing
}

fn has_release(home: &Path, legacy: bool) -> bool {
    if home.join("release").is_file() {
        return true;
    }
    legacy
        && home
            .file_name()
            .is_some_and(|name| name.eq_ignore_ascii_case("jre"))
        && home
            .parent()
            .is_some_and(|jdk| jdk.join("release").is_file())
}

/// 「执行一次 `java -version` 并返回输出」的函数。抽成参数是为了让测试注入固定输出，
/// 绕开真实子进程；需要 `Sync` 是因为识别在多个线程上并发进行。
pub type JavaRunner<'a> = dyn Fn(&Path) -> Result<String> + Sync + 'a;

/// 系统位置的探测来源：注册表、JAVA_HOME、常见安装目录、PATH。
///
/// 全部由调用方给出而不是在探测里现读环境：测试注入替身注册表与临时目录，结果才不随测试机变化。
#[derive(Debug, Clone)]
pub struct SystemSources {
    /// 注册表读取器。
    pub registry: Arc<dyn RegistryReader>,
    /// JAVA_HOME 的原始取值。
    pub java_home: Option<OsString>,
    /// PATH 的原始取值。
    pub path: Option<OsString>,
    /// 常见安装目录的候选根，每个根下有限深度递归。
    pub search_roots: Vec<PathBuf>,
}

impl SystemSources {
    /// 生产：WindowsRegistry、环境变量 JAVA_HOME / PATH、default_search_roots()。
    pub fn from_env() -> Self {
        Self {
            registry: Arc::new(WindowsRegistry),
            java_home: std::env::var_os("JAVA_HOME"),
            path: std::env::var_os("PATH"),
            search_roots: default_search_roots(),
        }
    }
}

/// 探测范围。
#[derive(Debug, Clone, Default)]
pub struct DetectScope {
    /// 托管运行时根目录（[`managed_runtime_root`]）；`None` 表示不扫托管目录。
    pub managed_root: Option<PathBuf>,
    /// 手动添加的 java 可执行文件（配置里的 extra_java_paths）。
    pub manual: Vec<PathBuf>,
    /// None：不扫系统位置（测试用）。
    pub system: Option<SystemSources>,
}

impl DetectScope {
    /// 生产范围：托管目录 + 全部系统位置。
    pub fn system_with_managed(managed_root: PathBuf) -> Self {
        Self {
            managed_root: Some(managed_root),
            manual: Vec::new(),
            system: Some(SystemSources::from_env()),
        }
    }
}

/// 探测本机全部可用 Java，不带缓存：托管目录取默认数据目录下的 `runtime`。
///
/// 供不持有数据目录的调用方使用；持有数据目录与缓存的上层应调用 [`detect_with`]。
pub fn detect_all() -> Vec<JavaInstallation> {
    let managed_root = match aurora_base::fs::data_dir() {
        Ok(dir) => Some(managed_runtime_root(&dir)),
        Err(err) => {
            tracing::warn!(error = %err, "定位不到数据目录，本次探测不含托管运行时");
            None
        }
    };
    let scope = DetectScope {
        managed_root,
        manual: Vec::new(),
        system: Some(SystemSources::from_env()),
    };
    detect_with(&scope, &mut ProbeCache::default(), &run_java_version)
}

/// 按范围探测：收集候选、按规范化路径去重、命中缓存的直接复用、其余并发识别，并把结果写回缓存。
///
/// 结果按候选顺序排列（托管 > 手动 > 注册表 > JAVA_HOME > 常见目录 > PATH），与识别的完成先后
/// 无关；同一路径从几路都探测到时只保留最先的来源。单个候选识别失败不中断整体（一个坏 Java 不该
/// 拖垮全部探测），只记 debug 日志跳过，并按指纹记进失败记录。缓存里本次没再出现的路径（成功与失败
/// 记录都是）会被清掉：卸载了的 Java 不该在下次启动时被当成「已知可用」或「已知坏」。
pub fn detect_with(
    scope: &DetectScope,
    cache: &mut ProbeCache,
    runner: &JavaRunner<'_>,
) -> Vec<JavaInstallation> {
    probe_candidates(collect_candidates(scope), cache, runner)
}

/// 对单个 java 可执行文件跑 `java -version` 并解析成 [`JavaInstallation`]，不经缓存。
pub fn probe(path: &Path, source: DetectSource) -> Result<JavaInstallation> {
    probe_cached(path, source, &mut ProbeCache::default(), &run_java_version)
}

/// 识别单个 java 可执行文件：文件大小与修改时间都与缓存一致时直接复用缓存，否则执行一次识别并更新缓存。
///
/// 这是显式识别（启动前校验选中的 Java、用户手动添加），不看失败记录，未命中成功缓存就总会真跑一次；
/// 结果照样写入或清除失败记录，让下一轮全量探测知道它现在的状况。
pub fn probe_cached(
    path: &Path,
    source: DetectSource,
    cache: &mut ProbeCache,
    runner: &JavaRunner<'_>,
) -> Result<JavaInstallation> {
    let key = canonical_key(path);
    let fingerprint = fingerprint(path)?;
    if let Some(hit) = cache.lookup(&key, fingerprint) {
        return Ok(hit.to_installation(path, source));
    }
    match runner(path).and_then(|out| parse_java_version_output(&out)) {
        Ok(probed) => {
            cache.clear_failure(&key);
            let entry = CachedProbe::new(fingerprint, source, probed);
            let installation = entry.to_installation(path, source);
            cache.store(key, path, entry);
            Ok(installation)
        }
        Err(err) => {
            cache.record_failure(key, path, fingerprint, &err);
            Err(err)
        }
    }
}

/// 实际执行 `java -version`，最多等 [`PROBE_TIMEOUT`]，把 stderr（Java 主要往这里打）与 stdout
/// 拼在一起返回。
pub fn run_java_version(path: &Path) -> Result<String> {
    run_java_version_with_timeout(path, PROBE_TIMEOUT)
}

/// [`run_java_version`] 的等待上限可指定版本。超时会结束子进程并确认它已退出，然后返回
/// [`Error::JavaProbeTimeout`]。
pub fn run_java_version_with_timeout(path: &Path, timeout: Duration) -> Result<String> {
    let mut cmd = Command::new(path);
    cmd.arg("-version");
    configure_no_window(&mut cmd);
    wait_output_with_timeout(cmd, path, timeout)
}

/// 拉起 `cmd` 并在 `timeout` 内收集输出；`path` 只用于错误信息。
fn wait_output_with_timeout(mut cmd: Command, path: &Path, timeout: Duration) -> Result<String> {
    cmd.stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = cmd.spawn().map_err(|source| exec_error(path, source))?;
    collect_output_with_timeout(&mut child, path, timeout)
}

/// 等一个 stdout 与 stderr 都是管道的子进程结束并收集输出。
///
/// 两路输出各起一个线程读：子进程把任一管道写满就会阻塞，只读一路可能把它卡死。主线程按短间隔
/// `try_wait`，到点先结束进程、再 `wait` 确认它已退出，才返回超时错误——不留孤儿 JVM。
fn collect_output_with_timeout(
    child: &mut Child,
    path: &Path,
    timeout: Duration,
) -> Result<String> {
    let stdout = spawn_pipe_reader(child.stdout.take(), path)?;
    let stderr = spawn_pipe_reader(child.stderr.take(), path)?;
    let deadline = Instant::now() + timeout;
    loop {
        match child.try_wait() {
            Ok(Some(_status)) => break,
            Ok(None) => {}
            Err(source) => {
                end_child(child, path);
                return Err(exec_error(path, source));
            }
        }
        let now = Instant::now();
        if now >= deadline {
            child.kill().map_err(|source| exec_error(path, source))?;
            child.wait().map_err(|source| exec_error(path, source))?;
            // 读线程不 join：若子进程派生的进程还握着管道，join 会跟着卡住；进程已结束，它们会自行收尾。
            return Err(Error::JavaProbeTimeout {
                path: path.to_path_buf(),
                timeout_secs: timeout.as_secs(),
            });
        }
        std::thread::sleep(PROBE_POLL_INTERVAL.min(deadline - now));
    }
    let stderr = join_pipe_reader(stderr, path)?;
    let stdout = join_pipe_reader(stdout, path)?;
    let mut combined = String::from_utf8_lossy(&stderr).into_owned();
    combined.push_str(&String::from_utf8_lossy(&stdout));
    Ok(combined)
}

/// 查询子进程状态本身出错时尽力结束它；这里的失败只记日志，调用方返回的是更早的那个错误。
fn end_child(child: &mut Child, path: &Path) {
    if let Err(err) = child.kill().and_then(|()| child.wait().map(drop)) {
        tracing::warn!(path = %path.display(), error = %err, "结束识别用的 java 子进程失败");
    }
}

type PipeReader = JoinHandle<std::io::Result<Vec<u8>>>;

fn spawn_pipe_reader<R: Read + Send + 'static>(pipe: Option<R>, path: &Path) -> Result<PipeReader> {
    let mut pipe = pipe.expect("调用方已把 stdout 与 stderr 设为管道");
    std::thread::Builder::new()
        .name("java-probe-pipe".to_owned())
        .spawn(move || {
            let mut buf = Vec::new();
            pipe.read_to_end(&mut buf).map(|_| buf)
        })
        .map_err(|source| exec_error(path, source))
}

fn join_pipe_reader(reader: PipeReader, path: &Path) -> Result<Vec<u8>> {
    reader
        .join()
        .expect("读管道的线程只做 read_to_end，不会 panic")
        .map_err(|source| exec_error(path, source))
}

fn exec_error(path: &Path, source: std::io::Error) -> Error {
    Error::JavaExec {
        path: path.to_path_buf(),
        source,
    }
}

// ---- 探测缓存 ----

/// java 可执行文件的识别缓存，键为规范化后的小写路径。可序列化，由上层落盘。
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProbeCache {
    entries: BTreeMap<String, CachedProbe>,
    /// 识别失败的记录。旧版缓存文件没有这一项。
    #[serde(default)]
    failures: BTreeMap<String, CachedFailure>,
}

/// 识别失败的类别。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ProbeFailureKind {
    /// 拉不起进程或读不到输出。
    Exec,
    /// 超过 [`PROBE_TIMEOUT`] 没有结束。
    Timeout,
    /// 有输出但解析不出版本号。
    Parse,
}

impl ProbeFailureKind {
    fn of(err: &Error) -> Self {
        match err {
            Error::JavaProbeTimeout { .. } => Self::Timeout,
            Error::JavaVersionParse { .. } => Self::Parse,
            _ => Self::Exec,
        }
    }
}

/// 一条识别失败记录，供上层展示「这个位置识别不出 Java」。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProbeFailureRecord {
    /// java 可执行文件路径。
    pub path: PathBuf,
    /// 失败类别。
    pub kind: ProbeFailureKind,
    /// 失败原因（含来源错误链）。
    pub message: String,
}

impl ProbeCache {
    /// 缓存里的全部已知安装（上次探测或校验时识别成功的那些），按路径排序。
    ///
    /// 启动路径先在它们里面按主版本挑，挑中的再用 [`probe_cached`] 校验文件还在、没被换过。
    pub fn installations(&self) -> Vec<JavaInstallation> {
        self.entries
            .values()
            .map(|entry| entry.to_installation(&entry.path, entry.source))
            .collect()
    }

    /// 全部识别失败记录，按路径排序。
    pub fn failures(&self) -> Vec<ProbeFailureRecord> {
        self.failures
            .values()
            .map(|failure| ProbeFailureRecord {
                path: failure.path.clone(),
                kind: failure.kind,
                message: failure.message.clone(),
            })
            .collect()
    }

    /// 缓存条目数。
    pub fn len(&self) -> usize {
        self.entries.len()
    }

    /// 缓存是否为空。
    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    fn lookup(&self, key: &str, fingerprint: Fingerprint) -> Option<&CachedProbe> {
        fingerprint?;
        self.entries
            .get(key)
            .filter(|entry| entry.fingerprint() == fingerprint)
    }

    fn store(&mut self, key: String, path: &Path, mut entry: CachedProbe) {
        entry.path = path.to_path_buf();
        if entry.size.is_some() {
            self.entries.insert(key, entry);
        }
    }

    /// 指纹相同、并且距失败不到 [`FAILED_PROBE_RETRY_AFTER`] 的失败记录。
    ///
    /// 系统时钟回拨到失败时间之前时不算新鲜：宁可多跑一次，也不让一条记录在时钟错乱期间一直生效。
    fn fresh_failure(
        &self,
        key: &str,
        fingerprint: Fingerprint,
        now_ms: Option<u64>,
    ) -> Option<&CachedFailure> {
        let (size, modified_ms) = fingerprint?;
        let now_ms = now_ms?;
        let window_ms = u64::try_from(FAILED_PROBE_RETRY_AFTER.as_millis())
            .expect("失败复用窗口是几分钟量级的常量，放得进 u64 毫秒");
        self.failures.get(key).filter(|failure| {
            failure.size == size
                && failure.modified_ms == modified_ms
                && now_ms
                    .checked_sub(failure.failed_at_ms)
                    .is_some_and(|elapsed| elapsed < window_ms)
        })
    }

    /// 写入或刷新失败记录。没有指纹或读不到当前时间时不记：无从判断文件换没换过、过了多久，
    /// 下次照常识别。
    fn record_failure(&mut self, key: String, path: &Path, fingerprint: Fingerprint, err: &Error) {
        let (Some((size, modified_ms)), Some(failed_at_ms)) =
            (fingerprint, unix_millis(SystemTime::now()))
        else {
            return;
        };
        self.failures.insert(
            key,
            CachedFailure {
                path: path.to_path_buf(),
                size,
                modified_ms,
                failed_at_ms,
                kind: ProbeFailureKind::of(err),
                message: error_chain(err),
            },
        );
    }

    fn clear_failure(&mut self, key: &str) {
        self.failures.remove(key);
    }
}

/// 一条缓存：识别结果 + 当时的文件指纹。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
struct CachedProbe {
    path: PathBuf,
    source: DetectSource,
    size: Option<u64>,
    modified_ms: Option<u64>,
    version: JavaVersion,
    is_64bit: bool,
    vendor: String,
}

impl CachedProbe {
    fn new(fingerprint: Fingerprint, source: DetectSource, probed: ProbedJava) -> Self {
        let (size, modified_ms) = match fingerprint {
            Some((size, modified)) => (Some(size), Some(modified)),
            None => (None, None),
        };
        Self {
            path: PathBuf::new(),
            source,
            size,
            modified_ms,
            version: probed.version,
            is_64bit: probed.is_64bit,
            vendor: probed.vendor,
        }
    }

    fn fingerprint(&self) -> Fingerprint {
        Some((self.size?, self.modified_ms?))
    }

    fn to_installation(&self, path: &Path, source: DetectSource) -> JavaInstallation {
        JavaInstallation {
            path: path.to_path_buf(),
            version: self.version.clone(),
            is_64bit: self.is_64bit,
            vendor: self.vendor.clone(),
            source,
            missing_files: missing_runtime_files(path, self.version.major),
        }
    }
}

/// 一条识别失败记录 + 当时的文件指纹与失败时间。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
struct CachedFailure {
    path: PathBuf,
    size: u64,
    modified_ms: u64,
    failed_at_ms: u64,
    kind: ProbeFailureKind,
    message: String,
}

/// 文件指纹 `(大小, 修改时间毫秒)`。平台给不出修改时间时为 `None`，此时不缓存、每次都识别——
/// 没有指纹就无从判断文件换没换过，宁可多跑一次 JVM 也不能拿旧结果冒充。
type Fingerprint = Option<(u64, u64)>;

fn fingerprint(path: &Path) -> Result<Fingerprint> {
    let meta = std::fs::metadata(path).map_err(|source| exec_error(path, source))?;
    let modified = meta.modified().ok().and_then(unix_millis);
    Ok(modified.map(|ms| (meta.len(), ms)))
}

fn unix_millis(time: SystemTime) -> Option<u64> {
    let elapsed = time.duration_since(UNIX_EPOCH).ok()?;
    u64::try_from(elapsed.as_millis()).ok()
}

/// 错误连同来源链拼成一行：`JavaExec` 自身的文案只有路径，真正的原因在 io 错误里。
fn error_chain(err: &Error) -> String {
    let mut message = err.to_string();
    let mut source = std::error::Error::source(err);
    while let Some(cause) = source {
        message.push_str(": ");
        message.push_str(&cause.to_string());
        source = cause.source();
    }
    message
}

// ---- 内部：候选 -> 安装项 ----

/// 一整轮识别：去重、过滤不存在的路径后，命中成功缓存的直接收下，有新鲜失败记录的跳过，其余交给
/// 并发识别；输出保持候选顺序。结束时把本轮没再出现的成功条目与失败记录清掉。
fn probe_candidates(
    candidates: Vec<(PathBuf, DetectSource)>,
    cache: &mut ProbeCache,
    runner: &JavaRunner<'_>,
) -> Vec<JavaInstallation> {
    let now_ms = unix_millis(SystemTime::now());
    let mut seen: HashSet<String> = HashSet::new();
    let mut succeeded: HashSet<String> = HashSet::new();
    let mut failed: HashSet<String> = HashSet::new();
    let mut slots: Vec<Option<JavaInstallation>> = Vec::new();
    let mut misses: Vec<Miss> = Vec::new();
    for (exe, source) in candidates {
        if !exe.is_file() {
            continue;
        }
        let key = canonical_key(&exe);
        if !seen.insert(key.clone()) {
            continue;
        }
        let fingerprint = match fingerprint(&exe) {
            Ok(fingerprint) => fingerprint,
            Err(err) => {
                tracing::debug!(path = %exe.display(), error = %err, "读不到候选的文件信息，跳过");
                continue;
            }
        };
        if let Some(hit) = cache.lookup(&key, fingerprint) {
            slots.push(Some(hit.to_installation(&exe, source)));
            succeeded.insert(key);
            continue;
        }
        if let Some(failure) = cache.fresh_failure(&key, fingerprint, now_ms) {
            tracing::debug!(
                path = %exe.display(),
                kind = ?failure.kind,
                reason = %failure.message,
                "上次识别失败且文件没变，本轮不再拉起 JVM"
            );
            failed.insert(key);
            continue;
        }
        misses.push(Miss {
            slot: slots.len(),
            key,
            exe,
            source,
            fingerprint,
        });
        slots.push(None);
    }

    for (miss, outcome) in probe_concurrently(&misses, runner) {
        match outcome {
            Ok(probed) => {
                cache.clear_failure(&miss.key);
                let entry = CachedProbe::new(miss.fingerprint, miss.source, probed);
                slots[miss.slot] = Some(entry.to_installation(&miss.exe, miss.source));
                cache.store(miss.key.clone(), &miss.exe, entry);
                succeeded.insert(miss.key.clone());
            }
            Err(err) => {
                tracing::debug!(path = %miss.exe.display(), error = %err, "跳过无法识别为 Java 的候选");
                cache.record_failure(miss.key.clone(), &miss.exe, miss.fingerprint, &err);
                failed.insert(miss.key.clone());
            }
        }
    }
    cache.entries.retain(|key, _| succeeded.contains(key));
    cache.failures.retain(|key, _| failed.contains(key));
    slots.into_iter().flatten().collect()
}

/// 一个未命中缓存、需要真正识别的候选。
struct Miss {
    slot: usize,
    key: String,
    exe: PathBuf,
    source: DetectSource,
    fingerprint: Fingerprint,
}

/// 在至多 [`MAX_PROBE_WORKERS`] 个线程上并发识别，返回与 `misses` 一一对应的结果。
///
/// 用作用域线程而不是异步任务：调用方本就在阻塞线程池里，识别是阻塞的子进程等待，
/// 线程领取下一个下标直到取完，慢的候选不会让别的线程空等。
fn probe_concurrently<'a>(
    misses: &'a [Miss],
    runner: &JavaRunner<'_>,
) -> Vec<(&'a Miss, Result<ProbedJava>)> {
    let next = AtomicUsize::new(0);
    let results: Mutex<Vec<(usize, Result<ProbedJava>)>> = Mutex::new(Vec::new());
    let workers = misses.len().min(MAX_PROBE_WORKERS);
    std::thread::scope(|scope| {
        for _ in 0..workers {
            scope.spawn(|| {
                loop {
                    let index = next.fetch_add(1, Ordering::Relaxed);
                    let Some(miss) = misses.get(index) else {
                        break;
                    };
                    let outcome = runner(&miss.exe).and_then(|out| parse_java_version_output(&out));
                    results
                        .lock()
                        .expect("识别结果锁只在本作用域内使用，持锁期间不会 panic")
                        .push((index, outcome));
                }
            });
        }
    });
    let mut results = results
        .into_inner()
        .expect("识别线程已全部结束，结果锁不会中毒");
    results.sort_by_key(|(index, _)| *index);
    results
        .into_iter()
        .map(|(index, outcome)| (&misses[index], outcome))
        .collect()
}

/// 收集候选。顺序就是去重时保留的来源优先级：托管 > 手动 > 注册表（先 HKLM 后 HKCU）>
/// JAVA_HOME > 常见目录 > PATH。
fn collect_candidates(scope: &DetectScope) -> Vec<(PathBuf, DetectSource)> {
    let mut candidates = Vec::new();
    if let Some(root) = &scope.managed_root {
        for exe in common_dir_javas(std::slice::from_ref(root)) {
            candidates.push((exe, DetectSource::Managed));
        }
    }
    for exe in &scope.manual {
        candidates.push((exe.clone(), DetectSource::Manual));
    }
    if let Some(system) = &scope.system {
        for hive in [RegistryHive::LocalMachine, RegistryHive::CurrentUser] {
            for key in VENDOR_KEYS {
                for home in system.registry.homes_under(hive, key) {
                    candidates.push((java_exe_in_home(&home), DetectSource::Registry));
                }
            }
        }
        if let Some(home) = java_home_dir(system.java_home.as_deref()) {
            candidates.push((java_exe_in_home(&home), DetectSource::JavaHome));
        }
        for exe in common_dir_javas(&system.search_roots) {
            candidates.push((exe, DetectSource::CommonDir));
        }
        for exe in path_javas(system.path.as_deref()) {
            candidates.push((exe, DetectSource::Path));
        }
    }
    candidates
}

/// JAVA_HOME 的取值去掉首尾空白与双引号：用户在系统设置里常把路径连引号一起填进去。
fn java_home_dir(value: Option<&OsStr>) -> Option<PathBuf> {
    let raw = value?;
    let Some(text) = raw.to_str() else {
        return Some(PathBuf::from(raw));
    };
    let trimmed = text.trim_matches(|c: char| c.is_whitespace() || c == '"');
    (!trimmed.is_empty()).then(|| PathBuf::from(trimmed))
}

/// 探测时抑制子进程的控制台窗口，避免每识别一个 Java 就闪一下黑框。
#[cfg(windows)]
fn configure_no_window(cmd: &mut Command) {
    use std::os::windows::process::CommandExt;
    // CREATE_NO_WINDOW，避免控制台子进程弹窗。
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    cmd.creation_flags(CREATE_NO_WINDOW);
}

#[cfg(not(windows))]
fn configure_no_window(_cmd: &mut Command) {}

/// 去重与缓存键：优先用规范化后的绝对路径，失败退回原路径；统一小写（Windows 路径大小写不敏感）。
fn canonical_key(exe: &Path) -> String {
    std::fs::canonicalize(exe)
        .unwrap_or_else(|_| exe.to_path_buf())
        .to_string_lossy()
        .to_lowercase()
}

// ---- 系统位置：候选路径产出 ----

/// 组装常见安装目录候选根：系统 JDK 安装位、JetBrains IDE 自带的 jbr、各启动器与工具的运行时目录。
///
/// 只收经各家官方文档或源码核对过的位置。本启动器自己的托管目录不在这里：它由
/// [`DetectScope::managed_root`] 单独给出，来源记为 Managed。
fn default_search_roots() -> Vec<PathBuf> {
    let env_dir = |key: &str| std::env::var_os(key).map(PathBuf::from);
    let mut roots = Vec::new();

    for key in ["ProgramFiles", "ProgramFiles(x86)", "ProgramW6432"] {
        let Some(base) = env_dir(key) else { continue };
        // 系统级 JDK 安装根（各发行版直接装在 Program Files 下）。
        for sub in [
            "Java",
            "Eclipse Adoptium",
            "Eclipse Foundation",
            "Microsoft",
            "Zulu",
            "BellSoft",
            "Amazon Corretto",
            "Semeru",
        ] {
            roots.push(base.join(sub));
        }
        // 独立安装的 JetBrains IDE：<ProgramFiles>\JetBrains\<IDE>\jbr。
        roots.extend(jbr_homes(&base.join("JetBrains")));
    }
    if let Some(base) = env_dir("ProgramFiles(x86)") {
        // 旧版 MSI 安装的官方启动器。
        roots.push(base.join("Minecraft Launcher").join("runtime"));
    }

    if let Some(appdata) = env_dir("APPDATA") {
        // 官方启动器。
        roots.push(appdata.join(".minecraft").join("runtime"));
        // 其他启动器下载的运行时：HMCL、Prism Launcher、Modrinth App。
        roots.push(appdata.join(".hmcl").join("java"));
        roots.push(appdata.join("PrismLauncher").join("java"));
        roots.push(
            appdata
                .join("ModrinthApp")
                .join("meta")
                .join("java_versions"),
        );
    }
    if let Some(local) = env_dir("LOCALAPPDATA") {
        // Microsoft Store / Xbox 版官方启动器。
        roots.push(
            local
                .join("Packages")
                .join("Microsoft.4297127D64EC6_8wekyb3d8bbwe")
                .join("LocalCache")
                .join("Local")
                .join("runtime"),
        );
        // Toolbox App 2.0 起把 IDE 装在 %LOCALAPPDATA%\Programs\<IDE>。
        roots.extend(jbr_homes(&local.join("Programs")));
    }
    if let Some(profile) = env_dir("USERPROFILE") {
        // IntelliJ 下载的 JDK、scoop 安装的 java。
        roots.push(profile.join(".jdks"));
        roots.push(profile.join("scoop").join("apps"));
    }

    // ProgramFiles 与 ProgramW6432 在 64 位进程里是同一个目录，同一个根不扫两遍。
    let mut seen = HashSet::new();
    roots.retain(|root| seen.insert(root.to_string_lossy().to_lowercase()));
    roots
}

/// `<base>\<IDE>\jbr` 形式的 JetBrains Runtime 目录。
///
/// 只看每个 IDE 目录下的 `jbr` 而不把 `base` 整个当作扫描根：`%LOCALAPPDATA%\Programs` 里还装着
/// 各种无关程序，递归翻下去既慢又没有意义。
fn jbr_homes(base: &Path) -> Vec<PathBuf> {
    let Ok(entries) = std::fs::read_dir(base) else {
        return Vec::new();
    };
    entries
        .flatten()
        .filter(|entry| {
            entry
                .file_type()
                .is_ok_and(|kind| kind.is_dir() && !kind.is_symlink())
        })
        .map(|entry| entry.path().join("jbr"))
        .filter(|jbr| jbr.is_dir())
        .collect()
}

/// 在每个候选根下有限深度递归，收集所有 `<dir>/bin/<java 可执行文件>`。
fn common_dir_javas(roots: &[PathBuf]) -> Vec<PathBuf> {
    let mut found = Vec::new();
    for root in roots {
        collect_java_in_dir(root, MAX_SCAN_DEPTH, &mut found);
    }
    found
}

/// 目录扫描的最大递归深度：足够覆盖 `runtime/<component>/<platform>/<component>/bin` 这类深层布局，
/// 又不至于把 scoop/apps 之类的大目录翻穿。
const MAX_SCAN_DEPTH: usize = 5;

fn collect_java_in_dir(dir: &Path, depth: usize, out: &mut Vec<PathBuf>) {
    // 当前目录自身若是个 Java home（含 bin/java），先收下；它的子目录不会再有另一个 Java。
    let candidate = java_exe_in_home(dir);
    if candidate.is_file() {
        out.push(candidate);
        return;
    }
    if depth == 0 {
        return;
    }
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        // 只钻真实子目录，跳过符号链接/重解析点，避免绕环与踩进 javapath 转发目录。
        if file_type.is_dir() && !file_type.is_symlink() {
            collect_java_in_dir(&entry.path(), depth - 1, out);
        }
    }
}

/// 从 PATH 环境变量各目录下取 `java` 可执行文件，跳过 Oracle 安装器的 `javapath` 转发目录。
///
/// `javapath\java.exe` 是普通文件形式的转发器，不是符号链接，旁边没有运行时，会被当成不完整的
/// Java；它转发到的真实 JDK 已经由注册表 `JavaSoft` 键给出。
fn path_javas(path_var: Option<&OsStr>) -> Vec<PathBuf> {
    let Some(var) = path_var else {
        return Vec::new();
    };
    std::env::split_paths(var)
        .filter(|dir| !is_java_forwarder_dir(dir))
        .map(|dir| dir.join(JAVA_EXE))
        .filter(|exe| exe.is_file())
        .collect()
}

fn is_java_forwarder_dir(dir: &Path) -> bool {
    dir.file_name()
        .is_some_and(|name| name.eq_ignore_ascii_case("javapath"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicUsize;

    const OPENJDK_17: &str = "openjdk version \"17.0.1\" 2021-10-19\n\
        OpenJDK 64-Bit Server VM (build 17.0.1+12-39, mixed mode)\n";
    const OPENJDK_21: &str = "openjdk version \"21.0.3\" 2024-04-16\n\
        OpenJDK 64-Bit Server VM (build 21.0.3+9-LTS, mixed mode)\n";

    fn touch(path: &Path) {
        touch_with(path, b"stub");
    }

    fn touch_with(path: &Path, bytes: &[u8]) {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).unwrap();
        }
        std::fs::write(path, bytes).unwrap();
    }

    /// 建一个完整的 9 及以上运行时：`bin/java`、`release`、`lib/modules` 都是空文件。
    fn complete_home(home: &Path) -> PathBuf {
        touch(&home.join("release"));
        touch(&home.join("lib").join("modules"));
        let exe = java_exe_in_home(home);
        touch(&exe);
        exe
    }

    /// 计数的固定输出运行器：断言「命中缓存不拉起 JVM」靠它。
    struct CountingRunner {
        calls: AtomicUsize,
        output: &'static str,
    }

    impl CountingRunner {
        fn new(output: &'static str) -> Self {
            Self {
                calls: AtomicUsize::new(0),
                output,
            }
        }

        fn calls(&self) -> usize {
            self.calls.load(Ordering::SeqCst)
        }

        fn run(&self, _path: &Path) -> Result<String> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            Ok(self.output.to_owned())
        }
    }

    fn managed_scope(root: &Path) -> DetectScope {
        DetectScope {
            managed_root: Some(root.to_path_buf()),
            ..DetectScope::default()
        }
    }

    // ---- 超时 ----

    /// 被重新拉起时当作挂住的 java。不带环境变量时立即返回，`--include-ignored` 跑全量也不会白等。
    const HANG_HELPER_ENV: &str = "AURORA_JAVA_PROBE_HANG_HELPER";

    #[test]
    #[ignore = "只供超时测试重新拉起本测试二进制时运行"]
    fn hung_java_helper() {
        if std::env::var_os(HANG_HELPER_ENV).is_some() {
            std::thread::sleep(Duration::from_secs(60));
        }
    }

    fn hung_java_command() -> Command {
        let mut cmd = Command::new(std::env::current_exe().unwrap());
        cmd.args([
            "--ignored",
            "--exact",
            "detect::tests::hung_java_helper",
            "--test-threads=1",
        ])
        .env(HANG_HELPER_ENV, "1");
        cmd
    }

    const ONE_SECOND: Duration = Duration::from_secs(1);
    /// 超时之外允许的余量：拉起测试二进制、结束进程与线程调度。
    const TIMEOUT_SLACK: Duration = Duration::from_secs(4);

    #[test]
    fn hung_process_times_out_with_probe_timeout() {
        let exe = std::env::current_exe().unwrap();
        let started = Instant::now();
        let err = wait_output_with_timeout(hung_java_command(), &exe, ONE_SECOND).unwrap_err();
        let elapsed = started.elapsed();

        assert!(
            matches!(&err, Error::JavaProbeTimeout { path, timeout_secs: 1 } if path == &exe),
            "{err:?}"
        );
        assert!(elapsed >= ONE_SECOND, "还没到超时就返回了：{elapsed:?}");
        assert!(
            elapsed < ONE_SECOND + TIMEOUT_SLACK,
            "超时后没有及时返回：{elapsed:?}"
        );
        assert_eq!(
            err.to_string(),
            format!(
                "java -version 超过 1 秒没有结束，已结束该进程: {}",
                exe.display()
            )
        );
    }

    #[test]
    fn timed_out_child_has_exited_when_error_returns() {
        let exe = std::env::current_exe().unwrap();
        let mut cmd = hung_java_command();
        cmd.stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        let mut child = cmd.spawn().unwrap();
        let err = collect_output_with_timeout(&mut child, &exe, ONE_SECOND).unwrap_err();
        assert!(matches!(err, Error::JavaProbeTimeout { .. }), "{err:?}");
        let status = child.try_wait().unwrap();
        assert!(status.is_some(), "返回超时错误时子进程必须已经退出");
        assert!(
            !status.unwrap().success(),
            "子进程是被结束的，不是自己跑完的"
        );
    }

    /// 正常结束的进程在超时前返回，输出照常收集（libtest 的 `--list` 打到 stdout）。
    #[test]
    fn finished_process_returns_output_before_timeout() {
        let exe = std::env::current_exe().unwrap();
        let mut cmd = Command::new(&exe);
        cmd.args([
            "--list",
            "--exact",
            "detect::tests::hung_java_helper",
            "--ignored",
        ]);
        let started = Instant::now();
        let out = wait_output_with_timeout(cmd, &exe, Duration::from_secs(30)).unwrap();
        assert!(started.elapsed() < Duration::from_secs(30));
        assert!(
            out.contains("detect::tests::hung_java_helper: test"),
            "{out}"
        );
    }

    #[test]
    fn missing_executable_is_exec_error_not_timeout() {
        let dir = tempfile::tempdir().unwrap();
        let missing = dir.path().join(JAVA_EXE);
        let err = run_java_version_with_timeout(&missing, ONE_SECOND).unwrap_err();
        assert!(
            matches!(&err, Error::JavaExec { path, .. } if path == &missing),
            "{err:?}"
        );
    }

    /// 一个挂住的候选只占一个识别线程：其余三个照常识别，整轮在超时加余量内结束，挂住的记为超时失败。
    #[test]
    fn hung_candidate_does_not_stall_the_round() {
        let root = tempfile::tempdir().unwrap();
        let good: Vec<PathBuf> = ["17a", "17b", "17c"]
            .iter()
            .map(|name| complete_home(&root.path().join(name)))
            .collect();
        let bad = complete_home(&root.path().join("hung"));
        let bad_for_runner = bad.clone();
        let runner = move |p: &Path| -> Result<String> {
            if p == bad_for_runner {
                wait_output_with_timeout(hung_java_command(), p, ONE_SECOND)
            } else {
                Ok(OPENJDK_17.to_owned())
            }
        };
        let mut candidates: Vec<(PathBuf, DetectSource)> = good
            .iter()
            .map(|exe| (exe.clone(), DetectSource::CommonDir))
            .collect();
        candidates.insert(1, (bad.clone(), DetectSource::CommonDir));
        let mut cache = ProbeCache::default();

        let started = Instant::now();
        let found = probe_candidates(candidates, &mut cache, &runner);
        let elapsed = started.elapsed();

        assert_eq!(found.len(), 3);
        assert_eq!(
            found
                .iter()
                .map(|java| java.path.clone())
                .collect::<Vec<_>>(),
            good
        );
        assert!(
            elapsed < ONE_SECOND + TIMEOUT_SLACK,
            "整轮被挂住的候选拖住：{elapsed:?}"
        );
        let failures = cache.failures();
        assert_eq!(failures.len(), 1);
        assert_eq!(failures[0].path, bad);
        assert_eq!(failures[0].kind, ProbeFailureKind::Timeout);
        assert!(
            failures[0].message.contains("超过 1 秒"),
            "{}",
            failures[0].message
        );
    }

    // ---- 识别与缓存 ----

    #[test]
    fn probe_cached_assembles_installation_fields() {
        let dir = tempfile::tempdir().unwrap();
        let exe = dir.path().join(JAVA_EXE);
        touch(&exe);
        let runner = CountingRunner::new(OPENJDK_17);

        let install = probe_cached(
            &exe,
            DetectSource::Path,
            &mut ProbeCache::default(),
            &|p: &Path| runner.run(p),
        )
        .unwrap();
        assert_eq!(install.path, exe);
        assert_eq!(install.version.major, 17);
        assert_eq!(install.version.build, 12);
        assert!(install.is_64bit);
        assert_eq!(install.vendor, "OpenJDK");
        assert_eq!(install.source, DetectSource::Path);
    }

    #[test]
    fn candidates_are_deduplicated_by_path_keeping_first_source() {
        let dir = tempfile::tempdir().unwrap();
        let exe = dir.path().join(JAVA_EXE);
        touch(&exe);
        let runner = CountingRunner::new(OPENJDK_17);

        let candidates = vec![
            (exe.clone(), DetectSource::Registry),
            (exe.clone(), DetectSource::Path),
        ];
        let found = probe_candidates(candidates, &mut ProbeCache::default(), &|p: &Path| {
            runner.run(p)
        });
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].source, DetectSource::Registry);
        assert_eq!(runner.calls(), 1, "同一路径只应识别一次");
    }

    #[test]
    fn nonexistent_candidates_are_skipped() {
        let dir = tempfile::tempdir().unwrap();
        let missing = dir.path().join("nope").join(JAVA_EXE);
        let runner = CountingRunner::new(OPENJDK_17);
        let found = probe_candidates(
            vec![(missing, DetectSource::Path)],
            &mut ProbeCache::default(),
            &|p: &Path| runner.run(p),
        );
        assert!(found.is_empty());
        assert_eq!(runner.calls(), 0);
    }

    #[test]
    fn unrecognized_java_is_skipped_not_fatal_and_not_cached() {
        let dir = tempfile::tempdir().unwrap();
        let good = dir.path().join("good").join(JAVA_EXE);
        let bad = dir.path().join("bad").join(JAVA_EXE);
        touch(&good);
        touch(&bad);

        let good_dir = good.parent().unwrap().to_path_buf();
        let runner = move |p: &Path| -> Result<String> {
            if p.starts_with(&good_dir) {
                Ok(OPENJDK_17.to_owned())
            } else {
                Ok("garbage not a java".to_owned())
            }
        };
        let mut cache = ProbeCache::default();
        let found = probe_candidates(
            vec![
                (good.clone(), DetectSource::CommonDir),
                (bad.clone(), DetectSource::CommonDir),
            ],
            &mut cache,
            &runner,
        );
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].path, good);
        assert_eq!(cache.len(), 1, "识别失败的候选不进成功缓存");
        let failures = cache.failures();
        assert_eq!(failures.len(), 1);
        assert_eq!(failures[0].path, bad);
        assert_eq!(failures[0].kind, ProbeFailureKind::Parse);
        assert!(failures[0].message.contains("garbage not a java"));
    }

    /// 并发识别后结果仍按候选顺序排列，且每个候选恰好识别一次（多于工作线程数也不漏不重）。
    #[test]
    fn concurrent_probe_keeps_candidate_order_and_probes_each_once() {
        let dir = tempfile::tempdir().unwrap();
        let exes: Vec<PathBuf> = (0..(MAX_PROBE_WORKERS * 2 + 1))
            .map(|i| {
                dir.path()
                    .join(format!("jdk-{i:02}"))
                    .join("bin")
                    .join(JAVA_EXE)
            })
            .collect();
        for exe in &exes {
            touch(exe);
        }
        let runner = CountingRunner::new(OPENJDK_17);
        let candidates = exes
            .iter()
            .map(|exe| (exe.clone(), DetectSource::CommonDir))
            .collect();

        let found = probe_candidates(candidates, &mut ProbeCache::default(), &|p: &Path| {
            runner.run(p)
        });
        let paths: Vec<&PathBuf> = found.iter().map(|java| &java.path).collect();
        assert_eq!(paths, exes.iter().collect::<Vec<_>>());
        assert_eq!(runner.calls(), exes.len());
    }

    /// 同一文件第二次探测命中缓存，不再拉起 JVM；文件内容一变（大小变）就重新识别。
    #[test]
    fn cache_hit_skips_runner_until_file_changes() {
        let root = tempfile::tempdir().unwrap();
        let exe = root.path().join("17").join("bin").join(JAVA_EXE);
        touch(&exe);
        let scope = managed_scope(root.path());
        let mut cache = ProbeCache::default();

        let first = CountingRunner::new(OPENJDK_17);
        let found = detect_with(&scope, &mut cache, &|p: &Path| first.run(p));
        assert_eq!(found.len(), 1);
        assert_eq!(first.calls(), 1);

        let second = CountingRunner::new(OPENJDK_21);
        let found = detect_with(&scope, &mut cache, &|p: &Path| second.run(p));
        assert_eq!(second.calls(), 0, "文件没变，应直接复用缓存");
        assert_eq!(found[0].version.major, 17);

        // 换成另一个 Java（文件大小不同）：缓存失效，重新识别得到新版本。
        touch_with(&exe, b"a different java binary");
        let third = CountingRunner::new(OPENJDK_21);
        let found = detect_with(&scope, &mut cache, &|p: &Path| third.run(p));
        assert_eq!(third.calls(), 1);
        assert_eq!(found[0].version.major, 21);
    }

    /// 托管目录下的运行时以 Managed 来源出现：这是「第二次启动不重下运行时」的前提。
    #[test]
    fn managed_root_runtimes_are_detected_as_managed() {
        let data = tempfile::tempdir().unwrap();
        let root = managed_runtime_root(data.path());
        let exe = java_exe_in_home(&root.join("17"));
        touch(&exe);
        let runner = CountingRunner::new(OPENJDK_17);

        let found = detect_with(
            &managed_scope(&root),
            &mut ProbeCache::default(),
            &|p: &Path| runner.run(p),
        );
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].path, exe);
        assert_eq!(found[0].source, DetectSource::Managed);
        assert_eq!(root, data.path().join("runtime"));
    }

    /// 全量探测会把本次没再出现的路径从缓存里清掉，缓存里只剩真实存在的安装。
    #[test]
    fn full_detect_prunes_vanished_entries() {
        let root = tempfile::tempdir().unwrap();
        let keep = java_exe_in_home(&root.path().join("17"));
        let gone = java_exe_in_home(&root.path().join("21"));
        touch(&keep);
        touch(&gone);
        let runner = CountingRunner::new(OPENJDK_17);
        let mut cache = ProbeCache::default();
        detect_with(&managed_scope(root.path()), &mut cache, &|p: &Path| {
            runner.run(p)
        });
        assert_eq!(cache.len(), 2);

        std::fs::remove_file(&gone).unwrap();
        detect_with(&managed_scope(root.path()), &mut cache, &|p: &Path| {
            runner.run(p)
        });
        let cached: Vec<PathBuf> = cache.installations().into_iter().map(|j| j.path).collect();
        assert_eq!(cached, vec![keep]);
    }

    #[test]
    fn probe_cache_roundtrips_through_json() {
        let dir = tempfile::tempdir().unwrap();
        let exe = dir.path().join(JAVA_EXE);
        touch(&exe);
        let runner = CountingRunner::new(OPENJDK_21);
        let mut cache = ProbeCache::default();
        probe_cached(&exe, DetectSource::Managed, &mut cache, &|p: &Path| {
            runner.run(p)
        })
        .unwrap();

        let json = serde_json::to_string(&cache).unwrap();
        let restored: ProbeCache = serde_json::from_str(&json).unwrap();
        assert_eq!(restored, cache);
        let installs = restored.installations();
        assert_eq!(installs.len(), 1);
        assert_eq!(installs[0].source, DetectSource::Managed);
        assert_eq!(installs[0].version.major, 21);
    }

    #[test]
    fn probe_cached_reports_missing_file() {
        let dir = tempfile::tempdir().unwrap();
        let missing = dir.path().join(JAVA_EXE);
        let runner = CountingRunner::new(OPENJDK_17);
        let err = probe_cached(
            &missing,
            DetectSource::Path,
            &mut ProbeCache::default(),
            &|p: &Path| runner.run(p),
        )
        .unwrap_err();
        assert!(matches!(err, Error::JavaExec { ref path, .. } if path == &missing));
        assert_eq!(runner.calls(), 0);
    }

    // ---- 失败记录 ----

    const GARBAGE: &str = "Error: could not open `C:\\broken\\lib\\jvm.cfg'";

    /// 失败一次后，文件没变、在复用窗口内的下一轮不再拉起 JVM，结果里也没有它。
    #[test]
    fn failed_probe_is_reused_without_spawning_again() {
        let root = tempfile::tempdir().unwrap();
        let exe = java_exe_in_home(&root.path().join("17"));
        touch(&exe);
        let scope = managed_scope(root.path());
        let mut cache = ProbeCache::default();

        let first = CountingRunner::new(GARBAGE);
        assert!(detect_with(&scope, &mut cache, &|p: &Path| first.run(p)).is_empty());
        assert_eq!(first.calls(), 1);
        assert_eq!(cache.failures().len(), 1);

        let second = CountingRunner::new(OPENJDK_17);
        let found = detect_with(&scope, &mut cache, &|p: &Path| second.run(p));
        assert_eq!(second.calls(), 0, "失败记录还新鲜，不应再拉起 JVM");
        assert!(found.is_empty());
        assert_eq!(cache.failures().len(), 1, "复用的失败记录保留到下一轮");
    }

    #[test]
    fn failed_probe_reruns_when_fingerprint_changes() {
        let root = tempfile::tempdir().unwrap();
        let exe = java_exe_in_home(&root.path().join("17"));
        touch(&exe);
        let scope = managed_scope(root.path());
        let mut cache = ProbeCache::default();
        let first = CountingRunner::new(GARBAGE);
        detect_with(&scope, &mut cache, &|p: &Path| first.run(p));

        touch_with(&exe, b"reinstalled java binary");
        let second = CountingRunner::new(OPENJDK_17);
        let found = detect_with(&scope, &mut cache, &|p: &Path| second.run(p));
        assert_eq!(second.calls(), 1);
        assert_eq!(found.len(), 1);
        assert!(cache.failures().is_empty(), "识别成功要清掉失败记录");
    }

    /// 复用窗口的边界：差 5 秒到窗口仍复用，超过窗口 5 秒就重跑（余量留给测试本身的耗时）。
    #[test]
    fn failed_probe_reruns_only_after_retry_window() {
        let root = tempfile::tempdir().unwrap();
        let exe = java_exe_in_home(&root.path().join("17"));
        touch(&exe);
        let scope = managed_scope(root.path());
        let mut cache = ProbeCache::default();
        let first = CountingRunner::new(GARBAGE);
        detect_with(&scope, &mut cache, &|p: &Path| first.run(p));
        let window_ms = FAILED_PROBE_RETRY_AFTER.as_millis() as u64;

        for failure in cache.failures.values_mut() {
            failure.failed_at_ms -= window_ms - 5_000;
        }
        let inside = CountingRunner::new(OPENJDK_17);
        detect_with(&scope, &mut cache, &|p: &Path| inside.run(p));
        assert_eq!(inside.calls(), 0, "还在窗口内");

        for failure in cache.failures.values_mut() {
            failure.failed_at_ms -= 10_000;
        }
        let outside = CountingRunner::new(OPENJDK_17);
        let found = detect_with(&scope, &mut cache, &|p: &Path| outside.run(p));
        assert_eq!(outside.calls(), 1, "超过窗口应重新识别");
        assert_eq!(found.len(), 1);
        assert!(cache.failures().is_empty());
    }

    /// 失败时间在当前时间之后（时钟回拨）时不复用。
    #[test]
    fn failure_from_the_future_is_not_reused() {
        let root = tempfile::tempdir().unwrap();
        let exe = java_exe_in_home(&root.path().join("17"));
        touch(&exe);
        let scope = managed_scope(root.path());
        let mut cache = ProbeCache::default();
        detect_with(&scope, &mut cache, &|p: &Path| {
            CountingRunner::new(GARBAGE).run(p)
        });
        for failure in cache.failures.values_mut() {
            failure.failed_at_ms += 3_600_000;
        }
        let runner = CountingRunner::new(OPENJDK_17);
        detect_with(&scope, &mut cache, &|p: &Path| runner.run(p));
        assert_eq!(runner.calls(), 1);
    }

    #[test]
    fn vanished_failed_candidate_is_pruned() {
        let root = tempfile::tempdir().unwrap();
        let exe = java_exe_in_home(&root.path().join("17"));
        touch(&exe);
        let scope = managed_scope(root.path());
        let mut cache = ProbeCache::default();
        detect_with(&scope, &mut cache, &|p: &Path| {
            CountingRunner::new(GARBAGE).run(p)
        });
        assert_eq!(cache.failures().len(), 1);

        std::fs::remove_file(&exe).unwrap();
        detect_with(&scope, &mut cache, &|p: &Path| {
            CountingRunner::new(OPENJDK_17).run(p)
        });
        assert!(cache.failures().is_empty());
    }

    /// 显式识别不看失败记录：总会真跑一次，成功后清掉记录；失败时写入记录并带上来源错误链。
    #[test]
    fn probe_cached_ignores_failures_but_maintains_them() {
        let dir = tempfile::tempdir().unwrap();
        let exe = dir.path().join(JAVA_EXE);
        touch(&exe);
        let mut cache = ProbeCache::default();

        let exe_for_runner = exe.clone();
        let failing = move |_: &Path| -> Result<String> {
            Err(Error::JavaExec {
                path: exe_for_runner.clone(),
                source: std::io::Error::new(std::io::ErrorKind::PermissionDenied, "拒绝访问"),
            })
        };
        probe_cached(&exe, DetectSource::Manual, &mut cache, &failing).unwrap_err();
        let failures = cache.failures();
        assert_eq!(failures.len(), 1);
        assert_eq!(failures[0].kind, ProbeFailureKind::Exec);
        assert!(
            failures[0].message.ends_with(": 拒绝访问"),
            "{}",
            failures[0].message
        );

        let runner = CountingRunner::new(OPENJDK_17);
        let java = probe_cached(&exe, DetectSource::Manual, &mut cache, &|p: &Path| {
            runner.run(p)
        })
        .unwrap();
        assert_eq!(runner.calls(), 1, "显式识别不因失败记录跳过");
        assert_eq!(java.source, DetectSource::Manual);
        assert!(cache.failures().is_empty());
    }

    /// 旧版缓存文件没有 failures 字段：能读，成功条目原样保留。
    #[test]
    fn old_cache_json_without_failures_is_readable() {
        let empty: ProbeCache = serde_json::from_str(r#"{"entries":{}}"#).unwrap();
        assert!(empty.is_empty());
        assert!(empty.failures().is_empty());

        let dir = tempfile::tempdir().unwrap();
        let exe = dir.path().join(JAVA_EXE);
        touch(&exe);
        let mut cache = ProbeCache::default();
        probe_cached(&exe, DetectSource::Registry, &mut cache, &|p: &Path| {
            CountingRunner::new(OPENJDK_21).run(p)
        })
        .unwrap();
        let mut value = serde_json::to_value(&cache).unwrap();
        let object = value.as_object_mut().unwrap();
        assert!(object.remove("failures").is_some());
        assert_eq!(object.len(), 1, "旧版文件只有 entries");

        let restored: ProbeCache = serde_json::from_value(value).unwrap();
        assert_eq!(restored, cache);
        assert_eq!(restored.installations()[0].version.major, 21);
    }

    #[test]
    fn failures_roundtrip_through_json() {
        let dir = tempfile::tempdir().unwrap();
        let exe = dir.path().join(JAVA_EXE);
        touch(&exe);
        let mut cache = ProbeCache::default();
        probe_cached(&exe, DetectSource::Path, &mut cache, &|p: &Path| {
            CountingRunner::new(GARBAGE).run(p)
        })
        .unwrap_err();
        let json = serde_json::to_string(&cache).unwrap();
        assert!(json.contains("\"kind\":\"parse\""), "{json}");
        let restored: ProbeCache = serde_json::from_str(&json).unwrap();
        assert_eq!(restored.failures(), cache.failures());
    }

    // ---- 完整性 ----

    fn missing(exe: &Path, major: u32) -> Vec<String> {
        missing_runtime_files(exe, major)
    }

    #[test]
    fn complete_modern_runtime_has_nothing_missing() {
        let root = tempfile::tempdir().unwrap();
        let exe = complete_home(&root.path().join("jdk-21"));
        assert!(missing(&exe, 21).is_empty());
        assert!(missing(&exe, 9).is_empty(), "9 是 lib/modules 规则的下界");
    }

    #[test]
    fn missing_release_is_reported() {
        let root = tempfile::tempdir().unwrap();
        let home = root.path().join("jdk-17");
        let exe = complete_home(&home);
        std::fs::remove_file(home.join("release")).unwrap();
        assert_eq!(missing(&exe, 17), vec!["release"]);
    }

    #[test]
    fn missing_modules_is_reported_and_rt_jar_does_not_substitute() {
        let root = tempfile::tempdir().unwrap();
        let home = root.path().join("jdk-17");
        let exe = complete_home(&home);
        std::fs::remove_file(home.join("lib").join("modules")).unwrap();
        touch(&home.join("lib").join("rt.jar"));
        assert_eq!(missing(&exe, 17), vec!["lib/modules"]);

        std::fs::remove_file(home.join("release")).unwrap();
        assert_eq!(missing(&exe, 17), vec!["release", "lib/modules"]);
    }

    #[test]
    fn java8_accepts_rt_jar_in_lib_or_jre_lib() {
        let root = tempfile::tempdir().unwrap();
        let jre = root.path().join("jre8");
        touch(&jre.join("release"));
        touch(&jre.join("lib").join("rt.jar"));
        let jre_exe = java_exe_in_home(&jre);
        touch(&jre_exe);
        assert!(missing(&jre_exe, 8).is_empty());

        // JDK 8：只有 jre/lib/rt.jar。
        let jdk = root.path().join("jdk8");
        touch(&jdk.join("release"));
        touch(&jdk.join("jre").join("lib").join("rt.jar"));
        let jdk_exe = java_exe_in_home(&jdk);
        touch(&jdk_exe);
        assert!(missing(&jdk_exe, 8).is_empty());

        // lib/modules 对 8 不算数，8 是 rt.jar 规则的上界。
        let odd = root.path().join("odd8");
        touch(&odd.join("release"));
        touch(&odd.join("lib").join("modules"));
        let odd_exe = java_exe_in_home(&odd);
        touch(&odd_exe);
        assert_eq!(missing(&odd_exe, 8), vec!["lib/rt.jar"]);
        assert_eq!(missing(&odd_exe, 7), vec!["lib/rt.jar"]);
    }

    /// JDK 8 自带的 `jre/bin/java.exe`：release 在上一级 JDK 根目录，也算完整；这条放宽只对 8 及以下。
    #[test]
    fn java8_nested_jre_uses_jdk_release() {
        let root = tempfile::tempdir().unwrap();
        let jdk = root.path().join("jdk1.8.0_402");
        touch(&jdk.join("release"));
        touch(&jdk.join("jre").join("lib").join("rt.jar"));
        let nested = java_exe_in_home(&jdk.join("jre"));
        touch(&nested);
        assert!(missing(&nested, 8).is_empty());

        let modern = root.path().join("jdk-17");
        touch(&modern.join("release"));
        touch(&modern.join("jre").join("lib").join("modules"));
        let modern_nested = java_exe_in_home(&modern.join("jre"));
        touch(&modern_nested);
        assert_eq!(missing(&modern_nested, 17), vec!["release"]);
    }

    #[test]
    fn empty_java8_dir_misses_release_and_rt_jar() {
        let root = tempfile::tempdir().unwrap();
        let exe = java_exe_in_home(&root.path().join("broken8"));
        touch(&exe);
        assert_eq!(missing(&exe, 8), vec!["release", "lib/rt.jar"]);
    }

    #[test]
    fn exe_without_home_misses_everything() {
        assert_eq!(
            missing(Path::new(JAVA_EXE), 21),
            vec!["release", "lib/modules"]
        );
        assert_eq!(
            missing(Path::new(JAVA_EXE), 8),
            vec!["release", "lib/rt.jar"]
        );
    }

    /// 完整性不进缓存：补齐文件后，同一个缓存命中的安装项立刻转回完整。
    #[test]
    fn completeness_is_rechecked_on_cache_hits() {
        let root = tempfile::tempdir().unwrap();
        let home = root.path().join("17");
        let exe = java_exe_in_home(&home);
        touch(&exe);
        touch(&home.join("lib").join("modules"));
        let scope = managed_scope(root.path());
        let mut cache = ProbeCache::default();

        let found = detect_with(&scope, &mut cache, &|p: &Path| {
            CountingRunner::new(OPENJDK_17).run(p)
        });
        assert_eq!(found[0].missing_files, vec!["release"]);
        assert!(!found[0].is_complete());
        assert_eq!(cache.installations()[0].missing_files, vec!["release"]);

        touch(&home.join("release"));
        let runner = CountingRunner::new(OPENJDK_17);
        let found = detect_with(&scope, &mut cache, &|p: &Path| runner.run(p));
        assert_eq!(
            runner.calls(),
            0,
            "补的是运行时文件，java 本身没变，应命中缓存"
        );
        assert!(found[0].is_complete());
        assert!(cache.installations()[0].is_complete());
    }

    // ---- 来源 ----

    /// 只按 (hive, key) 返回预置安装根的替身注册表，并记下被问过的每一次。
    #[derive(Debug, Default)]
    struct FakeRegistry {
        homes: Vec<(RegistryHive, &'static str, PathBuf)>,
        calls: Mutex<Vec<(RegistryHive, String)>>,
    }

    impl RegistryReader for FakeRegistry {
        fn homes_under(&self, hive: RegistryHive, key: &str) -> Vec<PathBuf> {
            self.calls.lock().unwrap().push((hive, key.to_owned()));
            self.homes
                .iter()
                .filter(|(h, k, _)| *h == hive && *k == key)
                .map(|(_, _, home)| home.clone())
                .collect()
        }
    }

    fn system_scope(registry: Arc<FakeRegistry>) -> SystemSources {
        SystemSources {
            registry,
            java_home: None,
            path: None,
            search_roots: Vec::new(),
        }
    }

    fn scope_with(system: SystemSources, manual: Vec<PathBuf>) -> DetectScope {
        DetectScope {
            managed_root: None,
            manual,
            system: Some(system),
        }
    }

    const TEMURIN_KEY: &str = "SOFTWARE\\Eclipse Adoptium\\JDK";

    #[test]
    fn current_user_registry_home_is_detected_as_registry() {
        let root = tempfile::tempdir().unwrap();
        let home = root.path().join("jdk-21.0.5.11-hotspot");
        let exe = complete_home(&home);
        let registry = Arc::new(FakeRegistry {
            homes: vec![(RegistryHive::CurrentUser, TEMURIN_KEY, home)],
            ..FakeRegistry::default()
        });
        let runner = CountingRunner::new(OPENJDK_21);

        let found = detect_with(
            &scope_with(system_scope(registry.clone()), Vec::new()),
            &mut ProbeCache::default(),
            &|p: &Path| runner.run(p),
        );
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].path, exe);
        assert_eq!(found[0].source, DetectSource::Registry);
        assert!(found[0].is_complete());

        let calls = registry.calls.lock().unwrap();
        assert_eq!(
            calls.len(),
            VENDOR_KEYS.len() * 2,
            "两个根都要按整张表问一遍"
        );
        assert!(
            calls[..VENDOR_KEYS.len()]
                .iter()
                .all(|(hive, _)| *hive == RegistryHive::LocalMachine),
            "先问 HKLM"
        );
        assert!(
            calls[VENDOR_KEYS.len()..]
                .iter()
                .all(|(hive, _)| *hive == RegistryHive::CurrentUser),
            "后问 HKCU"
        );
    }

    #[test]
    fn java_home_with_quotes_and_spaces_is_detected_as_java_home() {
        let root = tempfile::tempdir().unwrap();
        let home = root.path().join("my jdk");
        let exe = complete_home(&home);
        let mut system = system_scope(Arc::new(FakeRegistry::default()));
        system.java_home = Some(OsString::from(format!("  \"{}\" ", home.display())));
        let runner = CountingRunner::new(OPENJDK_17);

        let found = detect_with(
            &scope_with(system, Vec::new()),
            &mut ProbeCache::default(),
            &|p: &Path| runner.run(p),
        );
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].path, exe);
        assert_eq!(found[0].source, DetectSource::JavaHome);
    }

    #[test]
    fn java_home_blank_or_unset_yields_no_candidate() {
        assert_eq!(java_home_dir(None), None);
        assert_eq!(java_home_dir(Some(OsStr::new(" \"\" "))), None);
        assert_eq!(
            java_home_dir(Some(OsStr::new("\"C:\\Program Files\\Java\\jdk-21\"\t"))),
            Some(PathBuf::from("C:\\Program Files\\Java\\jdk-21"))
        );
    }

    /// 手动添加的路径来源为 manual，并压过同一路径的注册表来源。
    #[test]
    fn manual_source_wins_over_registry_for_same_path() {
        let root = tempfile::tempdir().unwrap();
        let home = root.path().join("jdk-17");
        let exe = complete_home(&home);
        let registry = Arc::new(FakeRegistry {
            homes: vec![(RegistryHive::LocalMachine, "SOFTWARE\\JavaSoft\\JDK", home)],
            ..FakeRegistry::default()
        });
        let runner = CountingRunner::new(OPENJDK_17);

        let found = detect_with(
            &scope_with(system_scope(registry), vec![exe.clone()]),
            &mut ProbeCache::default(),
            &|p: &Path| runner.run(p),
        );
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].path, exe);
        assert_eq!(found[0].source, DetectSource::Manual);
        assert_eq!(runner.calls(), 1);
    }

    /// 各路来源同时存在时按 托管 > 手动 > 注册表 > JAVA_HOME > 常见目录 > PATH 排列。
    #[test]
    fn sources_are_ordered_by_priority() {
        let root = tempfile::tempdir().unwrap();
        let managed_root = root.path().join("managed");
        let managed = complete_home(&managed_root.join("17"));
        let manual = complete_home(&root.path().join("manual"));
        let registry_home = root.path().join("registry");
        let registered = complete_home(&registry_home);
        let java_home = root.path().join("java-home");
        let from_java_home = complete_home(&java_home);
        let common_root = root.path().join("common");
        let common = complete_home(&common_root.join("jdk-21"));
        let path_dir = root.path().join("on-path");
        let on_path = path_dir.join(JAVA_EXE);
        touch(&on_path);

        let system = SystemSources {
            registry: Arc::new(FakeRegistry {
                homes: vec![(RegistryHive::CurrentUser, TEMURIN_KEY, registry_home)],
                ..FakeRegistry::default()
            }),
            java_home: Some(java_home.into_os_string()),
            path: Some(std::env::join_paths([&path_dir]).unwrap()),
            search_roots: vec![common_root],
        };
        let scope = DetectScope {
            managed_root: Some(managed_root),
            manual: vec![manual.clone()],
            system: Some(system),
        };
        let runner = CountingRunner::new(OPENJDK_17);
        let found = detect_with(&scope, &mut ProbeCache::default(), &|p: &Path| {
            runner.run(p)
        });
        let got: Vec<(PathBuf, DetectSource)> = found
            .into_iter()
            .map(|java| (java.path, java.source))
            .collect();
        assert_eq!(
            got,
            vec![
                (managed, DetectSource::Managed),
                (manual, DetectSource::Manual),
                (registered, DetectSource::Registry),
                (from_java_home, DetectSource::JavaHome),
                (common, DetectSource::CommonDir),
                (on_path, DetectSource::Path),
            ]
        );
    }

    #[test]
    fn javapath_forwarder_on_path_is_skipped() {
        let root = tempfile::tempdir().unwrap();
        let forwarder = root
            .path()
            .join("Common Files")
            .join("Oracle")
            .join("Java")
            .join("javapath");
        touch(&forwarder.join(JAVA_EXE));
        let upper = root.path().join("ProgramData").join("JavaPath");
        touch(&upper.join(JAVA_EXE));
        let real = root.path().join("jdk-21").join("bin");
        touch(&real.join(JAVA_EXE));

        let joined = std::env::join_paths([&forwarder, &upper, &real]).unwrap();
        assert_eq!(
            path_javas(Some(joined.as_os_str())),
            vec![real.join(JAVA_EXE)]
        );
        // PATH 里带尾部分隔符的写法同样要认出来。
        let trailing = OsString::from(format!(
            "{}{}",
            forwarder.display(),
            std::path::MAIN_SEPARATOR
        ));
        assert!(path_javas(Some(trailing.as_os_str())).is_empty());
    }

    #[test]
    fn common_dir_scan_finds_nested_java() {
        let root = tempfile::tempdir().unwrap();
        let shallow = root.path().join("jdk-17.0.1").join("bin").join(JAVA_EXE);
        touch(&shallow);
        let deep = root
            .path()
            .join("runtime")
            .join("java-runtime-gamma")
            .join("windows-x64")
            .join("bin")
            .join(JAVA_EXE);
        touch(&deep);

        let found = common_dir_javas(&[root.path().to_path_buf()]);
        assert!(found.contains(&shallow), "应发现浅层 JDK");
        assert!(found.contains(&deep), "应发现深层 runtime 内的 java");
    }

    /// 只取每个 IDE 目录下的 jbr：没有 jbr 的目录与 jbr 不是目录的情况都不收。
    #[test]
    fn jbr_homes_lists_only_ide_dirs_with_jbr() {
        let root = tempfile::tempdir().unwrap();
        let idea = root.path().join("IntelliJ IDEA Ultimate");
        std::fs::create_dir_all(idea.join("jbr").join("bin")).unwrap();
        let pycharm = root.path().join("PyCharm Community");
        std::fs::create_dir_all(pycharm.join("jbr")).unwrap();
        std::fs::create_dir_all(root.path().join("Microsoft VS Code").join("resources")).unwrap();
        touch(&root.path().join("Odd").join("jbr"));

        let mut found = jbr_homes(root.path());
        found.sort();
        assert_eq!(found, vec![idea.join("jbr"), pycharm.join("jbr")]);
        assert!(jbr_homes(&root.path().join("does-not-exist")).is_empty());
    }

    #[test]
    fn default_roots_do_not_include_data_dir() {
        // 托管目录由 DetectScope 单独给出；常见目录里再列一遍会让它的来源被记成 CommonDir。
        let data = aurora_base::fs::data_dir().unwrap();
        let roots = default_search_roots();
        assert!(
            !roots.iter().any(|root| root.starts_with(&data)),
            "常见目录不应包含数据目录下的任何位置：{roots:?}"
        );
    }

    #[test]
    fn default_roots_have_no_duplicates() {
        let roots = default_search_roots();
        let unique: HashSet<String> = roots
            .iter()
            .map(|root| root.to_string_lossy().to_lowercase())
            .collect();
        assert_eq!(unique.len(), roots.len(), "{roots:?}");
    }

    #[test]
    fn path_javas_reads_split_paths() {
        let dir_a = tempfile::tempdir().unwrap();
        let dir_b = tempfile::tempdir().unwrap();
        let exe_a = dir_a.path().join(JAVA_EXE);
        touch(&exe_a);

        let joined = std::env::join_paths([dir_a.path(), dir_b.path()]).unwrap();
        let found = path_javas(Some(joined.as_os_str()));
        assert_eq!(found, vec![exe_a]);
    }

    #[test]
    fn path_javas_none_is_empty() {
        assert!(path_javas(None).is_empty());
    }
}
