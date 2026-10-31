// 假后端的工程目录要自洽：发现页搜得到的每个工程都能打开详情、列出版本、判定落位并装进实例，
// 浏览器预览里点开任何一张卡都不会撞上 404。
import { beforeEach, describe, expect, it, vi } from "vitest";
import { installMod, installResource, projectDetail, searchResources, type SearchArgs } from "../discover";
import { deleteInstance, listInstances, renameInstance } from "../instances";
import { installModpack, summarizePlatformModpack } from "../modpack";
import { listMods, matchInstances, modVersionList, planInstall } from "../mods";
import { mockInvoke, resetMocks } from "./index";
import { clearMockEventListeners } from "./events";
import { addMockInstance } from "./handlers/instances";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));

const ALL: SearchArgs = { query: null, resourceTypes: [], category: null, platform: null, loaders: [], gameVersions: [], sort: "relevance", limit: 50, cursor: null };

beforeEach(() => {
  resetMocks();
  clearMockEventListeners();
});

async function readyInstanceIds(): Promise<string[]> {
  return (await listInstances()).filter((i) => i.status === "ready").map((i) => i.id);
}

/** 只看版本、不关心截断的断言用。 */
const versionsOf = async (...args: Parameters<typeof modVersionList>) => (await modVersionList(...args)).versions;

describe("工程目录：搜得到就打得开、装得上", () => {
  it("每张卡的每个平台来源：详情、版本列表都取得到，最新版本与版本列表一致；能装进实例的还取得到落位矩阵", async () => {
    const { hits } = await searchResources(ALL);
    expect(hits.length).toBe(13);
    const ready = (await readyInstanceIds()).sort();
    for (const hit of hits) {
      for (const s of hit.sources) {
        const where = `${hit.title} @ ${s.platform}`;
        const detail = await projectDetail(s.platform, s.project_id);
        expect(detail.title, where).toBe(hit.title);
        const versions = await versionsOf(s.platform, s.project_id, [], []);
        expect(versions.length, where).toBeGreaterThan(0);
        expect(versions.every((v) => v.platform === s.platform && v.project_id === s.project_id), where).toBe(true);
        expect(detail.latest_version?.version_id, where).toBe(versions[0].version_id);
        // 整合包装成新实例，不往已有实例里落
        if (hit.resource_type === "modpack" || hit.resource_type === "plugin") continue;
        const matrix = await matchInstances(s.platform, s.project_id, hit.resource_type, null);
        expect(matrix.map((m) => m.version_id).sort(), where).toEqual(ready);
      }
    }
  });

  it("文件形态随类型：Mod 是 .jar 且标了加载器；资源包、光影、数据包是 .zip 且不带加载器；整合包分平台", async () => {
    const { hits } = await searchResources(ALL);
    for (const hit of hits) {
      for (const s of hit.sources) {
        const versions = await versionsOf(s.platform, s.project_id, [], []);
        for (const v of versions) {
          const where = `${hit.title} ${v.version_number}`;
          switch (hit.resource_type) {
            case "mod":
              expect(v.file_name, where).toMatch(/\.jar$/);
              break;
            case "modpack":
              expect(v.file_name, where).toMatch(s.platform === "modrinth" ? /\.mrpack$/ : /\.zip$/);
              expect(v.loaders.length, where).toBeGreaterThan(0);
              break;
            case "resource_pack":
            case "shader":
            case "data_pack":
              expect(v.file_name, where).toMatch(/\.zip$/);
              expect(v.loaders, where).toEqual([]);
              break;
            case "plugin":
              throw new Error(`目录里不该有插件：${hit.title}`);
          }
          expect(v.file_size, where).not.toBeNull();
          expect(v.game_versions.length, where).toBeGreaterThan(0);
        }
      }
    }
  });

  it("光影要用的 Iris 在目录里：Fabric / Quilt 实例能装，原版与 Forge 实例不能", async () => {
    const matrix = await matchInstances("modrinth", "YL57xq9U", "mod", null);
    const state = (id: string) => matrix.find((m) => m.version_id === id)?.state;
    expect(state("1.21.1-Fabric")).toBe("compatible");
    expect(state("1.20.1-Fabric")).toBe("compatible");
    expect(state("1.21.1")).toBe("incompatible");
    expect(state("1.20.1-Forge")).toBe("incompatible");
  });

  it("资源包、光影、数据包的矩阵只看游戏版本：原版、Fabric、Forge 实例对得上就兼容", async () => {
    const rows = async (projectId: string, type: "resource_pack" | "shader" | "data_pack") =>
      (await matchInstances("modrinth", projectId, type, null)).map((m) => [
        m.version_id,
        m.state,
        m.compatibility,
        m.best_version === null ? null : m.best_version.version_id,
      ]);
    const fits = { kind: "match" };
    const off = (mc: string) => ({ kind: "mismatch", reason: `不支持 MC ${mc}` });
    expect(await rows("faithful-32x", "resource_pack")).toEqual([
      ["1.20.1-Fabric", "compatible", fits, "f32-1201"],
      ["1.20.1-Forge", "compatible", fits, "f32-1201"],
      ["1.21.1", "compatible", fits, "f32-1211"],
      ["1.21.1-Fabric", "compatible", fits, "f32-1211"],
      ["樱花生存", "compatible", fits, "f32-1211"],
      ["1.21", "incompatible", off("1.21"), null],
      ["RLCraft", "incompatible", off("1.12.2"), null],
    ]);
    expect((await rows("HVnmMxH1", "shader")).slice(0, 3)).toEqual([
      ["1.20.1-Fabric", "compatible", fits, "cr-r53"],
      ["1.20.1-Forge", "compatible", fits, "cr-r53"],
      ["1.21.1", "compatible", fits, "cr-r53"],
    ]);
    expect((await rows("8oi3bsk5", "data_pack")).slice(0, 3)).toEqual([
      ["1.20.1-Fabric", "compatible", fits, "tl-243"],
      ["1.20.1-Forge", "compatible", fits, "tl-243"],
      ["1.21.1", "compatible", fits, "tl-254"],
    ]);
  });

  it("同一个版本按 Mod 判仍要加载器对上；整合包没有落位矩阵", async () => {
    const sodium = await matchInstances("modrinth", "AANobbMI", "mod", null);
    expect(sodium.find((m) => m.version_id === "1.20.1-Forge")).toMatchObject({ state: "incompatible" });
    await expect(mockInvoke("match_instances", { platform: "modrinth", projectId: "1KVo5zza", resourceType: "modpack", modVersionId: null })).rejects.toMatchObject({ code: "invalid_argument" });
  });

  it("装 Mod：主项与缺的必需前置一起落进 mods/，卷宗记下来源，之后矩阵判为已安装", async () => {
    const plan = await planInstall("1.21.1-Fabric", "modrinth", "YL57xq9U", "iris-181");
    expect(plan.items.map((i) => [i.version.version_id, i.required_by, i.already_satisfied])).toEqual([
      ["iris-181", null, false],
      ["sodium-121", "YL57xq9U", false],
      ["fapi-0115", "AANobbMI", false],
    ]);
    const outcome = await installMod("t-iris", "1.21.1-Fabric", "modrinth", "YL57xq9U", "iris-181");
    expect(outcome).toEqual({ file_name: "YL57xq9U-1.8.1.jar", path: "C:/Games/.minecraft/versions/1.21.1-Fabric/mods/YL57xq9U-1.8.1.jar", platform: "modrinth" });
    const mods = await listMods("1.21.1-Fabric");
    expect(mods.map((m) => [m.file_name, m.source?.project_id, m.source?.dependency_of])).toEqual([
      ["AANobbMI-0.6.5.jar", "AANobbMI", "YL57xq9U"],
      ["P7dR8mSH-0.115.0.jar", "P7dR8mSH", "AANobbMI"],
      ["YL57xq9U-1.8.1.jar", "YL57xq9U", null],
    ]);
    expect((await listInstances()).find((i) => i.id === "1.21.1-Fabric")?.mod_count).toBe(3);
    const after = await matchInstances("modrinth", "AANobbMI", "mod", null);
    expect(after.find((m) => m.version_id === "1.21.1-Fabric")).toMatchObject({ state: "installed", installed: { file_name: "AANobbMI-0.6.5.jar", version_id: "sodium-121" } });
    // CurseForge 的工程在自己的平台上解析前置
    await installMod("t-cf", "1.20.1-Fabric", "curseforge", "394468", "4957843");
    expect((await listMods("1.20.1-Fabric")).map((m) => m.file_name)).toContain("394468-0.5.3.jar");
  });

  it("资源包、光影、数据包按矩阵给出的版本装进各自目录", async () => {
    const pick = async (platform: "modrinth" | "curseforge", projectId: string, type: "resource_pack" | "shader" | "data_pack", instance: string) => {
      const row = (await matchInstances(platform, projectId, type, null)).find((m) => m.version_id === instance);
      if (row === undefined || row.best_version === null) throw new Error(`${projectId} 在 ${instance} 上没有可装的版本`);
      return row.best_version.version_id;
    };
    const base = { versionId: "1.21.1-Fabric", world: null };
    const rp = await installResource({ ...base, taskId: "t-rp", resourceType: "resource_pack", platform: "modrinth", projectId: "faithful-32x", fileVersionId: await pick("modrinth", "faithful-32x", "resource_pack", "1.21.1-Fabric") });
    expect(rp.path).toBe("D:/Games/.minecraft/versions/1.21.1-Fabric/resourcepacks/faithful-32x-1.21.1-r2.zip");
    const sh = await installResource({ ...base, taskId: "t-sh", resourceType: "shader", platform: "curseforge", projectId: "627557", fileVersionId: await pick("curseforge", "627557", "shader", "1.21.1-Fabric") });
    expect(sh.path).toBe("D:/Games/.minecraft/versions/1.21.1-Fabric/shaderpacks/627557-r5.3.zip");
    const dp = await installResource({
      ...base,
      taskId: "t-dp",
      world: "生存",
      resourceType: "data_pack",
      platform: "modrinth",
      projectId: "8oi3bsk5",
      fileVersionId: await pick("modrinth", "8oi3bsk5", "data_pack", "1.21.1-Fabric"),
    });
    expect(dp.path).toBe("D:/Games/.minecraft/versions/1.21.1-Fabric/saves/生存/datapacks/8oi3bsk5-2.5.4.zip");
  });

  it("装进去的资源包、光影、数据包在落位矩阵里认作已装：数据包带上存档，指定版本时也认得出装着的别的版本", async () => {
    const row = async (platform: "modrinth" | "curseforge", projectId: string, type: "resource_pack" | "shader" | "data_pack", pinned: string | null, instance: string) => {
      const found = (await matchInstances(platform, projectId, type, pinned)).find((m) => m.version_id === instance);
      if (found === undefined) throw new Error(`矩阵里没有 ${instance}`);
      return found;
    };
    expect((await row("modrinth", "faithful-32x", "resource_pack", null, "1.21.1-Fabric")).state).toBe("compatible");

    const base = { versionId: "1.21.1-Fabric", world: null };
    await installResource({ ...base, taskId: "t-rp", resourceType: "resource_pack", platform: "modrinth", projectId: "faithful-32x", fileVersionId: "f32-1211" });
    await installResource({ ...base, taskId: "t-sh", resourceType: "shader", platform: "curseforge", projectId: "627557", fileVersionId: "5701234" });
    await installResource({ ...base, taskId: "t-dp", world: "生存", resourceType: "data_pack", platform: "modrinth", projectId: "8oi3bsk5", fileVersionId: "tl-254" });
    // 旧版装进原版 1.21.1：之后按新版查矩阵，仍要认出装着的旧版。
    await installResource({ versionId: "1.21.1", world: null, taskId: "t-old", resourceType: "resource_pack", platform: "modrinth", projectId: "faithful-32x", fileVersionId: "f32-1201" });

    expect(await row("modrinth", "faithful-32x", "resource_pack", null, "1.21.1-Fabric")).toMatchObject({
      state: "installed",
      installed: { file_name: "faithful-32x-1.21.1-r2.zip", version_id: "f32-1211", version_number: "1.21.1-r2", world: null },
    });
    expect((await row("modrinth", "faithful-32x", "resource_pack", null, "樱花生存")).state).toBe("compatible");
    expect(await row("curseforge", "627557", "shader", null, "1.21.1-Fabric")).toMatchObject({ state: "installed", installed: { version_id: "5701234", world: null } });
    // 同一个光影在另一个平台上是另一个工程，文件名也不同：不算装了它。
    expect((await row("modrinth", "HVnmMxH1", "shader", null, "1.21.1-Fabric")).state).toBe("compatible");
    expect(await row("modrinth", "8oi3bsk5", "data_pack", null, "1.21.1-Fabric")).toMatchObject({
      state: "installed",
      installed: { file_name: "8oi3bsk5-2.5.4.zip", version_id: "tl-254", version_number: "2.5.4", world: "生存" },
    });

    const pinned = await row("modrinth", "faithful-32x", "resource_pack", "f32-1211", "1.21.1");
    expect(pinned).toMatchObject({ state: "installed", installed: { version_id: "f32-1201", version_number: "1.20.1-r5" }, best_version: { version_id: "f32-1211" } });

    // 资源文件在实例目录里：改名跟着走，删掉实例后同名新实例不带着它。
    await renameInstance("1.21.1", "原版二周目");
    expect((await row("modrinth", "faithful-32x", "resource_pack", null, "原版二周目")).installed?.version_id).toBe("f32-1201");
    await deleteInstance("原版二周目");
    addMockInstance("原版二周目", "1.21.1", null, null);
    expect((await row("modrinth", "faithful-32x", "resource_pack", null, "原版二周目")).state).toBe("compatible");
  });

  it("每个平台整合包的最新版本都能读摘要并导入；导入的实例带整合包来源，mods/ 里是清单里的 Mod", async () => {
    const { hits } = await searchResources({ ...ALL, resourceTypes: ["modpack"] });
    expect(hits.map((h) => h.title)).toEqual(["Fabulously Optimized", "Better MC", "RLCraft"]);
    let n = 0;
    for (const hit of hits) {
      for (const s of hit.sources) {
        const [latest] = await versionsOf(s.platform, s.project_id, [], []);
        const summary = await summarizePlatformModpack(s.platform, s.project_id, latest.version_id);
        expect(summary.version).toBe(latest.version_number);
        expect(summary.minecraft).toBe(latest.game_versions[0]);
        n++;
        const name = `导入 ${n}`;
        await installModpack(`t-mp-${n}`, { kind: "platform", platform: s.platform, project_id: s.project_id, version_id: latest.version_id }, name);
        const instance = (await listInstances()).find((i) => i.id === name);
        expect(instance?.modpack).toEqual({ platform: s.platform, project_id: s.project_id, version_id: latest.version_id, name: hit.title, version: latest.version_number });
        expect(instance?.mc_version).toBe(summary.minecraft);
        const mods = await listMods(name);
        expect(instance?.mod_count).toBe(mods.length);
        expect(mods).toHaveLength(summary.mod_files);
      }
    }
    expect(n).toBe(4);
  });
});
