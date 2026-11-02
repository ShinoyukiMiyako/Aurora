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
import { useResource, type ResourceResult } from "../resource";

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

/** gpu-adapters —— 本机硬件显卡与是否可切换，显卡卡片据此决定说明。 */
export function useGpuAdapters(): ResourceResult<GpuAdaptersDto> {
  return useResource("gpu-adapters", gpuAdapters);
}

/** memory-advice:<id> 或 memory-advice（按主页当前实例 / 原版估算）。 */
export function useMemoryAdvice(versionId: string | null): ResourceResult<MemoryAdviceDto> {
  return useResource(versionId === null ? "memory-advice" : `memory-advice:${versionId}`, () =>
    versionId === null ? memoryAdvice() : memoryAdvice(versionId),
  );
}

/** game-dirs —— 已知游戏目录；切换、添加、移除后失效。 */
export function useGameDirectories(): ResourceResult<GameDirectoryDto[]> {
  return useResource("game-dirs", listGameDirectories);
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
