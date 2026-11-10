//! 启动器自更新：检查、下载、安装，以及「退出时安装」。
//!
//! 走 Rust 侧命令而不是让前端直接调插件：安装包要按「文件下载源」策略在清单列出的几个源之间排先后、
//! 一个源失败换下一个，插件的 JS 接口只会从清单的 `url` 下载；清单端点也按版本号决定，不写在 tauri.conf.json 里。
//!
//! 清单的平台条目除了插件认的 `url` 与 `signature`，另带 `x-sources`（候选源）与 `x-size`（包大小）两个扩展键，
//! 插件和旧客户端都不认、照常忽略，解析与换源的判定见 [`super::update_sources`]。换源只改下载地址，
//! 验签和签名版本校验仍由插件按清单的 `signature` 与 `version` 做，扩展键里的东西不参与校验。
//! 真去下载的地址都要过 https 与主机白名单：x-sources 每条和回退地址（插件选中的 `url`）都只比主机不比路径，
//! 白名单主机回的跳转照跟、但只跟到 https 地址（[`plugin_client`]），完整性靠插件验签。
//!
//! 插件只在配置了签名公钥、并要求签名带版本号（`requireSignedVersion: true`）的发行构建里注册
//! （[`detect_support`]）。没有公钥时插件初始化本身就会失败，而且没有公钥就无从校验更新包，宁可整体不支持。
//! 清单本身不签名，签名只盖住安装包：不要求签名带版本号，伪造的清单就能给旧版本的合法包配上更高的版本号，
//! 诱导降级（CVE-2026-95625），所以没打开这一项同样整体不支持。`allowDowngrades` 会把插件的版本比较从
//! 「比当前新」放宽成「与当前不同」，伪造的清单照实写上旧版本号、指向旧版本的合法包，签名版本也对得上，
//! 同样防不住降级，打开了也整体不支持。版本号的预发布标识认不出通道（[`Channel::of`]）时不知道该去哪取清单，
//! 也整体不支持。不支持时各命令报 `updater_unsupported`。
//! 仓库里的配置两项都不带，dev、beta 分支的 CI 打包时才分别写入开发版公钥（`.github/dev-updater.pub`）、
//! 发布公钥（`.github/release-updater.pub`）并打开 `requireSignedVersion`，签名时用 `--app-version` 把版本号写进
//! 可信注释：本地和 fork 构建的包不会去认落樱的更新。
//!
//! 去哪取清单由版本号决定（[`Channel`]），与前端从版本号推发布通道同源，不另设配置。

use std::future::Future;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, MutexGuard};
use std::time::{Duration, Instant};

use petalfall_base::http::NetworkFailure;
use petalfall_core::release::order::{compare_versions, Channel};
use petalfall_core::{CancellationToken, CoreEvent, DownloadProgress, EventSink, PackageCandidate};
use semver::Version;
use serde::{Serialize, Serializer};
use serde_json::{json, Map, Value};
use tauri::{AppHandle, Manager, State, Url};
use tauri_plugin_updater::{RemoteRelease, Update, Updater, UpdaterBuilder, UpdaterExt};
use tokio::sync::Notify;

use crate::commands::error::{code, source_chain, CommandError};
use crate::commands::update_channels::channel_pubkey;
use crate::commands::update_slot::{
    Candidate, CheckConclusion, ReleaseVersion, SlotError, UpdateSlot,
};
use crate::commands::update_sources::{
    judge, package_plan, sources_failed, AttemptError, PackagePlan, PackageSource, Verdict,
};
use crate::commands::update_stall::{StallGuard, STALL_MIN_BYTES, STALL_WINDOW};
use crate::events::CoreEventForwarder;
use crate::facade::Facade;
use crate::tasks::TaskRegistry;

/// 正式通道的清单地址，放在香港机上，是这个通道唯一的权威清单。
pub const PRIMARY_ENDPOINT: &str = concat!(
    "https://",
    petalfall_base::app_slug!(),
    ".org/updates/stable/latest.json"
);

/// 开发版通道的权威清单地址，放在香港机上。国内连 GitHub 常常不通，清单先从这里取；
/// CI 往这里和 [`dev_endpoint`] 发的是同一份文件，字节相同。
pub const DEV_ENDPOINT: &str = concat!(
    "https://",
    petalfall_base::app_slug!(),
    ".org/updates/dev/latest.json"
);

/// 测试版通道的清单地址，放在香港机上，是这个通道唯一的清单来源。不像开发版那样再排一份 GitHub 上的：
/// GitHub Release 能被 dev 的发布作业和 CLA 作业改写，不拿它当测试版的清单来源。
pub const BETA_ENDPOINT: &str = concat!(
    "https://",
    petalfall_base::app_slug!(),
    ".org/updates/beta/latest.json"
);

/// dev 分支每次构建都重建的滚动预发布，CI 里的 tag 必须与它一致。
const DEV_RELEASE_TAG: &str = "dev-build";

/// 开发版通道在 GitHub 滚动预发布上的那份清单。dev.35 及更早的客户端只认这一个地址，CI 照旧往这里发；
/// 新客户端把它排在 [`DEV_ENDPOINT`] 之后，香港机连不上时还能拿到清单。
pub fn dev_endpoint() -> String {
    format!(
        "{}/releases/download/{DEV_RELEASE_TAG}/latest.json",
        petalfall_base::brand::REPO_URL
    )
}

/// 这个通道的清单端点，按这个顺序逐个问（[`check_in_order`]）：前一个没给出清单就问下一个。顺序固定、不探测：
/// 清单只有几百字节，测速省不下时间，反倒多一轮请求。
fn channel_endpoints(channel: Channel) -> Vec<String> {
    match channel {
        Channel::Dev => vec![DEV_ENDPOINT.to_owned(), dev_endpoint()],
        Channel::Beta => vec![BETA_ENDPOINT.to_owned()],
        Channel::Stable => vec![PRIMARY_ENDPOINT.to_owned()],
    }
}

/// 单个端点取清单的时限。清单是一次性的小请求，比下载源探测放宽，慢网下也要能拿到。
const CHECK_TIMEOUT: Duration = Duration::from_secs(10);

/// 清单不存在时更新源回的状态码：这个源上还没有发布。
const MANIFEST_MISSING_STATUS: u16 = 404;

/// 下载进度推送的最小间隔，与下载池的采样间隔一致，前端进度条观感相同。
const PROGRESS_INTERVAL: Duration = Duration::from_millis(100);

/// 多久问一次下载有没有卡住。判定因此最多晚一秒，相对卡死检测的窗口可以忽略。
const STALL_CHECK_INTERVAL: Duration = Duration::from_secs(1);

/// 当前环境为什么没有自更新能力。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum UnsupportedReason {
    /// 开发构建：exe 不是安装程序装的，装更新会把正式版装到别处再退出当前开发会话。
    DebugBuild,
    /// tauri.conf.json 没有 `plugins.updater.pubkey`。
    MissingPubkey,
    /// tauri.conf.json 的 `plugins.updater` 没有把 `requireSignedVersion` 设为 true：签名不必带版本号，
    /// 伪造清单就能把旧版本的合法包配上更高的版本号，防不住降级。
    SignedVersionNotRequired,
    /// tauri.conf.json 的 `plugins.updater` 没有关掉 `allowDowngrades`：插件只要求清单版本与当前不同，
    /// 伪造清单指向旧版本的合法包也能装上。
    DowngradesAllowed,
    /// 版本号的预发布标识认不出是哪个通道（[`Channel::of`]），不知道该去哪里取清单。
    UnknownChannel,
    /// 注入的 `plugins.updater.pubkey` 不是钥表里本包通道的那一把（[`channel_pubkey`]）。检查器一律按钥表认
    /// 落樱的更新，不看注入的那一把：fork 换了自己的钥却没换仓库里的 `.pub` 文件时，它会去认落樱的包、
    /// 把自己换掉，所以两者对不上就整体不支持。
    PubkeyMismatch,
}

impl UnsupportedReason {
    /// 各命令报的 `updater_unsupported`，`detail.reason` 是这个原因。
    fn error(self) -> CommandError {
        CommandError::new(code::UPDATER_UNSUPPORTED, self.message())
            .with_detail(json!({ "reason": self }))
    }

    fn message(self) -> &'static str {
        match self {
            UnsupportedReason::DebugBuild => "开发构建不支持自更新",
            UnsupportedReason::MissingPubkey => {
                "没有配置更新签名公钥，无法校验更新包，自更新已停用"
            }
            UnsupportedReason::SignedVersionNotRequired => {
                "没有要求更新包的签名带版本号，防不住被诱导降级到旧版本，自更新已停用"
            }
            UnsupportedReason::DowngradesAllowed => {
                "更新配置允许装不比当前新的版本，防不住被诱导降级到旧版本，自更新已停用"
            }
            UnsupportedReason::UnknownChannel => {
                "这个版本号不属于任何更新通道，不知道该去哪里检查更新，自更新已停用"
            }
            UnsupportedReason::PubkeyMismatch => {
                "配置的更新签名公钥不是这个版本所属通道的那一把，自更新已停用"
            }
        }
    }
}

/// 自更新是否可用。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UpdaterSupport {
    Supported,
    Unsupported(UnsupportedReason),
}

/// 插件配置里 `requireSignedVersion` 认的两种键名：插件按 camelCase 反序列化，另设了 kebab-case 别名。
const REQUIRE_SIGNED_VERSION_KEYS: [&str; 2] = ["requireSignedVersion", "require-signed-version"];

/// 插件配置里 `allowDowngrades` 认的两种键名，规则与 [`REQUIRE_SIGNED_VERSION_KEYS`] 相同。
const ALLOW_DOWNGRADES_KEYS: [&str; 2] = ["allowDowngrades", "allow-downgrades"];

/// 配置里写了的那几种键名各自的值。
fn values_of<'a>(updater_config: Option<&'a Value>, keys: [&str; 2]) -> Vec<&'a Value> {
    keys.iter()
        .filter_map(|key| updater_config.and_then(|config| config.get(key)))
        .collect()
}

/// 由构建类型、版本号的预发布标识 `pre_release` 与 tauri.conf.json 的 `plugins.updater` 判定是否支持自更新，
/// 决定插件注册与否。
pub fn detect_support(
    updater_config: Option<&Value>,
    debug_build: bool,
    pre_release: &str,
) -> UpdaterSupport {
    if debug_build {
        return UpdaterSupport::Unsupported(UnsupportedReason::DebugBuild);
    }
    let Some(channel) = Channel::of(pre_release) else {
        return UpdaterSupport::Unsupported(UnsupportedReason::UnknownChannel);
    };
    // CI 注入前 trim 过，钥表给的也是去掉首尾空白的；这里同样去掉，只比内容。
    let pubkey = updater_config
        .and_then(|config| config.get("pubkey"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|key| !key.is_empty());
    let Some(pubkey) = pubkey else {
        return UpdaterSupport::Unsupported(UnsupportedReason::MissingPubkey);
    };
    if pubkey != channel_pubkey(channel) {
        return UpdaterSupport::Unsupported(UnsupportedReason::PubkeyMismatch);
    }
    // 两种键名同时出现、或值不是布尔，插件反序列化配置就会失败、整个应用起不来，也按没打开处理，不注册插件。
    let required = values_of(updater_config, REQUIRE_SIGNED_VERSION_KEYS);
    if !matches!(required.as_slice(), [flag] if flag.as_bool() == Some(true)) {
        return UpdaterSupport::Unsupported(UnsupportedReason::SignedVersionNotRequired);
    }
    // 插件的全局状态没设版本比较器，检查器自己也没设时，插件见到它打开就改用「与当前不同」比较。检查器都设了
    // 「严格新于」的比较器（[`check_checker`]），这一项仍必须关着，漏设比较器的检查器才不会退回去。两种键名
    // 同时出现或值不是布尔时，同样是插件拒收整份配置，不注册。
    let downgrades = values_of(updater_config, ALLOW_DOWNGRADES_KEYS);
    if matches!(downgrades.as_slice(), [] | [Value::Bool(false)]) {
        UpdaterSupport::Supported
    } else {
        UpdaterSupport::Unsupported(UnsupportedReason::DowngradesAllowed)
    }
}

/// 一个可用更新。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct UpdateDto {
    pub version: String,
    pub current_version: String,
    /// 更新说明（清单里的 `notes`）。
    pub notes: Option<String>,
    /// 发布时间，Unix 毫秒；清单没写时为 `null`。
    pub date: Option<i64>,
    /// 这一版取自哪个通道的清单。
    pub channel: Channel,
}

fn update_dto(update: &Update) -> UpdateDto {
    UpdateDto {
        version: update.version.clone(),
        current_version: update.current_version.clone(),
        notes: update.body.clone(),
        date: update
            .date
            .map(|date| date.unix_timestamp() * 1000 + i64::from(date.millisecond())),
        // 现在只问本包通道的清单，候选必然来自本包的通道；认不出通道的版本建不出检查器（[`version_endpoints`]），
        // 走不到这里。
        channel: package_channel(&update.current_version)
            .expect("候选只来自认得出通道的版本建的检查器"),
    }
}

/// 版本号 `version` 所属的发布通道，规则同 [`Channel::of`]；认不出时为 `None`。
///
/// `version` 只来自 `package_info` 的版本号（直接转成的字符串，或插件转成字符串后放进 `Update` 的），
/// 必然是合法的 semver。
fn package_channel(version: &str) -> Option<Channel> {
    let version = Version::parse(version).expect("版本号来自 package_info，必然是合法的 semver");
    Channel::of_version(&version)
}

/// 生效的通道偏好与本包通道之间的关系。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ChannelRelation {
    /// 偏好就是本包的通道。
    Same,
    /// 偏好比本包的通道慢：等那个通道追上本包的版本。
    Waiting,
    /// 偏好比本包的通道快，例如测试版用户跟随装上了正式版的包。
    Following,
}

/// 一个通道最近一次取清单的结果。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ChannelHeadState {
    /// 有端点给出了验过的清单头。
    Published,
    /// 所有端点都确认清单 404：这个通道还没有发布。
    NotPublished,
    /// 每个端点都给出了清单头，但全都旧于本机记下的这个通道的最高版本。
    Stale,
    /// 其余情况，含清单异常，以及有端点失败或 404、其余端点旧于本机记录的混合情形。
    Failed,
}

/// `channel_heads` 的一项。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ChannelHeadDto {
    pub channel: Channel,
    pub state: ChannelHeadState,
    /// 验过的清单头的版本，比当前版本新旧都有可能；没取到清单头时为 `null`。
    pub version: Option<String>,
    /// 清单里的发布时间（清单不签名，只作显示），Unix 毫秒；没有时为 `null`。
    pub date: Option<i64>,
}

/// 下载的用意：普通更新，或换到另一个通道。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum UpdateIntent {
    Update,
    Switch,
}

/// 一个版本在本次会话里为什么被拒。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum RefusalReason {
    /// 包认得的数据格式比正在运行的这一版旧，装上读不了现有数据。普通更新与换通道都会有。
    DataTooNew,
    /// 包认不得换通道安装，只随换通道出现。
    TargetUnsupported,
    /// 跟随别的通道时没能把偏好写进配置，只随普通更新出现。
    PreferenceUnsaved,
}

/// `refused` 的一项：本次会话里不再作为候选的版本。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct RefusedUpdateDto {
    pub version: String,
    pub channel: Channel,
    pub reason: RefusalReason,
    pub intent: UpdateIntent,
}

/// 设置页「关于与更新」要的全部状态；前端重载后据此恢复「有更新 / 已下载待安装」。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct UpdaterInfoDto {
    pub current_version: String,
    pub supported: bool,
    /// debug_build / missing_pubkey / signed_version_not_required / downgrades_allowed / unknown_channel /
    /// pubkey_mismatch；支持时为 `null`。
    pub unsupported_reason: Option<UnsupportedReason>,
    /// 本包的通道；版本号认不出通道时为 `null`。
    pub package_channel: Option<Channel>,
    /// 生效的通道偏好；`package_channel` 为 `null` 时也为 `null`。
    pub preference: Option<Channel>,
    /// `package_channel` 为 `null` 时也为 `null`。
    pub relation: Option<ChannelRelation>,
    /// 本次会话最近一次检查的结果；没检查过或已是最新时为 `null`。
    pub available: Option<UpdateDto>,
    /// 要看的每个通道最近一次取清单的结果；本次会话没取过清单时为空。
    pub channel_heads: Vec<ChannelHeadDto>,
    /// 本次会话里被拒的版本。
    pub refused: Vec<RefusedUpdateDto>,
    /// 已下载并通过签名校验、等待安装的版本。
    pub downloaded_version: Option<String>,
    /// 已下载的包所属的通道；没有时为 `null`。
    pub downloaded_channel: Option<Channel>,
    /// 已下载的包的用意；没有时为 `null`。
    pub downloaded_intent: Option<UpdateIntent>,
    pub install_on_exit: bool,
}

/// 自更新的 managed state。
pub struct UpdaterState {
    support: UpdaterSupport,
    slot: Mutex<UpdateSlot<Update>>,
}

impl UpdaterState {
    pub fn new(support: UpdaterSupport) -> Self {
        Self {
            support,
            slot: Mutex::new(UpdateSlot::default()),
        }
    }

    fn slot(&self) -> MutexGuard<'_, UpdateSlot<Update>> {
        // 临界区里只有字段赋值与同步的安装调用，真中毒说明程序已处于未知状态，直接崩。
        self.slot.lock().expect("更新状态的锁已中毒")
    }

    fn require_supported(&self) -> Result<(), CommandError> {
        match self.support {
            UpdaterSupport::Supported => Ok(()),
            UpdaterSupport::Unsupported(reason) => Err(reason.error()),
        }
    }

    fn info(&self, current_version: String) -> UpdaterInfoDto {
        let slot = self.slot();
        let (supported, unsupported_reason) = match self.support {
            UpdaterSupport::Supported => (true, None),
            UpdaterSupport::Unsupported(reason) => (false, Some(reason)),
        };
        // 偏好还没有地方存，生效的就是本包的通道；检查只问本包通道的清单、不按通道记结果，下载也只有普通更新一种，
        // 所以下好的包同样属于本包的通道。
        let package_channel = package_channel(&current_version);
        let downloaded_version = slot.downloaded_version();
        UpdaterInfoDto {
            current_version,
            supported,
            unsupported_reason,
            package_channel,
            preference: package_channel,
            relation: package_channel.map(|_| ChannelRelation::Same),
            available: slot
                .available
                .as_ref()
                .map(|candidate| update_dto(&candidate.update)),
            channel_heads: Vec::new(),
            refused: Vec::new(),
            downloaded_channel: downloaded_version.as_ref().and(package_channel),
            downloaded_intent: downloaded_version.as_ref().map(|_| UpdateIntent::Update),
            downloaded_version,
            install_on_exit: slot.install_on_exit,
        }
    }

    /// 拉起已下载更新包的安装程序。Windows 上成功即退出进程，不会返回；拉不起来（`ShellExecuteW` 失败）时
    /// 插件返回错误，但它在拉起之前已经跑过默认的 `on_before_exit`（tauri 的 `cleanup_before_exit`），
    /// 把所有窗口都藏了起来，见 [`install_after_persisting`]。
    fn install_downloaded(&self) -> Result<(), CommandError> {
        let slot = self.slot();
        let ready = slot.ready()?;
        tracing::info!(version = %ready.update.version, "开始安装更新");
        ready.update.install(&ready.bytes).map_err(|err| {
            updater_error(code::UPDATE_INSTALL_FAILED, "启动更新安装失败", None, err)
        })
    }
}

/// 槽位只说为什么拒绝，错误码与说法在这里定。
impl From<SlotError> for CommandError {
    fn from(err: SlotError) -> Self {
        match err {
            SlotError::Busy => {
                CommandError::new(code::UPDATE_BUSY, "已有更新包正在下载或安装，请等它结束")
            }
            SlotError::Superseded => CommandError::new(
                code::UPDATE_SUPERSEDED,
                "这期间更新通道改过，这次的结果已作废",
            ),
            SlotError::NoCandidate => {
                CommandError::new(code::UPDATE_NOT_AVAILABLE, "重新检查后已经没有可用更新")
            }
            SlotError::Outdated {
                downloading,
                latest,
            } => {
                let message = match latest {
                    Some(latest) => format!(
                        "下载期间检查到了更新的版本 {latest}，这次下载的 {downloading} 已作废，请重新下载"
                    ),
                    None => format!(
                        "下载期间再次检查时已没有可用更新，这次下载的 {downloading} 已作废"
                    ),
                };
                CommandError::new(code::UPDATE_NOT_AVAILABLE, message)
            }
            SlotError::NotReady => {
                CommandError::new(code::UPDATE_NOT_READY, "更新包还没有下载完成")
            }
        }
    }
}

/// 自更新状态。不支持时也能调，前端据 `supported` 决定是否显示更新入口。
#[tauri::command]
pub async fn updater_info(
    app: AppHandle,
    updater: State<'_, UpdaterState>,
) -> Result<UpdaterInfoDto, CommandError> {
    Ok(updater.info(app.package_info().version.to_string()))
}

/// 检查更新。端点见 [`channel_endpoints`]：开发版先问 [`DEV_ENDPOINT`] 再问 [`dev_endpoint`]，前一个没给出清单
/// （连不上、超时、非 2xx、正文读不出或不成形）就问下一个；测试版只问 [`BETA_ENDPOINT`]，
/// 正式版只问 [`PRIMARY_ENDPOINT`]。
/// 已是最新返回 `null`；所有端点的清单都确认 404 不算失败，见 [`check_in_order`] 与 [`UpdateSlot::settle_check`]。
/// 不看 `check_updates` 设置：那一项只管启动时要不要自动查，由前端决定。
#[tauri::command]
pub async fn check_update(
    app: AppHandle,
    updater: State<'_, UpdaterState>,
) -> Result<Option<UpdateDto>, CommandError> {
    updater.require_supported()?;
    let ticket = updater.slot().generation();
    let conclusion = fetch_conclusion(&app).await?;
    // 检查还只问本包通道的清单、不整理各通道的结果，`channel_heads` 照旧为空。
    let dto = updater
        .slot()
        .settle_check(ticket, Vec::new(), conclusion)?
        .map(|candidate| update_dto(&candidate.update));
    Ok(dto)
}

/// 取一次清单并下结论。检查和下载前的重查共用。
///
/// 每个端点各建一个只问它的检查器，由 [`check_in_order`] 逐个问，不把端点一次性交给插件：插件遇到 2xx 而正文
/// 读不出（不是 JSON、读到一半断开或撞上总时限）、或清单里没有本平台的条目时直接返回，不再问下一个端点；
/// 非 2xx 时只记一行不带地址与状态码的日志、不记成错误，最后报的是最后记下的那个错误。这样香港机的清单一坏，GitHub 上
/// 字节相同的那份就问不到，香港机回的状态码也进不了 detail。
async fn fetch_conclusion(app: &AppHandle) -> Result<CheckConclusion<Update>, CommandError> {
    let (channel, endpoints) = version_endpoints(app.package_info().version.pre.as_str())?;
    let checkers = endpoints
        .iter()
        .map(|endpoint| check_checker(app, channel, endpoint))
        .collect::<tauri_plugin_updater::Result<Vec<_>>>()
        .map_err(|err| check_failed(&endpoints, err))?;
    let version = app.package_info().version.to_string();
    check_in_order(&endpoints, &version, |index| checkers[index].check()).await
}

/// 预发布标识为 `pre_release` 的版本所属的通道与该问的清单端点。认不出通道时报 `updater_unsupported`：
/// [`detect_support`] 已把这种版本判为不支持、各命令先过 `require_supported`，走到这里说明两处判定对不上了，
/// 宁可报错也不拿哪个通道的清单顶上。
fn version_endpoints(pre_release: &str) -> Result<(Channel, Vec<String>), CommandError> {
    Channel::of(pre_release)
        .map(|channel| (channel, channel_endpoints(channel)))
        .ok_or_else(|| UnsupportedReason::UnknownChannel.error())
}

/// 只问通道 `channel` 的 `endpoint` 这一个端点的检查器构建器，这个 crate 构造检查器只从这里起步。
///
/// 显式用钥表里这个通道的公钥（[`channel_pubkey`]）：插件把它存进检查器的上下文，随 `Update` 带到下载后验签，
/// 不调的话沿用插件配置里注入的那一把，那一把只属于本包的通道。换源下载只改地址，不换钥。
fn channel_builder(
    app: &AppHandle,
    channel: Channel,
    endpoint: &str,
) -> tauri_plugin_updater::Result<UpdaterBuilder> {
    let http = petalfall_base::http::HttpConfig::default();
    let (connect, read) = (http.connect_timeout, http.read_timeout);
    Ok(app
        .updater_builder()
        .pubkey(channel_pubkey(channel))
        // 插件把这个回调放进上下文、随检查结果带进 Update，下载更新包也用它建客户端。插件自己的客户端一个超时
        // 都不设，终点不再送数据时下载会一直挂着；这里只补连接与读取超时，不设总时限：慢网下二十多兆的包要
        // 下好几分钟，总时限会把正常下载掐断。检查的总时限另由 CHECK_TIMEOUT 设。
        .configure_client(move |client| plugin_client(client, connect, read))
        .endpoints(endpoint_urls(&[endpoint.to_owned()]))?
        .timeout(CHECK_TIMEOUT))
}

/// 自动检查与下载前重查用的检查器：只为严格新于当前版本的清单造出更新（[`strictly_newer`]）。
/// requireSignedVersion 由插件配置带上。
fn check_checker(
    app: &AppHandle,
    channel: Channel,
    endpoint: &str,
) -> tauri_plugin_updater::Result<Updater> {
    channel_builder(app, channel, endpoint)?
        .version_comparator(|current, release| strictly_newer(&current, &release))
        .build()
}

/// 清单给的版本是否严格新于正在运行的版本 `current`，按 semver 优先级比，与挑候选时判「比当前新」用的是同一个
/// 比较（[`compare_versions`]）：只差构建元数据的两个版本算同一版，不造更新。
fn strictly_newer(current: &Version, release: &RemoteRelease) -> bool {
    compare_versions(&release.version, current).is_gt()
}

/// 插件 `configure_client` 回调收发的 reqwest 构建器。这一层不直接依赖 reqwest，从插件公开的回调类型里取出
/// 参数类型：版本永远是插件实际用的那一份，不会和插件错位。
type ClientBuilder =
    <<tauri_plugin_updater::OnBeforeRequest as std::ops::Deref>::Target as CallbackArg>::Arg;

/// 取出 `Fn(A) -> A` 回调的参数类型 `A`，只为 [`ClientBuilder`]。
trait CallbackArg {
    type Arg;
}

impl<A> CallbackArg for dyn Fn(A) -> A + Send + Sync {
    type Arg = A;
}

/// 给插件建的客户端套上连接与读取超时。读取超时在正文阶段是两次读到数据之间的最长静默，不限总时长；
/// 在响应头阶段（含跳转）同一个值却是从发请求起算、中途不重置的总期限，建连、TLS、跳转和等首字节都算在里面。
/// 时长由调用方给：线上用共享客户端的默认值，单测用短的读取超时验证卡住的下载会失败。
fn with_transfer_timeouts(
    client: ClientBuilder,
    connect: Duration,
    read: Duration,
) -> ClientBuilder {
    client.connect_timeout(connect).read_timeout(read)
}

/// 插件检查清单与下载更新包共用的客户端：传输超时见 [`with_transfer_timeouts`]，另外只走 https。插件的客户端
/// 沿用 reqwest 默认的跳转策略，清单端点或白名单下载源回一个指向 http 的跳转，后面的请求就成了明文：链路上的人
/// 看得到在下哪个版本，能替换包的字节，清单端点被跳过去时还能直接改写清单。`https_only` 让请求地址和跟的每一跳
/// 都必须是 https，不是的报错。不放进 [`with_transfer_timeouts`]：卡住下载的那条单测要连本地的 http 服务。
fn plugin_client(client: ClientBuilder, connect: Duration, read: Duration) -> ClientBuilder {
    with_transfer_timeouts(client, connect, read).https_only(true)
}

/// 按 `endpoints` 的先后逐个问清单，`check(i)` 问第 i 个端点。哪个端点给出了清单（有新版本或已是最新）就以它为准，
/// 后面的不再问；其余任何失败都记下、接着问下一个：连不上、超时、非 2xx、正文读不出或不成形、没有本平台的条目。
/// 一个端点都没给出清单时的结论见 [`conclude_without_manifest`]。
async fn check_in_order<U, Fut>(
    endpoints: &[String],
    app_version: &str,
    mut check: impl FnMut(usize) -> Fut,
) -> Result<CheckConclusion<U>, CommandError>
where
    U: ReleaseVersion,
    Fut: Future<Output = tauri_plugin_updater::Result<Option<U>>>,
{
    let mut misses = Vec::with_capacity(endpoints.len());
    for (index, endpoint) in endpoints.iter().enumerate() {
        let err = match check(index).await {
            Ok(found) => {
                match &found {
                    Some(update) => {
                        tracing::info!(endpoint, version = update.release_version(), "发现可用更新")
                    }
                    None => tracing::info!(endpoint, "已是最新版本"),
                }
                return Ok(match found {
                    // 现在只问本包通道的清单，候选必然来自本包的通道；认不出通道的版本建不出检查器
                    // （[`version_endpoints`]），走不到这里。
                    Some(update) => CheckConclusion::Found(Candidate {
                        update,
                        channel: package_channel(app_version)
                            .expect("候选只来自认得出通道的版本建的检查器"),
                    }),
                    None => CheckConclusion::UpToDate,
                });
            }
            Err(err) => err,
        };
        tracing::warn!(endpoint, error = %err, "清单端点没有给出清单");
        misses.push(match err {
            tauri_plugin_updater::Error::ReleaseNotFound => NoManifest::Unsuccessful(endpoint),
            other => NoManifest::Failed(EndpointFailure::plugin(endpoint, &other)),
        });
    }
    conclude_without_manifest(endpoints, app_version, misses).await
}

/// 一个端点为什么没给出清单。
enum NoManifest<'a> {
    /// 回了非 2xx。插件只报 `ReleaseNotFound`，不报状态码。
    Unsuccessful(&'a str),
    Failed(EndpointFailure),
}

/// 一个清单端点没给出清单的结果，按问的先后进 detail.attempts。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
struct EndpointFailure {
    endpoint: String,
    /// 回了非 2xx 时，再 GET 一次得到的状态码。
    #[serde(skip_serializing_if = "Option::is_none")]
    status: Option<u16>,
    /// 败在网络层时的种类，取值与 detail.network 相同。
    #[serde(
        skip_serializing_if = "Option::is_none",
        serialize_with = "network_code"
    )]
    network: Option<NetworkFailure>,
    message: String,
    /// 错误 source 链上的各层原文，没有就不写这个键。
    #[serde(skip_serializing_if = "Vec::is_empty")]
    causes: Vec<String>,
}

fn network_code<S: Serializer>(
    network: &Option<NetworkFailure>,
    serializer: S,
) -> Result<S::Ok, S::Error> {
    network.map(NetworkFailure::code).serialize(serializer)
}

impl EndpointFailure {
    fn plugin(endpoint: &str, err: &tauri_plugin_updater::Error) -> Self {
        EndpointFailure {
            endpoint: endpoint.to_owned(),
            status: None,
            network: plugin_network_failure(err),
            message: err.to_string(),
            causes: source_chain(err),
        }
    }

    fn status(endpoint: &str, status: u16) -> Self {
        let message = if status == MANIFEST_MISSING_STATUS {
            "更新服务器上没有这份清单"
        } else {
            "更新服务器返回了异常状态"
        };
        EndpointFailure {
            endpoint: endpoint.to_owned(),
            status: Some(status),
            network: None,
            message: message.to_owned(),
            causes: Vec::new(),
        }
    }

    /// 多个端点时 message 里的一行。状态码写法与前端给单个端点的 detail.status 补上的一样。
    fn line(&self) -> String {
        match self.status {
            Some(status) => format!("{}：{}（{status}）", self.endpoint, self.message),
            None => format!("{}：{}", self.endpoint, self.message),
        }
    }
}

/// 一个端点都没给出清单时的结论。回了非 2xx 的端点逐个再 GET 一次，问出状态码：全部端点都答 404 才算这个更新源上
/// 还没有发布；有一个答不出 404，就说不清那个源上有没有新版本，只能算检查失败。插件把 503、403 这类服务器故障也
/// 报成 `ReleaseNotFound`，不再问一次的话，服务器出故障时界面会显示已是最新。
async fn conclude_without_manifest<U>(
    endpoints: &[String],
    app_version: &str,
    misses: Vec<NoManifest<'_>>,
) -> Result<CheckConclusion<U>, CommandError> {
    assert!(!misses.is_empty(), "检查更新至少要问一个清单端点");
    let failures = probe_unsuccessful(app_version, misses).await?;
    if failures
        .iter()
        .all(|failure| failure.status == Some(MANIFEST_MISSING_STATUS))
    {
        // 界面上不算失败，日志要留痕。
        tracing::warn!(?endpoints, "更新源上没有清单（404），按没有新版本处理");
        return Ok(CheckConclusion::NotPublished);
    }
    Err(endpoints_failed(endpoints, failures))
}

/// 给回了非 2xx 的端点各 GET 一次问出状态码，与其余失败一起按问的先后排好。
async fn probe_unsuccessful(
    app_version: &str,
    misses: Vec<NoManifest<'_>>,
) -> Result<Vec<EndpointFailure>, CommandError> {
    let needs_probe = misses
        .iter()
        .any(|miss| matches!(miss, NoManifest::Unsuccessful(_)));
    let http = needs_probe
        .then(|| {
            petalfall_base::http::build_client_with(
                &petalfall_base::http::HttpConfig::for_app_version(app_version),
            )
        })
        .transpose()?;
    let mut failures = Vec::with_capacity(misses.len());
    for miss in misses {
        let failure = match miss {
            NoManifest::Failed(failure) => failure,
            NoManifest::Unsuccessful(endpoint) => {
                let probed = http
                    .as_ref()
                    .expect("有回了非 2xx 的端点时已建好客户端")
                    .get(endpoint)
                    .header("accept", "application/json")
                    .timeout(CHECK_TIMEOUT)
                    .send()
                    .await;
                match probed {
                    Ok(response) => EndpointFailure::status(endpoint, response.status().as_u16()),
                    Err(err) => EndpointFailure::plugin(
                        endpoint,
                        &tauri_plugin_updater::Error::Reqwest(err),
                    ),
                }
            }
        };
        failures.push(failure);
    }
    Ok(failures)
}

/// 所有端点都没给出清单、又不全是 404 时的检查失败。只问了一个端点时与逐端点检查之前的形状一致：message 是那个
/// 端点的原文，状态码在 detail.status，原因链在 detail.causes；多个端点时 message 逐行写成「端点：原文」，状态码与
/// 原因链各自留在 detail.attempts 里，顶层不放 status：前端会把它补在整段 message 的末尾，分不清是哪个端点的。
/// 全都败在网络层时标 detail.network，规则同下载源的汇总：全是超时为 timeout，混着连不上为 connect。
fn endpoints_failed(endpoints: &[String], failures: Vec<EndpointFailure>) -> CommandError {
    let message = match failures.as_slice() {
        [only] => only.message.clone(),
        many => many
            .iter()
            .map(EndpointFailure::line)
            .collect::<Vec<_>>()
            .join("\n"),
    };
    let mut detail = Map::new();
    detail.insert("endpoints".to_owned(), json!(endpoints));
    if let Some(network) = network_layer(&failures) {
        detail.insert("network".to_owned(), json!(network.code()));
    }
    if let [only] = failures.as_slice() {
        if let Some(status) = only.status {
            detail.insert("status".to_owned(), json!(status));
        }
        if !only.causes.is_empty() {
            detail.insert("causes".to_owned(), json!(only.causes));
        }
    }
    tracing::warn!(
        code = code::UPDATE_CHECK_FAILED,
        %message,
        attempts = ?failures,
        "没有一个清单端点给出清单，检查更新失败"
    );
    detail.insert("attempts".to_owned(), json!(failures));
    CommandError {
        code: code::UPDATE_CHECK_FAILED,
        message,
        detail: Some(Value::Object(detail)),
    }
}

/// 全部端点都败在网络层时是哪一种。
fn network_layer(failures: &[EndpointFailure]) -> Option<NetworkFailure> {
    let kinds = failures
        .iter()
        .map(|failure| failure.network)
        .collect::<Option<Vec<_>>>()?;
    Some(
        if kinds.iter().all(|kind| *kind == NetworkFailure::Timeout) {
            NetworkFailure::Timeout
        } else {
            NetworkFailure::Connect
        },
    )
}

fn check_failed(endpoints: &[String], err: tauri_plugin_updater::Error) -> CommandError {
    updater_error(
        code::UPDATE_CHECK_FAILED,
        "检查更新失败",
        Some(endpoints),
        err,
    )
}

/// 先按最新清单重查一次，再按「文件下载源」策略把清单列出的源排好（[`ordered_sources`]），逐个下载并校验签名，
/// 返回实际下载的版本（可能比界面上记着的新）。
/// 长任务：每个源开始前推一条 core-event `kind: "source"`，之后推下载进度（`kind: "download"`，`total` 恒为 1），
/// 都带 `task_id`；可经 `cancel_task(taskId)` 取消。一个源失败就换下一个，哪些失败换源、哪些立即停见
/// [`judge`]；全部失败时按 [`sources_failed`] 汇总，`detail.sources` 逐个列出已试的源。清单没给出可用候选、
/// 退回的插件选中地址又没过白名单时，一个源都不试，报 `update_download_failed`（见 [`package_plan`]）。下载期间
/// 再次检查换了版本或已无更新时报 `update_not_available`，包同样丢弃。正文开始后长时间没有进展（见 [`StallWatch`]）
/// 记为超时，下载的字节超过清单声明的大小记为 `too_large`，都换下一个源。
/// 重查、解析候选源与排序（自动档要探测）也都看取消：令牌一置位就丢下手头这一步，报 `cancelled`。
#[tauri::command]
pub async fn download_update(
    task_id: String,
    app: AppHandle,
    facade: State<'_, Facade>,
    updater: State<'_, UpdaterState>,
    tasks: State<'_, TaskRegistry>,
) -> Result<UpdateDto, CommandError> {
    updater.require_supported()?;
    let events = CoreEventForwarder::to_app(&app, Some(task_id.clone()));
    let outcome = async {
        let task = tasks.register(&task_id)?;
        let token = task.token();
        let ticket = updater.slot().generation();
        // 开发版的滚动预发布每次构建都删掉上一版安装包，检查时记下的地址过一阵就 404，重试也一样
        let conclusion = unless_cancelled(token, fetch_conclusion(&app)).await?;
        // 重查同检查，`channel_heads` 照旧为空。
        let candidate = updater
            .slot()
            .update_to_download(ticket, Vec::new(), conclusion)?;
        let update = &candidate.update;
        let plan = unless_cancelled(token, download_plan(&facade, update)).await?;
        let (bytes, source) = task
            .run(download_with_progress(
                update,
                &plan.sources,
                plan.size,
                events.sink(),
                token,
                || {
                    updater
                        .slot()
                        .ensure_current(&candidate)
                        .map_err(CommandError::from)
                },
            ))
            .await?;
        let dto = update_dto(update);
        tracing::info!(
            version = %update.version,
            source = %source.name,
            size = bytes.len(),
            "更新包下载并校验完成"
        );
        // 槽位里存的是清单原样的那份：安装只用字节，换源改过的下载地址留着没有用处。
        updater.slot().store_download(ticket, candidate, bytes)?;
        Ok(dto)
    }
    .await;
    events.finish().await;
    outcome
}

/// 跑下载前的一步。令牌已经置位就不开始；跑到一半置位就丢下它，报 `cancelled`。这几步都在 [`TaskHandle::run`]
/// 之外，不包这一层的话，取消要等它们自己结束：两个清单端点各等满 [`CHECK_TIMEOUT`]、再各问一次状态码，
/// 加上自动档的探测，用户点了取消，界面要停在下载中好几十秒。
///
/// [`TaskHandle::run`]: crate::tasks::TaskHandle::run
async fn unless_cancelled<T>(
    token: &CancellationToken,
    step: impl Future<Output = Result<T, CommandError>>,
) -> Result<T, CommandError> {
    match token.run_until_cancelled(step).await {
        Some(outcome) => outcome,
        None => Err(CommandError::cancelled()),
    }
}

/// 清单给出的候选源与大小上限（[`package_plan`]），候选源按「文件下载源」策略排好先后（[`ordered_sources`]）。
async fn download_plan(facade: &Facade, update: &Update) -> Result<PackagePlan, CommandError> {
    let plan = package_plan(&update.raw_json, &update.download_url, &update.signature)?;
    Ok(PackagePlan {
        sources: ordered_sources(facade, plan.sources).await,
        size: plan.size,
    })
}

/// 按「文件下载源」策略给清单列出的源排先后。排序在门面里做（自动档要探测），这里只在两边的类型之间来回转换。
async fn ordered_sources(facade: &Facade, sources: Vec<PackageSource>) -> Vec<PackageSource> {
    let candidates = sources
        .iter()
        .map(|source| PackageCandidate {
            name: source.name.clone(),
            url: source.url.to_string(),
            region: source.region,
        })
        .collect();
    let ordered = facade.snapshot().await.package_sources(candidates).await;
    let mut unordered = sources;
    ordered
        .into_iter()
        .map(|candidate| {
            // 源名在解析清单时已去过重，排序只换先后、不增删，按名字认得回原来那一条。
            let at = unordered
                .iter()
                .position(|source| source.name == candidate.name)
                .expect("门面排序只换先后，不会多出清单里没有的源");
            unordered.swap_remove(at)
        })
        .collect()
}

/// 立即安装已下载的更新。Windows 上拉起安装程序后进程退出，前端收不到返回；拉不起来时先把主窗口重新显示
/// 出来再报错。其它平台替换完文件后由这里重启。
#[tauri::command]
pub async fn install_update(
    app: AppHandle,
    updater: State<'_, UpdaterState>,
    facade: State<'_, Facade>,
) -> Result<(), CommandError> {
    updater.require_supported()?;
    install_after_persisting(
        &facade,
        || updater.install_downloaded(),
        reshow_after_failed_install(&app),
    )
    .await?;
    app.restart()
}

async fn reshow_after_failed_install(app: &AppHandle) {
    // 安装的错误才是要交给前端的那个，窗口没能显示只能记下来；此时用户多半看不到落樱，日志是唯一的线索。
    if let Err(err) = crate::window::reshow_main_window(app).await {
        tracing::error!(error = %err, "更新安装程序没拉起来，主窗口也没能重新显示");
    }
}

/// 先做退出收尾里的落盘（[`crate::exit::persist_before_exit`]：关闸并等进行中的外置令牌轮换、补写游玩记录）
/// 再安装：Windows 上更新插件拉起安装程序后直接结束进程，不经过 `RunEvent::Exit`，退出收尾赶不上。等不到或
/// 补写失败都只记日志、照样安装，与正常退出时一致。安装程序没拉起来时进程接着跑，重新开闸，外置令牌照常刷新。
///
/// 插件拉起安装程序之前已经把窗口藏了，没拉起来时不重新显示，用户就看不到报错、以为落樱自己退出了。
/// 所以失败时先等 `reshow` 跑完再返回错误；`reshow` 只在失败时才被 await，拉起成功时进程随即退出，不必显示。
pub(crate) async fn install_after_persisting(
    facade: &Facade,
    install: impl FnOnce() -> Result<(), CommandError>,
    reshow: impl Future<Output = ()>,
) -> Result<(), CommandError> {
    crate::exit::persist_before_exit(facade).await;
    let installed = install();
    if installed.is_err() {
        facade.rotation_gate().resume();
        reshow.await;
    }
    installed
}

/// 开关「退出时安装」。打开前更新包必须已下载好（否则 `update_not_ready`）。
#[tauri::command]
pub async fn set_install_on_exit(
    enabled: bool,
    updater: State<'_, UpdaterState>,
) -> Result<(), CommandError> {
    updater.require_supported()?;
    updater
        .slot()
        .set_install_on_exit(enabled)
        .map_err(CommandError::from)
}

/// 在 `RunEvent::Exit` 里调用：选了「退出时安装」就在进程退出前拉起安装程序。
pub fn install_on_exit(app: &AppHandle) {
    let updater = app.state::<UpdaterState>();
    if !updater.slot().install_on_exit {
        return;
    }
    // 正在等这个进程退出的后来者会赶在安装程序之前接手，安装程序替换文件时它就挡在那里：让它们退出，
    // 安装完由安装程序重新打开落樱。
    #[cfg(windows)]
    if let Some(answer) = app.try_state::<crate::single_instance::Answer>() {
        answer.release_waiting();
    }
    // 退出路径上没有前端可以报错，只能记日志；下次启动检查更新时会再次提示。插件藏起的窗口也不重新显示：
    // 进程本来就在退出。
    if let Err(err) = updater.install_downloaded() {
        tracing::error!(code = err.code, message = %err.message, "退出时安装更新失败");
    }
}

fn endpoint_urls(endpoints: &[String]) -> Vec<Url> {
    endpoints
        .iter()
        .map(|endpoint| Url::parse(endpoint).expect("更新端点来自编译期常量，必定是合法 URL"))
        .collect()
}

/// 下载并校验更新包的那一步。抽成 trait 是为了单测能换上假的下载、按暂停的时钟喂逐块回调，钉住进度、
/// 卡死检测与换源接在回调上的那几处；插件的 `Update` 字段私有，单测造不出来。
trait PackageDownload: Sized {
    /// 同一个更新换一个下载地址。只换地址：版本、签名和客户端配置原样，验签与签名版本校验照旧按清单的标准字段做。
    fn with_download_url(&self, url: &Url) -> Self;

    fn download_package<C, D>(
        &self,
        on_chunk: C,
        on_download_finish: D,
    ) -> impl Future<Output = tauri_plugin_updater::Result<Vec<u8>>> + Send
    where
        C: FnMut(usize, Option<u64>) + Send,
        D: FnOnce() + Send;
}

impl PackageDownload for Update {
    fn with_download_url(&self, url: &Url) -> Self {
        let mut update = self.clone();
        update.download_url = url.clone();
        update
    }

    fn download_package<C, D>(
        &self,
        on_chunk: C,
        on_download_finish: D,
    ) -> impl Future<Output = tauri_plugin_updater::Result<Vec<u8>>> + Send
    where
        C: FnMut(usize, Option<u64>) + Send,
        D: FnOnce() + Send,
    {
        self.download(on_chunk, on_download_finish)
    }
}

/// 按 `sources` 的先后逐个源下载，返回第一个下好并通过校验的包与它的源。
///
/// 每个源开始前推一条 [`CoreEvent::Source`]；失败由 [`judge`] 判定换不换下一个，同一个源不重试。换下一个源之前
/// 先问 `still_current`：下载期间又检查过、换了版本或已无更新时，再从下一个源下好也会被槽位拒收，白下一遍。
/// 用户取消立即返回，后面的源一个都不再试。
async fn download_with_progress<'s>(
    package: &impl PackageDownload,
    sources: &'s [PackageSource],
    size: Option<u64>,
    sink: &EventSink,
    cancel: &CancellationToken,
    still_current: impl Fn() -> Result<(), CommandError>,
) -> Result<(Vec<u8>, &'s PackageSource), CommandError> {
    let count = sources.len();
    let mut failures = Vec::new();
    for (index, source) in sources.iter().enumerate() {
        // 换源事件之前先看令牌：取消先于下载到达时 TaskHandle::run 照样在宽限期里跑这里一次，取消落在一个源刚失败
        // 的那一刻时也会接着走到下一个源；不先看就会推一条换源事件，界面上像是换了个源，紧接着才报取消。
        if cancel.is_cancelled() {
            return Err(CommandError::cancelled());
        }
        if index > 0 {
            still_current()?;
        }
        send(
            sink,
            CoreEvent::Source {
                index,
                count,
                name: source.name.clone(),
            },
        );
        let attempt = package.with_download_url(&source.url);
        let outcome = cancel
            .run_until_cancelled(attempt_download(&attempt, size, sink))
            .await
            .ok_or_else(CommandError::cancelled)?;
        let err = match outcome {
            Ok(bytes) => return Ok((bytes, source)),
            Err(err) => err,
        };
        let failure = judge(source, err);
        let stop = failure.verdict == Verdict::Stop;
        failures.push(failure);
        if stop {
            break;
        }
    }
    Err(sources_failed(failures))
}

/// 从一个源下载并校验更新包。进度计量与卡死检测每个源各建一份：换源后从零重下，进度与窗口都要从头算，
/// 沿用上一个源的卡死检测会把新源还没开始的那几秒算成没有进展。
async fn attempt_download(
    package: &impl PackageDownload,
    size: Option<u64>,
    sink: &EventSink,
) -> Result<Vec<u8>, AttemptError> {
    let mut meter = DownloadMeter::new(Instant::now(), PROGRESS_INTERVAL);
    let stall = StallWatch::new(STALL_WINDOW, STALL_MIN_BYTES);
    let limit = SizeLimit::new(size);
    let verify_sink = sink.clone();
    let download = package.download_package(
        |len, content_length| {
            stall.record(len as u64, stall_clock());
            limit.record(len as u64);
            if let Some(progress) = meter.chunk(len, content_length, Instant::now()) {
                send(sink, CoreEvent::Download(progress));
            }
        },
        move || {
            send(
                &verify_sink,
                CoreEvent::stage("更新包下载完成，正在校验签名"),
            )
        },
    );
    let Some(within_limit) =
        unless_stalled(limit.cut_off(download), &stall, STALL_CHECK_INTERVAL).await
    else {
        tracing::warn!(
            window_secs = STALL_WINDOW.as_secs(),
            min_bytes = STALL_MIN_BYTES,
            "更新包下载长时间没有进展，中止"
        );
        return Err(AttemptError::Stalled);
    };
    let bytes = within_limit?.map_err(AttemptError::Plugin)?;
    send(sink, CoreEvent::Download(meter.finish(Instant::now())));
    Ok(bytes)
}

/// 更新包的大小上限，取 [`package_plan`] 给的大小：清单的 `x-size`，缺失、不合法或超过硬上限时按硬上限，所以总有值。
/// 插件把整个包读进内存、读到连接结束为止，一个不停吐数据的源能把内存吃满；逐块回调里累计字节，一超过上限就让
/// 外层丢掉下载 future，连接随之关闭。`limit` 为 None 时不设限，只有绕开 package_plan 的测试会这样传。
struct SizeLimit {
    limit: Option<u64>,
    received: AtomicU64,
    exceeded: Notify,
}

impl SizeLimit {
    fn new(limit: Option<u64>) -> Self {
        Self {
            limit,
            received: AtomicU64::new(0),
            exceeded: Notify::new(),
        }
    }

    fn record(&self, bytes: u64) {
        // 逐块回调与外层的 select 在同一个任务里轮流跑，从不并发；用原子量只因命令的 future 要能跨线程，Relaxed 就够。
        let received = self.received.fetch_add(bytes, Ordering::Relaxed) + bytes;
        if self.limit.is_some_and(|limit| received > limit) {
            self.exceeded.notify_one();
        }
    }

    fn exceeded(&self) -> bool {
        self.limit
            .is_some_and(|limit| self.received.load(Ordering::Relaxed) > limit)
    }

    /// 跑 `download`，累计字节一超过上限就丢掉它，报 [`AttemptError::TooLarge`]。
    async fn cut_off<T>(&self, download: impl Future<Output = T>) -> Result<T, AttemptError> {
        let Some(limit) = self.limit else {
            return Ok(download.await);
        };
        tokio::select! {
            biased;
            () = self.exceeded.notified() => Err(AttemptError::TooLarge { limit }),
            // 插件逐块读、手头有数据就不让出，越过上限的那一块和下载结束可能落在同一次轮询里：结束时再看一眼，
            // 超过就是超过，不因为恰好读完了就收下。
            outcome = download => if self.exceeded() {
                Err(AttemptError::TooLarge { limit })
            } else {
                Ok(outcome)
            },
        }
    }
}

/// 卡死检测的时钟。走 tokio 的时钟：线上与系统时钟一致，单测暂停时钟就能按定时器推进。
fn stall_clock() -> Instant {
    tokio::time::Instant::now().into_std()
}

/// 更新包下载的卡死检测，窗口从收到第一块正文起才开始算。
///
/// 第一块之前是建连、TLS、跳转（dev 通道的包要从 github.com 302 到资源 CDN，握手两次）和等首字节。
/// 这一段算进窗口的话，慢线路上它就能用掉二十多秒，窗口剩下的几秒里收不够下限，稳定速率是阈值好几倍的下载
/// 也会被判卡死，重试还是一样。这一段交给套上的读取超时：响应头阶段它是从发请求起算的总期限；
/// 回了响应头、正文却一个字节都不来时，它又是读间隔的上限。
struct StallWatch {
    window: Duration,
    min_bytes: u64,
    guard: Mutex<Option<StallGuard>>,
}

impl StallWatch {
    fn new(window: Duration, min_bytes: u64) -> Self {
        Self {
            window,
            min_bytes,
            guard: Mutex::new(None),
        }
    }

    /// 在 `now` 收到 `bytes` 字节；第一次记的时刻就是窗口的起点。
    fn record(&self, bytes: u64, now: Instant) {
        self.lock()
            .get_or_insert_with(|| StallGuard::new(self.window, self.min_bytes, now))
            .record(bytes, now);
    }

    /// 正文还没开始时一律不算卡住。
    fn stalled(&self, now: Instant) -> bool {
        self.lock().as_ref().is_some_and(|guard| guard.stalled(now))
    }

    fn lock(&self) -> MutexGuard<'_, Option<StallGuard>> {
        // 逐块回调与定时检查在同一个任务里轮流跑，从不争锁；用 Mutex 只因命令的 future 要能跨线程。
        // 临界区里只有纯计算，真中毒说明程序已处于未知状态，直接崩。
        self.guard.lock().expect("卡死检测的锁已中毒")
    }
}

/// 跑 `download`，每隔 `every` 问一次 `stall` 有没有卡住。卡住时丢掉下载 future（连接随之关闭），返回 `None`。
/// 判定要靠定时器来问：卡死的连接恰恰不再触发逐块回调。
async fn unless_stalled<T>(
    download: impl Future<Output = T>,
    stall: &StallWatch,
    every: Duration,
) -> Option<T> {
    let mut download = std::pin::pin!(download);
    let mut checks = tokio::time::interval(every);
    loop {
        tokio::select! {
            // 下载先问：同一轮里下载已出结果、检查也到点时，不能把下好的包当成卡住丢掉。
            biased;
            outcome = &mut download => return Some(outcome),
            _ = checks.tick() => {
                if stall.stalled(stall_clock()) {
                    return None;
                }
            }
        }
    }
}

fn send(sink: &EventSink, event: CoreEvent) {
    // 接收端在命令结束前一直活着，发不出去只可能是转发任务已异常退出，它自己会留错误日志。
    if sink.send(event).is_err() {
        tracing::warn!("更新进度事件通道已关闭");
    }
}

/// 把插件逐块回调的字节数节流成下载进度快照。单文件下载，`total` 恒为 1。
struct DownloadMeter {
    started: Instant,
    last_at: Instant,
    last_bytes: u64,
    bytes: u64,
    total_bytes: Option<u64>,
    interval: Duration,
}

impl DownloadMeter {
    fn new(now: Instant, interval: Duration) -> Self {
        Self {
            started: now,
            last_at: now,
            last_bytes: 0,
            bytes: 0,
            total_bytes: None,
            interval,
        }
    }

    /// 记一块；距上次推送不足间隔时不出快照。速度取两次推送之间的平均。
    fn chunk(
        &mut self,
        len: usize,
        content_length: Option<u64>,
        now: Instant,
    ) -> Option<DownloadProgress> {
        self.bytes += len as u64;
        self.total_bytes = content_length;
        let since = now.duration_since(self.last_at);
        if since < self.interval {
            return None;
        }
        let speed = per_second(self.bytes - self.last_bytes, since);
        self.last_at = now;
        self.last_bytes = self.bytes;
        Some(self.snapshot(0, speed))
    }

    /// 收尾快照：`finished = 1`，速度取全程平均。
    fn finish(&self, now: Instant) -> DownloadProgress {
        self.snapshot(1, per_second(self.bytes, now.duration_since(self.started)))
    }

    fn snapshot(&self, finished: u64, speed: u64) -> DownloadProgress {
        DownloadProgress {
            total: 1,
            finished,
            bytes: self.bytes,
            total_bytes: self.total_bytes,
            transferred: self.bytes,
            speed,
        }
    }
}

fn per_second(bytes: u64, elapsed: Duration) -> u64 {
    (u128::from(bytes) * 1000 / elapsed.as_millis().max(1)) as u64
}

/// 插件错误转命令错误。签名相关的失败无论出现在哪一步都单独成码：前端要明确告诉用户包被拒了。
/// `message` 只放原因：是哪个动作失败由界面的主句或通知标题说，这里再带上就重复了；`action` 只进日志。
fn updater_error(
    fallback: &'static str,
    action: &str,
    endpoints: Option<&[String]>,
    err: tauri_plugin_updater::Error,
) -> CommandError {
    use tauri_plugin_updater::Error as UpdaterError;
    let code = match err {
        // 签名版本与清单版本对不上、或签名没带版本号，是清单被篡改或包签错了，同样是包被拒。
        UpdaterError::Minisign(_)
        | UpdaterError::Base64(_)
        | UpdaterError::SignatureUtf8(_)
        | UpdaterError::SignedVersionMismatch { .. }
        | UpdaterError::MissingSignedVersion => code::UPDATE_SIGNATURE_INVALID,
        _ => fallback,
    };
    let message = err.to_string();
    let causes = source_chain(&err);
    let mut detail = Map::new();
    if let Some(endpoints) = endpoints {
        detail.insert("endpoints".to_owned(), json!(endpoints));
    }
    if let Some(failure) = plugin_network_failure(&err) {
        detail.insert("network".to_owned(), json!(failure.code()));
    }
    if !causes.is_empty() {
        detail.insert("causes".to_owned(), json!(causes));
    }
    tracing::warn!(code, action, %message, ?causes, "更新命令失败");
    CommandError {
        code,
        message,
        detail: (!detail.is_empty()).then_some(Value::Object(detail)),
    }
}

/// 插件错误是不是败在网络层、是哪一种。插件的 Reqwest 变体是 transparent：它的 source() 直接给出 reqwest 错误的
/// 下一层，从插件错误顺着原因链找不到 reqwest 错误本身，只能在这里取出来判断。
fn plugin_network_failure(err: &tauri_plugin_updater::Error) -> Option<NetworkFailure> {
    match err {
        tauri_plugin_updater::Error::Reqwest(http) => petalfall_base::http::network_failure(http),
        other => petalfall_base::http::network_failure(other),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::update_slot::tests::Fake;
    use petalfall_core::SourceRegion;
    use std::collections::HashMap;
    use std::sync::Arc;

    /// 立即安装在拉起安装程序之前就把待补的游玩记录写进了文件，安装的结果原样返回。
    #[tokio::test]
    async fn install_now_saves_pending_play_records_before_installing() {
        use petalfall_core::playtime::PLAYTIME_FILE;
        use petalfall_core::{Petalfall, PetalfallConfig};

        const RECORDS: &str = r#"{"format":1,"book":{
            "instances":{
                "旧名":{"total_ms":7200000,"last_played_at":1761800000000},
                "留下":{"total_ms":1800000,"last_played_at":1761600000000}},
            "days":{"2026-10-30":{"instances":{"旧名":7200000,"留下":1800000}}}}}"#;
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(PLAYTIME_FILE);
        let facade = Facade::new(
            Petalfall::open(
                PetalfallConfig::default(),
                dir.path().to_path_buf(),
                dir.path().join("config.json"),
            )
            .unwrap(),
        );
        std::fs::write(&path, "{ broken").unwrap();
        assert!(facade
            .snapshot()
            .await
            .rename_play_records("旧名", "新名")
            .await
            .is_err());
        std::fs::write(&path, RECORDS).unwrap();

        let mut on_disk_at_install = None;
        let result = install_after_persisting(
            &facade,
            || {
                on_disk_at_install = Some(std::fs::read_to_string(&path).unwrap());
                Err(CommandError::new(
                    code::UPDATE_INSTALL_FAILED,
                    "启动更新安装失败",
                ))
            },
            async {},
        )
        .await;

        assert_eq!(result.unwrap_err().code, code::UPDATE_INSTALL_FAILED);
        let saved: Value = serde_json::from_str(&on_disk_at_install.unwrap()).unwrap();
        let book = &saved["directories"][0]["book"];
        assert_eq!(book["instances"]["新名"]["total_ms"], 7_200_000);
        assert!(book["instances"].get("旧名").is_none());
        assert_eq!(book["instances"]["留下"]["total_ms"], 1_800_000);
        assert_eq!(book["days"]["2026-10-30"]["instances"]["新名"], 7_200_000);
        assert!(!facade
            .snapshot()
            .await
            .save_pending_play_records()
            .await
            .unwrap());
    }

    /// 外置账户正在刷新令牌时立即安装：拉起安装程序之前新令牌已经落盘。安装程序一拉起进程就结束，
    /// 这里不等就没有别处会等，服务器那边已经作废了旧令牌，账户只能重新登录。
    #[cfg(windows)]
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn install_now_waits_for_the_authlib_rotation_in_flight() {
        let dir = tempfile::tempdir().unwrap();
        let account = crate::exit::tests::stale_authlib_account(
            dir.path(),
            std::time::Duration::ZERO,
            std::time::Duration::from_secs(1),
        )
        .await;
        let _renewal = account.renew_until("/authserver/refresh").await;
        assert_eq!(account.stored_token(), "stale");

        let mut stored_at_install = None;
        install_after_persisting(
            &account.facade,
            || {
                stored_at_install = Some(account.stored_token());
                Ok(())
            },
            async {},
        )
        .await
        .unwrap();
        assert_eq!(stored_at_install.as_deref(), Some("rotated"));
    }

    /// 安装程序没拉起来、进程接着跑：拉起之前关上的轮换闸要重新打开，外置令牌照常刷新。不开的话，之后每次
    /// 刷新外置账户都以取消告终，直到重启落樱。
    #[cfg(windows)]
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_failed_install_lets_authlib_tokens_refresh_again() {
        let dir = tempfile::tempdir().unwrap();
        let account = crate::exit::tests::stale_authlib_account(
            dir.path(),
            std::time::Duration::ZERO,
            std::time::Duration::ZERO,
        )
        .await;

        let failed = install_after_persisting(
            &account.facade,
            || {
                Err(CommandError::new(
                    code::UPDATE_INSTALL_FAILED,
                    "启动更新安装失败",
                ))
            },
            async {},
        )
        .await;
        assert_eq!(failed.unwrap_err().code, code::UPDATE_INSTALL_FAILED);

        account.renew().await.unwrap();
        assert_eq!(account.stored_token(), "rotated");
    }

    /// 插件拉起安装程序之前已经把窗口藏了：没拉起来时先把窗口重新显示出来再报错，否则用户看不到报错、
    /// 以为落樱自己退出了。拉起了就不显示：Windows 上进程随即退出。
    #[tokio::test]
    async fn only_a_failed_install_brings_the_window_back() {
        use petalfall_core::{Petalfall, PetalfallConfig};

        let dir = tempfile::tempdir().unwrap();
        let facade = Facade::new(
            Petalfall::open(
                PetalfallConfig::default(),
                dir.path().to_path_buf(),
                dir.path().join("config.json"),
            )
            .unwrap(),
        );
        let steps = std::cell::RefCell::new(Vec::new());

        let failed = install_after_persisting(
            &facade,
            || {
                steps.borrow_mut().push("install");
                Err(CommandError::new(
                    code::UPDATE_INSTALL_FAILED,
                    "启动更新安装失败",
                ))
            },
            async { steps.borrow_mut().push("reshow") },
        )
        .await;
        assert_eq!(failed.unwrap_err().code, code::UPDATE_INSTALL_FAILED);
        assert_eq!(*steps.borrow(), ["install", "reshow"]);

        steps.borrow_mut().clear();
        install_after_persisting(
            &facade,
            || {
                steps.borrow_mut().push("install");
                Ok(())
            },
            async { steps.borrow_mut().push("reshow") },
        )
        .await
        .unwrap();
        assert_eq!(*steps.borrow(), ["install"], "拉起了就不该重新显示窗口");
    }

    /// 支持判定用例里正式版的包要注入的公钥：钥表里正式版那一把。用例里的版本号不带预发布标识时都是正式版。
    fn stable_key() -> &'static str {
        channel_pubkey(Channel::Stable)
    }

    #[test]
    fn support_requires_release_build_and_non_empty_pubkey() {
        let with_key = json!({ "pubkey": stable_key(), "requireSignedVersion": true });
        assert_eq!(
            detect_support(Some(&with_key), false, ""),
            UpdaterSupport::Supported
        );
        // CI 注入前 trim 过，手写的配置多带了首尾空白也认。
        let padded =
            json!({ "pubkey": format!("  {}\n", stable_key()), "requireSignedVersion": true });
        assert_eq!(
            detect_support(Some(&padded), false, ""),
            UpdaterSupport::Supported
        );
        assert_eq!(
            detect_support(Some(&with_key), true, ""),
            UpdaterSupport::Unsupported(UnsupportedReason::DebugBuild)
        );
        for config in [
            json!({ "requireSignedVersion": true }),
            json!({ "pubkey": "  ", "requireSignedVersion": true }),
            json!({ "pubkey": 7, "requireSignedVersion": true }),
            json!({}),
        ] {
            assert_eq!(
                detect_support(Some(&config), false, ""),
                UpdaterSupport::Unsupported(UnsupportedReason::MissingPubkey),
                "{config}"
            );
        }
        assert_eq!(
            detect_support(None, false, ""),
            UpdaterSupport::Unsupported(UnsupportedReason::MissingPubkey)
        );
    }

    /// 有公钥但没要求签名带版本号：伪造的清单能把旧版本的合法包配上新版本号，自更新整体停用。
    /// 两种键名都认；同时出现或值不是布尔时插件拒绝整份配置，也不能注册插件。
    #[test]
    fn support_requires_signed_versions() {
        for key in REQUIRE_SIGNED_VERSION_KEYS {
            let config = json!({ "pubkey": stable_key(), key: true });
            assert_eq!(
                detect_support(Some(&config), false, ""),
                UpdaterSupport::Supported,
                "{config}"
            );
        }
        for config in [
            json!({ "pubkey": stable_key() }),
            json!({ "pubkey": stable_key(), "requireSignedVersion": false }),
            json!({ "pubkey": stable_key(), "require-signed-version": false }),
            json!({ "pubkey": stable_key(), "requireSignedVersion": "true" }),
            json!({ "pubkey": stable_key(), "requireSignedVersion": 1 }),
            json!({ "pubkey": stable_key(), "requireSignedVersion": null }),
            json!({ "pubkey": stable_key(), "require_signed_version": true }),
            json!({ "pubkey": stable_key(), "requireSignedVersion": true, "require-signed-version": true }),
        ] {
            assert_eq!(
                detect_support(Some(&config), false, ""),
                UpdaterSupport::Unsupported(UnsupportedReason::SignedVersionNotRequired),
                "{config}"
            );
        }

        let state = UpdaterState::new(UpdaterSupport::Unsupported(
            UnsupportedReason::SignedVersionNotRequired,
        ));
        let err = state.require_supported().unwrap_err();
        assert_eq!(err.code, code::UPDATER_UNSUPPORTED);
        assert_eq!(err.detail.unwrap()["reason"], "signed_version_not_required");
        assert!(err.message.contains("版本号"), "{}", err.message);
        let info = serde_json::to_value(state.info("0.1.0".into())).unwrap();
        assert_eq!(info["supported"], false);
        assert_eq!(info["unsupported_reason"], "signed_version_not_required");
    }

    /// 认键名的规则照着插件的反序列化来：两种键名都打开要求，没写时不要求，同时出现或值不是布尔时整份配置被拒。
    /// 插件改了这套规则，这里先挂，[`detect_support`] 跟着改。
    #[test]
    fn signed_version_keys_follow_the_plugin_config_rules() {
        use tauri_plugin_updater::Config;

        for key in REQUIRE_SIGNED_VERSION_KEYS {
            let config: Config =
                serde_json::from_value(json!({ "pubkey": stable_key(), key: true })).unwrap();
            assert!(config.require_signed_version, "{key}");
        }
        let absent: Config = serde_json::from_value(json!({ "pubkey": stable_key() })).unwrap();
        assert!(!absent.require_signed_version);
        for rejected in [
            json!({ "pubkey": stable_key(), "requireSignedVersion": true, "require-signed-version": true }),
            json!({ "pubkey": stable_key(), "requireSignedVersion": "true" }),
        ] {
            assert!(
                serde_json::from_value::<Config>(rejected.clone()).is_err(),
                "{rejected}"
            );
        }
    }

    /// 签名带了版本号，配置却允许装旧版本：伪造的清单照实写上旧版本号、指向旧版本的合法包，签名版本对得上，
    /// 插件的比较器又只要求「不同」，照样降级，所以同样整体停用。两种键名都认；关着或没写才支持。
    #[test]
    fn support_refuses_configs_that_allow_downgrades() {
        for key in ALLOW_DOWNGRADES_KEYS {
            let closed =
                json!({ "pubkey": stable_key(), "requireSignedVersion": true, key: false });
            assert_eq!(
                detect_support(Some(&closed), false, ""),
                UpdaterSupport::Supported,
                "{closed}"
            );
            let open = json!({ "pubkey": stable_key(), "requireSignedVersion": true, key: true });
            assert_eq!(
                detect_support(Some(&open), false, ""),
                UpdaterSupport::Unsupported(UnsupportedReason::DowngradesAllowed),
                "{open}"
            );
        }
        for config in [
            json!({ "pubkey": stable_key(), "requireSignedVersion": true, "allowDowngrades": "false" }),
            json!({ "pubkey": stable_key(), "requireSignedVersion": true, "allowDowngrades": 0 }),
            json!({ "pubkey": stable_key(), "requireSignedVersion": true, "allowDowngrades": null }),
            json!({
                "pubkey": stable_key(),
                "requireSignedVersion": true,
                "allowDowngrades": false,
                "allow-downgrades": false,
            }),
        ] {
            assert_eq!(
                detect_support(Some(&config), false, ""),
                UpdaterSupport::Unsupported(UnsupportedReason::DowngradesAllowed),
                "{config}"
            );
        }

        let state = UpdaterState::new(UpdaterSupport::Unsupported(
            UnsupportedReason::DowngradesAllowed,
        ));
        let err = state.require_supported().unwrap_err();
        assert_eq!(err.code, code::UPDATER_UNSUPPORTED);
        assert_eq!(err.detail.unwrap()["reason"], "downgrades_allowed");
        let info = serde_json::to_value(state.info("0.1.0".into())).unwrap();
        assert_eq!(info["unsupported_reason"], "downgrades_allowed");
    }

    /// `allowDowngrades` 的键名规则同样照着插件来：两种键名都打开，没写时关着，同时出现或值不是布尔时整份配置被拒。
    #[test]
    fn downgrade_keys_follow_the_plugin_config_rules() {
        use tauri_plugin_updater::Config;

        for key in ALLOW_DOWNGRADES_KEYS {
            let config: Config =
                serde_json::from_value(json!({ "pubkey": stable_key(), key: true })).unwrap();
            assert!(config.allow_downgrades, "{key}");
        }
        let absent: Config = serde_json::from_value(json!({ "pubkey": stable_key() })).unwrap();
        assert!(!absent.allow_downgrades);
        for rejected in [
            json!({ "pubkey": stable_key(), "allowDowngrades": false, "allow-downgrades": false }),
            json!({ "pubkey": stable_key(), "allowDowngrades": "false" }),
            json!({ "pubkey": stable_key(), "allowDowngrades": null }),
        ] {
            assert!(
                serde_json::from_value::<Config>(rejected.clone()).is_err(),
                "{rejected}"
            );
        }
    }

    /// 配置齐全，版本号却认不出通道（rc、alpha 这类）：没有该问的清单，自更新整体停用，不落到正式通道去问正式版的
    /// 清单。三个通道的版本照常支持；开发构建仍先按开发构建报。
    #[test]
    fn support_refuses_versions_outside_known_channels() {
        for (known, channel) in [
            ("", Channel::Stable),
            ("dev.37", Channel::Dev),
            ("beta.1", Channel::Beta),
            ("BETA.2", Channel::Beta),
        ] {
            let config = json!({ "pubkey": channel_pubkey(channel), "requireSignedVersion": true });
            assert_eq!(
                detect_support(Some(&config), false, known),
                UpdaterSupport::Supported,
                "{known}"
            );
        }
        // 认不出通道就无从谈哪一把是本包通道的钥，先于公钥判。
        let config = json!({ "pubkey": stable_key(), "requireSignedVersion": true });
        for unknown in ["rc.1", "alpha.1", "betax.1", "nightly", "dev-1"] {
            assert_eq!(
                detect_support(Some(&config), false, unknown),
                UpdaterSupport::Unsupported(UnsupportedReason::UnknownChannel),
                "{unknown}"
            );
        }
        assert_eq!(
            detect_support(Some(&config), true, "rc.1"),
            UpdaterSupport::Unsupported(UnsupportedReason::DebugBuild)
        );

        let state = UpdaterState::new(UpdaterSupport::Unsupported(
            UnsupportedReason::UnknownChannel,
        ));
        let err = state.require_supported().unwrap_err();
        assert_eq!(err.code, code::UPDATER_UNSUPPORTED);
        assert_eq!(err.detail.unwrap()["reason"], "unknown_channel");
        let info = serde_json::to_value(state.info("1.0.0-rc.1".into())).unwrap();
        assert_eq!(info["supported"], false);
        assert_eq!(info["unsupported_reason"], "unknown_channel");
    }

    /// 注入的公钥必须正是钥表里本包通道的那一把：dev 包注入了发布钥、beta 包注入了 dev 钥、fork 注入了自己的钥，
    /// 都整体不支持。检查器按钥表认落樱的更新，注入的钥对不上时 fork 会去认落樱的包，CI 注入错了钥则装不上自己
    /// 通道的更新。本机构建没注入公钥仍按缺公钥报，打开 allowDowngrades 仍不支持。
    #[test]
    fn support_requires_the_key_of_the_package_channel() {
        let dev_key = channel_pubkey(Channel::Dev);
        let release_key = channel_pubkey(Channel::Beta);
        assert_ne!(dev_key, release_key);
        let fork_key = "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWdu";
        let with = |key: &str| json!({ "pubkey": key, "requireSignedVersion": true });
        for (pre_release, key) in [
            ("dev.37", release_key),
            ("beta.1", dev_key),
            ("", dev_key),
            ("dev.37", fork_key),
            ("beta.1", fork_key),
            ("", fork_key),
        ] {
            assert_eq!(
                detect_support(Some(&with(key)), false, pre_release),
                UpdaterSupport::Unsupported(UnsupportedReason::PubkeyMismatch),
                "{pre_release} {key}"
            );
        }
        for (pre_release, key) in [
            ("dev.37", dev_key),
            ("beta.1", release_key),
            ("", release_key),
        ] {
            assert_eq!(
                detect_support(Some(&with(key)), false, pre_release),
                UpdaterSupport::Supported,
                "{pre_release}"
            );
        }

        for pre_release in ["dev.37", "beta.1", ""] {
            assert_eq!(
                detect_support(
                    Some(&json!({ "requireSignedVersion": true })),
                    false,
                    pre_release
                ),
                UpdaterSupport::Unsupported(UnsupportedReason::MissingPubkey),
                "{pre_release}"
            );
        }
        let downgrades = json!({
            "pubkey": dev_key,
            "requireSignedVersion": true,
            "allowDowngrades": true,
        });
        assert_eq!(
            detect_support(Some(&downgrades), false, "dev.37"),
            UpdaterSupport::Unsupported(UnsupportedReason::DowngradesAllowed)
        );

        let state = UpdaterState::new(UpdaterSupport::Unsupported(
            UnsupportedReason::PubkeyMismatch,
        ));
        let err = state.require_supported().unwrap_err();
        assert_eq!(err.code, code::UPDATER_UNSUPPORTED);
        assert_eq!(err.detail.unwrap()["reason"], "pubkey_mismatch");
        let info = serde_json::to_value(state.info("1.0.0-dev.12".into())).unwrap();
        assert_eq!(info["supported"], false);
        assert_eq!(info["unsupported_reason"], "pubkey_mismatch");
    }

    #[test]
    fn unsupported_error_carries_reason() {
        let state = UpdaterState::new(UpdaterSupport::Unsupported(
            UnsupportedReason::MissingPubkey,
        ));
        let err = state.require_supported().unwrap_err();
        assert_eq!(err.code, code::UPDATER_UNSUPPORTED);
        assert_eq!(err.detail.unwrap()["reason"], "missing_pubkey");

        let info = serde_json::to_value(state.info("0.1.0".into())).unwrap();
        assert_eq!(info["supported"], false);
        assert_eq!(info["unsupported_reason"], "missing_pubkey");
        assert_eq!(info["current_version"], "0.1.0");
        assert_eq!(info["available"], Value::Null);
        assert_eq!(info["downloaded_version"], Value::Null);
    }

    /// 偏好还没有地方存、清单也不按通道记结果：生效的偏好就是本包版本号所属的通道，关系为 same，各通道的结果与
    /// 被拒的版本都为空，没下载时下好的包的通道与用意为 null。开发构建不支持自更新，但通道照样认得出；
    /// 只有版本号认不出通道时，这三项才为 null。
    #[test]
    fn info_takes_the_package_channel_as_the_preference() {
        let supported = UpdaterState::new(UpdaterSupport::Supported);
        let debug = UpdaterState::new(UpdaterSupport::Unsupported(UnsupportedReason::DebugBuild));
        for (state, version, channel) in [
            (&supported, "1.0.0-dev.12", "dev"),
            (&supported, "1.0.0-beta.3", "beta"),
            (&supported, "1.0.0-BETA.2+build.7", "beta"),
            (&supported, "1.0.0", "stable"),
            (&debug, "0.1.0-dev.3", "dev"),
        ] {
            let info = serde_json::to_value(state.info(version.into())).unwrap();
            assert_eq!(info["package_channel"], channel, "{version}");
            assert_eq!(info["preference"], channel, "{version}");
            assert_eq!(info["relation"], "same", "{version}");
            assert_eq!(info["channel_heads"], json!([]), "{version}");
            assert_eq!(info["refused"], json!([]), "{version}");
            assert_eq!(info["downloaded_channel"], Value::Null, "{version}");
            assert_eq!(info["downloaded_intent"], Value::Null, "{version}");
        }

        let unknown = UpdaterState::new(UpdaterSupport::Unsupported(
            UnsupportedReason::UnknownChannel,
        ));
        let info = serde_json::to_value(unknown.info("1.0.0-rc.1".into())).unwrap();
        for field in ["package_channel", "preference", "relation"] {
            assert_eq!(info[field], Value::Null, "{field}");
        }
    }

    /// 三个通道的权威清单都在香港机上，按通道分目录：正式版、测试版与开发版各认各的，谁也拿不到别的通道的清单。
    #[test]
    fn endpoints_are_https_on_brand_domains() {
        let host = format!("{}.org", petalfall_base::brand::APP_SLUG);
        for (endpoint, path) in [
            (PRIMARY_ENDPOINT, "/updates/stable/latest.json"),
            (BETA_ENDPOINT, "/updates/beta/latest.json"),
            (DEV_ENDPOINT, "/updates/dev/latest.json"),
        ] {
            let urls = endpoint_urls(&[endpoint.to_owned()]);
            assert_eq!(urls[0].scheme(), "https", "{endpoint}");
            assert_eq!(urls[0].host_str(), Some(host.as_str()), "{endpoint}");
            assert_eq!(urls[0].path(), path, "{endpoint}");
        }
        // beta-release.yml 往这个地址推清单、再回读核对，.github/scripts/beta-release-contract.test.mjs 把工作流里的
        // HK_MANIFEST_URL 钉成同一个字面量，并核对这一句还在：改地址要两边一起改。这一句只在本地 cargo test 时跑，
        // CI 上由 beta-release.yml 打包后在 Petalfall.exe 里找这个地址兜底，所以 BETA_ENDPOINT 要保持编译期的整串。
        assert_eq!(
            BETA_ENDPOINT,
            "https://petalfall.org/updates/beta/latest.json"
        );
    }

    /// dev 通道先问香港机、再问 GitHub：反过来的话，连不上 GitHub 的用户每次检查都要先等它超时。
    /// 测试版与正式版各只有香港机一份，测试版不问 GitHub Release，也不问正式版的清单。
    #[test]
    fn each_channel_asks_its_endpoints_in_a_fixed_order() {
        assert_eq!(
            channel_endpoints(Channel::Dev),
            vec![DEV_ENDPOINT.to_owned(), dev_endpoint()]
        );
        assert_eq!(
            channel_endpoints(Channel::Beta),
            vec![BETA_ENDPOINT.to_owned()]
        );
        assert_eq!(
            channel_endpoints(Channel::Stable),
            vec![PRIMARY_ENDPOINT.to_owned()]
        );
    }

    /// 检查与下载前的重查都按版本号取端点：三个通道各取各的，认不出通道时报 `updater_unsupported`，
    /// 不拿哪个通道的清单顶上。
    #[test]
    fn version_endpoints_refuse_unknown_channels() {
        assert_eq!(
            version_endpoints("").unwrap(),
            (Channel::Stable, vec![PRIMARY_ENDPOINT.to_owned()])
        );
        assert_eq!(
            version_endpoints("beta.1").unwrap(),
            (Channel::Beta, vec![BETA_ENDPOINT.to_owned()])
        );
        assert_eq!(
            version_endpoints("dev.37").unwrap(),
            (Channel::Dev, vec![DEV_ENDPOINT.to_owned(), dev_endpoint()])
        );
        for unknown in ["rc.1", "alpha.1", "betax.1"] {
            let err = version_endpoints(unknown).unwrap_err();
            assert_eq!(err.code, code::UPDATER_UNSUPPORTED, "{unknown}");
            assert_eq!(
                err.detail.unwrap()["reason"],
                "unknown_channel",
                "{unknown}"
            );
            assert!(err.message.contains("通道"), "{}", err.message);
        }
    }

    /// dev 包认的地址必须正是 CI 上传清单的位置：任何一边改了 tag 或文件名，已装的 dev 包就再也收不到更新。
    #[test]
    fn dev_endpoint_is_where_ci_uploads_the_manifest() {
        let urls = endpoint_urls(&[dev_endpoint()]);
        assert_eq!(urls[0].scheme(), "https");
        assert_eq!(urls[0].host_str(), Some("github.com"));
        assert_eq!(
            urls[0].path(),
            "/ShinoyukiMiyako/Petalfall/releases/download/dev-build/latest.json"
        );

        let raw = include_str!("../../../../.github/workflows/dev-build.yml");
        // Windows 检出的工作流是 CRLF，逐行比，不拿换行符做界
        let workflow: Vec<&str> = raw.lines().map(str::trim).collect();
        assert!(workflow.contains(&format!("TAG: {DEV_RELEASE_TAG}").as_str()));
        assert!(workflow.contains(&"manifest=\"$RUNNER_TEMP/latest.json\""));
        assert!(workflow.iter().any(|line| line.starts_with("\"$MANIFEST#")));

        // 防降级要两头都在：客户端要求签名带版本号（否则 detect_support 不注册插件，dev 包收不到更新），
        // 签名时把这次的版本号写进可信注释（否则插件拒收每一个 dev 包）。只看真正执行的行：文件头和步骤上方的
        // 注释里也写着这两处，拿全文找子串的话，删掉真正的注入照样能过。整段比对更新插件的配置，写进别的层级、
        // 或多带一项（比如 allowDowngrades）都要挂。
        let steps: Vec<&str> = workflow
            .iter()
            .copied()
            .filter(|line| !line.starts_with('#'))
            .collect();
        let injected = steps
            .iter()
            .find(|line| line.starts_with("conf.plugins = "))
            .expect("CI 不再往 tauri.conf.json 写更新插件的配置");
        assert!(
            injected.contains(
                "updater: { pubkey: fs.readFileSync('../.github/dev-updater.pub', 'utf8').trim(), \
                 requireSignedVersion: true }"
            ),
            "{injected}"
        );
        assert!(
            steps
                .iter()
                .any(|line| line.contains("signer sign --app-version \"$VERSION\" ")),
            "签名不再把版本号写进可信注释"
        );
    }

    #[test]
    fn meter_throttles_and_reports_speed() {
        let start = Instant::now();
        let mut meter = DownloadMeter::new(start, Duration::from_millis(100));
        assert_eq!(
            meter.chunk(1000, Some(10_000), start + Duration::from_millis(40)),
            None
        );
        let progress = meter
            .chunk(1000, Some(10_000), start + Duration::from_millis(200))
            .unwrap();
        assert_eq!(
            progress,
            DownloadProgress {
                total: 1,
                finished: 0,
                bytes: 2000,
                total_bytes: Some(10_000),
                transferred: 2000,
                speed: 10_000,
            }
        );
        assert_eq!(
            meter.chunk(500, Some(10_000), start + Duration::from_millis(250)),
            None
        );
        let done = meter.finish(start + Duration::from_millis(500));
        assert_eq!(
            done,
            DownloadProgress {
                total: 1,
                finished: 1,
                bytes: 2500,
                total_bytes: Some(10_000),
                transferred: 2500,
                speed: 5000,
            }
        );
    }

    #[test]
    fn signature_failures_get_their_own_code() {
        let err = updater_error(
            code::UPDATE_DOWNLOAD_FAILED,
            "下载更新失败",
            None,
            tauri_plugin_updater::Error::SignatureUtf8("bad".into()),
        );
        assert_eq!(err.code, code::UPDATE_SIGNATURE_INVALID);
        assert_eq!(
            err.message,
            tauri_plugin_updater::Error::SignatureUtf8("bad".into()).to_string()
        );

        // 清单把旧版本的包配上了新版本号，或签名没带版本号：都是包被拒，不是下载失败。
        let downgrade = || tauri_plugin_updater::Error::SignedVersionMismatch {
            signed: "0.1.0-dev.12".into(),
            announced: "0.1.0-dev.40".into(),
        };
        let unversioned = || tauri_plugin_updater::Error::MissingSignedVersion;
        for (rejected, raw) in [
            (downgrade(), downgrade().to_string()),
            (unversioned(), unversioned().to_string()),
        ] {
            let err = updater_error(code::UPDATE_DOWNLOAD_FAILED, "下载更新失败", None, rejected);
            assert_eq!(err.code, code::UPDATE_SIGNATURE_INVALID, "{raw}");
            assert_eq!(err.message, raw);
            assert_eq!(err.detail, None, "{raw}");
        }

        let endpoints = vec![PRIMARY_ENDPOINT.to_owned()];
        let err = updater_error(
            code::UPDATE_CHECK_FAILED,
            "检查更新失败",
            Some(&endpoints),
            tauri_plugin_updater::Error::TargetNotFound("windows-x86_64".into()),
        );
        assert_eq!(err.code, code::UPDATE_CHECK_FAILED);
        assert_eq!(err.detail.unwrap()["endpoints"], json!([PRIMARY_ENDPOINT]));
    }

    /// 界面的主句已经说了是哪个动作失败，message 再带上就成了「检查更新失败 / 检查更新失败：...」。
    #[test]
    fn message_is_the_cause_without_the_action() {
        let actions = [
            (code::UPDATE_CHECK_FAILED, "检查更新失败"),
            (code::UPDATE_DOWNLOAD_FAILED, "下载更新失败"),
            (code::UPDATE_INSTALL_FAILED, "启动更新安装失败"),
        ];
        for (fallback, action) in actions {
            let err = updater_error(
                fallback,
                action,
                None,
                tauri_plugin_updater::Error::TargetNotFound("windows-x86_64".into()),
            );
            assert_eq!(err.code, fallback);
            assert_eq!(
                err.message,
                "the platform `windows-x86_64` was not found in the response `platforms` object"
            );
        }
    }

    /// 下载时连不上同样标 detail.network，前端据此写中文原因，原文留在 message；
    /// 下载回了错误状态码时插件报 Network 变体，那是拿到了响应，不算网络层失败。
    #[tokio::test]
    async fn download_failures_mark_network_kind_the_same_way() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!(
            "http://127.0.0.1:{}/Petalfall-setup.exe",
            listener.local_addr().unwrap().port()
        );
        drop(listener);
        let refused = petalfall_base::http::build_client()
            .unwrap()
            .get(&url)
            .send()
            .await
            .unwrap_err();
        let raw = refused.to_string();

        let err = updater_error(
            code::UPDATE_DOWNLOAD_FAILED,
            "下载更新失败",
            None,
            tauri_plugin_updater::Error::Reqwest(refused),
        );
        assert_eq!(err.code, code::UPDATE_DOWNLOAD_FAILED);
        assert_eq!(err.message, raw);
        assert_eq!(err.detail.unwrap()["network"], json!("connect"));

        let err = updater_error(
            code::UPDATE_DOWNLOAD_FAILED,
            "下载更新失败",
            None,
            tauri_plugin_updater::Error::Network(
                "Download request failed with status: 503 Service Unavailable".into(),
            ),
        );
        assert_eq!(err.code, code::UPDATE_DOWNLOAD_FAILED);
        assert_eq!(
            err.message,
            "`Download request failed with status: 503 Service Unavailable`"
        );
        assert_eq!(err.detail, None);
    }

    /// 下到一半终点不再送数据、连接也不断：套上的读取超时内失败，标成网络超时，前端提示检查网络后重试，
    /// 不会让进度条一直停在原地。插件下载时正是这样建客户端、逐块读正文的。
    #[tokio::test]
    async fn a_download_that_stops_mid_body_fails_within_the_read_timeout() {
        use std::io::{Read, Write};

        const PARTIAL: [u8; 512] = [7; 512];
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!(
            "http://{}/Petalfall-setup.exe",
            listener.local_addr().unwrap()
        );
        // 只用来等对面丢掉发送端：用例有了结论（或中途失败）时放开连接，服务线程随之退出。
        let (release, released) = std::sync::mpsc::channel::<()>();
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut head = Vec::new();
            let mut byte = [0u8; 1];
            while !head.ends_with(b"\r\n\r\n") {
                stream.read_exact(&mut byte).unwrap();
                head.push(byte[0]);
            }
            let reply = [
                b"HTTP/1.1 200 OK\r\nContent-Length: 4096\r\n\r\n".as_slice(),
                PARTIAL.as_slice(),
            ]
            .concat();
            stream.write_all(&reply).unwrap();
            released.recv().unwrap_err();
        });

        // 读取超时在响应头阶段是从发请求起算的总期限，服务线程 accept、逐字节读请求头、写回响应头都算在里面：
        // 给足余量，机器忙、服务线程迟迟排不上时也不会在请求头阶段就超时。
        let client = with_transfer_timeouts(
            ClientBuilder::new(),
            Duration::from_secs(5),
            Duration::from_secs(2),
        )
        .build()
        .unwrap();
        // 外层时限只把「没套上读取超时、永远等下去」变成失败，远长于读取超时，不参与判定先后。
        let (received, stalled) = tokio::time::timeout(Duration::from_secs(20), async {
            let mut response = client
                .get(&url)
                .send()
                .await
                .expect("请求头阶段就失败了，与被测的正文中途卡住无关");
            let mut received = 0;
            loop {
                match response.chunk().await {
                    Ok(Some(chunk)) => received += chunk.len(),
                    Ok(None) => panic!("正文没送完，读取不该正常结束"),
                    Err(err) => return (received, err),
                }
            }
        })
        .await
        .expect("卡住的下载没有在读取超时内失败");
        drop(release);
        server.join().unwrap();

        assert_eq!(received, PARTIAL.len(), "卡在正文中途，不是等响应头");
        let err = updater_error(
            code::UPDATE_DOWNLOAD_FAILED,
            "下载更新失败",
            None,
            tauri_plugin_updater::Error::Reqwest(stalled),
        );
        assert_eq!(err.code, code::UPDATE_DOWNLOAD_FAILED);
        assert_eq!(err.detail.unwrap()["network"], json!("timeout"));
    }

    /// 插件检查与下载用的客户端只走 https：明文地址当场拒掉，请求根本不发出去。跳转到 http 时拦在同一个开关上
    /// （reqwest 的跳转策略见到 https_only 就拒绝非 https 的下一跳），单测里起不了 https 的本地服务，只能验到这一层。
    /// 同一个本地服务用只套了超时的客户端是通的，拒掉它的正是这个开关。
    #[tokio::test]
    async fn the_plugin_client_only_speaks_https() {
        use wiremock::matchers::method;
        use wiremock::{Mock, MockServer, ResponseTemplate};

        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .respond_with(ResponseTemplate::new(200))
            .mount(&server)
            .await;
        let url = format!("{}/Petalfall-setup.exe", server.uri());
        let timeouts = (Duration::from_secs(5), Duration::from_secs(5));

        let plain = with_transfer_timeouts(ClientBuilder::new(), timeouts.0, timeouts.1)
            .build()
            .unwrap();
        let reached = plain.get(&url).send().await.unwrap();
        assert_eq!(reached.status().as_u16(), 200);

        let client = plugin_client(ClientBuilder::new(), timeouts.0, timeouts.1)
            .build()
            .unwrap();
        let refused = client.get(&url).send().await.unwrap_err();
        assert!(refused.is_builder(), "{refused:?}");
        assert_eq!(
            server.received_requests().await.unwrap().len(),
            1,
            "明文请求不该发到服务端"
        );
    }

    /// 测试用的卡死判定：10 秒窗口里不到 1000 字节算卡住。
    const TEST_WINDOW: Duration = Duration::from_secs(10);
    const TEST_MIN_BYTES: u64 = 1000;

    /// 卡死检查的外层时限：暂停的时钟下瞬间走完，只把「检查没起作用、永远等下去」变成失败。
    const NEVER: Duration = Duration::from_secs(3600);

    /// 正文还没开始（建连、跳转、等首字节）时不判卡死，等多久都不判：这一段归读取超时管。
    #[tokio::test(start_paused = true)]
    async fn waiting_for_the_first_chunk_is_never_a_stall() {
        let started = stall_clock();
        let stall = StallWatch::new(TEST_WINDOW, TEST_MIN_BYTES);
        let download = async {
            tokio::time::sleep(TEST_WINDOW * 5).await;
            "下完了"
        };
        let outcome = tokio::time::timeout(
            NEVER,
            unless_stalled(download, &stall, STALL_CHECK_INTERVAL),
        )
        .await
        .unwrap();
        assert_eq!(outcome, Some("下完了"));
        assert_eq!(stall_clock() - started, TEST_WINDOW * 5);
    }

    /// 窗口从第一块正文起算：第 5 秒来了一点就再没动静，看满第 5 秒之后的一个窗口才丢，不按开始下载的时刻算。
    #[tokio::test(start_paused = true)]
    async fn the_window_starts_at_the_first_chunk() {
        let started = stall_clock();
        let stall = StallWatch::new(TEST_WINDOW, TEST_MIN_BYTES);
        let first_chunk = Duration::from_secs(5);
        let download = async {
            tokio::time::sleep(first_chunk).await;
            stall.record(1, stall_clock());
            std::future::pending::<()>().await
        };
        let outcome = tokio::time::timeout(
            NEVER,
            unless_stalled(download, &stall, STALL_CHECK_INTERVAL),
        )
        .await
        .expect("停住的下载没有被丢掉");
        assert_eq!(outcome, None);
        let waited = stall_clock() - started;
        assert!(
            (first_chunk + TEST_WINDOW..=first_chunk + TEST_WINDOW + STALL_CHECK_INTERVAL)
                .contains(&waited),
            "{waited:?}"
        );
    }

    /// 下载完成与判卡死落在同一刻：先认下载的结果。只来了第一块就再没动静、恰好看满一个窗口时下完，
    /// 这一刻的检查本该判卡住，但下好的包不能丢。检查先被选中的话这条会挂，概率约一半。
    #[tokio::test(start_paused = true)]
    async fn a_download_finishing_as_the_window_closes_is_kept() {
        let stall = StallWatch::new(TEST_WINDOW, TEST_MIN_BYTES);
        let download = async {
            stall.record(1, stall_clock());
            tokio::time::sleep(TEST_WINDOW).await;
            assert!(stall.stalled(stall_clock()), "这一刻的检查本该判卡住");
            "下完了"
        };
        let outcome = tokio::time::timeout(
            NEVER,
            unless_stalled(download, &stall, STALL_CHECK_INTERVAL),
        )
        .await
        .unwrap();
        assert_eq!(outcome, Some("下完了"));
    }

    /// 下了一阵后停住：停满一个窗口之前不丢，停满之后的下一两次检查就丢。
    #[tokio::test(start_paused = true)]
    async fn a_download_that_stops_moving_is_dropped_a_window_later() {
        let started = stall_clock();
        let stall = StallWatch::new(TEST_WINDOW, TEST_MIN_BYTES);
        // 暂停的时钟下 sleep 只是排在定时器上的一个时刻，模拟每秒到一块。
        let download = async {
            for _ in 0..20 {
                tokio::time::sleep(Duration::from_secs(1)).await;
                stall.record(TEST_MIN_BYTES, stall_clock());
            }
            std::future::pending::<()>().await
        };
        let outcome = tokio::time::timeout(
            NEVER,
            unless_stalled(download, &stall, STALL_CHECK_INTERVAL),
        )
        .await
        .expect("停住的下载没有被丢掉");
        assert_eq!(outcome, None);
        let last_chunk = Duration::from_secs(20);
        let waited = stall_clock() - started;
        assert!(
            waited >= last_chunk + TEST_WINDOW,
            "停住不满一个窗口就丢了：{waited:?}"
        );
        assert!(
            waited <= last_chunk + TEST_WINDOW + 2 * STALL_CHECK_INTERVAL,
            "停住后迟迟不丢：{waited:?}"
        );
    }

    /// 慢但一直在动：下多久都不丢，下完照常交回结果。
    #[tokio::test(start_paused = true)]
    async fn a_slow_but_moving_download_is_never_dropped() {
        let started = stall_clock();
        let stall = StallWatch::new(TEST_WINDOW, TEST_MIN_BYTES);
        // 每秒 200 字节，任何一个 10 秒窗口里都有 2000 字节，是下限的两倍；一共下 10 个窗口。
        let download = async {
            for _ in 0..100 {
                tokio::time::sleep(Duration::from_secs(1)).await;
                stall.record(200, stall_clock());
            }
            "下完了"
        };
        let outcome = tokio::time::timeout(
            NEVER,
            unless_stalled(download, &stall, STALL_CHECK_INTERVAL),
        )
        .await
        .unwrap();
        assert_eq!(outcome, Some("下完了"));
        assert_eq!(stall_clock() - started, Duration::from_secs(100));
    }

    type UpdaterError = tauri_plugin_updater::Error;

    /// 一个源的剧本：先等 `head`（建连、跳转、等首字节），之后每秒到一块 `chunk` 字节、共 `chunks` 块，再按 `ending` 收尾。
    struct Script {
        head: Duration,
        chunk: usize,
        chunks: usize,
        ending: Ending,
    }

    enum Ending {
        /// 正文下完、验签通过，交回 [`package_from`] 这个源的包。
        Verified,
        /// 正文下完、验签不过：插件先报下载完成，再报这个错。
        Rejected(UpdaterError),
        /// 正文下完之前就出错：连不上、回了非 2xx。
        Failed(UpdaterError),
        /// 最后一块之后再不送数据，连接也不断。
        Hang,
    }

    impl Script {
        /// 一开始就有数据、按块下完、验签通过。
        fn steady(chunk: usize, chunks: usize) -> Self {
            Script {
                head: Duration::ZERO,
                chunk,
                chunks,
                ending: Ending::Verified,
            }
        }

        /// 一个字节都没收到就失败。
        fn failing(err: UpdaterError) -> Self {
            Script {
                head: Duration::ZERO,
                chunk: 0,
                chunks: 0,
                ending: Ending::Failed(err),
            }
        }

        /// 按块下完，字节或签名被插件拒掉。
        fn rejected(chunk: usize, chunks: usize, err: UpdaterError) -> Self {
            Script {
                ending: Ending::Rejected(err),
                ..Script::steady(chunk, chunks)
            }
        }
    }

    /// 插件对非 2xx 下载的报法。
    fn status(status: &str) -> UpdaterError {
        UpdaterError::Network(format!("Download request failed with status: {status}"))
    }

    /// 这个源的字节对不上签名。
    fn bad_bytes() -> UpdaterError {
        UpdaterError::Minisign(minisign_verify::Error::InvalidSignature)
    }

    /// 清单把旧版本的包配上了新版本号。
    fn downgrade() -> UpdaterError {
        UpdaterError::SignedVersionMismatch {
            signed: "0.1.0-dev.12".into(),
            announced: "0.1.0-dev.40".into(),
        }
    }

    /// 连一个刚关掉的本地端口，拿一份真的「连接被拒」。要在暂停时钟之前拿：暂停后等真实 I/O 时 tokio 会把时钟拨到
    /// 下一个定时器，连接超时可能抢在被拒之前到点。
    async fn refused() -> UpdaterError {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!(
            "http://127.0.0.1:{}/installer.exe",
            listener.local_addr().unwrap().port()
        );
        drop(listener);
        let err = petalfall_base::http::build_client()
            .unwrap()
            .get(&url)
            .send()
            .await
            .unwrap_err();
        UpdaterError::Reqwest(err)
    }

    /// 某个源下好、验签通过的包：带上源名，看得出交回的是哪个源的字节。
    fn package_from(source: &str) -> Vec<u8> {
        format!("signed installer from {source}").into_bytes()
    }

    /// 多源的假下载：每个源的地址各配一份剧本，记下按什么顺序、在什么时刻下过哪些源。剧本取一次就没了，
    /// 同一个源下第二次直接挂：换源的约定是同一个源不重试。
    #[derive(Clone)]
    struct FakePackage {
        url: Url,
        scripts: Arc<Mutex<HashMap<Url, (String, Script)>>>,
        calls: Arc<Mutex<Vec<(String, tokio::time::Instant)>>>,
    }

    impl FakePackage {
        /// 下过的源名，按开始的先后。
        fn called(&self) -> Vec<String> {
            let calls = self.calls.lock().unwrap();
            calls.iter().map(|(name, _)| name.clone()).collect()
        }

        /// 源 `name` 开始下载的时刻。
        fn started(&self, name: &str) -> tokio::time::Instant {
            let calls = self.calls.lock().unwrap();
            let (_, at) = calls
                .iter()
                .find(|(called, _)| called == name)
                .unwrap_or_else(|| panic!("{name} 没有下过"));
            *at
        }
    }

    impl PackageDownload for FakePackage {
        fn with_download_url(&self, url: &Url) -> Self {
            FakePackage {
                url: url.clone(),
                ..self.clone()
            }
        }

        fn download_package<C, D>(
            &self,
            mut on_chunk: C,
            on_download_finish: D,
        ) -> impl Future<Output = tauri_plugin_updater::Result<Vec<u8>>> + Send
        where
            C: FnMut(usize, Option<u64>) + Send,
            D: FnOnce() + Send,
        {
            let (name, script) = self
                .scripts
                .lock()
                .unwrap()
                .remove(&self.url)
                .unwrap_or_else(|| panic!("{} 没有剧本，或同一个源下了第二次", self.url));
            self.calls
                .lock()
                .unwrap()
                .push((name.clone(), tokio::time::Instant::now()));
            let Script {
                head,
                chunk,
                chunks,
                ending,
            } = script;
            let total = (chunk * chunks) as u64;
            async move {
                tokio::time::sleep(head).await;
                for _ in 0..chunks {
                    tokio::time::sleep(Duration::from_secs(1)).await;
                    on_chunk(chunk, Some(total));
                }
                match ending {
                    Ending::Verified => {
                        on_download_finish();
                        Ok(package_from(&name))
                    }
                    Ending::Rejected(err) => {
                        on_download_finish();
                        Err(err)
                    }
                    Ending::Failed(err) => Err(err),
                    Ending::Hang => std::future::pending().await,
                }
            }
        }
    }

    /// 按给出的先后排好的源，及给它们配好剧本的假下载。源名同时是地址的第一段路径；主机在解析清单时才查白名单，
    /// 这里不经过。假下载自己的地址没有剧本：不经换源、直接拿插件选中的地址去下就会挂。
    fn fake_sources(scripts: Vec<(&str, Script)>) -> (FakePackage, Vec<PackageSource>) {
        let mut sources = Vec::new();
        let mut by_url = HashMap::new();
        for (name, script) in scripts {
            let url = Url::parse(&format!("https://example.invalid/{name}/installer.exe")).unwrap();
            sources.push(PackageSource {
                name: name.to_owned(),
                url: url.clone(),
                region: SourceRegion::Domestic,
            });
            by_url.insert(url, (name.to_owned(), script));
        }
        let package = FakePackage {
            url: Url::parse("https://example.invalid/chosen-by-plugin.exe").unwrap(),
            scripts: Arc::new(Mutex::new(by_url)),
            calls: Arc::default(),
        };
        (package, sources)
    }

    /// 一次多源下载的结局：成功时是交回的字节与源名。
    type Outcome = Result<(Vec<u8>, String), CommandError>;

    /// 跑一遍多源下载，返回结局与推出的全部事件。清单一直没变，也不取消。
    async fn download_all(
        package: &FakePackage,
        sources: &[PackageSource],
        size: Option<u64>,
    ) -> (Outcome, Vec<CoreEvent>) {
        download_until(package, sources, size, &CancellationToken::new(), || Ok(())).await
    }

    async fn download_until(
        package: &FakePackage,
        sources: &[PackageSource],
        size: Option<u64>,
        cancel: &CancellationToken,
        still_current: impl Fn() -> Result<(), CommandError>,
    ) -> (Outcome, Vec<CoreEvent>) {
        let (sink, mut events) = tokio::sync::mpsc::unbounded_channel();
        let outcome = tokio::time::timeout(
            NEVER,
            download_with_progress(package, sources, size, &sink, cancel, still_current),
        )
        .await
        .expect("多源下载一直没有收场")
        .map(|(bytes, source)| (bytes, source.name.clone()));
        drop(sink);
        let mut received = Vec::new();
        while let Ok(event) = events.try_recv() {
            received.push(event);
        }
        (outcome, received)
    }

    /// 事件里看得出先后的那几条：换源、阶段、收尾快照（带有效字节）。中途的进度快照按真实时钟节流，条数不定，略去。
    fn milestones(events: &[CoreEvent]) -> Vec<String> {
        events
            .iter()
            .filter_map(|event| match event {
                CoreEvent::Source { index, count, name } => {
                    Some(format!("source {index}/{count} {name}"))
                }
                CoreEvent::Stage(stage) => Some(format!("stage {stage}")),
                CoreEvent::Download(progress) if progress.finished == 1 => {
                    Some(format!("done {}", progress.bytes))
                }
                CoreEvent::Download(_) => None,
                other => panic!("下载更新包不该推 {other:?}"),
            })
            .collect()
    }

    const VERIFYING: &str = "stage 更新包下载完成，正在校验签名";

    /// detail.sources 里每一条的（源名，失败种类）。
    fn failure_kinds(err: &CommandError) -> Vec<(String, String)> {
        let detail = err.detail.as_ref().expect("下载失败没有带 detail");
        detail["sources"]
            .as_array()
            .expect("detail.sources 不是数组")
            .iter()
            .map(|failure| {
                (
                    failure["source"].as_str().unwrap().to_owned(),
                    failure["failure"].as_str().unwrap().to_owned(),
                )
            })
            .collect()
    }

    fn pairs(expected: &[(&str, &str)]) -> Vec<(String, String)> {
        expected
            .iter()
            .map(|&(source, failure)| (source.to_owned(), failure.to_owned()))
            .collect()
    }

    /// 建连、跳转加等首字节用了 27 秒，之后按 20 KB/s 稳定下载：窗口从第一块正文算起，这样的下载照常下完。
    /// 窗口要是从开始下载算起，第 30 秒时窗口里只有三块共 60 KB，不到 64 KiB 的下限，就被当成卡死掐掉了。
    #[tokio::test(start_paused = true)]
    async fn a_late_first_byte_does_not_count_against_a_steady_download() {
        let (package, sources) = fake_sources(vec![(
            "default",
            Script {
                head: Duration::from_secs(27),
                ..Script::steady(20_000, 60)
            },
        )]);
        let (outcome, received) = download_all(&package, &sources, None).await;
        let (bytes, source) = outcome.expect("下完的包没有交回");
        assert_eq!(
            (bytes, source.as_str()),
            (package_from("default"), "default")
        );

        // 收尾两件事：告诉前端在验签，再推 finished = 1 的快照。
        let [.., CoreEvent::Stage(stage), CoreEvent::Download(done)] = received.as_slice() else {
            panic!("{received:?}");
        };
        assert_eq!(stage, "更新包下载完成，正在校验签名");
        assert_eq!(
            (done.finished, done.bytes, done.total_bytes),
            (1, 1_200_000, Some(1_200_000))
        );
    }

    /// 正文下到一半再不送数据：最后一块之后看满一个窗口就中止，记网络超时。判定器只能从插件的逐块回调里看到字节，
    /// 回调没把字节记给它时，它从不开始计时，这样的下载就会一直挂着。只有一个源时报错与第一批相同：原文就是
    /// 那个源的原文，`detail.network` 为 `timeout`，前端按网络超时的文案提示；另带上 `detail.sources`。
    #[tokio::test(start_paused = true)]
    async fn a_download_that_stops_mid_body_is_aborted_a_window_after_the_last_chunk() {
        let (package, sources) = fake_sources(vec![(
            "default",
            Script {
                head: Duration::from_secs(3),
                chunk: 100_000,
                chunks: 10,
                ending: Ending::Hang,
            },
        )]);
        let started = stall_clock();
        let (outcome, _) = download_all(&package, &sources, None).await;
        let err = outcome.unwrap_err();
        assert_eq!(err.code, code::UPDATE_DOWNLOAD_FAILED);
        assert_eq!(err.message, "下载长时间没有进展，已中止");
        assert_eq!(
            err.detail,
            Some(json!({
                "network": "timeout",
                "sources": [{
                    "source": "default",
                    "failure": "timeout",
                    "message": "下载长时间没有进展，已中止",
                }],
            }))
        );

        let last_chunk = Duration::from_secs(3 + 10);
        let waited = stall_clock() - started;
        assert!(
            waited >= last_chunk + STALL_WINDOW,
            "停住不满一个窗口就中止了：{waited:?}"
        );
        assert!(
            waited <= last_chunk + STALL_WINDOW + 2 * STALL_CHECK_INTERVAL,
            "停住后迟迟不中止：{waited:?}"
        );
    }

    /// 第一个源回了 503：换到第二个源，交回的是第二个源的字节。每个源开始前各推一条换源事件，第一个也推，
    /// 之后才是第二个源的验签与收尾快照。
    #[tokio::test(start_paused = true)]
    async fn a_failed_source_hands_over_to_the_next_one() {
        let (package, sources) = fake_sources(vec![
            ("cn", Script::failing(status("503 Service Unavailable"))),
            ("hk", Script::steady(1000, 3)),
        ]);
        let (outcome, received) = download_all(&package, &sources, None).await;
        let (bytes, source) = outcome.unwrap();
        assert_eq!((bytes, source.as_str()), (package_from("hk"), "hk"));
        assert_eq!(package.called(), ["cn", "hk"]);
        assert_eq!(
            milestones(&received),
            ["source 0/2 cn", "source 1/2 hk", VERIFYING, "done 3000"]
        );
    }

    /// 第一个源的字节对不上签名：只说明这个源上的文件不对，换下一个源。进度每个源从零算，收尾快照只有第二个源的字节，
    /// 不把第一个源白下的那些算进去。
    #[tokio::test(start_paused = true)]
    async fn bytes_failing_the_signature_move_on_and_progress_restarts_per_source() {
        let (package, sources) = fake_sources(vec![
            ("cn", Script::rejected(4000, 3, bad_bytes())),
            ("hk", Script::steady(1000, 2)),
        ]);
        let (outcome, received) = download_all(&package, &sources, None).await;
        assert_eq!(outcome.unwrap(), (package_from("hk"), "hk".to_owned()));
        assert_eq!(package.called(), ["cn", "hk"]);
        assert_eq!(
            milestones(&received),
            [
                "source 0/2 cn",
                VERIFYING,
                "source 1/2 hk",
                VERIFYING,
                "done 2000"
            ]
        );
    }

    /// 第一个源下了几块后停住：看满一个窗口就换源，不等读取超时之外的任何东西。第二个源的卡死检测从头算：它还在等首字节
    /// 的那几秒不能算成没有进展，沿用上一个源的检测的话，窗口早就看满了，第二个源一开始就会被判卡死。
    #[tokio::test(start_paused = true)]
    async fn a_stalled_source_is_left_a_window_after_its_last_chunk() {
        let (package, sources) = fake_sources(vec![
            (
                "cn",
                Script {
                    head: Duration::from_secs(2),
                    chunk: 100_000,
                    chunks: 5,
                    ending: Ending::Hang,
                },
            ),
            (
                "hk",
                Script {
                    head: Duration::from_secs(3),
                    ..Script::steady(100_000, 2)
                },
            ),
        ]);
        let started = tokio::time::Instant::now();
        let (outcome, _) = download_all(&package, &sources, None).await;
        assert_eq!(outcome.unwrap(), (package_from("hk"), "hk".to_owned()));

        let last_chunk = Duration::from_secs(2 + 5);
        let switched = package.started("hk") - started;
        assert!(
            switched >= last_chunk + STALL_WINDOW,
            "停住不满一个窗口就换源了：{switched:?}"
        );
        assert!(
            switched <= last_chunk + STALL_WINDOW + 2 * STALL_CHECK_INTERVAL,
            "停住后迟迟不换源：{switched:?}"
        );
    }

    /// 签名串不合规、签名版本与清单不符、签名没带版本、签名用的不是内置公钥那把钥匙：问题出在清单，换哪个源都是
    /// 同一个签名，后面的源一次都不试，报签名无效，原文是插件的原文。
    #[tokio::test(start_paused = true)]
    async fn signature_problems_of_the_manifest_stop_at_the_first_source() {
        let rejections: [fn() -> UpdaterError; 5] = [
            downgrade,
            || UpdaterError::MissingSignedVersion,
            || UpdaterError::SignatureUtf8("bad".into()),
            || UpdaterError::Minisign(minisign_verify::Error::UnexpectedKeyId),
            // 清单的签名串本身不是合法 base64：插件用同一个 STANDARD 引擎解它时报的就是这个。
            || {
                UpdaterError::Base64(
                    base64::Engine::decode(&base64::engine::general_purpose::STANDARD, "@")
                        .unwrap_err(),
                )
            },
        ];
        for rejected in rejections {
            let raw = rejected().to_string();
            let (package, sources) = fake_sources(vec![
                ("cn", Script::rejected(1000, 2, rejected())),
                ("hk", Script::steady(1000, 2)),
            ]);
            let (outcome, _) = download_all(&package, &sources, None).await;
            let err = outcome.unwrap_err();
            assert_eq!(package.called(), ["cn"], "{raw}");
            assert_eq!(err.code, code::UPDATE_SIGNATURE_INVALID, "{raw}");
            assert_eq!(err.message, raw);
            assert_eq!(
                err.detail,
                Some(json!({
                    "sources": [{ "source": "cn", "failure": "signature", "message": raw }],
                })),
                "{raw}"
            );
        }
    }

    /// 下到一半用户取消：立即报取消，正在下的源随即丢下，后面的源一次都不试。
    #[tokio::test(start_paused = true)]
    async fn cancelling_stops_without_trying_other_sources() {
        let (package, sources) = fake_sources(vec![
            (
                "cn",
                Script {
                    head: Duration::from_secs(1),
                    ..Script::steady(1000, 100)
                },
            ),
            ("hk", Script::steady(1000, 2)),
        ]);
        let cancel = CancellationToken::new();
        let cancel_at = Duration::from_secs(5);
        let started = tokio::time::Instant::now();
        let ((outcome, _), ()) = tokio::join!(
            download_until(&package, &sources, None, &cancel, || Ok(())),
            async {
                tokio::time::sleep(cancel_at).await;
                cancel.cancel();
            }
        );
        assert!(outcome.unwrap_err().is_cancelled());
        assert_eq!(started.elapsed(), cancel_at, "取消后没有立即返回");
        assert_eq!(package.called(), ["cn"]);
    }

    /// 取消先于下载到达（TaskHandle::run 在宽限期里照样跑下载一次）：一条换源事件都不推，一个源都不下，直接报取消。
    #[tokio::test(start_paused = true)]
    async fn a_download_cancelled_before_it_starts_announces_no_source() {
        let (package, sources) = fake_sources(vec![
            ("cn", Script::steady(1000, 2)),
            ("hk", Script::steady(1000, 2)),
        ]);
        let cancel = CancellationToken::new();
        cancel.cancel();
        let (outcome, received) =
            download_until(&package, &sources, None, &cancel, || Ok(())).await;
        assert!(outcome.unwrap_err().is_cancelled());
        assert!(received.is_empty(), "{received:?}");
        assert!(package.called().is_empty());
    }

    /// 下载前的几步（重查、排序）跑到一半用户取消：当场丢下，报取消，不等它自己结束；已经取消了就根本不开始。
    #[tokio::test(start_paused = true)]
    async fn a_step_before_the_download_stops_at_cancel() {
        let cancel = CancellationToken::new();
        let cancel_at = Duration::from_secs(1);
        let started = tokio::time::Instant::now();
        let (outcome, ()) = tokio::join!(
            unless_cancelled(&cancel, async {
                // 两个清单端点各等满总时限、再各问一次状态码
                tokio::time::sleep(CHECK_TIMEOUT * 4).await;
                Ok("重查完了")
            }),
            async {
                tokio::time::sleep(cancel_at).await;
                cancel.cancel();
            }
        );
        assert!(outcome.unwrap_err().is_cancelled());
        assert_eq!(started.elapsed(), cancel_at, "取消后没有立即返回");

        let ran = std::cell::Cell::new(false);
        let outcome = unless_cancelled(&cancel, async {
            ran.set(true);
            Ok(())
        })
        .await;
        assert!(outcome.unwrap_err().is_cancelled());
        assert!(!ran.get(), "已经取消了还开始跑");

        let live = CancellationToken::new();
        assert_eq!(
            unless_cancelled(&live, async { Ok("重查完了") })
                .await
                .unwrap(),
            "重查完了"
        );
    }

    /// 第一个源失败时，下载期间的一次检查已经换了版本：换源之前问一句槽位，报没有可用更新，不再从下一个源白下一遍。
    /// 第一个源开始前不问：重查刚确认过。检查结果没变时照常换源。
    #[tokio::test(start_paused = true)]
    async fn a_changed_manifest_stops_before_the_next_source() {
        let slot = Mutex::new(UpdateSlot::<Fake>::default());
        let found = |version| {
            let mut slot = slot.lock().unwrap();
            let ticket = slot.generation();
            let candidate = Candidate {
                update: Fake(version),
                channel: Channel::Stable,
            };
            slot.settle_check(ticket, Vec::new(), CheckConclusion::Found(candidate))
                .unwrap();
        };
        found("0.2.0");
        let downloading = Candidate {
            update: Fake("0.2.0"),
            channel: Channel::Stable,
        };
        let still_current = || {
            slot.lock()
                .unwrap()
                .ensure_current(&downloading)
                .map_err(CommandError::from)
        };
        let fixture = || {
            fake_sources(vec![
                ("cn", Script::failing(status("404 Not Found"))),
                ("hk", Script::steady(1000, 2)),
            ])
        };

        let (package, sources) = fixture();
        let cancel = CancellationToken::new();
        let (outcome, _) = download_until(&package, &sources, None, &cancel, still_current).await;
        assert_eq!(outcome.unwrap(), (package_from("hk"), "hk".to_owned()));

        found("0.2.1");
        let (package, sources) = fixture();
        let (outcome, _) = download_until(&package, &sources, None, &cancel, still_current).await;
        let err = outcome.unwrap_err();
        assert_eq!(err.code, code::UPDATE_NOT_AVAILABLE);
        assert!(err.message.contains("0.2.1"), "{}", err.message);
        assert!(err.message.contains("0.2.0"), "{}", err.message);
        assert_eq!(package.called(), ["cn"]);
    }

    /// 一个源不停地吐数据：累计字节一越过清单声明的大小就在那一块丢掉它、换下一个源，不等它把内存吃满。
    /// 正好等于声明大小的不算超。
    #[tokio::test(start_paused = true)]
    async fn an_endless_source_is_cut_off_at_the_chunk_past_the_size() {
        let (package, sources) = fake_sources(vec![
            ("cn", Script::steady(4000, 1000)),
            ("hk", Script::steady(5000, 2)),
        ]);
        let started = tokio::time::Instant::now();
        let (outcome, received) = download_all(&package, &sources, Some(10_000)).await;
        assert_eq!(outcome.unwrap(), (package_from("hk"), "hk".to_owned()));
        // 第 3 秒的那一块把累计推到 12000，越过了 10000。
        assert_eq!(package.started("hk") - started, Duration::from_secs(3));
        assert_eq!(
            milestones(&received),
            ["source 0/2 cn", "source 1/2 hk", VERIFYING, "done 10000"]
        );
    }

    /// 越过声明大小的那一块正好是最后一块、插件当场下完：照样算超，不因为恰好读完了就收下。
    #[tokio::test(start_paused = true)]
    async fn a_download_finishing_past_the_size_is_still_too_large() {
        let (package, sources) = fake_sources(vec![("cn", Script::steady(4000, 3))]);
        let (outcome, _) = download_all(&package, &sources, Some(10_000)).await;
        let err = outcome.unwrap_err();
        assert_eq!(err.code, code::UPDATE_DOWNLOAD_FAILED);
        assert_eq!(failure_kinds(&err), pairs(&[("cn", "too_large")]));
        assert!(err.detail.unwrap().get("network").is_none());
    }

    /// 四个源各败各的：逐个试完才报下载失败，detail.sources 按尝试的先后逐个列出源名与失败种类；有不在网络层的失败，
    /// 就不标 detail.network。原文逐行写成「源名：原文」。
    #[tokio::test]
    async fn when_every_source_fails_the_error_lists_each_one() {
        let refused = refused().await;
        let refused_raw = refused.to_string();
        tokio::time::pause();
        let (package, sources) = fake_sources(vec![
            ("cn", Script::failing(status("503 Service Unavailable"))),
            ("hk", Script::failing(refused)),
            (
                "global",
                Script {
                    ending: Ending::Hang,
                    ..Script::steady(1000, 1)
                },
            ),
            ("github", Script::steady(4000, 3)),
        ]);
        let (outcome, received) = download_all(&package, &sources, Some(10_000)).await;
        let err = outcome.unwrap_err();
        assert_eq!(package.called(), ["cn", "hk", "global", "github"]);
        assert_eq!(err.code, code::UPDATE_DOWNLOAD_FAILED);
        assert_eq!(
            failure_kinds(&err),
            pairs(&[
                ("cn", "http"),
                ("hk", "connect"),
                ("global", "timeout"),
                ("github", "too_large"),
            ])
        );
        assert!(err.detail.as_ref().unwrap().get("network").is_none());
        let lines: Vec<&str> = err.message.lines().collect();
        assert_eq!(lines.len(), 4, "{}", err.message);
        assert_eq!(
            lines[0],
            "cn：`Download request failed with status: 503 Service Unavailable`"
        );
        assert_eq!(lines[1], format!("hk：{refused_raw}"));
        assert!(lines[2].starts_with("global："), "{}", lines[2]);
        assert!(lines[3].starts_with("github："), "{}", lines[3]);
        assert_eq!(
            milestones(&received)
                .into_iter()
                .filter(|milestone| milestone.starts_with("source "))
                .collect::<Vec<_>>(),
            [
                "source 0/4 cn",
                "source 1/4 hk",
                "source 2/4 global",
                "source 3/4 github"
            ]
        );
    }

    /// 全都败在网络层：混着连不上就标 connect，全是超时才标 timeout，前端据此提示检查网络。
    #[tokio::test]
    async fn sources_failing_only_on_the_network_mark_detail_network() {
        let refused = refused().await;
        tokio::time::pause();
        let hang = || Script {
            ending: Ending::Hang,
            ..Script::steady(1000, 1)
        };

        let (package, sources) =
            fake_sources(vec![("hk", Script::failing(refused)), ("global", hang())]);
        let (outcome, _) = download_all(&package, &sources, None).await;
        let err = outcome.unwrap_err();
        assert_eq!(err.code, code::UPDATE_DOWNLOAD_FAILED);
        assert_eq!(
            failure_kinds(&err),
            pairs(&[("hk", "connect"), ("global", "timeout")])
        );
        assert_eq!(err.detail.unwrap()["network"], json!("connect"));

        let (package, sources) = fake_sources(vec![("global", hang()), ("github", hang())]);
        let (outcome, _) = download_all(&package, &sources, None).await;
        let err = outcome.unwrap_err();
        assert_eq!(err.detail.unwrap()["network"], json!("timeout"));
    }

    /// 每个源的字节都对不上签名：试完全部源，报签名无效；混着别的失败时只算下载失败。
    #[tokio::test(start_paused = true)]
    async fn every_source_rejecting_its_bytes_reads_as_an_invalid_signature() {
        let (package, sources) = fake_sources(vec![
            ("cn", Script::rejected(1000, 2, bad_bytes())),
            ("hk", Script::rejected(1000, 2, bad_bytes())),
        ]);
        let (outcome, _) = download_all(&package, &sources, None).await;
        let err = outcome.unwrap_err();
        assert_eq!(package.called(), ["cn", "hk"]);
        assert_eq!(err.code, code::UPDATE_SIGNATURE_INVALID);
        assert_eq!(
            failure_kinds(&err),
            pairs(&[("cn", "signature"), ("hk", "signature")])
        );

        let (package, sources) = fake_sources(vec![
            ("cn", Script::rejected(1000, 2, bad_bytes())),
            ("hk", Script::failing(status("502 Bad Gateway"))),
        ]);
        let (outcome, _) = download_all(&package, &sources, None).await;
        assert_eq!(outcome.unwrap_err().code, code::UPDATE_DOWNLOAD_FAILED);
    }

    /// 第一个源回了 503 换源，第二个源碰上签名版本与清单不符：问题出在清单，立即停、第三个源不再试；前一个源败在
    /// HTTP 层也不改变结论，报签名无效。detail.sources 按尝试的先后列出这两条，判定不进去。
    #[tokio::test(start_paused = true)]
    async fn a_manifest_signature_problem_after_switching_sources_is_still_an_invalid_signature() {
        let raw = downgrade().to_string();
        let unavailable = "`Download request failed with status: 503 Service Unavailable`";
        let (package, sources) = fake_sources(vec![
            ("cn", Script::failing(status("503 Service Unavailable"))),
            ("hk", Script::rejected(1000, 2, downgrade())),
            ("global", Script::steady(1000, 2)),
        ]);
        let (outcome, _) = download_all(&package, &sources, None).await;
        let err = outcome.unwrap_err();
        assert_eq!(package.called(), ["cn", "hk"]);
        assert_eq!(err.code, code::UPDATE_SIGNATURE_INVALID);
        assert_eq!(err.message, format!("cn：{unavailable}\nhk：{raw}"));
        assert_eq!(
            err.detail,
            Some(json!({
                "sources": [
                    { "source": "cn", "failure": "http", "message": unavailable },
                    { "source": "hk", "failure": "signature", "message": raw },
                ],
            }))
        );
    }

    /// 门面排好的先后带回到清单解析出的源上：每个地址仍跟着自己的源名，一个不多、一个不少。客户端只按源名排规范
    /// 顺序，与清单里的先后无关：同一组源换几种写法，排出来都一样。
    #[tokio::test]
    async fn sources_are_ordered_by_the_download_source_policy() {
        use petalfall_core::{DownloadSourcePolicy, Petalfall, PetalfallConfig};

        let listed_as = |names: [&str; 4]| -> Vec<PackageSource> {
            names
                .into_iter()
                .map(|name| PackageSource {
                    name: name.to_owned(),
                    url: Url::parse(&format!("https://example.invalid/{name}/installer.exe"))
                        .unwrap(),
                    region: match name {
                        "cn" | "hk" => SourceRegion::Domestic,
                        _ => SourceRegion::Overseas,
                    },
                })
                .collect()
        };
        // 规范顺序、整个倒过来、两组交错：按清单先后排的话，后两种在两档下都排不出规范结果。
        let listings = [
            listed_as(["cn", "hk", "global", "github"]),
            listed_as(["github", "global", "hk", "cn"]),
            listed_as(["hk", "github", "cn", "global"]),
        ];
        // 非自动档不探测，不会真去连这些地址。
        for (policy, expected) in [
            (
                DownloadSourcePolicy::OfficialFirst,
                ["global", "github", "hk", "cn"],
            ),
            (
                DownloadSourcePolicy::MirrorFirst,
                ["cn", "hk", "global", "github"],
            ),
        ] {
            let dir = tempfile::tempdir().unwrap();
            let config = PetalfallConfig {
                download_source: policy,
                ..PetalfallConfig::default()
            };
            let facade = Facade::new(
                Petalfall::open(
                    config,
                    dir.path().to_path_buf(),
                    dir.path().join("config.json"),
                )
                .unwrap(),
            );
            for listed in &listings {
                let ordered = ordered_sources(&facade, listed.clone()).await;
                let names: Vec<&str> = ordered.iter().map(|source| source.name.as_str()).collect();
                assert_eq!(names, expected, "{policy:?} {listed:?}");
                for source in &ordered {
                    let original = listed
                        .iter()
                        .find(|listed| listed.name == source.name)
                        .unwrap();
                    assert_eq!(source, original, "{policy:?}");
                }
            }
        }
    }

    /// 清单扩展键是 CI 写、客户端读：任何一边改了键名，客户端就悄悄退回只用 `url` 一个源、也不设大小上限，
    /// 哪里都不报错。客户端这边用 [`package_plan`] 真去读这两个键，CI 那边找生成清单的那两行；香港的 dev 清单地址
    /// 同样两头钉住：CI 回读核对的必须正是客户端先问的那个地址。
    #[test]
    fn ci_writes_the_extension_keys_the_client_reads() {
        const SOURCES_KEY: &str = "x-sources";
        const SIZE_KEY: &str = "x-size";
        let cn = format!(
            "https://{}/dev/0.1.0-dev.36-1/installer.exe",
            crate::commands::update_sources::ALLOWED_SOURCE_HOSTS[0]
        );
        let github = format!(
            "{}/releases/download/dev-build/installer.exe",
            petalfall_base::brand::REPO_URL
        );
        let manifest = json!({ "platforms": { "windows-x86_64": {
            "signature": "sig",
            "url": cn,
            SIZE_KEY: 22_846_361,
            SOURCES_KEY: [{ "name": "cn", "url": cn }, { "name": "github", "url": github }],
        }}});
        let plan = package_plan(&manifest, &Url::parse(&cn).unwrap(), "sig").unwrap();
        assert_eq!(plan.size, Some(22_846_361));
        let names: Vec<&str> = plan
            .sources
            .iter()
            .map(|source| source.name.as_str())
            .collect();
        assert_eq!(names, ["cn", "github"]);

        let github_dir = concat!(env!("CARGO_MANIFEST_DIR"), "/../../.github");
        let read = |path: &std::path::Path| {
            std::fs::read_to_string(path).unwrap_or_else(|err| panic!("{}: {err}", path.display()))
        };
        // 只看真正执行的行：注释里也写着这些键和地址，拿全文找子串的话，删掉真正的写入照样能过。
        let code_lines = |text: &str| -> Vec<String> {
            text.lines()
                .map(str::trim)
                .filter(|line| !line.starts_with('#') && !line.starts_with("//"))
                .map(str::to_owned)
                .collect()
        };
        let mut scripts = Vec::new();
        for entry in std::fs::read_dir(format!("{github_dir}/scripts")).unwrap() {
            let path = entry.unwrap().path();
            // 子目录里放的是测试夹具，不是流水线执行的脚本。
            if path.is_dir() {
                continue;
            }
            let name = path.file_name().unwrap().to_string_lossy().into_owned();
            if !name.contains(".test.") {
                scripts.extend(code_lines(&read(&path)));
            }
        }
        for key in [SOURCES_KEY, SIZE_KEY] {
            let written = format!("\"{key}\":");
            assert!(
                scripts.iter().any(|line| line.starts_with(&written)),
                "CI 生成清单时不再写 {key}"
            );
        }

        // 两个作业各有一行同名的 env 和一条读这个地址的 curl：按作业切开再找，否则 publish 里版本检查的那两行就能
        // 顶替 publish-hk 推送后的回读，回读整步删掉或地址改错都不会挂。
        let workflow = read(std::path::Path::new(&format!(
            "{github_dir}/workflows/dev-build.yml"
        )));
        let hk_manifest_url = format!("HK_MANIFEST_URL: {DEV_ENDPOINT}");
        let reads_hk_manifest =
            |line: &String| line.contains("curl ") && line.contains("\"$HK_MANIFEST_URL\"");

        let publish_hk = code_lines(&workflow_job(&workflow, "publish-hk"));
        assert!(
            publish_hk.contains(&hk_manifest_url),
            "publish-hk 回读的香港清单地址不再是客户端先问的 {DEV_ENDPOINT}"
        );
        assert!(
            publish_hk
                .iter()
                .any(|line| reads_hk_manifest(line)
                    && line.contains("--write-out '%{content_type}'")),
            "publish-hk 推送之后不再经公网回读香港清单、核对 Content-Type"
        );

        let publish = code_lines(&workflow_job(&workflow, "publish"));
        assert!(
            publish.contains(&hk_manifest_url),
            "publish 版本检查读的香港清单地址不再是客户端先问的 {DEV_ENDPOINT}"
        );
        assert!(
            publish.iter().any(reads_hk_manifest),
            "publish 不再读香港清单检查版本号有没有倒退"
        );
    }

    /// 工作流 `jobs` 下作业 `name` 的那一段：从 `  name:` 那一行起，到下一个同级作业或顶层键之前为止。
    fn workflow_job(workflow: &str, name: &str) -> String {
        let header = format!("  {name}:");
        let mut lines = workflow
            .lines()
            .skip_while(|line| line.trim_end() != header);
        let first = lines
            .next()
            .unwrap_or_else(|| panic!("工作流里找不到作业 {name}"));
        let sibling = |line: &&str| {
            let content = line.trim_start();
            let indent = line.len() - content.len();
            indent <= 2 && !content.is_empty() && !content.starts_with('#')
        };
        std::iter::once(first)
            .chain(lines.take_while(|line| !sibling(line)))
            .collect::<Vec<_>>()
            .join("\n")
    }

    /// 插件拉起安装程序之前已经藏了窗口：「立即安装」失败时交给 [`install_after_persisting`] 的必须是真去显示主窗口的
    /// 那个 future。换成空的 future 编译照过、上面的用例也照过，用户却会看着落樱像是自己退出了，所以钉住源码。
    /// 主窗口是否真的显示出来，单测里没有 tauri 的事件循环，只能在沙箱或手工验证。
    #[test]
    fn a_failed_install_now_reshows_the_main_window() {
        let (source, _) = include_str!("updater.rs")
            .split_once("#[cfg(test)]")
            .unwrap();
        let install_update = top_level_fn(source, "pub async fn install_update(");
        assert!(
            install_update.contains("install_after_persisting("),
            "{install_update}"
        );
        assert!(
            install_update.contains("reshow_after_failed_install(&app)"),
            "{install_update}"
        );
        let reshow = top_level_fn(source, "async fn reshow_after_failed_install(");
        assert!(
            reshow.contains("crate::window::reshow_main_window(app).await"),
            "{reshow}"
        );
    }

    /// 命令层的接线单测里造不出来（要 AppHandle 与插件的 Update），钉住源码：下载前的重查与排序必须包在
    /// [`unless_cancelled`] 里，否则取消要等它们自己结束；检查器必须用 [`plugin_client`] 建客户端，否则只剩超时、
    /// 跟得到 http 跳转。两个函数各自的行为由上面的用例验证。
    #[test]
    fn download_steps_watch_the_token_and_checkers_use_the_plugin_client() {
        let (source, _) = include_str!("updater.rs")
            .split_once("#[cfg(test)]")
            .unwrap();
        let download_update = top_level_fn(source, "pub async fn download_update(");
        for step in [
            "unless_cancelled(token, fetch_conclusion(&app)).await?",
            "unless_cancelled(token, download_plan(&facade, update)).await?",
        ] {
            assert!(download_update.contains(step), "{step}\n{download_update}");
        }
        let checker = top_level_fn(source, "fn channel_builder(");
        assert!(
            checker
                .contains(".configure_client(move |client| plugin_client(client, connect, read))"),
            "{checker}"
        );
        let fetch = top_level_fn(source, "async fn fetch_conclusion(");
        assert!(
            fetch.contains("check_checker(app, channel, endpoint)"),
            "{fetch}"
        );
    }

    /// 外壳的非测试代码（app/src-tauri/src 下各文件去掉测试模块与整行注释）里的代码行，带上文件路径。
    fn shell_code_lines() -> Vec<(String, String)> {
        fn visit(dir: &std::path::Path, lines: &mut Vec<(String, String)>) {
            for entry in std::fs::read_dir(dir).unwrap() {
                let path = entry.unwrap().path();
                if path.is_dir() {
                    visit(&path, lines);
                    continue;
                }
                if path.extension().is_none_or(|extension| extension != "rs") {
                    continue;
                }
                let text = std::fs::read_to_string(&path).unwrap();
                let all: Vec<&str> = text.lines().map(str::trim).collect();
                // 测试模块都在文件末尾：`#[cfg(test)]` 紧跟一行 `mod` 声明，从那里截断。
                let end = all
                    .windows(2)
                    .position(|pair| {
                        pair[0] == "#[cfg(test)]"
                            && (pair[1].starts_with("mod ")
                                || pair[1].starts_with("pub(crate) mod ")
                                || pair[1].starts_with("pub mod "))
                    })
                    .unwrap_or(all.len());
                let file = path.display().to_string();
                lines.extend(
                    all[..end]
                        .iter()
                        .filter(|line| !line.starts_with("//"))
                        .map(|line| (file.clone(), (*line).to_owned())),
                );
            }
        }
        let mut lines = Vec::new();
        visit(
            std::path::Path::new(concat!(env!("CARGO_MANIFEST_DIR"), "/src")),
            &mut lines,
        );
        assert!(
            lines
                .iter()
                .any(|(_, line)| line.starts_with("pub fn detect_support(")),
            "没读到 updater.rs 的源码"
        );
        lines
    }

    /// 外壳非测试代码里 `needle` 出现的次数，按文件列出。
    fn occurrences(lines: &[(String, String)], needle: &str) -> Vec<(String, usize)> {
        let mut found: Vec<(String, usize)> = Vec::new();
        for (file, line) in lines {
            let count = line.matches(needle).count();
            if count == 0 {
                continue;
            }
            match found.iter_mut().find(|(seen, _)| seen == file) {
                Some((_, total)) => *total += count,
                None => found.push((file.clone(), count)),
            }
        }
        found
    }

    /// 检查器只从 [`channel_builder`] 起步、同一处显式带上所问通道的公钥：别处另建检查器就会沿用插件配置里注入的
    /// 那一把（本包通道的钥），跟随别的通道时验不过，或者反过来拿错的钥认了别的通道的包。比较器只设在
    /// [`check_checker`]，插件默认的 `.updater()` 一处都不用。换通道用的安装参数与「装完不重开」这一期都还没有，
    /// 一处都不该出现：插件会把它们带进下载出来的每一个包。各函数的行为单测里造不出来（要 AppHandle），钉住源码。
    #[test]
    fn checkers_start_from_one_builder_that_names_the_channel_key() {
        let lines = shell_code_lines();
        let (source, _) = include_str!("updater.rs")
            .split_once("#[cfg(test)]")
            .unwrap();
        let in_updater = |count: usize| vec![(updater_rs_path(&lines), count)];

        assert_eq!(occurrences(&lines, "updater_builder()"), in_updater(1));
        let builder = top_level_fn(source, "fn channel_builder(");
        assert!(builder.contains("updater_builder()"), "{builder}");
        assert!(
            builder.contains(".pubkey(channel_pubkey(channel))"),
            "{builder}"
        );

        assert_eq!(occurrences(&lines, ".updater()"), Vec::new());

        let comparators = occurrences(&lines, "version_comparator(");
        let checker = top_level_fn(source, "fn check_checker(");
        assert_eq!(
            comparators,
            in_updater(checker.matches("version_comparator(").count())
        );
        assert_eq!(
            checker.matches("version_comparator(").count(),
            1,
            "{checker}"
        );

        for absent in ["installer_arg", "restart_after_install("] {
            assert_eq!(occurrences(&lines, absent), Vec::new(), "{absent}");
        }
    }

    /// 读到的源码里 updater.rs 那一个文件的路径。
    fn updater_rs_path(lines: &[(String, String)]) -> String {
        lines
            .iter()
            .find(|(_, line)| line.starts_with("pub fn detect_support("))
            .map(|(file, _)| file.clone())
            .unwrap()
    }

    /// 自动检查的比较器只认严格新于当前版本的清单，按 semver 优先级比：相等、更旧、只差构建元数据的都不造更新。
    #[test]
    fn the_check_comparator_takes_only_strictly_newer_versions() {
        let release = |version: &str| RemoteRelease {
            version: Version::parse(version).unwrap(),
            notes: None,
            pub_date: None,
            data: tauri_plugin_updater::RemoteReleaseInner::Dynamic(
                tauri_plugin_updater::ReleaseManifestPlatform {
                    url: Url::parse("https://petalfall.org/updates/dev/installer.exe").unwrap(),
                    signature: "sig".to_owned(),
                },
            ),
        };
        let current = Version::parse("1.0.0-dev.12").unwrap();
        for (offered, newer) in [
            ("1.0.0-dev.13", true),
            ("1.0.0-dev.120", true),
            ("1.0.0", true),
            ("1.1.0-beta.1", true),
            ("1.0.0-dev.12", false),
            ("1.0.0-dev.12+ci.7", false),
            ("1.0.0-dev.11", false),
            ("1.0.0-beta.99", false),
            ("0.9.0", false),
        ] {
            assert_eq!(
                strictly_newer(&current, &release(offered)),
                newer,
                "{offered}"
            );
        }
    }

    /// 取端点与支持判定都按应用自己的版本号认通道，接线要 AppHandle 与 tauri 上下文，单测造不出来，钉住源码：
    /// 取端点必须经 [`version_endpoints`]，认不出通道时报错，不拿默认通道顶上；lib.rs 给 [`detect_support`] 传的
    /// 必须是应用版本的预发布标识，写死的话认不出通道的版本也会注册插件、显示更新入口，到检查时才报不支持。
    /// 两个函数的行为由上面的用例验证。
    #[test]
    fn channel_is_read_from_the_app_version() {
        let (source, _) = include_str!("updater.rs")
            .split_once("#[cfg(test)]")
            .unwrap();
        let fetch = top_level_fn(source, "async fn fetch_conclusion(");
        assert!(
            fetch.contains(
                "let (channel, endpoints) = version_endpoints(app.package_info().version.pre.as_str())?;"
            ),
            "{fetch}"
        );
        let (_, call) = include_str!("../lib.rs")
            .split_once("commands::updater::detect_support(")
            .expect("lib.rs 不再调 detect_support");
        let (args, _) = call.split_once(");").unwrap();
        assert!(
            args.contains("context.package_info().version.pre.as_str()"),
            "{args}"
        );
    }

    /// `source` 里签名行以 `signature` 开头的顶层函数，从签名行到收尾那一行 `}`。
    fn top_level_fn(source: &str, signature: &str) -> String {
        let mut body = Vec::new();
        for line in source
            .lines()
            .skip_while(|line| !line.starts_with(signature))
        {
            body.push(line);
            if line.trim_end() == "}" {
                break;
            }
        }
        assert!(!body.is_empty(), "找不到 {signature}");
        body.join("\n")
    }

    /// 更新源都连不上时插件把最后一个 reqwest 错误包成 `Reqwest` 返回；它是 transparent 变体，
    /// 顺着 source 链往下走会跳过 reqwest 那一层，所以要单独认出来标 detail.network。
    #[tokio::test]
    async fn unreachable_update_endpoints_are_marked_as_network_failures() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!(
            "http://127.0.0.1:{}/latest.json",
            listener.local_addr().unwrap().port()
        );
        drop(listener);
        let refused = petalfall_base::http::build_client()
            .unwrap()
            .get(&url)
            .send()
            .await
            .unwrap_err();
        let endpoints = vec![PRIMARY_ENDPOINT.to_owned()];

        let err = updater_error(
            code::UPDATE_CHECK_FAILED,
            "检查更新失败",
            Some(&endpoints),
            tauri_plugin_updater::Error::Reqwest(refused),
        );
        assert_eq!(err.code, code::UPDATE_CHECK_FAILED);
        assert_eq!(err.detail.unwrap()["network"], json!("connect"));

        // 拿到了响应但内容不对：网络是通的。
        let err = updater_error(
            code::UPDATE_CHECK_FAILED,
            "检查更新失败",
            Some(&endpoints),
            tauri_plugin_updater::Error::TargetNotFound("windows-x86_64".into()),
        );
        assert!(err.detail.unwrap().get("network").is_none());
    }

    const MANIFEST: &str = "/updates/latest.json";

    /// 本地更新源：清单固定回一个状态码。匹配上 Accept 才回，探测和插件问的就是同一件事。
    async fn source_answering(status: u16) -> (wiremock::MockServer, String) {
        use wiremock::matchers::{header, method, path};
        use wiremock::{Mock, MockServer, ResponseTemplate};

        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path(MANIFEST))
            .and(header("accept", "application/json"))
            .respond_with(ResponseTemplate::new(status))
            .mount(&server)
            .await;
        let url = format!("{}{MANIFEST}", server.uri());
        (server, url)
    }

    /// 一次逐端点检查的经过：结论，与按先后问过的端点下标。
    type Checked = (Result<CheckConclusion<Fake>, CommandError>, Vec<usize>);

    /// 第 i 个端点上插件的检查给出 `results[i]`，跑一遍逐端点检查。回了非 2xx 的端点之后还要再问一次状态码，
    /// 这样的端点要用本地服务的地址。
    async fn check_with(
        endpoints: &[String],
        results: Vec<tauri_plugin_updater::Result<Option<Fake>>>,
    ) -> Checked {
        assert_eq!(endpoints.len(), results.len(), "每个端点配一个检查结果");
        let mut results = results.into_iter();
        let mut asked = Vec::new();
        let conclusion = check_in_order(endpoints, "0.1.0", |index| {
            asked.push(index);
            std::future::ready(results.next().expect("问的端点比配好的结果多"))
        })
        .await;
        (conclusion, asked)
    }

    /// 每个端点都回了非 2xx：插件对每一个都只报 `ReleaseNotFound`。前一个没给出清单，后一个照样要问。
    async fn after_release_not_found(
        endpoints: &[String],
    ) -> Result<CheckConclusion<Fake>, CommandError> {
        let results = endpoints
            .iter()
            .map(|_| Err(UpdaterError::ReleaseNotFound))
            .collect();
        let (conclusion, asked) = check_with(endpoints, results).await;
        assert_eq!(asked, (0..endpoints.len()).collect::<Vec<_>>());
        conclusion
    }

    /// 2xx 而正文不是 JSON（站点回退页、中间设备注入的页面）时插件报的错：插件对 2xx 的正文调 `json()`。
    async fn undecodable() -> UpdaterError {
        use wiremock::matchers::method;
        use wiremock::{Mock, MockServer, ResponseTemplate};

        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .respond_with(
                ResponseTemplate::new(200).set_body_string("<!doctype html><title>落樱</title>"),
            )
            .mount(&server)
            .await;
        let err = petalfall_base::http::build_client()
            .unwrap()
            .get(server.uri())
            .send()
            .await
            .unwrap()
            .json::<Value>()
            .await
            .unwrap_err();
        assert!(err.is_decode(), "{err:?}");
        UpdaterError::Reqwest(err)
    }

    /// 回了 200 和响应头，正文读到一半撞上总时限时插件报的错。插件给检查设的是 reqwest 的总时限，建连、等首字节与
    /// 读正文都算在里面，前面慢了，读正文时就会撞上。
    async fn body_timed_out() -> UpdaterError {
        use std::io::{Read, Write};

        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}{MANIFEST}", listener.local_addr().unwrap());
        // 只用来等对面丢掉发送端：拿到错误后放开连接，服务线程随之退出。
        let (release, released) = std::sync::mpsc::channel::<()>();
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut head = Vec::new();
            let mut byte = [0u8; 1];
            while !head.ends_with(b"\r\n\r\n") {
                stream.read_exact(&mut byte).unwrap();
                head.push(byte[0]);
            }
            stream
                .write_all(
                    b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n\
                      Content-Length: 4096\r\n\r\n{\"version\":",
                )
                .unwrap();
            released.recv().unwrap_err();
        });
        // 总时限也管着响应头阶段：给足余量，机器忙、服务线程迟迟排不上时也不会在请求头阶段就超时。
        let response = petalfall_base::http::build_client()
            .unwrap()
            .get(&url)
            .timeout(Duration::from_secs(2))
            .send()
            .await
            .expect("请求头阶段就失败了，与被测的正文阶段超时无关");
        let err = response.json::<Value>().await.unwrap_err();
        drop(release);
        server.join().unwrap();
        assert!(err.is_timeout(), "{err:?}");
        UpdaterError::Reqwest(err)
    }

    /// 连得上、却等不到响应头时插件报的错。不 accept 的监听端口照样完成握手，请求发出去就没有下文。
    async fn timed_out() -> UpdaterError {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}{MANIFEST}", listener.local_addr().unwrap());
        let err = petalfall_base::http::build_client()
            .unwrap()
            .get(&url)
            .timeout(Duration::from_millis(200))
            .send()
            .await
            .unwrap_err();
        drop(listener);
        assert!(err.is_timeout(), "{err:?}");
        UpdaterError::Reqwest(err)
    }

    /// 刚关掉的本地端口：再问状态码时连不上。
    fn closed_endpoint() -> String {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!(
            "http://127.0.0.1:{}{MANIFEST}",
            listener.local_addr().unwrap().port()
        );
        drop(listener);
        url
    }

    #[tokio::test]
    async fn manifest_404_counts_as_not_published() {
        let (_source, url) = source_answering(404).await;
        let conclusion = after_release_not_found(&[url]).await.unwrap();
        assert!(matches!(conclusion, CheckConclusion::NotPublished));
    }

    /// 服务器故障不能显示成已是最新：404 以外的状态一律是检查失败，状态码进 detail 让界面写出来。
    /// 200 是两次请求之间服务恢复了，这次同样没拿到清单，重试就好。只有一个端点时形状与逐端点检查之前一致，
    /// 另带 detail.attempts。
    #[tokio::test]
    async fn other_statuses_behind_release_not_found_stay_check_failures() {
        for status in [200, 400, 401, 403, 405, 429, 500, 502, 503] {
            let (_source, url) = source_answering(status).await;
            let endpoints = vec![url];
            let err = after_release_not_found(&endpoints).await.err().unwrap();
            assert_eq!(err.code, code::UPDATE_CHECK_FAILED, "{status}");
            assert_eq!(err.message, "更新服务器返回了异常状态", "{status}");
            assert_eq!(
                err.detail,
                Some(json!({
                    "endpoints": endpoints,
                    "status": status,
                    "attempts": [{
                        "endpoint": endpoints[0],
                        "status": status,
                        "message": "更新服务器返回了异常状态",
                    }],
                })),
                "{status}"
            );
        }
    }

    /// 再问一次时连不上：和插件自己连不上一样是检查失败，照样标出网络层失败的种类。
    #[tokio::test]
    async fn probe_that_cannot_connect_stays_a_check_failure() {
        let endpoints = vec![closed_endpoint()];
        let err = after_release_not_found(&endpoints).await.err().unwrap();
        assert_eq!(err.code, code::UPDATE_CHECK_FAILED);
        let detail = err.detail.unwrap();
        assert_eq!(detail["network"], json!("connect"));
        assert_eq!(detail["endpoints"], json!(endpoints));
        assert_eq!(detail["attempts"][0]["network"], json!("connect"));
        assert!(detail["attempts"][0].get("status").is_none());
    }

    /// dev 通道有香港机与 GitHub 两个端点：两个都确认 404 才算没有发布，任一端点故障就说不清它上面有没有新版本。
    /// 端点按 [`channel_endpoints`] 给的先后逐个问，两个顺序都试一遍；每个端点的状态码按问的先后进 detail.attempts，
    /// message 逐行写明。一个端点 404、另一个根本没答上话（超时）也不算没有发布。
    #[tokio::test]
    async fn every_endpoint_has_to_confirm_404() {
        let (missing, missing_url) = source_answering(404).await;
        let (other_missing, other_missing_url) = source_answering(404).await;
        let conclusion = after_release_not_found(&[missing_url.clone(), other_missing_url])
            .await
            .unwrap();
        assert!(matches!(conclusion, CheckConclusion::NotPublished));
        assert_eq!(missing.received_requests().await.unwrap().len(), 1);
        assert_eq!(other_missing.received_requests().await.unwrap().len(), 1);

        let (_broken, broken_url) = source_answering(503).await;
        let status_of = |url: &String| if *url == broken_url { 503 } else { 404 };
        let line_of = |url: &String| match status_of(url) {
            503 => format!("{url}：更新服务器返回了异常状态（503）"),
            _ => format!("{url}：更新服务器上没有这份清单（404）"),
        };
        for endpoints in [
            [missing_url.clone(), broken_url.clone()],
            [broken_url.clone(), missing_url.clone()],
        ] {
            let err = after_release_not_found(&endpoints).await.err().unwrap();
            assert_eq!(err.code, code::UPDATE_CHECK_FAILED);
            assert_eq!(
                err.message,
                format!("{}\n{}", line_of(&endpoints[0]), line_of(&endpoints[1]))
            );
            let detail = err.detail.unwrap();
            let attempts: Vec<(String, u64)> = detail["attempts"]
                .as_array()
                .unwrap()
                .iter()
                .map(|attempt| {
                    (
                        attempt["endpoint"].as_str().unwrap().to_owned(),
                        attempt["status"].as_u64().unwrap(),
                    )
                })
                .collect();
            let expected: Vec<(String, u64)> = endpoints
                .iter()
                .map(|url| (url.clone(), status_of(url)))
                .collect();
            assert_eq!(attempts, expected);
            // 前端会把顶层 status 补在整段 message 末尾，多个端点时分不清是谁的。
            assert!(detail.get("status").is_none());
            assert!(detail.get("network").is_none());
        }

        let endpoints = [closed_endpoint(), missing_url.clone()];
        let (conclusion, asked) = check_with(
            &endpoints,
            vec![Err(timed_out().await), Err(UpdaterError::ReleaseNotFound)],
        )
        .await;
        assert_eq!(asked, [0, 1]);
        let err = conclusion
            .err()
            .expect("一个端点超时、另一个 404，不能算没有发布");
        assert_eq!(err.code, code::UPDATE_CHECK_FAILED);
        let detail = err.detail.unwrap();
        assert_eq!(detail["attempts"][0]["network"], json!("timeout"));
        assert_eq!(detail["attempts"][1]["status"], json!(404));
        assert!(detail.get("network").is_none());
    }

    /// 哪个端点先给出了清单就以它为准：后面的端点不再问，前面也没有谁要再问状态码。
    #[tokio::test]
    async fn the_first_endpoint_with_a_manifest_settles_the_check() {
        let (first, first_url) = source_answering(503).await;
        let (second, second_url) = source_answering(404).await;
        let endpoints = vec![first_url, second_url];

        let (found, asked) = check_with(
            &endpoints,
            vec![Ok(Some(Fake("0.2.0"))), Ok(Some(Fake("0.3.0")))],
        )
        .await;
        assert!(matches!(
            found.unwrap(),
            CheckConclusion::Found(Candidate {
                update: Fake("0.2.0"),
                channel: Channel::Stable,
            })
        ));
        assert_eq!(asked, [0]);

        // 已是最新（含端点回 204）同样是给出了清单：不去问 GitHub 有没有更新的。
        let (latest, asked) = check_with(&endpoints, vec![Ok(None), Ok(Some(Fake("0.3.0")))]).await;
        assert!(matches!(latest.unwrap(), CheckConclusion::UpToDate));
        assert_eq!(asked, [0]);

        assert!(first.received_requests().await.unwrap().is_empty());
        assert!(second.received_requests().await.unwrap().is_empty());
    }

    /// 香港机没给出清单，不管是哪种失败，都接着问 GitHub，拿它的清单下结论；前面那个端点不必再问状态码。
    /// 插件把几个端点一次性问时，正文不是 JSON、正文读到一半撞上总时限、没有本平台的条目这几种直接返回，
    /// 字节相同的 GitHub 清单就问不到。
    #[tokio::test]
    async fn an_endpoint_without_a_manifest_hands_over_to_the_next() {
        let failures = [
            ("正文不是 JSON", undecodable().await),
            ("正文读到一半撞上总时限", body_timed_out().await),
            ("连不上", refused().await),
            ("连得上、等不到响应", timed_out().await),
            ("非 2xx", UpdaterError::ReleaseNotFound),
            (
                "清单不成形",
                UpdaterError::Serialization(serde_json::from_str::<Value>("{").unwrap_err()),
            ),
            (
                "没有本平台的条目",
                UpdaterError::TargetsNotFound(vec![
                    "windows-x86_64-nsis".into(),
                    "windows-x86_64".into(),
                ]),
            ),
        ];
        for (case, failure) in failures {
            let (hk, hk_url) = source_answering(503).await;
            let endpoints = vec![hk_url, dev_endpoint()];
            let (conclusion, asked) =
                check_with(&endpoints, vec![Err(failure), Ok(Some(Fake("0.2.0")))]).await;
            assert!(
                matches!(
                    conclusion,
                    Ok(CheckConclusion::Found(Candidate {
                        update: Fake("0.2.0"),
                        channel: Channel::Stable,
                    }))
                ),
                "{case}"
            );
            assert_eq!(asked, [0, 1], "{case}");
            assert!(
                hk.received_requests().await.unwrap().is_empty(),
                "{case}：后面的端点给出了清单，前面的不必再问状态码"
            );
        }
    }

    /// 香港机回 403（落盘的清单 Caddy 读不了）、GitHub 又连不上：两个端点各自的结果按问的先后写进 detail.attempts
    /// 与 message，香港机的状态码看得见；香港机答了话，就不是网络问题，不标 detail.network，界面不会写成连不上。
    #[tokio::test]
    async fn when_no_endpoint_gives_a_manifest_each_one_is_listed() {
        let refused = refused().await;
        let refused_raw = refused.to_string();
        let refused_causes = source_chain(&refused);
        let (hk, hk_url) = source_answering(403).await;
        let endpoints = vec![hk_url.clone(), dev_endpoint()];

        let (conclusion, asked) = check_with(
            &endpoints,
            vec![Err(UpdaterError::ReleaseNotFound), Err(refused)],
        )
        .await;
        assert_eq!(asked, [0, 1]);
        let err = conclusion.err().unwrap();
        assert_eq!(err.code, code::UPDATE_CHECK_FAILED);
        assert_eq!(
            err.message,
            format!(
                "{hk_url}：更新服务器返回了异常状态（403）\n{}：{refused_raw}",
                dev_endpoint()
            )
        );
        let mut github = json!({
            "endpoint": dev_endpoint(),
            "network": "connect",
            "message": refused_raw,
        });
        if !refused_causes.is_empty() {
            github["causes"] = json!(refused_causes);
        }
        assert_eq!(
            err.detail,
            Some(json!({
                "endpoints": endpoints,
                "attempts": [
                    { "endpoint": hk_url, "status": 403, "message": "更新服务器返回了异常状态" },
                    github,
                ],
            }))
        );
        assert_eq!(hk.received_requests().await.unwrap().len(), 1);
    }

    /// 全都败在网络层才标 detail.network：全是超时为 timeout，混着连不上为 connect；再问状态码时连不上也算连不上。
    /// 有一个端点拿到了响应（正文不是 JSON 也是拿到了），就不标。
    #[tokio::test]
    async fn endpoints_failing_only_on_the_network_mark_detail_network() {
        let unreachable = || vec![closed_endpoint(), closed_endpoint()];
        for (results, network) in [
            (
                vec![Err(refused().await), Err(timed_out().await)],
                Some("connect"),
            ),
            (
                vec![Err(timed_out().await), Err(refused().await)],
                Some("connect"),
            ),
            (
                vec![Err(timed_out().await), Err(body_timed_out().await)],
                Some("timeout"),
            ),
            (
                vec![Err(UpdaterError::ReleaseNotFound), Err(timed_out().await)],
                Some("connect"),
            ),
            (vec![Err(undecodable().await), Err(refused().await)], None),
        ] {
            let (conclusion, _) = check_with(&unreachable(), results).await;
            let err = conclusion.err().unwrap();
            assert_eq!(err.code, code::UPDATE_CHECK_FAILED);
            let detail = err.detail.unwrap();
            assert_eq!(
                detail.get("network"),
                network.map(|kind| json!(kind)).as_ref()
            );
        }
    }

    /// 只有一个端点、插件报的又不是非 2xx：不必再问状态码，message 是插件的原文。
    #[tokio::test]
    async fn other_check_failures_stay_failures_without_a_probe() {
        let (source, url) = source_answering(404).await;
        let missing = UpdaterError::TargetNotFound("windows-x86_64".into());
        let raw = missing.to_string();
        let endpoints = vec![url];
        let (conclusion, asked) = check_with(&endpoints, vec![Err(missing)]).await;
        assert_eq!(asked, [0]);
        let err = conclusion.err().unwrap();
        assert_eq!(err.code, code::UPDATE_CHECK_FAILED);
        assert_eq!(err.message, raw);
        assert_eq!(
            err.detail,
            Some(json!({
                "endpoints": endpoints,
                "attempts": [{ "endpoint": endpoints[0], "message": raw }],
            }))
        );
        assert!(source.received_requests().await.unwrap().is_empty());
    }

    /// 更新域名 TLS 不通时的样子：TCP 连得上，握手时被对端掐断。要算 connect，前端才认得出这是连不上。
    #[tokio::test]
    async fn tls_handshake_cut_off_is_a_connect_failure() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!(
            "https://127.0.0.1:{}/latest.json",
            listener.local_addr().unwrap().port()
        );
        std::thread::spawn(move || {
            let (socket, _) = listener.accept().unwrap();
            drop(socket);
        });
        let cut_off = petalfall_base::http::build_client()
            .unwrap()
            .get(&url)
            .send()
            .await
            .unwrap_err();
        let raw = cut_off.to_string();

        let err = updater_error(
            code::UPDATE_CHECK_FAILED,
            "检查更新失败",
            Some(&[url]),
            tauri_plugin_updater::Error::Reqwest(cut_off),
        );
        assert_eq!(err.code, code::UPDATE_CHECK_FAILED);
        assert_eq!(err.message, raw);
        assert_eq!(err.detail.unwrap()["network"], json!("connect"));
    }
}
