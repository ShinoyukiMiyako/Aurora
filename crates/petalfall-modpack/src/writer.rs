//! 把一份导出清单写成 Modrinth `.mrpack`。
//!
//! 包里两部分：根目录的 `modrinth.index.json` 列出能从平台下载的文件（路径、sha1 与 sha512、下载地址、
//! 大小），`overrides/` 装其余要原样带上的文件。写完立刻用读包的同一套代码读回来逐项比对：交出去的包
//! 在别人导入时才出问题，比当场报错难查得多。任何一步失败（含取消）都删掉产物，不留半个包。
//!
//! 同步阻塞 IO，调用方应放进 `spawn_blocking`。

use std::collections::{BTreeMap, HashSet};
use std::fs::File;
use std::io::{self, BufWriter, Read, Write};
use std::path::{Path, PathBuf};

use serde::Serialize;
use serde::ser::SerializeMap;
use zip::write::SimpleFileOptions;
use zip::{CompressionMethod, ZipWriter};

use crate::archive::read_pack;
use crate::error::{Error, Result};
use crate::manifest::{
    MODRINTH_DOCUMENT, MODRINTH_PLATFORM_HOSTS, PackFormat, PackLoader, RemoteFiles,
    check_download_url, loader_dependency_key,
};
use crate::path::SafeRelativePath;

/// 导出时允许写进清单的下载主机：只有格式约定的四个。CurseForge 的分发主机读包时认，导出一律不写，
/// 别的启动器与 Modrinth 都可能拒收这类地址。
pub const EXPORT_DOWNLOAD_HOSTS: &[&str] = MODRINTH_PLATFORM_HOSTS;

/// 流式拷贝的块大小：取消与进度都按块观察，64 KiB 让大文件也能在毫秒级停下。
const CHUNK: usize = 64 * 1024;

/// 单个条目超过这个大小就按 ZIP64 写。界线取 4 GiB 的一半：游戏运行时文件可能边写边变大，压缩后
/// 也可能比原文略大，留足余量，免得写到一半才因为没开 ZIP64 失败。
const LARGE_FILE_THRESHOLD: u64 = zip::ZIP64_BYTES_THR / 2;

/// 覆盖文件在包里的目录前缀。
const OVERRIDES_PREFIX: &str = "overrides/";

/// 停用 Mod 的文件名后缀。本 crate 不依赖 Mod 平台层，这里只用来判断压缩方式，不参与任何落点计算。
const DISABLED_SUFFIX: &str = ".disabled";

/// 地址能否写进导出的清单：https、不带用户凭据、主机在 [`EXPORT_DOWNLOAD_HOSTS`] 里。
pub fn is_export_download_url(url: &str) -> bool {
    check_download_url(url, &[EXPORT_DOWNLOAD_HOSTS]).is_ok()
}

/// 清单里的一个可下载文件。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IndexFile {
    /// 相对实例目录的落点。
    pub path: SafeRelativePath,
    /// 40 位十六进制 sha1（大小写不限，写出时统一小写）。
    pub sha1: String,
    /// 128 位十六进制 sha512（大小写不限，写出时统一小写）。
    pub sha512: String,
    /// 字节数。
    pub size: u64,
    /// 下载地址，按顺序尝试。
    pub downloads: Vec<String>,
}

/// 要原样打进包里的一个文件。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OverrideFile {
    /// 相对实例目录的路径；包里落在 `overrides/<path>`。
    pub path: SafeRelativePath,
    /// 本地源文件。
    pub source: PathBuf,
}

/// 一次导出要写的全部内容。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExportPack {
    /// 整合包名。
    pub name: String,
    /// 整合包版本（写进 `versionId`）。
    pub version_id: String,
    /// 简介；`None` 时不写这个字段。
    pub summary: Option<String>,
    /// MC 版本。
    pub minecraft: String,
    /// 加载器；原版为 `None`。
    pub loader: Option<PackLoader>,
    /// 可下载文件，按此顺序写进清单。
    pub files: Vec<IndexFile>,
    /// 覆盖文件，按此顺序写进包。
    pub overrides: Vec<OverrideFile>,
}

/// 写包进度。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct WriteProgress {
    /// 已写完的覆盖文件数。
    pub files_done: u64,
    /// 覆盖文件总数。
    pub files_total: u64,
    /// 已写入的覆盖文件字节。
    pub bytes_done: u64,
    /// 覆盖文件总字节（开写前量的；最后一次回调换成实际写入的总量）。
    pub bytes_total: u64,
}

/// 写成的包。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WrittenPack {
    /// 包文件的字节数。
    pub bytes: u64,
    /// 清单里的可下载文件数。
    pub index_files: usize,
    /// 覆盖文件数。
    pub override_files: usize,
}

/// 把 `pack` 写到 `dest`，写完读回来自校验。
///
/// 写前先校验清单（不创建任何文件）；之后的任何失败，包括 `is_cancelled` 返回真（每 64 KiB 查一次）
/// 与回读不对，都会先删掉 `dest` 再返回原错误。`on_progress` 在每块之后与结束时回调，最后一次的
/// `bytes_done` 等于 `bytes_total`。
pub fn write_pack(
    pack: &ExportPack,
    dest: &Path,
    is_cancelled: &dyn Fn() -> bool,
    on_progress: &mut dyn FnMut(WriteProgress),
) -> Result<WrittenPack> {
    let index = validate(pack)?;
    let mut sizes = Vec::with_capacity(pack.overrides.len());
    for file in &pack.overrides {
        let meta = std::fs::metadata(&file.source).map_err(|source| Error::Io {
            path: file.source.clone(),
            source,
        })?;
        sizes.push(meta.len());
    }
    let bytes_total: u64 = sizes.iter().sum();

    let file = File::create(dest).map_err(|source| Error::Io {
        path: dest.to_path_buf(),
        source,
    })?;
    let outcome = write_archive(
        file,
        pack,
        &index,
        &sizes,
        bytes_total,
        dest,
        is_cancelled,
        on_progress,
    )
    .and_then(|(written, bytes)| {
        verify(pack, dest, &written)?;
        Ok(WrittenPack {
            bytes,
            index_files: pack.files.len(),
            override_files: written.len(),
        })
    });
    if outcome.is_err() {
        remove_failed(dest);
    }
    outcome
}

/// 失败的产物删掉；删不掉只记日志，返回给调用方的仍是导致失败的那个错误。
fn remove_failed(dest: &Path) {
    if let Err(err) = std::fs::remove_file(dest)
        && err.kind() != io::ErrorKind::NotFound
    {
        tracing::error!(path = %dest.display(), error = %err, "导出失败后未能删除写了一半的整合包");
    }
}

/// 写前校验，产出要写的清单 JSON。
fn validate(pack: &ExportPack) -> Result<Vec<u8>> {
    let name = required(&pack.name, "name")?;
    let version_id = required(&pack.version_id, "versionId")?;
    let minecraft = required(&pack.minecraft, "dependencies.minecraft")?;
    let loader = pack
        .loader
        .as_ref()
        .map(|loader| {
            required(&loader.version, loader_dependency_key(loader.kind))
                .map(|version| (loader_dependency_key(loader.kind), version))
        })
        .transpose()?;

    let mut seen = HashSet::new();
    let mut entries = Vec::with_capacity(pack.files.len());
    for file in &pack.files {
        if !seen.insert(file.path.comparison_key()) {
            return Err(Error::DuplicatePath {
                path: file.path.as_str().to_owned(),
            });
        }
        let sha1 = hex_digest(&file.sha1, 40, &file.path, "sha1")?;
        let sha512 = hex_digest(&file.sha512, 128, &file.path, "sha512")?;
        if file.downloads.is_empty() {
            return Err(Error::invalid(
                MODRINTH_DOCUMENT,
                format!("{} 没有下载地址", file.path),
            ));
        }
        entries.push(IndexEntry {
            path: file.path.as_str(),
            hashes: Hashes { sha1, sha512 },
            downloads: &file.downloads,
            file_size: file.size,
        });
    }
    for file in &pack.overrides {
        if !seen.insert(file.path.comparison_key()) {
            return Err(Error::DuplicatePath {
                path: file.path.as_str().to_owned(),
            });
        }
    }

    let document = IndexDocument {
        format_version: 1,
        game: "minecraft",
        version_id,
        name,
        summary: pack.summary.as_deref(),
        files: entries,
        dependencies: Dependencies { minecraft, loader },
    };
    serde_json::to_vec(&document).map_err(|err| Error::invalid(MODRINTH_DOCUMENT, err.to_string()))
}

fn required<'a>(value: &'a str, field: &str) -> Result<&'a str> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Err(Error::invalid(MODRINTH_DOCUMENT, format!("{field} 为空")));
    }
    Ok(trimmed)
}

fn hex_digest(raw: &str, len: usize, path: &SafeRelativePath, algorithm: &str) -> Result<String> {
    let lower = raw.to_ascii_lowercase();
    if lower.len() != len || !lower.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(Error::invalid(
            MODRINTH_DOCUMENT,
            format!("{path} 的 {algorithm} 不是 {len} 位十六进制"),
        ));
    }
    Ok(lower)
}

/// 写出整个压缩包，返回每个覆盖条目实际写入的字节数与包文件的总字节数。写入器在这里收尾或随错误
/// 一起丢弃，返回时文件句柄已关，调用方才删得掉它。
#[allow(clippy::too_many_arguments)]
fn write_archive(
    file: File,
    pack: &ExportPack,
    index: &[u8],
    sizes: &[u64],
    bytes_total: u64,
    dest: &Path,
    is_cancelled: &dyn Fn() -> bool,
    on_progress: &mut dyn FnMut(WriteProgress),
) -> Result<(BTreeMap<String, u64>, u64)> {
    let io_error = |source: io::Error| Error::Io {
        path: dest.to_path_buf(),
        source,
    };
    let zip_error = |err: zip::result::ZipError| io_error(io::Error::from(err));

    let mut writer = ZipWriter::new(BufWriter::new(file));
    let deflated = SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);
    writer
        .start_file(MODRINTH_DOCUMENT, deflated)
        .map_err(zip_error)?;
    writer.write_all(index).map_err(io_error)?;

    let files_total = pack.overrides.len() as u64;
    let mut progress = WriteProgress {
        files_done: 0,
        files_total,
        bytes_done: 0,
        bytes_total,
    };
    let mut written = BTreeMap::new();
    let mut buffer = vec![0u8; CHUNK];
    for (file, &size) in pack.overrides.iter().zip(sizes) {
        let options = SimpleFileOptions::default()
            .compression_method(compression_for(file.path.as_str()))
            .large_file(size >= LARGE_FILE_THRESHOLD);
        writer
            .start_file(format!("{OVERRIDES_PREFIX}{}", file.path), options)
            .map_err(zip_error)?;
        let mut source = File::open(&file.source).map_err(|source| Error::Io {
            path: file.source.clone(),
            source,
        })?;
        let mut copied = 0u64;
        loop {
            if is_cancelled() {
                return Err(Error::Cancelled);
            }
            let n = source.read(&mut buffer).map_err(|err| Error::Io {
                path: file.source.clone(),
                source: err,
            })?;
            if n == 0 {
                break;
            }
            writer.write_all(&buffer[..n]).map_err(io_error)?;
            copied += n as u64;
            progress.bytes_done += n as u64;
            on_progress(progress);
        }
        written.insert(file.path.as_str().to_owned(), copied);
        progress.files_done += 1;
        on_progress(progress);
    }

    let buffered = writer.finish().map_err(zip_error)?;
    let file = buffered
        .into_inner()
        .map_err(|err| io_error(err.into_error()))?;
    file.sync_all().map_err(io_error)?;
    let bytes = file.metadata().map_err(io_error)?.len();

    // 源文件在量过大小之后可能变了，进度的终点以实际写入的为准。
    progress.bytes_total = progress.bytes_done;
    on_progress(progress);
    Ok((written, bytes))
}

/// jar、zip 与整合包本身已经是压缩过的，再压一遍只费时间。停用的 Mod 仍是 jar。
fn compression_for(path: &str) -> CompressionMethod {
    let lower = path.to_ascii_lowercase();
    let name = lower.strip_suffix(DISABLED_SUFFIX).unwrap_or(&lower);
    if [".jar", ".zip", ".mrpack"]
        .iter()
        .any(|ext| name.ends_with(ext))
    {
        CompressionMethod::Stored
    } else {
        CompressionMethod::Deflated
    }
}

/// 读回刚写的包，与要写的内容逐项比对。
fn verify(pack: &ExportPack, dest: &Path, written: &BTreeMap<String, u64>) -> Result<()> {
    let fail = |reason: String| Error::ExportCheckFailed {
        path: dest.to_path_buf(),
        reason,
    };
    let archive = read_pack(dest).map_err(|err| fail(petalfall_base::error_with_causes(&err)))?;
    let manifest = &archive.manifest;
    if manifest.format != PackFormat::Modrinth {
        return Err(fail("读回来不是 Modrinth 格式".to_owned()));
    }
    if manifest.name != pack.name.trim() {
        return Err(fail(format!("名称读回来是 {}", manifest.name)));
    }
    if manifest.version.as_deref() != Some(pack.version_id.trim()) {
        return Err(fail(format!("版本读回来是 {:?}", manifest.version)));
    }
    if manifest.minecraft != pack.minecraft.trim() {
        return Err(fail(format!("游戏版本读回来是 {}", manifest.minecraft)));
    }
    let expected_loader = pack.loader.as_ref().map(|l| PackLoader {
        kind: l.kind,
        version: l.version.trim().to_owned(),
    });
    if manifest.loader != expected_loader {
        return Err(fail(format!("加载器读回来是 {:?}", manifest.loader)));
    }

    let RemoteFiles::Modrinth(files) = &manifest.remote else {
        return Err(fail("读回来的远程文件不是 Modrinth 格式".to_owned()));
    };
    if files.len() != pack.files.len() {
        return Err(fail(format!(
            "清单里有 {} 个文件，要写的是 {} 个",
            files.len(),
            pack.files.len()
        )));
    }
    for (read, expected) in files.iter().zip(&pack.files) {
        if read.path != expected.path
            || read.sha1 != expected.sha1.to_ascii_lowercase()
            || read.size != expected.size
            || read.urls != expected.downloads
        {
            return Err(fail(format!("{} 读回来与要写的不一致", expected.path)));
        }
        if let Some(url) = read.urls.iter().find(|url| !is_export_download_url(url)) {
            return Err(fail(format!(
                "{} 的下载地址 {url} 不能写进导出的整合包",
                expected.path
            )));
        }
    }

    let overrides: BTreeMap<String, u64> = archive
        .overrides
        .iter()
        .map(|entry| (entry.path.as_str().to_owned(), entry.size))
        .collect();
    if &overrides != written {
        return Err(fail(format!(
            "覆盖文件读回来 {} 个，写入的是 {} 个，或有大小对不上",
            overrides.len(),
            written.len()
        )));
    }
    Ok(())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct IndexDocument<'a> {
    format_version: u32,
    game: &'static str,
    version_id: &'a str,
    name: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    summary: Option<&'a str>,
    files: Vec<IndexEntry<'a>>,
    dependencies: Dependencies<'a>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct IndexEntry<'a> {
    path: &'a str,
    hashes: Hashes,
    downloads: &'a [String],
    file_size: u64,
}

#[derive(Serialize)]
struct Hashes {
    sha1: String,
    sha512: String,
}

/// `minecraft` 在前、加载器在后。键是动态的，又不能交给按字典序排的映射，所以手写序列化。
struct Dependencies<'a> {
    minecraft: &'a str,
    loader: Option<(&'static str, &'a str)>,
}

impl Serialize for Dependencies<'_> {
    fn serialize<S: serde::Serializer>(
        &self,
        serializer: S,
    ) -> std::result::Result<S::Ok, S::Error> {
        let mut map = serializer.serialize_map(Some(1 + usize::from(self.loader.is_some())))?;
        map.serialize_entry("minecraft", self.minecraft)?;
        if let Some((key, version)) = self.loader {
            map.serialize_entry(key, version)?;
        }
        map.end()
    }
}

#[cfg(test)]
mod tests {
    use std::cell::Cell;

    use super::*;
    use crate::manifest::PackLoaderKind;

    const SHA1: &str = "0F4A890D07402280686A518579FA9FA02309E315";
    const CDN: &str = "https://cdn.modrinth.com/data/AANobbMI/versions/abc/sodium.jar";

    fn sha512() -> String {
        "AB".repeat(64)
    }

    fn path(raw: &str) -> SafeRelativePath {
        SafeRelativePath::new(raw).unwrap()
    }

    fn index_file(at: &str, url: &str) -> IndexFile {
        IndexFile {
            path: path(at),
            sha1: SHA1.to_owned(),
            sha512: sha512(),
            size: 4096,
            downloads: vec![url.to_owned()],
        }
    }

    fn pack(loader: Option<PackLoader>) -> ExportPack {
        ExportPack {
            name: "樱花林".to_owned(),
            version_id: "1.2.0".to_owned(),
            summary: None,
            minecraft: "1.21.1".to_owned(),
            loader,
            files: vec![index_file("mods/sodium.jar", CDN)],
            overrides: Vec::new(),
        }
    }

    fn never() -> bool {
        false
    }

    fn write(pack: &ExportPack, dest: &Path) -> Result<WrittenPack> {
        write_pack(pack, dest, &never, &mut |_| {})
    }

    fn index_json(dest: &Path) -> serde_json::Value {
        let mut archive = zip::ZipArchive::new(File::open(dest).unwrap()).unwrap();
        let mut text = String::new();
        archive
            .by_name(MODRINTH_DOCUMENT)
            .unwrap()
            .read_to_string(&mut text)
            .unwrap();
        serde_json::from_str(&text).unwrap()
    }

    fn keys(value: &serde_json::Value) -> Vec<&str> {
        value
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect()
    }

    #[test]
    fn every_loader_round_trips_through_read_pack() {
        let tmp = tempfile::tempdir().unwrap();
        for (kind, version) in [
            (PackLoaderKind::Fabric, "0.16.9"),
            (PackLoaderKind::Quilt, "0.27.1-beta.1"),
            (PackLoaderKind::Forge, "47.3.0"),
            (PackLoaderKind::NeoForge, "21.1.77"),
        ] {
            let loader = PackLoader {
                kind,
                version: version.to_owned(),
            };
            let dest = tmp.path().join(format!("{kind:?}.mrpack"));
            let written = write(&pack(Some(loader.clone())), &dest).unwrap();
            assert_eq!(written.index_files, 1);
            assert_eq!(written.override_files, 0);
            assert_eq!(written.bytes, std::fs::metadata(&dest).unwrap().len());

            let read = read_pack(&dest).unwrap();
            assert_eq!(read.manifest.loader, Some(loader), "{kind:?}");
            assert_eq!(read.manifest.name, "樱花林");
            assert_eq!(read.manifest.version.as_deref(), Some("1.2.0"));
            assert_eq!(read.manifest.minecraft, "1.21.1");
            let index = index_json(&dest);
            let mut deps = keys(&index["dependencies"]);
            deps.sort_unstable();
            let mut expected = vec!["minecraft", loader_dependency_key(kind)];
            expected.sort_unstable();
            assert_eq!(deps, expected);
            let text = index_text(&dest);
            let loader_at = text
                .find(&format!("\"{}\"", loader_dependency_key(kind)))
                .unwrap();
            assert!(
                text.find("\"minecraft\"").unwrap() < loader_at,
                "minecraft 在前：{text}"
            );
        }
        let vanilla = tmp.path().join("vanilla.mrpack");
        write(&pack(None), &vanilla).unwrap();
        assert_eq!(read_pack(&vanilla).unwrap().manifest.loader, None);
        assert_eq!(
            keys(&index_json(&vanilla)["dependencies"]),
            vec!["minecraft"]
        );
    }

    fn index_text(dest: &Path) -> String {
        let mut archive = zip::ZipArchive::new(File::open(dest).unwrap()).unwrap();
        let mut text = String::new();
        archive
            .by_name(MODRINTH_DOCUMENT)
            .unwrap()
            .read_to_string(&mut text)
            .unwrap();
        text
    }

    #[test]
    fn index_has_lowercase_hashes_no_env_and_summary_only_when_given() {
        let tmp = tempfile::tempdir().unwrap();
        let dest = tmp.path().join("a.mrpack");
        write(&pack(None), &dest).unwrap();
        let index = index_json(&dest);
        let mut top = keys(&index);
        top.sort_unstable();
        assert_eq!(
            top,
            vec![
                "dependencies",
                "files",
                "formatVersion",
                "game",
                "name",
                "versionId"
            ]
        );
        assert_eq!(index["formatVersion"], 1);
        assert_eq!(index["game"], "minecraft");
        let file = &index["files"][0];
        let mut file_keys = keys(file);
        file_keys.sort_unstable();
        assert_eq!(file_keys, vec!["downloads", "fileSize", "hashes", "path"]);
        let mut hash_keys = keys(&file["hashes"]);
        hash_keys.sort_unstable();
        assert_eq!(hash_keys, vec!["sha1", "sha512"]);
        assert_eq!(file["hashes"]["sha1"], SHA1.to_ascii_lowercase());
        assert_eq!(file["hashes"]["sha512"], "ab".repeat(64));
        assert_eq!(file["fileSize"], 4096);
        assert_eq!(file["downloads"], serde_json::json!([CDN]));
        assert!(!index_text(&dest).contains(['\n', ' ']), "紧凑 JSON");

        let mut with_summary = pack(None);
        with_summary.summary = Some("一句话介绍".to_owned());
        let dest = tmp.path().join("b.mrpack");
        write(&with_summary, &dest).unwrap();
        assert_eq!(index_json(&dest)["summary"], "一句话介绍");
        assert_eq!(
            read_pack(&dest).unwrap().manifest.summary.as_deref(),
            Some("一句话介绍")
        );
        let text = index_text(&dest);
        let at: Vec<usize> = [
            "\"formatVersion\"",
            "\"game\"",
            "\"versionId\"",
            "\"name\"",
            "\"summary\"",
            "\"files\"",
            "\"dependencies\"",
        ]
        .iter()
        .map(|key| text.find(key).unwrap_or_else(|| panic!("缺 {key}")))
        .collect();
        assert!(at.windows(2).all(|w| w[0] < w[1]), "字段顺序：{text}");
        let file_at: Vec<usize> = [
            "\"path\"",
            "\"hashes\"",
            "\"sha1\"",
            "\"sha512\"",
            "\"downloads\"",
            "\"fileSize\"",
        ]
        .iter()
        .map(|key| text.find(key).unwrap())
        .collect();
        assert!(
            file_at.windows(2).all(|w| w[0] < w[1]),
            "文件字段顺序：{text}"
        );
    }

    #[test]
    fn non_export_hosts_fail_the_read_back_and_leave_nothing() {
        let tmp = tempfile::tempdir().unwrap();
        for url in [
            "http://cdn.modrinth.com/data/a/versions/b/a.jar",
            "https://edge.forgecdn.net/files/1/2/a.jar",
        ] {
            let mut bad = pack(None);
            bad.files = vec![index_file("mods/a.jar", CDN), index_file("mods/b.jar", url)];
            let dest = tmp.path().join("bad.mrpack");
            let err = write(&bad, &dest).unwrap_err();
            assert!(
                matches!(&err, Error::ExportCheckFailed { path, .. } if path == &dest),
                "{url}: {err:?}"
            );
            assert!(!dest.exists(), "{url}: 没通过回读的包应删掉");
        }
        assert!(is_export_download_url(CDN));
        for host in ["github.com", "raw.githubusercontent.com", "gitlab.com"] {
            assert!(is_export_download_url(&format!("https://{host}/a/b.jar")));
        }
        for bad in [
            "https://mediafilez.forgecdn.net/files/1/2/a.jar",
            "https://user:pw@cdn.modrinth.com/a.jar",
            "https://example.com/a.jar",
            "ftp://cdn.modrinth.com/a.jar",
            "不是地址",
        ] {
            assert!(!is_export_download_url(bad), "{bad}");
        }
    }

    #[test]
    fn cancelling_mid_copy_returns_cancelled_and_removes_the_file() {
        let tmp = tempfile::tempdir().unwrap();
        let source = tmp.path().join("big.bin");
        std::fs::write(&source, vec![7u8; 200 * 1024]).unwrap();
        for nth in [1u32, 2, 3, 5] {
            let mut with_override = pack(None);
            with_override.overrides = vec![OverrideFile {
                path: path("config/big.bin"),
                source: source.clone(),
            }];
            let dest = tmp.path().join(format!("cancel-{nth}.mrpack"));
            let calls = Cell::new(0u32);
            let is_cancelled = || {
                calls.set(calls.get() + 1);
                calls.get() >= nth
            };
            let err = write_pack(&with_override, &dest, &is_cancelled, &mut |_| {}).unwrap_err();
            assert!(matches!(err, Error::Cancelled), "第 {nth} 次: {err:?}");
            assert_eq!(calls.get(), nth, "查到真之后立刻停下");
            assert!(!dest.exists(), "第 {nth} 次取消后不留文件");
        }
    }

    #[test]
    fn case_insensitive_duplicate_targets_are_refused_before_creating_the_file() {
        let tmp = tempfile::tempdir().unwrap();
        let source = tmp.path().join("x.jar");
        std::fs::write(&source, b"jar").unwrap();
        let dest = tmp.path().join("dup.mrpack");

        let mut across = pack(None);
        across.overrides = vec![OverrideFile {
            path: path("Mods/Sodium.jar"),
            source: source.clone(),
        }];
        let err = write(&across, &dest).unwrap_err();
        assert!(
            matches!(&err, Error::DuplicatePath { path } if path == "Mods/Sodium.jar"),
            "{err:?}"
        );
        assert!(!dest.exists());

        let mut within = pack(None);
        within.overrides = vec![
            OverrideFile {
                path: path("config/a.toml"),
                source: source.clone(),
            },
            OverrideFile {
                path: path("CONFIG/A.TOML"),
                source,
            },
        ];
        assert!(matches!(
            write(&within, &dest).unwrap_err(),
            Error::DuplicatePath { .. }
        ));
        assert!(!dest.exists());
    }

    #[test]
    fn invalid_fields_are_refused_before_creating_the_file() {
        let tmp = tempfile::tempdir().unwrap();
        let dest = tmp.path().join("bad.mrpack");
        let cases: Vec<(&str, ExportPack)> = vec![
            (
                "空名称",
                ExportPack {
                    name: "  ".into(),
                    ..pack(None)
                },
            ),
            (
                "空版本",
                ExportPack {
                    version_id: "".into(),
                    ..pack(None)
                },
            ),
            (
                "空游戏版本",
                ExportPack {
                    minecraft: " ".into(),
                    ..pack(None)
                },
            ),
            (
                "空加载器版本",
                pack(Some(PackLoader {
                    kind: PackLoaderKind::Fabric,
                    version: " ".into(),
                })),
            ),
            (
                "sha1 39 位",
                ExportPack {
                    files: vec![IndexFile {
                        sha1: SHA1[..39].to_owned(),
                        ..index_file("mods/a.jar", CDN)
                    }],
                    ..pack(None)
                },
            ),
            (
                "sha512 非十六进制",
                ExportPack {
                    files: vec![IndexFile {
                        sha512: "zz".repeat(64),
                        ..index_file("mods/a.jar", CDN)
                    }],
                    ..pack(None)
                },
            ),
            (
                "没有下载地址",
                ExportPack {
                    files: vec![IndexFile {
                        downloads: Vec::new(),
                        ..index_file("mods/a.jar", CDN)
                    }],
                    ..pack(None)
                },
            ),
        ];
        for (label, bad) in cases {
            let err = write(&bad, &dest).unwrap_err();
            assert!(
                matches!(
                    err,
                    Error::ManifestInvalid {
                        document: "modrinth.index.json",
                        ..
                    }
                ),
                "{label}: {err:?}"
            );
            assert!(!dest.exists(), "{label}");
        }
    }

    #[test]
    fn overrides_round_trip_with_progress_ending_at_the_total() {
        let tmp = tempfile::tempdir().unwrap();
        let seed = time_seed();
        let mut rng = Rng(seed);
        let mut overrides = Vec::new();
        let mut expected = BTreeMap::new();
        for (i, at) in [
            "config/sodium-options.json",
            "mods/local.jar",
            "mods/old.jar.disabled",
            "options.txt",
            "config/empty.toml",
        ]
        .into_iter()
        .enumerate()
        {
            let size = if at.ends_with("empty.toml") {
                0
            } else {
                (rng.next() % (150 * 1024)) as usize + i
            };
            let source = tmp.path().join(format!("src-{i}"));
            std::fs::write(&source, vec![b'a' + i as u8; size]).unwrap();
            expected.insert(at.to_owned(), size as u64);
            overrides.push(OverrideFile {
                path: path(at),
                source,
            });
        }
        let mut with_overrides = pack(None);
        with_overrides.overrides = overrides;
        let dest = tmp.path().join("full.mrpack");
        let mut seen = Vec::new();
        let written = write_pack(&with_overrides, &dest, &never, &mut |p| seen.push(p)).unwrap();
        assert_eq!(written.override_files, 5, "seed {seed}");

        let last = *seen.last().unwrap();
        let total: u64 = expected.values().sum();
        assert_eq!(last.bytes_done, last.bytes_total, "seed {seed}");
        assert_eq!(last.bytes_total, total, "seed {seed}");
        assert_eq!((last.files_done, last.files_total), (5, 5));
        assert!(
            seen.windows(2).all(|w| w[0].bytes_done <= w[1].bytes_done),
            "进度只进不退"
        );

        let read = read_pack(&dest).unwrap();
        let got: BTreeMap<String, u64> = read
            .overrides
            .iter()
            .map(|e| (e.path.as_str().to_owned(), e.size))
            .collect();
        assert_eq!(got, expected, "seed {seed}");

        let mut archive = zip::ZipArchive::new(File::open(&dest).unwrap()).unwrap();
        for (name, method) in [
            ("overrides/mods/local.jar", CompressionMethod::Stored),
            ("overrides/mods/old.jar.disabled", CompressionMethod::Stored),
            ("overrides/options.txt", CompressionMethod::Deflated),
            (MODRINTH_DOCUMENT, CompressionMethod::Deflated),
        ] {
            assert_eq!(
                archive.by_name(name).unwrap().compression(),
                method,
                "{name}"
            );
        }
        let mut options = String::new();
        archive
            .by_name("overrides/options.txt")
            .unwrap()
            .read_to_string(&mut options)
            .unwrap();
        assert_eq!(options.len() as u64, expected["options.txt"]);
        assert!(options.bytes().all(|b| b == b'a' + 3));
    }

    #[test]
    fn empty_pack_reports_a_final_progress_of_zero_over_zero() {
        let tmp = tempfile::tempdir().unwrap();
        let mut empty = pack(None);
        empty.files.clear();
        let dest = tmp.path().join("empty.mrpack");
        let mut seen = Vec::new();
        write_pack(&empty, &dest, &never, &mut |p| seen.push(p)).unwrap();
        assert_eq!(
            seen,
            vec![WriteProgress {
                files_done: 0,
                files_total: 0,
                bytes_done: 0,
                bytes_total: 0
            }]
        );
        assert!(index_json(&dest)["files"].as_array().unwrap().is_empty());
    }

    #[test]
    fn missing_override_source_fails_without_creating_the_file() {
        let tmp = tempfile::tempdir().unwrap();
        let mut broken = pack(None);
        let gone = tmp.path().join("gone.txt");
        broken.overrides = vec![OverrideFile {
            path: path("config/gone.txt"),
            source: gone.clone(),
        }];
        let dest = tmp.path().join("x.mrpack");
        let err = write(&broken, &dest).unwrap_err();
        assert!(
            matches!(&err, Error::Io { path, .. } if path == &gone),
            "{err:?}"
        );
        assert!(!dest.exists());
    }

    fn time_seed() -> u64 {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos() as u64
            | 1
    }

    /// 测试用的 xorshift：本 crate 不依赖随机数库，造随机大小够用了。
    struct Rng(u64);

    impl Rng {
        fn next(&mut self) -> u64 {
            self.0 ^= self.0 << 13;
            self.0 ^= self.0 >> 7;
            self.0 ^= self.0 << 17;
            self.0
        }
    }
}
