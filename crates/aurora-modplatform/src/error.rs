//! crate 统一错误类型。
//!
//! 本 crate 在 [`aurora_base::Error`] 之上叠加 Mod 平台专属的失败形态（HTTP 状态、JSON/TOML
//! 解析、jar 读取、CurseForge 未配置密钥、模组启禁冲突等）。底层的哈希/IO/URL 错误经
//! [`Error::Base`] 直接冒泡，下游只需 `#[from] aurora_modplatform::Error` 一处承接。
//!
//! 可重试性实现在 [`RetryableError`] 上：区分「换个时机或换个源可能就好」的瞬时故障与
//! 「重试也是白搭」的确定性失败，喂给 [`aurora_base::retry::retry_async`] 精确控制退避。

use std::path::PathBuf;

use aurora_base::retry::RetryableError;

/// aurora-modplatform 对外统一错误。
#[derive(Debug, thiserror::Error)]
pub enum Error {
    /// 底层设施错误（文件 IO、哈希、URL 改写等），来自 aurora-base。
    #[error(transparent)]
    Base(#[from] aurora_base::Error),

    /// 发送请求或读取响应体时的传输层错误（连接、超时、读到一半断开）。context 标明是哪一次调用。
    #[error("HTTP 请求失败: {context}")]
    Http {
        context: String,
        #[source]
        source: reqwest::Error,
    },

    /// 服务器返回了非 2xx 状态码。是否重试由状态码类别决定（5xx/429/408 可重试）。
    #[error("HTTP 状态码 {status}: {url}")]
    Status { url: String, status: u16 },

    /// 解析平台返回的 JSON 或 jar 内的 `fabric.mod.json` 失败。
    #[error("JSON 解析失败: {context}")]
    Json {
        context: String,
        #[source]
        source: serde_json::Error,
    },

    /// 解析 `META-INF/mods.toml` / `neoforge.mods.toml` 失败。
    #[error("TOML 解析失败: {context}")]
    Toml {
        context: String,
        #[source]
        source: toml::de::Error,
    },

    /// 读取 jar（zip）条目失败（非「不是合法压缩包」——那种情况按「无元数据」处理）。
    #[error("读取 jar 失败: {path}")]
    Zip {
        path: PathBuf,
        #[source]
        source: zip::result::ZipError,
    },

    /// CurseForge 需要 API key 才能访问，但环境变量 `AURORA_CURSEFORGE_API_KEY` 缺失或为空。
    /// 该源被明确禁用，而非静默降级——调用方据此决定是否只走 Modrinth。
    #[error("CurseForge API key 未配置（环境变量 AURORA_CURSEFORGE_API_KEY 缺失），该源已禁用")]
    CurseForgeKeyMissing,

    /// 切换模组启用/禁用状态时，目标文件名已存在（同名启用与禁用副本冲突）。
    #[error("Mod 启用状态切换失败：目标文件已存在 {path}")]
    ModStateConflict { path: PathBuf },
}

/// crate 级 `Result` 别名。
pub type Result<T> = std::result::Result<T, Error>;

impl RetryableError for Error {
    fn is_retryable(&self) -> bool {
        match self {
            // 委托底层：哈希不符（重下）、瞬时 IO 抖动可重试；配置/环境类不可。
            Error::Base(err) => err.is_retryable(),
            Error::Http { source, .. } => is_transient_reqwest(source),
            // 5xx 服务端抽风、429 限流、408 请求超时值得再试；403/404 等确定性拒绝立即放弃。
            Error::Status { status, .. } => {
                *status == 408 || *status == 429 || (500..=599).contains(status)
            }
            // 解析类、jar 读取、密钥缺失、启禁冲突都是确定性失败，重试也是同样结果。
            Error::Json { .. }
            | Error::Toml { .. }
            | Error::Zip { .. }
            | Error::CurseForgeKeyMissing
            | Error::ModStateConflict { .. } => false,
        }
    }
}

/// 判断 reqwest 传输层错误是否属于「再试一次可能就好」的瞬时故障。
///
/// 明确排除 `is_status`（状态类错误由 [`Error::Status`] 单独承载并分级）与 `is_builder`
/// （构造问题，重试无益）。
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
        let e429 = Error::Status {
            url: "http://x/a".into(),
            status: 429,
        };
        let e404 = Error::Status {
            url: "http://x/a".into(),
            status: 404,
        };
        assert!(e500.is_retryable());
        assert!(e429.is_retryable());
        assert!(!e404.is_retryable());
    }

    #[test]
    fn parse_and_config_errors_are_terminal() {
        assert!(!Error::CurseForgeKeyMissing.is_retryable());
        let conflict = Error::ModStateConflict {
            path: PathBuf::from("mods/a.jar.disabled"),
        };
        assert!(!conflict.is_retryable());
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
            url: "http://host/v2/search".into(),
            status: 503,
        };
        assert_eq!(err.to_string(), "HTTP 状态码 503: http://host/v2/search");
        assert_eq!(
            Error::CurseForgeKeyMissing.to_string(),
            "CurseForge API key 未配置（环境变量 AURORA_CURSEFORGE_API_KEY 缺失），该源已禁用"
        );
        // 原文直接作批量启停部分失败通知的正文，叫法与标点要和界面一致
        let conflict = Error::ModStateConflict {
            path: PathBuf::from("D:/mc/mods/a.jar.disabled"),
        };
        assert_eq!(
            conflict.to_string(),
            "Mod 启用状态切换失败：目标文件已存在 D:/mc/mods/a.jar.disabled"
        );
    }
}
