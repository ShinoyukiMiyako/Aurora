//! 取消令牌的集成测试：用会「发一半就卡住」的本地服务器模拟慢速下载源。
//!
//! wiremock 只能整段延迟响应，造不出「临时文件已经写了一半」的现场，所以这里用标准库
//! TcpListener 手写一个最小 HTTP 服务器：先回响应头与一部分响应体，然后保持连接不再发送。

use std::io::{Read, Write};
use std::net::{SocketAddr, TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use aurora_base::retry::RetryPolicy;
use aurora_download::{
    CancellationToken, ChunkConfig, DownloadConfig, DownloadPool, DownloadProgress, DownloadTask,
    Downloader, MirrorSource, SourcePlan,
};
use tokio::sync::watch;
use wiremock::matchers::{method, path};
use wiremock::{Mock, MockServer, ResponseTemplate};

/// 取消后命令必须在这个时限内返回（与产品要求一致）。
const CANCEL_DEADLINE: Duration = Duration::from_millis(1000);

/// 服务器在响应体发出前缀后卡住的时长：远长于任何一条测试，保证只有取消能让下载结束。
const STALL: Duration = Duration::from_secs(60);

fn client() -> reqwest::Client {
    aurora_base::http::build_client().expect("构建客户端")
}

fn config(chunk: ChunkConfig) -> DownloadConfig {
    DownloadConfig {
        chunk,
        // 默认退避（500 ms 起）保留：取消若落在退避里也必须及时返回。
        retry: RetryPolicy::default(),
        sources: SourcePlan::new(vec![MirrorSource::Official]),
    }
}

fn no_chunk() -> ChunkConfig {
    ChunkConfig {
        enabled: false,
        ..ChunkConfig::default()
    }
}

/// 读完请求头，返回 Range 起点（无 Range 时为 None）。
fn read_request(stream: &mut TcpStream) -> Option<u64> {
    let mut head = Vec::new();
    let mut byte = [0u8; 1];
    while !head.ends_with(b"\r\n\r\n") {
        match stream.read(&mut byte) {
            Ok(1) => head.push(byte[0]),
            _ => return None,
        }
    }
    let text = String::from_utf8_lossy(&head).to_ascii_lowercase();
    text.lines()
        .find_map(|line| line.strip_prefix("range: bytes="))
        .and_then(|spec| spec.split('-').next())
        .and_then(|start| start.trim().parse().ok())
}

/// 起一个服务器，每条连接交给 `handle` 在独立线程里处理。
fn serve(handle: fn(TcpStream)) -> SocketAddr {
    let listener = TcpListener::bind("127.0.0.1:0").expect("绑定本地端口");
    let addr = listener.local_addr().expect("本地地址");
    std::thread::spawn(move || {
        for stream in listener.incoming().flatten() {
            std::thread::spawn(move || handle(stream));
        }
    });
    addr
}

/// 引擎写盘前会先攒一段缓冲（百来 KiB）。卡住前发出的前缀与等待的落盘量都远大于它，
/// 「半截数据已经真正写到盘上」的现场才造得出来。
const ON_DISK: u64 = 256 * 1024;

/// 单流卡住前发出的前缀。
const STREAM_PREFIX: usize = 1024 * 1024;

/// 分片长度；首片完整返回，其余分片只发一半。
const CHUNK: u64 = 1024 * 1024;

/// 分块下载的文件总长：正好切成 4 片。
const CHUNKED_TOTAL: u64 = 4 * CHUNK;

/// 声明 4 MiB，只发前缀就卡住。
fn stall_after_prefix(mut stream: TcpStream) {
    read_request(&mut stream);
    // Connection: close 让客户端不复用这条卡住的连接去发下一个请求。
    let head = format!(
        "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        4 * STREAM_PREFIX
    );
    let _ = stream.write_all(head.as_bytes());
    let _ = stream.write_all(&vec![b'x'; STREAM_PREFIX]);
    let _ = stream.flush();
    std::thread::sleep(STALL);
}

/// 支持 Range：起点为 0 的分片完整返回，其余分片只发一半就卡住。
/// 不带 Range 的请求是分片前的解跳转探测，只回响应头即关连接（引擎不读探测的响应体）。
fn ranged_stall(mut stream: TcpStream) {
    let Some(start) = read_request(&mut stream) else {
        let head = format!(
            "HTTP/1.1 200 OK\r\nContent-Length: {CHUNKED_TOTAL}\r\nConnection: close\r\n\r\n"
        );
        let _ = stream.write_all(head.as_bytes());
        let _ = stream.flush();
        return;
    };
    let head = format!(
        "HTTP/1.1 206 Partial Content\r\nContent-Length: {CHUNK}\r\nContent-Range: bytes {start}-{}/{CHUNKED_TOTAL}\r\nConnection: close\r\n\r\n",
        start + CHUNK - 1
    );
    let _ = stream.write_all(head.as_bytes());
    if start == 0 {
        // 首片完整发完即关连接，客户端按正常路径读完它。
        let _ = stream.write_all(&vec![b'y'; CHUNK as usize]);
        let _ = stream.flush();
    } else {
        let _ = stream.write_all(&vec![b'y'; (CHUNK / 2) as usize]);
        let _ = stream.flush();
        std::thread::sleep(STALL);
    }
}

fn temp_of(dest: &Path) -> PathBuf {
    PathBuf::from(format!("{}.petalfall-tmp", dest.display()))
}

fn part_of(dest: &Path, index: usize) -> PathBuf {
    PathBuf::from(format!("{}.petalfall-part{index}", dest.display()))
}

/// 轮询直到 `cond` 成立；5 s 内不成立说明现场没造出来，测试本身有问题。
async fn wait_until(what: &str, cond: impl Fn() -> bool) {
    let deadline = Instant::now() + Duration::from_secs(5);
    while !cond() {
        assert!(Instant::now() < deadline, "等待超时：{what}");
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
}

/// 单流下载写了半截临时文件时取消：1000 ms 内以 Cancelled 返回，临时文件被删，目标不出现。
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn cancel_mid_stream_returns_quickly_and_removes_temp_file() {
    let addr = serve(stall_after_prefix);
    let dir = tempfile::tempdir().unwrap();
    let dest = dir.path().join("client.jar");
    let task = DownloadTask::new(format!("http://{addr}/client.jar"), &dest);

    let token = CancellationToken::new();
    let pool = DownloadPool::new(Downloader::new(client(), config(no_chunk())), 4)
        .with_cancel(token.clone());
    let download = tokio::spawn(async move { pool.download_all(vec![task], None).await });

    let temp = temp_of(&dest);
    wait_until("临时文件写入前缀", || {
        std::fs::metadata(&temp).is_ok_and(|m| m.len() >= ON_DISK)
    })
    .await;

    let cancelled_at = Instant::now();
    token.cancel();
    let result = download.await.expect("下载任务不应 panic");
    let elapsed = cancelled_at.elapsed();

    let err = result.expect_err("取消后不应返回成功");
    assert!(err.is_cancelled(), "应为取消，实际：{err:?}");
    assert!(elapsed < CANCEL_DEADLINE, "取消到返回耗时 {elapsed:?}");
    assert!(!temp.exists(), "半截临时文件应被清理");
    assert!(!dest.exists(), "目标文件不应出现");
}

/// 分块下载时取消：已完成的首片与写了一半的其余分片全部清掉。
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn cancel_mid_chunked_download_removes_every_part() {
    let addr = serve(ranged_stall);
    let dir = tempfile::tempdir().unwrap();
    let dest = dir.path().join("assets.bin");
    let task =
        DownloadTask::new(format!("http://{addr}/assets.bin"), &dest).with_size(CHUNKED_TOTAL);
    let chunk = ChunkConfig {
        enabled: true,
        min_split_size: 100,
        chunk_size: CHUNK,
        max_chunks: 4,
        chunk_concurrency: 3,
        excluded_hosts: Vec::new(),
    };

    let token = CancellationToken::new();
    let pool =
        DownloadPool::new(Downloader::new(client(), config(chunk)), 1).with_cancel(token.clone());
    let download = tokio::spawn(async move { pool.download_all(vec![task], None).await });

    wait_until("首片完整、后续分片各写了一半", || {
        std::fs::metadata(part_of(&dest, 0)).is_ok_and(|m| m.len() == CHUNK)
            && (1..4)
                .all(|i| std::fs::metadata(part_of(&dest, i)).is_ok_and(|m| m.len() >= ON_DISK))
    })
    .await;

    let cancelled_at = Instant::now();
    token.cancel();
    let result = download.await.expect("下载任务不应 panic");
    let elapsed = cancelled_at.elapsed();

    assert!(result.expect_err("取消后不应成功").is_cancelled());
    assert!(elapsed < CANCEL_DEADLINE, "取消到返回耗时 {elapsed:?}");
    for index in 0..4 {
        assert!(!part_of(&dest, index).exists(), "part{index} 应被清理");
    }
    assert!(!temp_of(&dest).exists());
    assert!(!dest.exists());
}

/// 并发 1 时第一个文件卡住：取消后排队中的文件不再派发，目录里不留任何文件。
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn cancel_stops_dispatching_queued_files() {
    let addr = serve(stall_after_prefix);
    let dir = tempfile::tempdir().unwrap();
    let tasks: Vec<DownloadTask> = (0..5)
        .map(|i| {
            DownloadTask::new(
                format!("http://{addr}/f{i}"),
                dir.path().join(format!("f{i}.bin")),
            )
        })
        .collect();

    let token = CancellationToken::new();
    let pool = DownloadPool::new(Downloader::new(client(), config(no_chunk())), 1)
        .with_cancel(token.clone());
    let download = tokio::spawn(async move { pool.download_all(tasks, None).await });

    let first_temp = temp_of(&dir.path().join("f0.bin"));
    wait_until("第一个文件开始写", || first_temp.exists()).await;
    token.cancel();
    let err = download
        .await
        .expect("下载任务不应 panic")
        .expect_err("取消后不应成功");

    assert!(err.is_cancelled());
    let left: Vec<_> = std::fs::read_dir(dir.path())
        .unwrap()
        .flatten()
        .map(|e| e.file_name())
        .collect();
    assert!(left.is_empty(), "不应留下任何文件：{left:?}");
}

/// 批量的总字节数是各任务声明大小之和；有一个大小未知就没有总量。
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn progress_reports_total_bytes_only_when_every_size_is_known() {
    let server = MockServer::start().await;
    for (route, body) in [("/a", "aaaa"), ("/b", "bbbbbbb")] {
        Mock::given(method("GET"))
            .and(path(route))
            .respond_with(ResponseTemplate::new(200).set_body_string(body))
            .mount(&server)
            .await;
    }
    let dir = tempfile::tempdir().unwrap();
    let pool = DownloadPool::new(Downloader::new(client(), config(no_chunk())), 2);

    let sized = vec![
        DownloadTask::new(format!("{}/a", server.uri()), dir.path().join("a")).with_size(4),
        DownloadTask::new(format!("{}/b", server.uri()), dir.path().join("b")).with_size(7),
    ];
    let (tx, rx) = watch::channel(DownloadProgress::default());
    let report = pool.download_all(sized, Some(tx)).await.unwrap();
    assert!(report.is_success());
    let snap = *rx.borrow();
    assert_eq!(snap.total_bytes, Some(11));
    assert_eq!(snap.finished, 2);

    let mixed = vec![
        DownloadTask::new(format!("{}/a", server.uri()), dir.path().join("a2")).with_size(4),
        DownloadTask::new(format!("{}/b", server.uri()), dir.path().join("b2")),
    ];
    let (tx, rx) = watch::channel(DownloadProgress::default());
    pool.download_all(mixed, Some(tx)).await.unwrap();
    assert_eq!(rx.borrow().total_bytes, None);
}

/// 池上挂的观察者在调用方不传 sender 时接收每一批的快照。
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn pool_level_progress_receives_batches_without_explicit_sender() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/one"))
        .respond_with(ResponseTemplate::new(200).set_body_string("12345"))
        .mount(&server)
        .await;
    let dir = tempfile::tempdir().unwrap();
    let (tx, rx) = watch::channel(DownloadProgress::default());
    let pool =
        DownloadPool::new(Downloader::new(client(), config(no_chunk())), 2).with_progress(tx);

    let task =
        DownloadTask::new(format!("{}/one", server.uri()), dir.path().join("one")).with_size(5);
    pool.download_all(vec![task], None).await.unwrap();

    let snap = *rx.borrow();
    assert_eq!(snap.total, 1);
    assert_eq!(snap.finished, 1);
    assert_eq!(snap.bytes, 5);
    assert_eq!(snap.total_bytes, Some(5));
}
