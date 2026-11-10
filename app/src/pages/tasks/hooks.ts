// 下载任务页的计时钩子：每秒的吞吐采样，曲线随采样推进的状态，以及剩余时间跟着已下大小换字的节拍。

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { Task } from "../../domain/types";
import { SAMPLE_INTERVAL_MS } from "./constants";
import { chartCeiling, pushSample, takeSample, type ThroughputSample } from "./model";

export interface ChartFrame {
  /** 纵轴上限（chartCeiling）：峰值滑出窗口后慢慢回落。 */
  ceiling: number;
  /** 采样序号：每来一个新采样加一，曲线的滑动以它为键重新起步。 */
  seq: number;
}

/**
 * 曲线的逐采样状态。上限要接着上一个采样时的值回落，所以记在这里；新采样在渲染里并进来，不多一次提交，
 * 进度每 100 ms 一次的重渲染不推进它。
 */
export function useChartFrame(history: readonly ThroughputSample[]): ChartFrame {
  const newest = history.length === 0 ? null : history[history.length - 1];
  const totals = () => history.map((s) => s.total);
  const [frame, setFrame] = useState(() => ({ newest, seq: 0, ceiling: chartCeiling(null, totals()) }));
  if (frame.newest === newest) return frame;
  const next = { newest, seq: frame.seq + 1, ceiling: chartCeiling(frame.ceiling, totals()) };
  setFrame(next);
  return next;
}

/**
 * 估剩余时间用的速度，跟着挨在旁边的已下大小一起换：beat（写出来的已下字节）变了的那一刻取一次最新的估速，之间一直沿用。
 * 估速每秒随采样变一次，窗口里还没有采样时更是随瞬时速度每 100 ms 变；照算的话剩余时间会在已下大小两次换字之间自己跳，
 * 比已下大小换得还勤。
 * 估速不是正数（没有数据在流）时不沿用旧值，调用方据此写「等待数据」；沿用的是 0 而眼下有了速度，也不等下一拍、立即换上，
 * 拿 0 去估只会得出无穷。
 */
export function usePacedEtaSpeed(beat: number, speed: number): number {
  const [held, setHeld] = useState({ beat, speed });
  const fresh = held.beat !== beat || held.speed <= 0 || speed <= 0;
  // 在渲染里就换上（不多一次提交）：beat 本身就是随这次渲染换的
  if (fresh && (held.beat !== beat || held.speed !== speed)) setHeld({ beat, speed });
  return fresh ? speed : held.speed;
}

/**
 * 每秒采一次运行中任务的速度，曲线画的是「最近 N 秒」的吞吐，而不是任务自报的瞬时值。
 * 只在本页挂载期间采样，离开即丢弃。没有运行中的任务、且窗口里的采样已全部为 0 时停表：
 * 此后的采样必然还是 0，停表不改变曲线，也不让空闲的页面每秒重渲染。
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
    // 开表时立刻采一次：进页的第一秒曲线上就有当前速度，不必等满一个间隔
    sample();
    const timer = setInterval(sample, SAMPLE_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [ticking]);
  return history;
}
