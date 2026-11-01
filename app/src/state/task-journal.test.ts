// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TASK_INTERRUPTED_CODE } from "../copy/flows";
import { IpcError } from "../ipc/errors";
import type { InstanceDto } from "../ipc/instances";
import { mockInvoke, resetMocks } from "../ipc/mock";
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
