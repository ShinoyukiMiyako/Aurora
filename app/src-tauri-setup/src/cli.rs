//! 引导程序的命令行：分清是启动器的更新插件拉起的还是用户自己打开的，拆出装完要带回启动器的参数。
//!
//! 插件（tauri-plugin-updater 2.12.0 src/updater.rs 的 `updater_parameters`）把下载到的 PE 一律当 NSIS 包拉起，
//! 参数是「模式开关 /UPDATE」，`restart_after_install` 为真（默认）时再接「重启开关 /ARGS 逐个转义的启动器参数」，
//! 为假时到 /UPDATE 为止。两组开关见同版本 src/config.rs：`nsis_args` 里 passive 是 `/P`，quiet 是 `/S`，basicUi
//! 不带；`nsis_restart_after_install_args` 里 passive、quiet 是 `/R`，basicUi 不带。还在用 2.10.1 的旧启动器拉起
//! 新引导程序时是「模式开关（passive、quiet 自带 /R）/UPDATE /ARGS 启动器参数」，所以 `/ARGS` 之前只认开关、不看顺序。
//! 转义按 Windows 标准规则来，std 拆 argv 就能还原，所以 `/ARGS` 之后的记号原样就是启动器的参数。
//!
//! 这有个前提：启动器只在换通道的那个检查器上配 `installer_args`（`/R`、`/CHANNELSWITCH`），并且那个检查器关掉了
//! `restart_after_install`。插件把 `installer_args` 原样接在整串最后：不重开时整串到 /UPDATE 为止，追加的开关紧跟
//! 其后，仍在 `/ARGS` 之前，拼出 `/P /UPDATE /R /CHANNELSWITCH`；重开时它们紧跟启动器参数，格式上分不出来，只会被
//! 当成启动器参数带回去，走原生回退时还会被转义成带引号的普通参数，NSIS 不再当开关认。
//!
//! `/CHANNELSWITCH` 表示启动器替用户发起了换到更慢通道的安装，引导程序据它放行装回较早版本的那一种，能从磁盘核实的
//! 条件照样每次重查。规则随发出去的包固定：不带值，只认 `/ARGS` 之前的，只在带 `/UPDATE` 时生效。没有 `/UPDATE`
//! 时和别的开关一样忽略：交互安装的同意只来自页面上的按钮，带开关的快捷方式绕不过页面。

use std::ffi::{OsStr, OsString};

use crate::contract::UpdateLaunch;

const PASSIVE: &str = "/P";
const SILENT: &str = "/S";
const RELAUNCH: &str = "/R";
const UPDATE: &str = "/UPDATE";
const ARGS: &str = "/ARGS";
const CHANNEL_SWITCH: &str = "/CHANNELSWITCH";

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

    /// 原生回退用：拼「/P[ /R] /UPDATE /ARGS <转义参数>」，整串给 raw_arg。开关和插件默认的 passive 带的一样，
    /// 顺序沿用 2.10.1：2.12.0 把 /R 挪到了 /UPDATE 之后，NSIS 模板用 GetOptions 在整条命令行里逐个找开关，不看顺序。
    /// 不带 `/CHANNELSWITCH`：NSIS 不认它，装回较早版本只由引导程序自己判定后放行。
    pub fn passive_arguments(&self) -> OsString {
        // 回退只为保住今天的行为：启动器没配 installMode，插件按默认的 passive 拉起，NSIS 包收到的就是这些开关和参数。
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
    /// `/ARGS` 之前带了 `/CHANNELSWITCH`：启动器为换到更慢的通道拉起。只在 `launch` 是更新模式时可能为真。
    pub channel_switch: bool,
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
            channel_switch: false,
        };
    }

    let relaunch = switches
        .iter()
        .any(|token| token.eq_ignore_ascii_case(RELAUNCH));
    // 整个记号相等才算：开关不带值，`/CHANNELSWITCH=…` 一类按不认得的开关忽略
    let channel_switch = switches
        .iter()
        .any(|token| token.eq_ignore_ascii_case(CHANNEL_SWITCH));
    let ignored = switches
        .into_iter()
        .filter(|token| {
            ![PASSIVE, SILENT, RELAUNCH, UPDATE, CHANNEL_SWITCH]
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
        channel_switch,
    }
}

// 照搬 tauri-plugin-updater 2.12.0 src/updater.rs 的 escape_nsis_current_exe_arg，原文又改编自 Rust std 的
// sys/args/windows.rs。只去掉了 `#[cfg(windows)]`（本 crate 只在 Windows 上编），函数体逐字保留，插件升级时好逐行比对。
// 2.10.1 是先 to_string_lossy 再按 char 走：要处理的字符全是 ASCII，合法 Unicode 下两版输出相同；未配对的代理项
// 旧版换成 U+FFFD，这一版按 UTF-16 码元原样保留，和插件一致，回退带回的参数才不走样。
fn escape_nsis_current_exe_arg(arg: impl AsRef<OsStr>) -> OsString {
    use std::os::windows::ffi::{OsStrExt, OsStringExt};

    let arg = arg.as_ref();
    let mut cmd: Vec<u16> = Vec::new();

    // compared to std we additionally escape `/` so that nsis won't interpret them as a beginning of an nsis argument.
    let quote = arg
        .as_encoded_bytes()
        .iter()
        .any(|c| *c == b' ' || *c == b'\t' || *c == b'/')
        || arg.is_empty();
    let escape = true;
    if quote {
        cmd.push('"' as u16);
    }
    let mut backslashes: usize = 0;
    for x in arg.encode_wide() {
        if escape {
            if x == '\\' as u16 {
                backslashes += 1;
            } else {
                if x == '"' as u16 {
                    // Add n+1 backslashes to total 2n+1 before internal '"'.
                    cmd.extend((0..=backslashes).map(|_| '\\' as u16));
                }
                backslashes = 0;
            }
        }
        cmd.push(x);
    }
    if quote {
        // Add n backslashes to total 2n before ending '"'.
        cmd.extend((0..backslashes).map(|_| '\\' as u16));
        cmd.push('"' as u16);
    }
    OsString::from_wide(&cmd)
}

#[cfg(test)]
mod tests {
    use std::io;
    use std::iter::once;
    use std::os::windows::ffi::{OsStrExt, OsStringExt};
    use std::slice;

    use windows_sys::Win32::Foundation::LocalFree;
    use windows_sys::Win32::UI::Shell::CommandLineToArgvW;

    use super::*;

    /// 同版本插件 src/config.rs 的两组开关：`nsis_args` 和装完要重开时再加的 `nsis_restart_after_install_args`。
    struct Mode {
        switches: &'static [&'static str],
        restart: &'static [&'static str],
    }

    const PASSIVE_MODE: Mode = Mode {
        switches: &["/P"],
        restart: &["/R"],
    };
    const QUIET_MODE: Mode = Mode {
        switches: &["/S"],
        restart: &["/R"],
    };
    const BASIC_UI_MODE: Mode = Mode {
        switches: &[],
        restart: &[],
    };

    fn os(args: &[&str]) -> Vec<OsString> {
        args.iter().map(OsString::from).collect()
    }

    /// 换通道的检查器追加的安装程序参数。
    const SWITCH_INSTALLER_ARGS: &[&str] = &["/R", "/CHANNELSWITCH"];

    /// 照插件 updater_parameters 的 NSIS 分支：模式开关、/UPDATE；`restart_after_install` 为真时再接重启开关、
    /// /ARGS、逐个转义的启动器参数；最后不论重开与否都接上检查器配的 `installer_args`，原样不转义。单个空格连接。
    fn plugin_parameters(
        mode: &Mode,
        restart_after_install: bool,
        current_args: &[OsString],
        installer_args: &[&str],
    ) -> OsString {
        let mut parts: Vec<OsString> = mode.switches.iter().map(OsString::from).collect();
        parts.push(OsString::from("/UPDATE"));
        if restart_after_install {
            parts.extend(mode.restart.iter().map(OsString::from));
            parts.push(OsString::from("/ARGS"));
            parts.extend(current_args.iter().map(escape_nsis_current_exe_arg));
        }
        parts.extend(installer_args.iter().map(OsString::from));
        parts.join(OsStr::new(" "))
    }

    /// 回退串与插件串比对用：`/ARGS` 之前的开关排好序，连同 `/ARGS` 起的尾巴一起返回。
    fn switches_and_tail(parameters: &OsStr) -> (Vec<&str>, &str) {
        let parameters = parameters.to_str().unwrap();
        let at = parameters.find(" /ARGS").unwrap();
        let mut switches: Vec<&str> = parameters[..at].split(' ').collect();
        switches.sort_unstable();
        (switches, &parameters[at..])
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

    fn parsed_as(launch: Launch, ignored: &[&str], channel_switch: bool) -> Parsed {
        Parsed {
            launch,
            ignored: os(ignored),
            channel_switch,
        }
    }

    /// 固定种子的 xorshift，失败时可复现。
    struct Rng(u64);

    impl Rng {
        fn below(&mut self, bound: u64) -> u64 {
            self.0 ^= self.0 << 13;
            self.0 ^= self.0 >> 7;
            self.0 ^= self.0 << 17;
            self.0 % bound
        }

        fn pick<T: Copy>(&mut self, items: &[T]) -> T {
            items[self.below(items.len() as u64) as usize]
        }

        fn arg(&mut self) -> OsString {
            // 和开关同名的记号落在 /ARGS 之后，要原样回到启动器手里
            const WHOLE: &[&str] = &[
                "/CHANNELSWITCH",
                "/channelswitch",
                "/UPDATE",
                "/ARGS",
                "/R",
                "",
            ];
            // 𠮷 在基本平面之外，UTF-16 下是一对代理项，转义按码元走时要整对原样过去。
            const ALPHABET: &[char] = &[
                'a', 'Z', '0', '-', '=', ':', '.', ' ', '\t', '"', '\\', '/', '樱', '𠮷',
            ];
            if self.below(4) == 0 {
                return self.pick(WHOLE).into();
            }
            let len = self.below(9);
            (0..len)
                .map(|_| self.pick(ALPHABET))
                .collect::<String>()
                .into()
        }
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
            ("𠮷", "𠮷"),
            ("𠮷 樱", "\"𠮷 樱\""),
            (r#"--name=𠮷\"樱"#, r#"--name=𠮷\\\"樱"#),
        ] {
            assert_eq!(escape_nsis_current_exe_arg(OsStr::new(orig)), escaped);
        }
    }

    #[test]
    fn plugin_passive_launch_is_an_update_that_relaunches() {
        let current = os(&["--minimized", "some space"]);
        let parsed = launched_with(&plugin_parameters(&PASSIVE_MODE, true, &current, &[]));
        assert_eq!(
            parsed,
            Parsed {
                launch: update(true, &["--minimized", "some space"]),
                ignored: Vec::new(),
                channel_switch: false,
            }
        );
    }

    #[test]
    fn plugin_quiet_launch_is_an_update_that_relaunches() {
        let current = os(&["--arg=\"wrapped space\""]);
        let parsed = launched_with(&plugin_parameters(&QUIET_MODE, true, &current, &[]));
        assert_eq!(
            parsed,
            Parsed {
                launch: update(true, &["--arg=\"wrapped space\""]),
                ignored: Vec::new(),
                channel_switch: false,
            }
        );
    }

    #[test]
    fn plugin_basic_ui_launch_is_an_update_without_relaunch() {
        let parsed = launched_with(&plugin_parameters(&BASIC_UI_MODE, true, &[], &[]));
        assert_eq!(
            parsed,
            Parsed {
                launch: update(false, &[]),
                ignored: Vec::new(),
                channel_switch: false,
            }
        );
    }

    #[test]
    fn relaunch_after_update_is_recognised_like_the_old_order() {
        let current = os(&["--minimized", "some space"]);
        let plugin = plugin_parameters(&PASSIVE_MODE, true, &current, &[]);
        assert_eq!(
            plugin,
            OsString::from(r#"/P /UPDATE /R /ARGS --minimized "some space""#)
        );
        let expected = Parsed {
            launch: update(true, &["--minimized", "some space"]),
            ignored: Vec::new(),
            channel_switch: false,
        };
        assert_eq!(launched_with(&plugin), expected);
        // 还在用 2.10.1 的启动器拉起新引导程序时，/R 在 /UPDATE 前面。
        assert_eq!(
            launched_with(OsStr::new(
                r#"/P /R /UPDATE /ARGS --minimized "some space""#
            )),
            expected
        );
    }

    #[test]
    fn plugin_without_restart_after_install_is_an_update_without_relaunch_or_args() {
        let current = os(&["--minimized", "some space"]);
        for (mode, expected) in [
            (&PASSIVE_MODE, "/P /UPDATE"),
            (&QUIET_MODE, "/S /UPDATE"),
            (&BASIC_UI_MODE, "/UPDATE"),
        ] {
            let plugin = plugin_parameters(mode, false, &current, &[]);
            assert_eq!(plugin, OsString::from(expected));
            let parsed = launched_with(&plugin);
            assert_eq!(
                parsed,
                Parsed {
                    launch: update(false, &[]),
                    ignored: Vec::new(),
                    channel_switch: false,
                },
                "{expected}"
            );
            assert_eq!(
                parsed.launch.update().unwrap().passive_arguments(),
                OsString::from("/P /UPDATE /ARGS"),
                "{expected}"
            );
        }
    }

    #[test]
    fn switches_and_separator_ignore_case() {
        assert_eq!(
            parse(os(&["/p", "/r", "/update", "/args", "--flag"])),
            Parsed {
                launch: update(true, &["--flag"]),
                ignored: Vec::new(),
                channel_switch: false,
            }
        );
        assert_eq!(
            parse(os(&["/s", "/Update", "/ArGs"])),
            Parsed {
                launch: update(false, &[]),
                ignored: Vec::new(),
                channel_switch: false,
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
                channel_switch: false,
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
                channel_switch: false,
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
                channel_switch: false,
            }
        );
        assert_eq!(
            parse(os(&["/P"])),
            Parsed {
                launch: Launch::Interactive,
                ignored: os(&["/P"]),
                channel_switch: false,
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
                channel_switch: false,
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
                channel_switch: false,
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
            r#"C:\𠮷 目录\"𠮷""#,
        ];
        let current = os(&tricky);
        let parsed = launched_with(&plugin_parameters(&PASSIVE_MODE, true, &current, &[]));
        assert_eq!(parsed.launch, update(true, &tricky));
        assert_eq!(parsed.ignored, Vec::<OsString>::new());
    }

    #[test]
    fn unpaired_surrogates_survive_the_plugin_and_the_fallback() {
        // Windows 的命令行和文件名都是不校验配对的 UTF-16，插件 2.12.0 按码元转义，原样交过来。
        let current = vec![
            OsString::from_wide(&[u16::from(b'a'), 0xD800, u16::from(b' '), 0xDC00]),
            OsString::from_wide(&[0xDFFF]),
        ];
        let parsed = launched_with(&plugin_parameters(&PASSIVE_MODE, true, &current, &[]));
        assert_eq!(
            parsed.launch,
            Launch::Update(UpdateRequest {
                relaunch: true,
                launcher_args: current.clone(),
            })
        );
        let fallback = launched_with(&parsed.launch.update().unwrap().passive_arguments());
        assert_eq!(fallback.launch, parsed.launch);
    }

    #[test]
    fn passive_arguments_differ_from_the_plugin_only_in_switch_order() {
        let current = os(&["--flag", "some space", "", "/UPDATE", r"C:\Users\a b\"]);
        let plugin = plugin_parameters(&PASSIVE_MODE, true, &current, &[]);
        assert_eq!(
            plugin,
            OsString::from(
                r#"/P /UPDATE /R /ARGS --flag "some space" "" "/UPDATE" "C:\Users\a b\\""#
            )
        );
        let parsed = launched_with(&plugin);
        let fallback = parsed.launch.update().unwrap().passive_arguments();
        assert_eq!(
            fallback,
            OsString::from(
                r#"/P /R /UPDATE /ARGS --flag "some space" "" "/UPDATE" "C:\Users\a b\\""#
            )
        );
        assert_eq!(switches_and_tail(&fallback), switches_and_tail(&plugin));
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
            switches_and_tail(&relaunching.passive_arguments()),
            switches_and_tail(&plugin_parameters(&PASSIVE_MODE, true, &[], &[]))
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
        let quiet = launched_with(&plugin_parameters(&QUIET_MODE, true, &current, &[]));
        assert_eq!(
            quiet.launch.update().unwrap().passive_arguments(),
            OsString::from(r#"/P /R /UPDATE /ARGS "--arg value""#)
        );
        let basic = launched_with(&plugin_parameters(&BASIC_UI_MODE, true, &current, &[]));
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
    fn the_plugin_line_for_a_channel_switch_relaunches_without_launcher_args() {
        let current = os(&["--minimized", "some space"]);
        for (mode, expected) in [
            (&PASSIVE_MODE, "/P /UPDATE /R /CHANNELSWITCH"),
            (&QUIET_MODE, "/S /UPDATE /R /CHANNELSWITCH"),
            (&BASIC_UI_MODE, "/UPDATE /R /CHANNELSWITCH"),
        ] {
            let plugin = plugin_parameters(mode, false, &current, SWITCH_INSTALLER_ARGS);
            assert_eq!(plugin, OsString::from(expected));
            let parsed = launched_with(&plugin);
            assert_eq!(
                parsed,
                parsed_as(update(true, &[]), &[], true),
                "{expected}"
            );
            // 原生回退不转发开关
            let fallback = parsed.launch.update().unwrap().passive_arguments();
            assert_eq!(
                fallback,
                OsString::from("/P /R /UPDATE /ARGS"),
                "{expected}"
            );
            assert_eq!(
                launched_with(&fallback),
                parsed_as(update(true, &[]), &[], false),
                "{expected}"
            );
        }
    }

    #[test]
    fn the_channel_switch_counts_in_any_case_anywhere_before_the_separator() {
        for line in [
            "/P /UPDATE /R /CHANNELSWITCH",
            "/CHANNELSWITCH /P /UPDATE /R",
            "/P /CHANNELSWITCH /R /UPDATE",
            "/p /update /r /channelswitch",
            "/P /UPDATE /R /ChannelSwitch /CHANNELSWITCH",
            "/P /UPDATE /R /CHANNELSWITCH /ARGS",
        ] {
            assert_eq!(
                launched_with(OsStr::new(line)),
                parsed_as(update(true, &[]), &[], true),
                "{line}"
            );
        }
        // 2.10.1 的旧顺序，带启动器参数时开关照样只看 /ARGS 之前
        assert_eq!(
            launched_with(OsStr::new("/P /R /CHANNELSWITCH /UPDATE /ARGS --a")),
            parsed_as(update(true, &["--a"]), &[], true)
        );
    }

    #[test]
    fn the_channel_switch_takes_no_value_and_must_match_as_a_whole() {
        for token in [
            "/CHANNELSWITCH=1",
            "/CHANNELSWITCH:beta",
            "/CHANNELSWITCHES",
            "/CHANNEL",
            "CHANNELSWITCH",
            "-CHANNELSWITCH",
            "/CHANNELSWITCH ",
            " /CHANNELSWITCH",
            // 只按 ASCII 不分大小写：长 s 与土耳其语无点 i 不算
            "/CHANNELſWITCH",
            "/CHANNELSWıTCH",
        ] {
            assert_eq!(
                parse(os(&["/P", "/UPDATE", "/R", token])),
                parsed_as(update(true, &[]), &[token], false),
                "{token:?}"
            );
        }
        // 后面跟着的记号不算它的值，按不认得的开关忽略
        assert_eq!(
            parse(os(&["/P", "/UPDATE", "/CHANNELSWITCH", "beta", "/R"])),
            parsed_as(update(true, &[]), &["beta"], true)
        );
    }

    #[test]
    fn a_channel_switch_after_the_separator_goes_back_to_the_launcher() {
        // 开着重开再追加参数，开关落在 /ARGS 之后，与启动器参数分不开，只能当启动器参数带回去
        let current = os(&["--minimized"]);
        let plugin = plugin_parameters(&PASSIVE_MODE, true, &current, SWITCH_INSTALLER_ARGS);
        assert_eq!(
            plugin,
            OsString::from("/P /UPDATE /R /ARGS --minimized /R /CHANNELSWITCH")
        );
        assert_eq!(
            launched_with(&plugin),
            parsed_as(
                update(true, &["--minimized", "/R", "/CHANNELSWITCH"]),
                &[],
                false
            )
        );
        assert_eq!(
            parse(os(&[
                "/P",
                "/UPDATE",
                "/ARGS",
                "/CHANNELSWITCH",
                "/channelswitch=1"
            ])),
            parsed_as(
                update(false, &["/CHANNELSWITCH", "/channelswitch=1"]),
                &[],
                false
            )
        );
        // 启动器自己带着这个参数时，插件转义、回退再转义，回来的仍是启动器参数
        let parsed = launched_with(&plugin_parameters(
            &PASSIVE_MODE,
            true,
            &os(&["/CHANNELSWITCH"]),
            &[],
        ));
        assert_eq!(
            parsed,
            parsed_as(update(true, &["/CHANNELSWITCH"]), &[], false)
        );
        let fallback = parsed.launch.update().unwrap().passive_arguments();
        assert_eq!(
            fallback,
            OsString::from(r#"/P /R /UPDATE /ARGS "/CHANNELSWITCH""#)
        );
        assert_eq!(launched_with(&fallback), parsed);
    }

    #[test]
    fn without_update_the_channel_switch_is_ignored_like_any_other_switch() {
        assert_eq!(
            launched_with(OsStr::new("/P /R /CHANNELSWITCH")),
            parsed_as(Launch::Interactive, &["/P", "/R", "/CHANNELSWITCH"], false)
        );
        for args in [
            &["/CHANNELSWITCH"][..],
            &["/channelswitch", "/ARGS", "/UPDATE"],
            &["/R", "/CHANNELSWITCH", "/ARGS", "--a", "/UPDATE"],
        ] {
            assert_eq!(
                parse(os(args)),
                parsed_as(Launch::Interactive, args, false),
                "{args:?}"
            );
        }
    }

    /// 检查器追加的参数，以及不重开时该解析出的结果。重开时它们落在 `/ARGS` 之后，一律是启动器参数。
    struct Appended {
        args: &'static [&'static str],
        relaunch: bool,
        channel_switch: bool,
        ignored: &'static [&'static str],
    }

    const APPENDED: [Appended; 5] = [
        Appended {
            args: &[],
            relaunch: false,
            channel_switch: false,
            ignored: &[],
        },
        Appended {
            args: SWITCH_INSTALLER_ARGS,
            relaunch: true,
            channel_switch: true,
            ignored: &[],
        },
        Appended {
            args: &["/CHANNELSWITCH"],
            relaunch: false,
            channel_switch: true,
            ignored: &[],
        },
        Appended {
            args: &["/channelswitch", "/r"],
            relaunch: true,
            channel_switch: true,
            ignored: &[],
        },
        Appended {
            args: &["/CHANNELSWITCH=1"],
            relaunch: false,
            channel_switch: false,
            ignored: &["/CHANNELSWITCH=1"],
        },
    ];

    /// 插件拼出的命令行经 CommandLineToArgvW 拆开再解析，结果与按插件拼法推出的一致；原生回退再走一遍，
    /// 启动器参数与重开不变，换通道开关不转发。
    fn assert_round_trip(
        mode: &Mode,
        restart_after_install: bool,
        current: &[OsString],
        appended: &Appended,
    ) {
        let line = plugin_parameters(mode, restart_after_install, current, appended.args);
        let parsed = launched_with(&line);
        let expected = if restart_after_install {
            let mut carried = current.to_vec();
            carried.extend(os(appended.args));
            Parsed {
                launch: Launch::Update(UpdateRequest {
                    relaunch: !mode.restart.is_empty(),
                    launcher_args: carried,
                }),
                ignored: Vec::new(),
                channel_switch: false,
            }
        } else {
            // 不重开时插件不带重启开关也不带 /ARGS，启动器参数根本不进命令行
            parsed_as(
                update(appended.relaunch, &[]),
                appended.ignored,
                appended.channel_switch,
            )
        };
        assert_eq!(parsed, expected, "{line:?}");

        let fallback = launched_with(&parsed.launch.update().unwrap().passive_arguments());
        assert_eq!(
            fallback,
            Parsed {
                launch: parsed.launch.clone(),
                ignored: Vec::new(),
                channel_switch: false,
            },
            "{line:?}"
        );
    }

    #[test]
    fn random_launcher_args_survive_the_plugin_and_the_fallback() {
        let modes = [&PASSIVE_MODE, &QUIET_MODE, &BASIC_UI_MODE];
        // 边界：没有启动器参数、只有一个空串、全是与开关同名的记号，每种组合都走一遍
        for current in [
            os(&[]),
            os(&[""]),
            os(&["/CHANNELSWITCH", "/channelswitch", "/UPDATE", "/ARGS", "/R"]),
        ] {
            for mode in modes {
                for restart_after_install in [false, true] {
                    for appended in &APPENDED {
                        assert_round_trip(mode, restart_after_install, &current, appended);
                    }
                }
            }
        }

        let mut rng = Rng(0x5EED_0C11);
        for _ in 0..300 {
            let current: Vec<OsString> = (0..rng.below(6)).map(|_| rng.arg()).collect();
            let mode = rng.pick(&modes);
            let restart_after_install = rng.below(2) == 1;
            let appended = &APPENDED[rng.below(APPENDED.len() as u64) as usize];
            assert_round_trip(mode, restart_after_install, &current, appended);
        }
    }
}
