//! 把载荷解到临时目录，从磁盘重读校验，并守着这份文件直到子进程退出。
//!
//! 目录放在 %TEMP% 的随机子目录里：安装目录同时是数据目录，不能放临时文件；独立目录也避开了同目录 DLL 劫持。
//! 文件名固定，不取自载荷头：头在未签名时可被篡改，取名就成了路径穿越。

use std::fs::{self, File, OpenOptions};
use std::io::{self, ErrorKind, Read};
use std::os::windows::fs::OpenOptionsExt;
use std::path::{Path, PathBuf};
use std::thread;
use std::time::{Duration, SystemTime};

use petalfall_setup_payload::Header;
use sha2::{Digest, Sha256};
use tempfile::TempDir;
use windows_sys::Win32::Foundation::{ERROR_ACCESS_DENIED, ERROR_SHARING_VIOLATION};
use windows_sys::Win32::Storage::FileSystem::FILE_SHARE_READ;

use crate::contract::{Failure, FailureCode};

pub const TEMP_PREFIX: &str = "Petalfall-Setup-";
/// 窗口的 WebView2 数据目录也建在系统临时目录下（`main.rs`）：默认的数据目录会永远留在 `%LOCALAPPDATA%`，
/// 引导程序没有卸载流程。正常关窗会删，进程被强杀时走不到那一步，残留交给 [`sweep_stale`]。
pub const WEBVIEW_DATA_PREFIX: &str = "petalfall-setup-webview-";
/// 只能改大小写：半装恢复按镜像名认载荷还在不在跑，每个发出去的引导程序都不分大小写比较
/// （`journal::SystemProcesses::payload_alive`），新旧版本接手对方留下的半装时才认得出对方解出的载荷。
pub const PAYLOAD_NAME: &str = "Petalfall-NSIS.exe";
/// 更新的目录可能还有另一次安装或另一个窗口在用。
pub const STALE_AFTER: Duration = Duration::from_secs(24 * 60 * 60);
/// 原样比较、分大小写。两种目录都由 tempfile 照前缀原样起名，NTFS 保留大小写，引导程序建的只会是这两种写法，
/// 不分大小写只会多删到别的程序起的目录。代价是被人改过大小写的残留一直留着，只占点空间。
const SWEPT_PREFIXES: [&str; 2] = [TEMP_PREFIX, WEBVIEW_DATA_PREFIX];

/// 杀软扫描刚落盘的文件时，打开和启动都会短暂撞上访问拒绝或共享冲突，退避约 3 秒通常就过了。
pub(crate) const BACKOFF: [Duration; 6] = [
    Duration::from_millis(50),
    Duration::from_millis(100),
    Duration::from_millis(200),
    Duration::from_millis(400),
    Duration::from_millis(800),
    Duration::from_millis(1600),
];
const CLEANUP_BACKOFF: [Duration; 1] = [Duration::from_millis(200)];
const HASH_BUFFER_LEN: usize = 1 << 20;

fn is_transient(err: &io::Error) -> bool {
    err.raw_os_error().is_some_and(|code| {
        code == ERROR_SHARING_VIOLATION as i32 || code == ERROR_ACCESS_DENIED as i32
    })
}

/// 只重试访问拒绝和共享冲突，`delays` 用完后把最后一次错误原样交出去。
pub(crate) fn retry_transient<T>(
    delays: &[Duration],
    mut op: impl FnMut() -> io::Result<T>,
) -> io::Result<T> {
    let mut remaining = delays.iter();
    loop {
        match op() {
            Err(err) if is_transient(&err) => match remaining.next() {
                Some(delay) => thread::sleep(*delay),
                None => return Err(err),
            },
            outcome => return outcome,
        }
    }
}

pub(crate) fn hash_reader(reader: &mut impl Read) -> io::Result<[u8; 32]> {
    let mut hasher = Sha256::new();
    let mut buffer = vec![0u8; HASH_BUFFER_LEN];
    loop {
        match reader.read(&mut buffer)? {
            0 => return Ok(hasher.finalize().into()),
            read => hasher.update(&buffer[..read]),
        }
    }
}

pub(crate) fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

/// 磁盘满要单独分出来：界面给的恢复办法是换一块盘，不是重试。
pub(crate) fn io_failure(stage: &str, err: &io::Error) -> Failure {
    let code = if err.kind() == ErrorKind::StorageFull {
        FailureCode::DiskFull
    } else {
        FailureCode::ExtractFailed
    };
    Failure {
        code,
        detail: format!("{stage}：{err}"),
    }
}

/// 只允许别的进程读：运行期间文件不能被写、改名或删除，校验到执行之间没有替换窗口。
/// 不用 DELETE_ON_CLOSE：NSIS 以 FILE_SHARE_READ 打开自身，带这个标记的句柄会让它共享冲突并退出。
fn open_guard(path: &Path) -> io::Result<File> {
    OpenOptions::new()
        .read(true)
        .share_mode(FILE_SHARE_READ)
        .open(path)
}

fn write_payload(payload: &mut impl Read, path: &Path) -> io::Result<()> {
    let mut file = OpenOptions::new().write(true).create_new(true).open(path)?;
    io::copy(payload, &mut file)?;
    Ok(())
}

/// 已校验、被守卫句柄钉住的载荷。
#[derive(Debug)]
pub struct Extracted {
    dir: TempDir,
    path: PathBuf,
    guard: File,
}

impl Extracted {
    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn dir(&self) -> &Path {
        self.dir.path()
    }

    /// 子进程退出后调。失败不影响安装结果，残留交给下次启动清扫。
    pub fn cleanup(self) -> io::Result<()> {
        let Extracted { dir, path, guard } = self;
        drop(guard);
        match retry_transient(&CLEANUP_BACKOFF, || fs::remove_file(&path)) {
            Err(err) if err.kind() != ErrorKind::NotFound => return Err(err),
            _ => {}
        }
        dir.close()
    }
}

/// 写完立刻关闭写句柄：句柄还开着时启动子进程必然共享冲突。校验读的是守卫句柄，确认的就是将要执行的字节，
/// 杀软改写或截断也在这里暴露。
pub fn extract(
    mut payload: impl Read,
    header: &Header,
    temp_root: &Path,
) -> Result<Extracted, Failure> {
    let dir = tempfile::Builder::new()
        .prefix(TEMP_PREFIX)
        .tempdir_in(temp_root)
        .map_err(|err| io_failure("建临时目录", &err))?;
    let path = dir.path().join(PAYLOAD_NAME);
    write_payload(&mut payload, &path).map_err(|err| io_failure("写载荷", &err))?;

    let mut guard = retry_transient(&BACKOFF, || open_guard(&path))
        .map_err(|err| io_failure("重新打开载荷", &err))?;
    let actual = hash_reader(&mut guard).map_err(|err| io_failure("校验载荷", &err))?;
    if actual != header.payload_sha256 {
        return Err(Failure {
            code: FailureCode::ExtractFailed,
            detail: format!(
                "解开后的载荷 SHA-256 是 {}，应为 {}",
                hex(&actual),
                hex(&header.payload_sha256)
            ),
        });
    }
    Ok(Extracted { dir, path, guard })
}

#[derive(Debug, Default)]
pub struct Sweep {
    pub removed: Vec<PathBuf>,
    /// 被占用或读不出属性的目录，留给下一次。
    pub skipped: Vec<(PathBuf, io::Error)>,
}

/// 清扫崩溃、断电或被强杀留下的目录：解载荷的临时目录和窗口的 WebView2 数据目录。`now` 由调用方给，时间边界才测得了。
pub fn sweep_stale(temp_root: &Path, now: SystemTime) -> io::Result<Sweep> {
    let mut sweep = Sweep::default();
    for entry in fs::read_dir(temp_root)? {
        let entry = entry?;
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if !SWEPT_PREFIXES.iter().any(|prefix| name.starts_with(prefix)) {
            continue;
        }
        // 联接点和符号链接的 is_dir 是假：只删自己建的目录，不顺着链接走到别处
        if !entry.file_type()?.is_dir() {
            continue;
        }
        let path = entry.path();
        let modified = match entry.metadata().and_then(|metadata| metadata.modified()) {
            Ok(modified) => modified,
            Err(err) => {
                sweep.skipped.push((path, err));
                continue;
            }
        };
        if now
            .duration_since(modified)
            .is_ok_and(|age| age >= STALE_AFTER)
        {
            match fs::remove_dir_all(&path) {
                Ok(()) => sweep.removed.push(path),
                Err(err) => sweep.skipped.push((path, err)),
            }
        }
    }
    Ok(sweep)
}

#[cfg(test)]
mod tests {
    use std::cell::Cell;
    use std::io::Cursor;
    use std::os::windows::process::CommandExt;
    use std::process::{Command, Stdio};

    use windows_sys::Win32::Storage::FileSystem::{
        FILE_FLAG_BACKUP_SEMANTICS, FILE_WRITE_ATTRIBUTES,
    };
    use windows_sys::Win32::System::Threading::CREATE_NO_WINDOW;

    use super::*;
    use crate::overlay::test_support::random_bytes;

    fn header_for(payload: &[u8]) -> Header {
        Header::new(payload, b"exe", "1.0.0").unwrap()
    }

    #[test]
    fn extract_writes_the_payload_under_a_random_prefixed_directory() {
        let temp = tempfile::tempdir().unwrap();
        let payload = random_bytes(3 * 1024 + 1);

        let extracted = extract(Cursor::new(&payload), &header_for(&payload), temp.path()).unwrap();

        assert_eq!(extracted.path().file_name().unwrap(), "Petalfall-NSIS.exe");
        let dir = extracted
            .dir()
            .file_name()
            .unwrap()
            .to_string_lossy()
            .into_owned();
        assert!(dir.starts_with("Petalfall-Setup-"), "{dir}");
        assert!(dir.len() > "Petalfall-Setup-".len(), "{dir}");
        assert_eq!(extracted.dir().parent().unwrap(), temp.path());
        assert_eq!(fs::read(extracted.path()).unwrap(), payload);
    }

    #[test]
    fn each_extraction_gets_its_own_directory() {
        let temp = tempfile::tempdir().unwrap();
        let payload = random_bytes(16);
        let header = header_for(&payload);

        let first = extract(Cursor::new(&payload), &header, temp.path()).unwrap();
        let second = extract(Cursor::new(&payload), &header, temp.path()).unwrap();

        assert_ne!(first.dir(), second.dir());
    }

    #[test]
    fn the_guard_lets_others_read_but_not_write_or_delete() {
        let temp = tempfile::tempdir().unwrap();
        let payload = random_bytes(64);
        let extracted = extract(Cursor::new(&payload), &header_for(&payload), temp.path()).unwrap();

        let write = OpenOptions::new().write(true).open(extracted.path());
        assert_eq!(
            write.unwrap_err().raw_os_error(),
            Some(ERROR_SHARING_VIOLATION as i32)
        );
        assert!(fs::remove_file(extracted.path()).is_err());
        assert_eq!(fs::read(extracted.path()).unwrap(), payload);
    }

    #[test]
    fn the_guard_does_not_stop_the_file_from_being_executed() {
        // cmd.exe 的副本代替载荷：要证明守卫句柄下能启动，又不能碰真实安装包
        let cmd = Path::new(&std::env::var_os("SystemRoot").unwrap()).join(r"System32\cmd.exe");
        let bytes = fs::read(cmd).unwrap();
        let temp = tempfile::tempdir().unwrap();
        let extracted = extract(Cursor::new(&bytes), &header_for(&bytes), temp.path()).unwrap();

        let status = Command::new(extracted.path())
            .args(["/d", "/c", "exit 7"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .unwrap();

        assert_eq!(status.code(), Some(7));
    }

    #[test]
    fn a_corrupted_payload_fails_and_leaves_nothing_behind() {
        let temp = tempfile::tempdir().unwrap();
        let mut payload = random_bytes(128);
        let header = header_for(&payload);
        payload[127] ^= 0xFF;

        let failure = extract(Cursor::new(&payload), &header, temp.path()).unwrap_err();

        assert_eq!(failure.code, FailureCode::ExtractFailed);
        assert!(
            failure.detail.contains(&hex(&header.payload_sha256)),
            "{}",
            failure.detail
        );
        assert_eq!(fs::read_dir(temp.path()).unwrap().count(), 0);
    }

    #[test]
    fn a_short_read_is_caught_by_the_hash() {
        let temp = tempfile::tempdir().unwrap();
        let payload = random_bytes(128);

        let failure = extract(
            Cursor::new(&payload[..127]),
            &header_for(&payload),
            temp.path(),
        )
        .unwrap_err();

        assert_eq!(failure.code, FailureCode::ExtractFailed);
    }

    struct BrokenReader(i32);

    impl Read for BrokenReader {
        fn read(&mut self, _: &mut [u8]) -> io::Result<usize> {
            Err(io::Error::from_raw_os_error(self.0))
        }
    }

    #[test]
    fn a_full_disk_is_reported_as_disk_full_for_both_system_codes() {
        for code in [112, 39] {
            let temp = tempfile::tempdir().unwrap();

            let failure = extract(BrokenReader(code), &header_for(b"x"), temp.path()).unwrap_err();

            assert_eq!(failure.code, FailureCode::DiskFull, "os error {code}");
            assert!(failure.detail.starts_with("写载荷："), "{}", failure.detail);
        }
    }

    #[test]
    fn other_write_errors_are_extract_failed_with_the_system_code() {
        let temp = tempfile::tempdir().unwrap();

        let failure = extract(BrokenReader(225), &header_for(b"x"), temp.path()).unwrap_err();

        assert_eq!(failure.code, FailureCode::ExtractFailed);
        assert!(
            failure.detail.contains("os error 225"),
            "{}",
            failure.detail
        );
    }

    #[test]
    fn a_missing_temp_root_is_extract_failed() {
        let temp = tempfile::tempdir().unwrap();

        let failure = extract(
            Cursor::new(b"x"),
            &header_for(b"x"),
            &temp.path().join("gone"),
        )
        .unwrap_err();

        assert_eq!(failure.code, FailureCode::ExtractFailed);
        assert!(
            failure.detail.starts_with("建临时目录："),
            "{}",
            failure.detail
        );
    }

    #[test]
    fn cleanup_removes_the_file_and_the_directory() {
        let temp = tempfile::tempdir().unwrap();
        let payload = random_bytes(64);
        let extracted = extract(Cursor::new(&payload), &header_for(&payload), temp.path()).unwrap();

        extracted.cleanup().unwrap();

        assert_eq!(fs::read_dir(temp.path()).unwrap().count(), 0);
    }

    #[test]
    fn cleanup_reports_a_file_that_stays_locked() {
        let temp = tempfile::tempdir().unwrap();
        let payload = random_bytes(64);
        let extracted = extract(Cursor::new(&payload), &header_for(&payload), temp.path()).unwrap();
        let path = extracted.path().to_owned();
        let other_guard = open_guard(&path).unwrap();

        let err = extracted.cleanup().unwrap_err();

        assert!(is_transient(&err), "{err}");
        drop(other_guard);
    }

    #[test]
    fn retry_stops_as_soon_as_the_operation_succeeds() {
        let calls = Cell::new(0);

        let value = retry_transient(&[Duration::ZERO; 5], || {
            calls.set(calls.get() + 1);
            if calls.get() < 3 {
                Err(io::Error::from_raw_os_error(32))
            } else {
                Ok(calls.get())
            }
        })
        .unwrap();

        assert_eq!(value, 3);
        assert_eq!(calls.get(), 3);
    }

    #[test]
    fn retry_gives_up_with_the_last_error_after_the_schedule_runs_out() {
        let calls = Cell::new(0);

        let err = retry_transient(&[Duration::ZERO; 2], || -> io::Result<()> {
            calls.set(calls.get() + 1);
            Err(io::Error::from_raw_os_error(5))
        })
        .unwrap_err();

        assert_eq!(err.raw_os_error(), Some(5));
        assert_eq!(calls.get(), 3);
    }

    #[test]
    fn retry_does_not_touch_errors_that_will_not_go_away() {
        let calls = Cell::new(0);

        let err = retry_transient(&[Duration::ZERO; 5], || -> io::Result<()> {
            calls.set(calls.get() + 1);
            Err(io::Error::from_raw_os_error(225))
        })
        .unwrap_err();

        assert_eq!(err.raw_os_error(), Some(225));
        assert_eq!(calls.get(), 1);
    }

    #[test]
    fn hash_reader_matches_the_payload_crate() {
        // 跨过读缓冲区边界才能覆盖循环
        let bytes = random_bytes(HASH_BUFFER_LEN + 17);

        assert_eq!(
            hash_reader(&mut Cursor::new(&bytes)).unwrap(),
            petalfall_setup_payload::sha256(&bytes)
        );
    }

    #[test]
    fn hex_is_lowercase_and_zero_padded() {
        assert_eq!(hex(&[0x00, 0x0F, 0xAB]), "000fab");
    }

    fn stale_now() -> SystemTime {
        SystemTime::now() + STALE_AFTER + Duration::from_secs(60)
    }

    #[test]
    fn sweep_removes_only_old_directories_with_our_prefix() {
        let temp = tempfile::tempdir().unwrap();
        let ours = temp.path().join("Petalfall-Setup-abc123");
        fs::create_dir(&ours).unwrap();
        fs::write(ours.join("petalfall-nsis.exe"), b"old").unwrap();
        let other_dir = temp.path().join("Other-abc123");
        fs::create_dir(&other_dir).unwrap();
        let prefixed_file = temp.path().join("Petalfall-Setup-file");
        fs::write(&prefixed_file, b"not a directory").unwrap();

        let sweep = sweep_stale(temp.path(), stale_now()).unwrap();

        assert_eq!(sweep.removed, vec![ours.clone()]);
        assert!(sweep.skipped.is_empty());
        assert!(!ours.exists());
        assert!(other_dir.exists());
        assert!(prefixed_file.exists());
    }

    #[test]
    fn sweep_keeps_directories_younger_than_a_day() {
        let temp = tempfile::tempdir().unwrap();
        let ours = temp.path().join("Petalfall-Setup-new");
        fs::create_dir(&ours).unwrap();

        let sweep = sweep_stale(
            temp.path(),
            SystemTime::now() + STALE_AFTER - Duration::from_secs(60),
        )
        .unwrap();

        assert!(sweep.removed.is_empty());
        assert!(ours.exists());
    }

    #[test]
    fn sweep_skips_a_directory_with_a_file_still_open() {
        let temp = tempfile::tempdir().unwrap();
        let ours = temp.path().join("Petalfall-Setup-busy");
        fs::create_dir(&ours).unwrap();
        let locked = ours.join("petalfall-nsis.exe");
        fs::write(&locked, b"running").unwrap();
        let guard = open_guard(&locked).unwrap();

        let sweep = sweep_stale(temp.path(), stale_now()).unwrap();

        assert!(sweep.removed.is_empty());
        assert_eq!(sweep.skipped.len(), 1);
        assert_eq!(sweep.skipped[0].0, ours);
        assert!(locked.exists());
        drop(guard);
    }

    #[test]
    fn sweep_on_a_missing_root_is_an_error() {
        let temp = tempfile::tempdir().unwrap();

        assert!(sweep_stale(&temp.path().join("gone"), SystemTime::now()).is_err());
    }

    /// 把修改时间拨到 `now` 之前 `age`：一次清扫里要同时有过期的和新鲜的。目录要带 FILE_FLAG_BACKUP_SEMANTICS 才打得开。
    fn backdate(path: &Path, now: SystemTime, age: Duration) {
        OpenOptions::new()
            .access_mode(FILE_WRITE_ATTRIBUTES)
            .custom_flags(FILE_FLAG_BACKUP_SEMANTICS)
            .open(path)
            .unwrap()
            .set_modified(now - age)
            .unwrap();
    }

    /// 照 main.rs 的建法起名，里面放一份浏览器缓存那样的嵌套文件。
    fn webview_data(temp: &Path) -> PathBuf {
        let dir = tempfile::Builder::new()
            .prefix(WEBVIEW_DATA_PREFIX)
            .tempdir_in(temp)
            .unwrap()
            .keep();
        let cache = dir.join(r"EBWebView\Default\Cache");
        fs::create_dir_all(&cache).unwrap();
        fs::write(cache.join("data_0"), random_bytes(64)).unwrap();
        dir
    }

    fn random_age() -> Duration {
        let bytes = random_bytes(2);
        Duration::from_secs(u64::from(u16::from_le_bytes([bytes[0], bytes[1]])))
    }

    #[test]
    fn sweep_treats_webview_data_by_the_same_one_day_rule() {
        let temp = tempfile::tempdir().unwrap();
        let now = SystemTime::now();
        let stale_webview = webview_data(temp.path());
        let fresh_webview = webview_data(temp.path());
        let old_webview = webview_data(temp.path());
        let stale_payload = temp.path().join("Petalfall-Setup-old");
        fs::create_dir(&stale_payload).unwrap();
        let unrelated = temp.path().join("Other-webview-old");
        fs::create_dir(&unrelated).unwrap();
        let prefixed_file = temp.path().join(format!("{WEBVIEW_DATA_PREFIX}file"));
        fs::write(&prefixed_file, b"not a directory").unwrap();
        // 恰好满一天就算过期，差一秒不算
        backdate(&stale_webview, now, STALE_AFTER);
        backdate(&fresh_webview, now, STALE_AFTER - Duration::from_secs(1));
        backdate(&old_webview, now, STALE_AFTER + random_age());
        backdate(&stale_payload, now, STALE_AFTER + random_age());
        backdate(&unrelated, now, STALE_AFTER * 2);
        backdate(&prefixed_file, now, STALE_AFTER * 2);

        let sweep = sweep_stale(temp.path(), now).unwrap();

        let mut removed = sweep.removed;
        removed.sort();
        let mut expected = vec![stale_webview.clone(), old_webview, stale_payload];
        expected.sort();
        assert_eq!(removed, expected);
        assert!(sweep.skipped.is_empty(), "{:?}", sweep.skipped);
        assert!(!stale_webview.exists());
        assert!(
            fresh_webview
                .join(r"EBWebView\Default\Cache\data_0")
                .exists()
        );
        assert!(unrelated.exists());
        assert!(prefixed_file.exists());
    }

    #[test]
    fn sweep_matches_both_prefixes_with_their_exact_case() {
        let temp = tempfile::tempdir().unwrap();
        let kept = [
            "PETALFALL-SETUP-WEBVIEW-a1",
            "Petalfall-setup-webview-a2",
            "petalfall-setup-a3",
            "PETALFALL-SETUP-a4",
        ]
        .map(|name| temp.path().join(name));
        // 改了大小写的 WebView2 前缀恰好原样以解载荷的前缀开头，按那一条删
        let recased_but_ours = temp.path().join("Petalfall-Setup-Webview-a5");
        for dir in kept.iter().chain([&recased_but_ours]) {
            fs::create_dir(dir).unwrap();
        }

        let sweep = sweep_stale(temp.path(), stale_now()).unwrap();

        assert_eq!(sweep.removed, vec![recased_but_ours]);
        for dir in &kept {
            assert!(dir.exists(), "{}", dir.display());
        }
    }

    #[test]
    fn sweep_does_not_follow_a_junction_named_like_webview_data() {
        let temp = tempfile::tempdir().unwrap();
        let elsewhere = tempfile::tempdir().unwrap();
        fs::write(elsewhere.path().join("keep.txt"), b"not ours").unwrap();
        let junction = temp.path().join(format!("{WEBVIEW_DATA_PREFIX}link"));
        // 建联接点不要管理员权限，符号链接要
        let status = Command::new("cmd")
            .arg("/c")
            .arg("mklink")
            .arg("/J")
            .arg(&junction)
            .arg(elsewhere.path())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .creation_flags(CREATE_NO_WINDOW)
            .status()
            .unwrap();
        assert!(status.success());

        let sweep = sweep_stale(temp.path(), stale_now()).unwrap();

        assert!(sweep.removed.is_empty());
        assert!(fs::symlink_metadata(&junction).is_ok(), "联接点本身也留着");
        assert!(elsewhere.path().join("keep.txt").exists());
    }
}
