//! 主窗口的拖放：系统把文件、或皮肤站上 authlib-injector 的服务器链接拖进窗口时，在原生层接住，
//! 以 [`WINDOW_DROP_EVENT`] 推给前端。
//!
//! Tauri 自带的原生拖放只认文件：它接管了 WebView2 的放置目标、关掉了 WebView2 自己的外部拖入，
//! 拖链接、文字进来既没有它的事件，网页里也收不到 drop。网页的 drop 事件又拿不到文件的完整路径，
//! 后端读不到那个文件。所以主窗口关掉自带的那套（tauri.conf.json 的 `dragDropEnabled: false`），
//! 由这里在 WebView2 的子窗口上注册自己的放置目标，文件列表与链接文字都读。
//!
//! 链接的格式由 authlib-injector 的启动器规范约定：拖拽数据是 `text/plain`（Windows 上即 `CF_UNICODETEXT`），
//! 内容为 `authlib-injector:yggdrasil-server:` 加上经 `encodeURIComponent` 编码的认证服务器 API 地址。

use percent_encoding::percent_decode_str;
use serde::Serialize;

/// 拖进、拖出、松开在主窗口上，负载为 [`WindowDropEvent`]。
pub const WINDOW_DROP_EVENT: &str = "aurora://window-drop";

/// authlib-injector 约定的拖拽链接前缀，后面跟 URL 编码过的认证服务器 API 地址。
pub const AUTH_SERVER_LINK_PREFIX: &str = "authlib-injector:yggdrasil-server:";

/// 拖进来的东西里认得的那一样。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum DropContent {
    /// 系统给出的完整路径，可能一次拖进多个文件。
    Files { paths: Vec<String> },
    /// 外置登录服务器链接里解出来的 API 地址（已解码）。
    AuthServer { url: String },
}

/// [`WINDOW_DROP_EVENT`] 的负载。拖动经过窗口时不逐次推送：前端只关心进来的是什么、最后松没松开。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum WindowDropEvent {
    Enter { content: DropContent },
    Leave,
    Drop { content: DropContent },
}

/// 从拖入的文字里取外置登录服务器地址；不是这种链接、解码不出 UTF-8 或地址为空时为 `None`。
pub fn parse_auth_server_link(text: &str) -> Option<String> {
    let rest = text.trim().strip_prefix(AUTH_SERVER_LINK_PREFIX)?;
    let decoded = percent_decode_str(rest).decode_utf8().ok()?;
    let url = decoded.trim();
    (!url.is_empty()).then(|| url.to_owned())
}

/// 按拖入数据里的文件列表与文字判断认不认：有文件就按文件（资源管理器拖文件时不带链接文字），
/// 没有文件时看文字是不是外置登录链接；别的一概不认，鼠标显示不可放置。
pub fn classify(paths: Vec<String>, text: Option<&str>) -> Option<DropContent> {
    if !paths.is_empty() {
        return Some(DropContent::Files { paths });
    }
    text.and_then(parse_auth_server_link)
        .map(|url| DropContent::AuthServer { url })
}

/// 在主窗口上装好放置目标。注册要在 WebView 所属的 UI 线程上做，经 `with_webview` 派过去；
/// 那边的结果传不回 setup，只能记日志——装不上的后果是拖进窗口的文件与链接都没有反应。
#[cfg(windows)]
pub fn install(window: &tauri::WebviewWindow) -> tauri::Result<()> {
    use tauri::Manager;

    let app = window.app_handle().clone();
    window.with_webview(move |webview| {
        let emit: native::Emit = std::rc::Rc::new(move |event: WindowDropEvent| {
            crate::events::emit(&app, WINDOW_DROP_EVENT, event)
        });
        // SAFETY: with_webview 的回调在 WebView 所属的 UI 线程上执行，那里已由窗口层初始化过 OLE；
        // controller 与它的父窗口在回调期间都有效。
        match unsafe { native::install(&webview, emit) } {
            Ok(registered) => tracing::info!(registered, "主窗口的拖放目标已就绪"),
            Err(err) => tracing::error!(error = %err, "主窗口的拖放目标没装上，拖进窗口的文件与外置登录链接眼下都没有反应"),
        }
    })
}

#[cfg(windows)]
mod native {
    use std::cell::Cell;
    use std::ptr;
    use std::rc::Rc;

    use webview2_com::Microsoft::Web::WebView2::Win32::{
        ICoreWebView2, ICoreWebView2Controller4, COREWEBVIEW2_PROCESS_FAILED_KIND,
        COREWEBVIEW2_PROCESS_FAILED_KIND_BROWSER_PROCESS_EXITED,
        COREWEBVIEW2_PROCESS_FAILED_KIND_FRAME_RENDER_PROCESS_EXITED,
        COREWEBVIEW2_PROCESS_FAILED_KIND_PPAPI_BROKER_PROCESS_EXITED,
        COREWEBVIEW2_PROCESS_FAILED_KIND_PPAPI_PLUGIN_PROCESS_EXITED,
        COREWEBVIEW2_PROCESS_FAILED_KIND_SANDBOX_HELPER_PROCESS_EXITED,
        COREWEBVIEW2_PROCESS_FAILED_KIND_UNKNOWN_PROCESS_EXITED,
        COREWEBVIEW2_PROCESS_FAILED_KIND_UTILITY_PROCESS_EXITED,
    };
    use webview2_com::{NavigationCompletedEventHandler, ProcessFailedEventHandler};
    use windows::Win32::Foundation::{
        DRAGDROP_E_NOTREGISTERED, DV_E_FORMATETC, DV_E_TYMED, E_FAIL, E_POINTER, HWND, LPARAM,
        POINTL, TRUE,
    };
    use windows::Win32::System::Com::{
        IDataObject, DVASPECT_CONTENT, FORMATETC, STGMEDIUM, TYMED_HGLOBAL,
    };
    use windows::Win32::System::Memory::{GlobalLock, GlobalSize, GlobalUnlock};
    use windows::Win32::System::Ole::{
        IDropTarget, IDropTarget_Impl, RegisterDragDrop, ReleaseStgMedium, RevokeDragDrop,
        CF_HDROP, CF_UNICODETEXT, DROPEFFECT, DROPEFFECT_COPY, DROPEFFECT_NONE,
    };
    use windows::Win32::System::SystemServices::MODIFIERKEYS_FLAGS;
    use windows::Win32::UI::Shell::{DragQueryFileW, HDROP};
    use windows::Win32::UI::WindowsAndMessaging::EnumChildWindows;
    use windows_core::{implement, Interface, BOOL};

    use super::{classify, DropContent, WindowDropEvent};

    pub type Emit = Rc<dyn Fn(WindowDropEvent)>;

    /// 拖入文字最多读这么多个 UTF-16 码元。外置登录链接只有几十到几百个字符；拖进一大段网页文字时不必整段读出来。
    const MAX_TEXT_UNITS: usize = 4096;

    /// 关掉 WebView2 自己的外部拖入，订阅子进程故障与页面加载完成（好在 WebView2 换掉子窗口之后重新挂上），
    /// 再在父窗口下的每个子窗口上换上 [`DropTarget`]。返回注册上的窗口数。
    ///
    /// # Safety
    /// 只能在 WebView 所属的 UI 线程上调用，且该线程已初始化 OLE。
    pub unsafe fn install(
        webview: &tauri::webview::PlatformWebview,
        emit: Emit,
    ) -> windows_core::Result<usize> {
        let controller = webview.controller();
        unsafe {
            // 放置目标换成这里的之后，万一 WebView2 在没换到的子窗口上还留着自己的，它也不再接外部拖入
            controller
                .cast::<ICoreWebView2Controller4>()?
                .SetAllowExternalDrop(false)?;
            let mut parent = HWND::default();
            controller.ParentWindow(&mut parent)?;
            let registrar = Rc::new(Registrar::new(parent, emit));
            arm(registrar, |registrar| {
                watch(&controller.CoreWebView2()?, registrar)
            })
        }
    }

    /// 先订阅页面加载完成，再按当前的子窗口挂一遍，返回这一遍注册上的窗口数。
    ///
    /// 订阅不看这一遍的结果：这一遍可能一个都挂不上（撤 WebView2 原有的放置目标会遇到 RPC_E_WRONG_THREAD），
    /// 只要订阅在，页面加载完成时还会再挂。
    ///
    /// # Safety
    /// 同 [`Registrar::sync`]。
    unsafe fn arm(
        registrar: Rc<Registrar>,
        subscribe: impl FnOnce(Rc<Registrar>) -> windows_core::Result<()>,
    ) -> windows_core::Result<usize> {
        // 订阅不上时眼下的拖放照常可用，只是子进程重启后不会重挂；单独记下，不当成装不上
        if let Err(err) = subscribe(registrar.clone()) {
            tracing::error!(error = %err, "订阅 WebView2 子进程故障与页面加载完成失败，WebView2 子进程重启后拖进窗口的文件与外置登录链接会没有反应");
        }
        unsafe { registrar.sync() }
    }

    /// 子进程故障记一笔，页面加载完成时按当时的子窗口重挂。两个订阅随 WebView 活到应用退出，
    /// 从不退订，注册令牌不用留。
    unsafe fn watch(core: &ICoreWebView2, registrar: Rc<Registrar>) -> windows_core::Result<()> {
        let mut token = 0i64;
        let on_failure = registrar.clone();
        let failed = ProcessFailedEventHandler::create(Box::new(move |_, args| {
            let kind = args.ok_or_else(|| E_POINTER.into()).and_then(|args| {
                let mut kind = COREWEBVIEW2_PROCESS_FAILED_KIND::default();
                // SAFETY: 事件参数在回调期间有效，kind 是可写的输出位置
                unsafe { args.ProcessFailedKind(&mut kind) }.map(|()| kind)
            });
            match kind {
                Ok(kind) => on_failure.process_failed(kind),
                Err(err) => {
                    tracing::error!(error = %err, "读不出 WebView2 子进程故障的类型，按子窗口会被换掉处理");
                    on_failure
                        .process_failed(COREWEBVIEW2_PROCESS_FAILED_KIND_UNKNOWN_PROCESS_EXITED);
                }
            }
            Ok(())
        }));
        let completed = NavigationCompletedEventHandler::create(Box::new(move |_, _| {
            // SAFETY: WebView2 的事件回调都在创建它的 UI 线程上执行，那里已初始化过 OLE
            unsafe { registrar.navigation_completed() };
            Ok(())
        }));
        unsafe {
            core.add_ProcessFailed(&failed, &mut token)?;
            core.add_NavigationCompleted(&completed, &mut token)?;
        }
        Ok(())
    }

    /// 一次 WebView2 子进程故障对放置目标意味着什么。
    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    pub enum FailureImpact {
        /// 浏览器进程退出：WebView 随之关闭，子窗口全部销毁，只有重建 WebView 才能恢复，而 Tauri 不重建。
        WebViewClosed,
        /// 渲染进程或 GPU 进程没了（认不出的类型也归这里）：WebView2 起新进程时会新建网页区域的子窗口，
        /// 新窗口上没有这里的放置目标。
        WindowsRebuilt,
        /// 只承载子框架或后台服务的进程，不带窗口。
        NoWindows,
    }

    /// 故障类型的取值见 WebView2 的 `COREWEBVIEW2_PROCESS_FAILED_KIND`。认不出的新类型按子窗口会被换掉处理：
    /// 宁可多记一条恢复日志，也不漏掉拖放失效的线索。
    pub fn failure_impact(kind: COREWEBVIEW2_PROCESS_FAILED_KIND) -> FailureImpact {
        match kind {
            COREWEBVIEW2_PROCESS_FAILED_KIND_BROWSER_PROCESS_EXITED => FailureImpact::WebViewClosed,
            COREWEBVIEW2_PROCESS_FAILED_KIND_FRAME_RENDER_PROCESS_EXITED
            | COREWEBVIEW2_PROCESS_FAILED_KIND_UTILITY_PROCESS_EXITED
            | COREWEBVIEW2_PROCESS_FAILED_KIND_SANDBOX_HELPER_PROCESS_EXITED
            | COREWEBVIEW2_PROCESS_FAILED_KIND_PPAPI_PLUGIN_PROCESS_EXITED
            | COREWEBVIEW2_PROCESS_FAILED_KIND_PPAPI_BROKER_PROCESS_EXITED => {
                FailureImpact::NoWindows
            }
            _ => FailureImpact::WindowsRebuilt,
        }
    }

    /// 主窗口共用的放置目标，以及把它挂到 WebView2 子窗口上的时机。
    ///
    /// 网页区域的子窗口归 WebView2 的浏览器进程所有：渲染进程退出时随之销毁，下一次加载页面时新建，新窗口上
    /// 没有这里的放置目标。WebView2 不通知子窗口的新建，能对上的是两件事：子进程故障告诉我们要换窗口了，
    /// 页面加载完成时新窗口一定已经在了。所以每次页面加载完成都按当时的子窗口重挂一遍，重挂对已挂好的窗口没有影响。
    pub struct Registrar {
        parent: HWND,
        target: IDropTarget,
        /// 子进程故障之后、子窗口重挂之前为真，用来把那一次重挂记成恢复而不是例行。
        rebuild_pending: Cell<bool>,
    }

    impl Registrar {
        pub fn new(parent: HWND, emit: Emit) -> Self {
            Self {
                parent,
                target: DropTarget::new(emit).into(),
                rebuild_pending: Cell::new(false),
            }
        }

        /// 在父窗口下当前的每个子孙窗口上换上放置目标，返回注册上的窗口数；可以反复调用，挂着的不论是谁的都先撤下。
        ///
        /// # Safety
        /// 只能在父窗口所属的 UI 线程上调用，且该线程已初始化 OLE。
        pub unsafe fn sync(&self) -> windows_core::Result<usize> {
            let mut registered = 0;
            for hwnd in unsafe { child_windows(self.parent) } {
                match unsafe { RevokeDragDrop(hwnd) } {
                    Ok(()) => {}
                    // 没注册过放置目标的子窗口是常态
                    Err(err) if err.code() == DRAGDROP_E_NOTREGISTERED => {}
                    Err(err) => {
                        tracing::warn!(error = %err, "撤下 WebView2 子窗口原有的放置目标失败，跳过这个窗口");
                        continue;
                    }
                }
                match unsafe { RegisterDragDrop(hwnd, &self.target) } {
                    Ok(()) => registered += 1,
                    Err(err) => {
                        tracing::warn!(error = %err, "在 WebView2 子窗口上注册放置目标失败")
                    }
                }
            }
            if registered == 0 {
                return Err(windows_core::Error::new(
                    E_FAIL,
                    "WebView2 下没有一个子窗口注册上放置目标",
                ));
            }
            Ok(registered)
        }

        pub fn process_failed(&self, kind: COREWEBVIEW2_PROCESS_FAILED_KIND) {
            match failure_impact(kind) {
                FailureImpact::WebViewClosed => tracing::error!(
                    kind = kind.0,
                    "WebView2 浏览器进程退出，WebView 已关闭：界面与拖放都不再可用，要重启应用才能恢复"
                ),
                FailureImpact::WindowsRebuilt => {
                    self.rebuild_pending.set(true);
                    tracing::warn!(
                        kind = kind.0,
                        "WebView2 子进程退出，网页区域的子窗口会被新建，拖放目标等下一次页面加载完成时重挂"
                    );
                }
                FailureImpact::NoWindows => tracing::warn!(
                    kind = kind.0,
                    "WebView2 子进程退出，它不带窗口，拖放目标不受影响"
                ),
            }
        }

        /// # Safety
        /// 同 [`Registrar::sync`]。
        pub unsafe fn navigation_completed(&self) {
            let recovering = self.rebuild_pending.replace(false);
            match unsafe { self.sync() } {
                Ok(registered) if recovering => tracing::info!(
                    registered,
                    "WebView2 子进程重启后，拖放目标已重挂到新的子窗口上"
                ),
                Ok(registered) => {
                    tracing::debug!(registered, "页面加载完成，拖放目标按当前子窗口重挂")
                }
                Err(err) => {
                    tracing::error!(error = %err, recovering, "页面加载完成后重挂拖放目标失败，拖进窗口的文件与外置登录链接都不会有反应")
                }
            }
        }
    }

    /// 父窗口下的全部子孙窗口。
    unsafe fn child_windows(parent: HWND) -> Vec<HWND> {
        unsafe extern "system" fn collect(hwnd: HWND, lparam: LPARAM) -> BOOL {
            // SAFETY: lparam 是下面传进来的 &mut Vec<HWND>，EnumChildWindows 返回之前一直有效
            let list = unsafe { &mut *(lparam.0 as *mut Vec<HWND>) };
            list.push(hwnd);
            TRUE
        }
        let mut list: Vec<HWND> = Vec::new();
        // 返回值没有意义（文档注明未使用），枚举结果就是 list
        let _ = unsafe {
            EnumChildWindows(
                Some(parent),
                Some(collect),
                LPARAM(&mut list as *mut Vec<HWND> as isize),
            )
        };
        list
    }

    fn hglobal_format(format: u16) -> FORMATETC {
        FORMATETC {
            cfFormat: format,
            ptd: ptr::null_mut(),
            dwAspect: DVASPECT_CONTENT.0,
            lindex: -1,
            tymed: TYMED_HGLOBAL.0 as u32,
        }
    }

    /// 取一种 HGLOBAL 格式的数据；数据里没有这种格式时为 `None`。
    unsafe fn hglobal_data(data: &IDataObject, format: u16, what: &str) -> Option<STGMEDIUM> {
        match unsafe { data.GetData(&hglobal_format(format)) } {
            Ok(medium) if medium.tymed == TYMED_HGLOBAL.0 as u32 => Some(medium),
            Ok(mut medium) => {
                unsafe { ReleaseStgMedium(&mut medium) };
                None
            }
            Err(err) if err.code() == DV_E_FORMATETC || err.code() == DV_E_TYMED => None,
            Err(err) => {
                tracing::warn!(error = %err, what, "读拖入数据失败，按没有这种数据处理");
                None
            }
        }
    }

    /// 拖入数据里的文件路径；路径不是合法 UTF-16 的文件前端也打不开，记一条日志后跳过。
    unsafe fn read_files(data: &IDataObject) -> Vec<String> {
        let Some(mut medium) = (unsafe { hglobal_data(data, CF_HDROP.0, "文件列表") }) else {
            return Vec::new();
        };
        let mut paths = Vec::new();
        unsafe {
            let hdrop = HDROP(medium.u.hGlobal.0);
            let count = DragQueryFileW(hdrop, u32::MAX, None);
            for i in 0..count {
                let len = DragQueryFileW(hdrop, i, None) as usize;
                let mut buf = vec![0u16; len + 1];
                DragQueryFileW(hdrop, i, Some(&mut buf));
                match String::from_utf16(&buf[..len]) {
                    Ok(path) => paths.push(path),
                    Err(err) => {
                        tracing::warn!(error = %err, "拖入的文件路径不是合法的 UTF-16，跳过")
                    }
                }
            }
            ReleaseStgMedium(&mut medium);
        }
        paths
    }

    /// 拖入数据里的文字；没有文字、太长或不是合法 UTF-16 时为 `None`。
    unsafe fn read_text(data: &IDataObject) -> Option<String> {
        let mut medium = unsafe { hglobal_data(data, CF_UNICODETEXT.0, "文字") }?;
        let text = unsafe {
            let handle = medium.u.hGlobal;
            let base = GlobalLock(handle) as *const u16;
            let text = if base.is_null() {
                tracing::warn!(error = %windows_core::Error::from_win32(), "锁定拖入文字的内存失败");
                None
            } else {
                let units = GlobalSize(handle) / 2;
                let slice = std::slice::from_raw_parts(base, units.min(MAX_TEXT_UNITS));
                match slice.iter().position(|&unit| unit == 0) {
                    Some(end) => String::from_utf16(&slice[..end]).ok(),
                    // 读满上限还没遇到结尾：太长，不会是链接；内存里本来就没有结尾的按全部内容算
                    None if units > MAX_TEXT_UNITS => None,
                    None => String::from_utf16(slice).ok(),
                }
            };
            if !base.is_null() {
                // 锁计数归零时 GlobalUnlock 返回 FALSE 且错误码为 NO_ERROR，这是正常结局，不是失败
                let _ = GlobalUnlock(handle);
            }
            ReleaseStgMedium(&mut medium);
            text
        };
        text
    }

    unsafe fn read_content(data: &IDataObject) -> Option<DropContent> {
        let paths = unsafe { read_files(data) };
        if !paths.is_empty() {
            return classify(paths, None);
        }
        let text = unsafe { read_text(data) };
        classify(Vec::new(), text.as_deref())
    }

    /// 主窗口各子窗口共用的一个放置目标：拖动从一个子窗口移到另一个时，系统先对前一个调用 DragLeave，
    /// 再对后一个调用 DragEnter，同一时刻只有一次拖动。
    #[implement(IDropTarget)]
    pub struct DropTarget {
        emit: Emit,
        /// 这一次拖动进来的东西认不认；不认的拖动不推送任何事件。
        accepted: Cell<bool>,
    }

    impl DropTarget {
        pub fn new(emit: Emit) -> Self {
            Self {
                emit,
                accepted: Cell::new(false),
            }
        }
    }

    fn set_effect(out: *mut DROPEFFECT, effect: DROPEFFECT) {
        if !out.is_null() {
            // SAFETY: OLE 传进来的输出参数，非空时指向一个可写的 DROPEFFECT
            unsafe { *out = effect };
        }
    }

    #[allow(non_snake_case)]
    impl IDropTarget_Impl for DropTarget_Impl {
        fn DragEnter(
            &self,
            pdataobj: windows_core::Ref<'_, IDataObject>,
            _grfkeystate: MODIFIERKEYS_FLAGS,
            _pt: &POINTL,
            pdweffect: *mut DROPEFFECT,
        ) -> windows_core::Result<()> {
            let content = pdataobj
                .as_ref()
                .and_then(|data| unsafe { read_content(data) });
            self.accepted.set(content.is_some());
            match content {
                Some(content) => {
                    (self.emit)(WindowDropEvent::Enter { content });
                    set_effect(pdweffect, DROPEFFECT_COPY);
                }
                None => set_effect(pdweffect, DROPEFFECT_NONE),
            }
            Ok(())
        }

        fn DragOver(
            &self,
            _grfkeystate: MODIFIERKEYS_FLAGS,
            _pt: &POINTL,
            pdweffect: *mut DROPEFFECT,
        ) -> windows_core::Result<()> {
            set_effect(
                pdweffect,
                if self.accepted.get() {
                    DROPEFFECT_COPY
                } else {
                    DROPEFFECT_NONE
                },
            );
            Ok(())
        }

        fn DragLeave(&self) -> windows_core::Result<()> {
            if self.accepted.replace(false) {
                (self.emit)(WindowDropEvent::Leave);
            }
            Ok(())
        }

        fn Drop(
            &self,
            pdataobj: windows_core::Ref<'_, IDataObject>,
            _grfkeystate: MODIFIERKEYS_FLAGS,
            _pt: &POINTL,
            pdweffect: *mut DROPEFFECT,
        ) -> windows_core::Result<()> {
            if !self.accepted.replace(false) {
                set_effect(pdweffect, DROPEFFECT_NONE);
                return Ok(());
            }
            // 松开时以这一刻的数据为准；读不出来时按拖出窗口收场，前端的提示随之收起
            match pdataobj
                .as_ref()
                .and_then(|data| unsafe { read_content(data) })
            {
                Some(content) => {
                    (self.emit)(WindowDropEvent::Drop { content });
                    set_effect(pdweffect, DROPEFFECT_COPY);
                }
                None => {
                    (self.emit)(WindowDropEvent::Leave);
                    set_effect(pdweffect, DROPEFFECT_NONE);
                }
            }
            Ok(())
        }
    }

    #[cfg(test)]
    mod tests {
        use std::cell::RefCell;

        use webview2_com::Microsoft::Web::WebView2::Win32::{
            COREWEBVIEW2_PROCESS_FAILED_KIND_GPU_PROCESS_EXITED,
            COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_EXITED,
            COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_UNRESPONSIVE,
        };
        use windows::Win32::Foundation::{
            DRAGDROP_E_ALREADYREGISTERED, E_NOINTERFACE, HGLOBAL, POINT,
        };
        use windows::Win32::System::Memory::{GlobalAlloc, GMEM_MOVEABLE};
        use windows::Win32::System::Ole::OleInitialize;
        use windows::Win32::UI::Shell::{SHCreateDataObject, DROPFILES};
        use windows::Win32::UI::WindowsAndMessaging::{
            CreateWindowExW, DestroyWindow, WINDOW_EX_STYLE, WS_CHILD, WS_POPUP,
        };
        use windows_core::PCWSTR;

        use super::*;

        fn hglobal_of(bytes: &[u8]) -> HGLOBAL {
            unsafe {
                let handle = GlobalAlloc(GMEM_MOVEABLE, bytes.len()).unwrap();
                let base = GlobalLock(handle) as *mut u8;
                assert!(!base.is_null());
                std::ptr::copy_nonoverlapping(bytes.as_ptr(), base, bytes.len());
                let _ = GlobalUnlock(handle);
                handle
            }
        }

        fn wide(text: &str) -> Vec<u8> {
            text.encode_utf16()
                .chain(std::iter::once(0))
                .flat_map(u16::to_le_bytes)
                .collect()
        }

        /// 系统的外壳数据对象，按资源管理器与浏览器的做法放进文字或文件列表。
        fn data_object(format: u16, bytes: Vec<u8>) -> IDataObject {
            unsafe {
                // 每个测试线程各自初始化；同一线程重复调用返回 S_FALSE，也算成功
                OleInitialize(None).unwrap();
                let data: IDataObject = SHCreateDataObject(None, None, None).unwrap();
                let medium = STGMEDIUM {
                    tymed: TYMED_HGLOBAL.0 as u32,
                    u: windows::Win32::System::Com::STGMEDIUM_0 {
                        hGlobal: hglobal_of(&bytes),
                    },
                    pUnkForRelease: std::mem::ManuallyDrop::new(None),
                };
                data.SetData(&hglobal_format(format), &medium, true)
                    .unwrap();
                data
            }
        }

        fn text_object(text: &str) -> IDataObject {
            data_object(CF_UNICODETEXT.0, wide(text))
        }

        fn files_object(paths: &[&str]) -> IDataObject {
            let header = DROPFILES {
                pFiles: std::mem::size_of::<DROPFILES>() as u32,
                pt: POINT { x: 0, y: 0 },
                fNC: false.into(),
                fWide: TRUE,
            };
            // SAFETY: DROPFILES 是 repr(C) 的纯数据结构，按字节拷出来就是它在内存里的样子
            let mut bytes = unsafe {
                std::slice::from_raw_parts(
                    &header as *const DROPFILES as *const u8,
                    std::mem::size_of::<DROPFILES>(),
                )
                .to_vec()
            };
            for path in paths {
                bytes.extend(wide(path));
            }
            bytes.extend([0, 0]);
            data_object(CF_HDROP.0, bytes)
        }

        fn recording_target() -> (IDropTarget, Rc<RefCell<Vec<WindowDropEvent>>>) {
            let events = Rc::new(RefCell::new(Vec::new()));
            let sink = events.clone();
            let target: IDropTarget =
                DropTarget::new(Rc::new(move |event| sink.borrow_mut().push(event))).into();
            (target, events)
        }

        const AT: POINTL = POINTL { x: 10, y: 20 };

        #[test]
        fn authlib_link_from_a_skin_site_is_accepted_and_decoded() {
            let (target, events) = recording_target();
            let data = text_object(
                "authlib-injector:yggdrasil-server:https%3A%2F%2Flittleskin.cn%2Fapi%2Fyggdrasil",
            );
            let mut effect = DROPEFFECT_NONE;
            unsafe {
                target
                    .DragEnter(&data, MODIFIERKEYS_FLAGS(0), AT, &mut effect)
                    .unwrap();
                assert_eq!(effect, DROPEFFECT_COPY);
                effect = DROPEFFECT_NONE;
                target
                    .DragOver(MODIFIERKEYS_FLAGS(0), AT, &mut effect)
                    .unwrap();
                assert_eq!(effect, DROPEFFECT_COPY);
                target
                    .Drop(&data, MODIFIERKEYS_FLAGS(0), AT, &mut effect)
                    .unwrap();
            }
            let server = DropContent::AuthServer {
                url: "https://littleskin.cn/api/yggdrasil".to_owned(),
            };
            assert_eq!(
                *events.borrow(),
                vec![
                    WindowDropEvent::Enter {
                        content: server.clone()
                    },
                    WindowDropEvent::Drop { content: server }
                ]
            );
            assert_eq!(effect, DROPEFFECT_COPY);
        }

        #[test]
        fn files_from_explorer_keep_their_full_paths() {
            let (target, events) = recording_target();
            let data = files_object(&[r"D:\Downloads\生存包.mrpack", r"C:\Users\a\RLCraft.zip"]);
            let mut effect = DROPEFFECT_NONE;
            unsafe {
                target
                    .DragEnter(&data, MODIFIERKEYS_FLAGS(0), AT, &mut effect)
                    .unwrap();
                target.DragLeave().unwrap();
            }
            assert_eq!(effect, DROPEFFECT_COPY);
            assert_eq!(
                *events.borrow(),
                vec![
                    WindowDropEvent::Enter {
                        content: DropContent::Files {
                            paths: vec![
                                r"D:\Downloads\生存包.mrpack".to_owned(),
                                r"C:\Users\a\RLCraft.zip".to_owned()
                            ]
                        }
                    },
                    WindowDropEvent::Leave,
                ]
            );
        }

        /// 别的文字（网页上的一段话、普通网址）不认：鼠标显示不可放置，拖过、拖出、松开都不推送事件。
        #[test]
        fn other_text_is_refused_without_any_event() {
            let (target, events) = recording_target();
            let data = text_object("https://littleskin.cn/api/yggdrasil");
            let mut effect = DROPEFFECT_COPY;
            unsafe {
                target
                    .DragEnter(&data, MODIFIERKEYS_FLAGS(0), AT, &mut effect)
                    .unwrap();
                assert_eq!(effect, DROPEFFECT_NONE);
                effect = DROPEFFECT_COPY;
                target
                    .DragOver(MODIFIERKEYS_FLAGS(0), AT, &mut effect)
                    .unwrap();
                assert_eq!(effect, DROPEFFECT_NONE);
                target.DragLeave().unwrap();
                target
                    .Drop(&data, MODIFIERKEYS_FLAGS(0), AT, &mut effect)
                    .unwrap();
            }
            assert_eq!(effect, DROPEFFECT_NONE);
            assert!(events.borrow().is_empty());
        }

        #[test]
        fn text_longer_than_the_cap_is_not_read() {
            let long = format!(
                "{}{}",
                super::super::AUTH_SERVER_LINK_PREFIX,
                "a".repeat(MAX_TEXT_UNITS)
            );
            let data = text_object(&long);
            assert_eq!(unsafe { read_text(&data) }, None);
            let short = text_object("你好");
            assert_eq!(unsafe { read_text(&short) }.as_deref(), Some("你好"));
        }

        /// 测试线程上的一个窗口；STATIC 是系统预注册的窗口类，不用自己注册。
        fn window(parent: Option<HWND>) -> HWND {
            unsafe {
                // 每个测试线程各自初始化；同一线程重复调用返回 S_FALSE，也算成功
                OleInitialize(None).unwrap();
                CreateWindowExW(
                    WINDOW_EX_STYLE::default(),
                    windows_core::w!("STATIC"),
                    PCWSTR::null(),
                    if parent.is_some() { WS_CHILD } else { WS_POPUP },
                    0,
                    0,
                    100,
                    100,
                    parent,
                    None,
                    None,
                    None,
                )
                .unwrap()
            }
        }

        /// 窗口上挂没挂放置目标：再注册一个探针，挂着的会报已注册；没挂的就地把探针撤掉。
        fn is_registered(hwnd: HWND) -> bool {
            let probe: IDropTarget = DropTarget::new(Rc::new(|_| {})).into();
            match unsafe { RegisterDragDrop(hwnd, &probe) } {
                Ok(()) => {
                    unsafe { RevokeDragDrop(hwnd) }.unwrap();
                    false
                }
                Err(err) if err.code() == DRAGDROP_E_ALREADYREGISTERED => true,
                Err(err) => panic!("探测放置目标失败：{err}"),
            }
        }

        /// 照 WebView2 的窗口层级搭：父窗口下一层宿主窗口，宿主下面是网页区域的子窗口。渲染进程退出后旧的网页
        /// 子窗口被销毁、下一次加载页面时换一个新的，新窗口要在页面加载完成时挂上放置目标。
        #[test]
        fn page_load_after_a_renderer_restart_registers_the_rebuilt_window() {
            let parent = window(None);
            let host = window(Some(parent));
            let page = window(Some(host));
            let registrar = Registrar::new(parent, Rc::new(|_| {}));
            assert_eq!(unsafe { registrar.sync() }.unwrap(), 2);
            assert!(is_registered(host) && is_registered(page));

            registrar.process_failed(COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_EXITED);
            assert!(registrar.rebuild_pending.get());
            unsafe { DestroyWindow(page) }.unwrap();
            let rebuilt = window(Some(host));
            assert!(!is_registered(rebuilt), "新建的子窗口上本来什么都没挂");

            unsafe { registrar.navigation_completed() };
            assert!(is_registered(rebuilt));
            assert!(is_registered(host));
            assert!(!registrar.rebuild_pending.get());
            unsafe { DestroyWindow(parent) }.unwrap();
        }

        /// 浏览器进程退出时 WebView 已经关了，不会再有新的子窗口，也就没有重挂可等。
        #[test]
        fn browser_process_exit_does_not_wait_for_a_rebuild() {
            let parent = window(None);
            let registrar = Registrar::new(parent, Rc::new(|_| {}));
            registrar.process_failed(COREWEBVIEW2_PROCESS_FAILED_KIND_BROWSER_PROCESS_EXITED);
            assert!(!registrar.rebuild_pending.get());
            registrar.process_failed(COREWEBVIEW2_PROCESS_FAILED_KIND_UTILITY_PROCESS_EXITED);
            assert!(!registrar.rebuild_pending.get());
            registrar.process_failed(COREWEBVIEW2_PROCESS_FAILED_KIND_GPU_PROCESS_EXITED);
            assert!(registrar.rebuild_pending.get());
            unsafe { DestroyWindow(parent) }.unwrap();
        }

        /// 装的那一刻一个子窗口都没挂上（没有子窗口，或撤旧、注册全失败），仍要订阅页面加载完成：
        /// 不然之后有了网页子窗口也没人去挂，这次运行里拖放一直没有反应。
        #[test]
        fn install_with_nothing_registered_still_waits_for_the_page_load() {
            let parent = window(None);
            let armed = RefCell::new(None);
            let err = unsafe {
                arm(
                    Rc::new(Registrar::new(parent, Rc::new(|_| {}))),
                    |registrar| {
                        *armed.borrow_mut() = Some(registrar);
                        Ok(())
                    },
                )
            }
            .unwrap_err();
            assert_eq!(err.code(), E_FAIL);

            let page = window(Some(parent));
            let registrar = armed
                .borrow_mut()
                .take()
                .expect("一个窗口都没挂上时也要订阅页面加载完成");
            unsafe { registrar.navigation_completed() };
            assert!(is_registered(page));
            unsafe { DestroyWindow(parent) }.unwrap();
        }

        /// 订阅失败只少了之后的重挂，眼下的子窗口照样挂上。
        #[test]
        fn failed_subscription_still_registers_the_current_windows() {
            let parent = window(None);
            let page = window(Some(parent));
            let registered = unsafe {
                arm(Rc::new(Registrar::new(parent, Rc::new(|_| {}))), |_| {
                    Err(E_NOINTERFACE.into())
                })
            }
            .unwrap();
            assert_eq!(registered, 1);
            assert!(is_registered(page));
            unsafe { DestroyWindow(parent) }.unwrap();
        }

        /// WebView2 下一个子窗口都没有时挂不上任何东西，要报错而不是当成挂好了。
        #[test]
        fn no_child_window_is_an_error() {
            let parent = window(None);
            let registrar = Registrar::new(parent, Rc::new(|_| {}));
            let err = unsafe { registrar.sync() }.unwrap_err();
            assert_eq!(err.code(), E_FAIL);
            unsafe { DestroyWindow(parent) }.unwrap();
        }

        #[test]
        fn every_failure_kind_has_a_known_impact() {
            for (kind, impact) in [
                (
                    COREWEBVIEW2_PROCESS_FAILED_KIND_BROWSER_PROCESS_EXITED,
                    FailureImpact::WebViewClosed,
                ),
                (
                    COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_EXITED,
                    FailureImpact::WindowsRebuilt,
                ),
                (
                    COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_UNRESPONSIVE,
                    FailureImpact::WindowsRebuilt,
                ),
                (
                    COREWEBVIEW2_PROCESS_FAILED_KIND_GPU_PROCESS_EXITED,
                    FailureImpact::WindowsRebuilt,
                ),
                (
                    COREWEBVIEW2_PROCESS_FAILED_KIND_UNKNOWN_PROCESS_EXITED,
                    FailureImpact::WindowsRebuilt,
                ),
                (
                    COREWEBVIEW2_PROCESS_FAILED_KIND_FRAME_RENDER_PROCESS_EXITED,
                    FailureImpact::NoWindows,
                ),
                (
                    COREWEBVIEW2_PROCESS_FAILED_KIND_UTILITY_PROCESS_EXITED,
                    FailureImpact::NoWindows,
                ),
                (
                    COREWEBVIEW2_PROCESS_FAILED_KIND_SANDBOX_HELPER_PROCESS_EXITED,
                    FailureImpact::NoWindows,
                ),
                (
                    COREWEBVIEW2_PROCESS_FAILED_KIND_PPAPI_PLUGIN_PROCESS_EXITED,
                    FailureImpact::NoWindows,
                ),
                (
                    COREWEBVIEW2_PROCESS_FAILED_KIND_PPAPI_BROKER_PROCESS_EXITED,
                    FailureImpact::NoWindows,
                ),
                // 以后的运行时新增的类型
                (
                    COREWEBVIEW2_PROCESS_FAILED_KIND(42),
                    FailureImpact::WindowsRebuilt,
                ),
            ] {
                assert_eq!(failure_impact(kind), impact, "{kind:?}");
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn auth_server_link_decodes_the_api_address() {
        assert_eq!(
            parse_auth_server_link(
                "authlib-injector:yggdrasil-server:https%3A%2F%2Flittleskin.cn%2Fapi%2Fyggdrasil"
            )
            .as_deref(),
            Some("https://littleskin.cn/api/yggdrasil")
        );
        // 浏览器拖出来的文字可能带首尾空白；没编码的地址照样能用
        assert_eq!(
            parse_auth_server_link(
                "  authlib-injector:yggdrasil-server:http://127.0.0.1:8080/api\r\n"
            )
            .as_deref(),
            Some("http://127.0.0.1:8080/api")
        );
        assert_eq!(
            parse_auth_server_link(
                "authlib-injector:yggdrasil-server:https%3A%2F%2Fskin.example%2F%E7%9A%AE%E8%82%A4"
            )
            .as_deref(),
            Some("https://skin.example/皮肤")
        );
    }

    #[test]
    fn other_text_is_not_an_auth_server_link() {
        for text in [
            "",
            "https://littleskin.cn/api/yggdrasil",
            "authlib-injector:yggdrasil-server:",
            "authlib-injector:yggdrasil-server:%20%20",
            "Authlib-Injector:yggdrasil-server:https%3A%2F%2Fa.example",
            "authlib-injector:other:https%3A%2F%2Fa.example",
            // 解码出来不是 UTF-8
            "authlib-injector:yggdrasil-server:%FF%FE",
        ] {
            assert_eq!(parse_auth_server_link(text), None, "{text:?}");
        }
    }

    #[test]
    fn files_win_over_text_and_unknown_drops_are_refused() {
        let paths = vec![r"D:\a.mrpack".to_owned()];
        assert_eq!(
            classify(
                paths.clone(),
                Some("authlib-injector:yggdrasil-server:https%3A%2F%2Fa.example")
            ),
            Some(DropContent::Files { paths })
        );
        assert_eq!(
            classify(
                Vec::new(),
                Some("authlib-injector:yggdrasil-server:https%3A%2F%2Fa.example")
            ),
            Some(DropContent::AuthServer {
                url: "https://a.example".to_owned()
            })
        );
        assert_eq!(classify(Vec::new(), Some("随便一段字")), None);
        assert_eq!(classify(Vec::new(), None), None);
    }

    /// 前端按同一个事件名订阅；两边各写一份，改了一边这里就失败。
    #[test]
    fn front_end_subscribes_to_the_same_event_name() {
        let ts = include_str!("../../src/ipc/window-drop.ts");
        assert!(
            ts.contains(&format!(
                "export const WINDOW_DROP_EVENT = \"{WINDOW_DROP_EVENT}\";"
            )),
            "app/src/ipc/window-drop.ts 里的事件名与后端不一致"
        );
    }

    /// 前端按这个形状分支：type 区分进出与松开，content.kind 区分文件与服务器链接。
    #[test]
    fn event_payload_shape_matches_the_front_end() {
        let enter = WindowDropEvent::Enter {
            content: DropContent::Files {
                paths: vec![r"D:\a.zip".to_owned()],
            },
        };
        assert_eq!(
            serde_json::to_value(&enter).unwrap(),
            serde_json::json!({ "type": "enter", "content": { "kind": "files", "paths": [r"D:\a.zip"] } })
        );
        let drop = WindowDropEvent::Drop {
            content: DropContent::AuthServer {
                url: "https://a.example".to_owned(),
            },
        };
        assert_eq!(
            serde_json::to_value(&drop).unwrap(),
            serde_json::json!({ "type": "drop", "content": { "kind": "auth_server", "url": "https://a.example" } })
        );
        assert_eq!(
            serde_json::to_value(WindowDropEvent::Leave).unwrap(),
            serde_json::json!({ "type": "leave" })
        );
    }
}
