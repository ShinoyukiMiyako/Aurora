import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getArtStatus, NO_ART, setArtStatus, type ArtStatusDto } from "./art";
import { bindArtStatus } from "./binding";
import { clearArtCache } from "./useArt";

const WINDOWS_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0";

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.stubGlobal("navigator", { userAgent: WINDOWS_UA });
  fetchMock = vi.fn(async () => ({ ok: true, status: 200, blob: async () => new Blob(["x"]) }));
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("createImageBitmap", vi.fn(async () => ({ width: 16, height: 16 })));
});

afterEach(() => {
  setArtStatus(NO_ART);
  clearArtCache();
  vi.unstubAllGlobals();
});

function eventSource() {
  let handler: (() => void) | null = null;
  const unlisten = vi.fn(() => {
    handler = null;
  });
  const listenChanged = vi.fn(async (h: () => void) => {
    handler = h;
    return unlisten;
  });
  return { listenChanged, unlisten, fire: () => handler?.() };
}

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe("bindArtStatus", () => {
  it("先订阅再首查；首查结果写入状态，材质源就绪后预加载 17 张封面面图", async () => {
    const order: string[] = [];
    const events = eventSource();
    events.listenChanged.mockImplementation(async (h: () => void) => {
      order.push("listen");
      void h;
      return events.unlisten;
    });
    const load = vi.fn(async (): Promise<ArtStatusDto> => {
      order.push("load");
      return { source: { version_id: "1.21.1" }, panorama: false };
    });
    const dispose = await bindArtStatus({ load, listenChanged: events.listenChanged, onError: vi.fn() });
    expect(order).toEqual(["listen", "load"]);
    expect(getArtStatus()).toEqual({ source: { versionId: "1.21.1" }, panorama: false });
    const urls = fetchMock.mock.calls.map((c) => String(c[0]));
    expect(urls).toHaveLength(17);
    expect(urls).toContain("http://petalfall-tex.localhost/art/block/grass_block_top.png?v=1.21.1");
    expect(urls.every((u) => u.endsWith("?v=1.21.1"))).toBe(true);
    dispose();
    expect(events.unlisten).toHaveBeenCalledTimes(1);
  });

  it("没有材质源时不预加载任何图", async () => {
    const events = eventSource();
    await bindArtStatus({ load: async () => ({ source: null, panorama: true }), listenChanged: events.listenChanged, onError: vi.fn() });
    expect(getArtStatus()).toEqual({ source: null, panorama: true });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("收到变化事件即重新查询，首次装好游戏后状态切到新材质源", async () => {
    const events = eventSource();
    const load = vi
      .fn<() => Promise<ArtStatusDto>>()
      .mockResolvedValueOnce({ source: null, panorama: false })
      .mockResolvedValueOnce({ source: { version_id: "1.20.1" }, panorama: true });
    await bindArtStatus({ load, listenChanged: events.listenChanged, onError: vi.fn() });
    expect(getArtStatus().source).toBeNull();
    events.fire();
    await flush();
    expect(load).toHaveBeenCalledTimes(2);
    expect(getArtStatus()).toEqual({ source: { versionId: "1.20.1" }, panorama: true });
  });

  it("事件触发的查询失败交给 onError，状态保持原样", async () => {
    const events = eventSource();
    const onError = vi.fn();
    const failure = new Error("后端不可用");
    const load = vi.fn<() => Promise<ArtStatusDto>>().mockResolvedValueOnce({ source: { version_id: "1.21.1" }, panorama: false }).mockRejectedValueOnce(failure);
    await bindArtStatus({ load, listenChanged: events.listenChanged, onError });
    events.fire();
    await flush();
    expect(onError).toHaveBeenCalledWith(failure);
    expect(getArtStatus().source).toEqual({ versionId: "1.21.1" });
  });

  it("首查失败撤销订阅并抛出；返回值形状不对同样抛出", async () => {
    const events = eventSource();
    await expect(bindArtStatus({ load: async () => Promise.reject(new Error("拒绝")), listenChanged: events.listenChanged, onError: vi.fn() })).rejects.toThrow("拒绝");
    expect(events.unlisten).toHaveBeenCalledTimes(1);

    const bad = eventSource();
    await expect(bindArtStatus({ load: async () => ({ source: "1.21" }) as never, listenChanged: bad.listenChanged, onError: vi.fn() })).rejects.toThrow("panorama");
    expect(bad.unlisten).toHaveBeenCalledTimes(1);
  });

  it("解除绑定后迟到的查询结果不再写入", async () => {
    const events = eventSource();
    let release: ((dto: ArtStatusDto) => void) | undefined;
    const load = vi
      .fn<() => Promise<ArtStatusDto>>()
      .mockResolvedValueOnce({ source: null, panorama: false })
      .mockImplementationOnce(() => new Promise((resolve) => (release = resolve)));
    const dispose = await bindArtStatus({ load, listenChanged: events.listenChanged, onError: vi.fn() });
    events.fire();
    dispose();
    release?.({ source: { version_id: "1.21.1" }, panorama: true });
    await flush();
    expect(getArtStatus()).toEqual(NO_ART);
  });
});
