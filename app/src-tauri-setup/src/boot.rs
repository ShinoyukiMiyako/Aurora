//! 开窗之前的几道关和开窗之后的兜底：WebView2 够不够新、是不是唯一的实例、是不是桌面用户本人在运行；
//! 窗口建好了前端却没动静时由这里显示出来。
//!
//! 过不了 WebView2 这关就退回 NSIS 原生向导，这不是错误处理的末路：WebView2 本来就是载荷自己装的，
//! 向导不依赖它，能陪用户走完全程。

use std::fmt::Display;
use std::fs;
use std::io;
use std::iter::once;
use std::mem::size_of;
use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle, RawHandle};
use std::path::Path;
use std::ptr::null_mut;
use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant};

use petalfall_release::data_format::TrustedWrittenBy;
use petalfall_release::install_policy::DataBlock;
use petalfall_release::order::Channel;
use tauri::{Runtime, WebviewWindow};
use windows_sys::Win32::Foundation::{
    ERROR_ALREADY_EXISTS, FALSE, GetLastError, HANDLE_FLAG_INHERIT, SetHandleInformation, TRUE,
    WAIT_OBJECT_0,
};
use windows_sys::Win32::Globalization::GetUserDefaultUILanguage;
use windows_sys::Win32::Security::{
    GetLengthSid, GetTokenInformation, SECURITY_ATTRIBUTES, TOKEN_ELEVATION, TOKEN_QUERY,
    TOKEN_USER, TokenElevation, TokenUser,
};
use windows_sys::Win32::System::Threading::{
    CreateEventW, GetCurrentProcess, INFINITE, OpenProcess, OpenProcessToken,
    PROCESS_QUERY_LIMITED_INFORMATION, SetEvent, WaitForSingleObject,
};
use windows_sys::Win32::UI::WindowsAndMessaging::{
    GetShellWindow, GetWindowThreadProcessId, MB_ICONERROR, MB_ICONWARNING, MB_OK,
    MESSAGEBOX_STYLE, MessageBoxW,
};

use crate::log::SetupLog;

/// 主窗口的 label，与 tauri.conf.json、能力文件一致。
pub const MAIN_WINDOW: &str = "main";

/// 样式依赖 `color-mix`，低于这个 Chromium 主版本页面会彻底失效。
pub const MIN_WEBVIEW_MAJOR: u32 = 111;

/// 窗口创建后超过这个时长仍不可见，就由后端强制显示，让前端的错误页至少能被看见。
pub const SHOW_FALLBACK: Duration = Duration::from_secs(3);

/// 用 `Local` 命名空间：别的登录会话是另一个用户，HKCU 和安装目录都是他自己的。
const INSTANCE_EVENT: &str = r"Local\Petalfall-Setup";

const WEBVIEW_DATA_CLEANUP: Duration = Duration::from_secs(5);
const CLEANUP_POLL: Duration = Duration::from_millis(100);

const SIMPLIFIED_AND_TRADITIONAL_CHINESE: u16 = 0x04;
const PRIMARY_LANGUAGE_MASK: u16 = 0x03FF;

/// 够放下 TOKEN_USER 和最长的 SID（68 字节）。缓冲区按 8 字节对齐，TOKEN_USER 里有指针。
const TOKEN_USER_BUFFER_WORDS: usize = 16;

/// WebView2 运行时能不能画樱花窗口。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Webview {
    Usable { version: String },
    Unavailable { reason: String },
}

impl Webview {
    /// `detected` 是 `tauri::webview_version()` 的返回值。微软文档对「未安装」写了好几种形态：
    /// 报错、空串、`0.0.0.0`，这里都落到不可用；解析不出版本号的也不赌它够新。
    pub fn judge<E: Display>(detected: Result<String, E>) -> Self {
        let version = match detected {
            Ok(version) => version,
            Err(err) => {
                return Self::Unavailable {
                    reason: format!("探测失败：{err}"),
                };
            }
        };
        match chromium_major(&version) {
            Some(major) if major >= MIN_WEBVIEW_MAJOR => Self::Usable { version },
            Some(_) => Self::Unavailable {
                reason: format!("版本 {version} 低于 {MIN_WEBVIEW_MAJOR}"),
            },
            None => Self::Unavailable {
                reason: format!("读不出版本号：{version:?}"),
            },
        }
    }
}

/// 预览通道的版本串带后缀（`120.0.2210.91 canary`），主版本在第一段，后缀不影响。
fn chromium_major(version: &str) -> Option<u32> {
    version.trim().split('.').next()?.parse().ok()
}

/// 这次启动在互斥事件上的结果。
#[derive(Debug)]
pub enum Claim {
    First(Instance),
    /// 已有实例在运行，这个进程该退出了。叫得动的话，它已经在把窗口拿到前台。
    Forwarded,
}

/// 占着 `Local\Petalfall-Setup` 的事件。
///
/// 两个 NSIS 同写一个文件时会互相跳过，静默模式下谁也不报错，所以要互斥。句柄建成可继承，随 payload 传下去：
/// 引导程序崩溃或被结束时，只要 payload 还在写文件，这个名字就还在。
#[derive(Debug)]
pub struct Instance {
    event: OwnedHandle,
}

impl Instance {
    /// 在独立线程上等后来者，每来一次调用一次 `on_request`。事件自动复位，开始监听之前的那次唤醒留到这时生效。
    pub fn listen(
        self: Arc<Self>,
        log: Arc<SetupLog>,
        on_request: impl Fn() + Send + 'static,
    ) -> io::Result<()> {
        thread::Builder::new()
            .name("single-instance".to_owned())
            .spawn(move || {
                loop {
                    // SAFETY: event 由 self 持有，这个线程结束前不会关闭
                    let woken =
                        unsafe { WaitForSingleObject(self.event.as_raw_handle(), INFINITE) };
                    if woken != WAIT_OBJECT_0 {
                        log.error(format_args!(
                            "等后来者的事件失效（{woken}），之后再次启动不会把窗口叫到前台"
                        ));
                        return;
                    }
                    on_request();
                }
            })?;
        Ok(())
    }

    /// `spawn` 期间不让子进程继承事件。std 的 `Command` 总是继承所有可继承句柄，子进程活多久，这个名字就占多久，
    /// 所以寿命比安装长的子进程都要从这里启动。
    pub fn without_inheritance<T>(&self, spawn: impl FnOnce() -> T) -> io::Result<T> {
        self.set_inheritable(false)?;
        let spawned = spawn();
        self.set_inheritable(true)?;
        Ok(spawned)
    }

    fn set_inheritable(&self, inheritable: bool) -> io::Result<()> {
        let flags = if inheritable { HANDLE_FLAG_INHERIT } else { 0 };
        // SAFETY: event 是本结构持有的有效句柄
        let done =
            unsafe { SetHandleInformation(self.event.as_raw_handle(), HANDLE_FLAG_INHERIT, flags) };
        if done == 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(())
    }

    #[cfg(test)]
    pub(crate) fn is_inheritable(&self) -> io::Result<bool> {
        use windows_sys::Win32::Foundation::GetHandleInformation;

        let mut flags = 0;
        // SAFETY: event 是本结构持有的有效句柄，flags 是本地变量
        if unsafe { GetHandleInformation(self.event.as_raw_handle(), &mut flags) } == 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(flags & HANDLE_FLAG_INHERIT != 0)
    }
}

pub fn claim() -> io::Result<Claim> {
    claim_name(INSTANCE_EVENT)
}

fn claim_name(name: &str) -> io::Result<Claim> {
    let name = wide(name);
    let attributes = SECURITY_ATTRIBUTES {
        nLength: size_of::<SECURITY_ATTRIBUTES>() as u32,
        lpSecurityDescriptor: null_mut(),
        bInheritHandle: TRUE,
    };
    // SAFETY: attributes 和 name 在调用期间有效
    let raw = unsafe { CreateEventW(&attributes, FALSE, FALSE, name.as_ptr()) };
    if raw.is_null() {
        let err = io::Error::last_os_error();
        // 先来的实例提权运行时，事件的默认权限不许普通进程打开。名字已被占用这一点是确定的，只是叫不动它
        if err.kind() == io::ErrorKind::PermissionDenied {
            return Ok(Claim::Forwarded);
        }
        return Err(err);
    }
    // SAFETY: 读当前线程的错误码。CreateEventW 成功时也用它区分「新建」与「已存在」
    let existed = unsafe { GetLastError() } == ERROR_ALREADY_EXISTS;
    // SAFETY: raw 是刚拿到的有效句柄，所有权交给 OwnedHandle
    let event = unsafe { OwnedHandle::from_raw_handle(raw) };
    if !existed {
        return Ok(Claim::First(Instance { event }));
    }
    // SAFETY: event 是上面拿到的有效句柄
    if unsafe { SetEvent(event.as_raw_handle()) } == 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(Claim::Forwarded)
}

/// 这个进程的令牌用户和桌面 shell 的用户是什么关系。
#[derive(Debug, PartialEq, Eq)]
pub enum DesktopUser {
    Same,
    /// 别的账户凭据提升出来的：HKCU、`%LOCALAPPDATA%`、桌面都是那个账户的，装完当前用户完全看不到。
    Other,
    /// 比不出来，比如这台机器没有 shell 窗口。没有证据说明账户不对，不能拦住安装。
    Unknown(String),
}

pub fn desktop_user() -> io::Result<DesktopUser> {
    Ok(compare_users(&current_user()?, shell_user()))
}

fn compare_users(own: &[u8], shell: io::Result<Vec<u8>>) -> DesktopUser {
    match shell {
        Ok(shell) if shell == own => DesktopUser::Same,
        Ok(_) => DesktopUser::Other,
        // 用户总打得开自己的 shell，打不开说明它属于别人
        Err(err) if err.kind() == io::ErrorKind::PermissionDenied => DesktopUser::Other,
        Err(err) => DesktopUser::Unknown(err.to_string()),
    }
}

fn shell_user() -> io::Result<Vec<u8>> {
    // SAFETY: 无参数，没有 shell 时返回空
    let shell = unsafe { GetShellWindow() };
    if shell.is_null() {
        return Err(io::Error::new(
            io::ErrorKind::NotFound,
            "这台机器没有 shell 窗口",
        ));
    }
    let mut pid = 0;
    // SAFETY: shell 是刚取到的窗口句柄，pid 是本地变量。窗口这时销毁了 pid 就留在 0
    unsafe { GetWindowThreadProcessId(shell, &mut pid) };
    if pid == 0 {
        return Err(io::Error::last_os_error());
    }
    process_user(pid)
}

pub(crate) fn current_user() -> io::Result<Vec<u8>> {
    // SAFETY: 无参数，返回的伪句柄不需要关闭
    token_user(unsafe { GetCurrentProcess() })
}

/// 进程令牌用户的 SID 字节。SID 的二进制形式是规范的，按字节比较就是比较账户。
pub(crate) fn process_user(pid: u32) -> io::Result<Vec<u8>> {
    // SAFETY: 只申请查询权限，失败时返回空
    let raw = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid) };
    if raw.is_null() {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: raw 是刚拿到的有效句柄，所有权交给 OwnedHandle
    let process = unsafe { OwnedHandle::from_raw_handle(raw) };
    token_user(process.as_raw_handle())
}

fn token_user(process: RawHandle) -> io::Result<Vec<u8>> {
    let token = open_token(process)?;
    let mut buffer = [0u64; TOKEN_USER_BUFFER_WORDS];
    let mut written = 0;
    // SAFETY: token 有效，buffer 的长度如实传入，written 是本地变量
    let done = unsafe {
        GetTokenInformation(
            token.as_raw_handle(),
            TokenUser,
            buffer.as_mut_ptr().cast(),
            size_of_val(&buffer) as u32,
            &mut written,
        )
    };
    if done == 0 {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: 调用成功时 buffer 开头是 TOKEN_USER，8 字节对齐满足它的对齐要求
    let sid = unsafe { (*buffer.as_ptr().cast::<TOKEN_USER>()).User.Sid };
    // SAFETY: sid 指向 buffer 里的合法 SID，长度由系统给出
    let bytes = unsafe { std::slice::from_raw_parts(sid.cast::<u8>(), GetLengthSid(sid) as usize) };
    Ok(bytes.to_vec())
}

fn open_token(process: RawHandle) -> io::Result<OwnedHandle> {
    let mut token = null_mut();
    // SAFETY: process 由调用方保证有效，token 是本地变量
    if unsafe { OpenProcessToken(process, TOKEN_QUERY, &mut token) } == 0 {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: 调用成功时 token 是有效句柄，所有权交给 OwnedHandle
    Ok(unsafe { OwnedHandle::from_raw_handle(token) })
}

/// 这个进程是否提权运行。提权时打开启动器会让便携探针通过受保护的目录，形成第二个数据根。
pub fn is_elevated() -> io::Result<bool> {
    // SAFETY: 无参数，返回的伪句柄不需要关闭
    let token = open_token(unsafe { GetCurrentProcess() })?;
    let mut elevation = TOKEN_ELEVATION::default();
    let mut written = 0;
    // SAFETY: token 有效，elevation 的长度如实传入，written 是本地变量
    let done = unsafe {
        GetTokenInformation(
            token.as_raw_handle(),
            TokenElevation,
            (&raw mut elevation).cast(),
            size_of::<TOKEN_ELEVATION>() as u32,
            &mut written,
        )
    };
    if done == 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(elevation.TokenIsElevated != 0)
}

/// 已装的比安装包新时，这个安装包为什么装不上去。更快、更慢两种的说明要写出两边的通道。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Older {
    /// 同一个通道上更早的包。
    SameChannel,
    /// 比已装的通道更快的通道上更早的包。
    FasterChannel {
        installed: Channel,
        payload: Channel,
    },
    /// 更慢通道上更早的包，却由不带换通道开关的自动更新拉起。
    SlowerChannel {
        installed: Channel,
        payload: Channel,
    },
    /// 任一侧的通道认不出。
    UnknownChannel,
}

/// 开窗之前要告诉用户的话。这时没有樱花界面，只有系统消息框。
///
/// 后三种是窗口起不来、要直接交给 NSIS 时判定不让装的情形：NSIS 自己不拦装回较早的版本，也不读数据格式记号。
/// `reopens` 为真时，用户关掉提示后会按原参数重开启动器（更新模式下启动器是为这次安装关掉的）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Notice {
    ForeignUser,
    IncompletePackage,
    StartFailed(String),
    /// 装回较早的版本只走窗口里的那条安装流程，那里有复核、半装记录与事后核验，窗口却起不来。
    NeedsWindow {
        reopens: bool,
    },
    /// 已装的比这个安装包新，又不是能装回去的那一种。
    Newer {
        older: Older,
        installed: String,
        payload: String,
        reopens: bool,
    },
    /// 数据被更新的版本用过，或者数据格式记号读不懂。`stamp` 是定下结论的那个记号文件。
    DataBlocked {
        block: DataBlock,
        stamp: String,
        payload: String,
        reopens: bool,
    },
}

impl Notice {
    fn text(&self, chinese: bool) -> String {
        match (self, chinese) {
            (Notice::ForeignUser, true) => "安装程序正以另一个账户运行，装完当前账户看不到落樱。关掉这里，直接双击安装包重新打开，不要选管理员身份。".to_owned(),
            (Notice::ForeignUser, false) => "Setup is running under a different account, so Petalfall would be installed for that account, not yours. Close this and open the installer again without running it as administrator.".to_owned(),
            (Notice::IncompletePackage, true) => "安装包不完整，多半是下载被截断了。重新下载一次再打开。".to_owned(),
            (Notice::IncompletePackage, false) => "This installer is incomplete, most likely a cut-off download. Download it again and reopen it.".to_owned(),
            (Notice::StartFailed(detail), true) => format!("安装程序没能继续。重新打开试试，反馈问题时带上下面这段原文。\n\n{detail}"),
            (Notice::StartFailed(detail), false) => format!("Setup can't continue. Try opening it again, and include the text below if you report the problem.\n\n{detail}"),
            (Notice::NeedsWindow { reopens }, true) => reopening("这次安装要用到安装程序的窗口，但这台电脑上的 WebView2 用不了。先装好或修复 WebView2，再运行这个安装包。".to_owned(), *reopens, true),
            (Notice::NeedsWindow { reopens }, false) => reopening("This install needs the setup window, but WebView2 isn't working on this PC. Install or repair WebView2, then run this installer again.".to_owned(), *reopens, false),
            (
                Notice::Newer {
                    older,
                    installed,
                    payload,
                    reopens,
                },
                chinese,
            ) => reopening(newer_text(*older, installed, payload, chinese), *reopens, chinese),
            (
                Notice::DataBlocked {
                    block,
                    stamp,
                    payload,
                    reopens,
                },
                chinese,
            ) => reopening(blocked_text(block, stamp, payload, chinese), *reopens, chinese),
        }
    }

    fn style(&self) -> MESSAGEBOX_STYLE {
        match self {
            Notice::ForeignUser
            | Notice::NeedsWindow { .. }
            | Notice::Newer { .. }
            | Notice::DataBlocked { .. } => MB_OK | MB_ICONWARNING,
            Notice::IncompletePackage | Notice::StartFailed(_) => MB_OK | MB_ICONERROR,
        }
    }
}

/// 引导程序文案里的通道名，与安装界面那一份相同。
fn channel_name(channel: Channel, chinese: bool) -> &'static str {
    match (channel, chinese) {
        (Channel::Dev, true) => "预览版",
        (Channel::Beta, true) => "测试版",
        (Channel::Stable, true) => "正式版",
        (Channel::Dev, false) => "Preview",
        (Channel::Beta, false) => "Beta",
        (Channel::Stable, false) => "Stable",
    }
}

/// 更新模式下用户关掉提示后会重开启动器，提示里先说一声，免得以为桌面上什么都没了。
fn reopening(text: String, reopens: bool, chinese: bool) -> String {
    if !reopens {
        return text;
    }
    let tail = if chinese {
        "关掉这个提示后会重新打开落樱。"
    } else {
        "Petalfall will reopen after you close this message."
    };
    format!("{text}\n\n{tail}")
}

/// 同安装界面已安装页 newer 的四种说明。
fn newer_text(older: Older, installed: &str, payload: &str, chinese: bool) -> String {
    match (older, chinese) {
        (Older::SameChannel, true) => {
            format!("已安装 {installed}，这个安装包是 {payload}，版本更早，不能往回装。")
        }
        (Older::SameChannel, false) => format!(
            "{installed} is installed and this installer is the earlier {payload}, so it can't go back."
        ),
        (
            Older::SlowerChannel {
                installed: ci,
                payload: cp,
            },
            true,
        ) => {
            let (ci, cp) = (channel_name(ci, true), channel_name(cp, true));
            format!(
                "已安装{ci} {installed}，这个安装包是版本更早的{cp} {payload}。自动更新不会这样换过去，所以没有安装。要换到{cp}，直接运行{cp}的安装包。"
            )
        }
        (
            Older::SlowerChannel {
                installed: ci,
                payload: cp,
            },
            false,
        ) => {
            let (ci, cp) = (channel_name(ci, false), channel_name(cp, false));
            format!(
                "{ci} {installed} is installed and this installer is the earlier {cp} {payload}. Automatic updates don't switch channels this way, so nothing was installed. To move to {cp}, run a {cp} installer directly."
            )
        }
        (
            Older::FasterChannel {
                installed: ci,
                payload: cp,
            },
            true,
        ) => {
            let (ci, cp) = (channel_name(ci, true), channel_name(cp, true));
            format!(
                "已安装{ci} {installed}，这个安装包是{cp} {payload}，版本更早，不能这样换过去。要换到{cp}，在落樱的「设置 · 关于」里把更新通道选成{cp}，{cp}出了比 {installed} 新的版本就会装上。"
            )
        }
        (
            Older::FasterChannel {
                installed: ci,
                payload: cp,
            },
            false,
        ) => {
            let (ci, cp) = (channel_name(ci, false), channel_name(cp, false));
            format!(
                "{ci} {installed} is installed and this installer is the earlier {cp} {payload}, so it can't switch this way. To move to {cp}, choose {cp} as the update channel in Petalfall's Settings, About; it installs once {cp} has a version newer than {installed}."
            )
        }
        (Older::UnknownChannel, true) => {
            format!("已安装 {installed}，这个安装包是 {payload}，不能往回装。")
        }
        (Older::UnknownChannel, false) => {
            format!(
                "{installed} is installed and this installer is {payload}, so it can't go back."
            )
        }
    }
}

/// 同安装界面已安装页数据拦截与读不懂的标题，空一行接说明。
fn blocked_text(block: &DataBlock, stamp: &str, payload: &str, chinese: bool) -> String {
    match (block, chinese) {
        (
            DataBlock::TooNew {
                written_by: Some(TrustedWrittenBy { version, channel }),
                ..
            },
            true,
        ) => {
            let channel = channel_name(*channel, true);
            format!(
                "这个安装包读不了现在的数据\n\n这台电脑上的数据已经被{channel} {version} 用过，这个安装包（{payload}）读不了，所以没有安装，落樱的程序和数据都没有改动。要接着用这些数据，装{channel} {version} 或更新的版本。"
            )
        }
        (
            DataBlock::TooNew {
                written_by: Some(TrustedWrittenBy { version, channel }),
                ..
            },
            false,
        ) => {
            let channel = channel_name(*channel, false);
            format!(
                "This installer can't read your current data\n\nThe data on this PC has been used by {channel} {version}, which this installer ({payload}) can't read, so nothing was installed and Petalfall's program files and data were left unchanged. To keep using this data, install {channel} {version} or later."
            )
        }
        (
            DataBlock::TooNew {
                written_by: None, ..
            },
            true,
        ) => format!(
            "这个安装包读不了现在的数据\n\n这台电脑上的数据已经被更新的落樱用过，这个安装包（{payload}）读不了，所以没有安装，落樱的程序和数据都没有改动。要接着用这些数据，装更新的版本。"
        ),
        (
            DataBlock::TooNew {
                written_by: None, ..
            },
            false,
        ) => format!(
            "This installer can't read your current data\n\nThe data on this PC has been used by a newer Petalfall, which this installer ({payload}) can't read, so nothing was installed and Petalfall's program files and data were left unchanged. To keep using this data, install a newer version."
        ),
        (DataBlock::Unreadable { reason }, true) => format!(
            "读不懂这台电脑上的数据格式记录\n\n{stamp}：{reason}。判断不了这里的数据能不能用这个安装包，所以没有安装，落樱的程序和数据都没有改动。反馈问题时带上这个路径和原因。"
        ),
        (DataBlock::Unreadable { reason }, false) => format!(
            "Can't read the data format record on this PC\n\n{stamp}: {reason}. It's unclear whether this installer can use the data here, so nothing was installed and Petalfall's program files and data were left unchanged. Include this path and reason if you report the problem."
        ),
    }
}

fn caption(chinese: bool) -> &'static str {
    if chinese {
        "落樱安装程序"
    } else {
        "Petalfall Setup"
    }
}

/// 与前端同一条语言规则：简体、繁体都走中文，其余英文。主语言在 LANGID 的低 10 位。
fn is_chinese(language: u16) -> bool {
    language & PRIMARY_LANGUAGE_MASK == SIMPLIFIED_AND_TRADITIONAL_CHINESE
}

/// 用系统消息框报告，等用户关掉才返回。
pub fn alert(notice: &Notice) {
    // SAFETY: 无参数
    let chinese = is_chinese(unsafe { GetUserDefaultUILanguage() });
    let text = wide(&notice.text(chinese));
    let title = wide(caption(chinese));
    // SAFETY: 两个字符串都以 0 结尾，活到调用返回。没有父窗口
    unsafe { MessageBoxW(null_mut(), text.as_ptr(), title.as_ptr(), notice.style()) };
}

/// 关闭 WebView2 的浏览器加速键：F5 / Ctrl+R 刷新、Ctrl+P 打印、Ctrl+F 查找、F12 开发者工具一次全部屏蔽。
/// 开发构建保留，出问题时还要刷新和调试。
pub fn disable_browser_accelerator_keys(
    window: &WebviewWindow,
    log: Arc<SetupLog>,
) -> tauri::Result<()> {
    use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2Settings3;
    use windows_core::Interface;

    fn apply(webview: &tauri::webview::PlatformWebview) -> windows_core::Result<()> {
        // SAFETY: with_webview 的回调在 WebView 所属的 UI 线程上执行，controller 与由它取得的
        // CoreWebView2、Settings 在回调期间都有效；这里只调用设置对象的 getter / setter。
        unsafe {
            let core = webview.controller().CoreWebView2()?;
            let settings: ICoreWebView2Settings3 = core.Settings()?.cast()?;
            settings.SetAreBrowserAcceleratorKeysEnabled(false)
        }
    }

    if cfg!(debug_assertions) {
        return Ok(());
    }
    window.with_webview(move |webview| {
        // 回调在 UI 线程上异步执行，错误传不回建窗处，只能记下来；后果是这些快捷键仍生效，安装中的刷新另有导航拦截。
        if let Err(err) = apply(&webview) {
            log.warn(format_args!("关闭 WebView2 浏览器加速键失败：{err}"));
        }
    })
}

/// 前端一旦出错就永远不显示窗口，这里留一道兜底，让错误页至少能被看见。
pub fn guard_visibility<R: Runtime>(
    window: WebviewWindow<R>,
    log: Arc<SetupLog>,
) -> io::Result<()> {
    thread::Builder::new()
        .name("show-fallback".to_owned())
        .spawn(move || {
            show_if_still_hidden(
                SHOW_FALLBACK,
                &log,
                || window.is_visible(),
                || window.show(),
            );
        })?;
    Ok(())
}

/// 等 `delay` 后检查可见性，仍不可见就显示。返回是否做了强制显示。
fn show_if_still_hidden<E: Display>(
    delay: Duration,
    log: &SetupLog,
    is_visible: impl Fn() -> Result<bool, E>,
    show: impl Fn() -> Result<(), E>,
) -> bool {
    thread::sleep(delay);
    match is_visible() {
        Ok(true) => false,
        Ok(false) => {
            log.warn(format_args!(
                "前端 {} 毫秒内没有显示窗口，强制显示",
                delay.as_millis()
            ));
            if let Err(err) = show() {
                log.error(format_args!("强制显示窗口失败：{err}"));
            }
            true
        }
        // 这个读取只在窗口已销毁时失败。兜底时限内用户关了窗就会走到这里，没有窗口要兜底，也不是故障
        Err(_) => false,
    }
}

/// 窗口关掉后删 WebView2 数据目录。浏览器进程比窗口活得久，头几次会碰上文件占用，这时界面已经没了，多等一会儿没人察觉。
pub fn remove_webview_data(dir: &Path) -> io::Result<()> {
    retry_until(WEBVIEW_DATA_CLEANUP, CLEANUP_POLL, || {
        fs::remove_dir_all(dir)
    })
}

/// 反复尝试到成功或时限用完，时限用完时交出最后一次的错误。
fn retry_until(
    budget: Duration,
    poll: Duration,
    mut attempt: impl FnMut() -> io::Result<()>,
) -> io::Result<()> {
    let deadline = Instant::now() + budget;
    loop {
        match attempt() {
            Err(_) if Instant::now() < deadline => thread::sleep(poll),
            outcome => return outcome,
        }
    }
}

/// 第二个实例来叫时把窗口拿到前台，最小化的先还原。
pub fn focus_on_request<R: Runtime>(
    instance: Arc<Instance>,
    window: WebviewWindow<R>,
    log: Arc<SetupLog>,
) -> io::Result<()> {
    let listener_log = Arc::clone(&log);
    instance.listen(listener_log, move || {
        log.info("又启动了一次，把已有窗口叫到前台");
        if let Err(err) = window.unminimize().and_then(|()| window.set_focus()) {
            log.error(format_args!("把窗口叫到前台失败：{err}"));
        }
    })
}

fn wide(text: &str) -> Vec<u16> {
    text.encode_utf16().chain(once(0)).collect()
}

/// 测试专用的占位：进程内的用例共用一个内核命名空间，名字带上进程号与用例名，并行跑、重复跑都不串，
/// 也不会和这台机器上真正运行的引导程序抢 `Local\Petalfall-Setup`。
#[cfg(test)]
pub(crate) fn test_claim(test: &str) -> Claim {
    claim_name(&test_event_name(test)).unwrap()
}

#[cfg(test)]
fn test_event_name(test: &str) -> String {
    format!(r"Local\petalfall-setup-test-{}-{test}", std::process::id())
}

/// 同一进程里别的用例开的子进程也会继承事件，它们退出前名字可能还在，等一小会儿再下结论。
#[cfg(test)]
pub(crate) fn test_claim_within(test: &str, budget: Duration) -> Option<Instance> {
    let deadline = Instant::now() + budget;
    loop {
        match test_claim(test) {
            Claim::First(instance) => return Some(instance),
            Claim::Forwarded if Instant::now() < deadline => {
                thread::sleep(Duration::from_millis(20));
            }
            Claim::Forwarded => return None,
        }
    }
}

#[cfg(test)]
mod tests {
    use std::cell::Cell;
    use std::fs::OpenOptions;
    use std::os::windows::fs::OpenOptionsExt;
    use std::os::windows::process::CommandExt;
    use std::process::{Child, Command, Stdio};
    use std::sync::mpsc;
    use std::time::Instant;

    use tempfile::TempDir;
    use windows_sys::Win32::System::Threading::CREATE_NO_WINDOW;

    use super::*;

    fn scratch_log() -> (TempDir, SetupLog) {
        let root = TempDir::new().unwrap();
        let log = SetupLog::open(root.path()).unwrap();
        (root, log)
    }

    fn logged(log: &SetupLog) -> String {
        fs::read_to_string(log.path()).unwrap()
    }

    fn first(test: &str) -> Instance {
        match test_claim(test) {
            Claim::First(instance) => instance,
            Claim::Forwarded => panic!("{test} 上不该已有实例"),
        }
    }

    fn is_forwarded(test: &str) -> bool {
        matches!(test_claim(test), Claim::Forwarded)
    }

    fn wait_until_free(test: &str) -> Instance {
        test_claim_within(test, Duration::from_secs(10))
            .unwrap_or_else(|| panic!("{test} 一直被占着"))
    }

    /// 活得比用例久的子进程。到时自己退出，用例半路失败也不会一直留着。
    fn lingering() -> Command {
        let mut command = Command::new("ping");
        command
            .args(["-n", "6", "127.0.0.1"])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .creation_flags(CREATE_NO_WINDOW);
        command
    }

    fn stop(mut child: Child) {
        child.kill().unwrap();
        child.wait().unwrap();
    }

    fn woken_by(instance: Instance) -> mpsc::Receiver<()> {
        let (tx, rx) = mpsc::channel();
        let (_root, log) = scratch_log();
        Arc::new(instance)
            .listen(Arc::new(log), move || tx.send(()).unwrap())
            .unwrap();
        rx
    }

    #[test]
    fn the_real_event_name_is_in_the_session_namespace() {
        assert_eq!(INSTANCE_EVENT, r"Local\Petalfall-Setup");
    }

    #[test]
    fn webview_at_the_minimum_is_usable_and_one_below_is_not() {
        assert_eq!(
            Webview::judge(Ok::<_, String>("111.0.1661.41".into())),
            Webview::Usable {
                version: "111.0.1661.41".into()
            }
        );
        assert_eq!(
            Webview::judge(Ok::<_, String>("110.0.1587.69".into())),
            Webview::Unavailable {
                reason: "版本 110.0.1587.69 低于 111".into()
            }
        );
    }

    #[test]
    fn every_major_version_is_judged_against_the_minimum() {
        for major in 1..300 {
            let judged = Webview::judge(Ok::<_, String>(format!("{major}.0.2210.91")));
            assert_eq!(
                matches!(judged, Webview::Usable { .. }),
                major >= MIN_WEBVIEW_MAJOR,
                "major={major}"
            );
        }
    }

    #[test]
    fn preview_channels_keep_their_suffix_and_pass() {
        assert_eq!(
            Webview::judge(Ok::<_, String>("126.0.2592.0 canary".into())),
            Webview::Usable {
                version: "126.0.2592.0 canary".into()
            }
        );
    }

    #[test]
    fn every_shape_of_not_installed_is_unavailable() {
        for version in ["", "   ", "0.0.0.0", "abc", ".1.2", "-120.0.0.0"] {
            assert!(
                matches!(
                    Webview::judge(Ok::<_, String>(version.into())),
                    Webview::Unavailable { .. }
                ),
                "{version:?}"
            );
        }
    }

    #[test]
    fn a_failed_probe_keeps_its_reason() {
        assert_eq!(
            Webview::judge(Err::<String, _>("HRESULT 0x80070002")),
            Webview::Unavailable {
                reason: "探测失败：HRESULT 0x80070002".into()
            }
        );
    }

    #[test]
    fn a_later_start_is_forwarded() {
        let _first = first("same");
        assert!(is_forwarded("same"));
        assert!(is_forwarded("same"), "第三次启动同样转交");
    }

    #[test]
    fn each_forwarded_start_wakes_the_listener_once() {
        let instance = first("wake");
        let woken = woken_by(instance);
        for _ in 0..3 {
            assert!(is_forwarded("wake"));
            woken
                .recv_timeout(Duration::from_secs(5))
                .expect("后来者要唤醒先来者");
        }
        assert!(
            woken.recv_timeout(Duration::from_millis(200)).is_err(),
            "事件自动复位，三次启动只醒三次"
        );
    }

    /// 窗口还没建好时就有人双击第二下：唤醒留在事件上，开始监听时才生效，不能丢。
    #[test]
    fn a_start_before_listening_is_not_lost() {
        let instance = first("early");
        assert!(is_forwarded("early"));
        woken_by(instance)
            .recv_timeout(Duration::from_secs(5))
            .expect("开始监听时要收到之前的那次唤醒");
    }

    #[test]
    fn the_claim_ends_with_the_owner() {
        drop(first("exit"));
        let _again = wait_until_free("exit");
    }

    /// 引导程序崩了 payload 还在写文件，这时再打开安装包不能再跑一个 NSIS。
    #[test]
    fn a_child_keeps_the_claim_after_the_owner_is_gone() {
        let instance = first("inherited");
        let child = lingering().spawn().unwrap();
        drop(instance);
        assert!(is_forwarded("inherited"), "子进程继承了事件，名字要还在");

        stop(child);
        let _free = wait_until_free("inherited");
    }

    /// 启动器开几个小时，它要是继承了事件，这期间再打开安装包只会默默退出。
    #[test]
    fn a_child_started_without_inheritance_does_not_hold_the_claim() {
        let instance = first("not-inherited");
        let child = instance
            .without_inheritance(|| lingering().spawn())
            .unwrap()
            .unwrap();
        drop(instance);
        let _free = wait_until_free("not-inherited");
        stop(child);
    }

    #[test]
    fn inheritance_is_off_only_during_the_spawn() {
        let instance = first("flag");
        assert!(instance.is_inheritable().unwrap(), "payload 要靠继承活下去");
        let inside = instance
            .without_inheritance(|| instance.is_inheritable().unwrap())
            .unwrap();
        assert!(!inside);
        assert!(
            instance.is_inheritable().unwrap(),
            "之后的 payload 还要继承"
        );
    }

    #[test]
    fn same_sid_is_the_same_user() {
        assert_eq!(
            compare_users(&[1, 2, 3], Ok(vec![1, 2, 3])),
            DesktopUser::Same
        );
    }

    #[test]
    fn another_sid_is_another_user() {
        assert_eq!(
            compare_users(&[1, 2, 3], Ok(vec![1, 2, 4])),
            DesktopUser::Other
        );
    }

    #[test]
    fn a_shell_that_refuses_us_belongs_to_someone_else() {
        let denied = io::Error::from(io::ErrorKind::PermissionDenied);
        assert_eq!(compare_users(&[1], Err(denied)), DesktopUser::Other);
    }

    #[test]
    fn a_machine_without_a_shell_does_not_block_the_install() {
        let missing = io::Error::new(io::ErrorKind::NotFound, "这台机器没有 shell 窗口");
        assert_eq!(
            compare_users(&[1], Err(missing)),
            DesktopUser::Unknown("这台机器没有 shell 窗口".into())
        );
    }

    #[test]
    fn this_process_reads_the_same_user_both_ways() {
        let own = current_user().unwrap();
        assert_eq!(own[0], 1, "SID 第一个字节是修订号");
        assert_eq!(process_user(std::process::id()).unwrap(), own);
    }

    #[test]
    fn a_process_that_is_not_there_is_an_error() {
        assert!(process_user(1).is_err());
    }

    #[test]
    fn chinese_covers_every_regional_variant() {
        for language in [0x0804, 0x0404, 0x0C04, 0x1004, 0x1404] {
            assert!(is_chinese(language), "{language:#06x}");
        }
        for language in [0x0409, 0x0809, 0x0411, 0x0412, 0x0007] {
            assert!(!is_chinese(language), "{language:#06x}");
        }
    }

    #[test]
    fn notices_speak_the_chosen_language() {
        assert_eq!(caption(true), "落樱安装程序");
        assert_eq!(caption(false), "Petalfall Setup");
        assert!(
            Notice::IncompletePackage
                .text(true)
                .contains("安装包不完整")
        );
        assert!(Notice::IncompletePackage.text(false).contains("incomplete"));
        assert!(Notice::ForeignUser.text(true).contains("另一个账户"));
        assert!(
            Notice::ForeignUser
                .text(false)
                .contains("different account")
        );
    }

    #[test]
    fn a_failure_notice_carries_the_original_text() {
        let notice = Notice::StartFailed("拒绝访问。 (os error 5)".into());
        assert!(notice.text(true).ends_with("拒绝访问。 (os error 5)"));
        assert!(notice.text(false).ends_with("拒绝访问。 (os error 5)"));
    }

    const STAMP: &str = r"D:\游戏\Petalfall\data-format.json";

    fn newer(older: Older, reopens: bool) -> Notice {
        Notice::Newer {
            older,
            installed: "1.1.0-dev.61".into(),
            payload: "1.0.0-beta.5".into(),
            reopens,
        }
    }

    fn blocked(block: DataBlock, reopens: bool) -> Notice {
        Notice::DataBlocked {
            block,
            stamp: STAMP.into(),
            payload: "1.0.0-dev.55".into(),
            reopens,
        }
    }

    fn too_new_by(written_by: &str) -> DataBlock {
        DataBlock::TooNew {
            recorded: 2,
            written_by: petalfall_release::data_format::trusted_written_by(written_by),
        }
    }

    /// 窗口起不来时判定不让装的几种，每种都带上「关掉后重开」的一句与不带的各一份。
    fn refusals(reopens: bool) -> Vec<Notice> {
        vec![
            Notice::NeedsWindow { reopens },
            newer(Older::SameChannel, reopens),
            newer(
                Older::FasterChannel {
                    installed: Channel::Stable,
                    payload: Channel::Beta,
                },
                reopens,
            ),
            newer(
                Older::SlowerChannel {
                    installed: Channel::Dev,
                    payload: Channel::Beta,
                },
                reopens,
            ),
            newer(Older::UnknownChannel, reopens),
            blocked(too_new_by("1.1.0-dev.57"), reopens),
            blocked(
                DataBlock::TooNew {
                    recorded: 2,
                    written_by: None,
                },
                reopens,
            ),
            blocked(
                DataBlock::Unreadable {
                    reason: "缺 data_format".into(),
                },
                reopens,
            ),
        ]
    }

    #[test]
    fn notices_follow_the_product_wording_rules() {
        let mut notices = vec![
            Notice::ForeignUser,
            Notice::IncompletePackage,
            Notice::StartFailed("x".into()),
        ];
        notices.extend(refusals(false));
        notices.extend(refusals(true));
        for notice in &notices {
            let text = notice.text(true);
            assert!(!text.contains('请'), "{text}");
            assert!(!text.contains("启动器"), "{text}");
            assert!(!text.contains("卸载"), "{text}");
            assert!(!text.contains("降级"), "{text}");
        }
    }

    #[test]
    fn failures_are_errors_and_everything_else_is_a_warning() {
        assert_eq!(Notice::IncompletePackage.style(), MB_OK | MB_ICONERROR);
        assert_eq!(
            Notice::StartFailed("x".into()).style(),
            MB_OK | MB_ICONERROR
        );
        let mut warnings = vec![Notice::ForeignUser];
        warnings.extend(refusals(false));
        warnings.extend(refusals(true));
        for notice in &warnings {
            assert_eq!(notice.style(), MB_OK | MB_ICONWARNING, "{notice:?}");
        }
    }

    #[test]
    fn a_switch_without_a_window_asks_for_webview2() {
        assert_eq!(
            Notice::NeedsWindow { reopens: false }.text(true),
            "这次安装要用到安装程序的窗口，但这台电脑上的 WebView2 用不了。先装好或修复 WebView2，再运行这个安装包。"
        );
        assert_eq!(
            Notice::NeedsWindow { reopens: false }.text(false),
            "This install needs the setup window, but WebView2 isn't working on this PC. Install or repair WebView2, then run this installer again."
        );
    }

    /// 四种原因与已安装页的说明一字不差；更快、更慢两种写出两边的通道。
    #[test]
    fn each_reason_an_earlier_package_cannot_go_on_reads_like_the_installed_page() {
        let cases = [
            (
                Older::SameChannel,
                "已安装 1.1.0-dev.61，这个安装包是 1.0.0-beta.5，版本更早，不能往回装。",
                "1.1.0-dev.61 is installed and this installer is the earlier 1.0.0-beta.5, so it can't go back.",
            ),
            (
                Older::SlowerChannel {
                    installed: Channel::Dev,
                    payload: Channel::Beta,
                },
                "已安装预览版 1.1.0-dev.61，这个安装包是版本更早的测试版 1.0.0-beta.5。自动更新不会这样换过去，所以没有安装。要换到测试版，直接运行测试版的安装包。",
                "Preview 1.1.0-dev.61 is installed and this installer is the earlier Beta 1.0.0-beta.5. Automatic updates don't switch channels this way, so nothing was installed. To move to Beta, run a Beta installer directly.",
            ),
            (
                Older::FasterChannel {
                    installed: Channel::Stable,
                    payload: Channel::Dev,
                },
                "已安装正式版 1.1.0-dev.61，这个安装包是预览版 1.0.0-beta.5，版本更早，不能这样换过去。要换到预览版，在落樱的「设置 · 关于」里把更新通道选成预览版，预览版出了比 1.1.0-dev.61 新的版本就会装上。",
                "Stable 1.1.0-dev.61 is installed and this installer is the earlier Preview 1.0.0-beta.5, so it can't switch this way. To move to Preview, choose Preview as the update channel in Petalfall's Settings, About; it installs once Preview has a version newer than 1.1.0-dev.61.",
            ),
            (
                Older::UnknownChannel,
                "已安装 1.1.0-dev.61，这个安装包是 1.0.0-beta.5，不能往回装。",
                "1.1.0-dev.61 is installed and this installer is 1.0.0-beta.5, so it can't go back.",
            ),
        ];
        for (older, chinese, english) in cases {
            assert_eq!(newer(older, false).text(true), chinese);
            assert_eq!(newer(older, false).text(false), english);
        }
    }

    #[test]
    fn data_written_by_a_known_version_names_it() {
        let notice = blocked(too_new_by("1.1.0-dev.57"), false);

        assert_eq!(
            notice.text(true),
            "这个安装包读不了现在的数据\n\n这台电脑上的数据已经被预览版 1.1.0-dev.57 用过，这个安装包（1.0.0-dev.55）读不了，所以没有安装，落樱的程序和数据都没有改动。要接着用这些数据，装预览版 1.1.0-dev.57 或更新的版本。"
        );
        assert_eq!(
            notice.text(false),
            "This installer can't read your current data\n\nThe data on this PC has been used by Preview 1.1.0-dev.57, which this installer (1.0.0-dev.55) can't read, so nothing was installed and Petalfall's program files and data were left unchanged. To keep using this data, install Preview 1.1.0-dev.57 or later."
        );
    }

    /// 记号里的 written_by 不像落樱发过的版本时，净化后为空，说成「更新的落樱」。
    #[test]
    fn data_written_by_someone_unknown_says_a_newer_petalfall() {
        let notice = blocked(too_new_by("9.9.9-evil"), false);

        assert_eq!(
            notice.text(true),
            "这个安装包读不了现在的数据\n\n这台电脑上的数据已经被更新的落樱用过，这个安装包（1.0.0-dev.55）读不了，所以没有安装，落樱的程序和数据都没有改动。要接着用这些数据，装更新的版本。"
        );
        assert_eq!(
            notice.text(false),
            "This installer can't read your current data\n\nThe data on this PC has been used by a newer Petalfall, which this installer (1.0.0-dev.55) can't read, so nothing was installed and Petalfall's program files and data were left unchanged. To keep using this data, install a newer version."
        );
    }

    #[test]
    fn an_unreadable_stamp_shows_its_path_and_reason() {
        let notice = blocked(
            DataBlock::Unreadable {
                reason: "缺 data_format".into(),
            },
            false,
        );

        assert_eq!(
            notice.text(true),
            format!(
                "读不懂这台电脑上的数据格式记录\n\n{STAMP}：缺 data_format。判断不了这里的数据能不能用这个安装包，所以没有安装，落樱的程序和数据都没有改动。反馈问题时带上这个路径和原因。"
            )
        );
        assert_eq!(
            notice.text(false),
            format!(
                "Can't read the data format record on this PC\n\n{STAMP}: 缺 data_format. It's unclear whether this installer can use the data here, so nothing was installed and Petalfall's program files and data were left unchanged. Include this path and reason if you report the problem."
            )
        );
    }

    /// 更新模式下关掉提示会重开启动器，每一种都在末尾说一声；交互启动时不说。
    #[test]
    fn a_refusal_in_update_mode_says_petalfall_will_reopen() {
        for (quiet, loud) in refusals(false).iter().zip(refusals(true).iter()) {
            assert_eq!(
                loud.text(true),
                format!("{}\n\n关掉这个提示后会重新打开落樱。", quiet.text(true))
            );
            assert_eq!(
                loud.text(false),
                format!(
                    "{}\n\nPetalfall will reopen after you close this message.",
                    quiet.text(false)
                )
            );
            assert!(!quiet.text(true).contains("重新打开落樱"), "{quiet:?}");
        }
    }

    #[test]
    fn a_hidden_window_is_shown_once_after_the_delay() {
        let (_root, log) = scratch_log();
        let shown = Cell::new(0);
        let started = Instant::now();
        let forced = show_if_still_hidden(
            Duration::from_millis(30),
            &log,
            || Ok::<_, String>(false),
            || {
                shown.set(shown.get() + 1);
                Ok(())
            },
        );
        assert!(forced);
        assert_eq!(shown.get(), 1);
        assert!(
            started.elapsed() >= Duration::from_millis(30),
            "不应早于时限检查"
        );
        assert!(logged(&log).contains("前端 30 毫秒内没有显示窗口"));
    }

    #[test]
    fn a_visible_window_is_left_alone() {
        let (_root, log) = scratch_log();
        let shown = Cell::new(0);
        let forced = show_if_still_hidden(
            Duration::from_millis(1),
            &log,
            || Ok::<_, String>(true),
            || {
                shown.set(shown.get() + 1);
                Ok(())
            },
        );
        assert!(!forced);
        assert_eq!(shown.get(), 0);
        assert_eq!(logged(&log), "");
    }

    /// 启动后三秒内正常关窗，可见性就读不出来了。这是常态，不能在日志里多一条错误让人以为出了故障。
    #[test]
    fn unreadable_visibility_means_the_window_closed() {
        let (_root, log) = scratch_log();
        let shown = Cell::new(0);
        let forced = show_if_still_hidden(
            Duration::from_millis(1),
            &log,
            || Err::<bool, _>("failed to receive message from webview".to_owned()),
            || {
                shown.set(shown.get() + 1);
                Ok(())
            },
        );
        assert!(!forced);
        assert_eq!(shown.get(), 0);
        assert_eq!(logged(&log), "");
    }

    #[test]
    fn a_failed_forced_show_is_logged() {
        let (_root, log) = scratch_log();
        let forced = show_if_still_hidden(
            Duration::from_millis(1),
            &log,
            || Ok::<_, String>(false),
            || Err("显示失败原文".to_owned()),
        );
        assert!(forced);
        assert!(logged(&log).contains("ERROR 强制显示窗口失败：显示失败原文"));
    }

    #[test]
    fn cleanup_retries_until_the_browser_lets_go() {
        let dir = TempDir::new().unwrap();
        let data = dir.path().join("webview");
        fs::create_dir(&data).unwrap();
        let held = OpenOptions::new()
            .write(true)
            .create_new(true)
            .share_mode(0)
            .open(data.join("LOCK"))
            .unwrap();
        assert!(fs::remove_dir_all(&data).is_err(), "占用时第一次删不掉");

        let releaser = thread::spawn(move || {
            thread::sleep(Duration::from_millis(150));
            drop(held);
        });
        remove_webview_data(&data).unwrap();
        releaser.join().unwrap();
        assert!(!data.exists());
    }

    #[test]
    fn retrying_stops_at_the_first_success() {
        let attempts = Cell::new(0);
        retry_until(Duration::from_secs(30), Duration::from_millis(1), || {
            attempts.set(attempts.get() + 1);
            if attempts.get() < 3 {
                Err(io::Error::from(io::ErrorKind::PermissionDenied))
            } else {
                Ok(())
            }
        })
        .unwrap();
        assert_eq!(attempts.get(), 3);
    }

    #[test]
    fn retrying_gives_up_with_the_last_error() {
        let attempts = Cell::new(0);
        let started = Instant::now();
        let err = retry_until(Duration::from_millis(30), Duration::from_millis(5), || {
            attempts.set(attempts.get() + 1);
            Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                format!("第 {} 次", attempts.get()),
            ))
        })
        .unwrap_err();
        assert!(started.elapsed() >= Duration::from_millis(30));
        assert!(attempts.get() >= 2);
        assert_eq!(err.to_string(), format!("第 {} 次", attempts.get()));
    }

    #[test]
    fn the_fallback_waits_three_seconds() {
        assert_eq!(SHOW_FALLBACK, Duration::from_secs(3));
    }

    /// 窗口由 main 手动创建才拿得到建窗结果，配置里默认建窗的话错误会被吞掉；不可见才有兜底显示可言。
    #[test]
    fn the_configured_window_waits_for_manual_creation() {
        let conf: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        let window = &conf["app"]["windows"][0];
        assert_eq!(window["label"], MAIN_WINDOW);
        assert_eq!(window["create"], false);
        assert_eq!(window["visible"], false);
    }
}
