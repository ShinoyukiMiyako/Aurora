//! 启动器自更新：检查、下载、安装，以及「退出时安装」。
//!
//! 走 Rust 侧命令而不是让前端直接调插件：端点要按「文件下载源」策略每次重排（主源与镜像谁先），
//! 插件的 JS 接口只能用 tauri.conf.json 里写死的端点。
//!
//! 插件只在配置了签名公钥的发行构建里注册（[`detect_support`]）。没有公钥时插件初始化本身就会失败，
//! 而且没有公钥就无从校验更新包，宁可整体不支持；此时各命令报 `updater_unsupported`。

use std::sync::{Mutex, MutexGuard};
use std::time::{Duration, Instant};

use aurora_core::{CancellationToken, CoreEvent, DownloadProgress, EventSink};
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
    aurora_base::app_slug!(),
    ".org/updates/latest.json"
);

/// 国内镜像的清单地址。
pub const MIRROR_ENDPOINT: &str = concat!(
    "https://",
    aurora_base::app_slug!(),
    ".cn/updates/latest.json"
);

/// 镜像域名完成 ICP 备案前不能对外服务，先关着；打开后端点顺序按下载源策略排。
pub const MIRROR_ENABLED: bool = false;

/// 单个端点取清单的时限。清单是一次性的小请求，比下载源探测放宽，慢网下也要能拿到。
const CHECK_TIMEOUT: Duration = Duration::from_secs(10);

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

    fn store_download(&mut self, update: U, bytes: Vec<u8>) {
        self.downloaded = Some(Downloaded { update, bytes });
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

/// 检查更新。端点按「文件下载源」策略排序，前一个连不上或非 2xx 时插件自动试下一个。
/// 已是最新返回 `null`。不看 `check_updates` 设置：那一项只管启动时要不要自动查，由前端决定。
#[tauri::command]
pub async fn check_update(
    app: AppHandle,
    facade: State<'_, Facade>,
    updater: State<'_, UpdaterState>,
) -> Result<Option<UpdateDto>, CommandError> {
    updater.require_supported()?;
    let endpoints = facade
        .snapshot()
        .await
        .update_endpoints(PRIMARY_ENDPOINT, MIRROR_ENABLED.then_some(MIRROR_ENDPOINT))
        .await;
    let urls = endpoint_urls(&endpoints);
    let check_failed = |err| {
        updater_error(
            code::UPDATE_CHECK_FAILED,
            "检查更新失败",
            Some(&endpoints),
            err,
        )
    };
    let checker = app
        .updater_builder()
        .endpoints(urls)
        .and_then(|builder| builder.timeout(CHECK_TIMEOUT).build())
        .map_err(check_failed)?;
    let found = checker.check().await.map_err(check_failed)?;
    match &found {
        Some(update) => tracing::info!(version = %update.version, ?endpoints, "发现可用更新"),
        None => tracing::info!(?endpoints, "已是最新版本"),
    }
    let dto = found.as_ref().map(update_dto);
    updater.slot().record_check(found);
    Ok(dto)
}

/// 下载最近一次检查到的更新并校验签名。长任务：进度经 core-event 推送（`kind: "download"`，
/// `total` 恒为 1，带 `task_id`），可经 `cancel_task(taskId)` 取消。签名不符报
/// `update_signature_invalid`，包随即丢弃。
#[tauri::command]
pub async fn download_update(
    task_id: String,
    app: AppHandle,
    updater: State<'_, UpdaterState>,
    tasks: State<'_, TaskRegistry>,
) -> Result<UpdateDto, CommandError> {
    updater.require_supported()?;
    let events = CoreEventForwarder::to_app(&app, Some(task_id.clone()));
    let outcome = async {
        let task = tasks.register(&task_id)?;
        let update =
            updater.slot().available.clone().ok_or_else(|| {
                CommandError::new(code::UPDATE_NOT_AVAILABLE, "还没有检查到可用更新")
            })?;
        let bytes = task
            .run(download_with_progress(&update, events.sink(), task.token()))
            .await?;
        let dto = update_dto(&update);
        tracing::info!(version = %update.version, size = bytes.len(), "更新包下载并校验完成");
        updater.slot().store_download(update, bytes);
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
    install_after_saving_play_records(&facade, || updater.install_downloaded()).await?;
    app.restart()
}

/// 先补写游玩记录里还没落盘的改动再安装：Windows 上更新插件拉起安装程序后直接结束进程，不经过
/// `RunEvent::Exit`，退出收尾里的那次补写赶不上。补写失败只记日志、照样安装，与正常退出时一致。
pub(crate) async fn install_after_saving_play_records(
    facade: &Facade,
    install: impl FnOnce() -> Result<(), CommandError>,
) -> Result<(), CommandError> {
    crate::exit::save_play_records(facade, crate::exit::PLAY_RECORDS_DEADLINE).await;
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
            speed,
        }
    }
}

fn per_second(bytes: u64, elapsed: Duration) -> u64 {
    (u128::from(bytes) * 1000 / elapsed.as_millis().max(1)) as u64
}

/// 插件错误转命令错误。签名相关的失败无论出现在哪一步都单独成码：前端要明确告诉用户包被拒了。
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
    let message = format!("{action}：{err}");
    let causes = source_chain(&err);
    let mut detail = Map::new();
    if let Some(endpoints) = endpoints {
        detail.insert("endpoints".to_owned(), json!(endpoints));
    }
    // 插件的 Reqwest 变体是 transparent：它的 source() 直接给出 reqwest 错误的下一层，
    // 从插件错误顺着原因链找不到 reqwest 错误本身，只能在这里取出来判断。
    let network = match &err {
        UpdaterError::Reqwest(http) => aurora_base::http::network_failure(http),
        other => aurora_base::http::network_failure(other),
    };
    if let Some(failure) = network {
        detail.insert("network".to_owned(), json!(failure.code()));
    }
    if !causes.is_empty() {
        detail.insert("causes".to_owned(), json!(causes));
    }
    tracing::warn!(code, %message, ?causes, "更新命令失败");
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
        use aurora_core::playtime::PLAYTIME_FILE;
        use aurora_core::{Aurora, AuroraConfig};

        const RECORDS: &str = r#"{"format":1,"book":{
            "instances":{
                "旧名":{"total_ms":7200000,"last_played_at":1761800000000},
                "留下":{"total_ms":1800000,"last_played_at":1761600000000}},
            "days":{"2026-10-30":{"instances":{"旧名":7200000,"留下":1800000}}}}}"#;
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(PLAYTIME_FILE);
        let facade = Facade::new(
            Aurora::open(
                AuroraConfig::default(),
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
        let result = install_after_saving_play_records(&facade, || {
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
            Some(format!("{}.org", aurora_base::brand::APP_SLUG).as_str())
        );
        assert_eq!(
            urls[1].host_str(),
            Some(format!("{}.cn", aurora_base::brand::APP_SLUG).as_str())
        );
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
        slot.store_download(Fake("0.2.0"), vec![1, 2, 3]);
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
        slot.store_download(Fake("0.2.0"), vec![9]);
        slot.set_install_on_exit(true).unwrap();

        slot.record_check(Some(Fake("0.2.0")));
        assert_eq!(slot.downloaded_version().as_deref(), Some("0.2.0"));
        assert!(slot.install_on_exit);

        slot.record_check(Some(Fake("0.2.1")));
        assert_eq!(slot.downloaded_version(), None);
        assert!(!slot.install_on_exit);
        assert_eq!(slot.available.as_ref().map(|u| u.0), Some("0.2.1"));

        slot.store_download(Fake("0.2.1"), vec![1]);
        slot.record_check(None);
        assert_eq!(slot.downloaded_version(), None);
        assert!(slot.available.is_none());
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
        assert!(err.message.starts_with("下载更新失败："));

        let endpoints = vec![PRIMARY_ENDPOINT.to_owned()];
        let err = updater_error(
            code::UPDATE_CHECK_FAILED,
            "检查更新失败",
            Some(&endpoints),
            tauri_plugin_updater::Error::ReleaseNotFound,
        );
        assert_eq!(err.code, code::UPDATE_CHECK_FAILED);
        assert_eq!(err.detail.unwrap()["endpoints"], json!([PRIMARY_ENDPOINT]));
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
        let refused = aurora_base::http::build_client()
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
            tauri_plugin_updater::Error::ReleaseNotFound,
        );
        assert!(err.detail.unwrap().get("network").is_none());
    }
}
