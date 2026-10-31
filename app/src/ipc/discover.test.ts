import { invoke as tauriInvoke } from "@tauri-apps/api/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installResource, projectDetail, searchResources, type SearchArgs } from "./discover";
import { IpcError } from "./errors";
import { resetMocks } from "./mock";
import { clearMockEventListeners } from "./mock/events";
import { CORE_EVENT, cancelTask, type CoreEvent } from "./tasks";
import { listen } from "./bridge";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));

const base: SearchArgs = {
  query: null,
  resourceTypes: [],
  category: null,
  platform: null,
  loaders: [],
  gameVersions: [],
  sort: "relevance",
  limit: 20,
  cursor: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  resetMocks();
  clearMockEventListeners();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Tauri 里参数键与 Rust 形参一致", () => {
  beforeEach(() => {
    vi.stubGlobal("window", { __TAURI_INTERNALS__: {} });
  });

  it("搜索、详情、装资源三条命令的参数原样传出", async () => {
    for (let i = 0; i < 3; i++) vi.mocked(tauriInvoke).mockResolvedValueOnce(null);
    await searchResources({ ...base, resourceTypes: ["shader"], category: "realistic", platform: "modrinth" });
    await projectDetail("curseforge", "238222");
    await installResource({
      taskId: "t-rp",
      versionId: "生存",
      resourceType: "data_pack",
      world: "新的世界",
      platform: "modrinth",
      projectId: "8oi3bsk5",
      fileVersionId: "v1",
    });
    expect(vi.mocked(tauriInvoke).mock.calls).toEqual([
      [
        "search_resources",
        {
          query: null,
          resourceTypes: ["shader"],
          category: "realistic",
          platform: "modrinth",
          loaders: [],
          gameVersions: [],
          sort: "relevance",
          limit: 20,
          cursor: null,
        },
      ],
      ["project_detail", { platform: "curseforge", projectId: "238222" }],
      [
        "install_resource",
        { taskId: "t-rp", versionId: "生存", resourceType: "data_pack", world: "新的世界", platform: "modrinth", projectId: "8oi3bsk5", fileVersionId: "v1" },
      ],
    ]);
  });
});

describe("发现 mock", () => {
  it("类型留空即全部可搜类型；合并卡下载量为两个平台之和并列出两个来源", async () => {
    const all = await searchResources(base);
    expect(new Set(all.hits.map((h) => h.resource_type))).toEqual(new Set(["mod", "modpack", "resource_pack", "shader", "data_pack"]));
    expect(all.total).toBe(all.hits.length);
    expect(all.next_cursor).toBeNull();
    const sodium = all.hits.find((h) => h.title === "Sodium");
    expect(sodium?.downloads).toBe(98_000_000 + 41_000_000);
    expect(sodium?.sources.map((s) => s.platform)).toEqual(["modrinth", "curseforge"]);
    expect(sodium?.platform).toBe("modrinth");
  });

  it("按类型、分类、平台与加载器筛选；只搜一个平台时另一个平台记为 filtered", async () => {
    const shaders = await searchResources({ ...base, resourceTypes: ["shader", "resource_pack"] });
    expect(shaders.hits.map((h) => h.title)).toEqual(["Faithful 32x", "Complementary Shaders - Reimagined"]);

    const optimization = await searchResources({ ...base, category: "optimization" });
    expect(optimization.hits.map((h) => h.title)).toEqual(["Sodium", "Fabulously Optimized"]);

    const curseforge = await searchResources({ ...base, resourceTypes: ["mod"], platform: "curseforge" });
    expect(curseforge.hits.map((h) => h.title)).toEqual(["Sodium", "Just Enough Items"]);
    expect(curseforge.skipped).toEqual([{ platform: "modrinth", reason: "filtered" }]);

    const forge = await searchResources({ ...base, loaders: ["forge"] });
    expect(forge.hits.map((h) => h.title)).toEqual(["Create", "Just Enough Items"]);

    const keyword = await searchResources({ ...base, query: "  光影 " });
    expect(keyword.hits.map((h) => h.title)).toEqual(["Complementary Shaders - Reimagined"]);
  });

  it("按下载量降序；翻页游标原样回传直到 null", async () => {
    const first = await searchResources({ ...base, sort: "downloads", limit: 3 });
    const downloads = first.hits.map((h) => h.downloads);
    expect(downloads).toEqual([...downloads].sort((a, b) => b - a));
    expect(first.next_cursor).not.toBeNull();
    const seen = [...first.hits];
    let cursor = first.next_cursor;
    while (cursor !== null) {
      const page = await searchResources({ ...base, sort: "downloads", limit: 3, cursor });
      seen.push(...page.hits);
      cursor = page.next_cursor;
    }
    expect(seen).toHaveLength(first.total);
    expect(new Set(seen.map((h) => h.project_id)).size).toBe(first.total);
  });

  it("非法参数与后端一样整体报 invalid_argument", async () => {
    for (const bad of [
      { ...base, limit: 0 },
      { ...base, limit: 51 },
      { ...base, category: "Optimization" },
      { ...base, category: "a b" },
      { ...base, gameVersions: [" "] },
      { ...base, resourceTypes: ["world" as never] },
      { ...base, platform: "curse_forge" as never },
      { ...base, sort: "hot" as never },
    ]) {
      const error = await searchResources(bad).catch((e: unknown) => e);
      expect(error, JSON.stringify(bad)).toBeInstanceOf(IpcError);
      expect((error as IpcError).code).toBe("invalid_argument");
    }
    const missing = await searchResources({ ...base, limit: undefined as never }).catch((e: unknown) => e);
    expect(missing).toMatchObject({ code: "unknown" });
  });

  it("详情按平台取各自那份数据；不存在的工程报 mod_platform_failed", async () => {
    const modrinth = await projectDetail("modrinth", "AANobbMI");
    expect(modrinth).toMatchObject({ title: "Sodium", body_format: "markdown", downloads: 98_000_000, distribution_allowed: true });
    const curseforge = await projectDetail("curseforge", "394468");
    expect(curseforge).toMatchObject({ project_id: "394468", body_format: "html", downloads: 41_000_000, follows: null });
    const missing = await projectDetail("modrinth", "nope").catch((e: unknown) => e);
    expect(missing).toMatchObject({ code: "mod_platform_failed" });
  });

  it("资源落进各自目录，数据包进指定存档；事件都带本任务 id", async () => {
    const events: CoreEvent[] = [];
    const off = await listen<CoreEvent>(CORE_EVENT, (e) => events.push(e));
    const shader = await installResource({
      taskId: "t-sh",
      versionId: "1.21.1-Fabric",
      resourceType: "shader",
      world: null,
      platform: "modrinth",
      projectId: "HVnmMxH1",
      fileVersionId: "v9",
    });
    expect(shader).toEqual({
      file_name: "complementary-reimagined-v9.zip",
      path: "D:/Games/.minecraft/versions/1.21.1-Fabric/shaderpacks/complementary-reimagined-v9.zip",
      platform: "modrinth",
      resource_type: "shader",
      world: null,
    });
    const datapack = await installResource({
      taskId: "t-dp",
      versionId: "1.21.1-Fabric",
      resourceType: "data_pack",
      world: "新的世界",
      platform: "modrinth",
      projectId: "8oi3bsk5",
      fileVersionId: "v2",
    });
    expect(datapack.path).toBe("D:/Games/.minecraft/versions/1.21.1-Fabric/saves/新的世界/datapacks/terralith-v2.zip");
    expect(datapack.world).toBe("新的世界");
    off();
    expect(events.length).toBeGreaterThan(0);
    expect(new Set(events.map((e) => e.task_id))).toEqual(new Set(["t-sh", "t-dp"]));
    const last = events.filter((e) => e.kind === "download" && e.task_id === "t-sh").pop();
    expect(last).toMatchObject({ finished: 1, bytes: 4_194_304, total_bytes: 4_194_304 });
  });

  it("安装目标不成立时报对应的码", async () => {
    const args = { taskId: "t", versionId: "1.21.1-Fabric", platform: "modrinth" as const, projectId: "8oi3bsk5", fileVersionId: "v" };
    const noWorld = await installResource({ ...args, resourceType: "data_pack", world: null }).catch((e: unknown) => e);
    expect(noWorld).toMatchObject({ code: "invalid_argument" });
    const strayWorld = await installResource({ ...args, resourceType: "shader", world: "生存" }).catch((e: unknown) => e);
    expect(strayWorld).toMatchObject({ code: "invalid_argument" });
    const unknownWorld = await installResource({ ...args, resourceType: "data_pack", world: "不存在" }).catch((e: unknown) => e);
    expect(unknownWorld).toMatchObject({ code: "world_not_found", detail: { version_id: "1.21.1-Fabric", world: "不存在" } });
    const modpack = await installResource({ ...args, resourceType: "modpack" as never, world: null }).catch((e: unknown) => e);
    expect(modpack).toMatchObject({ code: "invalid_argument" });
  });

  it("下载途中取消以 cancelled 结束，任务随之注销", async () => {
    const args = {
      taskId: "t-cancel",
      versionId: "1.21.1-Fabric",
      resourceType: "resource_pack" as const,
      world: null,
      platform: "modrinth" as const,
      projectId: "faithful-32x",
      fileVersionId: "v1",
    };
    const running = installResource(args).catch((e: unknown) => e);
    expect(await cancelTask("t-cancel")).toBe(true);
    expect(await running).toMatchObject({ code: "cancelled" });
    expect(await cancelTask("t-cancel")).toBe(false);
    expect((await installResource({ ...args, taskId: "t-retry" })).file_name).toBe("faithful-32x-v1.zip");
  });
});
