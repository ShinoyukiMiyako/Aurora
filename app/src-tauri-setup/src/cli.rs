//! 引导程序的命令行：分清是启动器的更新插件拉起的还是用户自己打开的，拆出装完要带回启动器的参数。
//!
//! 插件（tauri-plugin-updater 2.10.1 src/updater.rs 的 `install_inner`）把下载到的 PE 一律当 NSIS 包拉起，
//! 参数是「模式开关 /UPDATE /ARGS 逐个转义的启动器参数」，模式开关见同版本 src/config.rs 的 `nsis_args`：
//! passive 是 `/P /R`，quiet 是 `/S /R`，basicUi 不带。转义按 Windows 标准规则来，std 拆 argv 就能还原，
//! 所以 `/ARGS` 之后的记号原样就是启动器的参数。
//!
//! 这有个前提：启动器不配 `installer_args`。插件把它们接在启动器参数后面，格式上分不出来，配了就会被当成
//! 启动器参数带回去，走原生回退时还会被转义成带引号的普通参数，NSIS 不再当开关认。

use std::ffi::{OsStr, OsString};

use crate::contract::UpdateLaunch;

const PASSIVE: &str = "/P";
const SILENT: &str = "/S";
const RELAUNCH: &str = "/R";
const UPDATE: &str = "/UPDATE";
const ARGS: &str = "/ARGS";

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Launch {
    /// 用户自己打开的，或者命令行里没有 `/UPDATE`。
    Interactive,
    Update(UpdateRequest),
}

impl Launch {
    pub fn update(&self) -> Option<&UpdateRequest> {
        match self {
            Self::Interactive => None,
            Self::Update(request) => Some(request),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UpdateRequest {
    pub relaunch: bool,
    /// 启动器被更新时正带着的参数，装完重新打开它时原样带回。
    pub launcher_args: Vec<OsString>,
}

impl UpdateRequest {
    /// 给前端的那一半
    pub fn launch_info(&self) -> UpdateLaunch {
        UpdateLaunch {
            relaunch: self.relaunch,
        }
    }

    /// 原生回退用：按插件的样子重拼「/P[ /R] /UPDATE /ARGS <转义参数>」，整串给 raw_arg
    pub fn passive_arguments(&self) -> OsString {
        // 回退只为保住今天的行为：启动器没配 installMode，插件按默认的 passive 拉起，NSIS 包收到的就是这一串。
        // 来的是 /S 也拼 /P：解析时不保留模式，passive 至少留着进度条（插件 config.rs 的说明），用户看得到更新在进行。
        let mut arguments = OsString::from(PASSIVE);
        if self.relaunch {
            arguments.push(" ");
            arguments.push(RELAUNCH);
        }
        arguments.push(" ");
        arguments.push(UPDATE);
        arguments.push(" ");
        arguments.push(ARGS);
        for arg in &self.launcher_args {
            arguments.push(" ");
            arguments.push(escape_nsis_current_exe_arg(arg));
        }
        arguments
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Parsed {
    pub launch: Launch,
    /// 只用来写日志。交互启动时是全部参数：没有 `/UPDATE` 时哪个开关都不起作用。
    pub ignored: Vec<OsString>,
}

/// `args` 不含 argv[0]，调用方传 `std::env::args_os().skip(1)`。
pub fn parse(args: impl IntoIterator<Item = OsString>) -> Parsed {
    let mut tokens = args.into_iter();
    let mut switches = Vec::new();
    let mut separator = None;
    // 只有第一个 /ARGS 是分隔符，之后再出现的 /ARGS、/UPDATE 都是启动器自己的参数。
    // 插件总写大写，这里和另外几个开关一样不分大小写。
    for token in tokens.by_ref() {
        if token.eq_ignore_ascii_case(ARGS) {
            separator = Some(token);
            break;
        }
        switches.push(token);
    }
    let after_separator: Vec<OsString> = tokens.collect();

    if !switches
        .iter()
        .any(|token| token.eq_ignore_ascii_case(UPDATE))
    {
        let mut ignored = switches;
        ignored.extend(separator);
        ignored.extend(after_separator);
        return Parsed {
            launch: Launch::Interactive,
            ignored,
        };
    }

    let relaunch = switches
        .iter()
        .any(|token| token.eq_ignore_ascii_case(RELAUNCH));
    let ignored = switches
        .into_iter()
        .filter(|token| {
            ![PASSIVE, SILENT, RELAUNCH, UPDATE]
                .iter()
                .any(|known| token.eq_ignore_ascii_case(known))
        })
        .collect();
    Parsed {
        launch: Launch::Update(UpdateRequest {
            relaunch,
            launcher_args: after_separator,
        }),
        ignored,
    }
}

// 照搬 tauri-plugin-updater 2.10.1 src/updater.rs 的 escape_nsis_current_exe_arg，原文又改编自 Rust std 的
// sys/args/windows.rs。只把参数从 &&OsStr 改成 &OsStr，函数体逐字保留，插件升级时好逐行比对。
fn escape_nsis_current_exe_arg(arg: &OsStr) -> String {
    let arg = arg.to_string_lossy();
    let mut cmd: Vec<char> = Vec::new();

    // compared to std we additionally escape `/` so that nsis won't interpret them as a beginning of an nsis argument.
    let quote = arg.chars().any(|c| c == ' ' || c == '\t' || c == '/') || arg.is_empty();
    let escape = true;
    if quote {
        cmd.push('"');
    }
    let mut backslashes: usize = 0;
    for x in arg.chars() {
        if escape {
            if x == '\\' {
                backslashes += 1;
            } else {
                if x == '"' {
                    // Add n+1 backslashes to total 2n+1 before internal '"'.
                    cmd.extend((0..=backslashes).map(|_| '\\'));
                }
                backslashes = 0;
            }
        }
        cmd.push(x);
    }
    if quote {
        // Add n backslashes to total 2n before ending '"'.
        cmd.extend((0..backslashes).map(|_| '\\'));
        cmd.push('"');
    }
    cmd.into_iter().collect()
}

#[cfg(test)]
mod tests {
    use std::collections::hash_map::RandomState;
    use std::hash::{BuildHasher, Hasher};
    use std::io;
    use std::iter::once;
    use std::os::windows::ffi::{OsStrExt, OsStringExt};
    use std::slice;

    use windows_sys::Win32::Foundation::LocalFree;
    use windows_sys::Win32::UI::Shell::CommandLineToArgvW;

    use super::*;

    // 同版本插件 src/config.rs 的 nsis_args。
    const PASSIVE_MODE: &[&str] = &["/P", "/R"];
    const QUIET_MODE: &[&str] = &["/S", "/R"];
    const BASIC_UI_MODE: &[&str] = &[];

    fn os(args: &[&str]) -> Vec<OsString> {
        args.iter().map(OsString::from).collect()
    }

    /// 照插件 install_inner 的拼法：模式开关、/UPDATE、/ARGS、逐个转义的启动器参数，单个空格连接。
    fn plugin_parameters(mode: &[&str], current_args: &[OsString]) -> OsString {
        let escaped: Vec<String> = current_args
            .iter()
            .map(|arg| escape_nsis_current_exe_arg(arg))
            .collect();
        let parts: Vec<&OsStr> = mode
            .iter()
            .map(OsStr::new)
            .chain(once(OsStr::new("/UPDATE")))
            .chain(once(OsStr::new("/ARGS")))
            .chain(escaped.iter().map(OsStr::new))
            .collect();
        parts.join(OsStr::new(" "))
    }

    /// 按 Windows 规则拆命令行。std 的 args_os 不走 CommandLineToArgvW，用自己的拆分器（sys/args/windows.rs 的
    /// parse_lp_cmd_line，注释说后者不守新版 C/C++ 规则）。插件的转义给每个内部引号都垫了反斜杠，推测碰不到
    /// 两边有分歧的写法；std 那一侧另用子进程回显实测过两千组随机参数，都原样还原。
    fn split_command_line(line: &OsStr) -> Vec<OsString> {
        let wide: Vec<u16> = line.encode_wide().chain(once(0)).collect();
        let mut count = 0;
        // SAFETY: wide 以 NUL 结尾，count 是本地变量
        let argv = unsafe { CommandLineToArgvW(wide.as_ptr(), &mut count) };
        assert!(
            !argv.is_null(),
            "CommandLineToArgvW 失败：{}",
            io::Error::last_os_error()
        );
        let args = (0..usize::try_from(count).unwrap())
            .map(|index| {
                // SAFETY: argv 有 count 个元素，每个都是以 NUL 结尾的宽字符串，释放前一直有效
                unsafe {
                    let arg = *argv.add(index);
                    let len = (0..).take_while(|&at| *arg.add(at) != 0).count();
                    OsString::from_wide(slice::from_raw_parts(arg, len))
                }
            })
            .collect();
        // SAFETY: argv 是 CommandLineToArgvW 分配的整块内存，按文档用一次 LocalFree 释放，之后不再访问
        unsafe { LocalFree(argv.cast()) };
        args
    }

    /// 进程看到的命令行是带引号的程序路径再接参数（ShellExecuteW 的拼法属推测，argv[0] 反正跳过）。
    fn launched_with(parameters: &OsStr) -> Parsed {
        let mut line =
            OsString::from(r#""C:\Users\樱 花\AppData\Local\Temp\Petalfall_0.3.0_x64-setup.exe" "#);
        line.push(parameters);
        parse(split_command_line(&line).into_iter().skip(1))
    }

    fn update(relaunch: bool, launcher_args: &[&str]) -> Launch {
        Launch::Update(UpdateRequest {
            relaunch,
            launcher_args: os(launcher_args),
        })
    }

    fn random_below(bound: u64) -> u64 {
        RandomState::new().build_hasher().finish() % bound
    }

    fn random_arg() -> OsString {
        const ALPHABET: &[char] = &[
            'a', 'Z', '0', '-', '=', ':', '.', ' ', '\t', '"', '\\', '/', '樱',
        ];
        let len = random_below(9);
        (0..len)
            .map(|_| ALPHABET[random_below(ALPHABET.len() as u64) as usize])
            .collect::<String>()
            .into()
    }

    #[test]
    fn escapes_exactly_like_the_plugin_for_nsis() {
        // 插件 src/updater.rs 的 it_escapes_correctly_for_nsis，向量逐条照搬。
        let cases = [
            "something",
            "--flag",
            "--empty=",
            "--arg=value",
            "some space",
            "--arg value",
            "--arg=unwrapped space",
            "--arg=\"wrapped\"",
            "--arg=\"wrapped space\"",
            "--arg=midword\"wrapped space\"",
            "",
        ];
        let cases_escaped = [
            "something",
            "--flag",
            "--empty=",
            "--arg=value",
            "\"some space\"",
            "\"--arg value\"",
            "\"--arg=unwrapped space\"",
            "--arg=\\\"wrapped\\\"",
            "\"--arg=\\\"wrapped space\\\"\"",
            "\"--arg=midword\\\"wrapped space\\\"\"",
            "\"\"",
        ];
        assert_eq!(cases.len(), cases_escaped.len());
        for (orig, escaped) in cases.iter().zip(cases_escaped) {
            assert_eq!(escape_nsis_current_exe_arg(OsStr::new(orig)), escaped);
        }
    }

    #[test]
    fn escape_quotes_slashes_and_doubles_backslashes_before_quotes() {
        for (orig, escaped) in [
            ("/UPDATE", r#""/UPDATE""#),
            ("--dir=C:/a", r#""--dir=C:/a""#),
            (r"C:\dir\", r"C:\dir\"),
            (r"C:\a b\", r#""C:\a b\\""#),
            (r#"a\"b"#, r#"a\\\"b"#),
            ("tab\there", "\"tab\there\""),
        ] {
            assert_eq!(escape_nsis_current_exe_arg(OsStr::new(orig)), escaped);
        }
    }

    #[test]
    fn plugin_passive_launch_is_an_update_that_relaunches() {
        let current = os(&["--minimized", "some space"]);
        let parsed = launched_with(&plugin_parameters(PASSIVE_MODE, &current));
        assert_eq!(
            parsed,
            Parsed {
                launch: update(true, &["--minimized", "some space"]),
                ignored: Vec::new(),
            }
        );
    }

    #[test]
    fn plugin_quiet_launch_is_an_update_that_relaunches() {
        let current = os(&["--arg=\"wrapped space\""]);
        let parsed = launched_with(&plugin_parameters(QUIET_MODE, &current));
        assert_eq!(
            parsed,
            Parsed {
                launch: update(true, &["--arg=\"wrapped space\""]),
                ignored: Vec::new(),
            }
        );
    }

    #[test]
    fn plugin_basic_ui_launch_is_an_update_without_relaunch() {
        let parsed = launched_with(&plugin_parameters(BASIC_UI_MODE, &[]));
        assert_eq!(
            parsed,
            Parsed {
                launch: update(false, &[]),
                ignored: Vec::new(),
            }
        );
    }

    #[test]
    fn switches_and_separator_ignore_case() {
        assert_eq!(
            parse(os(&["/p", "/r", "/update", "/args", "--flag"])),
            Parsed {
                launch: update(true, &["--flag"]),
                ignored: Vec::new(),
            }
        );
        assert_eq!(
            parse(os(&["/s", "/Update", "/ArGs"])),
            Parsed {
                launch: update(false, &[]),
                ignored: Vec::new(),
            }
        );
    }

    #[test]
    fn no_arguments_is_interactive_with_nothing_ignored() {
        assert_eq!(
            parse(Vec::new()),
            Parsed {
                launch: Launch::Interactive,
                ignored: Vec::new(),
            }
        );
    }

    #[test]
    fn unknown_switches_before_the_separator_are_ignored_in_update_mode() {
        assert_eq!(
            parse(os(&[
                "/P", "/NCRC", "/R", r"/D=C:\x", "/UPDATE", "/ARGS", "--a"
            ])),
            Parsed {
                launch: update(true, &["--a"]),
                ignored: os(&["/NCRC", r"/D=C:\x"]),
            }
        );
    }

    #[test]
    fn without_update_every_argument_is_ignored() {
        assert_eq!(
            parse(os(&["/S", "/R", "/ARGS", "--a", "/UPDATE"])),
            Parsed {
                launch: Launch::Interactive,
                ignored: os(&["/S", "/R", "/ARGS", "--a", "/UPDATE"]),
            }
        );
        assert_eq!(
            parse(os(&["/P"])),
            Parsed {
                launch: Launch::Interactive,
                ignored: os(&["/P"]),
            }
        );
    }

    #[test]
    fn switches_after_the_separator_belong_to_the_launcher() {
        assert_eq!(
            parse(os(&[
                "/P", "/UPDATE", "/ARGS", "/UPDATE", "/ARGS", "/R", "/S"
            ])),
            Parsed {
                launch: update(false, &["/UPDATE", "/ARGS", "/R", "/S"]),
                ignored: Vec::new(),
            }
        );
    }

    #[test]
    fn update_without_separator_has_no_launcher_args() {
        assert_eq!(
            parse(os(&["/UPDATE", "/R"])),
            Parsed {
                launch: update(true, &[]),
                ignored: Vec::new(),
            }
        );
    }

    #[test]
    fn launcher_args_with_spaces_quotes_slashes_and_empty_strings_survive_the_plugin() {
        let tricky = [
            "some space",
            "--arg=\"wrapped space\"",
            "--arg=midword\"wrapped space\"",
            "",
            "/UPDATE",
            "/ARGS",
            "/r",
            r"C:\Users\a b\",
            r"C:\dir\",
            r#"a\"b"#,
            "tab\there",
            "樱 花",
        ];
        let current = os(&tricky);
        let parsed = launched_with(&plugin_parameters(PASSIVE_MODE, &current));
        assert_eq!(parsed.launch, update(true, &tricky));
        assert_eq!(parsed.ignored, Vec::<OsString>::new());
    }

    #[test]
    fn passive_arguments_match_the_plugin_byte_for_byte() {
        let current = os(&["--flag", "some space", "", "/UPDATE", r"C:\Users\a b\"]);
        let parsed = launched_with(&plugin_parameters(PASSIVE_MODE, &current));
        let request = parsed.launch.update().unwrap();
        assert_eq!(
            request.passive_arguments(),
            OsString::from(
                r#"/P /R /UPDATE /ARGS --flag "some space" "" "/UPDATE" "C:\Users\a b\\""#
            )
        );
        assert_eq!(
            request.passive_arguments(),
            plugin_parameters(PASSIVE_MODE, &current)
        );
    }

    #[test]
    fn passive_arguments_end_with_the_separator_when_there_are_no_launcher_args() {
        let relaunching = UpdateRequest {
            relaunch: true,
            launcher_args: Vec::new(),
        };
        assert_eq!(
            relaunching.passive_arguments(),
            OsString::from("/P /R /UPDATE /ARGS")
        );
        assert_eq!(
            relaunching.passive_arguments(),
            plugin_parameters(PASSIVE_MODE, &[])
        );
        let staying = UpdateRequest {
            relaunch: false,
            launcher_args: Vec::new(),
        };
        assert_eq!(
            staying.passive_arguments(),
            OsString::from("/P /UPDATE /ARGS")
        );
    }

    #[test]
    fn quiet_and_basic_ui_fall_back_to_passive_arguments() {
        let current = os(&["--arg value"]);
        let quiet = launched_with(&plugin_parameters(QUIET_MODE, &current));
        assert_eq!(
            quiet.launch.update().unwrap().passive_arguments(),
            OsString::from(r#"/P /R /UPDATE /ARGS "--arg value""#)
        );
        let basic = launched_with(&plugin_parameters(BASIC_UI_MODE, &current));
        assert_eq!(
            basic.launch.update().unwrap().passive_arguments(),
            OsString::from(r#"/P /UPDATE /ARGS "--arg value""#)
        );
    }

    #[test]
    fn launch_info_and_accessor_carry_the_request() {
        let relaunching = parse(os(&["/P", "/R", "/UPDATE", "/ARGS"]));
        assert_eq!(
            relaunching.launch.update().unwrap().launch_info(),
            UpdateLaunch { relaunch: true }
        );
        let staying = parse(os(&["/UPDATE", "/ARGS", "/R"]));
        assert_eq!(
            staying.launch.update().unwrap().launch_info(),
            UpdateLaunch { relaunch: false }
        );
        assert_eq!(Launch::Interactive.update(), None);
    }

    #[test]
    fn random_launcher_args_survive_the_plugin_and_the_fallback() {
        for _ in 0..300 {
            let current: Vec<OsString> = (0..random_below(6)).map(|_| random_arg()).collect();
            let parsed = launched_with(&plugin_parameters(PASSIVE_MODE, &current));
            assert_eq!(
                parsed.launch,
                Launch::Update(UpdateRequest {
                    relaunch: true,
                    launcher_args: current.clone(),
                }),
                "{current:?}"
            );
            assert_eq!(parsed.ignored, Vec::<OsString>::new(), "{current:?}");

            let request = parsed.launch.update().unwrap();
            let fallback = launched_with(&request.passive_arguments());
            assert_eq!(fallback.launch, parsed.launch, "{current:?}");
        }
    }
}
