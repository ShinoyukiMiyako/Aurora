//! 安装流程：解开载荷、落半装记录、静默运行 NSIS、报进度、事后核验。
//!
//! NSIS 在 /S 下没有进度通道、没有取消、也不说失败原因，这里只从外部观察：目标目录给里程碑，里程碑之间走时间模型。
//! 路径根、注册表和进程启动都经 [`Session`] 注入，测试和假载荷不碰真实位置。

#[cfg(debug_assertions)]
pub mod fake;

use std::ffi::{OsStr, OsString};
use std::fs::{self, File};
use std::io::{self, ErrorKind, Write};
use std::os::windows::ffi::OsStringExt;
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use petalfall_release::handoff::{ChannelHandoff, HANDOFF_FILE};
use petalfall_release::order::Channel;
use petalfall_setup_payload::Header;
use semver::Version;
use windows_sys::Win32::System::Com::CoTaskMemFree;
use windows_sys::Win32::UI::Shell::{FOLDERID_Desktop, KF_FLAG_DONT_VERIFY, SHGetKnownFolderPath};
use windows_sys::core::{GUID, PWSTR};

use crate::boot::Instance;
use crate::contract::{Failure, FailureCode, InstallMode, InstallPlan, Phase, Progress};
use crate::existing::{APP_EXE, CurrentUserRegistry, Registry};
use crate::extract::{
    BACKOFF, Extracted, Sweep, extract, io_failure, retry_transient, sweep_stale,
};
use crate::journal::{self, Journal, JournalStore, Processes, Recovery, SystemProcesses};
use crate::launcher::{self, Opened};
use crate::log::{self, SetupLog};
use crate::overlay::Source;
use crate::target::{SpaceNeed, SystemEnv, TargetEnv, Volume, write_fault};
use crate::verify::{self, Expected, UNINSTALLER_NAME, verify};

pub const SHORTCUT_NAME: &str = "Petalfall.lnk";
const HANDOFF_TEMP_FILE: &str = "channel-handoff.json.tmp";

const POLL: Duration = Duration::from_millis(100);
/// NSIS 3.10 打开自身撞上杀软扫描时不重试，直接以 2 退出，这种退出来得很快。
const QUICK_EXIT: Duration = Duration::from_secs(2);
const PAYLOAD_ABORTED: i32 = 2;

const EXTRACTED_PERCENT: f64 = 4.0;
const MODEL_CEILING: f64 = 92.0;
const MODEL_STEEPNESS: f64 = 2.5;
/// 解压速度的保守估计：LZMA 在 2 GHz 机器上的官方口径是 10 到 20 MB/s。
const MODEL_BYTES_PER_SECOND: f64 = 12.0 * 1024.0 * 1024.0;
const EXE_WRITTEN_PERCENT: f64 = 96.0;
const UNINSTALLER_WRITTEN_PERCENT: f64 = 98.0;
const EXITED_PERCENT: f64 = 99.0;
const VERIFIED_PERCENT: f64 = 100.0;
const SLOW_AFTER: Duration = Duration::from_secs(20);

/// 安装用到的路径根。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Roots {
    /// 解开载荷的地方。
    pub temp: PathBuf,
    /// 半装记录和日志的目录。
    pub state: PathBuf,
    /// 用户桌面。
    pub desktop: PathBuf,
}

impl Roots {
    pub fn system() -> io::Result<Self> {
        Ok(Self {
            temp: std::env::temp_dir(),
            state: log::default_root()?,
            desktop: known_folder(&FOLDERID_Desktop)?,
        })
    }
}

fn known_folder(id: &GUID) -> io::Result<PathBuf> {
    let mut raw: PWSTR = std::ptr::null_mut();
    // 不验证文件夹在不在：桌面被重定向到断开的位置时，验证失败会让整个安装包起不来，向导回退也走不到，
    // 而它只用来删一个快捷方式
    let status = unsafe {
        SHGetKnownFolderPath(
            id,
            KF_FLAG_DONT_VERIFY as u32,
            std::ptr::null_mut(),
            &mut raw,
        )
    };
    let path = (status >= 0).then(|| {
        let len = (0..).take_while(|&at| unsafe { *raw.add(at) } != 0).count();
        PathBuf::from(OsString::from_wide(unsafe {
            std::slice::from_raw_parts(raw, len)
        }))
    });
    // 这个 API 要求调用方释放缓冲区，失败时也一样
    unsafe { CoTaskMemFree(raw.cast()) };
    path.ok_or_else(|| io::Error::from_raw_os_error(status))
}

/// 拼 NSIS 的参数。整串走 `raw_arg`：`Command::arg` 遇空格会加引号，而 NSIS 只认
/// 不带引号、放在最后的 `/D=`，认不出时不报错，静默装到默认目录。
///
/// 升级和修复也带 /D=，目录就是探测到、界面显示、事后核验的那个登记目录。只传 /S 时 NSIS 从
/// [`crate::existing::LAST_DIR_KEY`]（`HKCU\Software\<发布者>\Petalfall`）还原目录，不看卸载项的
/// `InstallLocation`：这个键被清理工具删掉时装进默认目录，和卸载项不一致时装进键里记的目录，两种都是
/// 另装一份并把登记改指过去，原来那份连同数据成了孤儿，核验也永远过不了。传的是原登记目录，所以登记不会
/// 被改指别处。
/// 不传 /UPDATE、/P、/R、/NS：GetOptions 按前缀匹配，多传一个就多一处误触发。
pub fn nsis_arguments(dir: &Path) -> OsString {
    let mut arguments = OsString::from("/S /D=");
    arguments.push(dir);
    arguments
}

/// 工作目录放进私有临时目录：既不占着用户的下载目录，也让子进程搜不到那里的 DLL。
fn payload_command(exe: &Path, cwd: &Path, arguments: &OsStr) -> Command {
    let mut command = Command::new(exe);
    command
        .current_dir(cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    if !arguments.is_empty() {
        command.raw_arg(arguments);
    }
    command
}

/// 运行中的载荷。
pub trait Running: Send {
    fn pid(&self) -> u32;
    fn try_wait(&mut self) -> io::Result<Option<i32>>;
}

/// 启动载荷的口子：测试和假载荷都从这里替换掉真实进程。
pub trait Launcher: Send + Sync {
    fn launch(&self, exe: &Path, cwd: &Path, arguments: &OsStr) -> io::Result<Box<dyn Running>>;

    /// 这次安装实际落到哪里。假载荷在这里把写入关进沙箱。
    fn resolve_instdir(&self, requested: &Path) -> PathBuf {
        requested.to_owned()
    }

    /// 启动器开着没有。
    fn app_running(&self) -> io::Result<bool> {
        launcher::is_running()
    }

    /// 打开装好的启动器，`args` 原样交给它。
    fn open_app(&self, dir: &Path, args: &[OsString], instance: &Instance) -> io::Result<Opened> {
        launcher::open(dir, args, instance)
    }

    /// 目标目录所在的卷。
    fn target_volume(&self, dir: &Path) -> io::Result<Volume> {
        SystemEnv.volume(dir)
    }
}

pub struct SystemLauncher;

impl Launcher for SystemLauncher {
    fn launch(&self, exe: &Path, cwd: &Path, arguments: &OsStr) -> io::Result<Box<dyn Running>> {
        Ok(Box::new(ChildRun(
            payload_command(exe, cwd, arguments).spawn()?,
        )))
    }
}

struct ChildRun(Child);

impl Running for ChildRun {
    fn pid(&self) -> u32 {
        self.0.id()
    }

    fn try_wait(&mut self) -> io::Result<Option<i32>> {
        Ok(self
            .0
            .try_wait()?
            .map(|status| status.code().expect("Windows 上进程总有退出码")))
    }
}

/// 进度和日志的出口。`progress` 接 `setup://progress` 事件，`note` 接日志文件。
pub trait Reporter: Send + Sync {
    fn progress(&self, progress: Progress);
    fn note(&self, line: &str);
}

/// 没有窗口时的出口：原生向导走这里，进度也只能留在日志里。
impl Reporter for SetupLog {
    fn progress(&self, progress: Progress) {
        self.info(format_args!("进度：{progress:?}"));
    }

    fn note(&self, line: &str) {
        self.info(line);
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct Milestones {
    pub exe_written: bool,
    pub uninstaller_written: bool,
}

/// 里程碑之间的估计：`92*(1-exp(-2.5t/T))`，`T = exe_len / 12 MiB/s`。
pub fn time_model(elapsed: Duration, exe_len: u64) -> f64 {
    // 长度来自文件头，头坏成 0 时不能除出 NaN：NaN 过 JSON 到前端就成了 null
    let expected_seconds = (exe_len as f64 / MODEL_BYTES_PER_SECOND).max(f64::MIN_POSITIVE);
    MODEL_CEILING * (1.0 - (-MODEL_STEEPNESS * elapsed.as_secs_f64() / expected_seconds).exp())
}

/// 把各路信号折成单调的百分比：时间模型和里程碑谁也不能让进度条倒退。
#[derive(Debug, Clone, PartialEq)]
pub struct ProgressMeter {
    exe_len: u64,
    percent: f64,
}

impl ProgressMeter {
    pub fn new(exe_len: u64) -> Self {
        Self {
            exe_len,
            percent: 0.0,
        }
    }

    fn advance(&mut self, phase: Phase, percent: f64, slow: bool) -> Progress {
        self.percent = self.percent.max(percent);
        Progress {
            phase,
            percent: self.percent,
            slow,
        }
    }

    pub fn begin(&mut self) -> Progress {
        self.advance(Phase::Unpack, 0.0, false)
    }

    pub fn unpacked(&mut self) -> Progress {
        self.advance(Phase::Unpack, EXTRACTED_PERCENT, false)
    }

    pub fn tick(&mut self, elapsed: Duration, milestones: Milestones) -> Progress {
        let mut percent = time_model(elapsed, self.exe_len);
        if milestones.exe_written {
            percent = percent.max(EXE_WRITTEN_PERCENT);
        }
        if milestones.uninstaller_written {
            percent = percent.max(UNINSTALLER_WRITTEN_PERCENT);
        }
        self.advance(Phase::Write, percent, elapsed > SLOW_AFTER)
    }

    pub fn exited(&mut self) -> Progress {
        self.advance(Phase::Verify, EXITED_PERCENT, false)
    }

    pub fn verified(&mut self) -> Progress {
        self.advance(Phase::Verify, VERIFIED_PERCENT, false)
    }
}

/// 轮询拿不到长度只是少一个里程碑，核验才是定论，这里不算错。
fn file_len(path: &Path) -> Option<u64> {
    fs::metadata(path).ok().map(|metadata| metadata.len())
}

/// 从目标目录看里程碑。覆盖安装时旧文件已经在了：同版本重装的 exe 一开始就是目标长度，
/// 要先看到它变过才算写完，否则进度一上来就跳到 96。旧的 uninstall.exe 同理不算出现。
struct TargetWatch {
    exe: PathBuf,
    uninstaller: PathBuf,
    exe_len: u64,
    exe_is_old: bool,
    uninstaller_is_old: bool,
}

impl TargetWatch {
    fn new(instdir: &Path, exe_len: u64) -> Self {
        let exe = instdir.join(APP_EXE);
        let uninstaller = instdir.join(UNINSTALLER_NAME);
        Self {
            exe_is_old: file_len(&exe) == Some(exe_len),
            uninstaller_is_old: file_len(&uninstaller).is_some(),
            exe,
            uninstaller,
            exe_len,
        }
    }

    fn observe(&mut self) -> Milestones {
        let exe_len = file_len(&self.exe);
        if exe_len != Some(self.exe_len) {
            self.exe_is_old = false;
        }
        Milestones {
            exe_written: !self.exe_is_old && exe_len == Some(self.exe_len),
            uninstaller_written: !self.uninstaller_is_old && file_len(&self.uninstaller).is_some(),
        }
    }
}

fn dir_state(instdir: &Path) -> (Option<u64>, Option<u64>) {
    (
        file_len(&instdir.join(APP_EXE)),
        file_len(&instdir.join(UNINSTALLER_NAME)),
    )
}

/// 一次安装的目标。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Target {
    pub mode: InstallMode,
    pub instdir: PathBuf,
    pub desktop_shortcut: bool,
}

impl Target {
    /// 首装的目录来自计划，升级、修复和换通道来自注册登记的目录（`Existing.dir`），计划里不带。
    pub fn from_plan(plan: &InstallPlan, registered_dir: Option<&str>) -> Result<Self, Failure> {
        let dir = match plan.mode {
            InstallMode::Fresh => plan.dir.as_deref(),
            InstallMode::Upgrade | InstallMode::Repair | InstallMode::Switch => registered_dir,
        };
        let Some(dir) = dir else {
            return Err(Failure {
                code: FailureCode::DirUnwritable,
                detail: format!("{:?} 安装没有目标目录", plan.mode),
            });
        };
        Ok(Self {
            mode: plan.mode,
            instdir: PathBuf::from(dir),
            desktop_shortcut: plan.desktop_shortcut,
        })
    }
}

/// 用户在「换到」页上确认之后要留给启动器的交接记录：换到的通道与这次装的版本。写入时刻在落盘时取。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Handoff {
    pub channel: Channel,
    pub version: Version,
}

/// 非静默运行的载荷：NSIS 自己的界面接管，引导程序只负责清掉临时文件。
pub struct StandardRun {
    running: Box<dyn Running>,
    extracted: Extracted,
    poll: Duration,
}

impl StandardRun {
    pub fn pid(&self) -> u32 {
        self.running.pid()
    }

    /// 阻塞到向导退出。引导程序提前退出也不会杀掉向导，只是临时目录留给下次清扫。
    pub fn wait_and_clean(mut self, reporter: &dyn Reporter) -> io::Result<i32> {
        let code = loop {
            if let Some(code) = self.running.try_wait()? {
                break code;
            }
            thread::sleep(self.poll);
        };
        if let Err(err) = self.extracted.cleanup() {
            reporter.note(&format!("清理临时目录失败：{err}"));
        }
        Ok(code)
    }
}

pub struct Session {
    source: Source,
    roots: Roots,
    launcher: Box<dyn Launcher>,
    registry: Arc<dyn Registry>,
    processes: Box<dyn Processes>,
    poll: Duration,
    quick_exit: Duration,
    /// 交接记录的写入时刻从这里取，测试换成固定值。
    clock: fn() -> SystemTime,
}

impl Session {
    pub fn new(
        source: Source,
        roots: Roots,
        launcher: Box<dyn Launcher>,
        registry: Arc<dyn Registry>,
        processes: Box<dyn Processes>,
    ) -> Self {
        Self {
            source,
            roots,
            launcher,
            registry,
            processes,
            poll: POLL,
            quick_exit: QUICK_EXIT,
            clock: SystemTime::now,
        }
    }

    /// 按载荷来源接上真实环境，假载荷接沙箱。
    pub fn open(source: Source) -> io::Result<Self> {
        #[cfg(debug_assertions)]
        let source = match source {
            Source::Fake(fake) => {
                return fake::session(fake, &std::env::temp_dir().join(fake::SANDBOX_DIR));
            }
            packed => packed,
        };
        Ok(Self::new(
            source,
            Roots::system()?,
            Box::new(SystemLauncher),
            Arc::new(CurrentUserRegistry),
            Box::new(SystemProcesses),
        ))
    }

    pub fn header(&self) -> &Header {
        self.source.header()
    }

    pub fn roots(&self) -> &Roots {
        &self.roots
    }

    pub fn registry(&self) -> &dyn Registry {
        self.registry.as_ref()
    }

    pub fn launcher_running(&self) -> io::Result<bool> {
        self.launcher.app_running()
    }

    /// 打开启动器，等它的窗口出现。`args` 原样交给启动器：更新完要把它更新前的参数带回去。会阻塞，放在工作线程上调。
    pub fn open_launcher(
        &self,
        dir: &Path,
        args: &[OsString],
        instance: &Instance,
    ) -> io::Result<Opened> {
        self.launcher.open_app(dir, args, instance)
    }

    fn journal_store(&self) -> JournalStore {
        JournalStore::new(&self.roots.state)
    }

    /// 先写临时文件、刷盘、再改名，同半装记录：启动器只该读到完整的一份。交回写进去的内容，给日志用。
    fn write_handoff(&self, handoff: &Handoff) -> io::Result<String> {
        let written_at = (self.clock)()
            .duration_since(UNIX_EPOCH)
            .map_err(io::Error::other)?
            .as_secs();
        let contents = ChannelHandoff {
            channel: handoff.channel,
            version: handoff.version.clone(),
            written_at,
        }
        .to_json();
        fs::create_dir_all(&self.roots.state)?;
        let temp = self.roots.state.join(HANDOFF_TEMP_FILE);
        let mut file = File::create(&temp)?;
        file.write_all(contents.as_bytes())?;
        file.sync_all()?;
        drop(file);
        fs::rename(temp, self.roots.state.join(HANDOFF_FILE))?;
        Ok(contents)
    }

    /// 清掉上次崩溃留下的临时目录。
    pub fn sweep(&self) -> io::Result<Sweep> {
        sweep_stale(&self.roots.temp, SystemTime::now())
    }

    /// 判定上次安装的结局。载荷还活着时会一直等，要放在工作线程上调。
    pub fn recover(&self) -> io::Result<Recovery> {
        let header = self.header();
        journal::recover(
            &self.journal_store(),
            self.processes.as_ref(),
            self.poll,
            |journal| {
                verify(
                    &Expected::for_journal(journal, header),
                    self.registry.as_ref(),
                )
            },
        )
    }

    fn extract(&self) -> Result<Extracted, Failure> {
        let payload = self
            .source
            .payload()
            .map_err(|err| io_failure("读取载荷", &err))?;
        extract(payload, self.header(), &self.roots.temp)
    }

    fn launch(
        &self,
        extracted: &Extracted,
        arguments: &OsStr,
    ) -> Result<Box<dyn Running>, Failure> {
        retry_transient(&BACKOFF, || {
            self.launcher
                .launch(extracted.path(), extracted.dir(), arguments)
        })
        .map_err(|err| io_failure("启动载荷", &err))
    }

    /// 解开载荷，带着 `arguments` 启动 NSIS 自己的界面，参数整串原样走 `raw_arg`。空串是原生向导；
    /// 窗口起不来时的更新也走这里，带上插件给的那串参数，交给 NSIS 自己的更新流程。
    pub fn start_standard(&self, arguments: &OsStr) -> Result<StandardRun, Failure> {
        let extracted = self.extract()?;
        let running = self.launch(&extracted, arguments)?;
        Ok(StandardRun {
            running,
            extracted,
            poll: self.poll,
        })
    }

    fn wait_for_exit(
        &self,
        running: &mut dyn Running,
        watch: &mut TargetWatch,
        meter: &mut ProgressMeter,
        started: Instant,
        reporter: &dyn Reporter,
    ) -> Result<i32, Failure> {
        loop {
            if let Some(code) = running
                .try_wait()
                .map_err(|err| io_failure("等待载荷", &err))?
            {
                return Ok(code);
            }
            reporter.progress(meter.tick(started.elapsed(), watch.observe()));
            thread::sleep(self.poll);
        }
    }

    fn run_payload(
        &self,
        target: &Target,
        handoff: Option<&Handoff>,
        instdir: &Path,
        extracted: &Extracted,
        meter: &mut ProgressMeter,
        reporter: &dyn Reporter,
    ) -> Result<i32, Failure> {
        let header = self.header();
        // 交接记录先于半装记录：它写不成时什么都还没动，没有半装记录，安装目录也没碰；先落半装记录再失败的话，
        // 下次启动会把一次没开始的安装认成半装。记录写成而后面失败时不撤回：启动器只采用版本与自己相同的记录
        if let Some(handoff) = handoff {
            let contents = self
                .write_handoff(handoff)
                .map_err(|err| io_failure("写交接记录", &err))?;
            reporter.note(&format!("交接记录已写入：{contents}"));
        }
        let store = self.journal_store();
        let mut journal =
            Journal::begin(instdir, target.mode == InstallMode::Fresh, &header.version);
        // 记录要赶在载荷动手之前落盘；没有记录就启动的话，断电后没人认得出这个半装
        store
            .save(&journal)
            .map_err(|err| io_failure("写半装记录", &err))?;

        let arguments = nsis_arguments(instdir);
        reporter.note(&format!("载荷参数：{}", arguments.display()));
        let before = dir_state(instdir);
        let mut watch = TargetWatch::new(instdir, header.exe_len);
        let started = Instant::now();
        let mut retried = false;
        loop {
            let attempt = Instant::now();
            let mut running = self.launch(extracted, &arguments)?;
            reporter.note(&format!("载荷已启动，pid {}", running.pid()));
            journal.payload_pid = Some(running.pid());
            // 载荷已经在写了，不能因此中止；缺 pid 的记录下次只是不等它
            if let Err(err) = store.save(&journal) {
                reporter.note(&format!("更新半装记录失败：{err}"));
            }

            let code =
                self.wait_for_exit(running.as_mut(), &mut watch, meter, started, reporter)?;
            let quick = attempt.elapsed() < self.quick_exit;
            if code == PAYLOAD_ABORTED && quick && !retried && dir_state(instdir) == before {
                retried = true;
                reporter.note("载荷很快以 2 退出且目标目录没动，重试一次");
                continue;
            }
            return Ok(code);
        }
    }

    /// 退出码不是 0 时的结论。目标盘上查得出原因就按原因报，退出码留在 detail 里给反馈用；查不出才是 payload_exit。
    fn exit_failure(&self, code: i32, instdir: &Path, reporter: &dyn Reporter) -> Failure {
        let header = self.header();
        let need = SpaceNeed::for_payload(header.payload_len, header.exe_len).target;
        // NSIS 覆盖时先截断旧 exe，那块空间下一次还能用
        let reclaimable = file_len(&instdir.join(APP_EXE)).unwrap_or(0);
        let fault = write_fault(instdir, need, reclaimable, |anchor| {
            self.launcher
                .target_volume(anchor)
                .inspect_err(|err| reporter.note(&format!("查目标盘空间失败：{err}")))
                .ok()
        });
        match fault {
            Some(fault) => Failure {
                detail: format!("载荷返回码 {code}，{}", fault.detail),
                ..fault
            },
            None => Failure {
                code: FailureCode::PayloadExit,
                detail: code.to_string(),
            },
        }
    }

    /// 跑完一次安装。阻塞到结束，要放在工作线程上调：子进程要等好几秒，窗口线程不能陪着。
    pub fn install(&self, target: &Target, reporter: &dyn Reporter) -> Result<(), Failure> {
        self.install_with_handoff(target, None, reporter)
    }

    /// 同 [`Session::install`]；`handoff` 有值时，先把交接记录写进状态目录，写不成就不装。只有用户在「换到」页上
    /// 确认的那次安装带它：首装、修复与更新模式都不写，否则会改掉用户在落樱设置里选的更新通道。
    pub fn install_with_handoff(
        &self,
        target: &Target,
        handoff: Option<&Handoff>,
        reporter: &dyn Reporter,
    ) -> Result<(), Failure> {
        let outcome = self.perform(target, handoff, reporter);
        if let Err(failure) = &outcome {
            reporter.note(&format!("安装失败：{failure}"));
        }
        outcome
    }

    fn perform(
        &self,
        target: &Target,
        handoff: Option<&Handoff>,
        reporter: &dyn Reporter,
    ) -> Result<(), Failure> {
        let header = self.header();
        let instdir = self.launcher.resolve_instdir(&target.instdir);
        let mut meter = ProgressMeter::new(header.exe_len);
        reporter.progress(meter.begin());

        let extracted = self.extract()?;
        reporter.note(&format!("载荷已解到 {}", extracted.path().display()));
        reporter.progress(meter.unpacked());

        // NSIS 没有只关桌面快捷方式的开关，/NS 会把开始菜单一起关掉，只能事后删。
        // 查不出来时按已存在算：宁可多留一个，不能删掉用户原有的
        let shortcut = self.roots.desktop.join(SHORTCUT_NAME);
        let keep_shortcut = target.desktop_shortcut || shortcut.try_exists().unwrap_or(true);

        let outcome = self.run_payload(target, handoff, &instdir, &extracted, &mut meter, reporter);
        if let Err(err) = extracted.cleanup() {
            reporter.note(&format!("清理临时目录失败：{err}"));
        }
        let code = outcome?;
        reporter.note(&format!("载荷退出，返回码 {code}"));
        if code != 0 {
            return Err(self.exit_failure(code, &instdir, reporter));
        }

        reporter.progress(meter.exited());
        let mismatches = verify(
            &Expected::from_header(header, &instdir),
            self.registry.as_ref(),
        );
        if !mismatches.is_empty() {
            return Err(verify::failure(&mismatches));
        }

        // 已经装好了：记录删不掉时下次启动核验通过还会再删一次，不算失败
        if let Err(err) = self.journal_store().clear() {
            reporter.note(&format!("删除半装记录失败：{err}"));
        }
        if !keep_shortcut {
            remove_shortcut(&shortcut, reporter);
        }
        reporter.progress(meter.verified());
        Ok(())
    }
}

/// 快捷方式只是外观：删不掉不算安装失败。
fn remove_shortcut(shortcut: &Path, reporter: &dyn Reporter) {
    match fs::remove_file(shortcut) {
        Err(err) if err.kind() != ErrorKind::NotFound => {
            reporter.note(&format!("删除桌面快捷方式失败：{err}"));
        }
        _ => {}
    }
}

#[cfg(test)]
pub(crate) mod test_support {
    use std::sync::Mutex;

    use super::{Progress, Reporter};

    #[derive(Default)]
    pub struct Recording {
        pub progress: Mutex<Vec<Progress>>,
        pub notes: Mutex<Vec<String>>,
    }

    impl Reporter for Recording {
        fn progress(&self, progress: Progress) {
            self.progress.lock().unwrap().push(progress);
        }

        fn note(&self, line: &str) {
            self.notes.lock().unwrap().push(line.to_owned());
        }
    }
}

#[cfg(test)]
mod tests {
    use std::collections::VecDeque;
    use std::sync::Mutex;

    use windows_sys::Win32::UI::Shell::FOLDERID_OriginalImages;

    use super::test_support::Recording;
    use super::*;
    use crate::existing::{DISPLAY_VERSION, INSTALL_LOCATION};
    use crate::extract::WEBVIEW_DATA_PREFIX;
    use crate::overlay::Overlay;
    use crate::overlay::test_support::{packed_image, random_bytes};
    use crate::verify::test_support::MemoryEntry;

    const VERSION: &str = "0.2.0-dev.7";
    const DUMP_ENV: &str = "PETALFALL_TEST_DUMP_ARGS";
    /// 测试会话的时钟固定在这一秒。
    const WRITTEN_AT: u64 = 1_794_000_000;

    #[test]
    fn arguments_put_an_unquoted_directory_last() {
        assert_eq!(
            nsis_arguments(Path::new(r"D:\游戏 目录\Petalfall")),
            OsString::from(r"/S /D=D:\游戏 目录\Petalfall")
        );
    }

    #[test]
    fn the_command_carries_the_arguments_as_one_raw_string() {
        let arguments = nsis_arguments(Path::new(r"C:\Program Data\落樱"));

        let command = payload_command(
            Path::new(r"C:\t\petalfall-nsis.exe"),
            Path::new(r"C:\t"),
            &arguments,
        );

        assert_eq!(
            command.get_args().collect::<Vec<_>>(),
            [OsStr::new(r"/S /D=C:\Program Data\落樱")]
        );
        assert_eq!(command.get_current_dir(), Some(Path::new(r"C:\t")));
    }

    #[test]
    fn no_arguments_means_the_wizard_runs_with_an_empty_tail() {
        let command = payload_command(
            Path::new(r"C:\t\petalfall-nsis.exe"),
            Path::new(r"C:\t"),
            OsStr::new(""),
        );

        assert_eq!(command.get_args().count(), 0);
    }

    /// 不是用例，是下面那条测试拉起的子进程：把自己收到的参数写出来。
    #[test]
    fn child_dump_args() {
        if let Some(path) = std::env::var_os(DUMP_ENV) {
            let args: Vec<String> = std::env::args().skip(1).collect();
            fs::write(path, args.join("\n")).unwrap();
        }
    }

    #[test]
    fn a_real_child_sees_the_directory_without_quotes() {
        // 被加了引号的话这段路径会是一个参数；不加引号才会按空格断开，NSIS 看到的就是这种
        let dir = tempfile::tempdir().unwrap();
        let dump = dir.path().join("args.txt");
        let arguments = nsis_arguments(Path::new(r"D:\游戏 目录\Petalfall"));

        let status = payload_command(&std::env::current_exe().unwrap(), dir.path(), &arguments)
            .arg("child_dump_args")
            .env(DUMP_ENV, &dump)
            .status()
            .unwrap();

        assert!(status.success());
        assert_eq!(
            fs::read_to_string(dump).unwrap(),
            "/S\n/D=D:\\游戏\n目录\\Petalfall\nchild_dump_args"
        );
    }

    #[test]
    fn the_system_launcher_reports_pid_and_exit_code() {
        // cmd.exe 的副本改名成载荷跑一下；全程不碰真实安装包
        let dir = tempfile::tempdir().unwrap();
        let exe = dir.path().join("petalfall-nsis.exe");
        let cmd = Path::new(&std::env::var_os("SystemRoot").unwrap()).join(r"System32\cmd.exe");
        fs::copy(cmd, &exe).unwrap();

        let mut running = SystemLauncher
            .launch(&exe, dir.path(), OsStr::new("/d /c exit 42"))
            .unwrap();

        assert_ne!(running.pid(), 0);
        let code = loop {
            if let Some(code) = running.try_wait().unwrap() {
                break code;
            }
            thread::sleep(Duration::from_millis(10));
        };
        assert_eq!(code, 42);
    }

    #[test]
    fn system_roots_follow_the_environment_and_the_known_folders() {
        let roots = Roots::system().unwrap();

        assert_eq!(
            roots.state,
            Path::new(&std::env::var_os("LOCALAPPDATA").unwrap()).join("Petalfall-Setup")
        );
        assert_eq!(roots.temp, std::env::temp_dir());
        assert!(roots.desktop.is_absolute());
    }

    /// 交接记录由引导程序写、启动器读，两边各拼各的路径：目录名对不上，启动器就永远找不到记录。
    #[test]
    fn the_handoff_lands_where_the_launcher_looks_for_it() {
        assert_eq!(log::SETUP_DIR, petalfall_release::handoff::SETUP_DIR);
        assert_eq!(
            Roots::system().unwrap().state.join(HANDOFF_FILE),
            Path::new(&std::env::var_os("LOCALAPPDATA").unwrap())
                .join(r"Petalfall-Setup\channel-handoff.json")
        );
    }

    /// main.rs 按 tempfile 的默认临时目录建 WebView2 数据目录，清扫看的是这里的 temp：两处不是同一个目录的话，
    /// 强杀留下的数据目录永远扫不到。
    #[test]
    fn webview_data_lands_where_the_sweep_looks() {
        let webview = tempfile::Builder::new()
            .prefix(WEBVIEW_DATA_PREFIX)
            .tempdir()
            .unwrap();

        assert_eq!(
            webview.path().parent(),
            Some(Roots::system().unwrap().temp.as_path())
        );
    }

    /// 桌面重定向到已断开的位置时文件夹不在，拿真桌面测不了，这里换一个几乎没有机器真有的已知文件夹。
    #[test]
    fn a_known_folder_that_is_not_on_disk_still_resolves() {
        let path = known_folder(&FOLDERID_OriginalImages).unwrap();

        assert!(path.ends_with("Original Images"), "{}", path.display());
    }

    #[test]
    fn the_time_model_follows_the_formula() {
        let exe_len = 48 * 1024 * 1024;
        let t = 4.0;

        assert_eq!(time_model(Duration::ZERO, exe_len), 0.0);
        let at_t = time_model(Duration::from_secs_f64(t), exe_len);
        assert!(
            (at_t - 92.0 * (1.0 - (-2.5f64).exp())).abs() < 1e-9,
            "{at_t}"
        );
        let halfway = time_model(Duration::from_secs_f64(t / 2.0), exe_len);
        assert!(
            (halfway - 92.0 * (1.0 - (-1.25f64).exp())).abs() < 1e-9,
            "{halfway}"
        );
    }

    #[test]
    fn the_time_model_approaches_92_and_never_passes_it() {
        let exe_len = 12 * 1024 * 1024;

        let late = time_model(Duration::from_secs(3600), exe_len);

        assert!(late <= 92.0, "{late}");
        assert!(late > 91.9, "{late}");
    }

    #[test]
    fn the_time_model_stays_finite_for_a_zero_length_header() {
        assert_eq!(time_model(Duration::ZERO, 0), 0.0);
        assert_eq!(time_model(Duration::from_secs(1), 0), 92.0);
    }

    fn no_milestones() -> Milestones {
        Milestones::default()
    }

    #[test]
    fn the_meter_walks_through_the_three_phases() {
        let mut meter = ProgressMeter::new(1 << 25);

        assert_eq!(
            meter.begin(),
            Progress {
                phase: Phase::Unpack,
                percent: 0.0,
                slow: false
            }
        );
        assert_eq!(meter.unpacked().percent, 4.0);
        assert_eq!(
            meter.tick(Duration::from_millis(1), no_milestones()).phase,
            Phase::Write
        );
        assert_eq!(
            meter.exited(),
            Progress {
                phase: Phase::Verify,
                percent: 99.0,
                slow: false
            }
        );
        assert_eq!(
            meter.verified(),
            Progress {
                phase: Phase::Verify,
                percent: 100.0,
                slow: false
            }
        );
    }

    #[test]
    fn the_time_model_cannot_pull_the_bar_below_the_extraction_mark() {
        let mut meter = ProgressMeter::new(1 << 30);
        meter.unpacked();

        let progress = meter.tick(Duration::from_millis(1), no_milestones());

        assert_eq!(progress.percent, 4.0);
    }

    #[test]
    fn milestones_raise_the_floor() {
        let mut meter = ProgressMeter::new(1 << 30);

        let exe = Milestones {
            exe_written: true,
            ..no_milestones()
        };
        assert_eq!(meter.tick(Duration::from_millis(1), exe).percent, 96.0);
        let uninstaller = Milestones {
            uninstaller_written: true,
            ..no_milestones()
        };
        assert_eq!(
            meter.tick(Duration::from_millis(2), uninstaller).percent,
            98.0
        );
    }

    #[test]
    fn progress_never_goes_backwards_even_if_a_milestone_disappears() {
        let mut meter = ProgressMeter::new(1 << 30);
        let exe = Milestones {
            exe_written: true,
            ..no_milestones()
        };
        meter.tick(Duration::from_millis(1), exe);

        assert_eq!(
            meter
                .tick(Duration::from_millis(2), no_milestones())
                .percent,
            96.0
        );
    }

    #[test]
    fn slow_turns_on_only_past_twenty_seconds_of_writing() {
        let mut meter = ProgressMeter::new(1 << 25);

        assert!(!meter.tick(Duration::from_secs(20), no_milestones()).slow);
        assert!(
            meter
                .tick(Duration::from_millis(20_001), no_milestones())
                .slow
        );
        assert!(!meter.exited().slow);
    }

    #[test]
    fn a_fresh_target_reports_both_milestones_as_files_appear() {
        let dir = tempfile::tempdir().unwrap();
        let mut watch = TargetWatch::new(dir.path(), 8);

        assert_eq!(watch.observe(), no_milestones());
        fs::write(dir.path().join(APP_EXE), b"1234").unwrap();
        assert_eq!(watch.observe(), no_milestones());
        fs::write(dir.path().join(APP_EXE), b"12345678").unwrap();
        fs::write(dir.path().join(UNINSTALLER_NAME), b"x").unwrap();
        assert_eq!(
            watch.observe(),
            Milestones {
                exe_written: true,
                uninstaller_written: true
            }
        );
    }

    #[test]
    fn an_old_exe_of_the_same_length_does_not_count_until_it_changes() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join(APP_EXE), b"12345678").unwrap();
        let mut watch = TargetWatch::new(dir.path(), 8);

        assert!(!watch.observe().exe_written);
        fs::write(dir.path().join(APP_EXE), b"").unwrap();
        assert!(!watch.observe().exe_written);
        fs::write(dir.path().join(APP_EXE), b"abcdefgh").unwrap();
        assert!(watch.observe().exe_written);
    }

    #[test]
    fn an_old_uninstaller_is_not_a_milestone() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join(UNINSTALLER_NAME), b"old").unwrap();
        let mut watch = TargetWatch::new(dir.path(), 8);

        assert!(!watch.observe().uninstaller_written);
    }

    fn plan(mode: InstallMode, dir: Option<&str>) -> InstallPlan {
        InstallPlan {
            mode,
            dir: dir.map(str::to_owned),
            desktop_shortcut: false,
        }
    }

    #[test]
    fn a_fresh_target_uses_the_plan_directory() {
        let target = Target::from_plan(
            &plan(InstallMode::Fresh, Some(r"D:\a b")),
            Some(r"E:\ignored"),
        )
        .unwrap();

        assert_eq!(target.instdir, PathBuf::from(r"D:\a b"));
        assert_eq!(target.mode, InstallMode::Fresh);
        assert!(!target.desktop_shortcut);
    }

    #[test]
    fn upgrade_and_repair_targets_use_the_registered_directory() {
        for mode in [
            InstallMode::Upgrade,
            InstallMode::Repair,
            InstallMode::Switch,
        ] {
            let target = Target::from_plan(
                &plan(mode, Some(r"D:\ignored")),
                Some(r"E:\Games\Petalfall"),
            )
            .unwrap();

            assert_eq!(target.instdir, PathBuf::from(r"E:\Games\Petalfall"));
        }
    }

    #[test]
    fn a_target_without_a_directory_is_refused() {
        for (mode, registered) in [
            (InstallMode::Fresh, Some(r"E:\Petalfall")),
            (InstallMode::Upgrade, None),
            (InstallMode::Repair, None),
            (InstallMode::Switch, None),
        ] {
            let failure = Target::from_plan(&plan(mode, None), registered).unwrap_err();

            assert_eq!(failure.code, FailureCode::DirUnwritable, "{mode:?}");
        }
    }

    struct Exits {
        exit: i32,
        polls: u32,
    }

    impl Running for Exits {
        fn pid(&self) -> u32 {
            4242
        }

        fn try_wait(&mut self) -> io::Result<Option<i32>> {
            if self.polls == 0 {
                return Ok(Some(self.exit));
            }
            self.polls -= 1;
            Ok(None)
        }
    }

    enum Step {
        Refuse(i32),
        Run {
            effect: Box<dyn FnOnce() + Send>,
            exit: i32,
        },
    }

    #[derive(Debug, Clone)]
    struct Call {
        arguments: OsString,
        exe: PathBuf,
        cwd: PathBuf,
        payload: Vec<u8>,
        journal: Option<Journal>,
        handoff: Option<Vec<u8>>,
    }

    struct Scripted {
        steps: Mutex<VecDeque<Step>>,
        calls: Arc<Mutex<Vec<Call>>>,
        journal_path: PathBuf,
        handoff_path: PathBuf,
        free_bytes: u64,
    }

    impl Launcher for Scripted {
        fn target_volume(&self, _dir: &Path) -> io::Result<Volume> {
            Ok(Volume {
                id: r"D:\".to_owned(),
                free_bytes: self.free_bytes,
            })
        }

        fn launch(
            &self,
            exe: &Path,
            cwd: &Path,
            arguments: &OsStr,
        ) -> io::Result<Box<dyn Running>> {
            self.calls.lock().unwrap().push(Call {
                arguments: arguments.to_owned(),
                exe: exe.to_owned(),
                cwd: cwd.to_owned(),
                payload: fs::read(exe).unwrap(),
                journal: fs::read(&self.journal_path)
                    .ok()
                    .map(|bytes| serde_json::from_slice(&bytes).unwrap()),
                handoff: fs::read(&self.handoff_path).ok(),
            });
            match self
                .steps
                .lock()
                .unwrap()
                .pop_front()
                .expect("脚本里的步骤用完了")
            {
                Step::Refuse(code) => Err(io::Error::from_raw_os_error(code)),
                Step::Run { effect, exit } => {
                    effect();
                    Ok(Box::new(Exits { exit, polls: 2 }))
                }
            }
        }
    }

    struct NoProcesses;

    impl Processes for NoProcesses {
        fn payload_alive(&self, _: u32) -> io::Result<bool> {
            Ok(false)
        }
    }

    struct Bench {
        _dir: tempfile::TempDir,
        roots: Roots,
        instdir: PathBuf,
        image: PathBuf,
        payload: Vec<u8>,
        exe: Arc<Vec<u8>>,
        entry: Arc<MemoryEntry>,
        calls: Arc<Mutex<Vec<Call>>>,
        free_bytes: u64,
    }

    impl Bench {
        fn new() -> Self {
            let dir = tempfile::tempdir().unwrap();
            let roots = Roots {
                temp: dir.path().join("temp"),
                state: dir.path().join("state"),
                desktop: dir.path().join("desktop"),
            };
            fs::create_dir(&roots.temp).unwrap();
            fs::create_dir(&roots.desktop).unwrap();
            let payload = random_bytes(1024);
            let exe = Arc::new(random_bytes(2048));
            let image = packed_image(dir.path(), &payload, &exe, VERSION, &[]);
            let instdir = dir.path().join("游戏 目录").join("Petalfall");
            Self {
                roots,
                instdir,
                image,
                payload,
                exe,
                entry: Arc::new(MemoryEntry::default()),
                calls: Arc::default(),
                free_bytes: u64::MAX,
                _dir: dir,
            }
        }

        fn session(&self, steps: Vec<Step>) -> Session {
            let launcher = Scripted {
                steps: Mutex::new(steps.into()),
                calls: Arc::clone(&self.calls),
                journal_path: JournalStore::new(&self.roots.state).path(),
                handoff_path: self.handoff_path(),
                free_bytes: self.free_bytes,
            };
            let entry: Arc<dyn Registry> = self.entry.clone();
            let mut session = Session::new(
                Source::Packed(Overlay::open(&self.image).unwrap()),
                self.roots.clone(),
                Box::new(launcher),
                entry,
                Box::new(NoProcesses),
            );
            session.poll = Duration::ZERO;
            session.clock = || UNIX_EPOCH + Duration::from_secs(WRITTEN_AT);
            session
        }

        fn handoff_path(&self) -> PathBuf {
            self.roots.state.join(HANDOFF_FILE)
        }

        /// NSIS 跑完的现场：文件写好，卸载项写好。
        fn good_install(&self) -> Step {
            let instdir = self.instdir.clone();
            let exe = Arc::clone(&self.exe);
            let entry = Arc::clone(&self.entry);
            Step::Run {
                effect: Box::new(move || {
                    fs::create_dir_all(&instdir).unwrap();
                    fs::write(instdir.join(APP_EXE), exe.as_slice()).unwrap();
                    fs::write(instdir.join(UNINSTALLER_NAME), b"MZ").unwrap();
                    entry.set(DISPLAY_VERSION, VERSION);
                    entry.set(INSTALL_LOCATION, &format!("\"{}\"", instdir.display()));
                }),
                exit: 0,
            }
        }

        fn target(&self, mode: InstallMode, desktop_shortcut: bool) -> Target {
            Target {
                mode,
                instdir: self.instdir.clone(),
                desktop_shortcut,
            }
        }

        fn store(&self) -> JournalStore {
            JournalStore::new(&self.roots.state)
        }

        fn temp_is_empty(&self) -> bool {
            fs::read_dir(&self.roots.temp).unwrap().count() == 0
        }

        fn calls(&self) -> Vec<Call> {
            self.calls.lock().unwrap().clone()
        }
    }

    fn exits(code: i32) -> Step {
        Step::Run {
            effect: Box::new(|| {}),
            exit: code,
        }
    }

    #[test]
    fn a_fresh_install_runs_the_payload_and_finishes_clean() {
        let bench = Bench::new();
        let session = bench.session(vec![bench.good_install()]);
        let reporter = Recording::default();

        session
            .install(&bench.target(InstallMode::Fresh, true), &reporter)
            .unwrap();

        let calls = bench.calls();
        assert_eq!(calls.len(), 1);
        let mut expected_arguments = OsString::from("/S /D=");
        expected_arguments.push(&bench.instdir);
        assert_eq!(calls[0].arguments, expected_arguments);
        assert_eq!(calls[0].payload, bench.payload);
        assert_eq!(calls[0].exe.file_name().unwrap(), "Petalfall-NSIS.exe");
        assert_eq!(calls[0].exe.parent().unwrap(), calls[0].cwd);
        assert!(calls[0].cwd.starts_with(&bench.roots.temp));
        assert!(bench.temp_is_empty());
        assert!(!bench.store().path().exists());
    }

    #[test]
    fn the_journal_is_on_disk_before_the_payload_starts() {
        let bench = Bench::new();
        let session = bench.session(vec![bench.good_install()]);

        session
            .install(
                &bench.target(InstallMode::Fresh, true),
                &Recording::default(),
            )
            .unwrap();

        let journal = bench.calls()[0]
            .journal
            .clone()
            .expect("启动时记录必须已落盘");
        assert_eq!(journal.instdir, bench.instdir);
        assert!(journal.was_fresh);
        assert_eq!(journal.version, VERSION);
        assert_eq!(journal.payload_pid, None);
    }

    #[test]
    fn upgrades_and_repairs_pin_nsis_to_the_registered_directory() {
        // 只传 /S 的话 NSIS 按自己记的目录键装，那个键丢了就装进默认目录，登记跟着被改指过去
        for mode in [InstallMode::Upgrade, InstallMode::Repair] {
            let bench = Bench::new();
            let session = bench.session(vec![bench.good_install()]);

            session
                .install(&bench.target(mode, true), &Recording::default())
                .unwrap();

            let call = &bench.calls()[0];
            let mut expected_arguments = OsString::from("/S /D=");
            expected_arguments.push(&bench.instdir);
            assert_eq!(call.arguments, expected_arguments, "{mode:?}");
            assert!(!call.journal.as_ref().unwrap().was_fresh, "{mode:?}");
        }
    }

    #[test]
    fn progress_is_monotonic_and_covers_every_phase_up_to_100() {
        let bench = Bench::new();
        let session = bench.session(vec![bench.good_install()]);
        let reporter = Recording::default();

        session
            .install(&bench.target(InstallMode::Fresh, true), &reporter)
            .unwrap();

        let progress = reporter.progress.lock().unwrap();
        assert_eq!(progress[0].phase, Phase::Unpack);
        assert_eq!(progress[0].percent, 0.0);
        assert!(progress.iter().any(|item| item.phase == Phase::Write));
        let tail = &progress[progress.len() - 2..];
        assert_eq!(
            tail,
            [
                Progress {
                    phase: Phase::Verify,
                    percent: 99.0,
                    slow: false
                },
                Progress {
                    phase: Phase::Verify,
                    percent: 100.0,
                    slow: false
                },
            ]
        );
        assert!(
            progress
                .windows(2)
                .all(|pair| pair[0].percent <= pair[1].percent)
        );
    }

    #[test]
    fn a_failed_payload_reports_the_decimal_exit_code_and_keeps_the_journal() {
        let bench = Bench::new();
        let session = bench.session(vec![exits(3)]);
        let reporter = Recording::default();

        let failure = session
            .install(&bench.target(InstallMode::Fresh, true), &reporter)
            .unwrap_err();

        assert_eq!(
            failure,
            Failure {
                code: FailureCode::PayloadExit,
                detail: "3".to_owned(),
            }
        );
        assert!(bench.store().path().exists());
        assert!(bench.temp_is_empty());
        let notes = reporter.notes.lock().unwrap();
        assert!(
            notes.iter().any(|line| line == "载荷退出，返回码 3"),
            "{notes:?}"
        );
        assert!(
            notes.iter().any(|line| line == "安装失败：PayloadExit: 3"),
            "{notes:?}"
        );
    }

    /// `exe` 2048 字节加上目标盘的余量。
    const NEED_ON_TARGET: u64 = 2048 + 10 * 1024 * 1024;

    fn failed_slowly(bench: &Bench, mode: InstallMode, step: Step) -> Failure {
        let mut session = bench.session(vec![step]);
        session.quick_exit = Duration::ZERO;
        session
            .install(&bench.target(mode, true), &Recording::default())
            .unwrap_err()
    }

    #[test]
    fn exit_2_with_the_target_disk_out_of_space_is_disk_full() {
        let mut bench = Bench::new();
        bench.free_bytes = 4096;

        let failure = failed_slowly(&bench, InstallMode::Fresh, exits(2));

        assert_eq!(
            failure,
            Failure {
                code: FailureCode::DiskFull,
                detail: format!(r"载荷返回码 2，D:\ 还剩 4096 字节，需要 {NEED_ON_TARGET} 字节"),
            }
        );
        assert!(bench.store().path().exists(), "半装记录要留着");
    }

    #[test]
    fn a_half_written_exe_does_not_hide_a_full_disk() {
        let mut bench = Bench::new();
        bench.free_bytes = 0;
        let instdir = bench.instdir.clone();
        let half_written = Step::Run {
            effect: Box::new(move || {
                fs::create_dir_all(&instdir).unwrap();
                fs::write(instdir.join(APP_EXE), b"half").unwrap();
            }),
            exit: 2,
        };

        let failure = failed_slowly(&bench, InstallMode::Fresh, half_written);

        assert_eq!(failure.code, FailureCode::DiskFull);
    }

    #[test]
    fn the_space_an_overwrite_gets_back_is_not_a_shortage() {
        let mut bench = Bench::new();
        bench.free_bytes = 4096;
        fs::create_dir_all(&bench.instdir).unwrap();
        fs::write(
            bench.instdir.join(APP_EXE),
            vec![0u8; NEED_ON_TARGET as usize - 4096],
        )
        .unwrap();

        let failure = failed_slowly(&bench, InstallMode::Upgrade, exits(2));

        assert_eq!(
            failure,
            Failure {
                code: FailureCode::PayloadExit,
                detail: "2".to_owned(),
            }
        );
    }

    #[test]
    fn exit_2_with_a_target_that_cannot_be_written_is_dir_unwritable() {
        let bench = Bench::new();
        // 目标路径上的一段被文件占着：真实权限的情形在 target.rs 用 ACL 测
        fs::write(bench.instdir.parent().unwrap(), b"in the way").unwrap();

        let failure = failed_slowly(&bench, InstallMode::Fresh, exits(2));

        assert_eq!(failure.code, FailureCode::DirUnwritable);
        let prefix = format!("载荷返回码 2，{} 写不进去：", bench.instdir.display());
        assert!(failure.detail.starts_with(&prefix), "{}", failure.detail);
    }

    #[test]
    fn exit_zero_with_a_bad_install_is_a_verify_failure_naming_the_item() {
        let bench = Bench::new();
        let session = bench.session(vec![exits(0)]);

        let failure = session
            .install(
                &bench.target(InstallMode::Fresh, true),
                &Recording::default(),
            )
            .unwrap_err();

        assert_eq!(failure.code, FailureCode::VerifyFailed);
        assert!(
            failure.detail.contains("Petalfall.exe 不存在"),
            "{}",
            failure.detail
        );
        assert!(
            failure.detail.contains("uninstall.exe 不存在"),
            "{}",
            failure.detail
        );
        assert!(bench.store().path().exists());
        assert!(bench.temp_is_empty());
    }

    #[test]
    fn verification_looks_at_the_header_fingerprint_not_just_presence() {
        let bench = Bench::new();
        let instdir = bench.instdir.clone();
        let wrote_old_exe = Step::Run {
            effect: {
                let good = bench.good_install();
                Box::new(move || {
                    if let Step::Run { effect, .. } = good {
                        effect();
                    }
                    fs::write(instdir.join(APP_EXE), b"old exe that stayed behind").unwrap();
                })
            },
            exit: 0,
        };
        let session = bench.session(vec![wrote_old_exe]);

        let failure = session
            .install(
                &bench.target(InstallMode::Repair, true),
                &Recording::default(),
            )
            .unwrap_err();

        assert_eq!(failure.code, FailureCode::VerifyFailed);
        assert!(
            failure
                .detail
                .starts_with("Petalfall.exe 长度 26，应为 2048"),
            "{}",
            failure.detail
        );
    }

    #[test]
    fn a_quick_exit_2_with_an_untouched_target_is_retried_once() {
        let bench = Bench::new();
        let session = bench.session(vec![exits(2), bench.good_install()]);

        session
            .install(
                &bench.target(InstallMode::Fresh, true),
                &Recording::default(),
            )
            .unwrap();

        assert_eq!(bench.calls().len(), 2);
    }

    #[test]
    fn the_quick_retry_happens_at_most_once() {
        let bench = Bench::new();
        let session = bench.session(vec![exits(2), exits(2)]);

        let failure = session
            .install(
                &bench.target(InstallMode::Fresh, true),
                &Recording::default(),
            )
            .unwrap_err();

        assert_eq!(failure.detail, "2");
        assert_eq!(bench.calls().len(), 2);
    }

    #[test]
    fn exit_2_after_touching_the_target_is_not_retried() {
        let bench = Bench::new();
        let instdir = bench.instdir.clone();
        let half_written = Step::Run {
            effect: Box::new(move || {
                fs::create_dir_all(&instdir).unwrap();
                fs::write(instdir.join(APP_EXE), b"half").unwrap();
            }),
            exit: 2,
        };
        let session = bench.session(vec![half_written]);

        let failure = session
            .install(
                &bench.target(InstallMode::Fresh, true),
                &Recording::default(),
            )
            .unwrap_err();

        assert_eq!(failure.code, FailureCode::PayloadExit);
        assert_eq!(bench.calls().len(), 1);
    }

    #[test]
    fn a_slow_exit_2_is_not_retried() {
        let bench = Bench::new();
        let mut session = bench.session(vec![exits(2)]);
        session.quick_exit = Duration::ZERO;

        session
            .install(
                &bench.target(InstallMode::Fresh, true),
                &Recording::default(),
            )
            .unwrap_err();

        assert_eq!(bench.calls().len(), 1);
    }

    #[test]
    fn other_exit_codes_are_not_retried() {
        let bench = Bench::new();
        let session = bench.session(vec![exits(1)]);

        session
            .install(
                &bench.target(InstallMode::Fresh, true),
                &Recording::default(),
            )
            .unwrap_err();

        assert_eq!(bench.calls().len(), 1);
    }

    #[test]
    fn a_sharing_violation_at_launch_is_retried() {
        let bench = Bench::new();
        let session = bench.session(vec![Step::Refuse(32), bench.good_install()]);

        session
            .install(
                &bench.target(InstallMode::Fresh, true),
                &Recording::default(),
            )
            .unwrap();

        assert_eq!(bench.calls().len(), 2);
    }

    #[test]
    fn an_antivirus_refusal_at_launch_is_extract_failed_and_cleans_up() {
        let bench = Bench::new();
        let session = bench.session(vec![Step::Refuse(225)]);

        let failure = session
            .install(
                &bench.target(InstallMode::Fresh, true),
                &Recording::default(),
            )
            .unwrap_err();

        assert_eq!(failure.code, FailureCode::ExtractFailed);
        assert!(
            failure.detail.contains("os error 225"),
            "{}",
            failure.detail
        );
        assert!(bench.temp_is_empty());
    }

    #[test]
    fn a_journal_that_cannot_be_written_stops_before_the_payload_starts() {
        let bench = Bench::new();
        // 记录目录的位置被一个文件占着
        fs::write(&bench.roots.state, b"in the way").unwrap();
        let session = bench.session(vec![bench.good_install()]);

        let failure = session
            .install(
                &bench.target(InstallMode::Fresh, true),
                &Recording::default(),
            )
            .unwrap_err();

        assert_eq!(failure.code, FailureCode::ExtractFailed);
        assert!(
            failure.detail.starts_with("写半装记录："),
            "{}",
            failure.detail
        );
        assert!(bench.calls().is_empty());
    }

    #[test]
    fn extraction_failures_never_reach_the_payload_or_the_journal() {
        let bench = Bench::new();
        fs::remove_dir(&bench.roots.temp).unwrap();
        let session = bench.session(vec![bench.good_install()]);

        let reporter = Recording::default();

        let failure = session
            .install(&bench.target(InstallMode::Fresh, true), &reporter)
            .unwrap_err();

        assert_eq!(failure.code, FailureCode::ExtractFailed);
        assert!(bench.calls().is_empty());
        assert!(!bench.store().path().exists());
        let notes = reporter.notes.lock().unwrap();
        assert!(
            notes
                .iter()
                .any(|line| line.starts_with("安装失败：ExtractFailed: ")),
            "{notes:?}"
        );
    }

    fn handoff() -> Handoff {
        Handoff {
            channel: Channel::Dev,
            version: Version::parse(VERSION).unwrap(),
        }
    }

    fn handoff_written_at(written_at: u64) -> ChannelHandoff {
        ChannelHandoff {
            channel: Channel::Dev,
            version: Version::parse(VERSION).unwrap(),
            written_at,
        }
    }

    fn read_handoff(bytes: &[u8]) -> ChannelHandoff {
        ChannelHandoff::from_json(bytes).unwrap()
    }

    #[test]
    fn a_confirmed_switch_has_its_handoff_on_disk_before_the_payload_starts() {
        // 「换到」页确认的两种安装：已装的更旧、安装包通道更快的升级，与已装的更新、安装包通道更慢的换通道
        for mode in [InstallMode::Upgrade, InstallMode::Switch] {
            let bench = Bench::new();
            let session = bench.session(vec![bench.good_install()]);
            let reporter = Recording::default();

            session
                .install_with_handoff(&bench.target(mode, true), Some(&handoff()), &reporter)
                .unwrap();

            let call = &bench.calls()[0];
            let at_launch = call
                .handoff
                .as_deref()
                .expect("启动载荷时交接记录必须已落盘");
            assert_eq!(
                read_handoff(at_launch),
                handoff_written_at(WRITTEN_AT),
                "{mode:?}"
            );
            assert!(call.journal.is_some(), "{mode:?}");
            // 记录留给启动器读，装完不删
            assert_eq!(
                read_handoff(&fs::read(bench.handoff_path()).unwrap()),
                handoff_written_at(WRITTEN_AT),
                "{mode:?}"
            );
            let notes = reporter.notes.lock().unwrap();
            assert!(
                notes.iter().any(|line| line
                    == r#"交接记录已写入：{"channel":"dev","version":"0.2.0-dev.7","written_at":1794000000}"#),
                "{notes:?}"
            );
        }
    }

    #[test]
    fn the_handoff_is_written_before_the_journal() {
        let bench = Bench::new();
        // 半装记录的位置被一个目录占着，改名到那里会失败
        fs::create_dir_all(bench.store().path()).unwrap();
        let session = bench.session(vec![bench.good_install()]);

        let failure = session
            .install_with_handoff(
                &bench.target(InstallMode::Switch, true),
                Some(&handoff()),
                &Recording::default(),
            )
            .unwrap_err();

        assert!(
            failure.detail.starts_with("写半装记录："),
            "{}",
            failure.detail
        );
        assert!(bench.calls().is_empty());
        assert_eq!(
            read_handoff(&fs::read(bench.handoff_path()).unwrap()),
            handoff_written_at(WRITTEN_AT)
        );
    }

    #[test]
    fn a_handoff_that_cannot_be_written_stops_before_the_journal_and_the_payload() {
        // 状态目录的位置被一个文件占着，或者交接记录的位置被一个目录占着
        for state_is_a_file in [true, false] {
            let bench = Bench::new();
            if state_is_a_file {
                fs::write(&bench.roots.state, b"in the way").unwrap();
            } else {
                fs::create_dir_all(bench.handoff_path()).unwrap();
            }
            let session = bench.session(vec![bench.good_install()]);

            let failure = session
                .install_with_handoff(
                    &bench.target(InstallMode::Switch, true),
                    Some(&handoff()),
                    &Recording::default(),
                )
                .unwrap_err();

            assert_eq!(
                failure.code,
                FailureCode::ExtractFailed,
                "{state_is_a_file}"
            );
            assert!(
                failure.detail.starts_with("写交接记录："),
                "{}",
                failure.detail
            );
            assert!(bench.calls().is_empty(), "{state_is_a_file}");
            assert!(!bench.store().path().exists(), "{state_is_a_file}");
            assert!(bench.temp_is_empty(), "{state_is_a_file}");
        }
    }

    #[test]
    fn a_retry_rewrites_the_handoff_in_place() {
        let bench = Bench::new();
        bench
            .session(vec![exits(3)])
            .install_with_handoff(
                &bench.target(InstallMode::Switch, true),
                Some(&handoff()),
                &Recording::default(),
            )
            .unwrap_err();
        let mut retry = bench.session(vec![bench.good_install()]);
        retry.clock = || UNIX_EPOCH + Duration::from_secs(WRITTEN_AT + 60);

        retry
            .install_with_handoff(
                &bench.target(InstallMode::Switch, true),
                Some(&handoff()),
                &Recording::default(),
            )
            .unwrap();

        assert_eq!(
            read_handoff(&fs::read(bench.handoff_path()).unwrap()),
            handoff_written_at(WRITTEN_AT + 60)
        );
        let names: Vec<_> = fs::read_dir(&bench.roots.state)
            .unwrap()
            .map(|entry| entry.unwrap().file_name())
            .collect();
        assert_eq!(names, [HANDOFF_FILE]);
    }

    #[test]
    fn without_a_handoff_no_record_is_written() {
        // 首装与修复从不写；升级与换通道不带记录时，是更新模式下无人值守装的两种，以及不改通道的普通升级
        for mode in [
            InstallMode::Fresh,
            InstallMode::Upgrade,
            InstallMode::Repair,
            InstallMode::Switch,
        ] {
            let bench = Bench::new();
            let session = bench.session(vec![bench.good_install()]);

            session
                .install(&bench.target(mode, true), &Recording::default())
                .unwrap();

            assert_eq!(bench.calls()[0].handoff, None, "{mode:?}");
            assert!(!bench.handoff_path().exists(), "{mode:?}");
            assert!(
                !bench.roots.state.join(HANDOFF_TEMP_FILE).exists(),
                "{mode:?}"
            );
        }
    }

    /// 载荷按模板的行为总是建桌面快捷方式。
    fn install_with_shortcut(bench: &Bench) -> Step {
        let shortcut = bench.roots.desktop.join(SHORTCUT_NAME);
        let Step::Run { effect, exit } = bench.good_install() else {
            unreachable!("good_install 总是 Run");
        };
        Step::Run {
            effect: Box::new(move || {
                effect();
                fs::write(&shortcut, b"lnk").unwrap();
            }),
            exit,
        }
    }

    #[test]
    fn an_unticked_shortcut_created_by_the_install_is_removed() {
        let bench = Bench::new();
        let session = bench.session(vec![install_with_shortcut(&bench)]);

        session
            .install(
                &bench.target(InstallMode::Fresh, false),
                &Recording::default(),
            )
            .unwrap();

        assert!(!bench.roots.desktop.join(SHORTCUT_NAME).exists());
    }

    #[test]
    fn a_ticked_shortcut_stays() {
        let bench = Bench::new();
        let session = bench.session(vec![install_with_shortcut(&bench)]);

        session
            .install(
                &bench.target(InstallMode::Fresh, true),
                &Recording::default(),
            )
            .unwrap();

        assert!(bench.roots.desktop.join(SHORTCUT_NAME).exists());
    }

    #[test]
    fn a_shortcut_the_user_already_had_survives_unticking() {
        let bench = Bench::new();
        fs::write(bench.roots.desktop.join(SHORTCUT_NAME), b"the user's own").unwrap();
        let session = bench.session(vec![install_with_shortcut(&bench)]);

        session
            .install(
                &bench.target(InstallMode::Fresh, false),
                &Recording::default(),
            )
            .unwrap();

        assert!(bench.roots.desktop.join(SHORTCUT_NAME).exists());
    }

    #[test]
    fn a_failed_install_leaves_the_shortcut_alone() {
        let bench = Bench::new();
        let shortcut = bench.roots.desktop.join(SHORTCUT_NAME);
        let created = shortcut.clone();
        let step = Step::Run {
            effect: Box::new(move || fs::write(&created, b"lnk").unwrap()),
            exit: 0,
        };
        let session = bench.session(vec![step]);

        session
            .install(
                &bench.target(InstallMode::Fresh, false),
                &Recording::default(),
            )
            .unwrap_err();

        assert!(shortcut.exists());
    }

    #[test]
    fn unticking_with_no_shortcut_created_is_fine() {
        let bench = Bench::new();
        let session = bench.session(vec![bench.good_install()]);

        session
            .install(
                &bench.target(InstallMode::Fresh, false),
                &Recording::default(),
            )
            .unwrap();
    }

    #[test]
    fn a_desktop_that_is_not_on_disk_does_not_fail_the_install() {
        let bench = Bench::new();
        fs::remove_dir(&bench.roots.desktop).unwrap();
        let session = bench.session(vec![bench.good_install()]);
        let reporter = Recording::default();

        session
            .install(&bench.target(InstallMode::Fresh, false), &reporter)
            .unwrap();

        let notes = reporter.notes.lock().unwrap();
        assert!(
            !notes.iter().any(|line| line.contains("快捷方式")),
            "{notes:?}"
        );
    }

    #[test]
    fn recover_verifies_a_leftover_record_against_this_payload() {
        let bench = Bench::new();
        let session = bench.session(vec![exits(3)]);
        session
            .install(
                &bench.target(InstallMode::Fresh, true),
                &Recording::default(),
            )
            .unwrap_err();

        let recovery = session.recover().unwrap();

        let Recovery::Interrupted {
            journal,
            mismatches,
        } = recovery
        else {
            panic!("半装应判为中断：{recovery:?}");
        };
        assert_eq!(journal.instdir, bench.instdir);
        assert!(journal.was_fresh);
        assert_eq!(journal.payload_pid, Some(4242));
        assert_eq!(mismatches[0], verify::Mismatch::ExeMissing);
        assert!(bench.store().path().exists());
    }

    #[test]
    fn recover_clears_the_record_when_the_install_finished_after_all() {
        let bench = Bench::new();
        let session = bench.session(vec![exits(3)]);
        session
            .install(
                &bench.target(InstallMode::Fresh, true),
                &Recording::default(),
            )
            .unwrap_err();
        let Step::Run { effect, .. } = bench.good_install() else {
            unreachable!("good_install 总是 Run");
        };
        effect();

        assert_eq!(session.recover().unwrap(), Recovery::Completed);
        assert!(!bench.store().path().exists());
    }

    #[test]
    fn sweep_uses_the_session_temp_root() {
        let bench = Bench::new();
        let young = bench.roots.temp.join("Petalfall-Setup-young");
        fs::create_dir(&young).unwrap();

        let sweep = bench.session(vec![]).sweep().unwrap();

        assert!(sweep.removed.is_empty());
        assert!(young.exists());
    }

    #[test]
    fn the_standard_run_starts_the_wizard_without_arguments_and_cleans_up_after_it() {
        let bench = Bench::new();
        let session = bench.session(vec![exits(5)]);

        let run = session.start_standard(OsStr::new("")).unwrap();

        assert_eq!(run.pid(), 4242);
        assert!(!bench.temp_is_empty(), "向导运行期间临时文件要在");
        let call = &bench.calls()[0];
        assert_eq!(call.arguments, OsString::new());
        assert_eq!(call.payload, bench.payload);

        assert_eq!(run.wait_and_clean(&Recording::default()).unwrap(), 5);
        assert!(bench.temp_is_empty());
        assert!(!bench.store().path().exists(), "向导不写半装记录");
    }

    /// 窗口起不来时的更新：插件那串参数要一字不差地到 NSIS 手里，`/ARGS` 后面已经转义过的部分也不能再被动。
    #[test]
    fn the_standard_run_hands_its_arguments_to_the_payload_unchanged() {
        let bench = Bench::new();
        let session = bench.session(vec![exits(0)]);
        let arguments =
            OsStr::new(r#"/P /R /UPDATE /ARGS --flag "some space" "C:\游戏 目录\\" """#);

        let run = session.start_standard(arguments).unwrap();

        let call = &bench.calls()[0];
        assert_eq!(call.arguments, arguments);
        assert_eq!(call.payload, bench.payload);
        assert_eq!(run.wait_and_clean(&Recording::default()).unwrap(), 0);
        assert!(bench.temp_is_empty());
    }

    #[test]
    fn the_header_comes_from_the_source() {
        let bench = Bench::new();
        let session = bench.session(vec![]);

        assert_eq!(session.header().version, VERSION);
        assert_eq!(session.header().exe_len, 2048);
        assert_eq!(session.roots(), &bench.roots);
    }
}
