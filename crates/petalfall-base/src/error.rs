//! crate 统一错误类型。
//!
//! 全 crate 只暴露一个 [`Error`] 枚举，下游可用 `#[from] petalfall_base::Error` 一处冒泡。
//! 每个变体都携带足够定位现场的上下文（出错路径、期望/实际哈希），不做默认值掩盖。

use std::path::PathBuf;

use crate::retry::RetryableError;

/// petalfall-base 对外统一错误。
#[derive(Debug, thiserror::Error)]
pub enum Error {
    /// 构建 reqwest 客户端失败（TLS/连接池等配置层面问题，重试不会好转）。
    #[error("构建 HTTP 客户端失败")]
    HttpClientBuild(#[source] reqwest::Error),

    /// 待改写的 URL 无法解析为合法绝对 URL。
    #[error("URL 解析失败: {url}")]
    UrlParse {
        url: String,
        #[source]
        source: url::ParseError,
    },

    /// URL 没有主机名（相对路径、`mailto:` 之类），镜像改写无从下手。
    #[error("URL 缺少主机名，无法进行镜像改写: {0}")]
    UrlMissingHost(String),

    /// 文件读写失败，附带具体路径便于定位是哪个文件出的问题。
    #[error("文件 IO 失败: {path}")]
    Io {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },

    /// 流式校验得到的摘要与期望值不一致（下载损坏 / 被篡改）。
    #[error("{algorithm} 校验不通过: 期望 {expected}, 实际 {actual}")]
    HashMismatch {
        algorithm: &'static str,
        expected: String,
        actual: String,
    },

    /// 定位数据目录时缺少 %LOCALAPPDATA% 环境变量。
    #[error("环境变量 LOCALAPPDATA 缺失，无法定位数据目录")]
    MissingLocalAppData,

    /// 承载哈希计算的阻塞任务异常终止（panic 或被取消）。
    #[error("哈希计算任务异常终止")]
    HashTaskJoin(#[source] tokio::task::JoinError),
}

/// crate 级 `Result` 别名。
pub type Result<T> = std::result::Result<T, Error>;

/// 错误连同它的原因链，用「：」接起来。要显示给人看时用：真正的原因（系统错误、JSON 的行列）常在第二层。
pub fn error_with_causes(err: &dyn std::error::Error) -> String {
    let mut text = err.to_string();
    let mut cause = err.source();
    while let Some(inner) = cause {
        text.push('：');
        text.push_str(&inner.to_string());
        cause = inner.source();
    }
    text
}

impl RetryableError for Error {
    fn is_retryable(&self) -> bool {
        match self {
            // 下载损坏后重下、瞬时 IO 抖动都值得再试
            Error::HashMismatch { .. } => true,
            Error::Io { source, .. } => is_transient_io(source.kind()),
            // 配置 / 解析 / 环境类错误，重试也是同样结果
            Error::HttpClientBuild(_)
            | Error::UrlParse { .. }
            | Error::UrlMissingHost(_)
            | Error::MissingLocalAppData
            | Error::HashTaskJoin(_) => false,
        }
    }
}

/// 判断 IO 错误是否属于「换个时机可能就好了」的瞬时故障。
fn is_transient_io(kind: std::io::ErrorKind) -> bool {
    use std::io::ErrorKind;
    matches!(
        kind,
        ErrorKind::TimedOut
            | ErrorKind::Interrupted
            | ErrorKind::WouldBlock
            | ErrorKind::ConnectionReset
            | ErrorKind::ConnectionAborted
            | ErrorKind::BrokenPipe
            | ErrorKind::UnexpectedEof
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io;

    #[test]
    fn error_with_causes_walks_the_whole_source_chain() {
        let err = Error::Io {
            path: PathBuf::from("mods"),
            source: io::Error::other("拒绝访问"),
        };
        assert_eq!(error_with_causes(&err), format!("{err}：拒绝访问"));
        assert_eq!(
            error_with_causes(&io::Error::other("没有下一层")),
            "没有下一层"
        );
    }

    #[test]
    fn hash_mismatch_is_retryable() {
        let err = Error::HashMismatch {
            algorithm: "SHA-1",
            expected: "aa".into(),
            actual: "bb".into(),
        };
        assert!(err.is_retryable());
    }

    #[test]
    fn transient_io_is_retryable_but_notfound_is_not() {
        let transient = Error::Io {
            path: PathBuf::from("x"),
            source: io::Error::from(io::ErrorKind::TimedOut),
        };
        let permanent = Error::Io {
            path: PathBuf::from("x"),
            source: io::Error::from(io::ErrorKind::NotFound),
        };
        assert!(transient.is_retryable());
        assert!(!permanent.is_retryable());
    }

    #[test]
    fn config_errors_are_not_retryable() {
        let err = Error::UrlMissingHost("mailto:a@b".into());
        assert!(!err.is_retryable());
        let err = Error::MissingLocalAppData;
        assert!(!err.is_retryable());
    }

    #[test]
    fn display_carries_context() {
        let err = Error::HashMismatch {
            algorithm: "SHA-256",
            expected: "abc".into(),
            actual: "def".into(),
        };
        assert_eq!(err.to_string(), "SHA-256 校验不通过: 期望 abc, 实际 def");
    }
}
