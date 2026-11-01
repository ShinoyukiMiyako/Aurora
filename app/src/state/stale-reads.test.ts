// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { InstanceDto } from "../ipc/instances";
import type { IpcRecorder } from "../test/fake-bridge";
import type { ConfigDto } from "../ipc/config";
import { accountDto, bootOverrides, callsOf, configDto, deferred, instanceDto, resetRecorder, settle, startedStore, type Deferred } from "../test/launcher";
import { activeAccount } from "./selectors";
import type { LauncherStore } from "./store";

const ipc = vi.hoisted((): IpcRecorder => ({ calls: [], overrides: new Map() }));
vi.mock("../ipc/bridge", async (orig) => (await import("../test/fake-bridge")).fakeBridge(await orig(), ipc));

let onDisk: InstanceDto[];
let store: LauncherStore;

beforeEach(async () => {
  vi.useFakeTimers();
  vi.setSystemTime(1_720_000_000_000);
  resetRecorder(ipc);
  onDisk = [instanceDto("生存"), instanceDto("创造")];
  bootOverrides(ipc);
  ipc.overrides.set("list_instances", () => onDisk);
  store = await startedStore();
});
afterEach(() => {
  store.stop();
  vi.useRealTimers();
});

/** 下一次 list_instances 挂起，直到测试给出结果；之后的照常读盘。 */
function holdNextScan(): Deferred<InstanceDto[]> {
  const held = deferred<InstanceDto[]>();
  let first = true;
  ipc.overrides.set("list_instances", () => {
    if (!first) return onDisk;
    first = false;
    return held.promise;
  });
  return held;
}

const ids = (): string[] => store.getState().instances.map((i) => i.id);

describe("重叠的实例重扫：先发出、后回来的旧结果不覆盖新结果", () => {
  it("删除前已在路上的重扫晚到时，删掉的实例不会回到列表里", async () => {
    const stale = holdNextScan();
    void store.actions.refreshInstances();
    await settle();
    ipc.overrides.set("delete_instance", () => {
      onDisk = onDisk.filter((i) => i.id !== "创造");
      return null;
    });
    await store.actions.deleteInstance("创造", 0);
    expect(ids()).toEqual(["生存"]);

    stale.resolve([instanceDto("生存"), instanceDto("创造")]);
    await settle();
    expect(ids()).toEqual(["生存"]);
  });

  it("改名前已在路上的重扫晚到时，列表仍是新名字，不会变回旧名字", async () => {
    const stale = holdNextScan();
    void store.actions.refreshInstances();
    await settle();
    ipc.overrides.set("rename_instance", () => {
      onDisk = onDisk.map((i) => (i.id === "生存" ? { ...i, id: "生存二" } : i));
      return { id: "生存二" };
    });
    await store.actions.renameInstance("生存", "生存二");
    expect(ids()).toEqual(["生存二", "创造"]);

    stale.resolve([instanceDto("生存"), instanceDto("创造")]);
    await settle();
    expect(ids()).toEqual(["生存二", "创造"]);
    expect(store.getState().lastRename).toMatchObject({ from: "生存", to: "生存二" });
  });

  it("先发出的重扫先回来时照常采纳；后发出的那次随后回来再覆盖", async () => {
    const first = holdNextScan();
    void store.actions.refreshInstances();
    await settle();
    const second = deferred<InstanceDto[]>();
    ipc.overrides.set("list_instances", () => second.promise);
    void store.actions.refreshInstances();
    await settle();

    first.resolve([instanceDto("生存")]);
    await settle();
    expect(ids()).toEqual(["生存"]);
    second.resolve([instanceDto("生存"), instanceDto("新世界")]);
    await settle();
    expect(ids()).toEqual(["生存", "新世界"]);
  });
});

describe("账户列表与当前账户分两条命令读：对不上或晚到的旧结果不落进状态", () => {
  const A = accountDto({ uuid: "00000000-0000-0000-0000-00000000a001", name: "Steve" });
  const B = accountDto({ uuid: "00000000-0000-0000-0000-00000000b002", name: "Alex" });
  const C = accountDto({ uuid: "00000000-0000-0000-0000-00000000c003", name: "Noor" });

  it("读列表之后、读当前账户之前另一路加了账户：当前账户不在读到的列表里，重读一次再落定", async () => {
    let lists = 0;
    ipc.overrides.set("set_current_account", () => null);
    ipc.overrides.set("list_accounts", () => (++lists === 1 ? [A, B] : [A, B, C]));
    ipc.overrides.set("current_account", () => C);
    await store.actions.selectAccount(C.uuid);
    expect(lists).toBe(2);
    const state = store.getState();
    expect(state.accounts.map((a) => a.uuid)).toEqual([A.uuid, B.uuid, C.uuid]);
    expect(activeAccount(state)?.name).toBe("Noor");
  });

  it("连着几次都对不上时报错，不把对不上的一对落进状态", async () => {
    ipc.overrides.set("set_current_account", () => null);
    ipc.overrides.set("list_accounts", () => [A, B]);
    ipc.overrides.set("current_account", () => C);
    await expect(store.actions.selectAccount(C.uuid)).rejects.toThrow(`当前账户 ${C.uuid} 不在账户列表里`);
    expect(store.getState().currentAccountId).not.toBe(C.uuid);
    expect(callsOf(ipc, "list_accounts").length).toBeGreaterThan(1);
  });

  it("先发出的读取晚回来时，当前账户不会退回旧的那个", async () => {
    ipc.overrides.set("set_current_account", () => null);
    ipc.overrides.set("list_accounts", () => [A, B]);
    const slow = deferred<typeof A>();
    ipc.overrides.set("current_account", () => slow.promise);
    const first = store.actions.selectAccount(A.uuid);
    await settle();
    ipc.overrides.set("current_account", () => B);
    await store.actions.selectAccount(B.uuid);
    expect(store.getState().currentAccountId).toBe(B.uuid);

    slow.resolve(A);
    await first;
    expect(store.getState().currentAccountId).toBe(B.uuid);
  });
});

describe("重叠的设置与侧栏固定读取：先发出、后回来的旧结果不覆盖新结果", () => {
  it("设置：先发出的那次晚回来时，当前实例不退回旧值；先发出的先回来照常采纳", async () => {
    const slow = deferred<ConfigDto>();
    ipc.overrides.set("get_config", () => slow.promise);
    const first = store.actions.reload("settings");
    await settle();
    ipc.overrides.set("get_config", () => configDto({ selected_version: "创造" }));
    await store.actions.reload("settings");
    expect(store.getState().settings?.selectedVersion).toBe("创造");

    slow.resolve(configDto({ selected_version: "生存" }));
    await first;
    expect(store.getState().settings?.selectedVersion).toBe("创造");
    expect(store.getState().status.settings).toEqual({ kind: "ready" });

    const early = deferred<ConfigDto>();
    const late = deferred<ConfigDto>();
    const queue = [early, late];
    ipc.overrides.set("get_config", () => {
      const next = queue.shift();
      if (next === undefined) throw new Error("多读了一次配置");
      return next.promise;
    });
    const a = store.actions.reload("settings");
    const b = store.actions.reload("settings");
    await settle();
    early.resolve(configDto({ selected_version: null }));
    await a;
    expect(store.getState().settings?.selectedVersion).toBeNull();
    late.resolve(configDto({ selected_version: "生存" }));
    await b;
    expect(store.getState().settings?.selectedVersion).toBe("生存");
  });

  it("侧栏固定：先发出的那次晚回来时，固定列表不退回旧值", async () => {
    const slow = deferred<string[]>();
    ipc.overrides.set("get_sidebar_pins", () => slow.promise);
    const first = store.actions.reload("pins");
    await settle();
    ipc.overrides.set("get_sidebar_pins", () => ["创造", "生存"]);
    await store.actions.reload("pins");
    expect(store.getState().sidebarPins).toEqual(["创造", "生存"]);

    slow.resolve([]);
    await first;
    expect(store.getState().sidebarPins).toEqual(["创造", "生存"]);
    expect(store.getState().instances.filter((i) => i.pinned).map((i) => i.id)).toEqual(["生存", "创造"]);
  });
});

describe("写入之前已在路上的固定读取晚到时，不把刚写下的固定改回去", () => {
  it("侧栏固定：固定之前发出的读取晚到，固定列表仍是写入后的那份", async () => {
    const slow = deferred<string[]>();
    ipc.overrides.set("get_sidebar_pins", () => slow.promise);
    const reading = store.actions.reload("pins");
    await settle();
    ipc.overrides.set("set_sidebar_pins", (args) => args.pins);
    await store.actions.togglePin("创造");
    expect(store.getState().sidebarPins).toEqual(["创造"]);

    slow.resolve([]);
    await reading;
    expect(store.getState().sidebarPins).toEqual(["创造"]);
    expect(store.getState().instances.filter((i) => i.pinned).map((i) => i.id)).toEqual(["创造"]);
  });

  it("侧栏固定：拖动排序之前发出的读取晚到，顺序仍是写入后的那份", async () => {
    ipc.overrides.set("set_sidebar_pins", (args) => args.pins);
    await store.actions.setSidebarPins(["生存", "创造"]);
    const slow = deferred<string[]>();
    ipc.overrides.set("get_sidebar_pins", () => slow.promise);
    const reading = store.actions.reload("pins");
    await settle();
    await store.actions.setSidebarPins(["创造", "生存"]);

    slow.resolve(["生存", "创造"]);
    await reading;
    expect(store.getState().sidebarPins).toEqual(["创造", "生存"]);
  });

  it("侧栏固定：写入之后才发出的读取照常采纳", async () => {
    ipc.overrides.set("set_sidebar_pins", (args) => args.pins);
    await store.actions.togglePin("创造");
    ipc.overrides.set("get_sidebar_pins", () => ["生存", "创造"]);
    await store.actions.reload("pins");
    expect(store.getState().sidebarPins).toEqual(["生存", "创造"]);
  });
});
