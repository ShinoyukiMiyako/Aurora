// 下载任务页的两个计时钩子：每秒的吞吐采样，以及「慢了才出骨架、出了至少留一会儿」的加载门。

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { LOADING_DELAY_MS } from "../../domain/limits";
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

/**
 * 加载门：加载在 LOADING_DELAY_MS 内结束就什么都不显示（避免闪烁）；超过才显示骨架，
 * 骨架一旦出现至少保持同样的时长。
 */
export function useLoadingGate(loading: boolean): boolean {
  const [shown, setShown] = useState(false);
  const shownAt = useRef<number | null>(null);
  useEffect(() => {
    if (loading === shown) return;
    if (loading) {
      const timer = setTimeout(() => {
        shownAt.current = Date.now();
        setShown(true);
      }, LOADING_DELAY_MS);
      return () => clearTimeout(timer);
    }
    const since = shownAt.current;
    if (since === null) throw new Error("骨架已显示却没有记下出现时刻");
    const timer = setTimeout(() => setShown(false), Math.max(0, LOADING_DELAY_MS - (Date.now() - since)));
    return () => clearTimeout(timer);
  }, [loading, shown]);
  return shown;
}
