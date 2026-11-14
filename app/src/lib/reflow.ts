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
// - 途中又被挤一次：按解析解算出此刻的位置与速度，带着速度接着走，不从零速重新起步。弹簧是线性的，这一段等于
//   「旧轨迹照旧走」加上「这一趟的新位移从静止起步」两部分之和，两部分各按各的时刻起步：
//   旧轨迹不能停，新的一段起步时刻钉在文档时间轴此刻（旧动画的 currentTime 就是相对它算的）；新建的 Web Animation
//   要到带着它的那一帧（忙时下一帧）才定起步时刻，不钉的话在动的东西先停一两帧再接着走。
//   新位移那部分与别处从静止起步的让位一样等新排布画出来：先原样留着，到期时在同一个回调里换成从那一刻的位置与速度
//   起步的整段。嵌套的两层（外层分组接着走、里面的行从静止起步）同一刻起步，方向相反的两段位移才互相抵消；
//   早一两帧起步，叠起来就露出单层的位移，在终点附近多冲出去一截。长提交之后也不会把新位移的开头一截跳过去。
// - 从静止起步的先暂停在起点，等新排布画出来的下一帧才开始计时：画一整片新内容的那一帧很长，从提交就计时的话第一步跳一大截。
//   各容器的等待挂在同一条队列上（holdUntilPainted），同一帧到期的在同一个回调里开播；别的模块要与让位同一帧起步的动画也挂进来，
//   要跟着某一项这一趟的让位起步的（它排队就一起排、它当场起步就当场起步）用 followReflow。
//   增删引起的按提交在帧与帧之间算（隔两帧）；提交发生在某一帧的动画帧回调里时新排布就在这一帧画出，
//   由这一帧渲染步骤里的尺寸观察认出来，少等一帧。
//   跟着 framer-motion 形变走的（传 morph）不等：形变从提交那一刻计时，这里把起步时刻钉在建好的那一刻，与它用同一个时钟。
//   尺寸观察要到下一帧的渲染步骤才报：形变节点在 onLayoutAnimationStart 里调 syncReflow（useReflow 的 sync）当场补跑，
//   并交来形变自己的起步时刻，才同一刻起步。
// - 新插入的项自己不动、就地淡入。例外是传 morph 的容器长高、新项开了新的一行：它跟着外框下沿滑下来，
//   起点不高于原有最低一项的下沿（也不高于 -Δh）；紧贴着上一项的仍就地淡入，由长高的外框下沿逐步露出。
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

import { useMemo, useRef, type RefCallback } from "react";
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

/**
 * 一段让位的轨迹：位移是 rest 加上弹簧从 (x0, vx)、(y0, vy) 起走了 t 秒的位移。
 * rest 只在途中接续、等新排布画出来的那一截不为 0：这一趟新挤出来的位移原样留着，旧轨迹接着走（见 observeReflow 的 launch）。
 */
interface Shape {
  x0: number;
  vx: number;
  y0: number;
  vy: number;
  restX: number;
  restY: number;
}

interface Flight extends Shape {
  animation: Animation;
  spring: SpringName;
  additive: boolean;
  /**
   * 这一趟挂进等待队列的那一项，到期时新排布已经画出。从静止起步的停在起点、到期开播；途中接续的到期时换成整段
   * （followReflow 也据此认这一趟）。走 morph 的为 null。
   */
  hold: Hold | null;
}

interface Launch extends Shape {
  el: HTMLElement;
  additive: boolean;
  replaces: Animation | null;
  /**
   * 被顶替的那段已在播（没停在起点等）。刚开播、起步时刻还没定的那一刻速度也是 0，仍按在动的接着走：
   * 跟着它一起开播的（任务页换组行的飞行）已在走，它并进新的一段重新等新排布画出来，两层就错开两帧。
   */
  moving: boolean;
}

/**
 * 等新排布画出来的一项：frames 是还要等的动画帧回调数。到期时同一个回调里先调 starts（途中接续换成整段，
 * 收到这一批钉的起步时刻），再开播 animations 里还停着的。
 */
interface Hold {
  animations: Animation[];
  starts: ((at: number) => void)[];
  frames: number;
}

/**
 * 增删观察报在提交后的微任务里：提交在帧与帧之间时，下一帧才画出新排布，再下一帧开始计时。
 * 提交发生在某一帧的动画帧回调里时，微任务跑在这一帧的回调之后，新排布就在这一帧画出，该和尺寸观察一样只等一帧：
 * observeReflow 挂上这种等待时把容器的尺寸观察撤下重挂，这一帧的渲染步骤里它一定报一次，报到时这一项还没经过回调
 * （还要等两帧），就改成只等一帧。容器没有尺寸时报不出来，照两帧算。从 holdUntilPainted 挂的照数，不做这一步。
 */
export const HOLD_AFTER_MUTATION = 2;
/** 尺寸观察报在这一帧的渲染步骤里：新排布就在这一帧画出，下一帧开始计时。 */
export const HOLD_AFTER_RESIZE = 1;

/**
 * 每个窗口一条等待队列，排着时恰好有一个动画帧回调。各容器的让位与别的模块挂进来的动画共用它：同一帧到期的在同一个回调里开播。
 * 各排各的回调、在同一帧里分开 play 的，Chromium 实测也定成同一个起步时刻；共用一个回调是为了不依赖引擎这样做：
 * 规范只说起步时刻取动画就绪那一刻的时间轴时间，没有要求同一帧里分开 play 的在同一刻就绪。
 * 有途中接续要换成整段的那一批整批钉起步时刻（见 tick），同一批也靠同一个回调认出来。
 */
const waiting = new WeakMap<Window, Hold[]>();

function tick(view: Window, holds: Hold[]): void {
  // 先换上新的一条：开播途中再挂进来的排到它上面，从下一帧起算
  const kept: Hold[] = [];
  waiting.set(view, kept);
  const due: Hold[] = [];
  for (const hold of holds) {
    if (--hold.frames > 0) kept.push(hold);
    else due.push(hold);
  }
  // 到期的各项来自互不相干的容器与模块。各排各的动画帧回调时，一个回调抛异常，浏览器报告之后照样跑同一帧别的回调；
  // 共用一个回调只为同一刻起步，不该让一项的异常连累同一批：每个 start 与 play 各自接住异常，同一批照常做完，
  // 再原样抛出（不止一个时合成 AggregateError），照样冒到动画帧回调外面。
  // 下一次回调排在 finally 里：漏排的话 kept 再也等不到回调，之后挂进来的只会追加进这条队列，
  // 这个窗口的让位全停在起点、接续的停在留着位移的末帧。取不到时间轴的时间时这一批钉不了，整批不做，异常照样抛出
  const failures: unknown[] = [];
  try {
    // 只有从静止起步的一批照常 play，起步时刻交给引擎在这一帧的动画更新里一起定（新上合成线程的常常定在下一帧）。
    // 有途中接续要换成整段的一批，整批钉在这一帧的时间上：换上的整段不能等引擎定（定在下一帧的话，接着走的旧轨迹
    // 在那一帧停住）；只钉它又不行，钉了起步时刻的一段新上合成线程时，同一批里还没定时刻、只在主线程上播的（叠加模式）
    // 要等到下一帧才定，里外两层又错开一帧（Chromium 实测，外层分组钉在这一帧、里面叠加模式的行晚一帧起步）
    const pinned = due.some((hold) => hold.starts.length > 0) ? timelineNow(view) : null;
    if (pinned !== null) {
      for (const hold of due) {
        for (const start of hold.starts) {
          try {
            start(pinned);
          } catch (error) {
            failures.push(error);
          }
        }
      }
    }
    for (const hold of due) {
      for (const animation of hold.animations) {
        // 等待期间被取消（落定、被新的轨迹顶替）、播完或已在别处播起来的不再播：已取消的动画 play 会从头重播
        if (animation.playState !== "paused") continue;
        try {
          animation.play();
          if (pinned !== null) animation.startTime = pinned;
        } catch (error) {
          failures.push(error);
        }
      }
    }
  } finally {
    if (kept.length > 0) view.requestAnimationFrame(() => tick(view, kept));
    else waiting.delete(view);
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new AggregateError(failures, `让位等待队列这一帧到期的有 ${failures.length} 项抛了异常`);
}

function checkWait(wait: number): void {
  if (!Number.isInteger(wait) || wait < 1) throw new RangeError(`等待的动画帧数要是正整数，收到 ${wait}`);
}

/** 挂进 view 的等待队列，还要等 frames 次动画帧回调；animations 当场暂停，到期时开播。 */
function enqueue(animations: Animation[], view: Window, frames: number): Hold {
  for (const animation of animations) animation.pause();
  const hold: Hold = { animations, starts: [], frames };
  const holds = waiting.get(view);
  if (holds !== undefined) {
    holds.push(hold);
    return hold;
  }
  const first = [hold];
  waiting.set(view, first);
  view.requestAnimationFrame(() => tick(view, first));
  return hold;
}

/**
 * 当场暂停 animation（首帧生效、时钟不走），等新排布画出来再开播：第 wait 次动画帧回调时 play，
 * 与同一帧到期的其余等待在同一个回调里开播。等待期间动画已被取消、播完或顶替（playState 不是 paused）就不再播。
 * wait 按调用的时机取：提交后的微任务里（增删观察、framer-motion 的布局冲刷）用 HOLD_AFTER_MUTATION，
 * 渲染步骤里（尺寸观察）用 HOLD_AFTER_RESIZE；这里照数，提交发生在动画帧回调里时少等一帧的校正只有 observeReflow 自己的让位有。
 * 例如卡片外框（ui/Card 的 reflowEdge）：只在尺寸观察里起步，按 HOLD_AFTER_RESIZE 挂进来，与卡内从静止起步的让位在同一个回调里开播。
 * 要跟着某一项的让位起步的动画（任务页换组行的飞行）用 followReflow，它该排队时也挂在这里。
 * 停止观察、卸载都不撤销等待：还在等的照常开始走，不然会停在起点。
 */
export function holdUntilPainted(animation: Animation, view: Window, wait: number): void {
  checkWait(wait);
  enqueue([animation], view, wait);
}

/**
 * 等新排布画出来再调 start：第 wait 次动画帧回调时调，与同一帧到期的等待在同一个回调里、先于它们开播。wait 的取法同 holdUntilPainted。
 * 给自己算途中接续的元素用（ui/Card 的 reflowEdge 外框）：等着的这段时间旧轨迹接着走、这次的位移原样留着，
 * start 里换成从那一刻的位置与速度起步的整段，起步时刻钉在收到的 at 上（这一帧的时间）。同一批到期的、从静止起步的
 * 也钉在 at 上（见 tick），新位移与卡内从静止起步的让位同一刻起步。
 * 停止观察、卸载都不撤销：到期照常调，start 自己认还该不该换。
 */
export function startWhenPainted(start: (at: number) => void, view: Window, wait: number): void {
  checkWait(wait);
  enqueue([], view, wait).starts.push(start);
}

/**
 * 文档时间轴此刻的时间。途中接续时旧动画走了多久（currentTime）就是相对它算的，接着走的那一截起步时刻钉在这里才与读数同一刻。
 * 它在帧与帧之间停在上一帧的帧时间上，比 performance.now() 早：钉在后者上，旧轨迹要等到那时才接着走，在动的东西先顿一截。
 */
function timelineNow(view: Window): number {
  const time = view.document.timeline.currentTime;
  if (typeof time !== "number") throw new Error(`文档时间轴没有可用的时间（${String(time)}），接续的起步时刻无从钉起`);
  return time;
}

/**
 * 途中接续里等新排布画出来的那一截：一条采样好的轨迹（lib/slide 的 springTrack 一类，旧轨迹接着走、这次的位移原样留着）
 * 交给 Web Animations 播，起步时刻钉在文档时间轴此刻，不先停在起点；fill 为 both，播完也停在留着位移的末帧，等着换成整段。
 * 与让位里带着速度接着走的同一个做法。给自己按解析解算接续的元素用（ui/Card 的 reflowEdge 外框），换的时机交给 startWhenPainted。
 */
export function playContinuing(el: HTMLElement, track: { frames: Keyframe[]; duration: number }): Animation {
  const view = el.ownerDocument.defaultView;
  if (view === null) throw new Error("元素不在窗口里，没有文档时间轴可钉");
  const at = timelineNow(view);
  const animation = el.animate(track.frames, { duration: track.duration, easing: "linear", fill: "both" });
  animation.startTime = at;
  return animation;
}

const flights = new WeakMap<HTMLElement, Flight>();

/** 观察中的容器各自的补跑入口，见 syncReflow。 */
const syncs = new WeakMap<HTMLElement, (startedAt?: number) => void>();

/**
 * 对已在 observeReflow 观察中的 container 当场补跑一趟：读新位置、与上一趟比、起动画，等同于尺寸观察此刻报到；
 * 之后尺寸观察再报到时位置已记过，不重复起动画。container 不在观察中时什么也不做。
 * 用途：framer-motion 布局节点的 onLayoutAnimationStart 里调用，兄弟的让位与形变同一刻起步。尺寸观察要到提交之后
 * 那一帧的渲染步骤才报，比形变晚一帧以上；形变在提交后的微任务里冲刷时起步，onLayoutAnimationStart 就在这次冲刷里。
 * - startedAt：形变自己的起步时刻（framer-motion 冲刷布局时写下的帧时间 frameData.timestamp，形变的 startTime 就取它）。
 *   走 morph 的轨迹起步时刻钉在这里、fill 为 backwards。冲刷在回调之前就取了时刻，比回调里另读的 performance.now()
 *   早零点几毫秒（点击触发的提交）到几毫秒（定时器触发的提交）：钉在后者上，兄弟整段都比形变的边缘落后这么多。
 *   不给时钉在这一趟读到的 performance.now()，与增删那条路一致。
 * - 增删观察还没报的变化（同一次提交里的增删、暂停开关）先一并收下，再跑这一趟。
 * - 从静止起步的按提交后的微任务算，等 HOLD_AFTER_MUTATION 帧：这时新排布还没画出来。
 */
export function syncReflow(container: HTMLElement, startedAt?: number): void {
  syncs.get(container)?.(startedAt);
}

/**
 * 让 animation 跟着 leader 这一趟的让位起步，两段同一刻开始计时。animation 由调用方建好、还没开始计时；
 * leader 是某个 observeReflow 容器的让位项（容器的直接子项，display: contents 的包裹层换成它里面的）。
 * 「这一趟」按 leader 这一趟挂的等待认：还没到期，就是这一趟的新排布还没画出来。
 * - leader 这一趟的新位移还在等新排布画出来：animation 当场暂停，挂进它的那一项等待，与它在同一个回调里开播
 *   （那一项此后改成少等一帧时一起少等）。从静止起步的停在起点；上一段没走完又被挤的旧轨迹照旧走、这一趟的位移留着，
 *   到期时换成整段，跟随的与这一趟的位移同一刻起步。增删引起的到下一帧尺寸观察的回调里才调也赶得上，那一项还没到期。
 * - leader 刚在这一帧的回调里开播或换成整段、时钟还没走：animation 也不等，建好就播；leader 的起步时刻钉在了这一帧
 *   （那一批有途中接续换成整段）时 animation 钉同一刻，否则与它在同一帧由引擎定。
 * - leader 没有让位，或它的让位早已在走（这一趟没挪动它）：跟谁都不相干，按从静止起步处理，同 holdUntilPainted(animation, view, wait)。
 * 认的是调用这一刻 leader 的让位，所以要在 leader 所在容器这一趟跑过之后调：增删引起的跑在提交后的微任务里，
 * 尺寸变化引起的跑在这一帧尺寸观察的回调里，在比它晚建的尺寸观察回调里调就赶得上。
 * leader 的让位走 morph 时报错：那里的起步时刻钉在建好的那一刻，可能晚于接下来那一帧的帧时间，跟着它要钉同一刻并留住首帧，这里不做。
 */
export function followReflow(animation: Animation, leader: HTMLElement, wait: number): void {
  checkWait(wait);
  const view = leader.ownerDocument.defaultView;
  if (view === null) throw new Error("领头元素不在窗口里，没有动画帧可等");
  const flight = flights.get(leader);
  if (flight?.spring === "morph") throw new Error("领头元素的让位走 morph，起步时刻钉在建好的那一刻，followReflow 跟不了");
  if (flight !== undefined && flight.hold !== null && flight.hold.frames > 0) {
    animation.pause();
    flight.hold.animations.push(animation);
    return;
  }
  if (flight === undefined || elapsedSeconds(flight.animation) > 0) {
    enqueue([animation], view, wait);
    return;
  }
  // leader 刚在这一帧起步：这一批钉了起步时刻的，跟随的钉同一刻（不钉的话它要等引擎定，可能晚一帧）
  const startedAt = flight.animation.startTime;
  if (typeof startedAt === "number") animation.startTime = startedAt;
}

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
 * 登记的这一段此刻弹簧那部分的位移与速度（不含 rest）。时间还没走（暂停在起点等新排布画出来、刚建好、或钉下的起步时刻还没到）：
 * 就是起步时记下的值，不经解析解换算。欠阻尼弹簧在 t=0 算出的速度带舍入误差（±1e-13），从静止起步的会被当成在动，就不再先暂停
 */
function stateOf(flight: Flight): { x: { x: number; v: number }; y: { x: number; v: number } } {
  const t = elapsedSeconds(flight.animation);
  if (t === 0) return { x: { x: flight.x0, v: flight.vx }, y: { x: flight.y0, v: flight.vy } };
  return { x: springAt(flight.spring, flight.x0, flight.vx, t), y: springAt(flight.spring, flight.y0, flight.vy, t) };
}

/** 留着的位移并进弹簧那部分：一整段从这个位置与速度出发，回到 0。 */
function whole(shape: Shape): Shape {
  return { x0: shape.restX + shape.x0, vx: shape.vx, y0: shape.restY + shape.y0, vy: shape.vy, restX: 0, restY: 0 };
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
 * 传 morph 即表示让位与 framer-motion 的布局形变（浮层与弹窗的外框、启动胶囊）同拍。形变在提交后的微任务里冲刷，
 * 起步时刻取那一刻的 performance.now()；新建的 Web Animations 却要等带着它的那一帧画出来才定起步时刻，一次长提交之后
 * 晚几十毫秒，整段跟着落后。所以这里不等新排布画出来，起步时刻直接钉在建好的那一刻（文档时间轴与 performance.now()
 * 同一原点）。增删观察就报在提交后的微任务里，与形变的起点只差这一趟自己的耗时；尺寸观察报在下一帧的渲染步骤里，
 * 形变已经走了从提交到这一帧的那一段，这条路上仍晚这么多，除非形变节点在 onLayoutAnimationStart 里调 syncReflow 当场补跑，
 * 并把形变自己的起步时刻交过来（见 syncReflow 的 startedAt）。
 * 容器长高 Δh、新插入的项落在原有各项之下时，它们沿 morph 跟着外框下沿下来：起点不高于原有最低一项的下沿，
 * 补的位移也不超过 Δh，不压到上一行上；补不到 1px 的就地淡入。
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
  // 提交后挂上的等待：还没经过动画帧回调的，等容器的尺寸观察报到时改成只等一帧，见 HOLD_AFTER_MUTATION
  let unpainted: Hold[] = [];

  const plan = (el: HTMLElement, tx: number, ty: number): Launch | null => {
    if (Math.abs(tx) < MOVE_EPSILON_PX && Math.abs(ty) < MOVE_EPSILON_PX) return null;
    const flying = flights.get(el);
    if (flying !== undefined) {
      // 弹簧那部分照旧，这一趟的位移并进留着的那部分：从静止起步的一起等，在动的旧轨迹接着走、新位移等画出来，见 launch
      const now = stateOf(flying);
      const moving = flying.animation.playState !== "paused" || now.x.v !== 0 || now.y.v !== 0;
      return { el, x0: now.x.x, vx: now.x.v, y0: now.y.x, vy: now.y.v, restX: flying.restX + tx, restY: flying.restY + ty, additive: flying.additive, replaces: flying.animation, moving };
    }
    // 元素自己就靠 translate 定位或悬停位移时，位移叠加在它上面而不是顶替它（叠加模式不上合成线程，但不会把它甩离原位）
    const base = view.getComputedStyle(el).translate;
    const additive = base !== undefined && base !== "" && base !== "none";
    return { el, x0: 0, vx: 0, y0: 0, vy: 0, restX: tx, restY: ty, additive, replaces: null, moving: false };
  };

  /**
   * 起一段并登记。pin 为 null 时起步时刻等带着它的那一帧再定，否则钉在 pin。
   * held：等新排布画出来、留着位移的那一截。它播完停在末帧（fill 为 both），登记不清，到期还要按它换成整段。
   */
  const begin = (el: HTMLElement, shape: Shape, additive: boolean, fill: FillMode, pin: number | null, held: boolean): Flight => {
    const { frames, duration } = springTrack(spring, shape.x0, shape.vx, shape.y0, shape.vy, shape.restX, shape.restY);
    const animation = el.animate(frames, { duration, easing: "linear", composite: additive ? "add" : "replace", fill });
    if (pin !== null) animation.startTime = pin;
    const flight: Flight = { ...shape, animation, spring, additive, hold: null };
    flights.set(el, flight);
    const clear = () => {
      if (flights.get(el) === flight) flights.delete(el);
    };
    if (!held) animation.onfinish = clear;
    animation.oncancel = clear;
    return flight;
  };

  /**
   * afterCommit：这一趟跑在提交后的微任务里（增删观察、补跑），新位移等 HOLD_AFTER_MUTATION 帧；
   * 否则跑在渲染步骤里（尺寸观察），等 HOLD_AFTER_RESIZE 帧。
   * at：走 morph 的起步时刻钉在这里：补跑时是形变节点交来的起步时刻，否则是这一趟读到的 performance.now()。
   */
  const launch = (planned: Launch, afterCommit: boolean, at: number) => {
    const { el, additive } = planned;
    planned.replaces?.cancel();
    // 跟着 framer 形变走的与形变同一个时钟，见 observeReflow。钉了起步时刻，接下来那一帧的帧时间可能早于它
    // （尺寸观察报在这一帧的渲染步骤里，帧时间是这一帧开始时定的；长提交之后的第一帧，帧时间是长任务之前排下的）：
    // 不留住首帧，那一帧会画成终点
    if (morphSynced) {
      begin(el, whole(planned), additive, "backwards", at, false);
      return;
    }
    // 被顶替或落定时动画当场取消，等待队列认得出、不再播也不再换；停止观察时不撤销等待（同一元素换弹簧重新观察时也是先停后挂）
    const wait = afterCommit ? HOLD_AFTER_MUTATION : HOLD_AFTER_RESIZE;
    let hold: Hold;
    if (!planned.moving) {
      // 时钟从这一刻走，新排布却要等这一帧渲染完才上屏：一次提交要画一整片新内容时这一帧要几十毫秒，
      // 弹簧开头那一截没上屏就过去了，第一步跳一大截。先停在起点（首帧当场生效，时钟不走），等新排布画出来的下一帧再播
      const flight = begin(el, whole(planned), additive, "auto", null, false);
      hold = enqueue([flight.animation], view, wait);
      flight.hold = hold;
    } else {
      // 途中再被挤（被顶替的那段已在播）：旧轨迹不停（停下等就是在动的东西顿一下），起步时刻钉在读旧轨迹的这一刻；这一趟的新位移原样留着，
      // 与别处从静止起步的让位一样等新排布画出来，到期时在开播它们的同一个回调里，按那一刻的位置与速度换成整段，
      // 与它们钉同一个起步时刻（见 tick）
      const flight = begin(el, planned, additive, "both", timelineNow(view), true);
      hold = enqueue([], view, wait);
      flight.hold = hold;
      hold.starts.push((pinned) => {
        if (flights.get(el) !== flight) return;
        const now = stateOf(flight);
        flight.animation.cancel();
        const shape = whole({ x0: now.x.x, vx: now.x.v, y0: now.y.x, vy: now.y.v, restX: flight.restX, restY: flight.restY });
        begin(el, shape, additive, "auto", pinned, false).hold = hold;
      });
    }
    if (afterCommit) unpainted.push(hold);
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

  /** quiet：这一趟按暂停处理（暂停开关刚增删过）。afterCommit 见 launch。startedAt：补跑时形变节点交来的起步时刻，见 syncReflow。 */
  const pass = (quiet: boolean, afterCommit: boolean, startedAt?: number) => {
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
    // 传 morph 的容器长高时，外框下沿沿 morph 跟过来。新插入、顶边低于原有各项的（开了新的一行）补一段跟着下沿走的位移，
    // 起点不高于原有最低一项的下沿，也不高于 -Δh：不跟的话它从第一帧就在终点，下沿还没到，被外框裁掉半截；
    // 一律从 -Δh 起步又会从上一行的位置出发，行没有底色时两行字叠着画到淡入完。
    // 紧贴着上一项的（列表末尾追加一行）补不到 1px，就地淡入，由长高的外框下沿逐步露出。
    // 下沿取上一趟最低一项的顶边加它此刻的高度：只在真有新行时多读这一次。
    // settle 的容器（卡片、页面）下沿是一步到位的，新的一行就地淡入：滑下来只会压在上一行上
    const opened: typeof moved = [];
    if (grown >= MOVE_EPSILON_PX) {
      let lowest: HTMLElement | null = null;
      let lowestTop = -Infinity;
      for (const [el, spot] of before) {
        if (spot.top <= lowestTop) continue;
        lowest = el;
        lowestTop = spot.top;
      }
      let lowestBottom: number | null = null;
      for (const f of fresh) {
        if (f.top - lowestTop < MOVE_EPSILON_PX) continue;
        if (lowestBottom === null) lowestBottom = lowest === null ? -Infinity : lowestTop + lowest.offsetHeight;
        const rise = Math.min(grown, f.top - lowestBottom);
        if (rise >= MOVE_EPSILON_PX) opened.push({ el: f.el, top: f.top, dx: 0, dy: -rise });
      }
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
    // 同一趟的几段钉在同一刻：逐个建动画要花时间，各读各的会让它们错开起步。形变节点交来了自己的起步时刻就用它
    const at = startedAt ?? view.performance.now();
    // 已经过动画帧回调的不必再认，免得报不出尺寸的容器越攒越多
    unpainted = unpainted.filter((hold) => hold.frames === HOLD_AFTER_MUTATION);
    const pending = unpainted.length;
    for (const item of launches) launch(item, afterCommit, at);
    if (unpainted.length === pending) return;
    // 同一个观察者再 observe 同一节点、选项不变时浏览器不重置，撤下再挂才会在下一次渲染步骤里报一次
    sizes.unobserve(container);
    sizes.observe(container, { box: "border-box" });
  };

  const sizes = new ResizeObserver(() => {
    // 渲染步骤里报到时还没经过动画帧回调的：提交发生在这一帧的回调里，新排布就在这一帧画出，与这里起的让位一样只等一帧
    for (const hold of unpainted) if (hold.frames === HOLD_AFTER_MUTATION) hold.frames = HOLD_AFTER_RESIZE;
    unpainted = [];
    pass(false, false);
  });
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
  /** 收下增删记录：新来的纳入观察、移走的不再观察。返回暂停开关是否增删过。 */
  const absorb = (records: MutationRecord[]): boolean => {
    let toggled = false;
    for (const record of records) {
      if (record.type === "attributes") {
        if (record.target === container && record.attributeName === REFLOW_PAUSED_ATTR) toggled = true;
        continue;
      }
      for (const node of record.addedNodes) if (node instanceof HTMLElement) watch(node);
      for (const node of record.removedNodes) if (node instanceof HTMLElement) unwatch(node);
    }
    return toggled;
  };
  const kids = new MutationObserver((records) => pass(absorb(records), true));
  // 补跑时增删观察可能还有没报的记录（同一次提交里的增删、暂停开关）：取出来先收下，回调也就不会再拿它们跑一趟
  const sync = (startedAt?: number) => pass(absorb(kids.takeRecords()), true, startedAt);
  // 用户自己滚动不算位移：滚动事件先于布局派发，这里记下的就是布局之前的滚动位置
  const onScroll = () => {
    scroll = readScroll();
  };

  sizes.observe(container, { box: "border-box" });
  kids.observe(container, { childList: true, attributes: true, attributeFilter: [REFLOW_PAUSED_ATTR] });
  for (const child of container.children) if (child instanceof HTMLElement) watch(child);
  scroller?.addEventListener("scroll", onScroll, { passive: true });
  syncs.set(container, sync);

  return () => {
    sizes.disconnect();
    kids.disconnect();
    scroller?.removeEventListener("scroll", onScroll);
    // 同一容器可能已经挂上了新的一份（先挂后停）：只撤自己这一份
    if (syncs.get(container) === sync) syncs.delete(container);
  };
}

/**
 * 挂到容器元素上的 ref：容器的直接子项互相让位。spring 见 observeReflow。
 * 返回值同时带 sync(startedAt?)：对此刻挂着的容器调 syncReflow，没挂着时什么也不做。返回值（连同 sync）在 spring 不变时引用稳定，
 * 可以直接交给启动胶囊的 onMorphStart（它带着形变的起步时刻调用）；直接交给 framer-motion 的 onLayoutAnimationStart 时
 * 不带时刻，按补跑这一刻的 performance.now() 钉。
 */
export function useReflow<T extends HTMLElement>(spring: SpringName = "settle"): RefCallback<T> & { sync(startedAt?: number): void } {
  const mounted = useRef<T | null>(null);
  return useMemo(() => {
    const ref = (el: T | null) => {
      if (el === null) return;
      mounted.current = el;
      const stop = observeReflow(el, spring);
      return () => {
        stop();
        if (mounted.current === el) mounted.current = null;
      };
    };
    const sync = (startedAt?: number) => {
      if (mounted.current !== null) syncReflow(mounted.current, startedAt);
    };
    return Object.assign(ref, { sync });
  }, [spring]);
}
