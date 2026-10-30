// Java 运行时：扫描本机安装与按主版本自动下载。

import { invoke } from "./bridge";

export interface JavaVersionDto {
  major: number;
  minor: number;
  security: number;
  build: number;
  raw: string;
}

export interface JavaInstallationDto {
  path: string;
  version: JavaVersionDto;
  is_64bit: boolean;
  vendor: string;
  source: "registry" | "common_dir" | "path" | "managed";
}

export interface InstalledRuntimeDto {
  component: string;
  version: JavaVersionDto;
  java_executable: string;
}

export const detectJava = (): Promise<JavaInstallationDto[]> => invoke<JavaInstallationDto[]>("detect_java");

/** 长任务：进度经 core-event 推送并带 task_id，可用 cancelTask(taskId) 取消。 */
export const installJava = (taskId: string, requiredMajor: number): Promise<InstalledRuntimeDto> =>
  invoke<InstalledRuntimeDto>("install_java", { taskId, requiredMajor });
