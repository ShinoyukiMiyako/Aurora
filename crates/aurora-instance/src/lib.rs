//! aurora-instance（L2 实例管理）
//!
//! 一个实例就是游戏目录 `versions/` 下的一个版本目录，目录名即实例 id。本 crate 向上层（aurora-launch /
//! aurora-core）提供：已安装版本发现、版本级设置持久化、版本隔离判定。只碰本地文件系统，不发网络请求；
//! 版本 JSON 的域模型与加载器探测复用 [`aurora_version`]。
//!
//! 模块划分：
//! - [`folder`]：官方启动器的游戏目录位置。
//! - [`discovery`]：`versions/` 扫描与版本发现（含加载器探测与出错版本单列）。
//! - [`settings`]：版本级设置（描述 / 图标 / 收藏 / 分类 / 隔离覆盖）持久化。
//! - [`isolation`]：版本隔离档位、版本级覆盖、已有 mods/saves 强制隔离与工作目录产出。
//!
//! 错误统一归口到 [`Error`]，下游 `#[from]` 冒泡。

pub mod discovery;
pub mod error;
pub mod folder;
pub mod isolation;
pub mod settings;

pub use error::{Error, Result};

/// `.minecraft` 目录名。
pub const MINECRAFT_DIR_NAME: &str = ".minecraft";
/// 版本目录名（游戏目录下存放各版本的子目录）。
pub const VERSIONS_DIR: &str = "versions";
/// 启动器在游戏/版本目录内落自身元数据（版本设置等）的子目录名，形如 `.petalfall`。
/// 常量名里的 aurora 是内部代号，取值跟随产品 slug。
pub const AURORA_META_DIR: &str = concat!(".", aurora_base::app_slug!());

pub use folder::official_minecraft_dir;

pub use discovery::{BrokenReason, BrokenVersion, DiscoveredVersion, VersionScan, discover_versions};

pub use settings::{VersionSettings, VersionSettingsStore};

pub use isolation::{
    IsolationFacts, IsolationOverride, IsolationPolicy, ResolvedIsolation, game_working_dir,
    has_existing_mods_or_saves, is_isolated, resolve_isolation,
};
