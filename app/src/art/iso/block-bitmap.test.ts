// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { stubCanvas, type CanvasStub } from "../illustrations/test-canvas";
import { isoLayout } from "./geometry";
import { blockBitmap, type BlockSource } from "./render";

let canvas: CanvasStub;
let warn: MockInstance<typeof console.warn>;

beforeEach(() => {
  canvas = stubCanvas();
  warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const bitmap = (name: string, width = 16, height = 16) => ({ name, width, height }) as unknown as ImageBitmap;

function source(key: string, extra: Partial<BlockSource> = {}): BlockSource {
  return { key, top: bitmap(`${key}:top`), side: bitmap(`${key}:side`), front: null, topTint: null, sideTint: null, ...extra };
}

/** 这个来源的面被读了几次：每画一张新位图就读一遍面，命中缓存则不读。 */
const readsOf = (s: BlockSource) => canvas.draws.filter((d) => d.source === s.top || d.source === s.side || (s.front !== null && d.source === s.front)).length;

const layout = isoLayout(32);

describe("blockBitmap 的缓存键", () => {
  it("同一来源键命中缓存，同一张位图、不再读面；换宽度或 dpr 另画一张", () => {
    const a = source("block|1.21.1|oak_log");
    const first = blockBitmap(a, layout, 1);
    expect(readsOf(a)).toBe(2);
    expect(blockBitmap(a, layout, 1)).toBe(first);
    // 键相同而位图不同：仍命中缓存，说明缓存只认键，键必须足以区分来源
    const same = source("block|1.21.1|oak_log");
    expect(blockBitmap(same, layout, 1)).toBe(first);
    expect(readsOf(same)).toBe(0);
    expect(blockBitmap(a, layout, 2)).not.toBe(first);
    expect(blockBitmap(a, isoLayout(20), 1)).not.toBe(first);
  });

  it("材质源版本、方块与图片地址不同，键就不同，各画各的", () => {
    const keys = ["block|1.21.1|birch_log", "block|1.20.1|birch_log", "block|1.21.1|spruce_log", "image|http://petalfall-tex.localhost/cover/a", "image|http://petalfall-tex.localhost/cover/b"];
    const bitmaps = keys.map((key) => blockBitmap(source(key), layout, 1));
    expect(new Set(bitmaps).size).toBe(keys.length);
  });

  it("有正面时三张面都读，只取首帧 16 × 16", () => {
    const furnace = source("block|1.21.1|furnace", { front: bitmap("front") });
    expect(blockBitmap(furnace, layout, 1)).not.toBeNull();
    const fronts = canvas.draws.filter((d) => d.source === furnace.front);
    expect(fronts.map((d) => d.args.join(","))).toEqual(["0,0,16,16,0,0,16,16"]);
    expect(readsOf(furnace)).toBe(3);
  });

  it("正面尺寸不合规：回落 null 并只记一次 warn，警告里有来源键与面名", () => {
    const bad = source("block|1.21.1|dispenser", { front: bitmap("front", 32, 32) });
    expect(blockBitmap(bad, layout, 1)).toBeNull();
    expect(blockBitmap(bad, isoLayout(20), 1)).toBeNull();
    const warned = warn.mock.calls.filter((c) => String(c[0]).includes("block|1.21.1|dispenser"));
    expect(warned).toHaveLength(1);
    expect(String(warned[0][0])).toContain("正面");
    expect(String(warned[0][0])).toContain("32x32");
  });
});
