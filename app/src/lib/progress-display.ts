// 进度类数字的显示节流：下载速度怎么平滑、多久换一次字，任务完成时进度条推满、留住一拍再交给所在的行。
//
// 后端每 100 ms 报一次进度与瞬时速度。照原样写出来，速度文字一秒跳十次、读不清；任务一完成，行与进度条又在同一次
// 更新里撤掉，进度条停在最后一次上报的位置（常差最后几成），用户从没见过满格。这里只管「显示成什么、何时换」，
// 不改任务本身的数据。百分比文字不在这里：它取进度条用的同一份平滑（ui/ProgressBar 的 useSmoothProgress），字与条同步走。

import { useReducedMotionConfig } from "framer-motion";
import { useEffect, useState } from "react";
import { SPRING_PARAMS } from "./motion";

// ---------------------------------------------------------------- 速度

/** 显示速度的指数平均时间常数（秒）：1 秒前的速度权重降到 1/e，短促的尖峰与掉速被抹平，又不拖着旧值太久。 */
export const SPEED_SMOOTHING_S = 1;
/** 速度文字两次换字的最短间隔（毫秒）：每秒最多换 2 次。 */
export const SPEED_REFRESH_MS = 500;
/** 平均值与最新速度相差不到这个比例就算追上：直接显示最新速度，不再定时刷新。 */
const SPEED_SETTLED_RATIO = 0.005;

export interface SpeedDisplay {
  /** 最近一次报上来的速度（字节每秒）；下一次上报之前一直按它算。 */
  raw: number;
  /** 指数平均在 at 时刻的值。 */
  average: number;
  at: number;
  /** 正在显示的值，以及它换上的时刻。 */
  shown: number;
  shownAt: number;
}

function assertSpeed(raw: number): void {
  if (!Number.isFinite(raw) || raw < 0) throw new Error(`速度必须是非负有限数，收到 ${raw}`);
}

/** 第一次拿到速度：直接显示，没有可平滑的过去。 */
export function startSpeed(raw: number, now: number): SpeedDisplay {
  assertSpeed(raw);
  return { raw, average: raw, at: now, shown: raw, shownAt: now };
}

/** 平均值在 now 时刻走到哪：上一次上报之后速度一直是 raw，平均值按时间常数向它靠拢。 */
export function averageAt(s: SpeedDisplay, now: number): number {
  const dt = Math.max(0, now - s.at) / 1000;
  return s.raw + (s.average - s.raw) * Math.exp(-dt / SPEED_SMOOTHING_S);
}

/** 把平均值推进到 now 并换上显示：已经追上最新速度时显示最新速度本身，免得尾数一直差一点点。 */
export function publishSpeed(s: SpeedDisplay, now: number): SpeedDisplay {
  const average = averageAt(s, now);
  const settled = Math.abs(average - s.raw) <= s.raw * SPEED_SETTLED_RATIO;
  const value = settled ? s.raw : average;
  return { raw: s.raw, average: value, at: now, shown: value, shownAt: now };
}

/**
 * 报上来一个新的速度。平均值先按旧速度推进到此刻，再从此刻起按新速度走；离上次换字满 SPEED_REFRESH_MS 才换字，
 * 不满的由调用方定时补上。两种情况不平滑、直接换上：
 * - 速度落到 0：没有数据在流（停住、传完），平滑只会接着报几秒并不存在的速度；
 * - 从 0 开始传：从 0 慢慢爬上来的那几个数是平滑造出来的，真实速度一开始就是它。
 */
export function feedSpeed(s: SpeedDisplay, raw: number, now: number): SpeedDisplay {
  assertSpeed(raw);
  const average = averageAt(s, now);
  if (raw === 0 || average === 0) return startSpeed(raw, now);
  const next = { raw, average, at: now, shown: s.shown, shownAt: s.shownAt };
  return now - s.shownAt >= SPEED_REFRESH_MS ? publishSpeed(next, now) : next;
}

/** 显示已经停在最新速度上：不用再刷新。 */
export function speedSettled(s: SpeedDisplay): boolean {
  return s.shown === s.raw;
}

/**
 * 显示用的速度：约 1 秒的指数平均，每秒最多换 2 次字。速度不再变时继续按间隔刷新，直到追上最新速度。
 * 新速度在渲染里就并进来（不多一次提交）：进度事件每 100 ms 一次，部件本来就随它重渲染。
 */
export function useDisplaySpeed(raw: number): number {
  const [state, setState] = useState(() => startSpeed(raw, Date.now()));
  let current = state;
  if (raw !== state.raw) {
    current = feedSpeed(state, raw, Date.now());
    setState(current);
  }
  const settled = speedSettled(current);
  const nextAt = current.shownAt + SPEED_REFRESH_MS;
  useEffect(() => {
    if (settled) return;
    const timer = setTimeout(() => setState((s) => publishSpeed(s, Date.now())), Math.max(0, nextAt - Date.now()));
    return () => clearTimeout(timer);
  }, [settled, nextAt]);
  return current.shown;
}

// ---------------------------------------------------------------- 完成时的收尾

/**
 * 任务完成后，进度条推到满格、留住多久再交给所在的行换形（秒）：一个 settle 弹簧的感知时长，进度条的平滑走的也是 settle，
 * 推满正好走完。只留这一拍：它不是用户直接触发的操作，再长就成了拖延。
 */
export const COMPLETION_HOLD_S = SPRING_PARAMS.settle.duration;

/** 当前设置下的收尾时长（秒）：减少动画时进度条直接到位，不用等，为 0。 */
export function useCompletionHold(): number {
  return useReducedMotionConfig() === true ? 0 : COMPLETION_HOLD_S;
}

export interface FinishedItem {
  id: string;
  /** 完成时刻（毫秒时间戳）。 */
  finishedAt: number;
}

/**
 * now 时刻还在收尾（完成不到 holdS 秒）的那些，以及最早一个收尾结束的时刻；没有在收尾的为 null。
 * 完成时刻晚于 now（系统时钟往回调过）不算在收尾：不知道该留多久，宁可直接放行。
 */
export function finishingAt(done: readonly FinishedItem[], now: number, holdS: number): { ids: ReadonlySet<string>; until: number | null } {
  const holdMs = holdS * 1000;
  const ids = new Set<string>();
  let until: number | null = null;
  for (const item of done) {
    const age = now - item.finishedAt;
    if (age < 0 || age >= holdMs) continue;
    ids.add(item.id);
    const end = item.finishedAt + holdMs;
    if (until === null || end < until) until = end;
  }
  return { ids, until };
}

/**
 * 刚完成、还在收尾的任务：调用方让它们留在原处（原来的行、原来的通道），进度条画到满格；holdS 一过自动放行（重渲染一次），
 * 行再按完成去换组、通道再让给下一个任务。done 只传已完成的（失败与取消没有走满这回事）。
 */
export function useFinishing(done: readonly FinishedItem[], holdS: number): ReadonlySet<string> {
  const [tick, setTick] = useState(0);
  const { ids, until } = finishingAt(done, Date.now(), holdS);
  // 定时器到点后的那次渲染里，墙钟可能还差一点没到 until（定时器与墙钟有漂移、系统校时）：until 没变也要按剩余时间再排一次，
  // 所以每次到点（tick 变了）都重排。只看 until 的话这一批会停在满格，要等别的原因重渲染才放行。
  useEffect(() => {
    if (until === null) return;
    const timer = setTimeout(() => setTick((n) => n + 1), Math.max(0, until - Date.now()));
    return () => clearTimeout(timer);
  }, [until, tick]);
  return ids;
}
