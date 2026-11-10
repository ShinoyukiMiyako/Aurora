// 皮肤的取片与排布：头像（正脸 + 帽子层）与立绘方框。坐标单位为皮肤像素；立绘的盒子与 UV 在 figure3d.ts。

import type { SkinModel } from "../illustrations/silhouette";

export type { SkinModel } from "../illustrations/silhouette";

/** 后端皮肤信息：远程皮肤按 sha1 取，默认皮肤按白名单路径取。 */
export type SkinRef = { kind: "remote"; sha1: string; model: SkinModel; hat: boolean } | { kind: "default"; path: string; model: SkinModel };

/**
 * 头像与立绘收的皮肤：SkinRef 有皮肤，null 没有可用皮肤（画剪影），"loading" 皮肤信息还在读、还不知道有没有。
 * 读取中保留正在显示的那一张，读到再换：换了账户时不先落回剪影、再淡入新皮肤。
 */
export type SkinSource = SkinRef | null | "loading";

export type AvatarSize = 24 | 32 | 40 | 48;

/** 头像边长 -> 脸部边长与比例圆角；四周统一留 4 px 底座边，脸部是 8 的整数倍。 */
export const AVATAR_SPECS: Readonly<Record<AvatarSize, { face: number; radius: number }>> = {
  24: { face: 16, radius: 7 },
  32: { face: 24, radius: 10 },
  40: { face: 32, radius: 12 },
  48: { face: 40, radius: 14 },
};

export type FigureScale = 4 | 5 | 6;

/** 立绘在页面布局里占的方框：底边就是脚底基线，也是剪影的尺寸。 */
export const FIGURE_SIZE = { width: 16, height: 32 } as const;

/**
 * 3D 投影的外框比布局方框四周各大这么多。yaw 转满一圈时手臂外缘离中线最远 9.24；
 * 俯视让帽子后角升到基线以上 33.11、脚尖落到基线以下 1.24，四周都在 2 以内，余量留给接缝重叠。
 */
export const FIGURE_FRAME_PAD = 2;

export const FIGURE_FRAME = { width: FIGURE_SIZE.width + 2 * FIGURE_FRAME_PAD, height: FIGURE_SIZE.height + 2 * FIGURE_FRAME_PAD } as const;

export const FACE_RECT = { x: 8, y: 8, w: 8, h: 8 } as const;
export const HAT_RECT = { x: 40, y: 8, w: 8, h: 8 } as const;

/** 只接受 64 × 64（新格式）与 64 × 32（旧格式）。 */
export function skinFormat(width: number, height: number): "modern" | "legacy" | null {
  if (width !== 64) return null;
  if (height === 64) return "modern";
  if (height === 32) return "legacy";
  return null;
}
