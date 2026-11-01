//! 存档备份的文件层：把一个存档文件夹打成 zip、每个存档一份备份清单（`index.json`）、按保留策略挑出
//! 要清理的备份、从备份恢复存档、实例改名时搬运它名下的备份。
//!
//! 备份放在游戏目录的元数据目录下（`<游戏目录>/.petalfall/backups`），不放进 `versions/<实例>`：删除实例、
//! 重装启动器都不会带走备份，而且与存档同盘，打包和恢复都只在本盘上读写。目录按作用域分两层：隔离实例的
//! 存档在 `instances/<实例 id>/<存档文件夹名>/`，共用 `.minecraft/saves` 的在 `shared/<存档文件夹名>/`，
//! 名叫 shared 的实例也撞不上共用作用域。清单里不记实例 id，实例改名只需要挪目录。
//!
//! 打包、解压、恢复就位都是同步 IO，由门面放到阻塞线程池里执行；清单整份经 aurora-base 原子写。

use std::collections::HashSet;
use std::fs::{self, File, TryLockError};
use std::io::{BufReader, BufWriter, Read, Write};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use zip::result::ZipError;
use zip::write::SimpleFileOptions;
use zip::{CompressionMethod, ZipArchive, ZipWriter};

use crate::AURORA_META_DIR;
use crate::error::{Error, Result};
use crate::level::parse_level_dat;
use crate::naming::is_safe_instance_id;
use crate::trash::Disposer;

/// 元数据目录下放备份的子目录名。
pub const BACKUPS_DIR: &str = "backups";
/// 每个存档的备份目录里的清单文件名。
pub const BACKUP_INDEX_FILE: &str = "index.json";
/// 清单格式版本。
pub const BACKUP_INDEX_VERSION: u32 = 1;
/// 恢复时解压用的同级临时目录后缀：`<saves>/<存档><后缀>`。与存档同盘，就位只需一次改名。
pub const RESTORE_SUFFIX: &str = concat!(".", aurora_base::app_slug!(), "-restore");

const INSTANCES_SCOPE: &str = "instances";
const SHARED_SCOPE: &str = "shared";
/// 游戏打开存档时对它持有排他锁；锁着的文件读不出来，恢复后游戏也会自己重建，所以不进备份。
const SESSION_LOCK: &str = "session.lock";
const LEVEL_DAT: &str = "level.dat";
const PART_SUFFIX: &str = ".part";
/// 拷贝与解压的块大小，也是检查取消的粒度：一块 64 KiB 在机械盘上也是毫秒级，取消能在 1 秒内生效。
const COPY_CHUNK: usize = 64 * 1024;

/// 备份是自动做的（退出游戏后）还是玩家手动做的。自动清理只删自动备份。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BackupKind {
    Auto,
    Manual,
}

impl BackupKind {
    /// 与 serde 名相同，也是备份文件名里的那一段。
    pub fn as_str(self) -> &'static str {
        match self {
            BackupKind::Auto => "auto",
            BackupKind::Manual => "manual",
        }
    }

    /// 备份文件名 `<unix 毫秒>-<auto|manual>.zip`。
    pub fn file_name(self, created_at: u64) -> String {
        format!("{created_at}-{}.zip", self.as_str())
    }
}

/// 存档的归属：隔离实例自己的存档，或者不隔离的实例共用的 `.minecraft/saves`。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WorldScope {
    Instance(String),
    Shared,
}

/// 一个游戏目录下备份的路径布局。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BackupLayout {
    root: PathBuf,
}

impl BackupLayout {
    pub fn new(game_dir: &Path) -> Self {
        Self {
            root: game_dir.join(AURORA_META_DIR).join(BACKUPS_DIR),
        }
    }

    /// 备份根 `<游戏目录>/.petalfall/backups`。
    pub fn root(&self) -> &Path {
        &self.root
    }

    /// 一个作用域的目录。
    pub fn scope_dir(&self, scope: &WorldScope) -> PathBuf {
        match scope {
            WorldScope::Instance(id) => self.instance_dir(id),
            WorldScope::Shared => self.root.join(SHARED_SCOPE),
        }
    }

    /// 一个存档的备份目录。`world` 由调用方先过路径安全检查。
    pub fn world_dir(&self, scope: &WorldScope, world: &str) -> PathBuf {
        self.scope_dir(scope).join(world)
    }

    /// 隔离实例名下全部备份的目录 `instances/<id>`。
    pub fn instance_dir(&self, id: &str) -> PathBuf {
        self.root.join(INSTANCES_SCOPE).join(id)
    }
}

/// 一个存档的备份清单。新字段一律带默认值，旧版本写的清单照常读。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct BackupIndex {
    pub version: u32,
    pub entries: Vec<BackupEntry>,
}

impl BackupIndex {
    /// 当前版本的空清单。
    pub fn empty() -> Self {
        Self {
            version: BACKUP_INDEX_VERSION,
            entries: Vec::new(),
        }
    }

    pub fn find(&self, file: &str) -> Option<&BackupEntry> {
        self.entries.iter().find(|entry| entry.file == file)
    }
}

/// 清单里的一份备份。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BackupEntry {
    /// zip 文件名（与清单同目录）。
    pub file: String,
    pub kind: BackupKind,
    /// Unix 毫秒。
    pub created_at: u64,
    /// zip 在盘上的大小。
    pub size_bytes: u64,
    /// 备份时 level.dat 里的存档名；读不出时为 `None`。
    #[serde(default)]
    pub level_name: Option<String>,
}

/// 打包或解压的进度。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct PackProgress {
    pub files_total: u64,
    pub files_done: u64,
    pub bytes_total: u64,
    pub bytes_done: u64,
}

/// 打包的结果。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PackedWorld {
    /// zip 在盘上的大小。
    pub size_bytes: u64,
    /// 打进去的文件数（不含目录）。
    pub files: u64,
}

/// 自动清理的保留策略。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RetentionPolicy {
    /// 每个存档最多保留的自动备份份数。
    pub keep_per_world: u32,
    /// 全部备份的总量上限（字节）。
    pub max_total_bytes: u64,
}

/// `name` 能否作为清单里的备份文件名拼进备份目录：单个路径段、以 `.zip` 结尾。
///
/// 清单在盘上，可能被改过；按清单里的名字删除或搬运文件之前先过这一关，名字不会把操作指到备份目录之外。
pub fn is_backup_file_name(name: &str) -> bool {
    is_safe_instance_id(name)
        && name.len() > ".zip".len()
        && name
            .get(name.len() - ".zip".len()..)
            .is_some_and(|ext| ext.eq_ignore_ascii_case(".zip"))
}

// ---- 清单 ----

/// 读一个存档的备份清单。清单不存在算空表；读得到但解析不了报 [`Error::BackupIndexInvalid`]。
pub async fn read_backup_index(world_backup_dir: &Path) -> Result<BackupIndex> {
    let path = world_backup_dir.join(BACKUP_INDEX_FILE);
    let bytes = match tokio::fs::read(&path).await {
        Ok(bytes) => bytes,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(BackupIndex::empty()),
        Err(source) => return Err(Error::Io { path, source }),
    };
    serde_json::from_slice(&bytes).map_err(|err| Error::BackupIndexInvalid {
        path,
        reason: err.to_string(),
    })
}

/// 整份原子写一个存档的备份清单，按需建目录。写出的版本号总是当前版本。
pub async fn write_backup_index(world_backup_dir: &Path, index: &BackupIndex) -> Result<()> {
    #[derive(Serialize)]
    struct Current<'a> {
        version: u32,
        entries: &'a [BackupEntry],
    }
    let path = world_backup_dir.join(BACKUP_INDEX_FILE);
    let bytes = serde_json::to_vec_pretty(&Current {
        version: BACKUP_INDEX_VERSION,
        entries: &index.entries,
    })
    .map_err(|source| Error::Json {
        context: "存档备份清单",
        path: path.clone(),
        source,
    })?;
    aurora_base::fs::atomic_write(&path, &bytes).await?;
    Ok(())
}

/// 一个作用域目录下每个存档的备份目录与清单，按目录名排序。作用域目录不存在为空。
pub async fn scope_backup_indices(scope_dir: &Path) -> Result<Vec<(PathBuf, BackupIndex)>> {
    let mut indices = Vec::new();
    for dir in subdirs(scope_dir).await? {
        let index = read_backup_index(&dir).await?;
        indices.push((dir, index));
    }
    Ok(indices)
}

/// 备份根下全部存档的备份目录与清单：`instances/*/*` 与 `shared/*`。任何一份清单读不懂都报错：
/// 总量算不准时清理会删错。
pub async fn scan_backup_indices(root: &Path) -> Result<Vec<(PathBuf, BackupIndex)>> {
    let mut indices = Vec::new();
    for instance_dir in subdirs(&root.join(INSTANCES_SCOPE)).await? {
        indices.extend(scope_backup_indices(&instance_dir).await?);
    }
    indices.extend(scope_backup_indices(&root.join(SHARED_SCOPE)).await?);
    Ok(indices)
}

/// `dir` 下的子目录（不跟随符号链接），按名排序；`dir` 不存在为空。
async fn subdirs(dir: &Path) -> Result<Vec<PathBuf>> {
    let io = |source| Error::Io {
        path: dir.to_path_buf(),
        source,
    };
    let mut read = match tokio::fs::read_dir(dir).await {
        Ok(read) => read,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(source) => return Err(io(source)),
    };
    let mut dirs = Vec::new();
    while let Some(entry) = read.next_entry().await.map_err(io)? {
        if entry.file_type().await.map_err(io)?.is_dir() {
            dirs.push(entry.path());
        }
    }
    dirs.sort();
    Ok(dirs)
}

/// 删掉上一次没写完的备份（`*.zip.part`），返回删掉的个数。目录不存在为 0。
pub fn remove_partial_backups(world_backup_dir: &Path) -> Result<u32> {
    let io = |source| Error::Io {
        path: world_backup_dir.to_path_buf(),
        source,
    };
    let read = match fs::read_dir(world_backup_dir) {
        Ok(read) => read,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(0),
        Err(source) => return Err(io(source)),
    };
    let mut removed = 0;
    for entry in read {
        let path = entry.map_err(io)?.path();
        let is_part = path
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| name.ends_with(".zip.part"));
        if is_part && path.is_file() {
            fs::remove_file(&path).map_err(|source| Error::Io {
                path: path.clone(),
                source,
            })?;
            removed += 1;
        }
    }
    Ok(removed)
}

// ---- 打包 ----

/// 存档文件夹的内容，路径都相对存档根、用正斜杠连接。
#[derive(Default)]
struct WorldTree {
    dirs: Vec<String>,
    files: Vec<(PathBuf, String, u64)>,
}

fn walk(world_dir: &Path) -> Result<WorldTree> {
    let mut tree = WorldTree::default();
    let mut pending = vec![(world_dir.to_path_buf(), String::new())];
    while let Some((dir, rel)) = pending.pop() {
        let io = |source| Error::Io {
            path: dir.clone(),
            source,
        };
        let mut entries = Vec::new();
        for entry in fs::read_dir(&dir).map_err(io)? {
            entries.push(entry.map_err(io)?);
        }
        for entry in entries {
            let path = entry.path();
            let meta = fs::symlink_metadata(&path).map_err(|source| Error::Io {
                path: path.clone(),
                source,
            })?;
            let name = entry
                .file_name()
                .into_string()
                .map_err(|raw| Error::BackupArchive {
                    path: path.clone(),
                    reason: format!("文件名不是合法的 Unicode：{raw:?}"),
                })?;
            let child = if rel.is_empty() {
                name.clone()
            } else {
                format!("{rel}/{name}")
            };
            // 符号链接与目录联接会把打包带到存档之外，恢复时也还原不出原样，直接拒绝。
            if meta.file_type().is_symlink() {
                return Err(Error::BackupEntryUnsafe {
                    path: world_dir.to_path_buf(),
                    entry: child,
                    reason: "symlink",
                });
            }
            if meta.is_dir() {
                tree.dirs.push(child.clone());
                pending.push((path, child));
            } else if !name.eq_ignore_ascii_case(SESSION_LOCK) {
                tree.files.push((path, child, meta.len()));
            }
        }
    }
    tree.dirs.sort();
    tree.files.sort_by(|a, b| a.1.cmp(&b.1));
    Ok(tree)
}

/// `dest` 旁边写到一半的临时文件 `<dest>.part`。
fn part_path(dest: &Path) -> PathBuf {
    let mut raw = dest.as_os_str().to_owned();
    raw.push(PART_SUFFIX);
    PathBuf::from(raw)
}

/// 把存档文件夹打成 zip 写到 `dest`：条目统一加 `<存档文件夹名>/` 前缀，每个子目录都有目录条目（空目录也
/// 保留），任何层级的 `session.lock` 都跳过。先写 `<dest>.part`，写完再改名成 `dest`（已存在则覆盖）。
///
/// 先遍历一遍算出总量，之后每拷 64 KiB 查一次 `is_cancelled`，刷完盘、改名就位之前再查一次。取消或失败时删掉 `.part`，返回
/// [`Error::Cancelled`] 或原错误。存档里有符号链接或目录联接时拒绝打包。
pub fn pack_world(
    world_dir: &Path,
    dest: &Path,
    is_cancelled: &dyn Fn() -> bool,
    progress: &mut dyn FnMut(PackProgress),
) -> Result<PackedWorld> {
    let root = world_dir
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| Error::BackupArchive {
            path: world_dir.to_path_buf(),
            reason: "存档文件夹名不是合法的 Unicode".into(),
        })?
        .to_owned();
    let tree = walk(world_dir)?;
    if let Some(parent) = dest.parent() {
        fs::create_dir_all(parent).map_err(|source| Error::Io {
            path: parent.to_path_buf(),
            source,
        })?;
    }
    let part = part_path(dest);
    let written = write_archive(&root, &tree, &part, is_cancelled, progress).and_then(|()| {
        // 写目录区与刷盘可能要几秒；这期间来的取消也不能让 zip 就位：调用方可能已经不再等结果。
        if is_cancelled() {
            return Err(Error::Cancelled);
        }
        fs::rename(&part, dest).map_err(|source| Error::Io {
            path: dest.to_path_buf(),
            source,
        })
    });
    if let Err(err) = written {
        remove_file_logged(&part);
        return Err(err);
    }
    let size_bytes = fs::metadata(dest)
        .map_err(|source| Error::Io {
            path: dest.to_path_buf(),
            source,
        })?
        .len();
    Ok(PackedWorld {
        size_bytes,
        files: tree.files.len() as u64,
    })
}

fn write_archive(
    root: &str,
    tree: &WorldTree,
    part: &Path,
    is_cancelled: &dyn Fn() -> bool,
    progress: &mut dyn FnMut(PackProgress),
) -> Result<()> {
    let write_io = |source| Error::Io {
        path: part.to_path_buf(),
        source,
    };
    let zip_error = |err: ZipError| match err {
        ZipError::Io(source) => write_io(source),
        other => Error::BackupArchive {
            path: part.to_path_buf(),
            reason: other.to_string(),
        },
    };
    let file = File::create(part).map_err(write_io)?;
    let mut zip = ZipWriter::new(BufWriter::new(file));
    // 不设修改时间：游戏不读条目的 mtime，没开 time 特性时取 zip 的默认时刻就够了。
    let options = SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);
    zip.add_directory(format!("{root}/"), options)
        .map_err(zip_error)?;
    for dir in &tree.dirs {
        zip.add_directory(format!("{root}/{dir}/"), options)
            .map_err(zip_error)?;
    }

    let mut state = PackProgress {
        files_total: tree.files.len() as u64,
        files_done: 0,
        bytes_total: tree.files.iter().map(|(_, _, size)| size).sum(),
        bytes_done: 0,
    };
    progress(state);
    let mut buffer = vec![0u8; COPY_CHUNK];
    for (source, rel, size) in &tree.files {
        if is_cancelled() {
            return Err(Error::Cancelled);
        }
        zip.start_file(
            format!("{root}/{rel}"),
            options.large_file(*size >= zip::ZIP64_BYTES_THR),
        )
        .map_err(zip_error)?;
        let read_io = |err| Error::Io {
            path: source.clone(),
            source: err,
        };
        let mut input = File::open(source).map_err(read_io)?;
        loop {
            if is_cancelled() {
                return Err(Error::Cancelled);
            }
            let n = input.read(&mut buffer).map_err(read_io)?;
            if n == 0 {
                break;
            }
            zip.write_all(&buffer[..n]).map_err(write_io)?;
            state.bytes_done += n as u64;
            progress(state);
        }
        state.files_done += 1;
        progress(state);
    }
    let writer = zip.finish().map_err(zip_error)?;
    let file = writer
        .into_inner()
        .map_err(|err| write_io(err.into_error()))?;
    file.sync_all().map_err(write_io)
}

// ---- 恢复 ----

/// 校验通过、要解出的一个条目，路径已去掉顶层目录。
struct PlannedEntry {
    index: usize,
    name: String,
    rel: Vec<String>,
    is_dir: bool,
    size: u64,
}

/// 从备份 `zip` 解出存档到同级临时目录 `<saves_dir>/<world><RESTORE_SUFFIX>`，返回这个目录。
///
/// 写出第一个字节之前先校验全部条目：只能用正斜杠；不能是绝对路径、不能带盘符；不能有空的路径段、`.`
/// 或 `..`；路径段不能以点或空格结尾、不能含 Windows 非法字符或控制字符、不能是保留设备名；不能是符号
/// 链接；全部条目必须在同一个顶层目录下（解出时去掉这一层）。不合格报 [`Error::BackupEntryUnsafe`]，
/// `reason` 取 `parent_traversal`、`absolute`、`drive_prefix`、`backslash`、`empty_component`、
/// `current_dir`、`invalid_character`、`reserved_name`、`trailing_dot_or_space`、`symlink`、
/// `multiple_roots` 之一。解完读临时目录里的 level.dat，没有或读不懂报 [`Error::BackupLevelUnreadable`]。
///
/// 临时目录已存在（上次的残留）时先删掉。取消、校验失败、解压失败时删掉临时目录，从不碰
/// `saves_dir/<world>`。进度回调第一次出现时校验已经通过。
pub fn stage_restore(
    zip: &Path,
    saves_dir: &Path,
    world: &str,
    is_cancelled: &dyn Fn() -> bool,
    progress: &mut dyn FnMut(PackProgress),
) -> Result<PathBuf> {
    let file = File::open(zip).map_err(|source| Error::Io {
        path: zip.to_path_buf(),
        source,
    })?;
    let mut archive =
        ZipArchive::new(BufReader::new(file)).map_err(|err| archive_error(zip, err))?;
    let plan = plan_extraction(&mut archive, zip)?;
    if is_cancelled() {
        return Err(Error::Cancelled);
    }
    let staged = saves_dir.join(format!("{world}{RESTORE_SUFFIX}"));
    remove_existing(&staged)?;
    fs::create_dir_all(&staged).map_err(|source| Error::Io {
        path: staged.clone(),
        source,
    })?;
    let result = extract(&mut archive, zip, &plan, &staged, is_cancelled, progress)
        .and_then(|()| check_level(&staged, zip));
    if let Err(err) = result {
        remove_dir_logged(&staged);
        return Err(err);
    }
    Ok(staged)
}

fn archive_error(zip: &Path, err: ZipError) -> Error {
    Error::BackupArchive {
        path: zip.to_path_buf(),
        reason: err.to_string(),
    }
}

fn plan_extraction(
    archive: &mut ZipArchive<BufReader<File>>,
    zip: &Path,
) -> Result<Vec<PlannedEntry>> {
    let mut root: Option<String> = None;
    let mut plan = Vec::new();
    for index in 0..archive.len() {
        let file = archive
            .by_index(index)
            .map_err(|err| archive_error(zip, err))?;
        let name = file.name().to_owned();
        let refuse = |reason: &'static str| Error::BackupEntryUnsafe {
            path: zip.to_path_buf(),
            entry: name.clone(),
            reason,
        };
        if file.is_symlink() {
            return Err(refuse("symlink"));
        }
        let components = check_entry_name(&name).map_err(refuse)?;
        let (head, rest) = components
            .split_first()
            .expect("通过校验的条目名至少有一段");
        match &root {
            None => root = Some((*head).to_owned()),
            Some(existing) if existing != head => return Err(refuse("multiple_roots")),
            Some(_) => {}
        }
        if rest.is_empty() {
            // 只有顶层目录本身可以没有下一段；顶层的文件不属于任何存档文件夹。
            if file.is_dir() {
                continue;
            }
            return Err(refuse("multiple_roots"));
        }
        plan.push(PlannedEntry {
            index,
            rel: rest.iter().map(|part| (*part).to_owned()).collect(),
            is_dir: file.is_dir(),
            size: file.size(),
            name,
        });
    }
    Ok(plan)
}

/// zip 条目名的词法检查，通过时返回各路径段。
fn check_entry_name(name: &str) -> std::result::Result<Vec<&str>, &'static str> {
    if name.starts_with('/') || name.starts_with('\\') {
        return Err("absolute");
    }
    if name.contains('\\') {
        return Err("backslash");
    }
    let bytes = name.as_bytes();
    if bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' {
        return Err("drive_prefix");
    }
    // 目录条目以一个正斜杠结尾；再多的斜杠就是空路径段。
    let trimmed = name.strip_suffix('/').unwrap_or(name);
    let mut parts = Vec::new();
    for component in trimmed.split('/') {
        check_component(component)?;
        parts.push(component);
    }
    Ok(parts)
}

fn check_component(component: &str) -> std::result::Result<(), &'static str> {
    if component.is_empty() {
        return Err("empty_component");
    }
    if component == "." {
        return Err("current_dir");
    }
    if component == ".." {
        return Err("parent_traversal");
    }
    if component.ends_with('.') || component.ends_with(' ') {
        return Err("trailing_dot_or_space");
    }
    if component.chars().any(|c| {
        c <= '\u{1f}' || c == '\u{7f}' || matches!(c, '<' | '>' | ':' | '"' | '|' | '?' | '*')
    }) {
        return Err("invalid_character");
    }
    if is_reserved_name(component) {
        return Err("reserved_name");
    }
    Ok(())
}

/// Windows 保留的设备名（带扩展名也算，按第一个点之前的部分判断，不分大小写）。
fn is_reserved_name(component: &str) -> bool {
    let stem = component
        .split('.')
        .next()
        .unwrap_or(component)
        .trim_end_matches(' ')
        .to_ascii_uppercase();
    let numbered = |prefix: &str| {
        stem.strip_prefix(prefix).is_some_and(|n| {
            matches!(
                n,
                "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" | "¹" | "²" | "³"
            )
        })
    };
    matches!(
        stem.as_str(),
        "CON" | "PRN" | "AUX" | "NUL" | "CLOCK$" | "CONIN$" | "CONOUT$"
    ) || numbered("COM")
        || numbered("LPT")
}

/// [`Error::BackupEntryUnsafe`] 的规则码对应的说明。
pub fn unsafe_entry_text(reason: &str) -> &'static str {
    match reason {
        "parent_traversal" => "含上级目录 ..",
        "absolute" => "是绝对路径",
        "drive_prefix" => "带盘符",
        "backslash" => "用了反斜杠",
        "empty_component" => "含空的路径段",
        "current_dir" => "含当前目录 .",
        "invalid_character" => "含 Windows 不允许的字符",
        "reserved_name" => "是 Windows 保留的设备名",
        "trailing_dot_or_space" => "以点或空格结尾",
        "symlink" => "是符号链接",
        "multiple_roots" => "不在同一个存档文件夹里",
        _ => "不合规则",
    }
}

fn extract(
    archive: &mut ZipArchive<BufReader<File>>,
    zip: &Path,
    plan: &[PlannedEntry],
    staged: &Path,
    is_cancelled: &dyn Fn() -> bool,
    progress: &mut dyn FnMut(PackProgress),
) -> Result<()> {
    let files = plan.iter().filter(|entry| !entry.is_dir);
    let mut state = PackProgress {
        files_total: files.clone().count() as u64,
        files_done: 0,
        bytes_total: files.map(|entry| entry.size).sum(),
        bytes_done: 0,
    };
    progress(state);
    let mut created: HashSet<PathBuf> = HashSet::new();
    let mut buffer = vec![0u8; COPY_CHUNK];
    for entry in plan {
        if is_cancelled() {
            return Err(Error::Cancelled);
        }
        let target = entry
            .rel
            .iter()
            .fold(staged.to_path_buf(), |path, part| path.join(part));
        let dir = if entry.is_dir {
            Some(target.as_path())
        } else {
            target.parent()
        };
        if let Some(dir) = dir
            && !created.contains(dir)
        {
            fs::create_dir_all(dir).map_err(|source| Error::Io {
                path: dir.to_path_buf(),
                source,
            })?;
            created.insert(dir.to_path_buf());
        }
        if entry.is_dir {
            continue;
        }
        let write_io = |source| Error::Io {
            path: target.clone(),
            source,
        };
        let mut file = archive
            .by_index(entry.index)
            .map_err(|err| archive_error(zip, err))?;
        let mut out = File::create(&target).map_err(write_io)?;
        let mut written = 0u64;
        loop {
            if is_cancelled() {
                return Err(Error::Cancelled);
            }
            // 读侧（解压、CRC 校验）的错误是备份坏了，写侧的是磁盘的问题，分开报。
            let n = file
                .read(&mut buffer)
                .map_err(|err| archive_error(zip, ZipError::Io(err)))?;
            if n == 0 {
                break;
            }
            written += n as u64;
            if written > entry.size {
                return Err(Error::BackupArchive {
                    path: zip.to_path_buf(),
                    reason: format!("{} 解压后超过声明的大小", entry.name),
                });
            }
            out.write_all(&buffer[..n]).map_err(write_io)?;
            state.bytes_done += n as u64;
            progress(state);
        }
        state.files_done += 1;
        progress(state);
    }
    Ok(())
}

fn check_level(staged: &Path, zip: &Path) -> Result<()> {
    let path = staged.join(LEVEL_DAT);
    let bytes = match fs::read(&path) {
        Ok(bytes) => bytes,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
            return Err(Error::BackupLevelUnreadable {
                path: zip.to_path_buf(),
                reason: "备份里没有 level.dat".into(),
            });
        }
        Err(source) => return Err(Error::Io { path, source }),
    };
    parse_level_dat(&bytes).map_err(|err| Error::BackupLevelUnreadable {
        path: zip.to_path_buf(),
        reason: err.0,
    })?;
    Ok(())
}

/// 把解好的 `staged` 换上 `world_dir`：`world_dir` 存在时先交给 `disposer`（生产是回收站），再把 `staged`
/// 改名成 `world_dir`。返回原来的存档是否被处置掉了。
///
/// `disposer` 失败时删掉 `staged`、`world_dir` 原样不动，返回原错误。处置成功之后改名失败报
/// [`Error::RestoreNotPlaced`]，`staged` 保留不删：原存档已经不在原处，那是用户唯一的新副本。
pub fn commit_restore(staged: &Path, world_dir: &Path, disposer: &dyn Disposer) -> Result<bool> {
    let existed = match fs::symlink_metadata(world_dir) {
        Ok(_) => true,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => false,
        Err(source) => {
            remove_dir_logged(staged);
            return Err(Error::Io {
                path: world_dir.to_path_buf(),
                source,
            });
        }
    };
    if existed && let Err(err) = disposer.dispose(world_dir) {
        remove_dir_logged(staged);
        return Err(err);
    }
    match fs::rename(staged, world_dir) {
        Ok(()) => Ok(existed),
        Err(source) if existed => {
            tracing::error!(
                world_dir = %world_dir.display(),
                staged = %staged.display(),
                error = %source,
                "原存档已处置，恢复出的存档没能改名就位"
            );
            Err(Error::RestoreNotPlaced {
                world_dir: world_dir.to_path_buf(),
                staged: staged.to_path_buf(),
            })
        }
        Err(source) => {
            // 原来就没有这个存档，备份 zip 还在，临时目录不是唯一的副本。
            remove_dir_logged(staged);
            Err(Error::Io {
                path: world_dir.to_path_buf(),
                source,
            })
        }
    }
}

// ---- 改名搬运 ----

/// 实例改名时把 `from`（`instances/<旧名>`）下的备份并进 `to`（`instances/<新名>`）。
///
/// `from` 不存在时什么都不做；`to` 不存在时整目录改名。都存在时逐个存档处理：目标里没有同名存档目录的
/// 直接改名；有的就把 zip 逐个挪过去（撞名时毫秒加 1），再原子写合并后的目标清单，最后删掉源清单与空目录。
/// 逐个存档提交，中途失败时两边的清单都与盘上一致。
pub async fn merge_scope_dir(from: &Path, to: &Path) -> Result<()> {
    if !path_exists(from).await? {
        return Ok(());
    }
    if same_path_ignoring_case(from, to) {
        // 只改大小写：Windows 上是同一个目录，按原样改名即可。
        if from != to {
            rename(from, to).await?;
        }
        return Ok(());
    }
    if !path_exists(to).await? {
        if let Some(parent) = to.parent() {
            tokio::fs::create_dir_all(parent)
                .await
                .map_err(|source| Error::Io {
                    path: parent.to_path_buf(),
                    source,
                })?;
        }
        return rename(from, to).await;
    }
    for world_dir in subdirs(from).await? {
        let Some(name) = world_dir.file_name() else {
            continue;
        };
        let target = to.join(name);
        if path_exists(&target).await? {
            merge_world_dir(&world_dir, &target).await?;
        } else {
            rename(&world_dir, &target).await?;
        }
    }
    remove_dir_if_empty(from).await
}

async fn merge_world_dir(from: &Path, to: &Path) -> Result<()> {
    let source = read_backup_index(from).await?;
    let mut target = read_backup_index(to).await?;
    let mut taken: HashSet<String> = target
        .entries
        .iter()
        .map(|entry| entry.file.to_lowercase())
        .collect();
    let mut remaining = Vec::new();
    let mut failure = None;
    let mut entries = source.entries.into_iter();
    for mut entry in entries.by_ref() {
        if !is_backup_file_name(&entry.file) {
            remaining.push(entry);
            continue;
        }
        let from_file = from.join(&entry.file);
        if !path_exists(&from_file).await? {
            // 清单里有、盘上已经没有的条目，不再带进新目录。
            continue;
        }
        let mut name = entry.file.clone();
        let mut created_at = entry.created_at;
        while taken.contains(&name.to_lowercase()) || path_exists(&to.join(&name)).await? {
            created_at += 1;
            name = entry.kind.file_name(created_at);
        }
        match tokio::fs::rename(&from_file, to.join(&name)).await {
            Ok(()) => {
                taken.insert(name.to_lowercase());
                entry.file = name;
                entry.created_at = created_at;
                target.entries.push(entry);
            }
            Err(source) => {
                failure = Some(Error::Io {
                    path: from_file,
                    source,
                });
                remaining.push(entry);
                break;
            }
        }
    }
    remaining.extend(entries);
    // 先写目标清单：zip 已经挪过去了，目标清单不记上它们就成了没人认领的文件。
    write_backup_index(to, &target).await?;
    if remaining.is_empty() {
        let index = from.join(BACKUP_INDEX_FILE);
        match tokio::fs::remove_file(&index).await {
            Ok(()) => {}
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => {}
            Err(source) => {
                return Err(Error::Io {
                    path: index,
                    source,
                });
            }
        }
        remove_dir_if_empty(from).await?;
    } else {
        write_backup_index(
            from,
            &BackupIndex {
                version: BACKUP_INDEX_VERSION,
                entries: remaining,
            },
        )
        .await?;
    }
    match failure {
        Some(err) => Err(err),
        None => Ok(()),
    }
}

fn same_path_ignoring_case(a: &Path, b: &Path) -> bool {
    a.as_os_str().to_string_lossy().to_lowercase() == b.as_os_str().to_string_lossy().to_lowercase()
}

async fn path_exists(path: &Path) -> Result<bool> {
    match tokio::fs::symlink_metadata(path).await {
        Ok(_) => Ok(true),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(source) => Err(Error::Io {
            path: path.to_path_buf(),
            source,
        }),
    }
}

async fn rename(from: &Path, to: &Path) -> Result<()> {
    tokio::fs::rename(from, to)
        .await
        .map_err(|source| Error::Io {
            path: from.to_path_buf(),
            source,
        })
}

/// 目录空了才删；还剩东西（清单外的文件、没挪成的备份）就留着。
async fn remove_dir_if_empty(dir: &Path) -> Result<()> {
    let io = |source| Error::Io {
        path: dir.to_path_buf(),
        source,
    };
    let mut read = match tokio::fs::read_dir(dir).await {
        Ok(read) => read,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(source) => return Err(io(source)),
    };
    if read.next_entry().await.map_err(io)?.is_some() {
        tracing::warn!(dir = %dir.display(), "备份目录里还有清单以外的文件，没有删除");
        return Ok(());
    }
    tokio::fs::remove_dir(dir).await.map_err(io)
}

// ---- 占用探测与清理 ----

/// 存档是否正被游戏打开。1.16 起游戏打开存档时对 `session.lock` 整个文件持有排他锁（FileChannel.tryLock），
/// 这里对它试拿一次排他锁，拿不到即被占用；文件不存在算没被占用。更早的版本只往里写时间戳、不加系统锁，
/// 探测不到，靠实例互斥兜底。
pub fn world_in_use(world_dir: &Path) -> Result<bool> {
    let path = world_dir.join(SESSION_LOCK);
    let file = match File::open(&path) {
        Ok(file) => file,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        // 游戏自己探测占用时也把拒绝访问当成被占用。
        Err(err) if err.kind() == std::io::ErrorKind::PermissionDenied => return Ok(true),
        Err(source) => return Err(Error::Io { path, source }),
    };
    match file.try_lock() {
        Ok(()) => {
            file.unlock().map_err(|source| Error::Io { path, source })?;
            Ok(false)
        }
        Err(TryLockError::WouldBlock) => Ok(true),
        Err(TryLockError::Error(source)) => Err(Error::Io { path, source }),
    }
}

/// 删掉一个可能已存在的文件或目录（恢复用的临时目录的残留）。
fn remove_existing(path: &Path) -> Result<()> {
    let removed = match fs::symlink_metadata(path) {
        Ok(meta) if meta.is_dir() => fs::remove_dir_all(path),
        Ok(_) => fs::remove_file(path),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(err) => Err(err),
    };
    removed.map_err(|source| Error::Io {
        path: path.to_path_buf(),
        source,
    })
}

/// 清理中间产物；清理失败不盖过本来要返回的结果，但要留下记录。
fn remove_file_logged(path: &Path) {
    match fs::remove_file(path) {
        Ok(()) => {}
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {}
        Err(err) => tracing::warn!(path = %path.display(), error = %err, "清理写到一半的备份失败"),
    }
}

fn remove_dir_logged(path: &Path) {
    match fs::remove_dir_all(path) {
        Ok(()) => {}
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {}
        Err(err) => {
            tracing::warn!(path = %path.display(), error = %err, "清理恢复用的临时目录失败")
        }
    }
}

// ---- 保留策略 ----

/// 按保留策略挑出要删的备份，返回 `(存档备份目录, 文件名)`。纯函数，不碰盘。
///
/// 第一步，每个存档的自动备份按 `created_at` 倒序保留前 `keep_per_world` 份，其余进清单。第二步，剩下的
/// 全部备份（自动与手动一起算）总量超过 `max_total_bytes` 时，按全局 `created_at` 从旧到新继续删自动备份，
/// 直到不超或没有自动备份可删。手动备份永远不进清单。`keep` 是刚写成的那一份，两步都不删它：第一步它占保留
/// 份数里的一份（保留 0 份时也留下它），第二步不参与，否则单个存档比上限还大时，新备份刚写完就会被删。
/// 清单里文件名不安全的条目不是本工程写的，不碰。
pub fn plan_prune(
    indices: &[(PathBuf, BackupIndex)],
    policy: RetentionPolicy,
    keep: Option<(&Path, &str)>,
) -> Vec<(PathBuf, String)> {
    let mut doomed: Vec<(&Path, &BackupEntry)> = Vec::new();
    for (dir, index) in indices {
        let is_fresh = |entry: &BackupEntry| keep == Some((dir.as_path(), entry.file.as_str()));
        let mut autos: Vec<&BackupEntry> = index
            .entries
            .iter()
            .filter(|entry| entry.kind == BackupKind::Auto && is_backup_file_name(&entry.file))
            .collect();
        // 刚写成的那一份排在最前、至少留下它：按时刻排序在时钟回拨或保留 0 份时会把它排出去。
        autos.sort_by(|a, b| {
            is_fresh(b)
                .cmp(&is_fresh(a))
                .then_with(|| b.created_at.cmp(&a.created_at))
                .then_with(|| b.file.cmp(&a.file))
        });
        let fresh_here = autos.first().is_some_and(|entry| is_fresh(entry));
        let kept = (policy.keep_per_world as usize).max(usize::from(fresh_here));
        doomed.extend(
            autos
                .into_iter()
                .skip(kept)
                .map(|entry| (dir.as_path(), entry)),
        );
    }

    let is_doomed = |dir: &Path, entry: &BackupEntry, doomed: &[(&Path, &BackupEntry)]| {
        doomed
            .iter()
            .any(|(d, e)| *d == dir && e.file == entry.file)
    };
    let mut total: u64 = indices
        .iter()
        .flat_map(|(dir, index)| index.entries.iter().map(move |entry| (dir, entry)))
        .filter(|(dir, entry)| !is_doomed(dir, entry, &doomed))
        .map(|(_, entry)| entry.size_bytes)
        .sum();
    if total > policy.max_total_bytes {
        let mut candidates: Vec<(&Path, &BackupEntry)> = indices
            .iter()
            .flat_map(|(dir, index)| {
                index
                    .entries
                    .iter()
                    .map(move |entry| (dir.as_path(), entry))
            })
            .filter(|(dir, entry)| {
                entry.kind == BackupKind::Auto
                    && is_backup_file_name(&entry.file)
                    && keep != Some((*dir, entry.file.as_str()))
                    && !is_doomed(dir, entry, &doomed)
            })
            .collect();
        candidates.sort_by(|a, b| {
            a.1.created_at
                .cmp(&b.1.created_at)
                .then_with(|| a.0.cmp(b.0))
                .then_with(|| a.1.file.cmp(&b.1.file))
        });
        for (dir, entry) in candidates {
            if total <= policy.max_total_bytes {
                break;
            }
            total -= entry.size_bytes;
            doomed.push((dir, entry));
        }
    }
    doomed
        .into_iter()
        .map(|(dir, entry)| (dir.to_path_buf(), entry.file.clone()))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::level::tests::level_dat;
    use std::cell::Cell;
    use std::collections::BTreeMap;
    use std::sync::{Arc, Mutex};

    fn write(path: &Path, bytes: &[u8]) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, bytes).unwrap();
    }

    /// 一个典型的存档：level.dat、两个维度的区域文件、一个空目录、根上与子目录里各一个 session.lock。
    fn sample_world(saves: &Path, name: &str, level_name: &str, region: &[u8]) -> PathBuf {
        let world = saves.join(name);
        write(
            &world.join("level.dat"),
            &level_dat(level_name, 0, false, 1),
        );
        write(&world.join("region").join("r.0.0.mca"), region);
        write(
            &world.join("DIM-1").join("region").join("r.-1.0.mca"),
            b"nether",
        );
        fs::create_dir_all(world.join("data")).unwrap();
        write(&world.join("session.lock"), "\u{2603}".as_bytes());
        write(&world.join("DIM-1").join("session.lock"), b"x");
        world
    }

    /// 存档文件夹里每个文件的相对路径与字节，用来逐字节比较前后两份存档。
    fn snapshot(dir: &Path) -> BTreeMap<String, Vec<u8>> {
        fn visit(root: &Path, dir: &Path, out: &mut BTreeMap<String, Vec<u8>>) {
            for entry in fs::read_dir(dir).unwrap() {
                let path = entry.unwrap().path();
                if path.is_dir() {
                    out.insert(
                        format!("{}/", path.strip_prefix(root).unwrap().display()),
                        Vec::new(),
                    );
                    visit(root, &path, out);
                } else {
                    out.insert(
                        path.strip_prefix(root).unwrap().display().to_string(),
                        fs::read(&path).unwrap(),
                    );
                }
            }
        }
        let mut out = BTreeMap::new();
        visit(dir, dir, &mut out);
        out
    }

    fn zip_names(zip: &Path) -> Vec<String> {
        let mut archive = ZipArchive::new(File::open(zip).unwrap()).unwrap();
        let mut names: Vec<String> = (0..archive.len())
            .map(|i| archive.by_index(i).unwrap().name().to_owned())
            .collect();
        names.sort();
        names
    }

    fn pack(world: &Path, dest: &Path) -> (PackedWorld, Vec<PackProgress>) {
        let mut seen = Vec::new();
        let packed = pack_world(world, dest, &|| false, &mut |p| seen.push(p)).unwrap();
        (packed, seen)
    }

    /// 自己拼一个 zip：`(条目名, 内容)`，内容为 `None` 写目录条目。
    fn raw_zip(path: &Path, entries: &[(&str, Option<&[u8]>)]) {
        let mut zip = ZipWriter::new(File::create(path).unwrap());
        let options = SimpleFileOptions::default();
        for (name, body) in entries {
            match body {
                Some(body) => {
                    zip.start_file(*name, options).unwrap();
                    zip.write_all(body).unwrap();
                }
                None => zip.add_directory(*name, options).unwrap(),
            }
        }
        zip.finish().unwrap();
    }

    #[test]
    fn pack_writes_prefixed_entries_with_directories_and_skips_session_lock() {
        let tmp = tempfile::tempdir().unwrap();
        let world = sample_world(
            &tmp.path().join("saves"),
            "新的世界",
            "周末生存",
            &[7u8; 1000],
        );
        let dest = tmp.path().join("out").join("1-manual.zip");
        let (packed, seen) = pack(&world, &dest);

        assert_eq!(
            zip_names(&dest),
            vec![
                "新的世界/",
                "新的世界/DIM-1/",
                "新的世界/DIM-1/region/",
                "新的世界/DIM-1/region/r.-1.0.mca",
                "新的世界/data/",
                "新的世界/level.dat",
                "新的世界/region/",
                "新的世界/region/r.0.0.mca",
            ]
        );
        assert_eq!(packed.files, 3);
        assert_eq!(packed.size_bytes, fs::metadata(&dest).unwrap().len());
        assert!(!part_path(&dest).exists(), "写完后不应留下 .part");

        let mut archive = ZipArchive::new(File::open(&dest).unwrap()).unwrap();
        let mut region = archive.by_name("新的世界/region/r.0.0.mca").unwrap();
        assert_eq!(region.compression(), CompressionMethod::Deflated);
        let mut body = Vec::new();
        region.read_to_end(&mut body).unwrap();
        assert_eq!(body, vec![7u8; 1000]);

        let level_len = level_dat("周末生存", 0, false, 1).len() as u64;
        let last = *seen.last().unwrap();
        assert_eq!(
            last,
            PackProgress {
                files_total: 3,
                files_done: 3,
                bytes_total: 1000 + 6 + level_len,
                bytes_done: 1000 + 6 + level_len,
            }
        );
        assert_eq!(seen[0].files_done, 0, "开头先报一次总量");
    }

    #[test]
    fn empty_world_packs_to_a_root_entry_and_cannot_be_restored() {
        let tmp = tempfile::tempdir().unwrap();
        let world = tmp.path().join("saves").join("空");
        fs::create_dir_all(&world).unwrap();
        let dest = tmp.path().join("b.zip");
        let (packed, seen) = pack(&world, &dest);
        assert_eq!(packed.files, 0);
        assert_eq!(zip_names(&dest), vec!["空/"]);
        assert_eq!(seen, vec![PackProgress::default()]);

        let saves = tmp.path().join("restore");
        let err = stage_restore(&dest, &saves, "空", &|| false, &mut |_| {}).unwrap_err();
        match err {
            Error::BackupLevelUnreadable { path, reason } => {
                assert_eq!(path, dest);
                assert!(reason.contains("level.dat"), "{reason}");
            }
            other => panic!("应报 level.dat 读不出，实际：{other:?}"),
        }
        assert!(!saves.join(format!("空{RESTORE_SUFFIX}")).exists());
    }

    #[test]
    fn cancelled_pack_removes_the_partial_file() {
        let tmp = tempfile::tempdir().unwrap();
        let world = sample_world(&tmp.path().join("saves"), "w", "w", &[1u8; 300 * 1024]);
        let dest = tmp.path().join("b.zip");
        let chunks = Cell::new(0u32);
        let err = pack_world(&world, &dest, &|| chunks.get() >= 2, &mut |_| {
            chunks.set(chunks.get() + 1)
        })
        .unwrap_err();
        assert!(matches!(err, Error::Cancelled), "{err:?}");
        assert!(!dest.exists());
        assert!(!part_path(&dest).exists());
    }

    /// 最后一个文件写完之后还要写目录区、刷盘，大存档在机械盘上要几秒，这时进度已到 100%，玩家最容易点取消。
    /// 取消落在这段里也要按取消收场：不把 zip 改名就位（命令层宽限期满后不再等结果，就位的 zip 记不进清单，
    /// 导出则会盖掉原来的文件），原来的目标文件保持原样。
    #[test]
    fn cancel_after_the_last_file_keeps_the_destination_untouched() {
        let tmp = tempfile::tempdir().unwrap();
        let world = sample_world(&tmp.path().join("saves"), "w", "w", b"r");
        let dest = tmp.path().join("export.zip");
        fs::write(&dest, b"old").unwrap();
        let cancelled = Cell::new(false);
        let err = pack_world(&world, &dest, &|| cancelled.get(), &mut |p| {
            if p.files_total > 0 && p.files_done == p.files_total {
                cancelled.set(true);
            }
        })
        .unwrap_err();
        assert!(matches!(err, Error::Cancelled), "{err:?}");
        assert_eq!(fs::read(&dest).unwrap(), b"old");
        assert!(!part_path(&dest).exists());
    }

    #[test]
    fn pack_overwrites_an_existing_destination() {
        let tmp = tempfile::tempdir().unwrap();
        let world = sample_world(&tmp.path().join("saves"), "w", "w", b"r");
        let dest = tmp.path().join("export.zip");
        fs::write(&dest, b"old").unwrap();
        pack(&world, &dest);
        assert_eq!(zip_names(&dest).len(), 8);
    }

    #[cfg(windows)]
    #[test]
    fn junctions_inside_the_world_are_refused() {
        let tmp = tempfile::tempdir().unwrap();
        let world = sample_world(&tmp.path().join("saves"), "w", "w", b"r");
        let outside = tmp.path().join("outside");
        fs::create_dir_all(&outside).unwrap();
        // 目录联接不需要管理员权限，正好代表「指到存档之外」的重解析点。
        let status = std::process::Command::new("cmd")
            .args(["/C", "mklink", "/J"])
            .arg(world.join("link"))
            .arg(&outside)
            .output()
            .unwrap();
        assert!(status.status.success(), "{status:?}");
        let dest = tmp.path().join("b.zip");
        let err = pack_world(&world, &dest, &|| false, &mut |_| {}).unwrap_err();
        match err {
            Error::BackupEntryUnsafe { entry, reason, .. } => {
                assert_eq!(entry, "link");
                assert_eq!(reason, "symlink");
            }
            other => panic!("应拒绝联接，实际：{other:?}"),
        }
        assert!(!dest.exists() && !part_path(&dest).exists());
    }

    #[test]
    fn entry_names_are_checked_lexically() {
        for (name, reason) in [
            ("../evil.txt", "parent_traversal"),
            ("w/../x", "parent_traversal"),
            ("/abs", "absolute"),
            ("\\abs", "absolute"),
            ("w\\x", "backslash"),
            ("C:/x", "drive_prefix"),
            ("c:x", "drive_prefix"),
            ("w//x", "empty_component"),
            ("w/x//", "empty_component"),
            ("", "empty_component"),
            ("w/./x", "current_dir"),
            ("w/a.", "trailing_dot_or_space"),
            ("w/a ", "trailing_dot_or_space"),
            ("w/a?b", "invalid_character"),
            ("w/a\u{1}b", "invalid_character"),
            ("w/a:b", "invalid_character"),
            ("w/con.txt", "reserved_name"),
            ("w/LPT9", "reserved_name"),
            ("w/COM\u{b9}", "reserved_name"),
        ] {
            assert_eq!(check_entry_name(name), Err(reason), "{name:?}");
        }
        assert_eq!(check_entry_name("w/"), Ok(vec!["w"]));
        assert_eq!(
            check_entry_name("新的世界/region/r.0.0.mca"),
            Ok(vec!["新的世界", "region", "r.0.0.mca"])
        );
        // 只是以保留名开头、或不在清单里的编号，不拦。
        assert_eq!(check_entry_name("w/CONSOLE"), Ok(vec!["w", "CONSOLE"]));
        assert_eq!(check_entry_name("w/COM0"), Ok(vec!["w", "COM0"]));
    }

    #[test]
    fn unsafe_archives_are_refused_before_anything_is_written() {
        let tmp = tempfile::tempdir().unwrap();
        let saves = tmp.path().join("saves");
        let world = sample_world(&saves, "w", "原来的", b"original");
        let before = snapshot(&world);
        let level = level_dat("w", 0, false, 1);
        type Entries<'a> = Vec<(&'a str, Option<&'a [u8]>)>;
        let cases: Vec<(Entries, &str)> = vec![
            (
                vec![("w/level.dat", Some(&level)), ("../evil.txt", Some(b"x"))],
                "parent_traversal",
            ),
            (
                vec![
                    ("w/level.dat", Some(&level)),
                    ("w/../../evil.txt", Some(b"x")),
                ],
                "parent_traversal",
            ),
            (vec![("C:/evil.txt", Some(b"x"))], "drive_prefix"),
            (vec![("w\\evil.txt", Some(b"x"))], "backslash"),
            (
                vec![("w/level.dat", Some(&level)), ("other/x", Some(b"x"))],
                "multiple_roots",
            ),
            (vec![("level.dat", Some(&level))], "multiple_roots"),
        ];
        for (index, (entries, reason)) in cases.into_iter().enumerate() {
            let zip = tmp.path().join(format!("bad{index}.zip"));
            raw_zip(&zip, &entries);
            let progressed = Cell::new(false);
            let err = stage_restore(&zip, &saves, "w", &|| false, &mut |_| progressed.set(true))
                .unwrap_err();
            match err {
                Error::BackupEntryUnsafe {
                    path, reason: got, ..
                } => {
                    assert_eq!(path, zip);
                    assert_eq!(got, reason, "第 {index} 个包");
                }
                other => panic!("第 {index} 个包应被拒绝，实际：{other:?}"),
            }
            assert!(!progressed.get(), "校验没过不应开始解压");
            assert!(!saves.join(format!("w{RESTORE_SUFFIX}")).exists());
        }
        assert!(!tmp.path().join("evil.txt").exists());
        assert!(!saves.join("evil.txt").exists());
        assert_eq!(snapshot(&world), before, "现有存档必须逐字节不变");
    }

    #[test]
    fn symlink_entries_are_refused() {
        let tmp = tempfile::tempdir().unwrap();
        let zip = tmp.path().join("link.zip");
        let mut writer = ZipWriter::new(File::create(&zip).unwrap());
        writer
            .start_file("w/level.dat", SimpleFileOptions::default())
            .unwrap();
        writer.write_all(b"x").unwrap();
        writer
            .add_symlink("w/escape", "../../outside", SimpleFileOptions::default())
            .unwrap();
        writer.finish().unwrap();
        let err = stage_restore(&zip, tmp.path(), "w", &|| false, &mut |_| {}).unwrap_err();
        assert!(
            matches!(&err, Error::BackupEntryUnsafe { entry, reason: "symlink", .. } if entry == "w/escape"),
            "{err:?}"
        );
    }

    /// 记下处置的路径，并把它挪进 `trash` 目录（测试里不往开发者的回收站里塞东西）。
    #[derive(Clone)]
    struct MovingDisposer {
        trash: PathBuf,
        seen: Arc<Mutex<Vec<PathBuf>>>,
    }

    impl MovingDisposer {
        fn new(trash: PathBuf) -> Self {
            fs::create_dir_all(&trash).unwrap();
            Self {
                trash,
                seen: Arc::default(),
            }
        }
        fn seen(&self) -> Vec<PathBuf> {
            self.seen.lock().unwrap().clone()
        }
    }

    impl Disposer for MovingDisposer {
        fn dispose(&self, dir: &Path) -> Result<()> {
            self.seen.lock().unwrap().push(dir.to_path_buf());
            fs::rename(dir, self.trash.join(dir.file_name().unwrap())).unwrap();
            Ok(())
        }
    }

    struct FailingDisposer;

    impl Disposer for FailingDisposer {
        fn dispose(&self, dir: &Path) -> Result<()> {
            Err(Error::Recycle {
                path: dir.to_path_buf(),
                reason: "测试".into(),
            })
        }
    }

    /// 处置「成功」却没把目录挪走，用来让随后的改名失败。
    struct NoopDisposer;

    impl Disposer for NoopDisposer {
        fn dispose(&self, _: &Path) -> Result<()> {
            Ok(())
        }
    }

    /// 在 `tmp/backup-src` 下做一份备份，返回 zip 路径与备份时那份存档的快照。
    fn backup_of(tmp: &Path, level_name: &str) -> (PathBuf, BTreeMap<String, Vec<u8>>) {
        let src = sample_world(&tmp.join("backup-src"), "w", level_name, b"backup-region");
        let mut expected = snapshot(&src);
        expected.remove("session.lock");
        expected.remove("DIM-1\\session.lock");
        expected.remove("DIM-1/session.lock");
        let zip = tmp.join("1-auto.zip");
        pack(&src, &zip);
        (zip, expected)
    }

    #[test]
    fn restore_stages_then_swaps_the_world_and_recycles_the_old_one() {
        let tmp = tempfile::tempdir().unwrap();
        let (zip, expected) = backup_of(tmp.path(), "备份时");
        let saves = tmp.path().join("saves");
        let world = sample_world(&saves, "w", "现在的", b"current-region");
        let old = snapshot(&world);

        let mut seen = Vec::new();
        let staged = stage_restore(&zip, &saves, "w", &|| false, &mut |p| seen.push(p)).unwrap();
        assert_eq!(staged, saves.join(format!("w{RESTORE_SUFFIX}")));
        assert_eq!(snapshot(&world), old, "就位之前不碰现有存档");
        let last = *seen.last().unwrap();
        assert_eq!(last.files_done, 3);
        assert_eq!(last.bytes_done, last.bytes_total);

        let disposer = MovingDisposer::new(tmp.path().join("trash"));
        assert!(commit_restore(&staged, &world, &disposer).unwrap());
        assert_eq!(disposer.seen(), vec![world.clone()]);
        assert!(!staged.exists());
        assert_eq!(snapshot(&world), expected);
        let summary = parse_level_dat(&fs::read(world.join("level.dat")).unwrap()).unwrap();
        assert_eq!(summary.name.as_deref(), Some("备份时"));
        assert_eq!(snapshot(&tmp.path().join("trash").join("w")), old);
    }

    #[test]
    fn restore_into_a_missing_world_does_not_dispose_anything() {
        let tmp = tempfile::tempdir().unwrap();
        let (zip, expected) = backup_of(tmp.path(), "w");
        let saves = tmp.path().join("saves");
        let staged = stage_restore(&zip, &saves, "w", &|| false, &mut |_| {}).unwrap();
        let disposer = MovingDisposer::new(tmp.path().join("trash"));
        assert!(!commit_restore(&staged, &saves.join("w"), &disposer).unwrap());
        assert!(disposer.seen().is_empty());
        assert_eq!(snapshot(&saves.join("w")), expected);
    }

    #[test]
    fn leftover_staging_directory_is_replaced() {
        let tmp = tempfile::tempdir().unwrap();
        let (zip, expected) = backup_of(tmp.path(), "w");
        let saves = tmp.path().join("saves");
        let leftover = saves.join(format!("w{RESTORE_SUFFIX}"));
        write(&leftover.join("stale.txt"), b"stale");
        let staged = stage_restore(&zip, &saves, "w", &|| false, &mut |_| {}).unwrap();
        assert_eq!(snapshot(&staged), expected);
    }

    #[test]
    fn cancelled_restore_leaves_the_world_untouched() {
        let tmp = tempfile::tempdir().unwrap();
        let src = sample_world(&tmp.path().join("src"), "w", "w", &[3u8; 300 * 1024]);
        let zip = tmp.path().join("b.zip");
        pack(&src, &zip);
        let saves = tmp.path().join("saves");
        let world = sample_world(&saves, "w", "现在的", b"current");
        let before = snapshot(&world);

        let chunks = Cell::new(0u32);
        let err = stage_restore(&zip, &saves, "w", &|| chunks.get() >= 3, &mut |_| {
            chunks.set(chunks.get() + 1)
        })
        .unwrap_err();
        assert!(matches!(err, Error::Cancelled), "{err:?}");
        assert!(!saves.join(format!("w{RESTORE_SUFFIX}")).exists());
        assert_eq!(snapshot(&world), before);
    }

    #[test]
    fn unreadable_level_dat_in_backup_is_reported() {
        let tmp = tempfile::tempdir().unwrap();
        let zip = tmp.path().join("b.zip");
        raw_zip(
            &zip,
            &[
                ("w/", None),
                ("w/level.dat", Some(b"garbage")),
                ("w/region/", None),
            ],
        );
        let saves = tmp.path().join("saves");
        let err = stage_restore(&zip, &saves, "w", &|| false, &mut |_| {}).unwrap_err();
        assert!(
            matches!(&err, Error::BackupLevelUnreadable { reason, .. } if reason.contains("gzip")),
            "{err:?}"
        );
        assert!(!saves.join(format!("w{RESTORE_SUFFIX}")).exists());
    }

    #[test]
    fn not_a_zip_is_a_corrupt_archive() {
        let tmp = tempfile::tempdir().unwrap();
        let zip = tmp.path().join("b.zip");
        fs::write(&zip, b"definitely not a zip").unwrap();
        let err = stage_restore(&zip, tmp.path(), "w", &|| false, &mut |_| {}).unwrap_err();
        assert!(
            matches!(&err, Error::BackupArchive { path, .. } if *path == zip),
            "{err:?}"
        );
    }

    #[test]
    fn failed_disposal_keeps_the_world_and_drops_the_staged_copy() {
        let tmp = tempfile::tempdir().unwrap();
        let (zip, _) = backup_of(tmp.path(), "w");
        let saves = tmp.path().join("saves");
        let world = sample_world(&saves, "w", "现在的", b"current");
        let before = snapshot(&world);
        let staged = stage_restore(&zip, &saves, "w", &|| false, &mut |_| {}).unwrap();
        let err = commit_restore(&staged, &world, &FailingDisposer).unwrap_err();
        assert!(matches!(err, Error::Recycle { .. }), "{err:?}");
        assert!(!staged.exists());
        assert_eq!(snapshot(&world), before);
    }

    #[test]
    fn rename_failure_after_disposal_keeps_the_staged_copy() {
        let tmp = tempfile::tempdir().unwrap();
        let (zip, expected) = backup_of(tmp.path(), "w");
        let saves = tmp.path().join("saves");
        let world = sample_world(&saves, "w", "现在的", b"current");
        let staged = stage_restore(&zip, &saves, "w", &|| false, &mut |_| {}).unwrap();
        let err = commit_restore(&staged, &world, &NoopDisposer).unwrap_err();
        match err {
            Error::RestoreNotPlaced {
                world_dir,
                staged: kept,
            } => {
                assert_eq!(world_dir, world);
                assert_eq!(kept, staged);
            }
            other => panic!("应报没能就位，实际：{other:?}"),
        }
        assert_eq!(snapshot(&staged), expected, "唯一的新副本不能删");
    }

    fn entry(file: &str, kind: BackupKind, created_at: u64, size: u64) -> BackupEntry {
        BackupEntry {
            file: file.to_owned(),
            kind,
            created_at,
            size_bytes: size,
            level_name: None,
        }
    }

    fn index(entries: Vec<BackupEntry>) -> BackupIndex {
        BackupIndex {
            version: BACKUP_INDEX_VERSION,
            entries,
        }
    }

    fn autos(range: std::ops::RangeInclusive<u64>, size: u64) -> Vec<BackupEntry> {
        range
            .map(|t| entry(&BackupKind::Auto.file_name(t), BackupKind::Auto, t, size))
            .collect()
    }

    const UNLIMITED: u64 = u64::MAX;

    #[test]
    fn sixth_auto_backup_evicts_the_oldest_auto_and_keeps_manuals() {
        let dir = PathBuf::from("w");
        let mut entries = autos(1..=6, 10);
        entries.push(entry("0-manual.zip", BackupKind::Manual, 0, 10));
        entries.push(entry("3-manual.zip", BackupKind::Manual, 3, 10));
        let plan = plan_prune(
            &[(dir.clone(), index(entries))],
            RetentionPolicy {
                keep_per_world: 5,
                max_total_bytes: UNLIMITED,
            },
            Some((&dir, "6-auto.zip")),
        );
        assert_eq!(plan, vec![(dir, "1-auto.zip".to_owned())]);
    }

    #[test]
    fn keep_one_per_world_counts_each_world_separately() {
        let (a, b) = (PathBuf::from("a"), PathBuf::from("b"));
        let mut a_entries = autos(1..=3, 1);
        a_entries.push(entry("9-manual.zip", BackupKind::Manual, 9, 1));
        let plan = plan_prune(
            &[
                (a.clone(), index(a_entries)),
                (b.clone(), index(autos(4..=5, 1))),
            ],
            RetentionPolicy {
                keep_per_world: 1,
                max_total_bytes: UNLIMITED,
            },
            None,
        );
        assert_eq!(
            plan,
            vec![
                (a.clone(), "2-auto.zip".to_owned()),
                (a, "1-auto.zip".to_owned()),
                (b, "4-auto.zip".to_owned()),
            ]
        );
    }

    #[test]
    fn over_the_total_cap_the_oldest_autos_go_first_across_worlds() {
        let (a, b) = (PathBuf::from("a"), PathBuf::from("b"));
        // a: 自动 1、4，手动 2；b: 自动 3、5。每份 100，共 500。
        let a_index = index(vec![
            entry("1-auto.zip", BackupKind::Auto, 1, 100),
            entry("2-manual.zip", BackupKind::Manual, 2, 100),
            entry("4-auto.zip", BackupKind::Auto, 4, 100),
        ]);
        let b_index = index(
            autos(3..=3, 100)
                .into_iter()
                .chain(autos(5..=5, 100))
                .collect(),
        );
        let indices = [(a.clone(), a_index), (b.clone(), b_index)];
        let policy = |max| RetentionPolicy {
            keep_per_world: 5,
            max_total_bytes: max,
        };
        // 正好等于上限不删。
        assert!(plan_prune(&indices, policy(500), None).is_empty());
        // 超 1 字节：删全局最旧的自动备份一份。
        assert_eq!(
            plan_prune(&indices, policy(499), None),
            vec![(a.clone(), "1-auto.zip".to_owned())]
        );
        // 上限 250：删掉 1、3、4 三份自动，剩手动 2 与刚写的 5。
        assert_eq!(
            plan_prune(&indices, policy(250), Some((&b, "5-auto.zip"))),
            vec![
                (a.clone(), "1-auto.zip".to_owned()),
                (b.clone(), "3-auto.zip".to_owned()),
                (a.clone(), "4-auto.zip".to_owned()),
            ]
        );
        // 上限 0：自动全删（刚写的那份除外），手动不动。
        assert_eq!(
            plan_prune(&indices, policy(0), Some((&b, "5-auto.zip"))).len(),
            3
        );
    }

    /// 刚写成的那一份在第一步也不能被删：配置手改成每个存档 0 份，或系统时钟往回拨过、新备份的时刻比旧的还早时，
    /// 按时刻排序会把它排到保留份数之外，备份刚报成功文件就没了。它占保留份数里的一份，其余按时刻倒序补足。
    #[test]
    fn the_fresh_backup_survives_the_per_world_cut() {
        let dir = PathBuf::from("w");
        let policy = |keep| RetentionPolicy {
            keep_per_world: keep,
            max_total_bytes: UNLIMITED,
        };
        let indices = [(dir.clone(), index(autos(1..=3, 10)))];
        assert_eq!(
            plan_prune(&indices, policy(0), Some((&dir, "3-auto.zip"))),
            vec![
                (dir.clone(), "2-auto.zip".to_owned()),
                (dir.clone(), "1-auto.zip".to_owned()),
            ]
        );
        // 时钟回拨：刚写的是时刻最早的 1，保留 2 份时留下它与最新的 3。
        assert_eq!(
            plan_prune(&indices, policy(2), Some((&dir, "1-auto.zip"))),
            vec![(dir.clone(), "2-auto.zip".to_owned())]
        );
        // 不在这个存档里的 keep 不影响这里的取舍。
        assert_eq!(
            plan_prune(&indices, policy(2), Some((Path::new("别处"), "1-auto.zip"))),
            vec![(dir, "1-auto.zip".to_owned())]
        );
    }

    #[test]
    fn a_single_world_larger_than_the_cap_keeps_its_fresh_backup() {
        let dir = PathBuf::from("w");
        let plan = plan_prune(
            &[(dir.clone(), index(autos(1..=2, 1000)))],
            RetentionPolicy {
                keep_per_world: 5,
                max_total_bytes: 500,
            },
            Some((&dir, "2-auto.zip")),
        );
        assert_eq!(plan, vec![(dir, "1-auto.zip".to_owned())]);
    }

    #[test]
    fn manual_backups_are_never_pruned_even_over_the_cap() {
        let dir = PathBuf::from("w");
        let manuals = (1..=8)
            .map(|t| {
                entry(
                    &BackupKind::Manual.file_name(t),
                    BackupKind::Manual,
                    t,
                    1000,
                )
            })
            .collect();
        let plan = plan_prune(
            &[(dir, index(manuals))],
            RetentionPolicy {
                keep_per_world: 1,
                max_total_bytes: 1,
            },
            None,
        );
        assert!(plan.is_empty());
    }

    #[test]
    fn entries_with_unsafe_file_names_are_left_alone() {
        let dir = PathBuf::from("w");
        let plan = plan_prune(
            &[(
                dir,
                index(vec![
                    entry("../../config.json", BackupKind::Auto, 1, 1),
                    entry("2-auto.zip", BackupKind::Auto, 2, 1),
                ]),
            )],
            RetentionPolicy {
                keep_per_world: 0,
                max_total_bytes: 0,
            },
            None,
        );
        assert_eq!(plan, vec![(PathBuf::from("w"), "2-auto.zip".to_owned())]);
    }

    #[tokio::test]
    async fn index_roundtrips_tolerates_old_files_and_reports_corruption() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("w");
        assert_eq!(read_backup_index(&dir).await.unwrap(), BackupIndex::empty());

        let written = index(vec![BackupEntry {
            level_name: Some("周末生存".into()),
            ..entry("5-manual.zip", BackupKind::Manual, 5, 42)
        }]);
        write_backup_index(&dir, &written).await.unwrap();
        let raw: serde_json::Value =
            serde_json::from_slice(&fs::read(dir.join(BACKUP_INDEX_FILE)).unwrap()).unwrap();
        assert_eq!(
            raw,
            serde_json::json!({
                "version": 1,
                "entries": [{
                    "file": "5-manual.zip",
                    "kind": "manual",
                    "created_at": 5,
                    "size_bytes": 42,
                    "level_name": "周末生存",
                }]
            })
        );
        assert_eq!(read_backup_index(&dir).await.unwrap(), written);

        // 缺字段与多出来的字段都照常读。
        fs::write(
            dir.join(BACKUP_INDEX_FILE),
            r#"{"entries":[{"file":"1-auto.zip","kind":"auto","created_at":1,"size_bytes":2,"future":true}],"extra":1}"#,
        )
        .unwrap();
        let old = read_backup_index(&dir).await.unwrap();
        assert_eq!(old.version, 0);
        assert_eq!(
            old.entries,
            vec![entry("1-auto.zip", BackupKind::Auto, 1, 2)]
        );

        fs::write(dir.join(BACKUP_INDEX_FILE), "{ broken").unwrap();
        match read_backup_index(&dir).await.unwrap_err() {
            Error::BackupIndexInvalid { path, .. } => {
                assert_eq!(path, dir.join(BACKUP_INDEX_FILE))
            }
            other => panic!("应报清单读不懂，实际：{other:?}"),
        }
    }

    #[tokio::test]
    async fn scan_walks_instance_and_shared_scopes_separately() {
        let tmp = tempfile::tempdir().unwrap();
        let layout = BackupLayout::new(tmp.path());
        let instance_shared = layout.world_dir(&WorldScope::Instance("shared".into()), "w1");
        let shared = layout.world_dir(&WorldScope::Shared, "w1");
        let other = layout.world_dir(&WorldScope::Instance("a".into()), "w2");
        assert_ne!(
            instance_shared, shared,
            "名叫 shared 的实例撞不上共用作用域"
        );
        for (dir, n) in [(&instance_shared, 1u64), (&shared, 2), (&other, 3)] {
            write_backup_index(dir, &index(autos(n..=n, n)))
                .await
                .unwrap();
        }
        let found: Vec<(PathBuf, u64)> = scan_backup_indices(layout.root())
            .await
            .unwrap()
            .into_iter()
            .map(|(dir, index)| (dir, index.entries[0].created_at))
            .collect();
        assert_eq!(found, vec![(other, 3), (instance_shared, 1), (shared, 2)]);
        assert!(
            scan_backup_indices(&tmp.path().join("nowhere"))
                .await
                .unwrap()
                .is_empty()
        );
    }

    #[test]
    fn layout_paths_follow_the_scope() {
        let layout = BackupLayout::new(Path::new("D:/mc"));
        let root = Path::new("D:/mc").join(AURORA_META_DIR).join("backups");
        assert_eq!(layout.root(), root);
        assert_eq!(
            layout.world_dir(&WorldScope::Instance("生存".into()), "新的世界"),
            root.join("instances").join("生存").join("新的世界")
        );
        assert_eq!(
            layout.world_dir(&WorldScope::Shared, "新的世界"),
            root.join("shared").join("新的世界")
        );
        assert_eq!(
            layout.instance_dir("生存"),
            root.join("instances").join("生存")
        );
    }

    #[test]
    fn backup_file_names_must_be_plain_zip_names() {
        for ok in ["1-auto.zip", "1-manual.ZIP", "x.zip"] {
            assert!(is_backup_file_name(ok), "{ok}");
        }
        for bad in [
            "",
            ".zip",
            "../1-auto.zip",
            "a/b.zip",
            "a\\b.zip",
            "C:x.zip",
            "1-auto.rar",
            ".hidden.zip",
        ] {
            assert!(!is_backup_file_name(bad), "{bad}");
        }
    }

    #[test]
    fn partial_backups_are_cleared() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("w");
        write(&dir.join("1-auto.zip.part"), b"half");
        write(&dir.join("2-auto.zip"), b"whole");
        write(&dir.join(BACKUP_INDEX_FILE), b"{}");
        assert_eq!(remove_partial_backups(&dir).unwrap(), 1);
        assert!(!dir.join("1-auto.zip.part").exists());
        assert!(dir.join("2-auto.zip").exists());
        assert_eq!(remove_partial_backups(&tmp.path().join("none")).unwrap(), 0);
    }

    #[tokio::test]
    async fn merge_moves_whole_directories_and_merges_clashing_worlds() {
        let tmp = tempfile::tempdir().unwrap();
        let from = tmp.path().join("instances").join("旧名");
        let to = tmp.path().join("instances").join("新名");

        // 目标不存在：整目录改名。
        write(&from.join("w").join("1-auto.zip"), b"one");
        write_backup_index(&from.join("w"), &index(autos(1..=1, 3)))
            .await
            .unwrap();
        merge_scope_dir(&from, &to).await.unwrap();
        assert!(!from.exists());
        assert_eq!(fs::read(to.join("w").join("1-auto.zip")).unwrap(), b"one");

        // 目标已有同名存档与同名文件：撞名的毫秒加 1，清单合并，源目录删掉。
        write(&from.join("w").join("1-auto.zip"), b"clash");
        write(&from.join("w").join("7-manual.zip"), b"seven");
        write(&from.join("other").join("2-auto.zip"), b"two");
        write_backup_index(
            &from.join("w"),
            &index(vec![
                entry("1-auto.zip", BackupKind::Auto, 1, 5),
                entry("7-manual.zip", BackupKind::Manual, 7, 5),
                entry("9-auto.zip", BackupKind::Auto, 9, 5),
            ]),
        )
        .await
        .unwrap();
        write_backup_index(&from.join("other"), &index(autos(2..=2, 3)))
            .await
            .unwrap();
        merge_scope_dir(&from, &to).await.unwrap();

        assert!(!from.exists(), "源目录应已删掉");
        let merged = read_backup_index(&to.join("w")).await.unwrap();
        let files: Vec<(&str, u64)> = merged
            .entries
            .iter()
            .map(|e| (e.file.as_str(), e.created_at))
            .collect();
        // 盘上没有的 9-auto 不再带过来。
        assert_eq!(
            files,
            vec![("1-auto.zip", 1), ("2-auto.zip", 2), ("7-manual.zip", 7)]
        );
        assert_eq!(fs::read(to.join("w").join("1-auto.zip")).unwrap(), b"one");
        assert_eq!(fs::read(to.join("w").join("2-auto.zip")).unwrap(), b"clash");
        assert_eq!(
            fs::read(to.join("w").join("7-manual.zip")).unwrap(),
            b"seven"
        );
        assert_eq!(
            fs::read(to.join("other").join("2-auto.zip")).unwrap(),
            b"two"
        );

        // 源不存在是空操作。
        merge_scope_dir(&from, &to).await.unwrap();
        assert_eq!(read_backup_index(&to.join("w")).await.unwrap(), merged);
    }

    #[test]
    fn locked_session_means_the_world_is_in_use() {
        let tmp = tempfile::tempdir().unwrap();
        let world = tmp.path().join("w");
        fs::create_dir_all(&world).unwrap();
        assert!(!world_in_use(&world).unwrap(), "没有 session.lock 不算占用");
        assert!(!world_in_use(&tmp.path().join("missing")).unwrap());

        let lock_path = world.join(SESSION_LOCK);
        fs::write(&lock_path, "\u{2603}").unwrap();
        assert!(!world_in_use(&world).unwrap(), "文件在但没人锁");

        // 游戏用另一个句柄锁住整个文件；同进程里另开一个句柄同样拿不到。
        let holder = fs::OpenOptions::new().write(true).open(&lock_path).unwrap();
        holder.lock().unwrap();
        assert!(world_in_use(&world).unwrap());
        holder.unlock().unwrap();
        assert!(!world_in_use(&world).unwrap(), "放锁之后又可以备份");
    }
}
