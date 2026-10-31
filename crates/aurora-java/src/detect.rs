//! Java 安装探测：托管目录 / 注册表 / 常见安装目录 / PATH 四路，产出 [`JavaInstallation`] 列表。
//!
//! 每条候选最终都要跑一次 `java -version` 才算数——只有能正常执行并解析出版本的才收录。
//! 四路探测只负责产出「候选可执行文件路径」，识别交给 [`probe_cached`]。
//!
//! 识别是这里最贵的一步：每次 `java -version` 都要拉起一个 JVM，实测单次 110-130 ms，机器上有几个
//! JDK 就串几次。所以两件事：未命中缓存的候选并发识别（[`MAX_PROBE_WORKERS`]）；识别结果按
//! 「路径 + 文件大小 + 修改时间」记进 [`ProbeCache`]，同一个 java 可执行文件没变就不再拉起 JVM。
//!
//! 注册表读取是 Windows 专属能力，用 `#[cfg(windows)]` 隔开；非 Windows 平台给一个返回空的
//! 桩，保证 crate 仍能在其它平台编译。

use std::collections::{BTreeMap, HashSet};
use std::ffi::OsStr;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::UNIX_EPOCH;

use serde::{Deserialize, Serialize};

use crate::error::{Error, Result};
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
    /// 来自 Windows 注册表 JavaSoft/发行版键。
    Registry,
    /// 来自常见安装目录扫描。
    CommonDir,
    /// 来自 PATH 环境变量。
    Path,
    /// 由本启动器下载安装到数据目录的运行时。
    Managed,
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
}

/// 「执行一次 `java -version` 并返回输出」的函数。抽成参数是为了让测试注入固定输出，
/// 绕开真实子进程；需要 `Sync` 是因为识别在多个线程上并发进行。
pub type JavaRunner<'a> = dyn Fn(&Path) -> Result<String> + Sync + 'a;

/// 探测范围。
#[derive(Debug, Clone, Default)]
pub struct DetectScope {
    /// 托管运行时根目录（[`managed_runtime_root`]）；`None` 表示不扫托管目录。
    pub managed_root: Option<PathBuf>,
    /// 是否扫系统位置（注册表、常见安装目录、PATH）。测试关掉它，避免结果随测试机变化。
    pub system: bool,
}

impl DetectScope {
    /// 生产范围：托管目录 + 全部系统位置。
    pub fn system_with_managed(managed_root: PathBuf) -> Self {
        Self {
            managed_root: Some(managed_root),
            system: true,
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
        system: true,
    };
    detect_with(&scope, &mut ProbeCache::default(), &run_java_version)
}

/// 按范围探测：收集候选、按规范化路径去重、命中缓存的直接复用、其余并发识别，并把结果写回缓存。
///
/// 结果按候选顺序排列（托管 > 注册表 > 常见目录 > PATH），与识别的完成先后无关。单个候选识别失败
/// 不中断整体（一个坏 Java 不该拖垮全部探测），只记 debug 日志跳过。缓存里本次没再出现的路径会被
/// 清掉：卸载了的 Java 不该在下次启动时被当成「已知可用」。
pub fn detect_with(
    scope: &DetectScope,
    cache: &mut ProbeCache,
    runner: &JavaRunner<'_>,
) -> Vec<JavaInstallation> {
    let found = probe_candidates(collect_candidates(scope), cache, runner);
    let keep: HashSet<String> = found.iter().map(|java| canonical_key(&java.path)).collect();
    cache.entries.retain(|key, _| keep.contains(key));
    found
}

/// 对单个 java 可执行文件跑 `java -version` 并解析成 [`JavaInstallation`]，不经缓存。
pub fn probe(path: &Path, source: DetectSource) -> Result<JavaInstallation> {
    probe_cached(path, source, &mut ProbeCache::default(), &run_java_version)
}

/// 识别单个 java 可执行文件：文件大小与修改时间都与缓存一致时直接复用缓存，否则执行一次识别并更新缓存。
///
/// 启动路径只用它校验最终选中的那一个 Java，不跑全量探测。
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
    let probed = parse_java_version_output(&runner(path)?)?;
    let entry = CachedProbe::new(fingerprint, source, probed);
    let installation = entry.to_installation(path, source);
    cache.store(key, path, entry);
    Ok(installation)
}

/// 实际执行 `java -version`，把 stderr（Java 主要往这里打）与 stdout 拼在一起返回。
pub fn run_java_version(path: &Path) -> Result<String> {
    let mut cmd = std::process::Command::new(path);
    cmd.arg("-version");
    configure_no_window(&mut cmd);
    let output = cmd.output().map_err(|source| Error::JavaExec {
        path: path.to_path_buf(),
        source,
    })?;
    let mut combined = String::from_utf8_lossy(&output.stderr).into_owned();
    combined.push_str(&String::from_utf8_lossy(&output.stdout));
    Ok(combined)
}

// ---- 探测缓存 ----

/// java 可执行文件的识别缓存，键为规范化后的小写路径。可序列化，由上层落盘。
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProbeCache {
    entries: BTreeMap<String, CachedProbe>,
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
        }
    }
}

/// 文件指纹 `(大小, 修改时间毫秒)`。平台给不出修改时间时为 `None`，此时不缓存、每次都识别——
/// 没有指纹就无从判断文件换没换过，宁可多跑一次 JVM 也不能拿旧结果冒充。
type Fingerprint = Option<(u64, u64)>;

fn fingerprint(path: &Path) -> Result<Fingerprint> {
    let meta = std::fs::metadata(path).map_err(|source| Error::JavaExec {
        path: path.to_path_buf(),
        source,
    })?;
    let modified = meta
        .modified()
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .and_then(|elapsed| u64::try_from(elapsed.as_millis()).ok());
    Ok(modified.map(|ms| (meta.len(), ms)))
}

// ---- 内部：候选 -> 安装项 ----

/// 去重、过滤不存在的路径后，命中缓存的直接收下，其余交给并发识别；输出保持候选顺序。
fn probe_candidates(
    candidates: Vec<(PathBuf, DetectSource)>,
    cache: &mut ProbeCache,
    runner: &JavaRunner<'_>,
) -> Vec<JavaInstallation> {
    let mut seen: HashSet<String> = HashSet::new();
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
        match cache.lookup(&key, fingerprint) {
            Some(hit) => slots.push(Some(hit.to_installation(&exe, source))),
            None => {
                misses.push(Miss {
                    slot: slots.len(),
                    key,
                    exe,
                    source,
                    fingerprint,
                });
                slots.push(None);
            }
        }
    }

    for (miss, outcome) in probe_concurrently(&misses, runner) {
        match outcome {
            Ok(probed) => {
                let entry = CachedProbe::new(miss.fingerprint, miss.source, probed);
                slots[miss.slot] = Some(entry.to_installation(&miss.exe, miss.source));
                cache.store(miss.key.clone(), &miss.exe, entry);
            }
            Err(err) => {
                tracing::debug!(path = %miss.exe.display(), error = %err, "跳过无法识别为 Java 的候选");
            }
        }
    }
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

/// 收集候选：托管目录在最前，去重时保住 Managed 来源；其后注册表、常见目录、PATH。
fn collect_candidates(scope: &DetectScope) -> Vec<(PathBuf, DetectSource)> {
    let mut candidates = Vec::new();
    if let Some(root) = &scope.managed_root {
        for exe in common_dir_javas(std::slice::from_ref(root)) {
            candidates.push((exe, DetectSource::Managed));
        }
    }
    if scope.system {
        for home in registry_java_homes() {
            candidates.push((java_exe_in_home(&home), DetectSource::Registry));
        }
        for exe in common_dir_javas(&default_search_roots()) {
            candidates.push((exe, DetectSource::CommonDir));
        }
        for exe in path_javas(std::env::var_os("PATH").as_deref()) {
            candidates.push((exe, DetectSource::Path));
        }
    }
    candidates
}

/// 探测时抑制子进程的控制台窗口，避免每识别一个 Java 就闪一下黑框。
#[cfg(windows)]
fn configure_no_window(cmd: &mut std::process::Command) {
    use std::os::windows::process::CommandExt;
    // CREATE_NO_WINDOW，避免控制台子进程弹窗。
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    cmd.creation_flags(CREATE_NO_WINDOW);
}

#[cfg(not(windows))]
fn configure_no_window(_cmd: &mut std::process::Command) {}

/// 去重与缓存键：优先用规范化后的绝对路径，失败退回原路径；统一小写（Windows 路径大小写不敏感）。
fn canonical_key(exe: &Path) -> String {
    std::fs::canonicalize(exe)
        .unwrap_or_else(|_| exe.to_path_buf())
        .to_string_lossy()
        .to_lowercase()
}

// ---- 系统位置：候选路径产出 ----

/// 从 Windows 注册表读取各发行版登记的 Java 安装根目录（JavaHome / InstallationPath）。
#[cfg(windows)]
fn registry_java_homes() -> Vec<PathBuf> {
    use winreg::RegKey;
    use winreg::enums::{HKEY_LOCAL_MACHINE, KEY_READ, KEY_WOW64_32KEY, KEY_WOW64_64KEY};

    // JavaSoft 是 Oracle/官方登记处；其余是常见发行版自建的登记键。
    const VENDOR_KEYS: &[&str] = &[
        "SOFTWARE\\JavaSoft\\Java Runtime Environment",
        "SOFTWARE\\JavaSoft\\Java Development Kit",
        "SOFTWARE\\JavaSoft\\JRE",
        "SOFTWARE\\JavaSoft\\JDK",
        "SOFTWARE\\Eclipse Adoptium\\JDK",
        "SOFTWARE\\Eclipse Adoptium\\JRE",
        "SOFTWARE\\Eclipse Foundation\\JDK",
        "SOFTWARE\\Microsoft\\JDK",
        "SOFTWARE\\Azul Systems\\Zulu",
        "SOFTWARE\\BellSoft\\Liberica",
        "SOFTWARE\\Amazon Corretto",
    ];

    let mut homes = Vec::new();
    // 64 位与 32 位两套注册表视图都扫，兼顾 32 位 JVM 登记在 WOW6432Node 的情况。
    for view in [KEY_WOW64_64KEY, KEY_WOW64_32KEY] {
        let hklm = RegKey::predef(HKEY_LOCAL_MACHINE);
        for base in VENDOR_KEYS {
            let Ok(key) = hklm.open_subkey_with_flags(base, KEY_READ | view) else {
                continue;
            };
            for name in key.enum_keys().flatten() {
                let Ok(sub) = key.open_subkey_with_flags(&name, KEY_READ | view) else {
                    continue;
                };
                let home = sub
                    .get_value::<String, _>("JavaHome")
                    .or_else(|_| sub.get_value::<String, _>("InstallationPath"));
                if let Ok(home) = home {
                    homes.push(PathBuf::from(home));
                }
            }
        }
    }
    homes
}

/// 非 Windows 平台没有注册表探测，返回空（跨平台缝）。
#[cfg(not(windows))]
fn registry_java_homes() -> Vec<PathBuf> {
    Vec::new()
}

/// 组装常见安装目录候选根：系统 JDK 安装位、各启动器/工具的 runtime 目录。
///
/// 本启动器自己的托管目录不在这里：它由 [`DetectScope::managed_root`] 单独给出，来源记为 Managed。
fn default_search_roots() -> Vec<PathBuf> {
    let env_dir = |key: &str| std::env::var_os(key).map(PathBuf::from);
    let mut roots = Vec::new();

    // 系统级 JDK 安装根（各发行版直接装在 Program Files 下）。
    for key in ["ProgramFiles", "ProgramFiles(x86)", "ProgramW6432"] {
        let Some(base) = env_dir(key) else { continue };
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
    }

    // 官方启动器与常见工具的 runtime 目录。
    if let Some(appdata) = env_dir("APPDATA") {
        roots.push(appdata.join(".minecraft").join("runtime"));
    }
    if let Some(profile) = env_dir("USERPROFILE") {
        // IntelliJ 下载的 JDK、scoop 安装的 java。
        roots.push(profile.join(".jdks"));
        roots.push(profile.join("scoop").join("apps"));
    }

    roots
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

/// 从 PATH 环境变量各目录下取 `java` 可执行文件。
fn path_javas(path_var: Option<&OsStr>) -> Vec<PathBuf> {
    let Some(var) = path_var else {
        return Vec::new();
    };
    std::env::split_paths(var)
        .map(|dir| dir.join(JAVA_EXE))
        .filter(|exe| exe.is_file())
        .collect()
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
            system: false,
        }
    }

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
                (bad, DetectSource::CommonDir),
            ],
            &mut cache,
            &runner,
        );
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].path, good);
        assert_eq!(cache.len(), 1, "识别失败的候选不进缓存");
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
