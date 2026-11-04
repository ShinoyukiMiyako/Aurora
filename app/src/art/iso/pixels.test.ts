import { describe, expect, it } from "vitest";
import { hslToRgb } from "../illustrations/color";
import type { Pixels } from "../illustrations/canvas";
import { COVER_PRESETS, coverPreset, DEFAULT_COVER, defaultModpackCover } from "./covers";
import { emblemPixels, resampleArea, shadePixels, tintPixels, validTextureSize } from "./pixels";
import { emblemFaces, LruCache, prepareFaces } from "./render";

function solid(width: number, height: number, rgba: [number, number, number, number]): Pixels {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < data.length; i += 4) data.set(rgba, i);
  return { width, height, data };
}

const px = (p: Pixels, x: number, y: number) => [...p.data.slice((y * p.width + x) * 4, (y * p.width + x) * 4 + 4)];

describe("染色与明暗", () => {
  it("染色为 rgb × tint / 255，alpha 不变", () => {
    const out = tintPixels(solid(2, 2, [200, 100, 255, 128]), [124, 189, 107]);
    expect(px(out, 1, 1)).toEqual([Math.round((200 * 124) / 255), Math.round((100 * 189) / 255), 107, 128]);
  });

  it("三个面的明暗 1.0 / 0.8 / 0.6，透明像素保持透明", () => {
    const side = solid(16, 16, [250, 120, 60, 255]);
    side.data.set([10, 20, 30, 0], 0);
    const faces = prepareFaces(solid(16, 16, [100, 100, 100, 255]), side, null, 16);
    expect(px(faces.top, 3, 3)).toEqual([100, 100, 100, 255]);
    expect(px(faces.left, 3, 3)).toEqual([200, 96, 48, 255]);
    expect(px(faces.right, 3, 3)).toEqual([150, 72, 36, 255]);
    expect(px(faces.left, 0, 0)[3]).toBe(0);
    expect(() => shadePixels(side, 1.2)).toThrow("明暗系数");
  });

  it("只有给了顶面染色时才染顶面，侧面从不染", () => {
    const gray = solid(16, 16, [255, 255, 255, 255]);
    const faces = prepareFaces(gray, gray, [124, 189, 107], 16);
    expect(px(faces.top, 0, 0)).toEqual([124, 189, 107, 255]);
    expect(px(faces.left, 0, 0)).toEqual([204, 204, 204, 255]);
  });
});

describe("面积平均重采样", () => {
  it("纯色缩小后颜色不变", () => {
    for (const size of [6, 8, 13, 15]) {
      const out = resampleArea(solid(16, 16, [37, 140, 222, 255]), size);
      expect(out.width).toBe(size);
      for (const [x, y] of [
        [0, 0],
        [size - 1, size - 1],
      ]) expect(px(out, x, y)).toEqual([37, 140, 222, 255]);
    }
  });

  it("在线性光下平均：黑白各半得到 188 而不是 sRGB 直接平均的 128", () => {
    const source = solid(16, 16, [0, 0, 0, 255]);
    for (let y = 0; y < 16; y++) for (let x = 8; x < 16; x++) source.data.set([255, 255, 255, 255], (y * 16 + x) * 4);
    expect(px(resampleArea(source, 1), 0, 0)).toEqual([188, 188, 188, 255]);
  });

  it("按 alpha 加权：一半透明一半红色时颜色仍是纯红，alpha 为一半", () => {
    const source = solid(16, 16, [0, 0, 0, 0]);
    for (let y = 0; y < 16; y++) for (let x = 0; x < 8; x++) source.data.set([255, 0, 0, 255], (y * 16 + x) * 4);
    expect(px(resampleArea(source, 1), 0, 0)).toEqual([255, 0, 0, 128]);
    // 16 -> 8：每个目标像素恰好覆盖 2×2 源像素，左半全红、右半全透明
    const half = resampleArea(source, 8);
    expect(px(half, 3, 5)).toEqual([255, 0, 0, 255]);
    expect(px(half, 4, 5)).toEqual([0, 0, 0, 0]);
  });

  it("非整数比例按覆盖面积分配：16 -> 10 时跨界像素按 0.4 / 0.6 混合", () => {
    // 第 1 列（x ∈ [1.6, 3.2)）覆盖源像素 1 的 0.4、2 的 1.0、3 的 0.2；只有源像素 2 不透明
    const source = solid(16, 16, [0, 0, 0, 0]);
    for (let y = 0; y < 16; y++) source.data.set([0, 255, 0, 255], (y * 16 + 2) * 4);
    const out = resampleArea(source, 10);
    expect(px(out, 1, 0)).toEqual([0, 255, 0, Math.round((1 / 1.6) * 255)]);
    expect(px(out, 0, 0)[3]).toBe(0);
  });

  it("非方形或放大的目标直接抛错", () => {
    expect(() => resampleArea(solid(16, 32, [0, 0, 0, 255]), 8)).toThrow("方形");
    expect(() => resampleArea(solid(16, 16, [0, 0, 0, 255]), 20)).toThrow("不合法");
    expect(() => resampleArea(solid(16, 16, [0, 0, 0, 255]), 0)).toThrow("不合法");
  });
});

describe("材质尺寸", () => {
  it("宽 16、高为 16 的整数倍（动画帧）才是方块材质", () => {
    expect(validTextureSize(16, 16)).toBe(true);
    expect(validTextureSize(16, 512)).toBe(true);
    expect(validTextureSize(16, 24)).toBe(false);
    expect(validTextureSize(32, 32)).toBe(false);
    expect(validTextureSize(16, 8)).toBe(false);
  });
});

describe("实例徽记", () => {
  it("同一实例永远同一张纹理；每像素只取 hsl(H 42% 70/74/78%) 三色之一", () => {
    const a = emblemPixels("周末生存", 118, 16);
    const b = emblemPixels("周末生存", 118, 16);
    expect(a.data).toEqual(b.data);
    const allowed = new Set([70, 74, 78].map((l) => hslToRgb(118, 42, l).join(",")));
    const seen = new Set<string>();
    for (let i = 0; i < a.data.length; i += 4) {
      const key = `${a.data[i]},${a.data[i + 1]},${a.data[i + 2]}`;
      expect(allowed.has(key)).toBe(true);
      expect(a.data[i + 3]).toBe(255);
      seen.add(key);
    }
    expect(seen.size).toBe(3);
  });

  it("不同实例的纹理不同；色相只改颜色不改图案", () => {
    const a = emblemPixels("inst-a", 200, 16);
    const b = emblemPixels("inst-b", 200, 16);
    expect(a.data).not.toEqual(b.data);
    const levelsOf = (p: Pixels, hue: number) => {
      const lut = new Map([70, 74, 78].map((l) => [hslToRgb(hue, 42, l).join(","), l]));
      const out: number[] = [];
      for (let i = 0; i < p.data.length; i += 4) out.push(lut.get(`${p.data[i]},${p.data[i + 1]},${p.data[i + 2]}`) as number);
      return out;
    };
    expect(levelsOf(emblemPixels("inst-a", 10, 16), 10)).toEqual(levelsOf(a, 200));
  });

  it("小尺寸档直接生成 n × n，三面只差明暗", () => {
    const faces = emblemFaces("inst-a", 345, 10);
    expect(faces.top.width).toBe(10);
    const top = px(faces.top, 4, 4);
    expect(px(faces.left, 4, 4).slice(0, 3)).toEqual(top.slice(0, 3).map((c) => Math.round(c * 0.8)));
    expect(px(faces.right, 4, 4).slice(0, 3)).toEqual(top.slice(0, 3).map((c) => Math.round(c * 0.6)));
  });
});

describe("LruCache", () => {
  it("超出上限丢最久未用的一项；读取会刷新顺序", () => {
    const cache = new LruCache<string, number>(3);
    cache.set("a", 1);
    cache.set("b", 2);
    cache.set("c", 3);
    expect(cache.get("a")).toBe(1);
    cache.set("d", 4);
    expect(cache.get("b")).toBeUndefined();
    expect(cache.keys()).toEqual(["c", "a", "d"]);
    cache.set("c", 30);
    cache.set("e", 5);
    expect(cache.keys()).toEqual(["d", "c", "e"]);
    expect(cache.size).toBe(3);
    expect(() => new LruCache(0)).toThrow("上限");
  });
});

describe("封面预设", () => {
  it("16 块，默认樱花木板；按 id 查找，白名单外为 undefined", () => {
    expect(COVER_PRESETS).toHaveLength(16);
    expect(DEFAULT_COVER).toEqual({ block: "cherry_planks", hue: 345, image: null });
    expect(coverPreset("purpur_block")).toEqual({ block: "purpur_block", hue: 290, image: null });
    expect(coverPreset("block/purpur_block")).toBeUndefined();
  });

  it("整合包默认封面取第 fnv1a32(项目 id) mod 16 项", () => {
    // fnv1a32("a") = 3826002220，mod 16 = 12 -> 蓝冰
    expect(defaultModpackCover("a")).toEqual({ block: "blue_ice", hue: 205, image: null });
    // fnv1a32("foobar") = 3214735720，mod 16 = 8 -> 深板岩瓦
    expect(defaultModpackCover("foobar")).toEqual({ block: "deepslate_tiles", hue: 210, image: null });
  });
});
