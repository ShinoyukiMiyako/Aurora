// 新建实例、设置页用到的静态与本机数据：版本清单、加载器版本、Java、显卡、内存建议、游戏目录、启动器更新。

import {
  discoverGameDirectories,
  inspectGameDirectory,
  listGameDirectories,
  type GameDirectoryDto,
  type GameDirectoryInspectionDto,
  type NamedDirectoryDto,
} from "../../ipc/config";
import { detectJava, gpuAdapters, type GpuAdaptersDto, type JavaInstallationDto } from "../../ipc/java";
import {
  listLoaderVersions,
  listManifest,
  requiredJava,
  versionRequirements,
  type LoaderChoice,
  type LoaderVersionDto,
  type ManifestDto,
  type VersionRequirementsDto,
} from "../../ipc/instances";
import { memoryAdvice, updaterInfo, type MemoryAdviceDto, type UpdaterInfoDto } from "../../ipc/system";
import { resources, useResource, type ResourceResult } from "../resource";

export type { GameDirectoryDto, GameDirectoryInspectionDto, GameDirectoryProblem, NamedDirectoryDto } from "../../ipc/config";
export type { GpuAdapterDto, GpuAdaptersDto, JavaInstallationDto, JavaSource, JavaVersionDto } from "../../ipc/java";
export type { LoaderChoice, LoaderVersionDto, ManifestDto, ManifestVersionDto, VersionRequirementsDto } from "../../ipc/instances";
export type { MemoryAdviceDto, UpdaterInfoDto } from "../../ipc/system";

/** manifest —— 每个版本附可装的加载器；断网时为缓存，stale_since 与 fetch_error 说明情况。 */
export function useManifest(): ResourceResult<ManifestDto> {
  return useResource("manifest", listManifest);
}

/** loader-versions:<loader>:<mc>；mcVersion 为 null 时不请求。 */
export function useLoaderVersions(loader: LoaderChoice | null, mcVersion: string | null): ResourceResult<LoaderVersionDto[]> {
  const key = loader === null || mcVersion === null ? null : `loader-versions:${loader}:${mcVersion}`;
  return useResource(key, () => {
    if (loader === null || mcVersion === null) throw new Error("未启用的查询不应发出请求");
    return listLoaderVersions(loader, mcVersion);
  });
}

/** version-requirements:<mc> —— 新建这个版本要的 Java 主版本与全新下载的字节数（有库没标大小时为 null）。 */
export function useVersionRequirements(mcVersion: string | null): ResourceResult<VersionRequirementsDto> {
  return useResource(mcVersion === null ? null : `version-requirements:${mcVersion}`, () => {
    if (mcVersion === null) throw new Error("未启用的查询不应发出请求");
    return versionRequirements(mcVersion);
  });
}

/** required-java:<mc> —— 该游戏版本要求的 Java 主版本。 */
export function useRequiredJava(mcVersion: string | null): ResourceResult<number> {
  return useResource(mcVersion === null ? null : `required-java:${mcVersion}`, () => {
    if (mcVersion === null) throw new Error("未启用的查询不应发出请求");
    return requiredJava(mcVersion);
  });
}

/** java —— 本机 Java 全量探测；Java 下载完成后失效。 */
export function useJavaRuntimes(): ResourceResult<JavaInstallationDto[]> {
  return useResource("java", detectJava);
}

/** gpu-adapters —— 本机硬件显卡与是否可切换，显卡卡片据此决定说明；崩溃页只在有显卡线索时读（enabled 为 false 时不请求）。 */
export function useGpuAdapters(enabled = true): ResourceResult<GpuAdaptersDto> {
  return useResource(enabled ? "gpu-adapters" : null, gpuAdapters);
}

/** memory-advice:<id> 或 memory-advice（按主页当前实例 / 原版估算）。 */
export function useMemoryAdvice(versionId: string | null): ResourceResult<MemoryAdviceDto> {
  return useResource(versionId === null ? "memory-advice" : `memory-advice:${versionId}`, () =>
    versionId === null ? memoryAdvice() : memoryAdvice(versionId),
  );
}

const GAME_DIRS_KEY = "game-dirs";

/** game-dirs —— 已知游戏目录；切换、添加、移除后失效。 */
export function useGameDirectories(): ResourceResult<GameDirectoryDto[]> {
  return useResource(GAME_DIRS_KEY, listGameDirectories);
}

/**
 * 预取 game-dirs，外壳在主界面出来后调一次。实例库的工具条按登记的目录数决定有没有目录选择：第一次进实例库才去要的话，
 * 目录选择晚一个往返才淡入插进来、把搜索框挤开。缓存里已有、或已有请求在路上时不再请求。
 * 只取这一次、不常驻订阅：之后的失效与重读照旧由在看的页面负责。没人订阅时失效（切换目录、移动实例之后）会直接丢掉条目，
 * 下一次进实例库目录选择照样晚到；工具条为此按带目录选择的宽度占位，晚到不改变它的行数，这里不必常驻订阅去兜。
 * 用一次性订阅而不是 read：失败照常记进条目并通知错误旁听者，没人订阅的出错条目随即丢掉、页面订阅时重新请求，
 * 这里不必再接一个没人处理的 Promise。
 */
export function prefetchGameDirectories(): void {
  const settled = () => resources.snapshot(GAME_DIRS_KEY).status !== "loading";
  // 订阅只在没有数据、也没有请求在路上时才发请求，且不会在 subscribe 里同步通知：stop 在第一次通知之前已经赋值
  const stop = resources.subscribe(GAME_DIRS_KEY, listGameDirectories, () => {
    if (settled()) stop();
  });
  if (settled()) stop();
}

/** game-dirs:discovered —— 本机其他启动器的 .minecraft，只报告不写入。 */
export function useDiscoveredGameDirectories(): ResourceResult<NamedDirectoryDto[]> {
  return useResource("game-dirs:discovered", discoverGameDirectories);
}

/** game-dirs:inspect:<path> —— 候选目录是否存在、是否已有游戏文件。 */
export function useGameDirectoryInspection(path: string | null): ResourceResult<GameDirectoryInspectionDto> {
  return useResource(path === null ? null : `game-dirs:inspect:${path}`, () => {
    if (path === null) throw new Error("未启用的查询不应发出请求");
    return inspectGameDirectory(path);
  });
}

/** updater —— 启动器更新的能力与状态。 */
export function useUpdaterInfo(): ResourceResult<UpdaterInfoDto> {
  return useResource("updater", updaterInfo);
}
