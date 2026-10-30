//! 针对下载引擎关键路径的本地 mock 服务器集成测试。
//!
//! 覆盖：Range 分块下载并合并、指数退避重试、sha1 校验失败重下、耗尽后换源、Range 不支持时
//! 回退单流、分片粒度断点续传、批量池进度上报。全部走 wiremock 本地端口，无外网依赖。

use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;

use aurora_base::retry::RetryPolicy;
use aurora_download::{
    ChunkConfig, ChunkPlan, DownloadConfig, DownloadPool, DownloadProgress, DownloadTask,
    Downloader, MirrorSource, SourcePlan, SourceResolver,
};
use tokio::sync::watch;
use wiremock::matchers::{header, method, path};
use wiremock::{Mock, MockServer, Request, ResponseTemplate};

fn client() -> reqwest::Client {
    aurora_base::http::build_client().expect("构建客户端")
}

/// 确定性 ASCII 负载，便于切片后以 `set_body_string` 原样返回。
fn ascii_payload(size: usize) -> Vec<u8> {
    (0..size).map(|i| b'a' + (i % 26) as u8).collect()
}

async fn sha1_of(bytes: &[u8]) -> String {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("hashme");
    tokio::fs::write(&file, bytes).await.unwrap();
    aurora_base::fs::sha1_hex(&file).await.unwrap()
}

fn fast_policy() -> RetryPolicy {
    // 极小延迟、关 jitter：重试路径跑得快且确定。
    RetryPolicy {
        max_attempts: 3,
        initial_delay: Duration::from_millis(1),
        max_delay: Duration::from_millis(4),
        multiplier: 2.0,
        jitter: false,
    }
}

/// 单源（Official 恒等解析，直指 mock）+ 指定分块参数。
fn single_source_config(chunk: ChunkConfig) -> DownloadConfig {
    DownloadConfig {
        chunk,
        retry: fast_policy(),
        sources: SourcePlan::new(vec![MirrorSource::Official]),
    }
}

fn small_chunk_config() -> ChunkConfig {
    ChunkConfig {
        enabled: true,
        min_split_size: 100,
        chunk_size: 300,
        max_chunks: 8,
        chunk_concurrency: 4,
        excluded_hosts: Vec::new(),
    }
}

/// 关键路径一：大文件 Range 分块下载并按序合并，sha1 校验通过。
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn chunked_download_assembles_and_verifies() {
    let server = MockServer::start().await;
    let total = 1000u64;
    let payload = ascii_payload(total as usize);
    let sha1 = sha1_of(&payload).await;

    // 用与引擎一致的分块方案逐块注册 206 mock，模拟真实 Range 服务器。
    let plan = ChunkPlan::compute(total, 300, 8);
    assert_eq!(plan.chunks.len(), 4, "预期切成 4 块");
    for chunk in &plan.chunks {
        let slice = payload[chunk.start as usize..=chunk.end as usize].to_vec();
        let range_value = format!("bytes={}-{}", chunk.start, chunk.end);
        let content_range = format!("bytes {}-{}/{}", chunk.start, chunk.end, total);
        Mock::given(method("GET"))
            .and(path("/file"))
            .and(header("range", range_value.as_str()))
            .respond_with(
                ResponseTemplate::new(206)
                    .insert_header("content-range", content_range.as_str())
                    .set_body_string(String::from_utf8(slice).unwrap()),
            )
            .mount(&server)
            .await;
    }

    let dir = tempfile::tempdir().unwrap();
    let dest = dir.path().join("out.bin");
    let downloader = Downloader::new(client(), single_source_config(small_chunk_config()));
    let task = DownloadTask::new(format!("{}/file", server.uri()), &dest)
        .with_size(total)
        .with_sha1(&sha1);

    downloader.download(&task).await.expect("分块下载应成功");

    let got = tokio::fs::read(&dest).await.unwrap();
    assert_eq!(got, payload, "合并结果应与原始负载逐字节一致");
    // 分片与临时文件应清理干净。
    let tmp = format!("{}.petalfall-tmp", dest.display());
    assert!(!std::path::Path::new(&tmp).exists(), "合并临时文件未清理");
    for i in 0..plan.chunks.len() {
        let part = format!("{}.petalfall-part{}", dest.display(), i);
        assert!(!std::path::Path::new(&part).exists(), "分片 {i} 未清理");
    }
}

/// 关键路径二：瞬时 5xx 触发指数退避重试，最终成功。
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn transient_5xx_is_retried_until_success() {
    let server = MockServer::start().await;
    let body = "recovered-after-retries";
    let sha1 = sha1_of(body.as_bytes()).await;
    let hits = Arc::new(AtomicUsize::new(0));

    let hits_for_mock = hits.clone();
    Mock::given(method("GET"))
        .and(path("/retry"))
        .respond_with(move |_req: &Request| {
            let n = hits_for_mock.fetch_add(1, Ordering::SeqCst);
            if n < 2 {
                ResponseTemplate::new(500)
            } else {
                ResponseTemplate::new(200).set_body_string(body)
            }
        })
        .mount(&server)
        .await;

    let dir = tempfile::tempdir().unwrap();
    let dest = dir.path().join("retry.txt");
    // size 未知 -> 单流路径，专注验证重试而非分块。
    let downloader = Downloader::new(client(), single_source_config(ChunkConfig::default()));
    let task = DownloadTask::new(format!("{}/retry", server.uri()), &dest).with_sha1(&sha1);

    downloader.download(&task).await.expect("重试后应成功");

    assert_eq!(tokio::fs::read(&dest).await.unwrap(), body.as_bytes());
    assert_eq!(hits.load(Ordering::SeqCst), 3, "应恰好两次失败后第三次成功");
}

/// 关键路径三：首个响应体损坏导致 sha1 不符，触发删档重下。
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn sha1_mismatch_triggers_redownload() {
    let server = MockServer::start().await;
    let good = "the-correct-content";
    let sha1 = sha1_of(good.as_bytes()).await;
    let hits = Arc::new(AtomicUsize::new(0));

    let hits_for_mock = hits.clone();
    Mock::given(method("GET"))
        .and(path("/verify"))
        .respond_with(move |_req: &Request| {
            let n = hits_for_mock.fetch_add(1, Ordering::SeqCst);
            if n == 0 {
                // 第一次返回错误内容（长度不同也无妨，size 未知不做大小校验）。
                ResponseTemplate::new(200).set_body_string("corrupted-body")
            } else {
                ResponseTemplate::new(200).set_body_string(good)
            }
        })
        .mount(&server)
        .await;

    let dir = tempfile::tempdir().unwrap();
    let dest = dir.path().join("verify.txt");
    let downloader = Downloader::new(client(), single_source_config(ChunkConfig::default()));
    let task = DownloadTask::new(format!("{}/verify", server.uri()), &dest).with_sha1(&sha1);

    downloader.download(&task).await.expect("重下后应通过校验");

    assert_eq!(tokio::fs::read(&dest).await.unwrap(), good.as_bytes());
    assert_eq!(hits.load(Ordering::SeqCst), 2, "首次损坏、第二次正确，共两次");
    // 校验失败路径应已清掉临时文件。
    let tmp = format!("{}.petalfall-tmp", dest.display());
    assert!(!std::path::Path::new(&tmp).exists(), "损坏重下后临时文件未清理");
}

/// 换源路径映射器：把 Official / BmclApi 指向同一 mock 的不同路径。
struct TwoWayResolver {
    base: String,
}

impl SourceResolver for TwoWayResolver {
    fn resolve(&self, _url: &str, source: MirrorSource) -> aurora_download::Result<String> {
        Ok(match source {
            MirrorSource::Official => format!("{}/primary", self.base),
            MirrorSource::BmclApi => format!("{}/mirror", self.base),
        })
    }
}

/// 主源在同一源上重试耗尽后，切换到备源并成功。
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn exhausted_primary_switches_to_mirror() {
    let server = MockServer::start().await;
    let body = "served-by-mirror";
    let sha1 = sha1_of(body.as_bytes()).await;

    let primary_hits = Arc::new(AtomicUsize::new(0));
    let mirror_hits = Arc::new(AtomicUsize::new(0));

    let primary_counter = primary_hits.clone();
    Mock::given(method("GET"))
        .and(path("/primary"))
        .respond_with(move |_req: &Request| {
            primary_counter.fetch_add(1, Ordering::SeqCst);
            ResponseTemplate::new(500)
        })
        .mount(&server)
        .await;

    let mirror_counter = mirror_hits.clone();
    Mock::given(method("GET"))
        .and(path("/mirror"))
        .respond_with(move |_req: &Request| {
            mirror_counter.fetch_add(1, Ordering::SeqCst);
            ResponseTemplate::new(200).set_body_string(body)
        })
        .mount(&server)
        .await;

    let resolver = Arc::new(TwoWayResolver {
        base: server.uri(),
    });
    let config = DownloadConfig {
        chunk: ChunkConfig::default(),
        retry: fast_policy(),
        sources: SourcePlan::with_resolver(
            vec![MirrorSource::Official, MirrorSource::BmclApi],
            resolver,
        ),
    };

    let dir = tempfile::tempdir().unwrap();
    let dest = dir.path().join("switch.bin");
    let downloader = Downloader::new(client(), config);
    // URL 内容无关紧要，解析器按源改写；此处仅占位。
    let task = DownloadTask::new("https://official.example/whatever", &dest).with_sha1(&sha1);

    downloader.download(&task).await.expect("换源后应成功");

    assert_eq!(tokio::fs::read(&dest).await.unwrap(), body.as_bytes());
    assert_eq!(
        primary_hits.load(Ordering::SeqCst),
        3,
        "主源应被重试满 max_attempts 次"
    );
    assert_eq!(mirror_hits.load(Ordering::SeqCst), 1, "备源应恰好命中一次");
}

/// 服务器忽略 Range、整体 200 返回时，分块路径自动回退为单流并成功。
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn range_unsupported_falls_back_to_whole_file() {
    let server = MockServer::start().await;
    let total = 1000u64;
    let payload = ascii_payload(total as usize);
    let sha1 = sha1_of(&payload).await;

    // 无 range 匹配器：任何 GET /file（含带 Range 头的首块探测）都拿到整体 200。
    Mock::given(method("GET"))
        .and(path("/file"))
        .respond_with(
            ResponseTemplate::new(200).set_body_string(String::from_utf8(payload.clone()).unwrap()),
        )
        .mount(&server)
        .await;

    let dir = tempfile::tempdir().unwrap();
    let dest = dir.path().join("whole.bin");
    let downloader = Downloader::new(client(), single_source_config(small_chunk_config()));
    let task = DownloadTask::new(format!("{}/file", server.uri()), &dest)
        .with_size(total)
        .with_sha1(&sha1);

    downloader.download(&task).await.expect("应回退单流并成功");

    assert_eq!(tokio::fs::read(&dest).await.unwrap(), payload);
}

/// 断点续传：预置一个中间分片，运行时该分片不再被请求，仍能正确合并。
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn resume_skips_already_completed_chunk() {
    let server = MockServer::start().await;
    let total = 1000u64;
    let payload = ascii_payload(total as usize);
    let sha1 = sha1_of(&payload).await;

    let plan = ChunkPlan::compute(total, 300, 8);
    assert_eq!(plan.chunks.len(), 4);
    let resumed = plan.chunks[1]; // 预置的中间分片，索引 1

    let resumed_hits = Arc::new(AtomicUsize::new(0));
    for chunk in &plan.chunks {
        let slice = payload[chunk.start as usize..=chunk.end as usize].to_vec();
        let range_value = format!("bytes={}-{}", chunk.start, chunk.end);
        let content_range = format!("bytes {}-{}/{}", chunk.start, chunk.end, total);
        let body = String::from_utf8(slice).unwrap();
        if chunk.index == resumed.index {
            // 该分片若被请求则计数（预期为 0）。
            let counter = resumed_hits.clone();
            Mock::given(method("GET"))
                .and(path("/file"))
                .and(header("range", range_value.as_str()))
                .respond_with(move |_req: &Request| {
                    counter.fetch_add(1, Ordering::SeqCst);
                    ResponseTemplate::new(206)
                        .insert_header("content-range", content_range.as_str())
                        .set_body_string(body.clone())
                })
                .mount(&server)
                .await;
        } else {
            Mock::given(method("GET"))
                .and(path("/file"))
                .and(header("range", range_value.as_str()))
                .respond_with(
                    ResponseTemplate::new(206)
                        .insert_header("content-range", content_range.as_str())
                        .set_body_string(body),
                )
                .mount(&server)
                .await;
        }
    }

    let dir = tempfile::tempdir().unwrap();
    let dest = dir.path().join("resume.bin");
    // 预置已完成的中间分片，字节与其区间严格一致。
    let part_path = format!("{}.petalfall-part{}", dest.display(), resumed.index);
    tokio::fs::write(
        &part_path,
        &payload[resumed.start as usize..=resumed.end as usize],
    )
    .await
    .unwrap();

    let downloader = Downloader::new(client(), single_source_config(small_chunk_config()));
    let task = DownloadTask::new(format!("{}/file", server.uri()), &dest)
        .with_size(total)
        .with_sha1(&sha1);

    downloader.download(&task).await.expect("断点续传应成功");

    assert_eq!(tokio::fs::read(&dest).await.unwrap(), payload);
    assert_eq!(
        resumed_hits.load(Ordering::SeqCst),
        0,
        "已完成分片不应被再次请求"
    );
}

/// 批量池：并发下载多文件，进度经 watch channel 收敛到 finished == total。
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn pool_downloads_batch_and_reports_progress() {
    let server = MockServer::start().await;
    let bodies = ["alpha-body", "beta-body", "gamma-body"];
    let mut tasks = Vec::new();
    let dir = tempfile::tempdir().unwrap();

    for (i, body) in bodies.iter().enumerate() {
        let route = format!("/f{i}");
        Mock::given(method("GET"))
            .and(path(route.clone()))
            .respond_with(ResponseTemplate::new(200).set_body_string(*body))
            .mount(&server)
            .await;
        let sha1 = sha1_of(body.as_bytes()).await;
        let dest = dir.path().join(format!("f{i}.txt"));
        tasks.push(
            DownloadTask::new(format!("{}{}", server.uri(), route), dest).with_sha1(&sha1),
        );
    }

    let downloader = Downloader::new(client(), single_source_config(ChunkConfig::default()));
    let pool = DownloadPool::new(downloader, 2).with_sample_interval(Duration::from_millis(20));

    let (tx, rx) = watch::channel(DownloadProgress::default());
    let report = pool
        .download_all(tasks, Some(tx))
        .await
        .expect("批量下载不应 panic");

    assert!(report.is_success(), "所有文件应成功: {:?}", report.failures);
    assert_eq!(report.total, 3);
    assert_eq!(report.succeeded, 3);

    let final_progress = *rx.borrow();
    assert_eq!(final_progress.total, 3);
    assert_eq!(final_progress.finished, 3);
    assert!(final_progress.bytes > 0, "应累计到实际传输字节");

    for (i, body) in bodies.iter().enumerate() {
        let dest = dir.path().join(format!("f{i}.txt"));
        assert_eq!(tokio::fs::read(&dest).await.unwrap(), body.as_bytes());
    }
}
