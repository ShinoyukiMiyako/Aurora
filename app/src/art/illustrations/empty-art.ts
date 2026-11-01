// 空状态图的场景目录与几何。图 = 底圆 + 主字形 + 花瓣点缀，几何全部按画布边长 N 推出再取整，
// 同一场景在 96（常规）、64（compact）与崩溃页的 88 / 72 下比例一致。新增场景先在这里登记。

import { ICON_PATHS, type IconName } from "../icon-paths";
import { ART_GLYPHS, type ArtGlyphName } from "./art-glyphs";
import type { PetalGlyphName, PetalTone } from "./petal-glyphs";

/** 类别决定颜色与花瓣：无内容、无结果、离线、出错。 */
export type EmptyCategory = "empty" | "no-results" | "offline" | "error";

export interface EmptyPetal {
  glyph: PetalGlyphName;
  tone: PetalTone;
}

export const EMPTY_CATEGORIES: Readonly<Record<EmptyCategory, { a: EmptyPetal; b: EmptyPetal | null }>> = {
  empty: { a: { glyph: "P2", tone: "mid" }, b: { glyph: "P5", tone: "light" } },
  "no-results": { a: { glyph: "P4", tone: "light" }, b: null },
  offline: { a: { glyph: "P5", tone: "light" }, b: null },
  error: { a: { glyph: "P2", tone: "deep" }, b: null },
};

type SceneGlyph = { icon: IconName } | { art: ArtGlyphName };

export const EMPTY_SCENES = {
  /** 实例库为空、主页没有实例；「无内容」的默认图。 */
  sapling: { category: "empty", glyph: { art: "art-sapling" } },
  /** 实例库筛选无结果。 */
  telescope: { category: "no-results", glyph: { art: "art-telescope" } },
  /** 主页没有固定服务器。 */
  compass: { category: "empty", glyph: { icon: "compass" } },
  /** 没有存档。 */
  map: { category: "empty", glyph: { icon: "world" } },
  /** 原版实例没有 Mod。 */
  book: { category: "empty", glyph: { art: "art-book" } },
  /** 还没装 Mod。 */
  "enchanted-book": { category: "empty", glyph: { art: "art-book-sparkle" } },
  /** 还没有日志。 */
  "book-pen": { category: "empty", glyph: { art: "art-book-pen" } },
  /** 还没有变更历史。 */
  clock: { category: "empty", glyph: { icon: "clock" } },
  /** 没有崩溃记录。 */
  charm: { category: "empty", glyph: { art: "art-charm" } },
  /** 发现页无结果；「无结果」的默认图。 */
  "empty-branch": { category: "no-results", glyph: { art: "art-branch" } },
  /** 下载队列为空。 */
  "empty-basket": { category: "empty", glyph: { art: "art-basket" } },
  /** 没有账户。 */
  "empty-nametag": { category: "empty", glyph: { art: "art-nametag" } },
  /** 断网；「离线」的默认图。 */
  offline: { category: "offline", glyph: { icon: "cloud-off" } },
  /** 模块错误、页面错误边界、崩溃诊断页头部；「出错」的默认图。 */
  error: { category: "error", glyph: { art: "art-branch-broken" } },
  /** 列表内的紧凑搜索空态。 */
  search: { category: "no-results", glyph: { icon: "search" } },
} as const satisfies Record<string, { category: EmptyCategory; glyph: SceneGlyph }>;

export type EmptyScene = keyof typeof EMPTY_SCENES;

/** 96 常规、64 compact；88 / 72 只给崩溃诊断页头部。 */
export type EmptyArtSize = 96 | 64 | 88 | 72;

/** 主字形的描边路径：插画字形或图标的描边部分。图标若带实心部分则不能当空状态字形。 */
export function sceneGlyphPath(scene: EmptyScene): string {
  const glyph: SceneGlyph = EMPTY_SCENES[scene].glyph;
  if ("art" in glyph) return ART_GLYPHS[glyph.art];
  const def: { s?: string; f?: string } = ICON_PATHS[glyph.icon];
  if (def.f !== undefined || def.s === undefined) throw new Error(`图标 ${glyph.icon} 含实心部分或没有描边，不能用作空状态字形`);
  return def.s;
}

export interface EmptyArtGeometry {
  circle: { cx: number; cy: number; r: number };
  /** 主字形：边长取偶数，中心与底圆圆心重合。 */
  glyph: { x: number; y: number; size: number; strokeWidth: number };
  petalA: { x: number; y: number };
  petalB: { x: number; y: number };
}

/** 偶数取整：就近取偶数，正好居中时取大。 */
function roundEven(value: number): number {
  return 2 * Math.round(value / 2 + 1e-9);
}

export function emptyArtGeometry(n: EmptyArtSize): EmptyArtGeometry {
  const cx = Math.round(n / 2);
  const cy = Math.round((n * 13) / 24);
  const size = roundEven((n * 7) / 12);
  // 渲染粗细：96 及以上 2.25 px，更小 2 px；换算回 24 网格的描边单位
  const strokePx = n >= 96 ? 2.25 : 2;
  return {
    circle: { cx, cy, r: Math.round((n * 5) / 12) },
    glyph: { x: cx - size / 2, y: cy - size / 2, size, strokeWidth: (strokePx * 24) / size },
    petalA: { x: Math.round(n * 0.729), y: Math.round(n * 0.146) },
    petalB: { x: Math.round(n * 0.167), y: Math.round(n * 0.771) },
  };
}
