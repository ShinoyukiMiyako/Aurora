// 花瓣精灵：按「字模 × 色调」预先栅格化成 5 × 3 = 15 张离屏画布，每帧只做 drawImage。
// 精灵本身就是设备像素尺寸：每个像素单元是 cellDev × cellDev 的整数设备像素块，逐像素写进 ImageData，
// 不经过任何缩放，所以单元格边缘天然落在设备像素上、也不存在栅格化时的平滑。
// 外观（明暗、强调色）或设备像素比变化时整套重建，不做过渡。

import { resolveColorToken, type Rgba } from "./color";
import { CELL, GLYPHS, PETAL_SHADES, TONES, type Glyph, type GlyphId, type ToneId } from "./glyphs";

/** 花瓣五阶色，下标 0-4 对应 --sk-petal-0 到 --sk-petal-4。 */
export type PetalPalette = readonly Rgba[];

/** 从计算样式读出当前外观下的花瓣五阶色；probe 必须在文档内，令牌沿根元素继承到它身上。 */
export function readPetalPalette(probe: HTMLElement): PetalPalette {
  return Array.from({ length: PETAL_SHADES }, (_, i) => resolveColorToken(probe, `--sk-petal-${i}`));
}

/** 像素单元在设备上的边长：按设备像素比取整，至少 1。 */
export function cellSize(dprEff: number): number {
  return Math.max(1, Math.round(CELL * dprEff));
}

/** 某色调下格值 1 / 2 / 3（主色、亮部、暗部）对应的颜色；下标 0 不用。 */
export function toneColors(palette: PetalPalette, tone: ToneId): readonly [null, Rgba, Rgba, Rgba] {
  if (palette.length !== PETAL_SHADES) throw new Error(`花瓣色应有 ${PETAL_SHADES} 阶，实为 ${palette.length}`);
  const t = TONES[tone];
  return [null, palette[t.main], palette[t.light], palette[t.shade]];
}

/**
 * 把字模按 cellDev 放大写进 RGBA 缓冲（行优先，宽 cols × cellDev）。透明格保持缓冲原值，
 * 调用方传入的缓冲必须是全 0 的新缓冲。
 */
export function rasterizeGlyph(glyph: Glyph, colors: readonly [null, Rgba, Rgba, Rgba], cellDev: number, data: Uint8ClampedArray): void {
  if (!Number.isInteger(cellDev) || cellDev < 1) throw new Error(`像素单元边长必须是正整数，实为 ${cellDev}`);
  const width = glyph.cols * cellDev;
  const expected = width * glyph.rows * cellDev * 4;
  if (data.length !== expected) throw new Error(`字模 ${glyph.name} 的缓冲长度应为 ${expected}，实为 ${data.length}`);
  for (let gy = 0; gy < glyph.rows; gy++) {
    for (let gx = 0; gx < glyph.cols; gx++) {
      const value = glyph.cells[gy * glyph.cols + gx];
      if (value === 0) continue;
      const c = colors[value];
      if (c === null) throw new Error(`字模 ${glyph.name} 含无效格值 ${value}`);
      for (let dy = 0; dy < cellDev; dy++) {
        let i = ((gy * cellDev + dy) * width + gx * cellDev) * 4;
        for (let dx = 0; dx < cellDev; dx++, i += 4) {
          data[i] = c.r;
          data[i + 1] = c.g;
          data[i + 2] = c.b;
          data[i + 3] = c.a;
        }
      }
    }
  }
}

export interface SpriteSheet {
  readonly cellDev: number;
  sprite(glyph: GlyphId, tone: ToneId): HTMLCanvasElement;
}

function context2d(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("花瓣精灵拿不到 Canvas 2D 上下文");
  return ctx;
}

export function buildSprites(palette: PetalPalette, cellDev: number, doc: Document = document): SpriteSheet {
  const sheet = GLYPHS.map((glyph) =>
    TONES.map((_, tone) => {
      const canvas = doc.createElement("canvas");
      canvas.width = glyph.cols * cellDev;
      canvas.height = glyph.rows * cellDev;
      const ctx = context2d(canvas);
      const image = ctx.createImageData(canvas.width, canvas.height);
      rasterizeGlyph(glyph, toneColors(palette, tone as ToneId), cellDev, image.data);
      ctx.putImageData(image, 0, 0);
      return canvas;
    }),
  );
  return {
    cellDev,
    sprite: (glyph, tone) => sheet[glyph][tone],
  };
}
