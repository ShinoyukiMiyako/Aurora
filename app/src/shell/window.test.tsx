// @vitest-environment jsdom
import { StrictMode, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, type Rendered } from "../test/dom";
import { RevealWindow, useRevealWindow, WindowPortProvider, type WindowPort } from "./window";

let view: Rendered | undefined;
let frames: Map<number, FrameRequestCallback>;
let nextFrame: number;

/** 手动推进的动画帧：测试决定哪一帧在什么时候触发。 */
function flushFrames() {
  const pending = [...frames.values()];
  frames.clear();
  for (const callback of pending) callback(0);
}

beforeEach(() => {
  frames = new Map();
  nextFrame = 1;
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    const id = nextFrame++;
    frames.set(id, callback);
    return id;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => {
    frames.delete(id);
  });
});

afterEach(() => {
  view?.unmount();
  view = undefined;
  vi.unstubAllGlobals();
});

function fakePort(): WindowPort & { show: ReturnType<typeof vi.fn> } {
  const noop = async () => {};
  return {
    native: true,
    show: vi.fn(async () => {}),
    minimize: noop,
    unminimize: noop,
    toggleMaximize: noop,
    close: noop,
    destroy: noop,
    isMaximized: async () => false,
    isMinimized: async () => false,
    isFocused: async () => true,
    requestAttention: noop,
    onResized: async () => () => {},
    onFocusChanged: async () => () => {},
    onCloseRequested: async () => () => {},
  };
}

function Reveal({ ready }: { ready: boolean }) {
  useRevealWindow(ready);
  return null;
}

function mount(port: WindowPort, ui: ReactNode, strict: boolean) {
  const tree = <WindowPortProvider port={port}>{ui}</WindowPortProvider>;
  view = render(strict ? <StrictMode>{tree}</StrictMode> : tree);
}

describe("useRevealWindow", () => {
  it("开发构建的 StrictMode 先装、拆、再装一次布局 effect：仍在下一帧显示窗口，且只显示一次", () => {
    const port = fakePort();
    mount(port, <RevealWindow>{null}</RevealWindow>, true);
    expect(port.show).not.toHaveBeenCalled();
    flushFrames();
    expect(port.show).toHaveBeenCalledTimes(1);
    flushFrames();
    expect(port.show).toHaveBeenCalledTimes(1);
  });

  it("ready 为假时不显示；第一次变真后的下一帧显示，之后再变化不重复显示", () => {
    const port = fakePort();
    mount(port, <Reveal ready={false} />, false);
    flushFrames();
    expect(port.show).not.toHaveBeenCalled();
    view?.rerender(
      <WindowPortProvider port={port}>
        <Reveal ready />
      </WindowPortProvider>,
    );
    expect(port.show).not.toHaveBeenCalled();
    flushFrames();
    expect(port.show).toHaveBeenCalledTimes(1);
    view?.rerender(
      <WindowPortProvider port={port}>
        <Reveal ready={false} />
      </WindowPortProvider>,
    );
    view?.rerender(
      <WindowPortProvider port={port}>
        <Reveal ready />
      </WindowPortProvider>,
    );
    flushFrames();
    expect(port.show).toHaveBeenCalledTimes(1);
  });

  it("那一帧到来前就卸载：不显示（窗口交给后端兜底）", () => {
    const port = fakePort();
    mount(port, <Reveal ready />, false);
    view?.unmount();
    view = undefined;
    flushFrames();
    expect(port.show).not.toHaveBeenCalled();
  });
});
