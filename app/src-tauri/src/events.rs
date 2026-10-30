//! 推给前端的事件：事件名、负载与把门面事件转成 Tauri 事件的转发器。
//!
//! aurora-core 与 UI 框架解耦，只认一个 `mpsc` 发送端作为事件出口（[`EventSink`]）。命令建一个
//! [`CoreEventForwarder`]，把它的发送端交给门面方法，转发任务把收到的每条 [`CoreEvent`] 译成
//! [`CoreEventPayload`] 再 `emit` 出去。负载带 `task_id`：前端下载队列据此把进度归到对应任务，
//! 不带 `task_id`（为 `null`）的事件只属于启动会话。

use aurora_core::{CoreEvent, EventSink};
use serde::Serialize;
use tauri::{AppHandle, Emitter};

/// 阶段、告警与下载进度。
pub const CORE_EVENT: &str = "aurora://core-event";

/// 微软设备码登录拿到设备码时推送 user_code 与验证网址。
pub const DEVICE_CODE_EVENT: &str = "aurora://device-code";

/// 游戏进程的每一行 stdout / stderr。
pub const GAME_LOG_EVENT: &str = "aurora://game-log";

/// 推送一个事件；失败（窗口已关、无监听者）只记日志，不影响命令本身的结果。
pub fn emit<S: Serialize + Clone>(app: &AppHandle, event: &str, payload: S) {
    if let Err(err) = app.emit(event, payload) {
        tracing::warn!(event, error = %err, "事件推送失败");
    }
}

/// [`CORE_EVENT`] 的负载：`{ task_id, kind, ... }`。
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct CoreEventPayload {
    /// 所属任务；启动会话与非任务命令的事件为 `null`。
    pub task_id: Option<String>,
    #[serde(flatten)]
    pub event: CoreEventKind,
}

/// 按 `kind` 区分的事件主体。
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum CoreEventKind {
    /// 阶段推进（人类可读的一句话）。
    Stage { message: String },
    /// 非阻断性告警。
    Warning { message: String },
    /// 当前这一批下载的进度快照。安装要连跑好几批，每批都从 `finished = 0` 重新计起。
    Download {
        /// 本批文件数。
        total: u64,
        /// 已结束文件数（成功与最终失败都计入）。
        finished: u64,
        /// 实际传输字节（含重传，可能超过 `total_bytes`，画进度时要封顶）。
        bytes: u64,
        /// 本批声明大小之和；有文件大小未知时为 `null`。
        total_bytes: Option<u64>,
        /// 瞬时速度，字节/秒。
        speed: u64,
    },
}

impl From<CoreEvent> for CoreEventKind {
    fn from(event: CoreEvent) -> Self {
        match event {
            CoreEvent::Stage(message) => CoreEventKind::Stage { message },
            CoreEvent::Warning(message) => CoreEventKind::Warning { message },
            CoreEvent::Download(p) => CoreEventKind::Download {
                total: p.total,
                finished: p.finished,
                bytes: p.bytes,
                total_bytes: p.total_bytes,
                speed: p.speed,
            },
        }
    }
}

/// 一次命令的门面事件转发：持有交给门面的发送端与后台转发任务。
pub struct CoreEventForwarder {
    sink: EventSink,
    task: tauri::async_runtime::JoinHandle<()>,
}

impl CoreEventForwarder {
    /// 用任意投递函数起转发任务；每条事件都标上 `task_id`。
    pub fn spawn(
        task_id: Option<String>,
        deliver: impl Fn(CoreEventPayload) + Send + 'static,
    ) -> Self {
        let (sink, mut rx) = tokio::sync::mpsc::unbounded_channel::<CoreEvent>();
        let task = tauri::async_runtime::spawn(async move {
            // 发送端全部释放后 recv 返回 None，循环自然结束。
            while let Some(event) = rx.recv().await {
                deliver(CoreEventPayload {
                    task_id: task_id.clone(),
                    event: event.into(),
                });
            }
        });
        Self { sink, task }
    }

    /// 转发到前端的 [`CORE_EVENT`]。
    pub fn to_app(app: &AppHandle, task_id: Option<String>) -> Self {
        let app = app.clone();
        Self::spawn(task_id, move |payload| emit(&app, CORE_EVENT, payload))
    }

    /// 交给门面方法的事件发送端。
    pub fn sink(&self) -> &EventSink {
        &self.sink
    }

    /// 放掉自己的发送端并等转发任务排空剩余事件。
    ///
    /// 门面内部的进度转发也持有发送端，会在下载池释放后发完最后一份快照才放手，这里会等到它。
    pub async fn finish(self) {
        drop(self.sink);
        if let Err(err) = self.task.await {
            tracing::error!(error = %err, "事件转发任务异常结束");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use aurora_core::DownloadProgress;
    use serde_json::json;
    use std::sync::{Arc, Mutex};

    #[test]
    fn payload_serializes_flat_with_task_id_and_kind() {
        let payload = CoreEventPayload {
            task_id: Some("task-7".into()),
            event: CoreEventKind::Download {
                total: 3,
                finished: 1,
                bytes: 2048,
                total_bytes: Some(4096),
                speed: 512,
            },
        };
        assert_eq!(
            serde_json::to_value(&payload).unwrap(),
            json!({
                "task_id": "task-7",
                "kind": "download",
                "total": 3,
                "finished": 1,
                "bytes": 2048,
                "total_bytes": 4096,
                "speed": 512
            })
        );

        let session = CoreEventPayload {
            task_id: None,
            event: CoreEventKind::Stage {
                message: "开始安装原版 1.21".into(),
            },
        };
        assert_eq!(
            serde_json::to_value(&session).unwrap(),
            json!({ "task_id": null, "kind": "stage", "message": "开始安装原版 1.21" })
        );
    }

    #[tokio::test]
    async fn forwarder_tags_every_event_with_task_id_in_order() {
        let delivered = Arc::new(Mutex::new(Vec::new()));
        let sink_log = delivered.clone();
        let forwarder = CoreEventForwarder::spawn(Some("install-1".into()), move |p| {
            sink_log.lock().unwrap().push(p)
        });
        forwarder.sink().send(CoreEvent::stage("开始")).unwrap();
        forwarder
            .sink()
            .send(CoreEvent::Download(DownloadProgress {
                total: 2,
                finished: 2,
                bytes: 10,
                total_bytes: None,
                speed: 0,
            }))
            .unwrap();
        forwarder.sink().send(CoreEvent::warning("慢")).unwrap();
        forwarder.finish().await;

        let delivered = delivered.lock().unwrap();
        assert_eq!(delivered.len(), 3);
        assert!(delivered
            .iter()
            .all(|p| p.task_id.as_deref() == Some("install-1")));
        assert_eq!(
            delivered[1].event,
            CoreEventKind::Download {
                total: 2,
                finished: 2,
                bytes: 10,
                total_bytes: None,
                speed: 0,
            }
        );
        assert_eq!(
            delivered[2].event,
            CoreEventKind::Warning {
                message: "慢".into()
            }
        );
    }

    /// finish 要等所有发送端都放手：门面里还持有的克隆发出的最后一条事件不能丢。
    #[tokio::test]
    async fn finish_waits_for_cloned_senders() {
        let delivered = Arc::new(Mutex::new(Vec::new()));
        let sink_log = delivered.clone();
        let forwarder = CoreEventForwarder::spawn(None, move |p| sink_log.lock().unwrap().push(p));
        let late = forwarder.sink().clone();
        let straggler = tokio::spawn(async move {
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
            late.send(CoreEvent::stage("最后一条")).unwrap();
        });
        forwarder.finish().await;
        straggler.await.unwrap();

        let delivered = delivered.lock().unwrap();
        assert_eq!(delivered.len(), 1);
        assert_eq!(delivered[0].task_id, None);
    }
}
