// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TASK_HISTORY_LIMIT } from "../domain/limits";
import { IpcError } from "../ipc/errors";
import type { InstanceDto } from "../ipc/instances";
import type { IpcRecorder } from "../test/fake-bridge";
import { bootOverrides, deferred, instanceDto, resetRecorder, settle, startedStore } from "../test/launcher";
import type { LauncherStore } from "./store";
import { attemptTaskId } from "./tasks";

const ipc = vi.hoisted((): IpcRecorder => ({ calls: [], overrides: new Map() }));
vi.mock("../ipc/bridge", async (orig) => (await import("../test/fake-bridge")).fakeBridge(await orig(), ipc));

const T0 = 1_720_000_000_000;

/** 状态容器内部按任务 id 记着的东西。对外状态只给出未看失败的个数，要核对它们有没有越积越多只能直接读。 */
interface TaskRefs {
  taskMeta: Readonly<Record<string, unknown>>;
  unseenFailures: readonly string[];
  landing: readonly string[];
}

function refsOf(store: LauncherStore): TaskRefs {
  return (store as unknown as { raw: TaskRefs }).raw;
}

/** 入队上下文只为任务表里的任务与还在等落地重扫的任务记着；未看过的失败只记任务表里任务的当前这一次尝试。 */
function expectAligned(store: LauncherStore): void {
  const tasks = store.getState().tasks;
  const refs = refsOf(store);
  const live = new Set([...tasks.map((t) => t.id), ...refs.landing]);
  expect(Object.keys(refs.taskMeta).filter((id) => !live.has(id))).toEqual([]);
  const attempts = new Set(tasks.map(attemptTaskId));
  expect(refs.unseenFailures.filter((a) => !attempts.has(a))).toEqual([]);
}

let store: LauncherStore;

beforeEach(async () => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
  resetRecorder(ipc);
  bootOverrides(ipc);
  store = await startedStore();
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(() => {
  store.stop();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const majorOf = (args: Record<string, unknown>): number => {
  const value = args.requiredMajor;
  if (typeof value !== "number") throw new Error("install_java 应带 requiredMajor");
  return value;
};

describe("入队上下文与未看过的失败随任务一起清掉", () => {
  it("历史超出上限剪掉的最早几条：它们的入队上下文与未看记录一并清掉，留下的照常算未看", async () => {
    ipc.overrides.set("install_java", (args) => {
      throw new IpcError("download_failed", `Java ${majorOf(args)} 下载源暂时不可用`);
    });
    const total = TASK_HISTORY_LIMIT + 3;
    for (let major = 1; major <= total; major++) {
      // 每个任务晚一秒结束：历史按结束时刻剪，剪掉的是最早的 1、2、3
      vi.setSystemTime(T0 + major * 1000);
      await store.actions.installJava(major);
      await settle();
    }

    const tasks = store.getState().tasks;
    expect(tasks).toHaveLength(TASK_HISTORY_LIMIT);
    expect(Math.min(...tasks.map((t) => majorOf(t.spec.args)))).toBe(4);
    expect(Object.keys(refsOf(store).taskMeta)).toHaveLength(TASK_HISTORY_LIMIT);
    expect(refsOf(store).unseenFailures).toHaveLength(TASK_HISTORY_LIMIT);
    expect(store.getState().unseenFailures).toBe(TASK_HISTORY_LIMIT);
    expectAligned(store);
  });

  it("清除已结束：被清掉的任务的入队上下文一并清掉，进行中的那个留着并照常落地", async () => {
    const running = deferred<unknown>();
    ipc.overrides.set("install_java", (args) => {
      if (majorOf(args) === 21) return running.promise;
      throw new IpcError("download_failed", "下载源暂时不可用");
    });
    await store.actions.installJava(8);
    await store.actions.installJava(17);
    await store.actions.installJava(21, { launchAfter: "生存" });
    await settle();
    expect(store.getState().tasks.map((t) => t.status)).toEqual(["failed", "failed", "running"]);
    expect(Object.keys(refsOf(store).taskMeta)).toHaveLength(3);

    store.actions.clearFinishedTasks();
    const [left] = store.getState().tasks;
    expect(store.getState().tasks).toHaveLength(1);
    expect(Object.keys(refsOf(store).taskMeta)).toEqual([left.id]);
    expect(refsOf(store).unseenFailures).toEqual([]);
    expectAligned(store);

    running.resolve({ component: "java-runtime-delta", version: { major: 21, minor: 0, security: 5, build: 11, raw: "21.0.5" }, java_executable: "C:/jdk21/bin/java.exe" });
    await settle();
    // 入队上下文还在才知道装好后要带「启动」这个实例
    const done = store.getState().toasts.find((t) => t.tone === "success");
    expect(done?.action?.label).toBe("启动");
  });

  it("重试后再失败：上一次尝试的未看记录不再留着，只算这一次", async () => {
    ipc.overrides.set("install_java", () => {
      throw new IpcError("download_failed", "下载源暂时不可用");
    });
    await store.actions.installJava(17);
    await settle();
    const [task] = store.getState().tasks;
    store.actions.retryTask(task.id);
    await settle();
    const [again] = store.getState().tasks;
    expect(again.attempt).toBe(task.attempt + 1);
    expect(refsOf(store).unseenFailures).toEqual([attemptTaskId(again)]);
    expect(store.getState().unseenFailures).toBe(1);
  });

  it("新建结束后还在等落地重扫时清除已结束：这个任务留着（落地期间实例按它派生安装中），别的已结束照常清掉；落定之后再清就一并清掉", async () => {
    let onDisk: InstanceDto[] = [instanceDto("生存"), instanceDto("创造")];
    ipc.overrides.set("list_instances", () => onDisk);
    ipc.overrides.set("install_version", () => {
      onDisk = [...onDisk, instanceDto("新世界")];
      return { id: "新世界" };
    });
    ipc.overrides.set("install_java", () => {
      throw new IpcError("download_failed", "下载源暂时不可用");
    });
    ipc.overrides.set("set_sidebar_pins", (args) => args.pins);
    const settings = { description: null, cover: null, cover_image: null, background: "follow", background_image: null, isolation: "follow_global", memory_mb: null, java: "auto", jvm_args: "", resolution: { width: 854, height: 480 }, fullscreen: false };
    ipc.overrides.set("get_instance_settings", () => settings);
    ipc.overrides.set("set_instance_settings", (args) => args.settings);
    await store.actions.installJava(17);
    await settle();
    const [java] = store.getState().tasks;
    expect(java.status).toBe("failed");
    const landingScan = deferred<InstanceDto[]>();
    await store.actions.createInstance({ name: "新世界", mcVersion: "1.21.1", loader: "vanilla", loaderVersion: null, cover: "grass" });
    ipc.overrides.set("list_instances", () => landingScan.promise);
    await settle();
    const task = store.getState().tasks.find((t) => t.id !== java.id);
    if (task === undefined) throw new Error("应有新建任务");
    expect(task.status).toBe("done");
    expect(refsOf(store).landing).toEqual([task.id]);

    store.actions.clearFinishedTasks();
    expect(store.getState().tasks.map((t) => t.id)).toEqual([task.id]);
    expect(Object.keys(refsOf(store).taskMeta)).toEqual([task.id]);
    expect(store.getState().instances.find((i) => i.id === "新世界")).toMatchObject({ status: "installing" });
    expectAligned(store);

    landingScan.resolve(onDisk);
    await settle();
    expect(refsOf(store).landing).toEqual([]);
    expect(store.getState().instances.map((i) => i.id)).toEqual(["生存", "创造", "新世界"]);
    expect(store.getState().instances.find((i) => i.id === "新世界")).toMatchObject({ status: "ready" });

    store.actions.clearFinishedTasks();
    expect(store.getState().tasks).toEqual([]);
    expect(refsOf(store).taskMeta).toEqual({});
  });
});
