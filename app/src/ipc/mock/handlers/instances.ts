import { IpcError } from "../../errors";
import {
  checkInstanceName,
  LOADER_CHOICES,
  type BackupKind,
  type BackupResultDto,
  type CoverImageSlotDto,
  type DeletionPreviewDto,
  type ExportResultDto,
  type FolderTarget,
  type IncompleteDto,
  type InstallResultDto,
  type InstanceActivity,
  type InstanceContentDto,
  type InstanceDto,
  type InstanceModpackDto,
  type InstanceSettingsDto,
  type LoaderChoice,
  type LoaderVersionDto,
  type ManifestDto,
  type ManifestVersionDto,
  type NameRule,
  type RepairResultDto,
  type TemplateFileDto,
  type TemplateInfoDto,
  type TemplateOutcomeDto,
  type VersionRequirementsDto,
  TEMPLATE_FILES,
  TEMPLATE_SOURCE_EMPTY_ERROR_CODE,
  INSTANCE_MOVE_BLOCKED_ERROR_CODE,
  type DataFormatUnreadableDto,
  type GameDirDataTooNewDto,
  type MoveBlockerDto,
  type MoveFollowUpDto,
  type MoveOutcomeDto,
  type MovePreviewDto,
  type RestoreResultDto,
  type WorldBackupDto,
  type WorldBackupListDto,
  type WorldDto,
} from "../../instances";
import type { InstallPhase } from "../../../domain/types";
import { emitMockEvent } from "../events";
import type { MockArgs, MockHandlers, MockPersist } from "../types";
import {
  addExtraDirectory,
  followMockSelection,
  isKnownMockGameDirectory,
  isMockPathWithin,
  mockDirectoryVersions,
  mockGameDir,
  mockGameDirectoryName,
  mockWorldBackupSettings,
  recordMockMovedVersions,
  samePath,
  validateMockMoveTarget,
} from "./config";
import { forgetMockLaunchRecords, mockCrashReport, mockPlayRecordsError, mockPlaySummary, renameMockLaunchRecords, takeMockPlayRecordsFailure } from "./launch";
import { forgetMockMods, mockModFileCount, renameMockMods } from "./mods";
import { forgetMockPinnedInstance, renameMockPinnedInstance } from "./system";
import { beginMockTask, endMockTask, isMockTaskCancelled } from "./tasks";

// ipc/ 只能以类型方式引用别的模块，事件名与上限在这里按后端各写一份。
const CORE_EVENT = "petalfall://core-event";
const SIDEBAR_PIN_MAX = 5;
const FOLDER_TARGETS: readonly FolderTarget[] = [
  "game_dir",
  "data_dir",
  "launcher_logs",
  "instance",
  "mods",
  "saves",
  "resourcepacks",
  "shaderpacks",
  "logs",
  "session_logs",
  "screenshots",
  "world",
];

/** 假安装、假补全每一步之间的间隔，测试用假时钟按它推进。 */
export const MOCK_STEP_MS = 300;
/** 假安装的步数（每步推一次进度）。 */
export const MOCK_INSTALL_STEPS = 5;

const DAY = 86_400_000;
const MB = 1_048_576;
const GIB = 1024 * MB;

/** 后端的备份根（<游戏目录>/.petalfall/backups）；ipc/ 引用不到元数据目录名常量，mock 按后端的布局写一份。 */
const MOCK_BACKUPS_ROOT = "D:/Games/.minecraft/.petalfall/backups";

export const NAME_MESSAGES: Record<NameRule, string> = {
  empty: "先给实例起个名字",
  too_long: "名称最多 32 个字",
  illegal_char: '名称里不能有 \\ / : * ? " < > | 这些字符',
  reserved: "这个名字 Windows 不允许用作文件夹名",
  leading_dot: "名称不能以 . 开头",
  duplicate: "已经有同名的实例了，换一个吧",
};

const LOADER_NAMES: Record<LoaderChoice, string> = {
  fabric: "Fabric",
  quilt: "Quilt",
  forge: "Forge",
  neoforge: "NeoForge",
};

// ---------------------------------------------------------------- 假数据

/** 由设置、内容、整合包记录与启动 mock 现算的字段，不在 dto 里另存一份。 */
type DerivedField =
  | "activity"
  | "used_by"
  | "base_busy"
  | "description"
  | "cover"
  | "cover_image"
  | "background"
  | "background_image"
  | "memory_mb"
  | "playtime_min"
  | "last_played_at"
  | "play_error"
  | "dir_error"
  | "mod_count"
  | "world_count"
  | "isolated"
  | "modpack"
  | "modpack_error"
  | "last_crash_at"
  | "last_crash_error";

interface MockInstance {
  dto: Omit<InstanceDto, DerivedField>;
  settings: InstanceSettingsDto;
  /** 从整合包导入时记下的整合包；手动新建的实例为 null。 */
  modpack: InstanceModpackDto | null;
  /** 传统布局的加载器版本经 inheritsFrom 指向的原版实例。 */
  inheritsFrom: string | null;
  content: InstanceContentDto;
  sizeBytes: number;
  fileCount: number;
  /** 实例卡面图片目录（.petalfall/cover/）里此刻在盘上的文件名：设置可以引用盘上没有的名字，列表给取图键只认在盘上的。 */
  coverFiles: string[];
}

function defaultSettings(): InstanceSettingsDto {
  return {
    description: null,
    cover: null,
    cover_image: null,
    background: "follow",
    background_image: null,
    isolation: "follow_global",
    memory_mb: null,
    java: "auto",
    jvm_args: "",
    resolution: { width: 1280, height: 720 },
    fullscreen: false,
  };
}

function emptyContent(): InstanceContentDto {
  return { resource_packs: [], shader_packs: [], worlds: [] };
}

/**
 * 版本能否直达，与后端一样只看启动参数规则；mock 没有版本 JSON，按版本号推出真实版本 JSON 里的规则：
 * 23w14a（1.20 的快照）起有 Quick Play 的单人、多人规则；1.6 起是带 --username 的选项式启动参数，
 * 后端改追加 --server / --port，只能加入服务器；再早的位置参数式两样都不支持。按年份编号的新版本都在 1.20 之后。
 */
function quickPlayOf(mc: string): InstanceDto["quick_play"] {
  const both = { singleplayer: true, multiplayer: true };
  const legacy = { singleplayer: false, multiplayer: true };
  const snapshot = /^(\d{2})w(\d{2})[a-z]$/.exec(mc);
  if (snapshot !== null) return Number(snapshot[1]) * 100 + Number(snapshot[2]) >= 2314 ? both : legacy;
  const release = /^1\.(\d+)/.exec(mc);
  if (release === null) return both;
  const minor = Number(release[1]);
  return minor >= 20 ? both : minor >= 6 ? legacy : { singleplayer: false, multiplayer: false };
}

function readyDto(
  id: string,
  mc: string,
  loaders: InstanceDto["loaders"],
  javaMajor: number,
  createdAt: number | null,
): MockInstance["dto"] {
  return {
    id,
    status: "ready",
    broken_reason: null,
    mc_version: mc,
    loaders,
    release_type: "release",
    is_release: true,
    java_major: javaMajor,
    quick_play: quickPlayOf(mc),
    settings_error: null,
    incomplete: null,
    created_at: createdAt,
  };
}

function seedInstances(): MockInstance[] {
  const now = Date.now();
  return [
    {
      dto: readyDto("1.21.1", "1.21.1", [], 21, now - 40 * DAY),
      settings: defaultSettings(),
      modpack: null,
      inheritsFrom: null,
      content: emptyContent(),
      sizeBytes: 31 * MB,
      fileCount: 4,
      coverFiles: [],
    },
    {
      dto: readyDto("樱花生存", "1.21.1", [{ kind: "fabric", version: "0.16.10" }], 21, now - 12 * DAY),
      settings: { ...defaultSettings(), description: "和朋友的周末服务器", cover: "cherry_planks", memory_mb: 6144 },
      modpack: null,
      inheritsFrom: null,
      content: {
        resource_packs: [
          { file_name: "Faithful 32x.zip", is_dir: false, size_bytes: 24 * MB, modified_at: now - 10 * DAY, load_order: 1 },
          { file_name: "旧材质", is_dir: true, size_bytes: 3 * MB, modified_at: now - 30 * DAY, load_order: null },
        ],
        shader_packs: [
          { file_name: "ComplementaryReimagined_r5.3.zip", is_dir: false, size_bytes: 2 * MB, modified_at: now - 9 * DAY, active: true },
        ],
        worlds: [
          {
            dir_name: "New World",
            level_status: "ok",
            level_error: null,
            name: "樱花谷",
            mode: "survival",
            last_played: now - DAY,
            size_bytes: 180 * MB,
            modified_at: now - DAY,
          },
          {
            dir_name: "坏档",
            level_status: "unreadable",
            level_error: "level.dat 不是有效的 gzip 数据",
            name: null,
            mode: null,
            last_played: null,
            size_bytes: 2 * MB,
            modified_at: now - 20 * DAY,
          },
        ],
      },
      sizeBytes: 420 * MB,
      fileCount: 1830,
      coverFiles: [],
    },
    // 下面四个实例是 Mod、发现与启动各自 mock 里种好数据的实例：浏览器里从实例列表点进去，各页看到的是同一批实例。
    {
      dto: readyDto("1.20.1-Fabric", "1.20.1", [{ kind: "fabric", version: "0.15.11" }], 17, now - 60 * DAY),
      settings: defaultSettings(),
      modpack: null,
      inheritsFrom: null,
      content: emptyContent(),
      sizeBytes: 96 * MB,
      fileCount: 410,
      coverFiles: [],
    },
    {
      dto: readyDto("1.20.1-Forge", "1.20.1", [{ kind: "forge", version: "47.2.0" }], 17, now - 55 * DAY),
      settings: defaultSettings(),
      modpack: null,
      inheritsFrom: null,
      content: emptyContent(),
      sizeBytes: 120 * MB,
      fileCount: 520,
      coverFiles: [],
    },
    {
      dto: readyDto("1.21", "1.21", [], 21, now - 50 * DAY),
      settings: defaultSettings(),
      modpack: null,
      inheritsFrom: null,
      content: emptyContent(),
      sizeBytes: 30 * MB,
      fileCount: 4,
      coverFiles: [],
    },
    {
      dto: readyDto("1.21.1-Fabric", "1.21.1", [{ kind: "fabric", version: "0.16.10" }], 21, now - 20 * DAY),
      settings: defaultSettings(),
      modpack: null,
      inheritsFrom: null,
      content: {
        resource_packs: [],
        shader_packs: [],
        worlds: [
          {
            dir_name: "新的世界",
            level_status: "ok",
            level_error: null,
            name: "新的世界",
            mode: "survival",
            last_played: now - 3 * DAY,
            size_bytes: 40 * MB,
            modified_at: now - 3 * DAY,
          },
          {
            dir_name: "生存",
            level_status: "ok",
            level_error: null,
            name: "生存",
            mode: "survival",
            last_played: now - 8 * DAY,
            size_bytes: 85 * MB,
            modified_at: now - 8 * DAY,
          },
        ],
      },
      sizeBytes: 210 * MB,
      fileCount: 900,
      coverFiles: [],
    },
    {
      dto: readyDto("RLCraft", "1.12.2", [{ kind: "forge", version: "14.23.5.2860" }], 8, now - 90 * DAY),
      settings: { ...defaultSettings(), memory_mb: 8192, isolation: "enabled" },
      modpack: { platform: "curseforge", project_id: "285109", version_id: "4612979", name: "RLCraft", version: "2.9.3" },
      inheritsFrom: null,
      content: emptyContent(),
      sizeBytes: 1300 * MB,
      fileCount: 9200,
      coverFiles: [],
    },
    {
      dto: {
        id: "没装完",
        status: "broken",
        broken_reason: "缺少版本 JSON",
        mc_version: null,
        loaders: [],
        release_type: null,
        is_release: false,
        java_major: null,
        quick_play: null,
        settings_error: null,
        incomplete: {
          kind: "install",
          outcome: "failed",
          started_at: now - 2 * DAY,
          spec: { mc_version: "1.20.1", loader: "neoforge", loader_version: "47.1.106" },
          error: { code: "download_failed", message: "库 阶段有 3/41 个文件下载失败" },
        },
        created_at: now - 2 * DAY,
      },
      settings: defaultSettings(),
      modpack: null,
      inheritsFrom: null,
      content: emptyContent(),
      sizeBytes: 12 * MB,
      fileCount: 3,
      coverFiles: [],
    },
  ];
}

// ---------------------------------------------------------------- 存档备份

/**
 * 作用域 -> 存档文件夹名 -> 备份表。隔离实例的备份记在实例 id 下，不隔离的都记在 SHARED_BACKUPS 下，与后端的备份目录一样分层。
 * 不分新旧顺序，列出时再按 created_at 倒序。
 */
type BackupBook = Record<string, Record<string, WorldBackupDto[]>>;

/** 不隔离的实例共用的那一层备份；实例 id 不会含星号，不与任何实例相撞。 */
const SHARED_BACKUPS = "*shared";

function backupEntry(createdAt: number, kind: BackupKind, sizeBytes: number, levelName: string | null): WorldBackupDto {
  return { file: `${createdAt}-${kind}.zip`, kind, created_at: createdAt, size_bytes: sizeBytes, level_name: levelName };
}

/** 樱花生存的「New World」带着两份自动、一份手动：备份列表弹窗在浏览器里打开就有东西看。 */
function seedBackups(): BackupBook {
  const now = Date.now();
  return {
    樱花生存: {
      "New World": [
        backupEntry(now - 2 * 3_600_000, "auto", 172 * MB, "樱花谷"),
        backupEntry(now - DAY - 4 * 3_600_000, "manual", 168 * MB, "樱花谷"),
        backupEntry(now - 3 * DAY, "auto", 160 * MB, "樱花村"),
      ],
    },
  };
}

interface ManifestSeed {
  id: string;
  type: string;
  loaders: LoaderChoice[];
  java: number;
  /** null：版本 JSON 有一项没标大小，与后端给不出体积时一致。 */
  downloadBytes: number | null;
}

const MANIFEST: ManifestSeed[] = [
  { id: "1.21.1", type: "release", loaders: ["fabric", "quilt", "forge", "neoforge"], java: 21, downloadBytes: 712 * MB },
  { id: "24w14a", type: "snapshot", loaders: ["fabric"], java: 21, downloadBytes: 698 * MB },
  { id: "1.20.1", type: "release", loaders: ["fabric", "quilt", "forge", "neoforge"], java: 17, downloadBytes: 655 * MB },
  { id: "1.12.2", type: "release", loaders: ["forge"], java: 8, downloadBytes: 238 * MB },
  { id: "1.5.2", type: "release", loaders: [], java: 8, downloadBytes: null },
];

const LOADER_VERSIONS: Partial<Record<`${LoaderChoice}:${string}`, LoaderVersionDto[]>> = {
  "fabric:1.21.1": [
    { version: "0.16.10", stable: true },
    { version: "0.16.9", stable: true },
    { version: "0.16.8-beta", stable: false },
  ],
  "fabric:24w14a": [{ version: "0.16.10", stable: true }],
  "fabric:1.20.1": [{ version: "0.16.10", stable: true }],
  "quilt:1.21.1": [
    { version: "0.27.1", stable: true },
    { version: "0.27.2-beta.1", stable: false },
  ],
  "quilt:1.20.1": [{ version: "0.27.1", stable: true }],
  "forge:1.21.1": [
    { version: "52.0.20", stable: true },
    { version: "52.0.2", stable: true },
  ],
  "forge:1.20.1": [
    { version: "47.3.0", stable: true },
    { version: "47.2.0", stable: true },
  ],
  "forge:1.12.2": [{ version: "14.23.5.2860", stable: true }],
  "neoforge:1.21.1": [
    { version: "21.1.77", stable: true },
    { version: "21.1.9-beta", stable: false },
  ],
  "neoforge:1.20.1": [{ version: "47.1.106", stable: true }],
};

let instances: MockInstance[] = seedInstances();
let pins: string[] = ["樱花生存", "1.21.1"];

/** 数据目录里的默认设置；null 为没有。配置里的开关在 mock 里恒为开。 */
interface MockTemplate {
  files: TemplateFileDto[];
  source_instance: string | null;
  saved_at: number | null;
}
let template: MockTemplate | null = null;
let backups: BackupBook = seedBackups();
// 实例上的全部占用，键不分大小写，与后端 InstanceLocks 一致：同一实例可以同时有几件兼容的事。
// usedBy 只在 inherited 时有：正以这个实例为基底的那个实例。
const holds = new Map<string, { token: number; activity: InstanceActivity; usedBy: string | null }[]>();
let nextHoldToken = 0;

// ---------------------------------------------------------------- 共用

function str(args: MockArgs, key: string): string {
  const value = args[key];
  if (typeof value !== "string") throw new Error(`mock：${key} 应为字符串`);
  return value;
}

function optStr(args: MockArgs, key: string): string | null {
  const value = args[key];
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") throw new Error(`mock：${key} 应为字符串或 null`);
  return value;
}

function invalid(field: string, reason: string, message: string, extra: Record<string, unknown> = {}): IpcError {
  return new IpcError("invalid_argument", message, { field, reason, ...extra });
}

function isSafeId(id: string): boolean {
  return id !== "" && !id.startsWith(".") && !/[\\/:\0]/.test(id);
}

function find(id: string): MockInstance | undefined {
  return instances.find((i) => i.dto.id === id);
}

/** 与后端一样：id 不能安全拼进路径报 invalid_argument，不存在报 version_not_installed。 */
function requireInstance(id: string): MockInstance {
  if (!isSafeId(id)) throw invalid("id", "unsafe_id", `实例 id 不合法：${JSON.stringify(id)}`, { id });
  const found = find(id);
  if (!found) throw new IpcError("version_not_installed", `本地未安装版本 ${id}`, { id });
  return found;
}

function nameError(name: string, rule: NameRule): IpcError {
  return new IpcError("invalid_argument", `实例名称「${name}」不可用：${NAME_MESSAGES[rule]}`, { field: "name", rule, name });
}

function checkName(name: string, current: string | null): void {
  const rule = checkInstanceName(
    name,
    instances.map((i) => i.dto.id),
    current,
  );
  if (rule) throw nameError(name, rule);
}

/** 同一实例上几件事并行时的先后：实例自己的事（备份存档也算）最要紧，Mod 与设置的改动其次，被当作基底最后，与后端的 report_rank 一致。 */
function reportRank(activity: InstanceActivity): number {
  if (activity === "modifying") return 1;
  if (activity === "inherited") return 2;
  return 0;
}

/** 有几件事并行时报最值得界面知道的那一件。 */
function activityOf(id: string): InstanceActivity | null {
  const held = holds.get(id.toLowerCase());
  if (held === undefined) return null;
  let primary = held[0];
  for (const entry of held) if (reportRank(entry.activity) < reportRank(primary.activity)) primary = entry;
  return primary.activity;
}

/** 正以它为基底的实例；有几个时报最早占到的那个，与 instance_busy 报的是同一个。 */
function usedByOf(id: string): string | null {
  const held = holds.get(id.toLowerCase());
  if (held === undefined) return null;
  const user = held.find((h) => h.usedBy !== null);
  return user === undefined ? null : user.usedBy;
}

/** 继承链上第一个容不下基底占用的基底，与后端 InstanceLocks::blocking_base 一致。 */
function baseBusyOf(id: string): InstanceDto["base_busy"] {
  for (const base of mockInheritanceChain(id)) {
    const held = holds.get(base.toLowerCase());
    const conflicts = held === undefined ? [] : held.filter((h) => !compatible("inherited", h.activity));
    if (conflicts.length > 0) {
      let conflict = conflicts[0];
      for (const h of conflicts) if (reportRank(h.activity) < reportRank(conflict.activity)) conflict = h;
      return { id: base, activity: conflict.activity };
    }
  }
  return null;
}

const ACTIVITY_LABELS: Record<InstanceActivity, string> = {
  installing: "安装",
  repairing: "补全文件",
  renaming: "改名",
  deleting: "删除",
  launching: "启动",
  running: "运行",
  modifying: "改动 Mod、资源或设置",
  inherited: "被其他实例使用",
  backing_up: "备份或恢复存档",
  moving: "移到其他游戏目录",
};

/**
 * 两件事能否同时在一个实例上进行，与后端 InstanceActivity::compatible_with 同一张表：Mod、资源与设置的改动彼此兼容，
 * 也与启动、运行中的游戏、存档备份兼容；被别的实例当作基底时，基底照样能改动、备份存档，几个实例也能同时以它为基底，基底自己的
 * 启动、运行与之互斥（游戏映射着 natives，用它的实例写不了）；备份要读整个存档，游戏开着会边写边打包，所以与启动、运行互斥，
 * 同一实例也只备份一份，兼容集合比运行宽，游戏退出后才能原地转过去；新建、补全、改名、删除、移到别的游戏目录会挪走或重写整个目录，
 * 与任何事都互斥。
 */
function compatible(a: InstanceActivity, b: InstanceActivity): boolean {
  if (a === "modifying") return b === "modifying" || b === "launching" || b === "running" || b === "backing_up" || b === "inherited";
  if (a === "inherited") return b === "modifying" || b === "backing_up" || b === "inherited";
  if (a === "backing_up") return b === "modifying" || b === "inherited";
  return (a === "launching" || a === "running") && b === "modifying";
}

/** 实例上的一份占用。release 放开它；setActivity 只用于转向兼容集合不比原来窄的事（启动转运行、运行转备份）。 */
export interface MockInstanceHold {
  release(): void;
  setActivity(activity: InstanceActivity): void;
}

/** 实例连同基底的占用。intoBackup 是后端的 into_backup：游戏退出转自动备份，实例原地转成备份，基底当即放开。 */
export interface MockChainHold extends MockInstanceHold {
  intoBackup(): void;
}

/** instance_busy 的形状与后端 busy() 一致：detail 带实例 id 与正在做的事，基底占用再带正在用它的实例。 */
function busyError(id: string, activity: InstanceActivity, usedBy: string | null = null): IpcError {
  if (usedBy !== null) {
    return new IpcError("instance_busy", `实例 ${id} 正在被实例 ${usedBy} 使用，请稍后再试`, { id, activity, used_by: usedBy });
  }
  return new IpcError("instance_busy", `实例 ${id} 正在${ACTIVITY_LABELS[activity]}，请稍后再试`, { id, activity });
}

/** 占住实例做 activity；有与它不兼容的事在做时报 instance_busy，形状与后端一致。 */
export function acquireMockInstance(id: string, activity: InstanceActivity): MockInstanceHold {
  if (activity === "inherited") throw new Error("mock：基底占用要记下使用者，只经 acquireMockInstanceWithBases 占");
  return hold(id, activity, null);
}

/**
 * 占住实例 id 做 activity，同时以它的名义占住继承链上的基底 bases，与后端 acquire_with_bases 一致：先占实例自己，
 * 再依次占基底，任一处冲突报 instance_busy（基底被占时 detail.id 是那个基底），已占到的一并放开；与 id 同名或
 * 彼此只差大小写的基底只占一次。setActivity 只改实例自己那一份。
 */
export function acquireMockInstanceWithBases(id: string, activity: InstanceActivity, bases: readonly string[]): MockChainHold {
  const own = acquireMockInstance(id, activity);
  const keys = new Set([id.toLowerCase()]);
  let held: MockInstanceHold[] = [];
  try {
    for (const base of bases) {
      const key = base.toLowerCase();
      if (keys.has(key)) continue;
      keys.add(key);
      held.push(hold(base, "inherited", id));
    }
  } catch (error) {
    for (const h of held) h.release();
    own.release();
    throw error;
  }
  return {
    release: () => {
      for (const h of held) h.release();
      own.release();
    },
    setActivity: (next) => own.setActivity(next),
    intoBackup: () => {
      own.setActivity("backing_up");
      for (const h of held) h.release();
      held = [];
    },
  };
}

/**
 * id 继承链上除它自己以外的实例，由近及远，与后端 inheritance_chain 一致：链上某一环不在时停在那一环（它的 id
 * 已收进结果），判环不分大小写。
 */
export function mockInheritanceChain(id: string): string[] {
  const seen = new Set([id.toLowerCase()]);
  const chain: string[] = [];
  let current = find(id);
  while (current !== undefined && current.inheritsFrom !== null) {
    const parent = current.inheritsFrom;
    if (seen.has(parent.toLowerCase())) break;
    seen.add(parent.toLowerCase());
    chain.push(parent);
    current = instances.find((i) => i.dto.id.toLowerCase() === parent.toLowerCase());
  }
  return chain;
}

function hold(id: string, activity: InstanceActivity, usedBy: string | null): MockInstanceHold {
  const key = id.toLowerCase();
  const held = holds.get(key);
  // 冲突有几处时报列表里也报的那一件，与后端同一优先级；同级时报最早占到的
  const conflicts = held === undefined ? [] : held.filter((h) => !compatible(activity, h.activity));
  if (conflicts.length > 0) {
    let conflict = conflicts[0];
    for (const h of conflicts) if (reportRank(h.activity) < reportRank(conflict.activity)) conflict = h;
    throw busyError(id, conflict.activity, conflict.usedBy);
  }
  const entry = { token: nextHoldToken, activity, usedBy };
  nextHoldToken += 1;
  holds.set(key, held === undefined ? [entry] : [...held, entry]);
  const ownEntry = () => {
    const list = holds.get(key);
    const found = list === undefined ? undefined : list.find((h) => h.token === entry.token);
    if (list === undefined || found === undefined) throw new Error(`mock：实例 ${id} 的这份占用（${activity}）已经放开`);
    return { list, found };
  };
  return {
    release: () => {
      const { list } = ownEntry();
      const rest = list.filter((h) => h.token !== entry.token);
      if (rest.length === 0) holds.delete(key);
      else holds.set(key, rest);
    },
    setActivity: (next) => {
      ownEntry().found.activity = next;
    },
  };
}

/** 占着实例执行 work，结束（含异步完成与失败）即放开；同步的处理函数仍同步返回。 */
export function withMockInstance<T>(id: string, activity: InstanceActivity, work: () => T): T {
  const hold = acquireMockInstance(id, activity);
  let result: T;
  try {
    result = work();
  } catch (error) {
    hold.release();
    throw error;
  }
  if (result instanceof Promise) return result.finally(() => hold.release()) as T;
  hold.release();
  return result;
}

function acquire(id: string, activity: InstanceActivity): () => void {
  const hold = acquireMockInstance(id, activity);
  return () => hold.release();
}

function dependentsOf(id: string): string[] {
  return instances.filter((i) => i.inheritsFrom === id).map((i) => i.dto.id);
}

function ensureNoDependents(id: string): void {
  const dependents = dependentsOf(id);
  if (dependents.length > 0) {
    throw new IpcError("instance_has_dependents", `实例 ${id} 被 ${dependents.join("、")} 依赖，不能改名或删除`, { id, dependents });
  }
}

/** 隔离生效值：实例覆盖优先；跟随全局时按默认档位，装了加载器或不是正式版的隔离。 */
function isolatedOf(instance: MockInstance): boolean {
  const { isolation } = instance.settings;
  if (isolation === "enabled") return true;
  if (isolation === "disabled") return false;
  return instance.dto.loaders.some((l) => l.kind !== "optifine" && l.kind !== "liteloader") || !instance.dto.is_release;
}

/** 同一输入得同一串 length 位小写十六进制：每 8 位一轮 FNV-1a，各轮只靠输入前缀的轮次区分。 */
function stableHex(text: string, length: number): string {
  let out = "";
  for (let round = 0; out.length < length; round++) {
    let hash = 0x811c9dc5;
    for (const ch of `${round}:${text}`) {
      hash ^= ch.codePointAt(0) as number;
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    out += hash.toString(16).padStart(8, "0");
  }
  return out.slice(0, length);
}

/**
 * 卡面图片的取图键：文件不在盘上（没导入过、被换掉清理了、被手动删了）为 null，与后端列实例时的登记一致。
 * 后端的键是图片路径的 SHA-1；mock 没有真实路径，按实例与文件名给出同样形状（40 位小写十六进制）的确定性键，换名即换键。
 */
function coverImageKey(instance: MockInstance, file: string | null): string | null {
  if (file === null || !instance.coverFiles.includes(file)) return null;
  return stableHex(`${instance.dto.id}/${file}`, 40);
}

function toDto(instance: MockInstance): InstanceDto {
  const playError = mockPlayRecordsError();
  const play = playError === null ? mockPlaySummary(instance.dto.id) : null;
  const ready = instance.dto.status === "ready";
  const crash = mockCrashReport(instance.dto.id);
  return {
    ...instance.dto,
    description: instance.settings.description,
    cover: instance.settings.cover,
    cover_image: coverImageKey(instance, instance.settings.cover_image),
    background: instance.settings.background,
    background_image: coverImageKey(instance, instance.settings.background_image),
    memory_mb: instance.settings.memory_mb,
    // 与 list_mods 数的是同一份文件表，两边不会对不上。
    mod_count: ready ? mockModFileCount(instance.dto.id) : null,
    world_count: ready ? instance.content.worlds.length : null,
    isolated: ready ? isolatedOf(instance) : null,
    modpack: instance.modpack,
    modpack_error: null,
    last_crash_at: crash === null ? null : crash.at,
    last_crash_error: null,
    activity: activityOf(instance.dto.id),
    used_by: usedByOf(instance.dto.id),
    base_busy: ready ? baseBusyOf(instance.dto.id) : null,
    playtime_min: playError !== null ? null : play === null ? 0 : play.playtime_min,
    last_played_at: play === null ? null : play.last_played_at,
    play_error: playError,
    dir_error: null,
  };
}

/** 版本 JSON 可用的实例的游戏版本与加载器；不存在或损坏为 null（后端对这样的实例报 version_not_installed）。 */
export function mockInstanceFacts(id: string): { mc_version: string; loaders: string[] } | null {
  const found = find(id);
  if (found === undefined || found.dto.status !== "ready" || found.dto.mc_version === null) return null;
  return { mc_version: found.dto.mc_version, loaders: found.dto.loaders.map((l) => l.kind) };
}

/** 别的领域 mock 新建出的实例（整合包导入）记进实例列表，与后端「导入后 list_instances 能看到」一致。 */
export function addMockInstance(
  id: string,
  mcVersion: string,
  loader: InstanceDto["loaders"][number] | null,
  modpack: InstanceModpackDto | null,
): void {
  if (find(id) !== undefined) throw new Error(`mock 实例 ${id} 已存在`);
  // 与新建一样，不继承已经不在的同名旧实例留下的记录。
  forgetMockLaunchRecords(id);
  instances.push({
    dto: readyDto(id, mcVersion, loader === null ? [] : [loader], 21, Date.now()),
    // 整合包导入的实例强制隔离，与后端写入的实例设置一致。
    settings: { ...defaultSettings(), isolation: "enabled" },
    modpack,
    // 与后端一样，带加载器的实例 JSON 继承原版：启动、补全它都要连带占住原版，原版也因此不能删、不能改名
    inheritsFrom: loader === null ? null : mcVersion,
    content: emptyContent(),
    sizeBytes: 0,
    fileCount: 0,
    coverFiles: [],
  });
}

/** 模拟加载器自带的库被删后补全失败：留下与后端同形的未完成标记。 */
export function loseMockLoaderLibrary(id: string, fileName: string): void {
  const message = `加载器自带的库 ${fileName} 缺失或已损坏，它只能由加载器安装器生成，需要重新安装加载器`;
  requireInstance(id).dto.incomplete = { kind: "repair", outcome: "failed", started_at: Date.now(), spec: null, error: { code: "loader_library_missing", message } };
}

/** 模拟卡面图片在启动器外被删：设置照旧引用它，列表里的取图键变成 null。 */
export function loseMockCoverImage(id: string, file: string): void {
  const instance = requireInstance(id);
  if (!instance.coverFiles.includes(file)) throw new Error(`mock 实例 ${id} 的卡面图片目录里没有 ${file}`);
  instance.coverFiles = instance.coverFiles.filter((f) => f !== file);
}

/** 给实例加一个空存档（模拟游戏里新建的）。 */
export function addMockWorld(id: string, world: string): void {
  const instance = requireInstance(id);
  const created: WorldDto = { dir_name: world, level_status: "ok", level_error: null, name: world, mode: "survival", last_played: Date.now(), size_bytes: 10 * MB, modified_at: Date.now() };
  instance.content.worlds = [...instance.content.worlds, created];
}

/** 别的领域 mock 要求实例存在时用：id 不安全报 invalid_argument，不存在报 version_not_installed，与后端同形。 */
export function requireMockInstanceId(id: string): void {
  requireInstance(id);
}

/** 实例版本的直达能力，与 list_instances 给的同一份；实例不存在报 version_not_installed，与后端启动时一致。 */
export function mockInstanceQuickPlay(id: string): InstanceDto["quick_play"] {
  return requireInstance(id).dto.quick_play;
}

/** 实例存档的目录名；实例不存在或损坏为 null。 */
export function mockInstanceWorlds(id: string): string[] | null {
  if (mockInstanceFacts(id) === null) return null;
  const found = find(id);
  return found === undefined ? null : found.content.worlds.map((w) => w.dir_name);
}

/**
 * 装好的资源包、光影记进实例内容，实例页的列表才看得到它（与后端读目录同一口径）。新装的还没在游戏里启用：
 * 资源包没有加载顺序、光影不是当前光影；同名文件覆盖时沿用原记录的启用状态（游戏的选项文件按文件名记）。
 */
export function recordMockPack(id: string, type: "resource_pack" | "shader", fileName: string, sizeBytes: number): void {
  const found = find(id);
  if (found === undefined) throw new Error(`mock 里没有实例 ${id}`);
  const at = Date.now();
  const content = found.content;
  if (type === "resource_pack") {
    const previous = content.resource_packs.find((p) => p.file_name === fileName);
    const entry = { file_name: fileName, is_dir: false, size_bytes: sizeBytes, modified_at: at, load_order: previous === undefined ? null : previous.load_order };
    content.resource_packs = [...content.resource_packs.filter((p) => p.file_name !== fileName), entry];
  } else {
    const previous = content.shader_packs.find((p) => p.file_name === fileName);
    const entry = { file_name: fileName, is_dir: false, size_bytes: sizeBytes, modified_at: at, active: previous !== undefined && previous.active };
    content.shader_packs = [...content.shader_packs.filter((p) => p.file_name !== fileName), entry];
  }
}

/** 全部实例 id（含损坏的），按种子与新建的先后。 */
export function mockInstanceIds(): string[] {
  return instances.map((i) => i.dto.id);
}

function loaderChoice(raw: string): LoaderChoice {
  const choice = LOADER_CHOICES.find((c) => c === raw);
  if (choice === undefined) throw invalid("loader", "unknown", `未知加载器 ${raw}（支持 fabric/quilt/forge/neoforge）`);
  return choice;
}

function parseLoader(raw: string | null): LoaderChoice | null {
  return raw === null ? null : loaderChoice(raw);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function stage(taskId: string, message: string): void {
  emitMockEvent(CORE_EVENT, { kind: "stage", task_id: taskId, message });
}

/** 与后端 install_plan 同一份步骤表：Forge / NeoForge 先补齐原版再装加载器，装好后照合并后的版本 JSON 再校验一遍。 */
function mockInstallPlan(loader: LoaderChoice | null, useTemplate: boolean): InstallPhase[] {
  const plan: InstallPhase[] = ["metadata"];
  if (loader === "fabric" || loader === "quilt") plan.push("loader_profile", "libraries", "assets", "natives");
  else if (loader === "forge" || loader === "neoforge") plan.push("libraries", "assets", "natives", "java", "loader_installer", "loader_libraries", "loader_processors", "verify");
  else plan.push("libraries", "assets", "natives");
  if (useTemplate) plan.push("template");
  return plan;
}

/** 只补全、不重装时的步骤表，与后端 repair_instance 的 Complete 一致。 */
const MOCK_COMPLETE_PLAN: readonly InstallPhase[] = ["libraries", "assets", "natives"];

function phase(taskId: string, plan: readonly InstallPhase[], key: InstallPhase): void {
  const index = plan.indexOf(key);
  if (index === -1) throw new Error(`步骤 ${key} 不在这次的步骤表 ${plan.join()} 里`);
  emitMockEvent(CORE_EVENT, { kind: "phase", task_id: taskId, plan: [...plan], index });
}

/** 假后端只在「本体与库」那一步真的推下载进度，之后各步（模板除外，它跟着套模板报）接着报出来，进度条照样按步走。 */
function phasesAfterLibraries(taskId: string, plan: readonly InstallPhase[]): void {
  for (const key of plan.slice(plan.indexOf("libraries") + 1)) if (key !== "template") phase(taskId, plan, key);
}

/** 一段假下载：逐步推进度，期间被取消即以 cancelled 拒绝。 */
async function fakeDownload(taskId: string, files: number, bytesPerFile: number): Promise<void> {
  for (let step = 1; step <= MOCK_INSTALL_STEPS; step++) {
    await sleep(MOCK_STEP_MS);
    if (isMockTaskCancelled(taskId)) throw new IpcError("cancelled", "已取消");
    const finished = Math.round((files * step) / MOCK_INSTALL_STEPS);
    emitMockEvent(CORE_EVENT, {
      kind: "download",
      task_id: taskId,
      total: files,
      finished,
      bytes: finished * bytesPerFile,
      total_bytes: files * bytesPerFile,
      transferred: finished * bytesPerFile,
      speed: Math.round((files * bytesPerFile) / ((MOCK_INSTALL_STEPS * MOCK_STEP_MS) / 1000)),
    });
  }
}

// ---------------------------------------------------------------- 设置校验（与后端逐项一致）

const SETTINGS_KEYS = ["description", "cover", "cover_image", "background", "background_image", "isolation", "memory_mb", "java", "jvm_args", "resolution", "fullscreen"] as const;

function malformed(message: string): IpcError {
  return invalid("settings", "malformed", `实例设置格式不对：${message}`);
}

function parseSettings(raw: unknown): InstanceSettingsDto {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw malformed("应为对象");
  const s = raw as Record<string, unknown>;
  const unknown = Object.keys(s).find((k) => !(SETTINGS_KEYS as readonly string[]).includes(k));
  if (unknown !== undefined) throw malformed(`不认识的字段 ${unknown}`);
  const nullableString = (key: string): string | null => {
    const v = s[key];
    if (v === null || v === undefined) return null;
    if (typeof v !== "string") throw malformed(`${key} 应为字符串或 null`);
    return v;
  };
  const isolation = s.isolation;
  if (isolation !== "follow_global" && isolation !== "enabled" && isolation !== "disabled") throw malformed("isolation 取值不对");
  const background = s.background;
  if (background !== "follow" && background !== "art" && background !== "texture" && background !== "image") throw malformed("background 取值不对");
  const memory = s.memory_mb;
  if (memory !== null && memory !== undefined && (typeof memory !== "number" || !Number.isInteger(memory) || memory < 0)) {
    throw malformed("memory_mb 应为非负整数或 null");
  }
  if (typeof s.java !== "string") throw malformed("缺少 java");
  if (typeof s.jvm_args !== "string") throw malformed("缺少 jvm_args");
  if (typeof s.fullscreen !== "boolean") throw malformed("缺少 fullscreen");
  const resolution = s.resolution as Record<string, unknown> | null | undefined;
  if (
    typeof resolution !== "object" ||
    resolution === null ||
    !Number.isInteger(resolution.width) ||
    !Number.isInteger(resolution.height) ||
    (resolution.width as number) < 0 ||
    (resolution.height as number) < 0
  ) {
    throw malformed("resolution 应为 { width, height } 非负整数");
  }
  return {
    description: nullableString("description"),
    cover: nullableString("cover"),
    cover_image: nullableString("cover_image"),
    background,
    background_image: nullableString("background_image"),
    isolation,
    // 与后端 serde 一致：Option 字段缺省即 null。
    memory_mb: typeof memory === "number" ? memory : null,
    java: s.java,
    jvm_args: s.jvm_args,
    resolution: { width: resolution.width as number, height: resolution.height as number },
    fullscreen: s.fullscreen,
  };
}

function validateSettings(s: InstanceSettingsDto): void {
  const violation = (field: string, reason: string) =>
    new IpcError("invalid_argument", `实例设置的 ${field} 不合法：${reason}`, { field, reason });
  if (s.description !== null && s.description.trim() === "") throw violation("description", "没有介绍时应为 null，而不是空字符串");
  if (s.cover !== null && !/^[a-z0-9_]{1,64}$/.test(s.cover)) {
    throw violation("cover", `封面预设 id 只能由小写字母、数字与下划线组成（1 到 64 个）：${JSON.stringify(s.cover)}`);
  }
  if (s.cover_image !== null && !COVER_IMAGE_NAME.block.test(s.cover_image)) {
    throw violation("cover_image", `封面方块图片应形如 block-<16 位十六进制>.png：${JSON.stringify(s.cover_image)}`);
  }
  if (s.background_image !== null && !COVER_IMAGE_NAME.background.test(s.background_image)) {
    throw violation("background_image", `卡面背景图片应形如 background-<16 位十六进制>.png 或 .jpg：${JSON.stringify(s.background_image)}`);
  }
  if (s.background === "image" && s.background_image === null) throw violation("background", "背景设为图片时 background_image 不能为空");
  if (s.memory_mb !== null && (s.memory_mb < 1024 || s.memory_mb % 512 !== 0)) {
    throw violation("memory_mb", `内存至少 1024 MB 且为 512 的整数倍，收到 ${s.memory_mb}`);
  }
  if (s.java !== "auto" && !/^([A-Za-z]:[\\/]|\\\\)/.test(s.java)) {
    throw violation("java", `Java 应为 "auto" 或 java 可执行文件的绝对路径，收到 ${s.java}`);
  }
  const { width, height } = s.resolution;
  if (width < 320 || width > 7680 || height < 240 || height > 4320) {
    throw violation("resolution", `宽应在 320-7680、高应在 240-4320 之间，收到 ${width}×${height}`);
  }
}

// ---------------------------------------------------------------- 卡面图片

/** 与后端 CoverImageSlot::accepts 一致：前缀 + 16 位小写十六进制 + 这个位置认的扩展名，同时挡住路径穿越。 */
const COVER_IMAGE_NAME: Record<CoverImageSlotDto, RegExp> = {
  background: /^background-[0-9a-f]{16}\.(png|jpg)$/,
  block: /^block-[0-9a-f]{16}\.png$/,
};

/**
 * 原图扩展名 -> 背景存下的格式。后端按文件头认图、按有没有透明决定存 JPEG 还是 PNG；mock 读不了文件，
 * 按扩展名代替：JPEG 本来就不透明，PNG 与 WebP 可能带透明。方块一律存 PNG。
 */
const COVER_IMAGE_SOURCES: Readonly<Record<string, "png" | "jpg">> = { png: "png", jpg: "jpg", jpeg: "jpg", webp: "png" };

/** 与后端把 slot 解成 CoverImageSlot 一致：不认识的位置报 invalid_argument，detail.field 为 slot。 */
function coverSlot(raw: string): CoverImageSlotDto {
  if (raw !== "background" && raw !== "block") throw invalid("slot", "unknown", `不认识的卡面图片位置：${raw}`);
  return raw;
}

/** 落下一份设置，并像后端保存后那样清掉卡面图片目录里不再被引用的文件。 */
function commitSettings(instance: MockInstance, settings: InstanceSettingsDto): void {
  instance.settings = settings;
  instance.coverFiles = instance.coverFiles.filter((f) => f === settings.cover_image || f === settings.background_image);
}

/**
 * 与后端同序：先认位置，再认绝对路径，然后占住实例（改名、删除、新建、补全进行中报 instance_busy）、认实例，最后才认图
 * （扩展名代替文件头）。文件名的哈希段由位置与原图路径推出（后端取内容哈希），同一张图重复导入得同一个名字。
 */
function importCoverImage(args: MockArgs): InstanceSettingsDto {
  const id = str(args, "id");
  const slot = coverSlot(str(args, "slot"));
  const path = str(args, "path");
  if (!/^([A-Za-z]:[\\/]|\\\\)/.test(path)) throw invalid("path", "not_absolute", `图片路径须是绝对路径：${path}`);
  return withMockInstance(id, "modifying", () => {
    const instance = requireInstance(id);
    const dot = path.lastIndexOf(".");
    const ext = dot < 0 ? "" : path.slice(dot + 1).toLowerCase();
    const stored = Object.hasOwn(COVER_IMAGE_SOURCES, ext) ? COVER_IMAGE_SOURCES[ext] : null;
    if (stored === null) throw invalid("path", "unsupported_format", `只能用 PNG、JPEG 或 WebP 图片：${path}`);
    const hash = stableHex(`${slot}:${path}`, 16);
    const file = slot === "block" ? `block-${hash}.png` : `background-${hash}.${stored}`;
    const settings: InstanceSettingsDto =
      slot === "block" ? { ...instance.settings, cover_image: file } : { ...instance.settings, background: "image", background_image: file };
    if (!instance.coverFiles.includes(file)) instance.coverFiles = [...instance.coverFiles, file];
    commitSettings(instance, settings);
    return settings;
  });
}

// ---------------------------------------------------------------- 命令

function manifestDto(): ManifestDto {
  const versions: ManifestVersionDto[] = MANIFEST.map((v, i) => ({
    id: v.id,
    release_type: v.type,
    release_time: new Date(Date.UTC(2024, 7, 8) - i * 90 * DAY).toISOString(),
    loaders: [...v.loaders],
  }));
  return {
    latest: { release: "1.21.1", snapshot: "24w14a" },
    versions,
    loader_errors: [],
    stale_since: null,
    fetch_error: null,
  };
}

// ---------------------------------------------------------------- 默认设置

function templateInfo(): TemplateInfoDto {
  if (template === null) return { present: false, files: [], source_instance: null, saved_at: null, enabled: true };
  return { present: template.files.length > 0, files: template.files, source_instance: template.source_instance, saved_at: template.saved_at, enabled: true };
}

/** 与后端同一个判断顺序：配置开关、模板是否为空、新实例是否隔离（不隔离的共用游戏目录根下的设置，一个文件都不碰）。 */
function applyTemplate(instance: MockInstance): TemplateOutcomeDto {
  if (template === null || template.files.length === 0) return { status: "skipped", reason: "empty" };
  if (!isolatedOf(instance)) return { status: "skipped", reason: "shared_working_dir" };
  // 新建的实例目录里还没有任何设置文件：模板里的全都补上
  return { status: "applied", copied: template.files.map((f) => f.name), kept: [] };
}

const TEMPLATE_SKIP_STAGE: Record<Extract<TemplateOutcomeDto, { status: "skipped" }>["reason"], string> = {
  disabled: "新建实例时沿用默认设置已在配置里关闭",
  empty: "还没有默认设置",
  shared_working_dir: "这个实例与其他未隔离的实例共用 .minecraft 里的设置",
};

function templateStage(outcome: TemplateOutcomeDto): string {
  if (outcome.status === "skipped") return `没有沿用默认设置：${TEMPLATE_SKIP_STAGE[outcome.reason]}`;
  const kept = outcome.kept.length === 0 ? "" : `（已有的 ${outcome.kept.join("、")} 保留不动）`;
  return `沿用默认设置：补上 ${outcome.copied.join("、")}${kept}`;
}

/** useTemplate 与后端的 Option<bool> 形参一致：缺省等于 false，给了就必须是布尔。 */
function useTemplateArg(args: MockArgs): boolean {
  const value = args.useTemplate;
  if (value === undefined || value === null) return false;
  if (typeof value !== "boolean") throw invalid("useTemplate", "type", `useTemplate 应为布尔值：${JSON.stringify(value)}`);
  return value;
}

async function installVersion(args: MockArgs): Promise<InstallResultDto> {
  const taskId = str(args, "taskId");
  const mcVersion = str(args, "id");
  const loader = parseLoader(optStr(args, "loader"));
  const loaderVersionArg = optStr(args, "loaderVersion");
  const name = str(args, "targetName");
  const useTemplate = useTemplateArg(args);
  if ((loader === "forge" || loader === "neoforge") && loaderVersionArg === null) {
    throw new IpcError("loader_version_not_found", `${LOADER_NAMES[loader]} 没有适用于 ${mcVersion} 的可用 loader 版本`);
  }
  checkName(name, null);
  const release = acquire(name, "installing");
  try {
    beginMockTask(taskId);
  } catch (error) {
    release();
    throw error;
  }
  const createdAt = Date.now();
  const incomplete: IncompleteDto = {
    kind: "install",
    outcome: "pending",
    started_at: createdAt,
    spec: { mc_version: mcVersion, loader, loader_version: loaderVersionArg },
    error: null,
  };
  const instance: MockInstance = {
    dto: {
      id: name,
      status: "broken",
      broken_reason: "缺少版本 JSON",
      mc_version: null,
      loaders: [],
      release_type: null,
      is_release: false,
      java_major: null,
      quick_play: null,
      settings_error: null,
      incomplete,
      created_at: createdAt,
    },
    settings: defaultSettings(),
    modpack: null,
    inheritsFrom: null,
    content: emptyContent(),
    sizeBytes: 0,
    fileCount: 0,
    coverFiles: [],
  };
  instances.push(instance);
  // 与后端一样，名字下还留着的记录属于已经不在的同名旧实例（浏览器里刷新后游玩记录重新播种就会这样），新实例从零开始；
  // 会话日志与崩溃报告在后端存于实例目录，新目录里本来就没有。
  forgetMockLaunchRecords(name);
  const plan = mockInstallPlan(loader, useTemplate);
  try {
    if (isMockTaskCancelled(taskId)) throw new IpcError("cancelled", "已取消");
    phase(taskId, plan, "metadata");
    stage(taskId, `查找原版 ${mcVersion}`);
    await sleep(MOCK_STEP_MS);
    const entry = MANIFEST.find((v) => v.id === mcVersion);
    if (!entry) throw new IpcError("install_failed", `installer jar 内缺少条目: 版本清单中的 ${mcVersion}`);
    let loaderVersion: string | null = null;
    if (loader) {
      if (plan.includes("loader_profile")) phase(taskId, plan, "loader_profile");
      const available = LOADER_VERSIONS[`${loader}:${mcVersion}`] ?? [];
      // 没给版本号时与后端一样取推荐版：最新稳定版，没有稳定版取最新的。
      const recommended = available.find((v) => v.stable) ?? available[0];
      loaderVersion = loaderVersionArg !== null ? loaderVersionArg : recommended ? recommended.version : null;
      if (loaderVersion === null || !available.some((v) => v.version === loaderVersion)) {
        throw new IpcError("loader_version_not_found", `${LOADER_NAMES[loader]} 没有适用于 ${mcVersion} 的可用 loader 版本`);
      }
      stage(taskId, `获取 ${LOADER_NAMES[loader]} 加载器信息`);
    }
    stage(taskId, "补全库、资源与 natives");
    phase(taskId, plan, "libraries");
    await fakeDownload(taskId, 40, 512 * 1024);
    phasesAfterLibraries(taskId, plan);
    instance.dto = {
      ...readyDto(name, mcVersion, loader && loaderVersion ? [{ kind: loader, version: loaderVersion }] : [], entry.java, createdAt),
      release_type: entry.type,
      is_release: entry.type === "release",
    };
    instance.sizeBytes = 40 * 512 * 1024;
    instance.fileCount = 40;
    // 与后端一样在补全之后、首次启动之前套模板：判断隔离要用到装好后才知道的版本类型
    if (useTemplate) phase(taskId, plan, "template");
    const templateOutcome = useTemplate ? applyTemplate(instance) : null;
    if (templateOutcome !== null) stage(taskId, templateStage(templateOutcome));
    stage(taskId, `实例 ${name} 安装完成：库 40 / 资源 0 / natives 0`);
    return {
      id: name,
      mc_version: mcVersion,
      loader: loader && loaderVersion ? { kind: loader, version: loaderVersion } : null,
      libraries: 40,
      assets: 0,
      natives: 0,
      template: templateOutcome,
    };
  } catch (error) {
    if (error instanceof IpcError && error.code === "cancelled") {
      instances = instances.filter((i) => i !== instance);
    } else if (error instanceof IpcError) {
      instance.dto.incomplete = { ...incomplete, outcome: "failed", error: { code: error.code, message: error.message } };
    }
    throw error;
  } finally {
    endMockTask(taskId);
    release();
  }
}

/** reinstallLoader 与后端的 Option<bool> 形参一致：缺省等于 false，给了就必须是布尔。 */
function reinstallLoaderArg(args: MockArgs): boolean {
  const value = args.reinstallLoader;
  if (value === undefined) return false;
  if (typeof value !== "boolean") throw invalid("reinstallLoader", "type", `reinstallLoader 应为布尔值：${JSON.stringify(value)}`);
  return value;
}

/** 能原样装回的加载器，与后端 reinstallable_loader 同一套判定；装不回时给写进不可补全原因的说明。 */
function reinstallableMockLoader(loaders: InstanceDto["loaders"]): { kind: LoaderChoice; version: string } | string {
  const external = loaders.find((l) => l.kind === "optifine" || l.kind === "liteloader");
  if (external !== undefined) return `装着 ${external.kind === "optifine" ? "OptiFine" : "LiteLoader"}，重新安装只能装回 Fabric、Quilt、Forge 或 NeoForge，它会丢失`;
  const primary = (["neoforge", "forge", "fabric", "quilt"] as const).flatMap((kind) => {
    const found = loaders.find((l) => l.kind === kind);
    return found === undefined ? [] : [{ kind, version: found.version }];
  })[0];
  if (primary === undefined) return "没有装加载器，不需要重新安装";
  if (primary.version === null) return `读不出 ${LOADER_NAMES[primary.kind]} 的版本号，无法原样装回`;
  return { kind: primary.kind, version: primary.version };
}

/** 重新安装加载器要装回的内容，与后端 loader_reinstall_request 一致，定不出来时报同样的不可补全。 */
function mockLoaderReinstallSpec(instance: MockInstance): NonNullable<IncompleteDto["spec"]> {
  const { id, loaders, mc_version: mcVersion } = instance.dto;
  const refuse = (reason: string) => new IpcError("instance_failed", `实例 ${id} 无法补全：${reason}`, { id, reason });
  const loader = reinstallableMockLoader(loaders);
  if (typeof loader === "string") throw refuse(loader);
  if (mcVersion === null) throw refuse("读不出游戏版本号，无法原样装回");
  return { mc_version: mcVersion, loader: loader.kind, loader_version: loader.version };
}

async function repairInstance(args: MockArgs): Promise<RepairResultDto> {
  const taskId = str(args, "taskId");
  const id = str(args, "id");
  const reinstallLoader = reinstallLoaderArg(args);
  const instance = requireInstance(id);
  // 与后端一样，补全期间连同继承链上的基底一起占住：补全要读写基底里的客户端 jar 与 natives。
  const repairHold = acquireMockInstanceWithBases(id, "repairing", mockInheritanceChain(id));
  const release = () => repairHold.release();
  try {
    beginMockTask(taskId);
  } catch (error) {
    release();
    throw error;
  }
  try {
    if (instance.dto.incomplete?.kind === "modpack") {
      const reason = "整合包没有导入完，缺的 Mod 与配置补不回来，删掉这个实例后重新导入";
      throw new IpcError("instance_failed", `实例 ${id} 无法补全：${reason}`, { id, reason });
    }
    const marked = instance.dto.incomplete?.kind === "install" ? instance.dto.incomplete.spec : null;
    if (instance.dto.status === "broken" && marked === null) {
      const reason = `${instance.dto.broken_reason ?? "版本 JSON 不可用"}，也没有记下当初装的是什么`;
      throw new IpcError("instance_failed", `实例 ${id} 无法补全：${reason}`, { id, reason });
    }
    // 与后端一样：上次补全败在加载器自带的库上时，不带参数的补全也走重装，否则只会原样失败；装不回的照旧补全
    const stuck = instance.dto.incomplete?.error?.code === "loader_library_missing" && typeof reinstallableMockLoader(instance.dto.loaders) !== "string";
    const spec = marked !== null ? marked : reinstallLoader || stuck ? mockLoaderReinstallSpec(instance) : null;
    const startedAt = Date.now();
    instance.dto.incomplete = spec
      ? { kind: "install", outcome: "pending", started_at: startedAt, spec, error: null }
      : { kind: "repair", outcome: "pending", started_at: startedAt, spec: null, error: null };
    stage(taskId, `补全实例 ${id} 的文件`);
    // 重装在后端就是走一遍新建（不套模板），步骤表也是新建那一份
    const plan = spec ? mockInstallPlan(spec.loader, false) : MOCK_COMPLETE_PLAN;
    for (const key of plan.slice(0, plan.indexOf("libraries") + 1)) phase(taskId, plan, key);
    try {
      await fakeDownload(taskId, 12, 256 * 1024);
    } catch (error) {
      if (error instanceof IpcError && instance.dto.incomplete) {
        const cancelled = error.code === "cancelled";
        instance.dto.incomplete = {
          ...instance.dto.incomplete,
          outcome: cancelled ? "cancelled" : "failed",
          error: cancelled ? null : { code: error.code, message: error.message },
        };
      }
      throw error;
    }
    phasesAfterLibraries(taskId, plan);
    if (spec) {
      const entry = MANIFEST.find((v) => v.id === spec.mc_version);
      if (!entry) {
        const error = new IpcError("install_failed", `installer jar 内缺少条目: 版本清单中的 ${spec.mc_version}`);
        instance.dto.incomplete = { kind: "install", outcome: "failed", started_at: startedAt, spec, error: { code: error.code, message: error.message } };
        throw error;
      }
      const loaders = spec.loader && spec.loader_version ? [{ kind: spec.loader, version: spec.loader_version }] : [];
      instance.dto = readyDto(id, spec.mc_version, loaders, entry.java, instance.dto.created_at);
    }
    instance.dto.incomplete = null;
    return { reinstalled: spec !== null, libraries: 12, assets: 0, natives: 0 };
  } finally {
    endMockTask(taskId);
    release();
  }
}

// ---------------------------------------------------------------- 存档备份（与后端 world_backup 门面同一套规则）

/** 存档文件夹名与实例 id 同一套路径安全规则；不过报 invalid_argument，detail.field 为 world。 */
function worldArg(args: MockArgs): string {
  const world = str(args, "world");
  if (!isSafeId(world)) throw invalid("world", "unsafe", `存档文件夹名不合法：${JSON.stringify(world)}`);
  return world;
}

function requireWorld(instance: MockInstance, world: string): WorldDto {
  const found = instance.content.worlds.find((w) => w.dir_name === world);
  if (found === undefined) throw new IpcError("world_not_found", `实例 ${instance.dto.id} 里没有存档 ${world}`, { version_id: instance.dto.id, world });
  return found;
}

/** 这个实例的备份记在哪一层：共用存档的几个实例看到同一份。 */
function backupScope(id: string): string {
  return isolatedOf(requireInstance(id)) ? id : SHARED_BACKUPS;
}

function scopedBackups(scope: string, world: string): WorldBackupDto[] {
  const book = backups[scope];
  if (book === undefined) return [];
  const list = book[world];
  return list === undefined ? [] : list;
}

function setScopedBackups(scope: string, world: string, list: WorldBackupDto[]): void {
  const book = backups[scope] === undefined ? {} : backups[scope];
  if (list.length === 0) delete book[world];
  else book[world] = list;
  if (Object.keys(book).length === 0) delete backups[scope];
  else backups[scope] = book;
}

function worldBackups(id: string, world: string): WorldBackupDto[] {
  return scopedBackups(backupScope(id), world);
}

function setWorldBackups(id: string, world: string, list: WorldBackupDto[]): void {
  setScopedBackups(backupScope(id), world, list);
}

/** 与后端 merge_scope_dir 一致：把旧名字下的备份并进新名字下，新名字下原有的留着。 */
function mergeScope(from: string, to: string): void {
  const book = backups[from];
  if (book === undefined) return;
  for (const [world, list] of Object.entries(book)) setScopedBackups(to, world, [...scopedBackups(to, world), ...list]);
  delete backups[from];
}

function backupNotFound(id: string, world: string, file: string): IpcError {
  return new IpcError("world_backup_not_found", `「${world}」的备份 ${file} 已经不在了`, { id, world, file });
}

/** 毫秒撞名时加 1 毫秒，与后端一致。 */
function freshBackupTime(id: string, world: string): number {
  const taken = new Set(worldBackups(id, world).map((b) => b.created_at));
  let at = Date.now();
  while (taken.has(at)) at += 1;
  return at;
}

/**
 * 与后端 plan_prune 一致：先按每个存档保留最近 keep_per_world 份自动备份，再在全部备份超过总量上限时从全局最旧的
 * 自动备份删起；手动备份从不删，刚写成的那一份（keep）不参与第二步。返回删掉的份数。
 */
function pruneBackups(keep: { scope: string; world: string; file: string }): number {
  const policy = mockWorldBackupSettings();
  const limit = policy.max_total_gb * GIB;
  let pruned = 0;
  for (const [scope, book] of Object.entries(backups)) {
    for (const [world, list] of Object.entries(book)) {
      const autos = list.filter((b) => b.kind === "auto").sort((a, b) => b.created_at - a.created_at);
      const doomed = new Set(autos.slice(policy.keep_per_world).map((b) => b.file));
      if (doomed.size === 0) continue;
      pruned += doomed.size;
      setScopedBackups(
        scope,
        world,
        list.filter((b) => !doomed.has(b.file)),
      );
    }
  }
  const all = Object.entries(backups).flatMap(([scope, book]) => Object.entries(book).flatMap(([world, list]) => list.map((entry) => ({ scope, world, entry }))));
  let total = all.reduce((sum, b) => sum + b.entry.size_bytes, 0);
  const candidates = all
    .filter((b) => b.entry.kind === "auto" && !(b.scope === keep.scope && b.world === keep.world && b.entry.file === keep.file))
    .sort((a, b) => a.entry.created_at - b.entry.created_at);
  for (const c of candidates) {
    if (total <= limit) break;
    setScopedBackups(
      c.scope,
      c.world,
      scopedBackups(c.scope, c.world).filter((b) => b.file !== c.entry.file),
    );
    total -= c.entry.size_bytes;
    pruned += 1;
  }
  return pruned;
}

function backupDir(instance: MockInstance, world: string): { scope: WorldBackupListDto["scope"]; dir: string } {
  // 与后端一样按隔离生效值分作用域：不隔离的实例共用 .minecraft/saves，备份也放在共用的那一层
  return isolatedOf(instance)
    ? { scope: "instance", dir: `${MOCK_BACKUPS_ROOT}/instances/${instance.dto.id}/${world}` }
    : { scope: "shared", dir: `${MOCK_BACKUPS_ROOT}/shared/${world}` };
}

/** 实例上占着 wanted 里哪一件事；都没有为 null。 */
function heldActivity(instance: MockInstance, wanted: readonly InstanceActivity[]): InstanceActivity | null {
  const held = holds.get(instance.dto.id.toLowerCase());
  const hit = held === undefined ? undefined : held.find((h) => wanted.includes(h.activity));
  return hit === undefined ? null : hit.activity;
}

const GAME_ACTIVITIES: readonly InstanceActivity[] = ["launching", "running"];

/**
 * 与后端 ensure_shared_world_free 一致：实例锁只管自己，可游戏同时只跑一个。另一个也不隔离的实例正开着游戏时，
 * 它可能正打开着这份共用存档，报 instance_busy，detail 为那个实例与它的启动或运行。
 */
function ensureSharedWorldFree(id: string): void {
  const key = id.toLowerCase();
  for (const other of instances) {
    if (other.dto.id.toLowerCase() === key) continue;
    const game = heldActivity(other, GAME_ACTIVITIES);
    if (game === null) continue;
    if (!isolatedOf(requireInstance(id)) && !isolatedOf(other)) throw busyError(other.dto.id, game);
    return;
  }
}

/**
 * 与后端 ensure_shared_worlds_settled 一致，方向与上面相反：另一个也不隔离的实例正在备份、恢复或导出共用存档时，
 * 这个实例的游戏一起来就可能打开同一份存档，启动报 instance_busy，detail 为那个实例与 backing_up。
 * 启动 mock 占住实例之后、登记任务之前调用。
 */
export function ensureMockSharedWorldsSettled(id: string): void {
  const key = id.toLowerCase();
  const others = instances.filter((other) => other.dto.id.toLowerCase() !== key && heldActivity(other, ["backing_up"]) !== null);
  // 没有别的实例在备份时不看自己的存档作用域：每次启动都会经过这里
  if (others.length === 0) return;
  if (isolatedOf(requireInstance(id))) return;
  const shared = others.find((other) => !isolatedOf(other));
  if (shared !== undefined) throw busyError(shared.dto.id, "backing_up");
}

/** 存档正被导出整合包整份读走的实例（原样 id，同一实例可有多份），与后端互斥表里那份记录同一口径。 */
const savesReaders: string[] = [];
/** 正往存档里装数据包的实例，同上。 */
const savesWriters: string[] = [];

function markSaves(marked: string[], id: string): () => void {
  marked.push(id);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    marked.splice(marked.indexOf(id), 1);
  };
}

/** 记下实例的存档正被整份读走（导出整合包勾了存档），返回撤销函数；与后端一样先记下、再查备份与恢复。 */
export function markMockSavesRead(id: string): () => void {
  return markSaves(savesReaders, id);
}

/** 记下实例正往存档里写（装数据包），返回撤销函数；与后端一样先记下、再查备份、恢复与读存档的导出。 */
export function markMockSavesWritten(id: string): () => void {
  return markSaves(savesWriters, id);
}

/** 与后端 saves_holder 一致：marked 里和实例 id 用同一份存档的那个实例，它自己或同为不隔离的实例。 */
function savesHolder(id: string, marked: readonly string[]): string | undefined {
  // 没有记录时不看自己的存档作用域：每次恢复、备份都会经过这里
  if (marked.length === 0) return undefined;
  const key = id.toLowerCase();
  const own = marked.find((other) => other.toLowerCase() === key);
  if (own !== undefined) return own;
  if (isolatedOf(requireInstance(id))) return undefined;
  return marked.find((other) => !isolatedOf(requireInstance(other)));
}

/** 导出整合包与装数据包对外都是「改动中」，所以 activity 报 modifying，正文写明在做什么。 */
function savesBusy(id: string, message: string): IpcError {
  return new IpcError("instance_busy", message, { id, activity: "modifying" });
}

/** 与后端同序：恢复要替换存档，本实例或共用这份存档的另一个不隔离实例正在导出带存档的整合包时报 instance_busy。 */
function ensureSavesNotRead(id: string): void {
  const reader = savesHolder(id, savesReaders);
  if (reader !== undefined) throw savesBusy(reader, `实例 ${reader} 正在导出带存档的整合包，请稍后再试`);
}

/** 备份、恢复、导出存档与带存档的导出整合包：本实例或共用这份存档的实例正在装数据包时报 instance_busy。 */
function ensureSavesNotWritten(id: string): void {
  const writer = savesHolder(id, savesWriters);
  if (writer !== undefined) throw savesBusy(writer, `实例 ${writer} 正在往存档里装数据包，请稍后再试`);
}

/** 与后端 ensure_saves_settled_for_reading 一致：导出整合包要把存档整份读走，存档会变的时候报 instance_busy。 */
export function ensureMockSavesSettledForReading(id: string): void {
  const own = heldActivity(requireInstance(id), ["launching", "running", "backing_up"]);
  if (own !== null) throw busyError(id, own);
  ensureSharedWorldFree(id);
  ensureMockSharedWorldsSettled(id);
  ensureSavesNotWritten(id);
}

/** 与后端 ensure_saves_free_for_writing 一致：备份、恢复或读存档的导出进行中不能往存档里写。 */
export function ensureMockSavesFreeForWriting(id: string): void {
  if (heldActivity(requireInstance(id), ["backing_up"]) !== null) throw busyError(id, "backing_up");
  ensureMockSharedWorldsSettled(id);
  ensureSavesNotRead(id);
}

/** 与后端 ensure_saves_free_for_launch 一致：别的不隔离实例在备份，或存档正被打进整合包时不能启动。 */
export function ensureMockSavesFreeForLaunch(id: string): void {
  ensureMockSharedWorldsSettled(id);
  ensureSavesNotRead(id);
}

/**
 * 备份、恢复、导出共用的长任务外壳：先占住实例（启动、运行中报 instance_busy），共用存档再查别的实例的游戏，
 * 恢复再查有没有导出在读存档，最后登记任务，结束（含失败）放开。打包与解压按文件数推进度，期间被取消即以 cancelled 拒绝。
 */
async function worldTask<T>(taskId: string, id: string, replacesSaves: boolean, work: () => Promise<T>): Promise<T> {
  const release = acquire(id, "backing_up");
  try {
    ensureSharedWorldFree(id);
    if (replacesSaves) ensureSavesNotRead(id);
    ensureSavesNotWritten(id);
    beginMockTask(taskId);
  } catch (error) {
    release();
    throw error;
  }
  try {
    return await work();
  } finally {
    endMockTask(taskId);
    release();
  }
}

/** 下一次改名时存档备份挪不动的原因；null 为照常。 */
let pendingBackupsMoveFailure: string | null = null;

/** 下一次改名时备份目录挪不动（模拟被别的程序占着）：改名照常落盘，备份留在旧名下，命令报 world_backups_not_moved。 */
export function failNextMockBackupsMove(cause = "拒绝访问。 (os error 5)"): void {
  pendingBackupsMoveFailure = cause;
}

/** 存档打成 zip 后的大小：mock 按存档体积的九成算。 */
function packedSize(world: WorldDto): number {
  return Math.round(world.size_bytes * 0.9);
}

/** 打包或解压的假进度：24 个文件，按 MOCK_STEP_MS 推进。 */
function fakePack(taskId: string, bytes: number): Promise<void> {
  return fakeDownload(taskId, 24, Math.max(1, Math.round(bytes / 24)));
}

async function backupWorld(args: MockArgs): Promise<BackupResultDto> {
  const taskId = str(args, "taskId");
  const id = str(args, "id");
  const world = worldArg(args);
  return worldTask(taskId, id, false, async () => {
    const instance = requireInstance(id);
    const found = requireWorld(instance, world);
    stage(taskId, `正在打包「${world}」`);
    await fakePack(taskId, packedSize(found));
    const entry = backupEntry(freshBackupTime(id, world), "manual", packedSize(found), found.name);
    setWorldBackups(id, world, [...worldBackups(id, world), entry]);
    // 与后端一致：自动备份关着时不清理，手动备份不借机删以前的自动备份
    const pruned = mockWorldBackupSettings().auto ? pruneBackups({ scope: backupScope(id), world, file: entry.file }) : 0;
    return { backup: entry, pruned };
  });
}

/**
 * 与后端 auto_backup_after_session 一致：这一局进过的存档各写一份自动备份，写完按保留策略清理，返回备份成了的存档。
 * 存档这时已经不在的不算。启动 mock 在游戏退出后调用，占用由它持有到这里返回。
 */
export function autoBackupMockWorlds(id: string, worlds: readonly string[]): string[] {
  if (worlds.length === 0) return [];
  const instance = requireInstance(id);
  return worlds.filter((world) => {
    const found = instance.content.worlds.find((w) => w.dir_name === world);
    if (found === undefined) return false;
    const entry = backupEntry(freshBackupTime(id, world), "auto", packedSize(found), found.name);
    setWorldBackups(id, world, [...worldBackups(id, world), entry]);
    pruneBackups({ scope: backupScope(id), world, file: entry.file });
    return true;
  });
}

async function restoreWorldBackup(args: MockArgs): Promise<RestoreResultDto> {
  const taskId = str(args, "taskId");
  const id = str(args, "id");
  const world = worldArg(args);
  const file = str(args, "file");
  return worldTask(taskId, id, true, async () => {
    const instance = requireInstance(id);
    const entry = worldBackups(id, world).find((b) => b.file === file);
    if (entry === undefined) throw backupNotFound(id, world, file);
    stage(taskId, "正在校验备份");
    stage(taskId, "正在解压备份");
    await fakePack(taskId, entry.size_bytes);
    const existing = instance.content.worlds.find((w) => w.dir_name === world);
    if (existing !== undefined) stage(taskId, "正在把现在的存档移入回收站");
    const restored: WorldDto = {
      dir_name: world,
      level_status: "ok",
      level_error: null,
      name: entry.level_name,
      mode: existing === undefined ? null : existing.mode,
      last_played: entry.created_at,
      size_bytes: Math.round(entry.size_bytes / 0.9),
      modified_at: Date.now(),
    };
    instance.content.worlds = [...instance.content.worlds.filter((w) => w.dir_name !== world), restored];
    return { world, previous_in_recycle_bin: existing !== undefined };
  });
}

async function exportWorld(args: MockArgs): Promise<ExportResultDto> {
  const taskId = str(args, "taskId");
  const id = str(args, "id");
  const world = worldArg(args);
  const dest = str(args, "dest");
  if (!/^([A-Za-z]:[\\/]|\\\\)/.test(dest)) throw invalid("dest", "not_absolute", `导出位置须是绝对路径：${dest}`);
  if (!dest.toLowerCase().endsWith(".zip")) throw invalid("dest", "not_zip", `导出文件须是 .zip：${dest}`);
  const result = await worldTask(taskId, id, false, async () => {
    const instance = requireInstance(id);
    const found = requireWorld(instance, world);
    stage(taskId, `正在打包「${world}」`);
    await fakePack(taskId, packedSize(found));
    return { path: dest, size_bytes: packedSize(found) };
  });
  recordMockExport(result.path);
  return result;
}

/**
 * 在资源管理器里选中过的路径，按调用先后。浏览器里没有资源管理器，测试据此断言「打开所在文件夹」选中的是哪个文件。
 * 导出的是同一个数组，reset 只清空不换引用，测试模块里早先拿到的引用一直有效。
 */
export const mockRevealedPaths: string[] = [];

/** 这次运行里导出存档、导出整合包写成的文件；与后端一样，「打开所在文件夹」只放行这些与备份区里的路径。 */
const exportedFiles = new Set<string>();

export function recordMockExport(path: string): void {
  exportedFiles.add(path);
}

/** 浏览器里没有真实路径：拆开分隔符、折叠 . 与 ..，再看是否落在备份根之下，与后端按真实路径比的结论一致。 */
function insideMockBackups(path: string): boolean {
  const parts: string[] = [];
  for (const part of path.split(/[\\/]+/)) {
    if (part === "" || part === ".") continue;
    if (part === "..") parts.pop();
    else parts.push(part.toLowerCase());
  }
  return MOCK_BACKUPS_ROOT.toLowerCase()
    .split("/")
    .every((part, index) => parts[index] === part);
}

function revealInFolder(args: MockArgs): void {
  const path = str(args, "path");
  if (!/^([A-Za-z]:[\\/]|\\\\)/.test(path)) throw invalid("path", "relative", `要定位的路径必须是绝对路径：${path}`);
  if (!exportedFiles.has(path) && !insideMockBackups(path)) throw invalid("path", "not_launcher_output", `只能定位自己产出的文件：${path}`);
  mockRevealedPaths.push(path);
}

// ---------------------------------------------------------------- 移到另一个游戏目录（与后端 instance_move 同一套规则）

/** 目标盘除了要写的字节，至少还要留出这么多，与后端一致。 */
const MOVE_MARGIN_BYTES = 256 * MB;
/** 假磁盘各盘的剩余空间；E 盘故意很满，选到它上面的文件夹能看到空间不够。没列出的卷按很空算。 */
const MOCK_FREE_BYTES: Readonly<Record<string, number>> = { "c:": 38 * GIB, "d:": 120 * GIB, "e:": 1536 * MB };
const MOCK_FREE_BYTES_ELSEWHERE = 500 * GIB;
/** 一个版本要的共用文件（库、资源、日志配置）的粗略量；目标里已有游戏文件时大多已在，只缺这个版本独有的那些。 */
const MOCK_DEPENDENCIES_FULL = { files: 3460, bytes: 712 * MB };
const MOCK_DEPENDENCIES_PARTIAL = { files: 186, bytes: 94 * MB };
/** 带过去的基底版本只有版本 JSON 与客户端 jar。 */
const MOCK_BASE_FILES = 2;
const MOCK_BASE_BYTES = 26 * MB;
/** 与后端同一份步骤表：跨卷先复制、读回校验再提交，同卷直接改名过去。 */
const MOVE_CROSS_VOLUME_PLAN: readonly InstallPhase[] = ["move_dependencies", "move_copy", "move_verify", "move_commit"];
const MOVE_SAME_VOLUME_PLAN: readonly InstallPhase[] = ["move_dependencies", "move_commit"];

/** 卷：盘符，或 UNC 路径的 \\主机\共享。 */
function volumeOf(path: string): string {
  const unc = /^[\\/]{2}([^\\/]+)[\\/]([^\\/]+)/.exec(path);
  return (unc === null ? path.slice(0, 2) : `\\\\${unc[1]}\\${unc[2]}`).toLowerCase();
}

function freeBytesOf(path: string): number {
  const listed = MOCK_FREE_BYTES[volumeOf(path)];
  return listed === undefined ? MOCK_FREE_BYTES_ELSEWHERE : listed;
}

/** 这一版认得的数据格式号，与后端第一个带这套机制的版本相同。 */
const MOCK_DATA_FORMAT = 1;

/** 假游戏目录里数据格式记号的问题：比这一版新（supported 取这一版的号），或记号读不懂。其余字段同对应的拦截项。 */
export type MockGameDirDataProblem =
  | ({ kind: "data_too_new" } & Omit<GameDirDataTooNewDto, "path" | "supported">)
  | ({ kind: "data_format_unreadable" } & Omit<DataFormatUnreadableDto, "path">);

/** 登记过记号问题的假游戏目录；没登记的目录，记号与这一版相符或还没有记号。 */
let gameDirDataProblems: { path: string; problem: MockGameDirDataProblem }[] = [];

/**
 * 让一个假游戏目录的数据格式记号出问题（模拟被更新的版本用过，或记号文件坏了）：以它为目标的移动预检列出对应的拦截项，
 * 执行前的重新预检照样拦下。同一目录再登记一次换成新的问题。
 */
export function setMockGameDirDataProblem(path: string, problem: MockGameDirDataProblem): void {
  if (problem.kind === "data_too_new" && problem.found <= MOCK_DATA_FORMAT) throw new Error(`登记的数据格式号 ${problem.found} 不比这一版的 ${MOCK_DATA_FORMAT} 新`);
  gameDirDataProblems = [...gameDirDataProblems.filter((entry) => !samePath(entry.path, path)), { path, problem }];
}

/** 目标游戏目录的记号问题对应的拦截项；没登记过问题时为 null。 */
function dataFormatBlocker(target: string): MoveBlockerDto | null {
  const entry = gameDirDataProblems.find((e) => samePath(e.path, target));
  if (entry === undefined) return null;
  const { problem } = entry;
  return problem.kind === "data_too_new" ? { ...problem, path: target, supported: MOCK_DATA_FORMAT } : { ...problem, path: target };
}

/** 随实例走的存档备份：备份区里按实例 id 分的那一层，与后端 instances/<id> 同一个口径。 */
function movedBackups(id: string): { count: number; bytes: number } {
  const book = backups[id];
  const lists = book === undefined ? [] : Object.values(book);
  return {
    count: lists.reduce((sum, list) => sum + list.length, 0),
    bytes: lists.reduce((sum, list) => sum + list.reduce((total, b) => total + b.size_bytes, 0), 0),
  };
}

function previewMove(id: string, rawTarget: string): MovePreviewDto {
  const instance = requireInstance(id);
  if (instance.dto.status === "broken") {
    const reason = instance.dto.broken_reason ?? "版本 JSON 不可用";
    throw new IpcError("instance_failed", `实例 ${id} 的版本 JSON 不可用：${reason}`, { id, reason });
  }
  const target = validateMockMoveTarget(rawTarget);
  const source = mockGameDir();
  const sameVolume = volumeOf(source) === volumeOf(target);
  const targetVersions = mockDirectoryVersions(target);
  const inTarget = (name: string) => targetVersions.some((v) => v.toLowerCase() === name.toLowerCase());
  const chain = mockInheritanceChain(id);
  const basesToCopy = chain.filter((base) => !inTarget(base));
  const dependencies = targetVersions.length > 0 ? MOCK_DEPENDENCIES_PARTIAL : MOCK_DEPENDENCIES_FULL;
  const moved = movedBackups(id);
  const dependencyTotal = dependencies.bytes + basesToCopy.length * MOCK_BASE_BYTES;
  // 同卷只算补过去的共用文件；跨卷实例与备份也要复制一份
  const required = sameVolume ? dependencyTotal : dependencyTotal + instance.sizeBytes + moved.bytes;
  const available = freeBytesOf(target);
  const blockers: MoveBlockerDto[] = [];
  // 目标就是原处或在实例目录里面时，别的检查都无从谈起
  if (samePath(target, source)) blockers.push({ kind: "same_directory" });
  else if (isMockPathWithin(target, `${source}\\versions\\${id}`)) blockers.push({ kind: "target_inside_source" });
  else {
    const dataFormat = dataFormatBlocker(target);
    if (dataFormat !== null) blockers.push(dataFormat);
    if (inTarget(id)) blockers.push({ kind: "name_taken" });
    const dependents = dependentsOf(id);
    if (dependents.length > 0) blockers.push({ kind: "has_dependents", dependents });
    if (required + MOVE_MARGIN_BYTES > available) blockers.push({ kind: "insufficient_space", needed: required + MOVE_MARGIN_BYTES, available });
  }
  return {
    id,
    source,
    target,
    target_name: mockGameDirectoryName(target),
    target_registered: isKnownMockGameDirectory(target),
    same_volume: sameVolume,
    instance_bytes: instance.sizeBytes,
    instance_files: instance.fileCount,
    backup_bytes: moved.bytes,
    backup_count: moved.count,
    dependency_files: dependencies.files,
    dependency_bytes: dependencies.bytes,
    bases_to_copy: basesToCopy,
    reused_bases: chain.filter(inTarget),
    missing_in_source: instance.dto.incomplete === null ? 0 : 12,
    required_bytes: required,
    available_bytes: available,
    isolated: isolatedOf(instance),
    blockers,
  };
}

/** 下一次移动提交后配置存不上的原因；null 为照常。 */
let pendingMoveConfigFailure: string | null = null;

/**
 * 下一次移动提交后配置存不上（模拟配置文件被占用）：与后端一样照成功返回，跟进项多一项 config；原目录里对它的引用
 * （侧栏固定、当前选中、固定服务器）不动，新目标也不记进游戏目录列表，留给下次打开时按移动日志补。
 */
export function failNextMockMoveConfig(cause = "拒绝访问。 (os error 5)"): void {
  pendingMoveConfigFailure = cause;
}

/** 一步里的假复制：文件数为 0 时这一步没有可报的下载。 */
async function fakeCopy(taskId: string, files: number, bytes: number): Promise<void> {
  if (files === 0) return;
  await fakeDownload(taskId, files, Math.round(bytes / files));
}

async function moveInstance(args: MockArgs): Promise<MoveOutcomeDto> {
  const taskId = str(args, "taskId");
  const id = str(args, "id");
  const source = str(args, "source");
  const rawTarget = str(args, "target");
  requireInstance(id);
  // 与后端一样，移动期间连同继承链上的基底一起占住：要从基底读客户端 jar 带过去
  const moveHold = acquireMockInstanceWithBases(id, "moving", mockInheritanceChain(id));
  try {
    beginMockTask(taskId);
  } catch (error) {
    moveHold.release();
    throw error;
  }
  try {
    // 发起之后切换过游戏目录：当前目录里同名的是另一个实例，别的检查都无从谈起
    if (!samePath(source, mockGameDir())) {
      const blocker: MoveBlockerDto = { kind: "source_changed" };
      throw new IpcError(INSTANCE_MOVE_BLOCKED_ERROR_CODE, `实例 ${id} 不能移到 ${rawTarget}：当前游戏目录已经换了，不是发起移动时的那个`, { id, blocker });
    }
    const preview = previewMove(id, rawTarget);
    const blocker = preview.blockers[0];
    if (blocker !== undefined) {
      throw new IpcError(INSTANCE_MOVE_BLOCKED_ERROR_CODE, `实例 ${id} 不能移到 ${preview.target}：${blocker.kind}`, { id, blocker });
    }
    const plan = preview.same_volume ? MOVE_SAME_VOLUME_PLAN : MOVE_CROSS_VOLUME_PLAN;
    phase(taskId, plan, "move_dependencies");
    await fakeCopy(taskId, preview.dependency_files + preview.bases_to_copy.length * MOCK_BASE_FILES, preview.dependency_bytes + preview.bases_to_copy.length * MOCK_BASE_BYTES);
    if (!preview.same_volume) {
      const files = preview.instance_files + preview.backup_count;
      const bytes = preview.instance_bytes + preview.backup_bytes;
      phase(taskId, plan, "move_copy");
      await fakeCopy(taskId, files, bytes);
      phase(taskId, plan, "move_verify");
      await fakeCopy(taskId, files, bytes);
    }
    phase(taskId, plan, "move_commit");
    // 提交开始后不再理会取消：这一步只等一拍，不查取消
    await sleep(MOCK_STEP_MS);
    instances = instances.filter((i) => i.dto.id !== id);
    forgetMockMods(id);
    forgetMockLaunchRecords(id);
    const followUps: MoveFollowUpDto[] = [];
    // 与改名共用同一处失败注入：游玩记录、存档备份没跟过去时照成功返回，记成待提示的一项
    const lag = takeMockPlayRecordsFailure();
    if (lag !== null) followUps.push({ kind: "play_records", reason: lag });
    const stuck = pendingBackupsMoveFailure;
    pendingBackupsMoveFailure = null;
    if (stuck === null) delete backups[id];
    else followUps.push({ kind: "world_backups", reason: stuck });
    recordMockMovedVersions(preview.target, [id, ...preview.bases_to_copy]);
    // 配置在文件与记录都移好之后才改、才存；存不上同样照成功返回，原目录里的引用与目录列表都还是移动前的样子
    const configFailure = pendingMoveConfigFailure;
    pendingMoveConfigFailure = null;
    const registered = configFailure === null && !preview.target_registered;
    if (configFailure === null) {
      pins = pins.filter((pin) => pin !== id);
      forgetMockPinnedInstance(id);
      followMockSelection(id, null);
      if (registered) addExtraDirectory(preview.target_name, preview.target);
    } else followUps.push({ kind: "config", reason: configFailure });
    return { id, source: preview.source, target: preview.target, target_name: preview.target_name, registered, follow_ups: followUps };
  } finally {
    endMockTask(taskId);
    moveHold.release();
  }
}

export const handlers: MockHandlers = {
  // 与后端一样按小写 id 的码位顺序排，不按语言区域排序。
  list_instances: () =>
    instances.map(toDto).sort((a, b) => {
      const [x, y] = [a.id.toLowerCase(), b.id.toLowerCase()];
      return x < y ? -1 : x > y ? 1 : 0;
    }),

  get_instance_settings: (args) => requireInstance(str(args, "id")).settings,

  // 与后端同序：格式不对先报，再占住实例（改名、删除、新建、补全进行中报 instance_busy），之后才校验取值与实例是否存在。
  set_instance_settings: (args) => {
    const id = str(args, "id");
    const settings = parseSettings(args.settings);
    return withMockInstance(id, "modifying", () => {
      validateSettings(settings);
      const instance = requireInstance(id);
      commitSettings(instance, settings);
      return settings;
    });
  },

  import_cover_image: importCoverImage,

  list_instance_content: (args) => {
    const id = str(args, "id");
    const instance = requireInstance(id);
    if (instance.dto.status === "broken") {
      const reason = instance.dto.broken_reason ?? "版本 JSON 不可用";
      throw new IpcError("instance_failed", `实例 ${id} 的版本 JSON 不可用：${reason}`, { id, reason });
    }
    return instance.content;
  },

  get_sidebar_pins: () => pins.filter((pin) => find(pin) !== undefined),

  set_sidebar_pins: (args) => {
    const next = args.pins;
    if (!Array.isArray(next) || next.some((p) => typeof p !== "string")) throw new Error("mock：pins 应为字符串数组");
    const list = next as string[];
    const pinsError = (reason: string, message: string, id: string | null) =>
      new IpcError("invalid_argument", `侧栏固定列表不合法：${message}`, { field: "pins", reason, id });
    if (list.length > SIDEBAR_PIN_MAX) throw pinsError("too_many", "侧栏最多固定 5 个实例", null);
    const dup = list.find((pin, i) => list.indexOf(pin) !== i);
    if (dup !== undefined) throw pinsError("duplicate", "同一个实例重复固定", dup);
    const missing = list.find((pin) => find(pin) === undefined);
    if (missing !== undefined) throw pinsError("not_found", "要固定的实例不存在", missing);
    pins = [...list];
    return pins;
  },

  install_version: installVersion,

  repair_instance: repairInstance,

  template_info: () => templateInfo(),

  // 与后端同序：先认实例，再占住（改名、删除、安装、补全进行中报 instance_busy；与运行中的游戏兼容），之后才读工作目录
  save_instance_as_template: (args) => {
    const id = str(args, "id");
    requireInstance(id);
    return withMockInstance(id, "modifying", () => {
      // mock 没有真实的工作目录：没进过游戏的实例按「还没写出 options.txt 与服务器列表」处理
      if (mockPlaySummary(id) === null) {
        throw new IpcError(TEMPLATE_SOURCE_EMPTY_ERROR_CODE, `实例 ${id} 的游戏目录里还没有 options.txt 或服务器列表，进一次游戏后再保存`, { id, files: TEMPLATE_FILES });
      }
      template = {
        files: [
          { name: "options.txt", size: 2048 },
          { name: "servers.dat", size: 512 },
        ],
        source_instance: id,
        saved_at: Date.now(),
      };
      return templateInfo();
    });
  },

  clear_template: () => {
    template = null;
    return templateInfo();
  },

  preview_instance_deletion: (args): DeletionPreviewDto => {
    const id = str(args, "id");
    const instance = requireInstance(id);
    return {
      id,
      worlds: instance.content.worlds,
      size_bytes: instance.sizeBytes,
      file_count: instance.fileCount,
      dependents: dependentsOf(id),
      activity: activityOf(id),
      used_by: usedByOf(id),
      backups_dir: `${MOCK_BACKUPS_ROOT}/instances/${id}`,
      backup_count: Object.values(backups[id] === undefined ? {} : backups[id]).reduce((sum, list) => sum + list.length, 0),
    };
  },

  delete_instance: (args) => {
    const id = str(args, "id");
    if (!isSafeId(id)) throw invalid("id", "unsafe_id", `实例 id 不合法：${JSON.stringify(id)}`, { id });
    const release = acquire(id, "deleting");
    try {
      const existed = find(id) !== undefined;
      if (existed) {
        ensureNoDependents(id);
        instances = instances.filter((i) => i.dto.id !== id);
        forgetMockMods(id);
      }
      // 目录已不在时也清：残留的记录会被之后新建的同名实例继承
      forgetMockLaunchRecords(id);
      pins = pins.filter((pin) => pin !== id);
      forgetMockPinnedInstance(id);
      followMockSelection(id, null);
      const lag = takeMockPlayRecordsFailure();
      if (lag !== null) throw new IpcError("play_records_failed", `实例已删除，但游玩记录没能跟着改：${lag}`, { id, causes: [lag] });
      return { existed };
    } finally {
      release();
    }
  },

  rename_instance: (args) => {
    const id = str(args, "id");
    const newName = str(args, "newName");
    const releaseOld = acquire(id, "renaming");
    const sameKey = id.toLowerCase() === newName.toLowerCase();
    let releaseNew: () => void = () => {};
    try {
      if (!sameKey) releaseNew = acquire(newName, "renaming");
      const instance = requireInstance(id);
      checkName(newName, id);
      if (id === newName) return { id };
      ensureNoDependents(id);
      instance.dto = { ...instance.dto, id: newName };
      renameMockMods(id, newName);
      renameMockLaunchRecords(id, newName);
      // 隔离实例的备份按实例 id 分目录，改名时并到新名字下；共用的那一层不动
      const stuck = pendingBackupsMoveFailure;
      pendingBackupsMoveFailure = null;
      if (stuck === null) mergeScope(id, newName);
      pins = pins.map((pin) => (pin === id ? newName : pin));
      renameMockPinnedInstance(id, newName);
      followMockSelection(id, newName);
      const lag = takeMockPlayRecordsFailure();
      if (lag !== null) {
        throw new IpcError("play_records_failed", `实例已改名为「${newName}」，但游玩记录没能跟着改：${lag}`, { id, renamed_to: newName, causes: [lag] });
      }
      if (stuck !== null) {
        throw new IpcError("world_backups_not_moved", `实例已改名为「${newName}」，但存档备份没能跟着挪：${stuck}`, {
          id,
          renamed_to: newName,
          path: `${MOCK_BACKUPS_ROOT}/instances/${id}`,
          causes: [stuck],
        });
      }
      return { id: newName };
    } finally {
      releaseNew();
      releaseOld();
    }
  },

  list_manifest: () => manifestDto(),

  list_loader_versions: (args) => {
    const loader = loaderChoice(str(args, "loader"));
    const mcVersion = str(args, "mcVersion");
    // 表里没有即该加载器不支持这个版本：与后端一样返回空列表。
    return LOADER_VERSIONS[`${loader}:${mcVersion}`] ?? [];
  },

  required_java: (args) => {
    const mcVersion = str(args, "mcVersion");
    const entry = MANIFEST.find((v) => v.id === mcVersion);
    if (!entry) throw new IpcError("install_failed", `installer jar 内缺少条目: 版本清单中的 ${mcVersion}`);
    return entry.java;
  },

  version_requirements: (args): VersionRequirementsDto => {
    const mcVersion = str(args, "mcVersion");
    const entry = MANIFEST.find((v) => v.id === mcVersion);
    if (!entry) throw new IpcError("install_failed", `installer jar 内缺少条目: 版本清单中的 ${mcVersion}`);
    return { java_major: entry.java, download_bytes: entry.downloadBytes };
  },

  backup_world: backupWorld,

  list_world_backups: (args): WorldBackupListDto => {
    const id = str(args, "id");
    const world = worldArg(args);
    const instance = requireInstance(id);
    // 存档文件夹已经不在时照常列出它留下的备份，与后端一致
    const list = [...worldBackups(id, world)].sort((a, b) => b.created_at - a.created_at);
    return { world, ...backupDir(instance, world), backups: list, total_bytes: list.reduce((sum, b) => sum + b.size_bytes, 0) };
  },

  restore_world_backup: restoreWorldBackup,

  // 不占实例：删一份备份只动备份目录，游戏运行中照常可以删
  delete_world_backup: (args) => {
    const id = str(args, "id");
    const world = worldArg(args);
    const file = str(args, "file");
    // 与后端同序：先校验入参，再占住实例（改名、删除、新建、补全进行中报 instance_busy；与运行中的游戏、备份兼容）
    return withMockInstance(id, "modifying", () => {
      requireInstance(id);
      const list = worldBackups(id, world);
      if (!list.some((b) => b.file === file)) throw backupNotFound(id, world, file);
      setWorldBackups(
        id,
        world,
        list.filter((b) => b.file !== file),
      );
    });
  },

  export_world: exportWorld,

  preview_instance_move: (args) => previewMove(str(args, "id"), str(args, "target")),

  move_instance: moveInstance,

  reveal_in_folder: (args) => revealInFolder(args),
  open_folder: (args) => {
    const target = str(args, "target");
    const id = optStr(args, "id");
    const world = optStr(args, "world");
    if (!(FOLDER_TARGETS as readonly string[]).includes(target)) throw invalid("target", "unknown", `不认识的文件夹类型 ${target}`);
    if (target === "game_dir" || target === "data_dir" || target === "launcher_logs") return;
    if (id === null) throw invalid("id", "missing", `打开 ${target} 需要实例 id`);
    if (target === "world") {
      if (world === null) throw invalid("world", "missing", "打开存档需要存档文件夹名");
      if (!isSafeId(world)) throw invalid("world", "unsafe", `存档文件夹名不合法：${JSON.stringify(world)}`);
    }
    const resolve = () => {
      const instance = requireInstance(id);
      // 工作目录要从版本 JSON 推出来，版本 JSON 坏了的实例只能打开实例目录本身。
      if (target !== "instance" && instance.dto.status === "broken") {
        const reason = instance.dto.broken_reason ?? "版本 JSON 不可用";
        throw new IpcError("instance_failed", `实例 ${id} 的版本 JSON 不可用：${reason}`, { id, reason });
      }
      if (target === "world" && !instance.content.worlds.some((w) => w.dir_name === world)) {
        throw invalid("world", "not_found", `存档 ${world} 不存在`);
      }
    };
    // 工作目录下的子目录不存在时后端会先建出来，建目录期间占住实例，免得改名、删除进行中按旧路径建出空目录。
    // 浏览器里没有文件管理器可开，校验通过即视为已打开。
    if (target === "instance" || target === "world") resolve();
    else withMockInstance(id, "modifying", resolve);
  },
};

export function reset(): void {
  instances = seedInstances();
  pins = ["樱花生存", "1.21.1"];
  template = null;
  backups = seedBackups();
  holds.clear();
  pendingBackupsMoveFailure = null;
  pendingMoveConfigFailure = null;
  gameDirDataProblems = [];
  savesReaders.length = 0;
  savesWriters.length = 0;
  mockRevealedPaths.length = 0;
  exportedFiles.clear();
}

interface InstancesSnapshot {
  instances: MockInstance[];
  pins: string[];
  template: MockTemplate | null;
  backups: BackupBook;
}

// 实例此刻在做的事只在进程内有意义：刷新等于启动器重启，不存。默认设置在后端存于数据目录，跟着实例一起存。
// 版本 4：实例多了直达能力，另存存档备份表与默认设置。版本 5：实例多了卡面图片目录里的文件。
export const persist: MockPersist = {
  version: 5,
  snapshot: (): InstancesSnapshot => ({ instances, pins, template, backups }),
  restore: (data) => {
    const saved = data as InstancesSnapshot;
    instances = saved.instances;
    pins = saved.pins;
    template = saved.template;
    backups = saved.backups;
  },
};
