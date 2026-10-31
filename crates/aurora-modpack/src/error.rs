//! 读整合包与解出覆盖文件的统一错误。
//!
//! 变体按用户能做什么来分：扩展名不对（换个文件）、包里没有清单（不是整合包）、清单读不懂
//! （带原文，便于反馈）、文件损坏（重新下载）、压缩方式不支持（换原始文件）、路径不安全（包有问题，拒装）。

use std::path::PathBuf;

use crate::path::PathValidationError;

/// aurora-modpack 对外错误。
#[derive(Debug, thiserror::Error)]
pub enum Error {
    /// 扩展名既不是 `.mrpack` 也不是 `.zip`。
    #[error("只认 .mrpack 和 CurseForge 导出的 .zip：{path}")]
    UnsupportedExtension { path: PathBuf },

    /// 压缩包根目录既没有 `modrinth.index.json` 也没有 `manifest.json`。
    #[error("压缩包里没有 modrinth.index.json 或 manifest.json：{path}")]
    ManifestMissing { path: PathBuf },

    /// 清单存在但读不懂：JSON 语法错、字段缺失或取值超出格式约定。`reason` 为原文。
    #[error("{document} 读不出来：{reason}")]
    ManifestInvalid {
        document: &'static str,
        reason: String,
    },

    /// 文件不是完整的 zip，或包内条目解压失败。
    #[error("整合包文件不完整或已损坏：{path}")]
    Corrupt {
        path: PathBuf,
        #[source]
        source: zip::result::ZipError,
    },

    /// 要解的条目用了没有内置解压实现的压缩方式（如 Zstandard 的 93，或不认识的方法编号）。包本身
    /// 没坏，重新下载同一个文件没用，要换作者发布的原始文件。`entry` 为解码后的条目名。
    #[error("整合包用了不支持的压缩方式（方法编号 {method}）：{entry}")]
    UnsupportedCompression {
        path: PathBuf,
        entry: String,
        method: u16,
    },

    /// 包里的某条路径不能安全落到实例目录里。
    #[error("整合包里的路径不安全：{path}")]
    UnsafePath {
        path: String,
        #[source]
        source: PathValidationError,
    },

    /// 压缩包里有符号链接条目。照原样解出来会是一个指向任意位置的链接，按普通文件解又会得到
    /// 作者没打算放的内容，两种都不对，整包拒收。
    #[error("整合包里有符号链接条目：{path}")]
    SymlinkEntry { path: String },

    /// 同一份清单里有两条会落到同一个文件（Windows 下不区分大小写）的路径。
    #[error("整合包清单里有重复路径：{path}")]
    DuplicatePath { path: String },

    /// 读包或写覆盖文件时的文件 IO 失败。
    #[error("文件读写失败：{path}")]
    Io {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },

    /// 调用方要求中止（任务被取消）。
    #[error("已取消")]
    Cancelled,
}

impl Error {
    pub(crate) fn invalid(document: &'static str, reason: impl Into<String>) -> Self {
        Error::ManifestInvalid {
            document,
            reason: reason.into(),
        }
    }
}

/// crate 级结果别名。
pub type Result<T> = std::result::Result<T, Error>;
