//! aurora-install（L2 游戏本体与 Mod 加载器安装）
//!
//! 把「选定版本」变成「本地就绪」。在 aurora-version 的域模型与 aurora-download 的并发下载引擎之上，
//! 编排四条安装链路，并统一收口于完整性补全：
//!
//! - 原版（[`VanillaInstaller`]）：版本 JSON + client.jar + 按 rules 过滤的库 + assetIndex 与资源全量
//!   补全 + natives 解压（含 classifier 选择与 exclude 规则）。
//! - Fabric / Quilt（[`LoaderInstaller`]）：meta 服务合成版本 JSON 落盘 + 加载器库下载，无需本地安装器。
//! - Forge / NeoForge（[`ForgeInstaller`]）：解析 installer 的 `install_profile.json`，塌缩 data 占位符表，
//!   按语义替换后逐个执行 processors（java 子进程），并校验产物 sha1；legacy 版本走 versionInfo 落盘 +
//!   通用 jar 解出的旁路。
//! - 按实例名安装（[`instance`]）：原版与加载器 JSON 合并成一份自洽 JSON 落进实例目录；Forge / NeoForge
//!   的可用版本由 [`forge_versions`] 从 Maven 元数据推出。
//! - 完整性补全（[`ensure_complete`]）：任何版本启动前的缺失检查与补全入口，借下载引擎的幂等语义
//!   「缺什么补什么、已就绪零成本略过」。
//!
//! 下载任务的构造（[`plan`]）、maven 路径（[`maven`]）、目录布局（[`layout`]）、占位符替换等均为纯函数，
//! 表驱动单测覆盖；网络逻辑一律支持注入 base_url，用本地 mock 验证。所有错误归口到 [`Error`]，
//! 下游 `#[from] aurora_install::Error` 一处冒泡。

pub mod complete;
pub mod context;
pub mod error;
pub mod fabric;
pub mod forge;
pub mod forge_versions;
pub mod instance;
pub mod layout;
pub mod maven;
pub mod natives;
pub mod plan;
pub mod vanilla;

mod dir_lock;
mod net;

pub use complete::{CompletionReport, ensure_complete};
pub use context::InstallContext;
pub use error::{Error, Result};
pub use fabric::{
    GameVersionEntry, LoaderFlavor, LoaderInstaller, LoaderSummary, LoaderVersion, is_prerelease,
};
pub use forge::{ForgeInstaller, ForgeSummary, forge_installer_url, neoforge_installer_url};
pub use forge_versions::{
    FORGE_MAVEN_METADATA, LoaderBuild, NEOFORGE_LEGACY_MAVEN_METADATA, NEOFORGE_MAVEN_METADATA,
    builds_for, compare_versions, fetch_maven_versions, forge_builds, neoforge_builds,
    neoforge_mc_version, parse_maven_versions,
};
pub use instance::{merge_for_instance, write_instance_json};
pub use layout::{ASSET_OBJECTS_BASE, GameLayout};
pub use vanilla::{VERSION_MANIFEST_V2, VanillaInstaller, VanillaSummary};
