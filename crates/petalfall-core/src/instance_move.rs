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
//! 启动收尾是同一个函数，可以重入。调用方改好配置后经 [`Petalfall::confirm_instance_move`] 确认，日志这才删。
//!
//! 提交那一刻原备份（跨卷时连同原件）按 token 改名进原游戏目录的 `.petalfall/moving/<token>`，之后只按这个路径
//! 处理它们，再也不按实例 id 去动原游戏目录：收尾可能推迟到下次启动，那时原目录里可能已经有了同名的新实例，
//! 按 id 删备份、迁游玩记录就会删掉、搬走它的。

use std::collections::BTreeMap;
use std::fmt;
use std::path::{Component, Path, PathBuf, Prefix};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, PoisonError};
use std::time::{Duration, Instant};

use petalfall_base::error_with_causes;
use petalfall_download::CancellationToken;
use petalfall_instance::{
    VERSIONS_DIR, discover_versions, is_backup_file_name, is_safe_instance_id, list_version_dirs,
};
use tokio::sync::{RwLock, RwLockReadGuard};

use crate::InstanceError;
use crate::error::{CoreError, Result};
use crate::event::{CoreEvent, DownloadProgress, EventSink, InstallPhase, emit};
use crate::facade::Petalfall;
use crate::folders::{DIR_PROBE_TIMEOUT, same_path, validate_game_dir};
use crate::instances::{
    dependents_in, forget_base_versions_in, forget_unlanded_base_versions_in,
    record_base_versions_in,
};
use crate::move_copy::{
    CopyControl, Sha1Digest, TreeScan, available_space, copy_file, copy_tree, flush_dir,
    remove_tree, rename_no_replace, same_volume, scan_tree, verify_tree,
};
use crate::move_deps::{DependencyFile, DependencyPlan, plan_dependencies};
use crate::move_journal::{self, JournalEntry, MoveJournal, MoveStage};
use crate::world_backup::{instance_backups_dir_in, merge_staged_backups};

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
    /// 同名（不分大小写）实例有一次移动还没彻底完成（没收拾完，或调用方还没确认），它的源或目标就是这次的源或
    /// 目标，完成前不能再移。
    Pending,
    /// 请求发起时实例所在的游戏目录不是现在的当前目录：同名实例在别的游戏目录里是另一个实例，不能按旧请求移它。
    SourceChanged,
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
            MoveBlocker::SourceChanged => f.write_str("当前游戏目录已经换了，不是发起移动时的那个"),
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
    /// 发起时实例所在的游戏目录。执行时当前目录已经不是它就报 [`MoveBlocker::SourceChanged`]。
    pub source_game_dir: PathBuf,
    pub target_game_dir: PathBuf,
}

/// 移动已经完成，但没跟过去、要提示玩家的一项。带的字符串是人类可读的原因。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MoveFollowUp {
    /// 游玩记录没挪过去：迁移出错时下次启动再迁；原游戏目录里已经有了同名的新实例时不再迁，原账下这个名字的记录
    /// 分不清是谁的，留给新实例。
    PlayRecords(String),
    /// 备份没全部挪过去：原备份按这次移动收在原游戏目录的 `.petalfall/moving/<token>/backups`（原因里带着路径），
    /// 没并过去之前不删。
    WorldBackups(String),
    /// 移动留下的旧文件没删干净（路径），下次启动时再清。
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
    /// 这次移动的日志编号。调用方把配置改好、落了盘，再经 [`Petalfall::confirm_instance_move`] 确认；确认之前
    /// 日志留着，进程在中间退出时启动收尾会再交出一次 [`MoveRecovery::Completed`]。
    pub token: String,
    /// 能不能去掉原游戏目录在配置里对它的引用：原目录里此后又有了同名的新实例时为假，那些引用是新实例的。执行
    /// 的结果恒为真。
    pub forget_source_refs: bool,
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
    /// 提交已经完成、调用方还没确认：补做了记录迁移与清理。调用方据此改配置（按
    /// [`MoveOutcome::forget_source_refs`] 决定去不去掉原游戏目录的引用），落了盘再确认。
    Completed(MoveOutcome),
    /// 调用方早已确认（配置当时已经改过），这次补完了剩下的记录迁移或残留清理，什么都不剩了。调用方不要再改配置：
    /// 原游戏目录里此后可能有了同名的新实例。
    Settled {
        id: String,
        source_game_dir: PathBuf,
        target_game_dir: PathBuf,
    },
    /// 有目录访问不到、收尾中途出错、有事没做成（残留删不掉、记录没迁上），或盘面与日志对不上不敢动（`reason` 里
    /// 带着各处路径）。日志还在的下次启动再试。
    Deferred { id: String, reason: String },
}

// ---- 执行环境 ----

/// 目标盘写完之后至少还要剩下的字节：盘写满时游戏的存档与日志都会写坏。
const SPACE_MARGIN: u64 = 256 * 1024 * 1024;
/// 字节进度事件的最小间隔，与下载进度的节流一致。
const PROGRESS_INTERVAL: Duration = Duration::from_millis(100);
/// 补共用文件时同时复制的文件数：资源对象是几千个小文件，每个都要落盘再读回比对，一个接一个太慢。
const DEPENDENCY_WORKERS: usize = 4;

/// 执行与启动收尾之间的门：执行占读锁（几个实例可以同时移），启动收尾占写锁。启动收尾在后台跑，这时玩家已经
/// 能点移动；不隔开的话，收尾会把正在进行的那次移动的日志当成中断的，回滚掉它的暂存甚至原件。
static MOVE_GATE: RwLock<()> = RwLock::const_new(());

/// 预检与执行里随环境而定的几项。生产全部自动判断；测试强制走跨卷的复制路径、改写目标盘的剩余空间、往复制与
/// 刷盘里注入故障。
#[derive(Clone, Default)]
pub(crate) struct MoveEnv {
    volume: VolumeMode,
    #[cfg(test)]
    available_space: Option<u64>,
    #[cfg(test)]
    fault: Option<SharedFault>,
    /// 刷盘前以要刷的目录调用；返回 Err 时这次刷盘以它失败。
    #[cfg(test)]
    flush_fault: Option<SharedFault>,
}

/// 测试注入的钩子（写后钩子见 [`CopyControl::with_fault`]）。要带进阻塞线程，所以是 `Arc` 且 `Send`。
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

    /// 把目录刷到盘上（阻塞）。
    fn flush_dir(&self, path: &Path) -> Result<()> {
        #[cfg(test)]
        if let Some(fault) = &self.flush_fault {
            fault(path).map_err(|source| io_error(path, source))?;
        }
        flush_dir(path)
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

    /// 执行。请求里的源目录已经不是当前目录报 [`MoveBlocker::SourceChanged`]；再重新预检，有拦截项报
    /// [`CoreError::InstanceMoveBlocked`]（第一个）。`events` 推步骤与进度；取消看门面快照上的令牌，提交开始后
    /// 不再理会。只处理文件与记录，配置里的引用由调用方随后经 [`Petalfall::forget_moved_instance`] 改掉并落盘，
    /// 再经 [`Petalfall::confirm_instance_move`] 确认。
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
        let env = MoveEnv::default();
        let mut recovered = Vec::new();
        for entry in move_journal::list(self.data_dir()).await? {
            match entry {
                JournalEntry::Read(journal) => {
                    recovered.push(self.recover_move(journal, &env).await)
                }
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

    /// 调用方把移动后的配置改好、落了盘之后确认（`token` 即 [`MoveOutcome::token`]）：记下已确认；记录收拾完了、
    /// 旧目录与暂存也都不在了就删掉日志，否则写回日志，留给启动收尾接着做。`token` 不是移动日志的编号（带路径
    /// 分隔符之类）报错；日志已经不在算成功（重复确认）。与执行一样占门的读那一侧：启动收尾正在改日志时等它。
    pub async fn confirm_instance_move(&self, token: &str) -> Result<()> {
        let _gate = MOVE_GATE.read().await;
        let Some(mut journal) = move_journal::read(self.data_dir(), token).await? else {
            return Ok(());
        };
        journal.config_done = true;
        let mut leftovers = path_exists(&journal.old_dir).await?;
        if let Some(staging) = &journal.staging_dir {
            leftovers |= path_exists(staging).await?;
        }
        if journal.stage == MoveStage::Settled && !leftovers {
            move_journal::remove(self.data_dir(), token).await
        } else {
            move_journal::write(self.data_dir(), &journal).await
        }
    }

    async fn inspect_move(&self, id: &str, target: &Path, env: &MoveEnv) -> Result<Inspection> {
        let target = validate_game_dir(&target.to_string_lossy())?;
        let source = self.game_dir().to_path_buf();
        let instance_dir = self.existing_instance_dir(id).await?;
        // Windows 上大小写不同的 id 也打得开目录；照它改名会改掉实例名的大小写，记录与备份也就对不上了。
        if !has_entry_named(&source.join(VERSIONS_DIR), id).await? {
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
        let pending = move_journal::is_held(self.data_dir(), id, &source, &target).await?;
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
            id,
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

/// `dir` 下有没有名字一字不差（大小写也算）的一项，目录、文件、链接都算；`dir` 不存在为没有。
async fn has_entry_named(dir: &Path, name: &str) -> Result<bool> {
    let mut read = match tokio::fs::read_dir(dir).await {
        Ok(read) => read,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(source) => return Err(io_error(dir, source)),
    };
    while let Some(entry) = read
        .next_entry()
        .await
        .map_err(|source| io_error(dir, source))?
    {
        if entry.file_name() == name {
            return Ok(true);
        }
    }
    Ok(false)
}

/// 实例目录里的链接（相对实例目录，实例目录本身是链接时记作实例 id），加上备份目录里的链接（相对游戏目录，以
/// `.petalfall/backups/...` 开头，与实例目录里的区分开；备份目录本身是链接时就是这个前缀）。
fn link_paths(
    id: &str,
    instance: &TreeScan,
    backups: Option<&TreeScan>,
    source: &Path,
    backups_dir: &Path,
) -> Vec<PathBuf> {
    // 空的相对路径是根目录本身；`join("")` 会多出一个末尾分隔符，所以单独处理。
    let mut links: Vec<PathBuf> = instance
        .links
        .iter()
        .map(|rel| {
            if rel.as_os_str().is_empty() {
                PathBuf::from(id)
            } else {
                rel.clone()
            }
        })
        .collect();
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
    /// 有东西停在旧目录、改不回去：日志留给启动收尾。
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
        // 切换过游戏目录后，同名实例在当前目录里是另一个实例：按发起时的请求移它就移错了。
        if !same_path(&request.source_game_dir, self.game_dir()) {
            return Err(CoreError::InstanceMoveBlocked {
                id: request.id.clone(),
                blocker: MoveBlocker::SourceChanged,
            });
        }
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
        // 先写进日志再记进目标的依赖版本记录：记了而日志没记，中断后就没人知道要收回哪些。
        journal.bases = preview.bases_to_copy.clone();
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
        // 目标那本账下同名的记录只可能属于那边一个已经不在的同名实例（重名会被拦下），提交后并进来的却是累加：先丢掉。
        // 只能在提交之前做，这时目标里一定没有它；提交之后目标里玩出来的记录就分不开了。
        if let Err(err) = self
            .forget_play_records_in(&preview.target_game_dir, &preview.id)
            .await
        {
            return Err(self.abandon(&journal, err).await);
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
        // 刚提交完、还占着这个实例：原游戏目录里不会有同名的新实例。
        Ok(self.settle(journal, env, false).await.outcome)
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
        let (staging, staged_instance, staged_backups) = staging_paths(journal);
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
            let links = link_paths(&id, &instance, backups.as_ref(), &source, &backups_dir);
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
            let instance_digests = copy_tree(&instance_dir, &staged_instance, &instance, &control)?;
            let backups = match backups {
                Some(scan) => {
                    let digests = copy_tree(&backups_dir, &staged_backups, &scan, &control)?;
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
        let (_, staged_instance, staged_backups) = staging_paths(journal);
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
                &staged_instance,
                &staged.instance,
                &staged.instance_digests,
                &control,
            )?;
            if let Some((scan, digests)) = &staged.backups {
                verify_tree(&staged_backups, scan, digests, &control)?;
            }
            ensure_unchanged(&instance_dir, Some(&staged.instance))?;
            ensure_unchanged(&backups_dir, staged.backups.as_ref().map(|b| &b.0))?;
            progress.finish();
            Ok(())
        })
        .await
    }

    /// 提交。同卷：原备份（有的话）改名进旧目录，再把实例改名到目标。跨卷：原件改名进旧目录，原备份（有的话）
    /// 跟进去，再把暂存里的副本改名到目标。哪一步失败都按相反的顺序改回去：都改回去了就删暂存与日志再报错；有改
    /// 不回去的，日志留给启动收尾，报错里带上各处路径。
    async fn commit(&self, inspection: &Inspection, journal: &MoveJournal) -> Result<()> {
        let paths = CommitPaths {
            original: inspection.instance_dir.clone(),
            original_backups: inspection.backups_dir.clone(),
            dest: journal.target_game_dir.join(VERSIONS_DIR).join(&journal.id),
            old_dir: journal.old_dir.clone(),
            old_instance: journal.old_instance(),
            old_backups: journal.old_backups(),
        };
        let staged = journal.staged_instance();
        let backups_staged = journal.backups_staged;
        let outcome = tokio::task::spawn_blocking(move || match &staged {
            Some(staged) => commit_cross(&paths, staged, backups_staged),
            None => commit_same(&paths),
        })
        .await?;
        match outcome {
            Ok(()) => Ok(()),
            Err(CommitError::Restored(err)) => Err(self.abandon(journal, err).await),
            Err(CommitError::Stranded(err)) => {
                let error = error_with_causes(&err);
                tracing::error!(id = %journal.id, %error, "提交失败且没能全部改回原位，日志留给启动收尾");
                Err(err)
            }
        }
    }

    /// 提交前失败或取消：删暂存、收回没落下的基底记录、删日志，交回原来的错误。前两样没做成时日志留着，启动收尾
    /// 再做。
    async fn abandon(&self, journal: &MoveJournal, err: CoreError) -> CoreError {
        if let Err(cleanup) = self.discard(journal).await {
            let error = error_with_causes(&cleanup);
            tracing::warn!(id = %journal.id, %error, "移动没成，暂存或基底记录没收拾完，日志留着下次启动再收");
        }
        err
    }

    /// 回滚的收拾：收进旧目录的原备份改回原位；删暂存；要带的基底版本里没复制完的目录（没有版本 JSON 的只有这次
    /// 复制的一部分）整个删掉，再从目标的依赖版本记录里收回没落下的（不收回的话，日后玩家在那边装出同名版本会被
    /// 当成依赖版本藏起来）；旧目录空了删掉。都成了再删日志（日志删不掉只记日志：再来一遍做的是同样的事）。原件
    /// 改回原位由调用方先做：旧目录里还有东西时删不掉它，报错，日志留着。
    async fn discard(&self, journal: &MoveJournal) -> Result<()> {
        restore_original_backups(journal).await?;
        if let Some(staging) = journal.staging_dir.clone() {
            blocking(move || remove_tree(&staging)).await?;
        }
        if !journal.bases.is_empty() {
            remove_partial_bases(&journal.target_game_dir, &journal.bases).await?;
            forget_unlanded_base_versions_in(&journal.target_game_dir, &journal.bases).await?;
        }
        remove_empty_dir(&journal.old_dir).await?;
        self.drop_journal(journal).await;
        prune_moving_dirs(journal).await;
        Ok(())
    }

    async fn drop_journal(&self, journal: &MoveJournal) {
        if let Err(err) = move_journal::remove(self.data_dir(), &journal.token).await {
            let error = error_with_causes(&err);
            tracing::warn!(id = %journal.id, token = %journal.token, %error, "移动日志删不掉");
        }
    }

    /// 提交之后的收尾：备份、游玩记录、目标的依赖版本记录，再删旧目录与暂存。执行成功后与启动收尾都走这里，可以
    /// 重入：备份只并按 token 收着、还没并过去的，游玩记录迁过一次就记进日志，三样都收拾完记下
    /// [`MoveStage::Settled`]，之后再来只做清理。失败只记跟进项：实例已经在目标里，不能再报移动失败。调用方确认过、
    /// 收拾完了、残留也清完了才删日志。
    ///
    /// `source_reused`：原位置此刻有同名的目录，即原游戏目录里有了同名的新实例。这时原账下这个名字的游玩记录分不清
    /// 是谁的，不迁；结果里告诉调用方别去掉原游戏目录的配置引用。
    async fn settle(
        &self,
        mut journal: MoveJournal,
        env: &MoveEnv,
        source_reused: bool,
    ) -> Settlement {
        let mut follow_ups = Vec::new();
        let mut unfinished = Vec::new();
        let backups_carried = settle_backups(&journal, env, &mut follow_ups).await;
        if journal.stage != MoveStage::Settled {
            let records_done = self
                .settle_records(&mut journal, source_reused, &mut follow_ups)
                .await;
            let bases_done = match forget_base_versions_in(
                &journal.target_game_dir,
                std::slice::from_ref(&journal.id),
            )
            .await
            {
                Ok(()) => true,
                Err(err) => {
                    // 目标那边陈旧的同名依赖版本记录会把移过去的实例藏起来；没去掉就停在已提交，下次启动再去。
                    let error = error_with_causes(&err);
                    tracing::warn!(id = %journal.id, %error, "目标的依赖版本记录没去掉它，下次启动再去");
                    unfinished.push(format!("目标的依赖版本记录里还记着它：{error}"));
                    false
                }
            };
            journal.stage = if backups_carried && records_done && bases_done {
                MoveStage::Settled
            } else {
                MoveStage::Committed
            };
            if let Err(err) = move_journal::write(self.data_dir(), &journal).await {
                // 下次启动按盘上的旧进度再来一遍也对：并备份只并还没并过去的，游玩记录在原账下已经没有它时什么都不做。
                let error = error_with_causes(&err);
                tracing::error!(id = %journal.id, %error, "移动日志没记上收尾进度，下次启动再来一遍");
            }
        }
        let leftovers_remain = clean_up(&journal, env, &mut follow_ups).await;
        if leftovers_remain {
            unfinished.push("旧目录或暂存还没删完".to_owned());
        }
        if journal.stage != MoveStage::Settled {
            unfinished.push("备份或游玩记录还没收拾完".to_owned());
        }
        if journal.config_done && unfinished.is_empty() {
            self.drop_journal(&journal).await;
        }
        prune_moving_dirs(&journal).await;
        tracing::info!(
            id = %journal.id,
            stage = ?journal.stage,
            follow_ups = follow_ups.len(),
            unfinished = unfinished.len(),
            "实例移动收尾完成"
        );
        Settlement {
            outcome: MoveOutcome {
                token: journal.token.clone(),
                id: journal.id,
                source_game_dir: journal.source_game_dir,
                target_game_dir: journal.target_game_dir,
                follow_ups,
                forget_source_refs: !source_reused,
            },
            unfinished,
        }
    }

    /// 游玩记录并进目标那本账（累加，原账清掉），返回这一项收拾完了没有。原游戏目录里有了同名的新实例时不迁也算完。
    async fn settle_records(
        &self,
        journal: &mut MoveJournal,
        source_reused: bool,
        follow_ups: &mut Vec<MoveFollowUp>,
    ) -> bool {
        if journal.records_moved {
            return true;
        }
        if source_reused {
            let reason = format!(
                "原游戏目录里已经有了同名的新实例（{}），原账下这个名字的游玩记录分不清是谁的，留在原游戏目录",
                journal
                    .source_game_dir
                    .join(VERSIONS_DIR)
                    .join(&journal.id)
                    .display()
            );
            tracing::warn!(id = %journal.id, %reason, "游玩记录不迁");
            follow_ups.push(MoveFollowUp::PlayRecords(reason));
            return true;
        }
        match self
            .move_play_records(
                &journal.id,
                &journal.source_game_dir,
                &journal.target_game_dir,
            )
            .await
        {
            Ok(()) => {
                journal.records_moved = true;
                true
            }
            Err(err) => {
                let reason = error_with_causes(&err);
                tracing::warn!(id = %journal.id, %reason, "游玩记录没挪过去，下次启动再迁");
                follow_ups.push(MoveFollowUp::PlayRecords(reason));
                false
            }
        }
    }
}

/// 一次收尾的结局。
struct Settlement {
    outcome: MoveOutcome,
    /// 日志还得留着的原因（备份或记录没收拾完、依赖版本记录没改上、残留没删完）；都做完了为空。跟进项另在 `outcome` 里。
    unfinished: Vec<String>,
}

/// 备份跟过去，返回该并的都并过去了没有。原备份在提交时按 token 收进了旧目录，这里只按 token 路径处理，绝不按实例
/// id 去动原游戏目录：那里此时可能已经有了同名的新实例和它的备份。同卷并的就是原备份本身；跨卷并的是暂存里校验
/// 过的副本，副本全部并过去、目标里有、刷到盘上之后才删原备份，否则原备份留着、记跟进项。只剩清理时
/// （[`MoveStage::Settled`]）不再并：那时还有没并过去的，只能是盘面后来变过，不敢再动，留给玩家。
async fn settle_backups(
    journal: &MoveJournal,
    env: &MoveEnv,
    follow_ups: &mut Vec<MoveFollowUp>,
) -> bool {
    let (target, id) = (&journal.target_game_dir, journal.id.as_str());
    let original = journal.old_backups();
    let pending = journal.staged_backups().unwrap_or_else(|| original.clone());
    let mut cause = None;
    if journal.stage != MoveStage::Settled
        && (journal.same_volume || journal.backups_staged)
        && let Err(err) = merge_staged_backups(&pending, target, id).await
    {
        let reason = error_with_causes(&err);
        tracing::warn!(id, %reason, "备份没全部并进目标");
        cause = Some(reason);
    }
    let left = match has_entries(&pending).await {
        Ok(left) => left,
        Err(err) => {
            cause.get_or_insert_with(|| error_with_causes(&err));
            true
        }
    };
    let with_cause = |what: String, cause: Option<String>| match cause {
        Some(cause) => format!("{what}：{cause}"),
        None => what,
    };
    if left {
        let what = if journal.same_volume {
            format!("原备份没全部并进目标，留在 {}", pending.display())
        } else {
            format!(
                "暂存里还有没并进目标的备份（{}），原备份留在 {}",
                pending.display(),
                original.display()
            )
        };
        follow_ups.push(MoveFollowUp::WorldBackups(with_cause(what, cause)));
        return false;
    }
    if journal.same_volume {
        return true;
    }
    match path_exists(&original).await {
        Ok(false) => return true,
        Ok(true) => {}
        Err(err) => {
            follow_ups.push(MoveFollowUp::Cleanup {
                path: original,
                reason: error_with_causes(&err),
            });
            return true;
        }
    }
    if !journal.backups_staged {
        // 提交时核对过原备份在不在与有没有副本一致，到这里只能是盘面后来变过：没有副本的原备份不删。
        follow_ups.push(MoveFollowUp::WorldBackups(format!(
            "原备份没有复制过副本，留在 {}",
            original.display()
        )));
        return true;
    }
    // 副本全部并过去了也可能不在目标里（目标那边被删过）：这时原备份是唯一的一份。
    let merged = instance_backups_dir_in(target, id);
    match path_exists(&merged).await {
        Ok(true) => {}
        Ok(false) => {
            follow_ups.push(MoveFollowUp::WorldBackups(format!(
                "目标里没有这份备份（{}），原备份留在 {}",
                merged.display(),
                original.display()
            )));
            return true;
        }
        Err(err) => {
            follow_ups.push(MoveFollowUp::WorldBackups(format!(
                "看不了目标里的备份（{}），原备份留在 {}",
                error_with_causes(&err),
                original.display()
            )));
            return true;
        }
    }
    // 副本是改名并进目标的；两边不在一个卷上，原备份这边的删除先落了盘、目标那边的改名没落盘，断电后副本回到暂存，
    // 而日志可能已经说收拾完了：先把目标那边刷到盘上。
    let flushed = {
        let env = env.clone();
        let merged = merged.clone();
        blocking(move || {
            env.flush_dir(&merged)?;
            match merged.parent() {
                Some(parent) => env.flush_dir(parent),
                None => Ok(()),
            }
        })
        .await
    };
    if let Err(err) = flushed {
        let reason = format!(
            "目标里的备份没能刷到盘上，原备份留到下次启动再删：{}",
            error_with_causes(&err)
        );
        tracing::warn!(id, %reason, "原备份先不删");
        follow_ups.push(MoveFollowUp::Cleanup {
            path: original,
            reason,
        });
        return true;
    }
    remove_leftover(id, original, follow_ups).await;
    true
}

/// 删旧目录与暂存里能删的，返回还有没有残留。原件（旧目录里的 `instance/`）要等目标里的实例刷到盘上才删：两边不在
/// 一个卷上，原件这边的删除先落了盘、目标那边的改名没落盘，断电后两边就都没有了。暂存里的实例副本在目标里没有
/// 实例时不删：那时它可能是唯一的一份。两处备份由 [`settle_backups`] 处理；这里删掉空了的容器，容器里不认得的东西
/// 不删。
async fn clean_up(
    journal: &MoveJournal,
    env: &MoveEnv,
    follow_ups: &mut Vec<MoveFollowUp>,
) -> bool {
    let id = journal.id.as_str();
    if let Some(staged) = journal.staged_instance() {
        let versions = journal.target_game_dir.join(VERSIONS_DIR);
        let dest = versions.join(id);
        let dest_state = path_exists(&dest)
            .await
            .map_err(|err| format!("看不了目标里的实例（{}）", error_with_causes(&err)));
        let original = journal.old_instance();
        if present(&original, follow_ups).await {
            match &dest_state {
                Ok(true) => {
                    let flushed = {
                        let env = env.clone();
                        let (dest, versions) = (dest.clone(), versions.clone());
                        blocking(move || {
                            env.flush_dir(&dest)?;
                            env.flush_dir(&versions)
                        })
                        .await
                    };
                    match flushed {
                        Ok(()) => {
                            remove_leftover(id, original, follow_ups).await;
                        }
                        Err(err) => {
                            let reason = format!(
                                "目标里的实例没能刷到盘上，原件留到下次启动再删：{}",
                                error_with_causes(&err)
                            );
                            tracing::warn!(id, %reason, "原件先不删");
                            follow_ups.push(MoveFollowUp::Cleanup {
                                path: original,
                                reason,
                            });
                        }
                    }
                }
                Ok(false) => follow_ups.push(MoveFollowUp::Cleanup {
                    path: original,
                    reason: "目标里没有这个实例，原件留着".to_owned(),
                }),
                Err(reason) => follow_ups.push(MoveFollowUp::Cleanup {
                    path: original,
                    reason: format!("{reason}，原件留着"),
                }),
            }
        }
        if present(&staged, follow_ups).await {
            match &dest_state {
                Ok(true) => {
                    remove_leftover(id, staged, follow_ups).await;
                }
                Ok(false) => follow_ups.push(MoveFollowUp::Cleanup {
                    path: staged,
                    reason: "目标里没有这个实例，暂存里的副本可能是唯一的一份，没有删".to_owned(),
                }),
                Err(reason) => follow_ups.push(MoveFollowUp::Cleanup {
                    path: staged,
                    reason: format!("{reason}，暂存里的副本没有删"),
                }),
            }
        }
    }
    let mut remain = remove_container(
        &journal.old_dir,
        &[journal.old_instance(), journal.old_backups()],
        follow_ups,
    )
    .await;
    if let (Some(staging), Some(instance), Some(backups)) = (
        &journal.staging_dir,
        journal.staged_instance(),
        journal.staged_backups(),
    ) {
        remain |= remove_container(staging, &[instance, backups], follow_ups).await;
    }
    remain
}

/// 路径上有没有东西；看不了时记跟进项，按没有处理（不去动它）。
async fn present(path: &Path, follow_ups: &mut Vec<MoveFollowUp>) -> bool {
    match path_exists(path).await {
        Ok(present) => present,
        Err(err) => {
            follow_ups.push(MoveFollowUp::Cleanup {
                path: path.to_path_buf(),
                reason: error_with_causes(&err),
            });
            false
        }
    }
}

/// 旧目录或暂存这样的容器空了就删掉，返回它还在不在。`known` 是容器里这次移动放的东西（留着的都已记过跟进项）；
/// 别的东西不是这次移动放的，记跟进项、不删。
async fn remove_container(
    dir: &Path,
    known: &[PathBuf],
    follow_ups: &mut Vec<MoveFollowUp>,
) -> bool {
    let mut read = match tokio::fs::read_dir(dir).await {
        Ok(read) => read,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return false,
        Err(source) => {
            follow_ups.push(MoveFollowUp::Cleanup {
                path: dir.to_path_buf(),
                reason: error_with_causes(&io_error(dir, source)),
            });
            return true;
        }
    };
    let mut entries = Vec::new();
    loop {
        match read.next_entry().await {
            Ok(Some(entry)) => entries.push(entry.path()),
            Ok(None) => break,
            Err(source) => {
                follow_ups.push(MoveFollowUp::Cleanup {
                    path: dir.to_path_buf(),
                    reason: error_with_causes(&io_error(dir, source)),
                });
                return true;
            }
        }
    }
    drop(read);
    if entries.is_empty() {
        return match remove_empty_dir(dir).await {
            Ok(()) => false,
            Err(err) => {
                follow_ups.push(MoveFollowUp::Cleanup {
                    path: dir.to_path_buf(),
                    reason: error_with_causes(&err),
                });
                true
            }
        };
    }
    for path in entries.into_iter().filter(|path| !known.contains(path)) {
        follow_ups.push(MoveFollowUp::Cleanup {
            path,
            reason: "不是这次移动放的，没有删".to_owned(),
        });
    }
    true
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

/// 回滚时把收进旧目录的原备份改回原位。原位已经有东西时改名失败、报错：那不是这个实例的备份，不能盖掉。
async fn restore_original_backups(journal: &MoveJournal) -> Result<()> {
    let stashed = journal.old_backups();
    let original = instance_backups_dir_in(&journal.source_game_dir, &journal.id);
    blocking(move || {
        if !path_exists_blocking(&stashed)? {
            return Ok(());
        }
        if let Some(parent) = original.parent() {
            std::fs::create_dir_all(parent).map_err(|source| io_error(parent, source))?;
        }
        rename_no_replace(&stashed, &original)
    })
    .await
}

/// 回滚时删掉要带的基底版本里没复制完的目录。它们移动前在目标里没有（有的话会算作冲突或可复用），版本 JSON 最后
/// 复制，所以没有 JSON 的目录里只有这次复制的一部分；留着的话，下次预检会把它当成内容不同的同名基底拦下。
async fn remove_partial_bases(target: &Path, bases: &[String]) -> Result<()> {
    let versions = target.join(VERSIONS_DIR);
    let bases = bases.to_vec();
    blocking(move || {
        for base in &bases {
            if !is_safe_instance_id(base) {
                return Err(InstanceError::InvalidId { id: base.clone() }.into());
            }
            let dir = versions.join(base);
            if !path_exists_blocking(&dir)? {
                continue;
            }
            let json = dir.join(format!("{base}.json"));
            let landed = match std::fs::metadata(&json) {
                Ok(meta) => meta.is_file(),
                Err(err) if err.kind() == std::io::ErrorKind::NotFound => false,
                Err(source) => return Err(io_error(&json, source)),
            };
            if !landed {
                tracing::info!(base, path = %dir.display(), "回滚：删掉没复制完的基底版本目录");
                remove_tree(&dir)?;
            }
        }
        Ok(())
    })
    .await
}

/// 目录里还有没有东西；不在或空着为没有，空着的顺手删掉。
async fn has_entries(dir: &Path) -> Result<bool> {
    let mut read = match tokio::fs::read_dir(dir).await {
        Ok(read) => read,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(source) => return Err(io_error(dir, source)),
    };
    if read
        .next_entry()
        .await
        .map_err(|source| io_error(dir, source))?
        .is_some()
    {
        return Ok(true);
    }
    drop(read);
    remove_empty_dir(dir).await?;
    Ok(false)
}

/// 删一个空目录；不在算成功，不空照实报错。
async fn remove_empty_dir(dir: &Path) -> Result<()> {
    match tokio::fs::remove_dir(dir).await {
        Ok(()) => Ok(()),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(source) => Err(io_error(dir, source)),
    }
}

/// 两边游戏目录里的 `.petalfall/moving` 空了就删掉。只删空目录：别的移动可能正在里面放东西。删不掉只记日志，空
/// 目录不碍事。
async fn prune_moving_dirs(journal: &MoveJournal) {
    let parents = journal
        .staging_dir
        .iter()
        .chain(std::iter::once(&journal.old_dir))
        .filter_map(|dir| dir.parent());
    for dir in parents {
        match tokio::fs::remove_dir(dir).await {
            Ok(()) => {}
            Err(err)
                if matches!(
                    err.kind(),
                    std::io::ErrorKind::NotFound | std::io::ErrorKind::DirectoryNotEmpty
                ) => {}
            Err(err) => {
                tracing::warn!(path = %dir.display(), error = %err, "移动用的空目录删不掉");
            }
        }
    }
}

/// 跨卷日志的暂存目录，与里面实例副本、备份副本的位置。
fn staging_paths(journal: &MoveJournal) -> (PathBuf, PathBuf, PathBuf) {
    const CROSS: &str = "跨卷移动的日志由 MoveJournal::new 带上暂存目录";
    (
        journal.staging_dir.clone().expect(CROSS),
        journal.staged_instance().expect(CROSS),
        journal.staged_backups().expect(CROSS),
    )
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

/// 提交要动的几处位置。
struct CommitPaths {
    /// 原件 `<源>/versions/<id>` 与原备份 `<源>/.petalfall/backups/instances/<id>`。
    original: PathBuf,
    original_backups: PathBuf,
    /// 目标位置 `<目标>/versions/<id>`。
    dest: PathBuf,
    /// 原游戏目录里按 token 收东西的旧目录，与原件、原备份在里面的位置。
    old_dir: PathBuf,
    old_instance: PathBuf,
    old_backups: PathBuf,
}

/// 同卷：原备份（有的话）改名进旧目录，再把实例改名到目标。
fn commit_same(paths: &CommitPaths) -> std::result::Result<(), CommitError> {
    let mut moved = Vec::new();
    if path_exists_blocking(&paths.original_backups).map_err(CommitError::Restored)? {
        std::fs::create_dir_all(&paths.old_dir)
            .map_err(|source| CommitError::Restored(io_error(&paths.old_dir, source)))?;
        rename_no_replace(&paths.original_backups, &paths.old_backups)
            .map_err(CommitError::Restored)?;
        moved.push((&paths.old_backups, &paths.original_backups));
    }
    match rename_no_replace(&paths.original, &paths.dest) {
        Ok(()) => Ok(()),
        Err(err) => put_back(err, &moved),
    }
}

/// 跨卷：原件改名进旧目录，原备份（有的话）跟进去，再把暂存里的副本改名到目标。
fn commit_cross(
    paths: &CommitPaths,
    staged: &Path,
    backups_staged: bool,
) -> std::result::Result<(), CommitError> {
    let has_backups =
        path_exists_blocking(&paths.original_backups).map_err(CommitError::Restored)?;
    if has_backups != backups_staged {
        // 校验之后原备份冒出来或没了，与暂存里的副本对不上：照样提交的话，收尾会把没有副本的原备份当成并过去删掉，
        // 或者把已经删掉的备份并回去。
        return Err(CommitError::Restored(CoreError::InstanceMoveVerifyFailed {
            path: paths.original_backups.clone(),
        }));
    }
    std::fs::create_dir_all(&paths.old_dir)
        .map_err(|source| CommitError::Restored(io_error(&paths.old_dir, source)))?;
    rename_no_replace(&paths.original, &paths.old_instance).map_err(CommitError::Restored)?;
    let mut moved = vec![(&paths.old_instance, &paths.original)];
    if has_backups {
        if let Err(err) = rename_no_replace(&paths.original_backups, &paths.old_backups) {
            return put_back(err, &moved);
        }
        moved.push((&paths.old_backups, &paths.original_backups));
    }
    match rename_no_replace(staged, &paths.dest) {
        Ok(()) => Ok(()),
        Err(err) => put_back(err, &moved),
    }
}

/// 提交中途失败：已经改了名的（现在的位置，原来的位置）按相反的顺序改回去。都改回去了原件就在原位；有改不回去的，
/// 日志留给启动收尾，报错里带上两边的路径。
fn put_back(
    err: CoreError,
    moved: &[(&PathBuf, &PathBuf)],
) -> std::result::Result<(), CommitError> {
    let mut stuck = Vec::new();
    for (now, back) in moved.iter().rev() {
        if let Err(again) = rename_no_replace(now, back) {
            stuck.push(format!(
                "{} 改回 {} 失败（{}）",
                now.display(),
                back.display(),
                error_with_causes(&again)
            ));
        }
    }
    let Some((first, _)) = moved.first().filter(|_| !stuck.is_empty()) else {
        return Err(CommitError::Restored(err));
    };
    let message = format!(
        "{}，下次启动时再改回；提交失败的原因：{}",
        stuck.join("；"),
        error_with_causes(&err)
    );
    Err(CommitError::Stranded(io_error(
        first,
        std::io::Error::other(message),
    )))
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

/// 一份日志涉及的几处位置此刻在不在。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Disk {
    /// 原位置 `<源>/versions/<id>`。提交之后它在，就是原游戏目录里有了同名的新实例（或改名没落盘）。
    source: bool,
    /// 目标位置 `<目标>/versions/<id>`。
    target: bool,
    /// 跨卷时原件提交中改名到的位置（旧目录里的 `instance/`）。
    old: bool,
    /// 跨卷时暂存里的实例副本。
    staged: bool,
    /// 目标游戏目录本身。
    target_root: bool,
}

/// 按日志与盘面得出的收尾办法。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Verdict {
    /// 已经提交：补做记录迁移与清理。
    Finish,
    /// 已经提交、目标里却没有，只剩校验过的暂存副本：改名到目标，再补做记录迁移与清理。
    RollForward,
    /// 原件停在旧目录：改回原位，原备份也改回去，再删暂存。
    RenameBack,
    /// 原件在原位（或没有我们的东西可保）：原备份改回原位，删暂存。
    Discard,
    /// 盘面与日志对不上，动哪边都可能删掉唯一的一份：不动，留给玩家。
    Stuck(&'static str),
}

/// 收尾办法。原则：原件或它唯一的副本绝不删；能确认提交过才补完，否则回滚；复制阶段的暂存没校验过，绝不往前补完。
fn judge(stage: MoveStage, same_volume: bool, disk: Disk) -> Verdict {
    let verdict = if same_volume {
        judge_same_volume(stage, disk)
    } else {
        judge_cross_volume(stage, disk)
    };
    // 目标游戏目录整个不在了（被删了，盘还在）：补完会在原处重新建出它（并备份、改依赖版本记录都要建目录），把
    // 记录迁进一个已经没有的地方。只剩清理的不受影响：清理只删两边以 token 命名的中间目录。
    if !disk.target_root
        && stage != MoveStage::Settled
        && matches!(verdict, Verdict::Finish | Verdict::RollForward)
    {
        return Verdict::Stuck("日志说已提交，可目标游戏目录已经不在了");
    }
    verdict
}

fn judge_same_volume(stage: MoveStage, disk: Disk) -> Verdict {
    use MoveStage::{Committed, Committing, Copying, Settled};
    // 同卷的提交是一次改名，要么在原位要么在目标。
    match stage {
        // 实例在原位、不在目标：可能是改名没落盘，那原位置的就是它本身，补完会把它的备份并去目标；也可能是目标里的
        // 被删了、原目录里又建了同名的新实例。分不清，不动。
        Committed if !disk.target && disk.source => {
            Verdict::Stuck("日志说已提交，可目标里没有这个实例，原位置却有")
        }
        Committed | Settled => Verdict::Finish,
        Committing if disk.target && !disk.source => Verdict::Finish,
        // 改名成了、「已提交」还没写上就被杀，之后原目录里又建出同名的新实例；也可能是改名前目标里先冒出了同名目录。
        // 两边都在，分不清哪份是原件：回滚会把收起的备份改名给原位置那份，再删日志，目标里那份就没人认领了。
        Committing if disk.target && disk.source => {
            Verdict::Stuck("日志停在提交中，原位置和目标里都有这个实例")
        }
        Copying | Committing => Verdict::Discard,
    }
}

fn judge_cross_volume(stage: MoveStage, disk: Disk) -> Verdict {
    use MoveStage::{Committed, Committing, Copying, Settled};
    match stage {
        // 「已提交」写在两步改名都成了之后，暂存副本是校验过的：目标里没有、暂存里还有，是第二步改名没落盘（两边不在
        // 一个卷上，各自落盘），补做这一步。原件在不在旧目录都一样：原件要等目标刷到盘上才删。
        Committed | Settled if !disk.target && disk.staged => Verdict::RollForward,
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

/// 限时判断一个游戏目录此刻看不看得清：它在，或者它不在而最近的已存在上级在（目录被删了，盘还在），都算看得清，
/// 交给判定表按「那里什么都没有」处理；一路往上都访问不到（盘拔了、网络断了）或超时，才算不可达。
async fn probe_reachable(path: &Path) -> bool {
    let owned = path.to_path_buf();
    let probe = tokio::task::spawn_blocking(move || {
        for dir in owned.ancestors() {
            match std::fs::metadata(dir) {
                Ok(_) => return true,
                Err(err) if err.kind() == std::io::ErrorKind::NotFound => {}
                Err(_) => return false,
            }
        }
        false
    });
    match tokio::time::timeout(DIR_PROBE_TIMEOUT, probe).await {
        Ok(Ok(reachable)) => reachable,
        Ok(Err(join)) => {
            tracing::warn!(path = %path.display(), error = %join, "目录探测线程异常结束，按不可达处理");
            false
        }
        Err(_) => {
            tracing::info!(path = %path.display(), "目录探测超时，按不可达处理");
            false
        }
    }
}

impl Petalfall {
    async fn recover_move(&self, journal: MoveJournal, env: &MoveEnv) -> MoveRecovery {
        let id = journal.id.clone();
        for dir in [&journal.source_game_dir, &journal.target_game_dir] {
            if !probe_reachable(dir).await {
                tracing::info!(id, path = %dir.display(), "中断的移动涉及的目录访问不到，下次启动再收尾");
                return MoveRecovery::Deferred {
                    id,
                    reason: format!("{} 现在访问不到", dir.display()),
                };
            }
        }
        match self.resume_move(journal, env).await {
            Ok(recovery) => recovery,
            Err(err) => {
                let reason = error_with_causes(&err);
                tracing::error!(id, %reason, "中断的移动没能收尾，日志留着下次启动再试");
                MoveRecovery::Deferred { id, reason }
            }
        }
    }

    async fn resume_move(&self, journal: MoveJournal, env: &MoveEnv) -> Result<MoveRecovery> {
        let original = journal.source_game_dir.join(VERSIONS_DIR).join(&journal.id);
        let dest = journal.target_game_dir.join(VERSIONS_DIR).join(&journal.id);
        let staged = journal.staged_instance();
        let old = (!journal.same_volume).then(|| journal.old_instance());
        let disk = Disk {
            source: path_exists(&original).await?,
            target: path_exists(&dest).await?,
            old: match &old {
                Some(old) => path_exists(old).await?,
                None => false,
            },
            staged: match &staged {
                Some(staged) => path_exists(staged).await?,
                None => false,
            },
            target_root: path_exists(&journal.target_game_dir).await?,
        };
        let verdict = judge(journal.stage, journal.same_volume, disk);
        tracing::info!(id = %journal.id, stage = ?journal.stage, config_done = journal.config_done, ?disk, ?verdict, "收尾中断的移动");
        let rolled_back = |journal: &MoveJournal| MoveRecovery::RolledBack {
            id: journal.id.clone(),
            source_game_dir: journal.source_game_dir.clone(),
            target_game_dir: journal.target_game_dir.clone(),
        };
        match verdict {
            Verdict::Finish | Verdict::RollForward => {
                if verdict == Verdict::RollForward {
                    let staged = staged.expect("跨卷日志带暂存目录");
                    blocking(move || rename_no_replace(&staged, &dest)).await?;
                }
                let config_done = journal.config_done;
                // 提交之后原位置又有了同名目录：那是原游戏目录里的同名新实例，按 id 动原目录的事一概不做。
                let settlement = self.settle(journal, env, disk.source).await;
                if !config_done {
                    return Ok(MoveRecovery::Completed(settlement.outcome));
                }
                // 调用方早已确认、配置当时改过：这次只补完记录与清理，不能再交出 Completed 让调用方重改一遍。
                let outcome = settlement.outcome;
                if outcome.follow_ups.is_empty() && settlement.unfinished.is_empty() {
                    return Ok(MoveRecovery::Settled {
                        id: outcome.id,
                        source_game_dir: outcome.source_game_dir,
                        target_game_dir: outcome.target_game_dir,
                    });
                }
                let left: Vec<String> = outcome
                    .follow_ups
                    .iter()
                    .map(|follow_up| match follow_up {
                        MoveFollowUp::Cleanup { path, reason } => {
                            format!("{}（{reason}）", path.display())
                        }
                        MoveFollowUp::PlayRecords(reason) | MoveFollowUp::WorldBackups(reason) => {
                            reason.clone()
                        }
                    })
                    .chain(settlement.unfinished)
                    .collect();
                Ok(MoveRecovery::Deferred {
                    id: outcome.id,
                    reason: format!("上次移动还有没收完的：{}", left.join("；")),
                })
            }
            Verdict::RenameBack => {
                let old = old.expect("只有跨卷日志判出改回原位");
                blocking(move || rename_no_replace(&old, &original)).await?;
                self.discard(&journal).await?;
                Ok(rolled_back(&journal))
            }
            Verdict::Discard => {
                self.discard(&journal).await?;
                Ok(rolled_back(&journal))
            }
            Verdict::Stuck(why) => Ok(MoveRecovery::Deferred {
                id: journal.id.clone(),
                reason: format!(
                    "{why}，没有动它：原位置 {}，目标 {}，旧目录 {}，暂存 {}",
                    original.display(),
                    dest.display(),
                    journal.old_dir.display(),
                    staged.map_or_else(|| "无".to_owned(), |path| path.display().to_string()),
                ),
            }),
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
                source_game_dir: self.source.clone(),
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

    /// 游戏目录里放移动中间产物的目录；收拾完应当连它也不在。
    fn assert_no_moving_dir(game_dir: &Path) {
        let dir = game_dir.join(".petalfall").join("moving");
        assert!(!dir.exists(), "{} 还在：{:?}", dir.display(), entries(&dir));
    }

    /// 游戏目录的依赖版本记录；没有记录文件为 `None`。
    fn base_record(game_dir: &Path) -> Option<serde_json::Value> {
        let path = at(game_dir, ".petalfall/base-versions.json");
        path.exists()
            .then(|| serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap())
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
        assert_no_moving_dir(&dirs.target);
        assert_no_moving_dir(&dirs.source);
        assert!(journals(dirs).is_empty(), "{:?}", journals(dirs));
        assert_eq!(&snapshot(&dirs.backups_in(&dirs.source)), backups);
        assert!(!dirs.backups_in(&dirs.target).exists());
        assert_eq!(minutes(dirs, &dirs.source).await, Some(60));
        assert_eq!(minutes(dirs, &dirs.target).await, None);
    }

    /// 实例、依赖、备份与记录都到了目标，原处与中间目录都清干净了；日志等调用方确认，确认后删掉。
    async fn assert_moved(
        dirs: &Dirs,
        moved: &MoveOutcome,
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
        assert_eq!(base_record(&dirs.target), Some(json!({"versions": [BASE]})));
        assert_eq!(&snapshot(&dirs.backups_in(&dirs.target)), backups);
        assert!(!dirs.backups_in(&dirs.source).exists());
        assert_eq!(minutes(dirs, &dirs.target).await, Some(60));
        assert_eq!(minutes(dirs, &dirs.source).await, None);
        assert_no_moving_dir(&dirs.target);
        assert_no_moving_dir(&dirs.source);
        assert_eq!(journals(dirs), [journal_file(&moved.token)]);
        dirs.petalfall()
            .confirm_instance_move(&moved.token)
            .await
            .unwrap();
        assert!(journals(dirs).is_empty(), "{:?}", journals(dirs));
    }

    fn journal_file(token: &str) -> String {
        format!("{token}.json")
    }

    /// 全部跟过去、能去掉原游戏目录引用的结果。
    fn outcome(dirs: &Dirs, token: &str) -> MoveOutcome {
        MoveOutcome {
            id: ID.to_owned(),
            source_game_dir: dirs.source.clone(),
            target_game_dir: dirs.target.clone(),
            follow_ups: Vec::new(),
            token: token.to_owned(),
            forget_source_refs: true,
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

        assert!(!moved.token.is_empty());
        assert_eq!(moved, outcome(&dirs, &moved.token));
        assert_moved(&dirs, &moved, &instance, &backups).await;
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

        assert!(!moved.token.is_empty());
        assert_eq!(moved, outcome(&dirs, &moved.token));
        assert_moved(&dirs, &moved, &instance, &backups).await;
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

    /// 共用文件写到临时名时出的故障：基底版本排在共用文件之后，一个都没落下。
    fn is_shared_temp(path: &Path) -> bool {
        path.to_string_lossy().contains("gson-2.11.0.jar.")
    }

    /// 补依赖失败：目标的依赖版本记录里先记下的基底版本收回（目录没落下），目标里原有的记录不动。
    #[tokio::test]
    async fn a_failed_dependency_step_takes_back_the_recorded_bases() {
        let dirs = Dirs::new();
        build_instance(&dirs).await;
        let instance = snapshot(&dirs.instance_in(&dirs.source));
        let backups = snapshot(&dirs.backups_in(&dirs.source));
        record_base_versions_in(&dirs.target, &["别人的".to_owned()])
            .await
            .unwrap();
        let env = with_fault(MoveEnv::default(), |path| {
            if is_shared_temp(path) {
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
            matches!(&err, CoreError::Base(petalfall_base::Error::Io { path, .. }) if is_shared_temp(path)),
            "{err:?}"
        );
        assert!(!at(&dirs.target, &format!("versions/{BASE}")).exists());
        assert_eq!(
            base_record(&dirs.target),
            Some(json!({"versions": ["别人的"]}))
        );
        assert_untouched(&dirs, &instance, &backups).await;
    }

    #[tokio::test]
    async fn cancelling_the_dependency_step_takes_back_the_recorded_bases() {
        let dirs = Dirs::new();
        build_instance(&dirs).await;
        let instance = snapshot(&dirs.instance_in(&dirs.source));
        let backups = snapshot(&dirs.backups_in(&dirs.source));
        let token = CancellationToken::new();
        let trigger = token.clone();
        let env = with_fault(cross_volume(), move |path| {
            if is_shared_temp(path) {
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
        assert!(!at(&dirs.target, &format!("versions/{BASE}")).exists());
        assert_eq!(base_record(&dirs.target), Some(json!({"versions": []})));
        assert_untouched(&dirs, &instance, &backups).await;
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
                if *path == dirs.instance_in(&dirs.target)),
            "{err:?}"
        );
        assert_untouched(&dirs, &instance, &backups).await;
    }

    /// 预检之后目标里冒出了同名目录（哪怕是空的）：提交改名绝不盖掉它，原件留在原位。
    #[tokio::test]
    async fn a_same_named_directory_appearing_before_the_commit_is_never_replaced() {
        let dirs = Dirs::new();
        build_instance(&dirs).await;
        let instance = snapshot(&dirs.instance_in(&dirs.source));
        let backups = snapshot(&dirs.backups_in(&dirs.source));
        let squatter = dirs.instance_in(&dirs.target);
        let creator = squatter.clone();
        let env = with_fault(MoveEnv::default(), move |path| {
            if is_shared_temp(path) {
                std::fs::create_dir_all(&creator)?;
            }
            Ok(())
        });

        let err = dirs
            .petalfall()
            .move_instance_files_with(&dirs.request(), None, &env)
            .await
            .unwrap_err();

        assert!(
            matches!(&err, CoreError::Base(petalfall_base::Error::Io { path, source })
                if *path == squatter && source.kind() == std::io::ErrorKind::AlreadyExists),
            "{err:?}"
        );
        assert_eq!(snapshot(&dirs.instance_in(&dirs.source)), instance);
        // 同卷提交先把原备份收进旧目录：实例改名失败后改回原位。
        assert_eq!(snapshot(&dirs.backups_in(&dirs.source)), backups);
        assert_no_moving_dir(&dirs.source);
        assert!(squatter.is_dir() && snapshot(&squatter).is_empty());
        assert!(journals(&dirs).is_empty());
        assert_eq!(minutes(&dirs, &dirs.source).await, Some(60));
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
        // 第一步改名（原件到旧目录）就失败了：报的是旧目录的位置。
        assert!(
            matches!(&err, CoreError::Base(petalfall_base::Error::Io { path, .. })
                if path.starts_with(dirs.source.join(".petalfall").join("moving"))),
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
            source_game_dir: petalfall.game_dir().to_path_buf(),
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

    /// 实例目录与备份目录本身就是联接：拦截项里给的是实例 id 与备份目录的相对路径，不是空串。
    #[cfg(windows)]
    #[tokio::test]
    async fn an_instance_or_backups_directory_that_is_itself_a_junction_is_named() {
        let dirs = Dirs::new();
        build_instance(&dirs).await;
        let real_instance = dirs.tmp.path().join("别处").join(ID);
        let real_backups = dirs.tmp.path().join("别处").join("backups");
        rename(&dirs.instance_in(&dirs.source), &real_instance);
        rename(&dirs.backups_in(&dirs.source), &real_backups);
        junction(&dirs.instance_in(&dirs.source), &real_instance);
        junction(&dirs.backups_in(&dirs.source), &real_backups);
        assert_blocked(
            &dirs,
            &MoveEnv::default(),
            &dirs.target,
            &[MoveBlocker::Links(vec![
                PathBuf::from(ID),
                Path::new(".petalfall")
                    .join("backups")
                    .join("instances")
                    .join(ID),
            ])],
        )
        .await;
        assert!(real_instance.join(format!("{ID}.json")).is_file());
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

    /// 另一个同名实例从目标移走、还没确认：这时移进目标也要等它完成，否则它的收尾会把移进来的当成原目录里的同名新实例。
    #[tokio::test]
    async fn an_unfinished_move_out_of_the_target_blocks_moving_in() {
        let dirs = Dirs::new();
        build_instance(&dirs).await;
        let mut journal = MoveJournal::new(
            move_journal::new_token().unwrap(),
            ID,
            &dirs.target,
            &dirs.tmp.path().join("别的").join(".minecraft"),
            true,
            1,
        );
        journal.stage = MoveStage::Settled;
        move_journal::write(&dirs.data, &journal).await.unwrap();
        let preview = dirs
            .petalfall()
            .preview_instance_move(ID, &dirs.target)
            .await
            .unwrap();
        assert_eq!(preview.blockers, [MoveBlocker::Pending]);

        journal.config_done = true;
        move_journal::write(&dirs.data, &journal).await.unwrap();
        let preview = dirs
            .petalfall()
            .preview_instance_move(ID, &dirs.target)
            .await
            .unwrap();
        assert!(preview.blockers.is_empty(), "{:?}", preview.blockers);
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
        let mut journal = dirs.journal(false);
        journal.bases = vec![BASE.to_owned()];
        let staging = journal.staging_dir.clone().unwrap();
        put(
            &journal.staged_instance().unwrap().join("options.txt"),
            b"half",
        );
        record_base_versions_in(&dirs.target, &[BASE.to_owned(), "别人的".to_owned()])
            .await
            .unwrap();
        move_journal::write(&dirs.data, &journal).await.unwrap();

        let recovered = dirs.petalfall().recover_instance_moves().await.unwrap();

        assert_eq!(recovered, [rolled_back(&dirs)]);
        assert!(!staging.exists());
        // 基底没落下：记录里收回它，别的记录不动。
        assert_eq!(
            base_record(&dirs.target),
            Some(json!({"versions": ["别人的"]}))
        );
        assert_untouched(&dirs, &instance, &backups).await;
    }

    /// 原件与原备份都已收进旧目录、暂存还没改名到目标：两样都改回原位。
    #[tokio::test]
    async fn a_commit_interrupted_after_the_first_rename_puts_the_original_back() {
        let dirs = Dirs::new();
        build_instance(&dirs).await;
        let instance = snapshot(&dirs.instance_in(&dirs.source));
        let backups = snapshot(&dirs.backups_in(&dirs.source));
        let mut journal = dirs.journal(false);
        journal.stage = MoveStage::Committing;
        journal.backups_staged = true;
        let (staging, old) = (
            journal.staging_dir.clone().unwrap(),
            journal.old_dir.clone(),
        );
        copy_all(
            &dirs.instance_in(&dirs.source),
            &journal.staged_instance().unwrap(),
        );
        copy_all(
            &dirs.backups_in(&dirs.source),
            &journal.staged_backups().unwrap(),
        );
        rename(&dirs.instance_in(&dirs.source), &journal.old_instance());
        rename(&dirs.backups_in(&dirs.source), &journal.old_backups());
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
            journal.old_dir.clone(),
        );
        copy_all(
            &dirs.backups_in(&dirs.source),
            &journal.staged_backups().unwrap(),
        );
        copy_all(
            &dirs.instance_in(&dirs.source),
            &dirs.instance_in(&dirs.target),
        );
        rename(&dirs.instance_in(&dirs.source), &journal.old_instance());
        rename(&dirs.backups_in(&dirs.source), &journal.old_backups());
        move_journal::write(&dirs.data, &journal).await.unwrap();

        let recovered = dirs.petalfall().recover_instance_moves().await.unwrap();

        assert_eq!(
            recovered,
            [MoveRecovery::Completed(outcome(&dirs, &journal.token))]
        );
        assert!(!old.exists() && !staging.exists());
        assert_eq!(snapshot(&dirs.instance_in(&dirs.target)), instance);
        assert_eq!(snapshot(&dirs.backups_in(&dirs.target)), backups);
        assert!(!dirs.backups_in(&dirs.source).exists());
        assert_eq!(minutes(&dirs, &dirs.target).await, Some(60));
        assert_eq!(minutes(&dirs, &dirs.source).await, None);
        // 调用方还没确认：日志留着，记下已经收拾完。
        assert_eq!(journals(&dirs), [journal_file(&journal.token)]);
        let left = move_journal::read(&dirs.data, &journal.token)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            (left.stage, left.records_moved, left.config_done),
            (MoveStage::Settled, true, false)
        );
    }

    /// 复制过备份、可暂存与目标里都没有那份副本（目标那边被人删过）：收在旧目录里的原备份是唯一的一份，不删，记跟进项。
    #[tokio::test]
    async fn source_backups_stay_when_their_staged_copy_is_gone() {
        let dirs = Dirs::new();
        build_instance(&dirs).await;
        let backups = snapshot(&dirs.backups_in(&dirs.source));
        let mut journal = dirs.journal(false);
        journal.stage = MoveStage::Committed;
        journal.backups_staged = true;
        copy_all(
            &dirs.instance_in(&dirs.source),
            &dirs.instance_in(&dirs.target),
        );
        std::fs::remove_dir_all(dirs.instance_in(&dirs.source)).unwrap();
        rename(&dirs.backups_in(&dirs.source), &journal.old_backups());
        move_journal::write(&dirs.data, &journal).await.unwrap();

        let recovered = dirs.petalfall().recover_instance_moves().await.unwrap();

        let [MoveRecovery::Completed(outcome)] = &recovered[..] else {
            panic!("{recovered:?}");
        };
        assert!(
            matches!(&outcome.follow_ups[..], [MoveFollowUp::WorldBackups(reason)]
                if reason.contains(&dirs.backups_in(&dirs.target).display().to_string())
                    && reason.contains(&journal.old_backups().display().to_string())),
            "{:?}",
            outcome.follow_ups
        );
        assert_eq!(snapshot(&journal.old_backups()), backups);
        assert!(!dirs.backups_in(&dirs.source).exists());
        assert_eq!(minutes(&dirs, &dirs.target).await, Some(60));
        // 原备份还在旧目录里：确认之后日志也留着，下次启动再看。
        dirs.petalfall()
            .confirm_instance_move(&journal.token)
            .await
            .unwrap();
        assert_eq!(journals(&dirs), [journal_file(&journal.token)]);
    }

    /// 已提交、旧目录还在：补完收尾；没确认之前再收一遍，同样交出 Completed，什么都不多做（游玩记录不会再并一次）；
    /// 确认之后日志删掉，再收什么都没有。
    #[tokio::test]
    async fn a_committed_move_with_the_old_directory_left_is_completed_and_reentrant() {
        let dirs = Dirs::new();
        build_instance(&dirs).await;
        let instance = snapshot(&dirs.instance_in(&dirs.source));
        let backups = snapshot(&dirs.backups_in(&dirs.source));
        let mut journal = dirs.journal(false);
        journal.stage = MoveStage::Committed;
        let old = journal.old_dir.clone();
        copy_all(
            &dirs.instance_in(&dirs.source),
            &dirs.instance_in(&dirs.target),
        );
        rename(&dirs.instance_in(&dirs.source), &journal.old_instance());
        move_journal::write(&dirs.data, &journal).await.unwrap();

        let recovered = dirs.petalfall().recover_instance_moves().await.unwrap();

        let completed = MoveRecovery::Completed(outcome(&dirs, &journal.token));
        assert_eq!(recovered, std::slice::from_ref(&completed));
        assert!(!old.exists());
        assert_eq!(snapshot(&dirs.instance_in(&dirs.target)), instance);
        assert_eq!(minutes(&dirs, &dirs.target).await, Some(60));
        // 收尾只按 token 路径处理备份：原游戏目录里按 id 放着的那份不碰。
        assert_eq!(snapshot(&dirs.backups_in(&dirs.source)), backups);
        assert_eq!(journals(&dirs), [journal_file(&journal.token)]);

        let again = dirs.petalfall().recover_instance_moves().await.unwrap();
        assert_eq!(again, [completed]);
        assert_eq!(minutes(&dirs, &dirs.target).await, Some(60));
        assert_eq!(journals(&dirs), [journal_file(&journal.token)]);

        dirs.petalfall()
            .confirm_instance_move(&journal.token)
            .await
            .unwrap();
        assert!(journals(&dirs).is_empty());
        assert!(
            dirs.petalfall()
                .recover_instance_moves()
                .await
                .unwrap()
                .is_empty()
        );
    }

    /// 确认过、只剩清理的日志再收时不再迁记录：原游戏目录里这时的同名实例的记录是它自己的。
    #[tokio::test]
    async fn a_settled_move_only_cleans_up() {
        let dirs = Dirs::new();
        build_instance(&dirs).await;
        let mut journal = dirs.journal(false);
        journal.stage = MoveStage::Settled;
        journal.config_done = true;
        let old = journal.old_dir.clone();
        put(&journal.old_instance().join("leftover.txt"), b"x");
        copy_all(
            &dirs.instance_in(&dirs.source),
            &dirs.instance_in(&dirs.target),
        );
        move_journal::write(&dirs.data, &journal).await.unwrap();

        let recovered = dirs.petalfall().recover_instance_moves().await.unwrap();

        // 配置引用当时已经改过：这次交出 Settled，不是 Completed。
        assert_eq!(
            recovered,
            [MoveRecovery::Settled {
                id: ID.to_owned(),
                source_game_dir: dirs.source.clone(),
                target_game_dir: dirs.target.clone(),
            }]
        );
        assert!(!old.exists());
        assert_no_moving_dir(&dirs.source);
        assert_eq!(minutes(&dirs, &dirs.source).await, Some(60));
        assert_eq!(minutes(&dirs, &dirs.target).await, None);
        assert!(dirs.backups_in(&dirs.source).exists());
        assert!(journals(&dirs).is_empty());
    }

    /// 只剩清理、残留还是删不掉：推迟，日志留着下次再删，原因里写着删不掉的目录。
    #[cfg(windows)]
    #[tokio::test]
    async fn a_settled_move_whose_leftovers_stay_locked_is_deferred() {
        let dirs = Dirs::new();
        build_instance(&dirs).await;
        let mut journal = dirs.journal(false);
        journal.stage = MoveStage::Settled;
        journal.config_done = true;
        let old = journal.old_dir.clone();
        let locked = journal.old_instance().join("locked.txt");
        put(&locked, b"x");
        copy_all(
            &dirs.instance_in(&dirs.source),
            &dirs.instance_in(&dirs.target),
        );
        move_journal::write(&dirs.data, &journal).await.unwrap();
        let held = hold_exclusively(&locked);

        let recovered = dirs.petalfall().recover_instance_moves().await.unwrap();

        drop(held);
        assert!(
            matches!(&recovered[..], [MoveRecovery::Deferred { id, reason }]
                if id == ID && reason.contains(&journal.old_instance().display().to_string())),
            "{recovered:?}"
        );
        assert_eq!(journals(&dirs).len(), 1);
        let again = dirs.petalfall().recover_instance_moves().await.unwrap();
        assert!(
            matches!(&again[..], [MoveRecovery::Settled { .. }]),
            "{again:?}"
        );
        assert!(!old.exists());
        assert!(journals(&dirs).is_empty());
    }

    /// 目标游戏目录整个不在了、上级还在（目录被删了，不是盘拔了）：按「目标里什么都没有」判定，复制中的照常回滚，
    /// 也不在原处重新建出目标目录。
    #[tokio::test]
    async fn a_deleted_target_game_dir_rolls_an_interrupted_copy_back() {
        let dirs = Dirs::new();
        build_instance(&dirs).await;
        let instance = snapshot(&dirs.instance_in(&dirs.source));
        let backups = snapshot(&dirs.backups_in(&dirs.source));
        let mut journal = dirs.journal(false);
        journal.bases = vec![BASE.to_owned()];
        move_journal::write(&dirs.data, &journal).await.unwrap();
        assert!(!dirs.target.exists() && !dirs.target.parent().unwrap().exists());

        let recovered = dirs.petalfall().recover_instance_moves().await.unwrap();

        assert_eq!(recovered, [rolled_back(&dirs)]);
        assert!(!dirs.target.exists());
        assert_untouched(&dirs, &instance, &backups).await;
    }

    /// 原件已经改名到旧目录、目标游戏目录却被删了：改回原位。
    #[tokio::test]
    async fn a_deleted_target_game_dir_puts_a_half_committed_original_back() {
        let dirs = Dirs::new();
        build_instance(&dirs).await;
        let instance = snapshot(&dirs.instance_in(&dirs.source));
        let backups = snapshot(&dirs.backups_in(&dirs.source));
        let mut journal = dirs.journal(false);
        journal.stage = MoveStage::Committing;
        let old = journal.old_dir.clone();
        rename(&dirs.instance_in(&dirs.source), &journal.old_instance());
        move_journal::write(&dirs.data, &journal).await.unwrap();

        let recovered = dirs.petalfall().recover_instance_moves().await.unwrap();

        assert_eq!(recovered, [rolled_back(&dirs)]);
        assert!(!old.exists() && !dirs.target.exists());
        assert_untouched(&dirs, &instance, &backups).await;
    }

    /// 已提交、目标游戏目录却被删了：补完会在原处重新建出它、迁走记录与备份，不动，推迟。
    #[tokio::test]
    async fn a_committed_move_into_a_deleted_target_game_dir_is_left_alone() {
        let dirs = Dirs::new();
        build_instance(&dirs).await;
        let backups = snapshot(&dirs.backups_in(&dirs.source));
        std::fs::remove_dir_all(dirs.instance_in(&dirs.source)).unwrap();
        let mut journal = dirs.journal(true);
        journal.stage = MoveStage::Committed;
        move_journal::write(&dirs.data, &journal).await.unwrap();

        let recovered = dirs.petalfall().recover_instance_moves().await.unwrap();

        assert!(
            matches!(&recovered[..], [MoveRecovery::Deferred { id, reason }]
                if id == ID && reason.contains("目标游戏目录已经不在了")),
            "{recovered:?}"
        );
        assert!(!dirs.target.exists());
        assert_eq!(snapshot(&dirs.backups_in(&dirs.source)), backups);
        assert_eq!(minutes(&dirs, &dirs.source).await, Some(60));
        assert_eq!(journals(&dirs).len(), 1);
    }

    /// 源游戏目录整个不在了、上级还在：已提交的照常补完，记录迁到目标那本账。
    #[tokio::test]
    async fn a_deleted_source_game_dir_does_not_hold_up_a_committed_move() {
        let dirs = Dirs::new();
        build_instance(&dirs).await;
        let instance = snapshot(&dirs.instance_in(&dirs.source));
        copy_all(
            &dirs.instance_in(&dirs.source),
            &dirs.instance_in(&dirs.target),
        );
        std::fs::remove_dir_all(&dirs.source).unwrap();
        let mut journal = dirs.journal(false);
        journal.stage = MoveStage::Committed;
        move_journal::write(&dirs.data, &journal).await.unwrap();

        let recovered = dirs.petalfall().recover_instance_moves().await.unwrap();

        assert_eq!(
            recovered,
            [MoveRecovery::Completed(outcome(&dirs, &journal.token))]
        );
        assert_eq!(snapshot(&dirs.instance_in(&dirs.target)), instance);
        assert_eq!(minutes(&dirs, &dirs.target).await, Some(60));
        assert!(!dirs.source.exists(), "不在原处重新建出源目录");
        assert_eq!(journals(&dirs), [journal_file(&journal.token)]);
    }

    /// 一个此刻没有分配的盘符。
    #[cfg(windows)]
    fn unassigned_drive() -> PathBuf {
        ('D'..='Z')
            .rev()
            .map(|letter| PathBuf::from(format!("{letter}:\\")))
            .find(|root| std::fs::metadata(root).is_err())
            .expect("没有空闲的盘符")
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn unreachable_directories_defer_and_unreadable_journals_are_kept_aside() {
        let dirs = Dirs::new();
        build_instance(&dirs).await;
        let gone = unassigned_drive().join("Games").join(".minecraft");
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
        let old = journal.old_instance();
        rename(&dirs.instance_in(&dirs.source), &old);
        move_journal::write(&dirs.data, &journal).await.unwrap();

        let recovered = dirs.petalfall().recover_instance_moves().await.unwrap();

        assert!(
            matches!(&recovered[..], [MoveRecovery::Deferred { id, reason }]
                if id == ID && reason.contains(&journal.old_dir.display().to_string())),
            "{recovered:?}"
        );
        assert_eq!(snapshot(&old), instance);
        assert_eq!(journals(&dirs).len(), 1);
        assert_eq!(minutes(&dirs, &dirs.source).await, Some(60));
    }

    // ---- 审查修复：按 token 收起原件与原备份、原目录里的同名新实例、确认协议 ----

    /// 原游戏目录里新建一个同名的实例：自己的存档、一份备份（清单加 zip）、半小时游玩记录（记在原账下）。返回它的
    /// 实例目录与备份目录的快照。
    async fn build_newcomer(dirs: &Dirs) -> (BTreeMap<String, Vec<u8>>, BTreeMap<String, Vec<u8>>) {
        assert!(!dirs.instance_in(&dirs.source).exists());
        assert!(!dirs.backups_in(&dirs.source).exists());
        let dir = write_version(&dirs.source, ID, &instance_json());
        put(&dir.join("options.txt"), b"lang:en_us\n");
        put(
            &dir.join("saves").join("w").join("level.dat"),
            b"newcomer-level",
        );
        dirs.petalfall()
            .backup_world(ID, "w", BackupKind::Manual, None)
            .await
            .unwrap();
        let now = move_journal::now_millis().unwrap();
        crate::playtime::record_play(&dirs.data, &dirs.source, ID, now - HOUR / 2, now)
            .await
            .unwrap();
        let backups = snapshot(&dirs.backups_in(&dirs.source));
        assert!(
            backups.keys().any(|key| key.ends_with(".zip")),
            "{:?}",
            backups.keys()
        );
        (snapshot(&dir), backups)
    }

    /// 推迟收尾期间（跨卷，日志停在已提交、游玩记录没迁）原游戏目录里建了同名的新实例，带着它的备份与游玩记录。收尾
    /// 照常补完这次移动，但原目录里按 id 的东西一样不碰：新实例、它的备份、原账下的时长原样留着，调用方被告知别去掉
    /// 原目录的配置引用。
    #[tokio::test]
    async fn a_newcomer_with_the_same_name_survives_a_deferred_cross_volume_finish() {
        let dirs = Dirs::new();
        build_instance(&dirs).await;
        let instance = snapshot(&dirs.instance_in(&dirs.source));
        let backups = snapshot(&dirs.backups_in(&dirs.source));
        let mut journal = dirs.journal(false);
        journal.stage = MoveStage::Committed;
        journal.backups_staged = true;
        copy_all(
            &dirs.instance_in(&dirs.source),
            &dirs.instance_in(&dirs.target),
        );
        copy_all(
            &dirs.backups_in(&dirs.source),
            &journal.staged_backups().unwrap(),
        );
        rename(&dirs.instance_in(&dirs.source), &journal.old_instance());
        rename(&dirs.backups_in(&dirs.source), &journal.old_backups());
        move_journal::write(&dirs.data, &journal).await.unwrap();
        let (newcomer, newcomer_backups) = build_newcomer(&dirs).await;
        assert_eq!(minutes(&dirs, &dirs.source).await, Some(90));

        let recovered = dirs.petalfall().recover_instance_moves().await.unwrap();

        let [MoveRecovery::Completed(outcome)] = &recovered[..] else {
            panic!("{recovered:?}");
        };
        assert!(!outcome.forget_source_refs);
        assert_eq!(outcome.token, journal.token);
        assert!(
            matches!(&outcome.follow_ups[..], [MoveFollowUp::PlayRecords(reason)]
                if reason.contains("同名的新实例")),
            "{:?}",
            outcome.follow_ups
        );
        assert_eq!(snapshot(&dirs.instance_in(&dirs.source)), newcomer);
        assert_eq!(snapshot(&dirs.backups_in(&dirs.source)), newcomer_backups);
        assert_eq!(minutes(&dirs, &dirs.source).await, Some(90));
        assert_eq!(minutes(&dirs, &dirs.target).await, None);
        // 移过去的那个照常补完：备份副本并进目标，旧目录里的原件与原备份删掉。
        assert_eq!(snapshot(&dirs.instance_in(&dirs.target)), instance);
        assert_eq!(snapshot(&dirs.backups_in(&dirs.target)), backups);
        assert!(!journal.old_dir.exists());
        assert_no_moving_dir(&dirs.source);
        assert_no_moving_dir(&dirs.target);
        assert_eq!(journals(&dirs), [journal_file(&journal.token)]);
    }

    /// 同卷版本：原备份在提交时收进了旧目录，收尾把它并进目标；原目录里新实例的备份与时长不动。
    #[tokio::test]
    async fn a_newcomer_with_the_same_name_survives_a_deferred_same_volume_finish() {
        let dirs = Dirs::new();
        build_instance(&dirs).await;
        let instance = snapshot(&dirs.instance_in(&dirs.source));
        let backups = snapshot(&dirs.backups_in(&dirs.source));
        let mut journal = dirs.journal(true);
        journal.stage = MoveStage::Committed;
        rename(&dirs.backups_in(&dirs.source), &journal.old_backups());
        rename(
            &dirs.instance_in(&dirs.source),
            &dirs.instance_in(&dirs.target),
        );
        move_journal::write(&dirs.data, &journal).await.unwrap();
        let (newcomer, newcomer_backups) = build_newcomer(&dirs).await;

        let recovered = dirs.petalfall().recover_instance_moves().await.unwrap();

        let [MoveRecovery::Completed(outcome)] = &recovered[..] else {
            panic!("{recovered:?}");
        };
        assert!(!outcome.forget_source_refs);
        assert!(
            matches!(&outcome.follow_ups[..], [MoveFollowUp::PlayRecords(_)]),
            "{:?}",
            outcome.follow_ups
        );
        assert_eq!(snapshot(&dirs.instance_in(&dirs.source)), newcomer);
        assert_eq!(snapshot(&dirs.backups_in(&dirs.source)), newcomer_backups);
        assert_eq!(minutes(&dirs, &dirs.source).await, Some(90));
        assert_eq!(minutes(&dirs, &dirs.target).await, None);
        assert_eq!(snapshot(&dirs.instance_in(&dirs.target)), instance);
        assert_eq!(snapshot(&dirs.backups_in(&dirs.target)), backups);
        assert!(!journal.old_dir.exists());
        assert_no_moving_dir(&dirs.source);
    }

    /// 同卷提交改完名、还没记上「已提交」就被杀了，下次打开落樱之前，玩家用别的启动器玩了同名版本，原位置又建出了
    /// 一个同名目录（没有落樱的备份）。日志停在「提交中」、两边都有这个实例，盘面证明不了哪份是原件：回滚会把收起的
    /// 备份改名给原位置那个新实例，再删掉日志，目标里移过去的实例就没人认领了。所以不动，日志留着、原因里带上各处路径。
    #[tokio::test]
    async fn a_same_volume_commit_interrupted_before_committed_with_a_newcomer_is_left_alone() {
        let dirs = Dirs::new();
        build_instance(&dirs).await;
        let instance = snapshot(&dirs.instance_in(&dirs.source));
        let backups = snapshot(&dirs.backups_in(&dirs.source));
        let source_minutes = minutes(&dirs, &dirs.source).await;
        assert!(source_minutes.is_some());
        let mut journal = dirs.journal(true);
        journal.stage = MoveStage::Committing;
        rename(&dirs.backups_in(&dirs.source), &journal.old_backups());
        rename(
            &dirs.instance_in(&dirs.source),
            &dirs.instance_in(&dirs.target),
        );
        move_journal::write(&dirs.data, &journal).await.unwrap();
        // 别的启动器建出的同名版本目录：只有版本 JSON 与它自己的文件，没有落樱的元数据与备份。
        let newcomer_dir = write_version(&dirs.source, ID, &instance_json());
        put(&newcomer_dir.join("options.txt"), b"lang:en_us\n");
        let newcomer = snapshot(&newcomer_dir);

        let recovered = dirs.petalfall().recover_instance_moves().await.unwrap();

        let [MoveRecovery::Deferred { id, reason }] = &recovered[..] else {
            panic!("{recovered:?}");
        };
        assert_eq!(id, ID);
        for path in [
            dirs.instance_in(&dirs.source),
            dirs.instance_in(&dirs.target),
        ] {
            assert!(
                reason.contains(&path.display().to_string()),
                "原因里应有 {}：{reason}",
                path.display()
            );
        }
        assert_eq!(snapshot(&dirs.instance_in(&dirs.target)), instance);
        assert_eq!(snapshot(&journal.old_backups()), backups);
        assert!(
            !dirs.backups_in(&dirs.source).exists(),
            "收起的备份不能改名给原位置的新实例"
        );
        assert_eq!(snapshot(&newcomer_dir), newcomer);
        assert_eq!(minutes(&dirs, &dirs.source).await, source_minutes);
        assert_eq!(minutes(&dirs, &dirs.target).await, None);
        assert_eq!(journals(&dirs).len(), 1, "日志要留着");

        // 再收一遍结果相同，什么都不动。
        let again = dirs.petalfall().recover_instance_moves().await.unwrap();
        assert!(
            matches!(&again[..], [MoveRecovery::Deferred { .. }]),
            "{again:?}"
        );
        assert_eq!(snapshot(&journal.old_backups()), backups);
        assert_eq!(snapshot(&dirs.instance_in(&dirs.target)), instance);
    }

    /// 日志说已提交（或已收拾完），目标里却没有实例、暂存里还有、旧目录里的原件也没了：第二步改名没落盘，从校验过的
    /// 暂存往前补完，目标里的实例逐字节完整。
    #[tokio::test]
    async fn a_lost_second_rename_is_rolled_forward_from_the_verified_staging() {
        for (stage, config_done) in [
            (MoveStage::Committed, false),
            (MoveStage::Settled, false),
            (MoveStage::Settled, true),
        ] {
            let dirs = Dirs::new();
            build_instance(&dirs).await;
            let instance = snapshot(&dirs.instance_in(&dirs.source));
            std::fs::create_dir_all(dirs.target.join("versions")).unwrap();
            let mut journal = dirs.journal(false);
            journal.stage = stage;
            journal.records_moved = stage == MoveStage::Settled;
            journal.config_done = config_done;
            copy_all(
                &dirs.instance_in(&dirs.source),
                &journal.staged_instance().unwrap(),
            );
            std::fs::remove_dir_all(dirs.instance_in(&dirs.source)).unwrap();
            move_journal::write(&dirs.data, &journal).await.unwrap();

            let recovered = dirs.petalfall().recover_instance_moves().await.unwrap();

            let expected = if config_done {
                MoveRecovery::Settled {
                    id: ID.to_owned(),
                    source_game_dir: dirs.source.clone(),
                    target_game_dir: dirs.target.clone(),
                }
            } else {
                MoveRecovery::Completed(outcome(&dirs, &journal.token))
            };
            assert_eq!(recovered, [expected], "{stage:?}");
            assert_eq!(
                snapshot(&dirs.instance_in(&dirs.target)),
                instance,
                "{stage:?}"
            );
            assert_no_moving_dir(&dirs.target);
            assert_eq!(journals(&dirs).is_empty(), config_done, "{stage:?}");
        }
    }

    /// 复制阶段中断时暂存看着齐全也没校验过：删暂存，原件不动，绝不往前补完。
    #[tokio::test]
    async fn an_interrupted_copy_is_never_rolled_forward() {
        let dirs = Dirs::new();
        build_instance(&dirs).await;
        let instance = snapshot(&dirs.instance_in(&dirs.source));
        let backups = snapshot(&dirs.backups_in(&dirs.source));
        let journal = dirs.journal(false);
        copy_all(
            &dirs.instance_in(&dirs.source),
            &journal.staged_instance().unwrap(),
        );
        copy_all(
            &dirs.backups_in(&dirs.source),
            &journal.staged_backups().unwrap(),
        );
        move_journal::write(&dirs.data, &journal).await.unwrap();

        let recovered = dirs.petalfall().recover_instance_moves().await.unwrap();

        assert_eq!(recovered, [rolled_back(&dirs)]);
        assert_untouched(&dirs, &instance, &backups).await;
    }

    /// 切换过游戏目录后，按发起时的请求移的是另一个目录里的同名实例：报 SourceChanged，什么都不动。同一个目录换个
    /// 写法（大小写、末尾分隔符）不算换了。
    #[tokio::test]
    async fn a_request_made_in_another_current_directory_is_refused_before_anything_moves() {
        let dirs = Dirs::new();
        build_instance(&dirs).await;
        let instance = snapshot(&dirs.instance_in(&dirs.source));
        let backups = snapshot(&dirs.backups_in(&dirs.source));
        let stale = MoveRequest {
            source_game_dir: dirs.tmp.path().join("别的").join(".minecraft"),
            ..dirs.request()
        };

        let err = dirs
            .petalfall()
            .move_instance_files(&stale, None)
            .await
            .unwrap_err();

        assert!(
            matches!(&err, CoreError::InstanceMoveBlocked { id, blocker: MoveBlocker::SourceChanged } if id == ID),
            "{err:?}"
        );
        assert!(!dirs.target.exists());
        assert_untouched(&dirs, &instance, &backups).await;

        let alias = MoveRequest {
            source_game_dir: PathBuf::from(format!(
                "{}/",
                dirs.source.display().to_string().to_uppercase()
            )),
            ..dirs.request()
        };
        let moved = dirs
            .petalfall()
            .move_instance_files(&alias, None)
            .await
            .unwrap();
        assert_eq!(moved, outcome(&dirs, &moved.token));
    }

    /// 跨卷提交后目标没能刷到盘上：原件留在旧目录、日志留着（确认了也留着），下次启动刷成了再删。那时原目录里新建的
    /// 同名实例与它的备份不受影响：收尾只认 token 路径。
    #[tokio::test]
    async fn an_unflushed_target_keeps_the_original_until_the_next_start() {
        let dirs = Dirs::new();
        build_instance(&dirs).await;
        let instance = snapshot(&dirs.instance_in(&dirs.source));
        let backups = snapshot(&dirs.backups_in(&dirs.source));
        let dest = dirs.instance_in(&dirs.target);
        let refused = dest.clone();
        let env = MoveEnv {
            flush_fault: Some(Arc::new(move |path: &Path| {
                if path == refused {
                    return Err(std::io::Error::other("注入的刷盘失败"));
                }
                Ok(())
            })),
            ..cross_volume()
        };

        let moved = dirs
            .petalfall()
            .move_instance_files_with(&dirs.request(), None, &env)
            .await
            .unwrap();

        let journal = move_journal::read(&dirs.data, &moved.token)
            .await
            .unwrap()
            .unwrap();
        let original = journal.old_instance();
        assert!(
            matches!(&moved.follow_ups[..], [MoveFollowUp::Cleanup { path, reason }]
                if *path == original && reason.contains("注入的刷盘失败")),
            "{:?}",
            moved.follow_ups
        );
        assert_eq!(snapshot(&original), instance);
        assert_eq!(snapshot(&dest), instance);
        // 备份那边刷成了：原备份照常删掉。
        assert_eq!(snapshot(&dirs.backups_in(&dirs.target)), backups);
        assert!(!journal.old_backups().exists());
        assert_eq!(minutes(&dirs, &dirs.target).await, Some(60));
        assert_no_moving_dir(&dirs.target);
        dirs.petalfall()
            .confirm_instance_move(&moved.token)
            .await
            .unwrap();
        assert_eq!(journals(&dirs), [journal_file(&moved.token)]);
        let (newcomer, newcomer_backups) = build_newcomer(&dirs).await;

        let recovered = dirs.petalfall().recover_instance_moves().await.unwrap();

        assert_eq!(
            recovered,
            [MoveRecovery::Settled {
                id: ID.to_owned(),
                source_game_dir: dirs.source.clone(),
                target_game_dir: dirs.target.clone(),
            }]
        );
        assert!(!journal.old_dir.exists());
        assert_no_moving_dir(&dirs.source);
        assert!(journals(&dirs).is_empty());
        assert_eq!(snapshot(&dest), instance);
        assert_eq!(snapshot(&dirs.instance_in(&dirs.source)), newcomer);
        assert_eq!(snapshot(&dirs.backups_in(&dirs.source)), newcomer_backups);
        assert_eq!(minutes(&dirs, &dirs.source).await, Some(30));
        assert_eq!(minutes(&dirs, &dirs.target).await, Some(60));
    }

    /// 回滚时，要带的基底版本里只复制了 jar、还没有版本 JSON 的目录整个删掉、记录收回；JSON 已经落下的留着。
    #[tokio::test]
    async fn a_rollback_removes_bases_left_without_their_json() {
        const LANDED: &str = "1.20.1";
        let dirs = Dirs::new();
        build_instance(&dirs).await;
        let instance = snapshot(&dirs.instance_in(&dirs.source));
        let backups = snapshot(&dirs.backups_in(&dirs.source));
        put(
            &at(&dirs.target, &format!("versions/{BASE}/{BASE}.jar")),
            b"client-jar",
        );
        write_version(&dirs.target, LANDED, &vanilla_json(LANDED));
        record_base_versions_in(
            &dirs.target,
            &[BASE.to_owned(), LANDED.to_owned(), "别人的".to_owned()],
        )
        .await
        .unwrap();
        let mut journal = dirs.journal(false);
        journal.bases = vec![BASE.to_owned(), LANDED.to_owned()];
        move_journal::write(&dirs.data, &journal).await.unwrap();

        let recovered = dirs.petalfall().recover_instance_moves().await.unwrap();

        assert_eq!(recovered, [rolled_back(&dirs)]);
        assert!(!at(&dirs.target, &format!("versions/{BASE}")).exists());
        assert!(at(&dirs.target, &format!("versions/{LANDED}/{LANDED}.json")).is_file());
        assert_eq!(
            base_record(&dirs.target),
            Some(json!({"versions": [LANDED, "别人的"]}))
        );
        assert_untouched(&dirs, &instance, &backups).await;
    }

    /// 执行中复制基底版本的 JSON 时失败：只有 jar 的基底目录随回滚删掉，记录收回。
    #[tokio::test]
    async fn a_failed_base_copy_leaves_no_half_base_behind() {
        let dirs = Dirs::new();
        build_instance(&dirs).await;
        let instance = snapshot(&dirs.instance_in(&dirs.source));
        let backups = snapshot(&dirs.backups_in(&dirs.source));
        let base_json_temp = format!("{BASE}.json.");
        let env = with_fault(MoveEnv::default(), move |path| {
            if path.to_string_lossy().contains(&base_json_temp) {
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
            matches!(&err, CoreError::Base(petalfall_base::Error::Io { path, .. })
                if path.to_string_lossy().contains(&format!("{BASE}.json."))),
            "{err:?}"
        );
        assert!(!at(&dirs.target, &format!("versions/{BASE}")).exists());
        assert_eq!(base_record(&dirs.target), Some(json!({"versions": []})));
        assert_untouched(&dirs, &instance, &backups).await;
    }

    /// 推迟收尾期间在目标里玩过：收尾把原账的时长并进目标那本账，不盖掉在目标里新玩的。
    #[tokio::test]
    async fn time_played_in_the_target_before_a_deferred_finish_is_kept() {
        let dirs = Dirs::new();
        build_instance(&dirs).await;
        let mut journal = dirs.journal(true);
        journal.stage = MoveStage::Committed;
        rename(&dirs.backups_in(&dirs.source), &journal.old_backups());
        rename(
            &dirs.instance_in(&dirs.source),
            &dirs.instance_in(&dirs.target),
        );
        move_journal::write(&dirs.data, &journal).await.unwrap();
        let now = move_journal::now_millis().unwrap();
        crate::playtime::record_play(&dirs.data, &dirs.target, ID, now - HOUR / 2, now)
            .await
            .unwrap();

        let recovered = dirs.petalfall().recover_instance_moves().await.unwrap();

        assert_eq!(
            recovered,
            [MoveRecovery::Completed(outcome(&dirs, &journal.token))]
        );
        assert_eq!(minutes(&dirs, &dirs.target).await, Some(90));
        assert_eq!(minutes(&dirs, &dirs.source).await, None);
    }

    /// 游玩记录没迁上（记录文件读不懂）：记跟进项，日志停在已提交，确认了也留着；记录文件好了之后下次启动再迁，迁完
    /// 才算收拾完、删日志。
    #[tokio::test]
    async fn a_failed_play_record_move_stays_committed_and_is_retried() {
        let dirs = Dirs::new();
        build_instance(&dirs).await;
        let mut journal = dirs.journal(true);
        journal.stage = MoveStage::Committed;
        rename(&dirs.backups_in(&dirs.source), &journal.old_backups());
        rename(
            &dirs.instance_in(&dirs.source),
            &dirs.instance_in(&dirs.target),
        );
        move_journal::write(&dirs.data, &journal).await.unwrap();
        let book = dirs.data.join(crate::playtime::PLAYTIME_FILE);
        let good = std::fs::read(&book).unwrap();
        std::fs::write(&book, b"{ not json").unwrap();

        let recovered = dirs.petalfall().recover_instance_moves().await.unwrap();

        let [MoveRecovery::Completed(outcome)] = &recovered[..] else {
            panic!("{recovered:?}");
        };
        assert!(outcome.forget_source_refs);
        assert!(
            matches!(&outcome.follow_ups[..], [MoveFollowUp::PlayRecords(_)]),
            "{:?}",
            outcome.follow_ups
        );
        let left = move_journal::read(&dirs.data, &journal.token)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            (left.stage, left.records_moved),
            (MoveStage::Committed, false)
        );
        dirs.petalfall()
            .confirm_instance_move(&journal.token)
            .await
            .unwrap();
        assert_eq!(journals(&dirs), [journal_file(&journal.token)]);

        std::fs::write(&book, good).unwrap();
        let again = dirs.petalfall().recover_instance_moves().await.unwrap();

        assert_eq!(
            again,
            [MoveRecovery::Settled {
                id: ID.to_owned(),
                source_game_dir: dirs.source.clone(),
                target_game_dir: dirs.target.clone(),
            }]
        );
        assert!(journals(&dirs).is_empty());
        assert_eq!(minutes(&dirs, &dirs.target).await, Some(60));
        assert_eq!(minutes(&dirs, &dirs.source).await, None);
    }

    /// 目标那本账里有已经不在的同名实例留下的时长：提交前丢掉，移过去的实例只带着自己的时长。
    #[tokio::test]
    async fn stale_time_under_the_same_name_in_the_target_is_dropped_before_the_commit() {
        let dirs = Dirs::new();
        build_instance(&dirs).await;
        let now = move_journal::now_millis().unwrap();
        crate::playtime::record_play(&dirs.data, &dirs.target, ID, now - 4 * HOUR, now - 3 * HOUR)
            .await
            .unwrap();
        assert_eq!(minutes(&dirs, &dirs.target).await, Some(60));
        let ours = dirs.petalfall().play_summaries().await.unwrap()[ID].last_played_at;

        let moved = dirs
            .petalfall()
            .move_instance_files(&dirs.request(), None)
            .await
            .unwrap();

        assert_eq!(moved, outcome(&dirs, &moved.token));
        assert_eq!(minutes(&dirs, &dirs.target).await, Some(60));
        assert_eq!(minutes(&dirs, &dirs.source).await, None);
        // 留下的是移过去的那一局，不是旧的那一局（三小时前就结束了）。
        let summaries = dirs.facade(&dirs.target).play_summaries().await.unwrap();
        assert_eq!(summaries[ID].last_played_at, ours);
        assert_ne!(ours, now - 3 * HOUR);
    }

    /// 目标的依赖版本记录里留着同名的陈旧记录（那边以前有个同名的依赖版本）：收尾时去掉，否则移过去的实例会被当成
    /// 依赖版本藏起来。别的记录不动。
    #[tokio::test]
    async fn a_stale_base_record_under_the_same_name_in_the_target_is_dropped() {
        let dirs = Dirs::new();
        build_instance(&dirs).await;
        record_base_versions_in(&dirs.target, &[ID.to_owned(), "别人的".to_owned()])
            .await
            .unwrap();

        let moved = dirs
            .petalfall()
            .move_instance_files(&dirs.request(), None)
            .await
            .unwrap();

        assert_eq!(moved, outcome(&dirs, &moved.token));
        assert_eq!(
            base_record(&dirs.target),
            Some(json!({"versions": ["别人的", BASE]}))
        );
    }

    /// 执行完日志留着、挡住同一个实例再移，等调用方确认；没确认就退出的，启动收尾再交出 Completed；确认后日志删掉，
    /// 再收尾什么都没有。重复确认算成功，不像日志编号的确认报错。
    #[tokio::test]
    async fn the_journal_waits_for_the_callers_confirmation() {
        let dirs = Dirs::new();
        build_instance(&dirs).await;
        let elsewhere = dirs.tmp.path().join("别处").join(".minecraft");

        let moved = dirs
            .petalfall()
            .move_instance_files(&dirs.request(), None)
            .await
            .unwrap();

        assert_eq!(journals(&dirs), [journal_file(&moved.token)]);
        let from_target = dirs.facade(&dirs.target);
        let preview = from_target
            .preview_instance_move(ID, &elsewhere)
            .await
            .unwrap();
        assert_eq!(preview.blockers, [MoveBlocker::Pending]);

        let recovered = dirs.petalfall().recover_instance_moves().await.unwrap();
        assert_eq!(
            recovered,
            [MoveRecovery::Completed(outcome(&dirs, &moved.token))]
        );
        assert_eq!(minutes(&dirs, &dirs.target).await, Some(60));
        assert_eq!(journals(&dirs), [journal_file(&moved.token)]);

        dirs.petalfall()
            .confirm_instance_move(&moved.token)
            .await
            .unwrap();
        assert!(journals(&dirs).is_empty());
        assert!(
            dirs.petalfall()
                .recover_instance_moves()
                .await
                .unwrap()
                .is_empty()
        );
        let preview = from_target
            .preview_instance_move(ID, &elsewhere)
            .await
            .unwrap();
        assert!(preview.blockers.is_empty(), "{:?}", preview.blockers);
        dirs.petalfall()
            .confirm_instance_move(&moved.token)
            .await
            .unwrap();
        let err = dirs
            .petalfall()
            .confirm_instance_move(r"..\moves")
            .await
            .unwrap_err();
        assert!(
            matches!(&err, CoreError::Base(petalfall_base::Error::Io { source, .. })
                if source.kind() == std::io::ErrorKind::InvalidInput),
            "{err:?}"
        );
    }

    /// 暂存里的备份副本有并不过去的（清单外的文件）：原备份留在旧目录、记跟进项，日志停在已提交，确认了也留着。
    #[tokio::test]
    async fn backups_left_in_the_staging_keep_the_original_backups() {
        let dirs = Dirs::new();
        build_instance(&dirs).await;
        let backups = snapshot(&dirs.backups_in(&dirs.source));
        let mut journal = dirs.journal(false);
        journal.stage = MoveStage::Committed;
        journal.backups_staged = true;
        let staged_backups = journal.staged_backups().unwrap();
        copy_all(
            &dirs.instance_in(&dirs.source),
            &dirs.instance_in(&dirs.target),
        );
        write_version(&dirs.target, BASE, &base_json());
        copy_all(&dirs.backups_in(&dirs.source), &staged_backups);
        put(&staged_backups.join("w").join("stray.txt"), b"stray");
        rename(&dirs.instance_in(&dirs.source), &journal.old_instance());
        rename(&dirs.backups_in(&dirs.source), &journal.old_backups());
        // 目标里已有这个存档的备份目录：合并逐个挪 zip，清单外的文件挪不走。
        dirs.facade(&dirs.target)
            .backup_world(ID, "w", BackupKind::Manual, None)
            .await
            .unwrap();
        move_journal::write(&dirs.data, &journal).await.unwrap();

        let recovered = dirs.petalfall().recover_instance_moves().await.unwrap();

        let [MoveRecovery::Completed(outcome)] = &recovered[..] else {
            panic!("{recovered:?}");
        };
        assert!(
            matches!(&outcome.follow_ups[..], [MoveFollowUp::WorldBackups(reason)]
                if reason.contains(&staged_backups.display().to_string())
                    && reason.contains(&journal.old_backups().display().to_string())),
            "{:?}",
            outcome.follow_ups
        );
        assert_eq!(snapshot(&journal.old_backups()), backups);
        assert_eq!(
            snapshot(&staged_backups).into_keys().collect::<Vec<_>>(),
            ["w/", "w/stray.txt"]
        );
        // 原件那边照常收拾：目标在，旧目录里的原件删掉。
        assert!(!journal.old_instance().exists());
        let left = move_journal::read(&dirs.data, &journal.token)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            (left.stage, left.records_moved),
            (MoveStage::Committed, true)
        );
        dirs.petalfall()
            .confirm_instance_move(&journal.token)
            .await
            .unwrap();
        assert_eq!(journals(&dirs), [journal_file(&journal.token)]);
    }

    /// 跨卷提交到最后一步（暂存改名到目标）才失败：原备份与原件按相反的顺序改回原位，暂存与日志删掉。
    #[tokio::test]
    async fn a_cross_volume_commit_failing_at_the_last_rename_puts_both_back() {
        let dirs = Dirs::new();
        build_instance(&dirs).await;
        let instance = snapshot(&dirs.instance_in(&dirs.source));
        let backups = snapshot(&dirs.backups_in(&dirs.source));
        let squatter = dirs.instance_in(&dirs.target);
        let creator = squatter.clone();
        let env = with_fault(cross_volume(), move |path| {
            if in_staging(path) && path.ends_with("options.txt") {
                std::fs::create_dir_all(&creator)?;
            }
            Ok(())
        });

        let err = dirs
            .petalfall()
            .move_instance_files_with(&dirs.request(), None, &env)
            .await
            .unwrap_err();

        assert!(
            matches!(&err, CoreError::Base(petalfall_base::Error::Io { path, source })
                if *path == squatter && source.kind() == std::io::ErrorKind::AlreadyExists),
            "{err:?}"
        );
        assert_eq!(snapshot(&dirs.instance_in(&dirs.source)), instance);
        assert_eq!(snapshot(&dirs.backups_in(&dirs.source)), backups);
        assert!(squatter.is_dir() && snapshot(&squatter).is_empty());
        assert_no_moving_dir(&dirs.source);
        assert_no_moving_dir(&dirs.target);
        assert!(journals(&dirs).is_empty());
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
            target_root: true,
        };
        // 目标游戏目录本身不在：目标位置与暂存（在目标里）自然也不在。
        let no_target = |source, old| Disk {
            source,
            target: false,
            old,
            staged: false,
            target_root: false,
        };
        let only_staged = Verdict::Stuck("原位置和旧目录里都没有这个实例，只剩暂存里的副本");
        let target_gone = Verdict::Stuck("日志说已提交，可目标游戏目录已经不在了");
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
            // 两边都有：可能是改名后原目录里又建了同名新实例，回滚会把收起的备份交给它，不动。
            (
                Committing,
                true,
                disk(true, true, false, false),
                Verdict::Stuck("日志停在提交中，原位置和目标里都有这个实例"),
            ),
            (
                Committed,
                true,
                disk(false, true, false, false),
                Verdict::Finish,
            ),
            // 原目录里有了同名的新实例：目标里在就照常补完（收尾不碰原目录里按 id 的东西）；目标里不在，分不清是改名
            // 没落盘还是新实例，不动。
            (
                Committed,
                true,
                disk(true, true, false, false),
                Verdict::Finish,
            ),
            (
                Committed,
                true,
                disk(true, false, false, false),
                Verdict::Stuck("日志说已提交，可目标里没有这个实例，原位置却有"),
            ),
            (
                Settled,
                true,
                disk(true, false, false, false),
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
            // 复制阶段的暂存没校验过：目标里有东西也不往前补完。
            (
                Copying,
                false,
                disk(true, true, false, true),
                Verdict::Discard,
            ),
            (Copying, false, disk(false, true, false, true), only_staged),
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
            (
                Committed,
                false,
                disk(true, true, false, false),
                Verdict::Finish,
            ),
            // 已提交、目标里没有、暂存里还有：第二步改名没落盘，往前补完；原件在不在旧目录、原目录里有没有同名的新
            // 实例都一样。
            (
                Committed,
                false,
                disk(false, false, false, true),
                Verdict::RollForward,
            ),
            (
                Settled,
                false,
                disk(false, false, false, true),
                Verdict::RollForward,
            ),
            (
                Committed,
                false,
                disk(false, false, true, true),
                Verdict::RollForward,
            ),
            (
                Committed,
                false,
                disk(true, false, false, true),
                Verdict::RollForward,
            ),
            // 目标游戏目录整个不在：回滚照常，补完一律不做；只剩清理的照常清理。
            (Copying, false, no_target(true, false), Verdict::Discard),
            (
                Committing,
                false,
                no_target(false, true),
                Verdict::RenameBack,
            ),
            (Committing, true, no_target(true, false), Verdict::Discard),
            (Committed, true, no_target(false, false), target_gone),
            (Committed, false, no_target(false, false), target_gone),
            (Settled, true, no_target(false, false), Verdict::Finish),
            (Settled, false, no_target(false, false), Verdict::Finish),
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
