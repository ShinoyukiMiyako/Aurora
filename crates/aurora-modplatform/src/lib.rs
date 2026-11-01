//! aurora-modplatform（L2 Mod 平台客户端与聚合）
//!
//! 在 [`aurora_base`] 的 HTTP 工厂、退避重试、流式哈希与 [`aurora_download`] 的下载任务模型之上，
//! 构建 Modrinth / CurseForge 双平台客户端与本地模组管理：
//!
//! - [`modrinth`]：Modrinth v2 客户端——搜索（facets 过滤）、工程详情、单版本与版本列表、依赖、
//!   按哈希批量查版本 / 查更新（可按发布通道过滤）、单版本更新日志。
//! - [`curseforge`]：CurseForge v1 客户端——搜索、详情、文件、文件更新日志、指纹匹配、下载直链；
//!   强制 API key 注入，缺失时明确禁用（[`Error::CurseForgeKeyMissing`]）而非静默降级。
//! - [`aggregate`]：双源并行聚合搜索与翻页游标，同名同作者的工程合成一条（主来源 Modrinth），
//!   单平台失败、未参与的平台分别报告，不影响另一平台结果。
//! - [`category_map`]：Modrinth 分类键到 CurseForge 分类 id 的静态对照。
//! - [`detail`]：工程详情（介绍、图库、最新版本、必需前置）的跨平台统一视图。
//! - [`local`]：`mods/` 目录扫描（有界并发 + 元数据缓存）、四格式（fabric.mod.json / quilt.mod.json /
//!   mods.toml / neoforge.mods.toml）元数据解析、`.disabled` 后缀启禁切换。
//! - [`version`]：跨平台统一版本模型 [`ModVersionInfo`]——两个平台形状迥异的版本/文件对象归一到
//!   同一份视图，兼容判定、依赖解析、更新检查都只面向它。
//! - [`hash`]：Modrinth SHA-1 与 CurseForge MurmurHash2 指纹双通道，供已装模组的联网匹配与更新检测。
//!
//! 所有访问远端的客户端都支持注入 `base_url`，单元测试走本地 mock。错误统一归口到 [`Error`]，
//! 可重试性由 [`aurora_base::retry::RetryableError`] 分级。

pub mod aggregate;
pub mod category_map;
pub mod curseforge;
pub mod detail;
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
    hue_from_rgb,
};

pub use aggregate::{
    AggregateResult, CurseForgeSource, HitSource, PlatformCursor, PlatformError, SearchCursor,
    SearchEntry, SkipReason, SkippedPlatform, aggregate_search, normalize_for_merge, should_merge,
};

pub use detail::{
    BodyFormat, DependencyProject, ProjectDetail, curseforge_detail, modrinth_detail,
};

pub use version::{ModDependency, ModVersionInfo, ReleaseChannel, parse_loader_name};

pub use modrinth::{
    MODRINTH_BASE, ModrinthChangelog, ModrinthClient, ModrinthDependency, ModrinthFile,
    ModrinthGalleryImage, ModrinthHashes, ModrinthHit, ModrinthProject, ModrinthSearchResponse,
    ModrinthTeamMember, ModrinthUser, ModrinthVersion, primary_author,
};

pub use curseforge::{
    API_KEY_ENV, CURSEFORGE_BASE, CurseForgeClient, CurseForgeFile, CurseForgeFileDependency,
    CurseForgeFileHash, CurseForgeFileIndex, CurseForgeFileList, CurseForgeFingerprintMatch,
    CurseForgeMod, CurseForgeSearchPlan, CurseForgeSearchResponse, MINECRAFT_GAME_ID,
    MOD_FILES_MAX_PAGES, MOD_FILES_PAGE_SIZE, normalize_curseforge_game_versions, search_plan,
};

pub use local::{
    DISABLED_SUFFIX, InstalledMod, MetadataFormat, ModMetadata, disable_mod, enable_mod,
    is_disabled, parse_mod_metadata, read_jar_entry, scan_mods_dir, scan_mods_dir_cached,
    set_mod_enabled,
};

pub use hash::{ModHashes, curseforge_fingerprint, hash_mod_file, murmur2};

// 下游可直接从本 crate 取下载任务类型，无需再显式依赖 aurora-download。
pub use aurora_download::DownloadTask;
