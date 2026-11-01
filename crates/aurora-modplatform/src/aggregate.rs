//! 双源聚合搜索与双平台合并。
//!
//! 同一份查询并行发往 Modrinth 与 CurseForge，两边各自按平台的排序给出一窗结果，这里再把两窗
//! 交织成一页：按下载量或更新时间排序时比较数值，其余排序两边轮流出（各平台的相关度、关注数互相
//! 不可比）。两平台的同一工程只在「标题归一化后相等」且「作者归一化后对得上」时合成一条（组织工程的
//! 组织名与所有者都算数），主来源取 Modrinth（有文件哈希，便于日后识别与更新），下载与关注取两边之和。
//!
//! 分页靠 [`SearchCursor`]：每页恰好 `limit` 条（两边都到底时除外），没用上的命中留到下一页重取；
//! 被合并进本页、但在另一平台还排在偏移之后的条目记进游标，下一页遇到时跳过，不会重复出现。
//! 单个平台失败不影响另一平台：失败记在 [`AggregateResult::errors`]，该平台游标原地不动。
//! 没有参与的平台（未配置密钥、分类换算不到、用户只选了另一个平台）记在
//! [`AggregateResult::skipped`]，与失败分开，界面据此区分「暂时没响应」与「本来就只搜一边」。

use std::cmp::Ordering;
use std::collections::HashSet;

use serde::{Deserialize, Serialize};

use crate::curseforge::{CurseForgeClient, search_plan};
use crate::error::Error;
use crate::model::{ModLoader, Platform, ResourceType, SearchHit, SearchQuery, SortField};
use crate::modrinth::ModrinthClient;

/// CurseForge 搜索接口的硬上限：`index + pageSize <= 10000`。
const CURSEFORGE_MAX_WINDOW: u32 = 10_000;

/// 某个平台在聚合搜索中的失败记录。
#[derive(Debug)]
pub struct PlatformError {
    /// 出错的平台。
    pub platform: Platform,
    /// 具体错误。
    pub error: Error,
}

/// 平台没有参与本次搜索的原因。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SkipReason {
    /// 用户在筛选里只选了另一个平台。
    Filtered,
    /// 没有可用的 CurseForge API key。
    KeyMissing,
    /// 分类条件在 CurseForge 侧没有同义分类。
    CategoryUnmapped,
}

/// 没有参与本次搜索的平台。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct SkippedPlatform {
    /// 平台。
    pub platform: Platform,
    /// 原因。
    pub reason: SkipReason,
}

/// CurseForge 一侧的来源：可用的客户端，或不参与的原因。
#[derive(Debug, Clone, Copy)]
pub enum CurseForgeSource<'a> {
    /// 参与搜索。
    Enabled(&'a CurseForgeClient),
    /// 不参与。
    Skipped(SkipReason),
}

/// 合并卡上某个平台的来源。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct HitSource {
    /// 平台。
    pub platform: Platform,
    /// 平台内工程 id。
    pub project_id: String,
    /// slug。
    pub slug: Option<String>,
    /// 该平台的详情页。
    pub page_url: Option<String>,
    /// 该平台的下载量。
    pub downloads: u64,
    /// 该平台的关注数。
    pub follows: Option<u64>,
}

/// 聚合后的一条结果：单平台命中，或两平台合成的一张卡。
///
/// 展示字段取主来源（合并时为 Modrinth）；`downloads` / `follows` 是各来源之和，`loaders` 是并集。
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct SearchEntry {
    /// 主来源平台。
    pub platform: Platform,
    /// 主来源的工程 id。
    pub project_id: String,
    /// 主来源的 slug。
    pub slug: Option<String>,
    /// 标题。
    pub title: String,
    /// 简介。
    pub description: String,
    /// 作者。
    pub author: Option<String>,
    /// 各来源下载量之和。
    pub downloads: u64,
    /// 各来源关注数之和；没有任何来源给出关注数为 `None`。
    pub follows: Option<u64>,
    /// 图标。
    pub icon_url: Option<String>,
    /// 图库首图（主来源没有时取另一来源）。
    pub gallery_url: Option<String>,
    /// 色相。
    pub hue: Option<u16>,
    /// 分类标签。
    pub categories: Vec<String>,
    /// 各来源加载器的并集。
    pub loaders: Vec<ModLoader>,
    /// 资源类型。
    pub resource_type: ResourceType,
    /// 最近更新时间。
    pub date_modified: Option<String>,
    /// 主来源的详情页。
    pub page_url: Option<String>,
    /// 全部来源，主来源在前。
    pub sources: Vec<HitSource>,
}

impl SearchEntry {
    fn single(hit: SearchHit) -> Self {
        let source = source_of(&hit);
        Self {
            platform: hit.platform,
            project_id: hit.project_id,
            slug: hit.slug,
            title: hit.title,
            description: hit.description,
            author: hit.author,
            downloads: hit.downloads,
            follows: hit.follows,
            icon_url: hit.icon_url,
            gallery_url: hit.gallery_url,
            hue: hit.hue,
            categories: hit.categories,
            loaders: hit.loaders,
            resource_type: hit.resource_type,
            date_modified: hit.date_modified,
            page_url: hit.page_url,
            sources: vec![source],
        }
    }

    fn merged(primary: SearchHit, other: SearchHit) -> Self {
        let mut entry = Self::single(primary);
        entry.downloads = entry.downloads.saturating_add(other.downloads);
        entry.follows = match (entry.follows, other.follows) {
            (Some(a), Some(b)) => Some(a.saturating_add(b)),
            (a, b) => a.or(b),
        };
        if entry.gallery_url.is_none() {
            entry.gallery_url.clone_from(&other.gallery_url);
        }
        for loader in &other.loaders {
            if !entry.loaders.contains(loader) {
                entry.loaders.push(*loader);
            }
        }
        entry.sources.push(source_of(&other));
        entry
    }
}

fn source_of(hit: &SearchHit) -> HitSource {
    HitSource {
        platform: hit.platform,
        project_id: hit.project_id.clone(),
        slug: hit.slug.clone(),
        page_url: hit.page_url.clone(),
        downloads: hit.downloads,
        follows: hit.follows,
    }
}

/// 单个平台的分页位置。
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct PlatformCursor {
    /// 下一页从该平台结果的第几条开始取。
    pub offset: u32,
    /// 该平台是否已经到底。
    pub exhausted: bool,
    /// 该平台最近一次报告的总数。
    pub total: Option<u64>,
    /// 已并进之前某张合并卡、但在本平台还排在 `offset` 之后的工程 id，下一页遇到时跳过。
    pub absorbed: Vec<String>,
}

/// 聚合搜索的翻页游标。首页传 `None`，之后原样回传上一页的 [`AggregateResult::next_cursor`]。
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct SearchCursor {
    /// Modrinth 一侧。
    pub modrinth: PlatformCursor,
    /// CurseForge 一侧。
    pub curseforge: PlatformCursor,
}

/// 聚合搜索结果。
#[derive(Debug)]
pub struct AggregateResult {
    /// 本页结果，最多 `limit` 条。
    pub hits: Vec<SearchEntry>,
    /// 参与平台最近一次报告的总数之和（合并前计数，故为约数）。
    pub total: u64,
    /// 各平台的失败记录（为空表示参与的平台都成功）。
    pub errors: Vec<PlatformError>,
    /// 没有参与的平台。
    pub skipped: Vec<SkippedPlatform>,
    /// 下一页游标；两个平台都到底（或不参与）时为 `None`。
    pub next_cursor: Option<SearchCursor>,
}

impl AggregateResult {
    /// 是否参与的平台都成功（无失败记录）。
    pub fn is_complete(&self) -> bool {
        self.errors.is_empty()
    }
}

/// 合并判定用的归一化：转小写，只留字母与数字（空白、标点、符号一律去掉）。
pub fn normalize_for_merge(text: &str) -> String {
    text.chars()
        .filter(|c| c.is_alphanumeric())
        .flat_map(char::to_lowercase)
        .collect()
}

/// 两条命中是否该合成一张卡：标题归一化后相等，作者名归一化后有一个对得上，且都不为空。作者未知
/// 不合并——合并依赖两个条件同时成立，缺一个就无从判断。
pub fn should_merge(a: &SearchHit, b: &SearchHit) -> bool {
    let title = normalize_for_merge(&a.title);
    if title.is_empty() || title != normalize_for_merge(&b.title) {
        return false;
    }
    let names = merge_authors(a);
    merge_authors(b).iter().any(|name| names.contains(name))
}

/// 参与合并比对的作者名：展示作者加上所有者。同一组织工程在另一平台可能挂组织名，也可能挂个人名。
fn merge_authors(hit: &SearchHit) -> Vec<String> {
    [&hit.author, &hit.owner]
        .into_iter()
        .filter_map(|name| name.as_deref())
        .map(normalize_for_merge)
        .filter(|name| !name.is_empty())
        .collect()
}

/// 一个平台这一次请求取回的原始结果。
struct Window {
    /// 窗内每一项；`None` 是不属于请求类型、要跳过的项。
    items: Vec<Option<SearchHit>>,
    /// 平台实际返回的条数（含被筛掉的）。
    fetched: usize,
    /// 平台报告的总数。
    total: u64,
}

/// 一个平台这一次取回的一窗命中。
struct Lane {
    /// 窗内每一项；`None` 是要跳过的（不属于请求的类型，或已并进之前的合并卡）。
    items: Vec<Option<SearchHit>>,
    /// 已消费到窗内第几项。
    pos: usize,
    /// 这一窗在平台结果里的起始偏移。
    base: u32,
    /// 平台在这一窗之后已无更多结果。
    ends_after_window: bool,
    /// 平台报告的总数。
    total: Option<u64>,
    /// 先前游标里记下、本次在窗内遇到并置空的项：（窗内下标，工程 id）。
    carried: Vec<(usize, String)>,
    /// 本次被合并吸收的窗内下标。
    absorbed: HashSet<usize>,
    /// 这一页没取到窗（请求失败）时，先前游标里记下的吸收项：偏移没动，它们仍排在偏移之后。
    kept: Vec<String>,
}

impl Lane {
    fn empty(cursor: &PlatformCursor) -> Self {
        Self {
            items: Vec::new(),
            pos: 0,
            base: cursor.offset,
            ends_after_window: cursor.exhausted,
            total: cursor.total,
            carried: Vec::new(),
            absorbed: HashSet::new(),
            kept: Vec::new(),
        }
    }

    fn skip_consumed(&mut self) {
        while self.pos < self.items.len()
            && (self.items[self.pos].is_none() || self.absorbed.contains(&self.pos))
        {
            self.pos += 1;
        }
    }

    fn head(&self) -> Option<&SearchHit> {
        self.items.get(self.pos).and_then(Option::as_ref)
    }

    fn take(&mut self) -> SearchHit {
        let hit = self.items[self.pos].take().expect("head 已确认存在");
        self.pos += 1;
        hit
    }

    /// 在尚未消费的部分里找可与 `hit` 合并的项，找到就标记吸收并取出。
    fn absorb_partner(&mut self, hit: &SearchHit) -> Option<SearchHit> {
        let index = (self.pos..self.items.len()).find(|i| {
            !self.absorbed.contains(i)
                && self.items[*i]
                    .as_ref()
                    .is_some_and(|candidate| should_merge(hit, candidate))
        })?;
        self.absorbed.insert(index);
        self.items[index].clone()
    }

    fn next_cursor(&self) -> PlatformCursor {
        let consumed = u32::try_from(self.pos).expect("一窗不超过 u32");
        let offset = self.base + consumed;
        let window_done = self.pos >= self.items.len();
        let reached_total = self.total.is_some_and(|t| u64::from(offset) >= t);
        // 还排在新偏移之后的吸收项要继续记着；先前记下的项只有仍在偏移之后才续记，
        // 已被消费或这一窗里压根没出现（平台结果变了）的就此丢掉。
        let mut absorbed: Vec<String> = self
            .carried
            .iter()
            .filter(|(i, _)| *i >= self.pos)
            .map(|(_, id)| id.clone())
            .chain(self.kept.iter().cloned())
            .collect();
        absorbed.extend(
            (self.pos..self.items.len())
                .filter(|i| self.absorbed.contains(i))
                .filter_map(|i| self.items[i].as_ref().map(|h| h.project_id.clone())),
        );
        PlatformCursor {
            offset,
            exhausted: (self.ends_after_window && window_done) || reached_total,
            total: self.total,
            absorbed,
        }
    }
}

/// 并行聚合搜索一页。
///
/// `modrinth` 为 `None` 表示用户筛掉了 Modrinth；`query.offset` 不使用，分页位置全由 `cursor` 决定。
pub async fn aggregate_search(
    modrinth: Option<&ModrinthClient>,
    curseforge: CurseForgeSource<'_>,
    query: &SearchQuery,
    cursor: Option<&SearchCursor>,
) -> AggregateResult {
    let cursor = cursor.cloned().unwrap_or_default();
    let types = query.effective_types();
    let limit = query.limit;
    let mut skipped = Vec::new();

    let modrinth = match modrinth {
        None => {
            skipped.push(SkippedPlatform {
                platform: Platform::Modrinth,
                reason: SkipReason::Filtered,
            });
            None
        }
        Some(client) => Some(client),
    };
    let curseforge = match curseforge {
        CurseForgeSource::Skipped(reason) => {
            skipped.push(SkippedPlatform {
                platform: Platform::CurseForge,
                reason,
            });
            None
        }
        CurseForgeSource::Enabled(client) => match search_plan(query) {
            Some(plan) => Some((client, plan)),
            None => {
                skipped.push(SkippedPlatform {
                    platform: Platform::CurseForge,
                    reason: SkipReason::CategoryUnmapped,
                });
                None
            }
        },
    };

    let modrinth_fut = async {
        let client = modrinth?;
        if cursor.modrinth.exhausted {
            return None;
        }
        let page = SearchQuery {
            offset: cursor.modrinth.offset,
            limit,
            ..query.clone()
        };
        Some(client.search(&page).await.map(|resp| {
            let fetched = resp.hits.len();
            let items = resp
                .hits
                .iter()
                .map(|h| Some(h.to_search_hit(&types)))
                .collect();
            Window {
                items,
                fetched,
                total: u64::from(resp.total_hits),
            }
        }))
    };
    let curseforge_fut = async {
        let (client, plan) = curseforge.as_ref()?;
        if cursor.curseforge.exhausted {
            return None;
        }
        let room = CURSEFORGE_MAX_WINDOW.saturating_sub(cursor.curseforge.offset);
        let page = SearchQuery {
            offset: cursor.curseforge.offset,
            limit: limit.min(room),
            ..query.clone()
        };
        if page.limit == 0 {
            return Some(Ok(Window {
                items: Vec::new(),
                fetched: 0,
                total: u64::from(cursor.curseforge.offset),
            }));
        }
        Some(client.search(&page, plan).await.map(|resp| {
            let fetched = resp.data.len();
            let items = resp
                .data
                .iter()
                .map(|m| plan.accepts(m.class_id).then(|| SearchHit::from(m)))
                .collect();
            let total = resp
                .pagination
                .as_ref()
                .map_or(fetched as u64, |p| p.total_count)
                .min(u64::from(CURSEFORGE_MAX_WINDOW));
            Window {
                items,
                fetched,
                total,
            }
        }))
    };
    let (modrinth_res, curseforge_res) = tokio::join!(modrinth_fut, curseforge_fut);

    let mut errors = Vec::new();
    let mut lanes = [
        build_lane(
            Platform::Modrinth,
            modrinth.is_some(),
            &cursor.modrinth,
            modrinth_res,
            limit,
            &mut errors,
        ),
        build_lane(
            Platform::CurseForge,
            curseforge.is_some(),
            &cursor.curseforge,
            curseforge_res,
            limit,
            &mut errors,
        ),
    ];

    let hits = interleave(&mut lanes, query.sort, limit as usize);
    for lane in lanes.iter_mut() {
        lane.skip_consumed();
    }

    let [modrinth_lane, curseforge_lane] = &lanes;
    let next = SearchCursor {
        modrinth: modrinth_lane.next_cursor(),
        curseforge: curseforge_lane.next_cursor(),
    };
    let total = [&next.modrinth, &next.curseforge]
        .iter()
        .filter_map(|c| c.total)
        .sum();
    let next_cursor = (!(next.modrinth.exhausted && next.curseforge.exhausted)).then_some(next);
    AggregateResult {
        hits,
        total,
        errors,
        skipped,
        next_cursor,
    }
}

/// 把一个平台的取回结果整理成一窗。不参与的平台视为已到底；失败的平台窗为空、游标不前进。
fn build_lane(
    platform: Platform,
    participating: bool,
    cursor: &PlatformCursor,
    result: Option<crate::error::Result<Window>>,
    limit: u32,
    errors: &mut Vec<PlatformError>,
) -> Lane {
    let mut lane = Lane::empty(cursor);
    if !participating {
        lane.ends_after_window = true;
        lane.total = None;
        return lane;
    }
    match result {
        None => lane,
        Some(Err(error)) => {
            // 失败不能当成到底：游标原地不动，下一页（或重试）会再问一次，先前记下的吸收项也照旧记着。
            lane.ends_after_window = false;
            lane.kept.clone_from(&cursor.absorbed);
            errors.push(PlatformError { platform, error });
            lane
        }
        Some(Ok(Window {
            mut items,
            fetched,
            total,
        })) => {
            let previous: HashSet<&String> = cursor.absorbed.iter().collect();
            for (index, item) in items.iter_mut().enumerate() {
                if let Some(hit) = item
                    && previous.contains(&hit.project_id)
                {
                    lane.carried.push((index, hit.project_id.clone()));
                    *item = None;
                }
            }
            lane.items = items;
            lane.total = Some(total);
            lane.ends_after_window =
                fetched < limit as usize || u64::from(cursor.offset) + fetched as u64 >= total;
            lane
        }
    }
}

/// 从两窗里交织出最多 `limit` 条。
fn interleave(lanes: &mut [Lane; 2], sort: SortField, limit: usize) -> Vec<SearchEntry> {
    let mut out = Vec::with_capacity(limit);
    // 轮流出时下一条优先给谁：0 为 Modrinth，1 为 CurseForge。
    let mut turn = 0usize;
    while out.len() < limit {
        for lane in lanes.iter_mut() {
            lane.skip_consumed();
        }
        let pick = match (lanes[0].head(), lanes[1].head()) {
            (None, None) => break,
            (Some(_), None) => 0,
            (None, Some(_)) => 1,
            (Some(a), Some(b)) => match compare_heads(a, b, sort) {
                Some(Ordering::Less) => 1,
                Some(_) => 0,
                None => turn,
            },
        };
        let hit = lanes[pick].take();
        let other = 1 - pick;
        let partner = lanes[other].absorb_partner(&hit);
        let entry = match partner {
            // 合并卡的主来源固定为 Modrinth。
            Some(partner) if pick == 0 => SearchEntry::merged(hit, partner),
            Some(partner) => SearchEntry::merged(partner, hit),
            None => SearchEntry::single(hit),
        };
        out.push(entry);
        turn = other;
    }
    out
}

/// 两个平台的队首谁先出：`Greater`/`Equal` 表示 Modrinth 先；`None` 表示不可比，轮流出。
fn compare_heads(
    modrinth: &SearchHit,
    curseforge: &SearchHit,
    sort: SortField,
) -> Option<Ordering> {
    match sort {
        SortField::Downloads => Some(modrinth.downloads.cmp(&curseforge.downloads)),
        SortField::Updated => {
            // ISO-8601 的前 19 位（到秒）可直接按字典序比较；缺失的排后。
            let key = |h: &SearchHit| {
                h.date_modified
                    .as_deref()
                    .map(|d| d.get(..19).unwrap_or(d).to_owned())
            };
            Some(match (key(modrinth), key(curseforge)) {
                (Some(a), Some(b)) => a.cmp(&b),
                (Some(_), None) => Ordering::Greater,
                (None, Some(_)) => Ordering::Less,
                (None, None) => Ordering::Equal,
            })
        }
        SortField::Relevance | SortField::Follows | SortField::Newest => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use aurora_base::retry::RetryPolicy;
    use wiremock::matchers::{method, path, query_param};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    fn no_retry() -> RetryPolicy {
        RetryPolicy {
            max_attempts: 1,
            ..RetryPolicy::default()
        }
    }

    fn hit(
        platform: Platform,
        id: &str,
        title: &str,
        author: Option<&str>,
        downloads: u64,
    ) -> SearchHit {
        SearchHit {
            platform,
            project_id: id.to_owned(),
            slug: Some(id.to_owned()),
            title: title.to_owned(),
            description: String::new(),
            author: author.map(str::to_owned),
            owner: None,
            downloads,
            follows: (platform == Platform::Modrinth).then_some(10),
            icon_url: None,
            gallery_url: None,
            hue: None,
            categories: Vec::new(),
            loaders: Vec::new(),
            resource_type: ResourceType::Mod,
            date_modified: None,
            page_url: None,
        }
    }

    #[test]
    fn merge_requires_both_title_and_author_after_normalization() {
        let mr = hit(
            Platform::Modrinth,
            "a",
            "Better MC [BMC5]",
            Some("LunaPixelStudios"),
            1,
        );
        // 大小写、空白、标点不同仍是同一个。
        let cf = hit(
            Platform::CurseForge,
            "1",
            "better mc (bmc5)",
            Some("Luna Pixel Studios"),
            1,
        );
        assert!(should_merge(&mr, &cf));
        // 标题同、作者不同：不合并。
        let other_author = hit(
            Platform::CurseForge,
            "2",
            "Better MC [BMC5]",
            Some("someone"),
            1,
        );
        assert!(!should_merge(&mr, &other_author));
        // 作者同、标题不同：不合并（不做模糊匹配，BMC4 不是 BMC5）。
        let other_title = hit(
            Platform::CurseForge,
            "3",
            "Better MC [BMC4]",
            Some("LunaPixelStudios"),
            1,
        );
        assert!(!should_merge(&mr, &other_title));
        // 作者未知：无从判断，不合并。
        let unknown = hit(Platform::CurseForge, "4", "Better MC [BMC5]", None, 1);
        assert!(!should_merge(&mr, &unknown));
        // 归一化后为空（纯标点）也不合并。
        let a = hit(Platform::Modrinth, "x", "!!!", Some("a"), 1);
        let b = hit(Platform::CurseForge, "y", "???", Some("a"), 1);
        assert!(!should_merge(&a, &b));
        // 中文标题按字符比较。
        let zh_a = hit(Platform::Modrinth, "z1", "机械动力：齿轮", Some("作者"), 1);
        let zh_b = hit(Platform::CurseForge, "z2", "机械动力 齿轮", Some("作者"), 1);
        assert!(should_merge(&zh_a, &zh_b));
    }

    /// 组织工程的组织名与所有者都能对上另一平台的作者，别的名字对不上；只有所有者一样但标题不同也不合。
    #[test]
    fn organization_hit_merges_under_either_of_its_names() {
        let mut mr = hit(
            Platform::Modrinth,
            "AANobbMI",
            "Sodium",
            Some("CaffeineMC"),
            1,
        );
        mr.owner = Some("jellysquid3".to_owned());
        let cf = |author: &str, title: &str| hit(Platform::CurseForge, "1", title, Some(author), 1);

        assert!(should_merge(&mr, &cf("caffeine mc", "Sodium")));
        assert!(should_merge(&mr, &cf("JellySquid3", "Sodium")));
        assert!(should_merge(&cf("JellySquid3", "Sodium"), &mr));
        assert!(!should_merge(&mr, &cf("someone", "Sodium")));
        assert!(!should_merge(&mr, &cf("JellySquid3", "Lithium")));
    }

    #[test]
    fn merged_entry_sums_numbers_and_keeps_modrinth_as_primary() {
        let mut mr = hit(
            Platform::Modrinth,
            "mr-sodium",
            "Sodium",
            Some("jellysquid3"),
            100,
        );
        mr.loaders = vec![ModLoader::Fabric];
        let mut cf = hit(
            Platform::CurseForge,
            "394468",
            "Sodium",
            Some("jellysquid3"),
            40,
        );
        cf.loaders = vec![ModLoader::Fabric, ModLoader::NeoForge];
        cf.gallery_url = Some("https://cf/shot.png".into());
        let entry = SearchEntry::merged(mr, cf);
        assert_eq!(entry.platform, Platform::Modrinth);
        assert_eq!(entry.project_id, "mr-sodium");
        assert_eq!(entry.downloads, 140);
        // CurseForge 没有关注数，合计就是 Modrinth 的。
        assert_eq!(entry.follows, Some(10));
        assert_eq!(entry.loaders, vec![ModLoader::Fabric, ModLoader::NeoForge]);
        assert_eq!(entry.gallery_url.as_deref(), Some("https://cf/shot.png"));
        assert_eq!(entry.sources.len(), 2);
        assert_eq!(entry.sources[0].platform, Platform::Modrinth);
        assert_eq!(entry.sources[1].project_id, "394468");
        assert_eq!(entry.sources[1].downloads, 40);
    }

    fn modrinth_hits(entries: &[(&str, &str, &str, u64)]) -> serde_json::Value {
        let hits: Vec<serde_json::Value> = entries
            .iter()
            .map(|(id, title, author, downloads)| {
                serde_json::json!({
                    "project_id": id, "slug": id, "title": title, "description": "d",
                    "project_type": "mod", "downloads": downloads, "follows": 1,
                    "author": author, "date_modified": "2026-01-01T00:00:00Z"
                })
            })
            .collect();
        hits.into()
    }

    fn curseforge_mods(entries: &[(u32, &str, &str, u64, u32)]) -> serde_json::Value {
        let data: Vec<serde_json::Value> = entries
            .iter()
            .map(|(id, name, author, downloads, class_id)| {
                serde_json::json!({
                    "id": id, "name": name, "slug": format!("cf-{id}"), "summary": "d",
                    "downloadCount": downloads, "classId": class_id,
                    "authors": [{"id": 1, "name": author}]
                })
            })
            .collect();
        data.into()
    }

    async fn mount_modrinth_page(
        server: &MockServer,
        offset: u32,
        hits: serde_json::Value,
        total: u64,
    ) {
        Mock::given(method("GET"))
            .and(path("/search"))
            .and(query_param("offset", offset.to_string()))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "hits": hits, "offset": offset, "limit": 4, "total_hits": total
            })))
            .mount(server)
            .await;
    }

    async fn mount_curseforge_page(
        server: &MockServer,
        index: u32,
        data: serde_json::Value,
        total: u64,
    ) {
        let count = data.as_array().map_or(0, Vec::len);
        Mock::given(method("GET"))
            .and(path("/v1/mods/search"))
            .and(query_param("index", index.to_string()))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "data": data,
                "pagination": {"index": index, "pageSize": 4, "resultCount": count, "totalCount": total}
            })))
            .mount(server)
            .await;
    }

    fn clients(server: &MockServer) -> (ModrinthClient, CurseForgeClient) {
        let http = aurora_base::http::build_client().unwrap();
        let modrinth = ModrinthClient::new(http.clone())
            .with_base_url(server.uri())
            .with_retry(no_retry());
        let curseforge = CurseForgeClient::new(http, "test-key")
            .with_base_url(server.uri())
            .with_retry(no_retry());
        (modrinth, curseforge)
    }

    fn ids(result: &AggregateResult) -> Vec<String> {
        result
            .hits
            .iter()
            .map(|e| {
                e.sources
                    .iter()
                    .map(|s| s.project_id.clone())
                    .collect::<Vec<_>>()
                    .join("+")
            })
            .collect()
    }

    /// 组织工程在 CurseForge 上挂在所有者个人名下：卡片显示组织名，两边照样合成一张。
    /// Modrinth 一侧的结构取自 `/v2/search` 的实际响应。
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn organization_project_still_merges_with_listing_under_its_owner() {
        let server = MockServer::start().await;
        mount_modrinth_page(
            &server,
            0,
            serde_json::json!([{
                "project_id": "AANobbMI", "project_type": "mod", "all_project_types": ["mod"],
                "slug": "sodium", "author": "jellysquid3", "author_id": "TEZXhE2U",
                "organization": "CaffeineMC", "organization_id": "LjcZDkRW", "title": "Sodium",
                "description": "d", "downloads": 258125185, "follows": 42362,
                "date_modified": "2026-10-15T17:51:36.063140+00:00"
            }]),
            1,
        )
        .await;
        mount_curseforge_page(
            &server,
            0,
            curseforge_mods(&[(394468, "Sodium", "JellySquid3", 40, 6)]),
            1,
        )
        .await;

        let (modrinth, curseforge) = clients(&server);
        let query = SearchQuery::new("sodium").with_paging(4, 0);
        let page = aggregate_search(
            Some(&modrinth),
            CurseForgeSource::Enabled(&curseforge),
            &query,
            None,
        )
        .await;

        assert!(page.is_complete());
        assert_eq!(ids(&page), vec!["AANobbMI+394468"]);
        assert_eq!(page.hits[0].author.as_deref(), Some("CaffeineMC"));
    }

    /// 每页恰好 limit 条：两边轮流出；合并卡吸收了 CurseForge 窗口后部的同名工程，下一页遇到时
    /// 跳过；没用上的命中留到下一页；两边都到底后游标为 None。
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn pages_are_exact_merge_partners_do_not_reappear_and_cursor_ends() {
        let server = MockServer::start().await;
        mount_modrinth_page(
            &server,
            0,
            modrinth_hits(&[
                ("m1", "Sodium", "jellysquid3", 900),
                ("m2", "Lithium", "jellysquid3", 800),
                ("m3", "Iris", "coderbot", 700),
                ("m4", "Indium", "comp500", 600),
            ]),
            6,
        )
        .await;
        mount_modrinth_page(
            &server,
            2,
            modrinth_hits(&[
                ("m3", "Iris", "coderbot", 700),
                ("m4", "Indium", "comp500", 600),
                ("m5", "Zoomify", "isxander", 500),
                ("m6", "Sodium Extra", "FlashyReese", 400),
            ]),
            6,
        )
        .await;
        mount_modrinth_page(
            &server,
            4,
            modrinth_hits(&[
                ("m5", "Zoomify", "isxander", 500),
                ("m6", "Sodium Extra", "FlashyReese", 400),
            ]),
            6,
        )
        .await;
        // CurseForge 窗口第 4 项是 Lithium 的同名同作者工程（大小写不同），会并进 Modrinth 的 Lithium。
        mount_curseforge_page(
            &server,
            0,
            curseforge_mods(&[
                (1, "JEI", "mezz", 999, 6),
                (2, "Create", "simibubi", 888, 6),
                (4, "Botania", "Vazkii", 70, 6),
                (3, "lithium", "JellySquid3", 50, 6),
            ]),
            5,
        )
        .await;
        mount_curseforge_page(
            &server,
            2,
            curseforge_mods(&[
                (4, "Botania", "Vazkii", 70, 6),
                (3, "lithium", "JellySquid3", 50, 6),
                (5, "Quark", "Vazkii", 40, 6),
            ]),
            5,
        )
        .await;

        let (modrinth, curseforge) = clients(&server);
        let query = SearchQuery::new("perf").with_paging(4, 0);
        let search = |cursor: Option<SearchCursor>| {
            let (modrinth, curseforge, query) = (&modrinth, &curseforge, &query);
            async move {
                aggregate_search(
                    Some(modrinth),
                    CurseForgeSource::Enabled(curseforge),
                    query,
                    cursor.as_ref(),
                )
                .await
            }
        };

        let page1 = search(None).await;
        assert!(page1.is_complete());
        assert_eq!(ids(&page1), vec!["m1", "1", "m2+3", "2"]);
        assert_eq!(page1.total, 11);
        let cursor = page1.next_cursor.clone().expect("还有下一页");
        assert_eq!(cursor.modrinth.offset, 2);
        assert_eq!(cursor.curseforge.offset, 2);
        // CurseForge 的 3 号排在偏移之后却已被吸收，记进游标。
        assert_eq!(cursor.curseforge.absorbed, vec!["3".to_string()]);
        assert!(!cursor.curseforge.exhausted);

        let page2 = search(Some(cursor)).await;
        // 3 号被跳过，没有重复出现。
        assert_eq!(ids(&page2), vec!["m3", "4", "m4", "5"]);
        let cursor = page2.next_cursor.clone().expect("Modrinth 还有两条");
        assert!(cursor.curseforge.exhausted);
        assert!(
            cursor.curseforge.absorbed.is_empty(),
            "3 号已被消费，不再续记"
        );
        assert_eq!(cursor.curseforge.offset, 5);
        assert_eq!(cursor.modrinth.offset, 4);
        assert!(!cursor.modrinth.exhausted);

        let page3 = search(Some(cursor)).await;
        assert_eq!(ids(&page3), vec!["m5", "m6"]);
        assert!(page3.next_cursor.is_none(), "两边都到底");
    }

    /// 按下载量排序时两边按数值交织，而不是轮流。
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn downloads_sort_interleaves_by_value() {
        let server = MockServer::start().await;
        mount_modrinth_page(
            &server,
            0,
            modrinth_hits(&[("m1", "A", "x", 100), ("m2", "B", "x", 10)]),
            2,
        )
        .await;
        mount_curseforge_page(
            &server,
            0,
            curseforge_mods(&[(1, "C", "y", 50, 6), (2, "D", "y", 5, 6)]),
            2,
        )
        .await;
        let (modrinth, curseforge) = clients(&server);
        let query = SearchQuery::new("q")
            .with_sort(SortField::Downloads)
            .with_paging(4, 0);
        let result = aggregate_search(
            Some(&modrinth),
            CurseForgeSource::Enabled(&curseforge),
            &query,
            None,
        )
        .await;
        assert_eq!(ids(&result), vec!["m1", "1", "m2", "2"]);
        assert!(result.next_cursor.is_none(), "两边都不足一页即到底");
    }

    /// 多类型搜索时 CurseForge 混进来的世界（class 17）被筛掉，但仍计入偏移。
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn curseforge_foreign_classes_are_dropped_but_consumed() {
        let server = MockServer::start().await;
        mount_modrinth_page(&server, 0, modrinth_hits(&[]), 0).await;
        mount_curseforge_page(
            &server,
            0,
            curseforge_mods(&[(1, "World", "a", 9, 17), (2, "Pack", "b", 8, 4471)]),
            2,
        )
        .await;
        let (modrinth, curseforge) = clients(&server);
        let query = SearchQuery::default()
            .with_resource_types(Vec::new())
            .with_paging(4, 0);
        let result = aggregate_search(
            Some(&modrinth),
            CurseForgeSource::Enabled(&curseforge),
            &query,
            None,
        )
        .await;
        assert_eq!(ids(&result), vec!["2"]);
        assert_eq!(result.hits[0].resource_type, ResourceType::Modpack);
        assert!(result.next_cursor.is_none());
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn single_platform_failure_keeps_its_cursor_and_reports_error() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/search"))
            .respond_with(ResponseTemplate::new(500))
            .mount(&server)
            .await;
        mount_curseforge_page(
            &server,
            0,
            curseforge_mods(&[(7, "Create", "simibubi", 42, 6)]),
            1,
        )
        .await;

        let (modrinth, curseforge) = clients(&server);
        let query = SearchQuery::new("create").with_paging(4, 0);
        let result = aggregate_search(
            Some(&modrinth),
            CurseForgeSource::Enabled(&curseforge),
            &query,
            None,
        )
        .await;
        assert!(!result.is_complete());
        assert_eq!(result.errors.len(), 1);
        assert_eq!(result.errors[0].platform, Platform::Modrinth);
        assert_eq!(ids(&result), vec!["7"]);
        let cursor = result.next_cursor.expect("失败的平台不算到底");
        assert_eq!(cursor.modrinth.offset, 0);
        assert!(!cursor.modrinth.exhausted);
        assert!(cursor.curseforge.exhausted);
    }

    /// 平台这一页失败时游标原地不动，先前记下的吸收项也得原样续记：丢了它，重试那一页时已经并进
    /// 合并卡的工程会再单独出现一次。
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn failed_platform_keeps_absorbed_ids_so_merged_entries_do_not_reappear() {
        let server = MockServer::start().await;
        mount_modrinth_page(
            &server,
            2,
            modrinth_hits(&[("m3", "Iris", "coderbot", 700)]),
            3,
        )
        .await;
        Mock::given(method("GET"))
            .and(path("/v1/mods/search"))
            .respond_with(ResponseTemplate::new(503))
            .up_to_n_times(1)
            .with_priority(1)
            .mount(&server)
            .await;
        mount_curseforge_page(
            &server,
            2,
            curseforge_mods(&[
                (4, "Botania", "Vazkii", 70, 6),
                (3, "lithium", "JellySquid3", 50, 6),
            ]),
            4,
        )
        .await;

        let (modrinth, curseforge) = clients(&server);
        let query = SearchQuery::new("perf").with_paging(4, 0);
        // 上一页 CurseForge 的 3 号已经并进 Modrinth 的 Lithium，排在偏移 2 之后，记在游标里。
        let cursor = SearchCursor {
            modrinth: PlatformCursor {
                offset: 2,
                exhausted: false,
                total: Some(3),
                absorbed: Vec::new(),
            },
            curseforge: PlatformCursor {
                offset: 2,
                exhausted: false,
                total: Some(4),
                absorbed: vec!["3".to_string()],
            },
        };

        let failed = aggregate_search(
            Some(&modrinth),
            CurseForgeSource::Enabled(&curseforge),
            &query,
            Some(&cursor),
        )
        .await;
        assert_eq!(failed.errors.len(), 1);
        assert_eq!(failed.errors[0].platform, Platform::CurseForge);
        assert_eq!(ids(&failed), vec!["m3"]);
        let retry = failed.next_cursor.expect("失败的平台不算到底");
        assert_eq!(retry.curseforge.offset, 2);
        assert_eq!(retry.curseforge.absorbed, vec!["3".to_string()]);

        let recovered = aggregate_search(
            Some(&modrinth),
            CurseForgeSource::Enabled(&curseforge),
            &query,
            Some(&retry),
        )
        .await;
        assert!(recovered.is_complete());
        assert_eq!(ids(&recovered), vec!["4"], "3 号已并进合并卡，不再单独出现");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn skipped_platforms_are_reported_separately_from_errors() {
        let server = MockServer::start().await;
        mount_modrinth_page(&server, 0, modrinth_hits(&[("m1", "A", "x", 1)]), 1).await;
        let (modrinth, curseforge) = clients(&server);

        let no_key = aggregate_search(
            Some(&modrinth),
            CurseForgeSource::Skipped(SkipReason::KeyMissing),
            &SearchQuery::new("a").with_paging(4, 0),
            None,
        )
        .await;
        assert!(no_key.is_complete());
        assert_eq!(
            no_key.skipped,
            vec![SkippedPlatform {
                platform: Platform::CurseForge,
                reason: SkipReason::KeyMissing
            }]
        );
        assert_eq!(ids(&no_key), vec!["m1"]);
        assert!(no_key.next_cursor.is_none());

        // 分类换算不到时 CurseForge 不发请求（mock 上没挂 CurseForge 路由，发了会报 404 错误）。
        let unmapped = aggregate_search(
            Some(&modrinth),
            CurseForgeSource::Enabled(&curseforge),
            &SearchQuery::default()
                .with_resource_type(ResourceType::Shader)
                .with_category("potato")
                .with_paging(4, 0),
            None,
        )
        .await;
        assert!(
            unmapped.is_complete(),
            "CurseForge 不该被请求：{:?}",
            unmapped.errors
        );
        assert_eq!(unmapped.skipped[0].reason, SkipReason::CategoryUnmapped);

        let only_curseforge = aggregate_search(
            None,
            CurseForgeSource::Skipped(SkipReason::KeyMissing),
            &SearchQuery::new("a").with_paging(4, 0),
            None,
        )
        .await;
        assert!(only_curseforge.hits.is_empty());
        assert_eq!(only_curseforge.skipped.len(), 2);
        assert_eq!(only_curseforge.skipped[0].reason, SkipReason::Filtered);
        assert!(only_curseforge.next_cursor.is_none());
    }
}
