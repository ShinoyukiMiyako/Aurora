//! 针对下载引擎关键路径的本地 mock 服务器集成测试。
//!
//! 覆盖：Range 分块下载并合并、跳转 CDN 上分片改打终点、分片失败回退整文件、换源前清分片、
//! 指数退避重试、sha1 校验失败重下、耗尽后换源、Range 不支持时回退单流、分片粒度断点续传、
//! 批量池进度上报。全部走 wiremock 本地端口，无外网依赖。

use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;

use aurora_base::retry::RetryPolicy;
use aurora_download::{
    ChunkConfig, ChunkPlan, DownloadConfig, DownloadPool, DownloadProgress, DownloadTask,
    Downloader, Error, MirrorSource, SourcePlan, SourceResolver, WatchdogConfig,
};
use tokio::sync::watch;
use wiremock::matchers::{header, header_exists, method, path};
use wiremock::{Mock, MockServer, Request, ResponseTemplate};

/// 「不带 Range 头」匹配器。探测/整文件请求与分片请求走两套 mock，靠它彻底分流，
/// 断言便不依赖 wiremock 的匹配顺序。
fn without_range(request: &Request) -> bool {
    !request.headers.contains_key("range")
}

/// 为分片前的解跳转探测提供不带 Range 的整文件应答（真实服务器必然应答探测）。
async fn mount_whole_file(server: &MockServer, route: &str, payload: &[u8]) {
    Mock::given(method("GET"))
        .and(path(route))
        .and(without_range)
        .respond_with(
            ResponseTemplate::new(200)
                .set_body_string(String::from_utf8(payload.to_vec()).unwrap()),
        )
        .mount(server)
        .await;
}

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
        watchdog: WatchdogConfig::default(),
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
    mount_whole_file(&server, "/file", &payload).await;

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

/// 给每个分片注册 206 应答，返回所有分片请求的总命中计数。
async fn mount_ranges(
    server: &MockServer,
    route: &str,
    payload: &[u8],
    plan: &ChunkPlan,
) -> Arc<AtomicUsize> {
    let hits = Arc::new(AtomicUsize::new(0));
    let total = payload.len();
    for chunk in &plan.chunks {
        let body =
            String::from_utf8(payload[chunk.start as usize..=chunk.end as usize].to_vec()).unwrap();
        let content_range = format!("bytes {}-{}/{}", chunk.start, chunk.end, total);
        let counter = hits.clone();
        Mock::given(method("GET"))
            .and(path(route))
            .and(header(
                "range",
                format!("bytes={}-{}", chunk.start, chunk.end).as_str(),
            ))
            .respond_with(move |_req: &Request| {
                counter.fetch_add(1, Ordering::SeqCst);
                ResponseTemplate::new(206)
                    .insert_header("content-range", content_range.as_str())
                    .set_body_string(body.clone())
            })
            .mount(server)
            .await;
    }
    hits
}

fn assert_no_leftovers(dest: &std::path::Path, plan: &ChunkPlan) {
    let tmp = format!("{}.petalfall-tmp", dest.display());
    assert!(!std::path::Path::new(&tmp).exists(), "合并临时文件未清理");
    for chunk in &plan.chunks {
        let part = format!("{}.petalfall-part{}", dest.display(), chunk.index);
        assert!(
            !std::path::Path::new(&part).exists(),
            "分片 {} 应被清理",
            chunk.index
        );
    }
}

/// 跳转 CDN：探测解出终点后，所有分片必须打在终点地址上，一个都不许再打前端地址。
///
/// 复刻 CurseForge 实测行为：前端这一层对带 Range 的请求恒 404，只有跳转终点认 Range。
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn chunk_requests_target_probed_redirect_destination() {
    let server = MockServer::start().await;
    let total = 1000u64;
    let payload = ascii_payload(total as usize);
    let sha1 = sha1_of(&payload).await;

    let edge_probe_hits = Arc::new(AtomicUsize::new(0));
    let probe_counter = edge_probe_hits.clone();
    let location = format!("{}/media/file", server.uri());
    Mock::given(method("GET"))
        .and(path("/edge/file"))
        .and(without_range)
        .respond_with(move |_req: &Request| {
            probe_counter.fetch_add(1, Ordering::SeqCst);
            ResponseTemplate::new(302).insert_header("location", location.as_str())
        })
        .mount(&server)
        .await;
    let edge_range_hits = Arc::new(AtomicUsize::new(0));
    let edge_range_counter = edge_range_hits.clone();
    Mock::given(method("GET"))
        .and(path("/edge/file"))
        .and(header_exists("range"))
        .respond_with(move |_req: &Request| {
            edge_range_counter.fetch_add(1, Ordering::SeqCst);
            ResponseTemplate::new(404)
        })
        .mount(&server)
        .await;
    mount_whole_file(&server, "/media/file", &payload).await;
    let plan = ChunkPlan::compute(total, 300, 8);
    assert_eq!(plan.chunks.len(), 4, "预期切成 4 块");
    let media_range_hits = mount_ranges(&server, "/media/file", &payload, &plan).await;

    let dir = tempfile::tempdir().unwrap();
    let dest = dir.path().join("redirected.bin");
    let downloader = Downloader::new(client(), single_source_config(small_chunk_config()));
    let task = DownloadTask::new(format!("{}/edge/file", server.uri()), &dest)
        .with_size(total)
        .with_sha1(&sha1);

    downloader
        .download(&task)
        .await
        .expect("解跳转后分片下载应成功");

    assert_eq!(tokio::fs::read(&dest).await.unwrap(), payload);
    assert_eq!(
        edge_range_hits.load(Ordering::SeqCst),
        0,
        "分片请求不得再打会跳转的原地址"
    );
    assert_eq!(
        media_range_hits.load(Ordering::SeqCst),
        4,
        "四个分片应全部打在探测解出的终点地址上"
    );
    assert_eq!(
        edge_probe_hits.load(Ordering::SeqCst),
        1,
        "探测只发一次，不该每个分片各探一遍"
    );
    assert_no_leftovers(&dest, &plan);
}

/// 分片路径失败后回退整文件单请求，回退成功即整体成功；遗留分片被清理。
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn chunk_failure_falls_back_to_whole_file() {
    let server = MockServer::start().await;
    let total = 1000u64;
    let payload = ascii_payload(total as usize);
    let sha1 = sha1_of(&payload).await;

    let whole_hits = Arc::new(AtomicUsize::new(0));
    let whole_counter = whole_hits.clone();
    let whole_body = String::from_utf8(payload.clone()).unwrap();
    Mock::given(method("GET"))
        .and(path("/file"))
        .and(without_range)
        .respond_with(move |_req: &Request| {
            whole_counter.fetch_add(1, Ordering::SeqCst);
            ResponseTemplate::new(200).set_body_string(whole_body.clone())
        })
        .mount(&server)
        .await;

    // 首块正常 206（让 part0 真的落盘），其余分片 404 打断分片路径。
    let plan = ChunkPlan::compute(total, 300, 8);
    let first = plan.chunks[0];
    let first_body =
        String::from_utf8(payload[first.start as usize..=first.end as usize].to_vec()).unwrap();
    let first_content_range = format!("bytes {}-{}/{}", first.start, first.end, total);
    let range_hits = Arc::new(AtomicUsize::new(0));
    let first_counter = range_hits.clone();
    Mock::given(method("GET"))
        .and(path("/file"))
        .and(header(
            "range",
            format!("bytes={}-{}", first.start, first.end).as_str(),
        ))
        .respond_with(move |_req: &Request| {
            first_counter.fetch_add(1, Ordering::SeqCst);
            ResponseTemplate::new(206)
                .insert_header("content-range", first_content_range.as_str())
                .set_body_string(first_body.clone())
        })
        .mount(&server)
        .await;
    let rest_counter = range_hits.clone();
    Mock::given(method("GET"))
        .and(path("/file"))
        .and(header_exists("range"))
        .respond_with(move |_req: &Request| {
            rest_counter.fetch_add(1, Ordering::SeqCst);
            ResponseTemplate::new(404)
        })
        .mount(&server)
        .await;

    let dir = tempfile::tempdir().unwrap();
    let dest = dir.path().join("fallback.bin");
    let downloader = Downloader::new(client(), single_source_config(small_chunk_config()));
    let task = DownloadTask::new(format!("{}/file", server.uri()), &dest)
        .with_size(total)
        .with_sha1(&sha1);

    downloader.download(&task).await.expect("回退后应判定成功");

    assert_eq!(tokio::fs::read(&dest).await.unwrap(), payload);
    assert_eq!(
        whole_hits.load(Ordering::SeqCst),
        2,
        "应为一次探测加一次整文件回退"
    );
    assert_eq!(
        range_hits.load(Ordering::SeqCst),
        4,
        "首块 206 加三块 404，404 不可重试，分片路径不该被重试"
    );
    assert_no_leftovers(&dest, &plan);
}

/// 回退也失败时，错误必须同时带上分片阶段与回退阶段的定位信息。
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn fallback_failure_reports_both_stages() {
    let server = MockServer::start().await;
    let whole_hits = Arc::new(AtomicUsize::new(0));
    let whole_counter = whole_hits.clone();
    // 不带 Range：首次（探测）放行 200，之后（回退）一律 503。
    Mock::given(method("GET"))
        .and(path("/file"))
        .and(without_range)
        .respond_with(move |_req: &Request| {
            if whole_counter.fetch_add(1, Ordering::SeqCst) == 0 {
                ResponseTemplate::new(200).set_body_string("probe-only")
            } else {
                ResponseTemplate::new(503)
            }
        })
        .mount(&server)
        .await;
    let range_hits = Arc::new(AtomicUsize::new(0));
    let range_counter = range_hits.clone();
    Mock::given(method("GET"))
        .and(path("/file"))
        .and(header_exists("range"))
        .respond_with(move |_req: &Request| {
            range_counter.fetch_add(1, Ordering::SeqCst);
            ResponseTemplate::new(404)
        })
        .mount(&server)
        .await;

    let dir = tempfile::tempdir().unwrap();
    let dest = dir.path().join("doomed.bin");
    let url = format!("{}/file", server.uri());
    let downloader = Downloader::new(client(), single_source_config(small_chunk_config()));
    let task = DownloadTask::new(&url, &dest).with_size(1000);

    let err = downloader
        .download(&task)
        .await
        .expect_err("分片与回退双双失败时不得判定为成功");

    assert_eq!(err.http_status(), Some(503), "外层归口到最后一次真实请求");
    let Error::AllSourcesExhausted { url: failed, last } = err else {
        panic!("应归口为多源耗尽");
    };
    assert_eq!(failed, url);
    let Error::ChunkedFallbackFailed {
        url: stage_url,
        chunked,
        fallback,
    } = *last
    else {
        panic!("最后一个源的错误应是分片回退双失败");
    };
    assert_eq!(stage_url, url);
    assert_eq!(chunked.http_status(), Some(404), "分片阶段应记下 404");
    assert_eq!(fallback.http_status(), Some(503), "回退阶段应记下 503");
    assert_eq!(
        range_hits.load(Ordering::SeqCst),
        1,
        "首块 404 即终止分片路径"
    );
    assert_eq!(
        whole_hits.load(Ordering::SeqCst),
        4,
        "一次探测加三次回退重试（503 可重试，max_attempts=3）"
    );
    assert!(!dest.exists(), "全程失败不得留下目标文件");
}

/// 两个源分别指向同一 mock 的 `/a/file` 与 `/b/file`。
struct TwoPathResolver {
    base: String,
}

impl SourceResolver for TwoPathResolver {
    fn resolve(&self, _url: &str, source: MirrorSource) -> aurora_download::Result<String> {
        Ok(match source {
            MirrorSource::Official => format!("{}/a/file", self.base),
            MirrorSource::BmclApi => format!("{}/b/file", self.base),
        })
    }
}

/// 换源前必须清掉本源残留的分片——任务没有 sha1 时，这是唯一能拦住跨源拼接的地方。
///
/// 分片只按字节数判定「已完成」：源 A 写下一个长度对、内容错的分片后，若直接换到源 B 续传，
/// B 会把它当成已完成跳过，拼出一个大小合法、内容损坏的文件。
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn switching_source_drops_parts_when_task_has_no_sha1() {
    let server = MockServer::start().await;
    let total = 1000u64;
    let payload = ascii_payload(total as usize);
    let plan = ChunkPlan::compute(total, 300, 8);

    // 源 A：探测放行一次 200，之后的整文件回退一律 503，逼它耗尽后换源。
    let a_whole_hits = Arc::new(AtomicUsize::new(0));
    let a_whole_counter = a_whole_hits.clone();
    Mock::given(method("GET"))
        .and(path("/a/file"))
        .and(without_range)
        .respond_with(move |_req: &Request| {
            if a_whole_counter.fetch_add(1, Ordering::SeqCst) == 0 {
                ResponseTemplate::new(200).set_body_string("probe-only")
            } else {
                ResponseTemplate::new(503)
            }
        })
        .mount(&server)
        .await;
    // 源 A 的第 0 块正确、第 1 块长度对但内容全错——这正是「换源不清分片」会被原样拼进去的那段。
    for chunk in plan.chunks.iter().take(2) {
        let body = if chunk.index == 0 {
            String::from_utf8(payload[chunk.start as usize..=chunk.end as usize].to_vec()).unwrap()
        } else {
            "X".repeat(chunk.byte_len() as usize)
        };
        let content_range = format!("bytes {}-{}/{}", chunk.start, chunk.end, total);
        Mock::given(method("GET"))
            .and(path("/a/file"))
            .and(header(
                "range",
                format!("bytes={}-{}", chunk.start, chunk.end).as_str(),
            ))
            .respond_with(
                ResponseTemplate::new(206)
                    .insert_header("content-range", content_range.as_str())
                    .set_body_string(body),
            )
            .mount(&server)
            .await;
    }
    Mock::given(method("GET"))
        .and(path("/a/file"))
        .and(header_exists("range"))
        .respond_with(ResponseTemplate::new(404))
        .mount(&server)
        .await;

    // 源 B：探测与四个分片全部正常。
    mount_whole_file(&server, "/b/file", &payload).await;
    let b_range_hits = mount_ranges(&server, "/b/file", &payload, &plan).await;

    let dir = tempfile::tempdir().unwrap();
    let dest = dir.path().join("no-sha1.bin");
    let config = DownloadConfig {
        chunk: small_chunk_config(),
        retry: fast_policy(),
        sources: SourcePlan::with_resolver(
            vec![MirrorSource::Official, MirrorSource::BmclApi],
            Arc::new(TwoPathResolver { base: server.uri() }),
        ),
        watchdog: WatchdogConfig::default(),
    };
    let downloader = Downloader::new(client(), config);
    // 刻意不给 sha1：这类任务只校验总大小，跨源拼接的坏字节没有第二道关。
    let task = DownloadTask::new("https://official.example/no-sha1", &dest).with_size(total);

    downloader.download(&task).await.expect("换源后应下载成功");

    assert_eq!(
        tokio::fs::read(&dest).await.unwrap(),
        payload,
        "必须是源 B 的完整内容，不许混进源 A 写坏的那一段"
    );
    assert_eq!(
        b_range_hits.load(Ordering::SeqCst),
        4,
        "源 A 的残留分片必须在换源前清掉，源 B 四块都要重下"
    );
    assert_eq!(
        a_whole_hits.load(Ordering::SeqCst),
        4,
        "源 A 为一次探测加三次整文件回退重试"
    );
    assert_no_leftovers(&dest, &plan);
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
    assert_eq!(
        hits.load(Ordering::SeqCst),
        2,
        "首次损坏、第二次正确，共两次"
    );
    // 校验失败路径应已清掉临时文件。
    let tmp = format!("{}.petalfall-tmp", dest.display());
    assert!(
        !std::path::Path::new(&tmp).exists(),
        "损坏重下后临时文件未清理"
    );
}

/// 两次安装同时要同一个共享文件：后到的一方等前一方落位，再按 sha1 认出它已就绪直接跳过，
/// 服务器只被请求一次，两边都成功，落盘内容完整。
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn concurrent_downloads_of_one_destination_fetch_it_once() {
    let server = MockServer::start().await;
    let body = "shared-library-bytes";
    let sha1 = sha1_of(body.as_bytes()).await;
    Mock::given(method("GET"))
        .and(path("/shared.jar"))
        .respond_with(
            ResponseTemplate::new(200)
                .set_body_string(body)
                .set_delay(Duration::from_millis(300)),
        )
        .mount(&server)
        .await;

    let dir = tempfile::tempdir().unwrap();
    let dest = dir.path().join("libraries").join("shared.jar");
    let downloader = Downloader::new(client(), single_source_config(ChunkConfig::default()));
    let task = DownloadTask::new(format!("{}/shared.jar", server.uri()), &dest)
        .with_sha1(&sha1)
        .with_size(body.len() as u64);

    let (first, second) = tokio::join!(downloader.download(&task), downloader.download(&task));
    first.unwrap();
    second.unwrap();

    assert_eq!(tokio::fs::read(&dest).await.unwrap(), body.as_bytes());
    let requests = server.received_requests().await.unwrap();
    assert_eq!(requests.len(), 1, "同一目标只该下载一次");
    let tmp = format!("{}.petalfall-tmp", dest.display());
    assert!(!std::path::Path::new(&tmp).exists());
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

    let resolver = Arc::new(TwoWayResolver { base: server.uri() });
    let config = DownloadConfig {
        chunk: ChunkConfig::default(),
        retry: fast_policy(),
        sources: SourcePlan::with_resolver(
            vec![MirrorSource::Official, MirrorSource::BmclApi],
            resolver,
        ),
        watchdog: WatchdogConfig::default(),
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
    mount_whole_file(&server, "/file", &payload).await;

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
        tasks.push(DownloadTask::new(format!("{}{}", server.uri(), route), dest).with_sha1(&sha1));
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
    let content: u64 = bodies.iter().map(|b| b.len() as u64).sum();
    assert_eq!(
        final_progress.bytes, content,
        "无失败时有效字节等于内容总量"
    );

    for (i, body) in bodies.iter().enumerate() {
        let dest = dir.path().join(format!("f{i}.txt"));
        assert_eq!(tokio::fs::read(&dest).await.unwrap(), body.as_bytes());
    }
}

/// 内容损坏触发重下时，进度字节不能把同一个文件计两遍。
///
/// 这是「100% · 1.06 GB / 1.04 GB」的根因复现：字节完整传下来了，只是 sha1 不对，整个文件重下。
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn corrupted_retry_does_not_double_count_progress_bytes() {
    let server = MockServer::start().await;
    let good = "the-authentic-payload";
    let bad = "the-corrupted-payload"; // 与 good 等长，只有 sha1 拦得住它
    assert_eq!(good.len(), bad.len());
    let sha1 = sha1_of(good.as_bytes()).await;
    let size = good.len() as u64;

    let hits = Arc::new(AtomicUsize::new(0));
    let counter = hits.clone();
    let (release_retry, retry_held) = std::sync::mpsc::channel::<()>();
    let retry_held = std::sync::Mutex::new(retry_held);
    Mock::given(method("GET"))
        .and(path("/file"))
        .respond_with(move |_req: &Request| {
            if counter.fetch_add(1, Ordering::SeqCst) == 0 {
                ResponseTemplate::new(200).set_body_string(bad)
            } else {
                // 重下那一遍扣到用例看完进度才答，两次尝试之间的窗口不靠响应延迟。
                // 用例失败退出时放行端跟着丢弃，recv 出错，mock 的服务线程照样放开。
                let _ = retry_held.lock().unwrap().recv();
                ResponseTemplate::new(200).set_body_string(good)
            }
        })
        .mount(&server)
        .await;

    let dir = tempfile::tempdir().unwrap();
    let dest = dir.path().join("payload.bin");
    let task = DownloadTask::new(format!("{}/file", server.uri()), &dest)
        .with_sha1(&sha1)
        .with_size(size);
    let downloader = Downloader::new(client(), single_source_config(ChunkConfig::default()));
    let pool = DownloadPool::new(downloader, 1).with_sample_interval(Duration::from_millis(10));
    let (tx, mut rx) = watch::channel(DownloadProgress::default());
    let download = tokio::spawn(async move { pool.download_all(vec![task], Some(tx)).await });

    let deadline = std::time::Instant::now() + Duration::from_secs(15);
    while hits.load(Ordering::SeqCst) < 2 {
        assert!(std::time::Instant::now() < deadline, "等不到重下请求");
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    // 重下的回音还扣着，进度里只可能有坏的那一遍；它退不回 0 就是带着它在等重下。
    tokio::time::timeout(Duration::from_secs(15), rx.wait_for(|p| p.bytes == 0))
        .await
        .expect("坏的那一遍作废后，进度应立即退回，而不是带着它等重下")
        .expect("下载还没结束，进度通道不会关");
    release_retry.send(()).expect("mock 还在等放行");

    let report = download
        .await
        .expect("下载任务不应 panic")
        .expect("不应 panic");

    assert!(report.is_success(), "重下后应成功: {:?}", report.failures);
    assert_eq!(tokio::fs::read(&dest).await.unwrap(), good.as_bytes());
    assert_eq!(
        hits.load(Ordering::SeqCst),
        2,
        "首次拿到坏内容并触发一次重下"
    );
    let snap = *rx.borrow();
    assert_eq!(snap.bytes, size, "坏的那一遍要被退回，进度字节恰为文件大小");
    assert_eq!(snap.total_bytes, Some(size));
    assert_eq!(snap.transferred, 2 * size, "两遍都走了网线，传输量不退回");
}

/// 本就完整的文件计入进度：补全类批次里大部分文件都已在盘上，不计入的话进度会停在 0。
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn already_complete_files_count_towards_progress_bytes() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/missing"))
        .respond_with(ResponseTemplate::new(200).set_body_string("fresh"))
        .mount(&server)
        .await;

    let dir = tempfile::tempdir().unwrap();
    let present = dir.path().join("present.bin");
    tokio::fs::write(&present, b"already-here").await.unwrap();
    let tasks = vec![
        DownloadTask::new(format!("{}/present", server.uri()), &present)
            .with_sha1(sha1_of(b"already-here").await)
            .with_size(12),
        DownloadTask::new(
            format!("{}/missing", server.uri()),
            dir.path().join("missing.bin"),
        )
        .with_size(5),
    ];

    let downloader = Downloader::new(client(), single_source_config(ChunkConfig::default()));
    let (tx, rx) = watch::channel(DownloadProgress::default());
    let report = DownloadPool::new(downloader, 2)
        .download_all(tasks, Some(tx))
        .await
        .unwrap();

    assert!(report.is_success());
    let requested: Vec<String> = server
        .received_requests()
        .await
        .unwrap()
        .iter()
        .map(|r| r.url.path().to_owned())
        .collect();
    assert_eq!(requested, vec!["/missing"], "完整的文件不该再发请求");
    let snap = *rx.borrow();
    assert_eq!(snap.bytes, 17, "跳过的 12 字节加新下的 5 字节");
    assert_eq!(snap.total_bytes, Some(17));
    assert_eq!(snap.transferred, 5, "跳过的文件不算传输量");
}

/// 整批文件都已就绪：进度走满，传输量为 0。任务页据此写「文件已就绪」，而不是报一个没下过的大小。
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn batch_of_present_files_transfers_nothing() {
    let server = MockServer::start().await;
    let dir = tempfile::tempdir().unwrap();
    let present = dir.path().join("present.bin");
    tokio::fs::write(&present, b"already-here").await.unwrap();
    let task = DownloadTask::new(format!("{}/present", server.uri()), &present)
        .with_sha1(sha1_of(b"already-here").await)
        .with_size(12);

    let downloader = Downloader::new(client(), single_source_config(ChunkConfig::default()));
    let (tx, rx) = watch::channel(DownloadProgress::default());
    let report = DownloadPool::new(downloader, 2)
        .download_all(vec![task], Some(tx))
        .await
        .unwrap();

    assert!(report.is_success());
    let snap = *rx.borrow();
    assert_eq!((snap.bytes, snap.total_bytes), (12, Some(12)));
    assert_eq!(snap.transferred, 0);
}

/// 并发为 1 时请求顺序即派发顺序：大文件先开工，大小未知的最后。
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn pool_dispatches_largest_files_first() {
    let server = MockServer::start().await;
    let files = [
        ("/small", 3usize),
        ("/unknown", 4),
        ("/large", 9),
        ("/mid", 6),
    ];
    for (route, len) in files {
        Mock::given(method("GET"))
            .and(path(route))
            .respond_with(ResponseTemplate::new(200).set_body_string("x".repeat(len)))
            .mount(&server)
            .await;
    }
    let dir = tempfile::tempdir().unwrap();
    let tasks: Vec<DownloadTask> = files
        .iter()
        .map(|(route, len)| {
            let task = DownloadTask::new(
                format!("{}{route}", server.uri()),
                dir.path().join(route.trim_start_matches('/')),
            );
            if *route == "/unknown" {
                task
            } else {
                task.with_size(*len as u64)
            }
        })
        .collect();

    let downloader = Downloader::new(client(), single_source_config(ChunkConfig::default()));
    let report = DownloadPool::new(downloader, 1)
        .download_all(tasks, None)
        .await
        .unwrap();

    assert!(report.is_success());
    let order: Vec<String> = server
        .received_requests()
        .await
        .unwrap()
        .iter()
        .map(|r| r.url.path().to_owned())
        .collect();
    assert_eq!(order, vec!["/large", "/mid", "/small", "/unknown"]);
}

/// 响应头已到、响应体只来了一截连接就断开：同一个源上重试一次即可拿到完整文件。
/// wiremock 造不出「声明了长度却只写一半」，这里用手写的 TCP 端点：第一次连接声明 `payload.len()`
/// 字节、只写前 64 字节就关掉；第二次连接给完整内容。reqwest 把读响应体途中的失败一律归为
/// decode 类，引擎不能把它当成永久失败。
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn body_cut_off_midway_is_retried_on_the_same_source() {
    use std::io::{Read, Write};

    let payload = ascii_payload(4096);
    let sha1 = sha1_of(&payload).await;
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let url = format!("http://{}/cut.bin", listener.local_addr().unwrap());
    let accepted = Arc::new(AtomicUsize::new(0));
    let counter = accepted.clone();
    let served = payload.clone();
    std::thread::spawn(move || {
        for attempt in 0..2 {
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
                served.len()
            );
            stream.write_all(status.as_bytes()).unwrap();
            let body = if attempt == 0 {
                &served[..64]
            } else {
                &served[..]
            };
            stream.write_all(body).unwrap();
            stream.flush().unwrap();
        }
    });

    let dir = tempfile::tempdir().unwrap();
    let dest = dir.path().join("cut.bin");
    // size 未知 -> 单流路径，不探测 Range，连接数只来自重试。
    let downloader = Downloader::new(client(), single_source_config(ChunkConfig::default()));
    let task = DownloadTask::new(url, &dest).with_sha1(&sha1);

    downloader
        .download(&task)
        .await
        .expect("响应体中途断开后应在同一源上重试成功");

    assert_eq!(tokio::fs::read(&dest).await.unwrap(), payload);
    assert_eq!(
        accepted.load(Ordering::SeqCst),
        2,
        "应恰好断开一次、重试一次"
    );
}
