// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TASK_INTERRUPTED_CODE } from "../copy/flows";
import type { Task } from "../domain/types";
import { CORE_EVENT, type TaskRecordDto } from "../ipc/tasks";
import { APP_NAME } from "../lib/app-info";
import type { IpcRecorder } from "../test/fake-bridge";
import { bootOverrides, callsOf, cancelledError, deferred, emit, resetRecorder, settle, startedStore, type Deferred } from "../test/launcher";
import { applyTaskDownload, findDuplicate, newTask, queuePosition, retryTask, trimHistory, tasksToStart } from "./tasks";

const ipc = vi.hoisted((): IpcRecorder => ({ calls: [], overrides: new Map() }));
vi.mock("../ipc/bridge", async (orig) => (await import("../test/fake-bridge")).fakeBridge(await orig(), ipc));

const T0 = 1_720_000_000_000;

function task(id: string, overrides: Partial<Task> = {}): Task {
  return {
    ...newTask({ id, kind: "java", title: `Java ${id}`, detail: "", instanceId: null, spec: { command: "install_java", args: { requiredMajor: Number(id.replace(/\D/g, "")) } } }, T0),
    ...overrides,
  };
}

function record(id: string, status: TaskRecordDto["status"], overrides: Partial<TaskRecordDto> = {}): TaskRecordDto {
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
    speed_bps: 1_000_000,
    attempt: 1,
    error: null,
    created_at: T0 - 60_000,
    finished_at: status === "queued" || status === "running" ? null : T0 - 1000,
    spec: { command: "install_java", args: { requiredMajor: 21 } },
    ...overrides,
  };
}

describe("下载队列：纯函数", () => {
  it("调度按数组顺序取最靠前的 queued，同时最多 3 个在跑", () => {
    const tasks = [task("t1"), task("t2", { status: "running" }), task("t3"), task("t4"), task("t5")];
    expect(tasksToStart(tasks).map((t) => t.id)).toEqual(["t1", "t3"]);
    expect(queuePosition(tasks, "t1")).toBe(1);
    expect(queuePosition(tasks, "t4")).toBe(3);
    expect(queuePosition(tasks, "t2")).toBeNull();
  });

  it("重试只对失败的任务，换下一次尝试并排到队尾", () => {
    const tasks = [task("t1", { status: "failed", attempt: 1, error: { code: "network_failed", message: "x" }, finishedAt: T0 }), task("t2")];
    const retried = retryTask(tasks, "t1");
    expect(retried.map((t) => t.id)).toEqual(["t2", "t1"]);
    expect(retried[1]).toMatchObject({ status: "queued", attempt: 2, error: null, progress: 0, finishedAt: null });
    expect(() => retryTask(tasks, "t2")).toThrow("只有失败的任务能重试");
  });

  it("去重：同一资源装到同一实例算同一件事，实例名不分大小写；已结束的不算", () => {
    const spec = (versionId: string) => ({ command: "install_mods", args: { versionId, platform: "modrinth", projectId: "AANobbMI", items: [] } });
    const tasks = [task("t1", { spec: spec("Fabric") }), task("t2", { status: "done", finishedAt: T0, spec: spec("Other") })];
    expect(findDuplicate(tasks, { command: "install_resource", args: { versionId: "fabric", platform: "modrinth", projectId: "AANobbMI" } })?.id).toBe("t1");
    expect(findDuplicate(tasks, spec("other"))).toBeUndefined();
  });

  it("历史只留最近 100 条已结束的任务，进行中的不受影响", () => {
    const finished = Array.from({ length: 101 }, (_, i) => task(`d${i}`, { status: "done", finishedAt: T0 + i }));
    const active = task("live", { status: "running" });
    const kept = trimHistory([active, ...finished]);
    expect(kept).toHaveLength(101);
    expect(kept.some((t) => t.id === "d0")).toBe(false);
    expect(kept.some((t) => t.id === "d100")).toBe(true);
    expect(kept[0].id).toBe("live");
    expect(() => trimHistory([...finished, task("bad", { status: "failed", finishedAt: null })])).toThrow("没有结束时刻");
  });

  it("下载进度按批次如实显示：批次内只进不退，新批次从头算起", () => {
    const running = [task("t1", { status: "running" })];
    const first = applyTaskDownload(running, "t1#1", { total: 10, finished: 8, bytes: 800, totalBytes: 1000, speed: 5 });
    expect(first[0]).toMatchObject({ bytes: 800, totalBytes: 1000, speedBps: 5 });
    expect(first[0].progress).toBeCloseTo(0.8, 10);
    const more = applyTaskDownload(first, "t1#1", { total: 10, finished: 9, bytes: 900, totalBytes: 1000, speed: 5 });
    expect(more[0].progress).toBeCloseTo(0.9, 10);
    const nextBatch = applyTaskDownload(more, "t1#1", { total: 40, finished: 4, bytes: 100, totalBytes: 1000, speed: 5 });
    expect(nextBatch[0].progress).toBeCloseTo(0.1, 10);
    // 别的尝试的进度不认
    expect(applyTaskDownload(first, "t1#2", { total: 1, finished: 1, bytes: 1, totalBytes: 1, speed: 1 })).toEqual(first);
  });
});

describe("下载队列：状态容器", () => {
  let runs: Map<string, Deferred<unknown>>;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    resetRecorder(ipc);
    bootOverrides(ipc);
    runs = new Map();
    ipc.overrides.set("install_java", (args) => {
      const d = deferred<unknown>();
      runs.set(String(args.taskId), d);
      return d.promise;
    });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const runtime = (raw: string) => ({ component: "java-runtime-delta", version: { major: 21, minor: 0, security: 5, build: 11, raw }, java_executable: "C:/java.exe" });

  it("四个任务：三个同时开始，第四个排队；一个完成后第四个立刻开始", async () => {
    const store = await startedStore();
    for (const major of [8, 17, 21, 25]) await store.actions.installJava(major);
    await settle();
    const tasks = store.getState().tasks;
    expect(tasks.map((t) => t.status)).toEqual(["running", "running", "running", "queued"]);
    expect(callsOf(ipc, "install_java").map((a) => a.requiredMajor)).toEqual([8, 17, 21]);
    expect(callsOf(ipc, "install_java").map((a) => a.taskId)).toEqual(tasks.slice(0, 3).map((t) => `${t.id}#1`));
    expect(queuePosition(tasks, tasks[3].id)).toBe(1);

    runs.get(`${tasks[1].id}#1`)?.resolve(runtime("17.0.12"));
    await settle();
    expect(store.getState().tasks.map((t) => t.status)).toEqual(["running", "done", "running", "running"]);
    expect(callsOf(ipc, "install_java").map((a) => a.requiredMajor)).toEqual([8, 17, 21, 25]);
    expect(store.getState().toasts.some((t) => t.title === "Java 17 已就绪")).toBe(true);
    store.stop();
  });

  it("取消排队中的任务只改状态，不发任何命令", async () => {
    const store = await startedStore();
    for (const major of [8, 17, 21, 25]) await store.actions.installJava(major);
    await settle();
    const queued = store.getState().tasks[3];
    const before = ipc.calls.length;
    await store.actions.cancelTask(queued.id);
    expect(ipc.calls.slice(before).map((c) => c.cmd)).toEqual([]);
    expect(store.getState().tasks[3].status).toBe("cancelled");
    expect(store.getState().toasts.at(-1)?.title).toContain("已取消");
    store.stop();
  });

  it("取消进行中的任务用这一次尝试的 taskId；命令以 cancelled 返回后落为已取消", async () => {
    const store = await startedStore();
    await store.actions.installJava(21);
    await settle();
    const t = store.getState().tasks[0];
    ipc.overrides.set("cancel_task", (args) => {
      runs.get(String(args.taskId))?.reject(cancelledError());
      return true;
    });
    await store.actions.cancelTask(t.id);
    await settle();
    expect(callsOf(ipc, "cancel_task")).toEqual([{ taskId: `${t.id}#1` }]);
    expect(store.getState().tasks[0].status).toBe("cancelled");
    store.stop();
  });

  it("失败后重试：排到队尾、换新的 taskId 重新执行", async () => {
    const store = await startedStore();
    await store.actions.installJava(21);
    await store.actions.installJava(17);
    await settle();
    const [first] = store.getState().tasks;
    runs.get(`${first.id}#1`)?.reject({ code: "network_failed", message: "连接超时" });
    await settle();
    expect(store.getState().tasks[0]).toMatchObject({ status: "failed", error: { code: "network_failed", message: "连接超时" } });
    expect(store.getState().toasts.at(-1)).toMatchObject({ tone: "error", action: { label: "重试" } });

    store.actions.retryTask(first.id);
    await settle();
    const after = store.getState().tasks;
    expect(after.map((t) => t.id)).toEqual([after[0].id, first.id]);
    expect(after[1]).toMatchObject({ status: "running", attempt: 2 });
    expect(callsOf(ipc, "install_java").map((a) => a.taskId)).toContain(`${first.id}#2`);
    store.stop();
  });

  it("同一件事重复入队只提示，不加任务", async () => {
    const store = await startedStore();
    await store.actions.installJava(21);
    await store.actions.installJava(21);
    expect(store.getState().tasks).toHaveLength(1);
    expect(store.getState().toasts.at(-1)?.title).toContain("Java 21");
    store.stop();
  });

  it("下载进度事件按这一次尝试的 taskId 对上任务", async () => {
    const store = await startedStore();
    await store.actions.installJava(21);
    await settle();
    const t = store.getState().tasks[0];
    emit(CORE_EVENT, { kind: "download", task_id: `${t.id}#1`, total: 4, finished: 1, bytes: 300, total_bytes: 1200, speed: 2048 });
    expect(store.getState().tasks[0]).toMatchObject({ bytes: 300, totalBytes: 1200, speedBps: 2048 });
    expect(store.getState().tasks[0].progress).toBeCloseTo(0.25, 10);
    store.stop();
  });

  it("重启后：上次没完成的任务记为失败「关闭时中断」，写回任务日志，已结束的原样保留", async () => {
    bootOverrides(ipc, { journal: [record("r1", "running"), record("q1", "queued"), record("d1", "done")] });
    const store = await startedStore();
    const tasks = store.getState().tasks;
    expect(tasks.map((t) => [t.id, t.status])).toEqual([
      ["r1", "failed"],
      ["q1", "failed"],
      ["d1", "done"],
    ]);
    expect(tasks[0]).toMatchObject({ error: { code: TASK_INTERRUPTED_CODE, message: `${APP_NAME}关闭时中断` }, speedBps: 0, finishedAt: T0 });
    expect(callsOf(ipc, "install_java")).toEqual([]);
    await vi.advanceTimersByTimeAsync(1000);
    const saved = callsOf(ipc, "save_task_journal");
    expect(saved).toHaveLength(1);
    expect((saved[0].tasks as TaskRecordDto[]).map((r) => r.status)).toEqual(["failed", "failed", "done"]);
    store.stop();
  });
});
