// 启动链路的假后端：八阶段推进、同一时间只运行一个游戏、结束与退出、游玩统计。
// 游戏不会自己退出：浏览器里看界面时用 endMockGame 模拟正常退出或崩溃，用 failNextMockLaunch 模拟启动失败。

import type { ConfigDto } from "../../config";
import type { CrashReportDto, LaunchLogDto, SessionOutcome } from "../../diagnostics";
import { IpcError } from "../../errors";
import {
  BUSY_ERROR_CODE,
  GAME_EXIT_EVENT,
  GAME_LOG_EVENT,
  LAUNCH_PHASE_EVENT,
  type BusyDetail,
  type GameExitEvent,
  type InstanceMinutesDto,
  type LaunchPhaseEvent,
  type LaunchPhaseName,
  type LogLevelName,
  type LogLineDto,
  type PlayDayDto,
  type PlayStatsDto,
} from "../../launch";
import { emitMockEvent } from "../events";
import type { MockArgs, MockHandlers } from "../types";
import { handlers as configHandlers, samePath } from "./config";
import { acquireMockInstanceWithBases, mockInheritanceChain, type MockInstanceHold } from "./instances";
import { beginMockTask, endMockTask, isMockTaskCancelled } from "./tasks";

const MOCK_PID = 4242;
const MS_PER_MINUTE = 60_000;
const DAY_MS = 86_400_000;

const STAGES: { phase: LaunchPhaseName; label: string }[] = [
  { phase: "preparing", label: "检查 Java" },
  { phase: "preparing", label: "校验游戏文件" },
  { phase: "preparing", label: "补全库文件" },
  { phase: "downloading", label: "下载缺失文件" },
  { phase: "launching", label: "解压本地库" },
  { phase: "launching", label: "生成启动参数" },
  { phase: "launching", label: "启动游戏进程" },
  { phase: "running", label: "游戏运行中" },
];

/** 每个失败码在哪个阶段出现，与后端检查它的阶段一致。 */
const FAILURE_STAGE: Record<string, number> = {
  java_missing: 0,
  java_pinned_missing: 0,
  java_too_old: 0,
  account_relogin: 0,
  account_refresh_network: 0,
  version_broken: 1,
  files_offline: 3,
  files_failed: 3,
  disk_full: 3,
  spawn_failed: 6,
};

/** 崩溃时追加的游戏输出，最后一行是诊断命中的那一行。 */
const CRASH_TAIL = [
  "[12:00:01] [Render thread/INFO]: Reloading ResourceManager: vanilla",
  "[12:00:02] [Render thread/WARN]: Texture atlas is larger than recommended",
  "java.lang.OutOfMemoryError: Java heap space",
];

interface Occupant {
  versionId: string;
  phase: BusyDetail["phase"];
  startedAt: number;
  runningSince: number;
  /** 实例占用：从启动一直持有到游戏退出，期间改名、删除、补全被拒绝，Mod 与设置的改动照常。 */
  hold: MockInstanceHold;
  /** 启动时的游戏目录：这一局记在它下面，游戏运行期间换了游戏目录也记回这里。 */
  gameDir: string;
}

interface PendingFailure {
  code: string;
  message: string;
  params: Record<string, string | number>;
}

let occupant: Occupant | null = null;
let pendingFailure: PendingFailure | null = null;
let logs = new Map<string, LaunchLogDto>();
let crashes = new Map<string, CrashReportDto>();

/** 一个游戏目录的游玩记录。 */
interface PlayBook {
  /** 记下时的游戏目录；与后端一样，比对时不分大小写与斜杠方向、忽略末尾分隔符。 */
  gameDir: string;
  /** 本地日期 -> 实例 id -> 毫秒。 */
  days: Map<string, Map<string, number>>;
  /** 实例 id -> 累计毫秒与上次游玩结束时刻；与后端一样，累计不受每日记录的保留窗口影响。 */
  totals: Map<string, { totalMs: number; lastPlayedAt: number }>;
}

/**
 * 与后端一样按游戏目录分开记：实例 id 只在一个游戏目录里唯一，换了游戏目录，同名的是另一个实例，不继承这边的时长。
 * 列表、统计、改名与删除只看当前游戏目录。
 */
let playBooks: PlayBook[] = [];

function mockConfig(): ConfigDto {
  return configHandlers.get_config({}) as ConfigDto;
}

function findBook(gameDir: string): PlayBook | undefined {
  return playBooks.find((book) => samePath(book.gameDir, gameDir));
}

/** 当前游戏目录的记录；没记过时为 undefined：改名、删除、列表与统计不凭空开一本空账，与后端一致。 */
function currentBook(): PlayBook | undefined {
  return findBook(mockConfig().game_dir);
}

function localDate(at: number): string {
  const d = new Date(at);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** 累加：键第一次出现时从 ms 起算。 */
function accumulate(map: Map<string, number>, key: string, ms: number): void {
  const before = map.get(key);
  map.set(key, before === undefined ? ms : before + ms);
}

/** 记一局：这个游戏目录没记过时新开一本。 */
function addPlay(gameDir: string, versionId: string, at: number, ms: number): void {
  let book = findBook(gameDir);
  if (book === undefined) {
    book = { gameDir, days: new Map(), totals: new Map() };
    playBooks.push(book);
  }
  const before = book.totals.get(versionId);
  book.totals.set(versionId, {
    totalMs: before === undefined ? ms : before.totalMs + ms,
    lastPlayedAt: before === undefined ? at : Math.max(before.lastPlayedAt, at),
  });
  const date = localDate(at);
  let day = book.days.get(date);
  if (day === undefined) {
    day = new Map<string, number>();
    book.days.set(date, day);
  }
  accumulate(day, versionId, ms);
}

// 近两周断续的游玩，让日历与洞察在浏览器里打开时不是空的。
function seedPlay(): void {
  playBooks = [];
  // 种子实例记在默认游戏目录下而不是当前目录：复位时配置可能还停在换过的目录上，这样不依赖各领域复位的先后。
  const home = mockConfig().default_game_dir;
  const now = Date.now();
  // 实例 id 与实例 mock 的种子一致，实例列表里的游玩时长与这里的日历对得上。
  const pattern: [number, string, number][] = [
    [1, "1.20.1-Fabric", 95],
    [2, "1.21", 40],
    [2, "1.20.1-Fabric", 30],
    [4, "1.21", 120],
    [7, "1.20.1-Fabric", 55],
    [11, "1.21", 15],
  ];
  for (const [daysAgo, versionId, minutes] of pattern) addPlay(home, versionId, now - daysAgo * DAY_MS, minutes * MS_PER_MINUTE);
}

function emitPhase(taskId: string, stageIndex: number, download?: LaunchPhaseEvent["download"]): void {
  const payload: LaunchPhaseEvent = { task_id: taskId, phase: STAGES[stageIndex].phase, stage_index: stageIndex };
  if (download) payload.download = download;
  emitMockEvent(LAUNCH_PHASE_EVENT, payload);
}

function pushLines(versionId: string, lines: LogLineDto[]): void {
  const log = logs.get(versionId);
  if (log) log.lines.push(...lines);
  emitMockEvent(GAME_LOG_EVENT, { version_id: versionId, lines });
}

function line(source: LogLineDto["source"], level: LogLevelName, text: string): LogLineDto {
  return { at: Date.now(), source, level, text };
}

function endLog(versionId: string, outcome: SessionOutcome): void {
  const log = logs.get(versionId);
  if (log) log.ended = { at: Date.now(), outcome };
}

// 与后端对齐：缺参数或类型不对是 Tauri 自身的参数错误（纯字符串，前端归为 unknown）；
// 参数齐全但组合不合法由命令自己报 invalid_argument。
function argError(command: string, key: string): IpcError {
  return new IpcError("unknown", `invalid args \`${key}\` for command \`${command}\``);
}

function stringArg(command: string, args: MockArgs, key: string): string {
  const value = args[key];
  if (typeof value !== "string") throw argError(command, key);
  return value;
}

/** Rust 侧的 Option<String>：缺键与 null 都是 None。 */
function optionalStringArg(command: string, args: MockArgs, key: string): string | null {
  const value = args[key];
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw argError(command, key);
  return value;
}

function busy(current: Occupant): IpcError {
  const verb = current.phase === "running" ? "正在运行" : "正在启动";
  const detail: BusyDetail = { version_id: current.versionId, phase: current.phase };
  return new IpcError(BUSY_ERROR_CODE, `${current.versionId} ${verb}，同一时间只能运行一个游戏`, detail);
}

async function launchGame(args: MockArgs): Promise<{ pid: number }> {
  const taskId = stringArg("launch_game", args, "taskId");
  const versionId = stringArg("launch_game", args, "versionId");
  const uuid = optionalStringArg("launch_game", args, "accountUuid");
  const name = optionalStringArg("launch_game", args, "offlineName");
  if ((uuid === null) === (name === null)) throw new IpcError("invalid_argument", "启动需提供 account_uuid 与 offline_name 二者之一");
  if (occupant) throw busy(occupant);
  // 与后端同序：先占全局唯一的游戏槽，再连同继承链上的基底占住实例（新建、补全、改名、删除进行中报 instance_busy），
  // 最后登记任务；基底一直占到游戏退出，游戏期间要读它的客户端 jar 与 natives。
  const hold = acquireMockInstanceWithBases(versionId, "launching", mockInheritanceChain(versionId));
  try {
    beginMockTask(taskId);
  } catch (error) {
    hold.release();
    throw error;
  }
  const startedAt = Date.now();
  // 与后端一样取启动这一刻的游戏目录（启动用的是那一刻的门面快照）。
  const gameDir = mockConfig().game_dir;
  occupant = { versionId, phase: "loading", startedAt, runningSince: startedAt, hold, gameDir };
  logs.set(versionId, { path: `D:/mc/versions/${versionId}/logs/latest.log`, started_at: startedAt, lines: [], omitted: 0, ended: null });
  const failure = pendingFailure;
  pendingFailure = null;
  try {
    for (let index = 0; index < STAGES.length - 1; index++) {
      // 让出一拍，界面能看到阶段一格一格推进，取消也有机会插进来。
      await Promise.resolve();
      if (isMockTaskCancelled(taskId)) {
        endLog(versionId, "cancelled");
        throw new IpcError("cancelled", "已取消");
      }
      emitPhase(taskId, index);
      pushLines(versionId, [line("launcher", "info", STAGES[index].label)]);
      if (failure && FAILURE_STAGE[failure.code] === index) {
        pushLines(versionId, [line("launcher", "error", `启动失败：${failure.message}`)]);
        endLog(versionId, "failed");
        throw new IpcError(failure.code, failure.message, failure.params);
      }
      if (index === 3) {
        emitPhase(taskId, 3, { total: 0, finished: 0, bytes: 0, total_bytes: 0, speed: 0 });
      }
    }
  } catch (error) {
    occupant = null;
    hold.release();
    throw error;
  } finally {
    endMockTask(taskId);
  }
  hold.setActivity("running");
  occupant = { versionId, phase: "running", startedAt, runningSince: Date.now(), hold, gameDir };
  emitPhase(taskId, STAGES.length - 1);
  pushLines(versionId, [line("game", "info", "[12:00:00] [main/INFO]: Loading Minecraft")]);
  return { pid: MOCK_PID };
}

/** 游戏退出的收尾：记游玩、崩溃时留报告，先放开占用再推退出事件，与后端顺序一致。 */
function finishGame(exitCode: number | null, killed: boolean, durationMs: number): void {
  if (!occupant || occupant.phase !== "running") throw new Error("mock 里没有运行中的游戏");
  const { versionId } = occupant;
  const log = logs.get(versionId);
  if (log === undefined) throw new Error(`mock 丢了 ${versionId} 的会话日志`);
  const crashed = !killed && exitCode !== 0;
  const outcome: SessionOutcome = killed ? "killed" : crashed ? "crashed" : "exited";
  if (crashed) {
    pushLines(
      versionId,
      CRASH_TAIL.map((text, i) => line("game", i === CRASH_TAIL.length - 1 ? "error" : i === 1 ? "warn" : "info", text)),
    );
  }
  const code = exitCode === null ? "未知" : String(exitCode);
  pushLines(versionId, [line("launcher", crashed ? "error" : "info", `游戏${crashed ? "异常" : ""}退出（退出码 ${code}）`)]);
  endLog(versionId, outcome);
  const exitedAt = Date.now();
  addPlay(occupant.gameDir, versionId, exitedAt, durationMs);
  if (crashed) {
    const matched = CRASH_TAIL[CRASH_TAIL.length - 1];
    const hit = log.lines.findIndex((l) => l.text === matched);
    crashes.set(versionId, {
      at: exitedAt,
      exit_code: exitCode,
      session_started_at: log.started_at,
      log_path: log.path,
      diagnoses: [
        {
          category: "out_of_memory",
          summary: "内存不足",
          advice: "调高最大内存（-Xmx），减少同时加载的 Mod 与高清材质。",
          detail: null,
          matched,
          line: hit + 1,
          context: log.lines.slice(Math.max(0, hit - 2), hit).map((l) => l.text),
        },
      ],
      suspects: [],
      java: { major: 21, path: "C:/Program Files/Java/jdk-21/bin/java.exe", is_64bit: true },
      max_memory_mb: 4096,
      warnings: [],
    });
  }
  // 收尾记账写完后放开占用，再推退出事件：前端收到退出时已经可以改名、删除
  occupant.hold.release();
  occupant = null;
  const payload: GameExitEvent = { version_id: versionId, exit_code: exitCode, crashed, killed, duration_ms: durationMs };
  emitMockEvent(GAME_EXIT_EVENT, payload);
}

/** 模拟游戏自己退出（退出码非 0 即崩溃）。durationMs 缺省为从进程起来到现在。 */
export function endMockGame(exitCode: number | null, durationMs?: number): void {
  if (!occupant) throw new Error("mock 里没有运行中的游戏");
  finishGame(exitCode, false, durationMs === undefined ? Date.now() - occupant.runningSince : durationMs);
}

/** 下一次改名或删除时游玩记录没跟上的原因；null 为照常。 */
let pendingRecordsFailure: string | null = null;

/**
 * 下一次改名或删除时游玩记录没跟上（模拟 playtime.json 读写失败）：目录、侧栏固定与当前选中照常改好，命令报
 * play_records_failed。后端会把没改成的记录留在待补队列、下一次读写时补上，前端随即重扫列表就会读到，
 * 所以 mock 里记录照样迁移，只是命令报这个码。
 */
export function failNextMockPlayRecords(cause = "拒绝访问。 (os error 5)"): void {
  pendingRecordsFailure = cause;
}

/** 取走待报的游玩记录失败原因，只报一次。 */
export function takeMockPlayRecordsFailure(): string | null {
  const cause = pendingRecordsFailure;
  pendingRecordsFailure = null;
  return cause;
}

/** 下一次启动在对应阶段以该失败码失败。 */
export function failNextMockLaunch(code: string, params: Record<string, string | number>, message = `模拟的启动失败 ${code}`): void {
  if (!(code in FAILURE_STAGE)) throw new Error(`未知的启动失败码 ${code}`);
  pendingFailure = { code, message, params };
}

/** 诊断 mock 读取用。 */
/** 当前游戏目录里某实例的累计游玩（分钟向下取整）与上次游玩；没玩过为 null。实例 mock 的列表据此给出游玩时长。 */
export function mockPlaySummary(versionId: string): { playtime_min: number; last_played_at: number } | null {
  const book = currentBook();
  if (book === undefined) return null;
  const total = book.totals.get(versionId);
  if (total === undefined) return null;
  return { playtime_min: Math.floor(total.totalMs / MS_PER_MINUTE), last_played_at: total.lastPlayedAt };
}

export function mockLaunchLog(versionId: string): LaunchLogDto | null {
  const log = logs.get(versionId);
  return log === undefined ? null : log;
}

export function mockCrashReport(versionId: string): CrashReportDto | null {
  const report = crashes.get(versionId);
  return report === undefined ? null : report;
}

/** 去掉一个游戏目录里某实例的累计与每日记录。只剩这个实例的日子一并删掉，免得统计里多出零分钟的一天。 */
function forgetPlay(book: PlayBook, versionId: string): void {
  book.totals.delete(versionId);
  for (const [date, day] of [...book.days.entries()]) {
    day.delete(versionId);
    if (day.size === 0) book.days.delete(date);
  }
}

/**
 * 实例删除后去掉它的游玩记录、会话日志与崩溃报告，之后新建的同名实例从零开始。后端的游玩记录在数据目录里按游戏目录与
 * 实例 id 记，删除时显式清掉当前游戏目录下的那一份，别的游戏目录里的同名实例不受影响；日志与崩溃报告在实例目录里，随目录
 * 一起没了。
 */
export function forgetMockLaunchRecords(versionId: string): void {
  const book = currentBook();
  if (book !== undefined) forgetPlay(book, versionId);
  logs.delete(versionId);
  crashes.delete(versionId);
}

/** 实例目录改名后，日志与报告里记的路径指向新目录。 */
function relocated(path: string, from: string, to: string): string {
  return path.replace(`/versions/${from}/`, `/versions/${to}/`);
}

function moveKey<V>(map: Map<string, V>, from: string, to: string, adjust: (value: V) => V = (value) => value): void {
  const value = map.get(from);
  if (value === undefined) return;
  map.delete(from);
  map.set(to, adjust(value));
}

/**
 * 实例改名后它的游玩记录、会话日志与崩溃报告跟到新名字下：游玩记录由后端显式迁移（只迁当前游戏目录下的），日志与报告随
 * 实例目录一起改名。新名字下原有的记录先清掉，与后端迁移游玩记录的做法一致。
 */
export function renameMockLaunchRecords(from: string, to: string): void {
  if (from === to) return;
  forgetMockLaunchRecords(to);
  const book = currentBook();
  if (book !== undefined) {
    moveKey(book.totals, from, to);
    for (const day of book.days.values()) moveKey(day, from, to);
  }
  moveKey(logs, from, to, (log) => ({ ...log, path: relocated(log.path, from, to) }));
  moveKey(crashes, from, to, (report) => ({ ...report, log_path: report.log_path === null ? null : relocated(report.log_path, from, to) }));
}

function rankMinutes(totals: Map<string, number>): InstanceMinutesDto[] {
  return [...totals.entries()]
    .sort(([aId, aMs], [bId, bMs]) => bMs - aMs || (aId < bId ? -1 : aId > bId ? 1 : 0))
    .map(([version_id, ms]) => ({ version_id, minutes: Math.floor(ms / MS_PER_MINUTE) }));
}

function canonicalDate(text: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return null;
  const [y, m, d] = text.split("-").map(Number);
  const date = new Date(y, m - 1, d);
  return date.getFullYear() === y && date.getMonth() === m - 1 && date.getDate() === d ? text : null;
}

function playStats(args: MockArgs): PlayStatsDto {
  const raw = args.range;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw argError("play_stats", "range");
  const range = raw as Record<string, unknown>;
  if (typeof range.from !== "string" || typeof range.to !== "string") throw argError("play_stats", "range");
  const from = canonicalDate(range.from);
  const to = canonicalDate(range.to);
  if (from === null || to === null || from > to) {
    throw new IpcError("invalid_argument", `统计区间 ${range.from} 至 ${range.to} 无效：日期须为 YYYY-MM-DD，且起点不晚于终点`, {
      from: range.from,
      to: range.to,
    });
  }
  const totals = new Map<string, number>();
  const days: PlayDayDto[] = [];
  // 统计只看当前游戏目录；没记过的目录与后端一样读作一本空账。
  const book = currentBook();
  const recorded = book === undefined ? [] : [...book.days.entries()];
  for (const [date, perInstance] of recorded.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    if (date < from || date > to) continue;
    let dayMs = 0;
    for (const [id, ms] of perInstance) {
      accumulate(totals, id, ms);
      dayMs += ms;
    }
    days.push({ date, minutes: Math.floor(dayMs / MS_PER_MINUTE), instances: rankMinutes(perInstance) });
  }
  const totalMs = [...totals.values()].reduce((a, b) => a + b, 0);
  return { from, to, days, total_minutes: Math.floor(totalMs / MS_PER_MINUTE), instances: rankMinutes(totals) };
}

export const handlers: MockHandlers = {
  launch_game: launchGame,
  stop_game: () => {
    if (occupant?.phase === "running") finishGame(1, true, Date.now() - occupant.runningSince);
  },
  play_stats: playStats,
};

export function reset(): void {
  occupant = null;
  pendingFailure = null;
  pendingRecordsFailure = null;
  logs = new Map();
  crashes = new Map();
  seedPlay();
}

seedPlay();
