//! 实例管理：列表、设置、内容、工作目录、删除、改名与侧栏固定。
//!
//! 实例就是游戏目录 `versions/` 下的一个版本目录，目录名即实例 id。这里的操作只碰本地文件，
//! 安装与补全在 [`crate::instance_install`]。id 来自前端，是不可信输入，拼进任何路径之前都先过
//! [`is_safe_instance_id`]。
//!
//! 改名与删除会牵连两类引用：别的实例经 `inheritsFrom` 依赖它（传统布局的加载器版本），这种情况
//! 直接拒绝；配置里的侧栏固定、当前选中与固定服务器记住的实例由调用方拿到写锁后经
//! [`Petalfall::rename_instance_refs`] / [`Petalfall::forget_instance`] 同步再落盘，文件操作本身在快照上做，不占门面锁。

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use petalfall_base::error_with_causes;
use petalfall_instance::{
    BrokenReason, BrokenVersion, DiscoveredVersion, Disposer, IncompleteMarker, InstanceContent,
    MarkerStore, PETALFALL_META_DIR, PinsViolation, VersionProbe, VersionScan, VersionSettings,
    VersionSettingsStore, WorldEntry, check_instance_name, count_mod_files, count_resource_packs,
    count_worlds, dir_footprint, discover_versions, has_existing_mods_or_saves,
    is_backup_file_name, is_safe_instance_id, list_version_dirs, list_worlds, probe_version,
    read_instance_content, resolve_isolation,
};
use petalfall_launch::{QuickPlaySupport, quick_play_support};
use petalfall_version::{LoaderInfo, VersionJson, identify_mc_version};
use serde::{Deserialize, Serialize};
use tokio::sync::Semaphore;
use tokio::task::JoinSet;

use crate::InstanceError;
use crate::crashdiag::last_crash_at;
use crate::data_format::{GameDirCheck, GuardMode};
use crate::error::{CoreError, Result};
use crate::facade::Petalfall;
use crate::folders::same_path;
use crate::modfs::try_exists;
use crate::modpack::{InstanceModpack, read_instance_modpack};
use crate::workdir::read_version_json;

/// 侧栏最多固定的实例数。
pub const MAX_SIDEBAR_PINS: usize = 5;

/// 版本 JSON 没有声明 `javaVersion` 时用的 Java 主版本：只有 1.6 之前的老版本不带这个字段，
/// 它们都跑在 Java 8 上，官方启动器与启动流程取的是同一个值。
pub const LEGACY_JAVA_MAJOR: u32 = 8;

/// 列表阶段同时读取实例附属文件（设置、标记、mods 目录）的路数。
const LIST_CONCURRENCY: usize = 8;

/// 继承链最多追几层；正常数据只有一两层，上限只是防环。
const MAX_INHERIT_DEPTH: usize = 16;

/// 改名时旧版本 JSON 先挪到这个后缀的文件，新 JSON 写成功、其余文件也改完才删，失败时据此还原。
const RENAME_STAGED_SUFFIX: &str = concat!(".", petalfall_base::app_slug!(), "-rename");

/// 依赖版本记录的文件名，放在游戏目录的元数据目录下：换一个游戏目录就是另一批版本。
const BASE_RECORD_FILE: &str = "base-versions.json";

/// 依赖版本记录的读改写排队：并行的导入各记各的，不排队时后写的会盖掉先写的。
static BASE_RECORD_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

/// 一个附属文件的读取结果。读不出来时带原因，不让一个坏文件拖垮整张列表，也不假装它是默认值。
#[derive(Debug, Clone, PartialEq)]
pub enum Readable<T> {
    Read(T),
    Unreadable(String),
}

/// 列表里的一个实例。
#[derive(Debug, Clone, PartialEq)]
pub struct InstanceSummary {
    pub id: String,
    /// 实例目录 `versions/<id>`。
    pub dir: PathBuf,
    /// 版本 JSON 解析出的信息，或解析不了的原因。
    pub version: InstanceVersion,
    /// 实例设置（介绍、封面、隔离覆盖等）。
    pub settings: Readable<VersionSettings>,
    /// 未完成标记；`None` 表示文件齐全（或至少没有中断过的安装与修复）。
    pub incomplete: Option<Readable<IncompleteMarker>>,
    /// 实例目录的创建时刻（Unix 毫秒）；文件系统不记录创建时间或目录读不出时为 `None`。
    pub created_at: Option<u64>,
    /// 实例目录或工作目录读不出来的原因；此时 `created_at` 或 Mod 数、存档数、隔离生效值为 `None`。
    pub dir_error: Option<String>,
    /// 从整合包导入时记下的整合包信息；`Read(None)` 表示不是整合包实例。
    pub modpack: Readable<Option<InstanceModpack>>,
    /// 最近一次崩溃的时刻（Unix 毫秒）；`Read(None)` 表示没崩溃过。
    pub last_crash_at: Readable<Option<u64>>,
}

/// 实例的版本状态。
#[derive(Debug, Clone, PartialEq)]
pub enum InstanceVersion {
    Ready(ReadyVersion),
    Broken(BrokenReason),
}

/// 版本 JSON 可用的实例。
#[derive(Debug, Clone, PartialEq)]
pub struct ReadyVersion {
    /// 原版版本号；识别不出时为 `None`。
    pub mc_version: Option<String>,
    pub loaders: Vec<LoaderInfo>,
    /// 版本 JSON 的 `type`（release / snapshot / old_beta / old_alpha）。
    pub release_type: Option<String>,
    pub is_release: bool,
    /// 需要的 Java 主版本；继承链断了（父版本不在）时为 `None`。
    pub java_major: Option<u32>,
    /// 支持哪些直达方式（进入存档、加入服务器）；继承链断了时为 `None`。
    pub quick_play: Option<QuickPlaySupport>,
    /// 继承链上除它自己以外的版本 id，由近及远，口径同 [`Petalfall::inheritance_chain`]。
    pub bases: Vec<String>,
    /// 工作目录 `mods/` 下的 Mod 文件数；设置文件读不出定不了工作目录、或工作目录读不出时为 `None`。
    pub mod_count: Option<u32>,
    /// 工作目录 `saves/` 下的存档数，口径同 [`count_worlds`]；何时为 `None` 同 `mod_count`。
    pub world_count: Option<u32>,
    /// 工作目录 `resourcepacks/` 下的资源包数，口径同 [`count_resource_packs`]（与
    /// [`Petalfall::instance_content`] 列出的资源包一一对应）；何时为 `None` 同 `mod_count`。
    pub resource_pack_count: Option<u32>,
    /// 隔离的生效值（实例覆盖、全局档位与磁盘上已有数据共同决定）；何时为 `None` 同 `mod_count`。
    pub isolated: Option<bool>,
}

/// 删除前的预览：会一起删掉的存档、占用空间与依赖它的实例。
#[derive(Debug, Clone, PartialEq)]
pub struct DeletionPreview {
    pub id: String,
    pub dir: PathBuf,
    /// 实例目录里的存档（隔离的存档随实例删除；共用 `.minecraft/saves` 的不受影响，不在这里）。
    pub worlds: Vec<WorldEntry>,
    pub size_bytes: u64,
    pub file_count: u64,
    /// 经 `inheritsFrom` 依赖它的实例；非空时删除会被拒绝。
    pub dependents: Vec<String>,
    /// 这个实例名下存档备份的目录。备份不随实例删除。
    pub backups_dir: PathBuf,
    /// 这个实例名下的备份份数（各存档清单的条目数之和）。
    pub backup_count: u32,
}

impl Petalfall {
    /// 实例目录路径；id 不能安全拼进路径时报 [`InstanceError::InvalidId`]。不检查目录是否存在。
    pub fn instance_dir(&self, id: &str) -> Result<PathBuf> {
        if !is_safe_instance_id(id) {
            return Err(InstanceError::InvalidId { id: id.to_owned() }.into());
        }
        Ok(self.layout().version_dir(id))
    }

    /// 已存在的实例目录；不存在报 [`CoreError::VersionNotInstalled`]。
    pub async fn existing_instance_dir(&self, id: &str) -> Result<PathBuf> {
        let dir = self.instance_dir(id)?;
        match tokio::fs::metadata(&dir).await {
            Ok(meta) if meta.is_dir() => Ok(dir),
            Ok(_) => Err(not_installed(id)),
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => Err(not_installed(id)),
            Err(source) => Err(petalfall_base::Error::Io { path: dir, source }.into()),
        }
    }

    /// 实例的会话日志目录，日志页与崩溃报告读的启动日志都在这里。实例不存在报 [`CoreError::VersionNotInstalled`]，
    /// 日志目录本身可能还没建。
    pub async fn session_logs_dir(&self, id: &str) -> Result<PathBuf> {
        Ok(petalfall_launch::logfile::logs_dir(
            &self.existing_instance_dir(id).await?,
        ))
    }

    /// `versions/` 下全部实例目录名（含版本 JSON 损坏的），按名升序。
    pub async fn instance_names(&self) -> Result<Vec<String>> {
        Ok(list_version_dirs(self.game_dir())
            .await?
            .unwrap_or_default())
    }

    /// 列出全部实例：版本信息、设置、未完成标记、Mod 与存档数、隔离生效值、整合包来源、最近崩溃时刻
    /// 与创建时间一次给齐。
    ///
    /// Mod 数只数 `mods/` 下的文件，不解析 jar；存档数只数 `saves/` 下的文件夹，不读 level.dat；
    /// 版本 JSON 解析走进程内缓存，文件没变就不重读。玩家没建过的依赖版本目录不列出。
    ///
    /// 扫描之前以「使用」方式核对游戏目录的数据格式记号（[`Petalfall::guard_game_dir`]）：号比这一版新、
    /// 记号读不懂、时限内看不出结论都直接报错，一个实例文件也不读。游戏目录不存在时交回空列表。
    pub async fn list_instances(&self) -> Result<Vec<InstanceSummary>> {
        // 关卡已在时限内判定目录不存在：不再去看第二遍，也不扫描关卡之后才冒出来、没核对过记号的目录。
        if self.guard_game_dir(GuardMode::Use).await? == GameDirCheck::Absent {
            return Ok(Vec::new());
        }
        let mut scan = discover_versions(self.game_dir()).await?;
        // 先算再隐藏：这两项要沿继承链走，隐藏的版本可能正是链上的一环。
        let javas = java_majors(&scan);
        let quick_plays = quick_play_supports(&scan);
        let mut chains = inheritance_chains(&scan);
        hide_base_versions(self.game_dir(), &mut scan).await;
        let mut entries: Vec<Entry> = scan
            .versions
            .into_iter()
            .map(|version| {
                let java = javas.get(&version.id).copied().flatten();
                let quick_play = quick_plays.get(&version.id).copied().flatten();
                let bases = chains
                    .remove(&version.id)
                    .expect("继承链按同一份扫描结果算，每个版本都有");
                Entry::Found(Box::new(version), java, quick_play, bases)
            })
            .chain(scan.broken.into_iter().map(Entry::Broken))
            .collect();
        entries.sort_by_cached_key(|entry| entry.id().to_lowercase());

        let game_dir = self.game_dir().to_path_buf();
        let policy = self.config().isolation_policy;
        let permits = Arc::new(Semaphore::new(LIST_CONCURRENCY));
        let total = entries.len();
        let mut set = JoinSet::new();
        for (index, entry) in entries.into_iter().enumerate() {
            let permits = permits.clone();
            let game_dir = game_dir.clone();
            set.spawn(async move {
                let _permit = permits.acquire_owned().await.expect("列表的信号量从不关闭");
                (index, summarize(&game_dir, policy, entry).await)
            });
        }
        let mut slots: Vec<Option<InstanceSummary>> = vec![None; total];
        while let Some(joined) = set.join_next().await {
            let (index, summary) = joined?;
            slots[index] = Some(summary);
        }
        Ok(slots
            .into_iter()
            .map(|slot| slot.expect("每个实例都有一份结果"))
            .collect())
    }

    /// 读取实例设置；没有自定义过时为默认值。
    pub async fn instance_settings(&self, id: &str) -> Result<VersionSettings> {
        let dir = self.existing_instance_dir(id).await?;
        Ok(VersionSettingsStore::for_version_dir(&dir).load().await?)
    }

    /// 整份写入实例设置；任一字段不合法报 [`InstanceError::InvalidSettings`]，不改动文件。保存后删掉
    /// 卡面图片目录里不再被引用的图片（玩家清除图片、换回方块时旧文件随之删掉）。
    ///
    /// 先以「使用」方式核对游戏目录的数据格式记号，被拒时原样报错、什么都不写：任务重试与列实例被拒后
    /// 留下的旧列表都不经过列实例，不能指望调用方核对过。
    pub async fn set_instance_settings(&self, id: &str, settings: &VersionSettings) -> Result<()> {
        self.guard_game_dir(GuardMode::Use).await?;
        settings
            .validate()
            .map_err(|violation| InstanceError::InvalidSettings {
                field: violation.field,
                reason: violation.reason,
            })?;
        let dir = self.existing_instance_dir(id).await?;
        crate::cover_image::save_settings_and_prune(&dir, settings).await
    }

    /// 版本 JSON 可用的实例；目录不在报未安装，JSON 缺失或损坏报 [`InstanceError::Broken`]。
    pub async fn instance_version(&self, id: &str) -> Result<DiscoveredVersion> {
        let dir = self.existing_instance_dir(id).await?;
        match probe_version(self.game_dir(), id).await? {
            VersionProbe::Found(version) => Ok(*version),
            VersionProbe::Broken(broken) => {
                tracing::warn!(id, dir = %dir.display(), reason = ?broken.reason, "实例版本 JSON 不可用");
                Err(InstanceError::Broken {
                    id: id.to_owned(),
                    reason: broken_reason_text(&broken.reason),
                }
                .into())
            }
        }
    }

    /// 实例的资源包、光影包与存档（从它的工作目录读）。
    pub async fn instance_content(&self, id: &str) -> Result<InstanceContent> {
        let resolved = self.resolve_working_dir(id).await?;
        Ok(read_instance_content(&resolved.working_dir).await?)
    }

    /// 删除前的预览。实例不存在报未安装。
    pub async fn deletion_preview(&self, id: &str) -> Result<DeletionPreview> {
        let dir = self.existing_instance_dir(id).await?;
        let worlds = list_worlds(&dir.join("saves")).await?;
        let (size_bytes, file_count) = dir_footprint(&dir).await?;
        let scan = discover_versions(self.game_dir()).await?;
        Ok(DeletionPreview {
            id: id.to_owned(),
            dir,
            worlds,
            size_bytes,
            file_count,
            dependents: dependents_in(&scan, id),
            backups_dir: self.instance_backups_dir(id)?,
            backup_count: self.kept_backup_count(id).await?,
        })
    }

    /// 删除确认里要说的备份份数。备份不随实例删除，清单读不懂只影响这个数字：改数盘上的备份文件，
    /// 否则确认框打不开，实例就删不掉了。
    async fn kept_backup_count(&self, id: &str) -> Result<u32> {
        match self.instance_backup_count(id).await {
            Err(CoreError::Instance(InstanceError::BackupIndexInvalid { path, reason })) => {
                tracing::warn!(id, path = %path.display(), reason, "备份清单读不懂，删除预览改数盘上的备份文件");
                let dir = self.instance_backups_dir(id)?;
                tokio::task::spawn_blocking(move || count_backup_files(&dir)).await?
            }
            counted => counted,
        }
    }

    /// 把实例目录交给 `disposer`（生产是系统回收站）。返回目录原先是否存在：不存在时什么都不做，
    /// 重复删除是幂等的。有别的实例依赖它时报 [`InstanceError::HasDependents`]。
    ///
    /// 只处理文件；配置里的引用由调用方随后经 [`Petalfall::forget_instance`] 清掉。先核对游戏目录的数据格式
    /// 记号，规则同 [`Petalfall::set_instance_settings`]。
    pub async fn delete_instance_files(
        &self,
        id: &str,
        disposer: impl Disposer + 'static,
    ) -> Result<bool> {
        self.guard_game_dir(GuardMode::Use).await?;
        let dir = self.instance_dir(id)?;
        match tokio::fs::metadata(&dir).await {
            Ok(meta) if meta.is_dir() => {}
            Ok(_) => return Err(not_installed(id)),
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(false),
            Err(source) => return Err(petalfall_base::Error::Io { path: dir, source }.into()),
        }
        let scan = discover_versions(self.game_dir()).await?;
        ensure_no_dependents(&scan, id)?;
        tracing::info!(id, dir = %dir.display(), "删除实例：移入回收站");
        tokio::task::spawn_blocking(move || disposer.dispose(&dir)).await??;
        Ok(true)
    }

    /// 从配置里去掉对实例 `id` 的引用（侧栏固定、当前选中、固定服务器记住的实例）。返回配置是否有变化，
    /// 有变化时调用方落盘。
    pub fn forget_instance(&mut self, id: &str) -> bool {
        let pins = &self.config().sidebar_pins;
        let kept: Vec<String> = pins.iter().filter(|pin| *pin != id).cloned().collect();
        let pins_changed = kept.len() != pins.len();
        if pins_changed {
            self.set_sidebar_pins(kept);
        }
        let was_selected = self.config().selected_version.as_deref() == Some(id);
        if was_selected {
            self.set_selected_version(None);
        }
        let servers_changed = self.forget_pinned_instance(id);
        pins_changed || was_selected || servers_changed
    }

    /// 实例 `id` 已不在游戏目录 `from_game_dir` 里时，去掉配置在那个目录名下对它的引用：实例移到了别的游戏目录，
    /// 或整合包导入没成、半成品已删掉，都是这种情况。`from_game_dir` 是当前目录时同 [`Petalfall::forget_instance`]；
    /// 否则只改 `parked_directories` 里这个目录那条的固定与选中（固定服务器记的是当前目录的实例，不动），改完那条
    /// 固定与选中都空了就整条删掉，同切换目录时收起它们的规则。返回配置是否有变化，有变化时调用方落盘。
    pub fn forget_moved_instance(&mut self, id: &str, from_game_dir: &Path) -> bool {
        if same_path(from_game_dir, self.game_dir()) {
            return self.forget_instance(id);
        }
        let mut changed = false;
        self.config_mut().parked_directories.retain_mut(|parked| {
            if !same_path(&parked.path, from_game_dir) {
                return true;
            }
            let pins = parked.sidebar_pins.len();
            parked.sidebar_pins.retain(|pin| pin != id);
            let mut touched = parked.sidebar_pins.len() != pins;
            if parked.selected_version.as_deref() == Some(id) {
                parked.selected_version = None;
                touched = true;
            }
            changed |= touched;
            !(touched && parked.sidebar_pins.is_empty() && parked.selected_version.is_none())
        });
        changed
    }

    /// 改名：实例目录、版本 JSON（文件名与其中的 `id`）、客户端 jar 与 natives 目录一起改。
    ///
    /// 新名字按命名规则校验（不分大小写重名，自己除外）；有实例依赖它时拒绝。中途失败时把已经改掉的
    /// 逐项改回去再报错。只处理文件；配置里的引用由调用方随后经 [`Petalfall::rename_instance_refs`] 同步。
    /// 先核对游戏目录的数据格式记号，规则同 [`Petalfall::set_instance_settings`]。
    pub async fn rename_instance_files(&self, old: &str, new: &str) -> Result<()> {
        self.guard_game_dir(GuardMode::Use).await?;
        let old_dir = self.existing_instance_dir(old).await?;
        let names = self.instance_names().await?;
        check_instance_name(new, names.iter().map(String::as_str), Some(old)).map_err(
            |violation| InstanceError::InvalidName {
                name: new.to_owned(),
                violation,
            },
        )?;
        if old == new {
            return Ok(());
        }
        let scan = discover_versions(self.game_dir()).await?;
        ensure_no_dependents(&scan, old)?;
        let new_dir = self.instance_dir(new)?;
        let (old, new) = (old.to_owned(), new.to_owned());
        tracing::info!(%old, %new, "实例改名");
        tokio::task::spawn_blocking(move || rename_blocking(&old_dir, &new_dir, &old, &new))
            .await??;
        Ok(())
    }

    /// 把配置里对 `old` 的引用改成 `new`（侧栏固定保持原位，当前选中与固定服务器记住的实例跟着走）。
    /// 返回配置是否有变化。
    pub fn rename_instance_refs(&mut self, old: &str, new: &str) -> bool {
        let pins = &self.config().sidebar_pins;
        let renamed: Vec<String> = pins
            .iter()
            .map(|pin| {
                if pin == old {
                    new.to_owned()
                } else {
                    pin.clone()
                }
            })
            .collect();
        let pins_changed = renamed != *pins;
        if pins_changed {
            self.set_sidebar_pins(renamed);
        }
        let was_selected = self.config().selected_version.as_deref() == Some(old);
        if was_selected {
            self.set_selected_version(Some(new.to_owned()));
        }
        let servers_changed = self.rename_pinned_instance(old, new);
        pins_changed || was_selected || servers_changed
    }

    /// 配置里固定的实例中当前仍在实例库里的那些，保持顺序。不列出的版本目录也不算：侧栏看不见它，它却占着名额，
    /// 玩家就再也固定不满。
    pub async fn existing_sidebar_pins(&self) -> Result<Vec<String>> {
        let mut scan = discover_versions(self.game_dir()).await?;
        hide_base_versions(self.game_dir(), &mut scan).await;
        let visible: HashSet<&str> = scan
            .versions
            .iter()
            .map(|version| version.id.as_str())
            .chain(scan.broken.iter().map(|broken| broken.id.as_str()))
            .collect();
        Ok(self
            .config()
            .sidebar_pins
            .iter()
            .filter(|pin| visible.contains(pin.as_str()))
            .cloned()
            .collect())
    }

    /// 校验一份侧栏固定列表：不超过 [`MAX_SIDEBAR_PINS`] 个、不重复、每个都是现有实例。
    pub async fn validate_sidebar_pins(&self, pins: &[String]) -> Result<()> {
        if pins.len() > MAX_SIDEBAR_PINS {
            return Err(InstanceError::InvalidPins {
                reason: PinsViolation::TooMany,
                id: None,
            }
            .into());
        }
        let mut seen = HashSet::new();
        if let Some(dup) = pins.iter().find(|pin| !seen.insert(pin.as_str())) {
            return Err(InstanceError::InvalidPins {
                reason: PinsViolation::Duplicate,
                id: Some(dup.clone()),
            }
            .into());
        }
        let names: HashSet<String> = self.instance_names().await?.into_iter().collect();
        if let Some(missing) = pins.iter().find(|pin| !names.contains(*pin)) {
            return Err(InstanceError::InvalidPins {
                reason: PinsViolation::NotFound,
                id: Some(missing.clone()),
            }
            .into());
        }
        Ok(())
    }

    /// 新建实例时的名称校验：命名规则 + 不分大小写不与现有实例重名。
    pub async fn check_new_instance_name(&self, name: &str) -> Result<()> {
        let names = self.instance_names().await?;
        check_instance_name(name, names.iter().map(String::as_str), None).map_err(|violation| {
            InstanceError::InvalidName {
                name: name.to_owned(),
                violation,
            }
        })?;
        Ok(())
    }
}

fn not_installed(id: &str) -> CoreError {
    CoreError::VersionNotInstalled { id: id.to_owned() }
}

/// 损坏原因的人类可读说明（列表、错误信息共用）。
pub fn broken_reason_text(reason: &BrokenReason) -> String {
    match reason {
        BrokenReason::MissingJson => "缺少版本 JSON".to_owned(),
        BrokenReason::Parse(detail) => format!("版本 JSON 损坏：{detail}"),
        BrokenReason::Unreadable(detail) => format!("版本 JSON 读不出来：{detail}"),
    }
}

enum Entry {
    Found(
        Box<DiscoveredVersion>,
        Option<u32>,
        Option<QuickPlaySupport>,
        Vec<String>,
    ),
    Broken(BrokenVersion),
}

impl Entry {
    fn id(&self) -> &str {
        match self {
            Entry::Found(version, ..) => &version.id,
            Entry::Broken(broken) => &broken.id,
        }
    }
}

/// 一个实例的摘要。不返回 `Result`：读不出来的都标在这个实例上，一个实例不该让整张列表失败。
async fn summarize(
    game_dir: &Path,
    policy: petalfall_instance::IsolationPolicy,
    entry: Entry,
) -> InstanceSummary {
    let (id, dir) = match &entry {
        Entry::Found(version, ..) => (version.id.clone(), version.dir.clone()),
        Entry::Broken(broken) => (broken.id.clone(), broken.dir.clone()),
    };
    let settings = match VersionSettingsStore::for_version_dir(&dir).load().await {
        Ok(settings) => Readable::Read(settings),
        Err(err) => {
            let reason = error_with_causes(&err);
            tracing::warn!(id, error = %reason, "实例设置读不出来");
            Readable::Unreadable(reason)
        }
    };
    let incomplete = match MarkerStore::for_version_dir(&dir).load().await {
        Ok(marker) => marker.map(Readable::Read),
        Err(err) => {
            let reason = error_with_causes(&err);
            tracing::warn!(id, error = %reason, "未完成标记读不出来");
            Some(Readable::Unreadable(reason))
        }
    };
    // 整合包信息与崩溃记录是附属文件：读不出来只标在这一个实例上，和设置文件同一口径。
    let modpack = match read_instance_modpack(&dir).await {
        Ok(modpack) => Readable::Read(modpack),
        Err(err) => {
            let reason = error_with_causes(&err);
            tracing::warn!(id, error = %reason, "整合包信息读不出来");
            Readable::Unreadable(reason)
        }
    };
    let last_crash_at = match last_crash_at(&dir).await {
        Ok(at) => Readable::Read(at),
        Err(err) => {
            let reason = error_with_causes(&err);
            tracing::warn!(id, error = %reason, "崩溃记录读不出来");
            Readable::Unreadable(reason)
        }
    };
    let mut dir_error = None;
    let created_at = match tokio::fs::metadata(&dir).await {
        // created() 报错只意味着这个文件系统不记录创建时间。
        Ok(meta) => meta.created().ok().and_then(unix_millis),
        Err(source) => {
            let reason = error_with_causes(&petalfall_base::Error::Io {
                path: dir.clone(),
                source,
            });
            tracing::warn!(id, error = %reason, "实例目录读不出来");
            dir_error = Some(reason);
            None
        }
    };

    let version = match entry {
        Entry::Broken(broken) => InstanceVersion::Broken(broken.reason),
        Entry::Found(version, java_major, quick_play, bases) => {
            let workdir = match &settings {
                Readable::Read(settings) => {
                    match workdir_facts(game_dir, &id, policy, settings, &version).await {
                        Ok(facts) => Some(facts),
                        Err(err) => {
                            let reason = error_with_causes(&err);
                            tracing::warn!(id, error = %reason, "工作目录读不出来");
                            dir_error.get_or_insert(reason);
                            None
                        }
                    }
                }
                Readable::Unreadable(_) => None,
            };
            InstanceVersion::Ready(ReadyVersion {
                mc_version: identify_mc_version(&version.json).value,
                is_release: version.is_release(),
                release_type: version.json.release_type.clone(),
                loaders: version.loaders,
                java_major,
                quick_play,
                bases,
                mod_count: workdir.map(|facts| facts.mods),
                world_count: workdir.map(|facts| facts.worlds),
                resource_pack_count: workdir.map(|facts| facts.resource_packs),
                isolated: workdir.map(|facts| facts.isolated),
            })
        }
    };
    InstanceSummary {
        id,
        dir,
        version,
        settings,
        incomplete,
        created_at,
        dir_error,
        modpack,
        last_crash_at,
    }
}

/// 工作目录里列表要的 Mod 数、存档数、资源包数与隔离生效值。三个数同是 `u32`，按名字取，免得排错位置。
#[derive(Clone, Copy)]
struct WorkdirFacts {
    mods: u32,
    worlds: u32,
    resource_packs: u32,
    isolated: bool,
}

/// 任一项读不出就整组不给：列表把原因记进 `dir_error`，几个数一起为 `None`。
async fn workdir_facts(
    game_dir: &Path,
    id: &str,
    policy: petalfall_instance::IsolationPolicy,
    settings: &VersionSettings,
    version: &DiscoveredVersion,
) -> Result<WorkdirFacts> {
    let resolved = resolve_isolation(
        game_dir,
        id,
        policy,
        settings.isolation,
        version.has_mod_loader(),
        version.is_release(),
    )
    .await?;
    let mods = count_mod_files(&resolved.working_dir.join("mods")).await?;
    let worlds = count_worlds(&resolved.working_dir.join("saves")).await?;
    let resource_packs = count_resource_packs(&resolved.working_dir.join("resourcepacks")).await?;
    Ok(WorkdirFacts {
        mods,
        worlds,
        resource_packs,
        isolated: resolved.isolated,
    })
}

/// 实例备份目录下各存档里的备份文件数，按文件名认，不读清单。
fn count_backup_files(instance_dir: &Path) -> Result<u32> {
    let mut count = 0;
    for world in std::fs::read_dir(instance_dir).map_err(|source| io_error(instance_dir, source))? {
        let world = world
            .map_err(|source| io_error(instance_dir, source))?
            .path();
        if !world.is_dir() {
            continue;
        }
        for file in std::fs::read_dir(&world).map_err(|source| io_error(&world, source))? {
            let file = file.map_err(|source| io_error(&world, source))?;
            if file.file_name().to_str().is_some_and(is_backup_file_name) {
                count += 1;
            }
        }
    }
    Ok(count)
}

fn unix_millis(time: SystemTime) -> Option<u64> {
    time.duration_since(UNIX_EPOCH)
        .ok()
        .and_then(|d| u64::try_from(d.as_millis()).ok())
}

/// 每个版本需要的 Java 主版本：沿继承链找第一个声明了 `javaVersion` 的，链到头都没有取
/// [`LEGACY_JAVA_MAJOR`]；父版本不在扫描结果里（链断了）为 `None`。
fn java_majors(scan: &VersionScan) -> HashMap<String, Option<u32>> {
    let by_id: HashMap<&str, &VersionJson> = scan
        .versions
        .iter()
        .map(|v| (v.id.as_str(), &v.json))
        .collect();
    scan.versions
        .iter()
        .map(|v| (v.id.clone(), declared_java(&v.json, &by_id)))
        .collect()
}

fn declared_java(json: &VersionJson, by_id: &HashMap<&str, &VersionJson>) -> Option<u32> {
    let mut current = json;
    for _ in 0..MAX_INHERIT_DEPTH {
        if let Some(java) = &current.java_version {
            return Some(java.major_version);
        }
        match current.inherits_from.as_deref() {
            Some(parent) => current = by_id.get(parent)?,
            None => return Some(LEGACY_JAVA_MAJOR),
        }
    }
    None
}

/// 每个版本支持的直达方式：沿继承链逐层判定、按字段取或。启动时各层的 `arguments.game` 拼接在一起，
/// 原版的 Quick Play 块在加载器版本里照样生效。父版本不在扫描结果里（链断了）为 `None`。
fn quick_play_supports(scan: &VersionScan) -> HashMap<String, Option<QuickPlaySupport>> {
    let by_id: HashMap<&str, &VersionJson> = scan
        .versions
        .iter()
        .map(|v| (v.id.as_str(), &v.json))
        .collect();
    scan.versions
        .iter()
        .map(|v| (v.id.clone(), chain_quick_play(&v.json, &by_id)))
        .collect()
}

fn chain_quick_play(
    json: &VersionJson,
    by_id: &HashMap<&str, &VersionJson>,
) -> Option<QuickPlaySupport> {
    let mut support = QuickPlaySupport::default();
    let mut current = json;
    for _ in 0..MAX_INHERIT_DEPTH {
        let layer = quick_play_support(current);
        support.singleplayer |= layer.singleplayer;
        support.multiplayer |= layer.multiplayer;
        match current.inherits_from.as_deref() {
            Some(parent) => current = by_id.get(parent)?,
            None => return Some(support),
        }
    }
    None
}

/// 每个版本的继承链，口径同 [`Petalfall::inheritance_chain`]：不分大小写、断在哪一环就停在那一环（它的 id 收进结果）。
/// 列表要给全部实例算，所以从扫描结果走，不再逐个读版本 JSON。
fn inheritance_chains(scan: &VersionScan) -> HashMap<String, Vec<String>> {
    let by_key: HashMap<String, &VersionJson> = scan
        .versions
        .iter()
        .map(|v| (v.id.to_lowercase(), &v.json))
        .collect();
    scan.versions
        .iter()
        .map(|v| (v.id.clone(), chain_of(&v.id, &by_key)))
        .collect()
}

fn chain_of(id: &str, by_key: &HashMap<String, &VersionJson>) -> Vec<String> {
    let mut seen = HashSet::from([id.to_lowercase()]);
    let mut chain = Vec::new();
    let mut current = id.to_lowercase();
    for _ in 0..MAX_INHERIT_DEPTH {
        let Some(parent) = by_key
            .get(&current)
            .and_then(|json| json.inherits_from.as_deref())
            .filter(|parent| !parent.trim().is_empty())
        else {
            break;
        };
        let key = parent.to_lowercase();
        if !seen.insert(key.clone()) {
            break;
        }
        chain.push(parent.to_owned());
        current = key;
    }
    chain
}

/// 继承链的根版本 id：客户端 jar 与 natives 所在的版本。没有 inheritsFrom 时就是自己。
pub(crate) fn inheritance_root(scan: &VersionScan, id: &str) -> String {
    let by_id: HashMap<&str, &VersionJson> = scan
        .versions
        .iter()
        .map(|v| (v.id.as_str(), &v.json))
        .collect();
    let mut current = id;
    for _ in 0..MAX_INHERIT_DEPTH {
        match by_id.get(current).and_then(|v| v.inherits_from.as_deref()) {
            Some(parent) => current = parent,
            None => break,
        }
    }
    current.to_owned()
}

impl Petalfall {
    /// `id` 继承链上除它自己以外的版本 id，由近及远，最后一个是客户端 jar 与 natives 所在的链根。
    /// 没有 `inheritsFrom` 时为空。
    ///
    /// 只读链上各环的版本 JSON，不扫整个 `versions/`：启动与补全在开局就要它，用来在任务期间占住
    /// 这些基底版本。某一环的 JSON 不在或解析不了时停在那一环（它的 id 已经收进结果）：链断在哪、为什么
    /// 由启动与补全自己按失败码报出，这里提前报错只会把具体的失败原因换成笼统的错误。读文件本身出错
    /// （权限、磁盘）照实报错。`inheritsFrom` 来自盘上的文件，指向不能安全拼进路径的 id 时不再往下读。
    pub async fn inheritance_chain(&self, id: &str) -> Result<Vec<String>> {
        if !is_safe_instance_id(id) {
            return Err(InstanceError::InvalidId { id: id.to_owned() }.into());
        }
        let versions_dir = self.layout().versions_dir();
        // 实例锁与 Windows 的目录名都不分大小写，判环也不分。
        let mut seen = HashSet::from([id.to_lowercase()]);
        let mut chain = Vec::new();
        let mut current = id.to_owned();
        for _ in 0..MAX_INHERIT_DEPTH {
            if !is_safe_instance_id(&current) {
                break;
            }
            let json = match read_version_json(&versions_dir, &current).await {
                Ok(Some(json)) => json,
                Ok(None) | Err(CoreError::Version(_)) => break,
                Err(err) => return Err(err),
            };
            let Some(parent) = json
                .inherits_from
                .filter(|parent| !parent.trim().is_empty())
            else {
                break;
            };
            if !seen.insert(parent.to_lowercase()) {
                break;
            }
            chain.push(parent.clone());
            current = parent;
        }
        Ok(chain)
    }
}

/// 依赖版本记录：导入整合包时新落下的版本目录 id（原版与加载器版本）。
///
/// 目录本身看不出是导入落下的还是别的启动器装的，版本 JSON 一模一样，只有落下的那一刻知道，所以当场记下。
#[derive(Debug, Default, Serialize, Deserialize)]
struct BaseRecord {
    versions: Vec<String>,
}

fn base_record_path(game_dir: &Path) -> PathBuf {
    game_dir.join(PETALFALL_META_DIR).join(BASE_RECORD_FILE)
}

async fn read_base_record(game_dir: &Path) -> Result<BaseRecord> {
    let path = base_record_path(game_dir);
    match tokio::fs::read(&path).await {
        Ok(bytes) => serde_json::from_slice(&bytes)
            .map_err(|source| CoreError::JsonFileInvalid { path, source }),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(BaseRecord::default()),
        Err(source) => Err(petalfall_base::Error::Io { path, source }.into()),
    }
}

/// 改写记录。读不懂的旧内容作废重记：记录只管显示，不该让导入失败。
async fn update_base_record(game_dir: &Path, change: impl FnOnce(&mut Vec<String>)) -> Result<()> {
    let _turn = BASE_RECORD_LOCK.lock().await;
    let mut record = match read_base_record(game_dir).await {
        Err(CoreError::JsonFileInvalid { path, source }) => {
            tracing::warn!(path = %path.display(), error = %source, "依赖版本记录读不懂，作废重记");
            BaseRecord::default()
        }
        read => read?,
    };
    let before = record.versions.clone();
    change(&mut record.versions);
    if record.versions == before {
        return Ok(());
    }
    let bytes = serde_json::to_vec_pretty(&record).map_err(CoreError::JsonSerialize)?;
    petalfall_base::fs::atomic_write(base_record_path(game_dir), &bytes).await?;
    Ok(())
}

/// 在 `game_dir` 的依赖版本记录里补记 `ids`（已有的不重复记），排队同 [`update_base_record`]。实例移动时带到目标
/// 目录的基底版本也是启动器落下的，要记在目标目录名下。
pub(crate) async fn record_base_versions_in(game_dir: &Path, ids: &[String]) -> Result<()> {
    update_base_record(game_dir, |versions| {
        for id in ids {
            if !versions.contains(id) {
                versions.push(id.clone());
            }
        }
    })
    .await
}

impl Petalfall {
    /// 记下导入落下的依赖版本目录。
    pub(crate) async fn record_base_versions(&self, ids: &[String]) -> Result<()> {
        record_base_versions_in(self.game_dir(), ids).await
    }

    /// 安装之后收回 `ids` 里目录没落下的：记录只管启动器落下的目录，日后别的启动器装出同名版本时，它是玩家的。
    pub(crate) async fn forget_unlanded_base_versions(&self, ids: &[String]) -> Result<()> {
        forget_unlanded_base_versions_in(self.game_dir(), ids).await
    }
}

/// 在 `game_dir` 的依赖版本记录里收回 `ids` 中没落下的，排队同 [`update_base_record`]。实例移动在补依赖前
/// 先记下要带的基底版本，没补成时由它收回。
///
/// 落下以 `versions/<id>/<id>.json` 是文件为准，不看目录：安装器与移动都最后才放版本 JSON，目录在、JSON 不在的
/// 是半截（复制到一半只剩 jar），留着记录会把这个修不了的目录一直藏起来，日后再带同名基底过来也只会撞上冲突。
pub(crate) async fn forget_unlanded_base_versions_in(
    game_dir: &Path,
    ids: &[String],
) -> Result<()> {
    let layout = petalfall_install::GameLayout::new(game_dir);
    let mut unlanded = Vec::new();
    for id in ids {
        let json = layout.version_json(id);
        let landed = match tokio::fs::metadata(&json).await {
            Ok(meta) => meta.is_file(),
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => false,
            Err(source) => return Err(petalfall_base::Error::Io { path: json, source }.into()),
        };
        if !landed {
            unlanded.push(id.clone());
        }
    }
    forget_base_versions_in(game_dir, &unlanded).await
}

/// 从 `game_dir` 的依赖版本记录里去掉 `ids`，不看盘上有什么，排队同 [`update_base_record`]。实例移进目标之后对它
/// 自己的 id 调用：目标里同名的记录是那边早已不在的依赖版本留下的，留着会把移过去的实例当成依赖版本藏起来。
pub(crate) async fn forget_base_versions_in(game_dir: &Path, ids: &[String]) -> Result<()> {
    update_base_record(game_dir, |versions| {
        versions.retain(|id| !ids.contains(id));
    })
    .await
}

/// 从扫描结果里去掉玩家没建过的依赖版本目录，列出来它们就像凭空多了实例。实例库、安装目标与侧栏固定都经这里取实例。
///
/// 两种目录算这一类：依赖版本记录里的，没人用了也算；继承着别的版本、又被别的实例继承的加载器版本。这里只改这份
/// 结果：目录不删，继承链、依赖检查、实例占用与查重都不看它。
///
/// 记录里的目录缺版本 JSON 时一样隐藏：导入下载途中它就是这样，进程被杀后也会这样留下。记录读不出来时只有记录这
/// 一条不生效，目录上有实例痕迹的不隐藏，痕迹读不出来的也不隐藏：宁可多列一个，也不把看不清的目录藏起来。
pub(crate) async fn hide_base_versions(game_dir: &Path, scan: &mut VersionScan) {
    let recorded: HashSet<String> = match read_base_record(game_dir).await {
        Ok(record) => record.versions.into_iter().collect(),
        Err(err) => {
            let error = error_with_causes(&err);
            tracing::warn!(%error, "依赖版本记录读不出来，记录里的版本照常列出");
            HashSet::new()
        }
    };
    let found = scan
        .versions
        .iter()
        .filter(|version| {
            recorded.contains(&version.id)
                || (is_natural_loader_version(version)
                    && !dependents_in(scan, &version.id).is_empty())
        })
        .map(|version| (&version.id, &version.dir));
    let broken = scan
        .broken
        .iter()
        .filter(|broken| recorded.contains(&broken.id))
        .map(|broken| (&broken.id, &broken.dir));
    let mut hidden = HashSet::new();
    for (id, dir) in found.chain(broken) {
        match has_instance_traces(dir).await {
            Ok(false) => {
                hidden.insert(id.clone());
            }
            Ok(true) => {}
            Err(err) => {
                let error = error_with_causes(&err);
                tracing::warn!(id, %error, "读不出实例痕迹，版本目录照常列出");
            }
        }
    }
    scan.versions
        .retain(|version| !hidden.contains(&version.id));
    scan.broken.retain(|broken| !hidden.contains(&broken.id));
}

/// 版本目录是不是加载器安装器落下的样子：继承着别的版本，目录名里带着加载器的版本号
/// （`neoforge-21.1.265`、`1.20.1-forge-47.2.0`、`fabric-loader-0.16.10-1.21.1`）。
fn is_natural_loader_version(version: &DiscoveredVersion) -> bool {
    let inherits = version
        .json
        .inherits_from
        .as_deref()
        .is_some_and(|parent| !parent.trim().is_empty());
    inherits
        && version.loaders.iter().any(|loader| {
            loader
                .version
                .as_deref()
                .is_some_and(|number| version.id.contains(number))
        })
}

/// 目录上有没有当实例用过的痕迹：启动器只往实例的元数据目录里写东西（设置、卷宗、会话日志、安装记录、未完成
/// 标记），自带 `mods`、`saves` 时里面是玩家的东西。依赖版本记录里的名字也看它：原目录在启动器之外被删掉后，
/// 玩家可以用这个名字建实例。
async fn has_instance_traces(dir: &Path) -> Result<bool> {
    Ok(has_existing_mods_or_saves(dir).await? || try_exists(&dir.join(PETALFALL_META_DIR)).await?)
}

/// 经 `inheritsFrom` 直接依赖 `id` 的实例。不分大小写，与实例锁、[`Petalfall::inheritance_chain`] 判环和 Windows 的
/// 目录名同一口径：`inheritsFrom` 写的大小写与目录名不同时，那个实例照样靠这个目录运行。
pub(crate) fn dependents_in(scan: &VersionScan, id: &str) -> Vec<String> {
    let key = id.to_lowercase();
    scan.versions
        .iter()
        .filter(|v| {
            v.id.to_lowercase() != key
                && v.json
                    .inherits_from
                    .as_deref()
                    .is_some_and(|parent| parent.to_lowercase() == key)
        })
        .map(|v| v.id.clone())
        .collect()
}

pub(crate) fn ensure_no_dependents(scan: &VersionScan, id: &str) -> Result<()> {
    let dependents = dependents_in(scan, id);
    if dependents.is_empty() {
        return Ok(());
    }
    Err(InstanceError::HasDependents {
        id: id.to_owned(),
        dependents,
    }
    .into())
}

/// 改名中已经完成的一步，失败时按相反顺序撤销。
enum Undo {
    Renamed { from: PathBuf, to: PathBuf },
    Created(PathBuf),
}

fn rename_blocking(old_dir: &Path, new_dir: &Path, old: &str, new: &str) -> Result<()> {
    rename_with(old_dir, new_dir, old, new, |staged| {
        std::fs::remove_file(staged)
    })
}

/// `remove_staged` 删暂存的旧 JSON，由参数给出：删不掉的情形在用例的文件系统上造不出来。
fn rename_with(
    old_dir: &Path,
    new_dir: &Path,
    old: &str,
    new: &str,
    remove_staged: impl FnOnce(&Path) -> std::io::Result<()>,
) -> Result<()> {
    let mut done = Vec::new();
    let outcome = rename_steps(old_dir, new_dir, old, new, &mut done);
    match outcome {
        Ok(staged) => {
            // 到这一步目录、JSON、jar 与 natives 都已是新名字，回滚不了也不该回滚；这里报错的话调用方不再同步
            // 游玩记录、备份与配置引用。留下的暂存文件在元数据目录里，不影响实例，下次改名时被覆盖。
            if let Some(staged) = staged
                && let Err(err) = remove_staged(&staged)
            {
                tracing::warn!(path = %staged.display(), error = %err, "改名已完成，删除暂存的旧版本 JSON 失败");
            }
            Ok(())
        }
        Err(err) => {
            for step in done.into_iter().rev() {
                let undone = match &step {
                    Undo::Renamed { from, to } => std::fs::rename(to, from),
                    Undo::Created(path) => std::fs::remove_file(path),
                };
                if let Err(undo_err) = undone {
                    tracing::warn!(error = %undo_err, "改名失败后还原其中一步也失败了，需要手动检查实例目录");
                }
            }
            Err(err)
        }
    }
}

/// 依次改目录、版本 JSON、jar、natives。返回旧 JSON 暂存文件的路径（全部成功后由调用方删除）。
fn rename_steps(
    old_dir: &Path,
    new_dir: &Path,
    old: &str,
    new: &str,
    done: &mut Vec<Undo>,
) -> Result<Option<PathBuf>> {
    rename_path(old_dir, new_dir, done)?;

    let old_json = new_dir.join(format!("{old}.json"));
    let staged = if old_json.is_file() {
        let bytes = std::fs::read(&old_json).map_err(|source| io_error(&old_json, source))?;
        let rewritten = rewrite_version_id(&bytes, new, &old_json)?;
        // 只改大小写时新旧文件名在 Windows 上指向同一个文件，先挪开旧文件再写新文件才不会互相覆盖。
        let staged = new_dir
            .join(PETALFALL_META_DIR)
            .join(format!("{old}.json{RENAME_STAGED_SUFFIX}"));
        if let Some(parent) = staged.parent() {
            std::fs::create_dir_all(parent).map_err(|source| io_error(parent, source))?;
        }
        rename_path(&old_json, &staged, done)?;
        let new_json = new_dir.join(format!("{new}.json"));
        std::fs::write(&new_json, rewritten).map_err(|source| io_error(&new_json, source))?;
        done.push(Undo::Created(new_json));
        Some(staged)
    } else {
        None
    };

    for (from, to) in [
        (format!("{old}.jar"), format!("{new}.jar")),
        (format!("{old}-natives"), format!("{new}-natives")),
    ] {
        let from = new_dir.join(from);
        if from.exists() {
            rename_path(&from, &new_dir.join(to), done)?;
        }
    }
    Ok(staged)
}

fn rename_path(from: &Path, to: &Path, done: &mut Vec<Undo>) -> Result<()> {
    std::fs::rename(from, to).map_err(|source| io_error(from, source))?;
    done.push(Undo::Renamed {
        from: from.to_path_buf(),
        to: to.to_path_buf(),
    });
    Ok(())
}

fn io_error(path: &Path, source: std::io::Error) -> CoreError {
    petalfall_base::Error::Io {
        path: path.to_path_buf(),
        source,
    }
    .into()
}

/// 把版本 JSON 的 `id` 改成新名字，其余字段原样保留（含本项目没有建模的字段）。
///
/// 原版实例原先靠 id 本身就是版本号（`1.21.1`）认出 MC 版本，改名后就认不出了，所以没有
/// `inheritsFrom` 与 `clientVersion` 时把识别出的版本号写进 `clientVersion`。
fn rewrite_version_id(bytes: &[u8], new_id: &str, path: &Path) -> Result<Vec<u8>> {
    let json_error = |source| InstanceError::Json {
        context: "版本 JSON",
        path: path.to_path_buf(),
        source,
    };
    let parsed: VersionJson = serde_json::from_slice(bytes).map_err(json_error)?;
    let mut value: serde_json::Value = serde_json::from_slice(bytes).map_err(json_error)?;
    let object = value.as_object_mut().ok_or_else(|| InstanceError::Broken {
        id: parsed.id.clone(),
        reason: "版本 JSON 顶层不是对象".to_owned(),
    })?;
    if !object.contains_key("inheritsFrom") && !object.contains_key("clientVersion") {
        let mc = identify_mc_version(&parsed);
        if let (true, Some(version)) = (mc.reliable, mc.value) {
            object.insert(
                "clientVersion".to_owned(),
                serde_json::Value::String(version),
            );
        }
    }
    object.insert(
        "id".to_owned(),
        serde_json::Value::String(new_id.to_owned()),
    );
    serde_json::to_vec_pretty(&value).map_err(|source| json_error(source).into())
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::config::PetalfallConfig;
    use petalfall_instance::{
        IncompleteKind, IncompleteOutcome, InstallSpec, IsolationOverride, IsolationPolicy,
        NameViolation,
    };
    use serde_json::json;
    use std::sync::Mutex;

    use std::collections::BTreeMap;
    use std::sync::atomic::{AtomicUsize, Ordering};

    use petalfall_release::data_format::{StampFile, StampRead, parse_stamp};
    use tokio::time::Instant;

    use crate::data_format::testing::{GuardFixture, LookFn, with_fixture};
    use crate::data_format::{DATA_FORMAT, DirLook, STAMP_FILE};
    use crate::error::GameDirProblem;
    use crate::folders::DIR_PROBE_TIMEOUT;

    pub(crate) fn petalfall_at(root: &Path) -> Petalfall {
        Petalfall::for_test(
            PetalfallConfig::default(),
            root.to_path_buf(),
            root.join(".minecraft"),
        )
    }

    pub(crate) fn write_version(game_dir: &Path, id: &str, json: &str) -> PathBuf {
        let dir = game_dir.join("versions").join(id);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join(format!("{id}.json")), json).unwrap();
        dir
    }

    pub(crate) fn vanilla_json(id: &str) -> String {
        format!(
            r#"{{"id":"{id}","type":"release","mainClass":"net.minecraft.client.main.Main",
                "javaVersion":{{"component":"java-runtime-delta","majorVersion":21}}}}"#
        )
    }

    fn fabric_json(id: &str, parent: &str) -> String {
        format!(
            r#"{{"id":"{id}","inheritsFrom":"{parent}","type":"release",
                "mainClass":"net.fabricmc.loader.impl.launch.knot.KnotClient",
                "libraries":[{{"name":"net.fabricmc:fabric-loader:0.16.10"}}]}}"#
        )
    }

    /// 记下要处理的目录，然后真的删掉（测试里不往用户回收站里塞东西）。
    #[derive(Clone, Default)]
    struct RecordingDisposer(Arc<Mutex<Vec<PathBuf>>>);

    impl Disposer for RecordingDisposer {
        fn dispose(&self, dir: &Path) -> petalfall_instance::Result<()> {
            self.0.lock().unwrap().push(dir.to_path_buf());
            std::fs::remove_dir_all(dir).map_err(|source| InstanceError::Io {
                path: dir.to_path_buf(),
                source,
            })
        }
    }

    #[tokio::test]
    async fn list_instances_reports_versions_broken_entries_settings_and_markers() {
        let tmp = tempfile::tempdir().unwrap();
        let petalfall = petalfall_at(tmp.path());
        let game = petalfall.game_dir().to_path_buf();
        write_version(&game, "1.21.1", &vanilla_json("1.21.1"));
        let modded = write_version(&game, "模组", &fabric_json("模组", "1.21.1"));
        std::fs::create_dir_all(modded.join("mods")).unwrap();
        for name in ["a.jar", "b.jar.disabled", "notes.txt"] {
            std::fs::write(modded.join("mods").join(name), b"x").unwrap();
        }
        for world in ["生存", "创造"] {
            std::fs::create_dir_all(modded.join("saves").join(world)).unwrap();
        }
        // 原版不隔离：公共目录里的存档算在原版头上，不算进隔离的模组实例。
        std::fs::create_dir_all(game.join("saves").join("公共存档")).unwrap();
        std::fs::create_dir_all(game.join("resourcepacks").join("公共材质")).unwrap();
        std::fs::write(game.join("resourcepacks").join("Fresh.zip"), b"PK").unwrap();
        VersionSettingsStore::for_version_dir(&modded)
            .save(&VersionSettings {
                description: Some("周末一起玩".into()),
                cover: Some("cherry_planks".into()),
                ..VersionSettings::default()
            })
            .await
            .unwrap();
        let broken = game.join("versions").join("Broken");
        std::fs::create_dir_all(&broken).unwrap();
        MarkerStore::for_version_dir(&broken)
            .save(&IncompleteMarker::pending(
                IncompleteKind::Install {
                    spec: InstallSpec {
                        mc_version: "1.20.1".into(),
                        loader: None,
                        loader_version: None,
                        use_template: false,
                    },
                },
                42,
            ))
            .await
            .unwrap();

        let list = petalfall.list_instances().await.unwrap();
        let ids: Vec<&str> = list.iter().map(|i| i.id.as_str()).collect();
        assert_eq!(ids, vec!["1.21.1", "Broken", "模组"]);

        let InstanceVersion::Ready(vanilla) = &list[0].version else {
            panic!("原版应可用：{:?}", list[0].version);
        };
        assert_eq!(vanilla.mc_version.as_deref(), Some("1.21.1"));
        assert_eq!(vanilla.java_major, Some(21));
        assert!(vanilla.loaders.is_empty());
        // 原版正式版按默认档位不隔离，数的是公共 mods 目录（不存在为 0）。
        assert_eq!(vanilla.mod_count, Some(0));
        assert_eq!(vanilla.world_count, Some(1));
        assert_eq!(vanilla.resource_pack_count, Some(2));
        assert_eq!(vanilla.isolated, Some(false));
        assert!(list[0].incomplete.is_none());
        assert_eq!(list[0].modpack, Readable::Read(None));
        assert_eq!(list[0].last_crash_at, Readable::Read(None));

        assert_eq!(
            list[1].version,
            InstanceVersion::Broken(BrokenReason::MissingJson)
        );
        let Some(Readable::Read(marker)) = &list[1].incomplete else {
            panic!("应带未完成标记：{:?}", list[1].incomplete);
        };
        assert_eq!(marker.outcome, IncompleteOutcome::Pending);
        assert_eq!(marker.started_at, 42);

        let InstanceVersion::Ready(fabric) = &list[2].version else {
            panic!("模组实例应可用");
        };
        assert_eq!(fabric.mc_version.as_deref(), Some("1.21.1"));
        assert_eq!(fabric.java_major, Some(21), "沿继承链取原版声明的 Java");
        assert_eq!(
            fabric.loaders[0].kind,
            petalfall_version::LoaderKind::Fabric
        );
        assert_eq!(fabric.mod_count, Some(2), "只数 .jar 与 .jar.disabled");
        assert_eq!(fabric.world_count, Some(2));
        assert_eq!(fabric.resource_pack_count, Some(0), "公共目录的资源包不算");
        assert_eq!(fabric.isolated, Some(true), "装了加载器的实例默认隔离");
        let Readable::Read(settings) = &list[2].settings else {
            panic!("设置应可读");
        };
        assert_eq!(settings.description.as_deref(), Some("周末一起玩"));
        assert!(list.iter().all(|i| i.created_at.is_some()));
    }

    #[tokio::test]
    async fn corrupt_settings_are_reported_per_instance_instead_of_failing_the_list() {
        let tmp = tempfile::tempdir().unwrap();
        let petalfall = petalfall_at(tmp.path());
        let dir = write_version(petalfall.game_dir(), "1.21.1", &vanilla_json("1.21.1"));
        std::fs::create_dir_all(dir.join(PETALFALL_META_DIR)).unwrap();
        std::fs::write(dir.join(PETALFALL_META_DIR).join("settings.json"), b"{oops").unwrap();

        let list = petalfall.list_instances().await.unwrap();
        assert!(matches!(list[0].settings, Readable::Unreadable(_)));
        let InstanceVersion::Ready(ready) = &list[0].version else {
            panic!("版本 JSON 本身是好的");
        };
        assert_eq!(ready.mod_count, None, "定不了工作目录就不数");
        assert_eq!(ready.world_count, None);
        assert_eq!(ready.resource_pack_count, None);
        assert_eq!(ready.isolated, None);
    }

    /// 工作目录里的 `mods`、`saves`、`resourcepacks` 打不开（这里是同名普通文件）：只有这个实例数不出来，
    /// 别的实例照常。
    #[tokio::test]
    async fn unreadable_working_dir_is_reported_per_instance_instead_of_failing_the_list() {
        for blocked in ["mods", "saves", "resourcepacks"] {
            let tmp = tempfile::tempdir().unwrap();
            let petalfall = petalfall_at(tmp.path());
            let game = petalfall.game_dir().to_path_buf();
            write_version(&game, "1.21.1", &vanilla_json("1.21.1"));
            let bad = write_version(&game, "模组", &fabric_json("模组", "1.21.1"));
            std::fs::write(bad.join(blocked), b"not a directory").unwrap();

            let list = petalfall.list_instances().await.unwrap();

            let ids: Vec<&str> = list.iter().map(|i| i.id.as_str()).collect();
            assert_eq!(ids, vec!["1.21.1", "模组"]);
            let InstanceVersion::Ready(ready) = &list[1].version else {
                panic!("版本 JSON 本身是好的");
            };
            assert_eq!(ready.mod_count, None, "{blocked}");
            assert_eq!(ready.world_count, None, "{blocked}");
            assert_eq!(ready.resource_pack_count, None, "{blocked}");
            assert_eq!(ready.isolated, None, "{blocked}");
            let reason = list[1].dir_error.as_deref().unwrap();
            assert!(reason.contains(blocked), "{reason}");
            let InstanceVersion::Ready(healthy) = &list[0].version else {
                panic!("原版应可用");
            };
            assert_eq!(healthy.mod_count, Some(0), "{blocked}");
            assert_eq!(list[0].dir_error, None, "{blocked}");
        }
    }

    /// 列表里的资源包数要与内容页读到的资源包一样多：概览卡按前者画读到之前的占位，按后者画读到的行，
    /// 差一个就会在读到时跳一行。随机摆几类条目，两边都要等于按口径算出的数。
    #[tokio::test]
    async fn listed_resource_pack_count_matches_the_instance_content() {
        let seed = fastrand::get_seed();
        let tmp = tempfile::tempdir().unwrap();
        let petalfall = petalfall_at(tmp.path());
        let game = petalfall.game_dir().to_path_buf();
        write_version(&game, "1.21.1", &vanilla_json("1.21.1"));
        let modded = write_version(&game, "模组", &fabric_json("模组", "1.21.1"));
        let packs = modded.join("resourcepacks");
        std::fs::create_dir_all(&packs).unwrap();
        let zips = fastrand::usize(0..6);
        let upper_zips = fastrand::usize(0..3);
        let folders = fastrand::usize(0..4);
        let others = fastrand::usize(0..4);
        for i in 0..zips {
            std::fs::write(packs.join(format!("材质{i}.zip")), b"PK").unwrap();
        }
        for i in 0..upper_zips {
            std::fs::write(packs.join(format!("PACK{i}.ZIP")), b"PK").unwrap();
        }
        for i in 0..folders {
            std::fs::create_dir_all(packs.join(format!("文件夹{i}"))).unwrap();
        }
        for i in 0..others {
            std::fs::write(packs.join(format!("说明{i}.txt")), b"x").unwrap();
        }
        // 模组实例隔离，公共目录的资源包不算在它头上。
        std::fs::create_dir_all(game.join("resourcepacks").join("公共材质")).unwrap();
        let expected = zips + upper_zips + folders;
        let context =
            format!("seed {seed}: {zips} zip, {upper_zips} ZIP, {folders} 文件夹, {others} 其它");

        let list = petalfall.list_instances().await.unwrap();
        let modded = list.iter().find(|i| i.id == "模组").unwrap();
        let InstanceVersion::Ready(ready) = &modded.version else {
            panic!("模组实例应可用：{:?}", modded.version);
        };
        assert_eq!(
            ready.resource_pack_count,
            Some(expected as u32),
            "{context}"
        );
        let content = petalfall.instance_content("模组").await.unwrap();
        assert_eq!(content.resource_packs.len(), expected, "{context}");
    }

    /// 列出目录之后实例目录就没了（别处正删着它）：这一项拿不到创建时刻，整张列表照常出来。
    #[tokio::test]
    async fn instance_dir_vanishing_mid_scan_does_not_fail_the_summary() {
        let tmp = tempfile::tempdir().unwrap();
        let petalfall = petalfall_at(tmp.path());
        let gone = petalfall.game_dir().join("versions").join("刚删掉");
        let entry = Entry::Broken(BrokenVersion {
            id: "刚删掉".into(),
            dir: gone,
            reason: BrokenReason::MissingJson,
        });

        let summary = summarize(
            petalfall.game_dir(),
            petalfall.config().isolation_policy,
            entry,
        )
        .await;

        assert_eq!(summary.id, "刚删掉");
        assert_eq!(summary.created_at, None);
        assert!(summary.dir_error.unwrap().contains("刚删掉"));
    }

    /// 版本 JSON 读不出来的实例在列表里是损坏项，带上原因；同目录下别的实例不受影响。
    #[tokio::test]
    async fn unreadable_version_json_lists_as_broken_with_its_reason() {
        let tmp = tempfile::tempdir().unwrap();
        let petalfall = petalfall_at(tmp.path());
        let game = petalfall.game_dir().to_path_buf();
        write_version(&game, "1.21.1", &vanilla_json("1.21.1"));
        std::fs::create_dir_all(game.join("versions").join("被占").join("被占.json")).unwrap();

        let list = petalfall.list_instances().await.unwrap();

        let ids: Vec<&str> = list.iter().map(|i| i.id.as_str()).collect();
        assert_eq!(ids, vec!["1.21.1", "被占"]);
        assert!(matches!(list[0].version, InstanceVersion::Ready(_)));
        let InstanceVersion::Broken(reason) = &list[1].version else {
            panic!("应为损坏：{:?}", list[1].version);
        };
        let text = broken_reason_text(reason);
        assert!(text.starts_with("版本 JSON 读不出来："), "{text}");
        assert!(text.contains("被占.json"), "{text}");
    }

    /// 版本 JSON 写坏了：概览横幅与实例卡片上「版本 JSON」只说一次，后面跟着坏在哪里。
    #[tokio::test]
    async fn corrupt_version_json_reason_names_the_subject_once() {
        let tmp = tempfile::tempdir().unwrap();
        let petalfall = petalfall_at(tmp.path());
        write_version(petalfall.game_dir(), "写坏了", "{ this is not json }");

        let list = petalfall.list_instances().await.unwrap();

        let InstanceVersion::Broken(reason) = &list[0].version else {
            panic!("应为损坏：{:?}", list[0].version);
        };
        assert_eq!(
            broken_reason_text(reason),
            "版本 JSON 损坏：key must be a string at line 1 column 3"
        );
    }

    /// 整合包来源与最近崩溃时刻随列表给出；这两份附属文件坏了只标在这个实例上，列表照常返回。
    #[tokio::test]
    async fn list_instances_carries_modpack_origin_and_last_crash() {
        let tmp = tempfile::tempdir().unwrap();
        let petalfall = petalfall_at(tmp.path());
        let game = petalfall.game_dir().to_path_buf();
        let pack = write_version(&game, "整合包", &vanilla_json("整合包"));
        let meta = pack.join(PETALFALL_META_DIR);
        std::fs::create_dir_all(&meta).unwrap();
        std::fs::write(
            meta.join("modpack.json"),
            serde_json::to_vec(&json!({
                "schema": 1, "format": "modrinth", "platform": "modrinth",
                "project_id": "1KVo5zza", "version_id": "abc123",
                "name": "Fabulously Optimized", "version": "6.4.0", "minecraft": "1.21.1",
                "loader": null, "remote_files": 80, "override_files": 12, "installed_at": 1
            }))
            .unwrap(),
        )
        .unwrap();
        crate::crashdiag::save_crash_report(
            &pack,
            &crate::crashdiag::CrashReport {
                at: Some(1_700_000_000_000),
                exit_code: Some(-1),
                session_started_at: None,
                log_path: None,
                diagnoses: Vec::new(),
                suspects: Vec::new(),
                java: None,
                max_memory_mb: None,
                warnings: Vec::new(),
                exit_code_note: None,
                scanned_files: Vec::new(),
            },
        )
        .await
        .unwrap();
        let bad = write_version(&game, "坏记录", &vanilla_json("坏记录"));
        let bad_meta = bad.join(PETALFALL_META_DIR);
        std::fs::create_dir_all(&bad_meta).unwrap();
        std::fs::write(bad_meta.join("modpack.json"), b"{oops").unwrap();
        std::fs::write(
            bad_meta.join(crate::crashdiag::CRASH_REPORT_FILE),
            br#"{"format":99,"report":{"at":5}}"#,
        )
        .unwrap();

        let list = petalfall.list_instances().await.unwrap();
        let by_id = |id: &str| list.iter().find(|i| i.id == id).unwrap();
        let Readable::Read(Some(modpack)) = &by_id("整合包").modpack else {
            panic!("应读出整合包信息：{:?}", by_id("整合包").modpack);
        };
        assert_eq!(
            modpack.platform,
            Some(petalfall_modplatform::Platform::Modrinth)
        );
        assert_eq!(modpack.project_id.as_deref(), Some("1KVo5zza"));
        assert_eq!(modpack.name, "Fabulously Optimized");
        assert_eq!(modpack.version.as_deref(), Some("6.4.0"));
        assert_eq!(
            by_id("整合包").last_crash_at,
            Readable::Read(Some(1_700_000_000_000))
        );

        let Readable::Unreadable(modpack_reason) = &by_id("坏记录").modpack else {
            panic!("modpack.json 坏了应报读不出：{:?}", by_id("坏记录").modpack);
        };
        // 顶层文案只有路径，JSON 的行列在原因链里，界面与日志都要看得到
        assert!(modpack_reason.contains("line 1"), "{modpack_reason}");
        let Readable::Unreadable(reason) = &by_id("坏记录").last_crash_at else {
            panic!("格式版本不对应报读不出");
        };
        assert!(
            reason.contains(crate::crashdiag::CRASH_REPORT_FILE),
            "{reason}"
        );
    }

    #[test]
    fn java_major_is_none_when_the_parent_version_is_missing() {
        let child: VersionJson = serde_json::from_str(&fabric_json("f", "1.21.1")).unwrap();
        let old: VersionJson = serde_json::from_str(r#"{"id":"1.5.2","type":"release"}"#).unwrap();
        let by_id: HashMap<&str, &VersionJson> = HashMap::from([("1.5.2", &old)]);
        assert_eq!(declared_java(&child, &by_id), None);
        assert_eq!(declared_java(&old, &by_id), Some(LEGACY_JAVA_MAJOR));
    }

    /// 摘自官方 1.21.1 的游戏参数开头与两个直达块；其余块与此无关。
    fn quick_play_vanilla_json(id: &str) -> String {
        format!(
            r#"{{"id":"{id}","type":"release","mainClass":"net.minecraft.client.main.Main",
                "javaVersion":{{"component":"java-runtime-delta","majorVersion":21}},
                "arguments":{{"game":["--username","${{auth_player_name}}",
                    {{"rules":[{{"action":"allow","features":{{"is_quick_play_singleplayer":true}}}}],"value":["--quickPlaySingleplayer","${{quickPlaySingleplayer}}"]}},
                    {{"rules":[{{"action":"allow","features":{{"is_quick_play_multiplayer":true}}}}],"value":["--quickPlayMultiplayer","${{quickPlayMultiplayer}}"]}}
                ]}}}}"#
        )
    }

    #[tokio::test]
    async fn list_instances_reports_quick_play_support_along_the_inheritance_chain() {
        let tmp = tempfile::tempdir().unwrap();
        let petalfall = petalfall_at(tmp.path());
        let game = petalfall.game_dir().to_path_buf();
        write_version(&game, "1.21.1", &quick_play_vanilla_json("1.21.1"));
        write_version(&game, "织布机", &fabric_json("织布机", "1.21.1"));
        write_version(
            &game,
            "1.12.2",
            r#"{"id":"1.12.2","type":"release","mainClass":"net.minecraft.client.main.Main",
                "minecraftArguments":"--username ${auth_player_name} --version ${version_name}"}"#,
        );
        write_version(&game, "孤儿", &fabric_json("孤儿", "1.20.6"));

        let list = petalfall.list_instances().await.unwrap();
        let support = |id: &str| -> Option<QuickPlaySupport> {
            match &list.iter().find(|i| i.id == id).unwrap().version {
                InstanceVersion::Ready(ready) => ready.quick_play,
                InstanceVersion::Broken(reason) => panic!("{id} 不该损坏：{reason:?}"),
            }
        };
        let both = QuickPlaySupport {
            singleplayer: true,
            multiplayer: true,
        };
        assert_eq!(support("1.21.1"), Some(both));
        // 加载器层自己没有直达块，继承来的原版块照样算。
        assert_eq!(support("织布机"), Some(both));
        assert_eq!(
            support("1.12.2"),
            Some(QuickPlaySupport {
                singleplayer: false,
                multiplayer: true,
            })
        );
        assert_eq!(support("孤儿"), None);
    }

    const NATURAL_NEOFORGE: &str = "neoforge-21.1.265";

    /// NeoForge 安装器写的版本 JSON：版本号在启动参数里。
    fn neoforge_json(id: &str, parent: &str) -> String {
        format!(
            r#"{{"id":"{id}","inheritsFrom":"{parent}","type":"release",
                "mainClass":"cpw.mods.bootstraplauncher.BootstrapLauncher",
                "arguments":{{"game":["--fml.neoForgeVersion","21.1.265"],"jvm":[]}},
                "libraries":[{{"name":"net.neoforged:bus:8.0.5"}}]}}"#
        )
    }

    /// 导入整合包时写进实例元数据目录的记录。
    fn write_pack_info(instance_dir: &Path, minecraft: &str) {
        let meta = instance_dir.join(PETALFALL_META_DIR);
        std::fs::create_dir_all(&meta).unwrap();
        std::fs::write(
            meta.join("modpack.json"),
            serde_json::to_vec(&json!({
                "schema": 1, "format": "modrinth", "platform": null, "project_id": null,
                "version_id": null, "name": "周末整合包", "version": "1.0.0",
                "minecraft": minecraft,
                "loader": {"kind": "neoforge", "version": "21.1.265"},
                "remote_files": 0, "override_files": 0, "installed_at": 1
            }))
            .unwrap(),
        )
        .unwrap();
    }

    /// 写下依赖版本记录，内容与导入记下的同一形状。
    pub(crate) fn write_base_record(game_dir: &Path, ids: &[&str]) {
        let meta = game_dir.join(PETALFALL_META_DIR);
        std::fs::create_dir_all(&meta).unwrap();
        std::fs::write(
            meta.join("base-versions.json"),
            serde_json::to_vec(&json!({ "versions": ids })).unwrap(),
        )
        .unwrap();
    }

    async fn listed_ids(petalfall: &Petalfall) -> Vec<String> {
        let list = petalfall.list_instances().await.unwrap();
        list.into_iter().map(|instance| instance.id).collect()
    }

    fn assert_duplicate_name(err: &CoreError) {
        assert!(
            matches!(
                err,
                CoreError::Instance(InstanceError::InvalidName {
                    violation: NameViolation::Duplicate,
                    ..
                })
            ),
            "{err:?}"
        );
    }

    /// 导入 NeoForge 整合包后盘上的样子：原版与加载器版本是这次新落下的，都在记录里。玩家只建了一个实例，列表里
    /// 就只有这一个；目录留着、名字占着，继承链与依赖检查照常算它们，实例的 Java 与直达方式穿过隐藏的原版算出来。
    #[tokio::test]
    async fn recorded_base_versions_stay_out_of_the_list() {
        let tmp = tempfile::tempdir().unwrap();
        let petalfall = petalfall_at(tmp.path());
        let game = petalfall.game_dir().to_path_buf();
        let vanilla = write_version(&game, "1.21.1", &quick_play_vanilla_json("1.21.1"));
        let natural = write_version(
            &game,
            NATURAL_NEOFORGE,
            &neoforge_json(NATURAL_NEOFORGE, "1.21.1"),
        );
        let pack = write_version(&game, "周末整合包", &neoforge_json("周末整合包", "1.21.1"));
        write_pack_info(&pack, "1.21.1");
        write_base_record(&game, &["1.21.1", NATURAL_NEOFORGE]);

        let list = petalfall.list_instances().await.unwrap();
        let ids: Vec<&str> = list.iter().map(|i| i.id.as_str()).collect();
        assert_eq!(ids, ["周末整合包"]);
        let InstanceVersion::Ready(ready) = &list[0].version else {
            panic!("整合包实例应可用：{:?}", list[0].version);
        };
        assert_eq!(ready.java_major, Some(21));
        assert_eq!(
            ready.quick_play,
            Some(QuickPlaySupport {
                singleplayer: true,
                multiplayer: true,
            })
        );

        assert!(vanilla.join("1.21.1.json").is_file());
        assert!(natural.join(format!("{NATURAL_NEOFORGE}.json")).is_file());
        assert_eq!(
            petalfall.instance_names().await.unwrap(),
            ["1.21.1", NATURAL_NEOFORGE, "周末整合包"]
        );
        for taken in ["1.21.1", NATURAL_NEOFORGE] {
            let err = petalfall.check_new_instance_name(taken).await.unwrap_err();
            assert_duplicate_name(&err);
        }
        assert_eq!(
            petalfall.inheritance_chain("周末整合包").await.unwrap(),
            ["1.21.1"]
        );
        let preview = petalfall.deletion_preview("1.21.1").await.unwrap();
        assert_eq!(preview.dependents, [NATURAL_NEOFORGE, "周末整合包"]);
    }

    /// 别的启动器的游戏目录里已有同款原版与加载器版本：导入时目录原本就在，不进记录，它们是玩家的，整合包用上它们
    /// 也不藏，整合包删掉后还在。
    #[tokio::test]
    async fn versions_that_were_already_there_stay_listed_next_to_a_pack_using_them() {
        let tmp = tempfile::tempdir().unwrap();
        let petalfall = petalfall_at(tmp.path());
        let game = petalfall.game_dir().to_path_buf();
        write_version(&game, "1.21.1", &vanilla_json("1.21.1"));
        write_version(
            &game,
            NATURAL_NEOFORGE,
            &neoforge_json(NATURAL_NEOFORGE, "1.21.1"),
        );
        let pack = write_version(&game, "周末整合包", &neoforge_json("周末整合包", "1.21.1"));
        write_pack_info(&pack, "1.21.1");
        write_base_record(&game, &[]);

        assert_eq!(
            listed_ids(&petalfall).await,
            ["1.21.1", NATURAL_NEOFORGE, "周末整合包"]
        );

        std::fs::remove_dir_all(&pack).unwrap();

        assert_eq!(listed_ids(&petalfall).await, ["1.21.1", NATURAL_NEOFORGE]);
    }

    /// 被继承的自然加载器版本不列出，但它仍是继承链上的一环：Java 与直达方式穿过它算到原版，删除与改名
    /// 照样被依赖检查挡住。
    #[tokio::test]
    async fn hidden_loader_version_stays_on_the_chain_and_behind_the_dependents_check() {
        let tmp = tempfile::tempdir().unwrap();
        let petalfall = petalfall_at(tmp.path());
        let game = petalfall.game_dir().to_path_buf();
        write_version(&game, "1.21.1", &quick_play_vanilla_json("1.21.1"));
        let natural = write_version(
            &game,
            NATURAL_NEOFORGE,
            &neoforge_json(NATURAL_NEOFORGE, "1.21.1"),
        );
        write_version(
            &game,
            "光影叠加",
            &format!(r#"{{"id":"光影叠加","inheritsFrom":"{NATURAL_NEOFORGE}","type":"release"}}"#),
        );

        let list = petalfall.list_instances().await.unwrap();
        let ids: Vec<&str> = list.iter().map(|i| i.id.as_str()).collect();
        assert_eq!(ids, ["1.21.1", "光影叠加"]);
        let InstanceVersion::Ready(on_top) = &list[1].version else {
            panic!("叠在加载器版本上的实例应可用：{:?}", list[1].version);
        };
        assert_eq!(on_top.java_major, Some(21));
        assert_eq!(
            on_top.quick_play,
            Some(QuickPlaySupport {
                singleplayer: true,
                multiplayer: true,
            })
        );

        assert_eq!(
            petalfall.inheritance_chain("光影叠加").await.unwrap(),
            [NATURAL_NEOFORGE, "1.21.1"]
        );
        let preview = petalfall.deletion_preview(NATURAL_NEOFORGE).await.unwrap();
        assert_eq!(preview.dependents, ["光影叠加"]);
        for refused in [
            petalfall
                .delete_instance_files(NATURAL_NEOFORGE, RecordingDisposer::default())
                .await
                .map(|_| ()),
            petalfall
                .rename_instance_files(NATURAL_NEOFORGE, "新名字")
                .await,
        ] {
            let err = refused.unwrap_err();
            assert!(
                matches!(
                    &err,
                    CoreError::Instance(InstanceError::HasDependents { dependents, .. })
                        if dependents == &["光影叠加".to_owned()]
                ),
                "{err:?}"
            );
        }
        assert!(natural.is_dir(), "目录不该被动过");
    }

    /// 这些目录都是玩家的：官方安装器装的版本没有谁继承它，它就是玩家在玩的那个，玩家建了个同款加载器的实例
    /// 也不改变这一点。下面几个被别的实例继承着，但目录上有东西说明它是实例，或者名字压根不是加载器版本。
    #[tokio::test]
    async fn loader_versions_that_belong_to_the_player_stay_in_the_list() {
        let tmp = tempfile::tempdir().unwrap();
        let petalfall = petalfall_at(tmp.path());
        let game = petalfall.game_dir().to_path_buf();
        write_version(&game, "1.21.1", &vanilla_json("1.21.1"));

        let official = "fabric-loader-0.16.10-1.21.1";
        write_version(&game, official, &fabric_json(official, "1.21.1"));
        let built = write_version(
            &game,
            "周末生存",
            r#"{"id":"周末生存","clientVersion":"1.21.1","type":"release",
                "mainClass":"net.fabricmc.loader.impl.launch.knot.KnotClient",
                "libraries":[{"name":"net.fabricmc:fabric-loader:0.16.10"}]}"#,
        );
        petalfall_instance::InstallRecordStore::for_version_dir(&built)
            .save(&InstallSpec {
                mc_version: "1.21.1".into(),
                loader: Some("fabric".into()),
                loader_version: Some("0.16.10".into()),
                use_template: false,
            })
            .await
            .unwrap();

        let configured = write_version(
            &game,
            NATURAL_NEOFORGE,
            &neoforge_json(NATURAL_NEOFORGE, "1.21.1"),
        );
        VersionSettingsStore::for_version_dir(&configured)
            .save(&VersionSettings {
                description: Some("玩家写过介绍".into()),
                ..VersionSettings::default()
            })
            .await
            .unwrap();
        let with_saves = "fabric-loader-0.15.11-1.21.1";
        let dir = write_version(
            &game,
            with_saves,
            &fabric_json(with_saves, "1.21.1").replace("0.16.10", "0.15.11"),
        );
        std::fs::create_dir_all(dir.join("saves").join("新世界")).unwrap();
        // 名字是加载器版本的样子，但版本 JSON 是合并的：这是新建实例写出的样子，玩家可以这样起名。
        let named_like_one = "fabric-loader-0.14.0-1.21.1";
        write_version(
            &game,
            named_like_one,
            &format!(
                r#"{{"id":"{named_like_one}","clientVersion":"1.21.1","type":"release",
                    "libraries":[{{"name":"net.fabricmc:fabric-loader:0.14.0"}}]}}"#
            ),
        );
        write_version(&game, "我的存档版", &fabric_json("我的存档版", "1.21.1"));
        // 整合包本身不藏任何目录，隐藏只看记录与继承。
        let pack = write_version(&game, "同原版的包", &neoforge_json("同原版的包", "1.21.1"));
        write_pack_info(&pack, "1.21.1");
        let pack = write_version(
            &game,
            "同加载器的包",
            &fabric_json("同加载器的包", "1.20.1"),
        );
        write_pack_info(&pack, "1.20.1");
        for (index, parent) in [NATURAL_NEOFORGE, with_saves, named_like_one, "我的存档版"]
            .into_iter()
            .enumerate()
        {
            let id = format!("叠加{index}");
            write_version(
                &game,
                &id,
                &format!(r#"{{"id":"{id}","inheritsFrom":"{parent}","type":"release"}}"#),
            );
        }

        assert_eq!(
            listed_ids(&petalfall).await,
            [
                "1.21.1",
                named_like_one,
                with_saves,
                official,
                NATURAL_NEOFORGE,
                "叠加0",
                "叠加1",
                "叠加2",
                "叠加3",
                "同加载器的包",
                "同原版的包",
                "周末生存",
                "我的存档版",
            ]
        );
    }

    /// 最后一个用它们的整合包删掉后，记录里的版本也不回到列表：它们是导入落下的，玩家没建过。
    #[tokio::test]
    async fn recorded_versions_stay_hidden_once_nothing_uses_them() {
        let tmp = tempfile::tempdir().unwrap();
        let petalfall = petalfall_at(tmp.path());
        let game = petalfall.game_dir().to_path_buf();
        write_version(&game, "1.21.1", &vanilla_json("1.21.1"));
        write_version(
            &game,
            NATURAL_NEOFORGE,
            &neoforge_json(NATURAL_NEOFORGE, "1.21.1"),
        );
        let pack = write_version(&game, "周末整合包", &neoforge_json("周末整合包", "1.21.1"));
        write_pack_info(&pack, "1.21.1");
        write_base_record(&game, &["1.21.1", NATURAL_NEOFORGE]);
        assert_eq!(listed_ids(&petalfall).await, ["周末整合包"]);

        std::fs::remove_dir_all(&pack).unwrap();

        assert!(listed_ids(&petalfall).await.is_empty());
    }

    /// 导入下载途中原版目录还没有版本 JSON，进程被杀后也会这样留下：记录里的目录不因此露出来，不在记录里的
    /// 照常列成损坏。
    #[tokio::test]
    async fn recorded_directory_without_a_version_json_stays_hidden() {
        let tmp = tempfile::tempdir().unwrap();
        let petalfall = petalfall_at(tmp.path());
        let game = petalfall.game_dir().to_path_buf();
        for dir in ["正在下载的原版", "别的坏目录"] {
            std::fs::create_dir_all(game.join("versions").join(dir)).unwrap();
        }
        write_base_record(&game, &["正在下载的原版"]);

        assert_eq!(listed_ids(&petalfall).await, ["别的坏目录"]);
    }

    /// 记录里的目录在启动器之外被删掉后，玩家可以用这个名字建实例：目录上有实例痕迹，它就是实例，不隐藏。
    #[tokio::test]
    async fn instance_under_a_recorded_name_is_listed() {
        let tmp = tempfile::tempdir().unwrap();
        let petalfall = petalfall_at(tmp.path());
        let game = petalfall.game_dir().to_path_buf();
        let built = write_version(&game, "1.21.1", &vanilla_json("1.21.1"));
        petalfall_instance::InstallRecordStore::for_version_dir(&built)
            .save(&InstallSpec {
                mc_version: "1.21.1".into(),
                loader: None,
                loader_version: None,
                use_template: false,
            })
            .await
            .unwrap();
        write_base_record(&game, &["1.21.1"]);

        assert_eq!(listed_ids(&petalfall).await, ["1.21.1"]);
    }

    /// 并行的导入各记各的，谁都不能盖掉别人记下的 id。
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn concurrent_records_keep_every_id() {
        let tmp = tempfile::tempdir().unwrap();
        let petalfall = petalfall_at(tmp.path());
        let mut ids: Vec<String> = (0..16).map(|i| format!("base-{i:02}")).collect();
        let mut set = JoinSet::new();
        for id in &ids {
            let (petalfall, id) = (petalfall.clone(), id.clone());
            set.spawn(async move { petalfall.record_base_versions(&[id]).await });
        }
        while let Some(joined) = set.join_next().await {
            joined.unwrap().unwrap();
        }

        let mut kept = read_base_record(petalfall.game_dir())
            .await
            .unwrap()
            .versions;
        kept.sort();
        ids.sort();
        assert_eq!(kept, ids);
    }

    /// 记录读不懂时导入不该失败：作废重记，这次记下的目录照样隐藏，同一个 id 只记一次。
    #[tokio::test]
    async fn unreadable_base_record_is_rewritten_by_the_next_record() {
        let tmp = tempfile::tempdir().unwrap();
        let petalfall = petalfall_at(tmp.path());
        let game = petalfall.game_dir().to_path_buf();
        let meta = game.join(PETALFALL_META_DIR);
        std::fs::create_dir_all(&meta).unwrap();
        std::fs::write(meta.join("base-versions.json"), b"{oops").unwrap();
        write_version(&game, "1.21.1", &vanilla_json("1.21.1"));
        write_version(&game, "1.20.1", &vanilla_json("1.20.1"));

        for _ in 0..2 {
            petalfall
                .record_base_versions(&["1.21.1".to_owned()])
                .await
                .unwrap();
        }

        assert_eq!(listed_ids(&petalfall).await, ["1.20.1"]);
        assert_eq!(read_base_record(&game).await.unwrap().versions, ["1.21.1"]);
    }

    /// 往指定游戏目录的依赖版本记录里补记：原有的保留，重复的只记一次，门面当前目录的记录不碰；那边还没有记录
    /// 文件时新建。
    #[tokio::test]
    async fn base_versions_are_recorded_under_the_given_game_dir() {
        let tmp = tempfile::tempdir().unwrap();
        let petalfall = petalfall_at(tmp.path());
        let target = tmp.path().join("目标").join(".minecraft");
        write_base_record(&target, &["1.20.1"]);

        let ids: Vec<String> = ["1.21.1", "1.20.1", "neoforge-21.1.265", "1.21.1"]
            .map(str::to_owned)
            .to_vec();
        record_base_versions_in(&target, &ids).await.unwrap();
        assert_eq!(
            read_base_record(&target).await.unwrap().versions,
            ["1.20.1", "1.21.1", "neoforge-21.1.265"]
        );
        assert!(!base_record_path(petalfall.game_dir()).exists());

        let fresh = tmp.path().join("新盘").join(".minecraft");
        record_base_versions_in(&fresh, &["1.21.1".to_owned()])
            .await
            .unwrap();
        assert_eq!(read_base_record(&fresh).await.unwrap().versions, ["1.21.1"]);
    }

    /// 基底版本以版本 JSON 为落下的标志：复制到一半只留下 jar 的目录、空目录、JSON 的位置是个目录的、目录都没有的
    /// 一律收回；JSON 在的留着；不在这次 ids 里的记录不碰。收回之后那些半截目录照常列成损坏，玩家看得见、删得掉。
    #[tokio::test]
    async fn unlanded_bases_are_judged_by_their_version_json() {
        let tmp = tempfile::tempdir().unwrap();
        let petalfall = petalfall_at(tmp.path());
        let game = petalfall.game_dir().to_path_buf();
        write_version(&game, "1.21.1", &vanilla_json("1.21.1"));
        let half = game.join("versions").join("1.20.1");
        std::fs::create_dir_all(&half).unwrap();
        std::fs::write(half.join("1.20.1.jar"), b"client").unwrap();
        std::fs::create_dir_all(game.join("versions").join("空目录")).unwrap();
        std::fs::create_dir_all(game.join("versions").join("怪目录").join("怪目录.json")).unwrap();
        write_base_record(
            &game,
            &["别人的", "1.21.1", "1.20.1", "空目录", "怪目录", "没建的"],
        );
        assert!(listed_ids(&petalfall).await.is_empty());

        let ids: Vec<String> = ["1.21.1", "1.20.1", "空目录", "怪目录", "没建的"]
            .map(str::to_owned)
            .to_vec();
        petalfall.forget_unlanded_base_versions(&ids).await.unwrap();

        assert_eq!(
            read_base_record(&game).await.unwrap().versions,
            ["别人的", "1.21.1"]
        );
        let mut listed = listed_ids(&petalfall).await;
        listed.sort();
        assert_eq!(listed, ["1.20.1", "怪目录", "空目录"]);
    }

    /// 无条件去掉给定 id：目录与版本 JSON 都在也去掉（移过去的实例不能被目标里陈旧的同名记录藏起来），不在记录里的
    /// id 不算错，别的 id 与别的游戏目录的记录不碰；那边还没有记录文件时不凭空建出来。
    #[tokio::test]
    async fn forgetting_base_versions_drops_exactly_the_given_ids() {
        let tmp = tempfile::tempdir().unwrap();
        let petalfall = petalfall_at(tmp.path());
        let target = petalfall.game_dir().to_path_buf();
        let elsewhere = tmp.path().join("别处").join(".minecraft");
        write_version(&target, "1.21.1", &vanilla_json("1.21.1"));
        write_version(&target, "移过来的", &vanilla_json("移过来的"));
        write_base_record(&target, &["1.21.1", "移过来的", "neoforge-21.1.265"]);
        write_base_record(&elsewhere, &["移过来的"]);
        assert!(listed_ids(&petalfall).await.is_empty());

        let ids = ["移过来的".to_owned(), "不在记录里的".to_owned()];
        forget_base_versions_in(&target, &ids).await.unwrap();

        assert_eq!(
            read_base_record(&target).await.unwrap().versions,
            ["1.21.1", "neoforge-21.1.265"]
        );
        assert_eq!(
            read_base_record(&elsewhere).await.unwrap().versions,
            ["移过来的"]
        );
        assert_eq!(listed_ids(&petalfall).await, ["移过来的"]);

        let fresh = tmp.path().join("新盘").join(".minecraft");
        forget_base_versions_in(&fresh, &ids).await.unwrap();
        assert!(!base_record_path(&fresh).exists());
    }

    /// 记录读不懂时认不出哪些是依赖版本：宁可多列一个，也不把看不清的目录藏起来；继承规则不看记录，列表照常返回。
    #[tokio::test]
    async fn unreadable_base_record_hides_nothing_of_its_own() {
        let tmp = tempfile::tempdir().unwrap();
        let petalfall = petalfall_at(tmp.path());
        let game = petalfall.game_dir().to_path_buf();
        write_version(&game, "1.21.1", &vanilla_json("1.21.1"));
        write_version(
            &game,
            NATURAL_NEOFORGE,
            &neoforge_json(NATURAL_NEOFORGE, "1.21.1"),
        );
        write_version(
            &game,
            "光影叠加",
            &format!(r#"{{"id":"光影叠加","inheritsFrom":"{NATURAL_NEOFORGE}","type":"release"}}"#),
        );
        let meta = game.join(PETALFALL_META_DIR);
        std::fs::create_dir_all(&meta).unwrap();
        std::fs::write(meta.join("base-versions.json"), b"{oops").unwrap();

        assert_eq!(listed_ids(&petalfall).await, ["1.21.1", "光影叠加"]);
    }

    #[test]
    fn quick_play_is_none_when_the_parent_version_is_missing() {
        let child: VersionJson = serde_json::from_str(&fabric_json("f", "1.21.1")).unwrap();
        let positional: VersionJson = serde_json::from_str(
            r#"{"id":"1.5.2","type":"release","minecraftArguments":"${auth_player_name} ${auth_session}"}"#,
        )
        .unwrap();
        let by_id: HashMap<&str, &VersionJson> = HashMap::from([("1.5.2", &positional)]);
        assert_eq!(chain_quick_play(&child, &by_id), None);
        assert_eq!(
            chain_quick_play(&positional, &by_id),
            Some(QuickPlaySupport::default())
        );
    }

    #[tokio::test]
    async fn settings_roundtrip_and_invalid_values_are_rejected_without_writing() {
        let tmp = tempfile::tempdir().unwrap();
        let petalfall = petalfall_at(tmp.path());
        write_version(petalfall.game_dir(), "1.21.1", &vanilla_json("1.21.1"));

        let wanted = VersionSettings {
            memory_mb: Some(6144),
            isolation: IsolationOverride::Enabled,
            ..VersionSettings::default()
        };
        petalfall
            .set_instance_settings("1.21.1", &wanted)
            .await
            .unwrap();
        assert_eq!(petalfall.instance_settings("1.21.1").await.unwrap(), wanted);

        let bad = VersionSettings {
            memory_mb: Some(1000),
            ..VersionSettings::default()
        };
        let err = petalfall
            .set_instance_settings("1.21.1", &bad)
            .await
            .unwrap_err();
        assert!(
            matches!(
                err,
                CoreError::Instance(InstanceError::InvalidSettings {
                    field: "memory_mb",
                    ..
                })
            ),
            "实际：{err:?}"
        );
        assert_eq!(petalfall.instance_settings("1.21.1").await.unwrap(), wanted);

        let missing = petalfall.instance_settings("nope").await.unwrap_err();
        assert!(matches!(missing, CoreError::VersionNotInstalled { .. }));
        let unsafe_id = petalfall.instance_settings("../x").await.unwrap_err();
        assert!(matches!(
            unsafe_id,
            CoreError::Instance(InstanceError::InvalidId { .. })
        ));
    }

    #[tokio::test]
    async fn working_dir_follows_the_instance_isolation_override() {
        let tmp = tempfile::tempdir().unwrap();
        let mut petalfall = petalfall_at(tmp.path());
        petalfall.set_isolation_policy(IsolationPolicy::Disabled);
        write_version(petalfall.game_dir(), "1.21.1", &vanilla_json("1.21.1"));
        let shared = petalfall.resolve_working_dir("1.21.1").await.unwrap();
        assert_eq!(shared.working_dir, petalfall.game_dir());

        petalfall
            .set_instance_settings(
                "1.21.1",
                &VersionSettings {
                    isolation: IsolationOverride::Enabled,
                    ..VersionSettings::default()
                },
            )
            .await
            .unwrap();
        let isolated = petalfall.resolve_working_dir("1.21.1").await.unwrap();
        assert!(isolated.isolated);
        assert_eq!(
            isolated.working_dir,
            petalfall.game_dir().join("versions").join("1.21.1")
        );

        let broken_dir = petalfall.game_dir().join("versions").join("坏的");
        std::fs::create_dir_all(&broken_dir).unwrap();
        let err = petalfall.resolve_working_dir("坏的").await.unwrap_err();
        assert!(matches!(
            err,
            CoreError::Instance(InstanceError::Broken { .. })
        ));
    }

    #[tokio::test]
    async fn delete_moves_the_directory_out_and_forget_prunes_pins_and_selection() {
        let tmp = tempfile::tempdir().unwrap();
        let mut petalfall = petalfall_at(tmp.path());
        let dir = write_version(petalfall.game_dir(), "旧世界", &vanilla_json("1.21.1"));
        std::fs::create_dir_all(dir.join("saves").join("w")).unwrap();
        write_version(petalfall.game_dir(), "1.20.1", &vanilla_json("1.20.1"));
        petalfall.set_sidebar_pins(vec!["1.20.1".into(), "旧世界".into()]);
        petalfall.set_selected_version(Some("旧世界".into()));

        let preview = petalfall.deletion_preview("旧世界").await.unwrap();
        assert_eq!(preview.worlds.len(), 1);
        assert_eq!(preview.worlds[0].dir_name, "w");
        assert!(preview.size_bytes > 0);
        assert!(preview.dependents.is_empty());
        assert_eq!(
            preview.backups_dir,
            petalfall
                .game_dir()
                .join(PETALFALL_META_DIR)
                .join("backups")
                .join("instances")
                .join("旧世界")
        );
        assert_eq!(preview.backup_count, 0);

        let disposer = RecordingDisposer::default();
        assert!(
            petalfall
                .delete_instance_files("旧世界", disposer.clone())
                .await
                .unwrap()
        );
        assert!(!dir.exists());
        assert_eq!(*disposer.0.lock().unwrap(), vec![dir.clone()]);
        assert!(petalfall.forget_instance("旧世界"));
        assert_eq!(petalfall.config().sidebar_pins, vec!["1.20.1".to_owned()]);
        assert_eq!(petalfall.config().selected_version, None);

        // 再删一次是幂等的空操作，配置也不再变化。
        assert!(
            !petalfall
                .delete_instance_files("旧世界", disposer.clone())
                .await
                .unwrap()
        );
        assert!(!petalfall.forget_instance("旧世界"));
        assert_eq!(disposer.0.lock().unwrap().len(), 1);
    }

    #[tokio::test]
    async fn delete_and_rename_are_refused_while_another_instance_inherits_from_it() {
        let tmp = tempfile::tempdir().unwrap();
        let petalfall = petalfall_at(tmp.path());
        let parent = write_version(petalfall.game_dir(), "1.21.1", &vanilla_json("1.21.1"));
        write_version(petalfall.game_dir(), "fab", &fabric_json("fab", "1.21.1"));

        let preview = petalfall.deletion_preview("1.21.1").await.unwrap();
        assert_eq!(preview.dependents, vec!["fab".to_owned()]);
        let err = petalfall
            .delete_instance_files("1.21.1", RecordingDisposer::default())
            .await
            .unwrap_err();
        match err {
            CoreError::Instance(InstanceError::HasDependents { id, dependents }) => {
                assert_eq!(id, "1.21.1");
                assert_eq!(dependents, vec!["fab".to_owned()]);
            }
            other => panic!("应报有依赖，实际：{other:?}"),
        }
        assert!(parent.exists());
        let err = petalfall
            .rename_instance_files("1.21.1", "原版")
            .await
            .unwrap_err();
        assert!(matches!(
            err,
            CoreError::Instance(InstanceError::HasDependents { .. })
        ));
        assert!(parent.exists());
    }

    #[tokio::test]
    async fn inheritance_chain_lists_the_bases_up_to_the_root_and_stops_where_the_chain_breaks() {
        let tmp = tempfile::tempdir().unwrap();
        let petalfall = petalfall_at(tmp.path());
        let game = petalfall.game_dir().to_path_buf();
        write_version(&game, "1.20.1", &vanilla_json("1.20.1"));
        write_version(
            &game,
            "fabric-1.20.1",
            &fabric_json("fabric-1.20.1", "1.20.1"),
        );
        // 加载器版本上再叠一层（OptiFine 装在 Fabric 版本上的传统布局）。
        write_version(&game, "叠层", &fabric_json("叠层", "fabric-1.20.1"));

        assert_eq!(
            petalfall.inheritance_chain("叠层").await.unwrap(),
            vec!["fabric-1.20.1".to_owned(), "1.20.1".to_owned()]
        );
        assert_eq!(
            petalfall.inheritance_chain("fabric-1.20.1").await.unwrap(),
            vec!["1.20.1".to_owned()]
        );
        assert!(
            petalfall
                .inheritance_chain("1.20.1")
                .await
                .unwrap()
                .is_empty()
        );
        // 自包含的实例与盘上没有的 id：没有基底。
        assert!(
            petalfall
                .inheritance_chain("没有这个")
                .await
                .unwrap()
                .is_empty()
        );
        // 空白的 inheritsFrom 按没有处理。
        write_version(
            &game,
            "空白",
            r#"{"id":"空白","inheritsFrom":"  ","type":"release","mainClass":"M"}"#,
        );
        assert!(
            petalfall
                .inheritance_chain("空白")
                .await
                .unwrap()
                .is_empty()
        );

        // 父版本不在或 JSON 坏了：它的 id 照样收进来，链停在它那里。
        write_version(&game, "孤儿", &fabric_json("孤儿", "1.19.4"));
        assert_eq!(
            petalfall.inheritance_chain("孤儿").await.unwrap(),
            vec!["1.19.4".to_owned()]
        );
        write_version(&game, "坏父", "{ not json");
        write_version(&game, "坏子", &fabric_json("坏子", "坏父"));
        assert_eq!(
            petalfall.inheritance_chain("坏子").await.unwrap(),
            vec!["坏父".to_owned()]
        );

        // 环（含只差大小写的环）在回到走过的 id 时停下，不把自己算作基底。
        write_version(&game, "环A", &fabric_json("环A", "环b"));
        write_version(&game, "环b", &fabric_json("环b", "环a"));
        assert_eq!(
            petalfall.inheritance_chain("环A").await.unwrap(),
            vec!["环b".to_owned()]
        );
        // 盘上的 inheritsFrom 指向游戏目录之外时收下这个 id 但不去读它。
        write_version(&game, "越界", &fabric_json("越界", "../../secret"));
        assert_eq!(
            petalfall.inheritance_chain("越界").await.unwrap(),
            vec!["../../secret".to_owned()]
        );

        let err = petalfall.inheritance_chain("../x").await.unwrap_err();
        assert!(matches!(
            err,
            CoreError::Instance(InstanceError::InvalidId { .. })
        ));
    }

    /// 列表的 `bases` 从扫描结果走、不逐个读版本 JSON，补全占基底走的是 `inheritance_chain`：两边要断在同一环，
    /// 界面提前说的才是补全真会撞上的那个基底。
    #[tokio::test]
    async fn listed_bases_are_the_inheritance_chain_the_locks_are_taken_along() {
        let tmp = tempfile::tempdir().unwrap();
        let petalfall = petalfall_at(tmp.path());
        let game = petalfall.game_dir().to_path_buf();
        write_version(&game, "1.20.1", &vanilla_json("1.20.1"));
        write_version(
            &game,
            "fabric-1.20.1",
            &fabric_json("fabric-1.20.1", "1.20.1"),
        );
        write_version(&game, "叠层", &fabric_json("叠层", "fabric-1.20.1"));
        write_version(
            &game,
            "空白",
            r#"{"id":"空白","inheritsFrom":"  ","type":"release","mainClass":"M"}"#,
        );
        write_version(&game, "孤儿", &fabric_json("孤儿", "1.19.4"));
        write_version(&game, "坏父", "{ not json");
        write_version(&game, "坏子", &fabric_json("坏子", "坏父"));
        write_version(&game, "环A", &fabric_json("环A", "环b"));
        write_version(&game, "环b", &fabric_json("环b", "环a"));
        write_version(&game, "越界", &fabric_json("越界", "../../secret"));

        let bases_of = |list: &[InstanceSummary], id: &str| -> Vec<String> {
            let found = list.iter().find(|i| i.id == id).unwrap();
            let InstanceVersion::Ready(ready) = &found.version else {
                panic!("{id} 应可用：{:?}", found.version);
            };
            ready.bases.clone()
        };
        let list = petalfall.list_instances().await.unwrap();
        assert_eq!(
            bases_of(&list, "叠层"),
            ["fabric-1.20.1".to_owned(), "1.20.1".to_owned()],
            "由近及远"
        );
        for id in [
            "1.20.1",
            "fabric-1.20.1",
            "叠层",
            "空白",
            "孤儿",
            "坏子",
            "环A",
            "环b",
            "越界",
        ] {
            assert_eq!(
                bases_of(&list, id),
                petalfall.inheritance_chain(id).await.unwrap(),
                "{id}"
            );
        }
    }

    #[tokio::test]
    async fn rename_moves_directory_json_jar_and_natives_and_keeps_the_mc_version() {
        let tmp = tempfile::tempdir().unwrap();
        let mut petalfall = petalfall_at(tmp.path());
        let old_dir = write_version(
            petalfall.game_dir(),
            "1.21.1",
            r#"{"id":"1.21.1","type":"release","mainClass":"M","x-unmodelled":{"keep":true}}"#,
        );
        std::fs::write(old_dir.join("1.21.1.jar"), b"jar").unwrap();
        std::fs::create_dir_all(old_dir.join("1.21.1-natives")).unwrap();
        std::fs::create_dir_all(old_dir.join("saves").join("w")).unwrap();
        petalfall.set_sidebar_pins(vec!["a".into(), "1.21.1".into()]);
        petalfall.set_selected_version(Some("1.21.1".into()));

        petalfall
            .rename_instance_files("1.21.1", "生存服")
            .await
            .unwrap();
        assert!(petalfall.rename_instance_refs("1.21.1", "生存服"));

        let new_dir = petalfall.game_dir().join("versions").join("生存服");
        assert!(!old_dir.exists());
        assert_eq!(std::fs::read(new_dir.join("生存服.jar")).unwrap(), b"jar");
        assert!(new_dir.join("生存服-natives").is_dir());
        assert!(new_dir.join("saves").join("w").is_dir());
        assert!(!new_dir.join("1.21.1.json").exists());
        let json: serde_json::Value =
            serde_json::from_slice(&std::fs::read(new_dir.join("生存服.json")).unwrap()).unwrap();
        assert_eq!(json["id"], "生存服");
        assert_eq!(json["clientVersion"], "1.21.1");
        assert_eq!(json["x-unmodelled"]["keep"], true, "未建模字段原样保留");
        let leftovers: Vec<_> = walk(&new_dir)
            .into_iter()
            .filter(|p| p.to_string_lossy().contains(RENAME_STAGED_SUFFIX))
            .collect();
        assert!(leftovers.is_empty(), "暂存文件应已删除：{leftovers:?}");

        assert_eq!(
            petalfall.config().sidebar_pins,
            vec!["a".to_owned(), "生存服".to_owned()]
        );
        assert_eq!(
            petalfall.config().selected_version.as_deref(),
            Some("生存服")
        );

        let list = petalfall.list_instances().await.unwrap();
        let InstanceVersion::Ready(ready) = &list[0].version else {
            panic!("改名后的实例应可用");
        };
        assert_eq!(list[0].id, "生存服");
        assert_eq!(ready.mc_version.as_deref(), Some("1.21.1"));
    }

    #[tokio::test]
    async fn rename_only_changing_case_keeps_the_json() {
        let tmp = tempfile::tempdir().unwrap();
        let petalfall = petalfall_at(tmp.path());
        write_version(petalfall.game_dir(), "survival", &vanilla_json("1.21.1"));
        petalfall
            .rename_instance_files("survival", "Survival")
            .await
            .unwrap();
        let dir = petalfall.game_dir().join("versions").join("Survival");
        let json: serde_json::Value =
            serde_json::from_slice(&std::fs::read(dir.join("Survival.json")).unwrap()).unwrap();
        assert_eq!(json["id"], "Survival");
        let names = petalfall.instance_names().await.unwrap();
        assert_eq!(names, vec!["Survival".to_owned()]);
    }

    #[tokio::test]
    async fn rename_validates_the_new_name_and_rolls_back_on_failure() {
        let tmp = tempfile::tempdir().unwrap();
        let petalfall = petalfall_at(tmp.path());
        let dir = write_version(petalfall.game_dir(), "a", &vanilla_json("1.21.1"));
        write_version(petalfall.game_dir(), "B", &vanilla_json("1.20.1"));

        for (name, expected) in [
            ("b", NameViolation::Duplicate),
            ("CON", NameViolation::ReservedByWindows),
            ("x ", NameViolation::ReservedByWindows),
            ("a/b", NameViolation::IllegalChar),
        ] {
            let err = petalfall
                .rename_instance_files("a", name)
                .await
                .unwrap_err();
            match err {
                CoreError::Instance(InstanceError::InvalidName { violation, .. }) => {
                    assert_eq!(violation, expected, "{name:?}")
                }
                other => panic!("{name:?} 应报名称不合法，实际：{other:?}"),
            }
        }
        assert!(dir.join("a.json").is_file());

        // 版本 JSON 损坏：改写 id 失败，目录改名要还原。
        std::fs::write(dir.join("a.json"), b"{broken").unwrap();
        let err = petalfall.rename_instance_files("a", "c").await.unwrap_err();
        assert!(
            matches!(err, CoreError::Instance(InstanceError::Json { .. })),
            "实际：{err:?}"
        );
        assert!(dir.join("a.json").is_file(), "失败后目录与 JSON 应还原");
        assert!(!petalfall.game_dir().join("versions").join("c").exists());
    }

    /// 改名已经全部做完、只剩删暂存的旧 JSON：删不掉不能报错，目录已是新名字，报错的话调用方就不再同步游玩
    /// 记录、备份与配置引用，它们全都还指着旧名字。
    #[test]
    fn rename_succeeds_when_the_staged_json_cannot_be_removed() {
        let tmp = tempfile::tempdir().unwrap();
        let old_dir = write_version(tmp.path(), "旧名", &vanilla_json("旧名"));
        std::fs::write(old_dir.join("旧名.jar"), b"jar").unwrap();
        let new_dir = tmp.path().join("versions").join("新名");

        rename_with(&old_dir, &new_dir, "旧名", "新名", |staged| {
            assert!(staged.is_file(), "暂存文件应在：{}", staged.display());
            Err(std::io::ErrorKind::PermissionDenied.into())
        })
        .unwrap();

        assert!(!old_dir.exists());
        assert_eq!(std::fs::read(new_dir.join("新名.jar")).unwrap(), b"jar");
        let json: serde_json::Value =
            serde_json::from_slice(&std::fs::read(new_dir.join("新名.json")).unwrap()).unwrap();
        assert_eq!(json["id"], "新名");
    }

    /// 继承链、实例锁与 Windows 的目录名都不分大小写：`inheritsFrom` 写的大小写与目录名不同时，那个实例照样
    /// 靠这个目录运行，删除与改名不能放行。
    #[tokio::test]
    async fn dependents_are_found_regardless_of_case() {
        let tmp = tempfile::tempdir().unwrap();
        let petalfall = petalfall_at(tmp.path());
        let game = petalfall.game_dir().to_path_buf();
        let base = write_version(&game, "Vanilla-1.21", &vanilla_json("Vanilla-1.21"));
        write_version(&game, "fab", &fabric_json("fab", "vanilla-1.21"));

        let preview = petalfall.deletion_preview("Vanilla-1.21").await.unwrap();
        assert_eq!(preview.dependents, vec!["fab".to_owned()]);
        for err in [
            petalfall
                .delete_instance_files("Vanilla-1.21", RecordingDisposer::default())
                .await
                .unwrap_err(),
            petalfall
                .rename_instance_files("Vanilla-1.21", "底座")
                .await
                .unwrap_err(),
        ] {
            assert!(
                matches!(
                    &err,
                    CoreError::Instance(InstanceError::HasDependents { dependents, .. })
                        if dependents == &["fab".to_owned()]
                ),
                "实际：{err:?}"
            );
        }
        assert!(base.is_dir());
    }

    /// 备份清单坏了是备份自己的问题：删除预览照常给出，份数改数盘上的备份文件。否则确认框打不开，实例就删不掉了。
    #[tokio::test]
    async fn a_corrupt_backup_index_does_not_block_the_deletion_preview() {
        let tmp = tempfile::tempdir().unwrap();
        let petalfall = petalfall_at(tmp.path());
        write_version(petalfall.game_dir(), "生存", &vanilla_json("生存"));
        let world = petalfall
            .instance_backups_dir("生存")
            .unwrap()
            .join("新的世界");
        std::fs::create_dir_all(&world).unwrap();
        std::fs::write(world.join("index.json"), "{ broken").unwrap();
        for name in [
            "1761900000000-manual.zip",
            "1761900000001-auto.zip",
            "1761900000002-manual.zip.part",
            "说明.txt",
        ] {
            std::fs::write(world.join(name), b"x").unwrap();
        }

        let preview = petalfall.deletion_preview("生存").await.unwrap();
        assert_eq!(preview.backup_count, 2);
        assert_eq!(preview.backups_dir, world.parent().unwrap());
    }

    fn pinned(address: &str, instance: Option<&str>) -> crate::config::PinnedServer {
        crate::config::PinnedServer {
            name: address.to_owned(),
            address: address.to_owned(),
            instance: instance.map(str::to_owned),
        }
    }

    fn pinned_instances(petalfall: &Petalfall) -> Vec<(String, Option<String>)> {
        petalfall
            .pinned_servers()
            .iter()
            .map(|s| (s.address.clone(), s.instance.clone()))
            .collect()
    }

    /// 只有固定服务器记住了这个实例（没有侧栏固定、不是当前选中）时，改名与删除也要报配置有变化，
    /// 调用方才会落盘。
    #[test]
    fn rename_and_forget_carry_the_pinned_server_bindings() {
        let tmp = tempfile::tempdir().unwrap();
        let mut petalfall = petalfall_at(tmp.path());
        petalfall
            .set_pinned_servers(vec![
                pinned("a.example", Some("生存")),
                pinned("b.example", Some("创造")),
                pinned("c.example", None),
            ])
            .unwrap();

        assert!(petalfall.rename_instance_refs("生存", "生存 1.21.1"));
        assert_eq!(
            pinned_instances(&petalfall),
            vec![
                ("a.example".to_owned(), Some("生存 1.21.1".to_owned())),
                ("b.example".to_owned(), Some("创造".to_owned())),
                ("c.example".to_owned(), None),
            ]
        );
        assert!(!petalfall.rename_instance_refs("生存", "又一个"));

        assert!(petalfall.forget_instance("生存 1.21.1"));
        assert_eq!(
            pinned_instances(&petalfall),
            vec![
                ("a.example".to_owned(), None),
                ("b.example".to_owned(), Some("创造".to_owned())),
                ("c.example".to_owned(), None),
            ]
        );
        assert!(!petalfall.forget_instance("生存 1.21.1"));
    }

    fn parked(path: &str, pins: &[&str], selected: Option<&str>) -> crate::config::ParkedDirectory {
        crate::config::ParkedDirectory {
            path: PathBuf::from(path),
            sidebar_pins: pins.iter().map(|pin| (*pin).to_owned()).collect(),
            selected_version: selected.map(str::to_owned),
        }
    }

    /// 从当前目录移走（路径写法不同也算）：同删除，侧栏固定、当前选中、固定服务器记住的它都清掉；收起的别的目录
    /// 里同名的引用不动，那是另一个实例。
    #[test]
    fn moving_out_of_the_current_directory_forgets_like_a_delete() {
        let tmp = tempfile::tempdir().unwrap();
        let mut petalfall = petalfall_at(tmp.path());
        petalfall.set_sidebar_pins(vec!["生存".to_owned(), "建筑".to_owned()]);
        petalfall.set_selected_version(Some("生存".to_owned()));
        petalfall
            .set_pinned_servers(vec![
                pinned("a.example", Some("生存")),
                pinned("b.example", Some("建筑")),
            ])
            .unwrap();
        let elsewhere = parked("E:/PCL2/.minecraft", &["生存"], Some("生存"));
        petalfall.config_mut().parked_directories = vec![elsewhere.clone()];
        let current = PathBuf::from(
            petalfall
                .game_dir()
                .display()
                .to_string()
                .to_uppercase()
                .replace('\\', "/"),
        );

        assert!(petalfall.forget_moved_instance("生存", &current));
        assert_eq!(petalfall.config().sidebar_pins, vec!["建筑".to_owned()]);
        assert_eq!(petalfall.config().selected_version, None);
        assert_eq!(
            pinned_instances(&petalfall),
            vec![
                ("a.example".to_owned(), None),
                ("b.example".to_owned(), Some("建筑".to_owned())),
            ]
        );
        assert_eq!(petalfall.config().parked_directories, vec![elsewhere]);
        assert!(!petalfall.forget_moved_instance("生存", &current));
    }

    /// 从收起的目录移走：只改那条记录的固定与选中，当前目录的固定、选中与固定服务器都不动；改完固定与选中都空了的
    /// 整条删掉，同切换目录时收起它们的规则。
    #[test]
    fn moving_out_of_a_parked_directory_only_edits_that_record() {
        let tmp = tempfile::tempdir().unwrap();
        let mut petalfall = petalfall_at(tmp.path());
        petalfall.set_sidebar_pins(vec!["生存".to_owned()]);
        petalfall.set_selected_version(Some("生存".to_owned()));
        petalfall
            .set_pinned_servers(vec![pinned("a.example", Some("生存"))])
            .unwrap();
        let hmcl = parked("E:/HMCL/.minecraft", &["生存"], None);
        petalfall.config_mut().parked_directories = vec![
            parked("E:/PCL2/.minecraft", &["生存", "创造"], Some("生存")),
            hmcl.clone(),
        ];

        assert!(petalfall.forget_moved_instance("生存", Path::new("e:\\pcl2\\.minecraft\\")));
        assert_eq!(
            petalfall.config().parked_directories,
            vec![parked("E:/PCL2/.minecraft", &["创造"], None), hmcl.clone()]
        );
        assert_eq!(petalfall.config().sidebar_pins, vec!["生存".to_owned()]);
        assert_eq!(petalfall.config().selected_version.as_deref(), Some("生存"));
        assert_eq!(
            pinned_instances(&petalfall),
            vec![("a.example".to_owned(), Some("生存".to_owned()))]
        );
        assert!(!petalfall.forget_moved_instance("生存", Path::new("E:/PCL2/.minecraft")));

        assert!(petalfall.forget_moved_instance("生存", Path::new("E:/HMCL/.minecraft")));
        assert_eq!(
            petalfall.config().parked_directories,
            vec![parked("E:/PCL2/.minecraft", &["创造"], None)]
        );
        petalfall
            .config_mut()
            .parked_directories
            .push(parked("F:/mc", &[], Some("只选中")));
        assert!(petalfall.forget_moved_instance("只选中", Path::new("F:/mc")));
        assert_eq!(
            petalfall.config().parked_directories,
            vec![parked("E:/PCL2/.minecraft", &["创造"], None)]
        );
        assert!(!petalfall.forget_moved_instance("生存", Path::new("G:/没记过/.minecraft")));
    }

    #[tokio::test]
    async fn sidebar_pins_reject_overflow_duplicates_and_unknown_ids() {
        let tmp = tempfile::tempdir().unwrap();
        let mut petalfall = petalfall_at(tmp.path());
        let ids: Vec<String> = (1..=6).map(|i| format!("i{i}")).collect();
        for id in &ids {
            write_version(petalfall.game_dir(), id, &vanilla_json("1.21.1"));
        }
        petalfall
            .validate_sidebar_pins(&ids[..MAX_SIDEBAR_PINS])
            .await
            .unwrap();

        let pins_err = |err: CoreError| match err {
            CoreError::Instance(InstanceError::InvalidPins { reason, id }) => (reason, id),
            other => panic!("应报固定列表不合法，实际：{other:?}"),
        };
        let too_many = petalfall.validate_sidebar_pins(&ids).await.unwrap_err();
        assert_eq!(pins_err(too_many), (PinsViolation::TooMany, None));
        let dup = petalfall
            .validate_sidebar_pins(&["i1".into(), "i2".into(), "i1".into()])
            .await
            .unwrap_err();
        assert_eq!(pins_err(dup), (PinsViolation::Duplicate, Some("i1".into())));
        let missing = petalfall
            .validate_sidebar_pins(&["i1".into(), "ghost".into()])
            .await
            .unwrap_err();
        assert_eq!(
            pins_err(missing),
            (PinsViolation::NotFound, Some("ghost".into()))
        );

        petalfall.set_sidebar_pins(vec!["i2".into(), "gone".into(), "i1".into()]);
        assert_eq!(
            petalfall.existing_sidebar_pins().await.unwrap(),
            vec!["i2".to_owned(), "i1".to_owned()]
        );
    }

    /// 固定过的目录后来不列出了：侧栏看不见它，它也不该占名额。损坏的实例照常列在实例库里，固定着就还算。
    #[tokio::test]
    async fn hidden_versions_take_no_sidebar_pin_slot() {
        let tmp = tempfile::tempdir().unwrap();
        let mut petalfall = petalfall_at(tmp.path());
        let game = petalfall.game_dir().to_path_buf();
        write_version(&game, "1.21.1", &vanilla_json("1.21.1"));
        write_version(
            &game,
            NATURAL_NEOFORGE,
            &neoforge_json(NATURAL_NEOFORGE, "1.21.1"),
        );
        write_version(
            &game,
            "光影叠加",
            &format!(r#"{{"id":"光影叠加","inheritsFrom":"{NATURAL_NEOFORGE}","type":"release"}}"#),
        );
        write_base_record(&game, &["1.21.1"]);
        std::fs::create_dir_all(game.join("versions").join("坏的")).unwrap();
        let visible: Vec<String> = (1..=3).map(|i| format!("i{i}")).collect();
        for id in &visible {
            write_version(&game, id, &vanilla_json("1.21.1"));
        }
        let mut pins = vec!["1.21.1".to_owned(), NATURAL_NEOFORGE.to_owned()];
        pins.extend(visible.iter().cloned());
        pins.push("坏的".to_owned());
        pins.push("光影叠加".to_owned());
        petalfall.set_sidebar_pins(pins);

        let existing = petalfall.existing_sidebar_pins().await.unwrap();

        assert_eq!(existing, ["i1", "i2", "i3", "坏的", "光影叠加"]);
        assert_eq!(existing.len(), MAX_SIDEBAR_PINS);
        petalfall.validate_sidebar_pins(&existing).await.unwrap();
    }

    #[tokio::test]
    async fn new_instance_names_are_checked_against_existing_ones_case_insensitively() {
        let tmp = tempfile::tempdir().unwrap();
        let petalfall = petalfall_at(tmp.path());
        petalfall.check_new_instance_name("全新").await.unwrap();
        write_version(petalfall.game_dir(), "Survival", &vanilla_json("1.21.1"));
        let err = petalfall
            .check_new_instance_name("survival")
            .await
            .unwrap_err();
        assert!(matches!(
            err,
            CoreError::Instance(InstanceError::InvalidName {
                violation: NameViolation::Duplicate,
                ..
            })
        ));
    }

    // ---- 游戏目录的数据格式记号 ----

    /// 被更新的预览版抬到 3 的记号。测试经 [`with_fixture`] 把这一版的号当作 2，它就比这一版新。
    pub(crate) const NEWER_STAMP: &str = r#"{"data_format":3,"written_by":"1.1.0-dev.57"}"#;
    /// [`NEWER_STAMP`] 里 `written_by` 的原文。
    pub(crate) const NEWER_WRITER: &str = "1.1.0-dev.57";

    pub(crate) fn own_format(own: u32) -> GuardFixture {
        GuardFixture { own, look: None }
    }

    pub(crate) fn stamp_file(game_dir: &Path) -> PathBuf {
        game_dir.join(PETALFALL_META_DIR).join(STAMP_FILE)
    }

    pub(crate) fn write_stamp(game_dir: &Path, contents: &str) {
        let path = stamp_file(game_dir);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, contents).unwrap();
    }

    /// 目录下每个条目的相对路径、修改时间与文件字节（文件夹不记字节）。前后各拍一次，比对出有没有文件
    /// 被改过、多出或少了。
    pub(crate) fn disk_state(root: &Path) -> BTreeMap<PathBuf, (SystemTime, Option<Vec<u8>>)> {
        walk(root)
            .into_iter()
            .map(|path| {
                let meta = std::fs::metadata(&path).unwrap();
                let bytes = meta.is_file().then(|| std::fs::read(&path).unwrap());
                let relative = path.strip_prefix(root).unwrap().to_owned();
                (relative, (meta.modified().unwrap(), bytes))
            })
            .collect()
    }

    fn unreadable_reason(contents: &str) -> String {
        match parse_stamp(StampFile::Contents(contents.as_bytes())) {
            StampRead::Unreadable { reason } => reason,
            other => panic!("夹具应当读不懂，实际是 {other:?}"),
        }
    }

    /// 有两个实例的游戏目录：原版，以及装了 Mod、有存档与设置、继承原版的模组实例。
    async fn game_dir_with_instances(game_dir: &Path) {
        write_version(game_dir, "1.21.1", &vanilla_json("1.21.1"));
        let modded = write_version(game_dir, "生存", &fabric_json("生存", "1.21.1"));
        std::fs::create_dir_all(modded.join("mods")).unwrap();
        std::fs::write(modded.join("mods").join("sodium.jar"), b"jar").unwrap();
        std::fs::create_dir_all(modded.join("saves").join("世界")).unwrap();
        VersionSettingsStore::for_version_dir(&modded)
            .save(&VersionSettings {
                description: Some("周末一起玩".into()),
                ..VersionSettings::default()
            })
            .await
            .unwrap();
    }

    /// `versions` 是个文件的游戏目录：扫描读它必然出错，交回的错误能看出有没有走到扫描。
    fn game_dir_that_fails_the_scan(game_dir: &Path) {
        std::fs::create_dir_all(game_dir).unwrap();
        std::fs::write(game_dir.join("versions"), b"not a folder").unwrap();
    }

    fn ids(list: &[InstanceSummary]) -> Vec<&str> {
        list.iter().map(|summary| summary.id.as_str()).collect()
    }

    #[tokio::test]
    async fn list_instances_refuses_a_newer_game_dir_and_touches_no_file() {
        let tmp = tempfile::tempdir().unwrap();
        let petalfall = petalfall_at(tmp.path());
        let game = petalfall.game_dir().to_path_buf();
        game_dir_with_instances(&game).await;
        write_stamp(&game, NEWER_STAMP);
        let before = disk_state(tmp.path());

        match with_fixture(own_format(2), petalfall.list_instances())
            .await
            .unwrap_err()
        {
            CoreError::GameDirDataTooNew {
                path,
                found,
                supported,
                written_by,
            } => {
                assert_eq!(path, game);
                assert_eq!((found, supported), (3, 2));
                assert_eq!(written_by.as_deref(), Some(NEWER_WRITER));
            }
            other => panic!("应报游戏目录太新，实际是 {other:?}"),
        }
        assert_eq!(disk_state(tmp.path()), before);
    }

    /// 不换本版号：读不懂与号是多少无关，生产的这条路同样在扫描之前拦下。
    #[tokio::test]
    async fn list_instances_refuses_an_unreadable_stamp_and_touches_no_file() {
        let tmp = tempfile::tempdir().unwrap();
        let petalfall = petalfall_at(tmp.path());
        let game = petalfall.game_dir().to_path_buf();
        game_dir_with_instances(&game).await;
        let contents = r#"{"data_format":"3"}"#;
        write_stamp(&game, contents);
        let before = disk_state(tmp.path());

        match petalfall.list_instances().await.unwrap_err() {
            CoreError::DataFormatUnreadable { path, reason } => {
                assert_eq!(path, game);
                assert_eq!(reason, unreadable_reason(contents));
            }
            other => panic!("应报记号读不懂，实际是 {other:?}"),
        }
        assert_eq!(disk_state(tmp.path()), before);
    }

    #[tokio::test]
    async fn a_refused_game_dir_is_not_scanned() {
        let tmp = tempfile::tempdir().unwrap();
        let petalfall = petalfall_at(tmp.path());
        let game = petalfall.game_dir().to_path_buf();
        game_dir_that_fails_the_scan(&game);

        // 对照：记号等于这一版时放行，扫描照常进行，在 versions 上出错。
        write_stamp(&game, r#"{"data_format":2}"#);
        match with_fixture(own_format(2), petalfall.list_instances())
            .await
            .unwrap_err()
        {
            CoreError::Instance(InstanceError::Io { path, .. }) => {
                assert_eq!(path, game.join("versions"));
            }
            other => panic!("放行后应扫描并在 versions 上出错，实际是 {other:?}"),
        }

        write_stamp(&game, NEWER_STAMP);
        let err = with_fixture(own_format(2), petalfall.list_instances())
            .await
            .unwrap_err();
        assert!(
            matches!(err, CoreError::GameDirDataTooNew { found: 3, .. }),
            "{err:?}"
        );

        write_stamp(&game, "not json");
        let err = with_fixture(own_format(2), petalfall.list_instances())
            .await
            .unwrap_err();
        assert!(
            matches!(&err, CoreError::DataFormatUnreadable { reason, .. } if *reason == unreadable_reason("not json")),
            "{err:?}"
        );
    }

    /// 看目录、读记号超过探测时限：报暂时连不上，不扫描、不抬号；用户重试时及时读到「太新」就照常拦下。
    #[tokio::test(start_paused = true)]
    async fn a_stamp_read_past_the_probe_limit_is_unavailable_and_nothing_is_scanned() {
        let tmp = tempfile::tempdir().unwrap();
        let petalfall = petalfall_at(tmp.path());
        let game = petalfall.game_dir().to_path_buf();
        game_dir_that_fails_the_scan(&game);
        let before = disk_state(tmp.path());
        let calls = Arc::new(AtomicUsize::new(0));
        let look: LookFn = {
            let calls = calls.clone();
            Arc::new(move |_: &Path| {
                let call = calls.fetch_add(1, Ordering::SeqCst);
                Box::pin(async move {
                    if call == 0 {
                        // 挂起的网络盘：迟迟读不完，读完了也只是号更低、该抬号的记号。
                        tokio::time::sleep(DIR_PROBE_TIMEOUT * 3).await;
                        DirLook::Stamp(parse_stamp(StampFile::Missing))
                    } else {
                        DirLook::Stamp(parse_stamp(StampFile::Contents(NEWER_STAMP.as_bytes())))
                    }
                })
            })
        };
        let fixture = GuardFixture {
            own: 2,
            look: Some(look),
        };

        let started = Instant::now();
        let err = with_fixture(fixture.clone(), petalfall.list_instances())
            .await
            .unwrap_err();
        let elapsed = started.elapsed();
        match err {
            CoreError::InvalidGameDirectory { path, problem } => {
                assert_eq!(path, game);
                assert_eq!(problem, GameDirProblem::Unavailable);
            }
            other => panic!("应报暂时连不上，实际是 {other:?}"),
        }
        assert!(elapsed >= DIR_PROBE_TIMEOUT, "提前放弃了：{elapsed:?}");
        assert!(elapsed < DIR_PROBE_TIMEOUT * 5 / 4, "等太久：{elapsed:?}");
        assert_eq!(disk_state(tmp.path()), before, "超时后不该抬号");

        match with_fixture(fixture, petalfall.list_instances())
            .await
            .unwrap_err()
        {
            CoreError::GameDirDataTooNew {
                path,
                found,
                supported,
                written_by,
            } => {
                assert_eq!(path, game);
                assert_eq!((found, supported), (3, 2));
                assert_eq!(written_by.as_deref(), Some(NEWER_WRITER));
            }
            other => panic!("应报游戏目录太新，实际是 {other:?}"),
        }
        assert_eq!(calls.load(Ordering::SeqCst), 2);
        assert_eq!(disk_state(tmp.path()), before);
    }

    #[tokio::test]
    async fn a_missing_game_dir_lists_nothing_and_creates_nothing() {
        let tmp = tempfile::tempdir().unwrap();
        let petalfall = petalfall_at(tmp.path());

        // 本版号取 2：关卡要是在这里写记号，一定会留下文件。
        let list = with_fixture(own_format(2), petalfall.list_instances())
            .await
            .unwrap();
        assert_eq!(list, Vec::<InstanceSummary>::new());
        assert!(!petalfall.game_dir().exists());
        assert_eq!(disk_state(tmp.path()), BTreeMap::new());
    }

    /// 关卡不记「核对过」：两次列实例之间另一台电脑把号抬高了，第二次就拒绝。
    #[tokio::test]
    async fn a_stamp_raised_between_two_listings_is_refused_by_the_second() {
        let tmp = tempfile::tempdir().unwrap();
        let petalfall = petalfall_at(tmp.path());
        let game = petalfall.game_dir().to_path_buf();
        game_dir_with_instances(&game).await;

        // 记号缺失算 1：「使用」方式把它抬到这一版的 2，照常列出。
        let list = with_fixture(own_format(2), petalfall.list_instances())
            .await
            .unwrap();
        assert_eq!(ids(&list), vec!["1.21.1", "生存"]);
        assert_eq!(
            std::fs::read_to_string(stamp_file(&game)).unwrap(),
            r#"{"data_format":2}"#
        );
        // 记号等于这一版：不写，照常列出。
        let before = disk_state(tmp.path());
        let list = with_fixture(own_format(2), petalfall.list_instances())
            .await
            .unwrap();
        assert_eq!(ids(&list), vec!["1.21.1", "生存"]);
        assert_eq!(disk_state(tmp.path()), before);

        write_stamp(&game, NEWER_STAMP);
        match with_fixture(own_format(2), petalfall.list_instances())
            .await
            .unwrap_err()
        {
            CoreError::GameDirDataTooNew {
                found, supported, ..
            } => assert_eq!((found, supported), (3, 2)),
            other => panic!("应报游戏目录太新，实际是 {other:?}"),
        }
    }

    /// 号比这一版大一的记号，`written_by` 同 [`NEWER_STAMP`]。不换本版号，走生产的那条路。
    fn next_format_stamp() -> String {
        format!(
            r#"{{"data_format":{},"written_by":"{NEWER_WRITER}"}}"#,
            DATA_FORMAT + 1
        )
    }

    /// 号等于这一版的记号：关卡放行，什么都不写。
    pub(crate) fn current_format_stamp() -> String {
        format!(r#"{{"data_format":{DATA_FORMAT}}}"#)
    }

    /// 号写成了字符串，哪一版都读不懂。
    const UNREADABLE_STAMP: &str = r#"{"data_format":"3"}"#;

    /// `err` 应是 `game` 被 [`next_format_stamp`] 拦下时的报错：带出记号里的号、这一版的号与写它的版本。
    fn assert_too_new(err: CoreError, game: &Path) {
        match err {
            CoreError::GameDirDataTooNew {
                path,
                found,
                supported,
                written_by,
            } => {
                assert_eq!(path, game);
                assert_eq!((found, supported), (DATA_FORMAT + 1, DATA_FORMAT));
                assert_eq!(written_by.as_deref(), Some(NEWER_WRITER));
            }
            other => panic!("应报游戏目录太新，实际是 {other:?}"),
        }
    }

    /// `err` 应是 `game` 被 [`UNREADABLE_STAMP`] 拦下时的报错。
    fn assert_unreadable(err: CoreError, game: &Path) {
        match err {
            CoreError::DataFormatUnreadable { path, reason } => {
                assert_eq!(path, game);
                assert_eq!(reason, unreadable_reason(UNREADABLE_STAMP));
            }
            other => panic!("应报记号读不懂，实际是 {other:?}"),
        }
    }

    /// 断言某个游戏目录被关卡拦下时报的错，见 [`assert_too_new`]、[`assert_unreadable`]。
    pub(crate) type AssertRefused = fn(CoreError, &Path);

    /// 关卡该拦下的两种记号，与各自该报的错。
    pub(crate) fn refusing_stamps() -> [(String, AssertRefused); 2] {
        [
            (next_format_stamp(), assert_too_new),
            (UNREADABLE_STAMP.to_owned(), assert_unreadable),
        ]
    }

    /// 会往游戏目录写的实例入口，都对 [`game_dir_with_instances`] 里的「生存」下手。
    #[derive(Debug, Clone, Copy)]
    enum InstanceWrite {
        Settings,
        Delete,
        Rename,
    }

    impl InstanceWrite {
        const ALL: [Self; 3] = [Self::Settings, Self::Delete, Self::Rename];

        fn wanted_settings() -> VersionSettings {
            VersionSettings {
                memory_mb: Some(6144),
                ..VersionSettings::default()
            }
        }

        async fn run(self, petalfall: &Petalfall) -> Result<()> {
            match self {
                Self::Settings => {
                    petalfall
                        .set_instance_settings("生存", &Self::wanted_settings())
                        .await
                }
                Self::Delete => petalfall
                    .delete_instance_files("生存", RecordingDisposer::default())
                    .await
                    .map(|_existed| ()),
                Self::Rename => petalfall.rename_instance_files("生存", "创造").await,
            }
        }

        /// 放行时这次写入在盘上留下的结果。
        async fn assert_landed(self, game: &Path) {
            let versions = game.join("versions");
            match self {
                Self::Settings => assert_eq!(
                    VersionSettingsStore::for_version_dir(&versions.join("生存"))
                        .load()
                        .await
                        .unwrap(),
                    Self::wanted_settings()
                ),
                Self::Delete => assert!(!versions.join("生存").exists()),
                Self::Rename => {
                    assert!(!versions.join("生存").exists());
                    assert!(versions.join("创造").join("创造.json").is_file());
                }
            }
        }
    }

    /// 任务重试与列实例被拒后留下的旧列表都不经过列实例：每个写入口自己在动盘之前拦下。
    #[tokio::test]
    async fn instance_writes_refuse_a_newer_or_unreadable_game_dir_and_touch_no_file() {
        for write in InstanceWrite::ALL {
            let tmp = tempfile::tempdir().unwrap();
            let petalfall = petalfall_at(tmp.path());
            let game = petalfall.game_dir().to_path_buf();
            game_dir_with_instances(&game).await;
            for (stamp, assert_refused) in refusing_stamps() {
                write_stamp(&game, &stamp);
                let before = disk_state(tmp.path());
                let Err(err) = write.run(&petalfall).await else {
                    panic!("{write:?} 应被记号 {stamp} 拦下");
                };
                assert_refused(err, &game);
                assert_eq!(disk_state(tmp.path()), before, "{write:?} 被拦下后动了盘");
            }

            // 对照：号等于这一版时放行，这次写入真的落盘，上面盘面没变不是因为它本来就不写。
            write_stamp(&game, &current_format_stamp());
            write.run(&petalfall).await.unwrap();
            write.assert_landed(&game).await;
        }
    }

    fn walk(dir: &Path) -> Vec<PathBuf> {
        let mut out = Vec::new();
        let mut stack = vec![dir.to_path_buf()];
        while let Some(current) = stack.pop() {
            for entry in std::fs::read_dir(&current).unwrap().flatten() {
                let path = entry.path();
                if path.is_dir() {
                    stack.push(path.clone());
                }
                out.push(path);
            }
        }
        out
    }
}
