// 标签页：同一对象的几个内容面板之间切换。underline 只用于页面级（实例详情），pill 用于卡片内或页面次级切换。
// 筛选同一列表用分段控件；分步流程不用它。最多 7 项，放不下时横向滚动、两端渐隐，选中项自动滚入可视区。
// 漫游 tabindex：←→ 移动并激活，Home / End 到首尾。标签与面板按同一个 id 关联（aria-controls / aria-labelledby）。

import { motion, type Variants } from "framer-motion";
import { useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import { Icon, type IconName } from "../art/Icon";
import { fade, springs, tabPanel } from "../lib/motion";
import { cx, isImeComposing } from "../lib/util";
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

export function Tabs<T extends string>({ id, value, onChange, items, variant = "underline", size = "md", ariaLabel, className }: TabsProps<T>) {
  if (items.length > TABS_MAX_ITEMS) throw new Error(`Tabs 最多 ${TABS_MAX_ITEMS} 项，收到 ${items.length} 项`);
  if (ariaLabel.trim() === "") throw new Error("Tabs 的 ariaLabel 不能为空");
  const listRef = useRef<HTMLDivElement>(null);
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const [overflow, setOverflow] = useState({ start: false, end: false });
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

  // 选中项滚入可视区；平滑与否交给容器的 scroll-behavior（减少动画时为瞬时）
  useLayoutEffect(() => {
    const list = listRef.current;
    const tab = tabRefs.current[selected];
    if (!list || !tab) return;
    const left = tab.offsetLeft - FADE_EDGE;
    const right = tab.offsetLeft + tab.offsetWidth + FADE_EDGE;
    if (left < list.scrollLeft) list.scrollLeft = Math.max(0, left);
    else if (right > list.scrollLeft + list.clientWidth) list.scrollLeft = right - list.clientWidth;
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

  return (
    <div
      ref={listRef}
      role="tablist"
      aria-label={ariaLabel}
      className={cx(styles.list, className)}
      data-variant={variant}
      data-size={size}
      data-fade-start={overflow.start || undefined}
      data-fade-end={overflow.end || undefined}
      onKeyDown={onKeyDown}
      onScroll={measure}
    >
      {items.map((item, i) => {
        const on = i === selected;
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
            {on && <motion.span layoutId={`${id}-indicator`} className={styles.indicator} transition={springs.settle} />}
            <span className={styles.content}>
              {item.icon !== undefined && <Icon name={item.icon} size={16} />}
              <span>{item.label}</span>
              {item.badge}
            </span>
          </button>
        );
      })}
    </div>
  );
}

/** 卡片内的胶囊标签切换：新内容只淡入，不位移。 */
const cardPanel: Variants = {
  hidden: { opacity: 0 },
  show: { opacity: 1, transition: fade.in },
};

export interface TabPanelProps {
  /** 与对应 Tabs 相同的关联前缀。 */
  tabsId: string;
  /** 当前选中的标签值；面板按它重新挂载，旧面板同一帧移除。 */
  value: string;
  /** page：页面级与页面次级切换（淡入 + 上移 6px）；card：卡片内的胶囊标签（只淡入）。 */
  motion?: "page" | "card";
  className?: string;
  children: ReactNode;
}

/**
 * 面板必须以变体标签（hidden / show）驱动入场：面板内部带 variants 的子元素等最近的变体祖先来编排，
 * 写成 initial / animate 对象字面量时面板不是变体节点，子元素挂到只在页面挂载时编排过一次的上层祖先，
 * 切换一次标签后就永久停在 hidden。
 */
export function TabPanel({ tabsId, value, motion: kind = "page", className, children }: TabPanelProps) {
  return (
    <motion.div
      key={value}
      role="tabpanel"
      id={panelDomId(tabsId, value)}
      aria-labelledby={tabDomId(tabsId, value)}
      className={className}
      variants={kind === "page" ? tabPanel : cardPanel}
      initial="hidden"
      animate="show"
    >
      {children}
    </motion.div>
  );
}
