//! 主窗口的启动期处理：兜底显示、装上原生拖放（见 [`crate::drop`]）、渲染进程故障后的自动重载
//! （见 [`crate::renderer`]）与最小化时的页面可见性（见 [`crate::page_visibility`]）、生产构建关闭
//! WebView2 浏览器加速键，再次启动时把窗口叫到前台，以及更新安装程序没拉起来时把藏起的窗口重新显示出来。
//!
//! 窗口以 `visible: false` 创建：前端在首帧渲染前读外观、写好明暗与强调色，画完第一帧才自己
//! 显示窗口，夜樱下也不会先闪一下白底。代价是前端一旦出错就永远不显示，所以这里留一道兜底。显示都经
//! [`crate::window_state::reveal`]：上次关掉时是最大化的，要直接最大化地显示。

use std::fmt::Display;
use std::time::Duration;

use tauri::{App, AppHandle, Manager};

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
    #[cfg(windows)]
    crate::page_visibility::install(&window);

    // 开发构建保留刷新与开发者工具。
    #[cfg(windows)]
    if !cfg!(debug_assertions) {
        disable_browser_accelerator_keys(&window)?;
    }

    tauri::async_runtime::spawn(async move {
        show_if_still_hidden(
            SHOW_FALLBACK,
            || window.is_visible(),
            || crate::window_state::reveal_later(&window),
        )
        .await;
    });
    Ok(())
}

/// 再次启动时把主窗口叫到前台：最小化的先还原。窗口还没显示时 `set_focus` 不做事，前端显示时它本来就在前台。
///
/// 还原与取得焦点是投递给事件循环的消息，窗口已经销毁时被静默丢掉、照样报成功；读一次可见性要等事件循环
/// 回话，窗口不在就报错。读到了才算叫到了前台，这时才让后来者退出；正在退出时读不到，后来者等这个进程退出后接手。
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
        fronted(
            || window.unminimize().and_then(|()| window.set_focus()),
            || window.is_visible(),
        )
    })?;
    Ok(())
}

/// 把主窗口重新显示并取得焦点，等 UI 线程做完才返回。
///
/// 更新插件拉起安装程序之前先跑 tauri 的 `cleanup_before_exit`，它在 Windows 上把每个窗口都藏起来；
/// 拉不起来时插件返回错误、进程接着跑，窗口不重新显示，用户就看不到报错。显示经
/// [`crate::window_state::reveal`]，它只能在 UI 线程上调。
pub async fn reshow_main_window(app: &AppHandle) -> tauri::Result<()> {
    let window = app
        .get_webview_window(MAIN_WINDOW)
        .ok_or(tauri::Error::WindowNotFound)?;
    let (done, shown) = tokio::sync::oneshot::channel();
    let target = window.clone();
    window.run_on_main_thread(move || {
        let result = crate::window_state::reveal(&target).and_then(|()| target.set_focus());
        if let Err(Err(err)) = done.send(result) {
            tracing::warn!(error = %err, "重新显示主窗口失败，调用方已不再等结果");
        }
    })?;
    // 回调没跑就被丢掉，只会是事件循环已经退出。
    shown
        .await
        .map_err(|_| tauri::Error::FailedToReceiveMessage)?
}

/// 先叫窗口，再读一次可见性：读到了才算叫到了前台。可见与否不论，窗口还没显示时前端显示出来本来就在前台。
#[cfg(windows)]
fn fronted<E: Display>(
    front: impl FnOnce() -> Result<(), E>,
    is_visible: impl FnOnce() -> Result<bool, E>,
) -> bool {
    match front().and_then(|()| is_visible()) {
        Ok(_) => true,
        Err(err) => {
            tracing::warn!(
                error = %err,
                "没能把主窗口叫到前台，多半是窗口已关、正在退出：新启动的落樱等这个进程退出后接手，\
                 等满 15 秒还没退出就不再等，自行退出"
            );
            false
        }
    }
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
        // 这个读取只在窗口已销毁或事件循环已退出时失败，时限内正常关窗就会走到这里：没有窗口要兜底，也不是故障。
        Err(err) => {
            tracing::debug!(error = %err, "读取主窗口可见性失败，按窗口已关闭处理");
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

    /// 先叫窗口再读可见性，读到了（可见与否不论）才应答；叫完读不到说明窗口已经没了，不应答，后来者等着接手。
    /// 只看叫窗口的结果不够：窗口销毁之后叫它照样报成功。
    #[cfg(windows)]
    #[test]
    fn only_a_window_that_still_answers_counts_as_fronted() {
        let order = std::cell::RefCell::new(Vec::new());
        let front = || {
            order.borrow_mut().push("front");
            Ok::<_, String>(())
        };
        assert!(fronted(front, || {
            order.borrow_mut().push("read");
            Ok(false)
        }));
        assert_eq!(*order.borrow(), ["front", "read"], "要在叫完之后读");

        assert!(!fronted(
            || Ok::<_, String>(()),
            || Err("窗口已销毁".to_owned())
        ));

        let read = Cell::new(false);
        assert!(!fronted(
            || Err("事件循环已退出".to_owned()),
            || {
                read.set(true);
                Ok(true)
            }
        ));
        assert!(!read.get(), "叫窗口失败就不必再读");
    }

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

    /// 启动后三秒内正常关窗，可见性就读不出来了。这是常态，不能在日志里多一条 ERROR 让人以为出了故障，
    /// 失败原因留在 debug 级。
    #[tokio::test]
    async fn unreadable_visibility_means_the_window_closed() {
        let captured = crate::tests::Captured::new();
        let writer = captured.clone();
        let subscriber = tracing_subscriber::fmt()
            .with_ansi(false)
            .with_max_level(tracing::Level::DEBUG)
            .with_writer(move || writer.clone())
            .finish();
        let _guard = tracing::subscriber::set_default(subscriber);

        let shown = Cell::new(0);
        let forced = show_if_still_hidden(
            Duration::from_millis(1),
            || Err::<bool, _>("failed to receive message from webview".to_owned()),
            || {
                shown.set(shown.get() + 1);
                Ok(())
            },
        )
        .await;
        assert!(!forced);
        assert_eq!(shown.get(), 0);

        let log = String::from_utf8(captured.0.lock().unwrap().clone()).unwrap();
        assert!(!log.contains("ERROR"), "{log}");
        assert!(log.contains("DEBUG"), "{log}");
        assert!(log.contains("读取主窗口可见性失败"), "{log}");
        assert!(
            log.contains("failed to receive message from webview"),
            "{log}"
        );
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
    /// unminimize；首帧后显示窗口走后端命令（上次是最大化的要直接最大化地显示），WebView 不需要 show；
    /// 打开文件夹与在文件夹里选中都走后端命令，WebView 不需要 opener 的 reveal_item_in_dir——
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
        assert!(
            !granted.contains(&"core:window:allow-show"),
            "WebView 不该拿到 show：显示要经后端按上次的状态决定是否最大化"
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
