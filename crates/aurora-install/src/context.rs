//! 安装流程的共享上下文与批量下载收口。
//!
//! 各安装器（原版 / Fabric / Quilt / Forge）都需要同一组协作对象：注入的 HTTP 客户端（读元数据）、
//! aurora-download 并发池（下文件）、目录布局、运行环境与重试策略。[`InstallContext`] 把它们打成一束
//! 借用引用（整体 `Copy`，按值传递零成本），避免每个方法拖一长串参数。

use aurora_base::http::network_failure;
use aurora_base::retry::RetryPolicy;
use aurora_download::{DownloadPool, DownloadProgress, DownloadTask};
use aurora_version::RuntimeContext;
use tokio::sync::watch;

use crate::error::{Error, Result};
use crate::layout::GameLayout;

/// 安装流程共享的协作对象（全为借用，`Copy`）。
#[derive(Clone, Copy)]
pub struct InstallContext<'a> {
    /// 读元数据用的 HTTP 客户端（由 aurora-base 工厂构建）。
    pub client: &'a reqwest::Client,
    /// 下文件用的并发池（内含单文件引擎与镜像源调度）。
    pub pool: &'a DownloadPool,
    /// 目标游戏根目录布局。
    pub layout: &'a GameLayout,
    /// 运行环境（决定 library rules 与 natives classifier）。
    pub runtime: &'a RuntimeContext,
    /// 元数据抓取的退避重试策略（文件下载自有 aurora-download 的策略）。
    pub policy: &'a RetryPolicy,
}

impl<'a> InstallContext<'a> {
    /// 组装上下文。
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
        }
    }

    /// 跑一批下载并把「有文件最终失败」收敛为 [`Error::BatchIncomplete`]。
    ///
    /// aurora-download 的批量池对单文件失败返回 `Ok(report)` 而非 `Err`，故这里必须显式检查
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
    use aurora_base::http::{NetworkFailure, network_failure};
    use aurora_download::{DownloadConfig, Downloader, MirrorSource, SourcePlan};
    use aurora_version::OsName;
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
        let client = aurora_base::http::build_client().unwrap();
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
