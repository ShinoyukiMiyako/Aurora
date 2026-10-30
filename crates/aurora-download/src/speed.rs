//! 下载源测速：对各候选源打一次轻量探针，按首字节时间排出先后，并在进程内缓存一段时间。
//!
//! [`SourceSpeedCache`] 只管「测」与「记」，不认识上层的下载源策略：哪些档位需要测速、测不出来时
//! 退回什么顺序（兜底顺序）都由调用方以 `fallback` 传入。

use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::{Duration, Instant};

use aurora_base::mirror::MirrorSource;

use crate::error::Result;
use crate::source::{MirrorResolver, SourceResolver, order_by_latency, probe_latencies};

/// 单个源的探针超时。给一个字节都要三秒的源，排序上让它输就是了，没必要等到 HTTP 客户端的
/// 连接超时。
const PROBE_TIMEOUT: Duration = Duration::from_secs(3);

/// 测速结论的有效期。一次装机短则几分钟长则几十分钟，半小时保证同一次装机只探一轮；再长就会把人
/// 锁在过期结论上（换了网络、镜像临时挂了都属此列）。
const SPEED_TTL: Duration = Duration::from_secs(30 * 60);

/// 下载源测速结论的进程内缓存。
///
/// 刻意不落盘：测速量的是「此刻这条线路」，玩家的网络会换（家宽、校园网、热点、代理），把昨天的
/// 结论读回来复用等于拿一个可能已失效的判断替玩家做决定。重启即重测，成本是一轮几百毫秒的探针。
///
/// 结论失效有三种途径：超过有效期、[`invalidate`](Self::invalidate) 被显式调用、进程退出。
pub struct SourceSpeedCache {
    /// 探针打的样本地址（官方地址，按 `resolver` 解析到各源）。
    sample_url: String,
    resolver: Arc<dyn SourceResolver>,
    ttl: Duration,
    probe_timeout: Duration,
    latest: Mutex<Option<Measurement>>,
    /// 同一时刻只允许一轮探测。装机流程会从多处取顺序，没有这道闸就是同一轮网况被反复打探针。
    probe_gate: tokio::sync::Mutex<()>,
}

/// 一轮至少有一个源回了话的测量。
struct Measurement {
    latencies: Vec<(MirrorSource, Option<Duration>)>,
    taken_at: Instant,
}

impl SourceSpeedCache {
    /// 生产构造：按镜像改写表把 `sample_url` 解析到各源，探针超时 3 秒，结论有效 30 分钟。
    ///
    /// `sample_url` 应选两侧都最热、且在镜像改写表里有对应条目的官方地址（如版本清单）：镜像对
    /// 冷门产物是回源拉取，拿它测出来的是回源耗时而不是线路质量；没有镜像条目的地址在两个源上解析
    /// 成同一个端点，测速就成了自己跟自己比。
    pub fn new(sample_url: impl Into<String>) -> Self {
        Self::with_probe(
            sample_url,
            Arc::new(MirrorResolver),
            SPEED_TTL,
            PROBE_TIMEOUT,
        )
    }

    /// 注入解析器与两个时限构造（测试把各源指向不同的本地服务器）。
    pub fn with_probe(
        sample_url: impl Into<String>,
        resolver: Arc<dyn SourceResolver>,
        ttl: Duration,
        probe_timeout: Duration,
    ) -> Self {
        Self {
            sample_url: sample_url.into(),
            resolver,
            ttl,
            probe_timeout,
            latest: Mutex::new(None),
            probe_gate: tokio::sync::Mutex::new(()),
        }
    }

    /// 当前该用的候选顺序：有未过期且覆盖 `fallback` 全部源的结论，就按实测时延重排 `fallback`；
    /// 否则原样返回 `fallback`。
    ///
    /// 纯读缓存，不发请求：装配下载池是同步路径，不能在这里等网络。
    pub fn order_now(&self, fallback: &[MirrorSource]) -> Vec<MirrorSource> {
        self.fresh_order(fallback)
            .unwrap_or_else(|| fallback.to_vec())
    }

    /// 是否持有未过期的结论。
    pub fn is_fresh(&self) -> bool {
        self.lock()
            .as_ref()
            .is_some_and(|measurement| measurement.taken_at.elapsed() < self.ttl)
    }

    /// 取候选顺序：缓存可用就直接用，否则对 `fallback` 里的源现测一轮并记下结论。
    ///
    /// 有一轮探测在途时，后到的调用等它测完直接用它的结论（最多多等一个探针超时），不叠第二轮。
    /// 探针全部超时或非 2xx 时返回 `fallback` 且不写缓存：那时排出来的只是入参原序，不是测量结果，
    /// 缓存它等于把噪声当结论用半小时。单个源探不通不是错误，它在结果里沉底。
    ///
    /// 返回 `Err` 只有两种情况：样本地址在某个源上解析失败（此时不发任何探针），或探测后台任务
    /// 异常终止。
    pub async fn measured_order(
        &self,
        client: &reqwest::Client,
        fallback: &[MirrorSource],
    ) -> Result<Vec<MirrorSource>> {
        if let Some(order) = self.fresh_order(fallback) {
            return Ok(order);
        }
        let _gate = self.probe_gate.lock().await;
        // 等闸期间前一轮可能已经测完。
        if let Some(order) = self.fresh_order(fallback) {
            return Ok(order);
        }

        let measured = probe_latencies(
            client,
            &self.sample_url,
            fallback,
            self.resolver.as_ref(),
            self.probe_timeout,
        )
        .await?;
        for (source, latency) in &measured {
            match latency {
                Some(rtt) => tracing::debug!(
                    source = source.display_name(),
                    millis = rtt.as_millis() as u64,
                    "下载源探针返回"
                ),
                None => tracing::debug!(source = source.display_name(), "下载源探针超时或失败"),
            }
        }
        if measured.iter().all(|(_, latency)| latency.is_none()) {
            tracing::warn!("所有下载源探针均未返回，本次按兜底顺序下载且不写缓存");
            return Ok(fallback.to_vec());
        }

        let order = order_by_latency(measured.clone());
        *self.lock() = Some(Measurement {
            latencies: measured,
            taken_at: Instant::now(),
        });
        Ok(order)
    }

    /// 丢弃已有结论，下次 [`measured_order`](Self::measured_order) 重测。
    pub fn invalidate(&self) {
        *self.lock() = None;
    }

    /// 用未过期的结论重排 `fallback`；结论过期、缺失或没测过其中某个源时返回 `None`。
    fn fresh_order(&self, fallback: &[MirrorSource]) -> Option<Vec<MirrorSource>> {
        let latest = self.lock();
        let measurement = latest
            .as_ref()
            .filter(|measurement| measurement.taken_at.elapsed() < self.ttl)?;
        let ranked = fallback
            .iter()
            .map(|&source| {
                measurement
                    .latencies
                    .iter()
                    .find(|(measured, _)| *measured == source)
                    .map(|&(_, latency)| (source, latency))
            })
            .collect::<Option<Vec<_>>>()?;
        Some(order_by_latency(ranked))
    }

    fn lock(&self) -> MutexGuard<'_, Option<Measurement>> {
        // 锁内只有整值赋值与查找，不会留下半截状态；别处 panic 毒化了锁，照常读写即可。
        self.latest.lock().unwrap_or_else(PoisonError::into_inner)
    }
}
