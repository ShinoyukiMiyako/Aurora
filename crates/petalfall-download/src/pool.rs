//! 批量并发下载池。
//!
//! [`DownloadPool`] 用一个信号量控住「同时在下的文件数」，把上千个小文件（如 assets）以合并
//! 并发池的形式跑完，并把总进度经 [`watch`] channel 推给前端。发起前按目标路径去重，避免重复入队
//! 同名任务，再按声明大小从大到小派发。单个文件失败（重试并换源后仍失败）不拖垮整批：失败被收集进
//! [`BatchReport`]，由调用方决定后续处置。
//!
//! 挂了取消令牌的池在文件粒度上响应取消：令牌触发后不再派发新文件，进行中的文件在网络等待点上
//! 停下并清掉自己的临时文件，整批以 [`Error::Cancelled`] 返回。

use std::collections::HashSet;
use std::sync::Arc;
use std::time::Duration;

use tokio::sync::{Semaphore, watch};
use tokio::task::JoinSet;
use tokio_util::sync::CancellationToken;

use crate::engine::Downloader;
use crate::error::{Error, Result};
use crate::progress::{DownloadProgress, ProgressReporter};
use crate::task::DownloadTask;

/// 单个文件的失败记录。
#[derive(Debug)]
pub struct TaskFailure {
    /// 失败的任务。
    pub task: DownloadTask,
    /// 重试并换源后仍未克服的最终错误。
    pub error: Error,
}

/// 一批下载的结果汇总。
#[derive(Debug)]
pub struct BatchReport {
    /// 去重后的任务总数。
    pub total: usize,
    /// 成功数。
    pub succeeded: usize,
    /// 失败明细。
    pub failures: Vec<TaskFailure>,
}

impl BatchReport {
    /// 是否整批无失败。调用方应据此判定这批下载可否进入下一步。
    pub fn is_success(&self) -> bool {
        self.failures.is_empty()
    }
}

/// 批量并发下载池。
pub struct DownloadPool {
    downloader: Downloader,
    file_concurrency: usize,
    sample_interval: Duration,
    progress: Option<watch::Sender<DownloadProgress>>,
    cancel: Option<CancellationToken>,
}

impl DownloadPool {
    /// 用给定引擎与并发上限构造。采样间隔默认 100ms（对齐进度刷新节奏）。
    pub fn new(downloader: Downloader, file_concurrency: usize) -> Self {
        Self {
            downloader,
            file_concurrency: file_concurrency.max(1),
            sample_interval: Duration::from_millis(100),
            progress: None,
            cancel: None,
        }
    }

    /// 覆盖进度采样间隔。
    pub fn with_sample_interval(mut self, interval: Duration) -> Self {
        self.sample_interval = interval;
        self
    }

    /// 给池挂一个默认的进度观察者：`download_all` 没传 `sender` 时每一批都向它推快照。
    ///
    /// 安装流程要连跑好几批（版本 JSON、库、资源），每批由不同的安装器发起、都不传 `sender`；
    /// 挂在池上才能让整条流程的进度都流到同一个观察者。每批的快照各自从 0 计起。
    pub fn with_progress(mut self, sender: watch::Sender<DownloadProgress>) -> Self {
        self.progress = Some(sender);
        self
    }

    /// 给池挂取消令牌：令牌触发后整批以 [`Error::Cancelled`] 返回，临时文件与分片随之清掉。
    pub fn with_cancel(mut self, token: CancellationToken) -> Self {
        self.cancel = Some(token);
        self
    }

    /// 批量下载。`sender` 提供则全程推送进度快照（含起始与最终快照），否则回落到
    /// [`with_progress`](Self::with_progress) 挂的观察者。
    ///
    /// 返回汇总报告：即便有文件失败也返回 `Ok(report)`，失败明细在 `report.failures`。返回 `Err`
    /// 只有三种情况：某个下载任务本身 panic（而非下载失败）、引擎内部不变量被破坏，或取消令牌在
    /// 本批完成前触发。无论哪种，都先等已派发的文件全部收尾再返回。
    /// 调用方务必检查 [`BatchReport::is_success`]。
    pub async fn download_all(
        &self,
        tasks: Vec<DownloadTask>,
        sender: Option<watch::Sender<DownloadProgress>>,
    ) -> Result<BatchReport> {
        let mut tasks = dedup_by_dest(tasks);
        order_largest_first(&mut tasks);
        // 派发的任务只读借用同一份列表，不再逐个克隆；只有失败的任务才克隆进报告。
        let tasks: Arc<[DownloadTask]> = tasks.into();
        let total = tasks.len();
        // 任一任务大小未知即无总量：拿部分和冒充总量，进度条会在最后一刻倒退。
        let total_bytes = tasks.iter().map(|t| t.size).sum::<Option<u64>>();
        let sender = sender.or_else(|| self.progress.clone());
        let reporter = ProgressReporter::new(total as u64, total_bytes, sender);
        reporter.publish(); // 先把 total 发出去，前端立刻能画出「0/total」。

        // 守卫保证本 future 被上层丢弃时采样循环也随之停下，不留一个永远在跑的后台任务。
        let _sampler = if reporter.has_sender() {
            Some(AbortOnDrop(reporter.spawn_sampler(self.sample_interval)))
        } else {
            None
        };

        let semaphore = Arc::new(Semaphore::new(self.file_concurrency));
        let mut set: JoinSet<(usize, Result<()>)> = JoinSet::new();
        let mut dispatched = 0usize;
        // 让整批失败的错误（任务 panic、内部错误）。记下后继续收完已派发的文件，再统一返回。
        let mut fatal: Option<Error> = None;
        for index in 0..total {
            // 先取信号量再 spawn：并发满时在此自然阻塞，起到「文件级并发上限」的节流作用。
            // 等信号量期间取消即停止派发：没开始的文件不产生任何临时文件，无需清理。
            let acquire = semaphore.clone().acquire_owned();
            let acquired = match &self.cancel {
                Some(token) => match token.run_until_cancelled(acquire).await {
                    Some(acquired) => acquired,
                    None => break,
                },
                None => acquire.await,
            };
            // 信号量是本函数的局部变量且从不关闭。
            let Ok(permit) = acquired else {
                fatal = Some(Error::Internal {
                    what: "文件信号量已关闭",
                });
                break;
            };
            let downloader = self.downloader.clone();
            let reporter = reporter.clone();
            let cancel = self.cancel.clone();
            let tasks = tasks.clone();
            set.spawn(async move {
                let _permit = permit;
                let result = downloader
                    .run(&tasks[index], Some(&reporter), cancel.as_ref())
                    .await;
                reporter.finish_file();
                (index, result)
            });
            dispatched += 1;
        }

        // 取消后也要把已派发的文件等完：它们在网络等待点上很快停下并清掉自己的临时文件，
        // 提前返回会让清理与调用方的后续动作（如删除实例目录）赛跑。
        let mut succeeded = 0usize;
        let mut failures = Vec::new();
        while let Some(joined) = set.join_next().await {
            match joined {
                Ok((_, Ok(()))) => succeeded += 1,
                Ok((index, Err(err))) => failures.push(TaskFailure {
                    task: tasks[index].clone(),
                    error: err,
                }),
                Err(join) => {
                    if fatal.is_none() {
                        fatal = Some(Error::TaskJoin(join));
                    }
                }
            }
        }
        reporter.finalize();
        // 两者之差是重传与丢弃分片白传的字节：线路差时这里会明显大于有效字节。
        tracing::info!(
            total,
            succeeded,
            failed = failures.len(),
            effective_bytes = reporter.effective_bytes(),
            transferred_bytes = reporter.transferred_bytes(),
            "批量下载结束"
        );
        if let Some(err) = fatal {
            return Err(err);
        }

        if dispatched < total || failures.iter().any(|f| f.error.is_cancelled()) {
            tracing::debug!(total, dispatched, succeeded, "批量下载已取消");
            return Err(Error::Cancelled);
        }

        Ok(BatchReport {
            total,
            succeeded,
            failures,
        })
    }
}

/// 后台任务句柄：被丢弃时中止任务。
struct AbortOnDrop(tokio::task::JoinHandle<()>);

impl Drop for AbortOnDrop {
    fn drop(&mut self) {
        self.0.abort();
    }
}

/// 按目标路径去重，保留首次出现，丢弃后续同目标任务（下载重复任务检测）。
fn dedup_by_dest(tasks: Vec<DownloadTask>) -> Vec<DownloadTask> {
    let mut seen = HashSet::new();
    let mut out = Vec::with_capacity(tasks.len());
    for task in tasks {
        if seen.insert(task.dest.clone()) {
            out.push(task);
        } else {
            tracing::debug!(dest = %task.dest.display(), "已存在同目标任务，跳过重复入队");
        }
    }
    out
}

/// 最长作业优先：按声明大小从大到小排，大小未知的排最后，同级保持原序。
///
/// 池是固定并发的信号量；按清单原序下发时，收尾阶段往往只剩几个还没跑完的大文件，并发度从
/// 几十掉到个位数，总带宽跟着塌。大的先开工、小的填进空隙，收尾时仍有足够任务在跑——一批整合包
/// 文件里最大的 8 个占了 53.8% 的字节，而 51 个小文件加起来只有 1.6%。估不出耗时的不占前排。
fn order_largest_first(tasks: &mut [DownloadTask]) {
    tasks.sort_by_key(|task| std::cmp::Reverse(task.size));
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn sized(name: &str, size: Option<u64>) -> DownloadTask {
        let task = DownloadTask::new(format!("https://e/{name}"), name);
        match size {
            Some(size) => task.with_size(size),
            None => task,
        }
    }

    fn names(tasks: &[DownloadTask]) -> Vec<&str> {
        tasks.iter().map(|t| t.dest.to_str().unwrap()).collect()
    }

    #[test]
    fn largest_tasks_are_dispatched_first() {
        let mut tasks = vec![
            sized("small", Some(1)),
            sized("huge", Some(1 << 30)),
            sized("mid", Some(1 << 20)),
        ];
        order_largest_first(&mut tasks);
        assert_eq!(names(&tasks), vec!["huge", "mid", "small"]);
    }

    #[test]
    fn unknown_sizes_go_last_and_ties_keep_input_order() {
        let mut tasks = vec![
            sized("unknown-a", None),
            sized("tie-a", Some(10)),
            sized("big", Some(999)),
            sized("unknown-b", None),
            sized("tie-b", Some(10)),
            sized("zero", Some(0)),
        ];
        order_largest_first(&mut tasks);
        assert_eq!(
            names(&tasks),
            vec!["big", "tie-a", "tie-b", "zero", "unknown-a", "unknown-b"]
        );
    }

    #[test]
    fn ordering_empty_or_single_is_a_no_op() {
        let mut empty: Vec<DownloadTask> = Vec::new();
        order_largest_first(&mut empty);
        assert!(empty.is_empty());
        let mut one = vec![sized("only", Some(5))];
        order_largest_first(&mut one);
        assert_eq!(names(&one), vec!["only"]);
    }

    #[test]
    fn dedup_keeps_first_by_dest() {
        let tasks = vec![
            DownloadTask::new("https://a/1", "out/x.jar"),
            DownloadTask::new("https://b/2", "out/x.jar"), // 同目标，丢弃
            DownloadTask::new("https://c/3", "out/y.jar"),
        ];
        let deduped = dedup_by_dest(tasks);
        assert_eq!(deduped.len(), 2);
        assert_eq!(deduped[0].url, "https://a/1");
        assert_eq!(deduped[0].dest, PathBuf::from("out/x.jar"));
        assert_eq!(deduped[1].dest, PathBuf::from("out/y.jar"));
    }

    #[test]
    fn empty_report_is_success() {
        let report = BatchReport {
            total: 0,
            succeeded: 0,
            failures: Vec::new(),
        };
        assert!(report.is_success());
    }
}
