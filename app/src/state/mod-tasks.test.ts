// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IpcError } from "../ipc/errors";
import type { InstallPlan, ModUpdateOutcomeDto, ModVersionInfo, UpdateCandidate } from "../ipc/mods";
import { CORE_EVENT } from "../ipc/tasks";
import type { IpcRecorder } from "../test/fake-bridge";
import { bootOverrides, callsOf, deferred, emit, resetRecorder, settle, startedStore, type Deferred } from "../test/launcher";
import { resources } from "./resource";
import type { LauncherStore } from "./store";

const ipc = vi.hoisted((): IpcRecorder => ({ calls: [], overrides: new Map() }));
vi.mock("../ipc/bridge", async (orig) => (await import("../test/fake-bridge")).fakeBridge(await orig(), ipc));

const INSTALLED = { file_name: "x.jar", path: "", platform: "modrinth", skipped: [] };

function version(projectId: string, versionId: string, overrides: Partial<ModVersionInfo> = {}): ModVersionInfo {
  return {
    version_id: versionId,
    project_id: projectId,
    platform: "modrinth",
    name: `${projectId} ${versionId}`,
    version_number: versionId,
    release_channel: "release",
    game_versions: ["1.21.1"],
    loaders: ["fabric"],
    file_name: `${projectId}-${versionId}.jar`,
    file_size: 1024,
    sha1: null,
    download_url: null,
    date_published: "",
    dependencies: [],
    ...overrides,
  };
}

/** update_mod 的成功结果。 */
function updated(args: Record<string, unknown>, skipped: string[] = []): ModUpdateOutcomeDto {
  return { file_name: String(args.fileName), path: "", platform: "modrinth", skipped };
}

function plan(...items: { projectId: string; versionId: string; satisfied?: boolean }[]): InstallPlan {
  return {
    items: items.map((item, i) => ({
      version: version(item.projectId, item.versionId),
      title: item.projectId,
      icon_url: null,
      required_by: i === 0 ? null : items[0].projectId,
      already_satisfied: item.satisfied === true,
    })),
    skipped: [],
  };
}

/** 往缓存里放一份数据并确认它被缓存住（第二次读不再请求）。 */
async function cached(key: string): Promise<ReturnType<typeof vi.fn>> {
  const fetcher = vi.fn(() => Promise.resolve(key));
  await resources.read(key, fetcher);
  await resources.read(key, fetcher);
  expect(fetcher).toHaveBeenCalledTimes(1);
  return fetcher;
}

async function readAgain(key: string, fetcher: ReturnType<typeof vi.fn>): Promise<number> {
  await resources.read(key, fetcher as () => Promise<string>);
  return fetcher.mock.calls.length;
}

let store: LauncherStore;

beforeEach(async () => {
  vi.useFakeTimers();
  vi.setSystemTime(1_720_000_000_000);
  resetRecorder(ipc);
  bootOverrides(ipc);
  ipc.overrides.set("install_mod", () => ({ file_name: "x.jar", path: "", platform: "modrinth", skipped: [] }));
  store = await startedStore();
});
afterEach(() => {
  store.stop();
  vi.useRealTimers();
});

describe("Mod 集合变化后发现页的落位矩阵失效", () => {
  it("装好 Mod 后，这个工程与它前置的矩阵、目标实例的安装计划都要重取；别的实例的计划不受影响", async () => {
    ipc.overrides.set("plan_install", () => plan({ projectId: "sodium", versionId: "v2" }, { projectId: "fabric-api", versionId: "f1" }));
    const sodium = await cached("match:modrinth:sodium:mod:auto");
    const api = await cached("match:modrinth:fabric-api:mod:auto");
    const targetPlan = await cached("plan:生存:modrinth:sodium:v2");
    const otherPlan = await cached("plan:创造:modrinth:sodium:v2");

    await store.actions.installResource({
      resourceType: "mod",
      platform: "modrinth",
      projectId: "sodium",
      name: "Sodium",
      targets: [{ instanceId: "生存", fileVersionId: "v2", world: null }],
    });
    await settle();
    expect(callsOf(ipc, "install_mod")).toHaveLength(2);
    expect(store.getState().tasks.map((t) => t.status)).toEqual(["done"]);

    expect(await readAgain("match:modrinth:sodium:mod:auto", sodium)).toBe(2);
    expect(await readAgain("match:modrinth:fabric-api:mod:auto", api)).toBe(2);
    expect(await readAgain("plan:生存:modrinth:sodium:v2", targetPlan)).toBe(2);
    expect(await readAgain("plan:创造:modrinth:sodium:v2", otherPlan)).toBe(1);
  });

  it("移除 Mod 后矩阵失效：被移除的工程重新显示为可装", async () => {
    ipc.overrides.set("remove_mod", () => null);
    const sodium = await cached("match:modrinth:sodium:mod:auto");
    await store.actions.removeMod("生存", "sodium-v2.jar", "Sodium");
    expect(await readAgain("match:modrinth:sodium:mod:auto", sodium)).toBe(2);
  });

  it("装好资源包后矩阵失效", async () => {
    ipc.overrides.set("install_resource", () => ({ resource_type: "resource_pack", world: null, file_name: "faithful.zip" }));
    const pack = await cached("match:modrinth:faithful:resource_pack:auto");
    await store.actions.installResource({
      resourceType: "resource_pack",
      platform: "modrinth",
      projectId: "faithful",
      name: "Faithful",
      targets: [{ instanceId: "生存", fileVersionId: "r1", world: null }],
    });
    await settle();
    expect(store.getState().tasks.map((t) => t.status)).toEqual(["done"]);
    expect(await readAgain("match:modrinth:faithful:resource_pack:auto", pack)).toBe(2);
  });
});

function candidate(projectId: string, current: string, latest: string): UpdateCandidate {
  return { file_name: `${projectId}-${current}.jar`, title: projectId, current_version_id: current, current_version_number: current, latest: version(projectId, latest) };
}

describe("装 Mod 期间实例的状态", () => {
  const inst = (id: string) => store.getState().instances.find((i) => i.id === id);

  it("Mod 与资源任务只把实例记为改动中，照常可启动；补全这类写整个目录的任务才算安装中", async () => {
    const install = deferred<unknown>();
    ipc.overrides.set("plan_install", () => plan({ projectId: "sodium", versionId: "v2" }));
    ipc.overrides.set("install_mod", () => install.promise);
    await store.actions.installResource({
      resourceType: "mod",
      platform: "modrinth",
      projectId: "sodium",
      name: "Sodium",
      targets: [{ instanceId: "生存", fileVersionId: "v2", world: null }],
    });
    await settle();
    expect(store.getState().tasks.map((t) => [t.spec.command, t.status])).toEqual([["install_mods", "running"]]);
    expect(inst("生存")).toMatchObject({ status: "ready", activity: "modifying", brokenReason: null });
    expect(inst("创造")).toMatchObject({ status: "ready", activity: null });

    install.resolve({ file_name: "x.jar", path: "", platform: "modrinth", skipped: [] });
    await settle();
    expect(inst("生存")).toMatchObject({ status: "ready", activity: null });

    const repair = deferred<unknown>();
    ipc.overrides.set("repair_instance", () => repair.promise);
    await store.actions.repairInstance("生存");
    await settle();
    expect(inst("生存")).toMatchObject({ status: "installing" });
    repair.resolve(null);
    await settle();
  });
});

describe("一次装进几个实例", () => {
  const targets = ["生存", "创造", "冒险"].map((instanceId) => ({ instanceId, fileVersionId: "v2", world: null }));
  const infos = () => store.getState().toasts.filter((t) => t.tone === "info").map((t) => [t.title, t.body]);

  it("某个实例的安装计划失败时，其余照常排上并通知，最后原样报出那一个的错误", async () => {
    ipc.overrides.set("plan_install", (args) => {
      if (args.versionId === "创造") throw new IpcError("network_failed", "Modrinth 连不上", { network: "connect" });
      return plan({ projectId: "sodium", versionId: "v2" });
    });
    ipc.overrides.set("install_mod", () => deferred<unknown>().promise);
    await expect(store.actions.installResource({ resourceType: "mod", platform: "modrinth", projectId: "sodium", name: "Sodium", targets })).rejects.toMatchObject({
      code: "network_failed",
      message: "Modrinth 连不上",
    });
    expect(store.getState().tasks.map((t) => [t.instanceId, t.spec.command])).toEqual([
      ["生存", "install_mods"],
      ["冒险", "install_mods"],
    ]);
    expect(infos()).toEqual([["已加入下载队列：Sodium", "装入 2 个实例，进度见下载任务"]]);
  });

  it("几个实例都失败时，错误里逐个写明实例与原因", async () => {
    ipc.overrides.set("plan_install", (args) => {
      if (args.versionId === "生存") return plan({ projectId: "sodium", versionId: "v2" });
      throw new IpcError("mod_version_not_found", `${String(args.versionId)} 找不到这个版本`);
    });
    ipc.overrides.set("install_mod", () => deferred<unknown>().promise);
    await expect(store.actions.installResource({ resourceType: "mod", platform: "modrinth", projectId: "sodium", name: "Sodium", targets })).rejects.toThrow(
      "2 个实例没能加入下载队列：「创造」创造 找不到这个版本；「冒险」冒险 找不到这个版本",
    );
    expect(store.getState().tasks.map((t) => t.instanceId)).toEqual(["生存"]);
    expect(infos()).toEqual([["已加入下载队列：Sodium", "装入「生存」"]]);
  });
});

describe("全部更新", () => {
  it("多个可更新合成一个任务：标题写个数，逐个调 update_mod 并共用 taskId，完成只弹一条通知", async () => {
    ipc.overrides.set("check_updates", () => [candidate("sodium", "s1", "s2"), candidate("lithium", "l1", "l2"), candidate("iris", "i1", "i2")]);
    ipc.overrides.set("update_mod", (args) => updated(args));
    await store.actions.updateAllMods("生存");
    await settle();

    const tasks = store.getState().tasks;
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({ title: "更新 3 个 Mod", detail: "「生存」", kind: "mod", instanceId: "生存", status: "done" });
    const calls = callsOf(ipc, "update_mod");
    expect(calls.map((a) => [a.fileName, a.modVersionId])).toEqual([
      ["sodium-s1.jar", "s2"],
      ["lithium-l1.jar", "l2"],
      ["iris-i1.jar", "i2"],
    ]);
    expect(new Set(calls.map((a) => a.taskId)).size).toBe(1);
    // 每一项带上自己是第几项，后端把它标在这一项的进度事件上
    expect(calls.map((a) => a.step)).toEqual([0, 1, 2]);
    const toasts = store.getState().toasts.filter((t) => t.tone === "success");
    expect(toasts.map((t) => [t.title, t.body])).toEqual([["已更新 3 个 Mod", "「生存」· 旧版本已保留，可以回滚"]]);
  });

  it("只有一个可更新时退回单个 Mod 的任务与文案", async () => {
    ipc.overrides.set("check_updates", () => [candidate("sodium", "s1", "s2")]);
    ipc.overrides.set("update_mod", (args) => updated(args));
    await store.actions.updateAllMods("生存");
    await settle();
    expect(store.getState().tasks.map((t) => [t.title, t.spec.command])).toEqual([["更新 sodium", "update_mod"]]);
    // 单独的任务不是组合任务的一项，不带项序号
    expect(callsOf(ipc, "update_mod").map((a) => "step" in a)).toEqual([false]);
    expect(store.getState().toasts.filter((t) => t.tone === "success").map((t) => t.title)).toEqual(["已更新 sodium"]);
  });

  it("中途失败后重试：已经换过的跳过，其余按现在的文件名接着更新", async () => {
    ipc.overrides.set("check_updates", () => [candidate("sodium", "s1", "s2"), candidate("lithium", "l1", "l2"), candidate("iris", "i1", "i2")]);
    ipc.overrides.set("update_mod", (args) => {
      if (args.fileName === "lithium-l1.jar") throw new IpcError("download_failed", "下载源暂时不可用");
      return updated(args);
    });
    await store.actions.updateAllMods("生存");
    await settle();
    const [task] = store.getState().tasks;
    expect(task.status).toBe("failed");
    expect(callsOf(ipc, "update_mod").map((a) => a.fileName)).toEqual(["sodium-s1.jar", "lithium-l1.jar"]);

    // sodium 已是 s2；lithium 被玩家手动换成了另一个文件名；iris 还没动
    const lithiumRenamed = { ...candidate("lithium", "l1", "l2"), file_name: "lithium-fabric-l1.jar" };
    ipc.overrides.set("check_updates", () => [lithiumRenamed, candidate("iris", "i1", "i2")]);
    ipc.overrides.set("update_mod", (args) => updated(args));
    store.actions.retryTask(task.id);
    await settle();
    expect(store.getState().tasks[0].status).toBe("done");
    expect(callsOf(ipc, "update_mod").slice(2).map((a) => [a.fileName, a.modVersionId])).toEqual([
      ["lithium-fabric-l1.jar", "l2"],
      ["iris-i1.jar", "i2"],
    ]);
  });

  /** 三个可更新，第三个（iris）第一次失败；返回失败的那个任务。 */
  async function failOnIris(): Promise<string> {
    ipc.overrides.set("check_updates", () => [candidate("sodium", "s1", "s2"), candidate("lithium", "l1", "l2"), candidate("iris", "i1", "i2")]);
    ipc.overrides.set("update_mod", (args) => {
      if (args.fileName === "iris-i1.jar") throw new IpcError("history_write_failed", "变更历史写入失败");
      return updated(args);
    });
    await store.actions.updateAllMods("生存");
    await settle();
    const [task] = store.getState().tasks;
    expect(task.status).toBe("failed");
    ipc.overrides.set("update_mod", (args) => updated(args));
    return task.id;
  }

  const successes = () => store.getState().toasts.filter((t) => t.tone === "success").map((t) => [t.title, t.body]);

  it("单个 Mod 的更新还在跑时，全部更新跳过它，只把其余的合成一个任务", async () => {
    const sodium = deferred<unknown>();
    ipc.overrides.set("check_updates", () => [candidate("sodium", "s1", "s2"), candidate("lithium", "l1", "l2"), candidate("iris", "i1", "i2")]);
    ipc.overrides.set("update_mod", (args) => (args.fileName === "sodium-s1.jar" ? sodium.promise : updated(args)));
    await store.actions.updateMod("生存", "sodium-s1.jar");
    await settle();
    expect(store.getState().tasks.map((t) => [t.spec.command, t.status])).toEqual([["update_mod", "running"]]);

    await store.actions.updateAllMods("生存");
    await settle();
    const [, all] = store.getState().tasks;
    expect(all).toMatchObject({ title: "更新 2 个 Mod", spec: { command: "update_mods" }, status: "done" });
    expect(callsOf(ipc, "update_mod").map((a) => a.fileName)).toEqual(["sodium-s1.jar", "lithium-l1.jar", "iris-i1.jar"]);
    sodium.resolve(updated({ fileName: "sodium-s1.jar" }));
    await settle();
  });

  it("组合更新还在跑时又多出一个可更新：只把多出的那个单独排上；都在更新了就提示已在队列里", async () => {
    const pending = deferred<unknown>();
    ipc.overrides.set("check_updates", () => [candidate("sodium", "s1", "s2"), candidate("lithium", "l1", "l2")]);
    ipc.overrides.set("update_mod", () => pending.promise);
    await store.actions.updateAllMods("生存");
    await settle();
    expect(store.getState().tasks.map((t) => [t.spec.command, t.status])).toEqual([["update_mods", "running"]]);

    ipc.overrides.set("check_updates", () => [candidate("sodium", "s1", "s2"), candidate("lithium", "l1", "l2"), candidate("iris", "i1", "i2")]);
    await store.actions.updateAllMods("生存");
    await settle();
    expect(store.getState().tasks.map((t) => [t.title, t.spec.command])).toEqual([
      ["更新 2 个 Mod", "update_mods"],
      ["更新 iris", "update_mod"],
    ]);
    expect(callsOf(ipc, "update_mod").map((a) => a.fileName)).toEqual(["sodium-s1.jar", "iris-i1.jar"]);

    await store.actions.updateAllMods("生存");
    await settle();
    expect(store.getState().tasks).toHaveLength(2);
    expect(store.getState().toasts.filter((t) => t.tone === "info").map((t) => t.title)).toEqual(["更新 3 个 Mod 已在下载队列里"]);
    pending.resolve(updated({ fileName: "sodium-s1.jar" }));
    await settle();
  });

  it("重试时上次已经全部换好：这次一个都没更新，提示都已是最新，不报「已更新 3 个」", async () => {
    const id = await failOnIris();
    ipc.overrides.set("check_updates", () => []);
    store.actions.retryTask(id);
    await settle();
    expect(store.getState().tasks[0].status).toBe("done");
    expect(callsOf(ipc, "update_mod")).toHaveLength(3);
    expect(successes()).toEqual([]);
    const info = store.getState().toasts.filter((t) => t.tone === "info").map((t) => [t.title, t.body]);
    expect(info).toEqual([["所有 Mod 都是最新的", "「生存」"]]);
  });

  it("重试时只剩一个要换：按这一次实际换的写，单个时写 Mod 名", async () => {
    const id = await failOnIris();
    ipc.overrides.set("check_updates", () => [candidate("iris", "i1", "i2")]);
    store.actions.retryTask(id);
    await settle();
    expect(callsOf(ipc, "update_mod").slice(3).map((a) => a.fileName)).toEqual(["iris-i1.jar"]);
    expect(successes()).toEqual([["已更新 iris", "「生存」· 旧版本已保留，可以回滚"]]);
  });

  it("重试时剩两个要换：写这一次换的个数", async () => {
    const id = await failOnIris();
    ipc.overrides.set("check_updates", () => [candidate("lithium", "l1", "l2"), candidate("iris", "i1", "i2")]);
    store.actions.retryTask(id);
    await settle();
    expect(successes()).toEqual([["已更新 2 个 Mod", "「生存」· 旧版本已保留，可以回滚"]]);
  });

  it("从任务日志恢复的旧记录没有 Mod 名：只剩一个时写个数", async () => {
    store.stop();
    resetRecorder(ipc);
    const items = [
      { fileName: "sodium-s1.jar", platform: "modrinth", projectId: "sodium", modVersionId: "s2" },
      { fileName: "iris-i1.jar", platform: "modrinth", projectId: "iris", modVersionId: "i2" },
    ];
    bootOverrides(ipc, {
      journal: [
        {
          id: "task-old",
          kind: "mod",
          title: "更新 2 个 Mod",
          detail: "「生存」",
          instance_id: "生存",
          status: "running",
          progress: 0.5,
          bytes: 0,
          total_bytes: null,
          speed_bps: 0,
          attempt: 1,
          error: null,
          created_at: 1_719_000_000_000,
          finished_at: null,
          spec: { command: "update_mods", args: { versionId: "生存", items } },
        },
      ],
    });
    ipc.overrides.set("check_updates", () => [candidate("iris", "i1", "i2")]);
    ipc.overrides.set("update_mod", (args) => updated(args));
    store = await startedStore();
    store.actions.retryTask("task-old");
    await settle();
    expect(callsOf(ipc, "update_mod").map((a) => a.fileName)).toEqual(["iris-i1.jar"]);
    expect(successes()).toEqual([["已更新 1 个 Mod", "「生存」· 旧版本已保留，可以回滚"]]);
  });
});

describe("更新时没有照办的前置", () => {
  const HELD = "前置 Fabric API 按你的更新设置保留现有版本，未换成 sodium-s2.jar 指定的版本";
  const GONE = "前置 Cloth Config 在平台上已不存在，未加入计划";
  const NO_FIT = "前置 Indium 没有适配该实例的版本，未加入计划";
  const toastList = () => store.getState().toasts.map((t) => [t.tone, t.title, t.body]);
  const SUCCESS_BODY = "「生存」· 旧版本已保留，可以回滚";

  it("单个更新：完成通知之后补一条 warning 写后端原文并能去下载任务页，任务详情留一份全文", async () => {
    ipc.overrides.set("check_updates", () => [candidate("sodium", "s1", "s2")]);
    ipc.overrides.set("update_mod", (args) => updated(args, [HELD, GONE]));
    await store.actions.updateMod("生存", "sodium-s1.jar");
    await settle();
    expect(toastList()).toEqual([
      ["success", "已更新 sodium", SUCCESS_BODY],
      ["warning", "「生存」有 2 个前置要留意", `${HELD}；${GONE}`],
    ]);
    expect(store.getState().toasts[1].action).toMatchObject({ label: "查看", to: { page: "tasks" } });
    expect(store.getState().tasks[0]).toMatchObject({ status: "done", detail: `s1 → s2 · 「生存」 · ${HELD}；${GONE}` });
  });

  it("全部更新：几项撞上同一个前置时说明只留一条，合成一条通知", async () => {
    ipc.overrides.set("check_updates", () => [candidate("sodium", "s1", "s2"), candidate("lithium", "l1", "l2"), candidate("iris", "i1", "i2")]);
    ipc.overrides.set("update_mod", (args) => updated(args, args.fileName === "lithium-l1.jar" ? [] : args.fileName === "iris-i1.jar" ? [GONE, NO_FIT] : [GONE]));
    await store.actions.updateAllMods("生存");
    await settle();
    expect(toastList()).toEqual([
      ["success", "已更新 3 个 Mod", SUCCESS_BODY],
      ["warning", "「生存」有 2 个前置要留意", `${GONE}；${NO_FIT}`],
    ]);
    expect(store.getState().tasks[0].detail).toBe(`「生存」 · ${GONE}；${NO_FIT}`);
  });

  it("都照办了：只有完成通知，任务详情不变", async () => {
    ipc.overrides.set("check_updates", () => [candidate("sodium", "s1", "s2")]);
    ipc.overrides.set("update_mod", (args) => updated(args));
    await store.actions.updateMod("生存", "sodium-s1.jar");
    await settle();
    expect(toastList()).toEqual([["success", "已更新 sodium", SUCCESS_BODY]]);
    expect(store.getState().tasks[0].detail).toBe("s1 → s2 · 「生存」");
  });

  it("全部更新停在中途：已经换好的那几项的说明不丢，失败通知照常", async () => {
    ipc.overrides.set("check_updates", () => [candidate("sodium", "s1", "s2"), candidate("lithium", "l1", "l2"), candidate("iris", "i1", "i2")]);
    ipc.overrides.set("update_mod", (args) => {
      if (args.fileName === "lithium-l1.jar") throw new IpcError("download_failed", "下载源暂时不可用");
      return updated(args, [GONE]);
    });
    await store.actions.updateAllMods("生存");
    await settle();
    expect(store.getState().tasks[0].status).toBe("failed");
    expect(toastList()).toContainEqual(["warning", "「生存」有 1 个前置要留意", GONE]);
    expect(toastList().filter(([tone]) => tone === "error")).toHaveLength(1);
    expect(store.getState().tasks[0].detail).toBe(`「生存」 · ${GONE}`);
  });

  it("全部更新中途取消：已经换好的那几项的说明同样不丢", async () => {
    const lithium = deferred<unknown>();
    ipc.overrides.set("check_updates", () => [candidate("sodium", "s1", "s2"), candidate("lithium", "l1", "l2")]);
    ipc.overrides.set("update_mod", (args) => (args.fileName === "sodium-s1.jar" ? updated(args, [NO_FIT]) : lithium.promise));
    ipc.overrides.set("cancel_task", () => true);
    await store.actions.updateAllMods("生存");
    await settle();
    expect(callsOf(ipc, "update_mod")).toHaveLength(2);
    await store.actions.cancelTask(store.getState().tasks[0].id);
    lithium.reject(new IpcError("cancelled", "已取消"));
    await settle();
    expect(store.getState().tasks[0].status).toBe("cancelled");
    expect(toastList()).toContainEqual(["warning", "「生存」有 1 个前置要留意", NO_FIT]);
  });

  it("重启后恢复的单个更新重试成功：没有入队上下文也补这条说明", async () => {
    store.stop();
    resetRecorder(ipc);
    bootOverrides(ipc, {
      journal: [
        {
          id: "task-one",
          kind: "mod",
          title: "更新 sodium",
          detail: "s1 → s2 · 「生存」",
          instance_id: "生存",
          status: "running",
          progress: 0.5,
          bytes: 0,
          total_bytes: null,
          speed_bps: 0,
          attempt: 1,
          error: null,
          created_at: 1_719_000_000_000,
          finished_at: null,
          spec: { command: "update_mod", args: { versionId: "生存", fileName: "sodium-s1.jar", modVersionId: "s2" } },
        },
      ],
    });
    ipc.overrides.set("update_mod", (args) => updated(args, [HELD]));
    store = await startedStore();
    store.actions.retryTask("task-one");
    await settle();
    expect(toastList()).toContainEqual(["warning", "「生存」有 1 个前置要留意", HELD]);
    expect(store.getState().tasks[0].detail).toBe(`s1 → s2 · 「生存」 · ${HELD}`);
  });
});

describe("更新预览里勾选的几项", () => {
  const picked = [candidate("sodium", "s1", "s2"), candidate("lithium", "l1", "l2"), candidate("iris", "i1", "i2")];

  beforeEach(() => {
    ipc.overrides.set("update_mod", (args) => updated(args));
  });

  it("三项里勾了两项：入队的 update_mods 只含这两项，不再现查可更新项，逐项更新的也只有它们", async () => {
    await store.actions.updateAllMods("生存", [picked[0], picked[2]]);
    const task = store.getState().tasks[0];
    expect(store.getState().tasks).toHaveLength(1);
    expect(task).toMatchObject({ title: "更新 2 个 Mod", spec: { command: "update_mods" } });
    const items = task.spec.args.items as { fileName: string; modVersionId: string; projectId: string; title: string }[];
    expect(items.map((i) => [i.fileName, i.modVersionId, i.projectId, i.title])).toEqual([
      ["sodium-s1.jar", "s2", "sodium", "sodium"],
      ["iris-i1.jar", "i2", "iris", "iris"],
    ]);
    expect(callsOf(ipc, "check_updates")).toHaveLength(0);
    await settle();
    expect(callsOf(ipc, "update_mod").map((a) => [a.fileName, a.modVersionId, a.step])).toEqual([
      ["sodium-s1.jar", "s2", 0],
      ["iris-i1.jar", "i2", 1],
    ]);
  });

  it("只勾了一项：按单个更新入队，标题写 Mod 名", async () => {
    await store.actions.updateAllMods("生存", [picked[1]]);
    expect(store.getState().tasks.map((t) => [t.title, t.spec.command, t.spec.args.fileName, t.spec.args.modVersionId])).toEqual([
      ["更新 lithium", "update_mod", "lithium-l1.jar", "l2"],
    ]);
    expect(callsOf(ipc, "check_updates")).toHaveLength(0);
  });

  it("勾选里有文件已经在别的更新任务里换：那一项被剔除，只入队其余的", async () => {
    ipc.overrides.set("update_mod", () => new Promise(() => undefined));
    await store.actions.updateAllMods("生存", [picked[0]]);
    await settle();
    await store.actions.updateAllMods("生存", [picked[0], picked[1]]);
    expect(store.getState().tasks.map((t) => [t.title, t.spec.args.fileName])).toEqual([
      ["更新 sodium", "sodium-s1.jar"],
      ["更新 lithium", "lithium-l1.jar"],
    ]);
  });

  it("一项都没勾是界面的错：直接报错，不入队", async () => {
    await expect(store.actions.updateAllMods("生存", [])).rejects.toThrow("至少要勾选一个 Mod");
    expect(store.getState().tasks).toEqual([]);
  });
});

describe("添加本地 Mod", () => {
  const toastsNow = () => store.getState().toasts.map((t) => [t.tone, t.title, t.body]);
  const ok = (source: string, fileName: string) => ({ status: "ok", source, file_name: fileName });
  const refused = (source: string, message: string) => ({ status: "error", source, error: { code: "local_mod_refused", message } });

  it("一个加成：success 通知写落盘的文件名，Mod 列表、历史、可更新项与落位矩阵失效，实例摘要重取", async () => {
    ipc.overrides.set("add_local_mods", () => [ok("D:\\dl\\Sodium.JAR", "Sodium.jar")]);
    const mods = await cached("mods:生存");
    const history = await cached("history:生存");
    const updates = await cached("mod-updates:生存");
    const matrix = await cached("match:modrinth:sodium:mod:auto");
    const other = await cached("mods:创造");
    const listedBefore = callsOf(ipc, "list_instances").length;

    await store.actions.addLocalMods("生存", ["D:\\dl\\Sodium.JAR"]);

    expect(callsOf(ipc, "add_local_mods")).toEqual([{ versionId: "生存", paths: ["D:\\dl\\Sodium.JAR"] }]);
    expect(toastsNow()).toEqual([["success", "已添加 Sodium.jar", undefined]]);
    expect(await readAgain("mods:生存", mods)).toBe(2);
    expect(await readAgain("history:生存", history)).toBe(2);
    expect(await readAgain("mod-updates:生存", updates)).toBe(2);
    expect(await readAgain("match:modrinth:sodium:mod:auto", matrix)).toBe(2);
    expect(await readAgain("mods:创造", other)).toBe(1);
    expect(callsOf(ipc, "list_instances").length).toBe(listedBefore + 1);
  });

  it("多个全部加成：通知写个数", async () => {
    ipc.overrides.set("add_local_mods", () => [ok("a", "a.jar"), ok("b", "b.jar"), ok("c", "c.jar")]);
    await store.actions.addLocalMods("生存", ["a", "b", "c"]);
    expect(toastsNow()).toEqual([["success", "已添加 3 个 Mod", undefined]]);
  });

  it("部分被拒：warning 通知写加成与没加成的个数和原因；两种原因时写原因各不相同；全被拒时只写没加成的个数", async () => {
    ipc.overrides.set("add_local_mods", () => [ok("a", "a.jar"), refused("b", "mods 目录里已有 b.jar，先移除它再添加")]);
    await store.actions.addLocalMods("生存", ["a", "b"]);
    expect(toastsNow()).toEqual([["warning", "已添加 1 个 Mod，1 个没能添加", "mods 目录里已有 b.jar，先移除它再添加"]]);

    ipc.overrides.set("add_local_mods", () => [ok("a", "a.jar"), refused("b", "b.jar 是空文件"), refused("c", "c.jar 不是 .jar 文件")]);
    await store.actions.addLocalMods("生存", ["a", "b", "c"]);
    expect(toastsNow().at(-1)).toEqual(["warning", "已添加 1 个 Mod，2 个没能添加", "原因各不相同"]);

    ipc.overrides.set("add_local_mods", () => [refused("a", "a.jar 是空文件"), refused("b", "a.jar 是空文件")]);
    await store.actions.addLocalMods("生存", ["a", "b"]);
    expect(toastsNow().at(-1)).toEqual(["warning", "2 个 Mod 没能添加", "a.jar 是空文件"]);
  });

  it("整次失败照常抛出、不发通知；文件可能已经落盘（历史没写成），列表照样失效", async () => {
    ipc.overrides.set("add_local_mods", () => {
      throw new IpcError("io", "文件 IO 失败: history.json");
    });
    const mods = await cached("mods:生存");
    await expect(store.actions.addLocalMods("生存", ["a"])).rejects.toMatchObject({ code: "io" });
    expect(toastsNow()).toEqual([]);
    expect(await readAgain("mods:生存", mods)).toBe(2);
  });

  it("空数组是界面的错：直接报错，不发命令", async () => {
    await expect(store.actions.addLocalMods("生存", [])).rejects.toThrow("至少要有一个文件");
    expect(callsOf(ipc, "add_local_mods")).toEqual([]);
  });
});

describe("批量启停与移除", () => {
  const infoAndWarnings = () => store.getState().toasts.map((t) => [t.tone, t.title, t.body]);

  it("批量停用全部成功：一条 info 通知写个数并说明改名，Mod 列表失效", async () => {
    ipc.overrides.set("set_mods_enabled", (args) => (args.fileNames as string[]).map((f) => ({ status: "ok", file_name: f, path: `${f}.disabled` })));
    const mods = await cached("mods:生存");
    await store.actions.toggleMods("生存", ["a.jar", "b.jar"], false);
    expect(callsOf(ipc, "set_mods_enabled")).toEqual([{ versionId: "生存", fileNames: ["a.jar", "b.jar"], enabled: false }]);
    expect(infoAndWarnings()).toEqual([["info", "已停用 2 个 Mod", "文件名后加了 .disabled，随时可以再启用"]]);
    expect(await readAgain("mods:生存", mods)).toBe(2);
  });

  it("批量启用有一项被占用：warning 通知写失败个数与那条原因；两种原因时写原因各不相同", async () => {
    const busy = { code: "mod_file_busy", message: "另一个程序正在使用此文件", detail: { path: "b.jar" } };
    ipc.overrides.set("set_mods_enabled", () => [
      { status: "ok", file_name: "a.jar.disabled", path: "a.jar" },
      { status: "error", file_name: "b.jar.disabled", error: busy },
    ]);
    await store.actions.toggleMods("生存", ["a.jar.disabled", "b.jar.disabled"], true);
    expect(infoAndWarnings()).toEqual([["warning", "1 个 Mod 没能启用", "另一个程序正在使用此文件"]]);

    ipc.overrides.set("set_mods_enabled", () => [
      { status: "error", file_name: "a.jar", error: busy },
      { status: "error", file_name: "b.jar", error: { code: "mod_state_conflict", message: "目标文件已存在" } },
      { status: "error", file_name: "c.jar", error: busy },
    ]);
    await store.actions.toggleMods("生存", ["a.jar", "b.jar", "c.jar"], false);
    expect(infoAndWarnings().at(-1)).toEqual(["warning", "3 个 Mod 没能停用", "原因各不相同"]);
  });

  it("整次被拒（实例忙碌）照常抛出，不发通知", async () => {
    ipc.overrides.set("set_mods_enabled", () => {
      throw new IpcError("instance_busy", "实例 生存 正在补全，请稍后再试", { id: "生存", activity: "repairing" });
    });
    await expect(store.actions.toggleMods("生存", ["a.jar"], false)).rejects.toMatchObject({ code: "instance_busy" });
    expect(infoAndWarnings()).toEqual([]);
  });

  it("批量移除两项其中一项被占用：另一项照常移除，warning 通知写「1 个 Mod 没能移除」与原因，列表与实例数重取", async () => {
    ipc.overrides.set("remove_mod", (args) => {
      if (args.fileName === "b.jar") throw new IpcError("mod_file_busy", "另一个程序正在使用此文件", { path: "b.jar" });
      return null;
    });
    const mods = await cached("mods:生存");
    const listsBefore = callsOf(ipc, "list_instances").length;
    await store.actions.removeMods("生存", [
      { fileName: "b.jar", name: "B" },
      { fileName: "a.jar", name: "A" },
    ]);
    expect(callsOf(ipc, "remove_mod").map((a) => a.fileName)).toEqual(["b.jar", "a.jar"]);
    expect(infoAndWarnings()).toEqual([["warning", "1 个 Mod 没能移除", "另一个程序正在使用此文件"]]);
    expect(await readAgain("mods:生存", mods)).toBe(2);
    expect(callsOf(ipc, "list_instances").length).toBe(listsBefore + 1);
  });

  it("批量移除全部成功：一条 info 通知写个数；一项都没有是界面的错", async () => {
    ipc.overrides.set("remove_mod", () => null);
    await store.actions.removeMods("生存", [
      { fileName: "a.jar", name: "A" },
      { fileName: "b.jar", name: "B" },
      { fileName: "c.jar", name: "C" },
    ]);
    expect(infoAndWarnings()).toEqual([["info", "已移除 3 个 Mod", undefined]]);
    await expect(store.actions.removeMods("生存", [])).rejects.toThrow("至少要有一个 Mod");
    expect(callsOf(ipc, "remove_mod")).toHaveLength(3);
  });

  describe("文件读写失败时正文写原因链里真正的原因", () => {
    const REFUSED = "mods 目录里没有 ghost.jar，可能已被移除";
    const DENIED = "拒绝访问。 (os error 5)";
    /** 后端 refuse 的形状：正文只有路径，拒绝原因借 Io 错误挂在原因链上。 */
    const refused = (path: string, reason: string) => ({ code: "io", message: `文件 IO 失败: ${path}`, detail: { path, causes: [reason] } });
    /** 启停改名失败走平台层：同样的正文，错误码是 mod_platform_failed，也不带 detail.path。 */
    const renameFailed = (path: string, reason: string) => ({ code: "mod_platform_failed", message: `文件 IO 失败: ${path}`, detail: { causes: [reason] } });
    const failedToggle = (error: { code: string; message: string; detail?: unknown }, i: number) => ({ status: "error", file_name: `${i}.jar`, error });

    it("批量停用被后端拒绝：写拒绝原因，不写路径", async () => {
      ipc.overrides.set("set_mods_enabled", () => [failedToggle(refused("D:/mc/mods/ghost.jar", REFUSED), 0)]);
      await store.actions.toggleMods("生存", ["ghost.jar"], false);
      expect(infoAndWarnings()).toEqual([["warning", "1 个 Mod 没能停用", REFUSED]]);
    });

    it("批量启用改名失败：路径逐项不同但原因相同，写那条原因，不说原因各不相同", async () => {
      ipc.overrides.set("set_mods_enabled", () => [renameFailed("D:/mc/mods/a.jar", DENIED), renameFailed("D:/mc/mods/b.jar", DENIED)].map(failedToggle));
      await store.actions.toggleMods("生存", ["a.jar.disabled", "b.jar.disabled"], true);
      expect(infoAndWarnings()).toEqual([["warning", "2 个 Mod 没能启用", DENIED]]);
    });

    it("原因真的不止一种时才说各不相同", async () => {
      ipc.overrides.set("set_mods_enabled", () => [refused("D:/mc/mods/ghost.jar", REFUSED), renameFailed("D:/mc/mods/a.jar", DENIED)].map(failedToggle));
      await store.actions.toggleMods("生存", ["ghost.jar", "a.jar"], false);
      expect(infoAndWarnings()).toEqual([["warning", "2 个 Mod 没能停用", "原因各不相同"]]);
    });

    it("批量移除被后端拒绝：写拒绝原因；两项同一条系统错误只写一次", async () => {
      ipc.overrides.set("remove_mod", (args) => {
        const { code, message, detail } = refused(`D:/mc/mods/${String(args.fileName)}`, args.fileName === "ghost.jar" ? REFUSED : DENIED);
        throw new IpcError(code, message, detail);
      });
      await store.actions.removeMods("生存", [{ fileName: "ghost.jar", name: "Ghost" }]);
      expect(infoAndWarnings().at(-1)).toEqual(["warning", "1 个 Mod 没能移除", REFUSED]);
      await store.actions.removeMods("生存", [
        { fileName: "a.jar", name: "A" },
        { fileName: "b.jar", name: "B" },
      ]);
      expect(infoAndWarnings().at(-1)).toEqual(["warning", "2 个 Mod 没能移除", DENIED]);
    });

    it("添加本地 Mod 走同一份通知：落盘失败同样写系统错误", async () => {
      const failed = (source: string) => ({ status: "error", source, error: refused(`D:/mc/mods/${source}.jar`, DENIED) });
      ipc.overrides.set("add_local_mods", () => [failed("a"), failed("b")]);
      await store.actions.addLocalMods("生存", ["a", "b"]);
      expect(infoAndWarnings().at(-1)).toEqual(["warning", "2 个 Mod 没能添加", DENIED]);
    });
  });
});

describe("忽略与恢复检查更新", () => {
  it("忽略：带上设置调后端，Mod 列表与可更新项都失效，通知说明怎么恢复；恢复时 hold 传 null", async () => {
    ipc.overrides.set("set_mod_update_hold", () => null);
    const mods = await cached("mods:生存");
    const updates = await cached("mod-updates:生存");
    const otherUpdates = await cached("mod-updates:创造");
    await store.actions.setModUpdateHold("生存", "sodium.jar", "Sodium", { kind: "ignored" });
    expect(await readAgain("mods:生存", mods)).toBe(2);
    expect(await readAgain("mod-updates:生存", updates)).toBe(2);
    expect(await readAgain("mod-updates:创造", otherUpdates)).toBe(1);

    await store.actions.setModUpdateHold("生存", "sodium.jar", "Sodium", null);
    expect(callsOf(ipc, "set_mod_update_hold")).toEqual([
      { versionId: "生存", fileName: "sodium.jar", hold: { kind: "ignored" } },
      { versionId: "生存", fileName: "sodium.jar", hold: null },
    ]);
    expect(store.getState().toasts.map((t) => [t.tone, t.title, t.body])).toEqual([
      ["info", "已忽略 Sodium 的更新", "检查更新时会跳过它，可以在更多菜单里恢复"],
      ["info", "已恢复检查 Sodium 的更新", undefined],
    ]);
  });

  it("更新日志的缓存按实例划分：实例删除后同名新实例不会拿到旧日志", async () => {
    ipc.overrides.set("delete_instance", () => ({ existed: true }));
    const changelog = await cached("mod-changelog:生存:sodium.jar|s2");
    await store.actions.deleteInstance("生存", 0);
    expect(await readAgain("mod-changelog:生存:sodium.jar|s2", changelog)).toBe(2);
  });
});

describe("组合任务的取消", () => {
  const installSodium = () =>
    store.actions.installResource({
      resourceType: "mod",
      platform: "modrinth",
      projectId: "sodium",
      name: "Sodium",
      targets: [{ instanceId: "生存", fileVersionId: "v2", world: null }],
    });

  it("某一项在取消宽限期内照常装完、后端按成功返回：不再开始下一项，任务落为已取消，Mod 列表重取", async () => {
    ipc.overrides.set("plan_install", () => plan({ projectId: "sodium", versionId: "v2" }, { projectId: "fabric-api", versionId: "f1" }, { projectId: "lithium", versionId: "l1" }));
    const first = deferred<unknown>();
    ipc.overrides.set("install_mod", () => (callsOf(ipc, "install_mod").length === 1 ? first.promise : { file_name: "x.jar", path: "", platform: "modrinth", skipped: [] }));
    // 取消到达时这一项正在运行（返回 true），后端随后不再记着这个 id
    ipc.overrides.set("cancel_task", () => true);
    await installSodium();
    await settle();
    const [task] = store.getState().tasks;
    expect(task.status).toBe("running");
    const mods = await cached("mods:生存");

    await store.actions.cancelTask(task.id);
    first.resolve({ file_name: "sodium-v2.jar", path: "", platform: "modrinth", skipped: [] });
    await settle();

    expect(callsOf(ipc, "install_mod").map((a) => a.projectId)).toEqual(["sodium"]);
    expect(callsOf(ipc, "cancel_task")).toEqual([{ taskId: `${task.id}#1` }]);
    expect(store.getState().tasks.map((t) => t.status)).toEqual(["cancelled"]);
    expect(store.getState().toasts.map((t) => t.title)).toContain("已取消：安装 Sodium");
    expect(store.getState().toasts.some((t) => t.tone === "success")).toBe(false);
    // 第一项已经落进 mods 目录，列表不能停在取消前
    expect(await readAgain("mods:生存", mods)).toBe(2);
  });

  it("全部更新：一项在宽限期内换好后不再更新其余的", async () => {
    ipc.overrides.set("check_updates", () => [candidate("sodium", "s1", "s2"), candidate("lithium", "l1", "l2"), candidate("iris", "i1", "i2")]);
    const first = deferred<unknown>();
    ipc.overrides.set("update_mod", (args) => (callsOf(ipc, "update_mod").length === 1 ? first.promise : updated(args)));
    ipc.overrides.set("cancel_task", () => true);
    await store.actions.updateAllMods("生存");
    await settle();
    const [task] = store.getState().tasks;
    await store.actions.cancelTask(task.id);
    first.resolve(updated({ fileName: "sodium-s2.jar" }));
    await settle();
    expect(callsOf(ipc, "update_mod").map((a) => a.fileName)).toEqual(["sodium-s1.jar"]);
    expect(store.getState().tasks.map((t) => t.status)).toEqual(["cancelled"]);
  });

  it("取消落在最后一项上、它在宽限期内做完：活已经干完，任务算完成", async () => {
    ipc.overrides.set("plan_install", () => plan({ projectId: "sodium", versionId: "v2" }, { projectId: "fabric-api", versionId: "f1" }));
    const last = deferred<unknown>();
    ipc.overrides.set("install_mod", () => (callsOf(ipc, "install_mod").length === 2 ? last.promise : { file_name: "x.jar", path: "", platform: "modrinth", skipped: [] }));
    ipc.overrides.set("cancel_task", () => true);
    await installSodium();
    await settle();
    const [task] = store.getState().tasks;
    expect(callsOf(ipc, "install_mod")).toHaveLength(2);
    await store.actions.cancelTask(task.id);
    last.resolve({ file_name: "fabric-api-f1.jar", path: "", platform: "modrinth", skipped: [] });
    await settle();
    expect(store.getState().tasks.map((t) => t.status)).toEqual(["done"]);
    expect(store.getState().toasts.filter((t) => t.tone === "success").map((t) => t.title)).toEqual(["已安装 Sodium 及 1 个前置"]);
  });

  it("删除实例时取消运行中的组合任务：同样不再开始下一项", async () => {
    ipc.overrides.set("plan_install", () => plan({ projectId: "sodium", versionId: "v2" }, { projectId: "fabric-api", versionId: "f1" }));
    const first = deferred<unknown>();
    ipc.overrides.set("install_mod", () => (callsOf(ipc, "install_mod").length === 1 ? first.promise : { file_name: "x.jar", path: "", platform: "modrinth", skipped: [] }));
    ipc.overrides.set("cancel_task", () => true);
    ipc.overrides.set("delete_instance", () => ({ existed: true }));
    await installSodium();
    await settle();
    const deleting = store.actions.deleteInstance("生存", 0);
    await settle();
    first.resolve({ file_name: "sodium-v2.jar", path: "", platform: "modrinth", skipped: [] });
    await deleting;
    await settle();
    expect(callsOf(ipc, "install_mod")).toHaveLength(1);
    expect(callsOf(ipc, "delete_instance")).toEqual([{ id: "生存" }]);
  });
});

describe("组合任务的进度按整体累计", () => {
  /** 每次调用挂起，等测试逐个放行。 */
  function pendingCalls(cmd: string): Deferred<unknown>[] {
    const calls: Deferred<unknown>[] = [];
    ipc.overrides.set(cmd, () => {
      const d = deferred<unknown>();
      calls.push(d);
      return d.promise;
    });
    return calls;
  }

  it("全部更新：按各项声明大小折成整体，换项不归零，总量不变；上一项晚到的进度不算进下一项", async () => {
    const sized = (projectId: string, current: string, latest: string, size: number): UpdateCandidate => ({
      ...candidate(projectId, current, latest),
      latest: version(projectId, latest, { file_size: size }),
    });
    ipc.overrides.set("check_updates", () => [sized("sodium", "s1", "s2", 100), sized("lithium", "l1", "l2", 300), sized("iris", "i1", "i2", 600)]);
    const calls = pendingCalls("update_mod");
    await store.actions.updateAllMods("生存");
    await settle();
    const [{ id }] = store.getState().tasks;
    const seen: [number, number, number | null][] = [];
    const snap = () => {
      const t = store.getState().tasks[0];
      seen.push([t.progress, t.bytes, t.totalBytes]);
    };
    const progress = (step: number, bytes: number, total: number) => {
      emit(CORE_EVENT, { kind: "download", task_id: `${id}#1`, step, total: 1, finished: bytes === total ? 1 : 0, bytes, total_bytes: total, speed: 4096 });
      snap();
    };
    const finish = async (i: number) => {
      calls[i].resolve(updated({ fileName: `${i}.jar` }));
      await settle();
      snap();
    };

    snap();
    progress(0, 0, 100);
    progress(0, 50, 100);
    progress(0, 100, 100);
    await finish(0);
    progress(0, 100, 100);
    progress(1, 150, 300);
    progress(1, 300, 300);
    await finish(1);
    progress(2, 300, 600);
    await finish(2);

    expect(seen).toEqual([
      [0, 0, 1000],
      [0, 0, 1000],
      [0.05, 50, 1000],
      [0.1, 100, 1000],
      [0.1, 100, 1000],
      [0.1, 100, 1000],
      [0.25, 250, 1000],
      [0.4, 400, 1000],
      [0.4, 400, 1000],
      [0.7, 700, 1000],
      [1, 1000, 1000],
    ]);
    expect(store.getState().tasks[0].status).toBe("done");
  });

  it("装 Mod：第一项连带下载了前置，按实际字节算进整体，不卡在主项自己的那一份", async () => {
    const sized = plan({ projectId: "sodium", versionId: "v2" }, { projectId: "fabric-api", versionId: "f1" });
    sized.items[0] = { ...sized.items[0], version: { ...sized.items[0].version, file_size: 1024 } };
    sized.items[1] = { ...sized.items[1], version: { ...sized.items[1].version, file_size: 2048 } };
    ipc.overrides.set("plan_install", () => sized);
    const calls = pendingCalls("install_mod");
    await store.actions.installResource({
      resourceType: "mod",
      platform: "modrinth",
      projectId: "sodium",
      name: "Sodium",
      targets: [{ instanceId: "生存", fileVersionId: "v2", world: null }],
    });
    await settle();
    const [{ id }] = store.getState().tasks;
    const seen: [number, number, number | null][] = [];
    const snap = () => {
      const t = store.getState().tasks[0];
      seen.push([t.progress, t.bytes, t.totalBytes]);
    };
    // 主项的命令按计划把 Sodium 与 Fabric API 一批下完
    emit(CORE_EVENT, { kind: "download", task_id: `${id}#1`, step: 0, total: 2, finished: 1, bytes: 1536, total_bytes: 3072, speed: 1 });
    snap();
    emit(CORE_EVENT, { kind: "download", task_id: `${id}#1`, step: 0, total: 2, finished: 2, bytes: 3072, total_bytes: 3072, speed: 1 });
    snap();
    calls[0].resolve(INSTALLED);
    await settle();
    snap();
    // 前置已经装好，第二项的命令无事可做
    calls[1].resolve(INSTALLED);
    await settle();
    snap();
    expect(seen).toEqual([
      [0.5, 1536, 3072],
      [1, 3072, 3072],
      [1, 3072, 3072],
      [1, 3072, 3072],
    ]);
    expect(store.getState().tasks[0]).toMatchObject({ status: "done", doneBytes: 3072 });
    expect(callsOf(ipc, "install_mod").map((a) => [a.projectId, a.step])).toEqual([
      ["sodium", 0],
      ["fabric-api", 1],
    ]);
  });

  it("装 Mod 时有一项不知道大小：按项数折，进度单调不减", async () => {
    const unsized = plan({ projectId: "sodium", versionId: "v2" }, { projectId: "fabric-api", versionId: "f1" }, { projectId: "lithium", versionId: "l1" });
    unsized.items[1] = { ...unsized.items[1], version: { ...unsized.items[1].version, file_size: null } };
    ipc.overrides.set("plan_install", () => unsized);
    const calls = pendingCalls("install_mod");
    await store.actions.installResource({
      resourceType: "mod",
      platform: "modrinth",
      projectId: "sodium",
      name: "Sodium",
      targets: [{ instanceId: "生存", fileVersionId: "v2", world: null }],
    });
    await settle();
    const [{ id }] = store.getState().tasks;
    const seen: number[] = [];
    const progress = (step: number, bytes: number, total: number) => {
      emit(CORE_EVENT, { kind: "download", task_id: `${id}#1`, step, total: 1, finished: 0, bytes, total_bytes: total, speed: 1 });
      seen.push(store.getState().tasks[0].progress);
    };
    progress(0, 512, 1024);
    calls[0].resolve(INSTALLED);
    await settle();
    seen.push(store.getState().tasks[0].progress);
    progress(1, 0, 4096);
    progress(1, 4096, 4096);
    calls[1].resolve(INSTALLED);
    await settle();
    progress(2, 1024, 1024);
    calls[2].resolve(INSTALLED);
    await settle();

    expect(store.getState().tasks[0]).toMatchObject({ status: "done", totalBytes: null });
    const expected = [1 / 6, 1 / 3, 1 / 3, 2 / 3, 1];
    expect(seen).toHaveLength(expected.length);
    seen.forEach((value, i) => expect(value).toBeCloseTo(expected[i], 10));
  });

  /** 全部更新：每个可更新按给定的声明大小起一项，返回各项挂起的调用与这一次尝试的 taskId。 */
  async function updateAll(sizes: readonly (number | null)[]): Promise<{ calls: Deferred<unknown>[]; taskId: string }> {
    const names = ["sodium", "lithium", "iris"];
    ipc.overrides.set("check_updates", () =>
      sizes.map((size, i) => ({ ...candidate(names[i], `${names[i]}1`, `${names[i]}2`), latest: version(names[i], `${names[i]}2`, { file_size: size }) })),
    );
    const calls = pendingCalls("update_mod");
    await store.actions.updateAllMods("生存");
    await settle();
    const [task] = store.getState().tasks;
    expect(task).toMatchObject({ status: "running", spec: { command: "update_mods" } });
    return { calls, taskId: `${task.id}#1` };
  }

  /** 逐条喂进度并记下每一步之后的 [进度, 已下字节, 总量, 累计字节]。 */
  function progressLog(taskId: string, calls: Deferred<unknown>[]) {
    const seen: [number, number, number | null, number][] = [];
    const snap = () => {
      const t = store.getState().tasks[0];
      seen.push([t.progress, t.bytes, t.totalBytes, t.doneBytes]);
    };
    return {
      seen,
      snap,
      download(step: number, bytes: number, totalBytes: number | null, finished: number, total = 1, speed = 1) {
        emit(CORE_EVENT, { kind: "download", task_id: taskId, step, total, finished, bytes, total_bytes: totalBytes, speed });
        snap();
      },
      async finish(i: number) {
        calls[i].resolve(updated({ fileName: `${i}.jar` }));
        await settle();
        snap();
      },
    };
  }

  it("两项声明大小相同：后一项第一条就报满也照常算进整体，上一项晚到的同样快照不重复算", async () => {
    const { calls, taskId } = await updateAll([100, 100]);
    const log = progressLog(taskId, calls);
    log.snap();
    log.download(0, 0, 100, 0);
    log.download(0, 100, 100, 1);
    await log.finish(0);
    // 第二项的文件在一个进度间隔里就下完了：它的第一条快照与上一项的最后一条逐字段相同
    log.download(1, 100, 100, 1);
    // 上一项的最后一条这时才送到
    log.download(0, 100, 100, 1);
    await log.finish(1);
    expect(log.seen).toEqual([
      [0, 0, 200, 0],
      [0, 0, 200, 0],
      [0.5, 100, 200, 100],
      [0.5, 100, 200, 100],
      [1, 200, 200, 200],
      [1, 200, 200, 200],
      [1, 200, 200, 200],
    ]);
    expect(store.getState().tasks[0]).toMatchObject({ status: "done", doneBytes: 200 });
    expect(calls).toHaveLength(2);
    expect(callsOf(ipc, "update_mod").map((a) => [a.fileName, a.step])).toEqual([
      ["sodium-sodium1.jar", 0],
      ["lithium-lithium1.jar", 1],
    ]);
  });

  it("两项大小都未知：按项数折，后一项已下字节比上一项多也照常采纳", async () => {
    const { calls, taskId } = await updateAll([null, null]);
    const log = progressLog(taskId, calls);
    log.snap();
    log.download(0, 200, null, 0);
    log.download(0, 500, null, 1);
    await log.finish(0);
    log.download(1, 600, null, 1, 2);
    log.download(0, 500, null, 1);
    log.download(1, 900, null, 2, 2);
    await log.finish(1);
    expect(log.seen).toEqual([
      [0, 0, null, 0],
      [0, 200, null, 200],
      [0.5, 500, null, 500],
      [0.5, 500, null, 500],
      [0.75, 1100, null, 1100],
      [0.75, 1100, null, 1100],
      [1, 1400, null, 1400],
      [1, 1400, null, 1400],
    ]);
    expect(store.getState().tasks[0]).toMatchObject({ status: "done", totalBytes: null, doneBytes: 1400 });
  });

  it("上一项的进度在下一项报过进度之后才到：只补上它自己的字节，不推整体进度、不算进下一项", async () => {
    const { calls, taskId } = await updateAll([100, 300]);
    const log = progressLog(taskId, calls);
    log.snap();
    log.download(0, 60, 100, 0, 1, 111);
    await log.finish(0);
    log.download(1, 30, 300, 0, 1, 222);
    log.download(0, 100, 100, 1, 1, 111);
    // 速度是这一刻正在下的那一项的，晚到的不改它
    expect(store.getState().tasks[0].speedBps).toBe(222);
    log.download(1, 300, 300, 1, 1, 222);
    await log.finish(1);
    expect(log.seen).toEqual([
      [0, 0, 400, 0],
      [0.15, 60, 400, 60],
      [0.25, 100, 400, 60],
      [0.325, 130, 400, 90],
      [0.325, 130, 400, 130],
      [1, 400, 400, 400],
      [1, 400, 400, 400],
    ]);
    expect(store.getState().tasks[0]).toMatchObject({ status: "done", doneBytes: 400 });
  });

  it("组合任务收到不带项序号的进度：说明前后端的约定破了，直接报错，不靠快照去猜", async () => {
    const { taskId } = await updateAll([100, 100]);
    expect(() => emit(CORE_EVENT, { kind: "download", task_id: taskId, total: 1, finished: 0, bytes: 10, total_bytes: 100, speed: 1 })).toThrow("不带项序号");
    expect(store.getState().tasks[0]).toMatchObject({ progress: 0, doneBytes: 0 });
  });
});
