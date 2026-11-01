//! 载荷退出后的核验。静默下 File 写失败和 /D= 被忽略都以 0 退出，退出码只是必要条件，安装结果要到现场看。

use std::fmt;
use std::fs::{self, File};
use std::io::{self, ErrorKind};
use std::path::{Path, PathBuf};
use std::ptr;

use aurora_setup_payload::Header;
use windows_sys::Win32::Foundation::{
    ERROR_FILE_NOT_FOUND, ERROR_MORE_DATA, ERROR_PATH_NOT_FOUND, ERROR_SUCCESS,
};
use windows_sys::Win32::System::Registry::{HKEY, HKEY_CURRENT_USER, RRF_RT_REG_SZ, RegGetValueW};

use crate::contract::{Failure, FailureCode};
use crate::extract::{BACKOFF, hash_reader, hex, retry_transient};
use crate::journal::Journal;

pub const EXE_NAME: &str = "Petalfall.exe";
pub const UNINSTALLER_NAME: &str = "uninstall.exe";
pub const UNINSTALL_KEY: &str = r"Software\Microsoft\Windows\CurrentVersion\Uninstall\Petalfall";
pub const DISPLAY_VERSION: &str = "DisplayVersion";
pub const INSTALL_LOCATION: &str = "InstallLocation";
/// 够放一条路径；更长的值由系统报回真实长度后再读一次。
const REGISTRY_BUFFER_CHARS: usize = 1024;

/// 卸载项的读取口子：测试不能碰真实注册表，用户本机的这个键属于正在使用的安装。
pub trait UninstallEntry: Send + Sync {
    /// 值不存在是 `Ok(None)`，读取本身出错才是 `Err`。
    fn value(&self, name: &str) -> io::Result<Option<String>>;
}

/// 进程是 64 位，读到的就是模板 `SetRegView 64` 写的同一视图。
pub struct HkcuUninstall;

impl UninstallEntry for HkcuUninstall {
    fn value(&self, name: &str) -> io::Result<Option<String>> {
        read_string(
            HKEY_CURRENT_USER,
            UNINSTALL_KEY,
            name,
            REGISTRY_BUFFER_CHARS,
        )
    }
}

fn wide(text: &str) -> Vec<u16> {
    text.encode_utf16().chain([0]).collect()
}

fn read_string(
    root: HKEY,
    subkey: &str,
    name: &str,
    capacity: usize,
) -> io::Result<Option<String>> {
    let subkey = wide(subkey);
    let name = wide(name);
    let mut buffer = vec![0u16; capacity];
    loop {
        let mut size = (buffer.len() * 2) as u32;
        let status = unsafe {
            RegGetValueW(
                root,
                subkey.as_ptr(),
                name.as_ptr(),
                RRF_RT_REG_SZ,
                ptr::null_mut(),
                buffer.as_mut_ptr().cast(),
                &mut size,
            )
        };
        match status {
            ERROR_SUCCESS => {
                // size 含结尾的 0
                buffer.truncate((size as usize / 2).saturating_sub(1));
                let text = String::from_utf16(&buffer)
                    .map_err(|err| io::Error::new(ErrorKind::InvalidData, err))?;
                return Ok(Some(text));
            }
            ERROR_MORE_DATA => buffer.resize((size as usize).div_ceil(2), 0),
            ERROR_FILE_NOT_FOUND | ERROR_PATH_NOT_FOUND => return Ok(None),
            code => return Err(io::Error::from_raw_os_error(code as i32)),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExeFingerprint {
    pub len: u64,
    pub sha256: [u8; 32],
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Expected {
    pub instdir: PathBuf,
    pub version: String,
    /// `None` 时只确认文件在且非空，用于手里没有那个版本指纹的情形。
    pub exe: Option<ExeFingerprint>,
}

impl Expected {
    pub fn from_header(header: &Header, instdir: &Path) -> Self {
        Self {
            instdir: instdir.to_owned(),
            version: header.version.clone(),
            exe: Some(ExeFingerprint {
                len: header.exe_len,
                sha256: header.exe_sha256,
            }),
        }
    }

    /// 半装记录可能是另一个版本的引导程序留下的：拿当前载荷的指纹去比，已经装好的新版本也会被判成半装，
    /// 随后的修复就成了静默降级。
    pub fn for_journal(journal: &Journal, header: &Header) -> Self {
        let exe = (journal.version == header.version).then_some(ExeFingerprint {
            len: header.exe_len,
            sha256: header.exe_sha256,
        });
        Self {
            instdir: journal.instdir.clone(),
            version: journal.version.clone(),
            exe,
        }
    }
}

/// 核验没过的具体项。文案进 `Failure.detail`，失败页、日志和问题反馈都靠它定位。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Mismatch {
    ExeMissing,
    ExeEmpty,
    ExeLength {
        expected: u64,
        actual: u64,
    },
    ExeHash {
        expected: String,
        actual: String,
    },
    UninstallerMissing,
    UninstallerEmpty,
    Unreadable {
        item: &'static str,
        reason: String,
    },
    DisplayVersion {
        expected: String,
        actual: Option<String>,
    },
    InstallLocation {
        expected: String,
        actual: Option<String>,
    },
}

fn write_registry_value(
    f: &mut fmt::Formatter<'_>,
    name: &str,
    expected: &str,
    actual: Option<&str>,
) -> fmt::Result {
    match actual {
        Some(actual) => write!(f, "{name} 是 {actual}，应为 {expected}"),
        None => write!(f, "{name} 没有写入，应为 {expected}"),
    }
}

impl fmt::Display for Mismatch {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Mismatch::ExeMissing => write!(f, "{EXE_NAME} 不存在"),
            Mismatch::ExeEmpty => write!(f, "{EXE_NAME} 是空文件"),
            Mismatch::ExeLength { expected, actual } => {
                write!(f, "{EXE_NAME} 长度 {actual}，应为 {expected}")
            }
            Mismatch::ExeHash { expected, actual } => {
                write!(f, "{EXE_NAME} 的 SHA-256 是 {actual}，应为 {expected}")
            }
            Mismatch::UninstallerMissing => write!(f, "{UNINSTALLER_NAME} 不存在"),
            Mismatch::UninstallerEmpty => write!(f, "{UNINSTALLER_NAME} 是空文件"),
            Mismatch::Unreadable { item, reason } => write!(f, "{item} 读不出来：{reason}"),
            Mismatch::DisplayVersion { expected, actual } => {
                write_registry_value(f, DISPLAY_VERSION, expected, actual.as_deref())
            }
            Mismatch::InstallLocation { expected, actual } => {
                write_registry_value(f, INSTALL_LOCATION, expected, actual.as_deref())
            }
        }
    }
}

fn check_exe(expected: &Expected, found: &mut Vec<Mismatch>) {
    let path = expected.instdir.join(EXE_NAME);
    let actual_len = match fs::metadata(&path) {
        Ok(metadata) => metadata.len(),
        Err(err) if err.kind() == ErrorKind::NotFound => {
            found.push(Mismatch::ExeMissing);
            return;
        }
        Err(err) => {
            found.push(Mismatch::Unreadable {
                item: EXE_NAME,
                reason: err.to_string(),
            });
            return;
        }
    };
    let Some(fingerprint) = &expected.exe else {
        if actual_len == 0 {
            found.push(Mismatch::ExeEmpty);
        }
        return;
    };
    // 长度对不上就不用读完整个文件了
    if actual_len != fingerprint.len {
        found.push(Mismatch::ExeLength {
            expected: fingerprint.len,
            actual: actual_len,
        });
        return;
    }
    // 杀软常在文件落盘后立刻扫描，这时打开会短暂失败
    match retry_transient(&BACKOFF, || hash_reader(&mut File::open(&path)?)) {
        Ok(actual) if actual == fingerprint.sha256 => {}
        Ok(actual) => found.push(Mismatch::ExeHash {
            expected: hex(&fingerprint.sha256),
            actual: hex(&actual),
        }),
        Err(err) => found.push(Mismatch::Unreadable {
            item: EXE_NAME,
            reason: err.to_string(),
        }),
    }
}

fn check_uninstaller(instdir: &Path, found: &mut Vec<Mismatch>) {
    match fs::metadata(instdir.join(UNINSTALLER_NAME)) {
        Ok(metadata) if metadata.len() == 0 => found.push(Mismatch::UninstallerEmpty),
        Ok(_) => {}
        Err(err) if err.kind() == ErrorKind::NotFound => found.push(Mismatch::UninstallerMissing),
        Err(err) => found.push(Mismatch::Unreadable {
            item: UNINSTALLER_NAME,
            reason: err.to_string(),
        }),
    }
}

fn check_version(entry: &dyn UninstallEntry, expected: &str, found: &mut Vec<Mismatch>) {
    match entry.value(DISPLAY_VERSION) {
        Ok(actual) if actual.as_deref() == Some(expected) => {}
        Ok(actual) => found.push(Mismatch::DisplayVersion {
            expected: expected.to_owned(),
            actual,
        }),
        Err(err) => found.push(Mismatch::Unreadable {
            item: DISPLAY_VERSION,
            reason: err.to_string(),
        }),
    }
}

/// 目录比较要忽略大小写和末尾分隔符：Windows 下这些写法指向同一处，比字节会把好安装判成失败。
fn fold_dir(path: &str) -> String {
    path.trim_end_matches(['\\', '/']).to_lowercase()
}

fn check_location(entry: &dyn UninstallEntry, instdir: &Path, found: &mut Vec<Mismatch>) {
    let expected = instdir.to_string_lossy();
    match entry.value(INSTALL_LOCATION) {
        // 模板写的是带引号的目录
        Ok(Some(actual)) if fold_dir(actual.trim_matches('"')) == fold_dir(&expected) => {}
        Ok(actual) => found.push(Mismatch::InstallLocation {
            expected: expected.into_owned(),
            actual,
        }),
        Err(err) => found.push(Mismatch::Unreadable {
            item: INSTALL_LOCATION,
            reason: err.to_string(),
        }),
    }
}

/// 四项都查完再返回，一次报全：用户只发得来一次反馈。空表示通过。
pub fn verify(expected: &Expected, entry: &dyn UninstallEntry) -> Vec<Mismatch> {
    let mut found = Vec::new();
    check_exe(expected, &mut found);
    check_uninstaller(&expected.instdir, &mut found);
    check_version(entry, &expected.version, &mut found);
    check_location(entry, &expected.instdir, &mut found);
    found
}

pub fn failure(mismatches: &[Mismatch]) -> Failure {
    let detail = mismatches
        .iter()
        .map(ToString::to_string)
        .collect::<Vec<_>>();
    Failure {
        code: FailureCode::VerifyFailed,
        detail: detail.join("；"),
    }
}

#[cfg(test)]
pub(crate) mod test_support {
    use std::collections::HashMap;
    use std::io;

    use super::UninstallEntry;

    #[derive(Default)]
    pub struct MemoryEntry(pub std::sync::Mutex<HashMap<String, Result<String, i32>>>);

    impl MemoryEntry {
        pub fn with(values: &[(&str, &str)]) -> Self {
            let entry = Self::default();
            for (name, value) in values {
                entry.set(name, value);
            }
            entry
        }

        pub fn set(&self, name: &str, value: &str) {
            self.0
                .lock()
                .unwrap()
                .insert(name.to_owned(), Ok(value.to_owned()));
        }

        pub fn set_error(&self, name: &str, code: i32) {
            self.0.lock().unwrap().insert(name.to_owned(), Err(code));
        }
    }

    impl UninstallEntry for MemoryEntry {
        fn value(&self, name: &str) -> io::Result<Option<String>> {
            match self.0.lock().unwrap().get(name) {
                Some(Ok(value)) => Ok(Some(value.clone())),
                Some(Err(code)) => Err(io::Error::from_raw_os_error(*code)),
                None => Ok(None),
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use windows_sys::Win32::System::Registry::HKEY_LOCAL_MACHINE;

    use super::test_support::MemoryEntry;
    use super::*;
    use crate::overlay::test_support::random_bytes;

    const VERSION: &str = "0.2.0-dev.7";

    struct Install {
        _dir: tempfile::TempDir,
        instdir: PathBuf,
        exe: Vec<u8>,
    }

    /// 四项全过的现场，用例各自弄坏其中一项。
    fn install() -> Install {
        let dir = tempfile::tempdir().unwrap();
        let instdir = dir.path().join("游戏 目录").join("Petalfall");
        fs::create_dir_all(&instdir).unwrap();
        let exe = random_bytes(2048);
        fs::write(instdir.join(EXE_NAME), &exe).unwrap();
        fs::write(instdir.join(UNINSTALLER_NAME), b"MZ").unwrap();
        Install {
            _dir: dir,
            instdir,
            exe,
        }
    }

    impl Install {
        fn expected(&self) -> Expected {
            Expected {
                instdir: self.instdir.clone(),
                version: VERSION.to_owned(),
                exe: Some(ExeFingerprint {
                    len: self.exe.len() as u64,
                    sha256: aurora_setup_payload::sha256(&self.exe),
                }),
            }
        }

        fn entry(&self) -> MemoryEntry {
            let quoted = format!("\"{}\"", self.instdir.display());
            MemoryEntry::with(&[(DISPLAY_VERSION, VERSION), (INSTALL_LOCATION, &quoted)])
        }
    }

    #[test]
    fn a_good_install_passes_all_four_checks() {
        let install = install();

        assert_eq!(verify(&install.expected(), &install.entry()), vec![]);
    }

    #[test]
    fn a_missing_exe_is_named() {
        let install = install();
        fs::remove_file(install.instdir.join(EXE_NAME)).unwrap();

        assert_eq!(
            verify(&install.expected(), &install.entry()),
            vec![Mismatch::ExeMissing]
        );
    }

    #[test]
    fn a_wrong_exe_length_reports_both_numbers() {
        let install = install();
        fs::write(install.instdir.join(EXE_NAME), vec![0u8; 2047]).unwrap();

        let found = verify(&install.expected(), &install.entry());

        assert_eq!(
            found,
            vec![Mismatch::ExeLength {
                expected: 2048,
                actual: 2047
            }]
        );
        assert_eq!(found[0].to_string(), "Petalfall.exe 长度 2047，应为 2048");
    }

    #[test]
    fn same_length_with_different_bytes_fails_on_the_hash() {
        let install = install();
        let mut tampered = install.exe.clone();
        tampered[1024] ^= 0x01;
        fs::write(install.instdir.join(EXE_NAME), &tampered).unwrap();

        assert_eq!(
            verify(&install.expected(), &install.entry()),
            vec![Mismatch::ExeHash {
                expected: hex(&aurora_setup_payload::sha256(&install.exe)),
                actual: hex(&aurora_setup_payload::sha256(&tampered)),
            }]
        );
    }

    #[test]
    fn a_missing_uninstaller_is_named() {
        let install = install();
        fs::remove_file(install.instdir.join(UNINSTALLER_NAME)).unwrap();

        assert_eq!(
            verify(&install.expected(), &install.entry()),
            vec![Mismatch::UninstallerMissing]
        );
    }

    #[test]
    fn an_empty_uninstaller_does_not_count() {
        let install = install();
        fs::write(install.instdir.join(UNINSTALLER_NAME), b"").unwrap();

        assert_eq!(
            verify(&install.expected(), &install.entry()),
            vec![Mismatch::UninstallerEmpty]
        );
    }

    #[test]
    fn a_stale_display_version_is_named_with_the_value_found() {
        let install = install();
        let entry = install.entry();
        entry.set(DISPLAY_VERSION, "0.1.0");

        assert_eq!(
            verify(&install.expected(), &entry),
            vec![Mismatch::DisplayVersion {
                expected: VERSION.to_owned(),
                actual: Some("0.1.0".to_owned()),
            }]
        );
    }

    #[test]
    fn an_absent_uninstall_entry_fails_both_registry_checks() {
        let install = install();

        let found = verify(&install.expected(), &MemoryEntry::default());

        assert_eq!(
            found,
            vec![
                Mismatch::DisplayVersion {
                    expected: VERSION.to_owned(),
                    actual: None,
                },
                Mismatch::InstallLocation {
                    expected: install.instdir.display().to_string(),
                    actual: None,
                },
            ]
        );
        assert_eq!(
            found[0].to_string(),
            "DisplayVersion 没有写入，应为 0.2.0-dev.7"
        );
    }

    #[test]
    fn install_location_pointing_elsewhere_fails() {
        // /D= 被 NSIS 丢弃时就是这个现场：退出码 0，登记却指向默认目录
        let install = install();
        let entry = install.entry();
        entry.set(INSTALL_LOCATION, r#""C:\Users\a\AppData\Local\Petalfall""#);

        assert_eq!(
            verify(&install.expected(), &entry),
            vec![Mismatch::InstallLocation {
                expected: install.instdir.display().to_string(),
                actual: Some(r#""C:\Users\a\AppData\Local\Petalfall""#.to_owned()),
            }]
        );
    }

    #[test]
    fn install_location_compares_without_quotes_case_or_trailing_separator() {
        let install = install();
        for written in [
            install.instdir.display().to_string(),
            format!("\"{}\"", install.instdir.display()),
            format!("\"{}\\\"", install.instdir.display()),
            format!(
                "\"{}\"",
                install.instdir.display().to_string().to_uppercase()
            ),
        ] {
            let entry = install.entry();
            entry.set(INSTALL_LOCATION, &written);

            assert_eq!(verify(&install.expected(), &entry), vec![], "{written}");
        }
    }

    #[test]
    fn a_parent_directory_is_not_the_same_directory() {
        let install = install();
        let entry = install.entry();
        entry.set(
            INSTALL_LOCATION,
            &format!("\"{}\"", install.instdir.parent().unwrap().display()),
        );

        assert_eq!(verify(&install.expected(), &entry).len(), 1);
    }

    #[test]
    fn every_failed_item_is_reported_in_one_pass() {
        let install = install();
        fs::remove_file(install.instdir.join(EXE_NAME)).unwrap();
        fs::remove_file(install.instdir.join(UNINSTALLER_NAME)).unwrap();
        let entry = install.entry();
        entry.set(DISPLAY_VERSION, "0.1.0");

        let found = verify(&install.expected(), &entry);

        assert_eq!(
            failure(&found),
            Failure {
                code: FailureCode::VerifyFailed,
                detail: "Petalfall.exe 不存在；uninstall.exe 不存在；DisplayVersion 是 0.1.0，应为 0.2.0-dev.7"
                    .to_owned(),
            }
        );
    }

    #[test]
    fn a_registry_read_error_fails_the_check_instead_of_passing_silently() {
        let install = install();
        let entry = install.entry();
        entry.set_error(DISPLAY_VERSION, 5);
        entry.set_error(INSTALL_LOCATION, 5);

        let found = verify(&install.expected(), &entry);

        assert_eq!(found.len(), 2);
        assert!(
            found[0]
                .to_string()
                .starts_with("DisplayVersion 读不出来："),
            "{}",
            found[0]
        );
        assert!(
            found[1]
                .to_string()
                .starts_with("InstallLocation 读不出来："),
            "{}",
            found[1]
        );
    }

    #[test]
    fn without_a_fingerprint_only_presence_is_checked() {
        let install = install();
        let mut expected = install.expected();
        expected.exe = None;
        fs::write(install.instdir.join(EXE_NAME), b"some other version").unwrap();

        assert_eq!(verify(&expected, &install.entry()), vec![]);

        fs::write(install.instdir.join(EXE_NAME), b"").unwrap();
        assert_eq!(
            verify(&expected, &install.entry()),
            vec![Mismatch::ExeEmpty]
        );
    }

    fn journal(version: &str) -> Journal {
        Journal {
            instdir: PathBuf::from(r"D:\Petalfall"),
            was_fresh: false,
            version: version.to_owned(),
            payload_pid: None,
            started_at: 0,
        }
    }

    #[test]
    fn a_journal_from_the_same_version_uses_the_header_fingerprint() {
        let header = Header::new(b"payload", b"exe bytes", "1.0.0").unwrap();

        let expected = Expected::for_journal(&journal("1.0.0"), &header);

        assert_eq!(expected.instdir, PathBuf::from(r"D:\Petalfall"));
        assert_eq!(
            expected.exe,
            Some(ExeFingerprint {
                len: 9,
                sha256: header.exe_sha256
            })
        );
    }

    #[test]
    fn a_journal_from_another_version_is_not_held_to_this_payload() {
        let header = Header::new(b"payload", b"exe bytes", "1.0.0").unwrap();

        let expected = Expected::for_journal(&journal("2.0.0"), &header);

        assert_eq!(expected.version, "2.0.0");
        assert_eq!(expected.exe, None);
    }

    #[test]
    fn expected_from_header_keeps_the_target_directory() {
        let header = Header::new(b"payload", b"exe bytes", "1.0.0").unwrap();

        let expected = Expected::from_header(&header, Path::new(r"D:\游戏 目录\Petalfall"));

        assert_eq!(expected.instdir, PathBuf::from(r"D:\游戏 目录\Petalfall"));
        assert_eq!(expected.version, "1.0.0");
        assert_eq!(expected.exe.unwrap().len, 9);
    }

    const WINDOWS_VERSION_KEY: &str = r"SOFTWARE\Microsoft\Windows NT\CurrentVersion";

    /// 真实读取只读 HKLM 上这个每台 Windows 都有的值，不碰卸载项。
    #[test]
    fn read_string_returns_a_registry_value() {
        let value = read_string(
            HKEY_LOCAL_MACHINE,
            WINDOWS_VERSION_KEY,
            "ProductName",
            REGISTRY_BUFFER_CHARS,
        )
        .unwrap();

        assert!(value.unwrap().starts_with("Windows"));
    }

    #[test]
    fn read_string_grows_past_a_small_first_buffer() {
        let whole = read_string(
            HKEY_LOCAL_MACHINE,
            WINDOWS_VERSION_KEY,
            "ProductName",
            REGISTRY_BUFFER_CHARS,
        )
        .unwrap()
        .unwrap();

        let grown = read_string(HKEY_LOCAL_MACHINE, WINDOWS_VERSION_KEY, "ProductName", 1)
            .unwrap()
            .unwrap();

        assert_eq!(grown, whole);
    }

    #[test]
    fn read_string_treats_missing_values_and_keys_as_none() {
        assert_eq!(
            read_string(
                HKEY_LOCAL_MACHINE,
                WINDOWS_VERSION_KEY,
                "PetalfallNoSuchValue",
                REGISTRY_BUFFER_CHARS
            )
            .unwrap(),
            None
        );
        assert_eq!(
            read_string(
                HKEY_LOCAL_MACHINE,
                r"SOFTWARE\PetalfallNoSuchKey",
                "x",
                REGISTRY_BUFFER_CHARS
            )
            .unwrap(),
            None
        );
    }
}
