// 花枝像素画：原版物品贴图的笔法（同色系描边、斑驳杂色），名义上 3 CSS px 一格。
// 枝干按骨架距离场现画：任何框尺寸都按 meet 等比放进去，主枝从框的左缘伸进来；花、花苞是 blossom-branch.json 里
// 逐格手绘的精灵，格数固定不随框缩放，同一根枝上的花在形状、朝向、色调、开放程度上各不相同。
// 颜色是插画自己的固定调色板，日夜与强调色都不换，和应用图标的花瓣同一套淡粉。

import data from "../blossom-branch.json";
import { blankPixels, type Pixels } from "./canvas";
import { hexToRgb, type Rgb } from "./color";
import { PETAL_GLYPHS, PETAL_TONES, type PetalGlyphName, type PetalShade, type PetalTone } from "./petal-glyphs";

/** 每格的名义边长（CSS px）。实际边长按设备像素取整，见 branchCell。 */
export const BRANCH_CELL = 3;

/** 构图坐标的基准框（CSS px），沿用原插画的 240 × 168。 */
const BASE_W = 240;
const BASE_H = 168;

/** 缩放比低于它的框（离线弹窗、紧凑档头图）换精简花位：像素格不缩，花不会跟着变小，全量会挤成一团。 */
export const SMALL_SCALE = 0.8;

/**
 * 每格占几个设备像素。像素画只有整数倍才不糊，名义 3 CSS px 在 125% 缩放下是 3.75，取整到 4；
 * 格子因此比名义值略大或略小，但同一幅图里每格一样宽。
 */
export function branchCell(dpr: number): number {
  if (!(dpr > 0)) throw new Error(`设备像素比必须为正：${dpr}`);
  return Math.max(1, Math.round(BRANCH_CELL * dpr));
}

// ---------------------------------------------------------------- 调色板与精灵

type PaletteKey = keyof typeof data.palette;
export type SpriteName = keyof typeof data.sprites;

const PALETTE_KEYS = Object.keys(data.palette) as PaletteKey[];
const KEY_INDEX = new Map<string, number>(PALETTE_KEYS.map((key, i) => [key, i + 1]));

/** 调色板，下标 = 格子值 - 1；格子值 0 为透明。 */
export const BRANCH_PALETTE: readonly Rgb[] = PALETTE_KEYS.map((key) => hexToRgb(data.palette[key]));

function cellOf(key: string): number {
  const value = KEY_INDEX.get(key);
  if (value === undefined) throw new Error(`花枝调色板里没有「${key}」`);
  return value;
}

/** 精灵格：调色板键或透明。 */
export type SpriteGrid = readonly (readonly (string | null)[])[];

function parseSprite(name: SpriteName): SpriteGrid {
  const rows = data.sprites[name];
  const width = rows[0].length;
  return rows.map((row, y) => {
    if (row.length !== width) throw new Error(`花枝精灵 ${name} 第 ${y + 1} 行宽 ${row.length}，应为 ${width}`);
    return [...row].map((ch) => {
      if (ch === ".") return null;
      cellOf(ch);
      return ch;
    });
  });
}

const SPRITES = Object.fromEntries((Object.keys(data.sprites) as SpriteName[]).map((name) => [name, parseSprite(name)])) as Record<SpriteName, SpriteGrid>;

export type Tint = "base" | "pale" | "deep";

/** 色调：同一枝上的花深浅不一。淡的花瓣色整体提一阶，深的整体压一阶，描边与木色不动。 */
export const TINTS: Readonly<Record<Tint, Readonly<Record<string, string>>>> = {
  base: {},
  pale: { S: "M", M: "L", L: "H" },
  deep: { H: "L", L: "M", M: "S" },
};

export function spriteVariant(name: SpriteName, tint: Tint, mirror: boolean): SpriteGrid {
  const map = TINTS[tint];
  const grid = SPRITES[name].map((line) => line.map((key) => (key === null ? null : (map[key] ?? key))));
  return mirror ? grid.map((line) => [...line].reverse()) : grid;
}

// ---------------------------------------------------------------- 构图（基准 CSS px）

type Point = readonly [x: number, y: number];
type Curve = readonly [c1: Point, c2: Point, end: Point];

function polyline(start: Point, curves: readonly Curve[], steps = 20): Point[] {
  const out: Point[] = [start];
  let from = start;
  for (const [c1, c2, end] of curves) {
    for (let k = 1; k <= steps; k++) {
      const t = k / steps;
      const u = 1 - t;
      out.push([
        u * u * u * from[0] + 3 * u * u * t * c1[0] + 3 * u * t * t * c2[0] + t * t * t * end[0],
        u * u * u * from[1] + 3 * u * u * t * c1[1] + 3 * u * t * t * c2[1] + t * t * t * end[1],
      ]);
    }
    from = end;
  }
  return out;
}

interface Bough {
  points: readonly Point[];
  /** 起点与终点的半径（基准 px），沿枝线性收细。 */
  r0: number;
  r1: number;
  /** 沿首段方向延长到框外：框比构图宽时主枝也从画面边缘伸进来，不悬空。 */
  fromEdge?: boolean;
}

/** 主枝从左下进画，几道弯起伏着伸向右上；四根分枝各带弧度，花贴着枝开，枝从花间露出来。 */
const BOUGHS: readonly Bough[] = [
  {
    points: polyline([0, 152], [
      [[40, 154], [60, 128], [92, 126]],
      [[122, 124], [126, 102], [156, 96]],
      [[184, 90], [196, 70], [236, 58]],
    ]),
    r0: 7.5,
    r1: 3,
    fromEdge: true,
  },
  { points: polyline([98, 125], [[[108, 104], [90, 92], [110, 78]], [[126, 66], [140, 72], [150, 52]]]), r0: 3.6, r1: 2.4 },
  { points: polyline([166, 93], [[[184, 98], [190, 114], [212, 118]]]), r0: 3.4, r1: 2.2 },
  { points: polyline([56, 136], [[[54, 124], [66, 116], [78, 108]]]), r0: 3.2, r1: 2.2 },
  { points: polyline([200, 76], [[[204, 66], [196, 58], [204, 46]]]), r0: 2.8, r1: 2 },
];

interface Blossom {
  sprite: SpriteName;
  tint: Tint;
  mirror: boolean;
  /** 精灵中心（基准 px）。 */
  at: Point;
}

const blossom = (sprite: SpriteName, tint: Tint, mirror: boolean, at: Point): Blossom => ({ sprite, tint, mirror, at });

/** 十样花，先画的在后面。 */
export const BLOSSOMS: readonly Blossom[] = [
  blossom("bud", "deep", false, [44, 136]),
  blossom("flower9", "pale", true, [80, 103]),
  blossom("half", "base", false, [98, 96]),
  blossom("flower11", "deep", false, [110, 84]),
  blossom("half", "pale", true, [158, 88]),
  blossom("budTilt", "deep", false, [164, 36]),
  blossom("flower13", "base", false, [146, 50]),
  blossom("flower9", "base", true, [200, 46]),
  blossom("flower9down", "deep", true, [212, 118]),
  blossom("bud", "base", true, [229, 56]),
];

/** 小框只留五样，各在一个枝头。 */
export const SMALL_BLOSSOMS: readonly Blossom[] = [
  blossom("half", "base", false, [100, 94]),
  blossom("flower11", "base", false, [150, 48]),
  blossom("flower9down", "deep", true, [212, 116]),
  blossom("bud", "deep", true, [226, 56]),
  blossom("flower9", "pale", false, [46, 140]),
];

/** 飘落的花瓣与花枝同一像素格，画进同一张图；字模沿用主页花瓣场的那几片。 */
const PETALS: readonly { glyph: PetalGlyphName; tone: PetalTone; at: Point }[] = [
  { glyph: "P2", tone: "mid", at: [24, 52] },
  { glyph: "P4", tone: "light", at: [60, 70] },
  { glyph: "P5", tone: "deep", at: [112, 150] },
  { glyph: "P4", tone: "light", at: [226, 132] },
  { glyph: "P5", tone: "mid", at: [178, 140] },
];

const PETAL_KEY: Readonly<Record<PetalShade, PaletteKey>> = { "petal-0": "p0", "petal-1": "p1", "petal-2": "p2", "petal-3": "p3", "petal-4": "p4" };

// ---------------------------------------------------------------- 布局

export interface BranchLayout {
  cols: number;
  rows: number;
  /** 每格边长（CSS px）。 */
  cell: number;
  /** 基准 px 到 CSS px 的缩放（meet）。 */
  scale: number;
  offsetX: number;
  offsetY: number;
}

export function branchLayout(width: number, height: number, cell: number): BranchLayout {
  if (!(width > 0 && height > 0 && cell > 0)) throw new Error(`花枝布局参数必须为正：${width}x${height}，每格 ${cell}`);
  const scale = Math.min(width / BASE_W, height / BASE_H);
  return {
    cols: Math.floor(width / cell),
    rows: Math.floor(height / cell),
    cell,
    scale,
    offsetX: (width - BASE_W * scale) / 2,
    offsetY: (height - BASE_H * scale) / 2,
  };
}

function toCells(layout: BranchLayout, [x, y]: Point): Point {
  return [(layout.offsetX + x * layout.scale) / layout.cell, (layout.offsetY + y * layout.scale) / layout.cell];
}

// ---------------------------------------------------------------- 枝干

/** 格子哈希：同一格永远得到同一个 [0, 1) 值，树皮杂色在任何一次渲染里都一样。 */
function cellHash(x: number, y: number, seed: number): number {
  let h = Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263) ^ Math.imul(seed | 0, 1442695041);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

interface WoodField {
  hit: Uint8Array;
  /** 横向位置：-1 上沿，+1 下沿。 */
  across: Float32Array;
  /** 沿枝长度（格），树皮纹按它拉长。 */
  along: Float32Array;
  radius: Float32Array;
}

/** 最细处也有两格宽，细枝不至于断成虚线。 */
const MIN_RADIUS = 0.9;

/** 每格到骨架的距离小于该处半径即为木；重叠处取半径大的枝，主枝盖住分枝的接口。 */
function woodField(layout: BranchLayout): WoodField {
  const { cols, rows } = layout;
  const field: WoodField = {
    hit: new Uint8Array(cols * rows),
    across: new Float32Array(cols * rows),
    along: new Float32Array(cols * rows),
    radius: new Float32Array(cols * rows),
  };
  for (const bough of BOUGHS) {
    let pts = bough.points.map((p) => toCells(layout, p));
    let lead = 0;
    if (bough.fromEdge) {
      const [x0, y0] = pts[0];
      const [x1, y1] = pts[1];
      const edge = -3;
      if (x0 > edge) {
        const slope = (y1 - y0) / (x1 - x0);
        pts = [[edge, y0 + slope * (edge - x0)], ...pts];
        lead = Math.hypot(x0 - edge, slope * (x0 - edge));
      }
    }
    const lengths = pts.slice(1).map((p, k) => Math.hypot(p[0] - pts[k][0], p[1] - pts[k][1]));
    const body = lengths.reduce((a, b) => a + b, 0) - lead;
    const reach = Math.max(MIN_RADIUS, (bough.r0 * layout.scale) / layout.cell) + 1;
    // 逐段只扫段附近的格子，记下每格到整条折线的最近点：逐格对整条折线求距离要十几毫秒，账户页一屏挂三幅
    const bestD2 = new Float32Array(cols * rows).fill(Infinity);
    const bestAlong = new Float32Array(cols * rows);
    const bestSide = new Int8Array(cols * rows);
    let acc = 0;
    for (let k = 0; k < pts.length - 1; k++) {
      const [ax, ay] = pts[k];
      const [bx, by] = pts[k + 1];
      const dx = bx - ax;
      const dy = by - ay;
      const l2 = dx * dx + dy * dy;
      const len = Math.sqrt(l2) || 1;
      const xFrom = Math.max(0, Math.floor(Math.min(ax, bx) - reach));
      const xTo = Math.min(cols - 1, Math.ceil(Math.max(ax, bx) + reach));
      const yFrom = Math.max(0, Math.floor(Math.min(ay, by) - reach));
      const yTo = Math.min(rows - 1, Math.ceil(Math.max(ay, by) + reach));
      for (let y = yFrom; y <= yTo; y++) {
        for (let x = xFrom; x <= xTo; x++) {
          const px = x + 0.5;
          const py = y + 0.5;
          const t = l2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / l2));
          const ox = px - (ax + t * dx);
          const oy = py - (ay + t * dy);
          const d2 = ox * ox + oy * oy;
          const at = y * cols + x;
          if (d2 >= bestD2[at]) continue;
          bestD2[at] = d2;
          bestAlong[at] = acc + t * lengths[k];
          // 上法线 (dy, -dx)：向右生长的枝，上法线朝屏幕上方
          bestSide[at] = ox * (dy / len) - oy * (dx / len) >= 0 ? 1 : -1;
        }
      }
      acc += lengths[k];
    }
    for (let at = 0; at < cols * rows; at++) {
      if (bestD2[at] === Infinity) continue;
      const t = Math.max(0, Math.min(1, (bestAlong[at] - lead) / body));
      const r = Math.max(MIN_RADIUS, ((bough.r0 + (bough.r1 - bough.r0) * t) * layout.scale) / layout.cell);
      const d = Math.sqrt(bestD2[at]);
      if (d > r) continue;
      if (field.hit[at] !== 0 && field.radius[at] >= r) continue;
      field.hit[at] = 1;
      field.across[at] = -bestSide[at] * (d / r);
      field.along[at] = bestAlong[at];
      field.radius[at] = r;
    }
  }
  return field;
}

/** 细枝只有两三格宽，全描边会整根变成最暗色，夜樱暗底上看不见。 */
const THIN_RADIUS = 1.6;

/**
 * 树皮：外缘一圈描边；内部上沿亮、下沿暗，沿枝方向拉长的斑块当树皮纹，再叠逐格杂色与零星高光。
 * 出界的邻格不算空：伸出画面的主枝在框边不描边。阈值是对着成图逐版调出来的。
 */
function paintBark(cells: Uint8Array, layout: BranchLayout, field: WoodField): void {
  const { cols, rows } = layout;
  const empty = (x: number, y: number) => x >= 0 && y >= 0 && x < cols && y < rows && field.hit[y * cols + x] === 0;
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      const at = y * cols + x;
      if (field.hit[at] === 0) continue;
      const across = field.across[at];
      if (empty(x - 1, y) || empty(x + 1, y) || empty(x, y - 1) || empty(x, y + 1)) {
        cells[at] = cellOf(field.radius[at] < THIN_RADIUS ? (across < 0 ? "m" : "d") : "w");
        continue;
      }
      const lane = Math.round(across * field.radius[at]);
      let v = -across * 1.1;
      v += (cellHash(Math.floor((field.along[at] + lane * 1.3) / 2.2), lane, 7) - 0.5) * 0.9;
      v += (cellHash(x, y, 3) - 0.5) * 0.45;
      let key = v > 0.45 ? "l" : v > -0.25 ? "m" : v > -0.95 ? "d" : "w";
      if (key === "l" && cellHash(x, y, 11) > 0.75) key = "h";
      cells[at] = cellOf(key);
    }
  }
}

// ---------------------------------------------------------------- 成图

export interface PlacedBlossom {
  sprite: SpriteName;
  tint: Tint;
  mirror: boolean;
  /** 精灵左上角（格）。 */
  x: number;
  y: number;
  width: number;
  height: number;
}

/** 本框里的花位：小框换精简花位，精灵中心落在构图位置换算出的格上。 */
export function placeBlossoms(layout: BranchLayout): PlacedBlossom[] {
  const list = layout.scale < SMALL_SCALE ? SMALL_BLOSSOMS : BLOSSOMS;
  return list.map((b) => {
    const grid = SPRITES[b.sprite];
    const [cx, cy] = toCells(layout, b.at);
    const width = grid[0].length;
    const height = grid.length;
    return { sprite: b.sprite, tint: b.tint, mirror: b.mirror, x: Math.round(cx - width / 2), y: Math.round(cy - height / 2), width, height };
  });
}

export interface BranchArt {
  cols: number;
  rows: number;
  /** 行优先，值为调色板下标 + 1，0 透明。 */
  cells: Uint8Array;
  blossoms: PlacedBlossom[];
}

function stamp(cells: Uint8Array, layout: BranchLayout, grid: SpriteGrid, x0: number, y0: number): void {
  grid.forEach((line, y) =>
    line.forEach((key, x) => {
      const gx = x0 + x;
      const gy = y0 + y;
      if (key === null || gx < 0 || gy < 0 || gx >= layout.cols || gy >= layout.rows) return;
      cells[gy * layout.cols + gx] = cellOf(key);
    }),
  );
}

/** 画一整幅：枝干、花、花瓣依次叠上。cell 为每格的 CSS 边长（设备像素取整后的值除以 dpr）。 */
export function paintBranch(width: number, height: number, cell: number): BranchArt {
  const layout = branchLayout(width, height, cell);
  const cells = new Uint8Array(layout.cols * layout.rows);
  paintBark(cells, layout, woodField(layout));
  const blossoms = placeBlossoms(layout);
  for (const b of blossoms) stamp(cells, layout, spriteVariant(b.sprite, b.tint, b.mirror), b.x, b.y);
  for (const petal of PETALS) {
    const glyph = PETAL_GLYPHS[petal.glyph];
    const tone = PETAL_TONES[petal.tone];
    const keys = [null, PETAL_KEY[tone.main], PETAL_KEY[tone.light], PETAL_KEY[tone.dark]];
    const [px, py] = toCells(layout, petal.at).map(Math.round);
    const grid = Array.from({ length: glyph.height }, (_, y) => Array.from({ length: glyph.width }, (_, x) => keys[glyph.cells[y * glyph.width + x]]));
    stamp(cells, layout, grid, px, py);
  }
  return { cols: layout.cols, rows: layout.rows, cells, blossoms };
}

/** 放大成位图：每格 cellDevice × cellDevice 个设备像素整块复制，不产生调色板之外的颜色。 */
export function rasterizeBranch(art: BranchArt, cellDevice: number): Pixels {
  if (!Number.isInteger(cellDevice) || cellDevice < 1) throw new Error(`每格设备像素必须是正整数：${cellDevice}`);
  const pixels = blankPixels(art.cols * cellDevice, art.rows * cellDevice);
  for (let y = 0; y < art.rows; y++) {
    for (let x = 0; x < art.cols; x++) {
      const value = art.cells[y * art.cols + x];
      if (value === 0) continue;
      const [r, g, b] = BRANCH_PALETTE[value - 1];
      for (let dy = 0; dy < cellDevice; dy++) {
        const row = (y * cellDevice + dy) * pixels.width;
        for (let dx = 0; dx < cellDevice; dx++) pixels.data.set([r, g, b, 255], (row + x * cellDevice + dx) * 4);
      }
    }
  }
  return pixels;
}
