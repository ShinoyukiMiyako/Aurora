// 运行呼吸的窗口：游戏可能运行数小时，呼吸只在「刚进入运行」与「窗口重新获得焦点」后的 3 个周期内播放，
// 其余时间是静止帧。外壳决定何时开始、何时结束（失焦或不可见立即结束），计时与 <html> 上的标记在这里：
// 窗口期间 <html> 带 BREATH_ATTR（值为窗口起点），呼吸元素的样式写 :root[data-sk-breath] 下的无限循环动画。
// 窗口长度是整周期，结束时都停在首帧，不跳变。窗口内新挂载的元素按起点算负延迟，与已有元素同相；
// 每个新窗口开始时所有元素的延迟清零，一起从首帧起播。

import { useLayoutEffect, type RefObject } from "react";

export const BREATH_ATTR = "data-sk-breath";

/** 与 --sk-loop-breath 一致。 */
export const BREATH_PERIOD_MS = 2800;
export const BREATH_CYCLES = 3;

/** 呼吸元素的 animation-delay 取这个私有变量。 */
export const BREATH_DELAY_VAR = "--breath-delay";

const restartListeners = new Set<() => void>();
let windowTimer: ReturnType<typeof setTimeout> | null = null;

/** 当前呼吸窗口的起点；不在窗口内为 null。 */
export function breathWindowStart(root: HTMLElement = document.documentElement): number | null {
  const raw = root.getAttribute(BREATH_ATTR);
  if (raw === null) return null;
  const start = Number(raw);
  if (!Number.isFinite(start)) throw new Error(`${BREATH_ATTR} 的值不是时间戳：${raw}`);
  return start;
}

/** 窗口内新挂载的呼吸元素的相位延迟：−((now − 起点) mod 周期)。 */
export function breathDelayMs(windowStart: number, now: number): number {
  return -((now - windowStart) % BREATH_PERIOD_MS);
}

/** 开始一个 3 周期的呼吸窗口；已在窗口内时从头再来。 */
export function startBreathWindow(now: number = Date.now(), root: HTMLElement = document.documentElement): void {
  if (windowTimer !== null) clearTimeout(windowTimer);
  if (root.hasAttribute(BREATH_ATTR)) {
    root.removeAttribute(BREATH_ATTR);
    // 同一帧里先删后加不会重启 CSS 动画，中间强制一次样式计算
    void root.offsetWidth;
  }
  for (const listener of [...restartListeners]) listener();
  root.setAttribute(BREATH_ATTR, String(now));
  windowTimer = setTimeout(() => endBreathWindow(root), BREATH_PERIOD_MS * BREATH_CYCLES);
}

export function endBreathWindow(root: HTMLElement = document.documentElement): void {
  if (windowTimer !== null) clearTimeout(windowTimer);
  windowTimer = null;
  root.removeAttribute(BREATH_ATTR);
}

/** 呼吸元素挂载时按当前窗口对齐相位，之后每个新窗口开始时延迟清零。 */
export function useBreathPhase(ref: RefObject<HTMLElement | null>, active: boolean): void {
  useLayoutEffect(() => {
    const el = ref.current;
    if (!active || el === null) return;
    const start = breathWindowStart();
    el.style.setProperty(BREATH_DELAY_VAR, start === null ? "0ms" : `${breathDelayMs(start, Date.now())}ms`);
    const reset = () => el.style.setProperty(BREATH_DELAY_VAR, "0ms");
    restartListeners.add(reset);
    return () => {
      restartListeners.delete(reset);
    };
  }, [ref, active]);
}
