// 发现页的假后端：一份覆盖五种可搜类型、两个平台（含双平台合并卡与只在单个平台上的工程）的小目录。
// 参数按后端同样的规则校验（任一项非法整体报 invalid_argument），筛选、排序、翻页语义与后端一致；
// 安装类长任务登记任务、推送带 task_id 的进度事件并响应取消。

import type {
  DiscoverableType,
  InstallableResourceType,
  ModInstallOutcomeDto,
  PlatformId,
  ProjectDetail,
  ResourceInstallOutcomeDto,
  ResourceType,
  SearchCursor,
  SearchEntry,
  SearchResultDto,
  SkippedPlatform,
  SortField,
} from "../../discover";
import { IpcError } from "../../errors";
import type { ModLoader } from "../../mods";
import { CORE_EVENT, type CoreEvent } from "../../tasks";
import { emitMockEvent } from "../events";
import type { MockArgs, MockHandlers } from "../types";
import { mockInstanceWorlds } from "./instances";
import { beginMockTask, endMockTask, isMockTaskCancelled } from "./tasks";

/** 假游戏目录；只用来拼返回给界面的路径。 */
export const MOCK_GAME_DIR = "D:/Games/.minecraft";

const MAX_SEARCH_LIMIT = 50;
const PLATFORMS: readonly PlatformId[] = ["modrinth", "curseforge"];
const RESOURCE_TYPES: readonly ResourceType[] = ["mod", "modpack", "resource_pack", "shader", "data_pack", "plugin"];
const DISCOVERABLE: readonly DiscoverableType[] = ["mod", "modpack", "resource_pack", "shader", "data_pack"];
const LOADERS: readonly ModLoader[] = ["fabric", "quilt", "forge", "neoforge", "liteloader"];
const SORTS: readonly SortField[] = ["relevance", "downloads", "follows", "newest", "updated"];
const CATEGORY_KEY = /^[a-z0-9-]{1,64}$/;
/** 已有存档的实例（数据包只能装进存在的存档）。 */

export interface CatalogueItem {
  entry: SearchEntry;
  /** 搜索卡里没有游戏版本与发布日期，按版本筛选与「最新」排序要用。 */
  gameVersions: string[];
  datePublished: string;
  body: string;
}

function source(platform: PlatformId, project_id: string, slug: string | null, downloads: number, follows: number | null) {
  const page_url =
    platform === "modrinth" ? `https://modrinth.com/project/${slug ?? project_id}` : `https://www.curseforge.com/minecraft/${slug ?? project_id}`;
  return { platform, project_id, slug, page_url, downloads, follows };
}

function item(
  base: Omit<SearchEntry, "downloads" | "follows" | "platform" | "project_id" | "slug" | "page_url" | "sources">,
  sources: ReturnType<typeof source>[],
  gameVersions: string[],
  datePublished: string,
): CatalogueItem {
  const primary = sources[0];
  const follows = sources.every((s) => s.follows === null) ? null : sources.reduce((sum, s) => sum + (s.follows === null ? 0 : s.follows), 0);
  return {
    entry: {
      ...base,
      platform: primary.platform,
      project_id: primary.project_id,
      slug: primary.slug,
      page_url: primary.page_url,
      downloads: sources.reduce((sum, s) => sum + s.downloads, 0),
      follows,
      sources,
    },
    gameVersions,
    datePublished,
    body: `## ${base.title}\n\n${base.description}`,
  };
}

function seedCatalogue(): CatalogueItem[] {
  return [
    item(
      {
        title: "Sodium",
        description: "现代渲染引擎，大幅提升帧率",
        author: "jellysquid3",
        icon_url: null,
        gallery_url: null,
        hue: 145,
        categories: ["optimization"],
        loaders: ["fabric", "quilt", "neoforge"],
        resource_type: "mod",
        date_modified: "2026-10-12T08:00:00Z",
      },
      [source("modrinth", "AANobbMI", "sodium", 98_000_000, 26_000), source("curseforge", "394468", "sodium", 41_000_000, null)],
      ["1.21.1", "1.20.1"],
      "2020-11-01T00:00:00Z",
    ),
    item(
      {
        title: "Create",
        description: "齿轮、传送带与动力装置",
        author: "simibubi",
        icon_url: null,
        gallery_url: null,
        hue: 32,
        categories: ["technology", "decoration"],
        loaders: ["forge", "neoforge", "fabric"],
        resource_type: "mod",
        date_modified: "2026-09-30T12:00:00Z",
      },
      [source("modrinth", "LNytGWDc", "create", 12_000_000, 9_000)],
      ["1.21.1", "1.20.1"],
      "2021-01-18T00:00:00Z",
    ),
    item(
      {
        title: "Just Enough Items",
        description: "物品与合成配方查看",
        author: "mezz",
        icon_url: null,
        gallery_url: null,
        hue: null,
        categories: ["utility"],
        loaders: ["forge", "neoforge"],
        resource_type: "mod",
        date_modified: "2026-10-20T00:00:00Z",
      },
      [source("curseforge", "238222", "jei", 380_000_000, null)],
      ["1.21.1", "1.20.1"],
      "2015-11-24T00:00:00Z",
    ),
    item(
      {
        title: "Fabulously Optimized",
        description: "开箱即用的性能整合包",
        author: "robotkoer",
        icon_url: null,
        gallery_url: null,
        hue: 210,
        categories: ["optimization", "lightweight"],
        loaders: ["fabric"],
        resource_type: "modpack",
        date_modified: "2026-10-25T00:00:00Z",
      },
      [source("modrinth", "1KVo5zza", "fabulously-optimized", 7_400_000, 3_100), source("curseforge", "396246", "fabulously-optimized", 5_100_000, null)],
      ["1.21.1"],
      "2021-06-02T00:00:00Z",
    ),
    item(
      {
        title: "Better MC",
        description: "冒险向大型整合包",
        author: "Luna Pixel Studios",
        icon_url: null,
        gallery_url: null,
        hue: null,
        categories: ["adventure", "quests"],
        loaders: ["fabric"],
        resource_type: "modpack",
        date_modified: "2026-08-14T00:00:00Z",
      },
      [source("curseforge", "452013", "better-mc-fabric-bmc1", 9_800_000, null)],
      ["1.20.1"],
      "2021-03-15T00:00:00Z",
    ),
    item(
      {
        title: "Faithful 32x",
        description: "忠于原版风格的高清材质",
        author: "Faithful Resource Pack",
        icon_url: null,
        gallery_url: null,
        hue: 95,
        categories: ["vanilla-like"],
        loaders: [],
        resource_type: "resource_pack",
        date_modified: "2026-07-01T00:00:00Z",
      },
      [source("modrinth", "faithful-32x", "faithful-32x", 2_300_000, 1_800)],
      ["1.21.1", "1.20.1"],
      "2022-02-01T00:00:00Z",
    ),
    item(
      {
        title: "Complementary Shaders - Reimagined",
        description: "兼顾性能与观感的光影",
        author: "EminGT",
        icon_url: null,
        gallery_url: null,
        hue: 260,
        categories: ["realistic"],
        loaders: [],
        resource_type: "shader",
        date_modified: "2026-10-01T00:00:00Z",
      },
      [source("modrinth", "HVnmMxH1", "complementary-reimagined", 9_100_000, 4_200), source("curseforge", "627557", "complementary-reimagined", 6_300_000, null)],
      ["1.21.1", "1.20.1"],
      "2023-01-09T00:00:00Z",
    ),
    item(
      {
        title: "Terralith",
        description: "近百种新生物群系的地形生成",
        author: "Stardust Labs",
        icon_url: null,
        gallery_url: null,
        hue: 120,
        categories: ["worldgen", "adventure"],
        loaders: [],
        resource_type: "data_pack",
        date_modified: "2026-06-20T00:00:00Z",
      },
      [source("modrinth", "8oi3bsk5", "terralith", 5_500_000, 2_400)],
      ["1.21.1"],
      "2021-10-30T00:00:00Z",
    ),
  ];
}

let catalogue: CatalogueItem[] = seedCatalogue();

/** 给整合包 mock 查平台整合包用。 */
export function findCatalogueItem(platform: PlatformId, projectId: string): CatalogueItem | undefined {
  return catalogue.find((c) => c.entry.sources.some((s) => s.platform === platform && s.project_id === projectId));
}

function invalid(message: string): IpcError {
  return new IpcError("invalid_argument", message);
}

/**
 * 按形参类型取参数。缺参数或类型不对在真机上是 Tauri 自己的反序列化错误，到前端是纯字符串、
 * 归一为 unknown；mock 照样报 unknown，界面不会在假后端下拿到一个真机上不存在的错误码。
 */
export function argReader(cmd: string, args: MockArgs) {
  const fail = (key: string, expected: string) =>
    new IpcError("unknown", `invalid args \`${key}\` for command \`${cmd}\`: expected ${expected}`);
  return {
    string(key: string): string {
      const value = args[key];
      if (typeof value !== "string") throw fail(key, "a string");
      return value;
    },
    nullableString(key: string): string | null {
      const value = args[key];
      if (value === null || value === undefined) return null;
      if (typeof value !== "string") throw fail(key, "a string or null");
      return value;
    },
    strings(key: string): string[] {
      const value = args[key];
      if (!Array.isArray(value) || value.some((v) => typeof v !== "string")) throw fail(key, "a sequence of strings");
      return value as string[];
    },
    integer(key: string): number {
      const value = args[key];
      if (typeof value !== "number" || !Number.isInteger(value) || value < 0) throw fail(key, "u32");
      return value;
    },
  };
}

function parseOne<T extends string>(allowed: readonly T[], raw: string, message: string): T {
  if (!(allowed as readonly string[]).includes(raw)) throw invalid(message);
  return raw as T;
}

export function parsePlatform(raw: string): PlatformId {
  return parseOne(PLATFORMS, raw, `未知资源平台 ${raw}（支持 modrinth/curseforge）`);
}

function parseCursor(raw: unknown): SearchCursor | null {
  if (raw === null || raw === undefined) return null;
  const side = (value: unknown) =>
    typeof value === "object" && value !== null && typeof (value as Record<string, unknown>).offset === "number";
  const cursor = raw as Record<string, unknown>;
  if (typeof raw !== "object" || !side(cursor.modrinth) || !side(cursor.curseforge)) {
    throw invalid(`翻页游标不合法：${JSON.stringify(raw)}`);
  }
  return raw as SearchCursor;
}

function compareDesc(a: number | null, b: number | null): number {
  if (a === b) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return b - a;
}

function sortItems(items: CatalogueItem[], sort: SortField): CatalogueItem[] {
  const sorted = [...items];
  switch (sort) {
    case "relevance":
      return sorted;
    case "downloads":
      return sorted.sort((a, b) => compareDesc(a.entry.downloads, b.entry.downloads));
    case "follows":
      return sorted.sort((a, b) => compareDesc(a.entry.follows, b.entry.follows));
    case "newest":
      return sorted.sort((a, b) => b.datePublished.localeCompare(a.datePublished));
    case "updated": {
      // 没有更新时间的排在最后。
      const modified = (c: CatalogueItem) => (c.entry.date_modified === null ? "" : c.entry.date_modified);
      return sorted.sort((a, b) => modified(b).localeCompare(modified(a)));
    }
  }
}

function searchResources(args: MockArgs): SearchResultDto {
  const read = argReader("search_resources", args);
  const limit = read.integer("limit");
  if (limit < 1 || limit > MAX_SEARCH_LIMIT) throw invalid(`每页条数须在 1 到 ${MAX_SEARCH_LIMIT} 之间，收到 ${limit}`);
  const category = read.nullableString("category");
  if (category !== null && !CATEGORY_KEY.test(category)) throw invalid(`分类键不合法：${category}`);
  const gameVersions = read.strings("gameVersions").map((v) => v.trim());
  if (gameVersions.some((v) => v === "" || /\p{Cc}/u.test(v))) throw invalid("游戏版本不能为空或含控制字符");
  const cursor = parseCursor(args.cursor);
  const rawQuery = read.nullableString("query");
  const query = rawQuery === null ? "" : rawQuery.trim().toLowerCase();
  const types = read.strings("resourceTypes").map((t) => parseOne(RESOURCE_TYPES, t, `未知资源类型 ${t}`));
  const loaders = read.strings("loaders").map((l) => parseOne(LOADERS, l, `未知加载器 ${l}`));
  const rawSort = read.string("sort");
  const sort = parseOne(SORTS, rawSort, `未知排序字段 ${rawSort}`);
  const rawPlatform = read.nullableString("platform");
  const only = rawPlatform === null ? null : parsePlatform(rawPlatform);

  const wanted: readonly ResourceType[] = types.length === 0 ? DISCOVERABLE : types;
  const matched = catalogue.filter(({ entry, gameVersions: versions }) => {
    if (!wanted.includes(entry.resource_type)) return false;
    if (category !== null && !entry.categories.includes(category)) return false;
    if (only !== null && !entry.sources.some((s) => s.platform === only)) return false;
    if (loaders.length > 0 && !entry.loaders.some((l) => loaders.includes(l))) return false;
    if (gameVersions.length > 0 && !versions.some((v) => gameVersions.includes(v))) return false;
    if (query !== "" && !`${entry.title} ${entry.description}`.toLowerCase().includes(query)) return false;
    return true;
  });
  const sorted = sortItems(matched, sort);
  const offset = cursor === null ? 0 : cursor.modrinth.offset;
  const page = sorted.slice(offset, offset + limit);
  const nextOffset = offset + page.length;
  const exhausted = nextOffset >= sorted.length;
  const side = { offset: nextOffset, exhausted, total: sorted.length, absorbed: [] };
  const skipped: SkippedPlatform[] = only === null ? [] : PLATFORMS.filter((p) => p !== only).map((platform) => ({ platform, reason: "filtered" }));
  return {
    hits: page.map((c) => c.entry),
    total: sorted.length,
    errors: [],
    skipped,
    next_cursor: exhausted ? null : { modrinth: side, curseforge: { ...side, absorbed: [] } },
  };
}

function projectDetail(args: MockArgs): ProjectDetail {
  const read = argReader("project_detail", args);
  const platform = parsePlatform(read.string("platform"));
  const projectId = read.string("projectId");
  const found = findCatalogueItem(platform, projectId);
  if (!found) throw new IpcError("mod_platform_failed", `${platform} 返回 404：工程 ${projectId} 不存在`);
  const { entry } = found;
  const own = entry.sources.find((s) => s.platform === platform);
  if (!own) throw new Error("findCatalogueItem 返回了不含该平台的条目");
  const fileName = `${own.slug === null ? own.project_id : own.slug}-1.0.0.${entry.resource_type === "mod" ? "jar" : "zip"}`;
  return {
    platform,
    project_id: own.project_id,
    slug: own.slug,
    title: entry.title,
    summary: entry.description,
    body: platform === "modrinth" ? found.body : `<h2>${entry.title}</h2><p>${entry.description}</p>`,
    body_format: platform === "modrinth" ? "markdown" : "html",
    author: entry.author,
    downloads: own.downloads,
    follows: own.follows,
    icon_url: entry.icon_url,
    gallery: [],
    hue: entry.hue,
    categories: entry.categories,
    resource_type: entry.resource_type,
    loaders: entry.loaders,
    game_versions: found.gameVersions,
    date_published: found.datePublished,
    date_modified: entry.date_modified,
    page_url: own.page_url,
    source_url: null,
    issues_url: null,
    wiki_url: null,
    latest_version: {
      version_id: `${own.project_id}-latest`,
      project_id: own.project_id,
      platform,
      name: `${entry.title} 最新版`,
      version_number: "1.0.0",
      release_channel: "release",
      game_versions: found.gameVersions,
      loaders: entry.loaders,
      file_name: fileName,
      file_size: 1_048_576,
      sha1: null,
      download_url:
        platform === "modrinth"
          ? `https://cdn.modrinth.com/data/${own.project_id}/${fileName}`
          : `https://edge.forgecdn.net/files/1/2/${fileName}`,
      date_published: entry.date_modified === null ? found.datePublished : entry.date_modified,
      dependencies: [],
    },
    dependencies: [],
    distribution_allowed: true,
  };
}

/** 推送一条后端进度事件；按 CoreEvent 定型，负载形状写错在编译期就报出来。 */
export function emitCoreEvent(event: CoreEvent): void {
  emitMockEvent(CORE_EVENT, event);
}

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 15));

/**
 * 模拟一次下载：阶段事件 + 四次进度快照，每步之间检查取消。
 * 被取消时以 IpcError("cancelled") 拒绝，与后端在取消后的返回一致。
 */
export async function simulateDownload(taskId: string, label: string, totalBytes: number): Promise<void> {
  emitCoreEvent({ task_id: taskId, kind: "stage", message: `开始下载 ${label}` });
  for (let step = 0; step <= 4; step++) {
    if (isMockTaskCancelled(taskId)) throw new IpcError("cancelled", "已取消");
    const bytes = Math.round((totalBytes * step) / 4);
    emitCoreEvent({
      task_id: taskId,
      kind: "download",
      total: 1,
      finished: step === 4 ? 1 : 0,
      bytes,
      total_bytes: totalBytes,
      speed: step === 0 ? 0 : 2_097_152,
    });
    if (step < 4) await tick();
  }
}

/** 登记任务、跑主体、无论结果如何都注销，与后端 TaskHandle 的生命周期一致。 */
export async function runMockTask<T>(taskId: string, work: () => Promise<T>): Promise<T> {
  beginMockTask(taskId);
  try {
    if (isMockTaskCancelled(taskId)) throw new IpcError("cancelled", "已取消");
    return await work();
  } finally {
    endMockTask(taskId);
  }
}

function fileNameFor(platform: PlatformId, projectId: string, fileVersionId: string, extension: string): string {
  const found = findCatalogueItem(platform, projectId);
  const own = found?.entry.sources.find((s) => s.platform === platform);
  const stem = own === undefined || own.slug === null ? projectId : own.slug;
  return `${stem}-${fileVersionId}.${extension}`;
}

function installMod(args: MockArgs): Promise<ModInstallOutcomeDto> {
  const read = argReader("install_mod", args);
  const taskId = read.string("taskId");
  const versionId = read.string("versionId");
  const platform = parsePlatform(read.string("platform"));
  const projectId = read.string("projectId");
  const modVersionId = read.string("modVersionId");
  return runMockTask(taskId, async () => {
    requireInstalled(versionId);
    const file_name = fileNameFor(platform, projectId, modVersionId, "jar");
    await simulateDownload(taskId, file_name, 1_048_576);
    return { file_name, path: `${MOCK_GAME_DIR}/versions/${versionId}/mods/${file_name}`, platform };
  });
}

/** 实例以实例 mock 为准：不存在或损坏报 version_not_installed，与后端解析工作目录时一致；返回它的存档目录名。 */
function requireInstalled(versionId: string): string[] {
  const worlds = mockInstanceWorlds(versionId);
  if (worlds === null) throw new IpcError("version_not_installed", `本地未安装版本 ${versionId}`, { id: versionId });
  return worlds;
}

const RESOURCE_DIRS: Record<InstallableResourceType, string> = {
  mod: "mods",
  resource_pack: "resourcepacks",
  shader: "shaderpacks",
  data_pack: "datapacks",
};

function installResource(args: MockArgs): Promise<ResourceInstallOutcomeDto> {
  const read = argReader("install_resource", args);
  const taskId = read.string("taskId");
  const versionId = read.string("versionId");
  const rawType = read.string("resourceType");
  const resourceType = parseOne(RESOURCE_TYPES, rawType, `未知资源类型 ${rawType}`);
  if (resourceType === "modpack" || resourceType === "plugin") throw invalid(`${rawType} 不能作为单个资源装进实例`);
  const world = read.nullableString("world");
  const platform = parsePlatform(read.string("platform"));
  const projectId = read.string("projectId");
  const fileVersionId = read.string("fileVersionId");
  return runMockTask(taskId, async () => {
    if (resourceType === "data_pack" && world === null) throw invalid("安装目标不对：数据包要指明装进哪个存档");
    if (resourceType !== "data_pack" && world !== null) throw invalid("安装目标不对：只有数据包需要指定存档");
    const worlds = requireInstalled(versionId);
    if (world !== null && !worlds.includes(world)) {
      throw new IpcError("world_not_found", `实例 ${versionId} 里没有存档 ${world}`, { version_id: versionId, world });
    }
    const file_name = fileNameFor(platform, projectId, fileVersionId, resourceType === "mod" ? "jar" : "zip");
    await simulateDownload(taskId, file_name, 4_194_304);
    const dir = world === null ? RESOURCE_DIRS[resourceType] : `saves/${world}/${RESOURCE_DIRS[resourceType]}`;
    return {
      file_name,
      path: `${MOCK_GAME_DIR}/versions/${versionId}/${dir}/${file_name}`,
      platform,
      resource_type: resourceType,
      world,
    };
  });
}

export const handlers: MockHandlers = {
  search_resources: searchResources,
  project_detail: projectDetail,
  install_mod: installMod,
  install_resource: installResource,
};

export function reset(): void {
  catalogue = seedCatalogue();
}
