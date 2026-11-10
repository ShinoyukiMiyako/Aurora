// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { MotionConfig, MotionGlobalConfig } from "framer-motion";
import { act } from "react";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { NO_ART, setArtStatus } from "../../mc/art";
import { clearArtCache } from "../../mc/useArt";
import { render, setRect, stubMatchMedia, stubResizeObserver, waitForFrames, type ResizeObserverStub, type Rendered } from "../../test/dom";
import { stubCanvas, type CanvasStub } from "../illustrations/test-canvas";
import { FOCUS_X, FOCUS_Y, PanoramaBackdrop } from "./PanoramaBackdrop";

// jsdom 环境里的 URL 是 jsdom 自己的实现，node:fs 不认，按文件路径读
const CSS = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "PanoramaBackdrop.module.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

function ruleOf(selector: string): string {
  const rule = new RegExp(`(?:^|\\n)${selector.replace(".", "\\.")} \\{([^}]*)\\}`).exec(CSS);
  if (rule === null) throw new Error(`没有 ${selector} 规则`);
  return rule[1];
}

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

/**
 * first 第一次变成完全不透明的那一帧，second 的不透明度。framer 在同一帧里写完所有元素的样式之后，
 * 才轮到 MutationObserver 的回调，所以读到的是同一帧的值。
 */
async function opacityWhenOpaque(first: HTMLElement, second: HTMLElement): Promise<number> {
  const seen: { opacity: number | null } = { opacity: null };
  const observer = new MutationObserver(() => {
    if (seen.opacity === null && first.style.opacity === "1") seen.opacity = Number(second.style.opacity);
  });
  observer.observe(first, { attributes: true, attributeFilter: ["style"] });
  await waitForFrames(() => expect(seen.opacity).not.toBeNull());
  observer.disconnect();
  if (seen.opacity === null) throw new Error("先到的那层一直没有变成不透明");
  return seen.opacity;
}

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
    expect(fetchMock).toHaveBeenCalledWith("http://petalfall-tex.localhost/panorama/0.png", { mode: "cors" });
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

  it("节流间隙里旧尺寸的画布按 cover 等比铺满，焦点与重绘相同，不被非等比拉伸", () => {
    const image = ruleOf(".image");
    expect(image).toMatch(/(?:^|\s)object-fit: cover;/);
    const position = /(?:^|\s)object-position: ([\d.]+)% ([\d.]+)%;/.exec(image);
    if (position === null) throw new Error(".image 没有按百分比写的 object-position");
    expect(Number(position[1]) / 100).toBeCloseTo(FOCUS_X, 10);
    expect(Number(position[2]) / 100).toBeCloseTo(FOCUS_Y, 10);
  });

  it("开着时全景变得不可用：背景淡出后回到无图，记一条 warn", async () => {
    setArtStatus({ source: null, panorama: true });
    view = render(<PanoramaBackdrop enabled />);
    await settle();
    expect(backdrop()).not.toBeNull();
    act(() => setArtStatus({ source: null, panorama: false }));
    await waitForFrames(() => expect(backdrop()).toBeNull());
    expect(warn.mock.calls.some((c) => String(c[0]).includes("樱花林全景已不可用"))).toBe(true);
  });

  it("减少动画时入场收回 fade.in：比照常的那层先到不透明，不播 480 ms 的整窗淡入", async () => {
    setArtStatus({ source: null, panorama: true });
    // 先把图取好：之后两层在同一次提交里就拿到位图，同一帧起播，每一帧拿同一个时间戳算各自的不透明度
    view = render(<PanoramaBackdrop enabled />);
    await settle();
    view.unmount();
    view = render(
      <>
        <div data-lane="normal">
          <PanoramaBackdrop enabled />
        </div>
        <MotionConfig reducedMotion="always">
          <div data-lane="reduced">
            <PanoramaBackdrop enabled />
          </div>
        </MotionConfig>
      </>,
    );
    const lane = (name: string) => {
      const el = view?.container.querySelector<HTMLElement>(`[data-lane='${name}'] > [data-sk-art='panorama']`);
      if (el === null || el === undefined) throw new Error(`${name} 那层全景没有渲染`);
      return el;
    };
    const other = await opacityWhenOpaque(lane("reduced"), lane("normal"));
    // 200 ms 的淡入落到 1 的那一帧，480 ms 的环境层淡入还没走完
    expect(other).toBeGreaterThan(0);
    expect(other).toBeLessThan(1);
  });

  it("关掉开关：整层先淡出再卸载，不是一帧硬切", async () => {
    setArtStatus({ source: null, panorama: true });
    view = render(<PanoramaBackdrop enabled />);
    await settle();
    const shown = backdrop();
    if (!shown) throw new Error("全景背景没有渲染");
    view.rerender(<PanoramaBackdrop enabled={false} />);
    // 退场按真实时间播 200 ms：刚关掉时还在原处，正往透明淡
    expect(backdrop()).toBe(shown);
    await waitForFrames(() => expect(backdrop()).toBeNull());
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  describe("材质源变化后重新取图", () => {
    beforeAll(() => {
      // 退场一帧就播完：要是旧图被放下，几帧之内节点就没了
      MotionGlobalConfig.skipAnimations = true;
    });

    afterAll(() => {
      MotionGlobalConfig.skipAnimations = false;
    });

    /** 让下一次取图挂起，返回放行函数。 */
    function holdNextFetch(response: { ok: boolean; status: number }): () => Promise<void> {
      let release: (() => void) | undefined;
      fetchMock.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            release = () => resolve({ ...response, blob: async () => new Blob(["y"]) });
          }),
      );
      return async () => {
        if (release === undefined) throw new Error("取图还没有发出");
        release();
        await settle();
      };
    }

    /** 等若干帧，确认节点一直在、没被换掉。 */
    async function staysFor(frames: number, el: HTMLElement): Promise<void> {
      for (let i = 0; i < frames; i++) {
        await act(() => new Promise<void>((resolve) => setTimeout(resolve, 16)));
        expect(backdrop()).toBe(el);
      }
    }

    it("取图期间留着上一张，新图到了在同一块画布上换上，不卸载重来", async () => {
      const bitmaps: { width: number; height: number }[] = [];
      vi.stubGlobal(
        "createImageBitmap",
        vi.fn(async () => {
          const bitmap = { width: 1024, height: 1024 };
          bitmaps.push(bitmap);
          return bitmap;
        }),
      );
      setArtStatus({ source: null, panorama: true });
      view = render(<PanoramaBackdrop enabled />);
      await settle();
      const shown = backdrop();
      if (!shown) throw new Error("全景背景没有渲染");
      setRect(shown, { left: 0, top: 0, width: 1120, height: 720 });
      resize.resize(shown, 1120);
      expect(canvas.draws.at(-1)?.source).toBe(bitmaps[0]);

      const release = holdNextFetch({ ok: true, status: 200 });
      act(() => setArtStatus({ source: { versionId: "1.21.4" }, panorama: true }));
      await settle();
      expect(fetchMock).toHaveBeenCalledTimes(2);
      await staysFor(6, shown);

      await release();
      expect(bitmaps).toHaveLength(2);
      expect(backdrop()).toBe(shown);
      resize.resize(shown, 1120);
      expect(canvas.draws.at(-1)?.source).toBe(bitmaps[1]);
    });

    it("重新取图失败：放下旧图，淡出回到无图", async () => {
      setArtStatus({ source: null, panorama: true });
      view = render(<PanoramaBackdrop enabled />);
      await settle();
      const shown = backdrop();
      if (!shown) throw new Error("全景背景没有渲染");

      const release = holdNextFetch({ ok: false, status: 404 });
      act(() => setArtStatus({ source: { versionId: "1.21.4" }, panorama: true }));
      await settle();
      await staysFor(3, shown);
      await release();
      await waitForFrames(() => expect(backdrop()).toBeNull());
      expect(warn.mock.calls.some((c) => String(c[0]).includes("/panorama/0.png"))).toBe(true);
    });
  });
});
