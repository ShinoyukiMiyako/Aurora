// 列表的键入跳转（下拉选择、菜单共用）：按标签首字匹配，短时间内连续键入的字符合并成前缀。

import { useRef } from "react";

/** 两次键入相隔不超过这个时长（毫秒）就合并成一个前缀。 */
export const TYPEAHEAD_WINDOW_MS = 500;

/** 可打印的单个字符才参与键入跳转；带 Ctrl / Alt / Meta 的组合键交给快捷键。 */
export function isTypeaheadKey(event: { key: string; ctrlKey: boolean; altKey: boolean; metaKey: boolean }): boolean {
  return event.key.length === 1 && event.key !== " " && !event.ctrlKey && !event.altKey && !event.metaKey;
}

/**
 * 在 labels 里找下一个匹配 query 的可用项。
 * query 由同一个字符重复组成（连按同一个键）时，从 current 之后找以该字符开头的下一项，实现逐项轮换；
 * 否则从 current 本身开始找以整个前缀开头的项。首尾循环，跳过 disabled。找不到返回 -1。
 */
export function matchTypeahead(labels: readonly string[], disabled: readonly boolean[], query: string, current: number): number {
  const lower = query.toLocaleLowerCase();
  const repeated = [...lower].every((ch) => ch === lower[0]);
  const needle = repeated ? lower[0] : lower;
  const start = repeated ? current + 1 : Math.max(current, 0);
  const n = labels.length;
  for (let k = 0; k < n; k++) {
    const i = (((start + k) % n) + n) % n;
    if (!disabled[i] && labels[i].toLocaleLowerCase().startsWith(needle)) return i;
  }
  return -1;
}

/** 返回 push(char)：把字符并入当前前缀并返回合并后的前缀；距上次键入超过窗口时重新开始。 */
export function useTypeahead(): (char: string) => string {
  const state = useRef({ query: "", at: Number.NEGATIVE_INFINITY });
  return (char) => {
    const now = Date.now();
    const s = state.current;
    s.query = now - s.at <= TYPEAHEAD_WINDOW_MS ? s.query + char : char;
    s.at = now;
    return s.query;
  };
}
