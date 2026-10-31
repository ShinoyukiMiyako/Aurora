// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TASK_INTERRUPTED_CODE } from "../copy/flows";
import type { Task } from "../domain/types";
import { CORE_EVENT, type TaskRecordDto } from "../ipc/tasks";
import { APP_NAME } from "../lib/app-info";
import type { IpcRecorder } from "../test/fake-bridge";
import { bootOverrides, callsOf, cancelledError, deferred, emit, resetRecorder, settle, startedStore, type Deferred } from "../test/launcher";
import {
  applyCompositeDownload,
  applyTaskDownload,
  compositeProgress,
  completeCompositeStep,
  findDuplicate,
  newTask,
  progressTrack,
  queuePosition,
  retryTask,
  startComposite,
  trimHistory,
  tasksToStart,
  type CompositeProgress,
} from "./tasks";

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
  it("进度条标识：同批次不变，换批次或换尝试即变", () => {
    const a = task("t", { status: "running", totalBytes: 1000 });
    expect(progressTrack(a)).toBe(progressTrack({ ...a, bytes: 500, progress: 0.5 }));
    expect(progressTrack(a)).not.toBe(progressTrack({ ...a, totalBytes: 4000 }));
    expect(progressTrack(a)).not.toBe(progressTrack({ ...a, attempt: 2 }));
    expect(progressTrack({ ...a, totalBytes: 0 })).toBe("t#1:0");
    expect(progressTrack({ ...a, totalBytes: null })).toBe("t#1:count");
  });

  it("调度按数组顺序取最靠前的 queued，同时最多 3 个在跑", () => {
    const tasks = [task("t1"), task("t2", { status: "running" }), task("t3"), task("t4"), task("t5")];
    expect(tasksToStart(tasks).map((t) => t.id)).toEqual(["t1", "t3"]);
    expect(queuePosition(tasks, "t1")).toBe(1);
    expect(queuePosition(tasks, "t4")).toBe(3);
    expect(queuePosition(tasks, "t2")).toBeNull();
  });

  describe("同一实例上写整个目录的任务（新建、导入、补全）不与这个实例上的其它任务同时跑", () => {
    const repair = (id: string, instanceId: string, overrides: Partial<Task> = {}) =>
      task(id, { kind: "repair", instanceId, spec: { command: "repair_instance", args: { id: instanceId } }, ...overrides });
    const mods = (id: string, instanceId: string, overrides: Partial<Task> = {}) =>
      task(id, { kind: "mod", instanceId, spec: { command: "install_mods", args: { versionId: instanceId, platform: "modrinth", projectId: id, items: [] } }, ...overrides });

    it("装 Mod 在跑时，同一实例的补全留在队里，别的实例与不挂实例的任务照常开始", () => {
      const tasks = [mods("m1", "生存", { status: "running" }), repair("r1", "生存"), repair("r2", "创造"), task("j21")];
      expect(tasksToStart(tasks).map((t) => t.id)).toEqual(["r2", "j21"]);
    });

    it("实例 id 不分大小写：补全「Survival」在跑时，「survival」上的装 Mod 等着", () => {
      const tasks = [repair("r1", "Survival", { status: "running" }), mods("m1", "survival")];
      expect(tasksToStart(tasks)).toEqual([]);
    });

    it("先到先下：排在前面、还在等的补全挡住同一实例后来的装 Mod，即使装 Mod 彼此可以同时跑", () => {
      const tasks = [mods("m1", "生存", { status: "running" }), repair("r1", "生存"), mods("m2", "生存")];
      expect(tasksToStart(tasks)).toEqual([]);
      const afterFirst = tasks.map((t) => (t.id === "m1" ? { ...t, status: "done" as const, finishedAt: T0 } : t));
      expect(tasksToStart(afterFirst).map((t) => t.id)).toEqual(["r1"]);
    });

    it("同一实例上的装 Mod 与装资源彼此兼容，可以同时开始", () => {
      const tasks = [mods("m1", "生存", { status: "running" }), mods("m2", "生存"), mods("m3", "生存")];
      expect(tasksToStart(tasks).map((t) => t.id)).toEqual(["m2", "m3"]);
    });

    it("同一次调度里也互斥：空位够时，排队的补全与它后面同一实例的装 Mod 只开始前一个", () => {
      const tasks = [repair("r1", "生存"), mods("m1", "生存"), task("j21")];
      expect(tasksToStart(tasks).map((t) => t.id)).toEqual(["r1", "j21"]);
    });
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

  it("累计字节跨批次往上加：批次内按增量计，新批次从它自己的已下字节算起", () => {
    const running = [task("t1", { status: "running" })];
    const a = applyTaskDownload(running, "t1#1", { total: 10, finished: 2, bytes: 200, totalBytes: 1000, speed: 5 });
    const b = applyTaskDownload(a, "t1#1", { total: 10, finished: 10, bytes: 1000, totalBytes: 1000, speed: 5 });
    expect(b[0].doneBytes).toBe(1000);
    // 第二批：资源文件 500 字节
    const c = applyTaskDownload(b, "t1#1", { total: 3, finished: 1, bytes: 120, totalBytes: 500, speed: 5 });
    expect(c[0]).toMatchObject({ bytes: 120, doneBytes: 1120 });
    const d = applyTaskDownload(c, "t1#1", { total: 3, finished: 3, bytes: 500, totalBytes: 500, speed: 5 });
    expect(d[0]).toMatchObject({ bytes: 500, doneBytes: 1500 });
    // 第三批大小与第二批相同，但已下字节变少：仍认作新批次
    const e = applyTaskDownload(d, "t1#1", { total: 3, finished: 0, bytes: 0, totalBytes: 500, speed: 0 });
    expect(e[0].doneBytes).toBe(1500);
  });

  it("组合任务的权重：声明大小都已知且总和大于 0 时按字节，否则按项数", () => {
    expect(compositeProgress([100, 300, 600])).toMatchObject({ weights: [100, 300, 600], totalBytes: 1000, index: 0, batches: [null, null, null], itemBytes: [0, 0, 0] });
    expect(compositeProgress([100, null, 600])).toMatchObject({ weights: [1, 1, 1], totalBytes: null });
    expect(compositeProgress([0, 0])).toMatchObject({ weights: [1, 1], totalBytes: null });
    // 大小为 0 的一项（文件已就绪）在按字节计时只是不占进度
    expect(compositeProgress([0, 512])).toMatchObject({ weights: [0, 512], totalBytes: 512 });
    expect(compositeProgress([])).toMatchObject({ weights: [], totalBytes: null, index: 0 });
  });

  it("组合任务的进度：各项从 0 报起也按整体累计，换项不归零，只进不退", () => {
    let cursor: CompositeProgress = compositeProgress([100, 300]);
    let tasks = startComposite([task("t1", { status: "running" })], "t1#1", cursor);
    expect(tasks[0]).toMatchObject({ progress: 0, bytes: 0, totalBytes: 400 });
    const step = (item: number, bytes: number, totalBytes: number | null) => {
      const next = applyCompositeDownload(tasks, "t1#1", cursor, item, { total: 1, finished: bytes === totalBytes ? 1 : 0, bytes, totalBytes, speed: 7 + item });
      if (next === null) return false;
      tasks = next.tasks;
      cursor = next.cursor;
      return true;
    };
    const finish = () => {
      const next = completeCompositeStep(tasks, "t1#1", cursor);
      tasks = next.tasks;
      cursor = next.cursor;
    };
    step(0, 50, 100);
    expect(tasks[0]).toMatchObject({ progress: 0.125, bytes: 50, totalBytes: 400, doneBytes: 50, speedBps: 7 });
    step(0, 100, 100);
    finish();
    expect(tasks[0]).toMatchObject({ progress: 0.25, bytes: 100, doneBytes: 100 });
    // 上一项最后一条进度在它的命令返回后才到：续的是它自己那一批，没有新字节，也不算进下一项
    step(0, 100, 100);
    expect(tasks[0]).toMatchObject({ progress: 0.25, bytes: 100, doneBytes: 100 });
    step(1, 0, 300);
    expect(tasks[0]).toMatchObject({ progress: 0.25, bytes: 100, doneBytes: 100, speedBps: 8 });
    step(1, 150, 300);
    expect(tasks[0]).toMatchObject({ progress: 0.625, bytes: 250, doneBytes: 250 });
    // 同一项里换了一批（总量变了、从 0 报起）：整体不退，这一批的字节接着累计
    step(1, 10, 20);
    expect(tasks[0]).toMatchObject({ progress: 0.65, bytes: 260, doneBytes: 260 });
    expect(cursor.itemBytes).toEqual([100, 160]);
    finish();
    expect(tasks[0]).toMatchObject({ progress: 1, bytes: 400 });
    // 全部做完后最后一项晚到的进度：只补字节，进度与速度不动
    expect(step(1, 20, 20)).toBe(true);
    expect(tasks[0]).toMatchObject({ progress: 1, bytes: 400, doneBytes: 270, speedBps: 8 });
    // 别的尝试的进度不认
    expect(applyCompositeDownload(tasks, "t1#2", cursor, 0, { total: 1, finished: 0, bytes: 1, totalBytes: 2, speed: 1 })).toBeNull();
  });

  it("组合任务按项数折算时：总量为空，已下字节累计实际下载的", () => {
    let cursor = compositeProgress([null, 2048, 4096]);
    let tasks = startComposite([task("t1", { status: "running" })], "t1#1", cursor);
    const apply = (step: number, bytes: number, totalBytes: number) => {
      const next = applyCompositeDownload(tasks, "t1#1", cursor, step, { total: 1, finished: 0, bytes, totalBytes, speed: 1 });
      if (next === null) throw new Error("这条进度应被采纳");
      tasks = next.tasks;
      cursor = next.cursor;
    };
    apply(0, 512, 1024);
    expect(tasks[0].progress).toBeCloseTo(1 / 6, 10);
    expect(tasks[0]).toMatchObject({ bytes: 512, totalBytes: null, doneBytes: 512 });
    ({ tasks, cursor } = completeCompositeStep(tasks, "t1#1", cursor));
    expect(tasks[0].progress).toBeCloseTo(1 / 3, 10);
    apply(1, 1024, 2048);
    expect(tasks[0].progress).toBeCloseTo(1 / 2, 10);
    expect(tasks[0]).toMatchObject({ bytes: 1536, totalBytes: null, doneBytes: 1536 });
  });

  /** 起一个两项的组合任务，返回按项喂进度、做完当前项的操作与当前任务。 */
  function twoItems(sizes: [number | null, number | null]) {
    let cursor = compositeProgress(sizes);
    let tasks = startComposite([task("t1", { status: "running" })], "t1#1", cursor);
    return {
      feed(step: number, bytes: number, totalBytes: number | null, finished: number, speed = 1) {
        const next = applyCompositeDownload(tasks, "t1#1", cursor, step, { total: 1, finished, bytes, totalBytes, speed });
        if (next === null) throw new Error("这一次尝试在运行，进度应被采纳");
        ({ tasks, cursor } = next);
      },
      finish() {
        ({ tasks, cursor } = completeCompositeStep(tasks, "t1#1", cursor));
      },
      get task() {
        return tasks[0];
      },
      get cursor() {
        return cursor;
      },
    };
  }

  it("两项声明大小相同：后一项第一条就与上一项最后一条逐字段相同，也照常算进后一项", () => {
    const run = twoItems([100, 100]);
    run.feed(0, 100, 100, 1);
    run.finish();
    expect(run.task).toMatchObject({ progress: 0.5, bytes: 100, doneBytes: 100 });
    run.feed(1, 100, 100, 1);
    expect(run.task).toMatchObject({ progress: 1, bytes: 200, totalBytes: 200, doneBytes: 200 });
    // 上一项同样的那条快照这时才到：续它自己的批次，不重复算
    run.feed(0, 100, 100, 1);
    expect(run.task).toMatchObject({ progress: 1, bytes: 200, doneBytes: 200 });
    expect(run.cursor.itemBytes).toEqual([100, 100]);
  });

  it("两项大小都未知：后一项的已下字节比上一项多也照常采纳，按项数推进", () => {
    const run = twoItems([null, null]);
    run.feed(0, 500, null, 1);
    run.finish();
    expect(run.task).toMatchObject({ progress: 0.5, bytes: 500, totalBytes: null, doneBytes: 500 });
    run.feed(1, 600, null, 0);
    expect(run.task).toMatchObject({ progress: 0.5, bytes: 1100, doneBytes: 1100 });
    run.feed(1, 900, null, 1);
    expect(run.task).toMatchObject({ progress: 1, bytes: 1400, doneBytes: 1400 });
    // 边界：后一项从 0 报起、没有新字节
    const fresh = twoItems([null, null]);
    fresh.feed(0, 0, null, 0);
    expect(fresh.task).toMatchObject({ progress: 0, bytes: 0, doneBytes: 0 });
  });

  it("上一项的进度在后一项报过进度之后才到：只补上一项的字节，整体进度与速度都不动", () => {
    const run = twoItems([100, 300]);
    run.feed(0, 60, 100, 0, 5);
    run.finish();
    run.feed(1, 30, 300, 0, 9);
    expect(run.task).toMatchObject({ progress: 0.325, bytes: 130, doneBytes: 90, speedBps: 9 });
    run.feed(0, 100, 100, 1, 5);
    expect(run.task).toMatchObject({ progress: 0.325, bytes: 130, doneBytes: 130, speedBps: 9 });
    run.feed(1, 300, 300, 1, 9);
    expect(run.task).toMatchObject({ progress: 1, bytes: 400, doneBytes: 400 });
    expect(run.cursor.itemBytes).toEqual([100, 300]);
  });

  it("项序号越过当前项或越界：调用方给错了序号，直接报错", () => {
    const run = twoItems([100, 100]);
    expect(() => run.feed(1, 10, 100, 0)).toThrow("还在第 0 项，收到了第 1 项的进度");
    expect(() => run.feed(2, 10, 100, 0)).toThrow("只有 2 项，收到了第 2 项的进度");
    expect(() => run.feed(-1, 10, 100, 0)).toThrow("只有 2 项，收到了第 -1 项的进度");
    expect(() => run.feed(0.5, 10, 100, 0)).toThrow("只有 2 项");
    expect(run.task).toMatchObject({ progress: 0, doneBytes: 0 });
  });

  it("重试清掉上一次尝试的开始时刻与累计字节", () => {
    const failed = task("t1", { status: "failed", startedAt: T0 + 5, doneBytes: 4096, finishedAt: T0 + 9, error: { code: "network_failed", message: "x" } });
    expect(retryTask([failed], "t1")[0]).toMatchObject({ status: "queued", startedAt: null, doneBytes: 0 });
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

  it("全部重试：同一实例上的补全与装 Mod 一起重新排队时，只先开始补全，装 Mod 等补全结束再开始", async () => {
    const failed = (id: string, command: string, args: Record<string, unknown>, kind: Task["kind"]): TaskRecordDto =>
      record(id, "failed", { kind, instance_id: "生存", error: { code: "network_failed", message: "连不上" }, spec: { command, args } });
    ipc.overrides.set("load_task_journal", () => [
      failed("r1", "repair_instance", { id: "生存" }, "repair"),
      failed("m1", "install_mods", { versionId: "生存", platform: "modrinth", projectId: "sodium", items: [{ platform: "modrinth", projectId: "sodium", modVersionId: "v1", title: "Sodium", fileSize: 10 }] }, "mod"),
    ]);
    const store = await startedStore();
    try {
      const repairDone = deferred<unknown>();
      ipc.overrides.set("repair_instance", () => repairDone.promise);
      ipc.overrides.set("install_mod", () => null);
      expect(store.actions.retryFailedTasks()).toBe(2);
      await settle();
      expect(callsOf(ipc, "repair_instance")).toHaveLength(1);
      expect(callsOf(ipc, "install_mod")).toHaveLength(0);
      repairDone.resolve(null);
      await settle();
      expect(callsOf(ipc, "install_mod")).toHaveLength(1);
    } finally {
      store.stop();
    }
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

  it("下载 Java 时指定了实例：装好后把它的 Java 固定为新装的运行时，通知写明", async () => {
    const settings = { description: null, cover: null, isolation: "follow_global", memory_mb: null, java: "auto", jvm_args: "", resolution: { width: 854, height: 480 }, fullscreen: false };
    ipc.overrides.set("get_instance_settings", () => settings);
    ipc.overrides.set("set_instance_settings", (args) => args.settings);
    const store = await startedStore();
    await store.actions.installJava(21, { pinFor: "生存" });
    await settle();
    const [t] = store.getState().tasks;
    runs.get(`${t.id}#1`)?.resolve(runtime("21.0.5"));
    await settle();
    const saved = callsOf(ipc, "set_instance_settings");
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({ id: "生存", settings: { java: "C:/java.exe", memory_mb: null } });
    expect(store.getState().toasts.filter((x) => x.tone === "success").map((x) => [x.title, x.body])).toEqual([["Java 21 已就绪", "「生存」下次启动会用它"]]);
    store.stop();
  });

  it("没指定实例的 Java 下载不改任何实例设置", async () => {
    const store = await startedStore();
    await store.actions.installJava(21);
    await settle();
    runs.get(`${store.getState().tasks[0].id}#1`)?.resolve(runtime("21.0.5"));
    await settle();
    expect(callsOf(ipc, "set_instance_settings")).toEqual([]);
    expect(store.getState().toasts.at(-1)).toMatchObject({ title: "Java 21 已就绪", body: "需要它的实例会自动使用" });
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

  it("开始时刻记在开始运行的那一刻而不是入队时；用时与总量取这一次尝试的开始时刻与累计字节", async () => {
    const store = await startedStore();
    for (const major of [8, 17, 21, 25]) await store.actions.installJava(major);
    await settle();
    const tasks = store.getState().tasks;
    expect(tasks.map((t) => t.startedAt)).toEqual([T0, T0, T0, null]);

    vi.setSystemTime(T0 + 4000);
    emit(CORE_EVENT, { kind: "download", task_id: `${tasks[0].id}#1`, total: 2, finished: 2, bytes: 700, total_bytes: 700, speed: 1 });
    runs.get(`${tasks[0].id}#1`)?.resolve(runtime("8.0.412"));
    await settle();
    const after = store.getState().tasks;
    expect(after[0]).toMatchObject({ status: "done", startedAt: T0, finishedAt: T0 + 4000, doneBytes: 700 });
    // 第四个在通道空出的这一刻才开始
    expect(after[3]).toMatchObject({ status: "running", startedAt: T0 + 4000, doneBytes: 0 });
    store.stop();
  });

  it("任务日志存下开始时刻与累计字节；较早的日志没有这两项时，开始时刻为空、累计字节取最后一批", async () => {
    bootOverrides(ipc, {
      journal: [record("new", "done", { started_at: T0 - 9000, done_bytes: 52_000 }), record("old", "done")],
    });
    const store = await startedStore();
    expect(store.getState().tasks.map((t) => [t.id, t.startedAt, t.doneBytes])).toEqual([
      ["new", T0 - 9000, 52_000],
      ["old", null, 4096],
    ]);
    await store.actions.flushTaskJournal();
    const saved = callsOf(ipc, "save_task_journal").at(-1)?.tasks as TaskRecordDto[];
    expect(saved.map((r) => [r.id, r.started_at, r.done_bytes])).toEqual([
      ["new", T0 - 9000, 52_000],
      ["old", null, 4096],
    ]);
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
