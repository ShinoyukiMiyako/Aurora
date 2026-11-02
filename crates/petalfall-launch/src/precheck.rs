//! 启动前的轻量判断：版本要求的 Java 主版本、游戏路径里的危险字符。
//!
//! 阻断性的检查（主类缺失、Java 不匹配、文件缺失、账户失效）各自在启动编排的对应阶段里做，失败时
//! 带着结构化的失败码与参数直接中止；这里只放不阻断启动、只值得提醒一句的判断，以及几处共用的约定。

use std::path::{Path, PathBuf};
use std::sync::LazyLock;

use petalfall_version::{LoaderInfo, LoaderKind, VersionJson};
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

/// Forge 换成模块化启动栈（BootstrapLauncher、SecureJarHandler）的第一个小版本。
const FORGE_MODULE_STACK_MINOR: u32 = 17;

/// 路径里的非 ASCII 字符在这个版本上有没有风险。系统代码页表示不了的字符不归这里管，启动前已经拦下了。
///
/// 代码页表示得了的字符，Java 一路都能传到系统：在 GBK 系统上用启动器这套参数实测，模块化的 Forge 全栈
/// （含 Jar-in-Jar 的 Mod）与 LWJGL 3 的本地库都不受影响。提醒只留给模块化之前的 Forge：这类路径的问题一直
/// 指向它们，又没有样本能排除。
/// 版本号解析不出（含周快照）时不提醒：猜错了反而误导。
pub fn non_ascii_path_at_risk(loaders: &[LoaderInfo], game_version: &str) -> bool {
    if !loaders
        .iter()
        .any(|loader| loader.kind == LoaderKind::Forge)
    {
        return false;
    }
    RELEASE_PREFIX
        .captures(game_version)
        .and_then(|caps| caps[1].parse::<u32>().ok())
        .is_some_and(|minor| minor < FORGE_MODULE_STACK_MINOR)
}

/// 路径上一个值得提醒的字符，按玩家要改的地方分开：游戏目录里的要换目录才消得掉，实例名里的改个名就够了。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PathWarning {
    GameDir(char),
    InstanceName(char),
}

/// 第一个可能引发问题的字符。`!` 在路径段末尾时 Java 的 jar URL 解析会把它当成分隔符，读 jar 里的文件直接失败，
/// 与加载器无关；非 ASCII 只在 `non_ascii_at_risk` 时才算。它们不一定出问题，所以只提醒、不阻断。
fn risky_path_char(text: &str, non_ascii_at_risk: bool) -> Option<char> {
    text.chars()
        .find(|c| *c == '!' || (non_ascii_at_risk && !c.is_ascii()))
}

/// 这一局路径上值得提醒的字符，游戏目录在前。两处都有就各报一条：只改一处，另一处下一局还会冒出来。
/// `instance_names` 只传真正落在路径上的实例名，没落在路径上的改了也不起作用。
pub fn path_warnings<'a>(
    game_dir: &Path,
    instance_names: impl IntoIterator<Item = &'a str>,
    non_ascii_at_risk: bool,
) -> Vec<PathWarning> {
    let game_dir =
        risky_path_char(&game_dir.to_string_lossy(), non_ascii_at_risk).map(PathWarning::GameDir);
    let instance_name = instance_names
        .into_iter()
        .find_map(|name| risky_path_char(name, non_ascii_at_risk))
        .map(PathWarning::InstanceName);
    game_dir.into_iter().chain(instance_name).collect()
}

/// 路径里第一个系统代码页表示不了的字符。
///
/// Windows 上的 java.exe 按系统代码页读命令行（Java 8 到 26 实测都是）：表示不了的字符变成问号，
/// classpath 指向不存在的文件，游戏只会报找不到主类。其他系统的命令行是字节串，没有这回事。
pub fn path_char_outside_code_page(path: &Path) -> Option<char> {
    char_lost_on_command_line(&path.to_string_lossy())
}

/// 命令行参数里第一个到不了 Java 的字符。
#[cfg(windows)]
pub(crate) fn char_lost_on_command_line(text: &str) -> Option<char> {
    // SAFETY: 无参数，只读进程的系统代码页。
    let code_page = unsafe { windows_sys::Win32::Globalization::GetACP() };
    char_outside_code_page(text, code_page)
}

/// 命令行参数里第一个到不了 Java 的字符。非 Windows 系统不受影响。
#[cfg(not(windows))]
pub(crate) fn char_lost_on_command_line(_text: &str) -> Option<char> {
    None
}

#[cfg(windows)]
pub(crate) fn char_outside_code_page(text: &str, code_page: u32) -> Option<char> {
    use windows_sys::Win32::Globalization::{CP_UTF8, WC_NO_BEST_FIT_CHARS, WideCharToMultiByte};

    // UTF-8 什么都表示得了，而且系统不接受它带这里的标志与输出参数。
    if code_page == CP_UTF8 {
        return None;
    }
    text.chars().filter(|ch| !ch.is_ascii()).find(|ch| {
        let mut wide = [0u16; 2];
        let wide = ch.encode_utf16(&mut wide);
        let mut encoded = [0u8; 8];
        let mut lossy = 0;
        // SAFETY: 两个缓冲区都是栈上数组，长度都小到不会截断 i32，输出参数指向本地变量。
        let written = unsafe {
            WideCharToMultiByte(
                code_page,
                WC_NO_BEST_FIT_CHARS,
                wide.as_ptr(),
                wide.len() as i32,
                encoded.as_mut_ptr(),
                encoded.len() as i32,
                std::ptr::null(),
                &raw mut lossy,
            )
        };
        written == 0 || lossy != 0
    })
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

/// 是不是在设堆大小。前缀后面紧跟字母的是另一个选项（OpenJ9 的 `-Xmso<size>`），不是写错单位的堆参数；
/// 其余写法（`-Xmx`、`-Xmx=4g`）都还算，留给 [`heap_arg_bytes`] 判对错。
fn is_heap_arg(arg: &str) -> bool {
    arg.strip_prefix("-Xmx")
        .or_else(|| arg.strip_prefix("-Xms"))
        .is_some_and(|value| !value.starts_with(|c: char| c.is_ascii_alphabetic()))
}

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
        if !is_heap_arg(arg) {
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

    fn loader(kind: LoaderKind) -> LoaderInfo {
        LoaderInfo {
            kind,
            version: None,
        }
    }

    #[test]
    fn non_ascii_paths_only_put_forge_before_1_17_at_risk() {
        let forge = [loader(LoaderKind::Forge)];
        for version in ["1.7.10", "1.12.2", "1.13.2", "1.16.5", "1.16.5-pre1"] {
            assert!(non_ascii_path_at_risk(&forge, version), "{version}");
        }
        // 边界：1.16 的最后一个补丁版之后就是模块化启动栈。
        for version in ["1.17", "1.17.1", "1.20.1", "1.21.4", "26.1"] {
            assert!(!non_ascii_path_at_risk(&forge, version), "{version}");
        }
        // 版本号解析不出时不下结论。
        assert!(!non_ascii_path_at_risk(&forge, "23w45a"));
        assert!(!non_ascii_path_at_risk(&forge, "我的整合包"));

        // 同一个旧版本号，换成别的加载器或原版都不算。
        assert!(!non_ascii_path_at_risk(&[], "1.12.2"));
        for kind in [
            LoaderKind::Fabric,
            LoaderKind::Quilt,
            LoaderKind::NeoForge,
            LoaderKind::OptiFine,
            LoaderKind::LiteLoader,
        ] {
            assert!(
                !non_ascii_path_at_risk(&[loader(kind)], "1.12.2"),
                "{kind:?}"
            );
        }
        // Forge 叠 OptiFine 时 Forge 还在。
        assert!(non_ascii_path_at_risk(
            &[loader(LoaderKind::Forge), loader(LoaderKind::OptiFine)],
            "1.12.2"
        ));
    }

    #[test]
    fn path_warnings_separate_the_game_dir_from_the_instance_name() {
        let clean = Path::new(r"D:\games\mc");
        let chinese = Path::new(r"D:\我的世界");

        assert_eq!(
            path_warnings(clean, ["周末生存"], true),
            vec![PathWarning::InstanceName('周')]
        );
        assert_eq!(
            path_warnings(chinese, ["1.12.2"], true),
            vec![PathWarning::GameDir('我')]
        );
        assert_eq!(
            path_warnings(chinese, ["周末生存"], true),
            vec![PathWarning::GameDir('我'), PathWarning::InstanceName('周')]
        );
        // 第一个名字干净时看下一个：工作目录用实例名，client jar 与 natives 用继承链根的名字。
        assert_eq!(
            path_warnings(clean, ["1.12.2", "周末生存"], true),
            vec![PathWarning::InstanceName('周')]
        );
        assert_eq!(path_warnings(clean, ["1.12.2"], true), vec![]);
        assert_eq!(path_warnings(clean, [], true), vec![]);
    }

    #[test]
    fn non_ascii_is_only_flagged_when_it_is_at_risk() {
        let chinese = Path::new(r"D:\我的世界");
        assert_eq!(path_warnings(chinese, ["周末生存"], false), vec![]);
    }

    /// `!` 绊住的是 Java 本身，不看加载器；排在中文之前时报的是它。
    #[test]
    fn a_bang_is_flagged_whether_or_not_non_ascii_is_at_risk() {
        let bang = Path::new(r"D:\games!\mc");
        assert_eq!(
            path_warnings(bang, ["周末生存"], false),
            vec![PathWarning::GameDir('!')]
        );
        assert_eq!(
            path_warnings(Path::new(r"D:\games"), ["周末!"], false),
            vec![PathWarning::InstanceName('!')]
        );
        assert_eq!(
            path_warnings(Path::new(r"D:\游戏!"), [], true),
            vec![PathWarning::GameDir('游')]
        );
    }

    /// 判定只看给定的代码页，测试不随这台电脑的系统语言变。
    #[cfg(windows)]
    #[test]
    fn code_page_check_finds_the_first_character_it_cannot_encode() {
        const GBK: u32 = 936;
        const WESTERN: u32 = 1252;
        assert_eq!(char_outside_code_page(r"D:\我的世界\生存 1.12", GBK), None);
        assert_eq!(
            char_outside_code_page(r"D:\我的世界\한글 테스트", GBK),
            Some('한')
        );
        assert_eq!(char_outside_code_page(r"D:\games", WESTERN), None);
        assert_eq!(char_outside_code_page(r"D:\我的世界", WESTERN), Some('我'));
        // 代理对也是一个字符。
        assert_eq!(
            char_outside_code_page("D:\\\u{20BB7}", GBK),
            Some('\u{20BB7}')
        );
    }

    /// 只能近似映射的字符同样算表示不了：ā 近似成 a 之后路径指向的已经不是那个文件。
    #[cfg(windows)]
    #[test]
    fn best_fit_mapping_counts_as_not_encodable() {
        assert_eq!(char_outside_code_page("\u{101}", 1252), Some('\u{101}'));
    }

    #[cfg(windows)]
    #[test]
    fn utf8_code_page_encodes_everything() {
        assert_eq!(char_outside_code_page("D:\\한글\\\u{20BB7}", 65001), None);
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

    /// `-Xmso` 是 OpenJ9 的操作系统线程栈大小，只是前缀碰巧与 `-Xms` 相同：既不是写错单位的堆参数，
    /// 也不能把它的值算进最小堆。
    #[test]
    fn options_that_only_share_the_heap_prefix_are_left_alone() {
        let launcher = MemoryConfig::fixed(2048);
        assert_eq!(jvm_memory_issue(&args("-Xmso256k"), launcher), None);
        // 算进最小堆的话 8g 大于最大堆，这里要报的只有后面那个真的写错的 -Xms。
        assert_eq!(jvm_memory_issue(&args("-Xmso8g"), launcher), None);
        assert_eq!(
            jvm_memory_issue(&args("-Xmso256k -Xms4GB"), launcher),
            Some(JvmMemoryIssue::BadUnit {
                arg: "-Xms4GB".into()
            })
        );
        // 排在真堆参数之后也不改变生效值。
        assert_eq!(
            jvm_memory_issue(&args("-Xmx256m -Xmso8g"), launcher),
            Some(JvmMemoryIssue::MaxTooLow { max_mb: 256 })
        );
        // 紧跟的不是字母，就还是写错了的堆参数。
        assert_eq!(
            jvm_memory_issue(&args("-Xmx=4g"), launcher),
            Some(JvmMemoryIssue::BadUnit {
                arg: "-Xmx=4g".into()
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
