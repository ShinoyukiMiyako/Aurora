// 下载任务页的计时钩子：每秒的吞吐采样。

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { Task } from "../../domain/types";
import { SAMPLE_INTERVAL_MS } from "./constants";
import { pushSample, takeSample, type ThroughputSample } from "./model";

/**
 * 每秒采一次运行中任务的速度，曲线画的是「最近 N 秒」的吞吐，而不是任务自报的瞬时值。
 * 只在本页挂载期间采样，离开即丢弃。没有运行中的任务、且窗口里的采样已全部为 0 时停表：
 * 此后的采样必然还是 0，停表不改变画面，也不让空闲的页面每秒重渲染。
 */
export function useThroughput(running: readonly Task[]): readonly ThroughputSample[] {
  const latest = useRef(running);
  useLayoutEffect(() => {
    latest.current = running;
  });
  const [history, setHistory] = useState<ThroughputSample[]>([]);
  const ticking = running.length > 0 || history.some((s) => s.total > 0);
  useEffect(() => {
    if (!ticking) return;
    const sample = () => setHistory((h) => pushSample(h, takeSample(latest.current)));
    // 开表时立刻采一次，否则刚进页的第一秒曲线是空的，会误显示「没有下载流量」
    sample();
    const timer = setInterval(sample, SAMPLE_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [ticking]);
  return history;
}
