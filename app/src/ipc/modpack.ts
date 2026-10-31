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
  /** 导入后落进 mods/ 的 Mod 数：落进 mods/ 的远程文件加上覆盖层 mods/ 下的 .jar，与平台摘要同一口径。 */
  mod_files: number;
  /** 远程文件总字节数；平台没给齐每个文件的大小时为 null。 */
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
  /** 导入后落进 mods/ 的 Mod 数，与本地预览同一口径；CurseForge 的远程文件按工程大类认，与导入的落点一致。 */
  mod_files: number;
  /** 远程文件总字节数；平台没给齐每个文件的大小时为 null。 */
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

/**
 * 读本地整合包的清单与条目表（不解压）。CurseForge 清单有远程文件时后端另问两个批量接口来数 Mod、算下载量，
 * 没配 API key 时报 CurseForge 源被禁用的同一个错误。
 */
export const previewModpack = (path: string): Promise<ModpackPreviewDto> => invoke<ModpackPreviewDto>("preview_modpack", { path });

/**
 * 平台整合包某个版本的 Mod 数与要下载的字节，供安装前确认。只按范围读包末尾的目录与清单条目，
 * 不下载整包；服务器不支持范围读取、包不是可读的 zip 或缺清单时报 remote_pack_unreadable（detail.url、detail.reason）。
 * CurseForge 另问批量文件与批量工程两个接口，没配 API key 时报 CurseForge 源被禁用的同一个错误。
 */
export const summarizePlatformModpack = (platform: Platform, projectId: string, versionId: string): Promise<ModpackSummaryDto> =>
  invoke<ModpackSummaryDto>("summarize_platform_modpack", { platform, projectId, versionId });

/**
 * 长任务：把整合包导入为新实例。name 为 null 时用整合包自己的名字。
 * 进度经 core-event 推送并带 task_id，可用 cancelTask(taskId) 取消；失败或取消后不留半成品实例。
 */
export const installModpack = (taskId: string, source: ModpackSource, name: string | null): Promise<ModpackInstallOutcomeDto> =>
  invoke<ModpackInstallOutcomeDto>("install_modpack", { taskId, source, name });

// ---------------------------------------------------------------- 导出

/** 随整合包一起打包的实例内容；顺序即界面顺序，也是发给后端的顺序。 */
export type ExportExtra = "config" | "defaultconfigs" | "kubejs" | "resourcepacks" | "shaderpacks" | "options" | "saves";
export const EXPORT_EXTRAS: readonly ExportExtra[] = ["config", "defaultconfigs", "kubejs", "resourcepacks", "shaderpacks", "options", "saves"];

/** 在 Modrinth 上找得到的启用 Mod：只写进索引，导入的人从 Modrinth 下载。 */
export interface ExportIndexedModDto {
  file_name: string;
  path: string;
  size: number;
  project_id: string;
  version_id: string;
  /** 卷宗里记下的名称；按哈希查到的为 null。 */
  title: string | null;
  /** ledger：卷宗记的版本里就有这个文件；hash：按文件哈希查到。 */
  matched_by: "ledger" | "hash";
}

/** 要把文件本身打包进去的 Mod。 */
export interface ExportBundledModDto {
  file_name: string;
  path: string;
  size: number;
  /** unlisted：Modrinth 上查不到；curseforge：卷宗记为 CurseForge（它的下载地址不能写进整合包）；disabled：停用的 Mod。 */
  reason: "unlisted" | "curseforge" | "disabled";
}

export interface ExportExtraStatDto {
  extra: ExportExtra;
  /** 过滤后的文件数；为 0 即实例里没有这一项。 */
  files: number;
  bytes: number;
  /** 存档以外、实例里有的项默认勾选。 */
  default_selected: boolean;
}

/** 导出前的盘面：每次读取都按此刻的文件重算。 */
export interface ModpackExportPreviewDto {
  /** 默认名称与版本号：实例记下的整合包信息，没有时为实例名与 1.0.0。 */
  name: string;
  version: string;
  minecraft: string;
  loader: PackLoader | null;
  indexed: ExportIndexedModDto[];
  bundled: ExportBundledModDto[];
  disabled: ExportBundledModDto[];
  extras: ExportExtraStatDto[];
  /** 名字不能安全写进整合包、不会打包的文件（正斜杠相对路径）。 */
  skipped: string[];
}

/** 嵌套对象的键是 snake_case；后端拒绝不认识的键。 */
export interface ModpackExportOptions {
  /** 系统保存对话框给的绝对路径，扩展名 .mrpack。 */
  destination: string;
  name: string;
  version: string;
  summary: string | null;
  extras: ExportExtra[];
  include_disabled: boolean;
}

export interface ModpackExportOutcomeDto {
  path: string;
  name: string;
  version: string;
  bytes: number;
  indexed_files: number;
  override_files: number;
  /** 打包进文件的启用 Mod 的文件名。 */
  bundled_mods: string[];
  /** 实际带上的停用 Mod 数。 */
  disabled_mods: number;
  skipped: string[];
}

/** 错误码 modpack_export_unsupported 的 detail.reason。 */
export type ExportBlockReason = "version_unknown" | "loader_unsupported" | "loader_version_unknown" | "multiple_loaders" | "incomplete";

/** 只读、不占实例：Mod 走 Modrinth 索引还是打包进文件、各额外项的文件数与体积。实例不能导出时报 modpack_export_unsupported。 */
export const previewModpackExport = (id: string): Promise<ModpackExportPreviewDto> => invoke<ModpackExportPreviewDto>("preview_modpack_export", { id });

/**
 * 长任务：把实例导出为 .mrpack。后端按此刻的盘面重新规划，不信任前端带回的清单；占实例的「改动中」，
 * 与游戏运行、装 Mod 兼容。先写到同目录的临时文件、回读校验通过后才换到 destination，失败或取消不留文件。
 */
export const exportModpack = (taskId: string, id: string, options: ModpackExportOptions): Promise<ModpackExportOutcomeDto> =>
  invoke<ModpackExportOutcomeDto>("export_modpack", { taskId, id, options });

/** 在系统文件管理器里选中导出的文件（opener 插件）。 */
export const revealExportedPack = (path: string): Promise<void> => invoke<void>("plugin:opener|reveal_item_in_dir", { paths: [path] });
