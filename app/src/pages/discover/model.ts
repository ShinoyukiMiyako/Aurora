// 发现页的筛选模型：界面上的筛选状态、它与后端搜索参数的换算、条件说明、分页累积。纯函数，测试直接驱动。

import type { InstanceSummary } from "../../domain/adapt";
import type { LoaderKind, Platform, ResourceKind } from "../../domain/types";
import type { LoaderChoice } from "../../state/queries/catalog";
import type { DiscoverableType, InstanceSources, ResourceType, SearchArgs, SearchEntry, SearchResultDto, SortField } from "../../state/queries/discover";
import type { DiscoverKind, RouteOf } from "../../state/route";
import { CATEGORY_NAME, type CategoryKey } from "./copy";

/** 每页 24 条：2 / 3 / 4 列的公倍数，末行不留半排。 */
export const PAGE_SIZE = 24;
/** 一次会话最多累积 20 页；再往下翻的人需要的是更准的关键词。 */
export const MAX_RESULTS = 480;
/** 滚到距列表底这么远时预取下一页。 */
export const PREFETCH_MARGIN_PX = 600;

export const DISCOVER_KINDS: readonly DiscoverKind[] = ["all", "mod", "modpack", "resourcepack", "shader", "datapack"];

export const SORT_FIELDS: readonly SortField[] = ["relevance", "downloads", "follows", "newest", "updated"];

export const FILTER_LOADERS: readonly LoaderChoice[] = ["fabric", "forge", "neoforge", "quilt"];

const KIND_TYPES: Readonly<Record<DiscoverKind, DiscoverableType[]>> = {
  all: [],
  mod: ["mod"],
  modpack: ["modpack"],
  resourcepack: ["resource_pack"],
  shader: ["shader"],
  datapack: ["data_pack"],
};

/** 「全部」对应空数组：后端把空数组当作全部可搜类型。 */
export function resourceTypesOf(kind: DiscoverKind): DiscoverableType[] {
  return KIND_TYPES[kind];
}

/** 后端资源类型到界面资源类别。plugin 不在发现页的搜索范围里，出现即契约被破坏。 */
export function resourceKindOf(type: ResourceType): ResourceKind {
  switch (type) {
    case "mod":
      return "mod";
    case "modpack":
      return "modpack";
    case "resource_pack":
      return "resourcepack";
    case "shader":
      return "shader";
    case "data_pack":
      return "datapack";
    case "plugin":
      throw new Error("发现页不搜索服务端插件，却收到了 plugin 类型的结果");
  }
}

export interface HotCategory {
  key: string;
  label: string;
}

const hot = (...keys: CategoryKey[]): HotCategory[] => keys.map((key) => ({ key, label: CATEGORY_NAME[key] }));

const COMMON_CATEGORIES = hot("optimization", "technology", "magic", "adventure", "decoration", "utility", "worldgen");

/** 每种类型固定 7 枚热门分类；键是 Modrinth 的分类名，CurseForge 的对应由后端换算。 */
export const HOT_CATEGORIES: Readonly<Record<DiscoverKind, readonly HotCategory[]>> = {
  all: COMMON_CATEGORIES,
  mod: COMMON_CATEGORIES,
  datapack: COMMON_CATEGORIES,
  modpack: hot("adventure", "technology", "magic", "lightweight", "quests", "multiplayer", "optimization"),
  resourcepack: hot("vanilla-like", "simplistic", "realistic", "themed", "gui", "fonts", "audio"),
  shader: hot("vanilla-like", "realistic", "semi-realistic", "cartoon", "fantasy", "potato", "screenshot"),
};

export function categoryLabel(kind: DiscoverKind, key: string): string {
  const found = HOT_CATEGORIES[kind].find((c) => c.key === key);
  if (found === undefined) throw new Error(`分类 ${key} 不在「${kind}」的热门分类里`);
  return found.label;
}

/** 详情标签行的分类名。平台新加的分类与 CurseForge 的英文分类名没有中文名，为 null，界面上不显示：标签行不夹英文原文。 */
export function categoryDisplay(key: string): string | null {
  return Object.hasOwn(CATEGORY_NAME, key) ? CATEGORY_NAME[key as CategoryKey] : null;
}

/** 加载器筛选只对 Mod 与整合包有意义；资源包、光影、数据包不分加载器。 */
export function loaderFilterApplies(kind: DiscoverKind): boolean {
  return kind === "all" || kind === "mod" || kind === "modpack";
}

export interface DiscoverFilters {
  /** 搜索框里的文字（未防抖）。 */
  query: string;
  kind: DiscoverKind;
  category: string | null;
  platform: Platform | null;
  gameVersion: string | null;
  showSnapshots: boolean;
  loader: LoaderChoice | null;
  sort: SortField;
  /** 「适配实例」：选中时版本与加载器筛选取这个实例的值。 */
  fitInstance: string | null;
}

export const DEFAULT_FILTERS: DiscoverFilters = {
  query: "",
  kind: "all",
  category: null,
  platform: null,
  gameVersion: null,
  showSnapshots: false,
  loader: null,
  sort: "relevance",
  fitInstance: null,
};

/** 切换类型：已选分类不在新类型的列表里就清掉。 */
export function withKind(filters: DiscoverFilters, kind: DiscoverKind): DiscoverFilters {
  const keep = filters.category !== null && HOT_CATEGORIES[kind].some((c) => c.key === filters.category);
  return { ...filters, kind, category: keep ? filters.category : null };
}

/** 再点一次已选的分类即取消；同一时刻最多一个分类。 */
export function toggleCategory(filters: DiscoverFilters, key: string): DiscoverFilters {
  if (!HOT_CATEGORIES[filters.kind].some((c) => c.key === key)) throw new Error(`分类 ${key} 不在「${filters.kind}」的热门分类里`);
  return { ...filters, category: filters.category === key ? null : key };
}

/** 选中适配实例 = 版本与加载器取它的值；原版实例没有加载器，加载器筛选回到不限。 */
export function withFitInstance(filters: DiscoverFilters, instance: InstanceSummary | null): DiscoverFilters {
  if (instance === null) return { ...filters, fitInstance: null };
  if (instance.mcVersion === null) throw new Error(`实例 ${instance.id} 认不出游戏版本，不能作为适配实例`);
  return { ...filters, fitInstance: instance.id, gameVersion: instance.mcVersion, loader: instance.loader === "vanilla" ? null : instance.loader };
}

/** 手动改了版本或加载器：适配实例回到不限。 */
export function withGameVersion(filters: DiscoverFilters, gameVersion: string | null): DiscoverFilters {
  return { ...filters, gameVersion, fitInstance: null };
}

export function withLoader(filters: DiscoverFilters, loader: LoaderChoice | null): DiscoverFilters {
  return { ...filters, loader, fitInstance: null };
}

/** 筛选浮层的「重置」：只清浮层里的三项。 */
export function resetPopoverFilters(filters: DiscoverFilters): DiscoverFilters {
  return { ...filters, platform: null, gameVersion: null, loader: null, fitInstance: null };
}

/** 结果说明行的「清除筛选」：清分类、浮层与适配实例，不清搜索词，不动类型与排序。 */
export function clearFilters(filters: DiscoverFilters): DiscoverFilters {
  return { ...resetPopoverFilters(filters), category: null };
}

/** 筛选按钮后缀的条件数：只数浮层里生效的条件。 */
export function popoverFilterCount(filters: DiscoverFilters): number {
  let n = 0;
  if (filters.platform !== null) n++;
  if (filters.gameVersion !== null) n++;
  if (filters.loader !== null && loaderFilterApplies(filters.kind)) n++;
  return n;
}

export function hasConditions(filters: DiscoverFilters): boolean {
  return filters.category !== null || filters.fitInstance !== null || popoverFilterCount(filters) > 0;
}

/** 一页搜索的参数。query 为防抖后的关键词；首页 cursor 为 null。 */
export function searchArgsOf(filters: DiscoverFilters, query: string): SearchArgs {
  const trimmed = query.trim();
  return {
    query: trimmed === "" ? null : trimmed,
    resourceTypes: resourceTypesOf(filters.kind),
    category: filters.category,
    platform: filters.platform,
    loaders: filters.loader !== null && loaderFilterApplies(filters.kind) ? [filters.loader] : [],
    gameVersions: filters.gameVersion === null ? [] : [filters.gameVersion],
    sort: filters.sort,
    limit: PAGE_SIZE,
    cursor: null,
  };
}

/** 查询缓存的 key 与状态层的 useSearch 同一写法，「重试」据此让这一页失效。 */
export function searchKey(args: SearchArgs): string {
  return `search:${JSON.stringify(args)}`;
}

export interface ConditionLabels {
  loaderName: Readonly<Record<LoaderKind, string>>;
  platformName: Readonly<Record<Platform, string>>;
}

/** 结果说明行里的生效条件，按「版本 · 加载器 · 分类 · 平台」排列。 */
export function conditionParts(filters: DiscoverFilters, labels: ConditionLabels): string[] {
  const parts: string[] = [];
  if (filters.gameVersion !== null) parts.push(filters.gameVersion);
  if (filters.loader !== null && loaderFilterApplies(filters.kind)) parts.push(labels.loaderName[filters.loader]);
  if (filters.category !== null) parts.push(categoryLabel(filters.kind, filters.category));
  if (filters.platform !== null) parts.push(labels.platformName[filters.platform]);
  return parts;
}

/** 合并卡与单平台卡的身份：顶层平台 + 工程 id。 */
export function hitKey(entry: Pick<SearchEntry, "platform" | "project_id">): string {
  return `${entry.platform}:${entry.project_id}`;
}

/**
 * 把新一页接到已有结果后面。偏移量翻页在两次请求之间排名可能变动，同一工程会在相邻两页各出现一次，
 * 后到的那条丢掉；后端合并卡吸收的条目已经不在 hits 里。
 */
export function appendHits(existing: readonly SearchEntry[], page: readonly SearchEntry[]): SearchEntry[] {
  const seen = new Set(existing.map(hitKey));
  const out = [...existing];
  for (const entry of page) {
    const key = hitKey(entry);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(entry);
  }
  return out;
}

/**
 * 这一页有平台失败、给回的下一页游标又与请求的一模一样：失败的平台游标原地不动，另一个平台已经到底，
 * 再接下一页只是把同一个请求再发一遍。游标原样回传、前端不解读内容，所以按序列化后的样子整体比较。
 */
export function stalledPage(request: SearchArgs, page: SearchResultDto): boolean {
  return page.errors.length > 0 && page.next_cursor !== null && JSON.stringify(page.next_cursor) === JSON.stringify(request.cursor);
}

export type PartialFailure = { failed: Platform; other: Platform; message: string };

/** 只有一个平台失败、另一个照常返回时的说明；两个都失败或都正常时为 null。 */
export function partialFailure(result: SearchResultDto): PartialFailure | null {
  if (result.errors.length !== 1) return null;
  const failed = result.errors[0].platform;
  const other: Platform = failed === "modrinth" ? "curseforge" : "modrinth";
  const otherSkipped = result.skipped.some((s) => s.platform === other);
  return otherSkipped ? null : { failed, other, message: result.errors[0].message };
}

/** 两个平台都没给出结果（都失败，或一个失败另一个没参与）。 */
export function allPlatformsFailed(result: SearchResultDto): boolean {
  if (result.errors.length === 0) return false;
  const failed = new Set(result.errors.map((e) => e.platform));
  const skipped = new Set(result.skipped.map((s) => s.platform));
  return (["modrinth", "curseforge"] as const).every((p) => failed.has(p) || skipped.has(p)) && result.hits.length === 0;
}

/** CurseForge 因换算不到分类或缺少密钥没有参与时的说明；用户自己只选 Modrinth（filtered）不说明。 */
export function curseForgeSkipNote(result: SearchResultDto): "category_unmapped" | "key_missing" | null {
  const skip = result.skipped.find((s) => s.platform === "curseforge");
  if (skip === undefined || skip.reason === "filtered") return null;
  return skip.reason;
}

/** 一个工程在各平台上的身份：合并卡有两个来源，单平台卡与从路由直接打开的只有自己。 */
export interface ProjectOrigin {
  platform: Platform;
  projectId: string;
}

export function projectOrigins(entry: { platform: Platform; project_id: string; sources: readonly { platform: Platform; project_id: string }[] }): ProjectOrigin[] {
  const sources = entry.sources.length > 0 ? entry.sources : [entry];
  return sources.map((s) => ({ platform: s.platform, projectId: s.project_id }));
}

/** 来自这个整合包的实例：实例记下的整合包平台与工程 id 对上任一来源；本地文件导入的实例没有平台来源，不算。 */
export function instancesFromPack(origins: readonly ProjectOrigin[], instances: readonly InstanceSummary[]): InstanceSummary[] {
  return instances.filter((i) => {
    const pack = i.modpack;
    return pack !== null && pack.platform !== null && origins.some((o) => o.platform === pack.platform && o.projectId === pack.projectId);
  });
}

/**
 * 实例 id -> 已装 Mod 的「平台:工程 id」。只收 ids 里的实例（装好的、不是占位项），读不出来源的实例不收，按没装处理。
 * rows 为 undefined（还没读到）时为空表。
 */
export function installedBySource(rows: readonly InstanceSources[] | undefined, ids: readonly string[]): ReadonlyMap<string, ReadonlySet<string>> {
  const out = new Map<string, ReadonlySet<string>>();
  if (rows === undefined) return out;
  const wanted = new Set(ids);
  for (const row of rows) {
    if (row.status === "ready" && wanted.has(row.version_id)) out.set(row.version_id, new Set(row.sources.map((s) => `${s.platform}:${s.project_id}`)));
  }
  return out;
}

/** 已装入几个实例：任一来源（合并卡有两个）出现在实例的已装 Mod 里就算。 */
export function installedCount(entry: SearchEntry, installed: ReadonlyMap<string, ReadonlySet<string>>): number {
  const keys = entry.sources.length > 0 ? entry.sources.map((s) => `${s.platform}:${s.project_id}`) : [hitKey(entry)];
  let n = 0;
  for (const projects of installed.values()) if (keys.some((k) => projects.has(k))) n++;
  return n;
}

/** 搜索卡的色相：条目自带色相优先，缺失时由项目 id 推出，同一资源在各处一致。 */
export function entryHue(hue: number | null, projectId: string, hueOf: (key: string) => number): number {
  return hue === null ? hueOf(projectId) : hue;
}

/** 平台给的 ISO 时间；null 或空串表示平台没给。给了却解析不了说明契约被破坏，直接抛出。 */
export function parsePlatformTime(value: string | null): number | null {
  if (value === null || value === "") return null;
  const ts = Date.parse(value);
  if (Number.isNaN(ts)) throw new Error(`平台返回了无法解析的时间：${value}`);
  return ts;
}

/** 能当「适配实例」的实例：就绪、认得出游戏版本、不是还没扫到目录的占位项。 */
export function fitCandidates(instances: readonly InstanceSummary[]): InstanceSummary[] {
  return instances.filter((i) => i.status === "ready" && i.mcVersion !== null && !i.placeholder);
}

/**
 * 把进页路由带来的参数叠到当前筛选上：关键词、类型、适配实例。
 * forInstance 指向的实例不能当适配实例（还在安装、损坏、认不出版本）时不设适配，其余参数照常生效。
 */
export function routeFilters(base: DiscoverFilters, route: RouteOf<"discover">, instances: readonly InstanceSummary[]): DiscoverFilters {
  let next = base;
  if (route.query !== undefined) next = { ...next, query: route.query };
  if (route.kind !== undefined) next = withKind(next, route.kind);
  if (route.forInstance !== undefined) {
    const id = route.forInstance;
    const fit = fitCandidates(instances).find((i) => i.id === id);
    if (fit !== undefined) next = withFitInstance(next, fit);
  }
  return next;
}

/** 页面写回路由的部分：生效的关键词与类型（「全部」与空关键词不写）。适配实例与详情不写回。 */
export function routeOfFilters(kind: DiscoverKind, committedQuery: string): RouteOf<"discover"> {
  const query = committedQuery.trim();
  return {
    page: "discover",
    ...(query === "" ? {} : { query }),
    ...(kind === "all" ? {} : { kind }),
  };
}

/** 判断路由参数是否变过：页面自己写回的路由与外部导航带来的路由都按它比较。 */
export function routeSignature(route: RouteOf<"discover">): string {
  return JSON.stringify([route.query, route.kind, route.forInstance, route.open === undefined ? null : [route.open.platform, route.open.projectId], route.importFile]);
}
