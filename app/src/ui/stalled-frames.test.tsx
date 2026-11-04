// @vitest-environment jsdom
// 页面 hidden 时浏览器不跑动画帧。这里让真的 framer-motion 帧循环走一遍「帧停摆、再恢复」：它在模块加载时就取走
// requestAnimationFrame，用例里再 stub 换不到它，所以闸门要赶在所有 import 之前装上。
import { AnimatePresence, MotionConfig, type MotionValue } from "framer-motion";
import { act, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OverlayProvider, OverlayRoot } from "../shell/overlay";
import { render, stubResizeObserver, waitForFrames, type Rendered } from "../test/dom";
import { Modal } from "./Modal";
import { useSmoothProgress } from "./ProgressBar";

const frames = vi.hoisted(() => {
  let stalled = false;
  const held = new Set<FrameRequestCallback>();
  const schedule = (callback: FrameRequestCallback) =>
    setTimeout(() => {
      if (stalled) held.add(callback);
      else callback(performance.now());
    }, 16) as unknown as number;
  globalThis.requestAnimationFrame = (callback) => {
    if (!stalled) return schedule(callback);
    held.add(callback);
    return 0;
  };
  globalThis.cancelAnimationFrame = (handle) => clearTimeout(handle);
  return {
    stall() {
      stalled = true;
    },
    resume() {
      stalled = false;
      for (const callback of held) schedule(callback);
      held.clear();
    },
  };
});

/** 比一轮弹簧起步和几帧更新都长：要是有不该起的动画，这段时间足够它把值带跑。 */
const LONGER_THAN_A_FEW_FRAMES_MS = 200;
const elapse = (ms: number) => act(() => new Promise<void>((resolve) => setTimeout(resolve, ms)));

let view: Rendered | undefined;
beforeEach(() => {
  stubResizeObserver();
});
afterEach(() => {
  frames.resume();
  view?.unmount();
  view = undefined;
});

describe("useSmoothProgress：帧停摆期间", () => {
  let smooth: MotionValue<number> | undefined;
  function Probe({ value, track }: { value: number; track: string }) {
    smooth = useSmoothProgress(value, track).smooth;
    return null;
  }
  const bar = (value: number, track: string) => (
    <MotionConfig reducedMotion="never">
      <Probe value={value} track={track} />
    </MotionConfig>
  );
  const latest = () => {
    if (smooth === undefined) throw new Error("探针未挂载");
    return smooth.get();
  };

  it("进度继续往上报：帧恢复后追上最后的值", async () => {
    view = render(bar(0.2, "a"));
    await elapse(32);
    frames.stall();
    view.rerender(bar(0.4, "a"));
    view.rerender(bar(0.6, "a"));
    await elapse(32);
    expect(latest()).toBe(0.2);

    frames.resume();
    await waitForFrames(() => expect(latest()).toBeCloseTo(0.6, 2));
  });

  it("涨过进度又换了标识：帧恢复后停在新标识的值，不朝旧目标起弹簧", async () => {
    view = render(bar(0.2, "a"));
    await elapse(32);
    frames.stall();
    view.rerender(bar(0.6, "a"));
    view.rerender(bar(0.05, "b"));
    expect(latest()).toBe(0.05);

    frames.resume();
    await elapse(LONGER_THAN_A_FEW_FRAMES_MS);
    expect(latest()).toBe(0.05);
  });
});

describe("Modal：帧停摆期间关闭", () => {
  function mount(ui: ReactNode) {
    view = render(
      <OverlayProvider>
        {ui}
        <OverlayRoot />
      </OverlayProvider>,
    );
    return view;
  }
  const modal = (open: boolean) => (
    <OverlayProvider>
      <Modal open={open} onClose={() => {}} title="重命名" />
      <OverlayRoot />
    </OverlayProvider>
  );
  const layers = () => document.querySelectorAll<HTMLElement>("[data-sk-modal-layer]");

  it("退场停在半路、遮罩还在；帧恢复后走完并摘掉，不留下挡住界面的遮罩", async () => {
    view = render(modal(true));
    view.rerender(modal(true));
    await elapse(LONGER_THAN_A_FEW_FRAMES_MS);
    expect(layers()).toHaveLength(1);

    frames.stall();
    view.rerender(modal(false));
    await elapse(LONGER_THAN_A_FEW_FRAMES_MS);
    expect(layers()).toHaveLength(1);
    expect(layers()[0].hasAttribute("data-exiting")).toBe(true);

    frames.resume();
    await waitForFrames(() => expect(layers()).toHaveLength(0));
  });

  it("随父级 AnimatePresence 卸载时同样等帧恢复，父级的 mode=wait 随后放行下一屏", async () => {
    const screen = (show: boolean) => (
      <AnimatePresence mode="wait" initial={false}>
        {show ? <Modal key="modal" open onClose={() => {}} title="重命名" /> : <p key="next">下一屏</p>}
      </AnimatePresence>
    );
    mount(screen(true));
    const update = (show: boolean) =>
      view?.rerender(
        <OverlayProvider>
          {screen(show)}
          <OverlayRoot />
        </OverlayProvider>,
      );
    update(true);
    await elapse(LONGER_THAN_A_FEW_FRAMES_MS);
    expect(layers()).toHaveLength(1);

    frames.stall();
    update(false);
    await elapse(LONGER_THAN_A_FEW_FRAMES_MS);
    expect(document.body.textContent).not.toContain("下一屏");

    frames.resume();
    await waitForFrames(() => {
      expect(layers()).toHaveLength(0);
      expect(document.body.textContent).toContain("下一屏");
    });
  });
});
