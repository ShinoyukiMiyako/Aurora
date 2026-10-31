// 发现：跨 Modrinth / CurseForge 聚合搜索、工程详情，把平台上的 Mod 与资源装进实例。

import type { Platform } from "../domain/types";
import { invoke } from "./bridge";
import type { ModLoader, ModVersionInfo } from "./mods";

// 版本视图在 Mod 管理与发现两侧是同一个后端类型，只在 mods 定义一份，免得两边字段漂移。
export type { DependencyKind, ModDependency, ModVersionInfo, ReleaseChannel } from "./mods";

export type PlatformId = Platform;
export type ResourceType = "mod" | "modpack" | "resource_pack" | "shader" | "data_pack" | "plugin";
/** 发现页能搜的类型。 */
export type DiscoverableType = Exclude<ResourceType, "plugin">;
/** 能作为单个文件装进实例的类型（整合包走 installModpack）。 */
export type InstallableResourceType = "mod" | "resource_pack" | "shader" | "data_pack";
export type SortField = "relevance" | "downloads" | "follows" | "newest" | "updated";
/** 某平台没参与本次搜索的原因：只搜了另一个平台 / 没有 CurseForge API key / 该分类在 CurseForge 没有对应。 */
export type SkipReason = "filtered" | "key_missing" | "category_unmapped";
export type BodyFormat = "markdown" | "html";

/** 合并卡里某一个平台的那份工程。 */
export interface HitSource {
  platform: PlatformId;
  project_id: string;
  slug: string | null;
  page_url: string | null;
  downloads: number;
  follows: number | null;
}

/** 一张搜索卡。两个平台上标题与作者一致的同一工程合并成一张：顶层字段取 Modrinth 那份，下载量相加，`sources` 列出各平台。 */
export interface SearchEntry {
  platform: PlatformId;
  project_id: string;
  slug: string | null;
  title: string;
  description: string;
  author: string | null;
  downloads: number;
  follows: number | null;
  icon_url: string | null;
  gallery_url: string | null;
  /** 主色的色相 0..360；平台没给主色时为 null。 */
  hue: number | null;
  categories: string[];
  loaders: ModLoader[];
  resource_type: ResourceType;
  date_modified: string | null;
  page_url: string | null;
  sources: HitSource[];
}

export interface PlatformCursor {
  offset: number;
  exhausted: boolean;
  total: number | null;
  absorbed: string[];
}

/** 翻页游标：原样回传上一页的 next_cursor，前端不解读内容。 */
export interface SearchCursor {
  modrinth: PlatformCursor;
  curseforge: PlatformCursor;
}

export interface SkippedPlatform {
  platform: PlatformId;
  reason: SkipReason;
}

export interface SearchResultDto {
  hits: SearchEntry[];
  /** 参与平台报告的总数之和（合并前计数，界面写「约」）。 */
  total: number;
  /** 部分平台失败时，其余平台的结果照常返回，失败原因在这里。 */
  errors: { platform: PlatformId; message: string }[];
  skipped: SkippedPlatform[];
  /** 下一页游标；null 表示到底。 */
  next_cursor: SearchCursor | null;
}

export interface SearchArgs {
  /** 关键词；null 或空白表示不按关键词筛。 */
  query: string | null;
  /** 空数组表示全部可搜类型。 */
  resourceTypes: DiscoverableType[];
  /** 分类键（Modrinth 的分类名，小写字母、数字与连字符）；null 表示不限。 */
  category: string | null;
  /** 只搜一个平台；null 表示两个都搜。 */
  platform: PlatformId | null;
  loaders: ModLoader[];
  gameVersions: string[];
  sort: SortField;
  /** 1..=50。 */
  limit: number;
  /** 首页传 null。 */
  cursor: SearchCursor | null;
}

/** 详情页「必需前置」里的一项。 */
export interface DependencyProject {
  platform: PlatformId;
  project_id: string;
  title: string;
  icon_url: string | null;
  author: string | null;
  latest_version: string | null;
}

export interface ProjectDetail {
  platform: PlatformId;
  project_id: string;
  slug: string | null;
  title: string;
  summary: string;
  /** 介绍正文：Modrinth 为 Markdown，CurseForge 为 HTML，见 body_format。 */
  body: string;
  body_format: BodyFormat;
  author: string | null;
  downloads: number;
  follows: number | null;
  icon_url: string | null;
  gallery: string[];
  hue: number | null;
  categories: string[];
  resource_type: ResourceType;
  loaders: ModLoader[];
  game_versions: string[];
  date_published: string | null;
  date_modified: string | null;
  page_url: string | null;
  source_url: string | null;
  issues_url: string | null;
  wiki_url: string | null;
  latest_version: ModVersionInfo | null;
  dependencies: DependencyProject[];
  /** CurseForge 作者禁止第三方分发时为 false：只能去网页下载。 */
  distribution_allowed: boolean;
}

export interface ModInstallOutcomeDto {
  file_name: string;
  path: string;
  platform: PlatformId;
}

export interface ResourceInstallOutcomeDto {
  file_name: string;
  path: string;
  platform: PlatformId;
  resource_type: InstallableResourceType;
  /** 数据包装进的存档；其余类型为 null。 */
  world: string | null;
}

export interface InstallResourceArgs {
  taskId: string;
  versionId: string;
  resourceType: InstallableResourceType;
  /** 数据包必须给出存档目录名，其余类型必须为 null。 */
  world: string | null;
  platform: PlatformId;
  projectId: string;
  /** Modrinth 版本 id / CurseForge 文件 id。 */
  fileVersionId: string;
}

export const searchResources = (args: SearchArgs): Promise<SearchResultDto> =>
  invoke<SearchResultDto>("search_resources", { ...args });

export const projectDetail = (platform: PlatformId, projectId: string): Promise<ProjectDetail> =>
  invoke<ProjectDetail>("project_detail", { platform, projectId });

/**
 * 长任务：进度经 core-event 推送并带 task_id，可用 cancelTask(taskId) 取消。
 * 作为组合任务的一项调用时 step 给第几项（从 0 计），后端把它标在这次调用的每条事件上；单独调用不给。
 */
export const installMod = (
  taskId: string,
  versionId: string,
  platform: PlatformId,
  projectId: string,
  modVersionId: string,
  step?: number,
): Promise<ModInstallOutcomeDto> => invoke<ModInstallOutcomeDto>("install_mod", { taskId, versionId, platform, projectId, modVersionId, step });

/** 长任务：资源包进 resourcepacks/，光影进 shaderpacks/，数据包进 saves/<存档>/datapacks/。Mod 不走这里（报 invalid_argument），用 installMod。 */
export const installResource = (args: InstallResourceArgs): Promise<ResourceInstallOutcomeDto> =>
  invoke<ResourceInstallOutcomeDto>("install_resource", { ...args });
