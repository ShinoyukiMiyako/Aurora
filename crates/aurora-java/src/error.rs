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

    /// 同一份清单在两个及以上下载源上都没取到。
    ///
    /// `attempts` 按尝试顺序给出每个源的地址与它的完整失败原因（错误本身接上 `source()` 链），
    /// 排障时一眼能看出是官方源、镜像还是两边都出了问题；`last` 是最后一个源的原错误，
    /// 原因链从它接着往下，上层据此仍能判出是否属于网络不通。
    #[error("{context} 在全部 {} 个下载源上都失败：{}", .attempts.len(), .attempts.join("；"))]
    AllSourcesFailed {
        context: &'static str,
        attempts: Vec<String>,
        #[source]
        last: Box<Error>,
    },
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
            // 每个源内部已按策略重试过，整体再来一轮只会把同样的失败重演一遍。
            Error::AllSourcesFailed { .. } => false,
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::error::Error as _;

    #[test]
    fn all_sources_failed_lists_every_attempt_in_order_and_is_final() {
        let err = Error::AllSourcesFailed {
            context: "Java 运行时总清单",
            attempts: vec![
                "https://a/all.json：HTTP 请求失败: https://a/all.json".to_owned(),
                "https://b/all.json：Java 运行时清单不含平台 x".to_owned(),
            ],
            last: Box::new(Error::UnsupportedPlatform("x".to_owned())),
        };

        assert_eq!(
            err.to_string(),
            "Java 运行时总清单 在全部 2 个下载源上都失败：\
             https://a/all.json：HTTP 请求失败: https://a/all.json；\
             https://b/all.json：Java 运行时清单不含平台 x"
        );
        let last = err
            .source()
            .and_then(|s| s.downcast_ref::<Box<Error>>())
            .expect("原因链第一层应是最后一个源的原错误");
        assert!(matches!(last.as_ref(), Error::UnsupportedPlatform(p) if p == "x"));
        assert!(
            !err.is_retryable(),
            "各源已各自重试过，聚合错误不应再整体重试"
        );
        assert!(!err.is_cancelled());
    }
}
