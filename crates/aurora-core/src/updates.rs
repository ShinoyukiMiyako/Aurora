//! 启动器自更新的选源：复用「文件下载源」设置，不另设开关。
//!
//! - 官方优先：主源在前；
//! - 镜像优先：镜像在前；
//! - 自动：对两个源各发一次极小的探测请求测时延，快的在前；两边都测不出时镜像在前
//!   （国内网络连不上海外主源的情况远比反过来常见）。
//!
//! 镜像未启用（备案前）时端点表只有主源，也就不用探测。

use std::time::{Duration, Instant};

use crate::config::DownloadSourcePolicy;
use crate::facade::Aurora;

/// 单个源的探测时限。只是为了排个先后，等太久不如直接按镜像优先。
pub const UPDATE_PROBE_TIMEOUT: Duration = Duration::from_millis(1500);

/// 启动器更新源。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UpdateSource {
    /// 主源。
    Primary,
    /// 国内镜像。
    Mirror,
}

/// 按下载源策略给更新源排序。`latency` 是（主源，镜像）的探测时延，`None` 为测不出，只在自动档使用。
pub fn order_update_sources(
    policy: DownloadSourcePolicy,
    mirror_enabled: bool,
    latency: (Option<Duration>, Option<Duration>),
) -> Vec<UpdateSource> {
    use UpdateSource::{Mirror, Primary};
    if !mirror_enabled {
        return vec![Primary];
    }
    match policy {
        DownloadSourcePolicy::OfficialFirst => vec![Primary, Mirror],
        DownloadSourcePolicy::MirrorFirst => vec![Mirror, Primary],
        DownloadSourcePolicy::Auto => match latency {
            (Some(primary), Some(mirror)) if primary <= mirror => vec![Primary, Mirror],
            (Some(_), None) => vec![Primary, Mirror],
            _ => vec![Mirror, Primary],
        },
    }
}

impl Aurora {
    /// 本次检查更新要用的端点，按「文件下载源」策略排好。`mirror_url` 为 `None` 表示镜像未启用。
    pub async fn update_endpoints(
        &self,
        primary_url: &str,
        mirror_url: Option<&str>,
    ) -> Vec<String> {
        let policy = self.config().download_source;
        let latency = match (policy, mirror_url) {
            (DownloadSourcePolicy::Auto, Some(mirror)) => {
                let http = self.http();
                let primary_probe = tokio::spawn({
                    let http = http.clone();
                    let url = primary_url.to_owned();
                    async move { probe_latency(&http, &url).await }
                });
                let mirror_latency = probe_latency(&http, mirror).await;
                let primary_latency = match primary_probe.await {
                    Ok(latency) => latency,
                    Err(join) => {
                        tracing::warn!(error = %join, "更新主源探测任务异常结束，按测不出处理");
                        None
                    }
                };
                (primary_latency, mirror_latency)
            }
            _ => (None, None),
        };
        order_update_sources(policy, mirror_url.is_some(), latency)
            .into_iter()
            .map(|source| match source {
                UpdateSource::Primary => primary_url.to_owned(),
                UpdateSource::Mirror => mirror_url
                    .expect("镜像未启用时排序结果里不会有镜像")
                    .to_owned(),
            })
            .collect()
    }
}

/// 只要首字节的 Range 请求，成功（2xx）记时延，失败或超时记 `None`。
async fn probe_latency(http: &reqwest::Client, url: &str) -> Option<Duration> {
    let started = Instant::now();
    let response = http
        .get(url)
        .header(reqwest::header::RANGE, "bytes=0-0")
        .timeout(UPDATE_PROBE_TIMEOUT)
        .send()
        .await;
    match response {
        Ok(resp) if resp.status().is_success() => Some(started.elapsed()),
        Ok(resp) => {
            tracing::info!(url, status = %resp.status(), "更新源探测返回非 2xx");
            None
        }
        Err(err) => {
            tracing::info!(url, error = %err, "更新源探测失败");
            None
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::AuroraConfig;
    use UpdateSource::{Mirror, Primary};
    use wiremock::matchers::{method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    const FAST: Option<Duration> = Some(Duration::from_millis(40));
    const SLOW: Option<Duration> = Some(Duration::from_millis(400));

    #[test]
    fn order_follows_download_source_policy() {
        assert_eq!(
            order_update_sources(DownloadSourcePolicy::OfficialFirst, true, (SLOW, FAST)),
            vec![Primary, Mirror],
            "官方优先不看测速"
        );
        assert_eq!(
            order_update_sources(DownloadSourcePolicy::MirrorFirst, true, (FAST, SLOW)),
            vec![Mirror, Primary],
            "镜像优先不看测速"
        );
        assert_eq!(
            order_update_sources(DownloadSourcePolicy::Auto, true, (FAST, SLOW)),
            vec![Primary, Mirror]
        );
        assert_eq!(
            order_update_sources(DownloadSourcePolicy::Auto, true, (SLOW, FAST)),
            vec![Mirror, Primary]
        );
        assert_eq!(
            order_update_sources(DownloadSourcePolicy::Auto, true, (FAST, None)),
            vec![Primary, Mirror],
            "镜像测不出时主源在前"
        );
        assert_eq!(
            order_update_sources(DownloadSourcePolicy::Auto, true, (None, FAST)),
            vec![Mirror, Primary]
        );
        assert_eq!(
            order_update_sources(DownloadSourcePolicy::Auto, true, (None, None)),
            vec![Mirror, Primary],
            "都测不出时镜像优先"
        );
        assert_eq!(
            order_update_sources(DownloadSourcePolicy::Auto, true, (FAST, FAST)),
            vec![Primary, Mirror],
            "一样快时主源在前"
        );
    }

    #[test]
    fn disabled_mirror_leaves_only_primary_under_every_policy() {
        for policy in [
            DownloadSourcePolicy::Auto,
            DownloadSourcePolicy::OfficialFirst,
            DownloadSourcePolicy::MirrorFirst,
        ] {
            assert_eq!(
                order_update_sources(policy, false, (None, FAST)),
                vec![Primary]
            );
        }
    }

    fn aurora_with(policy: DownloadSourcePolicy) -> Aurora {
        let config = AuroraConfig {
            download_source: policy,
            ..AuroraConfig::default()
        };
        let dir = std::env::temp_dir();
        Aurora::for_test(config, dir.clone(), dir.join(".minecraft"))
    }

    /// 自动档真去探测：慢的那个源排到后面；换成镜像优先就不再探测。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn auto_policy_measures_and_puts_faster_source_first() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/primary/latest.json"))
            .respond_with(ResponseTemplate::new(206).set_delay(Duration::from_millis(400)))
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path("/mirror/latest.json"))
            .respond_with(ResponseTemplate::new(206))
            .mount(&server)
            .await;
        let primary = format!("{}/primary/latest.json", server.uri());
        let mirror = format!("{}/mirror/latest.json", server.uri());

        let ordered = aurora_with(DownloadSourcePolicy::Auto)
            .update_endpoints(&primary, Some(&mirror))
            .await;
        assert_eq!(ordered, vec![mirror.clone(), primary.clone()]);
        let probes = server.received_requests().await.unwrap();
        assert_eq!(probes.len(), 2);
        assert!(probes.iter().all(|r| r.headers.get("range").is_some()));

        let fixed = aurora_with(DownloadSourcePolicy::OfficialFirst)
            .update_endpoints(&primary, Some(&mirror))
            .await;
        assert_eq!(fixed, vec![primary.clone(), mirror]);
        assert_eq!(
            server.received_requests().await.unwrap().len(),
            2,
            "非自动档不探测"
        );

        let only = aurora_with(DownloadSourcePolicy::Auto)
            .update_endpoints(&primary, None)
            .await;
        assert_eq!(only, vec![primary]);
        assert_eq!(
            server.received_requests().await.unwrap().len(),
            2,
            "只有主源时不探测"
        );
    }
}
