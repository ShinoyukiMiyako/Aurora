// @vitest-environment jsdom
// 导入中的整合包与侧栏固定：导入失败或取消、后端删掉半成品之后固定列表跟着重读；导入进行中状态层不改它的固定。
// 假后端的固定列表照后端的规矩：读的时候只给出还在实例库里的，写的时候每一项都要在。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CANCELLED_ERROR_CODE, IpcError } from "../ipc/errors";
import type { InstanceDto } from "../ipc/instances";
import type { IpcRecorder } from "../test/fake-bridge";
import { bootOverrides, callsOf, deferred, instanceDto, resetRecorder, settle, startedStore, type Deferred } from "../test/launcher";
import type { InstallModpackSpec, LauncherStore } from "./store";

const ipc = vi.hoisted((): IpcRecorder => ({ calls: [], overrides: new Map() }));
vi.mock("../ipc/bridge", async (orig) => (await import("../test/fake-bridge")).fakeBridge(await orig(), ipc));

const PACK: InstallModpackSpec = {
  source: { kind: "file", path: "C:/packs/周末联机.mrpack" },
  name: "周末联机",
  cover: "grass",
  packName: "周末联机",
  packVersion: "1.0.0",
  modCount: 12,
  mcVersion: "1.21.1",
  loader: "fabric",
  loaderVersion: "0.16.10",
  excludedOptional: [],
};

let instances: InstanceDto[];
/** 配置里存着的固定列表。 */
let configPins: string[];
let store: LauncherStore;
let run: Deferred<unknown>;

const onDisk = (id: string) => instances.some((i) => i.id === id);

function pinsArg(args: Record<string, unknown>): string[] {
  const pins = args.pins;
  if (!Array.isArray(pins) || pins.some((p) => typeof p !== "string")) throw new Error("pins 应为字符串数组");
  return pins as string[];
}

/** 开机：配置里的固定列表由各用例给出；导入命令挂在 run 上。 */
async function boot(pins: string[]): Promise<void> {
  configPins = pins;
  store = await startedStore();
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_720_000_000_000);
  resetRecorder(ipc);
  instances = [instanceDto("生存"), instanceDto("创造")];
  bootOverrides(ipc);
  ipc.overrides.set("list_instances", () => instances);
  ipc.overrides.set("get_sidebar_pins", () => configPins.filter(onDisk));
  ipc.overrides.set("set_sidebar_pins", (args) => {
    const pins = pinsArg(args);
    const missing = pins.find((p) => !onDisk(p));
    if (missing !== undefined) throw new IpcError("invalid_argument", "侧栏固定列表不合法：要固定的实例不存在", { field: "pins", reason: "not_found", id: missing });
    configPins = pins;
    return pins;
  });
  run = deferred<unknown>();
  ipc.overrides.set("install_modpack", () => run.promise);
});
afterEach(() => {
  store.stop();
  vi.useRealTimers();
});

const writes = () => callsOf(ipc, "set_sidebar_pins").map((args) => args.pins);

/** 装到一半时重扫扫到了盘上的半成品目录（还没写版本 JSON，扫出来损坏），之后又读了一次固定列表。 */
async function scannedHalfway(): Promise<void> {
  instances = [...instances, instanceDto(PACK.name, { status: "broken", mc_version: null, loaders: [], activity: "installing" })];
  await store.actions.refreshInstances();
  await store.actions.reload("pins");
  await settle();
  expect(store.getState().instances.find((i) => i.id === PACK.name)).toMatchObject({ placeholder: false, status: "installing" });
}

describe("导入失败或取消、半成品被删掉之后", () => {
  it.each([
    { ending: "失败", error: new IpcError("download_failed", "下载源暂时不可用") },
    { ending: "取消", error: new IpcError(CANCELLED_ERROR_CODE, "已取消") },
  ])("导入$ending：固定列表跟着重读，不再留着删掉的名字；下一次固定只写还在的实例，照常写成", async ({ error }) => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    // 同名实例早先在落樱之外删掉了，配置里的固定还留着：开机读到的固定列表滤掉了它
    await boot(["生存", PACK.name]);
    expect(store.getState().sidebarPins).toEqual(["生存"]);
    await store.actions.installModpack(PACK);
    await settle();
    // 半成品目录建好之后后端认了这个名字，那条旧固定跟着回到固定列表里
    await scannedHalfway();
    expect(store.getState().sidebarPins).toEqual(["生存", PACK.name]);

    // 后端删掉半成品目录，再报导入的结局
    instances = instances.filter((i) => i.id !== PACK.name);
    run.reject(error);
    await settle();
    expect(store.getState().instances.map((i) => i.id)).toEqual(["生存", "创造"]);
    expect(store.getState().sidebarPins).toEqual(["生存"]);

    await store.actions.togglePin("创造");
    expect(writes()).toEqual([["生存", "创造"]]);
    expect(store.getState().sidebarPins).toEqual(["生存", "创造"]);
  });
});

describe("导入进行中：状态层不改它的固定", () => {
  it("还没固定的：占位项与被扫到的半成品都拦下固定，不写固定列表；导入完成后照常能固定", async () => {
    await boot(["生存"]);
    await store.actions.installModpack(PACK);
    await settle();
    expect(store.getState().instances.find((i) => i.id === PACK.name)).toMatchObject({ placeholder: true, status: "installing" });
    await expect(store.actions.togglePin(PACK.name)).rejects.toThrow(`整合包「${PACK.name}」还在导入，导入完成后才能固定`);

    // 半成品目录建好之后后端认这个名字，写得进去；导入失败或取消时它又会被删掉，留下一条指向不存在实例的固定
    await scannedHalfway();
    await expect(store.actions.togglePin(PACK.name)).rejects.toThrow(`整合包「${PACK.name}」还在导入，导入完成后才能固定`);
    expect(writes()).toEqual([]);
    expect(store.getState().sidebarPins).toEqual(["生存"]);

    instances = instances.map((i) => (i.id === PACK.name ? instanceDto(PACK.name, { loaders: [{ kind: "fabric", version: "0.16.10" }] }) : i));
    run.resolve({ version_id: PACK.name });
    await settle();
    expect(store.getState().tasks.map((t) => t.status)).toEqual(["done"]);
    await store.actions.togglePin(PACK.name);
    expect(writes()).toEqual([["生存", PACK.name]]);
    expect(store.getState().sidebarPins).toEqual(["生存", PACK.name]);
  });

  it("本来就已固定的（配置里留着同名旧固定）：取消固定同样拦下，原因说的是取消固定", async () => {
    await boot(["生存", PACK.name]);
    await store.actions.installModpack(PACK);
    await settle();
    await scannedHalfway();
    expect(store.getState().sidebarPins).toEqual(["生存", PACK.name]);

    await expect(store.actions.togglePin(PACK.name)).rejects.toThrow(`整合包「${PACK.name}」还在导入，导入完成后才能取消固定`);
    expect(writes()).toEqual([]);
    expect(store.getState().sidebarPins).toEqual(["生存", PACK.name]);
  });

  it("拦下的那次不挡侧栏固定链上排在后面的：紧接着固定别的实例照常写成", async () => {
    await boot(["生存"]);
    await store.actions.installModpack(PACK);
    await settle();
    const blocked = store.actions.togglePin(PACK.name);
    const next = store.actions.togglePin("创造");
    await expect(blocked).rejects.toThrow("导入完成后才能固定");
    await next;
    expect(writes()).toEqual([["生存", "创造"]]);
  });

  it("同在安装中的新建不受影响：照旧只改装好后要不要固定，不写固定列表", async () => {
    ipc.overrides.set("install_version", () => new Promise(() => undefined));
    await boot(["生存"]);
    await store.actions.createInstance({ name: "新世界", mcVersion: "1.21.1", loader: "fabric", loaderVersion: "0.16.10", cover: "grass" });
    await settle();
    expect(store.getState().sidebarPins).toEqual(["生存", "新世界"]);
    await store.actions.togglePin("新世界");
    expect(store.getState().sidebarPins).toEqual(["生存"]);
    expect(writes()).toEqual([]);
  });
});
