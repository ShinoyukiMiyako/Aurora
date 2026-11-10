// 页面根：内边距、区块间距与最大宽，以及新页面的入场。
//
// 入场：根元素淡入；一级区块（Page 与 Bento 的直接子项）上移淡入，并按序号错开。
// 区块组件（PageHeader、Card、Banner）经 EntranceBlock 认领自己的序号；Bento 不动自己，把序号转交给子项，
// 并按子项数占号，排在它后面的区块接着往下编，错开始终自上而下。认领之后子树里的序号被清空，嵌套在区块里的组件不会再动第二次。
// 页面怎么来的决定入场，由外壳经 PageArrivalProvider 告诉页面：
// - enter（侧栏、链接、命令面板）：根淡入加区块错开。
// - return（后退、前进）：回到看过的位置，只有根淡入，不重播区块的上移与错开。
// - still（应用启动的那一屏）：窗口显示时就是成品，什么都不播。
// 减少动画时只保留根的淡入：没有位移，也没有错开（错开的延迟会让透明度淡入看起来像卡顿）。
// 入场只属于页面挂上的第一帧：之后才挂上的一级区块（换搜索结果、数据晚到、窗口跨档换位）只淡入，不位移也不等序号延迟。
// 页面按路由键重新挂载，所以挂载即入场；同一路由键内的变化不会重播。

import { motion, useReducedMotionConfig, type MotionProps, type Variants } from "framer-motion";
import { Children, createContext, createElement, isValidElement, useContext, useEffect, useState, type ElementType, type HTMLAttributes, type ReactNode } from "react";
import { fade, pageItem } from "../lib/motion";
import { useReflow } from "../lib/reflow";
import { cx } from "../lib/util";
import styles from "./Page.module.css";

const EntranceContext = createContext<number | null>(null);

/**
 * 导航锚点：页面里标签条、分区导航所在的那一行。同一页换标签或分区时，它已滚出视口上方，外壳就瞬时滚回它，
 * 新面板从头看起。一页至多一个；吸顶的导航把吸顶的 top 写成锚点的 scroll-margin-top。
 * 锚点必须在文档流里：标在吸顶导航外层不吸顶的那一行（设置页的分区布局、实例页标签条外面那一行），
 * 不能是吸顶元素本身，也不能在吸顶元素里面。吸住时量到的是吸住的位置，滚回永远不会触发，外壳遇到会直接报错。
 */
export const NAV_ANCHOR_ATTR = "data-nav-anchor";

/** 页面是怎么来的：enter 新进入，return 后退前进回到看过的位置，still 应用启动的那一屏。 */
export type PageArrival = "enter" | "return" | "still";

const ArrivalContext = createContext<PageArrival>("enter");

/** 外壳告诉接下来挂载的页面它是怎么来的；页面只在挂载那一刻读一次。 */
export function PageArrivalProvider({ value, children }: { value: PageArrival; children: ReactNode }) {
  return <ArrivalContext.Provider value={value}>{children}</ArrivalContext.Provider>;
}

/** 一个页面的入场窗口。对象随页面建一次，第一帧画完时把 settled 置上，引用不变，不牵动任何重渲染。 */
interface EntranceStage {
  /** 一级区块按序号错开上移（新进入的页面）。 */
  stagger: boolean;
  /** 页面挂上之后的第一帧已经过去。 */
  settled: boolean;
}

const StageContext = createContext<EntranceStage | null>(null);

const pageRoot: Variants = {
  hidden: { opacity: 0 },
  show: { opacity: 1, transition: fade.in },
};

/** 一级区块挂到 motion 元素上的入场属性；data-entrance 方便在开发者工具里核对序号。 */
type EntranceProps = MotionProps & { "data-entrance"?: number };

/** 入场窗口过去之后才挂上的一级区块：原地淡入，没有位移，也不按序号等。 */
const LATE_ENTRANCE: EntranceProps = { initial: { opacity: 0 }, animate: { opacity: 1, transition: fade.in } };

/** 当前位置分到的入场序号；不在页面一级区块位置上时为 null。 */
export function useEntranceIndex(): number | null {
  return useContext(EntranceContext);
}

/** 清空子树的入场序号。 */
export function EntranceBoundary({ children }: { children: ReactNode }) {
  return <EntranceContext.Provider value={null}>{children}</EntranceContext.Provider>;
}

/**
 * 子树自己播入场（Appear 的增删动画）时清空序号，里面的区块不再叠一层页面淡入。
 * own 只在挂载那一刻读：挂载时就在、跟着页面入场走的子项，之后也一直跟着页面。
 */
export function EntranceGate({ own, children }: { own: boolean; children: ReactNode }) {
  const inherited = useContext(EntranceContext);
  const [claimed] = useState(own);
  // 始终是同一个 Provider：只换取值，不换结构，里面已经挂着的子树不会因此重建
  return <EntranceContext.Provider value={claimed ? null : inherited}>{children}</EntranceContext.Provider>;
}

/** 把序号转交给子项的组件（Bento）：按它的属性算出要占几个号。组件函数为键。 */
const spreaders = new WeakMap<object, (props: never) => number>();

/** 登记一个把入场序号转交给子项的组件：页面编号时它占 span(props) 个号，排在它后面的区块接着往下编。 */
export function spreadsEntrance<P>(component: (props: P) => ReactNode, span: (props: P) => number): void {
  spreaders.set(component, span as (props: never) => number);
}

function entranceSpan(child: ReactNode): number {
  if (!isValidElement(child)) return 1;
  const span = spreaders.get(child.type as object);
  return span === undefined ? 1 : (span as (props: unknown) => number)(child.props);
}

/** 给一组子项从 start 起依次编号；start 为 null 时子项都不参与入场。 */
export function numberEntrance(children: ReactNode, start: number | null): ReactNode {
  if (start === null) return <EntranceBoundary>{children}</EntranceBoundary>;
  let next = start;
  return Children.toArray(children).map((child, i) => {
    const index = next;
    next += entranceSpan(child);
    return (
      <EntranceContext.Provider key={isValidElement(child) && child.key !== null ? child.key : i} value={index}>
        {child}
      </EntranceContext.Provider>
    );
  });
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

/** 这一块挂载时该怎么入场；不参与时为 null。 */
function entranceOf(index: number | null, stage: EntranceStage | null, reduced: boolean): EntranceProps | null {
  if (index === null || stage === null) return null;
  if (stage.settled) return LATE_ENTRANCE;
  if (!stage.stagger || reduced) return null;
  return { variants: pageItem, custom: index, "data-entrance": index };
}

/**
 * 自己另有切换动画的区块（标签面板）挂载时问页面这一次怎么入场，只读一次：
 * - 入场属性：站在一级位置、赶上了首帧，页面在错开入场，照页面分的序号走；
 * - "still"：站在一级位置、赶上了首帧，但页面这一次不播区块入场（后退前进、启动那一屏、减少动画只留根淡入），区块直接是成品；
 * - null：不归页面管（嵌套在区块里，或首帧之后才挂上），区块播自己的。
 */
export function usePageEntrance(): EntranceProps | "still" | null {
  const index = useContext(EntranceContext);
  const stage = useContext(StageContext);
  const reduced = useReducedMotionConfig() === true;
  const [entrance] = useState<EntranceProps | "still" | null>(() => {
    if (index === null || stage === null || stage.settled) return null;
    if (!stage.stagger || reduced) return "still";
    return { variants: pageItem, custom: index, "data-entrance": index };
  });
  return entrance;
}

/**
 * 可参与入场的区块元素。元素类型与怎么入场都在挂载那一刻定下，之后不再变：
 * 中途开关减少动画、入场窗口过去，已经在的区块都不会换元素类型（那会让整块子树重建，开关拇指跳位、焦点丢失），也不会重播。
 * 类型只看挂载时站没站在页面一级位置上，与减少动画无关：站在一级位置上的始终是 motion 元素；
 * 嵌套在区块里、列表里的（每张结果卡、实例卡）是普通元素，不为每张卡多建一套 motion 状态与投影节点。
 * 入场只动 transform 与 opacity，组件自己的悬停位移改用独立的 translate / scale 属性，两者叠加互不覆盖。
 */
export function EntranceBlock({ as = "div", children, ...rest }: EntranceBlockProps) {
  const index = useContext(EntranceContext);
  const stage = useContext(StageContext);
  const reduced = useReducedMotionConfig() === true;
  const [tag] = useState<ElementType>(() => (index !== null && stage !== null ? MOTION_TAG[as] : as));
  const [entrance] = useState(() => entranceOf(index, stage, reduced));
  return createElement(tag, entrance === null ? rest : { ...rest, ...entrance }, <EntranceBoundary>{children}</EntranceBoundary>);
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
  // 一级区块互相让位：某一块的数据晚到、变高，下面各块滑过去而不是一帧跳下去
  const reflow = useReflow<HTMLDivElement>();
  const arrival = useContext(ArrivalContext);
  const [still] = useState(arrival === "still");
  const [stage] = useState<EntranceStage>(() => ({ stagger: arrival === "enter", settled: false }));
  useEffect(() => {
    // 第一帧之内挂上的区块（含挂载后同步补渲染的）都算首屏，跟着页面入场；之后挂上的只淡入
    const frame = requestAnimationFrame(() => {
      stage.settled = true;
    });
    return () => cancelAnimationFrame(frame);
  }, [stage]);
  return (
    <StageContext.Provider value={stage}>
      <motion.div
        ref={reflow}
        className={cx(styles.page, className)}
        data-width={width}
        data-fill={fill || undefined}
        aria-labelledby={aria["aria-labelledby"]}
        initial={still ? false : "hidden"}
        animate="show"
        variants={pageRoot}
      >
        {numberEntrance(children, 0)}
      </motion.div>
    </StageContext.Provider>
  );
}
