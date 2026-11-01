// 等距方块的投影几何。原版物品栏里方块的显示变换是绕 X 轴 30°、绕 Y 轴 225° 的正交投影：
// 顶面对角线水平、长 √2，纵深对角线投影为 √2·sin30° = √2/2，所以顶面是宽高 2:1 的菱形；
// 竖棱投影为 cos30° = √3/2，与顶面菱形半高之比为 √1.5。换到 16 像素材质上：顶面菱形宽 32k、高 16k，
// 竖棱长 16·√1.5·k，整块外接框宽 32k、高 16k(1 + √1.5)。竖棱若按 16k 画，方块会被压扁约 18%。

export const ISO_S = Math.sqrt(1.5);

/**
 * 允许的方块宽度（CSS px）。整数倍档每材质像素 1-4 CSS px；小尺寸档先把每面面积平均重采样到
 * (W/2) × (W/2)，再按每像素 1 CSS px 绘制，状态岛里 20 px 宽的方块也是清晰的像素画。其余宽度一律不允许。
 */
export const ISO_WIDTHS = [12, 14, 16, 18, 20, 22, 24, 26, 28, 30, 32, 64, 96, 128] as const;
export type IsoWidth = (typeof ISO_WIDTHS)[number];

export function isIsoWidth(width: number): width is IsoWidth {
  return (ISO_WIDTHS as readonly number[]).includes(width);
}

export interface IsoLayout {
  width: IsoWidth;
  /** 投影高度 W(1 + √1.5)/2，非整数。 */
  height: number;
  /** 画布高度：向上取整。 */
  canvasHeight: number;
  /** 每面的材质像素数：整数倍档 16，小尺寸档 W/2。 */
  n: number;
  /** 每个材质像素的 CSS 尺寸：整数倍档 W/32，小尺寸档 1。 */
  k: number;
}

export function isoLayout(width: number): IsoLayout {
  if (!isIsoWidth(width)) throw new Error(`等距方块宽度 ${width} 不允许：只能是 12-30 的偶数或 32 / 64 / 96 / 128`);
  const small = width <= 30;
  const n = small ? width / 2 : 16;
  const k = small ? 1 : width / 32;
  const height = n * k * (1 + ISO_S);
  return { width, height, canvasHeight: Math.ceil(height - 1e-9), n, k };
}

/** Canvas / CSS 的 matrix(a, b, c, d, e, f)：x = a·u + c·v + e，y = b·u + d·v + f。 */
export type Matrix = readonly [a: number, b: number, c: number, d: number, e: number, f: number];

export type IsoFace = "top" | "left" | "right";

/** 三个面的明暗系数：原版世界渲染的面亮度（顶 1.0、南北 0.8、东西 0.6）。 */
export const FACE_SHADE: Readonly<Record<IsoFace, number>> = { top: 1, left: 0.8, right: 0.6 };

/**
 * 把材质坐标 (u, v)（u 向右、v 向下，0 ≤ u, v ≤ n）映射到方块画布的三个仿射矩阵。
 * 侧面材质的 v = 0 一边在上，草方块的草边朝上。
 */
export function faceMatrices(n: number, k: number): Readonly<Record<IsoFace, Matrix>> {
  return {
    top: [k, k / 2, -k, k / 2, n * k, 0],
    left: [k, k / 2, 0, ISO_S * k, 0, (n * k) / 2],
    right: [k, -k / 2, 0, ISO_S * k, n * k, n * k],
  };
}

export function applyMatrix(m: Matrix, u: number, v: number): [x: number, y: number] {
  return [m[0] * u + m[2] * v + m[4], m[1] * u + m[3] * v + m[5]];
}

/** 面的四角（材质坐标的四个角点映射后），顺序 (0,0)、(n,0)、(n,n)、(0,n)。 */
export function faceCorners(m: Matrix, n: number): [number, number][] {
  return [applyMatrix(m, 0, 0), applyMatrix(m, n, 0), applyMatrix(m, n, n), applyMatrix(m, 0, n)];
}

/**
 * 组装中方块的「蓝图」：外轮廓六边形 + 内部 Y 形三棱，顶点按 k = W/32 的材质像素坐标换算。
 * 与真方块完全同一几何，面落位后严丝合缝盖住蓝图。
 */
export function blueprintPath(width: IsoWidth): string {
  const k = width / 32;
  const tall = 16 * ISO_S;
  const p = (x: number, y: number) => `${round2(x * k)} ${round2(y * k)}`;
  return (
    `M${p(16, 0)}L${p(32, 8)}L${p(32, 8 + tall)}L${p(16, 16 + tall)}L${p(0, 8 + tall)}L${p(0, 8)}Z` +
    `M${p(16, 16)}L${p(0, 8)}M${p(16, 16)}L${p(32, 8)}M${p(16, 16)}L${p(16, 16 + tall)}`
  );
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
