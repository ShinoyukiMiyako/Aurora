// 让位：容器里某个子项的尺寸变了，或子项有增删、换序，其余子项不再一帧跳到新位置，而是从旧位置滑过去。
//
// 为什么不用 framer-motion 的 layout：它只在带 layout 的组件自己重渲染时取「之前」的快照。异步数据在某张卡片内部到达时，
// 被挤开的是它的兄弟，兄弟并没有重渲染，拿不到快照，也就不会动。这里改成观察 DOM 本身：ResizeObserver 报尺寸变化，
// MutationObserver 报增删与换序，与 React 的渲染边界无关，也不要求每个子项都是 motion 元素。
// 退场的子项（AnimatePresence 的 popLayout）是先被抽出布局、淡完才从 DOM 里拿掉的：抽出的那一帧节点没有增删，
// 容器定宽时尺寸也不变，两种观察都不会报。所以另外盯着 framer 给退场项打的标记，兄弟在它让出位置的同一帧起步。
// display: contents 的子项没有盒子，挪它自己没有意义：越过它，把它的元素子项当作让位项（逐层往里，直到不是 contents）。
// 全站的按钮外面都常驻一层这样的提示包裹，容器的直接子项是按钮时，真正被挤动的是包裹里的按钮。
//
// 做法（FLIP）：布局照常一步到位；每个子项记着上一次相对容器的位置，位置变了就补一段从旧位置衰减到 0 的位移。
// - 位移走独立的 translate 属性：页面入场用的是 transform，两者叠加，互不覆盖。
// - 位移交给 Web Animations，关键帧由 settle 弹簧的解析解采样而来：整段在合成线程上播，数据到达时主线程正忙着渲染也不掉帧。
// - 途中又被挤一次：按解析解算出此刻的位置与速度，带着速度接着走，不从零速重新起步。
// - 测量只发生在观察者报了变化的那一帧，先读完再写，不来回触发布局。
//
// 不补位移的情况：容器宽度或窗口尺寸变了（窗口缩放、分档切换引起的重排不做动画）、减少动画、
// 容器带暂停属性（REFLOW_PAUSED_ATTR）、子项超过 REFLOW_HARD_MAX_ITEMS。
// 子项超过 REFLOW_MAX_ITEMS 时位置照记，只给可见范围附近的起动画，远处的直接到位：长列表删一行，可见的那段照样滑上去。
// 滚动锚定：内容在视口上方变高时浏览器会同步调整滚动位置，可见内容本来就没动，这时也不补。容器自己就是滚动容器时同样认得。

import { useCallback, type RefCallback } from "react";
import { springAt, type SpringName } from "./motion";
import { elapsedSeconds, springTrack } from "./slide";

/**
 * 一趟里同时起动画的子项至多这么多：再多既看不清谁在动，逐项起动画（每项一个合成层）的开销也不值。
 * 子项超过这个数时只挑起点或终点落在可见范围附近的，仍超过时取离可见范围中心最近的这么多个。
 */
export const REFLOW_MAX_ITEMS = 40;
/**
 * 子项超过这么多就整趟放弃，连位置也不读；回到这以内的第一趟只记位置。
 * 依据：每一趟按子项数线性地读布局（每项 offsetParent、offsetTop、offsetLeft 三次读取，布局已干净时都是不触发重排的
 * 快速读取，比 getBoundingClientRect 少一次变换换算、也不分配 DOMRect），再建表比对；400 项是一千出头次读取，
 * 估计在一毫秒以内（估算，未实测），且只在变化发生的那一帧做一次。会到几百项的只有导入大整合包时的模组清单
 * （几乎没有位移事件），任务、实例库、版本列表、更新日志都在这以下；超过 100 行的表格已经虚拟化，到不了这里。
 */
export const REFLOW_HARD_MAX_ITEMS = 400;
/** 子项带这个属性时不参与让位（自己管位移的元素，例如拖动排序中的项）。 */
export const REFLOW_SKIP_ATTR = "data-reflow-skip";
/**
 * 容器带这个属性时（值不论）让位暂停：位置照记，不起动画，被挪动的项若还在飞就直接落到新位置。
 * 给「这一批变化该整批换上、不该滑」的时刻用（命令面板键入过滤）；去掉之后的变化照常滑。
 * 属性的增删本身也按暂停处理：开关前后已经排好、尺寸观察还没报上来的变化一并收下，不会在去掉属性的那一刻补滑。
 */
export const REFLOW_PAUSED_ATTR = "data-reflow-paused";

/** framer-motion 的 popLayout 把退场项抽出布局时打在它身上的标记。 */
const POPPED_ATTR = "data-motion-pop-id";

/** 位置差不到这么多像素不算移动：亚像素取整的抖动不该起动画。 */
const MOVE_EPSILON_PX = 1;

/**
 * 子项多时可见范围上下各多算这么多像素。settle 弹簧从一两百像素的位移落定约 0.3 秒，
 * 这段时间里滚两格滚轮（每格约 100 px）能带进视野的就是这么远；与 List 的 ROW_WINDOW_MARGIN（上下各留 4 行）同一量级。
 */
const VIEW_MARGIN_PX = 200;

interface Spot {
  left: number;
  top: number;
}

/** 一个被挪动的子项：新位置的上沿（与 Spot 同一坐标）与要补的起点位移。 */
interface Shift {
  el: HTMLElement;
  top: number;
  tx: number;
  ty: number;
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

/**
 * el 自己或离它最近的纵向滚动祖先；都不滚动时为 null。
 * 从 el 自己查起：让位的容器本身就是滚动容器时，滚动锚定挪的是它自己的滚动位置，只看祖先就把锚定当成了位移。
 */
export function closestScroller(el: HTMLElement): HTMLElement | null {
  const view = el.ownerDocument.defaultView;
  if (view === null) return null;
  for (let node: HTMLElement | null = el; node !== null; node = node.parentElement) {
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

  // 只在开始观察时找一次
  const scroller = closestScroller(container);
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

  /**
   * 认出来的 display: contents 包裹层：让位越过它，量与盯的都是它里面的元素子项。
   * 认下之后直到它离开容器都不再复查 display：每趟复查就得给每个包裹层多读一次计算样式。
   */
  const wrappers = new WeakSet<HTMLElement>();

  /** 让位项：容器的元素子项，已认出的包裹层换成它里面的。只走 DOM，不读布局。 */
  const collect = (parent: Element, into: HTMLElement[]): HTMLElement[] => {
    for (const child of parent.children) {
      if (!(child instanceof HTMLElement) || child.hasAttribute(REFLOW_SKIP_ATTR)) continue;
      if (wrappers.has(child)) collect(child, into);
      else into.push(child);
    }
    return into;
  };

  /**
   * 子项多时挑出值得动的：起点或终点落在可见范围附近（上下各留 VIEW_MARGIN_PX）的，离可见范围中心近的优先，
   * 至多 REFLOW_MAX_ITEMS 个。起点终点都在远处的直接到位：整段都在视野之外，一帧跳过去看不出差别。
   * 可见范围取滚动容器与窗口的交集，没有滚动容器时就是窗口；只看纵向，滚动容器本来就只认纵向的。
   * inner：让位项的定位祖先是容器本身，位置从容器的内边距边量起（否则从边框边）。
   */
  const nearView = (shifts: Shift[], inner: boolean): Shift[] => {
    // 位置是容器内容未滚动时的布局位置：换成视口坐标要减去容器自己的滚动量
    const rect = container.getBoundingClientRect();
    const origin = rect.top + (inner ? container.clientTop : 0) - container.scrollTop;
    const clip = scroller === null ? null : scroller.getBoundingClientRect();
    const top = Math.max(clip === null ? 0 : clip.top, 0);
    const bottom = Math.min(clip === null ? view.innerHeight : clip.bottom, view.innerHeight);
    const center = (top + bottom) / 2;
    const near = (y: number, h: number) => y <= bottom + VIEW_MARGIN_PX && y + h >= top - VIEW_MARGIN_PX;
    const gap = (y: number, h: number) => (center < y ? y - center : center > y + h ? center - y - h : 0);
    const ranked: { shift: Shift; distance: number }[] = [];
    for (const shift of shifts) {
      const h = shift.el.offsetHeight;
      const end = origin + shift.top;
      const begin = end + shift.ty;
      if (!near(end, h) && !near(begin, h)) continue;
      ranked.push({ shift, distance: Math.min(gap(end, h), gap(begin, h)) });
    }
    // 排序是稳定的：离中心一样近的按文档顺序取
    ranked.sort((a, b) => a.distance - b.distance);
    return ranked.slice(0, REFLOW_MAX_ITEMS).map((r) => r.shift);
  };

  /** quiet：这一趟按暂停处理（暂停开关刚增删过）。 */
  const pass = (quiet: boolean) => {
    const items = collect(container, []);
    // 先数再量：数只走 DOM，超过硬上限时一个位置也不读。旧位置跟着作废：超限期间的变化没有跟踪，
    // 回到上限以内时拿它补滑，会把用户早已看着跳完的位移再播一遍
    if (items.length > REFLOW_HARD_MAX_ITEMS) {
      spots = new Map();
      return;
    }
    const next = new Map<HTMLElement, Spot>();
    const baseLeft = container.offsetLeft;
    const baseTop = container.offsetTop;
    let inner = false;
    // 按下标走：循环里新认出的包裹层，它里面的元素追加在末尾，这一趟就量到
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const parent = item.offsetParent;
      if (parent === null) {
        // 没有盒子。display: contents 的包裹层头一次遇到时认下来（只有这类没有盒子的才读计算样式，布局此刻已是干净的）；
        // display: none、固定定位不在这条流里
        if (view.getComputedStyle(item).display === "contents") {
          adopt(item);
          collect(item, items);
        }
        continue;
      }
      const own = parent === container;
      if (own) inner = true;
      next.set(item, { left: item.offsetLeft - (own ? 0 : baseLeft), top: item.offsetTop - (own ? 0 : baseTop) });
    }
    const nextWidth = container.clientWidth;
    const nextViewport = { width: view.innerWidth, height: view.innerHeight };
    const nextScroll = readScroll();

    const still =
      width === null ||
      nextWidth !== width ||
      nextViewport.width !== viewport.width ||
      nextViewport.height !== viewport.height ||
      doc.documentElement.hasAttribute("data-sk-reduced");
    const before = spots;
    const drift = { x: nextScroll.left - scroll.left, y: nextScroll.top - scroll.top };
    spots = next;
    width = nextWidth;
    viewport = nextViewport;
    scroll = nextScroll;
    if (still) return;

    const moved: { el: HTMLElement; top: number; dx: number; dy: number }[] = [];
    for (const [el, spot] of next) {
      const was = before.get(el);
      if (was === undefined) continue;
      const dx = was.left - spot.left;
      const dy = was.top - spot.top;
      if (Math.abs(dx) >= MOVE_EPSILON_PX || Math.abs(dy) >= MOVE_EPSILON_PX) moved.push({ el, top: spot.top, dx, dy });
    }
    if (moved.length === 0) return;

    if (quiet || container.hasAttribute(REFLOW_PAUSED_ATTR)) {
      // 被挪动的项还在飞的，剩下那段是相对旧排布起的：新排布整批一步换上了，接着播只会多出一段与这次变化无关的漂移。
      // 登记当场清掉：取消事件不是当场派发的，这期间再来一趟会按已取消的轨迹去算此刻的位置
      for (const m of moved) {
        const flying = flights.get(m.el);
        if (flying === undefined) continue;
        flights.delete(m.el);
        flying.animation.cancel();
      }
      return;
    }

    // 滚动位置在这一趟布局里变了，且恰好抵消了某个子项的位移：这是滚动锚定，按抵消后的量算
    const anchored =
      (drift.x !== 0 || drift.y !== 0) && moved.some((m) => Math.abs(m.dx + drift.x) < MOVE_EPSILON_PX && Math.abs(m.dy + drift.y) < MOVE_EPSILON_PX);
    const shifts: Shift[] = moved.map((m) => ({ el: m.el, top: m.top, tx: m.dx + (anchored ? drift.x : 0), ty: m.dy + (anchored ? drift.y : 0) }));
    const chosen = next.size > REFLOW_MAX_ITEMS ? nearView(shifts, inner) : shifts;
    const launches: Launch[] = [];
    for (const s of chosen) {
      const planned = plan(s.el, s.tx, s.ty);
      if (planned !== null) launches.push(planned);
    }
    for (const item of launches) launch(item);
  };

  const sizes = new ResizeObserver(() => pass(false));
  // 每个让位项各自登记，不对整棵子树开观察：子项内部再怎么频繁改 DOM（日志、进度文字）都不会惊动这里
  const watch = (node: HTMLElement) => {
    sizes.observe(node, { box: "border-box" });
    kids.observe(node, { attributes: true, attributeFilter: [POPPED_ATTR] });
  };
  // 包裹层没有盒子：尺寸恒为 0，退场标记打在它身上也抽不出什么，这两样都不必盯；改盯它这一层的增删，它里面的元素各自登记。
  // 同一个观察者对同一节点再次 observe 是换选项，不是叠加一份
  const adopt = (node: HTMLElement) => {
    wrappers.add(node);
    sizes.unobserve(node);
    kids.observe(node, { childList: true });
    for (const child of node.children) if (child instanceof HTMLElement) watch(child);
  };
  const unwatch = (node: HTMLElement) => {
    sizes.unobserve(node);
    if (!wrappers.delete(node)) return;
    for (const child of node.children) if (child instanceof HTMLElement) unwatch(child);
  };
  const kids = new MutationObserver((records) => {
    let toggled = false;
    for (const record of records) {
      if (record.type === "attributes") {
        if (record.target === container && record.attributeName === REFLOW_PAUSED_ATTR) toggled = true;
        continue;
      }
      for (const node of record.addedNodes) if (node instanceof HTMLElement) watch(node);
      for (const node of record.removedNodes) if (node instanceof HTMLElement) unwatch(node);
    }
    pass(toggled);
  });
  // 用户自己滚动不算位移：滚动事件先于布局派发，这里记下的就是布局之前的滚动位置
  const onScroll = () => {
    scroll = readScroll();
  };

  sizes.observe(container, { box: "border-box" });
  kids.observe(container, { childList: true, attributes: true, attributeFilter: [REFLOW_PAUSED_ATTR] });
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
