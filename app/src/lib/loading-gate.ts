// 「延迟出现、至少停留」的加载门：全站页面与卡片共用这一份，加载态的出现与消失时机处处一致。
//
// - 加载在 LOADING_DELAY_MS 内结束：不出现任何加载态（避免一闪而过）。等待期间是 pending，
//   调用方照常占位但不画骨架，数据到达时不发生布局位移。
// - 超过 LOADING_DELAY_MS 仍在加载：出现骨架；骨架一旦出现至少停留 LOADING_DELAY_MS，数据早到也等满再换成内容。
// - 骨架停留期间又开始了新一轮加载：骨架继续显示、不重新计时，免得先消失再出现；
//   最短停留仍从骨架第一次出现的时刻算起。
// - 同一轮加载持续超过 SLOW_HINT_MS：slow 为真，调用方在加载态下方追加「比平时慢一些」；新一轮加载重新计时。

import { useLayoutEffect, useState } from "react";
import { LOADING_DELAY_MS, SLOW_HINT_MS } from "../domain/limits";

export type LoadingView =
  /** 加载中、还没到出现骨架的时刻：占位但不可见。 */
  | "pending"
  | "skeleton"
  | "content";

export interface LoadingGate {
  view: LoadingView;
  /** 这一轮加载已超过 SLOW_HINT_MS。 */
  slow: boolean;
}

interface GateState {
  loading: boolean;
  /** 本轮加载（或本轮空闲）开始的时刻。 */
  since: number;
  /** 骨架出现的时刻；骨架没出现或已收起为 null。 */
  shownAt: number | null;
  slow: boolean;
}

export function useLoadingGate(loading: boolean): LoadingGate {
  const [gate, setGate] = useState<GateState>(() => ({ loading, since: Date.now(), shownAt: null, slow: false }));

  // 加载状态变化在渲染期同步换轮次：加载开始的这一帧就不能再画旧内容（数据已不在）
  let current = gate;
  if (gate.loading !== loading) {
    current = { loading, since: Date.now(), shownAt: gate.shownAt, slow: false };
    setGate(current);
  }

  useLayoutEffect(() => {
    if (current.loading) {
      const elapsed = Date.now() - current.since;
      const timers: ReturnType<typeof setTimeout>[] = [];
      if (current.shownAt === null) {
        timers.push(setTimeout(() => setGate((g) => (g.loading && g.shownAt === null ? { ...g, shownAt: Date.now() } : g)), Math.max(0, LOADING_DELAY_MS - elapsed)));
      }
      if (!current.slow) {
        timers.push(setTimeout(() => setGate((g) => (g.loading ? { ...g, slow: true } : g)), Math.max(0, SLOW_HINT_MS - elapsed)));
      }
      return () => timers.forEach(clearTimeout);
    }
    if (current.shownAt === null) return;
    const remaining = current.shownAt + LOADING_DELAY_MS - Date.now();
    const hide = () => setGate((g) => (g.loading ? g : { ...g, shownAt: null }));
    if (remaining <= 0) {
      hide();
      return;
    }
    const timer = setTimeout(hide, remaining);
    return () => clearTimeout(timer);
  }, [current.loading, current.since, current.shownAt, current.slow]);

  if (current.loading) return { view: current.shownAt === null ? "pending" : "skeleton", slow: current.slow };
  return { view: current.shownAt === null ? "content" : "skeleton", slow: false };
}
