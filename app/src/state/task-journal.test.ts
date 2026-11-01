// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TASK_INTERRUPTED_CODE, taskFailureReason } from "../copy/flows";
import { IpcError } from "../ipc/errors";
import type { InstanceDto } from "../ipc/instances";
import { mockInvoke, resetMocks } from "../ipc/mock";
import type { BlockedFileDto } from "../ipc/modpack";
import type { TaskJournalDto, TaskRecordDto } from "../ipc/tasks";
import { TASK_JOURNAL_DEBOUNCE_MS } from "../domain/limits";
import type { IpcRecorder } from "../test/fake-bridge";
import { bootOverrides, callsOf, deferred, instanceDto, resetRecorder, settle, startedStore, type Deferred } from "../test/launcher";
import type { LauncherStore } from "./store";

const ipc = vi.hoisted((): IpcRecorder => ({ calls: [], overrides: new Map() }));
vi.mock("../ipc/bridge", async (orig) => (await import("../test/fake-bridge")).fakeBridge(await orig(), ipc));

const T0 = 1_720_000_000_000;

function record(id: string, status: TaskRecordDto["status"]): TaskRecordDto {
  return {
    id,
    kind: "java",
    title: `Java ${id}`,
    detail: "Mojang 运行时 · 手动",
    instance_id: null,
    status,
    progress: 0.4,
    bytes: 4096,
    total_bytes: 10240,
    speed_bps: 0,
    attempt: 1,
    error: null,
    created_at: T0 - 60_000,
    finished_at: status === "queued" || status === "running" ? null : T0 - 1000,
    spec: { command: "install_java", args: { requiredMajor: 21 } },
  };
}

let journal: () => TaskJournalDto;
let install: Deferred<{ id: string }>;
let instances: InstanceDto[];
let store: LauncherStore;

beforeEach(async () => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
  resetRecorder(ipc);
  instances = [instanceDto("生存")];
  bootOverrides(ipc);
  ipc.overrides.set("list_instances", () => instances);
  journal = () => {
    throw new IpcError("io", "读不到任务日志：文件被占用");
  };
  ipc.overrides.set("load_task_journal", () => journal());
  install = deferred<{ id: string }>();
  ipc.overrides.set("install_version", () => install.promise);
  ipc.overrides.set("set_sidebar_pins", (args) => args.pins);
  const settings = { description: null, cover: null, isolation: "follow_global", memory_mb: null, java: "auto", jvm_args: "", resolution: { width: 854, height: 480 }, fullscreen: false };
  ipc.overrides.set("get_instance_settings", () => settings);
  ipc.overrides.set("set_instance_settings", (args) => args.settings);
  store = await startedStore();
});
afterEach(() => {
  store.stop();
  vi.useRealTimers();
});

describe("任务日志读不出来时", () => {
  it("暂停写回；重试读取时内存里正在跑的任务原样保留，完成后照常落地", async () => {
    expect(store.getState().status.tasks.kind).toBe("error");
    await store.actions.createInstance({ name: "新世界", mcVersion: "1.21.1", loader: "vanilla", loaderVersion: null, cover: "grass" });
    await settle();
    expect(store.getState().tasks.map((t) => t.status)).toEqual(["running"]);
    await vi.advanceTimersByTimeAsync(TASK_JOURNAL_DEBOUNCE_MS * 3);
    expect(callsOf(ipc, "save_task_journal")).toEqual([]);

    journal = () => ({ seq: 0, tasks: [record("old-done", "done"), record("old-running", "running")] });
    await store.actions.reload("tasks");
    expect(store.getState().status.tasks.kind).toBe("ready");
    const tasks = store.getState().tasks;
    expect(tasks.map((t) => [t.id.startsWith("task-") ? "新建" : t.id, t.status])).toEqual([
      ["old-done", "done"],
      ["old-running", "failed"],
      ["新建", "running"],
    ]);
    expect(tasks[1].error).toMatchObject({ code: TASK_INTERRUPTED_CODE });

    // 日志恢复后写回一次，内容包含旧历史与新任务
    await vi.advanceTimersByTimeAsync(TASK_JOURNAL_DEBOUNCE_MS);
    const saved = callsOf(ipc, "save_task_journal");
    expect(saved).toHaveLength(1);
    expect((saved[0].tasks as TaskRecordDto[]).map((r) => r.status)).toEqual(["done", "failed", "running"]);

    instances = [instanceDto("生存"), instanceDto("新世界")];
    install.resolve({ id: "新世界" });
    await settle();
    expect(store.getState().tasks[2].status).toBe("done");
    expect(callsOf(ipc, "set_sidebar_pins")).toEqual([{ pins: ["新世界"] }]);
    expect(store.getState().toasts.map((t) => t.title)).toContain("「新世界」已就绪");
  });

  it("读到过一次之后再重载不改任务表", async () => {
    journal = () => ({ seq: 0, tasks: [record("old-done", "done")] });
    await store.actions.reload("tasks");
    expect(store.getState().tasks.map((t) => t.id)).toEqual(["old-done"]);
    await store.actions.createInstance({ name: "新世界", mcVersion: "1.21.1", loader: "vanilla", loaderVersion: null, cover: "grass" });
    await settle();
    journal = () => ({ seq: 0, tasks: [record("old-done", "done"), record("from-elsewhere", "running")] });
    await store.actions.reload("tasks");
    expect(store.getState().tasks.map((t) => [t.id.startsWith("task-") ? "新建" : t.id, t.status])).toEqual([
      ["old-done", "done"],
      ["新建", "running"],
    ]);
  });

  it("日志文件损坏（内容救不回来）时照常写回，任务表还能存下来", async () => {
    store.stop();
    resetRecorder(ipc);
    bootOverrides(ipc);
    ipc.overrides.set("load_task_journal", () => {
      throw new IpcError("task_journal_invalid", "任务日志的版本是 2，当前只认 1");
    });
    ipc.overrides.set("install_version", () => new Promise(() => undefined));
    store = await startedStore();
    expect(store.getState().status.tasks.kind).toBe("error");
    await store.actions.createInstance({ name: "新世界", mcVersion: "1.21.1", loader: "vanilla", loaderVersion: null, cover: "grass" });
    await vi.advanceTimersByTimeAsync(TASK_JOURNAL_DEBOUNCE_MS);
    expect(callsOf(ipc, "save_task_journal")).toHaveLength(1);
  });
});

describe("任务日志的序号", () => {
  /** 重启状态容器，任务日志直接读写假后端；seq 大于 0 时假后端里预先落好序号为 seq 的一份。 */
  async function restartOnMockJournal(seq: number): Promise<void> {
    store.stop();
    resetRecorder(ipc);
    resetMocks();
    bootOverrides(ipc);
    ipc.overrides.delete("load_task_journal");
    ipc.overrides.delete("save_task_journal");
    if (seq > 0) await mockInvoke("save_task_journal", { seq, tasks: [record("old-done", "done")] });
    store = await startedStore();
    expect(store.getState().status.tasks.kind).toBe("ready");
  }
  const savedSeqs = () => callsOf(ipc, "save_task_journal").map((args) => args.seq);

  it("从盘上那份的序号之后接着编，防抖写入与立即写入都各加一", async () => {
    // 0 是从未写过或加序号之前写下的日志
    for (const base of [0, 1 + Math.floor(Math.random() * 1_000_000)]) {
      await restartOnMockJournal(base);
      await store.actions.flushTaskJournal();
      store.actions.clearFinishedTasks();
      await vi.advanceTimersByTimeAsync(TASK_JOURNAL_DEBOUNCE_MS);
      await store.actions.flushTaskJournal();
      expect(savedSeqs(), `盘上序号 ${base}`).toEqual([base + 1, base + 2, base + 3]);
      expect(await mockInvoke("load_task_journal"), `盘上序号 ${base}`).toEqual({ seq: base + 3, tasks: [] });
    }
  });

  it("两次写入并发、先发出的那份晚到：盘上留下序号大、内容新的那份", async () => {
    await restartOnMockJournal(7);
    const gates: Deferred<void>[] = [];
    ipc.overrides.set("save_task_journal", async (args) => {
      const gate = deferred<void>();
      gates.push(gate);
      await gate.promise;
      return mockInvoke("save_task_journal", args);
    });

    const older = store.actions.flushTaskJournal();
    store.actions.clearFinishedTasks();
    const newer = store.actions.flushTaskJournal();
    const sent = callsOf(ipc, "save_task_journal").map((args) => [args.seq, (args.tasks as TaskRecordDto[]).map((r) => r.id)]);
    expect(sent).toEqual([
      [8, ["old-done"]],
      [9, []],
    ]);

    gates[1].resolve();
    await newer;
    gates[0].resolve();
    await older;
    expect(await mockInvoke("load_task_journal")).toEqual({ seq: 9, tasks: [] });
  });

  it("日志读不出期间写回过：之后读到的序号更小也不倒退，更大则从它之后接着编", async () => {
    store.stop();
    resetRecorder(ipc);
    bootOverrides(ipc);
    let onDisk: () => TaskJournalDto = () => {
      throw new IpcError("task_journal_invalid", "任务日志已损坏");
    };
    ipc.overrides.set("load_task_journal", () => onDisk());
    store = await startedStore();
    await store.actions.flushTaskJournal();
    await store.actions.flushTaskJournal();
    expect(savedSeqs()).toEqual([1, 2]);

    onDisk = () => ({ seq: 1, tasks: [] });
    await store.actions.reload("tasks");
    await store.actions.flushTaskJournal();
    expect(savedSeqs()).toEqual([1, 2, 3]);

    onDisk = () => ({ seq: 10, tasks: [] });
    await store.actions.reload("tasks");
    await store.actions.flushTaskJournal();
    expect(savedSeqs()).toEqual([1, 2, 3, 11]);
  });
});

describe("需要手动下载的文件清单随失败记录进任务日志", () => {
  const BLOCKED: BlockedFileDto[] = [
    {
      project_id: 900001,
      file_id: 5000001,
      file_name: "blocked-a.jar",
      web_url: "https://www.curseforge.com/minecraft/mc-mods/blocked-a/files/5000001",
      destination: "mods/blocked-a.jar",
      sha1: "3f786850e387550fdab836ed7e6dc881de23001b",
      fingerprint: 0,
      size: 1024,
    },
    {
      project_id: 900002,
      file_id: 5000002,
      file_name: "blocked-b.jar",
      web_url: "https://www.curseforge.com/minecraft/mc-mods/blocked-b/files/5000002",
      destination: "mods/blocked-b.jar",
      sha1: null,
      fingerprint: 4_294_967_295,
      size: null,
    },
  ];
  const MESSAGE = "这些文件的作者不允许启动器直接下载，需要到 CurseForge 网页手动下载：blocked-a.jar、blocked-b.jar";

  function packRecord(id: string, error: TaskRecordDto["error"]): TaskRecordDto {
    return {
      ...record(id, "failed"),
      kind: "modpack",
      title: "导入整合包 樱落",
      instance_id: "樱落",
      error,
      spec: { command: "install_modpack", args: { source: { kind: "file", path: "D:\\packs\\樱落.zip" }, name: "樱落", excludedOptional: [] } },
    };
  }

  it("较早的日志：distribution_blocked 的记录没有清单，照常读入，失败原因用当时的原文", async () => {
    journal = () => ({ seq: 0, tasks: [packRecord("old", { code: "distribution_blocked", message: MESSAGE })] });
    await store.actions.reload("tasks");
    expect(store.getState().status.tasks.kind).toBe("ready");
    const [task] = store.getState().tasks;
    expect(task.error).toEqual({ code: "distribution_blocked", message: MESSAGE });
    expect(task.error === null ? null : taskFailureReason(task.error)).toBe(MESSAGE);
  });

  it("带清单的记录逐项读回；清单形状不对按日志读不出处理，任务表不被半份数据覆盖", async () => {
    journal = () => ({ seq: 0, tasks: [packRecord("with-files", { code: "distribution_blocked", message: MESSAGE, blocked_files: BLOCKED } as TaskRecordDto["error"])] });
    await store.actions.reload("tasks");
    expect(store.getState().tasks[0].error).toEqual({ code: "distribution_blocked", message: MESSAGE, blocked_files: BLOCKED });
    expect(taskFailureReason({ code: "distribution_blocked", message: MESSAGE, blocked_files: BLOCKED })).toBe("有 2 个文件需要到 CurseForge 网页手动下载");

    store.stop();
    resetRecorder(ipc);
    bootOverrides(ipc);
    // 旧版命令层的 detail.files 是文件名数组：不是清单
    ipc.overrides.set("load_task_journal", () => ({
      seq: 0,
      tasks: [packRecord("broken", { code: "distribution_blocked", message: MESSAGE, blocked_files: ["blocked-a.jar"] } as unknown as TaskRecordDto["error"])],
    }));
    store = await startedStore();
    expect(store.getState().status.tasks).toMatchObject({ kind: "error", error: { message: expect.stringContaining("blocked_files[0] 应是对象") } });
    expect(store.getState().tasks).toEqual([]);
  });

  it("导入以 distribution_blocked 失败：清单与跳过的可选文件一起写进日志，重试时原样带上", async () => {
    journal = () => ({ seq: 0, tasks: [] });
    await store.actions.reload("tasks");
    let attempts = 0;
    ipc.overrides.set("install_modpack", () => {
      attempts += 1;
      if (attempts === 1) throw new IpcError("distribution_blocked", MESSAGE, { files: BLOCKED });
      return new Promise(() => undefined);
    });
    await store.actions.installModpack({
      source: { kind: "file", path: "D:\\packs\\樱落.mrpack" },
      name: "樱落",
      cover: "grass",
      packName: "樱落",
      packVersion: "1.0.0",
      modCount: 41,
      mcVersion: "1.21.1",
      loader: "fabric",
      loaderVersion: "0.16.9",
      excludedOptional: ["mods/optional-helper.jar"],
    });
    await settle();
    const [failed] = store.getState().tasks;
    expect(failed.status).toBe("failed");
    expect(failed.error).toEqual({ code: "distribution_blocked", message: MESSAGE, blocked_files: BLOCKED });
    expect(store.getState().toasts.map((t) => t.body)).toContain("有 2 个文件需要到 CurseForge 网页手动下载");

    await vi.advanceTimersByTimeAsync(TASK_JOURNAL_DEBOUNCE_MS);
    const saved = callsOf(ipc, "save_task_journal");
    const last = saved[saved.length - 1].tasks as TaskRecordDto[];
    expect(last.map((r) => r.error)).toEqual([{ code: "distribution_blocked", message: MESSAGE, blocked_files: BLOCKED }]);
    expect(last[0].spec.args.excludedOptional).toEqual(["mods/optional-helper.jar"]);

    store.actions.retryTask(failed.id);
    await settle();
    const installs = callsOf(ipc, "install_modpack");
    expect(installs).toHaveLength(2);
    expect(installs[1]).toEqual({ ...installs[0], taskId: `${failed.id}#2` });
    expect(installs[1].excludedOptional).toEqual(["mods/optional-helper.jar"]);
    expect(store.getState().tasks[0]).toMatchObject({ status: "running", attempt: 2, error: null });
  });

  it("别的失败不带清单", async () => {
    journal = () => ({ seq: 0, tasks: [] });
    await store.actions.reload("tasks");
    ipc.overrides.set("install_modpack", () => {
      throw new IpcError("curseforge_key_rejected", "CurseForge 拒绝了下载密钥（HTTP 401）：https://edge.forgecdn.net/files/1/2/a.jar", {
        realm: "curseforge",
        url: "https://edge.forgecdn.net/files/1/2/a.jar",
        status: 401,
      });
    });
    await store.actions.installModpack({
      source: { kind: "file", path: "D:\\packs\\樱落.zip" },
      name: "樱落",
      cover: "grass",
      packName: "樱落",
      packVersion: "1.0.0",
      modCount: null,
      mcVersion: "1.21.1",
      loader: "fabric",
      loaderVersion: "0.16.9",
      excludedOptional: [],
    });
    await settle();
    const [failed] = store.getState().tasks;
    expect(failed.error).toEqual({ code: "curseforge_key_rejected", message: "CurseForge 拒绝了下载密钥（HTTP 401）：https://edge.forgecdn.net/files/1/2/a.jar" });
    expect(store.getState().toasts.map((t) => t.body)).toContain("CurseForge 拒绝了下载密钥。设置环境变量 AURORA_CURSEFORGE_API_KEY 换一个可用的密钥后重试");
  });
});
