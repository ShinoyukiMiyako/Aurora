// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IpcError } from "../ipc/errors";
import type { ModpackExportOptions, ModpackExportOutcomeDto } from "../ipc/modpack";
import { CORE_EVENT, type TaskRecordDto } from "../ipc/tasks";
import type { IpcRecorder } from "../test/fake-bridge";
import { bootOverrides, callsOf, deferred, emit, resetRecorder, settle, startedStore } from "../test/launcher";
import type { LauncherStore } from "./store";
import type { Toast } from "./toasts";

const ipc = vi.hoisted((): IpcRecorder => ({ calls: [], overrides: new Map() }));
vi.mock("../ipc/bridge", async (orig) => (await import("../test/fake-bridge")).fakeBridge(await orig(), ipc));

const T0 = 1_720_000_000_000;
const DEST = "D:\\分享\\周末包 1.2.0.mrpack";
const OPTIONS: ModpackExportOptions = {
  destination: DEST,
  name: "周末包",
  version: "1.2.0",
  summary: "和朋友一起玩的那套",
  extras: ["config", "options", "saves"],
  include_disabled: true,
};

function outcome(bundled: string[], over: Partial<ModpackExportOutcomeDto> = {}): ModpackExportOutcomeDto {
  return {
    path: DEST,
    name: "周末包",
    version: "1.2.0",
    bytes: 1_234_567,
    indexed_files: 12,
    override_files: 40,
    bundled_mods: bundled,
    disabled_mods: 1,
    skipped: [],
    ...over,
  };
}

let store: LauncherStore;

beforeEach(async () => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
  resetRecorder(ipc);
  bootOverrides(ipc);
  store = await startedStore();
});

afterEach(() => {
  store.stop();
  vi.useRealTimers();
});

function lastToast(): Toast {
  const toast = store.getState().toasts.at(-1);
  if (toast === undefined) throw new Error("没有通知");
  return toast;
}

async function runAction(toast: Toast): Promise<void> {
  const action = toast.action;
  if (action === undefined || !("run" in action)) throw new Error(`通知「${toast.title}」没有命令类动作`);
  await action.run();
}

describe("导出整合包任务", () => {
  it("入队即开始：任务挂在实例上，命令参数为 taskId、id 与 options，期间实例算改动中、不算安装中", async () => {
    const pending = deferred<ModpackExportOutcomeDto>();
    ipc.overrides.set("export_modpack", () => pending.promise);
    const id = await store.actions.exportModpack("生存", OPTIONS);
    await settle();
    expect(callsOf(ipc, "export_modpack")).toEqual([{ taskId: `${id}#1`, id: "生存", options: OPTIONS }]);
    const task = store.getState().tasks.find((t) => t.id === id);
    expect(task).toMatchObject({ kind: "modpack_export", title: "导出整合包 周末包", detail: "1.2.0 · 「生存」", instanceId: "生存", status: "running" });
    expect(store.getState().instances.find((i) => i.id === "生存")).toMatchObject({ status: "ready", activity: "modifying" });
    // 开始导出的提示
    expect(store.getState().toasts.map((t) => [t.tone, t.title, t.body])).toEqual([["info", "已开始导出「周末包」", "进度见下载任务"]]);

    // 打包进度按下载进度同一套规则记到任务上
    emit(CORE_EVENT, { task_id: `${id}#1`, kind: "download", total: 40, finished: 10, bytes: 300, total_bytes: 1200, speed: 600 });
    expect(store.getState().tasks.find((t) => t.id === id)).toMatchObject({ bytes: 300, totalBytes: 1200, progress: 0.25 });
    pending.resolve(outcome([]));
    await settle();
  });

  it("完成：Toast 标题「已导出「名称」」，没有打包进文件的 Mod 时没有正文；「打开所在文件夹」在资源管理器里选中导出的文件", async () => {
    ipc.overrides.set("export_modpack", () => outcome([]));
    ipc.overrides.set("reveal_in_folder", () => null);
    const id = await store.actions.exportModpack("生存", OPTIONS);
    await settle();
    expect(store.getState().tasks.find((t) => t.id === id)?.status).toBe("done");
    const toast = lastToast();
    expect([toast.tone, toast.title, toast.body]).toEqual(["success", "已导出「周末包」", undefined]);
    expect(toast.action?.label).toBe("打开所在文件夹");
    await runAction(toast);
    expect(callsOf(ipc, "reveal_in_folder")).toEqual([{ path: DEST }]);
    // 实例没有被当成装好或改过：导出不重扫实例列表
    expect(callsOf(ipc, "list_instances")).toHaveLength(1);
  });

  it("有 Mod 打包进了文件时正文提醒确认转载许可", async () => {
    ipc.overrides.set("export_modpack", () => outcome(["handmade-1.0.jar", "private-2.jar"]));
    await store.actions.exportModpack("生存", OPTIONS);
    await settle();
    expect([lastToast().title, lastToast().body]).toEqual(["已导出「周末包」", "2 个 Mod 打包进了文件，分享前确认作者允许转载"]);
  });

  it("失败：Toast 标题写「导出失败：」，正文用失败原因；两次失败各自一条，不并成「n 个下载失败」", async () => {
    ipc.overrides.set("export_modpack", () => {
      throw new IpcError("modpack_export_check_failed", "导出的整合包没通过回读校验：条目数对不上", { path: DEST, reason: "条目数对不上" });
    });
    const first = await store.actions.exportModpack("生存", OPTIONS);
    await settle();
    expect(store.getState().tasks.find((t) => t.id === first)).toMatchObject({ status: "failed", error: { code: "modpack_export_check_failed" } });
    expect([lastToast().tone, lastToast().title, lastToast().body]).toEqual(["error", "导出失败：导出整合包 周末包", "导出的文件没通过校验，已删除"]);
    expect(lastToast().action?.label).toBe("重试");

    await store.actions.exportModpack("创造", { ...OPTIONS, name: "创造包" });
    await settle();
    const errors = store.getState().toasts.filter((t) => t.tone === "error").map((t) => t.title);
    expect(errors).toEqual(["导出失败：导出整合包 周末包", "导出失败：导出整合包 创造包"]);
  });

  it("同一份导出已在队列里时不重复入队，交回那个任务的 id", async () => {
    ipc.overrides.set("export_modpack", () => new Promise(() => undefined));
    const first = await store.actions.exportModpack("生存", OPTIONS);
    const again = await store.actions.exportModpack("生存", OPTIONS);
    expect(again).toBe(first);
    expect(store.getState().tasks.filter((t) => t.kind === "modpack_export")).toHaveLength(1);
    expect(lastToast().title).toBe("周末包 已在下载队列里");
    // 换个位置是另一份导出
    const other = await store.actions.exportModpack("生存", { ...OPTIONS, destination: "D:\\备份\\周末包.mrpack" });
    expect(other).not.toBe(first);
  });

  it("从任务表恢复的导出任务按命令参数还原名称：重试成功后照常发「已导出」", async () => {
    store.stop();
    const record: TaskRecordDto = {
      id: "task-export",
      kind: "modpack_export",
      title: "导出整合包 周末包",
      detail: "1.2.0 · 「生存」",
      instance_id: "生存",
      status: "failed",
      progress: 0.5,
      bytes: 0,
      total_bytes: null,
      speed_bps: 0,
      attempt: 1,
      error: { code: "interrupted", message: "关闭时中断" },
      created_at: T0 - 60_000,
      finished_at: T0 - 1000,
      spec: { command: "export_modpack", args: { id: "生存", options: OPTIONS } },
    };
    resetRecorder(ipc);
    bootOverrides(ipc, { journal: [record] });
    ipc.overrides.set("export_modpack", () => outcome(["handmade-1.0.jar"]));
    store = await startedStore();
    expect(store.getState().tasks.map((t) => [t.id, t.kind, t.status])).toEqual([["task-export", "modpack_export", "failed"]]);
    store.actions.retryTask("task-export");
    await settle();
    expect(callsOf(ipc, "export_modpack")).toEqual([{ taskId: "task-export#2", id: "生存", options: OPTIONS }]);
    expect([lastToast().title, lastToast().body, lastToast().action?.label]).toEqual(["已导出「周末包」", "1 个 Mod 打包进了文件，分享前确认作者允许转载", "打开所在文件夹"]);
  });

  it("上次关闭时写到一半的导出：启动时按落点收掉临时文件，已经结束的和别的任务不动", async () => {
    store.stop();
    const record = (id: string, status: TaskRecordDto["status"], spec: TaskRecordDto["spec"]): TaskRecordDto => ({
      id,
      kind: "modpack_export",
      title: id,
      detail: "",
      instance_id: "生存",
      status,
      progress: 0.5,
      bytes: 0,
      total_bytes: null,
      speed_bps: 0,
      attempt: 1,
      error: null,
      created_at: T0 - 60_000,
      finished_at: null,
      spec,
    });
    resetRecorder(ipc);
    bootOverrides(ipc, {
      journal: [
        record("pack", "running", { command: "export_modpack", args: { id: "生存", options: { ...OPTIONS, destination: "D:/out/包.mrpack" } } }),
        record("world", "running", { command: "export_world", args: { id: "生存", world: "w", dest: "D:/out/存档.zip" } }),
        record("finished", "done", { command: "export_world", args: { id: "生存", world: "w", dest: "D:/out/完成.zip" } }),
        record("backup", "running", { command: "backup_world", args: { id: "生存", world: "w" } }),
      ],
    });
    store = await startedStore();
    await settle();
    expect(callsOf(ipc, "discard_export_leftovers").map((a) => a.dest)).toEqual(["D:/out/包.mrpack", "D:/out/存档.zip"]);
  });

  it("任务表里的导出任务缺 options.name 时重试直接报错，不调命令、不发没有名字的通知", async () => {
    store.stop();
    const broken: TaskRecordDto = {
      id: "task-bad",
      kind: "modpack_export",
      title: "导出整合包 ?",
      detail: "",
      instance_id: "生存",
      status: "failed",
      progress: 0,
      bytes: 0,
      total_bytes: null,
      speed_bps: 0,
      attempt: 1,
      error: { code: "interrupted", message: "关闭时中断" },
      created_at: T0 - 60_000,
      finished_at: T0 - 1000,
      spec: { command: "export_modpack", args: { id: "生存", options: { ...OPTIONS, name: 7 } } },
    };
    resetRecorder(ipc);
    bootOverrides(ipc, { journal: [broken] });
    ipc.overrides.set("export_modpack", () => outcome([]));
    store = await startedStore();
    expect(() => store.actions.retryTask("task-bad")).toThrow("任务 export_modpack 的参数 name 应为字符串");
    await settle();
    expect(callsOf(ipc, "export_modpack")).toEqual([]);
    expect(store.getState().tasks.map((t) => [t.id, t.status])).toEqual([["task-bad", "failed"]]);
    expect(store.getState().toasts.map((t) => t.title)).not.toContain("已导出「周末包」");
  });

  it("全部重试撞上一条坏记录时照样报错，排回队列的那几条不留在排队里", async () => {
    store.stop();
    const record = (id: string, name: unknown): TaskRecordDto => ({
      id,
      kind: "modpack_export",
      title: "导出整合包",
      detail: "",
      instance_id: "生存",
      status: "failed",
      progress: 0,
      bytes: 0,
      total_bytes: null,
      speed_bps: 0,
      attempt: 1,
      error: { code: "interrupted", message: "关闭时中断" },
      created_at: T0 - 60_000,
      finished_at: T0 - 1000,
      spec: { command: "export_modpack", args: { id: "生存", options: { ...OPTIONS, name } } },
    });
    resetRecorder(ipc);
    bootOverrides(ipc, { journal: [record("task-good", "周末包"), record("task-bad", 7)] });
    ipc.overrides.set("export_modpack", () => outcome([]));
    store = await startedStore();
    expect(() => store.actions.retryFailedTasks()).toThrow("任务 export_modpack 的参数 name 应为字符串");
    await settle();
    expect(callsOf(ipc, "export_modpack")).toEqual([{ taskId: "task-good#2", id: "生存", options: OPTIONS }]);
    expect(store.getState().tasks.find((t) => t.id === "task-good")?.status).toBe("done");
  });
});
