import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ArtDownloadProgressDto, ArtStatusDto } from "../ipc/art";
import { IpcError } from "../ipc/errors";
import { downloadArt, getArtDownloadState } from "./art-download";

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

afterEach(() => {
  expect(getArtDownloadState()).toEqual({ running: false });
});

describe("下载原版材质", () => {
  it("先订阅进度再调用后端，进度逐条写进状态，完成后退订并回到未下载", async () => {
    const done = downloadArt();
    expect(getArtDownloadState()).toEqual({ running: true, progress: null });
    await untilInvoked();
    expect(art.log).toEqual(["listen", "invoke"]);

    emit({ stage: "client", downloaded: 1_048_576, total: 27_350_016 });
    expect(getArtDownloadState()).toEqual({ running: true, progress: { stage: "client", downloaded: 1_048_576, total: 27_350_016 } });
    emit({ stage: "extract", downloaded: 0, total: null });
    expect(getArtDownloadState()).toEqual({ running: true, progress: { stage: "extract", downloaded: 0, total: null } });

    art.pending[0].resolve(READY);
    await done;
    expect(art.log).toEqual(["listen", "invoke", "unlisten"]);
    expect(getArtDownloadState()).toEqual({ running: false });
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

  it("失败时原样抛出、退订并回到未下载，再调一次会重新请求后端", async () => {
    const failure = new IpcError("download_failed", "client.jar 的 SHA-1 与版本清单不符");
    const first = downloadArt();
    await untilInvoked();
    art.pending[0].reject(failure);
    await expect(first).rejects.toBe(failure);
    expect(art.log).toEqual(["listen", "invoke", "unlisten"]);
    expect(getArtDownloadState()).toEqual({ running: false });

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
  });

  it("退订之后才到的进度不再写进状态", async () => {
    const done = downloadArt();
    await untilInvoked();
    art.pending[0].resolve(READY);
    await done;
    emit({ stage: "names", downloaded: 10, total: 20 });
    expect(getArtDownloadState()).toEqual({ running: false });
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
    expect(getArtDownloadState()).toEqual({ running: true, progress: null });
    art.pending[0].resolve(READY);
    await done;
  });
});
