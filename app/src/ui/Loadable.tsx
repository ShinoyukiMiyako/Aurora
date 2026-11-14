// 加载态与内容态的容器：把加载门（lib/loading-gate）的三种状态画成不发生位移的样子。
//
// - pending：占位（骨架）照常占着尺寸但不可见。请求很快回来时界面不闪，也不会先是 0 高、数据一到再撑开。
//   内容在这段时间里到达时，骨架同一帧直接拿掉：它本来就看不见，不播退场。上一段显出来过、退场没播完就被拉回等待期的骨架
//   不算在内：它正从半透明往 0 走，这时内容到达照常播退场，不在半透明时一帧消失；已经走到 0 的照样同一帧拿掉。
// - skeleton：骨架淡入。
// - content：内容淡入；骨架同时淡出，这时它已经脱离布局、叠在内容上，容器立即取内容的尺寸。
//   两层都等内容画出第一帧之后才起步：到达那次提交再长，交叉淡化也从头走。
// - 从内容退回加载（出错后重试、换了请求）：反过来交叉淡化。内容脱离布局、叠在骨架上淡出，骨架照上面的规则出现：
//   回到 pending 时先不可见地占位，直接回到 skeleton 时从透明淡入。
//
// 页面入场：挂载时就是内容（数据早就在），内容不单独淡入，里面的一级区块照常领页面分来的序号入场。
// 等过加载才挂上的内容由这里整层淡入，里面的区块（Card、Banner 这类）不再领序号，免得各自再叠一层淡入、透明度相乘。
// 内容出现过之后再挂上的骨架同理。
//
// 骨架的尺寸要与内容一致。做不到一致时（条数由数据决定），高度差由外层的让位（lib/reflow）接住：
// 下面的内容滑到新位置，而不是跳过去。
// 重新加载时要不要留着旧内容，由调用方决定传进来的 view：这里只管怎么画。
//
// 内容层在退回加载前后的两条约定，写内容时要照顾到：
// - 退场的那一段（fade.out 的时长）里，旧内容层仍按最后一次求值的 children 渲染，不再调用 children 函数。层里直接订阅
//   store 的组件照样会随 store 重渲染，这时数据可能已经不在（被重新加载清空、换了请求），要容忍取不到；
//   数据尽量在 children 函数里取好、按 props 往下传，旧层里拿到的就是最后一次的值。
// - 退场还没播完内容又回来时，同一层接着用、子树不重挂：挂载时定下状态的组件（useState 的初值、只在挂载时读一次的东西）
//   不会因为这次重新加载而重置。需要每一轮都从头来的，由调用方给内容里的那一块加 key（例如按请求参数）。

import { AnimatePresence, motion, PresenceContext, useIsPresent, usePresence, type TargetAndTransition } from "framer-motion";
import { useContext, useEffect, useMemo, useState, type ReactNode, type Ref } from "react";
import type { LoadingView } from "../lib/loading-gate";
import { fade } from "../lib/motion";
import { REFLOW_SKIP_ATTR } from "../lib/reflow";
import { usePaintedOnce } from "../lib/usePaintedOnce";
import { cx } from "../lib/util";
import styles from "./Loadable.module.css";
import { EntranceGate } from "./Page";

export interface LoadableProps {
  view: LoadingView;
  /** 加载态的占位，尺寸照真实内容给。 */
  skeleton: ReactNode;
  /** 内容。写成函数：只在 view 为 content 时求值，加载期间数据还不在。 */
  children: () => ReactNode;
  /**
   * 读屏听到的加载说明。骨架层整层对读屏隐藏，骨架里写的「正在读取…」读屏听不到，要让读屏知道在加载就传这一句。
   * 传了就在根元素前面常驻一个视觉隐藏的 role="status" 播报区：先挂好、先空着，骨架显出来时才写进这句话，
   * 等待期内就读完的不播报，与看得见的骨架同一时机；内容到达后清空。不传时不多出任何节点。
   * 播报区插进来的那一次提交总是空的、挂上之后才写字，所以 Loadable 在骨架期才挂上（加载门在父组件里、晚挂的条件块），
   * 或者这句话在骨架期才传进来，也照样播报。
   * 播报区是根元素的兄弟，不在带 aria-busy 的根里：忙碌区域里的变化读屏可以攒到忙完再报，那时说明已经清空了。
   * 它绝对定位、不参与让位，所在的 flex / grid 不因它多一道间距；按 :first-child 这类位置选择器排布的父元素要算上它。
   */
  busyLabel?: string;
  /** 只用于布局。 */
  className?: string;
  /** 包住内容的那一层的类名，只用于布局：内容要撑满按高度分配的区域、自己滚动时，让这一层也参与分高。 */
  contentClassName?: string;
}

export function Loadable({ view, skeleton, children, busyLabel, className, contentClassName }: LoadableProps) {
  // 一挂上就是内容（数据早就在）：不单独淡入，跟着所在页面的入场走。见过加载态之后，内容每次出现都淡入
  const [waited, setWaited] = useState(view !== "content");
  if (view !== "content" && !waited) setWaited(true);
  // 内容出现过：之后再挂上的骨架从透明淡入，接住正在淡出的内容，而不是不透明地一下子盖上去
  const [hadContent, setHadContent] = useState(view === "content");
  if (view === "content" && !hadContent) setHadContent(true);
  // 骨架此刻可能还看得见：显出来过，而且退场还没播完。确实看不见的骨架（一直停在等待期，或上一次退场已经播完之后
  // 才挂上的），内容到达时连同它所在的 AnimatePresence 一起卸掉：退场只能经 AnimatePresence 播，卸掉宿主才能让它不播、
  // 同一次提交里就离开 DOM，而不是透明地在内容上多叠一段退场。
  // 退场播完时清掉；回到等待期时不立即清，等淡出走到 0 再清：退场途中被拉回等待期的骨架是从半透明往 0 走的，
  // 这时内容又到，卸掉宿主就是半透明时一帧消失；走到 0 之后不清，内容到达时又会带着 data-pending 多播一段看不见的退场
  const [shown, setShown] = useState(view === "skeleton");
  if (view === "skeleton" && !shown) setShown(true);
  const body = (
    <div className={cx(styles.loadable, className)} aria-busy={view === "content" ? undefined : true}>
      {/* 首次挂载时骨架里的区块不播页面入场：骨架此时多半还在等待期，页面根的淡入已经盖住它。之后才挂上的骨架要播自己的淡入 */}
      {(view !== "content" || shown) && (
        <AnimatePresence mode="popLayout" initial={hadContent} onExitComplete={() => setShown(false)}>
          {view !== "content" && (
            <SkeletonLayer key="skeleton" pending={view === "pending"} fadeIn={hadContent} onHidden={() => setShown(false)}>
              {skeleton}
            </SkeletonLayer>
          )}
        </AnimatePresence>
      )}
      {/* 进出不牵动兄弟的布局（让位交给 lib/reflow）：关掉 presenceAffectsLayout，内容层的在场上下文才不会随每次重渲染换新，
          连带内容里所有 motion 元素跟着重渲染 */}
      <AnimatePresence mode="popLayout" presenceAffectsLayout={false}>
        {view === "content" && (
          <ContentLayer key="content" waited={waited} className={cx(styles.content, contentClassName)}>
            {children()}
          </ContentLayer>
        )}
      </AnimatePresence>
    </div>
  );
  return (
    <>
      {/* 播报区与根元素各占片段里固定的一格：busyLabel 中途有无变化时根元素不重挂 */}
      {busyLabel !== undefined && <BusyStatus text={view === "skeleton" ? busyLabel : ""} />}
      {body}
    </>
  );
}

/**
 * 加载说明的播报区。主流读屏只播报已在场的 role="status" 里的变化，带着文字插进来的一般不报，
 * 所以挂上的那一次提交不写字，挂上之后再写。是否已挂上跟着播报区自己，不跟着 Loadable：busyLabel 晚传进来时它才挂上。
 */
function BusyStatus({ text }: { text: string }) {
  const [armed, setArmed] = useState(false);
  useEffect(() => setArmed(true), []);
  return (
    <span className="sk-sr-only" role="status" {...{ [REFLOW_SKIP_ATTR]: "" }}>
      {armed ? text : ""}
    </span>
  );
}

/** 骨架层淡出的目标。第一个关键帧取当前值：停在哪都建得出一段动画、播完时报完成，据此放它离开。 */
const SKELETON_LEAVE: TargetAndTransition = { opacity: [null, 0], transition: fade.out };
const registerNothing = () => () => {};

interface SkeletonLayerProps {
  /** popLayout 把退场的骨架抽出布局时要量这一层，由 AnimatePresence 递进来。 */
  ref?: Ref<HTMLDivElement>;
  /** 等待期：占着位但看不见。 */
  pending: boolean;
  /** 内容出现过之后才挂上的骨架：从透明淡入，里面的区块不再领页面入场序号。只在挂载那一刻读。 */
  fadeIn: boolean;
  /** 等待期里淡到 0 了。 */
  onHidden: () => void;
  children: ReactNode;
}

/**
 * 骨架层。内容到达时它照常在那次提交里脱离布局（popLayout 看的是在不在场，不看动画），淡出却等第一帧画出来才开始，
 * 与停在透明、同样等这一帧的内容层同一刻起步。数据到达那次提交往往很长，淡出要是在提交里就建、从建的那一刻计时，
 * 第一帧画出来时骨架已淡掉一截而内容还没开始，两层之间露出一段空白。
 * framer-motion 的 exit 在在场变化的那次提交里就建，推迟不了，所以这一层的去留由 usePresence 自己管：放行之后换成淡出的目标，
 * 播完再告诉 AnimatePresence 可以移除。里面的 motion 元素拿到一份始终在场、不登记退场的在场上下文，不各自响应退场：
 * 各自的退场一下就报完，回到在场时 framer-motion 会把报完的元素跳回 initial，退场途中被拉回的骨架就会一帧变透明。
 * 外层的 initial 照传：首次挂载时骨架里的区块仍不播入场。
 */
function SkeletonLayer({ ref, pending, fadeIn, onHidden, children }: SkeletonLayerProps) {
  const outer = useContext(PresenceContext);
  const [present, safeToRemove] = usePresence();
  const leave = usePaintedOnce(present ? "present" : "leaving", !present) && !present;
  const inner = useMemo(
    () => (outer === null ? null : { id: outer.id, initial: outer.initial, custom: outer.custom, isPresent: true, register: registerNothing }),
    [outer],
  );
  return (
    <PresenceContext.Provider value={inner}>
      <motion.div
        ref={ref}
        className={styles.skeleton}
        data-pending={pending || undefined}
        aria-hidden="true"
        initial={fadeIn ? { opacity: 0 } : false}
        // 等待期占着位但看不见。用透明度而不是 visibility：到了该出现的时刻骨架是淡入的
        animate={leave ? SKELETON_LEAVE : { opacity: pending ? 0 : 1, transition: fade.in }}
        // 被新目标打断的动画不报完成（framer-motion 停掉它时不结清它的 promise）：报完成的淡出就是播完了；
        // 其余报完成、又在等待期的只会是走到 0 的那一段，退场放行之前走到的也一样，这时它已经看不见
        onAnimationComplete={(definition) => {
          if (definition === SKELETON_LEAVE) safeToRemove?.();
          else if (pending) onHidden();
        }}
      >
        <EntranceGate own={fadeIn}>{children}</EntranceGate>
      </motion.div>
    </PresenceContext.Provider>
  );
}

interface ContentLayerProps {
  /** popLayout 把退场的内容抽出布局时要量这一层，由 AnimatePresence 递进来。 */
  ref?: Ref<HTMLDivElement>;
  /** 等过加载才挂上：整层自己淡入，里面的区块不再领页面入场序号。只在挂载那一刻读。 */
  waited: boolean;
  className: string;
  children: ReactNode;
}

/** 等过加载的内容层先停在这里。与 initial 是同一个对象：挂载时 framer-motion 认出起点与目标相同，不建一段 0 到 0 的动画。 */
const LAYER_HIDDEN = { opacity: 0 } as const;
const LAYER_SHOWN = { opacity: 1, transition: fade.in } as const;

/**
 * 内容层。退回加载时它脱离布局、叠在骨架上淡出，这一段带 inert：点不到、聚焦不到，读屏也不再读它，
 * 按选择器找内容的代码与测试用 :not([inert]) 排除它。淡完之前内容又回来时，同一层接着用、淡回不透明。
 * 等过加载才挂上的这一层停在透明，画出第一帧之后才淡入（usePaintedOnce）：数据到达那次提交往往很长，
 * 从提交就计时的话第一帧画出来时淡入已走掉一截。停在透明时就退回加载的，退场目标与当前值相同、也没有动画在走，
 * framer-motion 不建退场，这一层随即移除：它本来就看不见。
 */
function ContentLayer({ ref, waited, className, children }: ContentLayerProps) {
  const present = useIsPresent();
  // 冻结挂载那一刻的值：一挂上就是内容的这一层，退回加载、淡完之前又被接着用时 waited 已经为真，不能因此退回透明再等一帧
  const [entering] = useState(waited);
  const painted = usePaintedOnce("content", entering);
  return (
    <motion.div ref={ref} className={className} inert={!present} initial={entering ? LAYER_HIDDEN : false} animate={painted ? LAYER_SHOWN : LAYER_HIDDEN} exit={{ opacity: 0, transition: fade.out }}>
      <EntranceGate own={waited}>{children}</EntranceGate>
    </motion.div>
  );
}
