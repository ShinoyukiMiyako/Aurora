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
//!
//! 直达存档或服务器（[`QuickPlay`]）在校验游戏文件阶段预检：版本不支持、存档不在、地址写错都在这里
//! 失败，不会先下载一堆文件再告诉玩家进不去。

use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use aurora_auth::{Account, AccountCredentials, AccountStatus};
use aurora_download::{BatchReport, DownloadTask};
use aurora_install::GameLayout;
use aurora_instance::{
    DiscoveredVersion, IsolationOverride, JavaSelection, VERSIONS_DIR, VersionSettings,
};
use aurora_java::{DetectSource, JavaInstallation, select_for_major};
use aurora_launch::logfile::{SessionOutcome, logs_dir};
use aurora_launch::{
    AuthValues, AuthlibInjector, CommandBuilder, GamePaths, GameSession, JvmMemoryIssue,
    LaunchCommand, LauncherLevel, LogBatchSink, LogSource, MemoryConfig, QuickPlayMode,
    QuickPlayTarget, SessionClock, SessionLog, SyncProvider, effective_max_heap_mb,
    game_path_warning, jvm_memory_issue, long_player_name, path_char_outside_code_page,
    quick_play_support, recommended_max_mb, required_java_major, sync_folder, sync_roots_from_env,
};
use aurora_version::{AssetLayout, AssetObjectsIndex, RuntimeContext, VersionJson, resolve};
use serde::Serialize;
use serde_json::Value;
use tokio::sync::mpsc;

use crate::config::MemorySettings;
use crate::error::{CoreError, OfflineFallbackRefusal};
use crate::event::{CoreEvent, DownloadProgress};
use crate::facade::Aurora;
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
    /// 工作目录在 OneDrive 同步的文件夹里。
    OnedriveFolder,
    /// 工作目录在 iCloud 同步的文件夹里。
    IcloudFolder,
    /// 角色名超过 16 个字符，而游戏版本是 1.20.3 或更新。
    LongPlayerName,
    /// 自定义 JVM 参数里 `-Xmx` / `-Xms` 的写法 Java 不认。
    JvmMemoryUnit,
    /// 生效的最小堆大于最大堆。
    JvmMinOverMax,
    /// 生效的最大堆低于 512 MB。
    JvmMaxTooLow,
}

/// 用哪个账户启动。
#[derive(Debug, Clone)]
pub enum LaunchAccount {
    /// 临时离线账户：只校验名字，不落库。
    Offline { name: String },
    /// 账户库里的账户（含令牌）。
    Stored(Box<Account>),
}

/// 启动后直接去哪儿。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum QuickPlay {
    /// 进入存档：`saves/` 下的世界文件夹名（不是存档里写的显示名）。
    Singleplayer { world_dir_name: String },
    /// 加入服务器：玩家写的地址原文。
    Multiplayer { address: String },
}

impl QuickPlay {
    pub fn mode(&self) -> QuickPlayMode {
        match self {
            QuickPlay::Singleplayer { .. } => QuickPlayMode::Singleplayer,
            QuickPlay::Multiplayer { .. } => QuickPlayMode::Multiplayer,
        }
    }
}

/// 一次启动的输入。
pub struct LaunchRequest {
    pub version_id: String,
    pub account: LaunchAccount,
    /// 写进 `${launcher_version}` 的应用版本号。
    pub launcher_version: String,
    /// 游戏输出的批量转发端；`None` 时只写会话日志。
    pub game_log: Option<LogBatchSink>,
    /// 启动后直接进入存档或加入服务器；`None` 为停在标题画面。
    pub quick_play: Option<QuickPlay>,
}

/// 各账户最近一次账户类启动失败，键为账户 uuid。只在内存里：降级放行要的是「刚才亲眼看到验证失败」，
/// 重开启动器后就不再作数。门面的快照克隆共享同一个句柄。
pub(crate) type AccountFailures = Arc<Mutex<HashMap<String, FailureCode>>>;

/// 会被记进 [`AccountFailures`] 的失败码。
const ACCOUNT_FAILURES: [FailureCode; 3] = [
    FailureCode::AccountRelogin,
    FailureCode::AccountRefreshNetwork,
    FailureCode::AccountServiceDown,
];

/// 按记下的上一次账户失败决定能否降级：只有验证本身没能完成（服务故障、网络故障）才放行；凭据被判定
/// 失效时离线进游戏只会掩盖问题，应当重新登录。
fn offline_fallback_verdict(
    previous: Option<FailureCode>,
) -> Result<FailureCode, OfflineFallbackRefusal> {
    match previous {
        Some(code @ (FailureCode::AccountServiceDown | FailureCode::AccountRefreshNetwork)) => {
            Ok(code)
        }
        // 记录里只有账户类失败码，剩下的就是 account_relogin。
        Some(_) => Err(OfflineFallbackRefusal::ReloginRequired),
        None => Err(OfflineFallbackRefusal::NoRecentFailure),
    }
}

/// 启动用的身份：注入命令行的鉴权值、外置登录要注入的验证服务器，以及这一局是否未经验证。
struct LaunchIdentity {
    auth: AuthValues,
    /// 外置登录账户的验证服务器 API 根；`None` 时不下载、不注入 authlib-injector。
    authlib_root: Option<String>,
    offline: bool,
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
    /// 登录服务一侧故障（微软或外置验证服务器回 5xx、429 或故障页），重试过仍不行；不是这个账户的问题。
    AccountServiceDown,
    FilesOffline,
    FilesFailed,
    DiskFull,
    VersionBroken,
    /// 路径里有系统代码页表示不了的字符，Java 收不到这个路径。
    PathUnsupported,
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
            FailureCode::AccountServiceDown => "account_service_down",
            FailureCode::FilesOffline => "files_offline",
            FailureCode::FilesFailed => "files_failed",
            FailureCode::DiskFull => "disk_full",
            FailureCode::VersionBroken => "version_broken",
            FailureCode::PathUnsupported => "path_unsupported",
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

/// 启动用的固定 Java 是在哪一层固定的：实例设置里指定的，还是实例跟随全局、全局设置固定了默认 Java。
/// 随 `java_pinned_missing`、`java_too_old` 以参数 `pinned_by` 交给界面，修复动作据此改对地方。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PinnedBy {
    Instance,
    Global,
}

impl PinnedBy {
    fn as_str(self) -> &'static str {
        match self {
            PinnedBy::Instance => "instance",
            PinnedBy::Global => "global",
        }
    }

    /// 报错与告警里对这个 Java 的称呼。
    fn label(self) -> &'static str {
        match self {
            PinnedBy::Instance => "实例指定的 Java",
            PinnedBy::Global => "设置里固定的默认 Java",
        }
    }
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
            // 设置里原样保存玩家输入的整行参数。按引号切分而不是按空白：带空格的路径（Program Files
            // 下的 -javaagent）与带空格的属性值要写成引号括起来的一个参数，引号本身不交给 JVM。
            jvm_args: aurora_launch::split_args(&jvm_args),
            // 全屏时窗口尺寸参数没有意义，不传，免得部分版本先按尺寸开窗再切全屏。
            resolution: (!fullscreen).then_some((resolution.width, resolution.height)),
            fullscreen,
        }
    }
}

/// 解析实际使用的内存：实例单独设置了就用实例的；否则全局开着自动分配时用 `auto_mb`（此刻的推荐值），
/// 关着时用全局最大堆。`auto_mb` 只在实例没设、全局开着自动分配时由调用方算出，其余情况传 `None`。
/// 最小堆超过最大堆时 JVM 拒绝启动，所以只在不超过最大堆时才带上。逐字段解构全局设置，理由同
/// [`InstanceLaunchSettings::from_settings`]。
pub fn resolve_memory(
    instance_mb: Option<u32>,
    global: MemorySettings,
    auto_mb: Option<u32>,
) -> MemoryConfig {
    let MemorySettings {
        max_mb,
        min_mb,
        auto: _,
    } = global;
    let max = instance_mb.or(auto_mb).unwrap_or(max_mb);
    let config = MemoryConfig::fixed(max);
    match min_mb {
        Some(min) if min <= max => config.with_min(min),
        _ => config,
    }
}

/// 自定义 JVM 参数的内存问题对应的提醒与启动器日志原文。
fn memory_warning(issue: JvmMemoryIssue) -> (LaunchWarning, String) {
    match issue {
        JvmMemoryIssue::BadUnit { arg } => (
            LaunchWarning::JvmMemoryUnit,
            format!(
                "自定义 JVM 参数 {arg} 的写法 Java 不认，内存单位只能是 k、m、g、t，例如 -Xmx4g"
            ),
        ),
        JvmMemoryIssue::MinOverMax { min_mb, max_mb } => (
            LaunchWarning::JvmMinOverMax,
            format!(
                "自定义 JVM 参数让最小内存（{min_mb} MB）大于最大内存（{max_mb} MB），Java 会拒绝启动"
            ),
        ),
        JvmMemoryIssue::MaxTooLow { max_mb } => (
            LaunchWarning::JvmMaxTooLow,
            format!("最大内存只有 {max_mb} MB，低于 512 MB，游戏多半进不了主界面"),
        ),
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
        self.launch_inner(request, false, events, None).await
    }

    /// 以离线方式进单人：这一局不续期、不校验，用账户上次登录时的档案名与 uuid、离线令牌进游戏，阶段
    /// 推进与普通启动相同。只在这个账户上一次启动因服务或网络故障没能验证时放行，由门面凭自己记下的
    /// 失败判定，不信调用方；不能放行时报 [`CoreError::OfflineFallbackRefused`]。
    pub async fn launch_offline_fallback(
        &self,
        request: LaunchRequest,
        events: &LaunchEventSink,
    ) -> Result<GameRun, LaunchFailed> {
        self.launch_inner(request, true, events, None).await
    }

    /// 固定用某个 Java 启动。实例设置还没有 Java 字段，测试要绕开本机 Java 探测只能从这里指定。
    #[cfg(test)]
    pub(crate) async fn launch_with_java(
        &self,
        request: LaunchRequest,
        offline_fallback: bool,
        events: &LaunchEventSink,
        java: PathBuf,
    ) -> Result<GameRun, LaunchFailed> {
        self.launch_inner(
            request,
            offline_fallback,
            events,
            Some(JavaChoice::Path(java)),
        )
        .await
    }

    async fn launch_inner(
        &self,
        request: LaunchRequest,
        offline_fallback: bool,
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
        let stored_uuid = match &request.account {
            LaunchAccount::Stored(account) => Some(account.uuid.clone()),
            LaunchAccount::Offline { .. } => None,
        };
        let result = self
            .launch_with(
                request,
                offline_fallback,
                chain,
                &mut reporter,
                java_override,
            )
            .await;
        if let Some(uuid) = stored_uuid {
            self.record_account_outcome(uuid, &result);
        }
        match result {
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
        offline_fallback: bool,
        chain: VersionChain,
        reporter: &mut Reporter<'_>,
        java_override: Option<JavaChoice>,
    ) -> Result<GameRun, LaunchFailed> {
        let LaunchRequest {
            version_id,
            account,
            launcher_version,
            game_log,
            quick_play,
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
        // 实例跟随全局、全局又固定了默认 Java 时，按固定路径对待：找不到或版本不够同样要报出来，
        // 不能悄悄换成自动挑选的另一个 Java。失败时要说清固定在哪一层：实例本来就是自动选择时，
        // 把实例改回自动选择什么也不会改变，界面得指向设置里的默认 Java。
        let mut pinned_by = PinnedBy::Instance;
        if settings.java == JavaChoice::Auto
            && let Some(path) = &self.config().default_java
        {
            settings.java = JavaChoice::Path(path.clone());
            pinned_by = PinnedBy::Global;
        }
        let LaunchIdentity {
            auth,
            authlib_root: authlib,
            offline,
        } = self
            .launch_identity(account, offline_fallback, reporter)
            .await?;
        let mut warnings = Vec::new();
        // 离线名与正版名本来就不超过 16 个字符，超长的只会来自外置登录的皮肤站，但对谁都查一遍不费事。
        // 查的是真正交给游戏的角色名：以离线方式进单人时它同样取自账户上次登录的档案名。
        // 改过名的原版实例没有 inheritsFrom，继承链根的 id 是玩家起的名字，游戏版本号只在 clientVersion 里。
        let game_version = merged
            .client_version
            .as_deref()
            .filter(|version| !version.is_empty())
            .unwrap_or(&mc_version);
        if long_player_name(&auth.player_name, game_version) {
            warnings.push(LaunchWarning::LongPlayerName);
            reporter
                .warn(format!(
                    "角色名 {} 有 {} 个字符，Minecraft 1.20.3 及更新的版本只认 16 个以内，进入存档或服务器时会被拒绝",
                    auth.player_name,
                    auth.player_name.encode_utf16().count()
                ))
                .await;
        }
        let required_major = required_java_major(merged);
        let java_plan = self
            .plan_java(
                required_major,
                &settings.java,
                pinned_by,
                game_version,
                reporter,
            )
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
        let paths = GamePaths::standard(self.game_dir(), &chain.base_id);
        ensure_paths_reach_java([&paths.client_jar, &paths.natives_dir, &working_dir])?;
        if let Some(text) = game_path_warning(&working_dir) {
            warnings.push(LaunchWarning::GamePath);
            reporter.warn(text).await;
        }
        if let Some(provider) = sync_folder(&working_dir, &sync_roots_from_env()) {
            let (warning, name) = match provider {
                SyncProvider::OneDrive => (LaunchWarning::OnedriveFolder, "OneDrive"),
                SyncProvider::ICloud => (LaunchWarning::IcloudFolder, "iCloud"),
            };
            warnings.push(warning);
            reporter
                .warn(format!(
                    "游戏目录在 {name} 同步的文件夹里（{}），同步时文件可能被占用或替换，建议换一个不在 {name} 里的游戏目录",
                    working_dir.display()
                ))
                .await;
        }
        if merged.main_class.is_none() {
            return Err(LaunchFailure::new(
                FailureCode::VersionBroken,
                format!("版本 {version_id} 缺少主类（mainClass），版本 JSON 可能没有正确合并"),
            )
            .param("reason", "missing_main_class")
            .into());
        }
        let quick_play = match quick_play {
            Some(quick_play) => {
                let target =
                    quick_play_target(&version_id, merged, &working_dir, quick_play).await?;
                reporter
                    .info(match &target {
                        QuickPlayTarget::Singleplayer { world_dir_name } => {
                            format!("直接进入存档「{world_dir_name}」")
                        }
                        QuickPlayTarget::Multiplayer { address, .. } => {
                            format!("直接加入服务器 {address}")
                        }
                    })
                    .await;
                Some(target)
            }
            None => None,
        };
        let layout = self.layout();
        let mut plan = DownloadPlan::default();
        let mut legacy = self
            .plan_game_files(merged, &chain.base_id, &layout, &working_dir, &mut plan)
            .await?;

        // -- 2 补全库文件
        reporter.stage(LaunchStage::CompleteLibraries).await;
        let libraries = aurora_install::plan::library_tasks(merged, self.runtime(), &layout)?;
        plan.files.extend(libraries);
        if let Some(logging) = aurora_install::plan::logging_task(merged, &layout)? {
            plan.files.push(logging);
        }
        let mut plan = DownloadPlan {
            files: missing_files(plan.files).await?,
            asset_index_missing: plan.asset_index_missing,
        };
        aurora_install::complete::reject_missing_bundled(&plan.files)?;

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
                let (objects, found) = self
                    .missing_asset_objects(merged, &layout, &working_dir)
                    .await?;
                legacy = found;
                self.download_files(objects, reporter).await?;
            }
        }
        if let Some(legacy) = legacy {
            self.ensure_legacy_assets(&layout, legacy, reporter).await?;
        }
        let java = match java_plan {
            JavaPlan::Ready(java) => java,
            JavaPlan::Download { major } => {
                self.download_java(major, self.java_runtime_url(), reporter)
                    .await?
            }
        };
        if self.config().prefer_dedicated_gpu {
            self.prefer_dedicated_gpu_for(&java.path, reporter).await?;
        }
        let authlib = match authlib {
            Some(api_root) => Some(
                self.prepare_authlib(&api_root, &auth.player_name, reporter)
                    .await?,
            ),
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
        let global_memory = self.config().memory;
        let auto_mb = if settings.memory_mb.is_none() && global_memory.auto {
            let tier = self.instance_memory_tier(&chain.target).await?;
            Some(recommended_max_mb(
                crate::memory::read_system_memory().await?,
                tier,
            ))
        } else {
            None
        };
        let memory = resolve_memory(settings.memory_mb, global_memory, auto_mb);
        if let Some(issue) = jvm_memory_issue(&settings.jvm_args, memory) {
            let (warning, text) = memory_warning(issue);
            warnings.push(warning);
            reporter.warn(text).await;
        }
        // 崩溃诊断拿它解释内存耗尽：写的要是内存设置而不是 -Xmx，诊断就会说一个这局根本没用上的数。
        let max_heap_mb = effective_max_heap_mb(&settings.jvm_args, memory);
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
            quick_play,
        )?;
        reporter
            .info(format!(
                "Java {} {}；最大内存 {} MB；工作目录 {}{}",
                java.version.major,
                java.path.display(),
                max_heap_mb,
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
        let session = spawn_game(&command, reporter.clock, &mut reporter.log, game_log)?;
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
                game_dir: self.game_dir().to_path_buf(),
                clock: reporter.clock,
                running_since: reporter.clock.now(),
                java: crate::session::JavaUsed {
                    major: java.version.major,
                    path: java.path.display().to_string(),
                    is_64bit: java.is_64bit,
                },
                max_memory_mb: max_heap_mb,
                warnings,
                pid,
                offline,
            },
            session,
        ))
    }

    /// 把这次要拉起的 java 可执行文件设为 Windows 图形设置里的「高性能」。
    ///
    /// 写不进去不挡启动：显卡偏好只影响帧数，游戏照样能玩，按 Windows 默认的显卡启动并在启动日志里说明。
    /// 只有阻塞任务本身异常（程序缺陷）才冒泡。
    async fn prefer_dedicated_gpu_for(
        &self,
        exe: &Path,
        reporter: &mut Reporter<'_>,
    ) -> Result<(), LaunchFailed> {
        let store = self.gpu_preferences();
        let path = exe.to_path_buf();
        let outcome = tokio::task::spawn_blocking(move || {
            crate::gpu::prefer_high_performance(&*store, &path)
        })
        .await?;
        match outcome {
            Ok(crate::gpu::GpuPreferenceChange::Written { previous, value }) => {
                tracing::info!(path = %exe.display(), ?previous, %value, "已写入显卡偏好");
                reporter
                    .info(format!(
                        "已在 Windows 图形设置里让 {} 使用高性能显卡",
                        exe.display()
                    ))
                    .await;
            }
            Ok(crate::gpu::GpuPreferenceChange::Unchanged) => {}
            Err(err) => {
                tracing::warn!(path = %exe.display(), error = %err, cause = ?std::error::Error::source(&err), "写入显卡偏好失败，按 Windows 默认的显卡启动");
                let reason = match &err {
                    CoreError::GpuPreferenceWrite { source, .. } => source.to_string(),
                    other => other.to_string(),
                };
                reporter
                    .warn(format!(
                        "没能写入显卡偏好（{reason}），这次按 Windows 默认的显卡启动"
                    ))
                    .await;
            }
        }
        Ok(())
    }

    /// 记下或清掉这个账户最近一次账户类失败，供以离线方式进单人时判定。只有可处理的账户失败才记；
    /// 正常验证后跑起来的一局清掉记录；其余结局（取消、文件或 Java 失败、降级启动本身）不动它。
    fn record_account_outcome(&self, uuid: String, result: &Result<GameRun, LaunchFailed>) {
        let mut failures = self
            .account_failures
            .lock()
            .expect("账户失败记录的锁已中毒");
        match result {
            Err(LaunchFailed::Failure(failure)) if ACCOUNT_FAILURES.contains(&failure.code) => {
                failures.insert(uuid, failure.code);
            }
            Ok(run) if !run.offline() => {
                failures.remove(&uuid);
            }
            _ => {}
        }
    }

    /// 账户与注入命令行的鉴权值。微软账户在这里静默续期，续期失败按原因分成「需要重登」「服务故障」
    /// 「网络问题」与其余原样报出的错误（见 [`classify_refresh`]）。
    async fn launch_identity(
        &self,
        account: LaunchAccount,
        offline_fallback: bool,
        reporter: &mut Reporter<'_>,
    ) -> Result<LaunchIdentity, LaunchFailed> {
        if offline_fallback {
            return self.offline_fallback_identity(account, reporter).await;
        }
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
            LaunchAccount::Stored(account) => self.refresh_for_launch(*account).await?,
        };
        let auth = AuthValues::from_account(&account)?;
        let authlib_root = match &account.credentials {
            AccountCredentials::AuthlibInjector(creds) => Some(creds.api_root.clone()),
            _ => None,
        };
        Ok(LaunchIdentity {
            auth,
            authlib_root,
            offline: false,
        })
    }

    /// 以离线方式进单人：不发任何网络请求，不写账户库，用账户上次登录时的档案名与 uuid、离线令牌进游戏。
    /// 判定顺序固定：离线账户、已失效账户先拒；再取出（同时消耗）上一次账户失败的记录，按它放行或拒绝。
    async fn offline_fallback_identity(
        &self,
        account: LaunchAccount,
        reporter: &mut Reporter<'_>,
    ) -> Result<LaunchIdentity, LaunchFailed> {
        let refuse = |account: String, reason: OfflineFallbackRefusal| -> LaunchFailed {
            CoreError::OfflineFallbackRefused { account, reason }.into()
        };
        let account = match account {
            LaunchAccount::Offline { name } => {
                return Err(refuse(name, OfflineFallbackRefusal::OfflineAccount));
            }
            LaunchAccount::Stored(account) => *account,
        };
        if matches!(account.credentials, AccountCredentials::Offline) {
            return Err(refuse(account.name, OfflineFallbackRefusal::OfflineAccount));
        }
        if account.status == AccountStatus::Expired {
            return Err(refuse(
                account.name,
                OfflineFallbackRefusal::ReloginRequired,
            ));
        }
        let previous = self
            .account_failures
            .lock()
            .expect("账户失败记录的锁已中毒")
            .remove(&account.uuid);
        let previous = match offline_fallback_verdict(previous) {
            Ok(code) => code,
            Err(reason) => return Err(refuse(account.name, reason)),
        };
        reporter
            .warn(format!(
                "以离线方式进单人：{} 这一局不经账户验证，只能玩单人游戏",
                account.name
            ))
            .await;
        tracing::warn!(
            uuid = %account.uuid,
            name = %account.name,
            previous = previous.as_str(),
            "账户验证不可用，按玩家选择以离线方式启动"
        );
        Ok(LaunchIdentity {
            auth: AuthValues::offline(account.name, account.uuid),
            authlib_root: None,
            offline: true,
        })
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
        pinned_by: PinnedBy,
        mc_version: &str,
        reporter: &mut Reporter<'_>,
    ) -> Result<JavaPlan, LaunchFailed> {
        if let JavaChoice::Path(path) = choice {
            let who = pinned_by.label();
            let probed = probe_java(path.clone(), DetectSource::Path).await?;
            let java = probed.map_err(|reason| {
                LaunchFailure::new(
                    FailureCode::JavaPinnedMissing,
                    format!("{who} 不可用：{}（{reason}）", path.display()),
                )
                .param("path", path.display().to_string())
                .param("pinned_by", pinned_by.as_str())
            })?;
            if java.version.major < required_major {
                return Err(LaunchFailure::new(
                    FailureCode::JavaTooOld,
                    format!(
                        "{who} {} 无法运行 Minecraft {mc_version}，至少需要 Java {required_major}",
                        java.version.major
                    ),
                )
                .param("current", java.version.major)
                .param("major", required_major)
                .param("mc_version", mc_version)
                .param("pinned_by", pinned_by.as_str())
                .into());
            }
            if java.version.major > required_major {
                reporter
                    .warn(format!(
                        "{who} {} 高于要求的 Java {required_major}，旧版 Forge 与部分 Mod 可能报错",
                        java.version.major
                    ))
                    .await;
            }
            // 用户指定的 Java 不完整也照用：缺的文件未必影响启动，替用户换一个就违背了设置。
            if !java.is_complete() {
                reporter
                    .warn(format!(
                        "指定的 Java 缺少 {}，可能没装完整，启动失败时换一个 Java",
                        java.missing_files.join("、")
                    ))
                    .await;
            }
            return Ok(JavaPlan::Ready(java));
        }

        // 走带指纹缓存的探测：每次启动都对每个 java 跑一遍 -version 是数百毫秒的白等。
        let installations = self.detect_java().await?;
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
                Ok(java) if java.version.major == required_major && java.is_complete() => {
                    return Ok(JavaPlan::Ready(java));
                }
                // 缺文件的托管运行时与自动选择一样跳过：重新下载时已就绪的文件按 sha1 跳过，等于补齐。
                Ok(java) if java.version.major == required_major => {
                    tracing::warn!(path = %managed.display(), missing = ?java.missing_files, "托管运行时缺少运行时文件，重新下载补齐")
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
        working_dir: &Path,
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
            let (objects, legacy) = self.asset_object_tasks(merged, layout, working_dir).await?;
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
        working_dir: &Path,
    ) -> Result<(Vec<DownloadTask>, Option<LegacyAssets>), LaunchFailed> {
        let asset_index = merged
            .asset_index
            .as_ref()
            .expect("调用方已确认 assetIndex 存在");
        let path = layout.asset_index_json(&asset_index.id)?;
        let bytes = tokio::fs::read(&path)
            .await
            .map_err(|source| aurora_base::Error::Io {
                path: path.clone(),
                source,
            })?;
        let index = AssetObjectsIndex::from_json_str(&String::from_utf8_lossy(&bytes))
            .map_err(|err| CoreError::from(aurora_install::Error::from(err)))?;
        let tasks = aurora_install::plan::asset_object_tasks(&index, layout)?;
        let target_dir = match index.layout() {
            AssetLayout::Standard => return Ok((tasks, None)),
            AssetLayout::Virtual => layout.asset_virtual_dir(&asset_index.id)?,
            // 这些版本只认工作目录下的 resources。隔离实例的工作目录是实例自己，共享根目录那份它读不到。
            AssetLayout::MapToResources => working_dir.join("resources"),
        };
        Ok((tasks, Some(LegacyAssets { target_dir, index })))
    }

    async fn missing_asset_objects(
        &self,
        merged: &VersionJson,
        layout: &GameLayout,
        working_dir: &Path,
    ) -> Result<(Vec<DownloadTask>, Option<LegacyAssets>), LaunchFailed> {
        let (objects, legacy) = self.asset_object_tasks(merged, layout, working_dir).await?;
        Ok((missing_files(objects).await?, legacy))
    }

    /// 旧版布局的展开目录不全时按逻辑名补齐。对象此时都在本地：缺的刚在下载阶段下完。隔离实例第一次启动、
    /// 玩家删过资源目录时走到这里。
    async fn ensure_legacy_assets(
        &self,
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
                let dest = aurora_install::layout::materialized_asset_path(&target_dir, logical)?;
                Ok(DownloadTask::new(String::new(), dest).with_size(object.size))
            })
            .collect::<Result<_, aurora_install::Error>>()?;
        let missing = missing_files(expanded).await?.len();
        if missing == 0 {
            return Ok(());
        }
        reporter
            .info(format!("旧版资源目录缺少 {missing} 个文件，从资源库补齐"))
            .await;
        aurora_install::complete::materialize_objects(layout, &index, &target_dir)
            .await
            .map_err(|err| -> LaunchFailed {
                LaunchFailure::new(FailureCode::FilesFailed, format!("补全旧版资源失败：{err}"))
                    .param("count", missing)
                    .param("reason", err.to_string())
                    .caused_by(err)
                    .into()
            })?;
        Ok(())
    }

    /// 下载一批游戏文件并把进度转成阶段 3 的事件。下载前先看游戏目录所在的盘够不够。
    async fn download_files(
        &self,
        files: Vec<DownloadTask>,
        reporter: &mut Reporter<'_>,
    ) -> Result<(), LaunchFailed> {
        self.download_files_into(files, self.game_dir(), reporter)
            .await
    }

    /// 下载一批落在 `root` 下的文件，进度转成阶段 3 的事件；下载前先看 `root` 所在的盘够不够。
    async fn download_files_into(
        &self,
        files: Vec<DownloadTask>,
        root: &Path,
        reporter: &mut Reporter<'_>,
    ) -> Result<(), LaunchFailed> {
        if files.is_empty() {
            return Ok(());
        }
        let count = files.len();
        if let Some(needed) = files.iter().map(|task| task.size).sum::<Option<u64>>() {
            let available =
                fs2::available_space(root).map_err(|source| aurora_base::Error::Io {
                    path: root.to_path_buf(),
                    source,
                })?;
            if available < needed {
                return Err(disk_full(root, needed - available).into());
            }
        }
        let report = self.run_download(files, reporter).await?;
        if report.is_success() {
            return Ok(());
        }
        Err(classify_download(&report, count, root).into())
    }

    async fn run_download(
        &self,
        files: Vec<DownloadTask>,
        reporter: &mut Reporter<'_>,
    ) -> Result<BatchReport, LaunchFailed> {
        self.prepare_sources().await?;
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

    /// 下载托管 Java：清单定出要哪些文件，文件交给下载池，与设置里手动安装是同一条路——并发、换源、
    /// 已就绪的按 sha1 跳过，进度和游戏文件一样进阶段 3 的事件。运行时有几百个文件，逐个顺序下载时
    /// 启动进度会停住几十秒到几分钟，首选源上一个文件失败就让整次启动失败。
    async fn download_java(
        &self,
        major: u32,
        manifest_url: &str,
        reporter: &mut Reporter<'_>,
    ) -> Result<JavaInstallation, LaunchFailed> {
        reporter.info(format!("下载 Java {major} 托管运行时")).await;
        let install_dir = crate::java::runtime_install_dir(self.data_dir(), major);
        self.prepare_sources().await?;
        let plan = self
            .java_installer(manifest_url)
            .plan(major, &install_dir)
            .await
            .map_err(|err| java_download_failure(major, err))?;
        let tasks = crate::java::runtime_download_tasks(&plan);
        self.download_files_into(tasks, self.data_dir(), reporter)
            .await?;
        plan.finalize()
            .await
            .map_err(|err| java_download_failure(major, err))?;
        let runtime = plan.installed();
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
        account_name: &str,
        reporter: &mut Reporter<'_>,
    ) -> Result<AuthlibInjector, LaunchFailed> {
        let agent = self.ensure_authlib_agent(reporter).await?;
        let http = self.http();
        let metadata = self
            .until_cancelled(aurora_auth::yggdrasil::prefetch_metadata(
                &http,
                api_root,
                crate::auth::AUTH_SERVER_TIMEOUT,
            ))
            .await?
            .map_err(|err| authlib_metadata_failure(err, api_root, account_name))?;
        Ok(AuthlibInjector::new(agent, metadata.api_root).with_prefetched(metadata.prefetched))
    }

    /// 取最新的 authlib-injector：本地已有同一构建且校验通过就直接用，否则下载；查不到最新构建时沿用
    /// 本地最新的一份。
    async fn ensure_authlib_agent(
        &self,
        reporter: &mut Reporter<'_>,
    ) -> Result<PathBuf, LaunchFailed> {
        let dir = crate::authlib::agent_dir(self.data_dir());
        let urls = self.authlib_latest_urls();
        let urls: Vec<&str> = urls.iter().map(String::as_str).collect();
        let http = self.http();
        let latest = crate::authlib::fetch_latest(&http, &urls);
        let release = match self.until_cancelled(latest).await? {
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
    fn authlib_latest_urls(&self) -> Vec<String> {
        #[cfg(test)]
        if let Some(url) = self.injected_authlib_latest_url() {
            return vec![url.to_owned()];
        }
        crate::authlib::latest_urls(&self.source_order(self.config().download_source))
            .into_iter()
            .map(str::to_owned)
            .collect()
    }

    /// 等一段不挂下载池令牌的联网：线路黑洞时要等连接超时才回来，取消不能跟着等。
    async fn until_cancelled<T>(
        &self,
        work: impl std::future::Future<Output = T>,
    ) -> Result<T, LaunchFailed> {
        match self.cancel_token() {
            Some(token) => token
                .run_until_cancelled(work)
                .await
                .ok_or_else(|| aurora_download::Error::Cancelled.into()),
            None => Ok(work.await),
        }
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
        crate::authlib::LatestLookupError::Parse { .. }
        | crate::authlib::LatestLookupError::TooLarge { .. } => failure,
    }
}

/// 直达目标的预检，顺序即报错的先后：版本不支持（不新增失败码，照常作为启动链路错误冒泡）、存档不在
/// 或文件夹名不安全（复用 [`CoreError::WorldNotFound`]）、文件夹名过不了系统代码页
/// （[`CoreError::WorldNameUnencodable`]）、地址写法不对（[`CoreError::InvalidServerAddress`]）。
/// 不联网解析地址，也不查 SRV：没写端口的地址原样交给游戏自己解析。
async fn quick_play_target(
    version_id: &str,
    merged: &VersionJson,
    working_dir: &Path,
    quick_play: QuickPlay,
) -> Result<QuickPlayTarget, LaunchFailed> {
    let mode = quick_play.mode();
    if !quick_play_support(merged).supports(mode) {
        return Err(aurora_launch::LaunchError::QuickPlayUnsupported {
            version: version_id.to_owned(),
            mode,
        }
        .into());
    }
    match quick_play {
        QuickPlay::Singleplayer { world_dir_name } => {
            let not_found = || CoreError::WorldNotFound {
                version_id: version_id.to_owned(),
                world: world_dir_name.clone(),
            };
            // 文件夹名会原样拼进路径并交给游戏：带分隔符或 `..` 的名字不可能是 saves 下的一个存档。
            if !crate::resources::is_safe_file_name(&world_dir_name) {
                return Err(not_found().into());
            }
            let world_dir = working_dir.join("saves").join(&world_dir_name);
            let is_dir = match tokio::fs::metadata(&world_dir).await {
                Ok(meta) => meta.is_dir(),
                Err(err) if err.kind() == std::io::ErrorKind::NotFound => false,
                Err(source) => {
                    return Err(aurora_base::Error::Io {
                        path: world_dir,
                        source,
                    }
                    .into());
                }
            };
            if !is_dir {
                return Err(not_found().into());
            }
            if let Some(ch) = aurora_launch::quick_play_lost_char(&world_dir_name) {
                return Err(CoreError::WorldNameUnencodable {
                    version_id: version_id.to_owned(),
                    world: world_dir_name,
                    ch,
                }
                .into());
            }
            Ok(QuickPlayTarget::Singleplayer { world_dir_name })
        }
        QuickPlay::Multiplayer { address } => {
            let parsed = crate::servers::parse_server_address(&address)?;
            Ok(QuickPlayTarget::Multiplayer {
                address: address.trim().to_owned(),
                host: parsed.host,
                port: parsed.port,
            })
        }
    }
}

/// 这些路径都要经 java.exe 的命令行。走不通时在下载之前停下：起进程只会等来一句找不到主类。
fn ensure_paths_reach_java<'a>(
    paths: impl IntoIterator<Item = &'a PathBuf>,
) -> Result<(), LaunchFailed> {
    for path in paths {
        if let Some(ch) = path_char_outside_code_page(path) {
            return Err(LaunchFailure::new(
                FailureCode::PathUnsupported,
                format!(
                    "路径里的「{ch}」不在系统代码页里，Java 读不了：{}",
                    path.display()
                ),
            )
            .param("char", ch.to_string())
            .param("path", path.display().to_string())
            .into());
        }
    }
    Ok(())
}

/// 起进程；起不来就是 spawn_failed，原样带上系统给的原因。
fn spawn_game(
    command: &LaunchCommand,
    clock: SessionClock,
    log: &mut Option<SessionLog>,
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

/// 读不到验证服务器元数据时，连不上（联网后重试）与服务故障（5xx、429，稍后重试）算玩家能对症处理的
/// 失败：账户还是好的，可以稍后重试或先以离线方式进单人，形状与续期失败相同。服务器回错误页、地址不是
/// 验证服务器之类的失败重新登录也解决不了，按门面错误原样报出原文，不提示重新登录。
fn authlib_metadata_failure(
    err: aurora_auth::AuthError,
    api_root: &str,
    account_name: &str,
) -> LaunchFailed {
    let message = format!("读取验证服务器 {api_root} 的信息失败：{err}");
    match err {
        aurora_auth::AuthError::Http { .. } => {
            LaunchFailure::new(FailureCode::AccountRefreshNetwork, message)
                .param("server", api_root)
                .caused_by(err)
                .into()
        }
        aurora_auth::AuthError::ServiceUnavailable { status, .. } => {
            LaunchFailure::new(FailureCode::AccountServiceDown, message)
                .param("account", account_name)
                .param("status", u64::from(status))
                .param("server", api_root)
                .caused_by(err)
                .into()
        }
        other => other.into(),
    }
}

/// 续期失败里只有三种给失败码：凭据被服务器判定失效（重新登录，账户由续期本身写库标成需要重登）、
/// 连不上（联网后重试）与登录服务故障（5xx、429，稍后重试）。后两种不碰账户库，账户还是好的，玩家可以
/// 稍后重试或先以离线方式进单人。封禁、未购买、应用未获批准、响应解析不了、凭据库读写失败都不是重新
/// 登录能解决的，按门面错误原样报出原文与错误码。取消同样原样报出：它不是续期的结论，当成账户失败
/// 记下会盖掉门面记下的上一次服务或网络故障，让紧接着的以离线方式进单人被错拒。
fn classify_refresh(err: CoreError, account_name: &str) -> LaunchFailed {
    match &err {
        CoreError::Auth(aurora_auth::AuthError::Http { .. }) => LaunchFailure::new(
            FailureCode::AccountRefreshNetwork,
            format!("刷新 {account_name} 的登录失败：{err}"),
        )
        .caused_by(err)
        .into(),
        CoreError::Auth(aurora_auth::AuthError::ServiceUnavailable { status, .. }) => {
            let status = u64::from(*status);
            LaunchFailure::new(
                FailureCode::AccountServiceDown,
                format!("刷新 {account_name} 的登录失败：{err}"),
            )
            .param("account", account_name)
            .param("status", status)
            .caused_by(err)
            .into()
        }
        CoreError::Auth(aurora_auth::AuthError::ReloginRequired) => LaunchFailure::new(
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

/// 拉运行时清单或收尾（建目录、链接、可执行位）失败。取消照原样冒泡，连不上清单算离线。
///
/// 离线与否沿原因链找 HTTP 层错误，而不是只认某个变体：清单在多个源之间回退时，HTTP 错误包在
/// 聚合错误的下层，只看顶层会把「每个源都连不上」误判成文件问题。
fn java_download_failure(major: u32, err: aurora_java::Error) -> LaunchFailed {
    if err.is_cancelled() {
        return CoreError::from(err).into();
    }
    let code = if has_http_cause(&err) {
        FailureCode::FilesOffline
    } else {
        FailureCode::FilesFailed
    };
    LaunchFailure::new(code, format!("下载 Java {major} 运行时失败：{err}"))
        .param("count", 1)
        .param("reason", err.to_string())
        .caused_by(err)
        .into()
}

/// 错误自身或其原因链上有没有 HTTP 层错误。
fn has_http_cause(err: &(dyn std::error::Error + 'static)) -> bool {
    let mut current = Some(err);
    while let Some(layer) = current {
        if layer.is::<reqwest::Error>() {
            return true;
        }
        current = layer.source();
    }
    false
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

/// 用合并后的版本 JSON、路径、鉴权值与实例设置拼出启动命令。版本不支持直达时的错误照常冒泡，不归为
/// version_broken：版本本身没坏，换个启动方式就能进。
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
    quick_play: Option<QuickPlayTarget>,
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
    if let Some(target) = quick_play {
        builder = builder.with_quick_play(target);
    }
    builder.build().map_err(|err| match err {
        aurora_launch::LaunchError::MissingMainClass { .. }
        | aurora_launch::LaunchError::InvalidLibraryCoordinate { .. }
        | aurora_launch::LaunchError::UnsafePath { .. } => {
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
    use std::sync::Arc;

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

    /// 放在完整运行时目录里的 [`fake_java`]：带 `release` 与 `lib/modules`，启动日志里不会多出
    /// 「指定的 Java 缺少文件」的提醒，断言整串提醒的用例用它。
    fn complete_fake_java(dir: &Path, major: u32, exit_code: i32) -> PathBuf {
        let home = dir.join(format!("jdk-{major}"));
        std::fs::create_dir_all(home.join("bin")).unwrap();
        std::fs::create_dir_all(home.join("lib")).unwrap();
        std::fs::write(
            home.join("release"),
            format!("JAVA_VERSION=\"{major}.0.8\""),
        )
        .unwrap();
        std::fs::write(home.join("lib").join("modules"), b"image").unwrap();
        fake_java(&home.join("bin"), major, exit_code)
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
        // 关掉自动分配：最大堆取全局的固定值，断言才不随本机此刻的空闲内存漂移。
        let config = AuroraConfig {
            memory: MemorySettings {
                auto: false,
                ..MemorySettings::default()
            },
            ..AuroraConfig::default()
        };
        let aurora = Aurora::for_test(config, root.clone(), root.join(".minecraft"));
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
            quick_play: None,
        }
    }

    /// 发起一次启动并收齐它推出的全部事件。
    async fn launch(
        aurora: &Aurora,
        java: PathBuf,
    ) -> (Result<GameRun, LaunchFailed>, Vec<LaunchEvent>) {
        launch_request(aurora, request(), java).await
    }

    async fn launch_request(
        aurora: &Aurora,
        request: LaunchRequest,
        java: PathBuf,
    ) -> (Result<GameRun, LaunchFailed>, Vec<LaunchEvent>) {
        launch_mode(aurora, request, false, java).await
    }

    /// 以离线方式进单人发起一次启动。
    async fn launch_fallback(
        aurora: &Aurora,
        request: LaunchRequest,
        java: PathBuf,
    ) -> (Result<GameRun, LaunchFailed>, Vec<LaunchEvent>) {
        launch_mode(aurora, request, true, java).await
    }

    async fn launch_mode(
        aurora: &Aurora,
        request: LaunchRequest,
        offline_fallback: bool,
        java: PathBuf,
    ) -> (Result<GameRun, LaunchFailed>, Vec<LaunchEvent>) {
        let (tx, mut rx) = mpsc::unbounded_channel();
        let result = aurora
            .launch_with_java(request, offline_fallback, &tx, java)
            .await;
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

    const MS_UUID: &str = "0123456789abcdef0123456789abcdef";
    const MS_NAME: &str = "PetalPlayer";

    /// Minecraft 令牌早已过期的微软账户：启动必须先续期。
    fn stale_microsoft() -> Account {
        let mut account = Account::new(
            MS_UUID,
            MS_NAME,
            AccountCredentials::Microsoft(aurora_auth::MicrosoftCredentials {
                refresh_token: "CACHED-REFRESH".into(),
                minecraft_token: Some("CACHED-MC".into()),
                minecraft_expires_at: Some(1),
            }),
        );
        account.last_verified_at = Some(7);
        account.xuid = Some("2535400000000001".into());
        account
    }

    fn stored_request(account: Account) -> LaunchRequest {
        LaunchRequest {
            account: LaunchAccount::Stored(Box::new(account)),
            ..request()
        }
    }

    /// 游戏参数里与直达有关的四个块，摘自官方 1.20.1 版本 JSON。
    const QUICK_PLAY_GAME_ARGS: &str = r#"["--username","${auth_player_name}","--version","${version_name}",
        {"rules":[{"action":"allow","features":{"has_quick_plays_support":true}}],"value":["--quickPlayPath","${quickPlayPath}"]},
        {"rules":[{"action":"allow","features":{"is_quick_play_singleplayer":true}}],"value":["--quickPlaySingleplayer","${quickPlaySingleplayer}"]},
        {"rules":[{"action":"allow","features":{"is_quick_play_multiplayer":true}}],"value":["--quickPlayMultiplayer","${quickPlayMultiplayer}"]},
        {"rules":[{"action":"allow","features":{"is_quick_play_realms":true}}],"value":["--quickPlayRealms","${quickPlayRealms}"]}]"#;

    /// 旧式启动参数：有 `--username`，没有 Quick Play 块。
    const LEGACY_ARGS: &str =
        r#""minecraftArguments":"--username ${auth_player_name} --version ${version_name}""#;

    fn quick_play_json(id: &str) -> String {
        format!(
            r#"{{"id":"{id}","type":"release","mainClass":"net.minecraft.client.main.Main","javaVersion":{{"component":"java-runtime-gamma","majorVersion":17}},"arguments":{{"game":{QUICK_PLAY_GAME_ARGS}}}}}"#
        )
    }

    fn legacy_json(id: &str) -> String {
        format!(
            r#"{{"id":"{id}","type":"release","mainClass":"net.minecraft.client.main.Main","javaVersion":{{"component":"java-runtime-gamma","majorVersion":17}},{LEGACY_ARGS}}}"#
        )
    }

    /// 装一个客户端 jar 已在本地、版本 JSON 由调用方给出的实例。
    fn install_json(mc: &Path, id: &str, json: &str) {
        let dir = mc.join("versions").join(id);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join(format!("{id}.json")), json).unwrap();
        std::fs::write(dir.join(format!("{id}.jar")), b"jar").unwrap();
    }

    fn quick_request(version_id: &str, quick_play: QuickPlay) -> LaunchRequest {
        LaunchRequest {
            version_id: version_id.to_owned(),
            quick_play: Some(quick_play),
            ..request()
        }
    }

    fn msa_endpoints(server: &wiremock::MockServer) -> aurora_auth::MsaEndpoints {
        aurora_auth::MsaEndpoints {
            oauth_base: server.uri(),
            xbl_authenticate: format!("{}/xbl", server.uri()),
            xsts_authorize: format!("{}/xsts", server.uri()),
            minecraft_base: server.uri(),
        }
    }

    /// 刷新令牌端点按给定状态与响应体回应；其后的 XBL 等步骤都没挂，走不到。
    async fn mount_token(server: &wiremock::MockServer, response: wiremock::ResponseTemplate) {
        use wiremock::matchers::{method, path};
        wiremock::Mock::given(method("POST"))
            .and(path("/token"))
            .respond_with(response)
            .mount(server)
            .await;
    }

    fn outage_page() -> wiremock::ResponseTemplate {
        wiremock::ResponseTemplate::new(503)
            .insert_header("content-type", "text/html")
            .set_body_string("<html><body>Service Unavailable</body></html>")
    }

    fn invalid_grant() -> wiremock::ResponseTemplate {
        wiremock::ResponseTemplate::new(400).set_body_json(serde_json::json!({
            "error": "invalid_grant",
            "error_description": "AADSTS70000: refresh token revoked"
        }))
    }

    /// 门面上布置一个过期的微软账户、指向 mock 的登录端点，返回落库后的账户。
    fn with_stale_account(fx: &Fixture, server: &wiremock::MockServer) -> (Aurora, Account) {
        with_stale_account_as(fx, server, MS_UUID)
    }

    /// 同 [`with_stale_account`]，账户用指定的 uuid。续期闸按 uuid 在进程内共享：要卡准续期时机的用例单用
    /// 一个 uuid，否则满载时会排在别的用例的续期后面，请求迟迟发不出去。
    fn with_stale_account_as(
        fx: &Fixture,
        server: &wiremock::MockServer,
        uuid: &str,
    ) -> (Aurora, Account) {
        let aurora = fx.aurora.clone().with_msa_endpoints(msa_endpoints(server));
        let mut account = stale_microsoft();
        account.uuid = uuid.to_owned();
        let stored = aurora.store_account_for_test(account).unwrap();
        (aurora, stored)
    }

    /// 冒充 java 的批处理：报 Java 17；当作游戏时把收到的全部参数回显成一行游戏输出。
    fn echo_java(dir: &Path) -> PathBuf {
        let path = dir.join("echo-java.cmd");
        let script = "@echo off\r\n\
             if \"%~1\"==\"-version\" goto version\r\n\
             echo ARGS %*\r\n\
             exit /b 0\r\n\
             :version\r\n\
             >&2 echo openjdk version \"17.0.8\" 2023-07-18\r\n\
             >&2 echo OpenJDK 64-Bit Server VM (build 17.0.8+7, mixed mode)\r\n\
             exit /b 0\r\n";
        std::fs::write(&path, script).unwrap();
        path
    }

    /// 带旧式 minecraftArguments 的最小原版：鉴权值经占位符原样落进游戏参数，回显出来即可断言。
    fn install_legacy_args_version(mc: &Path) {
        let dir = mc.join("versions").join(VERSION);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join(format!("{VERSION}.json")),
            format!(
                r#"{{"id":"{VERSION}","type":"release","mainClass":"net.minecraft.client.main.Main","minecraftArguments":"--username ${{auth_player_name}} --uuid ${{auth_uuid}} --accessToken ${{auth_access_token}} --userType ${{user_type}}","javaVersion":{{"component":"java-runtime-gamma","majorVersion":17}}}}"#
            ),
        )
        .unwrap();
        std::fs::write(dir.join(format!("{VERSION}.jar")), b"jar").unwrap();
    }

    /// 带 pre-1.6 资源索引的远古版本：索引与对象已在本地，走不到下载。
    fn install_pre_1_6_version(mc: &Path, id: &str, object: &[u8]) -> String {
        let hash = "ab".repeat(20);
        let index = format!(
            r#"{{"map_to_resources":true,"objects":{{"sound/step/grass1.ogg":{{"hash":"{hash}","size":{}}}}}}}"#,
            object.len()
        );
        let indexes = mc.join("assets").join("indexes");
        std::fs::create_dir_all(&indexes).unwrap();
        std::fs::write(indexes.join("pre-1.6.json"), &index).unwrap();
        let bucket = mc.join("assets").join("objects").join(&hash[..2]);
        std::fs::create_dir_all(&bucket).unwrap();
        std::fs::write(bucket.join(&hash), object).unwrap();
        install_json(
            mc,
            id,
            &format!(
                r#"{{"id":"{id}","type":"old_beta","mainClass":"net.minecraft.launchwrapper.Launch",
                    "javaVersion":{{"component":"java-runtime-gamma","majorVersion":17}},
                    "assets":"pre-1.6",
                    "assetIndex":{{"id":"pre-1.6","sha1":"{hash}","size":{},"url":"http://invalid.test/pre-1.6.json"}},
                    "minecraftArguments":"${{auth_player_name}} --gameDir ${{game_directory}} --assetsDir ${{game_assets}}"}}"#,
                index.len()
            ),
        );
        hash
    }

    /// 远古版本默认隔离，游戏只读工作目录下的 resources：铺到共享根目录等于没铺，这些版本一个音效都没有。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn isolated_pre_1_6_version_gets_resources_in_its_own_working_dir() {
        let fx = fixture();
        let mc = fx.root.join(".minecraft");
        install_pre_1_6_version(&mc, "b1.7.3", b"ogg!");
        let java = echo_java(&fx.root);
        let request = LaunchRequest {
            version_id: "b1.7.3".to_owned(),
            ..request()
        };

        let (result, _) = launch_request(&fx.aurora, request, java).await;
        let Ok(run) = result else {
            panic!("应启动成功");
        };
        let finished = run.finish().await;
        assert_eq!(finished.exit.exit_code, Some(0));

        let working_dir = mc.join("versions").join("b1.7.3");
        let resources = working_dir.join("resources");
        assert_eq!(
            std::fs::read(resources.join("sound").join("step").join("grass1.ogg")).unwrap(),
            b"ogg!"
        );
        let log = fx.aurora.last_launch_log("b1.7.3").await.unwrap().unwrap();
        let args = log
            .lines
            .iter()
            .find(|l| l.source == LogSource::Game && l.text.starts_with("ARGS "))
            .map(|l| l.text.clone())
            .expect("假 java 应回显启动参数");
        // 批处理回显时参数带不带引号由转义规则定，比的是内容。
        assert!(
            args.replace('"', "")
                .contains(&format!("--assetsDir {}", resources.display())),
            "{args}"
        );
    }

    /// 展开目录里缺的文件在启动时补回来；对象本身就在本地，不下载也不重新校验别的文件。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn missing_pre_1_6_resources_are_restored_on_the_next_launch() {
        let fx = fixture();
        let mc = fx.root.join(".minecraft");
        install_pre_1_6_version(&mc, "b1.7.3", b"ogg!");
        let java = echo_java(&fx.root);
        let request = || LaunchRequest {
            version_id: "b1.7.3".to_owned(),
            ..super::tests::request()
        };

        let (first, _) = launch_request(&fx.aurora, request(), java.clone()).await;
        let Ok(run) = first else {
            panic!("第一次应启动成功");
        };
        run.finish().await;
        let copied = mc
            .join("versions")
            .join("b1.7.3")
            .join("resources")
            .join("sound")
            .join("step")
            .join("grass1.ogg");
        std::fs::remove_file(&copied).unwrap();

        let (second, _) = launch_request(&fx.aurora, request(), java).await;
        let Ok(run) = second else {
            panic!("第二次应启动成功");
        };
        run.finish().await;
        assert_eq!(std::fs::read(&copied).unwrap(), b"ogg!");
    }

    /// java.exe 按系统代码页读命令行，表示不了的字符变成问号，游戏只会报找不到主类。不起进程，
    /// 说清楚是哪个字符。
    #[cfg(windows)]
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn path_outside_the_system_code_page_stops_the_launch() {
        // 扩展 B 区的汉字，不在任何 ANSI 代码页里。
        let id = "\u{20BB7}";
        // 系统代码页切成 UTF-8 的机器上这条路径是合法的。
        if aurora_launch::path_char_outside_code_page(Path::new(id)).is_none() {
            return;
        }
        let fx = fixture();
        let mc = fx.root.join(".minecraft");
        install_pre_1_6_version(&mc, id, b"ogg!");
        let java = echo_java(&fx.root);
        let request = LaunchRequest {
            version_id: id.to_owned(),
            ..super::tests::request()
        };

        let (result, _) = launch_request(&fx.aurora, request, java).await;

        let failure = expect_failure(result);
        assert_eq!(failure.code, FailureCode::PathUnsupported);
        assert_eq!(failure.params["char"], Value::from(id));
        let path = failure.params["path"].as_str().unwrap();
        assert!(path.ends_with(&format!("{id}.jar")), "{path}");
    }

    /// 刷新成功的整条令牌链；`login` 决定 Minecraft 登录那一步怎么回应。
    async fn mount_chain(server: &wiremock::MockServer, login: wiremock::ResponseTemplate) {
        use serde_json::json;
        use wiremock::matchers::{method, path};
        use wiremock::{Mock, ResponseTemplate};
        mount_token(
            server,
            ResponseTemplate::new(200).set_body_json(json!({
                "access_token": "msa-access",
                "refresh_token": "ROTATED-REFRESH",
                "expires_in": 3600
            })),
        )
        .await;
        for route in ["/xbl", "/xsts"] {
            Mock::given(method("POST"))
                .and(path(route))
                .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                    "Token": "xbox-token",
                    "DisplayClaims": { "xui": [ { "uhs": "uhs" } ] }
                })))
                .mount(server)
                .await;
        }
        Mock::given(method("POST"))
            .and(path("/authentication/login_with_xbox"))
            .respond_with(login)
            .mount(server)
            .await;
        Mock::given(method("GET"))
            .and(path("/minecraft/profile"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "id": MS_UUID,
                "name": MS_NAME
            })))
            .mount(server)
            .await;
    }

    fn refusal(result: Result<GameRun, LaunchFailed>) -> (String, OfflineFallbackRefusal) {
        match result {
            Err(LaunchFailed::Core(CoreError::OfflineFallbackRefused { account, reason })) => {
                (account, reason)
            }
            Err(other) => panic!("应拒绝以离线方式进单人，实际：{other:?}"),
            Ok(_) => panic!("应拒绝以离线方式进单人，实际启动成功"),
        }
    }

    fn expect_run(result: Result<GameRun, LaunchFailed>) -> GameRun {
        match result {
            Ok(run) => run,
            Err(err) => panic!("启动应成功：{err:?}"),
        }
    }

    fn failures_of(aurora: &Aurora) -> HashMap<String, FailureCode> {
        aurora.account_failures.lock().unwrap().clone()
    }

    #[test]
    fn offline_fallback_verdict_allows_only_unverifiable_outcomes() {
        assert_eq!(
            offline_fallback_verdict(Some(FailureCode::AccountServiceDown)),
            Ok(FailureCode::AccountServiceDown)
        );
        assert_eq!(
            offline_fallback_verdict(Some(FailureCode::AccountRefreshNetwork)),
            Ok(FailureCode::AccountRefreshNetwork)
        );
        assert_eq!(
            offline_fallback_verdict(Some(FailureCode::AccountRelogin)),
            Err(OfflineFallbackRefusal::ReloginRequired)
        );
        assert_eq!(
            offline_fallback_verdict(None),
            Err(OfflineFallbackRefusal::NoRecentFailure)
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn offline_fallback_after_service_down_plays_with_cached_identity_and_no_network() {
        let server = wiremock::MockServer::start().await;
        mount_token(&server, outage_page()).await;
        let fx = fixture();
        install_legacy_args_version(&fx.root.join(".minecraft"));
        let (aurora, stored) = with_stale_account(&fx, &server);
        let java = echo_java(&fx.root);

        let (result, _) =
            launch_request(&aurora, stored_request(stored.clone()), java.clone()).await;
        assert_eq!(expect_failure(result).code, FailureCode::AccountServiceDown);
        assert_eq!(
            failures_of(&aurora).get(MS_UUID),
            Some(&FailureCode::AccountServiceDown)
        );
        let before = server.received_requests().await.unwrap().len();

        let (result, events) = launch_fallback(&aurora, stored_request(stored.clone()), java).await;
        let run = expect_run(result);
        assert!(run.offline());
        // 不续期、不校验：这一局没有打到任何登录端点。
        assert_eq!(server.received_requests().await.unwrap().len(), before);
        // 阶段推进与普通启动相同。
        assert_eq!(stage_indices(&events), vec![0, 1, 2, 3, 4, 5, 6, 7]);
        let warning = format!("以离线方式进单人：{MS_NAME} 这一局不经账户验证，只能玩单人游戏");
        assert!(
            events.iter().any(|e| matches!(
                e,
                LaunchEvent::Log { level: LauncherLevel::Warn, text, .. } if *text == warning
            )),
            "{events:?}"
        );
        // 记录取出即消耗，降级成功也不会再写回。
        assert!(failures_of(&aurora).is_empty());

        let finished = run.finish().await;
        assert_eq!(finished.exit.exit_code, Some(0));
        let log = fx.aurora.last_launch_log(VERSION).await.unwrap().unwrap();
        assert!(
            log.lines.iter().any(|l| l.source == LogSource::Launcher
                && l.level == Some(LauncherLevel::Warn)
                && l.text == warning),
            "{:?}",
            log.lines
        );
        let args = log
            .lines
            .iter()
            .find(|l| l.source == LogSource::Game && l.text.starts_with("ARGS "))
            .map(|l| l.text.clone())
            .expect("假 java 应回显启动参数");
        assert!(args.contains(&format!("--username {MS_NAME} ")), "{args}");
        assert!(args.contains(&format!("--uuid {MS_UUID} ")), "{args}");
        assert!(args.contains("--accessToken 0 "), "{args}");
        assert!(args.contains("--userType legacy"), "{args}");
        for secret in ["CACHED-MC", "CACHED-REFRESH", "MC-TOKEN", "--userType msa"] {
            assert!(!args.contains(secret), "参数里不该出现 {secret}：{args}");
        }

        // 账户状态与凭据不变：降级不写账户库。
        let after = aurora
            .find_account(MS_UUID)
            .unwrap()
            .expect("账户应仍在库中");
        assert_eq!(after, stored);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn offline_fallback_is_refused_for_offline_accounts() {
        let fx = fixture();
        install_version(&fx.root.join(".minecraft"), 17, true);
        let java = fake_java(&fx.root, 17, 0);

        let (result, events) = launch_fallback(&fx.aurora, request(), java.clone()).await;
        assert_eq!(
            refusal(result),
            ("Steve".to_owned(), OfflineFallbackRefusal::OfflineAccount)
        );
        assert_eq!(stage_indices(&events), vec![0]);

        let library = fx.aurora.add_offline_account("Alex", None).unwrap();
        // 即便门面记着它的一次失败，离线账户也没有验证可降级。
        fx.aurora
            .account_failures
            .lock()
            .unwrap()
            .insert(library.uuid.clone(), FailureCode::AccountServiceDown);
        let (result, _) = launch_fallback(&fx.aurora, stored_request(library.clone()), java).await;
        assert_eq!(
            refusal(result),
            ("Alex".to_owned(), OfflineFallbackRefusal::OfflineAccount)
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn offline_fallback_is_refused_once_the_login_is_invalid() {
        // 续期被判定失效：账户落为 expired，降级按「需要重新登录」拒绝。
        let server = wiremock::MockServer::start().await;
        mount_token(&server, invalid_grant()).await;
        let fx = fixture();
        install_version(&fx.root.join(".minecraft"), 17, true);
        let java = fake_java(&fx.root, 17, 0);
        let (aurora, stored) = with_stale_account(&fx, &server);
        let (result, _) = launch_request(&aurora, stored_request(stored), java.clone()).await;
        assert_eq!(expect_failure(result).code, FailureCode::AccountRelogin);
        let expired = aurora.find_account(MS_UUID).unwrap().unwrap();
        assert_eq!(expired.status, AccountStatus::Expired);
        let before = server.received_requests().await.unwrap().len();
        let (result, _) =
            launch_fallback(&aurora, stored_request(expired.clone()), java.clone()).await;
        assert_eq!(
            refusal(result),
            (MS_NAME.to_owned(), OfflineFallbackRefusal::ReloginRequired)
        );
        assert_eq!(server.received_requests().await.unwrap().len(), before);
        assert_eq!(aurora.find_account(MS_UUID).unwrap().unwrap(), expired);

        // 应用未获批准：重新登录也解决不了，按门面错误原样报出，不记账户失败，账户也没被标成失效；
        // 没有服务或网络故障的记录，降级按「没有最近的失败」拒绝。
        let server = wiremock::MockServer::start().await;
        mount_chain(
            &server,
            wiremock::ResponseTemplate::new(403).set_body_string(
                r#"{"path":"/authentication/login_with_xbox","errorMessage":"Invalid app registration, see https://aka.ms/AppRegInfo for more information"}"#,
            ),
        )
        .await;
        let fx = fixture();
        install_version(&fx.root.join(".minecraft"), 17, true);
        let (aurora, stored) = with_stale_account(&fx, &server);
        let (result, _) = launch_request(&aurora, stored_request(stored), java.clone()).await;
        assert!(
            matches!(
                &result,
                Err(LaunchFailed::Core(CoreError::Auth(
                    aurora_auth::AuthError::AppNotApproved
                )))
            ),
            "应用未获批准应原样报出：{:?}",
            result.err()
        );
        assert!(failures_of(&aurora).is_empty());
        let current = aurora.find_account(MS_UUID).unwrap().unwrap();
        assert_eq!(current.status, AccountStatus::Ok);
        let (result, _) = launch_fallback(&aurora, stored_request(current), java).await;
        assert_eq!(
            refusal(result),
            (MS_NAME.to_owned(), OfflineFallbackRefusal::NoRecentFailure)
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn offline_fallback_needs_a_recent_failure_and_consumes_it_once() {
        let server = wiremock::MockServer::start().await;
        mount_token(&server, outage_page()).await;
        let fx = fixture();
        install_version(&fx.root.join(".minecraft"), 17, true);
        let java = fake_java(&fx.root, 17, 0);
        let (aurora, stored) = with_stale_account(&fx, &server);

        // 没有先前失败：不放行，也不联网。
        let (result, events) =
            launch_fallback(&aurora, stored_request(stored.clone()), java.clone()).await;
        assert_eq!(
            refusal(result),
            (MS_NAME.to_owned(), OfflineFallbackRefusal::NoRecentFailure)
        );
        assert_eq!(stage_indices(&events), vec![0]);
        assert!(server.received_requests().await.unwrap().is_empty());

        let (result, _) =
            launch_request(&aurora, stored_request(stored.clone()), java.clone()).await;
        assert_eq!(expect_failure(result).code, FailureCode::AccountServiceDown);

        // 重开门面（同一数据目录）：记录只在内存里，不作数。
        let reopened = Aurora::for_test(
            fx.aurora.config().clone(),
            fx.root.clone(),
            fx.root.join(".minecraft"),
        )
        .with_msa_endpoints(msa_endpoints(&server));
        let (result, _) =
            launch_fallback(&reopened, stored_request(stored.clone()), java.clone()).await;
        assert_eq!(
            refusal(result),
            (MS_NAME.to_owned(), OfflineFallbackRefusal::NoRecentFailure)
        );

        // 快照克隆共享同一份记录：在克隆上降级成功，原门面上的记录随之消耗。
        let snapshot = aurora.clone();
        let (result, _) =
            launch_fallback(&snapshot, stored_request(stored.clone()), java.clone()).await;
        let run = expect_run(result);
        assert!(run.offline());
        run.finish().await;

        // 一次性：紧接着再降级一次就没有可用的失败记录了。
        let (result, _) = launch_fallback(&aurora, stored_request(stored), java).await;
        assert_eq!(
            refusal(result),
            (MS_NAME.to_owned(), OfflineFallbackRefusal::NoRecentFailure)
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn offline_fallback_still_warns_about_a_long_player_name() {
        // 降级不经账户验证，但交给游戏的角色名照旧是账户档案名：超长名的提醒不能因为跳过了续期而漏掉。
        const NEW_VERSION: &str = "1.21.1";
        const LONG_NAME: &str = "PetalPlayerLongName01";
        let server = wiremock::MockServer::start().await;
        mount_token(&server, outage_page()).await;
        let fx = fixture();
        let dir = fx
            .root
            .join(".minecraft")
            .join("versions")
            .join(NEW_VERSION);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join(format!("{NEW_VERSION}.json")),
            format!(
                r#"{{"id":"{NEW_VERSION}","type":"release","mainClass":"net.minecraft.client.main.Main","javaVersion":{{"component":"java-runtime-delta","majorVersion":17}}}}"#
            ),
        )
        .unwrap();
        std::fs::write(dir.join(format!("{NEW_VERSION}.jar")), b"jar").unwrap();
        let aurora = fx.aurora.clone().with_msa_endpoints(msa_endpoints(&server));
        let mut account = stale_microsoft();
        account.name = LONG_NAME.to_owned();
        let stored = aurora.store_account_for_test(account).unwrap();
        let java = complete_fake_java(&fx.root, 17, 3);
        let request = || LaunchRequest {
            version_id: NEW_VERSION.to_owned(),
            ..stored_request(stored.clone())
        };

        let (result, _) = launch_request(&aurora, request(), java.clone()).await;
        assert_eq!(expect_failure(result).code, FailureCode::AccountServiceDown);

        let (result, events) = launch_fallback(&aurora, request(), java).await;
        let run = expect_run(result);
        assert!(run.offline());
        let mut stage = None;
        let mut warns = Vec::new();
        for event in &events {
            match event {
                LaunchEvent::Stage(s) => stage = Some(s.index()),
                LaunchEvent::Log {
                    level: LauncherLevel::Warn,
                    text,
                    ..
                } => warns.push((stage, text.clone())),
                _ => {}
            }
        }
        assert_eq!(
            warns,
            vec![
                (
                    Some(0),
                    format!("以离线方式进单人：{LONG_NAME} 这一局不经账户验证，只能玩单人游戏")
                ),
                (
                    Some(0),
                    format!(
                        "角色名 {LONG_NAME} 有 21 个字符，Minecraft 1.20.3 及更新的版本只认 16 个以内，进入存档或服务器时会被拒绝"
                    )
                ),
            ]
        );

        let finished = run.finish().await;
        assert!(finished.problems.is_empty(), "{:?}", finished.problems);
        let crash = aurora
            .last_crash(NEW_VERSION)
            .await
            .unwrap()
            .expect("崩溃应落盘");
        assert_eq!(crash.warnings, vec![LaunchWarning::LongPlayerName]);
        assert_eq!(crash.exit_code, Some(3));
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn renamed_vanilla_instance_judges_a_long_player_name_by_its_client_version() {
        // 改过名的原版实例没有 inheritsFrom，继承链根就是它自己，id 是玩家起的名字；游戏版本号只记在
        // clientVersion 里。拿实例名去比 1.20.3 永远比不出结果，超长名的提醒就漏了。
        const LONG_NAME: &str = "PetalPlayerLongName01";
        let server = wiremock::MockServer::start().await;
        mount_token(&server, outage_page()).await;
        let fx = fixture();
        let java = complete_fake_java(&fx.root, 17, 3);
        let aurora = fx.aurora.clone().with_msa_endpoints(msa_endpoints(&server));
        let mut account = stale_microsoft();
        account.name = LONG_NAME.to_owned();
        let stored = aurora.store_account_for_test(account).unwrap();

        let mut warned = Vec::new();
        for (renamed, client_version) in [("生存 服", "1.21.1"), ("老 存档", "1.20.2")] {
            let dir = fx.root.join(".minecraft").join("versions").join(renamed);
            std::fs::create_dir_all(&dir).unwrap();
            std::fs::write(
                dir.join(format!("{renamed}.json")),
                format!(
                    r#"{{"id":"{renamed}","clientVersion":"{client_version}","type":"release","mainClass":"net.minecraft.client.main.Main","javaVersion":{{"component":"java-runtime-gamma","majorVersion":17}}}}"#
                ),
            )
            .unwrap();
            std::fs::write(dir.join(format!("{renamed}.jar")), b"jar").unwrap();
            let request = || LaunchRequest {
                version_id: renamed.to_owned(),
                ..stored_request(stored.clone())
            };
            let (result, _) = launch_request(&aurora, request(), java.clone()).await;
            assert_eq!(expect_failure(result).code, FailureCode::AccountServiceDown);
            let (result, events) = launch_fallback(&aurora, request(), java.clone()).await;
            let run = expect_run(result);
            let long_name_warns = events
                .iter()
                .filter(|event| {
                    matches!(event, LaunchEvent::Log { level: LauncherLevel::Warn, text, .. } if text.starts_with("角色名 "))
                })
                .count();
            run.finish().await;
            let crash = aurora
                .last_crash(renamed)
                .await
                .unwrap()
                .expect("崩溃应落盘");
            warned.push((
                renamed,
                long_name_warns,
                crash.warnings.contains(&LaunchWarning::LongPlayerName),
            ));
        }
        assert_eq!(warned, vec![("生存 服", 1, true), ("老 存档", 0, false)]);
    }

    /// 新建实例的版本 JSON 把 id 换成实例名、去掉了 inheritsFrom，继承链根就是实例自己。Java 失败的文案要写
    /// 「Minecraft 1.21.1 需要 Java 21」，拿实例名去填就成了「Minecraft 生存 服 需要 Java 21」。
    #[tokio::test]
    async fn java_failures_name_the_game_version_not_the_instance() {
        let fx = fixture();
        let renamed = "生存 服";
        let dir = fx.root.join(".minecraft").join("versions").join(renamed);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join(format!("{renamed}.json")),
            format!(
                r#"{{"id":"{renamed}","clientVersion":"1.21.1","type":"release","mainClass":"net.minecraft.client.main.Main","javaVersion":{{"component":"java-runtime-delta","majorVersion":21}}}}"#
            ),
        )
        .unwrap();
        let request = || LaunchRequest {
            version_id: renamed.to_owned(),
            ..request()
        };

        let java = fake_java(&fx.root, 17, 0);
        let (result, _) = launch_request(&fx.aurora, request(), java).await;
        let failure = expect_failure(result);
        assert_eq!(failure.code, FailureCode::JavaTooOld);
        assert_eq!(
            failure.params.get("mc_version"),
            Some(&Value::from("1.21.1"))
        );
        assert_eq!(
            failure.message,
            "实例指定的 Java 17 无法运行 Minecraft 1.21.1，至少需要 Java 21"
        );
    }

    /// 进程起不来时会话日志不能跟着丢：写缓冲里攒着这次启动的全部阶段，而日志页正是玩家排查 spawn_failed 的地方。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn spawn_failure_keeps_a_finished_session_log() {
        let fx = fixture();
        let mc = fx.root.join(".minecraft");
        install_version(&mc, 17, true);
        // 命令行超过 Windows 的长度上限：Java 探测照常通过，到拉起进程这一步才被系统拒绝。
        aurora_instance::VersionSettingsStore::for_version_dir(
            &mc.join(VERSIONS_DIR).join(VERSION),
        )
        .save(&VersionSettings {
            jvm_args: format!("-Dpadding={}", "x".repeat(40_000)),
            ..VersionSettings::default()
        })
        .await
        .unwrap();

        let (result, events) = launch(&fx.aurora, fake_java(&fx.root, 17, 0)).await;
        let failure = expect_failure(result);
        assert_eq!(failure.code, FailureCode::SpawnFailed);
        assert_eq!(stage_indices(&events), vec![0, 1, 2, 3, 4, 5, 6]);

        let log = fx.aurora.last_launch_log(VERSION).await.unwrap().unwrap();
        assert_eq!(log.ended.map(|e| e.outcome), Some(SessionOutcome::Failed));
        let lines: Vec<(Option<LauncherLevel>, &str)> = log
            .lines
            .iter()
            .map(|l| (l.level, l.text.as_str()))
            .collect();
        assert!(
            lines.contains(&(Some(LauncherLevel::Info), LaunchStage::SpawnProcess.label())),
            "{lines:?}"
        );
        let last = lines.last().expect("日志里应有这次启动的记录");
        assert_eq!(last.0, Some(LauncherLevel::Error));
        assert!(last.1.starts_with("启动失败：无法启动 "), "{}", last.1);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn verified_launch_clears_the_recorded_failure() {
        let down = wiremock::MockServer::start().await;
        mount_token(&down, outage_page()).await;
        let fx = fixture();
        install_version(&fx.root.join(".minecraft"), 17, true);
        let java = fake_java(&fx.root, 17, 0);
        let (aurora, stored) = with_stale_account(&fx, &down);
        let (result, _) =
            launch_request(&aurora, stored_request(stored.clone()), java.clone()).await;
        assert_eq!(expect_failure(result).code, FailureCode::AccountServiceDown);

        // 服务恢复：普通启动续期成功并跑起来，清掉记下的失败。
        let up = wiremock::MockServer::start().await;
        mount_chain(
            &up,
            wiremock::ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "access_token": "MC-TOKEN",
                "expires_in": 86400
            })),
        )
        .await;
        let recovered = aurora.clone().with_msa_endpoints(msa_endpoints(&up));
        let (result, _) =
            launch_request(&recovered, stored_request(stored.clone()), java.clone()).await;
        let run = expect_run(result);
        assert!(!run.offline());
        run.finish().await;
        assert!(failures_of(&aurora).is_empty());

        let (result, _) = launch_fallback(&aurora, stored_request(stored), java).await;
        assert_eq!(
            refusal(result),
            (MS_NAME.to_owned(), OfflineFallbackRefusal::NoRecentFailure)
        );
    }

    #[test]
    fn refresh_failures_split_into_relogin_outage_and_network() {
        let outage = CoreError::Auth(aurora_auth::AuthError::ServiceUnavailable {
            step: "刷新令牌",
            status: 503,
        });
        let LaunchFailed::Failure(failure) = classify_refresh(outage, MS_NAME) else {
            panic!("服务故障应是可处理的启动失败");
        };
        assert_eq!(failure.code, FailureCode::AccountServiceDown);
        assert_eq!(failure.params.get("account"), Some(&Value::from(MS_NAME)));
        assert_eq!(failure.params.get("status"), Some(&Value::from(503u64)));
        assert!(failure.message.contains(MS_NAME), "{}", failure.message);
        assert!(failure.message.contains("HTTP 503"), "{}", failure.message);
        assert!(failure.source.is_some());

        let relogin = CoreError::Auth(aurora_auth::AuthError::ReloginRequired);
        let LaunchFailed::Failure(failure) = classify_refresh(relogin, MS_NAME) else {
            panic!("凭据被判失效应是可处理的启动失败");
        };
        assert_eq!(failure.code, FailureCode::AccountRelogin);
        assert_eq!(failure.params.get("account"), Some(&Value::from(MS_NAME)));
        assert_eq!(failure.params.get("status"), None);

        // 重新登录解决不了的账户错误原样报出，不冒充凭据失效。
        for terminal in [
            aurora_auth::AuthError::AppNotApproved,
            aurora_auth::AuthError::MinecraftProfileNotFound,
        ] {
            let name = format!("{terminal:?}");
            let failed = classify_refresh(CoreError::Auth(terminal), MS_NAME);
            assert!(
                matches!(failed, LaunchFailed::Core(CoreError::Auth(_))),
                "{name} 不该提示重新登录：{failed:?}"
            );
        }

        // 非账户错误原样冒泡，不冒充账户失败。
        let other = classify_refresh(CoreError::NoJava { major: 17 }, MS_NAME);
        assert!(
            matches!(other, LaunchFailed::Core(CoreError::NoJava { major: 17 })),
            "{other:?}"
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn refresh_outage_fails_as_service_down_and_leaves_the_account_alone() {
        let server = wiremock::MockServer::start().await;
        mount_token(&server, outage_page()).await;
        let fx = fixture();
        install_version(&fx.root.join(".minecraft"), 17, true);
        let (aurora, stored) = with_stale_account(&fx, &server);

        let (result, events) = launch_request(
            &aurora,
            stored_request(stored.clone()),
            fake_java(&fx.root, 17, 0),
        )
        .await;
        let failure = expect_failure(result);
        assert_eq!(failure.code, FailureCode::AccountServiceDown);
        assert_eq!(failure.params.get("status"), Some(&Value::from(503u64)));
        assert_eq!(failure.params.get("account"), Some(&Value::from(MS_NAME)));
        // 停在阶段 0：账户不可用就不往下走。
        assert_eq!(stage_indices(&events), vec![0]);
        // 服务故障值得按退避重试：默认策略的每一次机会都打到了令牌端点。
        assert_eq!(
            server.received_requests().await.unwrap().len(),
            aurora_base::retry::RetryPolicy::default().max_attempts as usize
        );

        // 账户还在、状态正常、凭据一个字没动。
        let after = aurora
            .find_account(MS_UUID)
            .unwrap()
            .expect("账户应仍在库中");
        assert_eq!(after.status, aurora_auth::AccountStatus::Ok);
        assert_eq!(after, stored);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn invalid_grant_fails_as_relogin_and_marks_the_account_expired() {
        let server = wiremock::MockServer::start().await;
        mount_token(&server, invalid_grant()).await;
        let fx = fixture();
        install_version(&fx.root.join(".minecraft"), 17, true);
        let (aurora, stored) = with_stale_account(&fx, &server);

        let (result, _) = launch_request(
            &aurora,
            stored_request(stored.clone()),
            fake_java(&fx.root, 17, 0),
        )
        .await;
        let failure = expect_failure(result);
        assert_eq!(failure.code, FailureCode::AccountRelogin);
        assert_eq!(failure.params.get("account"), Some(&Value::from(MS_NAME)));
        // 凭据失效不重试。
        assert_eq!(server.received_requests().await.unwrap().len(), 1);

        let after = aurora
            .find_account(MS_UUID)
            .unwrap()
            .expect("账户应仍在库中");
        assert_eq!(after.status, aurora_auth::AccountStatus::Expired);
        assert_eq!(after.credentials, stored.credentials);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn cancelling_while_refreshing_is_a_cancel_and_keeps_the_last_account_failure() {
        // 续期还在等服务端回应（服务故障时还要退避重试）就被玩家取消：这不是凭据被判失效，不能报成需要
        // 重新登录，也不能盖掉上一次的服务故障记录，否则紧接着的以离线方式进单人会被错拒。
        const CANCEL_UUID: &str = "c0ffee00c0ffee00c0ffee00c0ffee00";
        let server = wiremock::MockServer::start().await;
        mount_token(&server, outage_page()).await;
        let fx = fixture();
        install_version(&fx.root.join(".minecraft"), 17, true);
        let java = fake_java(&fx.root, 17, 0);
        let (aurora, stored) = with_stale_account_as(&fx, &server, CANCEL_UUID);
        let (result, _) =
            launch_request(&aurora, stored_request(stored.clone()), java.clone()).await;
        assert_eq!(expect_failure(result).code, FailureCode::AccountServiceDown);

        server.reset().await;
        mount_token(
            &server,
            wiremock::ResponseTemplate::new(503).set_delay(std::time::Duration::from_secs(30)),
        )
        .await;
        let token = CancellationToken::new();
        let cancelling = aurora.clone().with_cancel(token.clone());
        // 等续期请求真的发出才取消：定时取消在满载时会赶在请求之前，测的就不是「等回音时被取消」了。
        let cancel_once_sent = async {
            tokio::time::timeout(std::time::Duration::from_secs(15), async {
                while server.received_requests().await.unwrap().is_empty() {
                    tokio::time::sleep(std::time::Duration::from_millis(10)).await;
                }
            })
            .await
            .expect("续期请求应已发出");
            token.cancel();
        };
        let (_, (result, events)) = tokio::join!(
            cancel_once_sent,
            launch_request(&cancelling, stored_request(stored.clone()), java.clone())
        );
        match result {
            Err(err) => assert!(err.is_cancelled(), "{err:?}"),
            Ok(_) => panic!("取消后不应拉起进程"),
        }
        assert_eq!(stage_indices(&events), vec![0]);
        assert_eq!(server.received_requests().await.unwrap().len(), 1);
        assert_eq!(
            failures_of(&aurora).get(CANCEL_UUID),
            Some(&FailureCode::AccountServiceDown)
        );
        let log = fx.aurora.last_launch_log(VERSION).await.unwrap().unwrap();
        assert_eq!(
            log.ended.map(|e| e.outcome),
            Some(SessionOutcome::Cancelled)
        );
        assert_eq!(aurora.find_account(CANCEL_UUID).unwrap().unwrap(), stored);

        // 记录完好：降级照常放行。
        let (result, _) = launch_fallback(&aurora, stored_request(stored), java).await;
        let run = expect_run(result);
        assert!(run.offline());
        run.finish().await;
    }

    fn singleplayer(world: &str) -> QuickPlay {
        QuickPlay::Singleplayer {
            world_dir_name: world.to_owned(),
        }
    }

    fn launcher_lines(events: &[LaunchEvent]) -> Vec<String> {
        events
            .iter()
            .filter_map(|event| match event {
                LaunchEvent::Log { text, .. } => Some(text.clone()),
                _ => None,
            })
            .collect()
    }

    /// 旧版要直达存档：在校验游戏文件阶段就失败，存档在不在都不看，也不会走到补全与下载。
    #[tokio::test]
    async fn legacy_singleplayer_fails_while_verifying_files_before_any_download() {
        let fx = fixture();
        let mc = fx.root.join(".minecraft");
        install_json(&mc, "1.12.2", &legacy_json("1.12.2"));
        let java = fake_java(&fx.root, 17, 0);

        let (result, events) = launch_request(
            &fx.aurora,
            quick_request("1.12.2", singleplayer("New World")),
            java,
        )
        .await;
        match result {
            Err(LaunchFailed::Core(CoreError::Launch(
                aurora_launch::LaunchError::QuickPlayUnsupported { version, mode },
            ))) => {
                assert_eq!(version, "1.12.2");
                assert_eq!(mode, QuickPlayMode::Singleplayer);
            }
            other => panic!("应报不支持直达存档，实际：{:?}", other.err()),
        }
        assert_eq!(stage_indices(&events), vec![0, 1]);
        assert!(
            !events.iter().any(|e| matches!(e, LaunchEvent::Download(_))),
            "不该推出下载进度：{events:?}"
        );
        let log = fx.aurora.last_launch_log("1.12.2").await.unwrap().unwrap();
        assert_eq!(log.ended.map(|e| e.outcome), Some(SessionOutcome::Failed));
    }

    #[tokio::test]
    async fn missing_or_unsafe_world_is_world_not_found_with_the_given_name() {
        let fx = fixture();
        let mc = fx.root.join(".minecraft");
        install_json(&mc, VERSION, &quick_play_json(VERSION));
        // 同名的是文件不是文件夹：也不是存档。
        std::fs::create_dir_all(mc.join("saves")).unwrap();
        std::fs::write(mc.join("saves").join("只是文件"), b"x").unwrap();
        let java = fake_java(&fx.root, 17, 0);

        for world in ["New World", "../New World", "只是文件", ""] {
            let (result, events) = launch_request(
                &fx.aurora,
                quick_request(VERSION, singleplayer(world)),
                java.clone(),
            )
            .await;
            match result {
                Err(LaunchFailed::Core(CoreError::WorldNotFound {
                    version_id,
                    world: got,
                })) => {
                    assert_eq!(version_id, VERSION);
                    assert_eq!(got, world);
                }
                other => panic!("{world:?} 应报存档不存在，实际：{:?}", other.err()),
            }
            assert_eq!(stage_indices(&events), vec![0, 1], "{world:?}");
        }
    }

    /// 名字过不了系统代码页时停在校验阶段：起进程只会停在游戏里那句世界标识符无效，玩家不知道为什么。
    /// 系统代码页是 UTF-8 的机器上什么字符都到得了，这条无从验证。
    #[cfg(windows)]
    #[tokio::test]
    async fn world_name_outside_the_system_code_page_is_refused_before_the_game_starts() {
        const WORLD: &str = "𠮷野の里";
        let Some(lost) = aurora_launch::quick_play_lost_char(WORLD) else {
            return;
        };
        let fx = fixture();
        let mc = fx.root.join(".minecraft");
        install_json(&mc, VERSION, &quick_play_json(VERSION));
        std::fs::create_dir_all(mc.join("saves").join(WORLD)).unwrap();
        let java = fake_java(&fx.root, 17, 0);

        let (result, events) = launch_request(
            &fx.aurora,
            quick_request(VERSION, singleplayer(WORLD)),
            java,
        )
        .await;

        match result {
            Err(LaunchFailed::Core(CoreError::WorldNameUnencodable {
                version_id,
                world,
                ch,
            })) => {
                assert_eq!(version_id, VERSION);
                assert_eq!(world, WORLD);
                assert_eq!(ch, lost);
            }
            other => panic!("应报存档名带不过去，实际：{:?}", other.err()),
        }
        assert_eq!(stage_indices(&events), vec![0, 1]);
    }

    #[tokio::test]
    async fn invalid_server_address_fails_while_verifying_files() {
        let fx = fixture();
        install_json(
            &fx.root.join(".minecraft"),
            VERSION,
            &quick_play_json(VERSION),
        );
        let java = fake_java(&fx.root, 17, 0);
        let (result, events) = launch_request(
            &fx.aurora,
            quick_request(
                VERSION,
                QuickPlay::Multiplayer {
                    address: "mc.example.com:0".to_owned(),
                },
            ),
            java,
        )
        .await;
        assert!(
            matches!(&result, Err(LaunchFailed::Core(CoreError::InvalidServerAddress { address, .. })) if address == "mc.example.com:0"),
            "{:?}",
            result.as_ref().err()
        );
        assert_eq!(stage_indices(&events), vec![0, 1]);
    }

    /// 存档在的时候照常走完八个阶段，启动日志写明直达了哪个存档。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn quick_play_into_an_existing_world_reaches_running() {
        let fx = fixture();
        let mc = fx.root.join(".minecraft");
        install_json(&mc, VERSION, &quick_play_json(VERSION));
        std::fs::create_dir_all(mc.join("saves").join("New World")).unwrap();
        let java = fake_java(&fx.root, 17, 0);

        let (result, events) = launch_request(
            &fx.aurora,
            quick_request(VERSION, singleplayer("New World")),
            java.clone(),
        )
        .await;
        let run = match result {
            Ok(run) => run,
            Err(err) => panic!("启动应成功：{err:?}"),
        };
        assert_eq!(stage_indices(&events), vec![0, 1, 2, 3, 4, 5, 6, 7]);
        assert!(
            launcher_lines(&events).contains(&"直接进入存档「New World」".to_owned()),
            "{:?}",
            launcher_lines(&events)
        );
        run.finish().await;

        let (result, events) = launch_request(
            &fx.aurora,
            quick_request(
                VERSION,
                QuickPlay::Multiplayer {
                    address: " mc.example.com:25570 ".to_owned(),
                },
            ),
            java,
        )
        .await;
        let run = match result {
            Ok(run) => run,
            Err(err) => panic!("启动应成功：{err:?}"),
        };
        assert!(
            launcher_lines(&events).contains(&"直接加入服务器 mc.example.com:25570".to_owned()),
            "{:?}",
            launcher_lines(&events)
        );
        run.finish().await;
    }

    fn assembled(
        merged: &VersionJson,
        quick_play: Option<QuickPlayTarget>,
    ) -> Result<LaunchCommand, LaunchFailed> {
        let root = PathBuf::from(r"D:\mc\.minecraft");
        assemble_command(
            merged,
            &RuntimeContext::new(aurora_version::OsName::Windows, "x86_64", 64),
            Path::new(r"C:\jdk\bin\java.exe"),
            GamePaths::standard(&root, &merged.id),
            &root,
            AuthValues::offline("Steve", "0123456789abcdef0123456789abcdef"),
            &merged.id,
            "9.9.9",
            MemoryConfig::fixed(2048),
            &InstanceLaunchSettings::default(),
            None,
            quick_play,
        )
    }

    fn tail(args: &[String], n: usize) -> Vec<&str> {
        args[args.len() - n..].iter().map(String::as_str).collect()
    }

    /// 预检得出的目标原样进命令行：新版走 Quick Play、地址不补端口；旧版换算成 --server/--port，
    /// 没写端口时显式写 25565，IPv6 不带方括号。
    #[tokio::test]
    async fn checked_targets_reach_the_command_line() {
        let tmp = tempfile::tempdir().unwrap();
        let modern = VersionJson::from_json_str(&quick_play_json(VERSION)).unwrap();
        let legacy = VersionJson::from_json_str(&legacy_json("1.12.2")).unwrap();
        let multiplayer = |address: &str| QuickPlay::Multiplayer {
            address: address.to_owned(),
        };

        let bare = quick_play_target(
            VERSION,
            &modern,
            tmp.path(),
            multiplayer(" play.example.com "),
        )
        .await
        .unwrap();
        assert_eq!(
            bare,
            QuickPlayTarget::Multiplayer {
                address: "play.example.com".to_owned(),
                host: "play.example.com".to_owned(),
                port: 25565,
            }
        );
        let args = assembled(&modern, Some(bare)).unwrap().args;
        assert_eq!(
            tail(&args, 2),
            vec!["--quickPlayMultiplayer", "play.example.com"]
        );
        assert!(
            !args
                .iter()
                .any(|a| a == "--server" || a == "--quickPlayPath")
        );

        let default_port =
            quick_play_target("1.12.2", &legacy, tmp.path(), multiplayer("mc.example.com"))
                .await
                .unwrap();
        let args = assembled(&legacy, Some(default_port)).unwrap().args;
        assert_eq!(
            tail(&args, 4),
            vec!["--server", "mc.example.com", "--port", "25565"]
        );

        let ipv6 = quick_play_target(
            "1.12.2",
            &legacy,
            tmp.path(),
            multiplayer("[2001:db8::1]:25570"),
        )
        .await
        .unwrap();
        let args = assembled(&legacy, Some(ipv6)).unwrap().args;
        assert_eq!(
            tail(&args, 4),
            vec!["--server", "2001:db8::1", "--port", "25570"]
        );

        // 不带直达时命令行里没有任何直达参数。
        let plain = assembled(&modern, None).unwrap().args;
        assert!(
            !plain
                .iter()
                .any(|a| a.starts_with("--quickPlay") || a.contains("${quickPlay"))
        );
    }

    /// 拼命令时才发现不支持（调用方没预检）也照原样报不支持，不并进 version_broken。
    #[test]
    fn unsupported_target_at_assembly_is_not_version_broken() {
        let legacy = VersionJson::from_json_str(&legacy_json("1.12.2")).unwrap();
        let result = assembled(
            &legacy,
            Some(QuickPlayTarget::Singleplayer {
                world_dir_name: "New World".to_owned(),
            }),
        );
        assert!(
            matches!(
                &result,
                Err(LaunchFailed::Core(CoreError::Launch(
                    aurora_launch::LaunchError::QuickPlayUnsupported { version, mode: QuickPlayMode::Singleplayer }
                ))) if version == "1.12.2"
            ),
            "{:?}",
            result.as_ref().err()
        );
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
            auto: false,
        };
        let both = resolve_memory(None, global, None);
        assert_eq!((both.max_mb, both.min_mb), (4096, Some(1024)));
        let instance = resolve_memory(Some(6144), global, None);
        assert_eq!((instance.max_mb, instance.min_mb), (6144, Some(1024)));
        // 实例最大堆比全局最小堆还小：带上 -Xms 会让 JVM 拒绝启动。
        let small = resolve_memory(Some(768), global, None);
        assert_eq!((small.max_mb, small.min_mb), (768, None));
        let edge = resolve_memory(Some(1024), global, None);
        assert_eq!((edge.max_mb, edge.min_mb), (1024, Some(1024)));

        // 自动分配：没有实例覆盖时用此刻的推荐值，实例覆盖仍然优先。
        let auto = MemorySettings {
            auto: true,
            ..global
        };
        let recommended = resolve_memory(None, auto, Some(3584));
        assert_eq!((recommended.max_mb, recommended.min_mb), (3584, Some(1024)));
        let pinned = resolve_memory(Some(2048), auto, None);
        assert_eq!(pinned.max_mb, 2048);
        // 推荐值低于全局最小堆：-Xms 不带。
        let tight = resolve_memory(None, auto, Some(768));
        assert_eq!((tight.max_mb, tight.min_mb), (768, None));
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

    /// 一个真实的 reqwest 错误：地址解析失败，不联网。
    fn http_error() -> aurora_auth::AuthError {
        let source = reqwest::Client::new()
            .get("not a url")
            .build()
            .expect_err("非法地址应当构造失败");
        aurora_auth::AuthError::Http {
            context: "测试",
            source,
        }
    }

    #[test]
    fn only_rejected_credentials_ask_for_relogin_before_launch() {
        use aurora_auth::AuthError;
        let relogin = classify_refresh(CoreError::Auth(AuthError::ReloginRequired), "Steve");
        let LaunchFailed::Failure(failure) = relogin else {
            panic!("凭据被判失效应给出失败码：{relogin:?}");
        };
        assert_eq!(failure.code, FailureCode::AccountRelogin);
        assert_eq!(failure.params["account"], Value::from("Steve"));

        let network = classify_refresh(CoreError::Auth(http_error()), "Steve");
        let LaunchFailed::Failure(failure) = network else {
            panic!("连不上应给出失败码：{network:?}");
        };
        assert_eq!(failure.code, FailureCode::AccountRefreshNetwork);

        // 重新登录也解决不了的失败按门面错误原样报出，错误码与原文由命令层照常映射。
        for err in [
            AuthError::XstsBanned,
            AuthError::MinecraftProfileNotFound,
            AuthError::Response {
                context: "XBL 认证",
                detail: "HTTP 503".into(),
            },
            AuthError::Dpapi {
                operation: "解密",
                message: "拒绝访问".into(),
            },
            AuthError::AccountNotFound("0000".into()),
        ] {
            let name = format!("{err:?}");
            let failed = classify_refresh(CoreError::Auth(err), "Steve");
            assert!(
                matches!(failed, LaunchFailed::Core(CoreError::Auth(_))),
                "{name} 不该提示重新登录：{failed:?}"
            );
        }

        let cancelled = classify_refresh(CoreError::Auth(AuthError::Cancelled), "Steve");
        assert!(cancelled.is_cancelled(), "取消应原样认得出：{cancelled:?}");
    }

    #[test]
    fn unreadable_auth_server_metadata_does_not_ask_for_relogin() {
        const SERVER: &str = "https://skin.example/api/yggdrasil";
        let network = authlib_metadata_failure(http_error(), SERVER, "Steve");
        let LaunchFailed::Failure(failure) = network else {
            panic!("连不上验证服务器应给出失败码：{network:?}");
        };
        assert_eq!(failure.code, FailureCode::AccountRefreshNetwork);
        assert_eq!(failure.params["server"], Value::from(SERVER));

        let not_yggdrasil = authlib_metadata_failure(
            aurora_auth::AuthError::NotYggdrasilServer {
                url: SERVER.into(),
                detail: "API 根地址返回 HTTP 502 Bad Gateway".into(),
            },
            SERVER,
            "Steve",
        );
        assert!(
            matches!(
                not_yggdrasil,
                LaunchFailed::Core(CoreError::Auth(
                    aurora_auth::AuthError::NotYggdrasilServer { .. }
                ))
            ),
            "服务器回错页不该提示重新登录：{not_yggdrasil:?}"
        );

        // 服务故障和续期时一样归到登录服务故障：账户是好的，玩家可以稍后重试或先以离线方式进单人。
        let outage = authlib_metadata_failure(
            aurora_auth::AuthError::ServiceUnavailable {
                step: "读取验证服务器信息",
                status: 503,
            },
            SERVER,
            "Steve",
        );
        let LaunchFailed::Failure(failure) = outage else {
            panic!("验证服务器服务故障应给出失败码：{outage:?}");
        };
        assert_eq!(failure.code, FailureCode::AccountServiceDown);
        assert_eq!(failure.params["account"], Value::from("Steve"));
        assert_eq!(failure.params["status"], Value::from(503u64));
        assert_eq!(failure.params["server"], Value::from(SERVER));
    }

    /// 查最新构建与预取元数据这两次联网都不挂下载池的令牌，线路黑洞时要等连接超时才回来。对端这里一直
    /// 不回，取消后还能立刻以取消返回，才说明两处都接上了令牌。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn cancelling_while_preparing_authlib_returns_without_waiting_for_the_network() {
        use wiremock::matchers::{method, path};
        let stalled =
            wiremock::ResponseTemplate::new(503).set_delay(std::time::Duration::from_secs(60));

        for stall_latest in [true, false] {
            let server = wiremock::MockServer::start().await;
            wiremock::Mock::given(method("GET"))
                .and(path("/latest"))
                .respond_with(if stall_latest {
                    stalled.clone()
                } else {
                    wiremock::ResponseTemplate::new(404)
                })
                .mount(&server)
                .await;
            wiremock::Mock::given(method("GET"))
                .and(path("/yggdrasil"))
                .respond_with(stalled.clone())
                .mount(&server)
                .await;
            let fx = fixture();
            // 查不到最新构建时沿用这一份，流程才走得到预取元数据。
            let dir = crate::authlib::agent_dir(&fx.root);
            std::fs::create_dir_all(&dir).unwrap();
            std::fs::write(crate::authlib::agent_jar(&dir, 1), b"agent").unwrap();

            let token = CancellationToken::new();
            let aurora = fx
                .aurora
                .clone()
                .with_authlib_latest_url(format!("{}/latest", server.uri()))
                .with_cancel(token.clone());
            let (tx, _rx) = mpsc::unbounded_channel();
            let mut reporter = Reporter {
                events: &tx,
                clock: SessionClock::start().unwrap(),
                log: None,
            };
            let api_root = format!("{}/yggdrasil", server.uri());
            let cancel_once_stuck = async {
                let stuck_on = if stall_latest {
                    "/latest"
                } else {
                    "/yggdrasil"
                };
                while !server
                    .received_requests()
                    .await
                    .unwrap()
                    .iter()
                    .any(|request| request.url.path() == stuck_on)
                {
                    tokio::time::sleep(std::time::Duration::from_millis(10)).await;
                }
                token.cancel();
            };
            let (_, result) = tokio::time::timeout(std::time::Duration::from_secs(15), async {
                tokio::join!(
                    cancel_once_stuck,
                    aurora.prepare_authlib(&api_root, "Steve", &mut reporter)
                )
            })
            .await
            .unwrap_or_else(|_| panic!("取消没有打断等待（stall_latest={stall_latest}）"));
            match result {
                Err(err) => assert!(err.is_cancelled(), "{err:?}"),
                Ok(_) => panic!("取消后不该拿到 agent"),
            }
        }
    }

    #[test]
    fn instance_jvm_args_keep_quoted_values_in_one_argument() {
        let settings = InstanceLaunchSettings::from_settings(VersionSettings {
            jvm_args:
                r#"-javaagent:"C:\Program Files\agent\agent.jar" -Dfoo="a b" -Dempty="" -Xss4m"#
                    .into(),
            ..VersionSettings::default()
        });
        assert_eq!(
            settings.jvm_args,
            vec![
                r"-javaagent:C:\Program Files\agent\agent.jar".to_owned(),
                "-Dfoo=a b".to_owned(),
                "-Dempty=".to_owned(),
                "-Xss4m".to_owned(),
            ]
        );
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

        let finished = run.finish().await;
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

    #[test]
    fn launch_warning_codes_keep_their_wire_names() {
        let all = [
            LaunchWarning::GamePath,
            LaunchWarning::OnedriveFolder,
            LaunchWarning::IcloudFolder,
            LaunchWarning::LongPlayerName,
            LaunchWarning::JvmMemoryUnit,
            LaunchWarning::JvmMinOverMax,
            LaunchWarning::JvmMaxTooLow,
        ];
        let json = serde_json::to_value(all).unwrap();
        assert_eq!(
            json,
            serde_json::json!([
                "game_path",
                "onedrive_folder",
                "icloud_folder",
                "long_player_name",
                "jvm_memory_unit",
                "jvm_min_over_max",
                "jvm_max_too_low"
            ])
        );
        let back: Vec<LaunchWarning> = serde_json::from_value(json).unwrap();
        assert_eq!(back, all);
    }

    #[test]
    fn memory_issues_map_to_their_warning_and_log_text() {
        assert_eq!(
            memory_warning(aurora_launch::JvmMemoryIssue::BadUnit {
                arg: "-Xmx4GB".into()
            }),
            (
                LaunchWarning::JvmMemoryUnit,
                "自定义 JVM 参数 -Xmx4GB 的写法 Java 不认，内存单位只能是 k、m、g、t，例如 -Xmx4g"
                    .to_owned()
            )
        );
        assert_eq!(
            memory_warning(aurora_launch::JvmMemoryIssue::MinOverMax {
                min_mb: 4096,
                max_mb: 2048
            }),
            (
                LaunchWarning::JvmMinOverMax,
                "自定义 JVM 参数让最小内存（4096 MB）大于最大内存（2048 MB），Java 会拒绝启动"
                    .to_owned()
            )
        );
        assert_eq!(
            memory_warning(aurora_launch::JvmMemoryIssue::MaxTooLow { max_mb: 256 }),
            (
                LaunchWarning::JvmMaxTooLow,
                "最大内存只有 256 MB，低于 512 MB，游戏多半进不了主界面".to_owned()
            )
        );
    }

    /// 自定义 -Xmx 排在内存设置之后，这一局真正的上限是它：诊断要解释内存耗尽，记内存设置就是在说一个没用上的数。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn crash_report_records_the_max_heap_that_actually_applied() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().to_path_buf();
        let config = AuroraConfig {
            memory: MemorySettings {
                auto: false,
                ..MemorySettings::default()
            },
            ..AuroraConfig::default()
        };
        let aurora = Aurora::for_test(config, root.clone(), root.join(".minecraft"));
        install_version(&root.join(".minecraft"), 17, true);
        aurora_instance::VersionSettingsStore::for_version_dir(
            &root.join(".minecraft").join(VERSIONS_DIR).join(VERSION),
        )
        .save(&VersionSettings {
            jvm_args: "-Xmx64M".into(),
            ..VersionSettings::default()
        })
        .await
        .unwrap();
        let java = complete_fake_java(&root, 17, 3);

        let (result, _) = launch(&aurora, java).await;
        let run = match result {
            Ok(run) => run,
            Err(err) => panic!("过小的 -Xmx 只提醒，不阻断启动：{err:?}"),
        };
        assert!(run.finish().await.exit.crashed);
        let crash = aurora
            .last_crash(VERSION)
            .await
            .unwrap()
            .expect("崩溃应落盘");
        assert_eq!(crash.max_memory_mb, Some(64));
        let log = aurora.last_launch_log(VERSION).await.unwrap().unwrap();
        assert!(
            log.lines.iter().any(|l| l.text.contains("最大内存 64 MB")),
            "{:?}",
            log.lines
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn sync_folder_and_bad_jvm_memory_are_warned_in_their_stages() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("OneDrive").join("games");
        std::fs::create_dir_all(&root).unwrap();
        let config = AuroraConfig {
            memory: MemorySettings {
                auto: false,
                ..MemorySettings::default()
            },
            ..AuroraConfig::default()
        };
        let aurora = Aurora::for_test(config, root.clone(), root.join(".minecraft"));
        install_version(&root.join(".minecraft"), 17, true);
        aurora_instance::VersionSettingsStore::for_version_dir(
            &root.join(".minecraft").join(VERSIONS_DIR).join(VERSION),
        )
        .save(&VersionSettings {
            jvm_args: "-XX:+UseG1GC -Xmx4GB".into(),
            ..VersionSettings::default()
        })
        .await
        .unwrap();
        let java = complete_fake_java(&root, 17, 3);

        let (result, events) = launch(&aurora, java).await;
        let run = match result {
            Ok(run) => run,
            Err(err) => panic!("提醒不阻断启动：{err:?}"),
        };
        // 每条提醒记下它出现在哪个阶段。
        let mut stage = None;
        let mut warns = Vec::new();
        for event in &events {
            match event {
                LaunchEvent::Stage(s) => stage = Some(s.index()),
                LaunchEvent::Log {
                    level: LauncherLevel::Warn,
                    text,
                    ..
                } => warns.push((stage, text.clone())),
                _ => {}
            }
        }
        assert_eq!(warns.len(), 2, "{warns:?}");
        assert_eq!(warns[0].0, Some(1));
        assert!(
            warns[0]
                .1
                .starts_with("游戏目录在 OneDrive 同步的文件夹里（")
                && warns[0].1.ends_with("建议换一个不在 OneDrive 里的游戏目录"),
            "{}",
            warns[0].1
        );
        assert_eq!(
            warns[1],
            (
                Some(5),
                "自定义 JVM 参数 -Xmx4GB 的写法 Java 不认，内存单位只能是 k、m、g、t，例如 -Xmx4g"
                    .to_owned()
            )
        );

        let finished = run.finish().await;
        assert!(finished.problems.is_empty(), "{:?}", finished.problems);
        let crash = aurora
            .last_crash(VERSION)
            .await
            .unwrap()
            .expect("崩溃应落盘");
        assert_eq!(
            crash.warnings,
            vec![LaunchWarning::OnedriveFolder, LaunchWarning::JvmMemoryUnit]
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
        assert_eq!(
            failure.params.get("pinned_by"),
            Some(&Value::from("instance"))
        );
        assert!(
            failure.message.starts_with("实例指定的 Java 不可用："),
            "{}",
            failure.message
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
        assert_eq!(
            failure.params.get("pinned_by"),
            Some(&Value::from("instance"))
        );
    }

    #[tokio::test]
    async fn global_default_java_is_used_as_a_pinned_java() {
        let mut fx = fixture();
        install_version(&fx.root.join(".minecraft"), 21, true);
        let old = fake_java(&fx.root, 17, 0);
        fx.aurora.set_default_java(Some(old.clone()));

        // 实例没有指定 Java：全局固定的 Java 17 被当作指定的 Java，版本不够时报出来，
        // 而不是悄悄换成自动挑选的另一个。
        let (tx, mut rx) = mpsc::unbounded_channel();
        let result = fx.aurora.launch(request(), &tx).await;
        drop(tx);
        while rx.recv().await.is_some() {}
        let failure = expect_failure(result);
        assert_eq!(failure.code, FailureCode::JavaTooOld);
        assert_eq!(failure.params.get("current"), Some(&Value::from(17)));
        assert_eq!(failure.params.get("major"), Some(&Value::from(21)));
        // 固定在全局：把实例改回自动选择不会有任何变化，界面要据此改指设置里的默认 Java。
        assert_eq!(
            failure.params.get("pinned_by"),
            Some(&Value::from("global"))
        );
        assert_eq!(
            failure.message,
            format!("设置里固定的默认 Java 17 无法运行 Minecraft {VERSION}，至少需要 Java 21")
        );

        let missing = fx.root.join("gone").join("java.exe");
        fx.aurora.set_default_java(Some(missing.clone()));
        let (tx, mut rx) = mpsc::unbounded_channel();
        let result = fx.aurora.launch(request(), &tx).await;
        drop(tx);
        while rx.recv().await.is_some() {}
        let failure = expect_failure(result);
        assert_eq!(failure.code, FailureCode::JavaPinnedMissing);
        assert_eq!(
            failure.params.get("path"),
            Some(&Value::from(missing.display().to_string()))
        );
        assert_eq!(
            failure.params.get("pinned_by"),
            Some(&Value::from("global"))
        );
        assert!(
            failure
                .message
                .starts_with("设置里固定的默认 Java 不可用："),
            "{}",
            failure.message
        );
    }

    fn log_texts(events: &[LaunchEvent], want: LauncherLevel) -> Vec<String> {
        events
            .iter()
            .filter_map(|event| match event {
                LaunchEvent::Log { level, text, .. } if *level == want => Some(text.clone()),
                _ => None,
            })
            .collect()
    }

    /// 按给定开关、换上替身写入器启动一次，断言启动成功并等游戏退出，返回推出的事件。
    async fn launch_preferring_gpu(
        fx: &Fixture,
        store: Arc<crate::gpu::testing::MemoryGpuPreferences>,
        enabled: bool,
        java: PathBuf,
    ) -> Vec<LaunchEvent> {
        let mut aurora = fx.aurora.clone().with_gpu_preference_store(store);
        aurora.set_prefer_dedicated_gpu(enabled);
        let (result, events) = launch(&aurora, java).await;
        match result {
            Ok(run) => {
                run.finish().await;
            }
            Err(err) => panic!("启动应成功：{err:?}"),
        }
        assert_eq!(stage_indices(&events), vec![0, 1, 2, 3, 4, 5, 6, 7]);
        events
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn gpu_preference_is_left_alone_when_the_switch_is_off() {
        let fx = fixture();
        install_version(&fx.root.join(".minecraft"), 17, true);
        let java = fake_java(&fx.root, 17, 0);
        let store = Arc::new(crate::gpu::testing::MemoryGpuPreferences::default());

        let events = launch_preferring_gpu(&fx, store.clone(), false, java).await;
        assert!(store.writes().is_empty(), "开关关着不该写显卡偏好");
        assert!(
            !events
                .iter()
                .any(|e| matches!(e, LaunchEvent::Log { text, .. } if text.contains("显卡"))),
            "开关关着不该提到显卡"
        );
    }

    /// 写的正是这次拉起的那个 java，取值是高性能；已有的别的片段保留。写在拉起进程之前。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn gpu_preference_is_written_for_the_launched_java_before_spawn() {
        let fx = fixture();
        install_version(&fx.root.join(".minecraft"), 17, true);
        let java = fake_java(&fx.root, 17, 0);

        let fresh = Arc::new(crate::gpu::testing::MemoryGpuPreferences::default());
        let events = launch_preferring_gpu(&fx, fresh.clone(), true, java.clone()).await;
        assert_eq!(
            fresh.writes(),
            vec![(java.clone(), "GpuPreference=2;".to_owned())]
        );
        let notice = format!(
            "已在 Windows 图形设置里让 {} 使用高性能显卡",
            java.display()
        );
        let notice_at = events
            .iter()
            .position(|e| matches!(e, LaunchEvent::Log { text, .. } if *text == notice))
            .expect("应在启动日志里说明写了显卡偏好");
        let spawn_at = events
            .iter()
            .position(|e| matches!(e, LaunchEvent::Stage(LaunchStage::SpawnProcess)))
            .unwrap();
        assert!(notice_at < spawn_at, "显卡偏好要在拉起进程之前写好");

        let existing = Arc::new(crate::gpu::testing::MemoryGpuPreferences::with_value(
            &java,
            "AppStatus=0;",
        ));
        launch_preferring_gpu(&fx, existing.clone(), true, java.clone()).await;
        assert_eq!(
            existing.writes(),
            vec![(java.clone(), "AppStatus=0;GpuPreference=2;".to_owned())]
        );

        // 已经是高性能：不写也不提示。
        let events = launch_preferring_gpu(&fx, existing.clone(), true, java).await;
        assert_eq!(existing.writes().len(), 1);
        assert!(!log_texts(&events, LauncherLevel::Info).contains(&notice));
    }

    /// 指定的 Java 缺运行时文件：照常启动，启动日志里提醒一句；补齐之后不再提醒。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn incomplete_pinned_java_warns_but_still_launches() {
        let fx = fixture();
        install_version(&fx.root.join(".minecraft"), 17, true);
        let home = fx.root.join("half-jdk");
        std::fs::create_dir_all(home.join("bin")).unwrap();
        let java = fake_java(&home.join("bin"), 17, 0);
        let store = Arc::new(crate::gpu::testing::MemoryGpuPreferences::default());
        let reminder = "指定的 Java 缺少 release、lib/modules，可能没装完整，启动失败时换一个 Java";

        let events = launch_preferring_gpu(&fx, store.clone(), false, java.clone()).await;
        assert!(
            log_texts(&events, LauncherLevel::Warn).contains(&reminder.to_owned()),
            "{:?}",
            log_texts(&events, LauncherLevel::Warn)
        );

        std::fs::write(home.join("release"), b"JAVA_VERSION=\"17.0.8\"").unwrap();
        std::fs::create_dir_all(home.join("lib")).unwrap();
        std::fs::write(home.join("lib").join("modules"), b"image").unwrap();
        let events = launch_preferring_gpu(&fx, store, false, java).await;
        assert!(
            !log_texts(&events, LauncherLevel::Warn)
                .iter()
                .any(|text| text.contains("可能没装完整")),
            "{:?}",
            log_texts(&events, LauncherLevel::Warn)
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn gpu_preference_failure_warns_and_still_launches() {
        let fx = fixture();
        install_version(&fx.root.join(".minecraft"), 17, true);
        let java = fake_java(&fx.root, 17, 0);
        let store = Arc::new(crate::gpu::testing::MemoryGpuPreferences::failing());

        let events = launch_preferring_gpu(&fx, store.clone(), true, java).await;
        assert!(store.writes().is_empty());
        assert!(
            log_texts(&events, LauncherLevel::Warn).contains(
                &"没能写入显卡偏好（拒绝访问），这次按 Windows 默认的显卡启动".to_owned()
            ),
            "{:?}",
            log_texts(&events, LauncherLevel::Warn)
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

    /// 加载器安装器自带的库（版本 JSON 里地址留空）被删掉后启动：报只能重装加载器，不把空地址交给下载池
    /// 去报地址解析失败。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_deleted_bundled_loader_library_stops_launch_with_loader_library_missing() {
        let fx = fixture();
        let mc = fx.root.join(".minecraft");
        install_version(&mc, 17, true);
        let json = serde_json::json!({
            "id": VERSION,
            "type": "release",
            "mainClass": "cpw.mods.modlauncher.Launcher",
            "javaVersion": {"component": "java-runtime-gamma", "majorVersion": 17},
            "libraries": [{
                "name": "net.minecraftforge:forge:1.20.1-47.2.0:universal",
                "downloads": {"artifact": {
                    "path": "net/minecraftforge/forge/1.20.1-47.2.0/forge-1.20.1-47.2.0-universal.jar",
                    "url": "", "sha1": "0".repeat(40), "size": 4
                }}
            }]
        });
        let dir = mc.join("versions").join(VERSION);
        std::fs::write(dir.join(format!("{VERSION}.json")), json.to_string()).unwrap();
        let java = fake_java(&fx.root, 17, 0);

        let (result, _) = launch(&fx.aurora, java).await;

        let expected = mc
            .join("libraries")
            .join("net/minecraftforge/forge/1.20.1-47.2.0/forge-1.20.1-47.2.0-universal.jar");
        match result {
            Err(LaunchFailed::Core(CoreError::Install(
                aurora_install::Error::LoaderLibraryMissing { path },
            ))) => assert_eq!(path, expected),
            other => panic!("应报加载器自带的库缺失：{:?}", other.err()),
        }
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
            (FailureCode::AccountServiceDown, "account_service_down"),
            (FailureCode::FilesOffline, "files_offline"),
            (FailureCode::FilesFailed, "files_failed"),
            (FailureCode::DiskFull, "disk_full"),
            (FailureCode::VersionBroken, "version_broken"),
            (FailureCode::PathUnsupported, "path_unsupported"),
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

    /// 拉 Java 运行时清单失败：HTTP 层错误（不论直接还是压在逐源回退的聚合错误下面）判离线，
    /// 内容读不懂判文件失败。
    #[tokio::test]
    async fn java_manifest_failures_are_classified_by_http_cause() {
        let all_sources_failed = |last: aurora_java::Error| aurora_java::Error::AllSourcesFailed {
            context: "Java 运行时总清单",
            attempts: vec![
                "https://piston-meta.mojang.com/all.json：HTTP 请求失败".to_owned(),
                format!("https://bmclapi2.bangbang93.com/all.json：{last}"),
            ],
            last: Box::new(last),
        };

        let http = aurora_base::http::build_client().unwrap();
        let unreachable = || async {
            aurora_java::Error::Http {
                url: "::not-a-url".into(),
                source: http.get("::not-a-url").send().await.unwrap_err(),
            }
        };
        let code_of = |failed: LaunchFailed| match failed {
            LaunchFailed::Failure(failure) => failure.code,
            LaunchFailed::Core(err) => panic!("应归为可处理的失败，实际：{err:?}"),
        };

        assert_eq!(
            code_of(java_download_failure(17, unreachable().await)),
            FailureCode::FilesOffline
        );
        let garbled = aurora_java::Error::Json {
            context: "all.json".into(),
            source: serde_json::from_str::<serde_json::Value>("<html>").unwrap_err(),
        };
        assert_eq!(
            code_of(java_download_failure(17, garbled)),
            FailureCode::FilesFailed
        );
        // 两个源都没取到：最后一个源连不上仍判离线，最后一个源回的是读不懂的内容判文件失败。
        assert_eq!(
            code_of(java_download_failure(
                17,
                all_sources_failed(unreachable().await)
            )),
            FailureCode::FilesOffline
        );
        let garbled = aurora_java::Error::Json {
            context: "all.json".into(),
            source: serde_json::from_str::<serde_json::Value>("<html>").unwrap_err(),
        };
        assert_eq!(
            code_of(java_download_failure(17, all_sources_failed(garbled))),
            FailureCode::FilesFailed
        );
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

    /// 本地 mock 的一套两文件运行时清单；返回清单地址与各文件内容（java 本体放在第一个）。
    async fn mount_runtime(server: &wiremock::MockServer) -> (String, Vec<Vec<u8>>) {
        use sha1::{Digest, Sha1};
        use wiremock::matchers::{method, path};
        use wiremock::{Mock, ResponseTemplate};

        let base = server.uri();
        let hex = |bytes: &[u8]| -> String {
            Sha1::digest(bytes)
                .iter()
                .map(|b| format!("{b:02x}"))
                .collect()
        };
        let files = vec![
            b"MZ-not-really-java".to_vec(),
            b"modules image body".to_vec(),
        ];
        let component = format!(
            r#"{{"files":{{
                "bin":{{"type":"directory"}},
                "lib":{{"type":"directory"}},
                "bin/{exe}":{{"type":"file","executable":true,"downloads":{{"raw":{{"sha1":"{s0}","size":{n0},"url":"{base}/objects/java"}}}}}},
                "lib/modules":{{"type":"file","executable":false,"downloads":{{"raw":{{"sha1":"{s1}","size":{n1},"url":"{base}/objects/modules"}}}}}}
            }}}}"#,
            exe = aurora_java::JAVA_EXE,
            s0 = hex(&files[0]),
            n0 = files[0].len(),
            s1 = hex(&files[1]),
            n1 = files[1].len(),
        );
        let all = format!(
            r#"{{"{platform}":{{"java-runtime-gamma":[{{"manifest":{{"sha1":"{sha}","url":"{base}/gamma.json"}},"version":{{"name":"17.0.8"}}}}]}}}}"#,
            platform = aurora_java::current_platform(),
            sha = hex(component.as_bytes()),
        );
        for (route, body) in [
            ("/all.json", all.into_bytes()),
            ("/gamma.json", component.into_bytes()),
            ("/objects/java", files[0].clone()),
            ("/objects/modules", files[1].clone()),
        ] {
            Mock::given(method("GET"))
                .and(path(route))
                .respond_with(ResponseTemplate::new(200).set_body_bytes(body))
                .mount(server)
                .await;
        }
        (format!("{base}/all.json"), files)
    }

    /// 启动时缺 Java 自动下载走下载池：阶段 3 推出带总数与总字节的进度，文件落进托管目录。冒充的
    /// 运行时跑不起来，于是停在「刚下载的 Java 无法运行」——证明文件确实已经全部下完。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn auto_java_download_runs_through_the_pool_and_reports_progress() {
        let server = wiremock::MockServer::start().await;
        let (manifest, files) = mount_runtime(&server).await;
        let fx = fixture();
        let (tx, mut rx) = mpsc::unbounded_channel();
        let mut reporter = Reporter {
            events: &tx,
            clock: SessionClock::start().unwrap(),
            log: None,
        };

        let result = fx.aurora.download_java(17, &manifest, &mut reporter).await;
        drop(reporter);
        drop(tx);

        let failure = match result {
            Err(LaunchFailed::Failure(failure)) => *failure,
            other => panic!("冒充的运行时应在探测时失败：{other:?}"),
        };
        assert_eq!(failure.code, FailureCode::FilesFailed);
        assert!(failure.message.contains("无法运行"), "{}", failure.message);
        let home = crate::java::runtime_install_dir(&fx.root, 17);
        assert_eq!(
            std::fs::read(aurora_java::java_exe_in_home(&home)).unwrap(),
            files[0]
        );
        assert_eq!(
            std::fs::read(home.join("lib").join("modules")).unwrap(),
            files[1]
        );

        let mut progress = Vec::new();
        while let Some(event) = rx.recv().await {
            if let LaunchEvent::Download(snapshot) = event {
                progress.push(snapshot);
            }
        }
        let last = progress.last().expect("自动下载 Java 应推出下载进度");
        assert_eq!((last.total, last.finished), (2, 2));
        assert_eq!(
            last.total_bytes,
            Some(files.iter().map(|f| f.len() as u64).sum())
        );
    }
}
