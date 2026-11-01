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

/// 元数据响应体（版本清单、资源索引、Java 运行时清单）的读取上限。实际最大的也只有几 MB，上限只防镜像或被
/// 劫持的线路回来一个超大响应或压缩炸弹时整个读进内存。
pub const METADATA_MAX_BYTES: u64 = 64 * 1024 * 1024;

/// [`read_body_capped`] 的失败。
#[derive(Debug, thiserror::Error)]
pub enum BodyReadError {
    /// `size` 是响应头声明的长度，或读到超限那一刻已收到的字节数，都是实际大小的下界。
    #[error("响应体至少有 {size} 字节，超过 {limit} 字节的上限")]
    TooLarge { size: u64, limit: u64 },
    /// 读响应体途中的传输错误。reqwest 把这类错误归为 decode 类。
    #[error(transparent)]
    Transport(#[from] reqwest::Error),
}

/// 读完响应体，超过 `limit` 字节就中止。声明的长度超限时不读正文；没声明（分块传输）、声明不实或解压后
/// 变大的按块累计，一超限就中止。
pub async fn read_body_capped(
    mut response: reqwest::Response,
    limit: u64,
) -> std::result::Result<Vec<u8>, BodyReadError> {
    if let Some(size) = response.content_length()
        && size > limit
    {
        return Err(BodyReadError::TooLarge { size, limit });
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await? {
        let size = (bytes.len() + chunk.len()) as u64;
        if size > limit {
            return Err(BodyReadError::TooLarge { size, limit });
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}

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
    configured_builder(config)
        .build()
        .map_err(Error::HttpClientBuild)
}

/// 两种客户端共用的配置：带凭据的下载换用不跳转的客户端时，超时、UA 与连接池必须与共享客户端一致，
/// 以后给 [`HttpConfig`] 加的项也只改这一处。
fn configured_builder(config: &HttpConfig) -> reqwest::ClientBuilder {
    let builder = reqwest::Client::builder()
        .user_agent(config.user_agent.as_str())
        .connect_timeout(config.connect_timeout)
        .read_timeout(config.read_timeout)
        .pool_max_idle_per_host(config.pool_idle_per_host);
    match config.total_timeout {
        Some(total) => builder.timeout(total),
        None => builder,
    }
}

/// 用默认配置构建不自动跟随跳转的客户端，见 [`build_manual_redirect_client_with`]。
pub fn build_manual_redirect_client() -> Result<reqwest::Client> {
    build_manual_redirect_client_with(&HttpConfig::default())
}

/// 按给定配置构建不自动跟随跳转的客户端：3xx 原样交回调用方。
///
/// reqwest 跟随跨主机跳转时只摘掉 Authorization、Cookie、cookie2、Proxy-Authorization、
/// WWW-Authenticate 这几个头，自定义的 `x-api-key` 会被原样带到下一跳；跳转策略又只能按客户端设，
/// 不能按请求设。所以带密钥的下载要换用这个客户端，由下载引擎逐跳决定带不带头。
///
/// 除跳转策略外与 [`build_client_with`] 逐项相同。
pub fn build_manual_redirect_client_with(config: &HttpConfig) -> Result<reqwest::Client> {
    configured_builder(config)
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(Error::HttpClientBuild)
}

/// 联网请求在网络层失败的种类：连不上（DNS 解析失败、连接被拒、TLS 握手失败都在这里），或者等不到响应。
/// 收到了响应但状态码不对、响应体解析失败不算：那说明网络是通的。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NetworkFailure {
    Connect,
    Timeout,
}

impl NetworkFailure {
    /// 交给前端的稳定名字。
    pub fn code(self) -> &'static str {
        match self {
            NetworkFailure::Connect => "connect",
            NetworkFailure::Timeout => "timeout",
        }
    }
}

/// 沿错误的 source 链找第一个 reqwest 错误，判断它是不是网络层失败。各层错误都把 reqwest 错误挂在
/// source 上，所以不论从哪条路径冒上来都认得出；链上没有 reqwest 错误时为 `None`。
pub fn network_failure(err: &(dyn std::error::Error + 'static)) -> Option<NetworkFailure> {
    let mut current = Some(err);
    while let Some(layer) = current {
        if let Some(http) = layer.downcast_ref::<reqwest::Error>() {
            return if http.is_timeout() {
                Some(NetworkFailure::Timeout)
            } else if http.is_connect() {
                Some(NetworkFailure::Connect)
            } else {
                None
            };
        }
        current = layer.source();
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use wiremock::matchers::{header, method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    /// 手写一次应答后关闭连接。`headers` 不声明长度时响应体读到连接关闭为止，wiremock 造不出这种响应。
    fn raw_reply(headers: &str, body: &[u8]) -> String {
        use std::io::{Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}/", listener.local_addr().unwrap());
        let reply = [
            format!("HTTP/1.1 200 OK\r\nConnection: close\r\n{headers}\r\n").into_bytes(),
            body.to_vec(),
        ]
        .concat();
        std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut head = Vec::new();
            let mut byte = [0u8; 1];
            while !head.ends_with(b"\r\n\r\n") {
                stream.read_exact(&mut byte).unwrap();
                head.push(byte[0]);
            }
            stream.write_all(&reply).unwrap();
        });
        url
    }

    async fn capped(url: &str, limit: u64) -> std::result::Result<Vec<u8>, BodyReadError> {
        let response = build_client().unwrap().get(url).send().await.unwrap();
        read_body_capped(response, limit).await
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn capped_read_accepts_a_body_of_exactly_the_limit() {
        let url = raw_reply("Content-Length: 8\r\n", b"12345678");
        assert_eq!(capped(&url, 8).await.unwrap(), b"12345678");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn capped_read_refuses_a_declared_length_over_the_limit_without_the_body() {
        // 只声明不发正文：真去读就会报传输错误，而不是这里的超限。
        let url = raw_reply("Content-Length: 9\r\n", b"");
        match capped(&url, 8).await {
            Err(BodyReadError::TooLarge { size: 9, limit: 8 }) => {}
            other => panic!("应按声明的长度拒绝：{other:?}"),
        }
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn capped_read_stops_an_undeclared_body_once_it_passes_the_limit() {
        let url = raw_reply("", &[b'x'; 64]);
        match capped(&url, 8).await {
            Err(BodyReadError::TooLarge { size, limit: 8 }) => {
                assert!((9..=64).contains(&size), "{size}");
            }
            other => panic!("应在累计超限时中止：{other:?}"),
        }
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn capped_read_reports_a_body_cut_off_midway_as_transport() {
        let url = raw_reply("Content-Length: 64\r\n", b"short");
        match capped(&url, 1024).await {
            Err(BodyReadError::Transport(source)) => assert!(source.is_decode(), "{source:?}"),
            other => panic!("应为传输错误：{other:?}"),
        }
    }

    /// 模拟上层错误把 reqwest 错误挂在 source 上的样子。
    #[derive(Debug, thiserror::Error)]
    #[error("下载失败")]
    struct Wrapped(#[source] reqwest::Error);

    fn closed_port_url() -> String {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        drop(listener);
        format!("http://127.0.0.1:{port}/file")
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn refused_connection_is_a_connect_failure_wherever_it_sits_in_the_chain() {
        let err = build_client()
            .unwrap()
            .get(closed_port_url())
            .send()
            .await
            .unwrap_err();
        assert_eq!(network_failure(&err), Some(NetworkFailure::Connect));
        let wrapped = Wrapped(err);
        assert_eq!(network_failure(&wrapped), Some(NetworkFailure::Connect));
        assert_eq!(NetworkFailure::Connect.code(), "connect");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn no_response_within_the_deadline_is_a_timeout() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .respond_with(ResponseTemplate::new(200).set_delay(Duration::from_secs(5)))
            .mount(&server)
            .await;
        let err = build_client()
            .unwrap()
            .get(format!("{}/slow", server.uri()))
            .timeout(Duration::from_millis(200))
            .send()
            .await
            .unwrap_err();
        assert_eq!(
            network_failure(&Wrapped(err)),
            Some(NetworkFailure::Timeout)
        );
        assert_eq!(NetworkFailure::Timeout.code(), "timeout");
    }

    /// 收到了响应只是状态码不对，网络是通的。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn an_error_status_or_a_non_http_error_is_not_a_network_failure() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .respond_with(ResponseTemplate::new(503))
            .mount(&server)
            .await;
        let status = build_client()
            .unwrap()
            .get(format!("{}/busy", server.uri()))
            .send()
            .await
            .unwrap()
            .error_for_status()
            .unwrap_err();
        assert_eq!(network_failure(&Wrapped(status)), None);
        let io = std::io::Error::new(std::io::ErrorKind::TimedOut, "磁盘超时");
        assert_eq!(network_failure(&io), None);
    }

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

    /// 起点 302 到终点；终点只认带配置 UA 的请求。
    async fn mount_redirect_pair(server: &MockServer, ua: &str) {
        Mock::given(method("GET"))
            .and(path("/start"))
            .respond_with(
                ResponseTemplate::new(302)
                    .insert_header("location", format!("{}/end", server.uri())),
            )
            .mount(server)
            .await;
        Mock::given(method("GET"))
            .and(path("/end"))
            .and(header("user-agent", ua))
            .respond_with(ResponseTemplate::new(200).set_body_string("arrived"))
            .mount(server)
            .await;
    }

    fn paths_requested(requests: &[wiremock::Request]) -> Vec<String> {
        requests.iter().map(|r| r.url.path().to_owned()).collect()
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn manual_redirect_client_hands_the_302_back_without_following() {
        let server = MockServer::start().await;
        let ua = "Petalfall/7.7.7-manual";
        mount_redirect_pair(&server, ua).await;
        let config = HttpConfig {
            user_agent: ua.to_owned(),
            ..HttpConfig::default()
        };

        let resp = build_manual_redirect_client_with(&config)
            .unwrap()
            .get(format!("{}/start", server.uri()))
            .send()
            .await
            .unwrap();
        assert_eq!(resp.status().as_u16(), 302);
        assert_eq!(
            resp.headers().get("location").unwrap().to_str().unwrap(),
            format!("{}/end", server.uri())
        );
        assert_eq!(resp.url().path(), "/start");
        let requests = server.received_requests().await.unwrap();
        assert_eq!(paths_requested(&requests), vec!["/start"]);
        assert_eq!(
            requests[0]
                .headers
                .get("user-agent")
                .unwrap()
                .to_str()
                .unwrap(),
            ua,
            "除跳转策略外沿用同一份配置"
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn default_client_still_follows_the_302() {
        let server = MockServer::start().await;
        mount_redirect_pair(&server, USER_AGENT).await;
        // 默认配置版本也不跟随。
        let manual = build_manual_redirect_client()
            .unwrap()
            .get(format!("{}/start", server.uri()))
            .send()
            .await
            .unwrap();
        assert_eq!(manual.status().as_u16(), 302);

        let resp = build_client()
            .unwrap()
            .get(format!("{}/start", server.uri()))
            .send()
            .await
            .unwrap();
        assert_eq!(resp.status().as_u16(), 200);
        assert_eq!(resp.url().path(), "/end");
        assert_eq!(resp.text().await.unwrap(), "arrived");
        let requests = server.received_requests().await.unwrap();
        assert_eq!(paths_requested(&requests), vec!["/start", "/start", "/end"]);
    }
}
