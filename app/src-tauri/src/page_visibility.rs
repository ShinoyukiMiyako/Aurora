//! 主窗口最小化时告诉 WebView2 页面不可见，还原时再告诉它可见。
//!
//! WebView2 是顶层窗口的子窗口，收不到顶层窗口最小化、还原的消息，页面一直以为自己可见：`visibilityState`
//! 不变，rAF 与 CSS 动画照跑，玩游戏时渲染进程和 GPU 进程还在占 CPU。微软的文档要求宿主自己在最小化时把
//! `ICoreWebView2Controller` 的 `IsVisible` 设为假、还原时设回真，而 Tauri 与 wry 都没有做这件事。
//!
//! Tauri 没有最小化事件，这里能用的信号只有 `Resized`：最小化时 `WM_SIZE` 带来 0×0。还原的判据是「不再
//! 最小化」，不认具体的尺寸类型：最大化之后最小化再还原，系统报的是最大化而不是还原。`Resized` 在拖拽缩放时
//! 高频到来，所以只在状态翻转时才碰 controller。
//!
//! 没有走的路：`TrySuspend` 会冻结 JS，而游戏退出后的自动还原、任务完成时闪任务栏都由前端收到事件后执行；
//! Tauri 的 `Webview::hide` 隐藏的是容器子窗口，还原时有白屏。`IsVisible` 为假时 JS 与事件都照常，只是不画帧。
//! 代价是隐藏期间的切换动画不走，还原后不到 100 毫秒内还能看到它们淡出。

use std::sync::atomic::{AtomicBool, Ordering};

use tauri::PhysicalSize;

/// 这次 `Resized` 时窗口算不算最小化着。`iconic` 读的是系统此刻的窗口状态，`size` 是 Tauri 按当下客户区
/// 重算的，最小化时为 0×0。任一成立都算：哪一边的行为将来变了，也不至于漏掉翻转。
pub fn is_minimized(iconic: bool, size: PhysicalSize<u32>) -> bool {
    iconic || size.width == 0 || size.height == 0
}

/// 页面当前的可见性记录。初值是可见，与 wry 创建 controller 时一致：窗口以 `visible: false` 创建，但前端
/// 要靠 rAF 画完首帧才显示窗口，窗口还没显示不等于页面不可见。监听器是 `Fn`，记录只能靠内部可变；回调都在
/// UI 线程上，没有竞争，内存序用最宽松的就够。
#[derive(Debug, Default)]
pub struct PageVisibility {
    hidden: AtomicBool,
}

impl PageVisibility {
    /// 记下窗口新的最小化状态，返回要设给 `IsVisible` 的值；状态没有翻转时为 `None`。
    pub fn observe(&self, minimized: bool) -> Option<bool> {
        let was_hidden = self.hidden.swap(minimized, Ordering::Relaxed);
        (was_hidden != minimized).then_some(!minimized)
    }
}

/// 在主窗口上按最小化状态翻转 WebView2 的 `IsVisible`。
pub fn install(window: &tauri::WebviewWindow) {
    let target = window.clone();
    let page = PageVisibility::default();
    window.on_window_event(move |event| {
        let tauri::WindowEvent::Resized(size) = event else {
            return;
        };
        let iconic = match target.is_minimized() {
            Ok(iconic) => iconic,
            Err(err) => {
                tracing::error!(error = %err, "读取主窗口最小化状态失败，这次不翻转页面可见性");
                return;
            }
        };
        let Some(visible) = page.observe(is_minimized(iconic, *size)) else {
            return;
        };
        if let Err(err) = set_visible(&target, visible) {
            tracing::error!(error = %err, visible, "派发页面可见性失败");
        }
    });
}

fn set_visible(window: &tauri::WebviewWindow, visible: bool) -> tauri::Result<()> {
    window.with_webview(move |webview| {
        // SAFETY: with_webview 的回调在 WebView 所属的 UI 线程上执行，controller 在回调期间有效；这里只改一个属性。
        match unsafe { webview.controller().SetIsVisible(visible) } {
            Ok(()) => tracing::info!(visible, "已更新 WebView2 页面可见性"),
            // 回调在 UI 线程上异步执行，错误传不回来；后果是最小化时页面继续占 CPU，或还原后页面仍然降频。
            Err(err) => tracing::error!(error = %err, visible, "更新 WebView2 页面可见性失败"),
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const NORMAL: PhysicalSize<u32> = PhysicalSize::new(1120, 720);
    const MAXIMIZED: PhysicalSize<u32> = PhysicalSize::new(2560, 1392);
    const ZERO: PhysicalSize<u32> = PhysicalSize::new(0, 0);

    /// 按顺序喂一串 `Resized`，返回每次要设给 `IsVisible` 的值。
    fn replay(events: &[(bool, PhysicalSize<u32>)]) -> Vec<Option<bool>> {
        let page = PageVisibility::default();
        events
            .iter()
            .map(|&(iconic, size)| page.observe(is_minimized(iconic, size)))
            .collect()
    }

    #[test]
    fn iconic_or_a_zero_dimension_counts_as_minimized() {
        for (iconic, size, expected) in [
            (true, ZERO, true),
            (true, NORMAL, true),
            (false, ZERO, true),
            (false, PhysicalSize::new(0, 720), true),
            (false, PhysicalSize::new(1120, 0), true),
            (false, NORMAL, false),
            (false, PhysicalSize::new(1, 1), false),
        ] {
            assert_eq!(is_minimized(iconic, size), expected, "{iconic} {size:?}");
        }
    }

    /// 拖拽缩放时 `Resized` 一路高频到来，一次也不该碰 controller；最小化后反复收到 0×0 也只翻转一次。
    #[test]
    fn repeated_resizes_flip_only_once() {
        let drag: Vec<_> = (0..500)
            .map(|step| (false, PhysicalSize::new(960 + step, 720 + step / 2)))
            .collect();
        assert!(replay(&drag).iter().all(Option::is_none));

        let flips = replay(&[
            (true, ZERO),
            (true, ZERO),
            (true, ZERO),
            (false, NORMAL),
            (false, NORMAL),
            (false, PhysicalSize::new(1200, 800)),
        ]);
        assert_eq!(flips, vec![Some(false), None, None, Some(true), None, None]);
    }

    /// 最大化之后最小化再还原：系统报的是 `SIZE_MAXIMIZED`，还原后的尺寸是最大化的尺寸，也要翻回可见。
    #[test]
    fn restoring_into_maximized_flips_back() {
        let flips = replay(&[
            (false, MAXIMIZED),
            (true, ZERO),
            (false, MAXIMIZED),
            (true, ZERO),
            (false, NORMAL),
        ]);
        assert_eq!(
            flips,
            vec![None, Some(false), Some(true), Some(false), Some(true)]
        );
    }

    /// 窗口以 `visible: false` 创建，创建期间的 `Resized` 不是最小化：把页面标成不可见的话 rAF 不跑，前端
    /// 画不完首帧，窗口就要等兜底才显示。
    #[test]
    fn a_hidden_window_at_startup_is_not_taken_for_minimized() {
        assert_eq!(
            replay(&[(false, NORMAL), (false, NORMAL)]),
            vec![None, None]
        );
    }

    /// 第一次 `Resized` 就是最小化时立刻翻转，初值不能吃掉这一次。
    #[test]
    fn the_first_event_can_already_be_a_flip() {
        assert_eq!(
            replay(&[(true, ZERO), (false, NORMAL)]),
            vec![Some(false), Some(true)]
        );
    }

    /// 随机的事件序列（固定种子，可复现）：每次翻转都与上一次相反，且翻转后的记录与窗口状态一致。
    #[test]
    fn flips_alternate_under_random_events() {
        for seed in [0x9E37_79B9_7F4A_7C15u64, 1, 0xDEAD_BEEF, 20_261_101] {
            let mut state = seed | 1;
            let mut next = || {
                state ^= state << 13;
                state ^= state >> 7;
                state ^= state << 17;
                state
            };
            let page = PageVisibility::default();
            let mut visible = true;
            let mut flips = 0;
            for _ in 0..2_000 {
                let minimized = next() % 3 == 0;
                match page.observe(minimized) {
                    Some(flip) => {
                        assert_eq!(flip, !visible, "seed {seed}");
                        visible = flip;
                        flips += 1;
                    }
                    None => assert_eq!(visible, !minimized, "seed {seed}"),
                }
                assert_eq!(visible, !minimized, "seed {seed}");
            }
            assert!(flips > 100, "seed {seed}：随机序列应当多次翻转");
        }
    }
}
