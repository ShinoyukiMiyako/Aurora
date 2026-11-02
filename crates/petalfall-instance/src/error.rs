//! crate 统一错误类型。
//!
//! 本 crate 只暴露一个 [`Error`] 枚举，下游用 `#[from] petalfall_instance::Error` 一处冒泡。
//! 下层 crate 的错误（petalfall-base 的 IO/校验、petalfall-version 的解析）经 `#[from]` 透传，
//! 本层新增的只有「带路径的本地 IO」与「带上下文的配置 JSON 解析」两类；不做默认值掩盖。

use std::path::PathBuf;

use petalfall_base::retry::RetryableError;

use crate::naming::NameViolation;

/// petalfall-instance 对外统一错误。
#[derive(Debug, thiserror::Error)]
pub enum Error {
    /// 下层公共设施错误（原子写、哈希校验、目录定位等）。
    #[error(transparent)]
    Base(#[from] petalfall_base::Error),

    /// 版本 JSON 域模型解析错误（继承合并 / 反序列化）。
    #[error(transparent)]
    Version(#[from] petalfall_version::Error),

    /// 本地文件系统操作失败，附带出错路径便于定位。
    #[error("文件 IO 失败: {path}")]
    Io {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },

    /// 本 crate 自管的文件（版本设置、未完成标记）或游戏自己的配置序列化、解析失败。
    #[error("解析 {context} 失败: {path}")]
    Json {
        context: &'static str,
        path: PathBuf,
        #[source]
        source: serde_json::Error,
    },

    /// 实例 id 不能安全地拼进 `versions/` 下的路径（含分隔符、`..`、以点开头等）。
    #[error("实例 id 不合法：{id:?}")]
    InvalidId { id: String },

    /// 实例名称不满足命名规则。
    #[error("实例名称「{name}」不可用：{}", .violation.message())]
    InvalidName {
        name: String,
        violation: NameViolation,
    },

    /// 实例设置里有不合法的字段。
    #[error("实例设置的 {field} 不合法：{reason}")]
    InvalidSettings { field: &'static str, reason: String },

    /// 侧栏固定列表不合法。
    #[error("侧栏固定列表不合法：{reason}")]
    InvalidPins {
        reason: PinsViolation,
        /// 触发问题的实例 id（重复或不存在时）。
        id: Option<String>,
    },

    /// 有别的实例经 inheritsFrom 依赖这个实例，改名或删除会让它们坏掉。
    #[error("实例 {id} 被 {} 依赖，不能改名或删除", .dependents.join("、"))]
    HasDependents { id: String, dependents: Vec<String> },

    /// 实例缺少可用的版本 JSON，也没有记下当初的安装内容，无从补全。
    #[error("实例 {id} 无法补全：{reason}")]
    NotRepairable { id: String, reason: String },

    /// 移入回收站失败。
    #[error("移入回收站失败：{path}（{reason}）")]
    Recycle { path: PathBuf, reason: String },

    /// 实例目录在，但版本 JSON 缺失或损坏，读不出它是什么版本、该用哪个目录运行。
    #[error("实例 {id} 的版本 JSON 不可用：{reason}")]
    Broken { id: String, reason: String },

    /// 存档备份的 zip 读不了或写不成（不是 zip、条目坏了、解压后大小对不上等）。
    #[error("存档备份 {path} 读写失败：{reason}")]
    BackupArchive { path: PathBuf, reason: String },

    /// 备份里有不能安全解出的条目；`reason` 是稳定的规则码，见 [`crate::world_backup::stage_restore`]。
    #[error("备份 {path} 里的条目「{entry}」不能解出：{}", crate::world_backup::unsafe_entry_text(.reason))]
    BackupEntryUnsafe {
        path: PathBuf,
        entry: String,
        reason: &'static str,
    },

    /// 备份解出来了，但里面没有 level.dat 或读不懂，不像一个能玩的存档。
    #[error("备份 {path} 里的 level.dat 读不出来：{reason}")]
    BackupLevelUnreadable { path: PathBuf, reason: String },

    /// 某个存档的备份清单（index.json）读不懂。
    #[error("存档备份清单 {path} 读不懂：{reason}")]
    BackupIndexInvalid { path: PathBuf, reason: String },

    /// 存档正被游戏打开（游戏对 session.lock 持有排他锁）。
    #[error("存档 {path} 正被游戏打开，结束游戏后再试")]
    WorldInUse { path: PathBuf },

    /// 原来的存档已移入回收站，恢复出的副本却没能改名就位；副本留在 `staged`，那是用户唯一的新副本。
    #[error("原来的存档已移入回收站，但恢复出的存档没能放到 {world_dir}，它还在 {staged}")]
    RestoreNotPlaced { world_dir: PathBuf, staged: PathBuf },

    /// 存档备份的参数不成立（存档文件夹名不安全、导出位置不对）；`field` 指出是哪个参数。
    #[error("{reason}")]
    InvalidBackupArgument { field: &'static str, reason: String },

    /// 打包或解压被取消令牌中止。
    #[error("操作已取消")]
    Cancelled,
}

/// 侧栏固定列表的问题。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PinsViolation {
    /// 超过上限。
    TooMany,
    /// 同一个实例出现了不止一次。
    Duplicate,
    /// 列表里有不存在的实例。
    NotFound,
}

impl PinsViolation {
    pub fn code(self) -> &'static str {
        match self {
            PinsViolation::TooMany => "too_many",
            PinsViolation::Duplicate => "duplicate",
            PinsViolation::NotFound => "not_found",
        }
    }
}

impl std::fmt::Display for PinsViolation {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            PinsViolation::TooMany => "侧栏最多固定 5 个实例",
            PinsViolation::Duplicate => "同一个实例重复固定",
            PinsViolation::NotFound => "要固定的实例不存在",
        })
    }
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
            // 解析类与参数类错误重试也是同样结果。
            Error::Version(_)
            | Error::Json { .. }
            | Error::InvalidId { .. }
            | Error::InvalidName { .. }
            | Error::InvalidSettings { .. }
            | Error::InvalidPins { .. }
            | Error::HasDependents { .. }
            | Error::NotRepairable { .. }
            | Error::Recycle { .. }
            | Error::Broken { .. }
            | Error::BackupArchive { .. }
            | Error::BackupEntryUnsafe { .. }
            | Error::BackupLevelUnreadable { .. }
            | Error::BackupIndexInvalid { .. }
            | Error::WorldInUse { .. }
            | Error::RestoreNotPlaced { .. }
            | Error::InvalidBackupArgument { .. }
            | Error::Cancelled => false,
        }
    }
}

/// 判断 IO 错误是否属于「换个时机可能就好了」的瞬时故障。与 petalfall-base 的判据保持一致。
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
        // petalfall-base 的 HashMismatch 判定为可重试，透传后仍应可重试。
        let err: Error = petalfall_base::Error::HashMismatch {
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
            path: PathBuf::from(crate::PETALFALL_META_DIR).join("settings.json"),
            source: serde_json::from_str::<serde_json::Value>("{bad").unwrap_err(),
        };
        assert!(!json_err.is_retryable());

        let version_err: Error = petalfall_version::Error::SelfInherit { id: "1.21".into() }.into();
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
