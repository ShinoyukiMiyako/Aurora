//! 带下载凭据的任务：作用域内每个请求都带头，跳转到作用域外即摘掉，镜像候选各自判定，
//! 401 不重试、不换源、不回退，跳转有上限；不带凭据的任务照旧由共享客户端自动跟随跳转。
//!
//! 作用域用 `127.0.0.1:<端口>` 限定到某一台 wiremock 服务器，不同端口代表不同主机。

use std::sync::Arc;
use std::time::Duration;

use petalfall_base::retry::RetryPolicy;
use petalfall_download::{
    ChunkConfig, ChunkPlan, CredentialRealm, CredentialScope, DownloadConfig, DownloadCredential,
    DownloadTask, Downloader, Error, MirrorSource, SourceHealth, SourcePlan, SourceResolver,
    WatchdogConfig,
};
use wiremock::matchers::{header, method, path};
use wiremock::{Mock, MockServer, Request, ResponseTemplate};

const KEY: &str = "cf-test-key-0123456789";
const KEY_HEADER: &str = "x-api-key";

fn without_range(request: &Request) -> bool {
    !request.headers.contains_key("range")
}

fn client() -> reqwest::Client {
    petalfall_base::http::build_client().expect("构建共享客户端")
}

fn manual_client() -> reqwest::Client {
    petalfall_base::http::build_manual_redirect_client().expect("构建不跳转客户端")
}

fn fast_policy() -> RetryPolicy {
    RetryPolicy {
        max_attempts: 3,
        initial_delay: Duration::from_millis(1),
        max_delay: Duration::from_millis(4),
        multiplier: 2.0,
        jitter: false,
    }
}

fn whole_only() -> ChunkConfig {
    ChunkConfig {
        enabled: false,
        ..ChunkConfig::default()
    }
}

fn small_chunks() -> ChunkConfig {
    ChunkConfig {
        enabled: true,
        min_split_size: 100,
        chunk_size: 300,
        max_chunks: 8,
        chunk_concurrency: 4,
        excluded_hosts: Vec::new(),
    }
}

fn config(chunk: ChunkConfig, sources: SourcePlan) -> DownloadConfig {
    DownloadConfig {
        chunk,
        retry: fast_policy(),
        sources,
        watchdog: WatchdogConfig::default(),
    }
}

fn single_source() -> SourcePlan {
    SourcePlan::new(vec![MirrorSource::Official])
}

fn downloader(chunk: ChunkConfig, sources: SourcePlan) -> Downloader {
    Downloader::new(client(), config(chunk, sources)).with_manual_redirect_client(manual_client())
}

/// 只认这一台服务器（主机加端口）的凭据。
fn credential_for(server: &MockServer) -> DownloadCredential {
    let port = server.address().port();
    DownloadCredential::curseforge(KEY)
        .unwrap()
        .with_scope(CredentialScope::new([format!("127.0.0.1:{port}")], false))
}

fn ascii_payload(size: usize) -> Vec<u8> {
    (0..size).map(|i| b'a' + (i % 26) as u8).collect()
}

fn text(bytes: &[u8]) -> String {
    String::from_utf8(bytes.to_vec()).unwrap()
}

async fn requests_to(server: &MockServer, route: &str) -> Vec<Request> {
    server
        .received_requests()
        .await
        .expect("wiremock 默认记录请求")
        .into_iter()
        .filter(|request| request.url.path() == route)
        .collect()
}

fn key_of(request: &Request) -> Option<&str> {
    request
        .headers
        .get(KEY_HEADER)
        .map(|value| value.to_str().unwrap())
}

/// 给分块计划里的每一块挂一个 206 应答；`with_key` 时只认带密钥的请求。
async fn mount_ranges(server: &MockServer, route: &str, payload: &[u8], with_key: bool) {
    let total = payload.len() as u64;
    for chunk in &ChunkPlan::compute(total, 300, 8).chunks {
        let slice = text(&payload[chunk.start as usize..=chunk.end as usize]);
        let mut mock = Mock::given(method("GET")).and(path(route)).and(header(
            "range",
            format!("bytes={}-{}", chunk.start, chunk.end),
        ));
        if with_key {
            mock = mock.and(header(KEY_HEADER, KEY));
        }
        mock.respond_with(
            ResponseTemplate::new(206)
                .insert_header(
                    "content-range",
                    format!("bytes {}-{}/{total}", chunk.start, chunk.end),
                )
                .set_body_string(slice),
        )
        .expect(1)
        .mount(server)
        .await;
    }
}

/// 作用域内的整文件 GET、分片前的探测与每一个 Range GET 都带上密钥。
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn every_request_to_the_scoped_host_carries_the_key() {
    let server = MockServer::start().await;
    let dir = tempfile::tempdir().unwrap();

    // 整文件：没有大小，走单请求。
    Mock::given(method("GET"))
        .and(path("/small.jar"))
        .and(header(KEY_HEADER, KEY))
        .respond_with(ResponseTemplate::new(200).set_body_string("small-body"))
        .expect(1)
        .mount(&server)
        .await;
    let small = dir.path().join("small.jar");
    downloader(small_chunks(), single_source())
        .download(
            &DownloadTask::new(format!("{}/small.jar", server.uri()), &small)
                .with_credential(credential_for(&server)),
        )
        .await
        .unwrap();
    assert_eq!(std::fs::read(&small).unwrap(), b"small-body");

    // 分片：1000 字节切 4 块，先探测再发 4 个 Range。
    let payload = ascii_payload(1000);
    Mock::given(method("GET"))
        .and(path("/big.jar"))
        .and(without_range)
        .and(header(KEY_HEADER, KEY))
        .respond_with(ResponseTemplate::new(200).set_body_string(text(&payload)))
        .expect(1)
        .mount(&server)
        .await;
    mount_ranges(&server, "/big.jar", &payload, true).await;
    let big = dir.path().join("big.jar");
    downloader(small_chunks(), single_source())
        .download(
            &DownloadTask::new(format!("{}/big.jar", server.uri()), &big)
                .with_size(1000)
                .with_credential(credential_for(&server)),
        )
        .await
        .unwrap();
    assert_eq!(std::fs::read(&big).unwrap(), payload);

    let small_requests = requests_to(&server, "/small.jar").await;
    assert_eq!(small_requests.len(), 1);
    assert_eq!(key_of(&small_requests[0]), Some(KEY));
    let big_requests = requests_to(&server, "/big.jar").await;
    assert_eq!(big_requests.len(), 5, "1 次探测加 4 个分片");
    assert_eq!(
        big_requests.iter().filter(|r| without_range(r)).count(),
        1,
        "只有探测不带 Range"
    );
    assert!(
        big_requests.iter().all(|r| key_of(r) == Some(KEY)),
        "探测与分片都要带密钥"
    );
}

/// A 在作用域内、302 到作用域外的 B：A 那一跳带密钥，B 收到的请求一律不带。
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn redirect_to_an_out_of_scope_host_drops_the_key() {
    let origin = MockServer::start().await;
    let cdn = MockServer::start().await;
    let dir = tempfile::tempdir().unwrap();
    let payload = ascii_payload(1000);

    for route in ["/whole.jar", "/big.jar"] {
        Mock::given(method("GET"))
            .and(path(route))
            .respond_with(
                ResponseTemplate::new(302)
                    .insert_header("location", format!("{}{route}", cdn.uri())),
            )
            .mount(&origin)
            .await;
    }
    Mock::given(method("GET"))
        .and(path("/whole.jar"))
        .respond_with(ResponseTemplate::new(200).set_body_string("from-cdn"))
        .mount(&cdn)
        .await;
    Mock::given(method("GET"))
        .and(path("/big.jar"))
        .and(without_range)
        .respond_with(ResponseTemplate::new(200).set_body_string(text(&payload)))
        .mount(&cdn)
        .await;
    mount_ranges(&cdn, "/big.jar", &payload, false).await;

    let engine = downloader(small_chunks(), single_source());
    let whole = dir.path().join("whole.jar");
    engine
        .download(
            &DownloadTask::new(format!("{}/whole.jar", origin.uri()), &whole)
                .with_credential(credential_for(&origin)),
        )
        .await
        .unwrap();
    assert_eq!(std::fs::read(&whole).unwrap(), b"from-cdn");
    let big = dir.path().join("big.jar");
    engine
        .download(
            &DownloadTask::new(format!("{}/big.jar", origin.uri()), &big)
                .with_size(1000)
                .with_credential(credential_for(&origin)),
        )
        .await
        .unwrap();
    assert_eq!(std::fs::read(&big).unwrap(), payload);

    let origin_requests = origin.received_requests().await.unwrap();
    assert_eq!(
        origin_requests.len(),
        2,
        "起点只被整文件请求与探测各打一次，分片直接打终点"
    );
    assert!(origin_requests.iter().all(|r| key_of(r) == Some(KEY)));
    let cdn_requests = cdn.received_requests().await.unwrap();
    assert_eq!(cdn_requests.len(), 1 + 1 + 4, "整文件、探测、4 个分片");
    for request in &cdn_requests {
        assert!(
            !request.headers.contains_key(KEY_HEADER),
            "作用域外的 {} 不该收到密钥",
            request.url
        );
    }
}

/// 跳转两端都在作用域内（edge 302 到 mediafilez 的情形）：两跳都带密钥。
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn redirect_within_scope_keeps_the_key_on_every_hop() {
    let edge = MockServer::start().await;
    let files = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/a.jar"))
        .and(header(KEY_HEADER, KEY))
        .respond_with(
            ResponseTemplate::new(302).insert_header("location", format!("{}/a.jar", files.uri())),
        )
        .expect(1)
        .mount(&edge)
        .await;
    Mock::given(method("GET"))
        .and(path("/a.jar"))
        .and(header(KEY_HEADER, KEY))
        .respond_with(ResponseTemplate::new(200).set_body_string("both-hops"))
        .expect(1)
        .mount(&files)
        .await;
    let scope = CredentialScope::new(
        [
            format!("127.0.0.1:{}", edge.address().port()),
            format!("127.0.0.1:{}", files.address().port()),
        ],
        false,
    );
    let dir = tempfile::tempdir().unwrap();
    let dest = dir.path().join("a.jar");
    downloader(whole_only(), single_source())
        .download(
            &DownloadTask::new(format!("{}/a.jar", edge.uri()), &dest).with_credential(
                DownloadCredential::curseforge(KEY)
                    .unwrap()
                    .with_scope(scope),
            ),
        )
        .await
        .unwrap();
    assert_eq!(std::fs::read(&dest).unwrap(), b"both-hops");
}

/// 只有 Range 请求会跳转的源：分片打在探测解出的原地址上，跳转后的那一跳带着同一个 Range 值、不带密钥。
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn range_header_is_resent_on_every_hop() {
    let origin = MockServer::start().await;
    let cdn = MockServer::start().await;
    let payload = ascii_payload(1000);
    Mock::given(method("GET"))
        .and(path("/big.jar"))
        .and(without_range)
        .respond_with(ResponseTemplate::new(200).set_body_string(text(&payload)))
        .mount(&origin)
        .await;
    let target = format!("{}/big.jar", cdn.uri());
    Mock::given(method("GET"))
        .and(path("/big.jar"))
        .and(|r: &Request| r.headers.contains_key("range"))
        .respond_with(ResponseTemplate::new(307).insert_header("location", target.as_str()))
        .mount(&origin)
        .await;
    mount_ranges(&cdn, "/big.jar", &payload, false).await;

    let dir = tempfile::tempdir().unwrap();
    let dest = dir.path().join("big.jar");
    downloader(small_chunks(), single_source())
        .download(
            &DownloadTask::new(format!("{}/big.jar", origin.uri()), &dest)
                .with_size(1000)
                .with_credential(credential_for(&origin)),
        )
        .await
        .unwrap();
    assert_eq!(std::fs::read(&dest).unwrap(), payload);

    let origin_ranges: Vec<String> = origin
        .received_requests()
        .await
        .unwrap()
        .iter()
        .filter(|r| !without_range(r))
        .inspect(|r| assert_eq!(key_of(r), Some(KEY)))
        .map(|r| r.headers["range"].to_str().unwrap().to_owned())
        .collect();
    let mut cdn_ranges: Vec<String> = cdn
        .received_requests()
        .await
        .unwrap()
        .iter()
        .inspect(|r| assert!(!r.headers.contains_key(KEY_HEADER)))
        .map(|r| r.headers["range"].to_str().unwrap().to_owned())
        .collect();
    let mut origin_sorted = origin_ranges.clone();
    origin_sorted.sort();
    cdn_ranges.sort();
    assert_eq!(origin_ranges.len(), 4);
    assert_eq!(cdn_ranges, origin_sorted, "每一跳的 Range 值相同");
}

/// 把同一个官方地址解析到两台服务器：一台代表 Modrinth CDN，一台代表 BMCLAPI。
struct MirrorPair {
    modrinth: String,
    bmclapi: String,
}

impl SourceResolver for MirrorPair {
    fn resolve(&self, _url: &str, source: MirrorSource) -> petalfall_download::Result<String> {
        Ok(match source {
            MirrorSource::Official => format!("{}/data/x.jar", self.modrinth),
            MirrorSource::BmclApi => format!("{}/maven/x.jar", self.bmclapi),
        })
    }
}

fn two_sources(primary: &MockServer, secondary: &MockServer) -> SourcePlan {
    SourcePlan::with_resolver(
        vec![MirrorSource::Official, MirrorSource::BmclApi],
        Arc::new(MirrorPair {
            modrinth: primary.uri(),
            bmclapi: secondary.uri(),
        }),
    )
}

/// 镜像改写出的每个候选各按自己的主机判定：任务的官方地址在作用域内，也不能让密钥跟到镜像上。
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn mirror_candidates_outside_the_scope_get_no_key() {
    let official = MockServer::start().await;
    let modrinth = MockServer::start().await;
    let bmclapi = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/data/x.jar"))
        .respond_with(ResponseTemplate::new(404))
        .mount(&modrinth)
        .await;
    Mock::given(method("GET"))
        .and(path("/maven/x.jar"))
        .respond_with(ResponseTemplate::new(200).set_body_string("from-mirror"))
        .mount(&bmclapi)
        .await;

    let dir = tempfile::tempdir().unwrap();
    let dest = dir.path().join("x.jar");
    downloader(whole_only(), two_sources(&modrinth, &bmclapi))
        .download(
            &DownloadTask::new(format!("{}/files/x.jar", official.uri()), &dest)
                .with_credential(credential_for(&official)),
        )
        .await
        .unwrap();
    assert_eq!(std::fs::read(&dest).unwrap(), b"from-mirror");

    let modrinth_requests = modrinth.received_requests().await.unwrap();
    let bmclapi_requests = bmclapi.received_requests().await.unwrap();
    assert_eq!(modrinth_requests.len(), 1, "404 不重试，直接换源");
    assert_eq!(bmclapi_requests.len(), 1);
    for request in modrinth_requests.iter().chain(&bmclapi_requests) {
        assert!(!request.headers.contains_key(KEY_HEADER), "{}", request.url);
    }
    assert_eq!(official.received_requests().await.unwrap().len(), 0);
}

/// 带了密钥的那一跳回 401：不重试、不换源，报 CredentialRejected 并带上那一跳的地址。
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn rejected_key_stops_without_retry_or_source_switch() {
    for (label, chunk, size) in [
        ("整文件", whole_only(), None),
        ("分片", small_chunks(), Some(1000u64)),
    ] {
        let cdn = MockServer::start().await;
        let fallback = MockServer::start().await;
        Mock::given(method("GET"))
            .respond_with(ResponseTemplate::new(401))
            .mount(&cdn)
            .await;
        Mock::given(method("GET"))
            .respond_with(ResponseTemplate::new(200).set_body_string("should-not-be-used"))
            .mount(&fallback)
            .await;

        let dir = tempfile::tempdir().unwrap();
        let dest = dir.path().join("x.jar");
        let mut task = DownloadTask::new("https://edge.forgecdn.net/files/1/2/x.jar", &dest)
            .with_credential(credential_for(&cdn));
        task.size = size;
        let err = downloader(chunk, two_sources(&cdn, &fallback))
            .download(&task)
            .await
            .unwrap_err();

        match &err {
            Error::CredentialRejected { realm, url, status } => {
                assert_eq!(*realm, CredentialRealm::CurseForge, "{label}");
                assert_eq!(url, &format!("{}/data/x.jar", cdn.uri()), "{label}");
                assert_eq!(*status, 401, "{label}");
            }
            other => panic!("{label}：期望 CredentialRejected，实际 {other:?}"),
        }
        assert_eq!(
            err.credential_rejection(),
            Some(CredentialRealm::CurseForge)
        );
        assert_eq!(
            cdn.received_requests().await.unwrap().len(),
            1,
            "{label}：401 只请求一次，不重试也不回退整文件"
        );
        assert_eq!(
            fallback.received_requests().await.unwrap().len(),
            0,
            "{label}：不换源"
        );
        assert!(!dest.exists(), "{label}");
    }
}

/// 没带密钥的那一跳收到 401 是普通的状态码错误：照常换源。
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn unauthorized_without_the_key_follows_the_ordinary_path() {
    let elsewhere = MockServer::start().await;
    let cdn = MockServer::start().await;
    let fallback = MockServer::start().await;
    Mock::given(method("GET"))
        .respond_with(ResponseTemplate::new(401))
        .mount(&cdn)
        .await;
    Mock::given(method("GET"))
        .respond_with(ResponseTemplate::new(200).set_body_string("mirror-ok"))
        .mount(&fallback)
        .await;

    let dir = tempfile::tempdir().unwrap();
    let dest = dir.path().join("x.jar");
    // 作用域指向第三台服务器：cdn 那一跳不带密钥。
    downloader(whole_only(), two_sources(&cdn, &fallback))
        .download(
            &DownloadTask::new("https://edge.forgecdn.net/files/1/2/x.jar", &dest)
                .with_credential(credential_for(&elsewhere)),
        )
        .await
        .unwrap();
    assert_eq!(std::fs::read(&dest).unwrap(), b"mirror-ok");
    assert_eq!(cdn.received_requests().await.unwrap().len(), 1);
    assert_eq!(fallback.received_requests().await.unwrap().len(), 1);

    // 不带凭据的任务同理：多源耗尽时最后那次失败是 401 状态码。
    let lonely = MockServer::start().await;
    Mock::given(method("GET"))
        .respond_with(ResponseTemplate::new(401))
        .mount(&lonely)
        .await;
    let err = downloader(whole_only(), single_source())
        .download(&DownloadTask::new(
            format!("{}/y.jar", lonely.uri()),
            dir.path().join("y.jar"),
        ))
        .await
        .unwrap_err();
    assert!(
        matches!(&err, Error::AllSourcesExhausted { last, .. } if matches!(**last, Error::Status { status: 401, .. })),
        "{err:?}"
    );
    assert_eq!(err.credential_rejection(), None);
}

/// `/chain{len}/{n}`：n 小于 len 时 302 到下一跳，否则 200。
fn chain_responder(request: &Request) -> ResponseTemplate {
    let segments: Vec<&str> = request
        .url
        .path()
        .trim_start_matches('/')
        .split('/')
        .collect();
    let len: u32 = segments[0].trim_start_matches("chain").parse().unwrap();
    let n: u32 = segments[1].parse().unwrap();
    if n < len {
        ResponseTemplate::new(302).insert_header("location", format!("/chain{len}/{}", n + 1))
    } else {
        ResponseTemplate::new(200).set_body_string(format!("end-of-{len}"))
    }
}

/// 最多跟 10 跳：恰好 10 跳能落地，第 11 跳报 TooManyRedirects，相对 Location 按当前地址解析。
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_eleventh_redirect_is_refused() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .respond_with(chain_responder)
        .mount(&server)
        .await;
    let dir = tempfile::tempdir().unwrap();
    let engine = downloader(whole_only(), single_source());

    let ten = dir.path().join("ten.jar");
    engine
        .download(
            &DownloadTask::new(format!("{}/chain10/0", server.uri()), &ten)
                .with_credential(credential_for(&server)),
        )
        .await
        .unwrap();
    assert_eq!(std::fs::read(&ten).unwrap(), b"end-of-10");

    let eleven_url = format!("{}/chain11/0", server.uri());
    let err = engine
        .download(
            &DownloadTask::new(eleven_url.as_str(), dir.path().join("eleven.jar"))
                .with_credential(credential_for(&server)),
        )
        .await
        .unwrap_err();
    let Error::AllSourcesExhausted { last, .. } = &err else {
        panic!("实际：{err:?}");
    };
    match last.as_ref() {
        Error::TooManyRedirects { url } => assert_eq!(url, &eleven_url),
        other => panic!("实际：{other:?}"),
    }

    let requests = server.received_requests().await.unwrap();
    let count = |prefix: &str| {
        requests
            .iter()
            .filter(|r| r.url.path().starts_with(prefix))
            .count()
    };
    assert_eq!(count("/chain10/"), 11, "起点加 10 跳");
    assert_eq!(count("/chain11/"), 11, "第 11 个跳转响应不再跟，也不重试");
    assert!(requests.iter().all(|r| key_of(r) == Some(KEY)));
}

/// 3xx 没有 Location：报那一跳的状态码。
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn redirect_without_location_is_a_status_error() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .respond_with(ResponseTemplate::new(302))
        .mount(&server)
        .await;
    let dir = tempfile::tempdir().unwrap();
    let url = format!("{}/nowhere.jar", server.uri());
    let err = downloader(whole_only(), single_source())
        .download(
            &DownloadTask::new(url.as_str(), dir.path().join("nowhere.jar"))
                .with_credential(credential_for(&server)),
        )
        .await
        .unwrap_err();
    let Error::AllSourcesExhausted { last, .. } = &err else {
        panic!("实际：{err:?}");
    };
    match last.as_ref() {
        Error::Status { url: hop, status } => {
            assert_eq!(*status, 302);
            assert_eq!(hop, &url);
        }
        other => panic!("实际：{other:?}"),
    }
}

/// 不带凭据的任务遇到 302，仍由共享客户端自动跟随：装了不跳转客户端也不影响它。
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn tasks_without_credential_still_follow_redirects_automatically() {
    let origin = MockServer::start().await;
    let cdn = MockServer::start().await;
    let payload = ascii_payload(1000);
    for route in ["/plain.jar", "/big.jar"] {
        Mock::given(method("GET"))
            .and(path(route))
            .respond_with(
                ResponseTemplate::new(302)
                    .insert_header("location", format!("{}{route}", cdn.uri())),
            )
            .mount(&origin)
            .await;
    }
    Mock::given(method("GET"))
        .and(path("/plain.jar"))
        .respond_with(ResponseTemplate::new(200).set_body_string("followed"))
        .mount(&cdn)
        .await;
    Mock::given(method("GET"))
        .and(path("/big.jar"))
        .and(without_range)
        .respond_with(ResponseTemplate::new(200).set_body_string(text(&payload)))
        .mount(&cdn)
        .await;
    mount_ranges(&cdn, "/big.jar", &payload, false).await;

    let dir = tempfile::tempdir().unwrap();
    let engine = downloader(small_chunks(), single_source());
    let plain = dir.path().join("plain.jar");
    engine
        .download(&DownloadTask::new(
            format!("{}/plain.jar", origin.uri()),
            &plain,
        ))
        .await
        .unwrap();
    assert_eq!(std::fs::read(&plain).unwrap(), b"followed");
    let big = dir.path().join("big.jar");
    engine
        .download(&DownloadTask::new(format!("{}/big.jar", origin.uri()), &big).with_size(1000))
        .await
        .unwrap();
    assert_eq!(std::fs::read(&big).unwrap(), payload);

    assert_eq!(origin.received_requests().await.unwrap().len(), 2);
    let cdn_requests = cdn.received_requests().await.unwrap();
    assert_eq!(cdn_requests.len(), 1 + 1 + 4);
    assert!(
        cdn_requests
            .iter()
            .all(|r| !r.headers.contains_key(KEY_HEADER))
    );
}

/// 带凭据的任务交给没装不跳转客户端的引擎：开工前就报内部错误，不发请求，不记源的故障。
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn credentialed_task_needs_the_manual_client() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .respond_with(ResponseTemplate::new(200).set_body_string("unreachable"))
        .mount(&server)
        .await;
    let health = Arc::new(SourceHealth::with_policy(1, Duration::from_secs(60)));
    let engine = Downloader::with_health(
        client(),
        config(small_chunks(), single_source()),
        health.clone(),
    );
    let url = format!("{}/x.jar", server.uri());
    let dir = tempfile::tempdir().unwrap();
    let err = engine
        .download(
            &DownloadTask::new(url.as_str(), dir.path().join("x.jar"))
                .with_size(1000)
                .with_credential(credential_for(&server)),
        )
        .await
        .unwrap_err();
    match err {
        Error::Internal { what } => {
            assert_eq!(what, "带下载凭据的任务需要不自动跳转的客户端")
        }
        other => panic!("实际：{other:?}"),
    }
    assert_eq!(server.received_requests().await.unwrap().len(), 0);
    assert!(!health.is_tripped(&url));
    assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 0);
}

/// 引擎之外的单次读取：起点在作用域内带头，302 到作用域外的终点摘掉；Range 两跳都带同一个值；
/// 终点的状态原样交回。带了头的一跳回 401 报 CredentialRejected，url 是这一跳。
#[tokio::test]
async fn credentialed_get_follows_hops_with_the_same_rules_as_tasks() {
    let origin = MockServer::start().await;
    let cdn = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/pack.zip"))
        .respond_with(
            ResponseTemplate::new(302).insert_header("location", format!("{}/pack.zip", cdn.uri())),
        )
        .mount(&origin)
        .await;
    Mock::given(method("GET"))
        .and(path("/pack.zip"))
        .and(header("range", "bytes=-22"))
        .respond_with(ResponseTemplate::new(206).set_body_string("tail"))
        .expect(1)
        .mount(&cdn)
        .await;
    Mock::given(method("GET"))
        .and(path("/locked.zip"))
        .and(header(KEY_HEADER, KEY))
        .respond_with(ResponseTemplate::new(401))
        .expect(1)
        .mount(&origin)
        .await;

    let manual = manual_client();
    let credential = credential_for(&origin);
    let response = petalfall_download::credentialed_get(
        &manual,
        &credential,
        &format!("{}/pack.zip", origin.uri()),
        Some("bytes=-22"),
    )
    .await
    .unwrap();
    assert_eq!(response.status().as_u16(), 206);
    assert_eq!(response.text().await.unwrap(), "tail");
    let first = requests_to(&origin, "/pack.zip").await;
    assert_eq!(first.len(), 1);
    assert_eq!(key_of(&first[0]), Some(KEY));
    assert_eq!(first[0].headers.get("range").unwrap(), "bytes=-22");
    let second = requests_to(&cdn, "/pack.zip").await;
    assert_eq!(second.len(), 1);
    assert_eq!(key_of(&second[0]), None, "作用域外的一跳不带密钥");

    let locked = format!("{}/locked.zip", origin.uri());
    let err = petalfall_download::credentialed_get(&manual, &credential, &locked, None)
        .await
        .unwrap_err();
    assert!(
        matches!(&err, Error::CredentialRejected { realm: CredentialRealm::CurseForge, url, status: 401 } if url == &locked),
        "{err:?}"
    );
    origin.verify().await;
    cdn.verify().await;
}
