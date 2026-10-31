// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseComputedColor, sameColor, type Rgba } from "./color";
import { GLYPHS, TONES } from "./glyphs";
import { buildSprites, cellSize, rasterizeGlyph, readPetalPalette, toneColors, type PetalPalette } from "./sprites";

const rgba = (r: number, g: number, b: number, a = 255): Rgba => ({ r, g, b, a });

/** 日樱 · 樱粉下的花瓣五阶色。 */
const PALETTE: PetalPalette = [rgba(243, 205, 225), rgba(235, 168, 202), rgba(225, 127, 176), rgba(216, 85, 151), rgba(207, 48, 128)];

function pixel(data: Uint8ClampedArray, width: number, x: number, y: number): number[] {
  const i = (y * width + x) * 4;
  return [data[i], data[i + 1], data[i + 2], data[i + 3]];
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("字模", () => {
  it("五种字模的尺寸与像素图一致，每片都有暗部", () => {
    expect(GLYPHS.map((g) => [g.name, g.cols, g.rows])).toEqual([
      ["P1", 7, 8],
      ["P2", 7, 7],
      ["P3", 7, 6],
      ["P4", 4, 4],
      ["P5", 3, 3],
    ]);
    for (const g of GLYPHS) expect([...g.cells].filter((v) => v === 3).length).toBeGreaterThan(0);
    expect([...GLYPHS[4].cells]).toEqual([0, 1, 3, 1, 1, 1, 1, 1, 0]);
  });
});

describe("计算颜色解析", () => {
  it("认得 rgb / rgba 的逗号与空格写法和 color(srgb …)", () => {
    expect(parseComputedColor("rgb(207, 48, 128)")).toEqual(rgba(207, 48, 128));
    expect(parseComputedColor("rgba(207, 48, 128, 0.11)")).toEqual(rgba(207, 48, 128, 28));
    expect(parseComputedColor("rgb(207 48 128 / 50%)")).toEqual(rgba(207, 48, 128, 128));
    expect(parseComputedColor("rgba(0, 0, 0, 0)")).toEqual(rgba(0, 0, 0, 0));
    expect(parseComputedColor("color(srgb 0.952941 0.803922 0.882353)")).toEqual(rgba(243, 205, 225));
    expect(parseComputedColor("color(srgb 0.811765 0.188235 0.501961 / 0.2)")).toEqual(rgba(207, 48, 128, 51));
  });

  it("其余写法与坏值直接报错", () => {
    for (const bad of ["", "transparent", "#CF3080", "hsl(330 62% 50%)", "oklch(0.6 0.2 350)", "color(display-p3 1 0 0)", "rgb(1, 2)", "rgb(a, b, c)", "rgb(1 2 3 / 4 / 5)"]) {
      expect(() => parseComputedColor(bad), bad).toThrow();
    }
  });

  it("同色判定允许 1 级舍入误差", () => {
    expect(sameColor(rgba(207, 48, 128), rgba(208, 47, 128))).toBe(true);
    expect(sameColor(rgba(207, 48, 128), rgba(209, 48, 128))).toBe(false);
    expect(sameColor(rgba(207, 48, 128, 28), rgba(207, 48, 128, 26))).toBe(false);
  });
});

describe("色调", () => {
  it("浅、中、深三种色调取花瓣五阶的固定阶位", () => {
    expect(TONES).toEqual([
      { main: 1, light: 0, shade: 2 },
      { main: 2, light: 1, shade: 3 },
      { main: 3, light: 2, shade: 4 },
    ]);
    expect(toneColors(PALETTE, 0)).toEqual([null, PALETTE[1], PALETTE[0], PALETTE[2]]);
    expect(toneColors(PALETTE, 2)).toEqual([null, PALETTE[3], PALETTE[2], PALETTE[4]]);
    expect(() => toneColors(PALETTE.slice(0, 4), 0)).toThrow("5 阶");
  });
});

describe("栅格化", () => {
  it("像素单元按设备像素比取整，至少 1", () => {
    expect([1, 1.25, 1.5, 1.75, 2, 0.4, 0.2].map(cellSize)).toEqual([2, 3, 3, 4, 4, 1, 1]);
  });

  it("每格写成 cellDev × cellDev 的整块设备像素，透明格保持透明", () => {
    const glyph = GLYPHS[4];
    const colors = toneColors(PALETTE, 1);
    const cellDev = 3;
    const width = glyph.cols * cellDev;
    const data = new Uint8ClampedArray(width * glyph.rows * cellDev * 4);
    rasterizeGlyph(glyph, colors, cellDev, data);
    const main = [225, 127, 176, 255];
    const shade = [216, 85, 151, 255];
    const clear = [0, 0, 0, 0];
    // 第一行 ".#+"：每格 3 × 3 设备像素
    for (let y = 0; y < 3; y++) {
      for (let x = 0; x < 3; x++) expect(pixel(data, width, x, y)).toEqual(clear);
      for (let x = 3; x < 6; x++) expect(pixel(data, width, x, y)).toEqual(main);
      for (let x = 6; x < 9; x++) expect(pixel(data, width, x, y)).toEqual(shade);
    }
    // 第三行 "##."：右下角整格透明
    expect(pixel(data, width, 5, 8)).toEqual(main);
    expect(pixel(data, width, 6, 6)).toEqual(clear);
    expect(pixel(data, width, 8, 8)).toEqual(clear);
    // 亮部只出现在大字模上：P1 第三行第二格
    const p1 = GLYPHS[0];
    const big = new Uint8ClampedArray(p1.cols * 2 * p1.rows * 2 * 4);
    rasterizeGlyph(p1, colors, 2, big);
    expect(pixel(big, p1.cols * 2, 2, 4)).toEqual([235, 168, 202, 255]);
    expect(pixel(big, p1.cols * 2, 3, 5)).toEqual([235, 168, 202, 255]);
    expect(pixel(big, p1.cols * 2, 4, 4)).toEqual(main);
  });

  it("缓冲长度与单元边长不合法时报错", () => {
    const glyph = GLYPHS[3];
    const colors = toneColors(PALETTE, 0);
    expect(() => rasterizeGlyph(glyph, colors, 2, new Uint8ClampedArray(10))).toThrow("缓冲长度");
    expect(() => rasterizeGlyph(glyph, colors, 1.5, new Uint8ClampedArray(144))).toThrow("正整数");
  });
});

interface FakeSpriteContext {
  createImageData(w: number, h: number): { width: number; height: number; data: Uint8ClampedArray };
  putImageData: ReturnType<typeof vi.fn>;
}

describe("精灵表", () => {
  it("生成 5 × 3 = 15 张设备像素尺寸的精灵，每张写一次 ImageData，边长不超过 32", () => {
    const contexts: FakeSpriteContext[] = [];
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(function () {
      const ctx: FakeSpriteContext = {
        createImageData: (w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }),
        putImageData: vi.fn(),
      };
      contexts.push(ctx);
      return ctx as unknown as CanvasRenderingContext2D;
    });
    const sheet = buildSprites(PALETTE, 4);
    expect(contexts).toHaveLength(15);
    expect(sheet.cellDev).toBe(4);
    expect([sheet.sprite(0, 0).width, sheet.sprite(0, 0).height]).toEqual([28, 32]);
    expect([sheet.sprite(4, 2).width, sheet.sprite(4, 2).height]).toEqual([12, 12]);
    for (let g = 0; g < 5; g++) for (let t = 0; t < 3; t++) expect(Math.max(sheet.sprite(g as 0, t as 0).width, sheet.sprite(g as 0, t as 0).height)).toBeLessThanOrEqual(32);
    for (const ctx of contexts) expect(ctx.putImageData).toHaveBeenCalledTimes(1);
    // 深色调的 P5：右上角那格是暗部，取第 4 阶（强调色本身）
    const [image] = contexts[4 * 3 + 2].putImageData.mock.calls[0] as [{ data: Uint8ClampedArray }];
    expect(pixel(image.data, 12, 8, 0)).toEqual([207, 48, 128, 255]);
    expect(sheet.sprite(1, 1)).not.toBe(sheet.sprite(1, 2));
  });

  it("拿不到 2D 上下文时报错", () => {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
    expect(() => buildSprites(PALETTE, 2)).toThrow("2D 上下文");
  });
});

describe("读花瓣色令牌", () => {
  it("逐个解析 --sk-petal-0 到 4，读完撤掉探针上的内联颜色", () => {
    const probe = document.createElement("canvas");
    document.body.append(probe);
    const seen: string[] = [];
    vi.spyOn(window, "getComputedStyle").mockImplementation((el) => {
      const inline = (el as HTMLElement).style.color;
      if (inline !== "") seen.push(inline);
      const m = /--sk-petal-(\d)/.exec(inline);
      return {
        color: m ? `rgb(${PALETTE[Number(m[1])].r}, ${PALETTE[Number(m[1])].g}, ${PALETTE[Number(m[1])].b})` : "rgb(0, 0, 0)",
        getPropertyValue: (name: string) => (name.startsWith("--sk-petal-") ? "color-mix(in srgb, #CF3080 24%, #ffffff)" : ""),
      } as unknown as CSSStyleDeclaration;
    });
    expect(readPetalPalette(probe)).toEqual(PALETTE);
    expect(seen).toEqual([0, 1, 2, 3, 4].map((i) => `var(--sk-petal-${i})`));
    expect(probe.style.color).toBe("");
    probe.remove();
  });

  it("令牌未声明时报错，而不是静默取到继承的文字色", () => {
    const probe = document.createElement("canvas");
    vi.spyOn(window, "getComputedStyle").mockImplementation(() => ({ color: "rgb(1, 2, 3)", getPropertyValue: () => "" }) as unknown as CSSStyleDeclaration);
    expect(() => readPetalPalette(probe)).toThrow("--sk-petal-0 未声明");
  });
});
