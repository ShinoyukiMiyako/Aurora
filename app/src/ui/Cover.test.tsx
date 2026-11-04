// @vitest-environment jsdom
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stubCanvas, type CanvasStub } from "../art/illustrations/test-canvas";
import { render, stubMatchMedia, stubResizeObserver, type ResizeObserverStub, type Rendered } from "../test/dom";
import { Cover, coverIdentityWidth } from "./Cover";
import { RemoteImageProvider } from "./remote-image";

let view: Rendered | undefined;
let canvas: CanvasStub;
let resize: ResizeObserverStub;
let observers: { callback: IntersectionObserverCallback; targets: Element[] }[];

beforeEach(() => {
  stubMatchMedia(false);
  canvas = stubCanvas();
  resize = stubResizeObserver();
  observers = [];
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
});

afterEach(() => {
  view?.unmount();
  view = undefined;
  vi.unstubAllGlobals();
});

const settle = () => act(() => new Promise<void>((resolve) => setTimeout(resolve, 0)));
const cover = () => view?.container.firstElementChild as HTMLElement;

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

  it("remote 形态：量出宽度并进入视口后才加载；加载完换成远程图、加压暗，不再画身份方块", async () => {
    const resolve = vi.fn(async (url: string) => url);
    view = render(
      <RemoteImageProvider resolve={resolve}>
        <Cover hue={20} seed="p" height={180} remoteUrl="https://cdn.modrinth.com/gallery/a.png" shade="bottom" identity={{ instanceId: "i", cover: { block: "red_wool", hue: 355, image: null } }} />
      </RemoteImageProvider>,
    );
    act(() => {
      for (const o of observers) for (const target of o.targets) o.callback([{ isIntersecting: true, target } as IntersectionObserverEntry], {} as IntersectionObserver);
    });
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
});
