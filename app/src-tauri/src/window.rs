//! 主窗口的启动期处理：兜底显示、装上原生拖放（见 [`crate::drop`]）与渲染进程故障后的自动重载
//! （见 [`crate::renderer`]）、生产构建关闭 WebView2 浏览器加速键，以及再次启动时把窗口叫到前台。
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

    #[cfg(windows)]
    crate::drop::install(&window)?;
    #[cfg(windows)]
    crate::renderer::install(&window)?;

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

/// 再次启动时把主窗口叫到前台：最小化的先还原。窗口还没显示时 `set_focus` 不做事，前端显示时它本来就在前台。
#[cfg(windows)]
pub fn front_on_second_launch(
    app: &App,
    instance: crate::single_instance::Instance,
) -> Result<(), Box<dyn std::error::Error>> {
    let window = app
        .get_webview_window(MAIN_WINDOW)
        .ok_or_else(|| format!("找不到主窗口 {MAIN_WINDOW}，tauri.conf.json 与代码不一致"))?;
    instance.listen(move || {
        tracing::info!("又启动了一次，把已有窗口叫到前台");
        if let Err(err) = window.unminimize().and_then(|()| window.set_focus()) {
            tracing::error!(error = %err, "把主窗口叫到前台失败");
        }
    })?;
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
        // 原生拖放由 drop.rs 接管：Tauri 自带的那套只认文件，开着会占住 WebView2 的放置目标
        assert_eq!(window["dragDropEnabled"], false);
    }

    /// 前端要用到的窗口与插件权限都在能力文件里；少一条，对应的 API 调用会在运行时被拒。
    /// opener 的两条给它注入的外链脚本用（target="_blank" 的链接交给系统浏览器）：一条放行 open_url 命令，
    /// 一条给出 http(s)、mailto、tel 的地址范围。前端用不到的不授予：自更新后的重启在 Rust 侧，WebView
    /// 不需要 process 插件的权限；恢复最小化的窗口走不激活窗口的后端命令，WebView 不需要会激活窗口的
    /// unminimize；打开文件夹与在文件夹里选中都走后端命令，WebView 不需要 opener 的 reveal_item_in_dir——
    /// 它不受任何路径范围约束，`opener:default` 会连它一起授予，页面里一段注入的脚本就能让资源管理器定位到
    /// 任意路径。核心权限也逐条列出、不用 `core:default`：整套默认集还放行路径解析、事件发送、菜单、托盘等
    /// 命令，前端一条都不用，页面里注入的脚本却能借它们探路径、伪造事件。
    ///
    /// 授予清单按全集比对，不只查缺：只查缺时，单独加一条 `core:event:allow-emit` 或
    /// `core:path:allow-resolve-directory` 测试照样通过，收窄就悄悄退回去了。新调用 `@tauri-apps/api` 的接口时，
    /// 能力文件与这里的清单一起改。
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
        let mut expected = vec![
            "core:event:allow-listen",
            "core:event:allow-unlisten",
            "core:window:allow-is-maximized",
            "core:window:allow-is-minimized",
            "core:window:allow-is-focused",
            "core:window:allow-internal-toggle-maximize",
            "core:window:allow-minimize",
            "core:window:allow-toggle-maximize",
            "core:window:allow-close",
            "core:window:allow-destroy",
            "core:window:allow-start-dragging",
            "core:window:allow-show",
            "core:window:allow-request-user-attention",
            // 调试构建里 Ctrl+Shift+I 的注入脚本调用它；发布构建不编译这条命令，授权没有作用。
            "core:webview:allow-internal-toggle-devtools",
            "opener:allow-open-url",
            "opener:allow-default-urls",
            "dialog:allow-open",
            "dialog:allow-save",
        ];
        for unneeded in ["opener:default", "opener:allow-reveal-item-in-dir"] {
            assert!(
                !granted.contains(&unneeded),
                "WebView 不该拿到 {unneeded}：它会放行不受路径范围约束的 reveal_item_in_dir"
            );
        }
        assert!(
            !granted.iter().any(|p| p.starts_with("process:")),
            "WebView 不该拿到 process 插件的权限"
        );
        assert!(
            !granted.contains(&"core:window:allow-unminimize"),
            "WebView 不该拿到会激活窗口的 unminimize"
        );
        let defaults: Vec<&&str> = granted.iter().filter(|p| p.ends_with(":default")).collect();
        assert!(
            defaults.is_empty(),
            "WebView 不该拿到整套默认权限集：{defaults:?}"
        );
        let mut granted = granted;
        granted.sort_unstable();
        expected.sort_unstable();
        assert_eq!(
            granted, expected,
            "能力文件的授予清单与前端实际调用的命令不一致"
        );
    }

    /// 内嵌前端的内容安全策略：脚本只认打包进来的文件，页面只能连 IPC 与材质协议。策略被删掉或误放开
    /// 时，注入进页面的一段文字就能执行脚本、把数据发到任意主机。
    ///
    /// 每条指令按来源全集比对，也不许多出指令：只拦 `*`、`https:` 这类通配时，往 script-src 或
    /// connect-src 里加一个具体的远端主机测试照样通过，而页面本来就不直连任何远端（远端图片由后端下载、
    /// 经材质协议提供）。新增运行期来源时，策略与这里一起改。
    #[test]
    fn content_security_policy_stays_strict() {
        let conf: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        let csp = conf["app"]["security"]["csp"]
            .as_object()
            .expect("app.security.csp 应是按指令写的对象");
        let actual: std::collections::BTreeMap<&str, Vec<&str>> = csp
            .iter()
            .map(|(name, value)| {
                let mut sources: Vec<&str> = value
                    .as_str()
                    .unwrap_or_else(|| panic!("{name} 应是空格分隔的来源串"))
                    .split_whitespace()
                    .collect();
                sources.sort_unstable();
                (name.as_str(), sources)
            })
            .collect();
        let texture_host = format!("http://{}.localhost", crate::textures::SCHEME);
        let texture_scheme = format!("{}:", crate::textures::SCHEME);
        let mut connect = vec![
            "'self'",
            "ipc:",
            "http://ipc.localhost",
            texture_scheme.as_str(),
            texture_host.as_str(),
            // 服务器图标是 data: 地址，同样经 fetch 取字节画进 canvas。
            "data:",
        ];
        connect.sort_unstable();
        let expected = std::collections::BTreeMap::from([
            ("default-src", vec!["'none'"]),
            ("script-src", vec!["'self'"]),
            // framer-motion 的 popLayout 往空 <style> 里 insertRule，严格的 style-src 下规则不生效。
            ("style-src", vec!["'self'", "'unsafe-inline'"]),
            ("img-src", vec!["'self'"]),
            ("font-src", vec!["'self'"]),
            ("connect-src", connect),
            ("base-uri", vec!["'none'"]),
            ("form-action", vec!["'none'"]),
            ("frame-ancestors", vec!["'none'"]),
        ]);
        assert_eq!(actual, expected, "内容安全策略与页面实际用到的来源不一致");
    }
}
