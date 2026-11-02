//! 实例工作目录里的内容：存档、资源包、光影包，以及 Mod 文件计数与目录体积。
//!
//! 全部是对工作目录（隔离时为版本目录，否则为 `.minecraft` 根）的只读扫描。存档体积要递归统计成百上千
//! 个区块文件，整段用同步 IO 放到阻塞线程池里做，不在异步 worker 上逐个 await。
//!
//! 资源包的启用与顺序、当前光影都由游戏与光影 Mod 自己记录（`options.txt`、`config/iris.properties`、
//! `optionsshaders.txt`），这里只读不写。

use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

use crate::error::{Error, Result};
use crate::level::{LevelDatError, LevelSummary, parse_level_dat};
use crate::world_backup::RESTORE_SUFFIX;

/// 存档的 `level.dat` 读取情况。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LevelInfo {
    Read(LevelSummary),
    /// 存档文件夹里没有 `level.dat`（复制了一半、或不是存档的文件夹）。
    Missing,
    /// 有 `level.dat` 但读不懂，附原因。
    Unreadable(String),
}

/// 一个存档。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorldEntry {
    /// `saves/` 下的文件夹名。
    pub dir_name: String,
    pub level: LevelInfo,
    /// 存档文件夹的总字节数。
    pub size_bytes: u64,
    /// `level.dat`（没有时取文件夹本身）的修改时刻，Unix 毫秒。
    pub modified_at: Option<u64>,
}

impl WorldEntry {
    /// 排序用的「最近活动」时刻：优先 level.dat 记下的上次游玩，否则文件修改时刻。
    fn recency(&self) -> i64 {
        match &self.level {
            LevelInfo::Read(LevelSummary {
                last_played: Some(at),
                ..
            }) => *at,
            _ => self.modified_at.map_or(0, |m| m as i64),
        }
    }
}

/// 一个资源包或光影包（`.zip` 文件或文件夹）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PackEntry {
    pub file_name: String,
    pub is_dir: bool,
    /// 文件大小；文件夹为其内总字节数。
    pub size_bytes: u64,
    pub modified_at: Option<u64>,
}

/// 资源包及其在游戏里的启用顺序。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResourcePackEntry {
    pub pack: PackEntry,
    /// 在 `options.txt` 启用列表里的位置（从 1 起，越大越靠上、越优先）；未启用为 `None`。
    pub load_order: Option<u32>,
}

/// 光影包及是否为当前启用的光影。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ShaderPackEntry {
    pub pack: PackEntry,
    pub active: bool,
}

/// 一个实例工作目录里的全部内容。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InstanceContent {
    pub resource_packs: Vec<ResourcePackEntry>,
    pub shader_packs: Vec<ShaderPackEntry>,
    /// 按最近活动倒序。
    pub worlds: Vec<WorldEntry>,
}

/// 扫描工作目录里的存档、资源包与光影包。
pub async fn read_instance_content(working_dir: &Path) -> Result<InstanceContent> {
    let dir = working_dir.to_path_buf();
    blocking(working_dir, move || read_content(&dir)).await
}

/// 列出 `saves_dir` 下的存档，按最近活动倒序。目录不存在返回空。
pub async fn list_worlds(saves_dir: &Path) -> Result<Vec<WorldEntry>> {
    let dir = saves_dir.to_path_buf();
    blocking(saves_dir, move || worlds_in(&dir)).await
}

/// 统计 `saves_dir` 下的存档数，口径与 [`list_worlds`] 相同（每个子文件夹算一个），但不读 level.dat、
/// 不量大小，供列表页用。目录不存在为 0。
pub async fn count_worlds(saves_dir: &Path) -> Result<u32> {
    let dir = saves_dir.to_path_buf();
    blocking(saves_dir, move || count_worlds_in(&dir)).await
}

/// 统计 `mods_dir` 下的 Mod 文件数：`.jar` 与停用的 `.jar.disabled`，不解析内容。目录不存在为 0。
pub async fn count_mod_files(mods_dir: &Path) -> Result<u32> {
    let dir = mods_dir.to_path_buf();
    blocking(mods_dir, move || count_mods_in(&dir)).await
}

/// 递归统计目录的字节数与文件数，不跟随符号链接。目录不存在为 (0, 0)。
pub async fn dir_footprint(dir: &Path) -> Result<(u64, u64)> {
    let owned = dir.to_path_buf();
    blocking(dir, move || footprint(&owned)).await
}

async fn blocking<T: Send + 'static>(
    context: &Path,
    work: impl FnOnce() -> Result<T> + Send + 'static,
) -> Result<T> {
    tokio::task::spawn_blocking(work)
        .await
        .map_err(|join| Error::Io {
            path: context.to_path_buf(),
            source: std::io::Error::other(format!("扫描任务异常结束: {join}")),
        })?
}

fn read_content(working_dir: &Path) -> Result<InstanceContent> {
    let order = resource_pack_order(&working_dir.join("options.txt"))?;
    let resource_packs = packs_in(&working_dir.join("resourcepacks"))?
        .into_iter()
        .map(|pack| {
            let load_order = order
                .iter()
                .position(|name| *name == pack.file_name)
                .map(|i| i as u32 + 1);
            ResourcePackEntry { pack, load_order }
        })
        .collect();
    let active = active_shader(working_dir)?;
    let shader_packs = packs_in(&working_dir.join("shaderpacks"))?
        .into_iter()
        .map(|pack| ShaderPackEntry {
            active: active.as_deref() == Some(pack.file_name.as_str()),
            pack,
        })
        .collect();
    Ok(InstanceContent {
        resource_packs,
        shader_packs,
        worlds: worlds_in(&working_dir.join("saves"))?,
    })
}

/// 目录项；目录不存在返回 `None`。
fn read_dir_entries(dir: &Path) -> Result<Option<Vec<std::fs::DirEntry>>> {
    let read = match std::fs::read_dir(dir) {
        Ok(read) => read,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(source) => {
            return Err(Error::Io {
                path: dir.to_path_buf(),
                source,
            });
        }
    };
    let mut entries = Vec::new();
    for entry in read {
        entries.push(entry.map_err(|source| Error::Io {
            path: dir.to_path_buf(),
            source,
        })?);
    }
    Ok(Some(entries))
}

fn millis(time: std::io::Result<SystemTime>) -> Option<u64> {
    time.ok()?
        .duration_since(UNIX_EPOCH)
        .ok()
        .map(|d| d.as_millis() as u64)
}

fn metadata(path: &Path) -> Result<std::fs::Metadata> {
    std::fs::symlink_metadata(path).map_err(|source| Error::Io {
        path: path.to_path_buf(),
        source,
    })
}

fn worlds_in(saves: &Path) -> Result<Vec<WorldEntry>> {
    let Some(entries) = read_dir_entries(saves)? else {
        return Ok(Vec::new());
    };
    worlds_from_entries(entries)
}

/// 游戏运行中存档目录随时在变：玩家删存档，存盘时 level.dat 先被挪成 level.dat_old 再换上新的。
/// 类型取列目录时的信息（与计数同一口径），level.dat 的内容与修改时刻取自同一个打开的文件，不按路径
/// 再查一次；列出之后整个存档已经不在的，不再列出。
fn worlds_from_entries(entries: Vec<std::fs::DirEntry>) -> Result<Vec<WorldEntry>> {
    let mut worlds = Vec::new();
    for entry in entries {
        if is_staged_restore(&entry) {
            continue;
        }
        let path = entry.path();
        match entry.file_type() {
            Ok(file_type) if file_type.is_dir() => {}
            Ok(_) => continue,
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => continue,
            Err(source) => return Err(Error::Io { path, source }),
        }
        let level_path = path.join("level.dat");
        let (level, modified_at) = match read_with_metadata(&level_path) {
            Ok((bytes, meta)) => {
                let level = match parse_level_dat(&bytes) {
                    Ok(summary) => LevelInfo::Read(summary),
                    Err(LevelDatError(reason)) => LevelInfo::Unreadable(reason),
                };
                (level, millis(meta.modified()))
            }
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
                match std::fs::symlink_metadata(&path) {
                    Ok(meta) => (LevelInfo::Missing, millis(meta.modified())),
                    Err(err) if err.kind() == std::io::ErrorKind::NotFound => continue,
                    Err(source) => return Err(Error::Io { path, source }),
                }
            }
            Err(source) => {
                return Err(Error::Io {
                    path: level_path,
                    source,
                });
            }
        };
        worlds.push(WorldEntry {
            dir_name: entry.file_name().to_string_lossy().into_owned(),
            level,
            size_bytes: footprint(&path)?.0,
            modified_at,
        });
    }
    worlds.sort_by(|a, b| {
        b.recency()
            .cmp(&a.recency())
            .then_with(|| a.dir_name.cmp(&b.dir_name))
    });
    Ok(worlds)
}

/// 恢复存档时解出的副本：与存档同在 saves 下，换上之前不算存档。
fn is_staged_restore(entry: &std::fs::DirEntry) -> bool {
    entry
        .file_name()
        .to_string_lossy()
        .ends_with(RESTORE_SUFFIX)
}

fn read_with_metadata(path: &Path) -> std::io::Result<(Vec<u8>, std::fs::Metadata)> {
    use std::io::Read;
    let mut file = std::fs::File::open(path)?;
    let meta = file.metadata()?;
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes)?;
    Ok((bytes, meta))
}

/// 资源包与光影包：`.zip` 文件与文件夹，按名称排序；其它文件（说明文本等）不算。
fn packs_in(dir: &Path) -> Result<Vec<PackEntry>> {
    let Some(entries) = read_dir_entries(dir)? else {
        return Ok(Vec::new());
    };
    let mut packs = Vec::new();
    for entry in entries {
        let path = entry.path();
        let meta = metadata(&path)?;
        let file_name = entry.file_name().to_string_lossy().into_owned();
        let is_zip = file_name.to_ascii_lowercase().ends_with(".zip");
        if !(meta.is_dir() || (meta.is_file() && is_zip)) {
            continue;
        }
        let size_bytes = if meta.is_dir() {
            footprint(&path)?.0
        } else {
            meta.len()
        };
        packs.push(PackEntry {
            file_name,
            is_dir: meta.is_dir(),
            size_bytes,
            modified_at: millis(meta.modified()),
        });
    }
    packs.sort_by(|a, b| a.file_name.cmp(&b.file_name));
    Ok(packs)
}

fn count_worlds_in(saves: &Path) -> Result<u32> {
    let Some(entries) = read_dir_entries(saves)? else {
        return Ok(0);
    };
    count_world_entries(&entries)
}

/// 列表页对每个实例都数一遍存档，类型取列目录时已经拿到的信息，不再逐个 stat：多一次系统调用就多一处
/// 条目在两步之间被删掉的空档。平台需要补查类型时条目已经不在，就当它不在。
fn count_world_entries(entries: &[std::fs::DirEntry]) -> Result<u32> {
    let mut count = 0;
    for entry in entries {
        if is_staged_restore(entry) {
            continue;
        }
        match entry.file_type() {
            Ok(file_type) if file_type.is_dir() => count += 1,
            Ok(_) => {}
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => {}
            Err(source) => {
                return Err(Error::Io {
                    path: entry.path(),
                    source,
                });
            }
        }
    }
    Ok(count)
}

fn count_mods_in(mods: &Path) -> Result<u32> {
    let Some(entries) = read_dir_entries(mods)? else {
        return Ok(0);
    };
    let mut count = 0;
    for entry in entries {
        let name = entry.file_name().to_string_lossy().to_ascii_lowercase();
        if !(name.ends_with(".jar") || name.ends_with(".jar.disabled")) {
            continue;
        }
        let file_type = entry.file_type().map_err(|source| Error::Io {
            path: entry.path(),
            source,
        })?;
        if file_type.is_file() {
            count += 1;
        }
    }
    Ok(count)
}

fn footprint(root: &Path) -> Result<(u64, u64)> {
    let mut bytes = 0u64;
    let mut files = 0u64;
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let Some(entries) = read_dir_entries(&dir)? else {
            // 统计过程中被删掉的子目录（游戏正在写存档时会出现），不计入。
            continue;
        };
        for entry in entries {
            let path = entry.path();
            let meta = match std::fs::symlink_metadata(&path) {
                Ok(meta) => meta,
                Err(err) if err.kind() == std::io::ErrorKind::NotFound => continue,
                Err(source) => return Err(Error::Io { path, source }),
            };
            if meta.is_dir() {
                stack.push(path);
            } else {
                bytes = bytes.saturating_add(meta.len());
                files += 1;
            }
        }
    }
    Ok((bytes, files))
}

/// `options.txt` 里 `resourcePacks:[...]` 启用的本地资源包文件名，按游戏的加载顺序（先加载的在前）。
fn resource_pack_order(options: &Path) -> Result<Vec<String>> {
    let text = match std::fs::read(options) {
        Ok(bytes) => String::from_utf8_lossy(&bytes).into_owned(),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(source) => {
            return Err(Error::Io {
                path: options.to_path_buf(),
                source,
            });
        }
    };
    let Some(raw) = text.lines().find_map(|l| l.strip_prefix("resourcePacks:")) else {
        return Ok(Vec::new());
    };
    let names: Vec<String> = serde_json::from_str(raw).map_err(|source| Error::Json {
        context: "options.txt 的资源包列表",
        path: options.to_path_buf(),
        source,
    })?;
    // 1.13 起本地资源包写成 `file/<文件名>`，没有前缀的是 `vanilla` 这类内置包；1.12.2 及更早只写
    // 文件名、列表里不会有内置包。所以列表里一个带前缀的都没有时，按旧写法整份当文件名。
    if !names.iter().any(|n| n.starts_with(PACK_FILE_PREFIX)) {
        return Ok(names);
    }
    Ok(names
        .into_iter()
        .filter_map(|n| n.strip_prefix(PACK_FILE_PREFIX).map(str::to_owned))
        .collect())
}

/// 1.13 起 `options.txt` 启用列表里本地资源包的 id 前缀。
const PACK_FILE_PREFIX: &str = "file/";

/// 当前启用的光影包文件名：Iris（及其 Forge 移植 Oculus）记在 `config/<mod>.properties`，
/// OptiFine 记在 `optionsshaders.txt`。Iris 的配置优先：两者同时存在时游戏实际用的是 Iris。
fn active_shader(working_dir: &Path) -> Result<Option<String>> {
    for file in ["iris.properties", "oculus.properties"] {
        let path = working_dir.join("config").join(file);
        if let Some(props) = read_properties(&path)? {
            let enabled = props
                .iter()
                .find(|(k, _)| k == "enableShaders")
                .is_none_or(|(_, v)| v == "true");
            let pack = props
                .into_iter()
                .find(|(k, _)| k == "shaderPack")
                .map(|(_, v)| v);
            return Ok(pack.filter(|p| enabled && !p.is_empty()));
        }
    }
    let path = working_dir.join("optionsshaders.txt");
    let Some(props) = read_properties(&path)? else {
        return Ok(None);
    };
    Ok(props
        .into_iter()
        .find(|(k, _)| k == "shaderPack")
        .map(|(_, v)| v)
        .filter(|p| !p.is_empty() && p != "OFF" && p != "(internal)"))
}

/// 读 Java properties 风格的 `键=值` 文件；文件不存在返回 `None`。
fn read_properties(path: &Path) -> Result<Option<Vec<(String, String)>>> {
    let text = match std::fs::read(path) {
        Ok(bytes) => String::from_utf8_lossy(&bytes).into_owned(),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(source) => {
            return Err(Error::Io {
                path: path.to_path_buf(),
                source,
            });
        }
    };
    Ok(Some(
        text.lines()
            .map(str::trim_start)
            .filter(|l| !l.is_empty() && !l.starts_with('#') && !l.starts_with('!'))
            .filter_map(|l| {
                let (k, v) = l.split_once('=')?;
                Some((unescape_property(k.trim()), unescape_property(v.trim())))
            })
            .collect(),
    ))
}

/// properties 文件的转义：`\:`、`\=`、`\ `、`\\` 与 `\uXXXX`（Java 写出非 ASCII 文件名时用后者）。
fn unescape_property(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len());
    let mut chars = raw.chars();
    while let Some(c) = chars.next() {
        if c != '\\' {
            out.push(c);
            continue;
        }
        match chars.next() {
            Some('u') => {
                let hex: String = chars.by_ref().take(4).collect();
                match u32::from_str_radix(&hex, 16).ok().and_then(char::from_u32) {
                    Some(decoded) => out.push(decoded),
                    None => {
                        out.push_str("\\u");
                        out.push_str(&hex);
                    }
                }
            }
            Some('t') => out.push('\t'),
            Some('n') => out.push('\n'),
            Some(other) => out.push(other),
            None => out.push('\\'),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::level::GameMode;
    use crate::level::tests::level_dat;

    fn write(path: &Path, bytes: &[u8]) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, bytes).unwrap();
    }

    #[tokio::test]
    async fn worlds_read_level_dat_and_report_missing_or_unreadable() {
        let tmp = tempfile::tempdir().unwrap();
        let saves = tmp.path().join("saves");
        write(
            &saves.join("New World").join("level.dat"),
            &level_dat("周末生存", 0, false, 3_000),
        );
        write(
            &saves.join("New World").join("region").join("r.0.0.mca"),
            &[0u8; 4096],
        );
        write(
            &saves.join("hc").join("level.dat"),
            &level_dat("极限", 0, true, 2_000),
        );
        write(
            &saves.join("copied").join("region").join("r.mca"),
            &[0u8; 10],
        );
        write(&saves.join("bad").join("level.dat"), b"garbage");
        write(&saves.join("note.txt"), b"not a world");

        let worlds = list_worlds(&saves).await.unwrap();
        let names: Vec<&str> = worlds.iter().map(|w| w.dir_name.as_str()).collect();
        // 有 LastPlayed 的按它倒序；没有的按文件修改时刻（远大于 3000 毫秒）排在前面。
        assert_eq!(names.len(), 4, "{names:?}");
        let world = worlds.iter().find(|w| w.dir_name == "New World").unwrap();
        match &world.level {
            LevelInfo::Read(s) => {
                assert_eq!(s.name.as_deref(), Some("周末生存"));
                assert_eq!(s.mode, Some(GameMode::Survival));
                assert_eq!(s.last_played, Some(3_000));
            }
            other => panic!("{other:?}"),
        }
        assert_eq!(
            world.size_bytes,
            4096 + level_dat("周末生存", 0, false, 3_000).len() as u64
        );
        let hc = worlds.iter().find(|w| w.dir_name == "hc").unwrap();
        assert!(matches!(&hc.level, LevelInfo::Read(s) if s.mode == Some(GameMode::Hardcore)));
        let copied = worlds.iter().find(|w| w.dir_name == "copied").unwrap();
        assert_eq!(copied.level, LevelInfo::Missing);
        assert_eq!(copied.size_bytes, 10);
        assert!(copied.modified_at.is_some());
        let bad = worlds.iter().find(|w| w.dir_name == "bad").unwrap();
        assert!(matches!(&bad.level, LevelInfo::Unreadable(reason) if reason.contains("gzip")));

        let pos = |n: &str| names.iter().position(|x| *x == n).unwrap();
        assert!(
            pos("New World") < pos("hc"),
            "LastPlayed 3000 应排在 2000 之前"
        );
    }

    #[tokio::test]
    async fn missing_saves_dir_is_empty() {
        let tmp = tempfile::tempdir().unwrap();
        assert!(
            list_worlds(&tmp.path().join("saves"))
                .await
                .unwrap()
                .is_empty()
        );
        assert_eq!(count_worlds(&tmp.path().join("saves")).await.unwrap(), 0);
    }

    #[tokio::test]
    async fn world_count_matches_the_world_list_without_reading_level_dat() {
        let tmp = tempfile::tempdir().unwrap();
        let saves = tmp.path().join("saves");
        write(
            &saves.join("ok").join("level.dat"),
            &level_dat("a", 0, false, 1),
        );
        write(&saves.join("broken").join("level.dat"), b"garbage");
        std::fs::create_dir_all(saves.join("empty")).unwrap();
        write(&saves.join("note.txt"), b"not a world");
        write(&saves.join("world.zip"), b"PK");

        assert_eq!(count_worlds(&saves).await.unwrap(), 3);
        assert_eq!(list_worlds(&saves).await.unwrap().len(), 3);
    }

    /// 列出存档目录之后、读条目类型之前有存档被删掉（玩家正在删存档、游戏正在写）：计数照常给出，
    /// 不让整张实例列表失败。类型取自列目录时拿到的信息，所以按列目录那一刻计数。
    #[test]
    fn world_count_survives_an_entry_vanishing_after_listing() {
        let tmp = tempfile::tempdir().unwrap();
        let saves = tmp.path().join("saves");
        for name in ["生存", "creative", "删掉的"] {
            std::fs::create_dir_all(saves.join(name)).unwrap();
        }
        write(&saves.join("note.txt"), b"not a world");
        let entries = read_dir_entries(&saves).unwrap().unwrap();
        assert_eq!(entries.len(), 4);

        std::fs::remove_dir(saves.join("删掉的")).unwrap();
        assert_eq!(count_world_entries(&entries).unwrap(), 3);
        assert_eq!(count_worlds_in(&saves).unwrap(), 2);
    }

    /// 恢复存档时解出的副本放在 saves 下，换上之前它不是一个存档：列表与计数都不算它，否则恢复进行中界面上会多出
    /// 一个同名的存档，还能点进去。
    #[test]
    fn a_world_being_restored_is_neither_listed_nor_counted() {
        let tmp = tempfile::tempdir().unwrap();
        let saves = tmp.path().join("saves");
        write(
            &saves.join("生存").join("level.dat"),
            &level_dat("生存", 0, false, 2_000),
        );
        write(
            &saves
                .join(format!("生存{}", crate::world_backup::RESTORE_SUFFIX))
                .join("level.dat"),
            &level_dat("生存", 0, false, 1_000),
        );

        assert_eq!(count_worlds_in(&saves).unwrap(), 1);
        let worlds = worlds_in(&saves).unwrap();
        let names: Vec<&str> = worlds.iter().map(|w| w.dir_name.as_str()).collect();
        assert_eq!(names, vec!["生存"]);
    }

    /// 列出存档目录之后有存档被删掉（玩家在游戏里删存档）：其余存档照常列出，不让整个内容页失败；
    /// 已经不在的那个不再列出，免得给出一个读不到 level.dat、体积为 0 的空壳。
    #[test]
    fn world_list_survives_an_entry_vanishing_after_listing() {
        let tmp = tempfile::tempdir().unwrap();
        let saves = tmp.path().join("saves");
        write(
            &saves.join("生存").join("level.dat"),
            &level_dat("生存", 0, false, 2_000),
        );
        write(
            &saves.join("删掉的").join("level.dat"),
            &level_dat("删掉的", 1, false, 1_000),
        );
        std::fs::create_dir_all(saves.join("空文件夹")).unwrap();
        let entries = read_dir_entries(&saves).unwrap().unwrap();
        assert_eq!(entries.len(), 3);

        std::fs::remove_dir_all(saves.join("删掉的")).unwrap();
        std::fs::remove_dir(saves.join("空文件夹")).unwrap();
        let worlds = worlds_from_entries(entries).unwrap();
        let names: Vec<&str> = worlds.iter().map(|w| w.dir_name.as_str()).collect();
        assert_eq!(names, vec!["生存"]);
        assert!(matches!(&worlds[0].level, LevelInfo::Read(s) if s.last_played == Some(2_000)));
        assert!(worlds[0].modified_at.is_some());
    }

    #[tokio::test]
    async fn mod_count_includes_disabled_jars_and_ignores_other_entries() {
        let tmp = tempfile::tempdir().unwrap();
        let mods = tmp.path().join("mods");
        assert_eq!(count_mod_files(&mods).await.unwrap(), 0);
        write(&mods.join("sodium.jar"), b"x");
        write(&mods.join("Lithium.JAR"), b"x");
        write(&mods.join("iris.jar.disabled"), b"x");
        write(&mods.join("readme.txt"), b"x");
        write(&mods.join("config.jar.bak"), b"x");
        std::fs::create_dir_all(mods.join("folder.jar")).unwrap();
        assert_eq!(count_mod_files(&mods).await.unwrap(), 3);
    }

    #[tokio::test]
    async fn content_lists_packs_with_order_and_active_shader() {
        let tmp = tempfile::tempdir().unwrap();
        let wd = tmp.path();
        write(
            &wd.join("resourcepacks").join("Faithful 32x.zip"),
            &[0u8; 100],
        );
        write(&wd.join("resourcepacks").join("Fresh.zip"), &[0u8; 5]);
        write(
            &wd.join("resourcepacks")
                .join("Folder Pack")
                .join("pack.mcmeta"),
            b"{}",
        );
        write(&wd.join("resourcepacks").join("readme.txt"), b"x");
        write(
            &wd.join("options.txt"),
            b"version:3953\nresourcePacks:[\"vanilla\",\"file/Fresh.zip\",\"file/Faithful 32x.zip\"]\nlang:zh_cn\n",
        );
        write(&wd.join("shaderpacks").join("BSL_v8.2.09.zip"), &[0u8; 7]);
        write(&wd.join("shaderpacks").join("Complementary.zip"), &[0u8; 3]);
        write(
            &wd.join("config").join("iris.properties"),
            b"#comment\nenableShaders=true\nshaderPack=BSL_v8.2.09.zip\n",
        );

        let content = read_instance_content(wd).await.unwrap();
        let packs: Vec<(&str, Option<u32>, bool, u64)> = content
            .resource_packs
            .iter()
            .map(|r| {
                (
                    r.pack.file_name.as_str(),
                    r.load_order,
                    r.pack.is_dir,
                    r.pack.size_bytes,
                )
            })
            .collect();
        assert_eq!(
            packs,
            vec![
                ("Faithful 32x.zip", Some(2), false, 100),
                ("Folder Pack", None, true, 2),
                ("Fresh.zip", Some(1), false, 5),
            ]
        );
        let shaders: Vec<(&str, bool)> = content
            .shader_packs
            .iter()
            .map(|s| (s.pack.file_name.as_str(), s.active))
            .collect();
        assert_eq!(
            shaders,
            vec![("BSL_v8.2.09.zip", true), ("Complementary.zip", false)]
        );
        assert!(content.worlds.is_empty());
    }

    #[tokio::test]
    async fn shader_detection_covers_disabled_iris_and_optifine() {
        let tmp = tempfile::tempdir().unwrap();
        let wd = tmp.path();
        write(&wd.join("shaderpacks").join("Sildurs.zip"), b"x");
        write(&wd.join("optionsshaders.txt"), b"shaderPack=Sildurs.zip\n");
        assert!(read_instance_content(wd).await.unwrap().shader_packs[0].active);

        write(&wd.join("optionsshaders.txt"), b"shaderPack=OFF\n");
        assert!(!read_instance_content(wd).await.unwrap().shader_packs[0].active);

        // Iris 配置存在时以它为准：光影被关掉就没有当前光影。
        write(&wd.join("optionsshaders.txt"), b"shaderPack=Sildurs.zip\n");
        write(
            &wd.join("config").join("iris.properties"),
            b"enableShaders=false\nshaderPack=Sildurs.zip\n",
        );
        assert!(!read_instance_content(wd).await.unwrap().shader_packs[0].active);
    }

    #[test]
    fn property_unescaping_handles_unicode_and_colons() {
        assert_eq!(unescape_property(r"樱花 Shaders.zip"), "樱花 Shaders.zip");
        assert_eq!(unescape_property(r"a\:b\=c\\d"), "a:b=c\\d");
        assert_eq!(unescape_property(r"bad\uZZ"), r"bad\uZZ");
    }

    /// 1.13 起启用列表里的本地资源包写成 `file/<文件名>`，内置包是 `vanilla` 之类的 id；1.12.2 及更早
    /// 只写文件名、没有前缀。两种写法都要认出启用顺序。
    #[test]
    fn resource_pack_order_reads_both_prefixed_and_legacy_entries() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("options.txt");
        std::fs::write(
            &path,
            "resourcePacks:[\"Faithful 32x - 1.12.2.zip\",\"樱花材质\"]\n",
        )
        .unwrap();
        assert_eq!(
            resource_pack_order(&path).unwrap(),
            vec!["Faithful 32x - 1.12.2.zip", "樱花材质"]
        );

        std::fs::write(
            &path,
            "resourcePacks:[\"vanilla\",\"file/Fresh.zip\",\"fabric\",\"file/Folder Pack\"]\n",
        )
        .unwrap();
        assert_eq!(
            resource_pack_order(&path).unwrap(),
            vec!["Fresh.zip", "Folder Pack"]
        );
    }

    #[tokio::test]
    async fn legacy_options_mark_enabled_packs_in_their_order() {
        let tmp = tempfile::tempdir().unwrap();
        let wd = tmp.path();
        write(&wd.join("resourcepacks").join("A.zip"), b"x");
        write(&wd.join("resourcepacks").join("B.zip"), b"x");
        write(&wd.join("resourcepacks").join("C.zip"), b"x");
        write(
            &wd.join("options.txt"),
            b"invertYMouse:false\nresourcePacks:[\"C.zip\",\"A.zip\"]\nincompatibleResourcePacks:[]\n",
        );
        let content = read_instance_content(wd).await.unwrap();
        let order: Vec<(&str, Option<u32>)> = content
            .resource_packs
            .iter()
            .map(|r| (r.pack.file_name.as_str(), r.load_order))
            .collect();
        assert_eq!(
            order,
            vec![("A.zip", Some(2)), ("B.zip", None), ("C.zip", Some(1))]
        );
    }

    #[test]
    fn malformed_resource_pack_line_is_an_error() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("options.txt");
        std::fs::write(&path, "resourcePacks:[\"file/a.zip\"\n").unwrap();
        assert!(matches!(
            resource_pack_order(&path).unwrap_err(),
            Error::Json { .. }
        ));
    }

    #[tokio::test]
    async fn footprint_counts_nested_files_and_missing_dir_is_zero() {
        let tmp = tempfile::tempdir().unwrap();
        write(&tmp.path().join("a").join("b").join("c.bin"), &[0u8; 300]);
        write(&tmp.path().join("d.bin"), &[0u8; 20]);
        assert_eq!(dir_footprint(tmp.path()).await.unwrap(), (320, 2));
        assert_eq!(
            dir_footprint(&tmp.path().join("nope")).await.unwrap(),
            (0, 0)
        );
    }
}
