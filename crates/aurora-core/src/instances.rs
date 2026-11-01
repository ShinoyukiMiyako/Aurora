//! 实例管理：列表、设置、内容、工作目录、删除、改名与侧栏固定。
//!
//! 实例就是游戏目录 `versions/` 下的一个版本目录，目录名即实例 id。这里的操作只碰本地文件，
//! 安装与补全在 [`crate::instance_install`]。id 来自前端，是不可信输入，拼进任何路径之前都先过
//! [`is_safe_instance_id`]。
//!
//! 改名与删除会牵连两类引用：别的实例经 `inheritsFrom` 依赖它（传统布局的加载器版本），这种情况
//! 直接拒绝；配置里的侧栏固定、当前选中与固定服务器记住的实例由调用方拿到写锁后经
//! [`Aurora::rename_instance_refs`] / [`Aurora::forget_instance`] 同步再落盘，文件操作本身在快照上做，不占门面锁。

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use aurora_instance::{
    AURORA_META_DIR, BrokenReason, BrokenVersion, DiscoveredVersion, Disposer, IncompleteMarker,
    InstanceContent, MarkerStore, PinsViolation, VersionProbe, VersionScan, VersionSettings,
    VersionSettingsStore, WorldEntry, check_instance_name, count_mod_files, count_worlds,
    dir_footprint, discover_versions, is_backup_file_name, is_safe_instance_id, list_version_dirs,
    list_worlds, probe_version, read_instance_content, resolve_isolation,
};
use aurora_launch::{QuickPlaySupport, quick_play_support};
use aurora_version::{LoaderInfo, VersionJson, identify_mc_version};
use tokio::sync::Semaphore;
use tokio::task::JoinSet;

use crate::InstanceError;
use crate::crashdiag::last_crash_at;
use crate::error::{CoreError, Result};
use crate::facade::Aurora;
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
const RENAME_STAGED_SUFFIX: &str = concat!(".", aurora_base::app_slug!(), "-rename");

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
    /// 实例目录的创建时刻（Unix 毫秒）；文件系统不记录创建时间时为 `None`。
    pub created_at: Option<u64>,
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
    /// 工作目录 `mods/` 下的 Mod 文件数；设置文件读不出、定不了工作目录时为 `None`。
    pub mod_count: Option<u32>,
    /// 工作目录 `saves/` 下的存档数，口径同 [`count_worlds`]；何时为 `None` 同 `mod_count`。
    pub world_count: Option<u32>,
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

impl Aurora {
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
            Err(source) => Err(aurora_base::Error::Io { path: dir, source }.into()),
        }
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
    /// 版本 JSON 解析走进程内缓存，文件没变就不重读。
    pub async fn list_instances(&self) -> Result<Vec<InstanceSummary>> {
        let scan = discover_versions(self.game_dir()).await?;
        let javas = java_majors(&scan);
        let quick_plays = quick_play_supports(&scan);
        let mut entries: Vec<Entry> = scan
            .versions
            .into_iter()
            .map(|version| {
                let java = javas.get(&version.id).copied().flatten();
                let quick_play = quick_plays.get(&version.id).copied().flatten();
                Entry::Found(Box::new(version), java, quick_play)
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
            slots[index] = Some(summary?);
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

    /// 整份写入实例设置；任一字段不合法报 [`InstanceError::InvalidSettings`]，不改动文件。
    pub async fn set_instance_settings(&self, id: &str, settings: &VersionSettings) -> Result<()> {
        settings
            .validate()
            .map_err(|violation| InstanceError::InvalidSettings {
                field: violation.field,
                reason: violation.reason,
            })?;
        let dir = self.existing_instance_dir(id).await?;
        VersionSettingsStore::for_version_dir(&dir)
            .save(settings)
            .await?;
        Ok(())
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
    /// 只处理文件；配置里的引用由调用方随后经 [`Aurora::forget_instance`] 清掉。
    pub async fn delete_instance_files(
        &self,
        id: &str,
        disposer: impl Disposer + 'static,
    ) -> Result<bool> {
        let dir = self.instance_dir(id)?;
        match tokio::fs::metadata(&dir).await {
            Ok(meta) if meta.is_dir() => {}
            Ok(_) => return Err(not_installed(id)),
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(false),
            Err(source) => return Err(aurora_base::Error::Io { path: dir, source }.into()),
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

    /// 改名：实例目录、版本 JSON（文件名与其中的 `id`）、客户端 jar 与 natives 目录一起改。
    ///
    /// 新名字按命名规则校验（不分大小写重名，自己除外）；有实例依赖它时拒绝。中途失败时把已经改掉的
    /// 逐项改回去再报错。只处理文件；配置里的引用由调用方随后经 [`Aurora::rename_instance_refs`] 同步。
    pub async fn rename_instance_files(&self, old: &str, new: &str) -> Result<()> {
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

    /// 配置里固定的实例中当前仍然存在的那些，保持顺序。
    pub async fn existing_sidebar_pins(&self) -> Result<Vec<String>> {
        let names: HashSet<String> = self.instance_names().await?.into_iter().collect();
        Ok(self
            .config()
            .sidebar_pins
            .iter()
            .filter(|pin| names.contains(*pin))
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
    }
}

enum Entry {
    Found(
        Box<DiscoveredVersion>,
        Option<u32>,
        Option<QuickPlaySupport>,
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

async fn summarize(
    game_dir: &Path,
    policy: aurora_instance::IsolationPolicy,
    entry: Entry,
) -> Result<InstanceSummary> {
    let (id, dir) = match &entry {
        Entry::Found(version, ..) => (version.id.clone(), version.dir.clone()),
        Entry::Broken(broken) => (broken.id.clone(), broken.dir.clone()),
    };
    let settings = match VersionSettingsStore::for_version_dir(&dir).load().await {
        Ok(settings) => Readable::Read(settings),
        Err(err) => {
            tracing::warn!(id, error = %err, "实例设置读不出来");
            Readable::Unreadable(err.to_string())
        }
    };
    let incomplete = match MarkerStore::for_version_dir(&dir).load().await {
        Ok(marker) => marker.map(Readable::Read),
        Err(err) => {
            tracing::warn!(id, error = %err, "未完成标记读不出来");
            Some(Readable::Unreadable(err.to_string()))
        }
    };
    // 整合包信息与崩溃记录是附属文件：读不出来只标在这一个实例上，和设置文件同一口径。
    let modpack = match read_instance_modpack(&dir).await {
        Ok(modpack) => Readable::Read(modpack),
        Err(err) => {
            tracing::warn!(id, error = %err, "整合包信息读不出来");
            Readable::Unreadable(err.to_string())
        }
    };
    let last_crash_at = match last_crash_at(&dir).await {
        Ok(at) => Readable::Read(at),
        Err(err) => {
            tracing::warn!(id, error = %err, "崩溃记录读不出来");
            Readable::Unreadable(err.to_string())
        }
    };
    let meta = tokio::fs::metadata(&dir)
        .await
        .map_err(|source| aurora_base::Error::Io {
            path: dir.clone(),
            source,
        })?;
    // created() 报错只意味着这个文件系统不记录创建时间。
    let created_at = meta.created().ok().and_then(unix_millis);

    let version = match entry {
        Entry::Broken(broken) => InstanceVersion::Broken(broken.reason),
        Entry::Found(version, java_major, quick_play) => {
            let workdir = match &settings {
                Readable::Read(settings) => {
                    let resolved = resolve_isolation(
                        game_dir,
                        &id,
                        policy,
                        settings.isolation,
                        version.has_mod_loader(),
                        version.is_release(),
                    )
                    .await?;
                    let mods = count_mod_files(&resolved.working_dir.join("mods")).await?;
                    let worlds = count_worlds(&resolved.working_dir.join("saves")).await?;
                    Some((mods, worlds, resolved.isolated))
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
                mod_count: workdir.map(|(mods, _, _)| mods),
                world_count: workdir.map(|(_, worlds, _)| worlds),
                isolated: workdir.map(|(_, _, isolated)| isolated),
            })
        }
    };
    Ok(InstanceSummary {
        id,
        dir,
        version,
        settings,
        incomplete,
        created_at,
        modpack,
        last_crash_at,
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

impl Aurora {
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

/// 经 `inheritsFrom` 直接依赖 `id` 的实例。不分大小写，与实例锁、[`Aurora::inheritance_chain`] 判环和 Windows 的
/// 目录名同一口径：`inheritsFrom` 写的大小写与目录名不同时，那个实例照样靠这个目录运行。
fn dependents_in(scan: &VersionScan, id: &str) -> Vec<String> {
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

fn ensure_no_dependents(scan: &VersionScan, id: &str) -> Result<()> {
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
    let mut done = Vec::new();
    let outcome = rename_steps(old_dir, new_dir, old, new, &mut done);
    match outcome {
        Ok(staged) => {
            if let Some(staged) = staged {
                std::fs::remove_file(&staged).map_err(|source| io_error(&staged, source))?;
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
            .join(AURORA_META_DIR)
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
    aurora_base::Error::Io {
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
    use crate::config::AuroraConfig;
    use aurora_instance::{
        IncompleteKind, IncompleteOutcome, InstallSpec, IsolationOverride, IsolationPolicy,
        NameViolation,
    };
    use serde_json::json;
    use std::sync::Mutex;

    pub(crate) fn aurora_at(root: &Path) -> Aurora {
        Aurora::for_test(
            AuroraConfig::default(),
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
        fn dispose(&self, dir: &Path) -> aurora_instance::Result<()> {
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
        let aurora = aurora_at(tmp.path());
        let game = aurora.game_dir().to_path_buf();
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

        let list = aurora.list_instances().await.unwrap();
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
        assert_eq!(fabric.loaders[0].kind, aurora_version::LoaderKind::Fabric);
        assert_eq!(fabric.mod_count, Some(2), "只数 .jar 与 .jar.disabled");
        assert_eq!(fabric.world_count, Some(2));
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
        let aurora = aurora_at(tmp.path());
        let dir = write_version(aurora.game_dir(), "1.21.1", &vanilla_json("1.21.1"));
        std::fs::create_dir_all(dir.join(AURORA_META_DIR)).unwrap();
        std::fs::write(dir.join(AURORA_META_DIR).join("settings.json"), b"{oops").unwrap();

        let list = aurora.list_instances().await.unwrap();
        assert!(matches!(list[0].settings, Readable::Unreadable(_)));
        let InstanceVersion::Ready(ready) = &list[0].version else {
            panic!("版本 JSON 本身是好的");
        };
        assert_eq!(ready.mod_count, None, "定不了工作目录就不数");
        assert_eq!(ready.world_count, None);
        assert_eq!(ready.isolated, None);
    }

    /// 整合包来源与最近崩溃时刻随列表给出；这两份附属文件坏了只标在这个实例上，列表照常返回。
    #[tokio::test]
    async fn list_instances_carries_modpack_origin_and_last_crash() {
        let tmp = tempfile::tempdir().unwrap();
        let aurora = aurora_at(tmp.path());
        let game = aurora.game_dir().to_path_buf();
        let pack = write_version(&game, "整合包", &vanilla_json("整合包"));
        let meta = pack.join(AURORA_META_DIR);
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
        let bad_meta = bad.join(AURORA_META_DIR);
        std::fs::create_dir_all(&bad_meta).unwrap();
        std::fs::write(bad_meta.join("modpack.json"), b"{oops").unwrap();
        std::fs::write(
            bad_meta.join(crate::crashdiag::CRASH_REPORT_FILE),
            br#"{"format":99,"report":{"at":5}}"#,
        )
        .unwrap();

        let list = aurora.list_instances().await.unwrap();
        let by_id = |id: &str| list.iter().find(|i| i.id == id).unwrap();
        let Readable::Read(Some(modpack)) = &by_id("整合包").modpack else {
            panic!("应读出整合包信息：{:?}", by_id("整合包").modpack);
        };
        assert_eq!(
            modpack.platform,
            Some(aurora_modplatform::Platform::Modrinth)
        );
        assert_eq!(modpack.project_id.as_deref(), Some("1KVo5zza"));
        assert_eq!(modpack.name, "Fabulously Optimized");
        assert_eq!(modpack.version.as_deref(), Some("6.4.0"));
        assert_eq!(
            by_id("整合包").last_crash_at,
            Readable::Read(Some(1_700_000_000_000))
        );

        assert!(matches!(by_id("坏记录").modpack, Readable::Unreadable(_)));
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
        let aurora = aurora_at(tmp.path());
        let game = aurora.game_dir().to_path_buf();
        write_version(&game, "1.21.1", &quick_play_vanilla_json("1.21.1"));
        write_version(&game, "织布机", &fabric_json("织布机", "1.21.1"));
        write_version(
            &game,
            "1.12.2",
            r#"{"id":"1.12.2","type":"release","mainClass":"net.minecraft.client.main.Main",
                "minecraftArguments":"--username ${auth_player_name} --version ${version_name}"}"#,
        );
        write_version(&game, "孤儿", &fabric_json("孤儿", "1.20.6"));

        let list = aurora.list_instances().await.unwrap();
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
        let aurora = aurora_at(tmp.path());
        write_version(aurora.game_dir(), "1.21.1", &vanilla_json("1.21.1"));

        let wanted = VersionSettings {
            memory_mb: Some(6144),
            isolation: IsolationOverride::Enabled,
            ..VersionSettings::default()
        };
        aurora
            .set_instance_settings("1.21.1", &wanted)
            .await
            .unwrap();
        assert_eq!(aurora.instance_settings("1.21.1").await.unwrap(), wanted);

        let bad = VersionSettings {
            memory_mb: Some(1000),
            ..VersionSettings::default()
        };
        let err = aurora
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
        assert_eq!(aurora.instance_settings("1.21.1").await.unwrap(), wanted);

        let missing = aurora.instance_settings("nope").await.unwrap_err();
        assert!(matches!(missing, CoreError::VersionNotInstalled { .. }));
        let unsafe_id = aurora.instance_settings("../x").await.unwrap_err();
        assert!(matches!(
            unsafe_id,
            CoreError::Instance(InstanceError::InvalidId { .. })
        ));
    }

    #[tokio::test]
    async fn working_dir_follows_the_instance_isolation_override() {
        let tmp = tempfile::tempdir().unwrap();
        let mut aurora = aurora_at(tmp.path());
        aurora.set_isolation_policy(IsolationPolicy::Disabled);
        write_version(aurora.game_dir(), "1.21.1", &vanilla_json("1.21.1"));
        let shared = aurora.resolve_working_dir("1.21.1").await.unwrap();
        assert_eq!(shared.working_dir, aurora.game_dir());

        aurora
            .set_instance_settings(
                "1.21.1",
                &VersionSettings {
                    isolation: IsolationOverride::Enabled,
                    ..VersionSettings::default()
                },
            )
            .await
            .unwrap();
        let isolated = aurora.resolve_working_dir("1.21.1").await.unwrap();
        assert!(isolated.isolated);
        assert_eq!(
            isolated.working_dir,
            aurora.game_dir().join("versions").join("1.21.1")
        );

        let broken_dir = aurora.game_dir().join("versions").join("坏的");
        std::fs::create_dir_all(&broken_dir).unwrap();
        let err = aurora.resolve_working_dir("坏的").await.unwrap_err();
        assert!(matches!(
            err,
            CoreError::Instance(InstanceError::Broken { .. })
        ));
    }

    #[tokio::test]
    async fn delete_moves_the_directory_out_and_forget_prunes_pins_and_selection() {
        let tmp = tempfile::tempdir().unwrap();
        let mut aurora = aurora_at(tmp.path());
        let dir = write_version(aurora.game_dir(), "旧世界", &vanilla_json("1.21.1"));
        std::fs::create_dir_all(dir.join("saves").join("w")).unwrap();
        write_version(aurora.game_dir(), "1.20.1", &vanilla_json("1.20.1"));
        aurora.set_sidebar_pins(vec!["1.20.1".into(), "旧世界".into()]);
        aurora.set_selected_version(Some("旧世界".into()));

        let preview = aurora.deletion_preview("旧世界").await.unwrap();
        assert_eq!(preview.worlds.len(), 1);
        assert_eq!(preview.worlds[0].dir_name, "w");
        assert!(preview.size_bytes > 0);
        assert!(preview.dependents.is_empty());
        assert_eq!(
            preview.backups_dir,
            aurora
                .game_dir()
                .join(AURORA_META_DIR)
                .join("backups")
                .join("instances")
                .join("旧世界")
        );
        assert_eq!(preview.backup_count, 0);

        let disposer = RecordingDisposer::default();
        assert!(
            aurora
                .delete_instance_files("旧世界", disposer.clone())
                .await
                .unwrap()
        );
        assert!(!dir.exists());
        assert_eq!(*disposer.0.lock().unwrap(), vec![dir.clone()]);
        assert!(aurora.forget_instance("旧世界"));
        assert_eq!(aurora.config().sidebar_pins, vec!["1.20.1".to_owned()]);
        assert_eq!(aurora.config().selected_version, None);

        // 再删一次是幂等的空操作，配置也不再变化。
        assert!(
            !aurora
                .delete_instance_files("旧世界", disposer.clone())
                .await
                .unwrap()
        );
        assert!(!aurora.forget_instance("旧世界"));
        assert_eq!(disposer.0.lock().unwrap().len(), 1);
    }

    #[tokio::test]
    async fn delete_and_rename_are_refused_while_another_instance_inherits_from_it() {
        let tmp = tempfile::tempdir().unwrap();
        let aurora = aurora_at(tmp.path());
        let parent = write_version(aurora.game_dir(), "1.21.1", &vanilla_json("1.21.1"));
        write_version(aurora.game_dir(), "fab", &fabric_json("fab", "1.21.1"));

        let preview = aurora.deletion_preview("1.21.1").await.unwrap();
        assert_eq!(preview.dependents, vec!["fab".to_owned()]);
        let err = aurora
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
        let err = aurora
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
        let aurora = aurora_at(tmp.path());
        let game = aurora.game_dir().to_path_buf();
        write_version(&game, "1.20.1", &vanilla_json("1.20.1"));
        write_version(
            &game,
            "fabric-1.20.1",
            &fabric_json("fabric-1.20.1", "1.20.1"),
        );
        // 加载器版本上再叠一层（OptiFine 装在 Fabric 版本上的传统布局）。
        write_version(&game, "叠层", &fabric_json("叠层", "fabric-1.20.1"));

        assert_eq!(
            aurora.inheritance_chain("叠层").await.unwrap(),
            vec!["fabric-1.20.1".to_owned(), "1.20.1".to_owned()]
        );
        assert_eq!(
            aurora.inheritance_chain("fabric-1.20.1").await.unwrap(),
            vec!["1.20.1".to_owned()]
        );
        assert!(aurora.inheritance_chain("1.20.1").await.unwrap().is_empty());
        // 自包含的实例与盘上没有的 id：没有基底。
        assert!(
            aurora
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
        assert!(aurora.inheritance_chain("空白").await.unwrap().is_empty());

        // 父版本不在或 JSON 坏了：它的 id 照样收进来，链停在它那里。
        write_version(&game, "孤儿", &fabric_json("孤儿", "1.19.4"));
        assert_eq!(
            aurora.inheritance_chain("孤儿").await.unwrap(),
            vec!["1.19.4".to_owned()]
        );
        write_version(&game, "坏父", "{ not json");
        write_version(&game, "坏子", &fabric_json("坏子", "坏父"));
        assert_eq!(
            aurora.inheritance_chain("坏子").await.unwrap(),
            vec!["坏父".to_owned()]
        );

        // 环（含只差大小写的环）在回到走过的 id 时停下，不把自己算作基底。
        write_version(&game, "环A", &fabric_json("环A", "环b"));
        write_version(&game, "环b", &fabric_json("环b", "环a"));
        assert_eq!(
            aurora.inheritance_chain("环A").await.unwrap(),
            vec!["环b".to_owned()]
        );
        // 盘上的 inheritsFrom 指向游戏目录之外时收下这个 id 但不去读它。
        write_version(&game, "越界", &fabric_json("越界", "../../secret"));
        assert_eq!(
            aurora.inheritance_chain("越界").await.unwrap(),
            vec!["../../secret".to_owned()]
        );

        let err = aurora.inheritance_chain("../x").await.unwrap_err();
        assert!(matches!(
            err,
            CoreError::Instance(InstanceError::InvalidId { .. })
        ));
    }

    #[tokio::test]
    async fn rename_moves_directory_json_jar_and_natives_and_keeps_the_mc_version() {
        let tmp = tempfile::tempdir().unwrap();
        let mut aurora = aurora_at(tmp.path());
        let old_dir = write_version(
            aurora.game_dir(),
            "1.21.1",
            r#"{"id":"1.21.1","type":"release","mainClass":"M","x-unmodelled":{"keep":true}}"#,
        );
        std::fs::write(old_dir.join("1.21.1.jar"), b"jar").unwrap();
        std::fs::create_dir_all(old_dir.join("1.21.1-natives")).unwrap();
        std::fs::create_dir_all(old_dir.join("saves").join("w")).unwrap();
        aurora.set_sidebar_pins(vec!["a".into(), "1.21.1".into()]);
        aurora.set_selected_version(Some("1.21.1".into()));

        aurora
            .rename_instance_files("1.21.1", "生存服")
            .await
            .unwrap();
        assert!(aurora.rename_instance_refs("1.21.1", "生存服"));

        let new_dir = aurora.game_dir().join("versions").join("生存服");
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
            aurora.config().sidebar_pins,
            vec!["a".to_owned(), "生存服".to_owned()]
        );
        assert_eq!(aurora.config().selected_version.as_deref(), Some("生存服"));

        let list = aurora.list_instances().await.unwrap();
        let InstanceVersion::Ready(ready) = &list[0].version else {
            panic!("改名后的实例应可用");
        };
        assert_eq!(list[0].id, "生存服");
        assert_eq!(ready.mc_version.as_deref(), Some("1.21.1"));
    }

    #[tokio::test]
    async fn rename_only_changing_case_keeps_the_json() {
        let tmp = tempfile::tempdir().unwrap();
        let aurora = aurora_at(tmp.path());
        write_version(aurora.game_dir(), "survival", &vanilla_json("1.21.1"));
        aurora
            .rename_instance_files("survival", "Survival")
            .await
            .unwrap();
        let dir = aurora.game_dir().join("versions").join("Survival");
        let json: serde_json::Value =
            serde_json::from_slice(&std::fs::read(dir.join("Survival.json")).unwrap()).unwrap();
        assert_eq!(json["id"], "Survival");
        let names = aurora.instance_names().await.unwrap();
        assert_eq!(names, vec!["Survival".to_owned()]);
    }

    #[tokio::test]
    async fn rename_validates_the_new_name_and_rolls_back_on_failure() {
        let tmp = tempfile::tempdir().unwrap();
        let aurora = aurora_at(tmp.path());
        let dir = write_version(aurora.game_dir(), "a", &vanilla_json("1.21.1"));
        write_version(aurora.game_dir(), "B", &vanilla_json("1.20.1"));

        for (name, expected) in [
            ("b", NameViolation::Duplicate),
            ("CON", NameViolation::ReservedByWindows),
            ("x ", NameViolation::ReservedByWindows),
            ("a/b", NameViolation::IllegalChar),
        ] {
            let err = aurora.rename_instance_files("a", name).await.unwrap_err();
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
        let err = aurora.rename_instance_files("a", "c").await.unwrap_err();
        assert!(
            matches!(err, CoreError::Instance(InstanceError::Json { .. })),
            "实际：{err:?}"
        );
        assert!(dir.join("a.json").is_file(), "失败后目录与 JSON 应还原");
        assert!(!aurora.game_dir().join("versions").join("c").exists());
    }

    /// 继承链、实例锁与 Windows 的目录名都不分大小写：`inheritsFrom` 写的大小写与目录名不同时，那个实例照样
    /// 靠这个目录运行，删除与改名不能放行。
    #[tokio::test]
    async fn dependents_are_found_regardless_of_case() {
        let tmp = tempfile::tempdir().unwrap();
        let aurora = aurora_at(tmp.path());
        let game = aurora.game_dir().to_path_buf();
        let base = write_version(&game, "Vanilla-1.21", &vanilla_json("Vanilla-1.21"));
        write_version(&game, "fab", &fabric_json("fab", "vanilla-1.21"));

        let preview = aurora.deletion_preview("Vanilla-1.21").await.unwrap();
        assert_eq!(preview.dependents, vec!["fab".to_owned()]);
        for err in [
            aurora
                .delete_instance_files("Vanilla-1.21", RecordingDisposer::default())
                .await
                .unwrap_err(),
            aurora
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
        let aurora = aurora_at(tmp.path());
        write_version(aurora.game_dir(), "生存", &vanilla_json("生存"));
        let world = aurora
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

        let preview = aurora.deletion_preview("生存").await.unwrap();
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

    fn pinned_instances(aurora: &Aurora) -> Vec<(String, Option<String>)> {
        aurora
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
        let mut aurora = aurora_at(tmp.path());
        aurora
            .set_pinned_servers(vec![
                pinned("a.example", Some("生存")),
                pinned("b.example", Some("创造")),
                pinned("c.example", None),
            ])
            .unwrap();

        assert!(aurora.rename_instance_refs("生存", "生存 1.21.1"));
        assert_eq!(
            pinned_instances(&aurora),
            vec![
                ("a.example".to_owned(), Some("生存 1.21.1".to_owned())),
                ("b.example".to_owned(), Some("创造".to_owned())),
                ("c.example".to_owned(), None),
            ]
        );
        assert!(!aurora.rename_instance_refs("生存", "又一个"));

        assert!(aurora.forget_instance("生存 1.21.1"));
        assert_eq!(
            pinned_instances(&aurora),
            vec![
                ("a.example".to_owned(), None),
                ("b.example".to_owned(), Some("创造".to_owned())),
                ("c.example".to_owned(), None),
            ]
        );
        assert!(!aurora.forget_instance("生存 1.21.1"));
    }

    #[tokio::test]
    async fn sidebar_pins_reject_overflow_duplicates_and_unknown_ids() {
        let tmp = tempfile::tempdir().unwrap();
        let mut aurora = aurora_at(tmp.path());
        let ids: Vec<String> = (1..=6).map(|i| format!("i{i}")).collect();
        for id in &ids {
            write_version(aurora.game_dir(), id, &vanilla_json("1.21.1"));
        }
        aurora
            .validate_sidebar_pins(&ids[..MAX_SIDEBAR_PINS])
            .await
            .unwrap();

        let pins_err = |err: CoreError| match err {
            CoreError::Instance(InstanceError::InvalidPins { reason, id }) => (reason, id),
            other => panic!("应报固定列表不合法，实际：{other:?}"),
        };
        let too_many = aurora.validate_sidebar_pins(&ids).await.unwrap_err();
        assert_eq!(pins_err(too_many), (PinsViolation::TooMany, None));
        let dup = aurora
            .validate_sidebar_pins(&["i1".into(), "i2".into(), "i1".into()])
            .await
            .unwrap_err();
        assert_eq!(pins_err(dup), (PinsViolation::Duplicate, Some("i1".into())));
        let missing = aurora
            .validate_sidebar_pins(&["i1".into(), "ghost".into()])
            .await
            .unwrap_err();
        assert_eq!(
            pins_err(missing),
            (PinsViolation::NotFound, Some("ghost".into()))
        );

        aurora.set_sidebar_pins(vec!["i2".into(), "gone".into(), "i1".into()]);
        assert_eq!(
            aurora.existing_sidebar_pins().await.unwrap(),
            vec!["i2".to_owned(), "i1".to_owned()]
        );
    }

    #[tokio::test]
    async fn new_instance_names_are_checked_against_existing_ones_case_insensitively() {
        let tmp = tempfile::tempdir().unwrap();
        let aurora = aurora_at(tmp.path());
        aurora.check_new_instance_name("全新").await.unwrap();
        write_version(aurora.game_dir(), "Survival", &vanilla_json("1.21.1"));
        let err = aurora
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
