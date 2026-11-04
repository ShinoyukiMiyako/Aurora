//! 原版材质服务：运行时从玩家本机的游戏文件里读出界面点缀要用的那几张图，经自定义协议交给前端。
//!
//! 安装包与仓库里不带任何原版文件；能读到什么取决于玩家装过什么，读不到时界面画代码绘制的回落件。
//! 回落是设计内的正常路径，不打断用户，但每次回落的原因都以 warn 写进日志。
//!
//! - [`whitelist`]：允许读取的文件名单（17 张方块面 + 20 张默认皮肤）。
//! - [`default_skin`]：没有自定义皮肤的玩家（离线账户）在原版里显示哪一套默认皮肤。
//! - 材质源：候选游戏目录里最新的可信原版客户端 jar（选择规则见 `source`）。
//! - 磁盘缓存：选中材质源后把名单内文件一次抽到 `<缓存目录>/vanilla-art/<版本>/`。
//! - 全景：只认一张固定哈希的资源对象，直接从 `assets/objects` 读。
//! - 远程皮肤与缩略图：按 `sha1(url)` 缓存在 `<缓存目录>/skins`、`<缓存目录>/thumbs`。
//! - 卡面图片：玩家给实例卡面选的图片存在实例自己的目录里，列实例时按 `sha1(路径)` 登记给 `/cover/`。
//!
//! [`TextureService`] 不依赖门面锁：长任务持锁时取图照常。它可以廉价克隆（内部是 `Arc`）。

pub mod default_skin;
mod disk_cache;
mod image_rules;
mod lru;
mod remote;
mod source;
pub mod whitelist;

use std::collections::{BTreeSet, HashMap};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

use petalfall_auth::{SkinModel, SkinRef};

pub use default_skin::{DefaultSkin, default_skin};
pub use remote::{THUMB_HOSTS, ThumbError};
pub use source::{JarOpener, default_opener};

use lru::{Cached, Lru};
use source::{JarHashCache, SelectedSource};

use crate::facade::Petalfall;

/// 下载原版客户端的暂存子目录（在 vanilla-art 下）。点开头，不会被当成材质源版本目录。
const DOWNLOAD_DIR: &str = ".download";

/// 进程内缓存的条数上限。
const LRU_MAX_ENTRIES: usize = 512;
/// 进程内缓存的总字节上限（全景计入）。
const LRU_MAX_BYTES: usize = 16 * 1024 * 1024;

/// 原版标题全景的正面在资源索引里的对象：只认这一个哈希，不认版本号。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PanoramaSpec {
    pub sha1: String,
}

impl Default for PanoramaSpec {
    fn default() -> Self {
        Self {
            sha1: "f228a4964175f885b334033c5e5cf12bf62421d0".to_owned(),
        }
    }
}

impl PanoramaSpec {
    /// 对象在某个游戏目录里的位置：`assets/objects/<前两位>/<哈希>`。
    fn object_in(&self, game_dir: &Path) -> PathBuf {
        game_dir
            .join("assets")
            .join("objects")
            .join(&self.sha1[..2])
            .join(&self.sha1)
    }
}

/// 材质服务对外的状态。
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct ArtStatus {
    /// 材质源版本 id；没有可用材质源时为 None，前端不发任何材质请求、全部画回落件。
    pub source: Option<String>,
    /// 标题全景对象是否在某个候选目录里且哈希正确。
    pub panorama: bool,
}

/// 从官方源下载、校验过的客户端 jar 与中文语言文件：交给 [`TextureService::adopt_download`] 抽进缓存，
/// 之后由调用方删掉。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DownloadedClient {
    pub version_id: String,
    pub jar: PathBuf,
    /// jar 的 SHA-1（小写十六进制），已与版本 JSON 的声明核对过。
    pub jar_sha1: String,
    /// 资源索引里的 zh_cn.json，已按索引核对过 SHA-1；没下到为 None，方块名只有英文。
    pub zh_cn: Option<PathBuf>,
}

/// 远程皮肤就绪后的描述：协议取图用的键、模型与头像要不要叠帽子层。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SkinInfo {
    pub sha1: String,
    pub model: SkinModel,
    pub hat: bool,
}

/// 协议请求的结果，与 HTTP 状态一一对应。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TexResponse {
    /// 200：找到。
    Found {
        content_type: &'static str,
        body: Arc<Vec<u8>>,
    },
    /// 400：路径不合法或不在名单内（编程错误）。
    BadRequest(String),
    /// 404：路径合法但此刻没有这张图。
    NotFound(String),
    /// 500：读盘失败。
    Failed(String),
}

impl TexResponse {
    pub fn status(&self) -> u16 {
        match self {
            TexResponse::Found { .. } => 200,
            TexResponse::BadRequest(_) => 400,
            TexResponse::NotFound(_) => 404,
            TexResponse::Failed(_) => 500,
        }
    }
}

struct Active {
    source: SelectedSource,
    files: BTreeSet<String>,
}

struct State {
    active: Option<Active>,
    panorama: Option<PathBuf>,
    lru: Lru,
    hashes: JarHashCache,
    skins: HashMap<String, PathBuf>,
    thumbs: HashMap<String, PathBuf>,
    covers: HashMap<String, PathBuf>,
}

struct Inner {
    cache_root: PathBuf,
    http: reqwest::Client,
    panorama: PanoramaSpec,
    opener: JarOpener,
    state: Mutex<State>,
    refreshing: tokio::sync::Mutex<()>,
}

/// 原版材质服务。
#[derive(Clone)]
pub struct TextureService {
    inner: Arc<Inner>,
}

impl Petalfall {
    /// 用门面的 HTTP 客户端与 `<数据目录>/cache` 建一个材质服务。
    pub fn texture_service(&self) -> TextureService {
        TextureService::new(self.data_dir().join("cache"), self.http())
    }

    /// 材质的候选游戏目录，按优先级：设置里的游戏目录、与它并存登记的其他游戏目录，最后是官方启动器
    /// 的默认目录。这些目录只读不写，重复的只留一次。
    pub fn art_candidates(&self) -> Vec<PathBuf> {
        let mut dirs = vec![self.game_dir().to_path_buf()];
        for extra in &self.config().extra_game_directories {
            if !dirs.contains(&extra.path) {
                dirs.push(extra.path.clone());
            }
        }
        if let Some(official) = official_minecraft_dir()
            && !dirs.contains(&official)
        {
            dirs.push(official);
        }
        dirs
    }
}

/// 官方启动器的默认游戏目录 `%APPDATA%\.minecraft`；没有 APPDATA（非 Windows）时为 None。
fn official_minecraft_dir() -> Option<PathBuf> {
    std::env::var_os("APPDATA")
        .map(|appdata| PathBuf::from(appdata).join(petalfall_instance::MINECRAFT_DIR_NAME))
}

/// 状态锁只护着内存里的几张表，持锁期间不做 IO 也不 await；中毒不携带需要放弃的状态。
fn lock(state: &Mutex<State>) -> MutexGuard<'_, State> {
    state.lock().unwrap_or_else(PoisonError::into_inner)
}

impl TextureService {
    /// `cache_root` 是缓存根目录（其下建 vanilla-art、skins、thumbs），`http` 用于下载远程皮肤与缩略图。
    pub fn new(cache_root: PathBuf, http: reqwest::Client) -> Self {
        Self::with_parts(cache_root, http, PanoramaSpec::default(), default_opener())
    }

    /// 注入全景哈希与打开 jar 的函数（测试用：夹具里造不出真全景，也要数 jar 被打开了几次）。
    pub fn with_parts(
        cache_root: PathBuf,
        http: reqwest::Client,
        panorama: PanoramaSpec,
        opener: JarOpener,
    ) -> Self {
        Self {
            inner: Arc::new(Inner {
                cache_root,
                http,
                panorama,
                opener,
                state: Mutex::new(State {
                    active: None,
                    panorama: None,
                    lru: Lru::new(LRU_MAX_ENTRIES, LRU_MAX_BYTES),
                    hashes: JarHashCache::default(),
                    skins: HashMap::new(),
                    thumbs: HashMap::new(),
                    covers: HashMap::new(),
                }),
                refreshing: tokio::sync::Mutex::new(()),
            }),
        }
    }

    fn art_root(&self) -> PathBuf {
        self.inner.cache_root.join("vanilla-art")
    }

    /// 下载原版客户端的暂存目录：`<缓存目录>/vanilla-art/.download`。
    pub fn download_dir(&self) -> PathBuf {
        self.art_root().join(DOWNLOAD_DIR)
    }

    fn skins_dir(&self) -> PathBuf {
        self.inner.cache_root.join("skins")
    }

    fn thumbs_dir(&self) -> PathBuf {
        self.inner.cache_root.join("thumbs")
    }

    /// 当前状态（只读内存）。
    pub fn status(&self) -> ArtStatus {
        let state = lock(&self.inner.state);
        ArtStatus {
            source: state.active.as_ref().map(|a| a.source.version_id.clone()),
            panorama: state.panorama.is_some(),
        }
    }

    /// 重新选择材质源与全景并准备磁盘缓存，返回新状态；同时清空进程内缓存。
    ///
    /// 应在启动、更换游戏目录、任何游戏版本装好或删掉之后调用。不监听文件系统。
    /// 同一时刻只跑一次，后到的调用排队。
    pub async fn refresh(&self, candidates: &[PathBuf]) -> ArtStatus {
        let _running = self.inner.refreshing.lock().await;
        let mut hashes = std::mem::take(&mut lock(&self.inner.state).hashes);
        let selected = source::select_source(candidates, &self.inner.opener, &mut hashes).await;
        let active = match selected {
            Some(source) => self.prepare_cache(source).await,
            None => {
                tracing::warn!(candidates = ?candidates, "候选游戏目录里没有可用的原版材质源，界面点缀全部回落");
                None
            }
        };
        let panorama = self.find_panorama(candidates).await;
        let mut state = lock(&self.inner.state);
        state.hashes = hashes;
        state.active = active;
        state.panorama = panorama;
        state.lru.clear();
        ArtStatus {
            source: state.active.as_ref().map(|a| a.source.version_id.clone()),
            panorama: state.panorama.is_some(),
        }
    }

    async fn prepare_cache(&self, source: SelectedSource) -> Option<Active> {
        let root = self.art_root();
        let opener = self.inner.opener.clone();
        let job = source.clone();
        let prepared = tokio::task::spawn_blocking(move || {
            std::fs::create_dir_all(&root)
                .map_err(|e| format!("创建材质缓存目录 {} 失败：{e}", root.display()))?;
            disk_cache::ensure(&root, &job, &opener)
        })
        .await;
        match prepared {
            Ok(Ok(files)) => {
                tracing::info!(version = %source.version_id, full = source.full, files = files.len(), "原版材质源就绪");
                Some(Active { source, files })
            }
            Ok(Err(reason)) => {
                tracing::warn!(version = %source.version_id, %reason, "准备原版材质缓存失败，界面点缀全部回落");
                None
            }
            Err(err) => {
                tracing::warn!(version = %source.version_id, error = %err, "准备原版材质缓存的后台任务异常结束");
                None
            }
        }
    }

    async fn find_panorama(&self, candidates: &[PathBuf]) -> Option<PathBuf> {
        for dir in candidates {
            let path = self.inner.panorama.object_in(dir);
            match self.read_panorama(&path).await {
                Ok(Some(_)) => return Some(path),
                Ok(None) => {}
                Err(reason) => {
                    tracing::warn!(path = %path.display(), %reason, "标题全景对象不可用")
                }
            }
        }
        None
    }

    /// 读全景对象并校验哈希：不存在为 `Ok(None)`，哈希不符或读失败为 `Err`。
    async fn read_panorama(&self, path: &Path) -> Result<Option<Vec<u8>>, String> {
        let bytes = match tokio::fs::read(path).await {
            Ok(bytes) => bytes,
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(err) => return Err(format!("读取失败：{err}")),
        };
        let actual = remote::sha1_hex(&bytes);
        if actual != self.inner.panorama.sha1 {
            return Err(format!("SHA-1 为 {actual}，与预期不符"));
        }
        Ok(Some(bytes))
    }

    /// 处理一次协议请求。`path` 为 URL 路径（以 `/` 开头），`version` 为已解码的 `v` 参数。
    pub async fn respond(&self, path: &str, version: Option<&str>) -> TexResponse {
        let response = if let Some(rest) = path.strip_prefix("/art/") {
            self.respond_art(rest, version).await
        } else if path == "/panorama/0.png" {
            self.respond_panorama().await
        } else if let Some(rest) = path.strip_prefix("/skin/") {
            match rest.strip_suffix(".png") {
                Some(key) if remote::is_cache_key(key) => self.respond_registered(key, true).await,
                _ => TexResponse::BadRequest(format!("皮肤路径不合法：{path}")),
            }
        } else if let Some(key) = path.strip_prefix("/thumb/") {
            if remote::is_cache_key(key) {
                self.respond_registered(key, false).await
            } else {
                TexResponse::BadRequest(format!("缩略图路径不合法：{path}"))
            }
        } else if let Some(key) = path.strip_prefix("/cover/") {
            if remote::is_cache_key(key) {
                self.respond_cover(key).await
            } else {
                TexResponse::BadRequest(format!("卡面图片路径不合法：{path}"))
            }
        } else {
            TexResponse::BadRequest(format!("材质协议不提供这个路径：{path}"))
        };
        match &response {
            TexResponse::Found { .. } => {}
            TexResponse::BadRequest(reason) => tracing::warn!(path, %reason, "材质请求不合法"),
            TexResponse::NotFound(reason) => {
                tracing::warn!(path, version, %reason, "材质不可用，界面回落")
            }
            TexResponse::Failed(reason) => tracing::warn!(path, version, %reason, "读取材质失败"),
        }
        response
    }

    async fn respond_art(&self, rest: &str, version: Option<&str>) -> TexResponse {
        let Some(art_path) = rest.strip_suffix(".png") else {
            return TexResponse::BadRequest(format!("材质路径须以 .png 结尾：{rest}"));
        };
        if whitelist::art_kind(art_path).is_none() {
            return TexResponse::BadRequest(format!("{art_path} 不在允许读取的名单内"));
        }
        let Some(version) = version else {
            return TexResponse::BadRequest("缺少版本戳参数 v".to_owned());
        };
        let key = format!("art:{version}:{art_path}");
        let listed = {
            let mut guard = lock(&self.inner.state);
            // 拆成字段级借用：下面要同时读 active、改 lru。
            let state: &mut State = &mut guard;
            let Some(active) = &state.active else {
                return TexResponse::NotFound("没有可用的原版材质源".to_owned());
            };
            if active.source.version_id != version {
                return TexResponse::NotFound(format!(
                    "版本戳 {version} 已过期，当前材质源是 {}",
                    active.source.version_id
                ));
            }
            let listed = active.files.contains(art_path);
            match state.lru.get(&key) {
                Some(Cached::Bytes(body)) => return png(body),
                Some(Cached::Missing) => {
                    return TexResponse::NotFound("材质源里没有这个文件".to_owned());
                }
                None => listed,
            }
        };
        if !listed {
            lock(&self.inner.state).lru.put(key, Cached::Missing);
            return TexResponse::NotFound("材质源里没有这个文件".to_owned());
        }
        let file = disk_cache::texture_file(&self.art_root(), version, art_path);
        match tokio::fs::read(&file).await {
            Ok(bytes) => {
                let body = Arc::new(bytes);
                lock(&self.inner.state)
                    .lru
                    .put(key, Cached::Bytes(body.clone()));
                png(body)
            }
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
                lock(&self.inner.state).lru.put(key, Cached::Missing);
                TexResponse::NotFound(format!("缓存文件 {} 不见了", file.display()))
            }
            Err(err) => TexResponse::Failed(format!("读取 {} 失败：{err}", file.display())),
        }
    }

    async fn respond_panorama(&self) -> TexResponse {
        const KEY: &str = "panorama:0";
        let path = {
            let mut state = lock(&self.inner.state);
            let Some(path) = state.panorama.clone() else {
                return TexResponse::NotFound("任何候选目录里都没有标题全景对象".to_owned());
            };
            if let Some(Cached::Bytes(body)) = state.lru.get(KEY) {
                return png(body);
            }
            path
        };
        match self.read_panorama(&path).await {
            Ok(Some(bytes)) => {
                let body = Arc::new(bytes);
                lock(&self.inner.state)
                    .lru
                    .put(KEY.to_owned(), Cached::Bytes(body.clone()));
                png(body)
            }
            Ok(None) => TexResponse::NotFound(format!("全景对象 {} 已被删除", path.display())),
            Err(reason) => {
                TexResponse::NotFound(format!("全景对象 {} 不可用：{reason}", path.display()))
            }
        }
    }

    async fn respond_registered(&self, key: &str, skin: bool) -> TexResponse {
        let path = {
            let state = lock(&self.inner.state);
            let table = if skin { &state.skins } else { &state.thumbs };
            match table.get(key) {
                Some(path) => path.clone(),
                None => return TexResponse::NotFound(format!("{key} 没有登记过")),
            }
        };
        match tokio::fs::read(&path).await {
            Ok(bytes) => {
                let content_type = if skin {
                    "image/png"
                } else {
                    match remote::image_mime(&bytes) {
                        Some(mime) => mime,
                        None => return TexResponse::Failed(format!("{} 不是图片", path.display())),
                    }
                };
                if !skin && let Err(err) = remote::touch(&path) {
                    tracing::warn!(path = %path.display(), error = %err, "刷新缩略图使用时间失败");
                }
                TexResponse::Found {
                    content_type,
                    body: Arc::new(bytes),
                }
            }
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
                TexResponse::NotFound(format!("缓存文件 {} 不见了", path.display()))
            }
            Err(err) => TexResponse::Failed(format!("读取 {} 失败：{err}", path.display())),
        }
    }

    /// 登记一张卡面图片，返回协议 `/cover/` 路径用的键（`sha1(路径)`）。只记进内存，不碰磁盘：
    /// 文件在不在由调用方先确认，事后被删掉时协议答 404、界面回落。图片文件名带内容哈希，
    /// 同一路径的内容不会变，响应可以按不可变缓存。
    pub fn register_cover(&self, path: &Path) -> String {
        let key = remote::sha1_hex(path.to_string_lossy().as_bytes());
        lock(&self.inner.state)
            .covers
            .insert(key.clone(), path.to_owned());
        key
    }

    async fn respond_cover(&self, key: &str) -> TexResponse {
        let Some(path) = lock(&self.inner.state).covers.get(key).cloned() else {
            return TexResponse::NotFound(format!("卡面图片 {key} 没有登记过"));
        };
        match tokio::fs::read(&path).await {
            Ok(bytes) => match image_rules::cover_image_mime(&bytes) {
                Some(content_type) => TexResponse::Found {
                    content_type,
                    body: Arc::new(bytes),
                },
                None => TexResponse::Failed(format!("{} 不是 PNG 或 JPEG", path.display())),
            },
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
                TexResponse::NotFound(format!("卡面图片 {} 不见了", path.display()))
            }
            Err(err) => TexResponse::Failed(format!("读取 {} 失败：{err}", path.display())),
        }
    }

    /// 准备一张远程皮肤：缓存里已有且合规就直接用，否则下载（时限 5000 ms）、校验、落盘，
    /// 然后登记给协议的 `/skin/` 路径。任何一步失败都记 warn 并返回 None，界面回落。
    pub async fn skin_info(&self, skin: &SkinRef) -> Option<SkinInfo> {
        let key = remote::sha1_hex(skin.url.as_bytes());
        let path = self.skins_dir().join(format!("{key}.png"));
        let image = match self.cached_skin(&path).await {
            Some(image) => image,
            None => self.download_skin(&skin.url, &path).await?,
        };
        let hat = image_rules::hat_is_meaningful(&image);
        lock(&self.inner.state).skins.insert(key.clone(), path);
        Some(SkinInfo {
            sha1: key,
            model: skin.model,
            hat,
        })
    }

    /// 并发准备多张皮肤（外置登录的角色列表），结果与入参一一对应。
    pub async fn skin_infos(&self, skins: Vec<Option<SkinRef>>) -> Vec<Option<SkinInfo>> {
        let mut tasks = tokio::task::JoinSet::new();
        for (index, skin) in skins.into_iter().enumerate() {
            let service = self.clone();
            tasks.spawn(async move {
                let info = match skin {
                    Some(skin) => service.skin_info(&skin).await,
                    None => None,
                };
                (index, info)
            });
        }
        let mut results = vec![None; tasks.len()];
        while let Some(joined) = tasks.join_next().await {
            match joined {
                Ok((index, info)) => results[index] = info,
                Err(err) => tracing::warn!(error = %err, "准备角色皮肤的后台任务异常结束"),
            }
        }
        results
    }

    async fn cached_skin(&self, path: &Path) -> Option<image::RgbaImage> {
        let bytes = match tokio::fs::read(path).await {
            Ok(bytes) => bytes,
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => return None,
            Err(err) => {
                tracing::warn!(path = %path.display(), error = %err, "读取皮肤缓存失败，改为重新下载");
                return None;
            }
        };
        match image_rules::validate_skin(&bytes) {
            Ok(image) => Some(image),
            Err(reason) => {
                tracing::warn!(path = %path.display(), %reason, "皮肤缓存不合规，改为重新下载");
                None
            }
        }
    }

    async fn download_skin(&self, url: &str, path: &Path) -> Option<image::RgbaImage> {
        let bytes = match remote::fetch(
            &self.inner.http,
            url,
            remote::SKIN_TIMEOUT,
            remote::SKIN_MAX_BYTES,
        )
        .await
        {
            Ok(bytes) => bytes,
            Err(err) => {
                tracing::warn!(url, error = %err, cause = ?std::error::Error::source(&err), "下载皮肤失败，界面回落");
                return None;
            }
        };
        let image = match image_rules::validate_skin(&bytes) {
            Ok(image) => image,
            Err(reason) => {
                tracing::warn!(url, %reason, "下载到的皮肤不合规，界面回落");
                return None;
            }
        };
        if let Err(err) = petalfall_base::fs::atomic_write(path, &bytes).await {
            tracing::warn!(url, path = %path.display(), error = %err, "写入皮肤缓存失败，界面回落");
            return None;
        }
        Some(image)
    }

    /// 删掉不再被任何账户引用的皮肤缓存（档案里的皮肤地址换过之后，旧文件在下次启动时清掉）。
    pub async fn prune_skins(&self, current_urls: &[String]) {
        let keep: Vec<String> = current_urls
            .iter()
            .map(|url| remote::sha1_hex(url.as_bytes()))
            .collect();
        let dir = self.skins_dir();
        let pruned = tokio::task::spawn_blocking(move || remote::prune_except(&dir, &keep)).await;
        match pruned {
            Ok(Ok(removed)) if !removed.is_empty() => {
                tracing::info!(count = removed.len(), "已清理旧皮肤缓存")
            }
            Ok(Ok(_)) => {}
            Ok(Err(err)) => tracing::warn!(error = %err, "清理皮肤缓存失败"),
            Err(err) => tracing::warn!(error = %err, "清理皮肤缓存的后台任务异常结束"),
        }
    }

    /// 登记一张远程缩略图：主机须在名单内；缓存里没有就下载、识别格式后落盘，并按总量上限淘汰。
    /// 返回协议 `/thumb/` 路径用的键。
    pub async fn thumb_register(&self, url: &str) -> Result<String, ThumbError> {
        remote::check_thumb_url(url)?;
        let key = remote::sha1_hex(url.as_bytes());
        let path = self.thumbs_dir().join(&key);
        match remote::touch(&path) {
            Ok(()) => {
                lock(&self.inner.state).thumbs.insert(key.clone(), path);
                return Ok(key);
            }
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => {}
            Err(source) => return Err(ThumbError::Io { path, source }),
        }
        let bytes = remote::fetch_thumb(&self.inner.http, url).await?;
        if remote::image_mime(&bytes).is_none() {
            return Err(ThumbError::NotImage {
                url: url.to_owned(),
            });
        }
        petalfall_base::fs::atomic_write(&path, &bytes).await?;
        lock(&self.inner.state).thumbs.insert(key.clone(), path);
        self.evict_thumbs(None).await;
        Ok(key)
    }

    /// 启动时清理缩略图缓存：30 天没用过的删掉，总量超过上限的按最近使用时间从旧删起。
    pub async fn prune_thumbs(&self) {
        self.evict_thumbs(Some(remote::THUMB_MAX_IDLE)).await;
    }

    async fn evict_thumbs(&self, idle: Option<std::time::Duration>) {
        let dir = self.thumbs_dir();
        let evicted = tokio::task::spawn_blocking(move || {
            remote::evict(
                &dir,
                remote::THUMB_CACHE_MAX_BYTES,
                idle,
                std::time::SystemTime::now(),
            )
        })
        .await;
        let removed = match evicted {
            Ok(Ok(removed)) => removed,
            Ok(Err(err)) => {
                tracing::warn!(error = %err, "淘汰缩略图缓存失败");
                return;
            }
            Err(err) => {
                tracing::warn!(error = %err, "淘汰缩略图缓存的后台任务异常结束");
                return;
            }
        };
        if removed.is_empty() {
            return;
        }
        let mut state = lock(&self.inner.state);
        state.thumbs.retain(|_, path| !removed.contains(path));
    }
}

fn png(body: Arc<Vec<u8>>) -> TexResponse {
    TexResponse::Found {
        content_type: "image/png",
        body,
    }
}

#[cfg(test)]
mod tests;
