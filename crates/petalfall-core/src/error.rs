//! 门面层错误枚举。
//!
//! petalfall-core 组合各下层 crate，故其错误既向下透传各 crate 的独立错误（`#[from]` 冒泡，不吞不掩），
//! 也补充门面自身的失败：配置读写/解析、缺失微软 client_id、目标版本未安装、无匹配 Java 等。
//! 统一收口后由更上层（petalfall-cli / 未来前端）做兜底展示。

use std::path::PathBuf;

/// 门面层统一错误。
#[derive(Debug, thiserror::Error)]
pub enum CoreError {
    /// 下层公共设施错误（HTTP 构建、镜像改写、文件校验、目录定位）。
    #[error(transparent)]
    Base(#[from] petalfall_base::Error),
    /// 版本 JSON 解析/继承合并错误。
    #[error(transparent)]
    Version(#[from] petalfall_version::Error),
    /// 下载引擎错误。
    #[error(transparent)]
    Download(#[from] petalfall_download::Error),
    /// 安装（原版/加载器补全）错误。
    #[error(transparent)]
    Install(#[from] petalfall_install::Error),
    /// 实例（目录/版本发现/隔离）错误。
    #[error(transparent)]
    Instance(#[from] petalfall_instance::Error),
    /// Java 探测/自动下载错误。
    #[error(transparent)]
    Java(#[from] petalfall_java::Error),
    /// 账户/登录错误。
    #[error(transparent)]
    Auth(#[from] petalfall_auth::AuthError),
    /// 启动链路错误。
    #[error(transparent)]
    Launch(#[from] petalfall_launch::LaunchError),
    /// Mod 平台错误（Modrinth/CurseForge 客户端、本地模组扫描与启禁）。
    #[error(transparent)]
    ModPlatform(#[from] petalfall_modplatform::Error),
    /// 整合包文件错误（格式、清单、路径安全、解压）。
    #[error(transparent)]
    Modpack(#[from] petalfall_modpack::Error),

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
    /// 本地 jar 不能加进实例；`reason` 是给玩家看的一句话，不走 IO 错误：那一类的顶层文案只有路径，
    /// 玩家看不出是重名还是别的。
    #[error("{reason}")]
    LocalModRefused { path: PathBuf, reason: String },
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
    /// 直达的世界文件夹名里有系统代码页表示不了的字符，Java 的命令行参数带不过去。
    #[error(
        "存档文件夹名里的「{ch}」系统代码页表示不了，没法直接进入。请启动游戏后在单人列表里进入，或把文件夹改名"
    )]
    WorldNameUnencodable {
        version_id: String,
        world: String,
        ch: char,
    },
    /// 要恢复或删除的备份不在这个存档的备份清单里，或清单里有、盘上已经没有了。
    #[error("实例 {version_id} 的存档 {world} 没有备份 {file}")]
    WorldBackupNotFound {
        version_id: String,
        world: String,
        file: String,
    },
    /// 平台给出的文件名不能安全地落盘（含路径分隔符、`..` 等）。
    #[error("{platform} 给出的文件名不安全：{file_name}")]
    UnsafeFileName {
        platform: &'static str,
        file_name: String,
    },
    /// CurseForge 作者禁止第三方分发，这些文件拿不到下载地址，只能去网页手动下载。
    #[error(
        "这些文件的作者不允许启动器直接下载，需要到 CurseForge 网页手动下载：{}",
        blocked_names(files)
    )]
    FileDistributionBlocked {
        files: Vec<crate::blocked::BlockedFile>,
    },
    /// 认领手动下载的文件时，选的文件夹不存在、不是文件夹或读不了。
    #[error("{reason}")]
    ClaimFolderInvalid { path: PathBuf, reason: String },
    /// 新实例的名字不可用。
    #[error("实例名 {name} 不可用：{}", rule.message())]
    InstanceNameInvalid {
        name: String,
        rule: petalfall_instance::NameViolation,
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
    /// 要改的服务器不在固定列表里。
    #[error("服务器「{address}」没有固定")]
    ServerNotPinned { address: String },
    /// 游戏目录不能用作当前目录。
    #[error("游戏目录 {path} 不能用：{problem}")]
    InvalidGameDirectory {
        path: PathBuf,
        problem: GameDirProblem,
    },
    /// 读不到本机物理内存信息。
    #[error("读不到本机内存信息")]
    MemoryUnavailable,
    /// 手动添加的 Java 路径不能用。`source` 只在识别失败（拉起了 java -version）时有。
    #[error("{}", reason.message(path))]
    JavaPathInvalid {
        path: PathBuf,
        reason: JavaPathProblem,
        #[source]
        source: Option<petalfall_java::Error>,
    },
    /// 手动添加的 Java 缺少运行时文件，多半没装完整；`missing` 相对 Java 根目录、以 `/` 分隔。
    #[error("这个 Java 缺少 {}，可能没装完整：{}", missing.join("、"), path.display())]
    JavaRuntimeIncomplete { path: PathBuf, missing: Vec<String> },
    /// 读写 Windows 图形设置里某个程序的显卡偏好失败。`path` 是那个程序。
    #[error("写入 {path} 的显卡偏好失败")]
    GpuPreferenceWrite {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
    /// 要保存为默认设置的实例，工作目录里一个设置文件都没有（还没进过游戏）。
    #[error("实例 {id} 的游戏目录里还没有 options.txt 或服务器列表，进一次游戏后再保存")]
    TemplateSourceEmpty { id: String },
    /// 玩家选了以离线方式进单人，但这个账户此刻不能这样启动。
    #[error("{account} 不能以离线方式进单人：{}", reason.describe())]
    OfflineFallbackRefused {
        account: String,
        reason: OfflineFallbackRefusal,
    },
    /// 这个实例写不成 Modrinth 整合包。`loader` 只在加载器不受支持时给出它的名字。
    #[error("{}", reason.describe(loader.as_deref()))]
    ModpackExportUnsupported {
        id: String,
        reason: crate::export::ExportBlock,
        loader: Option<String>,
    },
}

/// 不能以离线方式进单人的原因。[`OfflineFallbackRefusal::as_str`] 是给前端分支用的稳定码。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OfflineFallbackRefusal {
    /// 离线账户本来就不经验证，没有什么可降级的。
    OfflineAccount,
    /// 登录已被判定失效：降级只为服务或网络故障兜底，凭据失效应当重新登录。
    ReloginRequired,
    /// 门面没有这个账户最近一次验证失败的记录：启动器重开过，或这次失败已经降级过一次。
    NoRecentFailure,
}

impl OfflineFallbackRefusal {
    /// 稳定的 snake_case 码。
    pub fn as_str(self) -> &'static str {
        match self {
            OfflineFallbackRefusal::OfflineAccount => "offline_account",
            OfflineFallbackRefusal::ReloginRequired => "relogin_required",
            OfflineFallbackRefusal::NoRecentFailure => "no_recent_failure",
        }
    }

    /// 给人看的原因。
    pub fn describe(self) -> &'static str {
        match self {
            OfflineFallbackRefusal::OfflineAccount => "离线账户本来就不经验证",
            OfflineFallbackRefusal::ReloginRequired => "登录已失效，需要重新登录",
            OfflineFallbackRefusal::NoRecentFailure => {
                "没有这个账户最近一次验证失败的记录，先重试一次启动"
            }
        }
    }
}

fn blocked_names(files: &[crate::blocked::BlockedFile]) -> String {
    files
        .iter()
        .map(|file| file.file_name.as_str())
        .collect::<Vec<_>>()
        .join("、")
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

/// 手动添加的 Java 路径不能用的具体原因。[`JavaPathProblem::code`] 是给前端分支用的稳定码。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum JavaPathProblem {
    /// 不是绝对路径。
    NotAbsolute,
    /// 文件名不是 java.exe 或 javaw.exe。
    NotJavaExecutable,
    /// 文件不存在。
    NotFound,
    /// java -version 跑不起来或输出里认不出版本。
    ProbeFailed,
    /// java -version 在限时内没有结束。
    ProbeTimeout,
}

impl JavaPathProblem {
    /// 稳定的 snake_case 码。
    pub fn code(self) -> &'static str {
        match self {
            JavaPathProblem::NotAbsolute => "not_absolute",
            JavaPathProblem::NotJavaExecutable => "not_java_executable",
            JavaPathProblem::NotFound => "not_found",
            JavaPathProblem::ProbeFailed => "probe_failed",
            JavaPathProblem::ProbeTimeout => "probe_timeout",
        }
    }

    /// 提示原文，直接作为界面上的提示正文。
    fn message(self, path: &std::path::Path) -> String {
        let path = path.display();
        match self {
            JavaPathProblem::NotAbsolute => format!("Java 路径须是绝对路径：{path}"),
            JavaPathProblem::NotJavaExecutable => {
                format!("只能添加 java.exe 或 javaw.exe：{path}")
            }
            JavaPathProblem::NotFound => format!("找不到这个文件：{path}"),
            JavaPathProblem::ProbeFailed => format!("识别不出这个 Java：{path}"),
            JavaPathProblem::ProbeTimeout => format!(
                "这个 Java {} 秒内没有给出版本信息，已放弃：{path}",
                petalfall_java::PROBE_TIMEOUT.as_secs()
            ),
        }
    }
}

impl CoreError {
    /// 是否由取消令牌引起。取消可能从下载引擎、安装器或 Java 下载任一层冒上来，
    /// 上层据此把它与真正的失败分开（前端不弹错误、任务记为已取消）。
    pub fn is_cancelled(&self) -> bool {
        match self {
            CoreError::Download(err) => err.is_cancelled(),
            CoreError::Install(petalfall_install::Error::Download(err)) => err.is_cancelled(),
            CoreError::Java(err) => err.is_cancelled(),
            CoreError::Auth(err) => err.is_cancelled(),
            CoreError::Modpack(petalfall_modpack::Error::Cancelled) => true,
            CoreError::Instance(petalfall_instance::Error::Cancelled) => true,
            _ => false,
        }
    }
}

/// 门面层 `Result` 别名，下游用 `#[from] petalfall_core::CoreError` 冒泡。
pub type Result<T> = std::result::Result<T, CoreError>;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cancellation_is_recognised_at_every_layer_it_can_surface_from() {
        assert!(CoreError::Download(petalfall_download::Error::Cancelled).is_cancelled());
        assert!(
            CoreError::Install(petalfall_install::Error::Download(
                petalfall_download::Error::Cancelled
            ))
            .is_cancelled()
        );
        assert!(CoreError::Java(petalfall_java::Error::Cancelled).is_cancelled());
        assert!(CoreError::Auth(petalfall_auth::AuthError::Cancelled).is_cancelled());
        assert!(!CoreError::Auth(petalfall_auth::AuthError::ReloginRequired).is_cancelled());
        assert!(CoreError::Modpack(petalfall_modpack::Error::Cancelled).is_cancelled());
        assert!(CoreError::Instance(petalfall_instance::Error::Cancelled).is_cancelled());
        assert!(
            !CoreError::Instance(petalfall_instance::Error::WorldInUse {
                path: PathBuf::from("saves/w"),
            })
            .is_cancelled()
        );

        assert!(
            !CoreError::OfflineFallbackRefused {
                account: "PetalPlayer".into(),
                reason: OfflineFallbackRefusal::NoRecentFailure,
            }
            .is_cancelled()
        );

        // 真正的失败不能被当成取消。
        assert!(!CoreError::NoJava { major: 17 }.is_cancelled());
        assert!(
            !CoreError::JavaPathInvalid {
                path: PathBuf::from("java.exe"),
                reason: JavaPathProblem::ProbeTimeout,
                source: None,
            }
            .is_cancelled()
        );
        assert!(
            !CoreError::Download(petalfall_download::Error::Status {
                url: "http://x".into(),
                status: 404,
            })
            .is_cancelled()
        );
    }

    /// 手动添加 Java 的提示原文直接显示给用户：每种原因的码与原文都钉住。
    #[test]
    fn java_path_problems_have_stable_codes_and_messages() {
        let path = PathBuf::from(r"D:\Java\jdk-21\bin\java.exe");
        let shown = path.display();
        for (reason, code, message) in [
            (
                JavaPathProblem::NotAbsolute,
                "not_absolute",
                format!("Java 路径须是绝对路径：{shown}"),
            ),
            (
                JavaPathProblem::NotJavaExecutable,
                "not_java_executable",
                format!("只能添加 java.exe 或 javaw.exe：{shown}"),
            ),
            (
                JavaPathProblem::NotFound,
                "not_found",
                format!("找不到这个文件：{shown}"),
            ),
            (
                JavaPathProblem::ProbeFailed,
                "probe_failed",
                format!("识别不出这个 Java：{shown}"),
            ),
            (
                JavaPathProblem::ProbeTimeout,
                "probe_timeout",
                format!("这个 Java 10 秒内没有给出版本信息，已放弃：{shown}"),
            ),
        ] {
            assert_eq!(reason.code(), code);
            let err = CoreError::JavaPathInvalid {
                path: path.clone(),
                reason,
                source: None,
            };
            assert_eq!(err.to_string(), message);
            assert!(std::error::Error::source(&err).is_none());
        }

        let probed = CoreError::JavaPathInvalid {
            path: path.clone(),
            reason: JavaPathProblem::ProbeFailed,
            source: Some(petalfall_java::Error::JavaVersionParse {
                output: "garbage".into(),
            }),
        };
        assert_eq!(
            std::error::Error::source(&probed).map(ToString::to_string),
            Some("无法从 java -version 输出解析版本号：garbage".to_owned())
        );

        let incomplete = CoreError::JavaRuntimeIncomplete {
            path: path.clone(),
            missing: vec!["release".into(), "lib/modules".into()],
        };
        assert_eq!(
            incomplete.to_string(),
            format!("这个 Java 缺少 release、lib/modules，可能没装完整：{shown}")
        );
    }

    #[test]
    fn offline_fallback_refusal_codes_and_message() {
        let all = [
            (OfflineFallbackRefusal::OfflineAccount, "offline_account"),
            (OfflineFallbackRefusal::ReloginRequired, "relogin_required"),
            (OfflineFallbackRefusal::NoRecentFailure, "no_recent_failure"),
        ];
        for (reason, code) in all {
            assert_eq!(reason.as_str(), code);
        }
        let err = CoreError::OfflineFallbackRefused {
            account: "PetalPlayer".into(),
            reason: OfflineFallbackRefusal::ReloginRequired,
        };
        assert_eq!(
            err.to_string(),
            "PetalPlayer 不能以离线方式进单人：登录已失效，需要重新登录"
        );
        assert_eq!(
            CoreError::OfflineFallbackRefused {
                account: "Steve".into(),
                reason: OfflineFallbackRefusal::OfflineAccount,
            }
            .to_string(),
            "Steve 不能以离线方式进单人：离线账户本来就不经验证"
        );
    }
}
