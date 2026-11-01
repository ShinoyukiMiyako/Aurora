//! 门面层错误枚举。
//!
//! aurora-core 组合各下层 crate，故其错误既向下透传各 crate 的独立错误（`#[from]` 冒泡，不吞不掩），
//! 也补充门面自身的失败：配置读写/解析、缺失微软 client_id、目标版本未安装、无匹配 Java 等。
//! 统一收口后由更上层（aurora-cli / 未来前端）做兜底展示。

use std::path::PathBuf;

/// 门面层统一错误。
#[derive(Debug, thiserror::Error)]
pub enum CoreError {
    /// 下层公共设施错误（HTTP 构建、镜像改写、文件校验、目录定位）。
    #[error(transparent)]
    Base(#[from] aurora_base::Error),
    /// 版本 JSON 解析/继承合并错误。
    #[error(transparent)]
    Version(#[from] aurora_version::Error),
    /// 下载引擎错误。
    #[error(transparent)]
    Download(#[from] aurora_download::Error),
    /// 安装（原版/加载器补全）错误。
    #[error(transparent)]
    Install(#[from] aurora_install::Error),
    /// 实例（目录/版本发现/隔离）错误。
    #[error(transparent)]
    Instance(#[from] aurora_instance::Error),
    /// Java 探测/自动下载错误。
    #[error(transparent)]
    Java(#[from] aurora_java::Error),
    /// 账户/登录错误。
    #[error(transparent)]
    Auth(#[from] aurora_auth::AuthError),
    /// 启动链路错误。
    #[error(transparent)]
    Launch(#[from] aurora_launch::LaunchError),
    /// Mod 平台错误（Modrinth/CurseForge 客户端、本地模组扫描与启禁）。
    #[error(transparent)]
    ModPlatform(#[from] aurora_modplatform::Error),
    /// 整合包文件错误（格式、清单、路径安全、解压）。
    #[error(transparent)]
    Modpack(#[from] aurora_modpack::Error),

    /// 读取配置文件失败。
    #[error("读取配置文件 {path} 失败")]
    ConfigIo {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
    /// 配置文件内容非法。
    #[error("解析配置文件 {path} 失败")]
    ConfigParse {
        path: PathBuf,
        #[source]
        source: serde_json::Error,
    },
    /// 配置序列化失败。
    #[error("序列化配置失败")]
    ConfigSerialize(#[source] serde_json::Error),

    /// 请求启动/操作的版本本地未安装。
    #[error("本地未安装版本 {id}")]
    VersionNotInstalled { id: String },
    /// 请求安装的模组版本/文件在平台上不存在。
    #[error("平台 {platform} 上工程 {project_id} 未找到版本 {version_id}")]
    ModVersionNotFound {
        platform: &'static str,
        project_id: String,
        version_id: String,
    },
    /// 找不到匹配主版本的 Java，且自动下载被关闭。
    #[error(
        "未找到匹配 Java {major} 的运行时，且自动下载已关闭（开启 auto_download_java 或手动安装对应 Java）"
    )]
    NoJava { major: u32 },
    /// 启动前检查存在阻断项，已中止启动。
    #[error("启动前检查未通过：{0}")]
    PrecheckFailed(String),
    /// 后台阻塞任务异常结束（如 Java 探测子任务 panic）。
    #[error("后台任务异常结束")]
    TaskJoin(#[from] tokio::task::JoinError),
    /// 该操作在当前平台不受支持（微软登录凭据加密仅限 Windows）。
    #[error("该操作在当前平台不受支持（微软登录的凭据加密仅限 Windows）")]
    PlatformUnsupported,
    /// 工程 id 的格式不符合该平台的约定（CurseForge 的工程与文件 id 都是十进制数字）。
    #[error("{platform} 的工程 id 格式不对：{project_id}")]
    InvalidProjectId {
        platform: &'static str,
        project_id: String,
    },
    /// 资源安装的目标不成立（数据包没指明存档、非数据包却给了存档、整合包当单个资源装等）。
    #[error("安装目标不对：{0}")]
    InvalidResourceTarget(String),
    /// 数据包要装进的存档在该实例里不存在。
    #[error("实例 {version_id} 里没有存档 {world}")]
    WorldNotFound { version_id: String, world: String },
    /// 平台给出的文件名不能安全地落盘（含路径分隔符、`..` 等）。
    #[error("{platform} 给出的文件名不安全：{file_name}")]
    UnsafeFileName {
        platform: &'static str,
        file_name: String,
    },
    /// CurseForge 作者禁止第三方分发，这些文件拿不到下载地址，只能去网页手动下载。
    #[error("这些文件的作者不允许启动器直接下载，需要到 CurseForge 网页手动下载：{}", files.join("、"))]
    FileDistributionBlocked { files: Vec<String> },
    /// 新实例的名字不可用。
    #[error("实例名 {name} 不可用：{}", rule.describe())]
    InstanceNameInvalid {
        name: String,
        rule: crate::modpack::InstanceNameRule,
    },
    /// 启动器写在实例里的 JSON 文件（整合包信息、未完成标记、版本 JSON）读不懂。
    #[error("读不懂 {path}")]
    JsonFileInvalid {
        path: PathBuf,
        #[source]
        source: serde_json::Error,
    },
    /// 序列化启动器自己的 JSON 文件失败。
    #[error("序列化 JSON 失败")]
    JsonSerialize(#[source] serde_json::Error),
    /// 系统时钟早于 1970 年，记不了导入时间。
    #[error("系统时钟早于 1970 年")]
    SystemClock(#[source] std::time::SystemTimeError),

    /// 请求远端内容源（资讯等）失败：连不上、超时或非 2xx。
    #[error("请求 {url} 失败")]
    Fetch {
        url: String,
        #[source]
        source: reqwest::Error,
    },
    /// 远端内容源（资讯等）回来的正文超出上限，没有整个读进内存。`size` 是响应头声明的长度，或读到超限那一刻
    /// 已收到的字节数，都是实际大小的下界。
    #[error("{url} 回来的内容至少有 {size} 字节，超过 {limit} 字节的上限")]
    FeedTooLarge { url: String, size: u64, limit: u64 },
    /// 只读远端整合包的目录与清单时读不下去：服务器不支持范围读取、不是可读的 zip、缺清单。
    #[error("读不了远端整合包 {url} 的清单：{reason}")]
    RemotePack { url: String, reason: String },
    /// 远端内容源返回的内容不是预期的格式。
    #[error("解析 {url} 的内容失败")]
    FeedParse {
        url: String,
        #[source]
        source: serde_json::Error,
    },
    /// 服务器地址写法不合法。
    #[error("服务器地址「{address}」不合法：{reason}")]
    InvalidServerAddress {
        address: String,
        reason: &'static str,
    },
    /// 游戏目录不能用作当前目录。
    #[error("游戏目录 {path} 不能用：{problem}")]
    InvalidGameDirectory {
        path: PathBuf,
        problem: GameDirProblem,
    },
    /// 读不到本机物理内存信息。
    #[error("读不到本机内存信息")]
    MemoryUnavailable,
}

/// 游戏目录不能用的具体原因。[`GameDirProblem::code`] 是给前端分支用的稳定码。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GameDirProblem {
    /// 路径为空。
    Empty,
    /// 不是绝对路径。
    NotAbsolute,
    /// 路径含 `!`：Java 的类路径会把 `!` 当成 jar 内路径分隔，读不出里面的游戏文件。
    ContainsBang,
    /// 位置此刻访问不到（盘没插、网络断开）或不是目录。
    Unavailable,
}

impl GameDirProblem {
    /// 稳定的 snake_case 码。
    pub fn code(self) -> &'static str {
        match self {
            GameDirProblem::Empty => "empty",
            GameDirProblem::NotAbsolute => "not_absolute",
            GameDirProblem::ContainsBang => "contains_bang",
            GameDirProblem::Unavailable => "unavailable",
        }
    }
}

impl std::fmt::Display for GameDirProblem {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            GameDirProblem::Empty => "路径为空",
            GameDirProblem::NotAbsolute => "不是绝对路径",
            GameDirProblem::ContainsBang => "路径里有「!」，Java 会读不出里面的游戏文件",
            GameDirProblem::Unavailable => "这个位置现在访问不到",
        })
    }
}

impl CoreError {
    /// 是否由取消令牌引起。取消可能从下载引擎、安装器或 Java 下载任一层冒上来，
    /// 上层据此把它与真正的失败分开（前端不弹错误、任务记为已取消）。
    pub fn is_cancelled(&self) -> bool {
        match self {
            CoreError::Download(err) => err.is_cancelled(),
            CoreError::Install(aurora_install::Error::Download(err)) => err.is_cancelled(),
            CoreError::Java(err) => err.is_cancelled(),
            CoreError::Auth(err) => err.is_cancelled(),
            CoreError::Modpack(aurora_modpack::Error::Cancelled) => true,
            _ => false,
        }
    }
}

/// 门面层 `Result` 别名，下游用 `#[from] aurora_core::CoreError` 冒泡。
pub type Result<T> = std::result::Result<T, CoreError>;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cancellation_is_recognised_at_every_layer_it_can_surface_from() {
        assert!(CoreError::Download(aurora_download::Error::Cancelled).is_cancelled());
        assert!(
            CoreError::Install(aurora_install::Error::Download(
                aurora_download::Error::Cancelled
            ))
            .is_cancelled()
        );
        assert!(CoreError::Java(aurora_java::Error::Cancelled).is_cancelled());
        assert!(CoreError::Auth(aurora_auth::AuthError::Cancelled).is_cancelled());
        assert!(!CoreError::Auth(aurora_auth::AuthError::ReloginRequired).is_cancelled());
        assert!(CoreError::Modpack(aurora_modpack::Error::Cancelled).is_cancelled());

        // 真正的失败不能被当成取消。
        assert!(!CoreError::NoJava { major: 17 }.is_cancelled());
        assert!(
            !CoreError::Download(aurora_download::Error::Status {
                url: "http://x".into(),
                status: 404,
            })
            .is_cancelled()
        );
    }
}
