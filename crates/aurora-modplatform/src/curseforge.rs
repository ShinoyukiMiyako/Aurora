//! CurseForge v1 客户端（api.curseforge.com/v1）。
//!
//! 覆盖搜索、工程详情、文件列表、按指纹匹配、取文件下载直链。CurseForge 强制 `x-api-key` 头，
//! key 经构造函数或环境变量 `AURORA_CURSEFORGE_API_KEY` 注入；缺失时构造直接失败
//! （[`Error::CurseForgeKeyMissing`]），该源被明确禁用而非静默降级。远端地址经 `base_url` 注入以走 mock。

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

    /// 从环境变量 `AURORA_CURSEFORGE_API_KEY` 读取 key 构造；缺失或空白返回
    /// [`Error::CurseForgeKeyMissing`]。
    pub fn from_env(http: reqwest::Client) -> Result<Self> {
        let key = key_from_env_value(std::env::var(API_KEY_ENV).ok())?;
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
        self.http.get(url).header("x-api-key", self.api_key.as_str())
    }

    fn post(&self, url: &str) -> reqwest::RequestBuilder {
        self.http.post(url).header("x-api-key", self.api_key.as_str())
    }

    /// 搜索工程。CurseForge 单次仅支持一个加载器与一个游戏版本，故取查询列表首项。
    pub async fn search(&self, query: &SearchQuery) -> Result<CurseForgeSearchResponse> {
        let params = build_search_params(query);
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

    /// 列出工程文件，可按游戏版本与加载器过滤。
    pub async fn mod_files(
        &self,
        mod_id: u32,
        loader: Option<crate::model::ModLoader>,
        game_version: Option<&str>,
    ) -> Result<Vec<CurseForgeFile>> {
        let mut params: Vec<(&str, String)> = Vec::new();
        if let Some(version) = game_version {
            params.push(("gameVersion", version.to_string()));
        }
        if let Some(loader) = loader {
            params.push(("modLoaderType", loader.curseforge_loader_type().to_string()));
        }
        let url = format!("{}/v1/mods/{}/files", self.base_url, mod_id);
        let envelope: ListEnvelope<CurseForgeFile> =
            send_json(&self.retry, "curseforge.mod_files", || {
                self.get(url.as_str()).query(&params)
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
        let envelope: Envelope<String> =
            send_json(&self.retry, "curseforge.download_url", || self.get(url.as_str())).await?;
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

/// 组装 `/v1/mods/search` 查询参数。
fn build_search_params(query: &SearchQuery) -> Vec<(&'static str, String)> {
    let mut params: Vec<(&'static str, String)> = vec![
        ("gameId", MINECRAFT_GAME_ID.to_string()),
        ("classId", query.resource_type.curseforge_class_id().to_string()),
        ("sortField", query.sort.curseforge_sort_field().to_string()),
        ("sortOrder", "desc".to_string()),
        ("index", query.offset.to_string()),
        ("pageSize", query.limit.to_string()),
    ];
    if let Some(text) = &query.query {
        params.push(("searchFilter", text.clone()));
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

/// 带分页的 `{ "data": [T], "pagination": ... }` 信封。
#[derive(Debug, Clone, Deserialize)]
struct ListEnvelope<T> {
    data: Vec<T>,
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
    /// 最新文件。
    #[serde(default)]
    pub latest_files: Vec<CurseForgeFile>,
    /// 相关链接。
    #[serde(default)]
    pub links: Option<CurseForgeLinks>,
    /// 更新时间。
    #[serde(default)]
    pub date_modified: Option<String>,
    /// 创建时间。
    #[serde(default)]
    pub date_created: Option<String>,
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
            categories: item.categories.iter().map(|c| c.name.clone()).collect(),
            resource_type: ResourceType::from_curseforge_class_id(item.class_id),
            date_modified: item.date_modified.clone(),
            page_url: item.links.as_ref().and_then(|l| l.website_url.clone()),
        }
    }
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
            // 契约规定缺失为空串：发布时间只用于排序与展示，不参与任何兼容判定。
            date_published: self.file_date.clone().unwrap_or_default(),
            dependencies: self
                .dependencies
                .iter()
                .filter_map(|dep| dep.to_mod_dependency())
                .collect(),
        }
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
    use crate::model::{ModLoader, SortField};
    use wiremock::matchers::{header, method, path, query_param};
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
        let params = build_search_params(&query);
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

        let resp = client(&server)
            .search(&SearchQuery::new("jei"))
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
        assert_eq!(m.file.dependencies[0].kind(), Some(DependencyKind::Required));

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

        let files = client(&server).mod_files(238222, None, None).await.unwrap();
        assert_eq!(files.len(), 1);
        let info = files[0].to_version_info();
        assert_eq!(info.version_id, "5001");
        assert_eq!(info.release_channel, ReleaseChannel::Release);
        assert_eq!(info.game_versions, vec!["1.21".to_string()]);
        assert_eq!(info.loaders, vec![ModLoader::NeoForge]);
        assert_eq!(info.file_size, Some(2048));
        assert!(info.dependencies.is_empty());
    }
}
