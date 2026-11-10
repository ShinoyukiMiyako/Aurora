import { invoke as tauriInvoke } from "@tauri-apps/api/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "./bridge";
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
  probeNetwork,
  SERVER_NOT_PINNED_CODE,
  setInstallOnExit,
  setPinnedServerInstance,
  setPinnedServers,
  setUpdateChannel,
  startupNotices,
  updaterInfo,
} from "./system";
import {
  setMockNetworkReachable,
  setMockStartupNotices,
  setMockUpdateDataTooNew,
  setMockUpdateManifest,
  setMockUpdatePreference,
  setMockUpdaterUnsupported,
  setMockUpdaterVersion,
  setMockUpdateSourceFailures,
  type MockUpdateManifest,
} from "./mock/handlers/system";
import { deleteInstance, listInstances, renameInstance } from "./instances";
import { cancelTask, onCoreEvent, type CoreEvent } from "./tasks";
import { mulberry32 } from "../art/illustrations/seed";

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
      preserved_path: "D:/Games/Launcher/config.json.broken-20261031-143025",
      error: "unknown variant `hide` at line 1 column 22",
    };
    setMockStartupNotices([notice]);
    expect(await startupNotices()).toEqual([notice]);
    expect(await startupNotices()).toEqual([notice]);
    resetMocks();
    expect(await startupNotices()).toEqual([]);
  });

  it("个别设置退回默认的提示原样返回；设置之后改动传入的对象不影响模拟后端", async () => {
    const fields = [
      { field: "language" as const, value: "fr-FR" },
      { field: "appearance.mode" as const, value: "" },
    ];
    const notice = { kind: "config_fields_reset" as const, fields };
    setMockStartupNotices([notice]);
    fields[0].value = "zh-CN";
    fields.push({ field: "language", value: "de-DE" });
    expect(await startupNotices()).toEqual([
      {
        kind: "config_fields_reset",
        fields: [
          { field: "language", value: "fr-FR" },
          { field: "appearance.mode", value: "" },
        ],
      },
    ]);
  });

  it("凭据库被重置的提示带着留存路径按设置的顺序原样返回；设置之后改动传入的对象不影响模拟后端", async () => {
    const config = { kind: "config_reset" as const, preserved_path: "D:/Launcher/config.json.broken-20261031-143025", error: "expected value at line 1 column 1" };
    const credentials = {
      kind: "credentials_reset" as const,
      preserved_path: "D:/Launcher/credentials.bin.broken-20261031-143025",
      error: "Windows DPAPI 解密失败: 参数错误。 (0x80070057)",
    };
    setMockStartupNotices([config, credentials]);
    credentials.preserved_path = "changed";
    expect(await startupNotices()).toEqual([
      config,
      { kind: "credentials_reset", preserved_path: "D:/Launcher/credentials.bin.broken-20261031-143025", error: "Windows DPAPI 解密失败: 参数错误。 (0x80070057)" },
    ]);
  });

  it("Tauri 里不带参数调用 startup_notices", async () => {
    vi.stubGlobal("window", { __TAURI_INTERNALS__: {} });
    vi.mocked(tauriInvoke).mockResolvedValueOnce([]);
    await startupNotices();
    expect(vi.mocked(tauriInvoke).mock.calls).toEqual([["startup_notices", undefined]]);
  });
});

describe("连通性探测", () => {
  it("mock 默认连得上；模拟断网后为 false，reset 后恢复", async () => {
    expect(await probeNetwork()).toBe(true);
    setMockNetworkReachable(false);
    expect(await probeNetwork()).toBe(false);
    resetMocks();
    expect(await probeNetwork()).toBe(true);
  });

  it("Tauri 里不带参数调用 probe_network，原样交回布尔值", async () => {
    vi.stubGlobal("window", { __TAURI_INTERNALS__: {} });
    vi.mocked(tauriInvoke).mockResolvedValueOnce(false);
    expect(await probeNetwork()).toBe(false);
    expect(vi.mocked(tauriInvoke).mock.calls).toEqual([["probe_network", undefined]]);
  });
});

describe("内存建议", () => {
  const LIMIT = { mb: 8192, reason: "half_physical" } as const;

  it("没给实例按原版估算，version_id 为 null", async () => {
    expect(await memoryAdvice()).toEqual({
      total_mb: 16384,
      available_mb: 9216,
      version_id: null,
      need_mb: 2560,
      limit: LIMIT,
      recommended_mb: 2560,
      factors: [{ kind: "base", loader: "vanilla", mb: 2560 }],
    });
  });

  it("id 里带加载器名按基数加 Mod 数估算，需求向上对齐到 512；只带 OptiFine 的按 OptiFine 基数", async () => {
    expect(await memoryAdvice("1.21.4-fabric")).toEqual({
      total_mb: 16384,
      available_mb: 9216,
      version_id: "1.21.4-fabric",
      need_mb: 4608,
      limit: LIMIT,
      recommended_mb: 4608,
      factors: [
        { kind: "base", loader: "modded", mb: 2765 },
        { kind: "mods", count: 80, mb: 1638 },
      ],
    });
    expect((await memoryAdvice("1.20.1-NeoForge")).factors[0]).toEqual({ kind: "base", loader: "modded", mb: 2765 });
    const optifine = await memoryAdvice("1.20.1-OptiFine_HD_U_I6");
    expect([optifine.need_mb, optifine.recommended_mb, optifine.factors]).toEqual([3072, 3072, [{ kind: "base", loader: "optifine", mb: 3072 }]]);
    expect((await memoryAdvice("1.21.4")).factors).toEqual([{ kind: "base", loader: "vanilla", mb: 2560 }]);
  });

  it("versionId 不是字符串按 Tauri 参数错误拒绝", async () => {
    const bad = await rejection(invoke("memory_advice", { versionId: 7 }));
    expect([bad.code, bad.message]).toEqual(["unknown", "invalid args `versionId` for command `memory_advice`: expected a string"]);
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
      { name: "New", path: "D:\\Games\\New\\.minecraft", is_current: true, available: true, version_count: 0 },
      { name: "默认目录", path: "D:\\Games\\Launcher\\.minecraft", is_current: false, available: true, version_count: 0 },
      { name: "HMCL", path: "D:\\HMCL\\.minecraft", is_current: false, available: true, version_count: 12 },
    ]);
  });
});

describe("服务器", () => {
  it("固定列表整体替换：同地址去重、空名字用地址", async () => {
    const saved = await setPinnedServers([
      { name: "", address: " play.example.cn:25566 ", instance: "1.21.1" },
      { name: "重复", address: "PLAY.example.cn:25566", instance: "RLCraft" },
      { name: "默认端口", address: "mc.example.cn", instance: null },
      { name: "同一台", address: "mc.example.cn:25565", instance: "1.21" },
    ]);
    // 去重保留第一次出现那条，连同它记住的实例
    expect(saved).toEqual([
      { name: "play.example.cn:25566", address: "play.example.cn:25566", instance: "1.21.1" },
      { name: "默认端口", address: "mc.example.cn", instance: null },
    ]);
    expect(await listPinnedServers()).toEqual(saved);
  });

  it("固定项可以不带 instance（旧调用方），读回为 null；instance 不是字符串或 null 按 Tauri 参数错误拒绝", async () => {
    const saved = await invoke<unknown>("set_pinned_servers", { servers: [{ name: "旧", address: "old.example" }] });
    expect(saved).toEqual([{ name: "旧", address: "old.example", instance: null }]);
    const typed = await rejection(invoke("set_pinned_servers", { servers: [{ name: "坏", address: "bad.example", instance: 7 }] }));
    expect(typed.code).toBe("unknown");
    const extra = await rejection(invoke("set_pinned_servers", { servers: [{ name: "多", address: "x.example", instance: null, port: 1 }] }));
    expect(extra.message).toContain("unknown field `port`");
    expect(await listPinnedServers()).toEqual(saved);
  });

  it("记住与忘掉加入用的实例：地址按去重键匹配，返回整份列表并落进固定列表", async () => {
    const remembered = await setPinnedServerInstance("BUILD.town.example:25570", "1.21.1");
    expect(remembered).toEqual([
      { name: "晨星生存服", address: "play.morningstar.example", instance: "樱花生存" },
      { name: "小镇建筑服", address: "build.town.example:25570", instance: "1.21.1" },
    ]);
    // 不写端口等于 25565
    const forgot = await setPinnedServerInstance("play.morningstar.example:25565", null);
    expect(forgot.map((s) => s.instance)).toEqual([null, "1.21.1"]);
    expect(await listPinnedServers()).toEqual(forgot);
  });

  it("记住实例：不在固定列表里报 server_not_pinned，实例不存在报 version_not_installed，地址不合法报 invalid_argument，列表都不变", async () => {
    const before = await listPinnedServers();
    const missing = await rejection(setPinnedServerInstance("nowhere.example", "1.21.1"));
    expect(missing.code).toBe(SERVER_NOT_PINNED_CODE);
    expect(missing.detail).toEqual({ address: "nowhere.example" });
    const ghost = await rejection(setPinnedServerInstance("play.morningstar.example", "已删除的实例"));
    expect(ghost.code).toBe("version_not_installed");
    expect(ghost.detail).toEqual({ id: "已删除的实例" });
    // 实例先查：服务器也不在时报的是实例
    expect((await rejection(setPinnedServerInstance("nowhere.example", "已删除的实例"))).code).toBe("version_not_installed");
    expect((await rejection(setPinnedServerInstance("bad:0", null))).detail).toMatchObject({ address: "bad:0" });
    expect(await listPinnedServers()).toEqual(before);
  });

  it("实例改名后记住的绑定跟着改，删除后清空；没记住它的服务器不动", async () => {
    await setPinnedServerInstance("build.town.example:25570", "1.21.1");
    await renameInstance("樱花生存", "樱花生存二");
    expect((await listPinnedServers()).map((s) => s.instance)).toEqual(["樱花生存二", "1.21.1"]);
    await deleteInstance("樱花生存二");
    expect((await listPinnedServers()).map((s) => s.instance)).toEqual([null, "1.21.1"]);
    expect((await listInstances()).some((i) => i.id === "樱花生存二")).toBe(false);
  });

  it("有一个地址不合法整体拒绝，原列表不变", async () => {
    const before = await listPinnedServers();
    for (const address of ["x:0", "x:65536", "x:abc", "", "[::1", "a b"]) {
      const error = await rejection(setPinnedServers([{ name: "好", address: "ok.example", instance: null }, { name: "坏", address, instance: null }]));
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
    expect(feed.items.map((i) => i.tag)).toEqual(["snapshot", "launcher", "release", "event"]);
    expect(feed.items[3]).toMatchObject({ thumbnail_url: null, game_version: null });
  });

  it("retry 是必填的布尔参数：listNews 不传时按 false 发出，直接调命令漏了它照 Tauri 原文拒绝", async () => {
    expect((await listNews({ retry: true })).items).toHaveLength(4);
    expect((await listNews()).items).toHaveLength(4);
    const missing = await invoke("list_news", {}).catch((e: unknown) => e);
    expect(missing).toMatchObject({ code: "unknown", message: "invalid args `retry` for command `list_news`: missing required key retry" });
    const wrongType = await invoke("list_news", { retry: "yes" }).catch((e: unknown) => e);
    expect(wrongType).toBeInstanceOf(IpcError);
  });

  it("启动器资讯混在官方资讯里按时刻排，没有游戏版本，取到时 launcher_error 为 null", async () => {
    const feed = await listNews();
    expect(feed.launcher_error).toBeNull();
    const launcher = feed.items.filter((i) => i.tag === "launcher");
    expect(launcher).toEqual([
      expect.objectContaining({ id: "launcher-300", date: Date.UTC(2026, 9, 20, 8, 0, 0), thumbnail_url: null, game_version: null }),
    ]);
  });
});

describe("自更新", () => {
  it("没检查就下载、没下载就安装或退出时安装，都按后端错误码拒绝", async () => {
    expect(await updaterInfo()).toEqual({
      current_version: "0.1.0",
      supported: true,
      unsupported_reason: null,
      package_channel: "stable",
      preference: "stable",
      relation: "same",
      available: null,
      channel_heads: [],
      refused: [],
      downloaded_version: null,
      downloaded_channel: null,
      downloaded_intent: null,
      install_on_exit: false,
    });
    expect((await rejection(downloadUpdate("u-0"))).code).toBe("update_not_available");
    expect((await rejection(setInstallOnExit(true))).code).toBe("update_not_ready");
    expect((await rejection(installUpdate())).code).toBe("update_not_ready");
  });

  it("检查、下载（进度带 task_id）、退出时安装、安装后为新版本", async () => {
    vi.useFakeTimers();
    const update = await checkUpdate();
    expect(update).toMatchObject({ version: "0.2.0", current_version: "0.1.0", channel: "stable" });

    const events: CoreEvent[] = [];
    await onCoreEvent((e) => events.push(e));
    expect(await settle(downloadUpdate("u-1"))).toEqual(update);
    const downloads = events.filter((e) => e.kind === "download");
    expect(downloads.length).toBeGreaterThan(1);
    expect(events.every((e) => e.task_id === "u-1")).toBe(true);
    expect(downloads.every((e) => e.kind === "download" && e.total === 1 && e.bytes <= (e.total_bytes as number))).toBe(true);
    expect(downloads[downloads.length - 1]).toMatchObject({ finished: 1, bytes: 12_582_912 });
    expect(events[events.length - 1]).toMatchObject({ kind: "stage" });
    // 与后端一样，第一个源开始前也推一条换源事件
    expect(events[0]).toEqual({ task_id: "u-1", kind: "source", index: 0, count: 4, name: "cn" });
    expect(events.filter((e) => e.kind === "source")).toHaveLength(1);

    await setInstallOnExit(true);
    expect(await updaterInfo()).toMatchObject({ downloaded_version: "0.2.0", downloaded_channel: "stable", downloaded_intent: "update", install_on_exit: true });
    await installUpdate();
    expect(await updaterInfo()).toMatchObject({ current_version: "0.2.0", downloaded_version: null, downloaded_channel: null, downloaded_intent: null, install_on_exit: false });
    expect(await checkUpdate()).toBeNull();
  });

  it("模拟前几个源断开：每个源开始前一条换源事件，换源后进度从头报起，最后一个源下完", async () => {
    vi.useFakeTimers();
    setMockUpdateSourceFailures(2);
    const update = await checkUpdate();
    const events: CoreEvent[] = [];
    await onCoreEvent((e) => events.push(e));
    expect(await settle(downloadUpdate("u-3"))).toEqual(update);

    const sourceAt = (index: number) => events.findIndex((e) => e.kind === "source" && e.index === index);
    expect(events.filter((e) => e.kind === "source").map((e) => e.kind === "source" && e.name)).toEqual(["cn", "hk", "global"]);
    const bytesBetween = (from: number, to: number) => events.slice(from, to).flatMap((e) => (e.kind === "download" ? [e.bytes] : []));
    expect(bytesBetween(sourceAt(0), sourceAt(1))).toEqual([2_516_582]);
    expect(bytesBetween(sourceAt(1), sourceAt(2))).toEqual([2_516_582]);
    const last = bytesBetween(sourceAt(2), events.length);
    expect(last[0]).toBe(2_516_582);
    expect(last[last.length - 1]).toBe(12_582_912);
    expect((await updaterInfo()).downloaded_version).toBe("0.2.0");
  });

  it("模拟断开的源至少留一个能下完，个数越界直接拒绝", () => {
    expect(() => setMockUpdateSourceFailures(4)).toThrow("要留一个能下完");
    expect(() => setMockUpdateSourceFailures(-1)).toThrow("要留一个能下完");
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

describe("更新通道", () => {
  const published = (version: string, date: number | null): MockUpdateManifest => ({ state: "published", version, notes: null, date });
  const headsOf = async () => (await updaterInfo()).channel_heads.map((h) => [h.channel, h.state, h.version]);

  it("改成更快的通道：本次会话的候选、已下好的包、各通道结果都作废，退出时安装关掉；之后三条线一起看，挑最新的", async () => {
    vi.useFakeTimers();
    await checkUpdate();
    await settle(downloadUpdate("c-1"));
    await setInstallOnExit(true);
    expect(await updaterInfo()).toMatchObject({
      available: { version: "0.2.0", channel: "stable" },
      channel_heads: [{ channel: "stable", state: "published", version: "0.2.0", date: Date.UTC(2026, 9, 29, 8, 0, 0) }],
      downloaded_version: "0.2.0",
      install_on_exit: true,
    });

    const info = await setUpdateChannel("dev");
    expect(info).toMatchObject({
      current_version: "0.1.0",
      package_channel: "stable",
      preference: "dev",
      relation: "following",
      available: null,
      channel_heads: [],
      downloaded_version: null,
      downloaded_channel: null,
      downloaded_intent: null,
      install_on_exit: false,
    });
    expect(await updaterInfo()).toEqual(info);

    expect(await checkUpdate()).toMatchObject({ version: "0.3.0-dev.4", channel: "dev", current_version: "0.1.0" });
    expect(await headsOf()).toEqual([
      ["dev", "published", "0.3.0-dev.4"],
      ["beta", "published", "0.3.0-beta.1"],
      ["stable", "published", "0.2.0"],
    ]);
  });

  it("选的通道与生效的偏好相同：只写下偏好，本次会话的结果都留着", async () => {
    vi.useFakeTimers();
    await checkUpdate();
    await settle(downloadUpdate("c-2"));
    const before = await updaterInfo();
    expect(await setUpdateChannel("stable")).toEqual(before);
    // 写下的是 stable 本身，不是「跟着包走」：包换成预览版之后偏好仍是正式版
    setMockUpdaterVersion("1.0.0-dev.3");
    expect(await updaterInfo()).toMatchObject({ package_channel: "dev", preference: "stable", relation: "waiting" });
  });

  it("关系：没存过偏好时按包的通道，相同为 same，选更慢的为 waiting，选更快的为 following", async () => {
    setMockUpdaterVersion("1.0.0-beta.4");
    expect(await updaterInfo()).toMatchObject({ package_channel: "beta", preference: "beta", relation: "same" });
    expect(await setUpdateChannel("stable")).toMatchObject({ package_channel: "beta", preference: "stable", relation: "waiting" });
    expect(await setUpdateChannel("dev")).toMatchObject({ package_channel: "beta", preference: "dev", relation: "following" });
    expect(await setUpdateChannel("beta")).toMatchObject({ package_channel: "beta", preference: "beta", relation: "same" });
  });

  it("通道名不对报 invalid_argument，先于不支持自更新；缺参数是 Tauri 的参数错误；都不改偏好", async () => {
    for (const bad of ["nightly", "Dev", "preview", "release", ""]) {
      const error = await rejection(invoke("set_update_channel", { channel: bad }));
      expect(error.code, bad).toBe("invalid_argument");
      expect(error.message).toContain(`「${bad}」`);
    }
    expect((await rejection(invoke("set_update_channel", {}))).code).toBe("unknown");
    expect((await rejection(invoke("set_update_channel", { channel: 1 }))).code).toBe("unknown");
    setMockUpdaterUnsupported("debug_build");
    expect((await rejection(invoke("set_update_channel", { channel: "nightly" }))).code).toBe("invalid_argument");
    expect((await updaterInfo()).preference).toBe("stable");
  });

  it("不支持自更新时改通道与其余更新命令都报 updater_unsupported（detail.reason），版本号认不出通道时通道、偏好与关系都为 null", async () => {
    setMockUpdaterUnsupported("pubkey_mismatch");
    expect(await rejection(setUpdateChannel("dev"))).toMatchObject({ code: "updater_unsupported", detail: { reason: "pubkey_mismatch" } });
    expect(await updaterInfo()).toMatchObject({ supported: false, unsupported_reason: "pubkey_mismatch", package_channel: "stable", preference: "stable", relation: "same" });
    for (const call of [() => checkUpdate(), () => downloadUpdate("c-u"), () => installUpdate(), () => setInstallOnExit(false)]) {
      expect(await rejection(call())).toMatchObject({ code: "updater_unsupported", detail: { reason: "pubkey_mismatch" } });
    }

    setMockUpdaterUnsupported(null);
    setMockUpdaterVersion("1.0.0-rc.1");
    expect(await updaterInfo()).toMatchObject({ supported: false, unsupported_reason: "unknown_channel", package_channel: null, preference: null, relation: null });
    expect(await rejection(setUpdateChannel("beta"))).toMatchObject({ code: "updater_unsupported", detail: { reason: "unknown_channel" } });
  });

  it("更新包下载中改通道或再开一次下载报 update_busy；取消后等下载命令返回，就能改了", async () => {
    vi.useFakeTimers();
    await checkUpdate();
    const pending = downloadUpdate("c-3");
    await vi.advanceTimersByTimeAsync(130);
    expect((await rejection(setUpdateChannel("dev"))).code).toBe("update_busy");
    expect((await rejection(downloadUpdate("c-4"))).code).toBe("update_busy");
    expect((await updaterInfo()).preference).toBe("stable");
    expect(await cancelTask("c-3")).toBe(true);
    expect((await rejection(settle(pending))).code).toBe("cancelled");
    expect(await setUpdateChannel("dev")).toMatchObject({ preference: "dev", relation: "following" });
  });

  it("偏好没存过时挑中更慢通道的候选：同一次检查把包的通道写成偏好，装上之后成了跟随，仍按原来那条线收更新", async () => {
    vi.useFakeTimers();
    setMockUpdaterVersion("1.0.0-beta.4");
    setMockUpdateManifest("beta", published("1.0.0-beta.4", null));
    setMockUpdateManifest("stable", published("1.0.0", Date.UTC(2026, 10, 20)));
    // 测试版跟随同号正式版：核心号没前进也是候选
    expect(await checkUpdate()).toMatchObject({ version: "1.0.0", channel: "stable", current_version: "1.0.0-beta.4", date: Date.UTC(2026, 10, 20) });
    expect(await updaterInfo()).toMatchObject({ package_channel: "beta", preference: "beta", relation: "same" });
    expect(await headsOf()).toEqual([
      ["beta", "published", "1.0.0-beta.4"],
      ["stable", "published", "1.0.0"],
    ]);
    await settle(downloadUpdate("c-5"));
    expect(await updaterInfo()).toMatchObject({ downloaded_version: "1.0.0", downloaded_channel: "stable", downloaded_intent: "update" });
    await installUpdate();
    expect(await updaterInfo()).toMatchObject({ current_version: "1.0.0", package_channel: "stable", preference: "beta", relation: "following", available: null, channel_heads: [] });
  });

  it("候选就在包自己的通道里时不写偏好：包换了通道，偏好跟着包走", async () => {
    setMockUpdaterVersion("1.0.0-beta.4");
    setMockUpdateManifest("beta", published("1.0.0-beta.5", null));
    setMockUpdateManifest("stable", { state: "not_published" });
    expect(await checkUpdate()).toMatchObject({ version: "1.0.0-beta.5", channel: "beta" });
    setMockUpdaterVersion("1.0.0");
    expect(await updaterInfo()).toMatchObject({ package_channel: "stable", preference: "stable", relation: "same" });
  });

  it("跟到更慢的通道要核心号前进；等它追上来时不受这条限制，同号正式版就是在等的那一版", async () => {
    setMockUpdaterVersion("1.0.0-dev.60");
    setMockUpdateManifest("dev", published("1.0.0-dev.60", null));
    setMockUpdateManifest("beta", published("1.0.0-beta.4", null));
    setMockUpdateManifest("stable", published("1.0.0", null));
    expect(await checkUpdate()).toBeNull();
    expect(await headsOf()).toEqual([
      ["dev", "published", "1.0.0-dev.60"],
      ["beta", "published", "1.0.0-beta.4"],
      ["stable", "published", "1.0.0"],
    ]);

    expect(await setUpdateChannel("beta")).toMatchObject({ relation: "waiting", channel_heads: [] });
    expect(await checkUpdate()).toMatchObject({ version: "1.0.0", channel: "stable" });
    // 等待中只看偏好与更慢的通道
    expect(await headsOf()).toEqual([
      ["beta", "published", "1.0.0-beta.4"],
      ["stable", "published", "1.0.0"],
    ]);
  });

  it("等它追上来：更快的通道再新也不看；偏好通道还没发布时不算失败，已知的结果不动", async () => {
    setMockUpdaterVersion("1.0.0-dev.60");
    setMockUpdatePreference("beta");
    setMockUpdateManifest("dev", published("1.0.0-dev.61", null));
    setMockUpdateManifest("beta", { state: "not_published" });
    setMockUpdateManifest("stable", published("1.0.0", null));
    expect(await updaterInfo()).toMatchObject({ package_channel: "dev", preference: "beta", relation: "waiting" });
    const update = await checkUpdate();
    expect(update).toMatchObject({ version: "1.0.0", channel: "stable" });

    setMockUpdateManifest("stable", { state: "not_published" });
    expect(await checkUpdate()).toEqual(update);
    expect(await updaterInfo()).toMatchObject({
      available: update,
      channel_heads: [
        { channel: "beta", state: "not_published", version: null, date: null },
        { channel: "stable", state: "not_published", version: null, date: null },
      ],
    });

    // 偏好通道发布了、没有比当前新的：已是最新，已知结果作废
    setMockUpdateManifest("beta", published("1.0.0-beta.4", null));
    expect(await checkUpdate()).toBeNull();
    expect((await updaterInfo()).available).toBeNull();
  });

  it("偏好是正式版而正式版还没发布：已是最新，channel_heads 里正式版为 not_published", async () => {
    setMockUpdaterVersion("1.0.0-beta.4");
    setMockUpdatePreference("stable");
    setMockUpdateManifest("stable", { state: "not_published" });
    expect(await checkUpdate()).toBeNull();
    expect(await updaterInfo()).toMatchObject({
      relation: "waiting",
      available: null,
      channel_heads: [{ channel: "stable", state: "not_published", version: null, date: null }],
    });
  });

  it("被拒：下完验过签才发现读不了本机数据，报 update_data_too_new、不留包、记进 refused，之后的检查不再挑它，改通道也不清掉", async () => {
    vi.useFakeTimers();
    setMockUpdaterVersion("1.0.0-dev.60");
    setMockUpdatePreference("beta");
    setMockUpdateManifest("beta", published("1.0.0-beta.4", null));
    setMockUpdateManifest("stable", published("1.0.0", null));
    setMockUpdateDataTooNew(["1.0.0"]);
    await checkUpdate();
    const events: CoreEvent[] = [];
    await onCoreEvent((e) => events.push(e));
    const refusal = await rejection(settle(downloadUpdate("c-6")));
    expect(refusal.code).toBe("update_data_too_new");
    // 与后端同形：被拒的那一版与它所属的通道
    expect(refusal.detail).toEqual({ version: "1.0.0", channel: "stable" });
    expect(events[events.length - 1]).toMatchObject({ kind: "stage", message: "更新包下载完成，正在校验签名" });
    const refused = [{ version: "1.0.0", channel: "stable", reason: "data_too_new", intent: "update" }];
    expect(await updaterInfo()).toMatchObject({ downloaded_version: null, downloaded_channel: null, refused });
    expect(await checkUpdate()).toBeNull();
    expect((await updaterInfo()).refused).toEqual(refused);
    expect(await setUpdateChannel("stable")).toMatchObject({ preference: "stable", refused });
    // 被拒的只是那一版：更新的正式版照样是候选
    setMockUpdateManifest("stable", published("1.0.1", null));
    expect(await checkUpdate()).toMatchObject({ version: "1.0.1", channel: "stable" });
  });

  it("偏好通道的更新源旧于本机记录：报 update_source_stale（detail.channel），不拿更慢的通道顶上，各通道结果照记", async () => {
    setMockUpdaterVersion("1.0.0-dev.60");
    setMockUpdatePreference("beta");
    setMockUpdateManifest("beta", { state: "stale", version: "1.0.0-beta.3", seen: "1.0.0-beta.4" });
    setMockUpdateManifest("stable", published("1.0.0", null));
    expect(await rejection(checkUpdate())).toMatchObject({
      code: "update_source_stale",
      detail: { channel: "beta", offered: [{ version: "1.0.0-beta.3" }], seen: "1.0.0-beta.4" },
    });
    expect(await updaterInfo()).toMatchObject({ available: null });
    expect(await headsOf()).toEqual([
      ["beta", "stale", "1.0.0-beta.3"],
      ["stable", "published", "1.0.0"],
    ]);
  });

  it("预发布序号按数值比，位数多的大，超过 2^53 也分得清", async () => {
    setMockUpdaterVersion("1.0.0-dev.9");
    setMockUpdateManifest("dev", published("1.0.0-dev.10", null));
    expect(await checkUpdate()).toMatchObject({ version: "1.0.0-dev.10" });
    setMockUpdaterVersion("1.0.0-dev.9007199254740992");
    setMockUpdateManifest("dev", published("1.0.0-dev.9007199254740993", null));
    expect(await checkUpdate()).toMatchObject({ version: "1.0.0-dev.9007199254740993" });
    setMockUpdateManifest("dev", published("1.0.0-dev.9007199254740992", null));
    expect(await checkUpdate()).toBeNull();

    const random = mulberry32(20261110);
    const serial = () => {
      const digits = 1 + Math.floor(random() * 20);
      let text = String(1 + Math.floor(random() * 9));
      while (text.length < digits) text += String(Math.floor(random() * 10));
      return text;
    };
    for (let i = 0; i < 200; i++) {
      const [current, offered] = [serial(), serial()];
      setMockUpdaterVersion(`1.0.0-dev.${current}`);
      setMockUpdateManifest("dev", published(`1.0.0-dev.${offered}`, null));
      const found = await checkUpdate();
      expect(found === null ? null : found.version, `${current} -> ${offered}`).toBe(BigInt(offered) > BigInt(current) ? `1.0.0-dev.${offered}` : null);
    }
  });

  it("假后端的设定写错时直接报错，不按错的跑", () => {
    expect(() => setMockUpdateManifest("beta", published("1.0.0-dev.3", null))).toThrow("不属于这个通道");
    expect(() => setMockUpdateManifest("stable", published("1.0.0-beta.1", null))).toThrow("不属于这个通道");
    expect(() => setMockUpdateManifest("dev", { state: "stale", version: "1.0.0-dev.5", seen: "1.0.0-dev.5" })).toThrow("不旧于");
    expect(() => setMockUpdaterVersion("v1.0.0")).toThrow("认不出版本号");
    expect(() => setMockUpdateDataTooNew(["1.0"])).toThrow("认不出版本号");
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
    await setPinnedServers([{ name: "a", address: "a.example", instance: null }]);
    await setPinnedServerInstance("a.example", "生存");
    await pingServers(["a.example"]);
    await downloadUpdate("u-9");
    await setInstallOnExit(false);
    await setUpdateChannel("beta");
    expect(vi.mocked(tauriInvoke).mock.calls).toEqual([
      ["update_config", { afterLaunch: "keep", checkUpdates: true, defaultJava: "auto", notifiedUpdateVersion: "0.2.0" }],
      ["add_game_directory", { name: "HMCL", path: "D:\\HMCL\\.minecraft" }],
      ["memory_advice", { versionId: "1.21.4" }],
      ["complete_first_run", { gameDir: "D:\\Games\\.minecraft", extraDirectories: [{ name: "HMCL", path: "D:\\HMCL\\.minecraft" }] }],
      ["set_pinned_servers", { servers: [{ name: "a", address: "a.example", instance: null }] }],
      ["set_pinned_server_instance", { address: "a.example", instance: "生存" }],
      ["ping_servers", { addresses: ["a.example"] }],
      ["download_update", { taskId: "u-9" }],
      ["set_install_on_exit", { enabled: false }],
      ["set_update_channel", { channel: "beta" }],
    ]);
  });
});
