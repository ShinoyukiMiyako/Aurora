//! aurora-core（L4 门面）
//!
//! 组合下层各 crate，向 Tauri 外壳与 CLI 暴露一套粗粒度异步 API：版本清单/发现、版本安装（原版 +
//! Fabric/Quilt）、微软/离线账户、离线启动、资源聚合搜索，并持有全局配置（config.json）与统一的
//! 进度/事件通道。目标是让上层只依赖本 crate 即可完成端到端流程。
//!
//! 结构：
//! - [`config`]：全局配置与下载源三档策略。
//! - [`error`]：门面统一错误 [`CoreError`]，各下层错误 `#[from]` 冒泡。
//! - [`event`]：进度/事件模型（[`CoreEvent`] / [`EventSink`] / [`DownloadProgress`]）。
//! - [`facade`]：门面结构 [`Aurora`] 与共享装配；各操作分散在 `versions`/`install`/`auth`/`launch`/`search`。
//! - 系统设置相关：[`folders`]（游戏目录并存与首次启动）、[`memory`]（内存建议）、[`servers`]（固定服务器与
//!   状态查询）、[`network`]（连通性探测）、[`news`]（官方资讯与启动器资讯）、[`updates`]（启动器更新端点排序）、[`java`]（Java 取用与运行时下载）。
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
pub mod art;
pub mod auth;
mod authlib;
pub mod compat;
pub mod config;
pub mod crashdiag;
pub mod deps;
pub mod error;
pub mod event;
pub mod facade;
pub mod folders;
pub mod history;
pub mod install;
pub mod instance_install;
pub mod instances;
pub mod java;
pub mod launch;
pub mod launcher_update;
pub mod ledger;
pub mod loaders;
pub mod memory;
mod modfs;
pub mod modpack;
pub mod modpack_summary;
pub mod mods;
pub mod modversions;
pub mod network;
pub mod news;
pub mod playtime;
pub mod resources;
pub mod search;
pub mod servers;
pub mod session;
pub mod updates;
pub mod versions;
mod workdir;
pub mod world_backup;

// ---- 门面自身的公开类型 ----
pub use appearance::{AccentColor, Appearance, AppearanceMode, AppearancePatch};
pub use compat::{
    Compatibility, InstalledCopy, InstalledSource, InstanceMatch, InstanceSources, MatchState,
};
pub use config::{
    AfterLaunch, AuroraConfig, ConfigFieldReset, ConfigRecovery, ConfigStore, DownloadSourcePolicy,
    MemorySettings, NamedDirectory, PinnedServer, WorldBackupSettings,
};
pub use crashdiag::{CrashClue, CrashReport, CrashSuspect, LaunchLog};
pub use deps::{InstallPlan, PlannedItem};
pub use error::{CoreError, GameDirProblem, Result};
pub use event::{CoreEvent, DownloadProgress, EventSink};
pub use facade::Aurora;
pub use folders::{GameDirectoryEntry, GameDirectoryInspection};
pub use history::{History, HistoryEvent, HistoryStore, RollbackCheck};
pub use install::{InstallOutcome, LoaderChoice};
pub use launch::{
    FailureCode, InstanceLaunchSettings, JavaChoice, LaunchAccount, LaunchEvent, LaunchEventSink,
    LaunchFailed, LaunchFailure, LaunchPhase, LaunchRequest, LaunchStage, LaunchWarning, QuickPlay,
    resolve_memory,
};
pub use launcher_update::{UpdateSource, order_update_sources};
pub use ledger::{Ledger, LedgerEntry, LedgerStore};
pub use modfs::is_mod_file_busy;
pub use modpack::{
    INSTANCE_NAME_MAX_CHARS, InstanceModpack, InstanceNameRule, ModpackInstallOutcome,
    ModpackPreview, ModpackSource, PreparedModpack, read_instance_modpack, validate_instance_name,
};
pub use modpack_summary::ModpackSummary;
pub use mods::{InstanceMod, ModInstallOutcome, ModSource};
pub use modversions::ProjectInfo;
pub use news::{LauncherChannel, NewsFeed, NewsItem, NewsTag};
pub use playtime::{InstanceMinutes, PlayDay, PlayRange, PlayStats, PlaySummary};
pub use resources::{ResourceInstallOutcome, ResourceTarget};
pub use servers::{KnownServer, ServerMonitor, ServerStatus};
pub use session::{
    Finished, GameExit, GameRun, GameSlot, JavaUsed, SlotBusy, SlotReservation, SlotTicket,
};
pub use updates::UpdateCandidate;
pub use world_backup::{
    AutoBackupOutcome, BackupOutcome, ExportOutcome, RestoreOutcome, WorldBackup, WorldBackupList,
};

pub use auth::{MSA_CLIENT_ID_ENV, perform_microsoft_login};

pub use art::{
    ArtStatus, DefaultSkin, SkinInfo, TexResponse, TextureService, ThumbError, default_skin,
};
pub use auth::{AuthServerInfo, AuthlibLogin, AuthlibPending};

// ---- 透传下层类型，让上层只依赖本 crate ----
pub use aurora_auth::{Account, AccountType, DeviceCodeResponse, GameProfile};
pub use aurora_auth::{
    AccountCredentials, AccountStatus, MicrosoftCredentials, SkinModel, SkinRef,
    YggdrasilCredentials,
};
pub use aurora_install::{LoaderSummary, VanillaSummary};
pub use aurora_instance::{
    BackupKind, BrokenReason, BrokenVersion, DiscoveredVersion, IsolationPolicy, VersionScan,
    WorldScope,
};
pub use aurora_java::{DetectSource, InstalledRuntime, JavaInstallation, JavaVersion};
pub use aurora_launch::{
    CrashCategory, CrashDiagnosis, ExitReport, KillSwitch, LauncherLevel, LogBatchSink, LogEntry,
    LogLine, LogSource, LogStream, MemoryAdvice, MemoryTier, QuickPlayMode, QuickPlaySupport,
    QuickPlayTarget, SessionEnded, SessionOutcome, SystemMemory, analyze, detect_crash,
    game_line_level, probe_system_memory,
};
pub use aurora_modplatform::{
    AggregateResult, DependencyKind, InstalledMod, MetadataFormat, ModDependency, ModLoader,
    ModMetadata, ModVersionInfo, Platform, PlatformError, ReleaseChannel, ResourceType, SearchHit,
    SearchQuery, SortField,
};
// 发现页：聚合搜索的合并结果与翻页游标、工程详情。
pub use aurora_modplatform::{
    BodyFormat, DependencyProject, HitSource, PlatformCursor, ProjectDetail, SearchCursor,
    SearchEntry, SkipReason, SkippedPlatform,
};
pub use aurora_version::{LoaderInfo, LoaderKind, ManifestVersion, VersionManifest};

// 微软登录端点表（集成测试经 [`Aurora::with_msa_endpoints`] 注入本地 mock）与取消令牌
// （长任务快照经 [`Aurora::with_cancel`] 挂上，命令层用同一类型登记与触发取消）。
pub use aurora_auth::MsaEndpoints;
pub use aurora_download::CancellationToken;

// 实例管理：列表、设置、内容、删除、改名、侧栏固定；按实例名新建与补全；加载器版本与版本清单概览。
pub use aurora_instance::{
    Disposer, GameMode, IncompleteKind, IncompleteMarker, IncompleteOutcome, InstallSpec,
    InstanceContent, IsolationOverride, JavaSelection, LevelInfo, LevelSummary, MarkerError,
    MarkerStore, NameViolation, PackEntry, PinsViolation, RecycleBin, Resolution,
    ResolvedIsolation, ResourcePackEntry, SettingsViolation, ShaderPackEntry, VersionSettings,
    WorldEntry, is_safe_instance_id,
};
pub use instance_install::{
    InstalledLoader, InstanceInstallOutcome, InstanceRequest, MarkerSettlement, RepairOutcome,
    RepairPlan,
};
pub use instances::{
    DeletionPreview, InstanceSummary, InstanceVersion, LEGACY_JAVA_MAJOR, MAX_SIDEBAR_PINS,
    Readable, ReadyVersion, broken_reason_text,
};
pub use loaders::{LoaderEndpoints, LoaderVersionInfo, ManifestOverview, VersionRequirements};

// 各下层 crate 的错误类型：上层（命令边界）要把每一种都映射成稳定的错误码，故全部透传。
pub use aurora_auth::AuthError;
pub use aurora_base::Error as BaseError;
pub use aurora_download::Error as DownloadError;
pub use aurora_install::Error as InstallError;
pub use aurora_instance::Error as InstanceError;
pub use aurora_java::Error as JavaError;
pub use aurora_launch::LaunchError;
pub use aurora_modpack::Error as ModpackError;
pub use aurora_modpack::{PackFormat, PackLoader, PackLoaderKind, PathValidationError};
pub use aurora_modplatform::Error as ModPlatformError;
pub use aurora_version::Error as VersionError;
