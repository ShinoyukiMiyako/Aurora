//! aurora-core（L4 门面）
//!
//! 组合下层各 crate，向 iced 前端与 CLI 暴露一套粗粒度异步 API：版本清单/发现、版本安装（原版 +
//! Fabric/Quilt）、微软/离线账户、离线启动、资源聚合搜索，并持有全局配置（config.json）与统一的
//! 进度/事件通道。目标是让上层只依赖本 crate 即可完成端到端流程。
//!
//! 结构：
//! - [`config`]：全局配置与下载源三档策略。
//! - [`error`]：门面统一错误 [`CoreError`]，各下层错误 `#[from]` 冒泡。
//! - [`event`]：进度/事件模型（[`CoreEvent`] / [`EventSink`] / [`DownloadProgress`]）。
//! - [`facade`]：门面结构 [`Aurora`] 与共享装配；各操作分散在 `versions`/`install`/`auth`/`launch`/`search`。
//!
//! ```no_run
//! # async fn demo() -> aurora_core::Result<()> {
//! use aurora_core::Aurora;
//! let aurora = Aurora::load().await?;
//! let manifest = aurora.list_manifest().await?;
//! println!("最新正式版：{}", manifest.latest.release);
//! # Ok(())
//! # }
//! ```

pub mod appearance;
pub mod auth;
pub mod compat;
pub mod config;
pub mod deps;
pub mod error;
pub mod event;
pub mod facade;
pub mod history;
pub mod install;
pub mod java;
pub mod launch;
pub mod ledger;
mod modfs;
pub mod mods;
pub mod modversions;
pub mod search;
pub mod updates;
pub mod versions;

// ---- 门面自身的公开类型 ----
pub use appearance::{AccentColor, Appearance, AppearanceMode, AppearancePatch};
pub use compat::{Compatibility, InstalledCopy, InstanceMatch, MatchState};
pub use config::{AuroraConfig, ConfigStore, DownloadSourcePolicy, MemorySettings};
pub use deps::{InstallPlan, PlannedItem};
pub use error::{CoreError, Result};
pub use event::{CoreEvent, DownloadProgress, EventSink};
pub use facade::Aurora;
pub use history::{History, HistoryEvent, HistoryStore, RollbackCheck};
pub use install::{InstallOutcome, LoaderChoice};
pub use launch::LaunchOptions;
pub use ledger::{Ledger, LedgerEntry, LedgerStore};
pub use modfs::is_mod_file_busy;
pub use mods::{InstanceMod, ModInstallOutcome, ModSource};
pub use modversions::ProjectInfo;
pub use updates::UpdateCandidate;

pub use auth::{MSA_CLIENT_ID_ENV, perform_microsoft_login};

// ---- 透传下层类型，让上层只依赖本 crate ----
pub use aurora_auth::{Account, AccountType, DeviceCodeResponse, GameProfile};
pub use aurora_install::{LoaderSummary, VanillaSummary};
pub use aurora_instance::{
    BrokenReason, BrokenVersion, DiscoveredVersion, IsolationPolicy, VersionScan,
};
pub use aurora_java::{DetectSource, InstalledRuntime, JavaInstallation, JavaVersion};
pub use aurora_launch::{
    CrashCategory, CrashDiagnosis, ExitReport, GameSession, LogLine, LogStream, analyze,
    detect_crash,
};
pub use aurora_modplatform::{
    AggregateResult, DependencyKind, InstalledMod, MetadataFormat, ModDependency, ModLoader,
    ModMetadata, ModVersionInfo, Platform, PlatformError, ReleaseChannel, ResourceType, SearchHit,
    SearchQuery, SortField,
};
pub use aurora_version::{LoaderInfo, LoaderKind, ManifestVersion, VersionManifest};

// 微软登录端点表（集成测试经 [`Aurora::with_msa_endpoints`] 注入本地 mock）与取消令牌
// （长任务快照经 [`Aurora::with_cancel`] 挂上，命令层用同一类型登记与触发取消）。
pub use aurora_auth::MsaEndpoints;
pub use aurora_download::CancellationToken;

// 各下层 crate 的错误类型：上层（命令边界）要把每一种都映射成稳定的错误码，故全部透传。
pub use aurora_auth::AuthError;
pub use aurora_base::Error as BaseError;
pub use aurora_download::Error as DownloadError;
pub use aurora_install::Error as InstallError;
pub use aurora_instance::Error as InstanceError;
pub use aurora_java::Error as JavaError;
pub use aurora_launch::LaunchError;
pub use aurora_modplatform::Error as ModPlatformError;
pub use aurora_version::Error as VersionError;
