// 整合包：预览本地整合包文件，把平台或本地整合包导入为新实例。

import type { Platform } from "../domain/types";
import { invoke } from "./bridge";

export type PackFormat = "modrinth" | "curseforge";
export type PackLoaderKind = "fabric" | "quilt" | "forge" | "neoforge";

export interface PackLoader {
  kind: PackLoaderKind;
  version: string;
}

/** 整合包来源。本地路径来自系统文件对话框（WebView 里的文件选择拿不到绝对路径）。 */
export type ModpackSource =
  | { kind: "platform"; platform: Platform; project_id: string; version_id: string }
  | { kind: "file"; path: string };

export interface ModpackPreviewDto {
  format: PackFormat;
  name: string;
  version: string | null;
  summary: string | null;
  author: string | null;
  minecraft: string;
  loader: PackLoader | null;
  remote_files: number;
  /** CurseForge 清单不带文件大小，为 null。 */
  remote_bytes: number | null;
  override_files: number;
  override_bytes: number;
}

/** 平台整合包某个版本的清单摘要：不下载整包，只读包末尾的目录与清单。 */
export interface ModpackSummaryDto {
  format: PackFormat;
  name: string;
  version: string | null;
  minecraft: string;
  loader: PackLoader | null;
  /** 整合包文件本身的字节数。 */
  pack_bytes: number;
  /** 导入时要另外下载的远程文件数。 */
  remote_files: number;
  /** 远程文件里落进 mods/ 的个数；CurseForge 清单分不出哪些是 Mod，为 null。 */
  mod_files: number | null;
  /** 远程文件总字节数；CurseForge 清单不带大小，为 null。 */
  remote_bytes: number | null;
  override_files: number;
  override_bytes: number;
}

/** 实例里记下的整合包信息。 */
export interface InstanceModpack {
  schema: number;
  format: PackFormat;
  /** 来自本地文件时 platform、project_id、version_id 都为 null。 */
  platform: Platform | null;
  project_id: string | null;
  version_id: string | null;
  /** 整合包自己的名字与版本（实例名可以不同）。 */
  name: string;
  version: string | null;
  minecraft: string;
  loader: PackLoader | null;
  remote_files: number;
  override_files: number;
  /** 导入完成的 Unix 秒。 */
  installed_at: number;
}

export interface ModpackInstallOutcomeDto {
  /** 新实例的版本 id，即实例名。 */
  version_id: string;
  version_dir: string;
  modpack: InstanceModpack;
}

/** 错误码 instance_name_invalid 的 detail.rule。 */
export type InstanceNameRule = "empty" | "too_long" | "illegal_char" | "reserved" | "duplicate";

/** 实例名最多字符数，与后端一致。 */
export const INSTANCE_NAME_MAX_CHARS = 32;

export const previewModpack = (path: string): Promise<ModpackPreviewDto> => invoke<ModpackPreviewDto>("preview_modpack", { path });

/**
 * 平台整合包某个版本的 Mod 数与要下载的字节，供安装前确认。只按范围读包末尾的目录与清单条目，
 * 不下载整包；服务器不支持范围读取、包不是可读的 zip 或缺清单时报 remote_pack_unreadable（detail.url、detail.reason）。
 */
export const summarizePlatformModpack = (platform: Platform, projectId: string, versionId: string): Promise<ModpackSummaryDto> =>
  invoke<ModpackSummaryDto>("summarize_platform_modpack", { platform, projectId, versionId });

/**
 * 长任务：把整合包导入为新实例。name 为 null 时用整合包自己的名字。
 * 进度经 core-event 推送并带 task_id，可用 cancelTask(taskId) 取消；失败或取消后不留半成品实例。
 */
export const installModpack = (taskId: string, source: ModpackSource, name: string | null): Promise<ModpackInstallOutcomeDto> =>
  invoke<ModpackInstallOutcomeDto>("install_modpack", { taskId, source, name });
