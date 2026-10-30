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

/// 依次尝试各候选地址，返回第一个成功的响应体；全部失败时返回最后一个候选的错误。
pub(crate) async fn get_bytes_from(
    client: &reqwest::Client,
    sources: Option<&SourcePlan>,
    url: &str,
    policy: &RetryPolicy,
) -> Result<Vec<u8>> {
    let mut last = None;
    for candidate in candidates(sources, url)? {
        match get_bytes(client, &candidate, policy).await {
            Ok(bytes) => return Ok(bytes),
            Err(err) => {
                tracing::warn!(url = %candidate, error = %err, "元数据抓取失败，换下一个下载源");
                last = Some(err);
            }
        }
    }
    Err(last.expect("候选地址至少有官方地址本身"))
}

/// GET 并用 serde_json 反序列化，失败时带上报文上下文。
pub(crate) async fn get_json<T: serde::de::DeserializeOwned>(
    client: &reqwest::Client,
    url: &str,
    policy: &RetryPolicy,
    context: &str,
) -> Result<T> {
    let bytes = get_bytes(client, url, policy).await?;
    parse_json(&bytes, context)
}

/// 同 [`get_json`]，但按下载源方案在候选地址间兜底。
pub(crate) async fn get_json_from<T: serde::de::DeserializeOwned>(
    client: &reqwest::Client,
    sources: Option<&SourcePlan>,
    url: &str,
    policy: &RetryPolicy,
    context: &str,
) -> Result<T> {
    let bytes = get_bytes_from(client, sources, url, policy).await?;
    parse_json(&bytes, context)
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

    /// 第一个候选失败时换下一个；全部失败时报最后一个的错误，不吞。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn get_bytes_from_falls_back_to_next_candidate() {
        use aurora_download::SourceResolver;
        use std::sync::Arc;

        #[derive(Debug)]
        struct Fixed(Vec<String>);
        impl SourceResolver for Fixed {
            fn resolve(&self, _url: &str, source: MirrorSource) -> aurora_download::Result<String> {
                Ok(match source {
                    MirrorSource::Official => self.0[0].clone(),
                    MirrorSource::BmclApi => self.0[1].clone(),
                })
            }
        }

        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/broken"))
            .respond_with(ResponseTemplate::new(404))
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path("/good"))
            .respond_with(ResponseTemplate::new(200).set_body_string("ok"))
            .expect(1)
            .mount(&server)
            .await;
        let client = aurora_base::http::build_client().unwrap();
        let resolver = Arc::new(Fixed(vec![
            format!("{}/broken", server.uri()),
            format!("{}/good", server.uri()),
        ]));
        let plan = SourcePlan::with_resolver(
            vec![MirrorSource::Official, MirrorSource::BmclApi],
            resolver.clone(),
        );
        let body = get_bytes_from(&client, Some(&plan), "https://x.invalid/a", &fast_policy())
            .await
            .unwrap();
        assert_eq!(body, b"ok");

        let only_broken = SourcePlan::with_resolver(vec![MirrorSource::Official], resolver);
        let err = get_bytes_from(
            &client,
            Some(&only_broken),
            "https://x.invalid/a",
            &fast_policy(),
        )
        .await
        .unwrap_err();
        assert!(matches!(err, Error::Http { ref url, .. } if url.ends_with("/broken")));
    }
}
