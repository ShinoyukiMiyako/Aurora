// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GAME_EXIT_EVENT, type GameExitEvent } from "../ipc/launch";
import type { IpcRecorder } from "../test/fake-bridge";
import { accountDto, bootOverrides, callsOf, emit, instanceDto, resetRecorder, settle, startedStore } from "../test/launcher";
import { resources } from "./resource";

const ipc = vi.hoisted((): IpcRecorder => ({ calls: [], overrides: new Map() }));
vi.mock("../ipc/bridge", async (orig) => (await import("../test/fake-bridge")).fakeBridge(await orig(), ipc));

const exit = (versionId: string): GameExitEvent => ({ version_id: versionId, exit_code: 0, crashed: false, killed: false, duration_ms: 1_800_000 });

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_720_000_000_000);
  resetRecorder(ipc);
  bootOverrides(ipc);
});
afterEach(() => {
  vi.useRealTimers();
});

describe("游戏退出后的缓存失效", () => {
  it("启动途中后端自己下载了 Java：退出后 Java 列表重新请求", async () => {
    const store = await startedStore();
    let majors = [17];
    const java = () => Promise.resolve(majors);
    expect(await resources.read("java", java)).toEqual([17]);

    majors = [17, 8];
    emit(GAME_EXIT_EVENT, exit("生存"));
    await settle();

    expect(await resources.read("java", java)).toEqual([17, 8]);
    store.stop();
  });

  it("没人订阅的存档内容与游玩统计被丢弃，下次读取重新请求；别的实例的内容不受影响", async () => {
    const store = await startedStore();
    let worlds = 1;
    const content = () => Promise.resolve({ worlds: Array.from({ length: worlds }, (_, i) => `世界 ${i + 1}`) });
    let minutes = 0;
    const stats = () => Promise.resolve({ total_min: minutes });
    const other = vi.fn(() => Promise.resolve({ worlds: [] }));

    expect(await resources.read("content:生存", content)).toEqual({ worlds: ["世界 1"] });
    expect(await resources.read("play-stats:2024-07-01:2024-07-31", stats)).toEqual({ total_min: 0 });
    await resources.read("content:创造", other);
    expect(other).toHaveBeenCalledTimes(1);

    // 这一局新建了一个世界、玩了 30 分钟
    worlds = 2;
    minutes = 30;
    emit(GAME_EXIT_EVENT, exit("生存"));
    await settle();

    expect(await resources.read("content:生存", content)).toEqual({ worlds: ["世界 1", "世界 2"] });
    expect(await resources.read("play-stats:2024-07-01:2024-07-31", stats)).toEqual({ total_min: 30 });
    await resources.read("content:创造", other);
    expect(other).toHaveBeenCalledTimes(1);
    // 实例列表照常重扫：上次游玩与游玩时长由后端写好
    expect(callsOf(ipc, "list_instances")).toHaveLength(2);
    store.stop();
  });

  it("启动前手动放进 mods 目录的文件，退出后的 Mod 列表里要有：诊断页按它对日志点名的 Mod", async () => {
    const store = await startedStore();
    let files = ["fabric-api.jar"];
    const mods = () => Promise.resolve([...files]);
    const other = vi.fn(() => Promise.resolve([]));
    expect(await resources.read("mods:生存", mods)).toEqual(["fabric-api.jar"]);
    await resources.read("mods:创造", other);

    files = ["fabric-api.jar", "sodium.jar"];
    emit(GAME_EXIT_EVENT, { ...exit("生存"), exit_code: 1, crashed: true });
    await settle();

    expect(await resources.read("mods:生存", mods)).toEqual(["fabric-api.jar", "sodium.jar"]);
    await resources.read("mods:创造", other);
    expect(other).toHaveBeenCalledTimes(1);
    store.stop();
  });

  it("页面一直订阅着的存档内容在退出时立即重取", async () => {
    const store = await startedStore();
    const fetcher = vi.fn(() => Promise.resolve({ worlds: [] }));
    const listener = vi.fn();
    const unsubscribe = resources.subscribe("content:生存", fetcher, listener);
    await settle();
    expect(fetcher).toHaveBeenCalledTimes(1);

    emit(GAME_EXIT_EVENT, exit("生存"));
    await settle();
    expect(fetcher).toHaveBeenCalledTimes(2);
    unsubscribe();
    store.stop();
  });
});

describe("启动途中下载的托管运行时", () => {
  it("游戏起来后本机 Java 列表重新探测，界面不再说启动时下载", async () => {
    bootOverrides(ipc, { accounts: [accountDto()], instances: [instanceDto("生存")] });
    ipc.overrides.set("launch_game", () => ({ pid: 1 }));
    const store = await startedStore();
    let runtimes: string[] = [];
    const detect = () => Promise.resolve(runtimes);
    expect(await resources.read("java", detect)).toEqual([]);

    runtimes = ["runtime/8/bin/java.exe"];
    await store.actions.launch("生存");
    await settle();

    expect(await resources.read("java", detect)).toEqual(["runtime/8/bin/java.exe"]);
    store.stop();
  });
});
