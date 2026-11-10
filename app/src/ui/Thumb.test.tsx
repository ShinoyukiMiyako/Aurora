// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { act, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stubCanvas, type CanvasStub } from "../art/illustrations/test-canvas";
import { render, stubMatchMedia, type Rendered } from "../test/dom";
import { RemoteImageProvider } from "./remote-image";
import { isPixelArtThumb, Thumb, THUMB_RADIUS, thumbIconSize, type ThumbSize } from "./Thumb";
import styles from "./Thumb.module.css";

let view: Rendered | undefined;
let canvas: CanvasStub;
let observers: { callback: IntersectionObserverCallback; options: IntersectionObserverInit | undefined; targets: Element[] }[];
let fetchMock: ReturnType<typeof vi.fn>;
let decodeMock: ReturnType<typeof vi.fn>;
let natural = { width: 16, height: 16 };

beforeEach(() => {
  stubMatchMedia(false);
  canvas = stubCanvas();
  observers = [];
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      private entry: (typeof observers)[number];
      constructor(callback: IntersectionObserverCallback, options?: IntersectionObserverInit) {
        this.entry = { callback, options, targets: [] };
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
  fetchMock = vi.fn(async (url: string) => ({ ok: true, status: 200, blob: async () => new Blob([url]) }));
  vi.stubGlobal("fetch", fetchMock);
  decodeMock = vi.fn(async (source: unknown, options?: ImageBitmapOptions) => {
    if (options?.resizeWidth !== undefined) return { width: options.resizeWidth, height: options.resizeHeight, close: vi.fn() };
    void source;
    return { ...natural, close: vi.fn() };
  });
  vi.stubGlobal("createImageBitmap", decodeMock);
  natural = { width: 16, height: 16 };
});

afterEach(() => {
  view?.unmount();
  view = undefined;
  vi.unstubAllGlobals();
});

const settle = () => act(() => new Promise<void>((resolve) => setTimeout(resolve, 0)));
const thumb = () => view?.container.firstElementChild as HTMLElement;

function enterViewport() {
  act(() => {
    for (const o of observers) {
      for (const target of o.targets) o.callback([{ isIntersecting: true, target } as IntersectionObserverEntry], {} as IntersectionObserver);
    }
  });
}

const withResolver = (resolve: (url: string) => Promise<string>, ui: ReactNode) => <RemoteImageProvider resolve={resolve}>{ui}</RemoteImageProvider>;

describe("判定规则", () => {
  it("像素风：不超过 64 的正方形源图，按 2 倍及以上整数倍放大", () => {
    expect(isPixelArtThumb(16, 16, 32)).toBe(true);
    expect(isPixelArtThumb(16, 16, 48)).toBe(true);
    expect(isPixelArtThumb(32, 32, 96)).toBe(true);
    expect(isPixelArtThumb(16, 16, 40)).toBe(false);
    expect(isPixelArtThumb(64, 64, 64)).toBe(false);
    expect(isPixelArtThumb(32, 32, 48)).toBe(false);
    expect(isPixelArtThumb(128, 128, 96)).toBe(false);
    expect(isPixelArtThumb(16, 32, 64)).toBe(false);
  });

  it("图标档位：边长 ≤ 32 用 16，33-48 用 20，更大用 24", () => {
    expect([32, 40, 44, 48, 64, 96].map((s) => thumbIconSize(s as 32))).toEqual([16, 20, 20, 20, 24, 24]);
  });

  it("每一档的圆角都是 round(边长 × 0.3)", () => {
    const sizes = Object.keys(THUMB_RADIUS).map(Number) as ThumbSize[];
    expect(sizes).toEqual([32, 40, 44, 48, 64, 96]);
    for (const size of sizes) expect(THUMB_RADIUS[size]).toBe(Math.round(size * 0.3));
  });
});

describe("Thumb", () => {
  it("没有图：色相底座 + 类型图标，比例圆角，不需要解析函数、不发请求", () => {
    view = render(<Thumb url={null} kind="resourcepack" hue={210} size={64} />);
    expect(thumb().dataset.view).toBe("fallback");
    expect(thumb().style.borderRadius).toBe("19px");
    expect(thumb().style.getPropertyValue("--hue")).toBe("210");
    expect(thumb().querySelector("svg")?.getAttribute("width")).toBe("24");
    expect(thumb().getAttribute("aria-hidden")).toBe("true");
    expect(fetchMock).not.toHaveBeenCalled();
    // 一开始就没有图：图标不单独淡入
    expect(thumb().querySelector("svg")?.classList.contains(styles.late)).toBe(false);
  });

  it("44 档：底座 44 见方、圆角 13、类型图标 20", () => {
    view = render(<Thumb url={null} kind="server" hue={120} size={44} />);
    expect([thumb().style.width, thumb().style.height, thumb().style.borderRadius]).toEqual(["44px", "44px", "13px"]);
    expect(thumb().querySelector("svg")?.getAttribute("width")).toBe("20");
  });

  it("有地址却缺少解析函数是装配错误", () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(() => render(<Thumb url="https://cdn.modrinth.com/a.png" kind="mod" hue={1} size={32} />)).toThrow("RemoteImageProvider");
  });

  it("进入视口（外扩 200 px）前是静止的占位、不解析；进入后才有扫光，解析、取图并画出像素风图标", async () => {
    const resolve = vi.fn(async (url: string) => `http://petalfall-tex.localhost/thumb/${url.length}`);
    view = render(withResolver(resolve, <Thumb url="https://cdn.modrinth.com/data/x/icon.png" kind="mod" hue={1} size={48} alt="钠" />));
    expect(thumb().dataset.view).toBe("pending");
    expect(observers[0].options?.rootMargin).toBe("200px");
    await settle();
    expect(resolve).not.toHaveBeenCalled();

    enterViewport();
    expect(thumb().dataset.view).toBe("loading");
    await settle();
    expect(resolve).toHaveBeenCalledWith("https://cdn.modrinth.com/data/x/icon.png");
    expect(fetchMock).toHaveBeenCalledWith("http://petalfall-tex.localhost/thumb/40", { mode: "cors" });
    expect(thumb().dataset.view).toBe("image");
    expect(thumb().getAttribute("role")).toBe("img");
    expect(thumb().getAttribute("aria-label")).toBe("钠");
    const image = thumb().querySelector("canvas") as HTMLCanvasElement;
    expect(image.dataset.pixel).toBe("true");
    const draw = canvas.draws.at(-1);
    expect(draw?.args).toEqual([0, 0, 16, 16, 0, 0, 48, 48]);
  });

  it("大图解码后缩到显示边长 × dpr × 2 再画，原图立即释放；居中裁成正方形", async () => {
    natural = { width: 512, height: 256 };
    view = render(withResolver(async (u) => u, <Thumb url="https://media.forgecdn.net/a.webp" kind="modpack" hue={1} size={64} />));
    enterViewport();
    await settle();
    expect(thumb().dataset.view).toBe("image");
    expect(decodeMock).toHaveBeenCalledTimes(2);
    expect(decodeMock.mock.calls[1][1]).toEqual({ resizeWidth: 128, resizeHeight: 64, resizeQuality: "high" });
    const original = await decodeMock.mock.results[0].value;
    expect(original.close).toHaveBeenCalledTimes(1);
    expect(thumb().querySelector("canvas")?.dataset.pixel).toBeUndefined();
    expect(canvas.draws.at(-1)?.args).toEqual([32, 0, 64, 64, 0, 0, 64, 64]);
  });

  it("解析失败或 404：回落色相底座 + 类型图标，记一条 warn", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    view = render(withResolver(async () => Promise.reject(new Error("登记失败")), <Thumb url="https://x.test/a.png" kind="shader" hue={40} size={40} inactive />));
    enterViewport();
    await settle();
    expect(thumb().dataset.view).toBe("fallback");
    expect(thumb().dataset.inactive).toBe("true");
    expect(thumb().querySelector("svg")?.getAttribute("width")).toBe("20");
    // 加载失败才落到回落图形：图标淡入
    expect(thumb().querySelector("svg")?.classList.contains(styles.late)).toBe(true);
    expect(String(warn.mock.calls[0][0])).toContain("https://x.test/a.png");

    view.unmount();
    fetchMock.mockImplementation(async () => ({ ok: false, status: 404, blob: async () => new Blob() }));
    view = render(withResolver(async (u) => u, <Thumb url="https://x.test/b.png" kind="news" hue={40} size={96} />));
    enterViewport();
    await settle();
    expect(thumb().dataset.view).toBe("fallback");
    expect(String(warn.mock.calls.at(-1)?.[1])).toContain("HTTP 404");
  });

  it("样式：失败时底色从骨架淡到色相底座、图标淡入；减少动画时图片淡入缩到 200ms", () => {
    const css = readFileSync(resolve(__dirname, "Thumb.module.css"), "utf8");
    const body = (selector: string) => {
      const at = css.indexOf(`${selector} {`);
      if (at < 0) throw new Error(`Thumb.module.css 里没有 ${selector}`);
      return css.slice(at, css.indexOf("}", at));
    };
    expect(body(".thumb")).toContain("transition: background-color var(--sk-dur-in) var(--sk-ease-out);");
    expect(body(".late")).toContain("animation: reveal var(--sk-dur-in) var(--sk-ease-out);");
    expect(body(".image")).toContain("animation: reveal var(--sk-dur-reveal) var(--sk-ease-out);");
    expect(body(":global([data-sk-reduced]) .image")).toContain("animation: reveal var(--sk-dur-in) var(--sk-ease-out);");
  });
});
