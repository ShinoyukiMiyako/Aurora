// 浮层体系：浮层根、Esc 栈、焦点圈定与归还、锚定定位。
//
// - 所有浮层 portal 到外壳的浮层根（根元素的最后一个子元素），不 portal 到 document.body：
//   坐标统一换算到根元素坐标系，层级只需要在浮层根内排序。浮层根内的层级用 --sk-z-modal / palette /
//   popover / toast / tooltip 令牌，同层后打开者在上（DOM 顺序靠后）。
// - Modal、命令面板、Popover、Menu、Select 下拉在打开时按时间顺序入 Esc 栈。Esc 只交给栈顶一层并阻止继续传播；
//   栈顶不可关闭时也吞掉 Esc。Tooltip、Toast 不入栈，但每次 Esc 都会通知它们（提示气泡要随 Esc 消失）。
// - 回调一律存进 ref，effect 只依赖 active：父组件每次重渲染都会传新的 onEscape / onClose 引用，
//   若放进依赖数组，effect 会反复清理重建，清理时归还焦点、重建时又抢回焦点，输入框每打一个字就丢一次焦点。

import {
  createContext,
  createElement,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
  type RefObject,
} from "react";
import { isImeComposing } from "../lib/util";
import styles from "./overlay.module.css";

export type OverlayKind = "modal" | "palette" | "popover";

interface Layer {
  id: number;
  kind: OverlayKind;
  dismissible: () => boolean;
  onEscape: () => void;
}

export interface OverlaySnapshot {
  /** Esc 栈深度。非 0 即「有浮层打开」，全局快捷键按「有浮层打开时」一列处理。 */
  depth: number;
  /** 是否有带遮罩的浮层（Modal、命令面板）：主页花瓣据此暂停，Toast 的操作按钮据此置灰。 */
  scrimOpen: boolean;
}

/** 焦点归还时，原焦点元素已不在文档中，就落到带这个属性的元素（外壳把它挂在内容区滚动容器上）。 */
export const FOCUS_FALLBACK_ATTR = "data-sk-focus-fallback";

class OverlayRegistry {
  private layers: Layer[] = [];
  private traps: HTMLElement[] = [];
  private escapeListeners = new Set<() => void>();
  private listeners = new Set<() => void>();
  private seq = 0;
  private suspended = 0;
  private snapshot: OverlaySnapshot = { depth: 0, scrimOpen: false };
  root: HTMLElement | null = null;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getSnapshot = (): OverlaySnapshot => this.snapshot;
  getRoot = (): HTMLElement | null => this.root;

  private notify(): void {
    const depth = this.layers.length;
    const scrimOpen = this.layers.some((l) => l.kind !== "popover");
    // useSyncExternalStore 要求快照在没有变化时引用不变
    if (depth !== this.snapshot.depth || scrimOpen !== this.snapshot.scrimOpen) this.snapshot = { depth, scrimOpen };
    for (const listener of [...this.listeners]) listener();
  }

  setRoot(el: HTMLElement | null): void {
    this.root = el;
    this.notify();
  }

  pushLayer(layer: Omit<Layer, "id">): () => void {
    const entry = { ...layer, id: ++this.seq };
    this.layers.push(entry);
    this.notify();
    return () => {
      const i = this.layers.indexOf(entry);
      if (i >= 0) this.layers.splice(i, 1);
      this.notify();
    };
  }

  addEscapeListener(listener: () => void): () => void {
    this.escapeListeners.add(listener);
    return () => {
      this.escapeListeners.delete(listener);
    };
  }

  /** 关闭栈顶一层。栈为空返回 false；栈顶不可关闭时不关，但同样视为已处理（返回 true）。 */
  closeTop(): boolean {
    const top = this.layers[this.layers.length - 1];
    if (!top) return false;
    if (top.dismissible()) top.onEscape();
    return true;
  }

  handleEscape(event: KeyboardEvent): void {
    for (const listener of [...this.escapeListeners]) listener();
    if (this.layers.length === 0) return;
    event.preventDefault();
    event.stopPropagation();
    this.closeTop();
  }

  pushTrap(container: HTMLElement): () => void {
    this.traps.push(container);
    return () => {
      const i = this.traps.lastIndexOf(container);
      if (i >= 0) this.traps.splice(i, 1);
    };
  }

  isTopTrap(container: HTMLElement): boolean {
    return this.suspended === 0 && this.traps[this.traps.length - 1] === container;
  }

  /**
   * 暂停全部焦点圈定执行 fn。浮层卸载时 React 先跑焦点归还的清理、后撤圈定的监听（或顺序反过来），
   * 归还时焦点落到浮层根之外，仍在监听的圈定会把它当成「焦点逃出弹窗」再拉回即将移除的弹窗，焦点就丢到 body。
   */
  withTrapsSuspended(fn: () => void): void {
    this.suspended++;
    try {
      fn();
    } finally {
      this.suspended--;
    }
  }
}

const OverlayContext = createContext<OverlayRegistry | null>(null);

function useRegistry(): OverlayRegistry {
  const registry = useContext(OverlayContext);
  if (!registry) throw new Error("浮层组件必须放在 OverlayProvider 之内");
  return registry;
}

/** 提供 Esc 栈与浮层根。整个应用只挂一个，包住外壳与所有会弹出浮层的组件。 */
export function OverlayProvider({ children }: { children: ReactNode }) {
  const [registry] = useState(() => new OverlayRegistry());
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      // 组字时的 Esc 属于输入法（取消候选），不关浮层
      if (event.key !== "Escape" || isImeComposing(event)) return;
      registry.handleEscape(event);
    };
    // 捕获阶段：先于任何组件自己的 keydown 处理器拿到 Esc，保证「只关栈顶一层」
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [registry]);
  return createElement(OverlayContext.Provider, { value: registry }, children);
}

/** 浮层根元素。外壳把它放在应用根元素的最后一个子位置；它铺满根元素、自身不接收指针，直接子元素恢复接收。 */
export function OverlayRoot({ className }: { className?: string }) {
  const registry = useRegistry();
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    registry.setRoot(ref.current);
    return () => registry.setRoot(null);
  }, [registry]);
  return createElement("div", { ref, className: className ? `${styles.root} ${className}` : styles.root, "data-sk-overlay-root": "" });
}

/** 浮层 portal 的目标；浮层根尚未挂载时为 null（此时不渲染浮层）。 */
export function useOverlayRoot(): HTMLElement | null {
  const registry = useRegistry();
  return useSyncExternalStore(registry.subscribe, registry.getRoot, registry.getRoot);
}

export function useOverlayState(): OverlaySnapshot {
  const registry = useRegistry();
  return useSyncExternalStore(registry.subscribe, registry.getSnapshot, registry.getSnapshot);
}

export interface OverlayControls {
  /** 事件处理时读取：当前是否有浮层打开。 */
  isOpen(): boolean;
  /** 关闭栈顶一层（Alt+← 与鼠标后退键在有浮层时等同 Esc）。 */
  closeTop(): boolean;
}

export function useOverlayControls(): OverlayControls {
  const registry = useRegistry();
  return { isOpen: () => registry.getSnapshot().depth > 0, closeTop: () => registry.closeTop() };
}

export interface EscapeLayerOptions {
  kind: OverlayKind;
  /** false：Esc 被吞掉但不关闭（误关会丢失不可恢复进度的流程）。默认 true。 */
  dismissible?: boolean;
}

/** active 期间登记一层；Esc 落在栈顶时调用 onEscape。 */
export function useEscapeLayer(active: boolean, onEscape: () => void, options: EscapeLayerOptions): void {
  const registry = useRegistry();
  const onEscapeRef = useRef(onEscape);
  onEscapeRef.current = onEscape;
  const dismissibleRef = useRef(options.dismissible !== false);
  dismissibleRef.current = options.dismissible !== false;
  const kind = options.kind;
  useEffect(() => {
    if (!active) return;
    return registry.pushLayer({ kind, dismissible: () => dismissibleRef.current, onEscape: () => onEscapeRef.current() });
  }, [active, kind, registry]);
}

/** 不入栈的 Esc 订阅（提示气泡）：每次 Esc 都会收到，不影响栈顶浮层的处理。 */
export function useEscapeListener(active: boolean, listener: () => void): void {
  const registry = useRegistry();
  const listenerRef = useRef(listener);
  listenerRef.current = listener;
  useEffect(() => {
    if (!active) return;
    return registry.addEscapeListener(() => listenerRef.current());
  }, [active, registry]);
}

const TABBABLE =
  'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"]), [contenteditable="true"]';

/** 容器内按文档顺序可用 Tab 到达的元素。 */
export function tabbableElements(container: HTMLElement): HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>(TABBABLE)].filter(
    // checkVisibility 排除 display:none / visibility:hidden 子树里的元素；不支持该方法的环境按可见处理
    // tabIndex < 0：带 tabindex="-1" 的按钮、链接也会命中上面的元素选择器，但 Tab 到不了
    (el) => el.tabIndex >= 0 && !el.closest("[inert]") && (typeof el.checkVisibility !== "function" || el.checkVisibility({ visibilityProperty: true })),
  );
}

/**
 * 焦点圈定：active 期间 Tab / Shift+Tab 在容器内首尾循环；焦点落到浮层根之外（背后的页面）时拉回容器。
 * 焦点进入浮层根里的其他浮层（Modal 里弹出的下拉、Toast）不拉回——它们本来就在弹窗之上。
 * 叠放时只有最上面的圈定生效。
 */
export function useFocusTrap(containerRef: RefObject<HTMLElement | null>, active: boolean): void {
  const registry = useRegistry();
  // layout effect：圈定随 DOM 同一次提交挂上、撤掉，弹窗节点移除之后不会还有监听把焦点往回拉
  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!active || !container) return;
    const release = registry.pushTrap(container);
    const outsideOverlay = (node: Node | null) => {
      const root = registry.root;
      return !node || !(root ? root.contains(node) : container.contains(node));
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Tab" || !registry.isTopTrap(container)) return;
      const current = document.activeElement;
      const inside = current !== null && container.contains(current);
      if (!inside && !outsideOverlay(current)) return;
      const items = tabbableElements(container);
      if (items.length === 0) {
        event.preventDefault();
        container.focus();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      if (event.shiftKey && (!inside || current === first || current === container)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (!inside || current === last)) {
        event.preventDefault();
        first.focus();
      }
    };
    const onFocusIn = (event: FocusEvent) => {
      if (!registry.isTopTrap(container) || !outsideOverlay(event.target as Node)) return;
      const items = tabbableElements(container);
      (items[0] ?? container).focus();
    };
    document.addEventListener("keydown", onKeyDown, true);
    document.addEventListener("focusin", onFocusIn);
    return () => {
      document.removeEventListener("keydown", onKeyDown, true);
      document.removeEventListener("focusin", onFocusIn);
      release();
    };
  }, [active, containerRef, registry]);
}

// ---------------------------------------------------------------- 锚定定位

export interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export type Side = "top" | "bottom" | "left" | "right";
export type Align = "start" | "center" | "end";
export type Placement = Side | `${Side}-${"start" | "end"}`;

/** 浮层与窗口边缘的最小距离。 */
export const FLOATING_MARGIN = 8;

/** 元素相对浮层根的布局矩形。 */
export function rectInRoot(el: Element, root: Element): Rect {
  const r = el.getBoundingClientRect();
  const rr = root.getBoundingClientRect();
  return { left: r.left - rr.left, top: r.top - rr.top, width: r.width, height: r.height };
}

const OPPOSITE: Record<Side, Side> = { top: "bottom", bottom: "top", left: "right", right: "left" };

function parsePlacement(placement: Placement): { side: Side; align: Align } {
  const [side, align] = placement.split("-") as [Side, "start" | "end" | undefined];
  return { side, align: align === undefined ? "center" : align };
}

function fits(side: Side, anchor: Rect, size: { width: number; height: number }, offset: number, bounds: { width: number; height: number }): boolean {
  switch (side) {
    case "top":
      return anchor.top - offset - size.height >= FLOATING_MARGIN;
    case "bottom":
      return anchor.top + anchor.height + offset + size.height <= bounds.height - FLOATING_MARGIN;
    case "left":
      return anchor.left - offset - size.width >= FLOATING_MARGIN;
    case "right":
      return anchor.left + anchor.width + offset + size.width <= bounds.width - FLOATING_MARGIN;
  }
}

/**
 * 计算浮层位置：首选方位放不下而对侧放得下时翻到对侧；最后把整个浮层夹在窗口内 8px。
 * 返回实际采用的方位，供动画决定从哪一侧进入。
 */
export function placeFloating(
  anchor: Rect,
  size: { width: number; height: number },
  placement: Placement,
  offset: number,
  bounds: { width: number; height: number },
): { left: number; top: number; side: Side } {
  const { side: preferred, align } = parsePlacement(placement);
  const side = !fits(preferred, anchor, size, offset, bounds) && fits(OPPOSITE[preferred], anchor, size, offset, bounds) ? OPPOSITE[preferred] : preferred;
  let left: number;
  let top: number;
  if (side === "top" || side === "bottom") {
    top = side === "bottom" ? anchor.top + anchor.height + offset : anchor.top - offset - size.height;
    left = align === "start" ? anchor.left : align === "end" ? anchor.left + anchor.width - size.width : anchor.left + (anchor.width - size.width) / 2;
  } else {
    left = side === "right" ? anchor.left + anchor.width + offset : anchor.left - offset - size.width;
    top = align === "start" ? anchor.top : align === "end" ? anchor.top + anchor.height - size.height : anchor.top + (anchor.height - size.height) / 2;
  }
  const maxLeft = Math.max(FLOATING_MARGIN, bounds.width - size.width - FLOATING_MARGIN);
  const maxTop = Math.max(FLOATING_MARGIN, bounds.height - size.height - FLOATING_MARGIN);
  return { left: Math.min(Math.max(FLOATING_MARGIN, left), maxLeft), top: Math.min(Math.max(FLOATING_MARGIN, top), maxTop), side };
}
