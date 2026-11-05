//! 自更新下载的卡死检测：最近一个窗口里几乎没收到字节，就判定这次下载不会再有进展。
//!
//! 插件下载更新包时自己新建 HTTP 客户端，`Update` 的超时也是空的；外壳经 `configure_client` 给它补上了连接与
//! 读取超时（`updater::with_transfer_timeouts`），没设总时限，免得慢网下的正常下载被掐断。读取超时只管两次读到
//! 数据之间的静默，完全不送数据的连接由它兜住；终点只要每次读都赶在超时之前吐几个字节，它就永远等不到，下载照样
//! 挂着、进度条停在原地。这里专抓这种涓流连接，看的是一个窗口里的总量，不是读间隔；完全静默的连接两边都拦得住。
//!
//! 完全静默时两道防线大致同时到点：读取超时从最后一次读到数据起满 30 秒报错；这里要等最后一块所在的桶离开窗口，
//! 通常晚它一点，最多一个桶宽再加一次检查间隔。连接本来就慢、窗口里余量不多时，这里也可能先到。谁先到都报
//! `update_download_failed`、`detail.network` 为 `timeout`，前端按同一套网络超时文案提示，只有后端原文不同。
//!
//! 这里只做判定，不读时钟，时刻都由调用方传入，便于逐点验证边界。字节在插件的逐块回调里记；
//! 判定要由独立的定时器来问，因为卡死的连接恰恰不再触发回调。
//!
//! 判定方式沿用 petalfall-download 的吞吐看门狗：看满一个窗口之前不判，窗口内的量严格低于阈值才判。
//! 那边的 `ThroughputWindow` 是 crate 内部类型，门面也没有导出，外壳只依赖门面与 petalfall-base，
//! 所以在这里单独实现。

use std::collections::VecDeque;
use std::time::{Duration, Instant};

/// 卡死判定的观察窗口。与读取超时（petalfall-base 的默认值 30 秒，经 `configure_client` 也套在这次下载上）
/// 同长、并行生效：读取超时把 30 秒一个字节都没有当成连接已死，这里放宽成 30 秒里几乎没有字节。
/// 它也是吞吐看门狗窗口（15 秒）的两倍，足以跨过 TCP 重传退避、Wi-Fi 漫游这类几秒到十几秒的停顿，不把它们当成卡死。
pub(crate) const STALL_WINDOW: Duration = Duration::from_secs(30);

/// 一个窗口里收到的字节少于它算卡死，按 30 秒窗口合约 2.1 KiB/s。
///
/// 吞吐看门狗按 32 KiB/s 判慢，是因为那边判慢只换终点，已下的分片续传不丢；插件把更新包整个读进内存、
/// 不支持续传，判死就只能从零重下，所以这里取得低一个数量级以上，只抓几乎不动的连接：
/// 20 KB/s 的慢线路一个窗口能收 600 KB，是阈值的九倍多。真低于它时，几 MB 的更新包也要下半个多小时，
/// 等下去没有意义。
pub(crate) const STALL_MIN_BYTES: u64 = 64 * 1024;

/// 窗口切成的桶数。字节按桶合并记账，逐块回调再密，内存也固定在 `BUCKETS + 1` 个桶；
/// 代价是判定最多晚一个桶宽（窗口的 1/30，默认窗口下是 1 秒），只会晚、不会早。
const BUCKETS: u32 = 30;

/// 下载卡死的判定器：从构造那一刻起，看满一个窗口后，最近一个窗口里记到的字节严格少于下限即算卡住。
#[derive(Debug)]
pub(crate) struct StallGuard {
    started: Instant,
    window: Duration,
    min_bytes: u64,
    /// 桶宽，纳秒。
    bucket_nanos: u128,
    /// `(桶序号, 这个桶里记到的字节)`，序号从构造时刻起算、严格递增，只留可能还在窗口里的桶。
    buckets: VecDeque<(u128, u64)>,
}

impl StallGuard {
    pub(crate) fn new(window: Duration, min_bytes: u64, now: Instant) -> Self {
        // 桶宽向上取整，`BUCKETS` 个桶才盖得住整个窗口，截断会让窗口算短、判定提前。
        // 不足 1 纳秒按 1 纳秒，零窗口也不会除零。
        let bucket_nanos = window.as_nanos().div_ceil(u128::from(BUCKETS)).max(1);
        Self {
            started: now,
            window,
            min_bytes,
            bucket_nanos,
            buckets: VecDeque::with_capacity(BUCKETS as usize + 1),
        }
    }

    /// 在 `now` 收到 `bytes` 字节。
    pub(crate) fn record(&mut self, bytes: u64, now: Instant) {
        let bucket = self.bucket_at(now);
        let oldest = Self::oldest_counted(bucket);
        while self.buckets.front().is_some_and(|&(at, _)| at < oldest) {
            self.buckets.pop_front();
        }
        match self.buckets.back_mut() {
            Some((at, total)) if *at == bucket => *total = total.saturating_add(bytes),
            _ => self.buckets.push_back((bucket, bytes)),
        }
    }

    /// 看满一个窗口，且最近一个窗口里记到的字节严格少于下限时为真。
    pub(crate) fn stalled(&self, now: Instant) -> bool {
        if now.saturating_duration_since(self.started) < self.window {
            return false;
        }
        let oldest = Self::oldest_counted(self.bucket_at(now));
        let seen = self
            .buckets
            .iter()
            .filter(|&&(at, _)| at >= oldest)
            .fold(0u64, |sum, &(_, bytes)| sum.saturating_add(bytes));
        seen < self.min_bytes
    }

    /// `now` 落在哪个桶。
    fn bucket_at(&self, now: Instant) -> u128 {
        let bucket = now.saturating_duration_since(self.started).as_nanos() / self.bucket_nanos;
        // 逐块回调与定时器各自取时刻，偶尔会有更早的时刻晚到；一律记进最新的桶，
        // 字节在窗口里只会多留一会儿，判定只会推迟、不会提前，桶序号也保持递增。
        self.buckets
            .back()
            .map_or(bucket, |&(latest, _)| bucket.max(latest))
    }

    /// 以 `bucket` 为当前桶时还算进窗口的最老桶。当前桶只走了一部分，再往前 `BUCKETS` 个桶才盖得住整个窗口；
    /// 最老那个桶有一部分已在窗口外，多算的都是旧字节，同样只会让判定推迟。
    fn oldest_counted(bucket: u128) -> u128 {
        bucket.saturating_sub(u128::from(BUCKETS))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 测试用窗口与下限：窗口 30 秒正好切成 1 秒一个桶，判定的时刻好算。
    const W: Duration = Duration::from_secs(30);
    const MIN: u64 = 1000;

    fn secs(n: u64) -> Duration {
        Duration::from_secs(n)
    }

    fn millis(n: u64) -> Duration {
        Duration::from_millis(n)
    }

    /// 判定允许晚到的上限：一个桶宽。
    fn bucket_width(window: Duration) -> Duration {
        window / BUCKETS
    }

    #[test]
    fn never_stalls_before_a_full_window() {
        let t0 = Instant::now();
        let guard = StallGuard::new(W, MIN, t0);
        // 一个字节都没收到，但还没看满 30 秒。
        for n in 0..30 {
            assert!(!guard.stalled(t0 + secs(n)), "第 {n} 秒不该报");
        }
        assert!(
            !guard.stalled(t0 + W - Duration::from_nanos(1)),
            "差 1 纳秒满窗口不该报"
        );
        assert!(guard.stalled(t0 + W), "恰好满一个窗口、零字节即报");
    }

    #[test]
    fn exactly_min_bytes_in_the_window_is_not_stalled() {
        let t0 = Instant::now();
        let mut guard = StallGuard::new(W, MIN, t0);
        guard.record(MIN, t0 + secs(10));
        assert!(!guard.stalled(t0 + W), "恰好等于下限不算卡住");

        let mut guard = StallGuard::new(W, MIN, t0);
        guard.record(MIN - 1, t0 + secs(10));
        assert!(guard.stalled(t0 + W), "比下限少一个字节即算卡住");
        guard.record(1, t0 + W);
        assert!(!guard.stalled(t0 + W), "补上这一个字节就恰好够下限");
    }

    #[test]
    fn steady_rate_just_above_the_threshold_never_stalls() {
        let t0 = Instant::now();
        let mut guard = StallGuard::new(STALL_WINDOW, STALL_MIN_BYTES, t0);
        // 每秒到一块，任何一个 30 秒窗口里都恰好有 30 块，合计刚够下限。
        let per_sec = STALL_MIN_BYTES.div_ceil(STALL_WINDOW.as_secs());
        assert!(per_sec * (STALL_WINDOW.as_secs() - 1) < STALL_MIN_BYTES);
        for n in 1..=600 {
            guard.record(per_sec, t0 + secs(n));
            assert!(!guard.stalled(t0 + secs(n)), "第 {n} 秒刚收到一块");
            assert!(
                !guard.stalled(t0 + secs(n) + millis(999)),
                "第 {n} 秒的下一块还没到"
            );
        }
    }

    #[test]
    fn slow_but_moving_at_20_kb_per_sec_never_stalls() {
        let t0 = Instant::now();
        let mut guard = StallGuard::new(STALL_WINDOW, STALL_MIN_BYTES, t0);
        // 每 100 毫秒 2000 字节，合 20 KB/s，下 10 分钟。
        for n in 1..=6000 {
            let now = t0 + millis(100 * n);
            guard.record(2000, now);
            assert!(!guard.stalled(now), "第 {n} 块时不该报");
        }
    }

    #[test]
    fn a_nearly_silent_connection_is_reported_with_the_real_thresholds() {
        let t0 = Instant::now();
        let mut guard = StallGuard::new(STALL_WINDOW, STALL_MIN_BYTES, t0);
        // 每秒 1 KiB：还在动，但一个窗口连阈值的一半都不到。
        for n in 1..=120 {
            guard.record(1024, t0 + secs(n));
        }
        assert!(guard.stalled(t0 + secs(120)));
    }

    #[test]
    fn stalls_once_the_transfer_has_stopped_for_a_full_window() {
        let t0 = Instant::now();
        let mut guard = StallGuard::new(W, MIN, t0);
        // 前 60 秒每 100 毫秒到 100 KB，之后一个字节都不来。
        for n in 1..=600 {
            let now = t0 + millis(100 * n);
            guard.record(100_000, now);
            assert!(!guard.stalled(now));
        }
        let last = t0 + secs(60);
        assert!(
            !guard.stalled(last + W - Duration::from_nanos(1)),
            "最后一块还在窗口里"
        );
        assert!(
            guard.stalled(last + W + bucket_width(W)),
            "最后一块离开窗口后，最多晚一个桶宽就要报"
        );
    }

    #[test]
    fn a_last_chunk_mid_bucket_leaves_the_window_within_one_bucket() {
        let t0 = Instant::now();
        let mut guard = StallGuard::new(W, MIN, t0);
        let last = t0 + millis(60_500);
        guard.record(10 * MIN, last);
        assert!(!guard.stalled(last + W - Duration::from_nanos(1)));
        assert!(guard.stalled(last + W + bucket_width(W)));
    }

    #[test]
    fn resuming_after_a_stall_clears_it() {
        let t0 = Instant::now();
        let mut guard = StallGuard::new(W, MIN, t0);
        for n in 1..=10 {
            guard.record(100_000, t0 + secs(n));
        }
        assert!(guard.stalled(t0 + secs(41)), "停了满一个窗口");

        // 恢复后只来一点点，还不够下限，照样算卡住。
        guard.record(MIN - 1, t0 + secs(45));
        assert!(guard.stalled(t0 + secs(45)));
        // 窗口里攒够下限，立刻不再算卡住，并且在这些字节离开窗口前一直不算。
        guard.record(1, t0 + secs(46));
        assert!(!guard.stalled(t0 + secs(46)));
        assert!(!guard.stalled(t0 + secs(45) + W - Duration::from_nanos(1)));
        // 之后又停住，这两块离开窗口后再次报。
        assert!(guard.stalled(t0 + secs(46) + W + bucket_width(W)));
    }

    #[test]
    fn old_bytes_do_not_count_after_a_long_silence() {
        let t0 = Instant::now();
        let mut guard = StallGuard::new(W, MIN, t0);
        guard.record(1 << 30, t0 + secs(1));
        assert!(guard.stalled(t0 + secs(7200)), "两小时前的字节不算");
        guard.record(MIN - 1, t0 + secs(7200));
        assert!(
            guard.stalled(t0 + secs(7200)),
            "新来的不够下限，旧字节也不能补上"
        );
    }

    #[test]
    fn memory_stays_bounded_however_dense_the_chunks() {
        let t0 = Instant::now();
        let mut guard = StallGuard::new(W, MIN, t0);
        // 每毫秒一块，下 10 分钟，窗口滑过二十轮。
        for n in 1..=600_000 {
            guard.record(16 * 1024, t0 + millis(n));
            assert!(guard.buckets.len() <= BUCKETS as usize + 1);
        }
        assert!(!guard.stalled(t0 + millis(600_000)));
    }

    #[test]
    fn a_late_earlier_timestamp_only_delays_the_verdict() {
        let t0 = Instant::now();
        let mut guard = StallGuard::new(W, MIN, t0);
        guard.record(1, t0 + secs(40));
        // 第 5 秒的一块到第 40 秒之后才记进来：按最新的桶算，不算在早已出窗的第 5 秒。
        guard.record(MIN, t0 + secs(5));
        assert!(!guard.stalled(t0 + secs(40)));
        assert!(guard.stalled(t0 + secs(40) + W + bucket_width(W)));
    }

    #[test]
    fn zero_min_bytes_never_stalls() {
        let t0 = Instant::now();
        let guard = StallGuard::new(W, 0, t0);
        assert!(!guard.stalled(t0 + secs(3600)));
    }
}
