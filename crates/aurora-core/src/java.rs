//! Java 探测与运行时下载的门面接口。
//!
//! 把 aurora-java 的三路本地探测（[`detect_all`]）与 Mojang 运行时安装器（[`JavaRuntimeInstaller`]）
//! 暴露成两个粗粒度异步 API：[`Aurora::detect_java`] 供 UI 列出本机可用 Java，
//! [`Aurora::install_java`] 供「设置里手动下载指定主版本」这类不经启动流程的场景使用。
//!
//! 安装目录与镜像源刻意与 launch.rs 的 `prepare_java` 对齐（`data_dir/runtime/<主版本>` +
//! `config.download_source` 首选源），使自动下载与手动下载落在同一处、走同一策略，避免同一主版本
//! 的运行时分裂到两个目录。

use std::path::{Path, PathBuf};

use aurora_java::{InstalledRuntime, JavaInstallation, detect_all};

use crate::error::Result;
use crate::event::{CoreEvent, EventSink, emit};
use crate::facade::Aurora;

impl Aurora {
    /// 探测本机全部可用 Java（注册表 / 常见目录 / PATH，逐个 `java -version` 识别）。
    ///
    /// [`detect_all`] 是同步的注册表/文件系统/子进程扫描，放进 `spawn_blocking` 避免阻塞异步 runtime
    /// 的工作线程。单个坏 Java 不会中断整体扫描（由 aurora-java 内部按候选跳过），故本方法不返回错误、
    /// 只返回成功识别的列表；空列表即「本机未探测到 Java」。
    pub async fn detect_java(&self) -> Vec<JavaInstallation> {
        // detect_all 按设计不 panic（逐候选吞掉识别失败）；此处 join 失败只可能是任务被异常中止，
        // 用 expect 令其显式冒泡而非静默返回空列表（空列表会被误读成「没有 Java」）。
        tokio::task::spawn_blocking(detect_all)
            .await
            .expect("Java 探测阻塞任务不应 panic")
    }

    /// 下载并安装匹配 `required_major` 的 Mojang 运行时到托管目录，返回安装产物。
    ///
    /// 不做本地探测/复用判断（那是启动流程 `prepare_java` 的职责），本方法总是执行一次下载安装，
    /// 供「设置里手动补一个运行时」这类显式意图。安装目录、镜像源与 `prepare_java` 完全一致。
    pub async fn install_java(
        &self,
        required_major: u32,
        events: Option<&EventSink>,
    ) -> Result<InstalledRuntime> {
        self.install_java_from(required_major, self.java_runtime_url().to_owned(), events)
            .await
    }

    /// [`install_java`](Self::install_java) 的清单地址可注入内核。
    ///
    /// 拆出这层是为了让单测把清单地址指向本地 mock（与 [`JavaRuntimeInstaller::with_manifest_url`] 同一
    /// 注入思路），从而在不触网的前提下走通「按 config 选源 -> 装到 data_dir/runtime/<主版本> -> 发阶段
    /// 事件」的真实生产路径。`install_java` 只是以真实 Mojang 地址调用它。
    async fn install_java_from(
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
        let installer = self.java_installer(&manifest_url);
        let runtime = installer.install(required_major, &install_dir).await?;
        emit(
            events,
            CoreEvent::stage(format!(
                "Java {required_major} 运行时安装完成：{}",
                runtime.java_executable.display()
            )),
        );
        Ok(runtime)
    }
}

/// 托管 Java 运行时的安装目录：`data_dir/runtime/<主版本>`。
///
/// 与 launch.rs 的 `prepare_java` 使用的路径保持一致，令自动下载与手动下载共用同一目录，探测复用不至
/// 于分叉到两处。
pub(crate) fn runtime_install_dir(data_dir: &Path, required_major: u32) -> PathBuf {
    data_dir.join("runtime").join(required_major.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::AuroraConfig;
    use sha1::{Digest, Sha1};
    use tokio::sync::mpsc;
    use wiremock::matchers::{method, path as match_path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    fn sha1_hex(bytes: &[u8]) -> String {
        let mut hasher = Sha1::new();
        hasher.update(bytes);
        hasher.finalize().iter().map(|b| format!("{b:02x}")).collect()
    }

    async fn mount_get(server: &MockServer, p: &str, body: String) {
        Mock::given(method("GET"))
            .and(match_path(p))
            .respond_with(ResponseTemplate::new(200).set_body_string(body))
            .mount(server)
            .await;
    }

    async fn mount_get_bytes(server: &MockServer, p: &str, body: Vec<u8>) {
        Mock::given(method("GET"))
            .and(match_path(p))
            .respond_with(ResponseTemplate::new(200).set_body_bytes(body))
            .mount(server)
            .await;
    }

    #[test]
    fn runtime_install_dir_matches_launch_layout() {
        // 锁定「与 prepare_java 同目录」这一契约：data_dir/runtime/<主版本>。
        assert_eq!(
            runtime_install_dir(Path::new("D:/data"), 17),
            Path::new("D:/data").join("runtime").join("17")
        );
        assert_eq!(
            runtime_install_dir(Path::new("/opt/aurora"), 8),
            Path::new("/opt/aurora").join("runtime").join("8")
        );
    }

    #[tokio::test]
    async fn detect_java_delegates_to_detect_all() {
        let dir = tempfile::tempdir().unwrap();
        let aurora = Aurora::for_test(
            AuroraConfig::default(),
            dir.path().to_path_buf(),
            dir.path().join(".minecraft"),
        );

        let via_facade = aurora.detect_java().await;
        let direct = tokio::task::spawn_blocking(detect_all).await.unwrap();
        // 门面探测应与直接调用 detect_all 逐条一致：忠实委托，不增删/不重排候选。
        assert_eq!(via_facade, direct);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn install_java_downloads_to_runtime_dir_and_emits_stage() {
        let server = MockServer::start().await;
        let base = server.uri();
        // 用当前平台键挂清单，使测试在任意平台都命中（install 内部按 current_platform 选平台）。
        let platform = aurora_java::current_platform();

        let java_bytes = b"MZ-fake-managed-java".to_vec();
        let component_manifest = format!(
            r#"{{"files":{{"bin/java.exe":{{"type":"file","executable":true,"downloads":{{"raw":{{"sha1":"{}","url":"{}/objects/java"}}}}}}}}}}"#,
            sha1_hex(&java_bytes),
            base,
        );
        let all_json = format!(
            r#"{{"{platform}":{{"java-runtime-gamma":[{{"manifest":{{"sha1":"{}","url":"{}/gamma.json"}},"version":{{"name":"17.0.8"}}}}]}}}}"#,
            sha1_hex(component_manifest.as_bytes()),
            base,
        );
        mount_get(&server, "/all.json", all_json).await;
        mount_get(&server, "/gamma.json", component_manifest).await;
        mount_get_bytes(&server, "/objects/java", java_bytes.clone()).await;

        let dir = tempfile::tempdir().unwrap();
        let data_dir = dir.path().to_path_buf();
        // 默认配置的下载源为 Auto -> primary_mirror = Official（对 mock 域名恒等改写）。
        let aurora = Aurora::for_test(
            AuroraConfig::default(),
            data_dir.clone(),
            data_dir.join(".minecraft"),
        );

        let (tx, mut rx) = mpsc::unbounded_channel();
        let installed = aurora
            .install_java_from(17, format!("{base}/all.json"), Some(&tx))
            .await
            .expect("mock 安装应成功");

        // 安装产物：组件、版本、可执行文件绝对路径都要对上。
        assert_eq!(installed.component, "java-runtime-gamma");
        assert_eq!(installed.version.major, 17);
        assert_eq!(installed.version.security, 8);
        let expected_exe = data_dir
            .join("runtime")
            .join("17")
            .join("bin")
            .join("java.exe");
        assert_eq!(installed.java_executable, expected_exe);
        // 文件真实落盘且内容为下载对象本身。
        assert_eq!(std::fs::read(&expected_exe).unwrap(), java_bytes);

        // 阶段事件：至少发出一条「安装完成」且带上产物路径。
        drop(tx);
        let mut stages = Vec::new();
        while let Ok(event) = rx.try_recv() {
            if let CoreEvent::Stage(message) = event {
                stages.push(message);
            }
        }
        assert!(
            stages
                .iter()
                .any(|m| m.contains("安装完成") && m.contains("java.exe")),
            "应发出带产物路径的安装完成阶段事件，实际: {stages:?}"
        );
    }
}
