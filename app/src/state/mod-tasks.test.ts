// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { InstallPlan, ModVersionInfo } from "../ipc/mods";
import type { IpcRecorder } from "../test/fake-bridge";
import { bootOverrides, callsOf, resetRecorder, settle, startedStore } from "../test/launcher";
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
