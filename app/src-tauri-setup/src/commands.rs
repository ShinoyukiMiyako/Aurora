//! 前端命令：把契约里的命令接到各模块。判定都在模块里，这里只管线程和这次启动要记住的东西。
//!
//! 不带 `async` 的命令跑在窗口线程上。碰盘、等进程的活都走 [`on_worker`]，否则窗口会跟着卡住。
//! 除 `install` 外，拒绝一律是字符串：前端把它们当意外，进致命错误页显示原文。

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
use tauri::ipc::InvokeError;
use tauri::{AppHandle, Emitter, State, WebviewWindow};

use crate::boot::{self, Instance};
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
use crate::runner::{Reporter, Session, StandardRun, Target};
use crate::target::{self, APP_FOLDER, SpaceNeed, SystemEnv, TargetEnv};

/// 探测时认定、之后的命令还要用的目录。
#[derive(Debug, Default)]
struct Located {
    /// 升级和修复的目录，前端的计划里不带。
    registered: Option<String>,
    /// 已知属于落樱的目录，校验时不能当成别人的：默认目录（启动器回落的数据目录），以及探测换上的半装记录或卸载残留。
    own: Vec<String>,
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

    pub fn install(&self, plan: &InstallPlan, reporter: &dyn Reporter) -> Result<(), Failure> {
        let registered = self
            .located
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .registered
            .clone();
        let target = Target::from_plan(plan, registered.as_deref())?;
        self.log.info(format_args!("开始安装：{target:?}"));
        self.installing.store(true, Ordering::Release);
        let outcome = self.session.install(&target, reporter);
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
    pub fn start_wizard(&self) -> Result<(), Failure> {
        self.start_standard(OsStr::new(""))
    }

    /// 窗口起不来时的退路，参数见 [`fallback_arguments`]。同样不等结束。
    pub fn start_fallback(&self) -> Result<(), Failure> {
        self.start_standard(&fallback_arguments(&self.launch))
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

/// 拒绝分两种：[`Failure`] 是安装结果，前端进失败页；工作线程崩了是字符串，前端进致命错误页。
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
    tauri::async_runtime::spawn_blocking(move || context.install(&plan, &reporter))
        .await
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

                let probe =
                    assemble_with(&registry, payload, Recovery::Clean, started(initiation)).probe;

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
        assert!(main.contains("context.start_fallback()?"));
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

            assert_eq!(rig.context.wait_for_wizard().unwrap(), None);
            rig.context.start_wizard().unwrap();
            assert_eq!(rig.context.wait_for_wizard().unwrap(), Some(0));
            assert_eq!(rig.context.wait_for_wizard().unwrap(), None);
            assert!(rig.logged().contains("原生向导已退出：0"));
        }

        #[test]
        fn the_wizard_button_stays_a_bare_wizard_during_an_update() {
            let rig = launched("wizard-update", update(true, launcher_args()));

            rig.context.start_wizard().unwrap();
            assert_eq!(rig.context.wait_for_wizard().unwrap(), Some(0));

            assert_eq!(rig.received.lock().unwrap().launches, [OsString::new()]);
        }

        #[test]
        fn the_fallback_of_an_update_runs_nsis_with_the_plugin_arguments() {
            let args = launcher_args();
            let nonce = args[0].to_str().unwrap().to_owned();
            let rig = launched("fallback-update", update(true, args));

            rig.context.start_fallback().unwrap();
            assert_eq!(rig.context.wait_for_wizard().unwrap(), Some(0));

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

            rig.context.start_fallback().unwrap();
            assert_eq!(rig.context.wait_for_wizard().unwrap(), Some(0));

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
}
