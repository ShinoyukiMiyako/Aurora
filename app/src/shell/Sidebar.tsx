// 侧栏：左侧 84px 槽位里浮着的一根竖胶囊。自上而下：四个主导航、分隔线、固定的实例（至多 5 个）、
// 新建实例、留白、设置。槽位本身的空白是窗口拖动区，胶囊不是。
//
// - 选中：整根胶囊只有一块选中滑块（强调浅底 + 左缘指示条），在条目之间沿弹簧滑动；落到固定实例上时浅底淡出、
//   只留指示条（头像自己有选中态）。在没固定的实例里时选中「实例库」；在账户页时没有选中项，滑块原地淡出。
//   滑块的位移走合成线程：换页时主线程正忙着渲染新页面，滑动不受它牵连。指针按下主导航的那一刻滑块就出发，不等松手。
// - 键盘：整根侧栏只有一个 Tab 停靠点（选中项，没有选中项时是「主页」），↑↓ 逐项移动不循环，Home / End 到首尾。
// - 再点一次当前所在的条目：内容区滚回顶部。
// - 固定实例：右键或 Shift+F10 / 菜单键打开操作菜单；按住拖动超过 4px 进入排序，1:1 跟手，其余项让位；
//   松手提交（先乐观改顺序，写入失败由状态层恢复并报错），Esc、指针取消或在侧栏外松手放弃并弹回原位。
//   顺序与成员变化一律按「旧位置 -> 新位置」补间（FLIP），菜单里的上移下移、写入失败的恢复也是同一套。
// - 固定区之外的行（新建按钮）随固定区变高变矮让位，不瞬移。
// - 冷启动：实例与固定列表晚于窗口显示才读到，固定区与新建按钮等这两片数据到了再一起淡入，不先画空的再被顶开。

import { AnimatePresence, animate, motion, useMotionValue, useReducedMotionConfig, type MotionValue } from "framer-motion";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode, type Ref } from "react";
import { Icon, type IconName } from "../art/Icon";
import { ACTION_ERROR, AVATAR_LINE, LAUNCH_COPY, PAGE_LABEL, STOPPED_LABEL } from "../copy/flows";
import type { InstanceSummary } from "../domain/adapt";
import { percent } from "../domain/format";
import { InstanceAvatar } from "../launch/InstanceAvatar";
import { brokenAction, launchView, launchViewEqual, type LaunchView } from "../launch/launchView";
import { useLaunch, type LaunchEntry } from "../launch/useLaunch";
import { TOOLTIP_TIMING, fade, springs } from "../lib/motion";
import { REFLOW_SKIP_ATTR, observeReflow } from "../lib/reflow";
import { Slide } from "../lib/slide";
import { clamp, isImeComposing } from "../lib/util";
import { shallowArrayEqual, useLauncherActions, useLauncherSelector, useNow } from "../state/launcher";
import { sameRoute, type Route } from "../state/route";
import { findInstance, pinnedInstances } from "../state/selectors";
import { showsUpdateDot } from "../state/updater/machine";
import { useUpdater } from "../state/updater/useUpdater";
import { Menu, type MenuEntry, type MenuItem, type MenuOpenedBy } from "../ui/Menu";
import { Tooltip } from "../ui/Tooltip";
import { useChrome } from "./chrome";
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
  /** 刚拖动松手、提交了新顺序的那一项：新顺序落地后它用 pop 飞进空位，其余项照常 settle。 */
  const dropped = useRef<string | null>(null);
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
    const landing = dropped.current;
    dropped.current = null;
    for (const [id, h] of handles.current) {
      const was = snapshot.get(id);
      if (was === undefined) continue;
      h.y.jump(was - h.el.offsetTop);
      settle(h.y, 0, id === landing ? springs.pop : springs.settle);
    }
  }, [orderKey, settle]);

  const register = useCallback((id: string, handle: PinHandle | null) => {
    if (handle === null) handles.current.delete(id);
    else handles.current.set(id, handle);
  }, []);

  // ---- 选中滑块
  const selectionEl = useRef<HTMLDivElement>(null);
  const slide = useRef<Slide | null>(null);
  /** 滑块此刻停在（或正滑向）哪一项；没显示时为 null。 */
  const shown = useRef<SidebarKey | null>(null);
  const selectionRef = useRef(selection);
  selectionRef.current = selection;
  // 选中的固定项被拖动、或在重排补间途中时，滑块跟着它的位移走
  const followY = useMotionValue(0);

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
      const top = topWithin(row, capsule);
      // 从没显示到显示：直接出现在那一行上淡入，不从上一次停的地方飞过来
      if (how === "jump" || shown.current === null || reduced) slide.current.jump(0, top);
      else slide.current.to(0, top);
      el.dataset.kind = isPinKey(key) ? "pin" : "nav";
      el.setAttribute("data-on", "");
      shown.current = key;
    },
    [reduced],
  );

  // 选中项变了：滑过去
  useLayoutEffect(() => {
    placeSelection(selection, "slide");
  }, [placeSelection, selection]);
  // 固定项增删换序、固定区刚挂上：行的位置变了，滑块直接跟到新位置（固定项自己的补间由 followY 带着走）
  useLayoutEffect(() => {
    placeSelection(selectionRef.current, "jump");
  }, [placeSelection, orderKey, pinsReady]);
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
  const [dragging, setDragging] = useState<string | null>(null);
  const suppressClick = useRef(false);
  const pinsRef = useRef(pins);
  pinsRef.current = pins;

  const handleOf = (id: string): PinHandle => {
    const h = handles.current.get(id);
    if (h === undefined) throw new Error(`侧栏固定项 ${id} 没有登记`);
    return h;
  };

  const cancelDrag = useCallback(() => {
    const d = drag.current;
    drag.current = null;
    setDragging(null);
    if (d === null || !d.active) return;
    for (const h of handles.current.values()) settle(h.y, 0, springs.pop);
  }, [settle]);

  // 拖动中 Esc 放弃
  useEffect(() => {
    if (dragging === null) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
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
    if (outside || d.over === d.from) {
      cancelDrag();
      return;
    }
    drag.current = null;
    setDragging(null);
    dropped.current = d.id;
    commitOrder(moveItem(pinsRef.current.map((p) => p.id), d.from, d.over));
  };

  // ---- 右键菜单
  // 每个固定项各有一个菜单槽：菜单开着时右键另一项，旧菜单在自己的槽里播完退场，新菜单另起，
  // 不会因为换了一项就被连根卸掉、一帧消失
  const [menus, setMenus] = useState<readonly MenuState[]>([]);
  const openMenu = (id: string, target: HTMLElement, openedBy: MenuOpenedBy) => {
    const capsule = capsuleRef.current;
    if (capsule === null) throw new Error("侧栏胶囊还没挂载");
    // 菜单贴着胶囊外缘、与该项顶边对齐
    const next: MenuState = { id, anchor: { clientX: capsule.getBoundingClientRect().right, clientY: target.getBoundingClientRect().top }, openedBy, open: true };
    const pinned = pinsRef.current.map((p) => p.id);
    // 关着的槽只留还固定着的项：取消固定的那一项早已退场完，留着只是多一份订阅
    setMenus((list) => [...list.filter((m) => m.id !== id && (m.open || pinned.includes(m.id))).map((m) => (m.open ? { ...m, open: false } : m)), next]);
  };
  const closeMenu = useCallback(() => setMenus((list) => (list.some((m) => m.open) ? list.map((m) => (m.open ? { ...m, open: false } : m)) : list)), []);
  const menuOpen = menus.some((m) => m.open);

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
          <span className={styles.selBlock} />
          <span className={styles.selBar} />
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
        <PinMenuSlot key={m.id} menu={m} pinIds={pinIds} onClose={closeMenu} onReorder={commitOrder} />
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
            {badge === true && (
              <motion.span
                className={styles.dot}
                aria-hidden="true"
                initial={{ opacity: 0, scale: 0 }}
                animate={{ opacity: 1, scale: 1, transition: { ...springs.pop, opacity: fade.in } }}
                exit={{ opacity: 0, scale: 0.6, transition: fade.out }}
              />
            )}
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
  register(id: string, handle: PinHandle | null): void;
  onPointerDown(event: ReactPointerEvent<HTMLButtonElement>, id: string, index: number): void;
  onPointerMove(event: ReactPointerEvent<HTMLButtonElement>): void;
  onPointerUp(event: ReactPointerEvent<HTMLButtonElement>): void;
  onPointerCancel(): void;
  onActivate(target: Route): void;
  onMenu(target: HTMLElement, openedBy: MenuOpenedBy): void;
}

function PinItem({ ref: presenceRef, instance, index, enter, selected = false, tabStop, tooltipsOff, dragging, register, onPointerDown, onPointerMove, onPointerUp, onPointerCancel, onActivate, onMenu }: PinItemProps) {
  const y = useMotionValue(0);
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
  return (
    <motion.li
      ref={ref}
      className={styles.row}
      data-sidebar-row=""
      data-dragging={dragging || undefined}
      style={{ y }}
      initial={enter ? { opacity: 0, scale: 0.6 } : false}
      animate={{ opacity: 1, scale: 1, transition: { ...springs.base, opacity: fade.in } }}
      exit={{ opacity: 0, scale: 0.8, transition: fade.out }}
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
          onPointerDown={(event) => onPointerDown(event, id, index)}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerCancel}
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

/** 一个固定项的菜单槽。实例已被删掉时不画：菜单里的启动入口按 id 取实例，取不到会抛错。 */
function PinMenuSlot({ menu, pinIds, onClose, onReorder }: { menu: MenuState; pinIds: readonly string[]; onClose: () => void; onReorder: (ids: string[]) => void }) {
  const instance = useLauncherSelector((s) => findInstance(s, menu.id));
  if (instance === undefined) return null;
  return <PinMenu menu={menu} instance={instance} pinIds={pinIds} onClose={onClose} onReorder={onReorder} />;
}

function PinMenu({ menu, instance, pinIds, onClose, onReorder }: { menu: MenuState; instance: InstanceSummary; pinIds: readonly string[]; onClose: () => void; onReorder: (ids: string[]) => void }) {
  const entry = useLaunch(instance.id);
  const actions = useLauncherActions();
  const { go } = useNav();
  const run = useRunner();
  const index = pinIds.indexOf(instance.id);
  const items: MenuEntry[] = [
    pinLaunchItem(entry),
    { label: SIDEBAR_COPY.openDetail, icon: "arrow-right", onSelect: () => go({ page: "instance", id: instance.id, tab: "overview" }) },
    { label: SIDEBAR_COPY.openFolder, icon: "folder-open", onSelect: () => void run(() => actions.openFolder("instance", instance.id), ACTION_ERROR.openFolder) },
    { kind: "separator" },
    { label: SIDEBAR_COPY.moveUp, icon: "arrow-up", disabled: index <= 0, onSelect: () => onReorder(moveItem(pinIds, index, index - 1)) },
    { label: SIDEBAR_COPY.moveDown, icon: "arrow-down", disabled: index < 0 || index >= pinIds.length - 1, onSelect: () => onReorder(moveItem(pinIds, index, index + 1)) },
    { label: SIDEBAR_COPY.unpin, icon: "pin-off", onSelect: () => void run(() => actions.togglePin(instance.id), ACTION_ERROR.pin) },
  ];
  return <Menu open={menu.open} anchor={menu.anchor} onClose={onClose} items={items} openedBy={menu.openedBy} placement="right-start" aria-label={SIDEBAR_COPY.menuLabel(instance.name)} />;
}
