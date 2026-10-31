// 「探针」：为一组实例各订阅一份按需查询，把结果汇总回父组件。查询 hook 不能在循环里调用，
// 每个实例挂一个不渲染任何东西的组件，由它订阅、在结果变化时回报。

import { useCallback, useEffect, useState } from "react";
import { useInstanceContent, useInstanceMods } from "../../state/queries/instance";
import type { WorldsState } from "./verdict";

/** 汇总表：key -> 回报的值；探针卸载时删掉自己那一项。 */
export function useCollected<T>(): [ReadonlyMap<string, T>, (key: string, value: T | null) => void] {
  const [values, setValues] = useState<ReadonlyMap<string, T>>(() => new Map());
  const report = useCallback((key: string, value: T | null) => {
    setValues((prev) => {
      if (value === null) {
        if (!prev.has(key)) return prev;
        const next = new Map(prev);
        next.delete(key);
        return next;
      }
      if (prev.get(key) === value) return prev;
      const next = new Map(prev);
      next.set(key, value);
      return next;
    });
  }, []);
  return [values, report];
}

/** 实例里已装 Mod 的平台来源，「平台:工程 id」。读不出来时在控制台留一条警告，这个实例按没装处理。 */
export function ModSourcesProbe({ instanceId, onReport }: { instanceId: string; onReport: (id: string, value: ReadonlySet<string> | null) => void }) {
  const mods = useInstanceMods(instanceId);
  const data = mods.status === "ready" ? mods.data : null;
  const error = mods.status === "error" ? mods.error : null;
  useEffect(() => {
    if (data !== null) onReport(instanceId, new Set(data.flatMap((m) => (m.source === null ? [] : [`${m.source.platform}:${m.source.project_id}`]))));
  }, [data, instanceId, onReport]);
  useEffect(() => {
    if (error !== null) console.warn(`「${instanceId}」的 Mod 列表读不出来，发现页的「已装入」不计这个实例`, error);
  }, [error, instanceId]);
  useEffect(() => () => onReport(instanceId, null), [instanceId, onReport]);
  return null;
}

/** 实例的存档列表（数据包要装进存档）。 */
export function WorldsProbe({ instanceId, onReport }: { instanceId: string; onReport: (id: string, value: WorldsState | null) => void }) {
  const content = useInstanceContent(instanceId);
  const status = content.status;
  const worlds = status === "ready" ? content.data.worlds : null;
  const message = status === "error" ? content.error.message : null;
  useEffect(() => {
    if (worlds !== null) onReport(instanceId, { status: "ready", worlds });
    else if (message !== null) onReport(instanceId, { status: "error", message });
    else onReport(instanceId, { status: "loading" });
  }, [worlds, message, instanceId, onReport]);
  useEffect(() => () => onReport(instanceId, null), [instanceId, onReport]);
  return null;
}
