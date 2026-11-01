//! debug 构建没拼过载荷时的替身，让 `tauri dev` 不需要真实 NSIS 包也能走完整个安装流程。
//!
//! 用 `PETALFALL_SETUP_FAKE=ok|fail|slow|verify` 选结果。所有写入都在系统临时目录下的沙箱里：
//! 请求的安装目录会被换成沙箱内的目录，注册表换成内存表，开发机上真实的安装和桌面都不受影响。

use std::collections::HashMap;
use std::ffi::OsStr;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::Duration;

use aurora_setup_payload::Header;

use super::{Launcher, Roots, Running, Session};
use crate::journal::Processes;
use crate::overlay::Source;
use crate::verify::{
    DISPLAY_VERSION, EXE_NAME, INSTALL_LOCATION, UNINSTALLER_NAME, UninstallEntry,
};

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

#[derive(Debug)]
pub struct Fake {
    outcome: Outcome,
    work_time: Duration,
    header: Header,
    payload: Vec<u8>,
    exe: Arc<Vec<u8>>,
}

impl Fake {
    pub fn new(outcome: Outcome, work_time: Duration) -> Self {
        let payload = vec![0x5A; PAYLOAD_LEN];
        let exe = vec![0xA5; EXE_LEN];
        let header =
            Header::new(&payload, &exe, env!("CARGO_PKG_VERSION")).expect("版本号来自 Cargo.toml");
        Self {
            outcome,
            work_time,
            header,
            payload,
            exe: Arc::new(exe),
        }
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

impl UninstallEntry for MemoryRegistry {
    fn value(&self, name: &str) -> io::Result<Option<String>> {
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
}

impl FakeLauncher {
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
        fs::write(self.instdir.join(EXE_NAME), written)?;
        fs::write(self.instdir.join(UNINSTALLER_NAME), b"fake uninstaller")?;
        self.registry.write(DISPLAY_VERSION, self.version.clone());
        self.registry
            .write(INSTALL_LOCATION, format!("\"{}\"", self.instdir.display()));
        Ok(0)
    }
}

impl Launcher for FakeLauncher {
    fn launch(&self, _exe: &Path, _cwd: &Path, arguments: &OsStr) -> io::Result<Box<dyn Running>> {
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
    use super::*;
    use crate::contract::{FailureCode, InstallMode, Phase};
    use crate::journal::Recovery;
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
            aurora_setup_payload::sha256(fake.payload())
        );
        assert_eq!(fake.header().exe_len, EXE_LEN as u64);
        assert_eq!(fake.header().version, env!("CARGO_PKG_VERSION"));
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
            fs::metadata(instdir.join(EXE_NAME)).unwrap().len(),
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
    fn the_standard_run_does_not_touch_the_install_directory() {
        let sandbox = tempfile::tempdir().unwrap();
        let session = session_for(Outcome::Ok, sandbox.path());

        let code = session
            .start_standard()
            .unwrap()
            .wait_and_clean(&Recording::default())
            .unwrap();

        assert_eq!(code, 0);
        assert!(!sandbox.path().join("instdir").exists());
    }
}
