//! 引导程序和已安装的启动器之间的两件事：安装前看它开着没有，装完替用户把它打开。
//!
//! 这里对别的进程只读：静默的 NSIS 会直接结束同名进程，下载和没保存的改动都会丢，所以开着就让用户自己关。
//! 打开进程只要查询权限，不要结束权限。

use std::ffi::OsString;
use std::io;
use std::mem::{size_of, zeroed};
use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
use std::path::Path;
use std::process::{Command, ExitStatus};
use std::thread;
use std::time::{Duration, Instant};

use windows_sys::Win32::Foundation::{
    ERROR_NO_MORE_FILES, HWND, INVALID_HANDLE_VALUE, LPARAM, TRUE,
};
use windows_sys::Win32::System::Diagnostics::ToolHelp::{
    CreateToolhelp32Snapshot, PROCESSENTRY32W, Process32FirstW, Process32NextW, TH32CS_SNAPPROCESS,
};
use windows_sys::Win32::UI::WindowsAndMessaging::{
    EnumWindows, GWL_EXSTYLE, GetWindowLongW, GetWindowThreadProcessId, IsWindowVisible,
    WS_EX_NOACTIVATE,
};
use windows_sys::core::BOOL;

use crate::boot::{self, Instance};
use crate::existing::APP_EXE;

/// 引导程序先关的话，桌面会空一段才等到启动器首帧；等太久又像卡住了，所以有上限。
pub const WINDOW_WAIT: Duration = Duration::from_secs(5);

const WINDOW_POLL: Duration = Duration::from_millis(100);

/// 打开启动器后等到的结果，只用来写日志：哪一种引导程序都该退出了。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Opened {
    WindowVisible,
    /// 进程先退了。再次启动的启动器把已有窗口叫到前台后就会这样，这本身不算失败。
    Exited(Option<i32>),
    TimedOut,
}

/// 当前用户有没有在运行启动器，不看它装在哪个目录：NSIS 就是这么判的，文件名也用同一个，别的目录的便携副本同样会被它结束。
pub fn is_running() -> io::Result<bool> {
    image_running(APP_EXE, &boot::current_user()?)
}

/// 打开 `dir` 下的启动器，`args` 逐个交给它，等它的窗口出现或等满 [`WINDOW_WAIT`]。会阻塞，不能放在 UI 线程上跑。
pub fn open(dir: &Path, args: &[OsString], instance: &Instance) -> io::Result<Opened> {
    launch(&mut launcher_command(dir, args), instance, WINDOW_WAIT)
}

fn launcher_command(dir: &Path, args: &[OsString]) -> Command {
    let mut command = Command::new(dir.join(APP_EXE));
    // 工作目录留在安装包所在的文件夹，这个文件夹就在启动器的整个运行期间删不掉
    command.current_dir(dir);
    // 这些是更新前启动器自己的参数，要逐个走 `args` 由 std 按 MSVC 规则加引号，启动器拆回来才和原来一模一样。
    // 载荷那边整串走 `raw_arg` 是迁就 NSIS 的 /D=，这里没有那层顾虑
    command.args(args);
    command
}

fn launch(command: &mut Command, instance: &Instance, timeout: Duration) -> io::Result<Opened> {
    // 启动器一开就是几个小时，继承了互斥事件的话，这期间再打开安装包只会默默退出
    let mut child = instance.without_inheritance(|| command.spawn())??;
    let pid = child.id();
    wait_for_window(
        timeout,
        WINDOW_POLL,
        || has_visible_window(pid),
        || child.try_wait(),
    )
}

fn wait_for_window(
    timeout: Duration,
    poll: Duration,
    mut has_window: impl FnMut() -> bool,
    mut exited: impl FnMut() -> io::Result<Option<ExitStatus>>,
) -> io::Result<Opened> {
    let deadline = Instant::now() + timeout;
    loop {
        if has_window() {
            return Ok(Opened::WindowVisible);
        }
        if let Some(status) = exited()? {
            return Ok(Opened::Exited(status.code()));
        }
        if Instant::now() >= deadline {
            return Ok(Opened::TimedOut);
        }
        thread::sleep(poll);
    }
}

/// 只认用户能激活的窗口：tao 的事件目标窗口一启动就带 `WS_VISIBLE`，它要靠这个收 `WM_PAINT`，屏幕上却看不见。
fn has_visible_window(pid: u32) -> bool {
    struct Search {
        pid: u32,
        found: bool,
    }

    unsafe extern "system" fn visit(window: HWND, state: LPARAM) -> BOOL {
        // SAFETY: state 是下面 EnumWindows 传进来的 Search 指针，枚举期间一直有效，也只有这个回调在用
        let search = unsafe { &mut *(state as *mut Search) };
        let mut owner = 0;
        // SAFETY: window 由系统枚举给出，owner 是本地变量
        unsafe { GetWindowThreadProcessId(window, &mut owner) };
        if owner != search.pid {
            return TRUE;
        }
        // SAFETY: 同上。窗口这时销毁了两个调用都只会返回 0
        let shown = unsafe { IsWindowVisible(window) } != 0
            && unsafe { GetWindowLongW(window, GWL_EXSTYLE) } as u32 & WS_EX_NOACTIVATE == 0;
        if shown {
            search.found = true;
            return 0;
        }
        TRUE
    }

    let mut search = Search { pid, found: false };
    // 回调返回 0 提前结束时 EnumWindows 也返回 0，这个返回值分不出成败，结果只看 found。
    // SAFETY: visit 符合 WNDENUMPROC 的约定，search 活到 EnumWindows 返回
    unsafe { EnumWindows(Some(visit), &raw mut search as LPARAM) };
    search.found
}

fn image_running(image: &str, user: &[u8]) -> io::Result<bool> {
    Ok(process_list()?
        .into_iter()
        .filter(|(_, name)| name.eq_ignore_ascii_case(image))
        .any(|(pid, _)| belongs_to(pid, user)))
}

/// 查不到属主就按不是当前用户的算：别的用户和提权的进程都查不到，刚退出的进程也一样，NSIS 同样跳过这些进程。
fn belongs_to(pid: u32, user: &[u8]) -> bool {
    boot::process_user(pid).is_ok_and(|owner| owner == user)
}

fn process_list() -> io::Result<Vec<(u32, String)>> {
    // SAFETY: 参数都是常量，失败时返回 INVALID_HANDLE_VALUE
    let raw = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) };
    if raw == INVALID_HANDLE_VALUE {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: raw 是刚创建的有效句柄，所有权交给 OwnedHandle
    let snapshot = unsafe { OwnedHandle::from_raw_handle(raw) };

    // SAFETY: PROCESSENTRY32W 全是整数字段，全零是合法值
    let mut entry: PROCESSENTRY32W = unsafe { zeroed() };
    entry.dwSize = size_of::<PROCESSENTRY32W>() as u32;

    let mut processes = Vec::new();
    // SAFETY: snapshot 有效，entry 的 dwSize 已填好
    let mut more = unsafe { Process32FirstW(snapshot.as_raw_handle(), &mut entry) };
    while more != 0 {
        processes.push((entry.th32ProcessID, image_name(&entry.szExeFile)));
        // SAFETY: 同上
        more = unsafe { Process32NextW(snapshot.as_raw_handle(), &mut entry) };
    }
    let err = io::Error::last_os_error();
    if err.raw_os_error() != Some(ERROR_NO_MORE_FILES as i32) {
        return Err(err);
    }
    Ok(processes)
}

fn image_name(raw: &[u16]) -> String {
    let end = raw.iter().position(|&unit| unit == 0).unwrap_or(raw.len());
    String::from_utf16_lossy(&raw[..end])
}

#[cfg(test)]
mod tests {
    use std::cell::Cell;
    use std::fs;
    use std::os::windows::ffi::OsStringExt;
    use std::os::windows::process::CommandExt;
    use std::process::Stdio;
    use std::ptr::{null, null_mut};

    use tempfile::TempDir;
    use windows_sys::Win32::Foundation::GetLastError;
    use windows_sys::Win32::System::Threading::{CREATE_NO_WINDOW, GetCurrentProcessId};
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        CreateWindowExW, DestroyWindow, WINDOW_EX_STYLE, WS_EX_LAYERED, WS_EX_TOOLWINDOW,
        WS_EX_TRANSPARENT, WS_POPUP, WS_VISIBLE,
    };

    use super::*;
    use crate::boot::{Claim, test_claim, test_claim_within};

    const DUMP_ENV: &str = "PETALFALL_TEST_DUMP_LAUNCHER_ARGS";

    fn instance(test: &str) -> Instance {
        match test_claim(&format!("launcher-{test}")) {
            Claim::First(instance) => instance,
            Claim::Forwarded => panic!("{test} 上不该已有实例"),
        }
    }

    fn wide(text: &str) -> Vec<u16> {
        text.encode_utf16().chain(std::iter::once(0)).collect()
    }

    /// 一个没有窗口的短命进程。命令行工具挂在测试的控制台上，CREATE_NO_WINDOW 让它连控制台窗口也不开。
    fn quiet_cmd(script: &str) -> Command {
        let mut command = Command::new("cmd");
        command
            .args(["/c", script])
            .creation_flags(CREATE_NO_WINDOW);
        command
    }

    #[test]
    fn image_name_stops_at_the_terminator() {
        let mut raw = [0u16; 260];
        for (slot, unit) in raw.iter_mut().zip("Petalfall.exe".encode_utf16()) {
            *slot = unit;
        }
        raw[20] = u16::from(b'x');
        assert_eq!(image_name(&raw), "Petalfall.exe");
    }

    #[test]
    fn image_name_keeps_a_full_buffer() {
        let raw = [u16::from(b'a'); 8];
        assert_eq!(image_name(&raw), "aaaaaaaa");
    }

    #[test]
    fn the_snapshot_lists_this_test_process_under_its_own_file_name() {
        let exe = std::env::current_exe().unwrap();
        let own = exe.file_name().unwrap().to_str().unwrap();
        // SAFETY: 无参数，永不失败
        let pid = unsafe { GetCurrentProcessId() };
        let listed = process_list().unwrap();
        assert!(
            listed.iter().any(|(id, name)| *id == pid && name == own),
            "{own} ({pid}) 不在进程列表里"
        );
    }

    #[test]
    fn a_process_counts_only_under_its_exact_file_name_and_owner() {
        let user = boot::current_user().unwrap();
        let exe = std::env::current_exe().unwrap();
        let own = exe.file_name().unwrap().to_str().unwrap().to_owned();

        assert!(image_running(&own, &user).unwrap());
        assert!(
            image_running(&own.to_uppercase(), &user).unwrap(),
            "文件名不分大小写，和 NSIS 一致"
        );
        assert!(
            !image_running(&format!("{own}.bak"), &user).unwrap(),
            "只认完整文件名"
        );
        assert!(
            !image_running(&format!("x{own}"), &user).unwrap(),
            "只认完整文件名"
        );

        let mut someone_else = user.clone();
        *someone_else.last_mut().unwrap() ^= 0xFF;
        assert!(
            !image_running(&own, &someone_else).unwrap(),
            "别的用户的进程不算"
        );
    }

    #[test]
    fn a_process_of_unknown_owner_is_not_ours() {
        let user = boot::current_user().unwrap();
        // 进程号都是 4 的倍数，这个值不会对应任何进程
        assert!(!belongs_to(1, &user));
    }

    fn popup(ex_style: WINDOW_EX_STYLE) -> HWND {
        let class = wide("STATIC");
        // SAFETY: 系统自带的窗口类，字符串活到调用返回，其余都是合法的空值
        let window = unsafe {
            CreateWindowExW(
                ex_style,
                class.as_ptr(),
                null(),
                WS_POPUP | WS_VISIBLE,
                0,
                0,
                1,
                1,
                null_mut(),
                null_mut(),
                null_mut(),
                null(),
            )
        };
        assert!(!window.is_null(), "建测试窗口失败：{}", unsafe {
            GetLastError()
        });
        window
    }

    fn destroy(window: HWND) {
        // SAFETY: window 是这个线程刚建的窗口
        assert_ne!(unsafe { DestroyWindow(window) }, 0);
    }

    /// 窗口是进程级的，这几步放在一个用例里，别的用例不建窗。
    #[test]
    fn only_a_window_the_user_can_see_counts() {
        // SAFETY: 无参数，永不失败
        let pid = unsafe { GetCurrentProcessId() };
        assert!(!has_visible_window(pid), "测试进程一开始没有窗口");

        // 与 tao 事件目标窗口相同的样式。算上它的话，启动器一启动就算窗口出现了，等待形同虚设
        let event_target =
            popup(WS_EX_NOACTIVATE | WS_EX_TRANSPARENT | WS_EX_LAYERED | WS_EX_TOOLWINDOW);
        assert!(!has_visible_window(pid));
        destroy(event_target);

        let window = popup(0);
        assert!(has_visible_window(pid));
        destroy(window);
        assert!(!has_visible_window(pid));
    }

    #[test]
    fn waiting_ends_as_soon_as_the_window_shows() {
        let polls = Cell::new(0);
        let opened = wait_for_window(
            Duration::from_secs(30),
            Duration::from_millis(1),
            || {
                polls.set(polls.get() + 1);
                polls.get() == 3
            },
            || Ok(None),
        )
        .unwrap();
        assert_eq!(opened, Opened::WindowVisible);
        assert_eq!(polls.get(), 3);
    }

    #[test]
    fn a_window_beats_an_exit_seen_in_the_same_poll() {
        let opened = wait_for_window(
            Duration::from_secs(30),
            Duration::from_millis(1),
            || true,
            || panic!("窗口已经出现，不用再看进程"),
        )
        .unwrap();
        assert_eq!(opened, Opened::WindowVisible);
    }

    #[test]
    fn waiting_gives_up_at_the_deadline_without_a_window() {
        let started = Instant::now();
        let opened = wait_for_window(
            Duration::from_millis(40),
            Duration::from_millis(5),
            || false,
            || Ok(None),
        )
        .unwrap();
        assert_eq!(opened, Opened::TimedOut);
        assert!(started.elapsed() >= Duration::from_millis(40));
        assert!(started.elapsed() < Duration::from_secs(5));
    }

    #[test]
    fn the_deadline_is_five_seconds() {
        assert_eq!(WINDOW_WAIT, Duration::from_secs(5));
    }

    #[test]
    fn a_process_that_exits_ends_the_wait_with_its_code() {
        let instance = instance("exit");
        let opened = launch(&mut quiet_cmd("exit 3"), &instance, Duration::from_secs(30)).unwrap();
        assert_eq!(opened, Opened::Exited(Some(3)));
    }

    /// 启动器开几个小时，它要是继承了事件，这期间再打开安装包只会默默退出。
    #[test]
    fn the_launcher_does_not_inherit_the_claim() {
        let name = "launcher-no-inherit";
        let holder = instance("no-inherit");
        // 比下面的等待活得久：名字空出来时它一定还在跑，这样才说明它没有占着名字
        let mut lingering = Command::new("ping");
        lingering
            .args(["-n", "6", "127.0.0.1"])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .creation_flags(CREATE_NO_WINDOW);

        let opened = launch(&mut lingering, &holder, Duration::from_millis(1)).unwrap();
        assert_eq!(opened, Opened::TimedOut);
        drop(holder);

        assert!(
            test_claim_within(name, Duration::from_secs(2)).is_some(),
            "启动器还在跑，名字不能被它占着"
        );
    }

    #[test]
    fn the_launcher_starts_from_its_own_folder() {
        let dir = Path::new(r"D:\游戏 目录\Petalfall");
        let command = launcher_command(dir, &[]);
        assert_eq!(
            command.get_program(),
            r"D:\游戏 目录\Petalfall\Petalfall.exe"
        );
        assert_eq!(command.get_current_dir(), Some(dir));
        assert_eq!(command.get_args().count(), 0, "没有参数时什么也不添");
    }

    /// 更新前启动器可能带着的参数：带空格、引号、末尾反斜杠、空串的都有，还有一个拼不成 UTF-8 的孤立代理项，
    /// 转成字符串再转回来就会变样。
    fn awkward_args() -> Vec<OsString> {
        vec![
            OsString::from("--flag"),
            OsString::from(r#"say "hi there"\"#),
            OsString::from(r"C:\游戏 目录\"),
            OsString::new(),
            OsString::from("petalfall://open?a=1&b=2"),
            OsString::from_wide(&[0x0061, 0xD800, 0x0062]),
        ]
    }

    #[test]
    fn each_argument_reaches_the_launcher_unchanged() {
        let args = awkward_args();

        let command = launcher_command(Path::new(r"D:\Petalfall"), &args);

        assert_eq!(
            command.get_args().collect::<Vec<_>>(),
            args.iter().map(OsString::as_os_str).collect::<Vec<_>>()
        );
    }

    /// 不是用例，是下面那条测试拉起的子进程：把自己收到的参数写出来。
    #[test]
    fn relaunched_child_dumps_its_args() {
        if let Some(path) = std::env::var_os(DUMP_ENV) {
            let args: Vec<OsString> = std::env::args_os().skip(1).collect();
            fs::write(path, format!("{args:?}")).unwrap();
        }
    }

    /// `get_args` 分不出 `arg` 和 `raw_arg`，只有真起一个进程、让它按系统规则拆一遍命令行，才看得出引号加得对不对。
    #[test]
    fn a_real_child_splits_the_command_line_back_into_the_same_arguments() {
        let dir = TempDir::new().unwrap();
        // 程序名写死成 Petalfall.exe，拿测试程序的副本顶替：它认得下面这个用例名，只把参数写出来
        fs::copy(std::env::current_exe().unwrap(), dir.path().join(APP_EXE)).unwrap();
        let dump = dir.path().join("args.txt");
        // 子进程是测试程序，参数也会被当成用例名过滤：不以 - 开头才不会被当成它的选项，孤立代理项会让它直接崩掉，这两种留给上一条
        let args: Vec<OsString> = awkward_args()
            .into_iter()
            .filter(|arg| arg.to_str().is_some_and(|text| !text.starts_with('-')))
            .collect();
        assert_eq!(args.len(), 4, "引号、末尾反斜杠和空串这几种都要在");
        let filter = [
            "--exact",
            "launcher::tests::relaunched_child_dumps_its_args",
        ];

        let status = launcher_command(dir.path(), &args)
            .args(filter)
            .env(DUMP_ENV, &dump)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .creation_flags(CREATE_NO_WINDOW)
            .status()
            .unwrap();

        assert!(status.success());
        let mut expected = args;
        expected.extend(filter.map(OsString::from));
        assert_eq!(fs::read_to_string(dump).unwrap(), format!("{expected:?}"));
    }

    #[test]
    fn a_folder_without_the_launcher_reports_the_failure() {
        let dir = TempDir::new().unwrap();
        let instance = instance("missing");
        let err = open(dir.path(), &[], &instance).unwrap_err();
        assert_eq!(err.kind(), io::ErrorKind::NotFound);
    }

    #[test]
    fn a_failed_start_still_leaves_the_event_inheritable() {
        let dir = TempDir::new().unwrap();
        let instance = instance("restore");
        open(dir.path(), &[], &instance).unwrap_err();
        assert!(instance.is_inheritable().unwrap());
    }
}
