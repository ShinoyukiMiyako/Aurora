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
// 行的增删：List 挂载之后新增的行淡入并从略小处落到位，只有落在可见范围附近的才播，远处的直接出现
// （换了一批、新来的又太多时改为整个列表淡入一次）；被删的行脱离布局原地淡出，其余行滑到新位置。
// 页面只管换 children（给稳定的 key），不用为进出场做任何事；行被页面自己的组件包着也一样。

import { AnimatePresence, motion, useAnimate, useIsPresent } from "framer-motion";
import { Children, createContext, isValidElement, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode, type Ref } from "react";
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
}

const ListContext = createContext<ListContextValue | null>(null);

interface RowSlotValue {
  /** popLayout 塞进来的 ref，交给行自己的 li。 */
  ref: Ref<HTMLLIElement> | undefined;
  /** 这一行挂载时播入场：列表挂载之后才来、又落在可见范围附近。挂载时就在的行跟着所在页面的入场走。 */
  entering: boolean;
}

/**
 * AnimatePresence 的 popLayout 往直接子项上塞 ref，量尺寸、把退场的行抽出布局。直接子项常是页面自己包行的组件，
 * 它们不会把 ref 接到 li 上：List 给每个子项套一层 RowSlot，ref 经上下文交给行自己的 li。这一行要不要播入场也由它带下去。
 */
const RowSlotContext = createContext<RowSlotValue | null>(null);

function RowSlot({ children, ref, entering }: { children: ReactNode; ref?: Ref<HTMLLIElement>; entering: boolean }) {
  const value = useMemo(() => ({ ref, entering }), [ref, entering]);
  return <RowSlotContext.Provider value={value}>{children}</RowSlotContext.Provider>;
}

/** 在场的选项；退场中的行（inert）还在文档里淡出，键盘不该停上去。 */
const LIVE_OPTION = ':scope > [role="option"]:not([inert])';

/** 一次新增超过这么多行、又不是在末尾追加时不逐行入场：行直接换上，整个列表淡入一次（与 Table 同一口径）。 */
export const ROW_MOTION_LIMIT = 40;

/**
 * 可见范围上下各多留这么多行。一次变化里只有落在这之内的行逐行动画（新行的入场、表格行的让位）：
 * 再远的在视口之外，直接到位看不出差别，也省掉逐行测量与起动画。余量盖住估算误差和标题栏一类遮挡。
 */
export const ROW_WINDOW_MARGIN = 4;

/** 行号范围，含两端。 */
export interface RowWindow {
  first: number;
  last: number;
}

/** 量不出可见范围（还没有布局：组件测试的 jsdom，或祖先 display: none）时按每一行都在范围内处理。 */
export const EVERY_ROW: RowWindow = { first: -Infinity, last: Infinity };

/**
 * 等距排开的行里，落在可见带 [clipTop, clipBottom] 之内的行号，上下各多留 ROW_WINDOW_MARGIN 行。
 * top 是第 0 行的上沿，pitch 是相邻两行上沿的间距，与可见带同一坐标系（视口坐标）。整块在可见带之外时范围为空或只剩余量。
 */
export function rowWindow(top: number, clipTop: number, clipBottom: number, pitch: number): RowWindow {
  if (!(pitch > 0)) throw new Error(`行距必须是正数，收到 ${pitch}`);
  return {
    first: Math.floor((clipTop - top) / pitch) - ROW_WINDOW_MARGIN,
    last: Math.ceil((clipBottom - top) / pitch) - 1 + ROW_WINDOW_MARGIN,
  };
}

/** 这次只是在末尾追加：上一次的行都还在，原样排在最前面。追加时已有的行一动不动，不算换了一批。 */
export function appendsOnly<K>(previous: readonly K[], next: readonly K[]): boolean {
  return previous.length > 0 && next.length > previous.length && previous.every((key, i) => next[i] === key);
}

/**
 * 一次变化里要逐行动画的行：新来的行里新位置在范围内的（播入场），前后都在、位置变了的行里旧位置或新位置在范围内的（走让位）。
 * 位置按行号算，行等高时与像素位置一一对应。
 */
export function rowsInWindow<K>(previous: readonly K[], next: readonly K[], window: RowWindow): { entering: Set<K>; moving: Set<K> } {
  const inside = (index: number) => index >= window.first && index <= window.last;
  const was = new Map(previous.map((key, i) => [key, i]));
  const entering = new Set<K>();
  const moving = new Set<K>();
  next.forEach((key, i) => {
    const from = was.get(key);
    if (from === undefined) {
      if (inside(i)) entering.add(key);
    } else if (from !== i && (inside(from) || inside(i))) moving.add(key);
  });
  return { entering, moving };
}

/**
 * 列表此刻露在视口里的行号范围，只在行集合变化的那一刻量一次。同一个列表里的行同高：上一次的总高按行数均分成行距
 * （行间的缝也算进去）。上一次没有行时无从估算，按全部在范围内处理。
 */
function listWindow(list: HTMLUListElement | null, count: number): RowWindow {
  if (list === null) throw new Error("List 尚未挂载");
  const view = list.ownerDocument.defaultView;
  if (view === null) throw new Error("List 不在文档窗口里");
  if (count === 0) return EVERY_ROW;
  const rect = list.getBoundingClientRect();
  if (rect.height === 0) return EVERY_ROW;
  return rowWindow(rect.top, 0, view.innerHeight, rect.height / count);
}

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
  // 和上一次提交相比新来了几行。换了一批（首次填充、整体换掉、换了条件）又来得太多时，逐行入场不划算，整个列表淡入一次；
  // 只是在末尾追加时已有的行原样留着、不跟着闪，新行里只有可见范围附近的播入场
  const keys = rows.map((row) => row.key);
  const shownKeys = useRef(keys);
  const previous = shownKeys.current;
  const before = new Set(previous);
  const added = keys.filter((key) => !before.has(key)).length;
  const crowded = added > ROW_MOTION_LIMIT && !appendsOnly(previous, keys);
  const entering = !mounted.current || crowded || added === 0 ? null : rowsInWindow(previous, keys, listWindow(listRef.current, previous.length)).entering;
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

  let context: ListContextValue = { variant, select: null };
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
    context = { variant, select: { ...select, tabStop, focus } };
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
            <RowSlot key={row.key} entering={entering !== null && entering.has(row.key)}>
              {row}
            </RowSlot>
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
  const slot = useContext(RowSlotContext);
  const present = useIsPresent();
  if (list === null || slot === null) throw new Error("ListRow 必须放在 List 里");
  // 行自己的进出场。退场时留在原处淡出，这段时间它已经不是列表的一行：不接受指针与焦点，读屏不再读到
  const item = {
    ref: slot.ref,
    className: cx(styles.item, className),
    inert: !present,
    initial: slot.entering ? insertItem.initial : false,
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
