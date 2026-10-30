//! aurora-download（L1 下载引擎与镜像源调度）
//!
//! 在 [`aurora_base`] 的 HTTP 工厂、镜像改写表、流式校验与退避重试之上，构建一个面向 Minecraft
//! 资源分发场景的通用下载引擎：
//!
//! - [`Downloader`]：单文件下载。已知大小的大文件走 Range 分块并发，分片粒度断点续传；每源指数
//!   退避重试，耗尽后按 [`SourcePlan`] 切换下一个镜像源；合并后强制 sha1/大小校验，不符即重下。
//! - [`DownloadPool`]：批量并发。信号量控住文件级并发，把上千小文件跑完，进度经 [`DownloadProgress`]
//!   与 `watch` channel 上报。
//! - [`SourcePlan`] / [`SourceResolver`]：官方源与 BMCLAPI 镜像的优先级调度与 URL 解析，支持测速排序。
//! - [`CancellationToken`]：挂到 [`DownloadPool`] 上，令牌触发后整批在文件粒度停下并清理临时文件。
//!
//! 所有失败归口到 [`Error`]，可重试性由 [`aurora_base::retry::RetryableError`] 精确分级。
//!
//! ```no_run
//! # async fn demo() -> aurora_download::Result<()> {
//! use aurora_download::{DownloadTask, Downloader};
//!
//! let client = aurora_base::http::build_client()?;
//! let downloader = Downloader::with_defaults(client);
//! let task = DownloadTask::new(
//!     "https://libraries.minecraft.net/com/mojang/authlib/1.5.25/authlib-1.5.25.jar",
//!     "C:/mc/libraries/com/mojang/authlib/1.5.25/authlib-1.5.25.jar",
//! )
//! .with_sha1("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")
//! .with_size(87342);
//! downloader.download(&task).await?;
//! # Ok(())
//! # }
//! ```

mod engine;

pub mod chunk;
pub mod error;
pub mod pool;
pub mod progress;
pub mod source;
pub mod task;

pub use chunk::{Chunk, ChunkConfig, ChunkPlan};
pub use engine::{DownloadConfig, Downloader};
pub use error::{Error, Result};
pub use pool::{BatchReport, DownloadPool, TaskFailure};
pub use progress::DownloadProgress;
pub use source::{MirrorResolver, SourcePlan, SourceResolver, order_by_latency, probe_latencies};
pub use task::DownloadTask;

// 下游可直接从本 crate 取镜像源枚举，无需再显式依赖 aurora-base。
pub use aurora_base::mirror::MirrorSource;
// 取消令牌的唯一类型来源：上层（门面、命令层）都经本 crate 取它，保证整条链路用的是同一个类型。
pub use tokio_util::sync::CancellationToken;
