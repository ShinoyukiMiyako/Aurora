// 皮肤的取片与排布：头像（正脸 + 帽子层）与正面立绘（头、身体、双臂、双腿，各有内外两层）。
// 坐标单位为皮肤像素；64 × 32 的旧格式皮肤没有左臂、左腿与身体外层：左侧用右侧水平镜像，外层只画帽子。

import { armWidth, type SkinModel } from "../illustrations/silhouette";

export type { SkinModel } from "../illustrations/silhouette";

/** 后端皮肤信息：远程皮肤按 sha1 取，默认皮肤按白名单路径取。 */
export type SkinRef = { kind: "remote"; sha1: string; model: SkinModel; hat: boolean } | { kind: "default"; path: string; model: SkinModel };

export type AvatarSize = 24 | 32 | 40 | 48;

/** 头像边长 -> 脸部边长与比例圆角；四周统一留 4 px 底座边，脸部是 8 的整数倍。 */
export const AVATAR_SPECS: Readonly<Record<AvatarSize, { face: number; radius: number }>> = {
  24: { face: 16, radius: 7 },
  32: { face: 24, radius: 10 },
  40: { face: 32, radius: 12 },
  48: { face: 40, radius: 14 },
};

export type FigureScale = 4 | 5 | 6;

export const FIGURE_SIZE = { width: 16, height: 32 } as const;

export const FACE_RECT = { x: 8, y: 8, w: 8, h: 8 } as const;
export const HAT_RECT = { x: 40, y: 8, w: 8, h: 8 } as const;

/** 只接受 64 × 64（新格式）与 64 × 32（旧格式）。 */
export function skinFormat(width: number, height: number): "modern" | "legacy" | null {
  if (width !== 64) return null;
  if (height === 64) return "modern";
  if (height === 32) return "legacy";
  return null;
}

export interface FigureLayer {
  /** 皮肤上的取片左上角。 */
  sx: number;
  sy: number;
  w: number;
  h: number;
  /** 立绘上的放置左上角。 */
  dx: number;
  dy: number;
  /** 水平镜像（旧格式的左臂、左腿取自右侧）。 */
  mirror: boolean;
}

/**
 * 立绘的绘制层，按先内层后外层、自上而下的顺序。右臂、右腿在画面左侧（玩家面朝屏幕）。
 */
export function figureLayers(model: SkinModel, format: "modern" | "legacy"): FigureLayer[] {
  const a = armWidth(model);
  const part = (sx: number, sy: number, w: number, h: number, dx: number, dy: number, mirror = false): FigureLayer => ({ sx, sy, w, h, dx, dy, mirror });
  if (format === "legacy") {
    return [
      part(8, 8, 8, 8, 4, 0),
      part(20, 20, 8, 12, 4, 8),
      part(44, 20, a, 12, 4 - a, 8),
      part(44, 20, a, 12, 12, 8, true),
      part(4, 20, 4, 12, 4, 20),
      part(4, 20, 4, 12, 8, 20, true),
      part(40, 8, 8, 8, 4, 0),
    ];
  }
  return [
    part(8, 8, 8, 8, 4, 0),
    part(20, 20, 8, 12, 4, 8),
    part(44, 20, a, 12, 4 - a, 8),
    part(36, 52, a, 12, 12, 8),
    part(4, 20, 4, 12, 4, 20),
    part(20, 52, 4, 12, 8, 20),
    part(40, 8, 8, 8, 4, 0),
    part(20, 36, 8, 12, 4, 8),
    part(44, 36, a, 12, 4 - a, 8),
    part(52, 52, a, 12, 12, 8),
    part(4, 36, 4, 12, 4, 20),
    part(4, 52, 4, 12, 8, 20),
  ];
}
