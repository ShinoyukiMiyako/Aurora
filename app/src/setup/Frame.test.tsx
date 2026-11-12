// @vitest-environment jsdom
// 常驻骨架换步时，两页里标着同一块的内容从旧位置滑到新位置。jsdom 没有布局也没有 Web Animations：
// 位置按元素上的 data-top / data-left 给，animate 换成记账的替身，断言交给合成线程的关键帧。

import { MotionGlobalConfig } from "framer-motion";
import type { ReactNode } from "react";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { OverlayProvider, OverlayRoot } from "../shell/overlay";
import { render, stubResizeObserver, type Rendered } from "../test/dom";
import { COPY } from "./copy";
import { FrameChromeProvider, FrameShell, type FrameChrome } from "./Frame";
import type { StepDirection } from "./model";

// 花瓣层要 canvas 和令牌，和这里要验的东西无关
vi.mock("./art", () => ({ BrandMark: () => null, StageArt: () => null }));

interface Played {
  el: HTMLElement;
  frames: Keyframe[];
  options: KeyframeAnimationOptions;
}

let played: Played[] = [];
let view: Rendered | null = null;

const chrome: FrameChrome = { copy: COPY.zh.frame, version: "0.2.0", canClose: true, canOpenLegal: true, reduced: false, onMinimize: vi.fn(), onClose: vi.fn(), onOpenLegal: vi.fn() };

function shell(step: string, direction: StepDirection, page: ReactNode) {
  return (
    <OverlayProvider>
      <FrameChromeProvider value={chrome}>
        <FrameShell step={step} direction={direction}>
          {page}
        </FrameShell>
        <OverlayRoot />
      </FrameChromeProvider>
    </OverlayProvider>
  );
}

const block = (id: string, top: number, left = 0) => <div data-setup-carry="location" data-id={id} data-top={top} data-left={left} />;

const playedOn = (id: string) => played.filter((entry) => entry.el.dataset.id === id);
const translates = (entry: Played) => entry.frames.map((frame) => frame.translate);

beforeAll(() => {
  MotionGlobalConfig.skipAnimations = true;
});

afterAll(() => {
  MotionGlobalConfig.skipAnimations = false;
});

beforeEach(() => {
  stubResizeObserver();
  played = [];
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    const top = Number(this.dataset.top);
    const left = Number(this.dataset.left);
    return { top, left, x: left, y: top, width: 100, height: 40, right: left + 100, bottom: top + 40, toJSON: () => ({}) } as DOMRect;
  });
  Object.defineProperty(HTMLElement.prototype, "animate", {
    configurable: true,
    writable: true,
    value: function (this: HTMLElement, frames: Keyframe[], options: KeyframeAnimationOptions) {
      played.push({ el: this, frames, options });
      return {} as Animation;
    },
  });
});

afterEach(() => {
  view?.unmount();
  view = null;
  Reflect.deleteProperty(HTMLElement.prototype, "animate");
  document.documentElement.removeAttribute("data-sk-reduced");
  vi.unstubAllGlobals();
});

describe("换步时同一块内容跟着走", () => {
  it("新页那块从旧页那块的位置沿弹簧回到自己的位置，旧页那块同时朝新位置走", () => {
    view = render(shell("welcome", 0, block("old", 140)));
    expect(played).toEqual([]);

    view.rerender(shell("location", 0, block("new", 100)));
    const [arrive] = playedOn("new");
    expect(translates(arrive)[0]).toBe("0px 40px");
    expect(translates(arrive).at(-1)).toBe("0px 0px");
    expect(arrive.options.easing).toBe("linear");

    const [leave] = playedOn("old");
    expect(translates(leave)[0]).toBe("0px 0px");
    expect(translates(leave).at(-1)).toBe("0px -40px");
    expect(leave.options.duration).toBe(arrive.options.duration);
  });

  it("横向错开时也一起算", () => {
    view = render(shell("welcome", 0, block("old", 100, 12)));
    view.rerender(shell("location", 0, block("new", 100)));
    expect(translates(playedOn("new")[0])[0]).toBe("12px 0px");
  });

  it("两块本来就对齐时不动", () => {
    view = render(shell("welcome", 0, block("old", 100)));
    view.rerender(shell("location", 0, block("new", 100.4)));
    expect(played).toEqual([]);
  });

  it("旧页没有同一块时不动", () => {
    view = render(shell("installing", 0, <div data-top={0} data-left={0} />));
    view.rerender(shell("location", 0, block("new", 100)));
    expect(played).toEqual([]);
  });

  it("减少动画时不动，直接在新位置", () => {
    document.documentElement.setAttribute("data-sk-reduced", "");
    view = render(shell("welcome", 0, block("old", 140)));
    view.rerender(shell("location", 0, block("new", 100)));
    expect(played).toEqual([]);
  });

  it("同一页里重渲染不算换步", () => {
    view = render(shell("location", 0, block("same", 140)));
    view.rerender(shell("location", 0, block("same", 100)));
    expect(played).toEqual([]);
  });
});

describe("退场中的页", () => {
  it("换步后旧页还在淡出，不可交互也不朗读，新页照常", () => {
    view = render(shell("welcome", 0, <h1>欢迎</h1>));
    view.rerender(shell("location", 1, <h1>选位置</h1>));
    const panes = [...document.querySelectorAll<HTMLElement>("[data-step-pane]")];
    expect(panes.map((pane) => [pane.textContent, pane.hasAttribute("inert"), pane.getAttribute("aria-hidden")])).toEqual([
      ["欢迎", true, "true"],
      ["选位置", false, null],
    ]);
  });
});
