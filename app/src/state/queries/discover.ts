// 发现与安装：搜索、详情、版本、落位矩阵与安装计划，以及本地整合包预览。
// 搜索的防抖与分页累积归页面：这里一组参数就是一页，换参数即换 key。

import type { Platform } from "../../domain/types";
import { projectDetail, searchResources, type InstallableResourceType, type ProjectDetail, type SearchArgs, type SearchResultDto } from "../../ipc/discover";
import { previewModpack, summarizePlatformModpack, type ModpackPreviewDto, type ModpackSummaryDto } from "../../ipc/modpack";
import { installedSources, matchInstances, modVersionList, planInstall, type InstallPlan, type InstanceMatch, type InstanceSources, type ModLoader, type ModVersionList } from "../../ipc/mods";
import { useResource, type ResourceResult } from "../resource";

export type {
  BodyFormat,
  DependencyProject,
  DiscoverableType,
  HitSource,
  InstallableResourceType,
  PlatformCursor,
  ProjectDetail,
  ResourceType,
  SearchArgs,
  SearchCursor,
  SearchEntry,
  SearchResultDto,
  SkippedPlatform,
  SkipReason,
  SortField,
} from "../../ipc/discover";
export type { ModpackPreviewDto, ModpackSource, ModpackSummaryDto, PackFormat, PackLoader } from "../../ipc/modpack";
export type { Compatibility, InstallPlan, InstalledSource, InstanceMatch, InstanceSources, MatchState, ModDependency, ModLoader, ModVersionInfo, ModVersionList, PlannedItem } from "../../ipc/mods";

/** search:<参数 JSON>；args 为 null 时不请求（关键词还在防抖中）。 */
export function useSearch(args: SearchArgs | null): ResourceResult<SearchResultDto> {
  return useResource(args === null ? null : `search:${JSON.stringify(args)}`, () => {
    if (args === null) throw new Error("未启用的查询不应发出请求");
    return searchResources(args);
  });
}

/** project:<platform>:<projectId>。 */
export function useProjectDetail(platform: Platform, projectId: string | null): ResourceResult<ProjectDetail> {
  return useResource(projectId === null ? null : `project:${platform}:${projectId}`, () => {
    if (projectId === null) throw new Error("未启用的查询不应发出请求");
    return projectDetail(platform, projectId);
  });
}

/** mod-versions:<platform>:<projectId>:<过滤 JSON>；两个过滤维度传空数组表示不过滤。truncated 时界面要说明列表不全。 */
export function useModVersions(platform: Platform, projectId: string, gameVersions: string[], loaders: ModLoader[]): ResourceResult<ModVersionList> {
  return useResource(`mod-versions:${platform}:${projectId}:${JSON.stringify([gameVersions, loaders])}`, () =>
    modVersionList(platform, projectId, gameVersions, loaders),
  );
}

/**
 * match:<platform>:<projectId>:<类型>:<版本或 auto> —— 全部实例的落位矩阵；任一实例的 Mod 或资源变化后整个前缀失效，
 * 实例增删时页面按需 reload。类型决定判定口径（资源包、光影、数据包不看加载器）。
 */
export function useInstanceMatches(
  platform: Platform,
  projectId: string,
  resourceType: InstallableResourceType,
  modVersionId: string | null,
): ResourceResult<InstanceMatch[]> {
  return useResource(`match:${platform}:${projectId}:${resourceType}:${modVersionId === null ? "auto" : modVersionId}`, () =>
    matchInstances(platform, projectId, resourceType, modVersionId),
  );
}

/**
 * installed-sources:<实例 id 列表 JSON> —— 全部实例已装 Mod 的平台来源，一条命令取齐（发现页「已装入 n 个实例」）。
 * 实例增删、改名时 key 随 id 列表变；Mod 装上、移除、更新、回滚后由 store 按前缀失效。instanceIds 为 null 时不请求。
 */
export function useInstalledSources(instanceIds: readonly string[] | null): ResourceResult<InstanceSources[]> {
  return useResource(instanceIds === null ? null : `installed-sources:${JSON.stringify(instanceIds)}`, () => installedSources());
}

/** plan:<实例>:<platform>:<projectId>:<版本> —— 一起装的前置与已满足项。 */
export function useInstallPlan(instanceId: string | null, platform: Platform, projectId: string, modVersionId: string | null): ResourceResult<InstallPlan> {
  const key = instanceId === null || modVersionId === null ? null : `plan:${instanceId}:${platform}:${projectId}:${modVersionId}`;
  return useResource(key, () => {
    if (instanceId === null || modVersionId === null) throw new Error("未启用的查询不应发出请求");
    return planInstall(instanceId, platform, projectId, modVersionId);
  });
}

/** modpack-preview:<path> —— 本地整合包文件的预览。 */
export function useModpackPreview(path: string | null): ResourceResult<ModpackPreviewDto> {
  return useResource(path === null ? null : `modpack-preview:${path}`, () => {
    if (path === null) throw new Error("未启用的查询不应发出请求");
    return previewModpack(path);
  });
}

/**
 * modpack-summary:<platform>:<projectId>:<versionId> —— 平台整合包的 Mod 数与下载字节，只读远端 zip 的目录与清单、不下载整包。
 * versionId 为 null 时不请求（还没选定版本）。
 */
export function useModpackSummary(platform: Platform, projectId: string, versionId: string | null): ResourceResult<ModpackSummaryDto> {
  return useResource(versionId === null ? null : `modpack-summary:${platform}:${projectId}:${versionId}`, () => {
    if (versionId === null) throw new Error("未启用的查询不应发出请求");
    return summarizePlatformModpack(platform, projectId, versionId);
  });
}
