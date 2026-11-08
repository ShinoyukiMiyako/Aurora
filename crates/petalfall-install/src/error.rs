//! crate 统一错误类型。
//!
//! 与 workspace 其它 crate 一致，只暴露一个 [`Error`] 枚举，下游用 `#[from] petalfall_install::Error`
//! 一处冒泡。下层 petalfall-base / petalfall-download / petalfall-version 的错误各自透传，并把它们的
//! 可重试性继承过来。安装是「先下载再本地加工」的两段式流程，故错误面既覆盖网络/下载，也覆盖
//! zip 解包、子进程执行与 install_profile 结构异常。

use std::path::PathBuf;

use petalfall_base::retry::RetryableError;

/// petalfall-install 对外统一错误。
#[derive(Debug, thiserror::Error)]
pub enum Error {
    /// 来自 petalfall-base 的错误（镜像改写 / 原子写入 / sha1 校验等）原样透传。
    #[error(transparent)]
    Base(#[from] petalfall_base::Error),

    /// 来自 petalfall-download 的错误（单文件下载 / 换源耗尽等）原样透传。
    #[error(transparent)]
    Download(#[from] petalfall_download::Error),

    /// 来自 petalfall-version 的错误（版本 JSON 解析 / 继承合并）原样透传。
    #[error(transparent)]
    Version(#[from] petalfall_version::Error),

    /// 抓取元数据（Fabric/Quilt meta、版本 JSON、maven-metadata）时的 HTTP 层错误。
    #[error("HTTP 请求失败: {url}")]
    Http {
        url: String,
        #[source]
        source: reqwest::Error,
    },

    /// 元数据响应体超过读取上限。`size` 是响应头声明的长度，或读到超限那一刻已收到的字节数，都是实际大小的
    /// 下界。
    #[error("{url} 的响应体至少有 {size} 字节，超过 {limit} 字节的上限")]
    ResponseTooLarge { url: String, size: u64, limit: u64 },

    /// 后面还有别的源可换时，这个源迟迟没回响应头，不再等它。
    #[error("{url} 在 {seconds} 秒内没有响应")]
    NoResponse { url: String, seconds: u64 },

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
        cause: Box<petalfall_download::Error>,
    },

    /// 版本 JSON 缺少客户端主件下载信息，无法确定 client.jar 来源。
    #[error("版本清单里的 {expected} 指向的版本 JSON 写的是 {actual}")]
    VersionIdMismatch { expected: String, actual: String },

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
    ProcessorFailed {
        jar: String,
        status: Option<i32>,
        /// 处理器自己的输出，java 抛出的异常就在这里面。
        #[source]
        output: ProcessorOutput,
    },

    /// 处理器要写的文件正被别的进程打开着：多半是另一个实例正用同一个 Forge / NeoForge 版本运行，
    /// 游戏的 JVM 占着库目录里的这份 jar。重试没用，要等那个游戏退出。
    #[error(
        "{path} 正被别的程序占用，处理器 {jar} 写不进去；可能有游戏正在用同一个加载器版本运行，关掉它后再试"
    )]
    ProcessorOutputLocked {
        jar: String,
        path: PathBuf,
        /// 处理器已经跑过并失败时是它的输出；动手之前就查出占用时为空。
        #[source]
        output: Option<ProcessorOutput>,
    },

    /// 要写进库目录的文件正被别的进程打开着（旧版 Forge 的通用 jar 由安装器直接解出，不经处理器）。
    /// 与 [`Error::ProcessorOutputLocked`] 同样重试没用，要等那个游戏退出。
    #[error(
        "{path} 正被别的程序占用，写不进去；可能有游戏正在用同一个加载器版本运行，关掉它后再试"
    )]
    LibraryFileLocked {
        path: PathBuf,
        /// 写入失败时的原始错误。
        #[source]
        source: petalfall_base::Error,
    },

    /// 版本 JSON、资源索引给出的相对路径（库路径、maven 坐标的某一段、资源 hash、索引 id、日志配置名、
    /// 版本 id）会落到游戏目录之外。这些值来自远端，sha1 也由同一份文件给出，下载校验拦不住，所以在算落点时
    /// 就拒掉。`entry` 指认是哪个条目，`problem` 说明是哪一种问题。
    #[error("{entry}：路径「{path}」会落到游戏目录之外，已拒绝写入")]
    UnsafePath {
        entry: String,
        path: String,
        #[source]
        problem: petalfall_version::UnsafePath,
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
            // 同一个地址再来一次还是这么大；换源由候选循环负责。
            Error::ResponseTooLarge { .. } => false,
            // 只在还有别的源时才会这样放弃，换源比在这里再等一轮快。
            Error::NoResponse { .. } => false,
            // 结构 / 解包 / 子进程 / 本地 IO 类：重试无意义或不安全，交由上层处置。
            // 每个源都已各自重试过，整体再来一遍只是把同样的失败重演一次。
            Error::AllSourcesFailed { .. } => false,
            Error::Json { .. }
            | Error::Zip { .. }
            | Error::Io { .. }
            | Error::BatchIncomplete { .. }
            | Error::VersionIdMismatch { .. }
            | Error::MissingClientDownload { .. }
            | Error::MissingAssetIndex { .. }
            | Error::InvalidLibraryCoordinate { .. }
            | Error::LoaderVersionNotFound { .. }
            | Error::InstallerEntryMissing { .. }
            | Error::UnsupportedInstallProfile { .. }
            | Error::DataKeyMissing { .. }
            | Error::ProcessorMainClassMissing { .. }
            | Error::JavaLaunch { .. }
            | Error::ProcessorFailed { .. }
            | Error::ProcessorOutputLocked { .. }
            | Error::LibraryFileLocked { .. } => false,
            // 路径越界与加载器自带库缺失都是文件内容本身的问题，重下同一份文件结果不变。
            Error::UnsafePath { .. } | Error::LoaderLibraryMissing { .. } => false,
        }
    }
}

/// 判断一个 reqwest 错误是否值得重试（与 petalfall-java 同策略）。
///
/// 读响应体时连接被重置或提前关闭也算瞬时故障：reqwest 把读体失败包成 decode 类（`Response::bytes`
/// 里统一经 `error::decode`），只认 body 类会把读到一半断开的请求当成永久失败、不再同源重试。
/// 工作区里 petalfall-base 开了 gzip 解压（特性按工作区合并），坏掉的压缩流也会落在 decode 类：那是
/// 确定性失败，但重试有次数上限，代价只是多试几次。
fn is_retryable_http(err: &reqwest::Error) -> bool {
    if err.is_timeout() || err.is_connect() || err.is_request() || err.is_body() || err.is_decode()
    {
        return true;
    }
    match err.status() {
        Some(status) => {
            status.is_server_error() || status == reqwest::StatusCode::TOO_MANY_REQUESTS
        }
        None => false,
    }
}

impl Error {
    /// 是否由取消令牌引起。取消一律以 [`petalfall_download::Error::Cancelled`] 冒上来，不论停在下载、
    /// 元数据抓取、排队还是处理器上；换源与兜底逻辑据此不把它当成某个源的故障。
    pub fn is_cancelled(&self) -> bool {
        matches!(self, Error::Download(inner) if inner.is_cancelled())
    }
}

/// 处理器子进程留下的输出：stdout 与 stderr 按到达顺序合在一起，只留末尾若干行。
///
/// 作为错误挂在处理器错误的原因链上：命令层把原因链整条放进 `detail`，「复制错误原文」与启动器日志
/// 都能直接看到 java 抛出的异常，而不只是一个退出码。
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ProcessorOutput {
    /// 留下的行，不含换行符，按到达顺序。
    pub lines: Vec<String>,
    /// 更早的、因只留末尾而丢掉的行数。
    pub dropped: usize,
}

impl std::fmt::Display for ProcessorOutput {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        if self.lines.is_empty() && self.dropped == 0 {
            return f.write_str("处理器没有任何输出");
        }
        if self.dropped > 0 {
            write!(f, "处理器输出（略去前 {} 行）：", self.dropped)?;
        } else {
            f.write_str("处理器输出：")?;
        }
        for line in &self.lines {
            write!(f, "\n{line}")?;
        }
        Ok(())
    }
}

impl std::error::Error for ProcessorOutput {}

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
        let err = Error::Base(petalfall_base::Error::HashMismatch {
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
            cause: Box::new(petalfall_download::Error::Status {
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
