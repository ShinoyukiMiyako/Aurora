// @vitest-environment jsdom
// 百分数随平滑逐帧走。数中间值的用例走假时钟（startFrameClock），用 stepFrames 逐帧推进；其余用例走真实时间，用 waitForFrames 等。
import { MotionConfig, motionValue } from "framer-motion";
import { act, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { drainFrames, render, stepFrames, waitForFrames, type Rendered } from "../test/dom";
import { PercentOf, SmoothPercent } from "./SmoothPercent";

let view: Rendered | undefined;
/** 这个用例的帧跟着假时钟走（startFrameClock）：收尾先卸载、再在假时钟上把帧循环排空，才换回真实计时器。 */
let frameClock = false;
afterEach(async () => {
  view?.unmount();
  view = undefined;
  if (frameClock) await drainFrames();
  frameClock = false;
  vi.useRealTimers();
});

/**
 * 数中间值的用例让帧跟着假时钟走，用 stepFrames 逐帧推进。按真实时间走的话，机器满载时一帧晚到就可能把平滑整段走完，
 * 一个中间值也录不到。换之前先在真实计时器上把帧循环排空（见 test/dom 的 drainFrames）。
 */
async function startFrameClock() {
  await drainFrames();
  vi.useFakeTimers();
  frameClock = true;
}

/** 平滑（settle 弹簧）在这么多帧（约 1 秒）之内落定。 */
const SETTLE_FRAMES = 60;

function text(): string | null {
  if (view === undefined) throw new Error("还没有挂载");
  return view.container.textContent;
}

/** 记下此后文字的每一次变化：平滑时一帧换一个中间值，直接到位时只换一次。 */
function watchTexts(): { seen: string[]; stop(): void } {
  if (view === undefined) throw new Error("还没有挂载");
  const seen: string[] = [];
  const observer = new MutationObserver(() => {
    const current = text();
    if (current !== null) seen.push(current);
  });
  observer.observe(view.container, { subtree: true, childList: true, characterData: true });
  return { seen, stop: () => observer.disconnect() };
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

describe("进度旁的百分数", () => {
  it("挂载时直接写当前进度；进度变了跟着进度条同一种平滑一帧帧走过去，不当场跳到新值", async () => {
    await startFrameClock();
    view = render(<SmoothPercent value={0.2} track="a" />);
    expect(text()).toBe("20%");
    const texts = watchTexts();
    view.rerender(<SmoothPercent value={0.6} track="a" />);
    expect(text()).toBe("20%");
    await stepFrames(SETTLE_FRAMES);
    expect(text()).toBe("60%");
    texts.stop();
    // 一帧换一个更大的中间值，走了好几帧才到
    expect(texts.seen.filter((t) => t !== "20%" && t !== "60%").length).toBeGreaterThan(5);
    const percents = texts.seen.map((t) => Number.parseInt(t, 10));
    for (let i = 1; i < percents.length; i++) expect(percents[i]).toBeGreaterThan(percents[i - 1]);
  });

  it("同一批内只进不退：后端分批上报回落时停在原处", async () => {
    view = render(<SmoothPercent value={0.8} track="a" />);
    view.rerender(<SmoothPercent value={0.3} track="a" />);
    await sleep(120);
    expect(text()).toBe("80%");
  });

  it("减少动画时直接写到新值，没有中间值", async () => {
    const reduced = (node: ReactNode) => <MotionConfig reducedMotion="always">{node}</MotionConfig>;
    view = render(reduced(<SmoothPercent value={0.2} track="a" />));
    const texts = watchTexts();
    view.rerender(reduced(<SmoothPercent value={0.9} track="a" />));
    await waitForFrames(() => expect(text()).toBe("90%"));
    texts.stop();
    expect(texts.seen.filter((t) => t !== "20%" && t !== "90%")).toEqual([]);
  });
});

describe("读现成平滑的百分数", () => {
  it("挂载时写平滑值此刻的数；平滑值每变一次当场换字，不另起弹簧、不落后", () => {
    const smooth = motionValue(0.3);
    view = render(<PercentOf value={smooth} />);
    expect(text()).toBe("30%");
    act(() => smooth.set(0.42));
    expect(text()).toBe("42%");
    act(() => smooth.set(0.427));
    expect(text()).toBe("43%");
  });
});
