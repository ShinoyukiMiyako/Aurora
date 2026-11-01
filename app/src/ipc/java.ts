// Java 运行时：扫描本机安装、手动添加与移除、按主版本自动下载，以及本机显卡（独显偏好的提示依据）。

import { invoke } from "./bridge";

export interface JavaVersionDto {
  major: number;
  minor: number;
  security: number;
  build: number;
  raw: string;
}

/**
 * 探测来源；managed 为启动器自己下载到数据目录 runtime/ 下的运行时，manual 为用户经「添加 Java」记下的，
 * java_home 来自环境变量 JAVA_HOME。
 */
export type JavaSource = "registry" | "common_dir" | "path" | "managed" | "manual" | "java_home";

export interface JavaInstallationDto {
  path: string;
  version: JavaVersionDto;
  is_64bit: boolean;
  vendor: string;
  source: JavaSource;
  /** 缺失的运行时文件（相对安装根、用 / 分隔，如 release、lib/modules），空为完整。不完整的不参与自动选择。 */
  missing_files: string[];
}

export interface InstalledRuntimeDto {
  component: string;
  version: JavaVersionDto;
  java_executable: string;
}

export interface RemoveJavaPathDto {
  /** 记录里确实有这一条并删掉了；本来就不在时为 false。 */
  removed: boolean;
  /** 默认 Java 正是它，随之改回了自动选择。 */
  default_reset: boolean;
}

export interface GpuAdapterDto {
  name: string;
  vendor_id: number;
  dedicated_video_memory_mb: number;
  /** 按高性能偏好排在第一的那块。 */
  high_performance: boolean;
  /** 按省电偏好排在第一的那块。 */
  power_saving: boolean;
}

export interface GpuAdaptersDto {
  /** 只含硬件适配器，按高性能偏好排序。 */
  adapters: GpuAdapterDto[];
  /** 至少两块硬件显卡，且高性能与省电偏好挑出的不是同一块。 */
  switchable: boolean;
}

/** 手动添加的路径不能用时的 IpcError.code；detail 为 { path, reason: JavaPathProblem }。 */
export const JAVA_PATH_INVALID = "java_path_invalid";
/** 手动添加的 Java 缺少运行时文件；detail 为 { path, missing: string[] }。 */
export const JAVA_RUNTIME_INCOMPLETE = "java_runtime_incomplete";
export type JavaPathProblem = "not_absolute" | "not_java_executable" | "not_found" | "probe_failed" | "probe_timeout";

/** 全量探测。识别结果按文件指纹缓存，没变过的 Java 不再重跑 java -version；首次仍可能要数秒。 */
export const detectJava = (): Promise<JavaInstallationDto[]> => invoke<JavaInstallationDto[]>("detect_java");

/** 长任务：进度经 core-event 推送并带 task_id，可用 cancelTask(taskId) 取消。 */
export const installJava = (taskId: string, requiredMajor: number): Promise<InstalledRuntimeDto> =>
  invoke<InstalledRuntimeDto>("install_java", { taskId, requiredMajor });

/**
 * 记下一个手动指定的 java.exe / javaw.exe：后端识别一次（最多 10 秒），残缺的拒绝。javaw.exe 按同目录的 java.exe 记录，
 * 返回的 path 是规范化后的那个。已记下的路径再加一次照常成功。
 */
export const addJavaPath = (path: string): Promise<JavaInstallationDto> => invoke<JavaInstallationDto>("add_java_path", { path });

/** 移除一条手动添加的记录（不动磁盘文件）；它是默认 Java 时默认 Java 同时改回自动选择。 */
export const removeJavaPath = (path: string): Promise<RemoveJavaPathDto> => invoke<RemoveJavaPathDto>("remove_java_path", { path });

/** 本机硬件显卡与是否可切换；非 Windows 为空列表。 */
export const gpuAdapters = (): Promise<GpuAdaptersDto> => invoke<GpuAdaptersDto>("gpu_adapters");
