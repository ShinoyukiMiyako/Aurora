//! 主页资讯：取 Mojang 官方启动器的内容源，只留 Java 版相关条目。
//!
//! 内容源两份，并发取：
//! - `v2/news.json`：官方资讯，`newsType` 含 `Java` 的才收，标为活动；
//! - `v2/javaPatchNotes.json`：Java 版更新日志，按 `type` 标为正式版或快照，带游戏版本号。
//!
//! 每次请求限时 [`FETCH_TIMEOUT`]，结果连同取得时刻缓存在 `<数据目录>/cache/news.json`，
//! [`CACHE_TTL`] 内直接用缓存；取不到时退回缓存并标记离线，连缓存都没有才报错。

use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

use crate::error::{CoreError, Result};
use crate::facade::Aurora;

/// 内容源与图片的根地址；条目里的图片地址是相对它的路径。
pub const LAUNCHER_CONTENT_BASE: &str = "https://launchercontent.mojang.com";
const NEWS_PATH: &str = "/v2/news.json";
const PATCH_NOTES_PATH: &str = "/v2/javaPatchNotes.json";
/// 单次请求的时限。
pub const FETCH_TIMEOUT: Duration = Duration::from_millis(8000);
/// 磁盘缓存的有效期。
pub const CACHE_TTL: Duration = Duration::from_secs(6 * 60 * 60);
/// 合并后最多保留的条数；主页最多显示 5 条，多留一些给以后的资讯列表。
pub const NEWS_LIMIT: usize = 20;
const CACHE_FILE: &str = "news.json";

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
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct NewsFeed {
    /// 按发布时刻倒序。
    pub items: Vec<NewsItem>,
    /// 这份内容取得的时刻（Unix 毫秒）。
    pub fetched_at: u64,
    /// 本次没取到新内容、给的是缓存。
    pub offline: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
struct CachedFeed {
    fetched_at: u64,
    items: Vec<NewsItem>,
}

impl Aurora {
    /// 取资讯：缓存新鲜就用缓存，否则联网取；取不到退回缓存并标记离线，没有缓存才报错。
    pub async fn list_news(&self) -> Result<NewsFeed> {
        self.list_news_from(LAUNCHER_CONTENT_BASE, now_ms()).await
    }

    /// [`list_news`](Self::list_news) 的内容源根地址与当前时刻可注入内核，供测试指向本地 mock。
    pub(crate) async fn list_news_from(&self, base: &str, now: u64) -> Result<NewsFeed> {
        let cache_path = news_cache_path(self.data_dir());
        let cached = load_cache(&cache_path).await;
        if let Some(cache) = &cached
            && now.saturating_sub(cache.fetched_at) < ttl_ms()
        {
            return Ok(NewsFeed {
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
                Ok(NewsFeed {
                    items: fresh.items,
                    fetched_at: now,
                    offline: false,
                })
            }
            Err(err) => match cached {
                Some(cache) => {
                    tracing::info!(error = %err, "资讯取不到，退回本地缓存");
                    Ok(NewsFeed {
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

fn news_cache_path(data_dir: &Path) -> PathBuf {
    data_dir.join("cache").join(CACHE_FILE)
}

fn ttl_ms() -> u64 {
    u64::try_from(CACHE_TTL.as_millis()).expect("6 小时的毫秒数放得进 u64")
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
    items.sort_by(|a, b| b.date.cmp(&a.date).then_with(|| a.id.cmp(&b.id)));
    items.truncate(NEWS_LIMIT);
    Ok(items)
}

async fn fetch_json(http: &reqwest::Client, url: &str) -> Result<Vec<u8>> {
    let fetch_error = |source| CoreError::Fetch {
        url: url.to_owned(),
        source,
    };
    let response = http
        .get(url)
        .timeout(FETCH_TIMEOUT)
        .send()
        .await
        .and_then(reqwest::Response::error_for_status)
        .map_err(fetch_error)?;
    let bytes = response.bytes().await.map_err(fetch_error)?;
    Ok(bytes.to_vec())
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
    use wiremock::matchers::{method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    const NEWS_FIXTURE: &str = include_str!("../tests/fixtures/launchercontent/news.json");
    const NOTES_FIXTURE: &str =
        include_str!("../tests/fixtures/launchercontent/javaPatchNotes.json");
    const BASE: &str = "https://launchercontent.mojang.com";
    /// 2026-10-30T00:00:00Z。
    const OCT_30: u64 = 1_793_318_400_000;

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
        let server = MockServer::start().await;
        mount_feeds(&server, NEWS_FIXTURE, NOTES_FIXTURE).await;
        let dir = tempfile::tempdir().unwrap();
        let aurora = aurora_in(dir.path());
        let base = server.uri();

        let first = aurora.list_news_from(&base, OCT_30).await.unwrap();
        assert!(!first.offline);
        assert_eq!(first.fetched_at, OCT_30);
        assert_eq!(first.items.len(), 11);
        assert!(
            first.items[0]
                .thumbnail_url
                .as_deref()
                .unwrap()
                .starts_with(&base)
        );
        assert_eq!(server.received_requests().await.unwrap().len(), 2);

        let ttl = ttl_ms();
        let cached = aurora
            .list_news_from(&base, OCT_30 + ttl - 1)
            .await
            .unwrap();
        assert_eq!(cached, first);
        assert_eq!(
            server.received_requests().await.unwrap().len(),
            2,
            "缓存有效期内不联网"
        );

        server.reset().await;
        let offline = aurora.list_news_from(&base, OCT_30 + ttl).await.unwrap();
        assert!(offline.offline);
        assert_eq!(offline.items, first.items);
        assert_eq!(offline.fetched_at, OCT_30);

        let empty = tempfile::tempdir().unwrap();
        let err = aurora_in(empty.path())
            .list_news_from(&base, OCT_30)
            .await
            .unwrap_err();
        assert!(matches!(err, CoreError::Fetch { .. }), "实际：{err:?}");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn one_bad_source_falls_back_like_offline() {
        let server = MockServer::start().await;
        mount_feeds(&server, "<html>maintenance</html>", NOTES_FIXTURE).await;
        let dir = tempfile::tempdir().unwrap();
        let err = aurora_in(dir.path())
            .list_news_from(&server.uri(), OCT_30)
            .await
            .unwrap_err();
        assert!(matches!(err, CoreError::FeedParse { .. }), "实际：{err:?}");
    }
}
