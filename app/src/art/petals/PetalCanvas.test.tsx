// @vitest-environment jsdom
import { MotionGlobalConfig } from "framer-motion";
import { act } from "react";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { render, stubMatchMedia, stubResizeObserver, type MediaQueryStub, type ResizeObserverStub } from "../../test/dom";
import { currentPetalStats } from "./engine";
import { PetalCanvas, type PetalCanvasProps } from "./PetalCanvas";
import { manualFrames, stubCanvas, stubPetalTokens, type ManualFrames } from "./test-canvas";

const BASE: Omit<PetalCanvasProps, "onDowngrade"> = { show: true, paused: false, reduced: false, tier: "compact", mode: "day", accent: "sakura", seed: 20231 };

let frames: ManualFrames;
let resize: ResizeObserverStub;
let media: MediaQueryStub;
let rect = { left: 0, top: 0, width: 800, height: 600 };

beforeAll(() => {
  // 淡入淡出只改透明度；测试里让 framer-motion 直接跳到终值，退场在下一帧完成
  MotionGlobalConfig.skipAnimations = true;
});

afterAll(() => {
  MotionGlobalConfig.skipAnimations = false;
});

beforeEach(() => {
  stubCanvas();
  stubPetalTokens();
  frames = manualFrames();
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => frames.request(cb));
  vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.cancel(id));
  vi.stubGlobal("devicePixelRatio", 1);
  resize = stubResizeObserver();
  media = stubMatchMedia(false);
  rect = { left: 0, top: 0, width: 800, height: 600 };
  vi.spyOn(HTMLCanvasElement.prototype, "getBoundingClientRect").mockImplementation(
    () => ({ ...rect, x: rect.left, y: rect.top, right: rect.left + rect.width, bottom: rect.top + rect.height, toJSON: () => rect }) as DOMRect,
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

function ui(props: Partial<PetalCanvasProps> = {}, onDowngrade = vi.fn()) {
  return (
    <div data-testid="content">
      <PetalCanvas {...BASE} onDowngrade={onDowngrade} {...props} />
    </div>
  );
}

const canvasIn = (container: HTMLElement) => container.querySelector("canvas[data-sk-petals]");

/** 等 framer-motion 跑完退场（它用自己在导入时取到的 rAF，不经过本测试替换的那个）。 */
async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 80));
  });
}

describe("PetalCanvas", () => {
  it("挂在内容区里、对读屏隐藏，挂载即按画布尺寸开始播放", () => {
    const view = render(ui());
    const canvas = canvasIn(view.container);
    expect(canvas).not.toBeNull();
    expect(canvas?.getAttribute("aria-hidden")).toBe("true");
    expect(canvas?.parentElement?.getAttribute("data-testid")).toBe("content");
    expect([(canvas as HTMLCanvasElement).width, (canvas as HTMLCanvasElement).height]).toEqual([800, 600]);
    expect(resize.observed()).toEqual([canvas]);
    expect(frames.pending()).toBe(1);
    expect(currentPetalStats()).toMatchObject({ running: true, count: 16, level: 0 });
    view.unmount();
  });

  it("paused 取消 rAF，恢复后重新请求；减少动画时不跑 rAF", () => {
    const view = render(ui());
    frames.run(1000);
    view.rerender(ui({ paused: true }));
    expect(frames.pending()).toBe(0);
    expect(frames.cancelled()).toHaveLength(1);
    view.rerender(ui({ paused: false }));
    expect(frames.pending()).toBe(1);
    view.rerender(ui({ reduced: true }));
    expect(frames.pending()).toBe(0);
    expect(currentPetalStats()).toMatchObject({ running: false, count: 16 });
    view.rerender(ui({ reduced: true, tier: "wide" }));
    expect(currentPetalStats()?.count).toBe(26);
    view.unmount();
  });

  it("尺寸观察与设备像素比变化都会重建后备缓冲", () => {
    const view = render(ui());
    const canvas = canvasIn(view.container) as HTMLCanvasElement;
    rect = { ...rect, width: 1000 };
    resize.resize(canvas, 1000);
    expect(canvas.width).toBe(1000);
    vi.stubGlobal("devicePixelRatio", 1.5);
    media.set(true);
    expect([canvas.width, canvas.height]).toEqual([1500, 900]);
    // 按新像素比重新订阅，旧订阅已移除
    expect(media.listenerCount()).toBe(1);
    view.unmount();
    expect(media.listenerCount()).toBe(0);
    expect(resize.disconnects()).toBe(1);
  });

  it("show 变为 false 后淡出并卸载画布节点、停掉引擎", async () => {
    const view = render(ui());
    expect(canvasIn(view.container)).not.toBeNull();
    view.rerender(ui({ show: false }));
    await settle();
    expect(canvasIn(view.container)).toBeNull();
    expect(frames.pending()).toBe(0);
    expect(currentPetalStats()).toBeNull();
    view.rerender(ui({ show: true }));
    expect(canvasIn(view.container)).not.toBeNull();
    expect(frames.pending()).toBe(1);
    view.unmount();
    expect(currentPetalStats()).toBeNull();
  });
});
