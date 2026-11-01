// @vitest-environment jsdom
// 直达游戏（进入存档、加入服务器）与普通启动共用一条拦截链：每一处拦截之后继续时都要带着同一个 quickPlay，
// 失败重试也带着它；固定服务器记住的实例经同一条读改写链写入，写完让服务器查询失效。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AccountDto } from "../ipc/accounts";
import { IpcError } from "../ipc/errors";
import type { InstanceDto } from "../ipc/instances";
import { GAME_EXIT_EVENT, type GameExitEvent, type QuickPlayArg } from "../ipc/launch";
import type { PinnedServerDto } from "../ipc/system";
import type { IpcRecorder } from "../test/fake-bridge";
import { accountDto, bootOverrides, callsOf, deferred, emit, instanceDto, resetRecorder, settle, startedStore } from "../test/launcher";
import { resources } from "./resource";
import type { LauncherStore } from "./store";

const ipc = vi.hoisted((): IpcRecorder => ({ calls: [], overrides: new Map() }));
vi.mock("../ipc/bridge", async (orig) => (await import("../test/fake-bridge")).fakeBridge(await orig(), ipc));

const WORLD: QuickPlayArg = { kind: "singleplayer", world_dir_name: "New World" };
const SERVER: QuickPlayArg = { kind: "multiplayer", address: "play.example:25570" };

let instances: InstanceDto[];
let accounts: AccountDto[];
let store: LauncherStore | null;

async function boot(): Promise<LauncherStore> {
  bootOverrides(ipc, { accounts, instances });
  ipc.overrides.set("list_instances", () => instances);
  ipc.overrides.set("list_accounts", () => accounts);
  ipc.overrides.set("current_account", () => (accounts.length === 0 ? null : accounts[0]));
  store = await startedStore();
  return store;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_720_000_000_000);
  resetRecorder(ipc);
  instances = [instanceDto("生存"), instanceDto("创造"), instanceDto("坏了", { status: "broken", broken_reason: "缺少版本 JSON", quick_play: null })];
  accounts = [accountDto()];
  store = null;
});
afterEach(() => {
  store?.stop();
  vi.useRealTimers();
});

describe("直达走与启动相同的拦截链", () => {
  it("直接启动：launch_game 收到这次的 quickPlay，会话记下它；普通启动显式传 null", async () => {
    const s = await boot();
    ipc.overrides.set("launch_game", () => ({ pid: 1 }));
    await s.actions.quickPlay("生存", WORLD);
    expect(callsOf(ipc, "launch_game")).toEqual([
      { taskId: s.getState().session?.taskId, versionId: "生存", accountUuid: "00000000-0000-0000-0000-00000000a001", offlineFallback: false, offlineName: null, quickPlay: WORLD },
    ]);
    expect(s.getState().session).toMatchObject({ instanceId: "生存", phase: "running", quickPlay: WORLD });
  });

  it("同一实例已在启动：再点直达不重复启动，也不弹替换确认", async () => {
    const s = await boot();
    const launched = deferred<{ pid: number }>();
    ipc.overrides.set("launch_game", () => launched.promise);
    const first = s.actions.quickPlay("生存", WORLD);
    await settle();
    await s.actions.quickPlay("生存", SERVER);
    expect(callsOf(ipc, "launch_game")).toHaveLength(1);
    expect(s.getState().launchPrompt).toBeNull();
    launched.resolve({ pid: 1 });
    await first;
  });

  it("还没有账户：先弹登录，意图带着 quickPlay；添加离线账户后自动继续，launch_game 收到同一个 quickPlay", async () => {
    accounts = [];
    const s = await boot();
    ipc.overrides.set("launch_game", () => ({ pid: 1 }));
    await s.actions.quickPlay("生存", SERVER);
    expect(s.getState().login).toEqual({ kind: "no_account", intent: { kind: "launch", instanceId: "生存", quickPlay: SERVER } });
    expect(callsOf(ipc, "launch_game")).toEqual([]);

    const intent = s.getState().login?.intent;
    if (intent === undefined) throw new Error("没有登录意图");
    await s.actions.openLogin("offline", intent);
    const created = accountDto({ uuid: "off-1", name: "Alex" });
    ipc.overrides.set("create_offline_account", () => {
      accounts = [created];
      return created;
    });
    await s.actions.addOfflineAccount("Alex");
    await settle();
    expect(s.getState().login).toBeNull();
    expect(callsOf(ipc, "launch_game")).toEqual([expect.objectContaining({ versionId: "生存", accountUuid: "off-1", quickPlay: SERVER })]);
    expect(s.getState().session).toMatchObject({ instanceId: "生存", quickPlay: SERVER, accountName: "Alex" });
  });

  it("别的实例在运行：弹替换确认，确认后先结束它再以同一个 quickPlay 启动；取消则什么都不启动", async () => {
    const s = await boot();
    ipc.overrides.set("launch_game", () => ({ pid: 1 }));
    // 结束游戏以退出事件为准：后端结束进程后推送 killed 退出
    ipc.overrides.set("stop_game", () => {
      queueMicrotask(() => emit(GAME_EXIT_EVENT, { version_id: "创造", exit_code: 0, crashed: false, killed: true, duration_ms: 1000 } satisfies GameExitEvent));
      return null;
    });
    await s.actions.launch("创造");
    await s.actions.quickPlay("生存", WORLD);
    expect(s.getState().launchPrompt).toEqual({ instanceId: "生存", occupantId: "创造", occupantPhase: "running", quickPlay: WORLD });

    await s.actions.resolveLaunchPrompt(false);
    expect(callsOf(ipc, "launch_game")).toHaveLength(1);

    await s.actions.quickPlay("生存", WORLD);
    await s.actions.resolveLaunchPrompt(true);
    await settle();
    expect(callsOf(ipc, "stop_game")).toHaveLength(1);
    expect(callsOf(ipc, "launch_game").map((a) => [a.versionId, a.quickPlay])).toEqual([
      ["创造", null],
      ["生存", WORLD],
    ]);
    expect(s.getState().session).toMatchObject({ instanceId: "生存", quickPlay: WORLD });
  });

  it("损坏的实例不提供直达：抛错，不启动也不排补全；普通启动照旧转成修复并启动", async () => {
    const s = await boot();
    await expect(s.actions.quickPlay("坏了", SERVER)).rejects.toThrow("「坏了」需要先修复，入口不应提供直达");
    expect(callsOf(ipc, "launch_game")).toEqual([]);
    expect(s.getState().tasks).toEqual([]);
    ipc.overrides.set("repair_instance", () => new Promise(() => undefined));
    await s.actions.launch("坏了");
    expect(s.getState().tasks.map((t) => t.spec.command)).toEqual(["repair_instance"]);
  });

  it("安装中的实例：直达与启动一样抛错", async () => {
    instances = [instanceDto("生存", { activity: "installing" })];
    const s = await boot();
    await expect(s.actions.quickPlay("生存", WORLD)).rejects.toThrow("「生存」还在安装，入口不应提供启动");
    expect(callsOf(ipc, "launch_game")).toEqual([]);
  });

  it("版本不支持、存档不在：不是启动失败码，清掉乐观会话后原样抛给入口", async () => {
    const s = await boot();
    for (const error of [
      new IpcError("quick_play_unsupported", "版本 生存 不支持直接进入存档（1.20 之前的版本没有 Quick Play）", { version_id: "生存", mode: "singleplayer" }),
      new IpcError("world_not_found", "实例 生存 里没有存档 New World", { version_id: "生存", world: "New World" }),
    ]) {
      ipc.overrides.set("launch_game", () => {
        throw error;
      });
      await expect(s.actions.quickPlay("生存", WORLD)).rejects.toMatchObject({ code: error.code, message: error.message });
      expect(s.getState().session).toBeNull();
    }
    expect(s.getState().toasts.filter((t) => t.tone === "error")).toEqual([]);
  });

  it("启动失败后重试带着同一个 quickPlay", async () => {
    const s = await boot();
    ipc.overrides.set("launch_game", () => {
      throw new IpcError("version_broken", "找不到启动入口");
    });
    await s.actions.quickPlay("生存", SERVER);
    expect(s.getState().session).toMatchObject({ phase: "failed", quickPlay: SERVER });
    const retry = s.actions.failureFix("retry");
    if (!("run" in retry)) throw new Error("重试应是命令类修复动作");
    ipc.overrides.set("launch_game", () => ({ pid: 2 }));
    await retry.run();
    expect(callsOf(ipc, "launch_game").map((a) => a.quickPlay)).toEqual([SERVER, SERVER]);
  });
});

describe("固定服务器记住的实例", () => {
  let stored: PinnedServerDto[];

  beforeEach(() => {
    stored = [{ name: "晨星", address: "play.example", instance: null }];
    ipc.overrides.set("list_pinned_servers", () => stored);
    ipc.overrides.set("set_pinned_servers", (args) => {
      stored = args.servers as PinnedServerDto[];
      return stored;
    });
    ipc.overrides.set("set_pinned_server_instance", (args) => {
      stored = stored.map((p) => (p.address === args.address ? { ...p, instance: args.instance as string | null } : p));
      return stored;
    });
  });

  const watchServers = () => {
    const fetched: string[] = [];
    const stops = ["servers:pinned", "servers:known"].map((key) => resources.subscribe(key, async () => fetched.push(key), () => undefined));
    return { fetched, stop: () => stops.forEach((stop) => stop()) };
  };

  it("记住与忘掉：参数原样交给后端，写完服务器查询重取", async () => {
    const s = await boot();
    const watch = watchServers();
    await settle();
    watch.fetched.length = 0;
    await s.actions.setPinnedServerInstance("play.example", "生存");
    await settle();
    expect(callsOf(ipc, "set_pinned_server_instance")).toEqual([{ address: "play.example", instance: "生存" }]);
    expect(watch.fetched.sort()).toEqual(["servers:known", "servers:pinned"]);
    await s.actions.setPinnedServerInstance("play.example", null);
    expect(callsOf(ipc, "set_pinned_server_instance").at(-1)).toEqual({ address: "play.example", instance: null });
    expect(stored).toEqual([{ name: "晨星", address: "play.example", instance: null }]);
    watch.stop();
  });

  it("与固定的读改写排在同一条链上：先排的切换写完，才写记住的实例；写入失败原样抛出，查询不失效", async () => {
    const s = await boot();
    const order: string[] = [];
    const gate = deferred<void>();
    ipc.overrides.set("set_pinned_servers", async (args) => {
      await gate.promise;
      order.push("set_pinned_servers");
      stored = args.servers as PinnedServerDto[];
      return stored;
    });
    ipc.overrides.set("set_pinned_server_instance", () => {
      order.push("set_pinned_server_instance");
      throw new IpcError("server_not_pinned", "服务器「new.example」没有固定", { address: "new.example" });
    });
    const toggle = s.actions.togglePinServer({ name: "新", address: "new.example", instance: "生存" });
    const remember = s.actions.setPinnedServerInstance("new.example", "生存");
    await settle();
    expect(order).toEqual([]);
    gate.resolve();
    await toggle;
    await expect(remember).rejects.toMatchObject({ code: "server_not_pinned" });
    expect(order).toEqual(["set_pinned_servers", "set_pinned_server_instance"]);
    // 新固定的服务器不带调用方给的实例：加入用的实例只能经实例选择记住
    expect(stored.at(-1)).toEqual({ name: "新", address: "new.example", instance: null });
  });

  it("实例改名、删除成功后让服务器查询失效：后端已把记住的实例跟着改掉或清空", async () => {
    const s = await boot();
    const watch = watchServers();
    await settle();
    watch.fetched.length = 0;
    ipc.overrides.set("rename_instance", () => {
      instances = instances.map((i) => (i.id === "生存" ? { ...i, id: "生存二" } : i));
      return { id: "生存二" };
    });
    await s.actions.renameInstance("生存", "生存二");
    await settle();
    expect(watch.fetched.sort()).toEqual(["servers:known", "servers:pinned"]);

    watch.fetched.length = 0;
    ipc.overrides.set("delete_instance", () => {
      instances = instances.filter((i) => i.id !== "生存二");
      return { existed: true };
    });
    await s.actions.deleteInstance("生存二", 0);
    await settle();
    expect(watch.fetched.sort()).toEqual(["servers:known", "servers:pinned"]);
    watch.stop();
  });
});
