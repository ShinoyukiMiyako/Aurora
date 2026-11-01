//! 启动前的轻量判断：版本要求的 Java 主版本、游戏路径里的危险字符。
//!
//! 阻断性的检查（主类缺失、Java 不匹配、文件缺失、账户失效）各自在启动编排的对应阶段里做，失败时
//! 带着结构化的失败码与参数直接中止；这里只放不阻断启动、只值得提醒一句的判断，以及几处共用的约定。

use std::path::{Path, PathBuf};
use std::sync::LazyLock;

use aurora_version::VersionJson;
use regex::Regex;

use crate::memory::MemoryConfig;

/// 版本 JSON 未声明 `javaVersion` 时所需的 Java 主版本：只有 1.16 及更早的版本 JSON 不写这个字段，
/// 它们都跑在 Java 8 上。
pub const DEFAULT_JAVA_MAJOR: u32 = 8;

/// 版本要求的 Java 主版本（合并后的版本 JSON）。
pub fn required_java_major(version: &VersionJson) -> u32 {
    version
        .java_version
        .as_ref()
        .map_or(DEFAULT_JAVA_MAJOR, |java| java.major_version)
}

/// 游戏路径里第一个可能引发问题的字符（非 ASCII、`!`）。有就返回提醒文案。
///
/// 部分 Forge 版本与 natives 加载在非 UTF-8 的系统代码页下读不了这类路径，`!` 则会被 Java 的
/// jar URL 解析当成分隔符。它们不一定出问题，所以只提醒、不阻断。
pub fn game_path_warning(game_dir: &Path) -> Option<String> {
    let lossy = game_dir.to_string_lossy();
    let ch = lossy.chars().find(|c| !c.is_ascii() || *c == '!')?;
    Some(format!(
        "游戏路径含字符「{ch}」，部分 Forge 版本与本地库加载可能出错，建议换到纯英文路径"
    ))
}

/// 同步盘。它们在同步时会占用、替换或按需下载正在读写的文件，存档与 Mod 可能读不全。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SyncProvider {
    OneDrive,
    ICloud,
}

/// 一个同步盘根目录。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SyncRoot {
    pub provider: SyncProvider,
    pub path: PathBuf,
}

/// OneDrive 客户端设置的根目录环境变量：`OneDrive` 指向第一个登录的账户，`OneDriveConsumer` 是个人版，
/// `OneDriveCommercial` 是工作或学校版。改过位置的同步目录不一定叫 OneDrive，只能靠它们认出来。
pub const ONEDRIVE_ENV_VARS: [&str; 3] = ["OneDrive", "OneDriveConsumer", "OneDriveCommercial"];

/// 从环境变量读出的同步盘根目录（未设或为空串的跳过）。这里是本模块唯一读进程环境的地方，
/// 判断本身在 [`sync_folder`] 里，便于测试。
pub fn sync_roots_from_env() -> Vec<SyncRoot> {
    ONEDRIVE_ENV_VARS
        .iter()
        .filter_map(std::env::var_os)
        .filter(|value| !value.is_empty())
        .map(|value| SyncRoot {
            provider: SyncProvider::OneDrive,
            path: PathBuf::from(value),
        })
        .collect()
}

/// 路径按 `\` 与 `/` 切成段，去掉空段与 `\\?\`、`\\.\` 前缀留下的 `?`、`.` 段。不用 [`Path::components`]：
/// 它只认当前平台的分隔符，而游戏目录与环境变量里的路径都可能是 Windows 写法。
fn path_segments(path: &Path) -> Vec<String> {
    let lossy = path.to_string_lossy();
    let mut segments: Vec<String> = lossy
        .split(['\\', '/'])
        .filter(|segment| !segment.is_empty())
        .map(str::to_owned)
        .collect();
    if segments
        .first()
        .is_some_and(|first| first == "?" || first == ".")
    {
        segments.remove(0);
    }
    segments
}

/// 路径是否在同步盘里：任一段（不区分大小写）是 OneDrive 的默认文件夹名（个人版 `OneDrive`、工作或
/// 学校版 `OneDrive - <组织名>`）或 iCloud 的默认文件夹名（`iCloudDrive`，微软商店版为 `iCloud Drive`），
/// 或按段位于某个已知根目录之内（含根目录本身）。
pub fn sync_folder(path: &Path, roots: &[SyncRoot]) -> Option<SyncProvider> {
    let segments = path_segments(path);
    for segment in &segments {
        let lower = segment.to_ascii_lowercase();
        if lower == "onedrive" || lower.starts_with("onedrive - ") {
            return Some(SyncProvider::OneDrive);
        }
        if lower == "iclouddrive" || lower == "icloud drive" {
            return Some(SyncProvider::ICloud);
        }
    }
    roots.iter().find_map(|root| {
        let root_segments = path_segments(&root.path);
        let inside = !root_segments.is_empty()
            && root_segments.len() <= segments.len()
            && root_segments
                .iter()
                .zip(&segments)
                .all(|(a, b)| a.eq_ignore_ascii_case(b));
        inside.then_some(root.provider)
    })
}

/// 1.20.3 起游戏只认不超过 16 个字符的角色名（按 Java `String.length` 计，即 UTF-16 码元），更长的名字
/// 进存档（内置服务器）与服务器时都会被拒绝。
pub const PLAYER_NAME_MAX_UNITS: usize = 16;

/// 版本号前缀 `1.<minor>[.<patch>]`；`-pre` / `-rc` 后缀不影响前缀。周快照（`23w45a`）匹配不上。
static RELEASE_PREFIX: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^1\.(\d+)(?:\.(\d+))?").expect("内置正则必须可编译"));

/// 2026 年起的年份版本号 `<年>.<序号>[.<修订>]`，快照与预发布写作 `26.1-snapshot-1`、`26.1-pre-3`。
/// 年份从 26 起，挡掉形似的愚人节版本 `2.0`。
static YEAR_BASED_PREFIX: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^(?:2[6-9]|[3-9]\d)\.\d+").expect("内置正则必须可编译"));

/// 角色名在这个游戏版本上是否过长。版本号解析不出（含周快照）时不提醒：猜错了反而误导。
pub fn long_player_name(name: &str, mc_version: &str) -> bool {
    if name.encode_utf16().count() <= PLAYER_NAME_MAX_UNITS {
        return false;
    }
    // 年份版本号全都晚于 1.20.3。
    if YEAR_BASED_PREFIX.is_match(mc_version) {
        return true;
    }
    let Some(caps) = RELEASE_PREFIX.captures(mc_version) else {
        return false;
    };
    let Ok(minor) = caps[1].parse::<u32>() else {
        return false;
    };
    let patch = match caps.get(2) {
        Some(patch) => match patch.as_str().parse::<u32>() {
            Ok(patch) => patch,
            Err(_) => return false,
        },
        // `1.21` 这类没有补丁号的正式版即补丁号 0。
        None => 0,
    };
    (minor, patch) >= (20, 3)
}

/// 自定义 JVM 参数里的内存问题。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum JvmMemoryIssue {
    /// `-Xmx` / `-Xms` 的写法 Java 不认（如 `-Xmx4GB`），原样带出那个参数。
    BadUnit { arg: String },
    /// 生效的最小堆大于最大堆，JVM 启动即报错退出。
    MinOverMax { min_mb: u64, max_mb: u64 },
    /// 生效的最大堆低于 [`MIN_MAX_HEAP_MB`]。
    MaxTooLow { max_mb: u64 },
}

/// 最大堆低于它时游戏多半进不了主界面。
pub const MIN_MAX_HEAP_MB: u64 = 512;

const MIB: u64 = 1024 * 1024;

/// HotSpot 认的堆大小写法：数字后至多一个单位字母 k、m、g、t（大小写均可），无单位为字节。
static HEAP_SIZE_ARG: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^-Xm([sx])(\d+)([kKmMgGtT]?)$").expect("内置正则必须可编译"));

/// 一个 `-Xmx` / `-Xms` 参数的字节数；写法不合法或数值溢出为 `None`（HotSpot 对溢出同样拒绝）。
fn heap_arg_bytes(arg: &str) -> Option<(char, u64)> {
    let caps = HEAP_SIZE_ARG.captures(arg)?;
    let kind = if &caps[1] == "x" { 'x' } else { 's' };
    let number = caps[2].parse::<u64>().ok()?;
    let unit: u64 = match caps[3].to_ascii_lowercase().as_str() {
        "" => 1,
        "k" => 1024,
        "m" => MIB,
        "g" => 1024 * MIB,
        "t" => 1024 * 1024 * MIB,
        other => unreachable!("正则只放行 k/m/g/t，实际 {other}"),
    };
    Some((kind, number.checked_mul(unit)?))
}

/// 检查自定义 JVM 参数与启动器内存设置合起来的生效内存。自定义参数排在启动器的内存参数之后，同一参数
/// JVM 取最后一次，所以生效值是自定义参数里最后一个 `-Xmx` / `-Xms`，没写才用启动器的。只返回第一个
/// 问题：写法不对时数值无从谈起。`-Xms` 低于 512 MB 不算问题，JVM 会按需扩堆。
pub fn jvm_memory_issue(custom_args: &[String], launcher: MemoryConfig) -> Option<JvmMemoryIssue> {
    let mut max_bytes = u64::from(launcher.max_mb) * MIB;
    let mut min_bytes = launcher.min_mb.map(|min| u64::from(min) * MIB);
    for arg in custom_args {
        if !(arg.starts_with("-Xmx") || arg.starts_with("-Xms")) {
            continue;
        }
        let Some((kind, bytes)) = heap_arg_bytes(arg) else {
            return Some(JvmMemoryIssue::BadUnit { arg: arg.clone() });
        };
        if kind == 'x' {
            max_bytes = bytes;
        } else {
            min_bytes = Some(bytes);
        }
    }
    if let Some(min_bytes) = min_bytes
        && min_bytes > max_bytes
    {
        return Some(JvmMemoryIssue::MinOverMax {
            min_mb: min_bytes / MIB,
            max_mb: max_bytes / MIB,
        });
    }
    (max_bytes < MIN_MAX_HEAP_MB * MIB).then_some(JvmMemoryIssue::MaxTooLow {
        max_mb: max_bytes / MIB,
    })
}

/// 这一局真正生效的最大堆（MB，向上取整）：自定义参数排在启动器的内存参数之后，同一参数 JVM 取最后一次，所以是
/// 自定义参数里最后一个 `-Xmx`，没写才用启动器的。写法不对的那些 Java 根本起不来，不算。
pub fn effective_max_heap_mb(custom_args: &[String], launcher: MemoryConfig) -> u32 {
    custom_args
        .iter()
        .filter_map(|arg| heap_arg_bytes(arg))
        .rfind(|(kind, _)| *kind == 'x')
        .map_or(launcher.max_mb, |(_, bytes)| {
            u32::try_from(bytes.div_ceil(MIB)).unwrap_or(u32::MAX)
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn effective_max_heap_follows_the_last_valid_xmx() {
        let launcher = MemoryConfig {
            max_mb: 4096,
            min_mb: None,
        };
        let args = |list: &[&str]| list.iter().map(|a| (*a).to_owned()).collect::<Vec<_>>();
        assert_eq!(effective_max_heap_mb(&[], launcher), 4096);
        assert_eq!(effective_max_heap_mb(&args(&["-Xmx64M"]), launcher), 64);
        assert_eq!(effective_max_heap_mb(&args(&["-Xmx2g"]), launcher), 2048);
        assert_eq!(
            effective_max_heap_mb(&args(&["-Xmx1g", "-Xmx512m"]), launcher),
            512
        );
        assert_eq!(effective_max_heap_mb(&args(&["-Xmx1536k"]), launcher), 2);
        // 最小堆与其他开关不影响最大堆；写错的 -Xmx 让 Java 起不来，这里不把它算成生效值。
        assert_eq!(
            effective_max_heap_mb(&args(&["-Xms1g", "-XX:+UseG1GC"]), launcher),
            4096
        );
        assert_eq!(effective_max_heap_mb(&args(&["-Xmx4GB"]), launcher), 4096);
        assert_eq!(
            effective_max_heap_mb(&args(&["-Xmx99999999999999g"]), launcher),
            4096
        );
    }

    #[test]
    fn game_path_warns_on_non_ascii_and_bang() {
        let chinese = game_path_warning(Path::new(r"D:\我的世界")).unwrap();
        assert!(chinese.contains("「我」"), "{chinese}");
        let bang = game_path_warning(Path::new(r"D:\games!\mc")).unwrap();
        assert!(bang.contains("「!」"), "{bang}");
        assert_eq!(game_path_warning(Path::new(r"D:\games\mc")), None);
    }

    #[test]
    fn required_major_defaults_to_java_8() {
        let old = VersionJson::from_json_str(r#"{"id":"1.12.2","mainClass":"m"}"#).unwrap();
        assert_eq!(required_java_major(&old), 8);
        let modern = VersionJson::from_json_str(
            r#"{"id":"1.21","mainClass":"m","javaVersion":{"component":"java-runtime-delta","majorVersion":21}}"#,
        )
        .unwrap();
        assert_eq!(required_java_major(&modern), 21);
    }

    fn onedrive_root(path: &str) -> SyncRoot {
        SyncRoot {
            provider: SyncProvider::OneDrive,
            path: PathBuf::from(path),
        }
    }

    #[test]
    fn sync_folder_recognises_default_names_and_relocated_roots() {
        let none: &[SyncRoot] = &[];
        assert_eq!(
            sync_folder(Path::new(r"D:\Users\a\OneDrive\mc"), none),
            Some(SyncProvider::OneDrive)
        );
        assert_eq!(
            sync_folder(
                Path::new(r"C:\Users\a\OneDrive - Contoso\games\.minecraft"),
                none
            ),
            Some(SyncProvider::OneDrive)
        );
        assert_eq!(
            sync_folder(Path::new(r"C:\Users\a\iCloudDrive\mc"), none),
            Some(SyncProvider::ICloud)
        );
        assert_eq!(
            sync_folder(Path::new("C:/Users/a/iCloud Drive/mc"), none),
            Some(SyncProvider::ICloud)
        );
        // 只是名字里含 OneDrive 的普通文件夹不算。
        assert_eq!(
            sync_folder(Path::new(r"D:\games\OneDriveBackup\mc"), none),
            None
        );
        assert_eq!(sync_folder(Path::new(r"D:\games\mc"), none), None);

        // 改过位置的同步目录路径里没有 OneDrive 字样，只能靠环境变量给出的根目录认。
        let roots = [onedrive_root(r"D:\Sync\Corp\")];
        assert_eq!(
            sync_folder(Path::new(r"d:\sync\corp\mc\.minecraft"), &roots),
            Some(SyncProvider::OneDrive)
        );
        assert_eq!(
            sync_folder(Path::new(r"D:\Sync\Corp"), &roots),
            Some(SyncProvider::OneDrive)
        );
        // 按段比较：同前缀的兄弟目录、根目录的上级都不在根目录之内。
        assert_eq!(
            sync_folder(Path::new(r"D:\Sync\Corporate\mc"), &roots),
            None
        );
        assert_eq!(sync_folder(Path::new(r"D:\Sync"), &roots), None);
        assert_eq!(
            sync_folder(Path::new(r"\\?\D:\Sync\Corp\mc"), &roots),
            Some(SyncProvider::OneDrive)
        );
    }

    #[test]
    fn long_player_name_counts_utf16_units_against_1_20_3() {
        let seventeen = "abcdefghijklmnopq";
        let sixteen = "abcdefghijklmnop";
        assert_eq!(seventeen.len(), 17);
        assert!(long_player_name(seventeen, "1.20.4"));
        assert!(long_player_name(seventeen, "1.20.3"));
        assert!(long_player_name(seventeen, "1.21"));
        assert!(long_player_name(seventeen, "1.20.3-pre1"));
        assert!(!long_player_name(seventeen, "1.20.2"));
        assert!(!long_player_name(seventeen, "1.20"));
        assert!(!long_player_name(seventeen, "1.12.2"));
        assert!(!long_player_name(seventeen, "23w45a"));
        assert!(!long_player_name(seventeen, "b1.7.3"));
        assert!(!long_player_name(sixteen, "1.21"));
        assert!(!long_player_name(sixteen, "1.20.3"));
        // 9 个汉字加 8 个字母是 17 个 UTF-16 码元，按 Java 的算法同样超长。
        assert!(long_player_name("春夏秋冬春夏秋冬春abcdefgh", "1.21"));
        // 数的是码元而非字符：8 个增补平面字符正好 16 个码元，再加 1 个即超长。
        let astral = "\u{20000}".repeat(8);
        assert_eq!(astral.chars().count(), 8);
        assert!(!long_player_name(&astral, "1.21"));
        assert!(long_player_name(&format!("{astral}a"), "1.21"));
    }

    #[test]
    fn long_player_name_counts_year_based_versions_as_newer_than_1_20_3() {
        // 2026 年起正式版、快照、预发布都改用 `<年>.<序号>` 的版本号，全部晚于 1.20.3。
        let seventeen = "abcdefghijklmnopq";
        for version in [
            "26.1",
            "26.1.2",
            "26.3",
            "26.1-snapshot-1",
            "26.1-pre-3",
            "26.1-rc-1",
        ] {
            assert!(long_player_name(seventeen, version), "{version}");
            assert!(!long_player_name("abcdefghijklmnop", version), "{version}");
        }
        // 愚人节的 2.0 与年份版本号形似，但它是 1.5 时代的版本。
        assert!(!long_player_name(seventeen, "2.0"));
        assert!(!long_player_name(seventeen, "25w14craftmine"));
    }

    fn args(line: &str) -> Vec<String> {
        line.split_whitespace().map(str::to_owned).collect()
    }

    #[test]
    fn jvm_memory_issue_uses_the_effective_values() {
        let launcher = MemoryConfig::fixed(2048);
        assert_eq!(
            jvm_memory_issue(&args("-Xms4G -Xmx2G"), launcher),
            Some(JvmMemoryIssue::MinOverMax {
                min_mb: 4096,
                max_mb: 2048
            })
        );
        assert_eq!(
            jvm_memory_issue(&args("-XX:+UseG1GC -Xmx4GB"), launcher),
            Some(JvmMemoryIssue::BadUnit {
                arg: "-Xmx4GB".into()
            })
        );
        assert_eq!(
            jvm_memory_issue(&args("-Xmx256m"), launcher),
            Some(JvmMemoryIssue::MaxTooLow { max_mb: 256 })
        );
        // 只写了 -Xms：最大堆沿用启动器的 2048。
        assert_eq!(
            jvm_memory_issue(&args("-Xms4g"), launcher),
            Some(JvmMemoryIssue::MinOverMax {
                min_mb: 4096,
                max_mb: 2048
            })
        );
        // 同一参数后者生效。
        assert_eq!(jvm_memory_issue(&args("-Xmx4g -Xmx8g"), launcher), None);
        assert_eq!(
            jvm_memory_issue(&args("-Xmx8g -Xmx256m"), launcher),
            Some(JvmMemoryIssue::MaxTooLow { max_mb: 256 })
        );
        // 无单位为字节：恰好 512 MiB 不算低，少 1 KiB 就算。
        assert_eq!(jvm_memory_issue(&args("-Xmx536870912"), launcher), None);
        assert_eq!(
            jvm_memory_issue(&args("-Xmx524287k"), launcher),
            Some(JvmMemoryIssue::MaxTooLow { max_mb: 511 })
        );
        assert_eq!(jvm_memory_issue(&args("-Xmx1t -Xms512M"), launcher), None);
        // 写法问题优先于数值问题，且只报第一个。
        assert_eq!(
            jvm_memory_issue(&args("-Xms4g -Xmx -Xmx2 g"), launcher),
            Some(JvmMemoryIssue::BadUnit { arg: "-Xmx".into() })
        );
        assert_eq!(
            jvm_memory_issue(&args("-Xmx99999999999999999999g"), launcher),
            Some(JvmMemoryIssue::BadUnit {
                arg: "-Xmx99999999999999999999g".into()
            })
        );
        // 没有自定义参数时看启动器自己的设置；-Xms 低不算问题；别的 -X 参数不管。
        assert_eq!(jvm_memory_issue(&[], launcher), None);
        assert_eq!(
            jvm_memory_issue(&[], MemoryConfig::fixed(256)),
            Some(JvmMemoryIssue::MaxTooLow { max_mb: 256 })
        );
        assert_eq!(
            jvm_memory_issue(&args("-Xms64m -Xss4m -Xmn256m"), launcher),
            None
        );
        assert_eq!(
            jvm_memory_issue(&args("-Xmx1g"), MemoryConfig::fixed(4096).with_min(2048)),
            Some(JvmMemoryIssue::MinOverMax {
                min_mb: 2048,
                max_mb: 1024
            })
        );
    }

    #[test]
    fn env_roots_are_onedrive_and_never_empty() {
        assert_eq!(
            ONEDRIVE_ENV_VARS,
            ["OneDrive", "OneDriveConsumer", "OneDriveCommercial"]
        );
        for root in sync_roots_from_env() {
            assert_eq!(root.provider, SyncProvider::OneDrive);
            assert!(!root.path.as_os_str().is_empty());
        }
    }
}
