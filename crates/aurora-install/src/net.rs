//! 元数据抓取的薄封装。
//!
//! 安装流程里除了「下文件」（走 aurora-download 引擎），还要「读元数据」：版本清单、版本 JSON、
//! Fabric/Quilt meta、Forge maven-metadata。这些是小报文、需在内存里解析，故用注入的
//! `reqwest::Client` 直接 GET，并在退避重试下取回字节（5xx/超时自动重试）。报文一律交给
//! serde_json 自行解析（与 aurora-java 一致），不启用 reqwest 的 json 特性。
//!
//! 调用方给了下载源调度方案时，按它把官方地址展开成候选（官方 / 镜像，按策略排序），逐个尝试：
//! 国内直连 meta.fabricmc.net、maven.minecraftforge.net 经常不通，单源抓取会让加载器列表与安装
//! 直接失败，而文件下载早已有镜像兜底。
//!
//! 给了取消令牌时，等连接、等响应头、读响应体与两次尝试之间的退避都看它：令牌一触发就丢下进行中的
//! 请求返回已取消。元数据只进内存、不落盘，半途丢下请求没有要清理的东西；不看令牌的话，一次卡住的
//! 抓取要等满客户端超时加整轮退避才返回，远超取消时限。

use aurora_base::http::{BodyReadError, METADATA_MAX_BYTES, read_body_capped};
use aurora_base::retry::{RetryPolicy, retry_async};
use aurora_download::{CancellationToken, SourcePlan};

use crate::error::{Error, Result};

/// 带退避重试地 GET 一个 URL 的响应体字节；`cancel` 触发即以已取消返回。
pub(crate) async fn get_bytes(
    client: &reqwest::Client,
    url: &str,
    policy: &RetryPolicy,
    cancel: Option<&CancellationToken>,
) -> Result<Vec<u8>> {
    let fetch = fetch_with_retry(client, url, policy);
    let Some(token) = cancel else {
        return fetch.await;
    };
    match token.run_until_cancelled(fetch).await {
        Some(result) => result,
        None => Err(aurora_download::Error::Cancelled.into()),
    }
}

async fn fetch_with_retry(
    client: &reqwest::Client,
    url: &str,
    policy: &RetryPolicy,
) -> Result<Vec<u8>> {
    retry_async(policy, || async {
        let resp = client
            .get(url)
            .send()
            .await
            .map_err(|source| Error::Http {
                url: url.to_owned(),
                source,
            })?
            .error_for_status()
            .map_err(|source| Error::Http {
                url: url.to_owned(),
                source,
            })?;
        read_body_capped(resp, METADATA_MAX_BYTES)
            .await
            .map_err(|err| match err {
                BodyReadError::TooLarge { size, limit } => Error::ResponseTooLarge {
                    url: url.to_owned(),
                    size,
                    limit,
                },
                BodyReadError::Transport(source) => Error::Http {
                    url: url.to_owned(),
                    source,
                },
            })
    })
    .await
}

/// 按下载源方案展开官方地址的全部候选；没给方案时只有官方地址本身。
pub(crate) fn candidates(sources: Option<&SourcePlan>, url: &str) -> Result<Vec<String>> {
    match sources {
        Some(plan) => Ok(plan.candidates(url)?),
        None => Ok(vec![url.to_owned()]),
    }
}

/// GET 并用 serde_json 反序列化（失败时带上报文上下文），按下载源方案在候选地址间兜底。
pub(crate) async fn get_json_from<T: serde::de::DeserializeOwned>(
    client: &reqwest::Client,
    sources: Option<&SourcePlan>,
    url: &str,
    policy: &RetryPolicy,
    cancel: Option<&CancellationToken>,
    context: &str,
) -> Result<T> {
    get_decoded_from(client, sources, url, policy, cancel, context, |bytes| {
        parse_json(&bytes, context)
    })
    .await
}

/// 依次尝试各候选地址，取到字节就当场交给 `decode`，返回第一个解码成功的结果。
///
/// 解码失败也换下一个：镜像偶尔回一页错误提示或截断的报文，状态码却是 200，只看传输成败会把这份读不懂
/// 的内容当成功交出去，另一个源明明有好的也用不上。取消不换源：它是调用方的决定，不是这个源的故障。
///
/// 全部失败时：只有一个候选就原样返回它的错误（没有换源可言，多包一层只会让上层的错误映射认不出它）；
/// 两个及以上返回 [`Error::AllSourcesFailed`]，按尝试顺序带上每个候选的失败原因。
pub(crate) async fn get_decoded_from<T>(
    client: &reqwest::Client,
    sources: Option<&SourcePlan>,
    url: &str,
    policy: &RetryPolicy,
    cancel: Option<&CancellationToken>,
    context: &str,
    decode: impl Fn(Vec<u8>) -> Result<T>,
) -> Result<T> {
    let mut attempts = Vec::new();
    let mut last = None;
    for candidate in candidates(sources, url)? {
        let outcome = match get_bytes(client, &candidate, policy, cancel).await {
            Ok(bytes) => decode(bytes),
            Err(err) => Err(err),
        };
        match outcome {
            Ok(value) => return Ok(value),
            Err(err) if err.is_cancelled() => return Err(err),
            Err(err) => {
                tracing::warn!(url = %candidate, error = %err, "元数据抓取失败，换下一个下载源");
                attempts.push(describe_attempt(&candidate, &err));
                last = Some(err);
            }
        }
    }
    let last = last.expect("候选地址至少有官方地址本身");
    if attempts.len() == 1 {
        return Err(last);
    }
    Err(Error::AllSourcesFailed {
        context: context.to_owned(),
        attempts,
        last: Box::new(last),
    })
}

/// 一次失败尝试的完整描述：地址、错误本身，再接上它 source 链的每一层。只记顶层会丢掉真正的原因
/// （状态码、连接被拒、JSON 第几行出错都在下层）。
fn describe_attempt(url: &str, err: &Error) -> String {
    let mut text = format!("{url}：{err}");
    let mut cause = std::error::Error::source(err);
    while let Some(layer) = cause {
        text.push('：');
        text.push_str(&layer.to_string());
        cause = layer.source();
    }
    text
}

/// 直接从字节反序列化：编码损坏要如实报错，不能先做有损 UTF-8 转换把坏字节换成替换符再解析。
pub(crate) fn parse_json<T: serde::de::DeserializeOwned>(bytes: &[u8], context: &str) -> Result<T> {
    serde_json::from_slice(bytes).map_err(|source| Error::Json {
        context: context.to_owned(),
        source,
    })
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use aurora_base::mirror::MirrorSource;
    use aurora_base::retry::RetryableError;
    use aurora_download::SourceResolver;
    use std::io::{Read, Write};
    use std::sync::Arc;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::time::{Duration, Instant};
    use wiremock::matchers::{method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    fn fast_policy() -> RetryPolicy {
        RetryPolicy {
            max_attempts: 1,
            initial_delay: Duration::from_millis(1),
            max_delay: Duration::from_millis(1),
            multiplier: 1.0,
            jitter: false,
        }
    }

    #[test]
    fn parse_json_rejects_invalid_utf8_instead_of_replacing_it() {
        let err = parse_json::<serde_json::Value>(b"{\"id\":\"\xff\"}", "版本 JSON").unwrap_err();
        assert!(matches!(err, Error::Json { ref context, .. } if context == "版本 JSON"));
    }

    #[test]
    fn candidates_without_plan_is_the_url_itself() {
        let url = "https://meta.fabricmc.net/v2/versions/game";
        assert_eq!(candidates(None, url).unwrap(), vec![url.to_owned()]);
        let plan = SourcePlan::new(vec![MirrorSource::BmclApi, MirrorSource::Official]);
        assert_eq!(
            candidates(Some(&plan), url).unwrap(),
            vec![
                "https://bmclapi2.bangbang93.com/fabric-meta/v2/versions/game".to_owned(),
                url.to_owned(),
            ]
        );
    }

    /// 官方候选钉到 `official`、镜像候选钉到 `mirror`，与真实镜像改写表无关。
    #[derive(Debug)]
    struct Fixed {
        official: String,
        mirror: String,
    }

    impl SourceResolver for Fixed {
        fn resolve(&self, _url: &str, source: MirrorSource) -> aurora_download::Result<String> {
            Ok(match source {
                MirrorSource::Official => self.official.clone(),
                MirrorSource::BmclApi => self.mirror.clone(),
            })
        }
    }

    pub(crate) fn plan_between(server: &MockServer, official: &str, mirror: &str) -> SourcePlan {
        SourcePlan::with_resolver(
            vec![MirrorSource::Official, MirrorSource::BmclApi],
            Arc::new(Fixed {
                official: format!("{}{official}", server.uri()),
                mirror: format!("{}{mirror}", server.uri()),
            }),
        )
    }

    async fn mount(server: &MockServer, route: &str, response: ResponseTemplate, times: u64) {
        Mock::given(method("GET"))
            .and(path(route))
            .respond_with(response)
            .expect(times)
            .mount(server)
            .await;
    }

    const UPSTREAM: &str = "https://x.invalid/a";

    async fn get_bytes_from(
        client: &reqwest::Client,
        sources: Option<&SourcePlan>,
        url: &str,
        policy: &RetryPolicy,
        cancel: Option<&CancellationToken>,
        context: &str,
    ) -> Result<Vec<u8>> {
        get_decoded_from(client, sources, url, policy, cancel, context, Ok).await
    }

    /// 第一个候选 503 时换第二个取到；只有一个候选时失败原样返回它自己的 Http 错误，不包聚合层。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn get_bytes_from_falls_back_to_next_candidate() {
        let server = MockServer::start().await;
        mount(&server, "/broken", ResponseTemplate::new(503), 2).await;
        mount(
            &server,
            "/good",
            ResponseTemplate::new(200).set_body_string("ok"),
            1,
        )
        .await;
        let client = aurora_base::http::build_client().unwrap();
        let plan = plan_between(&server, "/broken", "/good");
        let body = get_bytes_from(
            &client,
            Some(&plan),
            UPSTREAM,
            &fast_policy(),
            None,
            "测试报文",
        )
        .await
        .unwrap();
        assert_eq!(body, b"ok");

        let only_broken = SourcePlan::with_resolver(
            vec![MirrorSource::Official],
            Arc::new(Fixed {
                official: format!("{}/broken", server.uri()),
                mirror: format!("{}/good", server.uri()),
            }),
        );
        let err = get_bytes_from(
            &client,
            Some(&only_broken),
            UPSTREAM,
            &fast_policy(),
            None,
            "测试报文",
        )
        .await
        .unwrap_err();
        assert!(
            matches!(err, Error::Http { ref url, .. } if url.ends_with("/broken")),
            "实际：{err:?}"
        );
    }

    /// 第一个候选回 200 但内容不是合法 JSON：不把它当成功，换第二个候选取到真正的报文。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn get_json_from_moves_on_when_a_candidate_returns_unparsable_body() {
        let server = MockServer::start().await;
        mount(
            &server,
            "/garbled",
            ResponseTemplate::new(200).set_body_string("<html>维护中</html>"),
            1,
        )
        .await;
        mount(
            &server,
            "/clean",
            ResponseTemplate::new(200).set_body_string(r#"{"id":"1.21.1"}"#),
            1,
        )
        .await;
        let client = aurora_base::http::build_client().unwrap();
        let plan = plan_between(&server, "/garbled", "/clean");
        let value: serde_json::Value = get_json_from(
            &client,
            Some(&plan),
            UPSTREAM,
            &fast_policy(),
            None,
            "版本 JSON",
        )
        .await
        .unwrap();
        assert_eq!(value["id"], "1.21.1");
    }

    /// 两个候选都失败：聚合成 AllSourcesFailed，attempts 按尝试顺序各含自己的地址与下层原因，
    /// source 是第二个候选的原错误。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn every_candidate_failing_keeps_each_reason_in_order() {
        let server = MockServer::start().await;
        mount(&server, "/down", ResponseTemplate::new(503), 1).await;
        mount(
            &server,
            "/garbled",
            ResponseTemplate::new(200).set_body_string("not json"),
            1,
        )
        .await;
        let client = aurora_base::http::build_client().unwrap();
        let plan = plan_between(&server, "/down", "/garbled");
        let err = get_json_from::<serde_json::Value>(
            &client,
            Some(&plan),
            UPSTREAM,
            &fast_policy(),
            None,
            "版本清单",
        )
        .await
        .unwrap_err();
        let source_text = std::error::Error::source(&err)
            .expect("聚合错误应挂着最后一个候选的错误")
            .to_string();
        let Error::AllSourcesFailed {
            context,
            attempts,
            last,
        } = &err
        else {
            panic!("应聚合为 AllSourcesFailed，实际：{err:?}");
        };
        assert_eq!(context, "版本清单");
        assert_eq!(attempts.len(), 2);
        let down = format!("{}/down", server.uri());
        let garbled = format!("{}/garbled", server.uri());
        assert!(
            attempts[0].starts_with(&format!("{down}：")),
            "{attempts:?}"
        );
        assert!(
            attempts[0].contains("503"),
            "第一条要带上下层的状态码：{attempts:?}"
        );
        assert!(
            attempts[1].starts_with(&format!("{garbled}：")),
            "{attempts:?}"
        );
        assert!(
            attempts[1].contains("解析 JSON 失败: 版本清单"),
            "{attempts:?}"
        );
        assert!(
            matches!(**last, Error::Json { ref context, .. } if context == "版本清单"),
            "last 应是第二个候选的原错误：{last:?}"
        );
        assert_eq!(source_text, last.to_string());
        assert!(
            err.to_string()
                .starts_with("版本清单 在全部 2 个下载源上都失败："),
            "{err}"
        );
        assert!(!err.is_retryable());
    }

    /// 两次尝试之间的退避长到测试期间等不完，取消落在退避里时看得出有没有被打断。
    fn slow_backoff_policy() -> RetryPolicy {
        RetryPolicy {
            max_attempts: 3,
            initial_delay: Duration::from_secs(30),
            max_delay: Duration::from_secs(30),
            multiplier: 1.0,
            jitter: false,
        }
    }

    /// 一次手写的应答：声明 `declared` 字节，只写出 `body`；`hold` 为写完后挂住连接的时长。
    struct RawReply {
        declared: usize,
        body: Vec<u8>,
        hold: Duration,
    }

    /// 按连接顺序逐个交出 `replies` 的 HTTP 端点。wiremock 造不出「响应头发完、响应体只到一半」，
    /// 读响应体途中断开或卡住只能这样模拟。返回地址与已接受的连接数。
    fn raw_server(replies: Vec<RawReply>) -> (String, Arc<AtomicUsize>) {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}/meta.json", listener.local_addr().unwrap());
        let accepted = Arc::new(AtomicUsize::new(0));
        let counter = accepted.clone();
        std::thread::spawn(move || {
            for reply in replies {
                let (mut stream, _) = listener.accept().unwrap();
                counter.fetch_add(1, Ordering::SeqCst);
                let mut head = Vec::new();
                let mut byte = [0u8; 1];
                while !head.ends_with(b"\r\n\r\n") {
                    stream.read_exact(&mut byte).unwrap();
                    head.push(byte[0]);
                }
                let status = format!(
                    "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                    reply.declared
                );
                stream.write_all(status.as_bytes()).unwrap();
                stream.write_all(&reply.body).unwrap();
                stream.flush().unwrap();
                std::thread::sleep(reply.hold);
            }
        });
        (url, accepted)
    }

    /// 让抓取先跑 `before` 这么久（期间不该自己结束），再触发取消；返回结果与从触发到返回的用时。
    async fn cancel_midway(
        fetch: impl std::future::Future<Output = Result<Vec<u8>>>,
        token: &CancellationToken,
        before: Duration,
    ) -> (Result<Vec<u8>>, Duration) {
        tokio::pin!(fetch);
        assert!(
            tokio::time::timeout(before, &mut fetch).await.is_err(),
            "触发取消之前抓取不该自己结束"
        );
        let cancelled_at = Instant::now();
        token.cancel();
        let result = fetch.await;
        (result, cancelled_at.elapsed())
    }

    fn assert_cancelled_promptly(result: Result<Vec<u8>>, waited: Duration) {
        let err = result.expect_err("取消后应以错误返回");
        assert!(err.is_cancelled(), "应为已取消，实际：{err:?}");
        assert!(
            waited < Duration::from_secs(1),
            "取消后应在 1 秒内返回，实际等了 {waited:?}"
        );
    }

    /// 服务器迟迟不回响应头：取消立刻生效，不等满客户端超时。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn cancelling_while_waiting_for_the_response_returns_within_a_second() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/slow.json"))
            .respond_with(
                ResponseTemplate::new(200)
                    .set_body_string("{}")
                    .set_delay(Duration::from_secs(10)),
            )
            .mount(&server)
            .await;
        let client = aurora_base::http::build_client().unwrap();
        let token = CancellationToken::new();
        let url = format!("{}/slow.json", server.uri());

        let policy = fast_policy();
        let fetch = get_bytes(&client, &url, &policy, Some(&token));
        let (result, waited) = cancel_midway(fetch, &token, Duration::from_millis(300)).await;
        assert_cancelled_promptly(result, waited);
    }

    /// 响应头已到、响应体只来了一截就卡住：读响应体期间同样响应取消。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn cancelling_while_the_body_is_stalled_returns_within_a_second() {
        let (url, _) = raw_server(vec![RawReply {
            declared: 1000,
            body: b"{\"versions\":".to_vec(),
            hold: Duration::from_secs(10),
        }]);
        let client = aurora_base::http::build_client().unwrap();
        let token = CancellationToken::new();

        let policy = fast_policy();
        let fetch = get_bytes(&client, &url, &policy, Some(&token));
        let (result, waited) = cancel_midway(fetch, &token, Duration::from_millis(300)).await;
        assert_cancelled_promptly(result, waited);
    }

    /// 第一次 503 后进入 30 秒的退避：取消打断退避，不再发第二次请求。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn cancelling_during_backoff_returns_within_a_second_without_retrying() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/busy.json"))
            .respond_with(ResponseTemplate::new(503))
            .expect(1)
            .mount(&server)
            .await;
        let client = aurora_base::http::build_client().unwrap();
        let token = CancellationToken::new();
        let url = format!("{}/busy.json", server.uri());

        let policy = slow_backoff_policy();
        let fetch = get_bytes(&client, &url, &policy, Some(&token));
        tokio::pin!(fetch);
        // 等第一次请求真正落到服务器、拿到 503 进入退避之后再取消，量的才是退避期间的响应。
        let first_answered = async {
            while server.received_requests().await.unwrap().is_empty() {
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
            tokio::time::sleep(Duration::from_millis(200)).await;
        };
        tokio::select! {
            _ = &mut fetch => panic!("退避 30 秒期间抓取不该自己结束"),
            () = first_answered => {}
        }
        let cancelled_at = Instant::now();
        token.cancel();
        let result = fetch.await;
        assert_cancelled_promptly(result, cancelled_at.elapsed());
    }

    /// 令牌在抓取开始前就已触发：一个请求都不发。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn an_already_cancelled_token_sends_no_request() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .respond_with(ResponseTemplate::new(200).set_body_string("{}"))
            .expect(0)
            .mount(&server)
            .await;
        let client = aurora_base::http::build_client().unwrap();
        let token = CancellationToken::new();
        token.cancel();

        let err = get_json_from::<serde_json::Value>(
            &client,
            None,
            &format!("{}/a.json", server.uri()),
            &fast_policy(),
            Some(&token),
            "版本清单",
        )
        .await
        .unwrap_err();
        assert!(err.is_cancelled(), "实际：{err:?}");
    }

    /// 第一个候选卡住时取消：直接以已取消返回，不再去试下一个候选。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn cancelling_does_not_fall_back_to_the_next_candidate() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/stuck"))
            .respond_with(ResponseTemplate::new(200).set_delay(Duration::from_secs(10)))
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path("/spare"))
            .respond_with(ResponseTemplate::new(200).set_body_string("ok"))
            .expect(0)
            .mount(&server)
            .await;
        let client = aurora_base::http::build_client().unwrap();
        let plan = plan_between(&server, "/stuck", "/spare");
        let token = CancellationToken::new();
        let policy = fast_policy();

        let fetch = get_bytes_from(
            &client,
            Some(&plan),
            UPSTREAM,
            &policy,
            Some(&token),
            "测试报文",
        );
        let (result, waited) = cancel_midway(fetch, &token, Duration::from_millis(300)).await;
        assert_cancelled_promptly(result, waited);
    }

    /// 读响应体途中连接被对端断开：同一个源再试一次就拿到完整报文。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_body_cut_off_midway_is_retried_from_the_same_source() {
        let full = br#"{"versions":[{"id":"1.20.1"}]}"#.to_vec();
        let (url, accepted) = raw_server(vec![
            RawReply {
                declared: full.len(),
                body: full[..7].to_vec(),
                hold: Duration::ZERO,
            },
            RawReply {
                declared: full.len(),
                body: full.clone(),
                hold: Duration::ZERO,
            },
        ]);
        let client = aurora_base::http::build_client().unwrap();
        let twice = RetryPolicy {
            max_attempts: 2,
            ..fast_policy()
        };

        let body = get_bytes(&client, &url, &twice, None).await.unwrap();

        assert_eq!(body, full);
        assert_eq!(accepted.load(Ordering::SeqCst), 2, "应同源重试恰好一次");
    }

    /// 响应头声明的长度超过上限：不读正文，也不重试，同一个源再来一次还是这么大。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn an_oversized_response_is_refused_without_a_retry() {
        let declared = aurora_base::http::METADATA_MAX_BYTES as usize + 1;
        let (url, accepted) = raw_server(vec![
            RawReply {
                declared,
                body: Vec::new(),
                hold: Duration::ZERO,
            },
            RawReply {
                declared: 2,
                body: b"{}".to_vec(),
                hold: Duration::ZERO,
            },
        ]);
        let client = aurora_base::http::build_client().unwrap();
        let twice = RetryPolicy {
            max_attempts: 2,
            ..fast_policy()
        };

        let err = get_bytes(&client, &url, &twice, None).await.unwrap_err();

        match &err {
            Error::ResponseTooLarge {
                url: failed,
                size,
                limit,
            } => {
                assert_eq!(failed, &url);
                assert_eq!(*size, declared as u64);
                assert_eq!(*limit, aurora_base::http::METADATA_MAX_BYTES);
            }
            other => panic!("应为 ResponseTooLarge，实际 {other:?}"),
        }
        assert!(!err.is_retryable());
        assert_eq!(accepted.load(Ordering::SeqCst), 1, "不该重试");
    }

    /// 只有一次机会时照实报出读体失败，并判为值得重试的瞬时故障。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_body_cut_off_midway_is_a_retryable_http_error() {
        let (url, _) = raw_server(vec![RawReply {
            declared: 64,
            body: b"{\"id\":".to_vec(),
            hold: Duration::ZERO,
        }]);
        let client = aurora_base::http::build_client().unwrap();

        let err = get_bytes(&client, &url, &fast_policy(), None)
            .await
            .unwrap_err();

        match &err {
            Error::Http {
                url: failed,
                source,
            } => {
                assert_eq!(failed, &url);
                assert!(
                    source.is_decode(),
                    "reqwest 把读体失败归为 decode 类：{source:?}"
                );
            }
            other => panic!("应为 Http，实际 {other:?}"),
        }
        assert!(err.is_retryable());
        assert!(!err.is_cancelled());
    }
}
