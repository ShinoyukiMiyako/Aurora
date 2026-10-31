import { invoke as tauriInvoke } from "@tauri-apps/api/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { addGameDirectory, getConfig, listGameDirectories, updateConfig } from "./config";
import { IpcError } from "./errors";
import { resetMocks } from "./mock";
import { clearMockEventListeners } from "./mock/events";
import {
  checkUpdate,
  completeFirstRun,
  downloadUpdate,
  installUpdate,
  isFirstRun,
  listKnownServers,
  listNews,
  listPinnedServers,
  memoryAdvice,
  pingServers,
  setInstallOnExit,
  setPinnedServers,
  startupNotices,
  updaterInfo,
} from "./system";
import { setMockStartupNotices } from "./mock/handlers/system";
import { cancelTask, onCoreEvent, type CoreEvent } from "./tasks";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));

async function rejection(promise: Promise<unknown>): Promise<IpcError> {
  const error = await promise.catch((e: unknown) => e);
  expect(error).toBeInstanceOf(IpcError);
  return error as IpcError;
}

/** 推进假时钟直到 promise 落定：mock 长任务按步 setTimeout 推进度。 */
async function settle<T>(promise: Promise<T>): Promise<T> {
  let done = false;
  promise.then(
    () => (done = true),
    () => (done = true),
  );
  while (!done) await vi.advanceTimersByTimeAsync(50);
  return promise;
}

beforeEach(() => {
  vi.clearAllMocks();
  resetMocks();
  clearMockEventListeners();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("启动提示", () => {
  it("没有提示时为空列表；配置被重置时给出留存路径与原因，查询多少次都一样", async () => {
    expect(await startupNotices()).toEqual([]);
    const notice = {
      kind: "config_reset" as const,
      preserved_path: "C:/Users/me/AppData/Local/Petalfall/config.json.broken-20261031-143025",
      error: "unknown variant `hide` at line 1 column 22",
    };
    setMockStartupNotices([notice]);
    expect(await startupNotices()).toEqual([notice]);
    expect(await startupNotices()).toEqual([notice]);
    resetMocks();
    expect(await startupNotices()).toEqual([]);
  });

  it("Tauri 里不带参数调用 startup_notices", async () => {
    vi.stubGlobal("window", { __TAURI_INTERNALS__: {} });
    vi.mocked(tauriInvoke).mockResolvedValueOnce([]);
    await startupNotices();
    expect(vi.mocked(tauriInvoke).mock.calls).toEqual([["startup_notices", undefined]]);
  });
});

describe("内存建议", () => {
  it("按实例定档，推荐值不超过物理内存一半", async () => {
    const vanilla = await memoryAdvice();
    expect(vanilla).toEqual({ total_mb: 16384, available_mb: 9216, tier: "vanilla", recommended_mb: 3840 });
    const modded = await memoryAdvice("1.21.4-fabric");
    expect(modded.tier).toBe("modded");
    expect(modded.recommended_mb * 2).toBeLessThanOrEqual(modded.total_mb);
  });
});

describe("首次启动", () => {
  it("校验不过整次不生效，仍是首次启动", async () => {
    expect(await isFirstRun()).toBe(true);
    const bang = await rejection(completeFirstRun("D:\\a!b\\.minecraft", []));
    expect(bang.code).toBe("invalid_game_directory");
    expect(bang.detail).toEqual({ path: "D:\\a!b\\.minecraft", problem: "contains_bang" });
    const unnamed = await rejection(completeFirstRun("D:\\Games\\New\\.minecraft", [{ name: " ", path: "D:\\HMCL\\.minecraft" }]));
    expect(unnamed.code).toBe("invalid_argument");
    expect(await isFirstRun()).toBe(true);
    expect((await getConfig()).game_dir).toBe("D:\\Games\\Launcher\\.minecraft");
  });

  it("提交后目录设为当前、收下勾选的目录、不再是首次启动", async () => {
    await completeFirstRun("D:\\Games\\New\\.minecraft", [{ name: "HMCL", path: "D:\\HMCL\\.minecraft" }]);
    expect(await isFirstRun()).toBe(false);
    expect((await getConfig()).game_dir).toBe("D:\\Games\\New\\.minecraft");
    expect(await listGameDirectories()).toEqual([
      { name: "New", path: "D:\\Games\\New\\.minecraft", is_current: true, available: true },
      { name: "默认目录", path: "D:\\Games\\Launcher\\.minecraft", is_current: false, available: true },
      { name: "HMCL", path: "D:\\HMCL\\.minecraft", is_current: false, available: true },
    ]);
  });
});

describe("服务器", () => {
  it("固定列表整体替换：同地址去重、空名字用地址", async () => {
    const saved = await setPinnedServers([
      { name: "", address: " play.example.cn:25566 " },
      { name: "重复", address: "PLAY.example.cn:25566" },
      { name: "默认端口", address: "mc.example.cn" },
      { name: "同一台", address: "mc.example.cn:25565" },
    ]);
    expect(saved).toEqual([
      { name: "play.example.cn:25566", address: "play.example.cn:25566" },
      { name: "默认端口", address: "mc.example.cn" },
    ]);
    expect(await listPinnedServers()).toEqual(saved);
  });

  it("有一个地址不合法整体拒绝，原列表不变", async () => {
    const before = await listPinnedServers();
    for (const address of ["x:0", "x:65536", "x:abc", "", "[::1", "a b"]) {
      const error = await rejection(setPinnedServers([{ name: "好", address: "ok.example" }, { name: "坏", address }]));
      expect(error.code).toBe("invalid_argument");
      expect(error.detail).toMatchObject({ address });
    }
    expect(await listPinnedServers()).toEqual(before);
  });

  it("多人列表标出已固定；查询结果与入参同序，连不上记为 reachable false", async () => {
    expect(await listKnownServers()).toEqual([
      { name: "晨星生存服", address: "play.morningstar.example", pinned: true },
      { name: "小镇建筑服", address: "build.town.example:25570", pinned: true },
      { name: "本地测试", address: "localhost", pinned: false },
    ]);
    const pinned = await pingServers();
    expect(pinned.map((s) => [s.address, s.reachable, s.online])).toEqual([
      ["play.morningstar.example", true, 127],
      ["build.town.example:25570", false, null],
    ]);
    expect(pinned[1].last_online).toBe(9);
    const custom = await pingServers(["localhost", "PLAY.morningstar.example:25565"]);
    expect(custom.map((s) => [s.address, s.reachable])).toEqual([
      ["localhost", false],
      ["PLAY.morningstar.example:25565", true],
    ]);
    expect((await rejection(pingServers(["ok.example", "bad:0"]))).detail).toMatchObject({ address: "bad:0" });
    expect(await pingServers([])).toEqual([]);
  });
});

describe("资讯", () => {
  it("按发布时刻倒序，缺图的条目缩略图为 null", async () => {
    const feed = await listNews();
    expect(feed.offline).toBe(false);
    const dates = feed.items.map((i) => i.date);
    expect(dates).toEqual([...dates].sort((a, b) => b - a));
    expect(feed.items.map((i) => i.tag)).toEqual(["snapshot", "release", "event"]);
    expect(feed.items[2]).toMatchObject({ thumbnail_url: null, game_version: null });
  });
});

describe("自更新", () => {
  it("没检查就下载、没下载就安装或退出时安装，都按后端错误码拒绝", async () => {
    expect(await updaterInfo()).toEqual({
      current_version: "0.1.0",
      supported: true,
      unsupported_reason: null,
      available: null,
      downloaded_version: null,
      install_on_exit: false,
    });
    expect((await rejection(downloadUpdate("u-0"))).code).toBe("update_not_available");
    expect((await rejection(setInstallOnExit(true))).code).toBe("update_not_ready");
    expect((await rejection(installUpdate())).code).toBe("update_not_ready");
  });

  it("检查、下载（进度带 task_id）、退出时安装、安装后为新版本", async () => {
    vi.useFakeTimers();
    const update = await checkUpdate();
    expect(update).toMatchObject({ version: "0.2.0", current_version: "0.1.0" });

    const events: CoreEvent[] = [];
    await onCoreEvent((e) => events.push(e));
    expect(await settle(downloadUpdate("u-1"))).toEqual(update);
    const downloads = events.filter((e) => e.kind === "download");
    expect(downloads.length).toBeGreaterThan(1);
    expect(events.every((e) => e.task_id === "u-1")).toBe(true);
    expect(downloads.every((e) => e.kind === "download" && e.total === 1 && e.bytes <= (e.total_bytes as number))).toBe(true);
    expect(downloads[downloads.length - 1]).toMatchObject({ finished: 1, bytes: 12_582_912 });
    expect(events[events.length - 1]).toMatchObject({ kind: "stage" });

    await setInstallOnExit(true);
    expect(await updaterInfo()).toMatchObject({ downloaded_version: "0.2.0", install_on_exit: true });
    await installUpdate();
    expect(await updaterInfo()).toMatchObject({ current_version: "0.2.0", downloaded_version: null, install_on_exit: false });
    expect(await checkUpdate()).toBeNull();
  });

  it("下载途中取消以 cancelled 结束，不留下已下载的包", async () => {
    vi.useFakeTimers();
    await checkUpdate();
    const pending = downloadUpdate("u-2");
    await vi.advanceTimersByTimeAsync(130);
    expect(await cancelTask("u-2")).toBe(true);
    expect((await rejection(settle(pending))).code).toBe("cancelled");
    expect((await updaterInfo()).downloaded_version).toBeNull();
  });
});

// 键名逐个对应 Rust 命令形参的 camelCase 形式；对不上时 Tauri 以参数错误拒绝整条命令。
describe("Tauri 窗口里的参数键", () => {
  beforeEach(() => {
    vi.stubGlobal("window", { __TAURI_INTERNALS__: {} });
  });

  it("与 Rust 形参一致", async () => {
    vi.mocked(tauriInvoke).mockResolvedValue(null);
    await updateConfig({ afterLaunch: "keep", checkUpdates: true, defaultJava: "auto", notifiedUpdateVersion: "0.2.0" });
    await addGameDirectory("HMCL", "D:\\HMCL\\.minecraft");
    await memoryAdvice("1.21.4");
    await completeFirstRun("D:\\Games\\.minecraft", [{ name: "HMCL", path: "D:\\HMCL\\.minecraft" }]);
    await setPinnedServers([{ name: "a", address: "a.example" }]);
    await pingServers(["a.example"]);
    await downloadUpdate("u-9");
    await setInstallOnExit(false);
    expect(vi.mocked(tauriInvoke).mock.calls).toEqual([
      ["update_config", { afterLaunch: "keep", checkUpdates: true, defaultJava: "auto", notifiedUpdateVersion: "0.2.0" }],
      ["add_game_directory", { name: "HMCL", path: "D:\\HMCL\\.minecraft" }],
      ["memory_advice", { versionId: "1.21.4" }],
      ["complete_first_run", { gameDir: "D:\\Games\\.minecraft", extraDirectories: [{ name: "HMCL", path: "D:\\HMCL\\.minecraft" }] }],
      ["set_pinned_servers", { servers: [{ name: "a", address: "a.example" }] }],
      ["ping_servers", { addresses: ["a.example"] }],
      ["download_update", { taskId: "u-9" }],
      ["set_install_on_exit", { enabled: false }],
    ]);
  });
});
