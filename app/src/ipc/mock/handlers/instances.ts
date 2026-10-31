import { IpcError } from "../../errors";
import {
  checkInstanceName,
  LOADER_CHOICES,
  type DeletionPreviewDto,
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
  type VersionRequirementsDto,
} from "../../instances";
import { emitMockEvent } from "../events";
import type { MockArgs, MockHandlers, MockPersist } from "../types";
import { forgetMockLaunchRecords, mockCrashReport, mockPlaySummary, renameMockLaunchRecords } from "./launch";
import { forgetMockMods, mockModFileCount, renameMockMods } from "./mods";
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
// 实例上的全部占用，键不分大小写，与后端 InstanceLocks 一致：同一实例可以同时有几件兼容的事。
const holds = new Map<string, { token: number; activity: InstanceActivity }[]>();
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

/** 有几件事并行时报最值得界面知道的那一件：Mod 与设置的改动排在最后，与后端的 report_rank 一致。 */
function activityOf(id: string): InstanceActivity | null {
  const held = holds.get(id.toLowerCase());
  if (held === undefined) return null;
  const primary = held.find((h) => h.activity !== "modifying");
  return primary === undefined ? held[0].activity : primary.activity;
}

const ACTIVITY_LABELS: Record<InstanceActivity, string> = {
  installing: "安装",
  repairing: "补全文件",
  renaming: "改名",
  deleting: "删除",
  launching: "启动",
  running: "运行",
  modifying: "改动 Mod、资源或设置",
};

/**
 * 两件事能否同时在一个实例上进行，与后端 InstanceActivity::compatible_with 同一张表：Mod、资源与设置的改动彼此兼容，
 * 也与启动、运行中的游戏兼容；新建、补全、改名、删除会挪走或重写整个目录，与任何事都互斥。
 */
function compatible(a: InstanceActivity, b: InstanceActivity): boolean {
  if (a === "modifying") return b === "modifying" || b === "launching" || b === "running";
  return (a === "launching" || a === "running") && b === "modifying";
}

/** 实例上的一份占用。release 放开它；setActivity 只用于兼容关系相同的两件事之间改记（启动转为运行）。 */
export interface MockInstanceHold {
  release(): void;
  setActivity(activity: InstanceActivity): void;
}

/** 占住实例做 activity；有与它不兼容的事在做时报 instance_busy，形状与后端一致。 */
export function acquireMockInstance(id: string, activity: InstanceActivity): MockInstanceHold {
  const key = id.toLowerCase();
  const held = holds.get(key);
  const conflict = held === undefined ? undefined : held.find((h) => !compatible(activity, h.activity));
  if (conflict !== undefined) {
    throw new IpcError("instance_busy", `实例 ${id} 正在${ACTIVITY_LABELS[conflict.activity]}，请稍后再试`, { id, activity: conflict.activity });
  }
  const hold = { token: nextHoldToken, activity };
  nextHoldToken += 1;
  holds.set(key, held === undefined ? [hold] : [...held, hold]);
  const ownEntry = () => {
    const list = holds.get(key);
    const found = list === undefined ? undefined : list.find((h) => h.token === hold.token);
    if (list === undefined || found === undefined) throw new Error(`mock：实例 ${id} 的这份占用（${activity}）已经放开`);
    return { list, found };
  };
  return {
    release: () => {
      const { list } = ownEntry();
      const rest = list.filter((h) => h.token !== hold.token);
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
  instances.push({
    dto: readyDto(id, mcVersion, loader === null ? [] : [loader], 21, Date.now()),
    // 整合包导入的实例强制隔离，与后端写入的实例设置一致。
    settings: { ...defaultSettings(), isolation: "enabled" },
    modpack,
    inheritsFrom: null,
    content: emptyContent(),
    sizeBytes: 0,
    fileCount: 0,
  });
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

async function installVersion(args: MockArgs): Promise<InstallResultDto> {
  const taskId = str(args, "taskId");
  const mcVersion = str(args, "id");
  const loader = parseLoader(optStr(args, "loader"));
  const loaderVersionArg = optStr(args, "loaderVersion");
  const name = str(args, "targetName");
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
    stage(taskId, `实例 ${name} 安装完成：库 40 / 资源 0 / natives 0`);
    return {
      id: name,
      mc_version: mcVersion,
      loader: loader && loaderVersion ? { kind: loader, version: loaderVersion } : null,
      libraries: 40,
      assets: 0,
      natives: 0,
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
  const release = acquire(id, "repairing");
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
      pins = pins.map((pin) => (pin === id ? newName : pin));
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
  holds.clear();
}

interface InstancesSnapshot {
  instances: MockInstance[];
  pins: string[];
}

// 实例此刻在做的事只在进程内有意义：刷新等于启动器重启，不存。
export const persist: MockPersist = {
  version: 1,
  snapshot: (): InstancesSnapshot => ({ instances, pins }),
  restore: (data) => {
    const saved = data as InstancesSnapshot;
    instances = saved.instances;
    pins = saved.pins;
  },
};
