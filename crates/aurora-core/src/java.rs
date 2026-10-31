//! Java 探测、启动时取 Java 与运行时下载的门面接口。
//!
//! - [`Aurora::detect_java`]：设置页与首次启动用的全量探测（托管目录 + 注册表 + 常见目录 + PATH）。
//! - [`Aurora::resolve_java`]：启动与安装器取 Java。只校验最终选中的那一个，不在启动路径上跑全量探测：
//!   设置里固定了默认 Java 就用它；否则先在上次探测的结果里按主版本挑、再看托管目录里有没有这个主版本，
//!   都没有才全量探测，仍没有且开着自动下载就下一个。
//! - [`Aurora::install_java`]：把 Mojang 运行时下到托管目录 `<数据目录>/runtime/<主版本>`，
//!   文件交给下载池并发下载（换源、进度、取消、已就绪文件按 sha1 跳过）。
//!
//! 识别结果按文件指纹落盘在 `<数据目录>/java-probe-cache.json`：同一个 java 可执行文件没变就不再
//! 拉起 JVM 去问版本，第二次启动取 Java 只剩一次 stat。

use std::path::{Path, PathBuf};
use std::sync::Arc;

use aurora_download::DownloadTask;
use aurora_java::{
    DetectScope, DetectSource, InstalledRuntime, JavaInstallation, ProbeCache, RuntimePlan,
    detect_with, java_exe_in_home, managed_runtime_root, probe_cached, rank_for_major,
    select_for_major,
};

use crate::error::{CoreError, Result};
use crate::event::{CoreEvent, EventSink, emit};
use crate::facade::Aurora;

/// 探测缓存文件名，位于数据目录下。
const PROBE_CACHE_FILE: &str = "java-probe-cache.json";

/// 执行一次 `java -version` 的函数；在阻塞线程池里跨线程调用，故要 `Send + Sync + 'static`。
type SharedRunner = Arc<dyn Fn(&Path) -> aurora_java::Result<String> + Send + Sync>;

/// 探测环境。生产用 [`Aurora::java_env`]：真实子进程、扫系统位置、官方运行时清单；
/// 测试注入假运行器、关掉系统位置、把清单指向本地 mock，结果才不随测试机上装了什么 Java 而变。
#[derive(Clone)]
pub(crate) struct JavaEnv {
    runner: SharedRunner,
    system: bool,
    runtime_manifest: String,
}

impl Aurora {
    fn java_env(&self) -> JavaEnv {
        JavaEnv {
            runner: Arc::new(aurora_java::run_java_version),
            system: true,
            runtime_manifest: self.java_runtime_url().to_owned(),
        }
    }

    /// 全量探测本机可用 Java，结果按「托管 > 注册表 > 常见目录 > PATH」排列。
    ///
    /// 单个坏 Java 不会中断整体扫描（aurora-java 内部按候选跳过），空列表即「本机没有 Java」。
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

    fn detect_scope(&self, env: &JavaEnv) -> DetectScope {
        DetectScope {
            managed_root: Some(managed_runtime_root(self.data_dir())),
            system: env.system,
        }
    }
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
    runner: &aurora_java::JavaRunner<'_>,
) -> Result<Option<Picked>> {
    if let Some(path) = fixed {
        let source = if path.starts_with(managed_root) {
            DetectSource::Managed
        } else {
            DetectSource::CommonDir
        };
        let java = probe_cached(path, source, cache, runner)?;
        return Ok(Some(Picked { java, fixed: true }));
    }

    // 上次探测的结果里按主版本从好到差逐个校验：文件没变只是一次 stat，被删了就试下一个。
    let known = cache.installations();
    for candidate in rank_for_major(&known, required_major) {
        match probe_cached(&candidate.path, candidate.source, cache, runner) {
            Ok(java) if java.version.major == required_major => {
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
            Ok(java) if java.version.major == required_major => {
                return Ok(Some(Picked { java, fixed: false }));
            }
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
            if let Err(err) = aurora_base::fs::atomic_write(&path, &bytes).await {
                tracing::warn!(path = %path.display(), error = %err, "Java 探测缓存写盘失败");
            }
        }
        Err(err) => tracing::warn!(error = %err, "序列化 Java 探测缓存失败"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::AuroraConfig;
    use sha1::{Digest, Sha1};
    use std::sync::atomic::{AtomicUsize, Ordering};
    use tokio::sync::mpsc;
    use wiremock::matchers::{method, path as match_path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    const OPENJDK_17: &str = "openjdk version \"17.0.8\" 2023-07-18\n\
        OpenJDK 64-Bit Server VM Microsoft-8035246 (build 17.0.8+7-LTS, mixed mode)\n";

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

    /// 在 mock 上挂好一个只含 java 可执行文件的 17 运行时，返回清单地址与文件内容。
    async fn mount_runtime(server: &MockServer) -> (String, Vec<u8>) {
        let base = server.uri();
        let platform = aurora_java::current_platform();
        let java_bytes = b"MZ-fake-managed-java".to_vec();
        let exe_rel = format!("bin/{}", aurora_java::JAVA_EXE);
        let component_manifest = format!(
            r#"{{"files":{{"bin":{{"type":"directory"}},"{exe_rel}":{{"type":"file","executable":true,"downloads":{{"raw":{{"sha1":"{}","size":{},"url":"{}/objects/java"}}}}}}}}}}"#,
            sha1_hex(&java_bytes),
            java_bytes.len(),
            base,
        );
        let all_json = format!(
            r#"{{"{platform}":{{"java-runtime-gamma":[{{"manifest":{{"sha1":"{}","url":"{}/gamma.json"}},"version":{{"name":"17.0.8"}}}}]}}}}"#,
            sha1_hex(component_manifest.as_bytes()),
            base,
        );
        mount_get(server, "/all.json", all_json.into_bytes()).await;
        mount_get(server, "/gamma.json", component_manifest.into_bytes()).await;
        mount_get(server, "/objects/java", java_bytes.clone()).await;
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

    fn aurora_with(config: AuroraConfig, data_dir: &Path) -> Aurora {
        Aurora::for_test(config, data_dir.to_path_buf(), data_dir.join(".minecraft"))
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
        let aurora = aurora_with(AuroraConfig::default(), dir.path());

        let found = aurora.detect_java_with(&env).await.unwrap();
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].path, exe);
        assert_eq!(found[0].source, DetectSource::Managed);
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        assert!(dir.path().join(PROBE_CACHE_FILE).is_file());

        let again = aurora.detect_java_with(&env).await.unwrap();
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
        let aurora = aurora_with(AuroraConfig::default(), dir.path());
        let expected = java_exe_in_home(&runtime_install_dir(dir.path(), 17));

        let (list, path) = aurora.resolve_java_with(17, None, &env).await.unwrap();
        assert_eq!(path, expected);
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].source, DetectSource::Managed);
        assert_eq!(std::fs::read(&expected).unwrap(), java_bytes);
        assert_eq!(requests_to(&server, "/objects/java").await, 1);
        assert_eq!(calls.load(Ordering::SeqCst), 1);

        let (_, second) = aurora.resolve_java_with(17, None, &env).await.unwrap();
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
        let (_, third) = aurora.resolve_java_with(17, None, &env).await.unwrap();
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
        let config = AuroraConfig {
            auto_download_java: false,
            ..AuroraConfig::default()
        };
        let aurora = aurora_with(config, dir.path());
        let env = counting_env(Arc::new(AtomicUsize::new(0)), String::new());
        let err = aurora.resolve_java_with(21, None, &env).await.unwrap_err();
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
            .join(aurora_java::JAVA_EXE);
        touch(&fixed);
        let config = AuroraConfig {
            default_java: Some(fixed.clone()),
            ..AuroraConfig::default()
        };
        let aurora = aurora_with(config, dir.path());
        let env = counting_env(Arc::new(AtomicUsize::new(0)), String::new());

        let (list, path) = aurora.resolve_java_with(17, None, &env).await.unwrap();
        assert_eq!(path, fixed);
        assert_eq!(
            list.iter().map(|j| &j.path).collect::<Vec<_>>(),
            vec![&fixed]
        );

        std::fs::remove_file(&fixed).unwrap();
        let err = aurora.resolve_java_with(17, None, &env).await.unwrap_err();
        assert!(
            matches!(&err, CoreError::Java(aurora_java::Error::JavaExec { path, .. }) if path == &fixed),
            "实际：{err:?}"
        );
    }

    /// 安装走下载池：文件落到托管目录、发出带总数的下载进度与带产物路径的完成阶段。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn install_java_downloads_through_pool_and_reports_progress() {
        let server = MockServer::start().await;
        let (manifest, java_bytes) = mount_runtime(&server).await;
        let dir = tempfile::tempdir().unwrap();
        let aurora = aurora_with(AuroraConfig::default(), dir.path());

        let (tx, mut rx) = mpsc::unbounded_channel();
        let installed = aurora
            .install_java_from(17, manifest.clone(), Some(&tx))
            .await
            .expect("mock 安装应成功");
        assert_eq!(installed.component, "java-runtime-gamma");
        assert_eq!(installed.version.major, 17);
        let expected_exe = java_exe_in_home(&runtime_install_dir(dir.path(), 17));
        assert_eq!(installed.java_executable, expected_exe);
        assert_eq!(std::fs::read(&expected_exe).unwrap(), java_bytes);

        // 再装一次：清单照拉，文件已就绪不再下载。
        aurora.install_java_from(17, manifest, None).await.unwrap();
        assert_eq!(requests_to(&server, "/objects/java").await, 1);
        assert_eq!(requests_to(&server, "/all.json").await, 2);

        drop(tx);
        let mut stages = Vec::new();
        let mut last_download = None;
        while let Some(event) = rx.recv().await {
            match event {
                CoreEvent::Stage(message) => stages.push(message),
                CoreEvent::Download(progress) => last_download = Some(progress),
                CoreEvent::Warning(_) => {}
            }
        }
        let progress = last_download.expect("应转发下载进度");
        assert_eq!(progress.total, 1);
        assert_eq!(progress.finished, 1);
        assert_eq!(progress.total_bytes, Some(java_bytes.len() as u64));
        assert!(
            stages
                .iter()
                .any(|m| m.contains("安装完成") && m.contains(aurora_java::JAVA_EXE)),
            "应发出带产物路径的安装完成阶段事件，实际: {stages:?}"
        );
    }
}
