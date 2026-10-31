// 像素花瓣的字模与色调。复刻原版樱花粒子的像素语言（斜向菱形块、平涂、一个暗部像素、浅中深三种明度），
// 但数据是手绘的，不读取任何原版粒子文件。所有花瓣共用 2 CSS px 的像素单元：同一画面里像素尺寸一致，
// 远近层次只用字模大小与不透明度表达。静态插画与主页花瓣场共用这份数据。

/** 单元值：0 透明，1 主色，2 亮部，3 暗部。 */
export type PetalCell = 0 | 1 | 2 | 3;

export type PetalGlyphName = "P1" | "P2" | "P3" | "P4" | "P5";

export interface PetalGlyph {
  readonly width: number;
  readonly height: number;
  /** 行优先的单元值。 */
  readonly cells: readonly PetalCell[];
}

/** 每个像素单元的 CSS 尺寸。 */
export const PETAL_CELL = 2;

const LEGEND: Record<string, PetalCell> = { ".": 0, "#": 1, o: 2, "+": 3 };

function glyph(rows: readonly string[]): PetalGlyph {
  const width = rows[0].length;
  const cells = rows.flatMap((row, y) => {
    if (row.length !== width) throw new Error(`花瓣字模第 ${y + 1} 行宽 ${row.length}，应为 ${width}`);
    return [...row].map((ch) => {
      const value = LEGEND[ch];
      if (value === undefined) throw new Error(`花瓣字模含未知字符 ${ch}`);
      return value;
    });
  });
  return { width, height: rows.length, cells };
}

export const PETAL_GLYPHS: Readonly<Record<PetalGlyphName, PetalGlyph>> = {
  // 整瓣：正面，顶端带缺刻
  P1: glyph([".##.##.", "#######", "#o#####", "#######", ".#####.", ".####+.", "..##+..", "...+..."]),
  // 斜瓣：斜向，缺刻朝右上
  P2: glyph(["...##.#", "..###.#", ".#o####", ".#####.", "#####..", "###+...", "+......"]),
  // 侧瓣：侧面，看不见缺刻
  P3: glyph(["..##...", ".####..", ".#o###.", "..####.", "...###+", "....++."]),
  // 小瓣
  P4: glyph(["..##", ".###", "###.", "+#.."]),
  // 碎瓣：与原版粒子同形
  P5: glyph([".#+", "###", "##."]),
};

export type PetalTone = "light" | "mid" | "deep";

export type PetalShade = "petal-0" | "petal-1" | "petal-2" | "petal-3" | "petal-4";

/** 色调决定主色、亮部、暗部各取花瓣五阶中的哪一阶。 */
export const PETAL_TONES: Readonly<Record<PetalTone, { main: PetalShade; light: PetalShade; dark: PetalShade; weight: number }>> = {
  light: { main: "petal-1", light: "petal-0", dark: "petal-2", weight: 0.4 },
  mid: { main: "petal-2", light: "petal-1", dark: "petal-3", weight: 0.35 },
  deep: { main: "petal-3", light: "petal-2", dark: "petal-4", weight: 0.25 },
};

const TONE_ORDER: readonly PetalTone[] = ["light", "mid", "deep"];

/**
 * 按权重抽色调，r 为 [0, 1) 的随机数。浅色权重最大：花瓣场整体读作「淡粉的风」而不是「粉色斑点」，
 * 守住单屏强调色面积的预算。
 */
export function pickPetalTone(r: number): PetalTone {
  if (!(r >= 0 && r < 1)) throw new Error(`随机数应在 [0, 1)，实为 ${r}`);
  // 前几档按累计权重判定，落不进任何一档的就是最后一档
  let acc = 0;
  for (const tone of TONE_ORDER.slice(0, -1)) {
    acc += PETAL_TONES[tone].weight;
    if (r < acc) return tone;
  }
  return TONE_ORDER[TONE_ORDER.length - 1];
}

export type QuarterTurn = 0 | 90 | 180 | 270;

/**
 * 静态花瓣只允许水平镜像与 90° 倍数旋转：像素必须仍落在整数格上。先镜像再顺时针旋转。
 * 任意角度旋转只出现在动态花瓣场里。
 */
export function transformGlyph(source: PetalGlyph, mirror: boolean, rotate: QuarterTurn): PetalGlyph {
  const { width: w, height: h } = source;
  const at = (x: number, y: number) => source.cells[y * w + (mirror ? w - 1 - x : x)];
  const turned = rotate === 90 || rotate === 270;
  const width = turned ? h : w;
  const height = turned ? w : h;
  const cells: PetalCell[] = [];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (rotate === 0) cells.push(at(x, y));
      else if (rotate === 90) cells.push(at(y, h - 1 - x));
      else if (rotate === 180) cells.push(at(w - 1 - x, h - 1 - y));
      else cells.push(at(w - 1 - y, x));
    }
  }
  return { width, height, cells };
}

/** 某一单元值的全部格子合成一条路径（1 × 1 方格连写），坐标为字模单元。 */
export function glyphPath(source: PetalGlyph, value: Exclude<PetalCell, 0>): string {
  let d = "";
  source.cells.forEach((cell, i) => {
    if (cell === value) d += `M${i % source.width} ${Math.floor(i / source.width)}h1v1h-1Z`;
  });
  return d;
}
