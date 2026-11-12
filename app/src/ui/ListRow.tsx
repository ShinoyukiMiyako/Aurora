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
// 行的增删：List 挂载之后新增的行淡入并从略小处落到位，只有落在可见范围附近的才播，远处的直接出现；
// 被删的行脱离布局原地淡出，其余行滑到新位置。换了一批、新来的又太多时整批换上：新行只淡入，已在场的行直接到位、不滑，
// 被换掉的行直接拿掉；原先一行也没有时改为整个列表淡入一次。
// 页面只管换 children（给稳定的 key），不用为进出场做任何事；行被页面自己的组件包着也一样。

import { AnimatePresence, motion, useIsPresent } from "framer-motion";
import { Children, createContext, isValidElement, useCallback, useContext, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode, type Ref } from "react";
import { fade, insertItemFade } from "../lib/motion";
import { observeReflow, REFLOW_PAUSED_ATTR } from "../lib/reflow";
import { playTween } from "../lib/slide";
import { useInsertItem } from "../lib/useInsertItem";
import { useMounted } from "../lib/useMounted";
import { cx } from "../lib/util";
import { appendsOnly, EVERY_ROW, measuredRowWindow, ROW_MOTION_LIMIT, rowsInWindow, rowWindow, type RowWindow } from "./ListRow.window";
import styles from "./ListRow.module.css";

export { appendsOnly, EVERY_ROW, measuredRowWindow, ROW_MOTION_LIMIT, ROW_WINDOW_MARGIN, rowsInWindow, rowWindow, type RowEdges, type RowWindow } from "./ListRow.window";

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
  /**
   * 这一次是整批换上。这时退场的行直接拿掉：新行就落在它们腾出的位置上淡入，两层文字叠着交叉淡化看不清。
   * 走上下文而不是行自己的属性：退场的行留着的是它最后一次的属性，上下文变了它照样重渲染。
   */
  swapping: boolean;
}

const ListContext = createContext<ListContextValue | null>(null);

/** 整批换上时退场的行：不播淡出，直接拿掉。 */
const SWAP_EXIT = { opacity: 0, transition: fade.none } as const;

/**
 * 一行挂载时怎么入场。none：不播（挂载时就在、或落在可见范围之外）；item：按增删参数淡入并从略小处落到位；
 * fade：换了一批时整批的新行，只淡入。
 */
type RowEnter = "none" | "item" | "fade";

interface RowSlotValue {
  /** popLayout 塞进来的 ref，交给行自己的 li。 */
  ref: Ref<HTMLLIElement> | undefined;
  /** 这一行挂载时怎么入场：列表挂载之后才来、又落在可见范围附近的才播。挂载时就在的行跟着所在页面的入场走。 */
  enter: RowEnter;
}

/**
 * AnimatePresence 的 popLayout 往直接子项上塞 ref，量尺寸、把退场的行抽出布局。直接子项常是页面自己包行的组件，
 * 它们不会把 ref 接到 li 上：List 给每个子项套一层 RowSlot，ref 经上下文交给行自己的 li。这一行要不要播入场也由它带下去。
 */
const RowSlotContext = createContext<RowSlotValue | null>(null);

function RowSlot({ children, ref, enter }: { children: ReactNode; ref?: Ref<HTMLLIElement>; enter: RowEnter }) {
  const value = useMemo(() => ({ ref, enter }), [ref, enter]);
  return <RowSlotContext.Provider value={value}>{children}</RowSlotContext.Provider>;
}

/** 在场的选项；退场中的行（inert）还在文档里淡出，键盘不该停上去。 */
const LIVE_OPTION = ':scope > [role="option"]:not([inert])';
/** 在场的行，同上。 */
const LIVE_ROW = ":scope > li:not([inert])";

/**
 * 列表此刻露在视口里的行号范围，只在行集合变化的那一刻量一次。按在场的行各自的上下沿二分查找，行高不一也不累积偏差；
 * 视口越过末行的部分按平均行距（行间的缝也算进去）推算。在场的行与上一次的行数对不上（页面把一行包成了别的结构）时
 * 整段按平均行距估。上一次没有行、或量不到布局时按全部在范围内处理。
 */
function listWindow(list: HTMLUListElement | null, count: number): RowWindow {
  if (list === null) throw new Error("List 尚未挂载");
  const view = list.ownerDocument.defaultView;
  if (view === null) throw new Error("List 不在文档窗口里");
  if (count === 0) return EVERY_ROW;
  const rect = list.getBoundingClientRect();
  if (rect.height === 0) return EVERY_ROW;
  const pitch = rect.height / count;
  const rows = list.querySelectorAll<HTMLElement>(LIVE_ROW);
  if (rows.length !== count) return rowWindow(rect.top, 0, view.innerHeight, pitch);
  return measuredRowWindow(count, (index) => rows[index].getBoundingClientRect(), 0, view.innerHeight, pitch);
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
  const mounted = useMounted();
  const rows = Children.toArray(children).map((child) => {
    if (!isValidElement(child)) throw new Error("List 的子项只能是行（ListRow 或包着它的组件），不能直接放文字");
    return child;
  });
  // 和上一次提交相比新来了几行，新行里只有可见范围附近的播入场。只是在末尾追加时已有的行原样留着，照常逐行入场。
  // 换了一批（首次填充、整体换掉、换了条件）又来得太多时整批换上：新行只淡入，不从略小处落位；已在场的行被挤到哪就直接在哪，
  // 这一趟的让位暂停，几十行同时滑看不清谁在动，挤动的距离也可能长到几屏
  const keys = rows.map((row) => row.key);
  const shownKeys = useRef(keys);
  const previous = shownKeys.current;
  const before = new Set(previous);
  const added = keys.filter((key) => !before.has(key)).length;
  const crowded = added > ROW_MOTION_LIMIT && !appendsOnly(previous, keys);
  // 原先一行也没有时整个列表淡入一次：没有已在场的行会跟着闪，也省得几十上百行各起一段透明度动画
  const wholeFade = crowded && previous.length === 0;
  const entering = !mounted.current || added === 0 || wholeFade ? null : rowsInWindow(previous, keys, listWindow(listRef.current, previous.length)).entering;
  const newRow: RowEnter = crowded ? "fade" : "item";
  useLayoutEffect(() => {
    shownKeys.current = keys;
    const list = listRef.current;
    if (!crowded || list === null) return;
    // 暂停只盖住这一批：同一个任务里打上又撤掉，观察者把这一趟收作暂停（开关的增删本身就按暂停处理）。
    // 留到下一次渲染才撤的话，这期间行内自己引起的尺寸变化、撤掉的那一趟里同时发生的增删都会被一并吞掉，不再滑
    list.setAttribute(REFLOW_PAUSED_ATTR, "");
    list.removeAttribute(REFLOW_PAUSED_ATTR);
    // 组件测试的 jsdom 没有 Web Animations
    if (wholeFade && typeof list.animate === "function") playTween(list, [{ opacity: 0 }, { opacity: 1 }], fade.in);
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

  let context: ListContextValue = { variant, select: null, swapping: crowded };
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
    context = { variant, select: { ...select, tabStop, focus }, swapping: crowded };
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
            <RowSlot key={row.key} enter={entering !== null && entering.has(row.key) ? newRow : "none"}>
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
  const motionSet = useInsertItem();
  if (list === null || slot === null) throw new Error("ListRow 必须放在 List 里");
  // 行自己的进出场。退场时留在原处淡出，这段时间它已经不是列表的一行：不接受指针与焦点，读屏不再读到
  const item = {
    ref: slot.ref,
    className: cx(styles.item, className),
    inert: !present,
    initial: slot.enter === "none" ? false : slot.enter === "fade" ? insertItemFade.initial : motionSet.initial,
    animate: motionSet.animate,
    exit: list.swapping ? SWAP_EXIT : motionSet.exit,
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
