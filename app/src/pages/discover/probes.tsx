// 「探针」：为一组实例各订阅一份按需查询，把结果汇总回父组件。查询 hook 不能在循环里调用，
// 每个实例挂一个不渲染任何东西的组件，由它订阅、在结果变化时回报。
//
// 探针不一次全挂上：每条 list_instance_content 在后端各自再开一组线程解析存档，
// 几十个实例同时读会占满后端的阻塞线程池，同期的材质读取、版本扫描都得排队。所以同时在读的探针
// 最多 PROBE_CONCURRENCY 个，前面的读完（成功或失败）后面的才挂上；读完的继续挂着，保持订阅、随失效重取。

import { useCallback, useEffect, useState } from "react";
import { useInstanceContent } from "../../state/queries/instance";
import type { WorldsState } from "./verdict";

/** 同时在读的探针上限。 */
export const PROBE_CONCURRENCY = 2;

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

/** 探针的进度：还没回报过（没挂上，或刚挂上）为 null。 */
export type ProbeProgress = "loading" | "settled" | null;

/**
 * 此刻该挂探针的实例。已经回报过的照旧挂着：读完的不再发请求，正在读的（包括失效后重取的）拦不住，只是占着名额；
 * 还没回报过的按 ids 的顺序补上，直到在读的达到 limit。
 */
export function probeWindow(ids: readonly string[], progressOf: (id: string) => ProbeProgress, limit: number): string[] {
  const mounted = ids.filter((id) => progressOf(id) !== null);
  let busy = mounted.filter((id) => progressOf(id) === "loading").length;
  for (const id of ids) {
    if (busy >= limit) break;
    if (progressOf(id) !== null) continue;
    mounted.push(id);
    busy++;
  }
  return mounted;
}

export function worldsProgress(state: WorldsState | undefined): ProbeProgress {
  if (state === undefined) return null;
  return state.status === "loading" ? "loading" : "settled";
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
