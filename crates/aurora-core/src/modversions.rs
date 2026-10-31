//! 工程可用版本列表、单个版本与工程摘要（跨平台统一视图）。
//!
//! Modrinth 的 `GET /project/{id}/version` 与 CurseForge 的 `GET /mods/{id}/files` 返回两套形状完全
//! 不同的 JSON，归一动作已经在 [`aurora_modplatform::version`] 里做完。本模块只负责门面这一层的编排：
//! 按平台选客户端、拿列表、按调用方给的 MC 版本与加载器过滤，最后统一成
//! [`ModVersionInfo`] 交给兼容判定、依赖解析与更新检查复用——上层不该再见到任何平台分支。
//!
//! 排序一律按发布时间倒序：两个平台都不保证返回顺序，而版本下拉、依赖择优、更新检查想要的都是
//! 「最新的那个」，排序规则若各处自定必然分叉。
//!
//! 版本列表带一层短时进程内缓存：落位矩阵、安装计划（每个依赖一次）、更新检查（CurseForge 侧每个
//! Mod 一次）会在几秒内反复问同一个工程的版本列表，没有缓存就全靠令牌桶在客户端排队。

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use aurora_modplatform::{
    CurseForgeClient, CurseForgeFile, ModLoader, ModVersionInfo, ModrinthClient, ModrinthVersion,
    Platform,
};
use serde::Serialize;

use crate::error::{CoreError, Result};
use crate::facade::Aurora;

/// 版本列表缓存的有效期。平台上新版本的发布频率以天计，五分钟的陈旧度换来的是一次装 Mod 流程里
/// 同一工程只问一次平台。
const VERSION_LIST_TTL: Duration = Duration::from_secs(5 * 60);

/// 缓存条目上限，防止长时间浏览大量工程把进程内存慢慢撑大。
const VERSION_LIST_CAPACITY: usize = 256;

/// 工程摘要：给安装计划、卷宗与列表页一个能读的名字和图标。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ProjectInfo {
    /// 平台上的工程标题。
    pub title: String,
    /// 工程图标地址；平台没给为 `None`。
    pub icon_url: Option<String>,
}

impl Aurora {
    /// 列出某工程的全部可用版本（跨平台统一模型），按发布时间倒序。
    ///
    /// `game_versions` / `loaders` 传空表示该维度不过滤。同一维度内多个取值之间是「或」，两个维度
    /// 之间是「与」。能下推给平台的过滤条件一律下推（Modrinth 支持多值数组，CurseForge 单次只能
    /// 表达一个值），但下推只当作优化：两个平台的过滤语义并不一致，最终口径由本地那一遍统一。
    ///
    /// 平台没给元数据的版本一律放行，与 [`crate::compat::classify`] 判「可能可行」是同一条口径。
    /// CurseForge 早期文件常常既没标加载器也没标 MC 版本，若把「不知道」当「不匹配」筛掉，落位层
    /// 判成「可能可行」的实例会在版本列表里一个版本都挑不出来，玩家看到的就是自相矛盾的两块 UI。
    ///
    /// 工程不存在时平台返回 404，经 [`CoreError::ModPlatform`] 原样冒泡而不吞成空列表——
    /// 「这个工程一个版本都没有」与「这个工程根本不存在」对 UI 是两件事。
    pub async fn list_mod_versions(
        &self,
        platform: Platform,
        project_id: &str,
        game_versions: &[String],
        loaders: &[ModLoader],
    ) -> Result<Vec<ModVersionInfo>> {
        let base = match platform {
            Platform::Modrinth => self.modrinth_base(),
            Platform::CurseForge => self.curseforge_base(),
        };
        let key = cache_key(base, platform, project_id, game_versions, loaders);
        if let Some(hit) = self.version_cache().get(&key, Instant::now()) {
            return Ok(hit);
        }
        let fetched = match platform {
            Platform::Modrinth => {
                fetch_modrinth(&self.modrinth_client(), project_id, game_versions, loaders).await?
            }
            Platform::CurseForge => {
                fetch_curseforge(
                    &self.curseforge_client()?,
                    project_id,
                    game_versions,
                    loaders,
                )
                .await?
            }
        };
        let refined = refine(fetched, game_versions, loaders);
        self.version_cache()
            .put(key, Instant::now(), refined.clone());
        Ok(refined)
    }

    /// 写类操作之后让该工程的版本列表缓存失效，下一次读取重新问平台。
    ///
    /// 装完或更新完一个工程，紧接着的落位矩阵与更新检查应当看到平台此刻的真实状态，而不是装之前那一份。
    pub(crate) fn invalidate_mod_versions(&self, platform: Platform, project_id: &str) {
        self.version_cache()
            .invalidate(&project_marker(platform, project_id));
    }

    fn version_cache(&self) -> std::sync::MutexGuard<'_, VersionListCache> {
        self.mod_versions
            .lock()
            .expect("缓存锁只在本模块里短暂持有，不会在持有时 panic")
    }

    /// 按版本标识取单个版本。平台上不存在（或 CurseForge 的文件不属于该工程）返回
    /// [`CoreError::ModVersionNotFound`]。
    ///
    /// 安装、更新与钉了版本的依赖都只认一个确定的版本，直接走平台的单版本端点：CurseForge 的文件列表
    /// 是分页的，文件多的大 Mod 目标文件未必在首页，从列表里找会误报「版本不存在」。
    pub async fn get_mod_version(
        &self,
        platform: Platform,
        project_id: &str,
        version_id: &str,
    ) -> Result<ModVersionInfo> {
        match platform {
            Platform::Modrinth => {
                fetch_modrinth_version(&self.modrinth_client(), project_id, version_id).await
            }
            Platform::CurseForge => {
                fetch_curseforge_version(&self.curseforge_client()?, project_id, version_id).await
            }
        }
    }

    /// 按一批工程标识取工程摘要（标题与图标），一个平台一次请求；平台没返回的标识不在结果里。
    pub async fn project_infos(
        &self,
        platform: Platform,
        project_ids: &[String],
    ) -> Result<HashMap<String, ProjectInfo>> {
        match platform {
            Platform::Modrinth => {
                modrinth_project_infos(&self.modrinth_client(), project_ids).await
            }
            Platform::CurseForge => {
                curseforge_project_infos(&self.curseforge_client()?, project_ids).await
            }
        }
    }

    pub(crate) fn modrinth_client(&self) -> ModrinthClient {
        ModrinthClient::new(self.http()).with_base_url(self.modrinth_base())
    }

    /// CurseForge 客户端；未配置 API key 时报 [`aurora_modplatform::Error::CurseForgeKeyMissing`]。
    pub(crate) fn curseforge_client(&self) -> Result<CurseForgeClient> {
        #[cfg(test)]
        if let Some(key) = self.injected_curseforge_key() {
            return Ok(
                CurseForgeClient::new(self.http(), key).with_base_url(self.curseforge_base())
            );
        }
        Ok(CurseForgeClient::from_env(self.http())?.with_base_url(self.curseforge_base()))
    }
}

/// 拉取 Modrinth 工程版本并归一。
///
/// 过滤条件直接下推给 `/project/{id}/version` 的 `loaders` / `game_versions` 查询参数：Modrinth 两个
/// 参数都收 JSON 数组，语义与本地过滤一致，能少传一大截响应体。
///
/// `files` 为空的历史版本装不了，[`ModrinthVersion::to_version_info`] 会返回 `None`，这里显式跳过——
/// 塞一个空文件名进去会一路污染「卷宗与磁盘按文件名 join」这条地基。
async fn fetch_modrinth(
    client: &ModrinthClient,
    project_id: &str,
    game_versions: &[String],
    loaders: &[ModLoader],
) -> Result<Vec<ModVersionInfo>> {
    let wanted: Vec<&str> = game_versions.iter().map(String::as_str).collect();
    Ok(client
        .versions(project_id, loaders, &wanted)
        .await?
        .iter()
        .filter_map(ModrinthVersion::to_version_info)
        .collect())
}

/// 拉取 CurseForge 工程文件并归一。
///
/// `/mods/{id}/files` 的 `gameVersion` 与 `modLoaderType` 都只收单值，因此只有该维度恰好请求一个取值
/// 时才下推。这不只是省流量：该端点是分页的（客户端只取首页），不下推游戏版本时，一个有上百个文件
/// 的大 Mod 首页可能压根不含目标 MC 版本的文件，列表会「明明有版本却是空的」。
async fn fetch_curseforge(
    client: &CurseForgeClient,
    project_id: &str,
    game_versions: &[String],
    loaders: &[ModLoader],
) -> Result<Vec<ModVersionInfo>> {
    let mod_id = parse_curseforge_id(project_id, "*")?;
    let single_game_version = match game_versions {
        [only] => Some(only.as_str()),
        _ => None,
    };
    let single_loader = match loaders {
        [only] => Some(*only),
        _ => None,
    };
    Ok(client
        .mod_files(mod_id, single_loader, single_game_version)
        .await?
        .iter()
        .map(CurseForgeFile::to_version_info)
        .collect())
}

/// CurseForge 的工程与文件 id 都是十进制数字；非数字串不可能对应任何东西，在触网前就判为未找到。
fn parse_curseforge_id(project_id: &str, version_id: &str) -> Result<u32> {
    project_id
        .parse()
        .map_err(|_| CoreError::ModVersionNotFound {
            platform: Platform::CurseForge.display_name(),
            project_id: project_id.to_owned(),
            // 「*」表示「该工程的任何版本都取不到」，具体版本 id 由调用方给出时原样带上。
            version_id: version_id.to_owned(),
        })
}

fn not_found(platform: Platform, project_id: &str, version_id: &str) -> CoreError {
    CoreError::ModVersionNotFound {
        platform: platform.display_name(),
        project_id: project_id.to_owned(),
        version_id: version_id.to_owned(),
    }
}

/// Modrinth 单版本。版本 id 全局唯一，`project_id` 可能是 slug，不拿它去比对平台返回的规范 id。
async fn fetch_modrinth_version(
    client: &ModrinthClient,
    project_id: &str,
    version_id: &str,
) -> Result<ModVersionInfo> {
    client
        .version(version_id)
        .await?
        .and_then(|version| version.to_version_info())
        .ok_or_else(|| not_found(Platform::Modrinth, project_id, version_id))
}

/// CurseForge 单文件。平台给回的文件不属于请求的工程时同样判为未找到——那是一个错配的请求，不能装
/// 一个别家的文件进去。
async fn fetch_curseforge_version(
    client: &CurseForgeClient,
    project_id: &str,
    version_id: &str,
) -> Result<ModVersionInfo> {
    let mod_id = parse_curseforge_id(project_id, version_id)?;
    let file_id: u32 = version_id
        .parse()
        .map_err(|_| not_found(Platform::CurseForge, project_id, version_id))?;
    match client.mod_file(mod_id, file_id).await? {
        Some(file) if file.mod_id == mod_id => Ok(file.to_version_info()),
        _ => Err(not_found(Platform::CurseForge, project_id, version_id)),
    }
}

async fn modrinth_project_infos(
    client: &ModrinthClient,
    project_ids: &[String],
) -> Result<HashMap<String, ProjectInfo>> {
    Ok(client
        .projects(project_ids)
        .await?
        .into_iter()
        .map(|project| {
            (
                project.id,
                ProjectInfo {
                    title: project.title,
                    icon_url: project.icon_url,
                },
            )
        })
        .collect())
}

async fn curseforge_project_infos(
    client: &CurseForgeClient,
    project_ids: &[String],
) -> Result<HashMap<String, ProjectInfo>> {
    let mut ids = Vec::with_capacity(project_ids.len());
    for id in project_ids {
        ids.push(parse_curseforge_id(id, "*")?);
    }
    Ok(client
        .mods(&ids)
        .await?
        .into_iter()
        .map(|item| {
            (
                item.id.to_string(),
                ProjectInfo {
                    title: item.name,
                    icon_url: item.logo.map(|logo| logo.url),
                },
            )
        })
        .collect())
}

/// 过滤 + 排序：两个平台拉回来的列表都过这一道，保证对外口径唯一。
fn refine(
    mut versions: Vec<ModVersionInfo>,
    game_versions: &[String],
    loaders: &[ModLoader],
) -> Vec<ModVersionInfo> {
    versions.retain(|version| matches_filters(version, game_versions, loaders));
    sort_by_published_desc(&mut versions);
    versions
}

/// 某版本是否通过调用方给的过滤条件。
///
/// 三条规则：该维度没提要求就放行；平台没给该维度的元数据也放行（缺失不是证据）；给了就必须有交集。
/// 第二条与 [`crate::compat::classify`] 把单维缺失判成「可能可行」完全对齐，两处若各行其是，
/// 落位层的判定和版本下拉就会互相打脸。
fn matches_filters(
    version: &ModVersionInfo,
    game_versions: &[String],
    loaders: &[ModLoader],
) -> bool {
    let game_ok = game_versions.is_empty()
        || version.game_versions.is_empty()
        || version
            .game_versions
            .iter()
            .any(|declared| game_versions.contains(declared));
    let loader_ok = loaders.is_empty()
        || version.loaders.is_empty()
        || version
            .loaders
            .iter()
            .any(|declared| loaders.contains(declared));
    game_ok && loader_ok
}

/// 按发布时间倒序排序，日期缺失的沉底。
///
/// 两个平台的 `date_published` 都是 UTC 的 ISO 8601 定宽串，字典序即时间序，不必解析成时间戳再比
/// （启动器没有必要为排序引入一个日期库）。若将来出现带时区偏移的取值，这里必须改成真正的时间解析。
///
/// 日期为空串的版本排在最后：平台没给发布时间时无从判断新旧，把它顶到「最新」位置会让默认选中落到
/// 一个来历不明的版本上。
pub fn sort_by_published_desc(versions: &mut [ModVersionInfo]) {
    versions.sort_by(|a, b| {
        // 第一维升序（有日期 false < 无日期 true，即有日期的在前），第二维降序（新的在前）。
        a.date_published
            .is_empty()
            .cmp(&b.date_published.is_empty())
            .then_with(|| b.date_published.cmp(&a.date_published))
    });
}

// ---- 版本列表缓存 ----

/// 门面持有的共享缓存句柄。门面克隆（命令层的快照）共享同一份缓存，各自新建的门面互不相干。
pub(crate) type SharedVersionCache = Arc<Mutex<VersionListCache>>;

/// 工程在缓存键里的前缀：平台 + 工程。失效时按它匹配，不管当初带的是什么过滤条件。
fn project_marker(platform: Platform, project_id: &str) -> String {
    format!("{}\u{1f}{project_id}\u{1f}", platform.display_name())
}

/// 缓存键：根地址 + 平台 + 工程 + 排序后的过滤条件。带上根地址，测试里各自的 mock 服务不会串用。
fn cache_key(
    base: &str,
    platform: Platform,
    project_id: &str,
    game_versions: &[String],
    loaders: &[ModLoader],
) -> String {
    let mut games: Vec<&str> = game_versions.iter().map(String::as_str).collect();
    games.sort_unstable();
    games.dedup();
    let mut kinds: Vec<&str> = loaders.iter().map(|l| l.modrinth_facet()).collect();
    kinds.sort_unstable();
    kinds.dedup();
    format!(
        "{}{}\u{1f}{}\u{1f}{base}",
        project_marker(platform, project_id),
        games.join(","),
        kinds.join(",")
    )
}

/// 带有效期与容量上限的版本列表缓存。时刻由调用方传入，便于脱离真实时钟测试。
#[derive(Default)]
pub(crate) struct VersionListCache {
    entries: HashMap<String, (Instant, Vec<ModVersionInfo>)>,
}

impl VersionListCache {
    fn get(&self, key: &str, now: Instant) -> Option<Vec<ModVersionInfo>> {
        let (stored_at, value) = self.entries.get(key)?;
        (now.saturating_duration_since(*stored_at) < VERSION_LIST_TTL).then(|| value.clone())
    }

    fn put(&mut self, key: String, now: Instant, value: Vec<ModVersionInfo>) {
        if self.entries.len() >= VERSION_LIST_CAPACITY && !self.entries.contains_key(&key) {
            self.entries.retain(|_, (stored_at, _)| {
                now.saturating_duration_since(*stored_at) < VERSION_LIST_TTL
            });
            // 全都没过期仍然满了：挤掉最老的一条，给新的让位。
            if self.entries.len() >= VERSION_LIST_CAPACITY
                && let Some(oldest) = self
                    .entries
                    .iter()
                    .min_by_key(|(_, (stored_at, _))| *stored_at)
                    .map(|(k, _)| k.clone())
            {
                self.entries.remove(&oldest);
            }
        }
        self.entries.insert(key, (now, value));
    }

    fn invalidate(&mut self, marker: &str) {
        self.entries.retain(|key, _| !key.starts_with(marker));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::AuroraConfig;
    use aurora_modplatform::{
        DependencyKind, Error as PlatformError, ModDependency, ReleaseChannel,
    };
    use wiremock::matchers::{method, path, query_param, query_param_is_missing};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    fn version(id: &str, date: &str) -> ModVersionInfo {
        ModVersionInfo {
            version_id: id.to_owned(),
            project_id: "AANobbMI".to_owned(),
            platform: Platform::Modrinth,
            name: format!("Sodium {id}"),
            version_number: id.to_owned(),
            release_channel: ReleaseChannel::Release,
            game_versions: vec!["1.20.1".to_owned()],
            loaders: Vec::new(),
            file_name: format!("{id}.jar"),
            file_size: None,
            sha1: None,
            download_url: None,
            date_published: date.to_owned(),
            dependencies: Vec::new(),
        }
    }

    /// 造一个可精确控制两维元数据的版本，用于过滤边界。
    fn tagged(
        id: &str,
        date: &str,
        game_versions: &[&str],
        loaders: &[ModLoader],
    ) -> ModVersionInfo {
        ModVersionInfo {
            game_versions: game_versions.iter().map(|v| (*v).to_owned()).collect(),
            loaders: loaders.to_vec(),
            ..version(id, date)
        }
    }

    fn ids(versions: &[ModVersionInfo]) -> Vec<&str> {
        versions.iter().map(|v| v.version_id.as_str()).collect()
    }

    fn test_aurora(base: &str) -> Aurora {
        let tmp = std::env::temp_dir().join("petalfall-modversions-tests");
        Aurora::for_test(AuroraConfig::default(), tmp.clone(), tmp)
            .with_modrinth_base(base)
            .with_curseforge_base(base)
    }

    /// 直接建一个带 key 的 CurseForge 客户端：`from_env` 依赖进程级环境变量，测试里改全局环境
    /// （edition 2024 下还是 unsafe）会污染同进程的其它测试，故只覆盖到客户端之后的逻辑。
    fn curseforge_client(base: &str) -> CurseForgeClient {
        let http = aurora_base::http::build_client().expect("构建测试 HTTP 客户端");
        CurseForgeClient::new(http, "test-key").with_base_url(base)
    }

    // ---- 排序 ----

    #[test]
    fn newest_first() {
        let mut list = vec![
            version("old", "2025-03-01T00:00:00Z"),
            version("newest", "2026-07-30T12:00:00Z"),
            version("mid", "2026-01-02T03:04:05Z"),
        ];
        sort_by_published_desc(&mut list);
        assert_eq!(ids(&list), vec!["newest", "mid", "old"]);
    }

    #[test]
    fn same_day_orders_by_time_not_just_date() {
        let mut list = vec![
            version("morning", "2026-05-05T08:00:00Z"),
            version("evening", "2026-05-05T21:30:00Z"),
        ];
        sort_by_published_desc(&mut list);
        assert_eq!(ids(&list), vec!["evening", "morning"]);
    }

    #[test]
    fn undated_versions_sink_below_dated_ones() {
        let mut list = vec![
            version("nodate-a", ""),
            version("oldest", "2019-01-01T00:00:00Z"),
            version("nodate-b", ""),
            version("newer", "2026-01-01T00:00:00Z"),
        ];
        sort_by_published_desc(&mut list);
        // 即便日期最老，有日期的也排在无日期的前面。
        assert_eq!(ids(&list), vec!["newer", "oldest", "nodate-a", "nodate-b"]);
    }

    #[test]
    fn empty_and_single_are_untouched() {
        let mut empty: Vec<ModVersionInfo> = Vec::new();
        sort_by_published_desc(&mut empty);
        assert!(empty.is_empty());

        let mut one = vec![version("only", "2026-01-01T00:00:00Z")];
        sort_by_published_desc(&mut one);
        assert_eq!(ids(&one), vec!["only"]);
    }

    // ---- 本地过滤 ----

    #[test]
    fn filter_drops_declared_mismatches_and_keeps_metadata_less_versions() {
        let list = vec![
            tagged(
                "hit",
                "2026-01-05T00:00:00Z",
                &["1.20.1"],
                &[ModLoader::Fabric],
            ),
            // 加载器对不上：确凿不兼容，筛掉。
            tagged(
                "wrong-loader",
                "2026-01-04T00:00:00Z",
                &["1.20.1"],
                &[ModLoader::Forge],
            ),
            // MC 版本对不上：确凿不兼容，筛掉。
            tagged(
                "wrong-mc",
                "2026-01-03T00:00:00Z",
                &["1.19.4"],
                &[ModLoader::Fabric],
            ),
            // 两维都没标：平台没给元数据不等于不兼容，放行。
            tagged("bare", "2026-01-02T00:00:00Z", &[], &[]),
            // 只标了加载器且对得上，MC 版本缺失：单维缺失同样放行。
            tagged(
                "loader-only",
                "2026-01-01T00:00:00Z",
                &[],
                &[ModLoader::Fabric],
            ),
        ];
        let kept = refine(list, &["1.20.1".to_owned()], &[ModLoader::Fabric]);
        assert_eq!(ids(&kept), vec!["hit", "bare", "loader-only"]);
    }

    #[test]
    fn filter_treats_multiple_values_inside_one_dimension_as_or() {
        let list = vec![
            tagged(
                "mc-1201",
                "2026-01-03T00:00:00Z",
                &["1.20.1"],
                &[ModLoader::Fabric],
            ),
            tagged(
                "mc-1211",
                "2026-01-02T00:00:00Z",
                &["1.21.1"],
                &[ModLoader::Quilt],
            ),
            tagged(
                "mc-1194",
                "2026-01-01T00:00:00Z",
                &["1.19.4"],
                &[ModLoader::Fabric],
            ),
        ];
        let kept = refine(
            list,
            &["1.20.1".to_owned(), "1.21.1".to_owned()],
            &[ModLoader::Fabric, ModLoader::Quilt],
        );
        assert_eq!(ids(&kept), vec!["mc-1201", "mc-1211"]);
    }

    #[test]
    fn filter_requires_both_dimensions_to_pass() {
        let list = vec![tagged(
            "mc-ok-loader-bad",
            "2026-01-01T00:00:00Z",
            &["1.20.1"],
            &[ModLoader::Forge],
        )];
        assert!(refine(list, &["1.20.1".to_owned()], &[ModLoader::Fabric]).is_empty());
    }

    #[test]
    fn empty_filters_keep_everything() {
        let list = vec![
            tagged(
                "a",
                "2026-01-02T00:00:00Z",
                &["1.19.4"],
                &[ModLoader::Forge],
            ),
            tagged("b", "2026-01-03T00:00:00Z", &[], &[]),
        ];
        assert_eq!(ids(&refine(list, &[], &[])), vec!["b", "a"]);
    }

    // ---- 缓存 ----

    #[test]
    fn cache_entry_expires_after_ttl() {
        let mut cache = VersionListCache::default();
        let t0 = Instant::now();
        cache.put("k".into(), t0, vec![version("v", "2026-01-01T00:00:00Z")]);
        assert_eq!(
            cache.get("k", t0 + Duration::from_secs(1)).unwrap().len(),
            1
        );
        assert!(cache.get("k", t0 + VERSION_LIST_TTL).is_none());
        assert!(cache.get("absent", t0).is_none());
    }

    #[test]
    fn cache_invalidation_hits_every_filter_of_one_project_only() {
        let mut cache = VersionListCache::default();
        let t0 = Instant::now();
        let a1 = cache_key("http://x", Platform::Modrinth, "proj", &[], &[]);
        let a2 = cache_key(
            "http://x",
            Platform::Modrinth,
            "proj",
            &["1.20.1".to_owned()],
            &[ModLoader::Fabric],
        );
        // 前缀相同的另一个工程（proj 是 proj2 的前缀）不能被误伤。
        let other = cache_key("http://x", Platform::Modrinth, "proj2", &[], &[]);
        let same_id_other_platform = cache_key("http://x", Platform::CurseForge, "proj", &[], &[]);
        for key in [&a1, &a2, &other, &same_id_other_platform] {
            cache.put(key.clone(), t0, Vec::new());
        }
        cache.invalidate(&project_marker(Platform::Modrinth, "proj"));
        assert!(cache.get(&a1, t0).is_none());
        assert!(cache.get(&a2, t0).is_none());
        assert!(cache.get(&other, t0).is_some());
        assert!(cache.get(&same_id_other_platform, t0).is_some());
    }

    #[test]
    fn cache_key_ignores_filter_order_and_duplicates() {
        let a = cache_key(
            "b",
            Platform::Modrinth,
            "p",
            &["1.21".to_owned(), "1.20".to_owned()],
            &[ModLoader::Quilt, ModLoader::Fabric],
        );
        let b = cache_key(
            "b",
            Platform::Modrinth,
            "p",
            &["1.20".to_owned(), "1.21".to_owned(), "1.20".to_owned()],
            &[ModLoader::Fabric, ModLoader::Quilt],
        );
        assert_eq!(a, b);
    }

    #[test]
    fn cache_capacity_evicts_the_oldest_live_entry() {
        let mut cache = VersionListCache::default();
        let t0 = Instant::now();
        for i in 0..VERSION_LIST_CAPACITY {
            cache.put(
                format!("k{i}"),
                t0 + Duration::from_millis(i as u64),
                Vec::new(),
            );
        }
        cache.put("new".into(), t0 + Duration::from_secs(1), Vec::new());
        assert_eq!(cache.entries.len(), VERSION_LIST_CAPACITY);
        assert!(cache.get("k0", t0 + Duration::from_secs(1)).is_none());
        assert!(cache.get("k1", t0 + Duration::from_secs(1)).is_some());
        assert!(cache.get("new", t0 + Duration::from_secs(1)).is_some());
    }

    // ---- Modrinth ----

    fn modrinth_body() -> serde_json::Value {
        serde_json::json!([
            {
                "id": "old", "project_id": "AANobbMI", "name": "Sodium 0.5.0",
                "version_number": "0.5.0", "version_type": "release",
                "date_published": "2025-01-01T00:00:00Z", "game_versions": ["1.20.1"],
                "loaders": ["fabric"],
                "files": [{"hashes": {"sha1": "aa"}, "url": "https://cdn/old.jar", "filename": "old.jar", "primary": true, "size": 1}]
            },
            {
                "id": "new", "project_id": "AANobbMI", "name": "Sodium 0.6.0",
                "version_number": "0.6.0", "version_type": "beta",
                "date_published": "2026-01-01T00:00:00Z", "game_versions": ["1.20.1"],
                "loaders": ["fabric", "quilt"],
                "dependencies": [{"project_id": "P7dR8mSH", "dependency_type": "required"}],
                "files": [{"hashes": {"sha1": "bb"}, "url": "https://cdn/new.jar", "filename": "new.jar", "primary": true, "size": 2}]
            },
            {
                "id": "empty", "project_id": "AANobbMI", "name": "空版本",
                "version_number": "0.0.1", "version_type": "release",
                "date_published": "2026-06-01T00:00:00Z", "files": []
            }
        ])
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn modrinth_versions_are_listed_newest_first_with_fields_mapped() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/project/AANobbMI/version"))
            .respond_with(ResponseTemplate::new(200).set_body_json(modrinth_body()))
            .mount(&server)
            .await;

        let list = test_aurora(&server.uri())
            .list_mod_versions(Platform::Modrinth, "AANobbMI", &[], &[])
            .await
            .unwrap();
        // 没有文件的版本被丢弃，其余按发布时间倒序。
        assert_eq!(ids(&list), vec!["new", "old"]);
        let newest = &list[0];
        assert_eq!(newest.release_channel, ReleaseChannel::Beta);
        assert_eq!(newest.loaders, vec![ModLoader::Fabric, ModLoader::Quilt]);
        assert_eq!(newest.download_url.as_deref(), Some("https://cdn/new.jar"));
        assert_eq!(
            newest.dependencies,
            vec![ModDependency {
                project_id: Some("P7dR8mSH".to_owned()),
                version_id: None,
                kind: DependencyKind::Required,
            }]
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn modrinth_filters_are_pushed_into_the_platform_query() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/project/AANobbMI/version"))
            .and(query_param("loaders", r#"["fabric"]"#))
            .and(query_param("game_versions", r#"["1.20.1"]"#))
            .respond_with(ResponseTemplate::new(200).set_body_json(modrinth_body()))
            .expect(1)
            .mount(&server)
            .await;

        let list = test_aurora(&server.uri())
            .list_mod_versions(
                Platform::Modrinth,
                "AANobbMI",
                &["1.20.1".to_owned()],
                &[ModLoader::Fabric],
            )
            .await
            .unwrap();
        assert_eq!(ids(&list), vec!["new", "old"]);
    }

    /// 同一工程同一过滤条件在有效期内只问一次平台；失效后重新问。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn repeated_listing_hits_cache_until_invalidated() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/project/cached-proj/version"))
            .respond_with(ResponseTemplate::new(200).set_body_json(modrinth_body()))
            .expect(2)
            .mount(&server)
            .await;
        let aurora = test_aurora(&server.uri());

        for _ in 0..3 {
            let list = aurora
                .list_mod_versions(Platform::Modrinth, "cached-proj", &[], &[])
                .await
                .unwrap();
            assert_eq!(ids(&list), vec!["new", "old"]);
        }
        // 快照与原门面共享同一份缓存：在克隆上失效，原门面同样看得见。
        aurora
            .clone()
            .invalidate_mod_versions(Platform::Modrinth, "cached-proj");
        aurora
            .list_mod_versions(Platform::Modrinth, "cached-proj", &[], &[])
            .await
            .unwrap();
        // expect(2) 在 server 丢弃时核对：前三次只打了一次，失效后再打一次。
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn modrinth_missing_project_bubbles_status_error() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/project/ghost/version"))
            .respond_with(ResponseTemplate::new(404))
            .mount(&server)
            .await;

        let err = test_aurora(&server.uri())
            .list_mod_versions(Platform::Modrinth, "ghost", &[], &[])
            .await
            .unwrap_err();
        assert!(matches!(
            err,
            CoreError::ModPlatform(PlatformError::Status { status: 404, .. })
        ));
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn modrinth_single_version_comes_from_the_version_endpoint() {
        let server = MockServer::start().await;
        let body = modrinth_body()[1].clone();
        Mock::given(method("GET"))
            .and(path("/version/new"))
            .respond_with(ResponseTemplate::new(200).set_body_json(body))
            .expect(1)
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path("/version/gone"))
            .respond_with(ResponseTemplate::new(404))
            .mount(&server)
            .await;
        let aurora = test_aurora(&server.uri());

        let got = aurora
            .get_mod_version(Platform::Modrinth, "sodium", "new")
            .await
            .unwrap();
        assert_eq!(got.version_id, "new");
        assert_eq!(got.file_name, "new.jar");

        let err = aurora
            .get_mod_version(Platform::Modrinth, "sodium", "gone")
            .await
            .unwrap_err();
        match err {
            CoreError::ModVersionNotFound {
                project_id,
                version_id,
                ..
            } => {
                assert_eq!(project_id, "sodium");
                assert_eq!(version_id, "gone");
            }
            other => panic!("期望 ModVersionNotFound，得到 {other:?}"),
        }
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn modrinth_project_infos_map_by_canonical_id() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/projects"))
            .respond_with(
                ResponseTemplate::new(200).set_body_json(serde_json::json!([{
                    "id": "AANobbMI", "slug": "sodium", "title": "Sodium", "description": "d",
                    "project_type": "mod", "downloads": 1, "icon_url": "https://cdn/s.png"
                }])),
            )
            .mount(&server)
            .await;
        let infos = test_aurora(&server.uri())
            .project_infos(Platform::Modrinth, &["AANobbMI".to_owned(), "x".to_owned()])
            .await
            .unwrap();
        assert_eq!(infos.len(), 1);
        assert_eq!(
            infos["AANobbMI"],
            ProjectInfo {
                title: "Sodium".to_owned(),
                icon_url: Some("https://cdn/s.png".to_owned()),
            }
        );
    }

    // ---- CurseForge ----

    fn curseforge_files_body() -> serde_json::Value {
        serde_json::json!({
            "data": [
                {
                    "id": 1001, "modId": 238222, "displayName": "JEI old",
                    "fileName": "jei-old.jar", "releaseType": 1,
                    "fileDate": "2025-02-01T00:00:00Z", "gameVersions": ["1.20.1", "Forge"]
                },
                {
                    "id": 1002, "modId": 238222, "displayName": "JEI new",
                    "fileName": "jei-new.jar", "releaseType": 2,
                    "fileDate": "2026-02-01T00:00:00Z", "gameVersions": ["1.20.1", "NeoForge", "Client"],
                    "downloadUrl": "https://cf/jei-new.jar"
                }
            ]
        })
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn curseforge_files_are_normalized_and_listed_newest_first() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/v1/mods/238222/files"))
            .and(query_param_is_missing("gameVersion"))
            .and(query_param_is_missing("modLoaderType"))
            .respond_with(ResponseTemplate::new(200).set_body_json(curseforge_files_body()))
            .mount(&server)
            .await;

        let list = refine(
            fetch_curseforge(&curseforge_client(&server.uri()), "238222", &[], &[])
                .await
                .unwrap(),
            &[],
            &[],
        );
        assert_eq!(ids(&list), vec!["1002", "1001"]);
        assert_eq!(list[0].loaders, vec![ModLoader::NeoForge]);
        assert_eq!(list[0].game_versions, vec!["1.20.1".to_owned()]);
        assert_eq!(list[0].release_channel, ReleaseChannel::Beta);
        assert_eq!(
            list[0].download_url.as_deref(),
            Some("https://cf/jei-new.jar")
        );
        assert_eq!(list[1].download_url, None);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn curseforge_single_value_filters_are_pushed_into_the_platform_query() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/v1/mods/238222/files"))
            .and(query_param("gameVersion", "1.20.1"))
            .and(query_param("modLoaderType", "6"))
            .respond_with(ResponseTemplate::new(200).set_body_json(curseforge_files_body()))
            .expect(1)
            .mount(&server)
            .await;

        let list = refine(
            fetch_curseforge(
                &curseforge_client(&server.uri()),
                "238222",
                &["1.20.1".to_owned()],
                &[ModLoader::NeoForge],
            )
            .await
            .unwrap(),
            &["1.20.1".to_owned()],
            &[ModLoader::NeoForge],
        );
        // 下推只是优化，本地过滤仍按两维求交：老文件是 Forge，被筛掉。
        assert_eq!(ids(&list), vec!["1002"]);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn curseforge_multi_value_filters_stay_local() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/v1/mods/238222/files"))
            .and(query_param_is_missing("gameVersion"))
            .and(query_param_is_missing("modLoaderType"))
            .respond_with(ResponseTemplate::new(200).set_body_json(curseforge_files_body()))
            .expect(1)
            .mount(&server)
            .await;

        let games = ["1.20.1".to_owned(), "1.21".to_owned()];
        let loaders = [ModLoader::Forge, ModLoader::Fabric];
        let list = refine(
            fetch_curseforge(
                &curseforge_client(&server.uri()),
                "238222",
                &games,
                &loaders,
            )
            .await
            .unwrap(),
            &games,
            &loaders,
        );
        assert_eq!(ids(&list), vec!["1001"]);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn curseforge_missing_project_bubbles_status_error() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/v1/mods/999/files"))
            .respond_with(ResponseTemplate::new(404))
            .mount(&server)
            .await;
        let err = fetch_curseforge(&curseforge_client(&server.uri()), "999", &[], &[])
            .await
            .unwrap_err();
        assert!(matches!(
            err,
            CoreError::ModPlatform(PlatformError::Status { status: 404, .. })
        ));
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn curseforge_non_numeric_project_id_errors_before_touching_network() {
        let server = MockServer::start().await;
        let err = fetch_curseforge(&curseforge_client(&server.uri()), "jei", &[], &[])
            .await
            .unwrap_err();
        assert!(matches!(err, CoreError::ModVersionNotFound { .. }));
        assert!(server.received_requests().await.unwrap().is_empty());
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn curseforge_single_file_must_belong_to_the_requested_project() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/v1/mods/238222/files/1002"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "data": curseforge_files_body()["data"][1].clone()
            })))
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path("/v1/mods/111/files/1002"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "data": curseforge_files_body()["data"][1].clone()
            })))
            .mount(&server)
            .await;
        let client = curseforge_client(&server.uri());

        let ok = fetch_curseforge_version(&client, "238222", "1002")
            .await
            .unwrap();
        assert_eq!(ok.file_name, "jei-new.jar");
        // 平台给回的文件属于 238222，而请求的是 111：错配不能当成功。
        let err = fetch_curseforge_version(&client, "111", "1002")
            .await
            .unwrap_err();
        assert!(matches!(err, CoreError::ModVersionNotFound { .. }));
        // 非数字的文件 id 在触网前就判为未找到。
        let err = fetch_curseforge_version(&client, "238222", "abc")
            .await
            .unwrap_err();
        assert!(matches!(err, CoreError::ModVersionNotFound { .. }));
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn curseforge_project_infos_use_name_and_logo() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/v1/mods"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "data": [{
                    "id": 238222, "name": "Just Enough Items", "slug": "jei", "summary": "s",
                    "logo": {"url": "https://cf/jei.png"}
                }]
            })))
            .mount(&server)
            .await;
        let infos =
            curseforge_project_infos(&curseforge_client(&server.uri()), &["238222".to_owned()])
                .await
                .unwrap();
        assert_eq!(infos["238222"].title, "Just Enough Items");
        assert_eq!(
            infos["238222"].icon_url.as_deref(),
            Some("https://cf/jei.png")
        );
    }
}
