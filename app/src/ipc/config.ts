// 全局设置：读取、按字段更新、切换游戏目录。

import { invoke } from "./bridge";

export type DownloadSourcePolicy = "auto" | "official_first" | "mirror_first";
export type IsolationPolicy =
  | "disabled"
  | "mod_loaders_only"
  | "non_release_only"
  | "mod_loaders_and_non_release"
  | "all";

export interface MemorySettings {
  max_mb: number;
  min_mb: number | null;
}

export interface ConfigDto {
  game_dir: string;
  data_dir: string;
  download_source: DownloadSourcePolicy;
  version_list_source: DownloadSourcePolicy;
  download_concurrency: number;
  memory: MemorySettings;
  isolation_policy: IsolationPolicy;
  has_client_id: boolean;
  auto_download_java: boolean;
  selected_version: string | null;
}

/** 参数键为 camelCase，只写出要改的字段。 */
export interface ConfigPatch {
  downloadSource?: DownloadSourcePolicy;
  versionListSource?: DownloadSourcePolicy;
  downloadConcurrency?: number;
  memory?: MemorySettings;
  isolationPolicy?: IsolationPolicy;
  autoDownloadJava?: boolean;
  cacheDirectory?: string;
  clientId?: string;
  selectedVersion?: string;
}

export const getConfig = (): Promise<ConfigDto> => invoke<ConfigDto>("get_config");

export const updateConfig = (patch: ConfigPatch): Promise<void> => invoke<void>("update_config", { ...patch });

export const setGameDirectory = (path: string): Promise<void> => invoke<void>("set_game_directory", { path });
