// 实例：列表、设置、内容、侧栏固定、新建、补全、删除、改名、打开文件夹、新实例的默认设置，以及新建页要的版本清单、
// 加载器版本、所需 Java 与下载体积。
//
// 会改动实例目录的命令（新建、整合包导入、补全、改名、删除，以及装、删、启停、更新、回滚 Mod 与装资源）
// 在实例正忙时以 instance_busy 拒绝，detail.activity 指出正在做的事（Mod 与资源的改动彼此、与运行中的
// 游戏可以并行，记为 modifying；备份、恢复、导出存档记为 backing_up，只与 modifying、inherited 并行）；被别的实例经 inheritsFrom
// 依赖时以 instance_has_dependents 拒绝。参数类问题一律是
// invalid_argument，detail.field 指出哪一项：名称问题带 detail.rule（见 NameRule），侧栏固定带
// detail.reason（too_many / duplicate / not_found）与 detail.id。

import { invoke } from "./bridge";
import type { PlatformId } from "./discover";

export type LoaderChoice = "fabric" | "quilt" | "forge" | "neoforge";
export const LOADER_CHOICES: readonly LoaderChoice[] = ["fabric", "quilt", "forge", "neoforge"];

/** 已装实例里能探测到的加载器，比可安装的多两种。 */
export type DetectedLoaderKind = LoaderChoice | "optifine" | "liteloader";

/**
 * 实例此刻在做的事。inherited：别的实例正以它为基底（在那个实例的 inheritsFrom 链上），那个实例启动到退出、
 * 补全或导入整合包期间，这个实例的删除、改名、补全以 instance_busy 拒绝，detail.used_by 是正在用它的实例。
 */
export type InstanceActivity = "installing" | "repairing" | "renaming" | "deleting" | "launching" | "running" | "modifying" | "inherited" | "backing_up";

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
  /** install：新建没装完；repair：补全没做完；modpack：整合包没导入完（补全补不回来）；unknown：标记文件读不出来。 */
  kind: "install" | "repair" | "modpack" | "unknown";
  /** pending：进行中，或启动器在进行中被关掉了。 */
  outcome: "pending" | "failed" | "cancelled" | "unknown";
  started_at: number | null;
  spec: InstallSpecDto | null;
  /** 失败原因；标记读不出来时 code 为 marker_unreadable。 */
  error: { code: string; message: string } | null;
}

/** 实例所来自的整合包。 */
export interface InstanceModpackDto {
  /** 从本地文件导入时为 null。 */
  platform: PlatformId | null;
  project_id: string | null;
  version_id: string | null;
  /** 整合包自己的名字（实例名可以被改成别的）。 */
  name: string;
  version: string | null;
}

export interface QuickPlaySupportDto {
  singleplayer: boolean;
  multiplayer: boolean;
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
  /**
   * 版本能否直接进入存档、直接加入服务器（按版本 JSON 里的启动参数规则判定，沿继承链合并）；
   * 继承链断了或 broken 时为 null。
   */
  quick_play: QuickPlaySupportDto | null;
  /** 工作目录 mods/ 下的 Mod 文件数（.jar 与 .jar.disabled）；broken、设置或工作目录读不出时为 null。 */
  mod_count: number | null;
  /** 工作目录 saves/ 下的存档数（每个文件夹算一个）；何时为 null 同 mod_count。 */
  world_count: number | null;
  /** 隔离的生效值（实例覆盖、全局档位与已有数据共同决定）；何时为 null 同 mod_count。 */
  isolated: boolean | null;
  description: string | null;
  /** 封面预设 id；null 时按默认规则推导。 */
  cover: string | null;
  /** 实例设置里的最大内存 MB；null 为跟随全局（或设置读不出）。 */
  memory_mb: number | null;
  /** 实例设置读不出来的原因；此时 description、cover、memory_mb 为 null。 */
  settings_error: string | null;
  /** 从整合包导入时记下的整合包；不是整合包实例或记录读不出时为 null。 */
  modpack: InstanceModpackDto | null;
  /** 整合包记录读不出来的原因。 */
  modpack_error: string | null;
  /** 最近一次崩溃的毫秒时间戳；没崩溃过或记录读不出时为 null。 */
  last_crash_at: number | null;
  /** 崩溃记录读不出来的原因。 */
  last_crash_error: string | null;
  incomplete: IncompleteDto | null;
  /** 实例目录创建时刻（毫秒时间戳）；文件系统不记录或目录读不出时为 null。 */
  created_at: number | null;
  /** 实例目录或工作目录读不出来的原因；此时 created_at 或 mod_count、world_count、isolated 为 null。 */
  dir_error: string | null;
  /** 有几件事并行时报最值得界面知道的那一件：实例自己的事优先，其次 modifying，最后 inherited。 */
  activity: InstanceActivity | null;
  /** 正以它为基底的实例；有几个时为最早占到的那个（与 instance_busy 报的同一个），没被当作基底时为 null。 */
  used_by: string | null;
  /** 累计游玩分钟（向下取整）；没玩过为 0，游玩记录读不出时为 null。 */
  playtime_min: number | null;
  /** 上次游玩结束的毫秒时间戳；没玩过或游玩记录读不出时为 null。 */
  last_played_at: number | null;
  /** 游玩记录读不出来的原因。 */
  play_error: string | null;
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
  /** 正以它为基底的实例；含义同实例列表的 used_by。 */
  used_by: string | null;
  /** 这个实例的存档备份所在的目录（instances/<id>），删除实例不动它。 */
  backups_dir: string;
  /** 这个实例各存档的备份份数之和；为 0 时 backups_dir 可能还不存在。 */
  backup_count: number;
}

// ---------------------------------------------------------------- 存档备份

/** auto：退出游戏后自动备份的，会按保留份数与总量上限清理；manual：手动备份的，不会被自动清理。 */
export type BackupKind = "auto" | "manual";

export interface WorldBackupDto {
  /** 备份目录里的 zip 文件名；恢复与删除按它指认是哪一份。 */
  file: string;
  kind: BackupKind;
  /** 备份时刻（毫秒时间戳）。 */
  created_at: number;
  /** zip 在盘上的字节数。 */
  size_bytes: number;
  /** 备份时 level.dat 里的存档名；读不出为 null。 */
  level_name: string | null;
}

export interface WorldBackupListDto {
  world: string;
  /** instance：隔离实例自己的存档；shared：共用 .minecraft/saves 的存档，所有不隔离的实例看到同一份。 */
  scope: "instance" | "shared";
  /** 这个存档的备份目录（绝对路径）；还没有备份时可能还不存在。 */
  dir: string;
  /** 新的在前。 */
  backups: WorldBackupDto[];
  total_bytes: number;
}

export interface BackupResultDto {
  backup: WorldBackupDto;
  /** 这次写完后按保留规则清掉的旧自动备份份数。 */
  pruned: number;
}

export interface RestoreResultDto {
  world: string;
  /** 恢复前的存档是否移进了回收站；存档目录原本不存在时为 false。 */
  previous_in_recycle_bin: boolean;
}

export interface ExportResultDto {
  path: string;
  size_bytes: number;
}

export interface InstallResultDto {
  id: string;
  mc_version: string;
  loader: { kind: LoaderChoice; version: string } | null;
  libraries: number;
  assets: number;
  natives: number;
  /** 新建时请求了沿用默认设置才有；没请求为 null。 */
  template: TemplateOutcomeDto | null;
}

// ---------------------------------------------------------------- 默认设置（新实例模板）

/**
 * 模板只收这几个文件，按这个顺序列出与复制：原版的设置与服务器列表，以及 OptiFine 写在游戏目录根下的两份设置。
 * 与后端的白名单一致；template_source_empty 的 detail.files 就是它。
 */
export const TEMPLATE_FILES: readonly string[] = ["options.txt", "servers.dat", "optionsof.txt", "optionsshaders.txt"];

/** 保存默认设置时实例的工作目录里一个白名单文件都没有（还没进过游戏）；detail 为 { id, files }。 */
export const TEMPLATE_SOURCE_EMPTY_ERROR_CODE = "template_source_empty";

export interface TemplateFileDto {
  name: string;
  size: number;
}

export interface TemplateInfoDto {
  /** files 不为空。 */
  present: boolean;
  /** 模板目录里存在的白名单文件，按白名单顺序。 */
  files: TemplateFileDto[];
  /** 从哪个实例保存的；文件是手放进数据目录的、没有记录时为 null。 */
  source_instance: string | null;
  /** 保存时刻（毫秒时间戳）；没有记录时为 null。 */
  saved_at: number | null;
  /** 配置里新建实例时是否套用模板；为 false 时任何路径都不套。 */
  enabled: boolean;
}

/** 没有套上的原因：配置里关了、模板是空的、新实例与别的实例共用游戏目录根下的设置。 */
export type TemplateSkipReason = "disabled" | "empty" | "shared_working_dir";

/** 套模板的结果：copied 是补进实例的文件，kept 是实例里本来就有、原样保留的文件。 */
export type TemplateOutcomeDto = { status: "applied"; copied: string[]; kept: string[] } | { status: "skipped"; reason: TemplateSkipReason };

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

/**
 * open_folder 能打开的文件夹。game_dir、data_dir（启动器数据目录）、launcher_logs（启动器自己的日志目录）
 * 不需要 id；world 还需要存档文件夹名。
 */
export type FolderTarget =
  | "game_dir"
  | "data_dir"
  | "launcher_logs"
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
 * useTemplate 为 true 时装好后沿用默认设置（只补实例里没有的文件），结果见 InstallResultDto.template；
 * 不传与 false 相同，后端对旧任务表里重放的、没有这个键的新建任务也这样处理。
 */
export const installVersion = (
  taskId: string,
  id: string,
  loader: LoaderChoice | null,
  loaderVersion: string | null,
  targetName: string,
  useTemplate?: boolean,
): Promise<InstallResultDto> =>
  invoke<InstallResultDto>("install_version", { taskId, id, loader, loaderVersion, targetName, useTemplate });

/** 默认设置的现状：有哪些文件、取自哪个实例、配置里开没开。只读。 */
export const templateInfo = (): Promise<TemplateInfoDto> => invoke<TemplateInfoDto>("template_info");

/**
 * 把实例工作目录里的白名单文件整份存为默认设置（实例没有的文件，新模板里也没有），返回存完之后的状态。
 * 实例正在安装、补全、改名或删除时以 instance_busy 拒绝；游戏运行中可以保存。工作目录里一个白名单文件都没有时
 * 以 TEMPLATE_SOURCE_EMPTY_ERROR_CODE 拒绝，原来的默认设置不动。
 */
export const saveInstanceAsTemplate = (id: string): Promise<TemplateInfoDto> => invoke<TemplateInfoDto>("save_instance_as_template", { id });

/** 删掉默认设置，返回删完之后的状态（present 为 false）。本来就没有也算成功。 */
export const clearTemplate = (): Promise<TemplateInfoDto> => invoke<TemplateInfoDto>("clear_template");

/** 长任务：补全实例文件；新建没装完的实例照当初的内容重装。可取消。 */
export const repairInstance = (taskId: string, id: string): Promise<RepairResultDto> =>
  invoke<RepairResultDto>("repair_instance", { taskId, id });

/**
 * 改名或删除本身已经完成（目录、侧栏固定与当前选中都已改好），只是游玩记录没能跟着改：照成功处理（刷新列表、
 * 迁移界面上挂在旧 id 上的状态）再提示。detail.id 为原实例 id，改名时 detail.renamed_to 为新名字。没改成的记录
 * 由后端记着，之后读写游玩记录时补上。
 */
export const PLAY_RECORDS_FAILED_ERROR_CODE = "play_records_failed";

/**
 * 改名本身已经完成，只是存档备份没能从旧名下挪过来：照成功处理再提示。detail 为 { id, renamed_to, path }，
 * path 是留在旧名下的备份目录。备份与游玩记录都没跟上时报的是 PLAY_RECORDS_FAILED_ERROR_CODE。
 */
export const WORLD_BACKUPS_NOT_MOVED_ERROR_CODE = "world_backups_not_moved";

export const previewInstanceDeletion = (id: string): Promise<DeletionPreviewDto> =>
  invoke<DeletionPreviewDto>("preview_instance_deletion", { id });

/** 移入回收站并从侧栏固定、当前选中与游玩记录里去掉。目录已不在时 existed 为 false。只有游玩记录没清成时以 PLAY_RECORDS_FAILED_ERROR_CODE 拒绝。 */
export const deleteInstance = (id: string): Promise<{ existed: boolean }> =>
  invoke<{ existed: boolean }>("delete_instance", { id });

/** 改名：目录、版本 JSON、jar、游玩记录、侧栏固定与当前选中一起改。返回新的实例 id。只有游玩记录没跟上时以 PLAY_RECORDS_FAILED_ERROR_CODE 拒绝。 */
export const renameInstance = (id: string, newName: string): Promise<{ id: string }> =>
  invoke<{ id: string }>("rename_instance", { id, newName });

/** 版本清单，每个版本附带可装的加载器；断网时退回缓存，stale_since 与 fetch_error 说明情况。 */
export const listManifest = (): Promise<ManifestDto> => invoke<ManifestDto>("list_manifest");

/** 某加载器对某游戏版本的全部可用版本，新的在前。 */
export const listLoaderVersions = (loader: LoaderChoice, mcVersion: string): Promise<LoaderVersionDto[]> =>
  invoke<LoaderVersionDto[]>("list_loader_versions", { loader, mcVersion });

/** 新建这个游戏版本的实例需要的 Java 主版本。 */
export const requiredJava = (mcVersion: string): Promise<number> => invoke<number>("required_java", { mcVersion });

export interface VersionRequirementsDto {
  java_major: number;
  /** 全新下载的字节数（客户端、本机适用的库、资源索引与资源文件、日志配置），不含 Java 与加载器、
   * 不扣除本地已有的文件；版本 JSON 有一项没标大小时为 null。 */
  download_bytes: number | null;
}

/** 新建这个游戏版本要的 Java 主版本与下载体积。版本清单不带这两项，按选中的版本逐个查；后端按版本缓存。 */
export const versionRequirements = (mcVersion: string): Promise<VersionRequirementsDto> =>
  invoke<VersionRequirementsDto>("version_requirements", { mcVersion });

/**
 * 长任务：把存档打包成一份手动备份，写完按保留规则清理旧的自动备份。实例启动中或游戏中以 instance_busy 拒绝
 * （detail.activity 为 launching / running）；存档正被别的程序打开以 world_in_use 拒绝。
 */
export const backupWorld = (taskId: string, id: string, world: string): Promise<BackupResultDto> =>
  invoke<BackupResultDto>("backup_world", { taskId, id, world });

/** 某个存档的全部备份，新的在前。只读，不占实例；存档文件夹已经不在时照常列出它留下的备份。 */
export const listWorldBackups = (id: string, world: string): Promise<WorldBackupListDto> =>
  invoke<WorldBackupListDto>("list_world_backups", { id, world });

/**
 * 长任务：用一份备份替换现在的存档，现在的存档移入回收站。file 不在备份表里时以 world_backup_not_found 拒绝；
 * 备份校验不过（含越出存档目录的条目）以 world_backup_corrupt 拒绝，这时现在的存档原样不动。
 */
export const restoreWorldBackup = (taskId: string, id: string, world: string, file: string): Promise<RestoreResultDto> =>
  invoke<RestoreResultDto>("restore_world_backup", { taskId, id, world, file });

/** 把一份备份移入回收站并从备份表里去掉。不占实例，可以在游戏运行时做。 */
export const deleteWorldBackup = (id: string, world: string, file: string): Promise<void> =>
  invoke<void>("delete_world_backup", { id, world, file });

/** 长任务：把存档打包到 dest（绝对路径、扩展名 .zip、父目录存在）；已有同名文件时覆盖。 */
export const exportWorld = (taskId: string, id: string, world: string, dest: string): Promise<ExportResultDto> =>
  invoke<ExportResultDto>("export_world", { taskId, id, world, dest });

/** 用系统文件管理器打开文件夹；路径由后端按实例 id 解析。 */
export const openFolder = (target: FolderTarget, id: string | null, world: string | null = null): Promise<void> =>
  invoke<void>("open_folder", { target, id, world });

/**
 * 在系统文件管理器里选中一个启动器自己产出的文件或文件夹：存档备份区里的路径（备份列表的目录、改名后没挪过来的
 * 旧备份目录），或这次运行里导出存档、导出整合包写成的文件。别的路径后端报 invalid_argument。
 */
export const revealInFolder = (path: string): Promise<void> => invoke<void>("reveal_in_folder", { path });
