import { IpcError } from "../../errors";
import {
  SERVER_NOT_PINNED_CODE,
  type ChannelHeadDto,
  type ChannelRelation,
  type KnownServerDto,
  type MemoryAdviceDto,
  type MemoryNeedFactor,
  type NewsFeedDto,
  type NewsItemDto,
  type PinnedServerDto,
  type RefusedUpdateDto,
  type ServerStatusDto,
  type StartupNoticeDto,
  type UpdateChannel,
  type UpdateDto,
  type UpdaterInfoDto,
  type UpdaterUnsupportedReason,
} from "../../system";
import { CORE_EVENT, type CoreEvent } from "../../tasks";
import { emitMockEvent } from "../events";
import type { MockArgs, MockHandlers, MockPersist } from "../types";
import {
  addExtraDirectory,
  applyFirstRunDirectory,
  createDirectory,
  firstRunBaselineOnce,
  isFirstRunCompleted,
  markFirstRunCompleted,
  parseNamedDirectory,
  requireString,
  requireStruct,
  tauriArgError,
  validateGameDir,
} from "./config";
import { requireMockInstanceId } from "./instances";
import { beginMockTask, endMockTask, isMockTaskCancelled } from "./tasks";

// ---- 模拟下载 ----

const DOWNLOAD_STEPS = 5;
const DOWNLOAD_STEP_MS = 120;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function emitCore(event: CoreEvent): void {
  emitMockEvent(CORE_EVENT, event);
}

/**
 * 模拟一批带进度的下载：每步推一次 core-event 的 download 快照（finished 到最后一步才满），期间检查取消；
 * 被取消时以 IpcError("cancelled") 拒绝。调用方负责 beginMockTask / endMockTask。
 */
export async function simulateMockDownload(taskId: string, files: number, totalBytes: number): Promise<void> {
  const speed = Math.round(totalBytes / ((DOWNLOAD_STEPS * DOWNLOAD_STEP_MS) / 1000));
  for (let step = 1; step <= DOWNLOAD_STEPS; step++) {
    await sleep(DOWNLOAD_STEP_MS);
    if (isMockTaskCancelled(taskId)) throw new IpcError("cancelled", "已取消");
    emitCore({
      task_id: taskId,
      kind: "download",
      total: files,
      finished: step === DOWNLOAD_STEPS ? files : Math.floor((files * step) / DOWNLOAD_STEPS),
      bytes: Math.round((totalBytes * step) / DOWNLOAD_STEPS),
      total_bytes: totalBytes,
      transferred: Math.round((totalBytes * step) / DOWNLOAD_STEPS),
      speed,
    });
  }
}

// ---- 内存 ----

const TOTAL_MB = 16384;
const AVAILABLE_MB = 9216;
type BaseLoader = Extract<MemoryNeedFactor, { kind: "base" }>["loader"];
const BASE_MB: Record<BaseLoader, number> = { vanilla: 2560, optifine: 3072, modded: 2765 };
/** 假后端不扫 mods/，装了加载器的实例一律按这么多个启用的 Mod 算；折算与后端同一斜率（每 50 个 1024 MB）。 */
const MOCK_MOD_COUNT = 80;
const MOCK_MODS_MB = Math.floor((MOCK_MOD_COUNT * 1024) / 50);
const NEED_ALIGN_MB = 512;

function memoryAdvice(args: MockArgs): MemoryAdviceDto {
  const id = args.versionId;
  if (id !== undefined && typeof id !== "string") throw tauriArgError("memory_advice", "versionId", "expected a string");
  // 实例是否存在归实例领域的 mock 管，这里只按 id 里的加载器名估算。
  const loader: BaseLoader = typeof id !== "string" ? "vanilla" : /fabric|quilt|neoforge|forge/i.test(id) ? "modded" : /optifine/i.test(id) ? "optifine" : "vanilla";
  const base = { kind: "base", loader, mb: BASE_MB[loader] } as const;
  const mods = { kind: "mods", count: MOCK_MOD_COUNT, mb: MOCK_MODS_MB } as const;
  const factors = loader === "modded" ? [base, mods] : [base];
  const need = Math.ceil(factors.reduce((sum, f) => sum + f.mb, 0) / NEED_ALIGN_MB) * NEED_ALIGN_MB;
  const limit = TOTAL_MB / 2;
  return {
    total_mb: TOTAL_MB,
    available_mb: AVAILABLE_MB,
    version_id: typeof id === "string" ? id : null,
    need_mb: need,
    limit: { mb: limit, reason: "half_physical" },
    recommended_mb: Math.min(need, limit),
    factors,
  };
}

// ---- 启动提示 ----

let startupNotices: StartupNoticeDto[] = [];

/** 模拟一次带提示的启动（测试与界面调试用）；reset 后恢复为没有提示。 */
export function setMockStartupNotices(notices: StartupNoticeDto[]): void {
  startupNotices = notices.map((n) => (n.kind === "config_fields_reset" ? { ...n, fields: n.fields.map((f) => ({ ...f })) } : { ...n }));
}

// ---- 连通性 ----

let networkReachable = true;

/** 模拟连不上下载源（测试与界面调试用）；reset 后恢复为连得上。 */
export function setMockNetworkReachable(reachable: boolean): void {
  networkReachable = reachable;
}

// ---- 首次启动 ----

function completeFirstRun(args: MockArgs): void {
  const gameDir = validateGameDir(requireString(args, "gameDir", "complete_first_run"));
  const raw = args.extraDirectories;
  if (!Array.isArray(raw)) throw tauriArgError("complete_first_run", "extraDirectories", "expected a sequence");
  const extras = raw.map((item) => parseNamedDirectory(item, "complete_first_run"));
  const baseline = firstRunBaselineOnce();
  createDirectory(gameDir);
  applyFirstRunDirectory(baseline, gameDir);
  for (const extra of extras) addExtraDirectory(extra.name, extra.path);
  markFirstRunCompleted();
}

// ---- 服务器 ----

const DEFAULT_PORT = 25565;

/** 与后端 parse_server_address 一致，返回去重用的键 host小写:port；不合法报 invalid_argument（detail.address）。 */
export function serverKey(raw: string): string {
  const address = raw.trim();
  const invalid = (reason: string) => new IpcError("invalid_argument", `服务器地址「${raw}」不合法：${reason}`, { address: raw, reason });
  if (address === "") throw invalid("地址为空");
  let host: string;
  let port: string | null = null;
  if (address.startsWith("[")) {
    const close = address.indexOf("]");
    if (close < 0) throw invalid("缺少「]」");
    host = address.slice(1, close);
    const tail = address.slice(close + 1);
    if (tail !== "") {
      if (!tail.startsWith(":")) throw invalid("「]」之后只能跟端口");
      port = tail.slice(1);
    }
  } else {
    const colons = address.split(":").length - 1;
    if (colons === 1) [host, port] = address.split(":") as [string, string];
    else host = address;
  }
  if (host === "" || /\s/.test(host)) throw invalid("主机名为空或含空白");
  let portNumber = DEFAULT_PORT;
  if (port !== null) {
    portNumber = /^\d+$/.test(port) ? Number(port) : Number.NaN;
    if (!(portNumber >= 1 && portNumber <= 65535)) throw invalid("端口须是 1 到 65535 的整数");
  }
  return `${host.toLowerCase()}:${portNumber}`;
}

// 晨星记住了用实例 mock 种子里的「樱花生存」加入，小镇没记住：浏览器里两条路径都点得到。
const SEED_PINNED: PinnedServerDto[] = [
  { name: "晨星生存服", address: "play.morningstar.example", instance: "樱花生存" },
  { name: "小镇建筑服", address: "build.town.example:25570", instance: null },
];

// 游戏多人列表（servers.dat）里的服务器。
const KNOWN: { name: string; address: string }[] = [
  { name: "晨星生存服", address: "play.morningstar.example" },
  { name: "小镇建筑服", address: "build.town.example:25570" },
  { name: "本地测试", address: "localhost" },
];

type StatusTemplate = Omit<ServerStatusDto, "address" | "checked_at">;

// 按服务器键给出的状态；不在表里的一律连不上。
const STATUS: Record<string, StatusTemplate> = {
  "play.morningstar.example:25565": {
    reachable: true,
    latency_ms: 38,
    online: 127,
    max: 500,
    version_name: "Paper 1.21.4",
    motd: "晨星生存服 | 第六周目开荒中",
    favicon: null,
    last_seen_at: null,
    last_online: 127,
    error: null,
  },
  "build.town.example:25570": {
    reachable: false,
    latency_ms: null,
    online: null,
    max: null,
    version_name: null,
    motd: null,
    favicon: null,
    last_seen_at: Date.UTC(2026, 9, 28, 12, 0, 0),
    last_online: 9,
    error: "连接超时（3000 ms）",
  },
};

const UNREACHABLE: StatusTemplate = {
  reachable: false,
  latency_ms: null,
  online: null,
  max: null,
  version_name: null,
  motd: null,
  favicon: null,
  last_seen_at: null,
  last_online: null,
  error: "连接被拒绝",
};

let pinned: PinnedServerDto[] = SEED_PINNED.map((s) => ({ ...s }));

function setPinnedServers(args: MockArgs): PinnedServerDto[] {
  const raw = args.servers;
  if (!Array.isArray(raw)) throw tauriArgError("set_pinned_servers", "servers", "expected a sequence");
  const parsed = raw.map((item): PinnedServerDto => {
    const record = requireStruct(item, ["name", "address", "instance"], "set_pinned_servers", "servers");
    if (typeof record.name !== "string" || typeof record.address !== "string") {
      throw tauriArgError("set_pinned_servers", "servers", "name 与 address 须为字符串");
    }
    // 与后端的 #[serde(default)] Option<String> 一致：缺键与 null 都是没记住
    const instance = record.instance === undefined ? null : record.instance;
    if (instance !== null && typeof instance !== "string") throw tauriArgError("set_pinned_servers", "servers", "instance 须为字符串或 null");
    if (instance !== null) requireSafeInstanceId(instance);
    return { name: record.name, address: record.address, instance };
  });
  const seen = new Set<string>();
  const cleaned: PinnedServerDto[] = [];
  for (const server of parsed) {
    const key = serverKey(server.address);
    // 同地址去重时保留第一次出现那条，连同它记住的实例
    if (seen.has(key)) continue;
    seen.add(key);
    const address = server.address.trim();
    const name = server.name.trim();
    cleaned.push({ name: name === "" ? address : name, address, instance: server.instance });
  }
  pinned = cleaned;
  return pinned;
}

/** 与后端 is_safe_instance_id 同一口径：只校验能否安全拼进路径，不校验实例是否存在。 */
function requireSafeInstanceId(id: string): void {
  if (id === "" || id.startsWith(".") || /[\\/:\0]/.test(id)) {
    throw new IpcError("invalid_argument", `实例 id 不合法：${JSON.stringify(id)}`, { field: "id", reason: "unsafe_id", id });
  }
}

/** 与后端同序：先查实例（不存在报 version_not_installed），再按去重键找固定项（找不到报 server_not_pinned）。 */
function setPinnedServerInstance(args: MockArgs): PinnedServerDto[] {
  const address = requireString(args, "address", "set_pinned_server_instance");
  const raw = args.instance;
  const instance = raw === undefined || raw === null ? null : raw;
  if (instance !== null && typeof instance !== "string") throw tauriArgError("set_pinned_server_instance", "instance", "expected a string or null");
  if (instance !== null) requireMockInstanceId(instance);
  const key = serverKey(address);
  const index = pinned.findIndex((p) => serverKey(p.address) === key);
  if (index < 0) throw new IpcError(SERVER_NOT_PINNED_CODE, `服务器「${address}」没有固定`, { address });
  pinned = pinned.map((p, i) => (i === index ? { ...p, instance } : p));
  return pinned;
}

/** 实例改名后，记住它的固定服务器跟到新名字；按字符串精确相等，与侧栏固定同一口径。返回是否有改动。 */
export function renameMockPinnedInstance(from: string, to: string): boolean {
  const changed = pinned.some((p) => p.instance === from);
  if (changed) pinned = pinned.map((p) => (p.instance === from ? { ...p, instance: to } : p));
  return changed;
}

/** 实例删除后，记住它的固定服务器改回没记住。返回是否有改动。 */
export function forgetMockPinnedInstance(id: string): boolean {
  const changed = pinned.some((p) => p.instance === id);
  if (changed) pinned = pinned.map((p) => (p.instance === id ? { ...p, instance: null } : p));
  return changed;
}

function listKnownServers(): KnownServerDto[] {
  const pinnedKeys = new Set(pinned.map((p) => serverKey(p.address)));
  return KNOWN.map((s) => ({ ...s, pinned: pinnedKeys.has(serverKey(s.address)) }));
}

function pingServers(args: MockArgs): ServerStatusDto[] {
  const raw = args.addresses;
  if (raw !== undefined && !(Array.isArray(raw) && raw.every((a) => typeof a === "string"))) {
    throw tauriArgError("ping_servers", "addresses", "expected a sequence of strings");
  }
  const addresses = raw === undefined ? pinned.map((p) => p.address) : (raw as string[]);
  // 与后端一致：先全部校验，有一个不合法整体报错、一台也不查。
  const keys = addresses.map(serverKey);
  const now = Date.now();
  return addresses.map((address, i) => {
    const template = STATUS[keys[i]];
    const status = template === undefined ? UNREACHABLE : template;
    return { ...status, address, checked_at: now, last_seen_at: status.reachable ? now : status.last_seen_at };
  });
}

// ---- 资讯 ----

const NEWS: NewsItemDto[] = [
  {
    id: "java-26-4-snapshot-6",
    title: "Minecraft 26.4 Snapshot 6",
    summary: "新的快照带来了实验性的生物群系调整与若干漏洞修复。",
    date: Date.UTC(2026, 9, 27, 13, 40, 29),
    tag: "snapshot",
    thumbnail_url: "https://launchercontent.mojang.com/v2/images/26.4snapshot6540x540.jpg",
    game_version: "26.4-snapshot-6",
  },
  {
    id: "launcher-300",
    title: "v0.2.0",
    summary: "主页资讯加入启动器自己的发布。",
    date: Date.UTC(2026, 9, 20, 8, 0, 0),
    tag: "launcher",
    thumbnail_url: null,
    game_version: null,
  },
  {
    id: "java-26-3",
    title: "Minecraft Java Edition 26.3",
    summary: "正式版更新：新的方块、生物与性能改进。",
    date: Date.UTC(2026, 9, 14, 12, 0, 0),
    tag: "release",
    thumbnail_url: null,
    game_version: "26.3",
  },
  {
    id: "news-live-recap",
    title: "Minecraft Live 回顾",
    summary: "直播里公布的内容一览。",
    date: Date.UTC(2026, 9, 3),
    tag: "event",
    thumbnail_url: null,
    game_version: null,
  },
];

function listNews(args: MockArgs): NewsFeedDto {
  if (typeof args.retry !== "boolean") throw tauriArgError("list_news", "retry", "missing required key retry");
  return { items: NEWS, fetched_at: Date.now(), offline: false, launcher_error: null };
}

// ---- 自更新 ----

const CURRENT_VERSION = "0.1.0";
const UPDATE_SIZE = 12_582_912;
/** 假清单里的候选下载源，顺序同后端的「国内在前」。 */
const UPDATE_SOURCES = ["cn", "hk", "global", "github"] as const;

let failingUpdateSources = 0;

/** 模拟前 count 个下载源下到一部分就断开、换下一个源从头下（测试与界面调试用），至少留一个源能下完；reset 后恢复为第一个源就下完。 */
export function setMockUpdateSourceFailures(count: number): void {
  if (!Number.isInteger(count) || count < 0 || count >= UPDATE_SOURCES.length) throw new Error(`假后端只有 ${UPDATE_SOURCES.length} 个下载源，要留一个能下完：${count}`);
  failingUpdateSources = count;
}

/** 与后端一样，每个源开始下载前推一条换源事件，第一个也推。 */
function emitUpdateSource(taskId: string, index: number): void {
  emitCore({ task_id: taskId, kind: "source", index, count: UPDATE_SOURCES.length, name: UPDATE_SOURCES[index] });
}

/** 一个下到五分之一就断开的源：只报一条进度，之后由调用方换源。 */
async function simulateBrokenSource(taskId: string): Promise<void> {
  const bytes = Math.round(UPDATE_SIZE / DOWNLOAD_STEPS);
  await sleep(DOWNLOAD_STEP_MS);
  if (isMockTaskCancelled(taskId)) throw new IpcError("cancelled", "已取消");
  emitCore({ task_id: taskId, kind: "download", total: 1, finished: 0, bytes, total_bytes: UPDATE_SIZE, transferred: bytes, speed: Math.round(bytes / (DOWNLOAD_STEP_MS / 1000)) });
  await sleep(DOWNLOAD_STEP_MS);
  if (isMockTaskCancelled(taskId)) throw new IpcError("cancelled", "已取消");
}

/** 通道按快到慢排：偏好要看的是它自己和比它慢的通道。 */
const CHANNELS: readonly UpdateChannel[] = ["dev", "beta", "stable"];

const VERSION = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;
const NUMERIC_IDENTIFIER = /^\d+$/;

interface ParsedVersion {
  core: readonly [number, number, number];
  pre: readonly string[];
}

/** 假后端只认 X.Y.Z 与 X.Y.Z-标识（不带构建元数据）；别的写法是用例写错了，直接报错。 */
function parseVersion(version: string): ParsedVersion {
  const match = VERSION.exec(version);
  if (match === null) throw new Error(`假后端认不出版本号「${version}」：只认 X.Y.Z 与 X.Y.Z-标识`);
  return { core: [Number(match[1]), Number(match[2]), Number(match[3])], pre: match[4] === undefined ? [] : match[4].split(".") };
}

/** semver 的预发布标识：纯数字的低于含字母的；纯数字按数值比（不带前导零，位数多的大，序号再大也不丢精度）；含字母的按 ASCII 比。 */
function compareIdentifiers(a: string, b: string): number {
  const numericA = NUMERIC_IDENTIFIER.test(a);
  const numericB = NUMERIC_IDENTIFIER.test(b);
  if (numericA !== numericB) return numericA ? -1 : 1;
  if (numericA && a.length !== b.length) return a.length - b.length;
  return a < b ? -1 : a > b ? 1 : 0;
}

function compareCores(a: ParsedVersion, b: ParsedVersion): number {
  for (let i = 0; i < 3; i++) {
    if (a.core[i] !== b.core[i]) return a.core[i] - b.core[i];
  }
  return 0;
}

/** 按 semver 比先后，与后端同一套：核心号相同时带预发布段的更早，预发布段逐段比，前面都相同时段少的更早。 */
function compareVersions(a: string, b: string): number {
  const x = parseVersion(a);
  const y = parseVersion(b);
  const core = compareCores(x, y);
  if (core !== 0) return core;
  if (x.pre.length === 0 || y.pre.length === 0) return y.pre.length - x.pre.length;
  for (let i = 0; i < Math.min(x.pre.length, y.pre.length); i++) {
    const order = compareIdentifiers(x.pre[i], y.pre[i]);
    if (order !== 0) return order;
  }
  return x.pre.length - y.pre.length;
}

/** 包的通道：预发布标识第一段是 dev、beta 的为预览版、测试版，不带预发布段的为正式版，别的认不出。 */
function channelOf(version: string): UpdateChannel | null {
  const { pre } = parseVersion(version);
  if (pre.length === 0) return "stable";
  const tag = pre[0];
  return tag === "dev" || tag === "beta" ? tag : null;
}

function isUpdateChannel(value: string): value is UpdateChannel {
  return (CHANNELS as readonly string[]).includes(value);
}

/**
 * 一个通道的清单此刻给出什么（测试与界面调试用）。published：给出验过签的清单头；not_published：所有端点都回 404，
 * 这个通道还没有发布；stale：每个端点给出的版本 version 都旧于这台电脑记下的这个通道见过的最高版本 seen。
 */
export type MockUpdateManifest =
  | { state: "published"; version: string; notes: string | null; date: number | null }
  | { state: "not_published" }
  | { state: "stale"; version: string; seen: string };

// 默认的包是正式版 0.1.0，偏好没存过时只看正式版那份清单；另两份只在选了更快的通道时才看得到。
function seedManifests(): Record<UpdateChannel, MockUpdateManifest> {
  return {
    dev: { state: "published", version: "0.3.0-dev.4", notes: "设置里可以选更新通道。", date: Date.UTC(2026, 9, 31, 8, 0, 0) },
    beta: { state: "published", version: "0.3.0-beta.1", notes: "主页资讯加入启动器自己的发布。", date: Date.UTC(2026, 9, 30, 8, 0, 0) },
    stable: { state: "published", version: "0.2.0", notes: "新增首次启动向导与主页服务器卡片。", date: Date.UTC(2026, 9, 29, 8, 0, 0) },
  };
}

let manifests = seedManifests();

/** 设定一个通道的清单（测试与界面调试用）。清单头的版本要属于这个通道，stale 的要真的旧于 seen；reset 后恢复种子。 */
export function setMockUpdateManifest(channel: UpdateChannel, manifest: MockUpdateManifest): void {
  if (manifest.state !== "not_published" && channelOf(manifest.version) !== channel) {
    throw new Error(`${channel} 的清单头版本「${manifest.version}」不属于这个通道`);
  }
  if (manifest.state === "stale" && compareVersions(manifest.version, manifest.seen) >= 0) {
    throw new Error(`旧于本机记录的清单头要比见过的版本旧：${manifest.version} 不旧于 ${manifest.seen}`);
  }
  manifests = { ...manifests, [channel]: { ...manifest } };
}

function manifestEndpoint(channel: UpdateChannel): string {
  return `https://updates.example/${channel}/latest.json`;
}

let forcedUnsupported: UpdaterUnsupportedReason | null = null;

/** 模拟不支持自更新（测试与界面调试用），null 为按版本号判：版本号认不出通道时本来就是 unknown_channel。reset 后恢复为 null。 */
export function setMockUpdaterUnsupported(reason: UpdaterUnsupportedReason | null): void {
  forcedUnsupported = reason;
}

let dataTooNew: ReadonlySet<string> = new Set();

/**
 * 模拟这几个版本的包认得的数据格式比这台电脑上的数据旧（测试与界面调试用）：和后端一样下完、验完签才发现，
 * 下载报 update_data_too_new，那一版记进 refused。reset 后清空。
 */
export function setMockUpdateDataTooNew(versions: readonly string[]): void {
  for (const version of versions) parseVersion(version);
  dataTooNew = new Set(versions);
}

interface UpdaterMockState {
  current: string;
  /** 配置里存的 update_channel；null 是没存过，按包的通道生效。 */
  stored: UpdateChannel | null;
  available: UpdateDto | null;
  heads: ChannelHeadDto[];
  refused: RefusedUpdateDto[];
  downloaded: { version: string; channel: UpdateChannel } | null;
  installOnExit: boolean;
  /** 有更新包正在下载。 */
  busy: boolean;
}

function seedUpdater(): UpdaterMockState {
  return { current: CURRENT_VERSION, stored: null, available: null, heads: [], refused: [], downloaded: null, installOnExit: false, busy: false };
}

let updater: UpdaterMockState = seedUpdater();

/** 正在运行的这一版（测试与界面调试用），包的通道由它推出；在检查之前设。reset 后回到 0.1.0。 */
export function setMockUpdaterVersion(version: string): void {
  parseVersion(version);
  updater.current = version;
}

/** 配置里已经存着的更新通道偏好（测试与界面调试用），null 为没存过；不经命令，相当于启动前就写在配置里。reset 后为 null。 */
export function setMockUpdatePreference(channel: UpdateChannel | null): void {
  updater.stored = channel;
}

function notReady(): IpcError {
  return new IpcError("update_not_ready", "更新包还没有下载完成");
}

function busy(): IpcError {
  return new IpcError("update_busy", "已有更新包正在下载或安装");
}

type Support = { supported: true; channel: UpdateChannel } | { supported: false; reason: UpdaterUnsupportedReason };

function support(): Support {
  if (forcedUnsupported !== null) return { supported: false, reason: forcedUnsupported };
  const channel = channelOf(updater.current);
  return channel === null ? { supported: false, reason: "unknown_channel" } : { supported: true, channel };
}

/** 与后端一样，更新命令开头先确认支持自更新；返回包的通道。 */
function requireSupported(): UpdateChannel {
  const current = support();
  if (!current.supported) throw new IpcError("updater_unsupported", `当前环境不支持自更新（${current.reason}）`, { reason: current.reason });
  return current.channel;
}

function effectivePreference(packageChannel: UpdateChannel): UpdateChannel {
  return updater.stored === null ? packageChannel : updater.stored;
}

function relationOf(preference: UpdateChannel, packageChannel: UpdateChannel): ChannelRelation {
  if (preference === packageChannel) return "same";
  return CHANNELS.indexOf(preference) > CHANNELS.indexOf(packageChannel) ? "waiting" : "following";
}

function updaterInfo(): UpdaterInfoDto {
  const current = support();
  const packageChannel = channelOf(updater.current);
  const preference = packageChannel === null ? null : effectivePreference(packageChannel);
  const downloaded = updater.downloaded;
  return {
    current_version: updater.current,
    supported: current.supported,
    unsupported_reason: current.supported ? null : current.reason,
    package_channel: packageChannel,
    preference,
    relation: packageChannel === null || preference === null ? null : relationOf(preference, packageChannel),
    available: updater.available,
    channel_heads: updater.heads,
    refused: updater.refused,
    downloaded_version: downloaded === null ? null : downloaded.version,
    downloaded_channel: downloaded === null ? null : downloaded.channel,
    downloaded_intent: downloaded === null ? null : "update",
    install_on_exit: updater.installOnExit,
  };
}

function headOf(channel: UpdateChannel): ChannelHeadDto {
  const manifest = manifests[channel];
  switch (manifest.state) {
    case "published":
      return { channel, state: "published", version: manifest.version, date: manifest.date };
    case "stale":
      return { channel, state: "stale", version: manifest.version, date: null };
    case "not_published":
      return { channel, state: "not_published", version: null, date: null };
  }
}

/**
 * 自动更新挑候选的规则，与后端同一套：要比当前新；关系不是等待、又跟到比包更慢的通道时，核心号要前进（测试版跟随同号
 * 正式版例外：两者是同一份源码）；本次会话没拒过。
 */
function isCandidate(version: string, channel: UpdateChannel, packageChannel: UpdateChannel, relation: ChannelRelation): boolean {
  if (compareVersions(version, updater.current) <= 0) return false;
  const slower = CHANNELS.indexOf(channel) > CHANNELS.indexOf(packageChannel);
  const sameSource = packageChannel === "beta" && channel === "stable";
  if (relation !== "waiting" && slower && !sameSource && compareCores(parseVersion(version), parseVersion(updater.current)) <= 0) return false;
  return !updater.refused.some((r) => r.version === version && r.channel === channel);
}

/** 与后端一致：已下载的包只有与新结果同版本才保留，否则丢弃并撤销「退出时安装」。 */
function settle(found: UpdateDto | null): void {
  if (updater.downloaded !== null && updater.downloaded.version !== found?.version) {
    updater.downloaded = null;
    updater.installOnExit = false;
  }
  updater.available = found;
}

/**
 * 看偏好通道和比它慢的通道，各自的结果记进 channel_heads。偏好通道的清单旧于本机记录时整次失败，不拿更慢的通道顶上。
 * 挑中别的通道的候选、偏好又没存过时，同一次检查把当时包的通道写成偏好：装上那个通道的包之后仍按原来那条线收更新。
 */
function checkUpdate(): UpdateDto | null {
  const packageChannel = requireSupported();
  const preference = effectivePreference(packageChannel);
  const relation = relationOf(preference, packageChannel);
  const followed = CHANNELS.slice(CHANNELS.indexOf(preference));
  updater.heads = followed.map(headOf);
  const own = manifests[preference];
  if (own.state === "stale") {
    throw new IpcError("update_source_stale", `${preference} 的更新源给出的 ${own.version} 比这台电脑见过的 ${own.seen} 旧`, {
      channel: preference,
      offered: [{ endpoint: manifestEndpoint(preference), version: own.version }],
      seen: own.seen,
    });
  }
  const candidates = followed
    .flatMap((channel) => {
      const manifest = manifests[channel];
      return manifest.state === "published" && isCandidate(manifest.version, channel, packageChannel, relation) ? [{ channel, manifest }] : [];
    })
    .sort((a, b) => compareVersions(b.manifest.version, a.manifest.version));
  if (candidates.length === 0) {
    // 偏好通道还没有发布、别的通道也没有候选：不算失败，本次会话已知的结果不动
    if (own.state === "not_published") return updater.available;
    settle(null);
    return null;
  }
  const picked = candidates[0];
  if (picked.channel !== packageChannel && updater.stored === null) updater.stored = packageChannel;
  const found: UpdateDto = {
    version: picked.manifest.version,
    current_version: updater.current,
    notes: picked.manifest.notes,
    date: picked.manifest.date,
    channel: picked.channel,
  };
  settle(found);
  return found;
}

async function downloadUpdate(args: MockArgs): Promise<UpdateDto> {
  const taskId = requireString(args, "taskId", "download_update");
  requireSupported();
  beginMockTask(taskId);
  try {
    if (updater.busy) throw busy();
    const update = updater.available;
    if (update === null) throw new IpcError("update_not_available", "还没有检查到可用更新");
    updater.busy = true;
    try {
      for (let index = 0; index < failingUpdateSources; index++) {
        emitUpdateSource(taskId, index);
        await simulateBrokenSource(taskId);
      }
      emitUpdateSource(taskId, failingUpdateSources);
      await simulateMockDownload(taskId, 1, UPDATE_SIZE);
      emitCore({ task_id: taskId, kind: "stage", message: "更新包下载完成，正在校验签名" });
      if (dataTooNew.has(update.version)) {
        updater.refused = [...updater.refused, { version: update.version, channel: update.channel, reason: "data_too_new", intent: "update" }];
        throw new IpcError("update_data_too_new", `${update.version} 读不了这台电脑上的数据，下好的包已丢弃`);
      }
      updater.downloaded = { version: update.version, channel: update.channel };
      return update;
    } finally {
      updater.busy = false;
    }
  } finally {
    endMockTask(taskId);
  }
}

/** 真后端装完即退出或重启；mock 直接切到新版本，相当于重启后的状态：本次会话的结果都没了，配置里的偏好还在。 */
function installUpdate(): void {
  requireSupported();
  const downloaded = updater.downloaded;
  if (downloaded === null) throw notReady();
  updater = { ...seedUpdater(), current: downloaded.version, stored: updater.stored };
}

function setInstallOnExit(args: MockArgs): void {
  const enabled = args.enabled;
  if (typeof enabled !== "boolean") throw tauriArgError("set_install_on_exit", "enabled", "missing required key enabled");
  requireSupported();
  if (enabled && updater.downloaded === null) throw notReady();
  updater.installOnExit = enabled;
}

/**
 * 与后端同序：先认通道名，再看支不支持自更新，再看有没有更新包在下载。生效的偏好变了才作废本次会话按旧偏好得出的结果。
 * 后端这时还会清掉 refused 里 preference_unsaved 的条目；假后端不模拟写不进偏好，refused 里只有 data_too_new，它不随改通道清掉。
 */
function setUpdateChannel(args: MockArgs): UpdaterInfoDto {
  const channel = requireString(args, "channel", "set_update_channel");
  if (!isUpdateChannel(channel)) throw new IpcError("invalid_argument", `更新通道「${channel}」不是 dev、beta、stable 之一`);
  const packageChannel = requireSupported();
  if (updater.busy) throw busy();
  const before = effectivePreference(packageChannel);
  updater.stored = channel;
  if (channel !== before) {
    updater.available = null;
    updater.downloaded = null;
    updater.installOnExit = false;
    updater.heads = [];
  }
  return updaterInfo();
}

export const handlers: MockHandlers = {
  memory_advice: (args) => memoryAdvice(args),
  is_first_run: () => !isFirstRunCompleted(),
  complete_first_run: (args) => completeFirstRun(args),
  startup_notices: () => startupNotices,
  probe_network: () => networkReachable,
  list_pinned_servers: () => pinned,
  set_pinned_servers: (args) => setPinnedServers(args),
  set_pinned_server_instance: (args) => setPinnedServerInstance(args),
  list_known_servers: () => listKnownServers(),
  ping_servers: (args) => pingServers(args),
  list_news: (args) => listNews(args),
  updater_info: () => updaterInfo(),
  check_update: () => checkUpdate(),
  download_update: (args) => downloadUpdate(args),
  install_update: () => installUpdate(),
  set_install_on_exit: (args) => setInstallOnExit(args),
  set_update_channel: (args) => setUpdateChannel(args),
};

export function reset(): void {
  startupNotices = [];
  networkReachable = true;
  pinned = SEED_PINNED.map((s) => ({ ...s }));
  updater = seedUpdater();
  failingUpdateSources = 0;
  manifests = seedManifests();
  forcedUnsupported = null;
  dataTooNew = new Set();
}

// 固定的服务器在后端是配置的一部分；启动提示与更新状态每次启动重新得出，不存。
// 更新通道的偏好在后端也存在配置里，这里却不存：它是相对包的版本说的，而假后端的版本每次刷新都回到种子。
// 版本 2：固定项多了记住的实例。
export const persist: MockPersist = {
  version: 2,
  snapshot: () => pinned,
  restore: (data) => {
    pinned = data as PinnedServerDto[];
  },
};
