// 外壳布局：窗口背景层、左侧 84px 侧栏槽位（顶上一行品牌 + 胶囊）、主列（标题栏 + 内容区），以及始终挂着的通知、登录流程、
// 新建实例流程、启动器更新面板、拖放提示与浮层根（应用根元素的最后一个子元素）。首次启动时整窗换成向导：只留一条带徽记与窗口三键的标题条。
// 向导收尾时先播完它自己的退场（淡出并轻微放大），主界面再淡入；应用启动时已在的那一屏，侧栏与主列不播淡入，窗口显示时外壳就是成品。
//
// 页面与流程模块由 App 收集后传进来：外壳不引用 pages/ 与 flows/，依赖方向只从 App 指向两边。
// 内容区按路由键挂载页面：同一实例换分页、设置换分区不重新挂载；每个页面各有一层错误边界。

import { AnimatePresence, motion } from "framer-motion";
import { memo, Suspense, useCallback, useEffect, useMemo, useRef, useState, type ComponentType, type ReactNode, type RefObject } from "react";
import { PanoramaBackdrop } from "../art/panorama/PanoramaBackdrop";
import { PetalCanvas } from "../art/petals/PetalCanvas";
import type { PetalDowngrade } from "../art/petals/engine";
import { Logo } from "../art/Logo";
import { thumbRegister } from "../ipc/art";
import { logDiagnostic } from "../ipc/diagnostics";
import { createThumbResolver } from "../mc/art";
import { useAppearance } from "../state/appearance";
import type { FlowProps } from "../state/flows";
import { useLauncherActions, useLauncherSelector } from "../state/launcher";
import { prefetchGameDirectories } from "../state/queries/catalog";
import { routeKey, type Route } from "../state/route";
import { onboardingActive } from "../state/selectors";
import { ExternalLinkProvider } from "../ui/external-link";
import { PageArrivalProvider, type PageArrival } from "../ui/Page";
import { RemoteImageProvider } from "../ui/remote-image";
import styles from "./AppShell.module.css";
import { ChromeProvider, type ChromeApi } from "./chrome";
import { CommandPalette } from "./CommandPalette";
import { SHELL_ACTION_ERROR, SHELL_DEFECT_COPY } from "../copy/shell";
import { fade } from "../lib/motion";
import { useMounted } from "../lib/useMounted";
import { FOCUS_FALLBACK_ATTR, OverlayRoot } from "./overlay";
import { PageErrorBoundary } from "./PageError";
import type { AnyPage, PageRegistry } from "./pages";
import { useNav, useShell, type NavArrival } from "./shell";
import { Sidebar } from "./Sidebar";
import { TitleBar, useReportedWindowFrame, WindowControls } from "./TitleBar";
import { Toasts } from "./Toasts";
import { UpdatePanelMount } from "./UpdatePanel";
import { useRunner } from "./useRunner";
import { DropHint } from "./DropHint";
import { useStartupNotices, type StartupNotice } from "./startup-notices";
import { useDocumentLang } from "./useDocumentLang";
import { useRevealWindow } from "./window";
import { useAfterLaunch, useBackgroundAttention, useCloseGuard } from "./window-behavior";

export interface ShellFlows {
  login: ComponentType<FlowProps<"login">>;
  /**
   * 首次启动向导；模块不存在时为 null。首次启动遇到 null 视为构建不完整、整屏报错：向导负责选定游戏目录并标记首次启动完成，
   * 没有它就永远停在首次启动，导航快捷键也一直失效。
   */
  onboarding: ComponentType<FlowProps<"onboarding">> | null;
  /** 新建实例流程；模块不存在时为 null，打开请求记一条警告后收回。 */
  createInstance: ComponentType<FlowProps<"create-instance">> | null;
}

export interface AppShellProps {
  pages: PageRegistry;
  flows: ShellFlows;
  /** 后端在启动时记下的提示（例如配置文件损坏、已按默认设置启动）；给出时启动后读一次，逐条以通知显示。 */
  startupNotices?: () => Promise<readonly StartupNotice[]>;
}

/** 首帧与窗口显示之后再预载其余页面，不和首屏抢主线程。 */
export const PAGE_PRELOAD_DELAY_MS = 800;

// 资源图标、资讯配图、服务器图标的地址解析：同一地址整个进程只向后端登记一次，所以解析函数只建一份
const resolveRemoteImage = createThumbResolver(thumbRegister);

export function AppShell({ pages, flows, startupNotices }: AppShellProps) {
  // 按片订阅：外壳根只随「是否首次启动」变，下载进度与游戏日志不让整棵树跟着重渲染
  const firstRunKnown = useLauncherSelector((s) => s.status.firstRun.kind !== "loading");
  const firstRun = useLauncherSelector(onboardingActive);
  const { bindRoot, bindPageScroll, bindChrome, fileDropHint } = useShell();
  const { appearance, reduced } = useAppearance();
  const run = useRunner();
  const actions = useLauncherActions();
  // 组件库里的外部链接（资源介绍、更新说明）与其他打开网址的入口走同一个出口，失败经统一错误处理弹通知
  const openLink = useCallback((url: string) => void run(() => actions.openExternal(url), SHELL_ACTION_ERROR.openLink), [actions, run]);

  useRevealWindow(firstRunKnown);
  useCloseGuard();
  useAfterLaunch();
  useBackgroundAttention();
  useStartupNotices(startupNotices);
  useDocumentLang();

  useEffect(() => {
    const timer = window.setTimeout(() => void run(() => pages.preloadAll(), SHELL_ACTION_ERROR.pagePreload), PAGE_PRELOAD_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [pages, run]);

  // 主界面一出来就把游戏目录列表取进缓存：实例库工具条的目录选择要在第一帧就在，不等进页面才去要、晚到再淡入插进来。
  // 首次启动向导期间不取：目录还没选定，取到的是向导之前的旧记录
  useEffect(() => {
    if (firstRunKnown && !firstRun) prefetchGameDirectories();
  }, [firstRunKnown, firstRun]);

  if (firstRun && flows.onboarding === null) throw new Error(SHELL_DEFECT_COPY.missingOnboarding);
  const onboarding = firstRun ? flows.onboarding : null;

  // 应用启动时就在的那一屏不播两列的淡入；之后才挂上的主界面（向导收尾）照常淡入
  const booted = useMounted();

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
  // 全局快捷键的目标就是当前页时，外壳核心也要滚回顶部；同一份实现，减少动画的取舍不分两处写
  useEffect(() => {
    bindChrome(chrome);
    return () => bindChrome(null);
  }, [bindChrome, chrome]);

  return (
    <ChromeProvider value={chrome}>
      <ExternalLinkProvider open={openLink}>
        <RemoteImageProvider resolve={resolveRemoteImage}>
          <div ref={bindRoot} className={styles.app}>
            <div className={styles.backdrop} aria-hidden="true">
              <PanoramaBackdrop enabled={appearance.panorama} />
            </div>
            {/*
              向导收尾后先播完它自己的退场，再换成主界面：两者都占满整个网格，不能叠着同时出现。
              这里不能写 initial={false}：它会把「不播入场」记在首屏那一支的上下文里，整场会话不再更新，
              之后在它下面挂载的每个页面、每个分页面板的入场都被一并跳过。启动那一屏不淡入改由 MainFrame 自己管。
              presenceAffectsLayout 关掉：开着时外壳根每重渲染一次（命令面板开合、窗口失焦、分档变化），在场上下文都换一个新对象，
              主界面里每个读它的 motion 元素（侧栏、标题栏、页面）都跟着重渲染，带布局动画的还要重量一次布局。
              这里同一时刻只有一支，没有兄弟要随它进出让位，换场靠的是 isPresent 本身的变化，不靠这个新对象。
            */}
            <AnimatePresence mode="wait" presenceAffectsLayout={false}>
              {onboarding !== null ? (
                <OnboardingFrame key="onboarding" Flow={onboarding} />
              ) : (
                <MainFrame key="main" pages={pages} bindScroll={bindScroll} enter={booted.current} />
              )}
            </AnimatePresence>
            <DropHint hint={fileDropHint} />
            <Toasts />
            <LoginMount Flow={flows.login} />
            <CreateInstanceMount Flow={flows.createInstance} />
            <UpdatePanelMount />
            <OverlayRoot />
          </div>
        </RemoteImageProvider>
      </ExternalLinkProvider>
    </ChromeProvider>
  );
}

/** 主界面的两列各自淡入（它们是网格的直接子项，不能再包一层）。 */
const MAIN_ENTER = { initial: { opacity: 0 }, animate: { opacity: 1, transition: fade.in } } as const;
/** 应用启动时就在的那一屏：两列一挂上就不透明。initial={false} 只管这两个元素自己，不波及里面的页面。 */
const MAIN_STILL = { initial: false, animate: { opacity: 1, transition: fade.in } } as const;

/**
 * 新挂载的页面怎么入场：后退、前进回到看过的位置，重播首访的区块错开像重新加载，只留根淡入；
 * 应用启动的那一屏与两列一样，窗口显示时就是成品（窗口要等首帧之后才显示，入场会被截掉开头）。
 */
const PAGE_ARRIVAL: Readonly<Record<NavArrival, PageArrival>> = {
  boot: "still",
  go: "enter",
  replace: "enter",
  back: "return",
  forward: "return",
};

/**
 * 页面槽：放在错误边界里面，槽每次挂上时取一次到达方式，之后不再变。换路由键、错误页点「重新加载」都是连槽一起重挂，
 * 新挂上的页面拿到的就是这一次导航的到达方式；槽挂着期间主界面再重渲染（分档、花瓣暂停）不改它，
 * 已经挂着的页面不会因为取值变了多重渲染一次。
 * 导航状态停在 boot 直到第一次导航，但启动那一屏只有一次：主界面挂上之后、还没导航就重挂的页面
 * （重新加载、实例被删退回实例库）按新进入处理，不然错误视图淡入了，重载回来的页面反而一帧硬切出来。
 */
function PageArrivalSlot({ arrival, bootShown, children }: { arrival: NavArrival; bootShown: RefObject<boolean>; children: ReactNode }) {
  const [value] = useState<PageArrival>(() => (arrival === "boot" && bootShown.current ? "enter" : PAGE_ARRIVAL[arrival]));
  return <PageArrivalProvider value={value}>{children}</PageArrivalProvider>;
}

/**
 * 只随路由、分档与外观重渲染：父级（外壳根、AnimatePresence）重渲染时 props 不变就跳过。
 * enter 只在挂载那一刻起作用：两列要不要淡入。
 */
const MainFrame = memo(function MainFrame({ pages, bindScroll, enter }: { pages: PageRegistry; bindScroll: (el: HTMLDivElement | null) => void; enter: boolean }) {
  const { route, arrival } = useNav();
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
  // 挂载之后 enter 再变不改已经定下的入场：记住挂载那一刻的取值
  const [columns] = useState(() => (enter ? MAIN_ENTER : MAIN_STILL));
  // 第一次提交带着启动那一屏（或它的错误视图）画出来之后，启动那一屏就用掉了
  const bootShown = useMounted();
  return (
    <>
      {/* 槽位的空白是窗口拖动区（只认直接点在槽位上），侧栏胶囊本身不是 */}
      <motion.div className={styles.sidebarSlot} data-tauri-drag-region="" {...columns}>
        <SidebarBrand />
        <Sidebar />
      </motion.div>
      <motion.div className={styles.main} {...columns}>
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
              <PageArrivalSlot arrival={arrival} bootShown={bootShown}>
                <PageView route={route} pages={pages} />
              </PageArrivalSlot>
            </PageErrorBoundary>
          </motion.div>
        </div>
        <CommandPalette />
      </motion.div>
    </>
  );
});

/** 窗口左上角的品牌行。焦点状态放在这一小块里订阅：窗口失焦时只换字标颜色，不牵动 MainFrame 重渲染。 */
function SidebarBrand() {
  const frame = useReportedWindowFrame();
  return (
    <div className={styles.brand} data-tauri-drag-region="deep" data-blurred={!frame.focused || undefined}>
      <Logo size={20} className={styles.stripLogo} />
    </div>
  );
}

/** 一次挂载内固定用同一个组件：挂载时已加载的页面直接渲染，没加载的经 lazy 挂起。路由不变时不重渲染。 */
const PageView = memo(function PageView({ route, pages }: { route: Route; pages: PageRegistry }) {
  const [Page] = useState<AnyPage>(() => {
    const resolved = pages.resolved(route.page);
    return resolved === null ? pages.lazy(route.page) : resolved;
  });
  return (
    <Suspense fallback={null}>
      <Page route={route} />
    </Suspense>
  );
});

function OnboardingFrame({ Flow }: { Flow: ComponentType<FlowProps<"onboarding">> }) {
  const frame = useReportedWindowFrame();
  return (
    <div className={styles.onboarding} data-sk-onboarding="">
      {/* 向导收尾时顶条随向导主体一起淡出，主界面再整体淡入：不然它全不透明地停到最后一帧才消失，徽记与窗口三键先断后回 */}
      <motion.header className={styles.strip} data-tauri-drag-region="deep" data-blurred={!frame.focused || undefined} exit={{ opacity: 0, transition: fade.out }}>
        <Logo size={20} className={styles.stripLogo} />
        <WindowControls maximized={frame.maximized} />
      </motion.header>
      <div className={styles.onboardingBody}>
        <Suspense fallback={null}>
          <Flow />
        </Suspense>
      </div>
    </div>
  );
}

function LoginMount({ Flow }: { Flow: ComponentType<FlowProps<"login">> }) {
  const login = useLauncherSelector((s) => s.login);
  return <AnimatePresence>{login !== null && <Flow key="login" login={login} />}</AnimatePresence>;
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
