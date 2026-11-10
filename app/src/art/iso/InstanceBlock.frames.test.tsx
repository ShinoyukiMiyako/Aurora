// @vitest-environment jsdom
// 实例方块里要等动画真正播完的用例。整个文件走真实时间：换图留下的退场层要等 framer-motion 的帧循环把淡出播完才移除，
// 假定时器下帧循环一旦有一帧没到就停在原地，同一文件里之后的用例也再推不动它，
// 所以不和 InstanceBlock.test 里那些假定时器用例（组装中的方块）放在一起，不靠用例的先后顺序过。
import { act } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { NO_ART, setArtStatus } from "../../mc/art";
import { setBlockCatalog } from "../../mc/catalog";
import { clearArtCache } from "../../mc/useArt";
import { render, stubMatchMedia, waitForFrames, type Rendered } from "../../test/dom";
import { stubCanvas } from "../illustrations/test-canvas";
import { InstanceBlock } from "./InstanceBlock";

let view: Rendered | undefined;

beforeEach(() => {
  stubMatchMedia(false);
  stubCanvas();
  vi.stubGlobal("navigator", { userAgent: "Windows" });
  vi.stubGlobal("fetch", vi.fn(async (url: string) => ({ ok: true, status: 200, blob: async () => new Blob([url]) })));
  vi.stubGlobal("createImageBitmap", vi.fn(async (blob: Blob) => ({ width: 16, height: 16, url: await blob.text() })));
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

afterEach(() => {
  view?.unmount();
  view = undefined;
  setArtStatus(NO_ART);
  setBlockCatalog(null);
  clearArtCache();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const settle = () => act(() => new Promise<void>((resolve) => setTimeout(resolve, 0)));
const block = () => view?.container.querySelector<HTMLElement>("[data-sk-art='iso']") as HTMLElement;

it("换了来源（两张材质都已缓存、不经徽记直接换）：旧图淡出、新图淡入，两层叠放交叉", async () => {
  setArtStatus({ source: { versionId: "1.21.1" }, panorama: false });
  const at = (block: string) => <InstanceBlock instanceId="i6" cover={{ block, hue: 0, image: null }} width={32} />;
  // 先各取一次，两种方块的材质都进缓存；等换图留下的退场层走完
  view = render(at("cherry_planks"));
  await settle();
  view.rerender(at("mossy_cobblestone"));
  await settle();
  expect(block().dataset.art).toBe("texture");
  await waitForFrames(() => expect(block().children).toHaveLength(2));

  view.rerender(at("cherry_planks"));
  expect(block().dataset.art).toBe("texture");
  // 回落件一层 + 正在淡出的旧图 + 正在淡入的新图
  expect(block().children).toHaveLength(3);
});

it("换封面方块、新材质还在取：留着旧材质，不先落回徽记；新材质到了直接与旧材质交叉", async () => {
  setArtStatus({ source: { versionId: "1.21.1" }, panorama: false });
  const at = (block: string) => <InstanceBlock instanceId="i7" cover={{ block, hue: 0, image: null }} width={32} />;
  view = render(at("cherry_planks"));
  await settle();
  const layers = () => [...block().children] as HTMLElement[];
  // 旧材质完全淡入、回落件完全淡出：之后谁在离场一眼看得出
  await waitForFrames(() => expect(layers().map((l) => l.style.opacity)).toEqual(["0", "1"]));

  let release: (() => void) | undefined;
  vi.mocked(fetch).mockImplementationOnce((url) => new Promise((resolve) => (release = () => resolve({ ok: true, status: 200, blob: async () => new Blob([String(url)]) } as Response))));
  view.rerender(at("mossy_cobblestone"));
  await settle();
  // 还是材质，不是徽记；旧材质那一层原样留着，没有离场
  expect(block().dataset.art).toBe("texture");
  expect(layers().map((l) => l.style.opacity)).toEqual(["0", "1"]);

  if (release === undefined) throw new Error("新材质的取图还没发出");
  release();
  await settle();
  // 回落件一层 + 正在淡出的旧材质 + 正在淡入的新材质：回落件始终没有回来
  expect(layers()).toHaveLength(3);
  expect(layers()[0].style.opacity).toBe("0");
});
