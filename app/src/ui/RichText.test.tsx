// @vitest-environment jsdom
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stubCanvas } from "../art/illustrations/test-canvas";
import { render, stubMatchMedia, type Rendered } from "../test/dom";
import { ExternalLinkProvider, useExternalLinkOpener } from "./external-link";
import { RemoteImageProvider } from "./remote-image";
import { parseHtml, parseMarkdown, type Block } from "./richtext-parse";
import { RICH_IMAGE_MAX_WIDTH, richImageBox, richImageSize, RichText } from "./RichText";

let view: Rendered | undefined;
let observers: { callback: IntersectionObserverCallback; targets: Element[] }[];
let resolved: string[];
let opened: string[];

beforeEach(() => {
  stubMatchMedia(false);
  stubCanvas();
  observers = [];
  resolved = [];
  opened = [];
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

function mount(blocks: readonly Block[]) {
  view = render(
    <RemoteImageProvider
      resolve={async (url) => {
        resolved.push(url);
        return `asset://${url}`;
      }}
    >
      <ExternalLinkProvider open={(url) => opened.push(url)}>
        <RichText blocks={blocks} />
      </ExternalLinkProvider>
    </RemoteImageProvider>,
  );
  return view.container;
}

async function scrollAllIntoView() {
  await act(async () => {
    for (const o of observers) for (const target of o.targets) o.callback([{ isIntersecting: true, target } as unknown as IntersectionObserverEntry], {} as IntersectionObserver);
  });
  for (let i = 0; i < 5; i++) await settle();
}

describe("配图尺寸", () => {
  it("按原图比例缩到最宽 640，小图不放大，极扁的图高度至少 1", () => {
    expect(RICH_IMAGE_MAX_WIDTH).toBe(640);
    expect(richImageSize(1280, 720)).toEqual({ width: 640, height: 360 });
    expect(richImageSize(300, 200)).toEqual({ width: 300, height: 200 });
    expect(richImageSize(640, 480)).toEqual({ width: 640, height: 480 });
    expect(richImageSize(641, 641)).toEqual({ width: 640, height: 640 });
    expect(richImageSize(4000, 1)).toEqual({ width: 640, height: 1 });
  });

  it("原文写了宽高就照写的显示，取图前已知；没写的等解码，在那之前没有尺寸", () => {
    expect(richImageBox({ width: 1000, height: 500 }, null)).toEqual({ width: 640, height: 320 });
    expect(richImageBox({ width: 300, height: 150 }, { width: 1280, height: 720 })).toEqual({ width: 300, height: 150 });
    expect(richImageBox(undefined, null)).toBeNull();
    expect(richImageBox(undefined, { width: 1280, height: 720 })).toEqual({ width: 640, height: 360 });
  });
});

describe("RichText", () => {
  it("更新说明：标题一律降为 h4，列表、行内代码与段落按原顺序画出，不产生任何原始 HTML", () => {
    const container = mount(parseMarkdown("# 0.2.1\n\n1. 第一条\n2. 第二条 `--sk-accent`\n\n- 无序\n\n```\nfn main() {}\n```\n\n<b>粗</b> 与 <img src=x onerror=alert(1)>"));
    const body = container.firstElementChild as HTMLElement;
    expect([...body.children].map((el) => el.tagName)).toEqual(["H4", "OL", "UL", "PRE", "P"]);
    expect(body.querySelector("h4")?.textContent).toBe("0.2.1");
    expect([...body.querySelectorAll("ol > li")].map((li) => li.textContent)).toEqual(["第一条", "第二条 --sk-accent"]);
    expect(body.querySelector("ol code")?.textContent).toBe("--sk-accent");
    expect(body.querySelector("pre > code")?.textContent).toBe("fn main() {}");
    expect(body.querySelector(":scope > p")?.textContent).toBe("粗 与");
    expect(body.querySelectorAll("b, img, script")).toHaveLength(0);
  });

  it("链接不在启动器窗口里跳转、不带来源信息；非 http(s) 的链接只剩文字", () => {
    mount(parseMarkdown("见 [文档](https://docs.io/a) 与 https://wiki.io/b，还有 [坏链接](javascript:alert(1))"));
    const links = [...document.querySelectorAll("a")];
    expect(links.map((a) => [a.getAttribute("href"), a.getAttribute("target"), a.getAttribute("rel")])).toEqual([
      ["https://docs.io/a", "_blank", "noreferrer noopener"],
      ["https://wiki.io/b", "_blank", "noreferrer noopener"],
    ]);
    expect(document.body.textContent).toContain("坏链接");
  });

  // 打开外部网址只有一个出口（外壳注入，失败经统一错误处理提示）；链接自己的默认行为一律拦下
  it("点击与中键点击都交给外壳注入的打开方式，每次一条、地址原样，默认行为被拦下", () => {
    mount(parseMarkdown("见 [文档](https://docs.io/a?x=1#h) 与 https://wiki.io/b"));
    const [docs, wiki] = [...document.querySelectorAll("a")];
    const click = new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 });
    act(() => {
      docs.dispatchEvent(click);
    });
    expect(click.defaultPrevented).toBe(true);
    expect(opened).toEqual(["https://docs.io/a?x=1#h"]);

    const middle = new MouseEvent("auxclick", { bubbles: true, cancelable: true, button: 1 });
    act(() => {
      wiki.dispatchEvent(middle);
    });
    expect(middle.defaultPrevented).toBe(true);
    expect(opened).toEqual(["https://docs.io/a?x=1#h", "https://wiki.io/b"]);

    // 右键是上下文菜单，不是打开
    const right = new MouseEvent("auxclick", { bubbles: true, cancelable: true, button: 2 });
    act(() => {
      wiki.dispatchEvent(right);
    });
    expect(right.defaultPrevented).toBe(false);
    expect(opened).toHaveLength(2);
  });

  it("不在 ExternalLinkProvider 里打开链接是装配错误，直接抛，不悄悄退回别的打开方式", () => {
    let open: ((url: string) => void) | undefined;
    function Probe() {
      open = useExternalLinkOpener();
      return null;
    }
    view = render(<Probe />);
    if (open === undefined) throw new Error("探针没有渲染");
    const call = open;
    expect(() => call("https://docs.io/a")).toThrow("ExternalLinkProvider");
  });

  it("HTML 正文同样只画受限节点", () => {
    const container = mount(parseHtml('<h2>特性</h2><ul><li>快</li><li><strong>稳</strong></li></ul><script>alert(1)</script>'));
    const body = container.firstElementChild as HTMLElement;
    expect([...body.children].map((el) => el.tagName)).toEqual(["H4", "UL"]);
    expect(body.querySelector("strong")?.textContent).toBe("稳");
    expect(body.textContent).not.toContain("alert");
  });

  it("配图进入视口附近才经外壳解析取图，画成按比例缩小的 Canvas；取不到的图整个不显示", async () => {
    mount(parseMarkdown("![截图](https://cdn.io/shot.gif)\n\n![坏图](https://cdn.io/broken.png)"));
    expect(resolved).toEqual([]);
    await scrollAllIntoView();
    expect(resolved).toEqual(["https://cdn.io/shot.gif", "https://cdn.io/broken.png"]);
    const pictures = [...document.querySelectorAll('[role="img"]')];
    expect(pictures.map((el) => el.getAttribute("aria-label"))).toEqual(["截图"]);
    const canvas = pictures[0].querySelector("canvas");
    if (canvas === null) throw new Error("配图没有画进 Canvas");
    expect((pictures[0] as HTMLElement).style.width).toBe("640px");
    expect((pictures[0] as HTMLElement).style.aspectRatio).toBe("640 / 360");
    expect([canvas.width, canvas.height]).toEqual([640, 360]);
    expect(document.querySelectorAll("img")).toHaveLength(0);
  });

  it("写了宽高的配图取图之前就按比例占好位置，解码后尺寸不变，图画进同一格", async () => {
    mount(parseHtml('<p>前</p><img src="https://cdn.io/banner.png" alt="横幅" width="1000" height="250"><p>后</p>'));
    const slot = document.querySelector<HTMLElement>("[data-reserved]");
    if (slot === null) throw new Error("写了宽高的配图应该先占位");
    expect([slot.style.width, slot.style.aspectRatio]).toEqual(["640px", "640 / 160"]);
    expect(slot.hasAttribute("data-ready")).toBe(false);
    expect(slot.querySelector("canvas")).toBeNull();

    await scrollAllIntoView();
    // 原图 1280 × 720，与写的比例不同：照写的显示，位置不变
    expect(document.querySelector("[data-reserved]")).toBe(slot);
    expect([slot.style.width, slot.style.aspectRatio]).toEqual(["640px", "640 / 160"]);
    expect(slot.hasAttribute("data-ready")).toBe(true);
    expect(slot.getAttribute("role")).toBe("img");
    expect(slot.getAttribute("aria-label")).toBe("横幅");
    const canvas = slot.querySelector("canvas");
    if (canvas === null) throw new Error("配图没有画进占好的格子");
    expect([canvas.width, canvas.height]).toEqual([640, 160]);
  });

  it("没写宽高的配图解码前不占高度，也不垫骨架", () => {
    mount(parseMarkdown("![截图](https://cdn.io/shot.png)"));
    const slot = document.querySelector<HTMLElement>("p > span");
    if (slot === null) throw new Error("配图位没有渲染");
    expect(slot.hasAttribute("data-reserved")).toBe(false);
    expect(slot.style.width).toBe("");
    expect(slot.style.aspectRatio).toBe("");
  });

  it("空节点树：只有一个空容器", () => {
    const container = mount([]);
    expect(container.firstElementChild?.childElementCount).toBe(0);
  });
});
