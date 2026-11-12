// 加载态与内容态的容器：把加载门（lib/loading-gate）的三种状态画成不发生位移的样子。
//
// - pending：占位（骨架）照常占着尺寸但不可见。请求很快回来时界面不闪，也不会先是 0 高、数据一到再撑开。
//   内容在这段时间里到达时，骨架同一帧直接拿掉：它本来就看不见，不播退场。上一段显出来过、退场没播完就被拉回等待期的骨架
//   不算在内：它正从半透明往 0 走，这时内容到达照常播退场，不在半透明时一帧消失。
// - skeleton：骨架淡入。
// - content：内容淡入；骨架同时淡出，这时它已经脱离布局、叠在内容上，容器立即取内容的尺寸。
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

import { AnimatePresence, motion, useIsPresent } from "framer-motion";
import { useState, type ReactNode, type Ref } from "react";
import type { LoadingView } from "../lib/loading-gate";
import { fade } from "../lib/motion";
import { REFLOW_SKIP_ATTR } from "../lib/reflow";
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
  // 只在退场播完时清掉，回到等待期时不清：退场途中被拉回等待期的骨架是从半透明往 0 走的，这时内容又到，卸掉宿主就是半透明时一帧消失
  const [shown, setShown] = useState(view === "skeleton");
  if (view === "skeleton" && !shown) setShown(true);
  const body = (
    <div className={cx(styles.loadable, className)} aria-busy={view === "content" ? undefined : true}>
      {/* 首次挂载时骨架里的区块不播页面入场：骨架此时多半还在等待期，页面根的淡入已经盖住它。之后才挂上的骨架要播自己的淡入 */}
      {(view !== "content" || shown) && (
        <AnimatePresence mode="popLayout" initial={hadContent} onExitComplete={() => setShown(false)}>
          {view !== "content" && (
            <motion.div
              key="skeleton"
              className={styles.skeleton}
              data-pending={view === "pending" || undefined}
              aria-hidden="true"
              initial={hadContent ? { opacity: 0 } : false}
              // 等待期占着位但看不见。用透明度而不是 visibility：到了该出现的时刻骨架是淡入的
              animate={{ opacity: view === "pending" ? 0 : 1, transition: fade.in }}
              exit={{ opacity: 0, transition: fade.out }}
            >
              <EntranceGate own={hadContent}>{skeleton}</EntranceGate>
            </motion.div>
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
      {busyLabel !== undefined && (
        <span className={styles.status} role="status" {...{ [REFLOW_SKIP_ATTR]: "" }}>
          {view === "skeleton" ? busyLabel : ""}
        </span>
      )}
      {body}
    </>
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

/**
 * 内容层。退回加载时它脱离布局、叠在骨架上淡出，这一段带 inert：点不到、聚焦不到，读屏也不再读它，
 * 按选择器找内容的代码与测试用 :not([inert]) 排除它。淡完之前内容又回来时，同一层接着用、淡回不透明。
 */
function ContentLayer({ ref, waited, className, children }: ContentLayerProps) {
  const present = useIsPresent();
  return (
    <motion.div ref={ref} className={className} inert={!present} initial={waited ? { opacity: 0 } : false} animate={{ opacity: 1, transition: fade.in }} exit={{ opacity: 0, transition: fade.out }}>
      <EntranceGate own={waited}>{children}</EntranceGate>
    </motion.div>
  );
}
