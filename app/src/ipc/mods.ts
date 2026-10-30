// 实例内的 Mod：列表、启停、移除、更新检查与更新；下载页的版本列表、落位矩阵与安装计划。
// 字段名与后端 DTO 的 serde 名一致（snake_case），入参键为 camelCase。

import { invoke } from "./bridge";
import type { PlatformId } from "./discover";
import { isIpcError } from "./errors";

export type ModLoader = "fabric" | "quilt" | "forge" | "neoforge" | "liteloader";

/** 改动 mods 目录时文件正被占用（游戏运行中）的错误码；`detail.path` 为被占用的文件。 */
export const MOD_FILE_BUSY_ERROR_CODE = "mod_file_busy";

export function isModFileBusy(error: unknown): boolean {
  return isIpcError(error) && error.code === MOD_FILE_BUSY_ERROR_CODE;
}

export type MetadataFormat = "fabric" | "quilt_mod_json" | "forge_toml" | "neo_forge_toml";

export interface ModMetadata {
  mod_id: string;
  name: string | null;
  version: string | null;
  description: string | null;
  authors: string[];
  /** 声明的依赖 mod id（含 minecraft / fabricloader 这类平台伪 mod，原样列出）。 */
  depends: string[];
  /** 声明支持的 MC 版本约束原文。 */
  minecraft_version: string | null;
  /** jar 内的图标条目路径。 */
  icon: string | null;
  loader: ModLoader;
  format: MetadataFormat;
}

/** 已装 Mod 在卷宗里的平台来源。 */
export interface ModSource {
  platform: PlatformId;
  project_id: string;
  version_id: string;
  version_number: string | null;
  title: string | null;
  /** 作为谁的前置被带进来的（project_id）；玩家主动装的为 null。 */
  dependency_of: string | null;
}

export interface InstalledMod {
  path: string;
  /** 磁盘上的文件名，禁用态带 `.disabled` 后缀。 */
  file_name: string;
  enabled: boolean;
  size: number;
  /** 文件修改时刻，UNIX 毫秒。 */
  modified_ms: number;
  metadata: ModMetadata | null;
  /** 平台给的工程图标；来源不明或平台没给为 null。 */
  icon_url: string | null;
  /** 来源不明（手动放进来、还没被识别）为 null。 */
  source: ModSource | null;
}

export type ReleaseChannel = "release" | "beta" | "alpha";
export type DependencyKind = "required" | "optional" | "incompatible" | "embedded" | "tool";

export interface ModDependency {
  project_id: string | null;
  version_id: string | null;
  kind: DependencyKind;
}

export interface ModVersionInfo {
  version_id: string;
  project_id: string;
  platform: PlatformId;
  name: string;
  version_number: string;
  release_channel: ReleaseChannel;
  game_versions: string[];
  loaders: ModLoader[];
  file_name: string;
  file_size: number | null;
  sha1: string | null;
  download_url: string | null;
  /** ISO 8601；平台没给为空串。 */
  date_published: string;
  dependencies: ModDependency[];
}

export interface UpdateCandidate {
  /** 启用态文件名（磁盘上可能多一个 `.disabled`）。 */
  file_name: string;
  title: string | null;
  current_version_id: string;
  current_version_number: string | null;
  latest: ModVersionInfo;
}

export interface ModUpdateOutcomeDto {
  file_name: string;
  path: string;
  platform: PlatformId;
}

export type Compatibility =
  | { kind: "match" }
  /** 平台元数据不全或认不出实例版本：软提示，仍可安装。 */
  | { kind: "unknown"; reason: string }
  | { kind: "mismatch"; reason: string };

/** 落位矩阵的四态：兼容 / 可能可行 / 已安装 / 不兼容。数组已按这个顺序排好。 */
export type MatchState = "compatible" | "maybe" | "installed" | "incompatible";

export interface InstalledCopy {
  file_name: string;
  version_id: string;
  version_number: string | null;
}

export interface InstanceMatch {
  version_id: string;
  mc_version: string | null;
  /** 实例已装加载器的小写名（OptiFine 也照实列出）。 */
  loaders: string[];
  state: MatchState;
  compatibility: Compatibility;
  best_version: ModVersionInfo | null;
  installed: InstalledCopy | null;
}

export interface PlannedItem {
  version: ModVersionInfo;
  title: string | null;
  icon_url: string | null;
  /** 因谁被带进来（project_id）；玩家选的主项为 null。 */
  required_by: string | null;
  /** 已装在实例里，本次跳过下载。 */
  already_satisfied: boolean;
}

export interface InstallPlan {
  /** items[0] 恒为玩家选的主项，其余为必需前置。 */
  items: PlannedItem[];
  /** 跳过的依赖，每条一句给玩家看的说明。 */
  skipped: string[];
}

export const listMods = (versionId: string): Promise<InstalledMod[]> => invoke<InstalledMod[]>("list_mods", { versionId });

/** 返回改名后的磁盘绝对路径。 */
export const setModEnabled = (versionId: string, fileName: string, enabled: boolean): Promise<string> =>
  invoke<string>("set_mod_enabled", { versionId, fileName, enabled });

/** 移除一个 Mod 文件；变更历史里记一条移除事件。 */
export const removeMod = (versionId: string, fileName: string): Promise<void> => invoke<void>("remove_mod", { versionId, fileName });

export const checkUpdates = (versionId: string): Promise<UpdateCandidate[]> => invoke<UpdateCandidate[]>("check_updates", { versionId });

/** 长任务：进度经 core-event 推送并带 task_id，可用 cancelTask(taskId) 取消。旧文件留作 `.old` 备份，可在变更历史里回滚。 */
export const updateMod = (taskId: string, versionId: string, fileName: string, modVersionId: string): Promise<ModUpdateOutcomeDto> =>
  invoke<ModUpdateOutcomeDto>("update_mod", { taskId, versionId, fileName, modVersionId });

/** 工程的可用版本（发布时间倒序）；两个过滤维度传空数组表示不过滤。 */
export const listModVersions = (
  platform: PlatformId,
  projectId: string,
  gameVersions: string[],
  loaders: ModLoader[],
): Promise<ModVersionInfo[]> => invoke<ModVersionInfo[]>("list_mod_versions", { platform, projectId, gameVersions, loaders });

/** 工程对全部已装实例的落位矩阵；给出 modVersionId 时只按这个版本判定。 */
export const matchInstances = (platform: PlatformId, projectId: string, modVersionId: string | null): Promise<InstanceMatch[]> =>
  invoke<InstanceMatch[]>("match_instances", { platform, projectId, modVersionId });

export const planInstall = (versionId: string, platform: PlatformId, projectId: string, modVersionId: string): Promise<InstallPlan> =>
  invoke<InstallPlan>("plan_install", { versionId, platform, projectId, modVersionId });
