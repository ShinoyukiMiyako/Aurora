// 整合包：预览本地整合包文件，把平台或本地整合包导入为新实例。

import type { Platform } from "../domain/types";
import { invoke } from "./bridge";
import { isIpcError } from "./errors";

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

/** 包里一个文件从哪来：清单里要下载的远程文件，或覆盖层里随包带着的文件。 */
export type PackFileOrigin = "remote" | "override";
/**
 * 这个文件导入时怎么到手：download 照常下载；bundled 随包自带；blocked 作者不允许启动器直接下载、下载文件夹里也还没认领到；
 * claimed 已从用户手动下载的文件里认领、校验通过。
 */
export type PackFileAvailability = "download" | "bundled" | "blocked" | "claimed";

export interface PackModDto {
  /** 相对实例目录、正斜杠的落点，如 mods/sodium.jar。 */
  path: string;
  file_name: string;
  origin: PackFileOrigin;
  /** Modrinth 清单里 env.client 为 optional 的文件；只有它能在导入前取消勾选。 */
  optional: boolean;
  /** CurseForge 远程文件的工程与文件 id；Modrinth 文件与覆盖层文件为 null。 */
  project_id: number | null;
  file_id: number | null;
  availability: PackFileAvailability;
}

/** 作者不允许启动器直接下载、要到 CurseForge 网页手动下载的文件。 */
export interface BlockedFileDto {
  project_id: number;
  file_id: number;
  file_name: string;
  /** 这个文件在 CurseForge 上的文件页。 */
  web_url: string;
  /** 相对实例目录、正斜杠的落点，如 mods/foo.jar。 */
  destination: string;
  sha1: string | null;
  /** 平台的文件指纹；0 表示平台没给。 */
  fingerprint: number;
  size: number | null;
}

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
  /** 导入后落进 mods/ 的每个 Mod，按落点排序；条数等于 mod_files。 */
  mods: PackModDto[];
  /** 不直接落进 mods/ 的可选文件（资源包、光影、配置）。 */
  optional_extras: PackModDto[];
  /** 需要手动下载、还没认领到的文件。 */
  blocked_files: BlockedFileDto[];
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

export interface ClaimedFileDto {
  file_id: number;
  /** 认领自哪个文件；暂存位里本来就有的给暂存路径。 */
  source_path: string;
}

/** 一次认领的结果：claimed 与 missing 合起来覆盖入参的每个文件，missing 按入参顺序。 */
export interface ClaimReportDto {
  claimed: ClaimedFileDto[];
  missing: number[];
}

/** 有文件需要到 CurseForge 网页手动下载（detail.files 为 BlockedFileDto[]）。 */
export const DISTRIBUTION_BLOCKED = "distribution_blocked";
/** CurseForge 拒绝了下载密钥（detail.realm、url、status）。 */
export const CURSEFORGE_KEY_REJECTED = "curseforge_key_rejected";
/** 整合包用了不支持的压缩方式（detail.path、entry、method）。 */
export const MODPACK_UNSUPPORTED_COMPRESSION = "modpack_unsupported_compression";

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
 * 长任务：把整合包导入为新实例。name 为 null 时用整合包自己的名字。excludedOptional 是不装的可选文件落点，
 * 不是这个包里的可选文件时报 invalid_argument（detail.path）。
 * 进度经 core-event 推送并带 task_id，可用 cancelTask(taskId) 取消；失败或取消后不留半成品实例。
 * 还有需要手动下载的文件时以 distribution_blocked 失败，detail.files 只列没认领到的。
 */
export const installModpack = (taskId: string, source: ModpackSource, name: string | null, excludedOptional: readonly string[]): Promise<ModpackInstallOutcomeDto> =>
  invoke<ModpackInstallOutcomeDto>("install_modpack", { taskId, source, name, excludedOptional });

/**
 * 从用户选的文件夹里认领手动下载的文件：只看文件夹顶层，按文件名或大小挑候选，再按 sha1 或指纹校验，
 * 命中的复制进暂存位（原文件不动）。不联网、不占实例；文件夹读不了时报 io（detail.path）。
 */
export const claimBlockedFiles = (folder: string, files: readonly BlockedFileDto[]): Promise<ClaimReportDto> =>
  invoke<ClaimReportDto>("claim_blocked_files", { folder, files });

/** 系统的下载文件夹，选文件夹对话框的默认位置；找不到时报 io。 */
export const downloadsFolder = (): Promise<string> => invoke<string>("downloads_folder");

function field(record: Record<string, unknown>, key: string, where: string): unknown {
  if (!(key in record)) throw new Error(`${where} 缺少 ${key}`);
  return record[key];
}

function wholeNumber(value: unknown, what: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new Error(`${what} 应是非负整数，实为 ${JSON.stringify(value)}`);
  return value;
}

function text(value: unknown, what: string): string {
  if (typeof value !== "string" || value === "") throw new Error(`${what} 应是非空字符串，实为 ${JSON.stringify(value)}`);
  return value;
}

/** 逐项校验一份需要手动下载的文件清单（来自错误详情或任务日志），形状不对就抛错。 */
export function parseBlockedFiles(raw: unknown, where: string): BlockedFileDto[] {
  if (!Array.isArray(raw)) throw new Error(`${where} 应是数组，实为 ${JSON.stringify(raw)}`);
  return raw.map((item: unknown, i) => {
    const at = `${where}[${i}]`;
    if (typeof item !== "object" || item === null || Array.isArray(item)) throw new Error(`${at} 应是对象，实为 ${JSON.stringify(item)}`);
    const r = item as Record<string, unknown>;
    const sha1 = field(r, "sha1", at);
    const size = field(r, "size", at);
    return {
      project_id: wholeNumber(field(r, "project_id", at), `${at}.project_id`),
      file_id: wholeNumber(field(r, "file_id", at), `${at}.file_id`),
      file_name: text(field(r, "file_name", at), `${at}.file_name`),
      web_url: text(field(r, "web_url", at), `${at}.web_url`),
      destination: text(field(r, "destination", at), `${at}.destination`),
      sha1: sha1 === null ? null : text(sha1, `${at}.sha1`),
      fingerprint: wholeNumber(field(r, "fingerprint", at), `${at}.fingerprint`),
      size: size === null ? null : wholeNumber(size, `${at}.size`),
    };
  });
}

/** 错误码是 distribution_blocked 时，逐项校验 detail.files 并返回清单，形状不对就抛错；其余错误返回 null。 */
export function blockedFilesOf(error: unknown): BlockedFileDto[] | null {
  if (!isIpcError(error) || error.code !== DISTRIBUTION_BLOCKED) return null;
  const detail = error.detail;
  if (typeof detail !== "object" || detail === null) throw new Error(`distribution_blocked 没有带 detail：${error.message}`);
  const files = parseBlockedFiles((detail as Record<string, unknown>).files, "distribution_blocked 的 detail.files");
  if (files.length === 0) throw new Error(`distribution_blocked 的 detail.files 是空的：${error.message}`);
  return files;
}
