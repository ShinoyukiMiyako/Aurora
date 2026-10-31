//! 实例名称规则。
//!
//! 实例名就是 `versions/` 下的文件夹名，新建、改名都按同一套规则校验，返回第一条不满足的。
//! 界面在输入时用同样的规则提示，这里是落盘前的最后一道关：名字一旦成了文件夹名，再出问题就是
//! 「Windows 悄悄去掉了结尾的点」「两个实例指向同一个文件夹」这类没有报错的故障。

/// 名称长度上限，按 UTF-16 码元计：与界面输入框的 `maxLength` 计法一致，两边对同一个名字的判断不会分叉。
pub const MAX_NAME_UNITS: usize = 32;

/// 不能出现在文件夹名里的字符（Windows 的限制）。
pub const ILLEGAL_NAME_CHARS: [char; 9] = ['\\', '/', ':', '*', '?', '"', '<', '>', '|'];

/// Windows 保留的设备名，不分大小写，不能作文件夹名。
const RESERVED_NAMES: [&str; 22] = [
    "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8",
    "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
];

/// 名称不满足的规则，按校验顺序排列。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NameViolation {
    /// 去掉首尾空白后为空。
    Empty,
    /// 超过 [`MAX_NAME_UNITS`]。
    TooLong,
    /// 含 [`ILLEGAL_NAME_CHARS`] 中的字符。
    IllegalChar,
    /// 以点或空格结尾、是保留设备名、或含控制字符：Windows 不接受这样的文件夹名。
    ReservedByWindows,
    /// 以点开头：点开头的目录是启动器自己的元数据目录，扫描实例时会被跳过，实例会「消失」。
    LeadingDot,
    /// 与其他实例重名（不分大小写）：Windows 的文件夹名不分大小写，`ABC` 与 `abc` 是同一个文件夹。
    Duplicate,
}

impl NameViolation {
    /// 稳定的规则码，前端据此对应文案。
    pub fn code(self) -> &'static str {
        match self {
            NameViolation::Empty => "empty",
            NameViolation::TooLong => "too_long",
            NameViolation::IllegalChar => "illegal_char",
            NameViolation::ReservedByWindows => "reserved",
            NameViolation::LeadingDot => "leading_dot",
            NameViolation::Duplicate => "duplicate",
        }
    }

    /// 给用户看的说明。
    pub fn message(self) -> &'static str {
        match self {
            NameViolation::Empty => "先给实例起个名字",
            NameViolation::TooLong => "名称最多 32 个字",
            NameViolation::IllegalChar => "名称里不能有 \\ / : * ? \" < > | 这些字符",
            NameViolation::ReservedByWindows => "这个名字 Windows 不允许用作文件夹名",
            NameViolation::LeadingDot => "名称不能以 . 开头",
            NameViolation::Duplicate => "已经有同名的实例了，换一个吧",
        }
    }
}

/// 只看名称本身的规则（不含重名）。
pub fn check_name_format(name: &str) -> Result<(), NameViolation> {
    if name.trim().is_empty() {
        return Err(NameViolation::Empty);
    }
    if name.encode_utf16().count() > MAX_NAME_UNITS {
        return Err(NameViolation::TooLong);
    }
    if name.chars().any(|c| ILLEGAL_NAME_CHARS.contains(&c)) {
        return Err(NameViolation::IllegalChar);
    }
    // 带扩展名的设备名（`CON.txt`、`nul.tar.gz`）在 Windows 上同样指向设备，按第一个点之前的部分判断。
    let stem = name.split('.').next().unwrap_or(name).trim_end_matches(' ');
    let reserved = RESERVED_NAMES
        .iter()
        .any(|reserved| reserved.eq_ignore_ascii_case(stem));
    if name.ends_with('.') || name.ends_with(' ') || reserved || name.chars().any(char::is_control)
    {
        return Err(NameViolation::ReservedByWindows);
    }
    if name.starts_with('.') {
        return Err(NameViolation::LeadingDot);
    }
    Ok(())
}

/// 完整校验：名称本身的规则 + 与 `existing` 中的实例不重名（不分大小写）。
///
/// `current` 是正在改名的实例自己的 id：与自己同名（含只改大小写）不算重名；新建实例传 `None`。
pub fn check_instance_name<'a>(
    name: &str,
    existing: impl IntoIterator<Item = &'a str>,
    current: Option<&str>,
) -> Result<(), NameViolation> {
    check_name_format(name)?;
    let folded = name.to_lowercase();
    let clash = existing
        .into_iter()
        .filter(|other| Some(*other) != current)
        .any(|other| other.to_lowercase() == folded);
    if clash {
        return Err(NameViolation::Duplicate);
    }
    Ok(())
}

/// 已有实例 id 是否可以安全地拼进 `versions/` 下的路径：单个普通路径段、不以点开头、不以点或空格结尾。
///
/// id 来自前端，是不可信输入：`..`、带分隔符或盘符的名字会把删除、改名指到游戏目录之外；Windows
/// 解析路径时去掉段尾的点与空格，`abc.` 实际指向 `abc`，而实例锁按字面区分两者，删除、改名会绕过
/// `abc` 上的占用。这里只拦路径层面的危险；别的启动器建的实例名不一定符合 [`check_name_format`]，
/// 照样可以管理（段尾带点或空格的文件夹 Windows 本来就建不出）。
pub fn is_safe_instance_id(id: &str) -> bool {
    !id.is_empty()
        && !id.starts_with('.')
        && !id.ends_with(['.', ' '])
        && !id.contains(['/', '\\', ':', '\0'])
        && std::path::Path::new(id)
            .components()
            .all(|c| matches!(c, std::path::Component::Normal(_)))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn check(name: &str) -> Result<(), NameViolation> {
        check_instance_name(name, ["周末生存", "RLCraft"], None)
    }

    #[test]
    fn rules_are_checked_in_order_and_report_the_first_failure() {
        assert_eq!(check(""), Err(NameViolation::Empty));
        assert_eq!(check("   "), Err(NameViolation::Empty));
        // 超长且含非法字符：先报长度。
        assert_eq!(check(&"?".repeat(33)), Err(NameViolation::TooLong));
        // 非法字符且以点结尾：先报非法字符。
        assert_eq!(check("a:b."), Err(NameViolation::IllegalChar));
        // 保留名且重名：先报保留名。
        assert_eq!(
            check_instance_name("con", ["CON"], None),
            Err(NameViolation::ReservedByWindows)
        );
    }

    #[test]
    fn length_counts_utf16_units_with_boundaries() {
        assert_eq!(check(&"a".repeat(32)), Ok(()));
        assert_eq!(check(&"a".repeat(33)), Err(NameViolation::TooLong));
        assert_eq!(check(&"樱".repeat(32)), Ok(()));
        assert_eq!(check(&"樱".repeat(33)), Err(NameViolation::TooLong));
        // 补充平面字符占两个码元：16 个正好 32，17 个超限。
        assert_eq!(check(&"\u{1F338}".repeat(16)), Ok(()));
        assert_eq!(check(&"\u{1F338}".repeat(17)), Err(NameViolation::TooLong));
    }

    #[test]
    fn every_illegal_character_is_rejected() {
        for c in ILLEGAL_NAME_CHARS {
            assert_eq!(
                check(&format!("a{c}b")),
                Err(NameViolation::IllegalChar),
                "{c}"
            );
        }
    }

    #[test]
    fn windows_reserved_names_and_trailing_dot_or_space_are_rejected() {
        for name in [
            "CON",
            "con",
            "Prn",
            "aux",
            "NUL",
            "COM1",
            "com1",
            "COM9",
            "lpt1",
            "LPT9",
            "CON.txt",
            "nul.tar.gz",
            "com1.zip",
            "AUX .x",
        ] {
            assert_eq!(check(name), Err(NameViolation::ReservedByWindows), "{name}");
        }
        for name in ["生存.", "生存 ", "a\tb", "a\u{7}"] {
            assert_eq!(
                check(name),
                Err(NameViolation::ReservedByWindows),
                "{name:?}"
            );
        }
        // 只是以保留名开头、或 COM0/COM10 这类不在清单里的，不拦。
        for name in [
            "CONSOLE",
            "COM10",
            "COM0",
            "NULL",
            "1.21 生存",
            "CONSOLE.txt",
            "生存.CON",
        ] {
            assert_eq!(check(name), Ok(()), "{name}");
        }
    }

    #[test]
    fn leading_dot_is_rejected_because_scans_skip_dot_directories() {
        assert_eq!(check(".petalfall"), Err(NameViolation::LeadingDot));
        assert_eq!(check(".hidden"), Err(NameViolation::LeadingDot));
    }

    #[test]
    fn duplicates_are_case_insensitive_but_ignore_the_instance_itself() {
        assert_eq!(check("rlcraft"), Err(NameViolation::Duplicate));
        assert_eq!(check("RLCRAFT"), Err(NameViolation::Duplicate));
        assert_eq!(check("周末生存"), Err(NameViolation::Duplicate));
        // 改名时自己不算重名，只改大小写也允许。
        assert_eq!(
            check_instance_name("rlcraft", ["周末生存", "RLCraft"], Some("RLCraft")),
            Ok(())
        );
        // 但与别的实例只差大小写仍是重名。
        assert_eq!(
            check_instance_name("周末生存", ["周末生存", "RLCraft"], Some("RLCraft")),
            Err(NameViolation::Duplicate)
        );
        assert_eq!(check("RLCraft 2"), Ok(()));
    }

    #[test]
    fn codes_and_messages_are_stable() {
        assert_eq!(NameViolation::Duplicate.code(), "duplicate");
        assert_eq!(
            NameViolation::Duplicate.message(),
            "已经有同名的实例了，换一个吧"
        );
        assert_eq!(NameViolation::Empty.message(), "先给实例起个名字");
        assert_eq!(NameViolation::ReservedByWindows.code(), "reserved");
    }

    #[test]
    fn unsafe_ids_cannot_escape_the_versions_directory() {
        for id in [
            "..",
            ".",
            "",
            "../saves",
            r"..\saves",
            "a/b",
            r"a\b",
            "C:",
            "C:x",
            ".petalfall",
            "a\0b",
        ] {
            assert!(!is_safe_instance_id(id), "{id:?}");
        }
        for id in [
            "1.21",
            "周末生存",
            "fabric-loader-0.15.11-1.21",
            "CON",
            "a b",
        ] {
            assert!(is_safe_instance_id(id), "{id:?}");
        }
    }

    /// Windows 解析路径时会去掉段尾的点与空格：`周末生存.` 与 `周末生存 ` 都落到 `周末生存` 这个目录上，
    /// 而实例锁按字面区分它们，拿这样的 id 删除、改名就能绕过运行中的那个实例的占用。
    #[test]
    fn ids_aliasing_another_folder_through_trailing_dots_or_spaces_are_unsafe() {
        #[cfg(windows)]
        {
            let tmp = tempfile::tempdir().unwrap();
            std::fs::create_dir(tmp.path().join("周末生存")).unwrap();
            assert!(
                tmp.path().join("周末生存.").is_dir(),
                "前提：段尾的点被系统去掉"
            );
            assert!(
                tmp.path().join("周末生存 ").is_dir(),
                "前提：段尾的空格被系统去掉"
            );
        }
        for id in ["周末生存.", "周末生存 ", "1.21..", "a. ", "a ."] {
            assert!(!is_safe_instance_id(id), "{id:?}");
        }
        for id in ["1.21", "a.b", " a", "a b", "v1.0-rc"] {
            assert!(is_safe_instance_id(id), "{id:?}");
        }
    }
}
