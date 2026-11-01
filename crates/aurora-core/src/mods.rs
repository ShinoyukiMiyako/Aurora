//! 实例内的 Mod：安装、更新、移除、启停与列表。
//!
//! 安装不是「下一个文件」这么简单：一次安装是一份计划（玩家选的那个 Mod + 它的必需前置，见
//! [`crate::deps`]），整份计划要么全部落盘、要么一个文件都不落。为此走三段式——先全部下到工作目录
//! 元数据目录下的暂存区，逐个校验完整性契约，全过之后才移进 `mods/`。半套安装比装不上更难排查：
//! 玩家拿到的是一个「装了却进不去」的实例，而缺的那一半没有任何记录可查。
//!
//! 落盘之后、报成功之前必须写卷宗（[`crate::ledger`]）与变更历史（[`crate::history`]）。卷宗是 Mod
//! 身份的唯一来源，历史是回滚的唯一凭据，报成功却没写等于凭空造出一批查无此人的 jar。
//!
//! 目标已被同一工程的旧版本占着时走更新路径：旧文件就地改名为 `<旧文件名>.old` 留在 `mods/`，
//! 新文件移入，历史记 [`HistoryEvent::Update`]。那个 `.old` 就是回滚的全部凭据，没有它「更新」就是
//! 一条单行道。
//!
//! 实例的 mods 目录随版本隔离判定走：隔离版本落到 `versions/<id>/mods`，共享版本落到游戏目录的
//! `mods`。判定读版本级隔离覆盖，与启动链路同一套输入，避免「装进去的 mod 启动时不生效」。
//!
//! 所有改动 mods 目录的操作都在该目录的写锁下进行，并在动第一个文件前探测占用（游戏运行时 jar 被
//! JVM 打开着，Windows 上既不能改名也不能删）。

use std::collections::HashSet;
use std::path::{Path, PathBuf};

use aurora_download::DownloadTask;
use aurora_instance::{AURORA_META_DIR, DiscoveredVersion, VersionSettingsStore, discover_version};
use aurora_modplatform::{
    DISABLED_SUFFIX, InstalledMod, ModVersionInfo, Platform, disable_mod, enable_mod,
    parse_mod_metadata, scan_mods_dir_cached,
};
use serde::Serialize;

use crate::blocked::{BlockedFile, ClaimedCopy, place_claimed, single_blocked};
use crate::deps::PlannedItem;
use crate::error::{CoreError, Result};
use crate::event::{CoreEvent, EventSink, emit};
use crate::facade::Aurora;
use crate::history::HistoryEvent;
use crate::ledger::{Ledger, LedgerEntry, UpdateHold};
use crate::modfs::{
    MODS_DIR, ensure_not_held, is_plain_file_name, ledger_key, lock_mods_dir, now_unix,
    numbered_backup_name, present, refuse, try_exists,
};
use crate::resources::curseforge_download_url;

/// 暂存区目录名，位于 `<工作目录>/<元数据目录>/staging`。每次安装在其下另开一个独立子目录。
///
/// 与 mods 目录同处一个工作目录之下，「暂存 -> mods」必定是同卷改名，不会出现移到一半的半截文件。
/// 每次安装各用一个子目录：两个实例共享工作目录时并发安装同名文件，不会互相覆盖或删掉对方的暂存。
const STAGING_DIR: &str = "staging";

/// Mod 元数据缓存文件名，位于 `<工作目录>/<元数据目录>/`。
///
/// 解析一个 jar 的元数据要开一次 zip 并读完整份中央目录；mods 目录只在装/删 Mod 时才变。缓存是纯派生
/// 数据，删了只是下次慢一轮。所有扫 mods 目录的地方都从 [`InstanceDirs`] 取这条路径，拼错一处就是
/// 一份永远命不中的缓存，而且不会报任何错。
const MOD_METADATA_CACHE_FILE: &str = "mod-metadata-cache.json";

/// 被顶替的文件在卷宗里查无来源时，更新事件里记下的旧版本。
///
/// 手动丢进 `mods/` 的 jar 没有任何版本信息可继承。写一个明确的「未知」而不是编一个版本号——历史是
/// 证据，编造的证据比没有更坏。
const UNKNOWN_VERSION: &str = "未知";

/// 一次模组安装（或更新）的结果，描述的是玩家主动选的那个 Mod。
///
/// 本次连带装上的前置的落盘明细记在变更历史里，而不是塞进本结构——调用方要的是「我点的那个装到哪了」。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ModInstallOutcome {
    /// 落盘的模组文件名。
    pub file_name: String,
    /// 模组文件完整路径。
    pub path: PathBuf,
    /// 来源平台。
    pub platform: Platform,
}

/// 一个实例与 Mod 相关的全部目录，同源于一次隔离判定。
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct InstanceDirs {
    /// 运行工作目录。
    pub(crate) working_dir: PathBuf,
    /// `<工作目录>/mods`。
    pub(crate) mods_dir: PathBuf,
    /// mods 目录旁边那份元数据缓存的落点。
    pub(crate) metadata_cache: PathBuf,
}

/// 已装 Mod 在卷宗里的平台来源。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ModSource {
    /// 来源平台。
    pub platform: Platform,
    /// 工程标识。
    pub project_id: String,
    /// 已装版本标识。
    pub version_id: String,
    /// 已装版本号；卷宗里没记为 `None`。
    pub version_number: Option<String>,
    /// 工程标题；卷宗里没记为 `None`。
    pub title: Option<String>,
    /// 作为谁的前置被带进来的（project_id）；玩家主动装的为 `None`。
    pub dependency_of: Option<String>,
    /// 这个 Mod 装进实例的时刻（unix 秒），取卷宗原值。
    pub installed_at: i64,
    /// 更新检查设置；没设置为 `None`（序列化为 `null`）。
    pub update_hold: Option<UpdateHold>,
}

/// 批量启停里一个文件的结果。
#[derive(Debug)]
pub struct ModToggleOutcome {
    /// 入参里的文件名，原样带回。
    pub file_name: String,
    /// 切换后的磁盘路径，或这一个文件失败的原因。
    pub result: Result<PathBuf>,
}

/// 实例 Mod 列表的一项：磁盘扫描结果 + 卷宗 join 出的来源与图标。
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct InstanceMod {
    /// 磁盘扫描结果（路径、文件名、启用态、大小、修改时刻、jar 内元数据）。
    #[serde(flatten)]
    pub installed: InstalledMod,
    /// 工程图标地址（平台给的远程图片）；来源不明或平台没给为 `None`。
    pub icon_url: Option<String>,
    /// 平台来源；卷宗里没有这个文件（手动丢进来、还没被识别）为 `None`。
    pub source: Option<ModSource>,
}

/// 一个进入下载队列的计划项：计划里的原始信息 + 它在暂存区的落点与完整性契约。
struct StagedItem {
    version: ModVersionInfo,
    title: Option<String>,
    icon_url: Option<String>,
    required_by: Option<String>,
    /// 平台给的文件名，也是最终落进 `mods/` 的名字。
    file_name: String,
    /// 下载任务，`dest` 指向暂存区。
    task: DownloadTask,
    /// 手动下载认领到的副本：有它时不下载，从这里复制进暂存区，任务只用来核对大小与哈希。
    claimed: Option<PathBuf>,
    /// 校验通过后的 SHA-1：平台声明了就是它，没声明就是对暂存文件的实测值。
    sha1: Option<String>,
}

/// 被本次安装顶替掉的旧文件。
#[derive(Debug, Clone, PartialEq, Eq)]
struct Replaced {
    /// 旧文件的启用态文件名（卷宗的 join 键）。
    old_file: String,
    /// 旧文件对应的平台版本标识；卷宗里查不到时为 [`UNKNOWN_VERSION`]。
    from_version: String,
    /// 旧版本号；卷宗里没记为 `None`。
    from_version_number: Option<String>,
}

/// 一个文件真正落进 `mods/` 之后的事实，供随后写卷宗与历史。
struct Placement {
    file_name: String,
    version: ModVersionInfo,
    title: Option<String>,
    icon_url: Option<String>,
    sha1: Option<String>,
    required_by: Option<String>,
    /// 走更新路径时被备份掉的旧文件；新装为 `None`。
    replaced: Option<Replaced>,
    /// 旧文件实际改成的备份名，与 `replaced` 同为 `Some` 或同为 `None`。
    backup_file: Option<String>,
}

impl Aurora {
    /// 按安装计划把某平台上的一个模组版本（连同它的必需前置）安装到指定实例的 mods 目录。
    ///
    /// `project_id` / `mod_version_id` 的语义随平台而定：Modrinth 为工程 id/slug 与版本 id；CurseForge
    /// 为数字 modId 与 fileId（以十进制字符串传入）。
    ///
    /// 流程：[`Aurora::plan_install`] 算出计划 -> 全部文件下到暂存区 -> 逐个校验 sha1/大小 -> 全过才
    /// 移入 `mods/` -> 写卷宗与变更历史 -> 报成功。校验没全过就一个文件都不移，清掉暂存并冒泡错误。
    /// 计划里 `already_satisfied` 的项直接跳过：同工程同版本的文件已经躺在 `mods/` 里。
    pub async fn install_mod(
        &self,
        version_id: &str,
        platform: Platform,
        project_id: &str,
        mod_version_id: &str,
        events: Option<&EventSink>,
    ) -> Result<ModInstallOutcome> {
        emit(
            events,
            CoreEvent::stage(format!(
                "准备从 {} 安装模组到 {version_id}",
                platform.display_name()
            )),
        );
        let plan = self
            .plan_install(version_id, platform, project_id, mod_version_id)
            .await?;
        self.install_planned(
            version_id,
            plan.items,
            (platform, project_id, mod_version_id),
            events,
        )
        .await
    }

    /// 把实例里某个已识别来源的 Mod 换成同工程的 `mod_version_id`（通常取自
    /// [`Aurora::check_updates`] 给出的最新版）。
    ///
    /// 走与安装同一条管线：旧文件改名为 `.old` 留作回滚凭据，历史记一条更新事件，新版本声明的必需前置
    /// 一并补齐。`file_name` 是列表里的磁盘文件名（禁用态带 `.disabled` 也认）。卷宗里没有这个文件的
    /// 来源时拒绝：不知道它是哪个工程，就无从「更新」。
    pub async fn update_mod(
        &self,
        version_id: &str,
        file_name: &str,
        mod_version_id: &str,
        events: Option<&EventSink>,
    ) -> Result<ModInstallOutcome> {
        let dirs = self.resolved_dirs(version_id).await?;
        let path = mod_file_path(&dirs.mods_dir, file_name)?;
        let ledger = self.ledger_store(version_id).load().await?;
        let entry = ledger.find(ledger_key(file_name)).ok_or_else(|| {
            refuse(
                &path,
                std::io::ErrorKind::NotFound,
                format!("{file_name} 没有平台来源记录，无法自动更新（先检查更新让启动器识别它）"),
            )
        })?;
        let (platform, project_id) = (entry.platform, entry.project_id.clone());
        emit(
            events,
            CoreEvent::stage(format!("准备把 {file_name} 更新到版本 {mod_version_id}")),
        );
        let plan = self
            .plan_install(version_id, platform, &project_id, mod_version_id)
            .await?;
        self.install_planned(
            version_id,
            plan.items,
            (platform, &project_id, mod_version_id),
            events,
        )
        .await
    }

    /// 列出指定实例的已装 Mod（含禁用态），并从卷宗 join 出平台来源与图标。
    ///
    /// 磁盘是权威：列表来自重扫 mods 目录，卷宗只补身份。目录尚不存在（从未装过 Mod）返回空列表；
    /// 真实 IO 故障（如权限不足）与卷宗损坏照常冒泡。
    pub async fn list_mods(&self, version_id: &str) -> Result<Vec<InstanceMod>> {
        let dirs = self.resolved_dirs(version_id).await?;
        let installed = scan_installed(&dirs).await?;
        if installed.is_empty() {
            return Ok(Vec::new());
        }
        let ledger = self.ledger_store(version_id).load().await?;
        Ok(installed
            .into_iter()
            .map(|item| join_ledger(item, &ledger))
            .collect())
    }

    /// 启用或禁用指定实例里的某个模组，返回切换后的新路径。
    ///
    /// `file_name` 应为 [`Aurora::list_mods`] 返回的磁盘文件名（禁用态带 `.disabled` 后缀）。启禁以文件
    /// 重命名实现，卷宗按启用态文件名记账，因此无需改写卷宗；目标名已存在会冒泡冲突错误。
    pub async fn set_mod_enabled(
        &self,
        version_id: &str,
        file_name: &str,
        enabled: bool,
    ) -> Result<PathBuf> {
        let dirs = self.resolved_dirs(version_id).await?;
        let _guard = lock_mods_dir(&dirs.mods_dir).await;
        toggle_locked(&dirs.mods_dir, file_name, enabled).await
    }

    /// 批量启用或禁用一组文件，逐个给出结果，顺序与入参一致。
    ///
    /// 单个文件失败（名字不合法、文件不在、被游戏占用、目标名已存在）只记在它那一项，不中断其余：
    /// 玩家勾了十个，一个被占用不该让另外九个也不动。外层错误只来自实例本身解析不了。mods 目录的写锁
    /// 整批只拿一次，批次中途不会插进别的改动。与单个启停一样不写历史。
    pub async fn set_mods_enabled(
        &self,
        version_id: &str,
        file_names: &[String],
        enabled: bool,
    ) -> Result<Vec<ModToggleOutcome>> {
        let dirs = self.resolved_dirs(version_id).await?;
        let _guard = lock_mods_dir(&dirs.mods_dir).await;
        let mut outcomes = Vec::with_capacity(file_names.len());
        for file_name in file_names {
            outcomes.push(ModToggleOutcome {
                file_name: file_name.clone(),
                result: toggle_locked(&dirs.mods_dir, file_name, enabled).await,
            });
        }
        Ok(outcomes)
    }

    /// 设置某个 Mod 的更新检查：`Some` 为忽略或锁定版本，`None` 为恢复检查。
    ///
    /// `file_name` 是列表里的磁盘文件名，禁用态也认。只改卷宗、不碰 jar，所以游戏运行中也能做；值没变
    /// 时不落盘。文件不在 mods 目录里、或卷宗里没有它的平台来源（本地文件不参与更新检查）时拒绝。
    pub async fn set_mod_update_hold(
        &self,
        version_id: &str,
        file_name: &str,
        hold: Option<UpdateHold>,
    ) -> Result<()> {
        let dirs = self.resolved_dirs(version_id).await?;
        let path = mod_file_path(&dirs.mods_dir, file_name)?;
        let key = ledger_key(file_name);
        let _guard = lock_mods_dir(&dirs.mods_dir).await;
        if !present(&dirs.mods_dir, key).await? {
            return Err(refuse(
                &path,
                std::io::ErrorKind::NotFound,
                format!("mods 目录里没有 {file_name}，可能已被移除"),
            ));
        }
        let store = self.ledger_store(version_id);
        let mut ledger = store.load().await?;
        let entry = ledger.find_mut(key).ok_or_else(|| {
            refuse(
                &path,
                std::io::ErrorKind::NotFound,
                format!("{file_name} 没有平台来源记录，不能设置更新检查"),
            )
        })?;
        if entry.update_hold == hold {
            return Ok(());
        }
        entry.update_hold = hold;
        store.save(&ledger).await
    }

    /// 从实例里移除一个 Mod 文件，摘掉它的卷宗条目，并在历史里记一条移除事件。
    ///
    /// 只删这一个文件：它当初带进来的前置可能也被别的 Mod 依赖着，启动器无从确知，不连带删除。
    /// 文件不在、名字不是 mods 目录里的模组文件、或文件正被占用时整体拒绝，什么都不改。
    pub async fn remove_mod(&self, version_id: &str, file_name: &str) -> Result<()> {
        let dirs = self.resolved_dirs(version_id).await?;
        let mods_dir = &dirs.mods_dir;
        let path = mod_file_path(mods_dir, file_name)?;
        let _guard = lock_mods_dir(mods_dir).await;
        if !try_exists(&path).await? {
            return Err(refuse(
                &path,
                std::io::ErrorKind::NotFound,
                format!("mods 目录里没有 {file_name}，可能已被移除"),
            ));
        }
        ensure_not_held(vec![path.clone()]).await?;
        tokio::fs::remove_file(&path)
            .await
            .map_err(|source| aurora_base::Error::Io {
                path: path.clone(),
                source,
            })?;

        let key = ledger_key(file_name);
        // 启用与禁用两份同时存在时只删了其中一份，另一份仍是这个工程的同一个文件，身份不能摘。
        if !present(mods_dir, key).await? {
            let store = self.ledger_store(version_id);
            let mut ledger = store.load().await?;
            if ledger.remove(key).is_some() {
                store.save(&ledger).await?;
            }
        }

        let at = now_unix();
        self.history_store(version_id)
            .append_with(at, |id| HistoryEvent::Remove {
                id,
                at,
                files: vec![file_name.to_owned()],
            })
            .await
    }

    /// 读一个已安装版本；版本目录不存在、缺 JSON、JSON 损坏或 id 带路径成分一律报
    /// [`CoreError::VersionNotInstalled`]。
    ///
    /// 只解析这一个版本：Mod 操作只关心目标实例，为它把全部版本 JSON 读一遍是纯粹的浪费。id 来自
    /// 前端，必须当作不可信输入——带分隔符或 `..` 的 id 会让后续拼出的卷宗、历史、mods 路径逃出
    /// `versions/`。
    pub(crate) async fn resolve_instance(&self, version_id: &str) -> Result<DiscoveredVersion> {
        probe_installed_version(self.game_dir(), version_id)
            .await?
            .ok_or_else(|| CoreError::VersionNotInstalled {
                id: version_id.to_owned(),
            })
    }

    /// 由版本事实与版本级隔离覆盖算出该实例的工作目录与 mods 目录。
    ///
    /// 隔离覆盖读自版本设置，与启动链路同一份输入；只按全局档位算会在玩家单独改过某个实例的隔离后，
    /// 把 Mod 装进一个启动时根本不读的目录。
    pub(crate) async fn instance_dirs(&self, version: &DiscoveredVersion) -> Result<InstanceDirs> {
        let settings = VersionSettingsStore::for_version_dir(&version.dir)
            .load()
            .await?;
        let resolved = self
            .resolve_working_dir_from(
                &version.id,
                settings.isolation,
                version.has_mod_loader(),
                version.is_release(),
            )
            .await?;
        let working_dir = resolved.working_dir;
        Ok(InstanceDirs {
            mods_dir: working_dir.join(MODS_DIR),
            metadata_cache: working_dir
                .join(AURORA_META_DIR)
                .join(MOD_METADATA_CACHE_FILE),
            working_dir,
        })
    }

    /// [`Aurora::resolve_instance`] + [`Aurora::instance_dirs`]。
    pub(crate) async fn resolved_dirs(&self, version_id: &str) -> Result<InstanceDirs> {
        let version = self.resolve_instance(version_id).await?;
        self.instance_dirs(&version).await
    }

    /// 某已安装版本的 mods 目录（测试里断言落点用）。
    #[cfg(test)]
    pub(crate) async fn resolve_mods_dir(&self, version_id: &str) -> Result<PathBuf> {
        Ok(self.resolved_dirs(version_id).await?.mods_dir)
    }

    /// 执行一份安装计划。`root` 只用于计划为空时给出可读的错误。
    async fn install_planned(
        &self,
        version_id: &str,
        items: Vec<PlannedItem>,
        root: (Platform, &str, &str),
        events: Option<&EventSink>,
    ) -> Result<ModInstallOutcome> {
        // plan_install 在结构上保证计划至少含主项。这里给错误而不是 panic：万一那条保证被后续改动
        // 打破，玩家该看到一句能读懂的失败，而不是整个命令被 panic 掀掉。
        let Some(main) = items.first() else {
            return Err(CoreError::ModVersionNotFound {
                platform: root.0.display_name(),
                project_id: root.1.to_owned(),
                version_id: root.2.to_owned(),
            });
        };
        let main_platform = main.version.platform;
        let main_planned_file = main.version.file_name.clone();

        let dirs = self.resolved_dirs(version_id).await?;
        let staging_dir = dirs
            .working_dir
            .join(AURORA_META_DIR)
            .join(STAGING_DIR)
            .join(format!("{}-{:08x}", now_unix(), fastrand::u32(..)));

        let total = items.len();
        let pending: Vec<PlannedItem> = items
            .into_iter()
            .filter(|item| !item.already_satisfied)
            .collect();
        emit(
            events,
            CoreEvent::stage(format!(
                "安装计划共 {total} 项，其中 {} 个文件需要下载",
                pending.len()
            )),
        );

        let mut staged: Vec<StagedItem> = Vec::with_capacity(pending.len());
        let mut blocked: Vec<BlockedFile> = Vec::new();
        for item in pending {
            match self.stage_item(item, &staging_dir).await {
                Ok(item) => staged.push(item),
                // 一次报全：不让玩家手动下完一个、重试，才发现还有下一个。
                Err(CoreError::FileDistributionBlocked { files }) => blocked.extend(files),
                Err(err) => return Err(err),
            }
        }
        if !blocked.is_empty() {
            return Err(CoreError::FileDistributionBlocked { files: blocked });
        }
        ensure_unique_targets(&staged, &dirs.mods_dir)?;

        if let Err(err) = self.download_and_verify(&mut staged, events).await {
            discard_staging(&staging_dir, events).await;
            return Err(err);
        }

        let main_file = staged
            .iter()
            .find(|item| item.required_by.is_none())
            .map(|item| item.file_name.clone())
            // 主项已满足时没进下载队列，磁盘上那份就叫计划里的名字。
            .unwrap_or(main_planned_file);

        // 落位与记账放进独立任务：命令层取消后会在宽限期满时丢弃本 future，若这一段跟着被丢弃，
        // 就会留下「文件已移进 mods、卷宗与历史还没写」的半截状态。下载阶段可以取消，落位阶段一旦
        // 开始必须走完。
        let aurora = self.clone();
        let owned_version = version_id.to_owned();
        let mods_dir = dirs.mods_dir.clone();
        let metadata_cache = dirs.metadata_cache.clone();
        let sink = events.cloned();
        tokio::spawn(async move {
            let outcome = aurora
                .commit_staged(
                    &owned_version,
                    &mods_dir,
                    &metadata_cache,
                    staged,
                    sink.as_ref(),
                )
                .await;
            discard_staging(&staging_dir, sink.as_ref()).await;
            outcome
        })
        .await??;

        let dest = dirs.mods_dir.join(&main_file);
        emit(
            events,
            CoreEvent::stage(format!("模组 {main_file} 已安装到 {}", dest.display())),
        );
        Ok(ModInstallOutcome {
            file_name: main_file,
            path: dest,
            platform: main_platform,
        })
    }

    /// 为一个计划项生成下载任务，落点在本次安装的暂存子目录。
    async fn stage_item(&self, item: PlannedItem, staging_dir: &Path) -> Result<StagedItem> {
        let PlannedItem {
            version,
            title,
            icon_url,
            required_by,
            ..
        } = item;
        let file_name = version.file_name.clone();
        // 文件名来自第三方平台，随后要拼暂存路径、`mods/` 落点与 `.old` 备份名；带路径成分的名字会让
        // 这三处一起写到目录外去，故在唯一入口处一次挡掉。
        if !is_plain_file_name(&file_name) {
            return Err(refuse(
                staging_dir,
                std::io::ErrorKind::InvalidInput,
                format!("平台给出的文件名 {file_name} 不是合法的纯文件名，已拒绝安装"),
            ));
        }
        let dest = staging_dir.join(&file_name);
        let (task, claimed) = match version.to_download_task(&dest) {
            Some(task) => (task, None),
            None => match self.fallback_download_url(&version).await {
                Ok(url) => (version.task_for_url(url, &dest), None),
                Err(err) => {
                    let (_, copy) = self.claimed_instead_of(err).await?;
                    // 这条任务不下载，地址只会出现在校验失败的报错里，写副本路径才对得上来源。
                    let source = copy.display().to_string();
                    (version.task_for_url(source, &dest), Some(copy))
                }
            },
        };
        let task = match version.platform {
            Platform::CurseForge => {
                let client = self.curseforge_client()?;
                task.with_credential(self.curseforge_credential(&client)?)
            }
            Platform::Modrinth => task,
        };
        Ok(StagedItem {
            sha1: version.sha1.clone(),
            version,
            title,
            icon_url,
            required_by,
            file_name,
            task,
            claimed,
        })
    }

    /// 版本自带直链为空时的兜底直链。只有 CurseForge 会走到这里（禁止第三方分发的工程不在文件对象里
    /// 给直链）；Modrinth 版本没有文件时根本不会进入版本列表。端点拒绝或给空串时报
    /// [`CoreError::FileDistributionBlocked`]，与整合包导入、资源安装同一口径，落点是 `mods/` 下的同名文件。
    async fn fallback_download_url(&self, version: &ModVersionInfo) -> Result<String> {
        let not_found = || CoreError::ModVersionNotFound {
            platform: version.platform.display_name(),
            project_id: version.project_id.clone(),
            version_id: version.version_id.clone(),
        };
        match version.platform {
            Platform::CurseForge => {
                let mod_id: u32 = version.project_id.parse().map_err(|_| not_found())?;
                let file_id: u32 = version.version_id.parse().map_err(|_| not_found())?;
                let client = self.curseforge_client()?;
                match curseforge_download_url(&client, mod_id, file_id).await? {
                    Some(url) => Ok(url),
                    // 版本信息里没有 fileFingerprint，只按 sha1 与大小认。
                    None => Err(single_blocked(&client, mod_id, |project| BlockedFile {
                        project_id: mod_id,
                        file_id,
                        file_name: version.file_name.clone(),
                        web_url: aurora_modplatform::curseforge::file_page_url(project, file_id),
                        destination: format!("{MODS_DIR}/{}", version.file_name),
                        sha1: version.sha1.clone(),
                        fingerprint: 0,
                        size: version.file_size,
                    })
                    .await),
                }
            }
            Platform::Modrinth => Err(not_found()),
        }
    }

    /// 整批下载到暂存区，再逐个核对完整性契约。任一环节失败即整体失败。
    async fn download_and_verify(
        &self,
        staged: &mut [StagedItem],
        events: Option<&EventSink>,
    ) -> Result<()> {
        if staged.is_empty() {
            return Ok(());
        }
        let claimed: Vec<ClaimedCopy> = staged
            .iter()
            .filter_map(|item| {
                item.claimed.clone().map(|copy| ClaimedCopy {
                    staged: copy,
                    dest: item.task.dest.clone(),
                })
            })
            .collect();
        place_claimed(&claimed).await?;

        let tasks: Vec<DownloadTask> = staged
            .iter()
            .filter(|item| item.claimed.is_none())
            .map(|item| item.task.clone())
            .collect();
        if !tasks.is_empty() {
            let report = self
                .download_pool_reporting(events)
                .download_all(tasks, None)
                .await?;
            // 有失败即冒泡其最终错误（重试换源后仍失败），绝不当作成功。
            if let Some(failure) = report.failures.into_iter().next() {
                return Err(failure.error.into());
            }
        }

        let total = staged.len();
        for (index, item) in staged.iter_mut().enumerate() {
            verify_staged(&item.task).await?;
            if item.sha1.is_none() {
                // 平台没给 SHA-1 的文件（部分 CurseForge 老文件）记实测值：卷宗里的哈希是之后按
                // 哈希批量查更新的钥匙，留空就等于放弃这个文件的更新检查。
                item.sha1 = Some(aurora_base::fs::sha1_hex(&item.task.dest).await?);
            }
            emit(
                events,
                CoreEvent::stage(format!(
                    "({}/{total}) {} 下载完成并通过校验",
                    index + 1,
                    item.file_name
                )),
            );
        }
        Ok(())
    }

    /// 在 mods 目录写锁下完成落位决策、占用检查、移入与记账。
    async fn commit_staged(
        &self,
        version_id: &str,
        mods_dir: &Path,
        metadata_cache: &Path,
        staged: Vec<StagedItem>,
        events: Option<&EventSink>,
    ) -> Result<()> {
        if staged.is_empty() {
            return Ok(());
        }
        let _guard = lock_mods_dir(mods_dir).await;

        // 落位决策全部先算清楚再动第一次盘：与已有文件的冲突、被占用的旧文件都必须在移动开始之前
        // 暴露，而不是移到一半才发现，那时候撤不回来。
        let ledger = self.ledger_store(version_id).load().await?;
        let mut decisions = Vec::with_capacity(staged.len());
        for item in &staged {
            decisions.push(plan_placement(&ledger, mods_dir, metadata_cache, item).await?);
        }
        let touched: Vec<PathBuf> = decisions
            .iter()
            .flatten()
            .flat_map(|previous| {
                [
                    mods_dir.join(&previous.old_file),
                    mods_dir.join(format!("{}{DISABLED_SUFFIX}", previous.old_file)),
                ]
            })
            .collect();
        ensure_not_held(touched).await?;

        tokio::fs::create_dir_all(mods_dir)
            .await
            .map_err(|source| aurora_base::Error::Io {
                path: mods_dir.to_owned(),
                source,
            })?;

        let mut placements: Vec<Placement> = Vec::with_capacity(staged.len());
        let mut place_failure: Option<CoreError> = None;
        for (item, replaced) in staged.into_iter().zip(decisions) {
            match place_file(mods_dir, item, replaced).await {
                Ok(placement) => {
                    emit(events, CoreEvent::stage(describe_placement(&placement)));
                    placements.push(placement);
                }
                Err(err) => {
                    place_failure = Some(err);
                    break;
                }
            }
        }

        // 落位即便中途失败，已经躺进 mods 的文件也必须立刻拿到身份：磁盘上多出一批查不到来源的 jar，
        // 比这次安装失败本身糟得多。
        let recorded = self
            .record_placements(version_id, ledger, &placements)
            .await;
        for placement in &placements {
            self.invalidate_mod_versions(placement.version.platform, &placement.version.project_id);
        }

        if let Some(err) = place_failure {
            if let Err(record_err) = recorded {
                emit(
                    events,
                    CoreEvent::warning(format!("已落盘文件的卷宗/历史写入同样失败：{record_err}")),
                );
                tracing::error!(error = %record_err, "已落盘文件的卷宗/历史写入失败");
            }
            return Err(err);
        }
        recorded
    }

    /// 把已落盘的文件写进卷宗与变更历史。调用方持有 mods 目录写锁，`ledger` 是锁内读到的那份。
    ///
    /// 顺序是先卷宗后历史：卷宗决定「这个 jar 是谁」，历史只描述「发生过什么」。万一写到一半断电，
    /// 有身份没历史还能靠更新检查自愈，有历史没身份则连是哪个工程都说不出。
    async fn record_placements(
        &self,
        version_id: &str,
        mut ledger: Ledger,
        placements: &[Placement],
    ) -> Result<()> {
        if placements.is_empty() {
            return Ok(());
        }
        let at = now_unix();
        for placement in placements {
            // 改名式更新：旧文件名那条记录必须先摘掉，否则卷宗里会同时挂着新旧两个文件名，而磁盘上
            // 旧的那个已经变成 .old 备份了。
            let previous = match &placement.replaced {
                Some(replaced) if replaced.old_file != placement.file_name => {
                    ledger.remove(&replaced.old_file)
                }
                Some(_) => ledger.find(&placement.file_name).cloned(),
                None => None,
            };
            // 更新换的是版本不是 Mod：装进实例的时刻与玩家的更新设置都跟着这个 Mod 走。顶替来路不明的
            // 文件时没有旧记录可继承，按新装算。
            let (installed_at, update_hold) = match previous {
                Some(old) => (old.installed_at, old.update_hold),
                None => (at, None),
            };
            ledger.upsert(LedgerEntry {
                file_name: placement.file_name.clone(),
                platform: placement.version.platform,
                project_id: placement.version.project_id.clone(),
                version_id: placement.version.version_id.clone(),
                version_number: Some(placement.version.version_number.clone()),
                title: placement.title.clone(),
                icon_url: placement.icon_url.clone(),
                sha1: placement.sha1.clone(),
                installed_at,
                installed_as_dependency_of: placement.required_by.clone(),
                update_hold,
            });
        }
        self.ledger_store(version_id).save(&ledger).await?;

        let history = self.history_store(version_id);
        let fresh: Vec<String> = placements
            .iter()
            .filter(|p| p.replaced.is_none())
            .map(|p| p.file_name.clone())
            .collect();
        if !fresh.is_empty() {
            history
                .append_with(at, |id| HistoryEvent::Install {
                    id,
                    at,
                    files: fresh,
                })
                .await?;
        }
        // 更新逐条单记：回滚要的是「哪个文件从哪个版本换到了哪个版本」，一条批量事件表达不了这个。
        for placement in placements {
            let Some(replaced) = &placement.replaced else {
                continue;
            };
            history
                .append_with(at, |id| HistoryEvent::Update {
                    id,
                    at,
                    file_name: placement.file_name.clone(),
                    old_file: replaced.old_file.clone(),
                    backup_file: placement.backup_file.clone(),
                    from_version: replaced.from_version.clone(),
                    to_version: placement.version.version_id.clone(),
                    title: placement.title.clone(),
                    from_version_number: replaced.from_version_number.clone(),
                    to_version_number: Some(placement.version.version_number.clone()),
                })
                .await?;
        }
        Ok(())
    }
}

/// 只读一个版本目录：目录不存在、缺 JSON、JSON 损坏一律当作未安装（损坏版本本就不在已安装列表里）；
/// 只有真实 IO 故障冒泡。id 带路径成分直接判为未安装，拼出的卷宗、历史、mods 路径才逃不出 `versions/`。
async fn probe_installed_version(
    game_dir: &Path,
    version_id: &str,
) -> Result<Option<DiscoveredVersion>> {
    if !is_plain_file_name(version_id) {
        return Ok(None);
    }
    Ok(discover_version(game_dir, version_id).await?)
}

/// 扫描实例的 mods 目录（走元数据缓存）；目录还不存在返回空列表。
pub(crate) async fn scan_installed(dirs: &InstanceDirs) -> Result<Vec<InstalledMod>> {
    if !try_exists(&dirs.mods_dir).await? {
        return Ok(Vec::new());
    }
    Ok(scan_mods_dir_cached(&dirs.mods_dir, Some(&dirs.metadata_cache)).await?)
}

/// 把一条扫描结果与卷宗 join。
fn join_ledger(installed: InstalledMod, ledger: &Ledger) -> InstanceMod {
    let entry = ledger.find(ledger_key(&installed.file_name));
    InstanceMod {
        icon_url: entry.and_then(|e| e.icon_url.clone()),
        source: entry.map(|e| ModSource {
            platform: e.platform,
            project_id: e.project_id.clone(),
            version_id: e.version_id.clone(),
            version_number: e.version_number.clone(),
            title: e.title.clone(),
            dependency_of: e.installed_as_dependency_of.clone(),
            installed_at: e.installed_at,
            update_hold: e.update_hold.clone(),
        }),
        installed,
    }
}

/// 切换一个文件的启停。调用方持有 mods 目录写锁；单个与批量启停共用这一段，两条路径的校验与占用
/// 检查才不会走岔。
async fn toggle_locked(mods_dir: &Path, file_name: &str, enabled: bool) -> Result<PathBuf> {
    let path = mod_file_path(mods_dir, file_name)?;
    ensure_not_held(vec![path.clone()]).await?;
    let switched = if enabled {
        enable_mod(&path).await?
    } else {
        disable_mod(&path).await?
    };
    Ok(switched)
}

/// 前端传来的 mods 目录文件名 -> 完整路径，挡住任何不是「mods 目录里一个模组 jar」的名字。
///
/// 移除与启停只该作用于模组文件本身：放任任意文件名进来，`.old` 备份、配置文件乃至带 `..` 的路径都会
/// 被当成 Mod 删掉或改名。
pub(crate) fn mod_file_path(mods_dir: &Path, file_name: &str) -> Result<PathBuf> {
    if !is_plain_file_name(file_name) || !ledger_key(file_name).ends_with(".jar") {
        return Err(refuse(
            &mods_dir.join(file_name),
            std::io::ErrorKind::InvalidInput,
            format!("{file_name} 不是 mods 目录里的 Mod 文件名"),
        ));
    }
    Ok(mods_dir.join(file_name))
}

/// 计划里的多个文件不得写向同一个落点。
///
/// 两个不同工程的 jar 同名时，后者会覆盖前者，报告却说两个都装好了。这种冲突在触盘之前就能看出来，
/// 那就在触盘之前拒绝。
fn ensure_unique_targets(staged: &[StagedItem], mods_dir: &Path) -> Result<()> {
    let mut seen: HashSet<&str> = HashSet::with_capacity(staged.len());
    for item in staged {
        if !seen.insert(item.file_name.as_str()) {
            return Err(refuse(
                &mods_dir.join(&item.file_name),
                std::io::ErrorKind::AlreadyExists,
                format!(
                    "计划里有多个工程都要写入同一个文件 {}，无法同时安装",
                    item.file_name
                ),
            ));
        }
    }
    Ok(())
}

/// 校验暂存文件确实符合平台声明的完整性契约。
///
/// 下载引擎在合并落盘时已经校过一遍；这里再校一次，是因为「能不能移进 mods」必须建立在「此刻暂存区
/// 里躺着的就是对的东西」之上。平台两样都没给时能验的只剩「不是个空壳」——0 字节的 jar 必然是错误页
/// 或断流，装进去只会在启动时报一句看不懂的异常。
async fn verify_staged(task: &DownloadTask) -> Result<()> {
    let meta = tokio::fs::metadata(&task.dest)
        .await
        .map_err(|source| aurora_base::Error::Io {
            path: task.dest.clone(),
            source,
        })?;
    if meta.len() == 0 {
        return Err(refuse(
            &task.dest,
            std::io::ErrorKind::InvalidData,
            format!("下载得到的文件是 0 字节，来源 {}", task.url),
        ));
    }
    if let Some(expected) = task.size
        && meta.len() != expected
    {
        return Err(aurora_download::Error::SizeMismatch {
            url: task.url.clone(),
            expected,
            actual: meta.len(),
        }
        .into());
    }
    if let Some(sha1) = &task.sha1 {
        aurora_base::fs::verify_sha1(&task.dest, sha1).await?;
    }
    Ok(())
}

/// 算出一个待落盘文件该怎么落：是新装，还是先把同一个 Mod 的旧文件备份掉再覆上去。
async fn plan_placement(
    ledger: &Ledger,
    mods_dir: &Path,
    metadata_cache: &Path,
    item: &StagedItem,
) -> Result<Option<Replaced>> {
    let replaced = find_previous(ledger, mods_dir, metadata_cache, item).await?;

    // 改名式更新时目标名本该是空的；被别的文件占着说明那是另一个来路不明的 jar，直接改名过去会让它
    // 无声消失（Windows 的 rename 覆盖同名文件不报错）。
    if let Some(previous) = &replaced
        && previous.old_file != item.file_name
        && present(mods_dir, &item.file_name).await?
    {
        return Err(refuse(
            &mods_dir.join(&item.file_name),
            std::io::ErrorKind::AlreadyExists,
            format!(
                "mods 目录里已有文件 {}，它不属于本次要更新的 {}，为避免覆盖已中止安装",
                item.file_name, previous.old_file
            ),
        ));
    }
    Ok(replaced)
}

/// 在卷宗与磁盘里找这个 Mod 已装的旧文件。
///
/// 三道判据依次放宽：
/// 一、卷宗里同平台同工程且文件还在磁盘上——文件名从 `sodium-0.5.jar` 换成 `sodium-0.6.jar` 也认得出。
///    只比 project_id 不够，两个平台的工程标识各自成命名空间，撞上就会把别人的 jar 当成旧版备份掉。
/// 二、目标文件名已经被占：那是玩家手动丢进来或别的启动器装的文件，版本无从查考，但绝不能就这么覆盖。
/// 三、jar 里的 `mod_id` 相同：同一个 Mod 从两个平台各装一次时前两道都判「没装过」，两个 jar 共存，
///    游戏启动即因重复 Mod 崩溃；`mod_id` 才是加载器眼中的唯一身份。
async fn find_previous(
    ledger: &Ledger,
    mods_dir: &Path,
    metadata_cache: &Path,
    item: &StagedItem,
) -> Result<Option<Replaced>> {
    let version = &item.version;
    for entry in &ledger.entries {
        if entry.platform != version.platform || entry.project_id != version.project_id {
            continue;
        }
        // 磁盘是权威：卷宗有记录但文件被玩家删了，那就是没装，本次按新装处理。
        if present(mods_dir, &entry.file_name).await? {
            return Ok(Some(Replaced {
                old_file: entry.file_name.clone(),
                from_version: entry.version_id.clone(),
                from_version_number: entry.version_number.clone(),
            }));
        }
    }
    if present(mods_dir, &item.file_name).await? {
        let known = ledger.find(&item.file_name);
        return Ok(Some(Replaced {
            old_file: item.file_name.clone(),
            from_version: known
                .map(|e| e.version_id.clone())
                .unwrap_or_else(|| UNKNOWN_VERSION.to_owned()),
            from_version_number: known.and_then(|e| e.version_number.clone()),
        }));
    }
    find_previous_by_mod_id(ledger, mods_dir, metadata_cache, &item.task.dest).await
}

/// 按 `mod_id` 在 mods 目录里找同一个 Mod 的另一份拷贝（跨平台、跨来源）。
async fn find_previous_by_mod_id(
    ledger: &Ledger,
    mods_dir: &Path,
    metadata_cache: &Path,
    staged_file: &Path,
) -> Result<Option<Replaced>> {
    let Some(new_id) = mod_id_of(staged_file).await else {
        return Ok(None);
    };
    if !try_exists(mods_dir).await? {
        return Ok(None);
    }
    let installed = scan_mods_dir_cached(mods_dir, Some(metadata_cache)).await?;
    for item in installed {
        let Some(meta) = &item.metadata else {
            continue;
        };
        if meta.mod_id != new_id {
            continue;
        }
        let key = ledger_key(&item.file_name).to_owned();
        let known = ledger.find(&key);
        return Ok(Some(Replaced {
            from_version: known
                .map(|e| e.version_id.clone())
                .unwrap_or_else(|| UNKNOWN_VERSION.to_owned()),
            from_version_number: known.and_then(|e| e.version_number.clone()),
            old_file: key,
        }));
    }
    Ok(None)
}

/// 读一个暂存 jar 的 `mod_id`；没有可识别的描述文件返回 `None`。
///
/// 解析失败同样返回 `None`（记告警）：这道判据是额外收益，读不出元数据的 jar（损坏包、非标准打包）
/// 不该让整次安装失败——它已经通过了平台声明的完整性校验。
async fn mod_id_of(path: &Path) -> Option<String> {
    match parse_mod_metadata(path).await {
        Ok(meta) => meta.map(|meta| meta.mod_id),
        Err(err) => {
            tracing::warn!(path = %path.display(), error = %err, "读取暂存 jar 的 mod_id 失败，跳过按 mod_id 查重");
            None
        }
    }
}

/// 把一个暂存文件移进 mods 目录，必要时先给旧文件留一份 `.old` 备份。
async fn place_file(
    mods_dir: &Path,
    item: StagedItem,
    replaced: Option<Replaced>,
) -> Result<Placement> {
    let backup_file = match &replaced {
        Some(previous) => Some(backup_previous(mods_dir, &previous.old_file).await?),
        None => None,
    };
    let dest = mods_dir.join(&item.file_name);
    tokio::fs::rename(&item.task.dest, &dest)
        .await
        .map_err(|source| aurora_base::Error::Io {
            path: dest.clone(),
            source,
        })?;
    Ok(Placement {
        file_name: item.file_name,
        version: item.version,
        title: item.title,
        icon_url: item.icon_url,
        sha1: item.sha1,
        required_by: item.required_by,
        replaced,
        backup_file,
    })
}

/// 把旧文件改名为备份留在原目录，返回备份名；这是回滚的全部凭据。
///
/// 备份名取 `<old_file>.old`，已被更早的一次更新占着时依次取 `<old_file>.2.old`、`.3.old`……：
/// rename 会悄无声息地覆盖同名文件，盖掉的正是更早那次更新唯一的回滚凭据。调用方持有 mods 目录
/// 写锁，选名与改名之间不会有本启动器的另一次写入插进来。
///
/// 启用态与禁用态两种名字都试：玩家把旧版禁用了是常见操作，只认启用态会在 mods 里留下一份没人管的
/// `<old_file>.disabled`，下次更新检查还会拿它当一个独立的已装 Mod 去查。
async fn backup_previous(mods_dir: &Path, old_file: &str) -> Result<String> {
    let mut n = 1;
    let backup_file = loop {
        let candidate = numbered_backup_name(old_file, n);
        if !try_exists(&mods_dir.join(&candidate)).await? {
            break candidate;
        }
        n += 1;
    };
    let backup = mods_dir.join(&backup_file);
    for candidate in [
        mods_dir.join(old_file),
        mods_dir.join(format!("{old_file}{DISABLED_SUFFIX}")),
    ] {
        match tokio::fs::rename(&candidate, &backup).await {
            Ok(()) => return Ok(backup_file),
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => continue,
            Err(source) => {
                return Err(aurora_base::Error::Io {
                    path: candidate,
                    source,
                }
                .into());
            }
        }
    }
    // 判定阶段还看得见这个文件，真去改名时它没了：只可能是外部同时在动这个目录。这时候继续往下走会
    // 直接覆盖掉未知状态，不如停在这里。
    Err(refuse(
        &mods_dir.join(old_file),
        std::io::ErrorKind::NotFound,
        format!("待备份的旧文件 {old_file} 在备份前消失了，已中止安装"),
    ))
}

/// 一个文件落位后发给 UI 的那句话。
fn describe_placement(placement: &Placement) -> String {
    match (&placement.replaced, &placement.backup_file) {
        (Some(previous), Some(backup)) => format!(
            "{} 已更新，旧版 {} 备份为 {backup}",
            placement.file_name, previous.old_file
        ),
        _ => format!("{} 已放入 mods 目录", placement.file_name),
    }
}

/// 删掉本次安装的暂存子目录。
///
/// 清理失败只发告警不冒泡：它既不该把「已经装好了」翻案成失败，也不该盖住真正的根因错误。
async fn discard_staging(staging_dir: &Path, events: Option<&EventSink>) {
    if let Err(err) = tokio::fs::remove_dir_all(staging_dir).await
        && err.kind() != std::io::ErrorKind::NotFound
    {
        tracing::warn!(dir = %staging_dir.display(), error = %err, "清理暂存目录失败");
        emit(
            events,
            CoreEvent::warning(format!(
                "清理暂存目录 {} 失败：{err}",
                staging_dir.display()
            )),
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::AuroraConfig;
    use aurora_instance::{IsolationOverride, IsolationPolicy, VersionSettings};
    use sha1::{Digest, Sha1};
    use wiremock::matchers::{method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    /// 在 versions/<id>/<id>.json 落一份最小合法版本 JSON（正式原版，不装加载器）。
    async fn put_version(mc: &Path, id: &str) {
        let dir = mc.join("versions").join(id);
        tokio::fs::create_dir_all(&dir).await.unwrap();
        tokio::fs::write(
            dir.join(format!("{id}.json")),
            format!(r#"{{"id":"{id}","type":"release","mainClass":"m"}}"#),
        )
        .await
        .unwrap();
    }

    fn sha1_hex(bytes: &[u8]) -> String {
        Sha1::digest(bytes)
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect()
    }

    /// 拼一条 Modrinth 版本 JSON。`deps` 原样填进 dependencies 数组，`hashes` 原样填进文件哈希对象。
    #[allow(clippy::too_many_arguments)]
    fn modrinth_version(
        id: &str,
        project: &str,
        date: &str,
        file_name: &str,
        url: &str,
        hashes: &str,
        size: usize,
        deps: &str,
    ) -> String {
        format!(
            r#"{{"id":"{id}","project_id":"{project}","name":"{project} {id}",
                "version_number":"{id}.0","version_type":"release","date_published":"{date}",
                "game_versions":["1.21"],"loaders":[],"dependencies":[{deps}],
                "files":[{{"hashes":{hashes},"url":"{url}","filename":"{file_name}",
                    "primary":true,"size":{size}}}]}}"#
        )
    }

    /// 挂单版本端点（主项与钉版本的依赖走它）。
    async fn mount_version(server: &MockServer, id: &str, body: &str) {
        Mock::given(method("GET"))
            .and(path(format!("/version/{id}")))
            .respond_with(ResponseTemplate::new(200).set_body_string(body.to_owned()))
            .mount(server)
            .await;
    }

    /// 挂工程版本列表端点（不钉版本的依赖走它）。
    async fn mount_versions(server: &MockServer, project: &str, body: String) {
        Mock::given(method("GET"))
            .and(path(format!("/project/{project}/version")))
            .respond_with(ResponseTemplate::new(200).set_body_string(body))
            .mount(server)
            .await;
    }

    /// 挂工程摘要批量端点：给出的每个工程都带标题与图标。
    async fn mount_projects(server: &MockServer, projects: &[(&str, &str)]) {
        let body: Vec<String> = projects
            .iter()
            .map(|(id, title)| {
                format!(
                    r#"{{"id":"{id}","title":"{title}","description":"d","project_type":"mod",
                        "downloads":1,"icon_url":"https://cdn.example.invalid/{id}.png"}}"#
                )
            })
            .collect();
        Mock::given(method("GET"))
            .and(path("/projects"))
            .respond_with(
                ResponseTemplate::new(200).set_body_string(format!("[{}]", body.join(","))),
            )
            .mount(server)
            .await;
    }

    /// 挂一个 jar 直链。
    async fn mount_jar(server: &MockServer, name: &str, bytes: Vec<u8>) {
        Mock::given(method("GET"))
            .and(path(format!("/{name}")))
            .respond_with(ResponseTemplate::new(200).set_body_bytes(bytes))
            .mount(server)
            .await;
    }

    /// 造一个隔离档位为 All 的测试门面。
    fn isolated_aurora(mc: &Path, base: String) -> Aurora {
        let mut aurora =
            Aurora::for_test(AuroraConfig::default(), mc.to_path_buf(), mc.to_path_buf());
        aurora.set_isolation_policy(IsolationPolicy::All);
        aurora.with_modrinth_base(base)
    }

    /// 挂好「sodium v1 一个文件、无依赖」的全套端点，返回 jar 字节。
    async fn mount_sodium(server: &MockServer, version: &str, file: &str, bytes: &[u8]) {
        let body = modrinth_version(
            version,
            "sodium",
            "2026-01-01T00:00:00Z",
            file,
            &format!("{}/{file}", server.uri()),
            &format!(r#"{{"sha1":"{}"}}"#, sha1_hex(bytes)),
            bytes.len(),
            "",
        );
        mount_version(server, version, &body).await;
        mount_jar(server, file, bytes.to_vec()).await;
    }

    async fn dir_names(dir: &Path) -> Vec<String> {
        let mut reader = tokio::fs::read_dir(dir).await.unwrap();
        let mut names = Vec::new();
        while let Some(entry) = reader.next_entry().await.unwrap() {
            names.push(entry.file_name().to_string_lossy().into_owned());
        }
        names.sort();
        names
    }

    fn refusal(err: &CoreError) -> (PathBuf, String) {
        match err {
            CoreError::Base(aurora_base::Error::Io { path, source }) => {
                (path.clone(), source.to_string())
            }
            other => panic!("期望拒绝错误，得到 {other:?}"),
        }
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn install_lands_in_isolated_mods_dir_then_lists_with_source_and_toggles() {
        let server = MockServer::start().await;
        let jar = b"sodium jar bytes".to_vec();
        mount_sodium(&server, "v1", "sodium-v1.jar", &jar).await;
        mount_projects(&server, &[("sodium", "Sodium")]).await;

        let tmp = tempfile::tempdir().unwrap();
        put_version(tmp.path(), "1.21").await;
        let aurora = isolated_aurora(tmp.path(), server.uri());

        let outcome = aurora
            .install_mod("1.21", Platform::Modrinth, "sodium", "v1", None)
            .await
            .unwrap();
        let mods_dir = tmp.path().join("versions").join("1.21").join("mods");
        assert_eq!(outcome.file_name, "sodium-v1.jar");
        assert_eq!(outcome.path, mods_dir.join("sodium-v1.jar"));
        assert_eq!(outcome.platform, Platform::Modrinth);
        assert_eq!(tokio::fs::read(&outcome.path).await.unwrap(), jar);
        // 暂存子目录已清理，mods 里只有这一个文件。
        assert_eq!(dir_names(&mods_dir).await, vec!["sodium-v1.jar"]);
        let staging = tmp
            .path()
            .join("versions")
            .join("1.21")
            .join(AURORA_META_DIR)
            .join(STAGING_DIR);
        assert!(dir_names(&staging).await.is_empty());

        let listed = aurora.list_mods("1.21").await.unwrap();
        assert_eq!(listed.len(), 1);
        assert!(listed[0].installed.enabled);
        assert_eq!(listed[0].installed.size, jar.len() as u64);
        assert_eq!(
            listed[0].icon_url.as_deref(),
            Some("https://cdn.example.invalid/sodium.png")
        );
        let source = listed[0].source.as_ref().expect("装过的 Mod 应带来源");
        assert_eq!(source.project_id, "sodium");
        assert_eq!(source.version_id, "v1");
        assert_eq!(source.version_number.as_deref(), Some("v1.0"));
        assert_eq!(source.title.as_deref(), Some("Sodium"));
        assert_eq!(source.dependency_of, None);

        // IPC 形状：扫描字段被摊平在同一层，来源与图标并列其后。
        let json = serde_json::to_value(&listed[0]).unwrap();
        assert_eq!(json["file_name"], "sodium-v1.jar");
        assert_eq!(json["enabled"], true);
        assert_eq!(json["source"]["platform"], "modrinth");
        assert_eq!(json["icon_url"], "https://cdn.example.invalid/sodium.png");

        let disabled = aurora
            .set_mod_enabled("1.21", "sodium-v1.jar", false)
            .await
            .unwrap();
        assert_eq!(disabled, mods_dir.join("sodium-v1.jar.disabled"));
        let listed = aurora.list_mods("1.21").await.unwrap();
        assert!(!listed[0].installed.enabled);
        // 禁用只改文件名，卷宗身份照样 join 得上。
        assert_eq!(listed[0].source.as_ref().unwrap().version_id, "v1");
        aurora
            .set_mod_enabled("1.21", "sodium-v1.jar.disabled", true)
            .await
            .unwrap();
        assert!(mods_dir.join("sodium-v1.jar").exists());
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn install_lands_in_shared_root_mods_when_isolation_disabled() {
        let server = MockServer::start().await;
        mount_sodium(&server, "v1", "sodium-v1.jar", b"jar").await;
        mount_projects(&server, &[]).await;

        let tmp = tempfile::tempdir().unwrap();
        put_version(tmp.path(), "1.21").await;
        let mut aurora = Aurora::for_test(
            AuroraConfig::default(),
            tmp.path().to_path_buf(),
            tmp.path().to_path_buf(),
        );
        aurora.set_isolation_policy(IsolationPolicy::Disabled);
        let aurora = aurora.with_modrinth_base(server.uri());

        let outcome = aurora
            .install_mod("1.21", Platform::Modrinth, "sodium", "v1", None)
            .await
            .unwrap();
        assert_eq!(outcome.path, tmp.path().join("mods").join("sodium-v1.jar"));
        // 卷宗与历史仍挂在版本目录下：它们记的是这个版本的事实，不随工作目录漂移。
        let ledger = aurora.ledger_store("1.21").load().await.unwrap();
        assert_eq!(ledger.entries.len(), 1);
        // 工程摘要端点没给标题：标题与图标如实留空，不编造。
        assert_eq!(ledger.entries[0].title, None);
        assert_eq!(ledger.entries[0].icon_url, None);
    }

    /// 版本级隔离覆盖压过全局档位：全局关隔离、该实例单独开，Mod 必须落进版本目录。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn version_isolation_override_decides_the_mods_dir() {
        let server = MockServer::start().await;
        mount_sodium(&server, "v1", "sodium-v1.jar", b"jar").await;
        mount_projects(&server, &[]).await;

        let tmp = tempfile::tempdir().unwrap();
        put_version(tmp.path(), "1.21").await;
        let version_dir = tmp.path().join("versions").join("1.21");
        VersionSettingsStore::for_version_dir(&version_dir)
            .save(&VersionSettings {
                isolation: IsolationOverride::Enabled,
                ..VersionSettings::default()
            })
            .await
            .unwrap();
        let mut aurora = Aurora::for_test(
            AuroraConfig::default(),
            tmp.path().to_path_buf(),
            tmp.path().to_path_buf(),
        );
        aurora.set_isolation_policy(IsolationPolicy::Disabled);
        let aurora = aurora.with_modrinth_base(server.uri());

        let outcome = aurora
            .install_mod("1.21", Platform::Modrinth, "sodium", "v1", None)
            .await
            .unwrap();
        assert_eq!(outcome.path, version_dir.join("mods").join("sodium-v1.jar"));
        assert!(!tmp.path().join("mods").exists());
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn operations_on_uninstalled_or_unsafe_version_error_before_network() {
        // 不挂任何端点：一旦实现先去联网，得到的会是别的错误。
        let server = MockServer::start().await;
        let tmp = tempfile::tempdir().unwrap();
        let aurora = isolated_aurora(tmp.path(), server.uri());

        for id in ["ghost", "../escape", ""] {
            let err = aurora
                .install_mod(id, Platform::Modrinth, "sodium", "v1", None)
                .await
                .unwrap_err();
            assert!(
                matches!(&err, CoreError::VersionNotInstalled { id: got } if got == id),
                "{id:?} 应判为未安装，实得 {err:?}"
            );
        }
        assert!(matches!(
            aurora.list_mods("ghost").await.unwrap_err(),
            CoreError::VersionNotInstalled { .. }
        ));
        assert!(matches!(
            aurora.remove_mod("ghost", "a.jar").await.unwrap_err(),
            CoreError::VersionNotInstalled { .. }
        ));
        assert!(server.received_requests().await.unwrap().is_empty());
    }

    /// 版本目录在但 JSON 损坏：与全量扫描口径一致，按未安装处理。
    #[tokio::test]
    async fn broken_version_json_counts_as_not_installed() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("versions").join("broken");
        tokio::fs::create_dir_all(&dir).await.unwrap();
        tokio::fs::write(dir.join("broken.json"), b"{ not json")
            .await
            .unwrap();
        let aurora = isolated_aurora(tmp.path(), "http://127.0.0.1:9".to_owned());
        assert!(matches!(
            aurora.resolve_instance("broken").await.unwrap_err(),
            CoreError::VersionNotInstalled { id } if id == "broken"
        ));
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn install_missing_platform_version_errors() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/version/nope"))
            .respond_with(ResponseTemplate::new(404))
            .mount(&server)
            .await;

        let tmp = tempfile::tempdir().unwrap();
        put_version(tmp.path(), "1.21").await;
        let aurora = isolated_aurora(tmp.path(), server.uri());

        let err = aurora
            .install_mod("1.21", Platform::Modrinth, "sodium", "nope", None)
            .await
            .unwrap_err();
        match err {
            CoreError::ModVersionNotFound {
                project_id,
                version_id,
                ..
            } => {
                assert_eq!(project_id, "sodium");
                assert_eq!(version_id, "nope");
            }
            other => panic!("期望 ModVersionNotFound，得到 {other:?}"),
        }
    }

    /// 挂一个 CurseForge 文件：文件对象里的直链取 `download_url`，download-url 端点按 `fallback` 应答，
    /// 工程摘要给受限文件的网页链接用。
    async fn mount_curseforge_file(
        server: &MockServer,
        download_url: serde_json::Value,
        fallback: ResponseTemplate,
    ) {
        let file = serde_json::json!({
            "id": 5000, "modId": 238222, "displayName": "JEI", "fileName": "jei-1.21.jar",
            "releaseType": 1, "hashes": [], "fileDate": "2026-01-01T00:00:00Z", "fileLength": 4,
            "downloadUrl": download_url, "gameVersions": ["1.21"], "dependencies": []
        });
        Mock::given(method("GET"))
            .and(path("/v1/mods/238222/files/5000"))
            .respond_with(
                ResponseTemplate::new(200).set_body_json(serde_json::json!({"data": file})),
            )
            .mount(server)
            .await;
        Mock::given(method("POST"))
            .and(path("/v1/mods"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({"data": []})))
            .mount(server)
            .await;
        Mock::given(method("GET"))
            .and(path("/v1/mods/238222/files/5000/download-url"))
            .respond_with(fallback)
            .mount(server)
            .await;
        Mock::given(method("GET"))
            .and(path("/v1/mods/238222"))
            .respond_with(
                ResponseTemplate::new(200).set_body_json(serde_json::json!({"data": {
                    "id": 238222, "name": "JEI", "slug": "jei", "summary": "", "classId": 6
                }})),
            )
            .mount(server)
            .await;
    }

    /// 作者禁止第三方分发的 CurseForge 文件：文件对象不给直链，download-url 端点拒绝或给空串。
    /// 装 Mod 要与整合包导入一样报「需要到网页手动下载」并带上文件名与网页链接，而不是一句笼统的 HTTP
    /// 失败；什么都不落进 mods 目录。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn curseforge_file_blocked_from_distribution_is_reported_as_such() {
        let cases = [
            (serde_json::Value::Null, ResponseTemplate::new(403)),
            (serde_json::json!(""), ResponseTemplate::new(404)),
            (
                serde_json::Value::Null,
                ResponseTemplate::new(200).set_body_json(serde_json::json!({"data": ""})),
            ),
        ];
        for (download_url, fallback) in cases {
            let server = MockServer::start().await;
            mount_curseforge_file(&server, download_url.clone(), fallback).await;
            let tmp = tempfile::tempdir().unwrap();
            put_version(tmp.path(), "1.21").await;
            let aurora = isolated_aurora(tmp.path(), server.uri())
                .with_curseforge_base(server.uri())
                .with_curseforge_key("test-key");

            let err = aurora
                .install_mod("1.21", Platform::CurseForge, "238222", "5000", None)
                .await
                .unwrap_err();
            let CoreError::FileDistributionBlocked { files } = &err else {
                panic!("直链 {download_url}：期望 FileDistributionBlocked，得到 {err:?}");
            };
            assert_eq!(
                files,
                &[BlockedFile {
                    project_id: 238222,
                    file_id: 5000,
                    file_name: "jei-1.21.jar".into(),
                    web_url: "https://www.curseforge.com/minecraft/mc-mods/jei/files/5000".into(),
                    destination: "mods/jei-1.21.jar".into(),
                    sha1: None,
                    fingerprint: 0,
                    size: Some(4),
                }],
                "直链 {download_url}"
            );
            let mods_dir = aurora.resolve_mods_dir("1.21").await.unwrap();
            assert!(!try_exists(&mods_dir.join("jei-1.21.jar")).await.unwrap());
        }
    }

    #[tokio::test]
    async fn list_mods_on_version_without_mods_dir_is_empty() {
        let tmp = tempfile::tempdir().unwrap();
        put_version(tmp.path(), "1.21").await;
        let aurora = isolated_aurora(tmp.path(), "http://127.0.0.1:9".to_owned());
        assert!(aurora.list_mods("1.21").await.unwrap().is_empty());
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn required_dependency_is_installed_alongside_and_recorded() {
        let server = MockServer::start().await;
        let main_jar = b"main".to_vec();
        let dep_jar = b"dependency".to_vec();
        let main = modrinth_version(
            "v1",
            "sodium",
            "2026-01-01T00:00:00Z",
            "sodium-v1.jar",
            &format!("{}/sodium-v1.jar", server.uri()),
            &format!(r#"{{"sha1":"{}"}}"#, sha1_hex(&main_jar)),
            main_jar.len(),
            r#"{"project_id":"fabric-api","dependency_type":"required"}"#,
        );
        mount_version(&server, "v1", &main).await;
        let dep = modrinth_version(
            "d1",
            "fabric-api",
            "2026-01-01T00:00:00Z",
            "fabric-api-d1.jar",
            &format!("{}/fabric-api-d1.jar", server.uri()),
            &format!(r#"{{"sha1":"{}"}}"#, sha1_hex(&dep_jar)),
            dep_jar.len(),
            "",
        );
        mount_versions(&server, "fabric-api", format!("[{dep}]")).await;
        mount_jar(&server, "sodium-v1.jar", main_jar).await;
        mount_jar(&server, "fabric-api-d1.jar", dep_jar).await;
        mount_projects(
            &server,
            &[("sodium", "Sodium"), ("fabric-api", "Fabric API")],
        )
        .await;

        let tmp = tempfile::tempdir().unwrap();
        put_version(tmp.path(), "1.21").await;
        let aurora = isolated_aurora(tmp.path(), server.uri());
        let outcome = aurora
            .install_mod("1.21", Platform::Modrinth, "sodium", "v1", None)
            .await
            .unwrap();
        assert_eq!(outcome.file_name, "sodium-v1.jar");

        let mods_dir = aurora.resolve_mods_dir("1.21").await.unwrap();
        assert_eq!(
            dir_names(&mods_dir).await,
            vec!["fabric-api-d1.jar", "sodium-v1.jar"]
        );
        let ledger = aurora.ledger_store("1.21").load().await.unwrap();
        let dep = ledger.find("fabric-api-d1.jar").unwrap();
        assert_eq!(dep.installed_as_dependency_of.as_deref(), Some("sodium"));
        assert_eq!(dep.title.as_deref(), Some("Fabric API"));
        let main = ledger.find("sodium-v1.jar").unwrap();
        assert_eq!(main.installed_as_dependency_of, None);

        // 一次安装一条事件，列出全部落盘文件（主项在前）。
        let history = aurora.history("1.21").await.unwrap();
        assert_eq!(history.events.len(), 1);
        match &history.events[0] {
            HistoryEvent::Install { files, .. } => {
                assert_eq!(
                    files,
                    &vec!["sodium-v1.jar".to_owned(), "fabric-api-d1.jar".to_owned()]
                );
            }
            other => panic!("期望安装事件，得到 {other:?}"),
        }
    }

    /// 校验不过：mods 里一个文件都不落，卷宗与历史都不写。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn integrity_failure_leaves_mods_dir_empty_and_writes_nothing() {
        let server = MockServer::start().await;
        let body = modrinth_version(
            "v1",
            "sodium",
            "2026-01-01T00:00:00Z",
            "sodium-v1.jar",
            &format!("{}/sodium-v1.jar", server.uri()),
            // 声明的哈希与实际字节对不上。
            r#"{"sha1":"0000000000000000000000000000000000000000"}"#,
            3,
            "",
        );
        mount_version(&server, "v1", &body).await;
        mount_jar(&server, "sodium-v1.jar", b"bad".to_vec()).await;
        mount_projects(&server, &[]).await;

        let tmp = tempfile::tempdir().unwrap();
        put_version(tmp.path(), "1.21").await;
        let aurora = isolated_aurora(tmp.path(), server.uri());
        aurora
            .install_mod("1.21", Platform::Modrinth, "sodium", "v1", None)
            .await
            .unwrap_err();

        let version_dir = tmp.path().join("versions").join("1.21");
        assert!(!version_dir.join("mods").join("sodium-v1.jar").exists());
        assert_eq!(
            aurora.ledger_store("1.21").load().await.unwrap(),
            Ledger::default()
        );
        assert!(aurora.history("1.21").await.unwrap().events.is_empty());
        let staging = version_dir.join(AURORA_META_DIR).join(STAGING_DIR);
        assert!(dir_names(&staging).await.is_empty(), "暂存子目录必须被清掉");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn zero_byte_payload_is_rejected_before_touching_mods_dir() {
        let server = MockServer::start().await;
        // 平台没给哈希、声明大小为 0：能验的只剩「不是空壳」。
        let body = r#"{"id":"v1","project_id":"sodium","name":"s","version_number":"1",
            "version_type":"release","date_published":"2026-01-01T00:00:00Z",
            "game_versions":["1.21"],"loaders":[],"dependencies":[],
            "files":[{"hashes":{},"url":"URL/empty.jar","filename":"empty.jar","primary":true,"size":0}]}"#
            .replace("URL", &server.uri());
        mount_version(&server, "v1", &body).await;
        mount_jar(&server, "empty.jar", Vec::new()).await;
        mount_projects(&server, &[]).await;

        let tmp = tempfile::tempdir().unwrap();
        put_version(tmp.path(), "1.21").await;
        let aurora = isolated_aurora(tmp.path(), server.uri());
        let err = aurora
            .install_mod("1.21", Platform::Modrinth, "sodium", "v1", None)
            .await
            .unwrap_err();
        let (_, reason) = refusal(&err);
        assert!(reason.contains("0 字节"), "原因实得 {reason}");
        assert!(!tmp.path().join("versions/1.21/mods/empty.jar").exists());
    }

    /// 平台给出带路径成分的文件名：在下载之前拒绝，不让它写出暂存区。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn platform_file_name_with_path_components_is_refused() {
        let server = MockServer::start().await;
        let body = modrinth_version(
            "v1",
            "sodium",
            "2026-01-01T00:00:00Z",
            "../evil.jar",
            &format!("{}/evil.jar", server.uri()),
            r#"{}"#,
            3,
            "",
        );
        mount_version(&server, "v1", &body).await;
        mount_projects(&server, &[]).await;

        let tmp = tempfile::tempdir().unwrap();
        put_version(tmp.path(), "1.21").await;
        let aurora = isolated_aurora(tmp.path(), server.uri());
        let err = aurora
            .install_mod("1.21", Platform::Modrinth, "sodium", "v1", None)
            .await
            .unwrap_err();
        let (_, reason) = refusal(&err);
        assert!(reason.contains("不是合法的纯文件名"), "原因实得 {reason}");
        assert!(!tmp.path().join("versions/1.21/evil.jar").exists());
    }

    /// 更新：旧文件改名为 .old 留底，新文件移入，卷宗换成新身份，历史记一条带版本号的更新事件。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn update_mod_backs_up_old_file_and_records_update() {
        let server = MockServer::start().await;
        let old_jar = b"sodium old".to_vec();
        let new_jar = b"sodium new build".to_vec();
        mount_sodium(&server, "v1", "sodium-v1.jar", &old_jar).await;
        mount_sodium(&server, "v2", "sodium-v2.jar", &new_jar).await;
        mount_projects(&server, &[("sodium", "Sodium")]).await;

        let tmp = tempfile::tempdir().unwrap();
        put_version(tmp.path(), "1.21").await;
        let aurora = isolated_aurora(tmp.path(), server.uri());
        aurora
            .install_mod("1.21", Platform::Modrinth, "sodium", "v1", None)
            .await
            .unwrap();
        // 玩家把旧版禁用过：备份时禁用态那份也要认得出来。
        aurora
            .set_mod_enabled("1.21", "sodium-v1.jar", false)
            .await
            .unwrap();

        // 装进实例的时刻定在过去，好与「现在」区分；更新设置经禁用态文件名设上。
        let store = aurora.ledger_store("1.21");
        let mut ledger = store.load().await.unwrap();
        ledger.find_mut("sodium-v1.jar").unwrap().installed_at = 1_600_000_000;
        store.save(&ledger).await.unwrap();
        let pin = UpdateHold::Pinned {
            version_id: "v2".to_owned(),
        };
        aurora
            .set_mod_update_hold("1.21", "sodium-v1.jar.disabled", Some(pin.clone()))
            .await
            .unwrap();

        let outcome = aurora
            .update_mod("1.21", "sodium-v1.jar.disabled", "v2", None)
            .await
            .unwrap();
        assert_eq!(outcome.file_name, "sodium-v2.jar");

        let mods_dir = aurora.resolve_mods_dir("1.21").await.unwrap();
        assert_eq!(
            dir_names(&mods_dir).await,
            vec!["sodium-v1.jar.old", "sodium-v2.jar"]
        );
        assert_eq!(
            tokio::fs::read(mods_dir.join("sodium-v1.jar.old"))
                .await
                .unwrap(),
            old_jar
        );
        assert_eq!(
            aurora.backup_size("1.21").await.unwrap(),
            old_jar.len() as u64
        );

        let ledger = aurora.ledger_store("1.21").load().await.unwrap();
        assert_eq!(ledger.entries.len(), 1, "旧文件名的条目必须摘掉");
        let entry = ledger.find("sodium-v2.jar").unwrap();
        assert_eq!(entry.version_id, "v2");
        assert_eq!(entry.sha1.as_deref(), Some(sha1_hex(&new_jar).as_str()));
        // 换的是版本不是 Mod：装进实例的时刻与更新设置原样带到新条目上。
        assert_eq!(entry.installed_at, 1_600_000_000);
        assert_eq!(entry.update_hold, Some(pin.clone()));

        let history = aurora.history("1.21").await.unwrap();
        assert_eq!(history.events.len(), 2);
        match &history.events[1] {
            HistoryEvent::Update {
                file_name,
                old_file,
                from_version,
                to_version,
                title,
                from_version_number,
                to_version_number,
                ..
            } => {
                assert_eq!(file_name, "sodium-v2.jar");
                assert_eq!(old_file, "sodium-v1.jar");
                assert_eq!(from_version, "v1");
                assert_eq!(to_version, "v2");
                assert_eq!(title.as_deref(), Some("Sodium"));
                assert_eq!(from_version_number.as_deref(), Some("v1.0"));
                assert_eq!(to_version_number.as_deref(), Some("v2.0"));
            }
            other => panic!("期望更新事件，得到 {other:?}"),
        }

        // 回滚凭据成立：这条更新可以回滚，回滚后旧版回来。
        let checks = aurora.rollback_checks("1.21").await.unwrap();
        assert!(checks[1].can_rollback);
        let update_id = history.events[1].id().to_owned();
        aurora.rollback("1.21", &update_id).await.unwrap();
        assert_eq!(dir_names(&mods_dir).await, vec!["sodium-v1.jar"]);
        let ledger = aurora.ledger_store("1.21").load().await.unwrap();
        let restored = ledger.find("sodium-v1.jar").unwrap();
        assert_eq!(restored.version_number.as_deref(), Some("v1.0"));
        // 回滚同样不改装进实例的时刻，更新设置也还在。
        assert_eq!(restored.installed_at, 1_600_000_000);
        assert_eq!(restored.update_hold, Some(pin));
    }

    /// 挂一个文件名固定为 sodium.jar 的版本：各版本的下载地址按版本分开，文件名却相同（原地更新）。
    async fn mount_same_name_sodium(server: &MockServer, version: &str, bytes: &[u8]) {
        let url = format!("{}/{version}/sodium.jar", server.uri());
        let body = modrinth_version(
            version,
            "sodium",
            "2026-01-01T00:00:00Z",
            "sodium.jar",
            &url,
            &format!(r#"{{"sha1":"{}"}}"#, sha1_hex(bytes)),
            bytes.len(),
            "",
        );
        mount_version(server, version, &body).await;
        mount_jar(server, &format!("{version}/sodium.jar"), bytes.to_vec()).await;
    }

    /// 同名原地更新连做两次：第二份备份带序号、不盖掉第一份，事件记下各自的备份名；较早的更新要等
    /// 较晚的回滚之后才能回滚，两步回滚后内容、卷宗版本与哈希都回到最初那一版。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn repeated_in_place_updates_keep_every_backup_and_roll_back_in_order() {
        let server = MockServer::start().await;
        let (v1, v2, v3) = (b"one".to_vec(), b"two-two".to_vec(), b"three-3-3".to_vec());
        mount_same_name_sodium(&server, "v1", &v1).await;
        mount_same_name_sodium(&server, "v2", &v2).await;
        mount_same_name_sodium(&server, "v3", &v3).await;
        mount_projects(&server, &[("sodium", "Sodium")]).await;
        let tmp = tempfile::tempdir().unwrap();
        put_version(tmp.path(), "1.21").await;
        let aurora = isolated_aurora(tmp.path(), server.uri());

        aurora
            .install_mod("1.21", Platform::Modrinth, "sodium", "v1", None)
            .await
            .unwrap();
        let store = aurora.ledger_store("1.21");
        let mut ledger = store.load().await.unwrap();
        let entry = ledger.find_mut("sodium.jar").unwrap();
        entry.installed_at = 1_500_000_000;
        entry.update_hold = Some(UpdateHold::Ignored);
        store.save(&ledger).await.unwrap();
        aurora
            .update_mod("1.21", "sodium.jar", "v2", None)
            .await
            .unwrap();
        aurora
            .update_mod("1.21", "sodium.jar", "v3", None)
            .await
            .unwrap();
        // 同名原地更新同样沿用旧条目的装进时刻与更新设置。
        let entry = store
            .load()
            .await
            .unwrap()
            .find("sodium.jar")
            .cloned()
            .unwrap();
        assert_eq!(entry.version_id, "v3");
        assert_eq!(entry.installed_at, 1_500_000_000);
        assert_eq!(entry.update_hold, Some(UpdateHold::Ignored));

        let mods_dir = aurora.resolve_mods_dir("1.21").await.unwrap();
        assert_eq!(
            dir_names(&mods_dir).await,
            vec!["sodium.jar", "sodium.jar.2.old", "sodium.jar.old"]
        );
        let read = |name: &str| std::fs::read(mods_dir.join(name)).unwrap();
        assert_eq!(read("sodium.jar.old"), v1);
        assert_eq!(read("sodium.jar.2.old"), v2);
        assert_eq!(read("sodium.jar"), v3);
        assert_eq!(
            aurora.backup_size("1.21").await.unwrap(),
            (v1.len() + v2.len()) as u64
        );

        let history = aurora.history("1.21").await.unwrap();
        let updates: Vec<(String, Option<String>)> = history
            .events
            .iter()
            .filter_map(|event| match event {
                HistoryEvent::Update {
                    id, backup_file, ..
                } => Some((id.clone(), backup_file.clone())),
                _ => None,
            })
            .collect();
        assert_eq!(updates.len(), 2);
        assert_eq!(updates[0].1.as_deref(), Some("sodium.jar.old"));
        assert_eq!(updates[1].1.as_deref(), Some("sodium.jar.2.old"));
        let checks = aurora.rollback_checks("1.21").await.unwrap();
        assert_eq!(
            checks.iter().map(|c| c.can_rollback).collect::<Vec<_>>(),
            vec![false, false, true],
            "安装不可回滚，第一次更新被第二次盖过"
        );
        assert!(aurora.rollback("1.21", &updates[0].0).await.is_err());
        assert_eq!(read("sodium.jar"), v3);

        aurora.rollback("1.21", &updates[1].0).await.unwrap();
        assert_eq!(read("sodium.jar"), v2);
        assert_eq!(
            dir_names(&mods_dir).await,
            vec!["sodium.jar", "sodium.jar.old"]
        );
        aurora.rollback("1.21", &updates[0].0).await.unwrap();
        assert_eq!(dir_names(&mods_dir).await, vec!["sodium.jar"]);
        assert_eq!(read("sodium.jar"), v1);
        let ledger = aurora.ledger_store("1.21").load().await.unwrap();
        let entry = ledger.find("sodium.jar").unwrap();
        assert_eq!(entry.version_id, "v1");
        assert_eq!(entry.version_number.as_deref(), Some("v1.0"));
        assert_eq!(entry.sha1.as_deref(), Some(sha1_hex(&v1).as_str()));
    }

    /// 改名式连续更新（v1 -> v2 -> v3）后先回滚较早的那次：被拒，mods 里只留 v3，不会出现两份同一个 Mod。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn rolling_back_an_overtaken_update_is_refused_without_duplicating_the_mod() {
        let server = MockServer::start().await;
        mount_sodium(&server, "v1", "sodium-v1.jar", b"one").await;
        mount_sodium(&server, "v2", "sodium-v2.jar", b"two").await;
        mount_sodium(&server, "v3", "sodium-v3.jar", b"three").await;
        mount_projects(&server, &[("sodium", "Sodium")]).await;
        let tmp = tempfile::tempdir().unwrap();
        put_version(tmp.path(), "1.21").await;
        let aurora = isolated_aurora(tmp.path(), server.uri());
        aurora
            .install_mod("1.21", Platform::Modrinth, "sodium", "v1", None)
            .await
            .unwrap();
        aurora
            .update_mod("1.21", "sodium-v1.jar", "v2", None)
            .await
            .unwrap();
        aurora
            .update_mod("1.21", "sodium-v2.jar", "v3", None)
            .await
            .unwrap();
        let mods_dir = aurora.resolve_mods_dir("1.21").await.unwrap();
        let before = dir_names(&mods_dir).await;
        assert_eq!(
            before,
            vec!["sodium-v1.jar.old", "sodium-v2.jar.old", "sodium-v3.jar"]
        );

        let first_update = aurora.history("1.21").await.unwrap().events[1]
            .id()
            .to_owned();
        let err = aurora.rollback("1.21", &first_update).await.unwrap_err();
        assert!(
            refusal(&err).1.contains("请先回滚之后的那次更新"),
            "{err:?}"
        );
        assert_eq!(dir_names(&mods_dir).await, before);
        let jars: Vec<_> = aurora
            .list_mods("1.21")
            .await
            .unwrap()
            .into_iter()
            .map(|m| m.installed.file_name)
            .collect();
        assert_eq!(jars, vec!["sodium-v3.jar"]);
    }

    /// 来源不明的文件不能「更新」：不知道它属于哪个工程。
    #[tokio::test]
    async fn update_mod_without_ledger_identity_is_refused() {
        let tmp = tempfile::tempdir().unwrap();
        put_version(tmp.path(), "1.21").await;
        let aurora = isolated_aurora(tmp.path(), "http://127.0.0.1:9".to_owned());
        let mods_dir = aurora.resolve_mods_dir("1.21").await.unwrap();
        tokio::fs::create_dir_all(&mods_dir).await.unwrap();
        tokio::fs::write(mods_dir.join("manual.jar"), b"x")
            .await
            .unwrap();

        let err = aurora
            .update_mod("1.21", "manual.jar", "v2", None)
            .await
            .unwrap_err();
        let (path, reason) = refusal(&err);
        assert_eq!(path, mods_dir.join("manual.jar"));
        assert!(reason.contains("没有平台来源记录"), "原因实得 {reason}");
    }

    /// 同工程同版本已在磁盘上：跳过下载（jar 端点不该被请求），卷宗条目原样保留，历史不多记。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn reinstalling_same_version_skips_download_and_keeps_ledger_entry() {
        let server = MockServer::start().await;
        let jar = b"sodium".to_vec();
        let body = modrinth_version(
            "v1",
            "sodium",
            "2026-01-01T00:00:00Z",
            "sodium-v1.jar",
            &format!("{}/sodium-v1.jar", server.uri()),
            &format!(r#"{{"sha1":"{}"}}"#, sha1_hex(&jar)),
            jar.len(),
            "",
        );
        mount_version(&server, "v1", &body).await;
        Mock::given(method("GET"))
            .and(path("/sodium-v1.jar"))
            .respond_with(ResponseTemplate::new(200).set_body_bytes(jar.clone()))
            .expect(1)
            .mount(&server)
            .await;
        mount_projects(&server, &[("sodium", "Sodium")]).await;

        let tmp = tempfile::tempdir().unwrap();
        put_version(tmp.path(), "1.21").await;
        let aurora = isolated_aurora(tmp.path(), server.uri());
        aurora
            .install_mod("1.21", Platform::Modrinth, "sodium", "v1", None)
            .await
            .unwrap();
        let ledger_before = aurora.ledger_store("1.21").load().await.unwrap();

        let outcome = aurora
            .install_mod("1.21", Platform::Modrinth, "sodium", "v1", None)
            .await
            .unwrap();
        assert_eq!(outcome.file_name, "sodium-v1.jar");
        assert_eq!(
            aurora.ledger_store("1.21").load().await.unwrap(),
            ledger_before
        );
        assert_eq!(aurora.history("1.21").await.unwrap().events.len(), 1);
    }

    /// 移除：文件删掉、卷宗条目摘掉、历史追加一条移除事件。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn remove_mod_deletes_file_drops_ledger_entry_and_records_history() {
        let server = MockServer::start().await;
        mount_sodium(&server, "v1", "sodium-v1.jar", b"jar").await;
        mount_projects(&server, &[("sodium", "Sodium")]).await;

        let tmp = tempfile::tempdir().unwrap();
        put_version(tmp.path(), "1.21").await;
        let aurora = isolated_aurora(tmp.path(), server.uri());
        aurora
            .install_mod("1.21", Platform::Modrinth, "sodium", "v1", None)
            .await
            .unwrap();
        let mods_dir = aurora.resolve_mods_dir("1.21").await.unwrap();
        // 一个手动丢进来、卷宗里没有的 jar：照样能移除，照样记历史。
        tokio::fs::write(mods_dir.join("manual.jar.disabled"), b"m")
            .await
            .unwrap();

        aurora.remove_mod("1.21", "sodium-v1.jar").await.unwrap();
        aurora
            .remove_mod("1.21", "manual.jar.disabled")
            .await
            .unwrap();

        assert!(dir_names(&mods_dir).await.is_empty());
        assert_eq!(
            aurora.ledger_store("1.21").load().await.unwrap(),
            Ledger::default()
        );
        let history = aurora.history("1.21").await.unwrap();
        let removed: Vec<Vec<String>> = history
            .events
            .iter()
            .filter_map(|event| match event {
                HistoryEvent::Remove { files, .. } => Some(files.clone()),
                _ => None,
            })
            .collect();
        assert_eq!(
            removed,
            vec![
                vec!["sodium-v1.jar".to_owned()],
                vec!["manual.jar.disabled".to_owned()]
            ]
        );
        let checks = aurora.rollback_checks("1.21").await.unwrap();
        assert_eq!(
            checks[1].reason.as_deref(),
            Some("移除事件不支持回滚，文件已从磁盘删除")
        );
    }

    /// 启用与禁用两份同时存在时只删了一份：另一份仍是这个工程，卷宗身份保留。
    #[tokio::test]
    async fn removing_one_of_two_copies_keeps_the_identity() {
        let tmp = tempfile::tempdir().unwrap();
        put_version(tmp.path(), "1.21").await;
        let aurora = isolated_aurora(tmp.path(), "http://127.0.0.1:9".to_owned());
        let mods_dir = aurora.resolve_mods_dir("1.21").await.unwrap();
        tokio::fs::create_dir_all(&mods_dir).await.unwrap();
        tokio::fs::write(mods_dir.join("a.jar"), b"1")
            .await
            .unwrap();
        tokio::fs::write(mods_dir.join("a.jar.disabled"), b"2")
            .await
            .unwrap();
        let mut ledger = Ledger::default();
        ledger.upsert(LedgerEntry {
            file_name: "a.jar".to_owned(),
            platform: Platform::Modrinth,
            project_id: "a".to_owned(),
            version_id: "v".to_owned(),
            version_number: None,
            title: None,
            icon_url: None,
            sha1: None,
            installed_at: 0,
            installed_as_dependency_of: None,
            update_hold: None,
        });
        aurora.ledger_store("1.21").save(&ledger).await.unwrap();

        aurora.remove_mod("1.21", "a.jar.disabled").await.unwrap();
        assert_eq!(aurora.ledger_store("1.21").load().await.unwrap(), ledger);
        aurora.remove_mod("1.21", "a.jar").await.unwrap();
        assert_eq!(
            aurora.ledger_store("1.21").load().await.unwrap(),
            Ledger::default()
        );
    }

    /// 移除与启停只接受 mods 目录里的模组文件名：备份、配置、带路径成分的名字一律拒绝且不动盘。
    #[tokio::test]
    async fn remove_and_toggle_refuse_anything_but_a_mod_file_name() {
        let tmp = tempfile::tempdir().unwrap();
        put_version(tmp.path(), "1.21").await;
        let aurora = isolated_aurora(tmp.path(), "http://127.0.0.1:9".to_owned());
        let mods_dir = aurora.resolve_mods_dir("1.21").await.unwrap();
        tokio::fs::create_dir_all(&mods_dir).await.unwrap();
        tokio::fs::write(mods_dir.join("a.jar.old"), b"backup")
            .await
            .unwrap();
        tokio::fs::write(tmp.path().join("outside.jar"), b"x")
            .await
            .unwrap();

        for bad in ["a.jar.old", "../../../outside.jar", "config.toml", ""] {
            let err = aurora.remove_mod("1.21", bad).await.unwrap_err();
            let (_, reason) = refusal(&err);
            assert!(
                reason.contains("不是 mods 目录里的 Mod 文件名"),
                "{bad:?}: {reason}"
            );
            assert!(aurora.set_mod_enabled("1.21", bad, false).await.is_err());
        }
        assert!(mods_dir.join("a.jar.old").exists());
        assert!(tmp.path().join("outside.jar").exists());

        // 不存在的文件：明确拒绝，不记历史。
        let err = aurora.remove_mod("1.21", "ghost.jar").await.unwrap_err();
        assert!(refusal(&err).1.contains("没有 ghost.jar"));
        assert!(aurora.history("1.21").await.unwrap().events.is_empty());
    }

    /// 批量启停：逐个给出结果、顺序同入参；单个失败不影响其余；已是目标状态的原样返回路径；不写历史。
    #[tokio::test]
    async fn set_mods_enabled_reports_each_file_in_order() {
        let tmp = tempfile::tempdir().unwrap();
        put_version(tmp.path(), "1.21").await;
        let aurora = isolated_aurora(tmp.path(), "http://127.0.0.1:9".to_owned());
        let mods_dir = aurora.resolve_mods_dir("1.21").await.unwrap();
        tokio::fs::create_dir_all(&mods_dir).await.unwrap();
        for name in ["a.jar", "b.jar.disabled", "c.jar"] {
            tokio::fs::write(mods_dir.join(name), name.as_bytes())
                .await
                .unwrap();
        }

        let names: Vec<String> = [
            "a.jar",
            "config.toml",
            "b.jar.disabled",
            "ghost.jar",
            "c.jar",
        ]
        .into_iter()
        .map(str::to_owned)
        .collect();
        let outcomes = aurora
            .set_mods_enabled("1.21", &names, false)
            .await
            .unwrap();

        assert_eq!(
            outcomes
                .iter()
                .map(|o| o.file_name.as_str())
                .collect::<Vec<_>>(),
            vec![
                "a.jar",
                "config.toml",
                "b.jar.disabled",
                "ghost.jar",
                "c.jar"
            ]
        );
        assert_eq!(
            outcomes[0].result.as_ref().unwrap(),
            &mods_dir.join("a.jar.disabled")
        );
        let (_, reason) = refusal(outcomes[1].result.as_ref().unwrap_err());
        assert!(reason.contains("不是 mods 目录里的 Mod 文件名"), "{reason}");
        // 已是禁用态：原样返回原路径。
        assert_eq!(
            outcomes[2].result.as_ref().unwrap(),
            &mods_dir.join("b.jar.disabled")
        );
        assert!(outcomes[3].result.is_err());
        assert_eq!(
            outcomes[4].result.as_ref().unwrap(),
            &mods_dir.join("c.jar.disabled")
        );
        assert_eq!(
            dir_names(&mods_dir).await,
            vec!["a.jar.disabled", "b.jar.disabled", "c.jar.disabled"]
        );
        assert!(aurora.history("1.21").await.unwrap().events.is_empty());

        // 反向批量启用。
        let back: Vec<String> = ["a.jar.disabled", "c.jar.disabled"]
            .into_iter()
            .map(str::to_owned)
            .collect();
        let outcomes = aurora.set_mods_enabled("1.21", &back, true).await.unwrap();
        assert!(outcomes.iter().all(|o| o.result.is_ok()));
        assert_eq!(
            dir_names(&mods_dir).await,
            vec!["a.jar", "b.jar.disabled", "c.jar"]
        );

        let err = aurora
            .set_mods_enabled("ghost", &back, true)
            .await
            .unwrap_err();
        assert!(matches!(err, CoreError::VersionNotInstalled { .. }));
    }

    /// 更新检查设置：禁用态文件名也能设；文件不在、无来源记录各自拒绝；值没变不改写卷宗文件。
    #[tokio::test]
    async fn set_mod_update_hold_writes_ledger_and_skips_unchanged_values() {
        let tmp = tempfile::tempdir().unwrap();
        put_version(tmp.path(), "1.21").await;
        let aurora = isolated_aurora(tmp.path(), "http://127.0.0.1:9".to_owned());
        let mods_dir = aurora.resolve_mods_dir("1.21").await.unwrap();
        tokio::fs::create_dir_all(&mods_dir).await.unwrap();
        tokio::fs::write(mods_dir.join("sodium.jar.disabled"), b"jar")
            .await
            .unwrap();
        tokio::fs::write(mods_dir.join("manual.jar"), b"jar")
            .await
            .unwrap();
        let store = aurora.ledger_store("1.21");
        let mut ledger = Ledger::default();
        for (file_name, project_id) in [("sodium.jar", "AANobbMI"), ("gone.jar", "P7dR8mSH")] {
            ledger.upsert(LedgerEntry {
                file_name: file_name.to_owned(),
                platform: Platform::Modrinth,
                project_id: project_id.to_owned(),
                version_id: "v1".to_owned(),
                version_number: None,
                title: None,
                icon_url: None,
                sha1: None,
                installed_at: 1_700_000_000,
                installed_as_dependency_of: None,
                update_hold: None,
            });
        }
        store.save(&ledger).await.unwrap();

        aurora
            .set_mod_update_hold("1.21", "sodium.jar.disabled", Some(UpdateHold::Ignored))
            .await
            .unwrap();
        let after = store.load().await.unwrap();
        assert_eq!(
            after.find("sodium.jar").unwrap().update_hold,
            Some(UpdateHold::Ignored)
        );
        assert_eq!(after.find("gone.jar").unwrap().update_hold, None);

        // 值相同不落盘：先把文件换成紧凑写法，真的改写过就会变回带缩进的格式。
        let compact = serde_json::to_vec(&after).unwrap();
        tokio::fs::write(store.path(), &compact).await.unwrap();
        aurora
            .set_mod_update_hold("1.21", "sodium.jar", Some(UpdateHold::Ignored))
            .await
            .unwrap();
        assert_eq!(tokio::fs::read(store.path()).await.unwrap(), compact);

        // 改成锁定、再恢复检查。
        let pin = UpdateHold::Pinned {
            version_id: "v9".to_owned(),
        };
        aurora
            .set_mod_update_hold("1.21", "sodium.jar", Some(pin.clone()))
            .await
            .unwrap();
        assert_eq!(
            store
                .load()
                .await
                .unwrap()
                .find("sodium.jar")
                .unwrap()
                .update_hold,
            Some(pin)
        );
        aurora
            .set_mod_update_hold("1.21", "sodium.jar", None)
            .await
            .unwrap();
        assert_eq!(
            store
                .load()
                .await
                .unwrap()
                .find("sodium.jar")
                .unwrap()
                .update_hold,
            None
        );

        let before = tokio::fs::read(store.path()).await.unwrap();
        // 卷宗里有、盘上没有：按已被移除拒绝。
        let err = aurora
            .set_mod_update_hold("1.21", "gone.jar", Some(UpdateHold::Ignored))
            .await
            .unwrap_err();
        let (path, reason) = refusal(&err);
        assert_eq!(path, mods_dir.join("gone.jar"));
        assert!(reason.contains("mods 目录里没有 gone.jar"), "{reason}");
        // 盘上有、卷宗没有：本地文件不参与更新检查。
        let err = aurora
            .set_mod_update_hold("1.21", "manual.jar", Some(UpdateHold::Ignored))
            .await
            .unwrap_err();
        assert!(
            refusal(&err)
                .1
                .contains("manual.jar 没有平台来源记录，不能设置更新检查"),
            "{err:?}"
        );
        let err = aurora
            .set_mod_update_hold("1.21", "a.jar.old", None)
            .await
            .unwrap_err();
        assert!(refusal(&err).1.contains("不是 mods 目录里的 Mod 文件名"));
        assert_eq!(tokio::fs::read(store.path()).await.unwrap(), before);
    }

    /// 列表里的来源带上装进实例的时刻与更新设置，没设置时序列化为 null。
    #[tokio::test]
    async fn listed_source_carries_installed_at_and_update_hold() {
        let tmp = tempfile::tempdir().unwrap();
        put_version(tmp.path(), "1.21").await;
        let aurora = isolated_aurora(tmp.path(), "http://127.0.0.1:9".to_owned());
        let mods_dir = aurora.resolve_mods_dir("1.21").await.unwrap();
        tokio::fs::create_dir_all(&mods_dir).await.unwrap();
        tokio::fs::write(mods_dir.join("a.jar"), b"a")
            .await
            .unwrap();
        tokio::fs::write(mods_dir.join("b.jar"), b"b")
            .await
            .unwrap();
        let mut ledger = Ledger::default();
        for (file_name, at, hold) in [
            ("a.jar", 1_700_000_001, None),
            ("b.jar", -3, Some(UpdateHold::Ignored)),
        ] {
            ledger.upsert(LedgerEntry {
                file_name: file_name.to_owned(),
                platform: Platform::Modrinth,
                project_id: format!("p-{file_name}"),
                version_id: "v1".to_owned(),
                version_number: None,
                title: None,
                icon_url: None,
                sha1: None,
                installed_at: at,
                installed_as_dependency_of: None,
                update_hold: hold,
            });
        }
        aurora.ledger_store("1.21").save(&ledger).await.unwrap();

        let mut listed = aurora.list_mods("1.21").await.unwrap();
        listed.sort_by(|x, y| x.installed.file_name.cmp(&y.installed.file_name));
        let a = serde_json::to_value(listed[0].source.as_ref().unwrap()).unwrap();
        assert_eq!(a["installed_at"], 1_700_000_001);
        assert_eq!(a["update_hold"], serde_json::Value::Null);
        let b = serde_json::to_value(listed[1].source.as_ref().unwrap()).unwrap();
        assert_eq!(b["installed_at"], -3);
        assert_eq!(b["update_hold"], serde_json::json!({ "kind": "ignored" }));
    }

    /// 同一实例上的并发变更不丢记录：每次移除都留下自己的历史事件，卷宗条目全部摘净。
    ///
    /// 卷宗与历史都是「读全量 - 改 - 整体写」，没有写锁时并发的几次会各自读到同一份旧数据再各自写回，
    /// 后写者覆盖先写者，事件条数随之少于移除次数。
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn concurrent_removals_on_one_instance_keep_every_record() {
        const COUNT: usize = 16;
        let tmp = tempfile::tempdir().unwrap();
        put_version(tmp.path(), "1.21").await;
        let aurora = isolated_aurora(tmp.path(), "http://127.0.0.1:9".to_owned());
        let mods_dir = aurora.resolve_mods_dir("1.21").await.unwrap();
        tokio::fs::create_dir_all(&mods_dir).await.unwrap();
        let mut ledger = Ledger::default();
        for i in 0..COUNT {
            let name = format!("mod-{i:02}.jar");
            tokio::fs::write(mods_dir.join(&name), b"x").await.unwrap();
            ledger.upsert(LedgerEntry {
                file_name: name,
                platform: Platform::Modrinth,
                project_id: format!("p{i}"),
                version_id: "v".to_owned(),
                version_number: None,
                title: None,
                icon_url: None,
                sha1: None,
                installed_at: 0,
                installed_as_dependency_of: None,
                update_hold: None,
            });
        }
        aurora.ledger_store("1.21").save(&ledger).await.unwrap();

        let mut set = tokio::task::JoinSet::new();
        for i in 0..COUNT {
            let aurora = aurora.clone();
            set.spawn(async move { aurora.remove_mod("1.21", &format!("mod-{i:02}.jar")).await });
        }
        while let Some(joined) = set.join_next().await {
            joined.unwrap().unwrap();
        }

        let history = aurora.history("1.21").await.unwrap();
        assert_eq!(history.events.len(), COUNT);
        let ids: HashSet<&str> = history.events.iter().map(HistoryEvent::id).collect();
        assert_eq!(ids.len(), COUNT, "事件 id 必须两两不同");
        assert!(
            aurora
                .ledger_store("1.21")
                .load()
                .await
                .unwrap()
                .entries
                .is_empty()
        );
        assert!(dir_names(&mods_dir).await.is_empty());
    }

    /// 游戏正在跑（jar 被以不许删除的方式打开）：移除与启停在动盘之前整体拒绝，并被识别为「占用」。
    #[cfg(windows)]
    #[tokio::test]
    async fn busy_mod_file_blocks_remove_and_toggle() {
        use std::os::windows::fs::OpenOptionsExt;

        let tmp = tempfile::tempdir().unwrap();
        put_version(tmp.path(), "1.21").await;
        let aurora = isolated_aurora(tmp.path(), "http://127.0.0.1:9".to_owned());
        let mods_dir = aurora.resolve_mods_dir("1.21").await.unwrap();
        tokio::fs::create_dir_all(&mods_dir).await.unwrap();
        tokio::fs::write(mods_dir.join("a.jar"), b"x")
            .await
            .unwrap();

        let held = std::fs::OpenOptions::new()
            .read(true)
            .share_mode(0x1 | 0x2)
            .open(mods_dir.join("a.jar"))
            .unwrap();
        let err = aurora.remove_mod("1.21", "a.jar").await.unwrap_err();
        assert!(crate::modfs::is_mod_file_busy(&err), "实得 {err:?}");
        assert!(refusal(&err).1.contains("正被其它程序占用"));
        let err = aurora
            .set_mod_enabled("1.21", "a.jar", false)
            .await
            .unwrap_err();
        assert!(crate::modfs::is_mod_file_busy(&err), "实得 {err:?}");
        assert_eq!(dir_names(&mods_dir).await, vec!["a.jar"]);
        assert!(aurora.history("1.21").await.unwrap().events.is_empty());

        drop(held);
        aurora.remove_mod("1.21", "a.jar").await.unwrap();
        assert!(dir_names(&mods_dir).await.is_empty());
    }

    /// 造一个只含 fabric.mod.json 的最小 jar。
    fn build_mod_jar(path: &Path, mod_id: &str) {
        use std::io::Write;
        let file = std::fs::File::create(path).unwrap();
        let mut zip = zip::ZipWriter::new(file);
        zip.start_file("fabric.mod.json", zip::write::SimpleFileOptions::default())
            .unwrap();
        write!(
            zip,
            r#"{{"schemaVersion":1,"id":"{mod_id}","version":"1.0.0"}}"#
        )
        .unwrap();
        zip.finish().unwrap();
    }

    /// 同一个 Mod 换平台再装一次：按 jar 里的 mod_id 认出旧拷贝，走更新路径而不是两份共存。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn same_mod_id_from_another_source_is_treated_as_replacement() {
        let server = MockServer::start().await;
        let tmp = tempfile::tempdir().unwrap();
        put_version(tmp.path(), "1.21").await;
        let aurora = isolated_aurora(tmp.path(), server.uri());
        let mods_dir = aurora.resolve_mods_dir("1.21").await.unwrap();
        tokio::fs::create_dir_all(&mods_dir).await.unwrap();
        // 手动丢进来的旧拷贝（卷宗里没有）。
        build_mod_jar(&mods_dir.join("sodium-manual.jar"), "sodium");

        let jar_path = tmp.path().join("new.jar");
        build_mod_jar(&jar_path, "sodium");
        let jar = std::fs::read(&jar_path).unwrap();
        mount_sodium(&server, "v2", "sodium-v2.jar", &jar).await;
        mount_projects(&server, &[]).await;

        aurora
            .install_mod("1.21", Platform::Modrinth, "sodium", "v2", None)
            .await
            .unwrap();
        assert_eq!(
            dir_names(&mods_dir).await,
            vec!["sodium-manual.jar.old", "sodium-v2.jar"]
        );
        match &aurora.history("1.21").await.unwrap().events[0] {
            HistoryEvent::Update {
                old_file,
                from_version,
                ..
            } => {
                assert_eq!(old_file, "sodium-manual.jar");
                assert_eq!(from_version, UNKNOWN_VERSION);
            }
            other => panic!("期望更新事件，得到 {other:?}"),
        }
    }

    /// 改名式更新时目标名上另有一个来路不明的文件：拒绝，不覆盖它。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn rename_update_refuses_to_clobber_an_unrelated_file_on_the_target_name() {
        let server = MockServer::start().await;
        mount_sodium(&server, "v1", "sodium-v1.jar", b"one").await;
        mount_sodium(&server, "v2", "sodium-v2.jar", b"two").await;
        mount_projects(&server, &[]).await;

        let tmp = tempfile::tempdir().unwrap();
        put_version(tmp.path(), "1.21").await;
        let aurora = isolated_aurora(tmp.path(), server.uri());
        aurora
            .install_mod("1.21", Platform::Modrinth, "sodium", "v1", None)
            .await
            .unwrap();
        let mods_dir = aurora.resolve_mods_dir("1.21").await.unwrap();
        tokio::fs::write(mods_dir.join("sodium-v2.jar"), b"player")
            .await
            .unwrap();

        let err = aurora
            .update_mod("1.21", "sodium-v1.jar", "v2", None)
            .await
            .unwrap_err();
        assert!(refusal(&err).1.contains("为避免覆盖已中止安装"));
        assert_eq!(
            tokio::fs::read(mods_dir.join("sodium-v2.jar"))
                .await
                .unwrap(),
            b"player"
        );
        assert_eq!(
            dir_names(&mods_dir).await,
            vec!["sodium-v1.jar", "sodium-v2.jar"]
        );
    }

    fn version_info(
        platform: &str,
        project: &str,
        file: &str,
        url: Option<&str>,
    ) -> ModVersionInfo {
        serde_json::from_value(serde_json::json!({
            "version_id": file, "project_id": project, "platform": platform, "name": "n",
            "version_number": "1", "release_channel": "release", "game_versions": ["1.21"],
            "loaders": [], "file_name": format!("{project}-{file}.jar"), "file_size": 3,
            "sha1": null, "download_url": url, "date_published": "", "dependencies": []
        }))
        .unwrap()
    }

    fn planned(version: ModVersionInfo) -> PlannedItem {
        PlannedItem {
            version,
            title: None,
            icon_url: None,
            required_by: None,
            already_satisfied: false,
            delisted: false,
        }
    }

    /// CurseForge 的暂存任务（直链与 download-url 兜底出来的）都挂 CurseForge 凭据，Modrinth 的不挂。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn curseforge_staged_tasks_carry_the_credential_and_modrinth_tasks_do_not() {
        let server = MockServer::start().await;
        let uri = server.uri();
        Mock::given(method("GET"))
            .and(path("/v1/mods/8/files/80/download-url"))
            .respond_with(
                ResponseTemplate::new(200)
                    .set_body_json(serde_json::json!({"data": format!("{uri}/cdn/fallback.jar")})),
            )
            .mount(&server)
            .await;
        let tmp = tempfile::tempdir().unwrap();
        let aurora = isolated_aurora(tmp.path(), uri.clone())
            .with_curseforge_base(&uri)
            .with_curseforge_key("k");
        let staging = tmp.path().join("staging");

        let modrinth = aurora
            .stage_item(
                planned(version_info(
                    "modrinth",
                    "sodium",
                    "v1",
                    Some("https://cdn.modrinth.com/a.jar"),
                )),
                &staging,
            )
            .await
            .unwrap();
        assert!(modrinth.task.credential.is_none());
        let direct = aurora
            .stage_item(
                planned(version_info(
                    "curseforge",
                    "7",
                    "70",
                    Some(&format!("{uri}/cdn/direct.jar")),
                )),
                &staging,
            )
            .await
            .unwrap();
        let fallback = aurora
            .stage_item(
                planned(version_info("curseforge", "8", "80", None)),
                &staging,
            )
            .await
            .unwrap();
        assert_eq!(fallback.task.url, format!("{uri}/cdn/fallback.jar"));
        for item in [direct, fallback] {
            let credential = item
                .task
                .credential
                .as_ref()
                .expect("CurseForge 任务应带凭据");
            assert_eq!(
                credential.realm(),
                aurora_download::CredentialRealm::CurseForge
            );
        }
    }

    /// 作者不允许第三方分发的 CurseForge Mod：报受限文件，落点是 mods/ 下的同名文件，网页链接按工程拼。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn blocked_curseforge_mod_is_reported_with_its_page_and_landing() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/v1/mods/9/files/90/download-url"))
            .respond_with(ResponseTemplate::new(404))
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path("/v1/mods/9"))
            .respond_with(
                ResponseTemplate::new(200).set_body_json(serde_json::json!({"data": {
                    "id": 9, "name": "Locked", "slug": "locked", "summary": "", "classId": 6
                }})),
            )
            .expect(1)
            .mount(&server)
            .await;
        let tmp = tempfile::tempdir().unwrap();
        let uri = server.uri();
        let aurora = isolated_aurora(tmp.path(), uri.clone())
            .with_curseforge_base(&uri)
            .with_curseforge_key("k");
        let mut version = version_info("curseforge", "9", "90", None);
        version.sha1 = Some("a".repeat(40));

        let err = aurora
            .stage_item(planned(version), &tmp.path().join("staging"))
            .await
            .err()
            .expect("受限 Mod 应报错");
        let CoreError::FileDistributionBlocked { files } = &err else {
            panic!("实际：{err:?}");
        };
        assert_eq!(
            files,
            &[BlockedFile {
                project_id: 9,
                file_id: 90,
                file_name: "9-90.jar".into(),
                web_url: "https://www.curseforge.com/minecraft/mc-mods/locked/files/90".into(),
                destination: "mods/9-90.jar".into(),
                sha1: Some("a".repeat(40)),
                fingerprint: 0,
                size: Some(3),
            }]
        );
        server.verify().await;
    }

    /// 挂好一个作者不允许第三方分发的 CurseForge 工程：download-url 拒绝，工程摘要给网页链接用。
    async fn mount_blocked_project(server: &MockServer, mod_id: u32, file_id: u32) {
        Mock::given(method("GET"))
            .and(path(format!(
                "/v1/mods/{mod_id}/files/{file_id}/download-url"
            )))
            .respond_with(ResponseTemplate::new(404))
            .mount(server)
            .await;
        Mock::given(method("GET"))
            .and(path(format!("/v1/mods/{mod_id}")))
            .respond_with(
                ResponseTemplate::new(200).set_body_json(serde_json::json!({"data": {
                    "id": mod_id, "name": "Locked", "slug": format!("locked-{mod_id}"), "summary": "", "classId": 6
                }})),
            )
            .mount(server)
            .await;
    }

    fn blocked_version(mod_id: u32, file_id: u32, bytes: &[u8]) -> ModVersionInfo {
        let mut version = version_info(
            "curseforge",
            &mod_id.to_string(),
            &file_id.to_string(),
            None,
        );
        version.sha1 = Some(sha1_hex(bytes));
        version.file_size = Some(bytes.len() as u64);
        version
    }

    fn blocked_file(mod_id: u32, file_id: u32, bytes: &[u8]) -> BlockedFile {
        let file_name = format!("{mod_id}-{file_id}.jar");
        BlockedFile {
            project_id: mod_id,
            file_id,
            web_url: format!(
                "https://www.curseforge.com/minecraft/mc-mods/locked-{mod_id}/files/{file_id}"
            ),
            destination: format!("mods/{file_name}"),
            file_name,
            sha1: Some(sha1_hex(bytes)),
            fingerprint: 0,
            size: Some(bytes.len() as u64),
        }
    }

    /// 把受限文件放进「下载文件夹」再认领，走和界面一样的入口进暂存位。
    async fn claim(aurora: &Aurora, tmp: &Path, file: &BlockedFile, bytes: &[u8]) {
        let downloads = tmp.join("Downloads");
        tokio::fs::create_dir_all(&downloads).await.unwrap();
        tokio::fs::write(downloads.join(&file.file_name), bytes)
            .await
            .unwrap();
        let report = aurora
            .claim_blocked_files(&downloads, std::slice::from_ref(file))
            .await
            .unwrap();
        assert!(report.missing.is_empty(), "{report:?}");
    }

    /// 受限 Mod 手动下载并认领之后再装一次：不再报受限，也不下载，暂存位的副本过一遍校验后落进 mods/，
    /// 暂存位留着副本，卷宗照常记下来源。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn blocked_mod_installs_from_the_claimed_copy() {
        let server = MockServer::start().await;
        mount_blocked_project(&server, 9, 90).await;
        let tmp = tempfile::tempdir().unwrap();
        let mc = tmp.path();
        put_version(mc, "1.21").await;
        let uri = server.uri();
        let aurora = isolated_aurora(mc, uri.clone())
            .with_curseforge_base(&uri)
            .with_curseforge_key("k");
        let bytes: &[u8] = b"claimed-jar";
        claim(&aurora, mc, &blocked_file(9, 90, bytes), bytes).await;

        let outcome = aurora
            .install_planned(
                "1.21",
                vec![planned(blocked_version(9, 90, bytes))],
                (Platform::CurseForge, "9", "90"),
                None,
            )
            .await
            .unwrap();

        assert_eq!(outcome.file_name, "9-90.jar");
        let mods_dir = aurora.resolve_mods_dir("1.21").await.unwrap();
        assert_eq!(dir_names(&mods_dir).await, vec!["9-90.jar"]);
        assert_eq!(tokio::fs::read(&outcome.path).await.unwrap(), bytes);
        let listed = aurora.list_mods("1.21").await.unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(
            listed[0].source.as_ref().map(|s| s.project_id.as_str()),
            Some("9")
        );
        assert!(
            aurora
                .blocked_claims_dir()
                .join("curseforge-90/9-90.jar")
                .is_file()
        );
    }

    /// 暂存位的副本被改坏了（校验不过）不算认领：照旧报受限，mods/ 里什么都不落。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn tampered_claimed_copy_is_not_installed() {
        let server = MockServer::start().await;
        mount_blocked_project(&server, 9, 90).await;
        let tmp = tempfile::tempdir().unwrap();
        let mc = tmp.path();
        put_version(mc, "1.21").await;
        let uri = server.uri();
        let aurora = isolated_aurora(mc, uri.clone())
            .with_curseforge_base(&uri)
            .with_curseforge_key("k");
        let bytes: &[u8] = b"claimed-jar";
        claim(&aurora, mc, &blocked_file(9, 90, bytes), bytes).await;
        tokio::fs::write(
            aurora.blocked_claims_dir().join("curseforge-90/9-90.jar"),
            b"tampered",
        )
        .await
        .unwrap();

        let err = aurora
            .install_planned(
                "1.21",
                vec![planned(blocked_version(9, 90, bytes))],
                (Platform::CurseForge, "9", "90"),
                None,
            )
            .await
            .unwrap_err();

        assert!(
            matches!(err, CoreError::FileDistributionBlocked { .. }),
            "{err:?}"
        );
        let mods_dir = aurora.resolve_mods_dir("1.21").await.unwrap();
        assert!(!mods_dir.join("9-90.jar").exists());
    }

    /// 计划里有好几个受限文件时一次报全，已认领的不在其中；有没认领的就一个文件都不落。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn every_unclaimed_file_of_a_plan_is_reported_at_once() {
        let server = MockServer::start().await;
        for (mod_id, file_id) in [(9, 90), (10, 100), (11, 110)] {
            mount_blocked_project(&server, mod_id, file_id).await;
        }
        let tmp = tempfile::tempdir().unwrap();
        let mc = tmp.path();
        put_version(mc, "1.21").await;
        let uri = server.uri();
        let aurora = isolated_aurora(mc, uri.clone())
            .with_curseforge_base(&uri)
            .with_curseforge_key("k");
        let bytes: &[u8] = b"claimed-jar";
        claim(&aurora, mc, &blocked_file(10, 100, bytes), bytes).await;

        let err = aurora
            .install_planned(
                "1.21",
                vec![
                    planned(blocked_version(9, 90, b"first")),
                    planned(blocked_version(10, 100, bytes)),
                    planned(blocked_version(11, 110, b"third")),
                ],
                (Platform::CurseForge, "9", "90"),
                None,
            )
            .await
            .unwrap_err();

        let CoreError::FileDistributionBlocked { files } = &err else {
            panic!("实际：{err:?}");
        };
        assert_eq!(
            files,
            &[
                blocked_file(9, 90, b"first"),
                blocked_file(11, 110, b"third")
            ]
        );
        let mods_dir = aurora.resolve_mods_dir("1.21").await.unwrap();
        assert!(!mods_dir.join("10-100.jar").exists());
    }

    /// 门面级：CDN 对带了密钥的请求回 401，install_mod 失败；错误链上认得出是 CurseForge 拒绝了密钥，
    /// 带着被拒那一跳的地址；CDN 只被请求 1 次（不重试、不换源），请求确实带了 x-api-key；mods 里什么都没落。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn curseforge_cdn_rejecting_the_key_fails_install_once() {
        use wiremock::matchers::header;

        let server = MockServer::start().await;
        let uri = server.uri();
        let cdn = format!("{uri}/files/3040/523/jei.jar");
        Mock::given(method("GET"))
            .and(path("/v1/mods/238222/files/3040523"))
            .respond_with(
                ResponseTemplate::new(200).set_body_json(serde_json::json!({"data": {
                    "id": 3040523, "modId": 238222, "displayName": "JEI", "fileName": "jei.jar",
                    "hashes": [{"value": sha1_hex(b"jar"), "algo": 1}], "fileLength": 3,
                    "downloadUrl": cdn, "gameVersions": ["1.21"]
                }})),
            )
            .mount(&server)
            .await;
        Mock::given(method("POST"))
            .and(path("/v1/mods"))
            .respond_with(
                ResponseTemplate::new(200).set_body_json(serde_json::json!({"data": [
                    {"id": 238222, "name": "JEI", "slug": "jei", "summary": "", "classId": 6}
                ]})),
            )
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path("/files/3040/523/jei.jar"))
            .and(header("x-api-key", "k"))
            .respond_with(ResponseTemplate::new(401))
            .expect(1)
            .mount(&server)
            .await;
        let tmp = tempfile::tempdir().unwrap();
        let mc = tmp.path();
        put_version(mc, "1.21").await;
        let port = server.address().port();
        let aurora = isolated_aurora(mc, uri.clone())
            .with_curseforge_base(&uri)
            .with_curseforge_key("k")
            .with_curseforge_cdn_scope(aurora_download::CredentialScope::new(
                [format!("127.0.0.1:{port}")],
                false,
            ));

        let err = aurora
            .install_mod("1.21", Platform::CurseForge, "238222", "3040523", None)
            .await
            .unwrap_err();
        let CoreError::Download(download) = &err else {
            panic!("实际：{err:?}");
        };
        assert_eq!(
            download.credential_rejection(),
            Some(aurora_download::CredentialRealm::CurseForge)
        );
        assert!(
            matches!(download, aurora_download::Error::CredentialRejected { url, status: 401, .. } if url == &cdn),
            "{download:?}"
        );
        server.verify().await;
        let cdn_hits = server
            .received_requests()
            .await
            .unwrap()
            .iter()
            .filter(|r| r.url.path() == "/files/3040/523/jei.jar")
            .count();
        assert_eq!(cdn_hits, 1);
        let mods_dir = aurora.resolve_mods_dir("1.21").await.unwrap();
        assert!(!mods_dir.join("jei.jar").exists());
    }
}
