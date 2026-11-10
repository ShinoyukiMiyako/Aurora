//! 前端命令：把契约里的命令接到各模块。判定都在模块里，这里只管线程、这次启动要记住的东西，以及装之前的复核。
//!
//! 不带 `async` 的命令跑在窗口线程上。碰盘、等进程的活都走 [`on_worker`]，否则窗口会跟着卡住。
//! 拒绝一律是字符串：前端把它们当意外，进致命错误页显示原文。`install` 另有一种 [`Failure`]，是安装本身的结果，
//! 前端进失败页。`install` 开工之前后端还要复核一遍：模式不在探测允许的集合里、或数据此刻过不了数据格式关时，
//! 同样以字符串拒绝。装回较早的版本与数据比安装包新这两件事不能只靠前端的状态机拦。

use std::error::Error;
use std::ffi::{OsStr, OsString};
use std::fmt::Display;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, PoisonError};

use petalfall_release::data_format::{DATA_FORMAT, StampVerdict};
use petalfall_release::install_policy::{
    self, ChannelRelation, Initiation, KindJudgment, channel_of,
};
use petalfall_release::order;
use semver::Version;
use tauri::ipc::InvokeError;
use tauri::{AppHandle, Emitter, State, WebviewWindow};

use crate::boot::{self, Instance, Notice, Older};
use crate::cli::{Launch, UpdateRequest};
use crate::contract::{
    Channel, DirCheck, Existing, ExistingKind, Failure, InstallMode, InstallPlan, NewerReason,
    PROGRESS_EVENT, Probe, Progress, UpdateLaunch,
};
use crate::datamark::{self, DataGate};
use crate::existing::{self, Installation, Registry};
use crate::journal::{self, Recovery};
use crate::launcher::Opened;
use crate::log::SetupLog;
use crate::runner::{Handoff, Reporter, Session, StandardRun, Target};
use crate::target::{self, APP_FOLDER, SpaceNeed, SystemEnv, TargetEnv};

/// 探测时认定、之后的命令还要用的东西。
#[derive(Debug, Default)]
struct Located {
    /// 升级、修复和换通道的目录，前端的计划里不带。
    registered: Option<String>,
    /// 已知属于落樱的目录，校验时不能当成别人的：默认目录（启动器回落的数据目录），以及探测换上的半装记录或卸载残留。
    own: Vec<String>,
    /// 探测判下的允许模式。还没探测过时为空，什么都不许装。
    allowed: Vec<InstallMode>,
    /// 用户在页面上确认安装时要写的交接记录，只有交互的第 2a、5 行有。
    handoff: Option<Handoff>,
    /// 探测时数据格式关读过的根；没有登记安装时为空。
    data_roots: Vec<PathBuf>,
}

/// 窗口存活期间共用的东西，也是 `main.rs` 里 `manage` 进去的状态。
pub struct SetupContext {
    session: Session,
    instance: Arc<Instance>,
    log: Arc<SetupLog>,
    launch: Launch,
    /// 判定表看的发起方式，由 `launch` 与换通道开关折成。
    initiation: Initiation,
    /// `%LOCALAPPDATA%`：默认安装目录在它下面，登记目录写不进时启动器也落到它下面的数据根。
    local_app_data: PathBuf,
    located: Mutex<Located>,
    /// 用户选了原生向导，或窗口起不来时的退路。窗口关掉后进程还要等它退出：临时文件要靠守卫句柄钉到那时。
    wizard: Mutex<Option<StandardRun>>,
    /// F5 和右键菜单的刷新是 WebView2 自带的：页面一重载，进度和关窗拦截都没了，载荷却还在写。
    installing: AtomicBool,
}

impl SetupContext {
    pub fn new(
        session: Session,
        instance: Arc<Instance>,
        log: Arc<SetupLog>,
        launch: Launch,
        channel_switch: bool,
        local_app_data: PathBuf,
    ) -> Self {
        let initiation = initiation_of(&launch, channel_switch);
        Self {
            session,
            instance,
            log,
            launch,
            initiation,
            local_app_data,
            located: Mutex::default(),
            wizard: Mutex::default(),
            installing: AtomicBool::new(false),
        }
    }

    fn need(&self) -> SpaceNeed {
        let header = self.session.header();
        SpaceNeed::for_payload(header.payload_len, header.exe_len)
    }

    fn sweep_temp(&self) {
        match self.session.sweep() {
            Ok(sweep) => {
                for path in &sweep.removed {
                    self.log
                        .info(format_args!("清掉了残留的临时目录：{}", path.display()));
                }
                for (path, err) in &sweep.skipped {
                    self.log
                        .warn(format_args!("残留目录这次没清掉 {}：{err}", path.display()));
                }
            }
            // 残留只占点空间，下次启动还会再扫
            Err(err) => self.log.warn(format_args!("清扫临时目录失败：{err}")),
        }
    }

    fn note_recovery(&self, recovery: &Recovery) {
        match recovery {
            Recovery::Clean => {}
            Recovery::Completed => self.log.info("上次的安装其实已经完成，半装记录已删"),
            Recovery::Interrupted {
                journal,
                mismatches,
            } => {
                let found: Vec<String> = mismatches.iter().map(ToString::to_string).collect();
                self.log.warn(format_args!(
                    "上次的安装没有完成：{}，{}",
                    journal.instdir.display(),
                    found.join("；")
                ));
            }
            Recovery::Discarded { reason } => {
                self.log
                    .warn(format_args!("半装记录读不懂，已删：{reason}"));
            }
        }
    }

    /// 数据格式关拦下用户时，日志里要查得到读了哪几个根、哪个记号定的结论，以及为什么连回落的数据根也读了。
    fn note_gate(&self, when: &str, gate: &DataGate) {
        self.log.info(format_args!(
            "{when}的数据格式关：读了 {:?}，定下结论的记号 {}，结论 {:?}",
            gate.roots,
            gate.stamp.display(),
            gate.verdict
        ));
        if let Some(reason) = &gate.fallback_reason {
            self.log.warn(format_args!(
                "{when}时登记目录的探针没过，回落的数据根也读了：{reason}"
            ));
        }
    }

    /// 带了换通道开关、这次却不是无人值守的换通道安装：照判定表处理，开关只在日志里记一笔。
    fn note_switch(&self, probe: &Probe) {
        if self.initiation != Initiation::UpdateWithSwitch
            || probe.unattended == Some(InstallMode::Switch)
        {
            return;
        }
        if probe.newer_reason == Some(NewerReason::SameChannel) {
            self.log.warn("带了换通道开关，同通道不放行");
            return;
        }
        self.log.warn(format_args!(
            "带了换通道开关，这次不是换到更慢通道的安装，开关不起作用：种类 {:?}，数据格式关 {:?}",
            probe.existing.as_ref().map(|existing| existing.kind),
            probe.data_block.as_ref().map(|block| block.problem)
        ));
    }

    pub fn probe(&self) -> io::Result<Probe> {
        self.sweep_temp();
        let recovery = self.session.recover()?;
        self.note_recovery(&recovery);

        let default_dir = self
            .local_app_data
            .join(APP_FOLDER)
            .to_string_lossy()
            .into_owned();
        let started = Started {
            update: self.launch.update().map(UpdateRequest::launch_info),
            initiation: self.initiation,
            elevated: boot::is_elevated()?,
        };
        let Assembled {
            probe,
            relation,
            gate,
            handoff,
        } = assemble_probe(
            self.session.registry(),
            &self.local_app_data,
            &self.session.header().version,
            self.need().target,
            default_dir.clone(),
            recovery,
            started,
        )?;
        self.log.info(format_args!(
            "判定：发起方式 {:?}，两边的通道 {relation:?}",
            self.initiation
        ));
        match &gate {
            Some(gate) => self.note_gate("探测", gate),
            None => self
                .log
                .info("没有登记安装，探测时不读数据格式记号，首装的目标目录在安装前复核"),
        }
        self.note_switch(&probe);
        self.log.info(format_args!("探测结果：{probe:?}"));

        *self.located.lock().unwrap_or_else(PoisonError::into_inner) = Located {
            registered: probe.existing.as_ref().map(|existing| existing.dir.clone()),
            own: own_dirs(default_dir, &probe),
            allowed: probe.allowed_modes.clone(),
            handoff,
            data_roots: gate.map_or_else(Vec::new, |gate| gate.roots),
        };
        Ok(probe)
    }

    pub fn check_dir(&self, path: &str, env: &dyn TargetEnv) -> DirCheck {
        let own = self
            .located
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .own
            .clone();
        let own: Vec<&str> = own.iter().map(String::as_str).collect();
        target::check_dir(path, self.need(), &own, env)
    }

    pub fn launcher_running(&self) -> io::Result<bool> {
        self.session.launcher_running()
    }

    /// 窗口此刻能不能换页。
    pub fn allows_navigation(&self) -> bool {
        !self.installing.load(Ordering::Acquire)
    }

    /// 安装前由后端再核一次，tauri 命令 `install` 过了它才开工。前端发来的模式要在探测允许的集合里；数据此刻也要
    /// 过得了数据格式关：探测之后用户可能先打开过已装的落樱，记号被它抬高；首装的最终目录也是这时才定。
    /// 没过时返回原因，什么都还没开始：不写交接记录、不写半装记录、不启动载荷。
    pub fn review_plan(&self, plan: &InstallPlan) -> Result<(), String> {
        let (allowed, registered, probed_roots) = {
            let located = self.located.lock().unwrap_or_else(PoisonError::into_inner);
            (
                located.allowed.clone(),
                located.registered.clone(),
                located.data_roots.clone(),
            )
        };
        let refuse = |reason: String| -> Result<(), String> {
            self.log
                .warn(format_args!("安装前复核没过，不装：{reason}"));
            Err(reason)
        };
        if !allowed.contains(&plan.mode) {
            return refuse(format!(
                "探测允许的安装方式是 {allowed:?}，收到的是 {:?}",
                plan.mode
            ));
        }
        let gate = match plan.mode {
            InstallMode::Fresh => match plan.dir.as_deref() {
                Some(dir) => datamark::inspect_target(Path::new(dir), DATA_FORMAT),
                None => return refuse("首装的计划里没有目录".to_owned()),
            },
            InstallMode::Upgrade | InstallMode::Repair | InstallMode::Switch => {
                match registered.as_deref() {
                    Some(dir) => datamark::inspect_installed(
                        Path::new(dir),
                        &self.local_app_data,
                        DATA_FORMAT,
                    ),
                    None => return refuse(format!("{:?} 安装没有登记目录", plan.mode)),
                }
            }
        };
        self.log.info(format_args!(
            "安装前复核 {:?}：探测时数据格式关读过 {probed_roots:?}",
            plan.mode
        ));
        self.note_gate("安装前复核", &gate);
        match gate.block {
            Some(block) => refuse(format!("数据格式关没过：{block:?}")),
            None => Ok(()),
        }
    }

    /// tauri 命令 `install` 在工作线程上做的全部：先 [`Self::review_plan`]，过了才 [`Self::install`]。
    /// 外层的 `Err` 是复核没过，什么都没开始；里层是安装本身的结果。
    pub fn reviewed_install(
        &self,
        plan: &InstallPlan,
        reporter: &dyn Reporter,
    ) -> Result<Result<(), Failure>, String> {
        self.review_plan(plan)?;
        Ok(self.install(plan, reporter))
    }

    /// 按计划装，不复核：窗口里的安装走 [`Self::reviewed_install`]。探测记下交接记录时（用户在「换到」页上确认），
    /// 它先于半装记录落盘；失败页「重试」按同一计划再来，会覆盖重写。
    pub fn install(&self, plan: &InstallPlan, reporter: &dyn Reporter) -> Result<(), Failure> {
        let (registered, handoff) = {
            let located = self.located.lock().unwrap_or_else(PoisonError::into_inner);
            (located.registered.clone(), located.handoff.clone())
        };
        let target = Target::from_plan(plan, registered.as_deref())?;
        self.log
            .info(format_args!("开始安装：{target:?}，交接记录：{handoff:?}"));
        self.installing.store(true, Ordering::Release);
        let outcome = self
            .session
            .install_with_handoff(&target, handoff.as_ref(), reporter);
        self.installing.store(false, Ordering::Release);
        outcome
    }

    /// 更新模式把启动器被更新前带着的参数还给它，不论前端是自动打开还是用户在完成页上点的。
    pub fn open_launcher(&self, dir: &Path) -> io::Result<Opened> {
        let args: &[OsString] = match &self.launch {
            Launch::Interactive => &[],
            Launch::Update(request) => &request.launcher_args,
        };
        let opened = self.session.open_launcher(dir, args, &self.instance)?;
        self.log
            .info(format_args!("打开启动器，参数 {args:?}：{opened:?}"));
        Ok(opened)
    }

    /// 启动原生向导，不等它结束：调用方随后关窗。要等结束时用 [`Self::wait_for_wizard`]。
    /// 失败页上的按钮走这里，更新模式也不带插件那串参数：用户点它是要自己在向导里选。
    ///
    /// 向导里装什么由 NSIS 自己定，不再经过复核，所以先拒两种，都以字符串拒绝：探测允许的模式里没有首装、升级、
    /// 修复（只允许换通道或什么都不允许）；此刻再判一次，结论不让交给 NSIS（例如探测之后数据被更新的版本用过）。
    pub fn start_wizard(&self) -> Result<(), String> {
        let allowed = self
            .located
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .allowed
            .clone();
        let refuse = |reason: String| -> Result<(), String> {
            self.log
                .warn(format_args!("不能改用标准安装程序：{reason}"));
            Err(reason)
        };
        if !allowed.iter().copied().any(standard_mode) {
            return refuse(format!("探测允许的安装方式是 {allowed:?}"));
        }
        if let Standard::Refused { notice, .. } =
            self.judge_standard().map_err(|err| err.to_string())?
        {
            return refuse(format!("{notice:?}"));
        }
        self.start_standard(OsStr::new(""))
            .map_err(|failure| failure.to_string())
    }

    /// 窗口起不来时的退路。判定能装的交给 NSIS 并等它退出，参数见 [`fallback_arguments`]；不能装的用 `alert`
    /// 弹对话框说明，不交给 NSIS，更新模式下用户关掉对话框后按原参数重开登记目录里的启动器。
    pub fn fall_back(&self, alert: impl FnOnce(&Notice)) -> Result<FallenBack, Box<dyn Error>> {
        match self.judge_standard()? {
            Standard::Allowed => {
                self.start_standard(&fallback_arguments(&self.launch))?;
                let code = self
                    .wait_for_wizard()?
                    .expect("刚启动的原生向导还没有人等过");
                Ok(FallenBack::Ran(code))
            }
            Standard::Refused { notice, reopen } => {
                self.log.warn(format_args!("不交给 NSIS：{notice:?}"));
                alert(&notice);
                if let Some(dir) = reopen {
                    self.open_launcher(&dir)?;
                }
                Ok(FallenBack::Refused)
            }
        }
    }

    /// 不经窗口里的页面、直接交给 NSIS 之前的判定，判定表与探测同一套。不做半装恢复：恢复要等载荷进程、删记录，
    /// 这条路上不做。首装的目录要在 NSIS 向导里才定，数据格式关按默认目录判，卸载留下的目录优先；用户在向导里
    /// 另选了目录的，由启动器启动时那一关兜底。
    fn judge_standard(&self) -> io::Result<Standard> {
        let payload = self.session.header().version.clone();
        let registry = self.session.registry();
        let (found, judged) = judge_installed(registry, &payload, self.initiation)?;
        let gate = match &found {
            Some(found) => datamark::inspect_installed(
                Path::new(&found.dir),
                &self.local_app_data,
                DATA_FORMAT,
            ),
            None => {
                let default_dir = match existing::leftover_dir(registry)? {
                    Some(dir) => PathBuf::from(dir),
                    None => self.local_app_data.join(APP_FOLDER),
                };
                datamark::inspect_target(&default_dir, DATA_FORMAT)
            }
        };
        self.log.info(format_args!(
            "交给 NSIS 之前的判定：发起方式 {:?}，种类 {:?}，两边的通道 {:?}，newer 的原因 {:?}",
            self.initiation, judged.kind, judged.relation, judged.newer_reason
        ));
        self.note_gate("交给 NSIS 之前", &gate);
        let modes = install_policy::judge_modes(
            judged.kind,
            judged.relation,
            &gate.verdict,
            self.initiation,
        );
        // 更新模式下启动器是为这次安装关掉的，不装也要把它开回来；程序文件不在就没有可开的
        let reopen = found
            .as_ref()
            .filter(|found| found.program_intact && self.launch.update().is_some())
            .map(|found| PathBuf::from(&found.dir));
        let reopens = reopen.is_some();
        let notice = match (modes.data_block, judged.kind, found) {
            (Some(block), ..) => Notice::DataBlocked {
                block,
                stamp: gate.stamp.to_string_lossy().into_owned(),
                payload,
                reopens,
            },
            (
                None,
                None
                | Some(
                    install_policy::ExistingKind::Upgrade
                    | install_policy::ExistingKind::Same
                    | install_policy::ExistingKind::Broken,
                ),
                _,
            ) => return Ok(Standard::Allowed),
            (None, Some(install_policy::ExistingKind::Switch), _) => {
                Notice::NeedsWindow { reopens }
            }
            (
                None,
                Some(install_policy::ExistingKind::Newer),
                Some(Installation {
                    version: Some(installed),
                    ..
                }),
            ) => Notice::Newer {
                older: older_of(
                    judged.newer_reason,
                    channel_of(&installed),
                    channel_of(&payload),
                ),
                installed,
                payload,
                reopens,
            },
            (None, Some(install_policy::ExistingKind::Newer), _) => {
                unreachable!("newer 只出自卸载项里有版本的安装")
            }
        };
        Ok(Standard::Refused { notice, reopen })
    }

    fn start_standard(&self, arguments: &OsStr) -> Result<(), Failure> {
        let wizard = self.session.start_standard(arguments)?;
        self.log.info(format_args!(
            "原生向导已启动，pid {}，参数 {arguments:?}",
            wizard.pid()
        ));
        *self.wizard.lock().unwrap_or_else(PoisonError::into_inner) = Some(wizard);
        Ok(())
    }

    /// 等原生向导退出并清掉临时文件，返回它的退出码。没有启动过向导时是 `None`。
    pub fn wait_for_wizard(&self) -> io::Result<Option<i32>> {
        let wizard = self
            .wizard
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .take();
        let Some(wizard) = wizard else {
            return Ok(None);
        };
        let code = wizard.wait_and_clean(self.log.as_ref())?;
        self.log.info(format_args!("原生向导已退出：{code}"));
        Ok(Some(code))
    }
}

/// 窗口起不来时的结局。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FallenBack {
    /// NSIS 跑完了，带它的退出码。
    Ran(i32),
    /// 判定不能装，对话框说明过，没有拉起 NSIS。
    Refused,
}

/// 直接交给 NSIS 之前的判定结论。
#[derive(Debug)]
enum Standard {
    Allowed,
    /// 不能交给 NSIS：用这个对话框说明；`reopen` 有值时随后重开那里的启动器。
    Refused {
        notice: Notice,
        reopen: Option<PathBuf>,
    },
}

/// NSIS 自己的安装流程装得了的模式。换通道只走窗口里的流程。
fn standard_mode(mode: InstallMode) -> bool {
    match mode {
        InstallMode::Fresh | InstallMode::Upgrade | InstallMode::Repair => true,
        InstallMode::Switch => false,
    }
}

/// newer 的原因连同两边的通道，交给对话框挑说明。判定表给出 newer 时一定带原因，分出快慢时两边的通道都认得。
fn older_of(
    reason: Option<install_policy::NewerReason>,
    installed: Option<order::Channel>,
    payload: Option<order::Channel>,
) -> Older {
    use install_policy::NewerReason as Reason;
    match (reason, installed, payload) {
        (Some(Reason::SameChannel), ..) => Older::SameChannel,
        (Some(Reason::UnknownChannel), ..) => Older::UnknownChannel,
        (Some(Reason::FasterChannel), Some(installed), Some(payload)) => {
            Older::FasterChannel { installed, payload }
        }
        (Some(Reason::SlowerChannel), Some(installed), Some(payload)) => {
            Older::SlowerChannel { installed, payload }
        }
        (reason, installed, payload) => unreachable!(
            "判定表给出的 newer 与两边的通道对不上：{reason:?}，{installed:?}，{payload:?}"
        ),
    }
}

/// 命令行折成判定表的发起方式。换通道开关只在更新模式下解析得出来，交互启动时它总是假。
fn initiation_of(launch: &Launch, channel_switch: bool) -> Initiation {
    match (launch, channel_switch) {
        (Launch::Interactive, _) => Initiation::Interactive,
        (Launch::Update(_), false) => Initiation::Update,
        (Launch::Update(_), true) => Initiation::UpdateWithSwitch,
    }
}

/// 这次是怎么被拉起的。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Started {
    /// 交给界面的那一半，交互启动时为 `None`。
    update: Option<UpdateLaunch>,
    /// 判定用的那一半，换通道开关只体现在这里。
    initiation: Initiation,
    elevated: bool,
}

/// 探测折出来的东西：交给界面的探测结果，以及只进日志的判定细节。
#[derive(Debug)]
struct Assembled {
    probe: Probe,
    relation: ChannelRelation,
    /// 有登记安装时数据格式关读过的根与结论；没有时为 `None`，首装的最终目录要到安装前复核时才读。
    gate: Option<DataGate>,
    /// 用户在页面上确认安装时要写的交接记录。
    handoff: Option<Handoff>,
}

/// 交接记录记下安装包的通道与版本。判定表只在两边的通道都认得时才要写它，安装包的通道认得，版本就一定解析得了。
fn handoff_of(payload_version: &str) -> Handoff {
    Handoff {
        channel: channel_of(payload_version).expect("判定表只在安装包的通道认得时要写交接记录"),
        version: Version::parse(payload_version).expect("认得通道的版本一定解析得了"),
    }
}

/// 现有安装的事实与种类，探测和直接交给 NSIS 之前的判定共用：先读事实，再按版本、通道与发起方式定种类。
fn judge_installed(
    registry: &dyn Registry,
    payload_version: &str,
    initiation: Initiation,
) -> io::Result<(Option<Installation>, KindJudgment)> {
    let found = existing::read_installation(registry)?;
    let judged = install_policy::judge_kind(
        found.as_ref().map(Installation::as_installed),
        payload_version,
        initiation,
    );
    Ok((found, judged))
}

/// 带上判出的种类交给界面。判定表只在有安装时给种类，两边对不上说明接错了线。
fn existing_of(
    found: Option<Installation>,
    kind: Option<install_policy::ExistingKind>,
) -> Option<Existing> {
    match (found, kind) {
        (Some(found), Some(kind)) => Some(found.into_existing(kind.into())),
        (None, None) => None,
        (found, kind) => unreachable!("判定表只在有安装时给种类：{found:?}，{kind:?}"),
    }
}

/// 半装恢复改的是交给界面的种类，后面的模式判定要拿回判定表自己的类型。
fn policy_kind(kind: ExistingKind) -> install_policy::ExistingKind {
    match kind {
        ExistingKind::Upgrade => install_policy::ExistingKind::Upgrade,
        ExistingKind::Same => install_policy::ExistingKind::Same,
        ExistingKind::Newer => install_policy::ExistingKind::Newer,
        ExistingKind::Broken => install_policy::ExistingKind::Broken,
        ExistingKind::Switch => install_policy::ExistingKind::Switch,
    }
}

/// 把这台电脑的现状折成探测结果。顺序不能换：种类先按版本、通道与发起方式定下，半装记录再盖在它之上；
/// 数据格式关看恢复之后仍登记着的安装；允许的模式、无人值守的模式与要不要写交接记录都按恢复之后的种类算，
/// 被改成 broken 的那次只能「重新安装」，不再是「换到」页，也就不写交接记录。
fn assemble_probe(
    registry: &dyn Registry,
    local_app_data: &Path,
    payload_version: &str,
    required_bytes: u64,
    default_dir: String,
    recovery: Recovery,
    started: Started,
) -> io::Result<Assembled> {
    let (found, judged) = judge_installed(registry, payload_version, started.initiation)?;
    let existing = existing_of(found, judged.kind);
    let leftover = match existing {
        Some(_) => None,
        None => existing::leftover_dir(registry)?,
    };
    let probe = Probe {
        payload_version: payload_version.to_owned(),
        payload_channel: channel_of(payload_version).map(Channel::from),
        default_dir: leftover.unwrap_or(default_dir),
        required_bytes,
        existing,
        interrupted: false,
        elevated: started.elevated,
        update: started.update,
        newer_reason: judged.newer_reason.map(NewerReason::from),
        // 半装恢复可能改掉种类，模式相关的几项等它和数据格式关都定了再填
        allowed_modes: Vec::new(),
        unattended: None,
        handoff: false,
        data_block: None,
    };
    let probe = match recovery {
        Recovery::Interrupted { journal, .. } => journal::mark_interrupted(probe, &journal),
        Recovery::Clean | Recovery::Completed | Recovery::Discarded { .. } => probe,
    };
    let gate = probe.existing.as_ref().map(|existing| {
        datamark::inspect_installed(Path::new(&existing.dir), local_app_data, DATA_FORMAT)
    });
    // 首装的最终目录要到选目录时才定，这里放行；选目录与安装前复核在那个目录上把关
    let verdict = match &gate {
        Some(gate) => gate.verdict.clone(),
        None => StampVerdict::Pass,
    };
    let kind = probe
        .existing
        .as_ref()
        .map(|existing| policy_kind(existing.kind));
    let modes = install_policy::judge_modes(kind, judged.relation, &verdict, started.initiation);
    let data_block = gate.as_ref().and_then(|gate| gate.block.clone());
    Ok(Assembled {
        probe: Probe {
            allowed_modes: modes
                .allowed_modes
                .into_iter()
                .map(InstallMode::from)
                .collect(),
            unattended: modes.unattended.map(InstallMode::from),
            handoff: modes.handoff,
            data_block,
            ..probe
        },
        relation: judged.relation,
        gate,
        handoff: modes.handoff.then(|| handoff_of(payload_version)),
    })
}

/// 窗口起不来时交给 NSIS 的参数。更新模式的开关和插件默认 passive 带的一样，顺序沿用 2.10.1（见 cli.rs 的
/// passive_arguments），NSIS 包走它自己的更新流程，也就是引导程序接管更新之前的行为；交互模式是无参的原生向导。
fn fallback_arguments(launch: &Launch) -> OsString {
    match launch {
        Launch::Interactive => OsString::new(),
        Launch::Update(request) => request.passive_arguments(),
    }
}

/// 校验时认作落樱自己的目录。默认目录同时是启动器写不进 exe 旁边时的数据目录：没写过 config.json 之前
/// 里面只有日志、缓存和任务记录，当成别人的就会劝用户换文件夹，装到别处后启动器走便携，这份数据就成了孤儿。
fn own_dirs(data_home: String, probe: &Probe) -> Vec<String> {
    if probe.default_dir == data_home {
        vec![data_home]
    } else {
        vec![data_home, probe.default_dir.clone()]
    }
}

/// 进度发进窗口，其余进日志。
struct WindowReporter {
    app: AppHandle,
    log: Arc<SetupLog>,
}

impl Reporter for WindowReporter {
    fn progress(&self, progress: Progress) {
        // 窗口收不到进度不影响安装本身
        if let Err(err) = self.app.emit(PROGRESS_EVENT, progress) {
            self.log.warn(format_args!("发进度事件失败：{err}"));
        }
    }

    fn note(&self, line: &str) {
        self.log.info(line);
    }
}

async fn on_worker<T, E>(work: impl FnOnce() -> Result<T, E> + Send + 'static) -> Result<T, String>
where
    T: Send + 'static,
    E: Display + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(work)
        .await
        .map_err(|err| err.to_string())?
        .map_err(|err| err.to_string())
}

#[tauri::command]
pub async fn probe(context: State<'_, Arc<SetupContext>>) -> Result<Probe, String> {
    let context = Arc::clone(&context);
    on_worker(move || context.probe()).await
}

#[tauri::command]
pub async fn check_dir(
    context: State<'_, Arc<SetupContext>>,
    path: String,
) -> Result<DirCheck, String> {
    let context = Arc::clone(&context);
    on_worker(move || Ok::<_, String>(context.check_dir(&path, &SystemEnv))).await
}

#[tauri::command]
pub async fn launcher_running(context: State<'_, Arc<SetupContext>>) -> Result<bool, String> {
    let context = Arc::clone(&context);
    on_worker(move || context.launcher_running()).await
}

/// 拒绝分两种：[`Failure`] 是安装结果，前端进失败页；复核没过与工作线程崩了是字符串，前端进致命错误页。
#[tauri::command]
pub async fn install(
    app: AppHandle,
    context: State<'_, Arc<SetupContext>>,
    plan: InstallPlan,
) -> Result<(), InvokeError> {
    let reporter = WindowReporter {
        app,
        log: Arc::clone(&context.log),
    };
    let context = Arc::clone(&context);
    tauri::async_runtime::spawn_blocking(move || context.reviewed_install(&plan, &reporter))
        .await
        .map_err(InvokeError::from)?
        .map_err(InvokeError::from)?
        .map_err(InvokeError::from)
}

#[tauri::command]
pub async fn open_launcher(
    context: State<'_, Arc<SetupContext>>,
    dir: String,
) -> Result<(), String> {
    let context = Arc::clone(&context);
    on_worker(move || context.open_launcher(Path::new(&dir)).map(|_| ())).await
}

#[tauri::command]
pub async fn open_log(context: State<'_, Arc<SetupContext>>) -> Result<(), String> {
    let path = context.log.path().to_owned();
    on_worker(move || tauri_plugin_opener::open_path(path, None::<&str>)).await
}

#[tauri::command]
pub async fn run_standard_installer(context: State<'_, Arc<SetupContext>>) -> Result<(), String> {
    let context = Arc::clone(&context);
    on_worker(move || context.start_wizard()).await
}

#[tauri::command]
pub fn window_ready(window: WebviewWindow) -> Result<(), String> {
    window.show().map_err(|err| err.to_string())
}

#[cfg(test)]
mod tests {
    use std::collections::{BTreeSet, HashMap};
    #[cfg(debug_assertions)]
    use std::sync::Mutex;

    use petalfall_release::data_format::{STAMP_FILE, stamp_contents};

    use super::*;
    use crate::contract::{DataBlock, DataProblem};
    use crate::existing::{
        APP_EXE, CONFIG_FILE, DISPLAY_VERSION, INSTALL_LOCATION, LAST_DIR_KEY, LEGACY_LAST_DIR_KEY,
        UNINSTALL_KEY,
    };
    use crate::journal::Journal;

    const PAYLOAD: &str = "0.2.0";
    /// 假的 `%LOCALAPPDATA%`。用例里登记目录都是写得进的临时目录，探针一过就不会读到这里。
    const LOCAL_APP_DATA: &str = r"C:\Users\a\AppData\Local";
    const DEFAULT_DIR: &str = r"C:\Users\a\AppData\Local\Petalfall";
    const REQUIRED: u64 = 52_428_800;

    const INITIATIONS: [Initiation; 3] = [
        Initiation::Interactive,
        Initiation::Update,
        Initiation::UpdateWithSwitch,
    ];

    /// 缺 `data_format` 的记号读不懂，原因是固定的一句话。
    const NO_NUMBER: &str = r#"{"written_by":"1.0.0"}"#;
    const NO_NUMBER_REASON: &str = "缺 data_format";
    /// 把记号抬到比安装包高的那个版本。
    const RAISED_BY: &str = "1.1.0-dev.57";

    #[derive(Default)]
    struct Table(HashMap<(String, Option<String>), String>);

    impl Table {
        fn with(mut self, key: &str, value: Option<&str>, text: &str) -> Self {
            self.0
                .insert((key.to_owned(), value.map(str::to_owned)), text.to_owned());
            self
        }

        fn installed(dir: &str, version: &str) -> Self {
            Self::default()
                .with(UNINSTALL_KEY, Some(INSTALL_LOCATION), &format!("\"{dir}\""))
                .with(UNINSTALL_KEY, Some(DISPLAY_VERSION), version)
        }
    }

    impl Registry for Table {
        fn read_string(&self, key: &str, value: Option<&str>) -> io::Result<Option<String>> {
            let key = (key.to_owned(), value.map(str::to_owned));
            Ok(self.0.get(&key).cloned())
        }
    }

    /// 按发起方式拉起，更新模式都带 `/R`。
    fn started(initiation: Initiation) -> Started {
        let update = match initiation {
            Initiation::Interactive => None,
            Initiation::Update | Initiation::UpdateWithSwitch => {
                Some(UpdateLaunch { relaunch: true })
            }
        };
        Started {
            update,
            initiation,
            elevated: false,
        }
    }

    fn assemble_with(
        registry: &Table,
        payload: &str,
        recovery: Recovery,
        started: Started,
    ) -> Assembled {
        assemble_probe(
            registry,
            Path::new(LOCAL_APP_DATA),
            payload,
            REQUIRED,
            DEFAULT_DIR.to_owned(),
            recovery,
            started,
        )
        .unwrap()
    }

    fn assemble(registry: &Table, recovery: Recovery) -> Probe {
        assemble_with(
            registry,
            PAYLOAD,
            recovery,
            started(Initiation::Interactive),
        )
        .probe
    }

    fn interrupted(dir: &Path, was_fresh: bool) -> Recovery {
        interrupted_by(dir, was_fresh, PAYLOAD)
    }

    /// `version` 是留下半装记录的那个安装包的版本。
    fn interrupted_by(dir: &Path, was_fresh: bool, version: &str) -> Recovery {
        Recovery::Interrupted {
            journal: Journal::begin(dir, was_fresh, version),
            mismatches: vec![],
        }
    }

    fn app_dir() -> (tempfile::TempDir, String) {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join(APP_EXE), b"MZ").unwrap();
        let text = dir.path().to_str().unwrap().to_owned();
        (dir, text)
    }

    /// 卸载项还在、程序文件却不在的安装目录。
    fn hollow_dir() -> (tempfile::TempDir, String) {
        let dir = tempfile::tempdir().unwrap();
        let text = dir.path().to_str().unwrap().to_owned();
        (dir, text)
    }

    fn stamp_path(dir: &str) -> String {
        Path::new(dir).join(STAMP_FILE).to_str().unwrap().to_owned()
    }

    /// 数据被 [`RAISED_BY`] 抬到比安装包高一号时探测结果里的拦截详情。
    fn too_new_at(dir: &str) -> DataBlock {
        DataBlock {
            problem: DataProblem::TooNew,
            path: stamp_path(dir),
            recorded: Some(DATA_FORMAT + 1),
            supported: DATA_FORMAT,
            reason: None,
            written_by: Some(RAISED_BY.to_owned()),
            written_by_channel: Some(Channel::Dev),
        }
    }

    fn unreadable_at(dir: &str) -> DataBlock {
        DataBlock {
            problem: DataProblem::Unreadable,
            path: stamp_path(dir),
            recorded: None,
            supported: DATA_FORMAT,
            reason: Some(NO_NUMBER_REASON.to_owned()),
            written_by: None,
            written_by_channel: None,
        }
    }

    /// 数据根里的记号：太新的，或读不懂的。
    #[derive(Debug, Clone, Copy)]
    enum Stamp {
        TooNew,
        Unreadable,
    }

    impl Stamp {
        fn put(self, dir: &str) {
            let contents = match self {
                Stamp::TooNew => stamp_contents(DATA_FORMAT + 1, Some(RAISED_BY)),
                Stamp::Unreadable => NO_NUMBER.to_owned(),
            };
            std::fs::write(Path::new(dir).join(STAMP_FILE), contents).unwrap();
        }

        fn block_at(self, dir: &str) -> DataBlock {
            match self {
                Stamp::TooNew => too_new_at(dir),
                Stamp::Unreadable => unreadable_at(dir),
            }
        }
    }

    #[test]
    fn a_clean_machine_installs_fresh_to_the_default_dir() {
        let probe = assemble(&Table::default(), Recovery::Clean);

        assert_eq!(
            probe,
            Probe {
                payload_version: PAYLOAD.to_owned(),
                payload_channel: Some(Channel::Stable),
                default_dir: DEFAULT_DIR.to_owned(),
                required_bytes: REQUIRED,
                existing: None,
                interrupted: false,
                elevated: false,
                update: None,
                newer_reason: None,
                allowed_modes: vec![InstallMode::Fresh],
                unattended: None,
                handoff: false,
                data_block: None,
            }
        );
    }

    #[test]
    fn elevation_reaches_the_probe() {
        let elevated = Started {
            elevated: true,
            ..started(Initiation::Interactive)
        };

        let probe = assemble_with(&Table::default(), PAYLOAD, Recovery::Clean, elevated).probe;

        assert!(probe.elevated);
    }

    #[test]
    fn the_initiation_follows_the_launch_and_the_switch() {
        let update = Launch::Update(UpdateRequest {
            relaunch: true,
            launcher_args: Vec::new(),
        });

        assert_eq!(
            initiation_of(&Launch::Interactive, false),
            Initiation::Interactive
        );
        assert_eq!(
            initiation_of(&Launch::Interactive, true),
            Initiation::Interactive
        );
        assert_eq!(initiation_of(&update, false), Initiation::Update);
        assert_eq!(initiation_of(&update, true), Initiation::UpdateWithSwitch);
    }

    /// 前端靠这个字段决定跳过向导；断在半截的升级也可能是插件拉起的，盖上半装记录后字段不能丢。
    #[test]
    fn the_update_request_reaches_the_probe_through_every_recovery() {
        let (_guard, dir) = app_dir();
        let fresh_half = Path::new(r"D:\游戏 目录\Petalfall");
        for update in [
            None,
            Some(UpdateLaunch { relaunch: true }),
            Some(UpdateLaunch { relaunch: false }),
        ] {
            let cases = [
                (Table::installed(&dir, "0.1.0"), Recovery::Clean),
                (Table::default(), interrupted(fresh_half, true)),
                (
                    Table::installed(&dir, "0.1.0"),
                    interrupted(Path::new(&dir), false),
                ),
            ];
            let initiation = match update {
                None => Initiation::Interactive,
                Some(_) => Initiation::Update,
            };
            for (registry, recovery) in cases {
                let launched = Started {
                    update,
                    initiation,
                    elevated: false,
                };

                let probe = assemble_with(&registry, PAYLOAD, recovery, launched).probe;

                assert_eq!(probe.update, update, "{probe:?}");
            }
        }
    }

    #[test]
    fn the_fallback_is_the_bare_wizard_unless_the_updater_launched_us() {
        assert_eq!(fallback_arguments(&Launch::Interactive), OsString::new());

        let relaunching = Launch::Update(UpdateRequest {
            relaunch: true,
            launcher_args: vec![
                OsString::from("--minimized"),
                OsString::from("some space"),
                OsString::new(),
            ],
        });
        assert_eq!(
            fallback_arguments(&relaunching),
            OsString::from(r#"/P /R /UPDATE /ARGS --minimized "some space" """#)
        );

        let staying = Launch::Update(UpdateRequest {
            relaunch: false,
            launcher_args: Vec::new(),
        });
        assert_eq!(
            fallback_arguments(&staying),
            OsString::from("/P /UPDATE /ARGS")
        );
    }

    #[test]
    fn an_installed_version_is_classified_and_the_default_dir_stays() {
        let (_guard, dir) = app_dir();

        let probe = assemble(&Table::installed(&dir, "0.1.0"), Recovery::Clean);

        assert_eq!(
            probe.existing,
            Some(Existing {
                kind: ExistingKind::Upgrade,
                version: "0.1.0".to_owned(),
                dir,
                channel: Some(Channel::Stable),
            })
        );
        assert_eq!(probe.default_dir, DEFAULT_DIR);
    }

    #[test]
    fn data_left_by_an_uninstall_becomes_the_default_dir() {
        let leftover = tempfile::tempdir().unwrap();
        std::fs::write(leftover.path().join(CONFIG_FILE), b"{}").unwrap();
        let dir = leftover.path().to_str().unwrap();

        let probe = assemble(
            &Table::default().with(LAST_DIR_KEY, None, dir),
            Recovery::Clean,
        );

        assert_eq!(probe.default_dir, dir);
        assert_eq!(probe.existing, None);
        assert!(!probe.interrupted);
    }

    #[test]
    fn data_left_under_the_legacy_key_becomes_the_default_dir() {
        // 换发布者之前的包卸载后，目录只记在老键里
        let leftover = tempfile::tempdir().unwrap();
        std::fs::write(leftover.path().join(CONFIG_FILE), b"{}").unwrap();
        let dir = leftover.path().to_str().unwrap();

        let probe = assemble(
            &Table::default().with(LEGACY_LAST_DIR_KEY, None, dir),
            Recovery::Clean,
        );

        assert_eq!(probe.default_dir, dir);
        assert_eq!(probe.existing, None);
        assert!(!probe.interrupted);
    }

    #[test]
    fn a_working_install_does_not_look_at_leftovers() {
        let (_guard, dir) = app_dir();
        let leftover = tempfile::tempdir().unwrap();
        std::fs::write(leftover.path().join(CONFIG_FILE), b"{}").unwrap();
        let registry = Table::installed(&dir, PAYLOAD).with(
            LAST_DIR_KEY,
            None,
            leftover.path().to_str().unwrap(),
        );

        assert_eq!(
            assemble(&registry, Recovery::Clean).default_dir,
            DEFAULT_DIR
        );
    }

    #[test]
    fn an_interrupted_fresh_install_resumes_in_its_own_dir() {
        let dir = Path::new(r"D:\游戏 目录\Petalfall");

        let probe = assemble(&Table::default(), interrupted(dir, true));

        assert_eq!(probe.default_dir, dir.to_str().unwrap());
        assert_eq!(probe.existing, None);
        assert!(probe.interrupted);
    }

    /// 半装记录必须盖在现有安装的判定之上：升级断在半截时注册表里还是能升级的样子，反过来就只会再走一次升级。
    #[test]
    fn an_interrupted_upgrade_turns_a_healthy_looking_install_into_a_repair() {
        let (_guard, dir) = app_dir();

        let probe = assemble(
            &Table::installed(&dir, "0.1.0"),
            interrupted(Path::new(&dir), false),
        );

        assert_eq!(
            probe.existing,
            Some(Existing {
                kind: ExistingKind::Broken,
                version: "0.1.0".to_owned(),
                dir,
                channel: Some(Channel::Stable),
            })
        );
        assert!(probe.interrupted);
    }

    /// 允许的模式要按半装恢复之后的种类算：升级断在半截时注册表里还是能升级的样子，照恢复前的种类算，
    /// 更新插件拉起的那次就会不经页面再走一次升级。
    #[test]
    fn allowed_modes_follow_the_kind_left_after_recovery() {
        let (_guard, dir) = app_dir();
        let update = Initiation::Update;
        let cases = [
            (
                Table::default(),
                Recovery::Clean,
                Initiation::Interactive,
                vec![InstallMode::Fresh],
                None,
            ),
            (
                Table::installed(&dir, "0.1.0"),
                Recovery::Clean,
                Initiation::Interactive,
                vec![InstallMode::Upgrade],
                None,
            ),
            (
                Table::installed(&dir, "0.1.0"),
                Recovery::Clean,
                update,
                vec![InstallMode::Upgrade],
                Some(InstallMode::Upgrade),
            ),
            (
                Table::installed(&dir, PAYLOAD),
                Recovery::Clean,
                update,
                vec![InstallMode::Repair],
                None,
            ),
            (
                Table::installed(&dir, "0.1.0"),
                interrupted(Path::new(&dir), false),
                update,
                vec![InstallMode::Repair],
                None,
            ),
            (
                Table::installed(&dir, "0.1.0"),
                interrupted(Path::new(&dir), true),
                update,
                vec![InstallMode::Fresh],
                None,
            ),
        ];
        for (registry, recovery, initiation, allowed, unattended) in cases {
            let probe = assemble_with(&registry, PAYLOAD, recovery, started(initiation)).probe;

            assert_eq!(probe.allowed_modes, allowed, "{probe:?}");
            assert_eq!(probe.unattended, unattended, "{probe:?}");
            assert!(!probe.handoff, "{probe:?}");
            assert_eq!(probe.newer_reason, None, "{probe:?}");
            assert_eq!(probe.data_block, None, "{probe:?}");
        }
    }

    #[test]
    fn the_probe_names_the_channels_of_both_versions() {
        let (_guard, dir) = app_dir();

        let probe = assemble_with(
            &Table::installed(&dir, "1.1.0-dev.61"),
            "1.0.0-beta.5",
            Recovery::Clean,
            started(Initiation::Interactive),
        )
        .probe;

        assert_eq!(probe.payload_channel, Some(Channel::Beta));
        let existing = probe.existing.unwrap();
        assert_eq!(existing.kind, ExistingKind::Switch);
        assert_eq!(existing.channel, Some(Channel::Dev));
    }

    /// 判定表一行在一种发起方式下，探测结果里应有的种类、newer 的原因、允许的模式、无人值守的模式与交接记录。
    #[derive(Debug, Clone, Copy)]
    struct Row {
        kind: Option<ExistingKind>,
        reason: Option<NewerReason>,
        allowed: Option<InstallMode>,
        unattended: Option<InstallMode>,
        handoff: bool,
    }

    fn may(
        kind: Option<ExistingKind>,
        mode: InstallMode,
        unattended: Option<InstallMode>,
        handoff: bool,
    ) -> Row {
        Row {
            kind,
            reason: None,
            allowed: Some(mode),
            unattended,
            handoff,
        }
    }

    fn newer(reason: NewerReason) -> Row {
        Row {
            kind: Some(ExistingKind::Newer),
            reason: Some(reason),
            allowed: None,
            unattended: None,
            handoff: false,
        }
    }

    /// 已装的事实：版本与程序文件在不在；`None` 是没有安装。
    type Installed = Option<(&'static str, bool)>;

    /// 判定表每行各取一例，三列依次是交互、更新、更新并带换通道开关。全表穷举在共用包里，这里只钉住
    /// 探测把事实、半装恢复与数据格式关接到判定表上的方式。
    fn table_rows() -> [(&'static str, Installed, &'static str, [Row; 3]); 10] {
        use ExistingKind as K;
        use InstallMode as M;
        use NewerReason as R;

        let upgrade = |handoff| may(Some(K::Upgrade), M::Upgrade, None, handoff);
        let unattended_upgrade = may(Some(K::Upgrade), M::Upgrade, Some(M::Upgrade), false);
        let repair = |kind| may(Some(kind), M::Repair, None, false);
        [
            (
                "1",
                Some(("1.0.0-dev.5", true)),
                "1.0.0-dev.6",
                [upgrade(false), unattended_upgrade, unattended_upgrade],
            ),
            (
                "2a",
                Some(("1.0.0-beta.3", true)),
                "1.0.0-dev.60",
                [upgrade(true), unattended_upgrade, unattended_upgrade],
            ),
            (
                "2b",
                Some(("1.0.0-beta.4", true)),
                "1.0.0",
                [upgrade(false), unattended_upgrade, unattended_upgrade],
            ),
            (
                "3",
                Some(("1.0.0-dev.6", true)),
                "1.0.0-dev.6",
                [repair(K::Same); 3],
            ),
            (
                "4",
                Some(("1.0.0-dev.60", true)),
                "1.0.0-dev.55",
                [newer(R::SameChannel); 3],
            ),
            (
                "5",
                Some(("1.1.0-dev.61", true)),
                "1.0.0-beta.5",
                [
                    may(Some(K::Switch), M::Switch, None, true),
                    newer(R::SlowerChannel),
                    may(Some(K::Switch), M::Switch, Some(M::Switch), false),
                ],
            ),
            (
                "6",
                Some(("1.0.0", true)),
                "1.0.0-beta.4",
                [newer(R::FasterChannel); 3],
            ),
            (
                "7",
                Some(("2.0.0-rc.1", true)),
                "1.0.0",
                [newer(R::UnknownChannel); 3],
            ),
            (
                "8",
                Some(("1.0.0-dev.9", false)),
                "1.0.0-dev.6",
                [repair(K::Broken); 3],
            ),
            (
                "9",
                None,
                "1.0.0-dev.6",
                [may(None, M::Fresh, None, false); 3],
            ),
        ]
    }

    /// 按已装的事实摆好注册表与安装目录。返回的临时目录要活到用例结束。
    fn machine_with(installed: Installed) -> (tempfile::TempDir, String, Table) {
        let (guard, dir) = match installed {
            Some((_, false)) | None => hollow_dir(),
            Some((_, true)) => app_dir(),
        };
        let registry = match installed {
            Some((version, _)) => Table::installed(&dir, version),
            None => Table::default(),
        };
        (guard, dir, registry)
    }

    #[test]
    fn every_row_of_the_table_reaches_the_probe_under_each_initiation() {
        for (row, installed, payload, expected) in table_rows() {
            for (initiation, expected) in INITIATIONS.into_iter().zip(expected) {
                let (_guard, _dir, registry) = machine_with(installed);
                let context = format!("第 {row} 行，{initiation:?}");

                let assembled =
                    assemble_with(&registry, payload, Recovery::Clean, started(initiation));

                let probe = assembled.probe;
                assert_eq!(assembled.handoff.is_some(), expected.handoff, "{context}");
                assert_eq!(
                    probe.existing.as_ref().map(|existing| existing.kind),
                    expected.kind,
                    "{context}"
                );
                assert_eq!(probe.newer_reason, expected.reason, "{context}");
                assert_eq!(
                    probe.allowed_modes,
                    Vec::from_iter(expected.allowed),
                    "{context}"
                );
                assert_eq!(probe.unattended, expected.unattended, "{context}");
                assert_eq!(probe.handoff, expected.handoff, "{context}");
                assert_eq!(probe.data_block, None, "{context}");
            }
        }
    }

    /// 数据关先于一切：升级、换通道、修复都一样，什么模式都不给，也不写交接记录；种类照判，界面才知道给不给「打开落樱」。
    #[test]
    fn data_newer_than_the_package_or_unreadable_leaves_nothing_to_install() {
        let rows = [
            ("1", ("1.0.0-dev.5", true), "1.0.0-dev.6"),
            ("2a", ("1.0.0-beta.3", true), "1.0.0-dev.60"),
            ("3", ("1.0.0-dev.6", true), "1.0.0-dev.6"),
            ("5", ("1.1.0-dev.61", true), "1.0.0-beta.5"),
            ("8", ("1.0.0-dev.9", false), "1.0.0-dev.6"),
        ];
        for (row, installed, payload) in rows {
            for stamp in [Stamp::TooNew, Stamp::Unreadable] {
                for initiation in INITIATIONS {
                    let (_guard, dir, registry) = machine_with(Some(installed));
                    let clean =
                        assemble_with(&registry, payload, Recovery::Clean, started(initiation))
                            .probe;
                    stamp.put(&dir);
                    let context = format!("第 {row} 行，{stamp:?}，{initiation:?}");

                    let probe =
                        assemble_with(&registry, payload, Recovery::Clean, started(initiation))
                            .probe;

                    assert_eq!(probe.data_block, Some(stamp.block_at(&dir)), "{context}");
                    assert_eq!(probe.allowed_modes, Vec::new(), "{context}");
                    assert_eq!(probe.unattended, None, "{context}");
                    assert!(!probe.handoff, "{context}");
                    assert_eq!(probe.existing, clean.existing, "{context}");
                    assert_eq!(probe.newer_reason, clean.newer_reason, "{context}");
                }
            }
        }
    }

    /// 记号与安装包认得的号相同时照常放行。
    #[test]
    fn a_stamp_at_the_packages_own_format_lets_the_upgrade_through() {
        let (_guard, dir, registry) = machine_with(Some(("1.0.0-dev.5", true)));
        std::fs::write(
            Path::new(&dir).join(STAMP_FILE),
            stamp_contents(DATA_FORMAT, Some("1.0.0-dev.5")),
        )
        .unwrap();

        let assembled = assemble_with(
            &registry,
            "1.0.0-dev.6",
            Recovery::Clean,
            started(Initiation::Update),
        );

        assert_eq!(assembled.probe.allowed_modes, vec![InstallMode::Upgrade]);
        assert_eq!(assembled.probe.unattended, Some(InstallMode::Upgrade));
        assert_eq!(assembled.probe.data_block, None);
        let gate = assembled.gate.expect("有登记安装就要过数据格式关");
        assert_eq!(gate.roots, vec![PathBuf::from(&dir)]);
        assert_eq!(gate.stamp, Path::new(&dir).join(STAMP_FILE));
        assert_eq!(gate.verdict, StampVerdict::Pass);
    }

    /// 交接记录看半装恢复之后的种类：改成 broken 或首装的那次显示「重新安装」，不再是「换到」页。
    #[test]
    fn the_handoff_follows_the_kind_left_after_recovery() {
        let faster = (("1.0.0-beta.3", true), "1.0.0-dev.60");
        let slower_and_earlier = (("1.1.0-dev.61", true), "1.0.0-beta.5");
        let cases = [
            (
                faster,
                None,
                Some(ExistingKind::Upgrade),
                vec![InstallMode::Upgrade],
                true,
            ),
            (
                faster,
                Some(false),
                Some(ExistingKind::Broken),
                vec![InstallMode::Repair],
                false,
            ),
            (faster, Some(true), None, vec![InstallMode::Fresh], false),
            (
                slower_and_earlier,
                None,
                Some(ExistingKind::Switch),
                vec![InstallMode::Switch],
                true,
            ),
            // 已装的比载荷新时半装记录按过期处理，换通道保持原判
            (
                slower_and_earlier,
                Some(false),
                Some(ExistingKind::Switch),
                vec![InstallMode::Switch],
                true,
            ),
        ];
        for ((installed, payload), half, kind, allowed, handoff) in cases {
            let (_guard, dir, registry) = machine_with(Some(installed));
            let recovery = match half {
                None => Recovery::Clean,
                Some(was_fresh) => interrupted_by(Path::new(&dir), was_fresh, payload),
            };
            let context = format!("{installed:?} 装 {payload}，半装 {half:?}");

            let probe = assemble_with(
                &registry,
                payload,
                recovery,
                started(Initiation::Interactive),
            )
            .probe;

            assert_eq!(
                probe.existing.as_ref().map(|existing| existing.kind),
                kind,
                "{context}"
            );
            assert_eq!(probe.allowed_modes, allowed, "{context}");
            assert_eq!(probe.handoff, handoff, "{context}");
            assert_eq!(
                probe.interrupted,
                half.is_some() && kind != Some(ExistingKind::Switch),
                "{context}"
            );
        }
    }

    /// 首装的数据格式关要等最终目录定了才做：卸载留下的目录里记号再高，探测也只给首装，拦截由选目录和安装前复核给。
    #[test]
    fn a_fresh_install_reads_no_stamp_before_the_target_is_chosen() {
        let leftover = tempfile::tempdir().unwrap();
        std::fs::write(leftover.path().join(CONFIG_FILE), b"{}").unwrap();
        let dir = leftover.path().to_str().unwrap();
        Stamp::TooNew.put(dir);

        let assembled = assemble_with(
            &Table::default().with(LAST_DIR_KEY, None, dir),
            PAYLOAD,
            Recovery::Clean,
            started(Initiation::Interactive),
        );

        assert_eq!(assembled.probe.default_dir, dir);
        assert_eq!(assembled.probe.allowed_modes, vec![InstallMode::Fresh]);
        assert_eq!(assembled.probe.data_block, None);
        assert_eq!(assembled.gate, None);
    }

    /// 交接记录写的是安装包的通道与版本，启动器拿版本与自己比对，对上了才把偏好改成那个通道。
    #[test]
    fn the_handoff_names_the_packages_channel_and_version() {
        let cases = [
            (
                ("1.0.0-beta.3", true),
                "1.0.0-dev.60",
                Some(order::Channel::Dev),
            ),
            (
                ("1.1.0-dev.61", true),
                "1.0.0-beta.5",
                Some(order::Channel::Beta),
            ),
            (("1.0.0-beta.4", true), "1.0.0", None),
            (("1.0.0-dev.5", true), "1.0.0-dev.6", None),
        ];
        for (installed, payload, channel) in cases {
            let (_guard, _dir, registry) = machine_with(Some(installed));

            let assembled = assemble_with(
                &registry,
                payload,
                Recovery::Clean,
                started(Initiation::Interactive),
            );

            let expected = channel.map(|channel| Handoff {
                channel,
                version: Version::parse(payload).unwrap(),
            });
            assert_eq!(assembled.handoff, expected, "{payload}");
        }
    }

    /// 命令只是把活交给工作线程：复核写在命令里而不是 `SetupContext::install` 里，漏接了编译也不报。
    #[test]
    fn the_install_command_reviews_before_installing() {
        let source = include_str!("commands.rs");
        let (_, command) = source
            .split_once("pub async fn install(")
            .expect("要有 install 命令");
        let (body, _) = command
            .split_once("#[tauri::command]")
            .expect("install 后面还有命令");
        assert!(body.contains("context.reviewed_install(&plan, &reporter)"));
        assert!(!body.contains("context.install("));
    }

    #[test]
    fn a_finished_recovery_leaves_the_probe_alone() {
        for recovery in [
            Recovery::Completed,
            Recovery::Discarded {
                reason: "坏了".to_owned(),
            },
        ] {
            let probe = assemble(&Table::default(), recovery);

            assert_eq!(probe.default_dir, DEFAULT_DIR);
            assert!(!probe.interrupted);
        }
    }

    #[test]
    fn the_default_dir_counts_as_ours_whether_or_not_the_probe_moved_away() {
        let clean = assemble(&Table::default(), Recovery::Clean);
        assert_eq!(
            own_dirs(DEFAULT_DIR.to_owned(), &clean),
            vec![DEFAULT_DIR.to_owned()]
        );

        let half = Path::new(r"D:\游戏 目录\Petalfall");
        let moved = assemble(&Table::default(), interrupted(half, true));
        assert_eq!(
            own_dirs(DEFAULT_DIR.to_owned(), &moved),
            vec![DEFAULT_DIR.to_owned(), half.to_str().unwrap().to_owned()]
        );
    }

    fn registered_commands() -> BTreeSet<&'static str> {
        let main = include_str!("main.rs");
        let (_, rest) = main
            .split_once("generate_handler![")
            .expect("main.rs 要注册命令");
        let (list, _) = rest.split_once(']').expect("命令列表没有结束");
        list.split(',')
            .map(str::trim)
            .filter(|item| !item.is_empty())
            .map(|item| {
                item.strip_prefix("commands::")
                    .expect("命令都在 commands 模块里")
            })
            .collect()
    }

    fn bridge_commands() -> BTreeSet<&'static str> {
        include_str!("../../src/setup/bridge.ts")
            .split("invoke<")
            .skip(1)
            .filter_map(|call| call.split_once("(\"")?.1.split_once('"'))
            .map(|(name, _)| name)
            .collect()
    }

    /// 两边的名字只靠字符串对上，写错了编译不报，要到点按钮时才拒绝。
    #[test]
    fn the_bridge_and_the_handler_list_the_same_commands() {
        assert_eq!(bridge_commands(), registered_commands());
        assert_eq!(registered_commands().len(), 8);
    }

    /// 放行判定只有接到窗口上才起作用，配置项写错编译也不报。
    #[test]
    fn the_window_asks_the_context_before_navigating() {
        assert!(
            include_str!("main.rs").contains(".on_navigation(move |_| page.allows_navigation())")
        );
    }

    /// 浏览器加速键的开关要在运行时接到窗口上，漏了只有 release 窗口里才看得出来。
    #[test]
    fn the_window_turns_browser_keys_off() {
        assert!(
            include_str!("main.rs").contains("boot::disable_browser_accelerator_keys(&self.window")
        );
    }

    /// main 里给上下文传个写死的交互启动、回退时调成无参向导，编译都不报，只有插件真拉起时才看得出来。
    #[test]
    fn main_hands_the_parsed_launch_to_the_context_and_the_fallback() {
        let main = include_str!("main.rs");
        assert!(main.contains("cli::parse(std::env::args_os().skip(1))"));
        assert!(main.contains("parsed.launch,"));
        assert!(main.contains("parsed.channel_switch,"));
        assert!(main.contains("context.fall_back(boot::alert)?"));
        assert!(!main.contains("start_wizard"));
    }

    #[test]
    fn the_frontend_listens_on_the_event_the_backend_emits() {
        let needle = format!("PROGRESS_EVENT = \"{PROGRESS_EVENT}\"");
        assert!(include_str!("../../src/setup/contract.ts").contains(&needle));
    }

    #[cfg(debug_assertions)]
    mod with_the_fake_payload {
        use std::path::PathBuf;
        use std::time::Duration;

        use super::*;
        use crate::boot::{Claim, test_claim};
        use crate::contract::{FailureCode, InstallMode};
        use crate::extract::hex;
        use crate::journal::JournalStore;
        use crate::overlay::test_support::random_bytes;
        use crate::runner::fake::{self, Fake, Opening, Outcome, Received};
        use crate::runner::test_support::Recording;
        use crate::target::Volume;

        const PLENTY: u64 = 1 << 40;

        /// 系统环境把临时目录列为禁区，用例的目录都在那里，这里只放行。
        struct OpenEnv;

        impl TargetEnv for OpenEnv {
            fn blocked_roots(&self) -> Vec<String> {
                vec![]
            }

            fn temp_dir(&self) -> PathBuf {
                std::env::temp_dir()
            }

            fn char_outside_code_page(&self, _text: &str) -> Option<char> {
                None
            }

            fn is_remote_drive(&self, _root: &str) -> bool {
                false
            }

            fn long_path(&self, path: &Path) -> io::Result<String> {
                Ok(path.to_string_lossy().into_owned())
            }

            fn volume(&self, _dir: &Path) -> io::Result<Volume> {
                Ok(Volume {
                    id: "C".to_owned(),
                    free_bytes: PLENTY,
                })
            }
        }

        struct Rig {
            sandbox: tempfile::TempDir,
            context: SetupContext,
            received: Arc<Mutex<Received>>,
        }

        fn rig(test: &str) -> Rig {
            launched(test, Launch::Interactive)
        }

        fn launched(test: &str, launch: Launch) -> Rig {
            switched(test, launch, false)
        }

        /// 沙箱里的 `%LOCALAPPDATA%`，不碰这台电脑上真的那个。
        fn local_app_data(sandbox: &Path) -> PathBuf {
            sandbox.join("LocalAppData")
        }

        fn switched(test: &str, launch: Launch, channel_switch: bool) -> Rig {
            let sandbox = tempfile::tempdir().unwrap();
            let fake = Fake::new(Outcome::Ok, Duration::from_millis(5));
            let received = fake.received();
            let session = fake::session(fake, sandbox.path()).unwrap();
            let Claim::First(instance) = test_claim(&format!("commands-{test}")) else {
                panic!("{test} 上不该已有实例");
            };
            let log = SetupLog::open(&sandbox.path().join("log")).unwrap();
            let context = SetupContext::new(
                session,
                Arc::new(instance),
                Arc::new(log),
                launch,
                channel_switch,
                local_app_data(sandbox.path()),
            );
            Rig {
                sandbox,
                context,
                received,
            }
        }

        /// 启动器被更新时带着的参数。头一个每次跑都不一样，免得碰巧和哪里写死的值对上；其余是转义的边界：
        /// 空串、带空格的路径和末尾反斜杠、带引号的值。
        fn launcher_args() -> Vec<OsString> {
            vec![
                OsString::from(format!("--nonce={}", hex(&random_bytes(8)))),
                OsString::new(),
                OsString::from(r"C:\游戏 目录\"),
                OsString::from("--arg=\"wrapped space\""),
            ]
        }

        fn update(relaunch: bool, launcher_args: Vec<OsString>) -> Launch {
            Launch::Update(UpdateRequest {
                relaunch,
                launcher_args,
            })
        }

        impl Rig {
            /// 上次首装断在半截的现场。
            fn interrupted_at(&self, dir: &Path) {
                let store = JournalStore::new(&self.context.session.roots().state);
                let journal = Journal::begin(dir, true, &self.context.session.header().version);
                store.save(&journal).unwrap();
            }

            fn logged(&self) -> String {
                std::fs::read_to_string(self.context.log.path()).unwrap()
            }
        }

        /// 进度回调跑在安装的工作线程上，这里读到的就是安装中途的放行结果。
        struct NavigationSpy<'a> {
            context: &'a SetupContext,
            seen: Mutex<Vec<bool>>,
        }

        impl<'a> NavigationSpy<'a> {
            fn new(context: &'a SetupContext) -> Self {
                Self {
                    context,
                    seen: Mutex::default(),
                }
            }
        }

        impl Reporter for NavigationSpy<'_> {
            fn progress(&self, _: Progress) {
                let allowed = self.context.allows_navigation();
                self.seen.lock().unwrap().push(allowed);
            }

            fn note(&self, _: &str) {}
        }

        fn fresh(dir: &str) -> InstallPlan {
            InstallPlan {
                mode: InstallMode::Fresh,
                dir: Some(dir.to_owned()),
                desktop_shortcut: true,
            }
        }

        fn locked(mode: InstallMode) -> InstallPlan {
            InstallPlan {
                mode,
                dir: None,
                desktop_shortcut: false,
            }
        }

        #[test]
        fn the_page_stays_put_while_an_install_runs() {
            let rig = rig("navigation");
            assert!(rig.context.allows_navigation(), "开窗时的第一次加载要放行");

            let spy = NavigationSpy::new(&rig.context);
            rig.context.install(&fresh(r"D:\Petalfall"), &spy).unwrap();

            let seen = spy.seen.into_inner().unwrap();
            assert!(seen.len() >= 4, "开始、解包、退出、核验都有进度：{seen:?}");
            assert!(seen.iter().all(|allowed| !allowed), "{seen:?}");
            assert!(rig.context.allows_navigation(), "装完刷新已经碍不着什么");
        }

        #[test]
        fn a_failed_install_lets_the_page_go_again() {
            let sandbox = tempfile::tempdir().unwrap();
            let session = fake::session(
                Fake::new(Outcome::Verify, Duration::from_millis(5)),
                sandbox.path(),
            )
            .unwrap();
            let Claim::First(instance) = test_claim("commands-navigation-failed") else {
                panic!("这个名字上不该已有实例");
            };
            let log = SetupLog::open(&sandbox.path().join("log")).unwrap();
            let context = SetupContext::new(
                session,
                Arc::new(instance),
                Arc::new(log),
                Launch::Interactive,
                false,
                local_app_data(sandbox.path()),
            );

            let spy = NavigationSpy::new(&context);
            context.install(&fresh(r"D:\Petalfall"), &spy).unwrap_err();

            assert!(spy.seen.lock().unwrap().iter().all(|allowed| !allowed));
            assert!(context.allows_navigation());
        }

        #[test]
        fn a_half_written_dir_is_not_wrapped_in_another_folder() {
            let rig = rig("resume");
            let half = rig.sandbox.path().join("half");
            std::fs::create_dir(&half).unwrap();
            std::fs::write(half.join("uninstall.exe"), b"half").unwrap();
            rig.interrupted_at(&half);

            let probe = rig.context.probe().unwrap();
            let check = rig.context.check_dir(half.to_str().unwrap(), &OpenEnv);

            assert!(probe.interrupted);
            assert_eq!(probe.default_dir, half.to_str().unwrap());
            assert_eq!(check.issue, None);
            assert_eq!(check.normalized, half.to_str().unwrap());
            assert!(!check.not_empty);
            assert!(!check.appended);
        }

        #[test]
        fn someone_elses_dir_still_gets_its_own_folder() {
            let rig = rig("wrap");
            let half = rig.sandbox.path().join("half");
            let other = rig.sandbox.path().join("other");
            std::fs::create_dir(&half).unwrap();
            std::fs::create_dir(&other).unwrap();
            std::fs::write(other.join("notes.txt"), b"x").unwrap();
            rig.interrupted_at(&half);
            rig.context.probe().unwrap();

            let check = rig.context.check_dir(other.to_str().unwrap(), &OpenEnv);

            assert_eq!(
                check.normalized,
                format!(r"{}\{APP_FOLDER}", other.display())
            );
            assert!(check.not_empty);
            assert!(check.appended);
        }

        #[test]
        fn a_record_older_than_the_install_leaves_the_working_install_in_charge() {
            let rig = rig("stale");
            rig.context
                .install(&fresh(r"D:\Petalfall"), &Recording::default())
                .unwrap();
            let instdir = rig.sandbox.path().join("instdir");
            JournalStore::new(&rig.context.session.roots().state)
                .save(&Journal::begin(&instdir, true, "0.0.1"))
                .unwrap();

            let probe = rig.context.probe().unwrap();

            assert!(!probe.interrupted);
            assert_eq!(probe.existing.unwrap().kind, ExistingKind::Same);
            assert_ne!(probe.default_dir, instdir.to_str().unwrap());
        }

        #[test]
        fn a_half_upgrade_of_a_removed_install_goes_back_into_its_dir() {
            let rig = rig("removed");
            let half = rig.sandbox.path().join("half");
            std::fs::create_dir(&half).unwrap();
            std::fs::write(half.join(CONFIG_FILE), b"{}").unwrap();
            let journal = Journal::begin(&half, false, &rig.context.session.header().version);
            JournalStore::new(&rig.context.session.roots().state)
                .save(&journal)
                .unwrap();

            let probe = rig.context.probe().unwrap();
            let check = rig.context.check_dir(half.to_str().unwrap(), &OpenEnv);

            assert_eq!(probe.existing, None);
            assert!(probe.interrupted);
            assert_eq!(probe.default_dir, half.to_str().unwrap());
            assert_eq!(check.normalized, half.to_str().unwrap());
            assert!(check.has_config);
        }

        #[test]
        fn a_locked_install_before_any_probe_has_no_target() {
            let rig = rig("no-target");

            let failure = rig
                .context
                .install(&locked(InstallMode::Upgrade), &Recording::default())
                .unwrap_err();

            assert_eq!(failure.code, FailureCode::DirUnwritable);
        }

        #[test]
        fn a_repair_goes_to_the_dir_the_probe_found() {
            let rig = rig("repair");
            rig.context
                .install(&fresh(r"D:\Petalfall"), &Recording::default())
                .unwrap();

            let probe = rig.context.probe().unwrap();

            let existing = probe.existing.expect("装完应当探测得到");
            assert_eq!(existing.kind, ExistingKind::Same);
            assert_eq!(
                existing.dir,
                rig.sandbox.path().join("instdir").to_str().unwrap()
            );
            rig.context
                .install(&locked(InstallMode::Repair), &Recording::default())
                .unwrap();
            // 探测结果那行也带着这个目录，只看修复发起的那一行，才锁得住登记目录到 /D= 的映射
            let logged = rig.logged();
            let started = logged
                .lines()
                .rfind(|line| line.contains("开始安装"))
                .expect("修复应当记下发起的目标");
            assert!(started.contains("Repair"), "{started}");
            assert!(
                started.contains(&format!("{:?}", PathBuf::from(&existing.dir))),
                "{started}"
            );
        }

        #[test]
        fn an_install_failure_keeps_its_code() {
            let sandbox = tempfile::tempdir().unwrap();
            let session = fake::session(
                Fake::new(Outcome::Verify, Duration::from_millis(5)),
                sandbox.path(),
            )
            .unwrap();
            let Claim::First(instance) = test_claim("commands-verify") else {
                panic!("这个名字上不该已有实例");
            };
            let log = SetupLog::open(&sandbox.path().join("log")).unwrap();
            let context = SetupContext::new(
                session,
                Arc::new(instance),
                Arc::new(log),
                Launch::Interactive,
                false,
                local_app_data(sandbox.path()),
            );

            let failure = context
                .install(&fresh(r"D:\Petalfall"), &Recording::default())
                .unwrap_err();

            assert_eq!(failure.code, FailureCode::VerifyFailed);
        }

        #[test]
        fn opening_the_launcher_stays_inside_the_fake() {
            let rig = rig("open");
            let dir = Path::new(r"D:\没有这个目录");

            let opened = rig.context.open_launcher(dir);

            assert_eq!(opened.unwrap(), Opened::Exited(None));
            assert_eq!(
                rig.received.lock().unwrap().openings,
                [Opening {
                    dir: dir.to_owned(),
                    args: Vec::new(),
                }]
            );
            assert!(rig.logged().contains("打开启动器"));
        }

        #[test]
        fn an_update_hands_the_launcher_its_own_arguments_back() {
            for (test, relaunch) in [("open-update-relaunch", true), ("open-update-stay", false)] {
                let args = launcher_args();
                let rig = launched(test, update(relaunch, args.clone()));
                let dir = rig.sandbox.path().join("instdir");

                rig.context.open_launcher(&dir).unwrap();

                assert_eq!(
                    rig.received.lock().unwrap().openings,
                    [Opening { dir, args }],
                    "{test}"
                );
            }
        }

        #[test]
        fn the_wizard_is_waited_for_once() {
            let rig = rig("wizard");
            rig.context.probe().unwrap();

            assert_eq!(rig.context.wait_for_wizard().unwrap(), None);
            rig.context.start_wizard().unwrap();
            assert_eq!(rig.context.wait_for_wizard().unwrap(), Some(0));
            assert_eq!(rig.context.wait_for_wizard().unwrap(), None);
            assert!(rig.logged().contains("原生向导已退出：0"));
        }

        #[test]
        fn the_wizard_button_stays_a_bare_wizard_during_an_update() {
            let rig = launched("wizard-update", update(true, launcher_args()));
            rig.context.probe().unwrap();

            rig.context.start_wizard().unwrap();
            assert_eq!(rig.context.wait_for_wizard().unwrap(), Some(0));

            assert_eq!(rig.received.lock().unwrap().launches, [OsString::new()]);
        }

        fn no_alert(notice: &Notice) {
            panic!("能装的时候不该弹对话框：{notice:?}");
        }

        #[test]
        fn the_fallback_of_an_update_runs_nsis_with_the_plugin_arguments() {
            let args = launcher_args();
            let nonce = args[0].to_str().unwrap().to_owned();
            let rig = launched("fallback-update", update(true, args));

            assert_eq!(rig.context.fall_back(no_alert).unwrap(), FallenBack::Ran(0));

            assert_eq!(
                rig.received.lock().unwrap().launches,
                [OsString::from(format!(
                    r#"/P /R /UPDATE /ARGS {nonce} "" "C:\游戏 目录\\" "--arg=\"wrapped space\"""#
                ))]
            );
            assert!(rig.received.lock().unwrap().openings.is_empty());
        }

        #[test]
        fn the_fallback_of_an_interactive_launch_is_the_bare_wizard() {
            let rig = rig("fallback-interactive");

            assert_eq!(rig.context.fall_back(no_alert).unwrap(), FallenBack::Ran(0));

            assert_eq!(rig.received.lock().unwrap().launches, [OsString::new()]);
        }

        #[test]
        fn the_probe_tells_the_frontend_how_it_was_launched() {
            for (test, launch, expected) in [
                ("probe-interactive", Launch::Interactive, None),
                (
                    "probe-update-relaunch",
                    update(true, launcher_args()),
                    Some(UpdateLaunch { relaunch: true }),
                ),
                (
                    "probe-update-stay",
                    update(false, Vec::new()),
                    Some(UpdateLaunch { relaunch: false }),
                ),
            ] {
                let rig = launched(test, launch);

                assert_eq!(rig.context.probe().unwrap().update, expected, "{test}");
            }
        }

        #[test]
        fn a_probe_on_a_clean_sandbox_defaults_under_local_app_data() {
            let rig = rig("default");

            let probe = rig.context.probe().unwrap();

            assert_eq!(
                probe.default_dir,
                local_app_data(rig.sandbox.path())
                    .join("Petalfall")
                    .to_str()
                    .unwrap()
            );
            assert_eq!(probe.existing, None);
            assert_eq!(
                probe.required_bytes,
                SpaceNeed::for_payload(
                    rig.context.session.header().payload_len,
                    rig.context.session.header().exe_len
                )
                .target
            );
        }

        /// 拦下用户时要查得到读了哪个根、哪个记号定的结论。
        #[test]
        fn the_probe_logs_what_the_data_gate_read() {
            let rig = rig("probe-gate-log");
            rig.context
                .install(&fresh(r"D:\Petalfall"), &Recording::default())
                .unwrap();
            let instdir = rig.sandbox.path().join("instdir");

            rig.context.probe().unwrap();

            let logged = rig.logged();
            assert!(logged.contains("判定：发起方式 Interactive"), "{logged}");
            assert!(
                logged.contains(&format!(
                    "探测的数据格式关：读了 [{:?}]，定下结论的记号 {}，结论 Pass",
                    instdir,
                    instdir.join(STAMP_FILE).display()
                )),
                "{logged}"
            );
        }

        #[test]
        fn a_fresh_probe_says_it_left_the_stamp_for_later() {
            let rig = rig("probe-gate-fresh");

            rig.context.probe().unwrap();

            assert!(
                rig.logged()
                    .contains("没有登记安装，探测时不读数据格式记号")
            );
        }

        /// 开关只对换到更慢通道的那一行起作用，别的时候照判定表处理，日志里留一笔。
        #[test]
        fn a_switch_flag_with_nothing_to_switch_is_noted() {
            let rig = switched("probe-switch-noted", update(true, Vec::new()), true);
            rig.context
                .install(&fresh(r"D:\Petalfall"), &Recording::default())
                .unwrap();

            let probe = rig.context.probe().unwrap();

            assert_eq!(probe.existing.unwrap().kind, ExistingKind::Same);
            assert_eq!(probe.unattended, None);
            assert!(
                rig.logged()
                    .contains("带了换通道开关，这次不是换到更慢通道的安装，开关不起作用"),
                "{}",
                rig.logged()
            );
        }
    }

    /// 版本由用例定的安装包，打开在一台假电脑上：注册表在内存里，NSIS 是只记参数的替身，所有目录都在临时目录下。
    mod on_a_fake_machine {
        use std::fs;
        use std::sync::Mutex;

        use petalfall_release::handoff::{ChannelHandoff, HANDOFF_FILE};

        use super::*;
        use crate::boot::{Claim, test_claim};
        use crate::extract::hex;
        use crate::journal::{JOURNAL_FILE, Processes};
        use crate::overlay::test_support::{packed_image, random_bytes};
        use crate::overlay::{Overlay, Source};
        use crate::runner::test_support::Recording;
        use crate::runner::{Launcher, Roots, Running};
        use crate::verify::UNINSTALLER_NAME;

        /// 写得进的注册表：替身 NSIS 装完要改卸载项。
        #[derive(Default)]
        struct Hive(Mutex<HashMap<(String, Option<String>), String>>);

        impl Hive {
            fn set(&self, key: &str, value: Option<&str>, text: &str) {
                self.0
                    .lock()
                    .unwrap()
                    .insert((key.to_owned(), value.map(str::to_owned)), text.to_owned());
            }
        }

        impl Registry for Hive {
            fn read_string(&self, key: &str, value: Option<&str>) -> io::Result<Option<String>> {
                let key = (key.to_owned(), value.map(str::to_owned));
                Ok(self.0.lock().unwrap().get(&key).cloned())
            }
        }

        struct Exited(i32);

        impl Running for Exited {
            fn pid(&self) -> u32 {
                0
            }

            fn try_wait(&mut self) -> io::Result<Option<i32>> {
                Ok(Some(self.0))
            }
        }

        /// 替身 NSIS 与替身启动器收到过的东西。
        #[derive(Debug, Default)]
        struct Calls {
            /// 每次拉起 NSIS 的整串参数。
            launches: Vec<OsString>,
            /// 每次打开启动器的目录与参数。
            openings: Vec<(PathBuf, Vec<OsString>)>,
        }

        /// 静默安装时像 NSIS 一样写好程序文件与卸载项，事后核验才过得去；向导与原生回退只记参数。
        struct Nsis {
            exe: Vec<u8>,
            version: String,
            hive: Arc<Hive>,
            calls: Arc<Mutex<Calls>>,
        }

        impl Launcher for Nsis {
            fn launch(
                &self,
                _exe: &Path,
                _cwd: &Path,
                arguments: &OsStr,
            ) -> io::Result<Box<dyn Running>> {
                self.calls
                    .lock()
                    .unwrap()
                    .launches
                    .push(arguments.to_owned());
                let silent = arguments
                    .to_str()
                    .and_then(|text| text.strip_prefix("/S /D="));
                if let Some(dir) = silent {
                    let dir = Path::new(dir);
                    fs::create_dir_all(dir)?;
                    fs::write(dir.join(APP_EXE), &self.exe)?;
                    fs::write(dir.join(UNINSTALLER_NAME), b"MZ")?;
                    self.hive
                        .set(UNINSTALL_KEY, Some(DISPLAY_VERSION), &self.version);
                    self.hive.set(
                        UNINSTALL_KEY,
                        Some(INSTALL_LOCATION),
                        &format!("\"{}\"", dir.display()),
                    );
                }
                Ok(Box::new(Exited(0)))
            }

            fn app_running(&self) -> io::Result<bool> {
                Ok(false)
            }

            fn open_app(
                &self,
                dir: &Path,
                args: &[OsString],
                _instance: &Instance,
            ) -> io::Result<Opened> {
                self.calls
                    .lock()
                    .unwrap()
                    .openings
                    .push((dir.to_owned(), args.to_vec()));
                Ok(Opened::Exited(None))
            }
        }

        struct NoPayloadRunning;

        impl Processes for NoPayloadRunning {
            fn payload_alive(&self, _: u32) -> io::Result<bool> {
                Ok(false)
            }
        }

        struct Machine {
            root: tempfile::TempDir,
            hive: Arc<Hive>,
            calls: Arc<Mutex<Calls>>,
            context: SetupContext,
        }

        fn update_launch(launcher_args: Vec<OsString>) -> Launch {
            Launch::Update(UpdateRequest {
                relaunch: true,
                launcher_args,
            })
        }

        /// 三种发起方式对应的命令行，更新模式带着启动器被更新时的参数。
        fn launch_for(initiation: Initiation, launcher_args: Vec<OsString>) -> (Launch, bool) {
            match initiation {
                Initiation::Interactive => (Launch::Interactive, false),
                Initiation::Update => (update_launch(launcher_args), false),
                Initiation::UpdateWithSwitch => (update_launch(launcher_args), true),
            }
        }

        /// 启动器被更新时带着的参数。头一个每次跑都不一样，免得碰巧和哪里写死的值对上；其余是转义的边界。
        fn launcher_args() -> Vec<OsString> {
            vec![
                OsString::from(format!("--nonce={}", hex(&random_bytes(8)))),
                OsString::new(),
                OsString::from(r"C:\游戏 目录\"),
            ]
        }

        /// 在一台空电脑上打开版本为 `payload` 的安装包。`test` 区分各用例的实例互斥名。
        fn machine(test: &str, payload: &str, launch: Launch, channel_switch: bool) -> Machine {
            let root = tempfile::tempdir().unwrap();
            let exe = random_bytes(4096);
            let image = packed_image(root.path(), &random_bytes(1024), &exe, payload, &[]);
            let hive = Arc::new(Hive::default());
            let calls = Arc::new(Mutex::new(Calls::default()));
            let roots = Roots {
                temp: root.path().join("temp"),
                state: root.path().join("state"),
                desktop: root.path().join("desktop"),
            };
            fs::create_dir_all(&roots.temp).unwrap();
            fs::create_dir_all(&roots.desktop).unwrap();
            let nsis = Nsis {
                exe,
                version: payload.to_owned(),
                hive: Arc::clone(&hive),
                calls: Arc::clone(&calls),
            };
            let registry: Arc<dyn Registry> = hive.clone();
            let session = Session::new(
                Source::Packed(Overlay::open(&image).unwrap()),
                roots,
                Box::new(nsis),
                registry,
                Box::new(NoPayloadRunning),
            );
            let Claim::First(instance) = test_claim(&format!("commands-machine-{test}")) else {
                panic!("{test} 上不该已有实例");
            };
            let log = SetupLog::open(&root.path().join("log")).unwrap();
            let context = SetupContext::new(
                session,
                Arc::new(instance),
                Arc::new(log),
                launch,
                channel_switch,
                root.path().join("LocalAppData"),
            );
            Machine {
                root,
                hive,
                calls,
                context,
            }
        }

        impl Machine {
            /// 装好一份版本为 `version` 的落樱，返回登记目录。
            fn installed(&self, version: &str) -> String {
                let dir = self.root.path().join("Games").join("Petalfall");
                fs::create_dir_all(&dir).unwrap();
                fs::write(dir.join(APP_EXE), b"MZ").unwrap();
                let dir = dir.to_str().unwrap().to_owned();
                self.hive
                    .set(UNINSTALL_KEY, Some(INSTALL_LOCATION), &format!("\"{dir}\""));
                self.hive.set(UNINSTALL_KEY, Some(DISPLAY_VERSION), version);
                dir
            }

            /// 卸载项写着版本 `version`，程序文件却不在，返回登记目录。
            fn hollow(&self, version: &str) -> String {
                let dir = self.installed(version);
                fs::remove_file(Path::new(&dir).join(APP_EXE)).unwrap();
                dir
            }

            /// 没有安装时的默认目录，也是启动器写不进登记目录时回落的数据根。
            fn default_dir(&self) -> String {
                self.root
                    .path()
                    .join("LocalAppData")
                    .join(APP_FOLDER)
                    .to_str()
                    .unwrap()
                    .to_owned()
            }

            /// 走一遍窗口起不来时的退路，交回结局与弹过的对话框。
            fn fall_back(&self) -> (FallenBack, Vec<Notice>) {
                let mut shown = Vec::new();
                let fallen = self
                    .context
                    .fall_back(|notice| shown.push(notice.clone()))
                    .unwrap();
                (fallen, shown)
            }

            fn openings(&self) -> Vec<(PathBuf, Vec<OsString>)> {
                self.calls.lock().unwrap().openings.clone()
            }

            fn state(&self) -> PathBuf {
                self.context.session.roots().state.clone()
            }

            fn handoff(&self) -> Option<ChannelHandoff> {
                let path = self.state().join(HANDOFF_FILE);
                let bytes = match fs::read(path) {
                    Ok(bytes) => bytes,
                    Err(err) if err.kind() == io::ErrorKind::NotFound => return None,
                    Err(err) => panic!("读交接记录失败：{err}"),
                };
                Some(ChannelHandoff::from_json(&bytes).unwrap())
            }

            fn launches(&self) -> Vec<OsString> {
                self.calls.lock().unwrap().launches.clone()
            }

            /// 什么都没开始：没解开载荷、没拉起 NSIS、没写半装记录、没写交接记录。
            fn assert_untouched(&self, context: &str) {
                assert_eq!(self.launches(), Vec::<OsString>::new(), "{context}");
                assert!(!self.state().join(JOURNAL_FILE).exists(), "{context}");
                assert_eq!(self.handoff(), None, "{context}");
                let unpacked = fs::read_dir(self.root.path().join("temp")).unwrap().count();
                assert_eq!(unpacked, 0, "{context}");
            }
        }

        fn locked(mode: InstallMode) -> InstallPlan {
            InstallPlan {
                mode,
                dir: None,
                desktop_shortcut: false,
            }
        }

        fn fresh_at(dir: &str) -> InstallPlan {
            InstallPlan {
                mode: InstallMode::Fresh,
                dir: Some(dir.to_owned()),
                desktop_shortcut: false,
            }
        }

        fn silent_to(dir: &str) -> OsString {
            OsString::from(format!("/S /D={dir}"))
        }

        /// 安装前复核：探测允许的模式之外的计划一律拒绝，复核前什么都没动。
        #[test]
        fn a_mode_the_probe_did_not_allow_is_refused_before_anything_starts() {
            let machine = machine("review-mode", "1.0.0-dev.6", Launch::Interactive, false);
            machine.installed("1.0.0-dev.5");
            let elsewhere = machine.root.path().join("Elsewhere");
            let probe = machine.context.probe().unwrap();
            assert_eq!(probe.allowed_modes, vec![InstallMode::Upgrade]);

            for plan in [
                locked(InstallMode::Repair),
                locked(InstallMode::Switch),
                fresh_at(elsewhere.to_str().unwrap()),
            ] {
                let refused = machine
                    .context
                    .reviewed_install(&plan, &Recording::default())
                    .unwrap_err();

                assert_eq!(
                    refused,
                    format!("探测允许的安装方式是 [Upgrade]，收到的是 {:?}", plan.mode)
                );
                machine.assert_untouched(&format!("{plan:?}"));
            }
            assert!(!elsewhere.exists());
        }

        #[test]
        fn nothing_is_allowed_before_the_probe() {
            let machine = machine("review-unprobed", "1.0.0-dev.6", Launch::Interactive, false);
            machine.installed("1.0.0-dev.5");

            let refused = machine
                .context
                .reviewed_install(&locked(InstallMode::Upgrade), &Recording::default())
                .unwrap_err();

            assert_eq!(refused, "探测允许的安装方式是 []，收到的是 Upgrade");
            machine.assert_untouched("没探测过");
        }

        /// 探测时数据还读得了，之后用户打开了已装的落樱，记号被它抬高或写坏：复核在开工前拦下。
        #[test]
        fn a_stamp_raised_after_the_probe_stops_the_install() {
            let cases = [
                ("1.0.0-dev.5", "1.0.0-dev.6", InstallMode::Upgrade),
                ("1.1.0-dev.61", "1.0.0-beta.5", InstallMode::Switch),
                ("1.0.0-dev.6", "1.0.0-dev.6", InstallMode::Repair),
            ];
            for (installed, payload, mode) in cases {
                for stamp in [Stamp::TooNew, Stamp::Unreadable] {
                    let test = format!("review-raised-{mode:?}-{stamp:?}");
                    let machine = machine(&test, payload, Launch::Interactive, false);
                    let dir = machine.installed(installed);
                    assert_eq!(machine.context.probe().unwrap().allowed_modes, vec![mode]);
                    stamp.put(&dir);

                    let refused = machine
                        .context
                        .reviewed_install(&locked(mode), &Recording::default())
                        .unwrap_err();

                    assert_eq!(
                        refused,
                        format!("数据格式关没过：{:?}", stamp.block_at(&dir)),
                        "{test}"
                    );
                    machine.assert_untouched(&test);
                }
            }
        }

        /// 首装的最终目录在选目录时才定，复核读的就是计划里的那个目录。
        #[test]
        fn a_fresh_install_is_reviewed_at_the_dir_it_goes_to() {
            for stamp in [Stamp::TooNew, Stamp::Unreadable] {
                let test = format!("review-fresh-{stamp:?}");
                let machine = machine(&test, "1.0.0-dev.6", Launch::Interactive, false);
                let target = machine.root.path().join("Games").join("Petalfall");
                fs::create_dir_all(&target).unwrap();
                let target = target.to_str().unwrap().to_owned();
                stamp.put(&target);
                machine.context.probe().unwrap();

                let refused = machine
                    .context
                    .reviewed_install(&fresh_at(&target), &Recording::default())
                    .unwrap_err();

                assert_eq!(
                    refused,
                    format!("数据格式关没过：{:?}", stamp.block_at(&target)),
                    "{test}"
                );
                machine.assert_untouched(&test);
            }
        }

        #[test]
        fn a_fresh_install_to_a_clean_dir_goes_ahead() {
            let machine = machine(
                "review-fresh-clean",
                "1.0.0-dev.6",
                Launch::Interactive,
                false,
            );
            let target = machine.root.path().join("Games").join("Petalfall");
            let target = target.to_str().unwrap().to_owned();
            machine.context.probe().unwrap();

            machine
                .context
                .reviewed_install(&fresh_at(&target), &Recording::default())
                .unwrap()
                .unwrap();

            assert_eq!(machine.launches(), vec![silent_to(&target)]);
            assert_eq!(machine.handoff(), None);
        }

        /// 交接记录只在交互安装、用户在「换到」页上确认时写（第 2a、5 行），内容是安装包的通道与版本；
        /// 普通升级、修复、首装与更新模式都照常装，但不写。
        #[test]
        fn the_handoff_is_written_only_when_the_user_switches_on_the_page() {
            use Initiation as I;
            use InstallMode as M;
            use order::Channel as C;

            let cases = [
                (
                    "2a",
                    Some("1.0.0-beta.3"),
                    "1.0.0-dev.60",
                    I::Interactive,
                    M::Upgrade,
                    Some(C::Dev),
                ),
                (
                    "5",
                    Some("1.1.0-dev.61"),
                    "1.0.0-beta.5",
                    I::Interactive,
                    M::Switch,
                    Some(C::Beta),
                ),
                (
                    "1",
                    Some("1.0.0-dev.5"),
                    "1.0.0-dev.6",
                    I::Interactive,
                    M::Upgrade,
                    None,
                ),
                (
                    "2b",
                    Some("1.0.0-beta.4"),
                    "1.0.0",
                    I::Interactive,
                    M::Upgrade,
                    None,
                ),
                (
                    "3",
                    Some("1.0.0-dev.6"),
                    "1.0.0-dev.6",
                    I::Interactive,
                    M::Repair,
                    None,
                ),
                (
                    "2a-update",
                    Some("1.0.0-beta.3"),
                    "1.0.0-dev.60",
                    I::Update,
                    M::Upgrade,
                    None,
                ),
                (
                    "5-switch",
                    Some("1.1.0-dev.61"),
                    "1.0.0-beta.5",
                    I::UpdateWithSwitch,
                    M::Switch,
                    None,
                ),
                ("9", None, "1.0.0-dev.6", I::Interactive, M::Fresh, None),
            ];
            for (row, installed, payload, initiation, mode, channel) in cases {
                let (launch, switch) = launch_for(initiation, Vec::new());
                let machine = machine(&format!("handoff-{row}"), payload, launch, switch);
                let dir = match installed {
                    Some(version) => machine.installed(version),
                    None => machine
                        .root
                        .path()
                        .join("Fresh")
                        .to_str()
                        .unwrap()
                        .to_owned(),
                };
                let probe = machine.context.probe().unwrap();
                assert_eq!(probe.allowed_modes, vec![mode], "第 {row} 行");
                let plan = match mode {
                    M::Fresh => fresh_at(&dir),
                    M::Upgrade | M::Repair | M::Switch => locked(mode),
                };

                machine
                    .context
                    .reviewed_install(&plan, &Recording::default())
                    .unwrap()
                    .unwrap();

                assert_eq!(machine.launches(), vec![silent_to(&dir)], "第 {row} 行");
                let written = machine
                    .handoff()
                    .map(|handoff| (handoff.channel, handoff.version.to_string()));
                assert_eq!(
                    written,
                    channel.map(|channel| (channel, payload.to_owned())),
                    "第 {row} 行"
                );
                assert!(
                    !machine.state().join(JOURNAL_FILE).exists(),
                    "第 {row} 行装完要删半装记录"
                );
            }
        }

        fn newer_notice(older: Older, installed: &str, payload: &str, reopens: bool) -> Notice {
            Notice::Newer {
                older,
                installed: installed.to_owned(),
                payload: payload.to_owned(),
                reopens,
            }
        }

        fn too_new_block() -> install_policy::DataBlock {
            install_policy::DataBlock::TooNew {
                recorded: DATA_FORMAT + 1,
                written_by: petalfall_release::data_format::trusted_written_by(RAISED_BY),
            }
        }

        fn unreadable_block() -> install_policy::DataBlock {
            install_policy::DataBlock::Unreadable {
                reason: NO_NUMBER_REASON.to_owned(),
            }
        }

        fn policy_block(stamp: Stamp) -> install_policy::DataBlock {
            match stamp {
                Stamp::TooNew => too_new_block(),
                Stamp::Unreadable => unreadable_block(),
            }
        }

        /// 窗口起不来时，第 5 行、newer 都不交给 NSIS，弹对应的对话框；更新模式下随后按原参数重开登记目录里的启动器。
        #[test]
        fn the_fallback_explains_an_earlier_package_and_never_runs_nsis() {
            use Initiation as I;
            use order::Channel as C;

            let cases = [
                (
                    "5-interactive",
                    "1.1.0-dev.61",
                    "1.0.0-beta.5",
                    I::Interactive,
                    Notice::NeedsWindow { reopens: false },
                ),
                (
                    "5-switch",
                    "1.1.0-dev.61",
                    "1.0.0-beta.5",
                    I::UpdateWithSwitch,
                    Notice::NeedsWindow { reopens: true },
                ),
                (
                    "5-update",
                    "1.1.0-dev.61",
                    "1.0.0-beta.5",
                    I::Update,
                    newer_notice(
                        Older::SlowerChannel {
                            installed: C::Dev,
                            payload: C::Beta,
                        },
                        "1.1.0-dev.61",
                        "1.0.0-beta.5",
                        true,
                    ),
                ),
                (
                    "4",
                    "1.0.0-dev.60",
                    "1.0.0-dev.55",
                    I::Interactive,
                    newer_notice(Older::SameChannel, "1.0.0-dev.60", "1.0.0-dev.55", false),
                ),
                (
                    "6-update",
                    "1.0.0",
                    "1.0.0-beta.4",
                    I::Update,
                    newer_notice(
                        Older::FasterChannel {
                            installed: C::Stable,
                            payload: C::Beta,
                        },
                        "1.0.0",
                        "1.0.0-beta.4",
                        true,
                    ),
                ),
                (
                    "7-switch",
                    "2.0.0-rc.1",
                    "1.0.0",
                    I::UpdateWithSwitch,
                    newer_notice(Older::UnknownChannel, "2.0.0-rc.1", "1.0.0", true),
                ),
            ];
            for (row, installed, payload, initiation, expected) in cases {
                let args = launcher_args();
                let (launch, switch) = launch_for(initiation, args.clone());
                let machine = machine(&format!("fallback-{row}"), payload, launch, switch);
                let dir = machine.installed(installed);

                let (fallen, shown) = machine.fall_back();

                assert_eq!(fallen, FallenBack::Refused, "第 {row} 行");
                assert_eq!(shown, vec![expected.clone()], "第 {row} 行");
                let reopened = match initiation {
                    I::Interactive => vec![],
                    I::Update | I::UpdateWithSwitch => vec![(PathBuf::from(&dir), args)],
                };
                assert_eq!(machine.openings(), reopened, "第 {row} 行");
                machine.assert_untouched(&format!("第 {row} 行"));
            }
        }

        /// 数据格式关在原生回退上同样先于一切；首装按默认目录判，没有登记安装时没有启动器可重开。
        #[test]
        fn the_fallback_stops_at_the_data_gate() {
            for stamp in [Stamp::TooNew, Stamp::Unreadable] {
                for initiation in INITIATIONS {
                    let test = format!("fallback-data-{stamp:?}-{initiation:?}");
                    let args = launcher_args();
                    let (launch, switch) = launch_for(initiation, args.clone());
                    let machine = machine(&test, "1.0.0-dev.6", launch, switch);
                    let dir = machine.installed("1.0.0-dev.5");
                    stamp.put(&dir);

                    let (fallen, shown) = machine.fall_back();

                    let reopens = initiation != Initiation::Interactive;
                    assert_eq!(fallen, FallenBack::Refused, "{test}");
                    assert_eq!(
                        shown,
                        vec![Notice::DataBlocked {
                            block: policy_block(stamp),
                            stamp: stamp_path(&dir),
                            payload: "1.0.0-dev.6".to_owned(),
                            reopens,
                        }],
                        "{test}"
                    );
                    let reopened = if reopens {
                        vec![(PathBuf::from(&dir), args)]
                    } else {
                        vec![]
                    };
                    assert_eq!(machine.openings(), reopened, "{test}");
                    machine.assert_untouched(&test);

                    let fresh = format!("fallback-fresh-{stamp:?}-{initiation:?}");
                    let (launch, switch) = launch_for(initiation, launcher_args());
                    let machine = machine_on_clean(&fresh, launch, switch);
                    let default_dir = machine.default_dir();
                    fs::create_dir_all(&default_dir).unwrap();
                    stamp.put(&default_dir);

                    let (fallen, shown) = machine.fall_back();

                    assert_eq!(fallen, FallenBack::Refused, "{fresh}");
                    assert_eq!(
                        shown,
                        vec![Notice::DataBlocked {
                            block: policy_block(stamp),
                            stamp: stamp_path(&default_dir),
                            payload: "1.0.0-dev.6".to_owned(),
                            reopens: false,
                        }],
                        "{fresh}"
                    );
                    assert_eq!(machine.openings(), vec![], "{fresh}");
                    machine.assert_untouched(&fresh);
                }
            }
        }

        fn machine_on_clean(test: &str, launch: Launch, channel_switch: bool) -> Machine {
            machine(test, "1.0.0-dev.6", launch, channel_switch)
        }

        /// 卸载留下的目录优先当首装的默认目录，数据格式关也读它。
        #[test]
        fn the_fallback_reads_the_dir_an_uninstall_left_behind() {
            let machine = machine_on_clean("fallback-leftover", Launch::Interactive, false);
            let leftover = machine.root.path().join("Old").join("Petalfall");
            fs::create_dir_all(&leftover).unwrap();
            fs::write(leftover.join(CONFIG_FILE), b"{}").unwrap();
            let leftover = leftover.to_str().unwrap().to_owned();
            machine.hive.set(LAST_DIR_KEY, None, &leftover);
            Stamp::Unreadable.put(&leftover);

            let (fallen, shown) = machine.fall_back();

            assert_eq!(fallen, FallenBack::Refused);
            assert_eq!(
                shown,
                vec![Notice::DataBlocked {
                    block: unreadable_block(),
                    stamp: stamp_path(&leftover),
                    payload: "1.0.0-dev.6".to_owned(),
                    reopens: false,
                }]
            );
            machine.assert_untouched("卸载留下的目录");
        }

        /// 首装、第 1、2a、2b 行的升级、第 3 与第 8 行的修复交给 NSIS，参数与原来相同；没有「换到」页，第 2a 行
        /// 也不写交接记录。
        #[test]
        fn the_fallback_hands_the_rest_to_nsis_without_a_handoff() {
            use Initiation as I;

            let cases = [
                ("1", Some(("1.0.0-dev.5", true)), "1.0.0-dev.6", I::Update),
                (
                    "2a",
                    Some(("1.0.0-beta.3", true)),
                    "1.0.0-dev.60",
                    I::Interactive,
                ),
                (
                    "2a-update",
                    Some(("1.0.0-beta.3", true)),
                    "1.0.0-dev.60",
                    I::Update,
                ),
                ("2b", Some(("1.0.0-beta.4", true)), "1.0.0", I::Interactive),
                (
                    "3",
                    Some(("1.0.0-dev.6", true)),
                    "1.0.0-dev.6",
                    I::UpdateWithSwitch,
                ),
                (
                    "8",
                    Some(("1.0.0-dev.9", false)),
                    "1.0.0-dev.6",
                    I::Interactive,
                ),
                ("9", None, "1.0.0-dev.6", I::Update),
            ];
            for (row, installed, payload, initiation) in cases {
                let (launch, switch) = launch_for(initiation, launcher_args());
                let expected = fallback_arguments(&launch);
                let machine = machine(&format!("fallback-nsis-{row}"), payload, launch, switch);
                match installed {
                    Some((version, true)) => {
                        machine.installed(version);
                    }
                    Some((version, false)) => {
                        machine.hollow(version);
                    }
                    None => {}
                }

                let (fallen, shown) = machine.fall_back();

                assert_eq!(fallen, FallenBack::Ran(0), "第 {row} 行");
                assert_eq!(shown, vec![], "第 {row} 行");
                assert_eq!(machine.launches(), vec![expected], "第 {row} 行");
                assert_eq!(machine.handoff(), None, "第 {row} 行");
                assert_eq!(machine.openings(), vec![], "第 {row} 行");
            }
        }

        /// 失败页的「改用标准安装程序」：探测只允许换通道或什么都不允许、或此刻数据过不了关时，以字符串拒绝。
        #[test]
        fn the_wizard_button_is_refused_without_a_mode_nsis_could_install() {
            let switch_only = machine("wizard-switch", "1.0.0-beta.5", Launch::Interactive, false);
            switch_only.installed("1.1.0-dev.61");
            assert_eq!(
                switch_only.context.probe().unwrap().allowed_modes,
                vec![InstallMode::Switch]
            );
            assert_eq!(
                switch_only.context.start_wizard().unwrap_err(),
                "探测允许的安装方式是 [Switch]"
            );
            switch_only.assert_untouched("只允许换通道");

            let nothing = machine("wizard-nothing", "1.0.0-dev.55", Launch::Interactive, false);
            nothing.installed("1.0.0-dev.60");
            nothing.context.probe().unwrap();
            assert_eq!(
                nothing.context.start_wizard().unwrap_err(),
                "探测允许的安装方式是 []"
            );
            nothing.assert_untouched("什么都不允许");
        }

        /// 探测时数据还读得了，失败之后再点「改用标准安装程序」时记号已被抬高：此刻的判定拦下。
        #[test]
        fn the_wizard_button_is_refused_once_the_data_moved_past_the_package() {
            let machine = machine("wizard-raised", "1.0.0-dev.6", Launch::Interactive, false);
            let dir = machine.installed("1.0.0-dev.5");
            machine.context.probe().unwrap();
            Stamp::TooNew.put(&dir);

            let refused = machine.context.start_wizard().unwrap_err();

            let notice = Notice::DataBlocked {
                block: too_new_block(),
                stamp: stamp_path(&dir),
                payload: "1.0.0-dev.6".to_owned(),
                reopens: false,
            };
            assert_eq!(refused, format!("{notice:?}"));
            machine.assert_untouched("记号被抬高");
        }

        #[test]
        fn the_wizard_button_runs_the_bare_wizard_for_an_upgrade() {
            let machine = machine("wizard-upgrade", "1.0.0-dev.6", Launch::Interactive, false);
            machine.installed("1.0.0-dev.5");
            machine.context.probe().unwrap();

            machine.context.start_wizard().unwrap();

            assert_eq!(machine.context.wait_for_wizard().unwrap(), Some(0));
            assert_eq!(machine.launches(), vec![OsString::new()]);
            assert_eq!(machine.handoff(), None);
        }

        /// 每一个能装的入口：窗口里按任一模式安装、改用标准安装程序、窗口起不来时的原生回退。
        fn assert_no_entry_installs(machine: &Machine, context: &str) {
            let elsewhere = machine.root.path().join("Elsewhere").join("Petalfall");
            for plan in [
                fresh_at(elsewhere.to_str().unwrap()),
                fresh_at(&machine.default_dir()),
                locked(InstallMode::Upgrade),
                locked(InstallMode::Repair),
                locked(InstallMode::Switch),
            ] {
                let refused = machine
                    .context
                    .reviewed_install(&plan, &Recording::default());
                assert!(refused.is_err(), "{context}，{plan:?}：{refused:?}");
            }
            assert!(machine.context.start_wizard().is_err(), "{context}");
            let (fallen, shown) = machine.fall_back();
            assert_eq!(fallen, FallenBack::Refused, "{context}");
            assert_eq!(shown.len(), 1, "{context}");
            machine.assert_untouched(context);
        }

        /// 底线之一：同通道或更快通道上的旧包，交互、自动更新、带换通道开关的更新都装不了，经哪个入口都一样。
        #[test]
        fn an_earlier_package_on_the_same_or_a_faster_channel_installs_through_no_entry() {
            let cases = [
                (
                    "same",
                    "1.0.0-dev.60",
                    "1.0.0-dev.55",
                    NewerReason::SameChannel,
                ),
                (
                    "faster",
                    "1.0.0",
                    "1.0.0-beta.4",
                    NewerReason::FasterChannel,
                ),
                (
                    "faster-dev",
                    "1.1.0-beta.1",
                    "1.0.0-dev.60",
                    NewerReason::FasterChannel,
                ),
            ];
            for (name, installed, payload, reason) in cases {
                for initiation in INITIATIONS {
                    let test = format!("floor-older-{name}-{initiation:?}");
                    let (launch, switch) = launch_for(initiation, launcher_args());
                    let machine = machine(&test, payload, launch, switch);
                    machine.installed(installed);

                    let probe = machine.context.probe().unwrap();

                    assert_eq!(probe.allowed_modes, Vec::new(), "{test}");
                    assert_eq!(probe.unattended, None, "{test}");
                    assert_eq!(probe.newer_reason, Some(reason), "{test}");
                    assert_no_entry_installs(&machine, &test);
                }
            }
        }

        /// 底线之二：数据比安装包新或记号读不懂时，升级、换通道、修复、首装都装不了，经哪个入口都一样。
        #[test]
        fn data_newer_than_the_package_or_unreadable_installs_through_no_entry() {
            let rows = [
                ("1", Some("1.0.0-dev.5"), "1.0.0-dev.6"),
                ("5", Some("1.1.0-dev.61"), "1.0.0-beta.5"),
                ("3", Some("1.0.0-dev.6"), "1.0.0-dev.6"),
                ("9", None, "1.0.0-dev.6"),
            ];
            for (row, installed, payload) in rows {
                for stamp in [Stamp::TooNew, Stamp::Unreadable] {
                    for initiation in INITIATIONS {
                        let test = format!("floor-data-{row}-{stamp:?}-{initiation:?}");
                        let (launch, switch) = launch_for(initiation, launcher_args());
                        let machine = machine(&test, payload, launch, switch);
                        let data_root = match installed {
                            Some(version) => machine.installed(version),
                            None => {
                                let dir = machine.default_dir();
                                fs::create_dir_all(&dir).unwrap();
                                dir
                            }
                        };
                        stamp.put(&data_root);
                        let elsewhere = machine.root.path().join("Elsewhere").join("Petalfall");
                        fs::create_dir_all(&elsewhere).unwrap();
                        stamp.put(elsewhere.to_str().unwrap());

                        let probe = machine.context.probe().unwrap();

                        match installed {
                            Some(_) => {
                                assert_eq!(probe.allowed_modes, Vec::new(), "{test}");
                                assert_eq!(
                                    probe.data_block,
                                    Some(stamp.block_at(&data_root)),
                                    "{test}"
                                );
                            }
                            // 首装的数据关在最终目录上做，探测只给首装
                            None => {
                                assert_eq!(probe.allowed_modes, vec![InstallMode::Fresh], "{test}")
                            }
                        }
                        assert_eq!(probe.unattended, None, "{test}");
                        assert!(!probe.handoff, "{test}");
                        assert_no_entry_installs(&machine, &test);
                    }
                }
            }
        }
    }
}
