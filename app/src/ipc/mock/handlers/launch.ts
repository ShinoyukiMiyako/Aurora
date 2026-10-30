// 启动链路的假后端：八阶段推进、同一时间只运行一个游戏、结束与退出、游玩统计。
// 游戏不会自己退出：浏览器里看界面时用 endMockGame 模拟正常退出或崩溃，用 failNextMockLaunch 模拟启动失败。

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
/** 本地日期 -> 实例 id -> 毫秒。 */
let playDays = new Map<string, Map<string, number>>();

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

function addPlay(versionId: string, at: number, ms: number): void {
  const date = localDate(at);
  let day = playDays.get(date);
  if (day === undefined) {
    day = new Map<string, number>();
    playDays.set(date, day);
  }
  accumulate(day, versionId, ms);
}

// 近两周断续的游玩，让日历与洞察在浏览器里打开时不是空的。
function seedPlay(): Map<string, Map<string, number>> {
  playDays = new Map();
  const now = Date.now();
  const pattern: [number, string, number][] = [
    [1, "1.20.1-fabric", 95],
    [2, "1.21", 40],
    [2, "1.20.1-fabric", 30],
    [4, "1.21", 120],
    [7, "1.20.1-fabric", 55],
    [11, "1.21", 15],
  ];
  for (const [daysAgo, versionId, minutes] of pattern) addPlay(versionId, now - daysAgo * DAY_MS, minutes * MS_PER_MINUTE);
  return playDays;
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
  beginMockTask(taskId);
  const startedAt = Date.now();
  occupant = { versionId, phase: "loading", startedAt, runningSince: startedAt };
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
    throw error;
  } finally {
    endMockTask(taskId);
  }
  occupant = { versionId, phase: "running", startedAt, runningSince: Date.now() };
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
  addPlay(versionId, exitedAt, durationMs);
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
  occupant = null;
  const payload: GameExitEvent = { version_id: versionId, exit_code: exitCode, crashed, killed, duration_ms: durationMs };
  emitMockEvent(GAME_EXIT_EVENT, payload);
}

/** 模拟游戏自己退出（退出码非 0 即崩溃）。durationMs 缺省为从进程起来到现在。 */
export function endMockGame(exitCode: number | null, durationMs?: number): void {
  if (!occupant) throw new Error("mock 里没有运行中的游戏");
  finishGame(exitCode, false, durationMs === undefined ? Date.now() - occupant.runningSince : durationMs);
}

/** 下一次启动在对应阶段以该失败码失败。 */
export function failNextMockLaunch(code: string, params: Record<string, string | number>, message = `模拟的启动失败 ${code}`): void {
  if (!(code in FAILURE_STAGE)) throw new Error(`未知的启动失败码 ${code}`);
  pendingFailure = { code, message, params };
}

/** 诊断 mock 读取用。 */
export function mockLaunchLog(versionId: string): LaunchLogDto | null {
  const log = logs.get(versionId);
  return log === undefined ? null : log;
}

export function mockCrashReport(versionId: string): CrashReportDto | null {
  const report = crashes.get(versionId);
  return report === undefined ? null : report;
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
  for (const [date, perInstance] of [...playDays.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
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
  logs = new Map();
  crashes = new Map();
  seedPlay();
}

seedPlay();
