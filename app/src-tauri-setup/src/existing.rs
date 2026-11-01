//! 读现有安装：卸载项登记的位置和版本，核对程序文件后和载荷版本比较，给界面四种情况。
//!
//! 静默安装不比版本也不拦降级，这里的判定是降级保护的唯一依据。

use std::cmp::Ordering;
use std::fs;
use std::io;
use std::path::Path;

use semver::Version;

use crate::contract::{Existing, ExistingKind};

/// 安装后的主程序文件名。
pub const APP_EXE: &str = "Petalfall.exe";

/// NSIS 写的卸载项。主键用它：路径只随产品名变，备选键的路径还含发布者。
pub const UNINSTALL_KEY: &str = r"Software\Microsoft\Windows\CurrentVersion\Uninstall\Petalfall";
pub const INSTALL_LOCATION: &str = "InstallLocation";
pub const DISPLAY_VERSION: &str = "DisplayVersion";

/// NSIS 记下的上次安装目录，存在键的默认值里。卸载后它可能还在，所以只能当备选。
pub const LAST_DIR_KEY: &str = r"Software\petalfall\Petalfall";

/// 读 HKCU 的字符串值。抽出来是为了让测试换成内存表，不碰这台电脑上真实的安装记录。
pub trait Registry {
    /// `value` 为 `None` 时读键的默认值。键或值不存在是 `Ok(None)`，不是错误。
    fn read_string(&self, key: &str, value: Option<&str>) -> io::Result<Option<String>>;
}

/// 去掉注册表值两端的引号：NSIS 把 `InstallLocation` 写成带引号的目录。
pub fn unquote(value: &str) -> &str {
    value.trim().trim_matches('"').trim()
}

/// 读出一个值并去引号，空串当作没写过：模板写空值和不写对这里没有区别。
fn read_value(
    registry: &dyn Registry,
    key: &str,
    value: Option<&str>,
) -> io::Result<Option<String>> {
    let text = registry.read_string(key, value)?;
    Ok(text
        .as_deref()
        .map(unquote)
        .filter(|text| !text.is_empty())
        .map(str::to_owned))
}

/// 程序文件是否还在。0 字节算不在：覆盖安装中途断电时旧 exe 已被截断，文件还在但打不开。
fn app_exe_present(dir: &str) -> io::Result<bool> {
    match fs::metadata(Path::new(dir).join(APP_EXE)) {
        Ok(meta) => Ok(meta.is_file() && meta.len() > 0),
        Err(err) if err.kind() == io::ErrorKind::NotFound => Ok(false),
        Err(err) => Err(err),
    }
}

/// 比较两个版本。容错和 NSIS 的 SemverCompare 一致：一侧非法时合法的更大，两侧都非法算相等。
/// 构建元数据不参与比较：只差元数据的两个包是同一版本。
fn compare(left: &str, right: &str) -> Ordering {
    match (Version::parse(left), Version::parse(right)) {
        (Ok(left), Ok(right)) => left.cmp_precedence(&right),
        (Ok(_), Err(_)) => Ordering::Greater,
        (Err(_), Ok(_)) => Ordering::Less,
        (Err(_), Err(_)) => Ordering::Equal,
    }
}

/// 程序文件完好时，已装版本相对载荷版本的三种情况。
pub fn classify(installed: &str, payload: &str) -> ExistingKind {
    match compare(installed, payload) {
        Ordering::Less => ExistingKind::Upgrade,
        Ordering::Equal => ExistingKind::Same,
        Ordering::Greater => ExistingKind::Newer,
    }
}

/// 这台电脑上的现有安装。没有安装、或只是卸载后留下的目录记录时是 `None`。
///
/// 有卸载项但程序文件不在是 broken：修复时目录由 NSIS 从注册表还原，界面只需要显示。broken 的
/// `version` 可能是空串，界面的 broken 文案不用它。
pub fn detect(registry: &dyn Registry, payload_version: &str) -> io::Result<Option<Existing>> {
    let location = read_value(registry, UNINSTALL_KEY, Some(INSTALL_LOCATION))?;
    let version = read_value(registry, UNINSTALL_KEY, Some(DISPLAY_VERSION))?;
    let has_record = location.is_some() || version.is_some();

    let dir = match location {
        Some(dir) => Some(dir),
        None => read_value(registry, LAST_DIR_KEY, None)?,
    };
    // 不知道目录就无从修复也无从显示，只能按没装过走首装
    let Some(dir) = dir else {
        return Ok(None);
    };

    let exe_present = app_exe_present(&dir)?;
    // 卸载后备选键还留着，目录里可能只剩用户数据：这不是一份安装
    if !has_record && !exe_present {
        return Ok(None);
    }
    let kind = match &version {
        Some(version) if exe_present => classify(version, payload_version),
        _ => ExistingKind::Broken,
    };
    Ok(Some(Existing {
        kind,
        version: version.unwrap_or_default(),
        dir,
    }))
}

/// 真实的 HKCU。安装包只有 64 位，进程默认就是模板写入时用的 64 位视图。
#[cfg(windows)]
#[derive(Debug, Clone, Copy, Default)]
pub struct CurrentUserRegistry;

#[cfg(windows)]
impl Registry for CurrentUserRegistry {
    fn read_string(&self, key: &str, value: Option<&str>) -> io::Result<Option<String>> {
        use std::iter::once;
        use std::ptr::{null, null_mut};

        use windows_sys::Win32::Foundation::{
            ERROR_FILE_NOT_FOUND, ERROR_PATH_NOT_FOUND, ERROR_SUCCESS, ERROR_UNSUPPORTED_TYPE,
        };
        use windows_sys::Win32::System::Registry::{
            HKEY_CURRENT_USER, RRF_RT_REG_SZ, RegGetValueW,
        };

        let key: Vec<u16> = key.encode_utf16().chain(once(0)).collect();
        let value: Option<Vec<u16>> =
            value.map(|value| value.encode_utf16().chain(once(0)).collect());
        let value_ptr = value.as_ref().map_or(null(), |value| value.as_ptr());

        let mut bytes = 0u32;
        // SAFETY: key 和 value 都以 NUL 结尾且活过这次调用；空的数据指针表示只问长度。
        let status = unsafe {
            RegGetValueW(
                HKEY_CURRENT_USER,
                key.as_ptr(),
                value_ptr,
                RRF_RT_REG_SZ,
                null_mut(),
                null_mut(),
                &raw mut bytes,
            )
        };
        match status {
            ERROR_SUCCESS => {}
            ERROR_FILE_NOT_FOUND | ERROR_PATH_NOT_FOUND => return Ok(None),
            // 类型不对等于没写过：修复重装会重写它，报错只会把人卡在致命错误页
            ERROR_UNSUPPORTED_TYPE => return Ok(None),
            other => return Err(io::Error::from_raw_os_error(other as i32)),
        }

        let mut buffer = vec![0u16; (bytes as usize).div_ceil(2)];
        // SAFETY: 缓冲区长度不小于 bytes 字节，RegGetValueW 不会越界，并把实际字节数写回 bytes。
        let status = unsafe {
            RegGetValueW(
                HKEY_CURRENT_USER,
                key.as_ptr(),
                value_ptr,
                RRF_RT_REG_SZ,
                null_mut(),
                buffer.as_mut_ptr().cast(),
                &raw mut bytes,
            )
        };
        if status != ERROR_SUCCESS {
            return Err(io::Error::from_raw_os_error(status as i32));
        }
        Ok(Some(decode_reg_sz(&buffer)))
    }
}

/// RegGetValueW 保证以 NUL 结尾，缓冲区可能比字符串长。
#[cfg(windows)]
fn decode_reg_sz(buffer: &[u16]) -> String {
    let end = buffer
        .iter()
        .position(|unit| *unit == 0)
        .unwrap_or(buffer.len());
    String::from_utf16_lossy(&buffer[..end])
}

#[cfg(all(test, windows))]
mod tests {
    use std::collections::HashMap;
    use std::collections::hash_map::RandomState;
    use std::hash::{BuildHasher, Hasher};

    use super::*;

    const PAYLOAD: &str = "0.2.0";

    #[derive(Default)]
    struct FakeRegistry {
        values: HashMap<(&'static str, Option<&'static str>), String>,
        failure: Option<io::ErrorKind>,
    }

    impl FakeRegistry {
        fn uninstall(location: &str, version: &str) -> Self {
            Self::default()
                .with(UNINSTALL_KEY, Some(INSTALL_LOCATION), location)
                .with(UNINSTALL_KEY, Some(DISPLAY_VERSION), version)
        }

        fn with(mut self, key: &'static str, value: Option<&'static str>, text: &str) -> Self {
            self.values.insert((key, value), text.to_owned());
            self
        }
    }

    impl Registry for FakeRegistry {
        fn read_string(&self, key: &str, value: Option<&str>) -> io::Result<Option<String>> {
            if let Some(kind) = self.failure {
                return Err(kind.into());
            }
            let found = self
                .values
                .iter()
                .find(|((k, v), _)| *k == key && *v == value)
                .map(|(_, text)| text.clone());
            Ok(found)
        }
    }

    fn random_below(bound: u64) -> u64 {
        RandomState::new().build_hasher().finish() % bound
    }

    /// 带一份非空 exe 的临时安装目录。
    fn installed_dir() -> (tempfile::TempDir, String) {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join(APP_EXE), b"MZ").unwrap();
        let text = dir.path().to_str().unwrap().to_owned();
        (dir, text)
    }

    fn quoted(dir: &str) -> String {
        format!("\"{dir}\"")
    }

    #[test]
    fn registry_paths_match_what_the_nsis_template_writes() {
        assert_eq!(
            UNINSTALL_KEY,
            r"Software\Microsoft\Windows\CurrentVersion\Uninstall\Petalfall"
        );
        assert_eq!(LAST_DIR_KEY, r"Software\petalfall\Petalfall");
        assert_eq!(INSTALL_LOCATION, "InstallLocation");
        assert_eq!(DISPLAY_VERSION, "DisplayVersion");
        assert_eq!(APP_EXE, "Petalfall.exe");
    }

    #[test]
    fn unquote_strips_only_the_outer_quotes() {
        assert_eq!(unquote(r#""E:\Petalfall""#), r"E:\Petalfall");
        assert_eq!(
            unquote(r#"  "D:\游戏 目录\Petalfall"  "#),
            r"D:\游戏 目录\Petalfall"
        );
        assert_eq!(unquote(r"E:\Petalfall"), r"E:\Petalfall");
        assert_eq!(unquote(r#""""#), "");
        assert_eq!(unquote("   "), "");
    }

    #[test]
    fn plain_versions_map_to_the_three_kinds() {
        assert_eq!(classify("0.1.0", "0.2.0"), ExistingKind::Upgrade);
        assert_eq!(classify("0.2.0", "0.2.0"), ExistingKind::Same);
        assert_eq!(classify("0.3.0", "0.2.0"), ExistingKind::Newer);
    }

    #[test]
    fn prerelease_numbers_compare_as_numbers() {
        assert_eq!(
            classify("0.2.0-dev.9", "0.2.0-dev.12"),
            ExistingKind::Upgrade
        );
        assert_eq!(classify("0.2.0-dev.12", "0.2.0-dev.9"), ExistingKind::Newer);
        assert_eq!(classify("0.2.0-dev.12", "0.2.0-dev.12"), ExistingKind::Same);
    }

    #[test]
    fn a_release_outranks_its_own_prerelease() {
        assert_eq!(classify("0.2.0-dev.12", "0.2.0"), ExistingKind::Upgrade);
        assert_eq!(classify("0.2.0", "0.2.0-dev.12"), ExistingKind::Newer);
    }

    #[test]
    fn build_metadata_does_not_make_a_version_newer() {
        assert_eq!(classify("0.2.0+b", "0.2.0+a"), ExistingKind::Same);
    }

    #[test]
    fn illegal_versions_follow_the_template_tolerance() {
        assert_eq!(classify("not-a-version", "0.2.0"), ExistingKind::Upgrade);
        assert_eq!(classify("0.2.0", "not-a-version"), ExistingKind::Newer);
        assert_eq!(classify("garbage", "not-a-version"), ExistingKind::Same);
        assert_eq!(classify("", "0.2.0"), ExistingKind::Upgrade);
        assert_eq!(classify("1.2", "0.0.1"), ExistingKind::Upgrade);
    }

    #[test]
    fn random_versions_order_like_their_numbers() {
        for _ in 0..200 {
            let installed = (random_below(3), random_below(3), random_below(3));
            let payload = (random_below(3), random_below(3), random_below(3));
            let expected = match installed.cmp(&payload) {
                Ordering::Less => ExistingKind::Upgrade,
                Ordering::Equal => ExistingKind::Same,
                Ordering::Greater => ExistingKind::Newer,
            };
            let text = |(major, minor, patch): (u64, u64, u64)| format!("{major}.{minor}.{patch}");
            assert_eq!(
                classify(&text(installed), &text(payload)),
                expected,
                "{installed:?} 对 {payload:?}"
            );
        }
    }

    #[test]
    fn older_install_is_an_upgrade_and_keeps_the_unquoted_dir() {
        let (_guard, dir) = installed_dir();
        let registry = FakeRegistry::uninstall(&quoted(&dir), "0.1.0");
        assert_eq!(
            detect(&registry, PAYLOAD).unwrap(),
            Some(Existing {
                kind: ExistingKind::Upgrade,
                version: "0.1.0".into(),
                dir,
            })
        );
    }

    #[test]
    fn same_version_install_is_same() {
        let (_guard, dir) = installed_dir();
        let registry = FakeRegistry::uninstall(&quoted(&dir), PAYLOAD);
        let existing = detect(&registry, PAYLOAD).unwrap().unwrap();
        assert_eq!(existing.kind, ExistingKind::Same);
    }

    #[test]
    fn newer_install_is_newer() {
        let (_guard, dir) = installed_dir();
        let registry = FakeRegistry::uninstall(&quoted(&dir), "0.3.0-dev.1");
        let existing = detect(&registry, PAYLOAD).unwrap().unwrap();
        assert_eq!(existing.kind, ExistingKind::Newer);
        assert_eq!(existing.version, "0.3.0-dev.1");
    }

    #[test]
    fn installed_version_that_does_not_parse_can_still_be_upgraded() {
        let (_guard, dir) = installed_dir();
        let registry = FakeRegistry::uninstall(&quoted(&dir), "不是版本");
        let existing = detect(&registry, PAYLOAD).unwrap().unwrap();
        assert_eq!(existing.kind, ExistingKind::Upgrade);
        assert_eq!(existing.version, "不是版本");
    }

    #[test]
    fn missing_exe_is_broken_even_when_the_version_would_be_newer() {
        let dir = tempfile::tempdir().unwrap();
        let text = dir.path().to_str().unwrap().to_owned();
        let registry = FakeRegistry::uninstall(&quoted(&text), "9.9.9");
        assert_eq!(
            detect(&registry, PAYLOAD).unwrap(),
            Some(Existing {
                kind: ExistingKind::Broken,
                version: "9.9.9".into(),
                dir: text,
            })
        );
    }

    #[test]
    fn empty_exe_counts_as_missing() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join(APP_EXE), b"").unwrap();
        let registry = FakeRegistry::uninstall(dir.path().to_str().unwrap(), PAYLOAD);
        let existing = detect(&registry, PAYLOAD).unwrap().unwrap();
        assert_eq!(existing.kind, ExistingKind::Broken);
    }

    #[test]
    fn a_folder_named_like_the_exe_counts_as_missing() {
        let dir = tempfile::tempdir().unwrap();
        fs::create_dir(dir.path().join(APP_EXE)).unwrap();
        let registry = FakeRegistry::uninstall(dir.path().to_str().unwrap(), PAYLOAD);
        let existing = detect(&registry, PAYLOAD).unwrap().unwrap();
        assert_eq!(existing.kind, ExistingKind::Broken);
    }

    #[test]
    fn record_without_a_version_is_broken() {
        let (_guard, dir) = installed_dir();
        let registry =
            FakeRegistry::default().with(UNINSTALL_KEY, Some(INSTALL_LOCATION), &quoted(&dir));
        assert_eq!(
            detect(&registry, PAYLOAD).unwrap(),
            Some(Existing {
                kind: ExistingKind::Broken,
                version: String::new(),
                dir,
            })
        );
    }

    #[test]
    fn nothing_in_the_registry_means_no_install() {
        assert_eq!(detect(&FakeRegistry::default(), PAYLOAD).unwrap(), None);
    }

    #[test]
    fn leftover_last_dir_without_exe_is_not_an_install() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("config.json"), b"{}").unwrap();
        let registry =
            FakeRegistry::default().with(LAST_DIR_KEY, None, dir.path().to_str().unwrap());
        assert_eq!(detect(&registry, PAYLOAD).unwrap(), None);
    }

    #[test]
    fn last_dir_with_exe_but_no_uninstall_record_is_broken() {
        let (_guard, dir) = installed_dir();
        let registry = FakeRegistry::default().with(LAST_DIR_KEY, None, &dir);
        assert_eq!(
            detect(&registry, PAYLOAD).unwrap(),
            Some(Existing {
                kind: ExistingKind::Broken,
                version: String::new(),
                dir,
            })
        );
    }

    #[test]
    fn last_dir_stands_in_for_a_missing_install_location() {
        let (_guard, dir) = installed_dir();
        let registry = FakeRegistry::default()
            .with(UNINSTALL_KEY, Some(DISPLAY_VERSION), "0.1.0")
            .with(LAST_DIR_KEY, None, &dir);
        assert_eq!(
            detect(&registry, PAYLOAD).unwrap(),
            Some(Existing {
                kind: ExistingKind::Upgrade,
                version: "0.1.0".into(),
                dir,
            })
        );
    }

    #[test]
    fn install_location_wins_over_last_dir() {
        let (_guard, dir) = installed_dir();
        let registry = FakeRegistry::uninstall(&quoted(&dir), "0.1.0").with(
            LAST_DIR_KEY,
            None,
            r"Z:\别处\Petalfall",
        );
        assert_eq!(detect(&registry, PAYLOAD).unwrap().unwrap().dir, dir);
    }

    #[test]
    fn version_without_any_known_dir_means_no_install() {
        let registry = FakeRegistry::default().with(UNINSTALL_KEY, Some(DISPLAY_VERSION), "0.1.0");
        assert_eq!(detect(&registry, PAYLOAD).unwrap(), None);
    }

    #[test]
    fn blank_values_count_as_missing() {
        let registry = FakeRegistry::uninstall(r#""""#, "   ");
        assert_eq!(detect(&registry, PAYLOAD).unwrap(), None);
    }

    #[test]
    fn registry_failure_reaches_the_caller() {
        let registry = FakeRegistry {
            failure: Some(io::ErrorKind::PermissionDenied),
            ..FakeRegistry::default()
        };
        let err = detect(&registry, PAYLOAD).unwrap_err();
        assert_eq!(err.kind(), io::ErrorKind::PermissionDenied);
    }

    #[test]
    fn exe_check_failure_reaches_the_caller() {
        const ERROR_INVALID_NAME: i32 = 123;
        let dir = tempfile::tempdir().unwrap();
        let bad = format!(r"{}\bad|name", dir.path().to_str().unwrap());
        let registry = FakeRegistry::uninstall(&bad, PAYLOAD);
        let err = detect(&registry, PAYLOAD).unwrap_err();
        assert_eq!(err.raw_os_error(), Some(ERROR_INVALID_NAME));
    }

    #[test]
    fn reg_sz_stops_at_the_terminator() {
        let mut buffer: Vec<u16> = "E:\\落樱".encode_utf16().collect();
        assert_eq!(decode_reg_sz(&buffer), "E:\\落樱");
        buffer.extend([0, 0x41, 0]);
        assert_eq!(decode_reg_sz(&buffer), "E:\\落樱");
        assert_eq!(decode_reg_sz(&[0]), "");
    }
}
