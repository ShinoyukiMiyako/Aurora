// 一维列表的单行：实例库列表视图、下载任务、账户切换、Java 列表、日历当日实例、安装目标、历史记录。
// 多列可比属性且可能超过 20 行时用 Table；卡片网格用 Card。
//
// 行必须放在 List 里（ul / li）。两种排布：
// - inset：放在有内边距的卡片里，行带圆角、行间 2px 微缝、无分隔线；
// - flush：放在无内边距的卡片里贴边，行间 1px 分隔线。
// 行的交互按场景自动选写法：
// - 只有 onClick、没有尾部：整行是按钮；
// - onClick 且有尾部（尾部放了操作）：标题做成按钮，伪元素覆盖整行，尾部控件浮在覆盖层上；
// - 放在带 select 的 List 里：列表是 listbox，行是 option，↑↓ / Home / End 移动，Enter / Space 选中。
// 尾部操作常驻显示，不做「悬停才出现」：键盘与触控板用户看不到悬停态。
// 行的增删：List 挂载之后新增的行淡入并从略小处落到位（一次新增太多时改为整个列表淡入一次）；被删的行脱离布局原地淡出，其余行滑到新位置。
// 页面只管换 children（给稳定的 key），不用为进出场做任何事；行被页面自己的组件包着也一样。

import { AnimatePresence, motion, useAnimate, useIsPresent } from "framer-motion";
import { Children, createContext, isValidElement, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode, type Ref } from "react";
import { fade, insertItem } from "../lib/motion";
import { observeReflow } from "../lib/reflow";
import { cx } from "../lib/util";
import styles from "./ListRow.module.css";

export type ListVariant = "inset" | "flush";
export type ListRowSize = "sm" | "md" | "lg";

export interface ListSelect {
  /** 当前选中项的 value；没有选中时为 null。 */
  selected: string | null;
  onSelect: (value: string) => void;
}

interface ListContextValue {
  variant: ListVariant;
  select: (ListSelect & { tabStop: string | null; focus: (value: string) => void }) | null;
  /** 列表已经挂载：这之后出现的行播入场；挂载时就在的行跟着所在页面的入场走。 */
  entering: boolean;
}

const ListContext = createContext<ListContextValue | null>(null);

/**
 * AnimatePresence 的 popLayout 往直接子项上塞 ref，量尺寸、把退场的行抽出布局。直接子项常是页面自己包行的组件，
 * 它们不会把 ref 接到 li 上：List 给每个子项套一层 RowSlot，ref 经上下文交给行自己的 li。
 */
const RowSlotContext = createContext<Ref<HTMLLIElement> | undefined>(undefined);

function RowSlot({ children, ref }: { children: ReactNode; ref?: Ref<HTMLLIElement> }) {
  return <RowSlotContext.Provider value={ref}>{children}</RowSlotContext.Provider>;
}

/** 在场的选项；退场中的行（inert）还在文档里淡出，键盘不该停上去。 */
const LIVE_OPTION = ':scope > [role="option"]:not([inert])';

/** 一次新增超过这么多行时不逐行入场：行直接换上，整个列表淡入一次（与 Table 同一口径）。 */
export const ROW_MOTION_LIMIT = 40;

export interface ListProps {
  variant?: ListVariant;
  /** 可选择的列表：渲染为 listbox，必须同时给 aria-label。 */
  select?: ListSelect;
  "aria-label"?: string;
  className?: string;
  children: ReactNode;
}

/** listbox 里可选中的 value，按出现顺序；只认直接子级的 ListRow。 */
function optionValues(children: ReactNode): string[] {
  const values: string[] = [];
  for (const child of Children.toArray(children)) {
    if (!isValidElement<ListRowProps>(child) || child.type !== ListRow) continue;
    const { value, disabled } = child.props;
    if (value !== undefined && disabled !== true) values.push(value);
  }
  return values;
}

export function List({ variant = "inset", select, className, children, ...aria }: ListProps) {
  const label = aria["aria-label"];
  if (select !== undefined && (label === undefined || label.trim() === "")) throw new Error("可选择的 List 必须有 aria-label");
  const listRef = useRef<HTMLUListElement>(null);
  const [focusValue, setFocusValue] = useState<string | null>(null);
  // 不能用 AnimatePresence 的 initial={false} 关掉首屏入场：它会让行里之后才挂载的元素也永远跳过入场
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
  }, []);
  const rows = Children.toArray(children).map((child) => {
    if (!isValidElement(child)) throw new Error("List 的子项只能是行（ListRow 或包着它的组件），不能直接放文字");
    return child;
  });
  // 和上一次提交相比新来了几行：太多时逐行入场不划算，整个列表淡入一次
  const keys = rows.map((row) => row.key);
  const shownKeys = useRef(keys);
  const previous = new Set(shownKeys.current);
  const crowded = keys.filter((key) => !previous.has(key)).length > ROW_MOTION_LIMIT;
  const entering = mounted.current && !crowded;
  const [, animateList] = useAnimate<HTMLUListElement>();
  useLayoutEffect(() => {
    shownKeys.current = keys;
    const list = listRef.current;
    if (!crowded || list === null) return;
    // 透明度先在提交时压到 0，首帧就看不到整批新行一闪
    list.style.opacity = "0";
    void animateList(list, { opacity: [0, 1] }, fade.in);
  });
  // 行增删、变高变矮时其余行从原位置滑过去。回调必须稳定：每次渲染换一个会拆掉重建观察，丢掉旧位置
  const attach = useCallback((el: HTMLUListElement | null) => {
    listRef.current = el;
    if (el === null) return;
    const stop = observeReflow(el);
    return () => {
      listRef.current = null;
      stop();
    };
  }, []);

  let context: ListContextValue = { variant, select: null, entering };
  if (select !== undefined) {
    const values = optionValues(children);
    const preferred = [focusValue, select.selected].find((v): v is string => v !== null && values.includes(v));
    const tabStop = preferred !== undefined ? preferred : values.length > 0 ? values[0] : null;
    const focus = (value: string) => {
      setFocusValue(value);
      const list = listRef.current;
      if (list === null) throw new Error("List 尚未挂载");
      const target = [...list.querySelectorAll<HTMLElement>(LIVE_OPTION)].find((el) => el.dataset.value === value);
      if (target === undefined) throw new Error(`List 里找不到 value 为 ${value} 的选项`);
      target.focus();
    };
    context = { variant, select: { ...select, tabStop, focus }, entering };
  }

  const onKeyDown = (event: KeyboardEvent<HTMLUListElement>) => {
    const sel = context.select;
    if (sel === null || !(event.target instanceof HTMLElement)) return;
    const list = listRef.current;
    const current = event.target.closest<HTMLElement>('[role="option"]');
    if (list === null || current === null || current.parentElement !== list) return;
    const options = [...list.querySelectorAll<HTMLElement>(`${LIVE_OPTION}:not([aria-disabled="true"])`)];
    const index = options.indexOf(current);
    let next: HTMLElement | undefined;
    switch (event.key) {
      case "ArrowDown":
        next = options[Math.min(index + 1, options.length - 1)];
        break;
      case "ArrowUp":
        next = options[Math.max(index - 1, 0)];
        break;
      case "Home":
        next = options[0];
        break;
      case "End":
        next = options[options.length - 1];
        break;
      case "Enter":
      case " ": {
        event.preventDefault();
        if (current.getAttribute("aria-disabled") === "true") return;
        sel.onSelect(optionValue(current));
        return;
      }
      default:
        return;
    }
    event.preventDefault();
    if (next !== undefined) sel.focus(optionValue(next));
  };

  return (
    <ListContext.Provider value={context}>
      <ul
        ref={attach}
        className={cx(styles.list, className)}
        data-variant={variant}
        role={select === undefined ? undefined : "listbox"}
        aria-label={label}
        onKeyDown={select === undefined ? undefined : onKeyDown}
      >
        <AnimatePresence mode="popLayout">
          {rows.map((row) => (
            // toArray 给每个元素补上键（调用方的 key 加前缀，静态子项按位置）：presence 靠它认出谁走了、谁新来
            <RowSlot key={row.key}>{row}</RowSlot>
          ))}
        </AnimatePresence>
      </ul>
    </ListContext.Provider>
  );
}

function optionValue(el: HTMLElement): string {
  const value = el.dataset.value;
  if (value === undefined) throw new Error("listbox 选项缺少 data-value");
  return value;
}

export interface ListRowProps {
  title: ReactNode;
  /** 元信息（md / lg）：次级色，单行省略。 */
  meta?: ReactNode;
  /** 前导：sm 24-28、md 36-40、lg 44 的头像或图标。 */
  leading?: ReactNode;
  /** 尾部：元信息文字，或至多 2 个小号图标按钮（其余进「更多」菜单）。 */
  trailing?: ReactNode;
  /** lg 档元信息下方的小号进度条。 */
  progress?: ReactNode;
  size?: ListRowSize;
  selected?: boolean;
  /** 内容失效（停用、已撤销）：前导与主体淡化，尾部操作不变。 */
  inactive?: boolean;
  disabled?: boolean;
  /** 整行可点；在可选择的列表里不用它，选中经 List 的 onSelect 回报。 */
  onClick?: () => void;
  /** 可见标题不足以说明点击目标时的完整名称。 */
  ariaLabel?: string;
  /** 可选择列表里的取值，必填且唯一。 */
  value?: string;
  className?: string;
}

export function ListRow({
  title,
  meta,
  leading,
  trailing,
  progress,
  size = "md",
  selected = false,
  inactive = false,
  disabled = false,
  onClick,
  ariaLabel,
  value,
  className,
}: ListRowProps) {
  const list = useContext(ListContext);
  const slotRef = useContext(RowSlotContext);
  const present = useIsPresent();
  if (list === null) throw new Error("ListRow 必须放在 List 里");
  // 行自己的进出场。退场时留在原处淡出，这段时间它已经不是列表的一行：不接受指针与焦点，读屏不再读到
  const item = {
    ref: slotRef,
    className: cx(styles.item, className),
    inert: !present,
    initial: list.entering ? insertItem.initial : false,
    animate: insertItem.animate,
    exit: insertItem.exit,
  } as const;
  // inert 在真机上已经挡住指针；这里再断开回调，连点两下时第二下落在正退场的行上也不会再触发一次
  const activate = present ? onClick : undefined;
  const rowData = {
    "data-size": size,
    "data-variant": list.variant,
    "data-selected": selected || undefined,
    "data-inactive": inactive || undefined,
    "data-disabled": disabled || undefined,
  };
  const body = (titleNode: ReactNode) => (
    <>
      {leading !== undefined && <span className={styles.leading}>{leading}</span>}
      <span className={styles.body}>
        <span className={styles.title}>{titleNode}</span>
        {meta !== undefined && <span className={styles.meta}>{meta}</span>}
        {progress !== undefined && <span className={styles.progress}>{progress}</span>}
      </span>
      {trailing !== undefined && <span className={styles.trailing}>{trailing}</span>}
    </>
  );

  const select = list.select;
  if (select !== null) {
    if (value === undefined) throw new Error("可选择列表里的 ListRow 必须有 value");
    if (onClick !== undefined) throw new Error("可选择列表里的 ListRow 不用 onClick，选中经 List 的 onSelect 回报");
    const isSelected = select.selected === value;
    return (
      <motion.li
        {...item}
        role="option"
        data-value={value}
        aria-selected={isSelected}
        aria-disabled={disabled || undefined}
        aria-label={ariaLabel}
        tabIndex={!disabled && select.tabStop === value ? 0 : -1}
        onFocus={(event) => {
          if (event.target === event.currentTarget && !disabled && present) select.focus(value);
        }}
        onClick={() => {
          if (disabled || !present) return;
          select.focus(value);
          select.onSelect(value);
        }}
      >
        <div className={styles.row} {...rowData} data-selected={isSelected || undefined} data-interactive="">
          {body(title)}
        </div>
      </motion.li>
    );
  }

  if (onClick !== undefined && trailing === undefined) {
    return (
      <motion.li {...item}>
        <button type="button" className={styles.row} {...rowData} data-interactive="" disabled={disabled} aria-label={ariaLabel} onClick={activate}>
          {body(title)}
        </button>
      </motion.li>
    );
  }

  if (onClick !== undefined) {
    return (
      <motion.li {...item}>
        <div className={styles.row} {...rowData} data-interactive="" data-overlay="">
          {body(
            <button type="button" className={styles.titleButton} disabled={disabled} aria-label={ariaLabel} onClick={activate}>
              {title}
            </button>,
          )}
        </div>
      </motion.li>
    );
  }

  return (
    <motion.li {...item}>
      <div className={styles.row} {...rowData}>
        {body(title)}
      </div>
    </motion.li>
  );
}
