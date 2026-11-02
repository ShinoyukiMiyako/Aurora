//! 下载源测速的集成测试：两个源各钉到一台本地 mock 服务器，探针量的是它们的真实响应时延。

use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

use aurora_download::{MirrorSource, SourceResolver, SourceSpeedCache, probe_latencies};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::oneshot;
use wiremock::matchers::{header, method};
use wiremock::{Mock, MockServer, Request, Respond, ResponseTemplate};

const OFFICIAL_FIRST: [MirrorSource; 2] = [MirrorSource::Official, MirrorSource::BmclApi];
const MIRROR_FIRST: [MirrorSource; 2] = [MirrorSource::BmclApi, MirrorSource::Official];

/// 不考验超时的用例用的探针时限：只是兜底，机器再满载也碰不到，用例不靠它分出结果。
const UNREACHED_TIMEOUT: Duration = Duration::from_secs(60);

fn client() -> reqwest::Client {
    aurora_base::http::build_client().expect("构建客户端")
}

/// 把两个源分别钉到两台本地服务器；`broken_mirror` 时镜像侧解析失败。
struct PinnedResolver {
    official: String,
    bmcl: String,
    broken_mirror: bool,
}

impl SourceResolver for PinnedResolver {
    fn resolve(&self, _url: &str, source: MirrorSource) -> aurora_download::Result<String> {
        match source {
            MirrorSource::Official => Ok(self.official.clone()),
            MirrorSource::BmclApi if self.broken_mirror => {
                Err(aurora_base::Error::UrlMissingHost(self.bmcl.clone()).into())
            }
            MirrorSource::BmclApi => Ok(self.bmcl.clone()),
        }
    }
}

/// 起一台按给定状态码与延迟应答的源。只认 `Range: bytes=0-0`：探针不带它就拿不到 2xx。
async fn mock_source(status: u16, delay: Duration) -> MockServer {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(header("range", "bytes=0-0"))
        .respond_with(ResponseTemplate::new(status).set_delay(delay))
        .mount(&server)
        .await;
    server
}

fn resolver(official: &MockServer, bmcl: &MockServer) -> PinnedResolver {
    PinnedResolver {
        official: format!("{}/probe", official.uri()),
        bmcl: format!("{}/probe", bmcl.uri()),
        broken_mirror: false,
    }
}

fn cache_with(
    official: &MockServer,
    bmcl: &MockServer,
    ttl: Duration,
    probe_timeout: Duration,
) -> SourceSpeedCache {
    SourceSpeedCache::with_probe(
        "https://piston-meta.mojang.com/mc/game/version_manifest_v2.json",
        Arc::new(resolver(official, bmcl)),
        ttl,
        probe_timeout,
    )
}

fn cache_for(official: &MockServer, bmcl: &MockServer) -> SourceSpeedCache {
    cache_with(official, bmcl, Duration::from_secs(60), UNREACHED_TIMEOUT)
}

async fn hits(server: &MockServer) -> usize {
    server
        .received_requests()
        .await
        .expect("mock 服务器开着请求记录")
        .len()
}

/// 读完一个请求（到空行为止）。探针没有请求体。
async fn read_request(conn: &mut TcpStream) {
    let mut seen = Vec::new();
    while !seen.ends_with(b"\r\n\r\n") {
        let mut chunk = [0u8; 512];
        let read = conn.read(&mut chunk).await.expect("读请求");
        assert_ne!(read, 0, "请求没读完连接就断了");
        seen.extend_from_slice(&chunk[..read]);
    }
}

/// 起一快一慢两个探针终点，返回 `(快, 慢)` 的地址，各接一次探针。
///
/// 快慢由事件排定，不靠响应延迟的差值：机器满载时快的一方自己就可能拖过那个差值。快的一方只发响应头、
/// 扣着响应体，探针记完时延、丢掉响应才会断开连接，连接断开之后慢的一方才答。
///
/// 用例要跑在单线程运行时，并把慢的一方放在入参前面：探针任务按入参次序起跑，慢的一方开始得不晚、结束得更晚，
/// 实测时延一定更长。
async fn staged_sources() -> (String, String) {
    let fast = TcpListener::bind("127.0.0.1:0")
        .await
        .expect("绑定快的一方");
    let slow = TcpListener::bind("127.0.0.1:0")
        .await
        .expect("绑定慢的一方");
    let urls = (
        format!("http://{}/probe", fast.local_addr().unwrap()),
        format!("http://{}/probe", slow.local_addr().unwrap()),
    );
    let (fast_probe_done, answer_slow) = oneshot::channel::<()>();
    tokio::spawn(async move {
        let (mut conn, _) = fast.accept().await.expect("接受探针");
        read_request(&mut conn).await;
        conn.write_all(b"HTTP/1.1 206 Partial Content\r\nContent-Length: 1\r\n\r\n")
            .await
            .expect("写响应头");
        // 读到 0 或连接被重置都是对端丢掉了响应，这里只关心它断开了。
        let _ = conn.read(&mut [0u8; 1]).await;
        fast_probe_done.send(()).expect("用例还在等慢的一方");
    });
    tokio::spawn(async move {
        let (mut conn, _) = slow.accept().await.expect("接受探针");
        read_request(&mut conn).await;
        answer_slow.await.expect("快的一方应先结束");
        conn.write_all(b"HTTP/1.1 206 Partial Content\r\nContent-Length: 0\r\n\r\n")
            .await
            .expect("写响应");
    });
    urls
}

/// 官方快、镜像慢：排出来官方在前，恰与传入的兜底顺序相反，证明排序真的按实测生效。
#[tokio::test]
async fn faster_source_is_ranked_first() {
    let (official, bmcl) = staged_sources().await;
    let cache = SourceSpeedCache::with_probe(
        "https://piston-meta.mojang.com/mc/game/version_manifest_v2.json",
        Arc::new(PinnedResolver {
            official,
            bmcl,
            broken_mirror: false,
        }),
        Duration::from_secs(60),
        UNREACHED_TIMEOUT,
    );

    let order = cache
        .measured_order(&client(), &MIRROR_FIRST)
        .await
        .unwrap();
    assert_eq!(order, OFFICIAL_FIRST.to_vec());
    assert!(cache.is_fresh());
    // 记下的结论供同步路径直接取用，传入哪种兜底顺序都按实测重排。
    assert_eq!(cache.order_now(&MIRROR_FIRST), OFFICIAL_FIRST.to_vec());
    assert_eq!(
        cache.order_now(&[MirrorSource::BmclApi]),
        vec![MirrorSource::BmclApi]
    );
}

/// 官方探不通、镜像慢但通：失败源沉底，结论照常缓存。
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn unreachable_source_sinks_below_a_slow_one() {
    let official = mock_source(503, Duration::ZERO).await;
    let bmcl = mock_source(200, Duration::from_millis(120)).await;
    let cache = cache_for(&official, &bmcl);

    let order = cache
        .measured_order(&client(), &OFFICIAL_FIRST)
        .await
        .unwrap();
    assert_eq!(order, MIRROR_FIRST.to_vec());
    assert!(cache.is_fresh());
}

/// 两个源都 500：返回兜底顺序且不写缓存，下一次照样重新探测。
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn all_probes_failing_returns_fallback_and_caches_nothing() {
    let official = mock_source(500, Duration::ZERO).await;
    let bmcl = mock_source(500, Duration::ZERO).await;
    let cache = cache_for(&official, &bmcl);
    let client = client();

    let order = cache.measured_order(&client, &MIRROR_FIRST).await.unwrap();
    assert_eq!(order, MIRROR_FIRST.to_vec());
    assert!(!cache.is_fresh());
    assert_eq!(cache.order_now(&MIRROR_FIRST), MIRROR_FIRST.to_vec());

    cache.measured_order(&client, &MIRROR_FIRST).await.unwrap();
    assert_eq!(hits(&official).await, 2);
    assert_eq!(hits(&bmcl).await, 2);
}

/// 缓存命中不再碰网络：请求数一个不涨。
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn cache_hit_issues_no_further_probes() {
    let official = mock_source(200, Duration::ZERO).await;
    let bmcl = mock_source(200, Duration::from_millis(200)).await;
    let cache = cache_for(&official, &bmcl);
    let client = client();

    let first = cache.measured_order(&client, &MIRROR_FIRST).await.unwrap();
    for _ in 0..3 {
        assert_eq!(
            cache.measured_order(&client, &MIRROR_FIRST).await.unwrap(),
            first
        );
    }
    assert_eq!(hits(&official).await, 1);
    assert_eq!(hits(&bmcl).await, 1);
}

/// 过期即重测。有效期取 0，测完当场过期：断言不用跟「测完到检查」这段时间赛跑。
/// 镜像探不通，所以实测顺序是官方在前，与兜底顺序相反，过期的结论有没有被拿来用一眼能分出来。
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn expired_measurement_is_remeasured() {
    let official = mock_source(200, Duration::ZERO).await;
    let bmcl = mock_source(503, Duration::ZERO).await;
    let cache = cache_with(&official, &bmcl, Duration::ZERO, UNREACHED_TIMEOUT);
    let client = client();

    let order = cache.measured_order(&client, &MIRROR_FIRST).await.unwrap();
    assert_eq!(order, OFFICIAL_FIRST.to_vec());
    assert!(!cache.is_fresh());
    // 过期的结论不再参与同步路径的排序。
    assert_eq!(cache.order_now(&MIRROR_FIRST), MIRROR_FIRST.to_vec());

    cache.measured_order(&client, &MIRROR_FIRST).await.unwrap();
    assert_eq!(hits(&official).await, 2);
}

/// 显式失效后下一次取用重测。
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn invalidate_forces_a_new_measurement() {
    let official = mock_source(200, Duration::ZERO).await;
    let bmcl = mock_source(200, Duration::from_millis(80)).await;
    let cache = cache_for(&official, &bmcl);
    let client = client();

    cache.measured_order(&client, &MIRROR_FIRST).await.unwrap();
    cache.invalidate();
    assert!(!cache.is_fresh());
    assert_eq!(cache.order_now(&MIRROR_FIRST), MIRROR_FIRST.to_vec());

    cache.measured_order(&client, &MIRROR_FIRST).await.unwrap();
    assert_eq!(hits(&official).await, 2);
    assert_eq!(hits(&bmcl).await, 2);
}

/// 结论没覆盖本次要排的源（只测过官方）时不拿它凑数，现测一轮。官方只答得上头一轮，
/// 第二轮排出镜像在前只可能来自现测。
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn measurement_missing_a_source_is_not_reused() {
    let official = MockServer::start().await;
    Mock::given(method("GET"))
        .and(header("range", "bytes=0-0"))
        .respond_with(ResponseTemplate::new(200))
        .up_to_n_times(1)
        .with_priority(1)
        .mount(&official)
        .await;
    Mock::given(method("GET"))
        .and(header("range", "bytes=0-0"))
        .respond_with(ResponseTemplate::new(503))
        .mount(&official)
        .await;
    let bmcl = mock_source(200, Duration::ZERO).await;
    let cache = cache_for(&official, &bmcl);
    let client = client();

    let only_official = cache
        .measured_order(&client, &[MirrorSource::Official])
        .await
        .unwrap();
    assert_eq!(only_official, vec![MirrorSource::Official]);
    assert_eq!(cache.order_now(&OFFICIAL_FIRST), OFFICIAL_FIRST.to_vec());

    let both = cache
        .measured_order(&client, &OFFICIAL_FIRST)
        .await
        .unwrap();
    assert_eq!(both, MIRROR_FIRST.to_vec());
    assert_eq!(hits(&bmcl).await, 1);
}

/// 两处同时取顺序只打一轮探针，后到的那处拿到的是实测结论而不是兜底顺序。
/// 镜像探不通，实测顺序就与兜底顺序相反；`join!` 里后一处总在前一处的探针发出之后才被轮询。
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn concurrent_callers_share_one_probe_round() {
    let official = mock_source(200, Duration::ZERO).await;
    let bmcl = mock_source(503, Duration::ZERO).await;
    let cache = cache_for(&official, &bmcl);
    let client = client();

    let (first, second) = tokio::join!(
        cache.measured_order(&client, &MIRROR_FIRST),
        cache.measured_order(&client, &MIRROR_FIRST),
    );
    assert_eq!(first.unwrap(), OFFICIAL_FIRST.to_vec());
    assert_eq!(second.unwrap(), OFFICIAL_FIRST.to_vec());
    assert_eq!(hits(&official).await, 1);
    assert_eq!(hits(&bmcl).await, 1);
}

/// 镜像侧样本地址解析失败：整体报错，一个探针都不发，也不留结论。
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn resolve_failure_is_an_error_and_sends_nothing() {
    let official = mock_source(200, Duration::ZERO).await;
    let bmcl = mock_source(200, Duration::ZERO).await;
    let cache = SourceSpeedCache::with_probe(
        "https://piston-meta.mojang.com/mc/game/version_manifest_v2.json",
        Arc::new(PinnedResolver {
            broken_mirror: true,
            ..resolver(&official, &bmcl)
        }),
        Duration::from_secs(60),
        UNREACHED_TIMEOUT,
    );

    let err = cache
        .measured_order(&client(), &OFFICIAL_FIRST)
        .await
        .unwrap_err();
    assert!(
        matches!(
            err,
            aurora_download::Error::Base(aurora_base::Error::UrlMissingHost(_))
        ),
        "实际：{err:?}"
    );
    assert!(!cache.is_fresh());
    assert_eq!(hits(&official).await, 0);
    assert_eq!(hits(&bmcl).await, 0);
}

/// 两台源共用的会合点：两个探针都到了才一起答。
#[derive(Clone)]
struct Rendezvous(Arc<(Mutex<usize>, Condvar)>);

impl Respond for Rendezvous {
    fn respond(&self, _request: &Request) -> ResponseTemplate {
        let (arrived, all_here) = &*self.0;
        let mut arrived = arrived.lock().unwrap();
        *arrived += 1;
        all_here.notify_all();
        // 时限只防用例挂死：等不齐时放行，探针此时已按超时记成测不出，断言照常失败。
        let (_arrived, _) = all_here
            .wait_timeout_while(arrived, UNREACHED_TIMEOUT, |arrived| *arrived < 2)
            .unwrap();
        ResponseTemplate::new(200)
    }
}

/// 探针是并发发出的：两边都要等对方到了才答。改成逐个发时第二个要等第一个超时才出门，第一个就测不出时延，
/// 网络整体不佳时总耗时也就成了「源数 × 超时」。
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn probes_run_concurrently_so_timeouts_do_not_add_up() {
    let meeting = Rendezvous(Arc::default());
    let mut servers = Vec::new();
    for _ in 0..2 {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(header("range", "bytes=0-0"))
            .respond_with(meeting.clone())
            .mount(&server)
            .await;
        servers.push(server);
    }

    let measured = probe_latencies(
        &client(),
        "https://piston-meta.mojang.com/mc/game/version_manifest_v2.json",
        &MIRROR_FIRST,
        &resolver(&servers[0], &servers[1]),
        Duration::from_secs(30),
    )
    .await
    .unwrap();

    assert!(
        measured.iter().all(|(_, latency)| latency.is_some()),
        "两个探针应同时在途：{measured:?}"
    );
}

/// 两个源都卡到超时：不早于探针超时返回，按兜底顺序走，不留结论。
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn probes_that_time_out_leave_the_fallback_order() {
    let official = mock_source(200, Duration::from_secs(30)).await;
    let bmcl = mock_source(200, Duration::from_secs(30)).await;
    let probe_timeout = Duration::from_millis(200);
    let cache = cache_with(&official, &bmcl, Duration::from_secs(60), probe_timeout);

    let started = Instant::now();
    let order = cache
        .measured_order(&client(), &MIRROR_FIRST)
        .await
        .unwrap();
    let elapsed = started.elapsed();

    assert_eq!(order, MIRROR_FIRST.to_vec());
    assert!(
        elapsed >= probe_timeout,
        "探针不该早于超时返回：{elapsed:?}"
    );
    assert!(!cache.is_fresh());
}

/// 结果顺序与入参一致，与哪个探针先回来无关；时延按各自的响应时间计。
#[tokio::test]
async fn probe_results_keep_input_order() {
    let (official, bmcl) = staged_sources().await;

    let measured = probe_latencies(
        &client(),
        "https://piston-meta.mojang.com/mc/game/version_manifest_v2.json",
        &MIRROR_FIRST,
        &PinnedResolver {
            official,
            bmcl,
            broken_mirror: false,
        },
        UNREACHED_TIMEOUT,
    )
    .await
    .unwrap();

    assert_eq!(measured.len(), 2);
    assert_eq!(measured[0].0, MirrorSource::BmclApi);
    assert_eq!(measured[1].0, MirrorSource::Official);
    let slow = measured[0].1.expect("镜像应回了话");
    let fast = measured[1].1.expect("官方应回了话");
    assert!(fast < slow, "官方 {fast:?} 应快于镜像 {slow:?}");
}
