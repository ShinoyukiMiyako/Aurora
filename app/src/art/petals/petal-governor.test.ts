import { describe, expect, it } from "vitest";
import { GOVERNOR_WARMUP_MS, GOVERNOR_WINDOW_MS, PetalGovernor, median, type GovernorDowngrade } from "./governor";

/** 从 start 起按 intervals 依次采样，返回最后的时间戳与途中产生的降级。 */
function feed(governor: PetalGovernor, start: number, intervals: readonly number[]): { now: number; downgrades: { at: number; result: GovernorDowngrade }[] } {
  let now = start;
  const downgrades: { at: number; result: GovernorDowngrade }[] = [];
  for (const interval of intervals) {
    now += interval;
    const result = governor.sample(now);
    if (result !== null) downgrades.push({ at: now, result });
  }
  return { now, downgrades };
}

const repeat = (interval: number, totalMs: number): number[] => Array.from({ length: Math.ceil(totalMs / interval) }, () => interval);

describe("median", () => {
  it("奇数取中间、偶数取两个中间值的平均，不改动输入", () => {
    const values = [30, 10, 20];
    expect(median(values)).toBe(20);
    expect(values).toEqual([30, 10, 20]);
    expect(median([16, 40, 16, 100])).toBe(28);
    expect(median([7])).toBe(7);
    expect(() => median([])).toThrow("中位数");
  });
});

describe("PetalGovernor", () => {
  it("连续两个窗口中位数都超过 28 ms 才降到一级，结果带两窗中位数", () => {
    const g = new PetalGovernor();
    g.sample(0);
    const { downgrades } = feed(g, 0, repeat(40, GOVERNOR_WARMUP_MS + 2 * GOVERNOR_WINDOW_MS + 200));
    expect(downgrades).toHaveLength(1);
    expect(downgrades[0].result).toEqual({ level: 1, windowMediansMs: [40, 40] });
    // 预热 1000 ms 后第一个计入的采样开窗，两个 2000 ms 窗口之后才降级
    expect(downgrades[0].at).toBeGreaterThanOrEqual(GOVERNOR_WARMUP_MS + 2 * GOVERNOR_WINDOW_MS);
    expect(downgrades[0].at).toBeLessThan(GOVERNOR_WARMUP_MS + 2 * GOVERNOR_WINDOW_MS + 80);
    expect(g.level).toBe(1);
    expect(g.lastWindowMedianMs).toBe(40);
  });

  it("中位数恰为 28 ms 不算慢窗口", () => {
    const g = new PetalGovernor();
    g.sample(0);
    expect(feed(g, 0, repeat(28, 12000)).downgrades).toEqual([]);
    expect(g.level).toBe(0);
    expect(g.lastWindowMedianMs).toBe(28);
  });

  it("慢窗口之间夹一个快窗口不降级", () => {
    const g = new PetalGovernor();
    g.sample(0);
    const slow = feed(g, 0, repeat(40, GOVERNOR_WARMUP_MS + GOVERNOR_WINDOW_MS + 40));
    const fast = feed(g, slow.now, repeat(16, GOVERNOR_WINDOW_MS + 16));
    expect(g.lastWindowMedianMs).toBe(16);
    const slowAgain = feed(g, fast.now, repeat(40, GOVERNOR_WINDOW_MS + 40));
    expect(g.lastWindowMedianMs).toBe(40);
    expect([...slow.downgrades, ...fast.downgrades, ...slowAgain.downgrades]).toEqual([]);
    expect(g.level).toBe(0);
  });

  it("中位数不受偶发长帧影响", () => {
    const g = new PetalGovernor();
    g.sample(0);
    const spiky = Array.from({ length: 1200 }, (_, i) => (i % 3 === 0 ? 120 : 16));
    expect(feed(g, 0, spiky).downgrades).toEqual([]);
    expect(g.lastWindowMedianMs).toBe(16);
  });

  it("挂载后的前 1000 ms 不计：第一个窗口从预热结束时开窗", () => {
    const g = new PetalGovernor();
    g.sample(0);
    // 16 ms 一帧：第一个计入的采样在 1008 ms，窗口到 3008 ms 才结束
    const { now } = feed(g, 0, repeat(16, 2990));
    expect(now).toBe(2992);
    expect(g.lastWindowMedianMs).toBeNull();
    feed(g, now, [16]);
    expect(g.lastWindowMedianMs).toBe(16);
  });

  it("同一次挂载内只降不升：一级之后再快也不回到 0，再连续两窗慢降到二级，之后不再报告", () => {
    const g = new PetalGovernor();
    g.sample(0);
    let { now } = feed(g, 0, repeat(40, GOVERNOR_WARMUP_MS + 2 * GOVERNOR_WINDOW_MS + 40));
    expect(g.level).toBe(1);
    ({ now } = feed(g, now, repeat(16, 3 * GOVERNOR_WINDOW_MS)));
    expect(g.level).toBe(1);
    const second = feed(g, now, repeat(50, 2 * GOVERNOR_WINDOW_MS + 100));
    expect(second.downgrades.map((d) => d.result)).toEqual([{ level: 2, windowMediansMs: [50, 50] }]);
    expect(g.level).toBe(2);
    expect(feed(g, second.now, repeat(80, 3 * GOVERNOR_WINDOW_MS)).downgrades).toEqual([]);
    expect(g.level).toBe(2);
  });

  it("暂停恢复后重新预热并作废未结束的连续计数，已降的级别保留", () => {
    const g = new PetalGovernor();
    g.sample(0);
    // 一个慢窗口后暂停
    let { now } = feed(g, 0, repeat(40, GOVERNOR_WARMUP_MS + GOVERNOR_WINDOW_MS + 40));
    g.restart();
    now += 60_000;
    // 恢复后第一次采样只作起点：暂停时长不算成一个超长间隔
    expect(g.sample(now)).toBeNull();
    // 恢复后再有一个慢窗口：与暂停前那个不连续，不降级
    ({ now } = feed(g, now, repeat(40, GOVERNOR_WARMUP_MS + GOVERNOR_WINDOW_MS + 40)));
    expect(g.level).toBe(0);
    // 再一个慢窗口才与前一个连续
    const result = feed(g, now, repeat(40, GOVERNOR_WINDOW_MS + 40));
    expect(result.downgrades.map((d) => d.result.level)).toEqual([1]);
    g.restart();
    expect(g.level).toBe(1);
  });
});
