//! 半装记录：载荷启动前落盘，核验通过才删。下一次启动靠它认出上次没走完的安装。
//!
//! 放在 %LOCALAPPDATA%\Petalfall-Setup：NSIS 覆盖写，中途断电时还没有卸载项，只看注册表和目录认不出这种现场；
//! 也不放进安装目录，那里同时是用户的数据目录，卸载器的非递归 RMDir 还要它能删空。

use std::ffi::OsString;
use std::fs::{self, File};
use std::io::{self, ErrorKind, Write};
use std::os::windows::ffi::OsStringExt;
use std::os::windows::io::{FromRawHandle, OwnedHandle, RawHandle};
use std::path::{Path, PathBuf};
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use windows_sys::Win32::Foundation::{ERROR_ACCESS_DENIED, ERROR_INVALID_PARAMETER, WAIT_TIMEOUT};
use windows_sys::Win32::System::Threading::{
    OpenProcess, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_SYNCHRONIZE,
    QueryFullProcessImageNameW, WaitForSingleObject,
};

use crate::contract::{Existing, ExistingKind, Probe};
use crate::existing::classify;
use crate::extract::PAYLOAD_NAME;
use crate::verify::{Mismatch, fold_dir};

pub const JOURNAL_FILE: &str = "journal.json";
const JOURNAL_TEMP_FILE: &str = "journal.json.tmp";
const IMAGE_NAME_CAPACITY: usize = 32_768;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Journal {
    pub instdir: PathBuf,
    /// 为真时恢复按首装回到原目录：这种半装可能还没有注册表记录，没有现成的安装可修。
    pub was_fresh: bool,
    pub version: String,
    /// 启动前落盘时还没有 pid，那一刻是空。
    pub payload_pid: Option<u32>,
    pub started_at: u64,
}

impl Journal {
    pub fn begin(instdir: &Path, was_fresh: bool, version: &str) -> Self {
        Self {
            instdir: instdir.to_owned(),
            was_fresh,
            version: version.to_owned(),
            payload_pid: None,
            started_at: SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .expect("系统时钟早于 1970 年")
                .as_secs(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct JournalStore {
    root: PathBuf,
}

impl JournalStore {
    pub fn new(state_root: &Path) -> Self {
        Self {
            root: state_root.to_owned(),
        }
    }

    pub fn path(&self) -> PathBuf {
        self.root.join(JOURNAL_FILE)
    }

    /// 先写临时文件再改名，并刷到磁盘：这份记录正是为断电准备的，不能自己也断在半截。
    pub fn save(&self, journal: &Journal) -> io::Result<()> {
        fs::create_dir_all(&self.root)?;
        let temp = self.root.join(JOURNAL_TEMP_FILE);
        let mut file = File::create(&temp)?;
        file.write_all(&serde_json::to_vec_pretty(journal)?)?;
        file.sync_all()?;
        drop(file);
        fs::rename(temp, self.path())
    }

    pub fn clear(&self) -> io::Result<()> {
        match fs::remove_file(self.path()) {
            Err(err) if err.kind() != ErrorKind::NotFound => Err(err),
            _ => Ok(()),
        }
    }

    fn read(&self) -> io::Result<Option<Vec<u8>>> {
        match fs::read(self.path()) {
            Ok(bytes) => Ok(Some(bytes)),
            Err(err) if err.kind() == ErrorKind::NotFound => Ok(None),
            Err(err) => Err(err),
        }
    }
}

/// 进程表的读取口子：测试里决定 pid 活多久，不依赖真实进程。
pub trait Processes: Send + Sync {
    fn payload_alive(&self, pid: u32) -> io::Result<bool>;
}

pub struct SystemProcesses;

impl Processes for SystemProcesses {
    /// pid 会被系统复用，所以活着还不够，镜像名也要对得上。
    fn payload_alive(&self, pid: u32) -> io::Result<bool> {
        let raw = unsafe {
            OpenProcess(
                PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SYNCHRONIZE,
                0,
                pid,
            )
        };
        if raw.is_null() {
            let err = io::Error::last_os_error();
            // 不存在是 87；打不开的是别的账户的进程，载荷和引导程序同账户，那不是它
            return match err.raw_os_error() {
                Some(code)
                    if code == ERROR_INVALID_PARAMETER as i32
                        || code == ERROR_ACCESS_DENIED as i32 =>
                {
                    Ok(false)
                }
                _ => Err(err),
            };
        }
        // 借 OwnedHandle 在所有返回路径上关句柄
        let _process = unsafe { OwnedHandle::from_raw_handle(raw as RawHandle) };
        if unsafe { WaitForSingleObject(raw, 0) } != WAIT_TIMEOUT {
            return Ok(false);
        }

        let mut name = vec![0u16; IMAGE_NAME_CAPACITY];
        let mut len = name.len() as u32;
        if unsafe {
            QueryFullProcessImageNameW(raw, PROCESS_NAME_WIN32, name.as_mut_ptr(), &mut len)
        } == 0
        {
            return Err(io::Error::last_os_error());
        }
        let image = PathBuf::from(OsString::from_wide(&name[..len as usize]));
        Ok(image
            .file_name()
            .is_some_and(|file| file.eq_ignore_ascii_case(PAYLOAD_NAME)))
    }
}

#[derive(Debug, PartialEq, Eq)]
pub enum Recovery {
    /// 没有记录。
    Clean,
    /// 上次其实装完了，记录已删。
    Completed,
    /// 上次没装完，记录保留到下一次核验通过。
    Interrupted {
        journal: Journal,
        mismatches: Vec<Mismatch>,
    },
    /// 记录读不懂，已删。写入是原子的，走到这里说明文件被外部改过；留着它用户就永远出不了半装状态。
    Discarded { reason: String },
}

/// 启动时的恢复判定。载荷还活着时会一直等，要放在工作线程上调。
pub fn recover(
    store: &JournalStore,
    processes: &dyn Processes,
    poll: Duration,
    check: impl FnOnce(&Journal) -> Vec<Mismatch>,
) -> io::Result<Recovery> {
    let Some(bytes) = store.read()? else {
        return Ok(Recovery::Clean);
    };
    let journal: Journal = match serde_json::from_slice(&bytes) {
        Ok(journal) => journal,
        Err(err) => {
            store.clear()?;
            return Ok(Recovery::Discarded {
                reason: err.to_string(),
            });
        }
    };

    if let Some(pid) = journal.payload_pid {
        while processes.payload_alive(pid)? {
            thread::sleep(poll);
        }
    }

    let mismatches = check(&journal);
    if mismatches.is_empty() {
        store.clear()?;
        return Ok(Recovery::Completed);
    }
    Ok(Recovery::Interrupted {
        journal,
        mismatches,
    })
}

/// 把半装状态折进探测结果：升级半装走修复，首装半装回欢迎页按首装重装到原目录。什么都没登记时升级半装也按首装走：
/// 修复的目录取自登记，没有登记就没有现成的安装可修。
///
/// 记录只有核验通过才删，标准安装程序、NSIS 原包和自更新都不碰它，所以它可能早已过期，这时以登记为准：
/// 登记的版本比载荷新时，改成首装或修复都等于绕过降级保护；比记录新时那次安装早被盖过了，半装留下的登记只会比
/// 记录旧，这时藏起现有安装，用户在选目录页换个位置，那份数据就成了孤儿；登记在别的目录时，按记录走首装或修复
/// 都会带着 /D= 把登记改指回记录的目录，原来那份成孤儿。
pub fn mark_interrupted(probe: Probe, journal: &Journal) -> Probe {
    let dir = journal.instdir.to_string_lossy().into_owned();
    let superseded = probe.existing.as_ref().is_some_and(|existing| {
        existing.kind == ExistingKind::Newer
            || classify(&existing.version, &journal.version) == ExistingKind::Newer
            || fold_dir(&existing.dir) != fold_dir(&dir)
    });
    if superseded {
        return probe;
    }
    let Some(existing) = probe.existing.filter(|_| !journal.was_fresh) else {
        return Probe {
            default_dir: dir,
            existing: None,
            interrupted: true,
            ..probe
        };
    };
    Probe {
        existing: Some(Existing {
            kind: ExistingKind::Broken,
            version: existing.version,
            dir,
        }),
        interrupted: true,
        ..probe
    }
}

#[cfg(test)]
mod tests {
    use std::cell::Cell;
    use std::process::{Command, Stdio};
    use std::sync::Mutex;
    use std::sync::atomic::{AtomicU32, Ordering};

    use serde_json::json;

    use super::*;

    fn sample(pid: Option<u32>) -> Journal {
        Journal {
            instdir: PathBuf::from(r"D:\游戏 目录\Petalfall"),
            was_fresh: true,
            version: "0.2.0-dev.7".to_owned(),
            payload_pid: pid,
            started_at: 1_793_000_000,
        }
    }

    fn store() -> (tempfile::TempDir, JournalStore) {
        let dir = tempfile::tempdir().unwrap();
        let store = JournalStore::new(&dir.path().join("Petalfall-Setup"));
        (dir, store)
    }

    fn mismatch() -> Mismatch {
        Mismatch::ExeMissing
    }

    /// 前 `alive_polls` 次回答活着，之后回答退出，并记下问过哪些 pid。
    struct Scripted {
        alive_polls: AtomicU32,
        asked: Mutex<Vec<u32>>,
    }

    impl Scripted {
        fn new(alive_polls: u32) -> Self {
            Self {
                alive_polls: AtomicU32::new(alive_polls),
                asked: Mutex::default(),
            }
        }
    }

    impl Processes for Scripted {
        fn payload_alive(&self, pid: u32) -> io::Result<bool> {
            self.asked.lock().unwrap().push(pid);
            let left = self.alive_polls.load(Ordering::SeqCst);
            if left == 0 {
                return Ok(false);
            }
            self.alive_polls.store(left - 1, Ordering::SeqCst);
            Ok(true)
        }
    }

    #[test]
    fn begin_records_the_target_and_has_no_pid_yet() {
        let journal = Journal::begin(Path::new(r"D:\Petalfall"), true, "1.0.0");

        assert_eq!(journal.instdir, PathBuf::from(r"D:\Petalfall"));
        assert!(journal.was_fresh);
        assert_eq!(journal.version, "1.0.0");
        assert_eq!(journal.payload_pid, None);
        // 2026 年之后的某个时刻：秒而不是毫秒
        assert!((1_767_000_000..10_000_000_000).contains(&journal.started_at));
    }

    #[test]
    fn the_file_uses_the_agreed_field_names() {
        let (_dir, store) = store();

        store.save(&sample(Some(4242))).unwrap();

        let saved: serde_json::Value =
            serde_json::from_slice(&fs::read(store.path()).unwrap()).unwrap();
        assert_eq!(
            saved,
            json!({
                "instdir": r"D:\游戏 目录\Petalfall",
                "was_fresh": true,
                "version": "0.2.0-dev.7",
                "payload_pid": 4242,
                "started_at": 1_793_000_000u64,
            })
        );
    }

    #[test]
    fn save_creates_the_directory_and_replaces_the_old_record() {
        let (dir, store) = store();

        store.save(&sample(None)).unwrap();
        store.save(&sample(Some(7))).unwrap();

        let names: Vec<_> = fs::read_dir(dir.path().join("Petalfall-Setup"))
            .unwrap()
            .map(|entry| entry.unwrap().file_name())
            .collect();
        assert_eq!(names, ["journal.json"]);
        let saved: Journal = serde_json::from_slice(&fs::read(store.path()).unwrap()).unwrap();
        assert_eq!(saved, sample(Some(7)));
    }

    #[test]
    fn clear_is_fine_when_there_is_nothing_to_clear() {
        let (_dir, store) = store();

        store.clear().unwrap();
        store.save(&sample(None)).unwrap();
        store.clear().unwrap();

        assert!(!store.path().exists());
    }

    #[test]
    fn no_record_means_a_clean_start() {
        let (_dir, store) = store();
        let processes = Scripted::new(0);

        let recovery = recover(&store, &processes, Duration::ZERO, |_| {
            panic!("没有记录不该核验")
        })
        .unwrap();

        assert_eq!(recovery, Recovery::Clean);
        assert!(processes.asked.lock().unwrap().is_empty());
    }

    #[test]
    fn a_passing_check_clears_the_record() {
        let (_dir, store) = store();
        store.save(&sample(Some(10))).unwrap();

        let recovery = recover(&store, &Scripted::new(0), Duration::ZERO, |_| vec![]).unwrap();

        assert_eq!(recovery, Recovery::Completed);
        assert!(!store.path().exists());
    }

    #[test]
    fn a_failing_check_keeps_the_record_and_reports_why() {
        let (_dir, store) = store();
        store.save(&sample(Some(10))).unwrap();

        let recovery = recover(&store, &Scripted::new(0), Duration::ZERO, |_| {
            vec![mismatch()]
        })
        .unwrap();

        assert_eq!(
            recovery,
            Recovery::Interrupted {
                journal: sample(Some(10)),
                mismatches: vec![mismatch()],
            }
        );
        assert!(store.path().exists());
    }

    #[test]
    fn a_live_payload_is_waited_for_before_checking() {
        let (_dir, store) = store();
        store.save(&sample(Some(99))).unwrap();
        let processes = Scripted::new(3);
        let polls_when_checked = Cell::new(0);

        recover(&store, &processes, Duration::ZERO, |_| {
            polls_when_checked.set(processes.asked.lock().unwrap().len());
            vec![]
        })
        .unwrap();

        assert_eq!(polls_when_checked.get(), 4);
        assert_eq!(*processes.asked.lock().unwrap(), vec![99; 4]);
    }

    #[test]
    fn a_record_without_a_pid_goes_straight_to_the_check() {
        let (_dir, store) = store();
        store.save(&sample(None)).unwrap();
        let processes = Scripted::new(5);

        let recovery = recover(&store, &processes, Duration::ZERO, |_| vec![]).unwrap();

        assert_eq!(recovery, Recovery::Completed);
        assert!(processes.asked.lock().unwrap().is_empty());
    }

    #[test]
    fn an_unreadable_record_is_discarded_with_the_reason() {
        let (_dir, store) = store();
        store.save(&sample(None)).unwrap();
        fs::write(store.path(), b"{ not json").unwrap();

        let recovery = recover(&store, &Scripted::new(0), Duration::ZERO, |_| {
            panic!("读不懂不该核验")
        })
        .unwrap();

        assert!(matches!(recovery, Recovery::Discarded { reason } if !reason.is_empty()));
        assert!(!store.path().exists());
    }

    struct Failing;

    impl Processes for Failing {
        fn payload_alive(&self, _: u32) -> io::Result<bool> {
            Err(io::Error::from_raw_os_error(6))
        }
    }

    #[test]
    fn a_process_table_error_surfaces_instead_of_passing_as_exited() {
        let (_dir, store) = store();
        store.save(&sample(Some(1))).unwrap();

        let err = recover(&store, &Failing, Duration::ZERO, |_| vec![]).unwrap_err();

        assert_eq!(err.raw_os_error(), Some(6));
        assert!(store.path().exists());
    }

    fn probe(existing: Option<Existing>) -> Probe {
        Probe {
            payload_version: "0.3.0".into(),
            default_dir: r"C:\Users\a\AppData\Local\Petalfall".into(),
            required_bytes: 123,
            existing,
            interrupted: false,
            elevated: true,
            update: None,
        }
    }

    #[test]
    fn a_fresh_half_install_returns_to_welcome_with_its_directory() {
        let half_registered = probe(Some(Existing {
            kind: ExistingKind::Upgrade,
            version: "0.2.0-dev.7".into(),
            dir: r"D:\游戏 目录\Petalfall".into(),
        }));

        let marked = mark_interrupted(half_registered, &sample(None));

        assert_eq!(
            marked,
            Probe {
                payload_version: "0.3.0".into(),
                default_dir: r"D:\游戏 目录\Petalfall".into(),
                required_bytes: 123,
                existing: None,
                interrupted: true,
                elevated: true,
                update: None,
            }
        );
    }

    #[test]
    fn a_newer_install_keeps_its_downgrade_block_whatever_the_record_says() {
        for was_fresh in [true, false] {
            // 记录比登记还新：更老的安装包接手了更新的安装包留下的半装，这时只有 Newer 这一项在挡
            let journal = Journal {
                was_fresh,
                version: "0.5.0".into(),
                ..sample(None)
            };
            for dir in [r"D:\游戏 目录\Petalfall", r"E:\Elsewhere"] {
                let found = probe(Some(Existing {
                    kind: ExistingKind::Newer,
                    version: "0.4.0".into(),
                    dir: dir.into(),
                }));

                assert_eq!(mark_interrupted(found.clone(), &journal), found);
            }
        }
    }

    #[test]
    fn a_fresh_record_does_not_hide_an_install_registered_elsewhere() {
        // 首装失败后改用标准安装程序，装到了默认目录：再按记录走首装，/D= 会把登记改指回去
        let found = probe(Some(Existing {
            kind: ExistingKind::Upgrade,
            version: "0.2.0-dev.7".into(),
            dir: r"C:\Users\a\AppData\Local\Petalfall".into(),
        }));

        assert_eq!(mark_interrupted(found.clone(), &sample(None)), found);
    }

    #[test]
    fn a_record_older_than_the_registered_version_leaves_a_working_install_alone() {
        // 引导程序被结束后载荷自己装完了，没人再开安装包，记录就一直留着；启动器之后自己更新过，
        // 拿旧版本核验永远不过。半装留下的登记只会比记录旧，比记录新就说明那次安装早被盖过了
        for was_fresh in [true, false] {
            let journal = Journal {
                was_fresh,
                ..sample(None)
            };
            for (kind, version) in [
                (ExistingKind::Upgrade, "0.2.0"),
                (ExistingKind::Same, "0.3.0"),
            ] {
                let found = probe(Some(Existing {
                    kind,
                    version: version.into(),
                    dir: r"D:\游戏 目录\Petalfall".into(),
                }));

                assert_eq!(mark_interrupted(found.clone(), &journal), found);
            }
        }
    }

    #[test]
    fn a_half_upgrade_of_a_directory_no_longer_registered_is_superseded() {
        // 按记录的目录修复会带着 /D= 把登记改指过来，登记的那份就成了孤儿
        let journal = Journal {
            was_fresh: false,
            ..sample(None)
        };
        let found = probe(Some(Existing {
            kind: ExistingKind::Upgrade,
            version: "0.1.0".into(),
            dir: r"E:\Old".into(),
        }));

        assert_eq!(mark_interrupted(found.clone(), &journal), found);
    }

    #[test]
    fn the_registered_directory_matches_despite_case_and_trailing_separator() {
        let journal = Journal {
            was_fresh: false,
            ..sample(None)
        };
        let existing = Some(Existing {
            kind: ExistingKind::Upgrade,
            version: "0.1.0".into(),
            dir: r"d:\游戏 目录\PETALFALL\".into(),
        });

        let marked = mark_interrupted(probe(existing), &journal);

        assert_eq!(marked.existing.unwrap().kind, ExistingKind::Broken);
        assert!(marked.interrupted);
    }

    #[test]
    fn a_half_upgrade_becomes_a_broken_install_keeping_the_registered_version() {
        let journal = Journal {
            was_fresh: false,
            ..sample(None)
        };
        let existing = Some(Existing {
            kind: ExistingKind::Upgrade,
            version: "0.1.0".into(),
            dir: r"D:\游戏 目录\Petalfall".into(),
        });

        let marked = mark_interrupted(probe(existing), &journal);

        assert_eq!(
            marked.existing,
            Some(Existing {
                kind: ExistingKind::Broken,
                version: "0.1.0".into(),
                dir: r"D:\游戏 目录\Petalfall".into(),
            })
        );
        assert!(marked.interrupted);
        assert_eq!(marked.default_dir, r"C:\Users\a\AppData\Local\Petalfall");
    }

    #[test]
    fn a_half_upgrade_with_nothing_registered_resumes_like_a_fresh_install() {
        // 半装之后卸载并勾了删除数据：没有登记就没有现成的安装可修，只能按首装回到记录的目录
        let journal = Journal {
            was_fresh: false,
            ..sample(None)
        };

        let marked = mark_interrupted(probe(None), &journal);

        assert_eq!(
            marked,
            Probe {
                default_dir: r"D:\游戏 目录\Petalfall".into(),
                interrupted: true,
                ..probe(None)
            }
        );
    }

    #[test]
    fn system_processes_rejects_pids_that_do_not_exist() {
        // 4 的倍数才可能是 pid，这个值超出了系统的 pid 上限
        assert!(!SystemProcesses.payload_alive(0xFFFF_FFFC).unwrap());
    }

    #[test]
    fn system_processes_ignores_a_live_process_with_another_image_name() {
        assert!(!SystemProcesses.payload_alive(std::process::id()).unwrap());
    }

    /// cmd.exe 的副本改名成 `image_name`，stdin 管道开着时它一直等输入，关掉就退出；全程不碰真实安装包。
    /// 返回它还在跑时和退出后各问一次的回答。
    fn alive_then_after_exit(image_name: &str) -> (bool, bool) {
        let dir = tempfile::tempdir().unwrap();
        let image = dir.path().join(image_name);
        let cmd = Path::new(&std::env::var_os("SystemRoot").unwrap()).join(r"System32\cmd.exe");
        fs::copy(cmd, &image).unwrap();
        let mut child = Command::new(&image)
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        let pid = child.id();

        let alive = SystemProcesses.payload_alive(pid).unwrap();
        drop(child.stdin.take());
        child.wait().unwrap();
        let after_exit = SystemProcesses.payload_alive(pid).unwrap();
        (alive, after_exit)
    }

    #[test]
    fn system_processes_sees_a_live_payload_and_notices_when_it_exits() {
        assert_eq!(alive_then_after_exit(PAYLOAD_NAME), (true, false));
    }

    #[test]
    fn system_processes_sees_the_lowercase_payload_of_an_older_bootstrapper() {
        // 旧版引导程序解出的载荷叫这个名字：接手它留下的半装时，不能把还在跑的载荷当成已退出就去核验
        assert_eq!(alive_then_after_exit("petalfall-nsis.exe"), (true, false));
    }
}
