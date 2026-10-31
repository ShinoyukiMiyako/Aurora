// @vitest-environment jsdom
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { NO_ART, setArtStatus } from "../../mc/art";
import { clearArtCache } from "../../mc/useArt";
import { render, setRect, stubMatchMedia, stubResizeObserver, type ResizeObserverStub, type Rendered } from "../../test/dom";
import { stubCanvas, type CanvasStub } from "../illustrations/test-canvas";
import { PanoramaBackdrop } from "./PanoramaBackdrop";

let view: Rendered | undefined;
let canvas: CanvasStub;
let resize: ResizeObserverStub;
let fetchMock: ReturnType<typeof vi.fn>;
let warn: MockInstance<typeof console.warn>;

beforeEach(() => {
  stubMatchMedia(false);
  canvas = stubCanvas();
  resize = stubResizeObserver();
  vi.stubGlobal("navigator", { userAgent: "Windows" });
  fetchMock = vi.fn(async () => ({ ok: true, status: 200, blob: async () => new Blob(["x"]) }));
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("createImageBitmap", vi.fn(async () => ({ width: 1024, height: 1024 })));
  warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

afterEach(() => {
  view?.unmount();
  view = undefined;
  setArtStatus(NO_ART);
  clearArtCache();
  vi.unstubAllGlobals();
});

const settle = () => act(() => new Promise<void>((resolve) => setTimeout(resolve, 0)));
const backdrop = () => view?.container.querySelector<HTMLElement>("[data-sk-art='panorama']") ?? null;

describe("PanoramaBackdrop", () => {
  it("开关关闭时什么都不画、不取图", async () => {
    setArtStatus({ source: null, panorama: true });
    view = render(<PanoramaBackdrop enabled={false} />);
    await settle();
    expect(backdrop()).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("开关打开但本机没有全景：背景无图，不取图", async () => {
    view = render(<PanoramaBackdrop enabled />);
    await settle();
    expect(backdrop()).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("可用时取正面一张，按窗口尺寸 × dpr 等比铺满、焦点落在 46% 高度", async () => {
    setArtStatus({ source: null, panorama: true });
    view = render(<PanoramaBackdrop enabled />);
    await settle();
    expect(fetchMock).toHaveBeenCalledWith("http://aurora-tex.localhost/panorama/0.png", { mode: "cors" });
    const el = backdrop();
    if (!el) throw new Error("全景背景没有渲染");
    expect(el.getAttribute("aria-hidden")).toBe("true");
    setRect(el, { left: 0, top: 0, width: 1120, height: 720 });
    resize.resize(el, 1120);
    const draw = canvas.draws.at(-1);
    // 1024 × 1024 铺满 1120 × 720：横向放大 1.09375，纵向裁去 365.7 中的 46%
    expect(draw?.canvas).toMatchObject({ width: 1120, height: 720 });
    expect(draw?.args[0]).toBe(0);
    expect(draw?.args[1]).toBeCloseTo((1024 - 720 / 1.09375) * 0.46, 6);
    expect(draw?.args.slice(2)).toEqual([1024, 720 / 1.09375, 0, 0, 1120, 720]);
  });

  it("窗口尺寸变化在 300 ms 内只重绘首尾两次", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    setArtStatus({ source: null, panorama: true });
    view = render(<PanoramaBackdrop enabled />);
    await act(async () => {
      await vi.runAllTimersAsync();
    });
    const el = backdrop();
    if (!el) throw new Error("全景背景没有渲染");
    setRect(el, { left: 0, top: 0, width: 1000, height: 700 });
    const before = canvas.draws.length;
    resize.resize(el, 1000);
    resize.resize(el, 1010);
    resize.resize(el, 1020);
    expect(canvas.draws.length - before).toBe(1);
    act(() => {
      vi.advanceTimersByTime(300);
    });
    expect(canvas.draws.length - before).toBe(2);
    vi.useRealTimers();
  });

  it("开着时全景变得不可用：背景回到无图，记一条 warn", async () => {
    setArtStatus({ source: null, panorama: true });
    view = render(<PanoramaBackdrop enabled />);
    await settle();
    expect(backdrop()).not.toBeNull();
    act(() => setArtStatus({ source: null, panorama: false }));
    await settle();
    expect(backdrop()).toBeNull();
    expect(warn.mock.calls.some((c) => String(c[0]).includes("樱花林全景已不可用"))).toBe(true);
  });
});
