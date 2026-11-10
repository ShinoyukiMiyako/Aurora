// @vitest-environment jsdom
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { NO_ART, setArtStatus } from "../../mc/art";
import { catalogFromDto, setBlockCatalog, type CatalogBlockDto } from "../../mc/catalog";
import { clearArtCache } from "../../mc/useArt";
import { render, type Rendered } from "../../test/dom";
import type { InstanceCover } from "./covers";
import type { BlockSource } from "./render";
import { useBlockSource } from "./useBlockSource";

const ORIGIN = "http://petalfall-tex.localhost";
const IMAGE = `${ORIGIN}/cover/${"ab".repeat(20)}`;
const OTHER_IMAGE = `${ORIGIN}/cover/${"cd".repeat(20)}`;
const art = (path: string, version = "1.21.1") => `${ORIGIN}/art/${path}.png?v=${version}`;

let view: Rendered | undefined;
let fetchMock: ReturnType<typeof vi.fn>;
let missing: Set<string>;
/** 解码出的尺寸不是 16 × 16 的地址。 */
let sizes: Map<string, [number, number]>;
let warn: MockInstance<typeof console.warn>;
let last: BlockSource | null;

beforeEach(() => {
  vi.stubGlobal("navigator", { userAgent: "Windows" });
  missing = new Set();
  sizes = new Map();
  fetchMock = vi.fn(async (url: string) => ({ ok: !missing.has(url), status: missing.has(url) ? 404 : 200, blob: async () => new Blob([url]) }));
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal(
    "createImageBitmap",
    vi.fn(async (blob: Blob) => {
      const url = await blob.text();
      const [width, height] = sizes.get(url) ?? [16, 16];
      return { width, height, url };
    }),
  );
  warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  last = null;
});

afterEach(() => {
  view?.unmount();
  view = undefined;
  setArtStatus(NO_ART);
  setBlockCatalog(null);
  clearArtCache();
  vi.unstubAllGlobals();
});

function Probe({ cover }: { cover: InstanceCover | null }) {
  last = useBlockSource(cover);
  return null;
}

/** 取图、解码、再按结果取下一批图要几轮微任务，跑两轮把整条链走完。 */
const settle = async () => {
  for (let i = 0; i < 2; i++) await act(() => new Promise<void>((resolve) => setTimeout(resolve, 0)));
};

const urlOf = (bitmap: ImageBitmap | null) => (bitmap === null ? null : (bitmap as unknown as { url: string }).url);

function summary(source: BlockSource | null) {
  if (source === null) return null;
  return { key: source.key, top: urlOf(source.top), side: urlOf(source.side), front: urlOf(source.front), topTint: source.topTint, sideTint: source.sideTint };
}

const fetched = () => fetchMock.mock.calls.map((c) => String(c[0])).sort();

function block(id: string, extra: Partial<CatalogBlockDto> = {}): CatalogBlockDto {
  return { id, top: `block/${id}`, side: `block/${id}`, front: null, top_tint: null, side_tint: null, hue: 30, name_en: null, name_zh: null, ...extra };
}

function putCatalog(versionId: string, blocks: CatalogBlockDto[]) {
  setBlockCatalog(catalogFromDto({ version_id: versionId, blocks }));
}

const cover = (block: string, image: string | null = null): InstanceCover => ({ block, hue: 30, image });

const withSource = (versionId = "1.21.1") => setArtStatus({ source: { versionId }, panorama: false });

describe("useBlockSource：本机材质", () => {
  it("预设按预设表取面：草方块顶面与侧面两张图，顶面染色", async () => {
    withSource();
    view = render(<Probe cover={cover("grass_block")} />);
    expect(last).toBeNull();
    await settle();
    expect(summary(last)).toEqual({
      key: "block|1.21.1|grass_block",
      top: art("block/grass_block_top"),
      side: art("block/grass_block_side"),
      front: null,
      topTint: [124, 189, 107],
      sideTint: null,
    });
  });

  it("预设优先于目录：目录里同 id 的条目不改变预设的面与染色", async () => {
    withSource();
    putCatalog("1.21.1", [block("grass_block", { top: "block/dirt", side: "block/dirt", side_tint: [1, 2, 3] })]);
    view = render(<Probe cover={cover("grass_block")} />);
    await settle();
    expect(summary(last)).toMatchObject({ top: art("block/grass_block_top"), side: art("block/grass_block_side"), topTint: [124, 189, 107], sideTint: null });
    expect(fetched()).not.toContain(art("block/dirt"));
  });

  it("目录方块：有正面的取三张图并带正面", async () => {
    withSource();
    putCatalog("1.21.1", [block("furnace", { top: "block/furnace_top", side: "block/furnace_side", front: "block/furnace_front" })]);
    view = render(<Probe cover={cover("furnace")} />);
    await settle();
    expect(summary(last)).toEqual({
      key: "block|1.21.1|furnace",
      top: art("block/furnace_top"),
      side: art("block/furnace_side"),
      front: art("block/furnace_front"),
      topTint: null,
      sideTint: null,
    });
    expect(fetched()).toEqual([art("block/furnace_front"), art("block/furnace_side"), art("block/furnace_top")]);
  });

  it("目录方块：树叶带顶面与侧面染色，四面同一张图只取一次", async () => {
    withSource();
    putCatalog("1.21.1", [block("oak_leaves", { top_tint: [72, 181, 24], side_tint: [72, 181, 24] })]);
    view = render(<Probe cover={cover("oak_leaves")} />);
    await settle();
    expect(summary(last)).toEqual({ key: "block|1.21.1|oak_leaves", top: art("block/oak_leaves"), side: art("block/oak_leaves"), front: null, topTint: [72, 181, 24], sideTint: [72, 181, 24] });
    expect(fetched()).toEqual([art("block/oak_leaves")]);
  });

  it("有正面的方块正面读不到：整块算读不到", async () => {
    withSource();
    putCatalog("1.21.1", [block("furnace", { top: "block/furnace_top", side: "block/furnace_side", front: "block/furnace_front" })]);
    missing.add(art("block/furnace_front"));
    view = render(<Probe cover={cover("furnace")} />);
    await settle();
    expect(last).toBeNull();
  });

  it("目录出自别的材质源（新目录还没到）：非预设方块不取图、不警告", async () => {
    withSource("1.21.4");
    putCatalog("1.21.1", [block("oak_log", { top: "block/oak_log_top" })]);
    view = render(<Probe cover={cover("oak_log")} />);
    await settle();
    expect(last).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it("目录没载入：非预设方块不取图、不警告；预设照常", async () => {
    withSource();
    view = render(<Probe cover={cover("oak_log")} />);
    await settle();
    expect(last).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
    view.rerender(<Probe cover={cover("blue_ice")} />);
    await settle();
    expect(last?.key).toBe("block|1.21.1|blue_ice");
    expect(warn).not.toHaveBeenCalled();
  });

  it("不在预设也不在当前目录：不取图，同一个方块只警告一次", async () => {
    withSource();
    putCatalog("1.21.1", [block("oak_log")]);
    view = render(<Probe cover={cover("diamond_block")} />);
    await settle();
    view.rerender(<Probe cover={cover("diamond_block")} />);
    await settle();
    expect(last).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(warn.mock.calls.filter((c) => String(c[0]).includes("diamond_block"))).toHaveLength(1);
  });

  it("没有材质源：预设也不取图", async () => {
    view = render(<Probe cover={cover("cherry_planks")} />);
    await settle();
    expect(last).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("换材质源即换键：同一方块在两个版本下键不同", async () => {
    withSource("1.20.1");
    view = render(<Probe cover={cover("blue_ice")} />);
    await settle();
    expect(last?.key).toBe("block|1.20.1|blue_ice");
    act(() => withSource("1.21.1"));
    await settle();
    expect(last?.key).toBe("block|1.21.1|blue_ice");
    expect(urlOf(last?.side ?? null)).toBe(art("block/blue_ice", "1.21.1"));
  });

  it("cover 为 null：恒为 null，不发请求", async () => {
    withSource();
    view = render(<Probe cover={null} />);
    await settle();
    expect(last).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("useBlockSource：换来源时新图还在取", () => {
  /** 下一次取图挂起，返回放行函数。 */
  const holdNextFetch = () => {
    let release: (() => void) | undefined;
    fetchMock.mockImplementationOnce((url: string) => new Promise((resolve) => (release = () => resolve({ ok: !missing.has(url), status: missing.has(url) ? 404 : 200, blob: async () => new Blob([url]) }))));
    return () => {
      if (release === undefined) throw new Error("挂起的那次取图还没发出");
      release();
    };
  };

  it("换封面方块：新材质到之前先给上一份已就绪的（不落回 null 画徽记），到了再换", async () => {
    withSource();
    view = render(<Probe cover={cover("blue_ice")} />);
    await settle();
    expect(last?.key).toBe("block|1.21.1|blue_ice");

    const release = holdNextFetch();
    view.rerender(<Probe cover={cover("cherry_planks")} />);
    await settle();
    expect(fetched()).toContain(art("block/cherry_planks"));
    expect(summary(last)).toMatchObject({ key: "block|1.21.1|blue_ice", side: art("block/blue_ice") });

    release();
    await settle();
    expect(summary(last)).toMatchObject({ key: "block|1.21.1|cherry_planks", side: art("block/cherry_planks") });
  });

  it("新材质取不到：回落 null（画徽记），不一直留着旧的", async () => {
    withSource();
    view = render(<Probe cover={cover("blue_ice")} />);
    await settle();
    missing.add(art("block/cherry_planks"));
    const release = holdNextFetch();
    view.rerender(<Probe cover={cover("cherry_planks")} />);
    await settle();
    expect(last?.key).toBe("block|1.21.1|blue_ice");
    release();
    await settle();
    expect(last).toBeNull();
  });

  it("换图片：新图到之前先给旧图", async () => {
    view = render(<Probe cover={cover("cherry_planks", IMAGE)} />);
    await settle();
    const release = holdNextFetch();
    view.rerender(<Probe cover={cover("cherry_planks", OTHER_IMAGE)} />);
    await settle();
    expect(last?.key).toBe(`image|${IMAGE}`);
    release();
    await settle();
    expect(last?.key).toBe(`image|${OTHER_IMAGE}`);
  });

  it("新来源已有定论时直接换，不等：已缓存的立即给新的，cover 换成 null 立即为 null", async () => {
    withSource();
    view = render(<Probe cover={cover("blue_ice")} />);
    await settle();
    view.rerender(<Probe cover={cover("cherry_planks")} />);
    await settle();
    view.rerender(<Probe cover={cover("blue_ice")} />);
    expect(last?.key).toBe("block|1.21.1|blue_ice");
    view.rerender(<Probe cover={null} />);
    expect(last).toBeNull();
  });
});

describe("useBlockSource：玩家图片", () => {
  it("有图片时三面同一张、不染色，键是图片地址；不取方块材质", async () => {
    withSource();
    view = render(<Probe cover={cover("grass_block", IMAGE)} />);
    await settle();
    expect(summary(last)).toEqual({ key: `image|${IMAGE}`, top: IMAGE, side: IMAGE, front: null, topTint: null, sideTint: null });
    expect(fetched()).toEqual([IMAGE]);
  });

  it("图片不依赖本机材质源：没有材质源也画图片", async () => {
    view = render(<Probe cover={cover("cherry_planks", IMAGE)} />);
    await settle();
    expect(last?.key).toBe(`image|${IMAGE}`);
  });

  it("换图即换键", async () => {
    view = render(<Probe cover={cover("cherry_planks", IMAGE)} />);
    await settle();
    view.rerender(<Probe cover={cover("cherry_planks", OTHER_IMAGE)} />);
    await settle();
    expect(last?.key).toBe(`image|${OTHER_IMAGE}`);
  });

  it("图片还在取时为 null，也不取方块材质", async () => {
    withSource();
    let release: (() => void) | undefined;
    fetchMock.mockImplementationOnce((url: string) => new Promise((resolve) => (release = () => resolve({ ok: true, status: 200, blob: async () => new Blob([url]) }))));
    view = render(<Probe cover={cover("blue_ice", IMAGE)} />);
    await settle();
    expect(last).toBeNull();
    expect(fetched()).toEqual([IMAGE]);
    release?.();
    await settle();
    expect(last?.key).toBe(`image|${IMAGE}`);
    expect(fetched()).toEqual([IMAGE]);
  });

  it("图片读不到：回到方块 id 的材质", async () => {
    withSource();
    missing.add(IMAGE);
    view = render(<Probe cover={cover("blue_ice", IMAGE)} />);
    await settle();
    expect(summary(last)).toEqual({ key: "block|1.21.1|blue_ice", top: art("block/blue_ice"), side: art("block/blue_ice"), front: null, topTint: null, sideTint: null });
    expect(warn.mock.calls.some((c) => String(c[0]).includes(IMAGE))).toBe(true);
  });

  it("图片读不到、方块也读不到：为 null（画徽记）", async () => {
    missing.add(IMAGE);
    view = render(<Probe cover={cover("blue_ice", IMAGE)} />);
    await settle();
    expect(last).toBeNull();
    expect(fetched()).toEqual([IMAGE]);
  });

  it("图片取到了但尺寸不合规（手放或损坏的文件）：按读不到处理，回到方块 id 的材质，同一张图只警告一次", async () => {
    // 警告记录是模块级的、跨用例保留：用一张别的用例没用过的图
    const odd = `${ORIGIN}/cover/${"ef".repeat(20)}`;
    sizes.set(odd, [24, 24]);
    withSource();
    view = render(<Probe cover={cover("blue_ice", odd)} />);
    await settle();
    expect(summary(last)).toEqual({ key: "block|1.21.1|blue_ice", top: art("block/blue_ice"), side: art("block/blue_ice"), front: null, topTint: null, sideTint: null });
    expect(fetched()).toEqual([art("block/blue_ice"), odd]);

    view.rerender(<Probe cover={cover("blue_ice", odd)} />);
    await settle();
    expect(last?.key).toBe("block|1.21.1|blue_ice");
    const warned = warn.mock.calls.filter((c) => String(c[0]).includes(odd));
    expect(warned).toHaveLength(1);
    expect(String(warned[0][0])).toContain("24x24");
  });

  it("图片尺寸不合规、方块也读不到：为 null（画徽记）", async () => {
    const odd = `${ORIGIN}/cover/${"12".repeat(20)}`;
    sizes.set(odd, [16, 20]);
    view = render(<Probe cover={cover("blue_ice", odd)} />);
    await settle();
    expect(last).toBeNull();
    expect(fetched()).toEqual([odd]);
  });

  it("竖排动画帧的图片（宽 16、高为 16 的整数倍）与方块材质同样合规，照常用图片", async () => {
    sizes.set(IMAGE, [16, 32]);
    withSource();
    view = render(<Probe cover={cover("blue_ice", IMAGE)} />);
    await settle();
    expect(last?.key).toBe(`image|${IMAGE}`);
    expect(fetched()).toEqual([IMAGE]);
  });
});
