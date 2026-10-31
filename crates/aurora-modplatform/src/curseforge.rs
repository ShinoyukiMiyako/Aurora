//! CurseForge v1 客户端（api.curseforge.com/v1）。
//!
//! 覆盖搜索、工程详情、文件列表、按指纹匹配、取文件下载直链。CurseForge 强制 `x-api-key` 头，
//! key 经构造函数注入，或由 [`CurseForgeClient::from_env`] 依次取运行期环境变量与构建期内嵌的
//! `AURORA_CURSEFORGE_API_KEY`；都没有时构造直接失败（[`Error::CurseForgeKeyMissing`]），该源被明确
//! 禁用而非静默降级。远端地址经 `base_url` 注入以走 mock。

use std::collections::HashSet;
use std::path::PathBuf;

use aurora_base::retry::RetryPolicy;
use aurora_download::DownloadTask;
use serde::Deserialize;

use crate::error::{Error, Result};
use crate::model::{DependencyKind, ModLoader, Platform, ResourceType, SearchHit, SearchQuery};
use crate::net::send_json;
use crate::version::{ModDependency, ModVersionInfo, ReleaseChannel, parse_loader_name};

/// CurseForge v1 API 根地址（路径含 `/v1` 段，由各方法拼接）。
pub const CURSEFORGE_BASE: &str = "https://api.curseforge.com";

/// CurseForge Minecraft 的 gameId。
pub const MINECRAFT_GAME_ID: u32 = 432;

/// 环境变量名：CurseForge API key。
pub const API_KEY_ENV: &str = "AURORA_CURSEFORGE_API_KEY";

/// 文件列表一页的条数。官方文档写明 `pageSize` 的默认值与上限都是 50。
pub const MOD_FILES_PAGE_SIZE: u32 = 50;

/// 文件列表最多翻这么多页。文件上千的工程翻到底要几十个请求，版本下拉与落位判定用不着那么老的文件；
/// 翻到上限还没完时结果标明截断（[`CurseForgeFileList::truncated`]）。
pub const MOD_FILES_MAX_PAGES: u32 = 10;

// 官方文档：分页参数须满足 index + pageSize <= 10000，超出的请求会被拒。
const _: () = assert!(MOD_FILES_MAX_PAGES * MOD_FILES_PAGE_SIZE <= 10_000);

/// CurseForge v1 客户端。
#[derive(Debug, Clone)]
pub struct CurseForgeClient {
    http: reqwest::Client,
    base_url: String,
    api_key: String,
    retry: RetryPolicy,
}

impl CurseForgeClient {
    /// 用共享 HTTP 客户端与 API key 构造，指向官方地址。
    pub fn new(http: reqwest::Client, api_key: impl Into<String>) -> Self {
        Self {
            http,
            base_url: CURSEFORGE_BASE.to_string(),
            api_key: api_key.into(),
            retry: RetryPolicy::default(),
        }
    }

    /// 取 key 构造：运行期环境变量 `AURORA_CURSEFORGE_API_KEY` 优先（开发与自行构建时用），
    /// 其次是构建时经同名环境变量内嵌进二进制的 key（发行版用户机器上没有这个变量，只能靠内嵌）。
    /// 两处都缺失或空白返回 [`Error::CurseForgeKeyMissing`]。
    pub fn from_env(http: reqwest::Client) -> Result<Self> {
        let key = resolve_api_key(
            std::env::var(API_KEY_ENV).ok(),
            option_env!("AURORA_CURSEFORGE_API_KEY"),
        )?;
        Ok(Self::new(http, key))
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

    fn get(&self, url: &str) -> reqwest::RequestBuilder {
        self.http
            .get(url)
            .header("x-api-key", self.api_key.as_str())
    }

    fn post(&self, url: &str) -> reqwest::RequestBuilder {
        self.http
            .post(url)
            .header("x-api-key", self.api_key.as_str())
    }

    /// 按 [`search_plan`] 搜索工程。CurseForge 单次仅支持一个加载器与一个游戏版本，故取查询列表首项。
    ///
    /// 多类型搜索不带 classId，CurseForge 会把世界、附加包等发现页不收的 class 一并返回，这里不筛，
    /// 由调用方按 [`CurseForgeSearchPlan::accepts`] 过滤（被筛掉的条目仍计入分页偏移）。
    pub async fn search(
        &self,
        query: &SearchQuery,
        plan: &CurseForgeSearchPlan,
    ) -> Result<CurseForgeSearchResponse> {
        let params = build_search_params(query, plan);
        let url = format!("{}/v1/mods/search", self.base_url);
        send_json(&self.retry, "curseforge.search", || {
            self.get(url.as_str()).query(&params)
        })
        .await
    }

    /// 取工程详情。
    pub async fn get_mod(&self, mod_id: u32) -> Result<CurseForgeMod> {
        let url = format!("{}/v1/mods/{}", self.base_url, mod_id);
        let envelope: Envelope<CurseForgeMod> =
            send_json(&self.retry, "curseforge.get_mod", || self.get(url.as_str())).await?;
        Ok(envelope.data)
    }

    /// 批量取工程详情（一次请求）。空批次不发请求。
    pub async fn get_mods(&self, mod_ids: &[u32]) -> Result<Vec<CurseForgeMod>> {
        if mod_ids.is_empty() {
            return Ok(Vec::new());
        }
        #[derive(serde::Serialize)]
        #[serde(rename_all = "camelCase")]
        struct Body<'a> {
            mod_ids: &'a [u32],
        }
        let body = Body { mod_ids };
        let url = format!("{}/v1/mods", self.base_url);
        let envelope: ListEnvelope<CurseForgeMod> =
            send_json(&self.retry, "curseforge.get_mods", || {
                self.post(url.as_str()).json(&body)
            })
            .await?;
        Ok(envelope.data)
    }

    /// 工程介绍正文（HTML）。
    pub async fn mod_description(&self, mod_id: u32) -> Result<String> {
        let url = format!("{}/v1/mods/{}/description", self.base_url, mod_id);
        let envelope: Envelope<String> =
            send_json(&self.retry, "curseforge.mod_description", || {
                self.get(url.as_str())
            })
            .await?;
        Ok(envelope.data)
    }

    /// 批量按文件 id 取文件（一次请求）；整合包清单只给文件 id，下载地址与大小要靠它补全。
    pub async fn get_files(&self, file_ids: &[u32]) -> Result<Vec<CurseForgeFile>> {
        if file_ids.is_empty() {
            return Ok(Vec::new());
        }
        #[derive(serde::Serialize)]
        #[serde(rename_all = "camelCase")]
        struct Body<'a> {
            file_ids: &'a [u32],
        }
        let body = Body { file_ids };
        let url = format!("{}/v1/mods/files", self.base_url);
        let envelope: ListEnvelope<CurseForgeFile> =
            send_json(&self.retry, "curseforge.get_files", || {
                self.post(url.as_str()).json(&body)
            })
            .await?;
        Ok(envelope.data)
    }

    /// 列出工程文件，可按游戏版本与加载器过滤。
    ///
    /// 端点按页给，这里按官方文档的 `index` / `pageSize` 一页页往后翻，直到平台给完：拿到短页或空页，
    /// 或者已取到 `pagination.totalCount` 个。响应没带分页信息时只能凭满页判断后面还有。最多翻
    /// [`MOD_FILES_MAX_PAGES`] 页，翻满还没完就标 `truncated`。翻页期间有新文件发布时，后一页会把
    /// 前一页末尾的文件再给一遍，按文件 id 去重。
    pub async fn mod_files(
        &self,
        mod_id: u32,
        loader: Option<crate::model::ModLoader>,
        game_version: Option<&str>,
    ) -> Result<CurseForgeFileList> {
        let mut filters: Vec<(&str, String)> = Vec::new();
        if let Some(version) = game_version {
            filters.push(("gameVersion", version.to_string()));
        }
        if let Some(loader) = loader {
            filters.push(("modLoaderType", loader.curseforge_loader_type().to_string()));
        }
        let url = format!("{}/v1/mods/{}/files", self.base_url, mod_id);
        let mut files = Vec::new();
        let mut seen = HashSet::new();
        let mut index: u64 = 0;
        for _ in 0..MOD_FILES_MAX_PAGES {
            let mut params = filters.clone();
            params.push(("index", index.to_string()));
            params.push(("pageSize", MOD_FILES_PAGE_SIZE.to_string()));
            let envelope: ListEnvelope<CurseForgeFile> =
                send_json(&self.retry, "curseforge.mod_files", || {
                    self.get(url.as_str()).query(&params)
                })
                .await?;
            let fetched = u64::try_from(envelope.data.len()).expect("一页的文件数放得进 u64");
            index += fetched;
            let more = fetched > 0
                && match &envelope.pagination {
                    Some(pagination) => index < pagination.total_count,
                    None => fetched >= u64::from(MOD_FILES_PAGE_SIZE),
                };
            files.extend(
                envelope
                    .data
                    .into_iter()
                    .filter(|file| seen.insert(file.id)),
            );
            if !more {
                return Ok(CurseForgeFileList {
                    files,
                    truncated: false,
                });
            }
        }
        tracing::info!(
            mod_id,
            fetched = index,
            "CurseForge 文件列表翻到页数上限还没完，结果截断"
        );
        Ok(CurseForgeFileList {
            files,
            truncated: true,
        })
    }

    /// 按 fileId 取单个文件；工程或文件在平台上不存在返回 `None`。
    ///
    /// 文件列表端点是分页的、最多翻到页数上限，文件多的大 Mod 目标文件未必在翻到的页里；安装与钉版本
    /// 依赖只认一个确定的 fileId，直接走单文件端点既省请求又不会因分页误报「版本不存在」。
    pub async fn mod_file(&self, mod_id: u32, file_id: u32) -> Result<Option<CurseForgeFile>> {
        let url = format!("{}/v1/mods/{}/files/{}", self.base_url, mod_id, file_id);
        let result: Result<Envelope<CurseForgeFile>> =
            send_json(&self.retry, "curseforge.mod_file", || {
                self.get(url.as_str())
            })
            .await;
        match result {
            Ok(envelope) => Ok(Some(envelope.data)),
            Err(Error::Status { status: 404, .. }) => Ok(None),
            Err(err) => Err(err),
        }
    }

    /// 按一批 modId 取工程详情，用于给安装计划与卷宗补上工程标题与图标。空批次不发请求。
    pub async fn mods(&self, mod_ids: &[u32]) -> Result<Vec<CurseForgeMod>> {
        if mod_ids.is_empty() {
            return Ok(Vec::new());
        }
        #[derive(serde::Serialize)]
        #[serde(rename_all = "camelCase")]
        struct Body<'a> {
            mod_ids: &'a [u32],
        }
        let body = Body { mod_ids };
        let url = format!("{}/v1/mods", self.base_url);
        let envelope: Envelope<Vec<CurseForgeMod>> =
            send_json(&self.retry, "curseforge.mods", || {
                self.post(url.as_str()).json(&body)
            })
            .await?;
        Ok(envelope.data)
    }
    /// 按指纹批量匹配本地文件所属工程，返回精确匹配。
    pub async fn fingerprint_matches(
        &self,
        fingerprints: &[u32],
    ) -> Result<Vec<CurseForgeFingerprintMatch>> {
        #[derive(serde::Serialize)]
        struct Body<'a> {
            fingerprints: &'a [u32],
        }
        let body = Body { fingerprints };
        let url = format!("{}/v1/fingerprints", self.base_url);
        let envelope: Envelope<CurseForgeFingerprintResult> =
            send_json(&self.retry, "curseforge.fingerprints", || {
                self.post(url.as_str()).json(&body)
            })
            .await?;
        Ok(envelope.data.exact_matches)
    }

    /// 取某文件的下载直链（文件对象里 `downloadUrl` 可能为空时的兜底）。
    pub async fn file_download_url(&self, mod_id: u32, file_id: u32) -> Result<String> {
        let url = format!(
            "{}/v1/mods/{}/files/{}/download-url",
            self.base_url, mod_id, file_id
        );
        let envelope: Envelope<String> = send_json(&self.retry, "curseforge.download_url", || {
            self.get(url.as_str())
        })
        .await?;
        Ok(envelope.data)
    }
}

/// 校验从环境读到的 key 值：为空或纯空白视为未配置。抽出纯函数便于单测（不触碰进程级环境）。
fn key_from_env_value(value: Option<String>) -> Result<String> {
    match value {
        Some(key) if !key.trim().is_empty() => Ok(key),
        _ => Err(Error::CurseForgeKeyMissing),
    }
}

/// 运行期的值优先，构建期内嵌的值兜底；两者都缺失或空白即未配置。
fn resolve_api_key(runtime: Option<String>, embedded: Option<&str>) -> Result<String> {
    key_from_env_value(runtime).or_else(|_| key_from_env_value(embedded.map(str::to_owned)))
}

/// CurseForge 单次搜索请求的分类参数。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CurseForgeSearchPlan {
    /// 只搜一种类型时带上它的 classId；多类型时不带（CurseForge 只收单个 classId）。
    pub class_id: Option<u32>,
    /// 分类条件换算出的分类 id（每个 id 只属于一个 class）。
    pub category_ids: Vec<u32>,
    /// 本次请求的类型对应的全部 classId，用于筛掉多类型搜索混进来的其他 class。
    pub accepted_classes: Vec<u32>,
}

impl CurseForgeSearchPlan {
    /// 该命中的 class 是否属于本次请求的类型。
    pub fn accepts(&self, class_id: Option<u32>) -> bool {
        class_id.is_some_and(|id| self.accepted_classes.contains(&id))
    }
}

/// 把统一查询换算成 CurseForge 的分类参数；分类条件在这些类型下都没有同义分类时返回 `None`，
/// 表示该次搜索不该发往 CurseForge（发出去只会得到不带分类过滤的无关结果）。
pub fn search_plan(query: &SearchQuery) -> Option<CurseForgeSearchPlan> {
    let types = query.effective_types();
    let category_ids = match &query.category {
        Some(key) => {
            let ids = crate::category_map::curseforge_categories(&types, key);
            if ids.is_empty() {
                return None;
            }
            ids
        }
        None => Vec::new(),
    };
    let class_id = match types.as_slice() {
        [only] => Some(only.curseforge_class_id()),
        _ => None,
    };
    Some(CurseForgeSearchPlan {
        class_id,
        category_ids,
        accepted_classes: types.iter().map(|t| t.curseforge_class_id()).collect(),
    })
}

/// 组装 `/v1/mods/search` 查询参数。
fn build_search_params(
    query: &SearchQuery,
    plan: &CurseForgeSearchPlan,
) -> Vec<(&'static str, String)> {
    let mut params: Vec<(&'static str, String)> = vec![
        ("gameId", MINECRAFT_GAME_ID.to_string()),
        ("sortField", query.sort.curseforge_sort_field().to_string()),
        ("sortOrder", "desc".to_string()),
        ("index", query.offset.to_string()),
        ("pageSize", query.limit.to_string()),
    ];
    if let Some(class_id) = plan.class_id {
        params.push(("classId", class_id.to_string()));
    }
    match plan.category_ids.as_slice() {
        [] => {}
        [only] => params.push(("categoryId", only.to_string())),
        many => {
            let list: Vec<String> = many.iter().map(u32::to_string).collect();
            params.push(("categoryIds", format!("[{}]", list.join(","))));
        }
    }
    if let Some(text) = query.query.as_deref().filter(|t| !t.trim().is_empty()) {
        params.push(("searchFilter", text.to_string()));
    }
    if let Some(version) = query.game_versions.first() {
        params.push(("gameVersion", version.clone()));
    }
    if let Some(loader) = query.loaders.first() {
        params.push(("modLoaderType", loader.curseforge_loader_type().to_string()));
    }
    params
}

/// 通用 `{ "data": T }` 信封。
#[derive(Debug, Clone, Deserialize)]
struct Envelope<T> {
    data: T,
}

/// 带分页的 `{ "data": [T], "pagination": ... }` 信封。只有翻页的文件列表读 `pagination`，没带时为 `None`。
#[derive(Debug, Clone, Deserialize)]
struct ListEnvelope<T> {
    data: Vec<T>,
    #[serde(default)]
    pagination: Option<CurseForgePagination>,
}

/// 一个工程的文件列表：翻页取齐，或者翻到 [`MOD_FILES_MAX_PAGES`] 页为止。
#[derive(Debug, Clone)]
pub struct CurseForgeFileList {
    /// 各页拼起来的文件，按平台给的先后，同一文件只留第一次出现的那个。
    pub files: Vec<CurseForgeFile>,
    /// 翻到页数上限时平台那边还有没取的文件。
    pub truncated: bool,
}

/// `/v1/mods/search` 响应。
#[derive(Debug, Clone, Deserialize)]
pub struct CurseForgeSearchResponse {
    /// 命中工程列表。
    pub data: Vec<CurseForgeMod>,
    /// 分页信息。
    #[serde(default)]
    pub pagination: Option<CurseForgePagination>,
}

/// 分页信息。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CurseForgePagination {
    /// 首项零基下标。
    pub index: u32,
    /// 请求条数。
    pub page_size: u32,
    /// 实际返回条数。
    pub result_count: u32,
    /// 可用总数。
    pub total_count: u64,
}

/// 工程。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CurseForgeMod {
    /// 数字 id。
    pub id: u32,
    /// 名称。
    pub name: String,
    /// slug。
    pub slug: String,
    /// 简介。
    pub summary: String,
    /// 下载量。
    #[serde(default)]
    pub download_count: u64,
    /// 分类 classId。
    #[serde(default)]
    pub class_id: Option<u32>,
    /// 分类标签。
    #[serde(default)]
    pub categories: Vec<CurseForgeCategory>,
    /// 作者列表。
    #[serde(default)]
    pub authors: Vec<CurseForgeAuthor>,
    /// logo 资源。
    #[serde(default)]
    pub logo: Option<CurseForgeAsset>,
    /// 截图（图库）。
    #[serde(default)]
    pub screenshots: Vec<CurseForgeAsset>,
    /// 最新文件。
    #[serde(default)]
    pub latest_files: Vec<CurseForgeFile>,
    /// 每个（游戏版本，加载器）组合的最新文件索引；加载器与支持版本从这里汇总。
    #[serde(default)]
    pub latest_files_indexes: Vec<CurseForgeFileIndex>,
    /// 相关链接。
    #[serde(default)]
    pub links: Option<CurseForgeLinks>,
    /// 更新时间。
    #[serde(default)]
    pub date_modified: Option<String>,
    /// 创建时间。
    #[serde(default)]
    pub date_created: Option<String>,
    /// 作者是否允许第三方启动器分发文件；为 `false` 时文件没有下载地址，只能去网页手动下载。
    #[serde(default)]
    pub allow_mod_distribution: Option<bool>,
}

impl CurseForgeMod {
    /// 汇总最新文件索引里出现过的加载器（去重，按首次出现顺序）。
    pub fn loaders(&self) -> Vec<ModLoader> {
        let mut loaders = Vec::new();
        for index in &self.latest_files_indexes {
            if let Some(loader) = index
                .mod_loader
                .and_then(ModLoader::from_curseforge_loader_type)
                && !loaders.contains(&loader)
            {
                loaders.push(loader);
            }
        }
        loaders
    }

    /// 汇总最新文件索引里出现过的 MC 版本（去重，按首次出现顺序）。
    pub fn game_versions(&self) -> Vec<String> {
        let mut versions: Vec<String> = Vec::new();
        for index in &self.latest_files_indexes {
            if !versions.contains(&index.game_version) {
                versions.push(index.game_version.clone());
            }
        }
        versions
    }
}

impl From<&CurseForgeMod> for SearchHit {
    fn from(item: &CurseForgeMod) -> Self {
        SearchHit {
            platform: Platform::CurseForge,
            project_id: item.id.to_string(),
            slug: Some(item.slug.clone()),
            title: item.name.clone(),
            description: item.summary.clone(),
            author: item.authors.first().map(|a| a.name.clone()),
            downloads: item.download_count,
            // CurseForge 无「关注数」概念。
            follows: None,
            icon_url: item.logo.as_ref().map(|logo| logo.url.clone()),
            gallery_url: item.screenshots.first().map(|s| s.url.clone()),
            // CurseForge 不给工程主色。
            hue: None,
            categories: item.categories.iter().map(|c| c.name.clone()).collect(),
            loaders: item.loaders(),
            resource_type: ResourceType::from_curseforge_class_id(item.class_id),
            date_modified: item.date_modified.clone(),
            page_url: item.links.as_ref().and_then(|l| l.website_url.clone()),
        }
    }
}

/// 最新文件索引项。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CurseForgeFileIndex {
    /// 游戏版本。
    pub game_version: String,
    /// 文件 id。
    pub file_id: u32,
    /// 文件名。
    #[serde(default)]
    pub filename: Option<String>,
    /// 发布通道编码。
    #[serde(default)]
    pub release_type: Option<u8>,
    /// 加载器编码；不区分加载器的资源（资源包、光影）为空。
    #[serde(default)]
    pub mod_loader: Option<u8>,
}

/// 分类标签。
#[derive(Debug, Clone, Deserialize)]
pub struct CurseForgeCategory {
    /// 分类 id。
    pub id: u32,
    /// 分类名。
    pub name: String,
}

/// 作者。
#[derive(Debug, Clone, Deserialize)]
pub struct CurseForgeAuthor {
    /// 作者 id。
    pub id: u32,
    /// 作者名。
    pub name: String,
}

/// 图片资源。
#[derive(Debug, Clone, Deserialize)]
pub struct CurseForgeAsset {
    /// 资源 URL。
    pub url: String,
}

/// 工程链接。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CurseForgeLinks {
    /// 官网/详情页。
    #[serde(default)]
    pub website_url: Option<String>,
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

/// 文件。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CurseForgeFile {
    /// 文件 id。
    pub id: u32,
    /// 所属工程 id。
    pub mod_id: u32,
    /// 显示名。
    pub display_name: String,
    /// 实际文件名。
    pub file_name: String,
    /// 发布通道编码：1=Release，2=Beta，3=Alpha。老接口/裁剪响应里可能缺失。
    #[serde(default)]
    pub release_type: Option<u8>,
    /// 哈希列表（sha1/md5）。
    #[serde(default)]
    pub hashes: Vec<CurseForgeFileHash>,
    /// 文件时间。
    #[serde(default)]
    pub file_date: Option<String>,
    /// 文件字节数。
    #[serde(default)]
    pub file_length: Option<u64>,
    /// 下载量。
    #[serde(default)]
    pub download_count: u64,
    /// 下载直链（可能为空）。
    #[serde(default)]
    pub download_url: Option<String>,
    /// 适用游戏版本。
    #[serde(default)]
    pub game_versions: Vec<String>,
    /// 依赖。
    #[serde(default)]
    pub dependencies: Vec<CurseForgeFileDependency>,
    /// 文件指纹。
    #[serde(default)]
    pub file_fingerprint: u64,
}

impl CurseForgeFile {
    /// 取 SHA-1（算法编码 1）。
    pub fn sha1(&self) -> Option<&str> {
        self.hashes
            .iter()
            .find(|h| h.algo == 1)
            .map(|h| h.value.as_str())
    }

    /// 转成下载任务；`downloadUrl` 为空时返回 `None`（需先走 [`CurseForgeClient::file_download_url`]）。
    pub fn to_download_task(&self, dest: impl Into<PathBuf>) -> Option<DownloadTask> {
        let url = self.download_url.as_ref()?;
        let mut task = DownloadTask::new(url.clone(), dest);
        if let Some(size) = self.file_length {
            task = task.with_size(size);
        }
        if let Some(sha1) = self.sha1() {
            task = task.with_sha1(sha1.to_string());
        }
        Some(task)
    }
    /// 转成跨平台统一版本视图。
    ///
    /// `fileName` 是必填字段，因此这里恒能转换成功（与 Modrinth 侧可能返回 `None` 不同）。
    pub fn to_version_info(&self) -> ModVersionInfo {
        let (game_versions, loaders) = normalize_curseforge_game_versions(&self.game_versions);
        ModVersionInfo {
            version_id: self.id.to_string(),
            project_id: self.mod_id.to_string(),
            platform: Platform::CurseForge,
            name: self.display_name.clone(),
            // CurseForge 的文件模型没有独立的版本号字段：displayName 是给人看的标题，
            // fileName 才是带版本号的技术串，与 Modrinth 的 version_number 定位一致。
            version_number: self.file_name.clone(),
            // 认不出的通道按最不稳定处理，理由同 Modrinth 侧。
            release_channel: self
                .release_type
                .and_then(ReleaseChannel::from_curseforge)
                .unwrap_or(ReleaseChannel::Alpha),
            game_versions,
            loaders,
            file_name: self.file_name.clone(),
            file_size: self.file_length,
            sha1: self.sha1().map(|value| value.to_string()),
            // 空串与缺失同义：禁止第三方分发的工程两种写法都出现过。
            download_url: self
                .download_url
                .clone()
                .filter(|url| !url.trim().is_empty()),
            // 契约规定缺失为空串：发布时间只用于排序与展示，不参与任何兼容判定。
            date_published: self.file_date.clone().unwrap_or_default(),
            dependencies: self
                .dependencies
                .iter()
                .filter_map(|dep| dep.to_mod_dependency())
                .collect(),
        }
    }
}

/// 文件哈希。
#[derive(Debug, Clone, Deserialize)]
pub struct CurseForgeFileHash {
    /// 哈希值。
    pub value: String,
    /// 算法编码：1=SHA-1，2=MD5。
    pub algo: u8,
}

/// 文件依赖。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CurseForgeFileDependency {
    /// 依赖工程 id。
    pub mod_id: u32,
    /// 关系类型编码。
    pub relation_type: u8,
}

impl CurseForgeFileDependency {
    /// 依赖关系（统一模型）；未知编码返回 `None`。
    pub fn kind(&self) -> Option<DependencyKind> {
        DependencyKind::from_curseforge(self.relation_type)
    }
    /// 转成跨平台依赖项；未知 `relationType` 返回 `None`——判不出关系就不呈现，不能猜成必需。
    pub fn to_mod_dependency(&self) -> Option<ModDependency> {
        Some(ModDependency {
            project_id: Some(self.mod_id.to_string()),
            // CurseForge 的依赖只指到工程，不指定具体文件，版本由依赖解析自行择优。
            version_id: None,
            kind: self.kind()?,
        })
    }
}

/// 把 CurseForge 的 `gameVersions` 拆成「MC 版本」与「加载器」两份。
///
/// CurseForge 把加载器名、客户端/服务端标记、Java 版本全塞进同一个字符串数组，典型形如
/// `["1.20.1", "Forge", "Client", "Java 17"]`。判据分三步：能认出加载器名的归加载器；否则首字符是
/// 数字的归 MC 版本（正式版 `1.20.1`、快照 `24w14a` 都满足，而 `Client` / `Java 17` 都不满足）；
/// 剩下的一律丢弃。加载器结果去重——同一个加载器可能以不同大小写重复出现，去重后 UI 才不会
/// 显示「Forge, Forge」；MC 版本保持原样原序，那是平台给的事实。
pub fn normalize_curseforge_game_versions(raw: &[String]) -> (Vec<String>, Vec<ModLoader>) {
    let mut game_versions = Vec::new();
    let mut loaders: Vec<ModLoader> = Vec::new();
    for tag in raw {
        let tag = tag.trim();
        if tag.is_empty() {
            continue;
        }
        if let Some(loader) = parse_loader_name(tag) {
            if !loaders.contains(&loader) {
                loaders.push(loader);
            }
            continue;
        }
        if tag.starts_with(|c: char| c.is_ascii_digit()) {
            game_versions.push(tag.to_string());
        }
    }
    (game_versions, loaders)
}

/// 指纹匹配结果体。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CurseForgeFingerprintResult {
    #[serde(default)]
    exact_matches: Vec<CurseForgeFingerprintMatch>,
}

/// 单条指纹精确匹配。
#[derive(Debug, Clone, Deserialize)]
pub struct CurseForgeFingerprintMatch {
    /// 匹配到的工程 id。
    pub id: u32,
    /// 匹配到的文件。
    pub file: CurseForgeFile,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::SortField;
    use wiremock::matchers::{body_partial_json, header, method, path, query_param};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    fn client(server: &MockServer) -> CurseForgeClient {
        let http = aurora_base::http::build_client().unwrap();
        CurseForgeClient::new(http, "test-key").with_base_url(server.uri())
    }

    #[test]
    fn key_from_env_value_rejects_empty_and_blank() {
        assert!(matches!(
            key_from_env_value(None),
            Err(Error::CurseForgeKeyMissing)
        ));
        assert!(matches!(
            key_from_env_value(Some(String::new())),
            Err(Error::CurseForgeKeyMissing)
        ));
        assert!(matches!(
            key_from_env_value(Some("   ".to_string())),
            Err(Error::CurseForgeKeyMissing)
        ));
        assert_eq!(key_from_env_value(Some("abc".to_string())).unwrap(), "abc");
    }

    #[test]
    fn search_params_encode_type_loader_version_and_sort() {
        let query = SearchQuery::new("jei")
            .with_loader(ModLoader::Forge)
            .with_game_version("1.20.1")
            .with_sort(SortField::Downloads)
            .with_paging(30, 60);
        let plan = search_plan(&query).unwrap();
        let params = build_search_params(&query, &plan);
        let get = |key: &str| {
            params
                .iter()
                .find(|(k, _)| *k == key)
                .map(|(_, v)| v.as_str())
        };
        assert_eq!(get("gameId"), Some("432"));
        assert_eq!(get("classId"), Some("6"));
        assert_eq!(get("sortField"), Some("6"));
        assert_eq!(get("sortOrder"), Some("desc"));
        assert_eq!(get("index"), Some("60"));
        assert_eq!(get("pageSize"), Some("30"));
        assert_eq!(get("searchFilter"), Some("jei"));
        assert_eq!(get("gameVersion"), Some("1.20.1"));
        assert_eq!(get("modLoaderType"), Some("1"));
        assert_eq!(get("categoryId"), None);
        assert_eq!(get("categoryIds"), None);
    }

    fn params_of(query: &SearchQuery) -> Option<Vec<(&'static str, String)>> {
        search_plan(query).map(|plan| build_search_params(query, &plan))
    }

    fn param<'a>(params: &'a [(&'static str, String)], key: &str) -> Option<&'a str> {
        params
            .iter()
            .find(|(k, _)| *k == key)
            .map(|(_, v)| v.as_str())
    }

    #[test]
    fn single_type_with_category_sends_class_and_category_id() {
        let query = SearchQuery::default()
            .with_resource_type(ResourceType::Shader)
            .with_category("fantasy");
        let params = params_of(&query).unwrap();
        assert_eq!(param(&params, "classId"), Some("6552"));
        assert_eq!(param(&params, "categoryId"), Some("6554"));
        assert_eq!(param(&params, "categoryIds"), None);
        // 没有搜索词时不带 searchFilter，空白搜索词同样不带。
        assert_eq!(param(&params, "searchFilter"), None);
        let blank = params_of(&SearchQuery::new("   ")).unwrap();
        assert_eq!(param(&blank, "searchFilter"), None);
    }

    #[test]
    fn all_types_drop_class_and_union_category_ids() {
        let query = SearchQuery::default()
            .with_resource_types(Vec::new())
            .with_category("technology");
        let plan = search_plan(&query).unwrap();
        assert_eq!(plan.class_id, None);
        assert_eq!(plan.category_ids, vec![412, 4472, 6951]);
        assert_eq!(plan.accepted_classes, vec![6, 4471, 12, 6552, 6945]);
        let params = build_search_params(&query, &plan);
        assert_eq!(param(&params, "classId"), None);
        assert_eq!(param(&params, "categoryIds"), Some("[412,4472,6951]"));
        assert_eq!(param(&params, "categoryId"), None);
        // 世界（17）与插件（5）不在「全部」里。
        assert!(plan.accepts(Some(6945)));
        assert!(!plan.accepts(Some(17)));
        assert!(!plan.accepts(Some(5)));
        assert!(!plan.accepts(None));
    }

    #[test]
    fn unmapped_category_means_curseforge_is_skipped() {
        let query = SearchQuery::default()
            .with_resource_type(ResourceType::ResourcePack)
            .with_category("gui");
        assert_eq!(search_plan(&query), None);
        let unknown = SearchQuery::default().with_category("not-a-category");
        assert_eq!(search_plan(&unknown), None);
    }

    #[test]
    fn runtime_key_wins_and_embedded_key_is_the_fallback() {
        assert_eq!(
            resolve_api_key(Some("runtime".into()), Some("embedded")).unwrap(),
            "runtime"
        );
        assert_eq!(
            resolve_api_key(Some("  ".into()), Some("embedded")).unwrap(),
            "embedded"
        );
        assert_eq!(resolve_api_key(None, Some("embedded")).unwrap(), "embedded");
        assert!(matches!(
            resolve_api_key(None, Some(" ")),
            Err(Error::CurseForgeKeyMissing)
        ));
        assert!(matches!(
            resolve_api_key(None, None),
            Err(Error::CurseForgeKeyMissing)
        ));
    }

    #[test]
    fn mod_summarizes_loaders_and_versions_from_file_indexes() {
        let item: CurseForgeMod = serde_json::from_value(serde_json::json!({
            "id": 1, "name": "n", "slug": "s", "summary": "",
            "latestFilesIndexes": [
                {"gameVersion": "1.20.1", "fileId": 10, "modLoader": 1},
                {"gameVersion": "1.20.1", "fileId": 11, "modLoader": 6},
                {"gameVersion": "1.21.1", "fileId": 12, "modLoader": 6},
                {"gameVersion": "1.21.1", "fileId": 13, "modLoader": null},
                {"gameVersion": "1.19.2", "fileId": 14, "modLoader": 0}
            ],
            "screenshots": [{"url": "https://cf/shot1.png"}, {"url": "https://cf/shot2.png"}]
        }))
        .unwrap();
        assert_eq!(item.loaders(), vec![ModLoader::Forge, ModLoader::NeoForge]);
        assert_eq!(item.game_versions(), vec!["1.20.1", "1.21.1", "1.19.2"]);
        let hit = SearchHit::from(&item);
        assert_eq!(hit.gallery_url.as_deref(), Some("https://cf/shot1.png"));
        assert_eq!(hit.loaders, vec![ModLoader::Forge, ModLoader::NeoForge]);
        assert_eq!(hit.hue, None);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn search_sends_api_key_and_parses_mod() {
        let server = MockServer::start().await;
        let body = serde_json::json!({
            "data": [{
                "id": 238222,
                "name": "Just Enough Items",
                "slug": "jei",
                "summary": "物品/配方查看",
                "downloadCount": 900000000u64,
                "classId": 6,
                "categories": [{"id": 423, "name": "API 与库"}],
                "authors": [{"id": 1, "name": "mezz"}],
                "logo": {"url": "https://cf/jei.png"},
                "links": {"websiteUrl": "https://www.curseforge.com/minecraft/mc-mods/jei"},
                "dateModified": "2026-01-02T03:04:05Z"
            }],
            "pagination": {"index": 0, "pageSize": 20, "resultCount": 1, "totalCount": 1}
        });
        // 只有带正确 x-api-key 才命中；否则 wiremock 回 404。
        Mock::given(method("GET"))
            .and(path("/v1/mods/search"))
            .and(header("x-api-key", "test-key"))
            .and(query_param("gameId", "432"))
            .and(query_param("classId", "6"))
            .respond_with(ResponseTemplate::new(200).set_body_json(body))
            .mount(&server)
            .await;

        let query = SearchQuery::new("jei");
        let resp = client(&server)
            .search(&query, &search_plan(&query).unwrap())
            .await
            .unwrap();
        assert_eq!(resp.data.len(), 1);
        let unified: SearchHit = (&resp.data[0]).into();
        assert_eq!(unified.platform, Platform::CurseForge);
        assert_eq!(unified.project_id, "238222");
        assert_eq!(unified.downloads, 900_000_000);
        assert_eq!(unified.follows, None);
        assert_eq!(unified.author.as_deref(), Some("mezz"));
        assert_eq!(
            unified.page_url.as_deref(),
            Some("https://www.curseforge.com/minecraft/mc-mods/jei")
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn fingerprint_matches_returns_exact_matches() {
        let server = MockServer::start().await;
        let body = serde_json::json!({
            "data": {
                "isCacheBuilt": true,
                "exactMatches": [{
                    "id": 238222,
                    "file": {
                        "id": 5000,
                        "modId": 238222,
                        "displayName": "jei-1.20.1.jar",
                        "fileName": "jei-1.20.1.jar",
                        "hashes": [{"value": "abc123", "algo": 1}, {"value": "md5here", "algo": 2}],
                        "fileLength": 1048576,
                        "downloadUrl": "https://cf/jei-1.20.1.jar",
                        "dependencies": [{"modId": 100, "relationType": 3}],
                        "fileFingerprint": 123456789u64
                    }
                }],
                "exactFingerprints": [123456789u64]
            }
        });
        Mock::given(method("POST"))
            .and(path("/v1/fingerprints"))
            .and(header("x-api-key", "test-key"))
            .respond_with(ResponseTemplate::new(200).set_body_json(body))
            .mount(&server)
            .await;

        let matches = client(&server)
            .fingerprint_matches(&[123456789])
            .await
            .unwrap();
        assert_eq!(matches.len(), 1);
        let m = &matches[0];
        assert_eq!(m.id, 238222);
        assert_eq!(m.file.sha1(), Some("abc123"));
        assert_eq!(
            m.file.dependencies[0].kind(),
            Some(DependencyKind::Required)
        );

        let task = m.file.to_download_task("C:/mods/jei.jar").unwrap();
        assert_eq!(task.url, "https://cf/jei-1.20.1.jar");
        assert_eq!(task.sha1.as_deref(), Some("abc123"));
        assert_eq!(task.size, Some(1_048_576));
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn download_url_endpoint_unwraps_data() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/v1/mods/238222/files/5000/download-url"))
            .and(header("x-api-key", "test-key"))
            .respond_with(
                ResponseTemplate::new(200)
                    .set_body_json(serde_json::json!({"data": "https://cf/edge/jei.jar"})),
            )
            .mount(&server)
            .await;
        let url = client(&server)
            .file_download_url(238222, 5000)
            .await
            .unwrap();
        assert_eq!(url, "https://cf/edge/jei.jar");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn mod_file_fetches_single_file_and_maps_404_to_none() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/v1/mods/238222/files/5001"))
            .and(header("x-api-key", "test-key"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "data": {
                    "id": 5001,
                    "modId": 238222,
                    "displayName": "JEI 15.3.0.4",
                    "fileName": "jei-1.21-15.3.0.4.jar",
                    "releaseType": 2,
                    "hashes": [{"value": "ffee00", "algo": 1}],
                    "fileLength": 2048,
                    "downloadUrl": "https://cf/jei-15.3.jar",
                    "gameVersions": ["1.21", "NeoForge"],
                    "dependencies": []
                }
            })))
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path("/v1/mods/238222/files/9"))
            .respond_with(ResponseTemplate::new(404))
            .mount(&server)
            .await;

        let file = client(&server)
            .mod_file(238222, 5001)
            .await
            .unwrap()
            .expect("应命中文件");
        let info = file.to_version_info();
        assert_eq!(info.version_id, "5001");
        assert_eq!(info.release_channel, ReleaseChannel::Beta);
        assert_eq!(
            info.download_url.as_deref(),
            Some("https://cf/jei-15.3.jar")
        );
        assert_eq!(info.loaders, vec![ModLoader::NeoForge]);

        assert!(client(&server).mod_file(238222, 9).await.unwrap().is_none());
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn mods_posts_ids_and_unwraps_data() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/v1/mods"))
            .and(header("x-api-key", "test-key"))
            .and(body_partial_json(
                serde_json::json!({"modIds": [238222, 306612]}),
            ))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "data": [{
                    "id": 238222,
                    "name": "Just Enough Items",
                    "slug": "jei",
                    "summary": "物品/配方查看",
                    "logo": {"url": "https://cf/jei.png"}
                }]
            })))
            .expect(1)
            .mount(&server)
            .await;

        let got = client(&server).mods(&[238222, 306612]).await.unwrap();
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].name, "Just Enough Items");
        assert_eq!(
            got[0].logo.as_ref().map(|l| l.url.as_str()),
            Some("https://cf/jei.png")
        );
        assert!(client(&server).mods(&[]).await.unwrap().is_empty());
    }

    /// 把 `&str` 数组转成归一化函数要的 `Vec<String>`。
    fn tags(values: &[&str]) -> Vec<String> {
        values.iter().map(|v| v.to_string()).collect()
    }

    #[test]
    fn normalizes_real_world_mixed_game_versions() {
        let (versions, loaders) =
            normalize_curseforge_game_versions(&tags(&["1.20.1", "Forge", "Client", "Java 17"]));
        assert_eq!(versions, vec!["1.20.1".to_string()]);
        assert_eq!(loaders, vec![ModLoader::Forge]);
    }

    #[test]
    fn normalizes_loader_only_and_version_only_arrays() {
        let (versions, loaders) = normalize_curseforge_game_versions(&tags(&["Fabric", "Quilt"]));
        assert!(versions.is_empty());
        assert_eq!(loaders, vec![ModLoader::Fabric, ModLoader::Quilt]);

        let (versions, loaders) =
            normalize_curseforge_game_versions(&tags(&["1.21", "1.21.1", "1.21.2"]));
        assert_eq!(versions, vec!["1.21", "1.21.1", "1.21.2"]);
        assert!(loaders.is_empty());
    }

    #[test]
    fn normalizes_snapshot_versions_and_dedups_loaders() {
        // 快照号 24w14a 首字符是数字，必须当版本收下；Forge 大小写重复只留一个。
        let (versions, loaders) = normalize_curseforge_game_versions(&tags(&[
            "24w14a",
            "Forge",
            "forge",
            "NeoForge",
            "1.20.5-pre1",
        ]));
        assert_eq!(versions, vec!["24w14a", "1.20.5-pre1"]);
        assert_eq!(loaders, vec![ModLoader::Forge, ModLoader::NeoForge]);
    }

    #[test]
    fn normalizes_drops_noise_and_empty_tags() {
        let (versions, loaders) = normalize_curseforge_game_versions(&tags(&[
            "", "   ", "Client", "Server", "Java 21", "Addons", " 1.19.2 ",
        ]));
        // 只剩下被空白包着的那个版本号，且已 trim。
        assert_eq!(versions, vec!["1.19.2".to_string()]);
        assert!(loaders.is_empty());

        assert_eq!(
            normalize_curseforge_game_versions(&[]),
            (Vec::<String>::new(), Vec::<ModLoader>::new())
        );
    }

    /// 造一个文件裸模型，便于各转换用例改单个字段。
    fn file_json(release_type: serde_json::Value, extra_game_versions: &[&str]) -> CurseForgeFile {
        let mut game_versions = vec!["1.20.1".to_string(), "Forge".to_string()];
        game_versions.extend(extra_game_versions.iter().map(|v| v.to_string()));
        serde_json::from_value(serde_json::json!({
            "id": 5000,
            "modId": 238222,
            "displayName": "JEI 15.2.0.27",
            "fileName": "jei-1.20.1-15.2.0.27.jar",
            "releaseType": release_type,
            "hashes": [{"value": "abc123", "algo": 1}, {"value": "md5here", "algo": 2}],
            "fileDate": "2026-01-02T03:04:05Z",
            "fileLength": 1048576,
            "downloadUrl": "https://cf/jei.jar",
            "gameVersions": game_versions,
            "dependencies": [
                {"modId": 100, "relationType": 3},
                {"modId": 200, "relationType": 2},
                {"modId": 300, "relationType": 99}
            ],
            "fileFingerprint": 123456789u64
        }))
        .unwrap()
    }

    #[test]
    fn file_version_info_maps_all_fields() {
        let info = file_json(serde_json::json!(2), &["Client", "Java 17"]).to_version_info();
        assert_eq!(info.version_id, "5000");
        assert_eq!(info.project_id, "238222");
        assert_eq!(info.platform, Platform::CurseForge);
        assert_eq!(info.name, "JEI 15.2.0.27");
        assert_eq!(info.version_number, "jei-1.20.1-15.2.0.27.jar");
        assert_eq!(info.release_channel, ReleaseChannel::Beta);
        assert_eq!(info.game_versions, vec!["1.20.1".to_string()]);
        assert_eq!(info.loaders, vec![ModLoader::Forge]);
        assert_eq!(info.file_name, "jei-1.20.1-15.2.0.27.jar");
        assert_eq!(info.file_size, Some(1_048_576));
        assert_eq!(info.sha1.as_deref(), Some("abc123"));
        assert_eq!(info.download_url.as_deref(), Some("https://cf/jei.jar"));
        assert_eq!(info.date_published, "2026-01-02T03:04:05Z");

        // relationType 99 认不出，丢弃；必需与可选各留一条，project_id 用十进制串。
        assert_eq!(info.dependencies.len(), 2);
        assert_eq!(info.dependencies[0].project_id.as_deref(), Some("100"));
        assert_eq!(info.dependencies[0].version_id, None);
        assert_eq!(info.dependencies[0].kind, DependencyKind::Required);
        assert_eq!(info.dependencies[1].project_id.as_deref(), Some("200"));
        assert_eq!(info.dependencies[1].kind, DependencyKind::Optional);
    }

    #[test]
    fn file_version_info_treats_blank_download_url_as_missing() {
        let mut file = file_json(serde_json::json!(1), &[]);
        file.download_url = Some(String::new());
        assert_eq!(file.to_version_info().download_url, None);
        file.download_url = None;
        assert_eq!(file.to_version_info().download_url, None);
    }

    #[test]
    fn file_version_info_falls_back_to_alpha_without_release_type() {
        let missing = file_json(serde_json::json!(null), &[]).to_version_info();
        assert_eq!(missing.release_channel, ReleaseChannel::Alpha);

        let unknown = file_json(serde_json::json!(42), &[]).to_version_info();
        assert_eq!(unknown.release_channel, ReleaseChannel::Alpha);

        let release = file_json(serde_json::json!(1), &[]).to_version_info();
        assert_eq!(release.release_channel, ReleaseChannel::Release);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn mod_files_parses_release_type_for_version_info() {
        let server = MockServer::start().await;
        let body = serde_json::json!({
            "data": [{
                "id": 5001,
                "modId": 238222,
                "displayName": "JEI 15.3.0.4",
                "fileName": "jei-1.21-15.3.0.4.jar",
                "releaseType": 1,
                "hashes": [{"value": "ffee00", "algo": 1}],
                "fileDate": "2026-02-03T04:05:06Z",
                "fileLength": 2048,
                "gameVersions": ["1.21", "NeoForge", "Server"],
                "dependencies": []
            }],
            "pagination": {"index": 0, "pageSize": 50, "resultCount": 1, "totalCount": 1}
        });
        Mock::given(method("GET"))
            .and(path("/v1/mods/238222/files"))
            .and(header("x-api-key", "test-key"))
            .respond_with(ResponseTemplate::new(200).set_body_json(body))
            .mount(&server)
            .await;

        let list = client(&server).mod_files(238222, None, None).await.unwrap();
        assert!(!list.truncated);
        assert_eq!(list.files.len(), 1);
        let info = list.files[0].to_version_info();
        assert_eq!(info.version_id, "5001");
        assert_eq!(info.release_channel, ReleaseChannel::Release);
        assert_eq!(info.game_versions, vec!["1.21".to_string()]);
        assert_eq!(info.loaders, vec![ModLoader::NeoForge]);
        assert_eq!(info.file_size, Some(2048));
        assert!(info.dependencies.is_empty());
        assert_eq!(info.download_url, None);
    }

    /// 第 `k` 个文件，id 为 `7000 + k`。
    fn numbered_file(k: u64) -> serde_json::Value {
        serde_json::json!({
            "id": 7000 + k, "modId": 238222, "displayName": format!("JEI {k}"),
            "fileName": format!("jei-{k}.jar"), "releaseType": 1,
            "fileDate": "2026-01-01T00:00:00Z", "gameVersions": ["1.20.1", "Forge"]
        })
    }

    fn query_number(request: &wiremock::Request, name: &str) -> u64 {
        request
            .url
            .query_pairs()
            .find(|(key, _)| key == name)
            .unwrap_or_else(|| panic!("请求缺少 {name}：{}", request.url))
            .1
            .parse()
            .unwrap()
    }

    /// 按请求里的 `index` / `pageSize` 从 `total` 个文件里切出一页；`paginated` 为假时响应不带分页信息。
    fn paged_files(
        total: u64,
        paginated: bool,
    ) -> impl Fn(&wiremock::Request) -> ResponseTemplate + Send + Sync {
        move |request| {
            let index = query_number(request, "index");
            let size = query_number(request, "pageSize");
            let data: Vec<serde_json::Value> = (index.min(total)..(index + size).min(total))
                .map(numbered_file)
                .collect();
            let mut body = serde_json::json!({ "data": data });
            if paginated {
                body["pagination"] = serde_json::json!({
                    "index": index, "pageSize": size, "resultCount": data.len(), "totalCount": total
                });
            }
            ResponseTemplate::new(200).set_body_json(body)
        }
    }

    async fn files_server(total: u64, paginated: bool) -> MockServer {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/v1/mods/238222/files"))
            .and(query_param("pageSize", "50"))
            .respond_with(paged_files(total, paginated))
            .mount(&server)
            .await;
        server
    }

    async fn requested_indexes(server: &MockServer) -> Vec<u64> {
        server
            .received_requests()
            .await
            .unwrap()
            .iter()
            .map(|request| query_number(request, "index"))
            .collect()
    }

    /// 按总数翻页：总数正好落在页边界时不多发一个请求，短页即止；文件一个不少、按平台给的先后。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn mod_files_walks_pages_until_the_platform_runs_out() {
        for (total, pages) in [
            (0, vec![0]),
            (1, vec![0]),
            (50, vec![0]),
            (51, vec![0, 50]),
            (120, vec![0, 50, 100]),
        ] {
            let server = files_server(total, true).await;
            let list = client(&server).mod_files(238222, None, None).await.unwrap();
            let ids: Vec<u32> = list.files.iter().map(|file| file.id).collect();
            assert_eq!(
                ids,
                (7000..7000 + total as u32).collect::<Vec<_>>(),
                "共 {total} 个"
            );
            assert!(!list.truncated, "共 {total} 个");
            assert_eq!(requested_indexes(&server).await, pages, "共 {total} 个");
        }
    }

    /// 翻满 10 页（500 个）就停：总数刚好 500 不算截断，多一个就标截断，请求数都不超过 10。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn mod_files_stops_at_the_page_cap_and_says_so() {
        let every_page: Vec<u64> = (0..10).map(|page| page * 50).collect();
        for (total, truncated) in [(500, false), (501, true)] {
            let server = files_server(total, true).await;
            let list = client(&server).mod_files(238222, None, None).await.unwrap();
            assert_eq!(list.files.len(), 500, "共 {total} 个");
            assert_eq!(list.truncated, truncated, "共 {total} 个");
            assert_eq!(
                requested_indexes(&server).await,
                every_page,
                "共 {total} 个"
            );
        }
    }

    /// 响应没带分页信息时凭满页判断：满页就再要一页，空页或短页即止。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn mod_files_without_pagination_stops_on_a_short_page() {
        for (total, pages) in [(50, vec![0, 50]), (70, vec![0, 50]), (30, vec![0])] {
            let server = files_server(total, false).await;
            let list = client(&server).mod_files(238222, None, None).await.unwrap();
            assert_eq!(list.files.len() as u64, total);
            assert!(!list.truncated);
            assert_eq!(requested_indexes(&server).await, pages, "共 {total} 个");
        }
    }

    /// 过滤条件每一页都带上；翻页期间新发布的文件把上一页末尾挤到下一页时，重复的那个只留一份。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn mod_files_keeps_filters_on_every_page_and_drops_repeats() {
        let server = MockServer::start().await;
        let page = |range: std::ops::Range<u64>| {
            serde_json::json!({
                "data": range.map(numbered_file).collect::<Vec<_>>(),
                "pagination": {"index": 0, "pageSize": 50, "resultCount": 50, "totalCount": 90}
            })
        };
        Mock::given(method("GET"))
            .and(path("/v1/mods/238222/files"))
            .and(query_param("gameVersion", "1.20.1"))
            .and(query_param("modLoaderType", "1"))
            .and(query_param("index", "0"))
            .respond_with(ResponseTemplate::new(200).set_body_json(page(0..50)))
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path("/v1/mods/238222/files"))
            .and(query_param("gameVersion", "1.20.1"))
            .and(query_param("modLoaderType", "1"))
            .and(query_param("index", "50"))
            .respond_with(ResponseTemplate::new(200).set_body_json(page(49..90)))
            .mount(&server)
            .await;

        let list = client(&server)
            .mod_files(238222, Some(ModLoader::Forge), Some("1.20.1"))
            .await
            .unwrap();
        let ids: Vec<u32> = list.files.iter().map(|file| file.id).collect();
        assert_eq!(ids, (7000..7090).collect::<Vec<_>>());
        assert!(!list.truncated);
    }
}
