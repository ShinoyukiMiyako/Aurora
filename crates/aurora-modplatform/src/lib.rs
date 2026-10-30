//! aurora-modplatform（L2 Mod 平台客户端与聚合）
//!
//! 在 [`aurora_base`] 的 HTTP 工厂、退避重试、流式哈希与 [`aurora_download`] 的下载任务模型之上，
//! 构建 Modrinth / CurseForge 双平台客户端与本地模组管理：
//!
//! - [`modrinth`]：Modrinth v2 客户端——搜索（facets 过滤）、工程详情、版本列表、依赖、按哈希查版本/更新。
//! - [`curseforge`]：CurseForge v1 客户端——搜索、详情、文件、指纹匹配、下载直链；强制 API key 注入，
//!   缺失时明确禁用（[`Error::CurseForgeKeyMissing`]）而非静默降级。
//! - [`aggregate`]：双源并行聚合搜索，统一 [`SearchHit`] 模型，按 slug 去重（优先 Modrinth）、下载量排序，
//!   单平台失败不影响另一平台结果。
//! - [`local`]：`mods/` 目录扫描、四格式（fabric.mod.json / quilt.mod.json / mods.toml /
//!   neoforge.mods.toml）元数据解析、`.disabled` 后缀启禁切换。
//! - [`hash`]：Modrinth SHA-1 与 CurseForge MurmurHash2 指纹双通道，供已装模组的联网匹配与更新检测。
//! - [`version`]：跨平台统一版本模型 [`ModVersionInfo`]——两个平台形状迥异的版本/文件对象归一到
//!   同一份视图，兼容判定、依赖解析、更新检查都只面向它。
//!
//! 所有访问远端的客户端都支持注入 `base_url`，单元测试走本地 mock。错误统一归口到 [`Error`]，
//! 可重试性由 [`aurora_base::retry::RetryableError`] 分级。整合包安装本轮不做。

pub mod aggregate;
pub mod curseforge;
pub mod error;
pub mod hash;
pub mod local;
pub mod model;
pub mod modrinth;
pub mod version;

mod net;

pub use error::{Error, Result};

pub use model::{
    DependencyKind, ModLoader, Platform, ResourceType, SearchHit, SearchQuery, SortField,
};

pub use version::{ModDependency, ModVersionInfo, ReleaseChannel, parse_loader_name};

pub use aggregate::{AggregateResult, PlatformError, aggregate_search};

pub use modrinth::{
    MODRINTH_BASE, ModrinthClient, ModrinthDependency, ModrinthFile, ModrinthHashes, ModrinthHit,
    ModrinthProject, ModrinthSearchResponse, ModrinthVersion,
};

pub use curseforge::{
    API_KEY_ENV, CURSEFORGE_BASE, CurseForgeClient, CurseForgeFile, CurseForgeFileDependency,
    CurseForgeFileHash, CurseForgeFingerprintMatch, CurseForgeMod, CurseForgeSearchResponse,
    MINECRAFT_GAME_ID, normalize_curseforge_game_versions,
};

pub use local::{
    InstalledMod, MetadataFormat, ModMetadata, disable_mod, enable_mod, is_disabled,
    parse_mod_metadata, scan_mods_dir, set_mod_enabled,
};

pub use hash::{ModHashes, curseforge_fingerprint, hash_mod_file, murmur2};

// 下游可直接从本 crate 取下载任务类型，无需再显式依赖 aurora-download。
pub use aurora_download::DownloadTask;
