//! 连通性探测：联网请求以连接类错误失败之后，前端据此判断「是这一个请求的问题，还是整个网络断了」。

use std::time::Duration;

use tokio::task::JoinSet;

use crate::error::Result;
use crate::facade::Aurora;

/// 每个探测目标的时限。探测只回答「此刻连不连得上」，几秒内连不上的源对玩家来说就是断网；
/// 离线期间前端还会按固定间隔反复探测，不必在一次里等满下载用的连接超时。
pub const PROBE_TIMEOUT: Duration = Duration::from_secs(4);

impl Aurora {
    /// 下载实际要用的源里有没有一个连得上。目标是版本清单地址，以及它按当前下载源策略得出的另一个源
    /// （官方与 BMCLAPI 镜像）：玩家的网络只通其中一个时，下载照样能换源完成，不该判为离线。
    pub async fn probe_network(&self) -> Result<bool> {
        let targets = self
            .config()
            .download_source
            .source_plan()
            .candidates(self.manifest_url())?;
        reachable_any(&self.http(), targets, PROBE_TIMEOUT).await
    }
}

/// 并发向每个目标发一个 HEAD，任何一个收到 HTTP 响应就算连得上。状态码不论：404、503 也说明网络是通的，
/// 这里不判断源本身是否健康。全部连接失败、TLS 握手失败或超时才是连不上。
async fn reachable_any(
    http: &reqwest::Client,
    targets: Vec<String>,
    timeout: Duration,
) -> Result<bool> {
    let mut probes = JoinSet::new();
    for url in targets {
        let request = http.head(url).timeout(timeout);
        probes.spawn(async move { request.send().await.is_ok() });
    }
    // 有一个连上就返回：JoinSet 被丢弃时会中止还在等的探测，不让慢的源拖住结果。
    while let Some(joined) = probes.join_next().await {
        if joined? {
            return Ok(true);
        }
    }
    Ok(false)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::AuroraConfig;
    use std::net::TcpListener;
    use std::path::PathBuf;
    use std::time::Instant;
    use wiremock::matchers::method;
    use wiremock::{Mock, MockServer, ResponseTemplate};

    /// 一个此刻没人监听的本机端口：绑定后立刻释放，连接会被拒绝。
    fn closed_port_url() -> String {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        drop(listener);
        format!("http://127.0.0.1:{port}/mc/game/version_manifest_v2.json")
    }

    fn aurora_with_manifest(url: String) -> Aurora {
        let dir = PathBuf::from("/data");
        Aurora::for_test(AuroraConfig::default(), dir.clone(), dir.join(".minecraft"))
            .with_manifest_url(url)
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn any_http_response_counts_as_online_even_an_error_status() {
        let server = MockServer::start().await;
        Mock::given(method("HEAD"))
            .respond_with(ResponseTemplate::new(503))
            .expect(1)
            .mount(&server)
            .await;
        let aurora = aurora_with_manifest(format!("{}/manifest.json", server.uri()));
        assert!(aurora.probe_network().await.unwrap());
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn refused_connection_is_offline() {
        let aurora = aurora_with_manifest(closed_port_url());
        assert!(!aurora.probe_network().await.unwrap());
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_source_slower_than_the_timeout_is_offline() {
        let server = MockServer::start().await;
        Mock::given(method("HEAD"))
            .respond_with(ResponseTemplate::new(200).set_delay(Duration::from_secs(5)))
            .mount(&server)
            .await;
        let started = Instant::now();
        let reachable = reachable_any(
            &aurora_base::http::build_client().unwrap(),
            vec![format!("{}/manifest.json", server.uri())],
            Duration::from_millis(300),
        )
        .await
        .unwrap();
        assert!(!reachable);
        assert!(
            started.elapsed() < Duration::from_secs(3),
            "应在时限到达时放弃，而不是等响应"
        );
    }

    /// 一个源不通、另一个通：判为在线。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn one_reachable_source_is_enough() {
        let server = MockServer::start().await;
        Mock::given(method("HEAD"))
            .respond_with(ResponseTemplate::new(404))
            .mount(&server)
            .await;
        let reachable = reachable_any(
            &aurora_base::http::build_client().unwrap(),
            vec![closed_port_url(), format!("{}/manifest.json", server.uri())],
            Duration::from_secs(4),
        )
        .await
        .unwrap();
        assert!(reachable);
        assert!(
            !reachable_any(
                &aurora_base::http::build_client().unwrap(),
                Vec::new(),
                PROBE_TIMEOUT
            )
            .await
            .unwrap(),
            "没有任何目标时不能报在线"
        );
    }
}
