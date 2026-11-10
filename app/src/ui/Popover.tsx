// 锚定在触发元素旁的非模态面板：下载快览、账户切换、筛选面板，以及下拉列表与菜单的外框。
//
// - portal 到浮层根；按锚点矩形定位，首选方位放不下就翻到对侧，再夹在窗口内 8px。
//   锚点所在的滚动容器滚动、面板或窗口尺寸变化时重新定位；打开后沿用已采用的方位，当前一侧放不下了才翻，
//   面板随内容变矮（下拉里键入筛选词）时不会因为首选一侧又放得下而整块翻回去。
// - 入场从锚点长出：缩放原点落在锚点正对面板的那一点上（右对齐的按钮在面板右上角、右键菜单在指针处），
//   位移起点朝向实际采用的方位，翻到对侧时也是从锚点那边滑出。
// - 关闭途径：Esc（入 Esc 栈，只关栈顶）、指针按在面板与锚点之外（按下即判定，这次按下照常作用在目标上）、
//   Tab 移出面板。按在锚点上不算外部，由锚点自己切换开合；按在面板之后才打开的浮层里（面板里弹出的下拉）也不算。
// - 非模态，不圈定焦点。关闭时焦点仍在面板内（或已丢到 body）才还给打开前的元素；
//   用户已经把焦点带去别处（点了外部、Tab 走了）就留在那里。

import { AnimatePresence, motion, useIsPresent } from "framer-motion";
import { useCallback, useLayoutEffect, useRef, useState, type FocusEvent as ReactFocusEvent, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { fade, springs } from "../lib/motion";
import { cssVars, cx } from "../lib/util";
import { placeFloating, rectInRoot, tabbableElements, useEscapeLayer, useOverlayRoot, type Placement, type Rect, type Side } from "../shell/overlay";
import { FocusReturnPoint, type FocusReturnHandle } from "./focus-return";
import styles from "./Popover.module.css";

/** 锚点：触发元素，或右键菜单的指针位置（视口坐标）。 */
export type PopoverAnchor = Element | { clientX: number; clientY: number };

export interface PopoverProps {
  open: boolean;
  anchor: PopoverAnchor | null;
  /** Esc、点外部、Tab 移出面板时调用；由父组件把 open 置为 false。 */
  onClose: () => void;
  placement?: Placement;
  /** 与锚点的间距（px），默认 8；下拉选择用 6。 */
  offset?: number;
  /** 宽度不小于锚点（下拉选择）。 */
  matchWidth?: boolean;
  /** 打开即把焦点移进面板（面板容器本身）。 */
  autoFocus?: boolean;
  /** 面板的角色：默认 dialog；内容自带 menu / listbox 时传 presentation，由内容承担角色。 */
  role?: "dialog" | "presentation";
  id?: string;
  "aria-label"?: string;
  "aria-labelledby"?: string;
  className?: string;
  children: ReactNode;
}

/** 入场时起点向锚点一侧偏移的距离（px）。 */
const ENTER_SHIFT = 4;

/** 把 placement 的方位换成 side，对齐方式不变。 */
function withSide(placement: Placement, side: Side): Placement {
  const align = placement.split("-")[1];
  return align === "start" || align === "end" ? `${side}-${align}` : side;
}

/** 缩放原点（相对面板左上角）：面板朝向锚点的那条边上，正对锚点中心的一点；锚点超出面板范围时夹到边上。 */
export function originTowardAnchor(anchor: Rect, panel: { left: number; top: number; width: number; height: number }, side: Side): string {
  const x = Math.min(Math.max(anchor.left + anchor.width / 2 - panel.left, 0), panel.width);
  const y = Math.min(Math.max(anchor.top + anchor.height / 2 - panel.top, 0), panel.height);
  switch (side) {
    case "bottom":
      return `${x}px 0px`;
    case "top":
      return `${x}px ${panel.height}px`;
    case "right":
      return `0px ${y}px`;
    case "left":
      return `${panel.width}px ${y}px`;
  }
}

/** 入场起点相对最终位置的偏移：从锚点那一侧滑出。 */
export function enterShift(side: Side, distance: number): { x: number; y: number } {
  return {
    x: side === "right" ? -distance : side === "left" ? distance : 0,
    y: side === "bottom" ? -distance : side === "top" ? distance : 0,
  };
}

function anchorRect(anchor: PopoverAnchor, root: HTMLElement): Rect {
  if (anchor instanceof Element) return rectInRoot(anchor, root);
  const r = root.getBoundingClientRect();
  return { left: anchor.clientX - r.left, top: anchor.clientY - r.top, width: 0, height: 0 };
}

/** 浮层根的直接子元素里包含 node 的那一个（每个浮层都是浮层根的直接子元素）。 */
function layerOf(node: Node, root: HTMLElement): Element | null {
  let current: Node | null = node;
  while (current && current.parentNode !== root) current = current.parentNode;
  return current instanceof Element ? current : null;
}

/** node 落在比 panel 更晚打开的浮层里（面板里弹出的下拉、气泡）：这类交互不算「外部」。 */
function inLaterLayer(node: Node, panel: Element, root: HTMLElement): boolean {
  const layer = layerOf(node, root);
  return layer !== null && layer !== panel && (panel.compareDocumentPosition(layer) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
}

/**
 * 关闭浮层时把焦点按文档顺序移到锚点之后（backwards 时移回锚点）。
 * 浮层 portal 在文档末尾，若交给浏览器默认的 Tab，焦点会跳到文档尽头而不是锚点之后的元素。
 * 锚点在弹窗里时只在该弹窗内找，免得焦点越过弹窗的圈定。
 */
export function moveFocusPastAnchor(anchor: Element, root: HTMLElement, backwards: boolean): void {
  const scope = root.contains(anchor) ? layerOf(anchor, root) : document.body;
  if (!(scope instanceof HTMLElement)) throw new Error("锚点所在的浮层已不在浮层根内");
  const candidates = tabbableElements(scope).filter((el) => scope !== document.body || !root.contains(el));
  if (backwards) {
    if (anchor instanceof HTMLElement && candidates.includes(anchor)) {
      anchor.focus();
      return;
    }
    const before = candidates.filter((el) => (el.compareDocumentPosition(anchor) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0);
    (before[before.length - 1] ?? candidates[candidates.length - 1])?.focus();
    return;
  }
  const after = candidates.find((el) => !anchor.contains(el) && (anchor.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0);
  (after ?? candidates[0])?.focus();
}

export function Popover({ open, anchor, onClose, placement = "bottom-start", offset = 8, matchWidth = false, autoFocus = false, role = "dialog", id, className, children, ...aria }: PopoverProps) {
  const root = useOverlayRoot();
  // 当前（未在退场的）面板；关闭的那一刻它就是正在关闭的面板
  const panelRef = useRef<HTMLDivElement | null>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const generation = useOpenGeneration(open);

  useEscapeLayer(open, onClose, { kind: "popover" });

  const focusReturnRef = useRef<FocusReturnHandle | null>(null);
  // 关闭时焦点仍在面板内（或已丢到 body）才归还；用户已经把焦点带去别处就留在那里
  const focusStillHere = () => {
    const active = document.activeElement;
    return active === null || active === document.body || (panelRef.current !== null && panelRef.current.contains(active));
  };

  // 面板里的监听依赖它，保持引用稳定，免得每次重渲染都重挂监听
  const close = useCallback((returnFocus: boolean) => {
    if (!returnFocus) focusReturnRef.current?.skip();
    onCloseRef.current();
  }, []);

  return (
    <>
      <FocusReturnPoint active={open} shouldReturn={focusStillHere} handle={focusReturnRef} />
      {root &&
        createPortal(
          <AnimatePresence>
            {open && anchor && (
              <PopoverPanel
                key={generation}
                currentPanel={panelRef}
                root={root}
                anchor={anchor}
                placement={placement}
                offset={offset}
                matchWidth={matchWidth}
                autoFocus={autoFocus}
                role={role}
                id={id}
                aria={aria}
                className={className}
                close={close}
              >
                {children}
              </PopoverPanel>
            )}
          </AnimatePresence>,
          root,
        )}
    </>
  );
}

/**
 * 每次打开递增的序号，用作浮层节点的 key。退场动画期间重新打开时，AnimatePresence 遇到同 key 会复用正在退场的节点，
 * 内部状态（高亮项、初始焦点）都停在上一次；换 key 让重新打开的浮层从头挂载，旧的照常播完退场。
 */
export function useOpenGeneration(open: boolean): number {
  const [generation, setGeneration] = useState(0);
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) setGeneration(generation + 1);
  }
  return generation;
}

interface PanelProps {
  currentPanel: { current: HTMLDivElement | null };
  root: HTMLElement;
  anchor: PopoverAnchor;
  placement: Placement;
  offset: number;
  matchWidth: boolean;
  autoFocus: boolean;
  role: "dialog" | "presentation";
  id: string | undefined;
  aria: { "aria-label"?: string; "aria-labelledby"?: string };
  className: string | undefined;
  close: (returnFocus: boolean) => void;
  children: ReactNode;
}

interface Position {
  left: number;
  top: number;
  side: Side;
  anchorWidth: number;
  origin: string;
  /** 第一次定位时采用的方位：入场方向只按它定，之后翻侧也不重播入场。 */
  enter: Side;
}

function PopoverPanel({ currentPanel, root, anchor, placement, offset, matchWidth, autoFocus, role, id, aria, className, close, children }: PanelProps) {
  const present = useIsPresent();
  const panelRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<Position | null>(null);
  // 已采用的方位：之后的重新定位以它为首选
  const adopted = useRef<Side | null>(null);

  useLayoutEffect(() => {
    if (present) currentPanel.current = panelRef.current;
  }, [present, currentPanel]);

  const update = useCallback(() => {
    const el = panelRef.current;
    if (!el) return;
    const a = anchorRect(anchor, root);
    const bounds = root.getBoundingClientRect();
    const width = matchWidth ? Math.max(el.offsetWidth, a.width) : el.offsetWidth;
    const height = el.offsetHeight;
    const request = adopted.current === null ? placement : withSide(placement, adopted.current);
    const placed = placeFloating(a, { width, height }, request, offset, { width: bounds.width, height: bounds.height });
    adopted.current = placed.side;
    const origin = originTowardAnchor(a, { left: placed.left, top: placed.top, width, height }, placed.side);
    setPos((prev) =>
      prev && prev.left === placed.left && prev.top === placed.top && prev.side === placed.side && prev.anchorWidth === a.width && prev.origin === origin
        ? prev
        : { ...placed, anchorWidth: a.width, origin, enter: prev === null ? placed.side : prev.enter },
    );
  }, [anchor, root, placement, offset, matchWidth]);

  useLayoutEffect(() => {
    if (!present) return;
    update();
    const observer = new ResizeObserver(update);
    if (panelRef.current) observer.observe(panelRef.current);
    observer.observe(root);
    window.addEventListener("scroll", update, true);
    return () => {
      observer.disconnect();
      window.removeEventListener("scroll", update, true);
    };
  }, [present, update, root]);

  useLayoutEffect(() => {
    if (!present) return;
    const onPointerDown = (event: PointerEvent) => {
      const panel = panelRef.current;
      const target = event.target;
      if (!panel || !(target instanceof Node)) return;
      if (panel.contains(target) || (anchor instanceof Element && anchor.contains(target)) || inLaterLayer(target, panel, root)) return;
      close(false);
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => document.removeEventListener("pointerdown", onPointerDown, true);
  }, [present, anchor, root, close]);

  useLayoutEffect(() => {
    if (autoFocus) panelRef.current?.focus();
  }, [autoFocus]);

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Tab" || event.defaultPrevented) return;
    const panel = panelRef.current;
    if (!panel) return;
    const items = tabbableElements(panel);
    const active = document.activeElement;
    const leaving = event.shiftKey
      ? items.length === 0 || active === items[0] || active === panel
      : items.length === 0 || active === items[items.length - 1];
    if (!leaving) return;
    event.preventDefault();
    if (anchor instanceof Element) {
      moveFocusPastAnchor(anchor, root, event.shiftKey);
      close(false);
    } else {
      close(true);
    }
  };

  const onBlur = (event: ReactFocusEvent<HTMLDivElement>) => {
    const next = event.relatedTarget;
    const panel = panelRef.current;
    // relatedTarget 为空：窗口失焦或焦点落回 body，不当作「移出面板」
    if (!panel || !(next instanceof Node) || !present) return;
    if (panel.contains(next) || (anchor instanceof Element && anchor.contains(next)) || inLaterLayer(next, panel, root)) return;
    close(false);
  };

  const side = pos ? pos.side : (placement.split("-")[0] as Side);
  // 入场等定位之后才开始：挂载那一帧还不知道会不会翻到对侧，起点按首选方位给的话翻侧时方向是反的。
  // 位移写成从起点到 0 的关键帧，起点按第一次定位的方位算；值不变时重渲染不会重播
  const shift = pos === null ? null : enterShift(pos.enter, ENTER_SHIFT);

  return (
    <motion.div
      ref={panelRef}
      id={id}
      role={role}
      {...aria}
      tabIndex={-1}
      className={cx(styles.panel, className)}
      data-side={side}
      data-match-width={matchWidth || undefined}
      data-exiting={present ? undefined : ""}
      style={{
        ...cssVars({ "--popover-anchor-width": `${pos ? pos.anchorWidth : 0}px` }),
        left: pos ? pos.left : 0,
        top: pos ? pos.top : 0,
        visibility: pos ? "visible" : "hidden",
        transformOrigin: pos ? pos.origin : undefined,
      }}
      initial={{ opacity: 0, scale: 0.97 }}
      animate={shift === null ? undefined : { opacity: 1, scale: 1, x: [shift.x, 0], y: [shift.y, 0], transition: { ...springs.settle, opacity: fade.in } }}
      exit={{ opacity: 0, scale: 0.98, transition: fade.out }}
      onKeyDown={onKeyDown}
      onBlur={onBlur}
    >
      {children}
    </motion.div>
  );
}
