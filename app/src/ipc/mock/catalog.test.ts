// 假后端的工程目录要自洽：发现页搜得到的每个工程都能打开详情、列出版本、判定落位并装进实例，
// 浏览器预览里点开任何一张卡都不会撞上 404。
import { beforeEach, describe, expect, it, vi } from "vitest";
import { installMod, installResource, projectDetail, searchResources, type SearchArgs } from "../discover";
import { listInstances } from "../instances";
import { installModpack, summarizePlatformModpack } from "../modpack";
import { listMods, listModVersions, matchInstances, planInstall } from "../mods";
import { resetMocks } from "./index";
import { clearMockEventListeners } from "./events";

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

describe("工程目录：搜得到就打得开、装得上", () => {
  it("每张卡的每个平台来源：详情、版本列表、落位矩阵都取得到，最新版本与版本列表一致", async () => {
    const { hits } = await searchResources(ALL);
    expect(hits.length).toBe(13);
    const ready = (await readyInstanceIds()).sort();
    for (const hit of hits) {
      for (const s of hit.sources) {
        const where = `${hit.title} @ ${s.platform}`;
        const detail = await projectDetail(s.platform, s.project_id);
        expect(detail.title, where).toBe(hit.title);
        const versions = await listModVersions(s.platform, s.project_id, [], []);
        expect(versions.length, where).toBeGreaterThan(0);
        expect(versions.every((v) => v.platform === s.platform && v.project_id === s.project_id), where).toBe(true);
        expect(detail.latest_version?.version_id, where).toBe(versions[0].version_id);
        const matrix = await matchInstances(s.platform, s.project_id, null);
        expect(matrix.map((m) => m.version_id).sort(), where).toEqual(ready);
      }
    }
  });

  it("文件形态随类型：Mod 是 .jar 且标了加载器；资源包、光影、数据包是 .zip 且不带加载器；整合包分平台", async () => {
    const { hits } = await searchResources(ALL);
    for (const hit of hits) {
      for (const s of hit.sources) {
        const versions = await listModVersions(s.platform, s.project_id, [], []);
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
    const matrix = await matchInstances("modrinth", "YL57xq9U", null);
    const state = (id: string) => matrix.find((m) => m.version_id === id)?.state;
    expect(state("1.21.1-Fabric")).toBe("compatible");
    expect(state("1.20.1-Fabric")).toBe("compatible");
    expect(state("1.21.1")).toBe("incompatible");
    expect(state("1.20.1-Forge")).toBe("incompatible");
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
    const after = await matchInstances("modrinth", "AANobbMI", null);
    expect(after.find((m) => m.version_id === "1.21.1-Fabric")).toMatchObject({ state: "installed", installed: { file_name: "AANobbMI-0.6.5.jar", version_id: "sodium-121" } });
    // CurseForge 的工程在自己的平台上解析前置
    await installMod("t-cf", "1.20.1-Fabric", "curseforge", "394468", "4957843");
    expect((await listMods("1.20.1-Fabric")).map((m) => m.file_name)).toContain("394468-0.5.3.jar");
  });

  it("资源包、光影、数据包按矩阵给出的版本装进各自目录", async () => {
    const pick = async (platform: "modrinth" | "curseforge", projectId: string, instance: string) => {
      const row = (await matchInstances(platform, projectId, null)).find((m) => m.version_id === instance);
      if (row === undefined || row.best_version === null) throw new Error(`${projectId} 在 ${instance} 上没有可装的版本`);
      return row.best_version.version_id;
    };
    const base = { versionId: "1.21.1-Fabric", world: null };
    const rp = await installResource({ ...base, taskId: "t-rp", resourceType: "resource_pack", platform: "modrinth", projectId: "faithful-32x", fileVersionId: await pick("modrinth", "faithful-32x", "1.21.1-Fabric") });
    expect(rp.path).toBe("D:/Games/.minecraft/versions/1.21.1-Fabric/resourcepacks/faithful-32x-1.21.1-r2.zip");
    const sh = await installResource({ ...base, taskId: "t-sh", resourceType: "shader", platform: "curseforge", projectId: "627557", fileVersionId: await pick("curseforge", "627557", "1.21.1-Fabric") });
    expect(sh.path).toBe("D:/Games/.minecraft/versions/1.21.1-Fabric/shaderpacks/627557-r5.3.zip");
    const dp = await installResource({
      ...base,
      taskId: "t-dp",
      world: "生存",
      resourceType: "data_pack",
      platform: "modrinth",
      projectId: "8oi3bsk5",
      fileVersionId: await pick("modrinth", "8oi3bsk5", "1.21.1-Fabric"),
    });
    expect(dp.path).toBe("D:/Games/.minecraft/versions/1.21.1-Fabric/saves/生存/datapacks/8oi3bsk5-2.5.4.zip");
  });

  it("每个平台整合包的最新版本都能读摘要并导入；导入的实例带整合包来源，mods/ 里是清单里的 Mod", async () => {
    const { hits } = await searchResources({ ...ALL, resourceTypes: ["modpack"] });
    expect(hits.map((h) => h.title)).toEqual(["Fabulously Optimized", "Better MC", "RLCraft"]);
    let n = 0;
    for (const hit of hits) {
      for (const s of hit.sources) {
        const [latest] = await listModVersions(s.platform, s.project_id, [], []);
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
        if (summary.mod_files !== null) expect(mods).toHaveLength(summary.mod_files);
        else expect(mods.length).toBeGreaterThan(0);
      }
    }
    expect(n).toBe(4);
  });
});
