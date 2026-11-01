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
    #[error("HTTP 请求失败：{url}")]
    Http {
        url: String,
        #[source]
        source: reqwest::Error,
    },

    /// 清单响应体超过读取上限。`size` 是响应头声明的长度，或读到超限那一刻已收到的字节数，都是实际大小的
    /// 下界。
    #[error("{url} 的响应体至少有 {size} 字节，超过 {limit} 字节的上限")]
    ResponseTooLarge { url: String, size: u64, limit: u64 },

    /// JSON 反序列化失败，`context` 标明是哪一份报文（all.json / 组件清单）。
    #[error("解析 JSON 失败：{context}")]
    Json {
        context: String,
        #[source]
        source: serde_json::Error,
    },

    /// 启动 `java -version` 子进程本身失败（路径不存在 / 无执行权限等）。
    #[error("执行 java 可执行文件失败：{path}")]
    JavaExec {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },

    /// `java -version` 有输出，但无法从中解析出版本号。
    #[error("无法从 java -version 输出解析版本号：{output}")]
    JavaVersionParse { output: String },

    /// `java -version` 在等待上限内没有结束；子进程已被结束并确认退出。
    #[error("java -version 超过 {timeout_secs} 秒没有结束，已结束该进程：{path}")]
    JavaProbeTimeout { path: PathBuf, timeout_secs: u64 },

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

    /// 组件清单里的文件路径会落到运行时安装目录之外（为空、是绝对路径，或含 `..`、盘符、反斜杠、冒号、
    /// 空段）。清单与其中文件的 sha1 来自同一个源（可以是镜像），下载校验拦不住，所以在算落点时就拒掉。
    #[error("Java 运行时清单里的路径「{path}」{reason}，会落到运行时目录之外，已拒绝安装")]
    UnsafeRuntimePath { path: String, reason: &'static str },

    /// 组件清单里的符号链接指到运行时安装目录之外：之后经它写入或加载的文件会落到别处。
    #[error("Java 运行时清单里的链接「{path}」指向「{target}」，会指到运行时目录之外，已拒绝安装")]
    UnsafeRuntimeLink { path: String, target: String },

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
            // 挂住的 JVM 再拉一次多半还是挂住，只会让调用方多等一个超时。
            | Error::JavaProbeTimeout { .. }
            | Error::UnsupportedPlatform(_)
            | Error::NoRuntimeForMajor { .. }
            | Error::MissingJavaExecutable => false,
            // 取消是调用方的决定，重试违背它。
            Error::Cancelled => false,
            // 同一个地址再来一次还是这么大；换源由候选循环负责。
            Error::ResponseTooLarge { .. } => false,
            // 清单内容本身越界，重拉同一份清单结果不变。
            Error::UnsafeRuntimePath { .. } | Error::UnsafeRuntimeLink { .. } => false,
            // 每个源内部已按策略重试过，整体再来一轮只会把同样的失败重演一遍。
            Error::AllSourcesFailed { .. } => false,
        }
    }
}

/// 判断一个 reqwest 错误是否值得重试（与 aurora-install 同策略）。
///
/// 读响应体时连接被重置或提前关闭也算瞬时故障：reqwest 把读体失败包成 decode 类，只认 body 类会把读到
/// 一半断开的请求当成永久失败、直接换源，两个源各断一次整次 Java 下载就失败了。
fn is_retryable_http(err: &reqwest::Error) -> bool {
    if err.is_timeout() || err.is_connect() || err.is_request() || err.is_body() || err.is_decode()
    {
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
                "https://a/all.json：HTTP 请求失败：https://a/all.json".to_owned(),
                "https://b/all.json：Java 运行时清单不含平台 x".to_owned(),
            ],
            last: Box::new(Error::UnsupportedPlatform("x".to_owned())),
        };

        assert_eq!(
            err.to_string(),
            "Java 运行时总清单 在全部 2 个下载源上都失败：\
             https://a/all.json：HTTP 请求失败：https://a/all.json；\
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

    /// 这些原文经 detail.causes 与日志出现在界面上，和「没能添加 Java」的主提示并排：中文句后一律全角冒号。
    #[test]
    fn chinese_messages_use_full_width_colons() {
        let http = Error::Http {
            url: "https://a/all.json".into(),
            source: reqwest::Client::new()
                .get("不是网址")
                .build()
                .expect_err("非法网址构建请求必然失败"),
        };
        assert_eq!(http.to_string(), "HTTP 请求失败：https://a/all.json");
        let json = Error::Json {
            context: "all.json".into(),
            source: serde_json::from_str::<serde_json::Value>("{").expect_err("半截 JSON"),
        };
        assert_eq!(json.to_string(), "解析 JSON 失败：all.json");
        let exec = Error::JavaExec {
            path: PathBuf::from("D:/Java/bin/java.exe"),
            source: std::io::Error::from(std::io::ErrorKind::NotFound),
        };
        assert_eq!(
            exec.to_string(),
            "执行 java 可执行文件失败：D:/Java/bin/java.exe"
        );
        let parse = Error::JavaVersionParse {
            output: "garbage".into(),
        };
        assert_eq!(
            parse.to_string(),
            "无法从 java -version 输出解析版本号：garbage"
        );
        let timeout = Error::JavaProbeTimeout {
            path: PathBuf::from("D:/Java/bin/java.exe"),
            timeout_secs: 10,
        };
        assert_eq!(
            timeout.to_string(),
            "java -version 超过 10 秒没有结束，已结束该进程：D:/Java/bin/java.exe"
        );
    }
}
