// 一格里换内容：登录的种类、设备码的各个状态面、外置登录的各步、离线立绘。
// 新内容入场，旧内容脱离布局、叠在原处淡出，退场期间带 inert（点不到、聚焦不到，按选择器找内容时用 :not([inert]) 排除）。
// 这一格变高变矮由所在弹窗的面板形变接住（Modal 自带，前提是换内容经过了渲染 Modal 的那一层）。
// 挂载时就在的内容不单独入场，跟着弹窗的入场走。
//
// 外面包一层定位元素：退场项被抽出布局时按它定位。不能让它以弹窗面板为基准：面板形变期间主体带着 transform，
// 绝对定位的基准会中途换成主体，淡出中的旧内容跳一下。

import { AnimatePresence, motion, useIsPresent, type Variants } from "framer-motion";
import { useEffect, useLayoutEffect, useRef, type ReactNode, type Ref } from "react";
import { fade, tabPanel, type PanelFrom } from "../../lib/motion";
import { cx } from "../../lib/util";
import styles from "./login.module.css";

/** 只换样子、不换东西（同一个角色换皮肤）：原地交叉淡化，不位移。 */
const STILL: Variants = {
  hidden: { opacity: 0 },
  show: { opacity: 1, transition: fade.in },
};

const LEAVE = { opacity: 0, transition: fade.out };

export interface SwapProps {
  /** 内容的身份：变了才算换内容，同一身份下内容照常原位更新。 */
  id: string;
  /** 新内容从哪一侧进来（向导前进从右、后退从左）；不传时从下方略微上移。 */
  from?: PanelFrom;
  /** 原地交叉淡化，不位移。 */
  still?: boolean;
  /** 之后换上来的内容挂上后调用（交接焦点）；参数是新内容那一格。 */
  onEnter?: (pane: HTMLElement) => void;
  /** 外层定位元素的类名，只用于布局。 */
  className?: string;
  /** 每一格的类名，只用于布局。 */
  paneClassName?: string;
  children: ReactNode;
}

export function Swap({ id, from, still = false, onEnter, className, paneClassName, children }: SwapProps) {
  const wrap = useRef<HTMLDivElement>(null);
  // 挂载时就在的内容不播入场；不能在 AnimatePresence 上写 initial={false}，那会让里面之后才挂载的元素也跳过入场
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
  }, []);
  const settledId = useRef(id);
  const enterRef = useRef(onEnter);
  enterRef.current = onEnter;
  useLayoutEffect(() => {
    if (settledId.current === id) return;
    settledId.current = id;
    const host = wrap.current;
    if (host === null) throw new Error("换内容的那一格没有挂上");
    // 旧内容在同一次提交里已带上 inert，没带的那一格就是新内容
    const pane = [...host.children].find((el): el is HTMLElement => el instanceof HTMLElement && !el.hasAttribute("inert"));
    if (pane === undefined) throw new Error(`换上来的内容「${id}」不在这一格里`);
    enterRef.current?.(pane);
  }, [id]);
  return (
    <div ref={wrap} className={cx(styles.swap, className)}>
      <AnimatePresence mode="popLayout">
        <Pane key={id} enter={mounted.current} from={from} variants={still ? STILL : tabPanel} className={paneClassName}>
          {children}
        </Pane>
      </AnimatePresence>
    </div>
  );
}

interface PaneProps {
  /** popLayout 把退场项抽出布局时要量这一层，由 AnimatePresence 递进来。 */
  ref?: Ref<HTMLDivElement>;
  enter: boolean;
  from: PanelFrom | undefined;
  variants: Variants;
  className?: string;
  children: ReactNode;
}

function Pane({ ref, enter, from, variants, className, children }: PaneProps) {
  const present = useIsPresent();
  return (
    <motion.div
      ref={ref}
      className={className}
      inert={!present}
      custom={from}
      variants={variants}
      initial={enter ? "hidden" : false}
      animate="show"
      exit={LEAVE}
    >
      {children}
    </motion.div>
  );
}
