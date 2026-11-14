// 侧栏：左侧 84px 槽位里浮着的一根竖胶囊。自上而下：四个主导航、分隔线、固定的实例（至多 5 个）、
// 新建实例、留白、设置。槽位本身的空白是窗口拖动区，胶囊不是。
//
// - 选中：整根胶囊只有一块选中滑块（强调浅底 + 左缘指示条），在条目之间沿弹簧滑动；落到固定实例上时浅底淡出、
//   只留指示条（头像自己有选中态）。在没固定的实例里时选中「实例库」；在账户页时没有选中项，滑块原地淡出。
//   滑块的位移走合成线程：换页时主线程正忙着渲染新页面，滑动不受它牵连。指针按下主导航的那一刻滑块就出发，不等松手。
//   减少动画时不滑：一步到位，在新的一行上淡入。
// - 键盘：整根侧栏只有一个 Tab 停靠点（选中项，没有选中项时是「主页」），↑↓ 逐项移动不循环，Home / End 到首尾。
// - 再点一次当前所在的条目：内容区滚回顶部。
// - 固定实例：右键或 Shift+F10 / 菜单键打开操作菜单；按住拖动超过 4px 进入排序，1:1 跟手，其余项让位；
//   松手提交（先乐观改顺序，写入失败由状态层恢复并报错），Esc、指针取消或在侧栏外松手放弃并弹回原位。
//   顺序与成员变化一律按「旧位置 -> 新位置」补间（FLIP），菜单里的上移下移、写入失败的恢复也是同一套。
// - 固定区之外的行（新建按钮）随固定区变高变矮让位，不瞬移。
// - 冷启动：实例与固定列表晚于窗口显示才读到，固定区与新建按钮等这两片数据到了再一起淡入，不先画空的再被顶开。

import { AnimatePresence, animate, motion, useMotionValue, useReducedMotionConfig, type MotionValue } from "framer-motion";
import { memo, useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode, type Ref } from "react";
import { Icon, type IconName } from "../art/Icon";
import { ACTION_ERROR, AVATAR_LINE, LAUNCH_COPY, PAGE_LABEL, STOPPED_LABEL } from "../copy/flows";
import type { InstanceSummary } from "../domain/adapt";
import { percent } from "../domain/format";
import { InstanceAvatar } from "../launch/InstanceAvatar";
import { brokenAction, launchView, launchViewEqual, type LaunchView } from "../launch/launchView";
import { useLaunch, type LaunchEntry } from "../launch/useLaunch";
import { TOOLTIP_TIMING, fade, insertItemFade, popMark, springs } from "../lib/motion";
import { REFLOW_SKIP_ATTR, observeReflow } from "../lib/reflow";
import { Slide, playTween } from "../lib/slide";
import { useMounted } from "../lib/useMounted";
import { clamp, isImeComposing } from "../lib/util";
import { shallowArrayEqual, useLauncherActions, useLauncherSelector, useNow } from "../state/launcher";
import { sameRoute, type Route } from "../state/route";
import { findInstance, pinnedInstances } from "../state/selectors";
import { showsUpdateDot } from "../state/updater/machine";
import { useUpdater } from "../state/updater/useUpdater";
import { Menu, type MenuEntry, type MenuItem, type MenuOpenedBy } from "../ui/Menu";
import { Tooltip } from "../ui/Tooltip";
import { useChrome } from "./chrome";
import { useOverlayRoot } from "./overlay";
import { SHELL_ACTION_ERROR, SIDEBAR_COPY } from "../copy/shell";
import { PIN_SHORTCUT_COUNT, SHORTCUT_PAGES, type ShortcutPage } from "./keys";
import { useNav, useShell } from "./shell";
import styles from "./Sidebar.module.css";
import { useRunner } from "./useRunner";

// ---------------------------------------------------------------- 纯判定

export type SidebarKey = ShortcutPage | "settings" | `pin:${string}`;

const pinKey = (id: string): SidebarKey => `pin:${id}`;

/** 当前路由在侧栏上的选中项；账户页没有对应条目。 */
export function sidebarSelection(route: Route, pinIds: readonly string[]): SidebarKey | null {
  switch (route.page) {
    case "home":
    case "library":
    case "discover":
    case "tasks":
    case "settings":
      return route.page;
    case "instance":
      return pinIds.includes(route.id) ? pinKey(route.id) : "library";
    case "accounts":
      return null;
  }
}

/** 点固定实例去哪：崩溃了直接进崩溃诊断，其余进概览。 */
export function pinTarget(view: LaunchView, id: string): Route {
  return { page: "instance", id, tab: view.kind === "crashed" ? "crash" : "overview" };
}

/** 固定实例名称提示的第二行（也并入按钮的可访问名称）。 */
export function pinLine(view: LaunchView, inst: InstanceSummary, now: number): string {
  switch (view.kind) {
    case "ready":
      return inst.playError === null ? AVATAR_LINE.ready(inst.lastPlayedAt, now) : AVATAR_LINE.playUnknown;
    case "loading":
      return AVATAR_LINE.loading(view.phase, percent(view.session.progress, true));
    case "running": {
      const since = view.session.runningSince;
      if (since === null) throw new Error("running 会话缺少运行起点");
      return AVATAR_LINE.running(now - since);
    }
    case "stopped":
      return STOPPED_LABEL[view.reason];
    case "failed":
      return AVATAR_LINE.failed;
    case "crashed":
      return AVATAR_LINE.crashed;
    case "installing": {
      const task = view.task;
      if (task === null) return SIDEBAR_COPY.waitingInstall;
      if (task.status === "queued") {
        if (view.queuePosition === null) throw new Error(`排队中的任务 ${task.id} 没有名次`);
        return AVATAR_LINE.queued(view.queuePosition);
      }
      return AVATAR_LINE.installing(percent(task.progress));
    }
    case "broken":
      return AVATAR_LINE.broken;
  }
}

/** 一个固定实例占的纵向距离：按钮 44 + 间距 6（头像 40 居中在按钮里）。样式表里的行距由 sidebar-layout 测试钉在这个数上。 */
export const PIN_STEP = 50;
/** 按下后移动超过这么多才算拖动，免得手抖把点击变成排序。 */
export const DRAG_THRESHOLD = 4;

export function moveItem<T>(list: readonly T[], from: number, to: number): T[] {
  if (from < 0 || from >= list.length || to < 0 || to >= list.length) throw new Error(`移动下标越界：${from} -> ${to}（共 ${list.length} 项）`);
  const next = [...list];
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item);
  return next;
}

/** 拖动偏移 dy 对应的落点下标：越过半格就换位，夹在列表首尾之内。 */
export function dropIndex(from: number, dy: number, count: number): number {
  return clamp(from + Math.round(dy / PIN_STEP), 0, count - 1);
}

/** 拖动中其余项的让位偏移：被拖项越过的那几项朝反方向挪一格。 */
export function dragShift(index: number, from: number, over: number): number {
  if (from < over && index > from && index <= over) return -PIN_STEP;
  if (over < from && index >= over && index < from) return PIN_STEP;
  return 0;
}

/** 条目的键是不是固定实例。 */
const isPinKey = (key: SidebarKey): key is `pin:${string}` => key.startsWith("pin:");

/**
 * 元素自己的透明度过渡是不是还在播。滑块收起后调用，在播就是淡出还没播完。
 * 运行环境没有 Web Animations（组件测试的 jsdom）时没有过渡可播。
 */
function fadingOut(el: HTMLElement): boolean {
  if (typeof el.getAnimations !== "function") return false;
  return el.getAnimations().some((animation) => animation instanceof CSSTransition && animation.transitionProperty === "opacity");
}

/**
 * el 相对 ancestor 的纵向布局位置：沿定位祖先逐级累加 offsetTop，途中的滚动容器扣掉已滚过的距离。
 * 只看布局，不含任何位移（拖动、补间里的 transform 另算），所以不受位移写没写进 DOM 的时机影响。
 */
export function topWithin(el: HTMLElement, ancestor: HTMLElement): number {
  let top = 0;
  for (let node: Element | null = el; node instanceof HTMLElement && node !== ancestor; node = node.offsetParent) {
    top += node.offsetTop;
    const parent = node.offsetParent;
    if (parent instanceof HTMLElement && parent !== ancestor) top -= parent.scrollTop;
  }
  return top;
}

// ---------------------------------------------------------------- 侧栏

const NAV_ICON: Readonly<Record<ShortcutPage, IconName>> = { home: "home", library: "library", discover: "compass", tasks: "download" };

interface PinHandle {
  el: HTMLElement;
  y: MotionValue<number>;
}

interface DragState {
  id: string;
  pointerId: number;
  startY: number;
  from: number;
  over: number;
  active: boolean;
}

interface MenuState {
  id: string;
  anchor: { clientX: number; clientY: number };
  openedBy: MenuOpenedBy;
  open: boolean;
}

export function Sidebar() {
  // 只订阅固定实例这一片：下载进度、游戏日志不让侧栏重渲染（各固定项的启动入口另按自己的视图订阅）
  const pins = useLauncherSelector(pinnedInstances, shallowArrayEqual);
  const actions = useLauncherActions();
  const { route, go } = useNav();
  const { openCreateInstance } = useShell();
  const chrome = useChrome();
  const run = useRunner();
  const reduced = useReducedMotionConfig() === true;
  const navRef = useRef<HTMLElement>(null);
  const capsuleRef = useRef<HTMLDivElement | null>(null);
  // 胶囊的直接子项互相让位：固定区变高变矮时，新建按钮滑到新位置
  const bindCapsule = useCallback((el: HTMLDivElement | null) => {
    capsuleRef.current = el;
    if (el === null) return;
    const stop = observeReflow(el);
    return () => {
      stop();
      capsuleRef.current = null;
    };
  }, []);

  // 冷启动时实例与固定列表晚于窗口显示才读到：两片都离开过加载态之后才画固定区与新建按钮。
  // 之后重读（reload 会把切片打回加载态）不再收起，所以锁存。
  const slicesReady = useLauncherSelector((s) => s.status.instances.kind !== "loading" && s.status.pins.kind !== "loading");
  const [pinsReady, setPinsReady] = useState(slicesReady);
  if (slicesReady && !pinsReady) setPinsReady(true);
  // 挂载时数据还没到：到了以后淡入一次。数据随首帧就在时不播，窗口显示时就是成品
  const [late] = useState(!slicesReady);
  // 固定区画出来之后才加进来的项播入场；随固定区一起出现的那批不播（跟着整段淡入或直接就在）。
  // 不用 AnimatePresence 的 initial={false}：它会把这批项里之后才挂载的 motion 元素的入场也一并封住
  const pinsShown = useRef(false);
  useEffect(() => {
    if (pinsReady) pinsShown.current = true;
  }, [pinsReady]);

  const pinIds = pins.map((p) => p.id);
  const selection = sidebarSelection(route, pinIds);
  const tabStop: SidebarKey = selection === null ? "home" : selection;

  // ---- 位置补间（FLIP）
  const handles = useRef(new Map<string, PinHandle>());
  const orderKey = pinIds.join("\n");
  const lastOrderKey = useRef(orderKey);
  const before = useRef<Map<string, number> | null>(null);
  /**
   * 刚拖动松手、提交了新顺序的那一项：新顺序落地后它用 pop 飞进空位，其余项照常 settle。
   * 每次松手一个新对象：提交落定时按身份认出还是不是自己这一次。
   */
  const dropped = useRef<{ id: string } | null>(null);
  /** 拿起的那一项：拖动中，以及松手之后到新顺序落地（或提交落定）之前。 */
  const [dragging, setDragging] = useState<string | null>(null);
  /** 刚放下的那一项：拿起时的放大按 pop 缩回，与位置飞回同一条弹簧。缩回播完或下一次按下固定项时清掉。 */
  const [landing, setLanding] = useState<string | null>(null);
  // 放下：此前这一项一直保持拿起的样子。新顺序落地时 React 可能把它的节点挪了位置，挪动会掐掉已经起步的
  // CSS 过渡（缩回与阴影淡出就一帧跳完），所以等落地、节点挪完再放下。期间又拿起了别的项时不动那一项
  const putDown = useCallback((id: string) => {
    setDragging((current) => (current === id ? null : current));
    setLanding(id);
  }, []);
  const onLanded = useCallback((id: string) => setLanding((current) => (current === id ? null : current)), []);
  // 顺序或成员一变，在这次提交改动 DOM 之前记下每一项此刻的视觉位置（布局位置 + 当前位移）
  if (orderKey !== lastOrderKey.current) {
    lastOrderKey.current = orderKey;
    const snapshot = new Map<string, number>();
    for (const [id, h] of handles.current) snapshot.set(id, h.el.offsetTop + h.y.get());
    before.current = snapshot;
  }
  const settle = useCallback(
    (y: MotionValue<number>, target: number, spring = springs.settle) => {
      if (reduced) y.jump(target);
      else animate(y, target, spring);
    },
    [reduced],
  );
  useLayoutEffect(() => {
    const snapshot = before.current;
    before.current = null;
    if (snapshot === null) return;
    const drop = dropped.current;
    dropped.current = null;
    for (const [id, h] of handles.current) {
      const was = snapshot.get(id);
      if (was === undefined) continue;
      h.y.jump(was - h.el.offsetTop);
      settle(h.y, 0, drop !== null && id === drop.id ? springs.pop : springs.settle);
    }
    // 上面读布局时节点已经挪好、样式按拿起的样子算过一次：这时放下，过渡从挪好的节点上起步
    if (drop !== null) putDown(drop.id);
  }, [orderKey, putDown, settle]);

  const register = useCallback((id: string, handle: PinHandle | null) => {
    if (handle === null) handles.current.delete(id);
    else handles.current.set(id, handle);
  }, []);

  // ---- 选中滑块
  const selectionEl = useRef<HTMLDivElement>(null);
  const slide = useRef<Slide | null>(null);
  /** 滑块此刻停在（或正滑向）哪一项；没显示时为 null。 */
  const shown = useRef<SidebarKey | null>(null);
  /** 滑块最后摆上的那一项，收起后也记着：淡出没播完就又显出时，据此分辨是不是换了一行。 */
  const lastShown = useRef<SidebarKey | null>(null);
  // 减少动画时换行的淡入挂在浅底与指示条上，不挂在滑块自己身上：滑块的显隐由样式表的透明度过渡管，过渡在层叠里压过动画，
  // 落在同一个属性上会互相顶掉（收起时淡入还没播完，过渡播完后它又冒出来）。分在两层上各管各的，透明度相乘
  const blockEl = useRef<HTMLSpanElement>(null);
  const barEl = useRef<HTMLSpanElement>(null);
  /** 浅底与指示条正在播（或播完了还没清掉）的那次淡入。 */
  const partFades = useRef<Animation[]>([]);
  const selectionRef = useRef(selection);
  selectionRef.current = selection;
  // 选中的固定项被拖动、或在重排补间途中时，滑块跟着它的位移走
  const followY = useMotionValue(0);
  // 侧栏挂上的那一次提交还没过去：这期间摆出来的滑块直接是成品（冷启动时侧栏直接出现，不做入场）
  const mounted = useMounted();

  const placeSelection = useCallback(
    (key: SidebarKey | null, how: "slide" | "jump") => {
      const el = selectionEl.current;
      const capsule = capsuleRef.current;
      const nav = navRef.current;
      if (el === null || capsule === null || nav === null) return;
      const item = key === null ? undefined : [...nav.querySelectorAll<HTMLElement>("[data-sidebar-item]")].find((candidate) => candidate.dataset.sidebarItem === key);
      // 没有选中项（账户页），或选中的固定项还没画出来（冷启动时固定区晚到）：滑块原地淡出，等它挂上再摆
      const row = item === undefined ? null : item.closest<HTMLElement>("[data-sidebar-row]");
      if (key === null || row === null) {
        el.removeAttribute("data-on");
        shown.current = null;
        return;
      }
      if (shown.current === key && how === "slide") return;
      if (slide.current === null) slide.current = new Slide(el, "settle");
      // 从收起到显出：关着过渡先把种类换好，显出来时浅底已经是该有的样子，不先显出再淡掉。
      // 侧栏挂上的那一次提交里连显出也关着过渡。下面读布局时浏览器按此刻的属性算一次样式，
      // 这一次关着过渡就不起过渡；之后再打开过渡、值没再变，也不会补播。
      // 上一次的淡出还没播完（进账户页后马上点回侧栏）时按「仍显示着」处理：不关过渡（关了会掐掉淡出、
      // 一帧跳到全透明再淡入），透明度从此刻的值反向淡回，位置也从停着的那一行沿弹簧滑过去，
      // 而不是半透明地瞬移到新的一行。查询会先把挂起的样式算一遍，所以排在下面改属性之前
      const resuming = shown.current === null && fadingOut(el);
      const appearing = shown.current === null && !resuming;
      // 减少动画时不滑：显示着（或淡出还没播完）的滑块换到另一行，一步到位并在新行上从透明淡入，旧行上的那一块不留退场，
      // 与分段控件的选中块一样。这一次也关着过渡显出：种类直接换好（浅底不在固定项上先显出再淡掉），样式表里还在播的
      // 显隐过渡就此停住，透明度全交给浅底与指示条自己的淡入
      const refade = reduced && !appearing && lastShown.current !== key;
      if (appearing || refade) {
        // 种类可能要换：上一次换行的淡入还没播完就停掉，否则落到固定项上时浅底被它显出来
        for (const animation of partFades.current) animation.cancel();
        partFades.current = [];
        el.setAttribute("data-instant", "");
      }
      el.dataset.kind = isPinKey(key) ? "pin" : "nav";
      if (!mounted.current || refade) el.setAttribute("data-on", "");
      const top = topWithin(row, capsule);
      el.removeAttribute("data-instant");
      // 从没显示到显示：直接出现在那一行上淡入，不从上一次停的地方飞过来
      if (how === "jump" || appearing || reduced) slide.current.jump(0, top);
      else slide.current.to(0, top);
      el.setAttribute("data-on", "");
      if (refade) {
        // 浅底在固定项上本来就是透明的，只淡指示条。运行环境没有 Web Animations（组件测试的 jsdom）时直接出现
        for (const part of isPinKey(key) ? [barEl.current] : [blockEl.current, barEl.current]) {
          if (part !== null && typeof part.animate === "function") partFades.current.push(playTween(part, [{ opacity: 0 }, { opacity: 1 }], fade.in));
        }
      }
      shown.current = key;
      lastShown.current = key;
    },
    [reduced],
  );

  // 选中项变了：滑过去。选中项没变、只是固定项增删换序或固定区刚挂上：行的位置变了，滑块直接跟到新位置
  // （固定项自己的补间由 followY 带着走）。两件事落在同一次提交里时按选中项变了处理：在实例页固定或取消固定当前实例，
  // 选中项在「实例库」与这个固定项之间换，固定顺序也同时变了。这时读到的已是新布局，滑动的终点就是新位置；
  // 分成两个 effect 各管一件的话，排在后面的直接到位会掐掉刚起步的滑动，滑块瞬移到新行
  const placedFor = useRef(selection);
  useLayoutEffect(() => {
    const how = placedFor.current === selection ? "jump" : "slide";
    placedFor.current = selection;
    placeSelection(selection, how);
  }, [placeSelection, selection, orderKey, pinsReady]);
  // 胶囊高度变了（窗口缩放）：设置那一行跟着底边走
  useLayoutEffect(() => {
    const capsule = capsuleRef.current;
    if (capsule === null) return;
    const observer = new ResizeObserver(() => placeSelection(selectionRef.current, "jump"));
    observer.observe(capsule);
    return () => observer.disconnect();
  }, [placeSelection]);
  useEffect(() => {
    const handle = selection !== null && isPinKey(selection) ? handles.current.get(selection.slice("pin:".length)) : undefined;
    if (handle === undefined) {
      followY.set(0);
      return;
    }
    followY.set(handle.y.get());
    return handle.y.on("change", (value) => followY.set(value));
  }, [followY, orderKey, pinsReady, selection]);

  // 指针按下主导航：滑块立刻出发，不等松手后的点击。松开时没有换页（移出去了再松手）就滑回当前选中项
  const previewSelection = useCallback(
    (key: SidebarKey) => {
      placeSelection(key, "slide");
      const settleBack = () => {
        window.removeEventListener("pointerup", settleBack);
        window.removeEventListener("pointercancel", settleBack);
        // 点击事件排在 pointerup 之后：等它处理完、选中项更新过，再看要不要滑回去
        window.setTimeout(() => {
          if (shown.current !== selectionRef.current) placeSelection(selectionRef.current, "slide");
        }, 0);
      };
      window.addEventListener("pointerup", settleBack);
      window.addEventListener("pointercancel", settleBack);
    },
    [placeSelection],
  );

  const commitOrder = useCallback((ids: string[]) => void run(() => actions.setSidebarPins(ids), ACTION_ERROR.pin), [actions, run]);

  // ---- 拖动排序
  const drag = useRef<DragState | null>(null);
  const suppressClick = useRef(false);
  const pinsRef = useRef(pins);
  pinsRef.current = pins;
  const unsavedPins = useLauncherSelector((s) => s.unsavedPins);
  const unsavedRef = useRef(unsavedPins);
  unsavedRef.current = unsavedPins;

  const handleOf = (id: string): PinHandle => {
    const h = handles.current.get(id);
    if (h === undefined) throw new Error(`侧栏固定项 ${id} 没有登记`);
    return h;
  };

  /** 拖动没有换成顺序（放弃，或提交了却没换）：所有项按 pop 弹回原位。 */
  const springBack = useCallback(() => {
    for (const h of handles.current.values()) settle(h.y, 0, springs.pop);
  }, [settle]);

  const cancelDrag = useCallback(() => {
    const d = drag.current;
    drag.current = null;
    if (d === null || !d.active) return;
    putDown(d.id);
    springBack();
  }, [putDown, springBack]);

  // 拖动中 Esc 放弃
  useEffect(() => {
    if (dragging === null) return;
    const onKey = (event: KeyboardEvent) => {
      // 已经松手、只是等新顺序落地：没有可放弃的拖动，Esc 照常交给别处。这期间按下了另一项、还没拖起来，
      // 也还只是一次点击，与平时没在拖时一样放行，不吞 Esc、不屏蔽随后的点击
      if (event.key !== "Escape" || drag.current === null || !drag.current.active) return;
      event.preventDefault();
      event.stopPropagation();
      // 指针还按着：松手后浏览器照样补发一次 click，放弃了的拖动不能变成一次点击
      suppressClick.current = true;
      cancelDrag();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [cancelDrag, dragging]);

  const onPinPointerDown = (event: ReactPointerEvent<HTMLButtonElement>, id: string, index: number) => {
    if (event.button !== 0 || drag.current !== null) return;
    // 新的一次按下：上一次手势没等到补发的 click（松在了别处），留下的屏蔽不能吞掉这一次
    suppressClick.current = false;
    // 按下的缩小走平常的 tap，不沿用刚放下那一项的 pop
    setLanding(null);
    drag.current = { id, pointerId: event.pointerId, startY: event.clientY, from: index, over: index, active: false };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const onPinPointerMove = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const d = drag.current;
    if (d === null || d.pointerId !== event.pointerId) return;
    const dy = event.clientY - d.startY;
    if (!d.active) {
      if (Math.abs(dy) <= DRAG_THRESHOLD) return;
      d.active = true;
      setDragging(d.id);
    }
    const list = pinsRef.current;
    const offset = clamp(dy, -d.from * PIN_STEP, (list.length - 1 - d.from) * PIN_STEP);
    handleOf(d.id).y.jump(offset);
    const over = dropIndex(d.from, offset, list.length);
    if (over === d.over) return;
    d.over = over;
    list.forEach((p, i) => {
      if (p.id !== d.id) settle(handleOf(p.id).y, dragShift(i, d.from, over));
    });
  };

  const onPinPointerUp = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const d = drag.current;
    if (d === null || d.pointerId !== event.pointerId) return;
    if (!d.active) {
      drag.current = null;
      return;
    }
    // 松手后浏览器还会补发一次 click：这次不算点击
    suppressClick.current = true;
    const capsule = capsuleRef.current;
    if (capsule === null) throw new Error("侧栏胶囊还没挂载");
    const r = capsule.getBoundingClientRect();
    const outside = event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom;
    const ids = pinsRef.current.map((p) => p.id);
    const next = moveItem(ids, d.from, d.over);
    // 安装中自动固定的项总排在末尾、写不进固定顺序：只越过了它们时写下去的与现状一样，显示顺序也不会变。
    // 这时不发写入，像放弃一样当场放下，不必拿着等一次什么都不改的写入往返
    const unsaved = unsavedRef.current;
    const saved = (list: readonly string[]) => list.filter((id) => !unsaved.includes(id));
    if (outside || d.over === d.from || shallowArrayEqual(saved(next), saved(ids))) {
      cancelDrag();
      return;
    }
    // 拿起的样子留着，等新顺序落地（FLIP 认领这次松手）再放下，见 putDown
    drag.current = null;
    const mark = { id: d.id };
    dropped.current = mark;
    void run(() => actions.setSidebarPins(next), ACTION_ERROR.pin).then(() => {
      // 新顺序落地时 FLIP 已经认领了这次松手。落定了还没认领，就是这次写入没让显示的顺序变（排在前面的写入
      // 或一次重读已经把顺序改成了这样）：FLIP 不会再来，在这里放下，被拖项与让位的项弹回原位；
      // 记号也在这里清掉，免得之后一次不相干的增删让这一项误用 pop
      if (dropped.current !== mark) return;
      dropped.current = null;
      putDown(mark.id);
      // 这期间又拖起了一项：位移归那次拖动管，它松手或放弃时自会归位
      if (drag.current !== null && drag.current.active) return;
      springBack();
    });
  };

  // ---- 右键菜单
  // 每个固定项各有一个菜单槽：菜单开着时右键另一项，旧菜单在自己的槽里播完退场，新菜单另起，
  // 不会因为换了一项就被连根卸掉、一帧消失。关上的槽播完退场就卸掉，不常驻
  const [menus, setMenus] = useState<readonly MenuState[]>([]);
  const openMenu = (id: string, target: HTMLElement, openedBy: MenuOpenedBy) => {
    const capsule = capsuleRef.current;
    if (capsule === null) throw new Error("侧栏胶囊还没挂载");
    // 菜单贴着胶囊外缘、与该项顶边对齐
    const next: MenuState = { id, anchor: { clientX: capsule.getBoundingClientRect().right, clientY: target.getBoundingClientRect().top }, openedBy, open: true };
    // 关着的槽可能还在播退场（指针右键另一项时，旧菜单已被外部按下先关上了）：留着，等它自己报告播完
    setMenus((list) => [...list.filter((m) => m.id !== id).map((m) => (m.open ? { ...m, open: false } : m)), next]);
  };
  const closeMenu = useCallback(() => setMenus((list) => (list.some((m) => m.open) ? list.map((m) => (m.open ? { ...m, open: false } : m)) : list)), []);
  /** 关上的菜单播完了退场：卸掉它的槽。期间又打开了同一项的不动。 */
  const dropMenu = useCallback((id: string) => setMenus((list) => (list.some((m) => m.id === id && !m.open) ? list.filter((m) => m.id !== id || m.open) : list)), []);
  const menuOpen = menus.some((m) => m.open);

  // ---- 移走的固定项交出焦点
  // 焦点停在一个固定项上时它被移走（取消固定；实例被删，开着它的菜单时菜单关上那一刻也把焦点还给了它）：
  // 退场中的行还在 DOM 里接着焦点，退场播完、行一移除焦点就掉回 body。交给原位置上现在的那一项（原来的下一项），
  // 移走的是末项就交给新的末项，一项不剩交给主页入口。焦点不在移走的那一项上（用户已经把它带去别处）时不动
  const focusOrder = useRef<readonly string[]>([]);
  useLayoutEffect(() => {
    const before = focusOrder.current;
    const after = pinsRef.current.map((p) => p.id);
    focusOrder.current = after;
    const nav = navRef.current;
    const active = document.activeElement;
    if (nav === null || !(active instanceof HTMLElement) || !nav.contains(active)) return;
    const holder = active.closest<HTMLElement>("[data-sidebar-item]");
    const key = holder === null ? undefined : holder.dataset.sidebarItem;
    if (key === undefined || !key.startsWith("pin:")) return;
    const removed = key.slice("pin:".length);
    const at = before.indexOf(removed);
    if (at < 0 || after.includes(removed)) return;
    const target: SidebarKey = after.length === 0 ? "home" : pinKey(after[Math.min(at, after.length - 1)]);
    const el = [...nav.querySelectorAll<HTMLElement>("[data-sidebar-item]")].find((candidate) => candidate.dataset.sidebarItem === target);
    if (el === undefined) throw new Error(`侧栏没有条目 ${target}`);
    el.focus();
  }, [orderKey]);

  // ---- 导航
  const activate = (target: Route) => {
    if (sameRoute(route, target)) chrome.scrollContentToTop();
    else go(target);
  };

  const onNavKeyDown = (event: ReactKeyboardEvent<HTMLElement>) => {
    // 菜单经 portal 渲染在浮层根，React 事件仍会冒泡到这里：只处理侧栏自身里的按键
    const nav = navRef.current;
    if (nav === null || !(event.target instanceof Node) || !nav.contains(event.target)) return;
    if (event.altKey || event.ctrlKey || event.metaKey || isImeComposing(event)) return;
    const items = [...nav.querySelectorAll<HTMLElement>("[data-sidebar-item]")];
    const from = items.findIndex((el) => el === document.activeElement);
    let next: number;
    switch (event.key) {
      case "ArrowDown":
        next = Math.min(items.length - 1, from + 1);
        break;
      case "ArrowUp":
        next = Math.max(0, from - 1);
        break;
      case "Home":
        next = 0;
        break;
      case "End":
        next = items.length - 1;
        break;
      default:
        return;
    }
    event.preventDefault();
    items[next].focus();
  };

  const tooltipsOff = dragging !== null || menuOpen;

  return (
    <nav ref={navRef} aria-label={SIDEBAR_COPY.nav} onKeyDown={onNavKeyDown}>
      <div ref={bindCapsule} className={styles.capsule} data-dragging={dragging !== null || undefined}>
        <motion.div ref={selectionEl} className={styles.selection} style={{ y: followY }} aria-hidden="true" data-sidebar-selection="" {...{ [REFLOW_SKIP_ATTR]: "" }}>
          <span ref={blockEl} className={styles.selBlock} />
          <span ref={barEl} className={styles.selBar} />
        </motion.div>
        {SHORTCUT_PAGES.map((page, i) => (
          <NavItem
            key={page}
            itemKey={page}
            icon={NAV_ICON[page]}
            label={PAGE_LABEL[page]}
            sub={SIDEBAR_COPY.pageShortcut(i + 1)}
            shortcut={`Control+${i + 1}`}
            selected={selection === page}
            tabStop={tabStop === page}
            tooltipsOff={tooltipsOff}
            onActivate={() => activate({ page })}
            onPress={previewSelection}
          />
        ))}
        <div className={styles.separator} role="separator" />
        {pinsReady && (
          <PinList count={pins.length} late={late} onScroll={() => placeSelection(selectionRef.current, "jump")}>
            <AnimatePresence mode="popLayout">
              {pins.map((inst, index) => (
                <PinItem
                  key={inst.id}
                  instance={inst}
                  index={index}
                  enter={pinsShown.current}
                  selected={selection === pinKey(inst.id)}
                  tabStop={tabStop === pinKey(inst.id)}
                  dragging={dragging === inst.id}
                  landing={landing === inst.id}
                  onLanded={onLanded}
                  tooltipsOff={tooltipsOff}
                  register={register}
                  onPointerDown={onPinPointerDown}
                  onPointerMove={onPinPointerMove}
                  onPointerUp={onPinPointerUp}
                  onPointerCancel={cancelDrag}
                  onActivate={(target) => {
                    if (suppressClick.current) {
                      suppressClick.current = false;
                      return;
                    }
                    activate(target);
                  }}
                  onMenu={(target, openedBy) => openMenu(inst.id, target, openedBy)}
                />
              ))}
            </AnimatePresence>
          </PinList>
        )}
        {pinsReady && <CreateItem tabStop={false} tooltipsOff={tooltipsOff} late={late} onActivate={() => openCreateInstance()} />}
        <div className={styles.spacer} />
        <SettingsItem
          selected={selection === "settings"}
          tabStop={tabStop === "settings"}
          tooltipsOff={tooltipsOff}
          onActivate={() => activate({ page: "settings" })}
          onPress={previewSelection}
        />
      </div>
      {menus.map((m) => (
        <PinMenuSlot key={m.id} menu={m} pinIds={pinIds} onClose={closeMenu} onReorder={commitOrder} onGone={dropMenu} />
      ))}
    </nav>
  );
}

// ---------------------------------------------------------------- 条目

interface ItemBaseProps {
  selected?: boolean;
  tabStop: boolean;
  tooltipsOff: boolean;
}

function NavItem({
  itemKey,
  icon,
  label,
  sub,
  shortcut,
  selected = false,
  tabStop,
  tooltipsOff,
  onActivate,
  onPress,
  badge,
  ariaLabel,
}: ItemBaseProps & {
  itemKey: SidebarKey;
  icon: IconName;
  label: string;
  sub: string;
  shortcut: string;
  onActivate: () => void;
  /** 主键按下的那一刻：选中滑块先行出发。 */
  onPress: (key: SidebarKey) => void;
  badge?: boolean;
  ariaLabel?: string;
}) {
  const reduced = useReducedMotionConfig() === true;
  return (
    <div className={styles.row} data-sidebar-row="">
      <Tooltip content={label} sub={sub} side="right" delay={TOOLTIP_TIMING.sidebarDelay} disabled={tooltipsOff}>
        <button
          type="button"
          className={styles.item}
          data-sidebar-item={itemKey}
          data-selected={selected || undefined}
          tabIndex={tabStop ? 0 : -1}
          aria-label={ariaLabel === undefined ? label : ariaLabel}
          aria-current={selected ? "page" : undefined}
          aria-keyshortcuts={shortcut}
          onClick={onActivate}
          onPointerDown={(event) => {
            if (event.button === 0) onPress(itemKey);
          }}
        >
          <Icon name={icon} size={20} />
          <AnimatePresence initial={false}>
            {badge === true && <motion.span className={styles.dot} aria-hidden="true" {...(reduced ? popMark.reduced : popMark.dot)} />}
          </AnimatePresence>
        </button>
      </Tooltip>
    </div>
  );
}

function CreateItem({ tabStop, tooltipsOff, late, onActivate }: ItemBaseProps & { late: boolean; onActivate: () => void }) {
  return (
    <div className={styles.row} data-late={late || undefined}>
      <Tooltip content={SIDEBAR_COPY.create} sub={SIDEBAR_COPY.createShortcut} side="right" delay={TOOLTIP_TIMING.sidebarDelay} disabled={tooltipsOff}>
        <button
          type="button"
          className={styles.create}
          data-sidebar-item="create"
          tabIndex={tabStop ? 0 : -1}
          aria-label={SIDEBAR_COPY.create}
          aria-keyshortcuts="Control+N"
          onClick={onActivate}
        >
          <Icon name="plus" size={20} />
        </button>
      </Tooltip>
    </div>
  );
}

/**
 * 设置上的更新点与设置导航「关于」上的同一条规则：已下载待安装一直亮；只是检查到新版本时，跳过的版本不亮，
 * 打开过更新面板看过的也不再亮。设置还没读出来时不知道跳过了哪个版本，先不亮。
 */
function SettingsItem({ selected = false, tabStop, tooltipsOff, onActivate, onPress }: ItemBaseProps & { onActivate: () => void; onPress: (key: SidebarKey) => void }) {
  const updater = useUpdater();
  const skipped = useLauncherSelector((s) => (s.settings === null ? undefined : s.settings.skippedUpdateVersion));
  const run = useRunner();
  const error = updater.info.status === "error" ? updater.info.error : null;
  useEffect(() => {
    if (error !== null) void run(() => Promise.reject(error), SHELL_ACTION_ERROR.updater);
  }, [error, run]);
  const update = skipped !== undefined && showsUpdateDot(updater.state, skipped);
  return (
    <NavItem
      itemKey="settings"
      icon="settings"
      label={PAGE_LABEL.settings}
      sub={SIDEBAR_COPY.settingsShortcut}
      shortcut="Control+Comma"
      selected={selected}
      tabStop={tabStop}
      tooltipsOff={tooltipsOff}
      onActivate={onActivate}
      onPress={onPress}
      badge={update}
      ariaLabel={update ? SIDEBAR_COPY.settingsWithUpdate : PAGE_LABEL.settings}
    />
  );
}

/** 固定实例的滚动容器：放不下时可滚动，上下边缘淡出。late：数据晚于挂载才到，出现时淡入一次。 */
function PinList({ count, late, onScroll, children }: { count: number; late: boolean; onScroll: () => void; children: ReactNode }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [overflow, setOverflow] = useState(false);
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el === null) return;
    const measure = () => setOverflow(el.scrollHeight > el.clientHeight + 1);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [count]);
  return (
    <motion.div ref={scrollRef} className={styles.pinScroll} data-overflow={overflow || undefined} data-late={late || undefined} layoutScroll onScroll={onScroll}>
      <ul className={styles.pins} aria-label={SIDEBAR_COPY.pins}>
        {children}
      </ul>
    </motion.div>
  );
}

interface PinItemProps extends ItemBaseProps {
  /**
   * AnimatePresence 的 popLayout 经它拿到这一项的元素：退场时量出尺寸、把它抽出布局，其余项才能立刻让位。
   * 不接的话退场项一直占着位，淡出结束那一帧下面各项一起上跳。
   */
  ref?: Ref<HTMLLIElement>;
  instance: InstanceSummary;
  index: number;
  /** 挂载时播入场（新固定的项）；只在挂载那一刻读。 */
  enter: boolean;
  dragging: boolean;
  /** 刚放下：拿起时的放大按 pop 缩回。 */
  landing: boolean;
  /** 放下后的缩回播完了。 */
  onLanded(id: string): void;
  register(id: string, handle: PinHandle | null): void;
  onPointerDown(event: ReactPointerEvent<HTMLButtonElement>, id: string, index: number): void;
  onPointerMove(event: ReactPointerEvent<HTMLButtonElement>): void;
  onPointerUp(event: ReactPointerEvent<HTMLButtonElement>): void;
  onPointerCancel(): void;
  onActivate(target: Route): void;
  onMenu(target: HTMLElement, openedBy: MenuOpenedBy): void;
}

/**
 * 固定项的进出：新固定的从 0.6 沿 base 弹簧弹入，取消固定的淡出并缩到 0.8。
 * 减少动画时换成 insertItemFade 只动透明度：根部 MotionConfig 会把缩放改成一步到位，照用这一份的话
 * 取消固定的那一项会先跳到 0.8 再淡出。
 */
const PIN_PRESENCE = {
  initial: { opacity: 0, scale: 0.6 },
  animate: { opacity: 1, scale: 1, transition: { ...springs.base, opacity: fade.in } },
  exit: { opacity: 0, scale: 0.8, transition: fade.out },
} as const;

function PinItem({ ref: presenceRef, instance, index, enter, selected = false, tabStop, tooltipsOff, dragging, landing, onLanded, register, onPointerDown, onPointerMove, onPointerUp, onPointerCancel, onActivate, onMenu }: PinItemProps) {
  const y = useMotionValue(0);
  const presence = useReducedMotionConfig() === true ? insertItemFade : PIN_PRESENCE;
  // 每个固定项只随自己的启动视图变：别的实例的下载进度、这一局的游戏日志不让它重渲染
  const view = useLauncherSelector((s) => launchView(s, instance), launchViewEqual);
  const id = instance.id;
  const ref = useCallback(
    (el: HTMLLIElement | null) => {
      register(id, el === null ? null : { el, y });
      if (typeof presenceRef === "function") presenceRef(el);
      else if (presenceRef !== undefined && presenceRef !== null) presenceRef.current = el;
    },
    [id, presenceRef, register, y],
  );
  const onKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) {
      event.preventDefault();
      onMenu(event.currentTarget, "keyboard");
    }
  };
  // 缩回播完时指针还按着这个按钮（拖动途中按 Esc 放弃，指针还没松）：放下的记号留到指针松开再摘。
  // 早摘了，样式表里的按下缩小这时补上来，按钮停成一次不会生效的按压（这次松手的点击已被屏蔽）。
  // 指针被按钮捕获着，松开总是报到这里。「还按着」看主键按下的那个指针是否仍被按钮捕获，不看 :active：
  // 键盘按住空格也是 :active，可它松开不经过指针事件，记号会一直摘不掉；那一次按压松开照常触发点击，按下缩小本来就该显出来
  const pressedBy = useRef<number | null>(null);
  const landedWhilePressed = useRef(false);
  const release = () => {
    if (!landedWhilePressed.current) return;
    landedWhilePressed.current = false;
    onLanded(id);
  };
  return (
    <motion.li
      ref={ref}
      className={styles.row}
      data-sidebar-row=""
      data-dragging={dragging || undefined}
      data-landing={landing || undefined}
      style={{ y }}
      initial={enter ? presence.initial : false}
      animate={presence.animate}
      exit={presence.exit}
    >
      <Tooltip content={instance.name} sub={<PinLine view={view} instance={instance} />} side="right" delay={TOOLTIP_TIMING.sidebarDelay} disabled={tooltipsOff}>
        <button
          type="button"
          className={styles.pin}
          data-sidebar-item={pinKey(id)}
          data-selected={selected || undefined}
          tabIndex={tabStop ? 0 : -1}
          aria-label={instance.name}
          aria-current={selected ? "page" : undefined}
          aria-keyshortcuts={index < PIN_SHORTCUT_COUNT ? `Alt+${index + 1}` : undefined}
          onClick={() => onActivate(pinTarget(view, id))}
          onContextMenu={(event) => {
            event.preventDefault();
            onMenu(event.currentTarget, "pointer");
          }}
          onKeyDown={onKeyDown}
          onPointerDown={(event) => {
            if (event.button === 0) pressedBy.current = event.pointerId;
            onPointerDown(event, id, index);
          }}
          onPointerMove={onPointerMove}
          onPointerUp={(event) => {
            release();
            onPointerUp(event);
          }}
          onPointerCancel={() => {
            release();
            onPointerCancel();
          }}
          onLostPointerCapture={release}
          onTransitionEnd={(event) => {
            // 只认按钮自己的缩放：头像里的底色过渡会冒泡上来，抬起阴影叠层的透明度过渡也报在按钮上
            if (!landing || event.target !== event.currentTarget || event.propertyName !== "transform") return;
            const pointer = pressedBy.current;
            if (pointer !== null && event.currentTarget.hasPointerCapture(pointer)) landedWhilePressed.current = true;
            else onLanded(id);
          }}
        >
          {/* 拖动中方块照样浮着：拿起是往上提，摘掉上浮会让它先瞬间落下 2px */}
          <InstanceAvatar instance={instance} size={40} base="neutral" selected={selected} />
        </button>
      </Tooltip>
    </motion.li>
  );
}

/** 名称提示的第二行：运行中的计时要每秒走，只在提示气泡显示时挂计时器。 */
function PinLine({ view, instance }: { view: LaunchView; instance: InstanceSummary }) {
  const now = useNow(1000);
  return <span className={styles.pinLine}>{pinLine(view, instance, now)}</span>;
}

// ---------------------------------------------------------------- 固定实例的操作菜单

/**
 * 菜单第一项：按启动视图给出启动、取消、结束、诊断或修复；安装中给一个禁用项说明原因。
 * 存档备份或恢复进行中，启动与重新启动是带原因的禁用项。
 */
export function pinLaunchItem(entry: Pick<LaunchEntry, "view" | "blocked" | "repairBlocked" | "launch" | "cancel" | "stop" | "openCrash">): MenuItem {
  const launchBlock = entry.blocked === null ? {} : { disabled: true, disabledReason: entry.blocked };
  switch (entry.view.kind) {
    case "ready":
    case "stopped":
      return { label: LAUNCH_COPY.launch, icon: "play", ...launchBlock, onSelect: entry.launch };
    case "failed":
      return { label: LAUNCH_COPY.relaunch, icon: "play", ...launchBlock, onSelect: entry.launch };
    case "loading":
      return { label: LAUNCH_COPY.cancel, icon: "x", onSelect: entry.cancel };
    case "running":
      return { label: LAUNCH_COPY.stopGame, icon: "stop", onSelect: entry.stop };
    case "crashed":
      return { label: LAUNCH_COPY.viewCrash, icon: "bug", onSelect: entry.openCrash };
    case "broken": {
      const action = brokenAction(entry.view);
      const repairBlock = entry.repairBlocked === null ? {} : { disabled: true, disabledReason: entry.repairBlocked };
      return { label: action.label, icon: action.icon, ...repairBlock, onSelect: entry.launch };
    }
    case "installing":
      return {
        label: SIDEBAR_COPY.installing,
        icon: "download",
        disabled: true,
        onSelect: () => {
          throw new Error("安装中的实例没有启动动作");
        },
      };
  }
}

/** 菜单的条目与名称：实例还在时由 PinMenuItems 算好交给槽。 */
interface PinMenuContent {
  items: readonly MenuEntry[];
  label: string;
}

/**
 * 一个固定项的菜单槽。关上之后面板还要播一会儿退场，退场播完、面板从浮层根里拿掉时报告 onGone，由侧栏卸掉这个槽：
 * 关着的菜单不常驻，不再白白挂着启动入口的订阅（spawn_failed 时还会去读实例设置）。
 *
 * 菜单开着时实例被删掉：启动入口按 id 取实例，取不到会抛错，所以算条目的 PinMenuItems 当场卸掉；菜单外框不跟着卸
 * （卸了面板就没机会播退场，一帧消失），用删掉前交上来的最后一份条目以关上的状态播完退场。退场中的面板不接指针，
 * 焦点也已离开它，旧条目点不到。焦点去哪由侧栏按固定项被移走处理。
 */
function PinMenuSlot({
  menu,
  pinIds,
  onClose,
  onReorder,
  onGone,
}: {
  menu: MenuState;
  pinIds: readonly string[];
  onClose: () => void;
  onReorder: (ids: string[]) => void;
  onGone: (id: string) => void;
}) {
  const instance = useLauncherSelector((s) => findInstance(s, menu.id));
  const root = useOverlayRoot();
  const menuId = useId();
  const [content, setContent] = useState<PinMenuContent | null>(null);
  const { open, id } = menu;
  const missing = instance === undefined;
  // 开着菜单的实例被删掉：面板在同一次提交里就按关上播退场，侧栏这边也要记成关上。否则一直当作有菜单开着，名称提示全关着
  useEffect(() => {
    if (missing && open) onClose();
  }, [missing, onClose, open]);
  useEffect(() => {
    if (open) return;
    // 菜单不对外报告退场播完，面板拿掉就是播完了。按 id 找而不是记住元素：同一项关上又打开再关上时，
    // 上一次的面板可能还在退场，两份都拿掉才算完
    const gone = () => document.getElementById(menuId) === null;
    if (root === null || gone()) {
      onGone(id);
      return;
    }
    const observer = new MutationObserver(() => {
      if (!gone()) return;
      observer.disconnect();
      onGone(id);
    });
    observer.observe(root, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [id, menuId, onGone, open, root]);
  // 条目还没交上来（打开后的第一次提交）时不画外框：条目在同一次提交的布局阶段就交上来，绘制前外框已经挂上
  return (
    <>
      {instance !== undefined && <PinMenuItems instance={instance} pinIds={pinIds} onReorder={onReorder} publish={setContent} />}
      {content !== null && (
        <Menu id={menuId} open={open && !missing} anchor={menu.anchor} onClose={onClose} items={content.items} openedBy={menu.openedBy} placement="right-start" aria-label={content.label} />
      )}
    </>
  );
}

/**
 * 按实例的启动视图算出菜单条目，每次重渲染后交给菜单槽。只在实例还在时挂着。
 * 用 memo 包住：槽收到条目后自己重渲染时不连带它重渲染，否则每交一次都会引出下一次。
 */
const PinMenuItems = memo(function PinMenuItems({
  instance,
  pinIds,
  onReorder,
  publish,
}: {
  instance: InstanceSummary;
  pinIds: readonly string[];
  onReorder: (ids: string[]) => void;
  publish: (content: PinMenuContent) => void;
}) {
  const entry = useLaunch(instance.id);
  const actions = useLauncherActions();
  const { go } = useNav();
  const run = useRunner();
  // 安装中自动固定的项排在末尾、写不进固定顺序：上移下移只在已落库的项之间算。它们自己不能移，紧挨在它们前面的那一项
  // 也不能往下移，否则写下去的与现状一样，白发一次写入
  const unsaved = useLauncherSelector((s) => s.unsavedPins);
  const saved = pinIds.filter((id) => !unsaved.includes(id));
  const index = saved.indexOf(instance.id);
  const items: MenuEntry[] = [
    pinLaunchItem(entry),
    { label: SIDEBAR_COPY.openDetail, icon: "arrow-right", onSelect: () => go({ page: "instance", id: instance.id, tab: "overview" }) },
    { label: SIDEBAR_COPY.openFolder, icon: "folder-open", onSelect: () => void run(() => actions.openFolder("instance", instance.id), ACTION_ERROR.openFolder) },
    { kind: "separator" },
    { label: SIDEBAR_COPY.moveUp, icon: "arrow-up", disabled: index <= 0, onSelect: () => onReorder(moveItem(saved, index, index - 1)) },
    { label: SIDEBAR_COPY.moveDown, icon: "arrow-down", disabled: index < 0 || index >= saved.length - 1, onSelect: () => onReorder(moveItem(saved, index, index + 1)) },
    { label: SIDEBAR_COPY.unpin, icon: "pin-off", onSelect: () => void run(() => actions.togglePin(instance.id), ACTION_ERROR.pin) },
  ];
  const label = SIDEBAR_COPY.menuLabel(instance.name);
  useLayoutEffect(() => publish({ items, label }));
  return null;
});
