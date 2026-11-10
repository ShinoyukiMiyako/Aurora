// 提示气泡：给纯图标控件、截断文字、需要补一行说明的元素做悬停 / 聚焦提示。
//
// 时机：指针悬停 delay 后出现；键盘 :focus-visible 立即出现；指针按下、失焦、Esc、滚动时立即消失；
// 指针离开触发元素后再停留 linger，期间移入气泡则保持显示（可悬停驻留，不让气泡挡住路又抓不住）。
// 预热：任一气泡消失后 warmWindow 内，或另一个气泡还显示着（驻留中）时，移到另一个带提示的元素上不再等待。
// 全站同一时刻只有一个气泡：新的出现时旧的直接撤掉、不播退场（旧的已在淡出也一样立即撤掉）；预热中出现的气泡也不播入场，
// 指针扫过一排图标按钮时提示原地换字，不反复浮起、淡入淡出。只有一轮里的第一个气泡带入场。
// 由 open 强制显示的气泡不参与顶替：它标的是键盘所在的位置，指针移到别的提示上时它留着，也不让别的提示借它预热。
// 按在带原因禁用（aria-disabled）的控件上不收起而是立即显示：点击会被挡掉，这一刻正是最想知道原因的时候。
// 显示期间气泡尺寸变了（文案换成「已复制」、多出一行原因）就按新尺寸重新贴到锚点旁。
// 由 open 强制显示的气泡滚动时不收起，跟着锚点走（键盘在可滚动的网格里移动，滚动由程序触发）；
// 锚点被滚出所在滚动容器的可视区时藏起，滚回来再出现，不脱离锚点浮在无关的内容上。
// 不入 Esc 栈：Esc 先由栈顶浮层处理，同时通知这里收起。
//
// 包裹层可以常驻：disabled 时什么都不显示、也不碰浮层体系，控件要不要提示随状态变化时不用增减这一层，
// 增减的话 React 会重挂控件，聚焦着的控件把焦点丢回 body。Button、IconButton、Toggle、Checkbox 都这样用。

import { AnimatePresence, motion, type Variants } from "framer-motion";
import { cloneElement, useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type ReactElement, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { fade, springs, TOOLTIP_ENTER_OFFSET, TOOLTIP_TIMING } from "../lib/motion";
import { placeFloating, rectInRoot, useEscapeListener, useOverlayRoot, type Side } from "../shell/overlay";
import { enterShift } from "./Popover";
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
  /** 单个可聚焦元素；气泡锚定在它身上，并通过 aria-describedby 关联。它自己可以再带一层提示包裹。 */
  children: ReactElement<{ "aria-describedby"?: string }>;
}

/** 全站共享的预热时刻：最近一次有气泡消失的时间。 */
let lastHiddenAt = Number.NEGATIVE_INFINITY;

/** 正在显示的气泡：owner 区分是哪一个提示，hide(true) 让它直接撤掉、不播退场。强制显示的气泡不登记。 */
let showing: { owner: object; hide: (replaced: boolean) => void } | null = null;

/**
 * 正在播退场（fade.quick）的气泡：驻留结束后的预热窗口里移到下一个提示时，新气泡原地出现，
 * 旧的要跟着立即撤掉，不然两个气泡并存到旧的淡完。它已不在 showing 里，只能单独记下。
 */
let exiting: { owner: object; purge: () => void } | null = null;

/** 会裁掉超出部分的 overflow 取值。 */
const CLIPPING_OVERFLOW = new Set(["auto", "scroll", "hidden", "clip", "overlay"]);

/** 锚点外面一层层会裁掉超出部分的祖先（滚动容器等）。 */
function clippingAncestors(el: Element): Element[] {
  const found: Element[] = [];
  for (let node = el.parentElement; node !== null && node !== document.body; node = node.parentElement) {
    const style = getComputedStyle(node);
    if (CLIPPING_OVERFLOW.has(style.overflowX) || CLIPPING_OVERFLOW.has(style.overflowY)) found.push(node);
  }
  return found;
}

/** 两个矩形完全不相交（贴边不算）。 */
function disjoint(a: DOMRect, b: DOMRect): boolean {
  return a.bottom < b.top || a.top > b.bottom || a.right < b.left || a.left > b.right;
}

const DEFAULT_OFFSET: Record<TooltipSide, number> = { top: 8, bottom: 8, left: 12, right: 12 };

/** 包裹层里真正的控件：子元素自带一层包裹（<Tooltip><Button /></Tooltip>）时往里走，包裹层 display: contents，没有盒子可锚定。 */
function triggerOf(host: Element): Element | null {
  const first = host.firstElementChild;
  return first !== null && first.hasAttribute("data-tooltip-host") ? triggerOf(first) : first;
}

export function Tooltip({ content, sub, side = "top", delay = TOOLTIP_TIMING.delay, offset, wrap = false, disabled = false, open: forced, children }: TooltipProps) {
  const id = useId();
  const hostRef = useRef<HTMLSpanElement>(null);
  const showTimer = useRef<number | undefined>(undefined);
  const hideTimer = useRef<number | undefined>(undefined);
  const [anchor, setAnchor] = useState<Element | null>(null);
  const openRef = useRef(false);
  const [owner] = useState(() => ({}));
  // 这一次显示不播入场（预热中出现）；这一次收起不播退场（被另一个气泡顶替）
  const [instant, setInstant] = useState(false);
  const [replaced, setReplaced] = useState(false);
  // 换一个值就整个重挂气泡层：正在退场的气泡随旧的 AnimatePresence 一起立即卸掉
  const [layerKey, setLayerKey] = useState(0);
  const purge = useCallback(() => setLayerKey((n) => n + 1), []);

  // 错误屏的按钮在 OverlayProvider 之外，从没启用过的提示不能碰浮层体系。启用过就留着：退场动画要在气泡层里演完
  const [armed, setArmed] = useState(!disabled);
  if (!disabled && !armed) setArmed(true);
  // 调用方常把内容和 disabled 一起撤掉（按钮的禁用原因没了）：退场中的气泡留着最后的字，不闪成空气泡
  const shown = useRef({ content, sub });
  if (!disabled) shown.current = { content, sub };

  const clearTimers = () => {
    window.clearTimeout(showTimer.current);
    window.clearTimeout(hideTimer.current);
  };

  const hide = useCallback(
    (byOther: boolean) => {
      window.clearTimeout(showTimer.current);
      window.clearTimeout(hideTimer.current);
      if (openRef.current) {
        lastHiddenAt = Date.now();
        // 被顶替的直接撤掉，不用记；照常收起的要淡出 fade.quick，期间可能被下一个气泡顶掉
        if (!byOther) exiting = { owner, purge };
      }
      openRef.current = false;
      if (showing !== null && showing.owner === owner) showing = null;
      setReplaced(byOther);
      setAnchor(null);
    },
    [owner, purge],
  );
  const hideNow = useCallback(() => hide(false), [hide]);

  // 打开时触发元素就已禁用（悬停查看灰掉的后退键是什么）：照常显示，只在打开之后才变禁用时收起
  const openedDisabled = useRef(false);
  const open = (target: Element, warm: boolean) => {
    const other = showing !== null && showing.owner !== owner ? showing : null;
    other?.hide(true);
    // 自己正在退场又被重新打开时，同一个气泡会被 AnimatePresence 接回来，不能当成别人的退场撤掉
    if (exiting !== null) {
      if (exiting.owner !== owner) exiting.purge();
      exiting = null;
    }
    if (!forcedShown.current) showing = { owner, hide };
    openRef.current = true;
    openedDisabled.current = target.matches(":disabled");
    setInstant(warm || other !== null);
    setReplaced(false);
    setAnchor(target);
  };

  const show = (immediate: boolean) => {
    if (disabled) return;
    window.clearTimeout(hideTimer.current);
    if (openRef.current) return;
    const target = hostRef.current === null ? null : triggerOf(hostRef.current);
    if (target === null) throw new Error("Tooltip 必须包住一个元素");
    const warm = Date.now() - lastHiddenAt < TOOLTIP_TIMING.warmWindow || (showing !== null && showing.owner !== owner);
    window.clearTimeout(showTimer.current);
    if (immediate || warm) open(target, warm);
    else showTimer.current = window.setTimeout(() => open(target, false), delay);
  };

  const onPointerDown = () => {
    const target = hostRef.current === null ? null : triggerOf(hostRef.current);
    if (target !== null && target.getAttribute("aria-disabled") === "true") show(true);
    else hideNow();
  };

  const scheduleHide = () => {
    window.clearTimeout(showTimer.current);
    if (!openRef.current) return;
    window.clearTimeout(hideTimer.current);
    hideTimer.current = window.setTimeout(hideNow, TOOLTIP_TIMING.linger);
  };

  useEffect(
    () => () => {
      clearTimers();
      if (showing !== null && showing.owner === owner) showing = null;
      if (exiting !== null && exiting.owner === owner) exiting = null;
    },
    [owner],
  );

  useEffect(() => {
    if (disabled) hideNow();
  }, [disabled, hideNow]);

  // 只收起由 open 打开的那一次：open 一直为假时，悬停与聚焦打开的气泡不该被它关掉
  const forcedShown = useRef(false);
  useLayoutEffect(() => {
    if (forced === true) {
      forcedShown.current = true;
      show(true);
      // 悬停已经打开的这一次转成强制显示：同样不再让别的提示顶替
      if (showing !== null && showing.owner === owner) showing = null;
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

  const follow = forced === true;
  useEffect(() => {
    if (!anchor || follow) return;
    window.addEventListener("scroll", hideNow, true);
    return () => window.removeEventListener("scroll", hideNow, true);
  }, [anchor, follow, hideNow]);

  const describedBy = [children.props["aria-describedby"], anchor ? id : undefined].filter(Boolean).join(" ");

  return (
    <>
      <span
        ref={hostRef}
        className={styles.host}
        data-tooltip-host=""
        onPointerEnter={() => show(false)}
        onPointerLeave={scheduleHide}
        onPointerDown={onPointerDown}
        onFocus={(e) => {
          if ((e.target as Element).matches(":focus-visible")) show(true);
        }}
        onBlur={hideNow}
      >
        {cloneElement(children, { "aria-describedby": describedBy === "" ? undefined : describedBy })}
      </span>
      {armed && (
        <BubbleLayer
          key={layerKey}
          anchor={anchor}
          onEscape={hideNow}
          onExited={() => {
            if (exiting !== null && exiting.owner === owner) exiting = null;
          }}
          replaced={replaced}
          instant={instant}
          follow={follow}
          id={id}
          side={side}
          offset={offset ?? DEFAULT_OFFSET[side]}
          wrap={wrap}
          content={shown.current.content}
          sub={shown.current.sub}
          onEnter={() => window.clearTimeout(hideTimer.current)}
          onLeave={scheduleHide}
        />
      )}
    </>
  );
}

function BubbleLayer({
  anchor,
  onEscape,
  onExited,
  replaced,
  ...bubble
}: Omit<BubbleProps, "root" | "anchor"> & { anchor: Element | null; onEscape(): void; onExited(): void; replaced: boolean }) {
  const root = useOverlayRoot();
  useEscapeListener(anchor !== null, onEscape);
  if (root === null) return null;
  // custom 交给正在退场的气泡：被另一个气泡顶替时直接撤掉
  return createPortal(
    <AnimatePresence custom={replaced} onExitComplete={onExited}>
      {anchor && <Bubble key="bubble" root={root} anchor={anchor} {...bubble} />}
    </AnimatePresence>,
    root,
  );
}

const bubbleVariants: Variants = {
  gone: (replaced: boolean) => ({ opacity: 0, transition: replaced ? fade.none : fade.quick }),
};

interface BubbleProps {
  id: string;
  root: HTMLElement;
  anchor: Element;
  side: TooltipSide;
  offset: number;
  wrap: boolean;
  content: ReactNode;
  sub: ReactNode;
  /** 不播入场：预热中出现，原地换上。 */
  instant: boolean;
  /** 滚动时跟着锚点重新定位（由 open 强制显示的气泡）。 */
  follow: boolean;
  onEnter(): void;
  onLeave(): void;
}

interface BubblePosition {
  left: number;
  top: number;
  side: TooltipSide;
  /** 第一次定位时采用的方位：入场方向只按它定。 */
  enter: TooltipSide;
}

function Bubble({ id, root, anchor, side, offset, wrap, content, sub, instant, follow, onEnter, onLeave }: BubbleProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<BubblePosition | null>(null);

  const place = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    const rootRect = root.getBoundingClientRect();
    const next = placeFloating(rectInRoot(anchor, root), { width: el.offsetWidth, height: el.offsetHeight }, side, offset, { width: rootRect.width, height: rootRect.height });
    setPos((prev) =>
      prev && prev.left === next.left && prev.top === next.top && prev.side === next.side ? prev : { ...next, enter: prev === null ? next.side : prev.enter },
    );
  }, [anchor, root, side, offset]);

  useLayoutEffect(() => {
    place();
    const el = ref.current;
    // 组件测试的 jsdom 没有 ResizeObserver（也不做布局，尺寸变化无从谈起）；真机的 WebView2 有
    if (el === null || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(place);
    observer.observe(el);
    return () => observer.disconnect();
  }, [place]);

  // 跟着锚点走的气泡，锚点被滚出所在滚动容器的可视区时藏起：不然被夹在窗口里、浮在无关的内容上。
  // 裁切的祖先在开始跟随时找一次；之后每次滚动先读完矩形再定位
  const [clipped, setClipped] = useState(false);
  useLayoutEffect(() => {
    if (!follow) return;
    const clips = clippingAncestors(anchor);
    const check = () => {
      const rect = anchor.getBoundingClientRect();
      setClipped(clips.some((clip) => disjoint(rect, clip.getBoundingClientRect())));
    };
    const onScroll = () => {
      check();
      place();
    };
    check();
    window.addEventListener("scroll", onScroll, true);
    return () => window.removeEventListener("scroll", onScroll, true);
  }, [follow, anchor, place]);
  const visible = pos !== null && !(follow && clipped);

  // 入场等定位之后才开始，起点按第一次定位实际采用的方位向锚点一侧偏移：气泡在上方时从下往上浮出，在右侧时从左往右浮出。
  // 翻到对侧时方向跟着翻；位移写成从起点到 0 的关键帧，值不变时重渲染不会重播
  const actual = pos ? pos.side : side;
  const shift = pos === null ? null : enterShift(pos.enter, pos.enter === "left" || pos.enter === "right" ? TOOLTIP_ENTER_OFFSET.horizontal : TOOLTIP_ENTER_OFFSET.vertical);

  return (
    <motion.div
      ref={ref}
      id={id}
      role="tooltip"
      className={styles.bubble}
      data-wrap={wrap || undefined}
      data-side={actual}
      data-instant={instant || undefined}
      style={{ left: pos ? pos.left : 0, top: pos ? pos.top : 0, visibility: visible ? "visible" : "hidden" }}
      variants={bubbleVariants}
      initial={instant ? false : { opacity: 0 }}
      animate={instant ? { opacity: 1 } : shift === null ? undefined : { opacity: 1, x: [shift.x, 0], y: [shift.y, 0], transition: { ...springs.settle, opacity: fade.in } }}
      exit="gone"
      onPointerEnter={onEnter}
      onPointerLeave={onLeave}
    >
      {content}
      {sub !== undefined && <span className={styles.sub}>{sub}</span>}
    </motion.div>
  );
}
