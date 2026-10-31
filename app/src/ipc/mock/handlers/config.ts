import type {
  AfterLaunch,
  ConfigDto,
  DownloadSourcePolicy,
  GameDirectoryDto,
  GameDirectoryProblem,
  IsolationPolicy,
  MemorySettings,
  NamedDirectoryDto,
} from "../../config";
import { IpcError } from "../../errors";
import type { MockArgs, MockHandlers, MockPersist } from "../types";

export const MOCK_DATA_DIR = "D:\\Games\\Launcher";
const DEFAULT_GAME_DIR = `${MOCK_DATA_DIR}\\.minecraft`;
// 真后端给默认目录显示产品名；ipc/ 引用不到品牌常量，mock 用中性名字。
const DEFAULT_DIR_NAME = "默认目录";

// mock 的「磁盘」：这些目录视为存在。真后端限时探测磁盘，这里用集合代替。
const SEED_DISK = [DEFAULT_GAME_DIR, "C:\\Users\\player\\AppData\\Roaming\\.minecraft", "D:\\HMCL\\.minecraft"];
// 带 versions 文件夹（已有游戏文件）的目录。
const SEED_WITH_VERSIONS = ["C:\\Users\\player\\AppData\\Roaming\\.minecraft", "D:\\HMCL\\.minecraft"];
// 「发现其它启动器目录」会探到的候选；只报告盘上存在且尚未记录的。
const DISCOVERABLE: NamedDirectoryDto[] = [
  { name: "官方启动器", path: "C:\\Users\\player\\AppData\\Roaming\\.minecraft" },
  { name: "HMCL", path: "D:\\HMCL\\.minecraft" },
  { name: "PCL2", path: "E:\\Plain Craft Launcher 2\\.minecraft" },
];

const DOWNLOAD_SOURCES: readonly DownloadSourcePolicy[] = ["auto", "official_first", "mirror_first"];
const ISOLATION_POLICIES: readonly IsolationPolicy[] = [
  "disabled",
  "mod_loaders_only",
  "non_release_only",
  "mod_loaders_and_non_release",
  "all",
];
const AFTER_LAUNCH: readonly AfterLaunch[] = ["keep", "minimize", "close"];
const DEFAULT_JAVA_AUTO = "auto";

function seedConfig(): ConfigDto {
  return {
    game_dir: DEFAULT_GAME_DIR,
    default_game_dir: DEFAULT_GAME_DIR,
    data_dir: MOCK_DATA_DIR,
    download_source: "auto",
    version_list_source: "auto",
    download_concurrency: 64,
    memory: { max_mb: 4096, min_mb: null, auto: true },
    isolation_policy: "mod_loaders_and_non_release",
    has_client_id: true,
    auto_download_java: true,
    default_java: DEFAULT_JAVA_AUTO,
    after_launch: "minimize",
    check_updates: true,
    cache_directory: null,
    selected_version: null,
    skipped_update_version: null,
    notified_update_version: null,
  };
}

let config: ConfigDto = seedConfig();
let extras: NamedDirectoryDto[] = [];
let disk = new Set(SEED_DISK.map(norm));
let withVersions = new Set(SEED_WITH_VERSIONS.map(norm));
let firstRunCompleted = false;

/** 与后端 same_path 一致：大小写不敏感，抹平 / 与 \ 的混用和末尾分隔符。 */
function norm(path: string): string {
  return path.replace(/\//g, "\\").replace(/\\+$/, "").toLowerCase();
}

export function samePath(a: string, b: string): boolean {
  return norm(a) === norm(b);
}

/** 与后端 validate_game_dir 一致：去空白后不能为空、不能含 !、必须是绝对路径。返回规整后的路径。 */
export function validateGameDir(raw: string): string {
  const path = raw.trim();
  let problem: GameDirectoryProblem | null = null;
  if (path === "") problem = "empty";
  else if (path.includes("!")) problem = "contains_bang";
  else if (!/^([A-Za-z]:[\\/]|\\\\)/.test(path)) problem = "not_absolute";
  if (problem) throw invalidGameDir(path, problem);
  return path;
}

const PROBLEM_TEXT: Record<GameDirectoryProblem, string> = {
  empty: "路径为空",
  not_absolute: "不是绝对路径",
  contains_bang: "路径里有「!」，Java 会读不出里面的游戏文件",
  unavailable: "这个位置现在访问不到",
};

function invalidGameDir(path: string, problem: GameDirectoryProblem): IpcError {
  return new IpcError("invalid_game_directory", `游戏目录 ${path} 不能用：${PROBLEM_TEXT[problem]}`, { path, problem });
}

function directoryName(path: string): string {
  const named = extras.find((d) => samePath(d.path, path));
  if (named) return named.name;
  if (samePath(path, DEFAULT_GAME_DIR)) return DEFAULT_DIR_NAME;
  const parts = path.split(/[\\/]/).filter(Boolean);
  const label = parts[parts.length - 1] === ".minecraft" ? parts[parts.length - 2] : parts[parts.length - 1];
  // 盘根这类没有任何一级名字的路径，显示路径本身。
  return label === undefined ? path : label;
}

export function addExtraDirectory(name: string, path: string): void {
  if (samePath(path, config.game_dir)) return;
  const existing = extras.find((d) => samePath(d.path, path));
  if (existing) existing.name = name;
  else extras.push({ name, path });
}

/** 与后端 switch_game_directory 一致：原目录在盘上存在才收进额外目录。 */
export function switchGameDirectory(next: string): void {
  const previous = config.game_dir;
  if (samePath(previous, next)) return;
  extras = extras.filter((d) => !samePath(d.path, next));
  if (disk.has(norm(previous)) && !extras.some((d) => samePath(d.path, previous))) {
    extras.push({ name: directoryName(previous), path: previous });
  }
  config.game_dir = next;
}

/** 首次启动提交用：建目录（加入假磁盘）。 */
export function createDirectory(path: string): void {
  disk.add(norm(path));
}

export function isFirstRunCompleted(): boolean {
  return firstRunCompleted;
}

export function markFirstRunCompleted(): void {
  firstRunCompleted = true;
}

/** 解析带名目录：路径按游戏目录规则，名字去空白后不能为空。 */
export function parseNamedDirectory(raw: unknown, command: string): NamedDirectoryDto {
  const dto = requireStruct(raw, ["name", "path"], command, "extraDirectories");
  if (typeof dto.name !== "string" || typeof dto.path !== "string") throw tauriArgError(command, "extraDirectories", "name 与 path 须为字符串");
  const path = validateGameDir(dto.path);
  const name = dto.name.trim();
  if (name === "") throw new IpcError("invalid_argument", `目录 ${path} 的名字不能为空`);
  return { name, path };
}

/** Tauri 自己的参数反序列化错误：到前端是纯字符串，归一后 code 为 unknown。 */
export function tauriArgError(command: string, arg: string, reason: string): IpcError {
  return new IpcError("unknown", `invalid args \`${arg}\` for command \`${command}\`: ${reason}`);
}

/** 按 deny_unknown_fields 的结构体检查：必须是对象，不许有多余字段，缺字段同样是参数错误。 */
export function requireStruct(raw: unknown, fields: readonly string[], command: string, arg: string): Record<string, unknown> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw tauriArgError(command, arg, "expected a struct");
  const record = raw as Record<string, unknown>;
  const extra = Object.keys(record).find((key) => !fields.includes(key));
  if (extra) throw tauriArgError(command, arg, `unknown field \`${extra}\``);
  return record;
}

export function requireString(args: MockArgs, key: string, command: string): string {
  const value = args[key];
  if (typeof value !== "string") throw tauriArgError(command, key, `missing required key ${key}`);
  return value;
}

function parseMemory(raw: unknown): MemorySettings {
  const record = requireStruct(raw, ["max_mb", "min_mb", "auto"], "update_config", "memory");
  if (typeof record.max_mb !== "number") throw tauriArgError("update_config", "memory", "missing field `max_mb`");
  if (typeof record.auto !== "boolean") throw tauriArgError("update_config", "memory", "missing field `auto`");
  // serde 对缺省的 Option 字段按 None 处理，与显式 null 等价。
  const min = record.min_mb === undefined ? null : record.min_mb;
  if (min !== null && typeof min !== "number") throw tauriArgError("update_config", "memory", "invalid type for `min_mb`");
  if (record.max_mb < 1024) throw new IpcError("invalid_argument", `最大内存不能低于 1024 MB，收到 ${record.max_mb}`);
  if (min !== null && (min < 1 || min > record.max_mb)) {
    throw new IpcError("invalid_argument", `最小内存须在 1 到最大内存 ${record.max_mb} MB 之间，收到 ${min}`);
  }
  return { max_mb: record.max_mb, min_mb: min, auto: record.auto };
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], what: string): T {
  if (!allowed.includes(value as T)) throw new IpcError("invalid_argument", `未知${what} ${String(value)}`);
  return value as T;
}

/** 盘上存在的 java 可执行文件，由 Java mock 维护；默认 Java 只能指向它们之一（真后端要求文件存在）。 */
let knownJava = new Set<string>();

export function setMockJavaPaths(paths: readonly string[]): void {
  knownJava = new Set(paths.map(norm));
}

// 先把所有字段校验完再一次性写入，与后端「有一个不合法就整体拒绝」一致。
function updateConfig(args: MockArgs): void {
  const next: ConfigDto = { ...config, memory: { ...config.memory } };
  if (args.downloadSource !== undefined) next.download_source = oneOf(args.downloadSource, DOWNLOAD_SOURCES, "下载源策略");
  if (args.versionListSource !== undefined) next.version_list_source = oneOf(args.versionListSource, DOWNLOAD_SOURCES, "下载源策略");
  if (args.downloadConcurrency !== undefined) {
    const value = args.downloadConcurrency;
    if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
      throw tauriArgError("update_config", "downloadConcurrency", "expected usize");
    }
    if (value < 1 || value > 256) throw new IpcError("invalid_argument", `同时下载的文件数须在 1 到 256 之间，收到 ${value}`);
    next.download_concurrency = value;
  }
  if (args.memory !== undefined) next.memory = parseMemory(args.memory);
  if (args.isolationPolicy !== undefined) next.isolation_policy = oneOf(args.isolationPolicy, ISOLATION_POLICIES, "隔离档位");
  if (args.autoDownloadJava !== undefined) next.auto_download_java = requireBoolean(args, "autoDownloadJava");
  if (args.cacheDirectory !== undefined) next.cache_directory = requireString(args, "cacheDirectory", "update_config");
  if (args.clientId !== undefined) {
    if (requireString(args, "clientId", "update_config").trim() === "") throw new IpcError("invalid_argument", "client_id 不能为空");
    next.has_client_id = true;
  }
  if (args.selectedVersion !== undefined) next.selected_version = requireString(args, "selectedVersion", "update_config");
  if (args.afterLaunch !== undefined) next.after_launch = oneOf(args.afterLaunch, AFTER_LAUNCH, "的启动后行为");
  if (args.checkUpdates !== undefined) next.check_updates = requireBoolean(args, "checkUpdates");
  if (args.defaultJava !== undefined) next.default_java = parseDefaultJava(requireString(args, "defaultJava", "update_config"));
  if (args.skippedUpdateVersion !== undefined) {
    next.skipped_update_version = requireString(args, "skippedUpdateVersion", "update_config");
  }
  if (args.notifiedUpdateVersion !== undefined) {
    next.notified_update_version = requireString(args, "notifiedUpdateVersion", "update_config");
  }
  config = next;
}

function requireBoolean(args: MockArgs, key: string): boolean {
  const value = args[key];
  if (typeof value !== "boolean") throw tauriArgError("update_config", key, "expected a boolean");
  return value;
}

function parseDefaultJava(value: string): string {
  if (value === DEFAULT_JAVA_AUTO) return value;
  if (!/^([A-Za-z]:[\\/]|\\\\)/.test(value)) {
    throw new IpcError("invalid_argument", `默认 Java 须是 "${DEFAULT_JAVA_AUTO}" 或 java 可执行文件的绝对路径，收到 ${value}`);
  }
  if (!knownJava.has(norm(value))) throw new IpcError("invalid_argument", `默认 Java 指向的文件不存在：${value}`);
  return value;
}

function listGameDirectories(): GameDirectoryDto[] {
  const current = config.game_dir;
  const listed: GameDirectoryDto[] = [
    { name: directoryName(current), path: current, is_current: true, available: disk.has(norm(current)) },
  ];
  for (const extra of extras) {
    if (samePath(extra.path, current)) continue;
    listed.push({ name: extra.name, path: extra.path, is_current: false, available: disk.has(norm(extra.path)) });
  }
  return listed;
}

function discoverGameDirectories(): NamedDirectoryDto[] {
  const known = [config.game_dir, ...extras.map((d) => d.path)];
  return DISCOVERABLE.filter((c) => disk.has(norm(c.path)) && !known.some((k) => samePath(k, c.path)));
}

export const handlers: MockHandlers = {
  get_config: () => config,
  update_config: (args) => updateConfig(args),
  list_game_directories: () => listGameDirectories(),
  discover_game_directories: () => discoverGameDirectories(),
  add_game_directory: (args) => {
    const dir = parseNamedDirectory(
      { name: requireString(args, "name", "add_game_directory"), path: requireString(args, "path", "add_game_directory") },
      "add_game_directory",
    );
    addExtraDirectory(dir.name, dir.path);
  },
  remove_game_directory: (args) => {
    const path = requireString(args, "path", "remove_game_directory").trim();
    const before = extras.length;
    extras = extras.filter((d) => !samePath(d.path, path));
    return extras.length !== before;
  },
  set_game_directory: (args) => {
    const target = validateGameDir(requireString(args, "path", "set_game_directory"));
    if (!disk.has(norm(target))) throw invalidGameDir(target, "unavailable");
    switchGameDirectory(target);
  },
  inspect_game_directory: (args) => {
    const path = validateGameDir(requireString(args, "path", "inspect_game_directory"));
    return { exists: disk.has(norm(path)), has_versions: withVersions.has(norm(path)) };
  },
};

export function reset(): void {
  config = seedConfig();
  extras = [];
  disk = new Set(SEED_DISK.map(norm));
  withVersions = new Set(SEED_WITH_VERSIONS.map(norm));
  firstRunCompleted = false;
}

interface ConfigSnapshot {
  config: ConfigDto;
  extras: NamedDirectoryDto[];
  disk: string[];
  withVersions: string[];
  firstRunCompleted: boolean;
}

export const persist: MockPersist = {
  version: 1,
  snapshot: (): ConfigSnapshot => ({ config, extras, disk: [...disk], withVersions: [...withVersions], firstRunCompleted }),
  restore: (data) => {
    const saved = data as ConfigSnapshot;
    config = saved.config;
    extras = saved.extras;
    disk = new Set(saved.disk);
    withVersions = new Set(saved.withVersions);
    firstRunCompleted = saved.firstRunCompleted;
  },
};
