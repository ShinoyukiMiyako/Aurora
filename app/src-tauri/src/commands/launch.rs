//! 启动与结束游戏。
//!
//! 启动的 `task_id` 只是取消句柄：加载阶段（补 Java、拼命令）可经 `cancel_task` 取消；启动不进前端
//! 下载队列，所以它的 core-event 不带 `task_id`，前端把这些事件归给启动会话。

use aurora_core::{GameSession, LaunchOptions, LogLine, LogStream};
use serde::Serialize;
use tauri::{AppHandle, State};
use tokio::sync::Mutex;

use crate::commands::accounts::{ensure_fresh, find_account};
use crate::commands::CommandError;
use crate::events::{self, CoreEventForwarder, GAME_LOG_EVENT};
use crate::facade::Facade;
use crate::tasks::TaskRegistry;

/// 运行中的游戏会话槽：启动时存入，`stop_game` 取出后结束进程。
///
/// 与门面分列两个 managed state：会话生命周期独立于门面，启动后门面锁应立即可用。
#[derive(Default)]
pub struct RunningGame(Mutex<Option<GameSession>>);

/// 启动成功 DTO：仅回传进程 id（会话本体存于后端，不过 IPC）。
#[derive(Debug, Serialize)]
pub struct LaunchedDto {
    pub pid: Option<u32>,
}

/// 游戏进程一行输出 DTO（经 [`GAME_LOG_EVENT`] 推送）。
#[derive(Debug, Serialize, Clone)]
pub struct GameLogDto {
    /// 来源流：stdout / stderr。
    pub stream: String,
    pub text: String,
}

impl From<LogLine> for GameLogDto {
    fn from(line: LogLine) -> Self {
        GameLogDto {
            stream: match line.stream {
                LogStream::Stdout => "stdout",
                LogStream::Stderr => "stderr",
            }
            .to_owned(),
            text: line.text,
        }
    }
}

/// 启动一个已安装版本。给定 `account_uuid` 走在线账户启动，否则用 `offline_name` 走离线启动
/// （两者都缺报 `invalid_argument`，不静默兜底）。
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn launch_game(
    app: AppHandle,
    task_id: String,
    version_id: String,
    account_uuid: Option<String>,
    offline_name: Option<String>,
    max_memory_mb: Option<u32>,
    min_memory_mb: Option<u32>,
    fullscreen: bool,
    extra_jvm_args: Vec<String>,
    extra_game_args: Vec<String>,
    resolution: Option<(u32, u32)>,
    demo: bool,
    facade: State<'_, Facade>,
    tasks: State<'_, TaskRegistry>,
    running: State<'_, RunningGame>,
) -> Result<LaunchedDto, CommandError> {
    let options = LaunchOptions {
        max_memory_mb,
        min_memory_mb,
        fullscreen,
        extra_jvm_args,
        extra_game_args,
        resolution,
        demo,
    };

    // 游戏进程逐行输出 -> game-log。转发任务寿命随游戏进程：进程退出、管道关闭后读取端放掉发送端，
    // 通道随之关闭、转发任务自然结束，故此处 spawn 后不 await（await 会阻塞到游戏退出）。
    let (log_tx, mut log_rx) = tokio::sync::mpsc::channel::<LogLine>(256);
    let log_app = app.clone();
    tauri::async_runtime::spawn(async move {
        while let Some(line) = log_rx.recv().await {
            events::emit(&log_app, GAME_LOG_EVENT, GameLogDto::from(line));
        }
    });

    let events = CoreEventForwarder::to_app(&app, None);
    let launched = async {
        let task = tasks.register(&task_id)?;
        let aurora = facade.snapshot().await.with_cancel(task.token().clone());
        task.run(async {
            match account_uuid.as_deref() {
                Some(uuid) => {
                    let account = find_account(&aurora, uuid)?;
                    // 启动前静默续期：缓存令牌过期则用 refresh_token 换新，避免拿废令牌启动。
                    let account = ensure_fresh(&aurora, &account).await?;
                    Ok(aurora
                        .launch_account(
                            &version_id,
                            &account,
                            &options,
                            Some(log_tx),
                            Some(events.sink()),
                        )
                        .await?)
                }
                None => {
                    let name = offline_name.as_deref().ok_or_else(|| {
                        CommandError::invalid_argument("启动需提供 account_uuid 或 offline_name")
                    })?;
                    Ok(aurora
                        .launch_offline(
                            &version_id,
                            name,
                            &options,
                            Some(log_tx),
                            Some(events.sink()),
                        )
                        .await?)
                }
            }
        })
        .await
    }
    .await;
    events.finish().await;
    let session = launched?;

    let pid = session.id();
    // 直接覆盖旧值：上一局若未经 stop_game 结束，旧会话在此被丢弃。
    *running.0.lock().await = Some(session);
    Ok(LaunchedDto { pid })
}

/// 结束当前运行中的游戏进程。无运行中的游戏时为幂等空操作。
#[tauri::command]
pub async fn stop_game(running: State<'_, RunningGame>) -> Result<(), CommandError> {
    let session = running.0.lock().await.take();
    match session {
        Some(mut session) => Ok(session.kill().await?),
        None => Ok(()),
    }
}
