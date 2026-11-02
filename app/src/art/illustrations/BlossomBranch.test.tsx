// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, stubMatchMedia, type MediaQueryStub, type Rendered } from "../../test/dom";
import { BlossomBranch } from "./BlossomBranch";
import { paintBranch, rasterizeBranch } from "./branch-art";
import { stubCanvas, type CanvasStub } from "./test-canvas";

describe("BlossomBranch", () => {
  let view: Rendered | undefined;
  let canvases: CanvasStub;
  let media: MediaQueryStub;

  beforeEach(() => {
    media = stubMatchMedia(false);
    canvases = stubCanvas();
  });

  afterEach(() => {
    view?.unmount();
    view = undefined;
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  function show(width: number, height: number, dpr: number, extra: { mirror?: boolean; dim?: boolean; className?: string } = {}) {
    vi.stubGlobal("devicePixelRatio", dpr);
    view = render(<BlossomBranch width={width} height={height} {...extra} />);
    const frame = view.container.firstElementChild as HTMLElement;
    const canvas = frame.querySelector("canvas");
    if (canvas === null) throw new Error("BlossomBranch 没有渲染 <canvas>");
    return { frame, canvas };
  }

  // 框、缩放比、每格设备像素、格数
  it.each([
    [248, 200, 1, 3, 82, 66],
    [248, 200, 1.25, 4, 77, 62],
    [248, 200, 1.5, 5, 74, 60],
    [248, 200, 2, 6, 82, 66],
    [150, 96, 1.25, 4, 46, 30],
    [272, 200, 1.75, 5, 95, 70],
  ])("%d x %d、缩放比 %d：每格 %d 设备像素，%d x %d 格，位图一比一贴上", (width, height, dpr, cell, cols, rows) => {
    const { frame, canvas } = show(width, height, dpr);

    expect(frame.style.width).toBe(`${width}px`);
    expect(frame.style.height).toBe(`${height}px`);
    expect([canvas.width, canvas.height]).toEqual([cols * cell, rows * cell]);
    expect(Number.parseFloat(canvas.style.width) * dpr).toBeCloseTo(cols * cell, 6);
    expect(Number.parseFloat(canvas.style.height) * dpr).toBeCloseTo(rows * cell, 6);

    expect(canvases.draws).toHaveLength(1);
    const { source, args, canvas: target } = canvases.draws[0] as (typeof canvases.draws)[number] & { source: OffscreenCanvas };
    expect(target).toBe(canvas);
    expect(args).toEqual([0, 0]);
    expect([source.width, source.height]).toEqual([cols * cell, rows * cell]);
    const put = source.getContext("2d")?.putImageData as unknown as { mock: { calls: [ImageData, number, number][] } };
    expect(put.mock.calls).toHaveLength(1);
    const expected = rasterizeBranch(paintBranch(width, height, cell / dpr), cell);
    expect([...put.mock.calls[0][0].data]).toEqual([...expected.data]);
  });

  it("窗口拖到另一块缩放不同的屏幕后按新的格子重画", () => {
    const { canvas } = show(210, 150, 1);
    expect(canvas.width).toBe(70 * 3);

    vi.stubGlobal("devicePixelRatio", 2);
    media.set(true);

    expect(canvas.width).toBe(70 * 6);
    const last = canvases.draws[canvases.draws.length - 1] as { source: OffscreenCanvas };
    expect(last.source.width).toBe(70 * 6);
  });

  it("尺寸不变时重渲染不重新生成位图", () => {
    show(210, 150, 1);
    view?.rerender(<BlossomBranch width={210} height={150} className="另一个" />);
    expect(new Set(canvases.draws.map((draw) => draw.source)).size).toBe(1);
  });

  it("镜像、半透明与类名落在外框上，纯装饰对读屏隐藏", () => {
    const { frame } = show(150, 96, 1, { mirror: true, dim: true, className: "外部类" });
    expect(frame.dataset.mirror).toBe("true");
    expect(frame.dataset.dim).toBe("true");
    expect(frame.classList.contains("外部类")).toBe(true);
    expect(frame.getAttribute("aria-hidden")).toBe("true");

    view?.rerender(<BlossomBranch width={150} height={96} />);
    expect(frame.dataset.mirror).toBeUndefined();
    expect(frame.dataset.dim).toBeUndefined();
  });

  it("尺寸不是正数时抛错", () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.stubGlobal("devicePixelRatio", 1);
    expect(() => render(<BlossomBranch width={0} height={96} />)).toThrow("花枝插画尺寸必须为正：0x96");
  });
});
