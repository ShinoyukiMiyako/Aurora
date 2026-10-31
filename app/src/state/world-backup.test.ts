// @vitest-environment jsdom
// 存档备份的状态层：入队、落地后的通知与缓存失效、失败、删除一份、游戏退出后的自动备份事件，以及改名时备份没跟上。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IpcError } from "../ipc/errors";
import type { BackupResultDto, ExportResultDto, InstanceDto, RestoreResultDto } from "../ipc/instances";
import { WORLD_BACKUP_EVENT, type WorldBackupEvent } from "../ipc/launch";
import type { TaskRecordDto } from "../ipc/tasks";
import type { IpcRecorder } from "../test/fake-bridge";
import { bootOverrides, callsOf, deferred, emit, instanceDto, resetRecorder, settle, startedStore, type Deferred } from "../test/launcher";
import { resources } from "./resource";
import { busyWorlds } from "./selectors";
import { worldBackupsKey, type LauncherStore } from "./store";

const ipc = vi.hoisted((): IpcRecorder => ({ calls: [], overrides: new Map() }));
vi.mock("../ipc/bridge", async (orig) => (await import("../test/fake-bridge")).fakeBridge(await orig(), ipc));

const MB = 1_048_576;

let instances: InstanceDto[];
let store: LauncherStore;

function backupResult(pruned: number): BackupResultDto {
  return { backup: { file: "1720000000000-manual.zip", kind: "manual", created_at: 1_720_000_000_000, size_bytes: 3 * MB, level_name: "旧世界" }, pruned };
}

function toasts(): [string, string, string | undefined][] {
  return store.getState().toasts.map((t) => [t.tone, t.title, t.body]);
}

function toast(title: string) {
  const found = store.getState().toasts.find((t) => t.title === title);
  if (found === undefined) throw new Error(`没有标题为「${title}」的通知`);
  return found;
}

/** 让通知上的命令型操作跑一遍（与外壳的 runToastAction 一样直接调用 run）。 */
async function runAction(title: string): Promise<void> {
  const action = toast(title).action;
  if (action === undefined || !("run" in action)) throw new Error(`「${title}」没有可执行的操作`);
  await action.run();
}

/** 读一次某个缓存条目；返回读的次数计数器，失效后再读会多一次。 */
function cacheProbe(key: string) {
  const fetcher = vi.fn(() => Promise.resolve({ key }));
  return { fetcher, read: () => resources.read(key, fetcher) };
}

beforeEach(async () => {
  vi.useFakeTimers();
  vi.setSystemTime(1_720_000_000_000);
  resetRecorder(ipc);
  resources.clear();
  instances = [instanceDto("生存"), instanceDto("创造")];
  bootOverrides(ipc);
  ipc.overrides.set("list_instances", () => instances);
  store = await startedStore();
});

afterEach(() => {
  store.stop();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("备份、导出与恢复入队", () => {
  let pending: Deferred<BackupResultDto>;

  beforeEach(() => {
    pending = deferred<BackupResultDto>();
    ipc.overrides.set("backup_world", () => pending.promise);
  });

  it("备份：任务记作 world_backup，标题写存档名、详情写实例名，命令只带实例与存档文件夹名；入队即提示", async () => {
    await store.actions.backupWorld("生存", "w1", "旧世界");
    await settle();
    const [task] = store.getState().tasks;
    expect(task).toMatchObject({ kind: "world_backup", title: "备份「旧世界」", detail: "「生存」", instanceId: "生存", status: "running" });
    expect(task.spec).toEqual({ command: "backup_world", args: { id: "生存", world: "w1" } });
    expect(callsOf(ipc, "backup_world")).toEqual([{ id: "生存", world: "w1", taskId: `${task.id}#1` }]);
    expect(toasts()).toContainEqual(["info", "已开始备份「旧世界」", "进度可以在下载任务里查看"]);
    // 备份期间实例只算改动中，不画成安装中
    const inst = store.getState().instances.find((i) => i.id === "生存");
    expect(inst).toMatchObject({ status: "ready", activity: "modifying" });
    expect(busyWorlds(store.getState(), "生存")).toEqual(["w1"]);
    expect(busyWorlds(store.getState(), "创造")).toEqual([]);
  });

  it("同一个存档的备份已在队列里：不再入队，只提示重复", async () => {
    await store.actions.backupWorld("生存", "w1", "旧世界");
    await store.actions.backupWorld("生存", "w1", "旧世界");
    await settle();
    expect(store.getState().tasks).toHaveLength(1);
    expect(toasts().filter(([, title]) => title === "已开始备份「旧世界」")).toHaveLength(1);
    expect(toasts()).toContainEqual(["info", "备份「旧世界」 已在下载队列里", undefined]);
  });

  it("完成：通知写大小与清掉的旧备份份数，带「查看备份」回到实例概览；备份列表与存档内容失效，实例列表重扫", async () => {
    const list = cacheProbe(worldBackupsKey("生存", "w1"));
    const shared = cacheProbe(worldBackupsKey("创造", "w1"));
    const content = cacheProbe("content:生存");
    await Promise.all([list.read(), shared.read(), content.read()]);
    await store.actions.backupWorld("生存", "w1", "旧世界");
    await settle();
    const scans = callsOf(ipc, "list_instances").length;
    pending.resolve(backupResult(2));
    await settle();
    expect(store.getState().tasks[0].status).toBe("done");
    expect(toasts()).toContainEqual(["success", "已备份「旧世界」", "3.0 MB · 清理了 2 份旧的自动备份"]);
    expect(toast("已备份「旧世界」").action).toEqual({ label: "查看备份", to: { page: "instance", id: "生存", tab: "overview" } });
    expect(callsOf(ipc, "list_instances").length).toBe(scans + 1);
    await Promise.all([list.read(), shared.read(), content.read()]);
    // 共用存档的几个实例看到同一份备份表：别的实例下同名存档的列表一起失效
    expect([list.fetcher.mock.calls.length, shared.fetcher.mock.calls.length, content.fetcher.mock.calls.length]).toEqual([2, 2, 2]);
  });

  it("完成时没有清理旧备份：正文只写大小", async () => {
    await store.actions.backupWorld("生存", "w1", "旧世界");
    await settle();
    pending.resolve(backupResult(0));
    await settle();
    expect(toasts()).toContainEqual(["success", "已备份「旧世界」", "3.0 MB"]);
  });

  it("游戏运行中直接拒绝，不入队", async () => {
    ipc.overrides.set("launch_game", () => new Promise(() => undefined));
    void store.actions.launch("生存");
    await settle();
    await expect(store.actions.backupWorld("生存", "w1", "旧世界")).rejects.toThrow("「生存」的游戏正在运行，退出后再备份");
    await expect(store.actions.exportWorld("生存", "w1", "旧世界", "D:\\a.zip")).rejects.toThrow("退出后再导出");
    await expect(store.actions.restoreWorldBackup("生存", "w1", "旧世界", "1-auto.zip")).rejects.toThrow("退出后再恢复");
    expect(store.getState().tasks).toEqual([]);
  });

  it("导出：同样记作 world_backup，标题写「导出」；完成后通知写路径，「打开所在文件夹」在文件管理器里定位到它", async () => {
    const exported = deferred<ExportResultDto>();
    ipc.overrides.set("export_world", () => exported.promise);
    ipc.overrides.set("plugin:opener|reveal_item_in_dir", () => null);
    await store.actions.exportWorld("生存", "w1", "旧世界", "D:\\导出\\w1.zip");
    await settle();
    const [task] = store.getState().tasks;
    expect(task).toMatchObject({ kind: "world_backup", title: "导出「旧世界」" });
    expect(callsOf(ipc, "export_world")).toEqual([{ id: "生存", world: "w1", dest: "D:\\导出\\w1.zip", taskId: `${task.id}#1` }]);
    // 导出不弹「已开始备份」
    expect(toasts().map(([, title]) => title)).not.toContain("已开始备份「旧世界」");
    exported.resolve({ path: "D:\\导出\\w1.zip", size_bytes: 3 * MB });
    await settle();
    expect(toasts()).toContainEqual(["success", "已导出「旧世界」", "D:\\导出\\w1.zip"]);
    expect(toast("已导出「旧世界」").action?.label).toBe("打开所在文件夹");
    await runAction("已导出「旧世界」");
    expect(callsOf(ipc, "plugin:opener|reveal_item_in_dir")).toEqual([{ paths: ["D:\\导出\\w1.zip"] }]);
  });

  it("恢复：记作 world_restore；完成后说原存档进了回收站，原来没有这个存档时不说", async () => {
    const restored: Deferred<RestoreResultDto>[] = [deferred<RestoreResultDto>(), deferred<RestoreResultDto>()];
    let call = 0;
    ipc.overrides.set("restore_world_backup", () => restored[call++].promise);
    const content = cacheProbe("content:生存");
    await content.read();
    await store.actions.restoreWorldBackup("生存", "w1", "旧世界", "1700000000000-auto.zip");
    await settle();
    const [task] = store.getState().tasks;
    expect(task).toMatchObject({ kind: "world_restore", title: "恢复「旧世界」", detail: "「生存」" });
    expect(callsOf(ipc, "restore_world_backup")).toEqual([{ id: "生存", world: "w1", file: "1700000000000-auto.zip", taskId: `${task.id}#1` }]);
    restored[0].resolve({ world: "w1", previous_in_recycle_bin: true });
    await settle();
    expect(toasts()).toContainEqual(["success", "已恢复「旧世界」", "原来的存档已移入回收站"]);
    await content.read();
    expect(content.fetcher).toHaveBeenCalledTimes(2);

    await store.actions.restoreWorldBackup("生存", "w2", "新世界", "1700000000001-manual.zip");
    await settle();
    restored[1].resolve({ world: "w2", previous_in_recycle_bin: false });
    await settle();
    expect(toasts()).toContainEqual(["success", "已恢复「新世界」", undefined]);
  });

  it("失败：各自一条「没有完成」，正文按错误码给统一说法；不并进下载失败的合并通知；列表与实例重读", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    ipc.overrides.set("install_java", () => Promise.reject(new IpcError("network_failed", "连接被重置")));
    await store.actions.installJava(21);
    await store.actions.backupWorld("生存", "w1", "旧世界");
    await settle();
    const list = cacheProbe(worldBackupsKey("生存", "w1"));
    await list.read();
    const scans = callsOf(ipc, "list_instances").length;
    pending.reject(new IpcError("world_in_use", "这个存档正被游戏打开，退出游戏后再试", { path: "D:/saves/w1" }));
    await settle();
    const task = store.getState().tasks.find((t) => t.kind === "world_backup");
    expect(task).toMatchObject({ status: "failed", error: { code: "world_in_use" } });
    expect(toasts()).toContainEqual(["error", "备份「旧世界」没有完成", "这个存档正被游戏打开"]);
    expect(toasts()).toContainEqual(["error", "下载失败：下载 Java 21", "网络连接失败"]);
    expect(toasts().map(([, title]) => title)).not.toContain("2 个下载失败");
    expect(toast("备份「旧世界」没有完成").action?.label).toBe("重试");
    expect(callsOf(ipc, "list_instances").length).toBe(scans + 1);
    await list.read();
    expect(list.fetcher).toHaveBeenCalledTimes(2);
  });
});

describe("删除一份备份", () => {
  it("直接调后端（不入队）、提示已移入回收站，列表失效", async () => {
    ipc.overrides.set("delete_world_backup", () => null);
    const list = cacheProbe(worldBackupsKey("生存", "w1"));
    await list.read();
    await store.actions.deleteWorldBackup("生存", "w1", "1700000000000-auto.zip");
    expect(callsOf(ipc, "delete_world_backup")).toEqual([{ id: "生存", world: "w1", file: "1700000000000-auto.zip" }]);
    expect(store.getState().tasks).toEqual([]);
    expect(toasts()).toContainEqual(["info", "已删除一份备份", "已移入回收站"]);
    await list.read();
    expect(list.fetcher).toHaveBeenCalledTimes(2);
  });

  it("后端拒绝时原样抛出，不提示删除成功、不失效", async () => {
    ipc.overrides.set("delete_world_backup", () => Promise.reject(new IpcError("world_backup_not_found", "这份备份已经不在了", { id: "生存", world: "w1", file: "x.zip" })));
    const list = cacheProbe(worldBackupsKey("生存", "w1"));
    await list.read();
    await expect(store.actions.deleteWorldBackup("生存", "w1", "x.zip")).rejects.toMatchObject({ code: "world_backup_not_found" });
    expect(toasts().map(([, title]) => title)).not.toContain("已删除一份备份");
    await list.read();
    expect(list.fetcher).toHaveBeenCalledTimes(1);
  });
});

describe("游戏退出后的自动备份", () => {
  const event = (over: Partial<WorldBackupEvent>): WorldBackupEvent => ({ instance_id: "生存", backed_up: [], failed: [], ...over });

  it("都备份成了：列表失效、实例重扫（清掉 backing_up），不弹通知", async () => {
    const list = cacheProbe(worldBackupsKey("生存", "w1"));
    await list.read();
    const scans = callsOf(ipc, "list_instances").length;
    emit(WORLD_BACKUP_EVENT, event({ backed_up: ["w1", "w2"] }));
    await settle();
    expect(callsOf(ipc, "list_instances").length).toBe(scans + 1);
    await list.read();
    expect(list.fetcher).toHaveBeenCalledTimes(2);
    expect(store.getState().toasts).toEqual([]);
  });

  it("有存档没备份成：error 通知，正文是第一个失败的原文；「复制错误原文」写进全部失败与详情", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const writeText = vi.fn(() => Promise.resolve());
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    emit(
      WORLD_BACKUP_EVENT,
      event({
        backed_up: ["w1"],
        failed: [
          { world: "w2", error: { code: "world_in_use", message: "这个存档正被游戏打开，退出游戏后再试", detail: { path: "D:/saves/w2" } } },
          { world: "w3", error: { code: "io", message: "磁盘已满" } },
        ],
      }),
    );
    await settle();
    expect(toasts()).toEqual([["error", "「生存」的自动备份没有完成", "这个存档正被游戏打开，退出游戏后再试"]]);
    expect(toast("「生存」的自动备份没有完成").action?.label).toBe("复制错误原文");
    await runAction("「生存」的自动备份没有完成");
    expect(writeText).toHaveBeenCalledWith('w2：这个存档正被游戏打开，退出游戏后再试\n{"path":"D:/saves/w2"}\nw3：磁盘已满');
    expect(error).toHaveBeenCalledTimes(2);
  });
});

describe("改名时备份没跟上", () => {
  const notMoved = (detail: Record<string, unknown>) =>
    new IpcError("world_backups_not_moved", "实例已改名为「生存二」，但存档备份没能跟着挪：拒绝访问。 (os error 5)", detail);

  it("照改名成功处理，warning 通知写备份还在哪，「打开文件夹」定位到那里", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    ipc.overrides.set("plugin:opener|reveal_item_in_dir", () => null);
    ipc.overrides.set("rename_instance", () => {
      instances = instances.map((i) => (i.id === "生存" ? { ...i, id: "生存二" } : i));
      throw notMoved({ id: "生存", renamed_to: "生存二", path: "D:/Games/.minecraft/.petalfall/backups/instances/生存" });
    });
    expect(await store.actions.renameInstance("生存", "生存二")).toBe("生存二");
    expect(store.getState().instances.map((i) => i.id).sort()).toEqual(["创造", "生存二"]);
    expect(store.getState().lastRename).toMatchObject({ from: "生存", to: "生存二" });
    expect(toasts()).toContainEqual(["warning", "「生存二」的存档备份没能跟着改名", "备份还在 D:/Games/.minecraft/.petalfall/backups/instances/生存"]);
    expect(toasts().map(([, title]) => title)).not.toContain("「生存二」的游玩记录没能跟着改");
    await runAction("「生存二」的存档备份没能跟着改名");
    expect(callsOf(ipc, "plugin:opener|reveal_item_in_dir")).toEqual([{ paths: ["D:/Games/.minecraft/.petalfall/backups/instances/生存"] }]);
  });

  it("缺 detail.path 是契约被破坏：直接报错，不提示", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    ipc.overrides.set("rename_instance", () => {
      instances = instances.map((i) => (i.id === "生存" ? { ...i, id: "生存二" } : i));
      throw notMoved({ id: "生存", renamed_to: "生存二" });
    });
    await expect(store.actions.renameInstance("生存", "生存二")).rejects.toThrow("改名报 world_backups_not_moved 却没给出 detail.path");
  });

  it("删除实例不认这个码：照常抛出", async () => {
    ipc.overrides.set("delete_instance", () => Promise.reject(notMoved({ id: "生存", path: "x" })));
    await expect(store.actions.deleteInstance("生存", 0)).rejects.toMatchObject({ code: "world_backups_not_moved" });
  });

  it("改名后失败的备份任务指向新名字：重试按新名字调用", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    ipc.overrides.set("backup_world", () => Promise.reject(new IpcError("io", "拒绝访问")));
    await store.actions.backupWorld("生存", "w1", "旧世界");
    await settle();
    ipc.overrides.set("rename_instance", () => {
      instances = instances.map((i) => (i.id === "生存" ? { ...i, id: "生存二" } : i));
      return { id: "生存二" };
    });
    await store.actions.renameInstance("生存", "生存二");
    const [task] = store.getState().tasks;
    expect(task).toMatchObject({ instanceId: "生存二", spec: { args: { id: "生存二", world: "w1" } } });
    ipc.overrides.set("backup_world", () => backupResult(0));
    store.actions.retryTask(task.id);
    await settle();
    expect(callsOf(ipc, "backup_world").at(-1)).toEqual({ id: "生存二", world: "w1", taskId: `${task.id}#2` });
    expect(toasts()).toContainEqual(["success", "已备份「旧世界」", "3.0 MB"]);
    expect(toast("已备份「旧世界」").action).toEqual({ label: "查看备份", to: { page: "instance", id: "生存二", tab: "overview" } });
  });
});

describe("重启后恢复的存档任务", () => {
  it("任务日志里的备份任务按命令参数推出上下文：重试成功后通知按文件夹名称呼存档", async () => {
    store.stop();
    const record: TaskRecordDto = {
      id: "task-old",
      kind: "world_backup",
      title: "备份「旧世界」",
      detail: "「生存」",
      instance_id: "生存",
      status: "failed",
      progress: 0,
      bytes: 0,
      total_bytes: null,
      done_bytes: 0,
      speed_bps: 0,
      started_at: 1,
      attempt: 1,
      error: { code: "io", message: "拒绝访问" },
      created_at: 1,
      finished_at: 2,
      spec: { command: "backup_world", args: { id: "生存", world: "w1" } },
    };
    bootOverrides(ipc, { journal: [record] });
    ipc.overrides.set("list_instances", () => instances);
    ipc.overrides.set("backup_world", () => backupResult(1));
    store = await startedStore();
    expect(store.getState().tasks.map((t) => [t.kind, t.status])).toEqual([["world_backup", "failed"]]);
    store.actions.retryTask("task-old");
    await settle();
    expect(callsOf(ipc, "backup_world")).toEqual([{ id: "生存", world: "w1", taskId: "task-old#2" }]);
    expect(toasts()).toContainEqual(["success", "已备份「w1」", "3.0 MB · 清理了 1 份旧的自动备份"]);
  });
});
