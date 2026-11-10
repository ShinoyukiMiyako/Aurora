//! 启动器自更新：检查、下载、安装，以及「退出时安装」。
//!
//! 走 Rust 侧命令而不是让前端直接调插件：安装包要按「文件下载源」策略在清单列出的几个源之间排先后、
//! 一个源失败换下一个，插件的 JS 接口只会从清单的 `url` 下载；清单端点也按通道偏好决定，不写在 tauri.conf.json 里。
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
//! 也整体不支持。注入的公钥不是钥表里本包通道的那一把时同样整体不支持。不支持时各命令报 `updater_unsupported`。
//! 仓库里的配置两项都不带，dev、beta 分支的 CI 打包时才分别写入开发版公钥（`.github/dev-updater.pub`）、
//! 发布公钥（`.github/release-updater.pub`）并打开 `requireSignedVersion`，签名时用 `--app-version` 把版本号写进
//! 可信注释：本地和 fork 构建的包不会去认落樱的更新。
//!
//! 去哪取清单由生效的通道偏好决定：偏好通道与比它慢的通道同时问（[`fetch_conclusion`]）。偏好缺省时就是由版本号
//! 判出的本包通道（[`Channel`]），与前端从版本号推发布通道同源。每个检查器用钥表里它所问通道的公钥，清单头先核过
//! 形状与签名才算数（[`verify_head`]），验过的最高版本记进配置的见过的版本，回放的旧清单压不低它。

use std::collections::HashMap;
use std::future::Future;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::task::Poll;
use std::time::{Duration, Instant};

use petalfall_base::http::NetworkFailure;
use petalfall_core::data_format::DATA_FORMAT;
use petalfall_core::release::order::{compare_versions, Channel};
use petalfall_core::update_prefs::{
    LazyPreference, SeenUpdateEntries, SeenUpdateVersion, UpdateCheckRecord,
};
use petalfall_core::{CancellationToken, CoreEvent, DownloadProgress, EventSink, PackageCandidate};
use semver::Version;
use serde::{Serialize, Serializer};
use serde_json::{json, Map, Value};
use tauri::{AppHandle, Manager, State, Url};
use tauri_plugin_updater::{RemoteRelease, Update, Updater, UpdaterBuilder, UpdaterExt};
use tokio::sync::Notify;

use crate::commands::error::{code, source_chain, CommandError};
use crate::commands::update_channels::{
    channel_outcome, channel_pubkey, channel_relation, conclude, effective_preference,
    endpoint_groups, followed_channels, head_outcome, must_save_preference, ChannelEndpoints,
    ChannelOutcome, ChannelReport, Conclusion, EndpointOutcome,
};
use crate::commands::update_head::{read_seen_entry, verify_head, VerifiedHead};
use crate::commands::update_package::vet_download;
use crate::commands::update_slot::{
    Candidate, CheckConclusion, Downloaded, Generation, ReleaseVersion, SlotError, UpdateSlot,
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

/// 这个通道的清单端点，按这个顺序逐个问（[`fetch_channel`]）：前一个没给出可用的清单头就问下一个。顺序固定、不探测：
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

/// 端点回了 2xx 却不带正文的状态码。插件见到它直接当没有更新，不读正文：没给出清单头，算这个端点失败。
const NO_CONTENT_STATUS: u16 = 204;

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

/// 候选 `update` 的 DTO，`channel` 是它真实所属的通道（取自哪个通道的清单）。
fn update_dto(update: &Update, channel: Channel) -> UpdateDto {
    UpdateDto {
        version: update.version.clone(),
        current_version: update.current_version.clone(),
        notes: update.body.clone(),
        date: update_millis(update),
        channel,
    }
}

/// 清单里的发布时间，Unix 毫秒；清单没写时为 `None`。
fn update_millis(update: &Update) -> Option<i64> {
    update
        .date
        .map(|date| unix_millis(date.unix_timestamp(), date.millisecond()))
}

/// 清单发布时间的整秒数 `seconds` 与秒内毫秒数 `millisecond` 合成 Unix 毫秒。插件把发布时间解析成 `time` 库的
/// 类型，本 crate 不直接依赖 `time`、写不出那个类型，所以由调用方拆成两段传进来。
fn unix_millis(seconds: i64, millisecond: u16) -> i64 {
    seconds * 1000 + i64::from(millisecond)
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

/// 下载的用意。这一版只有普通更新。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum UpdateIntent {
    Update,
}

/// 一个版本在本次会话里为什么被拒。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum RefusalReason {
    /// 包认得的数据格式比正在运行的这一版旧，装上读不了现有数据。
    DataTooNew,
    /// 跟随别的通道时没能把偏好写进配置。
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
        lock_slot(&self.slot)
    }

    fn require_supported(&self) -> Result<(), CommandError> {
        match self.support {
            UpdaterSupport::Supported => Ok(()),
            UpdaterSupport::Unsupported(reason) => Err(reason.error()),
        }
    }

    /// 正在运行 `current`、配置里存着的偏好是 `stored` 时的自更新状态，见 [`info_of`]。
    fn info(&self, current: &Version, stored: Option<Channel>) -> UpdaterInfoDto {
        info_of(self.support, &self.slot(), current, stored, update_dto)
    }

    /// 拉起已下载更新包的安装程序，`current` 是正在运行的版本，先过安装前的关卡（[`installable`]）。Windows 上
    /// 成功即退出进程，不会返回；拉不起来（`ShellExecuteW` 失败）时插件返回错误，但它在拉起之前已经跑过默认的
    /// `on_before_exit`（tauri 的 `cleanup_before_exit`），把所有窗口都藏了起来，见 [`install_after_persisting`]。
    fn install_downloaded(&self, current: &Version) -> Result<(), CommandError> {
        let slot = self.slot();
        let ready = installable(&slot, current)?;
        tracing::info!(
            version = %ready.update.version,
            channel = ready.channel.as_str(),
            "开始安装更新"
        );
        ready.update.install(&ready.bytes).map_err(|err| {
            updater_error(code::UPDATE_INSTALL_FAILED, "启动更新安装失败", None, err)
        })
    }
}

/// 安装前的关卡，「立即安装」与「退出时安装」共用：槽位里要有下好的包，版本又严格新于正在运行的 `current`，
/// 否则报 `update_not_ready`、不交给安装程序。
///
/// 偏好、见过的版本与跟随规则已在下载前的重查里按同一个代号核过；改偏好会清掉槽位里的包、代号加一，下载开始之后
/// 才改的又落不进槽位，所以包还在就说明那些条件没变。关卡因此只读槽位，退出路径（同步、拿不到门面的锁）也能做。
fn installable<'s, U: ReleaseVersion>(
    slot: &'s UpdateSlot<U>,
    current: &Version,
) -> Result<&'s Downloaded<U>, CommandError> {
    let ready = slot.ready()?;
    let version = ready.update.release_version();
    let parsed = Version::parse(version).expect("槽位里包的版本由清单里解析出的 semver 转成");
    if !compare_versions(&parsed, current).is_gt() {
        tracing::error!(
            version,
            channel = ready.channel.as_str(),
            %current,
            "下好的包不比正在运行的版本新，不交给安装程序"
        );
        return Err(CommandError::new(
            code::UPDATE_NOT_READY,
            format!("下好的更新包 {version} 不比正在运行的 {current} 新，不能安装"),
        ));
    }
    Ok(ready)
}

/// 槽位里的进度连同通道偏好拼成 `updater_info`。`stored` 是配置里存着的偏好（缺省或认不出时为 `None`），生效的
/// 偏好与关系由它和本包的通道定（[`effective_preference`]、[`channel_relation`]）；版本号认不出通道时三项都为
/// `null`。`dto_of` 把候选转成 [`UpdateDto`]，生产传 [`update_dto`]；抽出来是为了单测能用假的更新。
fn info_of<U: ReleaseVersion>(
    support: UpdaterSupport,
    slot: &UpdateSlot<U>,
    current: &Version,
    stored: Option<Channel>,
    dto_of: impl Fn(&U, Channel) -> UpdateDto,
) -> UpdaterInfoDto {
    let (supported, unsupported_reason) = match support {
        UpdaterSupport::Supported => (true, None),
        UpdaterSupport::Unsupported(reason) => (false, Some(reason)),
    };
    let package_channel = Channel::of_version(current);
    let preference = package_channel.map(|package| effective_preference(stored, package));
    let downloaded = slot.ready().ok();
    UpdaterInfoDto {
        current_version: current.to_string(),
        supported,
        unsupported_reason,
        package_channel,
        preference,
        relation: package_channel
            .zip(preference)
            .map(|(package, preference)| channel_relation(preference, package)),
        available: slot
            .available
            .as_ref()
            .map(|candidate| dto_of(&candidate.update, candidate.channel)),
        channel_heads: slot.channel_heads().to_vec(),
        refused: slot.refused().to_vec(),
        downloaded_version: slot.downloaded_version(),
        downloaded_channel: downloaded.map(|ready| ready.channel),
        downloaded_intent: downloaded.map(|ready| ready.intent),
        install_on_exit: slot.install_on_exit,
    }
}

/// 拿槽位的锁。临界区里只有字段赋值与同步的安装调用，真中毒说明程序已处于未知状态，直接崩。
fn lock_slot<U>(slot: &Mutex<UpdateSlot<U>>) -> MutexGuard<'_, UpdateSlot<U>> {
    slot.lock().expect("更新状态的锁已中毒")
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

/// 自更新状态。不支持时也能调，前端据 `supported` 决定是否显示更新入口。通道偏好读自配置（[`info_now`]）。
#[tauri::command]
pub async fn updater_info(
    app: AppHandle,
    facade: State<'_, Facade>,
    updater: State<'_, UpdaterState>,
) -> Result<UpdaterInfoDto, CommandError> {
    Ok(info_now(&facade, &updater, &app.package_info().version).await)
}

/// 设置更新通道偏好，返回设置之后的 `updater_info`。`channel` 不是 `dev`、`beta`、`stable` 之一时报
/// `invalid_argument`；不支持自更新报 `updater_unsupported`；有下载或安装正在进行报 `update_busy`。偏好照写进配置，
/// 生效值变了才清掉本次会话的更新进度（[`apply_update_channel`]）。
#[tauri::command]
pub async fn set_update_channel(
    channel: String,
    app: AppHandle,
    facade: State<'_, Facade>,
    updater: State<'_, UpdaterState>,
) -> Result<UpdaterInfoDto, CommandError> {
    let channel = channel_named(&channel)?;
    updater.require_supported()?;
    let current = &app.package_info().version;
    apply_update_channel(&facade, &updater.slot, current, channel).await?;
    Ok(info_now(&facade, &updater, current).await)
}

/// 前端传来的通道名认成 [`Channel`]：只认 `dev`、`beta`、`stable` 这三个小写名（[`Channel::from_name`]），别的报
/// `invalid_argument`。
fn channel_named(name: &str) -> Result<Channel, CommandError> {
    Channel::from_name(name).ok_or_else(|| {
        CommandError::invalid_argument(format!("更新通道「{name}」不是 dev、beta、stable 之一"))
    })
}

/// 把通道偏好写成 `channel`，`current` 是正在运行的版本，由它判出本包的通道（[`package_channel_of`]）。
///
/// 有下载或安装正在进行时报 `update_busy`、什么都不写：偏好一改，下到一半的包就得作废，交给安装程序的包则已经
/// 收不回来。先写配置，再看生效值（[`effective_preference`]）变没变：变了才清掉槽位里按旧偏好得来的进度、代号加一
/// （[`UpdateSlot::reset_for_new_preference`]），没变时只写盘，候选、下好的包与各通道的结果照旧。写不进配置时报错，
/// 槽位不动。
async fn apply_update_channel<U: ReleaseVersion>(
    facade: &Facade,
    slot: &Mutex<UpdateSlot<U>>,
    current: &Version,
    channel: Channel,
) -> Result<(), CommandError> {
    let package = package_channel_of(current)?;
    lock_slot(slot).ensure_idle()?;
    let mut before = None;
    facade
        .update_if_changed(|petalfall| {
            before = Some(effective_preference(
                petalfall.update_channel_preference(),
                package,
            ));
            petalfall.set_update_channel_preference(channel)
        })
        .await?;
    let before = before.expect("update_if_changed 总会调用改动闭包");
    tracing::info!(
        before = before.as_str(),
        after = channel.as_str(),
        "设置了更新通道偏好"
    );
    if before != channel {
        lock_slot(slot).reset_for_new_preference();
    }
    Ok(())
}

/// 槽位里的进度连同配置里存着的偏好，拼成此刻的 `updater_info`。读锁里只读偏好。
async fn info_now(facade: &Facade, updater: &UpdaterState, current: &Version) -> UpdaterInfoDto {
    let stored = facade.read().await.update_channel_preference();
    updater.info(current, stored)
}

/// 检查更新。按生效的通道偏好，同时问偏好通道与所有比它慢的通道（[`fetch_conclusion`]）；每个通道的端点见
/// [`channel_endpoints`]：开发版先问 [`DEV_ENDPOINT`] 再问 [`dev_endpoint`]，测试版只问 [`BETA_ENDPOINT`]，
/// 正式版只问 [`PRIMARY_ENDPOINT`]，前一个没给出可用的清单头就问下一个。各通道的结果记进槽位（`channel_heads`），
/// 验过的清单头记进见过的版本（[`conclude_fetched`]）。
///
/// 已是最新返回 `null`；偏好通道的端点都确认 404（还没有发布）不算失败，本次会话已知的候选照旧
/// （[`UpdateSlot::settle_check`]）。偏好通道取不到可信的清单报 `update_check_failed`，给出的清单头全都旧于本机
/// 记录报 `update_source_stale`，都不拿更慢通道的结果顶上；检查期间改了通道偏好报 `update_superseded`。
/// 不看 `check_updates` 设置：那一项只管启动时要不要自动查，由前端决定。
#[tauri::command]
pub async fn check_update(
    app: AppHandle,
    facade: State<'_, Facade>,
    updater: State<'_, UpdaterState>,
) -> Result<Option<UpdateDto>, CommandError> {
    updater.require_supported()?;
    // 先取号再读偏好：读完偏好之后才改的，号对不上，这次的结果落不进来。
    let ticket = updater.slot().generation();
    let plan = read_check_plan(&facade, &app.package_info().version, channel_pubkey).await?;
    let fetched = fetch_conclusion(&app, &plan).await?;
    let (heads, conclusion) =
        conclude_fetched(&facade, &updater.slot, &plan, ticket, fetched).await?;
    let dto = updater
        .slot()
        .settle_check(ticket, heads, conclusion)?
        .map(|candidate| update_dto(&candidate.update, candidate.channel));
    Ok(dto)
}

/// 一次取清单要用的本机状态，取清单之前从配置里读出。
struct CheckPlan {
    /// 正在运行的版本。
    current: Version,
    /// 本包的通道，由 `current` 判出。
    package: Channel,
    /// 配置里存着的偏好；缺省或认不出时为 `None`。
    stored: Option<Channel>,
    /// 生效的偏好。
    preference: Channel,
    /// 要问的各通道见过的最高版本，逐项重验过；作废的项不在这里。
    seen: HashMap<Channel, VerifiedHead>,
}

impl CheckPlan {
    /// 由正在运行的版本 `current`、存着的偏好 `stored` 与见过的版本的原始各项 `entries` 定下这次要问什么。
    /// `key_of` 给出重验见过的版本用的公钥，生产传钥表（[`channel_pubkey`]）。
    ///
    /// 见过的版本只重验要问的那几个通道（[`followed_channels`]）：某一项重验不过只废这一项、记 error，下次取到
    /// 这个通道的清单时覆盖；整张表不是对象时整张作废，同样记 error。本包的通道认不出时报 `updater_unsupported`
    /// （[`package_channel_of`]）。
    fn new(
        current: Version,
        stored: Option<Channel>,
        entries: &SeenUpdateEntries,
        key_of: impl Fn(Channel) -> &'static str,
    ) -> Result<Self, CommandError> {
        let package = package_channel_of(&current)?;
        let preference = effective_preference(stored, package);
        if let Some(table) = entries.malformed_table() {
            tracing::error!(
                %table,
                "配置里见过的更新版本不是对象，整张当作没有记录，下次记录时换掉"
            );
        }
        let mut seen = HashMap::new();
        for &channel in followed_channels(preference) {
            let Some(raw) = entries.get(channel) else {
                continue;
            };
            match read_seen_entry(channel, raw, key_of(channel)) {
                Ok(head) => {
                    seen.insert(channel, head);
                }
                Err(err) => tracing::error!(
                    channel = channel.as_str(),
                    error = %err,
                    "配置里这个通道见过的更新版本作废，当作没有记录，下次取到清单时覆盖"
                ),
            }
        }
        Ok(Self {
            current,
            package,
            stored,
            preference,
            seen,
        })
    }

    /// 通道 `channel` 见过的最高版本；没有有效记录时为 `None`。
    fn seen_version(&self, channel: Channel) -> Option<&Version> {
        self.seen.get(&channel).map(|head| &head.version)
    }
}

/// 读出这次检查要用的偏好与见过的版本。读锁里只克隆原始的项，重验签名放到锁外做。`key_of` 同 [`CheckPlan::new`]。
async fn read_check_plan(
    facade: &Facade,
    current: &Version,
    key_of: impl Fn(Channel) -> &'static str,
) -> Result<CheckPlan, CommandError> {
    let (stored, entries) = {
        let petalfall = facade.read().await;
        (
            petalfall.update_channel_preference(),
            petalfall.seen_update_entries(),
        )
    };
    CheckPlan::new(current.clone(), stored, &entries, key_of)
}

/// 本包的通道。认不出时报 `updater_unsupported`：[`detect_support`] 已把这种版本判为不支持、各命令先过
/// `require_supported`，走到这里说明两处判定对不上了，宁可报错也不拿哪个通道的端点顶上。
fn package_channel_of(current: &Version) -> Result<Channel, CommandError> {
    Channel::of_version(current).ok_or_else(|| UnsupportedReason::UnknownChannel.error())
}

/// 按偏好问一次清单：偏好通道与所有更慢的通道同时问，通道内按先后逐个问（[`fetch_channels`]）。要问的通道与
/// 端点只经 [`endpoint_groups`] 按 [`followed_channels`] 取得，每组带着它所问通道的公钥。检查和下载前的重查共用。
///
/// 每个端点各建一个只问它的检查器（[`check_checker`]），不把端点一次性交给插件：插件遇到 2xx 而正文读不出
/// （不是 JSON、读到一半断开或撞上总时限）、或清单里没有本平台的条目时直接返回，不再问下一个端点；非 2xx 时只记一行
/// 不带地址与状态码的日志、不记成错误。一起交给插件的话，香港机的清单一坏，GitHub 上字节相同的那份就问不到，
/// 香港机回的状态码也进不了 detail。
async fn fetch_conclusion(
    app: &AppHandle,
    plan: &CheckPlan,
) -> Result<Vec<ChannelFetch<Update>>, CommandError> {
    let groups = endpoint_groups(plan.preference, channel_endpoints);
    fetch_channels(&groups, plan, |channel, endpoint| {
        ask_endpoint(app, channel, endpoint)
    })
    .await
}

/// 比较器记下的清单头，每个检查器一份。
type ReleaseRecord = Arc<Mutex<Option<RemoteRelease>>>;

/// 用 [`check_checker`] 问通道 `channel` 的端点 `endpoint`，连同比较器记下的清单头一起认成 [`EndpointAnswer`]。
async fn ask_endpoint(app: &AppHandle, channel: Channel, endpoint: &str) -> EndpointAnswer<Update> {
    let record = ReleaseRecord::default();
    let checked = match check_checker(app, channel, endpoint, Arc::clone(&record)) {
        Ok(checker) => checker.check().await,
        Err(err) => Err(err),
    };
    let recorded = record.lock().expect("记清单头的锁已中毒").take();
    endpoint_answer(checked, recorded)
}

/// 把插件对一个端点的检查结果 `checked` 与比较器记下的清单头 `recorded` 认成 [`EndpointAnswer`]。
fn endpoint_answer(
    checked: tauri_plugin_updater::Result<Option<Update>>,
    recorded: Option<RemoteRelease>,
) -> EndpointAnswer<Update> {
    match (checked, recorded) {
        (Ok(Some(update)), _) => EndpointAnswer::Head(ManifestHead {
            version: Version::parse(&update.version)
                .expect("插件交回的版本由清单里解析出的 semver 转成"),
            signature: update.signature.clone(),
            date: update_millis(&update),
            update: Some(update),
        }),
        // 比较器判为不新于当前，插件不造更新，清单头只能从记下的那份里取。
        (Ok(None), Some(release)) => match manifest_signature(&release) {
            Ok(signature) => EndpointAnswer::Head(ManifestHead {
                date: release
                    .pub_date
                    .map(|date| unix_millis(date.unix_timestamp(), date.millisecond())),
                version: release.version,
                signature,
                update: None,
            }),
            Err(err) => EndpointAnswer::Failed(err),
        },
        // 端点回了 204：插件不读正文，也不调比较器。
        (Ok(None), None) => EndpointAnswer::NoContent,
        (Err(tauri_plugin_updater::Error::ReleaseNotFound), _) => EndpointAnswer::Unsuccessful,
        // 比较器记下了也作废：例如清单里没有本平台的条目时，插件在比较之后才报错。
        (Err(err), _) => EndpointAnswer::Failed(err),
    }
}

/// 清单头 `release` 里本平台条目的签名串。插件只在造出更新时交回签名串，比较器判为不新于当前时只能照插件挑条目的
/// 顺序自己找：先 `<系统>-<架构>-<安装类型>`，再 `<系统>-<架构>`。插件在比较之后也按这个顺序找过，找不到时它已经
/// 报了错，走不到这里；这里找不到说明两边的顺序错开了，照插件的错误报成这个端点失败。
fn manifest_signature(release: &RemoteRelease) -> tauri_plugin_updater::Result<String> {
    let base = tauri_plugin_updater::target().ok_or(tauri_plugin_updater::Error::UnsupportedOs)?;
    let mut targets = Vec::with_capacity(2);
    if let Some(installer) = installer_name(tauri::utils::platform::bundle_type()) {
        targets.push(format!("{base}-{installer}"));
    }
    targets.push(base);
    let found = targets
        .iter()
        .find_map(|target| release.signature(target).ok().cloned());
    match found {
        Some(signature) => Ok(signature),
        None => Err(tauri_plugin_updater::Error::TargetsNotFound(targets)),
    }
}

/// 插件给安装类型起的名字，照插件自己的对照表：dmg 没有名字，只按 `<系统>-<架构>` 找。
fn installer_name(bundle: Option<tauri::utils::config::BundleType>) -> Option<&'static str> {
    use tauri::utils::config::BundleType;
    match bundle? {
        BundleType::Deb => Some("deb"),
        BundleType::Rpm => Some("rpm"),
        BundleType::AppImage => Some("appimage"),
        BundleType::Msi => Some("msi"),
        BundleType::Nsis => Some("nsis"),
        BundleType::App => Some("app"),
        BundleType::Dmg => None,
    }
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

/// 自动检查与下载前重查用的检查器：只为严格新于当前版本的清单造出更新，比较之前把清单头记进 `record`
/// （[`strictly_newer`]）。requireSignedVersion 由插件配置带上。
fn check_checker(
    app: &AppHandle,
    channel: Channel,
    endpoint: &str,
    record: ReleaseRecord,
) -> tauri_plugin_updater::Result<Updater> {
    channel_builder(app, channel, endpoint)?
        .version_comparator(strictly_newer(record))
        .build()
}

/// 自动检查的比较器：清单给的版本严格新于正在运行的版本才造出更新，按 semver 优先级比，与挑候选时判「比当前新」
/// 用的是同一个比较（[`compare_versions`]），只差构建元数据的两个版本算同一版。插件只为比较器判真的版本造出
/// 更新，自动更新这条路因此碰不到比当前旧的版本。
///
/// 判之前把插件交来的清单头存进 `record`：不比当前新的清单头插件不交回来，见过的版本与各通道的结果却都要用它。
fn strictly_newer(record: ReleaseRecord) -> impl Fn(Version, RemoteRelease) -> bool + Send + Sync {
    move |current, release| {
        let newer = compare_versions(&release.version, &current).is_gt();
        *record.lock().expect("记清单头的锁已中毒") = Some(release);
        newer
    }
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

/// 一个端点问下来、核验清单头之前的样子。
enum EndpointAnswer<U> {
    /// 给出了清单头。
    Head(ManifestHead<U>),
    /// 回了 204，没给出清单。
    NoContent,
    /// 回了非 2xx。插件只报 `ReleaseNotFound`，不报状态码，要再问一次才知道是不是 404（[`fetch_channel`]）。
    Unsuccessful,
    /// 其余失败：连不上、超时、正文读不出或不成形、没有本平台的条目、检查器建不起来。
    Failed(tauri_plugin_updater::Error),
}

/// 端点给出的清单头。
struct ManifestHead<U> {
    version: Version,
    /// 清单里本平台条目原样的签名串。
    signature: String,
    /// 清单里的发布时间，Unix 毫秒；清单不签名，只作显示。
    date: Option<i64>,
    /// 插件造出的更新：只有严格新于当前版本时才有（[`strictly_newer`]）。
    update: Option<U>,
}

/// 同时问 `groups` 里的各通道（[`fetch_channel`]），按 `groups` 的先后交回各通道的结果。`ask(c, e)` 问通道 c 的
/// 端点 e，生产里是 [`ask_endpoint`]。
async fn fetch_channels<'g, U, Fut>(
    groups: &'g [ChannelEndpoints],
    plan: &CheckPlan,
    ask: impl Fn(Channel, &'g str) -> Fut,
) -> Result<Vec<ChannelFetch<U>>, CommandError>
where
    Fut: Future<Output = EndpointAnswer<U>>,
{
    let app_version = plan.current.to_string();
    let channels = groups
        .iter()
        .map(|group| fetch_channel(group, plan.seen_version(group.channel), &app_version, &ask))
        .collect();
    all_of(channels).await.into_iter().collect()
}

/// 同时跑 `steps`，全部结束后按原来的先后交回结果。几个通道的清单同时问：慢的那条不拖着别的，整次检查的时长取最慢
/// 的那条而不是相加。都在当前任务里轮询、不另开任务，取消时丢掉这个 future，各通道的请求随之一起丢下。
async fn all_of<F: Future>(steps: Vec<F>) -> Vec<F::Output> {
    let mut steps: Vec<_> = steps.into_iter().map(Box::pin).collect();
    let mut outputs: Vec<Option<F::Output>> =
        std::iter::repeat_with(|| None).take(steps.len()).collect();
    std::future::poll_fn(|cx| {
        let mut pending = false;
        for (step, output) in steps.iter_mut().zip(outputs.iter_mut()) {
            if output.is_some() {
                continue;
            }
            match step.as_mut().poll(cx) {
                Poll::Ready(value) => *output = Some(value),
                Poll::Pending => pending = true,
            }
        }
        if pending {
            Poll::Pending
        } else {
            Poll::Ready(())
        }
    })
    .await;
    outputs
        .into_iter()
        .map(|output| output.expect("全部结束之后每一步都有结果"))
        .collect()
}

/// 按先后逐个问一个通道的端点，问到第一个签名与形状都验过（[`verify_head`]，用这一组的公钥）、又不旧于本机记录
/// `seen` 的清单头为止（[`head_outcome`]）。清单头没通过核验（清单异常）、旧于本机记录、回了 204 或别的失败，都记下
/// 原因、接着问下一个。一个可用的清单头都没问到时，回了非 2xx 的端点逐个再 GET 一次问出状态码：插件把 503、403
/// 这类服务器故障也报成 `ReleaseNotFound`，不再问一次的话，服务器出故障时界面会显示还没有发布。各端点的结果合成
/// 这个通道的结果见 [`channel_outcome`]：都答 404 才算还没有发布。
async fn fetch_channel<'g, U, Fut>(
    group: &'g ChannelEndpoints,
    seen: Option<&Version>,
    app_version: &str,
    ask: &impl Fn(Channel, &'g str) -> Fut,
) -> Result<ChannelFetch<U>, CommandError>
where
    Fut: Future<Output = EndpointAnswer<U>>,
{
    let channel = group.channel;
    let mut asked = Vec::with_capacity(group.endpoints.len());
    let mut found = None;
    let mut stale_shown = None;
    for endpoint in &group.endpoints {
        let head = match ask(channel, endpoint).await {
            EndpointAnswer::Head(head) => head,
            EndpointAnswer::NoContent => {
                tracing::warn!(
                    endpoint,
                    channel = channel.as_str(),
                    "清单端点回了 204，没给出清单"
                );
                asked.push(Asked::Failed(EndpointFailure::status(
                    endpoint,
                    NO_CONTENT_STATUS,
                )));
                continue;
            }
            EndpointAnswer::Unsuccessful => {
                tracing::warn!(endpoint, channel = channel.as_str(), "清单端点回了非 2xx");
                asked.push(Asked::Unsuccessful);
                continue;
            }
            EndpointAnswer::Failed(err) => {
                tracing::warn!(endpoint, channel = channel.as_str(), error = %err, "清单端点没有给出清单");
                asked.push(Asked::Failed(EndpointFailure::plugin(endpoint, &err)));
                continue;
            }
        };
        let verified = match verify_head(channel, &head.version, &head.signature, group.pubkey) {
            Ok(verified) => verified,
            Err(err) => {
                tracing::error!(
                    endpoint,
                    channel = channel.as_str(),
                    version = %head.version,
                    error = %err,
                    "清单头没通过核验，按清单异常处理，问下一个端点"
                );
                asked.push(Asked::Failed(EndpointFailure::rejected(
                    endpoint,
                    format!("清单头没通过核验：{err}"),
                )));
                continue;
            }
        };
        match head_outcome(head.version.clone(), seen) {
            EndpointOutcome::Verified(version) => {
                tracing::info!(
                    endpoint,
                    channel = channel.as_str(),
                    %version,
                    newer = head.update.is_some(),
                    "取到验过的清单头"
                );
                found = Some(FoundHead {
                    head: verified,
                    date: head.date,
                    update: head.update,
                });
                asked.push(Asked::Verified(version));
                break;
            }
            EndpointOutcome::Stale(version) => {
                tracing::warn!(
                    endpoint,
                    channel = channel.as_str(),
                    %version,
                    seen = ?seen.map(Version::to_string),
                    "清单给出的版本旧于本机记下的这个通道见过的最高版本，问下一个端点"
                );
                stale_shown.get_or_insert((version.clone(), head.date));
                asked.push(Asked::Stale(version));
            }
            EndpointOutcome::Missing | EndpointOutcome::Failed => {
                unreachable!("head_outcome 只判可用或旧于本机记录")
            }
        }
    }

    // 有端点给出了可用的清单头，这个通道已有结论，前面回了非 2xx 的端点不必再问状态码。
    let probe = (found.is_none() && asked.iter().any(|one| matches!(one, Asked::Unsuccessful)))
        .then(|| {
            petalfall_base::http::build_client_with(
                &petalfall_base::http::HttpConfig::for_app_version(app_version),
            )
        })
        .transpose()?;
    let mut outcomes = Vec::with_capacity(asked.len());
    let mut failures = Vec::new();
    for (endpoint, one) in group.endpoints.iter().zip(asked) {
        let (outcome, failure) = match one {
            Asked::Verified(version) => (EndpointOutcome::Verified(version), None),
            Asked::Stale(version) => {
                let seen = seen.expect("旧于本机记录的清单头必然有记录可比");
                let failure = EndpointFailure::rejected(
                    endpoint,
                    format!("清单给出的 {version} 旧于这台电脑见过的 {seen}"),
                );
                (EndpointOutcome::Stale(version), Some(failure))
            }
            Asked::Failed(failure) => (EndpointOutcome::Failed, Some(failure)),
            Asked::Unsuccessful => match &probe {
                None => (EndpointOutcome::Failed, None),
                Some(client) => {
                    let probed = client
                        .get(endpoint)
                        .header("accept", "application/json")
                        .timeout(CHECK_TIMEOUT)
                        .send()
                        .await;
                    // 再问一次也连不上时，记成网络层失败。
                    let failure = match probed {
                        Ok(response) => {
                            EndpointFailure::status(endpoint, response.status().as_u16())
                        }
                        Err(err) => EndpointFailure::plugin(
                            endpoint,
                            &tauri_plugin_updater::Error::Reqwest(err),
                        ),
                    };
                    let outcome = if failure.status == Some(MANIFEST_MISSING_STATUS) {
                        EndpointOutcome::Missing
                    } else {
                        EndpointOutcome::Failed
                    };
                    (outcome, Some(failure))
                }
            },
        };
        outcomes.push(outcome);
        failures.extend(failure);
    }
    let outcome = channel_outcome(outcomes);
    if outcome == ChannelOutcome::NotPublished {
        // 界面上不算失败，日志要留痕。
        tracing::warn!(
            channel = channel.as_str(),
            endpoints = ?group.endpoints,
            "更新源上没有这个通道的清单（404），按还没有发布处理"
        );
    }
    if found.is_some() {
        failures.clear();
    }
    Ok(ChannelFetch {
        channel,
        endpoints: group.endpoints.clone(),
        outcome,
        found,
        stale_shown,
        failures,
    })
}

/// 一个端点问到哪一步。
enum Asked {
    /// 给出了可用的清单头。
    Verified(Version),
    /// 给出了验过的清单头，但旧于本机记录。
    Stale(Version),
    /// 回了非 2xx，状态码还没问。
    Unsuccessful,
    Failed(EndpointFailure),
}

/// 给出可用清单头的那个端点交回的东西。
struct FoundHead<U> {
    head: VerifiedHead,
    date: Option<i64>,
    /// 插件造出的更新，见 [`ManifestHead::update`]。
    update: Option<U>,
}

/// 一个通道这次问下来的结果。
struct ChannelFetch<U> {
    channel: Channel,
    /// 这个通道的端点，按问的先后。
    endpoints: Vec<String>,
    outcome: ChannelOutcome,
    /// 给出可用清单头的端点交回的东西；没有端点给出时为 `None`。
    found: Option<FoundHead<U>>,
    /// 没取到可用清单头时界面显示的那一份：第一个旧于本机记录的清单头与它的发布时间。
    stale_shown: Option<(Version, Option<i64>)>,
    /// 各端点为什么没给出可用的清单头，按问的先后；偏好通道整次失败时进 detail。有端点给出可用清单头时为空。
    failures: Vec<EndpointFailure>,
}

impl<U> ChannelFetch<U> {
    /// 记进槽位、供界面显示的这个通道的结果。`version` 是验过的清单头，比当前版本新旧都有可能：取到可用的就是它，
    /// 否则是第一个旧于本机记录的那一份；一个验过的都没有时为 `null`。
    fn head_dto(&self) -> ChannelHeadDto {
        let shown = match &self.found {
            Some(found) => Some((&found.head.version, found.date)),
            None => self
                .stale_shown
                .as_ref()
                .map(|(version, date)| (version, *date)),
        };
        ChannelHeadDto {
            channel: self.channel,
            state: self.outcome.head_state(),
            version: shown.map(|(version, _)| version.to_string()),
            date: shown.and_then(|(_, date)| date),
        }
    }

    /// 偏好通道没取到可用的清单头、整次检查失败时报的错：给出的清单头全都旧于本机记录 `seen` 时报
    /// `update_source_stale`，其余报 `update_check_failed`。
    fn into_failure(self, seen: Option<&Version>) -> CommandError {
        match self.outcome {
            ChannelOutcome::Stale { offered } => source_stale(
                self.channel,
                &self.endpoints,
                &offered,
                seen.expect("旧于本机记录必然有记录可比"),
            ),
            ChannelOutcome::Failed => {
                endpoints_failed(self.channel, &self.endpoints, self.failures)
            }
            ChannelOutcome::Published { .. } | ChannelOutcome::NotPublished => {
                unreachable!("通道有清单或还没有发布都不算整次失败")
            }
        }
    }
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

    /// 端点给出了清单头却不能用：没通过核验，或旧于本机记录。`message` 写明是哪一种。
    fn rejected(endpoint: &str, message: String) -> Self {
        EndpointFailure {
            endpoint: endpoint.to_owned(),
            status: None,
            network: None,
            message,
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

/// 偏好通道 `channel` 的端点都没给出可用的清单头、又不全是 404 时的检查失败，`detail.channel` 是这个通道。
/// 只问了一个端点时：message 是那个端点的原文，状态码在 detail.status，原因链在 detail.causes；多个端点时 message
/// 逐行写成「端点：原文」，状态码与原因链各自留在 detail.attempts 里，顶层不放 status：前端会把它补在整段 message
/// 的末尾，分不清是哪个端点的。全都败在网络层时标 detail.network，规则同下载源的汇总：全是超时为 timeout，
/// 混着连不上为 connect。
fn endpoints_failed(
    channel: Channel,
    endpoints: &[String],
    failures: Vec<EndpointFailure>,
) -> CommandError {
    let message = match failures.as_slice() {
        [only] => only.message.clone(),
        many => many
            .iter()
            .map(EndpointFailure::line)
            .collect::<Vec<_>>()
            .join("\n"),
    };
    let mut detail = Map::new();
    detail.insert("channel".to_owned(), json!(channel));
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
        channel = channel.as_str(),
        %message,
        attempts = ?failures,
        "偏好通道没有一个清单端点给出可用的清单，检查更新失败"
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

/// 偏好通道 `channel` 的每个端点都给出了验过的清单头、却全都旧于本机记下的 `seen` 时的整次失败：多半是更新源在
/// 回放旧清单，或者还没跟上。`detail` 是 `{channel, offered: [{endpoint, version}], seen}`，`offered` 按端点先后，
/// 与 `endpoints` 一一对应。
fn source_stale(
    channel: Channel,
    endpoints: &[String],
    offered: &[Version],
    seen: &Version,
) -> CommandError {
    let offered: Vec<Value> = endpoints
        .iter()
        .zip(offered)
        .map(|(endpoint, version)| json!({ "endpoint": endpoint, "version": version.to_string() }))
        .collect();
    let message = format!(
        "{} 通道的更新源给出的版本都旧于这台电脑见过的 {seen}，更新源还没跟上",
        channel.as_str()
    );
    tracing::warn!(
        code = code::UPDATE_SOURCE_STALE,
        %message,
        ?offered,
        "偏好通道的清单都旧于本机记录，检查更新失败"
    );
    CommandError::new(code::UPDATE_SOURCE_STALE, message).with_detail(json!({
        "channel": channel,
        "offered": offered,
        "seen": seen.to_string(),
    }))
}

/// 把一次取清单的结果落成结论，检查和下载前的重查共用。交回各通道的结果与给槽位的结论，由调用方落进槽位。
///
/// - 各通道的结果按 [`conclude`] 合成，挑候选时排除本次会话被拒的版本。
/// - 验过、又高于本机记录的清单头并进见过的版本（[`newly_seen`]）；挑中别的通道的候选、偏好又是缺省时，同一次把
///   偏好写成本包的通道（[`must_save_preference`]），两者合成一次落盘（[`save_check_record`]）。偏好写不进去时，
///   跨通道的候选逐个记入被拒的版本（`preference_unsaved`）再挑，直到挑出本包通道的候选或没有候选；见过的版本
///   写不进去只记 error，这次照样用内存里验过的清单头判定。
/// - `ticket` 是取清单之前取的号。号变了说明这期间改了偏好：不写偏好、不落槽位，报 `update_superseded`；见过的
///   版本照样记，验过的清单头与偏好无关。
/// - 偏好通道整次失败（清单取不到或异常、清单头全都旧于本机记录）时只把各通道的结果记进槽位，候选与下好的包
///   不动，报错，不拿更慢通道的结果顶上。
async fn conclude_fetched<U: ReleaseVersion>(
    facade: &Facade,
    slot: &Mutex<UpdateSlot<U>>,
    plan: &CheckPlan,
    ticket: Generation,
    fetched: Vec<ChannelFetch<U>>,
) -> Result<(Vec<ChannelHeadDto>, CheckConclusion<U>), CommandError> {
    let heads: Vec<ChannelHeadDto> = fetched.iter().map(ChannelFetch::head_dto).collect();
    let reports: Vec<ChannelReport> = fetched
        .iter()
        .map(|fetch| ChannelReport {
            channel: fetch.channel,
            seen: plan.seen_version(fetch.channel).cloned(),
            outcome: fetch.outcome.clone(),
        })
        .collect();
    let (mut refused, current_ticket) = {
        let slot = lock_slot(slot);
        let refused: Vec<(Channel, Version)> = slot
            .refused()
            .iter()
            .map(|entry| {
                let version = Version::parse(&entry.version)
                    .expect("被拒的版本记的是候选的版本原文，由 semver 版本转成");
                (entry.channel, version)
            })
            .collect();
        (refused, slot.generation() == ticket)
    };
    let mut conclusion = conclude(
        &plan.current,
        plan.package,
        plan.preference,
        &reports,
        &refused,
    );

    let lazy_preference = match &conclusion {
        Conclusion::Available(candidate)
            if current_ticket
                && must_save_preference(candidate.channel, plan.package, plan.stored) =>
        {
            Some(plan.package)
        }
        _ => None,
    };
    let record = UpdateCheckRecord {
        lazy_preference,
        seen: fetched
            .iter()
            .filter_map(|fetch| newly_seen(fetch, plan))
            .collect(),
    };
    if save_check_record(facade, &record).await {
        while let Conclusion::Available(candidate) = &conclusion {
            if candidate.channel == plan.package {
                break;
            }
            let (channel, version) = (candidate.channel, candidate.version.clone());
            tracing::warn!(
                channel = channel.as_str(),
                %version,
                "跟随别的通道之前没能写下偏好，本次会话不再把这一版当作候选"
            );
            lock_slot(slot).refuse_update(
                ticket,
                version.to_string(),
                channel,
                RefusalReason::PreferenceUnsaved,
            )?;
            refused.push((channel, version));
            conclusion = conclude(
                &plan.current,
                plan.package,
                plan.preference,
                &reports,
                &refused,
            );
        }
    }

    let mut fetched = fetched.into_iter();
    let failed = match conclusion {
        Conclusion::CheckFailed | Conclusion::SourceStale => {
            let preferred = fetched.next().expect("要问的通道至少有偏好通道自己");
            preferred.into_failure(plan.seen_version(plan.preference))
        }
        Conclusion::Available(candidate) => {
            let update = fetched
                .find(|fetch| fetch.channel == candidate.channel)
                .and_then(|fetch| fetch.found)
                .and_then(|found| found.update)
                .expect("候选严格新于当前版本，检查器的比较器同样判它为新，插件已为它造出更新");
            return Ok((
                heads,
                CheckConclusion::Found(Candidate {
                    update,
                    channel: candidate.channel,
                }),
            ));
        }
        Conclusion::UpToDate => return Ok((heads, CheckConclusion::UpToDate)),
        Conclusion::NotPublished => return Ok((heads, CheckConclusion::NotPublished)),
    };
    lock_slot(slot).settle_failed_check(ticket, heads)?;
    Err(failed)
}

/// 通道这次取到的可用清单头高于本机记录（或没有有效记录）时，要并进见过的版本的那一项。记录只往上走：等于记录的
/// 不必重写，旧于记录的清单头根本不算这个通道的结果。
fn newly_seen<U>(
    fetch: &ChannelFetch<U>,
    plan: &CheckPlan,
) -> Option<(Channel, SeenUpdateVersion)> {
    let head = &fetch.found.as_ref()?.head;
    let higher = plan
        .seen_version(fetch.channel)
        .is_none_or(|seen| compare_versions(&head.version, seen).is_gt());
    higher.then(|| {
        (
            fetch.channel,
            SeenUpdateVersion {
                version: head.version.to_string(),
                signature: head.signature.clone(),
            },
        )
    })
}

/// 把一次检查要记的惰性偏好与见过的版本合成一次落盘（`Petalfall::merge_update_check`），返回惰性偏好是不是该写
/// 却没写进去。落盘失败只记 error：见过的版本下次取到清单时再记。检查期间用户选过通道时偏好不写，按用户选的算。
async fn save_check_record(facade: &Facade, record: &UpdateCheckRecord) -> bool {
    if *record == UpdateCheckRecord::default() {
        return false;
    }
    let mut merged = None;
    let saved = facade
        .update_if_changed(|petalfall| {
            let merge = petalfall.merge_update_check(record);
            merged = Some(merge);
            merge.changed
        })
        .await;
    let merged = merged.expect("update_if_changed 总会调用改动闭包");
    if let LazyPreference::AlreadyChosen(chosen) = merged.preference {
        tracing::info!(
            chosen = chosen.as_str(),
            "检查期间选过更新通道，不按这次检查写偏好"
        );
    }
    match saved {
        Ok(_) => {
            if merged.preference == LazyPreference::Written {
                tracing::info!(
                    preference = ?record.lazy_preference,
                    "跟随别的通道之前写下了偏好：之后仍按原来那条线收更新"
                );
            }
            false
        }
        Err(err) => {
            tracing::error!(
                error = %err,
                causes = ?source_chain(&err),
                lazy_preference = ?record.lazy_preference,
                seen = record.seen.len(),
                "检查结果没能写进配置：见过的版本下次取到清单时再记，没写下的偏好按没写处理"
            );
            merged.preference == LazyPreference::Written
        }
    }
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
/// 已有下载或安装在进行时一开始就报 `update_busy`。验过签的包先看载荷头再收进槽位（[`vet_download`]）：包不对报
/// `update_signature_invalid`；认不得这台电脑上的数据时报 `update_data_too_new`，本次会话不再把这一版当作候选。
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
        // 同一时间只有一次下载或安装；改通道也要等它结束。守卫随这个块结束（成功、失败、取消）放掉。
        let _busy = updater.slot().try_begin_busy()?;
        let task = tasks.register(&task_id)?;
        let token = task.token();
        let ticket = updater.slot().generation();
        // 开发版的滚动预发布每次构建都删掉上一版安装包，检查时记下的地址过一阵就 404，重试也一样。重查按整套规则
        // 走一遍（偏好、见过的版本、跟随规则、被拒的版本），结论与各通道的结果照检查落进槽位。
        let check = read_check_plan(&facade, &app.package_info().version, channel_pubkey).await?;
        let fetched = unless_cancelled(token, fetch_conclusion(&app, &check)).await?;
        let (heads, conclusion) =
            conclude_fetched(&facade, &updater.slot, &check, ticket, fetched).await?;
        let candidate = updater
            .slot()
            .update_to_download(ticket, heads, conclusion)?;
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
        // 交给安装程序之前看载荷头：包不对、或认不得这台电脑上的数据时在这里挡下，不进槽位。
        let bytes = vet_download(&mut updater.slot(), ticket, &candidate, bytes, DATA_FORMAT)?;
        let dto = update_dto(update, candidate.channel);
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
/// 出来再报错。其它平台替换完文件后由这里重启。已有下载或安装在进行时报 `update_busy`；下好的包过不了安装前的
/// 关卡（[`installable`]）时报 `update_not_ready`。
#[tauri::command]
pub async fn install_update(
    app: AppHandle,
    updater: State<'_, UpdaterState>,
    facade: State<'_, Facade>,
) -> Result<(), CommandError> {
    updater.require_supported()?;
    // 安装进行中不许改通道、不许再开下载：落盘那一步要等，期间清掉槽位的话就装不成了。
    let _busy = updater.slot().try_begin_busy()?;
    install_after_persisting(
        &facade,
        || updater.install_downloaded(&app.package_info().version),
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

/// 在 `RunEvent::Exit` 里调用：选了「退出时安装」就在进程退出前拉起安装程序，同样先过安装前的关卡（[`installable`]）。
pub fn install_on_exit(app: &AppHandle) {
    let updater = app.state::<UpdaterState>();
    if !updater.slot().install_on_exit {
        return;
    }
    // 「立即安装」正在落盘时退出的话，它会自己拉起安装程序，这里再拉一个就重复了；正在下载的同一版也收不进槽位了。
    let _busy = match updater.slot().try_begin_busy() {
        Ok(guard) => guard,
        Err(err) => {
            tracing::warn!(?err, "有下载或安装正在进行，退出时不再安装更新");
            return;
        }
    };
    // 正在等这个进程退出的后来者会赶在安装程序之前接手，安装程序替换文件时它就挡在那里：让它们退出，
    // 安装完由安装程序重新打开落樱。
    #[cfg(windows)]
    if let Some(answer) = app.try_state::<crate::single_instance::Answer>() {
        answer.release_waiting();
    }
    // 退出路径上没有前端可以报错，只能记日志；下次启动检查更新时会再次提示。插件藏起的窗口也不重新显示：
    // 进程本来就在退出。
    if let Err(err) = updater.install_downloaded(&app.package_info().version) {
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
        let info = serde_json::to_value(state.info(&version("0.1.0"), None)).unwrap();
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
        let info = serde_json::to_value(state.info(&version("0.1.0"), None)).unwrap();
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
        let info = serde_json::to_value(state.info(&version("1.0.0-rc.1"), None)).unwrap();
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
        let info = serde_json::to_value(state.info(&version("1.0.0-dev.12"), None)).unwrap();
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

        let info = serde_json::to_value(state.info(&version("0.1.0"), None)).unwrap();
        assert_eq!(info["supported"], false);
        assert_eq!(info["unsupported_reason"], "missing_pubkey");
        assert_eq!(info["current_version"], "0.1.0");
        assert_eq!(info["available"], Value::Null);
        assert_eq!(info["downloaded_version"], Value::Null);
    }

    /// 生效的偏好：配置里没存（或认不出）时就是本包版本号所属的通道，存了就是存的那个；关系按两者的快慢定。开发构建
    /// 不支持自更新，通道照样认得出。版本号认不出通道时这三项都为 null，存了什么都一样。没检查、没下载时各通道的结果
    /// 与被拒的版本为空，下好的包的通道与用意为 null。
    #[test]
    fn info_reports_the_effective_preference_and_its_relation() {
        let supported = UpdaterState::new(UpdaterSupport::Supported);
        let debug = UpdaterState::new(UpdaterSupport::Unsupported(UnsupportedReason::DebugBuild));
        for (state, current, stored, package, preference, relation) in [
            (&supported, "1.0.0-dev.12", None, "dev", "dev", "same"),
            (&supported, "1.0.0-beta.3", None, "beta", "beta", "same"),
            (
                &supported,
                "1.0.0-BETA.2+build.7",
                None,
                "beta",
                "beta",
                "same",
            ),
            (&supported, "1.0.0", None, "stable", "stable", "same"),
            (&debug, "0.1.0-dev.3", None, "dev", "dev", "same"),
            (
                &supported,
                "1.0.0-beta.3",
                Some(Channel::Beta),
                "beta",
                "beta",
                "same",
            ),
            (
                &supported,
                "1.0.0-beta.3",
                Some(Channel::Stable),
                "beta",
                "stable",
                "waiting",
            ),
            (
                &supported,
                "1.0.0-beta.3",
                Some(Channel::Dev),
                "beta",
                "dev",
                "following",
            ),
            (
                &supported,
                "1.0.0",
                Some(Channel::Beta),
                "stable",
                "beta",
                "following",
            ),
            (
                &supported,
                "1.0.0-dev.12",
                Some(Channel::Stable),
                "dev",
                "stable",
                "waiting",
            ),
        ] {
            let info = serde_json::to_value(state.info(&version(current), stored)).unwrap();
            let case = format!("{current} {stored:?}");
            assert_eq!(info["package_channel"], package, "{case}");
            assert_eq!(info["preference"], preference, "{case}");
            assert_eq!(info["relation"], relation, "{case}");
            assert_eq!(info["channel_heads"], json!([]), "{case}");
            assert_eq!(info["refused"], json!([]), "{case}");
            assert_eq!(info["downloaded_channel"], Value::Null, "{case}");
            assert_eq!(info["downloaded_intent"], Value::Null, "{case}");
        }

        let unknown = UpdaterState::new(UpdaterSupport::Unsupported(
            UnsupportedReason::UnknownChannel,
        ));
        for stored in [None, Some(Channel::Stable)] {
            let info = serde_json::to_value(unknown.info(&version("1.0.0-rc.1"), stored)).unwrap();
            for field in ["package_channel", "preference", "relation"] {
                assert_eq!(info[field], Value::Null, "{field} {stored:?}");
            }
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

    /// 检查与下载前的重查都由本包的版本号认通道，偏好缺省时按本包的通道取端点组：偏好通道在前，更慢的通道跟在后面，
    /// 各通道的端点各取各的。认不出通道时报 `updater_unsupported`（reason `unknown_channel`），一个端点都不取，
    /// 不拿哪个通道的端点顶上。
    #[test]
    fn version_endpoints_refuse_unknown_channels() {
        let plan_for = |version: &str| {
            CheckPlan::new(
                Version::parse(version).unwrap(),
                None,
                &SeenUpdateEntries::default(),
                channel_pubkey,
            )
        };
        let endpoints_of = |version: &str| -> Vec<(Channel, Vec<String>)> {
            let plan = plan_for(version).expect("认得出通道的版本建得出检查计划");
            endpoint_groups(plan.preference, channel_endpoints)
                .into_iter()
                .map(|group| (group.channel, group.endpoints))
                .collect()
        };
        let stable = (Channel::Stable, vec![PRIMARY_ENDPOINT.to_owned()]);
        let beta = (Channel::Beta, vec![BETA_ENDPOINT.to_owned()]);
        let dev = (Channel::Dev, vec![DEV_ENDPOINT.to_owned(), dev_endpoint()]);
        assert_eq!(endpoints_of("1.0.0"), vec![stable.clone()]);
        assert_eq!(
            endpoints_of("1.0.0-beta.1"),
            vec![beta.clone(), stable.clone()]
        );
        assert_eq!(endpoints_of("1.0.0-dev.37"), vec![dev, beta, stable]);
        for unknown in ["1.0.0-rc.1", "1.0.0-alpha.1", "1.0.0-betax.1"] {
            let err = plan_for(unknown)
                .err()
                .expect("认不出通道的版本不该有检查计划");
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
            "unless_cancelled(token, fetch_conclusion(&app, &check)).await?",
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
            fetch.contains("ask_endpoint(app, channel, endpoint)"),
            "{fetch}"
        );
        let ask = top_level_fn(source, "async fn ask_endpoint(");
        assert!(
            ask.contains("check_checker(app, channel, endpoint, Arc::clone(&record))"),
            "{ask}"
        );
    }

    /// 命令层的接线单测里造不出来（要 AppHandle 与插件的 Update），钉住源码：下载一开始就占忙碌标记，先于登记任务
    /// 与重查；下载交回的包先过载荷头关卡再收进槽位；「立即安装」先占忙碌标记再落盘、安装；退出时安装占不到标记就
    /// 不装，并且在打发走等着的后来者之前判；两条安装路都带着正在运行的版本过安装前的关卡。
    #[test]
    fn downloads_and_installs_take_the_busy_flag_and_pass_the_gates() {
        let (source, _) = include_str!("updater.rs")
            .split_once("#[cfg(test)]")
            .unwrap();
        let at = |body: &str, needle: &str| {
            body.find(needle)
                .unwrap_or_else(|| panic!("找不到 {needle}\n{body}"))
        };

        let download = top_level_fn(source, "pub async fn download_update(");
        let busy = at(&download, "let _busy = updater.slot().try_begin_busy()?;");
        assert!(
            busy < at(&download, "tasks.register(&task_id)?"),
            "{download}"
        );
        assert!(
            busy < at(&download, "fetch_conclusion(&app, &check)"),
            "{download}"
        );
        let vet = at(
            &download,
            "let bytes = vet_download(&mut updater.slot(), ticket, &candidate, bytes, DATA_FORMAT)?;",
        );
        assert!(at(&download, "download_with_progress(") < vet, "{download}");
        assert!(
            vet < at(&download, "store_download(ticket, candidate, bytes)?"),
            "{download}"
        );

        let install = top_level_fn(source, "pub async fn install_update(");
        let busy = at(&install, "let _busy = updater.slot().try_begin_busy()?;");
        assert!(
            busy < at(&install, "install_after_persisting("),
            "{install}"
        );
        assert!(
            install.contains("updater.install_downloaded(&app.package_info().version)"),
            "{install}"
        );

        let on_exit = top_level_fn(source, "pub fn install_on_exit(");
        let busy = at(
            &on_exit,
            "let _busy = match updater.slot().try_begin_busy() {",
        );
        assert!(busy < at(&on_exit, "answer.release_waiting()"), "{on_exit}");
        assert!(
            busy < at(
                &on_exit,
                "updater.install_downloaded(&app.package_info().version)"
            ),
            "{on_exit}"
        );

        let state = top_level_fn(source, "impl UpdaterState {");
        assert!(
            state.contains("let ready = installable(&slot, current)?;"),
            "{state}"
        );
        assert!(!state.contains("slot.ready()"), "{state}");
    }

    /// 安装前的关卡：槽位里没有包时报还没下好；下好的包严格新于正在运行的版本才交出去，等于（含只差构建元数据的）
    /// 或不新于正在运行的版本都报 `update_not_ready`。关卡只读槽位，挡下之后包照样留着。
    #[test]
    fn the_install_gate_takes_only_packages_newer_than_the_running_version() {
        let mut slot = UpdateSlot::<Fake>::default();
        let Err(err) = installable(&slot, &version("1.0.0-dev.7")) else {
            panic!("槽位里没有包时不能安装");
        };
        assert_eq!(err.code, code::UPDATE_NOT_READY);

        let ticket = slot.generation();
        let candidate = || Candidate {
            update: Fake("1.0.0-dev.8"),
            channel: Channel::Dev,
        };
        slot.settle_check(ticket, Vec::new(), CheckConclusion::Found(candidate()))
            .unwrap();
        slot.store_download(ticket, candidate(), vec![7, 8])
            .unwrap();

        for current in ["1.0.0-dev.7", "0.9.0", "0.9.9-beta.3"] {
            let ready = installable(&slot, &version(current))
                .map(|ready| (ready.update.0, ready.channel, ready.bytes.clone()));
            assert_eq!(
                ready,
                Ok(("1.0.0-dev.8", Channel::Dev, vec![7, 8])),
                "{current}"
            );
        }
        for current in [
            "1.0.0-dev.8",
            "1.0.0-dev.8+local",
            "1.0.0-dev.9",
            "1.0.1-beta.1",
            "1.0.0",
        ] {
            let Err(err) = installable(&slot, &version(current)) else {
                panic!("正在运行 {current} 时不该装 1.0.0-dev.8");
            };
            assert_eq!(err.code, code::UPDATE_NOT_READY, "{current}");
            assert!(err.message.contains("1.0.0-dev.8"), "{}", err.message);
            assert!(err.message.contains(current), "{}", err.message);
        }
        assert_eq!(slot.downloaded_version().as_deref(), Some("1.0.0-dev.8"));
    }

    /// 下载或安装进行中（忙碌标记被占着）再开一次下载或安装报 `update_busy`；占着的那一次结束（守卫放掉）之后又能开始。
    #[test]
    fn a_second_download_or_install_while_one_runs_is_busy() {
        let slot = UpdateSlot::<Fake>::default();
        let running = slot.try_begin_busy().unwrap();
        let err = CommandError::from(slot.try_begin_busy().unwrap_err());
        assert_eq!(err.code, code::UPDATE_BUSY);
        drop(running);
        let _next = slot.try_begin_busy().unwrap();
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
    /// 不管认不认，交来的清单头都记下：不新于当前的清单头也要用来显示与记见过的版本。
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
            let record = ReleaseRecord::default();
            let comparator = strictly_newer(Arc::clone(&record));
            assert_eq!(
                comparator(current.clone(), release(offered)),
                newer,
                "{offered}"
            );
            let recorded = record.lock().unwrap().take().expect("比较器没记下清单头");
            assert_eq!(
                recorded.version,
                Version::parse(offered).unwrap(),
                "{offered}"
            );
        }
    }

    /// 比较器判为不新于当前时，清单头的签名串照插件挑平台条目的顺序找：先带安装类型的，再不带的；都没有时报插件
    /// 自己的「找不到本平台的条目」。单测进程不是安装包，没有安装类型，只找不带的那一条。
    #[test]
    fn a_not_newer_head_takes_the_signature_the_plugin_would_pick() {
        let base = tauri_plugin_updater::target().expect("单测跑在插件支持的平台上");
        assert_eq!(tauri::utils::platform::bundle_type(), None);
        let release = |platforms: &[(&str, &str)]| RemoteRelease {
            version: Version::parse("1.0.0-dev.7").unwrap(),
            notes: None,
            pub_date: None,
            data: tauri_plugin_updater::RemoteReleaseInner::Static {
                platforms: platforms
                    .iter()
                    .map(|(target, signature)| {
                        (
                            (*target).to_owned(),
                            tauri_plugin_updater::ReleaseManifestPlatform {
                                url: Url::parse("https://petalfall.org/installer.exe").unwrap(),
                                signature: (*signature).to_owned(),
                            },
                        )
                    })
                    .collect(),
            },
        };
        let nsis = format!("{base}-nsis");
        assert_eq!(
            manifest_signature(&release(&[(&nsis, "nsis 的签名"), (&base, "通用的签名")])).unwrap(),
            "通用的签名"
        );
        let missing = manifest_signature(&release(&[(&nsis, "nsis 的签名")])).unwrap_err();
        assert!(
            matches!(&missing, tauri_plugin_updater::Error::TargetsNotFound(targets) if *targets == [base.clone()]),
            "{missing}"
        );

        assert_eq!(
            installer_name(Some(tauri::utils::config::BundleType::Nsis)),
            Some("nsis")
        );
        assert_eq!(
            installer_name(Some(tauri::utils::config::BundleType::Msi)),
            Some("msi")
        );
        assert_eq!(
            installer_name(Some(tauri::utils::config::BundleType::Dmg)),
            None
        );
        assert_eq!(installer_name(None), None);

        // 没交回更新、比较器也没记下清单头：端点回了 204。记下了却报错的照报错算。
        assert!(matches!(
            endpoint_answer(Ok(None), None),
            EndpointAnswer::NoContent
        ));
        assert!(matches!(
            endpoint_answer(
                Err(tauri_plugin_updater::Error::ReleaseNotFound),
                Some(release(&[(&base, "通用的签名")]))
            ),
            EndpointAnswer::Unsuccessful
        ));
        match endpoint_answer(Ok(None), Some(release(&[(&base, "通用的签名")]))) {
            EndpointAnswer::Head(head) => {
                assert_eq!(head.version, Version::parse("1.0.0-dev.7").unwrap());
                assert_eq!(head.signature, "通用的签名");
                assert!(head.update.is_none());
            }
            _ => panic!("记下了清单头却没认成清单头"),
        }
        assert!(matches!(
            endpoint_answer(
                Err(tauri_plugin_updater::Error::TargetsNotFound(vec![
                    base.clone()
                ])),
                Some(release(&[(&nsis, "nsis 的签名")]))
            ),
            EndpointAnswer::Failed(_)
        ));
    }

    /// 清单里的发布时间按 Unix 毫秒交出：秒内的毫秒照算，带时区的换成 UTC；1970 年以前的整秒是负数、秒内毫秒仍是
    /// 正的，合起来照样对；清单没写时为 `None`。
    #[test]
    fn manifest_publish_time_is_reported_in_unix_millis() {
        for (pub_date, millis) in [
            (Some("2026-11-10T08:00:00Z"), Some(1_794_297_600_000)),
            (Some("2026-11-10T08:00:00.250Z"), Some(1_794_297_600_250)),
            (
                Some("2026-11-10T16:00:00.999+08:00"),
                Some(1_794_297_600_999),
            ),
            (Some("1969-12-31T23:59:59.500Z"), Some(-500)),
            (None, None),
        ] {
            let release: RemoteRelease = serde_json::from_value(json!({
                "version": "1.0.0-dev.7",
                "pub_date": pub_date,
                "url": "https://petalfall.org/updates/dev/installer.exe",
                "signature": "通用的签名",
            }))
            .unwrap_or_else(|err| panic!("{pub_date:?}：{err}"));
            match endpoint_answer(Ok(None), Some(release)) {
                EndpointAnswer::Head(head) => assert_eq!(head.date, millis, "{pub_date:?}"),
                _ => panic!("{pub_date:?}：记下了清单头却没认成清单头"),
            }
        }
    }

    /// 本包的通道只由应用自己的版本号判定，要问的通道只经 [`followed_channels`] 按生效的偏好取得。接线要
    /// AppHandle 与 tauri 上下文，单测造不出来，钉住源码：检查与下载前的重查都拿应用版本建检查计划，本包的通道认不出
    /// 时报错（[`package_channel_of`]），不拿默认通道顶上；端点只经 [`endpoint_groups`] 取，别处不直接按通道拿端点，
    /// 免得绕过偏好去问比它快的通道。lib.rs 给 [`detect_support`] 传的必须是应用版本的预发布标识，写死的话认不出通道的
    /// 版本也会注册插件、显示更新入口，到检查时才报不支持。各函数的行为由上面的用例验证。
    #[test]
    fn channel_is_read_from_the_app_version() {
        let (source, _) = include_str!("updater.rs")
            .split_once("#[cfg(test)]")
            .unwrap();
        let package = top_level_fn(source, "fn package_channel_of(");
        assert!(
            package.contains("Channel::of_version(current)"),
            "{package}"
        );
        for command in [
            "pub async fn check_update(",
            "pub async fn download_update(",
        ] {
            let body = top_level_fn(source, command);
            assert!(
                body.contains(
                    "read_check_plan(&facade, &app.package_info().version, channel_pubkey).await?"
                ),
                "{body}"
            );
            // 每次取完清单都经同一处落结论，见过的版本跟着并进配置。
            assert!(
                body.contains("conclude_fetched(&facade, &updater.slot, &"),
                "{body}"
            );
        }

        let fetch = top_level_fn(source, "async fn fetch_conclusion(");
        assert!(
            fetch.contains("endpoint_groups(plan.preference, channel_endpoints)"),
            "{fetch}"
        );
        let lines = shell_code_lines();
        let updater_rs = updater_rs_path(&lines);
        let total = |needle: &str| -> usize {
            occurrences(&lines, needle)
                .iter()
                .map(|(_, count)| count)
                .sum()
        };
        let in_updater = |needle: &str| -> usize {
            occurrences(&lines, needle)
                .iter()
                .filter(|(file, _)| *file == updater_rs)
                .map(|(_, count)| count)
                .sum()
        };
        // endpoint_groups 定义在 update_channels.rs，用处只有 fetch_conclusion 这一处。
        assert_eq!(total("endpoint_groups("), 2);
        assert_eq!(in_updater("endpoint_groups("), 1);
        // channel_endpoints 除了定义，只交给 endpoint_groups。
        assert_eq!(total("channel_endpoints"), 2);
        assert_eq!(in_updater("channel_endpoints"), 2);
        assert_eq!(fetch.matches("channel_endpoints").count(), 1, "{fetch}");
        let channels_source = include_str!("update_channels.rs");
        let groups = top_level_fn(channels_source, "pub(crate) fn endpoint_groups(");
        assert!(groups.contains("followed_channels(preference)"), "{groups}");

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

    // 签名夹具：两把一次性 Ed25519 测试钥，离线按 tauri signer 的格式给下面几版签好名，外层再包一层 base64，与仓库里的
    // `.pub` 文件、清单里的 `signature` 字段同形。私钥只在生成时留在内存里，没有落盘，这里只有公钥与签名串。
    // TEST_DEV_KEY 充当预览版的钥，TEST_RELEASE_KEY 充当测试版与正式版共用的钥。检查流程的公钥由调用方传入
    // （端点组里的 `pubkey`、建检查计划时的 `key_of`），用例把它们换成这两把；生产路径只传钥表。

    /// 密钥号 ec6ec430e38c3082。
    const TEST_DEV_KEY: &str = "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IDgyMzA4Q0UzMzBDNDZFRUMKUldUc2JzUXc0NHd3Z3BMKzZoRTdaaGdtUjlJNXlvSXBzM2hnVDVadUk1YUhwVlcyekE2cUQ5K04K";
    /// 密钥号 7c9485859026bf2e。
    const TEST_RELEASE_KEY: &str = "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IDJFQkYyNjkwODU4NTk0N0MKUldSOGxJV0ZrQ2EvTHBLRC9CbXlDRHl3RFRlVGl6UHFqUVBwcVV5UWhkVkZFQjlJL0ZqQ3M1L0cK";

    /// 测试钥签好的清单头：版本，与清单里本平台条目的签名串。预览版的由 TEST_DEV_KEY 签，其余由 TEST_RELEASE_KEY 签；
    /// 可信注释里恰好一个 `version` 字段，等于这一版。
    const SIGNED_HEADS: [(&str, &str); 6] = [
        ("1.0.0-dev.7", "dW50cnVzdGVkIGNvbW1lbnQ6IHNpZ25hdHVyZSBmcm9tIHRhdXJpIHNlY3JldCBrZXkKUlVUc2JzUXc0NHd3Z2lQcXFZSDRxTDhWd093MEVmSE1kTHFaZzEvVUFSYXVjQXYzSVJsVDNTWVJ6TFp3cDhScVM5ZWE3M2tnQU04WlEyU0ZXOTBub28xTUxwZzJSQmc0SWdNPQp0cnVzdGVkIGNvbW1lbnQ6IHRpbWVzdGFtcDoxNzYyNzYxNjAwCWZpbGU6UGV0YWxmYWxsLUluc3RhbGxlci0xLjAuMC1kZXYuNy14NjQuZXhlCXZlcnNpb246MS4wLjAtZGV2LjcKTDBnMzk0eUlXQmJodWVJMEhIbHprRlJtUCs0a201QTQrMi9sVjZGamx3MWpzY2xLalZFeWJRenlNN1dRd2FRdm9IdmIxUnhMNGZqZlNvMm5HaGNPRFE9PQo="),
        ("1.0.0-dev.8", "dW50cnVzdGVkIGNvbW1lbnQ6IHNpZ25hdHVyZSBmcm9tIHRhdXJpIHNlY3JldCBrZXkKUlVUc2JzUXc0NHd3Z2lQcXFZSDRxTDhWd093MEVmSE1kTHFaZzEvVUFSYXVjQXYzSVJsVDNTWVJ6TFp3cDhScVM5ZWE3M2tnQU04WlEyU0ZXOTBub28xTUxwZzJSQmc0SWdNPQp0cnVzdGVkIGNvbW1lbnQ6IHRpbWVzdGFtcDoxNzYyNzYxNjAwCWZpbGU6UGV0YWxmYWxsLUluc3RhbGxlci0xLjAuMC1kZXYuOC14NjQuZXhlCXZlcnNpb246MS4wLjAtZGV2LjgKdWttOTY4MHBCei9OMk54UFU2bVlkblBBTHRUY0tBMGFoYlIvREMvOVc2MXB5Y1I2a3lQcE1vSUlJVk9vUm1jaURxbC9ZbmRLNFd2WVBkRURudm82Q3c9PQo="),
        ("1.0.0-dev.12", "dW50cnVzdGVkIGNvbW1lbnQ6IHNpZ25hdHVyZSBmcm9tIHRhdXJpIHNlY3JldCBrZXkKUlVUc2JzUXc0NHd3Z2lQcXFZSDRxTDhWd093MEVmSE1kTHFaZzEvVUFSYXVjQXYzSVJsVDNTWVJ6TFp3cDhScVM5ZWE3M2tnQU04WlEyU0ZXOTBub28xTUxwZzJSQmc0SWdNPQp0cnVzdGVkIGNvbW1lbnQ6IHRpbWVzdGFtcDoxNzYyNzYxNjAwCWZpbGU6UGV0YWxmYWxsLUluc3RhbGxlci0xLjAuMC1kZXYuMTIteDY0LmV4ZQl2ZXJzaW9uOjEuMC4wLWRldi4xMgo1Wjg1OG1vQXlTT3M2L1UxOEhQMEhsekRESnovYUJQeFEzaUY2SXpyRHU5NmhESGJTMFZCNDV0TUhZQytaOTdUVm91dXJTcjdGRmtNeFR5Q0RqYUdDZz09Cg=="),
        ("1.0.0-beta.4", "dW50cnVzdGVkIGNvbW1lbnQ6IHNpZ25hdHVyZSBmcm9tIHRhdXJpIHNlY3JldCBrZXkKUlVSOGxJV0ZrQ2EvTGxPcnExN0VrRGg4d1ZBQ2UrWnh3cGowYzBOQWczYi9jUWRMNWtPUzhWbWErcENmYVVqVXRYMWFoLzlILzZOcFpaQnI0NklyOHFmRnF0VUtGUzF4T1EwPQp0cnVzdGVkIGNvbW1lbnQ6IHRpbWVzdGFtcDoxNzYyNzYxNjAwCWZpbGU6UGV0YWxmYWxsLUluc3RhbGxlci0xLjAuMC1iZXRhLjQteDY0LmV4ZQl2ZXJzaW9uOjEuMC4wLWJldGEuNApLaDkwR1h4VDNQNzN0LzZhMjRhWGxHWDc0aGIweVlZcC8zVG8vMndTeDN5Z2pHYkVKQXZqeFVzYmlxN3FKQThWYVJzR1FEazBKenpUUEFEMURBRGxCQT09Cg=="),
        ("1.0.0", "dW50cnVzdGVkIGNvbW1lbnQ6IHNpZ25hdHVyZSBmcm9tIHRhdXJpIHNlY3JldCBrZXkKUlVSOGxJV0ZrQ2EvTGxPcnExN0VrRGg4d1ZBQ2UrWnh3cGowYzBOQWczYi9jUWRMNWtPUzhWbWErcENmYVVqVXRYMWFoLzlILzZOcFpaQnI0NklyOHFmRnF0VUtGUzF4T1EwPQp0cnVzdGVkIGNvbW1lbnQ6IHRpbWVzdGFtcDoxNzYyNzYxNjAwCWZpbGU6UGV0YWxmYWxsLUluc3RhbGxlci0xLjAuMC14NjQuZXhlCXZlcnNpb246MS4wLjAKeE9QOExxM3B4S0RPZzU1QUxYU3pJbXlnZnZVU3g3L2JtNXVTMm1NM2dyRy82aFVVQXBQTjNINHBnRE0wTXByTytoUzhmaXZZeWVSdlhZbUkvdmJEQ3c9PQo="),
        ("1.1.0-beta.1", "dW50cnVzdGVkIGNvbW1lbnQ6IHNpZ25hdHVyZSBmcm9tIHRhdXJpIHNlY3JldCBrZXkKUlVSOGxJV0ZrQ2EvTGxPcnExN0VrRGg4d1ZBQ2UrWnh3cGowYzBOQWczYi9jUWRMNWtPUzhWbWErcENmYVVqVXRYMWFoLzlILzZOcFpaQnI0NklyOHFmRnF0VUtGUzF4T1EwPQp0cnVzdGVkIGNvbW1lbnQ6IHRpbWVzdGFtcDoxNzYyNzYxNjAwCWZpbGU6UGV0YWxmYWxsLUluc3RhbGxlci0xLjEuMC1iZXRhLjEteDY0LmV4ZQl2ZXJzaW9uOjEuMS4wLWJldGEuMQpLS0crTlVvaHNDcUxwT2xsTjFMU2lMamwvRUFGRitvSHYyaEFScTFsRWRab05RT2NBQUdyeWRuL1U4UEJjeWMyOGRhZmlZMkpOVExEUS91OG9td0VCQT09Cg=="),
    ];

    /// 用例里各通道验清单头用的测试钥，形状同钥表：预览版一把，测试版与正式版共用一把。
    fn test_key(channel: Channel) -> &'static str {
        match channel {
            Channel::Dev => TEST_DEV_KEY,
            Channel::Beta | Channel::Stable => TEST_RELEASE_KEY,
        }
    }

    fn version(text: &str) -> Version {
        Version::parse(text).unwrap_or_else(|err| panic!("{text} 不是合法版本号：{err}"))
    }

    /// 测试钥给 `text` 那一版签的签名串。
    fn signature_of(text: &str) -> &'static str {
        SIGNED_HEADS
            .iter()
            .find(|(signed, _)| *signed == text)
            .map(|(_, signature)| *signature)
            .unwrap_or_else(|| panic!("夹具里没有 {text} 的签名"))
    }

    /// 清单里的发布时间：2026-11-10 08:00 UTC 的 Unix 毫秒。
    const HEAD_DATE: i64 = 1_762_761_600_000;

    /// 端点给出 `text` 那一版的清单头，签名串是测试钥签的那一份；比 `current` 新时插件也造出了更新，同检查器的比较器。
    fn head(text: &'static str, current: &str) -> EndpointAnswer<Fake> {
        let offered = version(text);
        let newer = compare_versions(&offered, &version(current)).is_gt();
        EndpointAnswer::Head(ManifestHead {
            version: offered,
            signature: signature_of(text).to_owned(),
            date: Some(HEAD_DATE),
            update: newer.then_some(Fake(text)),
        })
    }

    /// 端点声称 `claimed` 这一版，签名串却是 `signed` 那一版的：可信注释里的版本对不上，清单头核验不过。伪造的版本
    /// 比当前新，插件照样会为它造出更新。
    fn forged_head(claimed: &'static str, signed: &str) -> EndpointAnswer<Fake> {
        EndpointAnswer::Head(ManifestHead {
            version: version(claimed),
            signature: signature_of(signed).to_owned(),
            date: Some(HEAD_DATE),
            update: Some(Fake(claimed)),
        })
    }

    /// 夹具确实是测试钥签的、能过清单头核验；钥表里的真钥验不过它们，生产路径上认不了这些夹具。
    #[test]
    fn signed_heads_pass_the_head_check_only_with_the_test_keys() {
        for (text, signature) in SIGNED_HEADS {
            let offered = version(text);
            let channel = Channel::of_version(&offered).unwrap();
            verify_head(channel, &offered, signature, test_key(channel))
                .unwrap_or_else(|err| panic!("{text}：{err}"));
            assert!(
                verify_head(channel, &offered, signature, channel_pubkey(channel)).is_err(),
                "{text}"
            );
        }
    }

    /// 单通道用例的当前版本，只用作再问状态码时的 User-Agent；清单头新不新已在 [`head`] 里按各自的当前版本定好。
    const AGENT_VERSION: &str = "1.0.0-dev.6";

    /// 一个通道逐端点问下来的经过：偏好就是这个通道时它的结果（整次失败时是报的错），与按先后问过的端点下标。
    type Checked = (Result<ChannelOutcome, CommandError>, Vec<usize>);

    /// 通道 `channel` 的第 i 个端点给出 `answers[i]`、本机记下的这个通道的最高版本是 `seen` 时，逐端点问一遍。回了
    /// 非 2xx 的端点之后还要再问一次状态码，这样的端点要用本地服务的地址。
    async fn check_channel(
        channel: Channel,
        endpoints: &[String],
        seen: Option<&str>,
        answers: Vec<EndpointAnswer<Fake>>,
    ) -> Checked {
        assert_eq!(endpoints.len(), answers.len(), "每个端点配一个答案");
        let group = ChannelEndpoints {
            channel,
            pubkey: test_key(channel),
            endpoints: endpoints.to_vec(),
        };
        let seen = seen.map(version);
        let answers = std::cell::RefCell::new(answers.into_iter().map(Some).collect::<Vec<_>>());
        let asked = std::cell::RefCell::new(Vec::new());
        let ask = |_, endpoint: &str| {
            let index = group
                .endpoints
                .iter()
                .position(|known| known == endpoint)
                .expect("问了不属于这个通道的端点");
            asked.borrow_mut().push(index);
            let answer = answers.borrow_mut()[index]
                .take()
                .expect("同一个端点问了两次");
            std::future::ready(answer)
        };
        let fetch = fetch_channel(&group, seen.as_ref(), AGENT_VERSION, &ask)
            .await
            .expect("建再问状态码用的客户端失败");
        let failed = matches!(
            fetch.outcome,
            ChannelOutcome::Failed | ChannelOutcome::Stale { .. }
        );
        let result = if failed {
            Err(fetch.into_failure(seen.as_ref()))
        } else {
            Ok(fetch.outcome)
        };
        (result, asked.into_inner())
    }

    /// 每个端点都回了非 2xx：插件对每一个都只报 `ReleaseNotFound`。前一个没给出清单，后一个照样要问。
    async fn after_release_not_found(
        channel: Channel,
        endpoints: &[String],
    ) -> Result<ChannelOutcome, CommandError> {
        let answers = endpoints
            .iter()
            .map(|_| EndpointAnswer::Unsuccessful)
            .collect();
        let (outcome, asked) = check_channel(channel, endpoints, None, answers).await;
        assert_eq!(asked, (0..endpoints.len()).collect::<Vec<_>>());
        outcome
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
        let outcome = after_release_not_found(Channel::Stable, &[url])
            .await
            .unwrap();
        assert_eq!(outcome, ChannelOutcome::NotPublished);
    }

    /// 服务器故障不能显示成还没有发布：404 以外的状态一律是检查失败，状态码进 detail 让界面写出来。
    /// 200 是两次请求之间服务恢复了，这次同样没拿到清单，重试就好。只有一个端点时 message 是它的原文、状态码在
    /// detail.status，另带 detail.attempts；detail.channel 是没取到清单的那个通道。
    #[tokio::test]
    async fn other_statuses_behind_release_not_found_stay_check_failures() {
        for status in [200, 400, 401, 403, 405, 429, 500, 502, 503] {
            let (_source, url) = source_answering(status).await;
            let endpoints = vec![url];
            let err = after_release_not_found(Channel::Stable, &endpoints)
                .await
                .err()
                .unwrap();
            assert_eq!(err.code, code::UPDATE_CHECK_FAILED, "{status}");
            assert_eq!(err.message, "更新服务器返回了异常状态", "{status}");
            assert_eq!(
                err.detail,
                Some(json!({
                    "channel": "stable",
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
        let err = after_release_not_found(Channel::Stable, &endpoints)
            .await
            .err()
            .unwrap();
        assert_eq!(err.code, code::UPDATE_CHECK_FAILED);
        let detail = err.detail.unwrap();
        assert_eq!(detail["network"], json!("connect"));
        assert_eq!(detail["endpoints"], json!(endpoints));
        assert_eq!(detail["attempts"][0]["network"], json!("connect"));
        assert!(detail["attempts"][0].get("status").is_none());
    }

    /// 预览版有香港机与 GitHub 两个端点：两个都确认 404 才算没有发布，任一端点故障就说不清它上面有没有新版本。
    /// 端点按 [`channel_endpoints`] 给的先后逐个问，两个顺序都试一遍；每个端点的状态码按问的先后进 detail.attempts，
    /// message 逐行写明。一个端点 404、另一个根本没答上话（超时）也不算没有发布。
    #[tokio::test]
    async fn every_endpoint_has_to_confirm_404() {
        let (missing, missing_url) = source_answering(404).await;
        let (other_missing, other_missing_url) = source_answering(404).await;
        let outcome =
            after_release_not_found(Channel::Dev, &[missing_url.clone(), other_missing_url])
                .await
                .unwrap();
        assert_eq!(outcome, ChannelOutcome::NotPublished);
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
            let err = after_release_not_found(Channel::Dev, &endpoints)
                .await
                .err()
                .unwrap();
            assert_eq!(err.code, code::UPDATE_CHECK_FAILED);
            assert_eq!(
                err.message,
                format!("{}\n{}", line_of(&endpoints[0]), line_of(&endpoints[1]))
            );
            let detail = err.detail.unwrap();
            assert_eq!(detail["channel"], json!("dev"));
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
        let (outcome, asked) = check_channel(
            Channel::Dev,
            &endpoints,
            None,
            vec![
                EndpointAnswer::Failed(timed_out().await),
                EndpointAnswer::Unsuccessful,
            ],
        )
        .await;
        assert_eq!(asked, [0, 1]);
        let Err(err) = outcome else {
            panic!("一个端点超时、另一个 404，不能算没有发布");
        };
        assert_eq!(err.code, code::UPDATE_CHECK_FAILED);
        let detail = err.detail.unwrap();
        assert_eq!(detail["attempts"][0]["network"], json!("timeout"));
        assert_eq!(detail["attempts"][1]["status"], json!(404));
        assert!(detail.get("network").is_none());
    }

    /// 哪个端点先给出了验过的清单头就以它为准：后面的端点不再问，前面也没有谁要再问状态码。比当前新不新都算
    /// 给出了清单（不新就是已是最新，不去问 GitHub 有没有更新的）；等于本机记录的照常可用，那就是上次见过的同一版。
    #[tokio::test]
    async fn the_first_endpoint_with_a_manifest_settles_the_check() {
        let (first, first_url) = source_answering(503).await;
        let (second, second_url) = source_answering(404).await;
        let endpoints = vec![first_url, second_url];
        let published = |text: &str| ChannelOutcome::Published {
            endpoint: 0,
            version: version(text),
        };

        let (newer, asked) = check_channel(
            Channel::Dev,
            &endpoints,
            None,
            vec![
                head("1.0.0-dev.12", "1.0.0-dev.6"),
                head("1.0.0-dev.8", "1.0.0-dev.6"),
            ],
        )
        .await;
        assert_eq!(newer.unwrap(), published("1.0.0-dev.12"));
        assert_eq!(asked, [0]);

        let (latest, asked) = check_channel(
            Channel::Dev,
            &endpoints,
            None,
            vec![
                head("1.0.0-dev.7", "1.0.0-dev.12"),
                head("1.0.0-dev.12", "1.0.0-dev.12"),
            ],
        )
        .await;
        assert_eq!(latest.unwrap(), published("1.0.0-dev.7"));
        assert_eq!(asked, [0]);

        let (same_as_seen, asked) = check_channel(
            Channel::Dev,
            &endpoints,
            Some("1.0.0-dev.8"),
            vec![
                head("1.0.0-dev.8", "1.0.0-dev.6"),
                head("1.0.0-dev.12", "1.0.0-dev.6"),
            ],
        )
        .await;
        assert_eq!(same_as_seen.unwrap(), published("1.0.0-dev.8"));
        assert_eq!(asked, [0]);

        assert!(first.received_requests().await.unwrap().is_empty());
        assert!(second.received_requests().await.unwrap().is_empty());
    }

    /// 香港机没给出可用的清单头，不管是哪种情形，都接着问 GitHub，拿它的清单头下结论；前面那个端点不必再问状态码。
    /// 插件把几个端点一次性问时，正文不是 JSON、正文读到一半撞上总时限、没有本平台的条目这几种直接返回，字节相同的
    /// GitHub 清单就问不到。回了 204 不算给出了清单；清单头没通过核验（版本不属于这个通道、签名里的版本对不上）是
    /// 清单异常；清单头旧于本机记录多半是回放的旧清单：都接着问下一个。
    #[tokio::test]
    async fn an_endpoint_without_a_manifest_hands_over_to_the_next() {
        let current = "1.0.0-dev.6";
        let failures: Vec<(&str, Option<&str>, EndpointAnswer<Fake>)> = vec![
            (
                "正文不是 JSON",
                None,
                EndpointAnswer::Failed(undecodable().await),
            ),
            (
                "正文读到一半撞上总时限",
                None,
                EndpointAnswer::Failed(body_timed_out().await),
            ),
            ("连不上", None, EndpointAnswer::Failed(refused().await)),
            (
                "连得上、等不到响应",
                None,
                EndpointAnswer::Failed(timed_out().await),
            ),
            ("非 2xx", None, EndpointAnswer::Unsuccessful),
            ("回了 204", None, EndpointAnswer::NoContent),
            (
                "清单不成形",
                None,
                EndpointAnswer::Failed(UpdaterError::Serialization(
                    serde_json::from_str::<Value>("{").unwrap_err(),
                )),
            ),
            (
                "没有本平台的条目",
                None,
                EndpointAnswer::Failed(UpdaterError::TargetsNotFound(vec![
                    "windows-x86_64-nsis".into(),
                    "windows-x86_64".into(),
                ])),
            ),
            (
                "签名里的版本对不上",
                None,
                forged_head("1.0.0-dev.99", "1.0.0-dev.12"),
            ),
            ("版本不属于这个通道", None, head("1.0.0-beta.4", current)),
            (
                "旧于本机记录",
                Some("1.0.0-dev.8"),
                head("1.0.0-dev.7", current),
            ),
        ];
        for (case, seen, failure) in failures {
            let (hk, hk_url) = source_answering(503).await;
            let endpoints = vec![hk_url, dev_endpoint()];
            let (outcome, asked) = check_channel(
                Channel::Dev,
                &endpoints,
                seen,
                vec![failure, head("1.0.0-dev.12", current)],
            )
            .await;
            assert_eq!(
                outcome.unwrap(),
                ChannelOutcome::Published {
                    endpoint: 1,
                    version: version("1.0.0-dev.12"),
                },
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

        let (outcome, asked) = check_channel(
            Channel::Dev,
            &endpoints,
            None,
            vec![
                EndpointAnswer::Unsuccessful,
                EndpointAnswer::Failed(refused),
            ],
        )
        .await;
        assert_eq!(asked, [0, 1]);
        let err = outcome.err().unwrap();
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
                "channel": "dev",
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
        for (answers, network) in [
            (
                vec![
                    EndpointAnswer::Failed(refused().await),
                    EndpointAnswer::Failed(timed_out().await),
                ],
                Some("connect"),
            ),
            (
                vec![
                    EndpointAnswer::Failed(timed_out().await),
                    EndpointAnswer::Failed(refused().await),
                ],
                Some("connect"),
            ),
            (
                vec![
                    EndpointAnswer::Failed(timed_out().await),
                    EndpointAnswer::Failed(body_timed_out().await),
                ],
                Some("timeout"),
            ),
            (
                vec![
                    EndpointAnswer::Unsuccessful,
                    EndpointAnswer::Failed(timed_out().await),
                ],
                Some("connect"),
            ),
            (
                vec![
                    EndpointAnswer::Failed(undecodable().await),
                    EndpointAnswer::Failed(refused().await),
                ],
                None,
            ),
        ] {
            let (outcome, _) = check_channel(Channel::Dev, &unreachable(), None, answers).await;
            let err = outcome.err().unwrap();
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
        let (outcome, asked) = check_channel(
            Channel::Stable,
            &endpoints,
            None,
            vec![EndpointAnswer::Failed(missing)],
        )
        .await;
        assert_eq!(asked, [0]);
        let err = outcome.err().unwrap();
        assert_eq!(err.code, code::UPDATE_CHECK_FAILED);
        assert_eq!(err.message, raw);
        assert_eq!(
            err.detail,
            Some(json!({
                "channel": "stable",
                "endpoints": endpoints,
                "attempts": [{ "endpoint": endpoints[0], "message": raw }],
            }))
        );
        assert!(source.received_requests().await.unwrap().is_empty());
    }

    /// 清单头没通过核验就是清单异常：整个通道只有这一个端点时检查失败，attempts 里写明是哪一种不过，不标网络层。
    #[tokio::test]
    async fn a_head_failing_the_check_is_a_check_failure() {
        let endpoints = vec![PRIMARY_ENDPOINT.to_owned()];
        for (case, answer) in [
            ("签名里的版本对不上", forged_head("1.1.0", "1.0.0")),
            ("测试版的版本号", head("1.0.0-beta.4", "0.9.0")),
            ("预览版的版本号", head("1.0.0-dev.12", "0.9.0")),
        ] {
            let (outcome, asked) =
                check_channel(Channel::Stable, &endpoints, None, vec![answer]).await;
            assert_eq!(asked, [0], "{case}");
            let err = outcome.err().unwrap();
            assert_eq!(err.code, code::UPDATE_CHECK_FAILED, "{case}");
            assert!(
                err.message.starts_with("清单头没通过核验："),
                "{case}：{}",
                err.message
            );
            let detail = err.detail.unwrap();
            assert_eq!(detail["channel"], json!("stable"), "{case}");
            assert!(detail.get("network").is_none(), "{case}");
            assert!(detail.get("status").is_none(), "{case}");
        }
    }

    /// 每个端点都给出了验过的清单头、又全都旧于本机记录：更新源还没跟上，报 `update_source_stale`，detail 按端点先后
    /// 列出各自给的版本与本机记录。有端点没给出清单头（503）、其余旧于记录时说不清是不是整个更新源在回放，归检查失败。
    #[tokio::test]
    async fn stale_heads_on_every_endpoint_make_the_source_stale() {
        let current = "1.0.0-dev.6";
        let endpoints = vec![DEV_ENDPOINT.to_owned(), dev_endpoint()];
        let (outcome, asked) = check_channel(
            Channel::Dev,
            &endpoints,
            Some("1.0.0-dev.8"),
            vec![head("1.0.0-dev.7", current), head("1.0.0-dev.7", current)],
        )
        .await;
        assert_eq!(asked, [0, 1]);
        let err = outcome.err().unwrap();
        assert_eq!(err.code, code::UPDATE_SOURCE_STALE);
        assert_eq!(
            err.detail,
            Some(json!({
                "channel": "dev",
                "offered": [
                    { "endpoint": DEV_ENDPOINT, "version": "1.0.0-dev.7" },
                    { "endpoint": dev_endpoint(), "version": "1.0.0-dev.7" },
                ],
                "seen": "1.0.0-dev.8",
            }))
        );
        assert!(err.message.contains("1.0.0-dev.8"), "{}", err.message);

        let (_broken, broken_url) = source_answering(503).await;
        let endpoints = vec![DEV_ENDPOINT.to_owned(), broken_url.clone()];
        let (outcome, _) = check_channel(
            Channel::Dev,
            &endpoints,
            Some("1.0.0-dev.8"),
            vec![head("1.0.0-dev.7", current), EndpointAnswer::Unsuccessful],
        )
        .await;
        let err = outcome.err().unwrap();
        assert_eq!(err.code, code::UPDATE_CHECK_FAILED);
        let detail = err.detail.unwrap();
        assert_eq!(detail["channel"], json!("dev"));
        assert_eq!(
            detail["attempts"][0]["message"],
            json!("清单给出的 1.0.0-dev.7 旧于这台电脑见过的 1.0.0-dev.8")
        );
        assert_eq!(detail["attempts"][1]["status"], json!(503));
    }

    // 检查流程的端到端用例：真的门面（配置落在临时目录）、单测的假更新的槽位、按地址给答案的端点。检查器与插件要
    // AppHandle，换成按地址交出配好答案的 `ask`；回了非 2xx 的端点要再问状态码，配成本地服务的地址，其余地址只用来
    // 对答案，不会真去连。流程与 `check_update` 相同：取号、读计划、问清单、落结论、落槽位。

    const HK_DEV: &str = "https://hk.invalid/updates/dev/latest.json";
    const GITHUB_DEV: &str = "https://github.invalid/dev-build/latest.json";
    const HK_BETA: &str = "https://hk.invalid/updates/beta/latest.json";
    const HK_STABLE: &str = "https://hk.invalid/updates/stable/latest.json";

    /// 检查流程的夹具。
    struct Flow {
        _dir: tempfile::TempDir,
        config_path: std::path::PathBuf,
        facade: Facade,
        slot: Mutex<UpdateSlot<Fake>>,
        current: Version,
        endpoints: HashMap<Channel, Vec<String>>,
    }

    /// 一次检查交回的候选（版本，通道）。
    type Found = Option<(&'static str, Channel)>;

    impl Flow {
        /// 正在运行 `current`，配置里的 `update_channel` 与 `seen_update_versions` 是这两个原样的值。
        fn new(current: &str, update_channel: Option<Value>, seen: Option<Value>) -> Self {
            use petalfall_core::{Petalfall, PetalfallConfig};

            let dir = tempfile::tempdir().unwrap();
            let config_path = dir.path().join("config.json");
            let config = PetalfallConfig {
                update_channel,
                seen_update_versions: seen,
                ..PetalfallConfig::default()
            };
            let facade = Facade::new(
                Petalfall::open(config, dir.path().to_path_buf(), config_path.clone()).unwrap(),
            );
            let endpoints = HashMap::from([
                (Channel::Dev, vec![HK_DEV.to_owned(), GITHUB_DEV.to_owned()]),
                (Channel::Beta, vec![HK_BETA.to_owned()]),
                (Channel::Stable, vec![HK_STABLE.to_owned()]),
            ]);
            Flow {
                _dir: dir,
                config_path,
                facade,
                slot: Mutex::default(),
                current: version(current),
                endpoints,
            }
        }

        /// 通道 `channel` 的端点换成 `endpoints`。
        fn with_endpoints(mut self, channel: Channel, endpoints: &[&str]) -> Self {
            self.endpoints.insert(
                channel,
                endpoints
                    .iter()
                    .map(|endpoint| (*endpoint).to_owned())
                    .collect(),
            );
            self
        }

        /// 配置写不进去：配置文件的位置被同名文件夹占着，原子写入最后一步的改名必然失败。
        fn block_config_writes(&self) {
            std::fs::create_dir_all(&self.config_path).unwrap();
        }

        /// 落盘的配置；一次都没写过时为 `None`。
        fn saved(&self) -> Option<Value> {
            match std::fs::read_to_string(&self.config_path) {
                Ok(text) => Some(serde_json::from_str(&text).unwrap()),
                Err(err) if err.kind() == std::io::ErrorKind::NotFound => None,
                Err(err) => panic!("读不了落盘的配置：{err}"),
            }
        }

        fn ticket(&self) -> Generation {
            lock_slot(&self.slot).generation()
        }

        async fn plan(&self) -> CheckPlan {
            read_check_plan(&self.facade, &self.current, test_key)
                .await
                .expect("用例里的版本都认得出通道")
        }

        /// 按 `plan` 问一遍清单，`answers` 按端点地址给答案；交回各通道的结果，与问过的端点（按先后）。
        async fn fetch(
            &self,
            plan: &CheckPlan,
            answers: Vec<(&str, EndpointAnswer<Fake>)>,
        ) -> (Vec<ChannelFetch<Fake>>, Vec<String>) {
            let mut groups =
                endpoint_groups(plan.preference, |channel| self.endpoints[&channel].clone());
            for group in &mut groups {
                group.pubkey = test_key(group.channel);
            }
            let answers = std::cell::RefCell::new(
                answers
                    .into_iter()
                    .map(|(endpoint, answer)| (endpoint.to_owned(), answer))
                    .collect::<HashMap<_, _>>(),
            );
            let asked = std::cell::RefCell::new(Vec::new());
            let fetched = fetch_channels(&groups, plan, |_, endpoint: &str| {
                asked.borrow_mut().push(endpoint.to_owned());
                let answer = answers
                    .borrow_mut()
                    .remove(endpoint)
                    .unwrap_or_else(|| panic!("{endpoint} 没配答案，或问了两次"));
                std::future::ready(answer)
            })
            .await
            .expect("建再问状态码用的客户端失败");
            (fetched, asked.into_inner())
        }

        /// 落成结论并照 `check_update` 落进槽位。
        async fn settle(
            &self,
            plan: &CheckPlan,
            ticket: Generation,
            fetched: Vec<ChannelFetch<Fake>>,
        ) -> Result<Found, CommandError> {
            let (heads, conclusion) =
                conclude_fetched(&self.facade, &self.slot, plan, ticket, fetched).await?;
            let found = lock_slot(&self.slot)
                .settle_check(ticket, heads, conclusion)?
                .map(|candidate| (candidate.update.0, candidate.channel));
            Ok(found)
        }

        /// 照 `check_update` 跑一次检查，交回结果与问过的端点。
        async fn check(
            &self,
            answers: Vec<(&str, EndpointAnswer<Fake>)>,
        ) -> (Result<Found, CommandError>, Vec<String>) {
            let ticket = self.ticket();
            let plan = self.plan().await;
            let (fetched, asked) = self.fetch(&plan, answers).await;
            (self.settle(&plan, ticket, fetched).await, asked)
        }

        fn heads(&self) -> Vec<ChannelHeadDto> {
            lock_slot(&self.slot).channel_heads().to_vec()
        }

        fn refused(&self) -> Vec<RefusedUpdateDto> {
            lock_slot(&self.slot).refused().to_vec()
        }

        /// 本次会话已知的候选（版本，通道）。
        fn available(&self) -> Found {
            lock_slot(&self.slot)
                .available
                .as_ref()
                .map(|candidate| (candidate.update.0, candidate.channel))
        }

        /// 像选通道的命令那样把偏好写进配置并落盘，不碰槽位。
        async fn write_preference(&self, channel: Channel) {
            let changed = self
                .facade
                .update_if_changed(|petalfall| petalfall.set_update_channel_preference(channel))
                .await
                .unwrap();
            assert!(changed, "偏好本来就是 {}", channel.as_str());
        }

        /// 先在槽位里记下一个候选，好看检查失败或还没有发布时它动没动。
        fn remember(&self, version: &'static str, channel: Channel) {
            let mut slot = lock_slot(&self.slot);
            let ticket = slot.generation();
            slot.settle_check(
                ticket,
                Vec::new(),
                CheckConclusion::Found(Candidate {
                    update: Fake(version),
                    channel,
                }),
            )
            .unwrap();
        }

        /// 此刻给前端的 `updater_info`：偏好照命令那样读自配置，候选按假的更新转成 DTO。
        async fn info(&self) -> UpdaterInfoDto {
            let stored = self.facade.read().await.update_channel_preference();
            info_of(
                UpdaterSupport::Supported,
                &lock_slot(&self.slot),
                &self.current,
                stored,
                |update: &Fake, channel| UpdateDto {
                    version: update.0.to_owned(),
                    current_version: self.current.to_string(),
                    notes: None,
                    date: None,
                    channel,
                },
            )
        }

        /// 槽位里放上一次会话该有的进度：各通道的结果、测试版的候选与下好的包、退出时安装，以及两种原因被拒的版本。
        fn fill_session(&self) {
            let mut slot = lock_slot(&self.slot);
            let ticket = slot.generation();
            let candidate = || Candidate {
                update: Fake("1.0.0-beta.5"),
                channel: Channel::Beta,
            };
            let heads = vec![
                head_dto(
                    Channel::Beta,
                    ChannelHeadState::Published,
                    Some("1.0.0-beta.5"),
                ),
                head_dto(Channel::Stable, ChannelHeadState::NotPublished, None),
            ];
            slot.settle_check(ticket, heads, CheckConclusion::Found(candidate()))
                .unwrap();
            slot.store_download(ticket, candidate(), vec![5]).unwrap();
            slot.set_install_on_exit(true).unwrap();
            slot.refuse_update(
                ticket,
                "1.0.0-beta.6".to_owned(),
                Channel::Beta,
                RefusalReason::DataTooNew,
            )
            .unwrap();
            slot.refuse_update(
                ticket,
                "1.0.0".to_owned(),
                Channel::Stable,
                RefusalReason::PreferenceUnsaved,
            )
            .unwrap();
        }

        /// 照 `set_update_channel` 把通道设成 `channel`。
        async fn set_channel(&self, channel: Channel) -> Result<(), CommandError> {
            apply_update_channel(&self.facade, &self.slot, &self.current, channel).await
        }
    }

    /// 见过的版本里的一项：`text` 那一版连同测试钥签的签名串，与写入一方的形状相同。
    fn seen_entry(text: &str) -> Value {
        json!({ "version": text, "signature": signature_of(text) })
    }

    /// 槽位里一个通道的结果；有版本时发布时间就是夹具里的 [`HEAD_DATE`]。
    fn head_dto(
        channel: Channel,
        state: ChannelHeadState,
        version: Option<&str>,
    ) -> ChannelHeadDto {
        ChannelHeadDto {
            channel,
            state,
            version: version.map(str::to_owned),
            date: version.map(|_| HEAD_DATE),
        }
    }

    fn sorted(mut endpoints: Vec<String>) -> Vec<String> {
        endpoints.sort();
        endpoints
    }

    /// 偏好决定问哪几个通道：偏好通道与比它慢的都问，比它快的一个都不问。偏好缺省时按本包的通道；测试版的包选了
    /// 正式版只问正式版；预览版的包选了测试版，预览版的两个端点都不问。
    #[tokio::test]
    async fn a_check_asks_the_preferred_channel_and_the_slower_ones_only() {
        let (_stable, stable_url) = source_answering(404).await;
        let stable = stable_url.as_str();

        let flow = Flow::new("1.0.0-beta.4", None, None).with_endpoints(Channel::Stable, &[stable]);
        let (found, asked) = flow
            .check(vec![
                (HK_BETA, head("1.0.0-beta.4", "1.0.0-beta.4")),
                (stable, EndpointAnswer::Unsuccessful),
            ])
            .await;
        assert_eq!(
            found.unwrap(),
            None,
            "测试版有清单、没有更新的版本：已是最新"
        );
        assert_eq!(
            sorted(asked),
            sorted(vec![HK_BETA.to_owned(), stable_url.clone()])
        );
        assert_eq!(
            flow.heads(),
            [
                head_dto(
                    Channel::Beta,
                    ChannelHeadState::Published,
                    Some("1.0.0-beta.4")
                ),
                head_dto(Channel::Stable, ChannelHeadState::NotPublished, None),
            ]
        );

        let flow = Flow::new("1.0.0-beta.4", Some(json!("stable")), None)
            .with_endpoints(Channel::Stable, &[stable]);
        let (found, asked) = flow
            .check(vec![(stable, EndpointAnswer::Unsuccessful)])
            .await;
        assert_eq!(found.unwrap(), None);
        assert_eq!(asked, [stable]);
        assert_eq!(
            flow.heads(),
            [head_dto(
                Channel::Stable,
                ChannelHeadState::NotPublished,
                None
            )]
        );

        // 等它追上来：测试版的核心号更高，不受跟随规则约束，是候选。
        let flow = Flow::new("1.0.0-dev.6", Some(json!("beta")), None)
            .with_endpoints(Channel::Stable, &[stable]);
        let (found, asked) = flow
            .check(vec![
                (HK_BETA, head("1.1.0-beta.1", "1.0.0-dev.6")),
                (stable, EndpointAnswer::Unsuccessful),
            ])
            .await;
        assert_eq!(found.unwrap(), Some(("1.1.0-beta.1", Channel::Beta)));
        assert_eq!(
            sorted(asked),
            sorted(vec![HK_BETA.to_owned(), stable_url.clone()])
        );
    }

    /// 香港机的预览版清单旧于本机记录（回放的旧清单）：接着问 GitHub，拿它验过的清单头挑候选，并把它记进见过的版本。
    /// 本通道的候选不必写偏好。
    #[tokio::test]
    async fn a_stale_hk_dev_manifest_hands_over_to_github() {
        let (_beta, beta_url) = source_answering(404).await;
        let (_stable, stable_url) = source_answering(404).await;
        let current = "1.0.0-dev.6";
        let flow = Flow::new(
            current,
            None,
            Some(json!({ "dev": seen_entry("1.0.0-dev.8") })),
        )
        .with_endpoints(Channel::Beta, &[beta_url.as_str()])
        .with_endpoints(Channel::Stable, &[stable_url.as_str()]);
        let (found, asked) = flow
            .check(vec![
                (HK_DEV, head("1.0.0-dev.7", current)),
                (GITHUB_DEV, head("1.0.0-dev.12", current)),
                (beta_url.as_str(), EndpointAnswer::Unsuccessful),
                (stable_url.as_str(), EndpointAnswer::Unsuccessful),
            ])
            .await;
        assert_eq!(found.unwrap(), Some(("1.0.0-dev.12", Channel::Dev)));
        let dev_asked: Vec<&String> = asked
            .iter()
            .filter(|endpoint| [HK_DEV, GITHUB_DEV].contains(&endpoint.as_str()))
            .collect();
        assert_eq!(dev_asked, [HK_DEV, GITHUB_DEV]);
        assert_eq!(
            flow.heads(),
            [
                head_dto(
                    Channel::Dev,
                    ChannelHeadState::Published,
                    Some("1.0.0-dev.12")
                ),
                head_dto(Channel::Beta, ChannelHeadState::NotPublished, None),
                head_dto(Channel::Stable, ChannelHeadState::NotPublished, None),
            ]
        );
        let saved = flow.saved().expect("见过的版本要落盘");
        assert_eq!(
            saved["seen_update_versions"],
            json!({ "dev": seen_entry("1.0.0-dev.12") })
        );
        assert_eq!(saved["update_channel"], Value::Null);
    }

    /// 偏好通道两处都旧于本机记录：整次失败，报 `update_source_stale`，不看更慢的通道。测试版那一版本来是候选，
    /// 也不拿它顶上；本次会话先前记着的候选不动，各通道的结果照记，测试版验过的清单头照样记进见过的版本。
    /// 一处旧于记录、一处 503 时说不清是不是整个更新源在回放，报检查失败，同样不看更慢的通道。
    #[tokio::test]
    async fn a_preferred_channel_stale_everywhere_fails_without_the_slower_ones() {
        let (_stable, stable_url) = source_answering(404).await;
        let current = "1.0.0-dev.6";
        let seen = || Some(json!({ "dev": seen_entry("1.0.0-dev.8") }));
        let flow = Flow::new(current, None, seen())
            .with_endpoints(Channel::Stable, &[stable_url.as_str()]);
        flow.remember("1.0.0-dev.8", Channel::Dev);
        let (outcome, _) = flow
            .check(vec![
                (HK_DEV, head("1.0.0-dev.7", current)),
                (GITHUB_DEV, head("1.0.0-dev.7", current)),
                (HK_BETA, head("1.1.0-beta.1", current)),
                (stable_url.as_str(), EndpointAnswer::Unsuccessful),
            ])
            .await;
        let Err(err) = outcome else {
            panic!("偏好通道两处都旧于记录，整次检查失败");
        };
        assert_eq!(err.code, code::UPDATE_SOURCE_STALE);
        assert_eq!(
            err.detail,
            Some(json!({
                "channel": "dev",
                "offered": [
                    { "endpoint": HK_DEV, "version": "1.0.0-dev.7" },
                    { "endpoint": GITHUB_DEV, "version": "1.0.0-dev.7" },
                ],
                "seen": "1.0.0-dev.8",
            }))
        );
        assert_eq!(flow.available(), Some(("1.0.0-dev.8", Channel::Dev)));
        assert_eq!(
            flow.heads(),
            [
                head_dto(Channel::Dev, ChannelHeadState::Stale, Some("1.0.0-dev.7")),
                head_dto(
                    Channel::Beta,
                    ChannelHeadState::Published,
                    Some("1.1.0-beta.1")
                ),
                head_dto(Channel::Stable, ChannelHeadState::NotPublished, None),
            ]
        );
        assert_eq!(
            flow.saved().expect("测试版验过的清单头要落盘")["seen_update_versions"],
            json!({
                "dev": seen_entry("1.0.0-dev.8"),
                "beta": seen_entry("1.1.0-beta.1"),
            })
        );

        let (_broken, broken_url) = source_answering(503).await;
        let flow = Flow::new(current, None, seen())
            .with_endpoints(Channel::Dev, &[HK_DEV, broken_url.as_str()])
            .with_endpoints(Channel::Stable, &[stable_url.as_str()]);
        let (outcome, _) = flow
            .check(vec![
                (HK_DEV, head("1.0.0-dev.7", current)),
                (broken_url.as_str(), EndpointAnswer::Unsuccessful),
                (HK_BETA, head("1.1.0-beta.1", current)),
                (stable_url.as_str(), EndpointAnswer::Unsuccessful),
            ])
            .await;
        let Err(err) = outcome else {
            panic!("一处旧于记录、一处 503，同样整次失败");
        };
        assert_eq!(err.code, code::UPDATE_CHECK_FAILED);
        assert_eq!(err.detail.unwrap()["channel"], json!("dev"));
        assert_eq!(flow.available(), None);
        assert_eq!(
            flow.heads()[0],
            head_dto(Channel::Dev, ChannelHeadState::Failed, Some("1.0.0-dev.7"))
        );
    }

    /// 正式版的清单回 404 是还没有发布，不算失败：偏好正式版时结论是还没有发布，本次会话先前记着的候选照旧；偏好测试版
    /// 时正式版只是没有候选，测试版有清单就是已是最新。
    #[tokio::test]
    async fn stable_404_means_not_published_rather_than_a_failure() {
        let (_stable, stable_url) = source_answering(404).await;
        let flow = Flow::new("1.0.0-beta.4", Some(json!("stable")), None)
            .with_endpoints(Channel::Stable, &[stable_url.as_str()]);
        flow.remember("1.0.0", Channel::Stable);
        let (found, _) = flow
            .check(vec![(stable_url.as_str(), EndpointAnswer::Unsuccessful)])
            .await;
        assert_eq!(found.unwrap(), Some(("1.0.0", Channel::Stable)));
        assert_eq!(
            flow.heads(),
            [head_dto(
                Channel::Stable,
                ChannelHeadState::NotPublished,
                None
            )]
        );

        let flow = Flow::new("1.0.0-beta.4", None, None)
            .with_endpoints(Channel::Stable, &[stable_url.as_str()]);
        let (found, _) = flow
            .check(vec![
                (HK_BETA, head("1.0.0-beta.4", "1.0.0-beta.4")),
                (stable_url.as_str(), EndpointAnswer::Unsuccessful),
            ])
            .await;
        assert_eq!(found.unwrap(), None);
    }

    /// 清单头没通过核验的端点被跳过：香港机给了一个更高、签名却对不上的版本，候选取 GitHub 验过的那一版，见过的版本
    /// 记的也是它，伪造的版本记不进来。更慢通道的清单头核验不过只算那个通道失败，检查照常，也不记它。
    #[tokio::test]
    async fn heads_failing_the_check_are_skipped_and_never_seen() {
        let (_beta, beta_url) = source_answering(404).await;
        let (_stable, stable_url) = source_answering(404).await;
        let current = "1.0.0-dev.6";
        let flow = Flow::new(current, None, None)
            .with_endpoints(Channel::Beta, &[beta_url.as_str()])
            .with_endpoints(Channel::Stable, &[stable_url.as_str()]);
        let (found, asked) = flow
            .check(vec![
                (HK_DEV, forged_head("1.0.0-dev.99", "1.0.0-dev.12")),
                (GITHUB_DEV, head("1.0.0-dev.12", current)),
                (beta_url.as_str(), EndpointAnswer::Unsuccessful),
                (stable_url.as_str(), EndpointAnswer::Unsuccessful),
            ])
            .await;
        assert_eq!(found.unwrap(), Some(("1.0.0-dev.12", Channel::Dev)));
        assert!(asked.contains(&GITHUB_DEV.to_owned()));
        assert_eq!(
            flow.heads()[0],
            head_dto(
                Channel::Dev,
                ChannelHeadState::Published,
                Some("1.0.0-dev.12")
            )
        );
        assert_eq!(
            flow.saved().unwrap()["seen_update_versions"],
            json!({ "dev": seen_entry("1.0.0-dev.12") })
        );

        let flow =
            Flow::new(current, None, None).with_endpoints(Channel::Stable, &[stable_url.as_str()]);
        let (found, _) = flow
            .check(vec![
                (HK_DEV, head("1.0.0-dev.12", current)),
                (HK_BETA, head("1.0.0-dev.8", current)),
                (stable_url.as_str(), EndpointAnswer::Unsuccessful),
            ])
            .await;
        assert_eq!(found.unwrap(), Some(("1.0.0-dev.12", Channel::Dev)));
        assert_eq!(
            flow.heads()[1],
            head_dto(Channel::Beta, ChannelHeadState::Failed, None)
        );
        assert_eq!(
            flow.saved().unwrap()["seen_update_versions"],
            json!({ "dev": seen_entry("1.0.0-dev.12") })
        );
    }

    /// 测试版用户跟随同号正式版：挑中别的通道的候选、偏好又是缺省，同一次检查先把偏好写成本包的通道，与见过的版本
    /// 一起落盘。不写的话装上正式版之后包的通道变了，他会悄悄成为正式版用户。偏好已经显式选过时不必再写。
    #[tokio::test]
    async fn following_a_slower_channel_saves_the_package_channel_first() {
        let current = "1.0.0-beta.4";
        let answers = || {
            vec![
                (HK_BETA, head("1.0.0-beta.4", current)),
                (HK_STABLE, head("1.0.0", current)),
            ]
        };
        let flow = Flow::new(current, None, None);
        let (found, _) = flow.check(answers()).await;
        assert_eq!(found.unwrap(), Some(("1.0.0", Channel::Stable)));
        let saved = flow.saved().expect("偏好与见过的版本要落盘");
        assert_eq!(saved["update_channel"], json!("beta"));
        assert_eq!(
            saved["seen_update_versions"],
            json!({ "beta": seen_entry("1.0.0-beta.4"), "stable": seen_entry("1.0.0") })
        );
        assert!(flow.refused().is_empty());

        let flow = Flow::new(current, Some(json!("beta")), None);
        let (found, _) = flow.check(answers()).await;
        assert_eq!(found.unwrap(), Some(("1.0.0", Channel::Stable)));
        assert_eq!(flow.saved().unwrap()["update_channel"], json!("beta"));
    }

    /// 检查期间用户选了通道：写偏好时在锁里再看一次，已经选过就不按这次检查写，留着用户选的。用户的命令已经清过
    /// 槽位、号变了时，这次的结果不落槽位，报 `update_superseded`，验过的清单头照样记进见过的版本。
    #[tokio::test]
    async fn a_preference_chosen_during_the_check_is_not_overwritten() {
        let current = "1.0.0-beta.4";
        let answers = || {
            vec![
                (HK_BETA, head("1.0.0-beta.4", current)),
                (HK_STABLE, head("1.0.0", current)),
            ]
        };
        // 选通道的命令先写配置、后清槽位：夹在两步之间时号还没变，这次照旧落下，随后被清掉。
        let flow = Flow::new(current, None, None);
        let ticket = flow.ticket();
        let plan = flow.plan().await;
        let (fetched, _) = flow.fetch(&plan, answers()).await;
        flow.write_preference(Channel::Stable).await;
        let found = flow.settle(&plan, ticket, fetched).await.unwrap();
        assert_eq!(found, Some(("1.0.0", Channel::Stable)));
        assert_eq!(flow.saved().unwrap()["update_channel"], json!("stable"));

        let flow = Flow::new(current, None, None);
        let ticket = flow.ticket();
        let plan = flow.plan().await;
        let (fetched, _) = flow.fetch(&plan, answers()).await;
        flow.set_channel(Channel::Stable).await.unwrap();
        let err = flow.settle(&plan, ticket, fetched).await.err().unwrap();
        assert_eq!(err.code, code::UPDATE_SUPERSEDED);
        let saved = flow.saved().unwrap();
        assert_eq!(saved["update_channel"], json!("stable"));
        assert_eq!(
            saved["seen_update_versions"],
            json!({ "beta": seen_entry("1.0.0-beta.4"), "stable": seen_entry("1.0.0") })
        );
        assert_eq!(flow.available(), None);
        assert!(flow.heads().is_empty());
    }

    /// 偏好写不进配置：跨通道的候选记入被拒的版本（`preference_unsaved`，意图为普通更新），同一会话不再是候选；本通道
    /// 的候选照常。见过的版本同样写不进去，只记 error，检查照样给出结论。
    #[tokio::test]
    async fn an_unsaved_preference_refuses_only_cross_channel_candidates() {
        let current = "1.0.0-beta.4";
        let flow = Flow::new(current, None, None);
        flow.block_config_writes();
        let answers = || {
            vec![
                (HK_BETA, head("1.0.0-beta.4", current)),
                (HK_STABLE, head("1.0.0", current)),
            ]
        };
        let unsaved = |version: &str, channel| RefusedUpdateDto {
            version: version.to_owned(),
            channel,
            reason: RefusalReason::PreferenceUnsaved,
            intent: UpdateIntent::Update,
        };
        let (found, _) = flow.check(answers()).await;
        assert_eq!(
            found.unwrap(),
            None,
            "跨通道的候选被拒，测试版自己没有更新的"
        );
        assert_eq!(flow.refused(), [unsaved("1.0.0", Channel::Stable)]);
        let (found, _) = flow.check(answers()).await;
        assert_eq!(found.unwrap(), None);
        assert_eq!(flow.refused(), [unsaved("1.0.0", Channel::Stable)]);

        // 测试版那一版核心号更高、本该胜出；写不进偏好就拒掉它，挑本通道的。
        let (_stable, stable_url) = source_answering(404).await;
        let current = "1.0.0-dev.6";
        let flow =
            Flow::new(current, None, None).with_endpoints(Channel::Stable, &[stable_url.as_str()]);
        flow.block_config_writes();
        let (found, _) = flow
            .check(vec![
                (HK_DEV, head("1.0.0-dev.12", current)),
                (HK_BETA, head("1.1.0-beta.1", current)),
                (stable_url.as_str(), EndpointAnswer::Unsuccessful),
            ])
            .await;
        assert_eq!(found.unwrap(), Some(("1.0.0-dev.12", Channel::Dev)));
        assert_eq!(flow.refused(), [unsaved("1.1.0-beta.1", Channel::Beta)]);
    }

    /// 读见过的版本时逐项重验：被改高的那一项（签名对不上版本）只废它自己，当这个通道没有记录，下次取到清单时覆盖；
    /// 别的通道照用，不认识的通道键原样带着写回。整张表不是对象时整张作废，下次记录时换成新对象。
    #[tokio::test]
    async fn a_tampered_seen_entry_only_voids_itself() {
        let (_stable, stable_url) = source_answering(404).await;
        let current = "1.0.0-dev.6";
        let seen = json!({
            "dev": { "version": "1.0.0-dev.99", "signature": signature_of("1.0.0-dev.12") },
            "beta": seen_entry("1.0.0-beta.4"),
            "nightly": { "version": "2.0.0-nightly.1" },
        });
        let flow = Flow::new(current, None, Some(seen))
            .with_endpoints(Channel::Stable, &[stable_url.as_str()]);
        let (found, _) = flow
            .check(vec![
                (HK_DEV, head("1.0.0-dev.7", current)),
                (HK_BETA, head("1.0.0-beta.4", current)),
                (stable_url.as_str(), EndpointAnswer::Unsuccessful),
            ])
            .await;
        assert_eq!(
            found.unwrap(),
            Some(("1.0.0-dev.7", Channel::Dev)),
            "改高的记录作废，挡不住 dev.7"
        );
        assert_eq!(
            flow.saved().unwrap()["seen_update_versions"],
            json!({
                "dev": seen_entry("1.0.0-dev.7"),
                "beta": seen_entry("1.0.0-beta.4"),
                "nightly": { "version": "2.0.0-nightly.1" },
            })
        );

        let flow = Flow::new(current, None, Some(json!("broken")))
            .with_endpoints(Channel::Stable, &[stable_url.as_str()]);
        let (found, _) = flow
            .check(vec![
                (HK_DEV, head("1.0.0-dev.12", current)),
                (HK_BETA, head("1.0.0-beta.4", current)),
                (stable_url.as_str(), EndpointAnswer::Unsuccessful),
            ])
            .await;
        assert_eq!(found.unwrap(), Some(("1.0.0-dev.12", Channel::Dev)));
        assert_eq!(
            flow.saved().unwrap()["seen_update_versions"],
            json!({
                "dev": seen_entry("1.0.0-dev.12"),
                "beta": seen_entry("1.0.0-beta.4"),
            })
        );
    }

    /// 见过的版本逐个通道读、各用这个通道的钥重验：测试版那一项被改高，只废它自己；预览版与正式版的照用，两者的钥
    /// 不同，同一把钥验不过两项。键名大小写不同的不算这个通道，它记着更高的版本也顶不掉预览版那一项。
    #[tokio::test]
    async fn each_seen_entry_is_rechecked_alone_with_its_channel_key() {
        let flow = Flow::new(
            "1.0.0-dev.6",
            None,
            Some(json!({
                "dev": seen_entry("1.0.0-dev.8"),
                "Dev": seen_entry("1.0.0-dev.12"),
                "beta": { "version": "1.1.0-beta.2", "signature": signature_of("1.1.0-beta.1") },
                "stable": seen_entry("1.0.0"),
            })),
        );
        let plan = flow.plan().await;
        let verified = |channel: Channel, text: &str| VerifiedHead {
            channel,
            version: version(text),
            signature: signature_of(text).to_owned(),
        };
        assert_eq!(
            plan.seen,
            HashMap::from([
                (Channel::Dev, verified(Channel::Dev, "1.0.0-dev.8")),
                (Channel::Stable, verified(Channel::Stable, "1.0.0")),
            ])
        );
    }

    /// 几个通道同时问：每个端点都要 5 秒才答，三个通道问完也只花 5 秒，不是相加的 15 秒。
    #[tokio::test(start_paused = true)]
    async fn channels_are_asked_at_the_same_time() {
        let current = "1.0.0-dev.6";
        let plan = CheckPlan::new(
            version(current),
            None,
            &SeenUpdateEntries::default(),
            test_key,
        )
        .expect("预览版认得出通道");
        let mut groups = endpoint_groups(plan.preference, |channel| match channel {
            Channel::Dev => vec![HK_DEV.to_owned()],
            Channel::Beta => vec![HK_BETA.to_owned()],
            Channel::Stable => vec![HK_STABLE.to_owned()],
        });
        for group in &mut groups {
            group.pubkey = test_key(group.channel);
        }
        let started = tokio::time::Instant::now();
        let fetched = fetch_channels(&groups, &plan, |channel, _| async move {
            tokio::time::sleep(Duration::from_secs(5)).await;
            match channel {
                Channel::Dev => head("1.0.0-dev.12", current),
                Channel::Beta => head("1.0.0-beta.4", current),
                Channel::Stable => head("1.0.0", current),
            }
        })
        .await
        .expect("没有要再问状态码的端点");
        assert_eq!(
            started.elapsed(),
            Duration::from_secs(5),
            "三个通道该同时问"
        );
        let outcomes: Vec<(Channel, ChannelOutcome)> = fetched
            .iter()
            .map(|fetch| (fetch.channel, fetch.outcome.clone()))
            .collect();
        let published = |text: &str| ChannelOutcome::Published {
            endpoint: 0,
            version: version(text),
        };
        assert_eq!(
            outcomes,
            [
                (Channel::Dev, published("1.0.0-dev.12")),
                (Channel::Beta, published("1.0.0-beta.4")),
                (Channel::Stable, published("1.0.0")),
            ]
        );
    }

    /// 通道名只认 dev、beta、stable 三个小写名；大小写不同、带空白、不认识的名字与空串都报 `invalid_argument`，
    /// 说法里带着原样的名字。
    #[test]
    fn update_channel_names_are_the_three_lowercase_ones() {
        for (name, channel) in [
            ("dev", Channel::Dev),
            ("beta", Channel::Beta),
            ("stable", Channel::Stable),
        ] {
            assert_eq!(channel_named(name), Ok(channel));
        }
        for name in ["", "Dev", "STABLE", " beta", "beta ", "nightly", "release"] {
            let err = channel_named(name).unwrap_err();
            assert_eq!(err.code, code::INVALID_ARGUMENT, "{name:?}");
            assert!(
                err.message.contains(&format!("「{name}」")),
                "{}",
                err.message
            );
        }
    }

    /// 命令层的接线单测里造不出来（要 AppHandle），钉住源码：设置通道先认通道名、再看支不支持自更新，然后才写偏好，
    /// 交回写完之后从配置读出的状态；写偏好之前先看有没有下载或安装在进行，写完才清槽位。`updater_info` 同样从配置
    /// 读偏好。命令在 lib.rs 里注册。各步的行为由下面的用例验证。
    #[test]
    fn setting_the_channel_checks_the_name_and_support_before_writing() {
        let (source, _) = include_str!("updater.rs")
            .split_once("#[cfg(test)]")
            .unwrap();
        let in_order = |body: &str, steps: &[&str]| {
            let positions: Vec<usize> = steps
                .iter()
                .map(|step| {
                    body.find(step)
                        .unwrap_or_else(|| panic!("找不到 {step}\n{body}"))
                })
                .collect();
            assert!(
                positions.windows(2).all(|pair| pair[0] < pair[1]),
                "{steps:?} 的先后不对\n{body}"
            );
        };

        let set = top_level_fn(source, "pub async fn set_update_channel(");
        in_order(
            &set,
            &[
                "let channel = channel_named(&channel)?;",
                "updater.require_supported()?;",
                "apply_update_channel(&facade, &updater.slot, current, channel).await?;",
                "Ok(info_now(&facade, &updater, current).await)",
            ],
        );
        let apply = top_level_fn(source, "async fn apply_update_channel<");
        in_order(
            &apply,
            &[
                "lock_slot(slot).ensure_idle()?;",
                ".update_if_changed(",
                "lock_slot(slot).reset_for_new_preference();",
            ],
        );
        let info = top_level_fn(source, "pub async fn updater_info(");
        assert!(
            info.contains("info_now(&facade, &updater, &app.package_info().version).await"),
            "{info}"
        );
        let now = top_level_fn(source, "async fn info_now(");
        assert!(
            now.contains("facade.read().await.update_channel_preference()"),
            "{now}"
        );
        assert!(include_str!("../lib.rs").contains("commands::updater::set_update_channel,"));
    }

    /// 生效的通道变了：偏好写进配置，本次会话按旧偏好得来的进度全部作废（候选、下好的包、各通道的结果、因为没能写下
    /// 偏好而被拒的版本），退出时不再安装，号加一；因为认不得数据而被拒的版本与偏好无关，留着。交回的状态按新偏好算。
    #[tokio::test]
    async fn a_new_effective_channel_clears_the_session_progress() {
        for (target, relation) in [
            (Channel::Stable, ChannelRelation::Waiting),
            (Channel::Dev, ChannelRelation::Following),
        ] {
            let flow = Flow::new("1.0.0-beta.4", None, None);
            flow.fill_session();
            let ticket = flow.ticket();
            flow.set_channel(target).await.unwrap();
            assert_eq!(
                flow.saved().unwrap()["update_channel"],
                json!(target.as_str())
            );
            assert_ne!(flow.ticket(), ticket);
            let info = flow.info().await;
            assert_eq!(info.package_channel, Some(Channel::Beta));
            assert_eq!(info.preference, Some(target));
            assert_eq!(info.relation, Some(relation));
            assert_eq!(info.available, None);
            assert!(info.channel_heads.is_empty());
            assert_eq!(info.downloaded_version, None);
            assert_eq!(info.downloaded_channel, None);
            assert_eq!(info.downloaded_intent, None);
            assert!(!info.install_on_exit);
            assert_eq!(
                info.refused,
                [RefusedUpdateDto {
                    version: "1.0.0-beta.6".to_owned(),
                    channel: Channel::Beta,
                    reason: RefusalReason::DataTooNew,
                    intent: UpdateIntent::Update,
                }]
            );
        }
    }

    /// 生效的通道没变：只把偏好写进配置，号不变，槽位原样，交回的状态与写之前一样。偏好缺省时选本包的通道、配置里是
    /// 认不出的值时选本包的通道，都算没变，配置里写下这个名字；已经存着同一个通道时连配置都不写。
    #[tokio::test]
    async fn an_unchanged_effective_channel_only_writes_the_preference() {
        for (stored, written) in [
            (None, true),
            (Some(json!("nightly")), true),
            (Some(json!("beta")), false),
        ] {
            let flow = Flow::new("1.0.0-beta.4", stored.clone(), None);
            flow.fill_session();
            let ticket = flow.ticket();
            let before = flow.info().await;
            assert_eq!(before.downloaded_version.as_deref(), Some("1.0.0-beta.5"));
            flow.set_channel(Channel::Beta).await.unwrap();
            assert_eq!(flow.ticket(), ticket, "{stored:?}");
            assert_eq!(flow.info().await, before, "{stored:?}");
            let saved = flow.saved().map(|saved| saved["update_channel"].clone());
            assert_eq!(saved, written.then(|| json!("beta")), "{stored:?}");
        }
    }

    /// 有下载或安装正在进行（忙碌标记被占着）时改不了通道：报 `update_busy`，配置与槽位都不动；那一次结束后就能改。
    #[tokio::test]
    async fn the_channel_stays_while_a_download_or_install_runs() {
        let flow = Flow::new("1.0.0-beta.4", None, None);
        flow.fill_session();
        let ticket = flow.ticket();
        let before = flow.info().await;
        let running = lock_slot(&flow.slot).try_begin_busy().unwrap();
        let err = flow.set_channel(Channel::Stable).await.unwrap_err();
        assert_eq!(err.code, code::UPDATE_BUSY);
        assert_eq!(flow.saved(), None);
        assert_eq!(flow.ticket(), ticket);
        assert_eq!(flow.info().await, before);

        drop(running);
        flow.set_channel(Channel::Stable).await.unwrap();
        assert_eq!(flow.saved().unwrap()["update_channel"], json!("stable"));
        assert_ne!(flow.ticket(), ticket);
    }

    /// 偏好写不进配置：照写配置失败报错，门面里的偏好不变，槽位与号都不动，免得界面按新通道显示、重启后却回到旧的。
    #[tokio::test]
    async fn a_channel_that_cannot_be_saved_changes_nothing() {
        let flow = Flow::new("1.0.0-beta.4", None, None);
        flow.fill_session();
        flow.block_config_writes();
        let ticket = flow.ticket();
        let before = flow.info().await;
        let err = flow.set_channel(Channel::Stable).await.unwrap_err();
        let save_failed = flow
            .facade
            .update_if_changed(|petalfall| petalfall.set_update_channel_preference(Channel::Stable))
            .await
            .unwrap_err();
        assert_eq!(err.code, CommandError::from(save_failed).code);
        assert_eq!(flow.facade.read().await.update_channel_preference(), None);
        assert_eq!(flow.ticket(), ticket);
        assert_eq!(flow.info().await, before);
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
