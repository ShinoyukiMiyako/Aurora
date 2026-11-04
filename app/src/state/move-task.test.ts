// @vitest-environment jsdom
// 移到另一个游戏目录的任务：入队参数、步骤文案、实例与基底的占用、完成后的落地与通知、失败原因与重启后的收尾。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { taskPhaseText } from "../copy/flows";
import { locksOf } from "../domain/instance-locks";
import { formatBytes } from "../domain/format";
import { TASK_JOURNAL_DEBOUNCE_MS } from "../domain/limits";
import type { InstallPhase } from "../domain/types";
import { APP_NAME } from "../lib/app-info";
import { IpcError } from "../ipc/errors";
import type { InstanceDto, MoveOutcomeDto } from "../ipc/instances";
import { CORE_EVENT, type TaskRecordDto } from "../ipc/tasks";
import type { IpcRecorder } from "../test/fake-bridge";
import { bootOverrides, callsOf, deferred, emit, instanceDto, resetRecorder, settle, startedStore } from "../test/launcher";
import type { LauncherStore } from "./store";
import type { Toast } from "./toasts";

const ipc = vi.hoisted((): IpcRecorder => ({ calls: [], overrides: new Map() }));
vi.mock("../ipc/bridge", async (orig) => (await import("../test/fake-bridge")).fakeBridge(await orig(), ipc));

const T0 = 1_720_000_000_000;
const GIB = 1024 ** 3;
const SOURCE = "D:\\Games\\.minecraft";
const TARGET = "E:\\HMCL\\.minecraft";
const CROSS: readonly InstallPhase[] = ["move_dependencies", "move_copy", "move_verify", "move_commit"];

function outcome(over: Partial<MoveOutcomeDto> = {}): MoveOutcomeDto {
  return { id: "生存", source: SOURCE, target: TARGET, target_name: "HMCL", registered: false, follow_ups: [], ...over };
}

let store: LauncherStore;
let instances: InstanceDto[];

async function boot(journal: TaskRecordDto[] = []): Promise<void> {
  resetRecorder(ipc);
  instances = [instanceDto("生存", { loaders: [{ kind: "fabric", version: "0.16.10" }] }), instanceDto("创造")];
  bootOverrides(ipc, { instances, pins: ["生存"], journal });
  ipc.overrides.set("list_instances", () => instances);
  store = await startedStore();
}

beforeEach(async () => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
  await boot();
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

function toastOf(title: string): Toast {
  const toast = store.getState().toasts.find((t) => t.title === title);
  if (toast === undefined) throw new Error(`没有标题为「${title}」的通知`);
  return toast;
}

async function runAction(toast: Toast): Promise<void> {
  const action = toast.action;
  if (action === undefined || !("run" in action)) throw new Error(`通知「${toast.title}」没有命令类动作`);
  await action.run();
}

function moveRecord(id: string, status: TaskRecordDto["status"], error: TaskRecordDto["error"]): TaskRecordDto {
  return {
    id,
    kind: "instance_move",
    title: "移动「生存」",
    detail: `移到 HMCL · ${TARGET}`,
    instance_id: "生存",
    status,
    progress: 0.4,
    bytes: 0,
    total_bytes: null,
    speed_bps: 0,
    attempt: 1,
    error,
    created_at: T0 - 60_000,
    finished_at: status === "running" ? null : T0 - 1000,
    spec: { command: "move_instance", args: { id: "生存", target: TARGET } },
  };
}

describe("入队与进行中", () => {
  it("命令参数为 taskId、id 与 target；任务挂在实例上，详情写目标名与路径；期间实例记为移动中、一切都锁住", async () => {
    const pending = deferred<MoveOutcomeDto>();
    ipc.overrides.set("move_instance", () => pending.promise);
    const id = await store.actions.moveInstance("生存", TARGET, "HMCL");
    await settle();
    expect(callsOf(ipc, "move_instance")).toEqual([{ taskId: `${id}#1`, id: "生存", target: TARGET }]);
    expect(store.getState().tasks.find((t) => t.id === id)).toMatchObject({ kind: "instance_move", title: "移动「生存」", detail: `移到 HMCL · ${TARGET}`, instanceId: "生存", status: "running" });
    const inst = store.getState().instances.find((i) => i.id === "生存");
    if (inst === undefined) throw new Error("实例不见了");
    expect([inst.status, inst.activity]).toEqual(["ready", "moving"]);
    expect(locksOf(inst, false)).toEqual({ mods: "moving", rename: "moving", repair: "moving", delete: "moving", launch: "moving", move: "moving" });
    expect(store.getState().toasts.map((t) => [t.tone, t.title, t.body])).toEqual([["info", "已开始移动「生存」", "进度见下载任务"]]);
    pending.resolve(outcome());
    await settle();
  });

  it("步骤事件：第一步到达时重扫一次（基底此刻已被占住），进度按四步折算、只进不退，步骤文案写这一步", async () => {
    const pending = deferred<MoveOutcomeDto>();
    ipc.overrides.set("move_instance", () => pending.promise);
    const id = await store.actions.moveInstance("生存", TARGET, "HMCL");
    await settle();
    const scans = callsOf(ipc, "list_instances").length;
    emit(CORE_EVENT, { task_id: `${id}#1`, kind: "phase", plan: [...CROSS], index: 0 });
    await settle();
    expect(callsOf(ipc, "list_instances")).toHaveLength(scans + 1);
    emit(CORE_EVENT, { task_id: `${id}#1`, kind: "phase", plan: [...CROSS], index: 1 });
    emit(CORE_EVENT, { task_id: `${id}#1`, kind: "download", total: 100, finished: 50, bytes: 500, total_bytes: 1000, transferred: 500, speed: 100 });
    await settle();
    // 第二步之后不再重扫
    expect(callsOf(ipc, "list_instances")).toHaveLength(scans + 1);
    const task = store.getState().tasks.find((t) => t.id === id);
    if (task === undefined || task.phase === null) throw new Error("任务没有步骤");
    expect(taskPhaseText(task.phase, "short")).toBe("复制实例与存档备份 · 第 2/4 步");
    // 权重 2 / 6 / 3 / 1：第二步走了一半
    expect(task.progress).toBeCloseTo((2 + 6 * 0.5) / 12);
    pending.resolve(outcome());
    await settle();
  });

  it("步骤文案：四个新键都有说法，跨盘与同盘两种步骤表都能解析", () => {
    expect(CROSS.map((_, index) => taskPhaseText({ plan: CROSS, index }, "long"))).toEqual([
      "第 1 步，共 4 步：补齐共用的游戏文件",
      "第 2 步，共 4 步：复制实例与存档备份",
      "第 3 步，共 4 步：校验复制出的文件",
      "第 4 步，共 4 步：移入目标游戏目录",
    ]);
    const same: readonly InstallPhase[] = ["move_dependencies", "move_commit"];
    expect(same.map((_, index) => taskPhaseText({ plan: same, index }, "short"))).toEqual(["补齐共用的游戏文件 · 第 1/2 步", "移入目标游戏目录 · 第 2/2 步"]);
  });

  it("移动与同一实例上的别的任务互斥：补全排在移动后面等着，别的实例不受影响", async () => {
    const pending = deferred<MoveOutcomeDto>();
    ipc.overrides.set("move_instance", () => pending.promise);
    ipc.overrides.set("repair_instance", () => new Promise(() => undefined));
    await store.actions.moveInstance("生存", TARGET, "HMCL");
    await settle();
    await store.actions.repairInstance("生存");
    await store.actions.repairInstance("创造");
    await settle();
    expect(store.getState().tasks.map((t) => [t.spec.command, t.instanceId, t.status])).toEqual([
      ["move_instance", "生存", "running"],
      ["repair_instance", "生存", "queued"],
      ["repair_instance", "创造", "running"],
    ]);
    pending.resolve(outcome());
    await settle();
  });

  it("同一件事已在队列里时不重复入队，交回那个任务的 id", async () => {
    ipc.overrides.set("move_instance", () => new Promise(() => undefined));
    const first = await store.actions.moveInstance("生存", TARGET, "HMCL");
    expect(await store.actions.moveInstance("生存", TARGET, "HMCL")).toBe(first);
    expect(store.getState().tasks.filter((t) => t.kind === "instance_move")).toHaveLength(1);
    expect(lastToast().title).toBe("移动「生存」 已在下载队列里");
  });
});

describe("完成", () => {
  it("实例离开列表、侧栏固定随后端去掉；lastMove 与新列表同一次到达；通知「已移到「HMCL」」带「切换过去」", async () => {
    ipc.overrides.set("move_instance", () => {
      instances = instances.filter((i) => i.id !== "生存");
      return outcome();
    });
    ipc.overrides.set("get_sidebar_pins", () => []);
    const frames: string[][] = [];
    store.subscribe(() => {
      if (store.getState().lastMove !== null) frames.push(store.getState().instances.map((i) => i.id));
    });
    const id = await store.actions.moveInstance("生存", TARGET, "HMCL");
    await settle();
    expect(store.getState().tasks.find((t) => t.id === id)?.status).toBe("done");
    expect(store.getState().instances.map((i) => i.id)).toEqual(["创造"]);
    expect(store.getState().sidebarPins).toEqual([]);
    expect(store.getState().lastMove).toEqual({ id: "生存", seq: 1 });
    // 外壳按 lastMove 把开着的实例页送去实例库：lastMove 第一次出现时，列表里已经没有它
    expect(frames[0]).toEqual(["创造"]);
    const toast = toastOf("已移到「HMCL」");
    expect([toast.tone, toast.body, toast.action?.label]).toEqual(["success", "「生存」已不在当前游戏目录里，切换过去就能玩", "切换过去"]);
    // 全都跟过去了：没有补充提醒
    expect(store.getState().toasts.filter((t) => t.tone === "warning")).toEqual([]);

    ipc.overrides.set("set_game_directory", () => null);
    await runAction(toast);
    expect(callsOf(ipc, "set_game_directory")).toEqual([{ path: TARGET }]);
  });

  it("「切换过去」在还有任务进行时不切，原因经通知动作的错误处理报出", async () => {
    ipc.overrides.set("move_instance", (args) => (args.id === "生存" ? outcome() : new Promise(() => undefined)));
    await store.actions.moveInstance("生存", TARGET, "HMCL");
    await settle();
    await store.actions.moveInstance("创造", TARGET, "HMCL");
    await settle();
    await expect(runAction(toastOf("已移到「HMCL」"))).rejects.toThrow("有游戏或下载在进行，结束后再切换");
    expect(callsOf(ipc, "set_game_directory")).toEqual([]);
  });

  it("有几项没跟过去：完成通知之后补一条 warning，逐项写原因", async () => {
    ipc.overrides.set("move_instance", () =>
      outcome({
        follow_ups: [
          { kind: "play_records", reason: "记录文件被占用" },
          { kind: "cleanup", path: "D:\\Games\\.minecraft\\.petalfall\\moving\\a1", reason: "拒绝访问。 (os error 5)" },
        ],
      }),
    );
    await store.actions.moveInstance("生存", TARGET, "HMCL");
    await settle();
    const warning = lastToast();
    expect([warning.tone, warning.title, warning.body]).toEqual([
      "warning",
      "「生存」已移过去，有 2 项要留意",
      "游玩记录没跟过去：记录文件被占用；原处还留着 D:\\Games\\.minecraft\\.petalfall\\moving\\a1，没能删掉：拒绝访问。 (os error 5)",
    ]);
  });
});

describe("失败", () => {
  it("被拦下：拦截项随失败记录存下（也写进任务日志），原因按种类写；通知单独一条、带重试，不并进下载失败", async () => {
    ipc.overrides.set("move_instance", () => {
      throw new IpcError("instance_move_blocked", "实例 生存 不能移到 E:\\HMCL\\.minecraft：目标盘空间不够", {
        id: "生存",
        blocker: { kind: "insufficient_space", needed: 3 * GIB, available: GIB },
      });
    });
    const id = await store.actions.moveInstance("生存", TARGET, "HMCL");
    await settle();
    const reason = `目标盘空间不够：需要 ${formatBytes(3 * GIB)}，只剩 ${formatBytes(GIB)}`;
    expect(store.getState().tasks.find((t) => t.id === id)).toMatchObject({ status: "failed", error: { code: "instance_move_blocked", move_blocker: { kind: "insufficient_space", needed: 3 * GIB, available: GIB } } });
    expect([lastToast().tone, lastToast().title, lastToast().body, lastToast().action?.label]).toEqual(["error", "移动「生存」没有完成", reason, "重试"]);
    await vi.advanceTimersByTimeAsync(TASK_JOURNAL_DEBOUNCE_MS);
    const saved = callsOf(ipc, "save_task_journal").at(-1);
    expect((saved?.tasks as TaskRecordDto[]).find((t) => t.id === id)?.error).toMatchObject({ move_blocker: { kind: "insufficient_space", needed: 3 * GIB, available: GIB } });
  });

  it("复制出的文件对不上：说原件没动", async () => {
    ipc.overrides.set("move_instance", () => {
      throw new IpcError("instance_move_verify_failed", "副本与原件不一致：E:\\HMCL\\.minecraft\\.petalfall\\moving\\t\\instance\\x.jar", { path: "x.jar" });
    });
    await store.actions.moveInstance("生存", TARGET, "HMCL");
    await settle();
    expect(lastToast().body).toBe("复制出的文件和原件对不上，这次移动已放弃，原件没动");
  });
});

describe("重启之后", () => {
  it("上次关闭时没完成的移动记为另一种中断：不能重试，「全部重试」与断网恢复的计数都跳过它；别的中断照常可重试", async () => {
    store.stop();
    const java: TaskRecordDto = {
      ...moveRecord("task-java", "running", null),
      kind: "java",
      title: "下载 Java 21",
      detail: "",
      instance_id: null,
      spec: { command: "install_java", args: { requiredMajor: 21 } },
    };
    await boot([moveRecord("task-move", "running", null), java]);
    const move = store.getState().tasks.find((t) => t.id === "task-move");
    expect(move).toMatchObject({ status: "failed", error: { code: "move_interrupted", message: `${APP_NAME}关闭时中断，重新打开时已自动收尾：实例要么已在目标游戏目录，要么留在原处` } });
    expect(store.getState().tasks.find((t) => t.id === "task-java")?.error?.code).toBe("interrupted");
    expect(() => store.actions.retryTask("task-move")).toThrow("已在打开时收尾，不能重试");
    ipc.overrides.set("install_java", () => new Promise(() => undefined));
    expect(store.actions.retryFailedTasks()).toBe(1);
    await settle();
    expect(callsOf(ipc, "move_instance")).toEqual([]);
    expect(store.getState().tasks.find((t) => t.id === "task-move")?.status).toBe("failed");
  });

  it("上次关闭时还在排队的移动没开过工：照普通中断记，可以重试，重试按原参数再移", async () => {
    store.stop();
    await boot([{ ...moveRecord("task-queued", "queued", null), finished_at: null }]);
    expect(store.getState().tasks[0]).toMatchObject({ status: "failed", error: { code: "interrupted" } });
    ipc.overrides.set("move_instance", () => new Promise(() => undefined));
    store.actions.retryTask("task-queued");
    await settle();
    expect(callsOf(ipc, "move_instance")).toEqual([{ taskId: "task-queued#2", id: "生存", target: TARGET }]);
  });

  it("日志里被拦下的移动：拦截项逐项校验后读回；形状不对按日志损坏报错", async () => {
    store.stop();
    await boot([moveRecord("task-blocked", "failed", { code: "instance_move_blocked", message: "原文", move_blocker: { kind: "has_dependents", dependents: ["甲", "乙", "丙"] } })]);
    expect(store.getState().tasks[0].error).toEqual({ code: "instance_move_blocked", message: "原文", move_blocker: { kind: "has_dependents", dependents: ["甲", "乙", "丙"] } });

    store.stop();
    const broken = moveRecord("task-broken", "failed", { code: "instance_move_blocked", message: "原文", move_blocker: { kind: "has_dependents", dependents: "甲" } as never });
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await boot([broken]);
    expect(store.getState().status.tasks.kind).toBe("error");
    errors.mockRestore();
  });

  it("失败的移动跟着实例改名：命令参数与标题都换成新名字，重试按新名字移", async () => {
    store.stop();
    await boot([moveRecord("task-old", "failed", { code: "io", message: "磁盘满了" })]);
    ipc.overrides.set("rename_instance", () => {
      instances = instances.map((i) => (i.id === "生存" ? { ...i, id: "生存二" } : i));
      return { id: "生存二" };
    });
    await store.actions.renameInstance("生存", "生存二");
    await settle();
    expect(store.getState().tasks[0]).toMatchObject({ title: "移动「生存二」", instanceId: "生存二", spec: { command: "move_instance", args: { id: "生存二", target: TARGET } } });
    ipc.overrides.set("move_instance", () => new Promise(() => undefined));
    store.actions.retryTask("task-old");
    await settle();
    expect(callsOf(ipc, "move_instance")).toEqual([{ taskId: "task-old#2", id: "生存二", target: TARGET }]);
  });
});
