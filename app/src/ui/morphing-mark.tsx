// 会形变的面板（Modal、Popover）给滚动主体打的「形变中」标记。外框的形变是 framer-motion 的布局动画（transform 缩放），
// 途中主体里的内容会越出主体的布局框，主体照常滚动的话就冒出一下滚动条、挤窄内容；样式表凭这个标记让主体途中不滚动。

import { MotionContext } from "framer-motion";
import { useContext, useEffect, type RefObject } from "react";

/** 主体在形变途中带的标记。 */
const MORPHING_ATTR = "data-morphing";

export interface MorphingMarkProps {
  /** 打标记的主体。 */
  target: RefObject<HTMLElement | null>;
  /**
   * 每次形变开始时判断这一次打不打，不传就总是打。判断的时刻布局刚被形变量过一遍，读布局是干净的。
   * 传模块级的函数：它换了引用就要重挂监听。
   */
  when?: (target: HTMLElement) => boolean;
}

/**
 * 跟着所在 motion 元素的布局投影节点，形变开始时给主体打上标记、结束时去掉。渲染为空：放在哪个 motion 元素里，
 * 跟的就是哪个元素的形变。
 * 读的是投影节点的 animationStart 与 animationComplete：形变被窗口缩放或下一次测量提前收尾时不会调
 * onLayoutAnimationComplete，标记会一直留着、主体再也滚不动；投影节点的这两个事件在这些情况下也成对。
 */
export function MorphingMark({ target, when }: MorphingMarkProps) {
  const { visualElement } = useContext(MotionContext);
  // 不用布局副作用：它排在主体之前、或就在主体里面先于主体挂 ref 运行，那时主体的 ref 还是空的。
  // 形变只会在之后的提交里开始，而 React 在下一次提交之前一定先跑完这次的普通副作用
  useEffect(() => {
    const el = target.current;
    const node = visualElement?.projection;
    if (el === null || node === undefined) throw new Error("形变的主体没有挂上，或所在的元素没有布局投影节点");
    const offStart = node.addEventListener("animationStart", () => {
      if (when === undefined || when(el)) el.setAttribute(MORPHING_ATTR, "");
    });
    const offComplete = node.addEventListener("animationComplete", () => el.removeAttribute(MORPHING_ATTR));
    return () => {
      offStart();
      offComplete();
    };
  }, [visualElement, target, when]);
  return null;
}
