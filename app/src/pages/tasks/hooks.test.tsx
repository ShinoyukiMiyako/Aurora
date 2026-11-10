// @vitest-environment jsdom
// 吞吐曲线的逐采样状态（useChartFrame）：纵轴上限接着上一个采样时的值回落，新的峰值立刻抬上去；
// 采样序号每来一个新采样加一（曲线的滑动以它为键重新起步），同一个采样期间的重渲染（进度每 100 ms 一次）不推进它。
import { afterEach, describe, expect, it } from "vitest";
import { render, type Rendered } from "../../test/dom";
import { CHART_CEILING_DECAY, CHART_MIN_CEILING_BPS } from "./constants";
import { useChartFrame } from "./hooks";
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
