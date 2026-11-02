//! 下载源计划：把三档策略落成具体的源顺序。
//!
//! 尽量官方 / 尽量镜像是静态顺序；自动档按门面上共享的测速结论排序，没有结论时取兜底顺序（镜像在前）。
//! 测速只在下载 Mojang 产物的长任务入口做（[`Aurora::prepare_sources`]），元数据与界面列表只读缓存：
//! 新建实例页这类首屏若也等探针，网络不佳时每次打开都要多等一个探针超时。
//!
//! 熔断沉底不在这里做：下载引擎对每个文件的候选地址都会按共享的源健康表重排，测速顺序与熔断自然叠加。

use aurora_base::mirror::MirrorSource;
use aurora_download::SourcePlan;

use crate::config::DownloadSourcePolicy;
use crate::error::Result;
use crate::facade::Aurora;

impl Aurora {
    /// 生成下载计划前调用：文件下载源或版本列表源任一为自动时，确保持有未过期的测速结论（TTL 内直接
    /// 返回，同一时刻只测一轮）。
    ///
    /// 两个源都测不出时不写缓存、返回 `Ok`，之后按兜底顺序下载。错误只有样本地址解析失败与探测任务
    /// 异常终止两种，原样冒泡为下载错误。
    ///
    /// 门面挂着取消令牌时，测速途中取消立即返回取消：一轮探针最长要等一个探针超时（3 秒），
    /// 不能让取消等它。丢下的那一轮不写缓存。
    pub(crate) async fn prepare_sources(&self) -> Result<()> {
        let config = self.config();
        if config.download_source != DownloadSourcePolicy::Auto
            && config.version_list_source != DownloadSourcePolicy::Auto
        {
            return Ok(());
        }
        let http = self.http();
        let fallback = DownloadSourcePolicy::Auto.mirror_order();
        let measure = self.source_speed.measured_order(&http, &fallback);
        match self.cancel_token() {
            Some(token) => {
                token
                    .run_until_cancelled(measure)
                    .await
                    .ok_or(aurora_download::Error::Cancelled)??;
            }
            None => {
                measure.await?;
            }
        }
        Ok(())
    }

    /// 该策略此刻的源顺序。不发请求：自动档读测速缓存，没有未过期结论时取兜底顺序。
    pub(crate) fn source_order(&self, policy: DownloadSourcePolicy) -> Vec<MirrorSource> {
        match policy {
            DownloadSourcePolicy::Auto => self.source_speed.order_now(&policy.mirror_order()),
            DownloadSourcePolicy::OfficialFirst | DownloadSourcePolicy::MirrorFirst => {
                policy.mirror_order()
            }
        }
    }

    /// 该策略此刻的下载源方案（顺序同 [`source_order`](Self::source_order)，地址经门面的解析器改写）。
    /// 元数据抓取不经下载引擎，方案上挂健康表，文件下载刚熔断的源在这里同样排到后面。
    pub(crate) fn source_plan(&self, policy: DownloadSourcePolicy) -> SourcePlan {
        SourcePlan::with_resolver(self.source_order(policy), self.source_resolver.clone())
            .with_health(self.source_health().clone())
    }

    /// 该策略此刻排第一的源，给只认一个首选源、自己负责兜底的下层（如 Java 运行时安装器）。
    pub(crate) fn preferred_source(&self, policy: DownloadSourcePolicy) -> MirrorSource {
        self.source_order(policy)
            .into_iter()
            .next()
            .expect("每一档都同时含官方与镜像两个源")
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use std::path::PathBuf;
    use std::sync::Arc;
    use std::time::Duration;

    use aurora_download::SourceResolver;
    use wiremock::matchers::{header, method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    use super::*;
    use crate::config::AuroraConfig;

    /// 测速样本（版本清单）的路径；两台 mock 只认带 `Range: bytes=0-0` 的探针。
    const SAMPLE_PATH: &str = "/mc/game/version_manifest_v2.json";
    /// 只是兜底，机器再满载也碰不到：这里的用例都不靠超时分出结果。
    const PROBE_TIMEOUT: Duration = Duration::from_secs(30);
    const LONG_TTL: Duration = Duration::from_secs(600);

    /// 官方地址钉到一台 mock、镜像钉到另一台，保留原路径。
    pub(crate) struct Routes {
        pub(crate) official: String,
        pub(crate) mirror: String,
    }

    impl SourceResolver for Routes {
        fn resolve(&self, url: &str, source: MirrorSource) -> aurora_download::Result<String> {
            let (_, rest) = url.split_once("://").expect("测试只解析绝对地址");
            let path = rest.find('/').map_or("/", |at| &rest[at..]);
            let base = match source {
                MirrorSource::Official => &self.official,
                MirrorSource::BmclApi => &self.mirror,
            };
            Ok(format!("{base}{path}"))
        }
    }

    async fn mount_probe(server: &MockServer, response: ResponseTemplate) {
        Mock::given(method("GET"))
            .and(path(SAMPLE_PATH))
            .and(header("range", "bytes=0-0"))
            .respond_with(response)
            .mount(server)
            .await;
    }

    async fn probe_count(server: &MockServer) -> usize {
        server
            .received_requests()
            .await
            .expect("mock 应记录请求")
            .iter()
            .filter(|request| {
                request.url.path() == SAMPLE_PATH
                    && request
                        .headers
                        .get("range")
                        .is_some_and(|value| value.as_bytes() == b"bytes=0-0")
            })
            .count()
    }

    fn routes(official: &MockServer, mirror: &MockServer) -> Arc<Routes> {
        Arc::new(Routes {
            official: official.uri(),
            mirror: mirror.uri(),
        })
    }

    fn aurora_with(
        config: AuroraConfig,
        official: &MockServer,
        mirror: &MockServer,
        ttl: Duration,
    ) -> Aurora {
        let dir = PathBuf::from("/data");
        Aurora::for_test(config, dir.clone(), dir.join(".minecraft")).with_source_routes(
            routes(official, mirror),
            ttl,
            PROBE_TIMEOUT,
        )
    }

    fn aurora_between(
        official: &MockServer,
        mirror: &MockServer,
        policy: DownloadSourcePolicy,
        ttl: Duration,
    ) -> Aurora {
        let config = AuroraConfig {
            download_source: policy,
            version_list_source: policy,
            ..AuroraConfig::default()
        };
        aurora_with(config, official, mirror, ttl)
    }

    fn partial() -> ResponseTemplate {
        ResponseTemplate::new(206).insert_header("content-range", "bytes 0-0/100")
    }

    /// 官方探不通、镜像答得上：自动档测速后镜像在前，下载引擎拿到的方案同序。
    /// 时延谁大谁小的比较由 aurora-download 的测速用例钉住，这里只看结论接到了各处，
    /// 所以让一方探不通，先后不用跟调度抖动赛跑。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn auto_puts_the_mirror_first_when_only_it_answers() {
        let official = MockServer::start().await;
        let mirror = MockServer::start().await;
        mount_probe(&official, ResponseTemplate::new(503)).await;
        mount_probe(&mirror, partial()).await;
        let aurora = aurora_between(&official, &mirror, DownloadSourcePolicy::Auto, LONG_TTL);

        aurora.prepare_sources().await.unwrap();
        let expected = vec![MirrorSource::BmclApi, MirrorSource::Official];
        assert_eq!(aurora.source_order(DownloadSourcePolicy::Auto), expected);
        assert_eq!(aurora.download_config().sources.sources, expected);
        assert_eq!(
            aurora.preferred_source(DownloadSourcePolicy::Auto),
            MirrorSource::BmclApi
        );
        assert_eq!(
            (probe_count(&official).await, probe_count(&mirror).await),
            (1, 1)
        );
    }

    /// 官方答得上、镜像探不通：排在前面的是官方，证明顺序来自实测而不是兜底（兜底是镜像在前）。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn auto_puts_the_official_first_when_only_it_answers() {
        let official = MockServer::start().await;
        let mirror = MockServer::start().await;
        mount_probe(&official, partial()).await;
        mount_probe(&mirror, ResponseTemplate::new(503)).await;
        let aurora = aurora_between(&official, &mirror, DownloadSourcePolicy::Auto, LONG_TTL);

        aurora.prepare_sources().await.unwrap();
        let expected = vec![MirrorSource::Official, MirrorSource::BmclApi];
        assert_eq!(aurora.source_order(DownloadSourcePolicy::Auto), expected);
        assert_eq!(aurora.download_config().sources.sources, expected);
        let first = aurora
            .source_plan(DownloadSourcePolicy::Auto)
            .candidates(aurora_install::VERSION_MANIFEST_V2)
            .unwrap()
            .remove(0);
        assert_eq!(first, format!("{}{SAMPLE_PATH}", official.uri()));
    }

    /// 两个源都测不出：镜像在前，且不写缓存，下一次生成计划时重新探测。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn auto_without_any_answer_falls_back_to_mirror_first_and_retries_later() {
        let official = MockServer::start().await;
        let mirror = MockServer::start().await;
        mount_probe(&official, ResponseTemplate::new(503)).await;
        mount_probe(&mirror, ResponseTemplate::new(503)).await;
        let aurora = aurora_between(&official, &mirror, DownloadSourcePolicy::Auto, LONG_TTL);

        aurora.prepare_sources().await.unwrap();
        assert_eq!(
            aurora.source_order(DownloadSourcePolicy::Auto),
            vec![MirrorSource::BmclApi, MirrorSource::Official]
        );
        aurora.prepare_sources().await.unwrap();
        assert_eq!(
            (probe_count(&official).await, probe_count(&mirror).await),
            (2, 2)
        );
    }

    /// 两项都是固定档时不测速，顺序就是该档的静态顺序。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn fixed_policies_never_probe() {
        for (policy, expected) in [
            (
                DownloadSourcePolicy::OfficialFirst,
                vec![MirrorSource::Official, MirrorSource::BmclApi],
            ),
            (
                DownloadSourcePolicy::MirrorFirst,
                vec![MirrorSource::BmclApi, MirrorSource::Official],
            ),
        ] {
            let official = MockServer::start().await;
            let mirror = MockServer::start().await;
            mount_probe(&official, partial()).await;
            mount_probe(&mirror, partial().set_delay(Duration::from_millis(300))).await;
            let aurora = aurora_between(&official, &mirror, policy, LONG_TTL);

            aurora.prepare_sources().await.unwrap();
            assert_eq!(aurora.source_order(policy), expected, "{policy:?}");
            assert_eq!(
                aurora.download_config().sources.sources,
                expected,
                "{policy:?}"
            );
            assert_eq!(
                (probe_count(&official).await, probe_count(&mirror).await),
                (0, 0),
                "{policy:?}"
            );
        }
    }

    /// 有效期内连续生成两次计划只测一轮；过了有效期再生成就重测。有效期取 0 即测完当场过期，
    /// 两次生成之间隔多久都一样。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn measurement_is_reused_within_ttl_and_redone_after() {
        for (ttl, rounds) in [(LONG_TTL, 1), (Duration::ZERO, 2)] {
            let official = MockServer::start().await;
            let mirror = MockServer::start().await;
            mount_probe(&official, partial()).await;
            mount_probe(&mirror, partial()).await;
            let aurora = aurora_between(&official, &mirror, DownloadSourcePolicy::Auto, ttl);

            aurora.prepare_sources().await.unwrap();
            aurora.prepare_sources().await.unwrap();
            assert_eq!(
                (probe_count(&official).await, probe_count(&mirror).await),
                (rounds, rounds),
                "{ttl:?}"
            );
        }
    }

    /// 实测镜像排在前面（官方探不通）、但它在共享健康表上已经熔断：下载这一个文件时镜像沉底，
    /// 请求只落在官方上。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn tripped_source_sinks_below_the_measured_order() {
        let official = MockServer::start().await;
        let mirror = MockServer::start().await;
        mount_probe(&official, ResponseTemplate::new(503)).await;
        mount_probe(&mirror, partial()).await;
        let file_path = "/com/example/lib/1.0/lib-1.0.jar";
        for server in [&official, &mirror] {
            Mock::given(method("GET"))
                .and(path(file_path))
                .respond_with(ResponseTemplate::new(200).set_body_string("library"))
                .mount(server)
                .await;
        }
        let aurora = aurora_between(&official, &mirror, DownloadSourcePolicy::Auto, LONG_TTL);
        aurora.prepare_sources().await.unwrap();
        assert_eq!(
            aurora.source_order(DownloadSourcePolicy::Auto),
            vec![MirrorSource::BmclApi, MirrorSource::Official]
        );
        let mirror_file = format!("{}{file_path}", mirror.uri());
        for _ in 0..3 {
            aurora.source_health().record_failure(&mirror_file, true);
        }

        let dir = tempfile::tempdir().unwrap();
        let dest = dir.path().join("lib-1.0.jar");
        let task = aurora_download::DownloadTask::new(
            format!("https://libraries.minecraft.net{file_path}"),
            &dest,
        );
        let report = aurora
            .download_pool()
            .download_all(vec![task], None)
            .await
            .unwrap();
        assert!(report.is_success(), "{:?}", report.failures);
        assert_eq!(std::fs::read_to_string(&dest).unwrap(), "library");

        let count = |requests: Vec<wiremock::Request>| {
            requests
                .iter()
                .filter(|request| request.url.path() == file_path)
                .count()
        };
        assert_eq!(count(mirror.received_requests().await.unwrap()), 0);
        assert!(count(official.received_requests().await.unwrap()) >= 1);
    }

    /// 文件下载熔断了镜像后，元数据候选与 Java 清单候选也把它排到后面：线路黑洞时这里每个请求都要先耗掉
    /// 几轮连接超时才换源。
    #[test]
    fn metadata_candidates_sink_a_tripped_source_too() {
        const MANIFEST: &str = "https://piston-meta.mojang.com/mc/game/version_manifest_v2.json";
        const MIRROR: &str = "https://bmclapi2.bangbang93.com/mc/game/version_manifest_v2.json";
        let dir = PathBuf::from("/data");
        let config = AuroraConfig {
            download_source: DownloadSourcePolicy::MirrorFirst,
            ..AuroraConfig::default()
        };
        let aurora = Aurora::for_test(config, dir.clone(), dir.join(".minecraft"));
        let java_candidates = || {
            aurora
                .java_installer(aurora_java::MOJANG_JAVA_RUNTIME_ALL)
                .candidates(aurora_java::MOJANG_JAVA_RUNTIME_ALL)
                .unwrap()
        };
        let plan = aurora.source_plan(DownloadSourcePolicy::MirrorFirst);
        assert_eq!(plan.candidates(MANIFEST).unwrap()[0], MIRROR);
        assert_ne!(java_candidates()[0], aurora_java::MOJANG_JAVA_RUNTIME_ALL);

        for _ in 0..3 {
            aurora.source_health().record_failure(MIRROR, true);
        }

        assert_eq!(plan.candidates(MANIFEST).unwrap()[0], MANIFEST);
        assert_eq!(java_candidates()[0], aurora_java::MOJANG_JAVA_RUNTIME_ALL);
    }

    /// 快照与常驻门面共用同一张健康表：一个任务记下的熔断，别的任务装配的下载池也看得到。
    #[test]
    fn clones_share_one_health_table() {
        let dir = PathBuf::from("/data");
        let aurora = Aurora::for_test(AuroraConfig::default(), dir.clone(), dir.join(".minecraft"));
        let snapshot = aurora
            .clone()
            .with_cancel(aurora_download::CancellationToken::new());
        assert!(Arc::ptr_eq(
            aurora.source_health(),
            snapshot.source_health()
        ));
        let url = "https://bmclapi2.bangbang93.com/maven/a.jar";
        for _ in 0..3 {
            snapshot.source_health().record_failure(url, true);
        }
        assert!(aurora.source_health().is_tripped(url));
        assert!(
            !Aurora::for_test(AuroraConfig::default(), dir.clone(), dir.join(".minecraft"))
                .source_health()
                .is_tripped(url),
            "各自新建的门面不串用"
        );
    }

    /// 测速途中任务被取消：不等探针，立即以取消返回，也不写缓存。两个探针都答不上来，等它们的话
    /// 只会等到超时、按测不出正常返回，下面的 `expect_err` 就过不去。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn cancel_during_measurement_returns_at_once_without_caching() {
        let official = MockServer::start().await;
        let mirror = MockServer::start().await;
        mount_probe(&official, partial().set_delay(PROBE_TIMEOUT * 2)).await;
        mount_probe(&mirror, partial().set_delay(PROBE_TIMEOUT * 2)).await;
        let token = aurora_download::CancellationToken::new();
        let aurora = aurora_between(&official, &mirror, DownloadSourcePolicy::Auto, LONG_TTL)
            .with_cancel(token.clone());
        let cancel_once_probing = async {
            tokio::time::timeout(Duration::from_secs(15), async {
                while probe_count(&official).await + probe_count(&mirror).await < 2 {
                    tokio::time::sleep(Duration::from_millis(5)).await;
                }
            })
            .await
            .expect("15 秒内探针没有发出");
            token.cancel();
        };

        let (measured, ()) = tokio::join!(aurora.prepare_sources(), cancel_once_probing);

        let err = measured.expect_err("取消后不该当作测完返回");
        assert!(err.is_cancelled(), "实际：{err:?}");
        assert!(!aurora.source_speed.is_fresh(), "取消的一轮不留结论");
    }

    /// 只有版本列表源是自动时也要测：版本清单的源顺序同样取自这份结论，文件下载仍按固定档。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn auto_version_list_alone_still_measures() {
        let official = MockServer::start().await;
        let mirror = MockServer::start().await;
        mount_probe(&official, partial()).await;
        mount_probe(&mirror, ResponseTemplate::new(503)).await;
        let config = AuroraConfig {
            download_source: DownloadSourcePolicy::MirrorFirst,
            version_list_source: DownloadSourcePolicy::Auto,
            ..AuroraConfig::default()
        };
        let aurora = aurora_with(config, &official, &mirror, LONG_TTL);

        aurora.prepare_sources().await.unwrap();
        assert_eq!(
            aurora.source_order(DownloadSourcePolicy::Auto),
            vec![MirrorSource::Official, MirrorSource::BmclApi]
        );
        assert_eq!(
            aurora.download_config().sources.sources,
            vec![MirrorSource::BmclApi, MirrorSource::Official]
        );
        assert_eq!(
            (probe_count(&official).await, probe_count(&mirror).await),
            (1, 1)
        );
    }
}
