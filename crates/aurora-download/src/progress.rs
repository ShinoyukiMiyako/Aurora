//! 下载进度上报。
//!
//! [`DownloadProgress`] 是暴露给前端进度条的快照结构；[`ProgressReporter`] 是引擎内部的
//! 累加器（原子计数 + 采样器），通过 [`tokio::sync::watch`] 把快照推给观察者。
//!
//! 字节有两套计数，各司其职：
//!
//! - 有效字节（快照里的 `bytes`）：一批里已经就绪的字节。成功或本就完整而跳过的文件按其实际
//!   大小计入，续传复用的分片计入；失败的尝试、被丢弃的分片一律退回。因此它不会因重传而虚高，
//!   一批全部成功时恰等于 `total_bytes`，用来画进度条与「已下载 / 总量」文案。
//! - 传输字节（只在内部）：网络上实际读到的字节，重试会重复累加，只用来算速度。
//!
//! 两者之差就是重传浪费，批次结束时记一条日志。曾经只有传输字节一套计数，界面拿它当完成度，
//! 于是出现过「100% · 1.06 GB / 1.04 GB」——分子比分母还大。
//!
//! `total_bytes` 是这一批任务声明大小之和，只在每个任务都声明了大小时才有值。
//! 速度由独立采样任务按固定间隔对传输字节增量做 EWMA 平滑得到。

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
    /// 有效字节：已就绪的字节，失败的尝试会被退回，不含重传。
    pub bytes: u64,
    /// 本批任务声明大小之和；有任一任务大小未知时为 `None`（总量无从得知，不能拿部分和冒充）。
    pub total_bytes: Option<u64>,
    /// 瞬时速度，字节/秒（按实际传输字节做 EWMA 平滑）。
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
    effective: AtomicU64,
    transferred: AtomicU64,
    speed: AtomicU64,
    sender: Option<watch::Sender<DownloadProgress>>,
}

impl ReporterInner {
    fn snapshot(&self) -> DownloadProgress {
        DownloadProgress {
            total: self.total,
            finished: self.finished.load(Ordering::Relaxed),
            bytes: self.effective.load(Ordering::Relaxed),
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
                effective: AtomicU64::new(0),
                transferred: AtomicU64::new(0),
                speed: AtomicU64::new(0),
                sender,
            }),
        }
    }

    /// 网络上读到 `n` 字节：传输与有效两套计数同时前进。
    fn transferred(&self, n: u64) {
        self.inner.transferred.fetch_add(n, Ordering::Relaxed);
        self.inner.effective.fetch_add(n, Ordering::Relaxed);
    }

    /// 计入 `n` 个不经网络就已就绪的字节（跳过的完整文件、复用的分片）。
    fn credit(&self, n: u64) {
        self.inner.effective.fetch_add(n, Ordering::Relaxed);
    }

    /// 退回 `n` 个有效字节。传输计数不动——那笔流量真的走过网线。
    ///
    /// 用 saturating 而非直接 fetch_sub：无符号数一旦下溢会翻成天文数字，进度条会瞬间冲满。
    fn rewind(&self, n: u64) {
        if n == 0 {
            return;
        }
        let _ =
            self.inner
                .effective
                .fetch_update(Ordering::Relaxed, Ordering::Relaxed, |current| {
                    Some(current.saturating_sub(n))
                });
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

    /// 本批累计的有效字节。
    pub(crate) fn effective_bytes(&self) -> u64 {
        self.inner.effective.load(Ordering::Relaxed)
    }

    /// 本批累计的传输字节（含重传）。
    pub(crate) fn transferred_bytes(&self) -> u64 {
        self.inner.transferred.load(Ordering::Relaxed)
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

/// 单个文件对有效字节的记账。
///
/// 每个文件记下自己已经计入了多少有效字节，于是任何一条失败路径（传输中断、校验不过、放弃分片、
/// 换源）都不必各自记得退回多少：新一次尝试开始时整笔退回，文件落定时对齐为实际大小，失败时清零。
/// 克隆共享同一份记账，供并发的分片任务使用。
#[derive(Clone)]
pub(crate) struct FileProgress {
    reporter: Option<ProgressReporter>,
    credited: Arc<AtomicU64>,
}

impl FileProgress {
    /// 挂到批次累加器上；`None` 时一切记账都是空操作。
    pub(crate) fn new(reporter: Option<&ProgressReporter>) -> Self {
        Self {
            reporter: reporter.cloned(),
            credited: Arc::new(AtomicU64::new(0)),
        }
    }

    /// 网络上为该文件读到 `n` 字节。
    pub(crate) fn transferred(&self, n: u64) {
        if let Some(reporter) = &self.reporter {
            reporter.transferred(n);
            self.credited.fetch_add(n, Ordering::Relaxed);
        }
    }

    /// 该文件有 `n` 字节不经网络就已就绪（续传复用的分片）。
    pub(crate) fn reused(&self, n: u64) {
        if let Some(reporter) = &self.reporter {
            reporter.credit(n);
            self.credited.fetch_add(n, Ordering::Relaxed);
        }
    }

    /// 上一次尝试作废：退回该文件已计入的全部有效字节。只在没有分片任务在跑时调用。
    pub(crate) fn reset(&self) {
        self.settle(0);
    }

    /// 文件落定：把该文件计入的有效字节对齐为 `len`（成功时为文件实际大小，失败时为 0）。
    pub(crate) fn settle(&self, len: u64) {
        let Some(reporter) = &self.reporter else {
            return;
        };
        let previous = self.credited.swap(len, Ordering::Relaxed);
        if len >= previous {
            reporter.credit(len - previous);
        } else {
            reporter.rewind(previous - len);
        }
    }
}

/// 采样循环：每个 tick 用「本区间传输字节增量 × 每秒 tick 数」估算瞬时速度，再做 EWMA 平滑。
async fn sample_loop(inner: Arc<ReporterInner>, interval: Duration) {
    let mut ticker = tokio::time::interval(interval);
    // 采样滞后时直接跳到当前时刻，不追赶补发，避免速度尖刺。
    ticker.set_missed_tick_behavior(MissedTickBehavior::Delay);
    let per_second = 1000.0 / interval.as_millis().max(1) as f64;
    let mut last_bytes = inner.transferred.load(Ordering::Relaxed);
    let mut ewma = 0.0f64;
    loop {
        ticker.tick().await;
        let current = inner.transferred.load(Ordering::Relaxed);
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

    fn reporter(
        total: u64,
        total_bytes: Option<u64>,
    ) -> (ProgressReporter, watch::Receiver<DownloadProgress>) {
        let (tx, rx) = watch::channel(DownloadProgress::default());
        (ProgressReporter::new(total, total_bytes, Some(tx)), rx)
    }

    #[test]
    fn snapshot_reflects_counters() {
        let (reporter, rx) = reporter(3, Some(4096));
        let file = FileProgress::new(Some(&reporter));
        file.transferred(100);
        file.transferred(50);
        reporter.finish_file();
        let snap = *rx.borrow();
        assert_eq!(snap.total, 3);
        assert_eq!(snap.finished, 1);
        assert_eq!(snap.bytes, 150);
        assert_eq!(snap.total_bytes, Some(4096));
        assert_eq!(reporter.transferred_bytes(), 150);
    }

    #[test]
    fn reset_takes_back_effective_but_not_transferred_bytes() {
        let (reporter, rx) = reporter(1, Some(1000));
        let file = FileProgress::new(Some(&reporter));
        file.transferred(1000);
        // 内容校验不过，整份重下：上一遍的字节不再算进度。
        file.reset();
        file.transferred(1000);
        file.settle(1000);
        reporter.finish_file();

        assert_eq!(
            rx.borrow().bytes,
            1000,
            "有效字节恰为文件大小，坏的那遍被退回"
        );
        assert_eq!(reporter.transferred_bytes(), 2000, "吞吐计数保留两遍传输");
    }

    #[test]
    fn reused_parts_count_as_ready_bytes() {
        let (reporter, _rx) = reporter(1, Some(900));
        let file = FileProgress::new(Some(&reporter));
        file.reused(600);
        file.transferred(300);
        file.settle(900);
        assert_eq!(reporter.effective_bytes(), 900);
        assert_eq!(reporter.transferred_bytes(), 300, "复用的分片没走网络");
    }

    #[test]
    fn settle_aligns_to_the_final_size_in_both_directions() {
        let (reporter, _rx) = reporter(2, None);
        let up = FileProgress::new(Some(&reporter));
        // 本就完整而跳过的文件：一个字节没传，落定时按实际大小计入。
        up.settle(4096);
        assert_eq!(reporter.effective_bytes(), 4096);

        let down = FileProgress::new(Some(&reporter));
        down.transferred(700);
        // 最终失败：该文件的贡献清零，别的文件不受影响。
        down.settle(0);
        assert_eq!(reporter.effective_bytes(), 4096);
        assert_eq!(reporter.transferred_bytes(), 700);
    }

    #[test]
    fn rewind_never_underflows_into_a_huge_number() {
        let (reporter, _rx) = reporter(1, None);
        reporter.credit(100);
        reporter.rewind(999_999);
        assert_eq!(reporter.effective_bytes(), 0);
        reporter.rewind(0);
        assert_eq!(reporter.effective_bytes(), 0);
    }

    #[test]
    fn concurrent_chunks_share_one_file_ledger() {
        let (reporter, _rx) = reporter(1, Some(300));
        let file = FileProgress::new(Some(&reporter));
        let chunk = file.clone();
        chunk.transferred(100);
        file.transferred(200);
        file.reset();
        assert_eq!(
            reporter.effective_bytes(),
            0,
            "克隆出的分片记账同属一个文件，一并退回"
        );
    }

    #[test]
    fn file_progress_without_reporter_is_inert() {
        let file = FileProgress::new(None);
        file.transferred(10);
        file.reused(5);
        file.settle(99);
        file.reset();
        assert_eq!(file.credited.load(Ordering::Relaxed), 0);
    }

    #[test]
    fn reporter_without_sender_still_counts_but_does_not_publish() {
        let reporter = ProgressReporter::new(2, None, None);
        FileProgress::new(Some(&reporter)).transferred(10);
        reporter.finish_file();
        assert!(!reporter.has_sender());
        assert_eq!(reporter.effective_bytes(), 10);
    }

    #[test]
    fn finalize_zeroes_speed_and_publishes_final_counts() {
        let (reporter, rx) = reporter(1, None);
        let file = FileProgress::new(Some(&reporter));
        file.transferred(4096);
        file.settle(4096);
        reporter.finish_file();
        reporter.finalize();
        let snap = *rx.borrow();
        assert_eq!(snap.finished, 1);
        assert_eq!(snap.total, 1);
        assert_eq!(snap.speed, 0);
        assert_eq!(snap.bytes, 4096);
    }
}
