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

    /// 版本 JSON、资源索引给出的相对路径（库路径、maven 坐标的某一段、资源 hash、索引 id、日志配置名、
    /// 版本 id）会落到游戏目录之外。这些值来自远端，sha1 也由同一份文件给出，下载校验拦不住，所以在算落点时
    /// 就拒掉。`entry` 指认是哪个条目，`problem` 说明是哪一种问题。
    #[error("{entry}：路径「{path}」会落到游戏目录之外，已拒绝写入")]
    UnsafePath {
        entry: String,
        path: String,
        #[source]
        problem: aurora_version::UnsafePath,
    },

    /// 加载器安装器自带的库（版本 JSON 里声明了下载件、地址留空）缺失或已损坏。它只在安装加载器时从
    /// installer 里解出或由处理器生成，没有地址可以重新下载。
    #[error(
        "加载器自带的库 {} 缺失或已损坏，它只能由加载器安装器生成，需要重新安装加载器",
        file_label(path)
    )]
    LoaderLibraryMissing { path: PathBuf },
}

/// 报错正文里只写文件名：完整路径太长，放进错误详情。
fn file_label(path: &std::path::Path) -> String {
    path.file_name().map_or_else(
        || path.display().to_string(),
        |name| name.to_string_lossy().into_owned(),
    )
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
            // 路径越界与加载器自带库缺失都是文件内容本身的问题，重下同一份文件结果不变。
            Error::UnsafePath { .. } | Error::LoaderLibraryMissing { .. } => false,
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
