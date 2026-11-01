//! 按实例名新建实例，以及补全一个文件不全的实例。
//!
//! 新建分两步，中间由调用方登记任务：
//! 1. [`Aurora::create_instance_dir`]：校验名称、原子地建出 `versions/<名>/`（并发重名在这一步暴露），
//!    写下未完成标记；
//! 2. [`Aurora::install_instance`]：原版 JSON 与加载器 JSON 合并成一份以实例名为 id 的自洽 JSON，
//!    客户端 jar 与 natives 落在实例目录里，库与资源进共享目录。
//!
//! 结局由调用方记下：成功、失败经 [`Aurora::settle_instance_marker`]（成功删标记，失败记下错误码与原文，
//! 界面据此显示「安装没有完成」），取消则经 [`Aurora::abandon_instance`] 把整个目录丢掉。
//!
//! 补全先经 [`Aurora::begin_repair`] 看标记定方案：标记里记着当初的安装内容（安装没完成）就照着重装，
//! 否则按现有版本 JSON 补齐缺失的文件；版本 JSON 被删或写坏时照装好时留下的安装记录重装。

use std::collections::HashMap;
use std::time::{SystemTime, UNIX_EPOCH};

use aurora_install::{
    ForgeInstaller, LoaderFlavor, LoaderInstaller, VanillaInstaller, ensure_complete,
    forge_installer_url, merge_for_instance, neoforge_installer_url, write_instance_json,
};
use aurora_instance::{
    AURORA_META_DIR, IncompleteKind, IncompleteMarker, IncompleteOutcome, InstallRecordStore,
    InstallSpec, MarkerError, MarkerStore, NameViolation, VersionProbe, discover_versions,
    probe_version,
};
use aurora_version::{VersionJson, resolve};

use crate::InstanceError;
use crate::error::{CoreError, Result};
use crate::event::{CoreEvent, EventSink, emit};
use crate::facade::{Aurora, make_context};
use crate::install::LoaderChoice;
use crate::instances::{LEGACY_JAVA_MAJOR, broken_reason_text, inheritance_root};
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
            return Err(aurora_install::Error::LoaderVersionNotFound {
                loader: choice.display_name(),
                game_version: self.mc_version.clone(),
            }
            .into());
        }
        if let (Some(choice), Some(version)) = (self.loader, &self.loader_version) {
            aurora_version::check_path_segment(version).map_err(|problem| {
                aurora_install::Error::UnsafePath {
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
    /// 当初的安装没有完成：照记下的内容重装。
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

impl Aurora {
    /// 校验名称，原子地建出实例目录并写下未完成标记，返回写下的标记（结局时原样交回
    /// [`Aurora::settle_instance_marker`]）。目录已经存在（含并发新建的同名实例）报重名。
    pub async fn create_instance_dir(
        &self,
        name: &str,
        request: &InstanceRequest,
    ) -> Result<IncompleteMarker> {
        request.validate()?;
        self.check_new_instance_name(name).await?;
        let dir = self.instance_dir(name)?;
        let versions = self.layout().versions_dir();
        tokio::fs::create_dir_all(&versions)
            .await
            .map_err(|source| aurora_base::Error::Io {
                path: versions,
                source,
            })?;
        match tokio::fs::create_dir(&dir).await {
            Ok(()) => {}
            Err(err) if err.kind() == std::io::ErrorKind::AlreadyExists => {
                return Err(InstanceError::InvalidName {
                    name: name.to_owned(),
                    violation: NameViolation::Duplicate,
                }
                .into());
            }
            Err(source) => return Err(aurora_base::Error::Io { path: dir, source }.into()),
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
    pub async fn install_instance(
        &self,
        id: &str,
        request: &InstanceRequest,
        events: Option<&EventSink>,
    ) -> Result<InstanceInstallOutcome> {
        request.validate()?;
        let dir = self.existing_instance_dir(id).await?;
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
        );
        let mc = request.mc_version.as_str();

        emit(events, CoreEvent::stage(format!("查找原版 {mc}")));
        let vanilla_installer = VanillaInstaller::new(cx)
            .with_manifest_url(self.manifest_url())
            .with_sources(self.source_plan(self.config().version_list_source));
        let entry = vanilla_installer.find_entry(mc).await?;
        let staged = dir.join(AURORA_META_DIR).join(STAGED_VANILLA_JSON);
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
        let report = ensure_complete(cx, &merged, id).await?;
        tokio::fs::remove_file(&staged)
            .await
            .map_err(|source| aurora_base::Error::Io {
                path: staged.clone(),
                source,
            })?;
        // 放在版本 JSON 写好之后：要不要套看实例隔离不隔离，而隔离取决于版本类型（正式版还是快照），
        // 建目录那一刻还读不到。仍然在第一次启动之前，游戏还没来得及写出自己的默认设置。套失败让安装
        // 失败：重试经补全重装时会再套一次，标记里记着这次请求了套用。
        let template = if request.use_template {
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
    pub async fn abandon_instance(&self, id: &str) -> Result<()> {
        let dir = self.instance_dir(id)?;
        match tokio::fs::remove_dir_all(&dir).await {
            Ok(()) => {
                tracing::info!(id, "新建被取消，实例目录已删除");
                Ok(())
            }
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(source) => Err(aurora_base::Error::Io { path: dir, source }.into()),
        }
    }

    /// 把长任务的结局写进未完成标记。`marker` 是开始时写下的那份。
    pub async fn settle_instance_marker(
        &self,
        id: &str,
        marker: IncompleteMarker,
        settlement: MarkerSettlement,
    ) -> Result<()> {
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
    pub async fn begin_repair(&self, id: &str) -> Result<(RepairPlan, IncompleteMarker)> {
        let dir = self.existing_instance_dir(id).await?;
        let store = MarkerStore::for_version_dir(&dir);
        let previous = match store.load().await {
            Ok(previous) => previous,
            Err(err) => {
                tracing::warn!(id, error = %err, "未完成标记损坏，按现有版本 JSON 补全并覆盖标记");
                None
            }
        };
        let plan = match previous.map(|marker| marker.kind) {
            Some(IncompleteKind::Install { spec }) => {
                RepairPlan::Reinstall(InstanceRequest::from_spec(id, &spec)?)
            }
            // 导入写版本 JSON 在前、下载 Mod 与解出覆盖文件在后，中断时版本 JSON 往往已经可用；
            // 照它补全只会补齐库文件，再把标记清掉，缺的 Mod 与配置却补不回来，实例就被当成了完好的。
            Some(IncompleteKind::Modpack { .. }) => {
                return Err(InstanceError::NotRepairable {
                    id: id.to_owned(),
                    reason: "整合包没有导入完，缺的 Mod 与配置补不回来，请删掉这个实例后重新导入"
                        .to_owned(),
                }
                .into());
            }
            Some(IncompleteKind::Repair) | None => {
                match probe_version(self.game_dir(), id).await? {
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

    /// 按方案补全实例。
    pub async fn repair_instance(
        &self,
        id: &str,
        plan: &RepairPlan,
        events: Option<&EventSink>,
    ) -> Result<RepairOutcome> {
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
                let cx = make_context(
                    &http,
                    &pool,
                    &layout,
                    self.runtime(),
                    &policy,
                    self.cancel_token(),
                );
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
    use crate::instances::tests::{aurora_at, vanilla_json, write_version};

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
        let aurora = aurora_at(tmp.path())
            .with_manifest_url(format!("{}/manifest.json", server.uri()))
            .with_fabric_base(server.uri());
        let req = request("1.21.1", Some(LoaderChoice::Fabric), Some("0.16.10"));

        let marker = aurora.create_instance_dir("周末生存", &req).await.unwrap();
        let dir = aurora.game_dir().join("versions").join("周末生存");
        assert!(marker_path(&dir).is_file(), "安装开始前就写下标记");
        let outcome = aurora
            .install_instance("周末生存", &req, None)
            .await
            .unwrap();
        aurora
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
        assert!(!dir.join(AURORA_META_DIR).join(STAGED_VANILLA_JSON).exists());
        // versions/ 下只有这一个实例，没有多出原版或 fabric-loader-* 目录。
        assert_eq!(
            aurora.instance_names().await.unwrap(),
            vec!["周末生存".to_owned()]
        );
        let json: VersionJson =
            serde_json::from_slice(&std::fs::read(dir.join("周末生存.json")).unwrap()).unwrap();
        assert_eq!(json.id, "周末生存");
        assert_eq!(json.inherits_from, None);
        assert_eq!(json.client_version.as_deref(), Some("1.21.1"));
        assert_eq!(json.java_version.unwrap().major_version, 21);

        let list = aurora.list_instances().await.unwrap();
        let crate::instances::InstanceVersion::Ready(ready) = &list[0].version else {
            panic!("新实例应可用");
        };
        assert_eq!(ready.mc_version.as_deref(), Some("1.21.1"));
        assert_eq!(ready.loaders[0].kind, aurora_version::LoaderKind::Fabric);
        assert!(list[0].incomplete.is_none());
    }

    fn put_template(aurora: &Aurora, files: &[(&str, &[u8])]) {
        let dir = aurora.template_dir();
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
        let aurora = aurora_at(tmp.path())
            .with_manifest_url(format!("{}/manifest.json", server.uri()))
            .with_fabric_base(server.uri());
        let servers: Vec<u8> = (0..fastrand::usize(1..2048))
            .map(|_| fastrand::u8(..))
            .collect();
        put_template(
            &aurora,
            &[
                ("options.txt", b"fov:90\nrenderDistance:16"),
                ("servers.dat", &servers),
            ],
        );
        let req = InstanceRequest {
            use_template: true,
            ..request("1.21.1", Some(LoaderChoice::Fabric), Some("0.16.10"))
        };

        aurora.create_instance_dir("周末生存", &req).await.unwrap();
        let dir = aurora.game_dir().join("versions").join("周末生存");
        let stored = MarkerStore::for_version_dir(&dir)
            .load()
            .await
            .unwrap()
            .unwrap();
        assert_eq!(stored.kind, IncompleteKind::Install { spec: req.spec() });
        assert!(req.spec().use_template);
        let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
        let outcome = aurora
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
        aurora.create_instance_dir("不套", &plain).await.unwrap();
        let outcome = aurora.install_instance("不套", &plain, None).await.unwrap();
        assert_eq!(outcome.template, None);
        let other = aurora.game_dir().join("versions").join("不套");
        assert!(!other.join("options.txt").exists());
        assert!(!other.join("servers.dat").exists());
    }

    /// 原版正式版在默认档位下不隔离：版本 JSON 写好后才判得出来，判出来就不碰共用的根目录。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn template_is_skipped_for_an_instance_sharing_the_game_dir() {
        let server = MockServer::start().await;
        mock_meta(&server).await;
        let tmp = tempfile::tempdir().unwrap();
        let aurora =
            aurora_at(tmp.path()).with_manifest_url(format!("{}/manifest.json", server.uri()));
        put_template(&aurora, &[("options.txt", b"fov:90")]);
        std::fs::create_dir_all(aurora.game_dir()).unwrap();
        std::fs::write(aurora.game_dir().join("options.txt"), b"fov:70").unwrap();
        let req = InstanceRequest {
            use_template: true,
            ..request("1.21.1", None, None)
        };

        aurora.create_instance_dir("原版", &req).await.unwrap();
        let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
        let outcome = aurora
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
            std::fs::read(aurora.game_dir().join("options.txt")).unwrap(),
            b"fov:70"
        );
        let dir = aurora.game_dir().join("versions").join("原版");
        assert!(!dir.join("options.txt").exists());
        assert!(
            stages(rx).iter().any(
                |s| s == "没有沿用默认设置：这个实例与其他未隔离的实例共用 .minecraft 里的设置"
            ),
        );
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
        let aurora = aurora_at(tmp.path());
        let dir = write_version(aurora.game_dir(), "Survival", &vanilla_json("1.21.1"));
        let err = aurora
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

        let err = aurora
            .create_instance_dir("x", &request("1.21.1", Some(LoaderChoice::Forge), None))
            .await
            .unwrap_err();
        assert!(matches!(
            err,
            CoreError::Install(aurora_install::Error::LoaderVersionNotFound { .. })
        ));
        assert!(!aurora.game_dir().join("versions").join("x").exists());
    }

    /// 同名旧实例在启动器之外（资源管理器、共用游戏目录的别的启动器）被删掉后，它的游玩记录还在；新建的
    /// 同名实例从零算起。撞名失败时不动已有实例的记录，别的实例与别的游戏目录的记录也不动。
    #[tokio::test]
    async fn new_instance_does_not_inherit_records_of_a_vanished_namesake() {
        let tmp = tempfile::tempdir().unwrap();
        let aurora = aurora_at(tmp.path());
        let other = tmp.path().join("HMCL").join(".minecraft");
        let hour = 3_600_000;
        for (game_dir, id) in [
            (aurora.game_dir(), "周末生存"),
            (aurora.game_dir(), "Survival"),
            (aurora.game_dir(), "别的"),
            (other.as_path(), "周末生存"),
        ] {
            crate::playtime::record_play(tmp.path(), game_dir, id, 0, hour)
                .await
                .unwrap();
        }
        write_version(aurora.game_dir(), "Survival", &vanilla_json("1.21.1"));

        aurora
            .create_instance_dir("survival", &request("1.21.1", None, None))
            .await
            .unwrap_err();
        aurora
            .create_instance_dir("周末生存", &request("1.21.1", None, None))
            .await
            .unwrap();

        let summaries = aurora.play_summaries().await.unwrap();
        assert_eq!(
            summaries.keys().collect::<Vec<_>>(),
            vec!["Survival", "别的"]
        );
        assert_eq!(summaries["Survival"].playtime_min, 60);
        let elsewhere = Aurora::for_test(
            crate::config::AuroraConfig::default(),
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
        let aurora = aurora_at(tmp.path())
            .with_manifest_url(format!("{}/manifest.json", server.uri()))
            .with_fabric_base(server.uri());
        // 不存在的 loader 版本：meta 404，安装失败。
        let bad = request("1.21.1", Some(LoaderChoice::Fabric), Some("9.9.9"));
        let marker = aurora.create_instance_dir("半成品", &bad).await.unwrap();
        let err = aurora
            .install_instance("半成品", &bad, None)
            .await
            .unwrap_err();
        aurora
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

        let dir = aurora.game_dir().join("versions").join("半成品");
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
        let (plan, marker) = aurora.begin_repair("半成品").await.unwrap();
        assert_eq!(plan, RepairPlan::Reinstall(good));
        assert_eq!(marker.outcome, IncompleteOutcome::Pending);
        let outcome = aurora.repair_instance("半成品", &plan, None).await.unwrap();
        assert!(outcome.reinstalled);
        aurora
            .settle_instance_marker("半成品", marker, MarkerSettlement::Succeeded)
            .await
            .unwrap();
        assert!(!marker_path(&dir).exists(), "修复成功后标记清掉");
        assert!(dir.join("半成品.json").is_file());
    }

    #[tokio::test]
    async fn repair_of_a_complete_instance_writes_then_clears_a_repair_marker() {
        let tmp = tempfile::tempdir().unwrap();
        let aurora = aurora_at(tmp.path());
        let dir = write_version(
            aurora.game_dir(),
            "1.21.1",
            r#"{"id":"1.21.1","type":"release","mainClass":"M"}"#,
        );
        let (plan, marker) = aurora.begin_repair("1.21.1").await.unwrap();
        assert_eq!(plan, RepairPlan::Complete);
        let on_disk = MarkerStore::for_version_dir(&dir)
            .load()
            .await
            .unwrap()
            .unwrap();
        assert_eq!(on_disk.kind, IncompleteKind::Repair);
        assert_eq!(on_disk.outcome, IncompleteOutcome::Pending);

        let outcome = aurora.repair_instance("1.21.1", &plan, None).await.unwrap();
        assert!(!outcome.reinstalled);
        assert_eq!(outcome.libraries, 0);
        aurora
            .settle_instance_marker("1.21.1", marker.clone(), MarkerSettlement::Succeeded)
            .await
            .unwrap();
        assert!(!marker_path(&dir).exists());

        // 被取消时标记留下并记为 cancelled。
        aurora
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
        let aurora = aurora_at(tmp.path())
            .with_manifest_url(format!("{}/manifest.json", server.uri()))
            .with_fabric_base(server.uri());
        let id = "周末生存";
        let req = request("1.21.1", Some(LoaderChoice::Fabric), Some("0.16.10"));
        let marker = aurora.create_instance_dir(id, &req).await.unwrap();
        aurora.install_instance(id, &req, None).await.unwrap();
        aurora
            .settle_instance_marker(id, marker, MarkerSettlement::Succeeded)
            .await
            .unwrap();
        let dir = aurora.game_dir().join("versions").join(id);
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
            let (plan, marker) = aurora.begin_repair(id).await.unwrap();
            assert_eq!(plan, RepairPlan::Reinstall(req.clone()));
            assert!(matches!(marker.kind, IncompleteKind::Install { .. }));
            let outcome = aurora.repair_instance(id, &plan, None).await.unwrap();
            assert!(outcome.reinstalled);
            aurora
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
        let aurora = aurora_at(tmp.path())
            .with_manifest_url(format!("{}/manifest.json", server.uri()))
            .with_fabric_base(server.uri());
        let req = InstanceRequest {
            use_template: true,
            ..request("1.21.1", Some(LoaderChoice::Fabric), None)
        };
        aurora.create_instance_dir("推荐版", &req).await.unwrap();
        aurora.install_instance("推荐版", &req, None).await.unwrap();
        let dir = aurora.game_dir().join("versions").join("推荐版");
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
        let aurora = aurora_at(tmp.path());
        let dir = write_version(aurora.game_dir(), "整合包", &vanilla_json("1.21.1"));
        let store = MarkerStore::for_version_dir(&dir);
        let marker = IncompleteMarker::pending(
            IncompleteKind::Modpack {
                task_id: "mp#1".into(),
            },
            1_700_000_000_000,
        );
        store.save(&marker).await.unwrap();

        let err = aurora.begin_repair("整合包").await.unwrap_err();
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
        let aurora = aurora_at(tmp.path());
        std::fs::create_dir_all(aurora.game_dir().join("versions").join("空的")).unwrap();
        let err = aurora.begin_repair("空的").await.unwrap_err();
        assert!(
            matches!(
                err,
                CoreError::Instance(InstanceError::NotRepairable { .. })
            ),
            "实际：{err:?}"
        );
    }

    #[tokio::test]
    async fn abandon_removes_the_directory_and_is_idempotent() {
        let tmp = tempfile::tempdir().unwrap();
        let aurora = aurora_at(tmp.path());
        let dir = write_version(aurora.game_dir(), "临时", &vanilla_json("1.21.1"));
        aurora.abandon_instance("临时").await.unwrap();
        assert!(!dir.exists());
        aurora.abandon_instance("临时").await.unwrap();
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
                aurora_version::UnsafePath::Backslash,
            ),
            (
                LoaderChoice::NeoForge,
                "21.1.42/../x",
                aurora_version::UnsafePath::Separator,
            ),
            (
                LoaderChoice::Fabric,
                "..",
                aurora_version::UnsafePath::DotSegment,
            ),
        ] {
            let request = InstanceRequest {
                mc_version: "1.20.1".into(),
                loader: Some(choice),
                loader_version: Some(version.into()),
                use_template: false,
            };
            match request.validate() {
                Err(CoreError::Install(aurora_install::Error::UnsafePath {
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
}
