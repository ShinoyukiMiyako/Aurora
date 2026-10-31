// 像素花瓣的字模与色调。花瓣全部由代码绘制，不读取游戏自带的粒子贴图：
// 启动器在本机还没有任何游戏文件时也要能显示花瓣，而且字模要能随强调色重新着色。
//
// 字模每格取值：0 透明、1 主色、2 亮部、3 暗部。字符串里 "." 为 0、"#" 为 1、"o" 为 2、"+" 为 3，
// 与像素画稿逐格对应，改字模时直接改这里的行。

/** 所有花瓣共用的像素单元（CSS 像素）。同一画面里像素尺寸一致，远近只靠字模大小、不透明度、速度与摆幅表达。 */
export const CELL = 2;

export interface Glyph {
  /** 字模名，只用于诊断与测试输出。 */
  name: string;
  cols: number;
  rows: number;
  /** 按行展开的格值，长度为 cols × rows。 */
  cells: Uint8Array;
}

const CELL_VALUE: Readonly<Record<string, number>> = { ".": 0, "#": 1, o: 2, "+": 3 };

function glyph(name: string, rows: readonly string[]): Glyph {
  const cols = rows[0].length;
  const cells = new Uint8Array(cols * rows.length);
  rows.forEach((row, y) => {
    if (row.length !== cols) throw new Error(`字模 ${name} 第 ${y + 1} 行宽 ${row.length}，应为 ${cols}`);
    for (let x = 0; x < cols; x++) {
      const value = CELL_VALUE[row[x]];
      if (value === undefined) throw new Error(`字模 ${name} 第 ${y + 1} 行含未知格「${row[x]}」`);
      cells[y * cols + x] = value;
    }
  });
  return { name, cols, rows: rows.length, cells };
}

/** P1 整瓣、P2 斜瓣、P3 侧瓣、P4 小瓣、P5 碎瓣；下标即 GlyphId。 */
export const GLYPHS: readonly Glyph[] = [
  glyph("P1", [".##.##.", "#######", "#o#####", "#######", ".#####.", ".####+.", "..##+..", "...+..."]),
  glyph("P2", ["...##.#", "..###.#", ".#o####", ".#####.", "#####..", "###+...", "+......"]),
  glyph("P3", ["..##...", ".####..", ".#o###.", "..####.", "...###+", "....++."]),
  glyph("P4", ["..##", ".###", "###.", "+#.."]),
  glyph("P5", [".#+", "###", "##."]),
];

export type GlyphId = 0 | 1 | 2 | 3 | 4;

/** 色调：浅、中、深；下标即 ToneId。 */
export type ToneId = 0 | 1 | 2;

/**
 * 每种色调的主色、亮部、暗部分别取花瓣五阶色（--sk-petal-0 到 --sk-petal-4）的哪一阶。
 * 五阶色由强调色与白色按固定比例混合得到，夜樱下花瓣因此仍然发亮。
 */
export const TONES: readonly { main: number; light: number; shade: number }[] = [
  { main: 1, light: 0, shade: 2 },
  { main: 2, light: 1, shade: 3 },
  { main: 3, light: 2, shade: 4 },
];

/** 色调抽取权重偏向浅色：花瓣场整体要读作淡粉的风，而不是一片粉色斑点。 */
export const TONE_WEIGHTS: readonly number[] = [0.4, 0.35, 0.25];

/** 花瓣五阶色的令牌数。 */
export const PETAL_SHADES = 5;
