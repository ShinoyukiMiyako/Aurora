//! 源健康表与引擎换源的集成测试：坏源熔断后不再拖累后续文件，404 与偶发抖动不判死好源。
//!
//! 两个源分别指向两台独立的 wiremock（不同端口即不同服务实例，健康状况互不干扰）。

use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;

use aurora_base::retry::RetryPolicy;
use aurora_download::{
    ChunkConfig, DownloadConfig, DownloadTask, Downloader, MirrorSource, SourceHealth, SourcePlan,
    SourceResolver, WatchdogConfig,
};
use wiremock::matchers::{method, path};
use wiremock::{Mock, MockServer, Request, ResponseTemplate};

fn client() -> reqwest::Client {
    aurora_base::http::build_client().expect("构建客户端")
}

async fn sha1_of(bytes: &[u8]) -> String {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("hashme");
    tokio::fs::write(&file, bytes).await.unwrap();
    aurora_base::fs::sha1_hex(&file).await.unwrap()
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

/// Official 指向一台服务器，BmclApi 指向另一台，两者都取 `/file`。
struct SplitHostResolver {
    primary: String,
    mirror: String,
}

impl SourceResolver for SplitHostResolver {
    fn resolve(&self, _url: &str, source: MirrorSource) -> aurora_download::Result<String> {
        Ok(match source {
            MirrorSource::Official => format!("{}/file", self.primary),
            MirrorSource::BmclApi => format!("{}/file", self.mirror),
        })
    }
}

fn split_config(primary: &MockServer, mirror: &MockServer) -> DownloadConfig {
    DownloadConfig {
        chunk: ChunkConfig::default(),
        retry: fast_policy(),
        sources: SourcePlan::with_resolver(
            vec![MirrorSource::Official, MirrorSource::BmclApi],
            Arc::new(SplitHostResolver {
                primary: primary.uri(),
                mirror: mirror.uri(),
            }),
        ),
        watchdog: WatchdogConfig::default(),
    }
}

async fn mount_counting(server: &MockServer, template: ResponseTemplate) -> Arc<AtomicUsize> {
    let hits = Arc::new(AtomicUsize::new(0));
    let counter = hits.clone();
    Mock::given(method("GET"))
        .and(path("/file"))
        .respond_with(move |_req: &Request| {
            counter.fetch_add(1, Ordering::SeqCst);
            template.clone()
        })
        .mount(server)
        .await;
    hits
}

/// 坏源被判定不通后，后续文件不再为它重复赔上整轮重试。
///
/// 没有熔断时坏源要被打满「文件数 × max_attempts」次；有熔断后，头几个文件付完学费坏源就沉底了。
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn tripped_source_stops_costing_retries_for_later_files() {
    const FILES: usize = 10;
    const THRESHOLD: u32 = 3;

    let bad_server = MockServer::start().await;
    let good_server = MockServer::start().await;
    let body = "served-by-healthy-source";
    let sha1 = sha1_of(body.as_bytes()).await;

    // 503 属主机侧故障，计入熔断。
    let bad_hits = mount_counting(&bad_server, ResponseTemplate::new(503)).await;
    let good_hits = mount_counting(
        &good_server,
        ResponseTemplate::new(200).set_body_string(body),
    )
    .await;

    let health = Arc::new(SourceHealth::with_policy(
        THRESHOLD,
        Duration::from_secs(60),
    ));
    let downloader = Downloader::with_health(
        client(),
        split_config(&bad_server, &good_server),
        health.clone(),
    );

    let dir = tempfile::tempdir().unwrap();
    for i in 0..FILES {
        let dest = dir.path().join(format!("file{i}.bin"));
        let task = DownloadTask::new("https://official.example/whatever", &dest).with_sha1(&sha1);
        downloader
            .download(&task)
            .await
            .expect("换源后每个文件都应装上");
        assert_eq!(tokio::fs::read(&dest).await.unwrap(), body.as_bytes());
    }

    let attempts = fast_policy().max_attempts as usize;
    assert_eq!(
        good_hits.load(Ordering::SeqCst),
        FILES,
        "每个文件都应由健康源交付"
    );
    assert!(
        health.is_tripped(&format!("{}/file", bad_server.uri())),
        "坏源应已被判定不通"
    );
    // 学费恰好是「达到阈值所需的文件数 × 每文件重试次数」：之后坏源排在最后，好源先成功。
    assert_eq!(
        bad_hits.load(Ordering::SeqCst),
        THRESHOLD as usize * attempts,
        "没有熔断时会是 {} 次",
        FILES * attempts
    );
}

/// 404 不是主机故障：一个源缺几个文件，不该让它整体被判死。
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn missing_files_do_not_trip_an_otherwise_healthy_source() {
    let primary = MockServer::start().await;
    let mirror = MockServer::start().await;
    let body = "from-mirror";
    let sha1 = sha1_of(body.as_bytes()).await;

    let primary_hits = mount_counting(&primary, ResponseTemplate::new(404)).await;
    let _ = mount_counting(&mirror, ResponseTemplate::new(200).set_body_string(body)).await;

    let health = Arc::new(SourceHealth::with_policy(2, Duration::from_secs(60)));
    let downloader =
        Downloader::with_health(client(), split_config(&primary, &mirror), health.clone());

    let dir = tempfile::tempdir().unwrap();
    for i in 0..4 {
        let dest = dir.path().join(format!("missing{i}.bin"));
        let task = DownloadTask::new("https://official.example/whatever", &dest).with_sha1(&sha1);
        downloader.download(&task).await.expect("应由备源交付");
    }

    assert!(
        !health.is_tripped(&format!("{}/file", primary.uri())),
        "连续 404 只说明该源没有这些文件，不该把它判成不可用"
    );
    // 404 不可重试，每个文件只在首选源上试一次；它一直排在首位。
    assert_eq!(primary_hits.load(Ordering::SeqCst), 4);
}

/// 成功一次即清账：偶发抖动不该累积成熔断。
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn intermittent_failures_do_not_accumulate_into_a_trip() {
    let server = MockServer::start().await;
    let body = "flaky-but-alive";
    let sha1 = sha1_of(body.as_bytes()).await;

    // 每个文件第一次 500、随后 200：单文件内靠重试就能成功，主机不该被判死。
    let hits = Arc::new(AtomicUsize::new(0));
    let counter = hits.clone();
    Mock::given(method("GET"))
        .and(path("/file"))
        .respond_with(move |_req: &Request| {
            if counter.fetch_add(1, Ordering::SeqCst).is_multiple_of(2) {
                ResponseTemplate::new(500)
            } else {
                ResponseTemplate::new(200).set_body_string(body)
            }
        })
        .mount(&server)
        .await;

    let config = DownloadConfig {
        chunk: ChunkConfig::default(),
        retry: fast_policy(),
        sources: SourcePlan::with_resolver(
            vec![MirrorSource::Official],
            Arc::new(SplitHostResolver {
                primary: server.uri(),
                mirror: server.uri(),
            }),
        ),
        watchdog: WatchdogConfig::default(),
    };
    let health = Arc::new(SourceHealth::with_policy(2, Duration::from_secs(60)));
    let downloader = Downloader::with_health(client(), config, health.clone());

    let dir = tempfile::tempdir().unwrap();
    for i in 0..5 {
        let dest = dir.path().join(format!("flaky{i}.bin"));
        let task = DownloadTask::new("https://official.example/whatever", &dest).with_sha1(&sha1);
        downloader.download(&task).await.expect("重试内应成功");
    }

    assert_eq!(hits.load(Ordering::SeqCst), 10, "每个文件恰好一败一成");
    assert!(
        !health.is_tripped(&format!("{}/file", server.uri())),
        "每个文件都最终成功，累计的抖动应被成功清账"
    );
}
