//! 启动器自更新的更新包选源：复用「文件下载源」设置，不另设开关。
//!
//! 清单给每个更新包列出一组候选下载源，分国内（cn、hk）与海外（global、github）两组。先后只看源名、不看清单里
//! 怎么写，规范顺序如下：
//! - 尽量镜像：国内在前，即 cn、hk、global、github；
//! - 尽量官方：海外在前，即 global、github、hk、cn。国内组倒过来接在后面，香港离海外网络比杭州近；
//! - 自动：对全部候选并发发一次极小的探测请求，比国内组与海外组各自最快的一个来选上面两种顺序之一；一样快或
//!   全都测不出时国内在前（国内网络连不上海外源的情况远比反过来常见）。测不出的源在选定的顺序里稳定地沉到末尾。
//!   时延只用来判国内还是海外，组内不按快慢重排：一个字节的探测只看得出首包时延，看不出吞吐，组内按固定偏好更稳。

use std::time::{Duration, Instant};

use crate::config::DownloadSourcePolicy;
use crate::facade::Petalfall;

/// 单个源的探测时限。只是为了排个先后，等太久不如直接按国内在前。
pub const UPDATE_PROBE_TIMEOUT: Duration = Duration::from_millis(1500);

/// 更新包下载源所在的网络地区。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SourceRegion {
    /// 国内（cn、hk）。
    Domestic,
    /// 海外（global、github）。
    Overseas,
}

/// 一个候选的更新包下载源。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PackageCandidate {
    /// 源名，写进日志与换源事件。
    pub name: String,
    /// 更新包地址。
    pub url: String,
    /// 所在地区，决定它在哪一组。
    pub region: SourceRegion,
}

/// 按下载源策略给更新包的候选源排序。纯函数。
///
/// `candidates` 的先后无所谓：先按源名排成规范的国内在前顺序（cn、hk、global、github），再分组排定。`probes`
/// 是各候选的探测时延（`None` 为测不出），只在自动档使用，与 `candidates` 等长、按下标一一对应；自动档不给探测
/// 结果时按全都测不出处理。
pub fn order_package_sources(
    policy: DownloadSourcePolicy,
    candidates: Vec<PackageCandidate>,
    probes: Option<&[Option<Duration>]>,
) -> Vec<PackageCandidate> {
    if let Some(probes) = probes {
        assert_eq!(
            probes.len(),
            candidates.len(),
            "探测结果必须与候选源一一对应"
        );
    }
    let latencies: Vec<Option<Duration>> = match (policy, probes) {
        (DownloadSourcePolicy::Auto, Some(probes)) => probes.to_vec(),
        _ => vec![None; candidates.len()],
    };
    let domestic_first = match policy {
        DownloadSourcePolicy::MirrorFirst => true,
        DownloadSourcePolicy::OfficialFirst => false,
        DownloadSourcePolicy::Auto => {
            let fastest = |region: SourceRegion| {
                candidates
                    .iter()
                    .zip(&latencies)
                    .filter(|(candidate, _)| candidate.region == region)
                    .filter_map(|(_, latency)| *latency)
                    .min()
            };
            match (
                fastest(SourceRegion::Domestic),
                fastest(SourceRegion::Overseas),
            ) {
                (Some(domestic), Some(overseas)) => domestic <= overseas,
                (None, Some(_)) => false,
                (Some(_), None) | (None, None) => true,
            }
        }
    };

    let mut paired: Vec<(PackageCandidate, Option<Duration>)> =
        candidates.into_iter().zip(latencies).collect();
    // 清单里 x-sources 的先后谁写都行，CI 与服务器脚本也不校验它；客户端的顺序只认源名，换个写法的清单才不会悄悄
    // 改掉用户选的策略。时延跟着候选一起排，下标对应关系不丢。
    paired.sort_by_key(|(candidate, _)| canonical_rank(&candidate.name));
    let (domestic, overseas): (Vec<_>, Vec<_>) = paired
        .into_iter()
        .partition(|(candidate, _)| candidate.region == SourceRegion::Domestic);
    let mut ordered = if domestic_first {
        domestic.into_iter().chain(overseas).collect::<Vec<_>>()
    } else {
        overseas
            .into_iter()
            .chain(domestic.into_iter().rev())
            .collect::<Vec<_>>()
    };
    // sort_by_key 是稳定排序：测不出的整体沉底，两段各自保持选定的先后。非自动档全是 None，顺序不动。
    ordered.sort_by_key(|(_, latency)| latency.is_none());
    ordered
        .into_iter()
        .map(|(candidate, _)| candidate)
        .collect()
}

/// 源名在国内在前规范顺序里的名次。
fn canonical_rank(name: &str) -> u8 {
    match name {
        "cn" => 0,
        "hk" => 1,
        "global" => 2,
        "github" => 3,
        // 调用方解析清单时就拒掉了不认得的源名，能走到这里的只有清单不给可用源时退回的 default，它总是单独出现。
        // 排在认得的后面、彼此按输入先后（排序是稳定的），不凭空给它定个组内位置。
        _ => 4,
    }
}

impl Petalfall {
    /// 本次下载更新包要依次尝试的源，按「文件下载源」策略排好。
    ///
    /// 自动档并发探测全部候选，每个限时 [`UPDATE_PROBE_TIMEOUT`]；其余两档不探测。只有一个候选时测了也改变不了
    /// 结果，不探测，省得白等一个时限。
    pub async fn package_sources(
        &self,
        candidates: Vec<PackageCandidate>,
    ) -> Vec<PackageCandidate> {
        let policy = self.config().download_source;
        let probes = match policy {
            DownloadSourcePolicy::Auto if candidates.len() > 1 => {
                Some(probe_all(&self.http(), &candidates).await)
            }
            _ => None,
        };
        let ordered = order_package_sources(policy, candidates, probes.as_deref());
        tracing::info!(
            ?policy,
            ?probes,
            order = ?ordered.iter().map(|c| c.name.as_str()).collect::<Vec<_>>(),
            "更新包下载源已排序"
        );
        ordered
    }
}

/// 并发探测每个候选，结果与 `candidates` 一一对应。探测任务异常结束的按测不出处理。
async fn probe_all(
    http: &reqwest::Client,
    candidates: &[PackageCandidate],
) -> Vec<Option<Duration>> {
    let mut tasks = tokio::task::JoinSet::new();
    for (index, candidate) in candidates.iter().enumerate() {
        let http = http.clone();
        let url = candidate.url.clone();
        tasks.spawn(async move { (index, probe_latency(&http, &url).await) });
    }
    let mut probes = vec![None; candidates.len()];
    while let Some(joined) = tasks.join_next().await {
        match joined {
            Ok((index, latency)) => probes[index] = latency,
            Err(join) => {
                tracing::warn!(error = %join, "更新包下载源探测任务异常结束，按测不出处理");
            }
        }
    }
    probes
}

/// 只要首字节的 Range 请求，成功（2xx）记时延，失败或超时记 `None`。
async fn probe_latency(http: &reqwest::Client, url: &str) -> Option<Duration> {
    let started = Instant::now();
    let response = http
        .get(url)
        .header(reqwest::header::RANGE, "bytes=0-0")
        .timeout(UPDATE_PROBE_TIMEOUT)
        .send()
        .await;
    match response {
        Ok(resp) if resp.status().is_success() => Some(started.elapsed()),
        Ok(resp) => {
            tracing::info!(url, status = %resp.status(), "更新源探测返回非 2xx");
            None
        }
        Err(err) => {
            tracing::info!(url, error = %err, "更新源探测失败");
            None
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::PetalfallConfig;
    use SourceRegion::{Domestic, Overseas};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use wiremock::matchers::{method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    const FAST: Option<Duration> = Some(Duration::from_millis(40));
    const QUICK: Option<Duration> = Some(Duration::from_millis(90));
    const SLOW: Option<Duration> = Some(Duration::from_millis(400));
    const SLOWER: Option<Duration> = Some(Duration::from_millis(900));

    fn candidate(name: &str, region: SourceRegion) -> PackageCandidate {
        PackageCandidate {
            name: name.to_owned(),
            url: format!("https://example.invalid/{name}/pkg.exe"),
            region,
        }
    }

    /// 规范的国内在前顺序的全部四个源。
    fn all_four() -> Vec<PackageCandidate> {
        vec![
            candidate("cn", Domestic),
            candidate("hk", Domestic),
            candidate("global", Overseas),
            candidate("github", Overseas),
        ]
    }

    fn names(ordered: &[PackageCandidate]) -> Vec<&str> {
        ordered.iter().map(|c| c.name.as_str()).collect()
    }

    fn auto(candidates: Vec<PackageCandidate>, probes: &[Option<Duration>]) -> Vec<String> {
        order_package_sources(DownloadSourcePolicy::Auto, candidates, Some(probes))
            .into_iter()
            .map(|c| c.name)
            .collect()
    }

    #[test]
    fn fixed_policies_ignore_probes() {
        let domestic_fast = [FAST, FAST, SLOW, None];
        let overseas_fast = [SLOW, None, FAST, FAST];
        for probes in [None, Some(&domestic_fast[..]), Some(&overseas_fast[..])] {
            assert_eq!(
                names(&order_package_sources(
                    DownloadSourcePolicy::MirrorFirst,
                    all_four(),
                    probes
                )),
                ["cn", "hk", "global", "github"],
                "尽量镜像是国内在前，不看测速、测不出的也不沉底"
            );
            assert_eq!(
                names(&order_package_sources(
                    DownloadSourcePolicy::OfficialFirst,
                    all_four(),
                    probes
                )),
                ["global", "github", "hk", "cn"],
                "尽量官方是海外按原序、接国内的逆序"
            );
        }
    }

    #[test]
    fn auto_picks_the_group_with_the_fastest_source() {
        assert_eq!(
            auto(all_four(), &[FAST, SLOW, SLOW, SLOWER]),
            ["cn", "hk", "global", "github"],
            "国内快"
        );
        assert_eq!(
            auto(all_four(), &[SLOW, FAST, SLOWER, QUICK]),
            ["cn", "hk", "global", "github"],
            "国内快；hk 比 cn 快、github 比 global 快都不改组内先后"
        );
        assert_eq!(
            auto(all_four(), &[SLOW, SLOWER, QUICK, FAST]),
            ["global", "github", "hk", "cn"],
            "海外快；github 比 global 快、cn 比 hk 快都不改组内先后"
        );
        assert_eq!(
            auto(all_four(), &[SLOWER, QUICK, QUICK, SLOW]),
            ["cn", "hk", "global", "github"],
            "两组最快的一样快时国内在前"
        );
        assert_eq!(
            auto(all_four(), &[None, None, None, None]),
            ["cn", "hk", "global", "github"],
            "全都测不出时国内在前"
        );
        assert_eq!(
            names(&order_package_sources(
                DownloadSourcePolicy::Auto,
                all_four(),
                None
            )),
            ["cn", "hk", "global", "github"],
            "自动档没给探测结果按全都测不出"
        );
    }

    #[test]
    fn auto_sinks_unmeasured_sources_keeping_their_order() {
        assert_eq!(
            auto(all_four(), &[None, SLOW, QUICK, None]),
            ["global", "hk", "github", "cn"],
            "海外在前时测不出的 github、cn 按选定顺序沉底"
        );
        assert_eq!(
            auto(all_four(), &[None, FAST, None, SLOW]),
            ["hk", "github", "cn", "global"],
            "国内在前时测不出的 cn、global 按选定顺序沉底"
        );
        assert_eq!(
            auto(all_four(), &[None, None, None, SLOWER]),
            ["github", "global", "hk", "cn"],
            "国内全测不出时海外哪怕慢也在前"
        );
        assert_eq!(
            auto(all_four(), &[None, SLOWER, None, None]),
            ["hk", "cn", "global", "github"],
            "海外全测不出时国内在前"
        );
    }

    #[test]
    fn partial_candidate_lists_follow_the_same_rules() {
        let no_github = || {
            vec![
                candidate("cn", Domestic),
                candidate("hk", Domestic),
                candidate("global", Overseas),
            ]
        };
        assert_eq!(
            names(&order_package_sources(
                DownloadSourcePolicy::OfficialFirst,
                no_github(),
                None
            )),
            ["global", "hk", "cn"]
        );
        assert_eq!(
            names(&order_package_sources(
                DownloadSourcePolicy::MirrorFirst,
                no_github(),
                None
            )),
            ["cn", "hk", "global"]
        );
        assert_eq!(
            auto(no_github(), &[SLOW, SLOWER, FAST]),
            ["global", "hk", "cn"]
        );
        assert_eq!(
            auto(no_github(), &[None, SLOW, SLOW]),
            ["hk", "global", "cn"]
        );

        let domestic_only = || vec![candidate("cn", Domestic), candidate("hk", Domestic)];
        assert_eq!(
            names(&order_package_sources(
                DownloadSourcePolicy::OfficialFirst,
                domestic_only(),
                None
            )),
            ["hk", "cn"],
            "没有海外源时尽量官方只剩国内组的逆序"
        );
        assert_eq!(auto(domestic_only(), &[None, FAST]), ["hk", "cn"]);

        let overseas_only = || vec![candidate("global", Overseas), candidate("github", Overseas)];
        for policy in [
            DownloadSourcePolicy::OfficialFirst,
            DownloadSourcePolicy::MirrorFirst,
        ] {
            assert_eq!(
                names(&order_package_sources(policy, overseas_only(), None)),
                ["global", "github"]
            );
        }
        assert_eq!(auto(overseas_only(), &[None, SLOW]), ["github", "global"]);

        let fallback = || vec![candidate("default", Domestic)];
        for policy in [
            DownloadSourcePolicy::Auto,
            DownloadSourcePolicy::OfficialFirst,
            DownloadSourcePolicy::MirrorFirst,
        ] {
            assert_eq!(
                names(&order_package_sources(
                    policy,
                    fallback(),
                    Some(&[None][..])
                )),
                ["default"]
            );
        }
    }

    fn named(name: &str) -> PackageCandidate {
        let region = if matches!(name, "cn" | "hk") {
            Domestic
        } else {
            Overseas
        };
        candidate(name, region)
    }

    fn permutations(names: &[&'static str]) -> Vec<Vec<&'static str>> {
        if names.len() <= 1 {
            return vec![names.to_vec()];
        }
        let mut all = Vec::new();
        for (index, first) in names.iter().enumerate() {
            let mut rest = names.to_vec();
            rest.remove(index);
            for mut tail in permutations(&rest) {
                tail.insert(0, *first);
                all.push(tail);
            }
        }
        all
    }

    /// 清单里 x-sources 怎么排都不影响结果：穷举全部排列，三档都只按源名落到设计的两种规范顺序上，探测时延
    /// 跟着各自的源走，不跟着下标走。
    #[test]
    fn listed_order_does_not_change_the_result() {
        let all = permutations(&["cn", "hk", "global", "github"]);
        assert_eq!(all.len(), 24);
        for listed in all {
            let candidates = || listed.iter().map(|name| named(name)).collect::<Vec<_>>();
            // 时延按源名给出，再摆到这次清单里各自的下标上。
            let probes = |by_name: [(&str, Option<Duration>); 4]| {
                listed
                    .iter()
                    .map(|name| by_name.iter().find(|(known, _)| known == name).unwrap().1)
                    .collect::<Vec<_>>()
            };
            assert_eq!(
                names(&order_package_sources(
                    DownloadSourcePolicy::MirrorFirst,
                    candidates(),
                    None
                )),
                ["cn", "hk", "global", "github"],
                "{listed:?}"
            );
            assert_eq!(
                names(&order_package_sources(
                    DownloadSourcePolicy::OfficialFirst,
                    candidates(),
                    None
                )),
                ["global", "github", "hk", "cn"],
                "{listed:?}"
            );
            assert_eq!(
                auto(
                    candidates(),
                    &probes([
                        ("cn", SLOW),
                        ("hk", FAST),
                        ("global", SLOWER),
                        ("github", QUICK)
                    ])
                ),
                ["cn", "hk", "global", "github"],
                "国内快，{listed:?}"
            );
            assert_eq!(
                auto(
                    candidates(),
                    &probes([
                        ("cn", SLOW),
                        ("hk", SLOWER),
                        ("global", QUICK),
                        ("github", FAST)
                    ])
                ),
                ["global", "github", "hk", "cn"],
                "海外快，{listed:?}"
            );
            assert_eq!(
                auto(
                    candidates(),
                    &probes([
                        ("cn", None),
                        ("hk", SLOW),
                        ("global", QUICK),
                        ("github", None)
                    ])
                ),
                ["global", "hk", "github", "cn"],
                "测不出的 github、cn 按规范顺序沉底，{listed:?}"
            );
        }

        for listed in permutations(&["cn", "hk", "global"]) {
            let candidates = || listed.iter().map(|name| named(name)).collect::<Vec<_>>();
            assert_eq!(
                names(&order_package_sources(
                    DownloadSourcePolicy::MirrorFirst,
                    candidates(),
                    None
                )),
                ["cn", "hk", "global"],
                "{listed:?}"
            );
            assert_eq!(
                names(&order_package_sources(
                    DownloadSourcePolicy::OfficialFirst,
                    candidates(),
                    None
                )),
                ["global", "hk", "cn"],
                "{listed:?}"
            );
        }
    }

    #[test]
    #[should_panic(expected = "探测结果必须与候选源一一对应")]
    fn probes_must_match_candidates() {
        order_package_sources(DownloadSourcePolicy::Auto, all_four(), Some(&[FAST][..]));
    }

    fn petalfall_with(policy: DownloadSourcePolicy) -> Petalfall {
        let config = PetalfallConfig {
            download_source: policy,
            ..PetalfallConfig::default()
        };
        let dir = std::env::temp_dir();
        Petalfall::for_test(config, dir.clone(), dir.join(".minecraft"))
    }

    fn closed_port_url() -> String {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        drop(listener);
        format!("http://127.0.0.1:{port}/pkg.exe")
    }

    fn at(name: &str, region: SourceRegion, url: String) -> PackageCandidate {
        PackageCandidate {
            name: name.to_owned(),
            url,
            region,
        }
    }

    async fn probed_paths(server: &MockServer) -> Vec<String> {
        let requests = server.received_requests().await.unwrap();
        assert!(
            requests.iter().all(|r| {
                r.headers
                    .get("range")
                    .is_some_and(|range| range.as_bytes() == b"bytes=0-0")
            }),
            "探测只要首字节"
        );
        let mut paths: Vec<String> = requests.iter().map(|r| r.url.path().to_owned()).collect();
        paths.sort();
        paths
    }

    /// 自动档真去探测：探得通（206）的源决定选哪组，连不上的、回非 2xx 的与拖过时限的沉底；换成固定档就不再探测。
    /// 测不出的一方用连不上、回 503 与拖过探测时限造，不比几百毫秒的快慢：那点差值在机器满载时会被调度抖动吃掉。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn auto_policy_probes_every_candidate_and_fixed_policies_do_not() {
        let stall = UPDATE_PROBE_TIMEOUT + Duration::from_secs(1);
        let server = MockServer::start().await;
        for (route, status, delay) in [
            ("/cn/pkg.exe", 503, Duration::ZERO),
            ("/hk/pkg.exe", 206, Duration::ZERO),
            ("/global/pkg.exe", 503, Duration::ZERO),
            ("/github/pkg.exe", 206, Duration::ZERO),
            ("/stalled/pkg.exe", 206, stall),
        ] {
            Mock::given(method("GET"))
                .and(path(route))
                .respond_with(ResponseTemplate::new(status).set_delay(delay))
                .mount(&server)
                .await;
        }
        let served = |name: &str| format!("{}/{name}/pkg.exe", server.uri());

        // 只有 hk 探得通：国内在前，hk 越过连不上的 cn 排到第一，测不出的三个按原先后跟在后面
        let domestic_reachable = vec![
            at("cn", Domestic, closed_port_url()),
            at("hk", Domestic, served("hk")),
            at("global", Overseas, served("global")),
            at("github", Overseas, closed_port_url()),
        ];
        let ordered = petalfall_with(DownloadSourcePolicy::Auto)
            .package_sources(domestic_reachable.clone())
            .await;
        assert_eq!(names(&ordered), ["hk", "cn", "global", "github"]);
        assert_eq!(
            probed_paths(&server).await,
            ["/global/pkg.exe", "/hk/pkg.exe"]
        );

        // 只有 github 探得通：海外在前，github 越过拖过时限的 global 排到第一。探测不限时的话 global 迟早回 206、
        // 算测得出，就还排在 github 前面
        let overseas_reachable = vec![
            at("cn", Domestic, served("cn")),
            at("hk", Domestic, closed_port_url()),
            at("global", Overseas, served("stalled")),
            at("github", Overseas, served("github")),
        ];
        let ordered = petalfall_with(DownloadSourcePolicy::Auto)
            .package_sources(overseas_reachable)
            .await;
        assert_eq!(names(&ordered), ["github", "global", "hk", "cn"]);
        assert_eq!(
            probed_paths(&server).await,
            [
                "/cn/pkg.exe",
                "/github/pkg.exe",
                "/global/pkg.exe",
                "/hk/pkg.exe",
                "/stalled/pkg.exe"
            ]
        );

        let fixed = petalfall_with(DownloadSourcePolicy::OfficialFirst)
            .package_sources(domestic_reachable.clone())
            .await;
        assert_eq!(names(&fixed), ["global", "github", "hk", "cn"]);
        let fixed = petalfall_with(DownloadSourcePolicy::MirrorFirst)
            .package_sources(domestic_reachable)
            .await;
        assert_eq!(names(&fixed), ["cn", "hk", "global", "github"]);
        assert_eq!(
            server.received_requests().await.unwrap().len(),
            5,
            "固定档不探测"
        );

        let only = petalfall_with(DownloadSourcePolicy::Auto)
            .package_sources(vec![at("default", Domestic, served("hk"))])
            .await;
        assert_eq!(names(&only), ["default"]);
        assert_eq!(
            server.received_requests().await.unwrap().len(),
            5,
            "只有一个候选时不探测"
        );
    }

    /// 读到请求头结束为止。
    async fn read_head(stream: &mut tokio::net::TcpStream) -> String {
        let mut head = Vec::new();
        let mut buf = [0u8; 1024];
        while !head.windows(4).any(|w| w == b"\r\n\r\n") {
            let read = stream.read(&mut buf).await.unwrap();
            assert!(read > 0, "请求头没读完连接就断了");
            head.extend_from_slice(&buf[..read]);
        }
        String::from_utf8(head).unwrap()
    }

    /// 探测是并发发出的：服务端收齐全部连接才一起回应。要是一个接一个地探，先发的那个等不到回应、超时测不出，
    /// 后面的才连得上，结果里必有 `None`。用显式的「收齐」做信号，不比耗时。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn probes_run_concurrently() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let candidates = vec![
            at("cn", Domestic, format!("{base}/cn/pkg.exe")),
            at("hk", Domestic, format!("{base}/hk/pkg.exe")),
            at("global", Overseas, format!("{base}/global/pkg.exe")),
        ];
        let expected = candidates.len();
        let server = tokio::spawn(async move {
            let mut waiting = Vec::new();
            let mut heads = Vec::new();
            while waiting.len() < expected {
                let (mut stream, _) = listener.accept().await.unwrap();
                heads.push(read_head(&mut stream).await);
                waiting.push(stream);
            }
            for mut stream in waiting {
                // 串行探测时先连上的那个早已超时断开，写失败在意料之中，结论看客户端测没测出
                let _ = stream
                    .write_all(
                        b"HTTP/1.1 206 Partial Content\r\nContent-Range: bytes 0-0/1\r\n\
                          Content-Length: 1\r\n\r\nx",
                    )
                    .await;
            }
            heads
        });

        let http = petalfall_base::http::build_client().unwrap();
        let probes = probe_all(&http, &candidates).await;
        assert!(probes.iter().all(Option::is_some), "{probes:?}");

        let heads = server.await.unwrap();
        let mut lines: Vec<String> = heads
            .iter()
            .map(|head| head.lines().next().unwrap().to_owned())
            .collect();
        lines.sort();
        assert_eq!(
            lines,
            [
                "GET /cn/pkg.exe HTTP/1.1",
                "GET /global/pkg.exe HTTP/1.1",
                "GET /hk/pkg.exe HTTP/1.1"
            ]
        );
        assert!(
            heads.iter().all(|head| head
                .to_ascii_lowercase()
                .contains("\r\nrange: bytes=0-0\r\n")),
            "{heads:?}"
        );
    }
}
