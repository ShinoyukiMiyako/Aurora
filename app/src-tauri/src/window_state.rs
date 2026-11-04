//! 主窗口记住大小、位置与是否最大化，下次启动按记下的样子摆回去。
//!
//! 记的是常态（非最大化）时客户区在屏幕上的物理矩形、当时的缩放比例和是否最大化，存在数据目录的
//! [`WINDOW_STATE_FILE`]。最小化不记：最小化期间的变化一律忽略，坐标不会记成 -32000，最大化后最小化再关掉，
//! 下次仍是最大化。
//!
//! 启动时窗口还隐藏着（见 [`crate::window`]），在这里摆好：目标屏取与记下的矩形重叠最多的那块，尺寸按逻辑
//! 像素换到目标屏现在的缩放，再整个夹进那块屏的工作区；哪块屏都不重叠（显示器拔了、排列换了）就居中到主
//! 显示器。文件读不出、内容不对按首次启动处理，不拦启动。
//!
//! 最大化不能在隐藏时交给 Tauri：tao 对隐藏的窗口最大化是先 `SW_MAXIMIZE`（显示并激活）再 `SW_HIDE`，前端
//! 还没画第一帧，窗口就先闪一下底色，激活权也落到了别的窗口上。所以隐藏期间先把窗口撑到工作区大小，让前端
//! 按最大化的尺寸排版；显示时（[`reveal`]）一次 `SetWindowPlacement(SW_SHOWMAXIMIZED)` 直接最大化地显示，
//! 还原矩形同时设成记下的常态矩形。
//!
//! 窗口停止变化 [`WRITE_DELAY`] 后写一次，退出时再补一次（[`flush_on_exit`]）：只在退出时写的话，进程被
//! 结束或崩溃就丢了这次的改动。

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{
    AppHandle, LogicalSize, Manager, Monitor, PhysicalPosition, WebviewWindow, WindowEvent,
};
use tokio::sync::Notify;

use crate::commands::error::source_chain;
use crate::window::MAIN_WINDOW;

/// 数据目录下的窗口状态文件名。卸载时的删除名单按它删（installer-hooks.nsh）。
pub const WINDOW_STATE_FILE: &str = "window-state.json";

/// 文件格式版本。字段含义变了就加一，旧文件按读不出处理。
const FORMAT: u32 = 1;

/// 窗口停止变化这么久之后写文件：拖动、缩放时事件一个接一个，不必每个都写。
pub const WRITE_DELAY: Duration = Duration::from_secs(1);

/// 退出时补写最多等这么久。文件只有几十字节，磁盘或杀毒软件卡住时不能让窗口关掉之后的进程一直挂着。
pub const EXIT_DEADLINE: Duration = Duration::from_secs(1);

/// 记下的宽高超过这个值就当文件坏了：没有这么大的屏，而且后面的坐标运算要留出余量。
const MAX_EDGE: u32 = 1 << 16;

/// 屏幕上的一块物理像素矩形。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Rect {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}

impl Rect {
    /// 与 `other` 重叠部分的面积，不重叠为 0。
    fn overlap(&self, other: &Rect) -> i64 {
        let span = |a: i32, a_len: u32, b: i32, b_len: u32| {
            let start = i64::from(a).max(i64::from(b));
            let end = (i64::from(a) + i64::from(a_len)).min(i64::from(b) + i64::from(b_len));
            (end - start).max(0)
        };
        span(self.x, self.width, other.x, other.width)
            * span(self.y, self.height, other.y, other.height)
    }
}

/// 记下的窗口状态，也是文件里的内容。
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
pub struct Saved {
    /// 常态时客户区左上角的屏幕物理坐标。
    pub x: i32,
    pub y: i32,
    /// 常态时客户区的物理宽高。
    pub width: u32,
    pub height: u32,
    /// 记下时窗口的缩放比例：换到缩放不同的屏、或这块屏改了缩放，据此保持窗口看起来一样大。
    pub scale: f64,
    pub maximized: bool,
}

impl Saved {
    fn client(&self) -> Rect {
        Rect {
            x: self.x,
            y: self.y,
            width: self.width,
            height: self.height,
        }
    }

    fn from_client(client: Rect, scale: f64, maximized: bool) -> Self {
        Self {
            x: client.x,
            y: client.y,
            width: client.width,
            height: client.height,
            scale,
            maximized,
        }
    }

    fn check(&self) -> Result<(), String> {
        if self.width == 0 || self.height == 0 || self.width > MAX_EDGE || self.height > MAX_EDGE {
            return Err(format!("窗口尺寸 {}x{} 不合理", self.width, self.height));
        }
        if !(self.scale.is_finite() && self.scale > 0.0) {
            return Err(format!("缩放比例 {} 不合理", self.scale));
        }
        Ok(())
    }
}

#[derive(Serialize, Deserialize)]
struct StateFile {
    format: u32,
    #[serde(flatten)]
    window: Saved,
}

/// 读窗口状态文件。没有文件是首次启动，返回 `None`；读不出、内容不对返回原因。
fn read(path: &Path) -> Result<Option<Saved>, String> {
    let bytes = match std::fs::read(path) {
        Ok(bytes) => bytes,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(err) => return Err(format!("读取失败：{err}")),
    };
    let file: StateFile =
        serde_json::from_slice(&bytes).map_err(|err| format!("内容不是窗口状态：{err}"))?;
    if file.format != FORMAT {
        return Err(format!("不认识的格式版本 {}", file.format));
    }
    file.window.check()?;
    Ok(Some(file.window))
}

/// 读窗口状态，读不出就按首次启动处理：这只是窗口摆在哪，拦下启动不值得。坏文件不留存，下次写入时覆盖。
fn load(path: &Path) -> Option<Saved> {
    match read(path) {
        Ok(Some(saved)) => Some(saved),
        Ok(None) => {
            tracing::debug!(path = %path.display(), "没有窗口状态文件，按默认尺寸居中启动");
            None
        }
        Err(reason) => {
            tracing::warn!(
                path = %path.display(),
                %reason,
                "窗口状态读不出来，按默认尺寸居中启动，下次记录时覆盖它"
            );
            None
        }
    }
}

/// 一块显示器：工作区（去掉任务栏）与缩放比例。
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Screen {
    pub work: Rect,
    pub scale: f64,
}

impl From<&Monitor> for Screen {
    fn from(monitor: &Monitor) -> Self {
        let work = monitor.work_area();
        Self {
            work: Rect {
                x: work.position.x,
                y: work.position.y,
                width: work.size.width,
                height: work.size.height,
            },
            scale: monitor.scale_factor(),
        }
    }
}

/// 启动时要把窗口摆成的样子。
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Placement {
    /// 常态时客户区的物理矩形。
    pub client: Rect,
    /// 目标屏的缩放比例。
    pub scale: f64,
    /// 目标屏的工作区，最大化时窗口撑满它。
    pub work: Rect,
    pub maximized: bool,
}

impl Placement {
    fn saved(&self) -> Saved {
        Saved::from_client(self.client, self.scale, self.maximized)
    }
}

/// 按记下的状态和眼下的显示器算出窗口摆在哪。`min` 是窗口配置里客户区的最小逻辑尺寸。
///
/// 窗口整个落在目标屏的工作区里：落樱是自绘标题栏，标题栏一旦在屏幕上沿外或被任务栏压住就拖不回来。
/// 工作区比最小尺寸还小时贴工作区左上，至少标题栏在屏上。
pub fn place(saved: &Saved, screens: &[Screen], primary: &Screen, min: (f64, f64)) -> Placement {
    let rect = saved.client();
    let anchored = screens
        .iter()
        .map(|screen| (screen, rect.overlap(&screen.work)))
        .filter(|(_, area)| *area > 0)
        .max_by_key(|(_, area)| *area)
        .map(|(screen, _)| *screen);
    let screen = anchored.unwrap_or(*primary);
    let work = screen.work;
    let ratio = screen.scale / saved.scale;
    let width = fit(
        f64::from(saved.width) * ratio,
        min.0 * screen.scale,
        work.width,
    );
    let height = fit(
        f64::from(saved.height) * ratio,
        min.1 * screen.scale,
        work.height,
    );
    let (x, y) = match anchored {
        Some(_) => (i64::from(saved.x), i64::from(saved.y)),
        None => (
            i64::from(work.x) + (i64::from(work.width) - i64::from(width)) / 2,
            i64::from(work.y) + (i64::from(work.height) - i64::from(height)) / 2,
        ),
    };
    Placement {
        client: Rect {
            x: clamp_into(x, width, work.x, work.width),
            y: clamp_into(y, height, work.y, work.height),
            width,
            height,
        },
        scale: screen.scale,
        work,
        maximized: saved.maximized,
    }
}

/// 尺寸不超过可用的长度、不小于最小尺寸；两者冲突时最小尺寸优先，系统本来也不让窗口小于它。
fn fit(size: f64, min: f64, available: u32) -> u32 {
    size.round().min(f64::from(available)).max(min.round()) as u32
}

/// 让 `[pos, pos + size)` 落进 `[start, start + extent)`；放不下时贴着起点。
fn clamp_into(pos: i64, size: u32, start: i32, extent: u32) -> i32 {
    let start = i64::from(start);
    let last = start + i64::from(extent) - i64::from(size);
    (if last < start {
        start
    } else {
        pos.clamp(start, last)
    }) as i32
}

/// 窗口事件到来时窗口此刻的样子。
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Frame {
    Minimized,
    Maximized,
    Normal { client: Rect, scale: f64 },
}

/// 按窗口此刻的样子更新记录，返回记录是否变了。最小化不改记录；最大化只改标志，常态矩形留着给下次还原用。
fn observe(record: &mut Option<Saved>, frame: Frame) -> bool {
    let next = match (frame, record.as_ref()) {
        (Frame::Minimized, _) => return false,
        (Frame::Maximized, Some(saved)) => Saved {
            maximized: true,
            ..*saved
        },
        // 还不知道常态矩形：没有值得记的东西
        (Frame::Maximized, None) => return false,
        (Frame::Normal { client, scale }, _) => Saved::from_client(client, scale, false),
    };
    if record.as_ref() == Some(&next) {
        return false;
    }
    *record = Some(next);
    true
}

/// 外框相对客户区多出的四边量好后，把客户区 `client` 换成外框矩形。无边框带阴影的窗口外框比客户区多一圈
/// 看不见的缩放边。
fn frame_around(
    client: Rect,
    outer: (PhysicalPosition<i32>, tauri::PhysicalSize<u32>),
    inner: (PhysicalPosition<i32>, tauri::PhysicalSize<u32>),
) -> Rect {
    let left = inner.0.x - outer.0.x;
    let top = inner.0.y - outer.0.y;
    let extra_width = outer.1.width.saturating_sub(inner.1.width);
    let extra_height = outer.1.height.saturating_sub(inner.1.height);
    Rect {
        x: client.x - left,
        y: client.y - top,
        width: client.width + extra_width,
        height: client.height + extra_height,
    }
}

/// 等到 `delay` 之内不再有新的变化为止。
async fn settle(changed: &Notify, delay: Duration) {
    while tokio::time::timeout(delay, changed.notified())
        .await
        .is_ok()
    {}
}

/// 主窗口状态的记录，managed state。
#[derive(Clone)]
pub struct WindowMemory(Arc<Shared>);

struct Shared {
    path: PathBuf,
    tracking: Mutex<Tracking>,
    changed: Notify,
    /// 写文件时一直占着：延迟写与退出补写不会交错，旧内容也不会在新内容之后落盘。
    write: tokio::sync::Mutex<()>,
}

struct Tracking {
    record: Option<Saved>,
    /// 记录变了、还没写进文件。启动时摆出来的样子不算：没动过就不写，文件保持原样。
    dirty: bool,
    /// 窗口显示之前的事件是启动期自己摆位置引起的，不记：要最大化时窗口隐藏着撑到了工作区大小，
    /// 那不是常态矩形。
    armed: bool,
    /// 要最大化显示时的常态客户区矩形，显示时用一次。
    pending_maximize: Option<Rect>,
}

impl WindowMemory {
    fn new(path: PathBuf, record: Option<Saved>, pending_maximize: Option<Rect>) -> Self {
        Self(Arc::new(Shared {
            path,
            tracking: Mutex::new(Tracking {
                record,
                dirty: false,
                armed: false,
                pending_maximize,
            }),
            changed: Notify::new(),
            write: tokio::sync::Mutex::new(()),
        }))
    }

    fn tracking(&self) -> std::sync::MutexGuard<'_, Tracking> {
        self.0
            .tracking
            .lock()
            .expect("窗口状态的锁在持有时 panic 过")
    }

    fn armed(&self) -> bool {
        self.tracking().armed
    }

    fn observe(&self, frame: Frame) {
        let mut tracking = self.tracking();
        if tracking.armed && observe(&mut tracking.record, frame) {
            tracking.dirty = true;
            self.0.changed.notify_one();
        }
    }

    /// 开始记录。首次启动时还没有记录，用窗口此刻的样子垫底，但不写：没动过的窗口下次照样居中。
    fn arm(&self, seed: impl FnOnce() -> tauri::Result<Frame>) {
        let mut tracking = self.tracking();
        if tracking.armed {
            return;
        }
        tracking.armed = true;
        if tracking.record.is_none() {
            match seed() {
                Ok(frame) => {
                    observe(&mut tracking.record, frame);
                }
                Err(err) => {
                    tracing::error!(error = %err, "读取主窗口状态失败，等窗口下次变化时再记")
                }
            }
        }
    }

    fn take_pending_maximize(&self) -> Option<Rect> {
        self.tracking().pending_maximize.take()
    }

    /// 记录变了就写进文件，返回是否写了。写失败时记录仍算没写，下次变化或退出时再写。
    pub async fn flush(&self) -> petalfall_base::Result<bool> {
        let _write = self.0.write.lock().await;
        let record = {
            let mut tracking = self.tracking();
            match (tracking.dirty, tracking.record) {
                (true, Some(record)) => {
                    tracking.dirty = false;
                    record
                }
                _ => return Ok(false),
            }
        };
        let file = StateFile {
            format: FORMAT,
            window: record,
        };
        let bytes =
            serde_json::to_vec_pretty(&file).expect("只有整数、有限小数与布尔值，序列化不会失败");
        if let Err(err) = petalfall_base::fs::atomic_write(&self.0.path, &bytes).await {
            self.tracking().dirty = true;
            return Err(err);
        }
        Ok(true)
    }

    async fn write_when_settled(self, delay: Duration) {
        loop {
            self.0.changed.notified().await;
            settle(&self.0.changed, delay).await;
            match self.flush().await {
                Ok(true) => tracing::debug!("已记下主窗口状态"),
                Ok(false) => {}
                Err(err) => tracing::error!(
                    error = %err,
                    causes = ?source_chain(&err),
                    "记下主窗口状态失败，下次窗口变化或退出时再写"
                ),
            }
        }
    }
}

/// 在 setup 里、主窗口显示之前调用：按记下的状态摆好窗口，开始跟踪它的变化。
pub fn install(
    app: &tauri::App,
    data_dir: &Path,
) -> Result<WindowMemory, Box<dyn std::error::Error>> {
    let window = app
        .get_webview_window(MAIN_WINDOW)
        .ok_or_else(|| format!("找不到主窗口 {MAIN_WINDOW}，tauri.conf.json 与代码不一致"))?;
    let path = data_dir.join(WINDOW_STATE_FILE);
    let (record, pending_maximize) = match load(&path) {
        Some(saved) => restore(&window, &saved).unwrap_or_else(|err| {
            // 只在窗口已销毁或事件循环已退出时发生；窗口照常按默认位置出来，不拦启动
            tracing::error!(error = %err, ?saved, "按上次的状态摆主窗口失败，按默认尺寸居中启动");
            (None, None)
        }),
        None => (None, None),
    };
    let memory = WindowMemory::new(path, record, pending_maximize);
    let target = window.clone();
    let tracked = memory.clone();
    window.on_window_event(move |event| {
        if !matches!(
            event,
            WindowEvent::Moved(_)
                | WindowEvent::Resized(_)
                | WindowEvent::ScaleFactorChanged { .. }
        ) || !tracked.armed()
        {
            return;
        }
        // 读窗口此刻的样子，不用事件里带的值：最大化、最小化时尺寸与位置的事件分几次到，读当下才不会错
        match capture(&target) {
            Ok(frame) => tracked.observe(frame),
            Err(err) => tracing::error!(error = %err, "读取主窗口状态失败，这次变化不记"),
        }
    });
    tauri::async_runtime::spawn(memory.clone().write_when_settled(WRITE_DELAY));
    Ok(memory)
}

/// 把隐藏着的窗口摆成记下的样子，返回此刻的记录与要最大化显示时的常态矩形。
fn restore(window: &WebviewWindow, saved: &Saved) -> tauri::Result<(Option<Saved>, Option<Rect>)> {
    let screens: Vec<Screen> = window
        .available_monitors()?
        .iter()
        .map(Screen::from)
        .collect();
    let Some(primary) = window.primary_monitor()? else {
        tracing::warn!(?saved, "找不到主显示器，按默认尺寸居中启动");
        return Ok((None, None));
    };
    let placement = place(saved, &screens, &Screen::from(&primary), min_size(window));
    move_client(window, placement.client, placement.scale)?;
    let pending_maximize = if placement.maximized {
        move_client(window, placement.work, placement.scale)?;
        Some(placement.client)
    } else {
        None
    };
    tracing::info!(
        ?saved,
        ?placement,
        ?screens,
        client_position = ?window.inner_position()?,
        client_size = ?window.inner_size()?,
        scale = window.scale_factor()?,
        "按上次的状态摆好了主窗口"
    );
    Ok((Some(placement.saved()), pending_maximize))
}

/// 窗口配置里主窗口客户区的最小逻辑尺寸。配置里没写最小尺寸就是不限，按 0 算；最小尺寸只认配置这一处，
/// 不在这里另写一份。
fn min_size(window: &WebviewWindow) -> (f64, f64) {
    window
        .config()
        .app
        .windows
        .iter()
        .find(|config| config.label == MAIN_WINDOW)
        .map(|config| {
            (
                config.min_width.unwrap_or(0.0),
                config.min_height.unwrap_or(0.0),
            )
        })
        .unwrap_or((0.0, 0.0))
}

/// 把客户区摆到 `client`。
fn move_client(window: &WebviewWindow, client: Rect, scale: f64) -> tauri::Result<()> {
    // 先挪到目标屏再定尺寸：跨到缩放不同的屏时系统会按新缩放改一次尺寸，尺寸要在那之后定
    window.set_position(PhysicalPosition::new(client.x, client.y))?;
    // 按逻辑尺寸设：窗口要是到显示时才换成目标屏的缩放，tao 换缩放时保持逻辑尺寸，物理尺寸照样落在 client 上
    window.set_size(LogicalSize::new(
        f64::from(client.width) / scale,
        f64::from(client.height) / scale,
    ))?;
    // set_position 定的是外框；按此刻外框与客户区的差值把客户区对齐到 client
    let frame = frame_around(
        client,
        (window.outer_position()?, window.outer_size()?),
        (window.inner_position()?, window.inner_size()?),
    );
    window.set_position(PhysicalPosition::new(frame.x, frame.y))
}

#[cfg(windows)]
fn capture(window: &WebviewWindow) -> tauri::Result<Frame> {
    let hwnd = window.hwnd()?;
    if native::is_minimized(hwnd) {
        return Ok(Frame::Minimized);
    }
    // 不用 tao 的最大化标记：它在 WM_SIZE 里才更新，最大化引起的 Moved 比它先到，那时读到的还是常态
    if native::is_maximized(hwnd) {
        return Ok(Frame::Maximized);
    }
    normal_frame(window)
}

#[cfg(not(windows))]
fn capture(window: &WebviewWindow) -> tauri::Result<Frame> {
    if window.is_minimized()? {
        return Ok(Frame::Minimized);
    }
    if window.is_maximized()? {
        return Ok(Frame::Maximized);
    }
    normal_frame(window)
}

fn normal_frame(window: &WebviewWindow) -> tauri::Result<Frame> {
    let position = window.inner_position()?;
    let size = window.inner_size()?;
    Ok(Frame::Normal {
        client: Rect {
            x: position.x,
            y: position.y,
            width: size.width,
            height: size.height,
        },
        scale: window.scale_factor()?,
    })
}

/// 显示主窗口，之后开始记录窗口的变化。上次关掉时是最大化的，就直接最大化地显示。只在 UI 线程上调用；
/// 前端首帧显示与启动兜底都会调，第二次起只剩一次不起作用的 `show()`。
pub fn reveal(window: &WebviewWindow) -> tauri::Result<()> {
    let memory = window
        .try_state::<WindowMemory>()
        .map(|memory| memory.inner().clone());
    if let Some(normal) = memory
        .as_ref()
        .and_then(WindowMemory::take_pending_maximize)
    {
        show_maximized(window, normal)?;
    }
    // 窗口已经最大化地显示出来时也要调：tao 只在自己显示窗口时记下窗口可见，绕过它的话它以为窗口还隐藏着，
    // 之后哪次改窗口标志（比如切换最大化）都会顺手把窗口藏掉
    window.show()?;
    if let Some(memory) = memory {
        memory.arm(|| capture(window));
    }
    Ok(())
}

/// 在 UI 线程上 [`reveal`]，给不在 UI 线程上的调用方用；那边拿不到结果，显示失败只能记日志。
pub fn reveal_later(window: &WebviewWindow) -> tauri::Result<()> {
    let target = window.clone();
    window.run_on_main_thread(move || {
        if let Err(err) = reveal(&target) {
            tracing::error!(error = %err, "显示主窗口失败");
        }
    })
}

#[cfg(windows)]
fn show_maximized(window: &WebviewWindow, normal: Rect) -> tauri::Result<()> {
    let frame = frame_around(
        normal,
        (window.outer_position()?, window.outer_size()?),
        (window.inner_position()?, window.inner_size()?),
    );
    match native::show_maximized(window.hwnd()?, frame) {
        Ok(()) => Ok(()),
        Err(err) => {
            // 退回 Tauri 的最大化：会闪一下、还原矩形是工作区大小，但窗口照样最大化地出来
            tracing::error!(error = %err, ?normal, "直接最大化地显示主窗口失败，改由 Tauri 最大化");
            window.maximize()
        }
    }
}

#[cfg(not(windows))]
fn show_maximized(window: &WebviewWindow, _normal: Rect) -> tauri::Result<()> {
    window.show()?;
    window.maximize()
}

/// 在 `RunEvent::Exit` 里调用：窗口最后一次变化还没等到延迟写就退出了，在这里补上。
pub fn flush_on_exit(app: &AppHandle) {
    flush_blocking(&app.state::<WindowMemory>(), EXIT_DEADLINE);
}

/// 退出时补写的结局。
#[derive(Debug)]
enum ExitFlush {
    Written,
    Unchanged,
    Failed,
    TimedOut,
}

/// 在没有 tokio 上下文的线程上（退出回调就在这样的线程上）限时补写并记日志。
fn flush_blocking(memory: &WindowMemory, deadline: Duration) -> ExitFlush {
    // timeout 在构造时就向当前运行时登记计时器，必须放进 async 块、在 block_on 里构造；直接当参数传进去的话
    // 它在运行时之外构造，当场 panic
    let outcome = tauri::async_runtime::block_on(async {
        tokio::time::timeout(deadline, memory.flush()).await
    });
    match outcome {
        Ok(Ok(true)) => {
            tracing::info!("退出前记下了主窗口状态");
            ExitFlush::Written
        }
        Ok(Ok(false)) => ExitFlush::Unchanged,
        Ok(Err(err)) => {
            tracing::error!(
                error = %err,
                causes = ?source_chain(&err),
                "退出前记下主窗口状态失败，下次启动按上一次记下的样子摆"
            );
            ExitFlush::Failed
        }
        Err(_) => {
            tracing::error!(
                deadline_ms = deadline.as_millis() as u64,
                "退出前记下主窗口状态超时，下次启动按上一次记下的样子摆"
            );
            ExitFlush::TimedOut
        }
    }
}

#[cfg(windows)]
mod native {
    use windows::Win32::Foundation::{HWND, RECT};
    use windows::Win32::UI::WindowsAndMessaging::{
        GetWindowPlacement, GetWindowRect, IsIconic, IsZoomed, SetWindowPlacement,
        SW_SHOWMAXIMIZED, WINDOWPLACEMENT, WINDOWPLACEMENT_FLAGS,
    };

    use super::Rect;

    pub fn is_minimized(hwnd: HWND) -> bool {
        // SAFETY: 只按句柄读系统里的窗口状态；句柄无效时返回 FALSE。
        unsafe { IsIconic(hwnd) }.as_bool()
    }

    pub fn is_maximized(hwnd: HWND) -> bool {
        // SAFETY: 同上。
        unsafe { IsZoomed(hwnd) }.as_bool()
    }

    /// 最大化地显示常态的窗口，还原矩形设成 `normal`（屏幕坐标的外框）。
    pub fn show_maximized(hwnd: HWND, normal: Rect) -> windows::core::Result<()> {
        let mut placement = WINDOWPLACEMENT {
            length: std::mem::size_of::<WINDOWPLACEMENT>() as u32,
            ..Default::default()
        };
        let mut current = RECT::default();
        // SAFETY: 两个结构体都在本函数栈上，WINDOWPLACEMENT 的 length 已按要求填好。
        unsafe {
            GetWindowPlacement(hwnd, &mut placement)?;
            GetWindowRect(hwnd, &mut current)?;
        }
        // rcNormalPosition 用的是工作区坐标，任务栏在屏幕上边或左边时与屏幕坐标差一截。窗口此刻是常态，
        // rcNormalPosition 就是它当前的外框，两者之差就是这块屏上的换算偏移；normal 与它在同一块屏上。
        let dx = placement.rcNormalPosition.left - current.left;
        let dy = placement.rcNormalPosition.top - current.top;
        placement.rcNormalPosition = RECT {
            left: normal.x + dx,
            top: normal.y + dy,
            right: normal.x + normal.width as i32 + dx,
            bottom: normal.y + normal.height as i32 + dy,
        };
        placement.showCmd = SW_SHOWMAXIMIZED.0 as u32;
        placement.flags = WINDOWPLACEMENT_FLAGS(0);
        // SAFETY: placement 在本函数栈上、已填好。
        unsafe { SetWindowPlacement(hwnd, &placement) }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const MIN: (f64, f64) = (960.0, 720.0);

    fn rect(x: i32, y: i32, width: u32, height: u32) -> Rect {
        Rect {
            x,
            y,
            width,
            height,
        }
    }

    fn screen(x: i32, y: i32, width: u32, height: u32, scale: f64) -> Screen {
        Screen {
            work: rect(x, y, width, height),
            scale,
        }
    }

    fn saved(x: i32, y: i32, width: u32, height: u32, scale: f64) -> Saved {
        Saved {
            x,
            y,
            width,
            height,
            scale,
            maximized: false,
        }
    }

    /// 1920x1080 的主屏，任务栏 48 高在下边。
    const PRIMARY: Screen = Screen {
        work: Rect {
            x: 0,
            y: 0,
            width: 1920,
            height: 1032,
        },
        scale: 1.0,
    };

    #[test]
    fn window_inside_its_screen_comes_back_where_it_was() {
        let placement = place(&saved(200, 150, 1280, 800, 1.0), &[PRIMARY], &PRIMARY, MIN);
        assert_eq!(placement.client, rect(200, 150, 1280, 800));
        assert_eq!(placement.scale, 1.0);
        assert_eq!(placement.work, PRIMARY.work);
        assert!(!placement.maximized);
    }

    /// 这块屏从 100% 改成 150%：窗口看起来一样大，物理尺寸跟着放大。
    #[test]
    fn scale_change_keeps_the_logical_size() {
        let hidpi = screen(0, 0, 2560, 1392, 1.5);
        let placement = place(&saved(100, 80, 1200, 800, 1.0), &[hidpi], &hidpi, MIN);
        assert_eq!(placement.client, rect(100, 80, 1800, 1200));
        assert_eq!(placement.scale, 1.5);
    }

    #[test]
    fn window_past_the_right_and_bottom_edges_is_pulled_back() {
        let placement = place(&saved(1500, 700, 1120, 720, 1.0), &[PRIMARY], &PRIMARY, MIN);
        assert_eq!(placement.client, rect(800, 312, 1120, 720));
    }

    /// 标题栏在屏幕上沿外就拖不回来了，必须拉进来。
    #[test]
    fn title_bar_above_the_top_edge_is_pulled_down() {
        let placement = place(&saved(-40, -300, 1120, 720, 1.0), &[PRIMARY], &PRIMARY, MIN);
        assert_eq!(placement.client, rect(0, 0, 1120, 720));
    }

    #[test]
    fn window_larger_than_the_work_area_is_shrunk_to_it() {
        let small = screen(0, 0, 1366, 728, 1.0);
        let placement = place(&saved(0, 0, 1900, 1000, 1.0), &[small], &small, MIN);
        assert_eq!(placement.client, rect(0, 0, 1366, 728));
    }

    /// 1920x1080 + 150% 的笔记本：工作区只有 1280x688 逻辑像素，比最小高度 720 还矮。最小尺寸优先，
    /// 窗口贴工作区左上，标题栏在屏上。
    #[test]
    fn work_area_below_the_minimum_keeps_the_minimum_and_the_top_left() {
        let laptop = screen(0, 0, 1920, 1032, 1.5);
        let placement = place(&saved(300, 200, 1440, 1080, 1.5), &[laptop], &laptop, MIN);
        assert_eq!(placement.client, rect(300, 0, 1440, 1080));

        let placement = place(&saved(300, 200, 1600, 1080, 1.0), &[laptop], &laptop, MIN);
        assert_eq!(placement.client.height, 1080, "最小高度 720 x 1.5");
        assert_eq!(placement.client.y, 0);
    }

    /// 副屏摆在主屏左边，坐标是负的。
    #[test]
    fn secondary_screen_on_the_left_keeps_negative_coordinates() {
        let left = screen(-2560, -200, 2560, 1400, 1.0);
        let placement = place(
            &saved(-2000, 0, 1280, 800, 1.0),
            &[PRIMARY, left],
            &PRIMARY,
            MIN,
        );
        assert_eq!(placement.client, rect(-2000, 0, 1280, 800));
        assert_eq!(placement.work, left.work);
    }

    /// 跨在两块屏上：落到重叠多的那块，缩放也按那块算。
    #[test]
    fn window_across_two_screens_goes_to_the_one_it_overlaps_most() {
        let right = screen(1920, 0, 2560, 1392, 1.25);
        let placement = place(
            &saved(1500, 100, 1200, 800, 1.0),
            &[PRIMARY, right],
            &PRIMARY,
            MIN,
        );
        assert_eq!(placement.work, right.work);
        assert_eq!(placement.scale, 1.25);
        assert_eq!(placement.client, rect(1920, 100, 1500, 1000));

        let placement = place(
            &saved(1000, 100, 1200, 800, 1.0),
            &[PRIMARY, right],
            &PRIMARY,
            MIN,
        );
        assert_eq!(placement.work, PRIMARY.work);
        assert_eq!(placement.client, rect(720, 100, 1200, 800));
    }

    /// 记下时在副屏上，副屏拔了：放到主屏，保持逻辑尺寸，居中。
    #[test]
    fn window_on_a_missing_screen_is_centred_on_the_primary_screen() {
        let mut gone = saved(3000, 200, 1500, 1000, 1.25);
        gone.maximized = true;
        let placement = place(&gone, &[PRIMARY], &PRIMARY, MIN);
        assert_eq!(placement.client, rect(360, 116, 1200, 800));
        assert_eq!(placement.work, PRIMARY.work);
        assert!(placement.maximized, "最大化与否照旧");
    }

    #[test]
    fn maximized_flag_is_kept_for_a_screen_that_is_still_there() {
        let mut maximized = saved(200, 150, 1280, 800, 1.0);
        maximized.maximized = true;
        let placement = place(&maximized, &[PRIMARY], &PRIMARY, MIN);
        assert!(placement.maximized);
        assert_eq!(placement.client, rect(200, 150, 1280, 800));
        assert_eq!(placement.saved(), maximized);
    }

    /// 随机的矩形、缩放与屏：结果总在目标屏工作区里（放得下时），尺寸不小于最小尺寸。
    #[test]
    fn placement_always_lands_inside_the_target_work_area() {
        let mut rng = fastrand::Rng::with_seed(0x5eed_1234);
        for _ in 0..2000 {
            let scale = [1.0, 1.25, 1.5, 1.75, 2.0][rng.usize(..5)];
            let screens = [
                screen(0, 0, rng.u32(1024..4000), rng.u32(700..2200), scale),
                screen(
                    -rng.i32(1000..4000),
                    rng.i32(-500..500),
                    rng.u32(1024..4000),
                    rng.u32(700..2200),
                    1.0,
                ),
            ];
            let state = saved(
                rng.i32(-8000..8000),
                rng.i32(-4000..4000),
                rng.u32(1..6000),
                rng.u32(1..4000),
                [1.0, 1.25, 1.5, 2.0][rng.usize(..4)],
            );
            let placement = place(&state, &screens, &screens[0], MIN);
            let work = placement.work;
            let client = placement.client;
            assert!(
                client.width as f64 >= (MIN.0 * placement.scale).round(),
                "{state:?} -> {placement:?}"
            );
            assert!(
                client.height as f64 >= (MIN.1 * placement.scale).round(),
                "{state:?} -> {placement:?}"
            );
            assert!(
                client.x >= work.x && client.y >= work.y,
                "{state:?} -> {placement:?}"
            );
            if client.width <= work.width {
                assert!(
                    client.x + client.width as i32 <= work.x + work.width as i32,
                    "{state:?} -> {placement:?}"
                );
            }
            if client.height <= work.height {
                assert!(
                    client.y + client.height as i32 <= work.y + work.height as i32,
                    "{state:?} -> {placement:?}"
                );
            }
        }
    }

    fn normal(x: i32, y: i32, width: u32, height: u32) -> Frame {
        Frame::Normal {
            client: rect(x, y, width, height),
            scale: 1.0,
        }
    }

    #[test]
    fn minimizing_leaves_the_record_alone() {
        let mut record = Some(saved(200, 150, 1280, 800, 1.0));
        assert!(!observe(&mut record, Frame::Minimized));
        assert_eq!(record, Some(saved(200, 150, 1280, 800, 1.0)));
    }

    /// 最大化只改标志，常态矩形留着；还原后记下还原出来的矩形。最大化后最小化，标志不丢。
    #[test]
    fn maximizing_keeps_the_normal_rect_for_restoring() {
        let mut record = Some(saved(200, 150, 1280, 800, 1.0));
        assert!(observe(&mut record, Frame::Maximized));
        let mut expected = saved(200, 150, 1280, 800, 1.0);
        expected.maximized = true;
        assert_eq!(record, Some(expected));
        assert!(
            !observe(&mut record, Frame::Maximized),
            "同样的状态不算变化"
        );
        assert!(!observe(&mut record, Frame::Minimized));
        assert_eq!(record, Some(expected));

        assert!(observe(&mut record, normal(200, 150, 1280, 800)));
        assert_eq!(record, Some(saved(200, 150, 1280, 800, 1.0)));
        assert!(observe(&mut record, normal(10, 20, 1000, 760)));
        assert_eq!(record, Some(saved(10, 20, 1000, 760, 1.0)));
    }

    #[test]
    fn maximizing_before_anything_is_known_records_nothing() {
        let mut record = None;
        assert!(!observe(&mut record, Frame::Maximized));
        assert_eq!(record, None);
    }

    #[test]
    fn frame_around_adds_the_invisible_borders() {
        let frame = frame_around(
            rect(100, 50, 1280, 800),
            (
                PhysicalPosition::new(493, 172),
                tauri::PhysicalSize::new(1134, 727),
            ),
            (
                PhysicalPosition::new(500, 172),
                tauri::PhysicalSize::new(1120, 720),
            ),
        );
        assert_eq!(frame, rect(93, 50, 1294, 807));
    }

    /// 1 秒内又有变化就接着等：最后一次变化之后满 1 秒才写。
    #[tokio::test(start_paused = true)]
    async fn writes_wait_until_the_window_settles() {
        let changed = Arc::new(Notify::new());
        let started = tokio::time::Instant::now();
        let waiting = {
            let changed = changed.clone();
            tokio::spawn(async move {
                settle(&changed, WRITE_DELAY).await;
                tokio::time::Instant::now()
            })
        };
        tokio::time::sleep(Duration::from_millis(500)).await;
        changed.notify_one();
        tokio::time::sleep(Duration::from_millis(900)).await;
        changed.notify_one();
        let settled = waiting.await.unwrap();
        assert_eq!(settled - started, Duration::from_millis(2400));
    }

    fn memory_in(dir: &Path) -> WindowMemory {
        WindowMemory::new(dir.join(WINDOW_STATE_FILE), None, None)
    }

    #[tokio::test]
    async fn changes_are_written_and_read_back() {
        let dir = tempfile::tempdir().unwrap();
        let memory = memory_in(dir.path());
        memory.arm(|| Ok(normal(0, 0, 1120, 720)));
        memory.observe(normal(321, 123, 1300, 900));
        memory.observe(Frame::Maximized);
        assert!(memory.flush().await.unwrap());

        let mut expected = saved(321, 123, 1300, 900, 1.0);
        expected.maximized = true;
        let path = dir.path().join(WINDOW_STATE_FILE);
        assert_eq!(read(&path).unwrap(), Some(expected));
        let written: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        assert_eq!(written["format"], 1);
        assert_eq!(written["x"], 321);
        assert_eq!(written["maximized"], true);
        let leftovers: Vec<_> = std::fs::read_dir(dir.path())
            .unwrap()
            .map(|entry| entry.unwrap().file_name())
            .collect();
        assert_eq!(
            leftovers,
            vec![std::ffi::OsString::from(WINDOW_STATE_FILE)],
            "原子写不留临时文件"
        );

        assert!(!memory.flush().await.unwrap(), "没有新变化就不再写");
    }

    /// 首次启动用窗口此刻的样子垫底，但没动过就不写：下次照样按默认尺寸居中。
    #[tokio::test]
    async fn untouched_first_run_writes_nothing() {
        let dir = tempfile::tempdir().unwrap();
        let memory = memory_in(dir.path());
        memory.arm(|| Ok(normal(400, 180, 1120, 720)));
        assert!(!memory.flush().await.unwrap());
        assert!(!dir.path().join(WINDOW_STATE_FILE).exists());

        // 垫底的记录让首次启动直接最大化也能记下常态矩形
        memory.observe(Frame::Maximized);
        assert!(memory.flush().await.unwrap());
        let mut expected = saved(400, 180, 1120, 720, 1.0);
        expected.maximized = true;
        assert_eq!(
            read(&dir.path().join(WINDOW_STATE_FILE)).unwrap(),
            Some(expected)
        );
    }

    /// 显示之前的事件是启动期自己摆位置引起的（要最大化时撑到工作区大小），不能当成常态矩形。
    #[tokio::test]
    async fn events_before_the_window_is_shown_are_ignored() {
        let dir = tempfile::tempdir().unwrap();
        let mut start = saved(200, 150, 1280, 800, 1.0);
        start.maximized = true;
        let memory = WindowMemory::new(
            dir.path().join(WINDOW_STATE_FILE),
            Some(start),
            Some(start.client()),
        );
        memory.observe(normal(0, 0, 1920, 1032));
        assert!(!memory.flush().await.unwrap());

        assert_eq!(memory.take_pending_maximize(), Some(start.client()));
        assert_eq!(memory.take_pending_maximize(), None, "只用一次");
        memory.arm(|| panic!("已有记录，不该再读窗口垫底"));
        memory.observe(Frame::Maximized);
        assert!(!memory.flush().await.unwrap(), "仍是启动时摆出来的样子");
        memory.observe(normal(200, 150, 1280, 800));
        assert!(memory.flush().await.unwrap());
        assert_eq!(
            read(&dir.path().join(WINDOW_STATE_FILE)).unwrap(),
            Some(saved(200, 150, 1280, 800, 1.0))
        );
    }

    /// 写不进去时变化仍算没写，放开后下一次写得进去。
    #[tokio::test]
    async fn failed_write_is_retried_on_the_next_flush() {
        let dir = tempfile::tempdir().unwrap();
        let blocker = dir.path().join("not-a-dir");
        std::fs::write(&blocker, b"").unwrap();
        let memory = WindowMemory::new(blocker.join(WINDOW_STATE_FILE), None, None);
        memory.arm(|| Ok(normal(0, 0, 1120, 720)));
        memory.observe(normal(5, 6, 1200, 760));
        assert!(memory.flush().await.is_err());

        std::fs::remove_file(&blocker).unwrap();
        assert!(memory.flush().await.unwrap());
        assert_eq!(
            read(&blocker.join(WINDOW_STATE_FILE)).unwrap(),
            Some(saved(5, 6, 1200, 760, 1.0))
        );
    }

    /// 退出回调所在的线程没有 tokio 上下文：限时补写的计时器要在运行时里创建，在外面创建会直接 panic，
    /// 补写和排在后面的更新安装都跑不到。所以这里用普通的 `#[test]`，不进任何运行时。
    #[test]
    fn exit_flush_works_without_an_ambient_runtime() {
        let dir = tempfile::tempdir().unwrap();
        let memory = memory_in(dir.path());
        memory.arm(|| Ok(normal(0, 0, 1120, 720)));
        memory.observe(normal(7, 8, 1200, 760));
        let outcome = flush_blocking(&memory, EXIT_DEADLINE);
        assert!(matches!(outcome, ExitFlush::Written), "{outcome:?}");
        assert_eq!(
            read(&dir.path().join(WINDOW_STATE_FILE)).unwrap(),
            Some(saved(7, 8, 1200, 760, 1.0))
        );
        let outcome = flush_blocking(&memory, EXIT_DEADLINE);
        assert!(matches!(outcome, ExitFlush::Unchanged), "{outcome:?}");
    }

    /// 写不进去时如实报失败，不当成写好了。
    #[test]
    fn exit_flush_reports_a_failed_write() {
        let dir = tempfile::tempdir().unwrap();
        let blocker = dir.path().join("not-a-dir");
        std::fs::write(&blocker, b"").unwrap();
        let memory = WindowMemory::new(blocker.join(WINDOW_STATE_FILE), None, None);
        memory.arm(|| Ok(normal(0, 0, 1120, 720)));
        memory.observe(normal(5, 6, 1200, 760));
        let outcome = flush_blocking(&memory, EXIT_DEADLINE);
        assert!(matches!(outcome, ExitFlush::Failed), "{outcome:?}");
    }

    #[test]
    fn missing_file_is_a_first_run() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(read(&dir.path().join(WINDOW_STATE_FILE)).unwrap(), None);
    }

    #[test]
    fn broken_or_unexpected_content_is_refused_with_a_reason() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(WINDOW_STATE_FILE);
        let cases = [
            ("{ broken", "内容不是窗口状态"),
            (
                r#"{"format":2,"x":0,"y":0,"width":1120,"height":720,"scale":1.0,"maximized":false}"#,
                "格式版本 2",
            ),
            (
                r#"{"format":1,"x":0,"y":0,"width":0,"height":720,"scale":1.0,"maximized":false}"#,
                "尺寸 0x720",
            ),
            (
                r#"{"format":1,"x":0,"y":0,"width":1120,"height":99999,"scale":1.0,"maximized":false}"#,
                "尺寸 1120x99999",
            ),
            (
                r#"{"format":1,"x":0,"y":0,"width":1120,"height":720,"scale":0.0,"maximized":false}"#,
                "缩放比例 0",
            ),
            (
                r#"{"format":1,"x":0,"y":0,"width":1120,"height":720,"scale":-1.5,"maximized":false}"#,
                "缩放比例 -1.5",
            ),
            (
                r#"{"format":1,"x":0,"y":0,"width":1120,"height":720,"maximized":false}"#,
                "内容不是窗口状态",
            ),
        ];
        for (content, reason) in cases {
            std::fs::write(&path, content).unwrap();
            let err = read(&path).unwrap_err();
            assert!(err.contains(reason), "{content} -> {err}");
        }
    }

    /// 坏文件不拦启动，但日志里要有一条 WARN，写明是哪个文件、为什么。
    #[test]
    fn broken_file_is_logged_and_treated_as_a_first_run() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(WINDOW_STATE_FILE);
        std::fs::write(&path, "{ broken").unwrap();
        let captured = crate::tests::Captured::default();
        let writer = captured.clone();
        let subscriber = tracing_subscriber::fmt()
            .with_ansi(false)
            .with_writer(move || writer.clone())
            .finish();
        let loaded = tracing::subscriber::with_default(subscriber, || load(&path));
        assert_eq!(loaded, None);
        let log = String::from_utf8(captured.0.lock().unwrap().clone()).unwrap();
        assert!(log.contains("WARN"), "{log}");
        assert!(log.contains("窗口状态读不出来"), "{log}");
        assert!(log.contains(&path.display().to_string()), "{log}");
        assert!(log.contains("内容不是窗口状态"), "{log}");
    }
}
