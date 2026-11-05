//! 启动器自更新：检查、下载、安装，以及「退出时安装」。
//!
//! 走 Rust 侧命令而不是让前端直接调插件：端点要按「文件下载源」策略每次重排（主源与镜像谁先），
//! 插件的 JS 接口只能用 tauri.conf.json 里写死的端点。
//!
//! 插件只在配置了签名公钥的发行构建里注册（[`detect_support`]）。没有公钥时插件初始化本身就会失败，
//! 而且没有公钥就无从校验更新包，宁可整体不支持；此时各命令报 `updater_unsupported`。
//! 仓库里的配置不带公钥，dev 分支的 CI 打包时才写入开发版公钥（`.github/dev-updater.pub`）：
//! 本地和 fork 构建的包不会去认落樱的更新。
//!
//! 去哪取清单由版本号决定（[`UpdateChannel`]），与前端从版本号推发布通道同源，不另设配置。

use std::sync::{Mutex, MutexGuard};
use std::time::{Duration, Instant};

use petalfall_core::{CancellationToken, CoreEvent, DownloadProgress, EventSink};
use serde::Serialize;
use serde_json::{json, Map, Value};
use tauri::{AppHandle, Manager, State, Url};
use tauri_plugin_updater::{Update, UpdaterExt};

use crate::commands::error::{code, source_chain, CommandError};
use crate::events::CoreEventForwarder;
use crate::facade::Facade;
use crate::tasks::TaskRegistry;

/// 主更新源的清单地址。
pub const PRIMARY_ENDPOINT: &str = concat!(
    "https://",
    petalfall_base::app_slug!(),
    ".org/updates/latest.json"
);

/// 国内镜像的清单地址。
pub const MIRROR_ENDPOINT: &str = concat!(
    "https://",
    petalfall_base::app_slug!(),
    ".cn/updates/latest.json"
);

/// 镜像域名完成 ICP 备案前不能对外服务，先关着；打开后端点顺序按下载源策略排。
pub const MIRROR_ENABLED: bool = false;

/// dev 分支每次构建都重建的滚动预发布，CI 里的 tag 必须与它一致。
const DEV_RELEASE_TAG: &str = "dev-build";

/// 开发版通道的清单地址。dev 包本来就发在这个预发布上，清单和安装包放在一起，不用另找地方托管；
/// 只有这一个源，也就不按下载源策略排序。
pub fn dev_endpoint() -> String {
    format!(
        "{}/releases/download/{DEV_RELEASE_TAG}/latest.json",
        petalfall_base::brand::REPO_URL
    )
}

/// 更新通道：决定去哪里取清单。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UpdateChannel {
    /// dev 分支的 CI 构建，版本号形如 `0.1.0-dev.12`。
    Dev,
    /// 其余版本，走主源与镜像。
    Release,
}

impl UpdateChannel {
    /// 看版本号预发布标识的第一段：`dev` 后面只跟数字（或什么都不跟）的是开发版，大小写不论，
    /// 与前端 build-info 认 dev 的规则一致。semver 的预发布标识只含 ASCII。
    pub fn of(pre_release: &str) -> Self {
        let tag = pre_release
            .split_once('.')
            .map_or(pre_release, |(head, _)| head);
        let is_dev = tag
            .get(..3)
            .is_some_and(|head| head.eq_ignore_ascii_case("dev"))
            && tag[3..].bytes().all(|byte| byte.is_ascii_digit());
        if is_dev {
            UpdateChannel::Dev
        } else {
            UpdateChannel::Release
        }
    }
}

/// 单个端点取清单的时限。清单是一次性的小请求，比下载源探测放宽，慢网下也要能拿到。
const CHECK_TIMEOUT: Duration = Duration::from_secs(10);

/// 清单不存在时更新源回的状态码：这个源上还没有发布。
const MANIFEST_MISSING_STATUS: u16 = 404;

/// 下载进度推送的最小间隔，与下载池的采样间隔一致，前端进度条观感相同。
const PROGRESS_INTERVAL: Duration = Duration::from_millis(100);

/// 当前环境为什么没有自更新能力。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum UnsupportedReason {
    /// 开发构建：exe 不是安装程序装的，装更新会把正式版装到别处再退出当前开发会话。
    DebugBuild,
    /// tauri.conf.json 没有 `plugins.updater.pubkey`。
    MissingPubkey,
}

impl UnsupportedReason {
    fn message(self) -> &'static str {
        match self {
            UnsupportedReason::DebugBuild => "开发构建不支持自更新",
            UnsupportedReason::MissingPubkey => {
                "没有配置更新签名公钥，无法校验更新包，自更新已停用"
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

/// 由构建类型与 tauri.conf.json 的 `plugins.updater` 判定是否支持自更新，决定插件注册与否。
pub fn detect_support(updater_config: Option<&Value>, debug_build: bool) -> UpdaterSupport {
    if debug_build {
        return UpdaterSupport::Unsupported(UnsupportedReason::DebugBuild);
    }
    let has_pubkey = updater_config
        .and_then(|config| config.get("pubkey"))
        .and_then(Value::as_str)
        .is_some_and(|key| !key.trim().is_empty());
    if has_pubkey {
        UpdaterSupport::Supported
    } else {
        UpdaterSupport::Unsupported(UnsupportedReason::MissingPubkey)
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
}

fn update_dto(update: &Update) -> UpdateDto {
    UpdateDto {
        version: update.version.clone(),
        current_version: update.current_version.clone(),
        notes: update.body.clone(),
        date: update
            .date
            .map(|date| date.unix_timestamp() * 1000 + i64::from(date.millisecond())),
    }
}

/// 设置页「关于与更新」要的全部状态；前端重载后据此恢复「有更新 / 已下载待安装」。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct UpdaterInfoDto {
    pub current_version: String,
    pub supported: bool,
    /// debug_build / missing_pubkey；支持时为 `null`。
    pub unsupported_reason: Option<UnsupportedReason>,
    /// 本次会话最近一次检查的结果；没检查过或已是最新时为 `null`。
    pub available: Option<UpdateDto>,
    /// 已下载并通过签名校验、等待安装的版本。
    pub downloaded_version: Option<String>,
    pub install_on_exit: bool,
}

/// 槽位只关心版本号；抽成 trait 是为了单测不必构造插件的 `Update`（字段私有，外部造不出来）。
trait ReleaseVersion {
    fn release_version(&self) -> &str;
}

impl ReleaseVersion for Update {
    fn release_version(&self) -> &str {
        &self.version
    }
}

struct Downloaded<U> {
    update: U,
    bytes: Vec<u8>,
}

/// 一次检查给槽位的结论。
enum CheckConclusion<U> {
    /// 取到了清单：`Some` 是比当前新的版本，`None` 是已是最新。
    Manifest(Option<U>),
    /// 所有端点都确认清单 404：这个更新源上还没有发布。
    NotPublished,
}

/// 一次会话内的更新进度：检查到的、下载好的、是否退出时安装。只在内存里，重启即清空。
struct UpdateSlot<U> {
    available: Option<U>,
    downloaded: Option<Downloaded<U>>,
    install_on_exit: bool,
}

impl<U> Default for UpdateSlot<U> {
    fn default() -> Self {
        Self {
            available: None,
            downloaded: None,
            install_on_exit: false,
        }
    }
}

impl<U: ReleaseVersion> UpdateSlot<U> {
    /// 记下检查结果。已下载的包只有与新结果同版本才保留，否则丢弃并取消「退出时安装」，
    /// 免得界面显示新版本、退出时却装上旧包。
    fn record_check(&mut self, found: Option<U>) {
        let keep = matches!(
            (&self.downloaded, &found),
            (Some(ready), Some(found)) if ready.update.release_version() == found.release_version()
        );
        if !keep {
            if let Some(stale) = self.downloaded.take() {
                tracing::info!(
                    version = stale.update.release_version(),
                    "已下载的更新包与最新检查结果不一致，丢弃"
                );
                self.install_on_exit = false;
            }
        }
        self.available = found;
    }

    /// 收下一次检查的结论，返回这次要告诉前端的版本。
    ///
    /// 清单 404 时这个更新源上还没有发布，不算检查失败；但没拿到清单也说不清最新版本是哪个，
    /// 所以槽位不动，记着的版本和下好的包照旧；什么都没记着时前端看到的就是没有新版本。
    fn settle_check(&mut self, conclusion: CheckConclusion<U>) -> Option<&U> {
        if let CheckConclusion::Manifest(found) = conclusion {
            self.record_check(found);
        }
        self.available.as_ref()
    }

    /// 下载前重查的结论落进槽位，返回该下载的版本。清单 404 时沿用记着的版本，见 [`settle_check`](Self::settle_check)。
    fn update_to_download(&mut self, conclusion: CheckConclusion<U>) -> Result<U, CommandError>
    where
        U: Clone,
    {
        self.settle_check(conclusion).cloned().ok_or_else(|| {
            CommandError::new(code::UPDATE_NOT_AVAILABLE, "重新检查后已经没有可用更新")
        })
    }

    /// 收下下载好的包。下载期间又检查过一次、结果换了版本或已无更新时不收：与 [`record_check`](Self::record_check)
    /// 守的是同一件事，界面按最新的检查结果显示版本，退出时装上的却是旧包。
    fn store_download(&mut self, update: U, bytes: Vec<u8>) -> Result<(), CommandError> {
        let latest = self.available.as_ref().map(ReleaseVersion::release_version);
        if latest != Some(update.release_version()) {
            tracing::info!(
                downloaded = update.release_version(),
                ?latest,
                "下载期间检查结果已变化，丢弃刚下好的更新包"
            );
            let message = match latest {
                Some(latest) => format!(
                    "下载期间检查到了更新的版本 {latest}，刚下好的 {} 已作废，请重新下载",
                    update.release_version()
                ),
                None => format!(
                    "下载期间再次检查时已没有可用更新，刚下好的 {} 已作废",
                    update.release_version()
                ),
            };
            return Err(CommandError::new(code::UPDATE_NOT_AVAILABLE, message));
        }
        self.downloaded = Some(Downloaded { update, bytes });
        Ok(())
    }

    fn ready(&self) -> Result<&Downloaded<U>, CommandError> {
        self.downloaded
            .as_ref()
            .ok_or_else(|| CommandError::new(code::UPDATE_NOT_READY, "更新包还没有下载完成"))
    }

    fn set_install_on_exit(&mut self, enabled: bool) -> Result<(), CommandError> {
        if enabled {
            self.ready()?;
        }
        self.install_on_exit = enabled;
        Ok(())
    }

    fn downloaded_version(&self) -> Option<String> {
        self.downloaded
            .as_ref()
            .map(|ready| ready.update.release_version().to_owned())
    }
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
            UpdaterSupport::Unsupported(reason) => Err(CommandError::new(
                code::UPDATER_UNSUPPORTED,
                reason.message(),
            )
            .with_detail(json!({ "reason": reason }))),
        }
    }

    fn info(&self, current_version: String) -> UpdaterInfoDto {
        let slot = self.slot();
        let (supported, unsupported_reason) = match self.support {
            UpdaterSupport::Supported => (true, None),
            UpdaterSupport::Unsupported(reason) => (false, Some(reason)),
        };
        UpdaterInfoDto {
            current_version,
            supported,
            unsupported_reason,
            available: slot.available.as_ref().map(update_dto),
            downloaded_version: slot.downloaded_version(),
            install_on_exit: slot.install_on_exit,
        }
    }

    /// 拉起已下载更新包的安装程序。Windows 上成功即退出进程，不会返回。
    fn install_downloaded(&self) -> Result<(), CommandError> {
        let slot = self.slot();
        let ready = slot.ready()?;
        tracing::info!(version = %ready.update.version, "开始安装更新");
        ready.update.install(&ready.bytes).map_err(|err| {
            updater_error(code::UPDATE_INSTALL_FAILED, "启动更新安装失败", None, err)
        })
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

/// 检查更新。开发版只问 [`dev_endpoint`]；其余版本的端点按「文件下载源」策略排序，前一个连不上或非 2xx 时
/// 插件自动试下一个。
/// 已是最新返回 `null`；所有端点的清单都确认 404 不算失败，见 [`conclude_check`] 与 [`UpdateSlot::settle_check`]。
/// 不看 `check_updates` 设置：那一项只管启动时要不要自动查，由前端决定。
#[tauri::command]
pub async fn check_update(
    app: AppHandle,
    facade: State<'_, Facade>,
    updater: State<'_, UpdaterState>,
) -> Result<Option<UpdateDto>, CommandError> {
    updater.require_supported()?;
    let conclusion = fetch_conclusion(&app, &facade).await?;
    let dto = updater.slot().settle_check(conclusion).map(update_dto);
    Ok(dto)
}

/// 取一次清单并下结论。检查和下载前的重查共用。
async fn fetch_conclusion(
    app: &AppHandle,
    facade: &Facade,
) -> Result<CheckConclusion<Update>, CommandError> {
    let endpoints = match UpdateChannel::of(app.package_info().version.pre.as_str()) {
        UpdateChannel::Dev => vec![dev_endpoint()],
        UpdateChannel::Release => {
            facade
                .snapshot()
                .await
                .update_endpoints(PRIMARY_ENDPOINT, MIRROR_ENABLED.then_some(MIRROR_ENDPOINT))
                .await
        }
    };
    let urls = endpoint_urls(&endpoints);
    let checker = app
        .updater_builder()
        .endpoints(urls)
        .and_then(|builder| builder.timeout(CHECK_TIMEOUT).build())
        .map_err(|err| check_failed(&endpoints, err))?;
    let checked = checker.check().await;
    match &checked {
        Ok(Some(update)) => {
            tracing::info!(version = %update.version, ?endpoints, "发现可用更新")
        }
        Ok(None) => tracing::info!(?endpoints, "已是最新版本"),
        Err(_) => {}
    }
    let version = app.package_info().version.to_string();
    conclude_check(checked, &version, &endpoints).await
}

/// 把插件的检查结果变成给槽位的结论。
///
/// `ReleaseNotFound` 只说明所有端点都回了非 2xx，插件不报状态码，503、403 这类服务器故障也长这样。
/// 所以自己再问一次，确认是 404 才算没有发布，否则服务器出故障时界面会显示已是最新。
async fn conclude_check<U>(
    checked: tauri_plugin_updater::Result<Option<U>>,
    app_version: &str,
    endpoints: &[String],
) -> Result<CheckConclusion<U>, CommandError> {
    match checked {
        Ok(found) => Ok(CheckConclusion::Manifest(found)),
        Err(tauri_plugin_updater::Error::ReleaseNotFound) => {
            confirm_manifest_missing(app_version, endpoints).await?;
            Ok(CheckConclusion::NotPublished)
        }
        Err(err) => Err(check_failed(endpoints, err)),
    }
}

/// 逐个端点再 GET 一次清单。只要有一个端点答不出 404，就说不清那个源上有没有新版本，只能算检查失败。
async fn confirm_manifest_missing(
    app_version: &str,
    endpoints: &[String],
) -> Result<(), CommandError> {
    let http = petalfall_base::http::build_client_with(
        &petalfall_base::http::HttpConfig::for_app_version(app_version),
    )?;
    for endpoint in endpoints {
        let response = http
            .get(endpoint)
            .header("accept", "application/json")
            .timeout(CHECK_TIMEOUT)
            .send()
            .await
            .map_err(|err| check_failed(endpoints, tauri_plugin_updater::Error::Reqwest(err)))?;
        let status = response.status().as_u16();
        if status != MANIFEST_MISSING_STATUS {
            tracing::warn!(
                endpoint,
                status,
                "更新源没有给出清单，也不是 404，算检查失败"
            );
            return Err(
                CommandError::new(code::UPDATE_CHECK_FAILED, "更新服务器返回了异常状态")
                    .with_detail(json!({ "endpoints": endpoints, "status": status })),
            );
        }
    }
    // 界面上不算失败，日志要留痕。
    tracing::warn!(?endpoints, "更新源上没有清单（404），按没有新版本处理");
    Ok(())
}

fn check_failed(endpoints: &[String], err: tauri_plugin_updater::Error) -> CommandError {
    updater_error(
        code::UPDATE_CHECK_FAILED,
        "检查更新失败",
        Some(endpoints),
        err,
    )
}

/// 先按最新清单重查一次，再下载其中的更新并校验签名，返回实际下载的版本（可能比界面上记着的新）。
/// 长任务：进度经 core-event 推送（`kind: "download"`，`total` 恒为 1，带 `task_id`），可经
/// `cancel_task(taskId)` 取消。签名不符报 `update_signature_invalid`，包随即丢弃；下载期间再次检查换了版本
/// 或已无更新时报 `update_not_available`，包同样丢弃。
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
        // 开发版的滚动预发布每次构建都删掉上一版安装包，检查时记下的地址过一阵就 404，重试也一样
        let conclusion = fetch_conclusion(&app, &facade).await?;
        let update = updater.slot().update_to_download(conclusion)?;
        let bytes = task
            .run(download_with_progress(&update, events.sink(), task.token()))
            .await?;
        let dto = update_dto(&update);
        tracing::info!(version = %update.version, size = bytes.len(), "更新包下载并校验完成");
        updater.slot().store_download(update, bytes)?;
        Ok(dto)
    }
    .await;
    events.finish().await;
    outcome
}

/// 立即安装已下载的更新。Windows 上拉起安装程序后进程退出，前端收不到返回；
/// 其它平台替换完文件后由这里重启。
#[tauri::command]
pub async fn install_update(
    app: AppHandle,
    updater: State<'_, UpdaterState>,
    facade: State<'_, Facade>,
) -> Result<(), CommandError> {
    updater.require_supported()?;
    install_after_persisting(&facade, || updater.install_downloaded()).await?;
    app.restart()
}

/// 先做退出收尾里的落盘（[`crate::exit::persist_before_exit`]：等进行中的外置令牌轮换、补写游玩记录）再安装：
/// Windows 上更新插件拉起安装程序后直接结束进程，不经过 `RunEvent::Exit`，退出收尾赶不上。等不到或补写失败
/// 都只记日志、照样安装，与正常退出时一致。
pub(crate) async fn install_after_persisting(
    facade: &Facade,
    install: impl FnOnce() -> Result<(), CommandError>,
) -> Result<(), CommandError> {
    crate::exit::persist_before_exit(facade).await;
    install()
}

/// 开关「退出时安装」。打开前更新包必须已下载好（否则 `update_not_ready`）。
#[tauri::command]
pub async fn set_install_on_exit(
    enabled: bool,
    updater: State<'_, UpdaterState>,
) -> Result<(), CommandError> {
    updater.require_supported()?;
    updater.slot().set_install_on_exit(enabled)
}

/// 在 `RunEvent::Exit` 里调用：选了「退出时安装」就在进程退出前拉起安装程序。
pub fn install_on_exit(app: &AppHandle) {
    let updater = app.state::<UpdaterState>();
    if !updater.slot().install_on_exit {
        return;
    }
    // 退出路径上没有前端可以报错，只能记日志；下次启动检查更新时会再次提示。
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

async fn download_with_progress(
    update: &Update,
    sink: &EventSink,
    cancel: &CancellationToken,
) -> Result<Vec<u8>, CommandError> {
    let mut meter = DownloadMeter::new(Instant::now(), PROGRESS_INTERVAL);
    let verify_sink = sink.clone();
    let download = update.download(
        |len, content_length| {
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
    let bytes = cancel
        .run_until_cancelled(download)
        .await
        .ok_or_else(CommandError::cancelled)?
        .map_err(|err| updater_error(code::UPDATE_DOWNLOAD_FAILED, "下载更新失败", None, err))?;
    send(sink, CoreEvent::Download(meter.finish(Instant::now())));
    Ok(bytes)
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
        UpdaterError::Minisign(_) | UpdaterError::Base64(_) | UpdaterError::SignatureUtf8(_) => {
            code::UPDATE_SIGNATURE_INVALID
        }
        _ => fallback,
    };
    let message = err.to_string();
    let causes = source_chain(&err);
    let mut detail = Map::new();
    if let Some(endpoints) = endpoints {
        detail.insert("endpoints".to_owned(), json!(endpoints));
    }
    // 插件的 Reqwest 变体是 transparent：它的 source() 直接给出 reqwest 错误的下一层，
    // 从插件错误顺着原因链找不到 reqwest 错误本身，只能在这里取出来判断。
    let network = match &err {
        UpdaterError::Reqwest(http) => petalfall_base::http::network_failure(http),
        other => petalfall_base::http::network_failure(other),
    };
    if let Some(failure) = network {
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

#[cfg(test)]
mod tests {
    use super::*;

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
        let result = install_after_persisting(&facade, || {
            on_disk_at_install = Some(std::fs::read_to_string(&path).unwrap());
            Err(CommandError::new(
                code::UPDATE_INSTALL_FAILED,
                "启动更新安装失败",
            ))
        })
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
        let rotation = crate::exit::tests::authlib_rotation_in_flight(dir.path()).await;
        assert_eq!(rotation.stored_token(), "stale");

        let mut stored_at_install = None;
        install_after_persisting(&rotation.facade, || {
            stored_at_install = Some(rotation.stored_token());
            Ok(())
        })
        .await
        .unwrap();
        assert_eq!(stored_at_install.as_deref(), Some("rotated"));
    }

    #[test]
    fn support_requires_release_build_and_non_empty_pubkey() {
        let with_key = json!({ "pubkey": "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWdu" });
        assert_eq!(
            detect_support(Some(&with_key), false),
            UpdaterSupport::Supported
        );
        assert_eq!(
            detect_support(Some(&with_key), true),
            UpdaterSupport::Unsupported(UnsupportedReason::DebugBuild)
        );
        for config in [json!({}), json!({ "pubkey": "  " }), json!({ "pubkey": 7 })] {
            assert_eq!(
                detect_support(Some(&config), false),
                UpdaterSupport::Unsupported(UnsupportedReason::MissingPubkey),
                "{config}"
            );
        }
        assert_eq!(
            detect_support(None, false),
            UpdaterSupport::Unsupported(UnsupportedReason::MissingPubkey)
        );
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

    #[test]
    fn endpoints_are_https_on_brand_domains() {
        let urls = endpoint_urls(&[PRIMARY_ENDPOINT.to_owned(), MIRROR_ENDPOINT.to_owned()]);
        assert_eq!(urls[0].scheme(), "https");
        assert_eq!(
            urls[0].host_str(),
            Some(format!("{}.org", petalfall_base::brand::APP_SLUG).as_str())
        );
        assert_eq!(
            urls[1].host_str(),
            Some(format!("{}.cn", petalfall_base::brand::APP_SLUG).as_str())
        );
    }

    #[test]
    fn channel_follows_the_first_pre_release_identifier() {
        for dev in ["dev.12", "dev", "dev3", "DEV.1", "Dev.7.rc"] {
            assert_eq!(UpdateChannel::of(dev), UpdateChannel::Dev, "{dev}");
        }
        for release in [
            "",
            "beta.1",
            "rc.2",
            "preview.3",
            "nightly",
            "devx.1",
            "dev-1",
            "de",
            "alpha.dev",
        ] {
            assert_eq!(
                UpdateChannel::of(release),
                UpdateChannel::Release,
                "{release}"
            );
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

        // Windows 检出的工作流是 CRLF，逐行比，不拿换行符做界
        let workflow: Vec<&str> = include_str!("../../../../.github/workflows/dev-build.yml")
            .lines()
            .map(str::trim)
            .collect();
        assert!(workflow.contains(&format!("TAG: {DEV_RELEASE_TAG}").as_str()));
        assert!(workflow.contains(&"manifest=\"$RUNNER_TEMP/latest.json\""));
        assert!(workflow.iter().any(|line| line.starts_with("\"$MANIFEST#")));
    }

    #[derive(Clone)]
    struct Fake(&'static str);

    impl ReleaseVersion for Fake {
        fn release_version(&self) -> &str {
            self.0
        }
    }

    #[test]
    fn install_on_exit_needs_a_downloaded_package() {
        let mut slot = UpdateSlot::<Fake>::default();
        let err = slot.set_install_on_exit(true).unwrap_err();
        assert_eq!(err.code, code::UPDATE_NOT_READY);
        assert!(!slot.install_on_exit);

        slot.record_check(Some(Fake("0.2.0")));
        slot.store_download(Fake("0.2.0"), vec![1, 2, 3]).unwrap();
        slot.set_install_on_exit(true).unwrap();
        assert!(slot.install_on_exit);
        assert_eq!(slot.ready().unwrap().bytes, vec![1, 2, 3]);
        slot.set_install_on_exit(false).unwrap();
        assert!(!slot.install_on_exit);
    }

    /// 再查一次：同版本保留已下载的包；版本变了或已无更新，丢包并撤销退出时安装。
    #[test]
    fn recheck_keeps_package_only_for_the_same_version() {
        let mut slot = UpdateSlot::<Fake>::default();
        slot.record_check(Some(Fake("0.2.0")));
        slot.store_download(Fake("0.2.0"), vec![9]).unwrap();
        slot.set_install_on_exit(true).unwrap();

        slot.record_check(Some(Fake("0.2.0")));
        assert_eq!(slot.downloaded_version().as_deref(), Some("0.2.0"));
        assert!(slot.install_on_exit);

        slot.record_check(Some(Fake("0.2.1")));
        assert_eq!(slot.downloaded_version(), None);
        assert!(!slot.install_on_exit);
        assert_eq!(slot.available.as_ref().map(|u| u.0), Some("0.2.1"));

        slot.store_download(Fake("0.2.1"), vec![1]).unwrap();
        slot.record_check(None);
        assert_eq!(slot.downloaded_version(), None);
        assert!(slot.available.is_none());
    }

    /// 下载期间又检查了一次（页面重载后的自动检查）：检查换了版本或已无更新时，下好的旧包不收，
    /// 「退出时安装」也就打不开，不会在界面显示新版本时退出装上旧包；检查结果没变照常收下。
    #[test]
    fn download_outdated_by_a_check_during_it_is_discarded() {
        let mut slot = UpdateSlot::<Fake>::default();
        slot.record_check(Some(Fake("0.2.0")));
        let downloading = slot.available.clone().unwrap();
        slot.record_check(Some(Fake("0.2.1")));

        let err = slot.store_download(downloading, vec![7]).unwrap_err();
        assert_eq!(err.code, code::UPDATE_NOT_AVAILABLE);
        assert!(err.message.contains("0.2.1"), "{}", err.message);
        assert!(err.message.contains("0.2.0"), "{}", err.message);
        assert_eq!(slot.downloaded_version(), None);
        assert_eq!(
            slot.set_install_on_exit(true).unwrap_err().code,
            code::UPDATE_NOT_READY
        );

        slot.record_check(None);
        let err = slot.store_download(Fake("0.2.1"), vec![8]).unwrap_err();
        assert_eq!(err.code, code::UPDATE_NOT_AVAILABLE);
        assert_eq!(slot.downloaded_version(), None);

        slot.record_check(Some(Fake("0.2.1")));
        slot.store_download(Fake("0.2.1"), vec![9]).unwrap();
        assert_eq!(slot.downloaded_version().as_deref(), Some("0.2.1"));
        assert_eq!(slot.ready().unwrap().bytes, vec![9]);
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

    /// 没拿到清单就说不清最新版本是哪个：本次会话记着的版本、下好的包和退出时安装都不动，
    /// 否则一次 404 就会把校验过的包丢掉。
    #[test]
    fn missing_manifest_keeps_what_the_session_knows() {
        let mut slot = UpdateSlot::<Fake>::default();
        assert!(slot.settle_check(CheckConclusion::NotPublished).is_none());

        slot.record_check(Some(Fake("0.2.0")));
        slot.store_download(Fake("0.2.0"), vec![9]).unwrap();
        slot.set_install_on_exit(true).unwrap();
        let known = slot.settle_check(CheckConclusion::NotPublished);
        assert_eq!(known.map(|update| update.0), Some("0.2.0"));
        assert_eq!(slot.downloaded_version().as_deref(), Some("0.2.0"));
        assert!(slot.install_on_exit);

        // 拿到了清单才是结论：已无更新时照旧丢包。
        assert!(slot.settle_check(CheckConclusion::Manifest(None)).is_none());
        assert_eq!(slot.downloaded_version(), None);
        assert!(!slot.install_on_exit);
    }

    /// 检查到 dev.12 之后预发布已重建成 dev.13：下载按重查到的版本走，不去拿已删掉的旧地址。
    #[test]
    fn download_follows_the_recheck_not_the_remembered_version() {
        let mut slot = UpdateSlot::<Fake>::default();
        slot.record_check(Some(Fake("0.1.0-dev.12")));

        let newer = slot
            .update_to_download(CheckConclusion::Manifest(Some(Fake("0.1.0-dev.13"))))
            .unwrap();
        assert_eq!(newer.0, "0.1.0-dev.13");
        assert_eq!(slot.available.as_ref().map(|u| u.0), Some("0.1.0-dev.13"));
        // 下好的正是重查到的版本，槽位照收
        slot.store_download(newer, vec![7]).unwrap();
        assert_eq!(slot.downloaded_version().as_deref(), Some("0.1.0-dev.13"));

        // 预发布正在重建、清单 404：沿用记着的版本
        let kept = slot
            .update_to_download(CheckConclusion::NotPublished)
            .unwrap();
        assert_eq!(kept.0, "0.1.0-dev.13");

        let Err(err) = slot.update_to_download(CheckConclusion::Manifest(None)) else {
            panic!("重查已无更新时不该给出可下载的版本");
        };
        assert_eq!(err.code, code::UPDATE_NOT_AVAILABLE);
        assert_eq!(slot.available.as_ref().map(|u| u.0), None);
        assert_eq!(slot.downloaded_version(), None);
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

    /// 插件报 `ReleaseNotFound` 之后的结论。
    async fn after_release_not_found(
        endpoints: &[String],
    ) -> Result<CheckConclusion<Fake>, CommandError> {
        conclude_check(
            Err(tauri_plugin_updater::Error::ReleaseNotFound),
            "0.1.0",
            endpoints,
        )
        .await
    }

    #[tokio::test]
    async fn manifest_404_counts_as_not_published() {
        let (_source, url) = source_answering(404).await;
        let conclusion = after_release_not_found(&[url]).await.unwrap();
        assert!(matches!(conclusion, CheckConclusion::NotPublished));
    }

    /// 服务器故障不能显示成已是最新：404 以外的状态一律是检查失败，状态码进 detail 让界面写出来。
    /// 200 是两次请求之间服务恢复了，这次同样没拿到清单，重试就好。
    #[tokio::test]
    async fn other_statuses_behind_release_not_found_stay_check_failures() {
        for status in [200, 400, 401, 403, 405, 429, 500, 502, 503] {
            let (_source, url) = source_answering(status).await;
            let endpoints = vec![url];
            let err = after_release_not_found(&endpoints).await.err().unwrap();
            assert_eq!(err.code, code::UPDATE_CHECK_FAILED, "{status}");
            let detail = err.detail.unwrap();
            assert_eq!(detail["status"], json!(status));
            assert_eq!(detail["endpoints"], json!(endpoints));
            assert!(detail.get("network").is_none(), "{status}");
        }
    }

    /// 再问一次时连不上：和插件自己连不上一样是检查失败，照样标出网络层失败的种类。
    #[tokio::test]
    async fn probe_that_cannot_connect_stays_a_check_failure() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!(
            "http://127.0.0.1:{}{MANIFEST}",
            listener.local_addr().unwrap().port()
        );
        drop(listener);

        let endpoints = vec![url];
        let err = after_release_not_found(&endpoints).await.err().unwrap();
        assert_eq!(err.code, code::UPDATE_CHECK_FAILED);
        let detail = err.detail.unwrap();
        assert_eq!(detail["network"], json!("connect"));
        assert_eq!(detail["endpoints"], json!(endpoints));
    }

    /// 主源与镜像都开着时：每个端点都确认 404 才算没有发布，任一端点故障就说不清它上面有没有新版本。
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
        for endpoints in [
            [missing_url.clone(), broken_url.clone()],
            [broken_url.clone(), missing_url.clone()],
        ] {
            let err = after_release_not_found(&endpoints).await.err().unwrap();
            assert_eq!(err.code, code::UPDATE_CHECK_FAILED);
            assert_eq!(err.detail.unwrap()["status"], json!(503));
        }
    }

    #[tokio::test]
    async fn check_results_with_a_manifest_need_no_probe() {
        let (source, url) = source_answering(503).await;
        let endpoints = vec![url];

        let found = conclude_check(Ok(Some(Fake("0.2.0"))), "0.1.0", &endpoints)
            .await
            .unwrap();
        assert!(matches!(
            found,
            CheckConclusion::Manifest(Some(Fake("0.2.0")))
        ));
        let latest = conclude_check::<Fake>(Ok(None), "0.1.0", &endpoints)
            .await
            .unwrap();
        assert!(matches!(latest, CheckConclusion::Manifest(None)));
        assert!(source.received_requests().await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn other_check_failures_stay_failures_without_a_probe() {
        let (source, url) = source_answering(404).await;
        let err = conclude_check::<Fake>(
            Err(tauri_plugin_updater::Error::TargetNotFound(
                "windows-x86_64".into(),
            )),
            "0.1.0",
            &[url],
        )
        .await
        .err()
        .unwrap();
        assert_eq!(err.code, code::UPDATE_CHECK_FAILED);
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
