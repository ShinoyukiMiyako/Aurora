//! IPC 命令，按领域分文件；lib.rs 的 `generate_handler!` 按同样的领域分块注册。
//!
//! 共同约定：
//! - 命令一律 async，错误类型一律 [`CommandError`]（序列化为 `{ code, message, detail? }`）。
//! - 门面的取用规矩见 [`crate::facade`]：内存读用 `read`，改配置用 `write`，等网络或扫盘用 `snapshot`。
//! - 长命令带 `task_id` 参数，经 [`crate::tasks::TaskRegistry`] 登记以便取消，进度经
//!   [`crate::events::CoreEventForwarder`] 推送并带上 `task_id`。

pub mod accounts;
pub mod appearance;
pub mod art;
pub mod config;
pub mod diagnostics;
pub mod discover;
pub mod error;
pub mod instances;
pub mod java;
pub mod launch;
pub mod mods;
pub mod tasks;

pub use error::CommandError;
