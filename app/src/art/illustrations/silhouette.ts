// 皮肤剪影：取不到皮肤（还没装游戏、离线、文件损坏）时的代码绘制等价物，与真皮肤占同样的方框。
// 用账户色相上色、不用名称首字；日夜两种模式同色，与真皮肤一样不压暗。

import { blankPixels, type Pixels } from "./canvas";
import { hslToRgb, type Rgb } from "./color";

/** H 发、F 脸与手臂、E 眼、B 上身、L 腿。 */
type SilhouetteCell = "H" | "F" | "E" | "B" | "L";

const SHADE: Readonly<Record<SilhouetteCell, readonly [s: number, l: number]>> = {
  H: [28, 46],
  F: [40, 84],
  E: [30, 30],
  B: [38, 64],
  L: [30, 50],
};

/** 8 × 8 剪影头像。 */
export const SILHOUETTE_HEAD: readonly string[] = ["HHHHHHHH", "HHHHHHHH", "HFFFFFFH", "FFFFFFFF", "FFEFFEFF", "FFFFFFFF", "FFFFFFFF", "FFFFFFFF"];

export type SkinModel = "wide" | "slim";

/** 臂宽：宽体型 4、细体型 3（皮肤像素）。 */
export function armWidth(model: SkinModel): 3 | 4 {
  return model === "slim" ? 3 : 4;
}

function palette(hue: number): Record<SilhouetteCell, Rgb> {
  const out = {} as Record<SilhouetteCell, Rgb>;
  for (const cell of Object.keys(SHADE) as SilhouetteCell[]) out[cell] = hslToRgb(hue, SHADE[cell][0], SHADE[cell][1]);
  return out;
}

function fill(pixels: Pixels, x0: number, y0: number, w: number, h: number, rgb: Rgb): void {
  for (let y = y0; y < y0 + h; y++) {
    for (let x = x0; x < x0 + w; x++) {
      const i = (y * pixels.width + x) * 4;
      pixels.data[i] = rgb[0];
      pixels.data[i + 1] = rgb[1];
      pixels.data[i + 2] = rgb[2];
      pixels.data[i + 3] = 255;
    }
  }
}

function paintHead(pixels: Pixels, x0: number, y0: number, colors: Record<SilhouetteCell, Rgb>): void {
  SILHOUETTE_HEAD.forEach((row, y) => {
    [...row].forEach((cell, x) => fill(pixels, x0 + x, y0 + y, 1, 1, colors[cell as SilhouetteCell]));
  });
}

/** 剪影头像，8 × 8 像素。 */
export function silhouetteHead(hue: number): Pixels {
  const pixels = blankPixels(8, 8);
  paintHead(pixels, 0, 0, palette(hue));
  return pixels;
}

/**
 * 剪影立绘，16 × 32 像素：头部即剪影头像，身体 B、双臂 F、双腿 L，部件位置与真皮肤立绘相同。
 * 细体型的手臂窄一列，左右两侧各留出一列透明。
 */
export function silhouetteFigure(hue: number, model: SkinModel): Pixels {
  const colors = palette(hue);
  const arm = armWidth(model);
  const pixels = blankPixels(16, 32);
  paintHead(pixels, 4, 0, colors);
  fill(pixels, 4, 8, 8, 12, colors.B);
  fill(pixels, 4 - arm, 8, arm, 12, colors.F);
  fill(pixels, 12, 8, arm, 12, colors.F);
  fill(pixels, 4, 20, 4, 12, colors.L);
  fill(pixels, 8, 20, 4, 12, colors.L);
  return pixels;
}
