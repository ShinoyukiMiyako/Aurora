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

import { Children, createContext, isValidElement, useContext, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
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

  let context: ListContextValue = { variant, select: null };
  if (select !== undefined) {
    const values = optionValues(children);
    const preferred = [focusValue, select.selected].find((v): v is string => v !== null && values.includes(v));
    const tabStop = preferred !== undefined ? preferred : values.length > 0 ? values[0] : null;
    const focus = (value: string) => {
      setFocusValue(value);
      const list = listRef.current;
      if (list === null) throw new Error("List 尚未挂载");
      const target = [...list.querySelectorAll<HTMLElement>(':scope > [role="option"]')].find((el) => el.dataset.value === value);
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
    const options = [...list.querySelectorAll<HTMLElement>(':scope > [role="option"]:not([aria-disabled="true"])')];
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
        ref={listRef}
        className={cx(styles.list, className)}
        data-variant={variant}
        role={select === undefined ? undefined : "listbox"}
        aria-label={label}
        onKeyDown={select === undefined ? undefined : onKeyDown}
      >
        {children}
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
  if (list === null) throw new Error("ListRow 必须放在 List 里");
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
      <li
        className={cx(styles.item, className)}
        role="option"
        data-value={value}
        aria-selected={isSelected}
        aria-disabled={disabled || undefined}
        aria-label={ariaLabel}
        tabIndex={!disabled && select.tabStop === value ? 0 : -1}
        onFocus={(event) => {
          if (event.target === event.currentTarget && !disabled) select.focus(value);
        }}
        onClick={() => {
          if (disabled) return;
          select.focus(value);
          select.onSelect(value);
        }}
      >
        <div className={styles.row} {...rowData} data-selected={isSelected || undefined} data-interactive="">
          {body(title)}
        </div>
      </li>
    );
  }

  if (onClick !== undefined && trailing === undefined) {
    return (
      <li className={cx(styles.item, className)}>
        <button type="button" className={styles.row} {...rowData} data-interactive="" disabled={disabled} aria-label={ariaLabel} onClick={onClick}>
          {body(title)}
        </button>
      </li>
    );
  }

  if (onClick !== undefined) {
    return (
      <li className={cx(styles.item, className)}>
        <div className={styles.row} {...rowData} data-interactive="" data-overlay="">
          {body(
            <button type="button" className={styles.titleButton} disabled={disabled} aria-label={ariaLabel} onClick={onClick}>
              {title}
            </button>,
          )}
        </div>
      </li>
    );
  }

  return (
    <li className={cx(styles.item, className)}>
      <div className={styles.row} {...rowData}>
        {body(title)}
      </div>
    </li>
  );
}
