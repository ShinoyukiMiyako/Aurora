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
// - 从静止起步的先暂停在起点，等新排布画出来的下一帧才开始计时：画一整片新内容的那一帧很长，从提交就计时的话第一步跳一大截。
//   跟着 framer-motion 形变走的（传 morph）不等，与形变同一刻起步。
// - 新插入的项自己不动、就地淡入。例外是传 morph 的容器长高、新项开了新的一行：它跟着外框下沿从 -Δh 滑下来。
// - 测量只发生在观察者报了变化的那一帧，先读完再写，不来回触发布局。
//
// 不补位移的情况：容器宽度或窗口尺寸变了（窗口缩放、分档切换引起的重排不做动画）、减少动画、
// 容器带暂停属性（REFLOW_PAUSED_ATTR）、子项超过 REFLOW_HARD_MAX_ITEMS。这些时候被挪动的项若还在飞，当场落到新位置；
// 超过硬上限时不读位置、认不出谁被挪动，还在飞的全部落定。
// 子项超过 REFLOW_MAX_ITEMS 时位置照记，每一趟只给可见范围附近的至多 REFLOW_MAX_ITEMS 个起动画，其余被挪动的直接到位：
// 长列表删一行，可见的那段照样滑上去。
// 滚动锚定：内容在视口上方变高时浏览器会同步调整滚动位置，可见内容本来就没动，这时也不补。容器自己就是滚动容器时同样认得。
//
// 已知限制：容器靠 margin-top: auto 贴底或纵向居中时，容器长高会让它的上沿上移，原地没动的子项相对容器的偏移跟着变了，
// 会被当成位移，先跳开再滑回来。这类容器不要挂让位。

import { useCallback, type RefCallback } from "react";
import { springAt, type SpringName } from "./motion";
import { elapsedSeconds, springTrack } from "./slide";

/**
 * 每一趟至多给这么多子项起动画：一次变化挪动的再多，既看不清谁在动，逐项起动画（每项一个合成层）的开销也不值。
 * 子项超过这个数时只挑起点或终点落在可见范围附近的，仍超过时取离可见范围中心最近的这么多个；被挪动而没挑上的直接到位，
 * 还在飞的当场落定。
 * 上限按趟算，不按同时在飞的总数算：前几趟起飞、这一趟没再被挪动的不占配额，接着飞完。这一趟被挤的才是此刻眼前在变的，
 * 配额先给它们；从配额里扣掉旧轨迹，会让眼前被挤的项一帧跳过去，却让早先起飞的接着飞。旧轨迹各自在一段弹簧时长内落定，
 * 再被挪动的会顶替自己的旧轨迹，不会叠成两段。
 */
export const REFLOW_MAX_ITEMS = 40;
/**
 * 让位项（display: contents 的包裹层展开之后数）超过这么多就整趟放弃，连位置也不读，还在飞的当场落定；回到这以内的第一趟只记位置。
 * 头一次遇到的包裹层要读一次定位祖先与计算样式才认得出，这份读取不论超没超限都要付，之后不再复查。
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

/** 暂停在起点、等新排布画出来的一段：frames 是还要等的动画帧回调数。 */
interface Hold {
  el: HTMLElement;
  flight: Flight;
  frames: number;
}

/** 增删观察报在提交后的微任务里：下一帧才画出新排布，再下一帧开始计时。 */
const HOLD_AFTER_MUTATION = 2;
/** 尺寸观察报在这一帧的渲染步骤里：新排布就在这一帧画出，下一帧开始计时。 */
const HOLD_AFTER_RESIZE = 1;

const flights = new WeakMap<HTMLElement, Flight>();

/**
 * 被挪动而这一趟不补位移的项若还在飞，直接落到新位置：剩下那段轨迹是相对旧排布起的，接着播会先随布局跳一下，
 * 再多出一段与这次变化无关的漂移。
 * 登记当场清掉：取消事件不是当场派发的，这期间再来一趟会按已取消的轨迹去算此刻的位置。
 */
function land(el: HTMLElement): void {
  const flying = flights.get(el);
  if (flying === undefined) return;
  flights.delete(el);
  flying.animation.cancel();
}

/**
 * el 自己或离它最近的纵向滚动祖先；都不滚动时为 null。
 * 从 el 自己查起：让位的容器本身就是滚动容器时，滚动锚定挪的是它自己的滚动位置，只看祖先就把锚定当成了位移。
 * 只看计算后的 overflow-y：只写了 overflow-x: hidden / auto / scroll 的元素，overflow-y 按 CSS 规则会一并算成 auto，
 * 这里也就把它当成纵向滚动容器（计算样式分不出这是不是本意）。让位容器外面隔着这样一层时，滚动锚定只认这一层的
 * 滚动位置，可见范围按它的矩形截，不再看更外面真正在滚的那一个。
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
 * 传 morph 即表示让位与 framer-motion 的布局形变（浮层与弹窗的外框、启动胶囊）同拍：形变的时钟从提交那一刻走，
 * 这里从静止起步也就当场计时，不等新排布画出来；容器长高、新插入的项落在原有各项之下时，它们沿 morph 从 -Δh 起步，
 * 跟着外框下沿下来。
 * 运行环境没有 ResizeObserver 或 Web Animations 时什么也不做：组件测试用的 jsdom 既不做布局也没有这两个接口，
 * 让位在那里无从谈起；真机的 WebView2 两者都有。
 */
export function observeReflow(container: HTMLElement, spring: SpringName = "settle"): () => void {
  const doc = container.ownerDocument;
  const view = doc.defaultView;
  if (view === null || typeof ResizeObserver === "undefined" || typeof container.animate !== "function") return () => {};
  const morphSynced = spring === "morph";

  // 只在开始观察时找一次
  const scroller = closestScroller(container);
  const readScroll = (): Spot => (scroller === null ? { left: 0, top: 0 } : { left: scroller.scrollLeft, top: scroller.scrollTop });

  let spots = new Map<HTMLElement, Spot>();
  // 第一趟只记位置：此前没有「旧位置」可言
  let width: number | null = null;
  // 容器上一趟的高度，只有传 morph 的才读：长高时认出新开的一行。超限的那几趟作废，回到上限以内的第一趟只记
  let height: number | null = null;
  let viewport = { width: view.innerWidth, height: view.innerHeight };
  let scroll = readScroll();

  const plan = (el: HTMLElement, tx: number, ty: number): Launch | null => {
    if (Math.abs(tx) < MOVE_EPSILON_PX && Math.abs(ty) < MOVE_EPSILON_PX) return null;
    const flying = flights.get(el);
    if (flying !== undefined) {
      // 时间还没走（暂停在起点等新排布画出来、或刚建好）：此刻就是起步时记下的位置与速度，不经解析解换算。
      // 欠阻尼弹簧在 t=0 算出的速度带舍入误差（±1e-13），从静止起步的会被当成在动，launch 就不再先暂停
      const t = elapsedSeconds(flying.animation);
      const x = t === 0 ? { x: flying.x0, v: flying.vx } : springAt(flying.spring, flying.x0, flying.vx, t);
      const y = t === 0 ? { x: flying.y0, v: flying.vy } : springAt(flying.spring, flying.y0, flying.vy, t);
      return { el, x0: x.x + tx, vx: x.v, y0: y.x + ty, vy: y.v, additive: flying.additive, replaces: flying.animation };
    }
    // 元素自己就靠 translate 定位或悬停位移时，位移叠加在它上面而不是顶替它（叠加模式不上合成线程，但不会把它甩离原位）
    const base = view.getComputedStyle(el).translate;
    const additive = base !== undefined && base !== "" && base !== "none";
    return { el, x0: tx, vx: 0, y0: ty, vy: 0, additive, replaces: null };
  };

  const holds: Hold[] = [];
  let ticking = false;
  // 停止观察时不取消：还在等的照常开始走，不然会停在起点（同一元素换弹簧重新观察时也是先停后挂）
  const tick = () => {
    let kept = 0;
    for (const hold of holds) {
      if (--hold.frames > 0) {
        holds[kept++] = hold;
        continue;
      }
      // 等待期间被顶替或落定的不再播：已取消的动画 play 会从头重播
      const { el, flight } = hold;
      if (flights.get(el) === flight && flight.animation.playState === "paused") flight.animation.play();
    }
    holds.length = kept;
    ticking = kept > 0;
    if (ticking) view.requestAnimationFrame(tick);
  };

  /** wait：从静止起步时要等的动画帧回调数（HOLD_AFTER_MUTATION / HOLD_AFTER_RESIZE）。 */
  const launch = ({ el, x0, vx, y0, vy, additive, replaces }: Launch, wait: number) => {
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
    // 时钟从这一刻走，新排布却要等这一帧渲染完才上屏：一次提交要画一整片新内容时这一帧要几十毫秒，
    // 弹簧开头那一截没上屏就过去了，第一步跳一大截。先停在起点（首帧当场生效，时钟不走），等新排布画出来的下一帧再播。
    // 途中再被挤的带着速度当场接着走：停两帧就是在动的东西顿一下。跟着 framer 形变走的不等，见 observeReflow
    if (morphSynced || vx !== 0 || vy !== 0) return;
    animation.pause();
    holds.push({ el, flight, frames: wait });
    if (ticking) return;
    ticking = true;
    view.requestAnimationFrame(tick);
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
   * 这一趟至多 REFLOW_MAX_ITEMS 个。起点终点都在远处的直接到位：整段都在视野之外，一帧跳过去看不出差别。
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

  /** quiet：这一趟按暂停处理（暂停开关刚增删过）。wait 见 launch。 */
  const pass = (quiet: boolean, wait: number) => {
    // 先数，再认包裹层，展开之后再数一次，最后才量：超过硬上限时一个位置也不读。
    // 旧位置跟着作废：超限期间的变化没有跟踪，回到上限以内时拿它补滑，会把用户早已看着跳完的位移再播一遍。
    // 还在飞的一并落定：不读位置就认不出谁被挪动了，剩下的轨迹又是相对旧排布起的；落定只走 DOM 与登记表，不读布局
    const items = collect(container, []);
    // 数只走 DOM，已认出的包裹层在这里已经展开；超限时连定位祖先也不读
    if (items.length > REFLOW_HARD_MAX_ITEMS) {
      spots = new Map();
      height = null;
      for (const item of items) land(item);
      return;
    }
    // 认包裹层：只读定位祖先，没有盒子的再读一次计算样式，位置留到确认没超限之后再读。
    // 按下标走：新认出的包裹层，它里面的元素追加在末尾，这一趟就认到（包裹层套包裹层逐层往里）。
    // 展开后超限也把这一趟遇到的认完：认下的不再复查，之后各趟在上一步就停，不用一趟趟地认
    const boxed: { el: HTMLElement; parent: Element }[] = [];
    let count = items.length;
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const parent = item.offsetParent;
      if (parent !== null) {
        boxed.push({ el: item, parent });
        continue;
      }
      // 没有盒子。display: contents 的包裹层头一次遇到时认下来（只有这类没有盒子的才读计算样式，布局此刻已是干净的）；
      // display: none、固定定位不在这条流里
      if (view.getComputedStyle(item).display !== "contents") continue;
      adopt(item);
      const before = items.length;
      collect(item, items);
      // 包裹层自己不算让位项，换成它里面的
      count += items.length - before - 1;
    }
    if (count > REFLOW_HARD_MAX_ITEMS) {
      spots = new Map();
      height = null;
      for (const item of items) land(item);
      return;
    }
    const next = new Map<HTMLElement, Spot>();
    const baseLeft = container.offsetLeft;
    const baseTop = container.offsetTop;
    let inner = false;
    for (const { el, parent } of boxed) {
      const own = parent === container;
      if (own) inner = true;
      next.set(el, { left: el.offsetLeft - (own ? 0 : baseLeft), top: el.offsetTop - (own ? 0 : baseTop) });
    }
    const nextWidth = container.clientWidth;
    const nextHeight = morphSynced ? container.clientHeight : null;
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
    const grown = height === null || nextHeight === null ? 0 : nextHeight - height;
    spots = next;
    width = nextWidth;
    height = nextHeight;
    viewport = nextViewport;
    scroll = nextScroll;

    const moved: { el: HTMLElement; top: number; dx: number; dy: number }[] = [];
    const fresh: { el: HTMLElement; top: number }[] = [];
    for (const [el, spot] of next) {
      const was = before.get(el);
      if (was === undefined) {
        fresh.push({ el, top: spot.top });
        continue;
      }
      const dx = was.left - spot.left;
      const dy = was.top - spot.top;
      if (Math.abs(dx) >= MOVE_EPSILON_PX || Math.abs(dy) >= MOVE_EPSILON_PX) moved.push({ el, top: spot.top, dx, dy });
    }
    if (still) {
      // 新排布一步换上：被它挪动的若还在飞就落定；没被挪动的接着飞，它的轨迹仍对得上新排布，打断反而多跳一下
      for (const m of moved) land(m.el);
      return;
    }
    // 传 morph 的容器长高时，外框下沿沿 morph 跟过来。新插入、落在原有各项之下的（开了新的一行）从 -Δh 起步跟着下沿走；
    // 不跟的话它从第一帧就在终点，下沿还没到，被外框裁掉半截。只看顶边，不读各项的高度。
    // settle 的容器（卡片、页面）下沿是一步到位的，新的一行就地淡入：滑下来只会压在上一行上
    const opened: typeof moved = [];
    if (grown >= MOVE_EPSILON_PX) {
      let lowest = -Infinity;
      for (const spot of before.values()) lowest = Math.max(lowest, spot.top);
      for (const f of fresh) if (f.top - lowest >= MOVE_EPSILON_PX) opened.push({ el: f.el, top: f.top, dx: 0, dy: -grown });
    }
    if (moved.length === 0 && opened.length === 0) return;

    if (quiet || container.hasAttribute(REFLOW_PAUSED_ATTR)) {
      // 新排布整批一步换上了：还在飞的一并落定
      for (const m of moved) land(m.el);
      return;
    }

    // 滚动位置在这一趟布局里变了，且恰好抵消了某个子项的位移：这是滚动锚定，按抵消后的量算。
    // 只拿真被挪动的项来认：新开一行的起点是凑出来的，不是布局位移
    const anchored =
      (drift.x !== 0 || drift.y !== 0) && moved.some((m) => Math.abs(m.dx + drift.x) < MOVE_EPSILON_PX && Math.abs(m.dy + drift.y) < MOVE_EPSILON_PX);
    // 抵消之后不到 1px 的在眼前并没有动：不占挑选的名额，还在飞的接着飞
    const shifts: Shift[] = [];
    for (const m of [...moved, ...opened]) {
      const tx = m.dx + (anchored ? drift.x : 0);
      const ty = m.dy + (anchored ? drift.y : 0);
      if (Math.abs(tx) >= MOVE_EPSILON_PX || Math.abs(ty) >= MOVE_EPSILON_PX) shifts.push({ el: m.el, top: m.top, tx, ty });
    }
    const chosen = next.size > REFLOW_MAX_ITEMS ? nearView(shifts, inner) : shifts;
    if (chosen.length < shifts.length) {
      const picked = new Set(chosen);
      for (const s of shifts) if (!picked.has(s)) land(s.el);
    }
    const launches: Launch[] = [];
    for (const s of chosen) {
      const planned = plan(s.el, s.tx, s.ty);
      if (planned !== null) launches.push(planned);
    }
    for (const item of launches) launch(item, wait);
  };

  const sizes = new ResizeObserver(() => pass(false, HOLD_AFTER_RESIZE));
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
    pass(toggled, HOLD_AFTER_MUTATION);
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
