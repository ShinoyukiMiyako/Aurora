// 全局设置：读取、按字段更新，以及游戏目录的并存、切换与检查。

import { invoke } from "./bridge";

export type DownloadSourcePolicy = "auto" | "official_first" | "mirror_first";
export type IsolationPolicy =
  | "disabled"
  | "mod_loaders_only"
  | "non_release_only"
  | "mod_loaders_and_non_release"
  | "all";
/** 游戏启动后启动器窗口的去留。 */
export type AfterLaunch = "keep" | "minimize" | "close";
/** 界面语言：BCP 47 语言标签。外壳按它与已有译文推出 <html lang>（没有译文的语言落回中文）。 */
export type UiLanguage = "zh-CN" | "en-US";
export const UI_LANGUAGES: readonly UiLanguage[] = ["zh-CN", "en-US"];

/**
 * config.json 里取值是枚举的字段，嵌套用点号连接。这些字段遇到这个版本不认识的取值时只退回默认，
 * 其余设置照常读入（经启动提示 config_fields_reset 告知）。
 */
export type ConfigEnumField =
  | "download_source"
  | "version_list_source"
  | "isolation_policy"
  | "appearance.mode"
  | "appearance.accent"
  | "after_launch"
  | "language";

/** default_java 取这个值表示按版本自动选择。 */
export const DEFAULT_JAVA_AUTO = "auto";

export interface MemorySettings {
  /** 手动分配的最大堆（MB），不低于 1024。auto 为 true 时启动改用 memoryAdvice 的推荐值，这里保留手动值。 */
  max_mb: number;
  /** 最小堆（MB），1 到 max_mb；null 表示不设。 */
  min_mb: number | null;
  auto: boolean;
}

/** 存档备份：退出游戏后自动备份玩过的存档，自动备份按两条规则清理，手动备份一直保留。 */
export interface WorldBackupSettings {
  auto: boolean;
  /** 每个存档保留的自动备份份数，1 到 50。 */
  keep_per_world: number;
  /** 全部备份的总量上限（GB），1 到 1000；超过时先删最旧的自动备份。 */
  max_total_gb: number;
}

export interface ConfigDto {
  /** 当前游戏目录（.minecraft）绝对路径。 */
  game_dir: string;
  /** 数据目录下的默认游戏目录，「用回默认位置」用它。 */
  default_game_dir: string;
  data_dir: string;
  download_source: DownloadSourcePolicy;
  version_list_source: DownloadSourcePolicy;
  download_concurrency: number;
  memory: MemorySettings;
  isolation_policy: IsolationPolicy;
  has_client_id: boolean;
  auto_download_java: boolean;
  /** "auto" 或 java 可执行文件绝对路径。 */
  default_java: string;
  after_launch: AfterLaunch;
  /** 启动时是否自动检查启动器更新；手动检查不受它限制。 */
  check_updates: boolean;
  cache_directory: string | null;
  selected_version: string | null;
  /** 用户选了「跳过此版本」的启动器版本。 */
  skipped_update_version: string | null;
  /** 自动检查已经提示过的启动器版本，同一版本只提示一次。 */
  notified_update_version: string | null;
  language: UiLanguage;
  /** 手动添加的 java 可执行文件（规范化后的 java.exe 路径），只经 addJavaPath / removeJavaPath 修改。 */
  extra_java_paths: string[];
  /** 启动前把这次用的 java 设为 Windows 图形设置里的高性能显卡。 */
  prefer_dedicated_gpu: boolean;
  world_backup: WorldBackupSettings;
}

/**
 * 参数键为 camelCase，只写出要改的字段。有一个字段不合法整次都不生效：枚举（含 language）、并发、client_id、
 * defaultJava 不合法报 invalid_argument；memory 缺字段或多字段是 Tauri 参数错误，归为 unknown。
 */
export interface ConfigPatch {
  downloadSource?: DownloadSourcePolicy;
  versionListSource?: DownloadSourcePolicy;
  /** 1 到 256。 */
  downloadConcurrency?: number;
  /** 三个字段都必须给出。 */
  memory?: MemorySettings;
  isolationPolicy?: IsolationPolicy;
  autoDownloadJava?: boolean;
  cacheDirectory?: string;
  clientId?: string;
  selectedVersion?: string;
  afterLaunch?: AfterLaunch;
  checkUpdates?: boolean;
  /** "auto"，或存在的 java 可执行文件的绝对路径。 */
  defaultJava?: string;
  skippedUpdateVersion?: string;
  notifiedUpdateVersion?: string;
  language?: UiLanguage;
  preferDedicatedGpu?: boolean;
  /** 三个字段都必须给出；越界报 invalid_argument，detail.field 为 world_backup.keep_per_world 或 world_backup.max_total_gb。 */
  worldBackup?: WorldBackupSettings;
}

export const getConfig = (): Promise<ConfigDto> => invoke<ConfigDto>("get_config");

export const updateConfig = (patch: ConfigPatch): Promise<void> => invoke<void>("update_config", { ...patch });

// ---- 游戏目录 ----

/** 游戏目录不能用时的 IpcError.code；detail 为 { path, problem }。 */
export const INVALID_GAME_DIRECTORY = "invalid_game_directory";
export type GameDirectoryProblem = "empty" | "not_absolute" | "contains_bang" | "unavailable";

export interface GameDirectoryDto {
  name: string;
  path: string;
  is_current: boolean;
  /** 此刻能否访问；为假时记录仍保留（移动硬盘拔了之类）。 */
  available: boolean;
}

export interface NamedDirectoryDto {
  name: string;
  path: string;
}

export interface GameDirectoryInspectionDto {
  exists: boolean;
  /** 已有 versions 文件夹：选它会直接接管已有游戏文件。 */
  has_versions: boolean;
}

/** 全部已知游戏目录：当前目录在前，其余按记录顺序，各目录限时探测是否可达。 */
export const listGameDirectories = (): Promise<GameDirectoryDto[]> => invoke<GameDirectoryDto[]>("list_game_directories");

/** 这台机器上尚未记录的其它启动器的 .minecraft。只报告不写入。 */
export const discoverGameDirectories = (): Promise<NamedDirectoryDto[]> =>
  invoke<NamedDirectoryDto[]>("discover_game_directories");

/** 记下一个额外目录；同路径已记录时只改名字，与当前目录相同时什么都不做。 */
export const addGameDirectory = (name: string, path: string): Promise<void> =>
  invoke<void>("add_game_directory", { name, path });

/** 移除一条额外目录记录（不动磁盘文件），返回是否真的移除了一条。 */
export const removeGameDirectory = (path: string): Promise<boolean> => invoke<boolean>("remove_game_directory", { path });

/** 切换当前游戏目录。目标须此刻可访问（否则 invalid_game_directory / unavailable）；原目录在盘上存在时收进额外目录。 */
export const setGameDirectory = (path: string): Promise<void> => invoke<void>("set_game_directory", { path });

/** 检查一个候选目录是否存在、是否已有游戏文件。 */
export const inspectGameDirectory = (path: string): Promise<GameDirectoryInspectionDto> =>
  invoke<GameDirectoryInspectionDto>("inspect_game_directory", { path });
