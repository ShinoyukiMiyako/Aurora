//! crate 统一错误类型。
//!
//! 与 workspace 其它 crate 一致，只暴露一个 [`Error`] 枚举，下游可用
//! `#[from] aurora_java::Error` 一处冒泡。底层 aurora-base 的错误（镜像改写、原子写入、
//! 哈希校验）通过 [`Error::Base`] 透传，且把它的可重试性一并继承过来。

use std::path::PathBuf;

use aurora_base::retry::RetryableError;

/// aurora-java 对外统一错误。
#[derive(Debug, thiserror::Error)]
pub enum Error {
    /// 来自 aurora-base 的错误（镜像改写 / 原子写入 / sha1 校验等）原样透传。
    #[error(transparent)]
    Base(#[from] aurora_base::Error),

    /// 访问远端（Java 运行时清单 / 组件文件）时的 HTTP 层错误，附带具体 URL。
    #[error("HTTP 请求失败: {url}")]
    Http {
        url: String,
        #[source]
        source: reqwest::Error,
    },

    /// JSON 反序列化失败，`context` 标明是哪一份报文（all.json / 组件清单）。
    #[error("解析 JSON 失败: {context}")]
    Json {
        context: String,
        #[source]
        source: serde_json::Error,
    },

    /// 启动 `java -version` 子进程本身失败（路径不存在 / 无执行权限等）。
    #[error("执行 java 可执行文件失败: {path}")]
    JavaExec {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },

    /// `java -version` 有输出，但无法从中解析出版本号。
    #[error("无法从 java -version 输出解析版本号: {output}")]
    JavaVersionParse { output: String },

    /// `java -version` 在等待上限内没有结束；子进程已被结束并确认退出。
    #[error("java -version 超过 {timeout_secs} 秒没有结束，已结束该进程: {path}")]
    JavaProbeTimeout { path: PathBuf, timeout_secs: u64 },

    /// Java 运行时清单不包含当前平台键（如非 windows-x64 平台）。
    #[error("Java 运行时清单不含平台 {0}")]
    UnsupportedPlatform(String),

    /// 清单里没有主版本号匹配的运行时组件（例如目标要 Java 8 但清单只提供 17/21）。
    #[error("Java 运行时清单不含匹配主版本 {major} 的组件")]
    NoRuntimeForMajor { major: u32 },

    /// 选中的组件文件清单里找不到 java 可执行文件条目，安装结果无从指认。
    #[error("Java 运行时组件清单缺少 java 可执行文件条目")]
    MissingJavaExecutable,

    /// 调用方经取消令牌放弃了本次运行时下载。
    #[error("Java 运行时下载已取消")]
    Cancelled,
}

impl Error {
    /// 是否为取消。
    pub fn is_cancelled(&self) -> bool {
        matches!(self, Error::Cancelled)
    }
}

/// crate 级 `Result` 别名。
pub type Result<T> = std::result::Result<T, Error>;

impl RetryableError for Error {
    fn is_retryable(&self) -> bool {
        match self {
            // aurora-base 已区分好瞬时/永久（sha1 不符可重下、瞬时 IO 可重试）。
            Error::Base(inner) => inner.is_retryable(),
            // 网络类：超时、建连失败、请求发送失败可重试；5xx / 429 也当作瞬时故障重试。
            Error::Http { source, .. } => is_retryable_http(source),
            // 解析 / 平台 / 匹配 / 结构类错误，重试也是同样结果。
            Error::Json { .. }
            | Error::JavaExec { .. }
            | Error::JavaVersionParse { .. }
            // 挂住的 JVM 再拉一次多半还是挂住，只会让调用方多等一个超时。
            | Error::JavaProbeTimeout { .. }
            | Error::UnsupportedPlatform(_)
            | Error::NoRuntimeForMajor { .. }
            | Error::MissingJavaExecutable => false,
            // 取消是调用方的决定，重试违背它。
            Error::Cancelled => false,
        }
    }
}

/// 判断一个 reqwest 错误是否值得重试。
fn is_retryable_http(err: &reqwest::Error) -> bool {
    if err.is_timeout() || err.is_connect() || err.is_request() {
        return true;
    }
    // error_for_status 抛出的状态码错误：仅对服务端错误与限流重试，4xx（除 429）不重试。
    match err.status() {
        Some(status) => {
            status.is_server_error() || status == reqwest::StatusCode::TOO_MANY_REQUESTS
        }
        None => false,
    }
}
