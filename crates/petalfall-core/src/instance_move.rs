//! 把实例移到另一个游戏目录。
//!
//! 实例的位置由名字决定（`<游戏目录>/versions/<id>`），所以「移到别处」只有一种意思：换一个游戏目录。实例目录里的
//! 东西（设置、卷宗、日志、崩溃记录、回滚历史）整体带走；不在里面的三类要迁：游玩记录（全局文件里按游戏目录
//! 分账）、存档备份（`<游戏目录>/.petalfall/backups/instances/<id>`）与配置里的引用。共用的库、资源与继承链上的
//! 基底版本按游戏目录各一份，目标缺的从原目录补过去：Forge 处理器生成的文件下载不回来，不补就启动不了。
//!
//! 三段：预检（[`Petalfall::preview_instance_move`]）只读不写，把拦着这次移动的问题全列出来；执行
//! （[`Petalfall::move_instance_files`]）先补依赖，同卷一次改名提交，跨卷先复制进目标盘的暂存、读回比对，再两步
//! 改名提交；启动收尾（[`Petalfall::recover_instance_moves`]）按移动日志与盘面把中断的移动回滚或补完。提交之前
//! 原件一直在原位，失败与取消只删暂存；提交之后不再回头，记录迁移与清理失败只记跟进项。执行成功后的收尾与
//! 启动收尾是同一个函数，可以重入。

use std::collections::BTreeMap;
use std::fmt;
use std::path::{Component, Path, PathBuf, Prefix};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, PoisonError};
use std::time::{Duration, Instant};

use petalfall_base::error_with_causes;
use petalfall_download::CancellationToken;
use petalfall_instance::{VERSIONS_DIR, discover_versions, is_backup_file_name, list_version_dirs};
use tokio::sync::{RwLock, RwLockReadGuard};

use crate::InstanceError;
use crate::error::{CoreError, Result};
use crate::event::{CoreEvent, DownloadProgress, EventSink, InstallPhase, emit};
use crate::facade::Petalfall;
use crate::folders::{probe_dir, validate_game_dir};
use crate::instances::{dependents_in, record_base_versions_in};
use crate::move_copy::{
    CopyControl, Sha1Digest, TreeScan, available_space, copy_file, copy_tree, remove_tree,
    same_volume, scan_tree, verify_tree,
};
use crate::move_deps::{DependencyFile, DependencyPlan, plan_dependencies};
use crate::move_journal::{self, JournalEntry, MoveJournal, MoveStage};
use crate::world_backup::{
    instance_backups_dir_in, merge_staged_backups, move_backups_between, remove_instance_backups_in,
};

/// 拦着一次移动的问题。预检把它们全列出来给界面；执行前重新预检，遇到的第一个报
/// [`CoreError::InstanceMoveBlocked`](crate::CoreError::InstanceMoveBlocked)。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MoveBlocker {
    /// 目标就是实例现在所在的游戏目录。
    SameDirectory,
    /// 目标游戏目录在实例目录里面。
    TargetInsideSource,
    /// 目标里已有同名（不分大小写）的版本目录，含隐藏的依赖版本目录。
    NameTaken,
    /// 别的实例经 `inheritsFrom` 依赖它。
    HasDependents(Vec<String>),
    /// 实例目录或它的备份目录里有符号链接、目录联接（相对实例目录或备份目录的路径）。复制会把链接指向的
    /// 内容复制一份，删原件时又可能顺着链接删到别处。
    Links(Vec<PathBuf>),
    /// 目标里已有同名、内容不同的基底版本。
    BaseConflict(Vec<String>),
    /// 目标盘空间不够：这次要写的字节加上余量，与目标盘剩余的字节。
    InsufficientSpace { needed: u64, available: u64 },
    /// 这个实例有一次中断的移动还没收尾（当时有目录访问不到），收尾前不能再移。
    Pending,
}

impl fmt::Display for MoveBlocker {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            MoveBlocker::SameDirectory => f.write_str("目标就是它现在所在的游戏目录"),
            MoveBlocker::TargetInsideSource => f.write_str("目标游戏目录在实例目录里面"),
            MoveBlocker::NameTaken => f.write_str("目标游戏目录里已有同名的版本"),
            MoveBlocker::HasDependents(ids) => {
                write!(f, "有实例依赖它：{}", ids.join("、"))
            }
            MoveBlocker::Links(paths) => {
                let listed: Vec<String> = paths.iter().map(|p| p.display().to_string()).collect();
                write!(f, "里面有链接：{}", listed.join("、"))
            }
            MoveBlocker::BaseConflict(ids) => {
                write!(f, "目标里的同名基底版本内容不同：{}", ids.join("、"))
            }
            MoveBlocker::InsufficientSpace { needed, available } => {
                write!(f, "目标盘空间不够：要 {needed} 字节，剩 {available} 字节")
            }
            MoveBlocker::Pending => f.write_str("上一次移动还没收尾"),
        }
    }
}

/// 移动前的预检结果，不写盘。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MovePreview {
    pub id: String,
    /// 实例现在所在的游戏目录。
    pub source_game_dir: PathBuf,
    /// 要移去的游戏目录（可能还不存在，执行时建）。
    pub target_game_dir: PathBuf,
    /// 两个游戏目录在同一个卷上：实例目录与备份直接改名过去，不复制。
    pub same_volume: bool,
    /// 实例目录的字节与文件数。
    pub instance_bytes: u64,
    pub instance_files: u64,
    /// 随实例带走的备份（`instances/<id>`）的字节与份数。
    pub backup_bytes: u64,
    pub backup_count: u32,
    /// 要补到目标的共用文件（库、资源、日志配置、处理器产物）的个数与字节，不含基底版本。
    pub dependency_files: u64,
    pub dependency_bytes: u64,
    /// 目标里没有、要带过去的基底版本，由近及远。
    pub bases_to_copy: Vec<String>,
    /// 目标里已有、内容相同直接用的基底版本。
    pub reused_bases: Vec<String>,
    /// 原目录里也缺的共用文件数；下次启动时由补全下载。
    pub missing_in_source: u64,
    /// 这次要写进目标盘的字节（不含余量）。
    pub required_bytes: u64,
    /// 目标盘剩余的字节。
    pub available_bytes: u64,
    /// 是否隔离。不隔离时存档、Mod 与游戏设置在原游戏目录根下和别的实例共用，不跟着走。
    pub isolated: bool,
    /// 拦着这次移动的问题；为空才能移。
    pub blockers: Vec<MoveBlocker>,
}

/// 一次移动的请求。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MoveRequest {
    pub id: String,
    pub target_game_dir: PathBuf,
}

/// 移动已经完成，但没跟过去、要提示玩家的一项。带的字符串是人类可读的原因。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MoveFollowUp {
    /// 游玩记录没挪过去：已记下待补，之后读写游玩记录时补上。
    PlayRecords(String),
    /// 备份没挪过去，留在原游戏目录。
    WorldBackups(String),
    /// 移动留下的旧文件没删干净（路径）。原件改名后的旧目录与目标盘上的暂存下次启动时再清；原游戏目录里
    /// 已经并过去的备份不再自动清（那时原目录里可能已有同名的新实例），留给玩家处理。
    Cleanup { path: PathBuf, reason: String },
}

/// 一次完成的移动。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MoveOutcome {
    pub id: String,
    pub source_game_dir: PathBuf,
    pub target_game_dir: PathBuf,
    /// 为空即全部跟过去了。
    pub follow_ups: Vec<MoveFollowUp>,
}

/// 启动时收尾一份中断的移动的结论。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MoveRecovery {
    /// 提交前就中断了：暂存已删，实例还在原游戏目录。
    RolledBack {
        id: String,
        source_game_dir: PathBuf,
        target_game_dir: PathBuf,
    },
    /// 提交已经完成：补做了记录迁移与清理。调用方据此去掉原游戏目录在配置里对它的引用。
    Completed(MoveOutcome),
    /// 有目录访问不到、收尾中途出错，或盘面与日志对不上不敢动（`reason` 里带着各处路径），日志留着，下次启动再试。
    Deferred { id: String, reason: String },
}

// ---- 执行环境 ----

/// 目标盘写完之后至少还要剩下的字节：盘写满时游戏的存档与日志都会写坏。
const SPACE_MARGIN: u64 = 256 * 1024 * 1024;
/// 暂存目录里实例副本与备份副本的位置。
const STAGED_INSTANCE: &str = "instance";
const STAGED_BACKUPS: &str = "backups";
/// 字节进度事件的最小间隔，与下载进度的节流一致。
const PROGRESS_INTERVAL: Duration = Duration::from_millis(100);
/// 补共用文件时同时复制的文件数：资源对象是几千个小文件，每个都要落盘再读回比对，一个接一个太慢。
const DEPENDENCY_WORKERS: usize = 4;

/// 执行与启动收尾之间的门：执行占读锁（几个实例可以同时移），启动收尾占写锁。启动收尾在后台跑，这时玩家已经
/// 能点移动；不隔开的话，收尾会把正在进行的那次移动的日志当成中断的，回滚掉它的暂存甚至原件。
static MOVE_GATE: RwLock<()> = RwLock::const_new(());

/// 预检与执行里随环境而定的几项。生产全部自动判断；测试强制走跨卷的复制路径、改写目标盘的剩余空间、往复制里
/// 注入故障。
#[derive(Clone, Default)]
pub(crate) struct MoveEnv {
    volume: VolumeMode,
    #[cfg(test)]
    available_space: Option<u64>,
    #[cfg(test)]
    fault: Option<SharedFault>,
}

/// 测试注入的写后钩子（见 [`CopyControl::with_fault`]）。要带进阻塞线程，所以是 `Arc` 且 `Send`。
#[cfg(test)]
type SharedFault = Arc<dyn Fn(&Path) -> std::io::Result<()> + Send + Sync>;

/// 同卷与否怎么定。
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub(crate) enum VolumeMode {
    /// 按两个游戏目录所在的卷判断。
    #[default]
    Auto,
    /// 同卷也按跨卷复制。
    #[cfg(test)]
    CrossVolume,
}

impl MoveEnv {
    fn same_volume(&self, detected: bool) -> bool {
        match self.volume {
            VolumeMode::Auto => detected,
            #[cfg(test)]
            VolumeMode::CrossVolume => false,
        }
    }

    fn available_space(&self, detected: u64) -> u64 {
        #[cfg(test)]
        if let Some(space) = self.available_space {
            return space;
        }
        detected
    }

    fn control<'a>(
        &'a self,
        cancel: Option<&'a CancellationToken>,
        progress: &'a (dyn Fn(u64, u64) + Sync),
    ) -> CopyControl<'a> {
        #[cfg(test)]
        if let Some(fault) = &self.fault {
            return CopyControl::new(cancel, progress).with_fault(fault.as_ref());
        }
        CopyControl::new(cancel, progress)
    }
}

// ---- 预检 ----

/// 预检的结论：预览交给界面，其余交给执行接着用。
struct Inspection {
    preview: MovePreview,
    plan: DependencyPlan,
    instance_dir: PathBuf,
    backups_dir: PathBuf,
}

/// 预检里在阻塞线程上做的盘点。
struct Footprint {
    instance: TreeScan,
    /// 实例名下的备份目录不在时为 `None`。
    backups: Option<TreeScan>,
    same_volume: bool,
    available: u64,
}

impl Petalfall {
    /// 预检，不写盘。源是当前游戏目录，目标可以还不存在。实例不在报 [`CoreError::VersionNotInstalled`]，目标路径
    /// 不合法报 [`CoreError::InvalidGameDirectory`]，版本 JSON 坏了照实报错；拦着移动的问题全列进
    /// [`MovePreview::blockers`]。
    pub async fn preview_instance_move(
        &self,
        id: &str,
        target_game_dir: &Path,
    ) -> Result<MovePreview> {
        Ok(self
            .inspect_move(id, target_game_dir, &MoveEnv::default())
            .await?
            .preview)
    }

    /// 执行。先重新预检，有拦截项报 [`CoreError::InstanceMoveBlocked`]（第一个）。`events` 推步骤与进度；取消看
    /// 门面快照上的令牌，提交开始后不再理会。只处理文件与记录，配置里的引用由调用方随后经
    /// [`Petalfall::forget_moved_instance`] 改掉并落盘。
    ///
    /// 提交之前失败或取消时原件不动、暂存与日志删掉再报错；提交之后的记录迁移与清理失败记进
    /// [`MoveOutcome::follow_ups`]，照常返回成功。
    pub async fn move_instance_files(
        &self,
        request: &MoveRequest,
        events: Option<EventSink>,
    ) -> Result<MoveOutcome> {
        self.move_instance_files_with(request, events, &MoveEnv::default())
            .await
    }

    /// 启动时按移动日志收尾：提交前中断的回滚，提交了的补完记录迁移与清理。读不懂的日志改名成 `.broken` 留着，
    /// 接着收下一份；一份收不了（目录访问不到、出错、盘面对不上）记为 [`MoveRecovery::Deferred`]，日志留着下次再试。
    /// 只有读不了日志目录本身才报错。
    pub async fn recover_instance_moves(&self) -> Result<Vec<MoveRecovery>> {
        let _gate = MOVE_GATE.write().await;
        let mut recovered = Vec::new();
        for entry in move_journal::list(self.data_dir()).await? {
            match entry {
                JournalEntry::Read(journal) => recovered.push(self.recover_move(journal).await),
                JournalEntry::Unreadable { path, reason } => {
                    tracing::warn!(path = %path.display(), reason, "移动日志读不懂，改名留着");
                    if let Err(err) = move_journal::quarantine(&path).await {
                        let error = error_with_causes(&err);
                        tracing::warn!(path = %path.display(), %error, "读不懂的移动日志改名失败");
                    }
                }
            }
        }
        Ok(recovered)
    }

    async fn inspect_move(&self, id: &str, target: &Path, env: &MoveEnv) -> Result<Inspection> {
        let target = validate_game_dir(&target.to_string_lossy())?;
        let source = self.game_dir().to_path_buf();
        let instance_dir = self.existing_instance_dir(id).await?;
        // Windows 上大小写不同的 id 也打得开目录；照它改名会改掉实例名的大小写，记录与备份也就对不上了。
        let listed = list_version_dirs(&source).await?.unwrap_or_default();
        if !listed.iter().any(|name| name == id) {
            return Err(CoreError::VersionNotInstalled { id: id.to_owned() });
        }
        let backups_dir = instance_backups_dir_in(&source, id);
        let footprint = tokio::task::spawn_blocking({
            let (instance_dir, backups_dir, source, target) = (
                instance_dir.clone(),
                backups_dir.clone(),
                source.clone(),
                target.clone(),
            );
            move || take_footprint(&instance_dir, &backups_dir, &source, &target)
        });
        let plan = plan_dependencies(&source, &target, id, self.runtime()).await?;
        let dependents = dependents_in(&discover_versions(&source).await?, id);
        let name_taken = name_taken(&target, id).await?;
        let isolated = self.resolve_working_dir(id).await?.isolated;
        let pending = move_journal::is_held(self.data_dir(), id, &source).await?;
        let indexed_backups = self.instance_backup_count(id).await;
        let footprint = footprint.await??;

        let backup_count = match indexed_backups {
            Ok(count) => count,
            Err(CoreError::Instance(InstanceError::BackupIndexInvalid { path, reason })) => {
                // 清单读不懂只影响这个数字，同删除预览：改数盘上的备份文件，不让移动对话框打不开。
                tracing::warn!(id, path = %path.display(), reason, "备份清单读不懂，移动预检改数盘上的备份文件");
                footprint.backups.as_ref().map_or(0, count_backup_files)
            }
            Err(err) => return Err(err),
        };
        let same_volume = env.same_volume(footprint.same_volume);
        let available_bytes = env.available_space(footprint.available);
        let backup_bytes = footprint
            .backups
            .as_ref()
            .map_or(0, |scan| scan.total_bytes);
        let dependency_bytes = plan.files.iter().map(|file| file.size).sum();
        let required_bytes = plan.total_bytes()
            + if same_volume {
                0
            } else {
                footprint.instance.total_bytes + backup_bytes
            };

        let same_dir = lexical_key(&source) == lexical_key(&target);
        let mut blockers = Vec::new();
        if same_dir {
            blockers.push(MoveBlocker::SameDirectory);
        }
        if is_within(&target, &instance_dir) {
            blockers.push(MoveBlocker::TargetInsideSource);
        }
        // 目标就是源时，「同名」的正是它自己，再报一遍只会让人困惑。
        if name_taken && !same_dir {
            blockers.push(MoveBlocker::NameTaken);
        }
        if !dependents.is_empty() {
            blockers.push(MoveBlocker::HasDependents(dependents));
        }
        let links = link_paths(
            &footprint.instance,
            footprint.backups.as_ref(),
            &source,
            &backups_dir,
        );
        if !links.is_empty() {
            blockers.push(MoveBlocker::Links(links));
        }
        if !plan.conflicting_bases.is_empty() {
            blockers.push(MoveBlocker::BaseConflict(plan.conflicting_bases.clone()));
        }
        let needed = required_bytes.saturating_add(SPACE_MARGIN);
        if available_bytes < needed {
            blockers.push(MoveBlocker::InsufficientSpace {
                needed,
                available: available_bytes,
            });
        }
        if pending {
            blockers.push(MoveBlocker::Pending);
        }

        let preview = MovePreview {
            id: id.to_owned(),
            source_game_dir: source,
            target_game_dir: target,
            same_volume,
            instance_bytes: footprint.instance.total_bytes,
            instance_files: footprint.instance.files.len() as u64,
            backup_bytes,
            backup_count,
            dependency_files: plan.file_count(),
            dependency_bytes,
            bases_to_copy: plan.bases.iter().map(|base| base.id.clone()).collect(),
            reused_bases: plan.reused_bases.clone(),
            missing_in_source: plan.missing_in_source,
            required_bytes,
            available_bytes,
            isolated,
            blockers,
        };
        Ok(Inspection {
            preview,
            plan,
            instance_dir,
            backups_dir,
        })
    }
}

fn take_footprint(
    instance_dir: &Path,
    backups_dir: &Path,
    source: &Path,
    target: &Path,
) -> Result<Footprint> {
    Ok(Footprint {
        instance: scan_tree(instance_dir)?,
        backups: scan_if_present(backups_dir)?,
        same_volume: same_volume(source, target)?,
        available: available_space(target)?,
    })
}

/// 目标里有没有同名（不分大小写）的版本目录，含点开头之外的隐藏依赖版本目录；同名的文件或链接也算占着。
async fn name_taken(target: &Path, id: &str) -> Result<bool> {
    let key = id.to_lowercase();
    if list_version_dirs(target)
        .await?
        .is_some_and(|names| names.iter().any(|name| name.to_lowercase() == key))
    {
        return Ok(true);
    }
    path_exists(&target.join(VERSIONS_DIR).join(id)).await
}

/// 实例目录里的链接（相对实例目录），加上备份目录里的链接（相对游戏目录，以 `.petalfall/backups/...` 开头，与实例
/// 目录里的区分开）。
fn link_paths(
    instance: &TreeScan,
    backups: Option<&TreeScan>,
    source: &Path,
    backups_dir: &Path,
) -> Vec<PathBuf> {
    let mut links = instance.links.clone();
    if let Some(scan) = backups {
        let prefix = backups_dir.strip_prefix(source).unwrap_or(backups_dir);
        links.extend(scan.links.iter().map(|rel| {
            if rel.as_os_str().is_empty() {
                prefix.to_path_buf()
            } else {
                prefix.join(rel)
            }
        }));
    }
    links
}

/// 备份目录（`instances/<id>`）下各存档目录里按文件名认得出的备份文件数，不读清单。
fn count_backup_files(scan: &TreeScan) -> u32 {
    scan.files
        .iter()
        .filter(|file| {
            let mut parts = file.rel.components();
            matches!(
                (parts.next(), parts.next(), parts.next()),
                (Some(Component::Normal(_)), Some(Component::Normal(name)), None)
                    if name.to_str().is_some_and(is_backup_file_name)
            )
        })
        .count() as u32
}

/// 路径按字面规整成可比较的键：盘符与各段不分大小写，`/` 与 `\` 一样，去掉 `.`、按 `..` 回退一级、去掉末尾分隔符。
/// 不走 `canonicalize`：目标可能还不存在。
fn lexical_key(path: &Path) -> String {
    let mut prefix = String::new();
    let mut parts: Vec<String> = Vec::new();
    for component in path.components() {
        match component {
            Component::Prefix(p) => {
                prefix = match p.kind() {
                    Prefix::Disk(drive) | Prefix::VerbatimDisk(drive) => {
                        format!("{}:", char::from(drive).to_ascii_lowercase())
                    }
                    _ => p.as_os_str().to_string_lossy().to_lowercase(),
                }
            }
            Component::RootDir | Component::CurDir => {}
            Component::ParentDir => {
                parts.pop();
            }
            Component::Normal(part) => parts.push(part.to_string_lossy().to_lowercase()),
        }
    }
    format!("{prefix}\\{}", parts.join("\\"))
}

/// `path` 是不是 `dir` 本身或在它里面（[`lexical_key`] 口径）。
fn is_within(path: &Path, dir: &Path) -> bool {
    let (path, dir) = (lexical_key(path), lexical_key(dir));
    path == dir || path.starts_with(&format!("{}\\", dir.trim_end_matches('\\')))
}

// ---- 执行 ----

/// 跨卷复制进暂存的结果：复制时的清单与摘要，校验与查原件有没有变都按它。
struct Staged {
    instance: TreeScan,
    instance_digests: Vec<Sha1Digest>,
    backups: Option<(TreeScan, Vec<Sha1Digest>)>,
}

/// 提交失败时原件的下落。
enum CommitError {
    /// 原件在原位：删暂存与日志即可。
    Restored(CoreError),
    /// 原件停在旧目录、改不回去：日志留给启动收尾。
    Stranded(CoreError),
}

impl Petalfall {
    /// [`Petalfall::move_instance_files`] 的本体；测试经 `env` 强制走跨卷路径、改写剩余空间、注入故障。
    pub(crate) async fn move_instance_files_with(
        &self,
        request: &MoveRequest,
        events: Option<EventSink>,
        env: &MoveEnv,
    ) -> Result<MoveOutcome> {
        let _gate = self.enter_move_gate().await?;
        let inspection = self
            .inspect_move(&request.id, &request.target_game_dir, env)
            .await?;
        if let Some(blocker) = inspection.preview.blockers.first() {
            return Err(CoreError::InstanceMoveBlocked {
                id: request.id.clone(),
                blocker: blocker.clone(),
            });
        }
        if self.is_cancelled() {
            return Err(InstanceError::Cancelled.into());
        }
        let events = events.as_ref();
        let preview = &inspection.preview;
        let versions = preview.target_game_dir.join(VERSIONS_DIR);
        tokio::fs::create_dir_all(&versions)
            .await
            .map_err(|source| io_error(&versions, source))?;
        let mut journal = MoveJournal::new(
            move_journal::new_token()?,
            &preview.id,
            &preview.source_game_dir,
            &preview.target_game_dir,
            preview.same_volume,
            move_journal::now_millis()?,
        );
        move_journal::write(self.data_dir(), &journal).await?;
        tracing::info!(
            id = %preview.id,
            source = %preview.source_game_dir.display(),
            target = %preview.target_game_dir.display(),
            same_volume = preview.same_volume,
            token = %journal.token,
            "开始移动实例"
        );

        let steps = Steps::new(events, preview.same_volume);
        steps.enter(InstallPhase::MoveDependencies);
        if let Err(err) = self
            .copy_dependencies(&inspection.plan, &preview.target_game_dir, events, env)
            .await
        {
            return Err(self.abandon(&journal, err).await);
        }
        if !preview.same_volume {
            steps.enter(InstallPhase::MoveCopy);
            let staged = match self.stage_copies(&inspection, &journal, events, env).await {
                Ok(staged) => staged,
                Err(err) => return Err(self.abandon(&journal, err).await),
            };
            journal.backups_staged = staged.backups.is_some();
            steps.enter(InstallPhase::MoveVerify);
            if let Err(err) = self
                .verify_copies(&inspection, &journal, staged, events, env)
                .await
            {
                return Err(self.abandon(&journal, err).await);
            }
        }

        steps.enter(InstallPhase::MoveCommit);
        if self.is_cancelled() {
            return Err(self
                .abandon(&journal, InstanceError::Cancelled.into())
                .await);
        }
        journal.stage = MoveStage::Committing;
        if let Err(err) = move_journal::write(self.data_dir(), &journal).await {
            // 原子写失败时盘上还是上一版（复制中），原件没动，照提交前失败处理。
            return Err(self.abandon(&journal, err).await);
        }
        self.commit(&inspection, &journal).await?;
        tracing::info!(id = %journal.id, token = %journal.token, "实例移动已提交");
        journal.stage = MoveStage::Committed;
        if let Err(err) = move_journal::write(self.data_dir(), &journal).await {
            // 实例已经在目标里，不能再报失败。日志停在「提交中」，启动收尾看盘面认得出已经提交。
            let error = error_with_causes(&err);
            tracing::error!(id = %journal.id, %error, "移动日志没记上已提交，接着收尾");
        }
        Ok(self.settle(journal).await)
    }

    /// 占执行那一侧的门；等的时候响应取消。
    async fn enter_move_gate(&self) -> Result<RwLockReadGuard<'static, ()>> {
        match self.cancel_token() {
            Some(token) => token
                .run_until_cancelled(MOVE_GATE.read())
                .await
                .ok_or_else(|| InstanceError::Cancelled.into()),
            None => Ok(MOVE_GATE.read().await),
        }
    }

    /// 第一步：先把要带的基底版本记进目标的依赖版本记录（落了一半时它们也不会被当成实例列出来），再补共用文件
    /// 与基底版本。目标里已有的跳过、不覆盖：它可能正被目标里的别的实例使用。已经补上的不随失败撤回：它们是目标
    /// 那边共用的缓存，正确且无害。
    async fn copy_dependencies(
        &self,
        plan: &DependencyPlan,
        target: &Path,
        events: Option<&EventSink>,
        env: &MoveEnv,
    ) -> Result<()> {
        let bases: Vec<String> = plan.bases.iter().map(|base| base.id.clone()).collect();
        if !bases.is_empty() {
            record_base_versions_in(target, &bases).await?;
        }
        let shared = plan.files.clone();
        let bases = base_copy_order(plan);
        let total = (shared.len() + bases.len()) as u64;
        let total_bytes = shared.iter().chain(&bases).map(|file| file.size).sum();
        let progress = StepProgress::start(events, total, total_bytes);
        let cancel = self.cancel_token().cloned();
        let env = env.clone();
        let reporter = progress.clone();
        blocking(move || {
            copy_dependencies_blocking(&shared, &bases, cancel.as_ref(), &reporter, &env)
        })
        .await?;
        progress.finish();
        Ok(())
    }

    /// 跨卷第一步：重新盘点原件（离预检已经过了补依赖这一步），把实例目录与备份复制进目标盘的暂存。
    async fn stage_copies(
        &self,
        inspection: &Inspection,
        journal: &MoveJournal,
        events: Option<&EventSink>,
        env: &MoveEnv,
    ) -> Result<Staged> {
        let staging = staging_dir(journal);
        let id = journal.id.clone();
        let source = journal.source_game_dir.clone();
        let instance_dir = inspection.instance_dir.clone();
        let backups_dir = inspection.backups_dir.clone();
        let cancel = self.cancel_token().cloned();
        let sink = events.cloned();
        let env = env.clone();
        blocking(move || {
            let instance = scan_tree(&instance_dir)?;
            let backups = scan_if_present(&backups_dir)?;
            let links = link_paths(&instance, backups.as_ref(), &source, &backups_dir);
            if !links.is_empty() {
                return Err(CoreError::InstanceMoveBlocked {
                    id,
                    blocker: MoveBlocker::Links(links),
                });
            }
            let scans = std::iter::once(&instance).chain(backups.as_ref());
            let (total, total_bytes) = scans.fold((0, 0), |(files, bytes), scan| {
                (files + scan.files.len() as u64, bytes + scan.total_bytes)
            });
            let progress = StepProgress::start(sink.as_ref(), total, total_bytes);
            let report = |bytes, files| progress.advance(bytes, files);
            let control = env.control(cancel.as_ref(), &report);
            std::fs::create_dir_all(&staging).map_err(|source| io_error(&staging, source))?;
            let instance_digests = copy_tree(
                &instance_dir,
                &staging.join(STAGED_INSTANCE),
                &instance,
                &control,
            )?;
            let backups = match backups {
                Some(scan) => {
                    let digests =
                        copy_tree(&backups_dir, &staging.join(STAGED_BACKUPS), &scan, &control)?;
                    Some((scan, digests))
                }
                None => None,
            };
            progress.finish();
            Ok(Staged {
                instance,
                instance_digests,
                backups,
            })
        })
        .await
    }

    /// 跨卷第二步：读回暂存逐个比大小与 SHA-1，再确认原件在复制之后没有变过：多出来的文件不在暂存里，提交后
    /// 原件一删就没了。
    async fn verify_copies(
        &self,
        inspection: &Inspection,
        journal: &MoveJournal,
        staged: Staged,
        events: Option<&EventSink>,
        env: &MoveEnv,
    ) -> Result<()> {
        let staging = staging_dir(journal);
        let instance_dir = inspection.instance_dir.clone();
        let backups_dir = inspection.backups_dir.clone();
        let cancel = self.cancel_token().cloned();
        let sink = events.cloned();
        let env = env.clone();
        blocking(move || {
            let scans =
                std::iter::once(&staged.instance).chain(staged.backups.iter().map(|b| &b.0));
            let (total, total_bytes) = scans.fold((0, 0), |(files, bytes), scan| {
                (files + scan.files.len() as u64, bytes + scan.total_bytes)
            });
            let progress = StepProgress::start(sink.as_ref(), total, total_bytes);
            let report = |bytes, files| progress.advance(bytes, files);
            let control = env.control(cancel.as_ref(), &report);
            verify_tree(
                &staging.join(STAGED_INSTANCE),
                &staged.instance,
                &staged.instance_digests,
                &control,
            )?;
            if let Some((scan, digests)) = &staged.backups {
                verify_tree(&staging.join(STAGED_BACKUPS), scan, digests, &control)?;
            }
            ensure_unchanged(&instance_dir, Some(&staged.instance))?;
            ensure_unchanged(&backups_dir, staged.backups.as_ref().map(|b| &b.0))?;
            progress.finish();
            Ok(())
        })
        .await
    }

    /// 提交：同卷一次改名到目标；跨卷先把原件改名到旧目录，再把暂存改名到目标，第二步失败时把原件改回原位。
    /// 原件在原位的失败删掉暂存与日志再报错；原件改不回去时日志留给启动收尾，报错里带上两边的路径。
    async fn commit(&self, inspection: &Inspection, journal: &MoveJournal) -> Result<()> {
        let original = inspection.instance_dir.clone();
        let dest = journal.target_game_dir.join(VERSIONS_DIR).join(&journal.id);
        let outcome = match (journal.staging_dir.clone(), journal.old_dir.clone()) {
            (Some(staging), Some(old)) => {
                let staged = staging.join(STAGED_INSTANCE);
                tokio::task::spawn_blocking(move || commit_cross(&original, &old, &staged, &dest))
                    .await?
            }
            _ => tokio::task::spawn_blocking(move || rename_dir(&original, &dest))
                .await?
                .map_err(CommitError::Restored),
        };
        match outcome {
            Ok(()) => Ok(()),
            Err(CommitError::Restored(err)) => Err(self.abandon(journal, err).await),
            Err(CommitError::Stranded(err)) => {
                let error = error_with_causes(&err);
                tracing::error!(id = %journal.id, %error, "提交失败且原件没能改回原位，日志留给启动收尾");
                Err(err)
            }
        }
    }

    /// 提交前失败或取消：删暂存与日志，交回原来的错误。暂存删不掉时日志留着，启动收尾再删。
    async fn abandon(&self, journal: &MoveJournal, err: CoreError) -> CoreError {
        if let Err(cleanup) = self.discard(journal).await {
            let error = error_with_causes(&cleanup);
            tracing::warn!(id = %journal.id, %error, "移动没成，暂存没删掉，日志留着下次启动再删");
        }
        err
    }

    /// 删暂存，删成了再删日志（日志删不掉只记日志：再来一遍也是删同一个暂存）。
    async fn discard(&self, journal: &MoveJournal) -> Result<()> {
        if let Some(staging) = journal.staging_dir.clone() {
            blocking(move || remove_tree(&staging)).await?;
        }
        self.drop_journal(journal).await;
        Ok(())
    }

    async fn drop_journal(&self, journal: &MoveJournal) {
        if let Err(err) = move_journal::remove(self.data_dir(), &journal.token).await {
            let error = error_with_causes(&err);
            tracing::warn!(id = %journal.id, token = %journal.token, %error, "移动日志删不掉");
        }
    }

    /// 提交之后的收尾：备份、游玩记录、删旧目录与暂存、删日志。执行成功后与启动收尾都走这里，可以重入：记录迁移
    /// 在已经迁过的盘面上什么都不做，迁完记下 [`MoveStage::Settled`]，之后再来只做清理。失败只记跟进项：实例已经
    /// 在目标里，不能再报移动失败。清理没做完时日志留着，下次启动再清。
    async fn settle(&self, mut journal: MoveJournal) -> MoveOutcome {
        let mut follow_ups = Vec::new();
        let mut staging_safe = true;
        if journal.stage != MoveStage::Settled {
            carry_backups(&journal, &mut follow_ups).await;
            if let Err(err) = self
                .move_play_records(
                    &journal.id,
                    &journal.source_game_dir,
                    &journal.target_game_dir,
                )
                .await
            {
                let reason = error_with_causes(&err);
                tracing::warn!(id = %journal.id, %reason, "游玩记录没挪过去，已记下待补");
                follow_ups.push(MoveFollowUp::PlayRecords(reason));
            }
            journal.stage = MoveStage::Settled;
            if let Err(err) = move_journal::write(self.data_dir(), &journal).await {
                // 下次启动会把记录再迁一遍；那时并备份读的正是暂存里的备份副本，这次删到一半的话，原目录里没并过去
                // 的那些就会跟着被当成并完删掉。所以没记上之前不删暂存。
                let error = error_with_causes(&err);
                tracing::error!(id = %journal.id, %error, "移动日志没记上记录已迁完，暂存留到下次启动");
                staging_safe = false;
            }
        }
        let mut leftovers_remain = false;
        if let Some(old) = journal.old_dir.clone() {
            leftovers_remain |= !remove_leftover(&journal.id, old, &mut follow_ups).await;
        }
        if let Some(staging) = journal.staging_dir.clone() {
            if staging_safe {
                leftovers_remain |= !remove_leftover(&journal.id, staging, &mut follow_ups).await;
            } else {
                follow_ups.push(MoveFollowUp::Cleanup {
                    path: staging,
                    reason: "移动日志没写成，留到下次启动再删".to_owned(),
                });
                leftovers_remain = true;
            }
        }
        if !leftovers_remain {
            self.drop_journal(&journal).await;
        }
        tracing::info!(id = %journal.id, follow_ups = follow_ups.len(), "实例移动收尾完成");
        MoveOutcome {
            id: journal.id,
            source_game_dir: journal.source_game_dir,
            target_game_dir: journal.target_game_dir,
            follow_ups,
        }
    }
}

/// 备份跟过去。同卷直接把 `instances/<id>` 并过去。跨卷把暂存里的副本并进目标，并成了才删原游戏目录里的那份；
/// 并不成时原件留着，记跟进项。没复制过备份（当时没有）就什么都不碰：原目录里那时没有它的备份，现在有的也不是它的。
async fn carry_backups(journal: &MoveJournal, follow_ups: &mut Vec<MoveFollowUp>) {
    let (source, target, id) = (
        &journal.source_game_dir,
        &journal.target_game_dir,
        journal.id.as_str(),
    );
    if journal.same_volume {
        if let Err(err) = move_backups_between(source, target, id).await {
            let reason = error_with_causes(&err);
            tracing::warn!(id, %reason, "备份没挪过去，留在原游戏目录");
            follow_ups.push(MoveFollowUp::WorldBackups(reason));
        }
        return;
    }
    if !journal.backups_staged {
        return;
    }
    let staged = staging_dir(journal).join(STAGED_BACKUPS);
    if let Err(err) = merge_staged_backups(&staged, target, id).await {
        let reason = error_with_causes(&err);
        tracing::warn!(id, %reason, "暂存里的备份没并进目标，原游戏目录里的留着");
        follow_ups.push(MoveFollowUp::WorldBackups(reason));
        return;
    }
    if let Err(err) = remove_instance_backups_in(source, id).await {
        let reason = error_with_causes(&err);
        tracing::warn!(id, %reason, "备份已并进目标，原游戏目录里的那份没删掉");
        follow_ups.push(MoveFollowUp::Cleanup {
            path: instance_backups_dir_in(source, id),
            reason,
        });
    }
}

/// 删移动留下的一个中间目录；删不掉记跟进项。返回删干净了没有。
async fn remove_leftover(id: &str, dir: PathBuf, follow_ups: &mut Vec<MoveFollowUp>) -> bool {
    let target = dir.clone();
    match blocking(move || remove_tree(&target)).await {
        Ok(()) => true,
        Err(err) => {
            let reason = error_with_causes(&err);
            tracing::warn!(id, path = %dir.display(), %reason, "移动留下的目录没删干净，下次启动再删");
            follow_ups.push(MoveFollowUp::Cleanup { path: dir, reason });
            false
        }
    }
}

/// 跨卷日志的暂存目录。
fn staging_dir(journal: &MoveJournal) -> PathBuf {
    journal
        .staging_dir
        .clone()
        .expect("跨卷移动的日志由 MoveJournal::new 带上暂存目录")
}

/// 基底版本的复制顺序：由远及近，每个版本的 JSON 最后。中途断了时，目标里有 JSON 的基底版本一定齐全、它的父版本
/// 也已就位：下次预检把它算作可复用，不会再补。
fn base_copy_order(plan: &DependencyPlan) -> Vec<DependencyFile> {
    let mut files = Vec::new();
    for base in plan.bases.iter().rev() {
        let json = format!("{}.json", base.id);
        let (jsons, rest): (Vec<_>, Vec<_>) = base.files.iter().cloned().partition(|file| {
            file.dst
                .file_name()
                .is_some_and(|name| name == json.as_str())
        });
        files.extend(rest);
        files.extend(jsons);
    }
    files
}

/// 在阻塞线程上补依赖：共用文件几个线程一起复制，基底版本按 [`base_copy_order`] 逐个复制。
fn copy_dependencies_blocking(
    shared: &[DependencyFile],
    bases: &[DependencyFile],
    cancel: Option<&CancellationToken>,
    progress: &StepProgress,
    env: &MoveEnv,
) -> Result<()> {
    let report = |bytes, files| progress.advance(bytes, files);
    let next = AtomicUsize::new(0);
    let stop = AtomicBool::new(false);
    let failure: Mutex<Option<CoreError>> = Mutex::new(None);
    std::thread::scope(|scope| {
        for _ in 0..DEPENDENCY_WORKERS.min(shared.len()) {
            scope.spawn(|| {
                let control = env.control(cancel, &report);
                while !stop.load(Ordering::Relaxed) {
                    let Some(file) = shared.get(next.fetch_add(1, Ordering::Relaxed)) else {
                        break;
                    };
                    if let Err(err) = copy_dependency(file, cancel, &control, progress) {
                        stop.store(true, Ordering::Relaxed);
                        failure
                            .lock()
                            .unwrap_or_else(PoisonError::into_inner)
                            .get_or_insert(err);
                        break;
                    }
                }
            });
        }
    });
    if let Some(err) = failure.into_inner().unwrap_or_else(PoisonError::into_inner) {
        return Err(err);
    }
    let control = env.control(cancel, &report);
    for file in bases {
        copy_dependency(file, cancel, &control, progress)?;
    }
    Ok(())
}

/// 补一个文件：目标已有就跳过（算作完成）；复制途中别处抢先写成了也算跳过。
fn copy_dependency(
    file: &DependencyFile,
    cancel: Option<&CancellationToken>,
    control: &CopyControl,
    progress: &StepProgress,
) -> Result<()> {
    if cancel.is_some_and(CancellationToken::is_cancelled) {
        return Err(InstanceError::Cancelled.into());
    }
    if path_exists_blocking(&file.dst)? {
        progress.advance(file.size, 1);
        return Ok(());
    }
    match copy_file(&file.src, &file.dst, control) {
        Ok(()) => Ok(()),
        Err(CoreError::Base(petalfall_base::Error::Io { source, .. }))
            if source.kind() == std::io::ErrorKind::AlreadyExists =>
        {
            progress.advance(0, 1);
            Ok(())
        }
        Err(err) => Err(err),
    }
}

/// 根目录（可以不在）在复制之后有没有变：文件多了、少了、大小变了，冒出链接或目录。变了就不能提交。
fn ensure_unchanged(root: &Path, copied: Option<&TreeScan>) -> Result<()> {
    let now = scan_if_present(root)?;
    let changed = match (copied, &now) {
        (None, None) => None,
        (None, Some(_)) | (Some(_), None) => Some(PathBuf::new()),
        (Some(before), Some(after)) => first_difference(before, after),
    };
    match changed {
        None => Ok(()),
        Some(rel) if rel.as_os_str().is_empty() => Err(CoreError::InstanceMoveVerifyFailed {
            path: root.to_path_buf(),
        }),
        Some(rel) => Err(CoreError::InstanceMoveVerifyFailed {
            path: root.join(rel),
        }),
    }
}

fn first_difference(before: &TreeScan, after: &TreeScan) -> Option<PathBuf> {
    let files = |scan: &TreeScan| -> BTreeMap<PathBuf, u64> {
        scan.files
            .iter()
            .map(|file| (file.rel.clone(), file.size))
            .collect()
    };
    let (was, now) = (files(before), files(after));
    let file = was
        .iter()
        .find(|(rel, size)| now.get(*rel) != Some(size))
        .map(|(rel, _)| rel)
        .or_else(|| now.keys().find(|rel| !was.contains_key(*rel)));
    if let Some(rel) = file {
        return Some(rel.clone());
    }
    if let Some(link) = after.links.iter().find(|link| !before.links.contains(link)) {
        return Some(link.clone());
    }
    after
        .dirs
        .iter()
        .find(|dir| !before.dirs.contains(dir))
        .or_else(|| before.dirs.iter().find(|dir| !after.dirs.contains(dir)))
        .cloned()
}

/// 跨卷的两步改名。
fn commit_cross(
    original: &Path,
    old: &Path,
    staged: &Path,
    dest: &Path,
) -> std::result::Result<(), CommitError> {
    if let Some(parent) = old.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|source| CommitError::Restored(io_error(parent, source)))?;
    }
    rename_dir(original, old).map_err(CommitError::Restored)?;
    let Err(err) = rename_dir(staged, dest) else {
        return Ok(());
    };
    match rename_dir(old, original) {
        Ok(()) => Err(CommitError::Restored(err)),
        Err(back) => {
            let message = format!(
                "实例目录已改名到 {}，改回 {} 失败（{}），下次启动时再改回；提交失败的原因：{}",
                old.display(),
                original.display(),
                error_with_causes(&back),
                error_with_causes(&err),
            );
            Err(CommitError::Stranded(io_error(
                old,
                std::io::Error::other(message),
            )))
        }
    }
}

/// 目录改名，绝不覆盖：目标已经有东西（哪怕是空目录）就报 AlreadyExists。
fn rename_dir(from: &Path, to: &Path) -> Result<()> {
    if path_exists_blocking(to)? {
        return Err(io_error(
            to,
            std::io::Error::new(std::io::ErrorKind::AlreadyExists, "目标位置已经有东西"),
        ));
    }
    std::fs::rename(from, to).map_err(|source| io_error(from, source))
}

fn scan_if_present(dir: &Path) -> Result<Option<TreeScan>> {
    if path_exists_blocking(dir)? {
        Ok(Some(scan_tree(dir)?))
    } else {
        Ok(None)
    }
}

/// 路径上有没有东西（不跟随链接：悬空的链接也算有）。
fn path_exists_blocking(path: &Path) -> Result<bool> {
    match std::fs::symlink_metadata(path) {
        Ok(_) => Ok(true),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(source) => Err(io_error(path, source)),
    }
}

async fn path_exists(path: &Path) -> Result<bool> {
    match tokio::fs::symlink_metadata(path).await {
        Ok(_) => Ok(true),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(source) => Err(io_error(path, source)),
    }
}

fn io_error(path: &Path, source: std::io::Error) -> CoreError {
    petalfall_base::Error::Io {
        path: path.to_path_buf(),
        source,
    }
    .into()
}

async fn blocking<T: Send + 'static>(
    work: impl FnOnce() -> Result<T> + Send + 'static,
) -> Result<T> {
    tokio::task::spawn_blocking(work).await?
}

// ---- 步骤与进度 ----

/// 这次移动的步骤表，开工时排定、全程不变。
struct Steps<'a> {
    sink: Option<&'a EventSink>,
    plan: Vec<InstallPhase>,
}

impl<'a> Steps<'a> {
    fn new(sink: Option<&'a EventSink>, same_volume: bool) -> Self {
        let plan = if same_volume {
            vec![InstallPhase::MoveDependencies, InstallPhase::MoveCommit]
        } else {
            vec![
                InstallPhase::MoveDependencies,
                InstallPhase::MoveCopy,
                InstallPhase::MoveVerify,
                InstallPhase::MoveCommit,
            ]
        };
        Self { sink, plan }
    }

    fn enter(&self, phase: InstallPhase) {
        let index = self
            .plan
            .iter()
            .position(|planned| *planned == phase)
            .expect("只进入步骤表里排定的步骤");
        emit(
            self.sink,
            CoreEvent::Phase {
                plan: self.plan.clone(),
                index,
            },
        );
    }
}

/// 一步里的文件进度，节流成下载事件：开始时先发一条从零起的，之后两条之间至少隔 100 ms，最后一条必发；速度按
/// 从这一步开始算起的平均值。复制可能在几个线程上同时报进度，状态放在锁里。
struct StepProgress {
    sink: Option<EventSink>,
    total: u64,
    total_bytes: u64,
    started: Instant,
    state: Mutex<ProgressState>,
}

#[derive(Default)]
struct ProgressState {
    finished: u64,
    bytes: u64,
    last_sent: Option<Instant>,
    unsent: bool,
}

impl StepProgress {
    fn start(sink: Option<&EventSink>, total: u64, total_bytes: u64) -> Arc<Self> {
        let progress = Arc::new(Self {
            sink: sink.cloned(),
            total,
            total_bytes,
            started: Instant::now(),
            state: Mutex::default(),
        });
        progress.send(&mut progress.lock(), Instant::now());
        progress
    }

    fn advance(&self, bytes: u64, files: u64) {
        let mut state = self.lock();
        state.bytes += bytes;
        state.finished += files;
        state.unsent = true;
        let now = Instant::now();
        if state
            .last_sent
            .is_none_or(|sent| now.duration_since(sent) >= PROGRESS_INTERVAL)
        {
            self.send(&mut state, now);
        }
    }

    fn finish(&self) {
        let mut state = self.lock();
        if state.unsent {
            self.send(&mut state, Instant::now());
        }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, ProgressState> {
        // 锁里只有计数，持锁时 panic 也不会留下改了一半的状态。
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }

    fn send(&self, state: &mut ProgressState, now: Instant) {
        state.last_sent = Some(now);
        state.unsent = false;
        let elapsed_ms = now.duration_since(self.started).as_millis() as u64;
        let speed = match elapsed_ms {
            0 => 0,
            ms => state.bytes.saturating_mul(1000) / ms,
        };
        emit(
            self.sink.as_ref(),
            CoreEvent::Download(DownloadProgress {
                total: self.total,
                finished: state.finished,
                bytes: state.bytes,
                total_bytes: Some(self.total_bytes),
                transferred: 0,
                speed,
            }),
        );
    }
}

// ---- 启动收尾 ----

/// 一份日志涉及的四处位置此刻在不在。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Disk {
    /// 原位置 `<源>/versions/<id>`。
    source: bool,
    /// 目标位置 `<目标>/versions/<id>`。
    target: bool,
    /// 跨卷时原件提交中改名到的旧目录。
    old: bool,
    /// 跨卷时暂存里的实例副本。
    staged: bool,
}

/// 按日志与盘面得出的收尾办法。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Verdict {
    /// 已经提交：补做记录迁移与清理。
    Finish,
    /// 提交到一半、原件已不在，只剩校验过的暂存副本：改名到目标，再补做记录迁移与清理。
    RollForward,
    /// 原件停在旧目录：改回原位，再删暂存。
    RenameBack,
    /// 原件在原位（或没有我们的东西可保）：删暂存。
    Discard,
    /// 盘面与日志对不上，动哪边都可能删掉唯一的一份：不动，留给玩家。
    Stuck(&'static str),
}

/// 收尾办法。原则：原件或它唯一的副本绝不删；能确认提交过才补完，否则回滚。
fn judge(stage: MoveStage, same_volume: bool, disk: Disk) -> Verdict {
    use MoveStage::{Committed, Committing, Copying, Settled};
    if same_volume {
        // 同卷的提交是一次改名，要么在原位要么在目标。
        return match stage {
            Committed | Settled => Verdict::Finish,
            Committing if disk.target && !disk.source => Verdict::Finish,
            Copying | Committing => Verdict::Discard,
        };
    }
    match stage {
        Committed | Settled if !disk.target && disk.old => {
            Verdict::Stuck("日志说已提交，可目标里没有这个实例，原件的旧目录还在")
        }
        Committed | Settled => Verdict::Finish,
        Committing if disk.target && !disk.staged && !disk.source => Verdict::Finish,
        // 「提交中」写在校验通过之后，暂存副本是校验过的。
        Committing if !disk.target && disk.staged && !disk.source && !disk.old => {
            Verdict::RollForward
        }
        Copying | Committing if disk.old && !disk.source => Verdict::RenameBack,
        Copying | Committing if disk.old => Verdict::Stuck("原位置和旧目录里都有这个实例"),
        Copying | Committing if !disk.source && disk.staged => {
            Verdict::Stuck("原位置和旧目录里都没有这个实例，只剩暂存里的副本")
        }
        Copying | Committing => Verdict::Discard,
    }
}

impl Petalfall {
    async fn recover_move(&self, journal: MoveJournal) -> MoveRecovery {
        let id = journal.id.clone();
        for dir in [&journal.source_game_dir, &journal.target_game_dir] {
            if !probe_dir(dir).await {
                tracing::info!(id, path = %dir.display(), "中断的移动涉及的目录访问不到，下次启动再收尾");
                return MoveRecovery::Deferred {
                    id,
                    reason: format!("{} 现在访问不到", dir.display()),
                };
            }
        }
        match self.resume_move(journal).await {
            Ok(recovery) => recovery,
            Err(err) => {
                let reason = error_with_causes(&err);
                tracing::error!(id, %reason, "中断的移动没能收尾，日志留着下次启动再试");
                MoveRecovery::Deferred { id, reason }
            }
        }
    }

    async fn resume_move(&self, journal: MoveJournal) -> Result<MoveRecovery> {
        let original = journal.source_game_dir.join(VERSIONS_DIR).join(&journal.id);
        let dest = journal.target_game_dir.join(VERSIONS_DIR).join(&journal.id);
        let staged = journal
            .staging_dir
            .as_ref()
            .map(|staging| staging.join(STAGED_INSTANCE));
        let disk = Disk {
            source: path_exists(&original).await?,
            target: path_exists(&dest).await?,
            old: match &journal.old_dir {
                Some(old) => path_exists(old).await?,
                None => false,
            },
            staged: match &staged {
                Some(staged) => path_exists(staged).await?,
                None => false,
            },
        };
        let verdict = judge(journal.stage, journal.same_volume, disk);
        tracing::info!(id = %journal.id, stage = ?journal.stage, ?disk, ?verdict, "收尾中断的移动");
        let rolled_back = |journal: &MoveJournal| MoveRecovery::RolledBack {
            id: journal.id.clone(),
            source_game_dir: journal.source_game_dir.clone(),
            target_game_dir: journal.target_game_dir.clone(),
        };
        match verdict {
            Verdict::Finish => Ok(MoveRecovery::Completed(self.settle(journal).await)),
            Verdict::RollForward => {
                let staged = staged.expect("跨卷日志带暂存目录");
                blocking(move || rename_dir(&staged, &dest)).await?;
                Ok(MoveRecovery::Completed(self.settle(journal).await))
            }
            Verdict::RenameBack => {
                let old = journal.old_dir.clone().expect("跨卷日志带旧目录");
                blocking(move || rename_dir(&old, &original)).await?;
                self.discard(&journal).await?;
                Ok(rolled_back(&journal))
            }
            Verdict::Discard => {
                self.discard(&journal).await?;
                Ok(rolled_back(&journal))
            }
            Verdict::Stuck(why) => {
                let shown = |path: Option<&PathBuf>| {
                    path.map_or_else(|| "无".to_owned(), |path| path.display().to_string())
                };
                Ok(MoveRecovery::Deferred {
                    id: journal.id.clone(),
                    reason: format!(
                        "{why}，没有动它：原位置 {}，目标 {}，旧目录 {}，暂存 {}",
                        original.display(),
                        dest.display(),
                        shown(journal.old_dir.as_ref()),
                        shown(staged.as_ref()),
                    ),
                })
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::PetalfallConfig;
    use crate::instances::tests::{vanilla_json, write_version};
    use petalfall_instance::BackupKind;
    use serde_json::json;
    use std::time::SystemTime;
    use tokio::sync::mpsc::{UnboundedReceiver, unbounded_channel};

    const ID: &str = "Pack";
    const BASE: &str = "1.21.1";
    const HOUR: u64 = 3_600_000;

    /// 数据目录与两个游戏目录，都在一个临时目录里。
    struct Dirs {
        tmp: tempfile::TempDir,
        data: PathBuf,
        source: PathBuf,
        target: PathBuf,
    }

    impl Dirs {
        fn new() -> Self {
            let tmp = tempfile::tempdir().unwrap();
            let data = tmp.path().join("data");
            let source = tmp.path().join("源").join(".minecraft");
            let target = tmp.path().join("目标").join(".minecraft");
            std::fs::create_dir_all(&source).unwrap();
            Self {
                tmp,
                data,
                source,
                target,
            }
        }

        fn facade(&self, game_dir: &Path) -> Petalfall {
            Petalfall::for_test(
                PetalfallConfig::default(),
                self.data.clone(),
                game_dir.to_path_buf(),
            )
        }

        fn petalfall(&self) -> Petalfall {
            self.facade(&self.source)
        }

        fn request(&self) -> MoveRequest {
            MoveRequest {
                id: ID.to_owned(),
                target_game_dir: self.target.clone(),
            }
        }

        fn instance_in(&self, game_dir: &Path) -> PathBuf {
            game_dir.join("versions").join(ID)
        }

        fn backups_in(&self, game_dir: &Path) -> PathBuf {
            instance_backups_dir_in(game_dir, ID)
        }

        fn journal(&self, same_volume: bool) -> MoveJournal {
            MoveJournal::new(
                move_journal::new_token().unwrap(),
                ID,
                &self.source,
                &self.target,
                same_volume,
                move_journal::now_millis().unwrap(),
            )
        }
    }

    fn put(path: &Path, bytes: &[u8]) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, bytes).unwrap();
    }

    /// 游戏目录下以 `/` 分隔的相对路径。
    fn at(game_dir: &Path, rel: &str) -> PathBuf {
        rel.split('/')
            .fold(game_dir.to_path_buf(), |path, part| path.join(part))
    }

    fn object_hash() -> String {
        "a".repeat(40)
    }

    /// 基底版本声明、源里备着的共用文件（相对游戏目录）与内容。
    fn dependency_files() -> Vec<(String, Vec<u8>)> {
        let index = json!({"objects": {
            "minecraft/lang/zh_cn.json": {"hash": object_hash(), "size": 3}
        }})
        .to_string();
        vec![
            (
                "libraries/com/google/code/gson/gson/2.11.0/gson-2.11.0.jar".to_owned(),
                b"gson-bytes".to_vec(),
            ),
            (
                "libraries/net/fabricmc/fabric-loader/0.16.10/fabric-loader-0.16.10.jar".to_owned(),
                b"loader-bytes".to_vec(),
            ),
            ("assets/indexes/17.json".to_owned(), index.into_bytes()),
            (
                format!("assets/objects/aa/{}", object_hash()),
                b"aaa".to_vec(),
            ),
            (
                "assets/log_configs/client-1.12.xml".to_owned(),
                b"<xml/>".to_vec(),
            ),
        ]
    }

    fn base_json() -> String {
        json!({
            "id": BASE, "type": "release", "mainClass": "net.minecraft.client.main.Main",
            "javaVersion": {"component": "java-runtime-delta", "majorVersion": 21},
            "assetIndex": {"id": "17", "sha1": "0", "size": 1, "url": "https://example.invalid/17.json"},
            "logging": {"client": {
                "argument": "-Dlog4j.configurationFile=${path}", "type": "log4j2-xml",
                "file": {"id": "client-1.12.xml", "sha1": "0", "size": 1, "url": "https://example.invalid/l.xml"}
            }},
            "libraries": [{
                "name": "com.google.code.gson:gson:2.11.0",
                "downloads": {"artifact": {
                    "path": "com/google/code/gson/gson/2.11.0/gson-2.11.0.jar",
                    "sha1": "0", "size": 1, "url": "https://example.invalid/g.jar"
                }}
            }]
        })
        .to_string()
    }

    fn instance_json() -> String {
        json!({
            "id": ID, "inheritsFrom": BASE, "type": "release",
            "mainClass": "net.fabricmc.loader.impl.launch.knot.KnotClient",
            "libraries": [{"name": "net.fabricmc:fabric-loader:0.16.10", "url": "https://maven.fabricmc.net/"}]
        })
        .to_string()
    }

    /// 源里造一个 Fabric 实例（隔离）：继承原版基底，带 Mod、存档、设置、一个跨好几块的大文件与一个空目录；
    /// 源里备着它要的库、资源与日志配置；给它的存档打一份备份，记一小时游玩。
    async fn build_instance(dirs: &Dirs) {
        write_version(&dirs.source, BASE, &base_json());
        put(
            &at(&dirs.source, &format!("versions/{BASE}/{BASE}.jar")),
            b"client-jar",
        );
        let dir = write_version(&dirs.source, ID, &instance_json());
        put(&dir.join("mods").join("sodium.jar"), b"mod-bytes");
        put(&dir.join("options.txt"), b"lang:zh_cn\n");
        put(&dir.join("saves").join("w").join("level.dat"), b"level");
        put(
            &dir.join("saves").join("w").join("region").join("r.0.0.mca"),
            b"region-bytes",
        );
        put(&dir.join(".petalfall").join("notes.txt"), "卷宗".as_bytes());
        let big: Vec<u8> = (0..3 * 1024 * 1024 + 17u32)
            .map(|i| (i % 251) as u8)
            .collect();
        put(&dir.join("big.bin"), &big);
        std::fs::create_dir_all(dir.join("screenshots")).unwrap();
        for (rel, bytes) in dependency_files() {
            put(&at(&dirs.source, &rel), &bytes);
        }
        dirs.petalfall()
            .backup_world(ID, "w", BackupKind::Manual, None)
            .await
            .unwrap();
        let now = move_journal::now_millis().unwrap();
        crate::playtime::record_play(&dirs.data, &dirs.source, ID, now - 2 * HOUR, now - HOUR)
            .await
            .unwrap();
    }

    /// 目录树的内容：目录记成 `x/`，文件记成字节。
    fn snapshot(dir: &Path) -> BTreeMap<String, Vec<u8>> {
        fn visit(root: &Path, dir: &Path, out: &mut BTreeMap<String, Vec<u8>>) {
            for entry in std::fs::read_dir(dir).unwrap() {
                let path = entry.unwrap().path();
                let key = path
                    .strip_prefix(root)
                    .unwrap()
                    .to_string_lossy()
                    .replace('\\', "/");
                if path.is_dir() {
                    out.insert(format!("{key}/"), Vec::new());
                    visit(root, &path, out);
                } else {
                    out.insert(key, std::fs::read(&path).unwrap());
                }
            }
        }
        let mut out = BTreeMap::new();
        visit(dir, dir, &mut out);
        out
    }

    fn entries(dir: &Path) -> Vec<String> {
        match std::fs::read_dir(dir) {
            Ok(read) => read
                .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
                .collect(),
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => Vec::new(),
            Err(err) => panic!("{err}"),
        }
    }

    fn journals(dirs: &Dirs) -> Vec<String> {
        entries(&dirs.data.join("moves"))
    }

    fn moving(game_dir: &Path) -> Vec<String> {
        entries(&game_dir.join(".petalfall").join("moving"))
    }

    async fn minutes(dirs: &Dirs, game_dir: &Path) -> Option<u64> {
        dirs.facade(game_dir)
            .play_summaries()
            .await
            .unwrap()
            .get(ID)
            .map(|summary| summary.playtime_min)
    }

    fn drain(rx: &mut UnboundedReceiver<CoreEvent>) -> Vec<CoreEvent> {
        let mut events = Vec::new();
        while let Ok(event) = rx.try_recv() {
            events.push(event);
        }
        events
    }

    /// 按步骤分好的下载进度：`(步骤, 这一步的全部进度快照)`。
    fn steps_of(events: &[CoreEvent]) -> Vec<(InstallPhase, Vec<DownloadProgress>)> {
        let mut steps: Vec<(InstallPhase, Vec<DownloadProgress>)> = Vec::new();
        for event in events {
            match event {
                CoreEvent::Phase { plan, index } => steps.push((plan[*index], Vec::new())),
                CoreEvent::Download(progress) => steps.last_mut().unwrap().1.push(*progress),
                _ => {}
            }
        }
        steps
    }

    fn cross_volume() -> MoveEnv {
        MoveEnv {
            volume: VolumeMode::CrossVolume,
            ..MoveEnv::default()
        }
    }

    /// 故障只打在暂存里的文件上（补依赖时 copy_file 的临时文件不在 moving 下）。
    fn in_staging(path: &Path) -> bool {
        path.components().any(|part| part.as_os_str() == "moving")
    }

    fn with_fault(
        env: MoveEnv,
        fault: impl Fn(&Path) -> std::io::Result<()> + Send + Sync + 'static,
    ) -> MoveEnv {
        MoveEnv {
            fault: Some(Arc::new(fault)),
            ..env
        }
    }

    /// 移动没成之后：原件逐字节不变，目标里没有它，暂存与日志都删了，游玩记录与备份没动。
    async fn assert_untouched(
        dirs: &Dirs,
        instance: &BTreeMap<String, Vec<u8>>,
        backups: &BTreeMap<String, Vec<u8>>,
    ) {
        assert_eq!(&snapshot(&dirs.instance_in(&dirs.source)), instance);
        assert!(!dirs.instance_in(&dirs.target).exists());
        assert!(
            moving(&dirs.target).is_empty(),
            "{:?}",
            moving(&dirs.target)
        );
        assert!(
            moving(&dirs.source).is_empty(),
            "{:?}",
            moving(&dirs.source)
        );
        assert!(journals(dirs).is_empty(), "{:?}", journals(dirs));
        assert_eq!(&snapshot(&dirs.backups_in(&dirs.source)), backups);
        assert!(!dirs.backups_in(&dirs.target).exists());
        assert_eq!(minutes(dirs, &dirs.source).await, Some(60));
        assert_eq!(minutes(dirs, &dirs.target).await, None);
    }

    /// 实例、依赖、备份与记录都到了目标，原处与中间目录都清干净了。
    async fn assert_moved(
        dirs: &Dirs,
        instance: &BTreeMap<String, Vec<u8>>,
        backups: &BTreeMap<String, Vec<u8>>,
    ) {
        assert!(!dirs.instance_in(&dirs.source).exists());
        assert_eq!(&snapshot(&dirs.instance_in(&dirs.target)), instance);
        for (rel, bytes) in dependency_files() {
            assert_eq!(
                std::fs::read(at(&dirs.target, &rel)).unwrap(),
                bytes,
                "{rel}"
            );
            assert!(
                at(&dirs.source, &rel).exists(),
                "共用文件是复制过去的：{rel}"
            );
        }
        for file in [format!("{BASE}.json"), format!("{BASE}.jar")] {
            let rel = format!("versions/{BASE}/{file}");
            assert_eq!(
                std::fs::read(at(&dirs.target, &rel)).unwrap(),
                std::fs::read(at(&dirs.source, &rel)).unwrap()
            );
        }
        let record: serde_json::Value = serde_json::from_slice(
            &std::fs::read(at(&dirs.target, ".petalfall/base-versions.json")).unwrap(),
        )
        .unwrap();
        assert_eq!(record, json!({"versions": [BASE]}));
        assert_eq!(&snapshot(&dirs.backups_in(&dirs.target)), backups);
        assert!(!dirs.backups_in(&dirs.source).exists());
        assert_eq!(minutes(dirs, &dirs.target).await, Some(60));
        assert_eq!(minutes(dirs, &dirs.source).await, None);
        assert!(journals(dirs).is_empty(), "{:?}", journals(dirs));
        assert!(
            moving(&dirs.target).is_empty(),
            "{:?}",
            moving(&dirs.target)
        );
        assert!(
            moving(&dirs.source).is_empty(),
            "{:?}",
            moving(&dirs.source)
        );
    }

    fn outcome(dirs: &Dirs) -> MoveOutcome {
        MoveOutcome {
            id: ID.to_owned(),
            source_game_dir: dirs.source.clone(),
            target_game_dir: dirs.target.clone(),
            follow_ups: Vec::new(),
        }
    }

    #[tokio::test]
    async fn preview_counts_what_moves_and_what_the_target_lacks() {
        let dirs = Dirs::new();
        build_instance(&dirs).await;
        let preview = dirs
            .petalfall()
            .preview_instance_move(ID, &dirs.target)
            .await
            .unwrap();
        let instance = snapshot(&dirs.instance_in(&dirs.source));
        let instance_files: Vec<&Vec<u8>> = instance
            .iter()
            .filter(|(key, _)| !key.ends_with('/'))
            .map(|(_, bytes)| bytes)
            .collect();
        let backups = snapshot(&dirs.backups_in(&dirs.source));
        let backup_bytes: u64 = backups.values().map(|bytes| bytes.len() as u64).sum();
        let shared_bytes: u64 = dependency_files()
            .iter()
            .map(|(_, bytes)| bytes.len() as u64)
            .sum();
        let base_bytes = (base_json().len() + b"client-jar".len()) as u64;
        assert_eq!(preview.id, ID);
        assert_eq!(preview.source_game_dir, dirs.source);
        assert_eq!(preview.target_game_dir, dirs.target);
        assert!(preview.same_volume);
        assert_eq!(preview.instance_files, instance_files.len() as u64);
        assert_eq!(
            preview.instance_bytes,
            instance_files
                .iter()
                .map(|bytes| bytes.len() as u64)
                .sum::<u64>()
        );
        assert_eq!(preview.backup_bytes, backup_bytes);
        assert_eq!(preview.backup_count, 1);
        assert_eq!(preview.dependency_files, 5);
        assert_eq!(preview.dependency_bytes, shared_bytes);
        assert_eq!(preview.bases_to_copy, vec![BASE.to_owned()]);
        assert!(preview.reused_bases.is_empty());
        assert_eq!(preview.missing_in_source, 0);
        // 同卷只算要补的依赖（含基底版本）。
        assert_eq!(preview.required_bytes, shared_bytes + base_bytes);
        assert!(preview.available_bytes > 0);
        assert!(preview.isolated);
        assert!(preview.blockers.is_empty(), "{:?}", preview.blockers);

        // 跨卷还要把实例与备份复制过去。
        let cross = dirs
            .petalfall()
            .inspect_move(ID, &dirs.target, &cross_volume())
            .await
            .unwrap()
            .preview;
        assert!(!cross.same_volume);
        assert_eq!(
            cross.required_bytes,
            shared_bytes + base_bytes + preview.instance_bytes + backup_bytes
        );
        assert!(!dirs.target.exists(), "预检不写盘");
    }

    #[tokio::test]
    async fn same_volume_move_renames_the_instance_and_carries_dependencies_backups_and_records() {
        let dirs = Dirs::new();
        build_instance(&dirs).await;
        let instance = snapshot(&dirs.instance_in(&dirs.source));
        let backups = snapshot(&dirs.backups_in(&dirs.source));
        let (tx, mut rx) = unbounded_channel();

        let moved = dirs
            .petalfall()
            .move_instance_files(&dirs.request(), Some(tx))
            .await
            .unwrap();

        assert_eq!(moved, outcome(&dirs));
        assert_moved(&dirs, &instance, &backups).await;
        let steps = steps_of(&drain(&mut rx));
        let phases: Vec<InstallPhase> = steps.iter().map(|(phase, _)| *phase).collect();
        assert_eq!(
            phases,
            [InstallPhase::MoveDependencies, InstallPhase::MoveCommit]
        );
        let deps = &steps[0].1;
        let (first, last) = (deps.first().unwrap(), deps.last().unwrap());
        assert_eq!((first.finished, first.bytes), (0, 0));
        assert_eq!(
            (last.total, last.finished),
            (7, 7),
            "5 个共用文件加基底的 JSON 与 jar"
        );
        assert_eq!(Some(last.bytes), last.total_bytes);
    }

    #[tokio::test]
    async fn cross_volume_move_copies_verifies_and_removes_the_original() {
        let dirs = Dirs::new();
        build_instance(&dirs).await;
        let old_time = SystemTime::UNIX_EPOCH + Duration::from_secs(1_600_000_000);
        let options = dirs.instance_in(&dirs.source).join("options.txt");
        std::fs::File::options()
            .write(true)
            .open(&options)
            .unwrap()
            .set_modified(old_time)
            .unwrap();
        let instance = snapshot(&dirs.instance_in(&dirs.source));
        let backups = snapshot(&dirs.backups_in(&dirs.source));
        let (tx, mut rx) = unbounded_channel();

        let moved = dirs
            .petalfall()
            .move_instance_files_with(&dirs.request(), Some(tx), &cross_volume())
            .await
            .unwrap();

        assert_eq!(moved, outcome(&dirs));
        assert_moved(&dirs, &instance, &backups).await;
        let moved_options = dirs.instance_in(&dirs.target).join("options.txt");
        assert_eq!(
            std::fs::metadata(moved_options)
                .unwrap()
                .modified()
                .unwrap(),
            old_time
        );
        let steps = steps_of(&drain(&mut rx));
        let phases: Vec<InstallPhase> = steps.iter().map(|(phase, _)| *phase).collect();
        assert_eq!(
            phases,
            [
                InstallPhase::MoveDependencies,
                InstallPhase::MoveCopy,
                InstallPhase::MoveVerify,
                InstallPhase::MoveCommit
            ]
        );
        let instance_files = instance.keys().filter(|key| !key.ends_with('/')).count();
        let backup_files = backups.keys().filter(|key| !key.ends_with('/')).count();
        for (phase, progress) in &steps[1..3] {
            let (first, last) = (progress.first().unwrap(), progress.last().unwrap());
            assert_eq!((first.finished, first.bytes), (0, 0), "{phase:?} 从零计数");
            assert_eq!(
                last.total,
                (instance_files + backup_files) as u64,
                "{phase:?}"
            );
            assert_eq!(last.finished, last.total, "{phase:?}");
            assert_eq!(Some(last.bytes), last.total_bytes, "{phase:?}");
        }
    }

    #[tokio::test]
    async fn a_failed_write_while_staging_leaves_everything_as_it_was() {
        let dirs = Dirs::new();
        build_instance(&dirs).await;
        let instance = snapshot(&dirs.instance_in(&dirs.source));
        let backups = snapshot(&dirs.backups_in(&dirs.source));
        let env = with_fault(cross_volume(), |path| {
            if in_staging(path) && path.ends_with("options.txt") {
                return Err(std::io::Error::other("注入的写失败"));
            }
            Ok(())
        });

        let err = dirs
            .petalfall()
            .move_instance_files_with(&dirs.request(), None, &env)
            .await
            .unwrap_err();

        assert!(
            matches!(&err, CoreError::Base(petalfall_base::Error::Io { path, .. }) if path.ends_with("options.txt")),
            "{err:?}"
        );
        assert_untouched(&dirs, &instance, &backups).await;
    }

    #[tokio::test]
    async fn a_corrupted_staged_copy_fails_verification_and_is_discarded() {
        let dirs = Dirs::new();
        build_instance(&dirs).await;
        let instance = snapshot(&dirs.instance_in(&dirs.source));
        let backups = snapshot(&dirs.backups_in(&dirs.source));
        let env = with_fault(cross_volume(), |path| {
            if in_staging(path) && path.ends_with("big.bin") {
                let mut bytes = std::fs::read(path)?;
                bytes[2 * 1024 * 1024] ^= 0xff;
                std::fs::write(path, bytes)?;
            }
            Ok(())
        });

        let err = dirs
            .petalfall()
            .move_instance_files_with(&dirs.request(), None, &env)
            .await
            .unwrap_err();

        assert!(
            matches!(&err, CoreError::InstanceMoveVerifyFailed { path }
                if path.ends_with("big.bin") && path.starts_with(dirs.target.join(".petalfall"))),
            "{err:?}"
        );
        assert_untouched(&dirs, &instance, &backups).await;
    }

    /// 复制途中原件里多了一个文件：暂存里没有它，提交后原件一删它就没了，所以校验这一步拦下。
    #[tokio::test]
    async fn a_file_appearing_in_the_original_during_the_copy_stops_the_commit() {
        let dirs = Dirs::new();
        build_instance(&dirs).await;
        let backups = snapshot(&dirs.backups_in(&dirs.source));
        let late = dirs.instance_in(&dirs.source).join("mods").join("late.jar");
        let writer = late.clone();
        let env = with_fault(cross_volume(), move |path| {
            if in_staging(path) && path.ends_with("options.txt") {
                std::fs::write(&writer, b"late")?;
            }
            Ok(())
        });

        let err = dirs
            .petalfall()
            .move_instance_files_with(&dirs.request(), None, &env)
            .await
            .unwrap_err();

        assert!(
            matches!(&err, CoreError::InstanceMoveVerifyFailed { path } if *path == late),
            "{err:?}"
        );
        let instance = snapshot(&dirs.instance_in(&dirs.source));
        assert_eq!(instance["mods/late.jar"], b"late");
        assert_untouched(&dirs, &instance, &backups).await;
    }

    #[tokio::test]
    async fn cancelling_while_staging_leaves_everything_as_it_was() {
        let dirs = Dirs::new();
        build_instance(&dirs).await;
        let instance = snapshot(&dirs.instance_in(&dirs.source));
        let backups = snapshot(&dirs.backups_in(&dirs.source));
        let token = CancellationToken::new();
        let trigger = token.clone();
        let env = with_fault(cross_volume(), move |path| {
            if in_staging(path) {
                trigger.cancel();
            }
            Ok(())
        });

        let err = dirs
            .petalfall()
            .with_cancel(token)
            .move_instance_files_with(&dirs.request(), None, &env)
            .await
            .unwrap_err();

        assert!(err.is_cancelled(), "{err:?}");
        assert_untouched(&dirs, &instance, &backups).await;
    }

    /// 独占打开实例目录里的一个文件，目录就改不了名。
    #[cfg(windows)]
    fn hold_exclusively(path: &Path) -> std::fs::File {
        use std::os::windows::fs::OpenOptionsExt;
        std::fs::File::options()
            .read(true)
            .share_mode(0)
            .open(path)
            .unwrap()
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn same_volume_rename_failure_leaves_the_original_in_place() {
        let dirs = Dirs::new();
        build_instance(&dirs).await;
        let instance = snapshot(&dirs.instance_in(&dirs.source));
        let backups = snapshot(&dirs.backups_in(&dirs.source));
        let held = hold_exclusively(&dirs.instance_in(&dirs.source).join("options.txt"));

        let err = dirs
            .petalfall()
            .move_instance_files(&dirs.request(), None)
            .await
            .unwrap_err();

        drop(held);
        assert!(
            matches!(&err, CoreError::Base(petalfall_base::Error::Io { path, .. })
                if *path == dirs.instance_in(&dirs.source)),
            "{err:?}"
        );
        assert_untouched(&dirs, &instance, &backups).await;
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn cross_volume_commit_failure_leaves_the_original_in_place_and_drops_the_staging() {
        let dirs = Dirs::new();
        build_instance(&dirs).await;
        let instance = snapshot(&dirs.instance_in(&dirs.source));
        let backups = snapshot(&dirs.backups_in(&dirs.source));
        // 暂存里的 options.txt 写完之后才独占原件里的它：复制与校验照常，提交时原件改不了名。
        let original = dirs.instance_in(&dirs.source).join("options.txt");
        let held: Arc<Mutex<Option<std::fs::File>>> = Arc::default();
        let holder = held.clone();
        let env = with_fault(cross_volume(), move |path| {
            if in_staging(path) && path.ends_with("options.txt") {
                *holder.lock().unwrap() = Some(hold_exclusively(&original));
            }
            Ok(())
        });

        let err = dirs
            .petalfall()
            .move_instance_files_with(&dirs.request(), None, &env)
            .await
            .unwrap_err();

        assert!(held.lock().unwrap().take().is_some());
        assert!(
            matches!(&err, CoreError::Base(petalfall_base::Error::Io { path, .. })
                if *path == dirs.instance_in(&dirs.source)),
            "{err:?}"
        );
        assert_untouched(&dirs, &instance, &backups).await;
    }

    /// 预检列出全部拦截项，执行报第一个，什么都不写。
    async fn assert_blocked(dirs: &Dirs, env: &MoveEnv, target: &Path, expected: &[MoveBlocker]) {
        let petalfall = dirs.petalfall();
        let preview = petalfall
            .inspect_move(ID, target, env)
            .await
            .unwrap()
            .preview;
        assert_eq!(preview.blockers, expected);
        let request = MoveRequest {
            id: ID.to_owned(),
            target_game_dir: target.to_path_buf(),
        };
        let err = petalfall
            .move_instance_files_with(&request, None, env)
            .await
            .unwrap_err();
        assert!(
            matches!(&err, CoreError::InstanceMoveBlocked { id, blocker } if id == ID && *blocker == expected[0]),
            "{err:?}"
        );
        assert!(dirs.instance_in(&dirs.source).is_dir());
        assert!(journals(dirs).is_empty());
    }

    #[tokio::test]
    async fn a_same_named_version_in_the_target_blocks_regardless_of_case() {
        let dirs = Dirs::new();
        build_instance(&dirs).await;
        std::fs::create_dir_all(dirs.target.join("versions").join("pack")).unwrap();
        assert_blocked(
            &dirs,
            &MoveEnv::default(),
            &dirs.target,
            &[MoveBlocker::NameTaken],
        )
        .await;
        assert!(!dirs.target.join("libraries").exists(), "拦下时不补依赖");
    }

    #[tokio::test]
    async fn an_instance_inheriting_from_it_blocks() {
        let dirs = Dirs::new();
        build_instance(&dirs).await;
        write_version(
            &dirs.source,
            "Child",
            &json!({"id": "Child", "inheritsFrom": "pack", "type": "release", "mainClass": "m"})
                .to_string(),
        );
        assert_blocked(
            &dirs,
            &MoveEnv::default(),
            &dirs.target,
            &[MoveBlocker::HasDependents(vec!["Child".to_owned()])],
        )
        .await;
    }

    #[cfg(windows)]
    fn junction(link: &Path, target: &Path) {
        std::fs::create_dir_all(target).unwrap();
        let status = std::process::Command::new("cmd")
            .arg("/c")
            .arg("mklink")
            .arg("/J")
            .arg(link)
            .arg(target)
            .stdout(std::process::Stdio::null())
            .status()
            .unwrap();
        assert!(status.success());
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn junctions_in_the_instance_or_its_backups_block() {
        let dirs = Dirs::new();
        build_instance(&dirs).await;
        let elsewhere = dirs.tmp.path().join("别处");
        junction(
            &dirs.instance_in(&dirs.source).join("mods").join("linked"),
            &elsewhere,
        );
        junction(&dirs.backups_in(&dirs.source).join("jl"), &elsewhere);
        assert_blocked(
            &dirs,
            &MoveEnv::default(),
            &dirs.target,
            &[MoveBlocker::Links(vec![
                Path::new("mods").join("linked"),
                Path::new(".petalfall")
                    .join("backups")
                    .join("instances")
                    .join(ID)
                    .join("jl"),
            ])],
        )
        .await;
    }

    #[tokio::test]
    async fn too_little_space_on_the_target_blocks() {
        let dirs = Dirs::new();
        build_instance(&dirs).await;
        let env = MoveEnv {
            available_space: Some(1000),
            ..cross_volume()
        };
        let required = dirs
            .petalfall()
            .inspect_move(ID, &dirs.target, &env)
            .await
            .unwrap()
            .preview
            .required_bytes;
        assert_blocked(
            &dirs,
            &env,
            &dirs.target,
            &[MoveBlocker::InsufficientSpace {
                needed: required + SPACE_MARGIN,
                available: 1000,
            }],
        )
        .await;
    }

    #[tokio::test]
    async fn the_current_directory_or_one_inside_the_instance_is_not_a_target() {
        let dirs = Dirs::new();
        build_instance(&dirs).await;
        let alias = PathBuf::from(format!(
            "{}/",
            dirs.source.display().to_string().to_uppercase()
        ));
        assert_blocked(
            &dirs,
            &MoveEnv::default(),
            &alias,
            &[MoveBlocker::SameDirectory],
        )
        .await;
        let inside = dirs
            .instance_in(&dirs.source)
            .join("saves")
            .join(".minecraft");
        assert_blocked(
            &dirs,
            &MoveEnv::default(),
            &inside,
            &[MoveBlocker::TargetInsideSource],
        )
        .await;
    }

    /// 别的目录移进来、还没迁完记录的同名实例（大小写不同也算）：收尾前不能再移它。
    #[tokio::test]
    async fn an_unfinished_move_of_the_same_instance_blocks() {
        let dirs = Dirs::new();
        build_instance(&dirs).await;
        let mut journal = MoveJournal::new(
            move_journal::new_token().unwrap(),
            "PACK",
            &dirs.tmp.path().join("别的").join(".minecraft"),
            &dirs.source,
            true,
            1,
        );
        journal.stage = MoveStage::Committed;
        move_journal::write(&dirs.data, &journal).await.unwrap();
        let preview = dirs
            .petalfall()
            .preview_instance_move(ID, &dirs.target)
            .await
            .unwrap();
        assert_eq!(preview.blockers, [MoveBlocker::Pending]);
        let err = dirs
            .petalfall()
            .move_instance_files(&dirs.request(), None)
            .await
            .unwrap_err();
        assert!(
            matches!(
                &err,
                CoreError::InstanceMoveBlocked {
                    blocker: MoveBlocker::Pending,
                    ..
                }
            ),
            "{err:?}"
        );
        assert_eq!(journals(&dirs).len(), 1);
    }

    #[tokio::test]
    async fn an_unisolated_instance_previews_as_shared() {
        let dirs = Dirs::new();
        write_version(&dirs.source, "Plain", &vanilla_json("Plain"));
        let preview = dirs
            .petalfall()
            .preview_instance_move("Plain", &dirs.target)
            .await
            .unwrap();
        assert!(!preview.isolated);
        assert!(preview.blockers.is_empty(), "{:?}", preview.blockers);
        assert_eq!((preview.backup_count, preview.backup_bytes), (0, 0));
    }

    #[tokio::test]
    async fn an_id_in_another_case_is_not_the_instance() {
        let dirs = Dirs::new();
        build_instance(&dirs).await;
        let err = dirs
            .petalfall()
            .preview_instance_move("pack", &dirs.target)
            .await
            .unwrap_err();
        assert!(
            matches!(&err, CoreError::VersionNotInstalled { id } if id == "pack"),
            "{err:?}"
        );
    }

    // ---- 启动收尾 ----

    fn copy_all(from: &Path, to: &Path) {
        std::fs::create_dir_all(to).unwrap();
        for entry in std::fs::read_dir(from).unwrap() {
            let entry = entry.unwrap();
            let dst = to.join(entry.file_name());
            if entry.file_type().unwrap().is_dir() {
                copy_all(&entry.path(), &dst);
            } else {
                std::fs::copy(entry.path(), dst).unwrap();
            }
        }
    }

    fn rename(from: &Path, to: &Path) {
        std::fs::create_dir_all(to.parent().unwrap()).unwrap();
        std::fs::rename(from, to).unwrap();
    }

    fn rolled_back(dirs: &Dirs) -> MoveRecovery {
        MoveRecovery::RolledBack {
            id: ID.to_owned(),
            source_game_dir: dirs.source.clone(),
            target_game_dir: dirs.target.clone(),
        }
    }

    #[tokio::test]
    async fn an_interrupted_copy_is_rolled_back_by_dropping_the_staging() {
        let dirs = Dirs::new();
        build_instance(&dirs).await;
        let instance = snapshot(&dirs.instance_in(&dirs.source));
        let backups = snapshot(&dirs.backups_in(&dirs.source));
        let journal = dirs.journal(false);
        let staging = journal.staging_dir.clone().unwrap();
        put(&staging.join(STAGED_INSTANCE).join("options.txt"), b"half");
        move_journal::write(&dirs.data, &journal).await.unwrap();

        let recovered = dirs.petalfall().recover_instance_moves().await.unwrap();

        assert_eq!(recovered, [rolled_back(&dirs)]);
        assert!(!staging.exists());
        assert_untouched(&dirs, &instance, &backups).await;
    }

    #[tokio::test]
    async fn a_commit_interrupted_after_the_first_rename_puts_the_original_back() {
        let dirs = Dirs::new();
        build_instance(&dirs).await;
        let instance = snapshot(&dirs.instance_in(&dirs.source));
        let backups = snapshot(&dirs.backups_in(&dirs.source));
        let mut journal = dirs.journal(false);
        journal.stage = MoveStage::Committing;
        let (staging, old) = (
            journal.staging_dir.clone().unwrap(),
            journal.old_dir.clone().unwrap(),
        );
        copy_all(
            &dirs.instance_in(&dirs.source),
            &staging.join(STAGED_INSTANCE),
        );
        rename(&dirs.instance_in(&dirs.source), &old);
        move_journal::write(&dirs.data, &journal).await.unwrap();

        let recovered = dirs.petalfall().recover_instance_moves().await.unwrap();

        assert_eq!(recovered, [rolled_back(&dirs)]);
        assert!(!old.exists() && !staging.exists());
        assert_untouched(&dirs, &instance, &backups).await;
    }

    /// 两步改名都做完了、记录还没迁：认作已提交，补迁记录与备份，删旧目录与暂存。
    #[tokio::test]
    async fn a_commit_interrupted_after_the_second_rename_is_completed() {
        let dirs = Dirs::new();
        build_instance(&dirs).await;
        let instance = snapshot(&dirs.instance_in(&dirs.source));
        let backups = snapshot(&dirs.backups_in(&dirs.source));
        let mut journal = dirs.journal(false);
        journal.stage = MoveStage::Committing;
        journal.backups_staged = true;
        let (staging, old) = (
            journal.staging_dir.clone().unwrap(),
            journal.old_dir.clone().unwrap(),
        );
        copy_all(
            &dirs.backups_in(&dirs.source),
            &staging.join(STAGED_BACKUPS),
        );
        copy_all(
            &dirs.instance_in(&dirs.source),
            &dirs.instance_in(&dirs.target),
        );
        rename(&dirs.instance_in(&dirs.source), &old);
        move_journal::write(&dirs.data, &journal).await.unwrap();

        let recovered = dirs.petalfall().recover_instance_moves().await.unwrap();

        assert_eq!(recovered, [MoveRecovery::Completed(outcome(&dirs))]);
        assert!(!old.exists() && !staging.exists());
        assert_eq!(snapshot(&dirs.instance_in(&dirs.target)), instance);
        assert_eq!(snapshot(&dirs.backups_in(&dirs.target)), backups);
        assert!(!dirs.backups_in(&dirs.source).exists());
        assert_eq!(minutes(&dirs, &dirs.target).await, Some(60));
        assert_eq!(minutes(&dirs, &dirs.source).await, None);
        assert!(journals(&dirs).is_empty());
    }

    /// 已提交、旧目录还在：补完收尾；同一份日志再收一遍（日志没删掉的情形）什么都不多做。
    #[tokio::test]
    async fn a_committed_move_with_the_old_directory_left_is_completed_and_reentrant() {
        let dirs = Dirs::new();
        build_instance(&dirs).await;
        let instance = snapshot(&dirs.instance_in(&dirs.source));
        let mut journal = dirs.journal(false);
        journal.stage = MoveStage::Committed;
        let old = journal.old_dir.clone().unwrap();
        copy_all(
            &dirs.instance_in(&dirs.source),
            &dirs.instance_in(&dirs.target),
        );
        rename(&dirs.instance_in(&dirs.source), &old);
        move_journal::write(&dirs.data, &journal).await.unwrap();

        let recovered = dirs.petalfall().recover_instance_moves().await.unwrap();

        assert_eq!(recovered, [MoveRecovery::Completed(outcome(&dirs))]);
        assert!(!old.exists());
        assert_eq!(snapshot(&dirs.instance_in(&dirs.target)), instance);
        assert_eq!(minutes(&dirs, &dirs.target).await, Some(60));
        // 当时没有复制备份：原游戏目录里那份不碰。
        assert!(dirs.backups_in(&dirs.source).exists());
        assert!(journals(&dirs).is_empty());

        move_journal::write(&dirs.data, &journal).await.unwrap();
        let again = dirs.petalfall().recover_instance_moves().await.unwrap();
        assert_eq!(again, [MoveRecovery::Completed(outcome(&dirs))]);
        assert_eq!(minutes(&dirs, &dirs.target).await, Some(60));
        assert!(journals(&dirs).is_empty());
    }

    /// 只剩清理的日志再收时不再迁记录：原游戏目录里这时的同名实例的记录是它自己的。
    #[tokio::test]
    async fn a_settled_move_only_cleans_up() {
        let dirs = Dirs::new();
        build_instance(&dirs).await;
        let mut journal = dirs.journal(false);
        journal.stage = MoveStage::Settled;
        let old = journal.old_dir.clone().unwrap();
        put(&old.join("leftover.txt"), b"x");
        copy_all(
            &dirs.instance_in(&dirs.source),
            &dirs.instance_in(&dirs.target),
        );
        move_journal::write(&dirs.data, &journal).await.unwrap();

        let recovered = dirs.petalfall().recover_instance_moves().await.unwrap();

        assert_eq!(recovered, [MoveRecovery::Completed(outcome(&dirs))]);
        assert!(!old.exists());
        assert_eq!(minutes(&dirs, &dirs.source).await, Some(60));
        assert_eq!(minutes(&dirs, &dirs.target).await, None);
        assert!(dirs.backups_in(&dirs.source).exists());
        assert!(journals(&dirs).is_empty());
    }

    #[tokio::test]
    async fn unreachable_directories_defer_and_unreadable_journals_are_kept_aside() {
        let dirs = Dirs::new();
        build_instance(&dirs).await;
        let gone = dirs.tmp.path().join("拔掉的盘").join(".minecraft");
        let journal = MoveJournal::new(
            move_journal::new_token().unwrap(),
            ID,
            &dirs.source,
            &gone,
            false,
            1,
        );
        move_journal::write(&dirs.data, &journal).await.unwrap();
        put(&dirs.data.join("moves").join("9-9.json"), b"{ broken");

        let recovered = dirs.petalfall().recover_instance_moves().await.unwrap();

        assert_eq!(
            recovered,
            [MoveRecovery::Deferred {
                id: ID.to_owned(),
                reason: format!("{} 现在访问不到", gone.display()),
            }]
        );
        let mut left = journals(&dirs);
        left.sort();
        assert_eq!(
            left,
            [
                format!("{}.json", journal.token),
                "9-9.json.broken".to_owned()
            ]
        );
        assert!(dirs.instance_in(&dirs.source).is_dir());
    }

    /// 日志说已提交、目标里却没有实例而旧目录还在：动哪边都可能删掉唯一的一份，不动，日志留着。
    #[tokio::test]
    async fn a_disk_that_contradicts_the_journal_is_left_alone() {
        let dirs = Dirs::new();
        build_instance(&dirs).await;
        std::fs::create_dir_all(&dirs.target).unwrap();
        let instance = snapshot(&dirs.instance_in(&dirs.source));
        let mut journal = dirs.journal(false);
        journal.stage = MoveStage::Committed;
        let old = journal.old_dir.clone().unwrap();
        rename(&dirs.instance_in(&dirs.source), &old);
        move_journal::write(&dirs.data, &journal).await.unwrap();

        let recovered = dirs.petalfall().recover_instance_moves().await.unwrap();

        assert!(
            matches!(&recovered[..], [MoveRecovery::Deferred { id, reason }]
                if id == ID && reason.contains(&old.display().to_string())),
            "{recovered:?}"
        );
        assert_eq!(snapshot(&old), instance);
        assert_eq!(journals(&dirs).len(), 1);
        assert_eq!(minutes(&dirs, &dirs.source).await, Some(60));
    }

    #[test]
    fn the_verdict_never_drops_the_only_copy() {
        use MoveStage::{Committed, Committing, Copying, Settled};
        let disk = |source, target, old, staged| Disk {
            source,
            target,
            old,
            staged,
        };
        let only_staged = Verdict::Stuck("原位置和旧目录里都没有这个实例，只剩暂存里的副本");
        let cases = [
            // 同卷：一次改名，在目标且不在原位才算提交了。
            (
                Copying,
                true,
                disk(true, false, false, false),
                Verdict::Discard,
            ),
            (
                Committing,
                true,
                disk(false, true, false, false),
                Verdict::Finish,
            ),
            (
                Committing,
                true,
                disk(true, false, false, false),
                Verdict::Discard,
            ),
            (
                Committing,
                true,
                disk(true, true, false, false),
                Verdict::Discard,
            ),
            (
                Committed,
                true,
                disk(false, true, false, false),
                Verdict::Finish,
            ),
            // 跨卷复制中：原件在原位，删暂存。
            (
                Copying,
                false,
                disk(true, false, false, true),
                Verdict::Discard,
            ),
            (
                Copying,
                false,
                disk(false, false, true, true),
                Verdict::RenameBack,
            ),
            (Copying, false, disk(false, false, false, true), only_staged),
            // 跨卷提交中的各个时刻。
            (
                Committing,
                false,
                disk(true, false, false, true),
                Verdict::Discard,
            ),
            (
                Committing,
                false,
                disk(false, false, true, true),
                Verdict::RenameBack,
            ),
            (
                Committing,
                false,
                disk(false, true, true, false),
                Verdict::Finish,
            ),
            (
                Committing,
                false,
                disk(false, true, false, false),
                Verdict::Finish,
            ),
            (
                Committing,
                false,
                disk(false, false, false, true),
                Verdict::RollForward,
            ),
            (
                Committing,
                false,
                disk(false, true, true, true),
                Verdict::RenameBack,
            ),
            (
                Committing,
                false,
                disk(true, false, true, true),
                Verdict::Stuck("原位置和旧目录里都有这个实例"),
            ),
            (
                Committing,
                false,
                disk(false, true, false, true),
                only_staged,
            ),
            // 已提交。
            (
                Committed,
                false,
                disk(false, true, true, false),
                Verdict::Finish,
            ),
            (
                Settled,
                false,
                disk(false, true, false, false),
                Verdict::Finish,
            ),
            (
                Committed,
                false,
                disk(false, false, true, false),
                Verdict::Stuck("日志说已提交，可目标里没有这个实例，原件的旧目录还在"),
            ),
        ];
        for (stage, same_volume, disk, expected) in cases {
            assert_eq!(
                judge(stage, same_volume, disk),
                expected,
                "{stage:?} same_volume={same_volume} {disk:?}"
            );
        }
    }

    #[test]
    fn lexical_keys_ignore_case_separators_dots_and_trailing_slashes() {
        assert_eq!(
            lexical_key(Path::new(r"E:\Games\.minecraft\")),
            lexical_key(Path::new("e:/games/./x/../.minecraft"))
        );
        assert!(is_within(
            Path::new("E:/Games/.minecraft/versions/Pack/sub"),
            Path::new(r"e:\games\.minecraft\versions\pack")
        ));
        assert!(!is_within(
            Path::new("E:/Games/.minecraft/versions/Pack2"),
            Path::new("E:/Games/.minecraft/versions/Pack")
        ));
    }
}
