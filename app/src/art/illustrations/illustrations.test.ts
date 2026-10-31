import { describe, expect, it } from "vitest";
import { coverRect } from "./canvas";
import { hslToRgb } from "./color";
import { coverPetals } from "./CoverPattern";
import { EMPTY_CATEGORIES, EMPTY_SCENES, emptyArtGeometry, sceneGlyphPath, type EmptyScene } from "./empty-art";
import { glyphPath, PETAL_GLYPHS, PETAL_TONES, pickPetalTone, transformGlyph, type PetalGlyphName } from "./petal-glyphs";
import { accountHue, fnv1a32, hueOf, mulberry32, serverHue } from "./seed";
import { armWidth, silhouetteFigure, silhouetteHead, SILHOUETTE_HEAD } from "./silhouette";

describe("fnv1a32 / mulberry32", () => {
  it("FNV-1a 32 位标准向量，按 UTF-8 字节计算", () => {
    expect(fnv1a32("")).toBe(2166136261);
    expect(fnv1a32("a")).toBe(0xe40c292c);
    expect(fnv1a32("foobar")).toBe(0xbf9cf968);
    expect(fnv1a32("樱")).toBe(2099989590);
  });

  it("mulberry32 标准序列", () => {
    const r1 = mulberry32(1);
    expect([r1(), r1(), r1()]).toEqual([0.6270739405881613, 0.002735721180215478, 0.5274470399599522]);
    const r0 = mulberry32(0);
    expect(r0()).toBe(0.26642920868471265);
    // 大于 2^31 的种子按 32 位有符号截断，与字符串哈希直接作种子的用法一致
    const big = mulberry32(3826002220);
    expect(big()).toBe(0.621685681398958);
  });

  it("输出落在 [0, 1)，同种子同序列", () => {
    const a = mulberry32(20231);
    const b = mulberry32(20231);
    for (let i = 0; i < 1000; i++) {
      const v = a();
      expect(v).toBe(b());
      expect(v >= 0 && v < 1).toBe(true);
    }
  });

  it("色相：账户 UUID 去连字符、不分大小写；服务器地址不分大小写", () => {
    expect(hueOf("a")).toBe(3826002220 % 360);
    expect(accountHue("01234567-89AB-cdef-0123-456789ABCDEF")).toBe(accountHue("0123456789abcdef0123456789abcdef"));
    expect(accountHue("0123456789abcdef0123456789abcdef")).toBe(45);
    expect(serverHue("Play.Example.com")).toBe(288);
    for (const key of ["x", "mod:sodium", "1.21.1"]) expect(hueOf(key)).toBeGreaterThanOrEqual(0);
  });
});

describe("hslToRgb", () => {
  it("标准换算", () => {
    expect(hslToRgb(0, 100, 50)).toEqual([255, 0, 0]);
    expect(hslToRgb(120, 100, 25)).toEqual([0, 128, 0]);
    expect(hslToRgb(240, 100, 50)).toEqual([0, 0, 255]);
    expect(hslToRgb(0, 0, 100)).toEqual([255, 255, 255]);
    expect(hslToRgb(0, 0, 0)).toEqual([0, 0, 0]);
    expect(hslToRgb(345, 42, 74)).toEqual([217, 161, 175]);
    expect(hslToRgb(-15, 42, 74)).toEqual(hslToRgb(345, 42, 74));
    expect(hslToRgb(705, 42, 74)).toEqual(hslToRgb(345, 42, 74));
  });

  it("分量越界抛错", () => {
    expect(() => hslToRgb(0, 101, 50)).toThrow("越界");
    expect(() => hslToRgb(0, 50, -1)).toThrow("越界");
  });
});

describe("像素花瓣", () => {
  it("五种字模的尺寸", () => {
    const dims = Object.fromEntries(Object.entries(PETAL_GLYPHS).map(([k, g]) => [k, [g.width, g.height]]));
    expect(dims).toEqual({ P1: [7, 8], P2: [7, 7], P3: [7, 6], P4: [4, 4], P5: [3, 3] });
    for (const g of Object.values(PETAL_GLYPHS)) expect(g.cells).toHaveLength(g.width * g.height);
  });

  it("每片有且只有一个亮部像素（P4、P5 太小没有亮部），至少一个暗部像素", () => {
    const count = (name: PetalGlyphName, v: number) => PETAL_GLYPHS[name].cells.filter((c) => c === v).length;
    expect(["P1", "P2", "P3"].map((n) => count(n as PetalGlyphName, 2))).toEqual([1, 1, 1]);
    expect(["P4", "P5"].map((n) => count(n as PetalGlyphName, 2))).toEqual([0, 0]);
    for (const name of Object.keys(PETAL_GLYPHS) as PetalGlyphName[]) expect(count(name, 3)).toBeGreaterThan(0);
  });

  it("色调权重 0.40 / 0.35 / 0.25，按累计权重抽取", () => {
    expect(PETAL_TONES.light.weight + PETAL_TONES.mid.weight + PETAL_TONES.deep.weight).toBeCloseTo(1, 12);
    expect([0, 0.3999, 0.4, 0.7499, 0.75, 0.9999].map(pickPetalTone)).toEqual(["light", "light", "mid", "mid", "deep", "deep"]);
    expect(() => pickPetalTone(1)).toThrow();
    expect(() => pickPetalTone(-0.01)).toThrow();
    expect(() => pickPetalTone(Number.NaN)).toThrow();
  });

  it("色调取花瓣五阶：浅 1/0/2、中 2/1/3、深 3/2/4", () => {
    expect(PETAL_TONES.light).toMatchObject({ main: "petal-1", light: "petal-0", dark: "petal-2" });
    expect(PETAL_TONES.mid).toMatchObject({ main: "petal-2", light: "petal-1", dark: "petal-3" });
    expect(PETAL_TONES.deep).toMatchObject({ main: "petal-3", light: "petal-2", dark: "petal-4" });
  });

  it("镜像与 90° 旋转：形状仍在整数格上，四次旋转、两次镜像回到原样", () => {
    const p1 = PETAL_GLYPHS.P1;
    const turned = transformGlyph(p1, false, 90);
    expect([turned.width, turned.height]).toEqual([8, 7]);
    // 顺时针 90°：原左下角 (0, 7) 转到新左上角
    expect(turned.cells[0]).toBe(p1.cells[7 * 7 + 0]);
    expect(transformGlyph(transformGlyph(transformGlyph(turned, false, 90), false, 90), false, 90).cells).toEqual(p1.cells);
    const mirrored = transformGlyph(p1, true, 0);
    expect(mirrored.cells[0]).toBe(p1.cells[6]);
    expect(transformGlyph(mirrored, true, 0).cells).toEqual(p1.cells);
    expect(transformGlyph(p1, false, 180).cells).toEqual([...p1.cells].reverse());
  });

  it("每种颜色一条 1 × 1 方格路径，格子数与字模一致", () => {
    const p2 = PETAL_GLYPHS.P2;
    const squares = (d: string) => (d.match(/h1v1h-1Z/g) ?? []).length;
    expect(squares(glyphPath(p2, 1))).toBe(p2.cells.filter((c) => c === 1).length);
    expect(glyphPath(p2, 2)).toBe("M2 2h1v1h-1Z");
  });
});

describe("空状态图几何", () => {
  it("N = 96：底圆 (48, 52) r 40，字形 56 左上 (20, 24) 描边 0.96，花瓣 A (70, 14)、B (16, 74)", () => {
    const g = emptyArtGeometry(96);
    expect(g.circle).toEqual({ cx: 48, cy: 52, r: 40 });
    expect(g.glyph).toMatchObject({ x: 20, y: 24, size: 56 });
    expect(g.glyph.strokeWidth).toBeCloseTo(0.964, 3);
    expect(g.petalA).toEqual({ x: 70, y: 14 });
    expect(g.petalB).toEqual({ x: 16, y: 74 });
  });

  it("N = 64：底圆 (32, 35) r 27，字形 38 左上 (13, 16) 描边 1.26，花瓣 A (47, 9)、B (11, 49)", () => {
    const g = emptyArtGeometry(64);
    expect(g.circle).toEqual({ cx: 32, cy: 35, r: 27 });
    expect(g.glyph).toMatchObject({ x: 13, y: 16, size: 38 });
    expect(g.glyph.strokeWidth).toBeCloseTo(1.263, 3);
    expect(g.petalA).toEqual({ x: 47, y: 9 });
    expect(g.petalB).toEqual({ x: 11, y: 49 });
  });

  it("崩溃页 88 / 72：字形边长取偶数，渲染描边 2 px", () => {
    expect(emptyArtGeometry(88).glyph).toMatchObject({ size: 52, x: 18, y: 22 });
    expect(emptyArtGeometry(88).glyph.strokeWidth * 52).toBeCloseTo(48, 9);
    expect(emptyArtGeometry(72)).toMatchObject({ circle: { cx: 36, cy: 39, r: 30 }, glyph: { size: 42, x: 15, y: 18 } });
  });

  it("场景目录 15 个，每个都有可描边的字形；类别决定花瓣", () => {
    const scenes = Object.keys(EMPTY_SCENES) as EmptyScene[];
    expect(scenes).toHaveLength(15);
    for (const s of scenes) expect(sceneGlyphPath(s).length).toBeGreaterThan(10);
    expect(EMPTY_SCENES.error.category).toBe("error");
    expect(EMPTY_CATEGORIES.error).toEqual({ a: { glyph: "P2", tone: "deep" }, b: null });
    expect(EMPTY_CATEGORIES.empty.b).toEqual({ glyph: "P5", tone: "light" });
    expect(scenes.filter((s) => EMPTY_SCENES[s].category === "no-results")).toEqual(["telescope", "empty-branch", "search"]);
  });
});

describe("剪影", () => {
  it("头像 8 × 8：两行发、一行发与脸、眼在第 5 行第 3、6 列", () => {
    const hue = 200;
    const head = silhouetteHead(hue);
    const at = (x: number, y: number) => [...head.data.slice((y * 8 + x) * 4, (y * 8 + x) * 4 + 3)];
    expect(SILHOUETTE_HEAD[4]).toBe("FFEFFEFF");
    expect(at(0, 0)).toEqual([...hslToRgb(hue, 28, 46)]);
    expect(at(1, 2)).toEqual([...hslToRgb(hue, 40, 84)]);
    expect(at(2, 4)).toEqual([...hslToRgb(hue, 30, 30)]);
    expect(at(5, 4)).toEqual([...hslToRgb(hue, 30, 30)]);
    expect(head.data.filter((_, i) => i % 4 === 3).every((a) => a === 255)).toBe(true);
  });

  it("立绘 16 × 32：宽体型臂宽 4 撑满两侧；细体型两侧各空一列", () => {
    const alphaAt = (p: ReturnType<typeof silhouetteFigure>, x: number, y: number) => p.data[(y * 16 + x) * 4 + 3];
    const wide = silhouetteFigure(10, "wide");
    const slim = silhouetteFigure(10, "slim");
    expect([armWidth("wide"), armWidth("slim")]).toEqual([4, 3]);
    expect([alphaAt(wide, 0, 10), alphaAt(wide, 15, 10)]).toEqual([255, 255]);
    expect([alphaAt(slim, 0, 10), alphaAt(slim, 15, 10), alphaAt(slim, 1, 10), alphaAt(slim, 14, 10)]).toEqual([0, 0, 255, 255]);
    // 头部两侧、腿部两侧透明
    expect([alphaAt(wide, 3, 0), alphaAt(wide, 12, 0), alphaAt(wide, 3, 25), alphaAt(wide, 12, 25)]).toEqual([0, 0, 0, 0]);
    const rgbAt = (x: number, y: number) => [...wide.data.slice((y * 16 + x) * 4, (y * 16 + x) * 4 + 3)];
    expect(rgbAt(6, 12)).toEqual([...hslToRgb(10, 38, 64)]);
    expect(rgbAt(6, 25)).toEqual([...hslToRgb(10, 30, 50)]);
    expect(rgbAt(1, 12)).toEqual([...hslToRgb(10, 40, 84)]);
  });
});

describe("封面花瓣散布", () => {
  it("同一实例永远同一散布；字模依次 P2–P5，坐标在 [16, 304) × [8, 72)", () => {
    expect(coverPetals("inst-1")).toEqual([
      { glyph: "P2", tone: "deep", x: 138, y: 35 },
      { glyph: "P3", tone: "light", x: 244, y: 38 },
      { glyph: "P4", tone: "light", x: 162, y: 67 },
      { glyph: "P5", tone: "mid", x: 277, y: 58 },
    ]);
    expect(coverPetals("周末生存")).toEqual(coverPetals("周末生存"));
    for (let i = 0; i < 200; i++) {
      for (const p of coverPetals(`seed-${i}-${Math.random()}`)) {
        expect(p.x >= 16 && p.x < 304 && Number.isInteger(p.x)).toBe(true);
        expect(p.y >= 8 && p.y < 72 && Number.isInteger(p.y)).toBe(true);
      }
    }
  });
});

describe("coverRect", () => {
  it("等比放大盖满，按焦点裁掉多余部分", () => {
    expect(coverRect(1024, 1024, 1920, 1080, 0.5, 0.46)).toEqual({ sx: 0, sy: (1024 - 576) * 0.46, sw: 1024, sh: 576 });
    expect(coverRect(400, 100, 100, 100)).toEqual({ sx: 150, sy: 0, sw: 100, sh: 100 });
    expect(coverRect(64, 64, 128, 128)).toEqual({ sx: 0, sy: 0, sw: 64, sh: 64 });
    expect(() => coverRect(0, 10, 10, 10)).toThrow("必须为正");
  });
});
