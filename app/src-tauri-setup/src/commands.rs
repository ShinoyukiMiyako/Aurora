//! 前端命令：把契约里的命令接到各模块。判定都在模块里，这里只管线程和这次启动要记住的东西。
//!
//! 不带 `async` 的命令跑在窗口线程上。碰盘、等进程的活都走 [`on_worker`]，否则窗口会跟着卡住。
//! 除 `install` 外，拒绝一律是字符串：前端把它们当意外，进致命错误页显示原文。

use std::fmt::Display;
use std::io;
use std::path::Path;
use std::sync::{Arc, Mutex, PoisonError};

use tauri::ipc::InvokeError;
use tauri::{AppHandle, Emitter, State, WebviewWindow};

use crate::boot::{self, Instance};
use crate::contract::{DirCheck, Failure, InstallPlan, PROGRESS_EVENT, Probe, Progress};
use crate::existing::{self, Registry};
use crate::journal::{self, Recovery};
use crate::launcher::Opened;
use crate::log::{self, SetupLog};
use crate::runner::{Reporter, Session, StandardRun, Target};
use crate::target::{self, APP_FOLDER, SpaceNeed, SystemEnv, TargetEnv};

/// 探测时认定、之后的命令还要用的目录。
#[derive(Debug, Default)]
struct Located {
    /// 升级和修复的目录，前端的计划里不带。
    registered: Option<String>,
    /// 已知属于落樱的目录：半装记录或卸载残留。目录内容证明不了归属，校验时不能再套一层。
    resume: Option<String>,
}

/// 窗口存活期间共用的东西，也是 `main.rs` 里 `manage` 进去的状态。
pub struct SetupContext {
    session: Session,
    instance: Arc<Instance>,
    log: Arc<SetupLog>,
    located: Mutex<Located>,
    /// 用户选了原生向导。窗口关掉后进程还要等它退出：临时文件要靠守卫句柄钉到那时。
    wizard: Mutex<Option<StandardRun>>,
}

impl SetupContext {
    pub fn new(session: Session, instance: Arc<Instance>, log: Arc<SetupLog>) -> Self {
        Self {
            session,
            instance,
            log,
            located: Mutex::default(),
            wizard: Mutex::default(),
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

    pub fn probe(&self) -> io::Result<Probe> {
        self.sweep_temp();
        let recovery = self.session.recover()?;
        self.note_recovery(&recovery);

        let default_dir = log::local_app_data()?
            .join(APP_FOLDER)
            .to_string_lossy()
            .into_owned();
        let probe = assemble_probe(
            self.session.registry(),
            &self.session.header().version,
            self.need().target,
            default_dir.clone(),
            recovery,
            boot::is_elevated()?,
        )?;
        self.log.info(format_args!("探测结果：{probe:?}"));

        *self.located.lock().unwrap_or_else(PoisonError::into_inner) = Located {
            registered: probe.existing.as_ref().map(|existing| existing.dir.clone()),
            resume: (probe.default_dir != default_dir).then(|| probe.default_dir.clone()),
        };
        Ok(probe)
    }

    pub fn check_dir(&self, path: &str, env: &dyn TargetEnv) -> DirCheck {
        let resume = self
            .located
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .resume
            .clone();
        target::check_dir(path, self.need(), resume.as_deref(), env)
    }

    pub fn launcher_running(&self) -> io::Result<bool> {
        self.session.launcher_running()
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
        self.session.install(&target, reporter)
    }

    pub fn open_launcher(&self, dir: &Path) -> io::Result<Opened> {
        let opened = self.session.open_launcher(dir, &self.instance)?;
        self.log.info(format_args!("打开启动器：{opened:?}"));
        Ok(opened)
    }

    /// 启动原生向导，不等它结束：调用方随后关窗。要等结束时用 [`Self::wait_for_wizard`]。
    pub fn start_wizard(&self) -> Result<(), Failure> {
        let wizard = self.session.start_standard()?;
        self.log
            .info(format_args!("原生向导已启动，pid {}", wizard.pid()));
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

/// 把这台电脑的现状折成探测结果。顺序不能换：半装记录要盖在现有安装的判定之上。
fn assemble_probe(
    registry: &dyn Registry,
    payload_version: &str,
    required_bytes: u64,
    default_dir: String,
    recovery: Recovery,
    elevated: bool,
) -> io::Result<Probe> {
    let existing = existing::detect(registry, payload_version)?;
    let leftover = match existing {
        Some(_) => None,
        None => existing::leftover_dir(registry)?,
    };
    let probe = Probe {
        payload_version: payload_version.to_owned(),
        default_dir: leftover.unwrap_or(default_dir),
        required_bytes,
        existing,
        interrupted: false,
        elevated,
    };
    Ok(match recovery {
        Recovery::Interrupted { journal, .. } => journal::mark_interrupted(probe, &journal),
        Recovery::Clean | Recovery::Completed | Recovery::Discarded { .. } => probe,
    })
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

    use super::*;
    use crate::contract::{Existing, ExistingKind};
    use crate::existing::{
        APP_EXE, CONFIG_FILE, DISPLAY_VERSION, INSTALL_LOCATION, LAST_DIR_KEY, UNINSTALL_KEY,
    };
    use crate::journal::Journal;

    const PAYLOAD: &str = "0.2.0";
    const DEFAULT_DIR: &str = r"C:\Users\a\AppData\Local\Petalfall";
    const REQUIRED: u64 = 52_428_800;

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

    fn assemble(registry: &Table, recovery: Recovery) -> Probe {
        assemble_probe(
            registry,
            PAYLOAD,
            REQUIRED,
            DEFAULT_DIR.to_owned(),
            recovery,
            false,
        )
        .unwrap()
    }

    fn interrupted(dir: &Path, was_fresh: bool) -> Recovery {
        Recovery::Interrupted {
            journal: Journal::begin(dir, was_fresh, PAYLOAD),
            mismatches: vec![],
        }
    }

    fn app_dir() -> (tempfile::TempDir, String) {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join(APP_EXE), b"MZ").unwrap();
        let text = dir.path().to_str().unwrap().to_owned();
        (dir, text)
    }

    #[test]
    fn a_clean_machine_installs_fresh_to_the_default_dir() {
        let probe = assemble(&Table::default(), Recovery::Clean);

        assert_eq!(
            probe,
            Probe {
                payload_version: PAYLOAD.to_owned(),
                default_dir: DEFAULT_DIR.to_owned(),
                required_bytes: REQUIRED,
                existing: None,
                interrupted: false,
                elevated: false,
            }
        );
    }

    #[test]
    fn elevation_reaches_the_probe() {
        let probe = assemble_probe(
            &Table::default(),
            PAYLOAD,
            REQUIRED,
            DEFAULT_DIR.to_owned(),
            Recovery::Clean,
            true,
        )
        .unwrap();

        assert!(probe.elevated);
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
            })
        );
        assert!(probe.interrupted);
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
        use crate::journal::JournalStore;
        use crate::runner::fake::{self, Fake, Outcome};
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
        }

        fn rig(test: &str) -> Rig {
            let sandbox = tempfile::tempdir().unwrap();
            let session = fake::session(
                Fake::new(Outcome::Ok, Duration::from_millis(5)),
                sandbox.path(),
            )
            .unwrap();
            let Claim::First(instance) = test_claim(&format!("commands-{test}")) else {
                panic!("{test} 上不该已有实例");
            };
            let log = SetupLog::open(&sandbox.path().join("log")).unwrap();
            let context = SetupContext::new(session, Arc::new(instance), Arc::new(log));
            Rig { sandbox, context }
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
            assert!(rig.logged().contains("开始安装"));
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
            let context = SetupContext::new(session, Arc::new(instance), Arc::new(log));

            let failure = context
                .install(&fresh(r"D:\Petalfall"), &Recording::default())
                .unwrap_err();

            assert_eq!(failure.code, FailureCode::VerifyFailed);
        }

        #[test]
        fn opening_the_launcher_stays_inside_the_fake() {
            let rig = rig("open");

            let opened = rig.context.open_launcher(Path::new(r"D:\没有这个目录"));

            assert_eq!(opened.unwrap(), Opened::Exited(None));
            assert!(rig.logged().contains("打开启动器"));
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
        fn a_probe_on_a_clean_sandbox_defaults_under_local_app_data() {
            let rig = rig("default");

            let probe = rig.context.probe().unwrap();

            assert_eq!(
                probe.default_dir,
                log::local_app_data()
                    .unwrap()
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
    }
}
