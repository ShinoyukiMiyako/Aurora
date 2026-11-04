// @vitest-environment jsdom
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { APP_NAME_EN } from "../lib/app-info";
import { render, stubMatchMedia, type MediaQueryStub, type Rendered } from "../test/dom";
import type { Pixels } from "./illustrations/canvas";
import { stubCanvas, type CanvasStub } from "./illustrations/test-canvas";
import { Logo } from "./Logo";
import master from "./petal-mark.json";
import { PetalMark, petalRendition, rasterizePetalMark, type PetalRendition } from "./PetalMark";

/** 调色板写成十进制字面值：换算写错时，从同一份十六进制推出的期望值发现不了。 */
const RGBA: Record<string, readonly number[]> = {
  ".": [0, 0, 0, 0],
  O: [169, 87, 138, 255],
  S: [224, 141, 184, 255],
  M: [242, 175, 208, 255],
  L: [249, 204, 226, 255],
  H: [255, 234, 244, 255],
};

function rgbaAt(pixels: Pixels, x: number, y: number): number[] {
  const at = (y * pixels.width + x) * 4;
  return [...pixels.data.slice(at, at + 4)];
}

/** 按母版格子独立推算整张位图：每个设备像素都属于某一格，出界即透明。 */
function expectedPixels(side: number, { grid, scale }: PetalRendition, inset: number): number[] {
  const rows = master[grid];
  const out: number[] = [];
  for (let y = 0; y < side; y++) {
    for (let x = 0; x < side; x++) {
      const gridX = Math.floor((x - inset) / scale);
      const gridY = Math.floor((y - inset) / scale);
      const inside = gridX >= 0 && gridY >= 0 && gridX < rows.length && gridY < rows.length;
      out.push(...RGBA[inside ? rows[gridY][gridX] : "."]);
    }
  }
  return out;
}

describe("petal-mark.json", () => {
  it.each([
    ["grid16", 16],
    ["grid12", 12],
  ] as const)("%s 是 %d 见方，只用调色板里的颜色", (grid, side) => {
    const rows = master[grid];
    expect(rows).toHaveLength(side);
    for (const row of rows) expect(row).toMatch(new RegExp(`^[.OSMLH]{${side}}$`));
  });

  // 下面的位图期望从这份 JSON 现算，只抽查了十来个像素，改了形状照样通过，只有摘要守得住。按解析后的对象算，
  // 不受换行符与缩进影响；摘要不是素材本身，钉在代码里不会把素材数据带回来
  it("内容摘要钉死：改动素材即有意重绘，须同时更新摘要，新素材按素材许可另行发布", () => {
    expect(createHash("sha256").update(JSON.stringify(master)).digest("hex")).toBe("fe2008dddc9cbe783c49b497ca0f0b05b30f34bc65cd4c30c1eed10b50a9122a");
  });
});

describe("petalRendition", () => {
  it.each<[number, PetalRendition]>([
    [16, { grid: "grid16", scale: 1 }],
    [20, { grid: "grid16", scale: 1 }],
    [23, { grid: "grid16", scale: 1 }],
    [24, { grid: "grid12", scale: 2 }],
    [31, { grid: "grid12", scale: 2 }],
    [32, { grid: "grid16", scale: 2 }],
    [47, { grid: "grid16", scale: 2 }],
    [48, { grid: "grid16", scale: 3 }],
    [63, { grid: "grid16", scale: 3 }],
    [64, { grid: "grid16", scale: 4 }],
    [96, { grid: "grid16", scale: 6 }],
  ])("%d 设备像素的版本", (side, rendition) => {
    expect(petalRendition(side)).toEqual(rendition);
  });

  it("放不下主母版 1 倍时抛错，不把图裁掉", () => {
    expect(() => petalRendition(15)).toThrow("花瓣徽记没有 15 设备像素的版本");
    expect(() => petalRendition(0)).toThrow("花瓣徽记没有 0 设备像素的版本");
  });

  it("任何边长都取放得下的最大版本", () => {
    const sides = [24];
    for (let multiple = 1; multiple * 16 <= 1024; multiple++) sides.push(multiple * 16);
    for (let side = 16; side <= 1024; side++) {
      const { grid, scale } = petalRendition(side);
      const art = master[grid].length * scale;
      const closest = Math.max(...sides.filter((candidate) => candidate <= side));
      expect(art, `边长 ${side}`).toBe(closest);
      expect(Number.isInteger(scale), `边长 ${side}`).toBe(true);
    }
  });
});

describe("rasterizePetalMark", () => {
  it("16 × 1 倍：格子原样落到设备像素上", () => {
    const pixels = rasterizePetalMark(16);
    expect(rgbaAt(pixels, 0, 0)).toEqual(RGBA["."]);
    expect(rgbaAt(pixels, 9, 2)).toEqual(RGBA.O);
    expect(rgbaAt(pixels, 11, 2)).toEqual(RGBA["."]);
    expect(rgbaAt(pixels, 8, 4)).toEqual(RGBA.H);
    expect(rgbaAt(pixels, 13, 4)).toEqual(RGBA.S);
    expect(rgbaAt(pixels, 9, 3)).toEqual(RGBA.L);
    expect(rgbaAt(pixels, 10, 3)).toEqual(RGBA.M);
  });

  it("24 用 12 格母版：每格 2 × 2，不是主母版缩放出来的", () => {
    const pixels = rasterizePetalMark(24);
    // grid12 第 1 行第 7 格是描边，四个设备像素同色；紧邻的左侧格透明
    for (const [x, y] of [
      [14, 2],
      [15, 2],
      [14, 3],
      [15, 3],
    ]) {
      expect(rgbaAt(pixels, x, y)).toEqual(RGBA.O);
    }
    expect(rgbaAt(pixels, 13, 2)).toEqual(RGBA["."]);
  });

  it("余量均分到四周，奇数余量的多余一行落在下方与右方", () => {
    const pixels = rasterizePetalMark(25);
    expect(rgbaAt(pixels, 14, 2)).toEqual(RGBA.O);
    for (let i = 0; i < 25; i++) {
      expect(rgbaAt(pixels, i, 24)).toEqual(RGBA["."]);
      expect(rgbaAt(pixels, 24, i)).toEqual(RGBA["."]);
    }
  });

  it("随机边长下只有调色板颜色，不产生插值色", () => {
    const palette = new Set(Object.values(RGBA).map((rgba) => rgba.join()));
    for (let round = 0; round < 8; round++) {
      const side = 16 + Math.floor(Math.random() * 180);
      const pixels = rasterizePetalMark(side);
      const seen = new Set<string>();
      for (let at = 0; at < pixels.data.length; at += 4) seen.add(pixels.data.slice(at, at + 4).join());
      expect([...seen].filter((color) => !palette.has(color)), `边长 ${side}`).toEqual([]);
    }
  });
});

describe("PetalMark", () => {
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
  });

  function show(size: number, dpr: number, className?: string): HTMLCanvasElement {
    vi.stubGlobal("devicePixelRatio", dpr);
    view = render(<PetalMark size={size} className={className} />);
    const canvas = view.container.querySelector("canvas");
    if (canvas === null) throw new Error("PetalMark 没有渲染 <canvas>");
    return canvas;
  }

  // 行为：size、dpr、设备像素边长、版本、四周留白
  it.each<[number, number, number, PetalRendition, number]>([
    [20, 1, 20, { grid: "grid16", scale: 1 }, 2],
    [20, 1.25, 25, { grid: "grid12", scale: 2 }, 0],
    [20, 1.5, 30, { grid: "grid12", scale: 2 }, 3],
    [20, 2, 40, { grid: "grid16", scale: 2 }, 4],
    [28, 1, 28, { grid: "grid12", scale: 2 }, 2],
    [28, 1.25, 35, { grid: "grid16", scale: 2 }, 1],
    [28, 1.5, 42, { grid: "grid16", scale: 2 }, 5],
    [28, 2, 56, { grid: "grid16", scale: 3 }, 4],
    [32, 1, 32, { grid: "grid16", scale: 2 }, 0],
    [32, 1.25, 40, { grid: "grid16", scale: 2 }, 4],
    [32, 1.5, 48, { grid: "grid16", scale: 3 }, 0],
    [32, 2, 64, { grid: "grid16", scale: 4 }, 0],
    [48, 1, 48, { grid: "grid16", scale: 3 }, 0],
    [48, 1.25, 60, { grid: "grid16", scale: 3 }, 6],
    [48, 1.5, 72, { grid: "grid16", scale: 4 }, 4],
    [48, 2, 96, { grid: "grid16", scale: 6 }, 0],
  ])("size %d、缩放比 %d：位图 %d 设备像素一比一贴上", (size, dpr, side, rendition, inset) => {
    const canvas = show(size, dpr);

    expect(canvas.width).toBe(side);
    expect(canvas.height).toBe(side);
    expect(canvas.style.width).toBe(`${size}px`);
    expect(canvas.style.height).toBe(`${size}px`);

    expect(canvases.draws).toHaveLength(1);
    const { source, args, canvas: target } = canvases.draws[0] as (typeof canvases.draws)[number] & { source: OffscreenCanvas };
    expect(target).toBe(canvas);
    expect(args).toEqual([0, 0]);
    expect([source.width, source.height]).toEqual([side, side]);

    expect(petalRendition(side)).toEqual(rendition);
    const put = source.getContext("2d")?.putImageData as unknown as { mock: { calls: [ImageData, number, number][] } };
    expect(put.mock.calls).toHaveLength(1);
    const [image, x, y] = put.mock.calls[0];
    expect([x, y]).toEqual([0, 0]);
    expect([...image.data]).toEqual(expectedPixels(side, rendition, inset));
  });

  it("随机尺寸与常见缩放比：画布始终等于取整后的设备像素", () => {
    const scales = [1, 1.25, 1.5, 1.75, 2, 2.25, 2.5, 3];
    const size = 16 + 4 * Math.floor(Math.random() * 28);
    const dpr = scales[Math.floor(Math.random() * scales.length)];
    const canvas = show(size, dpr);
    const context = `size=${size} dpr=${dpr}`;
    expect(canvas.width, context).toBe(size * dpr);
    expect(canvas.style.width, context).toBe(`${size}px`);
  });

  it("乘不出整数时 CSS 边长跟着位图取整，保证贴到设备像素网格上是一比一", () => {
    const canvas = show(28, 1.1);
    expect(canvas.width).toBe(31);
    expect(Number.parseFloat(canvas.style.width) * 1.1).toBeCloseTo(31, 6);
  });

  it("窗口拖到另一块缩放不同的屏幕后按新缩放比重画", () => {
    const canvas = show(20, 1);
    expect(canvas.width).toBe(20);

    vi.stubGlobal("devicePixelRatio", 2);
    media.set(true);

    expect(canvas.width).toBe(40);
    expect(canvas.style.width).toBe("20px");
    const last = canvases.draws[canvases.draws.length - 1] as { source: OffscreenCanvas };
    expect(last.source.width).toBe(40);
  });

  it("同一设备像素边长不重新生成位图", () => {
    show(20, 1);
    view?.rerender(<PetalMark size={20} className="另一个" />);
    const sources = new Set(canvases.draws.map((draw) => draw.source));
    expect(sources.size).toBe(1);
  });

  it("类名透传，纯装饰对读屏隐藏", () => {
    const canvas = show(20, 1, "外部类");
    expect(canvas.classList.contains("外部类")).toBe(true);
    expect(canvas.getAttribute("aria-hidden")).toBe("true");
  });

  it.each([
    [20, "6px", "14px"],
    [28, "8px", "19px"],
  ] as const)("Logo size %d：徽记换成花瓣，字标算法不变", (size, gap, fontSize) => {
    vi.stubGlobal("devicePixelRatio", 1);
    view = render(<Logo size={size} className="外部类" />);
    const logo = view.container.firstElementChild as HTMLElement;
    const [mark, wordmark] = logo.children as unknown as [HTMLCanvasElement, HTMLElement];

    expect(logo.classList.contains("外部类")).toBe(true);
    expect(logo.style.gap).toBe(gap);
    expect(mark.tagName).toBe("CANVAS");
    expect(mark.style.width).toBe(`${size}px`);
    expect(wordmark.style.fontSize).toBe(fontSize);
    expect(wordmark.textContent).toBe(APP_NAME_EN);
    expect(logo.querySelector("svg")).toBeNull();
  });
});
