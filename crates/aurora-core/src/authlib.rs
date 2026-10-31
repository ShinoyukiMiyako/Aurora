//! authlib-injector：第三方验证服务器账户启动时注入的 javaagent。
//!
//! 每次用这类账户启动都先查一次最新构建：验证服务器常随 authlib-injector 的新版本调整协议，旧 agent
//! 登录得进却拿不到皮肤是最常见的反馈。查不到（离线、源挂了）时沿用本地最新的一份，一份都没有才失败。
//!
//! 每个构建存成带构建号的独立文件，不覆盖旧文件：正在运行的另一局游戏占着它所用的那份 jar，Windows 上
//! 替换一个被打开的文件会失败。

use std::path::{Path, PathBuf};

use aurora_base::mirror::MirrorSource;
use serde::Deserialize;

use crate::error::Result;

/// 官方发布的最新构建信息。
const OFFICIAL_LATEST: &str = "https://authlib-injector.yushi.moe/artifact/latest.json";
/// BMCLAPI 镜像的最新构建信息；其中的下载地址同样指向镜像。
const BMCL_LATEST: &str =
    "https://bmclapi2.bangbang93.com/mirrors/authlib-injector/artifact/latest.json";
/// 数据目录下存放 agent 的子目录。
const AGENT_DIR: &str = "authlib-injector";
const AGENT_PREFIX: &str = "authlib-injector-";
const AGENT_SUFFIX: &str = ".jar";

/// 一个 authlib-injector 构建。
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub(crate) struct AgentRelease {
    pub build_number: u32,
    pub version: String,
    pub download_url: String,
    pub checksums: AgentChecksums,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub(crate) struct AgentChecksums {
    pub sha256: String,
}

/// 存放 agent 的目录。
pub(crate) fn agent_dir(data_dir: &Path) -> PathBuf {
    data_dir.join(AGENT_DIR)
}

/// 某个构建的 jar 路径。
pub(crate) fn agent_jar(dir: &Path, build_number: u32) -> PathBuf {
    dir.join(format!("{AGENT_PREFIX}{build_number}{AGENT_SUFFIX}"))
}

/// 按下载源顺序给出最新构建信息的地址。
pub(crate) fn latest_urls(sources: &[MirrorSource]) -> Vec<&'static str> {
    sources
        .iter()
        .map(|source| match source {
            MirrorSource::Official => OFFICIAL_LATEST,
            MirrorSource::BmclApi => BMCL_LATEST,
        })
        .collect()
}

/// 查询最新构建失败的原因。
#[derive(Debug, thiserror::Error)]
pub(crate) enum LatestLookupError {
    #[error(transparent)]
    Download(#[from] aurora_download::Error),
    #[error("authlib-injector 构建信息 {url} 无法解析")]
    Parse {
        url: String,
        #[source]
        source: serde_json::Error,
    },
}

impl LatestLookupError {
    /// 连不上（而不是连上了但返回的东西不对）。
    pub(crate) fn is_offline(&self) -> bool {
        matches!(
            self,
            LatestLookupError::Download(aurora_download::Error::Request { .. })
        )
    }
}

/// 依次查询各地址，第一个成功的为准；全部失败时返回最后一个地址的错误。
pub(crate) async fn fetch_latest(
    http: &reqwest::Client,
    urls: &[&str],
) -> std::result::Result<AgentRelease, LatestLookupError> {
    let mut last = None;
    for &url in urls {
        match fetch_from(http, url).await {
            Ok(release) => return Ok(release),
            Err(err) => {
                tracing::warn!(url, error = %err, "查询 authlib-injector 最新构建失败");
                last = Some(err);
            }
        }
    }
    Err(last.expect("调用方至少给出一个地址"))
}

async fn fetch_from(
    http: &reqwest::Client,
    url: &str,
) -> std::result::Result<AgentRelease, LatestLookupError> {
    let request_failed = |source| aurora_download::Error::Request {
        url: url.to_owned(),
        source,
    };
    let response = http.get(url).send().await.map_err(request_failed)?;
    let status = response.status();
    if !status.is_success() {
        return Err(aurora_download::Error::Status {
            url: url.to_owned(),
            status: status.as_u16(),
        }
        .into());
    }
    let bytes = response.bytes().await.map_err(request_failed)?;
    serde_json::from_slice(&bytes).map_err(|source| LatestLookupError::Parse {
        url: url.to_owned(),
        source,
    })
}

/// 本地 jar 的 sha256 是否与构建声明的一致。文件不存在为 `false`。
pub(crate) async fn matches_checksum(jar: &Path, sha256: &str) -> Result<bool> {
    if !tokio::fs::try_exists(jar)
        .await
        .map_err(|source| aurora_base::Error::Io {
            path: jar.to_path_buf(),
            source,
        })?
    {
        return Ok(false);
    }
    let actual = aurora_base::fs::sha256_hex(jar).await?;
    Ok(actual.eq_ignore_ascii_case(sha256))
}

/// 本地构建号最大的一份 agent；目录不存在或没有 agent 为 `None`。
///
/// 目录里的 jar 都是下载完、校验过才改名到位的（下载引擎先写临时文件再原子改名，校验不过的当场删除），
/// 所以离线时直接用它，不再重新校验。
pub(crate) async fn newest_local(dir: &Path) -> Result<Option<PathBuf>> {
    let io = |source| aurora_base::Error::Io {
        path: dir.to_path_buf(),
        source,
    };
    let mut entries = match tokio::fs::read_dir(dir).await {
        Ok(entries) => entries,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(source) => return Err(io(source).into()),
    };
    let mut newest: Option<(u32, PathBuf)> = None;
    while let Some(entry) = entries.next_entry().await.map_err(io)? {
        let name = entry.file_name();
        let Some(build) = name
            .to_str()
            .and_then(|name| name.strip_prefix(AGENT_PREFIX))
            .and_then(|rest| rest.strip_suffix(AGENT_SUFFIX))
            .and_then(|build| build.parse::<u32>().ok())
        else {
            continue;
        };
        if newest.as_ref().is_none_or(|(best, _)| build > *best) {
            newest = Some((build, entry.path()));
        }
    }
    Ok(newest.map(|(_, path)| path))
}

#[cfg(test)]
mod tests {
    use super::*;
    use wiremock::matchers::{method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    const LATEST: &str = r#"{
        "build_number": 53,
        "version": "1.2.5",
        "release_time": "2024-05-02T13:36:22.144+00:00",
        "download_url": "https://authlib-injector.yushi.moe/artifact/53/authlib-injector-1.2.5.jar",
        "checksums": { "sha256": "3bc9ebdc583b36abd2a65b626c4b9f35f21177fbf42a851606eaaea3fd42ee0f" }
    }"#;

    #[test]
    fn source_order_follows_download_policy() {
        assert_eq!(
            latest_urls(&[MirrorSource::BmclApi, MirrorSource::Official]),
            vec![BMCL_LATEST, OFFICIAL_LATEST]
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn falls_through_to_next_source_and_parses_release() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/broken/latest.json"))
            .respond_with(ResponseTemplate::new(502))
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path("/ok/latest.json"))
            .respond_with(ResponseTemplate::new(200).set_body_string(LATEST))
            .mount(&server)
            .await;
        let broken = format!("{}/broken/latest.json", server.uri());
        let ok = format!("{}/ok/latest.json", server.uri());
        let http = aurora_base::http::build_client().unwrap();

        let release = fetch_latest(&http, &[&broken, &ok]).await.unwrap();
        assert_eq!(release.build_number, 53);
        assert_eq!(release.version, "1.2.5");
        assert!(release.download_url.ends_with("authlib-injector-1.2.5.jar"));
        assert_eq!(
            release.checksums.sha256,
            "3bc9ebdc583b36abd2a65b626c4b9f35f21177fbf42a851606eaaea3fd42ee0f"
        );

        // 只剩坏的源时报最后一个源的错误：状态码错不是「离线」。
        let err = fetch_latest(&http, &[&broken]).await.unwrap_err();
        assert!(
            matches!(
                &err,
                LatestLookupError::Download(aurora_download::Error::Status { status: 502, .. })
            ),
            "{err:?}"
        );
        assert!(!err.is_offline());
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn garbage_body_is_a_parse_error_and_refused_connection_is_offline() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/latest.json"))
            .respond_with(ResponseTemplate::new(200).set_body_string("<html>"))
            .mount(&server)
            .await;
        let http = aurora_base::http::build_client().unwrap();
        let garbage = format!("{}/latest.json", server.uri());
        let err = fetch_latest(&http, &[&garbage]).await.unwrap_err();
        assert!(matches!(err, LatestLookupError::Parse { .. }), "{err:?}");
        assert!(!err.is_offline());

        let err = fetch_latest(&http, &["http://127.0.0.1:9/latest.json"])
            .await
            .unwrap_err();
        assert!(err.is_offline(), "{err:?}");
    }

    #[tokio::test]
    async fn newest_local_picks_highest_build_and_ignores_strangers() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = agent_dir(tmp.path());
        assert_eq!(newest_local(&dir).await.unwrap(), None);

        std::fs::create_dir_all(&dir).unwrap();
        for name in [
            "authlib-injector-9.jar",
            "authlib-injector-53.jar",
            "authlib-injector-100.jar.petalfall-part0",
            "authlib-injector-latest.jar",
            "notes.txt",
        ] {
            std::fs::write(dir.join(name), b"x").unwrap();
        }
        assert_eq!(newest_local(&dir).await.unwrap(), Some(agent_jar(&dir, 53)));
    }

    #[tokio::test]
    async fn checksum_compare_ignores_case_and_missing_file_is_false() {
        let tmp = tempfile::tempdir().unwrap();
        let jar = tmp.path().join("a.jar");
        // "abc" 的 sha256。
        let abc = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";
        assert!(!matches_checksum(&jar, abc).await.unwrap());
        std::fs::write(&jar, b"abc").unwrap();
        assert!(
            matches_checksum(&jar, &abc.to_ascii_uppercase())
                .await
                .unwrap()
        );
        assert!(
            !matches_checksum(&jar, &abc.replace('b', "c"))
                .await
                .unwrap()
        );
    }
}
