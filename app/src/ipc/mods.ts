// 实例内已安装的 Mod：列出与启停（启停靠增删 .disabled 后缀改文件名）。

import { invoke } from "./bridge";

export type ModLoader = "fabric" | "quilt" | "forge" | "neoforge" | "liteloader";

export interface ModMetadata {
  mod_id: string;
  name: string | null;
  version: string | null;
  description: string | null;
  authors: string[];
  loader: ModLoader;
  format: string;
}

export interface InstalledMod {
  path: string;
  file_name: string;
  enabled: boolean;
  metadata: ModMetadata | null;
}

export const listMods = (versionId: string): Promise<InstalledMod[]> => invoke<InstalledMod[]>("list_mods", { versionId });

/** 返回改名后的磁盘绝对路径。 */
export const setModEnabled = (versionId: string, fileName: string, enabled: boolean): Promise<string> =>
  invoke<string>("set_mod_enabled", { versionId, fileName, enabled });
