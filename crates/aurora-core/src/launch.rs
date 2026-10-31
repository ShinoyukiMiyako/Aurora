//! 启动编排：版本 -> 账户 -> Java -> 文件校验与补全 -> natives -> 启动参数 -> 进程。
//!
//! 一次启动按八个阶段推进（[`LaunchStage`]），每进入一个阶段推一条 [`LaunchEvent::Stage`]，下标单调
//! 递增；阶段 3 期间另推字节进度。内存、Java、JVM 参数、分辨率一律在这里按实例设置与全局设置解析，
//! 调用方只给版本、账户与取消令牌。
//!
//! 失败分两类：玩家能针对性处理的（找不到 Java、文件下载失败、磁盘满……）收敛为带失败码与插值参数的
//! [`LaunchFailure`]；其余照常作为 [`CoreError`] 冒泡。取消始终是 [`CoreError`]，由上层识别。
//!
//! 文件校验只看存在与大小、不算哈希：每次启动给几千个资源文件算 sha1 要几十秒。缺了或大小不对的
//! 才交给下载池，下载池对它们做完整校验。

use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::{Path, PathBuf};

use aurora_auth::{Account, AccountCredentials};
use aurora_download::{BatchReport, DownloadTask};
use aurora_install::GameLayout;
use aurora_instance::{
    DiscoveredVersion, IsolationOverride, JavaSelection, VERSIONS_DIR, VersionSettings,
};
use aurora_java::{DetectSource, JavaInstallation, detect_all, select_for_major};
use aurora_launch::logfile::{SessionOutcome, logs_dir};
use aurora_launch::{
    AuthValues, AuthlibInjector, CommandBuilder, GamePaths, GameSession, LaunchCommand,
    LauncherLevel, LogBatchSink, LogSource, MemoryConfig, SessionClock, SessionLog,
    game_path_warning, required_java_major,
};
use aurora_version::{AssetLayout, AssetObjectsIndex, RuntimeContext, VersionJson, resolve};
use serde::Serialize;
use serde_json::Value;
use tokio::sync::mpsc;

use crate::config::MemorySettings;
use crate::error::CoreError;
use crate::event::{CoreEvent, DownloadProgress, EventSink, emit};
use crate::facade::{Aurora, make_context};
use crate::session::GameRun;
use crate::workdir::{discovered, read_version_json};

/// 启动的八个阶段，判别值即阶段下标。
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum LaunchStage {
    CheckJava = 0,
    VerifyFiles = 1,
    CompleteLibraries = 2,
    DownloadMissing = 3,
    ExtractNatives = 4,
    BuildArguments = 5,
    SpawnProcess = 6,
    Running = 7,
}

impl LaunchStage {
    pub fn index(self) -> u8 {
        self as u8
    }

    /// 阶段所属的会话阶段。
    pub fn phase(self) -> LaunchPhase {
        match self {
            LaunchStage::CheckJava | LaunchStage::VerifyFiles | LaunchStage::CompleteLibraries => {
                LaunchPhase::Preparing
            }
            LaunchStage::DownloadMissing => LaunchPhase::Downloading,
            LaunchStage::ExtractNatives
            | LaunchStage::BuildArguments
            | LaunchStage::SpawnProcess => LaunchPhase::Launching,
            LaunchStage::Running => LaunchPhase::Running,
        }
    }

    /// 写进会话日志的阶段名。
    fn label(self) -> &'static str {
        match self {
            LaunchStage::CheckJava => "检查 Java",
            LaunchStage::VerifyFiles => "校验游戏文件",
            LaunchStage::CompleteLibraries => "补全库文件",
            LaunchStage::DownloadMissing => "下载缺失文件",
            LaunchStage::ExtractNatives => "解压本地库",
            LaunchStage::BuildArguments => "生成启动参数",
            LaunchStage::SpawnProcess => "启动游戏进程",
            LaunchStage::Running => "游戏运行中",
        }
    }
}

/// 加载阶段的分段。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum LaunchPhase {
    Preparing,
    Downloading,
    Launching,
    Running,
}

/// 启动过程中推给上层的事件，按发生顺序送达。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LaunchEvent {
    /// 进入某阶段。
    Stage(LaunchStage),
    /// 阶段 3 的下载进度快照；没有要下载的文件时推一条全零快照，表示这一阶段直接完成。
    Download(DownloadProgress),
    /// 启动器日志行（同时写进会话日志），`at` 是写下它的 Unix 毫秒。
    Log {
        at: u64,
        level: LauncherLevel,
        text: String,
    },
}

/// 启动事件的发送端。
pub type LaunchEventSink = mpsc::UnboundedSender<LaunchEvent>;

/// 不阻断启动、但值得在崩溃诊断里引用的提醒。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LaunchWarning {
    /// 游戏路径含非 ASCII 或 `!`。
    GamePath,
}

/// 用哪个账户启动。
#[derive(Debug, Clone)]
pub enum LaunchAccount {
    /// 临时离线账户：只校验名字，不落库。
    Offline { name: String },
    /// 账户库里的账户（含令牌）。
    Stored(Account),
}

/// 一次启动的输入。
pub struct LaunchRequest {
    pub version_id: String,
    pub account: LaunchAccount,
    /// 写进 `${launcher_version}` 的应用版本号。
    pub launcher_version: String,
    /// 游戏输出的批量转发端；`None` 时只写会话日志。
    pub game_log: Option<LogBatchSink>,
}

/// 玩家能针对性处理的启动失败码。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum FailureCode {
    JavaMissing,
    JavaPinnedMissing,
    JavaTooOld,
    AccountRelogin,
    AccountRefreshNetwork,
    FilesOffline,
    FilesFailed,
    DiskFull,
    VersionBroken,
    SpawnFailed,
}

impl FailureCode {
    pub fn as_str(self) -> &'static str {
        match self {
            FailureCode::JavaMissing => "java_missing",
            FailureCode::JavaPinnedMissing => "java_pinned_missing",
            FailureCode::JavaTooOld => "java_too_old",
            FailureCode::AccountRelogin => "account_relogin",
            FailureCode::AccountRefreshNetwork => "account_refresh_network",
            FailureCode::FilesOffline => "files_offline",
            FailureCode::FilesFailed => "files_failed",
            FailureCode::DiskFull => "disk_full",
            FailureCode::VersionBroken => "version_broken",
            FailureCode::SpawnFailed => "spawn_failed",
        }
    }
}

/// 带失败码与插值参数的启动失败。`message` 是给日志与排查看的完整说明，界面文案由前端按失败码生成。
#[derive(Debug, thiserror::Error)]
#[error("{message}")]
pub struct LaunchFailure {
    pub code: FailureCode,
    pub message: String,
    /// 插值参数（数字或字符串）。
    pub params: BTreeMap<String, Value>,
    /// 底层原因。
    #[source]
    pub source: Option<CoreError>,
}

impl LaunchFailure {
    fn new(code: FailureCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            params: BTreeMap::new(),
            source: None,
        }
    }

    fn param(mut self, key: &str, value: impl Into<Value>) -> Self {
        self.params.insert(key.to_owned(), value.into());
        self
    }

    fn caused_by(mut self, source: impl Into<CoreError>) -> Self {
        self.source = Some(source.into());
        self
    }
}

/// 启动失败：可针对性处理的失败，或其余门面错误（含取消）。可处理的失败装箱：它带着参数表与原因，
/// 直接放在枚举里会让每个返回它的函数都背上一个大号的 `Err`。
#[derive(Debug, thiserror::Error)]
pub enum LaunchFailed {
    #[error(transparent)]
    Failure(Box<LaunchFailure>),
    #[error(transparent)]
    Core(#[from] CoreError),
}

impl From<LaunchFailure> for LaunchFailed {
    fn from(failure: LaunchFailure) -> Self {
        LaunchFailed::Failure(Box::new(failure))
    }
}

impl LaunchFailed {
    pub fn is_cancelled(&self) -> bool {
        matches!(self, LaunchFailed::Core(err) if err.is_cancelled())
    }
}

/// 下层错误先并入门面错误，保证同一种失败无论从哪层来都得到同一个错误码。
macro_rules! via_core_error {
    ($($source:ty),+ $(,)?) => {
        $(
            impl From<$source> for LaunchFailed {
                fn from(err: $source) -> Self {
                    LaunchFailed::Core(CoreError::from(err))
                }
            }
        )+
    };
}

via_core_error!(
    aurora_base::Error,
    aurora_auth::AuthError,
    aurora_download::Error,
    aurora_install::Error,
    aurora_instance::Error,
    aurora_java::Error,
    aurora_launch::LaunchError,
    tokio::task::JoinError,
);

/// 启动所需的实例级覆盖；`None` / 空即跟随全局。
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct InstanceLaunchSettings {
    pub isolation: IsolationOverride,
    pub memory_mb: Option<u32>,
    pub java: JavaChoice,
    pub jvm_args: Vec<String>,
    pub resolution: Option<(u32, u32)>,
    pub fullscreen: bool,
}

/// 实例选用的 Java。
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub enum JavaChoice {
    /// 按版本要求自动挑选，本机没有时按全局设置自动下载。
    #[default]
    Auto,
    /// 固定用某个 java 可执行文件。
    Path(PathBuf),
}

impl InstanceLaunchSettings {
    /// 从版本设置里取出影响启动的部分。逐字段解构：实例设置新增字段时这里编译不过，逼着决定它是否
    /// 影响启动，而不是新字段存了却悄悄不生效。
    pub fn from_settings(settings: VersionSettings) -> Self {
        let VersionSettings {
            description: _,
            cover: _,
            isolation,
            memory_mb,
            java,
            jvm_args,
            resolution,
            fullscreen,
        } = settings;
        Self {
            isolation,
            memory_mb,
            java: match java {
                JavaSelection::Auto => JavaChoice::Auto,
                JavaSelection::Path(path) => JavaChoice::Path(path),
            },
            // 设置里原样保存玩家输入的整行参数，这里按空白切成独立参数交给 JVM。
            jvm_args: jvm_args.split_whitespace().map(str::to_owned).collect(),
            // 全屏时窗口尺寸参数没有意义，不传，免得部分版本先按尺寸开窗再切全屏。
            resolution: (!fullscreen).then_some((resolution.width, resolution.height)),
            fullscreen,
        }
    }
}

/// 解析实际使用的内存：实例单独设置了就用实例的，否则用全局。最小堆超过最大堆时 JVM 拒绝启动，
/// 所以只在不超过最大堆时才带上。逐字段解构全局设置，理由同 [`InstanceLaunchSettings::from_settings`]。
pub fn resolve_memory(instance_mb: Option<u32>, global: MemorySettings) -> MemoryConfig {
    let MemorySettings { max_mb, min_mb } = global;
    let max = instance_mb.unwrap_or(max_mb);
    let config = MemoryConfig::fixed(max);
    match min_mb {
        Some(min) if min <= max => config.with_min(min),
        _ => config,
    }
}

/// 继承链只读目标及其祖先，不扫整个 `versions/`。
struct VersionChain {
    target: DiscoveredVersion,
    merged: VersionJson,
    /// 继承链根（持有客户端 jar 与 natives 的版本）。
    base_id: String,
}

/// 读继承链上的一个版本 JSON，内容非法归为 version_broken。
async fn read_chain_member(
    versions_dir: &Path,
    id: &str,
) -> Result<Option<VersionJson>, LaunchFailed> {
    read_version_json(versions_dir, id)
        .await
        .map_err(|err| match err {
            CoreError::Version(err) => version_broken(format!("版本 {id} 的 JSON 损坏：{err}"))
                .caused_by(err)
                .into(),
            other => other.into(),
        })
}

fn version_broken(reason: impl Into<String>) -> LaunchFailure {
    let reason = reason.into();
    LaunchFailure::new(FailureCode::VersionBroken, reason.clone()).param("reason", reason)
}

async fn read_version_chain(
    game_dir: &Path,
    version_id: &str,
) -> Result<VersionChain, LaunchFailed> {
    let versions_dir = game_dir.join(VERSIONS_DIR);
    let json = read_chain_member(&versions_dir, version_id)
        .await?
        .ok_or_else(|| CoreError::VersionNotInstalled {
            id: version_id.to_owned(),
        })?;

    let mut provider: HashMap<String, VersionJson> = HashMap::new();
    let mut base_id = version_id.to_owned();
    let mut seen = HashSet::from([version_id.to_owned()]);
    let mut next = json.inherits_from.clone();
    while let Some(parent) = next.take() {
        // 环与缺失的前置由 resolve 报出具体原因，这里遇到就停。
        if !seen.insert(parent.clone()) {
            break;
        }
        let Some(parent_json) = read_chain_member(&versions_dir, &parent).await? else {
            break;
        };
        next = parent_json.inherits_from.clone();
        base_id = parent.clone();
        provider.insert(parent, parent_json);
    }
    let merged =
        resolve(&json, &provider).map_err(|err| version_broken(err.to_string()).caused_by(err))?;
    Ok(VersionChain {
        target: discovered(&versions_dir, version_id, json),
        merged,
        base_id,
    })
}

/// 选定的 Java。
enum JavaPlan {
    Ready(JavaInstallation),
    /// 本机没有，阶段 3 下载托管运行时。
    Download {
        major: u32,
    },
}

/// 一次启动里要下载的东西。
#[derive(Default)]
struct DownloadPlan {
    files: Vec<DownloadTask>,
    /// 资源索引本地缺失：下完索引才知道还缺哪些资源对象。
    asset_index_missing: bool,
}

/// 旧版资源布局（virtual / resources）要求把对象按逻辑名展开到另一个目录。
struct LegacyAssets {
    target_dir: PathBuf,
    index: AssetObjectsIndex,
}

/// 启动过程的事件与日志出口。会话日志打不开时照常启动，只是这一次不留日志。
struct Reporter<'a> {
    events: &'a LaunchEventSink,
    clock: SessionClock,
    log: Option<SessionLog>,
}

impl Reporter<'_> {
    /// 进入阶段。阶段名同时作为一行启动器日志推出：实时日志与事后读回的会话日志应是同一份内容。
    async fn stage(&mut self, stage: LaunchStage) {
        let _ = self.events.send(LaunchEvent::Stage(stage));
        self.info(stage.label()).await;
    }

    fn download(&self, progress: DownloadProgress) {
        let _ = self.events.send(LaunchEvent::Download(progress));
    }

    async fn info(&mut self, text: impl Into<String>) {
        self.emit(LauncherLevel::Info, text.into()).await;
    }

    async fn warn(&mut self, text: impl Into<String>) {
        self.emit(LauncherLevel::Warn, text.into()).await;
    }

    async fn emit(&mut self, level: LauncherLevel, text: String) {
        let at = self.clock.now();
        self.write(at, level, &text).await;
        let _ = self.events.send(LaunchEvent::Log { at, level, text });
    }

    /// 只写日志文件。写失败（磁盘满等）就停写，留一条诊断日志，不打断启动。
    async fn write(&mut self, at: u64, level: LauncherLevel, text: &str) {
        if let Some(log) = self.log.as_mut()
            && let Err(err) = log.write(at, LogSource::Launcher, Some(level), text).await
        {
            tracing::warn!(error = %err, "会话日志写入失败，本次启动停止写日志");
            self.log = None;
        }
    }
}

impl Aurora {
    /// 启动一个已安装版本，返回运行中的游戏。
    pub async fn launch(
        &self,
        request: LaunchRequest,
        events: &LaunchEventSink,
    ) -> Result<GameRun, LaunchFailed> {
        self.launch_inner(request, events, None).await
    }

    /// 固定用某个 Java 启动。实例设置还没有 Java 字段，测试要绕开本机 Java 探测只能从这里指定。
    #[cfg(test)]
    pub(crate) async fn launch_with_java(
        &self,
        request: LaunchRequest,
        events: &LaunchEventSink,
        java: PathBuf,
    ) -> Result<GameRun, LaunchFailed> {
        self.launch_inner(request, events, Some(JavaChoice::Path(java)))
            .await
    }

    async fn launch_inner(
        &self,
        request: LaunchRequest,
        events: &LaunchEventSink,
        java_override: Option<JavaChoice>,
    ) -> Result<GameRun, LaunchFailed> {
        let clock = SessionClock::start()?;
        let chain = read_version_chain(self.game_dir(), &request.version_id).await?;
        let version_dir = chain.target.dir.clone();
        let (log, log_error) = match SessionLog::create(
            &logs_dir(&version_dir),
            &request.version_id,
            clock.started_at(),
        )
        .await
        {
            Ok(log) => (Some(log), None),
            Err(err) => (None, Some(err)),
        };
        let mut reporter = Reporter { events, clock, log };
        // 日志只是现场记录，建不起来不值得挡住这一局；但要让玩家在启动日志里看到这一次没有文件可查。
        if let Some(err) = log_error {
            tracing::warn!(error = %err, version = %request.version_id, "会话日志创建失败，本次启动不留日志");
            reporter
                .warn(format!(
                    "本次启动的日志文件创建失败（{err}），崩溃诊断只能依据最近的输出"
                ))
                .await;
        }
        match self
            .launch_with(request, chain, &mut reporter, java_override)
            .await
        {
            Ok(run) => Ok(run),
            Err(err) => {
                let outcome = if err.is_cancelled() {
                    SessionOutcome::Cancelled
                } else {
                    reporter
                        .emit(LauncherLevel::Error, format!("启动失败：{err}"))
                        .await;
                    SessionOutcome::Failed
                };
                if let Some(log) = reporter.log.take()
                    && let Err(log_err) = log.finish(clock.now(), outcome).await
                {
                    tracing::warn!(error = %log_err, "会话日志收尾失败");
                }
                Err(err)
            }
        }
    }

    async fn launch_with(
        &self,
        request: LaunchRequest,
        chain: VersionChain,
        reporter: &mut Reporter<'_>,
        java_override: Option<JavaChoice>,
    ) -> Result<GameRun, LaunchFailed> {
        let LaunchRequest {
            version_id,
            account,
            launcher_version,
            game_log,
        } = request;
        let merged = &chain.merged;
        // 继承链根就是原版：加载器版本的 inheritsFrom 可能指向另一个加载器版本，不能直接当游戏版本号。
        let mc_version = chain.base_id.clone();

        // -- 0 检查 Java（连同账户：令牌续期与 Java 探测都是开局就要知道能不能继续的事）
        reporter.stage(LaunchStage::CheckJava).await;
        let mut settings =
            InstanceLaunchSettings::from_settings(self.version_settings(&version_id).await?);
        if let Some(java) = java_override {
            settings.java = java;
        }
        let (account, auth) = self.launch_identity(account, reporter).await?;
        let required_major = required_java_major(merged);
        let java_plan = self
            .plan_java(required_major, &settings.java, &mc_version, reporter)
            .await?;

        // -- 1 校验游戏文件：工作目录、主类、客户端 jar 与资源
        reporter.stage(LaunchStage::VerifyFiles).await;
        let resolved = self
            .resolve_working_dir_from(
                &version_id,
                settings.isolation,
                chain.target.has_mod_loader(),
                chain.target.is_release(),
            )
            .await?;
        let working_dir = resolved.working_dir.clone();
        tokio::fs::create_dir_all(&working_dir)
            .await
            .map_err(|source| aurora_base::Error::Io {
                path: working_dir.clone(),
                source,
            })?;
        let mut warnings = Vec::new();
        if let Some(text) = game_path_warning(&working_dir) {
            warnings.push(LaunchWarning::GamePath);
            reporter.warn(text).await;
        }
        if merged.main_class.is_none() {
            return Err(LaunchFailure::new(
                FailureCode::VersionBroken,
                format!("版本 {version_id} 缺少主类（mainClass），版本 JSON 可能没有正确合并"),
            )
            .param("reason", "missing_main_class")
            .into());
        }
        let layout = self.layout();
        let mut plan = DownloadPlan::default();
        let mut legacy = self
            .plan_game_files(merged, &chain.base_id, &layout, &mut plan)
            .await?;

        // -- 2 补全库文件
        reporter.stage(LaunchStage::CompleteLibraries).await;
        let libraries = aurora_install::plan::library_tasks(merged, self.runtime(), &layout)?;
        plan.files.extend(libraries);
        if let Some(logging) = aurora_install::plan::logging_task(merged, &layout) {
            plan.files.push(logging);
        }
        let mut plan = DownloadPlan {
            files: missing_files(plan.files).await?,
            asset_index_missing: plan.asset_index_missing,
        };
        let authlib = match &account.credentials {
            AccountCredentials::AuthlibInjector(creds) => Some(creds.api_root.clone()),
            _ => None,
        };

        // -- 3 下载缺失文件（游戏文件、托管 Java、authlib-injector）
        reporter.stage(LaunchStage::DownloadMissing).await;
        let nothing_to_download = plan.files.is_empty()
            && !plan.asset_index_missing
            && !matches!(java_plan, JavaPlan::Download { .. })
            && authlib.is_none();
        if nothing_to_download {
            reporter.download(DownloadProgress {
                total: 0,
                finished: 0,
                bytes: 0,
                total_bytes: Some(0),
                speed: 0,
            });
        } else {
            if !plan.files.is_empty() {
                reporter
                    .info(format!("缺少 {} 个游戏文件，开始下载", plan.files.len()))
                    .await;
            }
            self.download_files(std::mem::take(&mut plan.files), reporter)
                .await?;
            if plan.asset_index_missing {
                let (objects, found) = self.missing_asset_objects(merged, &layout).await?;
                legacy = found;
                self.download_files(objects, reporter).await?;
            }
        }
        if let Some(legacy) = legacy {
            self.ensure_legacy_assets(merged, &chain.base_id, &layout, legacy, reporter)
                .await?;
        }
        let java = match java_plan {
            JavaPlan::Ready(java) => java,
            JavaPlan::Download { major } => self.download_java(major, reporter).await?,
        };
        let authlib = match authlib {
            Some(api_root) => Some(self.prepare_authlib(&api_root, reporter).await?),
            None => None,
        };

        // -- 4 解压本地库
        reporter.stage(LaunchStage::ExtractNatives).await;
        aurora_install::natives::extract_all_natives(
            merged,
            self.runtime(),
            &layout,
            &chain.base_id,
        )
        .await
        .map_err(|err| {
            LaunchFailure::new(FailureCode::FilesFailed, format!("解压本地库失败：{err}"))
                .param("count", 1)
                .param("reason", err.to_string())
                .caused_by(err)
        })?;

        // -- 5 生成启动参数
        reporter.stage(LaunchStage::BuildArguments).await;
        let memory = resolve_memory(settings.memory_mb, self.config().memory);
        let paths = GamePaths::standard(self.game_dir(), &chain.base_id);
        let command = assemble_command(
            merged,
            self.runtime(),
            &java.path,
            paths,
            &working_dir,
            auth,
            &version_id,
            &launcher_version,
            memory,
            &settings,
            authlib,
        )?;
        reporter
            .info(format!(
                "Java {} {}；最大内存 {} MB；工作目录 {}{}",
                java.version.major,
                java.path.display(),
                memory.max_mb,
                working_dir.display(),
                if resolved.isolated {
                    "（已隔离）"
                } else {
                    ""
                }
            ))
            .await;

        // -- 6 启动游戏进程。这里是最后一个可取消的点：进程一旦起来就归运行中的会话管，不再随取消丢弃。
        reporter.stage(LaunchStage::SpawnProcess).await;
        if self.is_cancelled() {
            return Err(CoreError::from(aurora_download::Error::Cancelled).into());
        }
        let log = reporter.log.take();
        let session = spawn_game(&command, reporter.clock, log, game_log)?;
        let pid = session.id();
        let _ = reporter
            .events
            .send(LaunchEvent::Stage(LaunchStage::Running));

        Ok(GameRun::new(
            crate::session::RunInfo {
                version_id,
                version_dir: chain.target.dir.clone(),
                working_dir,
                data_dir: self.data_dir().to_path_buf(),
                clock: reporter.clock,
                running_since: reporter.clock.now(),
                java: crate::session::JavaUsed {
                    major: java.version.major,
                    path: java.path.display().to_string(),
                    is_64bit: java.is_64bit,
                },
                max_memory_mb: memory.max_mb,
                warnings,
                pid,
            },
            session,
        ))
    }

    /// 账户与注入命令行的鉴权值。微软账户在这里静默续期，续期失败按原因分成「需要重登」与「网络问题」。
    async fn launch_identity(
        &self,
        account: LaunchAccount,
        reporter: &mut Reporter<'_>,
    ) -> Result<(Account, AuthValues), LaunchFailed> {
        let account = match account {
            LaunchAccount::Offline { name } => {
                let (tx, mut rx) = mpsc::unbounded_channel();
                let account = self.create_offline_account(&name, Some(&tx))?;
                drop(tx);
                while let Some(event) = rx.recv().await {
                    if let CoreEvent::Warning(text) = event {
                        reporter.warn(text).await;
                    }
                }
                account
            }
            LaunchAccount::Stored(account) => self.refresh_for_launch(account).await?,
        };
        let auth = AuthValues::from_account(&account)?;
        Ok((account, auth))
    }

    /// 微软令牌过期就续期，外置令牌先校验、无效再刷新，离线原样返回。凭据被判定失效时账户库里
    /// 同时落为 `expired`，账户页据此提示重新登录。
    async fn refresh_for_launch(&self, account: Account) -> Result<Account, LaunchFailed> {
        self.ensure_account_fresh(&account)
            .await
            .map_err(|err| classify_refresh(err, &account.name))
    }

    async fn plan_java(
        &self,
        required_major: u32,
        choice: &JavaChoice,
        mc_version: &str,
        reporter: &mut Reporter<'_>,
    ) -> Result<JavaPlan, LaunchFailed> {
        if let JavaChoice::Path(path) = choice {
            let probed = probe_java(path.clone(), DetectSource::Path).await?;
            let java = probed.map_err(|reason| {
                LaunchFailure::new(
                    FailureCode::JavaPinnedMissing,
                    format!("实例指定的 Java 不可用：{}（{reason}）", path.display()),
                )
                .param("path", path.display().to_string())
            })?;
            if java.version.major < required_major {
                return Err(LaunchFailure::new(
                    FailureCode::JavaTooOld,
                    format!(
                        "实例指定的 Java {} 无法运行 Minecraft {mc_version}，至少需要 Java {required_major}",
                        java.version.major
                    ),
                )
                .param("current", java.version.major)
                .param("major", required_major)
                .param("mc_version", mc_version)
                .into());
            }
            if java.version.major > required_major {
                reporter
                    .warn(format!(
                        "实例指定的 Java {} 高于要求的 Java {required_major}，旧版 Forge 与部分 Mod 可能报错",
                        java.version.major
                    ))
                    .await;
            }
            return Ok(JavaPlan::Ready(java));
        }

        let installations = tokio::task::spawn_blocking(detect_all).await?;
        if let Some(java) = select_for_major(&installations, required_major) {
            return Ok(JavaPlan::Ready(java.clone()));
        }
        // 自动下载过的托管运行时不在系统探测范围里，按托管目录的固定布局找。
        let managed = crate::java::runtime_install_dir(self.data_dir(), required_major)
            .join("bin")
            .join(if cfg!(windows) { "java.exe" } else { "java" });
        if tokio::fs::try_exists(&managed)
            .await
            .map_err(|source| aurora_base::Error::Io {
                path: managed.clone(),
                source,
            })?
        {
            match probe_java(managed.clone(), DetectSource::Managed).await? {
                Ok(java) if java.version.major == required_major => {
                    return Ok(JavaPlan::Ready(java));
                }
                Ok(java) => {
                    tracing::warn!(path = %managed.display(), major = java.version.major, "托管运行时主版本与目录不符，重新下载")
                }
                Err(reason) => {
                    tracing::warn!(path = %managed.display(), %reason, "托管运行时无法运行，重新下载")
                }
            }
        }
        if self.config().auto_download_java {
            reporter
                .info(format!("本机没有 Java {required_major}，将下载托管运行时"))
                .await;
            return Ok(JavaPlan::Download {
                major: required_major,
            });
        }
        Err(LaunchFailure::new(
            FailureCode::JavaMissing,
            format!("找不到 Java {required_major}，且自动下载已关闭"),
        )
        .param("major", required_major)
        .param("mc_version", mc_version)
        .into())
    }

    /// 客户端 jar 与资源（索引在本地时连资源对象一起）的下载任务，尚未过滤已就绪的文件。索引在本地且
    /// 是旧版布局时一并返回，下载完再检查展开目录。
    async fn plan_game_files(
        &self,
        merged: &VersionJson,
        base_id: &str,
        layout: &GameLayout,
        plan: &mut DownloadPlan,
    ) -> Result<Option<LegacyAssets>, LaunchFailed> {
        let jar = layout.version_jar(base_id);
        match merged.downloads.as_ref().and_then(|d| d.client.as_ref()) {
            Some(client) => plan.files.push(
                DownloadTask::new(client.url.clone(), jar)
                    .with_sha1(client.sha1.clone())
                    .with_size(client.size),
            ),
            None => {
                if !path_exists(&jar).await? {
                    return Err(LaunchFailure::new(
                        FailureCode::FilesFailed,
                        format!(
                            "客户端 jar {} 缺失，且版本 JSON 没有给出下载地址",
                            jar.display()
                        ),
                    )
                    .param("count", 1)
                    .param("reason", "客户端 jar 缺失且没有下载地址")
                    .into());
                }
            }
        }
        if merged.asset_index.is_none() {
            return Ok(None);
        }
        let index_task = aurora_install::plan::asset_index_task(merged, layout)?;
        if path_exists(&index_task.dest).await? {
            plan.files.push(index_task);
            let (objects, legacy) = self.asset_object_tasks(merged, layout).await?;
            plan.files.extend(objects);
            Ok(legacy)
        } else {
            plan.asset_index_missing = true;
            plan.files.push(index_task);
            Ok(None)
        }
    }

    /// 读本地资源索引，展开成资源对象任务；旧版布局连同索引一起返回。
    async fn asset_object_tasks(
        &self,
        merged: &VersionJson,
        layout: &GameLayout,
    ) -> Result<(Vec<DownloadTask>, Option<LegacyAssets>), LaunchFailed> {
        let asset_index = merged
            .asset_index
            .as_ref()
            .expect("调用方已确认 assetIndex 存在");
        let path = layout.asset_index_json(&asset_index.id);
        let bytes = tokio::fs::read(&path)
            .await
            .map_err(|source| aurora_base::Error::Io {
                path: path.clone(),
                source,
            })?;
        let index = AssetObjectsIndex::from_json_str(&String::from_utf8_lossy(&bytes))
            .map_err(|err| CoreError::from(aurora_install::Error::from(err)))?;
        let tasks = aurora_install::plan::asset_object_tasks(&index, layout);
        let target_dir = match index.layout() {
            AssetLayout::Standard => return Ok((tasks, None)),
            AssetLayout::Virtual => layout.asset_virtual_dir(&asset_index.id),
            AssetLayout::MapToResources => layout.resources_dir(),
        };
        Ok((tasks, Some(LegacyAssets { target_dir, index })))
    }

    async fn missing_asset_objects(
        &self,
        merged: &VersionJson,
        layout: &GameLayout,
    ) -> Result<(Vec<DownloadTask>, Option<LegacyAssets>), LaunchFailed> {
        let (objects, legacy) = self.asset_object_tasks(merged, layout).await?;
        Ok((missing_files(objects).await?, legacy))
    }

    /// 旧版布局的展开目录不全时交给完整补全：展开（按逻辑名复制对象）只在那里实现。展开目录齐全是常态
    /// （安装时已展开），这条路只在玩家删过资源目录时走到，届时完整补全按哈希重验全部文件的代价可以接受。
    async fn ensure_legacy_assets(
        &self,
        merged: &VersionJson,
        base_id: &str,
        layout: &GameLayout,
        legacy: LegacyAssets,
        reporter: &mut Reporter<'_>,
    ) -> Result<(), LaunchFailed> {
        let LegacyAssets { target_dir, index } = legacy;
        // 借用「缺失或大小不符」的检查：这些任务只用来比对展开目录，不会交给下载池。
        let expanded: Vec<DownloadTask> = index
            .objects
            .iter()
            .map(|(logical, object)| {
                let dest = logical
                    .split('/')
                    .filter(|segment| !segment.is_empty())
                    .fold(target_dir.clone(), |dir, segment| dir.join(segment));
                DownloadTask::new(String::new(), dest).with_size(object.size)
            })
            .collect();
        let missing = missing_files(expanded).await?.len();
        if missing == 0 {
            return Ok(());
        }
        reporter
            .info(format!("旧版资源目录缺少 {missing} 个文件，补全游戏文件"))
            .await;
        let http = self.http();
        let pool = self.download_pool();
        let policy = self.retry_policy();
        aurora_install::ensure_complete(
            make_context(&http, &pool, layout, self.runtime(), &policy),
            merged,
            base_id,
        )
        .await
        .map_err(|err| -> LaunchFailed {
            if matches!(&err, aurora_install::Error::Download(inner) if inner.is_cancelled()) {
                return CoreError::from(err).into();
            }
            LaunchFailure::new(FailureCode::FilesFailed, format!("补全旧版资源失败：{err}"))
                .param("count", missing)
                .param("reason", err.to_string())
                .caused_by(err)
                .into()
        })?;
        Ok(())
    }

    /// 下载一批文件并把进度转成阶段 3 的事件。下载前先看磁盘够不够。
    async fn download_files(
        &self,
        files: Vec<DownloadTask>,
        reporter: &mut Reporter<'_>,
    ) -> Result<(), LaunchFailed> {
        if files.is_empty() {
            return Ok(());
        }
        let count = files.len();
        if let Some(needed) = files.iter().map(|task| task.size).sum::<Option<u64>>() {
            let available =
                fs2::available_space(self.game_dir()).map_err(|source| aurora_base::Error::Io {
                    path: self.game_dir().to_path_buf(),
                    source,
                })?;
            if available < needed {
                return Err(disk_full(self.game_dir(), needed - available).into());
            }
        }
        let report = self.run_download(files, reporter).await?;
        if report.is_success() {
            return Ok(());
        }
        Err(classify_download(&report, count, self.game_dir()).into())
    }

    async fn run_download(
        &self,
        files: Vec<DownloadTask>,
        reporter: &mut Reporter<'_>,
    ) -> Result<BatchReport, LaunchFailed> {
        let (tx, mut rx) = mpsc::unbounded_channel::<CoreEvent>();
        let pool = self.download_pool_reporting(Some(&tx));
        drop(tx);
        // 进度直接转进启动事件通道；等转发任务收完最后一份快照再往下走，阶段事件才不会插到进度前面。
        let events = reporter.events.clone();
        let forward = tokio::spawn(async move {
            while let Some(event) = rx.recv().await {
                if let CoreEvent::Download(progress) = event {
                    let _ = events.send(LaunchEvent::Download(progress));
                }
            }
        });
        let result = pool.download_all(files, None).await;
        drop(pool);
        forward.await?;
        Ok(result?)
    }

    async fn download_java(
        &self,
        major: u32,
        reporter: &mut Reporter<'_>,
    ) -> Result<JavaInstallation, LaunchFailed> {
        reporter.info(format!("下载 Java {major} 托管运行时")).await;
        let install_dir = crate::java::runtime_install_dir(self.data_dir(), major);
        let runtime = self
            .java_installer(self.java_runtime_url())
            .install(major, &install_dir)
            .await
            .map_err(|err| -> LaunchFailed {
                if err.is_cancelled() {
                    return CoreError::from(err).into();
                }
                let code = if matches!(err, aurora_java::Error::Http { .. }) {
                    FailureCode::FilesOffline
                } else {
                    FailureCode::FilesFailed
                };
                LaunchFailure::new(code, format!("下载 Java {major} 运行时失败：{err}"))
                    .param("count", 1)
                    .param("reason", err.to_string())
                    .caused_by(err)
                    .into()
            })?;
        let java = probe_java(runtime.java_executable.clone(), DetectSource::Managed)
            .await?
            .map_err(|reason| {
                LaunchFailure::new(
                    FailureCode::FilesFailed,
                    format!("刚下载的 Java {major} 无法运行：{reason}"),
                )
                .param("count", 1)
                .param("reason", reason)
            })?;
        reporter
            .info(format!("Java {major} 已就绪：{}", java.path.display()))
            .await;
        Ok(java)
    }

    async fn prepare_authlib(
        &self,
        api_root: &str,
        reporter: &mut Reporter<'_>,
    ) -> Result<AuthlibInjector, LaunchFailed> {
        let agent = self.ensure_authlib_agent(reporter).await?;
        let metadata = aurora_auth::yggdrasil::prefetch_metadata(
            &self.http(),
            api_root,
            crate::auth::AUTH_SERVER_TIMEOUT,
        )
        .await
        .map_err(|err| -> LaunchFailed {
            let code = if matches!(err, aurora_auth::AuthError::Http { .. }) {
                FailureCode::AccountRefreshNetwork
            } else {
                FailureCode::AccountRelogin
            };
            LaunchFailure::new(code, format!("读取验证服务器 {api_root} 的信息失败：{err}"))
                .param("server", api_root)
                .caused_by(err)
                .into()
        })?;
        Ok(AuthlibInjector::new(agent, metadata.api_root).with_prefetched(metadata.prefetched))
    }

    /// 取最新的 authlib-injector：本地已有同一构建且校验通过就直接用，否则下载；查不到最新构建时沿用
    /// 本地最新的一份。
    async fn ensure_authlib_agent(
        &self,
        reporter: &mut Reporter<'_>,
    ) -> Result<PathBuf, LaunchFailed> {
        let dir = crate::authlib::agent_dir(self.data_dir());
        let urls = crate::authlib::latest_urls(&self.config().download_source.mirror_order());
        let release = match crate::authlib::fetch_latest(&self.http(), &urls).await {
            Ok(release) => release,
            Err(err) => {
                let Some(jar) = crate::authlib::newest_local(&dir).await? else {
                    return Err(agent_unavailable(err).into());
                };
                reporter
                    .warn(format!(
                        "无法检查 authlib-injector 更新（{err}），沿用本地版本"
                    ))
                    .await;
                return Ok(jar);
            }
        };
        let jar = crate::authlib::agent_jar(&dir, release.build_number);
        if crate::authlib::matches_checksum(&jar, &release.checksums.sha256).await? {
            return Ok(jar);
        }
        reporter
            .info(format!("下载 authlib-injector {}", release.version))
            .await;
        self.download_files(
            vec![DownloadTask::new(release.download_url.clone(), jar.clone())],
            reporter,
        )
        .await?;
        if !crate::authlib::matches_checksum(&jar, &release.checksums.sha256).await? {
            // 校验不过的文件当场删掉：离线回落只认目录里现成的 jar，留着它会在下次离线时被当成好文件用。
            tokio::fs::remove_file(&jar)
                .await
                .map_err(|source| aurora_base::Error::Io {
                    path: jar.clone(),
                    source,
                })?;
            return Err(LaunchFailure::new(
                FailureCode::FilesFailed,
                format!("authlib-injector {} 校验不通过", release.version),
            )
            .param("count", 1)
            .param("reason", "authlib-injector 校验不通过")
            .into());
        }
        Ok(jar)
    }
}

impl Aurora {
    /// 解析可用 Java：本地探测并按主版本匹配，缺失且允许时自动下载 Mojang 运行时。供安装器（Forge 安装器
    /// 要用 Java 跑）使用；启动走 [`Aurora::launch`] 自己的 Java 选择，那里还要区分失败码。
    ///
    /// 返回 `(探测/托管的 Java 列表, 选中的 java 可执行文件路径)`。
    pub(crate) async fn prepare_java(
        &self,
        required_major: u32,
        events: Option<&EventSink>,
    ) -> crate::error::Result<(Vec<JavaInstallation>, PathBuf)> {
        let mut installations = tokio::task::spawn_blocking(detect_all).await?;
        if let Some(java) = select_for_major(&installations, required_major) {
            let path = java.path.clone();
            emit(
                events,
                CoreEvent::stage(format!(
                    "使用本地 Java {required_major}：{}",
                    path.display()
                )),
            );
            return Ok((installations, path));
        }

        if !self.config().auto_download_java {
            return Err(CoreError::NoJava {
                major: required_major,
            });
        }

        emit(
            events,
            CoreEvent::stage(format!(
                "本地未找到 Java {required_major}，开始下载 Mojang 运行时"
            )),
        );
        let installer = self.java_installer(self.java_runtime_url());
        let install_dir = crate::java::runtime_install_dir(self.data_dir(), required_major);
        let runtime = installer.install(required_major, &install_dir).await?;
        let exe = runtime.java_executable.clone();
        let probed =
            tokio::task::spawn_blocking(move || aurora_java::probe(&exe, DetectSource::Managed))
                .await??;
        let path = probed.path.clone();
        installations.push(probed);
        emit(
            events,
            CoreEvent::stage(format!(
                "Java {required_major} 运行时安装完成：{}",
                path.display()
            )),
        );
        Ok((installations, path))
    }
}

/// 查不到最新构建、本地也没有任何一份 authlib-injector。
fn agent_unavailable(err: crate::authlib::LatestLookupError) -> LaunchFailure {
    let code = if err.is_offline() {
        FailureCode::FilesOffline
    } else {
        FailureCode::FilesFailed
    };
    let failure = LaunchFailure::new(code, format!("获取 authlib-injector 失败：{err}"))
        .param("count", 1)
        .param("reason", err.to_string());
    match err {
        crate::authlib::LatestLookupError::Download(inner) => failure.caused_by(inner),
        crate::authlib::LatestLookupError::Parse { .. } => failure,
    }
}

/// 起进程；起不来就是 spawn_failed，原样带上系统给的原因。
fn spawn_game(
    command: &LaunchCommand,
    clock: SessionClock,
    log: Option<SessionLog>,
    game_log: Option<LogBatchSink>,
) -> Result<GameSession, LaunchFailed> {
    aurora_launch::spawn(command, clock, log, game_log).map_err(|err| {
        let message = match &err {
            aurora_launch::LaunchError::Spawn { program, source } => {
                format!("无法启动 {}：{source}", program.display())
            }
            other => other.to_string(),
        };
        LaunchFailure::new(FailureCode::SpawnFailed, message.clone())
            .param("message", message)
            .caused_by(err)
            .into()
    })
}

fn classify_refresh(err: CoreError, account_name: &str) -> LaunchFailed {
    match &err {
        CoreError::Auth(aurora_auth::AuthError::Http { .. }) => LaunchFailure::new(
            FailureCode::AccountRefreshNetwork,
            format!("刷新 {account_name} 的登录失败：{err}"),
        )
        .caused_by(err)
        .into(),
        CoreError::Auth(_) => LaunchFailure::new(
            FailureCode::AccountRelogin,
            format!("{account_name} 的登录已失效：{err}"),
        )
        .param("account", account_name)
        .caused_by(err)
        .into(),
        _ => err.into(),
    }
}

/// 在阻塞线程上跑 `java -version`。外层错误是任务本身异常，内层是这个 Java 不可用的原因。
async fn probe_java(
    path: PathBuf,
    source: DetectSource,
) -> Result<Result<JavaInstallation, String>, LaunchFailed> {
    let probed = tokio::task::spawn_blocking(move || aurora_java::probe(&path, source)).await?;
    Ok(probed.map_err(|err| err.to_string()))
}

async fn path_exists(path: &Path) -> Result<bool, LaunchFailed> {
    tokio::fs::try_exists(path).await.map_err(|source| {
        aurora_base::Error::Io {
            path: path.to_path_buf(),
            source,
        }
        .into()
    })
}

/// 过滤出缺失或大小不符的文件。只看元数据不算哈希，几千个文件放在一个阻塞任务里一口气查完。
async fn missing_files(tasks: Vec<DownloadTask>) -> Result<Vec<DownloadTask>, LaunchFailed> {
    let checked = tokio::task::spawn_blocking(move || {
        let mut missing = Vec::new();
        for task in tasks {
            match std::fs::metadata(&task.dest) {
                Ok(meta) => {
                    if task.size.is_some_and(|size| size != meta.len()) {
                        missing.push(task);
                    }
                }
                Err(err) if err.kind() == std::io::ErrorKind::NotFound => missing.push(task),
                Err(source) => {
                    return Err(aurora_base::Error::Io {
                        path: task.dest.clone(),
                        source,
                    });
                }
            }
        }
        Ok(missing)
    })
    .await??;
    Ok(checked)
}

/// 下载批次失败的归类：全是连不上就当没网；有磁盘写满就报磁盘；其余报下载失败并带上第一条原因。
fn classify_download(report: &BatchReport, planned: usize, game_dir: &Path) -> LaunchFailure {
    let failures = &report.failures;
    if failures.iter().any(|f| is_storage_full(&f.error)) {
        let needed = failures.iter().filter_map(|f| f.task.size).sum::<u64>();
        return disk_full(game_dir, needed);
    }
    if failures
        .iter()
        .all(|f| matches!(innermost(&f.error), aurora_download::Error::Request { .. }))
    {
        return LaunchFailure::new(
            FailureCode::FilesOffline,
            format!("还缺 {planned} 个文件，下载源都连不上"),
        )
        .param("count", planned);
    }
    let first = failures
        .first()
        .map(|f| innermost(&f.error).to_string())
        .expect("调用方只在有失败时归类");
    LaunchFailure::new(
        FailureCode::FilesFailed,
        format!("有 {} 个文件下载失败：{first}", failures.len()),
    )
    .param("count", failures.len())
    .param("reason", first)
}

/// 换源下载全部失败时，真正的原因在最后一个源的错误里。
fn innermost(err: &aurora_download::Error) -> &aurora_download::Error {
    match err {
        aurora_download::Error::AllSourcesExhausted { last, .. } => innermost(last),
        other => other,
    }
}

fn is_storage_full(err: &aurora_download::Error) -> bool {
    let mut current: Option<&(dyn std::error::Error + 'static)> = Some(err);
    while let Some(cause) = current {
        if let Some(io) = cause.downcast_ref::<std::io::Error>()
            && io.kind() == std::io::ErrorKind::StorageFull
        {
            return true;
        }
        current = cause.source();
    }
    false
}

fn disk_full(game_dir: &Path, needed_bytes: u64) -> LaunchFailure {
    let drive = drive_label(game_dir);
    LaunchFailure::new(
        FailureCode::DiskFull,
        format!("{drive} 空间不足，还需要 {needed_bytes} 字节"),
    )
    .param("drive", drive)
    .param("needed_bytes", needed_bytes)
}

/// 路径所在的盘：Windows 上是 `D:` 这样的盘符，其余平台取根。
fn drive_label(path: &Path) -> String {
    match path.components().next() {
        Some(std::path::Component::Prefix(prefix)) => {
            prefix.as_os_str().to_string_lossy().into_owned()
        }
        Some(first) => first.as_os_str().to_string_lossy().into_owned(),
        None => path.display().to_string(),
    }
}

/// 用合并后的版本 JSON、路径、鉴权值与实例设置拼出启动命令。
#[allow(clippy::too_many_arguments)]
fn assemble_command(
    merged: &VersionJson,
    runtime: &RuntimeContext,
    java: &Path,
    paths: GamePaths,
    working_dir: &Path,
    auth: AuthValues,
    version_name: &str,
    launcher_version: &str,
    memory: MemoryConfig,
    settings: &InstanceLaunchSettings,
    authlib: Option<AuthlibInjector>,
) -> Result<LaunchCommand, LaunchFailed> {
    let mut builder = CommandBuilder::new(
        merged,
        runtime.clone(),
        java,
        paths,
        working_dir,
        auth,
        launcher_version,
    )
    .with_memory(memory)
    .with_version_name(version_name)
    .fullscreen(settings.fullscreen)
    .add_jvm_args(settings.jvm_args.iter().cloned());
    if let Some((width, height)) = settings.resolution {
        builder = builder.with_resolution(width, height);
    }
    if let Some(authlib) = authlib {
        builder = builder.with_authlib(authlib);
    }
    builder.build().map_err(|err| match err {
        aurora_launch::LaunchError::MissingMainClass { .. }
        | aurora_launch::LaunchError::InvalidLibraryCoordinate { .. } => {
            version_broken(err.to_string()).caused_by(err).into()
        }
        other => other.into(),
    })
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;
    use crate::config::AuroraConfig;
    use aurora_download::CancellationToken;
    use aurora_launch::logfile::SessionOutcome;

    const VERSION: &str = "1.20.1";

    /// 冒充 java 的批处理：`-version` 时按真 JDK 的格式报版本，其余时候当作游戏，打一行日志后以给定码退出。
    fn fake_java(dir: &Path, major: u32, exit_code: i32) -> PathBuf {
        let path = dir.join(format!("fake-java-{major}-{exit_code}.cmd"));
        let script = format!(
            "@echo off\r\n\
             if \"%~1\"==\"-version\" goto version\r\n\
             echo [12:00:00] [main/INFO]: fake game up\r\n\
             exit /b {exit_code}\r\n\
             :version\r\n\
             >&2 echo openjdk version \"{major}.0.8\" 2023-07-18\r\n\
             >&2 echo OpenJDK 64-Bit Server VM (build {major}.0.8+7, mixed mode)\r\n\
             exit /b 0\r\n"
        );
        std::fs::write(&path, script).unwrap();
        path
    }

    /// 一个最小的可启动原版：版本 JSON 不带下载地址，客户端 jar 已在本地。
    fn install_version(mc: &Path, java_major: u32, with_jar: bool) {
        let dir = mc.join("versions").join(VERSION);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join(format!("{VERSION}.json")),
            format!(
                r#"{{"id":"{VERSION}","type":"release","mainClass":"net.minecraft.client.main.Main","javaVersion":{{"component":"java-runtime-gamma","majorVersion":{java_major}}}}}"#
            ),
        )
        .unwrap();
        if with_jar {
            std::fs::write(dir.join(format!("{VERSION}.jar")), b"jar").unwrap();
        }
    }

    struct Fixture {
        _tmp: tempfile::TempDir,
        root: PathBuf,
        aurora: Aurora,
    }

    fn fixture() -> Fixture {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().to_path_buf();
        let aurora = Aurora::for_test(
            AuroraConfig::default(),
            root.clone(),
            root.join(".minecraft"),
        );
        Fixture {
            _tmp: tmp,
            root,
            aurora,
        }
    }

    fn request() -> LaunchRequest {
        LaunchRequest {
            version_id: VERSION.to_owned(),
            account: LaunchAccount::Offline {
                name: "Steve".to_owned(),
            },
            launcher_version: "9.9.9".to_owned(),
            game_log: None,
        }
    }

    /// 发起一次启动并收齐它推出的全部事件。
    async fn launch(
        aurora: &Aurora,
        java: PathBuf,
    ) -> (Result<GameRun, LaunchFailed>, Vec<LaunchEvent>) {
        let (tx, mut rx) = mpsc::unbounded_channel();
        let result = aurora.launch_with_java(request(), &tx, java).await;
        drop(tx);
        let mut events = Vec::new();
        while let Some(event) = rx.recv().await {
            events.push(event);
        }
        (result, events)
    }

    fn stage_indices(events: &[LaunchEvent]) -> Vec<u8> {
        events
            .iter()
            .filter_map(|event| match event {
                LaunchEvent::Stage(stage) => Some(stage.index()),
                _ => None,
            })
            .collect()
    }

    fn expect_failure(result: Result<GameRun, LaunchFailed>) -> LaunchFailure {
        match result {
            Err(LaunchFailed::Failure(failure)) => *failure,
            Err(LaunchFailed::Core(err)) => panic!("应是可处理的启动失败，实际：{err:?}"),
            Ok(_) => panic!("应启动失败"),
        }
    }

    #[test]
    fn stage_table_maps_to_phases_in_order() {
        let stages = [
            LaunchStage::CheckJava,
            LaunchStage::VerifyFiles,
            LaunchStage::CompleteLibraries,
            LaunchStage::DownloadMissing,
            LaunchStage::ExtractNatives,
            LaunchStage::BuildArguments,
            LaunchStage::SpawnProcess,
            LaunchStage::Running,
        ];
        let indices: Vec<u8> = stages.iter().map(|s| s.index()).collect();
        assert_eq!(indices, (0..8).collect::<Vec<u8>>());
        let phases: Vec<LaunchPhase> = stages.iter().map(|s| s.phase()).collect();
        assert_eq!(
            phases,
            vec![
                LaunchPhase::Preparing,
                LaunchPhase::Preparing,
                LaunchPhase::Preparing,
                LaunchPhase::Downloading,
                LaunchPhase::Launching,
                LaunchPhase::Launching,
                LaunchPhase::Launching,
                LaunchPhase::Running,
            ]
        );
    }

    #[test]
    fn memory_follows_instance_then_global_and_drops_impossible_min() {
        let global = MemorySettings {
            max_mb: 4096,
            min_mb: Some(1024),
        };
        let both = resolve_memory(None, global);
        assert_eq!((both.max_mb, both.min_mb), (4096, Some(1024)));
        let instance = resolve_memory(Some(6144), global);
        assert_eq!((instance.max_mb, instance.min_mb), (6144, Some(1024)));
        // 实例最大堆比全局最小堆还小：带上 -Xms 会让 JVM 拒绝启动。
        let small = resolve_memory(Some(768), global);
        assert_eq!((small.max_mb, small.min_mb), (768, None));
        let edge = resolve_memory(Some(1024), global);
        assert_eq!((edge.max_mb, edge.min_mb), (1024, Some(1024)));
    }

    #[test]
    fn instance_settings_map_every_launch_field() {
        let windowed = InstanceLaunchSettings::from_settings(VersionSettings {
            description: Some("周末生存".into()),
            cover: Some("cherry_planks".into()),
            isolation: IsolationOverride::Enabled,
            memory_mb: Some(6144),
            java: JavaSelection::Path(PathBuf::from(r"C:\jdk\bin\java.exe")),
            jvm_args: "  -XX:+UseG1GC\t-Dfoo=bar \n".into(),
            resolution: aurora_instance::Resolution {
                width: 1920,
                height: 1080,
            },
            fullscreen: false,
        });
        assert_eq!(
            windowed,
            InstanceLaunchSettings {
                isolation: IsolationOverride::Enabled,
                memory_mb: Some(6144),
                java: JavaChoice::Path(PathBuf::from(r"C:\jdk\bin\java.exe")),
                jvm_args: vec!["-XX:+UseG1GC".into(), "-Dfoo=bar".into()],
                resolution: Some((1920, 1080)),
                fullscreen: false,
            }
        );

        let fullscreen = InstanceLaunchSettings::from_settings(VersionSettings {
            fullscreen: true,
            ..VersionSettings::default()
        });
        assert_eq!(fullscreen.resolution, None);
        assert!(fullscreen.fullscreen);
        assert_eq!(fullscreen.java, JavaChoice::Auto);
        assert_eq!(fullscreen.memory_mb, None);
        assert!(fullscreen.jvm_args.is_empty());
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn stages_advance_monotonically_to_running_and_crash_is_recorded() {
        let fx = fixture();
        install_version(&fx.root.join(".minecraft"), 17, true);
        let java = fake_java(&fx.root, 17, 3);

        let (result, events) = launch(&fx.aurora, java.clone()).await;
        let run = match result {
            Ok(run) => run,
            Err(err) => panic!("启动应成功：{err:?}"),
        };
        assert_eq!(stage_indices(&events), vec![0, 1, 2, 3, 4, 5, 6, 7]);
        // 没有要下载的文件时，阶段 3 推一份全零进度后立刻进入阶段 4。
        let download_at = events
            .iter()
            .position(|e| matches!(e, LaunchEvent::Download(p) if p.total == 0 && p.total_bytes == Some(0)))
            .expect("阶段 3 应推一份进度");
        let stage = |index: u8| {
            events
                .iter()
                .position(|e| matches!(e, LaunchEvent::Stage(s) if s.index() == index))
                .unwrap()
        };
        assert!(stage(3) < download_at && download_at < stage(4));
        assert!(run.pid().is_some());

        let finished = run.finish().await.unwrap();
        assert!(finished.problems.is_empty(), "{:?}", finished.problems);
        let exit = finished.exit;
        assert_eq!(exit.version_id, VERSION);
        assert_eq!(exit.exit_code, Some(3));
        assert!(exit.crashed);
        assert!(!exit.killed);

        let crash = fx
            .aurora
            .last_crash(VERSION)
            .await
            .unwrap()
            .expect("崩溃应落盘");
        assert_eq!(crash.exit_code, Some(3));
        assert_eq!(crash.java.as_ref().map(|j| j.major), Some(17));
        assert_eq!(
            crash.java.as_ref().map(|j| j.path.clone()),
            Some(java.display().to_string())
        );
        assert_eq!(crash.max_memory_mb, Some(4096));
        assert!(crash.log_path.is_some());

        let log = fx.aurora.last_launch_log(VERSION).await.unwrap().unwrap();
        assert_eq!(log.ended.map(|e| e.outcome), Some(SessionOutcome::Crashed));
        assert!(
            log.lines
                .iter()
                .any(|l| l.source == LogSource::Game && l.text.contains("fake game up")),
            "{:?}",
            log.lines
        );
        // 跑起来过的会话才记游玩。
        assert!(
            fx.aurora
                .play_summaries()
                .await
                .unwrap()
                .contains_key(VERSION)
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn failure_before_running_records_no_playtime() {
        let fx = fixture();
        install_version(&fx.root.join(".minecraft"), 17, false);
        let java = fake_java(&fx.root, 17, 0);

        let (result, events) = launch(&fx.aurora, java).await;
        let failure = expect_failure(result);
        assert_eq!(failure.code, FailureCode::FilesFailed);
        assert_eq!(failure.params.get("count"), Some(&Value::from(1)));
        // 停在阶段 1（校验游戏文件），不会走到后面的阶段。
        assert_eq!(stage_indices(&events), vec![0, 1]);
        assert!(fx.aurora.play_summaries().await.unwrap().is_empty());
        assert!(!fx.root.join(crate::playtime::PLAYTIME_FILE).exists());
        let log = fx.aurora.last_launch_log(VERSION).await.unwrap().unwrap();
        assert_eq!(log.ended.map(|e| e.outcome), Some(SessionOutcome::Failed));
        assert_eq!(fx.aurora.last_crash(VERSION).await.unwrap(), None);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn cancellation_before_spawn_starts_nothing() {
        let fx = fixture();
        install_version(&fx.root.join(".minecraft"), 17, true);
        let java = fake_java(&fx.root, 17, 0);
        let token = CancellationToken::new();
        token.cancel();
        let aurora = fx.aurora.clone().with_cancel(token);

        let (result, events) = launch(&aurora, java).await;
        match result {
            Err(err) => assert!(err.is_cancelled(), "{err:?}"),
            Ok(_) => panic!("取消后不应拉起进程"),
        }
        assert_eq!(stage_indices(&events), vec![0, 1, 2, 3, 4, 5, 6]);
        let log = fx.aurora.last_launch_log(VERSION).await.unwrap().unwrap();
        assert_eq!(
            log.ended.map(|e| e.outcome),
            Some(SessionOutcome::Cancelled)
        );
        assert!(fx.aurora.play_summaries().await.unwrap().is_empty());
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn pinned_java_failures_carry_their_parameters() {
        let fx = fixture();
        install_version(&fx.root.join(".minecraft"), 21, true);

        let missing = fx.root.join("no-such-java.exe");
        let (result, _) = launch(&fx.aurora, missing.clone()).await;
        let failure = expect_failure(result);
        assert_eq!(failure.code, FailureCode::JavaPinnedMissing);
        assert_eq!(
            failure.params.get("path"),
            Some(&Value::from(missing.display().to_string()))
        );

        let (result, _) = launch(&fx.aurora, fake_java(&fx.root, 17, 0)).await;
        let failure = expect_failure(result);
        assert_eq!(failure.code, FailureCode::JavaTooOld);
        assert_eq!(failure.params.get("current"), Some(&Value::from(17)));
        assert_eq!(failure.params.get("major"), Some(&Value::from(21)));
        assert_eq!(
            failure.params.get("mc_version"),
            Some(&Value::from(VERSION))
        );
    }

    #[tokio::test]
    async fn unknown_and_broken_versions_fail_before_any_stage() {
        let fx = fixture();
        let java = fake_java(&fx.root, 17, 0);
        let (result, events) = launch(&fx.aurora, java.clone()).await;
        assert!(
            matches!(&result, Err(LaunchFailed::Core(CoreError::VersionNotInstalled { id })) if id == VERSION),
            "{:?}",
            result.as_ref().err()
        );
        assert!(events.is_empty());

        let dir = fx.root.join(".minecraft").join("versions").join(VERSION);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join(format!("{VERSION}.json")), "{ not json").unwrap();
        let (result, _) = launch(&fx.aurora, java).await;
        let failure = expect_failure(result);
        assert_eq!(failure.code, FailureCode::VersionBroken);
        assert!(failure.params.contains_key("reason"));
    }

    #[test]
    fn failure_codes_match_the_wire_names() {
        let all = [
            (FailureCode::JavaMissing, "java_missing"),
            (FailureCode::JavaPinnedMissing, "java_pinned_missing"),
            (FailureCode::JavaTooOld, "java_too_old"),
            (FailureCode::AccountRelogin, "account_relogin"),
            (
                FailureCode::AccountRefreshNetwork,
                "account_refresh_network",
            ),
            (FailureCode::FilesOffline, "files_offline"),
            (FailureCode::FilesFailed, "files_failed"),
            (FailureCode::DiskFull, "disk_full"),
            (FailureCode::VersionBroken, "version_broken"),
            (FailureCode::SpawnFailed, "spawn_failed"),
        ];
        for (code, name) in all {
            assert_eq!(code.as_str(), name);
            assert_eq!(serde_json::to_value(code).unwrap(), Value::from(name));
        }
    }

    fn failed(error: aurora_download::Error) -> aurora_download::TaskFailure {
        aurora_download::TaskFailure {
            task: DownloadTask::new("https://libraries.minecraft.net/a.jar", "D:/mc/a.jar")
                .with_size(2048),
            error,
        }
    }

    #[tokio::test]
    async fn download_failures_are_classified_through_source_fallback() {
        let http = aurora_base::http::build_client().unwrap();
        // 变体才是归类的依据；用解析不了的地址造一个传输层错误，不必真的去等一次连接超时。
        let unreachable = || async {
            let source = http.get("::not-a-url").send().await.unwrap_err();
            aurora_download::Error::Request {
                url: "::not-a-url".into(),
                source,
            }
        };
        // 官方源与镜像都连不上：换源层把最后一个源的错误包在里面，仍应认作离线。
        let exhausted = aurora_download::Error::AllSourcesExhausted {
            url: "https://libraries.minecraft.net/a.jar".into(),
            last: Box::new(unreachable().await),
        };
        let report = BatchReport {
            total: 3,
            succeeded: 1,
            failures: vec![failed(exhausted), failed(unreachable().await)],
        };
        let offline = classify_download(&report, 3, Path::new(r"D:\mc"));
        assert_eq!(offline.code, FailureCode::FilesOffline);
        assert_eq!(offline.params.get("count"), Some(&Value::from(3)));

        // 有一个源回了 404：不是离线，报下载失败并带上真正的原因。
        let not_found = aurora_download::Error::AllSourcesExhausted {
            url: "https://libraries.minecraft.net/a.jar".into(),
            last: Box::new(aurora_download::Error::Status {
                url: "https://bmclapi2.bangbang93.com/maven/a.jar".into(),
                status: 404,
            }),
        };
        let report = BatchReport {
            total: 3,
            succeeded: 1,
            failures: vec![failed(not_found), failed(unreachable().await)],
        };
        let files = classify_download(&report, 3, Path::new(r"D:\mc"));
        assert_eq!(files.code, FailureCode::FilesFailed);
        assert_eq!(files.params.get("count"), Some(&Value::from(2)));
        let reason = files.params.get("reason").and_then(Value::as_str).unwrap();
        assert!(reason.contains("404"), "{reason}");
    }

    #[test]
    fn drive_label_takes_the_windows_drive() {
        assert_eq!(drive_label(Path::new(r"D:\Games\.minecraft")), "D:");
        let disk = disk_full(Path::new(r"E:\mc"), 1_048_576);
        assert_eq!(disk.code, FailureCode::DiskFull);
        assert_eq!(disk.params.get("drive"), Some(&Value::from("E:")));
        assert_eq!(
            disk.params.get("needed_bytes"),
            Some(&Value::from(1_048_576u64))
        );
    }
}
