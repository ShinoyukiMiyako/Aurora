//! 原版材质的磁盘缓存：`<缓存目录>/vanilla-art/<材质源版本>/textures/<路径>.png` + `manifest.json`。
//!
//! 选定材质源后，缓存的 `jarSha1` 与源 jar 一致就直接用；否则从 jar 把名单内的文件一次抽出来，
//! 先写进临时目录、最后写 manifest，再整体改名到位——半途失败只会留下临时目录，不会出现
//! 「manifest 说有、文件却缺一半」的缓存。新目录就绪后删掉其余版本的旧目录。
//!
//! 抽完立刻关 jar：Windows 上被打开的文件删不掉也覆盖不了，长期持有会让删除实例、修复与重装失败。

use std::collections::BTreeSet;
use std::io::Read;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use super::image_rules::{process_block, validate_skin};
use super::source::{JarOpener, SelectedSource};
use super::whitelist::{ArtKind, all_art_paths, jar_entry};

const MANIFEST: &str = "manifest.json";
const TEXTURES: &str = "textures";
const TMP_PREFIX: &str = ".tmp-";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Manifest {
    pub version_id: String,
    pub jar_sha1: String,
    pub files: Vec<String>,
}

/// 材质源版本的缓存目录。
pub fn version_dir(root: &Path, version_id: &str) -> PathBuf {
    root.join(version_id)
}

/// 缓存里某个名单路径的文件位置。
pub fn texture_file(root: &Path, version_id: &str, path: &str) -> PathBuf {
    version_dir(root, version_id)
        .join(TEXTURES)
        .join(format!("{path}.png"))
}

/// 确保材质源的缓存就绪，返回缓存里实际有的名单路径。阻塞调用，放在阻塞线程池里跑。
pub fn ensure(
    root: &Path,
    source: &SelectedSource,
    opener: &JarOpener,
) -> Result<BTreeSet<String>, String> {
    let dir = version_dir(root, &source.version_id);
    let files = match read_manifest(&dir) {
        Some(manifest) if manifest.jar_sha1 == source.jar_sha1 => manifest.files,
        _ => extract(root, source, opener)?,
    };
    remove_other_versions(root, &source.version_id);
    Ok(files.into_iter().collect())
}

/// 读已有的 manifest；不存在或损坏都按「没有缓存」处理（损坏记 warn），随后整份重抽。
fn read_manifest(dir: &Path) -> Option<Manifest> {
    let path = dir.join(MANIFEST);
    let bytes = match std::fs::read(&path) {
        Ok(bytes) => bytes,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return None,
        Err(err) => {
            tracing::warn!(path = %path.display(), error = %err, "读取材质缓存清单失败，将重新抽取");
            return None;
        }
    };
    match serde_json::from_slice(&bytes) {
        Ok(manifest) => Some(manifest),
        Err(err) => {
            tracing::warn!(path = %path.display(), error = %err, "材质缓存清单已损坏，将重新抽取");
            None
        }
    }
}

fn extract(
    root: &Path,
    source: &SelectedSource,
    opener: &JarOpener,
) -> Result<Vec<String>, String> {
    let tmp = root.join(format!(
        "{TMP_PREFIX}{}-{}-{}",
        source.version_id,
        std::process::id(),
        fastrand::u64(..)
    ));
    let result = extract_into(&tmp, source, opener);
    if result.is_err() {
        // 临时目录只是半成品，清掉；清理本身失败只影响磁盘占用，下次启动会再清一次。
        if let Err(err) = std::fs::remove_dir_all(&tmp)
            && err.kind() != std::io::ErrorKind::NotFound
        {
            tracing::warn!(dir = %tmp.display(), error = %err, "清理材质抽取临时目录失败");
        }
        return result;
    }
    let dir = version_dir(root, &source.version_id);
    match std::fs::remove_dir_all(&dir) {
        Ok(()) => {}
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {}
        Err(err) => return Err(format!("删除旧缓存 {} 失败：{err}", dir.display())),
    }
    std::fs::rename(&tmp, &dir)
        .map_err(|e| format!("把临时目录改名为 {} 失败：{e}", dir.display()))?;
    result
}

fn extract_into(
    tmp: &Path,
    source: &SelectedSource,
    opener: &JarOpener,
) -> Result<Vec<String>, String> {
    let file = opener(&source.jar).map_err(|e| format!("打开 jar 失败：{e}"))?;
    let mut archive = zip::ZipArchive::new(file).map_err(|e| format!("不是合法的 zip：{e}"))?;
    let mut files = Vec::new();
    for (path, kind) in all_art_paths() {
        let entry = jar_entry(path);
        let has_mcmeta = archive.index_for_name(&format!("{entry}.mcmeta")).is_some();
        let bytes = match archive.by_name(&entry) {
            Ok(mut zipped) => {
                let mut bytes = Vec::new();
                zipped
                    .read_to_end(&mut bytes)
                    .map_err(|e| format!("解压 {entry} 失败：{e}"))?;
                bytes
            }
            Err(zip::result::ZipError::FileNotFound) => continue,
            Err(err) => return Err(format!("读取 {entry} 失败：{err}")),
        };
        let processed = match kind {
            ArtKind::Block => process_block(&bytes, has_mcmeta),
            ArtKind::Skin => validate_skin(&bytes).map(|_| bytes),
        };
        let processed = match processed {
            Ok(processed) => processed,
            Err(reason) => {
                tracing::warn!(version = %source.version_id, path, %reason, "原版材质不合规，不进缓存，界面将回落");
                continue;
            }
        };
        let target = tmp.join(TEXTURES).join(format!("{path}.png"));
        let parent = target.parent().expect("材质路径必有父目录");
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("创建缓存目录 {} 失败：{e}", parent.display()))?;
        std::fs::write(&target, &processed)
            .map_err(|e| format!("写入缓存 {} 失败：{e}", target.display()))?;
        files.push(path.to_owned());
    }
    drop(archive);
    let manifest = Manifest {
        version_id: source.version_id.clone(),
        jar_sha1: source.jar_sha1.clone(),
        files: files.clone(),
    };
    std::fs::create_dir_all(tmp)
        .map_err(|e| format!("创建缓存目录 {} 失败：{e}", tmp.display()))?;
    let bytes =
        serde_json::to_vec_pretty(&manifest).map_err(|e| format!("序列化缓存清单失败：{e}"))?;
    std::fs::write(tmp.join(MANIFEST), bytes).map_err(|e| format!("写入缓存清单失败：{e}"))?;
    Ok(files)
}

/// 删掉不是当前材质源的版本目录与残留的临时目录。删不掉的只记 warn，下次再试。
fn remove_other_versions(root: &Path, keep: &str) {
    let entries = match std::fs::read_dir(root) {
        Ok(entries) => entries,
        Err(err) => {
            tracing::warn!(dir = %root.display(), error = %err, "列出材质缓存目录失败，旧缓存未清理");
            return;
        }
    };
    for entry in entries {
        let entry = match entry {
            Ok(entry) => entry,
            Err(err) => {
                tracing::warn!(dir = %root.display(), error = %err, "读取材质缓存目录项失败");
                continue;
            }
        };
        if entry.file_name() == keep {
            continue;
        }
        let path = entry.path();
        if path.is_dir()
            && let Err(err) = std::fs::remove_dir_all(&path)
        {
            tracing::warn!(dir = %path.display(), error = %err, "删除旧版材质缓存失败");
        }
    }
}
