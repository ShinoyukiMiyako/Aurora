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

    /// 组件清单里的文件路径会落到运行时安装目录之外（为空、是绝对路径，或含 `..`、盘符、反斜杠、冒号、
    /// 空段）。清单与其中文件的 sha1 来自同一个源（可以是镜像），下载校验拦不住，所以在算落点时就拒掉。
    #[error("Java 运行时清单里的路径「{path}」{reason}，会落到运行时目录之外，已拒绝安装")]
    UnsafeRuntimePath { path: String, reason: &'static str },

    /// 组件清单里的符号链接指到运行时安装目录之外：之后经它写入或加载的文件会落到别处。
    #[error("Java 运行时清单里的链接「{path}」指向「{target}」，会指到运行时目录之外，已拒绝安装")]
    UnsafeRuntimeLink { path: String, target: String },
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
            | Error::UnsupportedPlatform(_)
            | Error::NoRuntimeForMajor { .. }
            | Error::MissingJavaExecutable => false,
            // 取消是调用方的决定，重试违背它。
            Error::Cancelled => false,
            // 清单内容本身越界，重拉同一份清单结果不变。
            Error::UnsafeRuntimePath { .. } | Error::UnsafeRuntimeLink { .. } => false,
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
