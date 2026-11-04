//! 吞吐看门狗：大文件下载中途变慢时，判定当前下载终点不值得再等。
//!
//! HTTP 客户端只有连接超时与读间隔超时，一个每秒只吐几 KB 的终点永远触发不了它们，一个几十 MB
//! 的文件能被拖上几个小时。BMCLAPI 这类分发入口每次请求都会跳到不同的节点，换一个节点往往立刻
//! 恢复正常速度，所以值得盯着吞吐：最近一个窗口的平均速度低于阈值就放弃当前终点，由引擎向原地址
//! 重新要一个终点接着续传。
//!
//! 低于阈值不一定是终点的错：一批几十个文件同时下时，带宽被大家分走，每个文件分到的速度都可能
//! 低于阈值。这时放弃终点只会白丢在途分片，还把正常的主机记成故障，最后全落到恰恰更慢的源上。
//! 所以 `LinkMeter` 记下整条链路的总字节与连接数，判慢前先分清这笔账算谁的（见 `Tally::blame`）。
//!
//! 只盯声明大小超过 [`WATCHDOG_MIN_FILE_SIZE`] 的文件：小文件一个往返就下完了，窗口都攒不满，
//! 判慢只会白白多发请求。大小未知的文件同样不盯，因为无法排除它是小文件。

use std::collections::VecDeque;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, OnceLock};
use std::time::{Duration, Instant};

use tokio::time::MissedTickBehavior;
use tokio_util::sync::CancellationToken;

use crate::progress::FileProgress;

/// 只看声明大小严格大于这个值的文件。
pub const WATCHDOG_MIN_FILE_SIZE: u64 = 1 << 20;

/// 单条传输的判慢阈值，字节/秒。取得很低：独占线路时正常速度比它快两个数量级，低于它说明终点几乎
/// 不在送数据，宁可漏判也不误伤只是偏慢的终点（误判的代价是丢掉在途分片重下）。并发分摊时单条低于它
/// 很常见，所以它只是判慢的必要条件，见 [`LINK_FLOOR_BYTES_PER_SEC`]。
pub const SLOW_BYTES_PER_SEC: u64 = 32 * 1024;

/// 总速率低于它才算链路确实带不动，字节/秒（约 1 Mbit/s）。默认 64 并发时总速率约 2 MiB/s 就会把
/// 每条摊到单条阈值以下，这里取得比那低一个数量级：带宽被摊薄是常态，只有总量也见底才值得折腾。
pub const LINK_FLOOR_BYTES_PER_SEC: u64 = 128 * 1024;

/// 平均速度的观察窗口。足够长，抹平 TCP 慢启动与偶发的几秒卡顿；又远短于读间隔超时之后
/// 那种分钟级的拖延。
pub const SLOW_WINDOW: Duration = Duration::from_secs(15);

/// 采样间隔。
pub const WATCHDOG_TICK: Duration = Duration::from_secs(1);

/// 每个源、每次尝试最多换几次终点。再换不好多半是源整体慢，交给换源。
pub const MAX_ENDPOINT_SWITCHES: u32 = 2;

/// 吞吐看门狗的参数。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct WatchdogConfig {
    /// 总开关。
    pub enabled: bool,
    /// 只看声明大小严格大于它的文件。
    pub min_file_size: u64,
    /// 窗口平均速度严格低于它才可能判慢，字节/秒。
    pub min_bytes_per_sec: u64,
    /// 总速率严格低于它算链路确实带不动，字节/秒。
    pub link_floor_bytes_per_sec: u64,
    /// 平均速度的观察窗口；一个终点被观察满一个窗口之前永不判慢。
    pub window: Duration,
    /// 采样间隔。
    pub tick: Duration,
    /// 每个源、每次尝试最多换几次终点。
    pub max_endpoint_switches: u32,
}

impl Default for WatchdogConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            min_file_size: WATCHDOG_MIN_FILE_SIZE,
            min_bytes_per_sec: SLOW_BYTES_PER_SEC,
            link_floor_bytes_per_sec: LINK_FLOOR_BYTES_PER_SEC,
            window: SLOW_WINDOW,
            tick: WATCHDOG_TICK,
            max_endpoint_switches: MAX_ENDPOINT_SWITCHES,
        }
    }
}

impl WatchdogConfig {
    /// 这个声明大小的文件要不要盯。大小未知不盯：无法排除它是小文件。
    pub fn applies_to(&self, size: Option<u64>) -> bool {
        self.enabled && size.is_some_and(|size| size > self.min_file_size)
    }
}

/// 判慢这笔账算谁的。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SlowCause {
    /// 问题在这个终点：总速率正常而它连份额的一半都不到，或者根本没有别的传输可比。
    Endpoint,
    /// 总速率见了底：可能是链路，也可能是这批都在用的源，分不清，不记主机的账。
    Link,
}

/// 整条下载链路的吞吐计量。所有传输共用一份，只增减原子计数，不起后台任务：
/// 每个看门狗按自己的窗口采样，总速率与本传输的速度就落在同一段时间上。
#[derive(Debug, Default)]
pub(crate) struct LinkMeter {
    wire: AtomicU64,
    streams: AtomicU64,
}

impl LinkMeter {
    /// 网络上读到 `n` 字节。
    pub(crate) fn transferred(&self, n: u64) {
        self.wire.fetch_add(n, Ordering::Relaxed);
    }

    /// 迄今读到的原始字节，只增不减。
    pub(crate) fn wire_bytes(&self) -> u64 {
        self.wire.load(Ordering::Relaxed)
    }

    /// 一条连接开始读响应体。
    pub(crate) fn stream_opened(&self) {
        self.streams.fetch_add(1, Ordering::Relaxed);
    }

    /// 一条连接读完或放弃了响应体。
    pub(crate) fn stream_closed(&self) {
        self.streams.fetch_sub(1, Ordering::Relaxed);
    }

    /// 此刻正在读响应体的连接数。
    pub(crate) fn streams(&self) -> u64 {
        self.streams.load(Ordering::Relaxed)
    }
}

/// 一次判慢的结论。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct Slow {
    /// 判慢那一刻测得的窗口平均速度，字节/秒。
    pub(crate) bytes_per_sec: u64,
    pub(crate) cause: SlowCause,
}

/// 采样累计值，字段都只增不减，两次采样相减即得这段时间内的增量。
///
/// 连接数按采样累加而不取当前值：别的文件在窗口后半段刚下完时，当前连接数已经掉下去了，总速率
/// 却还算着它们的字节，这样算出的份额会虚高，把还在跑的传输误判成掉队。
#[derive(Debug, Clone, Copy, Default)]
pub(crate) struct Tally {
    /// 本传输读到的字节。
    own: u64,
    /// 整条链路读到的字节。
    link: u64,
    /// 本传输的连接数之和。
    own_streams: u64,
    /// 整条链路的连接数之和。
    link_streams: u64,
}

impl Tally {
    fn since(&self, anchor: &Tally) -> Tally {
        Tally {
            own: self.own.saturating_sub(anchor.own),
            link: self.link.saturating_sub(anchor.link),
            own_streams: self.own_streams.saturating_sub(anchor.own_streams),
            link_streams: self.link_streams.saturating_sub(anchor.link_streams),
        }
    }

    /// 本传输已低于单条阈值时，这笔账算谁的；`None` 是带宽被大家分走了，谁的账都不算。
    ///
    /// 份额按连接数分而不按文件数分：TCP 公平的单位是连接，开八条连接的大文件会挤掉单连接的小文件，
    /// 按文件数算，1 到 4 MiB 的单连接文件在大文件旁边永远拿不到「文件数份额」的一半，又成了误判。
    /// 本传输开几条连接就该分几份，开一条时就是「总速率除以活跃数」。
    fn blame(&self, elapsed: Duration, link_floor: u64) -> Option<SlowCause> {
        // 窗口里只有它自己：没有可比的对象，只能按它自己判。
        if self.link_streams <= self.own_streams {
            return Some(SlowCause::Endpoint);
        }
        // 总量见底时先算链路的账：这种线路上各条的份额抖得厉害，谁落后都说明不了主机的好坏。
        if below_rate(self.link, elapsed, link_floor) {
            return Some(SlowCause::Link);
        }
        // 用乘法比较而不先除出份额：整除取整会把恰好等于一半的情形算成「不到一半」。
        let entitled = u128::from(self.link) * u128::from(self.own_streams);
        (2 * u128::from(self.own) * u128::from(self.link_streams) < entitled)
            .then_some(SlowCause::Endpoint)
    }
}

/// `elapsed` 内读到 `bytes` 字节的平均速度是否严格低于 `rate`。
///
/// 用乘法比较而不先除出速度：整除取整会让恰好等于阈值的速度在某些时长下被截成「低于」。
fn below_rate(bytes: u64, elapsed: Duration, rate: u64) -> bool {
    u128::from(bytes) * 1_000_000_000 < u128::from(rate) * elapsed.as_nanos()
}

/// 一个采样点：时刻与那一刻为止的累计读数。
#[derive(Debug, Clone, Copy)]
struct Sample {
    at: Instant,
    tally: Tally,
}

/// 滑动窗口内的吞吐测算。纯计算，不读时钟：时刻都由调用方传入，便于逐点验证判定边界。
///
/// 累计读数从构造那一刻的 0 起算，调用方负责扣掉武装前已有的量。
#[derive(Debug)]
pub(crate) struct ThroughputWindow {
    window: Duration,
    samples: VecDeque<Sample>,
}

impl ThroughputWindow {
    /// 从 `started` 开始观察，窗口长度 `window`。
    pub(crate) fn new(started: Instant, window: Duration) -> Self {
        Self {
            window,
            samples: VecDeque::from([Sample {
                at: started,
                tally: Tally::default(),
            }]),
        }
    }

    /// 记一个样本，并丢掉不再可能成为窗口起点的旧样本：只留不晚于 `now - window` 的最新那一个。
    pub(crate) fn record(&mut self, now: Instant, tally: Tally) {
        self.samples.push_back(Sample { at: now, tally });
        let Some(cutoff) = now.checked_sub(self.window) else {
            return;
        };
        while self.samples.len() >= 2 && self.samples[1].at <= cutoff {
            self.samples.pop_front();
        }
    }

    /// 窗口起点（不晚于 `now - window` 的最新样本）到最新样本之间的增量与经过时长；
    /// 还没观察满一个窗口时为 `None`。
    fn span(&self, now: Instant) -> Option<(Tally, Duration)> {
        let cutoff = now.checked_sub(self.window)?;
        let anchor = self
            .samples
            .iter()
            .rev()
            .find(|sample| sample.at <= cutoff)?;
        let latest = self.samples.back()?;
        Some((
            latest.tally.since(&anchor.tally),
            now.saturating_duration_since(anchor.at),
        ))
    }

    /// 观察满一个窗口且本传输的窗口平均速度严格低于 `min_bytes_per_sec` 时为真。
    pub(crate) fn stalled(&self, now: Instant, min_bytes_per_sec: u64) -> bool {
        self.span(now)
            .is_some_and(|(seen, elapsed)| below_rate(seen.own, elapsed, min_bytes_per_sec))
    }

    /// 观察满一个窗口后的判定：本传输低于单条阈值，且账能算到谁头上才判慢。
    pub(crate) fn verdict(&self, now: Instant, config: &WatchdogConfig) -> Option<Slow> {
        if !self.stalled(now, config.min_bytes_per_sec) {
            return None;
        }
        let (seen, elapsed) = self.span(now)?;
        let cause = seen.blame(elapsed, config.link_floor_bytes_per_sec)?;
        Some(Slow {
            bytes_per_sec: self.bytes_per_sec(now)?,
            cause,
        })
    }

    /// 本传输的窗口平均速度，字节/秒（向下取整）；还没观察满一个窗口时为 `None`。
    /// 只用于日志与错误信息。
    pub(crate) fn bytes_per_sec(&self, now: Instant) -> Option<u64> {
        let (seen, elapsed) = self.span(now)?;
        let nanos = elapsed.as_nanos().max(1);
        Some(u64::try_from(u128::from(seen.own) * 1_000_000_000 / nanos).unwrap_or(u64::MAX))
    }
}

/// 一个终点上武装着的看门狗。
///
/// 网络操作改用 [`token`](Self::token) 观察取消：用户取消经父子关系传进来，判慢由后台采样任务
/// 取消它。不用 `select!` 包住网络 future，是因为 `stream_to_file` 已经保证只在读下一段响应体时
/// 响应取消，不会在落盘中途丢 future；令牌正好复用这条路径。
///
/// 释放即解除：后台采样任务随之 abort，之后的合并、校验、落位不再计时。
pub(crate) struct Armed {
    token: CancellationToken,
    fired: Arc<OnceLock<Slow>>,
    ticker: tokio::task::JoinHandle<()>,
}

impl Armed {
    /// 从此刻起盯住 `file` 的原始字节计数。`user` 是用户的取消令牌，有则派生子令牌。
    pub(crate) fn arm(
        config: WatchdogConfig,
        file: &FileProgress,
        user: Option<&CancellationToken>,
    ) -> Self {
        let token = user.map_or_else(CancellationToken::new, CancellationToken::child_token);
        let fired = Arc::new(OnceLock::new());
        let ticker = tokio::spawn(watch(config, file.clone(), token.clone(), fired.clone()));
        Self {
            token,
            fired,
            ticker,
        }
    }

    /// 网络操作该观察的取消令牌。
    pub(crate) fn token(&self) -> &CancellationToken {
        &self.token
    }

    /// 解除看门狗；判过慢时返回判慢那一刻的结论。
    pub(crate) fn disarm(self) -> Option<Slow> {
        self.fired.get().copied()
    }
}

impl Drop for Armed {
    fn drop(&mut self) {
        self.ticker.abort();
    }
}

/// 采样循环：每个 tick 记一次本传输与整条链路的读数，判慢即记下结论并取消令牌，然后退出。
async fn watch(
    config: WatchdogConfig,
    file: FileProgress,
    token: CancellationToken,
    fired: Arc<OnceLock<Slow>>,
) {
    let baseline = file.wire_bytes();
    let link_baseline = file.link_bytes();
    let mut tally = Tally::default();
    let mut window = ThroughputWindow::new(Instant::now(), config.window);
    // 零周期会让 interval 直接 panic；配置给 0 时按 1 毫秒采样。
    let tick = config.tick.max(Duration::from_millis(1));
    let mut ticker = tokio::time::interval_at(tokio::time::Instant::now() + tick, tick);
    ticker.set_missed_tick_behavior(MissedTickBehavior::Delay);
    loop {
        ticker.tick().await;
        if token.is_cancelled() {
            return;
        }
        let now = Instant::now();
        // 武装着就至少算一条：响应头迟迟不回的终点还没有连接在读响应体，它照样在占着这个文件。
        let own_streams = file.open_streams().max(1);
        tally.own = file.wire_bytes().saturating_sub(baseline);
        tally.link = file.link_bytes().saturating_sub(link_baseline);
        tally.own_streams += own_streams;
        tally.link_streams += file.link_streams().max(own_streams);
        window.record(now, tally);
        if let Some(slow) = window.verdict(now, &config) {
            // 先记结论再取消：观察到取消的一方读 fired 时它一定已经写好。
            let _ = fired.set(slow);
            token.cancel();
            return;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const KIB: u64 = 1024;
    const MIB: u64 = 1024 * KIB;

    fn secs(n: u64) -> Duration {
        Duration::from_secs(n)
    }

    /// 只有本传输时的累计读数。
    fn alone(total: u64) -> Tally {
        Tally {
            own: total,
            link: total,
            ..Tally::default()
        }
    }

    /// 窗口内的读数：本传输 `own` 字节开 `own_streams` 条连接，整条链路 `link` 字节开 `link_streams` 条。
    fn seen(own: u64, own_streams: u64, link: u64, link_streams: u64) -> Tally {
        Tally {
            own,
            link,
            own_streams,
            link_streams,
        }
    }

    /// 15 秒窗口下，按平均速度与平均连接数算账。
    fn blame(
        own_rate: u64,
        own_streams: u64,
        link_rate: u64,
        link_streams: u64,
    ) -> Option<SlowCause> {
        const WINDOW: u64 = 15;
        seen(
            own_rate * WINDOW,
            own_streams * WINDOW,
            link_rate * WINDOW,
            link_streams * WINDOW,
        )
        .blame(secs(WINDOW), LINK_FLOOR_BYTES_PER_SEC)
    }

    #[test]
    fn defaults_match_the_named_constants() {
        let config = WatchdogConfig::default();
        assert!(config.enabled);
        assert_eq!(config.min_file_size, 1 << 20);
        assert_eq!(config.min_bytes_per_sec, 32 * 1024);
        assert_eq!(config.link_floor_bytes_per_sec, 128 * 1024);
        assert_eq!(config.window, secs(15));
        assert_eq!(config.tick, secs(1));
        assert_eq!(config.max_endpoint_switches, 2);
    }

    #[test]
    fn applies_only_to_files_strictly_larger_than_the_floor() {
        let config = WatchdogConfig::default();
        assert!(!config.applies_to(None), "大小未知不盯");
        assert!(!config.applies_to(Some(0)));
        assert!(
            !config.applies_to(Some(WATCHDOG_MIN_FILE_SIZE)),
            "恰 1 MiB 不盯"
        );
        assert!(config.applies_to(Some(WATCHDOG_MIN_FILE_SIZE + 1)));
        let off = WatchdogConfig {
            enabled: false,
            ..config
        };
        assert!(!off.applies_to(Some(1 << 30)), "总开关关掉时一律不盯");
    }

    #[test]
    fn never_stalls_before_a_full_window_is_observed() {
        let t0 = Instant::now();
        let mut window = ThroughputWindow::new(t0, secs(10));
        // 一个字节都没收到，但还没看满 10 秒。
        for n in 1..10 {
            window.record(t0 + secs(n), alone(0));
            assert!(!window.stalled(t0 + secs(n), 32 * KIB), "第 {n} 秒不该判慢");
            assert_eq!(window.bytes_per_sec(t0 + secs(n)), None);
        }
        window.record(t0 + secs(10), alone(0));
        assert!(
            window.stalled(t0 + secs(10), 32 * KIB),
            "看满一个窗口零字节即判慢"
        );
        assert_eq!(window.bytes_per_sec(t0 + secs(10)), Some(0));
    }

    #[test]
    fn average_exactly_at_threshold_is_not_slow() {
        let t0 = Instant::now();
        let mut window = ThroughputWindow::new(t0, secs(10));
        let threshold = 32 * KIB;
        for n in 1..=10 {
            window.record(t0 + secs(n), alone(threshold * n));
        }
        let now = t0 + secs(10);
        assert_eq!(window.bytes_per_sec(now), Some(threshold));
        assert!(!window.stalled(now, threshold), "恰等于阈值不判慢");
        assert!(window.stalled(now, threshold + 1), "阈值高一字节即判慢");
    }

    #[test]
    fn average_below_threshold_is_slow() {
        let t0 = Instant::now();
        let mut window = ThroughputWindow::new(t0, secs(10));
        let threshold = 32 * KIB;
        // 十秒少一个字节。
        for n in 1..=9 {
            window.record(t0 + secs(n), alone(threshold * n));
        }
        window.record(t0 + secs(10), alone(threshold * 10 - 1));
        let now = t0 + secs(10);
        assert!(window.stalled(now, threshold));
        assert_eq!(window.bytes_per_sec(now), Some(threshold - 1));
    }

    #[test]
    fn burst_then_silence_stalls_only_after_the_burst_leaves_the_window() {
        let t0 = Instant::now();
        let mut window = ThroughputWindow::new(t0, secs(10));
        let burst = 64 << 20;
        // 第 1 秒内猛冲 64 MiB，之后一个字节都不来。
        window.record(t0 + secs(1), alone(burst));
        for n in 2..=10 {
            window.record(t0 + secs(n), alone(burst));
            assert!(
                !window.stalled(t0 + secs(n), 32 * KIB),
                "第 {n} 秒猛冲还在窗口里"
            );
        }
        window.record(t0 + secs(11), alone(burst));
        assert!(
            window.stalled(t0 + secs(11), 32 * KIB),
            "窗口起点越过猛冲之后才判慢"
        );
        assert_eq!(window.bytes_per_sec(t0 + secs(11)), Some(0));
    }

    #[test]
    fn record_keeps_only_one_sample_older_than_the_window() {
        let t0 = Instant::now();
        let mut window = ThroughputWindow::new(t0, secs(3));
        for n in 1..=100 {
            window.record(t0 + secs(n), alone(n * KIB));
        }
        // 起点（第 97 秒）加窗口内的 98、99、100 秒。
        assert_eq!(window.samples.len(), 4);
        assert_eq!(window.samples[0].at, t0 + secs(97));
        assert_eq!(window.bytes_per_sec(t0 + secs(100)), Some(KIB));
    }

    #[test]
    fn zero_threshold_never_stalls() {
        let t0 = Instant::now();
        let mut window = ThroughputWindow::new(t0, secs(1));
        window.record(t0 + secs(5), alone(0));
        assert!(!window.stalled(t0 + secs(5), 0));
    }

    #[test]
    fn a_lone_transfer_is_judged_on_its_own() {
        assert_eq!(blame(10 * KIB, 1, 10 * KIB, 1), Some(SlowCause::Endpoint));
        assert_eq!(
            blame(10 * KIB, 8, 10 * KIB, 8),
            Some(SlowCause::Endpoint),
            "连接都是自己的也算独自一个"
        );
        // 总速率下限配得再低，也不能放过独自一条的慢终点。
        assert_eq!(
            seen(10 * KIB, 1, 10 * KIB, 1).blame(secs(1), 0),
            Some(SlowCause::Endpoint)
        );
    }

    #[test]
    fn equal_shares_at_a_healthy_total_blame_nobody() {
        // 16 Mbit/s 摊给 64 条连接：每条约 30.5 KiB/s，都在单条阈值以下。
        let link = 2_000_000;
        assert_eq!(blame(link / 64, 1, link, 64), None);
        // 恰在下限上的总速率不算带不动。
        assert_eq!(
            blame(
                LINK_FLOOR_BYTES_PER_SEC / 16,
                1,
                LINK_FLOOR_BYTES_PER_SEC,
                16
            ),
            None
        );
    }

    #[test]
    fn a_transfer_under_half_of_its_share_is_blamed_on_its_endpoint() {
        // 公平份额 100 KiB/s，比一半少一个字节/秒。
        let link = 800 * KIB;
        assert_eq!(
            blame(50 * KIB - 1, 1, link, 8),
            Some(SlowCause::Endpoint),
            "不到一半"
        );
        assert_eq!(blame(50 * KIB, 1, link, 8), None, "恰好一半不算掉队");
    }

    #[test]
    fn everyone_slow_below_the_link_floor_is_blamed_on_the_link() {
        let link = LINK_FLOOR_BYTES_PER_SEC - 16;
        assert_eq!(blame(link / 16, 1, link, 16), Some(SlowCause::Link));
        // 总量见底时落后也不算主机的账：这种线路上份额本来就抖。
        assert_eq!(blame(KIB, 1, link, 16), Some(SlowCause::Link));
    }

    #[test]
    fn shares_follow_connections_not_files() {
        // 16 个大文件各开 8 条、48 个小文件各开 1 条，共 176 条分 2 MiB/s：每条约 11.6 KiB/s。
        // 按文件数算份额是 32 KiB/s，这些小文件都会被算成不到一半。
        let link = 2 * MIB;
        assert_eq!(blame(link / 176, 1, link, 176), None);
        // 开 8 条连接的文件只拿到 1 条的份额，才是真掉队。
        assert_eq!(blame(link / 176, 8, link, 176), Some(SlowCause::Endpoint));
    }

    #[test]
    fn others_finishing_mid_window_do_not_inflate_the_share() {
        let t0 = Instant::now();
        let mut window = ThroughputWindow::new(t0, secs(10));
        let config = WatchdogConfig::default();
        let mut tally = Tally::default();
        // 前 8 秒 64 条连接平分 2 MiB/s，后 2 秒别的文件都下完了，只剩本传输一条。
        for n in 1..=10 {
            let (others_rate, streams) = if n <= 8 {
                (2 * MIB - 30 * KIB, 64)
            } else {
                (0, 1)
            };
            tally.own += 30 * KIB;
            tally.link += others_rate + 30 * KIB;
            tally.own_streams += 1;
            tally.link_streams += streams;
            window.record(t0 + secs(n), tally);
        }
        let now = t0 + secs(10);
        assert!(window.stalled(now, config.min_bytes_per_sec));
        assert_eq!(
            window.verdict(now, &config),
            None,
            "按此刻的 1 条算份额会是 1.6 MiB/s，把一直跟大家一样快的传输判成掉队"
        );
    }

    #[test]
    fn verdict_needs_the_transfer_itself_below_the_threshold() {
        let t0 = Instant::now();
        let config = WatchdogConfig::default();
        let min = config.min_bytes_per_sec;
        let mut window = ThroughputWindow::new(t0, secs(1));
        // 远低于公平份额，但自己不慢：大家都飞快时落后一点无所谓。
        window.record(t0 + secs(1), seen(min, 1, 100 * MIB, 2));
        assert_eq!(window.verdict(t0 + secs(1), &config), None);
        // 下一秒一个字节都没来：低于阈值，也远不到份额。
        window.record(t0 + secs(2), seen(min, 2, 200 * MIB, 4));
        assert_eq!(window.verdict(t0 + secs(2), &config), Some(silent()));
    }

    fn quick(window: Duration) -> WatchdogConfig {
        WatchdogConfig {
            window,
            tick: Duration::from_millis(10),
            ..WatchdogConfig::default()
        }
    }

    /// 一个字节都没收到的判慢结论。
    fn silent() -> Slow {
        Slow {
            bytes_per_sec: 0,
            cause: SlowCause::Endpoint,
        }
    }

    /// 没有字节流动时，看满窗口后令牌被取消，判慢速度为 0。
    #[tokio::test]
    async fn armed_cancels_its_token_when_nothing_flows() {
        let file = FileProgress::new(None);
        let armed = Armed::arm(quick(Duration::from_millis(100)), &file, None);
        tokio::time::timeout(secs(2), armed.token().cancelled())
            .await
            .expect("看满窗口后应判慢");
        assert_eq!(armed.disarm(), Some(silent()));
    }

    /// 用户取消经子令牌传进来，但那不是判慢：fired 保持为空，用户令牌本身不受子令牌影响。
    #[tokio::test]
    async fn user_cancel_reaches_the_armed_token_without_firing() {
        let user = CancellationToken::new();
        let file = FileProgress::new(None);
        let armed = Armed::arm(quick(secs(60)), &file, Some(&user));
        user.cancel();
        assert!(armed.token().is_cancelled());
        assert_eq!(armed.disarm(), None);

        let user = CancellationToken::new();
        let armed = Armed::arm(quick(Duration::from_millis(50)), &file, Some(&user));
        tokio::time::timeout(secs(2), armed.token().cancelled())
            .await
            .expect("应判慢");
        assert!(!user.is_cancelled(), "判慢只取消子令牌，不替用户取消整批");
    }

    /// 武装前已有的字节不算进本终点的窗口。
    #[tokio::test]
    async fn bytes_before_arming_do_not_count() {
        let file = FileProgress::new(None);
        file.transferred(64 << 20);
        let armed = Armed::arm(quick(Duration::from_millis(100)), &file, None);
        tokio::time::timeout(secs(2), armed.token().cancelled())
            .await
            .expect("武装后没有新字节，应判慢");
        assert_eq!(armed.disarm(), Some(silent()));
    }

    /// 同一条链路上别的文件正常在送数据、本文件响应头迟迟不回：它没有在读响应体的连接，
    /// 也要按一条算份额，不能因为连接数为 0 就永远算不到它头上。
    #[tokio::test]
    async fn a_transfer_waiting_for_headers_still_counts_as_one_stream() {
        let link = Arc::new(LinkMeter::default());
        let file = FileProgress::on_link(None, link.clone());
        let other = FileProgress::on_link(None, link.clone());
        let _reading = other.open_stream();
        let armed = Armed::arm(quick(Duration::from_millis(100)), &file, None);
        let feeder = tokio::spawn(async move {
            loop {
                other.transferred(MIB);
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        });
        tokio::time::timeout(secs(2), armed.token().cancelled())
            .await
            .expect("别的文件在跑时，一个字节没收到的文件应判慢");
        feeder.abort();
        assert_eq!(armed.disarm(), Some(silent()));
    }

    /// 链路上大家一样慢、总速率正常时，看门狗一直不开火。
    #[tokio::test]
    async fn sharing_the_link_equally_keeps_the_token_alive() {
        let link = Arc::new(LinkMeter::default());
        let files: Vec<_> = (0..4)
            .map(|_| FileProgress::on_link(None, link.clone()))
            .collect();
        let _reading: Vec<_> = files.iter().map(FileProgress::open_stream).collect();
        let config = WatchdogConfig {
            min_bytes_per_sec: 100 * MIB,
            link_floor_bytes_per_sec: KIB,
            ..quick(Duration::from_millis(200))
        };
        let armed = Armed::arm(config, &files[0], None);
        let feeders: Vec<_> = files
            .iter()
            .cloned()
            .map(|file| {
                tokio::spawn(async move {
                    loop {
                        file.transferred(KIB);
                        tokio::time::sleep(Duration::from_millis(5)).await;
                    }
                })
            })
            .collect();
        tokio::time::sleep(Duration::from_millis(700)).await;
        for feeder in &feeders {
            feeder.abort();
        }
        assert!(!armed.token().is_cancelled(), "大家一样慢不该判慢");
        assert_eq!(armed.disarm(), None);
    }
}
