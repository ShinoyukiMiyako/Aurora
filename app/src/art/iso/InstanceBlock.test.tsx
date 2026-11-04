// @vitest-environment jsdom
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { NO_ART, setArtStatus } from "../../mc/art";
import { clearArtCache } from "../../mc/useArt";
import { render, stubMatchMedia, type Rendered } from "../../test/dom";
import { stubCanvas, type CanvasStub } from "../illustrations/test-canvas";
import { ASSEMBLY_TIMING, AssemblingBlock } from "./AssemblingBlock";
import { InstanceAvatarBase } from "./InstanceAvatarBase";
import { InstanceBlock } from "./InstanceBlock";

let view: Rendered | undefined;
let canvas: CanvasStub;
let fetchMock: ReturnType<typeof vi.fn>;
let textureSize = { width: 16, height: 16 };
let warn: MockInstance<typeof console.warn>;

beforeEach(() => {
  stubMatchMedia(false);
  canvas = stubCanvas();
  vi.stubGlobal("navigator", { userAgent: "Windows" });
  fetchMock = vi.fn(async (url: string) => ({ ok: true, status: 200, blob: async () => new Blob([url]) }));
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("createImageBitmap", vi.fn(async (blob: Blob) => ({ ...textureSize, url: await blob.text() })));
  warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  textureSize = { width: 16, height: 16 };
});

afterEach(() => {
  view?.unmount();
  view = undefined;
  setArtStatus(NO_ART);
  clearArtCache();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const settle = () => act(() => new Promise<void>((resolve) => setTimeout(resolve, 0)));
const block = () => view?.container.querySelector<HTMLElement>("[data-sk-art='iso']") as HTMLElement;

describe("InstanceBlock", () => {
  it("没有材质源：画实例徽记，不发请求；方框为 W × ceil(H)", async () => {
    view = render(<InstanceBlock instanceId="周末生存" cover={{ block: "grass_block", hue: 118, image: null }} width={64} />);
    await settle();
    expect(block().dataset.art).toBe("emblem");
    expect(block().style.width).toBe("64px");
    expect(block().style.height).toBe("72px");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("有材质源：取顶面与侧面，换成真材质；草方块顶面与侧面是两张图", async () => {
    setArtStatus({ source: { versionId: "1.21.1" }, panorama: false });
    view = render(<InstanceBlock instanceId="周末生存" cover={{ block: "grass_block", hue: 118, image: null }} width={32} />);
    expect(block().dataset.art).toBe("emblem");
    await settle();
    expect(fetchMock.mock.calls.map((c) => c[0]).sort()).toEqual([
      "http://petalfall-tex.localhost/art/block/grass_block_side.png?v=1.21.1",
      "http://petalfall-tex.localhost/art/block/grass_block_top.png?v=1.21.1",
    ]);
    expect(block().dataset.art).toBe("texture");
    // 三个面按左、右、顶画到 32 × 36 的设备像素画布上，每面 16 × 16
    const faces = canvas.draws.filter((d) => d.canvas.width === 32 && d.canvas.height === 36 && d.args.length === 8);
    // 前三次是首帧的徽记，后三次是真材质
    expect(faces).toHaveLength(6);
    expect(faces.slice(-3).map((d) => d.args.slice(0, 4).join(","))).toEqual(["0,0,16,16", "0,0,16,16", "0,0,16,16"]);
  });

  it("动画材质（16 × 48）当作方块材质，只读首帧 16 × 16", async () => {
    setArtStatus({ source: { versionId: "1.21.1" }, panorama: false });
    textureSize = { width: 16, height: 48 };
    view = render(<InstanceBlock instanceId="i0" cover={{ block: "prismarine_bricks", hue: 175, image: null }} width={20} />);
    await settle();
    expect(block().dataset.art).toBe("texture");
    const reads = canvas.draws.filter((d) => d.canvas.width === 16 && d.canvas.height === 16 && (d.source as { url?: string }).url !== undefined);
    expect(reads.map((d) => d.args.join(","))).toEqual(["0,0,16,16,0,0,16,16", "0,0,16,16,0,0,16,16"]);
  });

  it("宽不是 16 的材质回落徽记，并只记一次 warn", async () => {
    setArtStatus({ source: { versionId: "1.21.1" }, panorama: false });
    textureSize = { width: 32, height: 32 };
    view = render(<InstanceBlock instanceId="i1" cover={{ block: "blue_ice", hue: 205, image: null }} width={32} />);
    await settle();
    expect(block().dataset.art).toBe("emblem");
    view.rerender(<InstanceBlock instanceId="i1" cover={{ block: "blue_ice", hue: 205, image: null }} width={64} />);
    expect(warn.mock.calls.filter((c) => String(c[0]).includes("blue_ice")).length).toBe(1);
  });

  it("白名单外的封面显示徽记，不请求任何材质", async () => {
    setArtStatus({ source: { versionId: "1.21.1" }, panorama: false });
    view = render(<InstanceBlock instanceId="i2" cover={{ block: "diamond_block", hue: 180, image: null }} width={24} />);
    await settle();
    expect(block().dataset.art).toBe("emblem");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(warn.mock.calls.some((c) => String(c[0]).includes("diamond_block"))).toBe(true);
  });

  it("不允许的宽度直接抛错", () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(() => render(<InstanceBlock instanceId="i3" cover={{ block: "cherry_planks", hue: 345, image: null }} width={48 as never} />)).toThrow("不允许");
  });
});

describe("InstanceAvatarBase", () => {
  it.each([
    [24, 16, 7],
    [32, 20, 10],
    [40, 24, 12],
    [44, 28, 13],
    [56, 32, 17],
  ] as const)("边长 %d：方块宽 %d、圆角 %d", (size, blockWidth, radius) => {
    view = render(<InstanceAvatarBase instanceId="i" cover={{ block: "cherry_planks", hue: 345, image: null }} size={size} />);
    const avatar = view.container.firstElementChild as HTMLElement;
    expect(avatar.style.width).toBe(`${size}px`);
    expect(avatar.style.borderRadius).toBe(`${radius}px`);
    expect(avatar.style.getPropertyValue("--hue")).toBe("345");
    expect(avatar.dataset.base).toBe("hue");
    expect(block().style.width).toBe(`${blockWidth}px`);
    view.unmount();
    view = undefined;
  });

  it("中性底座、选中外环与叠加的状态层", () => {
    view = render(
      <InstanceAvatarBase instanceId="i" cover={{ block: "cherry_planks", hue: 345, image: null }} size={40} base="neutral" selected>
        <span data-testid="ring" />
      </InstanceAvatarBase>,
    );
    const avatar = view.container.firstElementChild as HTMLElement;
    expect(avatar.dataset.base).toBe("neutral");
    expect(avatar.dataset.selected).toBe("true");
    expect(avatar.querySelector("[data-testid='ring']")).not.toBeNull();
  });
});

describe("AssemblingBlock", () => {
  it("挂载时已落的面直接显示；落位数增加时逐面补齐，相邻两面隔一个落位间隔", () => {
    // 落位间隔由定时器与 performance.now 共同决定。用真实时间等「间隔之内」时，机器一忙定时器就晚到、
    // 下一个面已经落下；假时钟按毫秒推进，间隔前一刻与到点那一刻都能确定地看到
    vi.useFakeTimers();
    const advance = (ms: number) =>
      act(() => {
        vi.advanceTimersByTime(ms);
      });
    view = render(<AssemblingBlock instanceId="i" cover={{ block: "cherry_planks", hue: 345, image: null }} placed={1} />);
    const root = () => view?.container.firstElementChild as HTMLElement;
    expect(root().dataset.placed).toBe("1");
    expect(root().style.width).toBe("28px");
    expect(root().style.height).toBe("32px");
    expect(root().querySelectorAll("[data-face]").length).toBe(3);
    view.rerender(<AssemblingBlock instanceId="i" cover={{ block: "cherry_planks", hue: 345, image: null }} placed={3} />);
    // 挂载时已落的面不算一次落位，第一个新面不用等间隔
    expect(root().dataset.placed).toBe("1");
    advance(0);
    expect(root().dataset.placed).toBe("2");
    advance(ASSEMBLY_TIMING.stepGapMs - 1);
    expect(root().dataset.placed).toBe("2");
    advance(1);
    expect(root().dataset.placed).toBe("3");
    view.rerender(<AssemblingBlock instanceId="i" cover={{ block: "cherry_planks", hue: 345, image: null }} placed={0} />);
    expect(root().dataset.placed).toBe("0");
  });
});
