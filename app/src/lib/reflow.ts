// 让位：容器里某个子项的尺寸变了，或子项有增删、换序，其余子项不再一帧跳到新位置，而是从旧位置滑过去。
//
// 为什么不用 framer-motion 的 layout：它只在带 layout 的组件自己重渲染时取「之前」的快照。异步数据在某张卡片内部到达时，
// 被挤开的是它的兄弟，兄弟并没有重渲染，拿不到快照，也就不会动。这里改成观察 DOM 本身：ResizeObserver 报尺寸变化，
// MutationObserver 报增删与换序，与 React 的渲染边界无关，也不要求每个子项都是 motion 元素。
// 退场的子项（AnimatePresence 的 popLayout）是先被抽出布局、淡完才从 DOM 里拿掉的：抽出的那一帧节点没有增删，
// 容器定宽时尺寸也不变，两种观察都不会报。所以另外盯着 framer 给退场项打的标记，兄弟在它让出位置的同一帧起步。
//
// 做法（FLIP）：布局照常一步到位；每个子项记着上一次相对容器的位置，位置变了就补一段从旧位置衰减到 0 的位移。
// - 位移走独立的 translate 属性：页面入场用的是 transform，两者叠加，互不覆盖。
// - 位移交给 Web Animations，关键帧由 settle 弹簧的解析解采样而来：整段在合成线程上播，数据到达时主线程正忙着渲染也不掉帧。
// - 途中又被挤一次：按解析解算出此刻的位置与速度，带着速度接着走，不从零速重新起步。
// - 测量只发生在观察者报了变化的那一帧，先读完再写，不来回触发布局。
//
// 不补位移的情况：容器宽度或窗口尺寸变了（窗口缩放、分档切换引起的重排不做动画）、子项超过 REFLOW_MAX_ITEMS、减少动画。
// 滚动锚定：内容在视口上方变高时浏览器会同步调整滚动位置，可见内容本来就没动，这时也不补。

import { useCallback, type RefCallback } from "react";
import { springAt, type SpringName } from "./motion";
import { elapsedSeconds, springTrack } from "./slide";

/** 一次变化涉及的子项超过这么多就不做：逐项测量与起动画的开销不值，也看不清谁在动。 */
export const REFLOW_MAX_ITEMS = 40;
/** 子项带这个属性时不参与让位（自己管位移的元素，例如拖动排序中的项）。 */
export const REFLOW_SKIP_ATTR = "data-reflow-skip";

/** framer-motion 的 popLayout 把退场项抽出布局时打在它身上的标记。 */
const POPPED_ATTR = "data-motion-pop-id";

/** 位置差不到这么多像素不算移动：亚像素取整的抖动不该起动画。 */
const MOVE_EPSILON_PX = 1;

interface Spot {
  left: number;
  top: number;
}

interface Flight {
  animation: Animation;
  spring: SpringName;
  x0: number;
  vx: number;
  y0: number;
  vy: number;
  additive: boolean;
}

interface Launch {
  el: HTMLElement;
  x0: number;
  vx: number;
  y0: number;
  vy: number;
  additive: boolean;
  replaces: Animation | null;
}

const flights = new WeakMap<HTMLElement, Flight>();

/** 最近的纵向滚动祖先；没有则为 null。只在开始观察时找一次。 */
function scrollerOf(el: HTMLElement): HTMLElement | null {
  const view = el.ownerDocument.defaultView;
  if (view === null) return null;
  for (let node = el.parentElement; node !== null; node = node.parentElement) {
    const overflow = view.getComputedStyle(node).overflowY;
    if (overflow === "auto" || overflow === "scroll") return node;
  }
  return null;
}

/**
 * 开始观察 container 的直接子项，返回停止函数。
 * spring：让位走哪条弹簧。默认 settle；容器里有自己按 morph 变宽的子项（启动胶囊）时传 morph，兄弟与它的边缘同步。
 * 运行环境没有 ResizeObserver 或 Web Animations 时什么也不做：组件测试用的 jsdom 既不做布局也没有这两个接口，
 * 让位在那里无从谈起；真机的 WebView2 两者都有。
 */
export function observeReflow(container: HTMLElement, spring: SpringName = "settle"): () => void {
  const doc = container.ownerDocument;
  const view = doc.defaultView;
  if (view === null || typeof ResizeObserver === "undefined" || typeof container.animate !== "function") return () => {};

  const scroller = scrollerOf(container);
  const readScroll = (): Spot => (scroller === null ? { left: 0, top: 0 } : { left: scroller.scrollLeft, top: scroller.scrollTop });

  let spots = new Map<HTMLElement, Spot>();
  // 第一趟只记位置：此前没有「旧位置」可言
  let width: number | null = null;
  let viewport = { width: view.innerWidth, height: view.innerHeight };
  let scroll = readScroll();

  const plan = (el: HTMLElement, tx: number, ty: number): Launch | null => {
    if (Math.abs(tx) < MOVE_EPSILON_PX && Math.abs(ty) < MOVE_EPSILON_PX) return null;
    const flying = flights.get(el);
    if (flying !== undefined) {
      const t = elapsedSeconds(flying.animation);
      const x = springAt(flying.spring, flying.x0, flying.vx, t);
      const y = springAt(flying.spring, flying.y0, flying.vy, t);
      return { el, x0: x.x + tx, vx: x.v, y0: y.x + ty, vy: y.v, additive: flying.additive, replaces: flying.animation };
    }
    // 元素自己就靠 translate 定位或悬停位移时，位移叠加在它上面而不是顶替它（叠加模式不上合成线程，但不会把它甩离原位）
    const base = view.getComputedStyle(el).translate;
    const additive = base !== undefined && base !== "" && base !== "none";
    return { el, x0: tx, vx: 0, y0: ty, vy: 0, additive, replaces: null };
  };

  const launch = ({ el, x0, vx, y0, vy, additive, replaces }: Launch) => {
    replaces?.cancel();
    const { frames, duration } = springTrack(spring, x0, vx, y0, vy);
    const animation = el.animate(frames, { duration, easing: "linear", composite: additive ? "add" : "replace" });
    const flight: Flight = { animation, spring, x0, vx, y0, vy, additive };
    flights.set(el, flight);
    const clear = () => {
      if (flights.get(el) === flight) flights.delete(el);
    };
    animation.onfinish = clear;
    animation.oncancel = clear;
  };

  const pass = () => {
    const next = new Map<HTMLElement, Spot>();
    const baseLeft = container.offsetLeft;
    const baseTop = container.offsetTop;
    for (const child of container.children) {
      // offsetParent 为空：没有盒子（display: none / contents）或固定定位，都不在这条流里
      if (!(child instanceof HTMLElement) || child.offsetParent === null || child.hasAttribute(REFLOW_SKIP_ATTR)) continue;
      const own = child.offsetParent === container;
      next.set(child, { left: child.offsetLeft - (own ? 0 : baseLeft), top: child.offsetTop - (own ? 0 : baseTop) });
    }
    const nextWidth = container.clientWidth;
    const nextViewport = { width: view.innerWidth, height: view.innerHeight };
    const nextScroll = readScroll();

    const still =
      width === null ||
      nextWidth !== width ||
      nextViewport.width !== viewport.width ||
      nextViewport.height !== viewport.height ||
      next.size > REFLOW_MAX_ITEMS ||
      doc.documentElement.hasAttribute("data-sk-reduced");
    const before = spots;
    const drift = { x: nextScroll.left - scroll.left, y: nextScroll.top - scroll.top };
    spots = next;
    width = nextWidth;
    viewport = nextViewport;
    scroll = nextScroll;
    if (still) return;

    const moved: { el: HTMLElement; dx: number; dy: number }[] = [];
    for (const [el, spot] of next) {
      const was = before.get(el);
      if (was === undefined) continue;
      const dx = was.left - spot.left;
      const dy = was.top - spot.top;
      if (Math.abs(dx) >= MOVE_EPSILON_PX || Math.abs(dy) >= MOVE_EPSILON_PX) moved.push({ el, dx, dy });
    }
    if (moved.length === 0) return;

    // 滚动位置在这一趟布局里变了，且恰好抵消了某个子项的位移：这是滚动锚定，按抵消后的量算
    const anchored =
      (drift.x !== 0 || drift.y !== 0) && moved.some((m) => Math.abs(m.dx + drift.x) < MOVE_EPSILON_PX && Math.abs(m.dy + drift.y) < MOVE_EPSILON_PX);
    const launches: Launch[] = [];
    for (const m of moved) {
      const planned = plan(m.el, m.dx + (anchored ? drift.x : 0), m.dy + (anchored ? drift.y : 0));
      if (planned !== null) launches.push(planned);
    }
    for (const item of launches) launch(item);
  };

  const sizes = new ResizeObserver(pass);
  // 每个子项各自登记，不对整棵子树开观察：子项内部再怎么频繁改 DOM（日志、进度文字）都不会惊动这里
  const watch = (node: HTMLElement) => {
    sizes.observe(node, { box: "border-box" });
    kids.observe(node, { attributes: true, attributeFilter: [POPPED_ATTR] });
  };
  const kids = new MutationObserver((records) => {
    for (const record of records) {
      for (const node of record.addedNodes) if (node instanceof HTMLElement) watch(node);
      for (const node of record.removedNodes) if (node instanceof HTMLElement) sizes.unobserve(node);
    }
    pass();
  });
  // 用户自己滚动不算位移：滚动事件先于布局派发，这里记下的就是布局之前的滚动位置
  const onScroll = () => {
    scroll = readScroll();
  };

  sizes.observe(container, { box: "border-box" });
  kids.observe(container, { childList: true });
  for (const child of container.children) if (child instanceof HTMLElement) watch(child);
  scroller?.addEventListener("scroll", onScroll, { passive: true });

  return () => {
    sizes.disconnect();
    kids.disconnect();
    scroller?.removeEventListener("scroll", onScroll);
  };
}

/** 挂到容器元素上的 ref：容器的直接子项互相让位。spring 见 observeReflow。 */
export function useReflow<T extends HTMLElement>(spring: SpringName = "settle"): RefCallback<T> {
  return useCallback(
    (el: T | null) => {
      if (el === null) return;
      return observeReflow(el, spring);
    },
    [spring],
  );
}
