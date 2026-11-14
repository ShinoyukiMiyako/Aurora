// @vitest-environment jsdom
// 整个文件走真实时间：百分数随平滑逐帧走，framer-motion 的帧循环不受假定时器驱动（见 test/dom 的 waitForFrames）。
import { MotionConfig, motionValue } from "framer-motion";
import { act, type ReactNode } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { render, waitForFrames, type Rendered } from "../test/dom";
import { PercentOf, SmoothPercent } from "./SmoothPercent";

let view: Rendered | undefined;
afterEach(() => {
  view?.unmount();
  view = undefined;
});

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
    view = render(<SmoothPercent value={0.2} track="a" />);
    expect(text()).toBe("20%");
    const texts = watchTexts();
    view.rerender(<SmoothPercent value={0.6} track="a" />);
    expect(text()).toBe("20%");
    await waitForFrames(() => expect(text()).toBe("60%"));
    texts.stop();
    expect(texts.seen.filter((t) => t !== "20%" && t !== "60%").length).toBeGreaterThan(0);
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

  it("冻结后停在冻结那一刻的数，不跟着平滑值走；解冻时先对齐到此刻的值，再接着跟", () => {
    const smooth = motionValue(0.2);
    view = render(<PercentOf value={smooth} />);
    view.rerender(<PercentOf value={smooth} frozen />);
    act(() => smooth.set(0.6));
    expect(text()).toBe("20%");
    view.rerender(<PercentOf value={smooth} />);
    expect(text()).toBe("60%");
    act(() => smooth.set(0.7));
    expect(text()).toBe("70%");
  });
});
