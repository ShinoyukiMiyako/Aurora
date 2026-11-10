//! debug 构建没拼过载荷时的替身，让 `tauri dev` 不需要真实 NSIS 包也能走完整个安装流程。
//!
//! 用 `PETALFALL_SETUP_FAKE=ok|fail|slow|verify` 选结果。所有写入都在系统临时目录下的沙箱里：
//! 请求的安装目录会被换成沙箱内的目录，注册表换成内存表，开发机上真实的安装和桌面都不受影响。

use std::collections::HashMap;
use std::ffi::{OsStr, OsString};
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::Duration;

use petalfall_setup_payload::Header;

use super::{Launcher, Roots, Running, Session};
use crate::boot::Instance;
use crate::existing::{APP_EXE, DISPLAY_VERSION, INSTALL_LOCATION, Registry, UNINSTALL_KEY};
use crate::journal::Processes;
use crate::launcher::Opened;
use crate::overlay::Source;
use crate::verify::UNINSTALLER_NAME;

pub const ENV_VAR: &str = "PETALFALL_SETUP_FAKE";
pub const SANDBOX_DIR: &str = "Petalfall-Fake-Sandbox";

/// 16 MiB 让时间模型的 T 约 1.3 秒，进度条有东西可看。
const EXE_LEN: usize = 16 * 1024 * 1024;
const PAYLOAD_LEN: usize = 64 * 1024;
const WORK_TIME: Duration = Duration::from_millis(1500);
/// 要越过写入阶段 20 秒的慢提示。
const SLOW_WORK_TIME: Duration = Duration::from_secs(23);
const ABORTED: i32 = 2;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Outcome {
    Ok,
    Fail,
    Slow,
    Verify,
}

impl Outcome {
    pub fn parse(value: Option<&str>) -> Result<Self, String> {
        match value {
            None | Some("ok") => Ok(Outcome::Ok),
            Some("fail") => Ok(Outcome::Fail),
            Some("slow") => Ok(Outcome::Slow),
            Some("verify") => Ok(Outcome::Verify),
            Some(other) => Err(format!(
                "{ENV_VAR} 只接受 ok、fail、slow、verify，收到 {other}"
            )),
        }
    }

    fn work_time(self) -> Duration {
        match self {
            Outcome::Slow => SLOW_WORK_TIME,
            Outcome::Ok | Outcome::Fail | Outcome::Verify => WORK_TIME,
        }
    }
}

/// 打开启动器的一次请求。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Opening {
    pub dir: PathBuf,
    pub args: Vec<OsString>,
}

/// 假载荷和假启动器收到过的参数。沙箱里既没有真的 NSIS 也没有真的启动器，参数有没有原样送到只能看这里。
#[derive(Debug, Default)]
pub struct Received {
    /// 每次启动载荷的整串参数。
    pub launches: Vec<OsString>,
    pub openings: Vec<Opening>,
}

#[derive(Debug)]
pub struct Fake {
    outcome: Outcome,
    work_time: Duration,
    header: Header,
    payload: Vec<u8>,
    exe: Arc<Vec<u8>>,
    received: Arc<Mutex<Received>>,
}

impl Fake {
    pub fn new(outcome: Outcome, work_time: Duration) -> Self {
        let payload = vec![0x5A; PAYLOAD_LEN];
        let exe = vec![0xA5; EXE_LEN];
        // 载入时要核对头里的数据格式号与能力位，只有 `Header::new` 填的本版本的值过得去
        let header =
            Header::new(&payload, &exe, env!("CARGO_PKG_VERSION")).expect("版本号来自 Cargo.toml");
        Self {
            outcome,
            work_time,
            header,
            payload,
            exe: Arc::new(exe),
            received: Arc::default(),
        }
    }

    /// 交给 [`session`] 之后这份假载荷就拿不回来了，要看收到的参数得先留一份。
    pub fn received(&self) -> Arc<Mutex<Received>> {
        Arc::clone(&self.received)
    }

    /// 环境变量写错直接 panic：这是开发者的开关，悄悄回退到 ok 只会让人以为失败路径测过了。
    pub fn from_env() -> Self {
        let value = std::env::var(ENV_VAR).ok();
        let outcome =
            Outcome::parse(value.as_deref()).unwrap_or_else(|message| panic!("{message}"));
        Self::new(outcome, outcome.work_time())
    }

    pub fn header(&self) -> &Header {
        &self.header
    }

    pub fn payload(&self) -> &[u8] {
        &self.payload
    }
}

#[derive(Default)]
struct MemoryRegistry(Mutex<HashMap<String, String>>);

impl MemoryRegistry {
    fn write(&self, name: &str, value: String) {
        self.0
            .lock()
            .expect("假注册表的锁被 panic 的线程占着")
            .insert(name.to_owned(), value);
    }
}

impl Registry for MemoryRegistry {
    fn read_string(&self, key: &str, value: Option<&str>) -> io::Result<Option<String>> {
        let Some(name) = value.filter(|_| key == UNINSTALL_KEY) else {
            return Ok(None);
        };
        Ok(self
            .0
            .lock()
            .expect("假注册表的锁被 panic 的线程占着")
            .get(name)
            .cloned())
    }
}

/// 假载荷是线程不是进程，没有 pid 可等。
struct NoProcesses;

impl Processes for NoProcesses {
    fn payload_alive(&self, _: u32) -> io::Result<bool> {
        Ok(false)
    }
}

#[derive(Clone)]
struct FakeLauncher {
    outcome: Outcome,
    work_time: Duration,
    instdir: PathBuf,
    exe: Arc<Vec<u8>>,
    version: String,
    registry: Arc<MemoryRegistry>,
    received: Arc<Mutex<Received>>,
}

impl FakeLauncher {
    fn record(&self, note: impl FnOnce(&mut Received)) {
        let mut received = self
            .received
            .lock()
            .expect("参数记录的锁被 panic 的线程占着");
        note(&mut received);
    }

    fn perform(&self) -> io::Result<i32> {
        thread::sleep(self.work_time);
        if self.outcome == Outcome::Fail {
            return Ok(ABORTED);
        }
        fs::create_dir_all(&self.instdir)?;
        let written = match self.outcome {
            // 退出码 0 但文件不对，正是核验要抓的情形
            Outcome::Verify => &self.exe[..self.exe.len() - 1],
            _ => &self.exe[..],
        };
        fs::write(self.instdir.join(APP_EXE), written)?;
        fs::write(self.instdir.join(UNINSTALLER_NAME), b"fake uninstaller")?;
        self.registry.write(DISPLAY_VERSION, self.version.clone());
        self.registry
            .write(INSTALL_LOCATION, format!("\"{}\"", self.instdir.display()));
        Ok(0)
    }
}

impl Launcher for FakeLauncher {
    fn launch(&self, _exe: &Path, _cwd: &Path, arguments: &OsStr) -> io::Result<Box<dyn Running>> {
        self.record(|received| received.launches.push(arguments.to_owned()));
        let script = self.clone();
        // 空参数是非静默向导：假载荷没有向导可显示，等一下就结束
        let wizard = arguments.is_empty();
        let worker = thread::spawn(move || {
            if wizard {
                thread::sleep(script.work_time);
                return Ok(0);
            }
            script.perform()
        });
        Ok(Box::new(FakeRunning {
            worker: Some(worker),
        }))
    }

    fn resolve_instdir(&self, _requested: &Path) -> PathBuf {
        self.instdir.clone()
    }

    /// 开发机上开着真的落樱时，假流程也要走得完。
    fn app_running(&self) -> io::Result<bool> {
        Ok(false)
    }

    /// 沙箱里写的不是真程序，没有什么可打开的，只记下要打开哪里、带什么参数。
    fn open_app(&self, dir: &Path, args: &[OsString], _instance: &Instance) -> io::Result<Opened> {
        self.record(|received| {
            received.openings.push(Opening {
                dir: dir.to_owned(),
                args: args.to_vec(),
            });
        });
        Ok(Opened::Exited(None))
    }
}

struct FakeRunning {
    worker: Option<JoinHandle<io::Result<i32>>>,
}

impl Running for FakeRunning {
    fn pid(&self) -> u32 {
        0
    }

    fn try_wait(&mut self) -> io::Result<Option<i32>> {
        let finished = self.worker.as_ref().is_none_or(JoinHandle::is_finished);
        if !finished {
            return Ok(None);
        }
        let worker = self.worker.take().expect("退出码只取一次");
        worker.join().expect("假载荷线程 panic").map(Some)
    }
}

/// 全部路径根都放进 `sandbox`，并用内存表顶替注册表。
pub fn session(fake: Fake, sandbox: &Path) -> io::Result<Session> {
    let roots = Roots {
        temp: sandbox.join("temp"),
        state: sandbox.join("state"),
        desktop: sandbox.join("desktop"),
    };
    fs::create_dir_all(&roots.temp)?;
    fs::create_dir_all(&roots.desktop)?;
    let registry = Arc::new(MemoryRegistry::default());
    let launcher = FakeLauncher {
        outcome: fake.outcome,
        work_time: fake.work_time,
        instdir: sandbox.join("instdir"),
        exe: Arc::clone(&fake.exe),
        version: fake.header.version.clone(),
        registry: Arc::clone(&registry),
        received: fake.received(),
    };
    Ok(Session::new(
        Source::Fake(fake),
        roots,
        Box::new(launcher),
        registry,
        Box::new(NoProcesses),
    ))
}

#[cfg(test)]
mod tests {
    use petalfall_release::data_format::DATA_FORMAT;
    use petalfall_setup_payload::SHIPPED_CAPS;

    use super::*;
    use crate::contract::{FailureCode, InstallMode, Phase};
    use crate::journal::Recovery;
    use crate::overlay::test_support::random_bytes;
    use crate::runner::Target;
    use crate::runner::test_support::Recording;

    fn target(instdir: &Path, desktop_shortcut: bool) -> Target {
        Target {
            mode: InstallMode::Fresh,
            instdir: instdir.to_owned(),
            desktop_shortcut,
        }
    }

    fn session_for(outcome: Outcome, sandbox: &Path) -> Session {
        session(Fake::new(outcome, Duration::from_millis(5)), sandbox).unwrap()
    }

    #[test]
    fn the_environment_variable_picks_the_outcome() {
        assert_eq!(Outcome::parse(None), Ok(Outcome::Ok));
        assert_eq!(Outcome::parse(Some("ok")), Ok(Outcome::Ok));
        assert_eq!(Outcome::parse(Some("fail")), Ok(Outcome::Fail));
        assert_eq!(Outcome::parse(Some("slow")), Ok(Outcome::Slow));
        assert_eq!(Outcome::parse(Some("verify")), Ok(Outcome::Verify));
    }

    #[test]
    fn a_typo_in_the_environment_variable_is_refused() {
        let message = Outcome::parse(Some("OK")).unwrap_err();

        assert!(message.contains("PETALFALL_SETUP_FAKE"), "{message}");
        assert!(message.ends_with("收到 OK"), "{message}");
    }

    #[test]
    fn slow_runs_past_the_slow_notice_and_the_others_do_not() {
        assert!(Outcome::Slow.work_time() > Duration::from_secs(20));
        assert!(Outcome::Ok.work_time() < Duration::from_secs(20));
    }

    #[test]
    fn the_fake_header_matches_its_own_bytes() {
        let fake = Fake::new(Outcome::Ok, Duration::ZERO);

        assert_eq!(fake.header().payload_len, PAYLOAD_LEN as u64);
        assert_eq!(
            fake.header().payload_sha256,
            petalfall_setup_payload::sha256(fake.payload())
        );
        assert_eq!(fake.header().exe_len, EXE_LEN as u64);
        assert_eq!(fake.header().version, env!("CARGO_PKG_VERSION"));
    }

    #[test]
    fn the_fake_header_carries_this_builds_data_format_and_caps() {
        let fake = Fake::new(Outcome::Ok, Duration::ZERO);

        assert_eq!(fake.header().data_format, Some(DATA_FORMAT));
        assert_eq!(fake.header().caps, Some(SHIPPED_CAPS));
    }

    #[test]
    fn ok_finishes_the_whole_flow_inside_the_sandbox() {
        let sandbox = tempfile::tempdir().unwrap();
        let elsewhere = tempfile::tempdir().unwrap();
        let requested = elsewhere.path().join("Petalfall");
        let session = session_for(Outcome::Ok, sandbox.path());
        let reporter = Recording::default();

        session
            .install(&target(&requested, true), &reporter)
            .unwrap();

        assert!(!requested.exists(), "请求的目录不能被写");
        let instdir = sandbox.path().join("instdir");
        assert_eq!(
            fs::metadata(instdir.join(APP_EXE)).unwrap().len(),
            EXE_LEN as u64
        );
        assert!(instdir.join(UNINSTALLER_NAME).exists());
        assert_eq!(
            reporter.progress.lock().unwrap().last().unwrap().percent,
            100.0
        );
    }

    #[test]
    fn the_session_roots_all_live_in_the_sandbox() {
        let sandbox = tempfile::tempdir().unwrap();

        let session = session_for(Outcome::Ok, sandbox.path());

        let roots = session.roots();
        assert!(roots.temp.starts_with(sandbox.path()));
        assert!(roots.state.starts_with(sandbox.path()));
        assert!(roots.desktop.starts_with(sandbox.path()));
    }

    #[test]
    fn fail_exits_with_2_and_writes_nothing() {
        let sandbox = tempfile::tempdir().unwrap();
        let mut session = session_for(Outcome::Fail, sandbox.path());
        session.quick_exit = Duration::ZERO;

        let failure = session
            .install(
                &target(Path::new(r"D:\Petalfall"), true),
                &Recording::default(),
            )
            .unwrap_err();

        assert_eq!(failure.code, FailureCode::PayloadExit);
        assert_eq!(failure.detail, "2");
        assert!(!sandbox.path().join("instdir").exists());
    }

    #[test]
    fn verify_exits_with_0_and_gets_caught_by_the_check() {
        let sandbox = tempfile::tempdir().unwrap();
        let session = session_for(Outcome::Verify, sandbox.path());

        let failure = session
            .install(
                &target(Path::new(r"D:\Petalfall"), true),
                &Recording::default(),
            )
            .unwrap_err();

        assert_eq!(failure.code, FailureCode::VerifyFailed);
        assert_eq!(
            failure.detail,
            format!("Petalfall.exe 长度 {}，应为 {}", EXE_LEN - 1, EXE_LEN)
        );
    }

    #[test]
    fn progress_passes_through_the_write_phase() {
        let sandbox = tempfile::tempdir().unwrap();
        let session = session(
            Fake::new(Outcome::Ok, Duration::from_millis(250)),
            sandbox.path(),
        )
        .unwrap();
        let reporter = Recording::default();

        session
            .install(&target(Path::new(r"D:\Petalfall"), true), &reporter)
            .unwrap();

        let progress = reporter.progress.lock().unwrap();
        assert!(progress.iter().any(|item| item.phase == Phase::Write));
    }

    #[test]
    fn an_interrupted_record_is_found_on_the_next_session() {
        let sandbox = tempfile::tempdir().unwrap();
        let mut failing = session_for(Outcome::Fail, sandbox.path());
        failing.quick_exit = Duration::ZERO;
        failing
            .install(
                &target(Path::new(r"D:\Petalfall"), true),
                &Recording::default(),
            )
            .unwrap_err();

        let recovery = session_for(Outcome::Ok, sandbox.path()).recover().unwrap();

        assert!(matches!(
            recovery,
            Recovery::Interrupted { journal, .. } if journal.instdir == sandbox.path().join("instdir")
        ));
    }

    #[test]
    fn the_session_reads_its_own_registry_and_never_the_real_one() {
        let sandbox = tempfile::tempdir().unwrap();
        let session = session_for(Outcome::Ok, sandbox.path());

        assert_eq!(
            crate::existing::detect(session.registry(), "0.1.0").unwrap(),
            None
        );

        session
            .install(
                &target(Path::new(r"D:\Petalfall"), true),
                &Recording::default(),
            )
            .unwrap();

        let existing = crate::existing::detect(session.registry(), "0.1.0")
            .unwrap()
            .unwrap();
        assert_eq!(
            existing.dir,
            sandbox.path().join("instdir").display().to_string()
        );
    }

    fn recorded_session(sandbox: &Path) -> (Session, Arc<Mutex<Received>>) {
        let fake = Fake::new(Outcome::Ok, Duration::from_millis(5));
        let received = fake.received();
        (session(fake, sandbox).unwrap(), received)
    }

    /// 每次跑都不一样的一段，免得参数碰巧和哪里写死的值对上。
    fn nonce() -> String {
        format!("--nonce={}", crate::extract::hex(&random_bytes(8)))
    }

    #[test]
    fn nothing_real_is_opened() {
        let sandbox = tempfile::tempdir().unwrap();
        let (session, received) = recorded_session(sandbox.path());
        let crate::boot::Claim::First(instance) = crate::boot::test_claim("fake-open") else {
            panic!("这个名字上不该已有实例");
        };
        let dir = Path::new(r"D:\没有这个目录");
        let args = vec![
            OsString::from("some space"),
            OsString::new(),
            OsString::from(nonce()),
        ];

        assert!(!session.launcher_running().unwrap());
        assert_eq!(
            session.open_launcher(dir, &args, &instance).unwrap(),
            Opened::Exited(None)
        );
        assert_eq!(
            received.lock().unwrap().openings,
            [Opening {
                dir: dir.to_owned(),
                args,
            }]
        );
    }

    #[test]
    fn the_standard_run_does_not_touch_the_install_directory() {
        let sandbox = tempfile::tempdir().unwrap();
        let (session, received) = recorded_session(sandbox.path());

        let code = session
            .start_standard(OsStr::new(""))
            .unwrap()
            .wait_and_clean(&Recording::default())
            .unwrap();

        assert_eq!(code, 0);
        assert!(!sandbox.path().join("instdir").exists());
        assert_eq!(received.lock().unwrap().launches, [OsString::new()]);
    }

    #[test]
    fn update_arguments_reach_the_fake_payload_unchanged() {
        let sandbox = tempfile::tempdir().unwrap();
        let (session, received) = recorded_session(sandbox.path());
        let arguments = OsString::from(format!(
            r#"/P /R /UPDATE /ARGS "C:\游戏 目录\\" "" {}"#,
            nonce()
        ));

        let code = session
            .start_standard(&arguments)
            .unwrap()
            .wait_and_clean(&Recording::default())
            .unwrap();

        assert_eq!(code, 0);
        assert_eq!(received.lock().unwrap().launches, [arguments]);
        // 带参数的是 NSIS 自己的安装，不是向导：假载荷照样把文件写进沙箱
        assert!(sandbox.path().join("instdir").join(APP_EXE).exists());
    }
}
