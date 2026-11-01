//! 长任务的取消与任务日志的读写。登记表与日志的实现在 [`crate::tasks`]。

use serde_json::{Map, Value};
use tauri::State;

use crate::commands::CommandError;
use crate::facade::Facade;
use crate::tasks::{JournalSnapshot, TaskJournal, TaskRegistry};

/// 取消一个运行中的长任务。返回该任务此刻是否在运行；不在运行（已结束或尚未登记）时返回
/// `false`，这不是错误——取消与任务自然结束本来就会赛跑。被取消的命令在 1000 ms 内以
/// `{ code: "cancelled" }` 返回。
#[tauri::command]
pub async fn cancel_task(
    task_id: String,
    tasks: State<'_, TaskRegistry>,
) -> Result<bool, CommandError> {
    Ok(tasks.cancel(&task_id))
}

/// 整份写入前端任务表到 `<数据目录>/tasks.json`。每项必须带非空、互不重复的字符串 `id`。
///
/// `seq` 是前端给这份的序号，从 1 起单调递增。不比已落盘那份的序号大时，这份是晚到的旧版本，
/// 丢弃而不报错：更新的那份已经在盘上了。
#[tauri::command]
pub async fn save_task_journal(
    seq: u64,
    tasks: Vec<Map<String, Value>>,
    facade: State<'_, Facade>,
    journal: State<'_, TaskJournal>,
) -> Result<(), CommandError> {
    let data_dir = facade.read().await.data_dir().to_path_buf();
    journal.save(&data_dir, seq, tasks).await?;
    Ok(())
}

/// 读回任务表与它的序号 `{ seq, tasks }`。从未写过时为 `{ seq: 0, tasks: [] }`；
/// 文件损坏或版本不符报 `task_journal_invalid`。
#[tauri::command]
pub async fn load_task_journal(
    facade: State<'_, Facade>,
    journal: State<'_, TaskJournal>,
) -> Result<JournalSnapshot, CommandError> {
    let data_dir = facade.read().await.data_dir().to_path_buf();
    journal.load(&data_dir).await
}
