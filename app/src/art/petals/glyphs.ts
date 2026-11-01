// 主页花瓣场用的字模与色调视图。字模与色调数据只有一份，在 illustrations/petal-glyphs.ts，静态插画与
// 花瓣场共用；这里把它换成粒子模拟方便取用的形状：按下标取字模、格值放进 Uint8Array、色调换成五阶色下标。

import { PETAL_CELL, PETAL_GLYPHS, PETAL_TONES, type PetalGlyphName, type PetalShade, type PetalTone } from "../illustrations/petal-glyphs";

/** 所有花瓣共用的像素单元（CSS 像素）。同一画面里像素尺寸一致，远近只靠字模大小、不透明度、速度与摆幅表达。 */
export const CELL = PETAL_CELL;

export interface Glyph {
  /** 字模名，只用于诊断与测试输出。 */
  name: string;
  cols: number;
  rows: number;
  /** 按行展开的格值（0 透明、1 主色、2 亮部、3 暗部），长度为 cols × rows。 */
  cells: Uint8Array;
}

const GLYPH_ORDER: readonly PetalGlyphName[] = ["P1", "P2", "P3", "P4", "P5"];

/** P1 整瓣、P2 斜瓣、P3 侧瓣、P4 小瓣、P5 碎瓣；下标即 GlyphId。 */
export const GLYPHS: readonly Glyph[] = GLYPH_ORDER.map((name) => {
  const source = PETAL_GLYPHS[name];
  return { name, cols: source.width, rows: source.height, cells: Uint8Array.from(source.cells) };
});

export type GlyphId = 0 | 1 | 2 | 3 | 4;

/** 色调：浅、中、深；下标即 ToneId。 */
export type ToneId = 0 | 1 | 2;

const TONE_ORDER: readonly PetalTone[] = ["light", "mid", "deep"];

const SHADE_INDEX: Readonly<Record<PetalShade, number>> = {
  "petal-0": 0,
  "petal-1": 1,
  "petal-2": 2,
  "petal-3": 3,
  "petal-4": 4,
};

/**
 * 每种色调的主色、亮部、暗部分别取花瓣五阶色（--sk-petal-0 到 --sk-petal-4）的哪一阶。
 * 五阶色由强调色与白色按固定比例混合得到，夜樱下花瓣因此仍然发亮。
 */
export const TONES: readonly { main: number; light: number; shade: number }[] = TONE_ORDER.map((tone) => {
  const { main, light, dark } = PETAL_TONES[tone];
  return { main: SHADE_INDEX[main], light: SHADE_INDEX[light], shade: SHADE_INDEX[dark] };
});

/** 色调抽取权重偏向浅色：花瓣场整体要读作淡粉的风，而不是一片粉色斑点。 */
export const TONE_WEIGHTS: readonly number[] = TONE_ORDER.map((tone) => PETAL_TONES[tone].weight);

/** 花瓣五阶色的令牌数。 */
export const PETAL_SHADES = 5;
