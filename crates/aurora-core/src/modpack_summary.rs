//! 平台整合包的清单摘要：不下载整包，按 HTTP Range 只取 zip 末尾的中央目录与清单那一个条目。
//!
//! 整合包动辄几百 MB，而发现页要在用户点「安装」之前就说清有多少个 Mod、还要下多少字节。zip 的目录
//! 在文件末尾，清单（`modrinth.index.json` / `manifest.json`）是其中一个条目：取尾部找到中央目录，
//! 从目录里查出清单条目的偏移与压缩长度，再只取这一段解压。一共三四个小请求，与包的大小无关。
//!
//! 服务器不支持 Range（回 200 整包）时直接报错，不退回整包下载：那与导入时的下载重复，也违背
//! 「不下载整包」的前提。ZIP64（中央目录或条目超过 4 GiB）同样报错：整合包远到不了这个体量。
//!
//! CurseForge 清单只有工程与文件 id，Mod 数与下载量要再问批量文件、批量工程两个接口，与导入同一套落点规则。

use std::io::Read;
use std::path::Path;
use std::time::Duration;

use aurora_modpack::{PackFormat, PackLoader, PackManifest};
use aurora_modplatform::Platform;

use crate::error::{CoreError, Result};
use crate::facade::Aurora;
use crate::modpack::{RemoteFacts, count_pack_mods};

const EOCD_SIGNATURE: u32 = 0x0605_4b50;
const CENTRAL_SIGNATURE: u32 = 0x0201_4b50;
const LOCAL_SIGNATURE: u32 = 0x0403_4b50;
const EOCD_LEN: usize = 22;
const CENTRAL_HEADER_LEN: usize = 46;
const LOCAL_HEADER_LEN: u64 = 30;
/// EOCD 之后最多跟 65535 字节的注释，尾部取这么多一定能找到 EOCD。
const TAIL_BYTES: u64 = EOCD_LEN as u64 + u16::MAX as u64;
/// ZIP64 用这个值占位，真正的数在扩展记录里。
const ZIP64_MARKER: u32 = u32::MAX;
/// 清单解压后的上限。正常的清单在几百 KB，上限只防构造出来的压缩炸弹。
const MANIFEST_MAX_BYTES: u64 = 32 * 1024 * 1024;
/// 单个范围请求的时限。
const RANGE_TIMEOUT: Duration = Duration::from_secs(20);
const STORED: u16 = 0;
const DEFLATED: u16 = 8;

/// 一个平台整合包版本的清单摘要。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ModpackSummary {
    pub format: PackFormat,
    pub name: String,
    pub version: Option<String>,
    pub minecraft: String,
    pub loader: Option<PackLoader>,
    /// 整合包文件本身的字节数。
    pub pack_bytes: u64,
    /// 导入时要另外下载的远程文件数。
    pub remote_files: usize,
    /// 导入后落进 `mods/` 的 Mod 数，与本地预览同一口径（见 `count_pack_mods`）；CurseForge 的远程
    /// 文件按工程大类认，与导入的落点一致。
    pub mod_files: usize,
    /// 远程文件总字节数；平台没给齐每个文件的大小时为 `None`。
    pub remote_bytes: Option<u64>,
    /// 包内自带的覆盖文件数。
    pub override_files: usize,
    /// 覆盖文件解压后的总字节数。
    pub override_bytes: u64,
}

/// 按平台选用的清单解析函数。
type ManifestParser = fn(&[u8]) -> aurora_modpack::Result<PackManifest>;

/// 中央目录里的一个条目。
#[derive(Debug)]
struct CentralEntry {
    name: String,
    method: u16,
    compressed: u64,
    uncompressed: u64,
    local_offset: u64,
}

/// 按范围读出来的平台整合包：文件总长、清单与中央目录。
#[derive(Debug)]
struct RemotePack {
    total: u64,
    manifest: PackManifest,
    entries: Vec<CentralEntry>,
}

impl Aurora {
    /// 平台上某个整合包版本的清单摘要，不下载整包。服务器不支持范围读取、包不是可读的 zip
    /// 或缺清单时报 [`CoreError::RemotePack`]，清单本身不合法时报整合包解析错误。
    pub async fn summarize_platform_modpack(
        &self,
        platform: Platform,
        project_id: &str,
        version_id: &str,
    ) -> Result<ModpackSummary> {
        // 只要下载地址：落点目录不会被用到。
        let (_, task) = self
            .platform_file_task(platform, project_id, version_id, Path::new(""))
            .await?;
        let pack = read_remote_pack(&self.http(), &task.url, platform).await?;
        let remote = self.remote_facts(&pack.manifest.remote).await?;
        Ok(pack.summarize(remote))
    }
}

/// 取尾部找到中央目录，再只取清单那一个条目解析。
async fn read_remote_pack(
    http: &reqwest::Client,
    url: &str,
    platform: Platform,
) -> Result<RemotePack> {
    let (tail, total) = fetch_range(http, url, format!("bytes=-{TAIL_BYTES}")).await?;
    let tail_start = total
        .checked_sub(tail.len() as u64)
        .ok_or_else(|| remote(url, "尾部范围比整个文件还长"))?;
    let entries = central_directory(http, url, &tail, tail_start).await?;

    let (manifest_name, parse): (&str, ManifestParser) = match platform {
        Platform::Modrinth => ("modrinth.index.json", PackManifest::parse_modrinth),
        Platform::CurseForge => ("manifest.json", PackManifest::parse_curseforge),
    };
    let entry = entries
        .iter()
        .find(|entry| entry.name == manifest_name)
        .ok_or_else(|| remote(url, format!("包里没有 {manifest_name}")))?;
    let manifest = parse(&read_entry(http, url, entry).await?)?;
    Ok(RemotePack {
        total,
        manifest,
        entries,
    })
}

impl RemotePack {
    fn summarize(self, remote: RemoteFacts) -> ModpackSummary {
        // 覆盖文件与它去掉覆盖层前缀后、相对实例目录的落点。
        let overrides: Vec<(&CentralEntry, &str)> = self
            .entries
            .iter()
            .filter(|entry| !entry.name.ends_with('/'))
            .filter_map(|entry| {
                self.manifest
                    .override_layers
                    .iter()
                    .find_map(|layer| entry.name.strip_prefix(layer.as_str()))
                    .map(|relative| (entry, relative))
            })
            .collect();
        let override_files = overrides.len();
        let override_bytes = overrides.iter().map(|(entry, _)| entry.uncompressed).sum();
        let mod_files = count_pack_mods(
            remote.destinations.iter().map(String::as_str),
            overrides.iter().map(|&(_, relative)| relative),
        );
        let manifest = self.manifest;
        ModpackSummary {
            format: manifest.format,
            remote_files: manifest.remote.len(),
            name: manifest.name,
            version: manifest.version,
            minecraft: manifest.minecraft,
            loader: manifest.loader,
            pack_bytes: self.total,
            mod_files,
            remote_bytes: remote.bytes,
            override_files,
            override_bytes,
        }
    }
}

fn remote(url: &str, reason: impl Into<String>) -> CoreError {
    CoreError::RemotePack {
        url: url.to_owned(),
        reason: reason.into(),
    }
}

/// 取一段范围（`bytes=a-b` 或尾部 `bytes=-n`），返回内容与 Content-Range 里的文件总长。
/// 回的不是 206 说明服务器没按范围给，连同响应体一起丢掉，不把整包读下来。
async fn fetch_range(http: &reqwest::Client, url: &str, range: String) -> Result<(Vec<u8>, u64)> {
    let fetch_error = |source| CoreError::Fetch {
        url: url.to_owned(),
        source,
    };
    let response = http
        .get(url)
        .header(reqwest::header::RANGE, range.as_str())
        .timeout(RANGE_TIMEOUT)
        .send()
        .await
        .and_then(reqwest::Response::error_for_status)
        .map_err(fetch_error)?;
    if response.status() != reqwest::StatusCode::PARTIAL_CONTENT {
        return Err(remote(
            url,
            format!(
                "服务器不支持按范围读取（{range} 回的是 {}）",
                response.status()
            ),
        ));
    }
    let total = response
        .headers()
        .get(reqwest::header::CONTENT_RANGE)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.rsplit_once('/'))
        .and_then(|(_, total)| total.parse::<u64>().ok())
        .ok_or_else(|| remote(url, "206 响应缺少可读的 Content-Range 总长"))?;
    let bytes = response.bytes().await.map_err(fetch_error)?;
    Ok((bytes.to_vec(), total))
}

fn le16(bytes: &[u8], at: usize) -> u16 {
    u16::from_le_bytes([bytes[at], bytes[at + 1]])
}

fn le32(bytes: &[u8], at: usize) -> u32 {
    u32::from_le_bytes([bytes[at], bytes[at + 1], bytes[at + 2], bytes[at + 3]])
}

/// 从尾部倒着找 EOCD，读出中央目录；目录不全在尾部时再取一次。
async fn central_directory(
    http: &reqwest::Client,
    url: &str,
    tail: &[u8],
    tail_start: u64,
) -> Result<Vec<CentralEntry>> {
    let eocd = (0..=tail.len().saturating_sub(EOCD_LEN))
        .rev()
        .find(|&at| tail.len() >= at + EOCD_LEN && le32(tail, at) == EOCD_SIGNATURE)
        .ok_or_else(|| remote(url, "文件末尾找不到 zip 目录结尾记录，不是 zip 或已损坏"))?;
    let count = le16(tail, eocd + 10);
    let size = le32(tail, eocd + 12);
    let offset = le32(tail, eocd + 16);
    if count == u16::MAX || size == ZIP64_MARKER || offset == ZIP64_MARKER {
        return Err(remote(url, "包是 ZIP64 格式，暂不支持只读目录"));
    }
    let (size, offset) = (u64::from(size), u64::from(offset));
    let directory = if offset >= tail_start {
        let start = usize::try_from(offset - tail_start).expect("尾部内的偏移放得进 usize");
        let end = start + usize::try_from(size).expect("尾部内的长度放得进 usize");
        tail.get(start..end)
            .ok_or_else(|| remote(url, "目录结尾记录里的目录范围越出了文件"))?
            .to_vec()
    } else if size == 0 {
        Vec::new()
    } else {
        fetch_range(http, url, format!("bytes={offset}-{}", offset + size - 1))
            .await?
            .0
    };
    parse_central_directory(&directory, count).map_err(|reason| remote(url, reason))
}

fn parse_central_directory(
    directory: &[u8],
    count: u16,
) -> std::result::Result<Vec<CentralEntry>, String> {
    let mut entries = Vec::with_capacity(usize::from(count));
    let mut at = 0;
    for index in 0..count {
        if directory.len() < at + CENTRAL_HEADER_LEN || le32(directory, at) != CENTRAL_SIGNATURE {
            return Err(format!("目录第 {} 项的头部不对", index + 1));
        }
        let method = le16(directory, at + 10);
        let compressed = le32(directory, at + 20);
        let uncompressed = le32(directory, at + 24);
        let name_len = usize::from(le16(directory, at + 28));
        let extra_len = usize::from(le16(directory, at + 30));
        let comment_len = usize::from(le16(directory, at + 32));
        let local_offset = le32(directory, at + 42);
        if [compressed, uncompressed, local_offset].contains(&ZIP64_MARKER) {
            return Err(format!("目录第 {} 项是 ZIP64 条目，暂不支持", index + 1));
        }
        let name_start = at + CENTRAL_HEADER_LEN;
        let name = directory
            .get(name_start..name_start + name_len)
            .ok_or_else(|| format!("目录第 {} 项的文件名越界", index + 1))?;
        entries.push(CentralEntry {
            name: String::from_utf8_lossy(name).into_owned(),
            method,
            compressed: u64::from(compressed),
            uncompressed: u64::from(uncompressed),
            local_offset: u64::from(local_offset),
        });
        at = name_start + name_len + extra_len + comment_len;
    }
    Ok(entries)
}

/// 取一个条目的数据并解压。本地头里的扩展字段长度可能与目录里的不同，所以先读本地头再定数据起点。
async fn read_entry(http: &reqwest::Client, url: &str, entry: &CentralEntry) -> Result<Vec<u8>> {
    if entry.uncompressed > MANIFEST_MAX_BYTES {
        return Err(remote(
            url,
            format!(
                "{} 解压后 {} 字节，超出上限",
                entry.name, entry.uncompressed
            ),
        ));
    }
    let header_end = entry.local_offset + LOCAL_HEADER_LEN - 1;
    let (header, _) = fetch_range(
        http,
        url,
        format!("bytes={}-{header_end}", entry.local_offset),
    )
    .await?;
    if header.len() < LOCAL_HEADER_LEN as usize || le32(&header, 0) != LOCAL_SIGNATURE {
        return Err(remote(url, format!("{} 的本地头不对", entry.name)));
    }
    let data_start = entry.local_offset
        + LOCAL_HEADER_LEN
        + u64::from(le16(&header, 26))
        + u64::from(le16(&header, 28));
    let data = if entry.compressed == 0 {
        Vec::new()
    } else {
        fetch_range(
            http,
            url,
            format!("bytes={data_start}-{}", data_start + entry.compressed - 1),
        )
        .await?
        .0
    };
    match entry.method {
        STORED => Ok(data),
        DEFLATED => {
            let mut out = Vec::new();
            flate2::read::DeflateDecoder::new(data.as_slice())
                .take(MANIFEST_MAX_BYTES + 1)
                .read_to_end(&mut out)
                .map_err(|err| remote(url, format!("解压 {} 失败：{err}", entry.name)))?;
            if out.len() as u64 > MANIFEST_MAX_BYTES {
                return Err(remote(url, format!("{} 解压后超出上限", entry.name)));
            }
            Ok(out)
        }
        other => Err(remote(
            url,
            format!("{} 用了不支持的压缩方式 {other}", entry.name),
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::instances::tests::aurora_at;
    use std::io::Write;
    use std::sync::Arc;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use wiremock::matchers::{method, path};
    use wiremock::{Mock, MockServer, Request, Respond, ResponseTemplate};

    /// 按请求头里的 Range 回 206 与对应片段；`ranges: false` 时像不支持范围的服务器一样回 200 整包。
    struct RangeServer {
        body: Arc<Vec<u8>>,
        ranges: bool,
        served_bytes: Arc<AtomicUsize>,
    }

    impl Respond for RangeServer {
        fn respond(&self, request: &Request) -> ResponseTemplate {
            let total = self.body.len();
            let header = request
                .headers
                .get("range")
                .and_then(|value| value.to_str().ok())
                .and_then(|value| value.strip_prefix("bytes="));
            let (Some(spec), true) = (header, self.ranges) else {
                self.served_bytes.fetch_add(total, Ordering::SeqCst);
                return ResponseTemplate::new(200).set_body_bytes(self.body.as_slice());
            };
            let (start, end) = match spec.split_once('-').unwrap() {
                ("", suffix) => (total.saturating_sub(suffix.parse().unwrap()), total - 1),
                (start, end) => (
                    start.parse().unwrap(),
                    end.parse::<usize>().unwrap().min(total - 1),
                ),
            };
            self.served_bytes
                .fetch_add(end + 1 - start, Ordering::SeqCst);
            ResponseTemplate::new(206)
                .insert_header(
                    "content-range",
                    format!("bytes {start}-{end}/{total}").as_str(),
                )
                .set_body_bytes(&self.body[start..=end])
        }
    }

    /// 打一个 .mrpack：清单 + 两个覆盖文件，再塞一大块不会被读到的填充，模拟几十 MB 的包。
    fn mrpack(manifest: &serde_json::Value) -> Vec<u8> {
        let mut writer = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
        let deflated = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Deflated);
        let stored = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Stored);
        writer
            .start_file("overrides/config/sodium.json", deflated)
            .unwrap();
        writer.write_all(&[b'x'; 300]).unwrap();
        writer.start_file("filler.bin", stored).unwrap();
        writer.write_all(&vec![7u8; 4 * 1024 * 1024]).unwrap();
        writer
            .add_directory("overrides/resourcepacks/", stored)
            .unwrap();
        writer.start_file("overrides/options.txt", stored).unwrap();
        writer.write_all(b"lang:zh_cn").unwrap();
        writer.start_file("modrinth.index.json", deflated).unwrap();
        writer.write_all(manifest.to_string().as_bytes()).unwrap();
        writer.finish().unwrap().into_inner()
    }

    fn manifest() -> serde_json::Value {
        serde_json::json!({
            "formatVersion": 1, "game": "minecraft", "versionId": "6.4.0",
            "name": "Fabulously Optimized",
            "dependencies": { "minecraft": "1.21.1", "fabric-loader": "0.16.10" },
            "files": [
                { "path": "mods/sodium.jar", "hashes": { "sha1": "a".repeat(40), "sha512": "b".repeat(128) },
                  "downloads": ["https://cdn.modrinth.com/sodium.jar"], "fileSize": 1_000_000 },
                { "path": "mods/lithium.jar", "hashes": { "sha1": "c".repeat(40), "sha512": "d".repeat(128) },
                  "downloads": ["https://cdn.modrinth.com/lithium.jar"], "fileSize": 600_000 },
                { "path": "resourcepacks/faithful.zip", "hashes": { "sha1": "e".repeat(40), "sha512": "f".repeat(128) },
                  "downloads": ["https://cdn.modrinth.com/faithful.zip"], "fileSize": 9_000_000 }
            ]
        })
    }

    async fn serve(pack: Vec<u8>, ranges: bool) -> (MockServer, Arc<AtomicUsize>, usize) {
        let server = MockServer::start().await;
        let total = pack.len();
        let served = Arc::new(AtomicUsize::new(0));
        Mock::given(method("GET"))
            .and(path("/version/ver1"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "id": "ver1", "project_id": "1KVo5zza", "name": "6.4.0", "version_number": "6.4.0",
                "version_type": "release", "game_versions": ["1.21.1"], "loaders": ["fabric"],
                "date_published": "2026-01-01T00:00:00Z", "dependencies": [],
                "files": [{ "url": format!("{}/pack.mrpack", server.uri()), "filename": "fo.mrpack",
                            "primary": true, "size": total,
                            "hashes": { "sha1": "0".repeat(40), "sha512": "1".repeat(128) } }]
            })))
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path("/pack.mrpack"))
            .respond_with(RangeServer {
                body: Arc::new(pack),
                ranges,
                served_bytes: served.clone(),
            })
            .mount(&server)
            .await;
        (server, served, total)
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn summary_reads_only_the_directory_and_the_manifest() {
        let (server, served, total) = serve(mrpack(&manifest()), true).await;
        let tmp = tempfile::tempdir().unwrap();
        let aurora = aurora_at(tmp.path()).with_modrinth_base(server.uri());

        let summary = aurora
            .summarize_platform_modpack(Platform::Modrinth, "1KVo5zza", "ver1")
            .await
            .unwrap();
        assert_eq!(summary.name, "Fabulously Optimized");
        assert_eq!(summary.version.as_deref(), Some("6.4.0"));
        assert_eq!(summary.minecraft, "1.21.1");
        assert_eq!(summary.pack_bytes, total as u64);
        assert_eq!(summary.remote_files, 3);
        assert_eq!(summary.mod_files, 2, "只数落进 mods/ 的");
        assert_eq!(summary.remote_bytes, Some(10_600_000));
        assert_eq!(summary.override_files, 2, "目录条目不算文件");
        assert_eq!(summary.override_bytes, 300 + 10);
        // 包里有 4 MiB 的填充：取到的字节远小于整包，说明没有整包下载。
        let read = served.load(Ordering::SeqCst);
        assert!(read < total / 20, "读了 {read} / {total} 字节");
    }

    /// 同一个 .mrpack，放在平台上读摘要与放在本地读预览，Mod 数一样：落进 mods/ 的远程文件加上两层覆盖里
    /// 直接在 mods/ 下的 .jar，同一落点只算一次。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn platform_summary_and_local_preview_count_mods_the_same_way() {
        let mut writer = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
        let options = zip::write::SimpleFileOptions::default();
        for (name, bytes) in [
            ("overrides/mods/extra.jar", &b"jar"[..]),
            ("client-overrides/mods/extra.jar", b"client jar"),
            ("client-overrides/mods/zoom.jar", b"zoom"),
            ("overrides/mods/sodium.jar", b"patched"),
            ("overrides/mods/README.md", b"read me"),
            ("overrides/mods/old/legacy.jar", b"old"),
        ] {
            writer.start_file(name, options).unwrap();
            writer.write_all(bytes).unwrap();
        }
        writer.start_file("modrinth.index.json", options).unwrap();
        writer.write_all(manifest().to_string().as_bytes()).unwrap();
        let pack = writer.finish().unwrap().into_inner();
        let tmp = tempfile::tempdir().unwrap();
        let local = tmp.path().join("同一个包.mrpack");
        std::fs::write(&local, &pack).unwrap();
        let (server, _, _) = serve(pack, true).await;
        let aurora = aurora_at(tmp.path()).with_modrinth_base(server.uri());

        let summary = aurora
            .summarize_platform_modpack(Platform::Modrinth, "1KVo5zza", "ver1")
            .await
            .unwrap();
        let preview = aurora.preview_modpack_file(&local).await.unwrap();
        assert_eq!(summary.mod_files, 4, "sodium、lithium、extra、zoom");
        assert_eq!(preview.mod_files, summary.mod_files);
        assert_eq!(preview.remote_bytes, summary.remote_bytes);
    }

    /// CurseForge 导出的 .zip：清单、一个配置与两个 mods/ 下的覆盖文件，再塞一大块不会被读到的填充。
    fn curseforge_zip(manifest: &serde_json::Value) -> Vec<u8> {
        let mut writer = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
        let deflated = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Deflated);
        let stored = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Stored);
        writer.start_file("filler.bin", stored).unwrap();
        writer.write_all(&vec![7u8; 4 * 1024 * 1024]).unwrap();
        writer
            .start_file("overrides/config/create.toml", deflated)
            .unwrap();
        writer.write_all(&[b'c'; 120]).unwrap();
        writer
            .start_file("overrides/mods/kubejs-extra.jar", stored)
            .unwrap();
        writer.write_all(&[b'j'; 30]).unwrap();
        writer
            .start_file("overrides/mods/notes.txt", stored)
            .unwrap();
        writer.write_all(&[b'n'; 6]).unwrap();
        writer.start_file("manifest.json", deflated).unwrap();
        writer.write_all(manifest.to_string().as_bytes()).unwrap();
        writer.finish().unwrap().into_inner()
    }

    fn curseforge_manifest() -> serde_json::Value {
        serde_json::json!({
            "minecraft": { "version": "1.20.1", "modLoaders": [{ "id": "forge-47.2.0", "primary": true }] },
            "manifestType": "minecraftModpack", "manifestVersion": 1,
            "name": "All of Create", "version": "2.1", "author": "樱",
            "files": [
                { "projectID": 328085, "fileID": 4_712_001, "required": true },
                { "projectID": 306612, "fileID": 4_712_002, "required": true },
                { "projectID": 457570, "fileID": 4_712_003, "required": true },
                { "projectID": 328085, "fileID": 4_712_004, "required": false }
            ],
            "overrides": "overrides"
        })
    }

    fn curseforge_file(id: u32, mod_id: u32, name: &str, length: u64) -> serde_json::Value {
        serde_json::json!({
            "id": id, "modId": mod_id, "displayName": name, "fileName": name,
            "fileLength": length, "downloadUrl": format!("https://edge.forgecdn.net/files/{id}/{name}")
        })
    }

    /// CurseForge 摘要：Mod 数按工程大类认（资源包不算），下载量由批量文件接口的大小加总；批量文件与批量
    /// 工程接口各只问一次，作者停用的文件不进请求。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn curseforge_summary_counts_mods_by_class_and_sums_file_lengths() {
        use wiremock::matchers::body_json;

        let server = MockServer::start().await;
        let pack = curseforge_zip(&curseforge_manifest());
        let total = pack.len();
        Mock::given(method("GET"))
            .and(path("/pack.zip"))
            .respond_with(RangeServer {
                body: Arc::new(pack),
                ranges: true,
                served_bytes: Arc::new(AtomicUsize::new(0)),
            })
            .mount(&server)
            .await;
        Mock::given(method("POST"))
            .and(path("/v1/mods/files"))
            .and(body_json(
                serde_json::json!({"fileIds": [4_712_001, 4_712_002, 4_712_003]}),
            ))
            .respond_with(
                ResponseTemplate::new(200).set_body_json(serde_json::json!({"data": [
                    curseforge_file(4_712_001, 328085, "create-0.5.1.jar", 13_000_000),
                    curseforge_file(4_712_002, 306612, "jei-15.2.jar", 1_250_000),
                    curseforge_file(4_712_003, 457570, "create-textures.zip", 8_000_000),
                ]})),
            )
            .expect(1)
            .mount(&server)
            .await;
        Mock::given(method("POST"))
            .and(path("/v1/mods"))
            .and(body_json(
                serde_json::json!({"modIds": [306612, 328085, 457570]}),
            ))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({"data": [
                { "id": 328085, "name": "Create", "slug": "create", "summary": "", "classId": 6 },
                { "id": 306612, "name": "JEI", "slug": "jei", "summary": "", "classId": 6 },
                { "id": 457570, "name": "Textures", "slug": "textures", "summary": "", "classId": 12 }
            ]})))
            .expect(1)
            .mount(&server)
            .await;
        let http = aurora_base::http::build_client().unwrap();
        let client = aurora_modplatform::CurseForgeClient::new(http.clone(), "k")
            .with_base_url(server.uri());

        let pack = read_remote_pack(
            &http,
            &format!("{}/pack.zip", server.uri()),
            Platform::CurseForge,
        )
        .await
        .unwrap();
        let aurora_modpack::RemoteFiles::CurseForge(refs) = &pack.manifest.remote else {
            panic!("应读出 CurseForge 清单");
        };
        let remote = crate::modpack::curseforge_remote_facts(&client, refs)
            .await
            .unwrap();
        let summary = pack.summarize(remote);

        assert_eq!(summary.format, PackFormat::CurseForge);
        assert_eq!(summary.name, "All of Create");
        assert_eq!(summary.minecraft, "1.20.1");
        assert_eq!(summary.pack_bytes, total as u64);
        assert_eq!(summary.remote_files, 3);
        assert_eq!(
            summary.mod_files, 3,
            "create 与 jei 加覆盖层的 kubejs-extra.jar；资源包工程与覆盖层的说明文件不算"
        );
        assert_eq!(summary.remote_bytes, Some(22_250_000));
        assert_eq!(
            (summary.override_files, summary.override_bytes),
            (3, 120 + 30 + 6)
        );
        server.verify().await;
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn server_without_range_support_is_refused_instead_of_downloading_the_pack() {
        let (server, _, _) = serve(mrpack(&manifest()), false).await;
        let tmp = tempfile::tempdir().unwrap();
        let aurora = aurora_at(tmp.path()).with_modrinth_base(server.uri());

        let err = aurora
            .summarize_platform_modpack(Platform::Modrinth, "1KVo5zza", "ver1")
            .await
            .unwrap_err();
        let CoreError::RemotePack { reason, .. } = err else {
            panic!("应报 RemotePack，实为 {err:?}");
        };
        assert!(reason.contains("不支持按范围读取"), "{reason}");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_file_that_is_not_a_zip_or_lacks_the_manifest_is_reported() {
        let (server, _, _) = serve(vec![0u8; 1000], true).await;
        let tmp = tempfile::tempdir().unwrap();
        let aurora = aurora_at(tmp.path()).with_modrinth_base(server.uri());
        let err = aurora
            .summarize_platform_modpack(Platform::Modrinth, "1KVo5zza", "ver1")
            .await
            .unwrap_err();
        assert!(
            matches!(&err, CoreError::RemotePack { reason, .. } if reason.contains("找不到 zip 目录")),
            "{err:?}"
        );

        let mut writer = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
        writer
            .start_file("readme.txt", zip::write::SimpleFileOptions::default())
            .unwrap();
        writer.write_all(b"hi").unwrap();
        let (server, _, _) = serve(writer.finish().unwrap().into_inner(), true).await;
        let aurora = aurora_at(tmp.path()).with_modrinth_base(server.uri());
        let err = aurora
            .summarize_platform_modpack(Platform::Modrinth, "1KVo5zza", "ver1")
            .await
            .unwrap_err();
        assert!(
            matches!(&err, CoreError::RemotePack { reason, .. } if reason.contains("modrinth.index.json")),
            "{err:?}"
        );
    }
}
