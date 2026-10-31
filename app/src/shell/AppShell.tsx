// 外壳布局：窗口背景层、左侧 84px 侧栏槽位、主列（标题栏 + 内容区），以及始终挂着的通知、登录流程、
// 新建实例流程与浮层根（应用根元素的最后一个子元素）。首次启动时整窗换成向导：只留一条带徽记与窗口三键的标题条。
//
// 页面与流程模块由 App 收集后传进来：外壳不引用 pages/ 与 flows/，依赖方向只从 App 指向两边。
// 内容区按路由键挂载页面：同一实例换分页、设置换分区不重新挂载；每个页面各有一层错误边界。

import { AnimatePresence, motion } from "framer-motion";
import { Suspense, useCallback, useEffect, useMemo, useRef, useState, type ComponentType } from "react";
import { PanoramaBackdrop } from "../art/panorama/PanoramaBackdrop";
import { PetalCanvas } from "../art/petals/PetalCanvas";
import type { PetalDowngrade } from "../art/petals/engine";
import { Logo } from "../art/Logo";
import { thumbRegister } from "../ipc/art";
import { logDiagnostic } from "../ipc/diagnostics";
import { createThumbResolver } from "../mc/art";
import { useAppearance } from "../state/appearance";
import type { FlowProps } from "../state/flows";
import { useLauncher } from "../state/launcher";
import { routeKey, type Route } from "../state/route";
import { RemoteImageProvider } from "../ui/remote-image";
import styles from "./AppShell.module.css";
import { ChromeProvider, type ChromeApi } from "./chrome";
import { CommandPalette } from "./CommandPalette";
import { SHELL_ACTION_ERROR } from "../copy/shell";
import { FOCUS_FALLBACK_ATTR, OverlayRoot } from "./overlay";
import { PageErrorBoundary } from "./PageError";
import type { AnyPage, PageRegistry } from "./pages";
import { useNav, useShell } from "./shell";
import { Sidebar } from "./Sidebar";
import { TitleBar, useReportedWindowFrame, WindowControls } from "./TitleBar";
import { Toasts } from "./Toasts";
import { useRunner } from "./useRunner";
import { useRevealWindow } from "./window";
import { useAfterLaunch, useBackgroundAttention, useCloseGuard } from "./window-behavior";

export interface ShellFlows {
  login: ComponentType<FlowProps<"login">>;
  /** 首次启动向导；模块不存在时为 null，首次启动直接进主界面。 */
  onboarding: ComponentType<FlowProps<"onboarding">> | null;
  /** 新建实例流程；模块不存在时为 null，打开请求记一条警告后收回。 */
  createInstance: ComponentType<FlowProps<"create-instance">> | null;
}

export interface AppShellProps {
  pages: PageRegistry;
  flows: ShellFlows;
}

/** 首帧与窗口显示之后再预载其余页面，不和首屏抢主线程。 */
export const PAGE_PRELOAD_DELAY_MS = 800;

// 资源图标、资讯配图、服务器图标的地址解析：同一地址整个进程只向后端登记一次，所以解析函数只建一份
const resolveRemoteImage = createThumbResolver(thumbRegister);

export function AppShell({ pages, flows }: AppShellProps) {
  const { state } = useLauncher();
  const { bindRoot, bindPageScroll } = useShell();
  const { appearance, reduced } = useAppearance();
  const run = useRunner();

  useRevealWindow(state.status.firstRun.kind !== "loading");
  useCloseGuard();
  useAfterLaunch();
  useBackgroundAttention();

  useEffect(() => {
    const timer = window.setTimeout(() => void run(() => pages.preloadAll(), SHELL_ACTION_ERROR.pagePreload), PAGE_PRELOAD_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [pages, run]);

  const onboarding = state.firstRun === true ? flows.onboarding : null;
  const warnedOnboarding = useRef(false);
  useEffect(() => {
    if (state.firstRun !== true || flows.onboarding !== null || warnedOnboarding.current) return;
    warnedOnboarding.current = true;
    console.warn("[shell] 首次启动向导模块不存在，直接进入主界面");
  }, [flows.onboarding, state.firstRun]);

  // 内容区滚动容器：交给外壳核心记录滚动位置，也给侧栏与命令面板用
  const scrollEl = useRef<HTMLDivElement | null>(null);
  const bindScroll = useCallback(
    (el: HTMLDivElement | null) => {
      scrollEl.current = el;
      bindPageScroll(el);
    },
    [bindPageScroll],
  );
  const chrome = useMemo<ChromeApi>(() => {
    const content = () => {
      const el = scrollEl.current;
      if (el === null) throw new Error("内容区还没挂载");
      return el;
    };
    return {
      scrollContentToTop: () => content().scrollTo({ top: 0, behavior: reduced ? "auto" : "smooth" }),
      focusContent: () => content().focus({ preventScroll: true }),
    };
  }, [reduced]);

  return (
    <ChromeProvider value={chrome}>
      <RemoteImageProvider resolve={resolveRemoteImage}>
        <div ref={bindRoot} className={styles.app}>
          <div className={styles.backdrop} aria-hidden="true">
            <PanoramaBackdrop enabled={appearance.panorama} />
          </div>
          {/* 向导收尾后先播完它自己的退场，再换成主界面：两者都占满整个网格，不能叠着同时出现 */}
          <AnimatePresence mode="wait">
            {onboarding !== null ? (
              <OnboardingFrame key="onboarding" Flow={onboarding} />
            ) : (
              <MainFrame key="main" pages={pages} bindScroll={bindScroll} />
            )}
          </AnimatePresence>
          <Toasts />
          <LoginMount Flow={flows.login} />
          <CreateInstanceMount Flow={flows.createInstance} />
          <OverlayRoot />
        </div>
      </RemoteImageProvider>
    </ChromeProvider>
  );
}

function MainFrame({ pages, bindScroll }: { pages: PageRegistry; bindScroll: (el: HTMLDivElement | null) => void }) {
  const { route } = useNav();
  const { tier, petalsPaused } = useShell();
  const { appearance, reduced } = useAppearance();
  const run = useRunner();
  const onDowngrade = useCallback(
    (event: PetalDowngrade) =>
      void run(
        () => logDiagnostic("warn", "花瓣降级", { tier: event.tier, level: event.level, windowMediansMs: [...event.windowMediansMs] }),
        SHELL_ACTION_ERROR.petalsLog,
      ),
    [run],
  );
  const key = routeKey(route);
  return (
    <>
      {/* 槽位的空白是窗口拖动区（只认直接点在槽位上），侧栏胶囊本身不是 */}
      <div className={styles.sidebarSlot} data-tauri-drag-region="">
        <Sidebar />
      </div>
      <div className={styles.main}>
        <TitleBar />
        <div className={styles.content}>
          <PetalCanvas
            show={route.page === "home" && appearance.petals}
            paused={petalsPaused}
            reduced={reduced}
            tier={tier}
            mode={appearance.mode}
            accent={appearance.accent}
            onDowngrade={onDowngrade}
          />
          <motion.div ref={bindScroll} className={styles.scroll} layoutScroll tabIndex={-1} {...{ [FOCUS_FALLBACK_ATTR]: "" }}>
            <PageErrorBoundary key={key} page={route.page}>
              <PageView route={route} pages={pages} />
            </PageErrorBoundary>
          </motion.div>
        </div>
        <CommandPalette />
      </div>
    </>
  );
}

/** 一次挂载内固定用同一个组件：挂载时已加载的页面直接渲染，没加载的经 lazy 挂起。 */
function PageView({ route, pages }: { route: Route; pages: PageRegistry }) {
  const [Page] = useState<AnyPage>(() => {
    const resolved = pages.resolved(route.page);
    return resolved === null ? pages.lazy(route.page) : resolved;
  });
  return (
    <Suspense fallback={null}>
      <Page route={route} />
    </Suspense>
  );
}

function OnboardingFrame({ Flow }: { Flow: ComponentType<FlowProps<"onboarding">> }) {
  const frame = useReportedWindowFrame();
  return (
    <div className={styles.onboarding}>
      <header className={styles.strip} data-tauri-drag-region="deep" data-blurred={!frame.focused || undefined}>
        <Logo size={20} className={styles.stripLogo} />
        <WindowControls maximized={frame.maximized} />
      </header>
      <div className={styles.onboardingBody}>
        <Suspense fallback={null}>
          <Flow />
        </Suspense>
      </div>
    </div>
  );
}

function LoginMount({ Flow }: { Flow: ComponentType<FlowProps<"login">> }) {
  const { state } = useLauncher();
  const login = state.login;
  return <AnimatePresence>{login !== null && <Flow key={login.kind} login={login} />}</AnimatePresence>;
}

function CreateInstanceMount({ Flow }: { Flow: ComponentType<FlowProps<"create-instance">> | null }) {
  const { createInstance, closeCreateInstance } = useShell();
  const warned = useRef(false);
  // 没有流程模块时把打开请求立即收回，免得外壳一直以为流程开着
  useEffect(() => {
    if (!createInstance.open || Flow !== null) return;
    if (!warned.current) console.warn("[shell] 新建实例流程模块不存在，打开请求没有界面可显示");
    warned.current = true;
    closeCreateInstance();
  }, [Flow, closeCreateInstance, createInstance.open]);
  if (Flow === null) return null;
  return (
    <AnimatePresence>
      {createInstance.open && (
        <Suspense key="create-instance" fallback={null}>
          <Flow preset={createInstance.preset} onClose={closeCreateInstance} />
        </Suspense>
      )}
    </AnimatePresence>
  );
}
