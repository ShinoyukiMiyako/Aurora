//! 存档备份的门面：备份、列出、恢复、删除、导出，退出游戏后的自动备份，以及实例改名时把备份带过去。
//!
//! 文件操作在 [`petalfall_instance::world_backup`]，这里负责按实例解析存档的作用域与路径、进程内互斥、
//! 进度事件与取消。快照之间共享两类锁，写法与下载引擎按目标路径加锁相同：按存档的备份目录加的锁在
//! 整个备份、恢复、导出、删除期间持有；备份根锁在清单读改写、清理与改名搬运期间持有，同时要两把时
//! 先存档锁后根锁。不隔离的实例共用同一份存档，两个实例同时操作它时就靠这两把锁排队。等锁期间响应取消。

use std::collections::{BTreeMap, HashSet};
use std::path::{Component, Path, PathBuf};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use petalfall_base::PathLocks;
use petalfall_download::CancellationToken;
use petalfall_instance::{
    BackupEntry, BackupKind, BackupLayout, Disposer, PackProgress, PackedWorld, RESTORE_SUFFIX,
    ResolvedIsolation, RetentionPolicy, WorldScope, commit_restore, is_backup_file_name,
    is_safe_instance_id, merge_scope_dir, pack_world, plan_prune, read_backup_index,
    remove_partial_backups, scan_backup_indices, scope_backup_indices, stage_restore, world_in_use,
    write_backup_index,
};
use tokio::sync::OwnedMutexGuard;

use crate::InstanceError;
use crate::config::WorldBackupSettings;
use crate::data_format::GuardMode;
use crate::error::{CoreError, Result};
use crate::event::{CoreEvent, DownloadProgress, EventSink, emit};
use crate::facade::Petalfall;

/// 字节进度事件的最小间隔，与下载进度的节流一致。
const PROGRESS_INTERVAL: Duration = Duration::from_millis(100);
const GIB: u64 = 1024 * 1024 * 1024;

/// 一份备份。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorldBackup {
    pub file: String,
    pub kind: BackupKind,
    /// Unix 毫秒。
    pub created_at: u64,
    pub size_bytes: u64,
    /// 备份时 level.dat 里的存档名。
    pub level_name: Option<String>,
}

impl From<BackupEntry> for WorldBackup {
    fn from(entry: BackupEntry) -> Self {
        Self {
            file: entry.file,
            kind: entry.kind,
            created_at: entry.created_at,
            size_bytes: entry.size_bytes,
            level_name: entry.level_name,
        }
    }
}

/// 一个存档的全部备份。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorldBackupList {
    pub world: String,
    pub scope: WorldScope,
    /// 这个存档的备份目录。
    pub dir: PathBuf,
    /// 按 `created_at` 倒序。
    pub backups: Vec<WorldBackup>,
    pub total_bytes: u64,
}

/// 一次备份的结果。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BackupOutcome {
    pub backup: WorldBackup,
    /// 这次顺带清理掉的旧备份份数。
    pub pruned: u32,
}

/// 一次恢复的结果。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RestoreOutcome {
    pub world: String,
    /// 原来的存档是否被移进了回收站（恢复前这个存档文件夹不在时为 `false`）。
    pub previous_in_recycle_bin: bool,
}

/// 一次导出的结果。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExportOutcome {
    pub path: PathBuf,
    pub size_bytes: u64,
}

/// 退出游戏后自动备份的结果。某个存档失败不影响其余存档。
#[derive(Debug, Default)]
pub struct AutoBackupOutcome {
    pub backed_up: Vec<String>,
    pub failed: Vec<(String, CoreError)>,
}

/// 存档在磁盘上的几处位置。
struct WorldPaths {
    scope: WorldScope,
    saves_dir: PathBuf,
    world_dir: PathBuf,
    backup_dir: PathBuf,
}

impl Petalfall {
    /// 存档的归属：实例隔离时是它自己的，否则是不隔离的实例共用的 `.minecraft/saves`。
    pub async fn world_scope(&self, id: &str) -> Result<WorldScope> {
        Ok(scope_of(id, &self.resolve_working_dir(id).await?))
    }

    /// 备份一个存档。存档文件夹不在报 [`CoreError::WorldNotFound`]，正被游戏打开报
    /// `Instance(WorldInUse)`。写进清单之后，自动备份开着时按保留策略清理旧备份，清理不掉（包括别的存档的清单
    /// 读不懂）只发一条告警，下次再试：这份备份已经成了，不能因为清理报失败。
    ///
    /// 动手之前先以「使用」方式核对当前游戏目录的数据格式记号：目录被更新的落樱用过、记号读不懂时报错，什么都不写。
    /// 任务重试、列实例被拒后还留着的旧列表都能不经列实例直接调到这里，所以不靠调用方先核对。退出游戏后的自动备份
    /// 也经这里，被拒时每个存档各记一条失败。
    pub async fn backup_world(
        &self,
        id: &str,
        world: &str,
        kind: BackupKind,
        events: Option<&EventSink>,
    ) -> Result<BackupOutcome> {
        self.guard_game_dir(GuardMode::Use).await?;
        let paths = self.world_paths(id, world).await?;
        ensure_world_exists(id, world, &paths.world_dir).await?;
        let _world = acquire(&WORLD_LOCKS, &paths.backup_dir, self.cancel_token()).await?;
        ensure_not_in_use(&paths.world_dir).await?;

        let root = self.backup_layout().root().to_path_buf();
        // 打包前先确认自己的清单读得懂：打完包才发现记不进清单，备份就成了没人认领的文件。
        read_backup_index(&paths.backup_dir).await?;
        let dir = paths.backup_dir.clone();
        blocking(move || remove_partial_backups(&dir)).await?;

        let index = read_backup_index(&paths.backup_dir).await?;
        let mut created_at = now_millis()?;
        let mut file = kind.file_name(created_at);
        while index.find(&file).is_some() || path_exists(&paths.backup_dir.join(&file)).await? {
            created_at += 1;
            file = kind.file_name(created_at);
        }
        let level_name = read_level_name(&paths.world_dir).await;
        emit(events, CoreEvent::stage(format!("正在打包「{world}」")));
        let zip = paths.backup_dir.join(&file);
        let packed = self.pack(&paths.world_dir, &zip, events).await?;
        let entry = BackupEntry {
            file,
            kind,
            created_at,
            size_bytes: packed.size_bytes,
            level_name,
        };

        let _root = acquire(&ROOT_LOCKS, &root, None).await?;
        let mut index = read_backup_index(&paths.backup_dir).await?;
        index.entries.push(entry.clone());
        if let Err(err) = write_backup_index(&paths.backup_dir, &index).await {
            // 记不进清单的 zip 列不出来也清理不到，删掉它，照实报错。
            if let Err(cleanup) = tokio::fs::remove_file(&zip).await {
                tracing::warn!(path = %zip.display(), error = %cleanup, "清单没写成，删除刚打好的备份也失败");
            }
            return Err(err.into());
        }
        // 保留策略只管自动备份：自动备份关着时设置页把两项保留设置一起禁用、写明不会清理，
        // 手动备份不能借机删掉玩家以前的自动备份。
        let pruned = if self.config().world_backup.auto {
            match self
                .prune(&root, Some((&paths.backup_dir, &entry.file)), events)
                .await
            {
                Ok(pruned) => pruned,
                Err(err) => {
                    tracing::error!(error = %err, "按保留策略清理旧的存档备份失败");
                    emit(
                        events,
                        CoreEvent::warning(format!(
                            "这次没能清理旧的自动备份，下次备份时再试：{err}"
                        )),
                    );
                    0
                }
            }
        } else {
            0
        };
        Ok(BackupOutcome {
            backup: entry.into(),
            pruned,
        })
    }

    /// 列出一个存档的备份，按时间倒序。存档文件夹已经不在了也照常列出。
    pub async fn list_world_backups(&self, id: &str, world: &str) -> Result<WorldBackupList> {
        let paths = self.world_paths(id, world).await?;
        let index = read_backup_index(&paths.backup_dir).await?;
        let mut backups: Vec<WorldBackup> = index.entries.into_iter().map(Into::into).collect();
        backups.sort_by(|a, b| {
            b.created_at
                .cmp(&a.created_at)
                .then_with(|| b.file.cmp(&a.file))
        });
        let total_bytes = backups.iter().map(|backup| backup.size_bytes).sum();
        Ok(WorldBackupList {
            world: world.to_owned(),
            scope: paths.scope,
            dir: paths.backup_dir,
            backups,
            total_bytes,
        })
    }

    /// 用一份备份替换现在的存档：先解到同级临时目录并确认 level.dat 可读，再把现在的存档交给 `disposer`
    /// （生产是回收站），最后把临时目录改名就位。`file` 必须是清单里登记过的名字，不在清单里或盘上已经
    /// 没有时报 [`CoreError::WorldBackupNotFound`]。任何一步失败，现在的存档都原样不动。
    ///
    /// 动手之前先核对当前游戏目录的数据格式记号，同 [`Petalfall::backup_world`]。
    pub async fn restore_world_backup(
        &self,
        id: &str,
        world: &str,
        file: &str,
        disposer: impl Disposer + 'static,
        events: Option<&EventSink>,
    ) -> Result<RestoreOutcome> {
        self.guard_game_dir(GuardMode::Use).await?;
        let paths = self.world_paths(id, world).await?;
        check_backup_file(file)?;
        let _world = acquire(&WORLD_LOCKS, &paths.backup_dir, self.cancel_token()).await?;
        let index = read_backup_index(&paths.backup_dir).await?;
        let zip = paths.backup_dir.join(file);
        if index.find(file).is_none() || !path_exists(&zip).await? {
            return Err(backup_not_found(id, world, file));
        }
        ensure_not_in_use(&paths.world_dir).await?;

        emit(events, CoreEvent::stage("正在校验备份"));
        let cancel = self.cancel_token().cloned();
        let mut reporter = Reporter::new(events).with_first_stage("正在解压备份");
        let (saves, name) = (paths.saves_dir.clone(), world.to_owned());
        let staged = blocking(move || {
            let is_cancelled = || cancel.as_ref().is_some_and(CancellationToken::is_cancelled);
            let staged = stage_restore(&zip, &saves, &name, &is_cancelled, &mut |p| {
                reporter.update(p)
            })?;
            reporter.finish();
            Ok(staged)
        })
        .await?;
        if self.is_cancelled() {
            // 解完了但还没动现在的存档：照样按取消处理，丢掉解好的副本。
            if let Err(err) = tokio::fs::remove_dir_all(&staged).await {
                tracing::warn!(path = %staged.display(), error = %err, "清理恢复用的临时目录失败");
            }
            return Err(InstanceError::Cancelled.into());
        }

        if path_exists(&paths.world_dir).await? {
            emit(events, CoreEvent::stage("正在把现在的存档移入回收站"));
        }
        let world_dir = paths.world_dir.clone();
        tracing::info!(id, world, file, "恢复存档备份");
        let previous = blocking(move || commit_restore(&staged, &world_dir, &disposer)).await?;
        Ok(RestoreOutcome {
            world: world.to_owned(),
            previous_in_recycle_bin: previous,
        })
    }

    /// 删除一份备份：zip 交给 `disposer`（生产是回收站，可以找回），再从清单里摘掉。清单里有、盘上已经
    /// 没有的只摘清单。不在清单里报 [`CoreError::WorldBackupNotFound`]。
    ///
    /// 删除不占实例，能和实例改名同时发生，而改名只持备份根锁。根锁要盖住从查清单到写回的全程：放在写回前才拿
    /// 的话，改名可以从中间插进来，写回时旧路径上的清单读出来是空的，又把搬走的目录在旧名下建了回去，新名下的
    /// 清单还留着已经删掉的那份。排在改名之后的删除查不到这份备份，按不在报错，不写任何东西。
    ///
    /// 动手之前先核对当前游戏目录的数据格式记号，同 [`Petalfall::backup_world`]。
    pub async fn delete_world_backup(
        &self,
        id: &str,
        world: &str,
        file: &str,
        disposer: impl Disposer + 'static,
    ) -> Result<()> {
        self.guard_game_dir(GuardMode::Use).await?;
        let paths = self.world_paths(id, world).await?;
        check_backup_file(file)?;
        let _world = acquire(&WORLD_LOCKS, &paths.backup_dir, self.cancel_token()).await?;
        let root = self.backup_layout().root().to_path_buf();
        let _root = acquire(&ROOT_LOCKS, &root, self.cancel_token()).await?;
        let mut index = read_backup_index(&paths.backup_dir).await?;
        if index.find(file).is_none() {
            return Err(backup_not_found(id, world, file));
        }
        let zip = paths.backup_dir.join(file);
        if path_exists(&zip).await? {
            tracing::info!(id, world, file, "删除存档备份：移入回收站");
            blocking(move || disposer.dispose(&zip)).await?;
        }
        index.entries.retain(|entry| entry.file != file);
        write_backup_index(&paths.backup_dir, &index).await?;
        Ok(())
    }

    /// 把存档打成 zip 导出到 `dest`，结构与备份相同，解压进 saves 就能直接用。`dest` 必须是绝对路径、扩展名
    /// 为 .zip、父目录存在，而且不能落在这个存档文件夹里面；已存在就覆盖（保存对话框已经确认过）。
    pub async fn export_world(
        &self,
        id: &str,
        world: &str,
        dest: &Path,
        events: Option<&EventSink>,
    ) -> Result<ExportOutcome> {
        let paths = self.world_paths(id, world).await?;
        check_export_dest(dest, &paths.world_dir).await?;
        ensure_world_exists(id, world, &paths.world_dir).await?;
        let _world = acquire(&WORLD_LOCKS, &paths.backup_dir, self.cancel_token()).await?;
        ensure_not_in_use(&paths.world_dir).await?;
        emit(events, CoreEvent::stage(format!("正在打包「{world}」")));
        let packed = self.pack(&paths.world_dir, dest, events).await?;
        Ok(ExportOutcome {
            path: dest.to_path_buf(),
            size_bytes: packed.size_bytes,
        })
    }

    /// 游戏退出后自动备份这次玩过的存档：只挑 level.dat 的修改时刻晚于 `session_started` 的。游戏载入存档、
    /// 自动保存与退出存档时都会重写 level.dat，进过的存档一定满足。自动备份关着时直接返回空结果，不碰盘。
    pub async fn auto_backup_after_session(
        &self,
        id: &str,
        session_started: SystemTime,
    ) -> Result<AutoBackupOutcome> {
        let mut outcome = AutoBackupOutcome::default();
        if !self.config().world_backup.auto {
            return Ok(outcome);
        }
        let saves = self
            .resolve_working_dir(id)
            .await?
            .working_dir
            .join("saves");
        for world in played_worlds(&saves, session_started).await? {
            let result = match &world {
                PlayedWorld::Named(name) => self
                    .backup_world(id, name, BackupKind::Auto, None)
                    .await
                    .map(drop),
                PlayedWorld::Unnamed(_) => Err(InstanceError::InvalidBackupArgument {
                    field: "world",
                    reason: "存档文件夹名不是合法的 Unicode，没法备份".to_owned(),
                }
                .into()),
            };
            let name = world.into_name();
            match result {
                Ok(()) => outcome.backed_up.push(name),
                Err(err) => outcome.failed.push((name, err)),
            }
        }
        Ok(outcome)
    }

    /// 实例改名后把 `instances/<old>` 下的备份并进 `instances/<new>`；旧目录不存在时什么都不做。
    ///
    /// 动手之前先核对当前游戏目录的数据格式记号，同 [`Petalfall::backup_world`]。
    pub async fn rename_world_backups(&self, old: &str, new: &str) -> Result<()> {
        self.guard_game_dir(GuardMode::Use).await?;
        let from = self.instance_backups_dir(old)?;
        let to = self.instance_backups_dir(new)?;
        let root = self.backup_layout().root().to_path_buf();
        let _root = acquire(&ROOT_LOCKS, &root, None).await?;
        merge_scope_dir(&from, &to).await?;
        Ok(())
    }

    /// 隔离实例名下全部备份的目录 `<游戏目录>/.petalfall/backups/instances/<id>`（不检查是否存在）。
    pub fn instance_backups_dir(&self, id: &str) -> Result<PathBuf> {
        self.instance_dir(id)?;
        Ok(self.backup_layout().instance_dir(id))
    }

    /// 隔离实例名下的备份份数（各存档清单的条目数之和）。
    pub(crate) async fn instance_backup_count(&self, id: &str) -> Result<u32> {
        let dir = self.instance_backups_dir(id)?;
        let indices = scope_backup_indices(&dir).await?;
        Ok(indices
            .iter()
            .map(|(_, index)| index.entries.len() as u32)
            .sum())
    }

    /// 设置存档备份；落盘仍需调用 [`Petalfall::save_config`]。取值范围由调用方校验。
    pub fn set_world_backup(&mut self, settings: WorldBackupSettings) {
        self.config_mut().world_backup = settings;
    }

    /// 当前游戏目录的备份根 `<游戏目录>/.petalfall/backups`（不检查是否存在）。外壳据此判断一个路径是不是
    /// 启动器自己的备份区里的。
    pub fn world_backups_root(&self) -> PathBuf {
        self.backup_layout().root().to_path_buf()
    }

    fn backup_layout(&self) -> BackupLayout {
        BackupLayout::new(self.game_dir())
    }

    async fn world_paths(&self, id: &str, world: &str) -> Result<WorldPaths> {
        if !is_safe_instance_id(world) {
            return Err(InstanceError::InvalidBackupArgument {
                field: "world",
                reason: format!("存档文件夹名不合法：{world:?}"),
            }
            .into());
        }
        let resolved = self.resolve_working_dir(id).await?;
        let scope = scope_of(id, &resolved);
        let saves_dir = resolved.working_dir.join("saves");
        Ok(WorldPaths {
            world_dir: saves_dir.join(world),
            backup_dir: self.backup_layout().world_dir(&scope, world),
            saves_dir,
            scope,
        })
    }

    /// 在阻塞线程池里打包，进度节流成下载事件。
    async fn pack(
        &self,
        world_dir: &Path,
        dest: &Path,
        events: Option<&EventSink>,
    ) -> Result<PackedWorld> {
        let (world_dir, dest) = (world_dir.to_path_buf(), dest.to_path_buf());
        let cancel = self.cancel_token().cloned();
        let mut reporter = Reporter::new(events);
        blocking(move || {
            let is_cancelled = || cancel.as_ref().is_some_and(CancellationToken::is_cancelled);
            let packed = pack_world(&world_dir, &dest, &is_cancelled, &mut |p| {
                reporter.update(p)
            })?;
            reporter.finish();
            Ok(packed)
        })
        .await
    }

    /// 按保留策略清理，返回清理掉的份数。调用方持有备份根锁。删不掉的文件留在清单里，记日志并发告警。
    async fn prune(
        &self,
        root: &Path,
        keep: Option<(&Path, &str)>,
        events: Option<&EventSink>,
    ) -> Result<u32> {
        let indices = scan_backup_indices(root).await?;
        let doomed = plan_prune(&indices, retention(self.config().world_backup), keep);
        let mut by_dir: BTreeMap<PathBuf, Vec<String>> = BTreeMap::new();
        for (dir, file) in doomed {
            by_dir.entry(dir).or_default().push(file);
        }
        let mut pruned = 0u32;
        let mut stuck = 0usize;
        for (dir, files) in by_dir {
            let mut removed = HashSet::new();
            for file in files {
                let path = dir.join(&file);
                match tokio::fs::remove_file(&path).await {
                    Ok(()) => {
                        removed.insert(file);
                    }
                    Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
                        removed.insert(file);
                    }
                    Err(err) => {
                        tracing::error!(path = %path.display(), error = %err, "清理旧的存档备份失败");
                        stuck += 1;
                    }
                }
            }
            if removed.is_empty() {
                continue;
            }
            let mut index = indices
                .iter()
                .find(|(d, _)| *d == dir)
                .map(|(_, index)| index.clone())
                .expect("清理清单里的目录来自同一次扫描");
            index.entries.retain(|entry| !removed.contains(&entry.file));
            write_backup_index(&dir, &index).await?;
            pruned += removed.len() as u32;
        }
        if stuck > 0 {
            emit(
                events,
                CoreEvent::warning(format!("有 {stuck} 份旧的自动备份没能清理，下次备份时再试")),
            );
        }
        Ok(pruned)
    }
}

/// 隔离实例在某个游戏目录下全部备份的目录 `<game_dir>/.petalfall/backups/instances/<id>`（不检查是否存在）。
/// `id` 由调用方先过 [`is_safe_instance_id`]。
pub(crate) fn instance_backups_dir_in(game_dir: &Path, id: &str) -> PathBuf {
    BackupLayout::new(game_dir).instance_dir(id)
}

/// 实例移动：把按 token 收着的备份 `staged`（形状同 `instances/<id>`；跨卷是目标盘暂存里的副本，同卷是原游戏目录
/// 旧目录里的原备份）并进 `to_game_dir` 下 `instances/<id>`，合并规则同改名，占着目标备份根的锁。`staged` 不存在
/// 时什么都不做。
pub(crate) async fn merge_staged_backups(
    staged: &Path,
    to_game_dir: &Path,
    id: &str,
) -> Result<()> {
    check_instance_id(id)?;
    let root = BackupLayout::new(to_game_dir).root().to_path_buf();
    let _root = acquire(&ROOT_LOCKS, &root, None).await?;
    merge_scope_dir(staged, &instance_backups_dir_in(to_game_dir, id)).await?;
    Ok(())
}

fn check_instance_id(id: &str) -> Result<()> {
    if is_safe_instance_id(id) {
        Ok(())
    } else {
        Err(InstanceError::InvalidId { id: id.to_owned() }.into())
    }
}

fn scope_of(id: &str, resolved: &ResolvedIsolation) -> WorldScope {
    if resolved.isolated {
        WorldScope::Instance(id.to_owned())
    } else {
        WorldScope::Shared
    }
}

/// 配置里的保留策略换算成字节。
fn retention(settings: WorldBackupSettings) -> RetentionPolicy {
    RetentionPolicy {
        keep_per_world: settings.keep_per_world,
        max_total_bytes: u64::from(settings.max_total_gb) * GIB,
    }
}

fn backup_not_found(id: &str, world: &str, file: &str) -> CoreError {
    CoreError::WorldBackupNotFound {
        version_id: id.to_owned(),
        world: world.to_owned(),
        file: file.to_owned(),
    }
}

fn check_backup_file(file: &str) -> Result<()> {
    if is_backup_file_name(file) {
        Ok(())
    } else {
        Err(InstanceError::InvalidBackupArgument {
            field: "file",
            reason: format!("备份文件名不合法：{file:?}"),
        }
        .into())
    }
}

async fn check_export_dest(dest: &Path, world_dir: &Path) -> Result<()> {
    let invalid = |reason: &str| -> CoreError {
        InstanceError::InvalidBackupArgument {
            field: "dest",
            reason: reason.to_owned(),
        }
        .into()
    };
    if !dest.is_absolute() {
        return Err(invalid("导出位置要是完整的路径"));
    }
    if dest
        .components()
        .any(|c| matches!(c, Component::ParentDir | Component::CurDir))
    {
        return Err(invalid("导出位置里不能有 . 或 .."));
    }
    if !dest
        .extension()
        .is_some_and(|ext| ext.eq_ignore_ascii_case("zip"))
    {
        return Err(invalid("导出的文件要以 .zip 结尾"));
    }
    let parent_ok = match dest.parent() {
        Some(parent) => is_dir(parent).await?,
        None => false,
    };
    if !parent_ok {
        return Err(invalid("导出位置所在的文件夹不存在"));
    }
    if is_within(dest, world_dir) {
        return Err(invalid("不能导出到这个存档自己的文件夹里"));
    }
    Ok(())
}

/// `path` 是否在 `dir` 里面（按路径段比较，不分大小写：Windows 的路径不分大小写）。
fn is_within(path: &Path, dir: &Path) -> bool {
    let fold = |p: &Path| -> Vec<String> {
        p.components()
            .map(|c| c.as_os_str().to_string_lossy().to_lowercase())
            .collect()
    };
    let (path, dir) = (fold(path), fold(dir));
    path.len() > dir.len() && path.starts_with(&dir)
}

async fn ensure_world_exists(id: &str, world: &str, world_dir: &Path) -> Result<()> {
    if is_dir(world_dir).await? {
        Ok(())
    } else {
        Err(CoreError::WorldNotFound {
            version_id: id.to_owned(),
            world: world.to_owned(),
        })
    }
}

async fn ensure_not_in_use(world_dir: &Path) -> Result<()> {
    let dir = world_dir.to_path_buf();
    if blocking(move || world_in_use(&dir)).await? {
        return Err(InstanceError::WorldInUse {
            path: world_dir.to_path_buf(),
        }
        .into());
    }
    Ok(())
}

/// 备份时 level.dat 里的存档名；没有 level.dat 或读不懂时为 `None`，那份存档照样能备份（打包的是文件夹）。
async fn read_level_name(world_dir: &Path) -> Option<String> {
    let bytes = tokio::fs::read(world_dir.join("level.dat")).await.ok()?;
    parse_level_name(&bytes)
}

fn parse_level_name(bytes: &[u8]) -> Option<String> {
    petalfall_instance::level::parse_level_dat(bytes).ok()?.name
}

/// 这次会话里玩过的存档文件夹，按名排序。
enum PlayedWorld {
    Named(String),
    /// 文件夹名不是合法的 Unicode，只能给出近似的名字。
    Unnamed(String),
}

impl PlayedWorld {
    fn into_name(self) -> String {
        match self {
            PlayedWorld::Named(name) | PlayedWorld::Unnamed(name) => name,
        }
    }
}

async fn played_worlds(saves: &Path, since: SystemTime) -> Result<Vec<PlayedWorld>> {
    let io = |path: &Path, source| -> CoreError {
        petalfall_base::Error::Io {
            path: path.to_path_buf(),
            source,
        }
        .into()
    };
    let mut read = match tokio::fs::read_dir(saves).await {
        Ok(read) => read,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(source) => return Err(io(saves, source)),
    };
    let mut worlds = Vec::new();
    while let Some(entry) = read.next_entry().await.map_err(|e| io(saves, e))? {
        if !entry.file_type().await.map_err(|e| io(saves, e))?.is_dir() {
            continue;
        }
        let raw = entry.file_name();
        let lossy = raw.to_string_lossy().into_owned();
        // 恢复中途留下的临时目录不是存档。
        if lossy.ends_with(RESTORE_SUFFIX) {
            continue;
        }
        let level = entry.path().join("level.dat");
        let modified = match tokio::fs::metadata(&level).await {
            Ok(meta) => meta.modified().map_err(|e| io(&level, e))?,
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => continue,
            Err(source) => return Err(io(&level, source)),
        };
        if modified > since {
            worlds.push(match raw.into_string() {
                Ok(name) => PlayedWorld::Named(name),
                Err(_) => PlayedWorld::Unnamed(lossy),
            });
        }
    }
    worlds.sort_by(|a, b| a.name().cmp(b.name()));
    Ok(worlds)
}

impl PlayedWorld {
    fn name(&self) -> &str {
        match self {
            PlayedWorld::Named(name) | PlayedWorld::Unnamed(name) => name,
        }
    }
}

fn now_millis() -> Result<u64> {
    Ok(SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(CoreError::SystemClock)?
        .as_millis() as u64)
}

async fn path_exists(path: &Path) -> Result<bool> {
    match tokio::fs::symlink_metadata(path).await {
        Ok(_) => Ok(true),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(source) => Err(petalfall_base::Error::Io {
            path: path.to_path_buf(),
            source,
        }
        .into()),
    }
}

async fn is_dir(path: &Path) -> Result<bool> {
    match tokio::fs::metadata(path).await {
        Ok(meta) => Ok(meta.is_dir()),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(source) => Err(petalfall_base::Error::Io {
            path: path.to_path_buf(),
            source,
        }
        .into()),
    }
}

async fn blocking<T: Send + 'static>(
    work: impl FnOnce() -> petalfall_instance::Result<T> + Send + 'static,
) -> Result<T> {
    Ok(tokio::task::spawn_blocking(work).await??)
}

// ---- 进程内互斥 ----

/// 按存档备份目录加的锁。
static WORLD_LOCKS: PathLocks = PathLocks::new();
/// 按备份根加的锁：清单读改写与清理。
static ROOT_LOCKS: PathLocks = PathLocks::new();

/// 占住 `path` 对应的锁。等锁期间响应取消，令牌已触发时不再去拿锁。
async fn acquire(
    table: &PathLocks,
    path: &Path,
    cancel: Option<&CancellationToken>,
) -> Result<OwnedMutexGuard<()>> {
    let slot = table.slot(path);
    match cancel {
        Some(token) if token.is_cancelled() => Err(InstanceError::Cancelled.into()),
        Some(token) => token
            .run_until_cancelled(slot.lock_owned())
            .await
            .ok_or_else(|| InstanceError::Cancelled.into()),
        None => Ok(slot.lock_owned().await),
    }
}

// ---- 进度 ----

/// 把打包、解压的进度节流成下载事件：两条之间至少隔 100 ms，最后一条必发；速度按从开始算起的平均值。
struct Reporter {
    sink: Option<EventSink>,
    started: Instant,
    last_sent: Option<Instant>,
    latest: Option<PackProgress>,
    unsent: bool,
    /// 第一次收到进度时先发的阶段：解压在校验通过后才开始报进度。
    first_stage: Option<&'static str>,
}

impl Reporter {
    fn new(sink: Option<&EventSink>) -> Self {
        Self {
            sink: sink.cloned(),
            started: Instant::now(),
            last_sent: None,
            latest: None,
            unsent: false,
            first_stage: None,
        }
    }

    fn with_first_stage(mut self, stage: &'static str) -> Self {
        self.first_stage = Some(stage);
        self
    }

    fn update(&mut self, progress: PackProgress) {
        if let Some(stage) = self.first_stage.take() {
            emit(self.sink.as_ref(), CoreEvent::stage(stage));
        }
        self.latest = Some(progress);
        self.unsent = true;
        let now = Instant::now();
        if self
            .last_sent
            .is_none_or(|sent| now.duration_since(sent) >= PROGRESS_INTERVAL)
        {
            self.send(now);
        }
    }

    fn finish(&mut self) {
        if self.unsent {
            self.send(Instant::now());
        }
    }

    fn send(&mut self, now: Instant) {
        let Some(progress) = self.latest else {
            return;
        };
        self.last_sent = Some(now);
        self.unsent = false;
        let elapsed_ms = now.duration_since(self.started).as_millis() as u64;
        let speed = match elapsed_ms {
            0 => 0,
            ms => progress.bytes_done.saturating_mul(1000) / ms,
        };
        emit(
            self.sink.as_ref(),
            CoreEvent::Download(DownloadProgress {
                total: progress.files_total,
                finished: progress.files_done,
                bytes: progress.bytes_done,
                total_bytes: Some(progress.bytes_total),
                transferred: 0,
                speed,
            }),
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::instances::tests::{petalfall_at, vanilla_json, write_version};
    use std::io::Write;
    use std::sync::{Arc, Mutex};

    /// 一份最小的 level.dat：根复合标签里的 `Data.LevelName`，gzip 压缩。
    fn level_dat(name: &str) -> Vec<u8> {
        let mut raw = vec![10, 0, 0, 10];
        raw.extend(4u16.to_be_bytes());
        raw.extend(b"Data");
        raw.push(8);
        raw.extend(9u16.to_be_bytes());
        raw.extend(b"LevelName");
        raw.extend((name.len() as u16).to_be_bytes());
        raw.extend(name.as_bytes());
        raw.extend([0, 0]);
        let mut gz = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
        gz.write_all(&raw).unwrap();
        gz.finish().unwrap()
    }

    fn write(path: &Path, bytes: &[u8]) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, bytes).unwrap();
    }

    /// 隔离的实例（快照版默认隔离），返回它的 saves 目录。
    fn isolated(petalfall: &Petalfall, id: &str) -> PathBuf {
        let dir = write_version(
            petalfall.game_dir(),
            id,
            &format!(r#"{{"id":"{id}","type":"snapshot","mainClass":"m"}}"#),
        );
        dir.join("saves")
    }

    /// 不隔离的原版正式版实例，返回共用的 saves 目录。
    fn shared(petalfall: &Petalfall, id: &str) -> PathBuf {
        write_version(petalfall.game_dir(), id, &vanilla_json(id));
        petalfall.game_dir().join("saves")
    }

    fn world(saves: &Path, name: &str, level_name: &str) -> PathBuf {
        let dir = saves.join(name);
        write(&dir.join("level.dat"), &level_dat(level_name));
        write(&dir.join("region").join("r.0.0.mca"), b"region-bytes");
        write(&dir.join("session.lock"), "\u{2603}".as_bytes());
        dir
    }

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

    fn zip_names(zip: &Path) -> Vec<String> {
        let mut archive = zip::ZipArchive::new(std::fs::File::open(zip).unwrap()).unwrap();
        let mut names: Vec<String> = (0..archive.len())
            .map(|i| archive.by_index(i).unwrap().name().to_owned())
            .collect();
        names.sort();
        names
    }

    fn backups_root(petalfall: &Petalfall) -> PathBuf {
        petalfall
            .game_dir()
            .join(petalfall_instance::PETALFALL_META_DIR)
            .join("backups")
    }

    fn zips_in(dir: &Path) -> Vec<String> {
        let mut names: Vec<String> = std::fs::read_dir(dir)
            .unwrap()
            .map(|e| e.unwrap().file_name().into_string().unwrap())
            .filter(|name| name.ends_with(".zip"))
            .collect();
        names.sort();
        names
    }

    /// 记下处置的路径并把它挪进 `trash`（测试里不往开发者的回收站里塞东西）。
    #[derive(Clone)]
    struct RecordingDisposer {
        trash: PathBuf,
        seen: Arc<Mutex<Vec<PathBuf>>>,
    }

    impl RecordingDisposer {
        fn new(trash: PathBuf) -> Self {
            std::fs::create_dir_all(&trash).unwrap();
            Self {
                trash,
                seen: Arc::default(),
            }
        }
        fn seen(&self) -> Vec<PathBuf> {
            self.seen.lock().unwrap().clone()
        }
    }

    impl Disposer for RecordingDisposer {
        fn dispose(&self, path: &Path) -> petalfall_instance::Result<()> {
            self.seen.lock().unwrap().push(path.to_path_buf());
            std::fs::rename(path, self.trash.join(path.file_name().unwrap())).unwrap();
            Ok(())
        }
    }

    fn drain(rx: &mut tokio::sync::mpsc::UnboundedReceiver<CoreEvent>) -> Vec<CoreEvent> {
        let mut events = Vec::new();
        while let Ok(event) = rx.try_recv() {
            events.push(event);
        }
        events
    }

    fn stages(events: &[CoreEvent]) -> Vec<&str> {
        events
            .iter()
            .filter_map(|e| match e {
                CoreEvent::Stage(s) => Some(s.as_str()),
                _ => None,
            })
            .collect()
    }

    fn last_download(events: &[CoreEvent]) -> DownloadProgress {
        events
            .iter()
            .rev()
            .find_map(|e| match e {
                CoreEvent::Download(p) => Some(*p),
                _ => None,
            })
            .expect("至少应有一条字节进度")
    }

    #[tokio::test]
    async fn backup_of_an_isolated_world_is_packed_indexed_and_reported() {
        let tmp = tempfile::tempdir().unwrap();
        let petalfall = petalfall_at(tmp.path());
        let saves = isolated(&petalfall, "生存");
        world(&saves, "新的世界", "周末生存");
        assert_eq!(
            petalfall.world_scope("生存").await.unwrap(),
            WorldScope::Instance("生存".into())
        );

        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
        let outcome = petalfall
            .backup_world("生存", "新的世界", BackupKind::Manual, Some(&tx))
            .await
            .unwrap();
        let dir = backups_root(&petalfall)
            .join("instances")
            .join("生存")
            .join("新的世界");
        let backup = &outcome.backup;
        assert_eq!(backup.kind, BackupKind::Manual);
        assert_eq!(backup.file, format!("{}-manual.zip", backup.created_at));
        assert_eq!(backup.level_name.as_deref(), Some("周末生存"));
        assert_eq!(
            backup.size_bytes,
            std::fs::metadata(dir.join(&backup.file)).unwrap().len()
        );
        assert_eq!(outcome.pruned, 0);
        assert_eq!(
            zip_names(&dir.join(&backup.file)),
            vec![
                "新的世界/",
                "新的世界/level.dat",
                "新的世界/region/",
                "新的世界/region/r.0.0.mca",
            ]
        );
        let index = read_backup_index(&dir).await.unwrap();
        assert_eq!(index.entries.len(), 1);
        assert_eq!(WorldBackup::from(index.entries[0].clone()), *backup);

        let events = drain(&mut rx);
        assert_eq!(stages(&events), vec!["正在打包「新的世界」"]);
        let last = last_download(&events);
        let level_len = level_dat("周末生存").len() as u64;
        assert_eq!((last.total, last.finished), (2, 2));
        assert_eq!(last.bytes, level_len + 12);
        assert_eq!(last.transferred, 0, "备份只碰本机文件，没有网络传输");
        assert_eq!(last.total_bytes, Some(level_len + 12));
    }

    #[tokio::test]
    async fn worlds_of_unisolated_instances_share_one_scope() {
        let tmp = tempfile::tempdir().unwrap();
        let petalfall = petalfall_at(tmp.path());
        let saves = shared(&petalfall, "1.21.1");
        shared(&petalfall, "1.20.1");
        world(&saves, "共用", "共用");
        assert_eq!(
            petalfall.world_scope("1.21.1").await.unwrap(),
            WorldScope::Shared
        );
        petalfall
            .backup_world("1.21.1", "共用", BackupKind::Manual, None)
            .await
            .unwrap();
        // 另一个不隔离的实例看到的是同一份备份。
        let list = petalfall
            .list_world_backups("1.20.1", "共用")
            .await
            .unwrap();
        assert_eq!(list.scope, WorldScope::Shared);
        assert_eq!(
            list.dir,
            backups_root(&petalfall).join("shared").join("共用")
        );
        assert_eq!(list.backups.len(), 1);
    }

    #[tokio::test]
    async fn unsafe_or_missing_worlds_are_refused() {
        let tmp = tempfile::tempdir().unwrap();
        let petalfall = petalfall_at(tmp.path());
        isolated(&petalfall, "a");
        for bad in ["..", "a/b", "", ".hidden", "C:x"] {
            let err = petalfall
                .backup_world("a", bad, BackupKind::Manual, None)
                .await
                .unwrap_err();
            assert!(
                matches!(
                    err,
                    CoreError::Instance(InstanceError::InvalidBackupArgument {
                        field: "world",
                        ..
                    })
                ),
                "{bad:?}: {err:?}"
            );
        }
        let err = petalfall
            .backup_world("a", "不存在", BackupKind::Manual, None)
            .await
            .unwrap_err();
        assert!(
            matches!(&err, CoreError::WorldNotFound { version_id, world } if version_id == "a" && world == "不存在"),
            "{err:?}"
        );
        assert!(!backups_root(&petalfall).exists(), "参数不对时不碰盘");
    }

    #[tokio::test]
    async fn sixth_auto_backup_evicts_the_oldest_auto_and_manuals_stay() {
        let tmp = tempfile::tempdir().unwrap();
        let mut petalfall = petalfall_at(tmp.path());
        let saves = isolated(&petalfall, "a");
        world(&saves, "w", "w");
        let backup = |petalfall: Petalfall, kind| async move {
            petalfall.backup_world("a", "w", kind, None).await.unwrap()
        };
        let manual = backup(petalfall.clone(), BackupKind::Manual).await;
        let mut autos = Vec::new();
        for _ in 0..5 {
            let outcome = backup(petalfall.clone(), BackupKind::Auto).await;
            assert_eq!(outcome.pruned, 0);
            autos.push(outcome.backup.file);
        }
        let manual2 = backup(petalfall.clone(), BackupKind::Manual).await;
        let sixth = backup(petalfall.clone(), BackupKind::Auto).await;
        assert_eq!(sixth.pruned, 1);

        let dir = backups_root(&petalfall)
            .join("instances")
            .join("a")
            .join("w");
        let mut expected: Vec<String> = autos[1..].to_vec();
        expected.extend([
            manual.backup.file.clone(),
            manual2.backup.file.clone(),
            sixth.backup.file.clone(),
        ]);
        expected.sort();
        assert_eq!(
            zips_in(&dir),
            expected,
            "最旧的自动备份 {} 应被删",
            autos[0]
        );
        let index = read_backup_index(&dir).await.unwrap();
        assert_eq!(index.entries.len(), 7);
        assert!(index.find(&autos[0]).is_none());
        let kinds = |kind| index.entries.iter().filter(|e| e.kind == kind).count();
        assert_eq!((kinds(BackupKind::Auto), kinds(BackupKind::Manual)), (5, 2));

        // 每个存档只留 1 份：一次清掉 5 份旧的自动备份，手动备份一份不少。
        petalfall.set_world_backup(WorldBackupSettings {
            auto: true,
            keep_per_world: 1,
            max_total_gb: 20,
        });
        let last = backup(petalfall.clone(), BackupKind::Auto).await;
        assert_eq!(last.pruned, 5);
        let mut left = vec![
            manual.backup.file,
            manual2.backup.file,
            last.backup.file.clone(),
        ];
        left.sort();
        assert_eq!(zips_in(&dir), left);
    }

    #[test]
    fn total_cap_is_converted_from_gigabytes() {
        let policy = |gb| {
            retention(WorldBackupSettings {
                auto: true,
                keep_per_world: 3,
                max_total_gb: gb,
            })
        };
        assert_eq!(
            policy(1),
            RetentionPolicy {
                keep_per_world: 3,
                max_total_bytes: 1_073_741_824,
            }
        );
        assert_eq!(policy(1000).max_total_bytes, 1000 * 1_073_741_824);
        assert_eq!(
            retention(WorldBackupSettings::default()).max_total_bytes,
            20 * GIB
        );
    }

    #[tokio::test]
    async fn list_is_newest_first_and_survives_the_world_folder() {
        let tmp = tempfile::tempdir().unwrap();
        let petalfall = petalfall_at(tmp.path());
        let saves = isolated(&petalfall, "a");
        let dir = world(&saves, "w", "w");
        let first = petalfall
            .backup_world("a", "w", BackupKind::Auto, None)
            .await
            .unwrap();
        let second = petalfall
            .backup_world("a", "w", BackupKind::Manual, None)
            .await
            .unwrap();
        std::fs::remove_dir_all(&dir).unwrap();

        let list = petalfall.list_world_backups("a", "w").await.unwrap();
        assert_eq!(list.world, "w");
        assert_eq!(
            list.backups,
            vec![second.backup.clone(), first.backup.clone()]
        );
        assert_eq!(
            list.total_bytes,
            first.backup.size_bytes + second.backup.size_bytes
        );
        assert!(
            petalfall
                .list_world_backups("a", "从没备份过")
                .await
                .unwrap()
                .backups
                .is_empty()
        );
    }

    #[tokio::test]
    async fn restore_brings_the_backup_back_and_recycles_the_current_world() {
        let tmp = tempfile::tempdir().unwrap();
        let petalfall = petalfall_at(tmp.path());
        let saves = isolated(&petalfall, "a");
        let dir = world(&saves, "w", "备份时");
        let mut at_backup = snapshot(&dir);
        at_backup.remove("session.lock");
        let backup = petalfall
            .backup_world("a", "w", BackupKind::Manual, None)
            .await
            .unwrap()
            .backup;

        // 之后又玩了一阵：区域文件变了，多了一个文件。
        write(&dir.join("region").join("r.0.0.mca"), b"changed");
        write(&dir.join("region").join("r.1.0.mca"), b"new");
        write(&dir.join("level.dat"), &level_dat("现在的"));
        let current = snapshot(&dir);

        let disposer = RecordingDisposer::new(tmp.path().join("trash"));
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
        let outcome = petalfall
            .restore_world_backup("a", "w", &backup.file, disposer.clone(), Some(&tx))
            .await
            .unwrap();
        assert_eq!(
            outcome,
            RestoreOutcome {
                world: "w".into(),
                previous_in_recycle_bin: true,
            }
        );
        assert_eq!(disposer.seen(), vec![dir.clone()]);
        assert_eq!(snapshot(&dir), at_backup);
        assert_eq!(snapshot(&tmp.path().join("trash").join("w")), current);
        assert_eq!(
            parse_level_name(&std::fs::read(dir.join("level.dat")).unwrap()).as_deref(),
            Some("备份时")
        );
        assert!(!saves.join(format!("w{RESTORE_SUFFIX}")).exists());
        let events = drain(&mut rx);
        assert_eq!(
            stages(&events),
            vec!["正在校验备份", "正在解压备份", "正在把现在的存档移入回收站"]
        );
        let last = last_download(&events);
        assert_eq!((last.total, last.finished), (2, 2));
    }

    #[tokio::test]
    async fn restoring_an_unknown_or_vanished_backup_is_not_found() {
        let tmp = tempfile::tempdir().unwrap();
        let petalfall = petalfall_at(tmp.path());
        let saves = isolated(&petalfall, "a");
        let dir = world(&saves, "w", "w");
        let before = snapshot(&dir);
        let disposer = RecordingDisposer::new(tmp.path().join("trash"));
        let err = petalfall
            .restore_world_backup("a", "w", "1-auto.zip", disposer.clone(), None)
            .await
            .unwrap_err();
        assert!(
            matches!(&err, CoreError::WorldBackupNotFound { version_id, world, file }
                if version_id == "a" && world == "w" && file == "1-auto.zip"),
            "{err:?}"
        );

        let backup = petalfall
            .backup_world("a", "w", BackupKind::Auto, None)
            .await
            .unwrap()
            .backup;
        let zip = backups_root(&petalfall)
            .join("instances")
            .join("a")
            .join("w")
            .join(&backup.file);
        std::fs::remove_file(&zip).unwrap();
        let err = petalfall
            .restore_world_backup("a", "w", &backup.file, disposer.clone(), None)
            .await
            .unwrap_err();
        assert!(
            matches!(err, CoreError::WorldBackupNotFound { .. }),
            "{err:?}"
        );

        // 文件名本身不安全的直接按参数错误拒绝。
        let err = petalfall
            .restore_world_backup("a", "w", "../../x.zip", disposer.clone(), None)
            .await
            .unwrap_err();
        assert!(
            matches!(
                err,
                CoreError::Instance(InstanceError::InvalidBackupArgument { field: "file", .. })
            ),
            "{err:?}"
        );
        assert!(disposer.seen().is_empty());
        assert_eq!(snapshot(&dir), before);
    }

    #[tokio::test]
    async fn tampered_backup_with_parent_traversal_leaves_the_world_byte_for_byte() {
        let tmp = tempfile::tempdir().unwrap();
        let petalfall = petalfall_at(tmp.path());
        let saves = isolated(&petalfall, "a");
        let dir = world(&saves, "w", "w");
        let backup = petalfall
            .backup_world("a", "w", BackupKind::Auto, None)
            .await
            .unwrap()
            .backup;
        let zip = backups_root(&petalfall)
            .join("instances")
            .join("a")
            .join("w")
            .join(&backup.file);
        let mut writer = zip::ZipWriter::new(std::fs::File::create(&zip).unwrap());
        let options = zip::write::SimpleFileOptions::default();
        writer.start_file("w/level.dat", options).unwrap();
        writer.write_all(&level_dat("w")).unwrap();
        writer.start_file("../escaped.txt", options).unwrap();
        writer.write_all(b"evil").unwrap();
        writer.finish().unwrap();
        let before = snapshot(&dir);

        let disposer = RecordingDisposer::new(tmp.path().join("trash"));
        let err = petalfall
            .restore_world_backup("a", "w", &backup.file, disposer.clone(), None)
            .await
            .unwrap_err();
        match err {
            CoreError::Instance(InstanceError::BackupEntryUnsafe { entry, reason, .. }) => {
                assert_eq!(entry, "../escaped.txt");
                assert_eq!(reason, "parent_traversal");
            }
            other => panic!("应拒绝越界条目，实际：{other:?}"),
        }
        assert!(disposer.seen().is_empty());
        assert_eq!(snapshot(&dir), before);
        assert!(!saves.join("escaped.txt").exists());
        assert!(!saves.join(format!("w{RESTORE_SUFFIX}")).exists());
    }

    #[tokio::test]
    async fn cancelled_restore_leaves_the_world_alone() {
        let tmp = tempfile::tempdir().unwrap();
        let petalfall = petalfall_at(tmp.path());
        let saves = isolated(&petalfall, "a");
        let dir = world(&saves, "w", "w");
        let backup = petalfall
            .backup_world("a", "w", BackupKind::Auto, None)
            .await
            .unwrap()
            .backup;
        write(&dir.join("region").join("r.0.0.mca"), b"changed");
        let before = snapshot(&dir);

        let token = CancellationToken::new();
        token.cancel();
        let disposer = RecordingDisposer::new(tmp.path().join("trash"));
        let err = petalfall
            .clone()
            .with_cancel(token)
            .restore_world_backup("a", "w", &backup.file, disposer.clone(), None)
            .await
            .unwrap_err();
        assert!(err.is_cancelled(), "{err:?}");
        assert!(disposer.seen().is_empty());
        assert_eq!(snapshot(&dir), before);
    }

    /// 时钟暂停：取消后还剩多少时限只看定时器先后，机器满载不会把排队的调度算进去。
    #[tokio::test(start_paused = true)]
    async fn waiting_for_a_busy_world_responds_to_cancellation() {
        let tmp = tempfile::tempdir().unwrap();
        let petalfall = petalfall_at(tmp.path());
        let saves = isolated(&petalfall, "a");
        world(&saves, "w", "w");
        let backup_dir = backups_root(&petalfall)
            .join("instances")
            .join("a")
            .join("w");
        // 另一个操作正占着这个存档。
        let held = acquire(&WORLD_LOCKS, &backup_dir, None).await.unwrap();

        let token = CancellationToken::new();
        let snapshot = petalfall.clone().with_cancel(token.clone());
        let waiting = tokio::spawn(async move {
            snapshot
                .backup_world("a", "w", BackupKind::Manual, None)
                .await
        });
        tokio::time::sleep(Duration::from_millis(50)).await;
        assert!(!waiting.is_finished(), "锁被占着时应排队");
        token.cancel();
        let err = tokio::time::timeout(Duration::from_secs(1), waiting)
            .await
            .expect("取消后 1 秒内返回")
            .unwrap()
            .unwrap_err();
        assert!(err.is_cancelled(), "{err:?}");
        drop(held);
        assert!(!backup_dir.exists(), "取消在打包之前，不应留下任何东西");
    }

    #[tokio::test]
    async fn delete_recycles_the_zip_and_drops_it_from_the_index() {
        let tmp = tempfile::tempdir().unwrap();
        let petalfall = petalfall_at(tmp.path());
        let saves = isolated(&petalfall, "a");
        world(&saves, "w", "w");
        let keep = petalfall
            .backup_world("a", "w", BackupKind::Manual, None)
            .await
            .unwrap()
            .backup;
        let gone = petalfall
            .backup_world("a", "w", BackupKind::Auto, None)
            .await
            .unwrap()
            .backup;
        let dir = backups_root(&petalfall)
            .join("instances")
            .join("a")
            .join("w");

        let disposer = RecordingDisposer::new(tmp.path().join("trash"));
        petalfall
            .delete_world_backup("a", "w", &gone.file, disposer.clone())
            .await
            .unwrap();
        assert_eq!(disposer.seen(), vec![dir.join(&gone.file)]);
        assert_eq!(zips_in(&dir), vec![keep.file.clone()]);
        let list = petalfall.list_world_backups("a", "w").await.unwrap();
        assert_eq!(list.backups, vec![keep]);

        let err = petalfall
            .delete_world_backup("a", "w", &gone.file, disposer.clone())
            .await
            .unwrap_err();
        assert!(
            matches!(err, CoreError::WorldBackupNotFound { .. }),
            "{err:?}"
        );
        assert_eq!(disposer.seen().len(), 1);
    }

    /// 处置完 zip 后停住，等测试放行：正好卡在删除动完盘、写回清单之前。
    #[derive(Clone)]
    struct PausingDisposer {
        inner: RecordingDisposer,
        disposed: Arc<tokio::sync::Notify>,
        resume: Arc<std::sync::Barrier>,
    }

    impl PausingDisposer {
        fn new(trash: PathBuf) -> Self {
            Self {
                inner: RecordingDisposer::new(trash),
                disposed: Arc::default(),
                resume: Arc::new(std::sync::Barrier::new(2)),
            }
        }

        /// 放行停在处置之后的那个线程。只在 `disposed` 响过之后调，对方已经到了屏障跟前，不会久等。
        fn resume(&self) {
            self.resume.wait();
        }
    }

    impl Disposer for PausingDisposer {
        fn dispose(&self, path: &Path) -> petalfall_instance::Result<()> {
            self.inner.dispose(path)?;
            self.disposed.notify_one();
            self.resume.wait();
            Ok(())
        }
    }

    /// 改名赶在删除写回清单之前到来：改名不占存档锁，只有备份根锁能让它等。等不住时旧名下会长出一份空清单，
    /// 新名下的清单还留着已经进回收站的那份。
    #[tokio::test]
    async fn rename_waits_for_a_delete_in_progress() {
        let tmp = tempfile::tempdir().unwrap();
        let petalfall = petalfall_at(tmp.path());
        let saves = isolated(&petalfall, "旧名");
        world(&saves, "w", "w");
        let keep = petalfall
            .backup_world("旧名", "w", BackupKind::Manual, None)
            .await
            .unwrap()
            .backup;
        let gone = petalfall
            .backup_world("旧名", "w", BackupKind::Auto, None)
            .await
            .unwrap()
            .backup;

        let disposer = PausingDisposer::new(tmp.path().join("trash"));
        let deleting = tokio::spawn({
            let (petalfall, file, disposer) =
                (petalfall.clone(), gone.file.clone(), disposer.clone());
            async move {
                petalfall
                    .delete_world_backup("旧名", "w", &file, disposer)
                    .await
            }
        });
        disposer.disposed.notified().await;

        let renaming = tokio::spawn({
            let petalfall = petalfall.clone();
            async move { petalfall.rename_world_backups("旧名", "新名").await }
        });
        // 留够改名跑完的时间：它要是不用等，这段时间里已经把目录搬走了。
        tokio::time::sleep(Duration::from_millis(200)).await;
        disposer.resume();
        deleting.await.unwrap().unwrap();
        renaming.await.unwrap().unwrap();

        assert!(
            !petalfall.instance_backups_dir("旧名").unwrap().exists(),
            "旧名下不应重建备份目录"
        );
        let dir = petalfall.instance_backups_dir("新名").unwrap().join("w");
        assert_eq!(zips_in(&dir), vec![keep.file.clone()]);
        let index = read_backup_index(&dir).await.unwrap();
        let listed: Vec<&str> = index.entries.iter().map(|e| e.file.as_str()).collect();
        assert_eq!(listed, vec![keep.file.as_str()]);
    }

    /// 改名进行中来的删除：拿到备份根锁之前什么都不碰；排到时备份已经搬走，按备份不在报错，旧名下不写东西，
    /// 搬走的备份在新名下原样留着。
    #[tokio::test]
    async fn delete_during_a_rename_leaves_the_moved_backups_alone() {
        let tmp = tempfile::tempdir().unwrap();
        let petalfall = petalfall_at(tmp.path());
        let saves = isolated(&petalfall, "旧名");
        world(&saves, "w", "w");
        let backup = petalfall
            .backup_world("旧名", "w", BackupKind::Manual, None)
            .await
            .unwrap()
            .backup;
        let from = petalfall.instance_backups_dir("旧名").unwrap();
        let to = petalfall.instance_backups_dir("新名").unwrap();

        // 改名全程持有备份根锁，这里先占住，等删除排上队再搬目录。
        let renaming = acquire(&ROOT_LOCKS, &petalfall.world_backups_root(), None)
            .await
            .unwrap();
        let disposer = RecordingDisposer::new(tmp.path().join("trash"));
        let deleting = tokio::spawn({
            let (petalfall, file, disposer) =
                (petalfall.clone(), backup.file.clone(), disposer.clone());
            async move {
                petalfall
                    .delete_world_backup("旧名", "w", &file, disposer)
                    .await
            }
        });
        tokio::time::sleep(Duration::from_millis(200)).await;
        assert_eq!(
            disposer.seen(),
            Vec::<PathBuf>::new(),
            "拿到根锁之前不应动 zip"
        );

        merge_scope_dir(&from, &to).await.unwrap();
        drop(renaming);
        let err = deleting.await.unwrap().unwrap_err();

        assert!(
            matches!(&err, CoreError::WorldBackupNotFound { file, .. } if *file == backup.file),
            "{err:?}"
        );
        assert_eq!(disposer.seen(), Vec::<PathBuf>::new());
        assert!(!from.exists(), "旧名下不应重建备份目录");
        let dir = to.join("w");
        assert_eq!(zips_in(&dir), vec![backup.file.clone()]);
        assert_eq!(
            read_backup_index(&dir).await.unwrap().entries.len(),
            1,
            "新名下的清单不受影响"
        );
    }

    #[tokio::test]
    async fn export_validates_the_destination_and_overwrites_it() {
        let tmp = tempfile::tempdir().unwrap();
        let petalfall = petalfall_at(tmp.path());
        let saves = isolated(&petalfall, "a");
        let dir = world(&saves, "w", "w");
        let out = tmp.path().join("导出");
        std::fs::create_dir_all(&out).unwrap();
        for bad in [
            PathBuf::from("relative.zip"),
            out.join("w.rar"),
            out.join("no-ext"),
            tmp.path().join("missing").join("w.zip"),
            dir.join("inside.zip"),
            dir.join("region").join("deeper.zip"),
            out.join("..").join("w.zip"),
        ] {
            let err = petalfall
                .export_world("a", "w", &bad, None)
                .await
                .unwrap_err();
            assert!(
                matches!(
                    err,
                    CoreError::Instance(InstanceError::InvalidBackupArgument { field: "dest", .. })
                ),
                "{}: {err:?}",
                bad.display()
            );
        }

        let dest = out.join("w.ZIP");
        std::fs::write(&dest, b"old").unwrap();
        let outcome = petalfall.export_world("a", "w", &dest, None).await.unwrap();
        assert_eq!(outcome.path, dest);
        assert_eq!(outcome.size_bytes, std::fs::metadata(&dest).unwrap().len());
        assert_eq!(
            zip_names(&dest),
            vec!["w/", "w/level.dat", "w/region/", "w/region/r.0.0.mca"]
        );
        assert!(
            !backups_root(&petalfall)
                .join("instances")
                .join("a")
                .join("w")
                .exists(),
            "导出不进备份"
        );
    }

    fn set_mtime(path: &Path, at: SystemTime) {
        std::fs::File::options()
            .write(true)
            .open(path)
            .unwrap()
            .set_modified(at)
            .unwrap();
    }

    #[tokio::test]
    async fn after_a_session_only_worlds_touched_since_it_started_are_backed_up() {
        let tmp = tempfile::tempdir().unwrap();
        let petalfall = petalfall_at(tmp.path());
        let saves = isolated(&petalfall, "a");
        let started = SystemTime::now() - Duration::from_secs(600);
        let old = world(&saves, "没进过", "没进过");
        set_mtime(&old.join("level.dat"), started - Duration::from_secs(3600));
        world(&saves, "玩过的", "玩过的");
        let busy = world(&saves, "开着的", "开着的");
        // 只有文件夹、没有 level.dat 的不是存档；恢复留下的临时目录也不是。
        std::fs::create_dir_all(saves.join("空文件夹")).unwrap();
        world(&saves, &format!("玩过的{RESTORE_SUFFIX}"), "残留");

        let holder = std::fs::OpenOptions::new()
            .write(true)
            .open(busy.join("session.lock"))
            .unwrap();
        holder.lock().unwrap();
        let outcome = petalfall
            .auto_backup_after_session("a", started)
            .await
            .unwrap();
        holder.unlock().unwrap();

        assert_eq!(outcome.backed_up, vec!["玩过的".to_owned()]);
        assert_eq!(outcome.failed.len(), 1);
        assert_eq!(outcome.failed[0].0, "开着的");
        assert!(
            matches!(
                outcome.failed[0].1,
                CoreError::Instance(InstanceError::WorldInUse { .. })
            ),
            "{:?}",
            outcome.failed[0].1
        );
        let scope = backups_root(&petalfall).join("instances").join("a");
        let indices = scope_backup_indices(&scope).await.unwrap();
        assert_eq!(indices.len(), 1);
        assert_eq!(indices[0].0, scope.join("玩过的"));
        assert_eq!(indices[0].1.entries.len(), 1);
        assert_eq!(indices[0].1.entries[0].kind, BackupKind::Auto);
    }

    #[tokio::test]
    async fn auto_backup_switched_off_produces_nothing() {
        let tmp = tempfile::tempdir().unwrap();
        let mut petalfall = petalfall_at(tmp.path());
        let saves = isolated(&petalfall, "a");
        world(&saves, "w", "w");
        petalfall.set_world_backup(WorldBackupSettings {
            auto: false,
            ..WorldBackupSettings::default()
        });
        let outcome = petalfall
            .auto_backup_after_session("a", SystemTime::UNIX_EPOCH)
            .await
            .unwrap();
        assert!(outcome.backed_up.is_empty() && outcome.failed.is_empty());
        assert!(!backups_root(&petalfall).exists());
    }

    /// 设置页在自动备份关闭时禁用两项保留设置并写明「不会清理」：这时手动备份也不能顺手删掉以前的自动备份，
    /// 不管份数还是总量超没超。
    #[tokio::test]
    async fn manual_backup_with_auto_off_keeps_every_earlier_auto_backup() {
        let tmp = tempfile::tempdir().unwrap();
        let mut petalfall = petalfall_at(tmp.path());
        let saves = isolated(&petalfall, "a");
        world(&saves, "w", "w");
        let mut autos = Vec::new();
        for _ in 0..3 {
            let outcome = petalfall
                .backup_world("a", "w", BackupKind::Auto, None)
                .await
                .unwrap();
            autos.push(outcome.backup.file);
        }

        petalfall.set_world_backup(WorldBackupSettings {
            auto: false,
            keep_per_world: 1,
            max_total_gb: 1,
        });
        let manual = petalfall
            .backup_world("a", "w", BackupKind::Manual, None)
            .await
            .unwrap();
        assert_eq!(manual.pruned, 0);

        let dir = backups_root(&petalfall)
            .join("instances")
            .join("a")
            .join("w");
        let mut expected = autos.clone();
        expected.push(manual.backup.file.clone());
        expected.sort();
        assert_eq!(zips_in(&dir), expected);
        assert_eq!(read_backup_index(&dir).await.unwrap().entries.len(), 4);

        // 重新打开后，下一份自动备份照常清理：每个存档只留 1 份自动备份，以前的 3 份都清掉，手动备份不动。
        petalfall.set_world_backup(WorldBackupSettings {
            auto: true,
            keep_per_world: 1,
            max_total_gb: 20,
        });
        let next = petalfall
            .backup_world("a", "w", BackupKind::Auto, None)
            .await
            .unwrap();
        assert_eq!(next.pruned, 3);
        let mut left = vec![manual.backup.file, next.backup.file];
        left.sort();
        assert_eq!(zips_in(&dir), left);
    }

    /// 别的存档的清单读不懂只影响清理：这一份备份照常写成、记进自己的清单，自动备份开着时发一条告警。
    #[tokio::test]
    async fn unreadable_index_of_another_world_only_costs_the_prune() {
        let tmp = tempfile::tempdir().unwrap();
        let mut petalfall = petalfall_at(tmp.path());
        let saves = isolated(&petalfall, "a");
        world(&saves, "w", "w");
        let elsewhere = isolated(&petalfall, "b");
        world(&elsewhere, "x", "x");
        petalfall
            .backup_world("b", "x", BackupKind::Manual, None)
            .await
            .unwrap();
        write(
            &backups_root(&petalfall)
                .join("instances")
                .join("b")
                .join("x")
                .join(petalfall_instance::BACKUP_INDEX_FILE),
            b"{ broken",
        );
        let dir = backups_root(&petalfall)
            .join("instances")
            .join("a")
            .join("w");

        for (auto, kind, warned) in [
            (false, BackupKind::Manual, false),
            (true, BackupKind::Manual, true),
            (true, BackupKind::Auto, true),
        ] {
            petalfall.set_world_backup(WorldBackupSettings {
                auto,
                ..WorldBackupSettings::default()
            });
            let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
            let outcome = petalfall
                .backup_world("a", "w", kind, Some(&tx))
                .await
                .unwrap_or_else(|err| panic!("auto={auto}, {kind:?}: {err:?}"));
            drop(tx);

            assert_eq!(outcome.pruned, 0);
            assert!(dir.join(&outcome.backup.file).exists());
            let index = read_backup_index(&dir).await.unwrap();
            assert!(index.find(&outcome.backup.file).is_some());
            let mut warnings = Vec::new();
            while let Some(event) = rx.recv().await {
                if let CoreEvent::Warning(text) = event {
                    warnings.push(text);
                }
            }
            assert_eq!(
                !warnings.is_empty(),
                warned,
                "auto={auto}, {kind:?}: {warnings:?}"
            );
        }

        // 自己这个存档的清单读不懂时仍然不打包：打完包记不进去，备份就成了没人认领的文件。
        write(
            &dir.join(petalfall_instance::BACKUP_INDEX_FILE),
            b"{ broken",
        );
        let before = zips_in(&dir);
        let err = petalfall
            .backup_world("a", "w", BackupKind::Manual, None)
            .await
            .unwrap_err();
        assert!(
            matches!(
                err,
                CoreError::Instance(InstanceError::BackupIndexInvalid { .. })
            ),
            "{err:?}"
        );
        assert_eq!(zips_in(&dir), before);
    }

    #[tokio::test]
    async fn renamed_instance_still_lists_its_backups() {
        let tmp = tempfile::tempdir().unwrap();
        let petalfall = petalfall_at(tmp.path());
        let saves = isolated(&petalfall, "旧名");
        world(&saves, "w", "w");
        let backup = petalfall
            .backup_world("旧名", "w", BackupKind::Manual, None)
            .await
            .unwrap()
            .backup;

        petalfall
            .rename_instance_files("旧名", "新名")
            .await
            .unwrap();
        petalfall
            .rename_world_backups("旧名", "新名")
            .await
            .unwrap();
        let list = petalfall.list_world_backups("新名", "w").await.unwrap();
        assert_eq!(list.backups, vec![backup]);
        assert_eq!(list.scope, WorldScope::Instance("新名".into()));
        assert!(!petalfall.instance_backups_dir("旧名").unwrap().exists());
        // 旧名下没有备份时是空操作。
        petalfall
            .rename_world_backups("旧名", "新名")
            .await
            .unwrap();
        assert_eq!(
            petalfall
                .list_world_backups("新名", "w")
                .await
                .unwrap()
                .backups
                .len(),
            1
        );
        assert!(matches!(
            petalfall
                .rename_world_backups("..", "新名")
                .await
                .unwrap_err(),
            CoreError::Instance(InstanceError::InvalidId { .. })
        ));
    }

    #[tokio::test]
    async fn deleting_the_instance_keeps_its_backups_and_preview_counts_them() {
        let tmp = tempfile::tempdir().unwrap();
        let petalfall = petalfall_at(tmp.path());
        let saves = isolated(&petalfall, "a");
        world(&saves, "w1", "w1");
        world(&saves, "w2", "w2");
        for w in ["w1", "w1", "w2"] {
            petalfall
                .backup_world("a", w, BackupKind::Manual, None)
                .await
                .unwrap();
        }
        let preview = petalfall.deletion_preview("a").await.unwrap();
        let backups_dir = backups_root(&petalfall).join("instances").join("a");
        assert_eq!(preview.backups_dir, backups_dir);
        assert_eq!(preview.backup_count, 3);

        let disposer = RecordingDisposer::new(tmp.path().join("trash"));
        assert!(
            petalfall
                .delete_instance_files("a", disposer)
                .await
                .unwrap()
        );
        assert_eq!(zips_in(&backups_dir.join("w1")).len(), 2);
        assert_eq!(zips_in(&backups_dir.join("w2")).len(), 1);
    }

    #[tokio::test]
    async fn a_world_open_in_the_game_is_not_backed_up() {
        let tmp = tempfile::tempdir().unwrap();
        let petalfall = petalfall_at(tmp.path());
        let saves = isolated(&petalfall, "a");
        let dir = world(&saves, "w", "w");
        let holder = std::fs::OpenOptions::new()
            .write(true)
            .open(dir.join("session.lock"))
            .unwrap();
        holder.lock().unwrap();
        let err = petalfall
            .backup_world("a", "w", BackupKind::Manual, None)
            .await
            .unwrap_err();
        assert!(
            matches!(&err, CoreError::Instance(InstanceError::WorldInUse { path }) if *path == dir),
            "{err:?}"
        );
        holder.unlock().unwrap();
    }

    /// 一个存档备份目录里的 zip 与清单条目：两者要对得上。
    async fn backed_up(dir: &Path) -> (Vec<String>, Vec<String>) {
        let mut listed: Vec<String> = read_backup_index(dir)
            .await
            .unwrap()
            .entries
            .into_iter()
            .map(|entry| entry.file)
            .collect();
        listed.sort();
        (zips_in(dir), listed)
    }

    /// 跨卷移动：暂存里的备份副本并进目标，同名存档合并，暂存清空；暂存不存在时什么都不做。
    #[tokio::test]
    async fn staged_backups_merge_into_the_target_and_leave_the_stage_empty() {
        let tmp = tempfile::tempdir().unwrap();
        let source = petalfall_at(&tmp.path().join("源"));
        let target = petalfall_at(&tmp.path().join("目标"));
        let saves = isolated(&source, "生存");
        world(&saves, "w", "w");
        world(&saves, "只在源里", "只在源里");
        for name in ["w", "w", "只在源里"] {
            source
                .backup_world("生存", name, BackupKind::Manual, None)
                .await
                .unwrap();
        }
        let target_saves = isolated(&target, "生存");
        world(&target_saves, "w", "w");
        target
            .backup_world("生存", "w", BackupKind::Auto, None)
            .await
            .unwrap();
        let staged = tmp
            .path()
            .join("目标")
            .join(".minecraft")
            .join(".petalfall")
            .join("moving")
            .join("token")
            .join("backups");
        std::fs::create_dir_all(staged.parent().unwrap()).unwrap();
        std::fs::rename(source.instance_backups_dir("生存").unwrap(), &staged).unwrap();

        merge_staged_backups(&staged, target.game_dir(), "生存")
            .await
            .unwrap();
        assert!(!staged.exists());
        let to = target.instance_backups_dir("生存").unwrap();
        let (zips, listed) = backed_up(&to.join("w")).await;
        assert_eq!(zips.len(), 3);
        assert_eq!(listed, zips);
        let list = target.list_world_backups("生存", "w").await.unwrap();
        assert_eq!(list.backups.len(), 3);
        let (zips, listed) = backed_up(&to.join("只在源里")).await;
        assert_eq!((zips.len(), listed.len()), (1, 1));

        let merged = snapshot(&to);
        merge_staged_backups(&staged, target.game_dir(), "生存")
            .await
            .unwrap();
        assert_eq!(snapshot(&to), merged);
    }

    // ---- 游戏目录的数据格式记号 ----

    use crate::data_format::testing::with_fixture;
    use crate::instances::tests::{NEWER_STAMP, NEWER_WRITER, disk_state, own_format, write_stamp};

    /// 会往游戏目录写的入口。
    const WRITERS: [&str; 4] = [
        "backup_world",
        "restore_world_backup",
        "delete_world_backup",
        "rename_world_backups",
    ];

    /// 隔离实例「a」的存档 w 带一份手动备份，返回备份的文件名。各入口真走下去都会改盘：打新包、换掉存档、
    /// 处置备份、把备份目录搬到「b」名下。
    async fn instance_with_a_backup(petalfall: &Petalfall) -> String {
        let saves = isolated(petalfall, "a");
        world(&saves, "w", "w");
        petalfall
            .backup_world("a", "w", BackupKind::Manual, None)
            .await
            .unwrap()
            .backup
            .file
    }

    async fn call_writer(
        petalfall: &Petalfall,
        entry: &str,
        file: &str,
        disposer: &RecordingDisposer,
    ) -> Result<()> {
        match entry {
            "backup_world" => petalfall
                .backup_world("a", "w", BackupKind::Manual, None)
                .await
                .map(drop),
            "restore_world_backup" => petalfall
                .restore_world_backup("a", "w", file, disposer.clone(), None)
                .await
                .map(drop),
            "delete_world_backup" => {
                petalfall
                    .delete_world_backup("a", "w", file, disposer.clone())
                    .await
            }
            "rename_world_backups" => petalfall.rename_world_backups("a", "b").await,
            other => panic!("表里没有这个入口：{other}"),
        }
    }

    /// 当前游戏目录被更新的落樱用过：每个写入口都报游戏目录太新，数据目录与游戏目录里的文件内容、修改时间都不变，
    /// 没有多出文件，也没有处置任何东西。
    #[tokio::test]
    async fn writers_refuse_a_newer_game_dir_and_touch_no_file() {
        for entry in WRITERS {
            let tmp = tempfile::tempdir().unwrap();
            let petalfall = petalfall_at(tmp.path());
            let file = instance_with_a_backup(&petalfall).await;
            let disposer = RecordingDisposer::new(tmp.path().join("trash"));
            write_stamp(petalfall.game_dir(), NEWER_STAMP);
            let before = disk_state(tmp.path());

            let err = with_fixture(
                own_format(2),
                call_writer(&petalfall, entry, &file, &disposer),
            )
            .await
            .unwrap_err();

            match err {
                CoreError::GameDirDataTooNew {
                    path,
                    found,
                    supported,
                    written_by,
                } => {
                    assert_eq!(path, petalfall.game_dir(), "{entry}");
                    assert_eq!((found, supported), (3, 2), "{entry}");
                    assert_eq!(written_by.as_deref(), Some(NEWER_WRITER), "{entry}");
                }
                other => panic!("{entry} 应报游戏目录太新，实际是 {other:?}"),
            }
            assert_eq!(disk_state(tmp.path()), before, "{entry}");
            assert_eq!(disposer.seen(), Vec::<PathBuf>::new(), "{entry}");
        }
    }

    /// 不换本版号：记号读不懂与号是多少无关，生产的这条路同样在碰任何文件之前拦下。
    #[tokio::test]
    async fn writers_refuse_an_unreadable_stamp_and_touch_no_file() {
        for entry in ["backup_world", "delete_world_backup"] {
            let tmp = tempfile::tempdir().unwrap();
            let petalfall = petalfall_at(tmp.path());
            let file = instance_with_a_backup(&petalfall).await;
            let disposer = RecordingDisposer::new(tmp.path().join("trash"));
            write_stamp(petalfall.game_dir(), r#"{"data_format":"3"}"#);
            let before = disk_state(tmp.path());

            let err = call_writer(&petalfall, entry, &file, &disposer)
                .await
                .unwrap_err();

            assert!(
                matches!(&err, CoreError::DataFormatUnreadable { path, .. } if path == petalfall.game_dir()),
                "{entry}：{err:?}"
            );
            assert_eq!(disk_state(tmp.path()), before, "{entry}");
        }
    }

    /// 退出游戏后的自动备份经 backup_world 写盘：游戏目录被更新的落樱用过时，玩过的存档各记一条游戏目录太新的失败，
    /// 什么都不写。
    #[tokio::test]
    async fn auto_backup_in_a_newer_game_dir_fails_each_world_and_writes_nothing() {
        let tmp = tempfile::tempdir().unwrap();
        let petalfall = petalfall_at(tmp.path());
        let saves = isolated(&petalfall, "a");
        world(&saves, "w", "w");
        write_stamp(petalfall.game_dir(), NEWER_STAMP);
        let before = disk_state(tmp.path());

        let outcome = with_fixture(
            own_format(2),
            petalfall.auto_backup_after_session("a", SystemTime::UNIX_EPOCH),
        )
        .await
        .unwrap();

        assert_eq!(outcome.backed_up, Vec::<String>::new());
        assert_eq!(outcome.failed.len(), 1);
        assert_eq!(outcome.failed[0].0, "w");
        assert!(
            matches!(
                &outcome.failed[0].1,
                CoreError::GameDirDataTooNew {
                    found: 3,
                    supported: 2,
                    ..
                }
            ),
            "{:?}",
            outcome.failed[0].1
        );
        assert_eq!(disk_state(tmp.path()), before);
    }
}
