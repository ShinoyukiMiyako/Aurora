// @vitest-environment jsdom
// 换步时旧页怎么退场。要等 framer-motion 的帧循环把退场播完，整个文件走真实时间、不开 skipAnimations；
// 帧循环一旦在假定时器下停住，同一文件后面的用例就推不动它，所以不和 Frame.test 里只看挂载时刻的用例放在一起。

import { MotionConfig } from "framer-motion";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OverlayProvider, OverlayRoot } from "../shell/overlay";
import { render, stubResizeObserver, waitForFrames, type Rendered } from "../test/dom";
import { COPY } from "./copy";
import { FrameChromeProvider, FrameShell, type FrameChrome } from "./Frame";
import type { StepDirection } from "./model";

// 花瓣层要 canvas 和令牌，和这里要验的东西无关
vi.mock("./art", () => ({ BrandMark: () => null, StageArt: () => null }));

type Reduced = "always" | "never";

const chrome: FrameChrome = { copy: COPY.zh.frame, version: "0.2.0", canClose: true, canOpenLegal: true, reduced: false, onMinimize: vi.fn(), onClose: vi.fn(), onOpenLegal: vi.fn() };

let view: Rendered | null = null;

function shell(reduced: Reduced, step: string, direction: StepDirection) {
  return (
    <MotionConfig reducedMotion={reduced}>
      <OverlayProvider>
        <FrameChromeProvider value={chrome}>
          <FrameShell step={step} direction={direction}>
            <h1>{step}</h1>
          </FrameShell>
          <OverlayRoot />
        </FrameChromeProvider>
      </OverlayProvider>
    </MotionConfig>
  );
}

interface Stepped {
  /** 新页挂上那一刻的 transform。 */
  arriving: string;
  /** 旧页从开始退场到移出 DOM 之间写过的每一个 transform。 */
  leaving: string[];
}

/** 从欢迎页往前换到安装中（方向 1），等旧页退场播完。 */
async function stepForward(reduced: Reduced): Promise<Stepped> {
  view = render(shell(reduced, "welcome", 0));
  const old = document.querySelector<HTMLElement>("[data-step-pane]");
  if (old === null) throw new Error("骨架里没有页");
  const leaving: string[] = [];
  const watcher = new MutationObserver(() => leaving.push(old.style.transform));
  watcher.observe(old, { attributes: true, attributeFilter: ["style"] });
  try {
    view.rerender(shell(reduced, "installing", 1));
    const arriving = document.querySelector<HTMLElement>("[data-step-pane]:not([inert])");
    if (arriving === null) throw new Error("换步后没有新页");
    const arrivingTransform = arriving.style.transform;
    await waitForFrames(() => expect(old.isConnected).toBe(false));
    return { arriving: arrivingTransform, leaving };
  } finally {
    watcher.disconnect();
  }
}

const shifted = (transforms: string[]) => transforms.filter((transform) => transform.includes("translate"));

beforeEach(() => {
  stubResizeObserver();
});

afterEach(() => {
  view?.unmount();
  view = null;
  vi.unstubAllGlobals();
});

describe("换步的退场", () => {
  it("平时旧页朝反方向横移着淡出，新页从前进一侧进来", async () => {
    const { arriving, leaving } = await stepForward("never");
    expect(arriving).toBe("translateX(16px)");
    expect(shifted(leaving).some((transform) => transform.startsWith("translateX(-"))).toBe(true);
  });

  it("减少动画时只淡入淡出：旧页不先横跳一下再淡，新页也不从侧边进来", async () => {
    const { arriving, leaving } = await stepForward("always");
    expect(arriving).not.toContain("translate");
    // 退场确实播了（样式被写过），只是没有一次带位移
    expect(leaving.length).toBeGreaterThan(0);
    expect(shifted(leaving)).toEqual([]);
  });
});
