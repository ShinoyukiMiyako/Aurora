//! 按实例名新建实例，以及补全一个文件不全的实例。
//!
//! 新建分两步，中间由调用方登记任务：
//! 1. [`Petalfall::create_instance_dir`]：校验名称、原子地建出 `versions/<名>/`（并发重名在这一步暴露），
//!    写下未完成标记；
//! 2. [`Petalfall::install_instance`]：原版 JSON 与加载器 JSON 合并成一份以实例名为 id 的自洽 JSON，
//!    客户端 jar 与 natives 落在实例目录里，库与资源进共享目录。
//!
//! 结局由调用方记下：成功、失败经 [`Petalfall::settle_instance_marker`]（成功删标记，失败记下错误码与原文，
//! 界面据此显示「安装没有完成」），取消则经 [`Petalfall::abandon_instance`] 把整个目录丢掉。
//!
//! 补全先经 [`Petalfall::begin_repair`] 看标记定方案：标记里记着当初的安装内容（安装没完成）就照着重装，
//! 否则按现有版本 JSON 补齐缺失的文件；版本 JSON 被删或写坏时照装好时留下的安装记录重装。加载器自带的库
//! 补不回来，要经 [`Petalfall::begin_loader_reinstall`] 把版本 JSON 里读出的加载器原样重装一遍，走的是同一条
//! 安装链路。

use std::collections::HashMap;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use petalfall_install::{
    ForgeInstaller, LoaderFlavor, LoaderInstaller, VanillaInstaller, ensure_complete,
    forge_installer_url, merge_for_instance, neoforge_installer_url, write_instance_json,
};
use petalfall_instance::{
    DiscoveredVersion, IncompleteKind, IncompleteMarker, IncompleteOutcome, InstallRecordStore,
    InstallSpec, MarkerError, MarkerStore, NameViolation, PETALFALL_META_DIR, VersionProbe,
    discover_versions, probe_version,
};
use petalfall_version::{LoaderInfo, LoaderKind, VersionJson, identify_mc_version, resolve};

use crate::InstanceError;
use crate::data_format::{GameDirCheck, GuardMode};
use crate::error::{CoreError, Result};
use crate::event::{CoreEvent, EventSink, InstallPhase, emit};
use crate::facade::{Petalfall, make_context};
use crate::install::LoaderChoice;
use crate::instances::{LEGACY_JAVA_MAJOR, broken_reason_text, inheritance_root};
use crate::launch::FailureCode;
use crate::template::TemplateOutcome;

/// 安装过程中原版 JSON 的暂存位置（实例元数据目录里）。合并后的 JSON 写好即删除。
const STAGED_VANILLA_JSON: &str = "vanilla.json";

/// 新实例要装的东西。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InstanceRequest {
    /// 原版版本号（版本清单里的 id）。
    pub mc_version: String,
    pub loader: Option<LoaderChoice>,
    /// 加载器版本；Fabric / Quilt 缺省取推荐版，Forge / NeoForge 必须给出。
    pub loader_version: Option<String>,
    /// 装好后把默认设置补进实例。
    pub use_template: bool,
}

impl InstanceRequest {
    /// 写进未完成标记的形式。
    pub fn spec(&self) -> InstallSpec {
        InstallSpec {
            mc_version: self.mc_version.clone(),
            loader: self.loader.map(|choice| choice.key().to_owned()),
            loader_version: self.loader_version.clone(),
            use_template: self.use_template,
        }
    }

    /// 从未完成标记里的安装内容还原；标记里的加载器键不认识时报不可补全。
    pub fn from_spec(id: &str, spec: &InstallSpec) -> Result<Self> {
        let loader =
            match spec.loader.as_deref() {
                None => None,
                Some(key) => Some(LoaderChoice::from_key(key).ok_or_else(|| {
                    InstanceError::NotRepairable {
                        id: id.to_owned(),
                        reason: format!("未完成标记里记的加载器 {key} 不认识"),
                    }
                })?),
            };
        Ok(Self {
            mc_version: spec.mc_version.clone(),
            loader,
            loader_version: spec.loader_version.clone(),
            use_template: spec.use_template,
        })
    }

    /// 不碰网络就能判断的问题：Forge / NeoForge 没有「推荐版」可查，版本号必须给出；版本号来自远端版本
    /// 列表，会原样拼进安装器地址、缓存文件名与版本 id，必须是单个安全的路径段。
    pub fn validate(&self) -> Result<()> {
        if let Some(choice @ (LoaderChoice::Forge | LoaderChoice::NeoForge)) = self.loader
            && self.loader_version.is_none()
        {
            return Err(petalfall_install::Error::LoaderVersionNotFound {
                loader: choice.display_name(),
                game_version: self.mc_version.clone(),
            }
            .into());
        }
        if let (Some(choice), Some(version)) = (self.loader, &self.loader_version) {
            petalfall_version::check_path_segment(version).map_err(|problem| {
                petalfall_install::Error::UnsafePath {
                    entry: format!("{} 版本号", choice.display_name()),
                    path: version.clone(),
                    problem,
                }
            })?;
        }
        Ok(())
    }
}

/// 实例里装上的加载器。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InstalledLoader {
    pub choice: LoaderChoice,
    pub version: String,
}

/// 一次实例安装的结果。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InstanceInstallOutcome {
    pub id: String,
    pub mc_version: String,
    pub loader: Option<InstalledLoader>,
    /// 确保就绪的库文件数。
    pub libraries: usize,
    /// 确保就绪的资源对象数。
    pub assets: usize,
    /// natives 文件数。
    pub natives: u32,
    /// 套默认设置的结果；没请求套用时为 `None`。
    pub template: Option<TemplateOutcome>,
}

/// 补全的方案。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RepairPlan {
    /// 重装：当初的安装没有完成时照记下的内容，版本 JSON 丢失或写坏时照安装记录，重新安装加载器时照版本
    /// JSON 读出的内容。
    Reinstall(InstanceRequest),
    /// 按现有版本 JSON 补齐文件。
    Complete,
}

/// 一次补全的结果。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RepairOutcome {
    /// 是否走了重装。
    pub reinstalled: bool,
    pub libraries: usize,
    pub assets: usize,
    pub natives: u32,
}

/// 长任务的结局，写进未完成标记。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MarkerSettlement {
    /// 成功：删掉标记。
    Succeeded,
    /// 失败：记下错误码与原文。
    Failed(MarkerError),
    /// 取消。
    Cancelled,
}

impl Petalfall {
    /// 校验名称，原子地建出实例目录并写下未完成标记，返回写下的标记（结局时原样交回
    /// [`Petalfall::settle_instance_marker`]）。目录已经存在（含并发新建的同名实例）报重名。
    ///
    /// 建任何东西之前先以「使用」方式核对当前游戏目录的数据格式记号：目录被更新的落樱用过、记号读不懂时报错，
    /// 什么都不建。
    pub async fn create_instance_dir(
        &self,
        name: &str,
        request: &InstanceRequest,
    ) -> Result<IncompleteMarker> {
        request.validate()?;
        let checked = self.guard_game_dir(GuardMode::Use).await?;
        self.check_new_instance_name(name).await?;
        let dir = self.instance_dir(name)?;
        let versions = self.layout().versions_dir();
        tokio::fs::create_dir_all(&versions)
            .await
            .map_err(|source| petalfall_base::Error::Io {
                path: versions,
                source,
            })?;
        // 游戏目录是上一步才建出来的：开头核对时它还不在，记号没处写，现在补上。放在建实例目录之前，记号写不进去
        // 时还没有任何实例数据落下。
        if checked == GameDirCheck::Absent {
            self.guard_game_dir(GuardMode::Use).await?;
        }
        match tokio::fs::create_dir(&dir).await {
            Ok(()) => {}
            Err(err) if err.kind() == std::io::ErrorKind::AlreadyExists => {
                return Err(InstanceError::InvalidName {
                    name: name.to_owned(),
                    violation: NameViolation::Duplicate,
                }
                .into());
            }
            Err(source) => return Err(petalfall_base::Error::Io { path: dir, source }.into()),
        }
        // 名字下还留着的记录属于在启动器之外被删掉的同名旧实例，不清掉的话新实例一建出来就带着它的时长。
        // 放在目录建成之后：撞名时那份记录是现有实例的。清不掉不拦新建，改动已记下待补，在这个实例的
        // 第一局记下之前一定先补上。
        if let Err(err) = self.forget_play_records(name).await {
            tracing::warn!(name, error = %err, "清掉同名旧实例的游玩记录失败，已记下待补");
        }
        let marker = IncompleteMarker::pending(
            IncompleteKind::Install {
                spec: request.spec(),
            },
            now_millis(),
        );
        MarkerStore::for_version_dir(&dir).save(&marker).await?;
        tracing::info!(name, mc = %request.mc_version, loader = ?request.loader, "新建实例：目录已建好");
        Ok(marker)
    }

    /// 在已建好的实例目录 `versions/<id>/` 里安装 `request` 描述的版本。
    ///
    /// 动手之前先以「使用」方式核对当前游戏目录的数据格式记号：目录被更新的落樱用过、记号读不懂时报错，不下载、
    /// 不写任何文件。
    pub async fn install_instance(
        &self,
        id: &str,
        request: &InstanceRequest,
        events: Option<&EventSink>,
    ) -> Result<InstanceInstallOutcome> {
        request.validate()?;
        // 不看是不是「目录不在」：实例目录在，游戏目录就在；不在时下一步就报实例不存在。新建出来的游戏目录由
        // create_instance_dir 补记号。
        self.guard_game_dir(GuardMode::Use).await?;
        let dir = self.existing_instance_dir(id).await?;
        let announcer = PhaseAnnouncer::new(events, install_plan(request));
        let report_phase = |phase| announcer.enter(phase);
        announcer.enter(InstallPhase::Metadata);
        self.prepare_sources().await?;
        let layout = self.layout();
        let pool = self.download_pool_reporting(events);
        let policy = self.retry_policy();
        let http = self.http();
        let cx = make_context(
            &http,
            &pool,
            &layout,
            self.runtime(),
            &policy,
            self.cancel_token(),
        )
        .with_phases(Some(&report_phase));
        let mc = request.mc_version.as_str();

        emit(events, CoreEvent::stage(format!("查找原版 {mc}")));
        let vanilla_installer = VanillaInstaller::new(cx)
            .with_manifest_url(self.manifest_url())
            .with_sources(self.source_plan(self.config().version_list_source));
        let entry = vanilla_installer.find_entry(mc).await?;
        let staged = dir.join(PETALFALL_META_DIR).join(STAGED_VANILLA_JSON);
        let vanilla = vanilla_installer
            .download_version_json(&entry, &staged)
            .await?;

        let (merged, loader) = match request.loader {
            None => (merge_for_instance(id, &vanilla, None)?, None),
            Some(choice @ (LoaderChoice::Fabric | LoaderChoice::Quilt)) => {
                let (flavor, base) = match choice {
                    LoaderChoice::Fabric => (LoaderFlavor::Fabric, self.fabric_base()),
                    _ => (LoaderFlavor::Quilt, self.quilt_base()),
                };
                announcer.enter(InstallPhase::LoaderProfile);
                emit(
                    events,
                    CoreEvent::stage(format!("获取 {} 加载器信息", choice.display_name())),
                );
                let (_, profile, version) = LoaderInstaller::with_flavor(cx, flavor)
                    .with_base_url(base)
                    .with_sources(self.source_plan(self.config().version_list_source))
                    .fetch_profile(mc, request.loader_version.as_deref())
                    .await?;
                (
                    merge_for_instance(id, &vanilla, Some(&profile))?,
                    Some(InstalledLoader { choice, version }),
                )
            }
            Some(choice) => {
                let version = request
                    .loader_version
                    .clone()
                    .expect("validate 已保证 Forge / NeoForge 带版本号");
                // 处理器要读实例目录里的客户端 jar 与原版库，先把原版补齐。
                emit(events, CoreEvent::stage(format!("补全原版 {mc} 的文件")));
                ensure_complete(cx, &merge_for_instance(id, &vanilla, None)?, id).await?;
                let major = vanilla
                    .java_version
                    .as_ref()
                    .map_or(LEGACY_JAVA_MAJOR, |java| java.major_version);
                announcer.enter(InstallPhase::Java);
                let (_, java) = self.resolve_java(major, events).await?;
                let url = match choice {
                    LoaderChoice::Forge => forge_installer_url(mc, &version),
                    _ => neoforge_installer_url(&version),
                };
                emit(
                    events,
                    CoreEvent::stage(format!(
                        "下载并执行 {} 安装器：{url}",
                        choice.display_name()
                    )),
                );
                // 处理器不看下载池的令牌，取消看的是上下文上挂的那个（make_context 已挂上）：
                // 取消时正在跑的处理器要被结束，不能等宽限期满被丢下。
                let (embedded, summary) = ForgeInstaller::new(cx, java)
                    .with_sources(self.source_plan(self.config().download_source))
                    .install_for_instance(&url, id)
                    .await?;
                emit(
                    events,
                    CoreEvent::stage(format!(
                        "{} 安装器执行完成：库 {} / 处理器 {}",
                        choice.display_name(),
                        summary.libraries,
                        summary.processors
                    )),
                );
                (
                    merge_for_instance(id, &vanilla, Some(&embedded))?,
                    Some(InstalledLoader { choice, version }),
                )
            }
        };

        write_instance_json(&layout, &merged).await?;
        // 记实际装上的版本：Fabric / Quilt 没指定版本时装的是当时的推荐版，日后修复时推荐版可能已经变了。
        // 默认设置不记：重装时实例里已经有玩家自己的设置。
        InstallRecordStore::for_version_dir(&dir)
            .save(&InstallSpec {
                mc_version: request.mc_version.clone(),
                loader: request.loader.map(|choice| choice.key().to_owned()),
                loader_version: loader.as_ref().map(|l| l.version.clone()),
                use_template: false,
            })
            .await?;
        emit(events, CoreEvent::stage("补全库、资源与 natives"));
        // Forge / NeoForge 的原版文件与加载器的库在这之前都已下好，这一遍照合并后的版本 JSON 再核一遍：整遍合成
        // 「校验」一步报，库、资源与 natives 这几步前面已经报过，不再报。
        let report = if matches!(
            request.loader,
            Some(LoaderChoice::Forge | LoaderChoice::NeoForge)
        ) {
            announcer.enter(InstallPhase::Verify);
            ensure_complete(cx.with_phases(None), &merged, id).await?
        } else {
            ensure_complete(cx, &merged, id).await?
        };
        tokio::fs::remove_file(&staged)
            .await
            .map_err(|source| petalfall_base::Error::Io {
                path: staged.clone(),
                source,
            })?;
        // 放在版本 JSON 写好之后：要不要套看实例隔离不隔离，而隔离取决于版本类型（正式版还是快照），
        // 建目录那一刻还读不到。仍然在第一次启动之前，游戏还没来得及写出自己的默认设置。套失败让安装
        // 失败：重试经补全重装时会再套一次，标记里记着这次请求了套用。
        let template = if request.use_template {
            announcer.enter(InstallPhase::Template);
            let outcome = self.apply_template(id).await?;
            emit(events, CoreEvent::stage(template_stage(&outcome)));
            Some(outcome)
        } else {
            None
        };
        emit(
            events,
            CoreEvent::stage(format!(
                "实例 {id} 安装完成：库 {} / 资源 {} / natives {}",
                report.libraries, report.assets, report.natives
            )),
        );
        Ok(InstanceInstallOutcome {
            id: id.to_owned(),
            mc_version: request.mc_version.clone(),
            loader,
            libraries: report.libraries,
            assets: report.assets,
            natives: report.natives,
            template,
        })
    }

    /// 丢掉一个新建到一半的实例目录（新建被取消时）。目录已经不在不算错。
    ///
    /// 动手之前先以「使用」方式核对当前游戏目录的数据格式记号：目录被更新的落樱用过、记号读不懂时报错，什么都不删。
    pub async fn abandon_instance(&self, id: &str) -> Result<()> {
        self.guard_game_dir(GuardMode::Use).await?;
        let dir = self.instance_dir(id)?;
        match tokio::fs::remove_dir_all(&dir).await {
            Ok(()) => {
                tracing::info!(id, "新建被取消，实例目录已删除");
                Ok(())
            }
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(source) => Err(petalfall_base::Error::Io { path: dir, source }.into()),
        }
    }

    /// 把长任务的结局写进未完成标记。`marker` 是开始时写下的那份。
    ///
    /// 动手之前先以「使用」方式核对当前游戏目录的数据格式记号：目录被更新的落樱用过、记号读不懂时报错，标记不动。
    pub async fn settle_instance_marker(
        &self,
        id: &str,
        marker: IncompleteMarker,
        settlement: MarkerSettlement,
    ) -> Result<()> {
        self.guard_game_dir(GuardMode::Use).await?;
        let store = MarkerStore::for_version_dir(&self.instance_dir(id)?);
        let settled = match settlement {
            MarkerSettlement::Succeeded => return Ok(store.clear().await?),
            MarkerSettlement::Failed(error) => IncompleteMarker {
                outcome: IncompleteOutcome::Failed,
                error: Some(error),
                ..marker
            },
            MarkerSettlement::Cancelled => IncompleteMarker {
                outcome: IncompleteOutcome::Cancelled,
                error: None,
                ..marker
            },
        };
        store.save(&settled).await?;
        Ok(())
    }

    /// 定补全方案并写下新的未完成标记，返回方案与标记。
    ///
    /// 标记文件损坏时当作没有标记：版本 JSON 可用就照它补全，不可用时照安装记录重装，连记录也没有才报不可补全。
    ///
    /// 动手之前先以「使用」方式核对当前游戏目录的数据格式记号：目录被更新的落樱用过、记号读不懂时报错，标记不动。
    /// 任务中心重试补全不经列实例，不能指望调用方已经核对过。
    pub async fn begin_repair(&self, id: &str) -> Result<(RepairPlan, IncompleteMarker)> {
        self.guard_game_dir(GuardMode::Use).await?;
        self.plan_repair(id, false).await
    }

    /// 定「重新安装加载器」的方案并写下未完成标记：游戏版本、加载器与它的版本号照现有版本 JSON 原样装回，
    /// 不请求套默认设置，实例里的 Mod、配置与存档都不碰。标记记成安装：中途失败或取消后，普通补全照着这份
    /// 内容接着重装。
    ///
    /// 标记里记着安装内容的照它重装，整合包没导入完的报不可补全，版本 JSON 丢失或写坏时照安装记录重装，都与
    /// [`Petalfall::begin_repair`] 一样；定不出能原样装回的内容时报不可补全，标记不动。核对数据格式记号也同它。
    pub async fn begin_loader_reinstall(&self, id: &str) -> Result<(RepairPlan, IncompleteMarker)> {
        self.guard_game_dir(GuardMode::Use).await?;
        self.plan_repair(id, true).await
    }

    async fn plan_repair(
        &self,
        id: &str,
        reinstall_loader: bool,
    ) -> Result<(RepairPlan, IncompleteMarker)> {
        let dir = self.existing_instance_dir(id).await?;
        let store = MarkerStore::for_version_dir(&dir);
        let previous = match store.load().await {
            Ok(previous) => previous,
            Err(err) => {
                tracing::warn!(id, error = %err, "未完成标记损坏，按现有版本 JSON 补全并覆盖标记");
                None
            }
        };
        // 上次补全已经查实加载器自带的库只能重装补回：再照版本 JSON 补一遍只会原样失败，实例库、启动胶囊
        // 与任务重试的入口都带不上「重装」这个意思，所以由看标记定方案的这一步替它们换掉。装不回的照旧补全：
        // 玩家可能已经把文件放回去了，这是清掉标记的唯一办法；没放回去时照样报缺失。
        let stuck = previous.as_ref().is_some_and(lost_loader_library);
        let plan = match previous.map(|marker| marker.kind) {
            Some(IncompleteKind::Install { spec }) => {
                RepairPlan::Reinstall(InstanceRequest::from_spec(id, &spec)?)
            }
            // 导入写版本 JSON 在前、下载 Mod 与解出覆盖文件在后，中断时版本 JSON 往往已经可用；
            // 照它补全只会补齐库文件，再把标记清掉，缺的 Mod 与配置却补不回来，实例就被当成了完好的。
            Some(IncompleteKind::Modpack { .. }) => {
                return Err(InstanceError::NotRepairable {
                    id: id.to_owned(),
                    reason: "整合包没有导入完，缺的 Mod 与配置补不回来，删掉这个实例后重新导入"
                        .to_owned(),
                }
                .into());
            }
            Some(IncompleteKind::Repair) | None => {
                match probe_version(self.game_dir(), id).await? {
                    VersionProbe::Found(version)
                        if reinstall_loader
                            || (stuck && reinstallable_loader(&version.loaders).is_ok()) =>
                    {
                        RepairPlan::Reinstall(self.loader_reinstall_request(&version).await?)
                    }
                    VersionProbe::Found(_) => RepairPlan::Complete,
                    VersionProbe::Broken(broken) => {
                        let record = match InstallRecordStore::for_version_dir(&dir).load().await {
                            Ok(record) => record,
                            Err(err) => {
                                tracing::warn!(id, error = %err, "安装记录损坏，当作没有记录");
                                None
                            }
                        };
                        let Some(spec) = record else {
                            return Err(InstanceError::NotRepairable {
                                id: id.to_owned(),
                                reason: format!(
                                    "{}，也没有记下当初装的是什么",
                                    broken_reason_text(&broken.reason)
                                ),
                            }
                            .into());
                        };
                        RepairPlan::Reinstall(InstanceRequest::from_spec(id, &spec)?)
                    }
                }
            }
        };
        let kind = match &plan {
            RepairPlan::Reinstall(request) => IncompleteKind::Install {
                spec: request.spec(),
            },
            RepairPlan::Complete => IncompleteKind::Repair,
        };
        let marker = IncompleteMarker::pending(kind, now_millis());
        store.save(&marker).await?;
        tracing::info!(id, plan = ?plan, "开始补全实例");
        Ok((plan, marker))
    }

    /// 从现有版本 JSON 还原「把加载器原样装回」要的内容。在写标记之前调：定不出来的实例不留下一份照猜测写的
    /// 安装标记，版本号不安全的也在这里拒掉。
    async fn loader_reinstall_request(
        &self,
        version: &DiscoveredVersion,
    ) -> Result<InstanceRequest> {
        let id = version.id.as_str();
        let refuse = |reason: String| -> CoreError {
            InstanceError::NotRepairable {
                id: id.to_owned(),
                reason,
            }
            .into()
        };
        let (loader, loader_version) = reinstallable_loader(&version.loaders).map_err(refuse)?;
        // 看继承链根而不是 inheritsFrom：加载器版本可能叠在另一个加载器版本上，改过名的原版基底 id 是玩家起的
        // 名字，版本号只在 clientVersion 里。基底已经不在时只剩 inheritsFrom 写的那个 id 可用。
        let scan = discover_versions(self.game_dir()).await?;
        let root = inheritance_root(&scan, id);
        let base = scan
            .versions
            .iter()
            .find(|v| v.id == root)
            .map_or(&version.json, |v| &v.json);
        let mc = identify_mc_version(base);
        let mc_version = mc
            .value
            .filter(|_| mc.reliable)
            .ok_or_else(|| refuse("读不出游戏版本号，无法原样装回".to_owned()))?;
        let request = InstanceRequest {
            mc_version,
            loader: Some(loader),
            loader_version: Some(loader_version),
            use_template: false,
        };
        request.validate()?;
        Ok(request)
    }

    /// 按方案补全实例。
    ///
    /// 动手之前先以「使用」方式核对当前游戏目录的数据格式记号：目录被更新的落樱用过、记号读不懂时报错，不下载、
    /// 不写任何文件。重装方案经 [`Petalfall::install_instance`]，那里照样再核对一次。
    pub async fn repair_instance(
        &self,
        id: &str,
        plan: &RepairPlan,
        events: Option<&EventSink>,
    ) -> Result<RepairOutcome> {
        self.guard_game_dir(GuardMode::Use).await?;
        match plan {
            RepairPlan::Reinstall(request) => {
                let outcome = self.install_instance(id, request, events).await?;
                Ok(RepairOutcome {
                    reinstalled: true,
                    libraries: outcome.libraries,
                    assets: outcome.assets,
                    natives: outcome.natives,
                })
            }
            RepairPlan::Complete => {
                let scan = discover_versions(self.game_dir()).await?;
                let target = scan
                    .versions
                    .iter()
                    .find(|v| v.id == id)
                    .ok_or_else(|| CoreError::VersionNotInstalled { id: id.to_owned() })?;
                let provider: HashMap<String, VersionJson> = scan
                    .versions
                    .iter()
                    .map(|v| (v.id.clone(), v.json.clone()))
                    .collect();
                let merged = resolve(&target.json, &provider)?;
                // 传统布局的加载器版本，客户端 jar 与 natives 在继承链根（原版）的目录里。
                let root = inheritance_root(&scan, id);
                self.prepare_sources().await?;
                let layout = self.layout();
                let pool = self.download_pool_reporting(events);
                let policy = self.retry_policy();
                let http = self.http();
                let announcer = PhaseAnnouncer::new(
                    events,
                    vec![
                        InstallPhase::Libraries,
                        InstallPhase::Assets,
                        InstallPhase::Natives,
                    ],
                );
                let report_phase = |phase| announcer.enter(phase);
                let cx = make_context(
                    &http,
                    &pool,
                    &layout,
                    self.runtime(),
                    &policy,
                    self.cancel_token(),
                )
                .with_phases(Some(&report_phase));
                emit(events, CoreEvent::stage(format!("补全实例 {id} 的文件")));
                let report = ensure_complete(cx, &merged, &root).await?;
                emit(
                    events,
                    CoreEvent::stage(format!(
                        "实例 {id} 补全完成：库 {} / 资源 {} / natives {}",
                        report.libraries, report.assets, report.natives
                    )),
                );
                Ok(RepairOutcome {
                    reinstalled: false,
                    libraries: report.libraries,
                    assets: report.assets,
                    natives: report.natives,
                })
            }
        }
    }
}

/// 这份标记记着上次败在加载器自带的库上（码与命令报给前端的启动失败码同一个）。
fn lost_loader_library(marker: &IncompleteMarker) -> bool {
    marker
        .error
        .as_ref()
        .is_some_and(|error| error.code == FailureCode::LoaderLibraryMissing.as_str())
}

/// 能原样装回的加载器与它的版本号；装不回时给出写进不可补全原因的说明。
///
/// OptiFine、LiteLoader 是外部安装器写进版本 JSON 的，这里装不了，叠在别的加载器上时重装也会把它们丢掉。
/// 读不出版本号的同样不装：Fabric / Quilt 缺版本号时安装器会改装推荐版，版本号就变了。
fn reinstallable_loader(
    loaders: &[LoaderInfo],
) -> std::result::Result<(LoaderChoice, String), String> {
    if let Some(external) = loaders
        .iter()
        .find(|l| matches!(l.kind, LoaderKind::OptiFine | LoaderKind::LiteLoader))
    {
        return Err(format!(
            "装着 {}，重新安装只能装回 Fabric、Quilt、Forge 或 NeoForge，它会丢失",
            external.kind.as_str()
        ));
    }
    // NeoForge 排在 Forge 前面，与界面取主加载器同序：1.20.1 的 NeoForge 探测时也会命中 Forge。
    let primary = [
        (LoaderKind::NeoForge, LoaderChoice::NeoForge),
        (LoaderKind::Forge, LoaderChoice::Forge),
        (LoaderKind::Fabric, LoaderChoice::Fabric),
        (LoaderKind::Quilt, LoaderChoice::Quilt),
    ]
    .into_iter()
    .find_map(|(kind, choice)| {
        let found = loaders.iter().find(|l| l.kind == kind)?;
        Some((choice, found.version.clone()))
    });
    match primary {
        None => Err("没有装加载器，不需要重新安装".to_owned()),
        Some((choice, None)) => Err(format!(
            "读不出 {} 的版本号，无法原样装回",
            choice.display_name()
        )),
        Some((choice, Some(version))) => Ok((choice, version)),
    }
}

/// 新建要走的各步。Forge / NeoForge 的处理器要读实例目录里的客户端 jar，先把原版补齐；加载器装好后照合并后的
/// 版本 JSON 再补一遍，这一遍合成「校验」一步报。
fn install_plan(request: &InstanceRequest) -> Vec<InstallPhase> {
    use InstallPhase::*;
    let mut plan = vec![Metadata];
    match request.loader {
        None => plan.extend([Libraries, Assets, Natives]),
        Some(LoaderChoice::Fabric | LoaderChoice::Quilt) => {
            plan.extend([LoaderProfile, Libraries, Assets, Natives]);
        }
        Some(LoaderChoice::Forge | LoaderChoice::NeoForge) => plan.extend([
            Libraries,
            Assets,
            Natives,
            Java,
            LoaderInstaller,
            LoaderLibraries,
            LoaderProcessors,
            Verify,
        ]),
    }
    if request.use_template {
        plan.push(Template);
    }
    plan
}

/// 按开工时排定的步骤表报步骤。报来的步骤不在表里、比上一步靠前或报了两遍，说明表排错了：前端拿到这样的
/// 下标只会算出倒退的进度，直接崩。
struct PhaseAnnouncer<'a> {
    events: Option<&'a EventSink>,
    plan: Vec<InstallPhase>,
    /// 下一步最小的合法下标。
    next: AtomicUsize,
}

impl<'a> PhaseAnnouncer<'a> {
    fn new(events: Option<&'a EventSink>, plan: Vec<InstallPhase>) -> Self {
        Self {
            events,
            plan,
            next: AtomicUsize::new(0),
        }
    }

    fn enter(&self, phase: InstallPhase) {
        let index = self
            .plan
            .iter()
            .position(|p| *p == phase)
            .unwrap_or_else(|| panic!("步骤 {phase:?} 不在这次的步骤表 {:?} 里", self.plan));
        let floor = self.next.swap(index + 1, Ordering::Relaxed);
        assert!(
            index >= floor,
            "步骤 {phase:?} 报在了它后面的步骤之后，或报了两遍：{:?}",
            self.plan
        );
        emit(
            self.events,
            CoreEvent::Phase {
                plan: self.plan.clone(),
                index,
            },
        );
    }
}

/// 套默认设置这一步的进度文案。
pub(crate) fn template_stage(outcome: &TemplateOutcome) -> String {
    match outcome {
        TemplateOutcome::Applied { copied, kept } if copied.is_empty() => {
            format!("沿用默认设置：已有的 {} 保留不动", kept.join("、"))
        }
        TemplateOutcome::Applied { copied, kept } => {
            let mut text = format!("沿用默认设置：补上 {}", copied.join("、"));
            if !kept.is_empty() {
                text.push_str(&format!("（已有的 {} 保留不动）", kept.join("、")));
            }
            text
        }
        TemplateOutcome::Skipped(reason) => format!("没有沿用默认设置：{}", reason.describe()),
    }
}

/// 当前 Unix 毫秒。系统时钟早于 1970 年时报错而不是记一个 0：标记的开始时间要拿来展示。
pub(crate) fn now_millis() -> u64 {
    let elapsed = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("系统时钟早于 1970-01-01");
    u64::try_from(elapsed.as_millis()).expect("毫秒数超出 u64")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::instances::tests::{petalfall_at, vanilla_json, write_version};

    fn marker_path(instance_dir: &std::path::Path) -> std::path::PathBuf {
        MarkerStore::for_version_dir(instance_dir)
            .path()
            .to_path_buf()
    }
    use wiremock::matchers::{method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    fn request(mc: &str, loader: Option<LoaderChoice>, version: Option<&str>) -> InstanceRequest {
        InstanceRequest {
            mc_version: mc.to_owned(),
            loader,
            loader_version: version.map(str::to_owned),
            use_template: false,
        }
    }

    /// 清单里一个空壳原版（无下载、无资源）与 Fabric meta。
    async fn mock_meta(server: &MockServer) {
        let base = server.uri();
        Mock::given(method("GET"))
            .and(path("/manifest.json"))
            .respond_with(ResponseTemplate::new(200).set_body_string(format!(
                r#"{{"latest":{{"release":"1.21.1","snapshot":"1.21.1"}},
                    "versions":[{{"id":"1.21.1","type":"release","url":"{base}/1.21.1.json",
                    "time":"t","releaseTime":"t"}}]}}"#
            )))
            .mount(server)
            .await;
        Mock::given(method("GET"))
            .and(path("/1.21.1.json"))
            .respond_with(ResponseTemplate::new(200).set_body_string(vanilla_json("1.21.1")))
            .mount(server)
            .await;
        Mock::given(method("GET"))
            .and(path("/v2/versions/loader/1.21.1/0.16.10/profile/json"))
            .respond_with(ResponseTemplate::new(200).set_body_string(format!(
                r#"{{"id":"fabric-loader-0.16.10-1.21.1","inheritsFrom":"1.21.1","type":"release",
                    "mainClass":"net.fabricmc.loader.impl.launch.knot.KnotClient",
                    "libraries":[{{"name":"net.example:loader:0.16.10","url":"{base}/"}}]}}"#
            )))
            .mount(server)
            .await;
        Mock::given(method("GET"))
            .and(path("/net/example/loader/0.16.10/loader-0.16.10.jar"))
            .respond_with(ResponseTemplate::new(200).set_body_bytes(b"loader".to_vec()))
            .mount(server)
            .await;
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn fabric_instance_is_self_contained_under_its_name() {
        let server = MockServer::start().await;
        mock_meta(&server).await;
        let tmp = tempfile::tempdir().unwrap();
        let petalfall = petalfall_at(tmp.path())
            .with_manifest_url(format!("{}/manifest.json", server.uri()))
            .with_fabric_base(server.uri());
        let req = request("1.21.1", Some(LoaderChoice::Fabric), Some("0.16.10"));

        let marker = petalfall
            .create_instance_dir("周末生存", &req)
            .await
            .unwrap();
        let dir = petalfall.game_dir().join("versions").join("周末生存");
        assert!(marker_path(&dir).is_file(), "安装开始前就写下标记");
        let outcome = petalfall
            .install_instance("周末生存", &req, None)
            .await
            .unwrap();
        petalfall
            .settle_instance_marker("周末生存", marker, MarkerSettlement::Succeeded)
            .await
            .unwrap();

        assert_eq!(outcome.id, "周末生存");
        assert_eq!(
            outcome.loader,
            Some(InstalledLoader {
                choice: LoaderChoice::Fabric,
                version: "0.16.10".into()
            })
        );
        assert_eq!(outcome.libraries, 1);
        assert!(!marker_path(&dir).exists(), "成功后标记删除");
        assert!(
            !dir.join(PETALFALL_META_DIR)
                .join(STAGED_VANILLA_JSON)
                .exists()
        );
        // versions/ 下只有这一个实例，没有多出原版或 fabric-loader-* 目录。
        assert_eq!(
            petalfall.instance_names().await.unwrap(),
            vec!["周末生存".to_owned()]
        );
        let json: VersionJson =
            serde_json::from_slice(&std::fs::read(dir.join("周末生存.json")).unwrap()).unwrap();
        assert_eq!(json.id, "周末生存");
        assert_eq!(json.inherits_from, None);
        assert_eq!(json.client_version.as_deref(), Some("1.21.1"));
        assert_eq!(json.java_version.unwrap().major_version, 21);

        let list = petalfall.list_instances().await.unwrap();
        let crate::instances::InstanceVersion::Ready(ready) = &list[0].version else {
            panic!("新实例应可用");
        };
        assert_eq!(ready.mc_version.as_deref(), Some("1.21.1"));
        assert_eq!(ready.loaders[0].kind, petalfall_version::LoaderKind::Fabric);
        assert!(list[0].incomplete.is_none());
    }

    fn put_template(petalfall: &Petalfall, files: &[(&str, &[u8])]) {
        let dir = petalfall.template_dir();
        std::fs::create_dir_all(&dir).unwrap();
        for (name, bytes) in files {
            std::fs::write(dir.join(name), bytes).unwrap();
        }
    }

    fn stages(mut rx: tokio::sync::mpsc::UnboundedReceiver<CoreEvent>) -> Vec<String> {
        let mut stages = Vec::new();
        while let Ok(event) = rx.try_recv() {
            if let CoreEvent::Stage(stage) = event {
                stages.push(stage);
            }
        }
        stages
    }

    /// 请求了套用：版本 JSON 写好后补上模板文件，标记里记着这次请求；没请求的实例一个文件都不多。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn requested_template_is_applied_once_the_instance_is_installed() {
        let server = MockServer::start().await;
        mock_meta(&server).await;
        let tmp = tempfile::tempdir().unwrap();
        let petalfall = petalfall_at(tmp.path())
            .with_manifest_url(format!("{}/manifest.json", server.uri()))
            .with_fabric_base(server.uri());
        let servers: Vec<u8> = (0..fastrand::usize(1..2048))
            .map(|_| fastrand::u8(..))
            .collect();
        put_template(
            &petalfall,
            &[
                ("options.txt", b"fov:90\nrenderDistance:16"),
                ("servers.dat", &servers),
            ],
        );
        let req = InstanceRequest {
            use_template: true,
            ..request("1.21.1", Some(LoaderChoice::Fabric), Some("0.16.10"))
        };

        petalfall
            .create_instance_dir("周末生存", &req)
            .await
            .unwrap();
        let dir = petalfall.game_dir().join("versions").join("周末生存");
        let stored = MarkerStore::for_version_dir(&dir)
            .load()
            .await
            .unwrap()
            .unwrap();
        assert_eq!(stored.kind, IncompleteKind::Install { spec: req.spec() });
        assert!(req.spec().use_template);
        let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
        let outcome = petalfall
            .install_instance("周末生存", &req, Some(&tx))
            .await
            .unwrap();
        drop(tx);

        assert_eq!(
            outcome.template,
            Some(TemplateOutcome::Applied {
                copied: vec!["options.txt", "servers.dat"],
                kept: vec![],
            })
        );
        assert_eq!(
            std::fs::read(dir.join("options.txt")).unwrap(),
            b"fov:90\nrenderDistance:16"
        );
        assert_eq!(std::fs::read(dir.join("servers.dat")).unwrap(), servers);
        let stages = stages(rx);
        let at = stages
            .iter()
            .position(|s| s == "沿用默认设置：补上 options.txt、servers.dat")
            .unwrap_or_else(|| panic!("{stages:?}"));
        assert!(
            stages[at + 1].starts_with("实例 周末生存 安装完成"),
            "{stages:?}"
        );

        let plain = request("1.21.1", Some(LoaderChoice::Fabric), Some("0.16.10"));
        petalfall.create_instance_dir("不套", &plain).await.unwrap();
        let outcome = petalfall
            .install_instance("不套", &plain, None)
            .await
            .unwrap();
        assert_eq!(outcome.template, None);
        let other = petalfall.game_dir().join("versions").join("不套");
        assert!(!other.join("options.txt").exists());
        assert!(!other.join("servers.dat").exists());
    }

    /// 原版正式版在默认档位下不隔离：版本 JSON 写好后才判得出来，判出来就不碰共用的根目录。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn template_is_skipped_for_an_instance_sharing_the_game_dir() {
        let server = MockServer::start().await;
        mock_meta(&server).await;
        let tmp = tempfile::tempdir().unwrap();
        let petalfall =
            petalfall_at(tmp.path()).with_manifest_url(format!("{}/manifest.json", server.uri()));
        put_template(&petalfall, &[("options.txt", b"fov:90")]);
        std::fs::create_dir_all(petalfall.game_dir()).unwrap();
        std::fs::write(petalfall.game_dir().join("options.txt"), b"fov:70").unwrap();
        let req = InstanceRequest {
            use_template: true,
            ..request("1.21.1", None, None)
        };

        petalfall.create_instance_dir("原版", &req).await.unwrap();
        let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
        let outcome = petalfall
            .install_instance("原版", &req, Some(&tx))
            .await
            .unwrap();
        drop(tx);

        assert_eq!(
            outcome.template,
            Some(TemplateOutcome::Skipped(
                crate::template::TemplateSkip::SharedWorkingDir
            ))
        );
        assert_eq!(
            std::fs::read(petalfall.game_dir().join("options.txt")).unwrap(),
            b"fov:70"
        );
        let dir = petalfall.game_dir().join("versions").join("原版");
        assert!(!dir.join("options.txt").exists());
        assert!(
            stages(rx).iter().any(
                |s| s == "没有沿用默认设置：这个实例与其他未隔离的实例共用 .minecraft 里的设置"
            ),
        );
    }

    fn drain(mut rx: tokio::sync::mpsc::UnboundedReceiver<CoreEvent>) -> Vec<CoreEvent> {
        let mut events = Vec::new();
        while let Ok(event) = rx.try_recv() {
            events.push(event);
        }
        events
    }

    /// 步骤事件按到达先后的 (步骤表, 下标)。
    fn phases_of(events: &[CoreEvent]) -> Vec<(Vec<InstallPhase>, usize)> {
        events
            .iter()
            .filter_map(|event| match event {
                CoreEvent::Phase { plan, index } => Some((plan.clone(), *index)),
                _ => None,
            })
            .collect()
    }

    /// 新建一路报出的步骤：第一条事件就是第一步，表里每一步按先后各报一次、一步不跳，整份表全程不变。
    /// 套默认设置时这一步照报，哪怕实例共用游戏目录、最后没有套。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn install_announces_every_phase_once_in_plan_order() {
        use InstallPhase::*;
        let server = MockServer::start().await;
        mock_meta(&server).await;
        let tmp = tempfile::tempdir().unwrap();
        let petalfall = petalfall_at(tmp.path())
            .with_manifest_url(format!("{}/manifest.json", server.uri()))
            .with_fabric_base(server.uri());
        put_template(&petalfall, &[("options.txt", b"fov:90")]);
        let cases = [
            (
                "织布",
                request("1.21.1", Some(LoaderChoice::Fabric), Some("0.16.10")),
                vec![Metadata, LoaderProfile, Libraries, Assets, Natives],
            ),
            (
                "原版",
                InstanceRequest {
                    use_template: true,
                    ..request("1.21.1", None, None)
                },
                vec![Metadata, Libraries, Assets, Natives, Template],
            ),
        ];

        for (name, req, plan) in cases {
            petalfall.create_instance_dir(name, &req).await.unwrap();
            let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
            petalfall
                .install_instance(name, &req, Some(&tx))
                .await
                .unwrap();
            drop(tx);

            let events = drain(rx);
            assert!(
                matches!(events[0], CoreEvent::Phase { index: 0, .. }),
                "{name}: {events:?}"
            );
            assert_eq!(
                phases_of(&events),
                (0..plan.len())
                    .map(|i| (plan.clone(), i))
                    .collect::<Vec<_>>(),
                "{name}"
            );
        }
    }

    #[test]
    fn plans_list_the_steps_each_loader_goes_through() {
        use InstallPhase::*;
        let plan = |loader, version: Option<&str>, use_template| {
            install_plan(&InstanceRequest {
                use_template,
                ..request("1.20.1", loader, version)
            })
        };
        for use_template in [false, true] {
            let tail: &[InstallPhase] = if use_template { &[Template] } else { &[] };
            let expect = |steps: &[InstallPhase]| [steps, tail].concat();
            assert_eq!(
                plan(None, None, use_template),
                expect(&[Metadata, Libraries, Assets, Natives])
            );
            for choice in [LoaderChoice::Fabric, LoaderChoice::Quilt] {
                assert_eq!(
                    plan(Some(choice), None, use_template),
                    expect(&[Metadata, LoaderProfile, Libraries, Assets, Natives])
                );
            }
            for (choice, version) in [
                (LoaderChoice::Forge, "47.2.0"),
                (LoaderChoice::NeoForge, "21.1.77"),
            ] {
                assert_eq!(
                    plan(Some(choice), Some(version), use_template),
                    expect(&[
                        Metadata,
                        Libraries,
                        Assets,
                        Natives,
                        Java,
                        LoaderInstaller,
                        LoaderLibraries,
                        LoaderProcessors,
                        Verify,
                    ])
                );
            }
        }
    }

    #[test]
    #[should_panic(expected = "报了两遍")]
    fn announcing_a_phase_twice_panics() {
        let announcer =
            PhaseAnnouncer::new(None, vec![InstallPhase::Metadata, InstallPhase::Libraries]);
        announcer.enter(InstallPhase::Libraries);
        announcer.enter(InstallPhase::Libraries);
    }

    #[test]
    #[should_panic(expected = "不在这次的步骤表")]
    fn announcing_a_phase_outside_the_plan_panics() {
        let announcer =
            PhaseAnnouncer::new(None, vec![InstallPhase::Metadata, InstallPhase::Libraries]);
        announcer.enter(InstallPhase::Template);
    }

    #[test]
    fn request_round_trips_through_the_marker_spec() {
        for use_template in [true, false] {
            for (loader, version) in [
                (None, None),
                (Some(LoaderChoice::Fabric), None),
                (Some(LoaderChoice::Quilt), Some("0.27.1")),
                (Some(LoaderChoice::Forge), Some("47.4.20")),
                (Some(LoaderChoice::NeoForge), Some("21.1.77")),
            ] {
                let req = InstanceRequest {
                    use_template,
                    ..request("1.21.1", loader, version)
                };
                let spec = req.spec();
                assert_eq!(spec.use_template, use_template);
                assert_eq!(InstanceRequest::from_spec("x", &spec).unwrap(), req);
            }
        }
    }

    #[test]
    fn template_stage_names_copied_and_kept_files() {
        use crate::template::TemplateSkip;
        assert_eq!(
            template_stage(&TemplateOutcome::Applied {
                copied: vec!["servers.dat"],
                kept: vec!["options.txt", "optionsof.txt"],
            }),
            "沿用默认设置：补上 servers.dat（已有的 options.txt、optionsof.txt 保留不动）"
        );
        assert_eq!(
            template_stage(&TemplateOutcome::Applied {
                copied: vec![],
                kept: vec!["options.txt"],
            }),
            "沿用默认设置：已有的 options.txt 保留不动"
        );
        assert_eq!(
            template_stage(&TemplateOutcome::Skipped(TemplateSkip::Empty)),
            "没有沿用默认设置：还没有默认设置"
        );
        assert_eq!(
            template_stage(&TemplateOutcome::Skipped(TemplateSkip::Disabled)),
            "没有沿用默认设置：新建实例时沿用默认设置已在配置里关闭"
        );
    }

    #[tokio::test]
    async fn creating_an_existing_name_reports_duplicate_and_leaves_it_alone() {
        let tmp = tempfile::tempdir().unwrap();
        let petalfall = petalfall_at(tmp.path());
        let dir = write_version(petalfall.game_dir(), "Survival", &vanilla_json("1.21.1"));
        let err = petalfall
            .create_instance_dir("survival", &request("1.21.1", None, None))
            .await
            .unwrap_err();
        assert!(matches!(
            err,
            CoreError::Instance(InstanceError::InvalidName {
                violation: NameViolation::Duplicate,
                ..
            })
        ));
        assert!(!marker_path(&dir).exists());

        let err = petalfall
            .create_instance_dir("x", &request("1.21.1", Some(LoaderChoice::Forge), None))
            .await
            .unwrap_err();
        assert!(matches!(
            err,
            CoreError::Install(petalfall_install::Error::LoaderVersionNotFound { .. })
        ));
        assert!(!petalfall.game_dir().join("versions").join("x").exists());
    }

    /// 同名旧实例在启动器之外（资源管理器、共用游戏目录的别的启动器）被删掉后，它的游玩记录还在；新建的
    /// 同名实例从零算起。撞名失败时不动已有实例的记录，别的实例与别的游戏目录的记录也不动。
    #[tokio::test]
    async fn new_instance_does_not_inherit_records_of_a_vanished_namesake() {
        let tmp = tempfile::tempdir().unwrap();
        let petalfall = petalfall_at(tmp.path());
        let other = tmp.path().join("HMCL").join(".minecraft");
        let hour = 3_600_000;
        for (game_dir, id) in [
            (petalfall.game_dir(), "周末生存"),
            (petalfall.game_dir(), "Survival"),
            (petalfall.game_dir(), "别的"),
            (other.as_path(), "周末生存"),
        ] {
            crate::playtime::record_play(tmp.path(), game_dir, id, 0, hour)
                .await
                .unwrap();
        }
        write_version(petalfall.game_dir(), "Survival", &vanilla_json("1.21.1"));

        petalfall
            .create_instance_dir("survival", &request("1.21.1", None, None))
            .await
            .unwrap_err();
        petalfall
            .create_instance_dir("周末生存", &request("1.21.1", None, None))
            .await
            .unwrap();

        let summaries = petalfall.play_summaries().await.unwrap();
        assert_eq!(
            summaries.keys().collect::<Vec<_>>(),
            vec!["Survival", "别的"]
        );
        assert_eq!(summaries["Survival"].playtime_min, 60);
        let elsewhere = Petalfall::for_test(
            crate::config::PetalfallConfig::default(),
            tmp.path().to_path_buf(),
            other,
        );
        assert_eq!(
            elsewhere.play_summaries().await.unwrap()["周末生存"].playtime_min,
            60
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn failed_install_keeps_the_directory_with_a_failed_marker_and_repair_reinstalls() {
        let server = MockServer::start().await;
        mock_meta(&server).await;
        let tmp = tempfile::tempdir().unwrap();
        let petalfall = petalfall_at(tmp.path())
            .with_manifest_url(format!("{}/manifest.json", server.uri()))
            .with_fabric_base(server.uri());
        // 不存在的 loader 版本：meta 404，安装失败。
        let bad = request("1.21.1", Some(LoaderChoice::Fabric), Some("9.9.9"));
        let marker = petalfall.create_instance_dir("半成品", &bad).await.unwrap();
        let err = petalfall
            .install_instance("半成品", &bad, None)
            .await
            .unwrap_err();
        petalfall
            .settle_instance_marker(
                "半成品",
                marker,
                MarkerSettlement::Failed(MarkerError {
                    code: "install_failed".into(),
                    message: err.to_string(),
                }),
            )
            .await
            .unwrap();

        let dir = petalfall.game_dir().join("versions").join("半成品");
        let stored = MarkerStore::for_version_dir(&dir)
            .load()
            .await
            .unwrap()
            .unwrap();
        assert_eq!(stored.outcome, IncompleteOutcome::Failed);
        assert_eq!(stored.error.as_ref().unwrap().code, "install_failed");
        assert_eq!(stored.kind, IncompleteKind::Install { spec: bad.spec() });

        // 修复照标记里的内容重装；把标记里的版本改成存在的那个，模拟「网络恢复后重试」。
        let good = request("1.21.1", Some(LoaderChoice::Fabric), Some("0.16.10"));
        MarkerStore::for_version_dir(&dir)
            .save(&IncompleteMarker {
                kind: IncompleteKind::Install { spec: good.spec() },
                ..stored
            })
            .await
            .unwrap();
        let (plan, marker) = petalfall.begin_repair("半成品").await.unwrap();
        assert_eq!(plan, RepairPlan::Reinstall(good));
        assert_eq!(marker.outcome, IncompleteOutcome::Pending);
        let outcome = petalfall
            .repair_instance("半成品", &plan, None)
            .await
            .unwrap();
        assert!(outcome.reinstalled);
        petalfall
            .settle_instance_marker("半成品", marker, MarkerSettlement::Succeeded)
            .await
            .unwrap();
        assert!(!marker_path(&dir).exists(), "修复成功后标记清掉");
        assert!(dir.join("半成品.json").is_file());
    }

    #[tokio::test]
    async fn repair_of_a_complete_instance_writes_then_clears_a_repair_marker() {
        let tmp = tempfile::tempdir().unwrap();
        let petalfall = petalfall_at(tmp.path());
        let dir = write_version(
            petalfall.game_dir(),
            "1.21.1",
            r#"{"id":"1.21.1","type":"release","mainClass":"M"}"#,
        );
        let (plan, marker) = petalfall.begin_repair("1.21.1").await.unwrap();
        assert_eq!(plan, RepairPlan::Complete);
        let on_disk = MarkerStore::for_version_dir(&dir)
            .load()
            .await
            .unwrap()
            .unwrap();
        assert_eq!(on_disk.kind, IncompleteKind::Repair);
        assert_eq!(on_disk.outcome, IncompleteOutcome::Pending);

        let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
        let outcome = petalfall
            .repair_instance("1.21.1", &plan, Some(&tx))
            .await
            .unwrap();
        drop(tx);
        assert!(!outcome.reinstalled);
        assert_eq!(outcome.libraries, 0);
        let steps = vec![
            InstallPhase::Libraries,
            InstallPhase::Assets,
            InstallPhase::Natives,
        ];
        assert_eq!(
            phases_of(&drain(rx)),
            vec![(steps.clone(), 0), (steps.clone(), 1), (steps, 2)]
        );
        petalfall
            .settle_instance_marker("1.21.1", marker.clone(), MarkerSettlement::Succeeded)
            .await
            .unwrap();
        assert!(!marker_path(&dir).exists());

        // 被取消时标记留下并记为 cancelled。
        petalfall
            .settle_instance_marker("1.21.1", marker, MarkerSettlement::Cancelled)
            .await
            .unwrap();
        let cancelled = MarkerStore::for_version_dir(&dir)
            .load()
            .await
            .unwrap()
            .unwrap();
        assert_eq!(cancelled.outcome, IncompleteOutcome::Cancelled);
    }

    /// 整合包导入中断的实例即使版本 JSON 已经写好也不能按「补全」处理：报不可补全，标记原样留着。
    /// 装好之后版本 JSON 被手工删掉或写坏：这时已经没有未完成标记，只有安装记录说得出当初装的是什么。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn lost_version_json_is_reinstalled_from_the_install_record() {
        let server = MockServer::start().await;
        mock_meta(&server).await;
        let tmp = tempfile::tempdir().unwrap();
        let petalfall = petalfall_at(tmp.path())
            .with_manifest_url(format!("{}/manifest.json", server.uri()))
            .with_fabric_base(server.uri());
        let id = "周末生存";
        let req = request("1.21.1", Some(LoaderChoice::Fabric), Some("0.16.10"));
        let marker = petalfall.create_instance_dir(id, &req).await.unwrap();
        petalfall.install_instance(id, &req, None).await.unwrap();
        petalfall
            .settle_instance_marker(id, marker, MarkerSettlement::Succeeded)
            .await
            .unwrap();
        let dir = petalfall.game_dir().join("versions").join(id);
        let json = dir.join(format!("{id}.json"));
        let installed = std::fs::read_to_string(&json).unwrap();
        // 玩家的 Mod 不能因为修复而丢。
        std::fs::create_dir_all(dir.join("mods")).unwrap();
        std::fs::write(dir.join("mods").join("sodium.jar"), b"jar").unwrap();

        for damage in [
            Box::new(|p: &std::path::Path| std::fs::remove_file(p).unwrap())
                as Box<dyn Fn(&std::path::Path)>,
            Box::new(|p: &std::path::Path| std::fs::write(p, "{ not json").unwrap()),
        ] {
            damage(&json);
            let (plan, marker) = petalfall.begin_repair(id).await.unwrap();
            assert_eq!(plan, RepairPlan::Reinstall(req.clone()));
            assert!(matches!(marker.kind, IncompleteKind::Install { .. }));
            let outcome = petalfall.repair_instance(id, &plan, None).await.unwrap();
            assert!(outcome.reinstalled);
            petalfall
                .settle_instance_marker(id, marker, MarkerSettlement::Succeeded)
                .await
                .unwrap();
            assert_eq!(std::fs::read_to_string(&json).unwrap(), installed);
        }
        assert!(dir.join("mods").join("sodium.jar").exists());
        assert!(!marker_path(&dir).exists());
    }

    /// 没指定版本时记下的是这次实际装上的，不是「推荐版」：日后修复不该换掉玩家的加载器版本。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn install_record_keeps_the_version_that_was_actually_installed() {
        let server = MockServer::start().await;
        mock_meta(&server).await;
        Mock::given(method("GET"))
            .and(path("/v2/versions/loader/1.21.1"))
            .respond_with(ResponseTemplate::new(200).set_body_string(
                r#"[{"loader":{"separator":".","build":10,"maven":"m","version":"0.16.10","stable":true}}]"#,
            ))
            .mount(&server)
            .await;
        let tmp = tempfile::tempdir().unwrap();
        let petalfall = petalfall_at(tmp.path())
            .with_manifest_url(format!("{}/manifest.json", server.uri()))
            .with_fabric_base(server.uri());
        let req = InstanceRequest {
            use_template: true,
            ..request("1.21.1", Some(LoaderChoice::Fabric), None)
        };
        petalfall.create_instance_dir("推荐版", &req).await.unwrap();
        petalfall
            .install_instance("推荐版", &req, None)
            .await
            .unwrap();
        let dir = petalfall.game_dir().join("versions").join("推荐版");
        assert_eq!(
            InstallRecordStore::for_version_dir(&dir)
                .load()
                .await
                .unwrap(),
            Some(InstallSpec {
                mc_version: "1.21.1".into(),
                loader: Some("fabric".into()),
                loader_version: Some("0.16.10".into()),
                use_template: false,
            })
        );
    }

    #[tokio::test]
    async fn interrupted_modpack_import_is_not_repairable_and_keeps_its_marker() {
        let tmp = tempfile::tempdir().unwrap();
        let petalfall = petalfall_at(tmp.path());
        let dir = write_version(petalfall.game_dir(), "整合包", &vanilla_json("1.21.1"));
        let store = MarkerStore::for_version_dir(&dir);
        let marker = IncompleteMarker::pending(
            IncompleteKind::Modpack {
                task_id: "mp#1".into(),
            },
            1_700_000_000_000,
        );
        store.save(&marker).await.unwrap();

        let err = petalfall.begin_repair("整合包").await.unwrap_err();
        match err {
            CoreError::Instance(InstanceError::NotRepairable { id, reason }) => {
                assert_eq!(id, "整合包");
                assert!(reason.contains("重新导入"), "{reason}");
            }
            other => panic!("应报不可补全：{other:?}"),
        }
        assert_eq!(store.load().await.unwrap(), Some(marker));
    }

    #[tokio::test]
    async fn broken_instance_without_install_record_is_not_repairable() {
        let tmp = tempfile::tempdir().unwrap();
        let petalfall = petalfall_at(tmp.path());
        std::fs::create_dir_all(petalfall.game_dir().join("versions").join("空的")).unwrap();
        let err = petalfall.begin_repair("空的").await.unwrap_err();
        assert!(
            matches!(
                err,
                CoreError::Instance(InstanceError::NotRepairable { .. })
            ),
            "实际：{err:?}"
        );
    }

    /// 实例目录里的 Fabric 版本 JSON：`clientVersion` 记着原版版本号，改过名也认得出。
    fn fabric_instance_json(id: &str, loader: &str) -> String {
        format!(
            r#"{{"id":"{id}","type":"release","clientVersion":"1.21.1",
                "mainClass":"net.fabricmc.loader.impl.launch.knot.KnotClient",
                "libraries":[{{"name":"net.fabricmc:fabric-loader:{loader}"}}]}}"#
        )
    }

    /// 重新安装加载器照原样把版本 JSON 与加载器装回：Mod、配置、存档一个字节不动，默认设置也不套，
    /// 否则玩家的 options.txt 之外的文件会被模板补进来。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn reinstalling_the_loader_rewrites_it_and_leaves_player_files_alone() {
        let server = MockServer::start().await;
        mock_meta(&server).await;
        let tmp = tempfile::tempdir().unwrap();
        let petalfall = petalfall_at(tmp.path())
            .with_manifest_url(format!("{}/manifest.json", server.uri()))
            .with_fabric_base(server.uri());
        put_template(&petalfall, &[("servers.dat", b"template")]);
        let dir = write_version(
            petalfall.game_dir(),
            "周末生存",
            &fabric_instance_json("周末生存", "0.16.10"),
        );
        let world: Vec<u8> = (0..fastrand::usize(1..2048))
            .map(|_| fastrand::u8(..))
            .collect();
        let kept: [(&str, &[u8]); 4] = [
            ("mods/sodium.jar", b"mod-bytes"),
            ("config/sodium.toml", b"[sodium]\nfog = false\n"),
            ("saves/新世界/level.dat", &world),
            ("options.txt", b"fov:90"),
        ];
        for (path, bytes) in kept {
            let file = dir.join(path);
            std::fs::create_dir_all(file.parent().unwrap()).unwrap();
            std::fs::write(file, bytes).unwrap();
        }

        let (plan, marker) = petalfall.begin_loader_reinstall("周末生存").await.unwrap();
        let expected = request("1.21.1", Some(LoaderChoice::Fabric), Some("0.16.10"));
        assert_eq!(plan, RepairPlan::Reinstall(expected.clone()));
        let on_disk = MarkerStore::for_version_dir(&dir)
            .load()
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            on_disk.kind,
            IncompleteKind::Install {
                spec: expected.spec()
            },
            "中途失败时补全要照着这份内容接着重装"
        );
        assert_eq!(on_disk.outcome, IncompleteOutcome::Pending);

        let outcome = petalfall
            .repair_instance("周末生存", &plan, None)
            .await
            .unwrap();
        petalfall
            .settle_instance_marker("周末生存", marker, MarkerSettlement::Succeeded)
            .await
            .unwrap();

        assert_eq!(
            outcome,
            RepairOutcome {
                reinstalled: true,
                libraries: 1,
                assets: 0,
                natives: 0
            }
        );
        assert!(!marker_path(&dir).exists(), "重装成功后标记清掉");
        let json: VersionJson =
            serde_json::from_slice(&std::fs::read(dir.join("周末生存.json")).unwrap()).unwrap();
        assert_eq!(json.client_version.as_deref(), Some("1.21.1"));
        assert_eq!(
            json.libraries
                .iter()
                .map(|l| l.name.as_str())
                .collect::<Vec<_>>(),
            vec!["net.example:loader:0.16.10"],
            "版本 JSON 换成了加载器服务给的那一份"
        );
        for (path, bytes) in kept {
            assert_eq!(std::fs::read(dir.join(path)).unwrap(), bytes, "{path}");
        }
        assert!(!dir.join("servers.dat").exists(), "重装不套默认设置");
    }

    /// 版本号照现有版本 JSON 读：改过名的基底只在 clientVersion 里记着版本号，1.20.1 的 NeoForge 探测时
    /// 同时命中 Forge，都不能读错，否则重装的就是另一个游戏版本或另一个加载器。
    #[tokio::test]
    async fn the_loader_to_reinstall_is_read_from_the_version_json() {
        let tmp = tempfile::tempdir().unwrap();
        let petalfall = petalfall_at(tmp.path());
        let game = petalfall.game_dir().to_path_buf();
        write_version(
            &game,
            "我的原版",
            r#"{"id":"我的原版","type":"release","clientVersion":"1.20.1","mainClass":"M"}"#,
        );
        for (id, json, mc, loader, version) in [
            (
                "Forge",
                r#"{"id":"Forge","type":"release","clientVersion":"1.20.1","mainClass":"M",
                    "libraries":[{"name":"net.minecraftforge:forge:1.20.1-47.2.0:client"}]}"#,
                "1.20.1",
                LoaderChoice::Forge,
                "47.2.0",
            ),
            (
                "NeoForge",
                r#"{"id":"NeoForge","type":"release","clientVersion":"1.21.1","mainClass":"M",
                    "libraries":[{"name":"net.neoforged:neoforge:21.1.77-beta:universal"}]}"#,
                "1.21.1",
                LoaderChoice::NeoForge,
                "21.1.77-beta",
            ),
            (
                "NeoForge 旧版",
                r#"{"id":"NeoForge 旧版","type":"release","clientVersion":"1.20.1","mainClass":"M",
                    "arguments":{"game":["--fml.forgeVersion","47.1.106"],"jvm":[]},
                    "libraries":[{"name":"net.neoforged:forge:1.20.1-47.1.106:universal"}]}"#,
                "1.20.1",
                LoaderChoice::NeoForge,
                "47.1.106",
            ),
            (
                "Quilt",
                r#"{"id":"Quilt","type":"release","clientVersion":"1.20.1","mainClass":"M",
                    "libraries":[{"name":"org.quiltmc:quilt-loader:0.26.0-beta.1"}]}"#,
                "1.20.1",
                LoaderChoice::Quilt,
                "0.26.0-beta.1",
            ),
            (
                "传统布局",
                r#"{"id":"传统布局","inheritsFrom":"我的原版","type":"release","mainClass":"M",
                    "libraries":[{"name":"net.fabricmc:fabric-loader:0.15.11"}]}"#,
                "1.20.1",
                LoaderChoice::Fabric,
                "0.15.11",
            ),
            (
                "基底不在了",
                r#"{"id":"基底不在了","inheritsFrom":"1.19.4","type":"release","mainClass":"M",
                    "libraries":[{"name":"net.fabricmc:fabric-loader:0.15.11"}]}"#,
                "1.19.4",
                LoaderChoice::Fabric,
                "0.15.11",
            ),
        ] {
            write_version(&game, id, json);
            let (plan, _) = petalfall.begin_loader_reinstall(id).await.unwrap();
            assert_eq!(
                plan,
                RepairPlan::Reinstall(request(mc, Some(loader), Some(version))),
                "{id}"
            );
        }
    }

    /// 定不出能原样装回的内容时报不可补全，动手之前就停下，原有的标记不被覆盖：实例不会因为点了一下就多出
    /// 一份照着猜测内容写的安装标记。
    #[tokio::test]
    async fn loaders_that_cannot_be_put_back_as_they_were_are_refused() {
        let tmp = tempfile::tempdir().unwrap();
        let petalfall = petalfall_at(tmp.path());
        let game = petalfall.game_dir().to_path_buf();
        for (id, json, reason) in [
            (
                "原版",
                r#"{"id":"原版","type":"release","clientVersion":"1.21.1","mainClass":"M"}"#,
                "没有装加载器",
            ),
            (
                "光影",
                r#"{"id":"光影","type":"release","clientVersion":"1.21.1","mainClass":"M",
                    "libraries":[{"name":"optifine:OptiFine:1.21.1_HD_U_J1"}]}"#,
                "OptiFine",
            ),
            (
                "叠层",
                r#"{"id":"叠层","type":"release","clientVersion":"1.20.1","mainClass":"M",
                    "libraries":[{"name":"net.minecraftforge:forge:1.20.1-47.2.0"},
                                 {"name":"optifine:OptiFine:1.20.1_HD_U_I6"}]}"#,
                "OptiFine",
            ),
            (
                "老旧",
                r#"{"id":"老旧","type":"release","clientVersion":"1.7.10","mainClass":"M",
                    "minecraftArguments":"--tweakClass com.mumfrey.liteloader.launch.LiteLoaderTweaker",
                    "libraries":[{"name":"com.mumfrey:liteloader:1.7.10"}]}"#,
                "LiteLoader",
            ),
            (
                "无版本号",
                r#"{"id":"无版本号","type":"release","clientVersion":"1.21.1",
                    "mainClass":"net.fabricmc.loader.impl.launch.knot.KnotClient"}"#,
                "读不出 Fabric 的版本号",
            ),
            (
                "不知版本",
                r#"{"id":"不知版本","type":"release","mainClass":"M",
                    "libraries":[{"name":"net.fabricmc:fabric-loader:0.15.11"}]}"#,
                "读不出游戏版本号",
            ),
            // 版本号是从目录名里抠出来的：猜错了就成了另一个游戏版本。
            (
                "魔改1.20",
                r#"{"id":"魔改1.20","type":"release","mainClass":"M",
                    "libraries":[{"name":"net.fabricmc:fabric-loader:0.15.11"}]}"#,
                "读不出游戏版本号",
            ),
        ] {
            let dir = write_version(&game, id, json);
            let store = MarkerStore::for_version_dir(&dir);
            let earlier = IncompleteMarker {
                error: Some(MarkerError {
                    code: "network_failed".into(),
                    message: "连不上".into(),
                }),
                outcome: IncompleteOutcome::Failed,
                ..IncompleteMarker::pending(IncompleteKind::Repair, 1_700_000_000_000)
            };
            store.save(&earlier).await.unwrap();

            match petalfall.begin_loader_reinstall(id).await.unwrap_err() {
                CoreError::Instance(InstanceError::NotRepairable {
                    id: got,
                    reason: why,
                }) => {
                    assert_eq!(got, id);
                    assert!(why.contains(reason), "{id}：{why}");
                }
                other => panic!("{id} 应报不可补全：{other:?}"),
            }
            assert_eq!(store.load().await.unwrap(), Some(earlier), "{id}");
        }
    }

    /// 版本号来自本地版本 JSON，同样会拼进安装器地址：不是单个安全路径段时在写下标记之前就拒掉。
    #[tokio::test]
    async fn an_unsafe_loader_version_in_the_version_json_is_refused_before_any_marker() {
        let tmp = tempfile::tempdir().unwrap();
        let petalfall = petalfall_at(tmp.path());
        let dir = write_version(
            petalfall.game_dir(),
            "手改过",
            &fabric_instance_json("手改过", ".."),
        );
        let err = petalfall
            .begin_loader_reinstall("手改过")
            .await
            .unwrap_err();
        assert!(
            matches!(
                err,
                CoreError::Install(petalfall_install::Error::UnsafePath { .. })
            ),
            "实际：{err:?}"
        );
        assert!(!marker_path(&dir).exists());
    }

    /// 安装没完成的实例照标记里记下的内容重装（标记里可能记着开局要套默认设置），不去读可能还没写出来的版本 JSON；
    /// 整合包没导入完的缺的是整合包内容，重装加载器补不回来。
    #[tokio::test]
    async fn loader_reinstall_defers_to_what_the_marker_recorded() {
        let tmp = tempfile::tempdir().unwrap();
        let petalfall = petalfall_at(tmp.path());
        let wanted = InstanceRequest {
            use_template: true,
            ..request("1.21.1", Some(LoaderChoice::Fabric), Some("0.16.10"))
        };
        petalfall
            .create_instance_dir("半成品", &wanted)
            .await
            .unwrap();
        let (plan, _) = petalfall.begin_loader_reinstall("半成品").await.unwrap();
        assert_eq!(plan, RepairPlan::Reinstall(wanted));

        let dir = write_version(
            petalfall.game_dir(),
            "整合包",
            &fabric_instance_json("整合包", "0.16.10"),
        );
        let store = MarkerStore::for_version_dir(&dir);
        let marker = IncompleteMarker::pending(
            IncompleteKind::Modpack {
                task_id: "mp#1".into(),
            },
            1_700_000_000_000,
        );
        store.save(&marker).await.unwrap();
        match petalfall
            .begin_loader_reinstall("整合包")
            .await
            .unwrap_err()
        {
            CoreError::Instance(InstanceError::NotRepairable { reason, .. }) => {
                assert!(reason.contains("重新导入"), "{reason}");
            }
            other => panic!("应报不可补全：{other:?}"),
        }
        assert_eq!(store.load().await.unwrap(), Some(marker));
    }

    /// 上次补全败在加载器自带的库上时，普通补全直接换成重装：「修复并启动」「重试」「全部修复」都走这里，
    /// 否则每一个都原样失败，玩家在实例库里点不出去。别的失败照旧按版本 JSON 补全。
    #[tokio::test]
    async fn repair_after_a_lost_loader_library_reinstalls_the_loader() {
        let tmp = tempfile::tempdir().unwrap();
        let petalfall = petalfall_at(tmp.path());
        let dir = write_version(
            petalfall.game_dir(),
            "周末生存",
            &fabric_instance_json("周末生存", "0.16.10"),
        );
        let store = MarkerStore::for_version_dir(&dir);
        let failed_with = |code: &str| IncompleteMarker {
            error: Some(MarkerError {
                code: code.to_owned(),
                message: "原文".into(),
            }),
            outcome: IncompleteOutcome::Failed,
            ..IncompleteMarker::pending(IncompleteKind::Repair, 1_700_000_000_000)
        };

        store.save(&failed_with("network_failed")).await.unwrap();
        let (plan, _) = petalfall.begin_repair("周末生存").await.unwrap();
        assert_eq!(plan, RepairPlan::Complete);

        store
            .save(&failed_with("loader_library_missing"))
            .await
            .unwrap();
        let (plan, _) = petalfall.begin_repair("周末生存").await.unwrap();
        assert_eq!(
            plan,
            RepairPlan::Reinstall(request(
                "1.21.1",
                Some(LoaderChoice::Fabric),
                Some("0.16.10")
            ))
        );

        // 装不回的加载器照旧补全：玩家把文件放回去之后，这是清掉标记的唯一办法。
        let optifine = write_version(
            petalfall.game_dir(),
            "光影",
            r#"{"id":"光影","type":"release","clientVersion":"1.21.1","mainClass":"M",
                "libraries":[{"name":"optifine:OptiFine:1.21.1_HD_U_J1"}]}"#,
        );
        MarkerStore::for_version_dir(&optifine)
            .save(&failed_with("loader_library_missing"))
            .await
            .unwrap();
        let (plan, _) = petalfall.begin_repair("光影").await.unwrap();
        assert_eq!(plan, RepairPlan::Complete);
    }

    #[tokio::test]
    async fn abandon_removes_the_directory_and_is_idempotent() {
        let tmp = tempfile::tempdir().unwrap();
        let petalfall = petalfall_at(tmp.path());
        let dir = write_version(petalfall.game_dir(), "临时", &vanilla_json("1.21.1"));
        petalfall.abandon_instance("临时").await.unwrap();
        assert!(!dir.exists());
        petalfall.abandon_instance("临时").await.unwrap();
    }

    #[test]
    fn unknown_loader_in_a_marker_is_not_repairable() {
        let spec = InstallSpec {
            mc_version: "1.21.1".into(),
            loader: Some("rift".into()),
            loader_version: None,
            use_template: false,
        };
        let err = InstanceRequest::from_spec("x", &spec).unwrap_err();
        assert!(matches!(
            err,
            CoreError::Instance(InstanceError::NotRepairable { .. })
        ));
    }

    /// 加载器版本号来自远端版本列表，会拼进安装器地址、缓存文件名与版本 id：不是单个安全路径段时在动手之前
    /// 报路径越界，不建目录、不发请求；正常的版本号（含预发布后缀）照常放行。
    #[test]
    fn loader_versions_that_are_not_a_single_path_segment_fail_validation() {
        for (choice, version, problem) in [
            (
                LoaderChoice::Forge,
                r"47.2.0\..\..\x",
                petalfall_version::UnsafePath::Backslash,
            ),
            (
                LoaderChoice::NeoForge,
                "21.1.42/../x",
                petalfall_version::UnsafePath::Separator,
            ),
            (
                LoaderChoice::Fabric,
                "..",
                petalfall_version::UnsafePath::DotSegment,
            ),
        ] {
            let request = InstanceRequest {
                mc_version: "1.20.1".into(),
                loader: Some(choice),
                loader_version: Some(version.into()),
                use_template: false,
            };
            match request.validate() {
                Err(CoreError::Install(petalfall_install::Error::UnsafePath {
                    entry,
                    path,
                    problem: got,
                })) => {
                    assert_eq!(entry, format!("{} 版本号", choice.display_name()));
                    assert_eq!(path, version);
                    assert_eq!(got, problem);
                }
                other => panic!("{version} 应报路径越界，实际：{other:?}"),
            }
        }
        for (choice, version) in [
            (LoaderChoice::Forge, "47.2.0"),
            (LoaderChoice::Quilt, "0.26.0-beta.1"),
        ] {
            InstanceRequest {
                mc_version: "1.20.1".into(),
                loader: Some(choice),
                loader_version: Some(version.into()),
                use_template: false,
            }
            .validate()
            .unwrap();
        }
    }

    // ---- 游戏目录的数据格式记号 ----

    use crate::data_format::STAMP_FILE;
    use crate::data_format::testing::{GuardFixture, with_fixture};
    use std::collections::BTreeMap;
    use std::path::{Path, PathBuf};

    /// 测试里当作这一版的数据格式号：号为 1 时一个记号都不写，看不出写没写。
    const OWN: u32 = 2;
    /// 比 [`OWN`] 新的记号。
    const NEWER_STAMP: &str = r#"{"data_format":3,"written_by":"1.1.0-dev.57"}"#;

    fn own() -> GuardFixture {
        GuardFixture {
            own: OWN,
            look: None,
        }
    }

    fn stamp_file(game_dir: &Path) -> PathBuf {
        game_dir.join(PETALFALL_META_DIR).join(STAMP_FILE)
    }

    fn put(path: &Path, contents: &str) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, contents).unwrap();
    }

    /// `root` 下的全部内容：目录记成 `None`，文件记成字节。
    fn tree(root: &Path) -> BTreeMap<PathBuf, Option<Vec<u8>>> {
        fn walk(root: &Path, dir: &Path, out: &mut BTreeMap<PathBuf, Option<Vec<u8>>>) {
            for entry in std::fs::read_dir(dir).unwrap() {
                let path = entry.unwrap().path();
                let rel = path.strip_prefix(root).unwrap().to_owned();
                if path.is_dir() {
                    out.insert(rel, None);
                    walk(root, &path, out);
                } else {
                    out.insert(rel, Some(std::fs::read(&path).unwrap()));
                }
            }
        }
        let mut out = BTreeMap::new();
        walk(root, root, &mut out);
        out
    }

    /// 当前游戏目录被更新的落樱用过、或记号读不懂：新建在建任何东西之前就报错，数据目录与游戏目录一个文件都不多。
    #[tokio::test]
    async fn creating_in_a_refused_game_dir_writes_nothing() {
        let unreadable = r#"{"data_format":"3"}"#;
        for stamp in [NEWER_STAMP, unreadable] {
            let tmp = tempfile::tempdir().unwrap();
            let petalfall = petalfall_at(tmp.path());
            write_version(petalfall.game_dir(), "旧实例", &vanilla_json("1.21.1"));
            put(&stamp_file(petalfall.game_dir()), stamp);
            let before = tree(tmp.path());

            let err = with_fixture(
                own(),
                petalfall.create_instance_dir("新实例", &request("1.21.1", None, None)),
            )
            .await
            .unwrap_err();

            match err {
                CoreError::GameDirDataTooNew {
                    path,
                    found,
                    supported,
                    written_by,
                } if stamp == NEWER_STAMP => {
                    assert_eq!(path, petalfall.game_dir());
                    assert_eq!((found, supported), (3, OWN));
                    assert_eq!(written_by.as_deref(), Some("1.1.0-dev.57"));
                }
                CoreError::DataFormatUnreadable { path, .. } if stamp == unreadable => {
                    assert_eq!(path, petalfall.game_dir());
                }
                other => panic!("记号 {stamp} 应拒绝新建，实际是 {other:?}"),
            }
            assert_eq!(tree(tmp.path()), before, "记号 {stamp}");
        }
    }

    /// 实例目录建好之后、安装开工之前，游戏目录被更新的落樱用过：安装报错，一个请求都不发，一个文件都不写。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn installing_into_a_newer_game_dir_downloads_and_writes_nothing() {
        let server = MockServer::start().await;
        mock_meta(&server).await;
        let tmp = tempfile::tempdir().unwrap();
        let petalfall = petalfall_at(tmp.path())
            .with_manifest_url(format!("{}/manifest.json", server.uri()))
            .with_fabric_base(server.uri());
        let req = request("1.21.1", Some(LoaderChoice::Fabric), Some("0.16.10"));
        petalfall
            .create_instance_dir("周末生存", &req)
            .await
            .unwrap();
        put(&stamp_file(petalfall.game_dir()), NEWER_STAMP);
        let before = tree(tmp.path());

        let err = with_fixture(own(), petalfall.install_instance("周末生存", &req, None))
            .await
            .unwrap_err();

        match err {
            CoreError::GameDirDataTooNew {
                path,
                found,
                supported,
                ..
            } => {
                assert_eq!(path, petalfall.game_dir());
                assert_eq!((found, supported), (3, OWN));
            }
            other => panic!("应拒绝安装，实际是 {other:?}"),
        }
        assert_eq!(server.received_requests().await.unwrap().len(), 0);
        assert_eq!(tree(tmp.path()), before);
    }

    /// 游戏目录原本不存在：新建把它建出来，在安装开工之前就补上记号，成功后记号是这一版的号。记号已经等于这一版
    /// 时再新建，记号原样不动。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_game_dir_created_by_a_new_instance_gets_the_stamp() {
        let server = MockServer::start().await;
        mock_meta(&server).await;
        let tmp = tempfile::tempdir().unwrap();
        let petalfall = petalfall_at(tmp.path())
            .with_manifest_url(format!("{}/manifest.json", server.uri()))
            .with_fabric_base(server.uri());
        let game_dir = petalfall.game_dir().to_owned();
        assert!(!game_dir.exists());
        let req = request("1.21.1", Some(LoaderChoice::Fabric), Some("0.16.10"));

        with_fixture(own(), async {
            petalfall
                .create_instance_dir("周末生存", &req)
                .await
                .unwrap();
            assert_eq!(
                std::fs::read_to_string(stamp_file(&game_dir)).unwrap(),
                r#"{"data_format":2}"#,
                "建出游戏目录时就该补上记号"
            );
            petalfall
                .install_instance("周末生存", &req, None)
                .await
                .unwrap();
        })
        .await;

        assert_eq!(
            std::fs::read_to_string(stamp_file(&game_dir)).unwrap(),
            r#"{"data_format":2}"#
        );
        assert!(
            game_dir
                .join("versions")
                .join("周末生存")
                .join("周末生存.json")
                .is_file()
        );

        let equal = r#"{"data_format":2,"written_by":"1.0.0"}"#;
        put(&stamp_file(&game_dir), equal);
        with_fixture(
            own(),
            petalfall.create_instance_dir("第二个", &request("1.21.1", None, None)),
        )
        .await
        .unwrap();
        assert_eq!(
            std::fs::read_to_string(stamp_file(&game_dir)).unwrap(),
            equal
        );
    }

    use crate::data_format::DirLook;
    use crate::data_format::testing::LookFn;
    use crate::error::GameDirProblem;
    use petalfall_release::data_format::{StampFile, parse_stamp};
    use std::sync::{Arc, Mutex};

    /// 游戏目录原本不存在：开头的核对看到目录不存在，建好 `versions/` 之后的第二次核对被拒，一种是别处刚写下了更高的
    /// 号，一种是这一刻够不着这个位置（网络盘断开）。新建报第二次核对的错误，实例目录没建、没有未完成标记、没写记号：
    /// 盘上只多出空的 `versions/`。
    #[tokio::test]
    async fn a_refused_check_after_creating_the_game_dir_creates_no_instance() {
        for case in ["更高的号", "够不着"] {
            let tmp = tempfile::tempdir().unwrap();
            let petalfall = petalfall_at(tmp.path());
            let game_dir = petalfall.game_dir().to_owned();
            let instance = game_dir.join("versions").join("新实例");
            // 游戏目录建出来之后的每次核对都记下那时实例目录在不在。
            let seen: Arc<Mutex<Vec<bool>>> = Arc::default();
            let look: LookFn = {
                let (seen, instance) = (seen.clone(), instance.clone());
                Arc::new(move |dir: &Path| {
                    let look = if !dir.exists() {
                        DirLook::Absent
                    } else {
                        seen.lock().unwrap().push(instance.exists());
                        match case {
                            "更高的号" => DirLook::Stamp(parse_stamp(StampFile::Contents(
                                NEWER_STAMP.as_bytes(),
                            ))),
                            _ => DirLook::Unreachable(std::io::Error::from_raw_os_error(53)),
                        }
                    };
                    Box::pin(async move { look })
                })
            };

            let err = with_fixture(
                GuardFixture {
                    own: OWN,
                    look: Some(look),
                },
                petalfall.create_instance_dir("新实例", &request("1.21.1", None, None)),
            )
            .await
            .unwrap_err();

            match (case, err) {
                (
                    "更高的号",
                    CoreError::GameDirDataTooNew {
                        path,
                        found,
                        supported,
                        written_by,
                    },
                ) => {
                    assert_eq!(path, game_dir);
                    assert_eq!((found, supported), (3, OWN));
                    assert_eq!(written_by.as_deref(), Some("1.1.0-dev.57"));
                }
                ("够不着", CoreError::InvalidGameDirectory { path, problem }) => {
                    assert_eq!(path, game_dir);
                    assert_eq!(problem, GameDirProblem::Unavailable);
                }
                (case, other) => panic!("{case}：应拒绝新建，实际是 {other:?}"),
            }
            assert_eq!(
                *seen.lock().unwrap(),
                [false],
                "{case}：建好目录之后只核对一次，那时实例目录还不在"
            );
            assert_eq!(
                tree(tmp.path()),
                BTreeMap::from([
                    (PathBuf::from(".minecraft"), None),
                    (PathBuf::from(".minecraft").join("versions"), None),
                ]),
                "{case}"
            );
        }
    }

    use crate::instances::tests::disk_state;

    /// 补全、定方案、记结局、丢弃这几个入口在表里的名字；补全按两种方案各调一次。
    const WRITERS: [&str; 6] = [
        "abandon_instance",
        "settle_instance_marker",
        "begin_repair",
        "begin_loader_reinstall",
        "repair_instance 补齐",
        "repair_instance 重装",
    ];

    /// 等着补全的实例「待补全」：版本 JSON 只有一个从模拟端点下载的库，未完成标记记着当初的安装内容。各入口真走
    /// 下去都会改盘或发请求：删目录、清标记、写新标记、下载库与版本清单。返回写下的标记。
    async fn repairable_instance(petalfall: &Petalfall, base: &str) -> IncompleteMarker {
        let dir = write_version(
            petalfall.game_dir(),
            "待补全",
            &format!(
                r#"{{"id":"待补全","type":"release","mainClass":"m",
                    "libraries":[{{"name":"net.example:loader:0.16.10","url":"{base}/"}}]}}"#
            ),
        );
        let marker = IncompleteMarker::pending(
            IncompleteKind::Install {
                spec: request("1.21.1", None, None).spec(),
            },
            1_700_000_000_000,
        );
        MarkerStore::for_version_dir(&dir)
            .save(&marker)
            .await
            .unwrap();
        marker
    }

    async fn call_writer(
        petalfall: &Petalfall,
        entry: &str,
        marker: &IncompleteMarker,
    ) -> Result<()> {
        let id = "待补全";
        match entry {
            "abandon_instance" => petalfall.abandon_instance(id).await,
            "settle_instance_marker" => {
                petalfall
                    .settle_instance_marker(id, marker.clone(), MarkerSettlement::Succeeded)
                    .await
            }
            "begin_repair" => petalfall.begin_repair(id).await.map(drop),
            "begin_loader_reinstall" => petalfall.begin_loader_reinstall(id).await.map(drop),
            "repair_instance 补齐" => petalfall
                .repair_instance(id, &RepairPlan::Complete, None)
                .await
                .map(drop),
            "repair_instance 重装" => petalfall
                .repair_instance(
                    id,
                    &RepairPlan::Reinstall(request("1.21.1", None, None)),
                    None,
                )
                .await
                .map(drop),
            other => panic!("表里没有这个入口：{other}"),
        }
    }

    fn repair_petalfall(root: &Path, server: &MockServer) -> Petalfall {
        petalfall_at(root)
            .with_manifest_url(format!("{}/manifest.json", server.uri()))
            .with_fabric_base(server.uri())
    }

    /// 任务中心重试补全、旧列表上点补全时，游戏目录已被更新的落樱用过：每个入口都报游戏目录太新，一个请求都不发，
    /// 数据目录与游戏目录里的文件内容、修改时间都不变，没有多出文件。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn repair_entries_refuse_a_newer_game_dir_and_touch_nothing() {
        for entry in WRITERS {
            let server = MockServer::start().await;
            mock_meta(&server).await;
            let tmp = tempfile::tempdir().unwrap();
            let petalfall = repair_petalfall(tmp.path(), &server);
            let marker = repairable_instance(&petalfall, &server.uri()).await;
            put(&stamp_file(petalfall.game_dir()), NEWER_STAMP);
            let before = disk_state(tmp.path());

            let err = with_fixture(own(), call_writer(&petalfall, entry, &marker))
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
                    assert_eq!((found, supported), (3, OWN), "{entry}");
                    assert_eq!(written_by.as_deref(), Some("1.1.0-dev.57"), "{entry}");
                }
                other => panic!("{entry} 应报游戏目录太新，实际是 {other:?}"),
            }
            assert_eq!(disk_state(tmp.path()), before, "{entry}");
            assert_eq!(
                server.received_requests().await.unwrap().len(),
                0,
                "{entry}"
            );
        }
    }

    /// 不换本版号：记号读不懂与号是多少无关，生产的这条路同样在碰任何文件、发任何请求之前拦下。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn repair_entries_refuse_an_unreadable_stamp_and_touch_nothing() {
        for entry in ["begin_repair", "repair_instance 补齐"] {
            let server = MockServer::start().await;
            mock_meta(&server).await;
            let tmp = tempfile::tempdir().unwrap();
            let petalfall = repair_petalfall(tmp.path(), &server);
            let marker = repairable_instance(&petalfall, &server.uri()).await;
            put(&stamp_file(petalfall.game_dir()), r#"{"data_format":"3"}"#);
            let before = disk_state(tmp.path());

            let err = call_writer(&petalfall, entry, &marker).await.unwrap_err();

            assert!(
                matches!(&err, CoreError::DataFormatUnreadable { path, .. } if path == petalfall.game_dir()),
                "{entry}：{err:?}"
            );
            assert_eq!(disk_state(tmp.path()), before, "{entry}");
            assert_eq!(
                server.received_requests().await.unwrap().len(),
                0,
                "{entry}"
            );
        }
    }
}
