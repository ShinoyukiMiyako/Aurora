//! aurora-instance（L2 实例管理）
//!
//! 一个实例就是游戏目录 `versions/` 下的一个版本目录，目录名即实例 id。本 crate 向上层（aurora-launch /
//! aurora-core）提供：已安装版本发现、实例命名规则、实例设置与未完成标记的持久化、版本隔离判定、
//! 存档与资源包的读取、移入回收站。只碰本地文件系统，不发网络请求；版本 JSON 的域模型与加载器探测
//! 复用 [`aurora_version`]。
//!
//! 模块划分：
//! - [`folder`]：官方启动器的游戏目录位置。
//! - [`discovery`]：`versions/` 扫描与单版本读取（含加载器探测、出错版本单列与解析缓存）。
//! - [`naming`]：实例名称规则与实例 id 的路径安全检查。
//! - [`settings`]：实例设置（介绍 / 封面 / 隔离覆盖 / 内存 / Java / JVM 参数 / 窗口）持久化。
//! - [`marker`]：安装与修复的未完成标记。
//! - [`isolation`]：版本隔离档位、版本级覆盖、已有 mods/saves 强制隔离与工作目录产出。
//! - [`content`]：存档、资源包、光影包、Mod 文件计数与目录体积。
//! - [`level`]：`level.dat` 的最小 NBT 读取。
//! - [`trash`]：移入回收站。
//!
//! 错误统一归口到 [`Error`]，下游 `#[from]` 冒泡。

pub mod content;
pub mod discovery;
pub mod error;
pub mod folder;
pub mod isolation;
pub mod level;
pub mod marker;
pub mod naming;
pub mod settings;
pub mod trash;

pub use error::{Error, PinsViolation, Result};

/// `.minecraft` 目录名。
pub const MINECRAFT_DIR_NAME: &str = ".minecraft";
/// 版本目录名（游戏目录下存放各版本的子目录）。
pub const VERSIONS_DIR: &str = "versions";
/// 启动器在游戏/版本目录内落自身元数据（版本设置等）的子目录名，形如 `.petalfall`。
/// 常量名里的 aurora 是内部代号，取值跟随产品 slug。
pub const AURORA_META_DIR: &str = concat!(".", aurora_base::app_slug!());

pub use folder::official_minecraft_dir;

pub use discovery::{
    BrokenReason, BrokenVersion, DiscoveredVersion, VersionProbe, VersionScan, discover_version,
    discover_versions, list_version_dirs, probe_version,
};

pub use naming::{
    ILLEGAL_NAME_CHARS, MAX_NAME_UNITS, NameViolation, check_instance_name, check_name_format,
    is_safe_instance_id,
};

pub use settings::{
    JavaSelection, Resolution, SettingsViolation, VersionSettings, VersionSettingsStore,
};

pub use marker::{
    IncompleteKind, IncompleteMarker, IncompleteOutcome, InstallSpec, MarkerError, MarkerStore,
};

pub use isolation::{
    IsolationFacts, IsolationOverride, IsolationPolicy, ResolvedIsolation, game_working_dir,
    has_existing_mods_or_saves, is_isolated, resolve_isolation,
};

pub use content::{
    InstanceContent, LevelInfo, PackEntry, ResourcePackEntry, ShaderPackEntry, WorldEntry,
    count_mod_files, dir_footprint, list_worlds, read_instance_content,
};

pub use level::{GameMode, LevelSummary};

pub use trash::{Disposer, RecycleBin};
