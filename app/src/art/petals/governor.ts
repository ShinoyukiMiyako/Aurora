// 花瓣的自动降级：精简系统、老集显或后台装包占满 CPU 时，花瓣不能反过来拖慢整个启动器。
// 记录每两次实际绘制之间的间隔，每 2 s 为一个窗口取中位数（中位数不受偶发长帧影响）；
// 连续两个窗口的中位数都超过 28 ms（约低于 36 fps）才降一级。同一次挂载内只降不升：
// 负载往往是间歇的，升回去再降会让花瓣反复增减，比一直少一点更显眼。

import type { PetalLevel } from "./sim";

/** 挂载与每次恢复后的这段时间不计：首几帧常被样式计算与图片解码拖慢，不代表稳态。 */
export const GOVERNOR_WARMUP_MS = 1000;
export const GOVERNOR_WINDOW_MS = 2000;
/** 窗口中位数严格大于它才算慢窗口。 */
export const GOVERNOR_SLOW_MEDIAN_MS = 28;
export const GOVERNOR_SLOW_WINDOWS = 2;

export interface GovernorDowngrade {
  /** 降到的级别。 */
  level: 1 | 2;
  /** 触发这次降级的连续慢窗口的中位数，按时间先后。 */
  windowMediansMs: readonly number[];
}

export function median(values: readonly number[]): number {
  if (values.length === 0) throw new Error("空集合没有中位数");
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

export class PetalGovernor {
  private levelValue: PetalLevel = 0;
  private lastDrawAt: number | null = null;
  private countFrom = 0;
  private windowStart: number | null = null;
  private intervals: number[] = [];
  private slowMedians: number[] = [];
  private lastMedian: number | null = null;

  get level(): PetalLevel {
    return this.levelValue;
  }

  /** 最近一个已结束窗口的绘制间隔中位数；还没有窗口结束时为 null。 */
  get lastWindowMedianMs(): number | null {
    return this.lastMedian;
  }

  /**
   * 挂载或暂停恢复后调用：下一次采样只作为计时起点，并重新开始预热。
   * 暂停把时间轴切断了，未结束的窗口与连续慢窗口的计数一并作废；已降的级别保留。
   */
  restart(): void {
    this.lastDrawAt = null;
    this.windowStart = null;
    this.intervals = [];
    this.slowMedians = [];
  }

  /** 每次实际绘制后调用一次，now 为该帧时间戳（毫秒）。需要降级时返回降级结果。 */
  sample(now: number): GovernorDowngrade | null {
    if (this.levelValue === 2) return null;
    if (this.lastDrawAt === null) {
      this.lastDrawAt = now;
      this.countFrom = now + GOVERNOR_WARMUP_MS;
      return null;
    }
    const interval = now - this.lastDrawAt;
    this.lastDrawAt = now;
    if (now < this.countFrom) return null;
    if (this.windowStart === null) this.windowStart = now;
    this.intervals.push(interval);
    if (now - this.windowStart < GOVERNOR_WINDOW_MS) return null;

    const m = median(this.intervals);
    this.lastMedian = m;
    this.intervals = [];
    this.windowStart = now;
    if (m > GOVERNOR_SLOW_MEDIAN_MS) this.slowMedians.push(m);
    else this.slowMedians = [];
    if (this.slowMedians.length < GOVERNOR_SLOW_WINDOWS) return null;

    const windowMediansMs = this.slowMedians;
    this.slowMedians = [];
    const level = this.levelValue === 0 ? 1 : 2;
    this.levelValue = level;
    return { level, windowMediansMs };
  }
}
