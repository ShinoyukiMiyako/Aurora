// DTO（serde 的 snake_case）到前端领域模型的纯函数，以及这些模型的形状。状态层在 IPC 边界调用它们，
// 页面、外壳与启动层只认这里输出的形状。取值集合之外的值一律抛错：前后端随同一个安装包发布，
// 未知取值说明契约被破坏，静默回落只会把缺口藏起来。

import { incompleteReason } from "../copy/flows";
import type { AccountDto, AccountType, AuthServerDto, AuthlibProfileDto } from "../ipc/accounts";
import type { SkinInfoDto } from "../ipc/art";
import { UI_LANGUAGES, type AfterLaunch, type ConfigDto, type ConfigPatch, type DownloadSourcePolicy, type IsolationPolicy, type UiLanguage } from "../ipc/config";
import type {
  DetectedLoaderKind,
  IncompleteDto,
  InstanceActivity,
  InstanceDto,
  InstanceModpackDto,
  InstanceSettingsDto,
  IsolationOverride,
  LoaderChoice,
} from "../ipc/instances";
import type { LaunchDownloadDto, LogLineDto } from "../ipc/launch";
import type { TaskRecordDto } from "../ipc/tasks";
import {
  BASE_BLOCKING_ACTIVITIES,
  COVER_BACKGROUNDS,
  INSTALL_PHASES,
  PLATFORMS,
  TASK_KINDS,
  TASK_STATUSES,
  type AccountKind,
  type BaseBlockingActivity,
  type CoverBackground,
  type InstallPhase,
  type LoaderKind,
  type LogLine,
  type Platform,
  type SessionDownload,
  type Task,
} from "./types";

function oneOf<T extends string>(value: unknown, allowed: readonly T[], what: string): T {
  if (typeof value !== "string" || !(allowed as readonly string[]).includes(value)) throw new Error(`未知的${what}：${String(value)}`);
  return value as T;
}

// ---------------------------------------------------------------- 账户

export type AccountStatus = "ok" | "expired";

export interface Account {
  uuid: string;
  name: string;
  kind: AccountKind;
  /** 外置登录的验证服务器名；其余类型为 null。 */
  authServer: string | null;
  /** 外置登录的 API 根地址，重新登录时原样交回；其余类型为 null。 */
  serverUrl: string | null;
  /** 外置登录时填的账号，重新登录时预填；其余类型、或较早登录的记录为 null。 */
  username: string | null;
  addedAt: number;
  /** expired：续期被服务器判定失效，只有重新登录能恢复。 */
  status: AccountStatus;
  lastVerifiedAt: number | null;
}

const ACCOUNT_KIND: Readonly<Record<AccountType, AccountKind>> = {
  microsoft: "microsoft",
  offline: "offline",
  authlib_injector: "authlib",
};

/** 账户 DTO 与接回的那局游戏的账户快照共用同一套 account_type 取值。 */
export function accountKindFromDto(type: AccountType): AccountKind {
  if (!Object.hasOwn(ACCOUNT_KIND, type)) throw new Error(`未知的账户类型：${String(type)}`);
  return ACCOUNT_KIND[type];
}

export function accountFromDto(dto: AccountDto): Account {
  const kind = accountKindFromDto(dto.account_type);
  if (kind === "authlib" && dto.auth_server === null) throw new Error(`外置登录账户 ${dto.name} 缺少验证服务器名`);
  if (kind === "authlib" && dto.server_url === null) throw new Error(`外置登录账户 ${dto.name} 缺少验证服务器地址`);
  return {
    uuid: dto.uuid,
    name: dto.name,
    kind,
    authServer: kind === "authlib" ? dto.auth_server : null,
    serverUrl: kind === "authlib" ? dto.server_url : null,
    username: kind === "authlib" ? dto.username : null,
    addedAt: dto.added_at,
    status: oneOf(dto.status, ["ok", "expired"] as const, "账户状态"),
    lastVerifiedAt: dto.last_verified_at,
  };
}

export interface AuthServer {
  apiRoot: string;
  serverName: string;
  host: string;
}

export function authServerFromDto(dto: AuthServerDto): AuthServer {
  return { apiRoot: dto.api_root, serverName: dto.server_name, host: dto.host };
}

export interface AuthlibProfile {
  uuid: string;
  name: string;
  /** 取不到皮肤时为 null，画剪影。 */
  skin: SkinInfoDto | null;
}

export function authlibProfileFromDto(dto: AuthlibProfileDto): AuthlibProfile {
  return { uuid: dto.uuid, name: dto.name, skin: dto.skin };
}

// ---------------------------------------------------------------- 实例

export type InstanceStatus = "ready" | "installing" | "broken";
export type ReleaseType = "release" | "snapshot" | "old";
export type ExtraLoaderKind = "optifine" | "liteloader";

/** 实例所来自的整合包。 */
export interface InstanceModpack {
  /** 从本地文件导入时为 null。 */
  platform: Platform | null;
  projectId: string | null;
  versionId: string | null;
  /** 整合包自己的名字（实例名可以被改成别的）。 */
  name: string;
  version: string | null;
}

export interface InstanceIncomplete {
  kind: IncompleteDto["kind"];
  outcome: IncompleteDto["outcome"];
  startedAt: number | null;
  spec: { mcVersion: string; loader: LoaderChoice | null; loaderVersion: string | null } | null;
  error: { code: string; message: string } | null;
}

/**
 * 实例列表里的一项：一次 list_instances 拿全，不为每个实例另发详情请求。
 * id 就是版本目录名，也是显示名；重命名即改目录。
 */
export interface InstanceSummary {
  id: string;
  name: string;
  /** 识别不出或损坏时为 null。 */
  mcVersion: string | null;
  /** 按 NeoForge > Forge > Fabric > Quilt 取第一个，都没有为原版。 */
  loader: LoaderKind;
  loaderVersion: string | null;
  /** OptiFine、LiteLoader 作为附加标签。 */
  extraLoaders: { kind: ExtraLoaderKind; version: string | null }[];
  releaseType: ReleaseType | null;
  javaMajor: number | null;
  /** 版本能否直接进入存档、直接加入服务器；读不出版本信息（损坏、继承链断了）或还在安装的占位项为 null。 */
  quickPlay: { singleplayer: boolean; multiplayer: boolean } | null;
  /** 实例设置里的描述；没写或设置读不出时为 null。 */
  description: string | null;
  /** 封面方块 id；null 表示没设过，按默认封面规则画。 */
  cover: string | null;
  /** 封面方块用的玩家图片在材质协议 /cover/ 下的取图键；没设或文件不见了为 null。 */
  coverImage: string | null;
  /** 卡面背景；follow 跟随外观设置里的默认。 */
  background: CoverBackground;
  /** 卡面背景图片的取图键；没设或文件不见了为 null。 */
  backgroundImage: string | null;
  pinned: boolean;
  status: InstanceStatus;
  /** status 为 broken 时的原因；其余为 null。 */
  brokenReason: string | null;
  createdAt: number | null;
  /** 上次游玩的毫秒时间戳；没玩过或游玩记录读不出时为 null，要说「从未游玩」先看 playError。 */
  lastPlayedAt: number | null;
  /** 累计游玩分钟；没玩过为 0，游玩记录读不出时为 null。 */
  playtimeMin: number | null;
  /** 游玩记录读不出来的原因。 */
  playError: string | null;
  /** 实例目录或工作目录读不出来的原因；此时 createdAt 或 modCount、worldCount、resourcePackCount、isolated 为 null。 */
  dirError: string | null;
  /** mods/ 下的文件数，只数不解析；损坏、设置或工作目录读不出时为 null。 */
  modCount: number | null;
  /** saves/ 下的存档数（每个文件夹算一个）；何时为 null 同 modCount。 */
  worldCount: number | null;
  /** resourcepacks/ 下的资源包数（文件夹与 .zip 文件各算一个，与内容列表同一口径）；何时为 null 同 modCount。 */
  resourcePackCount: number | null;
  /** 隔离的生效值；何时为 null 同 modCount。 */
  isolated: boolean | null;
  /** 实例设置里的最大内存 MB；null 为跟随全局（或设置读不出）。 */
  memoryMb: number | null;
  /** 从整合包导入的实例记下的整合包；不是整合包实例或记录读不出时为 null。 */
  modpack: InstanceModpack | null;
  /** 整合包记录读不出来的原因。 */
  modpackError: string | null;
  /** 最近一次崩溃的毫秒时间戳；没崩溃过或记录读不出时为 null。 */
  lastCrashAt: number | null;
  /** 崩溃记录读不出来的原因。 */
  lastCrashError: string | null;
  /** 后端此刻在这个实例上做的事。 */
  activity: InstanceActivity | null;
  /** 正以它为基底的实例（启动到游戏退出、补全或导入整合包期间）；这时它的启动、改名、补全、删除会被后端拒绝。没被当作基底时为 null。 */
  usedBy: string | null;
  /** 继承链上正忙、容不下基底占用的基底；这时它的补全、重新安装加载器会被后端拒绝。 */
  baseBusy: { id: string; activity: BaseBlockingActivity } | null;
  settingsError: string | null;
  incomplete: InstanceIncomplete | null;
  /** 新建或导入任务已入队、实例目录还没扫到时由状态层补上的占位项。 */
  placeholder: boolean;
}

const LOADER_PRIORITY: readonly LoaderChoice[] = ["neoforge", "forge", "fabric", "quilt"];
const DETECTED_LOADERS: readonly DetectedLoaderKind[] = ["fabric", "quilt", "forge", "neoforge", "optifine", "liteloader"];

const RELEASE_TYPES: Readonly<Record<string, ReleaseType>> = {
  release: "release",
  snapshot: "snapshot",
  old_beta: "old",
  old_alpha: "old",
};

/**
 * 版本类型是外部数据：实例的版本 JSON 由写它的启动器决定，官方清单也可能多出新类型。
 * 认不出为 null，由调用方决定怎么显示，一项认不出不该让整张列表适配失败。
 */
export function knownReleaseType(value: string): ReleaseType | null {
  return Object.hasOwn(RELEASE_TYPES, value) ? RELEASE_TYPES[value] : null;
}

export function incompleteFromDto(dto: IncompleteDto): InstanceIncomplete {
  return {
    kind: oneOf(dto.kind, ["install", "repair", "modpack", "unknown"] as const, "未完成标记类型"),
    outcome: oneOf(dto.outcome, ["pending", "failed", "cancelled", "unknown"] as const, "未完成标记结局"),
    startedAt: dto.started_at,
    spec: dto.spec === null ? null : { mcVersion: dto.spec.mc_version, loader: dto.spec.loader, loaderVersion: dto.spec.loader_version },
    error: dto.error,
  };
}

function modpackFromDto(dto: InstanceModpackDto): InstanceModpack {
  return {
    platform: dto.platform === null ? null : oneOf(dto.platform, PLATFORMS, "整合包来源平台"),
    projectId: dto.project_id,
    versionId: dto.version_id,
    name: dto.name,
    version: dto.version,
  };
}

export interface InstanceContext {
  /** 侧栏固定列表；pinned 由它推出。 */
  pins: readonly string[];
  /** 有 queued / running 任务的实例 id。 */
  busyTaskInstanceIds: ReadonlySet<string>;
}

function instanceStatus(dto: InstanceDto, incomplete: InstanceIncomplete | null, ctx: InstanceContext): { status: InstanceStatus; brokenReason: string | null } {
  // 正在安装或补全时版本目录里也有未完成标记，必须先判安装中，否则排队中的新实例会被画成损坏
  if (ctx.busyTaskInstanceIds.has(dto.id) || dto.activity === "installing" || dto.activity === "repairing") {
    return { status: "installing", brokenReason: null };
  }
  if (dto.status === "broken") {
    if (dto.broken_reason !== null) return { status: "broken", brokenReason: dto.broken_reason };
    if (incomplete !== null) return { status: "broken", brokenReason: incompleteReason(incomplete) };
    throw new Error(`实例 ${dto.id} 标为损坏却没有原因`);
  }
  if (dto.status !== "ready") throw new Error(`未知的实例状态：${String(dto.status)}`);
  if (incomplete !== null) return { status: "broken", brokenReason: incompleteReason(incomplete) };
  return { status: "ready", brokenReason: null };
}

export function instanceFromDto(dto: InstanceDto, ctx: InstanceContext): InstanceSummary {
  const loaders = dto.loaders.map((l) => ({ kind: oneOf(l.kind, DETECTED_LOADERS, "加载器"), version: l.version }));
  const primary = LOADER_PRIORITY.map((kind) => ({ kind, found: loaders.find((l) => l.kind === kind) })).find((p) => p.found !== undefined);
  const extraLoaders = loaders
    .filter((l): l is { kind: ExtraLoaderKind; version: string | null } => l.kind === "optifine" || l.kind === "liteloader")
    .map((l) => ({ kind: l.kind, version: l.version }));
  const incomplete = dto.incomplete === null ? null : incompleteFromDto(dto.incomplete);
  const { status, brokenReason } = instanceStatus(dto, incomplete, ctx);
  // 活动只报最要紧的那一件，被当作基底时它可能是 running 等；反过来报 inherited 却没说谁在用，或说了谁在用却没有任何占用，都是契约破了。
  if (dto.activity === "inherited" && dto.used_by === null) throw new Error(`实例 ${dto.id} 被当作基底占着，却没说是哪个实例在用`);
  if (dto.used_by !== null && dto.activity === null) throw new Error(`实例 ${dto.id} 正被 ${dto.used_by} 使用，却没有报出占用`);
  if ((dto.playtime_min === null) !== (dto.play_error !== null)) throw new Error(`实例 ${dto.id} 的游玩时长与它的读取错误对不上`);
  return {
    id: dto.id,
    name: dto.id,
    mcVersion: dto.mc_version,
    loader: primary === undefined ? "vanilla" : primary.kind,
    loaderVersion: primary === undefined || primary.found === undefined ? null : primary.found.version,
    extraLoaders,
    releaseType: dto.release_type === null ? null : knownReleaseType(dto.release_type),
    javaMajor: dto.java_major,
    quickPlay: dto.quick_play === null ? null : { singleplayer: dto.quick_play.singleplayer, multiplayer: dto.quick_play.multiplayer },
    description: dto.description,
    cover: dto.cover,
    coverImage: dto.cover_image,
    background: oneOf(dto.background, COVER_BACKGROUNDS, "卡面背景"),
    backgroundImage: dto.background_image,
    pinned: ctx.pins.includes(dto.id),
    status,
    brokenReason,
    createdAt: dto.created_at,
    lastPlayedAt: dto.last_played_at,
    playtimeMin: dto.playtime_min,
    playError: dto.play_error,
    dirError: dto.dir_error,
    modCount: dto.mod_count,
    worldCount: dto.world_count,
    resourcePackCount: dto.resource_pack_count,
    isolated: dto.isolated,
    memoryMb: dto.memory_mb,
    modpack: dto.modpack === null ? null : modpackFromDto(dto.modpack),
    modpackError: dto.modpack_error,
    lastCrashAt: dto.last_crash_at,
    lastCrashError: dto.last_crash_error,
    activity: dto.activity,
    usedBy: dto.used_by,
    baseBusy: dto.base_busy === null ? null : { id: dto.base_busy.id, activity: oneOf(dto.base_busy.activity, BASE_BLOCKING_ACTIVITIES, "基底的活动") },
    settingsError: dto.settings_error,
    incomplete,
    placeholder: false,
  };
}

// ---------------------------------------------------------------- 实例设置

/** 实例设置与全局设置里 Java 取这个值表示按游戏版本自动选择；其余取值是 java 可执行文件的绝对路径。 */
export const JAVA_AUTO = "auto";

/** 实例固定了某个 Java（不是自动选择）。 */
export function javaPinned(settings: InstanceSettings): boolean {
  return settings.java !== JAVA_AUTO;
}

export interface InstanceSettings {
  description: string | null;
  cover: string | null;
  /** 封面方块图片的文件名；只由导入写下，界面只会把它清成 null。 */
  coverImage: string | null;
  background: CoverBackground;
  /** 卡面背景图片的文件名；同上。 */
  backgroundImage: string | null;
  isolation: IsolationOverride;
  /** null 跟随全局。 */
  memoryMb: number | null;
  /** "auto" 或 java 可执行文件的绝对路径。 */
  java: string;
  jvmArgs: string;
  resolution: { width: number; height: number };
  fullscreen: boolean;
}

export function instanceSettingsFromDto(dto: InstanceSettingsDto): InstanceSettings {
  return {
    description: dto.description,
    cover: dto.cover,
    coverImage: dto.cover_image,
    background: oneOf(dto.background, COVER_BACKGROUNDS, "卡面背景"),
    backgroundImage: dto.background_image,
    isolation: oneOf(dto.isolation, ["follow_global", "enabled", "disabled"] as const, "隔离设置"),
    memoryMb: dto.memory_mb,
    java: dto.java,
    jvmArgs: dto.jvm_args,
    resolution: { width: dto.resolution.width, height: dto.resolution.height },
    fullscreen: dto.fullscreen,
  };
}

export function instanceSettingsToDto(settings: InstanceSettings): InstanceSettingsDto {
  return {
    description: settings.description,
    cover: settings.cover,
    cover_image: settings.coverImage,
    background: settings.background,
    background_image: settings.backgroundImage,
    isolation: settings.isolation,
    memory_mb: settings.memoryMb,
    java: settings.java,
    jvm_args: settings.jvmArgs,
    resolution: { width: settings.resolution.width, height: settings.resolution.height },
    fullscreen: settings.fullscreen,
  };
}

// ---------------------------------------------------------------- 全局设置

export interface Settings {
  gameDir: string;
  defaultGameDir: string;
  dataDir: string;
  downloadSource: DownloadSourcePolicy;
  versionListSource: DownloadSourcePolicy;
  /** 同时下载的文件数。 */
  downloadConcurrency: number;
  memory: { maxMb: number; minMb: number | null; auto: boolean };
  isolationPolicy: IsolationPolicy;
  hasClientId: boolean;
  microsoftLoginAvailable: boolean;
  autoDownloadJava: boolean;
  /** "auto" 或 java 可执行文件绝对路径。 */
  defaultJava: string;
  afterLaunch: AfterLaunch;
  checkUpdates: boolean;
  cacheDirectory: string | null;
  selectedVersion: string | null;
  skippedUpdateVersion: string | null;
  notifiedUpdateVersion: string | null;
  language: UiLanguage;
  /** 手动添加的 java 可执行文件；识别不识别得出以 Java 探测结果为准。 */
  extraJavaPaths: string[];
  preferDedicatedGpu: boolean;
  skipAccessibilityOnboarding: boolean;
  /** 存档备份：退出游戏后是否自动备份，自动备份每个存档留几份、全部备份的总量上限（GB）。 */
  worldBackup: WorldBackup;
}

export interface WorldBackup {
  auto: boolean;
  keepPerWorld: number;
  maxTotalGb: number;
}

const SOURCES: readonly DownloadSourcePolicy[] = ["auto", "official_first", "mirror_first"];
const ISOLATION: readonly IsolationPolicy[] = ["disabled", "mod_loaders_only", "non_release_only", "mod_loaders_and_non_release", "all"];
const AFTER_LAUNCH: readonly AfterLaunch[] = ["keep", "minimize", "close"];

export function settingsFromDto(dto: ConfigDto): Settings {
  return {
    gameDir: dto.game_dir,
    defaultGameDir: dto.default_game_dir,
    dataDir: dto.data_dir,
    downloadSource: oneOf(dto.download_source, SOURCES, "下载源"),
    versionListSource: oneOf(dto.version_list_source, SOURCES, "版本列表源"),
    downloadConcurrency: dto.download_concurrency,
    memory: { maxMb: dto.memory.max_mb, minMb: dto.memory.min_mb, auto: dto.memory.auto },
    isolationPolicy: oneOf(dto.isolation_policy, ISOLATION, "版本隔离策略"),
    hasClientId: dto.has_client_id,
    microsoftLoginAvailable: dto.microsoft_login_available,
    autoDownloadJava: dto.auto_download_java,
    defaultJava: dto.default_java,
    afterLaunch: oneOf(dto.after_launch, AFTER_LAUNCH, "游戏启动后的窗口行为"),
    checkUpdates: dto.check_updates,
    cacheDirectory: dto.cache_directory,
    selectedVersion: dto.selected_version,
    skippedUpdateVersion: dto.skipped_update_version,
    notifiedUpdateVersion: dto.notified_update_version,
    language: oneOf(dto.language, UI_LANGUAGES, "界面语言"),
    extraJavaPaths: [...dto.extra_java_paths],
    preferDedicatedGpu: dto.prefer_dedicated_gpu,
    skipAccessibilityOnboarding: dto.skip_accessibility_onboarding,
    worldBackup: { auto: dto.world_backup.auto, keepPerWorld: dto.world_backup.keep_per_world, maxTotalGb: dto.world_backup.max_total_gb },
  };
}

/** 全局设置的补丁：只写出要改的字段。游戏目录与外观各有专门的入口，不在这里。 */
export interface SettingsPatch {
  downloadSource?: DownloadSourcePolicy;
  versionListSource?: DownloadSourcePolicy;
  downloadConcurrency?: number;
  memory?: { maxMb: number; minMb: number | null; auto: boolean };
  isolationPolicy?: IsolationPolicy;
  autoDownloadJava?: boolean;
  cacheDirectory?: string;
  clientId?: string;
  clearClientId?: true;
  afterLaunch?: AfterLaunch;
  checkUpdates?: boolean;
  defaultJava?: string;
  skippedUpdateVersion?: string;
  notifiedUpdateVersion?: string;
  language?: UiLanguage;
  preferDedicatedGpu?: boolean;
  skipAccessibilityOnboarding?: boolean;
  /** 三项一起写：后端要求一次给全。 */
  worldBackup?: WorldBackup;
}

export function settingsPatchToConfig(patch: SettingsPatch): ConfigPatch {
  const { memory, worldBackup, ...rest } = patch;
  const out: ConfigPatch = { ...rest };
  if (memory !== undefined) out.memory = { max_mb: memory.maxMb, min_mb: memory.minMb, auto: memory.auto };
  if (worldBackup !== undefined) out.worldBackup = { auto: worldBackup.auto, keep_per_world: worldBackup.keepPerWorld, max_total_gb: worldBackup.maxTotalGb };
  return out;
}

// ---------------------------------------------------------------- 日志与启动进度

const LOG_LEVELS = ["info", "warn", "error"] as const;
const LOG_SOURCES = ["game", "launcher"] as const;

/** 一行日志。游戏行的级别由后端按 log4j 标记推断（与读回会话日志时同一条规则），这里只校验取值。 */
export function logLineFromDto(dto: LogLineDto): LogLine {
  return {
    at: dto.at,
    level: oneOf(dto.level, LOG_LEVELS, "日志级别"),
    source: oneOf(dto.source, LOG_SOURCES, "日志来源"),
    text: dto.text,
  };
}

export function sessionDownloadFromDto(dto: LaunchDownloadDto): SessionDownload {
  return { done: dto.finished, total: dto.total, bytes: dto.bytes, totalBytes: dto.total_bytes, speedBps: dto.speed };
}

// ---------------------------------------------------------------- 任务进度

/** 步骤表里有不认识的键，说明前后端的表对不上，算出的「第几步」与进度都不可信。 */
export function installPhasesFromDto(plan: readonly string[]): InstallPhase[] {
  return plan.map((key) => oneOf(key, INSTALL_PHASES, "安装步骤"));
}

// ---------------------------------------------------------------- 任务日志

export function taskFromRecord(dto: TaskRecordDto): Task {
  if (typeof dto.spec?.command !== "string" || typeof dto.spec.args !== "object" || dto.spec.args === null) {
    throw new Error(`任务 ${dto.id} 的重试参数形状不对`);
  }
  return {
    id: dto.id,
    kind: oneOf(dto.kind, TASK_KINDS, "任务类别"),
    title: dto.title,
    detail: dto.detail,
    instanceId: dto.instance_id,
    status: oneOf(dto.status, TASK_STATUSES, "任务状态"),
    progress: dto.progress,
    bytes: dto.bytes,
    totalBytes: dto.total_bytes,
    // 较早的日志没有这几项：累计字节只知道最后一批的，开始时刻（不显示用时）与传输量（不显示下载量）不知道
    doneBytes: dto.done_bytes === undefined ? dto.bytes : dto.done_bytes,
    transferredBytes: dto.transferred_bytes === undefined ? null : dto.transferred_bytes,
    batchTransferred: 0,
    batchFiles: 0,
    phase: null,
    speedBps: dto.speed_bps,
    startedAt: dto.started_at === undefined ? null : dto.started_at,
    attempt: dto.attempt,
    error: dto.error,
    createdAt: dto.created_at,
    finishedAt: dto.finished_at,
    spec: { command: dto.spec.command, args: dto.spec.args },
  };
}

export function taskToRecord(task: Task): TaskRecordDto {
  return {
    id: task.id,
    kind: task.kind,
    title: task.title,
    detail: task.detail,
    instance_id: task.instanceId,
    status: task.status,
    progress: task.progress,
    bytes: task.bytes,
    total_bytes: task.totalBytes,
    done_bytes: task.doneBytes,
    transferred_bytes: task.transferredBytes,
    speed_bps: task.speedBps,
    started_at: task.startedAt,
    attempt: task.attempt,
    error: task.error,
    created_at: task.createdAt,
    finished_at: task.finishedAt,
    spec: { command: task.spec.command, args: task.spec.args },
  };
}
