//! crate 统一错误类型。
//!
//! 本 crate 只暴露一个 [`Error`] 枚举，下游用 `#[from] aurora_instance::Error` 一处冒泡。
//! 下层 crate 的错误（aurora-base 的 IO/校验、aurora-version 的解析）经 `#[from]` 透传，
//! 本层新增的只有「带路径的本地 IO」与「带上下文的配置 JSON 解析」两类；不做默认值掩盖。

use std::path::PathBuf;

use aurora_base::retry::RetryableError;

/// aurora-instance 对外统一错误。
#[derive(Debug, thiserror::Error)]
pub enum Error {
    /// 下层公共设施错误（原子写、哈希校验、目录定位等）。
    #[error(transparent)]
    Base(#[from] aurora_base::Error),

    /// 版本 JSON 域模型解析错误（继承合并 / 反序列化）。
    #[error(transparent)]
    Version(#[from] aurora_version::Error),

    /// 本地文件系统操作失败，附带出错路径便于定位。
    #[error("文件 IO 失败: {path}")]
    Io {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },

    /// 本 crate 自管的配置文件（launcher_profiles / 版本设置 / 版本列表缓存）序列化或解析失败。
    #[error("解析 {context} 失败: {path}")]
    Json {
        context: &'static str,
        path: PathBuf,
        #[source]
        source: serde_json::Error,
    },
}

/// crate 级 `Result` 别名。
pub type Result<T> = std::result::Result<T, Error>;

impl RetryableError for Error {
    fn is_retryable(&self) -> bool {
        match self {
            // 下层自行判定（下载损坏重下、瞬时 IO 抖动等）。
            Error::Base(e) => e.is_retryable(),
            // 本地 IO 抖动可再试；NotFound / 权限类是终态。
            Error::Io { source, .. } => is_transient_io(source.kind()),
            // 解析类错误重试也是同样结果。
            Error::Version(_) | Error::Json { .. } => false,
        }
    }
}

/// 判断 IO 错误是否属于「换个时机可能就好了」的瞬时故障。与 aurora-base 的判据保持一致。
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
    fn base_error_delegates_retryability() {
        // aurora-base 的 HashMismatch 判定为可重试，透传后仍应可重试。
        let err: Error = aurora_base::Error::HashMismatch {
            algorithm: "SHA-1",
            expected: "aa".into(),
            actual: "bb".into(),
        }
        .into();
        assert!(err.is_retryable());
    }

    #[test]
    fn transient_io_retryable_but_notfound_not() {
        let transient = Error::Io {
            path: PathBuf::from("versions"),
            source: io::Error::from(io::ErrorKind::TimedOut),
        };
        let permanent = Error::Io {
            path: PathBuf::from("versions"),
            source: io::Error::from(io::ErrorKind::NotFound),
        };
        assert!(transient.is_retryable());
        assert!(!permanent.is_retryable());
    }

    #[test]
    fn json_and_version_errors_are_terminal() {
        let json_err = Error::Json {
            context: "版本设置",
            path: PathBuf::from(crate::AURORA_META_DIR).join("settings.json"),
            source: serde_json::from_str::<serde_json::Value>("{bad").unwrap_err(),
        };
        assert!(!json_err.is_retryable());

        let version_err: Error = aurora_version::Error::SelfInherit { id: "1.21".into() }.into();
        assert!(!version_err.is_retryable());
    }

    #[test]
    fn display_carries_path_context() {
        let err = Error::Io {
            path: PathBuf::from("D:\\mc\\versions"),
            source: io::Error::from(io::ErrorKind::PermissionDenied),
        };
        assert_eq!(err.to_string(), "文件 IO 失败: D:\\mc\\versions");
    }
}
