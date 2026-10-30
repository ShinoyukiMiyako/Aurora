// 方块面的逐像素预处理：染色、明暗、小尺寸档的面积平均重采样，以及材质不可读时的实例徽记纹理。
// 全部在 RGBA 数组上做，不用合成模式与遮罩：树叶这类带透明像素的材质，透明处原样保持透明。

import { blankPixels, type Pixels } from "../illustrations/canvas";
import { hslToRgb, type Rgb } from "../illustrations/color";
import { fnv1a32 } from "../illustrations/seed";

/** 染色：rgb × tint / 255，alpha 不变。 */
export function tintPixels(source: Pixels, tint: Rgb): Pixels {
  const data = new Uint8ClampedArray(source.data);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = Math.round((data[i] * tint[0]) / 255);
    data[i + 1] = Math.round((data[i + 1] * tint[1]) / 255);
    data[i + 2] = Math.round((data[i + 2] * tint[2]) / 255);
  }
  return { width: source.width, height: source.height, data };
}

/** 明暗：rgb 乘系数，alpha 不变。 */
export function shadePixels(source: Pixels, factor: number): Pixels {
  if (!(factor >= 0 && factor <= 1)) throw new Error(`明暗系数应在 0-1，实为 ${factor}`);
  const data = new Uint8ClampedArray(source.data);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = Math.round(data[i] * factor);
    data[i + 1] = Math.round(data[i + 1] * factor);
    data[i + 2] = Math.round(data[i + 2] * factor);
  }
  return { width: source.width, height: source.height, data };
}

const toLinear = (c: number) => {
  const s = c / 255;
  return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
};

const toSrgb = (l: number) => {
  const s = l <= 0.0031308 ? l * 12.92 : 1.055 * l ** (1 / 2.4) - 0.055;
  return Math.round(Math.min(1, Math.max(0, s)) * 255);
};

/**
 * 面积平均重采样：方形源图缩到 size × size。每个目标像素按覆盖面积对源像素加权，
 * 在线性光下求平均且按 alpha 加权：在 sRGB 上直接平均会让明暗交界发暗，不按 alpha 加权会把透明像素的黑色混进来。
 */
export function resampleArea(source: Pixels, size: number): Pixels {
  if (source.width !== source.height) throw new Error(`只能重采样方形材质，实为 ${source.width}x${source.height}`);
  if (!Number.isInteger(size) || size <= 0 || size > source.width) throw new Error(`重采样目标边长 ${size} 不合法（源边长 ${source.width}）`);
  const n = source.width;
  const ratio = n / size;
  const out = blankPixels(size, size);
  for (let ty = 0; ty < size; ty++) {
    for (let tx = 0; tx < size; tx++) {
      const x0 = tx * ratio;
      const x1 = x0 + ratio;
      const y0 = ty * ratio;
      const y1 = y0 + ratio;
      let area = 0;
      let alphaArea = 0;
      let r = 0;
      let g = 0;
      let b = 0;
      for (let sy = Math.floor(y0); sy < Math.ceil(y1 - 1e-9); sy++) {
        const wy = Math.min(sy + 1, y1) - Math.max(sy, y0);
        for (let sx = Math.floor(x0); sx < Math.ceil(x1 - 1e-9); sx++) {
          const w = (Math.min(sx + 1, x1) - Math.max(sx, x0)) * wy;
          const i = (sy * n + sx) * 4;
          const a = (source.data[i + 3] / 255) * w;
          area += w;
          alphaArea += a;
          r += toLinear(source.data[i]) * a;
          g += toLinear(source.data[i + 1]) * a;
          b += toLinear(source.data[i + 2]) * a;
        }
      }
      const o = (ty * size + tx) * 4;
      if (alphaArea > 0) {
        out.data[o] = toSrgb(r / alphaArea);
        out.data[o + 1] = toSrgb(g / alphaArea);
        out.data[o + 2] = toSrgb(b / alphaArea);
      }
      out.data[o + 3] = Math.round((alphaArea / area) * 255);
    }
  }
  return out;
}

/**
 * 方块材质必须宽 16；高度为 16 的整数倍且大于 16 时是竖排动画帧，只取首帧 (0, 0, 16, 16)。
 * 不合规的尺寸按材质不可读处理。
 */
export function validTextureSize(width: number, height: number): boolean {
  return width === 16 && height >= 16 && height % 16 === 0;
}

/** 实例徽记纹理的三档明度偏移（相对 74%）。 */
const EMBLEM_LIGHTNESS = [70, 74, 78] as const;

/**
 * 实例徽记：材质不可读时的回落纹理。每个像素取色相 H、饱和度 42%、明度 L，L 由 fnv1a32(id:u:v) mod 3 选取，
 * 同一实例永远同一张纹理；三个面都用它，走与真方块完全相同的投影、明暗与缓存流程，切换时没有布局位移。
 * 不画任何文字或字母。
 */
export function emblemPixels(instanceId: string, hue: number, size: number): Pixels {
  const colors = EMBLEM_LIGHTNESS.map((l) => hslToRgb(hue, 42, l));
  const out = blankPixels(size, size);
  for (let v = 0; v < size; v++) {
    for (let u = 0; u < size; u++) {
      const [r, g, b] = colors[fnv1a32(`${instanceId}:${u}:${v}`) % 3];
      const o = (v * size + u) * 4;
      out.data[o] = r;
      out.data[o + 1] = g;
      out.data[o + 2] = b;
      out.data[o + 3] = 255;
    }
  }
  return out;
}
