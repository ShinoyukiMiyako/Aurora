// 条件出现的块：提示条、警告、校验错误、开关联动出现的选项这类「有时在、有时不在」的内容。
//
// 出现时淡入并从略小处落到位，消失时淡出并立即脱离布局。它只管自己的入场与退场；被它挤开的兄弟怎么动，
// 交给所在容器的让位（lib/reflow 的 useReflow，页面一级区块与卡片网格已经自带）。
//
// 用法：把条件渲染原样写在里面，假值会被丢掉。多个子项各自进出，要给稳定的 key。
//   <Appear>{warning !== null && <Callout tone="warn">{warning}</Callout>}</Appear>
//
// 每个子项外面包了一层元素，它才是所在 flex / grid 里的那一项；需要撑满或对齐时用 itemClassName。

import { AnimatePresence, motion } from "framer-motion";
import { Children, isValidElement, useEffect, useRef, type ReactNode } from "react";
import { insertItem } from "../lib/motion";

export interface AppearProps {
  children: ReactNode;
  /** 包在每个子项外面的那层元素的类名，只用于布局。 */
  itemClassName?: string;
  /** 挂载时已经在的子项也播入场。默认不播：它们跟着所在页面的入场走。 */
  initial?: boolean;
}

export function Appear({ children, itemClassName, initial = false }: AppearProps) {
  // 挂载时就在的子项不播入场。不能用 AnimatePresence 的 initial={false} 来做：它会让这些子项里面
  // 之后才挂载的元素也永远跳过入场。这里只在包裹层自己身上关掉。
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
  }, []);
  return (
    <AnimatePresence mode="popLayout">
      {Children.toArray(children).map((child, index) => (
        <motion.div
          key={isValidElement(child) && child.key !== null ? child.key : index}
          className={itemClassName}
          initial={mounted.current || initial ? insertItem.initial : false}
          animate={insertItem.animate}
          exit={insertItem.exit}
        >
          {child}
        </motion.div>
      ))}
    </AnimatePresence>
  );
}
