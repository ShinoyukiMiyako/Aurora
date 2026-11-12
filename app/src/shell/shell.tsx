// 外壳核心（不含视觉件）：路由与历史栈、浮层根的提供者、命令式确认框、命令面板与新建实例的开合、
// 启动器更新面板的开合与自动检查、全局快捷键、尺寸分档、运行呼吸窗口、材质状态绑定，以及启动层要的宿主能力。
// 标题栏、侧栏、命令面板、通知容器等视觉件只读这里导出的 useShell / useNav，不各自持有这些状态。
//
// 装配：AppearanceProvider -> LauncherProvider -> ShellProvider -> 外壳布局。外壳布局把应用根元素交给 bindRoot、
// 内容区滚动容器交给 bindPageScroll，并把 OverlayRoot 放在应用根元素的最后一个子位置。

import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ACTION_ERROR, TOAST_COPY } from "../copy/flows";
import { artBlocks, artStatus, onArtChanged } from "../ipc/art";
import { endBreathWindow, startBreathWindow } from "../launch/breath";
import { LaunchHostProvider, type ConfirmOptions, type LaunchHost } from "../launch/host";
import { bindArtStatus } from "../mc/binding";
import { registerCatalogReload, settleArtDownload } from "../state/art-download";
import type { CreateInstancePreset } from "../state/flows";
import { shallowArrayEqual, useLauncherActions, useLauncherSelector } from "../state/launcher";
import { LIBRARY_ROUTE, routeInstanceId, routeKey, sameRoute, type Route } from "../state/route";
import { activeDownloads, activeTasks, pinnedInstances } from "../state/selectors";
import { gameDirDataRejectionOf } from "../state/errors";
import { launchPromptCopy, type SliceStatus } from "../state/store";
import type { Toast } from "../state/toasts";
import { phaseUpdate } from "../state/updater/machine";
import { UpdaterProvider, useUpdater, type UpdaterApi } from "../state/updater/useUpdater";
import { DROP_COPY, FILE_PICK_COPY, FILE_SAVE_COPY, SHELL_ACTION_ERROR } from "../copy/shell";
import { UPDATE_COPY } from "../copy/updater";
import { holdScroll } from "../lib/scroll-hold";
import { isTypingTarget } from "../lib/util";
import { ConfirmDialog } from "../ui/ConfirmDialog";
import { NAV_ANCHOR_ATTR } from "../ui/Page";
import type { ChromeApi } from "./chrome";
import { FILE_KINDS, useFileDrop, type FileDropHint, type FileDropTarget, type FileKind, type JarDropTarget } from "./file-drop";
import { assertPageCombo, matchesCombo, useGlobalShortcuts, type KeyCombo, type Shortcut } from "./keys";
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
import { pickFile as pickNativeFile, pickSaveFile as saveNativeFile, SAVE_FILE_KINDS, withExtension, type SaveFileDialog, type SaveFileKind } from "./platform";
import { useTier, type Tier } from "./tier";
import { useUpdaterAutoCheck } from "./update-check";
import { useRunner } from "./useRunner";
import { useWindowPort } from "./window";

export type { ConfirmOptions } from "../launch/host";

/** 最近一次导航是怎么来的：boot 应用启动后还没导航过，go 压入新项，back / forward 在历史里移动，replace 替换当前项。 */
export type NavArrival = "boot" | "go" | "back" | "forward" | "replace";

export interface NavApi {
  /** 当前路由；指向已不存在的实例时已按实例库给出，页面拿不到不存在的 id。 */
  route: Route;
  /** 当前路由是怎么来的；外壳据此决定新挂载的页面怎么入场。 */
  arrival: NavArrival;
  canBack: boolean;
  canForward: boolean;
  /** 侧栏、卡片、链接、命令面板跳转：压入新历史项，回到顶部。与当前路由相同时什么都不做。 */
  go(route: Route): void;
  /**
   * 实例详情切 Tab、设置切分区、发现页改关键词：替换当前项，保留滚动位置；
   * 页面标了导航锚点（NAV_ANCHOR_ATTR）且锚点已滚出视口上方时，先瞬时滚回锚点。
   * 标了锚点的页面还会被托住高度（新面板较短时滚动位置不被夹回），直到用户滚回页顶。
   */
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
  /** 启动器更新面板是否打开（外壳布局据此挂载面板）。 */
  updatePanelOpen: boolean;
  /**
   * 打开启动器更新面板：设置页的更新卡、发现新版本通知的「查看」都走这里。打开即算看过这一版，提示点随之消失。
   * 没有可查看的版本时调用属于调用方的错误，直接抛出。
   */
  openUpdatePanel(): void;
  closeUpdatePanel(): void;
  /**
   * 「重启并安装」：有活动任务时先确认会中断它们；安装会关闭启动器，动手前把任务表写盘，重启后能看到被中断的任务并重试。
   * 游戏会话进行中不允许安装，由入口自己禁用。失败经统一错误处理提示，永不 reject。
   */
  installUpdate(): Promise<void>;
  /** 页面级 Ctrl+F：页面挂载时登记、卸载时调用返回的函数注销；后登记的优先。 */
  registerFind(handler: () => void): () => void;
  /**
   * 页面级快捷键（实例详情的 F2 改名之类）：页面挂载时在 effect 里登记、卸载时调用返回的函数注销；同一组合后登记的优先。
   * 与全局快捷键同一套规则：只在没有浮层打开、不在首次启动向导时生效，输入法组字期间不响应，控件自己处理过的按键不再触发。
   * 不带 Ctrl / Alt 的组合（F2、字母）在焦点落在输入框里时不触发，那时按键属于输入框。
   * 占用全局快捷键或 Esc 属于设计错误，登记时抛出。
   */
  registerShortcut(combo: KeyCombo, handler: () => void): () => void;
  /**
   * 接收窗口级文件拖放：登记期间（通常是导入弹窗打开期间）独占全部文件拖放，外壳不再自己导航或提示，拖进来的服务器链接也不处理。
   * 没有接收方时，拖进 .mrpack / .zip 由外壳导航到发现页并带上 importFile；拖进外置登录服务器链接打开外置登录弹窗。
   */
  registerFileDrop(target: FileDropTarget): () => void;
  /** 登记收 .jar 的页面：只拿走 .jar，别的拖放仍归外壳；返回注销函数。 */
  registerJarDrop(target: JarDropTarget): () => void;
  /** 拖动经过窗口时外壳要显示的放置提示（外壳布局据此绘制）。 */
  fileDropHint: FileDropHint;
  /** 系统选择文件对话框，按文件种类给出标题与扩展名过滤；用户取消为 null。浏览器预览里没有这个对话框，如实拒绝。 */
  pickFile(kind: FileKind): Promise<string | null>;
  /**
   * 系统保存文件对话框：标题与类型过滤按文件种类取，或由页面直接给出（标题里要写存档名这类）；文件名框预填 defaultName，用户取消为 null。
   * 给回的路径一定带要求的扩展名（类型过滤的第一个）。浏览器预览里没有这个对话框，如实拒绝。页面要保存文件都经这里。
   */
  saveFile(target: SaveFileKind | SaveFileDialog, defaultName: string): Promise<string | null>;
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
  /** 外壳布局给自己视觉件的能力（滚回顶部）：全局快捷键的目标就是当前页时也要用它。只由外壳布局调用。 */
  bindChrome(chrome: ChromeApi | null): void;
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
      <UpdaterProvider>
        <ShellCore>{children}</ShellCore>
      </UpdaterProvider>
    </OverlayProvider>
  );
}

type NavIntent = "go" | "back" | "forward";

/**
 * 同一页换标签或分区（replace）时的落点：页面标出的锚点（标签条、分区导航所在的那一行）已经滚出视口上方时，
 * 瞬时滚回锚点，新面板从头看起；锚点还在视口里就不动。不做平滑滚动，变化交给面板自己的入场。
 * 锚点的 scroll-margin-top 是它上方要留出的距离：分区导航吸顶时写成吸顶的 top，滚回去导航停在原处不动。
 * 返回页面标出的锚点；页面没有锚点时为 null。
 */
function revealNavAnchor(scroller: HTMLElement): HTMLElement | null {
  const anchor = scroller.querySelector<HTMLElement>(`[${NAV_ANCHOR_ATTR}]`);
  if (anchor === null) return null;
  assertAnchorInFlow(anchor, scroller);
  const top = anchor.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop - scrollMarginTop(anchor);
  if (top < scroller.scrollTop) scroller.scrollTop = top;
  return anchor;
}

/** 锚点所在的页面：内容区滚动容器里包着锚点的那个直接子元素，也就是页面根。 */
function pageOf(anchor: HTMLElement, scroller: HTMLElement): HTMLElement {
  let el = anchor;
  while (el.parentElement !== scroller) {
    if (el.parentElement === null) throw new Error("导航锚点不在内容区滚动容器里");
    el = el.parentElement;
  }
  return el;
}

/**
 * 吸顶元素吸住时量到的就是吸住的位置，锚点看起来永远在视口里，滚回永远不触发。
 * 标错了当场报错，不让它静默失效：锚点要标在吸顶导航外层、不吸顶的那一行上。
 */
function assertAnchorInFlow(anchor: HTMLElement, scroller: HTMLElement): void {
  for (let el: HTMLElement | null = anchor; el !== null && el !== scroller; el = el.parentElement) {
    if (getComputedStyle(el).position === "sticky") {
      throw new Error(`导航锚点不能是吸顶元素，也不能在吸顶元素里面：${el.tagName.toLowerCase()}.${el.className}`);
    }
  }
}

/**
 * 实例列表是不是已知：读到了，或游戏目录因数据格式打不开（换目录之前列表就是空的，指向实例的页面都已失效）。
 * 加载中与别的读取失败（网络盘暂时连不上等）不算：列表只是没读到，不能据此把人从实例页送走。
 */
function instanceListKnown(status: SliceStatus): boolean {
  return status.kind === "ready" || (status.kind === "error" && gameDirDataRejectionOf(status.error) !== null);
}

function scrollMarginTop(el: HTMLElement): number {
  const raw = getComputedStyle(el).scrollMarginTop;
  // 浏览器总给出像素值；jsdom 对没声明的属性给空串，而这个属性的初始值就是 0
  if (raw === "") return 0;
  const px = Number.parseFloat(raw);
  if (Number.isNaN(px)) throw new Error(`导航锚点的 scroll-margin-top 不是像素值：${raw}`);
  return px;
}

interface ConfirmRequest {
  id: number;
  /** 确认框的 key：框开着时被顶替的请求沿用前一个的，框关上之后再来的请求才换新的。 */
  frame: number;
  options: ConfirmOptions;
  resolve: (ok: boolean) => void;
}

/**
 * 替外壳核心整份订阅更新状态的叶子，什么都不画：下载更新的每条进度事件只让它重渲染，不让外壳核心重渲染。
 * 在布局阶段交接口，并排在外壳内容之前：内容里挂载时就调更新动作的一方（布局与常规副作用都算）读到的已经是它。
 */
function UpdaterBridge({ bind }: { bind: (api: UpdaterApi) => void }) {
  const updater = useUpdater();
  useLayoutEffect(() => bind(updater), [bind, updater]);
  return null;
}

function ShellCore({ children }: { children: ReactNode }) {
  // 外壳根只订阅自己用到的几片：每 100 ms 的下载进度与每批游戏日志都不让它重渲染
  const lastRename = useLauncherSelector((s) => s.lastRename);
  const lastMove = useLauncherSelector((s) => s.lastMove);
  const instancesKnown = useLauncherSelector((s) => instanceListKnown(s.status.instances));
  const ids = useLauncherSelector((s) => s.instances.map((i) => i.id), shallowArrayEqual);
  const crashedId = useLauncherSelector((s) => (s.session !== null && s.session.phase === "crashed" ? s.session.instanceId : null));
  const runningSince = useLauncherSelector((s) => (s.session !== null && s.session.phase === "running" ? s.session.runningSince : null));
  const launchPrompt = useLauncherSelector((s) => s.launchPrompt);
  const firstRun = useLauncherSelector((s) => s.firstRun);
  const pins = useLauncherSelector(pinnedInstances, shallowArrayEqual);
  const pendingTasks = useLauncherSelector((s) => activeTasks(s).length);
  const pendingDownloads = useLauncherSelector(activeDownloads);
  const actions = useLauncherActions();
  const run = useRunner();
  const overlay = useOverlayControls();
  const { scrimOpen } = useOverlayState();

  // ---------------------------------------------------------------- 历史

  const [history, setHistoryState] = useState<NavHistory>(initialHistory);
  const [arrival, setArrival] = useState<NavArrival>("boot");
  const historyRef = useRef(history);
  const intentRef = useRef<NavIntent | null>(null);
  const scrollRef = useRef<HTMLElement | null>(null);
  /** 最近一次换标签、换分区留下的托底的滚动监听；摘掉它不动托底（见 lib/scroll-hold）。 */
  const scrollHoldRef = useRef<(() => void) | null>(null);

  /** 事件处理器里连续导航时读的是 ref 里的最新值，不等重渲染。intent 为 null 的提交（替换、剪除失效项）不动滚动位置。 */
  const commit = useCallback((next: NavHistory, intent: NavIntent | null) => {
    if (next === historyRef.current) return;
    historyRef.current = next;
    if (intent !== null) intentRef.current = intent;
    setHistoryState(next);
    setArrival(intent === null ? "replace" : intent);
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
  const replace = useCallback(
    (route: Route) => {
      const next = navReplace(historyRef.current, route);
      if (next === historyRef.current) return;
      // 在提交之前滚：framer-motion 的布局动画在提交时取快照，吸顶导航里的指示块前后两次测量都落在新的滚动位置上，
      // 不会按滚动差飞一段；同一个事件里滚动与新面板一起画出，旧面板不会在新位置上露一帧
      const scroller = scrollRef.current;
      const anchor = scroller === null ? null : revealNavAnchor(scroller);
      if (scroller !== null && anchor !== null) {
        // 滚回锚点之后、新面板挂上之前，按此刻的滚动位置托住页面的高度：新面板较短时滚动不被夹回，
        // 标签条、吸顶的分区导航不跟着下跳（见 lib/scroll-hold）
        scrollHoldRef.current?.();
        scrollHoldRef.current = holdScroll(pageOf(anchor, scroller), scroller);
      }
      commit(next, null);
    },
    [commit],
  );
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
  const [appliedRename, setAppliedRename] = useState(() => (lastRename === null ? 0 : lastRename.seq));
  const rename = lastRename !== null && lastRename.seq !== appliedRename ? lastRename : null;
  const viewHistory = rename === null ? history : renameInHistory(history, rename.from, rename.to);

  // 移走也不是删除：开着的正是移走的那个实例时去实例库，剪掉它的历史项后落回上一页的话，上一页多半还是它的别的标签，
  // 一样会被剪掉，最后停在哪里说不准。移走与新列表同一次到达，这一帧 effectiveRoute 已按实例库渲染
  const [appliedMove, setAppliedMove] = useState(() => (lastMove === null ? 0 : lastMove.seq));
  const move = lastMove !== null && lastMove.seq !== appliedMove ? lastMove : null;

  const instanceIds = useMemo(() => new Set(ids), [ids]);
  useEffect(() => {
    let next = historyRef.current;
    if (rename !== null) next = renameInHistory(next, rename.from, rename.to);
    const leaveMoved = move !== null && routeInstanceId(currentEntry(next).route) === move.id;
    if (leaveMoved) next = navGo(next, LIBRARY_ROUTE);
    // 实例列表还没读到时不剪：此时列表为空，会把所有实例页都当成失效
    if (instancesKnown) next = pruneHistory(next, (r) => {
      const id = routeInstanceId(r);
      return id === null || instanceIds.has(id);
    });
    commit(next, leaveMoved ? "go" : null);
    if (rename !== null) setAppliedRename(rename.seq);
    if (move !== null) setAppliedMove(move.seq);
  }, [commit, instanceIds, instancesKnown, rename, move]);

  const current = currentEntry(viewHistory);
  const route = effectiveRoute(current.route, (id) => !instancesKnown || instanceIds.has(id));

  // 托底跟着页面走：换了页面（页面按路由键重挂，托着的页面根已经卸掉）就摘掉它的滚动监听
  const pageKey = routeKey(route);
  useEffect(
    () => () => {
      scrollHoldRef.current?.();
      scrollHoldRef.current = null;
    },
    [pageKey],
  );

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
  const crashedHere = crashedId !== null && route.page === "instance" && route.tab === "crash" && route.id === crashedId;
  useEffect(() => {
    if (crashedHere) actions.dismissSession();
  }, [actions, crashedHere]);

  // 人已经在错误通知指向的页面上：要说的页面都说了，错误通知又不自动消失，留着只会挡住页面上的控件
  const toasts = useLauncherSelector((s) => s.toasts);
  useEffect(() => {
    for (const toast of toasts) {
      const action = toast.action;
      if (toast.tone === "error" && action !== undefined && "to" in action && sameRoute(action.to, route)) actions.dismissToast(toast.id);
    }
  }, [actions, route, toasts]);

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
      const frame = pendingRef.current === null ? confirmSeq.current : pendingRef.current.frame;
      const request: ConfirmRequest = { id: confirmSeq.current, frame, options, resolve };
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
  const promptRef = useRef<typeof launchPrompt>(null);
  useEffect(() => {
    if (launchPrompt === null || promptRef.current === launchPrompt) return;
    promptRef.current = launchPrompt;
    const copy = launchPromptCopy(launchPrompt);
    void confirm(copy).then((ok) => {
      // 确认框改过口时旧的这次按取消结算，它的回答不算数，别把新的那次也收走
      if (promptRef.current !== launchPrompt) return;
      return run(() => actions.resolveLaunchPrompt(ok), ACTION_ERROR.launch(launchPrompt.instanceId));
    });
  }, [actions, confirm, launchPrompt, run]);

  // ---------------------------------------------------------------- 命令面板、新建实例

  const [palette, setPalette] = useState<PaletteState>({ open: false, query: "" });
  const openPalette = useCallback((query = "") => setPalette({ open: true, query }), []);
  const closePalette = useCallback(() => setPalette((p) => (p.open ? { ...p, open: false } : p)), []);

  const [createInstance, setCreateInstance] = useState<CreateInstanceState>({ open: false, preset: null });
  const openCreateInstance = useCallback((preset?: CreateInstancePreset) => setCreateInstance({ open: true, preset: preset === undefined ? null : preset }), []);
  const closeCreateInstance = useCallback(() => setCreateInstance((c) => (c.open ? { ...c, open: false } : c)), []);

  // ---------------------------------------------------------------- 启动器更新

  // 外壳核心（连同其中的自动检查）只在回调与事件里调更新动作、经 snapshot() 读此刻的阶段，自己不订阅更新状态：
  // 整份订阅的是下面渲染的 UpdaterBridge 叶子，下载更新的每条进度事件只让它重渲染，它把接口交进这个 ref
  const updaterRef = useRef<UpdaterApi | null>(null);
  const bindUpdater = useCallback((api: UpdaterApi) => {
    updaterRef.current = api;
  }, []);
  const updater = useCallback((): UpdaterApi => {
    const api = updaterRef.current;
    if (api === null) throw new Error("更新接口还没交进外壳核心：UpdaterBridge 没有挂上");
    return api;
  }, []);
  // installUpdate 是引用稳定的回调：活动任务数经 ref 读，不进它的依赖
  const pendingWorkRef = useRef({ tasks: pendingTasks, downloads: pendingDownloads });
  pendingWorkRef.current = { tasks: pendingTasks, downloads: pendingDownloads };
  const [updatePanelOpen, setUpdatePanelOpen] = useState(false);
  const openUpdatePanel = useCallback(() => {
    const api = updater();
    const update = phaseUpdate(api.snapshot().phase);
    if (update === null) throw new Error("没有可查看的更新时不该打开更新面板");
    api.markSeen(update.version);
    setUpdatePanelOpen(true);
  }, [updater]);
  const closeUpdatePanel = useCallback(() => setUpdatePanelOpen(false), []);
  const installUpdate = useCallback(async () => {
    const { tasks, downloads } = pendingWorkRef.current;
    if (tasks > 0) {
      const ok = await confirm({ ...UPDATE_COPY.restartConfirm(tasks, downloads), tone: "danger" });
      if (!ok) return;
    }
    // 任务记录写不进去（数据目录只读、盘满、文件被占用）不该拦住更新：与关窗、启动后自动退出一致，单独报错后照常安装
    await run(() => actions.flushTaskJournal(), ACTION_ERROR.saveJournal);
    await run(() => updater().install(), UPDATE_COPY.installFailed);
  }, [actions, confirm, run, updater]);
  useUpdaterAutoCheck(openUpdatePanel, updater);

  const findHandlers = useRef<(() => void)[]>([]);
  const registerFind = useCallback((handler: () => void) => {
    findHandlers.current.push(handler);
    return () => {
      const i = findHandlers.current.lastIndexOf(handler);
      if (i >= 0) findHandlers.current.splice(i, 1);
    };
  }, []);

  const pageShortcuts = useRef<{ combo: KeyCombo; handler: () => void }[]>([]);
  const registerShortcut = useCallback((combo: KeyCombo, handler: () => void) => {
    assertPageCombo(combo);
    const entry = { combo, handler };
    pageShortcuts.current.push(entry);
    return () => {
      const i = pageShortcuts.current.lastIndexOf(entry);
      if (i >= 0) pageShortcuts.current.splice(i, 1);
    };
  }, []);

  // ---------------------------------------------------------------- 全局快捷键

  const shortcutState = { firstRun, paletteOpen: palette.open, pins };

  // 外壳布局在 ShellProvider 里面，它的滚回顶部只能由它交进来
  const chromeRef = useRef<ChromeApi | null>(null);
  const bindChrome = useCallback((chrome: ChromeApi | null) => {
    chromeRef.current = chrome;
  }, []);

  /**
   * 快捷键要去的就是当前页时滚回顶部，与侧栏、命令面板一致；go 遇到同一路由什么都不做，按下去像没反应。
   * 内容区还没挂上时没有可滚的内容，什么都不做：向导收尾时首次启动标记已经撤掉、快捷键已经生效，
   * 主界面却要等向导的退场播完才挂上，这段时间里按到当前页（初始就是主页）是正常操作，不是装配错误。
   */
  const openFromShortcut = (target: Route) => {
    if (!sameRoute(route, target)) {
      go(target);
      return;
    }
    if (scrollRef.current === null) return;
    const chrome = chromeRef.current;
    if (chrome === null) throw new Error("外壳布局还没挂载，快捷键没法把内容区滚回顶部");
    chrome.scrollContentToTop();
  };

  /** 不是全局快捷键的按键：交给最后登记的、组合相同的页面快捷键；返回是否接手。 */
  const onPageKey = (event: KeyboardEvent): boolean => {
    if (shortcutState.firstRun === true || overlay.isOpen() || shortcutState.paletteOpen) return false;
    const list = pageShortcuts.current;
    for (let i = list.length - 1; i >= 0; i--) {
      const entry = list[i];
      if (!matchesCombo(event, entry.combo)) continue;
      // 不带 Ctrl / Alt 的组合在输入框里属于输入框本身（例如改名框里再按 F2）
      if (entry.combo.ctrl !== true && entry.combo.alt !== true && isTypingTarget(event.target)) return false;
      entry.handler();
      return true;
    }
    return false;
  };

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
        openFromShortcut({ page: shortcut.page });
        return;
      case "pin": {
        const inst = shortcutState.pins[shortcut.index];
        if (inst !== undefined) openFromShortcut({ page: "instance", id: inst.id, tab: "overview" });
        return;
      }
      case "create":
        openCreateInstance();
        return;
      case "settings":
        openFromShortcut({ page: "settings" });
        return;
    }
  }, onPageKey);

  // ---------------------------------------------------------------- 文件与服务器链接：拖放与选择文件

  const port = useWindowPort();
  const fileDrop = useFileDrop(port, {
    blocked: () => shortcutState.firstRun === true || overlay.isOpen() || shortcutState.paletteOpen,
    go,
    rejectNonModpack: () => void actions.toast("warning", DROP_COPY.notModpack.title, DROP_COPY.notModpack.body),
    rejectJars: () => void actions.toast("warning", DROP_COPY.jarElsewhere.title, DROP_COPY.jarElsewhere.body),
    rejectLockedJars: (reason) => void actions.toast("warning", DROP_COPY.modsLocked, reason),
    openAuthServer: (url) => void run(() => actions.openAuthlibServer(url), ACTION_ERROR.authlib),
    reportError: (error) => void run(() => Promise.reject(error), SHELL_ACTION_ERROR.fileDrop),
  });

  const pickFile = useCallback((kind: FileKind) => {
    const copy = FILE_PICK_COPY[kind];
    return pickNativeFile({ title: copy.title, filter: { name: copy.filter, extensions: FILE_KINDS[kind].extensions } });
  }, []);

  const saveFile = useCallback(async (target: SaveFileKind | SaveFileDialog, defaultName: string) => {
    const dialog: SaveFileDialog =
      typeof target === "string" ? { title: FILE_SAVE_COPY[target].title, filter: { name: FILE_SAVE_COPY[target].filter, extensions: SAVE_FILE_KINDS[target].extensions } } : target;
    const path = await saveNativeFile({ ...dialog, defaultPath: defaultName });
    return path === null ? null : withExtension(path, dialog.filter.extensions[0]);
  }, []);

  // ---------------------------------------------------------------- 尺寸分档、可见性与焦点

  const [rootEl, setRootEl] = useState<HTMLElement | null>(null);
  const tier = useTier(rootEl);
  const bindPageScroll = useCallback((el: HTMLElement | null) => {
    scrollRef.current = el;
  }, []);

  const [visible, setVisible] = useState(() => document.visibilityState !== "hidden");
  useEffect(() => {
    const onVisibility = () => setVisible(document.visibilityState !== "hidden");
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, []);

  // 焦点认窗口自己的焦点事件，不认网页的 focus / blur：焦点落到系统对话框这类地方时两者会不一致。
  // 初值先取网页的，再以窗口读回的为准；订阅之后已经收到过焦点事件时，晚回来的初值不再盖掉它
  const [focused, setFocused] = useState(() => document.hasFocus());
  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | null = null;
    let heard = false;
    const report = (error: unknown) => void run(() => Promise.reject(error), SHELL_ACTION_ERROR.windowState);
    port
      .onFocusChanged((now) => {
        heard = true;
        if (!disposed) setFocused(now);
      })
      .then((release) => {
        if (disposed) release();
        else unlisten = release;
      }, report);
    port.isFocused().then((now) => {
      if (!disposed && !heard) setFocused(now);
    }, report);
    return () => {
      disposed = true;
      if (unlisten !== null) unlisten();
    };
  }, [port, run]);

  // visibilityState 要靠宿主在最小化时把 WebView2 设为不可见，再问窗口一路兜底：最小化与还原都会让窗口尺寸变化，
  // 变一次读一次。两路各自独立，任一说不可见就算不可见，先后到达都只翻转一次。
  // 读取是异步命令，在线程池上各跑各的，回来的先后没有保证：只认最后发出的那次，
  // 否则晚到的「已最小化」会盖掉「已还原」，通知暂停和花瓣就停在那里，下次窗口尺寸变化才解开
  const [minimized, setMinimized] = useState(false);
  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | null = null;
    let latestRead = 0;
    const read = () => {
      latestRead += 1;
      const seq = latestRead;
      void run(async () => {
        const now = await port.isMinimized();
        if (!disposed && seq === latestRead) setMinimized(now);
      }, SHELL_ACTION_ERROR.windowState);
    };
    port.onResized(read).then(
      (release) => {
        if (disposed) {
          release();
          return;
        }
        unlisten = release;
        read();
      },
      (error: unknown) => void run(() => Promise.reject(error), SHELL_ACTION_ERROR.windowState),
    );
    return () => {
      disposed = true;
      if (unlisten !== null) unlisten();
    };
  }, [port, run]);
  const shown = visible && !minimized;

  // 窗口不可见期间全部通知暂停计时
  useEffect(() => {
    if (shown) return;
    actions.pauseToasts("hidden");
    return () => actions.resumeToasts("hidden");
  }, [actions, shown]);

  // 运行呼吸窗口：进入运行、或运行中窗口重新获得焦点时开始；失焦或不可见立即结束
  const active = shown && focused;
  useEffect(() => {
    if (runningSince === null || !active) {
      endBreathWindow();
      return;
    }
    startBreathWindow();
    return () => endBreathWindow();
  }, [runningSince, active]);

  const petalsPaused = !shown || !focused || scrimOpen;

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
      loadCatalog: artBlocks,
      listenChanged: (handler) => onArtChanged(() => handler()),
      onError: report,
      onCatalog: settleArtDownload,
      reloadRequests: registerCatalogReload,
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
    () => ({ route, arrival, canBack: canBack(viewHistory), canForward: canForward(viewHistory), go, replace, back, forward }),
    [arrival, back, forward, go, replace, route, viewHistory],
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
      updatePanelOpen,
      openUpdatePanel,
      closeUpdatePanel,
      installUpdate,
      registerFind,
      registerShortcut,
      registerFileDrop: fileDrop.registerFileDrop,
      registerJarDrop: fileDrop.registerJarDrop,
      fileDropHint: fileDrop.hint,
      pickFile,
      saveFile,
      runToastAction,
      copyText,
      petalsPaused,
      bindRoot: setRootEl,
      bindPageScroll,
      bindChrome,
    }),
    [
      bindChrome,
      bindPageScroll,
      closeCreateInstance,
      closePalette,
      closeUpdatePanel,
      confirm,
      copyText,
      createInstance,
      fileDrop.hint,
      fileDrop.registerFileDrop,
      fileDrop.registerJarDrop,
      installUpdate,
      openCreateInstance,
      openPalette,
      openUpdatePanel,
      palette,
      petalsPaused,
      pickFile,
      registerFind,
      registerShortcut,
      runToastAction,
      saveFile,
      tier,
      updatePanelOpen,
    ],
  );

  return (
    <NavContext.Provider value={nav}>
      <ShellContext.Provider value={shell}>
        <LaunchHostProvider host={launchHost}>
          <UpdaterBridge bind={bindUpdater} />
          {children}
          {/* 框开着时被顶替不换 key：换 key 会把开着的框连遮罩一起卸掉重挂，遮罩断一帧。原地换内容，
              按 requestKey 重做初始聚焦；框关上之后再来的请求才换 key */}
          {confirmRequest !== null && (
            <ConfirmDialog
              key={confirmRequest.frame}
              open={confirmOpen}
              {...confirmRequest.options}
              requestKey={confirmRequest.id}
              onConfirm={() => settleConfirm(true)}
              onClose={() => settleConfirm(false)}
            />
          )}
        </LaunchHostProvider>
      </ShellContext.Provider>
    </NavContext.Provider>
  );
}
