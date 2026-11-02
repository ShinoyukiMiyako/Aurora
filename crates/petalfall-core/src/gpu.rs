//! 每个程序用哪块显卡：Windows 图形设置里的按程序显卡偏好。
//!
//! 系统设置把它记在当前用户的 `Software\Microsoft\DirectX\UserGpuPreferences` 下：值名是程序的完整路径，
//! REG_SZ，内容是一串 `键=值;` 片段，`GpuPreference=2;` 为高性能（1 省电，0 交给 Windows）。微软没有这个键的
//! 参考文档，格式取自系统设置自己写出的值；同一个值里还会有别的片段（如 `AppStatus=0;`），改写时原样保留。
//!
//! 笔记本上 Java 默认跑在省电的核显上，帧数会低很多；启动前把这次拉起的那个 java 可执行文件设成高性能，
//! 游戏就用独显。写入器抽成 [`GpuPreferenceStore`]，测试注入替身，不碰真实注册表。

use std::path::Path;

use crate::error::Result;

/// 按程序显卡偏好所在的键（当前用户）。
pub(crate) const USER_GPU_PREFERENCES_KEY: &str = r"Software\Microsoft\DirectX\UserGpuPreferences";

/// 偏好片段的键名。
const GPU_PREFERENCE: &str = "GpuPreference";

/// 高性能的取值。
const HIGH_PERFORMANCE: &str = "2";

/// 按程序显卡偏好的读写。值名是程序的完整路径。
pub(crate) trait GpuPreferenceStore: Send + Sync + std::fmt::Debug {
    /// 读这个程序现有的偏好串；没有记录时为 `None`。
    fn read(&self, exe: &Path) -> Result<Option<String>>;
    /// 把这个程序的偏好串整个写成 `value`。
    fn write(&self, exe: &Path, value: &str) -> Result<()>;
}

/// 生产实现：当前用户的注册表，值名为 exe 的完整路径，REG_SZ。
/// 非 Windows：读总是没有记录，写报平台不支持。
#[derive(Debug)]
pub(crate) struct RegistryGpuPreferences;

#[cfg(windows)]
impl GpuPreferenceStore for RegistryGpuPreferences {
    fn read(&self, exe: &Path) -> Result<Option<String>> {
        use winreg::RegKey;
        use winreg::enums::{HKEY_CURRENT_USER, KEY_READ};

        let key = match RegKey::predef(HKEY_CURRENT_USER)
            .open_subkey_with_flags(USER_GPU_PREFERENCES_KEY, KEY_READ)
        {
            Ok(key) => key,
            // 从没在图形设置里改过任何程序时，这个键不存在。
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(source) => return Err(store_error(exe, source)),
        };
        match key.get_value::<String, _>(exe.as_os_str()) {
            Ok(value) => Ok(Some(value)),
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(source) => Err(store_error(exe, source)),
        }
    }

    fn write(&self, exe: &Path, value: &str) -> Result<()> {
        use winreg::RegKey;
        use winreg::enums::{HKEY_CURRENT_USER, KEY_SET_VALUE};

        let (key, _) = RegKey::predef(HKEY_CURRENT_USER)
            .create_subkey_with_flags(USER_GPU_PREFERENCES_KEY, KEY_SET_VALUE)
            .map_err(|source| store_error(exe, source))?;
        key.set_value(exe.as_os_str(), &value)
            .map_err(|source| store_error(exe, source))
    }
}

#[cfg(not(windows))]
impl GpuPreferenceStore for RegistryGpuPreferences {
    fn read(&self, _exe: &Path) -> Result<Option<String>> {
        Ok(None)
    }

    fn write(&self, _exe: &Path, _value: &str) -> Result<()> {
        Err(crate::error::CoreError::PlatformUnsupported)
    }
}

#[cfg(windows)]
fn store_error(exe: &Path, source: std::io::Error) -> crate::error::CoreError {
    crate::error::CoreError::GpuPreferenceWrite {
        path: exe.to_path_buf(),
        source,
    }
}

/// 把偏好串里的 `GpuPreference` 改成高性能，没有就补上。
///
/// 按分号拆成片段，去掉空片段（系统设置会写出 `GpuPreference=1; ;` 这样的串），其余片段按原顺序保留，
/// 每段都以分号结尾。重复的 `GpuPreference` 只留第一处，免得两处取值互相打架。
pub(crate) fn with_high_performance(existing: Option<&str>) -> String {
    let mut out = String::new();
    let mut placed = false;
    for fragment in existing
        .unwrap_or_default()
        .split(';')
        .map(str::trim)
        .filter(|fragment| !fragment.is_empty())
    {
        if is_preference_fragment(fragment) {
            if placed {
                continue;
            }
            placed = true;
            out.push_str(GPU_PREFERENCE);
            out.push('=');
            out.push_str(HIGH_PERFORMANCE);
        } else {
            out.push_str(fragment);
        }
        out.push(';');
    }
    if !placed {
        out.push_str(GPU_PREFERENCE);
        out.push('=');
        out.push_str(HIGH_PERFORMANCE);
        out.push(';');
    }
    out
}

fn is_preference_fragment(fragment: &str) -> bool {
    fragment
        .split_once('=')
        .is_some_and(|(key, _)| key.trim().eq_ignore_ascii_case(GPU_PREFERENCE))
}

/// 偏好串里第一处 `GpuPreference` 的取值。
fn current_preference(value: &str) -> Option<&str> {
    value
        .split(';')
        .map(str::trim)
        .filter(|fragment| is_preference_fragment(fragment))
        .find_map(|fragment| fragment.split_once('=').map(|(_, v)| v.trim()))
}

/// 一次设置的结果。
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum GpuPreferenceChange {
    /// 已经是高性能，没有写。
    Unchanged,
    /// 写入了新的偏好串。
    Written {
        previous: Option<String>,
        value: String,
    },
}

/// 让这个程序用高性能显卡。已经是高性能时不写，免得每次启动都改一遍注册表。
pub(crate) fn prefer_high_performance(
    store: &dyn GpuPreferenceStore,
    exe: &Path,
) -> Result<GpuPreferenceChange> {
    let previous = store.read(exe)?;
    if previous
        .as_deref()
        .and_then(current_preference)
        .is_some_and(|value| value == HIGH_PERFORMANCE)
    {
        return Ok(GpuPreferenceChange::Unchanged);
    }
    let value = with_high_performance(previous.as_deref());
    store.write(exe, &value)?;
    Ok(GpuPreferenceChange::Written { previous, value })
}

#[cfg(test)]
pub(crate) mod testing {
    use std::collections::HashMap;
    use std::path::{Path, PathBuf};
    use std::sync::Mutex;

    use super::GpuPreferenceStore;
    use crate::error::{CoreError, Result};

    /// 内存里的替身：记下每次写入，可预置已有的值，也可让写入失败。
    #[derive(Debug, Default)]
    pub(crate) struct MemoryGpuPreferences {
        values: Mutex<HashMap<PathBuf, String>>,
        writes: Mutex<Vec<(PathBuf, String)>>,
        fail_writes: bool,
    }

    impl MemoryGpuPreferences {
        pub(crate) fn with_value(exe: &Path, value: &str) -> Self {
            let store = Self::default();
            store
                .values
                .lock()
                .unwrap()
                .insert(exe.to_path_buf(), value.to_owned());
            store
        }

        pub(crate) fn failing() -> Self {
            Self {
                fail_writes: true,
                ..Self::default()
            }
        }

        pub(crate) fn writes(&self) -> Vec<(PathBuf, String)> {
            self.writes.lock().unwrap().clone()
        }
    }

    impl GpuPreferenceStore for MemoryGpuPreferences {
        fn read(&self, exe: &Path) -> Result<Option<String>> {
            Ok(self.values.lock().unwrap().get(exe).cloned())
        }

        fn write(&self, exe: &Path, value: &str) -> Result<()> {
            if self.fail_writes {
                return Err(CoreError::GpuPreferenceWrite {
                    path: exe.to_path_buf(),
                    source: std::io::Error::new(std::io::ErrorKind::PermissionDenied, "拒绝访问"),
                });
            }
            self.writes
                .lock()
                .unwrap()
                .push((exe.to_path_buf(), value.to_owned()));
            self.values
                .lock()
                .unwrap()
                .insert(exe.to_path_buf(), value.to_owned());
            Ok(())
        }
    }

    /// 测试门面的默认写入器：没注入替身的测试一旦开着独显偏好去启动，只会得到一个写入失败，
    /// 绝不会改到跑测试这台机器的注册表。
    #[derive(Debug)]
    pub(crate) struct UnsetGpuPreferences;

    impl GpuPreferenceStore for UnsetGpuPreferences {
        fn read(&self, _exe: &Path) -> Result<Option<String>> {
            Ok(None)
        }

        fn write(&self, exe: &Path, _value: &str) -> Result<()> {
            Err(CoreError::GpuPreferenceWrite {
                path: exe.to_path_buf(),
                source: std::io::Error::other("测试门面没有注入显卡偏好写入器"),
            })
        }
    }
}

#[cfg(test)]
mod tests {
    use super::testing::MemoryGpuPreferences;
    use super::*;
    use std::path::PathBuf;

    #[test]
    fn with_high_performance_sets_or_appends_the_preference() {
        let cases: &[(Option<&str>, &str)] = &[
            (None, "GpuPreference=2;"),
            (Some(""), "GpuPreference=2;"),
            (Some("AppStatus=0;"), "AppStatus=0;GpuPreference=2;"),
            (Some("GpuPreference=1; ;"), "GpuPreference=2;"),
            (Some("GpuPreference=2;"), "GpuPreference=2;"),
            (Some("GpuPreference=0;"), "GpuPreference=2;"),
            // 别的片段保持原顺序，偏好留在原位；末尾没分号的片段补上。
            (
                Some("AppStatus=0;GpuPreference=1;SwapEffectUpgradeEnable=1"),
                "AppStatus=0;GpuPreference=2;SwapEffectUpgradeEnable=1;",
            ),
            // 重复的偏好只留第一处。
            (
                Some("GpuPreference=1;AppStatus=0;GpuPreference=0;"),
                "GpuPreference=2;AppStatus=0;",
            ),
        ];
        for (existing, want) in cases {
            assert_eq!(with_high_performance(*existing), *want, "{existing:?}");
        }
    }

    #[test]
    fn already_high_performance_is_not_rewritten() {
        let exe = PathBuf::from(r"D:\jdk-17\bin\java.exe");
        for existing in [
            "GpuPreference=2;",
            "GpuPreference=2; ;",
            "AppStatus=0;GpuPreference=2;",
        ] {
            let store = MemoryGpuPreferences::with_value(&exe, existing);
            assert_eq!(
                prefer_high_performance(&store, &exe).unwrap(),
                GpuPreferenceChange::Unchanged,
                "{existing}"
            );
            assert!(store.writes().is_empty(), "{existing} 不该再写");
        }
    }

    #[test]
    fn other_preferences_are_written_as_high_performance() {
        let exe = PathBuf::from(r"C:\Program Files\Java\jdk-21\bin\java.exe");
        let fresh = MemoryGpuPreferences::default();
        assert_eq!(
            prefer_high_performance(&fresh, &exe).unwrap(),
            GpuPreferenceChange::Written {
                previous: None,
                value: "GpuPreference=2;".into()
            }
        );
        assert_eq!(
            fresh.writes(),
            vec![(exe.clone(), "GpuPreference=2;".into())]
        );

        let saver = MemoryGpuPreferences::with_value(&exe, "GpuPreference=1; ;");
        assert_eq!(
            prefer_high_performance(&saver, &exe).unwrap(),
            GpuPreferenceChange::Written {
                previous: Some("GpuPreference=1; ;".into()),
                value: "GpuPreference=2;".into()
            }
        );
        // 第二次已经是高性能：不再写。
        assert_eq!(
            prefer_high_performance(&saver, &exe).unwrap(),
            GpuPreferenceChange::Unchanged
        );
        assert_eq!(saver.writes().len(), 1);
    }

    #[test]
    fn write_failure_bubbles_up_with_the_path() {
        let exe = PathBuf::from(r"D:\jdk-8\bin\java.exe");
        let err = prefer_high_performance(&MemoryGpuPreferences::failing(), &exe).unwrap_err();
        assert!(
            matches!(&err, crate::error::CoreError::GpuPreferenceWrite { path, .. } if path == &exe),
            "实际：{err:?}"
        );
    }
}
