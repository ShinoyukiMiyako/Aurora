// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { FONT_SPECS, LATIN_EXT_RANGE, loadFonts, MONO_FAMILY, MONO_LATIN_RANGE, OUTFIT_FAMILY, OUTFIT_LATIN_RANGE } from "./fonts";

/** 把 unicode-range 展开成码位集合。 */
function codePoints(range: string): Set<number> {
  const set = new Set<number>();
  for (const part of range.split(",").map((s) => s.trim())) {
    const m = part.match(/^U\+([0-9A-F]+)(?:-([0-9A-F]+))?$/i);
    if (!m) throw new Error(`无法解析 ${part}`);
    const from = parseInt(m[1], 16);
    const to = m[2] ? parseInt(m[2], 16) : from;
    for (let cp = from; cp <= to; cp++) set.add(cp);
  }
  return set;
}

const CJK_PUNCTUATION = [0x2014, 0x2015, 0x2018, 0x2019, 0x201a, 0x201b, 0x201c, 0x201d, 0x201e, 0x201f, 0x2026];

describe("字体子集范围", () => {
  it("Outfit 的 latin 子集恰好比字体包原值少中文用的破折号、引号与省略号", () => {
    const original = codePoints(MONO_LATIN_RANGE);
    const outfit = codePoints(OUTFIT_LATIN_RANGE);
    const removed = [...original].filter((cp) => !outfit.has(cp)).sort((a, b) => a - b);
    expect(removed).toEqual(CJK_PUNCTUATION);
    expect([...outfit].every((cp) => original.has(cp))).toBe(true);
  });

  it("中文间隔号与西文连字符仍由 Outfit 负责", () => {
    const outfit = codePoints(OUTFIT_LATIN_RANGE);
    for (const cp of [0x00b7, 0x2013, 0x2016, 0x2027, 0x0041]) expect(outfit.has(cp)).toBe(true);
  });

  it("两款字体各两个子集，不带 cyrillic、greek、vietnamese", () => {
    expect(FONT_SPECS.map((s) => [s.family, s.weight])).toEqual([
      [OUTFIT_FAMILY, "100 900"],
      [OUTFIT_FAMILY, "100 900"],
      [MONO_FAMILY, "100 800"],
      [MONO_FAMILY, "100 800"],
    ]);
    const all = new Set(FONT_SPECS.flatMap((s) => [...codePoints(s.unicodeRange)]));
    for (const cp of [0x0410, 0x03b1, 0x1ea0]) expect(all.has(cp)).toBe(false);
    expect(FONT_SPECS.filter((s) => s.unicodeRange === LATIN_EXT_RANGE)).toHaveLength(2);
    for (const spec of FONT_SPECS) expect(spec.url).toMatch(/\.woff2$/);
  });
});

describe("loadFonts", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function stubFonts(failOn?: string) {
    const added: { family: string; source: string; descriptors: FontFaceDescriptors }[] = [];
    const loaded: string[] = [];
    class FakeFontFace {
      constructor(
        readonly family: string,
        readonly source: string,
        readonly descriptors: FontFaceDescriptors,
      ) {}
      load() {
        if (this.descriptors.unicodeRange === failOn) return Promise.reject(new Error(`字体加载失败：${this.family}`));
        loaded.push(`${this.family}|${this.descriptors.unicodeRange}`);
        return Promise.resolve(this);
      }
    }
    vi.stubGlobal("FontFace", FakeFontFace);
    Object.defineProperty(document, "fonts", { configurable: true, value: { add: (face: FakeFontFace) => added.push(face) } });
    return { added, loaded };
  }

  it("四个字面全部注册并等到加载完成", async () => {
    const { added, loaded } = stubFonts();
    await loadFonts();
    expect(added.map((f) => f.family)).toEqual([OUTFIT_FAMILY, OUTFIT_FAMILY, MONO_FAMILY, MONO_FAMILY]);
    expect(added[0].descriptors).toEqual({ weight: "100 900", style: "normal", display: "swap", unicodeRange: OUTFIT_LATIN_RANGE });
    expect(added[0].source).toMatch(/^url\(.+\.woff2\) format\("woff2"\)$/);
    expect(loaded).toHaveLength(4);
  });

  it("任一字面加载失败时整体失败，交给启动流程显示错误页", async () => {
    stubFonts(MONO_LATIN_RANGE);
    await expect(loadFonts()).rejects.toThrow(`字体加载失败：${MONO_FAMILY}`);
  });
});
