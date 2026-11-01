//! 吞吐看门狗的集成测试：慢终点被放弃、向原地址换节点续传、换不出就换源、最后一个源关掉看门狗下完。
//!
//! wiremock 只能把整个响应延后，造不出「每秒只吐几 KB」的终点，所以下载终点用测试里手写的
//! tokio TCP 服务器扮演：按 Range 起点或之前收到的请求决定一口气发完还是每 200 ms 写 2 KiB。
//! 分发入口（每次请求 302 到某个节点）用 wiremock 扮演：第一次跳到慢节点，之后跳到快节点。

use std::net::SocketAddr;
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use aurora_base::retry::RetryPolicy;
use aurora_download::watchdog::WATCHDOG_MIN_FILE_SIZE;
use aurora_download::{
    CancellationToken, ChunkConfig, CredentialScope, DownloadConfig, DownloadCredential,
    DownloadPool, DownloadTask, Downloader, MirrorSource, SourceHealth, SourcePlan, SourceResolver,
    WatchdogConfig,
};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use wiremock::matchers::{method, path};
use wiremock::{Mock, MockServer, ResponseTemplate};

const MIB: u64 = 1 << 20;

/// 慢终点每次写这么多。
const DRIP_SLICE: usize = 2 * 1024;
/// 慢终点两次写之间的间隔：合 10 KiB/s，远低于测试阈值 64 KiB/s。
const DRIP_EVERY: Duration = Duration::from_millis(200);
/// 整个响应体都滴灌。
const DRIP_ALL: usize = usize::MAX;

/// 测试用看门狗：窗口 1 秒、每 100 ms 采样、低于 64 KiB/s 判慢，其余取默认（只盯大于 1 MiB 的文件）。
fn test_watchdog() -> WatchdogConfig {
    WatchdogConfig {
        window: Duration::from_secs(1),
        tick: Duration::from_millis(100),
        min_bytes_per_sec: 64 * 1024,
        ..WatchdogConfig::default()
    }
}

/// 1 MiB 一片、一次只下一片：分片的先后顺序确定，「哪一片慢」由服务器按 Range 起点决定。
fn one_at_a_time(chunk_size: u64) -> ChunkConfig {
    ChunkConfig {
        enabled: true,
        min_split_size: 1,
        chunk_size,
        max_chunks: 16,
        chunk_concurrency: 1,
        excluded_hosts: Vec::new(),
    }
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

fn config(chunk: ChunkConfig, sources: SourcePlan) -> DownloadConfig {
    DownloadConfig {
        chunk,
        retry: fast_policy(),
        sources,
        watchdog: test_watchdog(),
    }
}

fn single_source() -> SourcePlan {
    SourcePlan::new(vec![MirrorSource::Official])
}

fn client() -> reqwest::Client {
    aurora_base::http::build_client().expect("构建客户端")
}

/// 确定性但不规则的负载：拼错分片的位置会改变 sha1。
fn payload(size: u64) -> Arc<Vec<u8>> {
    Arc::new(
        (0..size)
            .map(|i| (i.wrapping_mul(2_654_435_761) >> 13) as u8)
            .collect(),
    )
}

async fn sha1_of_file(file: &Path) -> String {
    aurora_base::fs::sha1_hex(file).await.unwrap()
}

async fn sha1_of(bytes: &[u8]) -> String {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("hashme");
    tokio::fs::write(&file, bytes).await.unwrap();
    sha1_of_file(&file).await
}

/// 目录里只剩目标文件：临时文件与分片都已清理。
fn only_dest_left(dir: &Path, dest: &Path) {
    let left: Vec<_> = std::fs::read_dir(dir)
        .unwrap()
        .flatten()
        .map(|entry| entry.path())
        .collect();
    assert_eq!(left, vec![dest.to_path_buf()], "不应留下中间文件");
}

/// 下载终点对一个请求的发送节奏。
#[derive(Debug, Clone, Copy)]
enum Pace {
    /// 只回响应头就关连接：分片前的解跳转探测不读响应体。
    HeadOnly,
    /// 一口气发完。
    Fast,
    /// 末尾这么多字节每 200 ms 写 2 KiB，之前的一口气发完。
    DripTail(usize),
}

/// 按本次请求的 Range 起点（不带 Range 为 `None`）与此前收到的全部请求决定节奏。
type PaceFn = fn(Option<u64>, &[Option<u64>]) -> Pace;

/// 手写的下载终点：支持 `Range: bytes=a-b`，每个连接只答一个请求（`Connection: close`），
/// 按到达顺序记下每个请求的 Range 起点与带来的下载密钥。
struct Endpoint {
    addr: SocketAddr,
    seen: Arc<Mutex<Vec<Option<u64>>>>,
    keys: Arc<Mutex<Vec<Option<String>>>>,
}

impl Endpoint {
    async fn start(body: Arc<Vec<u8>>, pace: PaceFn) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0")
            .await
            .expect("绑定本地端口");
        let addr = listener.local_addr().expect("本地地址");
        let seen = Arc::new(Mutex::new(Vec::new()));
        let keys = Arc::new(Mutex::new(Vec::new()));
        let log = seen.clone();
        let key_log = keys.clone();
        tokio::spawn(async move {
            while let Ok((stream, _)) = listener.accept().await {
                tokio::spawn(answer(
                    stream,
                    body.clone(),
                    log.clone(),
                    key_log.clone(),
                    pace,
                ));
            }
        });
        Self { addr, seen, keys }
    }

    fn url(&self, route: &str) -> String {
        format!("http://{}{route}", self.addr)
    }

    /// 收到的全部请求，按到达顺序；不带 Range 的记为 `None`。
    fn requests(&self) -> Vec<Option<u64>> {
        self.seen.lock().unwrap().clone()
    }

    /// 收到的 Range 请求的起点，按到达顺序。
    fn range_starts(&self) -> Vec<u64> {
        self.requests().into_iter().flatten().collect()
    }

    /// 每个请求带来的 `x-api-key` 值，按到达顺序；没带为 `None`。
    fn api_keys(&self) -> Vec<Option<String>> {
        self.keys.lock().unwrap().clone()
    }
}

/// 读完请求头；返回 Range 区间（不带 Range 为 `None`）与 `x-api-key` 的值，连接提前断开返回 `Err`。
async fn read_range(
    stream: &mut TcpStream,
) -> std::io::Result<(Option<(u64, u64)>, Option<String>)> {
    let mut head = Vec::new();
    let mut buf = [0u8; 1024];
    while !head.windows(4).any(|w| w == b"\r\n\r\n") {
        let read = stream.read(&mut buf).await?;
        if read == 0 {
            return Err(std::io::ErrorKind::UnexpectedEof.into());
        }
        head.extend_from_slice(&buf[..read]);
    }
    let text = String::from_utf8_lossy(&head).to_ascii_lowercase();
    let range = text
        .lines()
        .find_map(|line| line.strip_prefix("range: bytes="))
        .and_then(|spec| {
            let (start, end) = spec.trim().split_once('-')?;
            Some((start.parse().ok()?, end.parse().ok()?))
        });
    let api_key = text
        .lines()
        .find_map(|line| line.strip_prefix("x-api-key:"))
        .map(|value| value.trim().to_owned());
    Ok((range, api_key))
}

async fn answer(
    mut stream: TcpStream,
    body: Arc<Vec<u8>>,
    log: Arc<Mutex<Vec<Option<u64>>>>,
    key_log: Arc<Mutex<Vec<Option<String>>>>,
    pace: PaceFn,
) {
    let Ok((range, api_key)) = read_range(&mut stream).await else {
        return;
    };
    key_log.lock().unwrap().push(api_key);
    let start = range.map(|(start, _)| start);
    let pace = {
        let mut seen = log.lock().unwrap();
        let pace = pace(start, &seen);
        seen.push(start);
        pace
    };
    let total = body.len();
    let (head, slice) = match range {
        Some((start, end)) => (
            format!(
                "HTTP/1.1 206 Partial Content\r\nContent-Length: {}\r\nContent-Range: bytes {start}-{end}/{total}\r\nConnection: close\r\n\r\n",
                end - start + 1
            ),
            &body[start as usize..=end as usize],
        ),
        None => (
            format!("HTTP/1.1 200 OK\r\nContent-Length: {total}\r\nConnection: close\r\n\r\n"),
            &body[..],
        ),
    };
    if stream.write_all(head.as_bytes()).await.is_err() {
        return;
    }
    let tail = match pace {
        Pace::HeadOnly => return,
        Pace::Fast => 0,
        Pace::DripTail(tail) => tail.min(slice.len()),
    };
    let (quick, slow) = slice.split_at(slice.len() - tail);
    if stream.write_all(quick).await.is_err() {
        return;
    }
    for piece in slow.chunks(DRIP_SLICE) {
        tokio::time::sleep(DRIP_EVERY).await;
        // 客户端放弃了这条连接：写失败即收工。
        if stream.write_all(piece).await.is_err() {
            return;
        }
    }
    let _ = stream.shutdown().await;
}

/// 扮演分发入口：第一次 302 到 `first`，之后每次 302 到 `then`。
async fn redirector(route: &str, first: &str, then: &str) -> MockServer {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path(route))
        .respond_with(ResponseTemplate::new(302).insert_header("Location", first))
        .up_to_n_times(1)
        .with_priority(1)
        .mount(&server)
        .await;
    Mock::given(method("GET"))
        .and(path(route))
        .respond_with(ResponseTemplate::new(302).insert_header("Location", then))
        .with_priority(2)
        .mount(&server)
        .await;
    server
}

async fn origin_gets(server: &MockServer) -> usize {
    server
        .received_requests()
        .await
        .expect("开启了请求记录")
        .len()
}

fn probe_then_fast(start: Option<u64>, _: &[Option<u64>]) -> Pace {
    match start {
        None => Pace::HeadOnly,
        Some(_) => Pace::Fast,
    }
}

fn probe_then_drip(start: Option<u64>, _: &[Option<u64>]) -> Pace {
    match start {
        None => Pace::HeadOnly,
        Some(_) => Pace::DripTail(DRIP_ALL),
    }
}

/// 3 MiB 切三片，慢节点前两片快放、第三片滴灌：第三片被放弃，向原地址换到快节点只续传第三片，
/// 前两片不重下，文件完整。
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn slow_endpoint_is_abandoned_and_only_unfinished_chunks_resume_on_a_new_node() {
    let total = 3 * MIB;
    let body = payload(total);
    let sha1 = sha1_of(&body).await;
    let slow = Endpoint::start(body.clone(), |start, _| match start {
        None => Pace::HeadOnly,
        Some(start) if start < 2 * MIB => Pace::Fast,
        Some(_) => Pace::DripTail(DRIP_ALL),
    })
    .await;
    let fast = Endpoint::start(body.clone(), probe_then_fast).await;
    let origin = redirector(
        "/maven/big.jar",
        &slow.url("/node/big.jar?s=first&e=1"),
        &fast.url("/node/big.jar?s=second&e=2"),
    )
    .await;

    let dir = tempfile::tempdir().unwrap();
    let dest = dir.path().join("big.jar");
    let downloader = Downloader::new(client(), config(one_at_a_time(MIB), single_source()));
    let task = DownloadTask::new(format!("{}/maven/big.jar", origin.uri()), &dest)
        .with_size(total)
        .with_sha1(&sha1);

    let started = Instant::now();
    downloader.download(&task).await.expect("换节点后应下完");
    let elapsed = started.elapsed();

    assert_eq!(sha1_of_file(&dest).await, sha1);
    assert_eq!(
        fast.range_starts(),
        vec![2 * MIB],
        "快节点只续传没下完的第三片"
    );
    assert_eq!(
        slow.requests(),
        vec![None, Some(0), Some(MIB), Some(2 * MIB)],
        "慢节点上前两片各只请求一次"
    );
    assert_eq!(origin_gets(&origin).await, 2, "首次取终点 + 判慢后重取一次");
    // 第三片全靠滴灌要 100 秒以上。
    assert!(elapsed < Duration::from_secs(10), "耗时 {elapsed:?}");
    only_dest_left(dir.path(), &dest);
}

/// 声明大小 `size` 的文件在先快后慢的终点上下载：末尾 24 KiB 滴灌约 2.4 秒，长于 1 秒窗口。
/// 返回分发入口收到的请求数与两个节点各自收到的请求。
async fn floor_case(size: u64) -> (usize, Vec<Option<u64>>, Vec<Option<u64>>, Duration) {
    let body = payload(size);
    let sha1 = sha1_of(&body).await;
    let slow = Endpoint::start(body.clone(), |start, _| match start {
        None => Pace::HeadOnly,
        Some(_) => Pace::DripTail(24 * 1024),
    })
    .await;
    let fast = Endpoint::start(body.clone(), probe_then_fast).await;
    let origin = redirector(
        "/maven/lib.jar",
        &slow.url("/lib.jar"),
        &fast.url("/lib.jar"),
    )
    .await;

    let dir = tempfile::tempdir().unwrap();
    let dest = dir.path().join("lib.jar");
    // 4 MiB 一片：两个大小都只切一片，差别只在看门狗盯不盯。
    let downloader = Downloader::new(client(), config(one_at_a_time(4 * MIB), single_source()));
    let task = DownloadTask::new(format!("{}/maven/lib.jar", origin.uri()), &dest)
        .with_size(size)
        .with_sha1(&sha1);

    let started = Instant::now();
    downloader.download(&task).await.expect("应下完");
    let elapsed = started.elapsed();
    assert_eq!(sha1_of_file(&dest).await, sha1);
    only_dest_left(dir.path(), &dest);
    (
        origin_gets(&origin).await,
        slow.requests(),
        fast.requests(),
        elapsed,
    )
}

/// 恰为下限大小的文件不受看门狗管：慢也在原终点上下完，分发入口只被问一次；
/// 大一个字节就会判慢并向原地址重取终点。
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn files_at_the_size_floor_are_never_watched() {
    let ((at_floor, floor_slow, floor_fast, floor_elapsed), (above, above_slow, above_fast, _)) = tokio::join!(
        floor_case(WATCHDOG_MIN_FILE_SIZE),
        floor_case(WATCHDOG_MIN_FILE_SIZE + 1)
    );

    assert_eq!(at_floor, 1, "不盯的文件不会重取终点");
    assert_eq!(floor_slow, vec![None, Some(0)]);
    assert!(floor_fast.is_empty(), "不该换到快节点：{floor_fast:?}");
    assert!(
        floor_elapsed > test_watchdog().window,
        "传输时长要长于窗口，才说明是没盯而不是没来得及判：{floor_elapsed:?}"
    );

    assert_eq!(above, 2, "大一个字节就会判慢并重取终点");
    assert_eq!(above_slow, vec![None, Some(0)]);
    assert_eq!(above_fast, vec![None, Some(0)], "唯一一片在快节点上续传");
}

/// Official 指向分发入口，BmclApi 指向另一台快服务器。
struct TwoSources {
    official: String,
    mirror: String,
}

impl SourceResolver for TwoSources {
    fn resolve(&self, _url: &str, source: MirrorSource) -> aurora_download::Result<String> {
        Ok(match source {
            MirrorSource::Official => self.official.clone(),
            MirrorSource::BmclApi => self.mirror.clone(),
        })
    }
}

struct SameNodeOutcome {
    origin_url: String,
    mirror_url: String,
    origin_gets: usize,
    slow: Vec<Option<u64>>,
    mirror: Vec<u64>,
    health: Arc<SourceHealth>,
}

/// 分发入口每次都跳回同一个慢节点，第二个源是快服务器。`threshold` 是健康表的熔断阈值。
async fn same_node_case(threshold: u32) -> SameNodeOutcome {
    let total = 2 * MIB;
    let body = payload(total);
    let sha1 = sha1_of(&body).await;
    let slow = Endpoint::start(body.clone(), probe_then_drip).await;
    let mirror = Endpoint::start(body.clone(), probe_then_fast).await;
    let node = slow.url("/node/f.jar?s=same&e=1");
    let origin = redirector("/f.jar", &node, &node).await;
    let origin_url = format!("{}/f.jar", origin.uri());
    let mirror_url = mirror.url("/f.jar");

    let sources = SourcePlan::with_resolver(
        vec![MirrorSource::Official, MirrorSource::BmclApi],
        Arc::new(TwoSources {
            official: origin_url.clone(),
            mirror: mirror_url.clone(),
        }),
    );
    let health = Arc::new(SourceHealth::with_policy(
        threshold,
        Duration::from_secs(60),
    ));
    let downloader = Downloader::with_health(
        client(),
        config(one_at_a_time(MIB), sources),
        health.clone(),
    );
    let dir = tempfile::tempdir().unwrap();
    let dest = dir.path().join("f.jar");
    let task = DownloadTask::new("https://official.example/f.jar", &dest)
        .with_size(total)
        .with_sha1(&sha1);

    downloader
        .download(&task)
        .await
        .expect("应在第二个源上下完");
    assert_eq!(sha1_of_file(&dest).await, sha1);
    only_dest_left(dir.path(), &dest);
    SameNodeOutcome {
        origin_url,
        mirror_url,
        origin_gets: origin_gets(&origin).await,
        slow: slow.requests(),
        mirror: mirror.range_starts(),
        health,
    }
}

/// 原地址始终跳回同一个慢节点：换不出新终点即换源，在第二个源上下完；第一个源的主机记一次故障。
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_source_that_keeps_sending_the_same_slow_node_is_left_for_the_next_source() {
    let (trip_at_one, trip_at_two) = tokio::join!(same_node_case(1), same_node_case(2));

    for outcome in [&trip_at_one, &trip_at_two] {
        assert_eq!(outcome.origin_gets, 2, "首次取终点 + 判慢后重取一次");
        assert_eq!(
            outcome.slow,
            vec![None, Some(0), None],
            "慢节点：探测、首片滴灌、重取终点时又被跳回来"
        );
        assert_eq!(
            outcome.mirror,
            vec![0, MIB],
            "第二个源上首片重下、第二片接着下"
        );
        assert!(!outcome.health.is_tripped(&outcome.mirror_url));
    }
    assert!(
        trip_at_one.health.is_tripped(&trip_at_one.origin_url),
        "慢源记了故障"
    );
    assert!(
        !trip_at_two.health.is_tripped(&trip_at_two.origin_url),
        "只记了一次故障，阈值 2 时不熔断"
    );
}

/// 只有一个候选、第一次连接慢后面快：判慢后原地址换不出新终点，作为最后一个源关掉看门狗再来，
/// 照样下完。
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn the_last_source_finishes_with_the_watchdog_off() {
    let total = 2 * MIB;
    let body = payload(total);
    let sha1 = sha1_of(&body).await;
    let node = Endpoint::start(body.clone(), |start, seen| match start {
        None => Pace::HeadOnly,
        Some(_) if seen.iter().all(Option::is_none) => Pace::DripTail(DRIP_ALL),
        Some(_) => Pace::Fast,
    })
    .await;
    let downloader = Downloader::new(client(), config(one_at_a_time(MIB), single_source()));
    let dir = tempfile::tempdir().unwrap();
    let dest = dir.path().join("only.jar");
    let url = node.url("/only.jar");
    let task = DownloadTask::new(&url, &dest)
        .with_size(total)
        .with_sha1(&sha1);

    let started = Instant::now();
    downloader
        .download(&task)
        .await
        .expect("最后一个源上慢也要下完");
    let elapsed = started.elapsed();

    assert_eq!(sha1_of_file(&dest).await, sha1);
    assert_eq!(
        node.requests(),
        vec![
            // 第一轮：探测、首片滴灌被判慢、向原地址重取终点仍是自己。
            None,
            Some(0),
            None,
            // 关掉看门狗的一轮：探测、首片重下、第二片。
            None,
            Some(0),
            Some(MIB),
        ]
    );
    assert!(elapsed < Duration::from_secs(10), "耗时 {elapsed:?}");
    only_dest_left(dir.path(), &dest);
}

/// 第一个源只是慢、后面的源根本没有这个文件（镜像还没同步到的新版本就是这样）：换源失败后回到慢源，
/// 关掉看门狗在它上面下完，而不是把一个本来下得完的文件判成装不上。
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_slow_source_is_finished_with_the_watchdog_off_when_every_later_source_fails() {
    let total = 2 * MIB;
    let body = payload(total);
    let sha1 = sha1_of(&body).await;
    let node = Endpoint::start(body.clone(), |start, seen| match start {
        None => Pace::HeadOnly,
        Some(_) if seen.iter().all(Option::is_none) => Pace::DripTail(DRIP_ALL),
        Some(_) => Pace::Fast,
    })
    .await;
    let mirror = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/f.jar"))
        .respond_with(ResponseTemplate::new(404))
        .mount(&mirror)
        .await;
    let official_url = node.url("/f.jar");
    let sources = SourcePlan::with_resolver(
        vec![MirrorSource::Official, MirrorSource::BmclApi],
        Arc::new(TwoSources {
            official: official_url.clone(),
            mirror: format!("{}/f.jar", mirror.uri()),
        }),
    );
    let health = Arc::new(SourceHealth::with_policy(1, Duration::from_secs(60)));
    let downloader = Downloader::with_health(
        client(),
        config(one_at_a_time(MIB), sources),
        health.clone(),
    );
    let dir = tempfile::tempdir().unwrap();
    let dest = dir.path().join("f.jar");
    let task = DownloadTask::new("https://official.example/f.jar", &dest)
        .with_size(total)
        .with_sha1(&sha1);

    let started = Instant::now();
    downloader
        .download(&task)
        .await
        .expect("后面的源都失败时，慢源上关掉看门狗也要下完");
    let elapsed = started.elapsed();

    assert_eq!(sha1_of_file(&dest).await, sha1);
    assert_eq!(
        node.requests(),
        vec![
            // 看门狗盯着的一轮：探测、首片滴灌被判慢、向原地址重取终点仍是自己。
            None,
            Some(0),
            None,
            // 镜像 404 之后回到这里、关掉看门狗的一轮：探测、首片重下、第二片。
            None,
            Some(0),
            Some(MIB),
        ]
    );
    assert!(origin_gets(&mirror).await >= 1, "镜像确实试过");
    assert!(
        !health.is_tripped(&official_url),
        "慢源最后下成了，之前记的故障一笔勾销"
    );
    assert!(elapsed < Duration::from_secs(10), "耗时 {elapsed:?}");
    only_dest_left(dir.path(), &dest);
}

/// 轮询直到 `cond` 成立；5 s 内不成立说明现场没造出来，测试本身有问题。
async fn wait_until(what: &str, cond: impl Fn() -> bool) {
    let deadline = Instant::now() + Duration::from_secs(5);
    while !cond() {
        assert!(Instant::now() < deadline, "等待超时：{what}");
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
}

/// 取消后命令必须在这个时限内返回。
const CANCEL_DEADLINE: Duration = Duration::from_millis(1000);

/// 看门狗武装着、首片正在滴灌时用户取消：1 秒内返回取消而不是判慢，中间文件清干净。
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn user_cancel_while_armed_returns_cancelled_quickly() {
    let total = 2 * MIB;
    let node = Endpoint::start(payload(total), probe_then_drip).await;
    let dir = tempfile::tempdir().unwrap();
    let dest = dir.path().join("cancel.jar");
    let task = DownloadTask::new(node.url("/cancel.jar"), &dest).with_size(total);
    let token = CancellationToken::new();
    let pool = DownloadPool::new(
        Downloader::new(client(), config(one_at_a_time(MIB), single_source())),
        1,
    )
    .with_cancel(token.clone());
    let started = Instant::now();
    let download = tokio::spawn(async move { pool.download_all(vec![task], None).await });

    let part0 = dir.path().join("cancel.jar.petalfall-part0");
    wait_until("首片开始写", || part0.exists()).await;
    assert!(
        started.elapsed() < test_watchdog().window,
        "要在看门狗判慢之前取消"
    );
    let cancelled_at = Instant::now();
    token.cancel();
    let err = download
        .await
        .expect("下载任务不应 panic")
        .expect_err("取消后不应成功");
    let elapsed = cancelled_at.elapsed();

    assert!(err.is_cancelled(), "应为取消，实际：{err:?}");
    assert!(elapsed < CANCEL_DEADLINE, "取消到返回耗时 {elapsed:?}");
    assert_eq!(node.range_starts(), vec![0]);
    let left: Vec<_> = std::fs::read_dir(dir.path()).unwrap().flatten().collect();
    assert!(left.is_empty(), "不应留下任何文件：{left:?}");
}

/// 判慢之后、向原地址重取终点的半路上用户取消：返回取消而不是判慢。
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn user_cancel_during_endpoint_switch_wins_over_the_watchdog() {
    let total = 2 * MIB;
    let body = payload(total);
    let slow = Endpoint::start(body.clone(), probe_then_drip).await;
    let fast = Endpoint::start(body.clone(), probe_then_fast).await;
    let origin = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/f.jar"))
        .respond_with(ResponseTemplate::new(302).insert_header("Location", slow.url("/f.jar")))
        .up_to_n_times(1)
        .with_priority(1)
        .mount(&origin)
        .await;
    // 重取终点的这一次迟迟不回：取消正落在换终点途中。
    Mock::given(method("GET"))
        .and(path("/f.jar"))
        .respond_with(
            ResponseTemplate::new(302)
                .insert_header("Location", fast.url("/f.jar"))
                .set_delay(Duration::from_secs(30)),
        )
        .with_priority(2)
        .mount(&origin)
        .await;

    let dir = tempfile::tempdir().unwrap();
    let dest = dir.path().join("f.jar");
    let task = DownloadTask::new(format!("{}/f.jar", origin.uri()), &dest).with_size(total);
    let token = CancellationToken::new();
    let pool = DownloadPool::new(
        Downloader::new(client(), config(one_at_a_time(MIB), single_source())),
        1,
    )
    .with_cancel(token.clone());
    let download = tokio::spawn(async move { pool.download_all(vec![task], None).await });

    let deadline = Instant::now() + Duration::from_secs(5);
    while origin_gets(&origin).await < 2 {
        assert!(Instant::now() < deadline, "等待超时：判慢后重取终点");
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    let cancelled_at = Instant::now();
    token.cancel();
    let err = download
        .await
        .expect("下载任务不应 panic")
        .expect_err("取消后不应成功");
    let elapsed = cancelled_at.elapsed();

    assert!(err.is_cancelled(), "应为取消，实际：{err:?}");
    assert!(elapsed < CANCEL_DEADLINE, "取消到返回耗时 {elapsed:?}");
    assert!(fast.requests().is_empty(), "还没换到新终点");
    let left: Vec<_> = std::fs::read_dir(dir.path()).unwrap().flatten().collect();
    assert!(left.is_empty(), "不应留下任何文件：{left:?}");
}

/// 分片关闭的 2 MiB 文件走整文件单流：慢节点前 1 MiB 快放后面滴灌，判慢后删掉半截临时文件，
/// 向原地址换到快节点从头重下。
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn whole_file_stream_switches_endpoint_and_starts_over() {
    let total = 2 * MIB;
    let body = payload(total);
    let sha1 = sha1_of(&body).await;
    let slow = Endpoint::start(body.clone(), |_, _| Pace::DripTail(MIB as usize)).await;
    let fast = Endpoint::start(body.clone(), |_, _| Pace::Fast).await;
    let origin = redirector(
        "/whole.jar",
        &slow.url("/whole.jar?s=a&e=1"),
        &fast.url("/whole.jar?s=b&e=2"),
    )
    .await;
    let chunk = ChunkConfig {
        enabled: false,
        ..one_at_a_time(MIB)
    };
    let downloader = Downloader::new(client(), config(chunk, single_source()));
    let dir = tempfile::tempdir().unwrap();
    let dest = dir.path().join("whole.jar");
    let task = DownloadTask::new(format!("{}/whole.jar", origin.uri()), &dest)
        .with_size(total)
        .with_sha1(&sha1);

    let started = Instant::now();
    downloader.download(&task).await.expect("换节点后应下完");
    let elapsed = started.elapsed();

    assert_eq!(sha1_of_file(&dest).await, sha1);
    assert_eq!(origin_gets(&origin).await, 2, "首次下载 + 判慢后重取一次");
    assert_eq!(slow.requests(), vec![None], "慢节点只被下过一次");
    assert_eq!(
        fast.requests(),
        vec![None, None],
        "快节点：重取终点的探测与从头重下，都不带 Range"
    );
    assert!(elapsed < Duration::from_secs(10), "耗时 {elapsed:?}");
    only_dest_left(dir.path(), &dest);
}

/// 测试用下载密钥。手写终点按小写读回请求头，取全小写免得比较时还要转换。
const API_KEY: &str = "cf-test-key";

/// 作用域只认这几台本地服务器的下载密钥。
fn scoped_credential(hosts: &[String]) -> DownloadCredential {
    DownloadCredential::curseforge(API_KEY)
        .expect("测试密钥合法")
        .with_scope(CredentialScope::new(hosts.iter().cloned(), false))
}

fn credentialed_downloader(chunk: ChunkConfig) -> Downloader {
    Downloader::new(client(), config(chunk, single_source())).with_manual_redirect_client(
        aurora_base::http::build_manual_redirect_client().expect("构建不跳转客户端"),
    )
}

/// 分发入口每个请求带来的下载密钥，按到达顺序。
async fn origin_keys(server: &MockServer) -> Vec<Option<String>> {
    server
        .received_requests()
        .await
        .expect("开启了请求记录")
        .iter()
        .map(|r| {
            r.headers
                .get("x-api-key")
                .map(|v| v.to_str().unwrap().to_owned())
        })
        .collect()
}

/// 带密钥的分片下载判慢换节点：向原地址重取终点那一跳、新节点上的续传请求，都按作用域带上密钥。
/// 判慢后的重取终点若绕开逐跳规则改用自动跳转的客户端，原地址与新节点都会收到没带密钥的请求。
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn credentialed_chunked_download_keeps_the_key_on_the_switched_node() {
    let total = 3 * MIB;
    let body = payload(total);
    let sha1 = sha1_of(&body).await;
    let slow = Endpoint::start(body.clone(), |start, _| match start {
        None => Pace::HeadOnly,
        Some(start) if start < 2 * MIB => Pace::Fast,
        Some(_) => Pace::DripTail(DRIP_ALL),
    })
    .await;
    let fast = Endpoint::start(body.clone(), probe_then_fast).await;
    let origin = redirector(
        "/files/big.jar",
        &slow.url("/node/big.jar?s=first&e=1"),
        &fast.url("/node/big.jar?s=second&e=2"),
    )
    .await;
    let credential = scoped_credential(&[
        origin.address().to_string(),
        slow.addr.to_string(),
        fast.addr.to_string(),
    ]);

    let dir = tempfile::tempdir().unwrap();
    let dest = dir.path().join("big.jar");
    let task = DownloadTask::new(format!("{}/files/big.jar", origin.uri()), &dest)
        .with_size(total)
        .with_sha1(&sha1)
        .with_credential(credential);
    credentialed_downloader(one_at_a_time(MIB))
        .download(&task)
        .await
        .expect("换节点后应下完");

    let key = Some(API_KEY.to_owned());
    assert_eq!(sha1_of_file(&dest).await, sha1);
    assert_eq!(
        origin_keys(&origin).await,
        vec![key.clone(), key.clone()],
        "首次取终点与判慢后重取，都带密钥"
    );
    assert_eq!(fast.requests(), vec![None, Some(2 * MIB)]);
    assert_eq!(
        fast.api_keys(),
        vec![key.clone(), key.clone()],
        "新节点上的探测与续传都带密钥"
    );
    assert_eq!(slow.api_keys(), vec![key; 4]);
    only_dest_left(dir.path(), &dest);
}

/// 带密钥的整文件单流判慢换节点：新节点在作用域外时，探测与从头重下都不带密钥，
/// 作用域内的原地址与慢节点照常带。
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn credentialed_whole_file_switch_decides_the_key_per_hop() {
    let total = 2 * MIB;
    let body = payload(total);
    let sha1 = sha1_of(&body).await;
    let slow = Endpoint::start(body.clone(), |_, _| Pace::DripTail(MIB as usize)).await;
    let fast = Endpoint::start(body.clone(), |_, _| Pace::Fast).await;
    let origin = redirector(
        "/whole.jar",
        &slow.url("/whole.jar?s=a&e=1"),
        &fast.url("/whole.jar?s=b&e=2"),
    )
    .await;
    let credential = scoped_credential(&[origin.address().to_string(), slow.addr.to_string()]);
    let chunk = ChunkConfig {
        enabled: false,
        ..one_at_a_time(MIB)
    };

    let dir = tempfile::tempdir().unwrap();
    let dest = dir.path().join("whole.jar");
    let task = DownloadTask::new(format!("{}/whole.jar", origin.uri()), &dest)
        .with_size(total)
        .with_sha1(&sha1)
        .with_credential(credential);
    credentialed_downloader(chunk)
        .download(&task)
        .await
        .expect("换节点后应下完");

    let key = Some(API_KEY.to_owned());
    assert_eq!(sha1_of_file(&dest).await, sha1);
    assert_eq!(origin_keys(&origin).await, vec![key.clone(), key.clone()]);
    assert_eq!(slow.api_keys(), vec![key], "慢节点在作用域内");
    assert_eq!(
        fast.api_keys(),
        vec![None, None],
        "作用域外的新节点：重取终点的探测与从头重下都不带密钥"
    );
    only_dest_left(dir.path(), &dest);
}
