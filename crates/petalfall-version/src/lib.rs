//! petalfall-version（L1 版本域模型）
//!
//! 纯解析 crate：只把 Minecraft 版本清单与版本 JSON 建模、求值、合并，不发任何网络请求、不碰文件系统。
//! 版本来源（磁盘扫描）与网络抓取分别由 petalfall-instance / petalfall-download 提供，本 crate 通过
//! [`VersionProvider`] 抽象接住 "按 id 取版本" 的能力。
//!
//! 模块划分：
//! - [`manifest`]：version_manifest_v2 清单模型。
//! - [`model`]：版本 JSON 全模型（新旧两式 arguments、library rules/natives/classifiers、downloads、
//!   assetIndex、javaVersion、logging）与库筛选。
//! - [`rules`]：library / argument 的 rules 求值（os.name / os.version / os.arch / features）。
//! - [`merge`]：inheritsFrom 链式合并与循环检测。
//! - [`loader`]：Fabric/Quilt/Forge/NeoForge/OptiFine/LiteLoader 加载器探测与版本抽取。
//! - [`identify`]：版本号多级回退识别。
//! - [`availability`]：可用性检查。
//! - [`assets`]：资源索引（objects）模型与布局判定。
//! - [`relpath`]：远端给出的相对路径（库路径、坐标各段、资源逻辑名）能否安全拼进游戏目录。
//!
//! 错误统一归口到 [`Error`]，下游可 `#[from]` 冒泡。

pub mod assets;
pub mod availability;
pub mod error;
pub mod identify;
pub mod loader;
pub mod manifest;
pub mod merge;
pub mod model;
pub mod relpath;
pub mod rules;

pub use error::{Error, Result};

pub use assets::{AssetLayout, AssetObject, AssetObjectsIndex};
pub use availability::{UnavailableReason, VersionAvailability, check_availability};
pub use identify::{IdentifySource, McVersion, identify_mc_version};
pub use loader::{LoaderInfo, LoaderKind, detect_loaders};
pub use manifest::{LatestVersions, ManifestVersion, VersionManifest};
pub use merge::{VersionProvider, resolve};
pub use model::{
    Argument, ArgumentValue, Arguments, Artifact, AssetIndex, DownloadEntry, Downloads, Extract,
    JavaVersion, Library, LibraryDownloads, Logging, LoggingConfig, LoggingFile, MavenCoordinate,
    VersionJson, select_libraries,
};
pub use relpath::{UnsafePath, check_path_segment, check_relative_path};
pub use rules::{OsName, OsRule, Rule, RuleAction, RuntimeContext, evaluate_rules};
