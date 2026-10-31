//! 下载源健康状态：让「这个源现在不通」的结论只付一次学费。
//!
//! 引擎按候选列表逐源尝试，每个源要把退避重试跑满才切下一个。一批任务共用同一组候选时，
//! 第一个文件已经证明某个源不可用，后面每个文件仍会各自把那一轮重试与退避重新赔一遍。
//! 实测镜像线路不通时，262 个文件各赔一轮，安装卡了 13 分钟——换源本身是好的，代价全花在
//! 「每个文件重新发现同一件事」上。
//!
//! 这里按「主机:端口」记连续失败：达到阈值即熔断一段时间，熔断期间该主机的候选被排到列表末尾。
//! 是排到末尾而不是剔除——所有源都熔断时仍得有东西可试，宁可慢也不能判定装不上。
//! 任何一次成功立即清零，冷却到期后自动放行一次试探，成功即完全恢复。
//!
//! 只有「源本身不健康」才计数：404 这类是「该源没有这个文件」，切源即可，把它算作主机故障会
//! 误伤好源——镜像对个别冷门产物返回 404 时，它对其余路径往往是正常的。

use std::collections::HashMap;
use std::sync::{Mutex, MutexGuard, PoisonError};
use std::time::{Duration, Instant};

/// 连续失败多少次判定该主机不可用。
const DEFAULT_TRIP_THRESHOLD: u32 = 3;
/// 熔断后多久放行一次试探。
const DEFAULT_COOLDOWN: Duration = Duration::from_secs(60);

/// 单个主机的健康记录。
#[derive(Debug, Default, Clone)]
struct HostState {
    consecutive_failures: u32,
    /// 熔断截止时刻；`None` 表示未熔断。
    tripped_until: Option<Instant>,
}

/// 跨任务共享的下载源健康表。内部自带锁，以 `Arc` 共享给并发池里的所有任务，共用一份结论。
#[derive(Debug)]
pub struct SourceHealth {
    hosts: Mutex<HashMap<String, HostState>>,
    threshold: u32,
    cooldown: Duration,
}

impl Default for SourceHealth {
    fn default() -> Self {
        Self::new()
    }
}

impl SourceHealth {
    /// 用默认阈值（连续 3 次失败熔断 60 秒）构造。
    pub fn new() -> Self {
        Self::with_policy(DEFAULT_TRIP_THRESHOLD, DEFAULT_COOLDOWN)
    }

    /// 自定义阈值与冷却时长。阈值为 0 视作 1：至少要有一次失败才谈得上熔断。
    pub fn with_policy(threshold: u32, cooldown: Duration) -> Self {
        Self {
            hosts: Mutex::new(HashMap::new()),
            threshold: threshold.max(1),
            cooldown,
        }
    }

    /// 把候选按健康度稳定重排：熔断中的主机沉底，其余保持调用方给定的优先级。
    ///
    /// 稳定性很重要——同为健康或同为熔断的源之间，原有优先级（策略顺序、测速结论）必须原样
    /// 保留，这里只负责把已知不通的挪后。
    pub fn prioritize(&self, candidates: Vec<String>) -> Vec<String> {
        self.prioritize_at(candidates, Instant::now())
    }

    fn prioritize_at(&self, candidates: Vec<String>, now: Instant) -> Vec<String> {
        if candidates.len() < 2 {
            return candidates;
        }
        let hosts = self.lock();
        let tripped = |url: &String| -> bool {
            host_of(url)
                .and_then(|host| hosts.get(&host))
                .and_then(|state| state.tripped_until)
                .is_some_and(|until| until > now)
        };
        if !candidates.iter().any(tripped) {
            return candidates;
        }
        let (healthy, sunk): (Vec<String>, Vec<String>) =
            candidates.into_iter().partition(|url| !tripped(url));
        healthy.into_iter().chain(sunk).collect()
    }

    /// 上报一次成功：该主机立即恢复，之前累计的失败一笔勾销。
    pub fn record_success(&self, url: &str) {
        let Some(host) = host_of(url) else { return };
        self.lock().remove(&host);
    }

    /// 上报一次失败。`fault` 为 false 时（如 404）只切源、不计入主机故障。
    pub fn record_failure(&self, url: &str, fault: bool) {
        self.record_failure_at(url, fault, Instant::now());
    }

    fn record_failure_at(&self, url: &str, fault: bool, now: Instant) {
        if !fault {
            return;
        }
        let Some(host) = host_of(url) else { return };
        let mut hosts = self.lock();
        let state = hosts.entry(host).or_default();
        state.consecutive_failures = state.consecutive_failures.saturating_add(1);
        if state.consecutive_failures >= self.threshold {
            // 冷却从最近一次失败起算：熔断期内又撞上失败（半开试探失败）就顺延，
            // 免得刚放行就再赔一轮。
            state.tripped_until = Some(now + self.cooldown);
        }
    }

    /// 该 URL 所属主机当前是否处于熔断。用于观测与测试。
    pub fn is_tripped(&self, url: &str) -> bool {
        let now = Instant::now();
        host_of(url)
            .and_then(|host| self.lock().get(&host).and_then(|state| state.tripped_until))
            .is_some_and(|until| until > now)
    }

    /// 锁内只有查表与整字段赋值，不存在写到一半的中间态；中毒只说明别的线程在持锁时 panic 了，
    /// 表本身仍然一致，继续用它比让每个下载任务跟着 panic 更合理。
    fn lock(&self) -> MutexGuard<'_, HashMap<String, HostState>> {
        self.hosts.lock().unwrap_or_else(PoisonError::into_inner)
    }
}

/// 错误是否应记在主机头上。
///
/// 4xx 表示「这个源对这个文件说不」——文件不存在、被拒、路径不对，换个源多半就有了，
/// 但不说明该主机整体不可用。例外是 408/429：那是主机在喊「我扛不住」，属于主机侧状态。
/// 传输层失败（无状态码）与 5xx 一律计入。
pub fn is_host_fault(status: Option<u16>) -> bool {
    match status {
        Some(408) | Some(429) => true,
        Some(code) if (400..500).contains(&code) => false,
        _ => true,
    }
}

/// 从 URL 取「主机:端口」作为记账键。解析不了就返回 `None`，调用方按「不记账」处理。
///
/// 带上端口是因为同一主机的不同端口是不同的服务实例，健康状况彼此独立，混在一起会让
/// 一边的成功替另一边把失败清账。端口取 `port_or_known_default`，这样 `https://a.com`
/// 与 `https://a.com:443` 仍归一到同一个键，不会因写法不同被拆成两份。
fn host_of(url: &str) -> Option<String> {
    let parsed = reqwest::Url::parse(url).ok()?;
    let host = parsed.host_str()?.to_ascii_lowercase();
    Some(match parsed.port_or_known_default() {
        Some(port) => format!("{host}:{port}"),
        None => host,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const A: &str = "https://bmclapi2.bangbang93.com/assets/aa/aaaa";
    const A2: &str = "https://bmclapi2.bangbang93.com/maven/x/y.jar";
    const B: &str = "https://resources.download.minecraft.net/aa/aaaa";

    fn health() -> SourceHealth {
        SourceHealth::with_policy(3, Duration::from_secs(60))
    }

    #[test]
    fn healthy_candidates_keep_original_order() {
        let h = health();
        let got = h.prioritize(vec![A.into(), B.into()]);
        assert_eq!(got, vec![A.to_string(), B.to_string()]);
    }

    #[test]
    fn host_sinks_after_threshold_failures() {
        let h = health();
        for _ in 0..3 {
            h.record_failure(A, true);
        }
        assert!(h.is_tripped(A), "连续 3 次故障应触发熔断");
        // 同主机的另一条路径也一并沉底：熔断按主机而非 URL。
        assert!(h.is_tripped(A2));

        let got = h.prioritize(vec![A.into(), B.into()]);
        assert_eq!(got, vec![B.to_string(), A.to_string()], "坏源应沉到末尾");
    }

    #[test]
    fn below_threshold_does_not_trip() {
        let h = health();
        h.record_failure(A, true);
        h.record_failure(A, true);
        assert!(!h.is_tripped(A), "差一次不该熔断");
        assert_eq!(
            h.prioritize(vec![A.into(), B.into()]),
            vec![A.to_string(), B.to_string()]
        );
    }

    #[test]
    fn success_clears_accumulated_failures() {
        let h = health();
        h.record_failure(A, true);
        h.record_failure(A, true);
        h.record_success(A);
        h.record_failure(A, true);
        h.record_failure(A, true);
        assert!(!h.is_tripped(A), "成功后计数应清零，不该被旧账推过阈值");
    }

    #[test]
    fn not_found_never_counts_as_host_fault() {
        let h = health();
        for _ in 0..10 {
            h.record_failure(A, is_host_fault(Some(404)));
        }
        assert!(!h.is_tripped(A));
    }

    #[test]
    fn fault_classification_matches_semantics() {
        assert!(is_host_fault(None), "传输层失败没有状态码，算主机故障");
        assert!(is_host_fault(Some(500)));
        assert!(is_host_fault(Some(503)));
        assert!(is_host_fault(Some(408)), "请求超时是主机侧状态");
        assert!(is_host_fault(Some(429)), "限流是主机在喊扛不住");
        assert!(!is_host_fault(Some(404)));
        assert!(!is_host_fault(Some(403)));
        assert!(!is_host_fault(Some(400)));
        assert!(!is_host_fault(Some(499)), "4xx 区间上界同样不计入");
    }

    #[test]
    fn cooldown_expiry_restores_priority() {
        let h = SourceHealth::with_policy(2, Duration::from_secs(60));
        let start = Instant::now();
        h.record_failure_at(A, true, start);
        h.record_failure_at(A, true, start);

        let during = start + Duration::from_secs(59);
        assert_eq!(
            h.prioritize_at(vec![A.into(), B.into()], during),
            vec![B.to_string(), A.to_string()],
            "冷却期内应沉底"
        );
        let after = start + Duration::from_secs(61);
        assert_eq!(
            h.prioritize_at(vec![A.into(), B.into()], after),
            vec![A.to_string(), B.to_string()],
            "冷却到期应回到原优先级"
        );
    }

    #[test]
    fn failure_during_cooldown_extends_the_trip() {
        let h = SourceHealth::with_policy(1, Duration::from_secs(60));
        let start = Instant::now();
        h.record_failure_at(A, true, start);
        // 放行试探前又失败一次：冷却从这一次重新起算。
        h.record_failure_at(A, true, start + Duration::from_secs(50));
        let probe = start + Duration::from_secs(70);
        assert_eq!(
            h.prioritize_at(vec![A.into(), B.into()], probe),
            vec![B.to_string(), A.to_string()],
            "顺延后 70 s 时仍应在熔断期内"
        );
    }

    #[test]
    fn all_tripped_still_yields_every_candidate() {
        let h = SourceHealth::with_policy(1, Duration::from_secs(60));
        h.record_failure(A, true);
        h.record_failure(B, true);

        let got = h.prioritize(vec![A.into(), B.into()]);
        assert_eq!(
            got,
            vec![A.to_string(), B.to_string()],
            "全员熔断也不能剔除候选，且彼此保持原序"
        );
    }

    #[test]
    fn single_candidate_is_returned_as_is() {
        let h = SourceHealth::with_policy(1, Duration::from_secs(60));
        h.record_failure(A, true);
        assert_eq!(h.prioritize(vec![A.into()]), vec![A.to_string()]);
    }

    #[test]
    fn unparsable_url_is_ignored_rather_than_panicking() {
        let h = health();
        for _ in 0..5 {
            h.record_failure("not a url", true);
        }
        h.record_success("not a url");
        assert_eq!(
            h.prioritize(vec!["not a url".into(), B.into()]),
            vec!["not a url".to_string(), B.to_string()]
        );
    }

    #[test]
    fn explicit_default_port_and_case_map_to_the_same_key() {
        let h = SourceHealth::with_policy(2, Duration::from_secs(60));
        h.record_failure("https://Example.COM:443/a", true);
        h.record_failure("https://example.com/b", true);
        assert!(
            h.is_tripped("https://example.com/c"),
            "大小写与显式默认端口不该把同一个服务拆成两份"
        );
    }

    #[test]
    fn different_ports_are_independent_services() {
        let h = SourceHealth::with_policy(2, Duration::from_secs(60));
        h.record_failure("http://127.0.0.1:8081/x", true);
        h.record_failure("http://127.0.0.1:8081/y", true);
        assert!(h.is_tripped("http://127.0.0.1:8081/z"));
        assert!(
            !h.is_tripped("http://127.0.0.1:8082/z"),
            "另一个端口不该被牵连"
        );

        h.record_success("http://127.0.0.1:8082/ok");
        assert!(
            h.is_tripped("http://127.0.0.1:8081/z"),
            "别处的成功不该清掉这里的账"
        );
    }
}
