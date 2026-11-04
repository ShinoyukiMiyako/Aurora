import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { getArtStatus, NO_ART, setArtStatus, type ArtStatusDto } from "./art";
import { bindArtStatus } from "./binding";
import { getBlockCatalog, setBlockCatalog, type BlockCatalogDto, type CatalogBlockDto } from "./catalog";
import { clearArtCache } from "./useArt";

const WINDOWS_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0";

let fetchMock: ReturnType<typeof vi.fn>;
let warn: MockInstance<typeof console.warn>;

beforeEach(() => {
  vi.stubGlobal("navigator", { userAgent: WINDOWS_UA });
  fetchMock = vi.fn(async () => ({ ok: true, status: 200, blob: async () => new Blob(["x"]) }));
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("createImageBitmap", vi.fn(async () => ({ width: 16, height: 16 })));
  warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

afterEach(() => {
  setArtStatus(NO_ART);
  setBlockCatalog(null);
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

function block(id: string, extra: Partial<CatalogBlockDto> = {}): CatalogBlockDto {
  return { id, top: `block/${id}`, side: `block/${id}`, front: null, top_tint: null, side_tint: null, hue: 30, name_en: null, name_zh: null, ...extra };
}

const catalogDto = (versionId: string, ...ids: string[]): BlockCatalogDto => ({ version_id: versionId, blocks: ids.map((id) => block(id)) });

/** 目录载入结果的回报与重查入口：不关心它们的用例用这份。 */
const hooks = () => ({ onCatalog: vi.fn(), reloadRequests: vi.fn(() => () => undefined) });

/** 目录查询恒为 null：只关心材质状态的用例用它。 */
const noCatalog = () => vi.fn(async (): Promise<BlockCatalogDto | null> => null);

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
    const loadCatalog = vi.fn(async () => {
      order.push("catalog");
      return catalogDto("1.21.1", "oak_log");
    });
    const dispose = await bindArtStatus({ ...hooks(),  load, loadCatalog, listenChanged: events.listenChanged, onError: vi.fn() });
    await flush();
    expect(order).toEqual(["listen", "load", "catalog"]);
    expect(getArtStatus()).toEqual({ source: { versionId: "1.21.1" }, panorama: false });
    const urls = fetchMock.mock.calls.map((c) => String(c[0]));
    expect(urls).toHaveLength(17);
    expect(urls).toContain("http://petalfall-tex.localhost/art/block/grass_block_top.png?v=1.21.1");
    expect(urls.every((u) => u.endsWith("?v=1.21.1"))).toBe(true);
    dispose();
    expect(events.unlisten).toHaveBeenCalledTimes(1);
  });

  it("材质源就绪后载入方块目录：校验、转换后整份放进目录仓库", async () => {
    const events = eventSource();
    const loadCatalog = vi.fn(async (): Promise<BlockCatalogDto> => ({
      version_id: "1.21.1",
      blocks: [block("furnace", { top: "block/furnace_top", side: "block/furnace_side", front: "block/furnace_front", hue: 0, name_zh: "熔炉" }), block("oak_log", { top: "block/oak_log_top" })],
    }));
    await bindArtStatus({ ...hooks(),  load: async () => ({ source: { version_id: "1.21.1" }, panorama: false }), loadCatalog, listenChanged: events.listenChanged, onError: vi.fn() });
    await flush();
    const catalog = getBlockCatalog();
    expect(catalog?.versionId).toBe("1.21.1");
    expect(catalog?.blocks.map((b) => b.id)).toEqual(["furnace", "oak_log"]);
    expect(catalog?.byId.get("furnace")).toMatchObject({ top: "block/furnace_top", side: "block/furnace_side", front: "block/furnace_front", nameZh: "熔炉" });
    expect(catalog?.byId.get("oak_log")?.top).toBe("block/oak_log_top");
    expect(warn).not.toHaveBeenCalled();
  });

  it("没有材质源时不预加载任何图，也不查目录", async () => {
    const events = eventSource();
    const loadCatalog = noCatalog();
    await bindArtStatus({ ...hooks(),  load: async () => ({ source: null, panorama: true }), loadCatalog, listenChanged: events.listenChanged, onError: vi.fn() });
    await flush();
    expect(getArtStatus()).toEqual({ source: null, panorama: true });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(loadCatalog).not.toHaveBeenCalled();
    expect(getBlockCatalog()).toBeNull();
  });

  it("收到变化事件即重新查询，首次装好游戏后状态切到新材质源，目录随之载入", async () => {
    const events = eventSource();
    const load = vi
      .fn<() => Promise<ArtStatusDto>>()
      .mockResolvedValueOnce({ source: null, panorama: false })
      .mockResolvedValueOnce({ source: { version_id: "1.20.1" }, panorama: true });
    const loadCatalog = vi.fn(async () => catalogDto("1.20.1", "oak_log"));
    await bindArtStatus({ ...hooks(),  load, loadCatalog, listenChanged: events.listenChanged, onError: vi.fn() });
    expect(getArtStatus().source).toBeNull();
    expect(loadCatalog).not.toHaveBeenCalled();
    events.fire();
    await flush();
    expect(load).toHaveBeenCalledTimes(2);
    expect(getArtStatus()).toEqual({ source: { versionId: "1.20.1" }, panorama: true });
    expect(loadCatalog).toHaveBeenCalledTimes(1);
    expect(getBlockCatalog()?.versionId).toBe("1.20.1");
  });

  it("材质源变为 null 时清空目录", async () => {
    const events = eventSource();
    const load = vi
      .fn<() => Promise<ArtStatusDto>>()
      .mockResolvedValueOnce({ source: { version_id: "1.21.1" }, panorama: false })
      .mockResolvedValueOnce({ source: null, panorama: false });
    const loadCatalog = vi.fn(async () => catalogDto("1.21.1", "oak_log"));
    await bindArtStatus({ ...hooks(),  load, loadCatalog, listenChanged: events.listenChanged, onError: vi.fn() });
    await flush();
    expect(getBlockCatalog()?.byId.has("oak_log")).toBe(true);
    events.fire();
    await flush();
    expect(getArtStatus().source).toBeNull();
    expect(getBlockCatalog()).toBeNull();
    expect(loadCatalog).toHaveBeenCalledTimes(1);
  });

  it("每次变化事件都重新查目录，换了材质源时整份替换", async () => {
    const events = eventSource();
    const load = vi
      .fn<() => Promise<ArtStatusDto>>()
      .mockResolvedValueOnce({ source: { version_id: "1.20.1" }, panorama: false })
      .mockResolvedValueOnce({ source: { version_id: "1.21.4" }, panorama: false });
    const loadCatalog = vi.fn<() => Promise<BlockCatalogDto | null>>().mockResolvedValueOnce(catalogDto("1.20.1", "oak_log")).mockResolvedValueOnce(catalogDto("1.21.4", "pale_oak_log"));
    await bindArtStatus({ ...hooks(),  load, loadCatalog, listenChanged: events.listenChanged, onError: vi.fn() });
    await flush();
    const first = getBlockCatalog();
    events.fire();
    await flush();
    const second = getBlockCatalog();
    expect(second).not.toBe(first);
    expect(second?.versionId).toBe("1.21.4");
    expect(second?.blocks.map((b) => b.id)).toEqual(["pale_oak_log"]);
  });

  it("目录载入失败交给 onError，材质状态照常写入，绑定不撤销", async () => {
    const events = eventSource();
    const onError = vi.fn();
    const failure = new Error("目录不可用");
    const load = vi.fn(async (): Promise<ArtStatusDto> => ({ source: { version_id: "1.21.1" }, panorama: false }));
    const loadCatalog = vi.fn<() => Promise<BlockCatalogDto | null>>().mockRejectedValueOnce(failure).mockResolvedValueOnce(catalogDto("1.21.1", "oak_log"));
    await bindArtStatus({ ...hooks(),  load, loadCatalog, listenChanged: events.listenChanged, onError });
    await flush();
    expect(onError).toHaveBeenCalledWith(failure);
    expect(getArtStatus().source).toEqual({ versionId: "1.21.1" });
    expect(getBlockCatalog()).toBeNull();
    expect(events.unlisten).not.toHaveBeenCalled();
    // 下次变化事件重新查到目录
    events.fire();
    await flush();
    expect(getBlockCatalog()?.byId.has("oak_log")).toBe(true);
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it("目录形状不对：catalogFromDto 的错误交给 onError，旧目录保留", async () => {
    const events = eventSource();
    const onError = vi.fn();
    const loadCatalog = vi
      .fn<() => Promise<BlockCatalogDto | null>>()
      .mockResolvedValueOnce(catalogDto("1.21.1", "oak_log"))
      .mockResolvedValueOnce({ version_id: "1.21.1", blocks: [block("oak_log", { side: "item/apple" })] });
    await bindArtStatus({ ...hooks(),  load: async () => ({ source: { version_id: "1.21.1" }, panorama: false }), loadCatalog, listenChanged: events.listenChanged, onError });
    await flush();
    const before = getBlockCatalog();
    events.fire();
    await flush();
    expect(onError).toHaveBeenCalledTimes(1);
    expect(String(onError.mock.calls[0][0])).toContain("不是方块材质路径");
    expect(getBlockCatalog()).toBe(before);
  });

  it("目录与材质源版本对不上时照实放进去并记 warn", async () => {
    const events = eventSource();
    await bindArtStatus({ ...hooks(), 
      load: async () => ({ source: { version_id: "1.21.1" }, panorama: false }),
      loadCatalog: async () => catalogDto("1.21.4", "oak_log"),
      listenChanged: events.listenChanged,
      onError: vi.fn(),
    });
    await flush();
    expect(getBlockCatalog()?.versionId).toBe("1.21.4");
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain("1.21.4");
    expect(String(warn.mock.calls[0][0])).toContain("1.21.1");
  });

  it("只认最后一次查询：前一次迟到的目录不会盖掉后一次的", async () => {
    const events = eventSource();
    const load = vi
      .fn<() => Promise<ArtStatusDto>>()
      .mockResolvedValueOnce({ source: { version_id: "1.20.1" }, panorama: false })
      .mockResolvedValueOnce({ source: { version_id: "1.21.4" }, panorama: false });
    let releaseOld: ((dto: BlockCatalogDto) => void) | undefined;
    const loadCatalog = vi
      .fn<() => Promise<BlockCatalogDto | null>>()
      .mockImplementationOnce(() => new Promise((resolve) => (releaseOld = resolve)))
      .mockResolvedValueOnce(catalogDto("1.21.4", "pale_oak_log"));
    await bindArtStatus({ ...hooks(),  load, loadCatalog, listenChanged: events.listenChanged, onError: vi.fn() });
    events.fire();
    await flush();
    expect(getBlockCatalog()?.versionId).toBe("1.21.4");
    releaseOld?.(catalogDto("1.20.1", "oak_log"));
    await flush();
    expect(getBlockCatalog()?.versionId).toBe("1.21.4");
    expect(warn).not.toHaveBeenCalled();
  });

  it("目录还在路上时材质源变为 null：清空后不被迟到的目录写回", async () => {
    const events = eventSource();
    const load = vi
      .fn<() => Promise<ArtStatusDto>>()
      .mockResolvedValueOnce({ source: { version_id: "1.21.1" }, panorama: false })
      .mockResolvedValueOnce({ source: null, panorama: false });
    let release: ((dto: BlockCatalogDto) => void) | undefined;
    const loadCatalog = vi.fn(() => new Promise<BlockCatalogDto | null>((resolve) => (release = resolve)));
    await bindArtStatus({ ...hooks(),  load, loadCatalog, listenChanged: events.listenChanged, onError: vi.fn() });
    events.fire();
    await flush();
    release?.(catalogDto("1.21.1", "oak_log"));
    await flush();
    expect(getBlockCatalog()).toBeNull();
  });

  it("事件触发的查询失败交给 onError，状态保持原样", async () => {
    const events = eventSource();
    const onError = vi.fn();
    const failure = new Error("后端不可用");
    const load = vi.fn<() => Promise<ArtStatusDto>>().mockResolvedValueOnce({ source: { version_id: "1.21.1" }, panorama: false }).mockRejectedValueOnce(failure);
    await bindArtStatus({ ...hooks(),  load, loadCatalog: noCatalog(), listenChanged: events.listenChanged, onError });
    events.fire();
    await flush();
    expect(onError).toHaveBeenCalledWith(failure);
    expect(getArtStatus().source).toEqual({ versionId: "1.21.1" });
  });

  it("首查失败撤销订阅并抛出；返回值形状不对同样抛出", async () => {
    const events = eventSource();
    await expect(bindArtStatus({ ...hooks(),  load: async () => Promise.reject(new Error("拒绝")), loadCatalog: noCatalog(), listenChanged: events.listenChanged, onError: vi.fn() })).rejects.toThrow("拒绝");
    expect(events.unlisten).toHaveBeenCalledTimes(1);

    const bad = eventSource();
    await expect(bindArtStatus({ ...hooks(),  load: async () => ({ source: "1.21" }) as never, loadCatalog: noCatalog(), listenChanged: bad.listenChanged, onError: vi.fn() })).rejects.toThrow("panorama");
    expect(bad.unlisten).toHaveBeenCalledTimes(1);
  });

  it("解除绑定后迟到的查询结果不再写入", async () => {
    const events = eventSource();
    let release: ((dto: ArtStatusDto) => void) | undefined;
    const load = vi
      .fn<() => Promise<ArtStatusDto>>()
      .mockResolvedValueOnce({ source: null, panorama: false })
      .mockImplementationOnce(() => new Promise((resolve) => (release = resolve)));
    const dispose = await bindArtStatus({ ...hooks(),  load, loadCatalog: noCatalog(), listenChanged: events.listenChanged, onError: vi.fn() });
    events.fire();
    dispose();
    release?.({ source: { version_id: "1.21.1" }, panorama: true });
    await flush();
    expect(getArtStatus()).toEqual(NO_ART);
  });

  it("每次查询报告目录载没载入：载入了为 true，材质源为空、目录查询失败、状态查询失败都为 false", async () => {
    const events = eventSource();
    const onCatalog = vi.fn();
    const onError = vi.fn();
    const load = vi
      .fn<() => Promise<ArtStatusDto>>()
      .mockResolvedValueOnce({ source: { version_id: "1.21.1" }, panorama: false })
      .mockResolvedValueOnce({ source: null, panorama: false })
      .mockResolvedValueOnce({ source: { version_id: "1.21.1" }, panorama: false })
      .mockRejectedValueOnce(new Error("后端不可用"));
    const loadCatalog = vi
      .fn<() => Promise<BlockCatalogDto | null>>()
      .mockResolvedValueOnce(catalogDto("1.21.1", "oak_log"))
      .mockResolvedValueOnce({ version_id: "1.21.1", blocks: [block("Bad Id")] });
    await bindArtStatus({ ...hooks(), load, loadCatalog, listenChanged: events.listenChanged, onError, onCatalog });
    await vi.waitFor(() => expect(onCatalog).toHaveBeenCalledTimes(1));
    expect(onCatalog).toHaveBeenLastCalledWith(true);

    events.fire();
    await vi.waitFor(() => expect(onCatalog).toHaveBeenCalledTimes(2));
    expect(onCatalog).toHaveBeenLastCalledWith(false);

    // 目录校验被拒：报 false，错误照常交给 onError
    events.fire();
    await vi.waitFor(() => expect(onCatalog).toHaveBeenCalledTimes(3));
    expect(onCatalog).toHaveBeenLastCalledWith(false);
    expect(onError).toHaveBeenCalledTimes(1);

    events.fire();
    await vi.waitFor(() => expect(onCatalog).toHaveBeenCalledTimes(4));
    expect(onCatalog).toHaveBeenLastCalledWith(false);
    expect(onError).toHaveBeenCalledTimes(2);
    expect(onError).toHaveBeenLastCalledWith(new Error("后端不可用"));
  });

  it("被更新的查询作废的结果不报", async () => {
    const events = eventSource();
    const onCatalog = vi.fn();
    let releaseFirst: ((dto: BlockCatalogDto) => void) | undefined;
    const loadCatalog = vi
      .fn<() => Promise<BlockCatalogDto | null>>()
      .mockImplementationOnce(() => new Promise((resolve) => (releaseFirst = resolve)))
      .mockResolvedValueOnce(catalogDto("1.21.1", "oak_log"));
    await bindArtStatus({ ...hooks(), load: async () => ({ source: { version_id: "1.21.1" }, panorama: false }), loadCatalog, listenChanged: events.listenChanged, onError: vi.fn(), onCatalog });
    events.fire();
    await vi.waitFor(() => expect(onCatalog).toHaveBeenCalledTimes(1));
    releaseFirst?.(catalogDto("1.21.1", "stone"));
    await flush();
    expect(onCatalog).toHaveBeenCalledTimes(1);
    expect(getBlockCatalog()?.blocks.map((b) => b.id)).toEqual(["oak_log"]);
  });

  it("登记的重查入口触发一次完整查询；解除绑定时注销，首查失败时也注销", async () => {
    const events = eventSource();
    const unregister = vi.fn();
    let reload: (() => void) | undefined;
    const reloadRequests = vi.fn((r: () => void) => {
      reload = r;
      return unregister;
    });
    const load = vi.fn(async (): Promise<ArtStatusDto> => ({ source: null, panorama: false }));
    const dispose = await bindArtStatus({ ...hooks(), load, loadCatalog: noCatalog(), listenChanged: events.listenChanged, onError: vi.fn(), reloadRequests });
    expect(load).toHaveBeenCalledTimes(1);
    reload?.();
    await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(2));
    dispose();
    expect(unregister).toHaveBeenCalledTimes(1);

    const failedUnregister = vi.fn();
    await expect(
      bindArtStatus({ ...hooks(), load: async () => Promise.reject(new Error("拒绝")), loadCatalog: noCatalog(), listenChanged: eventSource().listenChanged, onError: vi.fn(), reloadRequests: () => failedUnregister }),
    ).rejects.toThrow("拒绝");
    expect(failedUnregister).toHaveBeenCalledTimes(1);
  });

  it("解除绑定后迟到的目录不再写入", async () => {
    const events = eventSource();
    let release: ((dto: BlockCatalogDto) => void) | undefined;
    const loadCatalog = vi.fn(() => new Promise<BlockCatalogDto | null>((resolve) => (release = resolve)));
    const dispose = await bindArtStatus({ ...hooks(),  load: async () => ({ source: { version_id: "1.21.1" }, panorama: false }), loadCatalog, listenChanged: events.listenChanged, onError: vi.fn() });
    dispose();
    release?.(catalogDto("1.21.1", "oak_log"));
    await flush();
    expect(getBlockCatalog()).toBeNull();
  });
});
