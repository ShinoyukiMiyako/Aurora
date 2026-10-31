// 外壳核心（不含视觉件）：路由与历史栈、浮层根的提供者、命令式确认框、命令面板与新建实例的开合、
// 全局快捷键、尺寸分档、运行呼吸窗口、材质状态绑定，以及启动层要的宿主能力。
// 标题栏、侧栏、命令面板、通知容器等视觉件只读这里导出的 useShell / useNav，不各自持有这些状态。
//
// 装配：AppearanceProvider -> LauncherProvider -> ShellProvider -> 外壳布局。外壳布局把应用根元素交给 bindRoot、
// 内容区滚动容器交给 bindPageScroll，并把 OverlayRoot 放在应用根元素的最后一个子位置。

import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ACTION_ERROR, TOAST_COPY } from "../copy/flows";
import { artStatus, onArtChanged } from "../ipc/art";
import { endBreathWindow, startBreathWindow } from "../launch/breath";
import { LaunchHostProvider, type ConfirmOptions, type LaunchHost } from "../launch/host";
import { bindArtStatus } from "../mc/binding";
import type { CreateInstancePreset } from "../state/flows";
import { useLauncher } from "../state/launcher";
import { routeInstanceId, type Route } from "../state/route";
import { pinnedInstances } from "../state/selectors";
import { launchPromptCopy } from "../state/store";
import type { Toast } from "../state/toasts";
import { ConfirmDialog } from "../ui/ConfirmDialog";
import { useGlobalShortcuts, type Shortcut } from "./keys";
import {
  canBack,
  canForward,
  currentEntry,
  effectiveRoute,
  initialHistory,
  navBack,
  navForward,
  navGo,
  navReplace,
  pruneHistory,
  recordScroll,
  renameInHistory,
  type NavHistory,
} from "./nav";
import { OverlayProvider, useOverlayControls, useOverlayState } from "./overlay";
import { useTier, type Tier } from "./tier";
import { useRunner } from "./useRunner";

export type { ConfirmOptions } from "../launch/host";

export interface NavApi {
  /** 当前路由；指向已不存在的实例时已按实例库给出，页面拿不到不存在的 id。 */
  route: Route;
  canBack: boolean;
  canForward: boolean;
  /** 侧栏、卡片、链接、命令面板跳转：压入新历史项，回到顶部。与当前路由相同时什么都不做。 */
  go(route: Route): void;
  /** 实例详情切 Tab、设置切分区、发现页改关键词：替换当前项，保留滚动位置。 */
  replace(route: Route): void;
  back(): void;
  forward(): void;
}

export interface PaletteState {
  open: boolean;
  /** 打开时带入的初始关键词；每次打开都从这里重新开始，不保留上次输入。 */
  query: string;
}

export interface CreateInstanceState {
  open: boolean;
  preset: CreateInstancePreset | null;
}

export interface ShellApi {
  tier: Tier;
  /** 命令式确认：确认为 true；取消、Esc、被新的确认顶掉为 false。 */
  confirm(options: ConfirmOptions): Promise<boolean>;
  palette: PaletteState;
  openPalette(query?: string): void;
  closePalette(): void;
  createInstance: CreateInstanceState;
  openCreateInstance(preset?: CreateInstancePreset): void;
  closeCreateInstance(): void;
  /** 页面级 Ctrl+F：页面挂载时登记、卸载时调用返回的函数注销；后登记的优先。 */
  registerFind(handler: () => void): () => void;
  /** 通知的动作：先关闭这条通知，再导航或经统一错误处理执行命令。 */
  runToastAction(toast: Toast): void;
  /**
   * 写剪贴板，给 CopyButton、KV、LogConsole 的 onCopy 直接用：写入成功为 true；失败经统一错误处理弹出「复制失败」后为 false，
   * 永不 reject（失败已经报告过，再抛回去会报两次）。
   */
  copyText(text: string): Promise<boolean>;
  /** 主页花瓣暂停：窗口不可见、失焦或有带遮罩的浮层。 */
  petalsPaused: boolean;
  /** 应用根元素（尺寸分档按它的宽度）。 */
  bindRoot(el: HTMLElement | null): void;
  /** 内容区唯一的纵向滚动容器（历史项的滚动位置记录与恢复）。 */
  bindPageScroll(el: HTMLElement | null): void;
}

const NavContext = createContext<NavApi | null>(null);
const ShellContext = createContext<ShellApi | null>(null);

export function useNav(): NavApi {
  const api = useContext(NavContext);
  if (api === null) throw new Error("useNav 必须在 ShellProvider 之内使用");
  return api;
}

export function useShell(): ShellApi {
  const api = useContext(ShellContext);
  if (api === null) throw new Error("useShell 必须在 ShellProvider 之内使用");
  return api;
}

export function ShellProvider({ children }: { children: ReactNode }) {
  return (
    <OverlayProvider>
      <ShellCore>{children}</ShellCore>
    </OverlayProvider>
  );
}

type NavIntent = "go" | "back" | "forward";

interface ConfirmRequest {
  id: number;
  options: ConfirmOptions;
  resolve: (ok: boolean) => void;
}

function ShellCore({ children }: { children: ReactNode }) {
  const { state, actions } = useLauncher();
  const run = useRunner();
  const overlay = useOverlayControls();
  const { scrimOpen } = useOverlayState();

  // ---------------------------------------------------------------- 历史

  const [history, setHistoryState] = useState<NavHistory>(initialHistory);
  const historyRef = useRef(history);
  const intentRef = useRef<NavIntent | null>(null);
  const scrollRef = useRef<HTMLElement | null>(null);

  /** 事件处理器里连续导航时读的是 ref 里的最新值，不等重渲染。 */
  const commit = useCallback((next: NavHistory, intent: NavIntent | null) => {
    if (next === historyRef.current) return;
    historyRef.current = next;
    if (intent !== null) intentRef.current = intent;
    setHistoryState(next);
  }, []);

  const scrollTop = () => (scrollRef.current === null ? 0 : scrollRef.current.scrollTop);

  const go = useCallback(
    (route: Route) => {
      const base = historyRef.current;
      if (navGo(base, route) === base) return;
      commit(navGo(recordScroll(base, scrollTop()), route), "go");
    },
    [commit],
  );
  const replace = useCallback((route: Route) => commit(navReplace(historyRef.current, route), null), [commit]);
  const back = useCallback(() => {
    const base = historyRef.current;
    if (!canBack(base)) return;
    commit(navBack(recordScroll(base, scrollTop())), "back");
  }, [commit]);
  const forward = useCallback(() => {
    const base = historyRef.current;
    if (!canForward(base)) return;
    commit(navForward(recordScroll(base, scrollTop())), "forward");
  }, [commit]);

  // 改名不是删除：先把历史里的旧 id 换成新 id，再剪除失效项。改名与新列表同一次到达，
  // 渲染时就按改名后的历史算当前路由，不会有一帧落到实例库
  const [appliedRename, setAppliedRename] = useState(() => (state.lastRename === null ? 0 : state.lastRename.seq));
  const rename = state.lastRename !== null && state.lastRename.seq !== appliedRename ? state.lastRename : null;
  const viewHistory = rename === null ? history : renameInHistory(history, rename.from, rename.to);

  const instancesReady = state.status.instances.kind === "ready";
  const instanceIds = useMemo(() => new Set(state.instances.map((i) => i.id)), [state.instances]);
  useEffect(() => {
    let next = historyRef.current;
    if (rename !== null) next = renameInHistory(next, rename.from, rename.to);
    // 实例列表还没读到时不剪：此时列表为空，会把所有实例页都当成失效
    if (instancesReady) next = pruneHistory(next, (r) => {
      const id = routeInstanceId(r);
      return id === null || instanceIds.has(id);
    });
    commit(next, null);
    if (rename !== null) setAppliedRename(rename.seq);
  }, [commit, instanceIds, instancesReady, rename]);

  const current = currentEntry(viewHistory);
  const route = effectiveRoute(current.route, (id) => !instancesReady || instanceIds.has(id));

  // go 进新项回到顶部；后退、前进恢复该项离开时的位置（内容不够高时浏览器自动取能滚到的最大值）；replace 不动
  useLayoutEffect(() => {
    const intent = intentRef.current;
    intentRef.current = null;
    const el = scrollRef.current;
    if (intent === null || el === null) return;
    if (intent === "go") {
      el.scrollTop = 0;
      return;
    }
    const target = current.scrollTop;
    el.scrollTop = target;
    // 页面是按需加载的，首帧可能还没有内容高度；下一帧再落一次
    const frame = requestAnimationFrame(() => {
      el.scrollTop = target;
    });
    return () => cancelAnimationFrame(frame);
  }, [current.seq, current.scrollTop, viewHistory.index]);

  // 打开该实例的崩溃诊断页即收起它的崩溃会话：诊断已经在页面上，状态岛不必再停着
  const crashedHere = state.session !== null && state.session.phase === "crashed" && route.page === "instance" && route.tab === "crash" && route.id === state.session.instanceId;
  useEffect(() => {
    if (crashedHere) actions.dismissSession();
  }, [actions, crashedHere]);

  // ---------------------------------------------------------------- 确认框

  const [confirmRequest, setConfirmRequest] = useState<ConfirmRequest | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const pendingRef = useRef<ConfirmRequest | null>(null);
  const confirmSeq = useRef(0);

  const confirm = useCallback((options: ConfirmOptions) => {
    return new Promise<boolean>((resolve) => {
      // 新的确认顶掉尚未回答的旧请求：旧请求按取消结算
      if (pendingRef.current !== null) pendingRef.current.resolve(false);
      confirmSeq.current += 1;
      const request: ConfirmRequest = { id: confirmSeq.current, options, resolve };
      pendingRef.current = request;
      setConfirmRequest(request);
      setConfirmOpen(true);
    });
  }, []);

  const settleConfirm = useCallback((ok: boolean) => {
    const request = pendingRef.current;
    if (request === null) return;
    pendingRef.current = null;
    request.resolve(ok);
    setConfirmOpen(false);
  }, []);

  // 另一实例占着游戏进程时再点启动：状态容器挂出 launchPrompt，这里弹替换确认并把回答交回
  const launchPrompt = state.launchPrompt;
  const promptRef = useRef<typeof launchPrompt>(null);
  useEffect(() => {
    if (launchPrompt === null || promptRef.current === launchPrompt) return;
    promptRef.current = launchPrompt;
    const copy = launchPromptCopy(launchPrompt);
    void confirm(copy).then((ok) => run(() => actions.resolveLaunchPrompt(ok), ACTION_ERROR.launch(launchPrompt.instanceId)));
  }, [actions, confirm, launchPrompt, run]);

  // ---------------------------------------------------------------- 命令面板、新建实例

  const [palette, setPalette] = useState<PaletteState>({ open: false, query: "" });
  const openPalette = useCallback((query = "") => setPalette({ open: true, query }), []);
  const closePalette = useCallback(() => setPalette((p) => (p.open ? { ...p, open: false } : p)), []);

  const [createInstance, setCreateInstance] = useState<CreateInstanceState>({ open: false, preset: null });
  const openCreateInstance = useCallback((preset?: CreateInstancePreset) => setCreateInstance({ open: true, preset: preset === undefined ? null : preset }), []);
  const closeCreateInstance = useCallback(() => setCreateInstance((c) => (c.open ? { ...c, open: false } : c)), []);

  const findHandlers = useRef<(() => void)[]>([]);
  const registerFind = useCallback((handler: () => void) => {
    findHandlers.current.push(handler);
    return () => {
      const i = findHandlers.current.lastIndexOf(handler);
      if (i >= 0) findHandlers.current.splice(i, 1);
    };
  }, []);

  // ---------------------------------------------------------------- 全局快捷键

  const shortcutState = { firstRun: state.firstRun, paletteOpen: palette.open, pins: pinnedInstances(state) };
  useGlobalShortcuts((shortcut: Shortcut) => {
    // 首次启动向导期间只有 Esc 生效（Esc 归浮层体系）
    if (shortcutState.firstRun === true) return;
    // 命令面板本身就是浮层：面板组件挂上 Esc 层之前的那一帧也按「有浮层」处理
    const overlayOpen = overlay.isOpen() || shortcutState.paletteOpen;
    switch (shortcut.kind) {
      case "palette":
        // 面板只能在没有浮层时打开；打开着的面板是栈顶（从面板触发的弹窗在面板关闭后才打开）
        if (shortcutState.paletteOpen) closePalette();
        else if (!overlayOpen) openPalette();
        return;
      case "back":
        // 有浮层时后退等同 Esc：只关栈顶一层，不后退
        if (!overlayOpen) back();
        else if (!overlay.closeTop()) closePalette();
        return;
      case "forward":
        if (!overlayOpen) forward();
        return;
      case "find": {
        const handler = findHandlers.current[findHandlers.current.length - 1];
        if (!overlayOpen && handler !== undefined) handler();
        return;
      }
      default:
        break;
    }
    if (overlayOpen) return;
    switch (shortcut.kind) {
      case "page":
        go({ page: shortcut.page });
        return;
      case "pin": {
        const inst = shortcutState.pins[shortcut.index];
        if (inst !== undefined) go({ page: "instance", id: inst.id, tab: "overview" });
        return;
      }
      case "create":
        openCreateInstance();
        return;
      case "settings":
        go({ page: "settings" });
        return;
    }
  });

  // ---------------------------------------------------------------- 尺寸分档、可见性与焦点

  const [rootEl, setRootEl] = useState<HTMLElement | null>(null);
  const tier = useTier(rootEl);
  const bindPageScroll = useCallback((el: HTMLElement | null) => {
    scrollRef.current = el;
  }, []);

  const [visible, setVisible] = useState(() => document.visibilityState !== "hidden");
  const [focused, setFocused] = useState(() => document.hasFocus());
  useEffect(() => {
    const onVisibility = () => setVisible(document.visibilityState !== "hidden");
    const onFocus = () => setFocused(true);
    const onBlur = () => setFocused(false);
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("focus", onFocus);
    window.addEventListener("blur", onBlur);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("blur", onBlur);
    };
  }, []);

  // 窗口不可见期间全部通知暂停计时
  useEffect(() => {
    if (visible) return;
    actions.pauseToasts("hidden");
    return () => actions.resumeToasts("hidden");
  }, [actions, visible]);

  // 运行呼吸窗口：进入运行、或运行中窗口重新获得焦点时开始；失焦或不可见立即结束
  const runningSince = state.session !== null && state.session.phase === "running" ? state.session.runningSince : null;
  const active = visible && focused;
  useEffect(() => {
    if (runningSince === null || !active) {
      endBreathWindow();
      return;
    }
    startBreathWindow();
    return () => endBreathWindow();
  }, [runningSince, active]);

  const petalsPaused = !visible || !focused || scrimOpen;

  // ---------------------------------------------------------------- 材质状态

  // 绑定只建一次；失败经统一错误处理报告（写控制台 + error 通知）
  const runRef = useRef(run);
  runRef.current = run;
  useEffect(() => {
    const report = (error: unknown) => void runRef.current(() => Promise.reject(error), ACTION_ERROR.artStatus);
    let disposed = false;
    let unbind: (() => void) | null = null;
    bindArtStatus({
      load: artStatus,
      listenChanged: (handler) => onArtChanged(() => handler()),
      onError: report,
    }).then(
      (release) => {
        if (disposed) release();
        else unbind = release;
      },
      report,
    );
    return () => {
      disposed = true;
      if (unbind !== null) unbind();
    };
  }, []);

  // ---------------------------------------------------------------- 通知动作与启动宿主

  const runToastAction = useCallback(
    (toast: Toast) => {
      const action = toast.action;
      if (action === undefined) throw new Error(`通知「${toast.title}」没有动作`);
      actions.dismissToast(toast.id);
      if ("to" in action) go(action.to);
      else void run(action.run, action.errorTitle);
    },
    [actions, go, run],
  );

  const copyText = useCallback(async (text: string) => (await run(() => navigator.clipboard.writeText(text), TOAST_COPY.copyFailed)).ok, [run]);

  const launchHost = useMemo<LaunchHost>(() => ({ run, go, confirm }), [confirm, go, run]);

  const nav = useMemo<NavApi>(
    () => ({ route, canBack: canBack(viewHistory), canForward: canForward(viewHistory), go, replace, back, forward }),
    [back, forward, go, replace, route, viewHistory],
  );

  const shell = useMemo<ShellApi>(
    () => ({
      tier,
      confirm,
      palette,
      openPalette,
      closePalette,
      createInstance,
      openCreateInstance,
      closeCreateInstance,
      registerFind,
      runToastAction,
      copyText,
      petalsPaused,
      bindRoot: setRootEl,
      bindPageScroll,
    }),
    [bindPageScroll, closeCreateInstance, closePalette, confirm, copyText, createInstance, openCreateInstance, openPalette, palette, petalsPaused, registerFind, runToastAction, tier],
  );

  return (
    <NavContext.Provider value={nav}>
      <ShellContext.Provider value={shell}>
        <LaunchHostProvider host={launchHost}>
          {children}
          {confirmRequest !== null && (
            <ConfirmDialog
              key={confirmRequest.id}
              open={confirmOpen}
              {...confirmRequest.options}
              onConfirm={() => settleConfirm(true)}
              onClose={() => settleConfirm(false)}
            />
          )}
        </LaunchHostProvider>
      </ShellContext.Provider>
    </NavContext.Provider>
  );
}
