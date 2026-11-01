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

import { useVirtualizer } from "@tanstack/react-virtual";
import { AnimatePresence, motion, useAnimate, useIsPresent, useReducedMotionConfig, type HTMLMotionProps, type Variants } from "framer-motion";
import { useLayoutEffect, useRef, useState, type FocusEvent, type KeyboardEvent, type MouseEvent, type ReactNode } from "react";
import { Icon } from "../art/Icon";
import { fade, springs } from "../lib/motion";
import { cssVars, cx } from "../lib/util";
import type { TierName } from "./Card";
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
/** 一次增删或换位超过这么多行时不逐行动画：行直接换上，整张表淡入一次。再多，布局测量本身就会掉帧。 */
const ROW_MOTION_LIMIT = 40;

const TIERS: readonly TierName[] = ["compact", "regular", "wide"];
const ROW_FOCUSABLE = 'button, a[href], input, select, textarea, [tabindex], [data-table-tabindex]';
const DEMOTED_ATTR = "data-table-tabindex";
/** 点击行内这些元素时不触发行的主动作。 */
const ROW_CONTROLS = 'button, a[href], input, select, textarea, label, [role="switch"], [role="checkbox"], [role="button"]';

const visibleIn = <T,>(column: TableColumn<T>, tier: TierName) => column.tiers === undefined || column.tiers.includes(tier);

/** 某一档的列模板：固定列写像素宽，弹性列按最小宽分剩余空间。 */
export function columnTemplate<T>(columns: readonly TableColumn<T>[], tier: TierName): string {
  return columns
    .filter((c) => visibleIn(c, tier))
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

/** full 淡入淡出带缩放；fade 减少动画时只留透明度；none 一次变化太多，行直接换上。 */
type RowMotion = "full" | "fade" | "none";

const ROW_VARIANTS: Variants = {
  hidden: (motion: RowMotion) => (motion === "none" ? { opacity: 1, scale: 1 } : motion === "fade" ? { opacity: 0, scale: 1 } : { opacity: 0, scale: 0.98 }),
  show: { opacity: 1, scale: 1, transition: { ...springs.settle, opacity: fade.in } },
  leave: (motion: RowMotion) => (motion === "none" ? { opacity: 0, transition: { duration: 0 } } : { opacity: 0, scale: motion === "fade" ? 1 : 0.98, transition: fade.out }),
};

interface PresenceRowProps extends HTMLMotionProps<"div"> {
  index: number;
  rowMotion: RowMotion;
  /** 行顺序的签名：只有它变了才量布局，窗口缩放、分档切换引起的重渲染不触发布局动画。 */
  order: string;
}

/**
 * 不虚拟化的一行。退场时留在原处淡出，这段时间它已经不是表格的一行：不再带序号（键盘移动按序号找行），
 * 也不接受指针与焦点，读屏不再读到。
 */
function PresenceRow({ index, rowMotion, order, tabIndex, ...rest }: PresenceRowProps) {
  const present = useIsPresent();
  return (
    <motion.div
      {...rest}
      data-row-index={present ? index : undefined}
      tabIndex={present ? tabIndex : -1}
      inert={!present}
      custom={rowMotion}
      variants={ROW_VARIANTS}
      initial="hidden"
      animate="show"
      exit="leave"
      layout={rowMotion === "full" ? "position" : false}
      layoutDependency={order}
      transition={{ layout: springs.settle }}
    />
  );
}

/** 非当前行的行内控件退出 Tab 序列；回到当前行时恢复原值。原值记在 data-table-tabindex 上。 */
function syncRowTabStops(body: HTMLElement) {
  for (const row of body.querySelectorAll<HTMLElement>(':scope > [role="row"]')) {
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
  const shownKeys = useRef(keys);
  const crowded = rowChurn(shownKeys.current, keys) > ROW_MOTION_LIMIT;
  const rowMotion: RowMotion = crowded ? "none" : reduced ? "fade" : "full";
  const order = keys.join("|");

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
    shownKeys.current = keys;
    const body = bodyRef.current;
    if (body === null) return;
    if (crowded) void animateBody(body, { opacity: [0, 1] }, fade.in);
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
    return <PresenceRow key={key} {...shared} index={index} rowMotion={rowMotion} order={order} />;
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
                    {sorted !== null && <Icon name={sorted === "asc" ? "chevron-up" : "chevron-down"} size={14} className={styles.sortIcon} />}
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
        {rows.length === 0 ? (
          <div role="row" className={styles.emptyRow}>
            <div role="gridcell" className={styles.empty}>
              {empty}
            </div>
          </div>
        ) : virtual ? (
          virtualizer.getVirtualItems().map((item) => renderRow(item.index, { transform: `translateY(${item.start}px)` }))
        ) : (
          <AnimatePresence initial={false} mode="popLayout" custom={rowMotion}>
            {rows.map((_, index) => renderRow(index))}
          </AnimatePresence>
        )}
      </div>
    </motion.div>
  );
}
