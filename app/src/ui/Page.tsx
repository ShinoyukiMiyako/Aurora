// 页面根：内边距、区块间距与最大宽，以及新页面的入场。
//
// 入场：根元素淡入；一级区块（Page 与 Bento 的直接子项）上移淡入，并按序号错开。
// 区块组件（PageHeader、Card、Banner）经 EntranceBlock 认领自己的序号；Bento 不动自己，只把序号转交给子项。
// 认领之后子树里的序号被清空，嵌套在区块里的组件不会再动第二次。
// 减少动画时只保留根的淡入：没有位移，也没有错开（错开的延迟会让透明度淡入看起来像卡顿）。
// 页面按路由键重新挂载，所以挂载即入场；同一路由键内的变化不会重播。

import { motion, useReducedMotionConfig, type Variants } from "framer-motion";
import { Children, createContext, createElement, isValidElement, useContext, type ElementType, type HTMLAttributes, type ReactNode } from "react";
import { fade, pageItem } from "../lib/motion";
import { cx } from "../lib/util";
import styles from "./Page.module.css";

const EntranceContext = createContext<number | null>(null);

const pageRoot: Variants = {
  hidden: { opacity: 0 },
  show: { opacity: 1, transition: fade.in },
};

/** 一级区块挂到 motion 元素上的属性；data-entrance 方便在开发者工具里核对序号。 */
export interface PageEntrance {
  variants: Variants;
  custom: number;
  "data-entrance": number;
}

/** 当前位置分到的入场序号；不在页面一级区块位置上时为 null。 */
export function useEntranceIndex(): number | null {
  return useContext(EntranceContext);
}

/** 一级区块要挂的入场属性；不参与入场（不在一级位置、或减少动画）时为 null。 */
export function usePageEntrance(): PageEntrance | null {
  const index = useContext(EntranceContext);
  const reduced = useReducedMotionConfig() === true;
  if (index === null || reduced) return null;
  return { variants: pageItem, custom: index, "data-entrance": index };
}

/** 清空子树的入场序号。 */
export function EntranceBoundary({ children }: { children: ReactNode }) {
  return <EntranceContext.Provider value={null}>{children}</EntranceContext.Provider>;
}

/** 给一组子项从 start 起依次编号；start 为 null 时子项都不参与入场。 */
export function numberEntrance(children: ReactNode, start: number | null): ReactNode {
  if (start === null) return <EntranceBoundary>{children}</EntranceBoundary>;
  return Children.toArray(children).map((child, i) => (
    <EntranceContext.Provider key={isValidElement(child) && child.key !== null ? child.key : i} value={start + i}>
      {child}
    </EntranceContext.Provider>
  ));
}

export type EntranceTag = "div" | "header" | "section" | "article" | "li";

const MOTION_TAG: Readonly<Record<EntranceTag, ElementType>> = {
  div: motion.div,
  header: motion.header,
  section: motion.section,
  article: motion.article,
  li: motion.li,
};

export interface EntranceBlockProps extends HTMLAttributes<HTMLElement> {
  as?: EntranceTag;
  [data: `data-${string}`]: string | number | boolean | undefined;
}

/**
 * 可参与入场的区块元素：分到序号时渲染成 motion 元素，否则是普通元素。
 * 入场只动 transform 与 opacity，组件自己的悬停位移改用独立的 translate / scale 属性，两者叠加互不覆盖。
 */
export function EntranceBlock({ as = "div", children, ...rest }: EntranceBlockProps) {
  const entrance = usePageEntrance();
  const inner = <EntranceBoundary>{children}</EntranceBoundary>;
  if (entrance === null) return createElement(as, rest, inner);
  return createElement(MOTION_TAG[as], { ...rest, ...entrance }, inner);
}

export interface PageProps {
  /** narrow：表单型页面（账户、设置）的最大宽，左对齐。 */
  width?: "full" | "narrow";
  /**
   * 页面高度锁定为内容区高度，外层不再滚动，由页面内部安排滚动区（日志控制台、长表格）。
   * 默认随内容变高，由外壳的页面滚动容器负责滚动。
   */
  fill?: boolean;
  /** 指向页头标题的 id，给页面根命名。 */
  "aria-labelledby"?: string;
  className?: string;
  children: ReactNode;
}

export function Page({ width = "full", fill = false, className, children, ...aria }: PageProps) {
  return (
    <motion.div
      className={cx(styles.page, className)}
      data-width={width}
      data-fill={fill || undefined}
      aria-labelledby={aria["aria-labelledby"]}
      initial="hidden"
      animate="show"
      variants={pageRoot}
    >
      {numberEntrance(children, 0)}
    </motion.div>
  );
}
