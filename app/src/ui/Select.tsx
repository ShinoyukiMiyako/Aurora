// 下拉选择：从 7 项以上、或文字较长的固定选项里选一个值（Java 运行时、游戏版本分支、语言、排序方式）。
// 2 到 6 个短选项用分段控件或单选组；触发动作用菜单按钮；带任意内容的下拉面板用 Popover。
//
// 焦点始终留在触发器上（有过滤框时在过滤框里），高亮项由 aria-activedescendant 指出。
// 键盘：关闭时 ↓ / ↑ / Enter / Space 打开并高亮当前值；打开时 ↑↓ 移动（跳过禁用项、首尾循环）、Home / End、
// Enter 选中并关闭、Esc 关闭并把焦点还给触发器、Tab 关闭并前进；任意时刻键入字符按首字跳转
// （500 ms 内连续键入合并为前缀；关闭时直接选中匹配项，与原生下拉一致）。
// 选项超过 12 个时列表顶部出现过滤框，打开即聚焦，按标签包含匹配。
// 尺寸不随内容跳：触发器宽度按最长的选项预留，换选中项时同一行的其他控件不被挤动（撑满的触发器宽度由容器定，不预留；
// 选项很多时只取估算最长的几条）；
// 打开期间面板不变矮（键入筛选词只换内容），过滤框有没有在打开那一刻定下，选项晚到也不会把它插进来。

import { useId, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import { Icon, type IconName } from "../art/Icon";
import { cx, isImeComposing } from "../lib/util";
import { mergeDescribedBy, useFieldControl } from "./Field";
import { Popover } from "./Popover";
import styles from "./Select.module.css";
import { TextInput } from "./TextInput";
import { isTypeaheadKey, matchTypeahead, useTypeahead } from "./typeahead";

export interface SelectOption<T extends string> {
  value: T;
  label: string;
  /** 第二行说明，选项高 48。 */
  hint?: string;
  icon?: IconName;
  disabled?: boolean;
  /** 分组标题；相邻且同组的选项归在一个标题下。 */
  group?: string;
}

export interface SelectProps<T extends string> {
  /** null：尚未选择，显示占位。 */
  value: T | null;
  onChange: (value: T) => void;
  options: readonly SelectOption<T>[];
  placeholder?: string;
  size?: "sm" | "md";
  block?: boolean;
  disabled?: boolean;
  invalid?: boolean;
  /** 不在 Field 里时必填。 */
  ariaLabel?: string;
  className?: string;
}

/** 超过这个数量的选项在列表顶部给过滤框。 */
export const SELECT_FILTER_THRESHOLD = 12;
export const SELECT_PLACEHOLDER = "选择";
export const SELECT_EMPTY_COPY = "没有匹配项";
export const SELECT_FILTER_LABEL = "筛选选项";
export const SELECT_FILTER_PLACEHOLDER = "筛选";

/**
 * 触发器预留宽度时最多叠放的候选数。游戏版本这类下拉有几百个选项，每个都放一个隐藏节点的话，
 * 触发器里多出同样数量的节点与文字排版，所在组件每次重渲染都要逐个对比。
 */
const WIDTH_CANDIDATE_LIMIT = 8;

/** 估算文字宽度用的权重：全角字符（中日韩文字、全角符号）按两个半角算。只用来挑候选，真实宽度仍由排版决定。 */
function textWeight(text: string): number {
  let weight = 0;
  for (const ch of text) weight += ch.charCodeAt(0) >= 0x2e80 ? 2 : 1;
  return weight;
}

/** 叠在触发器里撑宽的候选文案：不多于上限时全部，超过时取估算最宽的几条。 */
function widthCandidates(labels: readonly string[]): string[] {
  const unique = [...new Set(labels)];
  if (unique.length <= WIDTH_CANDIDATE_LIMIT) return unique;
  return unique
    .map((label) => ({ label, weight: textWeight(label) }))
    .sort((a, b) => b.weight - a.weight)
    .slice(0, WIDTH_CANDIDATE_LIMIT)
    .map((c) => c.label);
}

interface Section<T extends string> {
  group: string | undefined;
  indices: number[];
  options: SelectOption<T>[];
}

function sectionsOf<T extends string>(options: readonly SelectOption<T>[], visible: readonly number[]): Section<T>[] {
  const sections: Section<T>[] = [];
  for (const i of visible) {
    const option = options[i];
    const last = sections[sections.length - 1];
    if (last && last.group === option.group) {
      last.indices.push(i);
      last.options.push(option);
    } else sections.push({ group: option.group, indices: [i], options: [option] });
  }
  return sections;
}

export function Select<T extends string>({
  value,
  onChange,
  options,
  placeholder = SELECT_PLACEHOLDER,
  size = "md",
  block = false,
  disabled = false,
  invalid = false,
  ariaLabel,
  className,
}: SelectProps<T>) {
  const field = useFieldControl();
  if (ariaLabel === undefined && field === null) throw new Error("Select 必须放在 Field 里或传 ariaLabel");
  const selected = value === null ? -1 : options.findIndex((o) => o.value === value);
  if (value !== null && selected < 0) throw new Error(`Select 的当前值 ${value} 不在选项里`);

  const base = useId();
  const listId = `${base}-list`;
  const optionId = (i: number) => `${base}-option-${i}`;
  const [trigger, setTrigger] = useState<HTMLButtonElement | null>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [highlight, setHighlight] = useState(-1);
  const pushTypeahead = useTypeahead();
  // 打开那一刻定下：列表开着时选项才读到（版本下拉加载中就能点开），过滤框不在顶上插进来、把焦点抢走
  const [filterable, setFilterable] = useState(false);
  const isInvalid = invalid || (field !== null && field.invalid);

  const needle = query.trim().toLocaleLowerCase();
  const visible = options.map((_, i) => i).filter((i) => needle === "" || options[i].label.toLocaleLowerCase().includes(needle));
  const enabledVisible = visible.filter((i) => options[i].disabled !== true);
  const disabledFlags = options.map((o) => o.disabled === true);

  const openList = () => {
    setQuery("");
    setHighlight(selected >= 0 && options[selected].disabled !== true ? selected : disabledFlags.indexOf(false));
    setFilterable(options.length > SELECT_FILTER_THRESHOLD);
    setOpen(true);
  };

  const pick = (index: number) => {
    const option = options[index];
    if (!option || option.disabled === true) return;
    setOpen(false);
    if (option.value !== value) onChange(option.value);
  };

  const move = (delta: 1 | -1) => {
    if (enabledVisible.length === 0) return;
    const at = enabledVisible.indexOf(highlight);
    const next = at < 0 ? (delta === 1 ? 0 : enabledVisible.length - 1) : (at + delta + enabledVisible.length) % enabledVisible.length;
    setHighlight(enabledVisible[next]);
  };

  const typeahead = (key: string, from: number) =>
    matchTypeahead(
      options.map((o) => o.label),
      disabledFlags,
      pushTypeahead(key),
      from,
    );

  const onKeyDown = (event: ReactKeyboardEvent<HTMLElement>) => {
    if (isImeComposing(event)) return;
    const onTrigger = event.currentTarget === trigger;
    if (!open) {
      if (!onTrigger) return;
      if (event.key === "ArrowDown" || event.key === "ArrowUp" || event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        openList();
      } else if (isTypeaheadKey(event)) {
        const hit = typeahead(event.key, selected);
        if (hit >= 0 && options[hit].value !== value) onChange(options[hit].value);
      }
      return;
    }
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        move(1);
        return;
      case "ArrowUp":
        event.preventDefault();
        move(-1);
        return;
      case "Home":
      case "End":
        // 过滤框里的 Home / End 照常移动光标
        if (!onTrigger) return;
        event.preventDefault();
        if (enabledVisible.length > 0) setHighlight(enabledVisible[event.key === "Home" ? 0 : enabledVisible.length - 1]);
        return;
      case "Enter":
        event.preventDefault();
        if (highlight >= 0) pick(highlight);
        return;
      case " ":
        if (!onTrigger) return;
        event.preventDefault();
        if (highlight >= 0) pick(highlight);
        return;
      case "Tab":
        // 触发器上的 Tab 照常前进；过滤框里的 Tab 由浮层面板接管（焦点回到触发器之后）
        if (onTrigger) setOpen(false);
        return;
    }
    if (onTrigger && isTypeaheadKey(event)) {
      const hit = typeahead(event.key, highlight);
      if (hit >= 0) setHighlight(hit);
    }
  };

  const current = selected >= 0 ? options[selected] : null;
  const activeId = open && highlight >= 0 && visible.includes(highlight) ? optionId(highlight) : undefined;
  const widthLabels = block ? [] : widthCandidates([placeholder, ...options.map((o) => o.label)]);

  return (
    <>
      <button
        ref={setTrigger}
        type="button"
        role="combobox"
        id={field?.controlId}
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-activedescendant={filterable ? undefined : activeId}
        aria-invalid={isInvalid || undefined}
        aria-describedby={mergeDescribedBy(undefined, field)}
        disabled={disabled}
        className={cx(styles.trigger, className)}
        data-size={size}
        data-block={block || undefined}
        data-open={open || undefined}
        data-invalid={isInvalid || undefined}
        onClick={() => (open ? setOpen(false) : openList())}
        onKeyDown={onKeyDown}
      >
        {current?.icon !== undefined && <Icon name={current.icon} size={16} className={styles.triggerIcon} />}
        <span className={styles.value} data-placeholder={current === null || undefined}>
          <span className={styles.valueText}>{current === null ? placeholder : current.label}</span>
          {/* 全部候选叠在同一格里撑出宽度；文字写在伪元素上，不进 textContent 与可访问名称 */}
          {widthLabels.map((label) => (
            <span key={label} className={styles.widthLabel} data-label={label} aria-hidden="true" />
          ))}
        </span>
        <Icon name="chevron-down" size={16} className={styles.chevron} />
      </button>
      <Popover open={open} anchor={trigger} onClose={() => setOpen(false)} placement="bottom-start" offset={6} matchWidth role="presentation">
        <SelectList
          listId={listId}
          optionId={optionId}
          options={options}
          visible={visible}
          value={value}
          highlight={highlight}
          filterable={filterable}
          query={query}
          activeId={activeId}
          name={ariaLabel}
          labelledBy={field?.labelId}
          onQuery={(q) => {
            setQuery(q);
            const qn = q.trim().toLocaleLowerCase();
            const first = options.findIndex((o) => o.disabled !== true && (qn === "" || o.label.toLocaleLowerCase().includes(qn)));
            setHighlight(first);
          }}
          onHighlight={setHighlight}
          onPick={pick}
          onKeyDown={onKeyDown}
        />
      </Popover>
    </>
  );
}

interface SelectListProps<T extends string> {
  listId: string;
  optionId: (i: number) => string;
  options: readonly SelectOption<T>[];
  visible: readonly number[];
  value: T | null;
  highlight: number;
  filterable: boolean;
  query: string;
  activeId: string | undefined;
  name: string | undefined;
  labelledBy: string | undefined;
  onQuery: (query: string) => void;
  onHighlight: (index: number) => void;
  onPick: (index: number) => void;
  onKeyDown: (event: ReactKeyboardEvent<HTMLElement>) => void;
}

function SelectList<T extends string>({
  listId,
  optionId,
  options,
  visible,
  value,
  highlight,
  filterable,
  query,
  activeId,
  name,
  labelledBy,
  onQuery,
  onHighlight,
  onPick,
  onKeyDown,
}: SelectListProps<T>) {
  const panelRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const filterRef = useRef<HTMLInputElement>(null);

  // 打开时的高度定为下限：键入筛选词让列表变矮时面板不跟着缩，向上展开的面板顶上的过滤框也就不随每次按键下移。
  // 只在挂载时量这一次，直接写到元素上，不为它多渲染一遍
  useLayoutEffect(() => {
    const panel = panelRef.current;
    if (panel === null) throw new Error("下拉列表没有挂上面板");
    panel.style.minHeight = `${panel.offsetHeight}px`;
  }, []);

  // 打开即聚焦过滤框。不用 autoFocus：开发构建的 StrictMode 会重放 effect，autoFocus 不会重放
  useLayoutEffect(() => {
    if (filterable) filterRef.current?.focus();
  }, [filterable]);

  // 键盘移动高亮时把它滚进列表可视区
  useLayoutEffect(() => {
    const list = listRef.current;
    if (!list || highlight < 0) return;
    const el = list.querySelector<HTMLElement>(`[data-index="${highlight}"]`);
    if (!el) return;
    if (el.offsetTop < list.scrollTop) list.scrollTop = el.offsetTop;
    else if (el.offsetTop + el.offsetHeight > list.scrollTop + list.clientHeight) list.scrollTop = el.offsetTop + el.offsetHeight - list.clientHeight;
  }, [highlight]);

  const renderOption = (option: SelectOption<T>, i: number): ReactNode => {
    const isSelected = option.value === value;
    return (
      <div
        key={option.value}
        id={optionId(i)}
        data-index={i}
        role="option"
        aria-selected={isSelected}
        aria-disabled={option.disabled || undefined}
        className={styles.option}
        data-hint={option.hint !== undefined || undefined}
        data-highlight={highlight === i || undefined}
        onPointerMove={() => {
          if (option.disabled !== true && highlight !== i) onHighlight(i);
        }}
        onClick={() => onPick(i)}
      >
        {option.icon !== undefined && <Icon name={option.icon} size={16} className={styles.optionIcon} />}
        <span className={styles.optionText}>
          <span className={styles.optionLabel}>{option.label}</span>
          {option.hint !== undefined && <span className={styles.optionHint}>{option.hint}</span>}
        </span>
        {isSelected && <Icon name="check" size={16} className={styles.check} />}
      </div>
    );
  };

  return (
    <div ref={panelRef} className={styles.panel}>
      {filterable && (
        <div className={styles.filter}>
          <TextInput
            ref={filterRef}
            size="sm"
            icon="search"
            value={query}
            onChange={onQuery}
            placeholder={SELECT_FILTER_PLACEHOLDER}
            role="combobox"
            aria-label={SELECT_FILTER_LABEL}
            aria-expanded
            aria-autocomplete="list"
            aria-controls={listId}
            aria-activedescendant={activeId}
            onKeyDown={onKeyDown}
          />
        </div>
      )}
      <div
        ref={listRef}
        id={listId}
        role="listbox"
        aria-label={labelledBy === undefined ? name : undefined}
        aria-labelledby={labelledBy}
        className={styles.list}
        // 指针按下不把焦点从触发器或过滤框上移走
        onPointerDown={(e) => e.preventDefault()}
      >
        {sectionsOf(options, visible).map((section) =>
          section.group === undefined ? (
            section.indices.map((i) => renderOption(options[i], i))
          ) : (
            <div key={`group-${section.indices[0]}`} role="group" aria-labelledby={`${listId}-group-${section.indices[0]}`} className={styles.group}>
              <div id={`${listId}-group-${section.indices[0]}`} role="presentation" className={styles.groupTitle}>
                {section.group}
              </div>
              {section.indices.map((i) => renderOption(options[i], i))}
            </div>
          ),
        )}
      </div>
      {visible.length === 0 && (
        <div className={styles.empty} role="status">
          {SELECT_EMPTY_COPY}
        </div>
      )}
    </div>
  );
}
