//! 门面统一暴露的进度/事件。
//!
//! 各粗粒度操作（安装、启动、Java 下载等）在推进过程中通过一个可选的 [`EventSink`] 发出
//! [`CoreEvent`]，供前端/CLI 实时展示阶段与告警。细粒度的下载字节进度由 aurora-download 的
//! [`DownloadProgress`] 表达，这里一并透传其类型定义，前端只依赖本 crate 即可拿到进度模型。

use tokio::sync::mpsc;

/// 门面事件通道的发送端。`None` 表示调用方不关心事件。
pub type EventSink = mpsc::UnboundedSender<CoreEvent>;

/// 下载进度快照（从 aurora-download 透传，前端进度条直接消费）。
pub use aurora_download::DownloadProgress;

/// 一次操作过程中发出的事件。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CoreEvent {
    /// 阶段推进（人类可读的一句话，如「原版安装完成」）。
    Stage(String),
    /// 非阻断性告警（如离线用户名含非标准字符）。
    Warning(String),
    /// 批量下载进度快照。
    Download(DownloadProgress),
}

impl CoreEvent {
    /// 构造一个阶段事件。
    pub fn stage(message: impl Into<String>) -> Self {
        CoreEvent::Stage(message.into())
    }

    /// 构造一个告警事件。
    pub fn warning(message: impl Into<String>) -> Self {
        CoreEvent::Warning(message.into())
    }
}

/// 向可选的事件通道投递一条事件；无接收者或通道已关闭时静默忽略（事件是尽力而为的通知）。
pub(crate) fn emit(sink: Option<&EventSink>, event: CoreEvent) {
    if let Some(tx) = sink {
        let _ = tx.send(event);
    }
}
