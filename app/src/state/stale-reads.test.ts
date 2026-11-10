// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ACTION_ERROR } from "../copy/flows";
import { INSTANCE_RESCAN_MIN_MS } from "../domain/limits";
import { IpcError } from "../ipc/errors";
import type { InstanceDto } from "../ipc/instances";
import type { IpcRecorder } from "../test/fake-bridge";
import type { ConfigDto } from "../ipc/config";
import { accountDto, bootOverrides, callsOf, cancelledError, configDto, deferred, instanceDto, resetRecorder, settle, startedStore, type Deferred } from "../test/launcher";
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

describe("选中实例之前已在路上的设置读取晚到时，当前实例以写入为准", () => {
  it("当前实例：选中之前发出的设置读取晚到，当前实例仍是刚选中的那个，其余字段照常采纳", async () => {
    const slow = deferred<ConfigDto>();
    ipc.overrides.set("get_config", () => slow.promise);
    const reading = store.actions.reload("settings");
    await settle();
    await store.actions.selectInstance("创造");
    expect(store.getState().settings?.selectedVersion).toBe("创造");

    slow.resolve(configDto({ selected_version: "生存", download_concurrency: 8 }));
    await reading;
    expect(store.getState().settings?.selectedVersion).toBe("创造");
    expect(store.getState().settings?.downloadConcurrency).toBe(8);
  });

  it("当前实例：选中之后才发出的读取照常采纳（例如后端随删除清掉了选择）", async () => {
    await store.actions.selectInstance("创造");
    ipc.overrides.set("get_config", () => configDto({ selected_version: null }));
    await store.actions.reload("settings");
    expect(store.getState().settings?.selectedVersion).toBeNull();
  });
});

describe("任务进行中重扫读到的占用不留到任务结束之后", () => {
  const OPTIONS = { destination: "D:\\分享\\包.mrpack", name: "包", version: "1.0.0", summary: null, extras: [], include_disabled: false };
  const activity = () => store.getState().instances.find((i) => i.id === "生存")?.activity;

  /** 导出跑着的时候窗口回到前台重扫：列表记下后端此刻报的 modifying。 */
  async function exportingWithHeldList(): Promise<Deferred<unknown>> {
    const running = deferred<unknown>();
    ipc.overrides.set("export_modpack", () => running.promise);
    await store.actions.exportModpack("生存", OPTIONS);
    await settle();
    onDisk = [instanceDto("生存", { activity: "modifying" }), instanceDto("创造")];
    await store.actions.refreshInstances();
    expect(activity()).toBe("modifying");
    onDisk = [instanceDto("生存"), instanceDto("创造")];
    return running;
  }

  it("导出成功：落地不用重扫，结束时也要重读一次，改名与删除不再被挡", async () => {
    const running = await exportingWithHeldList();
    running.resolve({ path: OPTIONS.destination, name: "包", version: "1.0.0", bytes: 1, indexed_files: 0, override_files: 0, bundled_mods: [], disabled_mods: 0, skipped: [] });
    await settle();
    expect(activity()).toBeNull();
  });

  it("导出失败：同样按盘上重读", async () => {
    const running = await exportingWithHeldList();
    running.reject(new IpcError("modpack_export_check_failed", "回读校验没通过"));
    await settle();
    expect(activity()).toBeNull();
  });

  it("导出被取消：同样按盘上重读", async () => {
    const running = await exportingWithHeldList();
    running.reject(cancelledError());
    await settle();
    expect(activity()).toBeNull();
  });

  it("列表没记着占用的实例不多扫一次", async () => {
    const running = deferred<unknown>();
    ipc.overrides.set("export_modpack", () => running.promise);
    await store.actions.exportModpack("生存", OPTIONS);
    await settle();
    const scans = callsOf(ipc, "list_instances").length;
    running.reject(new IpcError("modpack_export_check_failed", "回读校验没通过"));
    await settle();
    expect(callsOf(ipc, "list_instances")).toHaveLength(scans);
  });
});

describe("列实例因游戏目录的数据格式被拒：手里的旧列表不再留着给人操作", () => {
  const GAME_DIR = "D:\\Games\\.minecraft";
  // 真后端每次调用都交回新的错误对象，这里同样每次新造一个
  const tooNew = (found: number, writtenBy: string) =>
    new IpcError("game_dir_data_too_new", `游戏目录 ${GAME_DIR} 的数据格式 ${found} 比这一版认得的 2 新`, { path: GAME_DIR, found, supported: 2, written_by: writtenBy, written_by_channel: "dev" });
  const unreadable = () => new IpcError("data_format_unreadable", `游戏目录 ${GAME_DIR} 的数据格式记号读不懂`, { path: GAME_DIR, reason: "expected value at line 1 column 1" });
  const tooNewBody = (writtenBy: string) => `游戏目录 ${GAME_DIR} 已经被预览版 ${writtenBy} 用过，这个版本读不了里面的实例。装上预览版 ${writtenBy} 或更新的版本，或者换一个游戏目录。`;
  const UNREADABLE_BODY = `游戏目录 ${GAME_DIR} 里的格式记录读不懂（expected value at line 1 column 1），为了不弄坏里面的实例，这次没有打开它。`;

  function scansFailWith(error: () => Error): void {
    ipc.overrides.set("list_instances", () => {
      throw error();
    });
  }

  /** 隔够节流时间后窗口回到前台，触发一次后台重扫。 */
  async function focusLater(): Promise<void> {
    vi.setSystemTime(Date.now() + INSTANCE_RESCAN_MIN_MS);
    window.dispatchEvent(new Event("focus"));
    await settle();
  }

  const slice = () => store.getState().status.instances;
  const shownError = (): IpcError => {
    const s = slice();
    if (s.kind !== "error" || !(s.error instanceof IpcError)) throw new Error(`实例切片不是后端错误：${JSON.stringify(s)}`);
    return s.error;
  };
  const errorToasts = () =>
    store
      .getState()
      .toasts.filter((t) => t.tone === "error")
      .map((t) => ({ title: t.title, body: t.body, repeats: t.repeats }));

  beforeEach(async () => {
    await store.actions.selectInstance("生存");
    expect(store.getState().selectedInstanceId).toBe("生存");
  });

  it.each([
    ["被更新的版本用过", () => tooNew(3, "1.1.0-dev.57"), "game_dir_data_too_new", tooNewBody("1.1.0-dev.57")],
    ["记号读不懂", unreadable, "data_format_unreadable", UNREADABLE_BODY],
  ])("%s：获焦重扫被拒后切片出错并带着这个错误，旧列表清空，当前实例失效，只发一条通知", async (_, error, code, body) => {
    scansFailWith(error);
    await focusLater();
    expect(shownError().code).toBe(code);
    expect(ids()).toEqual([]);
    expect(store.getState().selectedInstanceId).toBeNull();
    expect(errorToasts()).toEqual([{ title: ACTION_ERROR.refreshInstances, body, repeats: 0 }]);
  });

  it("别的错误（网络盘一时连不上）：旧列表与当前实例都留着，切片仍就绪，只发一条通知", async () => {
    scansFailWith(() => new IpcError("invalid_game_directory", `游戏目录 ${GAME_DIR} 不能用：找不到网络路径`, { path: GAME_DIR, problem: "unavailable" }));
    await focusLater();
    expect(slice()).toEqual({ kind: "ready" });
    expect(ids()).toEqual(["生存", "创造"]);
    expect(store.getState().selectedInstanceId).toBe("生存");
    expect(errorToasts()).toEqual([{ title: ACTION_ERROR.refreshInstances, body: `游戏目录 ${GAME_DIR} 不能用：找不到网络路径`, repeats: 0 }]);
  });

  it("同一个拒绝连续撞上：照样重扫，但切片不换、不再发通知；换成另一个拒绝才再说一次", async () => {
    scansFailWith(() => tooNew(3, "1.1.0-dev.57"));
    await focusLater();
    const first = slice();
    const scans = callsOf(ipc, "list_instances").length;

    await focusLater();
    expect(callsOf(ipc, "list_instances")).toHaveLength(scans + 1);
    expect(slice()).toBe(first);
    expect(errorToasts()).toEqual([{ title: ACTION_ERROR.refreshInstances, body: tooNewBody("1.1.0-dev.57"), repeats: 0 }]);

    // 又被更新的一版用过：记号与写入的版本都变了，是另一个拒绝
    scansFailWith(() => tooNew(4, "1.1.0-dev.60"));
    await focusLater();
    expect(shownError().detail).toMatchObject({ found: 4, written_by: "1.1.0-dev.60" });
    expect(errorToasts().map((t) => t.body)).toEqual([tooNewBody("1.1.0-dev.57"), tooNewBody("1.1.0-dev.60")]);
  });

  it("被拒之后记号修好了：下一次获焦重扫读到列表，切片回到就绪，当前实例回来", async () => {
    scansFailWith(unreadable);
    await focusLater();
    expect(shownError().code).toBe("data_format_unreadable");

    ipc.overrides.set("list_instances", () => onDisk);
    await focusLater();
    expect(slice()).toEqual({ kind: "ready" });
    expect(ids()).toEqual(["生存", "创造"]);
    expect(store.getState().selectedInstanceId).toBe("生存");
  });

  it("被拒之后换了游戏目录：切换后的重扫读到新目录的列表，切片回到就绪", async () => {
    scansFailWith(() => tooNew(3, "1.1.0-dev.57"));
    await focusLater();
    expect(shownError().code).toBe("game_dir_data_too_new");

    ipc.overrides.set("set_game_directory", () => null);
    onDisk = [instanceDto("别处的实例")];
    ipc.overrides.set("list_instances", () => onDisk);
    await store.actions.setGameDirectory("E:\\Other\\.minecraft");
    expect(slice()).toEqual({ kind: "ready" });
    expect(ids()).toEqual(["别处的实例"]);
  });

  it("拒绝之前发出、之后才回来的成功重扫不把旧列表放回来", async () => {
    const stale = holdNextScan();
    void store.actions.refreshInstances();
    await settle();
    scansFailWith(() => tooNew(3, "1.1.0-dev.57"));
    await expect(store.actions.refreshInstances()).rejects.toMatchObject({ code: "game_dir_data_too_new" });
    expect(ids()).toEqual([]);

    stale.resolve([instanceDto("生存"), instanceDto("创造")]);
    await settle();
    expect(shownError().code).toBe("game_dir_data_too_new");
    expect(ids()).toEqual([]);
  });

  it("成功之前发出、之后才被拒的旧重扫不把切片改成出错", async () => {
    const refused = deferred<InstanceDto[]>();
    ipc.overrides.set("list_instances", () => refused.promise);
    const older = store.actions.refreshInstances();
    await settle();
    ipc.overrides.set("list_instances", () => onDisk);
    await store.actions.refreshInstances();

    refused.reject(tooNew(3, "1.1.0-dev.57"));
    await expect(older).rejects.toMatchObject({ code: "game_dir_data_too_new" });
    expect(slice()).toEqual({ kind: "ready" });
    expect(ids()).toEqual(["生存", "创造"]);
  });
});

