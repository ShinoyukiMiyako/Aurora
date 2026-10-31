// 提示气泡：给纯图标控件、截断文字、需要补一行说明的元素做悬停 / 聚焦提示。
//
// 时机：指针悬停 delay 后出现；键盘 :focus-visible 立即出现；指针按下、失焦、Esc、滚动时立即消失；
// 指针离开触发元素后再停留 linger，期间移入气泡则保持显示（可悬停驻留，不让气泡挡住路又抓不住）。
// 预热：任一气泡消失后 warmWindow 内，移到另一个带提示的元素上不再等待。
// 不入 Esc 栈：Esc 先由栈顶浮层处理，同时通知这里收起。

import { AnimatePresence, motion } from "framer-motion";
import { cloneElement, useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type ReactElement, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { fade, springs, TOOLTIP_ENTER_OFFSET, TOOLTIP_TIMING } from "../lib/motion";
import { placeFloating, rectInRoot, useEscapeListener, useOverlayRoot, type Side } from "../shell/overlay";
import styles from "./Tooltip.module.css";

export type TooltipSide = Side;

export interface TooltipProps {
  content: ReactNode;
  /** 第二行小字（例如快捷键提示、实例状态）。 */
  sub?: ReactNode;
  side?: TooltipSide;
  /** 悬停出现的延迟（毫秒）；侧栏条目传 TOOLTIP_TIMING.sidebarDelay。 */
  delay?: number;
  /** 气泡与触发元素的间距（px）；默认上下 8、左右 12。 */
  offset?: number;
  /** 允许折行（长说明文字），最大宽 260。 */
  wrap?: boolean;
  disabled?: boolean;
  /**
   * 为真时立即显示，转为假时收起这一次显示；不影响悬停与聚焦照常触发。
   * 给焦点不落在触发元素自身上的场合用：菜单以 aria-activedescendant 高亮的项从不获得焦点，聚焦触发不了提示。
   */
  open?: boolean;
  /** 单个可聚焦元素；气泡锚定在它身上，并通过 aria-describedby 关联。 */
  children: ReactElement<{ "aria-describedby"?: string }>;
}

/** 全站共享的预热时刻：最近一次有气泡消失的时间。 */
let lastHiddenAt = Number.NEGATIVE_INFINITY;

const DEFAULT_OFFSET: Record<TooltipSide, number> = { top: 8, bottom: 8, left: 12, right: 12 };

export function Tooltip({ content, sub, side = "top", delay = TOOLTIP_TIMING.delay, offset, wrap = false, disabled = false, open: forced, children }: TooltipProps) {
  const root = useOverlayRoot();
  const id = useId();
  const hostRef = useRef<HTMLSpanElement>(null);
  const showTimer = useRef<number | undefined>(undefined);
  const hideTimer = useRef<number | undefined>(undefined);
  const [anchor, setAnchor] = useState<Element | null>(null);
  const openRef = useRef(false);

  const clearTimers = () => {
    window.clearTimeout(showTimer.current);
    window.clearTimeout(hideTimer.current);
  };

  const hideNow = useCallback(() => {
    window.clearTimeout(showTimer.current);
    window.clearTimeout(hideTimer.current);
    if (openRef.current) lastHiddenAt = Date.now();
    openRef.current = false;
    setAnchor(null);
  }, []);

  // 打开时触发元素就已禁用（悬停查看灰掉的后退键是什么）：照常显示，只在打开之后才变禁用时收起
  const openedDisabled = useRef(false);
  const open = (target: Element) => {
    openRef.current = true;
    openedDisabled.current = target.matches(":disabled");
    setAnchor(target);
  };

  const show = (immediate: boolean) => {
    if (disabled) return;
    window.clearTimeout(hideTimer.current);
    if (openRef.current) return;
    const target = hostRef.current?.firstElementChild;
    if (!target) throw new Error("Tooltip 必须包住一个元素");
    const warm = Date.now() - lastHiddenAt < TOOLTIP_TIMING.warmWindow;
    window.clearTimeout(showTimer.current);
    if (immediate || warm) open(target);
    else showTimer.current = window.setTimeout(() => open(target), delay);
  };

  const scheduleHide = () => {
    window.clearTimeout(showTimer.current);
    if (!openRef.current) return;
    window.clearTimeout(hideTimer.current);
    hideTimer.current = window.setTimeout(hideNow, TOOLTIP_TIMING.linger);
  };

  useEffect(() => clearTimers, []);

  useEffect(() => {
    if (disabled) hideNow();
  }, [disabled, hideNow]);

  // 只收起由 open 打开的那一次：open 一直为假时，悬停与聚焦打开的气泡不该被它关掉
  const forcedShown = useRef(false);
  useLayoutEffect(() => {
    if (forced === true) {
      forcedShown.current = true;
      show(true);
      return;
    }
    if (!forcedShown.current) return;
    forcedShown.current = false;
    hideNow();
    // show 每次渲染都是新函数，不列进依赖：只跟随 open 的变化
  }, [forced, hideNow]);

  // 显示期间触发元素自己变成禁用（后退键退到历史尽头）：浏览器把焦点挪到 body 却不派发 blur，
  // 气泡会一直挂在那里。禁用总是随这里的子元素一起重渲染，每次提交后查一次即可
  useLayoutEffect(() => {
    if (anchor !== null && !openedDisabled.current && anchor.matches(":disabled")) hideNow();
  });

  useEscapeListener(anchor !== null, hideNow);

  useEffect(() => {
    if (!anchor) return;
    window.addEventListener("scroll", hideNow, true);
    return () => window.removeEventListener("scroll", hideNow, true);
  }, [anchor, hideNow]);

  const describedBy = [children.props["aria-describedby"], anchor ? id : undefined].filter(Boolean).join(" ");

  return (
    <>
      <span
        ref={hostRef}
        className={styles.host}
        onPointerEnter={() => show(false)}
        onPointerLeave={scheduleHide}
        onPointerDown={hideNow}
        onFocus={(e) => {
          if ((e.target as Element).matches(":focus-visible")) show(true);
        }}
        onBlur={hideNow}
      >
        {cloneElement(children, { "aria-describedby": describedBy === "" ? undefined : describedBy })}
      </span>
      {root &&
        createPortal(
          <AnimatePresence>
            {anchor && (
              <Bubble
                key="bubble"
                id={id}
                root={root}
                anchor={anchor}
                side={side}
                offset={offset ?? DEFAULT_OFFSET[side]}
                wrap={wrap}
                content={content}
                sub={sub}
                onEnter={() => window.clearTimeout(hideTimer.current)}
                onLeave={scheduleHide}
              />
            )}
          </AnimatePresence>,
          root,
        )}
    </>
  );
}

interface BubbleProps {
  id: string;
  root: HTMLElement;
  anchor: Element;
  side: TooltipSide;
  offset: number;
  wrap: boolean;
  content: ReactNode;
  sub: ReactNode;
  onEnter(): void;
  onLeave(): void;
}

function Bubble({ id, root, anchor, side, offset, wrap, content, sub, onEnter, onLeave }: BubbleProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number; side: TooltipSide } | null>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const rootRect = root.getBoundingClientRect();
    setPos(placeFloating(rectInRoot(anchor, root), { width: el.offsetWidth, height: el.offsetHeight }, side, offset, { width: rootRect.width, height: rootRect.height }));
  }, [anchor, root, side, offset]);

  // 入场起点向锚点一侧偏移：气泡在上方时从下往上浮出，在右侧时从左往右浮出
  const actual = pos ? pos.side : side;
  const x = actual === "right" ? -TOOLTIP_ENTER_OFFSET.horizontal : actual === "left" ? TOOLTIP_ENTER_OFFSET.horizontal : 0;
  const y = actual === "bottom" ? -TOOLTIP_ENTER_OFFSET.vertical : actual === "top" ? TOOLTIP_ENTER_OFFSET.vertical : 0;

  return (
    <motion.div
      ref={ref}
      id={id}
      role="tooltip"
      className={styles.bubble}
      data-wrap={wrap || undefined}
      data-side={actual}
      style={{ left: pos ? pos.left : 0, top: pos ? pos.top : 0, visibility: pos ? "visible" : "hidden" }}
      initial={{ opacity: 0, x, y }}
      animate={{ opacity: 1, x: 0, y: 0, transition: { ...springs.settle, opacity: fade.in } }}
      exit={{ opacity: 0, transition: fade.quick }}
      onPointerEnter={onEnter}
      onPointerLeave={onLeave}
    >
      {content}
      {sub !== undefined && <span className={styles.sub}>{sub}</span>}
    </motion.div>
  );
}
