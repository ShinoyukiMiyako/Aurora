// 启动会话的状态转移。全局同一时刻最多一个会话；每个输入都核对它属于哪一次启动（taskId）或哪个实例，
// 迟到的旧事件原样丢弃。进度按八阶段表的区间计算，阶段 3 按字节线性推进，结果与旧值取最大（单调不减）。

import { SESSION_LOG_LIMIT } from "../domain/limits";
import { FAILURE_CODES, type AccountKind, type FailureCode, type LogLine, type Session, type SessionDownload, type SessionPhase } from "../domain/types";
import type { CrashCategoryName } from "../copy/flows";
import type { LaunchPhaseName, QuickPlayArg } from "../ipc/launch";

/** 崩溃会话的主线索：读报告前为 pending，读不出报告为 unavailable。 */
export type SessionCrash = { status: "pending" } | { status: "known"; category: CrashCategoryName | null } | { status: "unavailable" };

/** 状态层持有的会话：领域 Session 加上取消句柄与本次所用账户。 */
export interface SessionState extends Session {
  /** 本次启动的取消句柄（cancel_task 用），阶段事件以它标明属于哪一次启动。 */
  taskId: string;
  accountUuid: string;
  /** 本次所用账户的名字：失败文案要写它，账户随后被删除时也不丢。 */
  accountName: string;
  /** 本次所用账户的类型：服务故障的失败文案按它说是谁的故障，与名字一样不随账户删除丢失。 */
  accountKind: AccountKind;
  /** 这次启动直达的世界或服务器；普通启动为 null。失败后「重试」带着它再来一次。 */
  quickPlay: QuickPlayArg | null;
  crash: SessionCrash | null;
  /**
   * 加载期间各阶段收到的提醒条数，下标对应八阶段表。准备阶段的检查项不通过但不阻断时，后端写一条启动器 warn 日志，
   * 状态岛的阶段清单在该阶段右侧写「N 条提醒」。
   */
  stageWarnings: readonly number[];
  /**
   * 这一局不是这个渲染进程点启动建的，而是从后端找回的：关闭前启动、这次打开后接回的，或渲染进程重载前就在跑的。
   * 进入运行的那一刻早已过去，「游戏启动后」的最小化与关闭不再执行。
   */
  reattached: boolean;
}

/** 各阶段的起点；阶段 7 恒为 1。 */
export const STAGE_START: readonly number[] = [0, 0.1, 0.2, 0.3, 0.75, 0.83, 0.91, 1];
const DOWNLOAD_STAGE = 3;
const RUNNING_STAGE = 7;

const LOADING: readonly SessionPhase[] = ["preparing", "downloading", "launching"];

export function isLoadingPhase(phase: SessionPhase): phase is "preparing" | "downloading" | "launching" {
  return LOADING.includes(phase);
}

/** 加载阶段或运行中：此时它占着游戏进程。 */
export function isSessionActive(session: Session | null): boolean {
  return session !== null && (isLoadingPhase(session.phase) || session.phase === "running");
}

export function isFailureCode(code: string): code is FailureCode {
  return (FAILURE_CODES as readonly string[]).includes(code);
}

/** 阶段 3 的字节比例；声明大小未知时退回文件数比例。有效字节可能越过声明大小，封顶到 1。 */
export function downloadFraction(download: SessionDownload): number {
  if (download.totalBytes !== null && download.totalBytes > 0) return Math.min(1, download.bytes / download.totalBytes);
  if (download.total !== null && download.total > 0) return Math.min(1, download.done / download.total);
  return 0;
}

export function stageProgress(stageIndex: number, download: SessionDownload | null): number {
  const start = STAGE_START[stageIndex];
  if (start === undefined) throw new Error(`阶段下标 ${stageIndex} 超出八阶段表`);
  if (stageIndex === DOWNLOAD_STAGE && download !== null) {
    return start + (STAGE_START[DOWNLOAD_STAGE + 1] - start) * downloadFraction(download);
  }
  return start;
}

export function startSession(instanceId: string, taskId: string, account: { uuid: string; name: string; kind: AccountKind }, now: number, quickPlay: QuickPlayArg | null): SessionState {
  return {
    instanceId,
    taskId,
    accountUuid: account.uuid,
    accountName: account.name,
    accountKind: account.kind,
    quickPlay,
    phase: "preparing",
    progress: 0,
    stageIndex: 0,
    startedAt: now,
    runningSince: null,
    phaseSince: now,
    logs: [],
    download: null,
    stopReason: null,
    failure: null,
    crash: null,
    stageWarnings: STAGE_START.map(() => 0),
    reattached: false,
  };
}

/**
 * 从后端找回的、已经在运行的一局：加载阶段在找回之前就过去了，直接是运行态。游玩时长从后端记下的进程起来的时刻算，
 * 不从此刻算；阶段起点取此刻，界面上「运行中」的停留从找回时起算。
 */
export function reattachedSession(
  instanceId: string,
  taskId: string,
  account: { uuid: string; name: string; kind: AccountKind },
  times: { startedAt: number; runningSince: number },
  now: number,
): SessionState {
  return {
    ...startSession(instanceId, taskId, account, times.startedAt, null),
    phase: "running",
    stageIndex: RUNNING_STAGE,
    progress: 1,
    runningSince: times.runningSince,
    phaseSince: now,
    reattached: true,
  };
}

function enterPhase(session: SessionState, phase: SessionPhase, now: number): Pick<SessionState, "phase" | "phaseSince"> {
  return { phase, phaseSince: phase === session.phase ? session.phaseSince : now };
}

function toRunning(session: SessionState, now: number): SessionState {
  return {
    ...session,
    ...enterPhase(session, "running", now),
    stageIndex: RUNNING_STAGE,
    progress: 1,
    runningSince: session.runningSince === null ? now : session.runningSince,
  };
}

/** 后端阶段事件。只在加载阶段生效；阶段下标与进度都只进不退。 */
export function applyPhase(
  session: SessionState,
  event: { taskId: string; phase: LaunchPhaseName; stageIndex: number; download: SessionDownload | null },
  now: number,
): SessionState {
  if (event.taskId !== session.taskId || !isLoadingPhase(session.phase)) return session;
  if (event.phase === "running") return toRunning(session, now);
  const stageIndex = Math.max(session.stageIndex, event.stageIndex);
  const download = event.download === null ? session.download : event.download;
  const phase: SessionPhase = stageIndex < DOWNLOAD_STAGE ? "preparing" : stageIndex === DOWNLOAD_STAGE ? "downloading" : "launching";
  return {
    ...session,
    ...enterPhase(session, phase, now),
    stageIndex,
    download,
    progress: Math.max(session.progress, stageProgress(stageIndex, stageIndex === DOWNLOAD_STAGE ? download : null)),
  };
}

/** launch_game 返回 pid：游戏进程已经起来。退出事件抢先到达时会话已离开加载阶段，不再改回运行。 */
export function sessionLaunched(session: SessionState, taskId: string, now: number): SessionState {
  if (taskId !== session.taskId || !isLoadingPhase(session.phase)) return session;
  return toRunning(session, now);
}

export function sessionFailed(
  session: SessionState,
  taskId: string,
  failure: { code: FailureCode; params: Record<string, string | number> },
  now: number,
): SessionState {
  if (taskId !== session.taskId || !isLoadingPhase(session.phase)) return session;
  return { ...session, ...enterPhase(session, "failed", now), failure };
}

export function sessionCancelled(session: SessionState, taskId: string, now: number): SessionState {
  if (taskId !== session.taskId || !isLoadingPhase(session.phase)) return session;
  return { ...session, ...enterPhase(session, "stopped", now), stopReason: "cancelled" };
}

/**
 * 游戏退出。玩家结束的永远不判崩溃；退出事件可能先于 launch_game 的返回到达，此时会话仍在加载阶段，
 * 按「进过运行」处理（运行起点取此刻），游玩时长以后端写入的为准。
 */
export function sessionExited(session: SessionState, event: { versionId: string; crashed: boolean; killed: boolean }, now: number): SessionState {
  if (event.versionId !== session.instanceId || !isSessionActive(session)) return session;
  const base: SessionState = { ...session, runningSince: session.runningSince === null ? now : session.runningSince, stageIndex: RUNNING_STAGE, progress: 1 };
  if (event.killed) return { ...base, ...enterPhase(session, "stopped", now), stopReason: "killed" };
  if (event.crashed) return { ...base, ...enterPhase(session, "crashed", now), crash: { status: "pending" } };
  return { ...base, ...enterPhase(session, "stopped", now), stopReason: "exited" };
}

export function sessionCrashClue(session: SessionState, instanceId: string, crash: SessionCrash): SessionState {
  if (session.instanceId !== instanceId || session.phase !== "crashed") return session;
  return { ...session, crash };
}

/**
 * 追加日志，内存里只留最近 SESSION_LOG_LIMIT 行；完整日志在后端文件里。
 * 加载期间启动器的 warn 行记到当前阶段的提醒数上（一批日志在 100 ms 内到齐，按到达时所在的阶段算）。
 */
export function appendSessionLogs(session: SessionState, versionId: string, lines: readonly LogLine[]): SessionState {
  if (versionId !== session.instanceId || lines.length === 0) return session;
  const logs = session.logs.concat(lines);
  const warned = isLoadingPhase(session.phase) ? lines.filter((l) => l.source === "launcher" && l.level === "warn").length : 0;
  const stageWarnings = warned === 0 ? session.stageWarnings : session.stageWarnings.map((n, i) => (i === session.stageIndex ? n + warned : n));
  return { ...session, logs: logs.length > SESSION_LOG_LIMIT ? logs.slice(logs.length - SESSION_LOG_LIMIT) : logs, stageWarnings };
}

function sameLine(a: LogLine, b: LogLine): boolean {
  return a.at === b.at && a.source === b.source && a.level === b.level && a.text === b.text;
}

/** earlier 的末尾与 later 的开头有几行是同一批。 */
function overlapLength(earlier: readonly LogLine[], later: readonly LogLine[]): number {
  for (let k = Math.min(earlier.length, later.length); k > 0; k--) {
    const start = earlier.length - k;
    let i = 0;
    while (i < k && sameLine(earlier[start + i], later[i])) i += 1;
    if (i === k) return k;
  }
  return 0;
}

/**
 * 给找回的一局垫上会话日志文件的尾部，日志面板与状态岛才不是空的。内存里已有的是找回之后才推来的新行，
 * 读文件期间推来的那几行文件里可能也有，重合的部分只留一份。只认这一局（taskId），合并后同样只留最近 SESSION_LOG_LIMIT 行。
 */
export function backfillSessionLogs(session: SessionState, taskId: string, earlier: readonly LogLine[]): SessionState {
  if (taskId !== session.taskId || earlier.length === 0) return session;
  const overlap = overlapLength(earlier, session.logs);
  const logs = earlier.slice(0, earlier.length - overlap).concat(session.logs);
  return { ...session, logs: logs.length > SESSION_LOG_LIMIT ? logs.slice(logs.length - SESSION_LOG_LIMIT) : logs };
}

/** 运行了多少分钟（向下取整）；没进过运行为 null。stopped 时以进入 stopped 的时刻为终点。 */
export function sessionPlayedMinutes(session: Session, now: number): number | null {
  if (session.runningSince === null) return null;
  const end = session.phase === "running" ? now : session.phaseSince;
  return Math.floor(Math.max(0, end - session.runningSince) / 60_000);
}
