//! Java 探测、启动时取 Java 与运行时下载的门面接口。
//!
//! - [`Petalfall::detect_java`]：设置页与首次启动用的全量探测（托管目录 + 手动添加 + 注册表 + JAVA_HOME +
//!   常见目录 + PATH）。
//! - [`Petalfall::inspect_manual_java`]：设置页「添加 Java」识别用户选的 java 可执行文件；记下它由
//!   [`Petalfall::add_extra_java_path`] 写进配置，之后的全量探测把它算作手动添加的来源。
//! - [`Petalfall::resolve_java`]：启动与安装器取 Java。只校验最终选中的那一个，不在启动路径上跑全量探测：
//!   设置里固定了默认 Java 就用它；否则先在上次探测的结果里按主版本挑、再看托管目录里有没有这个主版本，
//!   都没有才全量探测，仍没有且开着自动下载就下一个。
//! - [`Petalfall::install_java`]：把 Mojang 运行时下到托管目录 `<数据目录>/runtime/<主版本>`，
//!   文件交给下载池并发下载（换源、进度、取消、已就绪文件按 sha1 跳过）。
//!
//! 识别结果按文件指纹落盘在 `<数据目录>/java-probe-cache.json`：同一个 java 可执行文件没变就不再
//! 拉起 JVM 去问版本，第二次启动取 Java 只剩一次 stat。

use std::path::{Path, PathBuf};
use std::sync::Arc;

use petalfall_download::DownloadTask;
use petalfall_java::{
    DetectScope, DetectSource, InstalledRuntime, JAVA_EXE, JavaInstallation, ProbeCache,
    RuntimePlan, SystemSources, detect_with, java_exe_in_home, managed_runtime_root, probe_cached,
    rank_for_major, select_for_major,
};

use crate::error::{CoreError, JavaPathProblem, Result};
use crate::event::{CoreEvent, EventSink, emit};
use crate::facade::Petalfall;

/// 探测缓存文件名，位于数据目录下。
const PROBE_CACHE_FILE: &str = "java-probe-cache.json";

/// 不带控制台窗口的 Java 启动器文件名。用户在「添加 Java」里选它时按同目录的 java 记下：
/// 启动链路拉起的是 java，显卡偏好也要写给真正拉起的那个文件，同一个 Java 也不该记成两条。
#[cfg(windows)]
const JAVAW_EXE: &str = "javaw.exe";
#[cfg(not(windows))]
const JAVAW_EXE: &str = "javaw";

/// 从手动添加的 Java 列表里移除一项的结果。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RemovedJavaPath {
    /// 列表里有这一项，已移除。
    pub removed: bool,
    /// 全局默认 Java 正是它，已改回按版本自动选择。
    pub default_reset: bool,
}

/// 执行一次 `java -version` 的函数；在阻塞线程池里跨线程调用，故要 `Send + Sync + 'static`。
type SharedRunner = Arc<dyn Fn(&Path) -> petalfall_java::Result<String> + Send + Sync>;

/// 探测环境。生产用 [`Petalfall::java_env`]：真实子进程、扫系统位置、官方运行时清单；
/// 测试注入假运行器、关掉系统位置、把清单指向本地 mock，结果才不随测试机上装了什么 Java 而变。
#[derive(Clone)]
pub(crate) struct JavaEnv {
    runner: SharedRunner,
    system: bool,
    runtime_manifest: String,
}

impl Petalfall {
    fn java_env(&self) -> JavaEnv {
        JavaEnv {
            runner: Arc::new(petalfall_java::run_java_version),
            system: true,
            runtime_manifest: self.java_runtime_url().to_owned(),
        }
    }

    /// 全量探测本机可用 Java，结果按「托管 > 手动添加 > 注册表 > JAVA_HOME > 常见目录 > PATH」排列。
    ///
    /// 单个坏 Java 不会中断整体扫描（petalfall-java 内部按候选跳过），空列表即「本机没有 Java」。
    /// 缺运行时文件的 Java 照样列出（`missing_files` 非空），由挑选与界面跳过。
    pub async fn detect_java(&self) -> Result<Vec<JavaInstallation>> {
        self.detect_java_with(&self.java_env()).await
    }

    pub(crate) async fn detect_java_with(&self, env: &JavaEnv) -> Result<Vec<JavaInstallation>> {
        let cache = load_probe_cache(self.data_dir()).await;
        let scope = self.detect_scope(env);
        let runner = env.runner.clone();
        let (found, cache) = tokio::task::spawn_blocking(move || {
            let mut cache = cache;
            let found = detect_with(&scope, &mut cache, &*runner);
            (found, cache)
        })
        .await?;
        save_probe_cache(self.data_dir(), &cache).await;
        Ok(found)
    }

    /// 启动与安装器取 Java：返回 `(参与启动前检查的 Java 列表, 选中的 java 可执行文件)`。
    ///
    /// 列表里只有选中的那一个：启动前检查要核对的正是「这次真正要用的 Java」与版本要求是否匹配。
    pub async fn resolve_java(
        &self,
        required_major: u32,
        events: Option<&EventSink>,
    ) -> Result<(Vec<JavaInstallation>, PathBuf)> {
        self.resolve_java_with(required_major, events, &self.java_env())
            .await
    }

    pub(crate) async fn resolve_java_with(
        &self,
        required_major: u32,
        events: Option<&EventSink>,
        env: &JavaEnv,
    ) -> Result<(Vec<JavaInstallation>, PathBuf)> {
        let cache = load_probe_cache(self.data_dir()).await;
        let fixed = self.config().default_java.clone();
        let managed_exe = java_exe_in_home(&runtime_install_dir(self.data_dir(), required_major));
        let managed_root = managed_runtime_root(self.data_dir());
        let scope = self.detect_scope(env);
        let runner = env.runner.clone();
        let (found, cache) = tokio::task::spawn_blocking(move || {
            let mut cache = cache;
            let found = pick_local_java(
                required_major,
                fixed.as_deref(),
                &managed_exe,
                &managed_root,
                &scope,
                &mut cache,
                &*runner,
            );
            (found, cache)
        })
        .await?;
        save_probe_cache(self.data_dir(), &cache).await;

        if let Some(picked) = found? {
            emit(
                events,
                CoreEvent::stage(format!(
                    "使用{} Java {}：{}",
                    if picked.fixed {
                        "设置里指定的"
                    } else {
                        "本地"
                    },
                    picked.java.version.major,
                    picked.java.path.display()
                )),
            );
            let path = picked.java.path.clone();
            return Ok((vec![picked.java], path));
        }

        if !self.config().auto_download_java {
            return Err(CoreError::NoJava {
                major: required_major,
            });
        }
        emit(
            events,
            CoreEvent::stage(format!(
                "本地未找到 Java {required_major}，开始下载 Mojang 运行时"
            )),
        );
        let runtime = self
            .install_java_from(required_major, env.runtime_manifest.clone(), events)
            .await?;

        let mut cache = load_probe_cache(self.data_dir()).await;
        let runner = env.runner.clone();
        let exe = runtime.java_executable.clone();
        let (probed, cache) = tokio::task::spawn_blocking(move || {
            let probed = probe_cached(&exe, DetectSource::Managed, &mut cache, &*runner);
            (probed, cache)
        })
        .await?;
        save_probe_cache(self.data_dir(), &cache).await;
        let java = probed?;
        let path = java.path.clone();
        Ok((vec![java], path))
    }

    /// 下载并安装匹配 `required_major` 的 Mojang 运行时到托管目录，返回安装产物。
    ///
    /// 总会走一遍清单（这是「设置里手动补一个运行时」的显式意图），但已就绪的文件按 sha1 跳过，
    /// 重复点击不会整套重下。
    pub async fn install_java(
        &self,
        required_major: u32,
        events: Option<&EventSink>,
    ) -> Result<InstalledRuntime> {
        self.install_java_from(required_major, self.java_runtime_url().to_owned(), events)
            .await
    }

    /// [`install_java`](Self::install_java) 的清单地址可注入内核，供单测指向本地 mock。
    pub(crate) async fn install_java_from(
        &self,
        required_major: u32,
        manifest_url: String,
        events: Option<&EventSink>,
    ) -> Result<InstalledRuntime> {
        let install_dir = runtime_install_dir(self.data_dir(), required_major);
        emit(
            events,
            CoreEvent::stage(format!(
                "开始下载 Java {required_major} 运行时到 {}",
                install_dir.display()
            )),
        );
        self.prepare_sources().await?;
        let plan = self
            .java_installer(&manifest_url)
            .plan(required_major, &install_dir)
            .await?;
        let tasks = runtime_download_tasks(&plan);
        let report = self
            .download_pool_reporting(events)
            .download_all(tasks, None)
            .await?;
        if let Some(failure) = report.failures.into_iter().next() {
            return Err(failure.error.into());
        }
        plan.finalize().await?;
        emit(
            events,
            CoreEvent::stage(format!(
                "Java {required_major} 运行时安装完成：{}",
                plan.java_executable.display()
            )),
        );
        Ok(plan.installed())
    }

    /// 识别用户在「添加 Java」里选的文件，通过后返回来源为手动添加的安装项。
    ///
    /// 依次检查：绝对路径；文件名是 java 或 javaw（不区分大小写，javaw 换成同目录的 java）；文件存在；
    /// 识别得出版本（`java -version` 最多等 [`petalfall_java::PROBE_TIMEOUT`]，文件没变过时用识别缓存）；
    /// 运行时文件齐全。只识别不记录：写进配置由调用方经 [`Petalfall::add_extra_java_path`] 落盘。
    pub async fn inspect_manual_java(&self, path: &Path) -> Result<JavaInstallation> {
        self.inspect_manual_java_with(path, &self.java_env()).await
    }

    pub(crate) async fn inspect_manual_java_with(
        &self,
        path: &Path,
        env: &JavaEnv,
    ) -> Result<JavaInstallation> {
        let invalid = |path: &Path, reason| CoreError::JavaPathInvalid {
            path: path.to_path_buf(),
            reason,
            source: None,
        };
        if !path.is_absolute() {
            return Err(invalid(path, JavaPathProblem::NotAbsolute));
        }
        let Some(exe) = manual_java_exe(path) else {
            return Err(invalid(path, JavaPathProblem::NotJavaExecutable));
        };
        match tokio::fs::metadata(&exe).await {
            Ok(meta) if meta.is_file() => {}
            Ok(_) => return Err(invalid(&exe, JavaPathProblem::NotFound)),
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
                return Err(invalid(&exe, JavaPathProblem::NotFound));
            }
            Err(source) => {
                return Err(petalfall_base::Error::Io { path: exe, source }.into());
            }
        }

        let cache = load_probe_cache(self.data_dir()).await;
        let runner = env.runner.clone();
        let probe_exe = exe.clone();
        let (probed, cache) = tokio::task::spawn_blocking(move || {
            let mut cache = cache;
            let probed = probe_cached(&probe_exe, DetectSource::Manual, &mut cache, &*runner);
            (probed, cache)
        })
        .await?;
        save_probe_cache(self.data_dir(), &cache).await;
        let java = probed.map_err(|err| CoreError::JavaPathInvalid {
            path: exe.clone(),
            reason: match err {
                petalfall_java::Error::JavaProbeTimeout { .. } => JavaPathProblem::ProbeTimeout,
                _ => JavaPathProblem::ProbeFailed,
            },
            source: Some(err),
        })?;
        if !java.is_complete() {
            return Err(CoreError::JavaRuntimeIncomplete {
                path: exe,
                missing: java.missing_files,
            });
        }
        Ok(java)
    }

    /// 把手动添加的 java 可执行文件记进配置；按路径不区分大小写去重，已在列表里时返回 `false`。
    /// 落盘仍需调用 [`Petalfall::save_config`]。
    pub fn add_extra_java_path(&mut self, exe: PathBuf) -> bool {
        let paths = &mut self.config_mut().extra_java_paths;
        if paths.iter().any(|known| same_path(known, &exe)) {
            return false;
        }
        paths.push(exe);
        true
    }

    /// 从手动添加的列表里移除这一项（只删记录，不动磁盘文件）。全局默认 Java 正是它时一并改回按版本
    /// 自动选择：留着一个用户刚移除的固定 Java，下次启动会被当成指定的 Java 去用。
    /// 落盘仍需调用 [`Petalfall::save_config`]。
    pub fn remove_extra_java_path(&mut self, exe: &Path) -> RemovedJavaPath {
        let config = self.config_mut();
        let before = config.extra_java_paths.len();
        config
            .extra_java_paths
            .retain(|known| !same_path(known, exe));
        let removed = config.extra_java_paths.len() != before;
        let default_reset = removed
            && config
                .default_java
                .as_deref()
                .is_some_and(|default| same_path(default, exe));
        if default_reset {
            config.default_java = None;
        }
        RemovedJavaPath {
            removed,
            default_reset,
        }
    }

    fn detect_scope(&self, env: &JavaEnv) -> DetectScope {
        DetectScope {
            managed_root: Some(managed_runtime_root(self.data_dir())),
            manual: self.config().extra_java_paths.clone(),
            system: env.system.then(SystemSources::from_env),
        }
    }
}

/// 用户选的文件规范成要记下的 java 可执行文件：java 原样，javaw 换成同目录的 java；别的文件为 `None`。
fn manual_java_exe(path: &Path) -> Option<PathBuf> {
    let name = path.file_name()?.to_str()?;
    if name.eq_ignore_ascii_case(JAVA_EXE) {
        Some(path.to_path_buf())
    } else if name.eq_ignore_ascii_case(JAVAW_EXE) {
        Some(path.with_file_name(JAVA_EXE))
    } else {
        None
    }
}

/// Windows 路径不区分大小写：同一个 Java 换了大小写也是同一条记录。
fn same_path(a: &Path, b: &Path) -> bool {
    a.to_string_lossy().to_lowercase() == b.to_string_lossy().to_lowercase()
}

/// 本地挑到的 Java，`fixed` 表示来自设置里的固定默认 Java。
struct Picked {
    java: JavaInstallation,
    fixed: bool,
}

/// 按优先级在本地找 Java，全程同步（在阻塞线程池里跑）。
///
/// 固定默认 Java 识别失败直接报错：用户明确指定了它，静默换一个别的就是在违背设置。
/// 其余几步找不到都只是「本地没有」，返回 `Ok(None)` 交给自动下载。
fn pick_local_java(
    required_major: u32,
    fixed: Option<&Path>,
    managed_exe: &Path,
    managed_root: &Path,
    scope: &DetectScope,
    cache: &mut ProbeCache,
    runner: &petalfall_java::JavaRunner<'_>,
) -> Result<Option<Picked>> {
    if let Some(path) = fixed {
        let source = if path.starts_with(managed_root) {
            DetectSource::Managed
        } else {
            DetectSource::CommonDir
        };
        let java = probe_cached(path, source, cache, runner)?;
        // 不完整也照用：用户明确指定了它，缺的文件未必影响启动，真起不来时启动失败会说明。
        if !java.is_complete() {
            tracing::warn!(path = %path.display(), missing = ?java.missing_files, "设置里指定的 Java 缺少运行时文件，可能没装完整");
        }
        return Ok(Some(Picked { java, fixed: true }));
    }

    // 上次探测的结果里按主版本从好到差逐个校验：文件没变只是一次 stat，被删了就试下一个。
    // 完整性每次现查：缓存里的那个 Java 之后被删掉了运行时文件，也不该再被自动选中。
    let known = cache.installations();
    for candidate in rank_for_major(&known, required_major) {
        match probe_cached(&candidate.path, candidate.source, cache, runner) {
            Ok(java) if java.version.major == required_major && java.is_complete() => {
                return Ok(Some(Picked { java, fixed: false }));
            }
            Ok(_) => {}
            Err(err) => {
                tracing::debug!(path = %candidate.path.display(), error = %err, "缓存里的 Java 已不可用");
            }
        }
    }

    if managed_exe.is_file() {
        match probe_cached(managed_exe, DetectSource::Managed, cache, runner) {
            Ok(java) if java.version.major == required_major && java.is_complete() => {
                return Ok(Some(Picked { java, fixed: false }));
            }
            // 托管运行时缺文件时交给自动下载：已就绪的文件按 sha1 跳过，重下一遍就是补齐。
            Ok(java) if java.version.major == required_major => tracing::warn!(
                path = %managed_exe.display(),
                missing = ?java.missing_files,
                "托管运行时缺少运行时文件，交给自动下载补齐"
            ),
            Ok(java) => tracing::warn!(
                path = %managed_exe.display(),
                found = java.version.major,
                required_major,
                "托管目录里的运行时主版本与目录名不符"
            ),
            Err(err) => {
                tracing::warn!(path = %managed_exe.display(), error = %err, "托管运行时识别失败")
            }
        }
    }

    let all = detect_with(scope, cache, runner);
    Ok(select_for_major(&all, required_major).map(|java| Picked {
        java: java.clone(),
        fixed: false,
    }))
}

/// 托管 Java 运行时的安装目录：`<数据目录>/runtime/<主版本>`。
pub(crate) fn runtime_install_dir(data_dir: &Path, required_major: u32) -> PathBuf {
    managed_runtime_root(data_dir).join(required_major.to_string())
}

/// 运行时计划里的文件换成下载池的任务（带 sha1 与已知大小）。设置里手动安装与启动时自动下载
/// 共用这一份：两条路径的并发、换源与进度应当完全一样。
pub(crate) fn runtime_download_tasks(plan: &RuntimePlan) -> Vec<DownloadTask> {
    plan.files
        .iter()
        .map(|file| {
            let task = DownloadTask::new(&file.url, &file.path).with_sha1(&file.sha1);
            match file.size {
                Some(size) => task.with_size(size),
                None => task,
            }
        })
        .collect()
}

/// 探测缓存是派生数据：缺失从空开始；损坏记一条告警后丢弃，下次探测会重建。
async fn load_probe_cache(data_dir: &Path) -> ProbeCache {
    let path = data_dir.join(PROBE_CACHE_FILE);
    match tokio::fs::read(&path).await {
        Ok(bytes) => match serde_json::from_slice(&bytes) {
            Ok(cache) => cache,
            Err(err) => {
                tracing::warn!(path = %path.display(), error = %err, "Java 探测缓存损坏，已丢弃重建");
                ProbeCache::default()
            }
        },
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => ProbeCache::default(),
        Err(err) => {
            tracing::warn!(path = %path.display(), error = %err, "读不了 Java 探测缓存，本次全部重新识别");
            ProbeCache::default()
        }
    }
}

/// 缓存写不进去只记告警：探测结果已经在手，丢了缓存只是下次多拉起几个 JVM。
async fn save_probe_cache(data_dir: &Path, cache: &ProbeCache) {
    let path = data_dir.join(PROBE_CACHE_FILE);
    match serde_json::to_vec(cache) {
        Ok(bytes) => {
            if let Err(err) = petalfall_base::fs::atomic_write(&path, &bytes).await {
                tracing::warn!(path = %path.display(), error = %err, "Java 探测缓存写盘失败");
            }
        }
        Err(err) => tracing::warn!(error = %err, "序列化 Java 探测缓存失败"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::PetalfallConfig;
    use sha1::{Digest, Sha1};
    use std::sync::atomic::{AtomicUsize, Ordering};
    use tokio::sync::mpsc;
    use wiremock::matchers::{method, path as match_path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    const OPENJDK_17: &str = "openjdk version \"17.0.8\" 2023-07-18\n\
        OpenJDK 64-Bit Server VM Microsoft-8035246 (build 17.0.8+7-LTS, mixed mode)\n";
    const RELEASE_BODY: &[u8] = b"JAVA_VERSION=\"17.0.8\"\n";
    const MODULES_BODY: &[u8] = b"fake modules image";

    fn sha1_hex(bytes: &[u8]) -> String {
        let mut hasher = Sha1::new();
        hasher.update(bytes);
        hasher
            .finalize()
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect()
    }

    async fn mount_get(server: &MockServer, p: &str, body: Vec<u8>) {
        Mock::given(method("GET"))
            .and(match_path(p))
            .respond_with(ResponseTemplate::new(200).set_body_bytes(body))
            .mount(server)
            .await;
    }

    /// 在 mock 上挂好一个 17 运行时（java 可执行文件、release、lib/modules，与 Mojang 运行时的根目录一样
    /// 齐全），返回清单地址与 java 可执行文件的内容。
    async fn mount_runtime(server: &MockServer) -> (String, Vec<u8>) {
        let base = server.uri();
        let platform = petalfall_java::current_platform();
        let java_bytes = b"MZ-fake-managed-java".to_vec();
        let release_bytes = RELEASE_BODY.to_vec();
        let modules_bytes = MODULES_BODY.to_vec();
        let exe_rel = format!("bin/{}", petalfall_java::JAVA_EXE);
        let file = |sha: String, size: usize, object: &str, executable: bool| {
            format!(
                r#"{{"type":"file","executable":{executable},"downloads":{{"raw":{{"sha1":"{sha}","size":{size},"url":"{base}/objects/{object}"}}}}}}"#
            )
        };
        let component_manifest = format!(
            r#"{{"files":{{"bin":{{"type":"directory"}},"lib":{{"type":"directory"}},"{exe_rel}":{},"release":{},"lib/modules":{}}}}}"#,
            file(sha1_hex(&java_bytes), java_bytes.len(), "java", true),
            file(
                sha1_hex(&release_bytes),
                release_bytes.len(),
                "release",
                false
            ),
            file(
                sha1_hex(&modules_bytes),
                modules_bytes.len(),
                "modules",
                false
            ),
        );
        let all_json = format!(
            r#"{{"{platform}":{{"java-runtime-gamma":[{{"manifest":{{"sha1":"{}","url":"{}/gamma.json"}},"version":{{"name":"17.0.8"}}}}]}}}}"#,
            sha1_hex(component_manifest.as_bytes()),
            base,
        );
        mount_get(server, "/all.json", all_json.into_bytes()).await;
        mount_get(server, "/gamma.json", component_manifest.into_bytes()).await;
        mount_get(server, "/objects/java", java_bytes.clone()).await;
        mount_get(server, "/objects/release", release_bytes).await;
        mount_get(server, "/objects/modules", modules_bytes).await;
        (format!("{base}/all.json"), java_bytes)
    }

    async fn requests_to(server: &MockServer, p: &str) -> usize {
        server
            .received_requests()
            .await
            .unwrap()
            .iter()
            .filter(|r| r.url.path() == p)
            .count()
    }

    fn counting_env(calls: Arc<AtomicUsize>, manifest: String) -> JavaEnv {
        JavaEnv {
            runner: Arc::new(move |_path: &Path| {
                calls.fetch_add(1, Ordering::SeqCst);
                Ok(OPENJDK_17.to_owned())
            }),
            system: false,
            runtime_manifest: manifest,
        }
    }

    fn petalfall_with(config: PetalfallConfig, data_dir: &Path) -> Petalfall {
        Petalfall::for_test(config, data_dir.to_path_buf(), data_dir.join(".minecraft"))
    }

    fn touch(path: &Path) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, b"stub").unwrap();
    }

    #[test]
    fn runtime_install_dir_is_under_managed_root() {
        assert_eq!(
            runtime_install_dir(Path::new("D:/data"), 17),
            Path::new("D:/data").join("runtime").join("17")
        );
        assert_eq!(
            runtime_install_dir(Path::new("/opt/x"), 8),
            Path::new("/opt/x").join("runtime").join("8")
        );
    }

    /// 托管目录里的运行时被探测到；第二次探测命中落盘的缓存，不再拉起 JVM。
    #[tokio::test]
    async fn detect_java_finds_managed_runtime_and_reuses_cache_from_disk() {
        let dir = tempfile::tempdir().unwrap();
        let exe = java_exe_in_home(&runtime_install_dir(dir.path(), 17));
        touch(&exe);
        let calls = Arc::new(AtomicUsize::new(0));
        let env = counting_env(calls.clone(), String::new());
        let petalfall = petalfall_with(PetalfallConfig::default(), dir.path());

        let found = petalfall.detect_java_with(&env).await.unwrap();
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].path, exe);
        assert_eq!(found[0].source, DetectSource::Managed);
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        assert!(dir.path().join(PROBE_CACHE_FILE).is_file());

        let again = petalfall.detect_java_with(&env).await.unwrap();
        assert_eq!(again, found);
        assert_eq!(
            calls.load(Ordering::SeqCst),
            1,
            "文件没变，第二次探测不应再跑 java -version"
        );
    }

    /// 第一次启动缺 Java 时下载；第二次启动不再下载、也不再拉起 JVM；缓存丢了也认得托管目录里的运行时。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn second_launch_reuses_downloaded_runtime_without_downloading() {
        let server = MockServer::start().await;
        let (manifest, java_bytes) = mount_runtime(&server).await;
        let dir = tempfile::tempdir().unwrap();
        let calls = Arc::new(AtomicUsize::new(0));
        let env = counting_env(calls.clone(), manifest);
        let petalfall = petalfall_with(PetalfallConfig::default(), dir.path());
        let expected = java_exe_in_home(&runtime_install_dir(dir.path(), 17));

        let (list, path) = petalfall.resolve_java_with(17, None, &env).await.unwrap();
        assert_eq!(path, expected);
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].source, DetectSource::Managed);
        assert_eq!(std::fs::read(&expected).unwrap(), java_bytes);
        assert_eq!(requests_to(&server, "/objects/java").await, 1);
        assert_eq!(calls.load(Ordering::SeqCst), 1);

        let (_, second) = petalfall.resolve_java_with(17, None, &env).await.unwrap();
        assert_eq!(second, expected);
        assert_eq!(
            requests_to(&server, "/objects/java").await,
            1,
            "第二次启动不应再下载"
        );
        assert_eq!(
            requests_to(&server, "/all.json").await,
            1,
            "第二次启动连清单都不该拉"
        );
        assert_eq!(calls.load(Ordering::SeqCst), 1, "命中缓存不拉起 JVM");

        std::fs::remove_file(dir.path().join(PROBE_CACHE_FILE)).unwrap();
        let (_, third) = petalfall.resolve_java_with(17, None, &env).await.unwrap();
        assert_eq!(third, expected);
        assert_eq!(requests_to(&server, "/objects/java").await, 1);
        assert_eq!(
            calls.load(Ordering::SeqCst),
            2,
            "缓存没了就识别托管目录里的那一个"
        );
    }

    #[tokio::test]
    async fn missing_java_without_auto_download_is_no_java() {
        let dir = tempfile::tempdir().unwrap();
        let config = PetalfallConfig {
            auto_download_java: false,
            ..PetalfallConfig::default()
        };
        let petalfall = petalfall_with(config, dir.path());
        let env = counting_env(Arc::new(AtomicUsize::new(0)), String::new());
        let err = petalfall
            .resolve_java_with(21, None, &env)
            .await
            .unwrap_err();
        assert!(
            matches!(err, CoreError::NoJava { major: 21 }),
            "实际：{err:?}"
        );
    }

    /// 固定了默认 Java 就只用它（即便托管目录里有匹配的运行时）；它不见了就报错，不悄悄换一个。
    #[tokio::test]
    async fn fixed_default_java_wins_and_fails_loudly_when_missing() {
        let dir = tempfile::tempdir().unwrap();
        touch(&java_exe_in_home(&runtime_install_dir(dir.path(), 17)));
        let fixed = dir
            .path()
            .join("jdk")
            .join("bin")
            .join(petalfall_java::JAVA_EXE);
        touch(&fixed);
        let config = PetalfallConfig {
            default_java: Some(fixed.clone()),
            ..PetalfallConfig::default()
        };
        let petalfall = petalfall_with(config, dir.path());
        let env = counting_env(Arc::new(AtomicUsize::new(0)), String::new());

        let (list, path) = petalfall.resolve_java_with(17, None, &env).await.unwrap();
        assert_eq!(path, fixed);
        assert_eq!(
            list.iter().map(|j| &j.path).collect::<Vec<_>>(),
            vec![&fixed]
        );

        std::fs::remove_file(&fixed).unwrap();
        let err = petalfall
            .resolve_java_with(17, None, &env)
            .await
            .unwrap_err();
        assert!(
            matches!(&err, CoreError::Java(petalfall_java::Error::JavaExec { path, .. }) if path == &fixed),
            "实际：{err:?}"
        );
    }

    /// 旧配置里固定的 Java 写着混合分隔符：取 Java 交出去的（启动拉起、独显偏好的值名都用它）与
    /// 界面传回来的规整路径是同一条，移除时默认 Java 跟着改回自动。
    #[cfg(windows)]
    #[tokio::test]
    async fn mixed_separators_in_an_old_config_are_settled_end_to_end() {
        let dir = tempfile::tempdir().unwrap();
        let exe = dir
            .path()
            .join("中文 目录")
            .join("bin")
            .join(petalfall_java::JAVA_EXE);
        touch(&exe);
        let expected = exe.to_str().unwrap().replace('/', "\\");
        let mixed = format!(
            "{}/bin\\{}",
            dir.path()
                .join("中文 目录")
                .to_str()
                .unwrap()
                .replace('\\', "/"),
            petalfall_java::JAVA_EXE
        );
        let file = dir.path().join("config.json");
        tokio::fs::write(
            &file,
            serde_json::to_vec(&serde_json::json!({
                "default_java": mixed,
                "extra_java_paths": [mixed],
            }))
            .unwrap(),
        )
        .await
        .unwrap();
        let config = crate::config::ConfigStore::at(&file).load().await.unwrap();
        let mut petalfall = petalfall_with(config, dir.path());
        let env = counting_env(Arc::new(AtomicUsize::new(0)), String::new());

        let (_, path) = petalfall.resolve_java_with(17, None, &env).await.unwrap();
        assert_eq!(path.to_str(), Some(expected.as_str()));

        assert_eq!(
            petalfall.remove_extra_java_path(Path::new(&expected)),
            RemovedJavaPath {
                removed: true,
                default_reset: true,
            }
        );
        assert_eq!(petalfall.config().default_java, None);
    }

    /// 安装走下载池：文件落到托管目录、发出带总数的下载进度与带产物路径的完成阶段。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn install_java_downloads_through_pool_and_reports_progress() {
        let server = MockServer::start().await;
        let (manifest, java_bytes) = mount_runtime(&server).await;
        let dir = tempfile::tempdir().unwrap();
        let petalfall = petalfall_with(PetalfallConfig::default(), dir.path());

        let (tx, mut rx) = mpsc::unbounded_channel();
        let installed = petalfall
            .install_java_from(17, manifest.clone(), Some(&tx))
            .await
            .expect("mock 安装应成功");
        assert_eq!(installed.component, "java-runtime-gamma");
        assert_eq!(installed.version.major, 17);
        let expected_exe = java_exe_in_home(&runtime_install_dir(dir.path(), 17));
        assert_eq!(installed.java_executable, expected_exe);
        assert_eq!(std::fs::read(&expected_exe).unwrap(), java_bytes);

        // 再装一次：清单照拉，文件已就绪不再下载。
        petalfall
            .install_java_from(17, manifest, None)
            .await
            .unwrap();
        assert_eq!(requests_to(&server, "/objects/java").await, 1);
        assert_eq!(requests_to(&server, "/all.json").await, 2);

        drop(tx);
        let mut stages = Vec::new();
        let mut last_download = None;
        while let Some(event) = rx.recv().await {
            match event {
                CoreEvent::Stage(message) => stages.push(message),
                CoreEvent::Download(progress) => last_download = Some(progress),
                CoreEvent::Warning(_) | CoreEvent::Phase { .. } => {}
            }
        }
        let progress = last_download.expect("应转发下载进度");
        assert_eq!(progress.total, 3);
        assert_eq!(progress.finished, 3);
        assert_eq!(
            progress.total_bytes,
            Some((java_bytes.len() + RELEASE_BODY.len() + MODULES_BODY.len()) as u64)
        );
        assert!(
            stages
                .iter()
                .any(|m| m.contains("安装完成") && m.contains(petalfall_java::JAVA_EXE)),
            "应发出带产物路径的安装完成阶段事件，实际: {stages:?}"
        );
    }

    /// 在 `dir/name` 下摆一个 Java 根目录：bin 里有 java 与 javaw；`complete` 时再放 release 与 lib/modules。
    fn jdk(dir: &Path, name: &str, complete: bool) -> PathBuf {
        let home = dir.join(name);
        let exe = java_exe_in_home(&home);
        touch(&exe);
        touch(&home.join("bin").join(JAVAW_EXE));
        if complete {
            touch(&home.join("release"));
            touch(&home.join("lib").join("modules"));
        }
        exe
    }

    /// 记下每次识别的路径，按给定的结果作答。
    fn recording_env(
        seen: Arc<std::sync::Mutex<Vec<PathBuf>>>,
        answer: fn(&Path) -> petalfall_java::Result<String>,
    ) -> JavaEnv {
        JavaEnv {
            runner: Arc::new(move |path: &Path| {
                seen.lock().unwrap().push(path.to_path_buf());
                answer(path)
            }),
            system: false,
            runtime_manifest: String::new(),
        }
    }

    fn answer_17(_path: &Path) -> petalfall_java::Result<String> {
        Ok(OPENJDK_17.to_owned())
    }

    fn reason_of(err: &CoreError) -> (JavaPathProblem, &Path, bool) {
        match err {
            CoreError::JavaPathInvalid {
                path,
                reason,
                source,
            } => (*reason, path.as_path(), source.is_some()),
            other => panic!("应是 JavaPathInvalid，实际：{other:?}"),
        }
    }

    /// 手动添加的路径写进配置后，全量探测把它列出来，来源为手动添加。
    #[tokio::test]
    async fn manual_java_in_config_is_detected_as_manual() {
        let dir = tempfile::tempdir().unwrap();
        let exe = jdk(&dir.path().join("elsewhere"), "jdk-17", true);
        let mut petalfall = petalfall_with(PetalfallConfig::default(), dir.path());
        assert!(petalfall.add_extra_java_path(exe.clone()));
        let env = counting_env(Arc::new(AtomicUsize::new(0)), String::new());

        let found = petalfall.detect_java_with(&env).await.unwrap();
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].path, exe);
        assert_eq!(found[0].source, DetectSource::Manual);
        assert_eq!(found[0].version.major, 17);
        assert!(found[0].is_complete(), "{:?}", found[0].missing_files);

        // 不在配置里就不会被探测到（系统位置关着）。
        let bare = petalfall_with(PetalfallConfig::default(), dir.path());
        assert!(bare.detect_java_with(&env).await.unwrap().is_empty());
    }

    /// 选 javaw 时按同目录的 java 识别与返回；文件名不区分大小写。
    #[tokio::test]
    async fn inspect_manual_java_records_java_for_javaw() {
        let dir = tempfile::tempdir().unwrap();
        let exe = jdk(dir.path(), "jdk-17.0.8", true);
        let javaw = exe.with_file_name(JAVAW_EXE.to_uppercase());
        let petalfall = petalfall_with(PetalfallConfig::default(), dir.path());
        let seen = Arc::new(std::sync::Mutex::new(Vec::new()));
        let env = recording_env(seen.clone(), answer_17);

        let java = petalfall
            .inspect_manual_java_with(&javaw, &env)
            .await
            .unwrap();
        assert_eq!(java.path, exe);
        assert_eq!(java.source, DetectSource::Manual);
        assert_eq!(java.version.major, 17);
        assert!(java.missing_files.is_empty());
        assert_eq!(
            *seen.lock().unwrap(),
            vec![exe.clone()],
            "识别的是 java 不是 javaw"
        );
        assert!(
            petalfall.config().extra_java_paths.is_empty(),
            "识别不写配置，记下由调用方落盘"
        );
    }

    #[tokio::test]
    async fn inspect_manual_java_reports_each_problem() {
        let dir = tempfile::tempdir().unwrap();
        let petalfall = petalfall_with(PetalfallConfig::default(), dir.path());
        let seen = Arc::new(std::sync::Mutex::new(Vec::new()));
        let env = recording_env(seen.clone(), answer_17);

        let relative = Path::new("jdk").join("bin").join(JAVA_EXE);
        let err = petalfall
            .inspect_manual_java_with(&relative, &env)
            .await
            .unwrap_err();
        assert_eq!(
            reason_of(&err),
            (JavaPathProblem::NotAbsolute, relative.as_path(), false)
        );

        let notes = dir.path().join("notes.txt");
        touch(&notes);
        let err = petalfall
            .inspect_manual_java_with(&notes, &env)
            .await
            .unwrap_err();
        assert_eq!(
            reason_of(&err),
            (JavaPathProblem::NotJavaExecutable, notes.as_path(), false)
        );
        let shell = dir.path().join("bin").join("javac.exe");
        let err = petalfall
            .inspect_manual_java_with(&shell, &env)
            .await
            .unwrap_err();
        assert_eq!(reason_of(&err).0, JavaPathProblem::NotJavaExecutable);

        // 选了 javaw，但旁边没有 java：报的是找不到那个 java。
        let lone_javaw = dir.path().join("lone").join("bin").join(JAVAW_EXE);
        touch(&lone_javaw);
        let err = petalfall
            .inspect_manual_java_with(&lone_javaw, &env)
            .await
            .unwrap_err();
        let lone_java = lone_javaw.with_file_name(JAVA_EXE);
        assert_eq!(
            reason_of(&err),
            (JavaPathProblem::NotFound, lone_java.as_path(), false)
        );
        // 叫 java.exe 的目录也不是文件。
        let folder = dir.path().join("odd").join(JAVA_EXE);
        std::fs::create_dir_all(&folder).unwrap();
        let err = petalfall
            .inspect_manual_java_with(&folder, &env)
            .await
            .unwrap_err();
        assert_eq!(reason_of(&err).0, JavaPathProblem::NotFound);
        assert!(seen.lock().unwrap().is_empty(), "前几步不通过就不拉起 JVM");

        let garbage = jdk(dir.path(), "garbage", true);
        let env = recording_env(seen.clone(), |_| Ok("not a java at all".to_owned()));
        let err = petalfall
            .inspect_manual_java_with(&garbage, &env)
            .await
            .unwrap_err();
        assert_eq!(
            reason_of(&err),
            (JavaPathProblem::ProbeFailed, garbage.as_path(), true)
        );

        let stuck = jdk(dir.path(), "stuck", true);
        let env = recording_env(seen.clone(), |path| {
            Err(petalfall_java::Error::JavaProbeTimeout {
                path: path.to_path_buf(),
                timeout_secs: petalfall_java::PROBE_TIMEOUT.as_secs(),
            })
        });
        let err = petalfall
            .inspect_manual_java_with(&stuck, &env)
            .await
            .unwrap_err();
        assert_eq!(
            reason_of(&err),
            (JavaPathProblem::ProbeTimeout, stuck.as_path(), true)
        );
        assert!(
            matches!(
                std::error::Error::source(&err)
                    .and_then(|source| source.downcast_ref::<petalfall_java::Error>()),
                Some(petalfall_java::Error::JavaProbeTimeout { .. })
            ),
            "超时的原错误挂在 source 上"
        );

        let broken = jdk(dir.path(), "broken", false);
        let err = petalfall
            .inspect_manual_java_with(&broken, &recording_env(seen, answer_17))
            .await
            .unwrap_err();
        assert!(
            matches!(
                &err,
                CoreError::JavaRuntimeIncomplete { path, missing }
                    if path == &broken && missing == &["release".to_owned(), "lib/modules".to_owned()]
            ),
            "实际：{err:?}"
        );
    }

    #[test]
    fn add_extra_java_path_dedupes_ignoring_case() {
        let dir = tempfile::tempdir().unwrap();
        let mut petalfall = petalfall_with(PetalfallConfig::default(), dir.path());
        let exe = PathBuf::from(r"D:\Java\jdk-21\bin\java.exe");
        assert!(petalfall.add_extra_java_path(exe.clone()));
        assert!(!petalfall.add_extra_java_path(exe.clone()));
        assert!(!petalfall.add_extra_java_path(PathBuf::from(r"d:\JAVA\JDK-21\BIN\JAVA.EXE")));
        let other = PathBuf::from(r"E:\zulu8\bin\java.exe");
        assert!(petalfall.add_extra_java_path(other.clone()));
        assert_eq!(petalfall.config().extra_java_paths, vec![exe, other]);
    }

    #[test]
    fn removing_the_default_java_resets_it_to_auto() {
        let dir = tempfile::tempdir().unwrap();
        let exe = PathBuf::from(r"D:\Java\jdk-21\bin\java.exe");
        let other = PathBuf::from(r"E:\zulu8\bin\java.exe");
        let config = PetalfallConfig {
            extra_java_paths: vec![exe.clone(), other.clone()],
            default_java: Some(exe.clone()),
            ..PetalfallConfig::default()
        };
        let mut petalfall = petalfall_with(config, dir.path());

        // 移除的不是默认 Java：默认不动。
        assert_eq!(
            petalfall.remove_extra_java_path(&other),
            RemovedJavaPath {
                removed: true,
                default_reset: false
            }
        );
        assert_eq!(
            petalfall.config().default_java.as_deref(),
            Some(exe.as_path())
        );

        assert_eq!(
            petalfall.remove_extra_java_path(Path::new(r"d:\java\JDK-21\bin\java.exe")),
            RemovedJavaPath {
                removed: true,
                default_reset: true
            }
        );
        assert!(petalfall.config().default_java.is_none());
        assert!(petalfall.config().extra_java_paths.is_empty());

        // 不在列表里：什么都不动，默认 Java 即便同路径也不改。
        petalfall.set_default_java(Some(exe.clone()));
        assert_eq!(
            petalfall.remove_extra_java_path(&exe),
            RemovedJavaPath {
                removed: false,
                default_reset: false
            }
        );
        assert_eq!(
            petalfall.config().default_java.as_deref(),
            Some(exe.as_path())
        );
    }

    /// 托管运行时缺了文件就不再被自动选中，交给自动下载：已就绪的文件按 sha1 跳过，只补缺的那个。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn incomplete_managed_runtime_is_repaired_by_download() {
        let server = MockServer::start().await;
        let (manifest, _) = mount_runtime(&server).await;
        let dir = tempfile::tempdir().unwrap();
        let env = counting_env(Arc::new(AtomicUsize::new(0)), manifest);
        let petalfall = petalfall_with(PetalfallConfig::default(), dir.path());
        let home = runtime_install_dir(dir.path(), 17);

        let (list, _) = petalfall.resolve_java_with(17, None, &env).await.unwrap();
        assert!(list[0].is_complete(), "{:?}", list[0].missing_files);
        assert_eq!(requests_to(&server, "/objects/release").await, 1);

        std::fs::remove_file(home.join("release")).unwrap();
        let (list, path) = petalfall.resolve_java_with(17, None, &env).await.unwrap();
        assert_eq!(path, java_exe_in_home(&home));
        assert!(list[0].is_complete());
        assert_eq!(std::fs::read(home.join("release")).unwrap(), RELEASE_BODY);
        assert_eq!(
            requests_to(&server, "/objects/release").await,
            2,
            "缺的那个重下"
        );
        assert_eq!(
            requests_to(&server, "/objects/java").await,
            1,
            "已就绪的不重下"
        );
        assert_eq!(requests_to(&server, "/objects/modules").await, 1);
    }

    /// 设置里固定的 Java 不完整也照用：用户明确指定了它。
    #[tokio::test]
    async fn incomplete_fixed_default_java_is_still_used() {
        let dir = tempfile::tempdir().unwrap();
        let fixed = jdk(dir.path(), "half-jdk", false);
        let config = PetalfallConfig {
            default_java: Some(fixed.clone()),
            auto_download_java: false,
            ..PetalfallConfig::default()
        };
        let petalfall = petalfall_with(config, dir.path());
        let env = counting_env(Arc::new(AtomicUsize::new(0)), String::new());

        let (list, path) = petalfall.resolve_java_with(17, None, &env).await.unwrap();
        assert_eq!(path, fixed);
        assert_eq!(list[0].missing_files, vec!["release", "lib/modules"]);
    }
}
