//! aurora-instance（L2 实例管理）
//!
//! 把「一台机器上散落的多个 `.minecraft`」抽象成可管理的实例集合，向上层（aurora-launch / aurora-core）
//! 提供：游戏目录发现、已安装版本发现、版本级设置持久化、以及版本隔离（PathIndie）判定。本 crate 只碰
//! 本地文件系统，不发网络请求；版本 JSON 的域模型与加载器探测复用 [`aurora_version`]。
//!
//! 模块划分：
//! - [`folder`]：多游戏目录扫描、「名称 > 路径」自定义列表、失效清理、无可用时自动创建。
//! - [`discovery`]：`versions/` 扫描与版本发现（含加载器探测与出错版本单列）。
//! - [`cache`]：版本列表哈希缓存与增量刷新（名单未变则免全量重解析）。
//! - [`settings`]：版本级设置（描述 / 图标 / 收藏 / 分类 / 隔离覆盖）持久化。
//! - [`profiles`]：`launcher_profiles.json` 兼容生成。
//! - [`isolation`]：版本隔离档位、版本级覆盖、已有 mods/saves 强制隔离与工作目录产出。
//!
//! 错误统一归口到 [`Error`]，下游 `#[from]` 冒泡。

pub mod cache;
pub mod discovery;
pub mod error;
pub mod folder;
pub mod isolation;
pub mod profiles;
pub mod settings;

pub use error::{Error, Result};

/// `.minecraft` 目录名。
pub const MINECRAFT_DIR_NAME: &str = ".minecraft";
/// 版本目录名（游戏目录下存放各版本的子目录）。
pub const VERSIONS_DIR: &str = "versions";
/// 启动器在游戏/版本目录内落自身元数据（版本列表缓存、版本设置）的子目录名，形如 `.petalfall`。
/// 常量名里的 aurora 是内部代号，取值跟随产品 slug。
pub const AURORA_META_DIR: &str = concat!(".", aurora_base::app_slug!());

pub use folder::{
    CustomDirectory, FolderScanner, GameDirectory, GameDirectorySource, current_minecraft_dir,
    official_minecraft_dir,
};

pub use discovery::{BrokenReason, BrokenVersion, DiscoveredVersion, VersionScan, discover_versions};

pub use cache::{
    VersionCacheStore, VersionListCache, build_cache, hash_version_ids, list_version_ids,
    needs_full_reload,
};

pub use settings::{VersionSettings, VersionSettingsStore};

pub use profiles::{
    LauncherProfile, LauncherProfiles, LauncherSettings, ensure_launcher_profiles,
    generate_client_token,
};

pub use isolation::{
    IsolationFacts, IsolationOverride, IsolationPolicy, ResolvedIsolation, game_working_dir,
    has_existing_mods_or_saves, is_isolated, resolve_isolation,
};
