// @vitest-environment jsdom
import { MotionConfig } from "framer-motion";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, type Rendered } from "../test/dom";
import { SPRING_PARAMS } from "./motion";
import {
  averageAt,
  COMPLETION_HOLD_S,
  feedCount,
  feedSpeed,
  finishingAt,
  publishCount,
  publishSpeed,
  SPEED_REFRESH_MS,
  SPEED_SMOOTHING_S,
  speedSettled,
  startCount,
  startSpeed,
  useCompletionHold,
  useDisplayCount,
  useDisplaySpeed,
  useFinishing,
  type FinishedItem,
} from "./progress-display";

const T0 = 1_730_000_000_000;
const MB = 1024 * 1024;

describe("显示速度：指数平均", () => {
  it("第一次拿到速度直接显示", () => {
    expect(startSpeed(3 * MB, T0)).toEqual({ raw: 3 * MB, average: 3 * MB, at: T0, shown: 3 * MB, shownAt: T0 });
  });

  it("平均值按时间常数向最新速度靠拢：过一个时间常数走完 1 - 1/e", () => {
    const s = { ...startSpeed(0, T0), raw: 10 * MB, average: 0 };
    expect(averageAt(s, T0)).toBe(0);
    expect(averageAt(s, T0 + SPEED_SMOOTHING_S * 1000)).toBeCloseTo(10 * MB * (1 - Math.exp(-1)), 0);
    // 时钟往回走不倒推
    expect(averageAt(s, T0 - 500)).toBe(0);
  });

  it("新速度不满换字间隔时只并入平均、不换字；满了才换，换上的是平均值而不是瞬时值", () => {
    let s = startSpeed(10 * MB, T0);
    s = feedSpeed(s, 20 * MB, T0 + 100);
    expect(s.shown).toBe(10 * MB);
    expect(s.raw).toBe(20 * MB);
    // 前 100 ms 速度一直是 10 MB/s：平均值还在 10 MB/s
    expect(s.average).toBe(10 * MB);
    s = feedSpeed(s, 20 * MB + 1, T0 + SPEED_REFRESH_MS);
    expect(s.shownAt).toBe(T0 + SPEED_REFRESH_MS);
    const expected = 20 * MB + (10 * MB - 20 * MB) * Math.exp(-(SPEED_REFRESH_MS - 100) / 1000 / SPEED_SMOOTHING_S);
    expect(s.shown).toBeCloseTo(expected, 0);
    expect(s.shown).toBeGreaterThan(10 * MB);
    expect(s.shown).toBeLessThan(20 * MB);
  });

  it("速度落到 0 立刻显示 0；从 0 开始传立刻显示新速度，不从 0 慢慢爬", () => {
    const stopped = feedSpeed(startSpeed(8 * MB, T0), 0, T0 + 100);
    expect(stopped.shown).toBe(0);
    expect(speedSettled(stopped)).toBe(true);
    const resumed = feedSpeed(stopped, 5 * MB, T0 + 200);
    expect(resumed.shown).toBe(5 * MB);
    expect(speedSettled(resumed)).toBe(true);
  });

  it("追上最新速度（差不到 0.5%）就显示最新速度本身并停止刷新", () => {
    const s = { raw: 10 * MB, average: 10 * MB * 1.004, at: T0, shown: 9 * MB, shownAt: T0 - SPEED_REFRESH_MS };
    const published = publishSpeed(s, T0);
    expect(published.shown).toBe(10 * MB);
    expect(speedSettled(published)).toBe(true);
    const far = publishSpeed({ ...s, average: 12 * MB }, T0);
    expect(far.shown).toBe(12 * MB);
    expect(speedSettled(far)).toBe(false);
  });

  it("速度不是非负有限数是调用方的错", () => {
    expect(() => startSpeed(-1, T0)).toThrow("非负有限数");
    expect(() => feedSpeed(startSpeed(1, T0), Number.NaN, T0)).toThrow("非负有限数");
  });
});

describe("累计量：按间隔换字", () => {
  const TOTAL = 100 * MB;

  it("第一次拿到直接显示", () => {
    expect(startCount(3 * MB, T0)).toEqual({ raw: 3 * MB, shown: 3 * MB, shownAt: T0 });
  });

  it("不满换字间隔只记下最新值、不换字；满了换上的是最新报上来的值本身，不做平均", () => {
    let s = startCount(10 * MB, T0);
    s = feedCount(s, 11 * MB, TOTAL, T0 + 100);
    s = feedCount(s, 12 * MB, TOTAL, T0 + SPEED_REFRESH_MS - 1);
    expect(s).toEqual({ raw: 12 * MB, shown: 10 * MB, shownAt: T0 });
    s = feedCount(s, 13 * MB, TOTAL, T0 + SPEED_REFRESH_MS);
    expect(s).toEqual({ raw: 13 * MB, shown: 13 * MB, shownAt: T0 + SPEED_REFRESH_MS });
  });

  // 显示停在 0 的那半拍里数据已经在流，旁边的百分数早已走起来
  it("从 0 开始传：第一个非零值立即换上，不在 0 上停满一个间隔；之后照常等间隔", () => {
    let s = startCount(0, T0);
    s = feedCount(s, 0, TOTAL, T0 + 100);
    expect(s).toEqual({ raw: 0, shown: 0, shownAt: T0 });
    s = feedCount(s, 2 * MB, TOTAL, T0 + 200);
    expect(s).toEqual({ raw: 2 * MB, shown: 2 * MB, shownAt: T0 + 200 });
    s = feedCount(s, 3 * MB, TOTAL, T0 + 300);
    expect(s).toEqual({ raw: 3 * MB, shown: 2 * MB, shownAt: T0 + 200 });
    // 换源后从 0 重来，重来后的第一个非零值同样立即换上
    s = feedCount(s, 0, TOTAL, T0 + 400);
    s = feedCount(s, MB, TOTAL, T0 + 450);
    expect(s).toEqual({ raw: MB, shown: MB, shownAt: T0 + 450 });
  });

  it("变小了（换源后从 0 重来）立即换上，不停在作废的旧值上", () => {
    const s = feedCount(startCount(40 * MB, T0), 41 * MB, TOTAL, T0 + 100);
    expect(feedCount(s, 0, null, T0 + 200)).toEqual({ raw: 0, shown: 0, shownAt: T0 + 200 });
  });

  it("到了总量立即换上；总量未知时照常等间隔", () => {
    const s = startCount(99 * MB, T0);
    expect(feedCount(s, TOTAL, TOTAL, T0 + 100).shown).toBe(TOTAL);
    expect(feedCount(s, TOTAL, null, T0 + 100).shown).toBe(99 * MB);
  });

  it("补上的是最后报上来的值，换字时刻记为补上的那一刻", () => {
    const s = feedCount(startCount(10 * MB, T0), 12 * MB, TOTAL, T0 + 100);
    expect(publishCount(s, T0 + SPEED_REFRESH_MS)).toEqual({ raw: 12 * MB, shown: 12 * MB, shownAt: T0 + SPEED_REFRESH_MS });
  });

  it("累计量不是非负有限数是调用方的错", () => {
    expect(() => startCount(-1, T0)).toThrow("非负有限数");
    expect(() => feedCount(startCount(1, T0), Number.POSITIVE_INFINITY, null, T0)).toThrow("非负有限数");
  });
});

describe("完成时的收尾", () => {
  it("收尾时长是一个 settle 弹簧的感知时长", () => {
    expect(COMPLETION_HOLD_S).toBe(SPRING_PARAMS.settle.duration);
  });

  it("完成不到收尾时长的算在收尾，给出最早一个收尾结束的时刻；到点、超过或时钟往回调过的不算", () => {
    const holdMs = COMPLETION_HOLD_S * 1000;
    const done: FinishedItem[] = [
      { id: "fresh", finishedAt: T0 - 100 },
      { id: "older", finishedAt: T0 - 200 },
      { id: "edge", finishedAt: T0 - holdMs },
      { id: "long-ago", finishedAt: T0 - 60_000 },
      { id: "future", finishedAt: T0 + 50 },
    ];
    const { ids, until } = finishingAt(done, T0, COMPLETION_HOLD_S);
    expect([...ids].sort()).toEqual(["fresh", "older"]);
    expect(until).toBe(T0 - 200 + holdMs);
    expect(finishingAt(done, T0, 0)).toEqual({ ids: new Set(), until: null });
  });
});

describe("显示速度与收尾的钩子", () => {
  let view: Rendered | undefined;
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
  });
  afterEach(() => {
    view?.unmount();
    view = undefined;
    vi.useRealTimers();
  });

  function SpeedProbe({ raw }: { raw: number }) {
    return <span>{useDisplaySpeed(raw)}</span>;
  }
  const shown = () => Number(view?.container.textContent);

  it("useDisplaySpeed：快速变化的速度每 500 ms 才换一次字，停在新值上之后按间隔追上它", () => {
    view = render(<SpeedProbe raw={10 * MB} />);
    expect(shown()).toBe(10 * MB);
    for (let i = 1; i <= 4; i++) {
      act(() => void vi.advanceTimersByTime(100));
      view.rerender(<SpeedProbe raw={(10 + i) * MB} />);
      expect(shown()).toBe(10 * MB);
    }
    act(() => void vi.advanceTimersByTime(100));
    view.rerender(<SpeedProbe raw={20 * MB} />);
    const first = shown();
    expect(first).toBeGreaterThan(10 * MB);
    expect(first).toBeLessThan(20 * MB);
    // 速度不再变：定时器每 500 ms 换一次字，一直追到 20 MB/s 本身
    act(() => void vi.advanceTimersByTime(SPEED_REFRESH_MS - 1));
    expect(shown()).toBe(first);
    act(() => void vi.advanceTimersByTime(1));
    expect(shown()).toBeGreaterThan(first);
    act(() => void vi.advanceTimersByTime(30_000));
    expect(shown()).toBe(20 * MB);
  });

  function CountProbe({ raw, total }: { raw: number; total: number | null }) {
    return <span>{useDisplayCount(raw, total)}</span>;
  }

  it("useDisplayCount：从 0 开始传的第一条立即换上；之后每 100 ms 一条进度，字每 500 ms 才换一次；进度停下后最后一条在间隔满时补上", () => {
    const total = 100 * MB;
    view = render(<CountProbe raw={0} total={total} />);
    expect(shown()).toBe(0);
    act(() => void vi.advanceTimersByTime(100));
    view.rerender(<CountProbe raw={MB} total={total} />);
    expect(shown()).toBe(MB);
    for (let i = 2; i <= 5; i++) {
      act(() => void vi.advanceTimersByTime(100));
      view.rerender(<CountProbe raw={i * MB} total={total} />);
      expect(shown()).toBe(MB);
    }
    // 换上 1 MB 之后间隔满的那一刻换上最近报上来的 5 MB，紧接着到的 6 MB 等下一个间隔
    act(() => void vi.advanceTimersByTime(100));
    expect(shown()).toBe(5 * MB);
    view.rerender(<CountProbe raw={6 * MB} total={total} />);
    expect(shown()).toBe(5 * MB);
    // 进度停在 6 MB：不等下一条事件，到间隔满时补上
    act(() => void vi.advanceTimersByTime(SPEED_REFRESH_MS - 1));
    expect(shown()).toBe(5 * MB);
    act(() => void vi.advanceTimersByTime(1));
    expect(shown()).toBe(6 * MB);
  });

  it("useDisplayCount：换源后从 0 重来、重来后的第一条、传到总量都立即换上；总量后到、恰好等于已报的值时也立即换上", () => {
    const total = 100 * MB;
    view = render(<CountProbe raw={40 * MB} total={total} />);
    act(() => void vi.advanceTimersByTime(100));
    view.rerender(<CountProbe raw={0} total={null} />);
    expect(shown()).toBe(0);
    act(() => void vi.advanceTimersByTime(100));
    view.rerender(<CountProbe raw={total} total={total} />);
    expect(shown()).toBe(total);
    view.rerender(<CountProbe raw={0} total={null} />);
    act(() => void vi.advanceTimersByTime(100));
    view.rerender(<CountProbe raw={MB} total={null} />);
    expect(shown()).toBe(MB);
    act(() => void vi.advanceTimersByTime(100));
    view.rerender(<CountProbe raw={2 * MB} total={null} />);
    expect(shown()).toBe(MB);
    view.rerender(<CountProbe raw={2 * MB} total={2 * MB} />);
    expect(shown()).toBe(2 * MB);
  });

  function FinishingProbe({ done, hold }: { done: readonly FinishedItem[]; hold: number }) {
    return <span>{[...useFinishing(done, hold)].join(",")}</span>;
  }

  it("useFinishing：刚完成的在收尾时长内留着，到点自动放行", () => {
    const done = [{ id: "a", finishedAt: T0 }];
    view = render(<FinishingProbe done={done} hold={COMPLETION_HOLD_S} />);
    expect(view.container.textContent).toBe("a");
    act(() => void vi.advanceTimersByTime(COMPLETION_HOLD_S * 1000 - 1));
    expect(view.container.textContent).toBe("a");
    act(() => void vi.advanceTimersByTime(1));
    expect(view.container.textContent).toBe("");
  });

  it("useFinishing：定时器到点时墙钟还差 1 ms 没到收尾结束（时钟漂移），按剩余时间再排一次，照样放行", () => {
    const holdMs = COMPLETION_HOLD_S * 1000;
    view = render(<FinishingProbe done={[{ id: "a", finishedAt: T0 }]} hold={COMPLETION_HOLD_S} />);
    // 墙钟往回拨 1 ms，定时器的计时不受影响：它到点时墙钟停在收尾结束前 1 ms
    vi.setSystemTime(T0 - 1);
    act(() => void vi.advanceTimersByTime(holdMs));
    expect(Date.now()).toBe(T0 + holdMs - 1);
    expect(view.container.textContent).toBe("a");
    act(() => void vi.advanceTimersByTime(1));
    expect(view.container.textContent).toBe("");
  });

  function HoldProbe() {
    return <span>{useCompletionHold()}</span>;
  }

  it("useCompletionHold：减少动画时为 0，不用等", () => {
    view = render(<HoldProbe />);
    expect(view.container.textContent).toBe(String(COMPLETION_HOLD_S));
    view.rerender(
      <MotionConfig reducedMotion="always">
        <HoldProbe />
      </MotionConfig>,
    );
    expect(view.container.textContent).toBe("0");
  });
});
