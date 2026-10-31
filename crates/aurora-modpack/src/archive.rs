//! 打开整合包压缩包：读清单、列出覆盖文件、把覆盖文件解进实例目录。

use std::collections::{HashMap, HashSet};
use std::fs::File;
use std::io::{self, BufReader, Read};
use std::path::{Path, PathBuf};

use zip::ZipArchive;
use zip::result::ZipError;

use crate::error::{Error, Result};
use crate::manifest::{CURSEFORGE_DOCUMENT, MODRINTH_DOCUMENT, PackManifest};
use crate::path::SafeRelativePath;

/// 清单正常只有几十到几百 KiB；设上限是为了让一个伪造的超大清单不能把内存吃满。
const MAX_MANIFEST_BYTES: u64 = 16 * 1024 * 1024;

/// 一个要解到实例目录的覆盖文件。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OverrideEntry {
    /// 压缩包内的条目序号。
    pub index: usize,
    /// 压缩包内的条目名（含覆盖层前缀），解压时用来核对序号没有错位。
    pub entry_name: String,
    /// 相对实例目录的落点。
    pub path: SafeRelativePath,
    /// 解压后的字节数。
    pub size: u64,
}

/// 读出来的整合包。
#[derive(Debug, Clone)]
pub struct PackArchive {
    /// 清单。
    pub manifest: PackManifest,
    /// 覆盖文件：已按层叠好，同一落点只留最上层的那一份，按条目序号排列。
    pub overrides: Vec<OverrideEntry>,
    /// 覆盖文件解压后的总字节数。
    pub overrides_bytes: u64,
}

/// 打开整合包，读清单并列出覆盖文件。不解压任何覆盖文件。
///
/// 格式按包内容认：根目录有 `modrinth.index.json` 即 Modrinth，有 `manifest.json` 即 CurseForge。
/// 扩展名只用来挡掉明显不是整合包的文件（改了扩展名的 .mrpack 照样认）。
pub fn read_pack(path: &Path) -> Result<PackArchive> {
    let extension = path
        .extension()
        .and_then(|e| e.to_str())
        .map(str::to_ascii_lowercase);
    if !matches!(extension.as_deref(), Some("mrpack" | "zip")) {
        return Err(Error::UnsupportedExtension {
            path: path.to_path_buf(),
        });
    }
    let mut archive = open(path)?;

    let manifest = if let Some(index) = archive.index_for_name(MODRINTH_DOCUMENT) {
        PackManifest::parse_modrinth(&read_manifest(
            &mut archive,
            index,
            path,
            MODRINTH_DOCUMENT,
        )?)?
    } else if let Some(index) = archive.index_for_name(CURSEFORGE_DOCUMENT) {
        PackManifest::parse_curseforge(&read_manifest(
            &mut archive,
            index,
            path,
            CURSEFORGE_DOCUMENT,
        )?)?
    } else {
        return Err(Error::ManifestMissing {
            path: path.to_path_buf(),
        });
    };

    let overrides = list_overrides(&mut archive, path, &manifest.override_layers)?;
    let overrides_bytes = overrides.iter().map(|e| e.size).sum();
    Ok(PackArchive {
        manifest,
        overrides,
        overrides_bytes,
    })
}

/// 把 [`read_pack`] 列出的覆盖文件解到 `dest_root` 下，已有同名文件直接覆盖。返回写出的文件数。
///
/// 每个条目前检查一次 `is_cancelled`，返回真即以 [`Error::Cancelled`] 中止；已写出的文件不回收，
/// 由调用方连同整个目标目录一起处理。
pub fn extract_overrides(
    pack_path: &Path,
    entries: &[OverrideEntry],
    dest_root: &Path,
    is_cancelled: &dyn Fn() -> bool,
) -> Result<usize> {
    let mut archive = open(pack_path)?;
    // 1000 个条目落在几十个目录里，逐个 create_dir_all 会把同一串目录反复 stat 上千次。
    let mut created: HashSet<PathBuf> = HashSet::new();
    for entry in entries {
        if is_cancelled() {
            return Err(Error::Cancelled);
        }
        let mut file = archive
            .by_index(entry.index)
            .map_err(|source| zip_error(pack_path, &entry.entry_name, source))?;
        if file.name() != entry.entry_name {
            return Err(corrupt(
                pack_path,
                ZipError::InvalidArchive(
                    format!("第 {} 个条目已不是 {}", entry.index, entry.entry_name).into(),
                ),
            ));
        }
        let target = entry.path.resolve_under(dest_root);
        if let Some(parent) = target.parent()
            && !created.contains(parent)
        {
            std::fs::create_dir_all(parent).map_err(|source| Error::Io {
                path: parent.to_path_buf(),
                source,
            })?;
            created.insert(parent.to_path_buf());
        }
        let mut out = File::create(&target).map_err(|source| Error::Io {
            path: target.clone(),
            source,
        })?;
        // 读侧（解压、CRC 校验）和写侧的错误分开报：前者是包坏了，后者是磁盘的问题。
        let mut buffer = [0u8; 64 * 1024];
        let mut written = 0u64;
        loop {
            let n = file
                .read(&mut buffer)
                .map_err(|source| read_error(pack_path, &entry.entry_name, source))?;
            if n == 0 {
                break;
            }
            written += n as u64;
            if written > entry.size {
                return Err(corrupt(
                    pack_path,
                    ZipError::InvalidArchive(
                        format!("{} 解压后超过声明的大小", entry.entry_name).into(),
                    ),
                ));
            }
            io::Write::write_all(&mut out, &buffer[..n]).map_err(|source| Error::Io {
                path: target.clone(),
                source,
            })?;
        }
    }
    Ok(entries.len())
}

fn open(path: &Path) -> Result<ZipArchive<BufReader<File>>> {
    let file = File::open(path).map_err(|source| Error::Io {
        path: path.to_path_buf(),
        source,
    })?;
    ZipArchive::new(BufReader::new(file)).map_err(|source| corrupt(path, source))
}

fn corrupt(path: &Path, source: ZipError) -> Error {
    Error::Corrupt {
        path: path.to_path_buf(),
        source,
    }
}

/// 打开条目失败的归类。压缩方式不支持单独报：包没坏，重新下载同一个文件没用，要换作者发布的原始文件。
fn zip_error(path: &Path, entry: &str, source: ZipError) -> Error {
    match source {
        ZipError::CompressionMethodNotSupported(method) => unsupported(path, entry, method),
        source => corrupt(path, source),
    }
}

/// 读条目内容失败的归类。zip 把解压阶段的 [`ZipError`] 包进 `io::Error` 往外抛，先拆出来再按
/// [`zip_error`] 的口径分。
fn read_error(path: &Path, entry: &str, source: io::Error) -> Error {
    if let Some(ZipError::CompressionMethodNotSupported(method)) = source
        .get_ref()
        .and_then(|inner| inner.downcast_ref::<ZipError>())
    {
        return unsupported(path, entry, *method);
    }
    corrupt(path, ZipError::Io(source))
}

fn unsupported(path: &Path, entry: &str, method: u16) -> Error {
    Error::UnsupportedCompression {
        path: path.to_path_buf(),
        entry: entry.to_owned(),
        method,
    }
}

fn read_manifest(
    archive: &mut ZipArchive<BufReader<File>>,
    index: usize,
    path: &Path,
    document: &'static str,
) -> Result<Vec<u8>> {
    let file = archive
        .by_index(index)
        .map_err(|source| zip_error(path, document, source))?;
    let mut bytes = Vec::new();
    file.take(MAX_MANIFEST_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|source| read_error(path, document, source))?;
    if bytes.len() as u64 > MAX_MANIFEST_BYTES {
        return Err(Error::invalid(document, "清单超过 16 MiB"));
    }
    Ok(bytes)
}

/// 列覆盖文件时需要的条目元数据。
struct EntryMeta {
    name: String,
    is_dir: bool,
    is_symlink: bool,
    size: u64,
}

fn list_overrides(
    archive: &mut ZipArchive<BufReader<File>>,
    path: &Path,
    layers: &[String],
) -> Result<Vec<OverrideEntry>> {
    // 元数据用 by_index_raw 读，不建解压器：不在覆盖层里的条目（modlist.html 之类）用了什么压缩方式都与
    // 安装无关，不该因为它们拒收整个包。每个条目只读一遍，再按层筛。
    let mut metas = Vec::with_capacity(archive.len());
    for index in 0..archive.len() {
        let file = archive
            .by_index_raw(index)
            .map_err(|source| corrupt(path, source))?;
        metas.push(EntryMeta {
            name: file.name().to_owned(),
            is_dir: file.is_dir(),
            is_symlink: file.is_symlink(),
            size: file.size(),
        });
    }

    // 落点比较键 -> 条目。上层覆盖下层，同一层里撞车说明包本身有问题。
    let mut merged: HashMap<String, OverrideEntry> = HashMap::new();
    for layer in layers {
        let mut in_layer: HashSet<String> = HashSet::new();
        for (index, meta) in metas.iter().enumerate() {
            let Some(relative) = meta.name.strip_prefix(layer.as_str()) else {
                continue;
            };
            if relative.is_empty() || meta.is_dir {
                continue;
            }
            if meta.is_symlink {
                return Err(Error::SymlinkEntry {
                    path: meta.name.clone(),
                });
            }
            let safe = SafeRelativePath::new(relative).map_err(|source| Error::UnsafePath {
                path: meta.name.clone(),
                source,
            })?;
            let key = safe.comparison_key();
            if !in_layer.insert(key.clone()) {
                return Err(Error::DuplicatePath {
                    path: meta.name.clone(),
                });
            }
            merged.insert(
                key,
                OverrideEntry {
                    index,
                    entry_name: meta.name.clone(),
                    path: safe,
                    size: meta.size,
                },
            );
        }
    }
    let mut entries: Vec<OverrideEntry> = merged.into_values().collect();
    entries.sort_by_key(|e| e.index);

    // 真正要解的条目先按解压方式打开一次：压缩方式不支持、加密这类问题在读包时就报，不拖到装到一半。
    for entry in &entries {
        archive
            .by_index(entry.index)
            .map_err(|source| zip_error(path, &entry.entry_name, source))?;
    }
    Ok(entries)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn read_errors_wrapping_an_unsupported_method_map_to_unsupported_compression() {
        let pack = Path::new("pack.zip");
        let wrapped = io::Error::from(ZipError::CompressionMethodNotSupported(93));
        assert!(matches!(
            read_error(pack, "overrides/a.txt", wrapped),
            Error::UnsupportedCompression { path, entry, method: 93 }
                if path == pack && entry == "overrides/a.txt"
        ));

        // 别的解压错误（CRC 不对、数据截断）仍然算包损坏。
        let crc = io::Error::new(io::ErrorKind::InvalidData, "Invalid checksum");
        assert!(matches!(
            read_error(pack, "overrides/a.txt", crc),
            Error::Corrupt { .. }
        ));
        let invalid = io::Error::from(ZipError::InvalidArchive("bad".into()));
        assert!(matches!(
            read_error(pack, "overrides/a.txt", invalid),
            Error::Corrupt { .. }
        ));
        assert!(matches!(
            zip_error(pack, "x", ZipError::CompressionMethodNotSupported(12)),
            Error::UnsupportedCompression { method: 12, .. }
        ));
        assert!(matches!(
            zip_error(pack, "x", ZipError::FileNotFound),
            Error::Corrupt { .. }
        ));
    }
}
