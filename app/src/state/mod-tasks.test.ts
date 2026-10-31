// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IpcError } from "../ipc/errors";
import type { InstallPlan, ModVersionInfo, UpdateCandidate } from "../ipc/mods";
import type { IpcRecorder } from "../test/fake-bridge";
import { bootOverrides, callsOf, deferred, resetRecorder, settle, startedStore } from "../test/launcher";
import { resources } from "./resource";
import type { LauncherStore } from "./store";

const ipc = vi.hoisted((): IpcRecorder => ({ calls: [], overrides: new Map() }));
vi.mock("../ipc/bridge", async (orig) => (await import("../test/fake-bridge")).fakeBridge(await orig(), ipc));

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
  ipc.overrides.set("install_mod", () => null);
  store = await startedStore();
});
afterEach(() => {
  store.stop();
  vi.useRealTimers();
});

describe("Mod 集合变化后发现页的落位矩阵失效", () => {
  it("装好 Mod 后，这个工程与它前置的矩阵、目标实例的安装计划都要重取；别的实例的计划不受影响", async () => {
    ipc.overrides.set("plan_install", () => plan({ projectId: "sodium", versionId: "v2" }, { projectId: "fabric-api", versionId: "f1" }));
    const sodium = await cached("match:modrinth:sodium:auto");
    const api = await cached("match:modrinth:fabric-api:auto");
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

    expect(await readAgain("match:modrinth:sodium:auto", sodium)).toBe(2);
    expect(await readAgain("match:modrinth:fabric-api:auto", api)).toBe(2);
    expect(await readAgain("plan:生存:modrinth:sodium:v2", targetPlan)).toBe(2);
    expect(await readAgain("plan:创造:modrinth:sodium:v2", otherPlan)).toBe(1);
  });

  it("移除 Mod 后矩阵失效：被移除的工程重新显示为可装", async () => {
    ipc.overrides.set("remove_mod", () => null);
    const sodium = await cached("match:modrinth:sodium:auto");
    await store.actions.removeMod("生存", "sodium-v2.jar", "Sodium");
    expect(await readAgain("match:modrinth:sodium:auto", sodium)).toBe(2);
  });

  it("装好资源包后矩阵失效", async () => {
    ipc.overrides.set("install_resource", () => ({ resource_type: "resource_pack", world: null, file_name: "faithful.zip" }));
    const pack = await cached("match:modrinth:faithful:auto");
    await store.actions.installResource({
      resourceType: "resource_pack",
      platform: "modrinth",
      projectId: "faithful",
      name: "Faithful",
      targets: [{ instanceId: "生存", fileVersionId: "r1", world: null }],
    });
    await settle();
    expect(store.getState().tasks.map((t) => t.status)).toEqual(["done"]);
    expect(await readAgain("match:modrinth:faithful:auto", pack)).toBe(2);
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

    install.resolve(null);
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

describe("全部更新", () => {
  it("多个可更新合成一个任务：标题写个数，逐个调 update_mod 并共用 taskId，完成只弹一条通知", async () => {
    ipc.overrides.set("check_updates", () => [candidate("sodium", "s1", "s2"), candidate("lithium", "l1", "l2"), candidate("iris", "i1", "i2")]);
    ipc.overrides.set("update_mod", (args) => ({ file_name: String(args.fileName), path: "", platform: "modrinth" }));
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
    const toasts = store.getState().toasts.filter((t) => t.tone === "success");
    expect(toasts.map((t) => [t.title, t.body])).toEqual([["已更新 3 个 Mod", "「生存」· 旧版本已保留，可以回滚"]]);
  });

  it("只有一个可更新时退回单个 Mod 的任务与文案", async () => {
    ipc.overrides.set("check_updates", () => [candidate("sodium", "s1", "s2")]);
    ipc.overrides.set("update_mod", (args) => ({ file_name: String(args.fileName), path: "", platform: "modrinth" }));
    await store.actions.updateAllMods("生存");
    await settle();
    expect(store.getState().tasks.map((t) => [t.title, t.spec.command])).toEqual([["更新 sodium", "update_mod"]]);
    expect(store.getState().toasts.filter((t) => t.tone === "success").map((t) => t.title)).toEqual(["已更新 sodium"]);
  });

  it("中途失败后重试：已经换过的跳过，其余按现在的文件名接着更新", async () => {
    ipc.overrides.set("check_updates", () => [candidate("sodium", "s1", "s2"), candidate("lithium", "l1", "l2"), candidate("iris", "i1", "i2")]);
    ipc.overrides.set("update_mod", (args) => {
      if (args.fileName === "lithium-l1.jar") throw new IpcError("download_failed", "下载源暂时不可用");
      return { file_name: String(args.fileName), path: "", platform: "modrinth" };
    });
    await store.actions.updateAllMods("生存");
    await settle();
    const [task] = store.getState().tasks;
    expect(task.status).toBe("failed");
    expect(callsOf(ipc, "update_mod").map((a) => a.fileName)).toEqual(["sodium-s1.jar", "lithium-l1.jar"]);

    // sodium 已是 s2；lithium 被玩家手动换成了另一个文件名；iris 还没动
    const lithiumRenamed = { ...candidate("lithium", "l1", "l2"), file_name: "lithium-fabric-l1.jar" };
    ipc.overrides.set("check_updates", () => [lithiumRenamed, candidate("iris", "i1", "i2")]);
    ipc.overrides.set("update_mod", (args) => ({ file_name: String(args.fileName), path: "", platform: "modrinth" }));
    store.actions.retryTask(task.id);
    await settle();
    expect(store.getState().tasks[0].status).toBe("done");
    expect(callsOf(ipc, "update_mod").slice(2).map((a) => [a.fileName, a.modVersionId])).toEqual([
      ["lithium-fabric-l1.jar", "l2"],
      ["iris-i1.jar", "i2"],
    ]);
  });
});
