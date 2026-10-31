// 侧栏：左侧 84px 槽位里浮着的一根竖胶囊。自上而下：四个主导航、分隔线、固定的实例（至多 5 个）、
// 新建实例、留白、设置。槽位本身的空白是窗口拖动区，胶囊不是。
//
// - 选中：主导航条目铺强调浅底 + 图标强调色 + 左缘指示条；固定实例只有指示条（头像自己有选中态）。
//   在没固定的实例里时选中「实例库」；在账户页时没有选中项。指示条用共享布局动画在条目之间滑动。
// - 键盘：整根侧栏只有一个 Tab 停靠点（选中项，没有选中项时是「主页」），↑↓ 逐项移动不循环，Home / End 到首尾。
// - 再点一次当前所在的条目：内容区滚回顶部。
// - 固定实例：右键或 Shift+F10 / 菜单键打开操作菜单；按住拖动超过 4px 进入排序，1:1 跟手，其余项让位；
//   松手提交（先乐观改顺序，写入失败由状态层恢复并报错），Esc、指针取消或在侧栏外松手放弃并弹回原位。
//   顺序与成员变化一律按「旧位置 -> 新位置」补间（FLIP），菜单里的上移下移、写入失败的恢复也是同一套。

import { AnimatePresence, animate, motion, useMotionValue, useReducedMotionConfig, type MotionValue } from "framer-motion";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { Icon, type IconName } from "../art/Icon";
import { ACTION_ERROR, AVATAR_LINE, LAUNCH_COPY, PAGE_LABEL, STOPPED_LABEL } from "../copy/flows";
import type { InstanceSummary } from "../domain/adapt";
import { percent } from "../domain/format";
import { InstanceAvatar } from "../launch/InstanceAvatar";
import { launchView, type LaunchView } from "../launch/launchView";
import { useLaunch, type LaunchEntry } from "../launch/useLaunch";
import { TOOLTIP_TIMING, fade, springs } from "../lib/motion";
import { clamp, isImeComposing } from "../lib/util";
import { useLauncher, useNow } from "../state/launcher";
import { useUpdaterInfo } from "../state/queries/catalog";
import { sameRoute, type Route } from "../state/route";
import { findInstance, pinnedInstances } from "../state/selectors";
import type { LauncherState } from "../state/store";
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
      return AVATAR_LINE.ready(inst.lastPlayedAt, now);
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

/** 一个固定实例占的纵向距离：头像 40 + 间距 6。 */
export const PIN_STEP = 46;
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
  const { state, actions } = useLauncher();
  const { route, go } = useNav();
  const { openCreateInstance } = useShell();
  const chrome = useChrome();
  const run = useRunner();
  const reduced = useReducedMotionConfig() === true;
  const navRef = useRef<HTMLElement>(null);
  const capsuleRef = useRef<HTMLDivElement>(null);

  const pins = pinnedInstances(state);
  const pinIds = pins.map((p) => p.id);
  const selection = sidebarSelection(route, pinIds);
  const tabStop: SidebarKey = selection === null ? "home" : selection;

  // ---- 位置补间（FLIP）
  const handles = useRef(new Map<string, PinHandle>());
  const orderKey = pinIds.join("\n");
  const lastOrderKey = useRef(orderKey);
  const before = useRef<Map<string, number> | null>(null);
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
    for (const [id, h] of handles.current) {
      const was = snapshot.get(id);
      if (was === undefined) continue;
      h.y.jump(was - h.el.offsetTop);
      settle(h.y, 0);
    }
  }, [orderKey, settle]);

  const register = useCallback((id: string, handle: PinHandle | null) => {
    if (handle === null) handles.current.delete(id);
    else handles.current.set(id, handle);
  }, []);

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
      cancelDrag();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [cancelDrag, dragging]);

  const onPinPointerDown = (event: ReactPointerEvent<HTMLButtonElement>, id: string, index: number) => {
    if (event.button !== 0 || drag.current !== null) return;
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
    commitOrder(moveItem(pinsRef.current.map((p) => p.id), d.from, d.over));
  };

  // ---- 右键菜单
  const [menu, setMenu] = useState<MenuState | null>(null);
  const openMenu = (id: string, target: HTMLElement, openedBy: MenuOpenedBy) => {
    const capsule = capsuleRef.current;
    if (capsule === null) throw new Error("侧栏胶囊还没挂载");
    // 菜单贴着胶囊外缘、与该项顶边对齐
    setMenu({ id, anchor: { clientX: capsule.getBoundingClientRect().right, clientY: target.getBoundingClientRect().top }, openedBy, open: true });
  };
  const closeMenu = useCallback(() => setMenu((m) => (m === null || !m.open ? m : { ...m, open: false })), []);
  const menuOpen = menu !== null && menu.open;
  const menuInstance = menu === null ? undefined : findInstance(state, menu.id);

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
      <div ref={capsuleRef} className={styles.capsule} data-dragging={dragging !== null || undefined}>
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
          />
        ))}
        {pins.length > 0 && <div className={styles.separator} role="separator" />}
        <PinList count={pins.length}>
          <AnimatePresence mode="popLayout" initial={false}>
            {pins.map((inst, index) => (
              <PinItem
                key={inst.id}
                instance={inst}
                index={index}
                state={state}
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
        <CreateItem tabStop={false} tooltipsOff={tooltipsOff} onActivate={() => openCreateInstance()} />
        <div className={styles.spacer} />
        <SettingsItem selected={selection === "settings"} tabStop={tabStop === "settings"} tooltipsOff={tooltipsOff} onActivate={() => activate({ page: "settings" })} />
      </div>
      {menu !== null && menuInstance !== undefined && (
        <PinMenu key={menu.id} menu={menu} instance={menuInstance} pinIds={pinIds} onClose={closeMenu} onReorder={commitOrder} />
      )}
    </nav>
  );
}

// ---------------------------------------------------------------- 条目

interface ItemBaseProps {
  selected?: boolean;
  tabStop: boolean;
  tooltipsOff: boolean;
}

function Indicator() {
  return <motion.span layoutId="sidebar-indicator" className={styles.indicator} transition={springs.settle} aria-hidden="true" />;
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
  badge,
  ariaLabel,
}: ItemBaseProps & { itemKey: SidebarKey; icon: IconName; label: string; sub: string; shortcut: string; onActivate: () => void; badge?: boolean; ariaLabel?: string }) {
  return (
    <div className={styles.row}>
      {selected && <Indicator />}
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
        >
          <Icon name={icon} size={20} />
          {badge === true && <span className={styles.dot} aria-hidden="true" />}
        </button>
      </Tooltip>
    </div>
  );
}

function CreateItem({ tabStop, tooltipsOff, onActivate }: ItemBaseProps & { onActivate: () => void }) {
  return (
    <div className={styles.row}>
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

/** 有可安装的更新（检查到新版本，或已下载待安装）时设置上挂一个强调点。 */
export function hasUpdate(info: { supported: boolean; available: unknown; downloaded_version: string | null }): boolean {
  return info.supported && (info.available !== null || info.downloaded_version !== null);
}

function SettingsItem({ selected = false, tabStop, tooltipsOff, onActivate }: ItemBaseProps & { onActivate: () => void }) {
  const updater = useUpdaterInfo();
  const run = useRunner();
  const error = updater.status === "error" ? updater.error : null;
  useEffect(() => {
    if (error !== null) void run(() => Promise.reject(error), SHELL_ACTION_ERROR.updater);
  }, [error, run]);
  const update = updater.data !== undefined && hasUpdate(updater.data);
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
      badge={update}
      ariaLabel={update ? SIDEBAR_COPY.settingsWithUpdate : PAGE_LABEL.settings}
    />
  );
}

/** 固定实例的滚动容器：放不下时可滚动，上下边缘淡出。 */
function PinList({ count, children }: { count: number; children: ReactNode }) {
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
    <motion.div ref={scrollRef} className={styles.pinScroll} data-overflow={overflow || undefined} layoutScroll>
      <ul className={styles.pins} aria-label={SIDEBAR_COPY.pins}>
        {children}
      </ul>
    </motion.div>
  );
}

interface PinItemProps extends ItemBaseProps {
  instance: InstanceSummary;
  index: number;
  state: LauncherState;
  dragging: boolean;
  register(id: string, handle: PinHandle | null): void;
  onPointerDown(event: ReactPointerEvent<HTMLButtonElement>, id: string, index: number): void;
  onPointerMove(event: ReactPointerEvent<HTMLButtonElement>): void;
  onPointerUp(event: ReactPointerEvent<HTMLButtonElement>): void;
  onPointerCancel(): void;
  onActivate(target: Route): void;
  onMenu(target: HTMLElement, openedBy: MenuOpenedBy): void;
}

function PinItem({ instance, index, state, selected = false, tabStop, tooltipsOff, dragging, register, onPointerDown, onPointerMove, onPointerUp, onPointerCancel, onActivate, onMenu }: PinItemProps) {
  const y = useMotionValue(0);
  const view = launchView(state, instance);
  const id = instance.id;
  const ref = useCallback(
    (el: HTMLLIElement | null) => {
      register(id, el === null ? null : { el, y });
    },
    [id, register, y],
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
      data-dragging={dragging || undefined}
      style={{ y }}
      initial={{ opacity: 0, scale: 0.8 }}
      animate={{ opacity: 1, scale: 1, transition: { ...springs.pop, opacity: fade.in } }}
      exit={{ opacity: 0, scale: 0.8, transition: fade.out }}
    >
      {selected && <Indicator />}
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
          <InstanceAvatar instance={instance} size={40} base="neutral" selected={selected} lift={!dragging} />
        </button>
      </Tooltip>
    </motion.li>
  );
}

/** 名称提示的第二行：运行中的计时要每秒走，只在提示气泡显示时挂计时器。 */
function PinLine({ view, instance }: { view: LaunchView; instance: InstanceSummary }) {
  const now = useNow(1000);
  return <>{pinLine(view, instance, now)}</>;
}

// ---------------------------------------------------------------- 固定实例的操作菜单

/** 菜单第一项：按启动视图给出启动、取消、结束、诊断或修复；安装中给一个禁用项说明原因。 */
export function pinLaunchItem(entry: Pick<LaunchEntry, "view" | "launch" | "cancel" | "stop" | "openCrash">): MenuItem {
  switch (entry.view.kind) {
    case "ready":
    case "stopped":
      return { label: LAUNCH_COPY.launch, icon: "play", onSelect: entry.launch };
    case "failed":
      return { label: LAUNCH_COPY.relaunch, icon: "play", onSelect: entry.launch };
    case "loading":
      return { label: LAUNCH_COPY.cancel, icon: "x", onSelect: entry.cancel };
    case "running":
      return { label: LAUNCH_COPY.stopGame, icon: "stop", onSelect: entry.stop };
    case "crashed":
      return { label: LAUNCH_COPY.viewCrash, icon: "bug", onSelect: entry.openCrash };
    case "broken":
      return { label: LAUNCH_COPY.repairAndLaunch, icon: "wrench", onSelect: entry.launch };
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

function PinMenu({ menu, instance, pinIds, onClose, onReorder }: { menu: MenuState; instance: InstanceSummary; pinIds: readonly string[]; onClose: () => void; onReorder: (ids: string[]) => void }) {
  const entry = useLaunch(instance.id);
  const { actions } = useLauncher();
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
