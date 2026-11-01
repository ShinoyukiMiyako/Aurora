//! 主页资讯：官方资讯与启动器资讯两个来源并发取，合并后按发布时刻倒序。
//!
//! 官方资讯取 Mojang 官方启动器的内容源，只留 Java 版相关条目。内容源两份，并发取：
//! - `v2/news.json`：官方资讯，`newsType` 含 `Java` 的才收，标为活动；
//! - `v2/javaPatchNotes.json`：Java 版更新日志，按 `type` 标为正式版或快照，带游戏版本号。
//!
//! 每次请求限时 [`FETCH_TIMEOUT`]，结果连同取得时刻缓存在 `<数据目录>/cache/news.json`，
//! [`CACHE_TTL`] 内直接用缓存；取不到时退回缓存并标记离线，连缓存都没有才报错。
//!
//! 启动器资讯取本启动器公开仓库（[`REPO_URL`]）的 GitHub Releases，免鉴权，进程内缓存
//! [`LAUNCHER_CACHE_TTL`]；草稿一律不收，预发布只给预览版与测试版看（[`LauncherChannel`]）。
//! 取不到时同样退回缓存并标记离线；连缓存都没有时只在 [`NewsFeed::launcher_error`] 里报错，
//! 官方资讯照常返回。取不到之后按 [`LAUNCHER_BACKOFF`] 退避：退避期内不请求 GitHub，直接给上次取到的
//! 发布（标记离线）或上次的失败，主页不必每次都等满请求时限；调用方明确要求重试时（重试按钮、恢复联网
//! 后的重取）不等退避期满，立即再请求一次。

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use aurora_base::brand::REPO_URL;
use serde::{Deserialize, Serialize};

use crate::error::{CoreError, Result};
use crate::facade::Aurora;

/// 内容源与图片的根地址；条目里的图片地址是相对它的路径。
pub const LAUNCHER_CONTENT_BASE: &str = "https://launchercontent.mojang.com";
const NEWS_PATH: &str = "/v2/news.json";
const PATCH_NOTES_PATH: &str = "/v2/javaPatchNotes.json";
/// 资讯与发布列表正文的上限。官方资讯与更新日志实测在几百 KB，留出几十倍余量；只防地址指到超大文件时
/// 整个读进内存。
const FEED_MAX_BYTES: u64 = 16 * 1024 * 1024;
/// 单次请求的时限。
pub const FETCH_TIMEOUT: Duration = Duration::from_millis(8000);
/// 磁盘缓存的有效期。
pub const CACHE_TTL: Duration = Duration::from_secs(6 * 60 * 60);
/// 合并后最多保留的条数；主页最多显示 5 条，多留一些给以后的资讯列表。
pub const NEWS_LIMIT: usize = 20;
const CACHE_FILE: &str = "news.json";

/// GitHub REST API 的根地址。
pub const GITHUB_API_BASE: &str = "https://api.github.com";
/// 钉住 REST API 版本：不带这个头时服务端按默认版本回应，默认版本前进时响应形状可能跟着变。
const GITHUB_API_VERSION: &str = "2026-03-10";
/// 启动器发布的进程内缓存有效期。免鉴权调用按 IP 每小时只有 60 次额度，一小时取一次远在额度内。
pub const LAUNCHER_CACHE_TTL: Duration = Duration::from_secs(60 * 60);
/// 启动器发布连续第 n 次取不到之后，等第 n 档时长再请求，超出表长按最后一档。GitHub 连不上通常不是
/// 几秒内能恢复的事，每次都重试只会让主页一次次等满 [`FETCH_TIMEOUT`]。
pub const LAUNCHER_BACKOFF: [Duration; 4] = [
    Duration::from_secs(60),
    Duration::from_secs(5 * 60),
    Duration::from_secs(15 * 60),
    Duration::from_secs(60 * 60),
];

/// 资讯类型。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum NewsTag {
    /// 正式版更新日志。
    Release,
    /// 快照、预发布、候选版更新日志。
    Snapshot,
    /// 官方资讯（活动、Realms 地图、直播等）。
    Event,
    /// 本启动器的发布。
    Launcher,
}

/// 正在运行的启动器属于哪个发布通道，决定启动器资讯里显示不显示预发布。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LauncherChannel {
    /// 正式版：只看正式发布。
    Stable,
    /// 预览版与测试版：本身就跑在预发布上，预发布也看。
    Prerelease,
}

impl LauncherChannel {
    /// 与前端构建信息推发布通道同一条规则：版本号带预发布标识、或主版本还是 0（尚未发布过正式版）的
    /// 是预览版或测试版，其余是正式版。
    pub fn from_version(major: u64, has_prerelease: bool) -> Self {
        if has_prerelease || major == 0 {
            Self::Prerelease
        } else {
            Self::Stable
        }
    }

    fn shows(self, release: &LauncherRelease) -> bool {
        !release.prerelease || self == Self::Prerelease
    }
}

/// 一条资讯。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct NewsItem {
    pub id: String,
    pub title: String,
    /// 一句话摘要。
    pub summary: String,
    /// 发布时刻（Unix 毫秒）。只有日期的条目取当天 UTC 零点。
    pub date: u64,
    pub tag: NewsTag,
    /// 缩略图绝对地址；条目没给图时为 `None`。
    pub thumbnail_url: Option<String>,
    /// 更新日志对应的游戏版本 id；官方资讯为 `None`。
    pub game_version: Option<String>,
}

/// 一次取资讯的结果。
#[derive(Debug)]
pub struct NewsFeed {
    /// 两个来源合并，按发布时刻倒序，最多 [`NEWS_LIMIT`] 条。
    pub items: Vec<NewsItem>,
    /// 官方资讯这份内容取得的时刻（Unix 毫秒）。
    pub fetched_at: u64,
    /// 至少有一个来源本次没取到新内容、给的是缓存。
    pub offline: bool,
    /// 启动器资讯取不到、也没有缓存可退时的失败；这时 `items` 里只有官方资讯。退避期内给的是上次那次失败。
    pub launcher_error: Option<LauncherFailure>,
}

/// 启动器资讯的一次失败。退避期内同一次失败要原样重报多次，错误本身由各次结果共享。
#[derive(Debug, Clone)]
pub struct LauncherFailure {
    /// 只会是请求失败（[`CoreError::Fetch`]）、正文超限（[`CoreError::FeedTooLarge`]）或内容认不出
    /// （[`CoreError::FeedParse`]）。
    pub error: Arc<CoreError>,
    /// 失败的时刻（Unix 毫秒）。
    pub failed_at: u64,
    /// 退避期满、不要求重试也会再请求的时刻（Unix 毫秒）。
    pub retry_at: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
struct CachedFeed {
    fetched_at: u64,
    items: Vec<NewsItem>,
}

/// 官方资讯这一来源的结果。
struct OfficialNews {
    items: Vec<NewsItem>,
    fetched_at: u64,
    offline: bool,
}

/// 一条启动器发布，带着是否预发布，供按通道过滤。
#[derive(Debug, Clone)]
struct LauncherRelease {
    item: NewsItem,
    prerelease: bool,
}

/// 按通道过滤前的全集：切换通道不用重新联网。
#[derive(Debug, Clone)]
struct CachedReleases {
    fetched_at: u64,
    releases: Vec<LauncherRelease>,
}

/// 启动器发布这一来源记着的状态。
#[derive(Debug, Clone)]
struct LauncherState {
    /// 最近一次取到的发布。
    releases: Option<CachedReleases>,
    /// 最近一次请求失败了才有，取到就清掉。
    failure: Option<FailureRecord>,
}

#[derive(Debug, Clone)]
struct FailureRecord {
    failure: LauncherFailure,
    /// 连续失败了几次，从 1 计；决定下一次退避多久。
    streak: usize,
}

/// 启动器发布的进程内缓存，连同最近一次失败与退避。
pub(crate) struct ReleaseCache {
    state: Mutex<LauncherState>,
}

impl ReleaseCache {
    pub(crate) const fn new() -> Self {
        Self {
            state: Mutex::new(LauncherState {
                releases: None,
                failure: None,
            }),
        }
    }

    fn get(&self) -> LauncherState {
        self.state.lock().expect("启动器发布缓存的锁已中毒").clone()
    }

    fn succeed(&self, fresh: CachedReleases) {
        let mut state = self.state.lock().expect("启动器发布缓存的锁已中毒");
        state.releases = Some(fresh);
        state.failure = None;
    }

    /// 记下一次失败，按连续失败的次数排好下一次请求的时刻。
    fn fail(&self, error: CoreError, now: u64) -> LauncherFailure {
        let mut state = self.state.lock().expect("启动器发布缓存的锁已中毒");
        let streak = state.failure.as_ref().map_or(1, |record| record.streak + 1);
        let failure = LauncherFailure {
            error: Arc::new(error),
            failed_at: now,
            retry_at: now.saturating_add(duration_ms(backoff_after(streak))),
        };
        state.failure = Some(FailureRecord {
            failure: failure.clone(),
            streak,
        });
        failure
    }
}

/// 连续第 `streak` 次失败之后的退避时长。
fn backoff_after(streak: usize) -> Duration {
    LAUNCHER_BACKOFF[streak.saturating_sub(1).min(LAUNCHER_BACKOFF.len() - 1)]
}

/// 进程全局一份：发布列表与配置、数据目录都无关；测试各自新建一份经 [`NewsSources`] 传入，互不串用。
static LAUNCHER_RELEASES: ReleaseCache = ReleaseCache::new();

/// 两个来源的根地址与启动器发布缓存；生产取常量，测试指向本地 mock。
pub(crate) struct NewsSources<'a> {
    pub(crate) official: &'a str,
    pub(crate) github_api: &'a str,
    pub(crate) releases: &'a ReleaseCache,
}

/// 启动器发布这一来源：缓存新鲜或还在退避期内时不请求、直接有结果，否则已在后台发出请求。
enum PendingReleases {
    Settled(LauncherOutcome),
    Fetching {
        stale: Option<CachedReleases>,
        task: tokio::task::JoinHandle<Result<Vec<LauncherRelease>>>,
    },
}

/// 启动器发布这一来源的结果：取到的（或退回的缓存），或者取不到又没有缓存时的那次失败。
type LauncherOutcome = std::result::Result<LauncherNews, LauncherFailure>;

struct LauncherNews {
    releases: Vec<LauncherRelease>,
    offline: bool,
}

/// 这一次要不要请求 GitHub。
enum ReleasePlan {
    /// 不请求：缓存还新鲜，或者还在失败后的退避期内。
    Settled(LauncherOutcome),
    /// 请求；带着过期的缓存，取不到时退回它。
    Fetch(Option<CachedReleases>),
}

fn plan_releases(state: LauncherState, now: u64, retry: bool) -> ReleasePlan {
    if let Some(cache) = &state.releases
        && now.saturating_sub(cache.fetched_at) < duration_ms(LAUNCHER_CACHE_TTL)
    {
        return ReleasePlan::Settled(Ok(LauncherNews {
            releases: cache.releases.clone(),
            offline: false,
        }));
    }
    match state.failure {
        // 时钟往回拨过（现在早于失败的时刻）时不算在退避期内：宁可多请求一次，也不卡到时钟追上来。
        Some(record)
            if !retry && (record.failure.failed_at..record.failure.retry_at).contains(&now) =>
        {
            tracing::info!(
                retry_at = record.failure.retry_at,
                "启动器发布在失败后的退避期内，这次不请求 GitHub"
            );
            ReleasePlan::Settled(match state.releases {
                Some(stale) => Ok(LauncherNews {
                    releases: stale.releases,
                    offline: true,
                }),
                None => Err(record.failure),
            })
        }
        _ => ReleasePlan::Fetch(state.releases),
    }
}

impl Aurora {
    /// 取资讯：官方资讯与启动器资讯各按自己的缓存规则取，合并后按发布时刻倒序。
    /// 官方资讯连缓存都没有才报错；启动器资讯的失败只记在 [`NewsFeed::launcher_error`]。
    /// `retry` 为真时启动器资讯不等失败后的退避期满，立即再请求一次。
    pub async fn list_news(&self, channel: LauncherChannel, retry: bool) -> Result<NewsFeed> {
        let sources = NewsSources {
            official: LAUNCHER_CONTENT_BASE,
            github_api: GITHUB_API_BASE,
            releases: &LAUNCHER_RELEASES,
        };
        self.list_news_from(&sources, channel, now_ms(), retry)
            .await
    }

    /// [`list_news`](Self::list_news) 的来源与当前时刻可注入内核，供测试指向本地 mock。
    pub(crate) async fn list_news_from(
        &self,
        sources: &NewsSources<'_>,
        channel: LauncherChannel,
        now: u64,
        retry: bool,
    ) -> Result<NewsFeed> {
        // 启动器发布先在后台发出去，与官方资讯并发，主页不必等两段网络时延相加。
        let pending = match plan_releases(sources.releases.get(), now, retry) {
            ReleasePlan::Settled(outcome) => PendingReleases::Settled(outcome),
            ReleasePlan::Fetch(stale) => PendingReleases::Fetching {
                stale,
                task: tokio::spawn(fetch_releases(
                    self.http(),
                    format!("{}{}", sources.github_api, releases_path()),
                )),
            },
        };
        let official = self.official_news(sources.official, now).await;
        let launcher = settle_releases(pending, sources.releases, now).await?;
        let official = official?;

        let mut items = official.items;
        let mut offline = official.offline;
        let launcher_error = match launcher {
            Ok(news) => {
                offline |= news.offline;
                items.extend(
                    news.releases
                        .into_iter()
                        .filter(|release| channel.shows(release))
                        .map(|release| release.item),
                );
                None
            }
            Err(failure) => {
                tracing::warn!(error = %failure.error, "启动器资讯取不到，也没有缓存可退，只给官方资讯");
                Some(failure)
            }
        };
        sort_newest_first(&mut items);
        items.truncate(NEWS_LIMIT);
        Ok(NewsFeed {
            items,
            fetched_at: official.fetched_at,
            offline,
            launcher_error,
        })
    }

    /// 官方资讯：缓存新鲜就用缓存，否则联网取；取不到退回缓存并标记离线，没有缓存才报错。
    async fn official_news(&self, base: &str, now: u64) -> Result<OfficialNews> {
        let cache_path = news_cache_path(self.data_dir());
        let cached = load_cache(&cache_path).await;
        if let Some(cache) = &cached
            && now.saturating_sub(cache.fetched_at) < duration_ms(CACHE_TTL)
        {
            return Ok(OfficialNews {
                items: cache.items.clone(),
                fetched_at: cache.fetched_at,
                offline: false,
            });
        }
        match fetch_feed(&self.http(), base).await {
            Ok(items) => {
                let fresh = CachedFeed {
                    fetched_at: now,
                    items,
                };
                save_cache(&cache_path, &fresh).await;
                Ok(OfficialNews {
                    items: fresh.items,
                    fetched_at: now,
                    offline: false,
                })
            }
            Err(err) => match cached {
                Some(cache) => {
                    tracing::info!(error = %err, "资讯取不到，退回本地缓存");
                    Ok(OfficialNews {
                        items: cache.items,
                        fetched_at: cache.fetched_at,
                        offline: true,
                    })
                }
                None => Err(err),
            },
        }
    }
}

/// 外层 `Result` 是后台任务本身的异常（应当让整个调用失败）；内层是这一来源的结果。
async fn settle_releases(
    pending: PendingReleases,
    cache: &ReleaseCache,
    now: u64,
) -> Result<LauncherOutcome> {
    let (stale, task) = match pending {
        PendingReleases::Settled(outcome) => return Ok(outcome),
        PendingReleases::Fetching { stale, task } => (stale, task),
    };
    Ok(match task.await? {
        Ok(releases) => {
            cache.succeed(CachedReleases {
                fetched_at: now,
                releases: releases.clone(),
            });
            Ok(LauncherNews {
                releases,
                offline: false,
            })
        }
        Err(err) => {
            let failure = cache.fail(err, now);
            tracing::info!(
                retry_at = failure.retry_at,
                "启动器发布取不到，退避期满前不再请求"
            );
            match stale {
                Some(cache) => {
                    tracing::info!(error = %failure.error, "启动器发布取不到，退回进程内缓存");
                    Ok(LauncherNews {
                        releases: cache.releases,
                        offline: true,
                    })
                }
                None => Err(failure),
            }
        }
    })
}

fn news_cache_path(data_dir: &Path) -> PathBuf {
    data_dir.join("cache").join(CACHE_FILE)
}

fn duration_ms(duration: Duration) -> u64 {
    u64::try_from(duration.as_millis()).expect("缓存有效期的毫秒数放得进 u64")
}

/// 同一时刻的条目按 id 排，结果与来源返回的先后无关。
fn sort_newest_first(items: &mut [NewsItem]) {
    items.sort_by(|a, b| b.date.cmp(&a.date).then_with(|| a.id.cmp(&b.id)));
}

/// 仓库地址换成 List releases 的路径。一页取 [`NEWS_LIMIT`] 个：合并后最多也只留这么多条。
fn releases_path() -> String {
    let slug = REPO_URL
        .strip_prefix("https://github.com/")
        .expect("仓库地址形如 https://github.com/<owner>/<repo>");
    format!("/repos/{slug}/releases?per_page={NEWS_LIMIT}")
}

async fn fetch_feed(http: &reqwest::Client, base: &str) -> Result<Vec<NewsItem>> {
    let news_url = format!("{base}{NEWS_PATH}");
    let notes_url = format!("{base}{PATCH_NOTES_PATH}");
    let news_task = tokio::spawn({
        let http = http.clone();
        let url = news_url.clone();
        async move { fetch_json(&http, &url).await }
    });
    let notes = fetch_json(http, &notes_url).await?;
    let news = news_task.await??;
    let mut items = parse_news(&news, base, &news_url)?;
    items.extend(parse_patch_notes(&notes, base, &notes_url)?);
    sort_newest_first(&mut items);
    items.truncate(NEWS_LIMIT);
    Ok(items)
}

async fn fetch_releases(http: reqwest::Client, url: String) -> Result<Vec<LauncherRelease>> {
    let request = http
        .get(&url)
        .header("accept", "application/vnd.github+json")
        .header("x-github-api-version", GITHUB_API_VERSION);
    let bytes = read_body(request, &url).await?;
    parse_releases(&bytes, &url)
}

async fn fetch_json(http: &reqwest::Client, url: &str) -> Result<Vec<u8>> {
    read_body(http.get(url), url).await
}

async fn read_body(request: reqwest::RequestBuilder, url: &str) -> Result<Vec<u8>> {
    let fetch_error = |source| CoreError::Fetch {
        url: url.to_owned(),
        source,
    };
    let mut response = request
        .timeout(FETCH_TIMEOUT)
        .send()
        .await
        .and_then(reqwest::Response::error_for_status)
        .map_err(fetch_error)?;
    // 声明的长度超限时不读正文；没声明（分块传输）或声明不实的按块累计，一超限就中止。
    let too_large = |size| CoreError::FeedTooLarge {
        url: url.to_owned(),
        size,
        limit: FEED_MAX_BYTES,
    };
    if let Some(declared) = response.content_length()
        && declared > FEED_MAX_BYTES
    {
        return Err(too_large(declared));
    }
    let mut body = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(fetch_error)? {
        let received = (body.len() + chunk.len()) as u64;
        if received > FEED_MAX_BYTES {
            return Err(too_large(received));
        }
        body.extend_from_slice(&chunk);
    }
    Ok(body)
}

#[derive(Deserialize)]
struct NewsDocument {
    entries: Vec<NewsEntry>,
}

#[derive(Deserialize)]
struct NewsEntry {
    id: String,
    title: String,
    #[serde(default)]
    text: String,
    date: String,
    #[serde(default, rename = "newsType")]
    news_type: Vec<String>,
    #[serde(default, rename = "playPageImage")]
    play_page_image: Option<ImageRef>,
}

#[derive(Deserialize)]
struct PatchNotesDocument {
    entries: Vec<PatchNoteEntry>,
}

#[derive(Deserialize)]
struct PatchNoteEntry {
    id: String,
    title: String,
    version: String,
    #[serde(rename = "type")]
    kind: String,
    date: String,
    #[serde(default, rename = "shortText")]
    short_text: String,
    #[serde(default)]
    image: Option<ImageRef>,
}

#[derive(Deserialize)]
struct ImageRef {
    url: String,
}

fn parse_news(bytes: &[u8], base: &str, url: &str) -> Result<Vec<NewsItem>> {
    let document: NewsDocument = parse_document(bytes, url)?;
    Ok(document
        .entries
        .into_iter()
        .filter(|entry| entry.news_type.iter().any(|t| t == "Java"))
        .filter_map(|entry| {
            let date = entry_date(&entry.date, &entry.id)?;
            Some(NewsItem {
                id: entry.id,
                title: entry.title.trim().to_owned(),
                summary: entry.text.trim().to_owned(),
                date,
                tag: NewsTag::Event,
                thumbnail_url: entry.play_page_image.map(|img| absolute(base, &img.url)),
                game_version: None,
            })
        })
        .collect())
}

fn parse_patch_notes(bytes: &[u8], base: &str, url: &str) -> Result<Vec<NewsItem>> {
    let document: PatchNotesDocument = parse_document(bytes, url)?;
    Ok(document
        .entries
        .into_iter()
        .filter_map(|entry| {
            let tag = match entry.kind.as_str() {
                "release" => NewsTag::Release,
                "snapshot" => NewsTag::Snapshot,
                other => {
                    tracing::debug!(id = %entry.id, kind = other, "更新日志类型不认识，跳过");
                    return None;
                }
            };
            let date = entry_date(&entry.date, &entry.id)?;
            Some(NewsItem {
                id: entry.id,
                title: entry.title.trim().to_owned(),
                summary: entry.short_text.trim().to_owned(),
                date,
                tag,
                thumbnail_url: entry.image.map(|img| absolute(base, &img.url)),
                game_version: Some(entry.version),
            })
        })
        .collect())
}

/// List releases 响应里的一项，只取用到的字段；`name`、`body`、`published_at` 可为 null。
#[derive(Deserialize)]
struct GithubRelease {
    id: u64,
    tag_name: String,
    name: Option<String>,
    body: Option<String>,
    draft: bool,
    prerelease: bool,
    published_at: Option<String>,
}

fn parse_releases(bytes: &[u8], url: &str) -> Result<Vec<LauncherRelease>> {
    let releases: Vec<GithubRelease> = parse_document(bytes, url)?;
    Ok(releases
        .into_iter()
        .filter_map(|release| {
            // 免鉴权的列表本就不含草稿；这里再挡一道，草稿无论如何不该出现在资讯里。
            if release.draft {
                return None;
            }
            let id = format!("launcher-{}", release.id);
            let Some(published_at) = release.published_at.as_deref() else {
                tracing::warn!(id, "启动器发布没有发布时刻，跳过这一条");
                return None;
            };
            let date = entry_date(published_at, &id)?;
            Some(LauncherRelease {
                prerelease: release.prerelease,
                item: NewsItem {
                    title: release_title(release.name.as_deref(), &release.tag_name),
                    summary: release_summary(release.body.as_deref()),
                    id,
                    date,
                    tag: NewsTag::Launcher,
                    thumbnail_url: None,
                    game_version: None,
                },
            })
        })
        .collect())
}

/// 发布没起名时 GitHub 网页上显示的就是标签名，这里照同一规则。
fn release_title(name: Option<&str>, tag_name: &str) -> String {
    match name.map(str::trim) {
        Some(name) if !name.is_empty() => name.to_owned(),
        _ => tag_name.trim().to_owned(),
    }
}

/// 发布说明是 Markdown，主页只要一句话：取第一行正文，跳过标题、分隔线与 HTML 注释，去掉列表记号。
/// 说明为空或没有正文时摘要为空，与没有摘要的官方条目一样。
fn release_summary(body: Option<&str>) -> String {
    let Some(body) = body else {
        return String::new();
    };
    match body.lines().map(str::trim).find(|line| is_prose(line)) {
        Some(line) => plain_inline(
            ["- ", "* ", "+ "]
                .into_iter()
                .find_map(|marker| line.strip_prefix(marker))
                .map_or(line, str::trim_start),
        ),
        None => String::new(),
    }
}

/// 主页把摘要当纯文本显示，行内 Markdown 记号会原样露出来：链接与图片只留文字，去掉加粗、删除线与
/// 行内代码的记号。单个 `*`、`_` 也可能是乘号或 snake_case 里的下划线，不动。
fn plain_inline(line: &str) -> String {
    let mut text = String::with_capacity(line.len());
    let mut rest = line;
    while let Some(open) = rest.find('[') {
        let after = &rest[open + 1..];
        let link = after
            .find(']')
            .filter(|&close| after[close + 1..].starts_with('('))
            .and_then(|close| {
                // 链接地址里不会有空白：先碰到空白说明这不是链接，不能一路吞到后面别处的右括号。
                let url = &after[close + 2..];
                url.find(|c: char| c == ')' || c.is_whitespace())
                    .filter(|&end| url[end..].starts_with(')'))
                    .map(|end| (close, close + 2 + end))
            });
        match link {
            Some((close, end)) => {
                let before = &rest[..open];
                text.push_str(before.strip_suffix('!').unwrap_or(before));
                text.push_str(&after[..close]);
                rest = &after[end + 1..];
            }
            None => {
                text.push_str(&rest[..=open]);
                rest = after;
            }
        }
    }
    text.push_str(rest);
    ["**", "__", "~~", "`"]
        .into_iter()
        .fold(text, |text, mark| text.replace(mark, ""))
}

fn is_prose(line: &str) -> bool {
    let rule = line
        .chars()
        .all(|c| matches!(c, '-' | '*' | '_' | '=' | ' '));
    !line.is_empty() && !rule && !line.starts_with('#') && !line.starts_with("<!--")
}

fn parse_document<T: serde::de::DeserializeOwned>(bytes: &[u8], url: &str) -> Result<T> {
    serde_json::from_slice(bytes).map_err(|source| CoreError::FeedParse {
        url: url.to_owned(),
        source,
    })
}

/// 单条日期解析不了只跳过这一条：一条坏数据不该让整个资讯模块挂掉。
fn entry_date(raw: &str, id: &str) -> Option<u64> {
    let parsed = parse_iso_date_ms(raw);
    if parsed.is_none() {
        tracing::warn!(id, date = raw, "资讯日期格式不认识，跳过这一条");
    }
    parsed
}

fn absolute(base: &str, url: &str) -> String {
    if url.starts_with("https://") || url.starts_with("http://") {
        url.to_owned()
    } else {
        format!("{base}{url}")
    }
}

/// 解析 `YYYY-MM-DD` 或 `YYYY-MM-DDTHH:MM:SS[.fff]Z`（UTC）为 Unix 毫秒。
fn parse_iso_date_ms(raw: &str) -> Option<u64> {
    let raw = raw.trim();
    let (date, time) = match raw.split_once('T') {
        Some((date, time)) => (date, Some(time)),
        None => (raw, None),
    };
    let mut parts = date.splitn(3, '-');
    let year: i64 = parts.next()?.parse().ok()?;
    let month: u32 = parts.next()?.parse().ok()?;
    let day: u32 = parts.next()?.parse().ok()?;
    if !(1..=12).contains(&month) || !(1..=31).contains(&day) {
        return None;
    }
    let mut ms = days_from_civil(year, month, day).checked_mul(86_400_000)?;
    if let Some(time) = time {
        let time = time.strip_suffix('Z')?;
        let (clock, fraction) = match time.split_once('.') {
            Some((clock, fraction)) => (clock, Some(fraction)),
            None => (time, None),
        };
        let mut hms = clock.splitn(3, ':');
        let hour: i64 = hms.next()?.parse().ok()?;
        let minute: i64 = hms.next()?.parse().ok()?;
        let second: i64 = hms.next()?.parse().ok()?;
        if hour > 23 || minute > 59 || second > 60 {
            return None;
        }
        let millis: i64 = match fraction {
            Some(f) if !f.is_empty() && f.chars().all(|c| c.is_ascii_digit()) => {
                format!("{:0<3}", &f[..f.len().min(3)]).parse().ok()?
            }
            Some(_) => return None,
            None => 0,
        };
        ms += ((hour * 60 + minute) * 60 + second) * 1000 + millis;
    }
    u64::try_from(ms).ok()
}

/// 公历日期到 1970-01-01 起的天数（Howard Hinnant 的 days_from_civil）。
fn days_from_civil(year: i64, month: u32, day: u32) -> i64 {
    let year = if month <= 2 { year - 1 } else { year };
    let era = year.div_euclid(400);
    let yoe = year.rem_euclid(400);
    let month = i64::from(month);
    let doy = (153 * (if month > 2 { month - 3 } else { month + 9 }) + 2) / 5 + i64::from(day) - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

/// 缓存是派生数据：缺失从零开始；损坏记一条告警后当作没有缓存，下次取到新内容就覆盖掉。
async fn load_cache(path: &Path) -> Option<CachedFeed> {
    match tokio::fs::read(path).await {
        Ok(bytes) => match serde_json::from_slice(&bytes) {
            Ok(cache) => Some(cache),
            Err(err) => {
                tracing::warn!(path = %path.display(), error = %err, "资讯缓存损坏，按没有缓存处理");
                None
            }
        },
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => None,
        Err(err) => {
            tracing::warn!(path = %path.display(), error = %err, "读不了资讯缓存，按没有缓存处理");
            None
        }
    }
}

/// 写不进缓存只记告警：资讯已经取到，没理由因为缓存落盘失败让主页报错。
async fn save_cache(path: &Path, cache: &CachedFeed) {
    match serde_json::to_vec(cache) {
        Ok(bytes) => {
            if let Err(err) = aurora_base::fs::atomic_write(path, &bytes).await {
                tracing::warn!(path = %path.display(), error = %err, "资讯缓存写盘失败");
            }
        }
        Err(err) => tracing::warn!(error = %err, "序列化资讯缓存失败"),
    }
}

fn now_ms() -> u64 {
    let elapsed = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("系统时钟早于 1970 年");
    u64::try_from(elapsed.as_millis()).expect("毫秒时间戳放得进 u64")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::AuroraConfig;
    use wiremock::matchers::{header, method, path, query_param};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    const NEWS_FIXTURE: &str = include_str!("../tests/fixtures/launchercontent/news.json");
    const NOTES_FIXTURE: &str =
        include_str!("../tests/fixtures/launchercontent/javaPatchNotes.json");
    const RELEASES_FIXTURE: &str = include_str!("../tests/fixtures/github/releases.json");
    const BASE: &str = "https://launchercontent.mojang.com";
    const RELEASES_PATH: &str = "/repos/ShinoyukiMiyako/Aurora/releases";
    /// 2026-10-30T00:00:00Z。
    const OCT_30: u64 = 1_793_318_400_000;
    const DAY: u64 = 86_400_000;

    #[test]
    fn iso_dates_parse_to_utc_millis() {
        assert_eq!(parse_iso_date_ms("1970-01-01"), Some(0));
        assert_eq!(parse_iso_date_ms("2026-10-30"), Some(OCT_30));
        assert_eq!(
            parse_iso_date_ms("2026-10-27T13:40:29.000Z"),
            Some(OCT_30 - 3 * 86_400_000 + (13 * 3600 + 40 * 60 + 29) * 1000)
        );
        assert_eq!(
            parse_iso_date_ms("2024-02-29T00:00:00.5Z"),
            Some(1_709_164_800_500)
        );
        for bad in [
            "",
            "2026-13-01",
            "2026-10-30T25:00:00Z",
            "2026-10-30T10:00:00+08:00",
            "yesterday",
        ] {
            assert_eq!(parse_iso_date_ms(bad), None, "{bad:?}");
        }
    }

    /// 真实响应夹具：只收 Java 资讯，更新日志按 type 标正式版 / 快照，合并后按时刻倒序。
    #[test]
    fn fixtures_parse_into_java_items() {
        let mut items = parse_news(NEWS_FIXTURE.as_bytes(), BASE, "news").unwrap();
        assert_eq!(items.len(), 3, "夹具里 8 条资讯只有 3 条是 Java 版");
        assert!(
            items
                .iter()
                .all(|i| i.tag == NewsTag::Event && i.game_version.is_none())
        );
        let halloween = items[0].clone();
        assert_eq!(halloween.title, "Halloween on Realms");
        assert_eq!(
            halloween.summary,
            "12 new maps to send a shiver down your spine!"
        );
        assert_eq!(halloween.date, OCT_30);
        assert_eq!(
            halloween.thumbnail_url.as_deref(),
            Some("https://launchercontent.mojang.com/v2/images/halloweenralms700x466.jpg")
        );

        let notes = parse_patch_notes(NOTES_FIXTURE.as_bytes(), BASE, "notes").unwrap();
        assert_eq!(notes.len(), 8);
        let release: Vec<&NewsItem> = notes.iter().filter(|n| n.tag == NewsTag::Release).collect();
        assert_eq!(release.len(), 1);
        assert_eq!(release[0].game_version.as_deref(), Some("26.3"));
        assert_eq!(notes[0].tag, NewsTag::Snapshot);
        assert_eq!(notes[0].game_version.as_deref(), Some("26.4-snapshot-6"));
        assert_eq!(notes[0].title, "Minecraft 26.4 Snapshot 6");

        items.extend(notes);
        items.sort_by_key(|item| std::cmp::Reverse(item.date));
        assert_eq!(items[0].id, halloween.id);
        assert!(items.windows(2).all(|w| w[0].date >= w[1].date));
    }

    #[test]
    fn missing_thumbnail_is_none_and_unknown_kinds_are_skipped() {
        let news = br#"{"entries":[{"id":"n1","title":" T ","text":"s","date":"2026-01-02","newsType":["Java"]}]}"#;
        let parsed = parse_news(news, BASE, "news").unwrap();
        assert_eq!(parsed[0].thumbnail_url, None);
        assert_eq!(parsed[0].title, "T");

        let notes = br#"{"entries":[
            {"id":"a","title":"A","version":"1.0","type":"release","date":"2026-01-02T00:00:00.000Z"},
            {"id":"b","title":"B","version":"x","type":"april_fools","date":"2026-01-02T00:00:00.000Z"},
            {"id":"c","title":"C","version":"y","type":"snapshot","date":"not a date"}
        ]}"#;
        let parsed = parse_patch_notes(notes, BASE, "notes").unwrap();
        assert_eq!(parsed.len(), 1);
        assert_eq!(parsed[0].id, "a");
        assert_eq!(parsed[0].thumbnail_url, None);
        assert_eq!(parsed[0].summary, "");

        let err = parse_news(b"{\"entries\": 1}", BASE, "https://x/news.json").unwrap_err();
        assert!(
            matches!(err, CoreError::FeedParse { ref url, .. } if url == "https://x/news.json")
        );
    }

    #[test]
    fn launcher_channel_follows_build_channel_rule() {
        use LauncherChannel::{Prerelease, Stable};
        for (major, has_prerelease, expected) in [
            (0, false, Prerelease),
            (0, true, Prerelease),
            (1, false, Stable),
            (1, true, Prerelease),
            (u64::MAX, false, Stable),
        ] {
            assert_eq!(
                LauncherChannel::from_version(major, has_prerelease),
                expected,
                "major={major} has_prerelease={has_prerelease}"
            );
        }
    }

    #[test]
    fn releases_path_comes_from_brand_repo() {
        assert_eq!(releases_path(), format!("{RELEASES_PATH}?per_page=20"));
    }

    /// 草稿与发布时刻坏了的跳过；没起名的用标签名；摘要取说明的第一行正文。
    #[test]
    fn releases_fixture_parses_published_items() {
        let releases = parse_releases(RELEASES_FIXTURE.as_bytes(), "releases").unwrap();
        let ids: Vec<&str> = releases.iter().map(|r| r.item.id.as_str()).collect();
        assert_eq!(ids, ["launcher-300", "launcher-299", "launcher-298"]);

        let beta = &releases[0];
        assert!(beta.prerelease);
        assert_eq!(beta.item.title, "0.3.0 测试版 1");
        assert_eq!(beta.item.summary, "主页资讯加入启动器发布");
        assert_eq!(
            beta.item.date,
            OCT_30 - 2 * DAY + (10 * 3600 + 30 * 60) * 1000
        );
        assert_eq!(beta.item.tag, NewsTag::Launcher);
        assert_eq!(beta.item.thumbnail_url, None);
        assert_eq!(beta.item.game_version, None);

        assert!(!releases[1].prerelease);
        assert_eq!(releases[1].item.title, "v0.2.1", "名字为空串时用标签名");
        assert_eq!(releases[1].item.summary, "下载源 测速更准");
        assert_eq!(releases[2].item.title, "v0.2.0", "名字为 null 时用标签名");
        assert_eq!(releases[2].item.summary, "");
        assert_eq!(releases[2].item.date, OCT_30 - 29 * DAY);

        let err = parse_releases(
            br#"{"message":"Not Found"}"#,
            "https://api.github.com/releases",
        )
        .unwrap_err();
        assert!(
            matches!(err, CoreError::FeedParse { ref url, .. } if url == "https://api.github.com/releases")
        );
    }

    #[test]
    fn release_summary_takes_first_prose_line() {
        assert_eq!(release_summary(None), "");
        assert_eq!(release_summary(Some("")), "");
        assert_eq!(
            release_summary(Some("## 只有标题\n\n---\n<!-- 注释 -->\n===\n")),
            ""
        );
        assert_eq!(release_summary(Some("  第一句。\n第二句。")), "第一句。");
        assert_eq!(
            release_summary(Some("# 标题\r\n\r\n+  加号列表\r\n")),
            "加号列表"
        );
        // 以 ** 开头的是加粗不是列表：记号去掉，正文一字不少。
        assert_eq!(
            release_summary(Some("**加粗开头**的正文")),
            "加粗开头的正文"
        );
        assert_eq!(release_summary(Some("***\n-1 不是列表")), "-1 不是列表");
    }

    /// 主页按纯文本显示摘要：行内 Markdown 记号去掉只留文字，单个 * 与 _ 有歧义（乘号、snake_case）不动。
    #[test]
    fn release_summary_drops_inline_markdown() {
        // GitHub 自动生成的说明里没有 PR 时，第一行正文就是这一句。
        assert_eq!(
            release_summary(Some(
                "**Full Changelog**: https://github.com/o/r/compare/v0.1.0...v0.2.0"
            )),
            "Full Changelog: https://github.com/o/r/compare/v0.1.0...v0.2.0"
        );
        assert_eq!(
            release_summary(Some(
                "* 修复 [#12](https://github.com/o/r/pull/12) 里 `snake_case` 的问题"
            )),
            "修复 #12 里 snake_case 的问题"
        );
        assert_eq!(
            release_summary(Some(
                "![图标](https://x/a.png) 新图标，~~旧说法~~，__强调__"
            )),
            "图标 新图标，旧说法，强调"
        );
        assert_eq!(
            release_summary(Some("- [x] 勾选框 [不是链接] (也不是) a_b * c")),
            "[x] 勾选框 [不是链接] (也不是) a_b * c"
        );
        assert_eq!(
            release_summary(Some("[没闭合](https://x 与 [空]()")),
            "[没闭合](https://x 与 空"
        );
    }

    async fn mount_feeds(server: &MockServer, news: &str, notes: &str) {
        Mock::given(method("GET"))
            .and(path(NEWS_PATH))
            .respond_with(ResponseTemplate::new(200).set_body_string(news))
            .mount(server)
            .await;
        Mock::given(method("GET"))
            .and(path(PATCH_NOTES_PATH))
            .respond_with(ResponseTemplate::new(200).set_body_string(notes))
            .mount(server)
            .await;
    }

    /// 只有带齐分页参数与 GitHub 建议的两个请求头时才命中，否则 wiremock 回 404。
    async fn mount_releases(server: &MockServer, body: &str) {
        Mock::given(method("GET"))
            .and(path(RELEASES_PATH))
            .and(query_param("per_page", "20"))
            .and(header("accept", "application/vnd.github+json"))
            .and(header("x-github-api-version", "2026-03-10"))
            .respond_with(ResponseTemplate::new(200).set_body_string(body))
            .mount(server)
            .await;
    }

    /// 打乱发布顺序：合并结果只看发布时刻，与 GitHub 返回的先后无关。
    fn shuffled_releases() -> String {
        let mut releases: Vec<serde_json::Value> = serde_json::from_str(RELEASES_FIXTURE).unwrap();
        fastrand::shuffle(&mut releases);
        serde_json::to_string(&releases).unwrap()
    }

    /// 两个来源各一台 mock，外加一份只属于这个测试的启动器发布缓存。
    struct Remote {
        official: MockServer,
        github: MockServer,
        official_uri: String,
        github_uri: String,
        releases: ReleaseCache,
    }

    impl Remote {
        async fn start() -> Self {
            let official = MockServer::start().await;
            let github = MockServer::start().await;
            Self {
                official_uri: official.uri(),
                github_uri: github.uri(),
                official,
                github,
                releases: ReleaseCache::new(),
            }
        }

        fn sources(&self) -> NewsSources<'_> {
            NewsSources {
                official: &self.official_uri,
                github_api: &self.github_uri,
                releases: &self.releases,
            }
        }

        async fn github_requests(&self) -> usize {
            self.github.received_requests().await.unwrap().len()
        }
    }

    fn launcher_ids(feed: &NewsFeed) -> Vec<&str> {
        feed.items
            .iter()
            .filter(|item| item.tag == NewsTag::Launcher)
            .map(|item| item.id.as_str())
            .collect()
    }

    fn aurora_in(dir: &Path) -> Aurora {
        Aurora::for_test(
            AuroraConfig::default(),
            dir.to_path_buf(),
            dir.join(".minecraft"),
        )
    }

    /// 首次取到后落缓存；6 小时内不再请求；过期后联网失败退回缓存并标离线；没有缓存时报错。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn caches_for_six_hours_and_falls_back_offline() {
        let remote = Remote::start().await;
        mount_feeds(&remote.official, NEWS_FIXTURE, NOTES_FIXTURE).await;
        mount_releases(&remote.github, "[]").await;
        let dir = tempfile::tempdir().unwrap();
        let aurora = aurora_in(dir.path());
        let base = &remote.official_uri;
        let channel = LauncherChannel::Stable;

        let first = aurora
            .list_news_from(&remote.sources(), channel, OCT_30, false)
            .await
            .unwrap();
        assert!(!first.offline);
        assert_eq!(first.fetched_at, OCT_30);
        assert_eq!(first.items.len(), 11);
        assert!(
            first.items[0]
                .thumbnail_url
                .as_deref()
                .unwrap()
                .starts_with(base.as_str())
        );
        assert_eq!(remote.official.received_requests().await.unwrap().len(), 2);

        let ttl = duration_ms(CACHE_TTL);
        let cached = aurora
            .list_news_from(&remote.sources(), channel, OCT_30 + ttl - 1, false)
            .await
            .unwrap();
        assert_eq!(cached.items, first.items);
        assert_eq!(cached.fetched_at, OCT_30);
        assert!(!cached.offline);
        assert_eq!(
            remote.official.received_requests().await.unwrap().len(),
            2,
            "缓存有效期内不联网"
        );

        remote.official.reset().await;
        let offline = aurora
            .list_news_from(&remote.sources(), channel, OCT_30 + ttl, false)
            .await
            .unwrap();
        assert!(offline.offline);
        assert_eq!(offline.items, first.items);
        assert_eq!(offline.fetched_at, OCT_30);

        let empty = tempfile::tempdir().unwrap();
        let err = aurora_in(empty.path())
            .list_news_from(&remote.sources(), channel, OCT_30, false)
            .await
            .unwrap_err();
        assert!(matches!(err, CoreError::Fetch { .. }), "实际：{err:?}");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn one_bad_source_falls_back_like_offline() {
        let remote = Remote::start().await;
        mount_feeds(&remote.official, "<html>maintenance</html>", NOTES_FIXTURE).await;
        mount_releases(&remote.github, RELEASES_FIXTURE).await;
        let dir = tempfile::tempdir().unwrap();
        let err = aurora_in(dir.path())
            .list_news_from(&remote.sources(), LauncherChannel::Stable, OCT_30, false)
            .await
            .unwrap_err();
        assert!(matches!(err, CoreError::FeedParse { .. }), "实际：{err:?}");
    }

    /// 启动器发布并进官方资讯按时刻排；正式版通道不显示预发布；一小时内不再请求 GitHub，切通道也不。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn launcher_releases_merge_by_channel_and_cache_for_an_hour() {
        let remote = Remote::start().await;
        mount_feeds(&remote.official, NEWS_FIXTURE, NOTES_FIXTURE).await;
        mount_releases(&remote.github, &shuffled_releases()).await;
        let dir = tempfile::tempdir().unwrap();
        let aurora = aurora_in(dir.path());

        let stable = aurora
            .list_news_from(&remote.sources(), LauncherChannel::Stable, OCT_30, false)
            .await
            .unwrap();
        assert!(stable.launcher_error.is_none());
        assert!(!stable.offline);
        assert_eq!(stable.items.len(), 13);
        assert!(stable.items.windows(2).all(|w| w[0].date >= w[1].date));
        assert_eq!(launcher_ids(&stable), ["launcher-299", "launcher-298"]);
        let patch = stable
            .items
            .iter()
            .position(|item| item.id == "launcher-299")
            .unwrap();
        assert_eq!(
            stable.items[patch - 1].id,
            "26-4-snapshot-5",
            "同一天 12:15 的快照排在 08:00 的启动器发布前面"
        );
        assert_eq!(remote.github_requests().await, 1);

        let preview = aurora
            .list_news_from(
                &remote.sources(),
                LauncherChannel::Prerelease,
                OCT_30 + 1,
                false,
            )
            .await
            .unwrap();
        assert_eq!(preview.items.len(), 14);
        assert_eq!(
            launcher_ids(&preview),
            ["launcher-300", "launcher-299", "launcher-298"]
        );
        assert_eq!(
            preview.items[1].id, "launcher-300",
            "10 月 28 日的测试版排在 30 日的活动之后"
        );
        assert_eq!(remote.github_requests().await, 1, "切通道不重新联网");

        let ttl = duration_ms(LAUNCHER_CACHE_TTL);
        aurora
            .list_news_from(
                &remote.sources(),
                LauncherChannel::Stable,
                OCT_30 + ttl - 1,
                false,
            )
            .await
            .unwrap();
        assert_eq!(remote.github_requests().await, 1, "一小时内不再请求 GitHub");
        let refreshed = aurora
            .list_news_from(
                &remote.sources(),
                LauncherChannel::Stable,
                OCT_30 + ttl,
                false,
            )
            .await
            .unwrap();
        assert_eq!(remote.github_requests().await, 2);
        assert_eq!(launcher_ids(&refreshed), ["launcher-299", "launcher-298"]);
        assert!(!refreshed.offline);
    }

    fn launcher_failure(feed: &NewsFeed) -> &LauncherFailure {
        feed.launcher_error
            .as_ref()
            .unwrap_or_else(|| panic!("期望启动器资讯失败，实际条目：{:?}", feed.items))
    }

    async fn mount_github_unavailable(server: &MockServer) {
        Mock::given(method("GET"))
            .and(path(RELEASES_PATH))
            .respond_with(ResponseTemplate::new(503))
            .mount(server)
            .await;
    }

    const MINUTE: u64 = 60_000;

    #[test]
    fn backoff_steps_cap_at_an_hour() {
        let minutes: Vec<u64> = [1, 2, 3, 4, 5, 100]
            .into_iter()
            .map(|streak| duration_ms(backoff_after(streak)) / MINUTE)
            .collect();
        assert_eq!(minutes, [1, 5, 15, 60, 60, 60]);
    }

    /// 退避期是左闭右开的区间；要求重试、或者时钟拨回到失败之前时照样请求。
    #[test]
    fn plan_respects_backoff_window_and_explicit_retry() {
        let cache = ReleaseCache::new();
        let failure = cache.fail(
            CoreError::FeedParse {
                url: "u".into(),
                source: serde_json::from_str::<serde_json::Value>("<").unwrap_err(),
            },
            10 * MINUTE,
        );
        assert_eq!(failure.retry_at, 11 * MINUTE);
        let fetches = |now: u64, retry: bool| {
            matches!(
                plan_releases(cache.get(), now, retry),
                ReleasePlan::Fetch(None)
            )
        };
        assert!(fetches(10 * MINUTE - 1, false), "时钟拨回到失败之前");
        assert!(!fetches(10 * MINUTE, false));
        assert!(!fetches(11 * MINUTE - 1, false));
        assert!(fetches(11 * MINUTE, false));
        assert!(fetches(10 * MINUTE + 1, true), "要求重试时不等退避期满");
    }

    /// GitHub 连不上时按 1、5、15、60 分钟退避，之后一直 60 分钟：退避期内不请求，原样给上次那次失败，
    /// 官方资讯照常给；要求重试时立即请求；取到之后连续失败的计数清零。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn launcher_failure_backs_off_before_retrying() {
        let remote = Remote::start().await;
        mount_feeds(&remote.official, NEWS_FIXTURE, NOTES_FIXTURE).await;
        mount_github_unavailable(&remote.github).await;
        let dir = tempfile::tempdir().unwrap();
        let aurora = aurora_in(dir.path());
        let channel = LauncherChannel::Stable;
        let at = |now: u64, retry: bool| {
            let aurora = &aurora;
            let sources = remote.sources();
            async move {
                aurora
                    .list_news_from(&sources, channel, now, retry)
                    .await
                    .unwrap()
            }
        };

        let first = at(OCT_30, false).await;
        assert_eq!(remote.github_requests().await, 1);
        assert_eq!(first.items.len(), 11, "官方资讯照常给");
        let first_failure = launcher_failure(&first).clone();
        assert_eq!(first_failure.failed_at, OCT_30);
        assert_eq!(first_failure.retry_at, OCT_30 + MINUTE);
        assert!(
            matches!(*first_failure.error, CoreError::Fetch { .. }),
            "实际：{:?}",
            first_failure.error
        );

        let within = at(OCT_30 + MINUTE - 1, false).await;
        assert_eq!(remote.github_requests().await, 1, "退避期内不请求 GitHub");
        assert_eq!(within.items.len(), 11);
        let replayed = launcher_failure(&within);
        assert!(
            Arc::ptr_eq(&replayed.error, &first_failure.error),
            "给的是上次那次失败"
        );
        assert_eq!(replayed.retry_at, first_failure.retry_at);

        // 每一档：期满前 1 毫秒不请求，期满即请求，请求失败后排到下一档。
        let mut failed_at = OCT_30 + MINUTE;
        let mut requests = 1;
        for wait in [5, 15, 60, 60] {
            let feed = at(failed_at, false).await;
            requests += 1;
            assert_eq!(remote.github_requests().await, requests);
            assert_eq!(launcher_failure(&feed).retry_at, failed_at + wait * MINUTE);
            at(failed_at + wait * MINUTE - 1, false).await;
            assert_eq!(
                remote.github_requests().await,
                requests,
                "{wait} 分钟的退避期内"
            );
            failed_at += wait * MINUTE;
        }

        // 恢复联网后的重取：不等退避期满。
        let retried = at(failed_at - 30 * MINUTE, true).await;
        assert_eq!(remote.github_requests().await, requests + 1);
        assert_eq!(launcher_failure(&retried).retry_at, failed_at + 30 * MINUTE);

        remote.github.reset().await;
        mount_releases(&remote.github, RELEASES_FIXTURE).await;
        let still_waiting = at(failed_at, false).await;
        assert_eq!(remote.github_requests().await, 0, "没要求重试就等退避期满");
        assert!(still_waiting.launcher_error.is_some());
        let recovered = at(failed_at, true).await;
        assert_eq!(remote.github_requests().await, 1);
        assert!(recovered.launcher_error.is_none());
        assert_eq!(launcher_ids(&recovered), ["launcher-299", "launcher-298"]);
        assert!(!recovered.offline);

        // 取到过之后再失败：从第一档重新计，退避期内给过期的发布并标离线。
        remote.github.reset().await;
        mount_github_unavailable(&remote.github).await;
        let expired = failed_at + duration_ms(LAUNCHER_CACHE_TTL);
        let stale = at(expired, false).await;
        assert_eq!(remote.github_requests().await, 1);
        assert!(stale.launcher_error.is_none());
        assert!(stale.offline);
        assert_eq!(launcher_ids(&stale), ["launcher-299", "launcher-298"]);
        let stale_again = at(expired + MINUTE - 1, false).await;
        assert_eq!(remote.github_requests().await, 1);
        assert!(stale_again.offline);
        assert_eq!(stale_again.items, stale.items);
        at(expired + MINUTE, false).await;
        assert_eq!(remote.github_requests().await, 2);
    }

    /// GitHub 拒绝或回了认不出的内容：官方资讯照常给，错误只记在 launcher_error；
    /// 之前取到过就退回进程内缓存并标离线，不报错。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn launcher_failure_only_affects_launcher_items() {
        let remote = Remote::start().await;
        mount_feeds(&remote.official, NEWS_FIXTURE, NOTES_FIXTURE).await;
        Mock::given(method("GET"))
            .and(path(RELEASES_PATH))
            .respond_with(
                ResponseTemplate::new(403)
                    .set_body_string(r#"{"message":"API rate limit exceeded"}"#),
            )
            .mount(&remote.github)
            .await;
        let dir = tempfile::tempdir().unwrap();
        let aurora = aurora_in(dir.path());
        let channel = LauncherChannel::Prerelease;
        let releases_url = format!("{}{RELEASES_PATH}?per_page=20", remote.github_uri);

        let refused = aurora
            .list_news_from(&remote.sources(), channel, OCT_30, false)
            .await
            .unwrap();
        assert_eq!(refused.items.len(), 11, "官方资讯一条不少");
        assert!(launcher_ids(&refused).is_empty());
        assert!(!refused.offline);
        let error = &launcher_failure(&refused).error;
        assert!(
            matches!(**error, CoreError::Fetch { ref url, .. } if *url == releases_url),
            "实际：{error:?}"
        );

        remote.github.reset().await;
        Mock::given(method("GET"))
            .and(path(RELEASES_PATH))
            .respond_with(ResponseTemplate::new(200).set_body_string("<html>unicorn</html>"))
            .mount(&remote.github)
            .await;
        let garbled = aurora
            .list_news_from(&remote.sources(), channel, OCT_30 + 1, true)
            .await
            .unwrap();
        assert_eq!(garbled.items.len(), 11);
        let error = &launcher_failure(&garbled).error;
        assert!(
            matches!(**error, CoreError::FeedParse { ref url, .. } if *url == releases_url),
            "实际：{error:?}"
        );

        remote.github.reset().await;
        mount_releases(&remote.github, RELEASES_FIXTURE).await;
        let fresh = aurora
            .list_news_from(&remote.sources(), channel, OCT_30 + 2, true)
            .await
            .unwrap();
        assert_eq!(launcher_ids(&fresh).len(), 3);

        remote.github.reset().await;
        let stale = aurora
            .list_news_from(
                &remote.sources(),
                channel,
                OCT_30 + 2 + duration_ms(LAUNCHER_CACHE_TTL),
                false,
            )
            .await
            .unwrap();
        assert!(stale.launcher_error.is_none());
        assert!(stale.offline, "启动器发布给的是过期缓存");
        assert_eq!(stale.items, fresh.items);
        assert_eq!(stale.fetched_at, OCT_30, "官方资讯仍在磁盘缓存有效期内");
    }

    /// 资讯与发布列表的正文有上限：地址指到超大文件时不整个读进内存。后面补满空白的合法 JSON 照样拒，
    /// 声明的长度超限时不读正文。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn oversized_feed_bodies_are_refused_before_they_are_read_whole() {
        let server = MockServer::start().await;
        let padded = format!(
            "{NEWS_FIXTURE}{}",
            " ".repeat(usize::try_from(FEED_MAX_BYTES).unwrap())
        );
        Mock::given(method("GET"))
            .and(path(NEWS_PATH))
            .respond_with(ResponseTemplate::new(200).set_body_string(padded.clone()))
            .mount(&server)
            .await;
        let http = aurora_base::http::build_client().unwrap();
        let url = format!("{}{NEWS_PATH}", server.uri());

        let err = match fetch_json(&http, &url).await {
            Ok(body) => panic!("应报正文超限，实际读下了 {} 字节", body.len()),
            Err(err) => err,
        };

        match err {
            CoreError::FeedTooLarge {
                url: got,
                size,
                limit,
            } => {
                assert_eq!(got, url);
                assert_eq!(size, padded.len() as u64, "声明了长度时按声明的报");
                assert_eq!(limit, FEED_MAX_BYTES);
            }
            other => panic!("应报正文超限，实际：{other:?}"),
        }
        // 正好在上限上的照常读下来。
        server.reset().await;
        let exact = format!(
            "{NEWS_FIXTURE}{}",
            " ".repeat(usize::try_from(FEED_MAX_BYTES).unwrap() - NEWS_FIXTURE.len())
        );
        Mock::given(method("GET"))
            .and(path(NEWS_PATH))
            .respond_with(ResponseTemplate::new(200).set_body_string(exact))
            .mount(&server)
            .await;
        let body = fetch_json(&http, &url).await.unwrap();
        assert_eq!(body.len() as u64, FEED_MAX_BYTES);
        assert_eq!(parse_news(&body, BASE, &url).unwrap().len(), 3);
    }
}
