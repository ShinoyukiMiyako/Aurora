// 资源平台：跨 Modrinth / CurseForge 搜索与安装 Mod。

import { invoke } from "./bridge";
import type { ModLoader } from "./mods";

export type PlatformId = "modrinth" | "curseforge";
export type ResourceType = "mod" | "modpack" | "resource_pack" | "shader" | "data_pack" | "plugin";
export type SortField = "relevance" | "downloads" | "follows" | "newest" | "updated";

export interface SearchHit {
  platform: PlatformId;
  project_id: string;
  slug: string | null;
  title: string;
  description: string;
  author: string | null;
  downloads: number;
  follows: number | null;
  icon_url: string | null;
  categories: string[];
  resource_type: ResourceType;
  date_modified: string | null;
  page_url: string | null;
}

export interface SearchResultDto {
  hits: SearchHit[];
  /** 部分平台失败时，其余平台的结果照常返回，失败原因在这里。 */
  errors: { platform: PlatformId; message: string }[];
}

export interface SearchArgs {
  query: string | null;
  resourceType: ResourceType;
  loaders: ModLoader[];
  gameVersions: string[];
  sort: SortField;
  limit: number;
  offset: number;
}

export interface ModInstallOutcomeDto {
  file_name: string;
  path: string;
  platform: PlatformId;
}

export const searchResources = (args: SearchArgs): Promise<SearchResultDto> =>
  invoke<SearchResultDto>("search_resources", { ...args });

/** 长任务：进度经 core-event 推送并带 task_id，可用 cancelTask(taskId) 取消。 */
export const installMod = (
  taskId: string,
  versionId: string,
  platform: PlatformId,
  projectId: string,
  modVersionId: string,
): Promise<ModInstallOutcomeDto> => invoke<ModInstallOutcomeDto>("install_mod", { taskId, versionId, platform, projectId, modVersionId });
