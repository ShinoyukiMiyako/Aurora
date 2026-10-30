//! 下载进度上报。
//!
//! [`DownloadProgress`] 是暴露给前端进度条的快照结构；[`ProgressReporter`] 是引擎内部的
//! 累加器（原子计数 + 采样器），通过 [`tokio::sync::watch`] 把快照推给观察者。
//!
//! 字节计数记录「实际传输字节」——重试会重复累加，因此 `bytes` 反映真实网络吞吐而非「已完成
//! 目标的字节」；整体完成度以文件计数 `finished/total` 表达，两者互不矛盾。`total_bytes` 是这一批
//! 任务声明大小之和，只在每个任务都声明了大小时才有值；拿 `bytes / total_bytes` 画进度条时要封顶到 1，
//! 因为重传会让 `bytes` 超过它。速度由独立采样任务按固定间隔对字节增量做 EWMA 平滑得到。

use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use tokio::sync::watch;
use tokio::time::MissedTickBehavior;

/// 面向前端进度条的进度快照。字段语义见模块文档。
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct DownloadProgress {
    /// 总任务（文件）数。
    pub total: u64,
    /// 已结束任务数（成功与最终失败都计入，故最终必达 `total`）。
    pub finished: u64,
    /// 累计已传输字节数（含重试重复传输）。
    pub bytes: u64,
    /// 本批任务声明大小之和；有任一任务大小未知时为 `None`（总量无从得知，不能拿部分和冒充）。
    pub total_bytes: Option<u64>,
    /// 瞬时速度，字节/秒（EWMA 平滑）。
    pub speed: u64,
}

/// 引擎内部的进度累加器。可廉价克隆（内部 `Arc`），供多个下载任务共享同一组计数。
#[derive(Clone)]
pub(crate) struct ProgressReporter {
    inner: Arc<ReporterInner>,
}

struct ReporterInner {
    total: u64,
    total_bytes: Option<u64>,
    finished: AtomicU64,
    bytes: AtomicU64,
    speed: AtomicU64,
    sender: Option<watch::Sender<DownloadProgress>>,
}

impl ReporterInner {
    fn snapshot(&self) -> DownloadProgress {
        DownloadProgress {
            total: self.total,
            finished: self.finished.load(Ordering::Relaxed),
            bytes: self.bytes.load(Ordering::Relaxed),
            total_bytes: self.total_bytes,
            speed: self.speed.load(Ordering::Relaxed),
        }
    }

    fn publish(&self) {
        if let Some(sender) = &self.sender {
            // send_replace 无视有无接收者都成功；观察者随时能借到最新快照。
            let _ = sender.send_replace(self.snapshot());
        }
    }
}

impl ProgressReporter {
    /// 新建累加器。`sender` 为 `None` 时所有 publish 皆为空操作（无观察者、不起采样器）。
    pub(crate) fn new(
        total: u64,
        total_bytes: Option<u64>,
        sender: Option<watch::Sender<DownloadProgress>>,
    ) -> Self {
        Self {
            inner: Arc::new(ReporterInner {
                total,
                total_bytes,
                finished: AtomicU64::new(0),
                bytes: AtomicU64::new(0),
                speed: AtomicU64::new(0),
                sender,
            }),
        }
    }

    /// 累加一次传输字节（下载流每读到一段就调用）。
    pub(crate) fn add_bytes(&self, n: u64) {
        self.inner.bytes.fetch_add(n, Ordering::Relaxed);
    }

    /// 标记一个文件任务结束（成功或最终失败），并立即推送一次快照。
    pub(crate) fn finish_file(&self) {
        self.inner.finished.fetch_add(1, Ordering::Relaxed);
        self.inner.publish();
    }

    /// 主动推送一次当前快照（用于开始时把 `total` 先发给观察者）。
    pub(crate) fn publish(&self) {
        self.inner.publish();
    }

    /// 是否配置了观察者。无观察者则无需起采样任务。
    pub(crate) fn has_sender(&self) -> bool {
        self.inner.sender.is_some()
    }

    /// 起一个后台采样任务，按 `interval` 计算并推送速度。返回句柄供池在结束时 abort。
    pub(crate) fn spawn_sampler(&self, interval: Duration) -> tokio::task::JoinHandle<()> {
        let inner = self.inner.clone();
        tokio::spawn(async move { sample_loop(inner, interval).await })
    }

    /// 收尾：速度归零并推送最终快照（此时 `finished` 应已达 `total`）。
    pub(crate) fn finalize(&self) {
        self.inner.speed.store(0, Ordering::Relaxed);
        self.inner.publish();
    }
}

/// 采样循环：每个 tick 用「本区间字节增量 × 每秒 tick 数」估算瞬时速度，再做 EWMA 平滑。
async fn sample_loop(inner: Arc<ReporterInner>, interval: Duration) {
    let mut ticker = tokio::time::interval(interval);
    // 采样滞后时直接跳到当前时刻，不追赶补发，避免速度尖刺。
    ticker.set_missed_tick_behavior(MissedTickBehavior::Delay);
    let per_second = 1000.0 / interval.as_millis().max(1) as f64;
    let mut last_bytes = inner.bytes.load(Ordering::Relaxed);
    let mut ewma = 0.0f64;
    loop {
        ticker.tick().await;
        let current = inner.bytes.load(Ordering::Relaxed);
        let delta = current.saturating_sub(last_bytes);
        last_bytes = current;
        let instant = delta as f64 * per_second;
        ewma = 0.5 * instant + 0.5 * ewma;
        inner.speed.store(ewma as u64, Ordering::Relaxed);
        inner.publish();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn snapshot_reflects_counters() {
        let (tx, rx) = watch::channel(DownloadProgress::default());
        let reporter = ProgressReporter::new(3, Some(4096), Some(tx));
        reporter.add_bytes(100);
        reporter.add_bytes(50);
        reporter.finish_file();
        let snap = *rx.borrow();
        assert_eq!(snap.total, 3);
        assert_eq!(snap.finished, 1);
        assert_eq!(snap.bytes, 150);
        assert_eq!(snap.total_bytes, Some(4096));
    }

    #[test]
    fn reporter_without_sender_is_silent() {
        let reporter = ProgressReporter::new(2, None, None);
        reporter.add_bytes(10);
        reporter.finish_file();
        // 无 sender 不 panic、无 publish；仅内部计数推进。
        assert!(!reporter.has_sender());
    }

    #[test]
    fn finalize_zeroes_speed_and_publishes_final_counts() {
        let (tx, rx) = watch::channel(DownloadProgress::default());
        let reporter = ProgressReporter::new(1, None, Some(tx));
        reporter.add_bytes(4096);
        reporter.finish_file();
        reporter.finalize();
        let snap = *rx.borrow();
        assert_eq!(snap.finished, 1);
        assert_eq!(snap.total, 1);
        assert_eq!(snap.speed, 0);
        assert_eq!(snap.bytes, 4096);
    }
}
