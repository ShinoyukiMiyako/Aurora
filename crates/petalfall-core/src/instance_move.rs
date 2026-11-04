//! 把实例移到另一个游戏目录。
//!
//! 实例的位置由名字决定（`<游戏目录>/versions/<id>`），所以「移到别处」只有一种意思：换一个游戏目录。实例目录里的
//! 东西（设置、卷宗、日志、崩溃记录、回滚历史）整体带走；不在里面的三类要迁：游玩记录（全局文件里按游戏目录
//! 分账）、存档备份（`<游戏目录>/.petalfall/backups/instances/<id>`）与配置里的引用。共用的库、资源与继承链上的
//! 基底版本按游戏目录各一份，目标缺的从原目录补过去：Forge 处理器生成的文件下载不回来，不补就启动不了。
//!
//! 这里先放预检、执行与收尾三方共用的数据类型。

use std::fmt;
use std::path::PathBuf;

/// 拦着一次移动的问题。预检把它们全列出来给界面；执行前重新预检，遇到的第一个报
/// [`CoreError::InstanceMoveBlocked`](crate::CoreError::InstanceMoveBlocked)。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MoveBlocker {
    /// 目标就是实例现在所在的游戏目录。
    SameDirectory,
    /// 目标游戏目录在实例目录里面。
    TargetInsideSource,
    /// 目标里已有同名（不分大小写）的版本目录，含隐藏的依赖版本目录。
    NameTaken,
    /// 别的实例经 `inheritsFrom` 依赖它。
    HasDependents(Vec<String>),
    /// 实例目录或它的备份目录里有符号链接、目录联接（相对实例目录或备份目录的路径）。复制会把链接指向的
    /// 内容复制一份，删原件时又可能顺着链接删到别处。
    Links(Vec<PathBuf>),
    /// 目标里已有同名、内容不同的基底版本。
    BaseConflict(Vec<String>),
    /// 目标盘空间不够：这次要写的字节加上余量，与目标盘剩余的字节。
    InsufficientSpace { needed: u64, available: u64 },
    /// 这个实例有一次中断的移动还没收尾（当时有目录访问不到），收尾前不能再移。
    Pending,
}

impl fmt::Display for MoveBlocker {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            MoveBlocker::SameDirectory => f.write_str("目标就是它现在所在的游戏目录"),
            MoveBlocker::TargetInsideSource => f.write_str("目标游戏目录在实例目录里面"),
            MoveBlocker::NameTaken => f.write_str("目标游戏目录里已有同名的版本"),
            MoveBlocker::HasDependents(ids) => {
                write!(f, "有实例依赖它：{}", ids.join("、"))
            }
            MoveBlocker::Links(paths) => {
                let listed: Vec<String> = paths.iter().map(|p| p.display().to_string()).collect();
                write!(f, "里面有链接：{}", listed.join("、"))
            }
            MoveBlocker::BaseConflict(ids) => {
                write!(f, "目标里的同名基底版本内容不同：{}", ids.join("、"))
            }
            MoveBlocker::InsufficientSpace { needed, available } => {
                write!(f, "目标盘空间不够：要 {needed} 字节，剩 {available} 字节")
            }
            MoveBlocker::Pending => f.write_str("上一次移动还没收尾"),
        }
    }
}

/// 移动前的预检结果，不写盘。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MovePreview {
    pub id: String,
    /// 实例现在所在的游戏目录。
    pub source_game_dir: PathBuf,
    /// 要移去的游戏目录（可能还不存在，执行时建）。
    pub target_game_dir: PathBuf,
    /// 两个游戏目录在同一个卷上：实例目录与备份直接改名过去，不复制。
    pub same_volume: bool,
    /// 实例目录的字节与文件数。
    pub instance_bytes: u64,
    pub instance_files: u64,
    /// 随实例带走的备份（`instances/<id>`）的字节与份数。
    pub backup_bytes: u64,
    pub backup_count: u32,
    /// 要补到目标的共用文件（库、资源、日志配置、处理器产物）的个数与字节，不含基底版本。
    pub dependency_files: u64,
    pub dependency_bytes: u64,
    /// 目标里没有、要带过去的基底版本，由近及远。
    pub bases_to_copy: Vec<String>,
    /// 目标里已有、内容相同直接用的基底版本。
    pub reused_bases: Vec<String>,
    /// 原目录里也缺的共用文件数；下次启动时由补全下载。
    pub missing_in_source: u64,
    /// 这次要写进目标盘的字节（不含余量）。
    pub required_bytes: u64,
    /// 目标盘剩余的字节。
    pub available_bytes: u64,
    /// 是否隔离。不隔离时存档、Mod 与游戏设置在原游戏目录根下和别的实例共用，不跟着走。
    pub isolated: bool,
    /// 拦着这次移动的问题；为空才能移。
    pub blockers: Vec<MoveBlocker>,
}

/// 一次移动的请求。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MoveRequest {
    pub id: String,
    pub target_game_dir: PathBuf,
}

/// 移动已经完成，但没跟过去、要提示玩家的一项。带的字符串是人类可读的原因。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MoveFollowUp {
    /// 游玩记录没挪过去：已记下待补，之后读写游玩记录时补上。
    PlayRecords(String),
    /// 备份没挪过去，留在原游戏目录。
    WorldBackups(String),
    /// 原游戏目录里的旧文件没删干净（路径），下次启动时再清。
    Cleanup { path: PathBuf, reason: String },
}

/// 一次完成的移动。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MoveOutcome {
    pub id: String,
    pub source_game_dir: PathBuf,
    pub target_game_dir: PathBuf,
    /// 为空即全部跟过去了。
    pub follow_ups: Vec<MoveFollowUp>,
}

/// 启动时收尾一份中断的移动的结论。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MoveRecovery {
    /// 提交前就中断了：暂存已删，实例还在原游戏目录。
    RolledBack {
        id: String,
        source_game_dir: PathBuf,
        target_game_dir: PathBuf,
    },
    /// 提交已经完成：补做了记录迁移与清理。调用方据此去掉原游戏目录在配置里对它的引用。
    Completed(MoveOutcome),
    /// 有目录访问不到，日志留着，下次启动再试。
    Deferred { id: String, reason: String },
}
