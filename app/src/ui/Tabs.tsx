// 标签页：同一对象的几个内容面板之间切换。underline 只用于页面级（实例详情），pill 用于卡片内或页面次级切换。
// 筛选同一列表用分段控件；分步流程不用它。最多 7 项，放不下时横向滚动、两端渐隐，选中项自动滚入可视区。
// 漫游 tabindex：←→ 移动并激活，Home / End 到首尾。标签与面板按同一个 id 关联（aria-controls / aria-labelledby）。

import { AnimatePresence, motion, useReducedMotionConfig, type Variants } from "framer-motion";
import { useCallback, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import { Icon, type IconName } from "../art/Icon";
import { fade, popMark, springs, tabPanel, type PanelFrom } from "../lib/motion";
import { useReflow } from "../lib/reflow";
import { useMounted } from "../lib/useMounted";
import { usePaintedOnce } from "../lib/usePaintedOnce";
import { cx, isImeComposing } from "../lib/util";
import { EntranceBoundary, usePageEntrance, usePageFirstFrame } from "./Page";
import { nextEnabled } from "./roving";
import styles from "./Tabs.module.css";

export const TABS_MAX_ITEMS = 7;

export interface TabItem<T extends string> {
  value: T;
  label: string;
  icon?: IconName;
  /** 文字后的徽标（崩溃诊断等异常计数用 danger 色调，普通计数用 neutral），由调用方传入徽标组件。 */
  badge?: ReactNode;
  disabled?: boolean;
}

export interface TabsProps<T extends string> {
  /** 标签与面板共用的关联前缀，通常取自 useId()；TabPanel 传同一个值。 */
  id: string;
  value: T;
  onChange: (value: T) => void;
  items: readonly TabItem<T>[];
  variant?: "underline" | "pill";
  /** 只对 pill 生效：sm 30 / md 36。 */
  size?: "sm" | "md";
  ariaLabel: string;
  className?: string;
}

export const tabDomId = (id: string, value: string) => `${id}-tab-${value}`;
export const panelDomId = (id: string, value: string) => `${id}-panel-${value}`;

/** 两端渐隐遮罩的宽度（px），选中项滚入可视区时也让出这段距离。 */
const FADE_EDGE = 16;

/**
 * 指示块的圆角：胶囊取标签高的一半，下划线取线高的一半。经 style 传给布局动画：在宽度不同的两个标签之间滑动时
 * framer-motion 用 scaleX 形变，只有 style 里的圆角会被逐帧反算校正，写在类里的会被拉成椭圆。
 */
export const INDICATOR_RADIUS = { underline: 1.25, pill: { md: 18, sm: 15 } } as const;

/**
 * 徽标会不会画出东西。React 对 undefined、null、布尔值与空串什么都不画：这些情况不包徽标层，
 * 否则空的包裹层也会吃掉标签内容的间距，让标签无故变宽。
 */
function rendersSomething(node: ReactNode): boolean {
  return node !== undefined && node !== null && typeof node !== "boolean" && node !== "";
}

export function Tabs<T extends string>({ id, value, onChange, items, variant = "underline", size = "md", ariaLabel, className }: TabsProps<T>) {
  if (items.length > TABS_MAX_ITEMS) throw new Error(`Tabs 最多 ${TABS_MAX_ITEMS} 项，收到 ${items.length} 项`);
  if (ariaLabel.trim() === "") throw new Error("Tabs 的 ariaLabel 不能为空");
  const listRef = useRef<HTMLDivElement>(null);
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const [overflow, setOverflow] = useState({ start: false, end: false });
  // 徽标晚到（Mod 更新数、「实时」）会撑宽所在标签：后面的标签从旧位置滑过去，而不是一帧横跳
  const reflow = useReflow<HTMLDivElement>();
  const bindList = useCallback(
    (el: HTMLDivElement | null) => {
      listRef.current = el;
      const stop = reflow(el);
      return () => {
        stop?.();
        listRef.current = null;
      };
    },
    [reflow],
  );
  // 挂载时就在的徽标跟着页面入场，不单独弹入。减少动画时缩放是一步到位的，只留淡入淡出
  const mounted = useMounted();
  const reduced = useReducedMotionConfig() === true;
  const mark = reduced ? popMark.reduced : popMark.glyph;
  // 指示块同理：减少动画时布局动画一步到位，指示块会从旧标签瞬移到新标签，改为在新标签上从透明淡入，旧的那一块直接卸载、不留退场。
  // 挂载时就在的那一块跟着页面入场，自己不淡
  const indicatorFade = reduced ? { initial: mounted.current ? { opacity: 0 } : false, animate: { opacity: 1, transition: fade.in } } : undefined;
  const placed = useRef(false);
  const disabled = items.map((item) => item.disabled === true);
  const selected = items.findIndex((item) => item.value === value);
  if (selected < 0) throw new Error(`Tabs 的当前值 ${value} 不在标签里`);

  const measure = () => {
    const el = listRef.current;
    if (!el) return;
    const next = { start: el.scrollLeft > 0, end: el.scrollLeft + el.clientWidth < el.scrollWidth - 1 };
    setOverflow((prev) => (prev.start === next.start && prev.end === next.end ? prev : next));
  };

  useLayoutEffect(() => {
    const el = listRef.current;
    if (!el) return;
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // 选中项滚入可视区；平滑与否交给容器的 scroll-behavior（减少动画时为瞬时）。
  // 挂载时的定位是摆放而不是滚动：照样平滑的话，标签条会在页面入场的同时横向滑一段，这一次临时改成瞬时
  useLayoutEffect(() => {
    const list = listRef.current;
    const tab = tabRefs.current[selected];
    if (!list || !tab) return;
    const instant = !placed.current;
    placed.current = true;
    const left = tab.offsetLeft - FADE_EDGE;
    const right = tab.offsetLeft + tab.offsetWidth + FADE_EDGE;
    let target: number | null = null;
    if (left < list.scrollLeft) target = Math.max(0, left);
    else if (right > list.scrollLeft + list.clientWidth) target = right - list.clientWidth;
    if (target === null) return;
    if (instant) list.style.scrollBehavior = "auto";
    list.scrollLeft = target;
    if (instant) list.style.scrollBehavior = "";
  }, [selected]);

  const activate = (index: number) => {
    tabRefs.current[index]?.focus();
    if (index !== selected) onChange(items[index].value);
  };

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (isImeComposing(event)) return;
    const from = tabRefs.current.findIndex((el) => el !== null && el === document.activeElement);
    const at = from >= 0 ? from : selected;
    let next = -1;
    if (event.key === "ArrowRight") next = nextEnabled(disabled, at, 1);
    else if (event.key === "ArrowLeft") next = nextEnabled(disabled, at, -1);
    else if (event.key === "Home") next = disabled.indexOf(false);
    else if (event.key === "End") next = disabled.lastIndexOf(false);
    else return;
    event.preventDefault();
    if (next >= 0) activate(next);
  };

  const indicatorRadius = variant === "underline" ? INDICATOR_RADIUS.underline : INDICATOR_RADIUS.pill[size];

  return (
    // 横向滚动容器标 layoutScroll：指示块的布局动画按滚动后的坐标算起点，选中项被滚入可视区时不偏一个滚动量
    <motion.div
      ref={bindList}
      role="tablist"
      aria-label={ariaLabel}
      className={cx(styles.list, className)}
      data-variant={variant}
      data-size={size}
      data-fade-start={overflow.start || undefined}
      data-fade-end={overflow.end || undefined}
      layoutScroll
      onKeyDown={onKeyDown}
      onScroll={measure}
    >
      {items.map((item, i) => {
        const on = i === selected;
        const hasBadge = rendersSomething(item.badge);
        return (
          <button
            key={item.value}
            ref={(el) => {
              tabRefs.current[i] = el;
            }}
            type="button"
            role="tab"
            id={tabDomId(id, item.value)}
            aria-selected={on}
            aria-controls={panelDomId(id, item.value)}
            tabIndex={on ? 0 : -1}
            disabled={item.disabled}
            className={styles.tab}
            onClick={() => activate(i)}
          >
            {/* 依赖取选中值：徽标晚到、上方内容变高引起的重渲染不量布局，指示块随标签一起到位，不从旧坐标追过来 */}
            {on && (
              <motion.span
                layoutId={`${id}-indicator`}
                layoutDependency={value}
                className={styles.indicator}
                style={{ borderRadius: indicatorRadius }}
                transition={springs.settle}
                {...indicatorFade}
              />
            )}
            <span className={styles.content}>
              {item.icon !== undefined && <Icon name={item.icon} size={16} />}
              <span>{item.label}</span>
              <AnimatePresence>
                {hasBadge && (
                  <motion.span
                    key="badge"
                    className={styles.badge}
                    initial={mounted.current ? mark.initial : false}
                    animate={mark.animate}
                    exit={mark.exit}
                  >
                    {item.badge}
                  </motion.span>
                )}
              </AnimatePresence>
            </span>
          </button>
        );
      })}
    </motion.div>
  );
}

/** 卡片内的胶囊标签切换：新内容只淡入，不位移。第一次挂载默认不播（见 TabPanelProps.initial）。 */
const cardPanel: Variants = {
  hidden: { opacity: 0 },
  show: { opacity: 1, transition: fade.in },
};

export interface TabPanelProps {
  /** 与对应 Tabs 相同的关联前缀。 */
  tabsId: string;
  /** 当前选中的标签值；面板按它重新挂载，旧面板同一帧移除。 */
  value: string;
  /** page：页面级与页面次级切换（淡入 + 上移 6px）；card：卡片内的胶囊标签（换标签时只淡入，第一次挂载默认不淡）。 */
  motion?: "page" | "card";
  /** 换标签时新面板从导航里的哪一侧进来：横排标签传 x 轴，竖排分区传 y 轴，dir 按新旧序号比较。不传时从下方上移。 */
  from?: PanelFrom;
  /**
   * 第一次挂载时播不播面板自己的入场。page 默认播；card 默认不播：卡片里的面板随所在的卡片、弹窗或向导步骤一起出现，
   * 自己再淡一遍就是两层叠着动。page 面板的外层已经把整块内容淡入（弹窗正文的 Loadable）时传 false：
   * 两层叠着动，标签内容会比旁边的内容多一段位移。只管第一次挂载，之后换标签照常走切换动画；
   * 进页那一次归页面管的面板（页面一级位置、赶上首帧）照页面的安排走，嵌套在首帧里的区块之内的跟着那个区块走，都不看它。
   */
  initial?: boolean;
  className?: string;
  children: ReactNode;
}

/**
 * 面板必须以变体标签（hidden / show）驱动入场：面板内部带 variants 的子元素等最近的变体祖先来编排，
 * 写成 initial / animate 对象字面量时面板不是变体节点，子元素挂到只在页面挂载时编排过一次的上层祖先，
 * 切换一次标签后就永久停在 hidden。
 *
 * 面板是一块内容，只动一次：里面的卡片、横幅不再认领页面入场序号（否则面板淡入的同时它们按序号再等一拍、
 * 再上移一次，内容分两段出现）。面板放在页面一级位置时，进页那一次由面板自己按序号随页面入场；
 * 嵌套在首帧里的一级区块之内时，进页那一次跟着那个区块走，自己不动；之后换标签只走面板的切换动画。
 * 面板自己播的入场（换标签、不归页面管的第一次挂载）先停在 hidden，画出第一帧之后才切到 show（usePaintedOnce）。
 */
export function TabPanel({ tabsId, value, motion: kind = "page", from, initial: firstEntrance = kind === "page", className, children }: TabPanelProps) {
  const entrance = usePageEntrance();
  const firstFrame = usePageFirstFrame();
  const [firstValue] = useState(value);
  const [switched, setSwitched] = useState(false);
  if (!switched && value !== firstValue) setSwitched(true);
  const own = { variants: kind === "page" ? tabPanel : cardPanel, custom: from };
  // 进页那一次归页面管：页面错开入场就照序号走，页面这次不播区块入场（后退前进、启动那一屏）面板也直接是成品
  const withPage = !switched && entrance !== null;
  // 不归页面管却赶上了首帧：嵌在首帧里的区块之内，外层整块已在随页面入场（或直接是成品），面板跟着它走
  const withBlock = !switched && entrance === null && firstFrame;
  const still = withPage ? entrance === "still" : !switched && (withBlock || !firstEntrance);
  // 页面错开入场的那一次与兄弟区块同一个时钟起步，不单独等
  const painted = usePaintedOnce(value, !withPage && !still);
  return (
    <motion.div
      key={value}
      role="tabpanel"
      id={panelDomId(tabsId, value)}
      aria-labelledby={tabDomId(tabsId, value)}
      className={className}
      {...(withPage && entrance !== "still" ? entrance : own)}
      initial={still ? false : "hidden"}
      animate={painted ? "show" : "hidden"}
    >
      <EntranceBoundary>{children}</EntranceBoundary>
    </motion.div>
  );
}
