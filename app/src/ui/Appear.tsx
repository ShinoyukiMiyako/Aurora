// 条件出现的块：提示条、警告、校验错误、开关联动出现的选项这类「有时在、有时不在」的内容。
//
// 出现时淡入并从略小处落到位，消失时淡出并立即脱离布局。它只管自己的入场与退场；被它挤开的兄弟怎么动，
// 交给所在容器的让位（lib/reflow 的 useReflow，页面一级区块与卡片网格已经自带）。
//
// 用法：把条件渲染原样写在里面，假值会被丢掉。多个子项各自进出，要给稳定的 key。
//   <Appear>{warning !== null && <Callout tone="warn">{warning}</Callout>}</Appear>
//
// 每个子项外面包了一层元素，它才是所在 flex / grid 里的那一项；需要撑满或对齐时用 itemClassName。
// 退场中的那一层带 inert：它已经让出位置、叠在顶上来的兄弟上面淡出，点不到、聚焦不到，读屏也不再读它。
// 按选择器找子项的代码与测试用 :not([inert]) 排除它（列表行的退场也是这个约定）。
// 放在页面一级区块的位置上时：挂载时就在的子项跟着页面入场；之后出现的子项由这里淡入，里面的区块不再叠一层页面淡入。
// 空的时候不占入场序号，有子项时占一个。

import { AnimatePresence, motion, useIsPresent, usePresenceData, type TargetAndTransition, type Transition } from "framer-motion";
import { Children, isValidElement, useState, type ReactNode, type Ref } from "react";
import { useInsertItem, type InsertMotion } from "../lib/useInsertItem";
import { useMounted } from "../lib/useMounted";
import { usePaintedOnce } from "../lib/usePaintedOnce";
import { EntranceGate, spreadsEntrance } from "./Page";

export interface AppearProps {
  children: ReactNode;
  /** 包在每个子项外面的那层元素的类名，只用于布局。 */
  itemClassName?: string;
  /** 挂载时已经在的子项也播入场。默认不播：它们跟着所在页面的入场走。 */
  initial?: boolean;
  /**
   * 还没开始入场的子项画出第一帧之后再等这么多秒才起步，透明度与缩放一起晚：它出现的地方还有别的内容正在让开，
   * 等让开了再淡入，不半透明地叠在上面。入场起步之后再改它不影响已经在走的入场。
   */
  enterDelay?: number;
  /**
   * 这一次渲染里撤掉的子项改用这条退场过渡。例如 fade.none：同一次变化里后面的内容已经整批换掉、排到了它的位置上，
   * 原地淡出会半透明地叠在新内容上。不给时照常原地淡出。
   */
  exitTransition?: Transition;
}

interface AppearItemProps {
  /** popLayout 把退场项抽出布局时要量这一层，由 AnimatePresence 递进来。 */
  ref?: Ref<HTMLDivElement>;
  /** 这一项自己播入场（Appear 挂载之后才出现的）。 */
  own: boolean;
  enterDelay?: number;
  className?: string;
  children: ReactNode;
}

/** 入场目标的过渡整体晚 delay 秒：按值写的透明度过渡也带上同一个延迟，不靠 motion-dom 从根上继承。 */
function delayed(animate: InsertMotion["animate"], delay: number): TargetAndTransition {
  const { transition } = animate;
  return { ...animate, transition: "opacity" in transition ? { ...transition, delay, opacity: { ...transition.opacity, delay } } : { ...transition, delay } };
}

function AppearItem({ ref, own, enterDelay, className, children }: AppearItemProps) {
  const present = useIsPresent();
  // 撤掉的子项还按撤掉之前那次渲染的属性画，收不到 Appear 这一次给的 exitTransition：它经 AnimatePresence 的 custom 递进来，
  // 在场与否变了的那次渲染里取到的就是撤掉那一次给的值
  const exitTransition = usePresenceData() as Transition | undefined;
  // 减少动画时只留透明度：缩放在那里是一步到位的，退场会先缩一下再淡出
  const item = useInsertItem();
  // 冻结挂载那一刻的值：Appear 挂载之后每次渲染给的 own 都为真，挂载时就在的子项不能因此退回起点
  const [entering] = useState(own);
  // 自己入场的先停在起点，画出第一帧之后才落到位：数据到达那次提交往往很长，从提交就计时的话第一帧画出来时入场已走掉一截。
  // 停着的目标与 initial 是同一个对象，挂载时 framer-motion 不建一段原地不动的动画。
  // 停着时就撤掉的子项（还没画出来过）与退场目标相同、也没有动画在走，framer-motion 不建退场，它随即移除：本来就看不见
  const painted = usePaintedOnce("item", entering);
  // 延迟取放行那一刻的值：调用方要等挂载之后量过布局才知道等多久，量完的那次重渲染排在放行之前
  const target = entering && enterDelay !== undefined ? delayed(item.animate, enterDelay) : item.animate;
  return (
    <motion.div
      ref={ref}
      className={className}
      inert={!present}
      initial={entering ? item.initial : false}
      animate={painted ? target : item.initial}
      exit={exitTransition === undefined ? item.exit : { ...item.exit, transition: exitTransition }}
    >
      <EntranceGate own={own}>{children}</EntranceGate>
    </motion.div>
  );
}

export function Appear({ children, itemClassName, initial = false, enterDelay, exitTransition }: AppearProps) {
  // 挂载时就在的子项不播入场。不能用 AnimatePresence 的 initial={false} 来做：它会让这些子项里面
  // 之后才挂载的元素也永远跳过入场。这里只在包裹层自己身上关掉。
  const mounted = useMounted();
  const own = mounted.current || initial;
  return (
    <AnimatePresence mode="popLayout" custom={exitTransition}>
      {Children.toArray(children).map((child, index) => (
        <AppearItem key={isValidElement(child) && child.key !== null ? child.key : index} own={own} enterDelay={enterDelay} className={itemClassName}>
          {child}
        </AppearItem>
      ))}
    </AnimatePresence>
  );
}

// 作为 Page 或 Bento 的直接子项时：空的不占入场序号，下面的区块不该为一个什么都没有的块晚一拍。
// 有子项时只占一个号，几个子项一起入场。与 numberEntrance 同样按 Children.toArray 计数：false、null、undefined、空数组都算空
spreadsEntrance(Appear, (props: AppearProps) => (Children.toArray(props.children).length > 0 ? 1 : 0));
