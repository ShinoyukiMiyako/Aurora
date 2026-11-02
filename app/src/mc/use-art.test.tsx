// @vitest-environment jsdom
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { render, type Rendered } from "../test/dom";
import { NO_ART, setArtStatus } from "./art";
import { clearArtCache, loadArt, peekArt, useArt } from "./useArt";

const URL_A = "http://petalfall-tex.localhost/art/block/cherry_planks.png?v=1.21.1";
const URL_B = "http://petalfall-tex.localhost/art/block/blue_ice.png?v=1.21.1";

interface FakeBitmap {
  width: number;
  height: number;
  source: string;
}

let views: Rendered[] = [];
let fetchMock: ReturnType<typeof vi.fn>;
let decodeMock: ReturnType<typeof vi.fn>;
let warn: MockInstance<typeof console.warn>;

function okResponse(url: string) {
  return { ok: true, status: 200, blob: async () => new Blob([url]) };
}

beforeEach(() => {
  clearArtCache();
  fetchMock = vi.fn(async (url: string) => okResponse(url));
  decodeMock = vi.fn(async (blob: Blob): Promise<FakeBitmap> => ({ width: 16, height: 16, source: await blob.text() }));
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("createImageBitmap", decodeMock);
  warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

afterEach(() => {
  for (const v of views) v.unmount();
  views = [];
  setArtStatus(NO_ART);
  clearArtCache();
  vi.unstubAllGlobals();
});

function Probe({ url }: { url: string | null }) {
  const state = useArt(url);
  const source = state.kind === "ready" ? (state.bitmap as unknown as FakeBitmap).source : "";
  return <span data-kind={state.kind} data-source={source} />;
}

function mount(url: string | null) {
  const view = render(<Probe url={url} />);
  views.push(view);
  return view;
}

const kindOf = (view: Rendered) => view.container.querySelector("span")?.dataset.kind;

/** 让 fetch -> blob -> 解码 -> setState 这一串微任务全部跑完。 */
const settle = () => act(() => new Promise<void>((resolve) => setTimeout(resolve, 0)));

describe("useArt", () => {
  it("取图失败为 missing，记一条带地址的 warn，以 CORS 模式请求一次", async () => {
    fetchMock.mockImplementation(async () => ({ ok: false, status: 404, blob: async () => new Blob() }));
    const view = mount(URL_A);
    expect(kindOf(view)).toBe("missing");
    await settle();
    expect(kindOf(view)).toBe("missing");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(URL_A, { mode: "cors" });
    expect(decodeMock).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain(URL_A);
    expect(String(warn.mock.calls[0][1])).toContain("HTTP 404");
  });

  it("解码失败同样回落 missing", async () => {
    decodeMock.mockRejectedValue(new Error("InvalidStateError: 无法解码"));
    const view = mount(URL_A);
    await settle();
    expect(kindOf(view)).toBe("missing");
    expect(String(warn.mock.calls[0][1])).toContain("无法解码");
  });

  it("成功结果跨挂载复用：重新挂载的首帧就是 ready，整个过程只取一次", async () => {
    const first = mount(URL_A);
    expect(kindOf(first)).toBe("missing");
    await settle();
    expect(kindOf(first)).toBe("ready");
    expect(first.container.querySelector("span")?.dataset.source).toBe(URL_A);
    first.unmount();
    views = views.filter((v) => v !== first);

    const second = mount(URL_A);
    // 不等任何微任务：缓存命中时同步给出结果，不闪回落件
    expect(kindOf(second)).toBe("ready");
    await settle();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(decodeMock).toHaveBeenCalledTimes(1);
  });

  it("同时挂载的多个使用方共用一次请求；不同地址各取一次", async () => {
    const a1 = mount(URL_A);
    const a2 = mount(URL_A);
    const b = mount(URL_B);
    await settle();
    expect([kindOf(a1), kindOf(a2), kindOf(b)]).toEqual(["ready", "ready", "ready"]);
    expect(fetchMock.mock.calls.map((c) => c[0]).sort()).toEqual([URL_B, URL_A].sort());
  });

  it("地址为 null 时恒为 missing，不发请求", async () => {
    const view = mount(null);
    await settle();
    expect(kindOf(view)).toBe("missing");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("失败结果也缓存；材质状态变化后清空重取，装好游戏不用重启即换真材质", async () => {
    fetchMock.mockImplementationOnce(async () => ({ ok: false, status: 404, blob: async () => new Blob() }));
    const view = mount(URL_A);
    await settle();
    expect(kindOf(view)).toBe("missing");
    expect(peekArt(URL_A)).toEqual({ kind: "missing" });
    expect(await loadArt(URL_A)).toEqual({ kind: "missing" });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    act(() => setArtStatus({ source: { versionId: "1.21.1" }, panorama: false }));
    expect(peekArt(URL_A)).toBeUndefined();
    await settle();
    expect(kindOf(view)).toBe("ready");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("取图途中状态变化：旧一代的结果不写进新缓存", async () => {
    let release: (() => void) | undefined;
    fetchMock.mockImplementationOnce(
      (url: string) => new Promise((resolve) => (release = () => resolve(okResponse(url)))),
    );
    const stale = loadArt(URL_A);
    clearArtCache();
    release?.();
    expect((await stale).kind).toBe("ready");
    expect(peekArt(URL_A)).toBeUndefined();
  });
});
