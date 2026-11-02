//! 本 crate 的错误枚举。
//!
//! 启动链路只在少数几处真正产生错误：classpath 组装时坐标非法、版本缺主类、账户无可用令牌、
//! 子进程 spawn/等待失败，以及委派给 [`petalfall_instance`] 的隔离解析冒泡上来的 IO 错误。其余全部
//! 是纯拼装逻辑（不失败）。错误自然向上冒泡，兜底展示归 CLI/前端层。

use std::path::PathBuf;

use crate::quickplay::QuickPlayMode;

/// 启动链路错误。
#[derive(Debug, thiserror::Error)]
pub enum LaunchError {
    /// 库坐标无法解析为 maven 路径，无法定位其 classpath 条目。
    #[error("库坐标非法，无法定位 classpath 条目：{name}")]
    InvalidLibraryCoordinate {
        /// 出问题的库 name（原始 maven 坐标）。
        name: String,
    },

    /// 版本 JSON 给出的库路径、坐标里的某一段或日志配置名不能安全地拼进游戏目录。启动前的补全按同一判据
    /// 已经拒过一次，这里不悄悄丢段或照拼，免得 classpath 与日志参数指到另一个文件。
    #[error("{entry}：路径「{path}」会落到游戏目录之外，无法用来启动")]
    UnsafePath {
        entry: String,
        path: String,
        #[source]
        problem: petalfall_version::UnsafePath,
    },

    /// 版本 JSON 缺少 mainClass，无从确定启动入口。
    #[error("版本 {version} 缺少主类（mainClass），无法确定启动入口")]
    MissingMainClass {
        /// 版本 id。
        version: String,
    },

    /// 账户缺少可用的 Minecraft 访问令牌（微软账户令牌未缓存或已过期）。
    #[error("账户 {name} 缺少可用的 Minecraft 访问令牌，请先完成登录或刷新")]
    MissingAccessToken {
        /// 账户名。
        name: String,
    },

    /// 启动子进程失败。
    #[error("启动游戏进程失败：{program}")]
    Spawn {
        /// 尝试执行的程序（java 可执行文件）路径。
        program: PathBuf,
        /// 底层 IO 错误。
        #[source]
        source: std::io::Error,
    },

    /// 等待游戏进程结束失败。
    #[error("等待游戏进程结束失败")]
    Wait(#[source] std::io::Error),

    /// 结束游戏进程失败（进程仍在运行）。
    #[error("无法结束游戏进程")]
    Kill(#[source] std::io::Error),

    /// 读取游戏输出或写会话日志的后台任务异常结束，属于程序缺陷。
    #[error("游戏会话的后台任务异常结束")]
    Join(#[source] tokio::task::JoinError),

    /// 会话日志读写失败。
    #[error("读写会话日志 {path} 失败")]
    Io {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },

    /// 会话日志不是本启动器写出的格式（头部不对，或第 `line` 行无法解析；`line` 为 0 指头部）。
    #[error("会话日志 {path} 第 {line} 行格式不对")]
    LogFormat { path: PathBuf, line: u64 },

    /// 系统时钟早于 1970 年：时间戳无从谈起。
    #[error("系统时钟早于 1970 年，请校正系统时间")]
    ClockBeforeEpoch,

    /// 要求直达存档或服务器，但这个版本的启动参数里没有对应的入口。
    #[error("版本 {version} 不支持直接{}", .mode.unsupported_action())]
    QuickPlayUnsupported {
        /// 版本 id。
        version: String,
        mode: QuickPlayMode,
    },

    /// 隔离解析（探盘 mods/saves）冒泡上来的实例层错误。
    #[error(transparent)]
    Instance(#[from] petalfall_instance::Error),
}

/// 本 crate 的结果别名。
pub type Result<T> = std::result::Result<T, LaunchError>;
