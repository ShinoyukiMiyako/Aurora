//! 原版材质的磁盘缓存：`<缓存目录>/vanilla-art/<材质源版本>/` 下的 `textures/<路径>.png`、方块目录
//! `catalog.json` 与 `manifest.json`。手动下载来的材质抽在 `vanilla-art/.download-cache/`，布局相同、
//! 清单标明来源为下载，事后不再需要 jar。
//!
//! 选定材质源后，清单的格式版本是当前的、`jarSha1` 与源 jar 一致就直接用；否则从 jar 一次抽出方块目录
//! 引用到的全部面、预设名单与默认皮肤，连同方块目录（含名称与色相）一起，先写进临时目录、最后写
//! manifest，再整体改名到位——半途失败只会留下临时目录，不会出现「manifest 说有、文件却缺一半」的缓存。
//!
//! 抽完立刻关 jar：Windows 上被打开的文件删不掉也覆盖不了，长期持有会让删除实例、修复与重装失败，
//! 下载来的 jar 也要在抽完后由调用方删掉。

use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::io::Read;
use std::path::{Path, PathBuf};

use petalfall_version::{AssetObjectsIndex, check_path_segment};
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};

use super::catalog::{self, BlockCatalog, CatalogBlock, ModelFiles};
use super::image_rules::{process_block, validate_skin};
use super::remote::sha1_hex;
use super::source::{JarOpener, SelectedSource};
use super::whitelist::{ArtKind, all_art_paths, jar_entry};
use super::{DOWNLOAD_DIR, DownloadedClient};

const MANIFEST: &str = "manifest.json";
const CATALOG: &str = "catalog.json";
const TEXTURES: &str = "textures";
const TMP_PREFIX: &str = ".tmp-";

/// 下载来的材质的缓存目录（在 vanilla-art 下）。点开头，不会与材质源版本目录重名。本机有完整材质源时
/// 也留着：下载是玩家手动点的，本机版本被删之后不该要他再下一次。
const DOWNLOAD_CACHE: &str = ".download-cache";

/// 缓存格式：2 起有方块目录并抽目录引用到的全部方块面。更早的清单里没有这一项，读出来是 0。
const FORMAT: u32 = 2;

const EN_US: &str = "assets/minecraft/lang/en_us.json";
/// 中文语言文件在资源索引里的逻辑名。
const ZH_CN_OBJECT: &str = "minecraft/lang/zh_cn.json";

/// 缓存里的材质从哪来。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Origin {
    /// 候选游戏目录里的客户端 jar。旧清单没有来源一项，只可能是它。
    #[default]
    Local,
    /// 玩家手动下载、抽完即删的客户端 jar。
    Download,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Manifest {
    #[serde(default)]
    pub format: u32,
    #[serde(default)]
    pub origin: Origin,
    pub version_id: String,
    pub jar_sha1: String,
    pub files: Vec<String>,
}

/// 一份就绪的缓存：目录、实际有的材质路径与方块目录。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Prepared {
    pub dir: PathBuf,
    pub files: BTreeSet<String>,
    pub catalog: BlockCatalog,
}

/// 方块的中文名从哪来。
enum ZhCn {
    /// 本机材质源：按版本 JSON 的资源索引 id 去 jar 所在游戏目录的 assets 里找，核对 SHA-1。
    AssetIndex {
        game_dir: PathBuf,
        index_id: Option<String>,
    },
    /// 下载来源：下载时已按索引核对过的文件；没下到为 None。
    File(Option<PathBuf>),
}

/// 一次抽取的输入。
struct Job {
    version_id: String,
    jar: PathBuf,
    jar_sha1: String,
    origin: Origin,
    zh_cn: ZhCn,
}

/// 本机材质源版本的缓存目录。
pub fn version_dir(root: &Path, version_id: &str) -> PathBuf {
    root.join(version_id)
}

/// 下载来的材质的缓存目录。
pub fn download_cache_dir(root: &Path) -> PathBuf {
    root.join(DOWNLOAD_CACHE)
}

/// 缓存目录里某个材质路径的文件位置。
pub fn texture_file(dir: &Path, path: &str) -> PathBuf {
    dir.join(TEXTURES).join(format!("{path}.png"))
}

/// 确保本机材质源的缓存就绪。阻塞调用，放在阻塞线程池里跑。
pub fn ensure(
    root: &Path,
    source: &SelectedSource,
    opener: &JarOpener,
) -> Result<Prepared, String> {
    let dir = version_dir(root, &source.version_id);
    if let Some(prepared) = load(&dir, |manifest| manifest.jar_sha1 == source.jar_sha1) {
        return Ok(prepared);
    }
    let job = Job {
        version_id: source.version_id.clone(),
        jar: source.jar.clone(),
        jar_sha1: source.jar_sha1.clone(),
        origin: Origin::Local,
        zh_cn: ZhCn::AssetIndex {
            game_dir: source.game_dir.clone(),
            index_id: source.asset_index.clone(),
        },
    };
    extract(root, &dir, &job, opener)
}

/// 读下载来的材质缓存；没有、格式过旧或损坏都为 None（损坏记 warn）。只读缓存目录，不需要 jar。
pub fn load_download(root: &Path) -> Option<Prepared> {
    load(&download_cache_dir(root), |manifest| {
        manifest.origin == Origin::Download
    })
}

/// 把下载来的 jar 抽进下载缓存，替换之前下载的那份。阻塞调用。
pub fn adopt(
    root: &Path,
    client: &DownloadedClient,
    opener: &JarOpener,
) -> Result<Prepared, String> {
    let job = Job {
        version_id: client.version_id.clone(),
        jar: client.jar.clone(),
        jar_sha1: client.jar_sha1.clone(),
        origin: Origin::Download,
        zh_cn: ZhCn::File(client.zh_cn.clone()),
    };
    extract(root, &download_cache_dir(root), &job, opener)
}

/// 清单与方块目录都在、格式是当前的、且 `accept` 认可清单时才算可用；否则调用方整份重抽。
fn load(dir: &Path, accept: impl Fn(&Manifest) -> bool) -> Option<Prepared> {
    let manifest_path = dir.join(MANIFEST);
    let manifest: Manifest = match read_json(&manifest_path) {
        Ok(Some(manifest)) => manifest,
        Ok(None) => return None,
        Err(reason) => {
            tracing::warn!(path = %manifest_path.display(), %reason, "材质缓存清单不可用，将重新抽取");
            return None;
        }
    };
    if manifest.format != FORMAT {
        tracing::info!(dir = %dir.display(), format = manifest.format, current = FORMAT, "材质缓存是旧格式，将重新抽取");
        return None;
    }
    if !accept(&manifest) {
        return None;
    }
    let catalog_path = dir.join(CATALOG);
    let catalog: BlockCatalog = match read_json(&catalog_path) {
        Ok(Some(catalog)) => catalog,
        Ok(None) => {
            tracing::warn!(path = %catalog_path.display(), "材质缓存缺方块目录，将重新抽取");
            return None;
        }
        Err(reason) => {
            tracing::warn!(path = %catalog_path.display(), %reason, "材质缓存的方块目录不可用，将重新抽取");
            return None;
        }
    };
    if catalog.version_id != manifest.version_id {
        tracing::warn!(dir = %dir.display(), catalog = %catalog.version_id, manifest = %manifest.version_id, "方块目录与缓存清单的版本不一致，将重新抽取");
        return None;
    }
    Some(Prepared {
        dir: dir.to_owned(),
        files: manifest.files.into_iter().collect(),
        catalog,
    })
}

/// 读一个 JSON 文件：不存在为 `Ok(None)`，读不了或解析失败为 `Err`。
fn read_json<T: DeserializeOwned>(path: &Path) -> Result<Option<T>, String> {
    let bytes = match std::fs::read(path) {
        Ok(bytes) => bytes,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(err) => return Err(format!("读取失败：{err}")),
    };
    serde_json::from_slice(&bytes)
        .map(Some)
        .map_err(|e| format!("解析失败：{e}"))
}

fn extract(root: &Path, dir: &Path, job: &Job, opener: &JarOpener) -> Result<Prepared, String> {
    let tmp = root.join(format!(
        "{TMP_PREFIX}{}-{}-{}",
        job.version_id,
        std::process::id(),
        fastrand::u64(..)
    ));
    let (files, catalog) = match extract_into(&tmp, job, opener) {
        Ok(extracted) => extracted,
        Err(reason) => {
            // 临时目录只是半成品，清掉；清理本身失败只影响磁盘占用，下次刷新会再清一次。
            if let Err(err) = std::fs::remove_dir_all(&tmp)
                && err.kind() != std::io::ErrorKind::NotFound
            {
                tracing::warn!(dir = %tmp.display(), error = %err, "清理材质抽取临时目录失败");
            }
            return Err(reason);
        }
    };
    match std::fs::remove_dir_all(dir) {
        Ok(()) => {}
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {}
        Err(err) => return Err(format!("删除旧缓存 {} 失败：{err}", dir.display())),
    }
    std::fs::rename(&tmp, dir)
        .map_err(|e| format!("把临时目录改名为 {} 失败：{e}", dir.display()))?;
    Ok(Prepared {
        dir: dir.to_owned(),
        files,
        catalog,
    })
}

fn extract_into(
    tmp: &Path,
    job: &Job,
    opener: &JarOpener,
) -> Result<(BTreeSet<String>, BlockCatalog), String> {
    let file = opener(&job.jar).map_err(|e| format!("打开 jar 失败：{e}"))?;
    let mut archive = zip::ZipArchive::new(file).map_err(|e| format!("不是合法的 zip：{e}"))?;

    let mut models = ModelFiles::default();
    for index in 0..archive.len() {
        let Some(name) = archive.name_for_index(index) else {
            continue;
        };
        if !ModelFiles::wants(name) {
            continue;
        }
        let name = name.to_owned();
        let mut zipped = archive
            .by_index(index)
            .map_err(|e| format!("读取 {name} 失败：{e}"))?;
        let mut bytes = Vec::new();
        zipped
            .read_to_end(&mut bytes)
            .map_err(|e| format!("解压 {name} 失败：{e}"))?;
        drop(zipped);
        models.insert(&name, bytes);
    }
    let faces = catalog::derive(&models);
    drop(models);
    let en_us = match read_entry(&mut archive, EN_US)? {
        Some(bytes) => lang_or_warn(&job.version_id, "英文", &bytes),
        None => {
            tracing::warn!(version = %job.version_id, "jar 里没有英文语言文件，方块名只有中文或没有");
            None
        }
    };

    let mut wanted: BTreeMap<&str, ArtKind> = all_art_paths().collect();
    for block in &faces {
        for path in block.textures() {
            wanted.insert(path, ArtKind::Block);
        }
    }
    let mut files = BTreeSet::new();
    // 抽好的方块面，算色相要用侧面。
    let mut blocks_png: HashMap<&str, Vec<u8>> = HashMap::new();
    for (path, kind) in wanted {
        let entry = jar_entry(path);
        let has_mcmeta = archive.index_for_name(&format!("{entry}.mcmeta")).is_some();
        let Some(bytes) = read_entry(&mut archive, &entry)? else {
            continue;
        };
        let processed = match kind {
            ArtKind::Block => process_block(&bytes, has_mcmeta),
            ArtKind::Skin => validate_skin(&bytes).map(|_| bytes),
        };
        let processed = match processed {
            Ok(processed) => processed,
            Err(reason) => {
                tracing::warn!(version = %job.version_id, path, %reason, "原版材质不合规，不进缓存，界面将回落");
                continue;
            }
        };
        let target = texture_file(tmp, path);
        let parent = target.parent().expect("材质路径必有父目录");
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("创建缓存目录 {} 失败：{e}", parent.display()))?;
        std::fs::write(&target, &processed)
            .map_err(|e| format!("写入缓存 {} 失败：{e}", target.display()))?;
        files.insert(path.to_owned());
        if kind == ArtKind::Block {
            blocks_png.insert(path, processed);
        }
    }
    drop(archive);

    let zh_cn = zh_cn_names(&job.version_id, &job.zh_cn);
    let mut blocks = Vec::with_capacity(faces.len());
    for block in &faces {
        if let Some(missing) = block.textures().find(|path| !blocks_png.contains_key(path)) {
            tracing::warn!(version = %job.version_id, block = %block.id, texture = missing, "方块用到的材质缺失或不合规，这个方块不进目录");
            continue;
        }
        let side = image::load_from_memory_with_format(
            &blocks_png[block.side.as_str()],
            image::ImageFormat::Png,
        )
        .map_err(|e| format!("解码抽好的 {} 失败：{e}", block.side))?
        .to_rgba8();
        blocks.push(CatalogBlock {
            id: block.id.clone(),
            top: block.top.clone(),
            side: block.side.clone(),
            front: block.front.clone(),
            top_tint: block.top_tint,
            side_tint: block.side_tint,
            hue: catalog::side_hue(&side, block.side_tint),
            name_en: en_us
                .as_ref()
                .and_then(|lang| catalog::block_name(lang, &block.id)),
            name_zh: zh_cn
                .as_ref()
                .and_then(|lang| catalog::block_name(lang, &block.id)),
        });
    }
    let catalog = BlockCatalog {
        version_id: job.version_id.clone(),
        blocks,
    };

    std::fs::create_dir_all(tmp)
        .map_err(|e| format!("创建缓存目录 {} 失败：{e}", tmp.display()))?;
    let bytes = serde_json::to_vec(&catalog).map_err(|e| format!("序列化方块目录失败：{e}"))?;
    std::fs::write(tmp.join(CATALOG), bytes).map_err(|e| format!("写入方块目录失败：{e}"))?;
    let manifest = Manifest {
        format: FORMAT,
        origin: job.origin,
        version_id: job.version_id.clone(),
        jar_sha1: job.jar_sha1.clone(),
        files: files.iter().cloned().collect(),
    };
    let bytes =
        serde_json::to_vec_pretty(&manifest).map_err(|e| format!("序列化缓存清单失败：{e}"))?;
    std::fs::write(tmp.join(MANIFEST), bytes).map_err(|e| format!("写入缓存清单失败：{e}"))?;
    Ok((files, catalog))
}

/// 读 jar 里的一个条目；没有这个条目为 `Ok(None)`。
fn read_entry(
    archive: &mut zip::ZipArchive<std::fs::File>,
    entry: &str,
) -> Result<Option<Vec<u8>>, String> {
    match archive.by_name(entry) {
        Ok(mut zipped) => {
            let mut bytes = Vec::new();
            zipped
                .read_to_end(&mut bytes)
                .map_err(|e| format!("解压 {entry} 失败：{e}"))?;
            Ok(Some(bytes))
        }
        Err(zip::result::ZipError::FileNotFound) => Ok(None),
        Err(err) => Err(format!("读取 {entry} 失败：{err}")),
    }
}

fn lang_or_warn(version: &str, language: &str, bytes: &[u8]) -> Option<HashMap<String, String>> {
    match catalog::parse_lang(bytes) {
        Ok(lang) => Some(lang),
        Err(reason) => {
            tracing::warn!(version, language, %reason, "语言文件不可用，方块名缺这一种语言");
            None
        }
    }
}

/// 方块的中文名表；拿不到只记 warn，目录照常生成，中文名为空。
fn zh_cn_names(version: &str, source: &ZhCn) -> Option<HashMap<String, String>> {
    let bytes = match source {
        // 下载阶段没拿到时，那边已经记过原因。
        ZhCn::File(None) => return None,
        ZhCn::File(Some(path)) => match std::fs::read(path) {
            Ok(bytes) => bytes,
            Err(err) => {
                tracing::warn!(version, path = %path.display(), error = %err, "读取下载来的中文语言文件失败，方块名只有英文");
                return None;
            }
        },
        ZhCn::AssetIndex { game_dir, index_id } => {
            match local_zh_cn(game_dir, index_id.as_deref()) {
                Ok(bytes) => bytes,
                Err(reason) => {
                    tracing::warn!(version, game_dir = %game_dir.display(), %reason, "本机资源里没有可用的中文语言文件，方块名只有英文");
                    return None;
                }
            }
        }
    };
    lang_or_warn(version, "中文", &bytes)
}

/// 按资源索引找到本机的 zh_cn.json 并核对 SHA-1。语言文件不在 jar 里，只随资源对象下载。
fn local_zh_cn(game_dir: &Path, index_id: Option<&str>) -> Result<Vec<u8>, String> {
    let index_id = index_id.ok_or("版本 JSON 没有资源索引")?;
    check_path_segment(index_id).map_err(|e| format!("资源索引 id {index_id:?} 不合法：{e}"))?;
    let assets = game_dir.join("assets");
    let index_path = assets.join("indexes").join(format!("{index_id}.json"));
    let text = std::fs::read_to_string(&index_path)
        .map_err(|e| format!("读取资源索引 {} 失败：{e}", index_path.display()))?;
    let index = AssetObjectsIndex::from_json_str(&text)
        .map_err(|e| format!("资源索引 {} 不可用：{e}", index_path.display()))?;
    let object = index
        .objects
        .get(ZH_CN_OBJECT)
        .ok_or_else(|| format!("资源索引 {index_id} 里没有 {ZH_CN_OBJECT}"))?;
    let expected = object.hash.to_ascii_lowercase();
    let path = assets.join("objects").join(object.object_path());
    let bytes = std::fs::read(&path).map_err(|e| format!("读取 {} 失败：{e}", path.display()))?;
    let actual = sha1_hex(&bytes);
    if actual != expected {
        return Err(format!(
            "{} 的 SHA-1 为 {actual}，与资源索引的 {expected} 不符",
            path.display()
        ));
    }
    Ok(bytes)
}

/// 删掉当前用不到的缓存：别的材质源版本目录与残留的临时目录。下载暂存目录（另一个任务可能正在往里下）
/// 与下载缓存都不动。删不掉的只记 warn，下次再试。
pub fn remove_stale(root: &Path, keep: &Path) {
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
        let name = entry.file_name();
        if name == DOWNLOAD_DIR || name == DOWNLOAD_CACHE {
            continue;
        }
        let path = entry.path();
        if path == keep {
            continue;
        }
        if path.is_dir()
            && let Err(err) = std::fs::remove_dir_all(&path)
        {
            tracing::warn!(dir = %path.display(), error = %err, "删除旧版材质缓存失败");
        }
    }
}
