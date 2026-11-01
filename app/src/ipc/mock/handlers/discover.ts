// 发现页的假后端：搜索与详情读共用的工程目录（ipc/mock/catalog），五种可搜类型、两个平台（含双平台合并卡与只在
// 单个平台上的工程）都在里面。参数按后端同样的规则校验（任一项非法整体报 invalid_argument），筛选、排序、翻页语义
// 与后端一致；装资源包、光影、数据包的长任务登记任务、推送带 task_id 的进度事件并响应取消。Mod 走 install_mod，
// 在 handlers/mods 里，与实例的 Mod 状态放在一起。

import type {
  DependencyProject,
  DiscoverableType,
  HitSource,
  InstallableResourceType,
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
import { findMockSource, findMockVersion, mockProjects, newestFirst, sourceVersions, sourcesGameVersions, sourcesLoaders, type MockProject, type MockSource } from "../catalog";
import { emitMockEvent } from "../events";
import type { MockArgs, MockHandlers, MockPersist } from "../types";
import { acquireMockInstance, ensureMockSavesFreeForWriting, markMockSavesWritten, mockInstanceWorlds, recordMockPack } from "./instances";
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

function pageUrl(platform: PlatformId, slug: string): string {
  return platform === "modrinth" ? `https://modrinth.com/project/${slug}` : `https://www.curseforge.com/minecraft/${slug}`;
}

function hitSource(s: MockSource): HitSource {
  return { platform: s.platform, project_id: s.projectId, slug: s.slug, page_url: pageUrl(s.platform, s.slug), downloads: s.downloads, follows: s.follows };
}

/** 一张搜索卡：顶层取主来源，下载量与关注数是各平台之和（都没给关注数时为 null）。 */
function searchEntry(project: MockProject): SearchEntry {
  const primary = project.sources[0];
  const follows = project.sources.every((s) => s.follows === null) ? null : project.sources.reduce((sum, s) => sum + (s.follows === null ? 0 : s.follows), 0);
  return {
    platform: primary.platform,
    project_id: primary.projectId,
    slug: primary.slug,
    title: project.title,
    description: project.description,
    author: project.author,
    downloads: project.sources.reduce((sum, s) => sum + s.downloads, 0),
    follows,
    icon_url: null,
    gallery_url: null,
    hue: project.hue,
    categories: project.categories,
    loaders: sourcesLoaders(project.sources),
    resource_type: project.resourceType,
    date_modified: project.dateModified,
    page_url: pageUrl(primary.platform, primary.slug),
    sources: project.sources.map(hitSource),
  };
}

function invalid(message: string): IpcError {
  return new IpcError("invalid_argument", message);
}

const U32_MAX = 4_294_967_295;

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
    /** Option<u32>：缺省与 null 都是 None。 */
    nullableInteger(key: string): number | null {
      const value = args[key];
      if (value === null || value === undefined) return null;
      if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > U32_MAX) throw fail(key, "u32");
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

function sortItems(items: SearchEntry[], sort: SortField, published: (e: SearchEntry) => string): SearchEntry[] {
  const sorted = [...items];
  switch (sort) {
    case "relevance":
      return sorted;
    case "downloads":
      return sorted.sort((a, b) => compareDesc(a.downloads, b.downloads));
    case "follows":
      return sorted.sort((a, b) => compareDesc(a.follows, b.follows));
    case "newest":
      return sorted.sort((a, b) => published(b).localeCompare(published(a)));
    case "updated": {
      // 没有更新时间的排在最后。
      const modified = (e: SearchEntry) => (e.date_modified === null ? "" : e.date_modified);
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
  const published = new Map<SearchEntry, string>();
  const matched: SearchEntry[] = [];
  for (const project of mockProjects()) {
    // 只搜一个平台时，合并卡只剩那个平台的一份：卡面、数字、来源都只按它算
    const sources = only === null ? project.sources : project.sources.filter((s) => s.platform === only);
    if (sources.length === 0 || !wanted.includes(project.resourceType)) continue;
    if (category !== null && !project.categories.includes(category)) continue;
    if (loaders.length > 0 && !sourcesLoaders(sources).some((l) => loaders.includes(l))) continue;
    if (gameVersions.length > 0 && !sourcesGameVersions(sources).some((v) => gameVersions.includes(v))) continue;
    if (query !== "" && !`${project.title} ${project.description}`.toLowerCase().includes(query)) continue;
    const entry = searchEntry({ ...project, sources });
    published.set(entry, project.datePublished);
    matched.push(entry);
  }
  const sorted = sortItems(matched, sort, (e) => {
    const date = published.get(e);
    if (date === undefined) throw new Error("搜索结果里出现了不是本次筛出的条目");
    return date;
  });
  const offset = cursor === null ? 0 : cursor.modrinth.offset;
  const page = sorted.slice(offset, offset + limit);
  const nextOffset = offset + page.length;
  const exhausted = nextOffset >= sorted.length;
  const side = { offset: nextOffset, exhausted, total: sorted.length, absorbed: [] };
  const skipped: SkippedPlatform[] = only === null ? [] : PLATFORMS.filter((p) => p !== only).map((platform) => ({ platform, reason: "filtered" }));
  return {
    hits: page,
    total: sorted.length,
    errors: [],
    skipped,
    next_cursor: exhausted ? null : { modrinth: side, curseforge: { ...side, absorbed: [] } },
  };
}

/** 平台上没有这个工程：后端是平台接口的 404，经命令层归为 mod_platform_failed。 */
function notFound(platform: PlatformId, projectId: string): IpcError {
  return new IpcError("mod_platform_failed", `${platform} 返回 404：工程 ${projectId} 不存在`);
}

/** 详情的「必需前置」：最新版本声明的必需依赖，前置本身也在目录里（目录是自洽的）。 */
function dependencyProjects(platform: PlatformId, source: MockSource): DependencyProject[] {
  const latest = newestFirst(sourceVersions(source))[0];
  if (latest === undefined) return [];
  return latest.dependencies.flatMap((dep) => {
    if (dep.kind !== "required" || dep.project_id === null) return [];
    const found = findMockSource(platform, dep.project_id);
    if (found === undefined) throw new Error(`mock 目录里 ${source.projectId} 的前置 ${dep.project_id} 不在目录里`);
    const depLatest = newestFirst(sourceVersions(found.source))[0];
    return [
      {
        platform,
        project_id: found.source.projectId,
        title: found.project.title,
        icon_url: null,
        author: found.project.author,
        latest_version: depLatest === undefined ? null : depLatest.version_number,
      },
    ];
  });
}

function projectDetail(args: MockArgs): ProjectDetail {
  const read = argReader("project_detail", args);
  const platform = parsePlatform(read.string("platform"));
  const projectId = read.string("projectId");
  const found = findMockSource(platform, projectId);
  if (found === undefined) throw notFound(platform, projectId);
  const { project, source } = found;
  const latest = newestFirst(sourceVersions(source))[0];
  return {
    platform,
    project_id: source.projectId,
    slug: source.slug,
    title: project.title,
    summary: project.description,
    body:
      platform === "modrinth"
        ? `## ${project.title}\n\n${project.description}\n\n- 作者：**${project.author}**\n- 更多介绍见 [项目主页](${pageUrl(platform, source.slug)})`
        : `<h2>${project.title}</h2><p>${project.description}</p><p>作者：<strong>${project.author}</strong></p>`,
    body_format: platform === "modrinth" ? "markdown" : "html",
    author: project.author,
    downloads: source.downloads,
    follows: source.follows,
    icon_url: null,
    gallery: [],
    hue: project.hue,
    categories: project.categories,
    resource_type: project.resourceType,
    loaders: sourcesLoaders([source]),
    game_versions: sourcesGameVersions([source]),
    date_published: project.datePublished,
    date_modified: project.dateModified,
    page_url: pageUrl(platform, source.slug),
    source_url: null,
    issues_url: null,
    wiki_url: null,
    latest_version: latest === undefined ? null : latest,
    dependencies: dependencyProjects(platform, source),
    distribution_allowed: true,
  };
}

/** 推送一条后端进度事件；按 CoreEvent 定型，负载形状写错在编译期就报出来。 */
export function emitCoreEvent(event: CoreEvent): void {
  emitMockEvent(CORE_EVENT, event);
}

/** 事件的归属。step 只在组合任务的一项上出现，没有时整个键都不写，与后端省去它的序列化一致。 */
export function eventOwner(taskId: string, step: number | null): { task_id: string; step?: number } {
  return step === null ? { task_id: taskId } : { task_id: taskId, step };
}

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 15));

/**
 * 模拟一次下载：阶段事件 + 四次进度快照，每步之间检查取消。
 * 被取消时以 IpcError("cancelled") 拒绝，与后端在取消后的返回一致。step 是组合任务的项序号，标在每条事件上。
 */
export async function simulateDownload(taskId: string, label: string, totalBytes: number, step: number | null = null): Promise<void> {
  const owner = eventOwner(taskId, step);
  emitCoreEvent({ ...owner, kind: "stage", message: `开始下载 ${label}` });
  for (let quarter = 0; quarter <= 4; quarter++) {
    if (isMockTaskCancelled(taskId)) throw new IpcError("cancelled", "已取消");
    const bytes = Math.round((totalBytes * quarter) / 4);
    emitCoreEvent({
      ...owner,
      kind: "download",
      total: 1,
      finished: quarter === 4 ? 1 : 0,
      bytes,
      total_bytes: totalBytes,
      transferred: bytes,
      speed: quarter === 0 ? 0 : 2_097_152,
    });
    if (quarter < 4) await tick();
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

/** 实例以实例 mock 为准：不存在或损坏报 version_not_installed，与后端解析工作目录时一致；返回它的存档目录名。 */
function requireInstalled(versionId: string): string[] {
  const worlds = mockInstanceWorlds(versionId);
  if (worlds === null) throw new IpcError("version_not_installed", `本地未安装版本 ${versionId}`, { id: versionId });
  return worlds;
}

const RESOURCE_DIRS: Record<Exclude<InstallableResourceType, "mod">, string> = {
  resource_pack: "resourcepacks",
  shader: "shaderpacks",
  data_pack: "datapacks",
};

/** 装进实例的资源包、光影、数据包文件。后端的落位矩阵读游戏目录里的文件认已装，这里记下装过的同一批文件。 */
export interface MockPackFile {
  type: Exclude<InstallableResourceType, "mod">;
  /** 数据包所在的存档；其余类型为 null。 */
  world: string | null;
  file_name: string;
  size: number;
}

let packFiles = new Map<string, MockPackFile[]>();

/** 实例里装过的资源包、光影、数据包；一个都没装过为空。 */
export function mockPackFiles(versionId: string): readonly MockPackFile[] {
  const known = packFiles.get(versionId);
  return known === undefined ? [] : known;
}

/** 同一目录下同名文件覆盖旧的那份，与落盘时一致。 */
function recordPackFile(versionId: string, file: MockPackFile): void {
  const kept = mockPackFiles(versionId).filter((f) => !(f.type === file.type && f.world === file.world && f.file_name === file.file_name));
  packFiles.set(versionId, [...kept, file]);
}

/** 实例改名时资源文件跟着走（它们就在实例目录里）。 */
export function renameMockPackFiles(from: string, to: string): void {
  const known = packFiles.get(from);
  if (known === undefined) return;
  packFiles.delete(from);
  packFiles.set(to, known);
}

/** 实例删除时一并忘掉，免得同名新实例凭空带着旧的资源包。 */
export function forgetMockPackFiles(versionId: string): void {
  packFiles.delete(versionId);
}

function installResource(args: MockArgs): Promise<ResourceInstallOutcomeDto> {
  const read = argReader("install_resource", args);
  const taskId = read.string("taskId");
  const versionId = read.string("versionId");
  const rawType = read.string("resourceType");
  const resourceType = parseOne(RESOURCE_TYPES, rawType, `未知资源类型 ${rawType}`);
  if (resourceType === "modpack" || resourceType === "plugin") throw invalid(`${rawType} 不能作为单个资源装进实例`);
  if (resourceType === "mod") throw invalid("Mod 要经 install_mod 安装，不能作为单个资源装进实例");
  const world = read.nullableString("world");
  const platform = parsePlatform(read.string("platform"));
  const projectId = read.string("projectId");
  const fileVersionId = read.string("fileVersionId");
  // 与后端同序：全部入参解析完再占住实例（modifying），之后登记任务
  const hold = acquireMockInstance(versionId, "modifying");
  // 数据包写进存档目录，与后端一样先记下再查备份、恢复与读存档的导出
  const unmark = resourceType === "data_pack" ? markMockSavesWritten(versionId) : () => undefined;
  const release = () => {
    unmark();
    hold.release();
  };
  if (resourceType === "data_pack") {
    try {
      ensureMockSavesFreeForWriting(versionId);
    } catch (error) {
      release();
      throw error;
    }
  }
  return runMockTask(taskId, async () => {
    if (resourceType === "data_pack" && world === null) throw invalid("安装目标不对：数据包要指明装进哪个存档");
    if (resourceType !== "data_pack" && world !== null) throw invalid("安装目标不对：只有数据包需要指定存档");
    const worlds = requireInstalled(versionId);
    if (world !== null && !worlds.includes(world)) {
      throw new IpcError("world_not_found", `实例 ${versionId} 里没有存档 ${world}`, { version_id: versionId, world });
    }
    if (findMockSource(platform, projectId) === undefined) throw notFound(platform, projectId);
    const version = findMockVersion(platform, projectId, fileVersionId);
    if (version === undefined) {
      throw new IpcError("mod_version_not_found", `平台 ${platform === "modrinth" ? "Modrinth" : "CurseForge"} 上工程 ${projectId} 未找到版本 ${fileVersionId}`);
    }
    const { file_name, file_size } = version.info;
    if (file_size === null) throw new Error(`mock 目录里的版本 ${fileVersionId} 缺少 file_size`);
    await simulateDownload(taskId, file_name, file_size);
    // 数据包装进存档，实例内容里没有它的列表
    if (resourceType !== "data_pack") recordMockPack(versionId, resourceType, file_name, file_size);
    recordPackFile(versionId, { type: resourceType, world, file_name, size: file_size });
    const dir = world === null ? RESOURCE_DIRS[resourceType] : `saves/${world}/${RESOURCE_DIRS[resourceType]}`;
    return {
      file_name,
      path: `${MOCK_GAME_DIR}/versions/${versionId}/${dir}/${file_name}`,
      platform,
      resource_type: resourceType,
      world,
    };
  }).finally(release);
}

export const handlers: MockHandlers = {
  search_resources: searchResources,
  project_detail: projectDetail,
  install_resource: installResource,
};

export function reset(): void {
  packFiles = new Map();
}

export const persist: MockPersist = {
  version: 1,
  snapshot: () => [...packFiles.entries()],
  restore: (data) => {
    packFiles = new Map(data as [string, MockPackFile[]][]);
  },
};
