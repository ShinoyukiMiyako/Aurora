// 发现与安装：搜索、详情、版本、落位矩阵与安装计划，以及本地整合包预览。
// 搜索的防抖与分页累积归页面：这里一组参数就是一页，换参数即换 key。

import type { Platform } from "../../domain/types";
import { projectDetail, searchResources, type ProjectDetail, type SearchArgs, type SearchResultDto } from "../../ipc/discover";
import { previewModpack, type ModpackPreviewDto } from "../../ipc/modpack";
import { listModVersions, matchInstances, planInstall, type InstallPlan, type InstanceMatch, type ModLoader, type ModVersionInfo } from "../../ipc/mods";
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
export type { ModpackPreviewDto, ModpackSource, PackFormat, PackLoader } from "../../ipc/modpack";
export type { Compatibility, InstallPlan, InstanceMatch, MatchState, ModDependency, ModLoader, ModVersionInfo, PlannedItem } from "../../ipc/mods";

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

/** mod-versions:<platform>:<projectId>:<过滤 JSON>；两个过滤维度传空数组表示不过滤。 */
export function useModVersions(platform: Platform, projectId: string, gameVersions: string[], loaders: ModLoader[]): ResourceResult<ModVersionInfo[]> {
  return useResource(`mod-versions:${platform}:${projectId}:${JSON.stringify([gameVersions, loaders])}`, () =>
    listModVersions(platform, projectId, gameVersions, loaders),
  );
}

/** match:<platform>:<projectId>:<版本或 auto> —— 全部实例的落位矩阵；实例增删后失效（instances 前缀不覆盖它，页面按需 reload）。 */
export function useInstanceMatches(platform: Platform, projectId: string, modVersionId: string | null): ResourceResult<InstanceMatch[]> {
  return useResource(`match:${platform}:${projectId}:${modVersionId === null ? "auto" : modVersionId}`, () =>
    matchInstances(platform, projectId, modVersionId),
  );
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
