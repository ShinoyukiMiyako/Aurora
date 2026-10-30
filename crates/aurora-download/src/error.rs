//! aurora-download 的独立错误类型。
//!
//! 本 crate 在 [`aurora_base::Error`] 之上叠加下载专属的失败形态（HTTP 状态、响应体截断、
//! 大小不符、Range 不支持、多源耗尽等）。底层的哈希/IO/URL 错误经 [`Error::Base`] 直接冒泡，
//! 下游只需 `#[from] aurora_download::Error` 一处承接。
//!
//! 错误是否可重试实现在 [`RetryableError`] 上：区分「换个时机或换个源可能就好」的瞬时故障
//! 与「重试也是白搭」的确定性失败，喂给 [`aurora_base::retry::retry_async`] 精确控制退避。

use aurora_base::retry::RetryableError;

/// aurora-download 对外统一错误。
#[derive(Debug, thiserror::Error)]
pub enum Error {
    /// 底层设施错误（哈希不符、文件 IO、URL 改写等），来自 aurora-base。
    #[error(transparent)]
    Base(#[from] aurora_base::Error),

    /// 发送请求或读取响应体时的传输层错误（连接、超时、读到一半断开）。
    #[error("HTTP 请求失败: {url}")]
    Request {
        url: String,
        #[source]
        source: reqwest::Error,
    },

    /// 服务器返回了非 2xx 状态码。是否重试由状态码类别决定（5xx/429/408 可重试）。
    #[error("HTTP 状态码 {status}: {url}")]
    Status { url: String, status: u16 },

    /// 实际读到的字节数少于该分块/文件应有的长度（连接中途断开）。
    #[error("响应体不完整: {url}（期望 {expected} 字节，实际 {actual} 字节）")]
    IncompleteBody {
        url: String,
        expected: u64,
        actual: u64,
    },

    /// 合并落盘后的文件大小与版本 JSON 声明的大小不一致。
    #[error("文件大小不符: {url}（期望 {expected} 字节，实际 {actual} 字节）")]
    SizeMismatch {
        url: String,
        expected: u64,
        actual: u64,
    },

    /// 对非零起始的分块请求却收到 200 整体响应，说明该源不支持 Range 分块。
    #[error("服务器不支持 Range 分块下载: {url}")]
    RangeUnsupported { url: String },

    /// 承载分块下载的异步任务 panic 或被取消。
    #[error("下载分块任务异常终止")]
    ChunkTaskJoin(#[source] tokio::task::JoinError),

    /// 优先级列表里所有下载源都试过且全部失败，附带最后一个源的错误。
    #[error("所有下载源均失败: {url}")]
    AllSourcesExhausted {
        url: String,
        #[source]
        last: Box<Error>,
    },

    /// 调用方经取消令牌放弃了本次下载；返回前已清掉该文件的临时文件与分片。
    #[error("下载已取消")]
    Cancelled,
}

impl Error {
    /// 是否为取消。上层据此把取消与真正的失败分开呈现。
    pub fn is_cancelled(&self) -> bool {
        matches!(self, Error::Cancelled)
    }
}

/// crate 级 `Result` 别名。
pub type Result<T> = std::result::Result<T, Error>;

impl RetryableError for Error {
    fn is_retryable(&self) -> bool {
        match self {
            // 委托底层：哈希不符（重下）、瞬时 IO 抖动可重试；配置/环境类不可。
            Error::Base(err) => err.is_retryable(),
            Error::Request { source, .. } => is_transient_reqwest(source),
            // 5xx 服务端抽风、429 限流、408 请求超时值得再试；403/404 等确定性拒绝立即放弃。
            Error::Status { status, .. } => {
                *status == 408 || *status == 429 || (500..=599).contains(status)
            }
            // 连接中途断开导致的截断、以及大小不符，换次尝试可能补齐。
            Error::IncompleteBody { .. } | Error::SizeMismatch { .. } => true,
            // Range 不支持是源能力问题（应切换到单流/换源，而非在同一路径上死重试）；
            // 任务 join 失败与多源耗尽都是终态。
            Error::RangeUnsupported { .. }
            | Error::ChunkTaskJoin(_)
            | Error::AllSourcesExhausted { .. } => false,
            // 取消是调用方的决定，重试或换源都违背它。
            Error::Cancelled => false,
        }
    }
}

/// 判断 reqwest 传输层错误是否属于「再试一次可能就好」的瞬时故障。
///
/// 明确排除 `is_status`（状态类错误在本 crate 由 [`Error::Status`] 单独承载并分级）与
/// `is_builder`/`is_redirect`（构造/重定向配置问题，重试无益）。
fn is_transient_reqwest(err: &reqwest::Error) -> bool {
    err.is_timeout() || err.is_connect() || err.is_request() || err.is_body()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn server_errors_are_retryable_client_errors_are_not() {
        let e500 = Error::Status {
            url: "http://x/a".into(),
            status: 500,
        };
        let e502 = Error::Status {
            url: "http://x/a".into(),
            status: 502,
        };
        let e429 = Error::Status {
            url: "http://x/a".into(),
            status: 429,
        };
        let e404 = Error::Status {
            url: "http://x/a".into(),
            status: 404,
        };
        let e403 = Error::Status {
            url: "http://x/a".into(),
            status: 403,
        };
        assert!(e500.is_retryable());
        assert!(e502.is_retryable());
        assert!(e429.is_retryable());
        assert!(!e404.is_retryable());
        assert!(!e403.is_retryable());
    }

    #[test]
    fn truncation_and_size_mismatch_are_retryable() {
        let truncated = Error::IncompleteBody {
            url: "http://x/a".into(),
            expected: 100,
            actual: 40,
        };
        let size = Error::SizeMismatch {
            url: "http://x/a".into(),
            expected: 100,
            actual: 99,
        };
        assert!(truncated.is_retryable());
        assert!(size.is_retryable());
    }

    #[test]
    fn range_unsupported_and_exhausted_are_terminal() {
        let range = Error::RangeUnsupported {
            url: "http://x/a".into(),
        };
        let exhausted = Error::AllSourcesExhausted {
            url: "http://x/a".into(),
            last: Box::new(Error::Status {
                url: "http://x/a".into(),
                status: 404,
            }),
        };
        assert!(!range.is_retryable());
        assert!(!exhausted.is_retryable());
    }

    #[test]
    fn cancelled_is_terminal_and_recognised() {
        assert!(!Error::Cancelled.is_retryable());
        assert!(Error::Cancelled.is_cancelled());
        let other = Error::Status {
            url: "http://x/a".into(),
            status: 503,
        };
        assert!(!other.is_cancelled());
    }

    #[test]
    fn base_hash_mismatch_bubbles_as_retryable() {
        let base = aurora_base::Error::HashMismatch {
            algorithm: "SHA-1",
            expected: "aa".into(),
            actual: "bb".into(),
        };
        let err: Error = base.into();
        assert!(err.is_retryable());
    }

    #[test]
    fn display_carries_context() {
        let err = Error::Status {
            url: "http://host/path".into(),
            status: 503,
        };
        assert_eq!(err.to_string(), "HTTP 状态码 503: http://host/path");
    }
}
