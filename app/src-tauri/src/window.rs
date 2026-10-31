//! 主窗口的启动期处理：兜底显示，以及生产构建关闭 WebView2 浏览器加速键。
//!
//! 窗口以 `visible: false` 创建：前端在首帧渲染前读外观、写好明暗与强调色，画完第一帧才自己
//! `show()`，夜樱下也不会先闪一下白底。代价是前端一旦出错就永远不显示，所以这里留一道兜底。

use std::fmt::Display;
use std::time::Duration;

use tauri::{App, Manager};

/// 主窗口的 label，与 tauri.conf.json、能力文件一致。
pub const MAIN_WINDOW: &str = "main";

/// 窗口创建后超过这个时长仍不可见，就由后端强制显示，让前端的错误页至少能被看见。
pub const SHOW_FALLBACK: Duration = Duration::from_millis(3000);

pub fn setup_main_window(app: &App) -> Result<(), Box<dyn std::error::Error>> {
    let window = app
        .get_webview_window(MAIN_WINDOW)
        .ok_or_else(|| format!("找不到主窗口 {MAIN_WINDOW}，tauri.conf.json 与代码不一致"))?;

    // 开发构建保留刷新与开发者工具。
    #[cfg(windows)]
    if !cfg!(debug_assertions) {
        disable_browser_accelerator_keys(&window)?;
    }

    tauri::async_runtime::spawn(async move {
        show_if_still_hidden(SHOW_FALLBACK, || window.is_visible(), || window.show()).await;
    });
    Ok(())
}

/// 等 `delay` 后检查可见性，仍不可见就显示。返回是否做了强制显示。
async fn show_if_still_hidden<E: Display>(
    delay: Duration,
    is_visible: impl Fn() -> Result<bool, E>,
    show: impl Fn() -> Result<(), E>,
) -> bool {
    tokio::time::sleep(delay).await;
    match is_visible() {
        Ok(true) => false,
        Ok(false) => {
            tracing::warn!(
                delay_ms = delay.as_millis() as u64,
                "前端未在时限内显示窗口，强制显示"
            );
            if let Err(err) = show() {
                tracing::error!(error = %err, "强制显示主窗口失败");
            }
            true
        }
        Err(err) => {
            tracing::error!(error = %err, "读取主窗口可见性失败，无法判断是否需要兜底显示");
            false
        }
    }
}

/// 关闭 WebView2 的浏览器加速键：F5 / Ctrl+R 刷新、Ctrl+P 打印、Ctrl+F / F3 查找、Ctrl+加减号
/// 缩放、F12 / Ctrl+Shift+I 开发者工具与浏览器前进后退键一次全部屏蔽。页面仍收得到这些按键事件，
/// 应用自己的快捷键照常工作。Tauri 没有暴露这个开关，只能直接调 WebView2 的设置接口。
#[cfg(windows)]
fn disable_browser_accelerator_keys(window: &tauri::WebviewWindow) -> tauri::Result<()> {
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

    window.with_webview(|webview| match apply(&webview) {
        Ok(()) => tracing::info!("已关闭 WebView2 浏览器加速键"),
        // 回调在 UI 线程上异步执行，错误传不回 setup，只能记下来；后果是刷新等浏览器快捷键仍生效。
        Err(err) => tracing::error!(error = %err, "关闭 WebView2 浏览器加速键失败"),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;

    #[tokio::test]
    async fn hidden_window_is_shown_once_after_the_delay() {
        let shown = Cell::new(0);
        let started = std::time::Instant::now();
        let forced = show_if_still_hidden(
            Duration::from_millis(30),
            || Ok::<_, String>(false),
            || {
                shown.set(shown.get() + 1);
                Ok(())
            },
        )
        .await;
        assert!(forced);
        assert_eq!(shown.get(), 1);
        assert!(
            started.elapsed() >= Duration::from_millis(30),
            "不应早于时限检查"
        );
    }

    #[tokio::test]
    async fn visible_window_is_left_alone() {
        let shown = Cell::new(0);
        let forced = show_if_still_hidden(
            Duration::from_millis(1),
            || Ok::<_, String>(true),
            || {
                shown.set(shown.get() + 1);
                Ok(())
            },
        )
        .await;
        assert!(!forced);
        assert_eq!(shown.get(), 0);
    }

    #[tokio::test]
    async fn unreadable_visibility_does_not_force_show() {
        let shown = Cell::new(0);
        let forced = show_if_still_hidden(
            Duration::from_millis(1),
            || Err::<bool, _>("窗口已销毁".to_owned()),
            || {
                shown.set(shown.get() + 1);
                Ok(())
            },
        )
        .await;
        assert!(!forced);
        assert_eq!(shown.get(), 0);
    }

    /// 窗口配置是首帧不闪白与尺寸规格的落点，钉住每个键的取值。
    #[test]
    fn main_window_config_matches_shell_spec() {
        let conf: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        let window = &conf["app"]["windows"][0];
        assert_eq!(window["label"], MAIN_WINDOW);
        assert_eq!(window["width"], 1120);
        assert_eq!(window["height"], 720);
        assert_eq!(window["minWidth"], 960);
        assert_eq!(window["minHeight"], 720);
        assert_eq!(window["decorations"], false);
        assert_eq!(window["shadow"], true);
        assert_eq!(window["transparent"], false);
        assert_eq!(window["resizable"], true);
        assert_eq!(window["maximizable"], true);
        assert_eq!(window["center"], true);
        assert_eq!(window["visible"], false);
        assert_eq!(window["backgroundColor"], "#FBF7F9");
        assert_eq!(window["zoomHotkeysEnabled"], false);
    }

    /// 前端要用到的窗口与插件权限都在能力文件里；少一条，对应的 API 调用会在运行时被拒。
    /// opener 的两条给它注入的外链脚本用（target="_blank" 的链接交给系统浏览器）。前端用不到的
    /// 不授予：自更新后的重启在 Rust 侧，WebView 不需要 process 插件的权限。
    #[test]
    fn capability_grants_every_window_api_the_shell_uses() {
        let cap: serde_json::Value =
            serde_json::from_str(include_str!("../capabilities/default.json")).unwrap();
        assert_eq!(cap["windows"], serde_json::json!([MAIN_WINDOW]));
        let granted: Vec<&str> = cap["permissions"]
            .as_array()
            .unwrap()
            .iter()
            .map(|p| p.as_str().unwrap())
            .collect();
        for needed in [
            "core:default",
            "core:window:allow-minimize",
            "core:window:allow-toggle-maximize",
            "core:window:allow-close",
            "core:window:allow-destroy",
            "core:window:allow-start-dragging",
            "core:window:allow-show",
            "core:window:allow-unminimize",
            "core:window:allow-request-user-attention",
            "opener:default",
            "opener:allow-open-url",
            "dialog:allow-open",
        ] {
            assert!(granted.contains(&needed), "能力文件缺少 {needed}");
        }
        assert!(
            !granted.iter().any(|p| p.starts_with("process:")),
            "WebView 不该拿到 process 插件的权限"
        );
    }
}
