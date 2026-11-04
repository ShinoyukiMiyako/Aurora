// @vitest-environment jsdom
import { MotionConfig } from "framer-motion";
import { act, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { stubCanvas, type CanvasStub } from "../art/illustrations/test-canvas";
import type { BlockSource } from "../art/iso/render";
import { useBlockSource } from "../art/iso/useBlockSource";
import { render, setRect, stubMatchMedia, stubResizeObserver, type ResizeObserverStub, type Rendered } from "../test/dom";
import { Cover, coverIdentityWidth } from "./Cover";
import { RemoteImageProvider } from "./remote-image";

vi.mock("../art/iso/useBlockSource", () => ({ useBlockSource: vi.fn() }));

let view: Rendered | undefined;
let canvas: CanvasStub;
let resize: ResizeObserverStub;
let observers: { callback: IntersectionObserverCallback; targets: Element[] }[];
let frames: FrameRequestCallback[];
let warn: MockInstance<typeof console.warn>;

beforeEach(() => {
  stubMatchMedia(false);
  canvas = stubCanvas();
  resize = stubResizeObserver();
  observers = [];
  frames = [];
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      private entry: (typeof observers)[number];
      constructor(callback: IntersectionObserverCallback) {
        this.entry = { callback, targets: [] };
        observers.push(this.entry);
      }
      observe(el: Element) {
        this.entry.targets.push(el);
      }
      disconnect() {
        this.entry.targets = [];
      }
    },
  );
  vi.stubGlobal("fetch", vi.fn(async (url: string) => ({ ok: true, status: 200, blob: async () => new Blob([url]) })));
  vi.stubGlobal("createImageBitmap", vi.fn(async () => ({ width: 1600, height: 900, close: vi.fn() })));
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => frames.push(cb));
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
  // 模块替身的调用记录跨用例累积，每例从空记录开始
  vi.mocked(useBlockSource).mockReset().mockReturnValue(null);
  warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

afterEach(() => {
  view?.unmount();
  view = undefined;
  vi.unstubAllGlobals();
});

const settle = () => act(() => new Promise<void>((resolve) => setTimeout(resolve, 0)));
const cover = () => view?.container.querySelector<HTMLElement>("[data-source]") as HTMLElement;
const CHERRY = { block: "cherry_planks", hue: 345, image: null };

/** 平铺用的方块来源：侧面 16 × 16。 */
function source(key: string, size = 16): BlockSource {
  const bitmap = { width: 16, height: size } as ImageBitmap;
  return { key, top: bitmap, side: bitmap, front: null, topTint: null, sideTint: null };
}

/** 平铺层的 <canvas>：媒体层里带内联尺寸的那张（远程图的画布不带，身份方块的画布不在媒体层里）。 */
const tileCanvas = () => cover().querySelector<HTMLCanvasElement>(":scope > div > canvas[style]");

function intersect() {
  act(() => {
    for (const o of observers) for (const target of o.targets) o.callback([{ isIntersecting: true, target } as IntersectionObserverEntry], {} as IntersectionObserver);
  });
}

function runFrames() {
  act(() => {
    for (const frame of frames.splice(0)) frame(0);
  });
}

function pointer(target: Element, type: "pointermove" | "pointerover", clientX: number, clientY: number) {
  act(() => {
    target.dispatchEvent(new PointerEvent(type, { bubbles: true, clientX, clientY }));
  });
}

const shift = () => [cover().style.getPropertyValue("--tile-x"), cover().style.getPropertyValue("--tile-y")];

describe("coverIdentityWidth", () => {
  it("W = 32 × floor(高 × 0.5 / 32)，最小 32、最大 128", () => {
    expect([40, 62, 64, 127, 128, 132, 200, 256, 400].map(coverIdentityWidth)).toEqual([32, 32, 32, 32, 64, 64, 96, 128, 128]);
  });
});

describe("Cover", () => {
  it("art 形态：色相渐变底 + 底纹 4 片花瓣 + 右侧身份方块；高度由页面给定", () => {
    view = render(
      <Cover hue={345} seed="inst-1" height={132} identity={{ instanceId: "inst-1", cover: { block: "cherry_planks", hue: 345, image: null } }}>
        <h2>周末生存</h2>
      </Cover>,
    );
    expect(cover().dataset.source).toBe("art");
    expect(cover().style.height).toBe("132px");
    expect(cover().style.getPropertyValue("--hue")).toBe("345");
    expect(cover().querySelectorAll("svg[data-glyph]")).toHaveLength(4);
    expect(cover().querySelector<HTMLElement>("[data-sk-art='iso']")?.style.width).toBe("64px");
    expect(cover().querySelector("h2")?.textContent).toBe("周末生存");
  });

  it("没有远程图时不需要解析函数；底纹花瓣按种子固定", () => {
    view = render(<Cover hue={120} seed="inst-1" height={62} />);
    const left = [...cover().querySelectorAll<SVGElement>("svg[data-glyph]")].map((p) => p.style.getPropertyValue("--px"));
    expect(left).toEqual(["138", "244", "162", "277"]);
  });

  it("art 形态不加压暗：shade 只对媒体生效", () => {
    view = render(<Cover hue={120} seed="inst-1" height={62} shade="left" />);
    expect(cover().dataset.source).toBe("art");
    expect(cover().dataset.shade).toBeUndefined();
  });

  it("remote 形态：量出宽度并进入视口后才加载；加载完换成远程图、加压暗，不再画身份方块", async () => {
    const resolve = vi.fn(async (url: string) => url);
    view = render(
      <RemoteImageProvider resolve={resolve}>
        <Cover hue={20} seed="p" height={180} remoteUrl="https://cdn.modrinth.com/gallery/a.png" shade="bottom" identity={{ instanceId: "i", cover: { block: "red_wool", hue: 355, image: null } }} />
      </RemoteImageProvider>,
    );
    intersect();
    await settle();
    expect(resolve).not.toHaveBeenCalled();
    expect(cover().dataset.source).toBe("art");

    resize.resize(cover(), 320);
    await settle();
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(cover().dataset.source).toBe("remote");
    expect(cover().dataset.shade).toBe("bottom");
    expect(cover().querySelector("[data-sk-art='iso']")).toBeNull();
    // 1600 × 900 的图按 cover 裁进 320 × 180：等比例刚好盖满
    expect(canvas.draws.at(-1)?.args).toEqual([0, 0, 1600, 900, 0, 0, 320, 180]);
  });

  it("remote 读不到、又没有平铺：回落 art，不加压暗", async () => {
    view = render(
      <RemoteImageProvider resolve={async () => Promise.reject(new Error("离线"))}>
        <Cover hue={20} seed="p" height={180} remoteUrl="https://cdn.modrinth.com/gallery/a.png" shade="bottom" />
      </RemoteImageProvider>,
    );
    intersect();
    resize.resize(cover(), 320);
    await settle();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(cover().dataset.source).toBe("art");
    expect(cover().dataset.shade).toBeUndefined();
  });

  it("texture 形态：侧面材质每像素 8 css px 平铺满四周各大出 12 px 的画布，按媒体加压暗，身份方块照画", () => {
    vi.mocked(useBlockSource).mockReturnValue(source("block|1.21.1|cherry_planks"));
    view = render(<Cover hue={345} seed="inst-1" height={132} texture={CHERRY} shade="left" identity={{ instanceId: "inst-1", cover: CHERRY }} />);
    expect(vi.mocked(useBlockSource)).toHaveBeenCalledWith(CHERRY);
    expect(cover().dataset.source).toBe("texture");
    expect(cover().dataset.shade).toBe("left");
    expect(cover().querySelectorAll("svg[data-glyph]")).toHaveLength(0);
    expect(cover().querySelector("[data-sk-art='iso']")).not.toBeNull();
    // 宽度量出来之前不画平铺
    expect(tileCanvas()).toBeNull();

    resize.resize(cover(), 320);
    const tile = tileCanvas();
    expect([tile?.style.width, tile?.style.height]).toEqual(["344px", "156px"]);
    expect([tile?.width, tile?.height]).toEqual([344, 156]);
    // 一格 16 × 8 = 128 css px：344 × 156 铺 3 列 2 行
    expect(canvas.draws.filter((d) => d.canvas === tile).map((d) => d.args.join(","))).toEqual([
      "0,0,16,16,0,0,128,128",
      "0,0,16,16,128,0,128,128",
      "0,0,16,16,256,0,128,128",
      "0,0,16,16,0,128,128,128",
      "0,0,16,16,128,128,128,128",
      "0,0,16,16,256,128,128,128",
    ]);
  });

  it("texture 读不到材质：画 art 形态，不加压暗", () => {
    view = render(<Cover hue={345} seed="inst-1" height={132} texture={CHERRY} shade="left" />);
    expect(vi.mocked(useBlockSource)).toHaveBeenCalledWith(CHERRY);
    expect(cover().dataset.source).toBe("art");
    expect(cover().dataset.shade).toBeUndefined();
    expect(cover().querySelectorAll("svg[data-glyph]")).toHaveLength(4);
  });

  it("不平铺时不读材质：texture 缺省即 null", () => {
    view = render(<Cover hue={345} seed="inst-1" height={132} />);
    expect(vi.mocked(useBlockSource)).toHaveBeenCalledWith(null);
    expect(vi.mocked(useBlockSource)).not.toHaveBeenCalledWith(CHERRY);
  });

  it("侧面材质尺寸不对：画 art 形态并警告", () => {
    vi.mocked(useBlockSource).mockReturnValue(source("block|1.21.1|odd_block", 20));
    view = render(<Cover hue={345} seed="inst-1" height={132} texture={CHERRY} shade="left" />);
    expect(cover().dataset.source).toBe("art");
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain("16x20");
  });

  it("远程图与平铺同给：加载中显示平铺，加载完以远程图为准", async () => {
    vi.mocked(useBlockSource).mockReturnValue(source("block|1.21.1|grass_block"));
    let finish: (url: string) => void = () => {
      throw new Error("解析函数还没被调用");
    };
    const resolve = vi.fn(() => new Promise<string>((done) => (finish = done)));
    view = render(
      <RemoteImageProvider resolve={resolve}>
        <Cover hue={118} seed="i" height={132} remoteUrl="http://petalfall-tex.localhost/cover/abc" texture={CHERRY} shade="bottom" />
      </RemoteImageProvider>,
    );
    intersect();
    resize.resize(cover(), 320);
    await settle();
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(cover().dataset.source).toBe("texture");
    expect(cover().dataset.shade).toBe("bottom");

    finish("http://petalfall-tex.localhost/cover/abc");
    await settle();
    expect(cover().dataset.source).toBe("remote");
    expect(cover().dataset.shade).toBe("bottom");
  });

  it("远程图读不到、有平铺：回落平铺", async () => {
    vi.mocked(useBlockSource).mockReturnValue(source("block|1.21.1|blue_ice"));
    view = render(
      <RemoteImageProvider resolve={async () => Promise.reject(new Error("文件不见了"))}>
        <Cover hue={205} seed="i" height={132} remoteUrl="http://petalfall-tex.localhost/cover/gone" texture={CHERRY} shade="left" />
      </RemoteImageProvider>,
    );
    intersect();
    resize.resize(cover(), 320);
    await settle();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(cover().dataset.source).toBe("texture");
    expect(cover().dataset.shade).toBe("left");
  });
});

describe("Cover 平铺视差", () => {
  function mountInHost(children: ReactNode = <Cover hue={345} seed="inst-1" height={132} texture={CHERRY} />) {
    view = render(
      <div data-sk-hover-host="" data-testid="host">
        <span data-testid="inside">标题</span>
        {children}
      </div>,
    );
    const host = view.container.querySelector<HTMLElement>("[data-testid='host']") as HTMLElement;
    setRect(host, { left: 100, top: 20, width: 400, height: 200 });
    return host;
  }

  beforeEach(() => {
    vi.mocked(useBlockSource).mockReturnValue(source("block|1.21.1|cherry_planks"));
  });

  it("指针在宿主上：平铺层反向位移，中心为 0、边缘为 8 px，按帧结算", () => {
    const host = mountInHost();
    const inside = host.querySelector("[data-testid='inside']") as HTMLElement;

    pointer(inside, "pointermove", 400, 70);
    // 还没到下一帧：不写
    expect(shift()).toEqual(["", ""]);
    pointer(inside, "pointermove", 300, 120);
    runFrames();
    // 同一帧内只按最后一次指针位置结算：(300, 120) 正是宿主中心
    expect(shift()).toEqual(["0px", "0px"]);

    pointer(inside, "pointermove", 400, 70);
    runFrames();
    expect(shift()).toEqual(["-4px", "4px"]);

    pointer(host, "pointermove", 100, 20);
    runFrames();
    expect(shift()).toEqual(["8px", "8px"]);

    pointer(host, "pointermove", 430, 195);
    runFrames();
    expect(shift()).toEqual(["-5.2px", "-6px"]);

    // 宿主在动、指针落到框外：按边缘算
    pointer(host, "pointermove", 560, -10);
    runFrames();
    expect(shift()).toEqual(["-8px", "8px"]);
  });

  it("指针离开宿主或移出窗口：归位", () => {
    const host = mountInHost();
    pointer(host, "pointermove", 400, 70);
    runFrames();
    expect(shift()).toEqual(["-4px", "4px"]);

    pointer(document.body, "pointermove", 400, 300);
    runFrames();
    expect(shift()).toEqual(["0px", "0px"]);

    pointer(host, "pointerover", 100, 20);
    runFrames();
    expect(shift()).toEqual(["8px", "8px"]);

    act(() => {
      host.dispatchEvent(new PointerEvent("pointerout", { bubbles: true, relatedTarget: null }));
    });
    runFrames();
    expect(shift()).toEqual(["0px", "0px"]);
  });

  it("卡面挂载之后才标成悬停宿主（卡片等标题按钮登记）：照样跟随", () => {
    view = render(
      <article data-testid="card">
        <Cover hue={345} seed="inst-1" height={132} texture={CHERRY} />
      </article>,
    );
    const card = view.container.querySelector<HTMLElement>("[data-testid='card']") as HTMLElement;
    setRect(card, { left: 0, top: 0, width: 200, height: 100 });
    pointer(card, "pointermove", 150, 25);
    runFrames();
    expect(shift()).toEqual(["0px", "0px"]);

    card.setAttribute("data-sk-hover-host", "");
    pointer(card, "pointermove", 150, 25);
    runFrames();
    expect(shift()).toEqual(["-4px", "4px"]);
  });

  it("只在显示平铺时挂指针监听；art 形态与远程图不挂，卸载后摘掉", () => {
    const add = vi.spyOn(document, "addEventListener");
    const remove = vi.spyOn(document, "removeEventListener");
    vi.mocked(useBlockSource).mockReturnValue(null);
    mountInHost();
    expect(add.mock.calls.filter(([type]) => type.startsWith("pointer"))).toEqual([]);
    view?.unmount();

    vi.mocked(useBlockSource).mockReturnValue(source("block|1.21.1|cherry_planks"));
    mountInHost();
    expect(add.mock.calls.filter(([type]) => type.startsWith("pointer")).map(([type]) => type)).toEqual(["pointermove", "pointerover", "pointerout"]);
    view?.unmount();
    view = undefined;
    expect(remove.mock.calls.filter(([type]) => type.startsWith("pointer")).map(([type]) => type)).toEqual(["pointermove", "pointerover", "pointerout"]);
  });

  it("多张平铺卡面共用一组监听，各按自己的宿主结算", () => {
    const add = vi.spyOn(document, "addEventListener");
    view = render(
      <>
        <div data-sk-hover-host="" data-testid="a">
          <Cover hue={345} seed="a" height={132} texture={CHERRY} />
        </div>
        <div data-sk-hover-host="" data-testid="b">
          <Cover hue={345} seed="b" height={132} texture={CHERRY} />
        </div>
      </>,
    );
    const [a, b] = ["a", "b"].map((id) => view?.container.querySelector<HTMLElement>(`[data-testid='${id}']`) as HTMLElement);
    setRect(a, { left: 0, top: 0, width: 200, height: 100 });
    setRect(b, { left: 0, top: 100, width: 200, height: 100 });
    expect(add.mock.calls.filter(([type]) => type === "pointermove")).toHaveLength(1);

    pointer(b, "pointermove", 0, 200);
    runFrames();
    const [coverA, coverB] = [a, b].map((host) => host.querySelector<HTMLElement>("[data-source]") as HTMLElement);
    expect(coverA.style.getPropertyValue("--tile-x")).toBe("0px");
    expect([coverB.style.getPropertyValue("--tile-x"), coverB.style.getPropertyValue("--tile-y")]).toEqual(["8px", "-8px"]);
  });

  it("远程图到了：平铺退下，摘掉监听并清掉位移", async () => {
    let finish: (url: string) => void = () => {
      throw new Error("解析函数还没被调用");
    };
    const remove = vi.spyOn(document, "removeEventListener");
    const host = mountInHost(
      <RemoteImageProvider resolve={() => new Promise<string>((done) => (finish = done))}>
        <Cover hue={345} seed="inst-1" height={132} remoteUrl="http://petalfall-tex.localhost/cover/abc" texture={CHERRY} />
      </RemoteImageProvider>,
    );
    intersect();
    resize.resize(cover(), 320);
    await settle();
    pointer(host, "pointermove", 400, 70);
    runFrames();
    expect(shift()).toEqual(["-4px", "4px"]);

    finish("http://petalfall-tex.localhost/cover/abc");
    await settle();
    expect(cover().dataset.source).toBe("remote");
    expect(shift()).toEqual(["", ""]);
    expect(remove.mock.calls.map(([type]) => type)).toContain("pointermove");
  });

  it("减少动画：不挂指针监听，指针移动也不位移", () => {
    const add = vi.spyOn(document, "addEventListener");
    const host = mountInHost(
      <MotionConfig reducedMotion="always">
        <Cover hue={345} seed="inst-1" height={132} texture={CHERRY} />
      </MotionConfig>,
    );
    expect(cover().dataset.source).toBe("texture");
    expect(add.mock.calls.filter(([type]) => type.startsWith("pointer"))).toEqual([]);
    pointer(host, "pointermove", 400, 70);
    runFrames();
    expect(shift()).toEqual(["", ""]);
    expect(frames).toHaveLength(0);
  });
});
