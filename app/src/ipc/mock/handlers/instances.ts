import { IpcError } from "../../errors";
import {
  checkInstanceName,
  LOADER_CHOICES,
  type BackupKind,
  type BackupResultDto,
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
  type RestoreResultDto,
  type WorldBackupDto,
  type WorldBackupListDto,
  type WorldDto,
} from "../../instances";
import { emitMockEvent } from "../events";
import type { MockArgs, MockHandlers, MockPersist } from "../types";
import { followMockSelection, mockWorldBackupSettings } from "./config";
import { forgetMockLaunchRecords, mockCrashReport, mockPlaySummary, renameMockLaunchRecords, takeMockPlayRecordsFailure } from "./launch";
import { forgetMockMods, mockModFileCount, renameMockMods } from "./mods";
import { forgetMockPinnedInstance, renameMockPinnedInstance } from "./system";
import { beginMockTask, endMockTask, isMockTaskCancelled } from "./tasks";

// ipc/ 只能以类型方式引用别的模块，事件名与上限在这里按后端各写一份。
const CORE_EVENT = "aurora://core-event";
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

const NAME_MESSAGES: Record<NameRule, string> = {
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
  | "description"
  | "cover"
  | "memory_mb"
  | "playtime_min"
  | "last_played_at"
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
}

function defaultSettings(): InstanceSettingsDto {
  return {
    description: null,
    cover: null,
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
    },
    {
      dto: readyDto("1.20.1-Forge", "1.20.1", [{ kind: "forge", version: "47.2.0" }], 17, now - 55 * DAY),
      settings: defaultSettings(),
      modpack: null,
      inheritsFrom: null,
      content: emptyContent(),
      sizeBytes: 120 * MB,
      fileCount: 520,
    },
    {
      dto: readyDto("1.21", "1.21", [], 21, now - 50 * DAY),
      settings: defaultSettings(),
      modpack: null,
      inheritsFrom: null,
      content: emptyContent(),
      sizeBytes: 30 * MB,
      fileCount: 4,
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
    },
    {
      dto: readyDto("RLCraft", "1.12.2", [{ kind: "forge", version: "14.23.5.2860" }], 8, now - 90 * DAY),
      settings: { ...defaultSettings(), memory_mb: 8192, isolation: "enabled" },
      modpack: { platform: "curseforge", project_id: "285109", version_id: "4612979", name: "RLCraft", version: "2.9.3" },
      inheritsFrom: null,
      content: emptyContent(),
      sizeBytes: 1300 * MB,
      fileCount: 9200,
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
};

/**
 * 两件事能否同时在一个实例上进行，与后端 InstanceActivity::compatible_with 同一张表：Mod、资源与设置的改动彼此兼容，
 * 也与启动、运行中的游戏、存档备份兼容；被别的实例当作基底时，基底自己照样能启动、改动、备份存档，几个实例也能同时以它为基底；
 * 备份要读整个存档，游戏开着会边写边打包，所以与启动、运行互斥，同一实例也只备份一份，兼容集合与运行相同，游戏退出后才能原地转过去；
 * 新建、补全、改名、删除会挪走或重写整个目录，与任何事都互斥。
 */
function compatible(a: InstanceActivity, b: InstanceActivity): boolean {
  if (a === "modifying" || a === "inherited") return b === "modifying" || b === "launching" || b === "running" || b === "backing_up" || b === "inherited";
  return (a === "launching" || a === "running" || a === "backing_up") && (b === "modifying" || b === "inherited");
}

/** 实例上的一份占用。release 放开它；setActivity 只用于兼容关系相同的两件事之间改记（启动转为运行）。 */
export interface MockInstanceHold {
  release(): void;
  setActivity(activity: InstanceActivity): void;
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
export function acquireMockInstanceWithBases(id: string, activity: InstanceActivity, bases: readonly string[]): MockInstanceHold {
  const own = acquireMockInstance(id, activity);
  const keys = new Set([id.toLowerCase()]);
  const held: MockInstanceHold[] = [];
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

/** 实例此刻有没有人占着做 activity：与后端按活动查占用同一口径，键不分大小写。 */
export function mockInstanceHeldFor(id: string, activity: InstanceActivity): boolean {
  const held = holds.get(id.toLowerCase());
  return held !== undefined && held.some((h) => h.activity === activity);
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

function toDto(instance: MockInstance): InstanceDto {
  const play = mockPlaySummary(instance.dto.id);
  const ready = instance.dto.status === "ready";
  const crash = mockCrashReport(instance.dto.id);
  return {
    ...instance.dto,
    description: instance.settings.description,
    cover: instance.settings.cover,
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
    playtime_min: play === null ? 0 : play.playtime_min,
    last_played_at: play === null ? null : play.last_played_at,
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
  });
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
      speed: Math.round((files * bytesPerFile) / ((MOCK_INSTALL_STEPS * MOCK_STEP_MS) / 1000)),
    });
  }
}

// ---------------------------------------------------------------- 设置校验（与后端逐项一致）

const SETTINGS_KEYS = ["description", "cover", "isolation", "memory_mb", "java", "jvm_args", "resolution", "fullscreen"] as const;

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
  };
  instances.push(instance);
  // 与后端一样，名字下还留着的记录属于已经不在的同名旧实例（浏览器里刷新后游玩记录重新播种就会这样），新实例从零开始；
  // 会话日志与崩溃报告在后端存于实例目录，新目录里本来就没有。
  forgetMockLaunchRecords(name);
  try {
    if (isMockTaskCancelled(taskId)) throw new IpcError("cancelled", "已取消");
    stage(taskId, `查找原版 ${mcVersion}`);
    await sleep(MOCK_STEP_MS);
    const entry = MANIFEST.find((v) => v.id === mcVersion);
    if (!entry) throw new IpcError("install_failed", `installer jar 内缺少条目: 版本清单中的 ${mcVersion}`);
    let loaderVersion: string | null = null;
    if (loader) {
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
    await fakeDownload(taskId, 40, 512 * 1024);
    instance.dto = {
      ...readyDto(name, mcVersion, loader && loaderVersion ? [{ kind: loader, version: loaderVersion }] : [], entry.java, createdAt),
      release_type: entry.type,
      is_release: entry.type === "release",
    };
    instance.sizeBytes = 40 * 512 * 1024;
    instance.fileCount = 40;
    // 与后端一样在补全之后、首次启动之前套模板：判断隔离要用到装好后才知道的版本类型
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

async function repairInstance(args: MockArgs): Promise<RepairResultDto> {
  const taskId = str(args, "taskId");
  const id = str(args, "id");
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
      const reason = "整合包没有导入完，缺的 Mod 与配置补不回来，请删掉这个实例后重新导入";
      throw new IpcError("instance_failed", `实例 ${id} 无法补全：${reason}`, { id, reason });
    }
    const spec = instance.dto.incomplete?.kind === "install" ? instance.dto.incomplete.spec : null;
    if (instance.dto.status === "broken" && spec === null) {
      const reason = `${instance.dto.broken_reason ?? "版本 JSON 不可用"}，也没有记下当初装的是什么`;
      throw new IpcError("instance_failed", `实例 ${id} 无法补全：${reason}`, { id, reason });
    }
    const startedAt = Date.now();
    instance.dto.incomplete = spec
      ? { kind: "install", outcome: "pending", started_at: startedAt, spec, error: null }
      : { kind: "repair", outcome: "pending", started_at: startedAt, spec: null, error: null };
    stage(taskId, `补全实例 ${id} 的文件`);
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

/** 记下实例的存档正被整份读走（导出整合包勾了存档），返回撤销函数；与后端一样先记下、再查备份与恢复。 */
export function markMockSavesRead(id: string): () => void {
  savesReaders.push(id);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    savesReaders.splice(savesReaders.indexOf(id), 1);
  };
}

function savesBeingExported(id: string): IpcError {
  return new IpcError("instance_busy", `实例 ${id} 正在导出带存档的整合包，请稍后再试`, { id, activity: "modifying" });
}

/** 与后端同序：恢复要替换存档，本实例或共用这份存档的另一个不隔离实例正在导出带存档的整合包时报 instance_busy。 */
function ensureSavesNotRead(id: string): void {
  // 没有导出在读存档时不看自己的存档作用域：每次恢复都会经过这里
  if (savesReaders.length === 0) return;
  const key = id.toLowerCase();
  const own = savesReaders.find((reader) => reader.toLowerCase() === key);
  if (own !== undefined) throw savesBeingExported(own);
  if (isolatedOf(requireInstance(id))) return;
  const shared = savesReaders.find((reader) => !isolatedOf(requireInstance(reader)));
  if (shared !== undefined) throw savesBeingExported(shared);
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
  if (!exportedFiles.has(path) && !insideMockBackups(path)) throw invalid("path", "not_launcher_output", `只能定位启动器自己产出的文件：${path}`);
  mockRevealedPaths.push(path);
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
      instance.settings = settings;
      return settings;
    });
  },

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
    const instance = requireInstance(id);
    return withMockInstance(id, "modifying", () => {
      // mock 没有真实的工作目录：没进过游戏的实例按「还没写出 options.txt 与服务器列表」处理
      if (toDto(instance).last_played_at === null) {
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
  savesReaders.length = 0;
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
// 版本 4：实例多了直达能力，另存存档备份表与默认设置。
export const persist: MockPersist = {
  version: 4,
  snapshot: (): InstancesSnapshot => ({ instances, pins, template, backups }),
  restore: (data) => {
    const saved = data as InstancesSnapshot;
    instances = saved.instances;
    pins = saved.pins;
    template = saved.template;
    backups = saved.backups;
  },
};
