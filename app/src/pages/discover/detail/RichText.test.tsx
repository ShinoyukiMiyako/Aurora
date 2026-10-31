// @vitest-environment jsdom
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stubCanvas } from "../../../art/illustrations/test-canvas";
import { render, stubMatchMedia, type Rendered } from "../../../test/dom";
import { RemoteImageProvider } from "../../../ui/remote-image";
import { parseMarkdown } from "../richtext";
import { bodyImageSize, RichText } from "./RichText";

let view: Rendered | undefined;
let observers: { callback: IntersectionObserverCallback; targets: Element[] }[];
let resolved: string[];

beforeEach(() => {
  stubMatchMedia(false);
  stubCanvas();
  observers = [];
  resolved = [];
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
  vi.stubGlobal("fetch", vi.fn(async (url: string) => (url.includes("broken") ? { ok: false, status: 404 } : { ok: true, status: 200, blob: async () => new Blob([url]) })));
  vi.stubGlobal("createImageBitmap", vi.fn(async () => ({ width: 1280, height: 720, close: vi.fn() })));
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  view?.unmount();
  view = undefined;
  vi.unstubAllGlobals();
});

const settle = () => act(() => new Promise<void>((resolve) => setTimeout(resolve, 0)));

function mount(markdown: string) {
  view = render(
    <RemoteImageProvider
      resolve={async (url) => {
        resolved.push(url);
        return `asset://${url}`;
      }}
    >
      <RichText blocks={parseMarkdown(markdown)} />
    </RemoteImageProvider>,
  );
}

async function scrollAllIntoView() {
  await act(async () => {
    for (const o of observers) for (const target of o.targets) o.callback([{ isIntersecting: true, target } as unknown as IntersectionObserverEntry], {} as IntersectionObserver);
  });
  for (let i = 0; i < 5; i++) await settle();
}

describe("正文配图的尺寸", () => {
  it("按原图比例缩到最宽 640，小图不放大，极扁的图高度至少 1", () => {
    expect(bodyImageSize(1280, 720)).toEqual({ width: 640, height: 360 });
    expect(bodyImageSize(300, 200)).toEqual({ width: 300, height: 200 });
    expect(bodyImageSize(640, 480)).toEqual({ width: 640, height: 480 });
    expect(bodyImageSize(4000, 1)).toEqual({ width: 640, height: 1 });
  });
});

describe("介绍正文", () => {
  it("链接交给系统浏览器打开，不带来源信息", () => {
    mount("见 [文档](https://docs.io/a) 与 https://wiki.io/b");
    const links = [...document.querySelectorAll("a")];
    expect(links.map((a) => [a.getAttribute("href"), a.getAttribute("target"), a.getAttribute("rel")])).toEqual([
      ["https://docs.io/a", "_blank", "noreferrer noopener"],
      ["https://wiki.io/b", "_blank", "noreferrer noopener"],
    ]);
  });

  it("配图进入视口附近才经外壳解析取图，画成按比例缩小的 Canvas；取不到的图整个不显示", async () => {
    mount("![截图](https://cdn.io/shot.gif)\n\n![坏图](https://cdn.io/broken.png)");
    expect(resolved).toEqual([]);
    expect(document.querySelectorAll("img")).toHaveLength(0);
    await scrollAllIntoView();
    expect(resolved).toEqual(["https://cdn.io/shot.gif", "https://cdn.io/broken.png"]);
    const pictures = [...document.querySelectorAll('[role="img"]')];
    expect(pictures.map((el) => el.getAttribute("aria-label"))).toEqual(["截图"]);
    const canvas = pictures[0].querySelector("canvas");
    if (canvas === null) throw new Error("配图没有画进 Canvas");
    expect(canvas.style.width).toBe("640px");
    expect(document.querySelectorAll("img")).toHaveLength(0);
  });
});
