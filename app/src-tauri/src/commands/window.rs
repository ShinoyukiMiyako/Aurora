//! 主窗口上 Tauri 的窗口 API 做不到、要直接调系统接口的操作。

use tauri::WebviewWindow;

use crate::commands::error::{code, CommandError};

/// 恢复最小化的主窗口而不激活它：游戏退出或崩溃时用户多半正在别的窗口里做事，启动器回到桌面上等着被看见，
/// 键盘焦点留在用户手里；要招呼用户时由任务栏提醒去闪。窗口没有最小化时什么都不做。
///
/// Tauri 的 `unminimize` 在 Windows 上走 `ShowWindow(SW_RESTORE)`，那会激活窗口，所以 Windows 上自己调
/// `SW_SHOWNOACTIVATE`。其他平台的 tao 没有不激活的还原，退回 Tauri 的 `unminimize`，抢不抢焦点随平台而定。
#[tauri::command]
pub async fn restore_window_without_focus(window: WebviewWindow) -> Result<(), CommandError> {
    restore(window).await
}

#[cfg(windows)]
async fn restore(window: WebviewWindow) -> Result<(), CommandError> {
    let (done, outcome) = tokio::sync::oneshot::channel();
    let target = window.clone();
    // tao 的窗口状态只在 UI 线程上改；还原与随后的校正放进同一个回调，中间插不进别的窗口消息。
    window
        .run_on_main_thread(move || {
            if let Err(Err(err)) = done.send(restore_on_ui_thread(&target)) {
                tracing::warn!(message = %err.message, "恢复窗口失败，命令已不再等结果");
            }
        })
        .map_err(window_error)?;
    outcome
        .await
        .map_err(|_| CommandError::new(code::INTERNAL, "事件循环已退出，窗口没有恢复"))?
}

#[cfg(windows)]
fn restore_on_ui_thread(window: &WebviewWindow) -> Result<(), CommandError> {
    let hwnd = window.hwnd().map_err(window_error)?;
    if native::restore_inactive(hwnd) {
        // tao 只在自己最小化、还原或收到系统菜单的最小化、还原时记下窗口最小化着，绕过它恢复之后它仍以为
        // 窗口最小化着，而它的 set_focus 与任务栏提醒都看这个记录。它的 set_minimized(false) 先按 IsIconic
        // 校正记录再比较新旧状态，窗口此刻已经恢复，所以这一步只改记录、不再调 ShowWindow，不会激活窗口。
        window.unminimize().map_err(window_error)?;
    }
    Ok(())
}

#[cfg(not(windows))]
async fn restore(window: WebviewWindow) -> Result<(), CommandError> {
    if window.is_minimized().map_err(window_error)? {
        window.unminimize().map_err(window_error)?;
    }
    Ok(())
}

/// 窗口操作失败只在窗口已销毁或事件循环已退出时发生，不是用户能处理的情况。
fn window_error(err: tauri::Error) -> CommandError {
    let message = format!("恢复窗口失败：{err}");
    tracing::warn!(%message, "窗口命令失败");
    CommandError::new(code::INTERNAL, message)
}

#[cfg(windows)]
mod native {
    use windows::Win32::Foundation::HWND;
    use windows::Win32::UI::WindowsAndMessaging::{IsIconic, ShowWindow, SW_SHOWNOACTIVATE};

    /// 窗口最小化着就以 `SW_SHOWNOACTIVATE` 恢复到最小化之前的样子，不激活，返回是否恢复了。
    /// 没有最小化的窗口不碰：对最大化着的窗口发 `SW_SHOWNOACTIVATE` 会把它还原成普通大小。
    pub fn restore_inactive(hwnd: HWND) -> bool {
        // SAFETY: 两个调用只按句柄读写系统里的窗口状态，不触碰调用方的内存；句柄无效时 IsIconic 返回 FALSE。
        unsafe {
            if !IsIconic(hwnd).as_bool() {
                return false;
            }
            // 返回值是调用之前窗口是否可见，不表示成败
            let _ = ShowWindow(hwnd, SW_SHOWNOACTIVATE);
        }
        true
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        use windows::core::w;
        use windows::Win32::UI::WindowsAndMessaging::{
            CreateWindowExW, DestroyWindow, GetGUIThreadInfo, GetWindowThreadProcessId,
            IsWindowVisible, IsZoomed, GUITHREADINFO, SW_SHOWMAXIMIZED, SW_SHOWMINNOACTIVE,
            WINDOW_EX_STYLE, WS_OVERLAPPEDWINDOW,
        };

        /// 测试线程自己的顶层窗口，用完销毁。用系统预定义的 STATIC 窗口类，不必注册窗口类。
        struct TestWindow(HWND);

        impl TestWindow {
            fn new() -> Self {
                // SAFETY: 类名与标题是静态的宽字符串，其余参数都是值；窗口属于当前测试线程。
                let hwnd = unsafe {
                    CreateWindowExW(
                        WINDOW_EX_STYLE::default(),
                        w!("STATIC"),
                        w!("restore test"),
                        WS_OVERLAPPEDWINDOW,
                        100,
                        100,
                        400,
                        300,
                        None,
                        None,
                        None,
                        None,
                    )
                }
                .expect("创建测试窗口");
                Self(hwnd)
            }

            fn show(&self, cmd: windows::Win32::UI::WindowsAndMessaging::SHOW_WINDOW_CMD) {
                // SAFETY: 句柄是本线程刚创建、尚未销毁的窗口。
                let _ = unsafe { ShowWindow(self.0, cmd) };
            }

            fn minimized(&self) -> bool {
                // SAFETY: 同上。
                unsafe { IsIconic(self.0) }.as_bool()
            }

            fn maximized(&self) -> bool {
                // SAFETY: 同上。
                unsafe { IsZoomed(self.0) }.as_bool()
            }

            fn visible(&self) -> bool {
                // SAFETY: 同上。
                unsafe { IsWindowVisible(self.0) }.as_bool()
            }

            /// 窗口所属线程此刻的活动窗口。测试进程多半不在前台，前台窗口看不出激活与否，线程的活动窗口看得出。
            fn is_active(&self) -> bool {
                let mut info = GUITHREADINFO {
                    cbSize: std::mem::size_of::<GUITHREADINFO>() as u32,
                    ..Default::default()
                };
                // SAFETY: info 是本函数栈上的结构体，cbSize 已按要求填好。
                unsafe {
                    let thread = GetWindowThreadProcessId(self.0, None);
                    GetGUIThreadInfo(thread, &mut info).expect("读线程的活动窗口");
                }
                info.hwndActive == self.0
            }
        }

        impl Drop for TestWindow {
            fn drop(&mut self) {
                // SAFETY: 句柄是本线程创建的窗口，只销毁这一次。
                if let Err(err) = unsafe { DestroyWindow(self.0) } {
                    eprintln!("销毁测试窗口失败：{err}");
                }
            }
        }

        #[test]
        fn minimized_window_comes_back_without_being_activated() {
            let window = TestWindow::new();
            window.show(SW_SHOWMINNOACTIVE);
            assert!(window.minimized());
            assert!(!window.is_active());

            assert!(restore_inactive(window.0));
            assert!(!window.minimized());
            assert!(window.visible());
            assert!(!window.is_active(), "恢复不该激活窗口");
        }

        #[test]
        fn window_maximized_before_minimizing_comes_back_maximized() {
            let window = TestWindow::new();
            window.show(SW_SHOWMAXIMIZED);
            window.show(SW_SHOWMINNOACTIVE);
            assert!(window.minimized());

            assert!(restore_inactive(window.0));
            assert!(!window.minimized());
            assert!(window.maximized(), "应恢复成最小化之前的最大化");
        }

        #[test]
        fn window_that_is_not_minimized_is_left_alone() {
            let window = TestWindow::new();
            window.show(SW_SHOWMAXIMIZED);
            assert!(window.maximized());

            assert!(!restore_inactive(window.0));
            assert!(window.maximized(), "没最小化的窗口不该被还原成普通大小");
        }
    }
}
