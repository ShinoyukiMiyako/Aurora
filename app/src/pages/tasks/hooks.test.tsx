// @vitest-environment jsdom
// 吞吐曲线的逐采样状态（useChartFrame）：纵轴上限接着上一个采样时的值回落，新的峰值立刻抬上去；
// 采样序号每来一个新采样加一（曲线的滑动以它为键重新起步），同一个采样期间的重渲染（进度每 100 ms 一次）不推进它。
// 剩余时间的估速（usePacedEtaSpeed）：只在已下大小换字时换，之间沿用；没有速度与刚有速度时不等节拍。
import { afterEach, describe, expect, it } from "vitest";
import { render, type Rendered } from "../../test/dom";
import { CHART_CEILING_DECAY, CHART_MIN_CEILING_BPS } from "./constants";
import { useChartFrame, usePacedEtaSpeed } from "./hooks";
import type { ThroughputSample } from "./model";

const MB = 1024 * 1024;

let view: Rendered | undefined;
afterEach(() => {
  view?.unmount();
  view = undefined;
});

function FrameProbe({ history }: { history: readonly ThroughputSample[] }) {
  const frame = useChartFrame(history);
  return <span data-seq={frame.seq} data-ceiling={frame.ceiling} />;
}

function frame(): { seq: number; ceiling: number } {
  const el = view?.container.querySelector("span");
  if (el === null || el === undefined) throw new Error("探针还没有挂载");
  return { seq: Number(el.dataset.seq), ceiling: Number(el.dataset.ceiling) };
}

const sample = (total: number): ThroughputSample => ({ total, tasks: { t: total } });

describe("useChartFrame", () => {
  it("峰值滑出窗口后上限每个采样只回落一档，新的峰值立刻抬上去；序号每个新采样加一", () => {
    view = render(<FrameProbe history={[]} />);
    expect(frame()).toEqual({ seq: 0, ceiling: CHART_MIN_CEILING_BPS });

    const peak = [sample(20 * MB)];
    view.rerender(<FrameProbe history={peak} />);
    expect(frame()).toEqual({ seq: 1, ceiling: 20 * MB });

    // 同一个采样期间的重渲染（换了数组，最新的采样还是那一个）：上限与序号都不动
    view.rerender(<FrameProbe history={[...peak]} />);
    expect(frame()).toEqual({ seq: 1, ceiling: 20 * MB });

    // 峰值已不在窗口里：上限从 20 MB 一档一档往下落，不一下子掉到 1 MB
    view.rerender(<FrameProbe history={[sample(MB)]} />);
    expect(frame().seq).toBe(2);
    expect(frame().ceiling).toBeCloseTo(20 * MB * CHART_CEILING_DECAY, 0);
    view.rerender(<FrameProbe history={[sample(MB)]} />);
    expect(frame().seq).toBe(3);
    expect(frame().ceiling).toBeCloseTo(20 * MB * CHART_CEILING_DECAY ** 2, 0);

    // 新的峰值高过回落中的上限：立刻抬到它，不慢慢涨
    view.rerender(<FrameProbe history={[sample(MB), sample(30 * MB)]} />);
    expect(frame()).toEqual({ seq: 4, ceiling: 30 * MB });
  });
});

describe("usePacedEtaSpeed", () => {
  function PaceProbe({ beat, speed }: { beat: number; speed: number }) {
    return <span>{usePacedEtaSpeed(beat, speed)}</span>;
  }
  const paced = () => Number(view?.container.textContent);

  it("已下大小没换字时估速怎么变都沿用换字那一刻的；换字的那一刻取最新的", () => {
    view = render(<PaceProbe beat={10 * MB} speed={4 * MB} />);
    expect(paced()).toBe(4 * MB);
    // 采样换了、瞬时速度变了：已下大小还是那个字，剩余时间不跟着跳
    view.rerender(<PaceProbe beat={10 * MB} speed={6 * MB} />);
    expect(paced()).toBe(4 * MB);
    view.rerender(<PaceProbe beat={10 * MB} speed={3 * MB} />);
    expect(paced()).toBe(4 * MB);
    // 已下大小换字：取这一刻的估速，之后再沿用它
    view.rerender(<PaceProbe beat={14 * MB} speed={5 * MB} />);
    expect(paced()).toBe(5 * MB);
    view.rerender(<PaceProbe beat={14 * MB} speed={9 * MB} />);
    expect(paced()).toBe(5 * MB);
    // 换批次从 0 重来同样算换字
    view.rerender(<PaceProbe beat={0} speed={2 * MB} />);
    expect(paced()).toBe(2 * MB);
  });

  it("速度落到 0 立即给 0（调用方写等待数据），不沿用旧估速；刚有速度时不等下一次换字", () => {
    view = render(<PaceProbe beat={10 * MB} speed={4 * MB} />);
    view.rerender(<PaceProbe beat={10 * MB} speed={0} />);
    expect(paced()).toBe(0);
    // 已下大小没换字，但沿用的是 0：有了速度立即换上，不拿 0 去估出无穷
    view.rerender(<PaceProbe beat={10 * MB} speed={3 * MB} />);
    expect(paced()).toBe(3 * MB);
    // 换上之后照常沿用到下一次换字
    view.rerender(<PaceProbe beat={10 * MB} speed={7 * MB} />);
    expect(paced()).toBe(3 * MB);
    // 挂载时就没有速度：同样一有速度就换上
    view.unmount();
    view = render(<PaceProbe beat={0} speed={0} />);
    expect(paced()).toBe(0);
    view.rerender(<PaceProbe beat={0} speed={MB} />);
    expect(paced()).toBe(MB);
  });
});
