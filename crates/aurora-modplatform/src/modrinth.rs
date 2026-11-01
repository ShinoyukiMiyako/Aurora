//! Modrinth v2 客户端（api.modrinth.com/v2）。
//!
//! 覆盖搜索（facets 过滤：类型/加载器/游戏版本）、工程详情、版本列表、依赖解析、以及按文件哈希查
//! 版本 / 查更新。所有远端地址经 `base_url` 注入，单测走本地 mock。响应体裸模型（`Modrinth*`）保持
//! 与 API 字段一致，向统一模型的翻译放在 [`From`] 实现里。组织只有 v3 路由，见
//! [`ModrinthClient::organizations`]。

use std::path::PathBuf;

use aurora_base::retry::RetryPolicy;
use aurora_download::DownloadTask;
use serde::Deserialize;

use crate::error::{Error, Result};
use crate::model::{
    DependencyKind, ModLoader, Platform, ResourceType, SearchHit, SearchQuery, SortField,
    hue_from_rgb,
};
use crate::net::send_json;
use crate::version::{ModDependency, ModVersionInfo, ReleaseChannel, parse_loader_name};

/// Modrinth v2 API 根地址。
pub const MODRINTH_BASE: &str = "https://api.modrinth.com/v2";

/// Modrinth v2 客户端。
#[derive(Debug, Clone)]
pub struct ModrinthClient {
    http: reqwest::Client,
    base_url: String,
    retry: RetryPolicy,
}

impl ModrinthClient {
    /// 用共享 HTTP 客户端构造，指向官方地址。
    pub fn new(http: reqwest::Client) -> Self {
        Self {
            http,
            base_url: MODRINTH_BASE.to_string(),
            retry: RetryPolicy::default(),
        }
    }

    /// 注入自定义根地址（末尾斜杠会被去除），供 mock 测试与镜像使用。
    pub fn with_base_url(mut self, base_url: impl Into<String>) -> Self {
        self.base_url = base_url.into().trim_end_matches('/').to_string();
        self
    }

    /// 覆盖重试策略。
    pub fn with_retry(mut self, retry: RetryPolicy) -> Self {
        self.retry = retry;
        self
    }

    /// 搜索工程。
    pub async fn search(&self, query: &SearchQuery) -> Result<ModrinthSearchResponse> {
        let facets = build_facets(query)?;
        let mut params: Vec<(&str, String)> = Vec::new();
        if let Some(text) = &query.query {
            params.push(("query", text.clone()));
        }
        params.push(("facets", facets));
        params.push(("index", search_index(query).to_string()));
        params.push(("offset", query.offset.to_string()));
        params.push(("limit", query.limit.to_string()));

        let url = format!("{}/search", self.base_url);
        send_json(&self.retry, "modrinth.search", || {
            self.http.get(url.as_str()).query(&params)
        })
        .await
    }

    /// 取工程详情（`id` 可为 project_id 或 slug）。
    pub async fn project(&self, id_or_slug: &str) -> Result<ModrinthProject> {
        let url = format!("{}/project/{}", self.base_url, id_or_slug);
        send_json(&self.retry, "modrinth.project", || {
            self.http.get(url.as_str())
        })
        .await
    }

    /// 工程成员列表（作者名取自这里：工程对象只带团队 id）。
    pub async fn project_members(&self, id_or_slug: &str) -> Result<Vec<ModrinthTeamMember>> {
        let url = format!("{}/project/{}/members", self.base_url, id_or_slug);
        send_json(&self.retry, "modrinth.project_members", || {
            self.http.get(url.as_str())
        })
        .await
    }

    /// 批量取多个团队的成员（一次请求），结果与 `team_ids` 不保证同序，按成员的 `team_id` 对回。
    pub async fn teams(&self, team_ids: &[String]) -> Result<Vec<Vec<ModrinthTeamMember>>> {
        if team_ids.is_empty() {
            return Ok(Vec::new());
        }
        let ids = json_array(
            &team_ids.iter().map(String::as_str).collect::<Vec<_>>(),
            "modrinth team ids",
        )?;
        let url = format!("{}/teams", self.base_url);
        send_json(&self.retry, "modrinth.teams", || {
            self.http.get(url.as_str()).query(&[("ids", ids.as_str())])
        })
        .await
    }

    /// 批量取组织（一次请求）：工程对象只带组织 id，组织名要到这里取。
    ///
    /// 不存在的 id 不会出现在结果里；空批次不发请求。v2 没有组织路由，这里换到同一根地址的 v3。
    pub async fn organizations(&self, ids: &[String]) -> Result<Vec<ModrinthOrganization>> {
        if ids.is_empty() {
            return Ok(Vec::new());
        }
        let ids = json_array(
            &ids.iter().map(String::as_str).collect::<Vec<_>>(),
            "modrinth organization ids",
        )?;
        let root = self
            .base_url
            .strip_suffix("/v2")
            .unwrap_or(self.base_url.as_str());
        let url = format!("{root}/v3/organizations");
        send_json(&self.retry, "modrinth.organizations", || {
            self.http.get(url.as_str()).query(&[("ids", ids.as_str())])
        })
        .await
    }

    /// 批量按版本 id 取版本（一次请求）。空批次不发请求。
    pub async fn versions_by_ids(&self, ids: &[String]) -> Result<Vec<ModrinthVersion>> {
        if ids.is_empty() {
            return Ok(Vec::new());
        }
        let ids = json_array(
            &ids.iter().map(String::as_str).collect::<Vec<_>>(),
            "modrinth version ids",
        )?;
        let url = format!("{}/versions", self.base_url);
        send_json(&self.retry, "modrinth.versions_by_ids", || {
            self.http.get(url.as_str()).query(&[("ids", ids.as_str())])
        })
        .await
    }

    /// 列出工程的版本，可按加载器与游戏版本过滤。
    pub async fn versions(
        &self,
        id_or_slug: &str,
        loaders: &[crate::model::ModLoader],
        game_versions: &[&str],
    ) -> Result<Vec<ModrinthVersion>> {
        // 版本对象里没有字段读更新日志；大工程上千个版本，带上日志要多传几百 KB。
        let mut params: Vec<(&str, String)> = vec![("include_changelog", "false".to_string())];
        if !loaders.is_empty() {
            let arr: Vec<&str> = loaders.iter().map(|l| l.modrinth_facet()).collect();
            params.push(("loaders", json_array(&arr, "modrinth loaders")?));
        }
        if !game_versions.is_empty() {
            params.push((
                "game_versions",
                json_array(game_versions, "modrinth game_versions")?,
            ));
        }
        let url = format!("{}/project/{}/version", self.base_url, id_or_slug);
        send_json(&self.retry, "modrinth.versions", || {
            self.http.get(url.as_str()).query(&params)
        })
        .await
    }

    /// 按版本 id 取单个版本；平台上不存在返回 `None`。
    ///
    /// 安装与依赖钉版本只认一个确定的版本 id，没必要为找它把整个工程的版本列表拉回来。
    pub async fn version(&self, version_id: &str) -> Result<Option<ModrinthVersion>> {
        let url = format!("{}/version/{}", self.base_url, version_id);
        let result = send_json(&self.retry, "modrinth.version", || {
            self.http.get(url.as_str())
        })
        .await;
        match result {
            Ok(version) => Ok(Some(version)),
            Err(Error::Status { status: 404, .. }) => Ok(None),
            Err(err) => Err(err),
        }
    }

    /// 取单个版本的更新日志；版本不存在返回 `None`。
    ///
    /// 与 [`Self::version`] 同一个端点，但只解析日志相关的几个字段：更新预览里玩家展开哪一项才取哪一项，
    /// 列表查询一律不带日志（见 [`Self::versions`]）。
    pub async fn version_changelog(&self, version_id: &str) -> Result<Option<ModrinthChangelog>> {
        let url = format!("{}/version/{}", self.base_url, version_id);
        let result = send_json(&self.retry, "modrinth.version_changelog", || {
            self.http.get(url.as_str())
        })
        .await;
        match result {
            Ok(changelog) => Ok(Some(changelog)),
            Err(Error::Status { status: 404, .. }) => Ok(None),
            Err(err) => Err(err),
        }
    }

    /// 按一批 SHA-1 反查各自对应的版本，返回 `哈希 -> 版本` 映射；未收录的哈希不出现在结果里。
    ///
    /// 手动丢进 mods 目录的 jar 补身份时，逐个文件各问一次就是 N 次请求，一个整合包实例上百个文件
    /// 立刻撞上限流。这里一次请求覆盖整批。
    pub async fn versions_by_hashes(
        &self,
        sha1s: &[String],
    ) -> Result<std::collections::HashMap<String, ModrinthVersion>> {
        if sha1s.is_empty() {
            return Ok(std::collections::HashMap::new());
        }
        #[derive(serde::Serialize)]
        struct HashList<'a> {
            hashes: &'a [String],
            algorithm: &'a str,
        }
        let body = HashList {
            hashes: sha1s,
            algorithm: "sha1",
        };
        let url = format!("{}/version_files", self.base_url);
        send_json(&self.retry, "modrinth.version_files", || {
            self.http.post(url.as_str()).json(&body)
        })
        .await
    }

    /// 按一批 SHA-1 查各自在指定加载器/游戏版本下的最新版本，返回 `哈希 -> 版本` 映射。
    ///
    /// 未收录或已是最新的哈希不会出现在结果里，故缺键即「无更新」，不是错误。一个实例几十个 Mod
    /// 逐个查会立刻撞上 Modrinth 限流（HTTP 429），这里一次请求覆盖整批。
    ///
    /// `version_types` 限定只看这些发布通道的版本，空切片表示不过滤（请求体里不带这个字段）。
    pub async fn latest_versions_by_hashes(
        &self,
        sha1s: &[String],
        loaders: &[crate::model::ModLoader],
        game_versions: &[&str],
        version_types: &[ReleaseChannel],
    ) -> Result<std::collections::HashMap<String, ModrinthVersion>> {
        // 空批次不该白打一次网络请求，也避免服务端对空 hashes 的行为差异。
        if sha1s.is_empty() {
            return Ok(std::collections::HashMap::new());
        }
        #[derive(serde::Serialize)]
        struct UpdateBody<'a> {
            hashes: &'a [String],
            algorithm: &'a str,
            loaders: Vec<&'a str>,
            game_versions: Vec<&'a str>,
            // 字段可选：不过滤时整个不出现，而不是发一个空数组让服务端自行解释。
            #[serde(skip_serializing_if = "Vec::is_empty")]
            version_types: Vec<&'static str>,
        }
        let body = UpdateBody {
            hashes: sha1s,
            algorithm: "sha1",
            loaders: loaders.iter().map(|l| l.modrinth_facet()).collect(),
            game_versions: game_versions.to_vec(),
            version_types: version_types
                .iter()
                .map(|channel| channel.modrinth_name())
                .collect(),
        };
        let url = format!("{}/version_files/update", self.base_url);
        send_json(&self.retry, "modrinth.version_files.update", || {
            self.http.post(url.as_str()).json(&body)
        })
        .await
    }

    /// 按一批工程 id（或 slug）取工程详情，用于给安装计划与卷宗补上工程标题与图标。
    ///
    /// 不存在的 id 不会出现在结果里；空批次不发请求。
    pub async fn projects(&self, ids: &[String]) -> Result<Vec<ModrinthProject>> {
        if ids.is_empty() {
            return Ok(Vec::new());
        }
        let refs: Vec<&str> = ids.iter().map(String::as_str).collect();
        let encoded = json_array(&refs, "modrinth project ids")?;
        let url = format!("{}/projects", self.base_url);
        send_json(&self.retry, "modrinth.projects", || {
            self.http
                .get(url.as_str())
                .query(&[("ids", encoded.as_str())])
        })
        .await
    }
}

/// Modrinth 的加载器标签（`/v2/tag/loader`）。搜索命中的 `categories` 把加载器与分类混在一起，
/// 分类标签只该显示真正的分类，靠这张表把加载器摘出去。
const MODRINTH_LOADER_TAGS: &[&str] = &[
    "babric",
    "bta-babric",
    "bukkit",
    "bungeecord",
    "canvas",
    "datapack",
    "fabric",
    "folia",
    "forge",
    "geyser",
    "iris",
    "java-agent",
    "legacy-fabric",
    "liteloader",
    "minecraft",
    "modloader",
    "neoforge",
    "nilloader",
    "optifine",
    "ornithe",
    "paper",
    "purpur",
    "quilt",
    "rift",
    "spigot",
    "sponge",
    "vanilla",
    "velocity",
    "waterfall",
];

/// 搜索排序索引。没有搜索词时相关度无从谈起，按下载量给出热门结果（与 CurseForge 侧的
/// Popularity 对齐），界面上的排序名不变。
fn search_index(query: &SearchQuery) -> &'static str {
    let no_text = query.query.as_deref().is_none_or(|q| q.trim().is_empty());
    if no_text && query.sort == SortField::Relevance {
        SortField::Downloads.modrinth_index()
    } else {
        query.sort.modrinth_index()
    }
}

/// 构造 Modrinth `facets` 查询串：形如 `[["project_type:mod"],["categories:fabric"],["versions:1.20.1"]]`。
/// 组内为「或」、组间为「与」。加载器与分类都归入 `categories` facet（Modrinth 搜索约定），
/// 但分别成组：分类条件与加载器条件是「与」的关系。
fn build_facets(query: &SearchQuery) -> Result<String> {
    let mut groups: Vec<Vec<String>> = Vec::new();
    groups.push(
        query
            .effective_types()
            .iter()
            .map(|t| format!("project_type:{}", t.modrinth_project_type()))
            .collect(),
    );
    if let Some(category) = &query.category {
        groups.push(vec![format!("categories:{category}")]);
    }
    if !query.loaders.is_empty() {
        groups.push(
            query
                .loaders
                .iter()
                .map(|l| format!("categories:{}", l.modrinth_facet()))
                .collect(),
        );
    }
    if !query.game_versions.is_empty() {
        groups.push(
            query
                .game_versions
                .iter()
                .map(|v| format!("versions:{v}"))
                .collect(),
        );
    }
    serde_json::to_string(&groups).map_err(|source| Error::Json {
        context: "modrinth facets".to_string(),
        source,
    })
}

/// 把字符串切片序列化为 JSON 数组串（Modrinth 的 `loaders` / `game_versions` 查询参数格式）。
fn json_array(values: &[&str], context: &str) -> Result<String> {
    serde_json::to_string(values).map_err(|source| Error::Json {
        context: context.to_string(),
        source,
    })
}

/// `/search` 响应。
#[derive(Debug, Clone, Deserialize)]
pub struct ModrinthSearchResponse {
    /// 命中列表。
    pub hits: Vec<ModrinthHit>,
    /// 本页偏移。
    pub offset: u32,
    /// 本页条数上限。
    pub limit: u32,
    /// 总命中数。
    pub total_hits: u32,
}

/// 单条搜索命中。
#[derive(Debug, Clone, Deserialize)]
pub struct ModrinthHit {
    /// 工程 id。
    pub project_id: String,
    /// 工程 slug。
    #[serde(default)]
    pub slug: Option<String>,
    /// 标题。
    pub title: String,
    /// 简介。
    pub description: String,
    /// 分类/加载器标签。
    #[serde(default)]
    pub categories: Vec<String>,
    /// 工程类型（mod/modpack/...）。
    pub project_type: String,
    /// 下载量。
    pub downloads: u64,
    /// 关注数。
    #[serde(default)]
    pub follows: u64,
    /// 图标 URL。
    #[serde(default)]
    pub icon_url: Option<String>,
    /// 工程所有者的用户名。组织工程这里是组织的所有者。
    pub author: String,
    /// 组织名；个人工程为 `None`。这里是展示名，工程详情的同名字段是组织 id。
    #[serde(default)]
    pub organization: Option<String>,
    /// 更新时间（ISO-8601）。
    pub date_modified: String,
    /// 工程同时属于的全部类型。数据包工程的 `project_type` 写的是 `mod`，只有这里带 `datapack`。
    #[serde(default)]
    pub all_project_types: Vec<String>,
    /// 精选图库图。
    #[serde(default)]
    pub featured_gallery: Option<String>,
    /// 图库图。
    #[serde(default)]
    pub gallery: Vec<String>,
    /// 平台为工程取的主色（`0xRRGGBB`）。
    #[serde(default)]
    pub color: Option<u32>,
}

impl ModrinthHit {
    /// 转成统一命中。`requested` 是本次搜索的类型：工程同时属于多种类型时（常见于同时发布为
    /// Mod 与数据包的工程），取其中被请求的那一种，免得在「数据包」搜索里显示成 Mod。
    pub fn to_search_hit(&self, requested: &[ResourceType]) -> SearchHit {
        let primary = ResourceType::from_modrinth_project_type(&self.project_type);
        let resource_type = if requested.contains(&primary) {
            primary
        } else {
            requested
                .iter()
                .copied()
                .find(|t| {
                    self.all_project_types
                        .iter()
                        .any(|p| p == t.modrinth_project_type())
                })
                .unwrap_or(primary)
        };
        let page_url = self.slug.as_ref().map(|slug| {
            format!(
                "https://modrinth.com/{}/{}",
                resource_type.modrinth_project_type(),
                slug
            )
        });
        let (loaders, categories) = split_modrinth_tags(&self.categories);
        let owner = Some(self.author.clone()).filter(|a| !a.trim().is_empty());
        let organization = self.organization.clone().filter(|o| !o.trim().is_empty());
        SearchHit {
            platform: Platform::Modrinth,
            project_id: self.project_id.clone(),
            slug: self.slug.clone(),
            title: self.title.clone(),
            description: self.description.clone(),
            author: organization.or_else(|| owner.clone()),
            owner,
            downloads: self.downloads,
            follows: Some(self.follows),
            icon_url: self.icon_url.clone(),
            gallery_url: self
                .featured_gallery
                .clone()
                .or_else(|| self.gallery.first().cloned()),
            hue: self.color.and_then(hue_from_rgb),
            categories,
            loaders,
            resource_type,
            date_modified: Some(self.date_modified.clone()),
            page_url,
        }
    }
}

/// 把 Modrinth 的 `categories` 拆成（能认出的加载器，真正的分类）。
pub(crate) fn split_modrinth_tags(tags: &[String]) -> (Vec<ModLoader>, Vec<String>) {
    let mut loaders = Vec::new();
    let mut categories = Vec::new();
    for tag in tags {
        if MODRINTH_LOADER_TAGS.contains(&tag.as_str()) {
            if let Some(loader) = parse_loader_name(tag)
                && !loaders.contains(&loader)
            {
                loaders.push(loader);
            }
        } else {
            categories.push(tag.clone());
        }
    }
    (loaders, categories)
}

/// 团队成员。
#[derive(Debug, Clone, Deserialize)]
pub struct ModrinthTeamMember {
    /// 所属团队 id。
    pub team_id: String,
    /// 用户。
    pub user: ModrinthUser,
    /// 角色名（Owner / Member / 自定义）。
    #[serde(default)]
    pub role: String,
    /// 排序位次，越小越靠前。
    #[serde(default)]
    pub ordering: i64,
}

/// 用户。
#[derive(Debug, Clone, Deserialize)]
pub struct ModrinthUser {
    /// 用户名。
    pub username: String,
}

/// 从团队成员里挑出展示用的作者：角色为 Owner 者优先，否则取排序最前的成员。
pub fn primary_author(members: &[ModrinthTeamMember]) -> Option<String> {
    members
        .iter()
        .find(|m| m.role.eq_ignore_ascii_case("owner"))
        .or_else(|| members.iter().min_by_key(|m| m.ordering))
        .map(|m| m.user.username.clone())
}

/// 组织（`GET /v3/organizations` 的一部分字段）。
#[derive(Debug, Clone, Deserialize)]
pub struct ModrinthOrganization {
    /// 组织 id。
    pub id: String,
    /// 展示名。搜索命中的 `organization` 给的就是它，不是 slug。
    pub name: String,
}

/// 图库图。
#[derive(Debug, Clone, Deserialize)]
pub struct ModrinthGalleryImage {
    /// 图片 URL（平台压缩后的版本）。
    pub url: String,
    /// 是否精选。
    #[serde(default)]
    pub featured: bool,
}

/// 工程详情。
#[derive(Debug, Clone, Deserialize)]
pub struct ModrinthProject {
    /// 工程 id。
    pub id: String,
    /// slug。
    #[serde(default)]
    pub slug: Option<String>,
    /// 标题。
    pub title: String,
    /// 简介。
    pub description: String,
    /// 分类/加载器标签。
    #[serde(default)]
    pub categories: Vec<String>,
    /// 工程类型。
    pub project_type: String,
    /// 下载量。
    pub downloads: u64,
    /// 关注数。
    #[serde(default)]
    pub followers: u64,
    /// 图标 URL。
    #[serde(default)]
    pub icon_url: Option<String>,
    /// 版本 id 列表。
    #[serde(default)]
    pub versions: Vec<String>,
    /// 支持的游戏版本。
    #[serde(default)]
    pub game_versions: Vec<String>,
    /// 支持的加载器。
    #[serde(default)]
    pub loaders: Vec<String>,
    /// 更新时间。
    #[serde(default)]
    pub updated: Option<String>,
    /// 发布时间。
    #[serde(default)]
    pub published: Option<String>,
    /// 介绍正文（Markdown）。
    #[serde(default)]
    pub body: Option<String>,
    /// 团队 id。
    #[serde(default)]
    pub team: Option<String>,
    /// 组织 id；个人工程为 `None`。
    #[serde(default)]
    pub organization: Option<String>,
    /// 图库。
    #[serde(default)]
    pub gallery: Vec<ModrinthGalleryImage>,
    /// 主色（`0xRRGGBB`）。
    #[serde(default)]
    pub color: Option<u32>,
    /// 源码地址。
    #[serde(default)]
    pub source_url: Option<String>,
    /// 问题反馈地址。
    #[serde(default)]
    pub issues_url: Option<String>,
    /// 维基地址。
    #[serde(default)]
    pub wiki_url: Option<String>,
}

impl ModrinthProject {
    /// 工程的资源类型。Modrinth 把数据包工程记为 `mod`，只能从加载器只有 `datapack` 认出来。
    pub fn resource_type(&self) -> ResourceType {
        let primary = ResourceType::from_modrinth_project_type(&self.project_type);
        if primary == ResourceType::Mod
            && !self.loaders.is_empty()
            && self.loaders.iter().all(|l| l == "datapack")
        {
            ResourceType::DataPack
        } else {
            primary
        }
    }
}

/// 版本。
#[derive(Debug, Clone, Deserialize)]
pub struct ModrinthVersion {
    /// 版本 id。
    pub id: String,
    /// 所属工程 id。
    pub project_id: String,
    /// 版本显示名。
    pub name: String,
    /// 版本号串。
    pub version_number: String,
    /// 依赖。
    #[serde(default)]
    pub dependencies: Vec<ModrinthDependency>,
    /// 支持的游戏版本。
    #[serde(default)]
    pub game_versions: Vec<String>,
    /// 发布通道（release/beta/alpha）。
    pub version_type: String,
    /// 支持的加载器。
    #[serde(default)]
    pub loaders: Vec<String>,
    /// 是否精选。
    #[serde(default)]
    pub featured: bool,
    /// 发布时间。
    pub date_published: String,
    /// 下载量。
    #[serde(default)]
    pub downloads: u64,
    /// 文件列表。
    pub files: Vec<ModrinthFile>,
}

impl ModrinthVersion {
    /// 主文件：优先标记为 `primary` 者，否则取第一个。
    pub fn primary_file(&self) -> Option<&ModrinthFile> {
        self.files
            .iter()
            .find(|f| f.primary)
            .or_else(|| self.files.first())
    }

    /// 转成跨平台统一版本视图。
    ///
    /// 一个文件都没有的版本装不了（Modrinth 上确实存在 `files` 为空的历史版本），返回 `None` 让上层
    /// 显式跳过，而不是塞个空文件名往下传——空文件名会一路污染卷宗与磁盘 join。
    pub fn to_version_info(&self) -> Option<ModVersionInfo> {
        let file = self.primary_file()?;
        Some(ModVersionInfo {
            version_id: self.id.clone(),
            project_id: self.project_id.clone(),
            platform: Platform::Modrinth,
            name: self.name.clone(),
            version_number: self.version_number.clone(),
            // 认不出的通道按最不稳定处理：把没见过的通道当正式版推给玩家，比多打一个 alpha 标签危险得多。
            release_channel: ReleaseChannel::from_modrinth(&self.version_type)
                .unwrap_or(ReleaseChannel::Alpha),
            game_versions: self.game_versions.clone(),
            loaders: self
                .loaders
                .iter()
                .filter_map(|name| parse_loader_name(name))
                .collect(),
            file_name: file.filename.clone(),
            file_size: Some(file.size),
            sha1: file.hashes.sha1.clone(),
            download_url: Some(file.url.clone()),
            date_published: self.date_published.clone(),
            dependencies: self
                .dependencies
                .iter()
                .filter_map(|dep| dep.to_mod_dependency())
                .collect(),
        })
    }
}

/// 单个版本的更新日志（`GET /version/{id}` 的一部分字段）。
#[derive(Debug, Clone, Deserialize)]
pub struct ModrinthChangelog {
    /// 版本 id。
    pub id: String,
    /// 所属工程 id。
    pub project_id: String,
    /// 更新日志正文（Markdown）；作者没写时平台给 `null`。
    #[serde(default)]
    pub changelog: Option<String>,
}

/// 版本依赖。
#[derive(Debug, Clone, Deserialize)]
pub struct ModrinthDependency {
    /// 指定的版本 id。
    #[serde(default)]
    pub version_id: Option<String>,
    /// 指定的工程 id。
    #[serde(default)]
    pub project_id: Option<String>,
    /// 指定的文件名。
    #[serde(default)]
    pub file_name: Option<String>,
    /// 依赖类型原始串。
    pub dependency_type: String,
}

impl ModrinthDependency {
    /// 依赖关系（统一模型）；未知类型返回 `None`。
    pub fn kind(&self) -> Option<DependencyKind> {
        DependencyKind::from_modrinth(&self.dependency_type)
    }

    /// 转成跨平台依赖项；未知 `dependency_type` 返回 `None`——判不出是必需还是不兼容时，
    /// 宁可不呈现也不能猜成必需去自动装。
    pub fn to_mod_dependency(&self) -> Option<ModDependency> {
        Some(ModDependency {
            project_id: self.project_id.clone(),
            version_id: self.version_id.clone(),
            kind: self.kind()?,
        })
    }
}

/// 版本文件。
#[derive(Debug, Clone, Deserialize)]
pub struct ModrinthFile {
    /// 各算法哈希。
    pub hashes: ModrinthHashes,
    /// 下载 URL。
    pub url: String,
    /// 文件名。
    pub filename: String,
    /// 是否主文件。
    #[serde(default)]
    pub primary: bool,
    /// 文件大小（字节）。
    pub size: u64,
}

impl ModrinthFile {
    /// 转成下载引擎可执行的任务：带上 sha1 与大小以便下载后强制校验。
    pub fn to_download_task(&self, dest: impl Into<PathBuf>) -> DownloadTask {
        let mut task = DownloadTask::new(self.url.clone(), dest).with_size(self.size);
        if let Some(sha1) = &self.hashes.sha1 {
            task = task.with_sha1(sha1.clone());
        }
        task
    }
}

/// 文件哈希集合。
#[derive(Debug, Clone, Deserialize)]
pub struct ModrinthHashes {
    /// SHA-1（小写十六进制）。
    #[serde(default)]
    pub sha1: Option<String>,
    /// SHA-512。
    #[serde(default)]
    pub sha512: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{ModLoader, SortField};
    use wiremock::matchers::{body_partial_json, method, path, query_param};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    fn client(server: &MockServer) -> ModrinthClient {
        let http = aurora_base::http::build_client().unwrap();
        ModrinthClient::new(http).with_base_url(server.uri())
    }

    #[test]
    fn facets_encodes_type_loader_and_version() {
        let query = SearchQuery::new("sodium")
            .with_loader(ModLoader::Fabric)
            .with_game_version("1.20.1");
        let facets = build_facets(&query).unwrap();
        assert_eq!(
            facets,
            r#"[["project_type:mod"],["categories:fabric"],["versions:1.20.1"]]"#
        );
    }

    #[test]
    fn facets_multi_loader_is_or_group() {
        let query = SearchQuery::default()
            .with_loader(ModLoader::Fabric)
            .with_loader(ModLoader::Quilt);
        let facets = build_facets(&query).unwrap();
        assert_eq!(
            facets,
            r#"[["project_type:mod"],["categories:fabric","categories:quilt"]]"#
        );
    }

    #[test]
    fn facets_without_filters_only_has_project_type() {
        let facets = build_facets(&SearchQuery::default()).unwrap();
        assert_eq!(facets, r#"[["project_type:mod"]]"#);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn search_parses_hits_and_sends_params() {
        let server = MockServer::start().await;
        let body = serde_json::json!({
            "hits": [{
                "project_id": "AANobbMI",
                "slug": "sodium",
                "title": "Sodium",
                "description": "现代化渲染优化",
                "categories": ["optimization", "fabric"],
                "project_type": "mod",
                "downloads": 12345678,
                "follows": 4321,
                "icon_url": "https://cdn.modrinth.com/sodium.png",
                "author": "jellysquid3",
                "date_modified": "2026-01-02T03:04:05Z"
            }],
            "offset": 0,
            "limit": 20,
            "total_hits": 1
        });
        Mock::given(method("GET"))
            .and(path("/search"))
            .and(query_param("index", "downloads"))
            .and(query_param("query", "sodium"))
            .respond_with(ResponseTemplate::new(200).set_body_json(body))
            .mount(&server)
            .await;

        let query = SearchQuery::new("sodium").with_sort(SortField::Downloads);
        let resp = client(&server).search(&query).await.unwrap();
        assert_eq!(resp.total_hits, 1);
        let hit = &resp.hits[0];
        assert_eq!(hit.project_id, "AANobbMI");
        assert_eq!(hit.downloads, 12_345_678);
        assert_eq!(hit.follows, 4321);

        // 统一模型转换：加载器从分类里摘出去。
        let unified = hit.to_search_hit(&[ResourceType::Mod]);
        assert_eq!(unified.platform, Platform::Modrinth);
        assert_eq!(unified.resource_type, ResourceType::Mod);
        assert_eq!(unified.follows, Some(4321));
        assert_eq!(unified.categories, vec!["optimization".to_string()]);
        assert_eq!(unified.loaders, vec![ModLoader::Fabric]);
        assert_eq!(unified.hue, None);
        assert_eq!(unified.gallery_url, None);
        assert_eq!(
            unified.page_url.as_deref(),
            Some("https://modrinth.com/mod/sodium")
        );
    }

    #[test]
    fn facets_carry_multiple_types_and_category_as_separate_groups() {
        let query = SearchQuery::default()
            .with_resource_types(vec![ResourceType::Mod, ResourceType::DataPack])
            .with_category("worldgen")
            .with_loader(ModLoader::Fabric);
        assert_eq!(
            build_facets(&query).unwrap(),
            r#"[["project_type:mod","project_type:datapack"],["categories:worldgen"],["categories:fabric"]]"#
        );
        let all = SearchQuery::default().with_resource_types(Vec::new());
        assert_eq!(
            build_facets(&all).unwrap(),
            r#"[["project_type:mod","project_type:modpack","project_type:resourcepack","project_type:shader","project_type:datapack"]]"#
        );
    }

    #[test]
    fn empty_query_with_relevance_sorts_by_downloads() {
        assert_eq!(search_index(&SearchQuery::default()), "downloads");
        assert_eq!(search_index(&SearchQuery::new("  ")), "downloads");
        assert_eq!(search_index(&SearchQuery::new("sodium")), "relevance");
        assert_eq!(
            search_index(&SearchQuery::default().with_sort(SortField::Updated)),
            "updated"
        );
    }

    fn hit_json(project_type: &str, all: &[&str]) -> ModrinthHit {
        serde_json::from_value(serde_json::json!({
            "project_id": "8oi3bsk5", "slug": "terralith", "title": "Terralith",
            "description": "d", "categories": ["datapack", "fabric", "worldgen", "neoforge"],
            "project_type": project_type, "all_project_types": all,
            "downloads": 10, "follows": 2, "author": "Starmute",
            "date_modified": "2026-10-01T00:00:00Z",
            "gallery": ["https://cdn.modrinth.com/g1.webp", "https://cdn.modrinth.com/g2.webp"],
            "featured_gallery": null, "color": 4996660
        }))
        .unwrap()
    }

    #[test]
    fn datapack_hit_takes_requested_type_from_all_project_types() {
        let hit = hit_json("mod", &["datapack", "mod"]);
        let as_datapack = hit.to_search_hit(&[ResourceType::DataPack]);
        assert_eq!(as_datapack.resource_type, ResourceType::DataPack);
        assert_eq!(
            as_datapack.page_url.as_deref(),
            Some("https://modrinth.com/datapack/terralith")
        );
        // 同时请求了 Mod 时按工程自报的主类型。
        let mixed = hit.to_search_hit(&[ResourceType::Mod, ResourceType::DataPack]);
        assert_eq!(mixed.resource_type, ResourceType::Mod);
        // datapack 是加载器标签，不进分类；能认出的加载器按出现顺序列出。
        assert_eq!(mixed.categories, vec!["worldgen".to_string()]);
        assert_eq!(mixed.loaders, vec![ModLoader::Fabric, ModLoader::NeoForge]);
        assert_eq!(
            mixed.gallery_url.as_deref(),
            Some("https://cdn.modrinth.com/g1.webp")
        );
        assert_eq!(mixed.hue, Some(25));
    }

    #[test]
    fn primary_author_prefers_owner_then_ordering() {
        let member = |name: &str, role: &str, ordering: i64| ModrinthTeamMember {
            team_id: "t".into(),
            user: ModrinthUser {
                username: name.into(),
            },
            role: role.into(),
            ordering,
        };
        assert_eq!(
            primary_author(&[member("a", "Member", 0), member("b", "Owner", 5)]).as_deref(),
            Some("b")
        );
        assert_eq!(
            primary_author(&[member("a", "Member", 3), member("c", "Member", 1)]).as_deref(),
            Some("c")
        );
        assert_eq!(primary_author(&[]), None);
    }

    /// 结构取自 `/v2/search` 的实际响应：组织工程的 `author` 是组织的所有者，组织名另在 `organization`。
    #[test]
    fn organization_hit_displays_organization() {
        let hit: ModrinthHit = serde_json::from_value(serde_json::json!({
            "project_id": "AANobbMI", "project_type": "mod", "all_project_types": ["mod"],
            "slug": "sodium", "author": "jellysquid3", "author_id": "TEZXhE2U",
            "organization": "CaffeineMC", "organization_id": "LjcZDkRW", "title": "Sodium",
            "description": "d", "downloads": 258125185, "follows": 42362,
            "date_modified": "2026-10-15T17:51:36.063140+00:00"
        }))
        .unwrap();
        let unified = hit.to_search_hit(&[ResourceType::Mod]);
        assert_eq!(unified.author.as_deref(), Some("CaffeineMC"));
        assert_eq!(unified.owner.as_deref(), Some("jellysquid3"));
    }

    /// 个人工程的 `organization` 是 null，作者就是所有者。
    #[test]
    fn personal_hit_displays_owner() {
        let hit: ModrinthHit = serde_json::from_value(serde_json::json!({
            "project_id": "PtjYWJkn", "project_type": "mod", "all_project_types": ["mod"],
            "slug": "sodium-extra", "author": "FlashyReese", "author_id": "QXAY01zS",
            "organization": null, "organization_id": null, "title": "Sodium Extra",
            "description": "d", "downloads": 1, "follows": 1,
            "date_modified": "2026-10-15T17:51:36.063140+00:00"
        }))
        .unwrap();
        let unified = hit.to_search_hit(&[ResourceType::Mod]);
        assert_eq!(unified.author.as_deref(), Some("FlashyReese"));
        assert_eq!(unified.owner.as_deref(), Some("FlashyReese"));

        // 组织名是空白时不能盖掉所有者，否则卡片上作者一栏是空的。
        let blank_org = ModrinthHit {
            organization: Some("  ".to_owned()),
            ..hit
        };
        let unified = blank_org.to_search_hit(&[ResourceType::Mod]);
        assert_eq!(unified.author.as_deref(), Some("FlashyReese"));
    }

    /// 组织只有 v3 路由：根地址是 `/v2` 时换成同级的 `/v3`，一批 id 一次请求，查不到的 id 不在结果里。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn organizations_batch_lands_on_v3_next_to_v2_root() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/v3/organizations"))
            .and(query_param("ids", r#"["LjcZDkRW","missing1"]"#))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!([
                {"id": "LjcZDkRW", "slug": "caffeinemc", "name": "CaffeineMC", "team_id": "UeUe8L5g"}
            ])))
            .expect(1)
            .mount(&server)
            .await;

        let http = aurora_base::http::build_client().unwrap();
        let client = ModrinthClient::new(http).with_base_url(format!("{}/v2", server.uri()));
        let got = client
            .organizations(&["LjcZDkRW".to_owned(), "missing1".to_owned()])
            .await
            .unwrap();

        assert_eq!(got.len(), 1);
        assert_eq!(got[0].id, "LjcZDkRW");
        assert_eq!(got[0].name, "CaffeineMC");
    }

    #[test]
    fn project_with_only_datapack_loader_is_a_datapack() {
        let project = |loaders: &[&str]| -> ModrinthProject {
            serde_json::from_value(serde_json::json!({
                "id": "p", "title": "t", "description": "d", "project_type": "mod",
                "downloads": 1, "loaders": loaders
            }))
            .unwrap()
        };
        assert_eq!(
            project(&["datapack"]).resource_type(),
            ResourceType::DataPack
        );
        assert_eq!(
            project(&["datapack", "fabric"]).resource_type(),
            ResourceType::Mod
        );
        assert_eq!(project(&[]).resource_type(), ResourceType::Mod);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn version_maps_404_to_none() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/version/deadbeef"))
            .respond_with(ResponseTemplate::new(404))
            .mount(&server)
            .await;
        let got = client(&server).version("deadbeef").await.unwrap();
        assert!(got.is_none());
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn version_client_error_bubbles_instead_of_none() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/version/boom"))
            .respond_with(ResponseTemplate::new(400))
            .mount(&server)
            .await;
        let err = client(&server).version("boom").await.unwrap_err();
        assert!(matches!(err, Error::Status { status: 400, .. }));
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn version_parses_version_and_primary_file() {
        let server = MockServer::start().await;
        let body = serde_json::json!({
            "id": "IZskiJmZ",
            "project_id": "AANobbMI",
            "name": "Sodium 0.5.3",
            "version_number": "mc1.20.1-0.5.3",
            "dependencies": [{
                "project_id": "P7dR8mSH",
                "dependency_type": "required"
            }],
            "game_versions": ["1.20.1"],
            "version_type": "release",
            "loaders": ["fabric"],
            "featured": true,
            "date_published": "2026-01-02T03:04:05Z",
            "downloads": 999,
            "files": [
                { "hashes": {"sha1": "aabbcc"}, "url": "https://cdn/other.jar", "filename": "other.jar", "primary": false, "size": 10 },
                { "hashes": {"sha1": "ddeeff", "sha512": "long"}, "url": "https://cdn/sodium.jar", "filename": "sodium.jar", "primary": true, "size": 204800 }
            ]
        });
        Mock::given(method("GET"))
            .and(path("/version/IZskiJmZ"))
            .respond_with(ResponseTemplate::new(200).set_body_json(body))
            .mount(&server)
            .await;

        let version = client(&server)
            .version("IZskiJmZ")
            .await
            .unwrap()
            .expect("应命中版本");
        assert_eq!(version.version_number, "mc1.20.1-0.5.3");
        assert_eq!(
            version.dependencies[0].kind(),
            Some(DependencyKind::Required)
        );

        // 主文件选取「primary=true」那个，转下载任务时带上 sha1 与大小。
        let primary = version.primary_file().unwrap();
        assert_eq!(primary.filename, "sodium.jar");
        let task = primary.to_download_task("C:/mods/sodium.jar");
        assert_eq!(task.url, "https://cdn/sodium.jar");
        assert_eq!(task.sha1.as_deref(), Some("ddeeff"));
        assert_eq!(task.size, Some(204800));

        // 统一视图里的直链就是主文件的 url，安装不必再回平台取一次。
        let info = version.to_version_info().unwrap();
        assert_eq!(info.download_url.as_deref(), Some("https://cdn/sodium.jar"));
    }

    /// 批量反查：一次 POST 带走整批 SHA-1，响应按哈希索引，未收录的哈希不在结果里。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn versions_by_hashes_posts_one_batch_and_maps_by_hash() {
        let server = MockServer::start().await;
        let body = serde_json::json!({
            "hash-a": {
                "id": "verA",
                "project_id": "AANobbMI",
                "name": "Sodium 0.6.5",
                "version_number": "0.6.5",
                "version_type": "release",
                "date_published": "2026-03-04T05:06:07Z",
                "files": [{ "hashes": {"sha1": "hash-a"}, "url": "https://cdn/a.jar", "filename": "a.jar", "primary": true, "size": 1 }]
            }
        });
        Mock::given(method("POST"))
            .and(path("/version_files"))
            .and(body_partial_json(serde_json::json!({
                "hashes": ["hash-a", "hash-b"],
                "algorithm": "sha1"
            })))
            .respond_with(ResponseTemplate::new(200).set_body_json(body))
            .expect(1)
            .mount(&server)
            .await;

        let hashes = vec!["hash-a".to_owned(), "hash-b".to_owned()];
        let got = client(&server).versions_by_hashes(&hashes).await.unwrap();
        assert_eq!(got.len(), 1);
        assert_eq!(got["hash-a"].id, "verA");
        assert!(!got.contains_key("hash-b"));
    }

    /// 批量查更新：一次请求带走整批哈希与实例条件，没更新的哈希不出现在结果里（缺键即无更新）。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn latest_versions_by_hashes_posts_batch_and_maps_by_hash() {
        let server = MockServer::start().await;
        let body = serde_json::json!({
            "hash-a": {
                "id": "newA",
                "project_id": "AANobbMI",
                "name": "Sodium 0.6.5",
                "version_number": "mc1.21.1-0.6.5",
                "dependencies": [],
                "game_versions": ["1.21.1"],
                "version_type": "release",
                "loaders": ["fabric"],
                "featured": true,
                "date_published": "2026-03-04T05:06:07Z",
                "downloads": 1,
                "files": [{ "hashes": {"sha1": "n1"}, "url": "https://cdn/a.jar", "filename": "a.jar", "primary": true, "size": 1 }]
            }
        });
        Mock::given(method("POST"))
            .and(path("/version_files/update"))
            .and(body_partial_json(serde_json::json!({
                "hashes": ["hash-a", "hash-b"],
                "algorithm": "sha1",
                "loaders": ["neoforge"],
                "game_versions": ["1.21.1"]
            })))
            .respond_with(ResponseTemplate::new(200).set_body_json(body))
            .expect(1)
            .mount(&server)
            .await;

        let hashes = vec!["hash-a".to_owned(), "hash-b".to_owned()];
        let got = client(&server)
            .latest_versions_by_hashes(&hashes, &[ModLoader::NeoForge], &["1.21.1"], &[])
            .await
            .unwrap();

        assert_eq!(got.len(), 1);
        assert_eq!(got["hash-a"].version_number, "mc1.21.1-0.6.5");
        // hash-b 服务端没返回，视为「无更新」而不是查询失败。
        assert!(!got.contains_key("hash-b"));
    }

    /// 发布通道过滤下推给服务端：请求体的 version_types 恰为给定通道的 Modrinth 名，顺序照给定顺序。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn latest_versions_by_hashes_sends_version_types_when_given() {
        for (channels, expected) in [
            (
                vec![ReleaseChannel::Release],
                serde_json::json!(["release"]),
            ),
            (
                vec![ReleaseChannel::Release, ReleaseChannel::Beta],
                serde_json::json!(["release", "beta"]),
            ),
        ] {
            let server = MockServer::start().await;
            Mock::given(method("POST"))
                .and(path("/version_files/update"))
                .and(body_partial_json(serde_json::json!({
                    "hashes": ["hash-a"],
                    "version_types": expected.clone()
                })))
                .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({})))
                .expect(1)
                .mount(&server)
                .await;

            let got = client(&server)
                .latest_versions_by_hashes(
                    &["hash-a".to_owned()],
                    &[ModLoader::Fabric],
                    &["1.21.1"],
                    &channels,
                )
                .await
                .unwrap();
            assert!(got.is_empty());
            // body_partial_json 只验包含；数组相等还要再看一遍原文，防止多带了别的通道。
            let requests = server.received_requests().await.unwrap();
            assert_eq!(requests.len(), 1);
            let body: serde_json::Value = serde_json::from_slice(&requests[0].body).unwrap();
            assert_eq!(body["version_types"], expected);
        }
    }

    /// 不过滤通道时请求体里不出现 version_types 这个键。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn latest_versions_by_hashes_omits_version_types_when_empty() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/version_files/update"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({})))
            .expect(1)
            .mount(&server)
            .await;

        client(&server)
            .latest_versions_by_hashes(
                &["hash-a".to_owned()],
                &[ModLoader::Fabric],
                &["1.21.1"],
                &[],
            )
            .await
            .unwrap();
        let requests = server.received_requests().await.unwrap();
        let body: serde_json::Value = serde_json::from_slice(&requests[0].body).unwrap();
        let keys: Vec<&str> = body
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect();
        assert!(!keys.contains(&"version_types"), "请求体：{body}");
        assert_eq!(body["hashes"], serde_json::json!(["hash-a"]));
        assert_eq!(body["loaders"], serde_json::json!(["fabric"]));
    }

    /// 单版本更新日志：打 /version/{id}，取回 Markdown 正文；版本不存在为 None；各只请求一次。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn version_changelog_reads_body_and_maps_404_to_none() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/version/IZskiJmZ"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "id": "IZskiJmZ",
                "project_id": "AANobbMI",
                "name": "Sodium 0.5.3",
                "changelog": "## 0.5.3\n- 修复渲染错误\n- 提升帧率",
                "version_type": "release"
            })))
            .expect(1)
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path("/version/ghost"))
            .respond_with(ResponseTemplate::new(404))
            .expect(1)
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path("/version/nolog"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "id": "nolog",
                "project_id": "AANobbMI",
                "changelog": null
            })))
            .expect(1)
            .mount(&server)
            .await;

        let c = client(&server);
        let got = c
            .version_changelog("IZskiJmZ")
            .await
            .unwrap()
            .expect("应命中版本");
        assert_eq!(got.id, "IZskiJmZ");
        assert_eq!(got.project_id, "AANobbMI");
        assert_eq!(
            got.changelog.as_deref(),
            Some("## 0.5.3\n- 修复渲染错误\n- 提升帧率")
        );
        assert!(c.version_changelog("ghost").await.unwrap().is_none());
        let empty = c.version_changelog("nolog").await.unwrap().unwrap();
        assert_eq!(empty.changelog, None);
        assert_eq!(server.received_requests().await.unwrap().len(), 3);
    }

    /// 空批次直接短路，不打网络请求。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn empty_batches_skip_the_request() {
        let server = MockServer::start().await;
        let c = client(&server);
        assert!(
            c.latest_versions_by_hashes(
                &[],
                &[ModLoader::Fabric],
                &["1.21.1"],
                &[ReleaseChannel::Release]
            )
            .await
            .unwrap()
            .is_empty()
        );
        assert!(c.versions_by_hashes(&[]).await.unwrap().is_empty());
        assert!(c.projects(&[]).await.unwrap().is_empty());
        assert!(c.organizations(&[]).await.unwrap().is_empty());
        assert!(server.received_requests().await.unwrap().is_empty());
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn projects_sends_ids_as_json_array() {
        let server = MockServer::start().await;
        let body = serde_json::json!([{
            "id": "AANobbMI",
            "slug": "sodium",
            "title": "Sodium",
            "description": "渲染优化",
            "project_type": "mod",
            "downloads": 5,
            "icon_url": "https://cdn.modrinth.com/sodium.png"
        }]);
        Mock::given(method("GET"))
            .and(path("/projects"))
            .and(query_param("ids", r#"["AANobbMI","P7dR8mSH"]"#))
            .respond_with(ResponseTemplate::new(200).set_body_json(body))
            .expect(1)
            .mount(&server)
            .await;

        let ids = vec!["AANobbMI".to_owned(), "P7dR8mSH".to_owned()];
        let got = client(&server).projects(&ids).await.unwrap();
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].title, "Sodium");
        assert_eq!(
            got[0].icon_url.as_deref(),
            Some("https://cdn.modrinth.com/sodium.png")
        );
    }

    /// 造一个版本裸模型，便于各转换用例改单个字段。
    fn version_json(
        version_type: &str,
        loaders: serde_json::Value,
        files: serde_json::Value,
    ) -> ModrinthVersion {
        serde_json::from_value(serde_json::json!({
            "id": "IZskiJmZ",
            "project_id": "AANobbMI",
            "name": "Sodium 0.5.3",
            "version_number": "mc1.20.1-0.5.3",
            "dependencies": [
                {"project_id": "P7dR8mSH", "dependency_type": "required"},
                {"project_id": "aaa", "version_id": "bbb", "dependency_type": "optional"},
                {"project_id": "ccc", "dependency_type": "外星依赖类型"}
            ],
            "game_versions": ["1.20.1", "1.20.2"],
            "version_type": version_type,
            "loaders": loaders,
            "date_published": "2026-01-02T03:04:05Z",
            "files": files
        }))
        .unwrap()
    }

    #[test]
    fn version_info_maps_channel_loaders_and_primary_file() {
        let version = version_json(
            "beta",
            serde_json::json!(["fabric", "quilt", "rift"]),
            serde_json::json!([
                { "hashes": {"sha1": "aabbcc"}, "url": "https://cdn/other.jar", "filename": "other.jar", "primary": false, "size": 10 },
                { "hashes": {"sha1": "ddeeff"}, "url": "https://cdn/sodium.jar", "filename": "sodium.jar", "primary": true, "size": 204800 }
            ]),
        );
        let info = version.to_version_info().expect("有文件应能转换");
        assert_eq!(info.version_id, "IZskiJmZ");
        assert_eq!(info.project_id, "AANobbMI");
        assert_eq!(info.platform, Platform::Modrinth);
        assert_eq!(info.version_number, "mc1.20.1-0.5.3");
        assert_eq!(info.release_channel, ReleaseChannel::Beta);
        assert_eq!(info.game_versions, vec!["1.20.1", "1.20.2"]);
        // "rift" 认不出，丢弃而非报错。
        assert_eq!(info.loaders, vec![ModLoader::Fabric, ModLoader::Quilt]);
        assert_eq!(info.file_name, "sodium.jar");
        assert_eq!(info.file_size, Some(204_800));
        assert_eq!(info.sha1.as_deref(), Some("ddeeff"));
        assert_eq!(info.download_url.as_deref(), Some("https://cdn/sodium.jar"));
        assert_eq!(info.date_published, "2026-01-02T03:04:05Z");

        // 三条依赖里未知类型那条被丢，剩两条保留原样。
        assert_eq!(info.dependencies.len(), 2);
        assert_eq!(info.dependencies[0].project_id.as_deref(), Some("P7dR8mSH"));
        assert_eq!(info.dependencies[0].version_id, None);
        assert_eq!(info.dependencies[0].kind, DependencyKind::Required);
        assert_eq!(info.dependencies[1].version_id.as_deref(), Some("bbb"));
        assert_eq!(info.dependencies[1].kind, DependencyKind::Optional);
    }

    #[test]
    fn version_info_falls_back_to_alpha_for_unknown_channel() {
        let version = version_json(
            "某种新通道",
            serde_json::json!(["forge"]),
            serde_json::json!([
                { "hashes": {"sha1": "aa"}, "url": "https://cdn/a.jar", "filename": "a.jar", "primary": true, "size": 1 }
            ]),
        );
        let info = version.to_version_info().unwrap();
        assert_eq!(info.release_channel, ReleaseChannel::Alpha);
        assert_eq!(info.loaders, vec![ModLoader::Forge]);
    }

    #[test]
    fn version_without_files_has_no_version_info() {
        let version = version_json(
            "release",
            serde_json::json!(["fabric"]),
            serde_json::json!([]),
        );
        assert!(version.to_version_info().is_none());
    }

    #[test]
    fn version_info_without_primary_flag_takes_first_file() {
        let version = version_json(
            "release",
            serde_json::json!(["fabric"]),
            serde_json::json!([
                { "hashes": {}, "url": "https://cdn/first.jar", "filename": "first.jar", "size": 7 },
                { "hashes": {"sha1": "zz"}, "url": "https://cdn/second.jar", "filename": "second.jar", "size": 8 }
            ]),
        );
        let info = version.to_version_info().unwrap();
        assert_eq!(info.file_name, "first.jar");
        assert_eq!(info.file_size, Some(7));
        // 该文件没给 sha1，不能伪造一个空串。
        assert_eq!(info.sha1, None);
    }
}
