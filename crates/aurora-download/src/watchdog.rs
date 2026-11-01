//! 吞吐看门狗：大文件下载中途变慢时，判定当前下载终点不值得再等。
//!
//! HTTP 客户端只有连接超时与读间隔超时，一个每秒只吐几 KB 的终点永远触发不了它们，一个几十 MB
//! 的文件能被拖上几个小时。BMCLAPI 这类分发入口每次请求都会跳到不同的节点，换一个节点往往立刻
//! 恢复正常速度，所以值得盯着吞吐：最近一个窗口的平均速度低于阈值就放弃当前终点，由引擎向原地址
//! 重新要一个终点接着续传。
//!
//! 只盯声明大小超过 [`WATCHDOG_MIN_FILE_SIZE`] 的文件：小文件一个往返就下完了，窗口都攒不满，
//! 判慢只会白白多发请求。大小未知的文件同样不盯，因为无法排除它是小文件。

use std::collections::VecDeque;
use std::sync::{Arc, OnceLock};
use std::time::{Duration, Instant};

use tokio::time::MissedTickBehavior;
use tokio_util::sync::CancellationToken;

use crate::progress::FileProgress;

/// 只看声明大小严格大于这个值的文件。
pub const WATCHDOG_MIN_FILE_SIZE: u64 = 1 << 20;

/// 判慢阈值，字节/秒。取得很低：正常线路比它快两个数量级，低于它说明终点几乎不在送数据，
/// 宁可漏判也不误伤只是偏慢的终点（误判的代价是丢掉在途分片重下）。
pub const SLOW_BYTES_PER_SEC: u64 = 32 * 1024;

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
    /// 窗口平均速度严格低于它即判慢，字节/秒。
    pub min_bytes_per_sec: u64,
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

/// 一个采样点：时刻与那一刻为止本终点上读到的累计字节数。
#[derive(Debug, Clone, Copy)]
struct Sample {
    at: Instant,
    total: u64,
}

/// 滑动窗口内的吞吐测算。纯计算，不读时钟：时刻都由调用方传入，便于逐点验证判定边界。
///
/// 累计字节从构造那一刻的 0 起算，调用方负责扣掉武装前已有的字节。
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
                total: 0,
            }]),
        }
    }

    /// 记一个样本，并丢掉不再可能成为窗口起点的旧样本：只留不晚于 `now - window` 的最新那一个。
    pub(crate) fn record(&mut self, now: Instant, total: u64) {
        self.samples.push_back(Sample { at: now, total });
        let Some(cutoff) = now.checked_sub(self.window) else {
            return;
        };
        while self.samples.len() >= 2 && self.samples[1].at <= cutoff {
            self.samples.pop_front();
        }
    }

    /// 窗口起点（不晚于 `now - window` 的最新样本）到最新样本之间的字节增量与经过时长；
    /// 还没观察满一个窗口时为 `None`。
    fn span(&self, now: Instant) -> Option<(u64, Duration)> {
        let cutoff = now.checked_sub(self.window)?;
        let anchor = self
            .samples
            .iter()
            .rev()
            .find(|sample| sample.at <= cutoff)?;
        let latest = self.samples.back()?;
        Some((
            latest.total.saturating_sub(anchor.total),
            now.saturating_duration_since(anchor.at),
        ))
    }

    /// 观察满一个窗口且窗口平均速度严格低于 `min_bytes_per_sec` 时为真。
    ///
    /// 用乘法比较而不先除出速度：整除取整会让恰好等于阈值的速度在某些时长下被截成「低于」。
    pub(crate) fn stalled(&self, now: Instant, min_bytes_per_sec: u64) -> bool {
        self.span(now).is_some_and(|(bytes, elapsed)| {
            u128::from(bytes) * 1_000_000_000 < u128::from(min_bytes_per_sec) * elapsed.as_nanos()
        })
    }

    /// 窗口平均速度，字节/秒（向下取整）；还没观察满一个窗口时为 `None`。只用于日志与错误信息。
    pub(crate) fn bytes_per_sec(&self, now: Instant) -> Option<u64> {
        let (bytes, elapsed) = self.span(now)?;
        let nanos = elapsed.as_nanos().max(1);
        Some(u64::try_from(u128::from(bytes) * 1_000_000_000 / nanos).unwrap_or(u64::MAX))
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
    fired: Arc<OnceLock<u64>>,
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

    /// 解除看门狗；判过慢时返回判慢那一刻测得的窗口平均速度。
    pub(crate) fn disarm(self) -> Option<u64> {
        self.fired.get().copied()
    }
}

impl Drop for Armed {
    fn drop(&mut self) {
        self.ticker.abort();
    }
}

/// 采样循环：每个 tick 记一次原始字节，判慢即记下速度并取消令牌，然后退出。
async fn watch(
    config: WatchdogConfig,
    file: FileProgress,
    token: CancellationToken,
    fired: Arc<OnceLock<u64>>,
) {
    let baseline = file.wire_bytes();
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
        window.record(now, file.wire_bytes().saturating_sub(baseline));
        // 判慢意味着已看满一个窗口，速度必然测得出来。
        if window.stalled(now, config.min_bytes_per_sec)
            && let Some(rate) = window.bytes_per_sec(now)
        {
            // 先记速度再取消：观察到取消的一方读 fired 时它一定已经写好。
            let _ = fired.set(rate);
            token.cancel();
            return;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const KIB: u64 = 1024;

    fn secs(n: u64) -> Duration {
        Duration::from_secs(n)
    }

    #[test]
    fn defaults_match_the_named_constants() {
        let config = WatchdogConfig::default();
        assert!(config.enabled);
        assert_eq!(config.min_file_size, 1 << 20);
        assert_eq!(config.min_bytes_per_sec, 32 * 1024);
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
            window.record(t0 + secs(n), 0);
            assert!(!window.stalled(t0 + secs(n), 32 * KIB), "第 {n} 秒不该判慢");
            assert_eq!(window.bytes_per_sec(t0 + secs(n)), None);
        }
        window.record(t0 + secs(10), 0);
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
            window.record(t0 + secs(n), threshold * n);
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
            window.record(t0 + secs(n), threshold * n);
        }
        window.record(t0 + secs(10), threshold * 10 - 1);
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
        window.record(t0 + secs(1), burst);
        for n in 2..=10 {
            window.record(t0 + secs(n), burst);
            assert!(
                !window.stalled(t0 + secs(n), 32 * KIB),
                "第 {n} 秒猛冲还在窗口里"
            );
        }
        window.record(t0 + secs(11), burst);
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
            window.record(t0 + secs(n), n * KIB);
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
        window.record(t0 + secs(5), 0);
        assert!(!window.stalled(t0 + secs(5), 0));
    }

    fn quick(window: Duration) -> WatchdogConfig {
        WatchdogConfig {
            window,
            tick: Duration::from_millis(10),
            ..WatchdogConfig::default()
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
        assert_eq!(armed.disarm(), Some(0));
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
        assert_eq!(armed.disarm(), Some(0));
    }
}
