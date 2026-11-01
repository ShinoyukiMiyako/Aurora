// @vitest-environment jsdom
// 新实例起步：沿用默认设置与开局 Mod。新建、套模板、装 Mod 都落到假后端，断言的是命令收到的参数与任务表的结局。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IpcError } from "../ipc/errors";
import { saveInstanceAsTemplate } from "../ipc/instances";
import { mockInvoke, resetMocks } from "../ipc/mock";
import { listMods, starterMods } from "../ipc/mods";
import type { TaskRecordDto } from "../ipc/tasks";
import type { IpcRecorder } from "../test/fake-bridge";
import { bootOverrides, callsOf, resetRecorder, settle, startedStore } from "../test/launcher";
import type { LauncherStore, StarterPick } from "./store";

const ipc = vi.hoisted((): IpcRecorder => ({ calls: [], overrides: new Map() }));
vi.mock("../ipc/bridge", async (orig) => (await import("../test/fake-bridge")).fakeBridge(await orig(), ipc));

const T0 = 1_790_000_000_000;
const NAME = "周末生存";

let store: LauncherStore;
/** 弹过的全部通知（按弹出顺序）：任务跑完时早弹的几条已经到时消失，只看当下的列表会漏掉。 */
let shown: string[];
let unsubscribe: () => void;

function watchToasts(target: LauncherStore): () => void {
  const seen = new Set<string>();
  return target.subscribe(() => {
    for (const t of target.getState().toasts) {
      if (seen.has(t.id)) continue;
      seen.add(t.id);
      shown.push(`${t.tone}:${t.title}${t.body === undefined ? "" : `:${t.body}`}`);
    }
  });
}

beforeEach(async () => {
  shown = [];
  vi.useFakeTimers();
  vi.setSystemTime(T0);
  resetRecorder(ipc);
  resetMocks();
  bootOverrides(ipc);
  // 实例列表与侧栏固定也走假后端：新建出来的实例要出现在列表里，装 Mod 时假后端也认得它
  ipc.overrides.delete("list_instances");
  ipc.overrides.delete("get_sidebar_pins");
  store = await startedStore();
  unsubscribe = watchToasts(store);
});

afterEach(() => {
  unsubscribe();
  store.stop();
  vi.useRealTimers();
});

/** 假安装与逐项装 Mod 都按假时钟推进；推够之后把收尾的微任务跑完。 */
async function runTasks(): Promise<void> {
  for (let i = 0; i < 20; i++) {
    await vi.advanceTimersByTimeAsync(1000);
    await settle();
  }
}

/** 假后端此刻给 1.21.1 Fabric 的开局表，按勾选「Fabric API」与「性能优化组合」组装（API 在前）。 */
async function fabricPicks(): Promise<StarterPick[]> {
  const table = await starterMods("fabric", "1.21.1");
  return table.available.map((m) => ({ projectId: m.project_id, modVersionId: m.version.version_id, title: m.name, fileSize: m.version.file_size }));
}

const instance = (id: string) => store.getState().instances.find((i) => i.id === id);
const tasksOf = (command: string) => store.getState().tasks.filter((t) => t.spec.command === command);
const toasts = () => shown;
const installed = (calls: Record<string, unknown>[]) => calls.map((a) => [a.versionId, a.projectId, a.modVersionId, a.step]);

describe("新实例起步：沿用默认设置与开局 Mod", () => {
  it("勾了沿用默认设置与 Fabric API、性能组合：安装带 useTemplate，就绪后只多一条装 Mod 的组合任务，逐项按序装上 5 个", async () => {
    await saveInstanceAsTemplate("1.21");
    const picks = await fabricPicks();
    expect(picks).toHaveLength(5);
    await store.actions.createInstance({ name: NAME, mcVersion: "1.21.1", loader: "fabric", loaderVersion: "0.16.10", cover: "grass", useTemplate: true, starterMods: picks });
    expect(callsOf(ipc, "install_version")).toEqual([{ taskId: expect.any(String), id: "1.21.1", loader: "fabric", loaderVersion: "0.16.10", targetName: NAME, useTemplate: true }]);
    // 实例装好之前不装 Mod：组合任务在就绪之后才排进来
    expect(tasksOf("install_mods")).toEqual([]);

    await runTasks();

    expect(instance(NAME)?.status).toBe("ready");
    const before = store.getState().tasks.filter((t) => t.spec.command !== "install_version");
    expect(before.map((t) => [t.kind, t.spec.command, t.title, t.detail, t.instanceId, t.status])).toEqual([["mod", "install_mods", "装上 5 个开局 Mod", "「周末生存」", NAME, "done"]]);
    expect(before[0].spec.args).toMatchObject({ versionId: NAME, platform: "modrinth", projectId: "P7dR8mSH", starter: true });
    expect(installed(callsOf(ipc, "install_mod"))).toEqual([
      [NAME, "P7dR8mSH", "fapi-0115", 0],
      [NAME, "AANobbMI", "sodium-121", 1],
      [NAME, "gvQqBUqZ", "lith-0143", 2],
      [NAME, "uXXizFIs", "fc-702-fabric", 3],
      [NAME, "nmDcB62a", "mfix-5194-fabric", 4],
    ]);
    expect((await listMods(NAME)).map((m) => m.source?.project_id)).toEqual(["AANobbMI", "P7dR8mSH", "gvQqBUqZ", "nmDcB62a", "uXXizFIs"]);
    expect(instance(NAME)?.modCount).toBe(5);
    // 套上了默认设置就不补「没有沿用」的提示；就绪与装好各一条
    expect(toasts()).toContain(`success:「${NAME}」已就绪:可以开始游戏了`);
    expect(toasts()).toContain(`success:已给「${NAME}」装上 5 个 Mod`);
    expect(toasts().some((t) => t.includes("没有沿用默认设置"))).toBe(false);
  });

  it("第 2 项装失败：组合任务记为失败，已经装上的第 1 项留着，实例照常是就绪", async () => {
    ipc.overrides.set("install_mod", (args) => {
      if (args.step === 1) throw new IpcError("mod_platform_failed", "Modrinth 请求失败: HTTP 503");
      return mockInvoke("install_mod", args);
    });
    const picks = await fabricPicks();
    await store.actions.createInstance({ name: NAME, mcVersion: "1.21.1", loader: "fabric", loaderVersion: "0.16.10", cover: "grass", useTemplate: false, starterMods: picks });
    await runTasks();

    expect(instance(NAME)?.status).toBe("ready");
    expect(tasksOf("install_version").map((t) => t.status)).toEqual(["done"]);
    const starter = tasksOf("install_mods");
    expect(starter.map((t) => [t.status, t.error?.code, t.error?.message])).toEqual([["failed", "mod_platform_failed", "Modrinth 请求失败: HTTP 503"]]);
    expect(installed(callsOf(ipc, "install_mod"))).toEqual([
      [NAME, "P7dR8mSH", "fapi-0115", 0],
      [NAME, "AANobbMI", "sodium-121", 1],
    ]);
    expect((await listMods(NAME)).map((m) => m.source?.project_id)).toEqual(["P7dR8mSH"]);
    // 组合任务停下前装上的那一项要反映到列表的 Mod 数上
    expect(instance(NAME)?.modCount).toBe(1);
    expect(toasts()).toContain("error:下载失败：装上 5 个开局 Mod:Modrinth 请求失败: HTTP 503");
    expect(toasts().some((t) => t.includes("装上 5 个 Mod"))).toBe(false);
  });

  it("新建失败、盘上留下目录：重试改排补全，补全好了照样接着装当初勾的开局 Mod", async () => {
    // 第一次安装在下载前失败（加载器版本对不上），假后端与后端一样留下带安装标记的目录
    ipc.overrides.set("install_version", (args) => mockInvoke("install_version", { ...args, loaderVersion: "0.0.0-missing" }));
    const picks = (await fabricPicks()).slice(0, 2);
    await store.actions.createInstance({ name: NAME, mcVersion: "1.21.1", loader: "fabric", loaderVersion: "0.16.10", cover: "grass", useTemplate: false, starterMods: picks });
    await runTasks();
    const [failed] = tasksOf("install_version");
    expect(failed.status).toBe("failed");
    expect(callsOf(ipc, "install_mod")).toEqual([]);

    store.actions.retryTask(failed.id);
    await runTasks();
    expect(callsOf(ipc, "repair_instance").map((a) => a.id)).toEqual([NAME]);
    expect(tasksOf("repair_instance").map((t) => t.status)).toEqual(["done"]);
    expect(tasksOf("install_mods").map((t) => [t.title, t.status])).toEqual([["装上 2 个开局 Mod", "done"]]);
    expect(installed(callsOf(ipc, "install_mod"))).toEqual([
      [NAME, "P7dR8mSH", "fapi-0115", 0],
      [NAME, "AANobbMI", "sodium-121", 1],
    ]);
    expect(toasts()).toContain(`success:已给「${NAME}」装上 2 个 Mod`);
  });

  it("没勾开局 Mod、也没勾沿用默认设置：只有新建任务，不调装 Mod，也不补提示", async () => {
    await store.actions.createInstance({ name: NAME, mcVersion: "1.21.1", loader: "fabric", loaderVersion: "0.16.10", cover: "grass" });
    expect(callsOf(ipc, "install_version")[0].useTemplate).toBe(false);
    await runTasks();
    expect(store.getState().tasks.map((t) => [t.spec.command, t.status])).toEqual([["install_version", "done"]]);
    expect(callsOf(ipc, "install_mod")).toEqual([]);
    expect(toasts().filter((t) => t.startsWith("info:「"))).toEqual([]);
  });

  it("勾了沿用默认设置却没有套上：就绪通知之后补一条 info，正文写原因（没有模板 / 原版正式版不隔离）", async () => {
    await store.actions.createInstance({ name: NAME, mcVersion: "1.21.1", loader: "fabric", loaderVersion: "0.16.10", cover: "grass", useTemplate: true, starterMods: [] });
    await runTasks();
    const list = toasts();
    const ready = list.indexOf(`success:「${NAME}」已就绪:可以开始游戏了`);
    expect(ready).toBeGreaterThanOrEqual(0);
    expect(list[ready + 1]).toBe(`info:「${NAME}」没有沿用默认设置:安装时没有找到默认设置，可能已被清除`);

    await saveInstanceAsTemplate("1.21");
    await store.actions.createInstance({ name: "原版", mcVersion: "1.21.1", loader: "vanilla", loaderVersion: null, cover: "grass", useTemplate: true, starterMods: [] });
    await runTasks();
    expect(toasts()).toContain("info:「原版」没有沿用默认设置:这个实例与其他未隔离的实例共用 .minecraft 里的设置");
    expect(store.getState().tasks.filter((t) => t.spec.command === "install_mods")).toEqual([]);
  });

  it("重启后恢复的开局任务没有入队时的上下文：按参数里的 starter 认出来，重试装完照开局的口径通知", async () => {
    store.stop();
    const record: TaskRecordDto = {
      id: "task-old",
      kind: "mod",
      title: "装上 2 个开局 Mod",
      detail: "「1.21.1-Fabric」",
      instance_id: "1.21.1-Fabric",
      status: "running",
      progress: 0.5,
      bytes: 0,
      total_bytes: null,
      speed_bps: 0,
      attempt: 1,
      error: null,
      created_at: T0 - 60_000,
      finished_at: null,
      spec: {
        command: "install_mods",
        args: {
          versionId: "1.21.1-Fabric",
          platform: "modrinth",
          projectId: "uXXizFIs",
          starter: true,
          items: [
            { platform: "modrinth", projectId: "uXXizFIs", modVersionId: "fc-702-fabric", title: "FerriteCore", fileSize: 143_360 },
            { platform: "modrinth", projectId: "nmDcB62a", modVersionId: "mfix-5194-fabric", title: "ModernFix", fileSize: 696_320 },
          ],
        },
      },
    };
    ipc.overrides.set("load_task_journal", () => ({ seq: 0, tasks: [record] }));
    unsubscribe();
    store = await startedStore();
    unsubscribe = watchToasts(store);
    const [restored] = store.getState().tasks;
    expect(restored.status).toBe("failed");
    store.actions.retryTask(restored.id);
    await runTasks();
    expect(store.getState().tasks.map((t) => t.status)).toEqual(["done"]);
    expect(installed(callsOf(ipc, "install_mod"))).toEqual([
      ["1.21.1-Fabric", "uXXizFIs", "fc-702-fabric", 0],
      ["1.21.1-Fabric", "nmDcB62a", "mfix-5194-fabric", 1],
    ]);
    expect(toasts()).toContain("success:已给「1.21.1-Fabric」装上 2 个 Mod");
  });

  /** 把一条任务记录当成上次退出前写下的任务表，重启 store 读回来。 */
  async function restartWith(record: TaskRecordDto): Promise<void> {
    store.stop();
    ipc.overrides.set("load_task_journal", () => ({ seq: 0, tasks: [record] }));
    unsubscribe();
    store = await startedStore();
    unsubscribe = watchToasts(store);
  }

  const interrupted = (command: string, title: string, instanceId: string, args: Record<string, unknown>): TaskRecordDto => ({
    id: `task-${command}`,
    kind: command === "repair_instance" ? "repair" : "game",
    title,
    detail: `「${instanceId}」`,
    instance_id: instanceId,
    status: "running",
    progress: 0.4,
    bytes: 0,
    total_bytes: null,
    speed_bps: 0,
    attempt: 1,
    error: null,
    created_at: T0 - 60_000,
    finished_at: null,
    spec: { command, args },
  });

  it("新建装到一半退出了启动器：任务表里记着勾的开局 Mod，重启后重试新建，就绪后照样接着装", async () => {
    const picks = (await fabricPicks()).slice(0, 3);
    // 这次安装停在半路，不会就绪：要看的只是退出前写进任务表的参数
    ipc.overrides.set("install_version", () => new Promise(() => undefined));
    await store.actions.createInstance({ name: NAME, mcVersion: "1.21.1", loader: "fabric", loaderVersion: "0.16.10", cover: "grass", useTemplate: false, starterMods: picks });
    const args = tasksOf("install_version")[0].spec.args;
    expect(args.starterMods).toEqual(picks);
    // 任务表里记着，调后端时不带：后端的新建命令没有这个参数
    expect("starterMods" in callsOf(ipc, "install_version")[0]).toBe(false);
    ipc.overrides.delete("install_version");
    const other = "重启之后";

    await restartWith(interrupted("install_version", "新建 1.21.1 Fabric", other, { ...args, targetName: other }));
    resetRecorder(ipc);
    const [restored] = store.getState().tasks;
    expect(restored.status).toBe("failed");
    store.actions.retryTask(restored.id);
    await runTasks();

    expect(tasksOf("install_version").map((t) => t.status)).toEqual(["done"]);
    expect(tasksOf("install_mods").map((t) => [t.title, t.status])).toEqual([["装上 3 个开局 Mod", "done"]]);
    expect(installed(callsOf(ipc, "install_mod"))).toEqual([
      [other, "P7dR8mSH", "fapi-0115", 0],
      [other, "AANobbMI", "sodium-121", 1],
      [other, "gvQqBUqZ", "lith-0143", 2],
    ]);
    expect(toasts()).toContain(`success:已给「${other}」装上 3 个 Mod`);
  });

  it("改排的补全装到一半退出了启动器：重启后重试补全，补全好了照样接着装当初勾的开局 Mod", async () => {
    const picks = (await fabricPicks()).slice(3);
    await restartWith(interrupted("repair_instance", "补全「1.21.1-Fabric」", "1.21.1-Fabric", { id: "1.21.1-Fabric", starterMods: picks }));
    const [restored] = store.getState().tasks;
    expect(restored.status).toBe("failed");
    store.actions.retryTask(restored.id);
    await runTasks();

    expect(tasksOf("repair_instance").map((t) => t.status)).toEqual(["done"]);
    expect(tasksOf("install_mods").map((t) => [t.title, t.status])).toEqual([["装上 2 个开局 Mod", "done"]]);
    expect(installed(callsOf(ipc, "install_mod"))).toEqual([
      ["1.21.1-Fabric", "uXXizFIs", "fc-702-fabric", 0],
      ["1.21.1-Fabric", "nmDcB62a", "mfix-5194-fabric", 1],
    ]);
  });

  it("没勾开局 Mod 的新建与补全不在参数里多写 starterMods", async () => {
    await store.actions.createInstance({ name: NAME, mcVersion: "1.21.1", loader: "fabric", loaderVersion: "0.16.10", cover: "grass", starterMods: [] });
    expect("starterMods" in tasksOf("install_version")[0].spec.args).toBe(false);
    await runTasks();
    await store.actions.repairInstance(NAME);
    expect(tasksOf("repair_instance")[0].spec.args).toEqual({ id: NAME });
  });

  it("保存为默认与清除：成功后默认设置的查询失效重取，并各自通知；没进过游戏的实例保存失败原样抛出", async () => {
    await store.actions.saveInstanceAsTemplate("1.21");
    expect(toasts()).toContain("success:已把「1.21」的设置保存为默认:新建实例时可以在确认步沿用");
    expect(callsOf(ipc, "save_instance_as_template")).toEqual([{ id: "1.21" }]);
    await store.actions.clearTemplate();
    expect(toasts()).toContain("info:已清除默认设置");
    const error = await store.actions.saveInstanceAsTemplate("樱花生存").catch((e: unknown) => e);
    expect(error).toMatchObject({ code: "template_source_empty", detail: { id: "樱花生存" } });
  });
});
