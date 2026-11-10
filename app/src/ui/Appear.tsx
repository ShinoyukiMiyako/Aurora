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

import { AnimatePresence, motion, useIsPresent } from "framer-motion";
import { Children, isValidElement, type ReactNode, type Ref } from "react";
import { useInsertItem } from "../lib/useInsertItem";
import { useMounted } from "../lib/useMounted";
import { EntranceGate, spreadsEntrance } from "./Page";

export interface AppearProps {
  children: ReactNode;
  /** 包在每个子项外面的那层元素的类名，只用于布局。 */
  itemClassName?: string;
  /** 挂载时已经在的子项也播入场。默认不播：它们跟着所在页面的入场走。 */
  initial?: boolean;
}

interface AppearItemProps {
  /** popLayout 把退场项抽出布局时要量这一层，由 AnimatePresence 递进来。 */
  ref?: Ref<HTMLDivElement>;
  /** 这一项自己播入场（Appear 挂载之后才出现的）。 */
  own: boolean;
  className?: string;
  children: ReactNode;
}

function AppearItem({ ref, own, className, children }: AppearItemProps) {
  const present = useIsPresent();
  // 减少动画时只留透明度：缩放在那里是一步到位的，退场会先缩一下再淡出
  const item = useInsertItem();
  return (
    <motion.div ref={ref} className={className} inert={!present} initial={own ? item.initial : false} animate={item.animate} exit={item.exit}>
      <EntranceGate own={own}>{children}</EntranceGate>
    </motion.div>
  );
}

export function Appear({ children, itemClassName, initial = false }: AppearProps) {
  // 挂载时就在的子项不播入场。不能用 AnimatePresence 的 initial={false} 来做：它会让这些子项里面
  // 之后才挂载的元素也永远跳过入场。这里只在包裹层自己身上关掉。
  const mounted = useMounted();
  const own = mounted.current || initial;
  return (
    <AnimatePresence mode="popLayout">
      {Children.toArray(children).map((child, index) => (
        <AppearItem key={isValidElement(child) && child.key !== null ? child.key : index} own={own} className={itemClassName}>
          {child}
        </AppearItem>
      ))}
    </AnimatePresence>
  );
}

// 作为 Page 或 Bento 的直接子项时：空的不占入场序号，下面的区块不该为一个什么都没有的块晚一拍。
// 有子项时只占一个号，几个子项一起入场。与 numberEntrance 同样按 Children.toArray 计数：false、null、undefined、空数组都算空
spreadsEntrance(Appear, (props: AppearProps) => (Children.toArray(props.children).length > 0 ? 1 : 0));
