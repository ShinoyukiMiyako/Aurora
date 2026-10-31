// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { InstanceDto } from "../ipc/instances";
import type { IpcRecorder } from "../test/fake-bridge";
import { bootOverrides, deferred, instanceDto, resetRecorder, settle, startedStore, type Deferred } from "../test/launcher";
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
