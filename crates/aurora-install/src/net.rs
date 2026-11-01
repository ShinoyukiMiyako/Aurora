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

use aurora_base::retry::{RetryPolicy, retry_async};
use aurora_download::SourcePlan;

use crate::error::{Error, Result};

/// 带退避重试地 GET 一个 URL 的响应体字节。
pub(crate) async fn get_bytes(
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
        let bytes = resp.bytes().await.map_err(|source| Error::Http {
            url: url.to_owned(),
            source,
        })?;
        Ok::<Vec<u8>, Error>(bytes.to_vec())
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

/// 依次尝试各候选地址，返回第一个成功的响应体。
///
/// 全部失败时：只有一个候选就原样返回它的错误（没有换源可言，多包一层只会让上层的错误映射认不出它）；
/// 两个及以上返回 [`Error::AllSourcesFailed`]，按尝试顺序带上每个候选的失败原因。
pub(crate) async fn get_bytes_from(
    client: &reqwest::Client,
    sources: Option<&SourcePlan>,
    url: &str,
    policy: &RetryPolicy,
    context: &str,
) -> Result<Vec<u8>> {
    first_success(client, sources, url, policy, context, Ok).await
}

/// GET 并用 serde_json 反序列化（失败时带上报文上下文），按下载源方案在候选地址间兜底。
///
/// 每个候选取到字节就当场解析，解析失败也换下一个：镜像偶尔回一页错误提示或截断的报文，状态码却是
/// 200，只看传输成败会把这份读不懂的内容当成功交出去，另一个源明明有好的也用不上。
pub(crate) async fn get_json_from<T: serde::de::DeserializeOwned>(
    client: &reqwest::Client,
    sources: Option<&SourcePlan>,
    url: &str,
    policy: &RetryPolicy,
    context: &str,
) -> Result<T> {
    first_success(client, sources, url, policy, context, |bytes| {
        parse_json(&bytes, context)
    })
    .await
}

/// 逐个候选取字节并交给 `decode`，返回第一个取到且解码成功的结果；失败的聚合规则见 [`get_bytes_from`]。
async fn first_success<T>(
    client: &reqwest::Client,
    sources: Option<&SourcePlan>,
    url: &str,
    policy: &RetryPolicy,
    context: &str,
    decode: impl Fn(Vec<u8>) -> Result<T>,
) -> Result<T> {
    let mut attempts = Vec::new();
    let mut last = None;
    for candidate in candidates(sources, url)? {
        let outcome = match get_bytes(client, &candidate, policy).await {
            Ok(bytes) => decode(bytes),
            Err(err) => Err(err),
        };
        match outcome {
            Ok(value) => return Ok(value),
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
mod tests {
    use super::*;
    use aurora_base::mirror::MirrorSource;
    use aurora_base::retry::RetryableError;
    use std::time::Duration;
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

    impl aurora_download::SourceResolver for Fixed {
        fn resolve(&self, _url: &str, source: MirrorSource) -> aurora_download::Result<String> {
            Ok(match source {
                MirrorSource::Official => self.official.clone(),
                MirrorSource::BmclApi => self.mirror.clone(),
            })
        }
    }

    fn plan_between(server: &MockServer, official: &str, mirror: &str) -> SourcePlan {
        SourcePlan::with_resolver(
            vec![MirrorSource::Official, MirrorSource::BmclApi],
            std::sync::Arc::new(Fixed {
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
        let body = get_bytes_from(&client, Some(&plan), UPSTREAM, &fast_policy(), "测试报文")
            .await
            .unwrap();
        assert_eq!(body, b"ok");

        let only_broken = SourcePlan::with_resolver(
            vec![MirrorSource::Official],
            std::sync::Arc::new(Fixed {
                official: format!("{}/broken", server.uri()),
                mirror: format!("{}/good", server.uri()),
            }),
        );
        let err = get_bytes_from(
            &client,
            Some(&only_broken),
            UPSTREAM,
            &fast_policy(),
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
        let value: serde_json::Value =
            get_json_from(&client, Some(&plan), UPSTREAM, &fast_policy(), "版本 JSON")
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
}
