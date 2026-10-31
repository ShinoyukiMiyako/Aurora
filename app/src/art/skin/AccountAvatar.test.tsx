// @vitest-environment jsdom
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { NO_ART, setArtStatus } from "../../mc/art";
import { clearArtCache } from "../../mc/useArt";
import { render, stubMatchMedia, type Rendered } from "../../test/dom";
import { stubCanvas, type CanvasStub } from "../illustrations/test-canvas";
import { AccountAvatar } from "./AccountAvatar";
import { AccountFigure } from "./AccountFigure";

const REMOTE = "aa".repeat(20);

let view: Rendered | undefined;
let canvas: CanvasStub;
let fetchMock: ReturnType<typeof vi.fn>;
let skinSize = { width: 64, height: 64 };
let warn: MockInstance<typeof console.warn>;
const bitmaps: { width: number; height: number; url: string }[] = [];

beforeEach(() => {
  stubMatchMedia(false);
  canvas = stubCanvas();
  vi.stubGlobal("navigator", { userAgent: "Windows" });
  fetchMock = vi.fn(async (url: string) => ({ ok: true, status: 200, blob: async () => new Blob([url]) }));
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal(
    "createImageBitmap",
    vi.fn(async (blob: Blob) => {
      const bitmap = { ...skinSize, url: await blob.text() };
      bitmaps.push(bitmap);
      return bitmap;
    }),
  );
  warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  skinSize = { width: 64, height: 64 };
  bitmaps.length = 0;
});

afterEach(() => {
  view?.unmount();
  view = undefined;
  setArtStatus(NO_ART);
  clearArtCache();
  vi.unstubAllGlobals();
});

const settle = () => act(() => new Promise<void>((resolve) => setTimeout(resolve, 0)));
const root = () => view?.container.firstElementChild as HTMLElement;

describe("AccountAvatar", () => {
  it("没有皮肤信息时是剪影，不发请求；旁边没有名称时 aria-hidden", async () => {
    view = render(<AccountAvatar uuid="0123456789abcdef0123456789abcdef" skin={null} size={40} />);
    await settle();
    expect(root().dataset.art).toBe("silhouette");
    expect(root().dataset.skArt).toBe("skin");
    expect(root().getAttribute("aria-hidden")).toBe("true");
    expect(root().style.width).toBe("40px");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("默认皮肤在本机没有材质源时不请求，显示剪影", async () => {
    view = render(<AccountAvatar uuid="u1" skin={{ kind: "default", path: "entity/player/wide/steve", model: "wide" }} size={32} />);
    await settle();
    expect(root().dataset.art).toBe("silhouette");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("默认皮肤取到后换成皮肤正脸 + 帽子层，脸 32 px 按 dpr 1 画满 32 × 32", async () => {
    setArtStatus({ source: { versionId: "1.21.1" }, panorama: false });
    view = render(<AccountAvatar uuid="u1" skin={{ kind: "default", path: "entity/player/slim/alex", model: "slim" }} size={40} current label="Alex 的头像" />);
    expect(root().dataset.art).toBe("silhouette");
    await settle();
    expect(fetchMock).toHaveBeenCalledWith("http://aurora-tex.localhost/art/entity/player/slim/alex.png?v=1.21.1", { mode: "cors" });
    expect(root().dataset.art).toBe("skin");
    expect(root().dataset.current).toBe("true");
    expect(root().getAttribute("role")).toBe("img");
    expect(root().getAttribute("aria-label")).toBe("Alex 的头像");
    const skin = bitmaps[0];
    expect(canvas.sourceRects(skin)).toEqual(["8,8,8,8", "40,8,8,8"]);
    const faceDraw = canvas.draws.find((d) => d.source === skin);
    expect(faceDraw?.canvas).toMatchObject({ width: 32, height: 32 });
  });

  it("远程皮肤按 sha1 取；后端判定没有帽子层时只画正脸", async () => {
    view = render(<AccountAvatar uuid="u2" skin={{ kind: "remote", sha1: REMOTE, model: "wide", hat: false }} size={24} />);
    await settle();
    expect(fetchMock).toHaveBeenCalledWith(`http://aurora-tex.localhost/skin/${REMOTE}.png`, { mode: "cors" });
    expect(root().dataset.art).toBe("skin");
    expect(canvas.sourceRects(bitmaps[0])).toEqual(["8,8,8,8"]);
  });

  it("尺寸不是 64 × 64 / 64 × 32 的皮肤回落剪影并记 warn", async () => {
    skinSize = { width: 64, height: 48 };
    view = render(<AccountAvatar uuid="u3" skin={{ kind: "remote", sha1: "bb".repeat(20), model: "wide", hat: true }} size={32} />);
    await settle();
    expect(root().dataset.art).toBe("silhouette");
    expect(warn.mock.calls.some((c) => String(c[0]).includes("64x48"))).toBe(true);
  });

  it("下载失败（404）回落剪影", async () => {
    fetchMock.mockImplementation(async () => ({ ok: false, status: 404, blob: async () => new Blob() }));
    view = render(<AccountAvatar uuid="u4" skin={{ kind: "remote", sha1: "cc".repeat(20), model: "wide", hat: true }} size={48} />);
    await settle();
    expect(root().dataset.art).toBe("silhouette");
  });
});

describe("AccountFigure", () => {
  it("旧格式皮肤：左臂左腿取右侧镜像，外层只画帽子；立绘 scale 5 为 80 × 160", async () => {
    skinSize = { width: 64, height: 32 };
    view = render(<AccountFigure uuid="u5" skin={{ kind: "remote", sha1: "dd".repeat(20), model: "wide", hat: true }} scale={5} />);
    await settle();
    expect(root().dataset.art).toBe("skin");
    expect(root().style.width).toBe("80px");
    expect(root().style.height).toBe("160px");
    expect(canvas.sourceRects(bitmaps[0])).toEqual(["8,8,8,8", "20,20,8,12", "44,20,4,12", "44,20,4,12", "4,20,4,12", "4,20,4,12", "40,8,8,8"]);
  });

  it("没有皮肤时是剪影立绘", async () => {
    view = render(<AccountFigure uuid="u6" skin={null} scale={4} />);
    await settle();
    expect(root().dataset.art).toBe("silhouette");
    expect(root().style.height).toBe("128px");
  });
});
