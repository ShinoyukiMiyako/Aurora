// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { locksOf } from "../domain/instance-locks";
import { IpcError } from "../ipc/errors";
import type { InstanceDto } from "../ipc/instances";
import { LAUNCH_PHASE_EVENT, type LaunchPhaseEvent } from "../ipc/launch";
import { CORE_EVENT, type CoreEvent } from "../ipc/tasks";
import type { IpcRecorder } from "../test/fake-bridge";
import { bootOverrides, callsOf, cancelledError, deferred, emit, instanceDto, resetRecorder, settle, startedStore } from "../test/launcher";
import type { LauncherStore } from "./store";

const ipc = vi.hoisted((): IpcRecorder => ({ calls: [], overrides: new Map() }));
vi.mock("../ipc/bridge", async (orig) => (await import("../test/fake-bridge")).fakeBridge(await orig(), ipc));

const BASE = "1.21.1";
const CHILD = "NF Pack";

const idle = (): InstanceDto[] => [instanceDto(BASE), instanceDto(CHILD)];
const occupied = (activity: InstanceDto["activity"]): InstanceDto[] => [instanceDto(BASE, { activity: "inherited", used_by: CHILD }), instanceDto(CHILD, { activity })];

let onDisk: InstanceDto[];
let store: LauncherStore;

beforeEach(async () => {
  vi.useFakeTimers();
  vi.setSystemTime(1_720_000_000_000);
  resetRecorder(ipc);
  onDisk = idle();
  bootOverrides(ipc);
  ipc.overrides.set("list_instances", () => onDisk);
  store = await startedStore();
});
afterEach(() => {
  store.stop();
  vi.useRealTimers();
});

const repairLock = (): unknown => {
  const inst = store.getState().instances.find((i) => i.id === BASE);
  if (inst === undefined) throw new Error("基底不在列表里");
  return locksOf(inst, false).repair;
};
const IN_USE = { kind: "inherited", usedBy: CHILD };
const stage = (taskId: string): CoreEvent => ({ kind: "stage", task_id: taskId, message: `补全实例 ${CHILD} 的文件` });

async function repairing(): Promise<{ taskId: string; finish: (value: unknown) => void; fail: (error: unknown) => void }> {
  const done = deferred<unknown>();
  ipc.overrides.set("repair_instance", () => done.promise);
  await store.actions.repairInstance(CHILD);
  await settle();
  const call = callsOf(ipc, "repair_instance")[0];
  if (call === undefined) throw new Error("补全没有开始");
  return { taskId: String(call.taskId), finish: done.resolve, fail: done.reject };
}

async function launching(): Promise<{ taskId: string; launched: (value: { pid: number; offline: boolean }) => void; refuse: (error: unknown) => void; pending: Promise<void> }> {
  const done = deferred<{ pid: number; offline: boolean }>();
  ipc.overrides.set("launch_game", () => done.promise);
  const pending = store.actions.launch(CHILD);
  await settle();
  const session = store.getState().session;
  if (session === null) throw new Error("没有建立会话");
  return { taskId: session.taskId, launched: done.resolve, refuse: done.reject, pending };
}

describe("子实例开工后基底的占用立刻进列表", () => {
  it("补全子实例：开工的阶段事件到达后基底的补全带原因禁用，补全结束后放开", async () => {
    const { taskId, finish } = await repairing();
    expect(repairLock()).toBeNull();

    onDisk = occupied("repairing");
    emit(CORE_EVENT, stage(taskId));
    await settle();
    expect(repairLock()).toEqual(IN_USE);

    onDisk = idle();
    finish({ reinstalled: false, libraries: 0, assets: 0, natives: 0 });
    await settle();
    expect(repairLock()).toBeNull();
  });

  it("补全子实例失败：基底同样放开", async () => {
    const { taskId, fail } = await repairing();
    onDisk = occupied("repairing");
    emit(CORE_EVENT, stage(taskId));
    await settle();
    expect(repairLock()).toEqual(IN_USE);

    onDisk = idle();
    fail(new IpcError("download_failed", "文件下载失败"));
    await settle();
    expect(repairLock()).toBeNull();
  });

  it("启动子实例：第一条阶段事件后基底带原因禁用，下载进度不再重扫", async () => {
    const { taskId, launched, pending } = await launching();
    const before = callsOf(ipc, "list_instances").length;

    onDisk = occupied("launching");
    emit(LAUNCH_PHASE_EVENT, { task_id: taskId, phase: "preparing", stage_index: 0 } satisfies LaunchPhaseEvent);
    await settle();
    expect(repairLock()).toEqual(IN_USE);
    expect(callsOf(ipc, "list_instances")).toHaveLength(before + 1);

    for (const finished of [1, 2, 3]) {
      emit(LAUNCH_PHASE_EVENT, { task_id: taskId, phase: "downloading", stage_index: 3, download: { total: 480, finished, bytes: 250, total_bytes: 1000, speed: 4_200_000 } } satisfies LaunchPhaseEvent);
    }
    await settle();
    expect(callsOf(ipc, "list_instances")).toHaveLength(before + 1);

    launched({ pid: 1, offline: false });
    await pending;
  });

  it("启动子实例中途取消：开工时记下的占用随之放开，基底不会一直禁用", async () => {
    const { taskId, refuse, pending } = await launching();
    onDisk = occupied("launching");
    emit(LAUNCH_PHASE_EVENT, { task_id: taskId, phase: "preparing", stage_index: 0 } satisfies LaunchPhaseEvent);
    await settle();
    expect(repairLock()).toEqual(IN_USE);

    onDisk = idle();
    refuse(cancelledError());
    await pending;
    await settle();
    expect(repairLock()).toBeNull();
  });

  it("导入整合包：平台包下载那条阶段早于占用，占住之后的阶段照样把基底读进列表", async () => {
    const pack = "空岛生存";
    const done = deferred<unknown>();
    ipc.overrides.set("install_modpack", () => done.promise);
    await store.actions.installModpack({
      source: { kind: "file", path: "C:/packs/pack.mrpack" },
      name: pack,
      cover: "grass",
      packName: pack,
      packVersion: "1.0.0",
      modCount: 0,
      mcVersion: BASE,
      loader: "neoforge",
      loaderVersion: "21.1.265",
      excludedOptional: [],
    });
    await settle();
    const call = callsOf(ipc, "install_modpack")[0];
    if (call === undefined) throw new Error("导入没有开始");
    const taskId = String(call.taskId);

    emit(CORE_EVENT, { kind: "stage", task_id: taskId, message: "下载整合包 pack.mrpack" });
    await settle();
    expect(repairLock()).toBeNull();

    onDisk = [instanceDto(BASE, { activity: "inherited", used_by: pack }), instanceDto(CHILD), instanceDto(pack, { activity: "installing" })];
    emit(CORE_EVENT, { kind: "stage", task_id: taskId, message: "下载 3 个整合包文件" });
    await settle();
    expect(repairLock()).toEqual({ kind: "inherited", usedBy: pack });
  });

  it("不占基底的任务（向导新建的实例是自包含的）的阶段事件不重扫", async () => {
    const done = deferred<unknown>();
    ipc.overrides.set("install_version", () => done.promise);
    await store.actions.createInstance({ name: "新世界", mcVersion: "1.21.1", loader: "vanilla", loaderVersion: null, cover: "grass" });
    await settle();
    const call = callsOf(ipc, "install_version")[0];
    if (call === undefined) throw new Error("安装没有开始");
    const before = callsOf(ipc, "list_instances").length;
    emit(CORE_EVENT, { kind: "stage", task_id: String(call.taskId), message: "查找原版 1.21.1" });
    await settle();
    expect(callsOf(ipc, "list_instances")).toHaveLength(before);
  });
});

describe("排队的任务撞上基底占用", () => {
  it("补全基底被拒：任务失败原因用「正在使用它」，不是后端原文", async () => {
    ipc.overrides.set("repair_instance", () =>
      Promise.reject(new IpcError("instance_busy", `实例 ${BASE} 正在被实例 ${CHILD} 使用，请稍后再试`, { id: BASE, activity: "inherited", used_by: CHILD })),
    );
    await store.actions.repairInstance(BASE);
    await settle();
    const task = store.getState().tasks.find((t) => t.instanceId === BASE);
    expect(task).toMatchObject({ status: "failed", error: { code: "instance_busy", message: `实例「${CHILD}」正在使用它` } });
    expect(store.getState().toasts.at(-1)).toMatchObject({ body: `实例「${CHILD}」正在使用它` });
  });
});
