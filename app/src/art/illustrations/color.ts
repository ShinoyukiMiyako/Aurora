// 逐像素绘制的回落图形（实例徽记、皮肤剪影）要把 HSL 换成 RGB 写进 ImageData，
// 颜色由数据（色相）与固定的饱和度、明度公式决定，不经过 CSS。

export type Rgb = readonly [r: number, g: number, b: number];

/** 逐格母版（花瓣徽记、花枝）的调色板写成 #RRGGBB，画进 ImageData 前换成分量。 */
export function hexToRgb(hex: string): Rgb {
  if (!/^#[0-9a-fA-F]{6}$/.test(hex)) throw new Error(`调色板颜色应为 #RRGGBB，实为 ${hex}`);
  const value = Number.parseInt(hex.slice(1), 16);
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
}

/** h 为色相（度，任意实数，按 360 取模），s、l 为百分数 0-100。结果四舍五入到 0-255。 */
export function hslToRgb(h: number, s: number, l: number): Rgb {
  if (s < 0 || s > 100 || l < 0 || l > 100) throw new Error(`HSL 分量越界：s=${s} l=${l}`);
  const hue = ((h % 360) + 360) % 360;
  const sat = s / 100;
  const light = l / 100;
  const chroma = (1 - Math.abs(2 * light - 1)) * sat;
  const sector = hue / 60;
  const x = chroma * (1 - Math.abs((sector % 2) - 1));
  const [r1, g1, b1] =
    sector < 1 ? [chroma, x, 0] : sector < 2 ? [x, chroma, 0] : sector < 3 ? [0, chroma, x] : sector < 4 ? [0, x, chroma] : sector < 5 ? [x, 0, chroma] : [chroma, 0, x];
  const m = light - chroma / 2;
  return [Math.round((r1 + m) * 255), Math.round((g1 + m) * 255), Math.round((b1 + m) * 255)];
}
