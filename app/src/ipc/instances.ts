// 实例：列表、设置、内容、侧栏固定、新建、补全、删除、改名、打开文件夹，以及新建页要的版本清单、
// 加载器版本与所需 Java。
//
// 会改动实例目录的命令（新建、补全、改名、删除）在实例正忙时以 instance_busy 拒绝，detail.activity
// 指出正在做的事；被别的实例经 inheritsFrom 依赖时以 instance_has_dependents 拒绝。参数类问题一律是
// invalid_argument，detail.field 指出哪一项：名称问题带 detail.rule（见 NameRule），侧栏固定带
// detail.reason（too_many / duplicate / not_found）与 detail.id。

import { invoke } from "./bridge";

export type LoaderChoice = "fabric" | "quilt" | "forge" | "neoforge";
export const LOADER_CHOICES: readonly LoaderChoice[] = ["fabric", "quilt", "forge", "neoforge"];

/** 已装实例里能探测到的加载器，比可安装的多两种。 */
export type DetectedLoaderKind = LoaderChoice | "optifine" | "liteloader";

/** 实例此刻在做的事。 */
export type InstanceActivity = "installing" | "repairing" | "renaming" | "deleting" | "launching" | "running";

export interface LoaderDto {
  kind: DetectedLoaderKind;
  version: string | null;
}

/** 未完成标记里记下的安装内容。 */
export interface InstallSpecDto {
  mc_version: string;
  loader: LoaderChoice | null;
  loader_version: string | null;
}

/** 实例的未完成状态：新建或补全中断、失败、被取消。 */
export interface IncompleteDto {
  /** install：新建没装完；repair：补全没做完；unknown：标记文件读不出来。 */
  kind: "install" | "repair" | "unknown";
  /** pending：进行中，或启动器在进行中被关掉了。 */
  outcome: "pending" | "failed" | "cancelled" | "unknown";
  started_at: number | null;
  spec: InstallSpecDto | null;
  /** 失败原因；标记读不出来时 code 为 marker_unreadable。 */
  error: { code: string; message: string } | null;
}

export interface InstanceDto {
  id: string;
  /** ready：版本 JSON 可用；broken：缺失或损坏，原因见 broken_reason。 */
  status: "ready" | "broken";
  broken_reason: string | null;
  /** 原版版本号；识别不出或 broken 时为 null。 */
  mc_version: string | null;
  loaders: LoaderDto[];
  /** release / snapshot / old_beta / old_alpha。 */
  release_type: string | null;
  is_release: boolean;
  /** 需要的 Java 主版本；继承链断了或 broken 时为 null。 */
  java_major: number | null;
  /** 工作目录 mods/ 下的 Mod 文件数（.jar 与 .jar.disabled）；broken 或设置读不出时为 null。 */
  mod_count: number | null;
  description: string | null;
  /** 封面预设 id；null 时按默认规则推导。 */
  cover: string | null;
  /** 实例设置读不出来的原因；此时 description、cover 为 null。 */
  settings_error: string | null;
  incomplete: IncompleteDto | null;
  /** 实例目录创建时刻（毫秒时间戳）；文件系统不记录时为 null。 */
  created_at: number | null;
  activity: InstanceActivity | null;
}

export type IsolationOverride = "follow_global" | "enabled" | "disabled";

/** 实例设置。读写同一形状，写入时多出或缺少字段都会被拒绝。 */
export interface InstanceSettingsDto {
  description: string | null;
  /** 小写字母、数字与下划线，1 到 64 个。 */
  cover: string | null;
  isolation: IsolationOverride;
  /** 最大内存 MB，至少 1024 且为 512 的整数倍；null 跟随全局。 */
  memory_mb: number | null;
  /** "auto"，或 java 可执行文件的绝对路径。 */
  java: string;
  jvm_args: string;
  /** 宽 320-7680、高 240-4320。 */
  resolution: { width: number; height: number };
  fullscreen: boolean;
}

export type GameModeDto = "survival" | "creative" | "adventure" | "spectator" | "hardcore";

export interface WorldDto {
  dir_name: string;
  /** ok：level.dat 读出来了；missing：没有 level.dat；unreadable：读不出来，原因见 level_error。 */
  level_status: "ok" | "missing" | "unreadable";
  level_error: string | null;
  /** 存档名；读不出来时为 null，界面用 dir_name。 */
  name: string | null;
  mode: GameModeDto | null;
  /** 最后游玩时刻（毫秒时间戳，来自 level.dat）。 */
  last_played: number | null;
  size_bytes: number;
  modified_at: number | null;
}

export interface PackDto {
  file_name: string;
  is_dir: boolean;
  size_bytes: number;
  modified_at: number | null;
}

export interface ResourcePackDto extends PackDto {
  /** 游戏里启用时的加载顺序（从 1 起）；未启用为 null。 */
  load_order: number | null;
}

export interface ShaderPackDto extends PackDto {
  active: boolean;
}

export interface InstanceContentDto {
  resource_packs: ResourcePackDto[];
  shader_packs: ShaderPackDto[];
  worlds: WorldDto[];
}

export interface DeletionPreviewDto {
  id: string;
  /** 随实例一起删掉的存档（实例目录里的；共用目录的存档不受影响）。 */
  worlds: WorldDto[];
  size_bytes: number;
  file_count: number;
  /** 依赖它的实例；非空时删除会以 instance_has_dependents 拒绝。 */
  dependents: string[];
  /** 非空时删除会以 instance_busy 拒绝。 */
  activity: InstanceActivity | null;
}

export interface InstallResultDto {
  id: string;
  mc_version: string;
  loader: { kind: LoaderChoice; version: string } | null;
  libraries: number;
  assets: number;
  natives: number;
}

export interface RepairResultDto {
  /** 是否按记下的安装内容重装（新建没装完的实例）。 */
  reinstalled: boolean;
  libraries: number;
  assets: number;
  natives: number;
}

export interface LoaderVersionDto {
  version: string;
  stable: boolean;
}

export interface ManifestVersionDto {
  id: string;
  /** release / snapshot / old_beta / old_alpha。 */
  release_type: string;
  release_time: string;
  /** 可以装在这个版本上的加载器，固定按 fabric、quilt、forge、neoforge 的顺序。 */
  loaders: LoaderChoice[];
}

export interface ManifestDto {
  latest: { release: string; snapshot: string };
  versions: ManifestVersionDto[];
  /** 拉不到、也没有缓存的加载器；它们不出现在任何版本的 loaders 里。 */
  loader_errors: { loader: LoaderChoice; message: string }[];
  /** 有数据来自离线缓存时，最旧那份缓存的时刻（毫秒时间戳）；全部新鲜时为 null。 */
  stale_since: number | null;
  fetch_error: string | null;
}

/** open_folder 能打开的文件夹。game_dir 不需要 id；world 还需要存档文件夹名。 */
export type FolderTarget =
  | "game_dir"
  | "instance"
  | "mods"
  | "saves"
  | "resourcepacks"
  | "shaderpacks"
  | "logs"
  | "screenshots"
  | "world";

// ---------------------------------------------------------------- 命名规则

/** 名称长度上限，按 UTF-16 码元计（与输入框 maxLength 的计法一致）。 */
export const INSTANCE_NAME_MAX_UNITS = 32;

/** 名称规则码，按校验顺序；与后端 invalid_argument 的 detail.rule 一致。 */
export type NameRule = "empty" | "too_long" | "illegal_char" | "reserved" | "leading_dot" | "duplicate";

export const ILLEGAL_NAME_CHARS: readonly string[] = ["\\", "/", ":", "*", "?", '"', "<", ">", "|"];

const RESERVED_NAMES = [
  "CON",
  "PRN",
  "AUX",
  "NUL",
  ...Array.from({ length: 9 }, (_, i) => `COM${i + 1}`),
  ...Array.from({ length: 9 }, (_, i) => `LPT${i + 1}`),
];

/**
 * 实例名称校验，返回第一条不满足的规则，全部满足为 null。与后端落盘前的校验逐条一致：
 * 去空白后为空、超长、含非法字符、Windows 不接受（以点或空格结尾、保留设备名含带扩展名的、控制字符）、
 * 以点开头、与现有实例不分大小写重名。改名时 current 传实例自己的 id，与自己同名（含只改大小写）不算重名。
 */
export function checkInstanceName(name: string, existing: readonly string[], current: string | null = null): NameRule | null {
  if (name.trim() === "") return "empty";
  if (name.length > INSTANCE_NAME_MAX_UNITS) return "too_long";
  if ([...name].some((c) => ILLEGAL_NAME_CHARS.includes(c))) return "illegal_char";
  const stem = name.split(".")[0].replace(/ +$/, "").toUpperCase();
  if (name.endsWith(".") || name.endsWith(" ") || RESERVED_NAMES.includes(stem) || /\p{Cc}/u.test(name)) return "reserved";
  if (name.startsWith(".")) return "leading_dot";
  const folded = name.toLowerCase();
  if (existing.some((other) => other !== current && other.toLowerCase() === folded)) return "duplicate";
  return null;
}

// ---------------------------------------------------------------- 命令

/** 全部实例，版本、加载器、设置摘要、未完成状态、Mod 数与正在做的事一次给齐。 */
export const listInstances = (): Promise<InstanceDto[]> => invoke<InstanceDto[]>("list_instances");

export const getInstanceSettings = (id: string): Promise<InstanceSettingsDto> =>
  invoke<InstanceSettingsDto>("get_instance_settings", { id });

/** 整份写入，返回写下的内容。任一字段不合法时整次不生效。 */
export const setInstanceSettings = (id: string, settings: InstanceSettingsDto): Promise<InstanceSettingsDto> =>
  invoke<InstanceSettingsDto>("set_instance_settings", { id, settings });

/** 资源包、光影包与存档，从实例运行时的工作目录读。 */
export const listInstanceContent = (id: string): Promise<InstanceContentDto> =>
  invoke<InstanceContentDto>("list_instance_content", { id });

/** 侧栏固定的实例，按显示顺序；已不存在的不返回。 */
export const getSidebarPins = (): Promise<string[]> => invoke<string[]>("get_sidebar_pins");

/** 整份设置侧栏固定列表（最多 5 个、不重复、须为现有实例），返回写下的列表。 */
export const setSidebarPins = (pins: string[]): Promise<string[]> => invoke<string[]>("set_sidebar_pins", { pins });

/**
 * 长任务：把原版 id（可选叠加加载器）新建为名为 targetName 的实例。进度经 core-event 推送并带 task_id，
 * 可用 cancelTask(taskId) 取消，取消后新建到一半的实例整个删掉；失败时实例保留并标为未完成，可补全重试。
 * 原版安装时 loader 与 loaderVersion 都传 null；Forge / NeoForge 必须给 loaderVersion。
 */
export const installVersion = (
  taskId: string,
  id: string,
  loader: LoaderChoice | null,
  loaderVersion: string | null,
  targetName: string,
): Promise<InstallResultDto> =>
  invoke<InstallResultDto>("install_version", { taskId, id, loader, loaderVersion, targetName });

/** 长任务：补全实例文件；新建没装完的实例照当初的内容重装。可取消。 */
export const repairInstance = (taskId: string, id: string): Promise<RepairResultDto> =>
  invoke<RepairResultDto>("repair_instance", { taskId, id });

export const previewInstanceDeletion = (id: string): Promise<DeletionPreviewDto> =>
  invoke<DeletionPreviewDto>("preview_instance_deletion", { id });

/** 移入回收站并从侧栏固定、当前选中里去掉。目录已不在时 existed 为 false。 */
export const deleteInstance = (id: string): Promise<{ existed: boolean }> =>
  invoke<{ existed: boolean }>("delete_instance", { id });

/** 改名：目录、版本 JSON、jar、侧栏固定与当前选中一起改。返回新的实例 id。 */
export const renameInstance = (id: string, newName: string): Promise<{ id: string }> =>
  invoke<{ id: string }>("rename_instance", { id, newName });

/** 版本清单，每个版本附带可装的加载器；断网时退回缓存，stale_since 与 fetch_error 说明情况。 */
export const listManifest = (): Promise<ManifestDto> => invoke<ManifestDto>("list_manifest");

/** 某加载器对某游戏版本的全部可用版本，新的在前。 */
export const listLoaderVersions = (loader: LoaderChoice, mcVersion: string): Promise<LoaderVersionDto[]> =>
  invoke<LoaderVersionDto[]>("list_loader_versions", { loader, mcVersion });

/** 新建这个游戏版本的实例需要的 Java 主版本。 */
export const requiredJava = (mcVersion: string): Promise<number> => invoke<number>("required_java", { mcVersion });

/** 用系统文件管理器打开文件夹；路径由后端按实例 id 解析。 */
export const openFolder = (target: FolderTarget, id: string | null, world: string | null = null): Promise<void> =>
  invoke<void>("open_folder", { target, id, world });
