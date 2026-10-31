// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IpcError } from "../ipc/errors";
import type { InstanceDto } from "../ipc/instances";
import type { IpcRecorder } from "../test/fake-bridge";
import { bootOverrides, callsOf, cancelledError, deferred, instanceDto, resetRecorder, settle, startedStore, type Deferred } from "../test/launcher";
import { isActiveTask } from "./tasks";
import type { LauncherStore } from "./store";

const ipc = vi.hoisted((): IpcRecorder => ({ calls: [], overrides: new Map() }));
vi.mock("../ipc/bridge", async (orig) => (await import("../test/fake-bridge")).fakeBridge(await orig(), ipc));

let instances: InstanceDto[];
let store: LauncherStore;

beforeEach(async () => {
  vi.useFakeTimers();
  vi.setSystemTime(1_720_000_000_000);
  resetRecorder(ipc);
  instances = [instanceDto("生存"), instanceDto("创造")];
  bootOverrides(ipc);
  ipc.overrides.set("list_instances", () => instances);
  store = await startedStore();
});
afterEach(() => {
  store.stop();
  vi.useRealTimers();
});

function renameOnDisk(from: string, to: string): void {
  ipc.overrides.set("rename_instance", () => {
    instances = instances.map((i) => (i.id === from ? { ...i, id: to } : i));
    return { id: to };
  });
}

describe("改名迁移启动会话", () => {
  it("启动失败的会话随改名换成新 id：重试按新名字启动，查看日志也落到新名字", async () => {
    ipc.overrides.set("launch_game", () => {
      throw new IpcError("version_broken", "找不到启动入口");
    });
    await store.actions.launch("生存");
    expect(store.getState().session).toMatchObject({ instanceId: "生存", phase: "failed" });

    renameOnDisk("生存", "生存二");
    expect(await store.actions.renameInstance("生存", "生存二")).toBe("生存二");
    expect(store.getState().session).toMatchObject({ instanceId: "生存二", phase: "failed" });

    expect(store.actions.failureFix("open_logs")).toEqual({ to: { page: "instance", id: "生存二", tab: "logs" } });
    const retry = store.actions.failureFix("retry");
    if (!("run" in retry)) throw new Error("重试应是命令类修复动作");
    ipc.overrides.set("launch_game", () => ({ pid: 4242 }));
    await retry.run();
    expect(callsOf(ipc, "launch_game").map((a) => a.versionId)).toEqual(["生存", "生存二"]);
  });

  it("替换确认里的两个实例也换成新 id；与改名无关的会话不动", async () => {
    ipc.overrides.set("launch_game", () => ({ pid: 1 }));
    await store.actions.launch("创造");
    await store.actions.launch("生存");
    expect(store.getState().launchPrompt).toEqual({ instanceId: "生存", occupantId: "创造", occupantPhase: "running" });

    renameOnDisk("生存", "生存二");
    await store.actions.renameInstance("生存", "生存二");
    expect(store.getState().launchPrompt).toEqual({ instanceId: "生存二", occupantId: "创造", occupantPhase: "running" });
    expect(store.getState().session).toMatchObject({ instanceId: "创造", phase: "running" });
    await settle();
  });
});

describe("删除实例时取消它的全部任务", () => {
  it("3 个运行中、2 个排队：排队的不再被拉起，运行中的都取消并落定后才删除目录", async () => {
    const running = new Map<string, Deferred<unknown>>();
    ipc.overrides.set("install_resource", (args) => {
      const d = deferred<unknown>();
      running.set(String(args.taskId), d);
      return d.promise;
    });
    ipc.overrides.set("cancel_task", (args) => {
      const d = running.get(String(args.taskId));
      if (d === undefined) return false;
      d.reject(cancelledError());
      return true;
    });
    let activeAtDelete: number | null = null;
    ipc.overrides.set("delete_instance", () => {
      activeAtDelete = store.getState().tasks.filter(isActiveTask).length;
      instances = instances.filter((i) => i.id !== "生存");
      return null;
    });
    for (const project of ["a", "b", "c", "d", "e"]) {
      await store.actions.installResource({
        resourceType: "resource_pack",
        platform: "modrinth",
        projectId: project,
        name: `材质 ${project}`,
        targets: [{ instanceId: "生存", fileVersionId: `${project}-1`, world: null }],
      });
    }
    // 另一个实例的任务不受影响
    await store.actions.installResource({
      resourceType: "resource_pack",
      platform: "modrinth",
      projectId: "f",
      name: "材质 f",
      targets: [{ instanceId: "创造", fileVersionId: "f-1", world: null }],
    });
    await settle();
    expect(store.getState().tasks.map((t) => t.status)).toEqual(["running", "running", "running", "queued", "queued", "queued"]);

    await store.actions.deleteInstance("生存", 0);
    await settle();

    expect(activeAtDelete).toBe(1);
    expect(callsOf(ipc, "cancel_task")).toHaveLength(3);
    // 排队的两个从没发出过命令；另一个实例的任务在通道空出后开始
    expect(callsOf(ipc, "install_resource").map((a) => a.versionId)).toEqual(["生存", "生存", "生存", "创造"]);
    const byInstance = store.getState().tasks.map((t) => [t.instanceId, t.status]);
    expect(byInstance).toEqual([
      ["生存", "cancelled"],
      ["生存", "cancelled"],
      ["生存", "cancelled"],
      ["生存", "cancelled"],
      ["生存", "cancelled"],
      ["创造", "running"],
    ]);
    expect(store.getState().instances.map((i) => i.id)).toEqual(["创造"]);
  });
});
