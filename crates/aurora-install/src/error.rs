//! crate 统一错误类型。
//!
//! 与 workspace 其它 crate 一致，只暴露一个 [`Error`] 枚举，下游用 `#[from] aurora_install::Error`
//! 一处冒泡。下层 aurora-base / aurora-download / aurora-version 的错误各自透传，并把它们的
//! 可重试性继承过来。安装是「先下载再本地加工」的两段式流程，故错误面既覆盖网络/下载，也覆盖
//! zip 解包、子进程执行与 install_profile 结构异常。

use std::path::PathBuf;

use aurora_base::retry::RetryableError;

/// aurora-install 对外统一错误。
#[derive(Debug, thiserror::Error)]
pub enum Error {
    /// 来自 aurora-base 的错误（镜像改写 / 原子写入 / sha1 校验等）原样透传。
    #[error(transparent)]
    Base(#[from] aurora_base::Error),

    /// 来自 aurora-download 的错误（单文件下载 / 换源耗尽等）原样透传。
    #[error(transparent)]
    Download(#[from] aurora_download::Error),

    /// 来自 aurora-version 的错误（版本 JSON 解析 / 继承合并）原样透传。
    #[error(transparent)]
    Version(#[from] aurora_version::Error),

    /// 抓取元数据（Fabric/Quilt meta、版本 JSON、maven-metadata）时的 HTTP 层错误。
    #[error("HTTP 请求失败: {url}")]
    Http {
        url: String,
        #[source]
        source: reqwest::Error,
    },

    /// 元数据在每个下载源上都没取到（连不上、非 2xx、内容读不懂）。`attempts` 按尝试顺序记下每个候选
    /// 地址与它失败的完整原因，界面据此能把每个源各自为什么失败都摆出来；`last` 是最后一个候选的原错误，
    /// 原因链从它接着往下，上层沿链判断是不是断网时不会因为多包了一层而认不出。
    #[error("{context} 在全部 {} 个下载源上都失败：{}", .attempts.len(), .attempts.join("；"))]
    AllSourcesFailed {
        context: String,
        attempts: Vec<String>,
        #[source]
        last: Box<Error>,
    },

    /// JSON 反序列化失败，`context` 标明是哪份报文。
    #[error("解析 JSON 失败: {context}")]
    Json {
        context: String,
        #[source]
        source: serde_json::Error,
    },

    /// 读取 / 解包 zip（natives jar 或 installer jar）失败。
    #[error("处理 zip 归档失败: {path}")]
    Zip {
        path: PathBuf,
        #[source]
        source: zip::result::ZipError,
    },

    /// 本地文件读写失败，附带具体路径。
    #[error("文件 IO 失败: {path}")]
    Io {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },

    /// 一批并发下载中有文件在换源与重试后仍失败。`stage` 标明是哪一阶段（库 / 资源 / installer 库）。
    #[error("{stage} 阶段有 {failed}/{total} 个文件下载失败")]
    BatchIncomplete {
        stage: &'static str,
        total: usize,
        failed: usize,
        /// 其中一个文件的最终错误：有网络层失败时取它，否则取第一个。挂在 source 上，
        /// 上层才能沿原因链认出这批失败是不是断网造成的。
        #[source]
        cause: Box<aurora_download::Error>,
    },

    /// 版本 JSON 缺少客户端主件下载信息，无法确定 client.jar 来源。
    #[error("版本 {version} 的 JSON 缺少 downloads.client")]
    MissingClientDownload { version: String },

    /// 版本 JSON 缺少 assetIndex，无法补全资源。
    #[error("版本 {version} 的 JSON 缺少 assetIndex")]
    MissingAssetIndex { version: String },

    /// 库坐标无法解析为合法 maven 坐标（缺 group/artifact/version）。
    #[error("非法的库坐标: {name}")]
    InvalidLibraryCoordinate { name: String },

    /// Fabric/Quilt meta 未给出目标游戏版本的可用 loader。
    #[error("{loader} 没有适用于 {game_version} 的可用 loader 版本")]
    LoaderVersionNotFound {
        loader: &'static str,
        game_version: String,
    },

    /// installer jar 内缺少 install_profile 声明要提取的条目（版本 JSON / data 文件 / 通用 jar）。
    #[error("installer jar 内缺少条目: {entry}")]
    InstallerEntryMissing { entry: String },

    /// install_profile.json 结构不被支持（既非现代 processors 式，也非 legacy install 式）。
    #[error("不支持的 install_profile 结构: {reason}")]
    UnsupportedInstallProfile { reason: String },

    /// 处理器参数引用了 data 表里不存在的键。
    #[error("处理器参数引用了未知的 data 键: {key}")]
    DataKeyMissing { key: String },

    /// 从处理器 jar 的 MANIFEST.MF 读不到 Main-Class，无法组装 java 调用。
    #[error("处理器 jar 缺少 Main-Class: {jar}")]
    ProcessorMainClassMissing { jar: String },

    /// 启动 java 子进程本身失败（路径不存在 / 无执行权限等）。
    #[error("启动 java 子进程失败: {path}")]
    JavaLaunch {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },

    /// java 处理器以非零码退出，安装无法继续。
    #[error("处理器 {jar} 执行失败（退出码 {status:?}）")]
    ProcessorFailed { jar: String, status: Option<i32> },
}

/// crate 级 `Result` 别名。
pub type Result<T> = std::result::Result<T, Error>;

impl RetryableError for Error {
    fn is_retryable(&self) -> bool {
        match self {
            // 下层已各自区分好瞬时/永久，直接继承。
            Error::Base(inner) => inner.is_retryable(),
            Error::Download(inner) => inner.is_retryable(),
            Error::Version(_) => false,
            // 网络类：超时、建连、请求发送失败可重试；5xx / 429 当作瞬时故障。
            Error::Http { source, .. } => is_retryable_http(source),
            // 结构 / 解包 / 子进程 / 本地 IO 类：重试无意义或不安全，交由上层处置。
            // 每个源都已各自重试过，整体再来一遍只是把同样的失败重演一次。
            Error::AllSourcesFailed { .. } => false,
            Error::Json { .. }
            | Error::Zip { .. }
            | Error::Io { .. }
            | Error::BatchIncomplete { .. }
            | Error::MissingClientDownload { .. }
            | Error::MissingAssetIndex { .. }
            | Error::InvalidLibraryCoordinate { .. }
            | Error::LoaderVersionNotFound { .. }
            | Error::InstallerEntryMissing { .. }
            | Error::UnsupportedInstallProfile { .. }
            | Error::DataKeyMissing { .. }
            | Error::ProcessorMainClassMissing { .. }
            | Error::JavaLaunch { .. }
            | Error::ProcessorFailed { .. } => false,
        }
    }
}

/// 判断一个 reqwest 错误是否值得重试（与 aurora-java 同策略）。
fn is_retryable_http(err: &reqwest::Error) -> bool {
    if err.is_timeout() || err.is_connect() || err.is_request() {
        return true;
    }
    match err.status() {
        Some(status) => {
            status.is_server_error() || status == reqwest::StatusCode::TOO_MANY_REQUESTS
        }
        None => false,
    }
}

/// 把 std::io 错误包成携带路径的 crate 错误。
pub(crate) fn io_err(path: impl Into<PathBuf>, source: std::io::Error) -> Error {
    Error::Io {
        path: path.into(),
        source,
    }
}

/// 把 zip 错误包成携带归档路径的 crate 错误。
pub(crate) fn zip_err(path: impl Into<PathBuf>, source: zip::result::ZipError) -> Error {
    Error::Zip {
        path: path.into(),
        source,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn version_and_structural_errors_are_not_retryable() {
        let err = Error::UnsupportedInstallProfile {
            reason: "既无 processors 也无 install".into(),
        };
        assert!(!err.is_retryable());

        let err = Error::DataKeyMissing {
            key: "BINPATCH".into(),
        };
        assert!(!err.is_retryable());
    }

    #[test]
    fn base_hash_mismatch_is_retryable_through_delegation() {
        let err = Error::Base(aurora_base::Error::HashMismatch {
            algorithm: "SHA-1",
            expected: "aa".into(),
            actual: "bb".into(),
        });
        assert!(err.is_retryable());
    }

    #[test]
    fn batch_incomplete_carries_counts() {
        let err = Error::BatchIncomplete {
            stage: "库",
            total: 40,
            failed: 3,
            cause: Box::new(aurora_download::Error::Status {
                url: "https://libraries.minecraft.net/a.jar".into(),
                status: 404,
            }),
        };
        assert_eq!(err.to_string(), "库 阶段有 3/40 个文件下载失败");
        let cause = std::error::Error::source(&err).expect("应挂着其中一个文件的错误");
        assert_eq!(
            cause.to_string(),
            "HTTP 状态码 404: https://libraries.minecraft.net/a.jar"
        );
    }
}
