// @vitest-environment jsdom
// 逐帧看进度环的填充弧：平滑用的 settle 弹簧带一点回弹，补满时会略冲过 1，描边偏移要停在 0，不变成负数。
// 冲过的量只有千分之一上下、只持续几帧，真实计时器下采不采得到看帧时刻；假定时器下帧跟着假时钟走，用 stepFrames 逐帧推进，
// 每次都落在同样的几帧上。收尾先卸载、再排空帧循环，再换回真实计时器。
import { MotionConfig, type MotionValue } from "framer-motion";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { drainFrames, render, stepFrames, type Rendered } from "../test/dom";
import { useSmoothProgress } from "./ProgressBar";
import { ProgressRing, RING_STROKE } from "./ProgressRing";

let view: Rendered | undefined;
let smooth: MotionValue<number> | undefined;

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(async () => {
  view?.unmount();
  view = undefined;
  smooth = undefined;
  await drainFrames();
  vi.useRealTimers();
});

/** 与进度环同一套平滑、同一次提交起步：读出每一帧的平滑值，用来确认采到了冲过 1 的帧。 */
function Probe({ value, track }: { value: number; track: string }) {
  smooth = useSmoothProgress(value, track).smooth;
  return null;
}

function latest(): number {
  if (smooth === undefined) throw new Error("探针未挂载");
  return smooth.get();
}

it("补满时弹簧冲过 1 的那几帧，填充弧的描边偏移停在 0，不变成负数", async () => {
  const size = 36;
  const circumference = 2 * Math.PI * ((size - RING_STROKE[size]) / 2);
  const tree = (value: number) => (
    <MotionConfig reducedMotion="never">
      <ProgressRing value={value} size={size} track="t" label="下载" />
      <Probe value={value} track="t" />
    </MotionConfig>
  );
  view = render(tree(0.5));
  const fill = view.container.querySelectorAll("circle")[1];
  if (fill === undefined) throw new Error("进度环没有填充弧");
  view.rerender(tree(1));

  const frames: { p: number; offset: number }[] = [];
  for (let i = 0; i < 40; i++) {
    await stepFrames(1);
    frames.push({ p: latest(), offset: Number(fill.getAttribute("stroke-dashoffset")) });
  }
  const over = frames.filter((f) => f.p > 1);
  expect(over.length).toBeGreaterThan(0);
  for (const f of over) expect(f.offset).toBe(0);
  for (const f of frames) expect(f.offset).toBeCloseTo(circumference * (1 - Math.min(1, f.p)), 6);
  expect(frames.at(-1)).toEqual({ p: 1, offset: 0 });
});
