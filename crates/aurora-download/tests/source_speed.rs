//! 下载源测速的集成测试：两个源各钉到一台本地 mock 服务器，探针量的是它们的真实响应时延。

use std::sync::Arc;
use std::time::{Duration, Instant};

use aurora_download::{MirrorSource, SourceResolver, SourceSpeedCache, probe_latencies};
use wiremock::matchers::{header, method};
use wiremock::{Mock, MockServer, ResponseTemplate};

const OFFICIAL_FIRST: [MirrorSource; 2] = [MirrorSource::Official, MirrorSource::BmclApi];
const MIRROR_FIRST: [MirrorSource; 2] = [MirrorSource::BmclApi, MirrorSource::Official];

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
    cache_with(
        official,
        bmcl,
        Duration::from_secs(60),
        Duration::from_secs(3),
    )
}

async fn hits(server: &MockServer) -> usize {
    server
        .received_requests()
        .await
        .expect("mock 服务器开着请求记录")
        .len()
}

/// 官方快、镜像慢：排出来官方在前，恰与传入的兜底顺序相反，证明排序真的按实测生效。
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn faster_source_is_ranked_first() {
    let official = mock_source(206, Duration::ZERO).await;
    let bmcl = mock_source(206, Duration::from_millis(250)).await;
    let cache = cache_for(&official, &bmcl);

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

/// 过期即重测。
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn expired_measurement_is_remeasured() {
    let official = mock_source(200, Duration::ZERO).await;
    let bmcl = mock_source(200, Duration::from_millis(80)).await;
    let cache = cache_with(
        &official,
        &bmcl,
        Duration::from_millis(50),
        Duration::from_secs(3),
    );
    let client = client();

    cache.measured_order(&client, &MIRROR_FIRST).await.unwrap();
    assert!(cache.is_fresh());
    tokio::time::sleep(Duration::from_millis(80)).await;
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

/// 结论没覆盖本次要排的源（只测过官方）时不拿它凑数，现测一轮。
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn measurement_missing_a_source_is_not_reused() {
    let official = mock_source(200, Duration::from_millis(150)).await;
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
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn concurrent_callers_share_one_probe_round() {
    let official = mock_source(200, Duration::ZERO).await;
    let bmcl = mock_source(200, Duration::from_millis(300)).await;
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
        Duration::from_secs(3),
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

/// 两个源都卡到超时：并发探测总耗时收敛到一个超时，而不是「源数 × 超时」。
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn probes_run_concurrently_so_timeouts_do_not_add_up() {
    let official = mock_source(200, Duration::from_secs(2)).await;
    let bmcl = mock_source(200, Duration::from_secs(2)).await;
    let probe_timeout = Duration::from_millis(500);
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
    assert!(
        elapsed < probe_timeout * 2,
        "并发探测耗时应接近单个超时，实际 {elapsed:?}"
    );
}

/// 结果顺序与入参一致，与哪个探针先回来无关；时延按各自的响应时间计。
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn probe_results_keep_input_order() {
    let official = mock_source(200, Duration::ZERO).await;
    let bmcl = mock_source(200, Duration::from_millis(200)).await;

    let measured = probe_latencies(
        &client(),
        "https://piston-meta.mojang.com/mc/game/version_manifest_v2.json",
        &MIRROR_FIRST,
        &resolver(&official, &bmcl),
        Duration::from_secs(3),
    )
    .await
    .unwrap();

    assert_eq!(measured.len(), 2);
    assert_eq!(measured[0].0, MirrorSource::BmclApi);
    assert_eq!(measured[1].0, MirrorSource::Official);
    let slow = measured[0].1.expect("镜像应回了话");
    let fast = measured[1].1.expect("官方应回了话");
    assert!(slow >= Duration::from_millis(200), "镜像时延 {slow:?}");
    assert!(fast < slow, "官方 {fast:?} 应快于镜像 {slow:?}");
}
