//! 长任务的登记、取消与任务日志。
//!
//! 前端下载队列给每次长命令调用（安装版本、装 Mod、装 Java、启动……）分配一个 `task_id`。命令开头
//! 用 [`TaskRegistry::register`] 登记，拿到的 [`TaskHandle`] 持有取消令牌；令牌挂到门面快照上
//! （`Aurora::with_cancel`），下载引擎在文件粒度观察它。`cancel_task` 触发令牌后，命令在
//! [`CANCEL_DEADLINE`] 内以 `cancelled` 返回：协作取消通常几毫秒就停（Forge 处理器子进程也会被
//! 结束并等它退出），个别不观察令牌的阶段（Java 探测）由 [`TaskHandle::run`] 在宽限期满后强行放弃。
//!
//! 任务日志是前端任务表的持久化：后端不解读任务内容，只保证整份原子写入、版本校验，以及按前端给的
//! 序号只留下更新的那份。

use std::collections::{HashMap, VecDeque};
use std::future::Future;
use std::path::Path;
use std::sync::Mutex;
use std::time::Duration;

use aurora_core::{BaseError, CancellationToken};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};

use crate::commands::error::{code, CommandError};

/// 取消到命令返回的上限，对前端承诺的值。
pub const CANCEL_DEADLINE: Duration = Duration::from_millis(1000);

/// 取消后等任务自己停下的宽限。比 [`CANCEL_DEADLINE`] 短 200 ms，给事件转发收尾（最多一个进度节流
/// 间隔）与 IPC 往返留出余量。
const CANCEL_GRACE: Duration = CANCEL_DEADLINE.saturating_sub(Duration::from_millis(200));

/// 记住多少个「取消先于登记到达」的任务 id。
///
/// 前端 invoke 长命令与 cancel_task 是两个并发的 IPC 调用，用户手快时取消可能先到；记下它，
/// 命令随后登记时直接拿到已取消的令牌。只记最近这么多个，旧的挤掉，内存有界。
const EARLY_CANCEL_MEMORY: usize = 64;

/// 运行中长任务的登记表：`task_id` 到取消令牌。
#[derive(Default)]
pub struct TaskRegistry {
    state: Mutex<RegistryState>,
}

#[derive(Default)]
struct RegistryState {
    running: HashMap<String, CancellationToken>,
    cancelled_early: VecDeque<String>,
}

impl TaskRegistry {
    fn state(&self) -> std::sync::MutexGuard<'_, RegistryState> {
        // 临界区里只有 HashMap / VecDeque 的增删，不会 panic；真中毒说明程序已处于未知状态，直接崩。
        self.state.lock().expect("任务登记表的锁已中毒")
    }

    /// 登记一个长任务。同一 id 已在运行时报 `task_conflict`；空 id 报 `invalid_argument`。
    ///
    /// 返回的句柄被丢弃时自动注销，命令无论成功、失败还是 panic 都不会留下孤儿登记。
    pub fn register(&self, task_id: &str) -> Result<TaskHandle<'_>, CommandError> {
        if task_id.trim().is_empty() {
            return Err(CommandError::invalid_argument("task_id 不能为空"));
        }
        let mut state = self.state();
        if state.running.contains_key(task_id) {
            return Err(
                CommandError::new(code::TASK_CONFLICT, format!("任务 {task_id} 已在运行"))
                    .with_detail(json!({ "task_id": task_id })),
            );
        }
        let token = CancellationToken::new();
        if let Some(pos) = state.cancelled_early.iter().position(|id| id == task_id) {
            state.cancelled_early.remove(pos);
            tracing::info!(task_id, "任务登记前已收到取消");
            token.cancel();
        }
        state.running.insert(task_id.to_owned(), token.clone());
        Ok(TaskHandle {
            registry: self,
            id: task_id.to_owned(),
            token,
        })
    }

    /// 取消一个任务。返回该任务此刻是否在运行。
    ///
    /// 不在运行时（已结束，或取消先于登记到达）记下这个 id，之后同 id 的登记直接拿到已取消的令牌，
    /// 因此前端每次调用长命令都应使用新的 id（重试也换新 id）。
    pub fn cancel(&self, task_id: &str) -> bool {
        let mut state = self.state();
        if let Some(token) = state.running.get(task_id) {
            token.cancel();
            tracing::info!(task_id, "已发出取消");
            return true;
        }
        if !state.cancelled_early.iter().any(|id| id == task_id) {
            if state.cancelled_early.len() == EARLY_CANCEL_MEMORY {
                state.cancelled_early.pop_front();
            }
            state.cancelled_early.push_back(task_id.to_owned());
        }
        tracing::info!(task_id, "取消的任务不在运行，已记下以防登记晚到");
        false
    }

    /// 该 id 是否正在运行。
    #[cfg(test)]
    pub fn is_running(&self, task_id: &str) -> bool {
        self.state().running.contains_key(task_id)
    }
}

/// 一个已登记的长任务；丢弃即注销。
pub struct TaskHandle<'a> {
    registry: &'a TaskRegistry,
    id: String,
    token: CancellationToken,
}

impl TaskHandle<'_> {
    /// 这个任务的取消令牌，挂到门面快照上：`facade.snapshot().await.with_cancel(task.token().clone())`。
    pub fn token(&self) -> &CancellationToken {
        &self.token
    }

    /// 在取消语义下执行任务主体。
    ///
    /// - 未取消：原样返回主体的结果。
    /// - 取消后主体在宽限期内结束：主体若成功仍返回成功（取消晚了一步，活已经干完）；
    ///   主体若失败一律报 `cancelled`——取消之后出现的失败都是取消造成的。
    /// - 宽限期满主体仍未结束：丢弃主体，报 `cancelled`。
    pub async fn run<T>(
        &self,
        work: impl Future<Output = Result<T, CommandError>>,
    ) -> Result<T, CommandError> {
        let mut work = std::pin::pin!(work);
        let outcome = match self.token.run_until_cancelled(work.as_mut()).await {
            Some(outcome) => outcome,
            None => match tokio::time::timeout(CANCEL_GRACE, work.as_mut()).await {
                Ok(outcome) => outcome,
                Err(_) => {
                    tracing::warn!(task_id = %self.id, "取消后任务未在宽限期内停下，已强行放弃");
                    return Err(CommandError::cancelled());
                }
            },
        };
        match outcome {
            Err(err) if self.token.is_cancelled() && !err.is_cancelled() => {
                tracing::info!(task_id = %self.id, code = err.code, "取消后任务以失败结束，按取消上报");
                Err(CommandError::cancelled())
            }
            other => other,
        }
    }
}

impl Drop for TaskHandle<'_> {
    fn drop(&mut self) {
        self.registry.state().running.remove(&self.id);
    }
}

/// 任务日志文件名，位于数据目录下。
pub const TASK_JOURNAL_FILE: &str = "tasks.json";

/// 任务日志的格式版本；前端任务结构不兼容地变化时递增，旧文件读出即报错而不是被误读。
const TASK_JOURNAL_VERSION: u32 = 1;

#[derive(Serialize, Deserialize)]
struct JournalFile {
    version: u32,
    /// 写下这份的前端序号。加序号之前写的日志没有这一项，按 0 读：比任何一次新写入都旧。
    #[serde(default)]
    seq: u64,
    tasks: Vec<Map<String, Value>>,
}

/// 读回的任务日志。
#[derive(Debug, PartialEq, Serialize)]
pub struct JournalSnapshot {
    /// 已落盘那份的序号；从未写过或加序号之前写的日志为 0。前端此后的写入从它之后接着编。
    pub seq: u64,
    pub tasks: Vec<Map<String, Value>>,
}

/// 盘上那份日志的状态。
enum Stored {
    Missing,
    /// 损坏或版本不符，附上说明。
    Invalid(String),
    Valid(JournalFile),
}

/// 任务日志的读写。
///
/// 前端防抖写入与关窗前的立即写入可能并发到达，两次 IPC 谁先拿到锁不确定，光靠串行会让先发出的那份
/// 后写、盖掉更新的那份。所以前端给每份带单调递增的序号，写入在锁内比对已落盘的序号，只接受更新的。
#[derive(Default)]
pub struct TaskJournal {
    write: tokio::sync::Mutex<()>,
}

impl TaskJournal {
    /// 整份写入任务表，返回这份是否真的落了盘。
    ///
    /// `seq` 从 1 起；不比已落盘那份的序号大时，这份是晚到的旧版本，丢弃并返回 `false`。
    /// 每个任务必须带非空、互不重复的字符串 `id`。
    pub async fn save(
        &self,
        data_dir: &Path,
        seq: u64,
        tasks: Vec<Map<String, Value>>,
    ) -> Result<bool, CommandError> {
        if seq == 0 {
            return Err(CommandError::invalid_argument(
                "任务日志的序号从 1 起，收到 0",
            ));
        }
        let mut seen = std::collections::HashSet::new();
        for (index, task) in tasks.iter().enumerate() {
            match task.get("id").and_then(Value::as_str) {
                Some(id) if !id.is_empty() => {
                    if !seen.insert(id) {
                        return Err(CommandError::invalid_argument(format!(
                            "任务日志里 id {id} 出现了不止一次"
                        )));
                    }
                }
                _ => {
                    return Err(CommandError::invalid_argument(format!(
                        "任务日志第 {index} 项缺少字符串 id"
                    )))
                }
            }
        }
        let path = data_dir.join(TASK_JOURNAL_FILE);
        let file = JournalFile {
            version: TASK_JOURNAL_VERSION,
            seq,
            tasks,
        };
        let bytes = serde_json::to_vec_pretty(&file).map_err(|err| {
            CommandError::new(code::INTERNAL, format!("序列化任务日志失败：{err}"))
        })?;
        let _guard = self.write.lock().await;
        let committed = match read_stored(&path).await? {
            Stored::Missing => 0,
            // 前端读到 task_journal_invalid 后照常写回，用新表覆盖这份救不回来的文件；
            // 它里面的序号不可信，不能挡住这次恢复。
            Stored::Invalid(reason) => {
                tracing::warn!(seq, %reason, "已落盘的任务日志读不出来，这次写入将覆盖它");
                0
            }
            Stored::Valid(stored) => stored.seq,
        };
        if seq <= committed {
            tracing::debug!(seq, committed, "任务日志晚到的旧版本，已丢弃");
            return Ok(false);
        }
        aurora_base::fs::atomic_write(&path, &bytes).await?;
        Ok(true)
    }

    /// 读回任务表与它的序号。文件不存在（从未写过）返回序号 0 的空表；内容损坏或版本不符报
    /// `task_journal_invalid`。
    ///
    /// 与写入同用一把锁：已经到达、还在排队的写入先落盘，读回的序号才是前端接着编号的正确起点。
    /// 否则窗口重载时上一个页面最后的那次写入可能晚于读取落盘，新页面的第一份会拿到同一个序号而被丢弃。
    pub async fn load(&self, data_dir: &Path) -> Result<JournalSnapshot, CommandError> {
        let path = data_dir.join(TASK_JOURNAL_FILE);
        let _guard = self.write.lock().await;
        match read_stored(&path).await? {
            Stored::Missing => Ok(JournalSnapshot {
                seq: 0,
                tasks: Vec::new(),
            }),
            Stored::Invalid(message) => Err(CommandError::new(code::TASK_JOURNAL_INVALID, message)
                .with_detail(json!({ "path": path.display().to_string() }))),
            Stored::Valid(file) => Ok(JournalSnapshot {
                seq: file.seq,
                tasks: file.tasks,
            }),
        }
    }
}

/// 读盘上那份日志。读不了（不是不存在）时报 IO 错误。
async fn read_stored(path: &Path) -> Result<Stored, CommandError> {
    let bytes = match tokio::fs::read(path).await {
        Ok(bytes) => bytes,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(Stored::Missing),
        Err(source) => {
            return Err(BaseError::Io {
                path: path.to_owned(),
                source,
            }
            .into())
        }
    };
    let file: JournalFile = match serde_json::from_slice(&bytes) {
        Ok(file) => file,
        Err(err) => {
            return Ok(Stored::Invalid(format!(
                "任务日志 {} 已损坏：{err}",
                path.display()
            )))
        }
    };
    if file.version != TASK_JOURNAL_VERSION {
        return Ok(Stored::Invalid(format!(
            "任务日志 {} 的版本是 {}，当前只认 {TASK_JOURNAL_VERSION}",
            path.display(),
            file.version
        )));
    }
    Ok(Stored::Valid(file))
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::time::Instant;

    #[test]
    fn handle_unregisters_on_drop_and_duplicates_conflict() {
        let registry = TaskRegistry::default();
        let handle = registry.register("t1").unwrap();
        assert!(registry.is_running("t1"));

        let err = registry.register("t1").err().expect("同 id 不能重复登记");
        assert_eq!(err.code, code::TASK_CONFLICT);
        assert_eq!(err.detail.unwrap()["task_id"], json!("t1"));

        drop(handle);
        assert!(!registry.is_running("t1"));
        // 注销后同 id 可以再登记。
        assert!(registry.register("t1").is_ok());
    }

    #[test]
    fn blank_task_id_is_rejected() {
        let registry = TaskRegistry::default();
        for blank in ["", "   "] {
            let err = registry.register(blank).err().unwrap();
            assert_eq!(err.code, code::INVALID_ARGUMENT);
        }
    }

    #[test]
    fn cancel_signals_only_the_named_running_task() {
        let registry = TaskRegistry::default();
        let a = registry.register("a").unwrap();
        let b = registry.register("b").unwrap();
        assert!(registry.cancel("a"));
        assert!(a.token().is_cancelled());
        assert!(!b.token().is_cancelled());
        assert!(!registry.cancel("missing"));
    }

    #[test]
    fn cancel_arriving_before_register_is_honoured() {
        let registry = TaskRegistry::default();
        assert!(!registry.cancel("early"), "此刻还没登记");
        let handle = registry.register("early").unwrap();
        assert!(
            handle.token().is_cancelled(),
            "登记时应直接拿到已取消的令牌"
        );
        drop(handle);
        // 记忆只生效一次：再次登记同 id 是全新的任务。
        assert!(!registry.register("early").unwrap().token().is_cancelled());
    }

    #[test]
    fn early_cancel_memory_is_bounded() {
        let registry = TaskRegistry::default();
        for i in 0..=EARLY_CANCEL_MEMORY {
            registry.cancel(&format!("ghost-{i}"));
        }
        // 第 0 个被挤掉，第 1 个还在。
        assert!(!registry.register("ghost-0").unwrap().token().is_cancelled());
        assert!(registry.register("ghost-1").unwrap().token().is_cancelled());
    }

    #[tokio::test]
    async fn run_returns_work_result_when_not_cancelled() {
        let registry = TaskRegistry::default();
        let task = registry.register("ok").unwrap();
        let value = task.run(async { Ok::<_, CommandError>(42) }).await.unwrap();
        assert_eq!(value, 42);
        let err = task
            .run(async { Err::<(), _>(CommandError::invalid_argument("坏参数")) })
            .await
            .unwrap_err();
        assert_eq!(err.code, code::INVALID_ARGUMENT, "未取消时失败原样上报");
    }

    /// 主体完全不看令牌（模拟 Java 探测这类阶段）：宽限期满后强行放弃，仍在时限内返回。
    /// 时钟暂停，下面的时长都是定时器之间的先后，不是实际耗时，机器再忙也不差分毫。
    #[tokio::test(start_paused = true)]
    async fn run_abandons_work_that_ignores_the_token() {
        let registry = TaskRegistry::default();
        let task = registry.register("stubborn").unwrap();
        let token = task.token().clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(100)).await;
            token.cancel();
        });
        let started = Instant::now();
        let err = task
            .run(async {
                tokio::time::sleep(Duration::from_secs(30)).await;
                Ok::<_, CommandError>(())
            })
            .await
            .unwrap_err();
        let elapsed = started.elapsed();
        assert!(err.is_cancelled());
        assert!(
            elapsed < Duration::from_millis(100) + CANCEL_DEADLINE,
            "取消后 {elapsed:?} 才返回"
        );
        assert!(elapsed >= Duration::from_millis(100) + CANCEL_GRACE);
    }

    /// 取消之后主体以别的错误结束（例如连接被掐断报网络错）：按取消上报。
    #[tokio::test]
    async fn failure_after_cancel_is_reported_as_cancelled() {
        let registry = TaskRegistry::default();
        let task = registry.register("late-fail").unwrap();
        let token = task.token().clone();
        let err = task
            .run(async move {
                token.cancel();
                tokio::time::sleep(Duration::from_millis(20)).await;
                Err::<(), _>(CommandError::new(code::DOWNLOAD_FAILED, "连接被重置"))
            })
            .await
            .unwrap_err();
        assert!(err.is_cancelled());
    }

    /// 取消晚了一步、主体已经成功：如实返回成功。
    #[tokio::test]
    async fn success_racing_cancel_is_kept() {
        let registry = TaskRegistry::default();
        let task = registry.register("raced").unwrap();
        let token = task.token().clone();
        let value = task
            .run(async move {
                token.cancel();
                Ok::<_, CommandError>("done")
            })
            .await
            .unwrap();
        assert_eq!(value, "done");
    }

    fn task(id: &str, status: &str) -> Map<String, Value> {
        let Value::Object(map) = json!({ "id": id, "status": status, "attempt": 1 }) else {
            unreachable!()
        };
        map
    }

    #[tokio::test]
    async fn journal_roundtrips_and_missing_file_is_empty() {
        let dir = tempfile::tempdir().unwrap();
        let journal = TaskJournal::default();
        assert_eq!(
            journal.load(dir.path()).await.unwrap(),
            JournalSnapshot {
                seq: 0,
                tasks: Vec::new()
            }
        );

        let tasks = vec![task("a", "running"), task("b", "done")];
        assert!(journal.save(dir.path(), 1, tasks.clone()).await.unwrap());
        assert_eq!(
            journal.load(dir.path()).await.unwrap(),
            JournalSnapshot { seq: 1, tasks }
        );

        // 落在数据目录的 tasks.json，带版本号与序号。
        let raw: Value =
            serde_json::from_slice(&std::fs::read(dir.path().join("tasks.json")).unwrap()).unwrap();
        assert_eq!(raw["version"], json!(1));
        assert_eq!(raw["seq"], json!(1));
        assert_eq!(raw["tasks"][1]["id"], json!("b"));

        // 空表也能写回（清空已结束任务后）。
        assert!(journal.save(dir.path(), 2, Vec::new()).await.unwrap());
        assert_eq!(
            journal.load(dir.path()).await.unwrap(),
            JournalSnapshot {
                seq: 2,
                tasks: Vec::new()
            }
        );
    }

    #[tokio::test]
    async fn corrupt_or_foreign_journal_is_an_error() {
        let dir = tempfile::tempdir().unwrap();
        let journal = TaskJournal::default();
        let path = dir.path().join(TASK_JOURNAL_FILE);

        std::fs::write(&path, b"{ not json").unwrap();
        let err = journal.load(dir.path()).await.unwrap_err();
        assert_eq!(err.code, code::TASK_JOURNAL_INVALID);
        assert_eq!(
            err.detail.unwrap()["path"],
            json!(path.display().to_string())
        );

        std::fs::write(&path, br#"{"version": 2, "tasks": []}"#).unwrap();
        let err = journal.load(dir.path()).await.unwrap_err();
        assert_eq!(err.code, code::TASK_JOURNAL_INVALID);
    }

    #[tokio::test]
    async fn journal_rejects_tasks_without_unique_ids() {
        let dir = tempfile::tempdir().unwrap();
        let journal = TaskJournal::default();

        let mut no_id = task("x", "done");
        no_id.remove("id");
        let err = journal.save(dir.path(), 1, vec![no_id]).await.unwrap_err();
        assert_eq!(err.code, code::INVALID_ARGUMENT);

        let dup = vec![task("x", "done"), task("x", "failed")];
        let err = journal.save(dir.path(), 1, dup).await.unwrap_err();
        assert_eq!(err.code, code::INVALID_ARGUMENT);
        // 校验失败不落盘。
        assert!(!dir.path().join(TASK_JOURNAL_FILE).exists());
    }

    /// 内容带上序号，读回时能认出留下的是哪一份。
    fn table(seq: u64) -> Vec<Map<String, Value>> {
        vec![task(&format!("t{seq}"), "running"), task("history", "done")]
    }

    #[tokio::test]
    async fn out_of_order_saves_keep_the_higher_seq() {
        let dir = tempfile::tempdir().unwrap();
        let journal = TaskJournal::default();

        // 后发出的 2 号先到，先发出的 1 号晚到：晚到的旧表不能盖掉新表。
        assert!(journal.save(dir.path(), 2, table(2)).await.unwrap());
        assert!(!journal.save(dir.path(), 1, table(1)).await.unwrap());
        assert_eq!(
            journal.load(dir.path()).await.unwrap(),
            JournalSnapshot {
                seq: 2,
                tasks: table(2)
            }
        );

        // 与已落盘的序号相同也不是更新的一份。
        assert!(!journal.save(dir.path(), 2, Vec::new()).await.unwrap());
        assert_eq!(journal.load(dir.path()).await.unwrap().tasks, table(2));

        // 紧接着的下一号照常写下。
        assert!(journal.save(dir.path(), 3, table(3)).await.unwrap());
        assert_eq!(
            journal.load(dir.path()).await.unwrap(),
            JournalSnapshot {
                seq: 3,
                tasks: table(3)
            }
        );
    }

    /// 一批写入以随机次序同时到达：不管谁先拿到锁，最后盘上都是序号最大的那份，且它一定写下了。
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn concurrent_saves_leave_the_highest_seq() {
        use std::hash::{BuildHasher, Hasher};

        const COUNT: u64 = 24;
        let seed = std::collections::hash_map::RandomState::new()
            .build_hasher()
            .finish()
            | 1;
        let mut state = seed;
        let mut order: Vec<u64> = (1..=COUNT).collect();
        for i in (1..order.len()).rev() {
            state ^= state << 13;
            state ^= state >> 7;
            state ^= state << 17;
            order.swap(i, (state % (i as u64 + 1)) as usize);
        }

        let dir = tempfile::tempdir().unwrap();
        let journal = std::sync::Arc::new(TaskJournal::default());
        let saves: Vec<_> = order
            .iter()
            .map(|&seq| {
                let journal = journal.clone();
                let path = dir.path().to_owned();
                tokio::spawn(async move { (seq, journal.save(&path, seq, table(seq)).await) })
            })
            .collect();
        let mut written = Vec::new();
        for save in saves {
            let (seq, outcome) = save.await.unwrap();
            if outcome.unwrap() {
                written.push(seq);
            }
        }

        assert!(
            written.contains(&COUNT),
            "种子 {seed}，次序 {order:?}：最大序号没有写下，写下的是 {written:?}"
        );
        assert_eq!(
            journal.load(dir.path()).await.unwrap(),
            JournalSnapshot {
                seq: COUNT,
                tasks: table(COUNT)
            },
            "种子 {seed}，次序 {order:?}"
        );
    }

    #[tokio::test]
    async fn journal_written_before_seq_existed_is_readable_and_superseded() {
        let dir = tempfile::tempdir().unwrap();
        let journal = TaskJournal::default();
        std::fs::write(
            dir.path().join(TASK_JOURNAL_FILE),
            br#"{"version": 1, "tasks": [{"id": "old", "status": "done", "attempt": 1}]}"#,
        )
        .unwrap();

        assert_eq!(
            journal.load(dir.path()).await.unwrap(),
            JournalSnapshot {
                seq: 0,
                tasks: vec![task("old", "done")]
            }
        );
        // 前端从 0 之后接着编，第一份 1 号就比它新。
        assert!(journal.save(dir.path(), 1, table(1)).await.unwrap());
        assert_eq!(journal.load(dir.path()).await.unwrap().tasks, table(1));
    }

    #[tokio::test]
    async fn zero_seq_is_rejected_and_nothing_is_written() {
        let dir = tempfile::tempdir().unwrap();
        let journal = TaskJournal::default();
        let err = journal.save(dir.path(), 0, table(0)).await.unwrap_err();
        assert_eq!(err.code, code::INVALID_ARGUMENT);
        assert!(!dir.path().join(TASK_JOURNAL_FILE).exists());
    }

    /// 读不出来的日志里的序号不可信：前端此时从 1 编起，照样能用新表把它覆盖掉。
    #[tokio::test]
    async fn unreadable_journal_does_not_block_the_overwrite() {
        let dir = tempfile::tempdir().unwrap();
        let journal = TaskJournal::default();
        let path = dir.path().join(TASK_JOURNAL_FILE);

        for unreadable in [
            br#"{"version": 1, "seq": 50, "tasks": "#.as_slice(),
            br#"{"version": 2, "seq": 50, "tasks": []}"#.as_slice(),
        ] {
            std::fs::write(&path, unreadable).unwrap();
            assert!(journal.save(dir.path(), 1, table(1)).await.unwrap());
            assert_eq!(
                journal.load(dir.path()).await.unwrap(),
                JournalSnapshot {
                    seq: 1,
                    tasks: table(1)
                }
            );
        }
    }

    /// 读取要等已经排上队的写入落盘，读回的序号才不会落后于实际。
    #[tokio::test]
    async fn load_waits_for_a_save_holding_the_lock() {
        let dir = tempfile::tempdir().unwrap();
        let journal = std::sync::Arc::new(TaskJournal::default());
        assert!(journal.save(dir.path(), 4, table(4)).await.unwrap());

        let guard = journal.write.lock().await;
        let load = tokio::spawn({
            let journal = journal.clone();
            let path = dir.path().to_owned();
            async move { journal.load(&path).await }
        });
        tokio::time::sleep(Duration::from_millis(50)).await;
        assert!(!load.is_finished(), "写入持锁期间读取不应返回");
        // 模拟持锁的那次写入落盘。
        let landed = JournalFile {
            version: TASK_JOURNAL_VERSION,
            seq: 5,
            tasks: table(5),
        };
        std::fs::write(
            dir.path().join(TASK_JOURNAL_FILE),
            serde_json::to_vec(&landed).unwrap(),
        )
        .unwrap();
        drop(guard);

        assert_eq!(
            load.await.unwrap().unwrap(),
            JournalSnapshot {
                seq: 5,
                tasks: table(5)
            }
        );
    }
}
