//! 远程图片的下载与磁盘缓存：玩家皮肤与资源平台、资讯的缩略图。
//!
//! 两者都以 `sha1(url)` 为文件名（地址变了就是另一个文件），下载走一次 GET、整体校验后原子写入。
//! 缩略图只接受固定几个图片域名：任意地址都能下的话，这个接口就成了一个替网页去访问任意主机的代理。

use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

use image::ImageFormat;
use sha1::{Digest, Sha1};

/// 皮肤下载的时限。
pub const SKIN_TIMEOUT: Duration = Duration::from_millis(5000);
/// 缩略图下载的时限。画廊大图可达数 MB，给得比皮肤宽。
pub const THUMB_TIMEOUT: Duration = Duration::from_secs(15);
/// 单张缩略图的大小上限，挡住把超大文件当图片塞进缓存。
pub const THUMB_MAX_BYTES: usize = 20 * 1024 * 1024;
/// 缩略图缓存的总量上限，超出按最近使用时间淘汰。
pub const THUMB_CACHE_MAX_BYTES: u64 = 256 * 1024 * 1024;
/// 缩略图多久没用就在启动时删掉。
pub const THUMB_MAX_IDLE: Duration = Duration::from_secs(30 * 24 * 3600);

/// 允许缓存缩略图的主机：Modrinth 的项目图标与画廊、CurseForge 的图标与截图、官方启动器资讯配图。
pub const THUMB_HOSTS: [&str; 3] = [
    "cdn.modrinth.com",
    "media.forgecdn.net",
    "launchercontent.mojang.com",
];

/// 缩略图登记失败的原因。
#[derive(Debug, thiserror::Error)]
pub enum ThumbError {
    #[error("缩略图地址不合法：{0}")]
    InvalidUrl(String),
    #[error("缩略图主机 {0} 不在允许名单内")]
    HostNotAllowed(String),
    #[error("下载缩略图 {url} 失败")]
    Http {
        url: String,
        #[source]
        source: reqwest::Error,
    },
    #[error("下载缩略图 {url} 返回 HTTP {status}")]
    Status { url: String, status: u16 },
    #[error("缩略图 {url} 有 {size} 字节，超过上限")]
    TooLarge { url: String, size: usize },
    #[error("{url} 的内容不是 PNG / JPEG / GIF / WebP 图片")]
    NotImage { url: String },
    #[error("读写缩略图缓存 {} 失败", path.display())]
    Io {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
    #[error("写入缩略图缓存失败")]
    Write(#[from] aurora_base::Error),
}

/// 40 位小写十六进制的 SHA-1。
pub fn sha1_hex(bytes: &[u8]) -> String {
    Sha1::digest(bytes)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

/// 协议路径里的缓存键必须是 40 位小写十六进制：既是格式校验，也挡住任何路径穿越。
pub fn is_cache_key(key: &str) -> bool {
    key.len() == 40 && key.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

/// 校验缩略图地址：https（或 http）且主机在名单内。
pub fn check_thumb_url(url: &str) -> Result<(), ThumbError> {
    let parsed =
        reqwest::Url::parse(url).map_err(|e| ThumbError::InvalidUrl(format!("{url}：{e}")))?;
    if !matches!(parsed.scheme(), "https" | "http") {
        return Err(ThumbError::InvalidUrl(format!(
            "{url}：只支持 http / https"
        )));
    }
    let host = parsed
        .host_str()
        .ok_or_else(|| ThumbError::InvalidUrl(format!("{url}：缺少主机名")))?;
    if !THUMB_HOSTS.contains(&host) {
        return Err(ThumbError::HostNotAllowed(host.to_owned()));
    }
    Ok(())
}

/// 识别图片格式，返回对应的 MIME；不是允许的四种格式时为 None。
pub fn image_mime(bytes: &[u8]) -> Option<&'static str> {
    match image::guess_format(bytes).ok()? {
        format @ (ImageFormat::Png | ImageFormat::Jpeg | ImageFormat::Gif | ImageFormat::WebP) => {
            Some(format.to_mime_type())
        }
        _ => None,
    }
}

/// GET 一个地址并读完响应体。
pub async fn fetch(
    http: &reqwest::Client,
    url: &str,
    timeout: Duration,
) -> Result<Vec<u8>, FetchError> {
    let resp = http
        .get(url)
        .timeout(timeout)
        .send()
        .await
        .map_err(FetchError::Http)?;
    let status = resp.status();
    if !status.is_success() {
        return Err(FetchError::Status(status.as_u16()));
    }
    Ok(resp.bytes().await.map_err(FetchError::Http)?.to_vec())
}

#[derive(Debug, thiserror::Error)]
pub enum FetchError {
    #[error("请求失败")]
    Http(#[source] reqwest::Error),
    #[error("返回 HTTP {0}")]
    Status(u16),
}

/// 把缓存文件的修改时间刷成现在：缩略图按它判断「最近使用」。
pub fn touch(path: &Path) -> std::io::Result<()> {
    std::fs::File::options()
        .write(true)
        .open(path)?
        .set_modified(SystemTime::now())
}

/// 缓存目录里的一个文件：路径、大小、最近使用时间。
struct CachedFile {
    path: PathBuf,
    len: u64,
    used: SystemTime,
}

fn list_files(dir: &Path) -> std::io::Result<Vec<CachedFile>> {
    let mut files = Vec::new();
    let entries = match std::fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(files),
        Err(err) => return Err(err),
    };
    for entry in entries {
        let entry = entry?;
        let meta = entry.metadata()?;
        if meta.is_file() {
            files.push(CachedFile {
                path: entry.path(),
                len: meta.len(),
                used: meta.modified()?,
            });
        }
    }
    Ok(files)
}

/// 删掉 `idle` 之前就没用过的文件，再按最近使用时间从旧到新删，直到总量不超过 `max_bytes`。
/// 返回删掉的文件。单个文件删不掉只记 warn。
pub fn evict(
    dir: &Path,
    max_bytes: u64,
    idle: Option<Duration>,
    now: SystemTime,
) -> std::io::Result<Vec<PathBuf>> {
    let mut files = list_files(dir)?;
    files.sort_by_key(|f| f.used);
    let mut total: u64 = files.iter().map(|f| f.len).sum();
    let mut removed = Vec::new();
    for file in files {
        let stale =
            idle.is_some_and(|idle| now.duration_since(file.used).is_ok_and(|age| age > idle));
        if !stale && total <= max_bytes {
            continue;
        }
        match std::fs::remove_file(&file.path) {
            Ok(()) => {
                total -= file.len;
                removed.push(file.path);
            }
            Err(err) => {
                tracing::warn!(path = %file.path.display(), error = %err, "删除缓存文件失败");
            }
        }
    }
    Ok(removed)
}

/// 删掉目录里文件名（去扩展名）不在 `keep` 里的文件，返回删掉的文件。
pub fn prune_except(dir: &Path, keep: &[String]) -> std::io::Result<Vec<PathBuf>> {
    let mut removed = Vec::new();
    for file in list_files(dir)? {
        let stem = file
            .path
            .file_stem()
            .and_then(|s| s.to_str())
            .map(str::to_owned);
        if stem.is_some_and(|stem| keep.contains(&stem)) {
            continue;
        }
        match std::fs::remove_file(&file.path) {
            Ok(()) => removed.push(file.path),
            Err(err) => {
                tracing::warn!(path = %file.path.display(), error = %err, "删除旧皮肤缓存失败");
            }
        }
    }
    Ok(removed)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sha1_matches_known_vector_and_keys_are_validated() {
        assert_eq!(sha1_hex(b"abc"), "a9993e364706816aba3e25717850c26c9cd0d89d");
        assert!(is_cache_key("a9993e364706816aba3e25717850c26c9cd0d89d"));
        assert!(!is_cache_key("A9993E364706816ABA3E25717850C26C9CD0D89D"));
        assert!(!is_cache_key("a9993e364706816aba3e25717850c26c9cd0d89"));
        assert!(!is_cache_key("../../../../../../../../etc/passwd/xxxx"));
    }

    #[test]
    fn thumb_urls_are_limited_to_known_image_hosts() {
        assert!(check_thumb_url("https://cdn.modrinth.com/data/AANobbMI/icon.png").is_ok());
        assert!(
            check_thumb_url("https://media.forgecdn.net/avatars/thumbnails/1/2/64/64/a.png")
                .is_ok()
        );
        assert!(matches!(
            check_thumb_url("https://evil.example/cdn.modrinth.com.png"),
            Err(ThumbError::HostNotAllowed(host)) if host == "evil.example"
        ));
        assert!(matches!(
            check_thumb_url("https://cdn.modrinth.com.evil.example/x.png"),
            Err(ThumbError::HostNotAllowed(_))
        ));
        assert!(matches!(
            check_thumb_url("file:///C:/Windows/win.ini"),
            Err(ThumbError::InvalidUrl(_))
        ));
        assert!(matches!(
            check_thumb_url("不是地址"),
            Err(ThumbError::InvalidUrl(_))
        ));
    }

    #[test]
    fn image_mime_only_accepts_four_formats() {
        let png = super::super::image_rules::testing::png(1, 1, |_, _| [0, 0, 0, 255]);
        assert_eq!(image_mime(&png), Some("image/png"));
        assert_eq!(image_mime(&[0xff, 0xd8, 0xff, 0xe0]), Some("image/jpeg"));
        assert_eq!(image_mime(b"GIF89a...."), Some("image/gif"));
        assert_eq!(image_mime(b"BM......"), None, "BMP 不在允许之列");
        assert_eq!(image_mime(b"<html>"), None);
    }

    #[test]
    fn eviction_drops_idle_files_then_oldest_until_under_cap() {
        let dir = tempfile::tempdir().unwrap();
        let now = SystemTime::now();
        let day = Duration::from_secs(24 * 3600);
        let write = |name: &str, len: usize, age_days: u64| {
            let path = dir.path().join(name);
            std::fs::write(&path, vec![0u8; len]).unwrap();
            std::fs::File::options()
                .write(true)
                .open(&path)
                .unwrap()
                .set_modified(now - day * age_days as u32)
                .unwrap();
        };
        write("idle", 10, 31);
        write("old", 40, 5);
        write("mid", 40, 3);
        write("new", 40, 1);

        // 上限 90：先删 31 天没用的 idle，再从最旧的 old 删起，删到 80 为止。
        let removed = evict(dir.path(), 90, Some(THUMB_MAX_IDLE), now).unwrap();
        let names: Vec<_> = removed
            .iter()
            .map(|p| p.file_name().unwrap().to_string_lossy().into_owned())
            .collect();
        assert_eq!(names, ["idle", "old"]);
        assert!(dir.path().join("mid").exists());
        assert!(dir.path().join("new").exists());
    }

    #[test]
    fn prune_keeps_only_listed_stems() {
        let dir = tempfile::tempdir().unwrap();
        let keep = sha1_hex(b"https://skin/new");
        std::fs::write(dir.path().join(format!("{keep}.png")), b"x").unwrap();
        std::fs::write(
            dir.path()
                .join(format!("{}.png", sha1_hex(b"https://skin/old"))),
            b"x",
        )
        .unwrap();
        let removed = prune_except(dir.path(), std::slice::from_ref(&keep)).unwrap();
        assert_eq!(removed.len(), 1);
        assert!(dir.path().join(format!("{keep}.png")).exists());
        // 目录不存在时什么都不做。
        assert!(
            prune_except(&dir.path().join("none"), &[])
                .unwrap()
                .is_empty()
        );
    }
}
