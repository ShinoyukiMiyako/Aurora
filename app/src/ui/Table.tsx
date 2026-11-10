// 表格：多列可比属性、行数可能很多的数据（Mod 列表为首要用途）。少于 3 个可比属性用 ListRow。
// 放在无内边距的卡片里，上方由页面放工具条；表头吸顶，不透明底遮住滚过的行。
//
// 键盘：整张表是 grid，行用漫游 tabindex——Tab 只停在当前行，↑↓ / Home / End 在行间移动，
// Enter 执行行的主动作，Space 切换行选择，再按 Tab 进入当前行的行内控件。非当前行的行内控件
// 统一退出 Tab 序列，否则几百行的开关与按钮会让 Tab 走不出表格。
// 行高只有两档且固定：超过 100 行时虚拟化，固定行高才能不经测量直接定位。
// 列按尺寸档显示或隐藏，档位由 <html data-sk-tier> 决定，组件不需要在脚本里知道当前档。
// 选择、排序的状态都由页面持有：组件只渲染并回报，批量操作条也由页面替换工具条。
// 行的增删：被删的行脱离布局原地淡出，其余行靠布局动画让位；页面只管换 rows，不用为退场做任何事。
// 被挤动的行里只有可见范围附近的那一小段走让位，新行也只有那一段播入场，远处的直接到位：几十行的表删一行不再整表闪一下。
// 筛到零行时空状态与行在同一个 AnimatePresence 里互换，同样淡入淡出。

import { useVirtualizer } from "@tanstack/react-virtual";
import { AnimatePresence, motion, useAnimate, useIsPresent, useReducedMotionConfig, type HTMLMotionProps, type Variants } from "framer-motion";
import { useLayoutEffect, useRef, useState, type FocusEvent, type KeyboardEvent, type MouseEvent, type ReactNode } from "react";
import { Icon } from "../art/Icon";
import { fade, springs } from "../lib/motion";
import { useMounted } from "../lib/useMounted";
import { cssVars, cx } from "../lib/util";
import type { TierName } from "./Card";
import { appendsOnly, EVERY_ROW, ROW_MOTION_LIMIT, rowsInWindow, rowWindow, type RowWindow } from "./ListRow.window";
import styles from "./Table.module.css";

export type TableDensity = "regular" | "compact";
export type SortDirection = "asc" | "desc";
export type TableSelectionState = "none" | "some" | "all";

export interface TableSort {
  key: string;
  direction: SortDirection;
}

export interface TableCellContext {
  selected: boolean;
  toggleSelected: () => void;
}

export interface TableHeaderContext {
  /** 全选框的三态。 */
  selection: TableSelectionState;
  toggleAll: () => void;
}

export interface TableColumn<T> {
  key: string;
  /** 表头内容；选择列传函数，拿到全选状态渲染三态复选框。 */
  header: ReactNode | ((ctx: TableHeaderContext) => ReactNode);
  /** 固定宽（px）；不给为弹性列。 */
  width?: number;
  /** 弹性列的最小宽（px）。 */
  minWidth?: number;
  align?: "start" | "center" | "end";
  sortable?: boolean;
  /** 在哪些尺寸档显示；不给为全部显示。 */
  tiers?: readonly TierName[];
  /** 内容失效的行里仍保持不透明（开关与操作列）。 */
  keepOpaque?: boolean;
  /** 单元格内容；返回字符串或数字时按单行省略处理。 */
  cell: (row: T, ctx: TableCellContext) => ReactNode;
}

export interface TableSelection {
  selected: ReadonlySet<string>;
  onChange: (next: ReadonlySet<string>) => void;
}

export interface TableProps<T> {
  /** 表格的可访问名称。 */
  label: string;
  columns: readonly TableColumn<T>[];
  rows: readonly T[];
  rowKey: (row: T) => string;
  /** regular 64（两行内容）/ compact 44（单行）。 */
  density?: TableDensity;
  /** 行的主动作（打开详情）：Enter 或点击行内非控件处触发。 */
  onActivate?: (row: T) => void;
  selection?: TableSelection;
  sort?: TableSort | null;
  /** 有可排序列时必填。点同一列翻转方向，点另一列按升序。 */
  onSortChange?: (next: TableSort) => void;
  /** 内容失效的行（停用的 Mod）：文字列淡化、缩略图去色，开关与操作列不变。 */
  isInactive?: (row: T) => boolean;
  /** 空表时放在表体里的内容（紧凑的空状态）。 */
  empty: ReactNode;
  className?: string;
}

export const ROW_HEIGHT: Readonly<Record<TableDensity, number>> = { regular: 64, compact: 44 };
export const HEADER_HEIGHT = 36;
/** 超过这个行数开启虚拟化。 */
export const VIRTUALIZE_ABOVE = 100;

const TIERS: readonly TierName[] = ["compact", "regular", "wide"];
const ROW_FOCUSABLE = 'button, a[href], input, select, textarea, [tabindex], [data-table-tabindex]';
const DEMOTED_ATTR = "data-table-tabindex";
/** 点击行内这些元素时不触发行的主动作。 */
const ROW_CONTROLS = 'button, a[href], input, select, textarea, label, [role="switch"], [role="checkbox"], [role="button"]';

const visibleIn = <T,>(column: TableColumn<T>, tier: TierName) => column.tiers === undefined || column.tiers.includes(tier);

/**
 * 某一档显示的列，按定义的顺序。照表格画同尺寸骨架的页面用它取列，不要自己再按 tiers 判断一遍：规则一改，骨架就会和表格错位。
 */
export function visibleColumns<T>(columns: readonly TableColumn<T>[], tier: TierName): TableColumn<T>[] {
  return columns.filter((c) => visibleIn(c, tier));
}

/** 某一档的列模板：固定列写像素宽，弹性列按最小宽分剩余空间。 */
export function columnTemplate<T>(columns: readonly TableColumn<T>[], tier: TierName): string {
  return visibleColumns(columns, tier)
    .map((c) => (c.width !== undefined ? `${c.width}px` : `minmax(${c.minWidth === undefined ? 0 : c.minWidth}px, 1fr)`))
    .join(" ");
}

export function validateColumns<T>(columns: readonly TableColumn<T>[]): void {
  const keys = new Set<string>();
  for (const c of columns) {
    if (keys.has(c.key)) throw new Error(`Table 列 key 重复：${c.key}`);
    keys.add(c.key);
    if (c.width !== undefined && !(c.width > 0)) throw new Error(`Table 列 ${c.key} 的宽度必须为正数`);
    if (c.minWidth !== undefined && !(c.minWidth >= 0)) throw new Error(`Table 列 ${c.key} 的最小宽不能为负`);
    if (c.tiers !== undefined && c.tiers.length === 0) throw new Error(`Table 列 ${c.key} 的 tiers 不能为空；任何档都不显示的列不要放进来`);
  }
  for (const tier of TIERS) {
    if (!columns.some((c) => visibleIn(c, tier))) throw new Error(`Table 在 ${tier} 档没有可见的列`);
  }
}

export function selectionState(selected: ReadonlySet<string>, keys: readonly string[]): TableSelectionState {
  const count = keys.filter((k) => selected.has(k)).length;
  if (count === 0) return "none";
  return count === keys.length ? "all" : "some";
}

/** 点表头后的排序：同一列翻转方向，另一列从升序开始。 */
export function nextSort(current: TableSort | null | undefined, key: string): TableSort {
  if (current !== null && current !== undefined && current.key === key) return { key, direction: current.direction === "asc" ? "desc" : "asc" };
  return { key, direction: "asc" };
}

/** 一次变化涉及多少行：增删的行数；行集合没变时是换了位置的行数。增删带来的让位不算，那正是布局动画要做的。 */
export function rowChurn(previous: readonly string[], next: readonly string[]): number {
  const before = new Set(previous);
  const after = new Set(next);
  const changed = next.filter((k) => !before.has(k)).length + previous.filter((k) => !after.has(k)).length;
  return changed > 0 ? changed : next.filter((k, i) => previous[i] !== k).length;
}

/** 前后都在、但下标变了的行数：被挤动的行。其中只有可见范围附近的量布局、走让位（见 rowsInWindow）。 */
export function rowShift(previous: readonly string[], next: readonly string[]): number {
  const before = new Map(previous.map((k, i) => [k, i]));
  let moved = 0;
  next.forEach((k, i) => {
    const was = before.get(k);
    if (was !== undefined && was !== i) moved++;
  });
  return moved;
}

export interface TableShape {
  keys: readonly string[];
  virtual: boolean;
}

/**
 * 这次变化是否整表换上：行不逐个淡入淡出，表体淡入一次。只留给真正换了一批数据的时候（排序、换筛选、整体刷新）。
 * - 虚拟化的行按下标绝对定位，没有退场也没有让位：行集合或顺序一变就整表换，不让被删行之后的行一帧跳上来。
 * - 跨过虚拟化阈值时两种渲染互换，同样整表换。
 * - 不虚拟化时，增删换位的行超过上限、又不是在末尾追加时才整表换。被挤动的行不计：删掉靠前的一行时其后几十行都被挤动，
 *   但只有可见范围附近的那一小段量布局、走让位，测量与动画的量由视口高度封顶，不随表格行数增长。
 */
export function swapsWholeTable(previous: TableShape, next: TableShape): boolean {
  const churn = rowChurn(previous.keys, next.keys);
  if (previous.virtual || next.virtual) return churn > 0;
  return churn > ROW_MOTION_LIMIT && !appendsOnly(previous.keys, next.keys);
}

/**
 * 表体此刻露在视口里的行号范围，只在行集合或顺序变化的那一刻量一次。可见带取表格（自己的滚动区，限高时）与窗口的交集；
 * 行高固定，表体上沿加行号乘行高就是每行的位置。
 */
function tableWindow(table: HTMLElement | null, body: HTMLElement | null, rowHeight: number): RowWindow {
  if (table === null || body === null) throw new Error("Table 尚未挂载");
  const view = table.ownerDocument.defaultView;
  if (view === null) throw new Error("Table 不在文档窗口里");
  const clip = table.getBoundingClientRect();
  if (clip.height === 0) return EVERY_ROW;
  return rowWindow(body.getBoundingClientRect().top, Math.max(clip.top, 0), Math.min(clip.bottom, view.innerHeight), rowHeight);
}

/** 两次的行是否同一批、同一个顺序。 */
function sameRows(previous: readonly string[], next: readonly string[]): boolean {
  return previous.length === next.length && previous.every((key, i) => next[i] === key);
}

/** 上一次提交时的行，以及每行的布局令牌。 */
interface Shown extends TableShape {
  /**
   * 每行的 layoutDependency。framer-motion 只在它变了的那次提交前量这一行的旧位置：这一次要走让位的行换成新令牌，
   * 其余沿用旧值，被挤动了也不量、直接到位。
   */
  tokens: ReadonlyMap<string, number>;
  /** 行集合或顺序变了几次；新令牌就取它。 */
  seq: number;
}

const NO_ROWS: ReadonlySet<string> = new Set();

/** 这一次的布局令牌：要走让位的行换成 seq，其余沿用旧值。新来的行挂载时不量布局，令牌取什么都一样，也给 seq。 */
function nextTokens(held: ReadonlyMap<string, number>, keys: readonly string[], moving: ReadonlySet<string>, seq: number): Map<string, number> {
  const tokens = new Map<string, number>();
  for (const key of keys) {
    const was = held.get(key);
    tokens.set(key, was === undefined || moving.has(key) ? seq : was);
  }
  return tokens;
}

/** full 淡入淡出带缩放；fade 减少动画时只留透明度；none 一次变化太多，行直接换上。 */
type RowMotion = "full" | "fade" | "none";

const ROW_VARIANTS: Variants = {
  hidden: (motion: RowMotion) => (motion === "none" ? { opacity: 1, scale: 1 } : motion === "fade" ? { opacity: 0, scale: 1 } : { opacity: 0, scale: 0.98 }),
  show: { opacity: 1, scale: 1, transition: { ...springs.settle, opacity: fade.in } },
  leave: (motion: RowMotion) => (motion === "none" ? { opacity: 0, transition: fade.none } : { opacity: 0, scale: motion === "fade" ? 1 : 0.98, transition: fade.out }),
};

interface PresenceRowProps extends HTMLMotionProps<"div"> {
  index: number;
  rowMotion: RowMotion;
  /** 这一行挂载时播入场：表格挂载之后才来、又落在可见范围附近。挂载时就在的行跟着所在页面的入场走。 */
  entering: boolean;
  /** 布局令牌：只在这一次要走让位时换新值。 */
  layoutToken: number;
}

/**
 * 不虚拟化的一行。退场时留在原处淡出，这段时间它已经不是表格的一行：不再带序号（键盘移动按序号找行），
 * 也不接受指针与焦点，读屏不再读到。
 * 只有令牌变了的行才量布局（layoutDependency 取令牌）：删掉一行时它前面的行、离视口远的行都不量，直接到位；
 * 窗口缩放、分档切换引起的重渲染不触发布局动画。layout 常开：framer-motion 只在挂载时登记布局动画，
 * 挂载时关着的行之后再打开也不会动。
 */
function PresenceRow({ index, rowMotion, entering, layoutToken, tabIndex, ...rest }: PresenceRowProps) {
  const present = useIsPresent();
  return (
    <motion.div
      {...rest}
      data-row-index={present ? index : undefined}
      tabIndex={present ? tabIndex : -1}
      inert={!present}
      custom={rowMotion}
      variants={ROW_VARIANTS}
      initial={entering ? "hidden" : false}
      animate="show"
      exit="leave"
      layout="position"
      layoutDependency={layoutToken}
      transition={{ layout: springs.settle }}
    />
  );
}

interface PresenceEmptyProps extends Omit<HTMLMotionProps<"div">, "children"> {
  rowMotion: RowMotion;
  entering: boolean;
  children: ReactNode;
}

/** 空表时表体里的空状态。与行同在一个 AnimatePresence 里：筛到零行时剩下的行照常淡出，空状态淡入；反过来也一样。 */
function PresenceEmpty({ rowMotion, entering, children, ...rest }: PresenceEmptyProps) {
  const present = useIsPresent();
  return (
    <motion.div
      {...rest}
      role="row"
      className={styles.emptyRow}
      inert={!present}
      custom={rowMotion}
      variants={ROW_VARIANTS}
      initial={entering ? "hidden" : false}
      animate="show"
      exit="leave"
    >
      <div role="gridcell" className={styles.empty}>
        {children}
      </div>
    </motion.div>
  );
}

/** 空状态在 AnimatePresence 里的键：行键来自调用方，控制字符开头的键不会与之相撞。 */
const EMPTY_ROW_KEY = "\u0000empty";

/**
 * 非当前行的行内控件退出 Tab 序列；回到当前行时恢复原值。原值记在 data-table-tabindex 上。
 * 只管带行号的数据行：空状态那一行不参与漫游 tabindex，里面的「清除筛选」这类按钮要一直能 Tab 到；
 * 退场中的行已经 inert，也不用管。
 */
function syncRowTabStops(body: HTMLElement) {
  for (const row of body.querySelectorAll<HTMLElement>(':scope > [role="row"][data-row-index]')) {
    const active = row.tabIndex === 0;
    for (const el of row.querySelectorAll<HTMLElement>(ROW_FOCUSABLE)) {
      const saved = el.getAttribute(DEMOTED_ATTR);
      if (active && saved !== null) {
        el.removeAttribute(DEMOTED_ATTR);
        if (saved === "") el.removeAttribute("tabindex");
        else el.setAttribute("tabindex", saved);
      } else if (!active && saved === null) {
        const original = el.getAttribute("tabindex");
        el.setAttribute(DEMOTED_ATTR, original === null ? "" : original);
        el.setAttribute("tabindex", "-1");
      }
    }
  }
}

export function Table<T>({
  label,
  columns,
  rows,
  rowKey,
  density = "regular",
  onActivate,
  selection,
  sort,
  onSortChange,
  isInactive,
  empty,
  className,
}: TableProps<T>) {
  validateColumns(columns);
  if (columns.some((c) => c.sortable === true) && onSortChange === undefined) throw new Error("Table 有可排序列时必须给出 onSortChange");

  const scrollRef = useRef<HTMLDivElement>(null);
  const [bodyRef, animateBody] = useAnimate<HTMLDivElement>();
  const [active, setActive] = useState(0);
  const pendingFocus = useRef<number | null>(null);
  const rowHeight = ROW_HEIGHT[density];
  const virtual = rows.length > VIRTUALIZE_ABOVE;
  const keys = rows.map(rowKey);
  if (new Set(keys).size !== keys.length) throw new Error("Table 的 rowKey 必须唯一");
  const activeIndex = rows.length === 0 ? -1 : Math.min(active, rows.length - 1);

  const reduced = useReducedMotionConfig() === true;
  const shown = useRef<Shown | null>(null);
  if (shown.current === null) shown.current = { keys, virtual, tokens: new Map(keys.map((key) => [key, 0])), seq: 0 };
  const before = shown.current;
  const changed = before.virtual !== virtual || !sameRows(before.keys, keys);
  const crowded = swapsWholeTable(before, { keys, virtual });
  const rowMotion: RowMotion = crowded ? "none" : reduced ? "fade" : "full";
  // 挂载时就在的行与空状态不播入场。不能用 AnimatePresence 的 initial={false} 来做：它会让这些行里面
  // 之后才挂载的元素（开关、徽标这类自带入场的部件）也永远跳过入场。这里只在行自己身上关掉
  const mounted = useMounted();
  // 行集合或顺序变了：读一次此刻的可见范围，只让附近的行逐行动画（新行入场、被挤动的行让位）。整表换上、虚拟化时一行也不量。
  // 减少动画时让位本来就一步到位，不必量布局，只留新行的淡入
  const nearby = changed && mounted.current && !crowded && !virtual ? rowsInWindow(before.keys, keys, tableWindow(scrollRef.current, bodyRef.current, rowHeight)) : null;
  const seq = changed ? before.seq + 1 : before.seq;
  const tokens = changed ? nextTokens(before.tokens, keys, nearby === null || reduced ? NO_ROWS : nearby.moving, seq) : before.tokens;

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => rowHeight,
    getItemKey: (index) => keys[index],
    overscan: 8,
    enabled: virtual,
  });

  // 虚拟化时当前行可能已滚出渲染范围：Tab 停点退到第一条渲染出来的行，表格始终能被 Tab 走到
  const renderedIndexes = virtual ? virtualizer.getVirtualItems().map((item) => item.index) : null;
  const tabStop = renderedIndexes === null || renderedIndexes.length === 0 || renderedIndexes.includes(activeIndex) ? activeIndex : renderedIndexes[0];

  useLayoutEffect(() => {
    shown.current = { keys, virtual, tokens, seq };
    const body = bodyRef.current;
    if (body === null) return;
    if (crowded) {
      // 透明度先在提交时压到 0：淡入要等下一帧才起步，首帧会先看到整批新行一闪
      body.style.opacity = "0";
      void animateBody(body, { opacity: [0, 1] }, fade.in);
    }
    syncRowTabStops(body);
    const wanted = pendingFocus.current;
    if (wanted === null) return;
    const row = [...body.querySelectorAll<HTMLElement>('[role="row"][data-row-index]')].find((el) => Number(el.dataset.rowIndex) === wanted);
    if (row === undefined) return;
    pendingFocus.current = null;
    row.focus();
  });

  const focusRow = (index: number) => {
    const target = Math.max(0, Math.min(index, rows.length - 1));
    pendingFocus.current = target;
    if (virtual) virtualizer.scrollToIndex(target, { align: "auto" });
    if (target === activeIndex) {
      const row = bodyRef.current?.querySelector<HTMLElement>(`[role="row"][data-row-index="${target}"]`);
      if (row) {
        pendingFocus.current = null;
        row.focus();
      }
    }
    setActive(target);
  };

  const toggle = (key: string) => {
    if (selection === undefined) return;
    const next = new Set(selection.selected);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    selection.onChange(next);
  };

  const headerCtx: TableHeaderContext = {
    selection: selection === undefined ? "none" : selectionState(selection.selected, keys),
    toggleAll: () => {
      if (selection === undefined) return;
      const state = selectionState(selection.selected, keys);
      const next = new Set(selection.selected);
      for (const k of keys) {
        if (state === "all") next.delete(k);
        else next.add(k);
      }
      selection.onChange(next);
    },
  };

  const onRowKeyDown = (event: KeyboardEvent<HTMLDivElement>, index: number, row: T, key: string) => {
    if (event.target !== event.currentTarget) return;
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        focusRow(index + 1);
        return;
      case "ArrowUp":
        event.preventDefault();
        focusRow(index - 1);
        return;
      case "Home":
        event.preventDefault();
        focusRow(0);
        return;
      case "End":
        event.preventDefault();
        focusRow(rows.length - 1);
        return;
      case "Enter":
        if (onActivate === undefined) return;
        event.preventDefault();
        onActivate(row);
        return;
      case " ":
        if (selection === undefined) return;
        event.preventDefault();
        toggle(key);
        return;
    }
  };

  const onRowClick = (event: MouseEvent<HTMLDivElement>, row: T) => {
    if (onActivate === undefined || !(event.target instanceof Element)) return;
    const control = event.target.closest(ROW_CONTROLS);
    if (control !== null && event.currentTarget.contains(control)) return;
    onActivate(row);
  };

  const tierAttrs = (column: TableColumn<T>) => ({
    "data-hide-compact": visibleIn(column, "compact") ? undefined : "",
    "data-hide-regular": visibleIn(column, "regular") ? undefined : "",
    "data-hide-wide": visibleIn(column, "wide") ? undefined : "",
  });

  const renderRow = (index: number, style?: { transform: string }) => {
    const row = rows[index];
    const key = keys[index];
    const selected = selection !== undefined && selection.selected.has(key);
    const ctx: TableCellContext = { selected, toggleSelected: () => toggle(key) };
    const shared = {
      role: "row",
      className: styles.row,
      "data-selected": selected || undefined,
      "data-inactive": isInactive !== undefined && isInactive(row) ? "" : undefined,
      "data-activatable": onActivate === undefined ? undefined : "",
      // 末行不画分隔线。:last-child 会把抽出布局、仍排在文档末尾的退场行认成末行，新的末行要等它淡完才去掉分隔线；
      // 退场的行留着最后一次的标记，淡出时样子不变
      "data-last": index === rows.length - 1 ? "" : undefined,
      "aria-selected": selection === undefined ? undefined : selected,
      tabIndex: index === tabStop ? 0 : -1,
      onFocus: (event: FocusEvent<HTMLDivElement>) => {
        if (event.target === event.currentTarget) setActive(index);
      },
      onKeyDown: (event: KeyboardEvent<HTMLDivElement>) => onRowKeyDown(event, index, row, key),
      onClick: (event: MouseEvent<HTMLDivElement>) => onRowClick(event, row),
      children: columns.map((column) => {
        const content = column.cell(row, ctx);
        return (
          <div key={column.key} role="gridcell" className={styles.cell} data-align={column.align === undefined ? "start" : column.align} data-keep={column.keepOpaque ? "" : undefined} {...tierAttrs(column)}>
            {typeof content === "string" || typeof content === "number" ? <span className={styles.text}>{content}</span> : content}
          </div>
        );
      }),
    };
    if (style !== undefined) return <div key={key} {...shared} data-row-index={index} data-virtual="" aria-rowindex={index + 2} style={style} />;
    const token = tokens.get(key);
    if (token === undefined) throw new Error(`Table 的行 ${key} 没有布局令牌`);
    return <PresenceRow key={key} {...shared} index={index} rowMotion={rowMotion} entering={nearby !== null && nearby.entering.has(key)} layoutToken={token} />;
  };

  const vars = cssVars({
    "--table-cols-compact": columnTemplate(columns, "compact"),
    "--table-cols-regular": columnTemplate(columns, "regular"),
    "--table-cols-wide": columnTemplate(columns, "wide"),
    "--table-row": `${rowHeight}px`,
    "--table-head": `${HEADER_HEIGHT}px`,
  });

  return (
    <motion.div
      ref={scrollRef}
      className={cx(styles.table, className)}
      style={vars}
      role="grid"
      aria-label={label}
      aria-rowcount={virtual ? rows.length + 1 : undefined}
      aria-multiselectable={selection === undefined ? undefined : true}
      data-density={density}
      layoutScroll
    >
      <div className={styles.head} role="rowgroup">
        <div className={styles.headRow} role="row" aria-rowindex={virtual ? 1 : undefined}>
          {columns.map((column) => {
            const content = typeof column.header === "function" ? column.header(headerCtx) : column.header;
            const sorted = sort !== null && sort !== undefined && sort.key === column.key ? sort.direction : null;
            return (
              <div
                key={column.key}
                role="columnheader"
                className={styles.headCell}
                data-align={column.align === undefined ? "start" : column.align}
                aria-sort={column.sortable ? (sorted === "asc" ? "ascending" : sorted === "desc" ? "descending" : "none") : undefined}
                {...tierAttrs(column)}
              >
                {column.sortable && onSortChange !== undefined ? (
                  <button type="button" className={styles.sortButton} data-sorted={sorted === null ? undefined : sorted} onClick={() => onSortChange(nextSort(sort, column.key))}>
                    <span className={styles.text}>{content}</span>
                    {/* 箭头常驻：换排序列时淡入淡出，翻转方向时转半圈；未排序的列也留着它的位置，换列时表头文字不挪动 */}
                    <Icon name="chevron-up" size={14} className={styles.sortIcon} />
                  </button>
                ) : (
                  content
                )}
              </div>
            );
          })}
        </div>
      </div>
      <div ref={bodyRef} className={styles.body} role="rowgroup" style={virtual ? { height: `${virtualizer.getTotalSize()}px` } : undefined} data-virtual={virtual ? "" : undefined}>
        {virtual ? (
          virtualizer.getVirtualItems().map((item) => renderRow(item.index, { transform: `translateY(${item.start}px)` }))
        ) : (
          <AnimatePresence mode="popLayout" custom={rowMotion}>
            {rows.length === 0 ? (
              <PresenceEmpty key={EMPTY_ROW_KEY} rowMotion={rowMotion} entering={mounted.current}>
                {empty}
              </PresenceEmpty>
            ) : (
              rows.map((_, index) => renderRow(index))
            )}
          </AnimatePresence>
        )}
      </div>
    </motion.div>
  );
}
