import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ArtDownloadProgressDto, ArtStatusDto } from "../ipc/art";
import { IpcError } from "../ipc/errors";
import { downloadArt, getArtDownloadState, registerCatalogReload, settleArtDownload } from "./art-download";

interface Pending {
  resolve(status: ArtStatusDto): void;
  reject(error: unknown): void;
}

const art = vi.hoisted(() => ({
  log: [] as string[],
  /** 最近一次订阅的进度回调；退订后仍留着，用来模拟退订之后才到的事件。 */
  handler: null as ((p: ArtDownloadProgressDto) => void) | null,
  pending: [] as Pending[],
}));

vi.mock("../ipc/art", async (orig) => ({
  ...(await orig<typeof import("../ipc/art")>()),
  onArtDownload: async (handler: (p: ArtDownloadProgressDto) => void) => {
    art.log.push("listen");
    art.handler = handler;
    return () => {
      art.log.push("unlisten");
    };
  },
  artDownload: () => {
    art.log.push("invoke");
    return new Promise<ArtStatusDto>((resolve, reject) => art.pending.push({ resolve, reject }));
  },
}));

const READY: ArtStatusDto = { source: { version_id: "1.21.4" }, panorama: false };

/** 让 downloadArt 走到调用后端那一步（订阅是异步的）。 */
const untilInvoked = () => vi.waitFor(() => expect(art.pending.length).toBeGreaterThan(0));

function emit(progress: ArtDownloadProgressDto): void {
  if (art.handler === null) throw new Error("还没有订阅进度");
  art.handler(progress);
}

beforeEach(() => {
  art.log.length = 0;
  art.handler = null;
  art.pending.length = 0;
});

// 每个用例结束时不能还在下；收尾时替材质绑定报告目录载入了，把下完后的等待与失败都清回 idle
afterEach(() => {
  settleArtDownload(true);
  expect(getArtDownloadState()).toEqual({ phase: "idle" });
});

describe("下载原版材质", () => {
  it("先订阅进度再调用后端，进度逐条写进状态，完成后退订并转为等目录", async () => {
    const done = downloadArt();
    expect(getArtDownloadState()).toEqual({ phase: "running", progress: null });
    await untilInvoked();
    expect(art.log).toEqual(["listen", "invoke"]);

    emit({ stage: "client", downloaded: 1_048_576, total: 27_350_016 });
    expect(getArtDownloadState()).toEqual({ phase: "running", progress: { stage: "client", downloaded: 1_048_576, total: 27_350_016 } });
    emit({ stage: "extract", downloaded: 0, total: null });
    expect(getArtDownloadState()).toEqual({ phase: "running", progress: { stage: "extract", downloaded: 0, total: null } });

    art.pending[0].resolve(READY);
    await done;
    expect(art.log).toEqual(["listen", "invoke", "unlisten"]);
    expect(getArtDownloadState()).toEqual({ phase: "finishing" });
  });

  it("下载中再调用拿到同一个 Promise，后端只调一次", async () => {
    const first = downloadArt();
    const second = downloadArt();
    expect(second).toBe(first);
    await untilInvoked();
    art.pending[0].resolve(READY);
    await Promise.all([first, second]);
    expect(art.log.filter((e) => e === "invoke")).toHaveLength(1);
  });

  it("失败时原样抛出、退订并转为下载阶段的可重试，再调一次会重新请求后端", async () => {
    const failure = new IpcError("download_failed", "client.jar 的 SHA-1 与版本清单不符");
    const first = downloadArt();
    await untilInvoked();
    art.pending[0].reject(failure);
    await expect(first).rejects.toBe(failure);
    expect(art.log).toEqual(["listen", "invoke", "unlisten"]);
    expect(getArtDownloadState()).toEqual({ phase: "failed", stage: "download" });

    const retry = downloadArt();
    expect(retry).not.toBe(first);
    await vi.waitFor(() => expect(art.pending).toHaveLength(2));
    art.pending[1].resolve(READY);
    await retry;
    expect(art.log).toEqual(["listen", "invoke", "unlisten", "listen", "invoke", "unlisten"]);
  });

  it("后端说下完了却仍没有材质源：当作失败抛出", async () => {
    const done = downloadArt();
    await untilInvoked();
    art.pending[0].resolve({ source: null, panorama: false });
    await expect(done).rejects.toThrow("原版材质下载完成，后端却仍报告没有材质源");
    expect(getArtDownloadState()).toEqual({ phase: "failed", stage: "download" });
  });

  it("退订之后才到的进度不再写进状态", async () => {
    const done = downloadArt();
    await untilInvoked();
    art.pending[0].resolve(READY);
    await done;
    emit({ stage: "names", downloaded: 10, total: 20 });
    expect(getArtDownloadState()).toEqual({ phase: "finishing" });
  });

  it.each([
    { stage: "unpack", downloaded: 0, total: null },
    { stage: "client", downloaded: -1, total: 10 },
    { stage: "client", downloaded: 1.5, total: 10 },
    { stage: "client", downloaded: 1, total: "10" },
  ])("进度形状不对（%o）直接抛错，不写进状态", async (bad) => {
    const done = downloadArt();
    await untilInvoked();
    expect(() => emit(bad as unknown as ArtDownloadProgressDto)).toThrow("art-download 进度形状不对");
    expect(getArtDownloadState()).toEqual({ phase: "running", progress: null });
    art.pending[0].resolve(READY);
    await done;
  });
});

describe("下完之后等方块目录", () => {
  async function downloaded() {
    const done = downloadArt();
    await untilInvoked();
    art.pending[art.pending.length - 1].resolve(READY);
    await done;
    expect(getArtDownloadState()).toEqual({ phase: "finishing" });
  }

  it("材质绑定报告目录载入了：回到 idle", async () => {
    await downloaded();
    settleArtDownload(true);
    expect(getArtDownloadState()).toEqual({ phase: "idle" });
  });

  it("材质绑定报告目录没能载入：离开等待、转为目录阶段的可重试；重试只请绑定重查，不再整包重下", async () => {
    const reload = vi.fn();
    const unregister = registerCatalogReload(reload);
    await downloaded();
    expect(reload).toHaveBeenCalledTimes(1);
    settleArtDownload(false);
    expect(getArtDownloadState()).toEqual({ phase: "failed", stage: "catalog" });

    await downloadArt();
    expect(getArtDownloadState()).toEqual({ phase: "finishing" });
    expect(reload).toHaveBeenCalledTimes(2);
    expect(art.log.filter((e) => e === "invoke")).toHaveLength(1);
    unregister();
  });

  it("下完时请登记的材质绑定重查一次：绑定那次查询可能早于下载命令返回就结束了；注销后不再请求", async () => {
    const reload = vi.fn(() => {
      // 请求重查时已经在等目录，绑定随后报告的结果才会被认
      expect(getArtDownloadState()).toEqual({ phase: "finishing" });
    });
    const unregister = registerCatalogReload(reload);
    await downloaded();
    expect(reload).toHaveBeenCalledTimes(1);
    settleArtDownload(true);

    unregister();
    await downloaded();
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("注销旧入口不会摘掉后来登记的入口", async () => {
    const first = vi.fn();
    const second = vi.fn();
    const unregisterFirst = registerCatalogReload(first);
    const unregisterSecond = registerCatalogReload(second);
    unregisterFirst();
    await downloaded();
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
    unregisterSecond();
  });

  it("下载失败之后目录载入了（玩家另装了游戏）：回到 idle；没能载入的报告不改失败的阶段", async () => {
    const done = downloadArt();
    await untilInvoked();
    art.pending[0].reject(new IpcError("download_failed", "所有下载源都连不上"));
    await expect(done).rejects.toThrow("所有下载源都连不上");
    settleArtDownload(false);
    expect(getArtDownloadState()).toEqual({ phase: "failed", stage: "download" });
    settleArtDownload(true);
    expect(getArtDownloadState()).toEqual({ phase: "idle" });
  });

  it("没在等目录时的报告什么都不改：idle 不动，下载中的结果说的是下载之前的材质源", async () => {
    settleArtDownload(false);
    expect(getArtDownloadState()).toEqual({ phase: "idle" });
    const done = downloadArt();
    await untilInvoked();
    emit({ stage: "client", downloaded: 10, total: 20 });
    settleArtDownload(true);
    settleArtDownload(false);
    expect(getArtDownloadState()).toEqual({ phase: "running", progress: { stage: "client", downloaded: 10, total: 20 } });
    art.pending[0].resolve(READY);
    await done;
    expect(getArtDownloadState()).toEqual({ phase: "finishing" });
  });
});
