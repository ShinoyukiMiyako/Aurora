// Java 运行时：扫描本机安装与按主版本自动下载。

import { invoke } from "./bridge";

export interface JavaVersionDto {
  major: number;
  minor: number;
  security: number;
  build: number;
  raw: string;
}

/** 探测来源；managed 为启动器自己下载到数据目录 runtime/ 下的运行时。 */
export type JavaSource = "registry" | "common_dir" | "path" | "managed";

export interface JavaInstallationDto {
  path: string;
  version: JavaVersionDto;
  is_64bit: boolean;
  vendor: string;
  source: JavaSource;
}

export interface InstalledRuntimeDto {
  component: string;
  version: JavaVersionDto;
  java_executable: string;
}

/** 全量探测。识别结果按文件指纹缓存，没变过的 Java 不再重跑 java -version；首次仍可能要数秒。 */
export const detectJava = (): Promise<JavaInstallationDto[]> => invoke<JavaInstallationDto[]>("detect_java");

/** 长任务：进度经 core-event 推送并带 task_id，可用 cancelTask(taskId) 取消。 */
export const installJava = (taskId: string, requiredMajor: number): Promise<InstalledRuntimeDto> =>
  invoke<InstalledRuntimeDto>("install_java", { taskId, requiredMajor });
