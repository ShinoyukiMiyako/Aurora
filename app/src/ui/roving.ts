// 单选类控件（单选组、选项块、分段控件）的漫游焦点：组内只有一个 Tab 停靠点（已选项，没有已选项时是第一个可用项），
// 方向键移动焦点并立即选中，跳过禁用项，首尾循环。

import { useRef, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { isImeComposing } from "../lib/util";

export interface RovingItem<T> {
  value: T;
  disabled?: boolean;
}

/** 从 from 出发沿 delta 方向找下一个可用项，首尾循环；全部禁用时返回 -1。 */
export function nextEnabled(disabled: readonly boolean[], from: number, delta: 1 | -1): number {
  const n = disabled.length;
  for (let k = 1; k <= n; k++) {
    const i = (((from + delta * k) % n) + n) % n;
    if (!disabled[i]) return i;
  }
  return -1;
}

const DELTA: Record<string, 1 | -1> = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 };

export interface RovingGroup {
  /** 第 i 项的 tabIndex：组内唯一的停靠点为 0，其余为 -1；整组禁用时全为 -1。 */
  tabIndexOf(index: number): 0 | -1;
  /** 第 i 项的 ref 回调。 */
  register(index: number): (el: HTMLElement | null) => void;
  onKeyDown(event: ReactKeyboardEvent): void;
}

export function useRovingGroup<T>(items: readonly RovingItem<T>[], value: T | null, onChange: (value: T) => void, groupDisabled: boolean): RovingGroup {
  const refs = useRef<(HTMLElement | null)[]>([]);
  const disabled = items.map((item) => groupDisabled || item.disabled === true);
  const selected = items.findIndex((item) => item.value === value);
  const stop = selected >= 0 && !disabled[selected] ? selected : disabled.indexOf(false);

  return {
    tabIndexOf: (index) => (index === stop ? 0 : -1),
    register: (index) => (el) => {
      refs.current[index] = el;
    },
    onKeyDown: (event) => {
      const delta = DELTA[event.key];
      if (delta === undefined || isImeComposing(event)) return;
      const from = refs.current.findIndex((el) => el !== null && el === document.activeElement);
      const next = nextEnabled(disabled, from >= 0 ? from : stop, delta);
      if (next < 0) return;
      event.preventDefault();
      refs.current[next]?.focus();
      if (next !== selected) onChange(items[next].value);
    },
  };
}
