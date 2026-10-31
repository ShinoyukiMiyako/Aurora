//! 主窗口 WebView2 的渲染进程崩溃或无响应之后自动重载页面。
//!
//! 主框架的渲染进程退出时，WebView2 起一个新的渲染进程，把页面换成错误页；无响应时页面卡住不动，WebView2
//! 隔一段时间（文档举的例子是 15 秒）重报一次，直到它恢复。两种情况官方给的恢复办法都是调 `Reload`，而生产
//! 构建关掉了 F5（见 [`crate::window`]），用户自己重载不了，只能由这里代劳。
//!
//! 重载有预算：[`RELOAD_WINDOW`] 内最多 [`MAX_RELOADS`] 次。页面一加载就崩、一加载就卡死时，见故障就重载会
//! 变成死循环，所以预算用完就停在原地，记一条 error。停下之后故障还在接连上报（无响应会一直报）就一直停着；
//! 整整一个窗口没再出故障，才当作上一轮已经过去，之后的故障重新计数。只按滑动窗口算的话，一直卡死的页面
//! 会每分钟被重载两次，没完没了。
//!
//! 重载出来的页面换了网页区域的子窗口，拖放目标随页面加载完成（`NavigationCompleted`）重挂，见 [`crate::drop`]。

use std::fmt::Display;
use std::time::{Duration, Instant};

/// 自动重载的计数窗口。
pub const RELOAD_WINDOW: Duration = Duration::from_secs(60);
/// [`RELOAD_WINDOW`] 内最多自动重载的次数。
pub const MAX_RELOADS: usize = 2;

/// 要重载页面才能恢复的主框架渲染进程故障。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RendererFailure {
    /// 渲染进程退出，页面已被换成错误页。
    Exited,
    /// 渲染进程无响应，页面卡住。
    Unresponsive,
}

impl RendererFailure {
    fn describe(self) -> &'static str {
        match self {
            Self::Exited => "退出",
            Self::Unresponsive => "无响应",
        }
    }
}

/// 一次故障怎么处置。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Verdict {
    /// 重载页面；`attempt` 是这个窗口里的第几次。
    Reload { attempt: usize },
    /// 窗口里的重载次数用完，从这次起停在原地。
    GiveUp,
    /// 已经停下，故障仍在接连上报。
    StillStopped,
}

/// 自动重载的预算。时刻由调用方传入，测试不必真的等。
#[derive(Debug, Default)]
pub struct ReloadBudget {
    /// 窗口内做过的重载的时刻。
    reloads: Vec<Instant>,
    /// 停下之后最近一次故障的时刻；没停下时为 `None`。
    stopped: Option<Instant>,
}

impl ReloadBudget {
    /// 在 `now` 出了一次故障，判定这次重不重载。
    pub fn judge(&mut self, now: Instant) -> Verdict {
        if let Some(last) = self.stopped {
            if now.saturating_duration_since(last) < RELOAD_WINDOW {
                self.stopped = Some(now);
                return Verdict::StillStopped;
            }
            // 停下之后隔了整整一个窗口才再出故障：窗口内的重载此时也都已过期，下面自然从零数起
            self.stopped = None;
        }
        self.reloads
            .retain(|at| now.saturating_duration_since(*at) < RELOAD_WINDOW);
        if self.reloads.len() < MAX_RELOADS {
            self.reloads.push(now);
            return Verdict::Reload {
                attempt: self.reloads.len(),
            };
        }
        self.stopped = Some(now);
        Verdict::GiveUp
    }
}

/// 主窗口渲染进程故障的处置：按预算判定，要重载时调用重载，并记下经过。
#[derive(Debug, Default)]
pub struct RendererRecovery {
    budget: ReloadBudget,
}

impl RendererRecovery {
    /// 处理在 `now` 上报的一次故障；判定要重载时调用 `reload`。返回这次的判定。
    ///
    /// 调过 `reload` 就算用掉一次预算，调用失败也算：失败多半是 WebView 已经不可用，接着重试只会把预算换成一串错误日志。
    pub fn on_failure<E: Display>(
        &mut self,
        failure: RendererFailure,
        now: Instant,
        reload: impl FnOnce() -> Result<(), E>,
    ) -> Verdict {
        let verdict = self.budget.judge(now);
        match verdict {
            Verdict::Reload { attempt } => {
                tracing::warn!(
                    ?failure,
                    attempt,
                    max = MAX_RELOADS,
                    window_secs = RELOAD_WINDOW.as_secs(),
                    "WebView2 渲染进程{}，自动重载页面",
                    failure.describe()
                );
                if let Err(err) = reload() {
                    tracing::error!(error = %err, ?failure, "自动重载页面失败，界面停在原地");
                }
            }
            Verdict::GiveUp => tracing::error!(
                ?failure,
                max = MAX_RELOADS,
                window_secs = RELOAD_WINDOW.as_secs(),
                "WebView2 渲染进程{}：{} 秒内已自动重载 {} 次，不再自动重载，界面停在原地；一直不恢复的话要重启应用",
                failure.describe(),
                RELOAD_WINDOW.as_secs(),
                MAX_RELOADS
            ),
            Verdict::StillStopped => tracing::debug!(
                ?failure,
                "WebView2 渲染进程仍有故障，自动重载已停下"
            ),
        }
        verdict
    }
}

/// 在主窗口上订阅子进程故障。订阅要在 WebView 所属的 UI 线程上做，经 `with_webview` 派过去；那边的结果传不回
/// setup，只能记日志——订阅不上的后果是渲染进程崩溃或卡死后界面不会自己恢复。
#[cfg(windows)]
pub fn install(window: &tauri::WebviewWindow) -> tauri::Result<()> {
    window.with_webview(|webview| {
        // SAFETY: with_webview 的回调在 WebView 所属的 UI 线程上执行，controller 在回调期间有效
        match unsafe { native::subscribe(&webview) } {
            Ok(()) => tracing::info!("已订阅 WebView2 子进程故障，渲染进程崩溃或无响应时自动重载页面"),
            Err(err) => tracing::error!(error = %err, "订阅 WebView2 子进程故障失败，渲染进程崩溃或无响应后界面不会自动恢复"),
        }
    })
}

#[cfg(windows)]
mod native {
    use std::time::Instant;

    use webview2_com::Microsoft::Web::WebView2::Win32::{
        COREWEBVIEW2_PROCESS_FAILED_KIND, COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_EXITED,
        COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_UNRESPONSIVE,
    };
    use webview2_com::ProcessFailedEventHandler;
    use windows::Win32::Foundation::E_POINTER;

    use super::{RendererFailure, RendererRecovery};

    /// 故障类型的取值见 WebView2 的 `COREWEBVIEW2_PROCESS_FAILED_KIND`，只有主框架渲染进程的退出与无响应要重载。
    /// 浏览器进程退出时 WebView 已经关闭，`Reload` 无从调起，只能重启应用；子框架、GPU、工具类等进程的故障
    /// WebView2 自己恢复或不波及主页面，重载反而白白丢掉页面状态。认不出的新类型同样不重载。
    pub fn renderer_failure(kind: COREWEBVIEW2_PROCESS_FAILED_KIND) -> Option<RendererFailure> {
        match kind {
            COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_EXITED => Some(RendererFailure::Exited),
            COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_UNRESPONSIVE => {
                Some(RendererFailure::Unresponsive)
            }
            _ => None,
        }
    }

    /// 订阅随 WebView 活到应用退出，从不退订，注册令牌不用留。
    ///
    /// # Safety
    /// 只能在 WebView 所属的 UI 线程上调用。
    pub unsafe fn subscribe(webview: &tauri::webview::PlatformWebview) -> windows_core::Result<()> {
        let core = unsafe { webview.controller().CoreWebView2()? };
        let mut recovery = RendererRecovery::default();
        let handler = ProcessFailedEventHandler::create(Box::new(move |sender, args| {
            let kind = args.ok_or_else(|| E_POINTER.into()).and_then(|args| {
                let mut kind = COREWEBVIEW2_PROCESS_FAILED_KIND::default();
                // SAFETY: 事件参数在回调期间有效，kind 是可写的输出位置
                unsafe { args.ProcessFailedKind(&mut kind) }.map(|()| kind)
            });
            let kind = match kind {
                Ok(kind) => kind,
                Err(err) => {
                    tracing::error!(error = %err, "读不出 WebView2 子进程故障的类型，这次不自动重载");
                    return Ok(());
                }
            };
            if let Some(failure) = renderer_failure(kind) {
                recovery.on_failure(failure, Instant::now(), || match &sender {
                    // SAFETY: 事件回调在 WebView 所属的 UI 线程上执行，发出事件的 CoreWebView2 此刻有效；
                    // Reload 只是发起一次导航，不在回调里跑消息循环
                    Some(core) => unsafe { core.Reload() },
                    None => Err(E_POINTER.into()),
                });
            }
            Ok(())
        }));
        let mut token = 0i64;
        unsafe { core.add_ProcessFailed(&handler, &mut token) }
    }

    #[cfg(test)]
    mod tests {
        use webview2_com::Microsoft::Web::WebView2::Win32::{
            COREWEBVIEW2_PROCESS_FAILED_KIND_BROWSER_PROCESS_EXITED,
            COREWEBVIEW2_PROCESS_FAILED_KIND_FRAME_RENDER_PROCESS_EXITED,
            COREWEBVIEW2_PROCESS_FAILED_KIND_GPU_PROCESS_EXITED,
            COREWEBVIEW2_PROCESS_FAILED_KIND_PPAPI_BROKER_PROCESS_EXITED,
            COREWEBVIEW2_PROCESS_FAILED_KIND_PPAPI_PLUGIN_PROCESS_EXITED,
            COREWEBVIEW2_PROCESS_FAILED_KIND_SANDBOX_HELPER_PROCESS_EXITED,
            COREWEBVIEW2_PROCESS_FAILED_KIND_UNKNOWN_PROCESS_EXITED,
            COREWEBVIEW2_PROCESS_FAILED_KIND_UTILITY_PROCESS_EXITED,
        };

        use super::*;

        #[test]
        fn only_main_frame_renderer_exit_and_hang_are_reloaded() {
            for (kind, expected) in [
                (
                    COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_EXITED,
                    Some(RendererFailure::Exited),
                ),
                (
                    COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_UNRESPONSIVE,
                    Some(RendererFailure::Unresponsive),
                ),
                (
                    COREWEBVIEW2_PROCESS_FAILED_KIND_BROWSER_PROCESS_EXITED,
                    None,
                ),
                (
                    COREWEBVIEW2_PROCESS_FAILED_KIND_FRAME_RENDER_PROCESS_EXITED,
                    None,
                ),
                (COREWEBVIEW2_PROCESS_FAILED_KIND_GPU_PROCESS_EXITED, None),
                (
                    COREWEBVIEW2_PROCESS_FAILED_KIND_UTILITY_PROCESS_EXITED,
                    None,
                ),
                (
                    COREWEBVIEW2_PROCESS_FAILED_KIND_SANDBOX_HELPER_PROCESS_EXITED,
                    None,
                ),
                (
                    COREWEBVIEW2_PROCESS_FAILED_KIND_PPAPI_PLUGIN_PROCESS_EXITED,
                    None,
                ),
                (
                    COREWEBVIEW2_PROCESS_FAILED_KIND_PPAPI_BROKER_PROCESS_EXITED,
                    None,
                ),
                (
                    COREWEBVIEW2_PROCESS_FAILED_KIND_UNKNOWN_PROCESS_EXITED,
                    None,
                ),
                // 以后的运行时新增的类型
                (COREWEBVIEW2_PROCESS_FAILED_KIND(42), None),
            ] {
                assert_eq!(renderer_failure(kind), expected, "{kind:?}");
            }
        }

        /// 两种要重载的故障在本机锁定的 webview2-com 里的取值与 WebView2 SDK 头文件一致。
        #[test]
        fn renderer_failure_kinds_have_the_sdk_values() {
            assert_eq!(COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_EXITED.0, 1);
            assert_eq!(
                COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_UNRESPONSIVE.0,
                2
            );
        }
    }
}

#[cfg(test)]
mod tests {
    use std::cell::Cell;

    use super::*;

    fn secs(n: u64) -> Duration {
        Duration::from_secs(n)
    }

    /// 记下 reload 被调了几次。
    fn reloader(count: &Cell<usize>) -> impl FnOnce() -> Result<(), String> + '_ {
        move || {
            count.set(count.get() + 1);
            Ok(())
        }
    }

    #[test]
    fn a_single_crash_is_reloaded_once() {
        let mut recovery = RendererRecovery::default();
        let reloads = Cell::new(0);
        let verdict =
            recovery.on_failure(RendererFailure::Exited, Instant::now(), reloader(&reloads));
        assert_eq!(verdict, Verdict::Reload { attempt: 1 });
        assert_eq!(reloads.get(), 1);
    }

    /// 一加载就崩：窗口内重载两次，第三次停下并不再调用重载。
    #[test]
    fn third_failure_within_the_window_stops_reloading() {
        let mut recovery = RendererRecovery::default();
        let reloads = Cell::new(0);
        let t0 = Instant::now();
        let verdicts: Vec<Verdict> = [secs(0), secs(1), secs(2)]
            .into_iter()
            .map(|at| recovery.on_failure(RendererFailure::Exited, t0 + at, reloader(&reloads)))
            .collect();
        assert_eq!(
            verdicts,
            vec![
                Verdict::Reload { attempt: 1 },
                Verdict::Reload { attempt: 2 },
                Verdict::GiveUp
            ]
        );
        assert_eq!(reloads.get(), MAX_RELOADS);
    }

    /// 一直卡死的页面每 15 秒报一次无响应：停下之后一直停着，五分钟里一次也不再重载，不会每分钟被重载两次。
    #[test]
    fn a_page_that_stays_hung_is_not_reloaded_again() {
        let mut recovery = RendererRecovery::default();
        let reloads = Cell::new(0);
        let t0 = Instant::now();
        let mut verdicts = Vec::new();
        for i in 0..=20u64 {
            verdicts.push(recovery.on_failure(
                RendererFailure::Unresponsive,
                t0 + secs(15 * i),
                reloader(&reloads),
            ));
        }
        assert_eq!(reloads.get(), 2);
        assert_eq!(
            verdicts[..3],
            [
                Verdict::Reload { attempt: 1 },
                Verdict::Reload { attempt: 2 },
                Verdict::GiveUp
            ]
        );
        assert!(verdicts[3..].iter().all(|v| *v == Verdict::StillStopped));
    }

    /// 停下之后安静了整整一个窗口：上一轮已经过去，下一次故障重新有两次重载；差 1 毫秒不算。
    #[test]
    fn a_quiet_window_after_stopping_restores_the_budget() {
        let t0 = Instant::now();
        let stopped_at = |budget: &mut ReloadBudget| {
            for at in [secs(0), secs(1)] {
                assert!(matches!(budget.judge(t0 + at), Verdict::Reload { .. }));
            }
            assert_eq!(budget.judge(t0 + secs(2)), Verdict::GiveUp);
            t0 + secs(2)
        };

        let mut budget = ReloadBudget::default();
        let last = stopped_at(&mut budget);
        assert_eq!(
            budget.judge(last + RELOAD_WINDOW - Duration::from_millis(1)),
            Verdict::StillStopped
        );

        let mut budget = ReloadBudget::default();
        let last = stopped_at(&mut budget);
        let quiet = last + RELOAD_WINDOW;
        assert_eq!(budget.judge(quiet), Verdict::Reload { attempt: 1 });
        assert_eq!(
            budget.judge(quiet + secs(1)),
            Verdict::Reload { attempt: 2 }
        );
        assert_eq!(budget.judge(quiet + secs(2)), Verdict::GiveUp);
    }

    /// 滑动窗口的边界：最早那次重载满 60 秒即过期，差 1 毫秒仍在窗口里。
    #[test]
    fn a_reload_expires_exactly_one_window_later() {
        let t0 = Instant::now();
        let mut budget = ReloadBudget::default();
        assert_eq!(budget.judge(t0), Verdict::Reload { attempt: 1 });
        assert_eq!(budget.judge(t0 + secs(30)), Verdict::Reload { attempt: 2 });
        assert_eq!(
            budget.judge(t0 + RELOAD_WINDOW),
            Verdict::Reload { attempt: 2 }
        );

        let mut budget = ReloadBudget::default();
        assert_eq!(budget.judge(t0), Verdict::Reload { attempt: 1 });
        assert_eq!(budget.judge(t0 + secs(30)), Verdict::Reload { attempt: 2 });
        assert_eq!(
            budget.judge(t0 + RELOAD_WINDOW - Duration::from_millis(1)),
            Verdict::GiveUp
        );
    }

    /// 重载调用失败也算用掉一次，不因为失败就在同一刻反复重试。
    #[test]
    fn a_failed_reload_still_counts() {
        let mut recovery = RendererRecovery::default();
        let calls = Cell::new(0);
        let t0 = Instant::now();
        for (at, expected) in [
            (secs(0), Verdict::Reload { attempt: 1 }),
            (secs(1), Verdict::Reload { attempt: 2 }),
            (secs(2), Verdict::GiveUp),
        ] {
            let verdict = recovery.on_failure(RendererFailure::Exited, t0 + at, || {
                calls.set(calls.get() + 1);
                Err("WebView 已关闭")
            });
            assert_eq!(verdict, expected);
        }
        assert_eq!(calls.get(), 2);
    }

    /// 随机的故障节奏下（固定种子，可复现），任意 60 秒里的自动重载不超过两次；停下之后，没隔满一个窗口的
    /// 安静期就不再重载。
    #[test]
    fn no_more_than_two_reloads_in_any_window_under_random_failures() {
        for seed in [0x9E37_79B9_7F4A_7C15u64, 1, 0xDEAD_BEEF, 20_261_031] {
            let mut state = seed | 1;
            let mut next = || {
                state ^= state << 13;
                state ^= state >> 7;
                state ^= state << 17;
                state
            };
            let t0 = Instant::now();
            let mut budget = ReloadBudget::default();
            let mut at = t0;
            let mut previous: Option<Instant> = None;
            let mut stopped = false;
            let mut reloads: Vec<Instant> = Vec::new();
            for _ in 0..2_000 {
                // 间隔 0 到 90 秒，含正好落在窗口边界上的情形
                at += Duration::from_millis(next() % 90_001);
                match budget.judge(at) {
                    Verdict::Reload { attempt } => {
                        if stopped {
                            let gap = at - previous.expect("停下之前必有故障");
                            assert!(
                                gap >= RELOAD_WINDOW,
                                "seed {seed}：停下后只隔 {gap:?} 就重载"
                            );
                        }
                        stopped = false;
                        reloads.push(at);
                        let in_window = reloads.iter().filter(|r| at - **r < RELOAD_WINDOW).count();
                        assert_eq!(attempt, in_window, "seed {seed}");
                        assert!(in_window <= MAX_RELOADS, "seed {seed}");
                    }
                    Verdict::GiveUp => {
                        assert!(!stopped, "seed {seed}：已停下时不该再报一次 GiveUp");
                        stopped = true;
                    }
                    Verdict::StillStopped => assert!(stopped, "seed {seed}"),
                }
                previous = Some(at);
            }
            assert!(
                reloads.len() > MAX_RELOADS,
                "seed {seed}：随机节奏应当覆盖到窗口过期后的重载"
            );
        }
    }
}
