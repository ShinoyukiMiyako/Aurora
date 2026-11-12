// 「延迟出现、至少停留」的加载门：全站页面与卡片共用这一份，加载态的出现与消失时机处处一致。
//
// - 加载在 LOADING_DELAY_MS 内结束：不出现任何加载态（避免一闪而过）。等待期间是 pending，
//   调用方照常占位但不画骨架，数据到达时不发生布局位移。
// - 超过 LOADING_DELAY_MS 仍在加载：出现骨架；骨架一旦出现至少停留 LOADING_DELAY_MS，数据早到也等满再换成内容。
// - 骨架停留期间又开始了新一轮加载：骨架继续显示、不重新计时，免得先消失再出现；
//   最短停留仍从骨架第一次出现的时刻算起。
// - 同一轮加载持续超过 SLOW_HINT_MS：slow 为真，调用方在加载态下方追加「比平时慢一些」；新一轮加载重新计时。
// - 加载中换了请求（加载状态一直为真，round 变了）也是新一轮：慢提示清掉、从换轮那一刻重新计时，
//   调用方接在慢提示后面的超时随之重来；骨架的出现与停留不受影响，玩家一直在等，不因换了请求再多等一个延迟。

import { useLayoutEffect, useState } from "react";
import { LOADING_DELAY_MS, SLOW_HINT_MS } from "../domain/limits";

/** 加载态出现前的等待时长。组件库不直接引 domain，要按同一时机自己判断的（缩略图留住回落图形等图）从这里取。 */
export { LOADING_DELAY_MS };

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
  round: string | undefined;
  /** 本轮加载（或本轮空闲）开始的时刻。 */
  since: number;
  /** 慢提示的计时起点：加载开始或加载中换轮的时刻。 */
  slowFrom: number;
  /** 骨架出现的时刻；骨架没出现或已收起为 null。 */
  shownAt: number | null;
  slow: boolean;
}

/** round 标识一轮加载（例如请求参数的序列化）；不传时只按加载状态的变化换轮。 */
export function useLoadingGate(loading: boolean, round?: string): LoadingGate {
  const [gate, setGate] = useState<GateState>(() => {
    const now = Date.now();
    return { loading, round, since: now, slowFrom: now, shownAt: null, slow: false };
  });

  // 加载状态变化在渲染期同步换轮次：加载开始的这一帧就不能再画旧内容（数据已不在）
  let current = gate;
  if (gate.loading !== loading) {
    const now = Date.now();
    current = { loading, round, since: now, slowFrom: now, shownAt: gate.shownAt, slow: false };
    setGate(current);
  } else if (gate.round !== round) {
    current = { ...gate, round, slowFrom: Date.now(), slow: false };
    setGate(current);
  }

  useLayoutEffect(() => {
    if (current.loading) {
      const elapsed = Date.now() - current.since;
      const timers: ReturnType<typeof setTimeout>[] = [];
      if (current.shownAt === null) {
        // 时刻在定时器到点时就取下：更新函数可能要等到下一次渲染才求值，那时再取，渲染推迟多久骨架就多停多久
        const show = () => {
          const at = Date.now();
          setGate((g) => (g.loading && g.shownAt === null ? { ...g, shownAt: at } : g));
        };
        timers.push(setTimeout(show, Math.max(0, LOADING_DELAY_MS - elapsed)));
      }
      if (!current.slow) {
        // 只标记定时器所属的那一轮：换轮后旧定时器即使赶在清理之前到点，也不能把新一轮说成慢
        const from = current.slowFrom;
        const markSlow = () => setGate((g) => (g.loading && g.slowFrom === from ? { ...g, slow: true } : g));
        timers.push(setTimeout(markSlow, Math.max(0, SLOW_HINT_MS - (Date.now() - from))));
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
  }, [current.loading, current.since, current.slowFrom, current.shownAt, current.slow]);

  if (current.loading) return { view: current.shownAt === null ? "pending" : "skeleton", slow: current.slow };
  return { view: current.shownAt === null ? "content" : "skeleton", slow: false };
}
