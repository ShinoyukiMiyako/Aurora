import { useEffect, useState } from "react";

/**
 * 新挂上的一块内容画出第一帧之后才为真；key 换了（换了一块内容）重新等。hold 为假时恒为真。
 *
 * 自己播入场的内容先停在起点，等它为真再换成目标。入场要是在挂载那次提交里就建，framer-motion 从建的那一刻计时
 * （motion-dom 的 AsyncMotionValueAnimation：建与解析相隔不超过 40 ms 时起点取建的时刻，超过时取下一帧的 rAF），
 * 而一整块新内容挂上的那一帧可能要几十到上百毫秒：挂载本身、同一时刻回来的别的数据引起的渲染，加上这一帧的样式、布局与绘制。
 * 这一段全算进了入场时长，第一帧画出来时淡入已走掉大半。rAF 回调在这一帧绘制之前跑，再排一个任务才落到绘制之后。
 *
 * 同一个 key 下 hold 不要由假变真：已经显示着的内容会退回起点再等一帧。只在挂载那一刻定下的条件由调用方冻结了再传。
 */
export function usePaintedOnce(key: string, hold: boolean): boolean {
  const [state, setState] = useState({ key, painted: false });
  if (state.key !== key) setState({ key, painted: false });
  useEffect(() => {
    if (!hold) return;
    let task: ReturnType<typeof setTimeout> | undefined;
    const frame = requestAnimationFrame(() => {
      task = setTimeout(() => setState((s) => (s.key === key ? { key, painted: true } : s)), 0);
    });
    return () => {
      cancelAnimationFrame(frame);
      clearTimeout(task);
    };
  }, [key, hold]);
  return !hold || (state.key === key && state.painted);
}
