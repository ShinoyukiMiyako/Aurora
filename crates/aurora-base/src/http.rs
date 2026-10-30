//! 统一 HTTP 客户端工厂。
//!
//! 全 workspace 只从这里取 [`reqwest::Client`]：统一 User-Agent、连接/读取超时与连接池，
//! 走 rustls（禁用 native-tls，规避 Windows schannel 差异）。需要访问远端的模块自行注入
//! `base_url` 以便单测走本地 mock。

use std::time::Duration;

use crate::error::{Error, Result};

/// 兜底 User-Agent，形如 `Petalfall/0.1.0`。
///
/// 版本段取的是 aurora-base 自己的 crate 版本，不随应用发版变化，只适合测试与命令行工具。
/// 应用层应以 [`HttpConfig::for_app_version`] 带上真实的应用版本构建客户端：镜像站按 UA 统计
/// 与限流，报出一个永远不变的版本号会让对方无从区分新旧客户端。
pub const USER_AGENT: &str = concat!(crate::app_name_en!(), "/", env!("CARGO_PKG_VERSION"));

/// HTTP 客户端构建参数。
///
/// 默认不设「整体超时」——大文件下载会持续几分钟，硬性总超时会把正常下载掐断；
/// 改用 `connect_timeout` + `read_timeout`（读之间的最长静默）来兜住真正卡死的连接。
#[derive(Debug, Clone)]
pub struct HttpConfig {
    /// 请求 User-Agent。
    pub user_agent: String,
    /// 建立 TCP/TLS 连接的超时。
    pub connect_timeout: Duration,
    /// 两次成功读取之间允许的最长静默；用于下载场景替代整体超时。
    pub read_timeout: Duration,
    /// 整体请求超时。默认 `None`：适配大文件下载；API 调用方可自行设一个值。
    pub total_timeout: Option<Duration>,
    /// 每个 host 的空闲连接池上限。
    pub pool_idle_per_host: usize,
}

impl HttpConfig {
    /// 默认参数，User-Agent 换成 `Petalfall/<应用版本>`。
    pub fn for_app_version(version: &str) -> Self {
        Self {
            user_agent: format!("{}/{version}", crate::brand::APP_NAME_EN),
            ..Self::default()
        }
    }
}

impl Default for HttpConfig {
    fn default() -> Self {
        Self {
            user_agent: USER_AGENT.to_owned(),
            connect_timeout: Duration::from_secs(15),
            read_timeout: Duration::from_secs(30),
            total_timeout: None,
            pool_idle_per_host: 8,
        }
    }
}

/// 用默认配置构建客户端。
pub fn build_client() -> Result<reqwest::Client> {
    build_client_with(&HttpConfig::default())
}

/// 按给定配置构建客户端。
pub fn build_client_with(config: &HttpConfig) -> Result<reqwest::Client> {
    let mut builder = reqwest::Client::builder()
        .user_agent(config.user_agent.as_str())
        .connect_timeout(config.connect_timeout)
        .read_timeout(config.read_timeout)
        .pool_max_idle_per_host(config.pool_idle_per_host);
    if let Some(total) = config.total_timeout {
        builder = builder.timeout(total);
    }
    builder.build().map_err(Error::HttpClientBuild)
}

#[cfg(test)]
mod tests {
    use super::*;
    use wiremock::matchers::{header, method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    #[test]
    fn default_user_agent_has_brand_prefix() {
        assert!(USER_AGENT.starts_with("Petalfall/"));
        // 版本号段应非空（形如 Petalfall/0.1.0）
        let version = USER_AGENT.trim_start_matches("Petalfall/");
        assert!(!version.is_empty());
        assert!(version.contains('.'));
    }

    #[test]
    fn app_version_config_only_replaces_user_agent() {
        let config = HttpConfig::for_app_version("2.3.0-beta.1");
        assert_eq!(config.user_agent, "Petalfall/2.3.0-beta.1");
        let default = HttpConfig::default();
        assert_eq!(config.connect_timeout, default.connect_timeout);
        assert_eq!(config.read_timeout, default.read_timeout);
        assert_eq!(config.total_timeout, default.total_timeout);
        assert_eq!(config.pool_idle_per_host, default.pool_idle_per_host);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn client_sends_default_user_agent() {
        let server = MockServer::start().await;
        // 只有当请求头 user-agent 恰好等于 USER_AGENT 时才命中 200，否则 wiremock 回 404。
        Mock::given(method("GET"))
            .and(path("/ping"))
            .and(header("user-agent", USER_AGENT))
            .respond_with(ResponseTemplate::new(200).set_body_string("pong"))
            .mount(&server)
            .await;

        let client = build_client().expect("客户端应构建成功");
        let resp = client
            .get(format!("{}/ping", server.uri()))
            .send()
            .await
            .expect("请求应成功");
        assert_eq!(resp.status().as_u16(), 200);
        assert_eq!(resp.text().await.unwrap(), "pong");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn custom_user_agent_is_applied() {
        let server = MockServer::start().await;
        let ua = "Petalfall/9.9.9-test";
        Mock::given(method("GET"))
            .and(path("/who"))
            .and(header("user-agent", ua))
            .respond_with(ResponseTemplate::new(204))
            .mount(&server)
            .await;

        let config = HttpConfig {
            user_agent: ua.to_owned(),
            ..HttpConfig::default()
        };
        let client = build_client_with(&config).expect("客户端应构建成功");
        let resp = client
            .get(format!("{}/who", server.uri()))
            .send()
            .await
            .expect("请求应成功");
        // 命中带自定义 UA 的 mock 才会是 204；否则会是 404。
        assert_eq!(resp.status().as_u16(), 204);
    }
}
