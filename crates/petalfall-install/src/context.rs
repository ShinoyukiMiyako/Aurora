//! 安装流程的共享上下文与批量下载收口。
//!
//! 各安装器（原版 / Fabric / Quilt / Forge）都需要同一组协作对象：注入的 HTTP 客户端（读元数据）、
//! petalfall-download 并发池（下文件）、目录布局、运行环境与重试策略。[`InstallContext`] 把它们打成一束
//! 借用引用（整体 `Copy`，按值传递零成本），避免每个方法拖一长串参数。
//!
//! 取消令牌也在这一束里：下文件由下载池自己的令牌停下，读元数据、Forge 排队与处理器子进程不经过
//! 下载池，各自从这里拿令牌。挂在上下文上而不是各安装器上，造上下文的地方给一次就覆盖整条链路。

use petalfall_base::http::network_failure;
use petalfall_base::retry::RetryPolicy;
use petalfall_download::{CancellationToken, DownloadPool, DownloadProgress, DownloadTask};
use petalfall_version::RuntimeContext;
use tokio::sync::watch;

use crate::error::{Error, Result};
use crate::layout::GameLayout;

/// 新建、补全实例一路上的各步，按执行先后排。下载批次之间的几步由安装器经 [`InstallContext::enter`]
/// 报出，其余由门面报；整份步骤表由门面开工前按请求排定。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InstallPhase {
    Metadata,
    LoaderProfile,
    Libraries,
    Assets,
    Natives,
    Java,
    LoaderInstaller,
    LoaderLibraries,
    LoaderProcessors,
    Verify,
    Template,
}

impl InstallPhase {
    /// 事件负载与前端文案表里用的键。
    pub fn key(self) -> &'static str {
        match self {
            Self::Metadata => "metadata",
            Self::LoaderProfile => "loader_profile",
            Self::Libraries => "libraries",
            Self::Assets => "assets",
            Self::Natives => "natives",
            Self::Java => "java",
            Self::LoaderInstaller => "loader_installer",
            Self::LoaderLibraries => "loader_libraries",
            Self::LoaderProcessors => "loader_processors",
            Self::Verify => "verify",
            Self::Template => "template",
        }
    }
}

/// 安装流程共享的协作对象（全为借用，`Copy`）。
#[derive(Clone, Copy)]
pub struct InstallContext<'a> {
    /// 读元数据用的 HTTP 客户端（由 petalfall-base 工厂构建）。
    pub client: &'a reqwest::Client,
    /// 下文件用的并发池（内含单文件引擎与镜像源调度）。
    pub pool: &'a DownloadPool,
    /// 目标游戏根目录布局。
    pub layout: &'a GameLayout,
    /// 运行环境（决定 library rules 与 natives classifier）。
    pub runtime: &'a RuntimeContext,
    /// 元数据抓取的退避重试策略（文件下载自有 petalfall-download 的策略）。
    pub policy: &'a RetryPolicy,
    /// 安装的取消令牌：元数据抓取（等连接、读响应体、退避）、Forge 安装排队与处理器子进程都看它。
    /// 应与 `pool` 上挂的是同一个令牌。
    pub cancel: Option<&'a CancellationToken>,
    /// 进入下一步时的回调；`None` 表示不报。只在上一批下载已经返回、下一批还没开始时调：之后才送到的
    /// 上一批快照都已下完（`finished == total`），前端凭这一点不把它们算进新的一步。
    pub phases: Option<&'a (dyn Fn(InstallPhase) + Send + Sync)>,
}

impl<'a> InstallContext<'a> {
    /// 组装上下文，不挂取消令牌（需要时再接 [`with_cancel`](Self::with_cancel)）。
    pub fn new(
        client: &'a reqwest::Client,
        pool: &'a DownloadPool,
        layout: &'a GameLayout,
        runtime: &'a RuntimeContext,
        policy: &'a RetryPolicy,
    ) -> Self {
        Self {
            client,
            pool,
            layout,
            runtime,
            policy,
            cancel: None,
            phases: None,
        }
    }

    /// 挂上取消令牌；传 `None` 表示不可取消。
    pub fn with_cancel(mut self, cancel: Option<&'a CancellationToken>) -> Self {
        self.cancel = cancel;
        self
    }

    /// 挂上报步骤的回调；传 `None` 表示这一段不报。
    pub fn with_phases(mut self, phases: Option<&'a (dyn Fn(InstallPhase) + Send + Sync)>) -> Self {
        self.phases = phases;
        self
    }

    /// 报告进入了 `phase` 这一步；没挂回调时什么也不做。
    pub fn enter(&self, phase: InstallPhase) {
        if let Some(report) = self.phases {
            report(phase);
        }
    }

    /// 跑一批下载并把「有文件最终失败」收敛为 [`Error::BatchIncomplete`]。
    ///
    /// petalfall-download 的批量池对单文件失败返回 `Ok(report)` 而非 `Err`，故这里必须显式检查
    /// `is_success()`，绝不放过部分失败（缺文件会在启动时才炸，代价更高）。
    pub(crate) async fn run_batch(
        &self,
        tasks: Vec<DownloadTask>,
        stage: &'static str,
        progress: Option<watch::Sender<DownloadProgress>>,
    ) -> Result<usize> {
        if tasks.is_empty() {
            return Ok(0);
        }
        let mut report = self.pool.download_all(tasks, progress).await?;
        if report.is_success() {
            return Ok(report.succeeded);
        }
        let failed = report.failures.len();
        // 挑一条挂上原因链：有网络层失败就取它，否则取第一条。命令层沿原因链判断要不要
        // 标 detail.network，404 排在前面时也不能把「连不上」藏起来。
        let representative = report
            .failures
            .iter()
            .position(|failure| network_failure(&failure.error).is_some())
            .unwrap_or(0);
        let cause = report.failures.swap_remove(representative).error;
        Err(Error::BatchIncomplete {
            stage,
            total: report.total,
            failed,
            cause: Box::new(cause),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use petalfall_base::http::{NetworkFailure, network_failure};
    use petalfall_download::{DownloadConfig, Downloader, MirrorSource, SourcePlan};
    use petalfall_version::OsName;
    use std::time::Duration;
    use wiremock::matchers::{method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    /// 端口先占后放：随后的连接一定被拒，不必真的去等一次超时。
    fn closed_port_url(name: &str) -> String {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        drop(listener);
        format!("http://127.0.0.1:{port}/{name}")
    }

    /// 只走官方源、每个源只试一次的池：失败立刻落定，测试不被退避拖慢。
    fn single_shot_pool(client: &reqwest::Client) -> DownloadPool {
        let once = RetryPolicy {
            max_attempts: 1,
            initial_delay: Duration::from_millis(1),
            max_delay: Duration::from_millis(1),
            multiplier: 1.0,
            jitter: false,
        };
        let config = DownloadConfig {
            retry: once,
            sources: SourcePlan::new(vec![MirrorSource::Official]),
            ..Default::default()
        };
        DownloadPool::new(Downloader::new(client.clone(), config), 4)
    }

    async fn batch_error(tasks: impl FnOnce(&std::path::Path) -> Vec<DownloadTask>) -> Error {
        let dir = tempfile::tempdir().unwrap();
        let client = petalfall_base::http::build_client().unwrap();
        let pool = single_shot_pool(&client);
        let layout = GameLayout::new(dir.path());
        let runtime = RuntimeContext::new(OsName::Windows, "x86_64", 64);
        let policy = RetryPolicy::default();
        let cx = InstallContext::new(&client, &pool, &layout, &runtime, &policy);
        cx.run_batch(tasks(dir.path()), "库", None)
            .await
            .expect_err("这批下载应有文件失败")
    }

    fn counts(err: &Error) -> (usize, usize) {
        match err {
            Error::BatchIncomplete { total, failed, .. } => (*total, *failed),
            other => panic!("应为 BatchIncomplete，实际 {other:?}"),
        }
    }

    // 安装批次把单文件失败收成一个计数错误；连不上的那条原因必须留在原因链上，
    // 命令层才能据此标出 detail.network，让前端去做一次连通性探测。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_batch_that_could_not_connect_keeps_the_network_failure_on_its_cause_chain() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/ok.jar"))
            .respond_with(ResponseTemplate::new(200).set_body_bytes(b"jar".to_vec()))
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path("/missing.jar"))
            .respond_with(ResponseTemplate::new(404))
            .mount(&server)
            .await;
        let ok = format!("{}/ok.jar", server.uri());
        let missing = format!("{}/missing.jar", server.uri());

        // 全部失败：都连不上。
        let err = batch_error(|dir| {
            vec![
                DownloadTask::new(closed_port_url("a.jar"), dir.join("a.jar")),
                DownloadTask::new(closed_port_url("b.jar"), dir.join("b.jar")),
            ]
        })
        .await;
        assert_eq!(counts(&err), (2, 2));
        assert_eq!(err.to_string(), "库 阶段有 2/2 个文件下载失败");
        assert_eq!(network_failure(&err), Some(NetworkFailure::Connect));

        // 部分失败：一个下好了，另一个连不上。
        let err = batch_error(|dir| {
            vec![
                DownloadTask::new(ok.clone(), dir.join("ok.jar")),
                DownloadTask::new(closed_port_url("b.jar"), dir.join("b.jar")),
            ]
        })
        .await;
        assert_eq!(counts(&err), (2, 1));
        assert_eq!(network_failure(&err), Some(NetworkFailure::Connect));

        // 全部失败，排在前面的是 404：仍挑连不上的那条挂上原因链。
        let err = batch_error(|dir| {
            vec![
                DownloadTask::new(missing.clone(), dir.join("missing.jar")),
                DownloadTask::new(closed_port_url("b.jar"), dir.join("b.jar")),
            ]
        })
        .await;
        assert_eq!(counts(&err), (2, 2));
        assert_eq!(network_failure(&err), Some(NetworkFailure::Connect));

        // 部分失败但服务器回了 404：网络是通的，不能标成断网。
        let err = batch_error(|dir| {
            vec![
                DownloadTask::new(ok.clone(), dir.join("ok2.jar")),
                DownloadTask::new(missing.clone(), dir.join("missing2.jar")),
            ]
        })
        .await;
        assert_eq!(counts(&err), (2, 1));
        assert_eq!(network_failure(&err), None);
        let causes: Vec<String> =
            std::iter::successors(std::error::Error::source(&err), |e| e.source())
                .map(|e| e.to_string())
                .collect();
        assert!(causes.iter().any(|c| c.contains("404")), "{causes:?}");
    }
}
