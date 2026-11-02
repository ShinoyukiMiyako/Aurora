import { describe, expect, it } from "vitest";
import data from "../blossom-branch.json";
import {
  BLOSSOMS,
  BRANCH_PALETTE,
  branchCell,
  branchLayout,
  paintBranch,
  placeBlossoms,
  rasterizeBranch,
  SMALL_BLOSSOMS,
  spriteVariant,
  type SpriteName,
  type Tint,
} from "./branch-art";

const KEYS = Object.keys(data.palette);
const SPRITE_NAMES = Object.keys(data.sprites) as SpriteName[];
const valueOf = (key: string) => KEYS.indexOf(key) + 1;
const keyOf = (value: number) => (value === 0 ? null : KEYS[value - 1]);
const WOOD = new Set(["w", "d", "m", "l", "h"]);

/** 5 处用法的框尺寸（含各尺寸档）。 */
const FRAMES = [
  [248, 200],
  [272, 200],
  [260, 170],
  [210, 150],
  [250, 175],
  [150, 110],
  [150, 96],
] as const;

describe("branchCell", () => {
  it.each([
    [1, 3],
    [1.25, 4],
    [1.5, 5],
    [1.75, 5],
    [2, 6],
    [2.5, 8],
    [3, 9],
  ])("缩放比 %d：每格 %d 设备像素", (dpr, cell) => {
    expect(branchCell(dpr)).toBe(cell);
  });

  it("缩放比不是正数时抛错", () => {
    expect(() => branchCell(0)).toThrow("设备像素比必须为正：0");
    expect(() => branchCell(Number.NaN)).toThrow("设备像素比必须为正");
  });
});

describe("blossom-branch.json", () => {
  it("调色板全是 #RRGGBB，精灵每行等宽、只用调色板里的键", () => {
    for (const hex of Object.values(data.palette)) expect(hex).toMatch(/^#[0-9A-F]{6}$/);
    for (const name of SPRITE_NAMES) {
      const rows = data.sprites[name];
      for (const row of rows) {
        expect(row.length, name).toBe(rows[0].length);
        for (const ch of row) expect(ch === "." || KEYS.includes(ch), `${name} 的 ${ch}`).toBe(true);
      }
    }
  });

  it("调色板分量按十六进制换算", () => {
    expect(BRANCH_PALETTE[valueOf("w") - 1]).toEqual([74, 37, 57]);
    expect(BRANCH_PALETTE[valueOf("O") - 1]).toEqual([169, 87, 138]);
    expect(BRANCH_PALETTE[valueOf("H") - 1]).toEqual([255, 234, 244]);
    expect(BRANCH_PALETTE[valueOf("p4") - 1]).toEqual([207, 48, 128]);
  });
});

describe("spriteVariant", () => {
  /** 写成字面表：色调换错时，从同一份映射推出的期望值发现不了。 */
  const EXPECTED: Record<Tint, Record<string, string>> = {
    base: {},
    pale: { S: "M", M: "L", L: "H" },
    deep: { H: "L", L: "M", M: "S" },
  };

  it.each(["base", "pale", "deep"] as const)("%s：花瓣色按表换一阶，描边与木色不动", (tint) => {
    for (const name of SPRITE_NAMES) {
      const rows = data.sprites[name];
      const grid = spriteVariant(name, tint, false);
      rows.forEach((row, y) =>
        [...row].forEach((ch, x) => {
          const want = ch === "." ? null : (EXPECTED[tint][ch] ?? ch);
          expect(grid[y][x], `${name} (${x}, ${y})`).toBe(want);
        }),
      );
    }
  });

  it("镜像逐行左右翻转", () => {
    const plain = spriteVariant("flower11", "deep", false);
    const mirrored = spriteVariant("flower11", "deep", true);
    plain.forEach((line, y) => expect(mirrored[y]).toEqual([...line].reverse()));
  });
});

describe("paintBranch", () => {
  it("格数 = 框边长 ÷ 每格边长，向下取整", () => {
    for (let round = 0; round < 12; round++) {
      const width = 120 + Math.floor(Math.random() * 200);
      const height = 80 + Math.floor(Math.random() * 160);
      const cell = branchCell(1 + Math.random() * 2) / (1 + Math.random() * 2);
      const art = paintBranch(width, height, cell);
      expect([art.cols, art.rows], `${width}x${height} 每格 ${cell}`).toEqual([Math.floor(width / cell), Math.floor(height / cell)]);
      expect(art.cells.length).toBe(art.cols * art.rows);
      expect(Math.max(...art.cells)).toBeLessThanOrEqual(KEYS.length);
    }
  });

  it("同样的输入画出逐格相同的图", () => {
    const a = paintBranch(250, 175, 3.2);
    const b = paintBranch(250, 175, 3.2);
    expect(Array.from(a.cells)).toEqual(Array.from(b.cells));
  });

  it("框比构图宽时主枝仍从左缘伸进来，框边那一列不描边", () => {
    const art = paintBranch(360, 150, 3);
    const column = Array.from({ length: art.rows }, (_, y) => keyOf(art.cells[y * art.cols]));
    const wood = column.flatMap((key, y) => (key !== null && WOOD.has(key) ? [y] : []));
    expect(wood.length).toBeGreaterThanOrEqual(3);
    expect(wood[wood.length - 1] - wood[0] + 1).toBe(wood.length);
    expect(column[wood[0]]).toBe("w");
    expect(column[wood[wood.length - 1]]).toBe("w");
    expect(wood.slice(1, -1).some((y) => column[y] !== "w")).toBe(true);
  });

  it("常规框开十样花，缩放比低于 0.8 的小框只留五样", () => {
    const regular = paintBranch(248, 200, 3).blossoms.map((b) => b.sprite);
    expect(regular).toEqual(["bud", "flower9", "half", "flower11", "half", "budTilt", "flower13", "flower9", "flower9down", "bud"]);
    expect(regular).toEqual(BLOSSOMS.map((b) => b.sprite));
    const small = paintBranch(150, 96, 3).blossoms.map((b) => b.sprite);
    expect(small).toEqual(["half", "flower11", "flower9down", "bud", "flower9"]);
    expect(small).toEqual(SMALL_BLOSSOMS.map((b) => b.sprite));
  });

  it("同一枝上的花不雷同：形状、色调、镜像三样组合两两不同", () => {
    for (const list of [BLOSSOMS, SMALL_BLOSSOMS]) {
      const looks = list.map((b) => `${b.sprite}/${b.tint}/${b.mirror}`);
      expect(new Set(looks).size).toBe(looks.length);
    }
  });

  it("5 处用法的框在常见缩放比下，没有一朵花被框边裁掉", () => {
    for (const dpr of [1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3]) {
      const cell = branchCell(dpr) / dpr;
      for (const [width, height] of FRAMES) {
        const layout = branchLayout(width, height, cell);
        for (const b of placeBlossoms(layout)) {
          const where = `${width}x${height} 缩放比 ${dpr} 的 ${b.sprite}`;
          expect(b.x, where).toBeGreaterThanOrEqual(0);
          expect(b.y, where).toBeGreaterThanOrEqual(0);
          expect(b.x + b.width, where).toBeLessThanOrEqual(layout.cols);
          expect(b.y + b.height, where).toBeLessThanOrEqual(layout.rows);
        }
      }
    }
  });

  it.each(FRAMES)("%d x %d：每朵花没被后画的花压住的格子与精灵逐格相同", (width, height) => {
    const art = paintBranch(width, height, 3);
    const covered = new Set<number>();
    for (let i = art.blossoms.length - 1; i >= 0; i--) {
      const b = art.blossoms[i];
      spriteVariant(b.sprite, b.tint, b.mirror).forEach((line, y) =>
        line.forEach((key, x) => {
          if (key === null) return;
          const at = (b.y + y) * art.cols + b.x + x;
          if (!covered.has(at)) expect(keyOf(art.cells[at]), `${b.sprite} (${x}, ${y})`).toBe(key);
          covered.add(at);
        }),
      );
    }
  });
});

describe("rasterizeBranch", () => {
  it("每格整块复制成 cell × cell 个设备像素，透明格留空", () => {
    const art = paintBranch(210, 150, 3);
    const cell = 4;
    const pixels = rasterizeBranch(art, cell);
    expect([pixels.width, pixels.height]).toEqual([art.cols * cell, art.rows * cell]);
    for (let round = 0; round < 400; round++) {
      const x = Math.floor(Math.random() * pixels.width);
      const y = Math.floor(Math.random() * pixels.height);
      const value = art.cells[Math.floor(y / cell) * art.cols + Math.floor(x / cell)];
      const at = (y * pixels.width + x) * 4;
      const rgba = [...pixels.data.slice(at, at + 4)];
      expect(rgba, `(${x}, ${y})`).toEqual(value === 0 ? [0, 0, 0, 0] : [...BRANCH_PALETTE[value - 1], 255]);
    }
  });

  it("随机尺寸下只有调色板颜色，不产生插值色", () => {
    const allowed = new Set(["0,0,0,0", ...BRANCH_PALETTE.map((rgb) => `${rgb.join()},255`)]);
    for (let round = 0; round < 4; round++) {
      const art = paintBranch(150 + Math.floor(Math.random() * 130), 96 + Math.floor(Math.random() * 110), 3);
      const pixels = rasterizeBranch(art, 2 + Math.floor(Math.random() * 4));
      for (let at = 0; at < pixels.data.length; at += 4) {
        const color = pixels.data.slice(at, at + 4).join();
        if (!allowed.has(color)) throw new Error(`调色板之外的颜色 ${color}`);
      }
    }
  });

  it("每格设备像素不是正整数时抛错", () => {
    const art = paintBranch(150, 96, 3);
    expect(() => rasterizeBranch(art, 0)).toThrow("每格设备像素必须是正整数：0");
    expect(() => rasterizeBranch(art, 2.5)).toThrow("每格设备像素必须是正整数：2.5");
  });
});
