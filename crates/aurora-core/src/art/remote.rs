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
    /// `size` 是响应头声明的长度，或读到超限那一刻已收到的字节数，都是实际大小的下界。
    #[error("缩略图 {url} 至少有 {size} 字节，超过 {limit} 字节的上限")]
    TooLarge {
        url: String,
        size: u64,
        limit: usize,
    },
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

/// 下载一张缩略图，最多 [`THUMB_MAX_BYTES`] 字节。
pub async fn fetch_thumb(http: &reqwest::Client, url: &str) -> Result<Vec<u8>, ThumbError> {
    fetch_capped(http, url, THUMB_TIMEOUT, THUMB_MAX_BYTES).await
}

/// GET 一个地址，正文最多 `max_bytes` 字节。
///
/// 先整包读进内存再比大小，指向超大文件的地址就会先被整个下进内存。所以响应声明的正文长度超限时不读
/// 正文直接拒；没有声明（分块传输、按压缩编码解码后长度未知）或声明不实的，按块累计，一超限就中止，
/// 丢掉响应即断开连接。
async fn fetch_capped(
    http: &reqwest::Client,
    url: &str,
    timeout: Duration,
    max_bytes: usize,
) -> Result<Vec<u8>, ThumbError> {
    let http_error = |source| ThumbError::Http {
        url: url.to_owned(),
        source,
    };
    let too_large = |size: u64| ThumbError::TooLarge {
        url: url.to_owned(),
        size,
        limit: max_bytes,
    };
    let mut resp = http
        .get(url)
        .timeout(timeout)
        .send()
        .await
        .map_err(http_error)?;
    let status = resp.status();
    if !status.is_success() {
        return Err(ThumbError::Status {
            url: url.to_owned(),
            status: status.as_u16(),
        });
    }
    if let Some(declared) = resp.content_length()
        && declared > max_bytes as u64
    {
        return Err(too_large(declared));
    }
    let mut body: Vec<u8> = Vec::new();
    while let Some(chunk) = resp.chunk().await.map_err(http_error)? {
        let received = body.len() + chunk.len();
        if received > max_bytes {
            return Err(too_large(received as u64));
        }
        body.extend_from_slice(&chunk);
    }
    Ok(body)
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
    use wiremock::matchers::{method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    const LIMIT: usize = 1024;
    /// 远大于上限、也大于 HTTP 客户端单次读取的缓冲：读到中途就该停下，而不是整份收完。
    const HUGE: usize = 4 * 1024 * 1024;

    fn http() -> reqwest::Client {
        aurora_base::http::build_client().unwrap()
    }

    async fn serve(server: &MockServer, route: &str, response: ResponseTemplate) -> String {
        Mock::given(method("GET"))
            .and(path(route.to_owned()))
            .respond_with(response)
            .mount(server)
            .await;
        format!("{}{route}", server.uri())
    }

    /// 让响应不带 Content-Length：显式声明分块传输，服务端就不再按正文长度写这个头。
    fn chunked(body: Vec<u8>) -> ResponseTemplate {
        ResponseTemplate::new(200)
            .insert_header("transfer-encoding", "chunked")
            .set_body_bytes(body)
    }

    /// 一个只发响应头与开头几个字节、之后既不再发也不断开的服务端：读正文的实现只能等到超时。
    async fn stalled(head: String) -> String {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut request = [0_u8; 4096];
            let read = socket.read(&mut request).await.unwrap();
            assert!(read > 0, "客户端应先发出请求");
            socket.write_all(head.as_bytes()).await.unwrap();
            socket.flush().await.unwrap();
            tokio::time::sleep(Duration::from_secs(30)).await;
        });
        format!("http://{addr}/thumb.png")
    }

    fn too_large(result: Result<Vec<u8>, ThumbError>) -> (u64, usize) {
        match result {
            Err(ThumbError::TooLarge { size, limit, .. }) => (size, limit),
            other => panic!("期望 TooLarge，实得 {other:?}"),
        }
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn declared_length_over_limit_is_refused_and_at_limit_is_accepted() {
        let server = MockServer::start().await;
        let huge = serve(
            &server,
            "/huge.png",
            ResponseTemplate::new(200).set_body_bytes(vec![7_u8; HUGE]),
        )
        .await;
        // 按声明的长度拒：报出的大小就是声明的那个数，而不是读到哪算哪。
        assert_eq!(
            too_large(fetch_capped(&http(), &huge, THUMB_TIMEOUT, LIMIT).await),
            (HUGE as u64, LIMIT)
        );

        let over = serve(
            &server,
            "/over.png",
            ResponseTemplate::new(200).set_body_bytes(vec![7_u8; LIMIT + 1]),
        )
        .await;
        assert_eq!(
            too_large(fetch_capped(&http(), &over, THUMB_TIMEOUT, LIMIT).await),
            ((LIMIT + 1) as u64, LIMIT)
        );

        let exact = serve(
            &server,
            "/exact.png",
            ResponseTemplate::new(200).set_body_bytes(vec![7_u8; LIMIT]),
        )
        .await;
        assert_eq!(
            fetch_capped(&http(), &exact, THUMB_TIMEOUT, LIMIT)
                .await
                .unwrap(),
            vec![7_u8; LIMIT]
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn body_without_length_stops_once_over_limit() {
        let server = MockServer::start().await;
        let huge = serve(&server, "/huge.png", chunked(vec![7_u8; HUGE])).await;
        // 确认这条响应真的没带长度，走的是边读边数那条路。
        let probe = http().get(&huge).send().await.unwrap();
        assert!(probe.headers().get("content-length").is_none());
        assert_eq!(probe.content_length(), None);
        drop(probe);

        let (size, limit) = too_large(fetch_capped(&http(), &huge, THUMB_TIMEOUT, LIMIT).await);
        assert_eq!(limit, LIMIT);
        assert!(size > LIMIT as u64, "超限才中止，实得 {size}");
        assert!(
            size < HUGE as u64,
            "一超限就该中止，不能整份读完：读了 {size}"
        );

        let exact = serve(&server, "/exact.png", chunked(vec![7_u8; LIMIT])).await;
        assert_eq!(
            fetch_capped(&http(), &exact, THUMB_TIMEOUT, LIMIT)
                .await
                .unwrap(),
            vec![7_u8; LIMIT]
        );
        let over = serve(&server, "/over.png", chunked(vec![7_u8; LIMIT + 1])).await;
        assert_eq!(
            too_large(fetch_capped(&http(), &over, THUMB_TIMEOUT, LIMIT).await),
            ((LIMIT + 1) as u64, LIMIT)
        );
    }

    /// 声明超限时连正文都不等：服务端发完头就停住，照样立刻拒，而不是等到超时。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn declared_length_over_limit_is_refused_without_waiting_for_the_body() {
        let url = stalled(format!(
            "HTTP/1.1 200 OK\r\nContent-Type: image/png\r\nContent-Length: {HUGE}\r\n\r\nPNG"
        ))
        .await;
        let started = std::time::Instant::now();
        assert_eq!(
            too_large(fetch_capped(&http(), &url, Duration::from_secs(5), LIMIT).await),
            (HUGE as u64, LIMIT)
        );
        assert!(started.elapsed() < Duration::from_secs(4));
    }

    /// 没有声明长度、正文先送来超限的一截再停住：读到超限当即中止，不等剩下的。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn body_without_length_is_aborted_without_waiting_for_the_rest() {
        let first = "x".repeat(LIMIT + 1);
        let url = stalled(format!(
            "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n{:x}\r\n{first}\r\n",
            first.len()
        ))
        .await;
        let started = std::time::Instant::now();
        let (size, _) = too_large(fetch_capped(&http(), &url, Duration::from_secs(5), LIMIT).await);
        assert_eq!(size, (LIMIT + 1) as u64);
        assert!(started.elapsed() < Duration::from_secs(4));
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn thumb_download_reports_status_and_returns_the_body() {
        let server = MockServer::start().await;
        let missing = serve(&server, "/missing.png", ResponseTemplate::new(404)).await;
        assert!(matches!(
            fetch_thumb(&http(), &missing).await,
            Err(ThumbError::Status { status: 404, .. })
        ));
        let small = serve(
            &server,
            "/small.png",
            ResponseTemplate::new(200).set_body_bytes(vec![1_u8; LIMIT * 4]),
        )
        .await;
        assert_eq!(
            fetch_thumb(&http(), &small).await.unwrap(),
            vec![1_u8; LIMIT * 4]
        );
    }

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
