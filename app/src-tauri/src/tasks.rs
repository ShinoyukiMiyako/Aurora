//! 长任务的登记、取消与任务日志。
//!
//! 前端下载队列给每次长命令调用（安装版本、装 Mod、装 Java、启动……）分配一个 `task_id`。命令开头
//! 用 [`TaskRegistry::register`] 登记，拿到的 [`TaskHandle`] 持有取消令牌；令牌挂到门面快照上
//! （`Aurora::with_cancel`），下载引擎在文件粒度观察它。`cancel_task` 触发令牌后，命令在
//! [`CANCEL_DEADLINE`] 内以 `cancelled` 返回：协作取消通常几毫秒就停，个别不观察令牌的阶段
//! （Forge 处理器、Java 探测）由 [`TaskHandle::run`] 在宽限期满后强行放弃。
//!
//! 任务日志是前端任务表的持久化：后端不解读任务内容，只保证整份原子写入与版本校验。

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
    tasks: Vec<Map<String, Value>>,
}

/// 任务日志的读写。写入串行化：前端防抖写入与关窗前的立即写入可能并发到达，
/// 两次原子写各自的临时文件互不干扰，但谁最后 rename 不确定，串行才能保证后到的那份留下。
#[derive(Default)]
pub struct TaskJournal {
    write: tokio::sync::Mutex<()>,
}

impl TaskJournal {
    /// 整份写入任务表。每个任务必须带非空、互不重复的字符串 `id`。
    pub async fn save(
        &self,
        data_dir: &Path,
        tasks: Vec<Map<String, Value>>,
    ) -> Result<(), CommandError> {
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
        let file = JournalFile {
            version: TASK_JOURNAL_VERSION,
            tasks,
        };
        let bytes = serde_json::to_vec_pretty(&file).map_err(|err| {
            CommandError::new(code::INTERNAL, format!("序列化任务日志失败：{err}"))
        })?;
        let _guard = self.write.lock().await;
        aurora_base::fs::atomic_write(data_dir.join(TASK_JOURNAL_FILE), &bytes)
            .await
            .map_err(CommandError::from)
    }

    /// 读回任务表。文件不存在（从未写过）返回空表；内容损坏或版本不符报 `task_journal_invalid`。
    pub async fn load(&self, data_dir: &Path) -> Result<Vec<Map<String, Value>>, CommandError> {
        let path = data_dir.join(TASK_JOURNAL_FILE);
        let bytes = match tokio::fs::read(&path).await {
            Ok(bytes) => bytes,
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(source) => {
                return Err(BaseError::Io {
                    path: path.clone(),
                    source,
                }
                .into())
            }
        };
        let invalid = |message: String| {
            CommandError::new(code::TASK_JOURNAL_INVALID, message)
                .with_detail(json!({ "path": path.display().to_string() }))
        };
        let file: JournalFile = serde_json::from_slice(&bytes)
            .map_err(|err| invalid(format!("任务日志 {} 已损坏：{err}", path.display())))?;
        if file.version != TASK_JOURNAL_VERSION {
            return Err(invalid(format!(
                "任务日志 {} 的版本是 {}，当前只认 {TASK_JOURNAL_VERSION}",
                path.display(),
                file.version
            )));
        }
        Ok(file.tasks)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Instant;

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

    /// 主体完全不看令牌（模拟 Forge 处理器这类阶段）：宽限期满后强行放弃，仍在时限内返回。
    #[tokio::test]
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
        assert!(journal.load(dir.path()).await.unwrap().is_empty());

        let tasks = vec![task("a", "running"), task("b", "done")];
        journal.save(dir.path(), tasks.clone()).await.unwrap();
        assert_eq!(journal.load(dir.path()).await.unwrap(), tasks);

        // 落在数据目录的 tasks.json，带版本号。
        let raw: Value =
            serde_json::from_slice(&std::fs::read(dir.path().join("tasks.json")).unwrap()).unwrap();
        assert_eq!(raw["version"], json!(1));
        assert_eq!(raw["tasks"][1]["id"], json!("b"));

        // 空表也能写回（清空已结束任务后）。
        journal.save(dir.path(), Vec::new()).await.unwrap();
        assert!(journal.load(dir.path()).await.unwrap().is_empty());
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
        let err = journal.save(dir.path(), vec![no_id]).await.unwrap_err();
        assert_eq!(err.code, code::INVALID_ARGUMENT);

        let dup = vec![task("x", "done"), task("x", "failed")];
        let err = journal.save(dir.path(), dup).await.unwrap_err();
        assert_eq!(err.code, code::INVALID_ARGUMENT);
        // 校验失败不落盘。
        assert!(!dir.path().join(TASK_JOURNAL_FILE).exists());
    }
}
