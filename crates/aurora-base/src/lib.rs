//! aurora-base（L0 公共设施）
//!
//! 整个 workspace 的地基：所有访问网络、落盘、校验、重试的上层 crate 都从这里取统一实现，
//! 避免各处各写一份 reqwest 客户端、各拼一套 BMCLAPI 改写规则。
//!
//! 五个子模块：
//! - [`brand`]：产品名常量（中文名、英文名、slug）的唯一定义点。
//! - [`http`]：reqwest + rustls 客户端工厂，统一 User-Agent 与超时策略。
//! - [`mirror`]：官方下载域名到 BMCLAPI 镜像域名的 URL 改写（architecture.md 五节速查表）。
//! - [`fs`]：流式 sha1/sha256 校验、临时文件 + rename 的原子写入、数据/缓存目录定位。
//! - [`retry`]：指数退避重试包装。
//!
//! 错误统一归口到 [`Error`]，下游 crate 直接 `#[from]` 冒泡即可。

pub mod brand;
pub mod error;
pub mod fs;
pub mod http;
pub mod mirror;
pub mod retry;

pub use error::{Error, Result};
