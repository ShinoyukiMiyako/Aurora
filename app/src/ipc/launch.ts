// 启动与结束游戏、启动阶段与退出事件、启动日志的实时推送，以及游玩统计。
// 内存、Java、JVM 参数与分辨率由后端按实例设置与全局设置解析，启动只给实例、账户与取消句柄。

import { invoke, listen, type UnlistenFn } from "./bridge";
import { IpcError } from "./errors";

/** 启动阶段推进与阶段 3 的下载进度。 */
export const LAUNCH_PHASE_EVENT = "aurora://launch-phase";
/** 游戏进程退出；游玩时长、上次游玩与崩溃报告在推送前已由后端写好。 */
export const GAME_EXIT_EVENT = "aurora://game-exit";
/** 启动器日志与游戏输出，成批推送。 */
export const GAME_LOG_EVENT = "aurora://game-log";
/** 游戏退出后的自动备份做完。开着自动备份时每局都推（这局没进过存档时两个列表都空），关着时不推。 */
export const WORLD_BACKUP_EVENT = "aurora://world-backup";

/** 已有游戏在加载或运行时 launchGame 的错误码，detail 为 BusyDetail。同一时间只运行一个游戏。 */
export const BUSY_ERROR_CODE = "busy";

export interface BusyDetail {
  /** 占用者的实例 id。 */
  version_id: string;
  phase: "loading" | "running";
}

/** 账户二选一：账户库里的账户，或临时离线角色名；另一项显式传 null。 */
export type LaunchAccountArgs = { accountUuid: string; offlineName: null } | { accountUuid: null; offlineName: string };

/**
 * 直达游戏（Quick Play）：启动后直接进入一个单人世界，或直接加入一台服务器。
 * world_dir_name 是 saves/ 下的世界文件夹名（不是 level.dat 里的世界名）；address 是服务器地址原文，
 * 不写端口时交给游戏按它自己的规则解析。
 */
export type QuickPlayArg = { kind: "singleplayer"; world_dir_name: string } | { kind: "multiplayer"; address: string };

export type LaunchArgs = {
  /** 只作取消句柄（cancelTask）：启动不进下载队列，阶段事件以它标明属于哪一次启动。 */
  taskId: string;
  versionId: string;
  /**
   * 这一局以离线方式进单人：不刷新登录、不注入有效令牌。只在这个账户上一次启动因验证不可用而失败时放行，
   * 判据是后端自己记下的那次失败码，不信前端；放行一次即消耗那条记录。普通启动传 false。
   */
  offlineFallback: boolean;
  /** 普通启动显式传 null：入口不能因为漏传而悄悄变成普通启动。 */
  quickPlay: QuickPlayArg | null;
} & LaunchAccountArgs;

/** 实例的版本不支持这种直达方式，detail 为 QuickPlayUnsupportedDetail。 */
export const QUICK_PLAY_UNSUPPORTED_CODE = "quick_play_unsupported";

export interface QuickPlayUnsupportedDetail {
  version_id: string;
  mode: "singleplayer" | "multiplayer";
}

/** 启动成功：游戏进程已经起来。 */
export interface LaunchedDto {
  pid: number | null;
  /** 这一局以离线方式进单人（未经账户验证）。 */
  offline: boolean;
}

/** 降级启动被拒绝时 invalid_argument 的 detail.field。 */
export const OFFLINE_FALLBACK_FIELD = "offlineFallback";

const OFFLINE_FALLBACK_REFUSALS = ["offline_account", "relogin_required", "no_recent_failure"] as const;

/**
 * offline_account：离线账户本来就不经验证；relogin_required：账户已被判定需要重新登录，或上次失败就是登录失效；
 * no_recent_failure：后端没有这个账户最近一次验证失败的记录（启动器重开过，或那条记录已用掉）。
 */
export type OfflineFallbackRefusal = (typeof OFFLINE_FALLBACK_REFUSALS)[number];

export interface OfflineFallbackRefusedDetail {
  field: typeof OFFLINE_FALLBACK_FIELD;
  reason: OfflineFallbackRefusal;
  /** 被拒绝的账户名。 */
  account: string;
}

function isOfflineFallbackRefusal(value: unknown): value is OfflineFallbackRefusal {
  return typeof value === "string" && (OFFLINE_FALLBACK_REFUSALS as readonly string[]).includes(value);
}

/**
 * 降级启动被拒绝时取出细节；不是这类拒绝为 null。field 对上了而 reason 或 account 不合契约时直接抛出：
 * 前后端随同一个安装包发布，这说明发布有缺陷，不能当成别的错误放过去。
 */
export function offlineFallbackRefusal(error: unknown): OfflineFallbackRefusedDetail | null {
  if (!(error instanceof IpcError) || error.code !== "invalid_argument") return null;
  const detail = error.detail;
  if (typeof detail !== "object" || detail === null) return null;
  const fields = detail as Record<string, unknown>;
  if (fields.field !== OFFLINE_FALLBACK_FIELD) return null;
  if (!isOfflineFallbackRefusal(fields.reason) || typeof fields.account !== "string") {
    throw new Error(`降级启动的拒绝细节不合契约：${JSON.stringify(detail)}`);
  }
  return { field: OFFLINE_FALLBACK_FIELD, reason: fields.reason, account: fields.account };
}

/** 加载阶段的分段；stage_index 0-2 为 preparing，3 为 downloading，4-6 为 launching，7 为 running。 */
export type LaunchPhaseName = "preparing" | "downloading" | "launching" | "running";

/** 阶段 3 的下载进度快照，字段与 core-event 的下载进度一致。 */
export interface LaunchDownloadDto {
  total: number;
  finished: number;
  /** 有效字节：已就绪的字节，不含重传，失败的文件退回 0；平台声明的大小与实际不符时仍可能越过 total_bytes，画进度时封顶到 1。 */
  bytes: number;
  /** 声明大小之和；有任一文件大小未知时为 null。 */
  total_bytes: number | null;
  /** 瞬时速度，字节每秒。 */
  speed: number;
}

/** stage_index 对应八阶段表，同一次启动内单调不减；只有阶段 3 的进度快照带 download。 */
export interface LaunchPhaseEvent {
  task_id: string;
  phase: LaunchPhaseName;
  stage_index: number;
  download?: LaunchDownloadDto;
}

export type LogSourceName = "game" | "launcher";
export type LogLevelName = "info" | "warn" | "error";

/** 一行日志。游戏行的级别由后端按 log4j 级别标记推断，与读回会话日志时的规则一致。 */
export interface LogLineDto {
  /** Unix 毫秒。 */
  at: number;
  source: LogSourceName;
  level: LogLevelName;
  text: string;
}

export interface GameLogEvent {
  version_id: string;
  /** 按发生顺序排列。 */
  lines: LogLineDto[];
}

export interface GameExitEvent {
  version_id: string;
  exit_code: number | null;
  /** 退出码非 0、拿不到退出码或日志有崩溃标记，且不是玩家结束的。 */
  crashed: boolean;
  /** 玩家结束了游戏。 */
  killed: boolean;
  duration_ms: number;
}

export interface WorldBackupFailureDto {
  /** 存档文件夹名；整次自动备份没能开始（例如工作目录解析失败）时为 "*"。 */
  world: string;
  error: { code: string; message: string; detail?: unknown };
}

export interface WorldBackupEvent {
  instance_id: string;
  /** 备份成了的存档文件夹名。 */
  backed_up: string[];
  failed: WorldBackupFailureDto[];
}

/** 两端都含的本地日期 YYYY-MM-DD，起点不晚于终点。 */
export interface PlayRangeArgs {
  from: string;
  to: string;
}

export interface InstanceMinutesDto {
  version_id: string;
  minutes: number;
}

export interface PlayDayDto {
  /** 本地日期 YYYY-MM-DD。 */
  date: string;
  minutes: number;
  /** 当天玩过的实例，分钟多的在前。 */
  instances: InstanceMinutesDto[];
}

export interface PlayStatsDto {
  from: string;
  to: string;
  /** 区间内有游玩的日子，按日期升序；没玩的日子不列出。 */
  days: PlayDayDto[];
  /** 区间合计：先合计毫秒再折算，可能大于各日分钟之和。 */
  total_minutes: number;
  /** 区间内各实例合计，分钟多的在前。 */
  instances: InstanceMinutesDto[];
}

/**
 * 启动一个实例。失败时 IpcError 的 code 为启动失败码（java_missing 等，插值参数平铺在 detail 里，
 * 原因链在 detail.causes）、BUSY_ERROR_CODE、cancelled，或门面的通用错误码。带 quickPlay 时还可能是
 * QUICK_PLAY_UNSUPPORTED_CODE、world_not_found（世界文件夹不在了），或 invalid_argument（地址不合法，detail.address）。
 * 降级启动被拒绝时 code 为 invalid_argument，detail 为 OfflineFallbackRefusedDetail（用 offlineFallbackRefusal 取出）。
 */
export const launchGame = (args: LaunchArgs): Promise<LaunchedDto> =>
  invoke<LaunchedDto>("launch_game", {
    taskId: args.taskId,
    versionId: args.versionId,
    accountUuid: args.accountUuid,
    offlineFallback: args.offlineFallback,
    offlineName: args.offlineName,
    quickPlay: args.quickPlay,
  });

/** 结束运行中的游戏；结局经 GAME_EXIT_EVENT 推送。没有运行中的游戏时为空操作，加载中的启动用 cancelTask 取消。 */
export const stopGame = (): Promise<void> => invoke<void>("stop_game");

/** 当前游戏目录的游玩统计：记录按游戏目录分开，换了游戏目录结果随之不同。 */
export const playStats = (range: PlayRangeArgs): Promise<PlayStatsDto> => invoke<PlayStatsDto>("play_stats", { range: { from: range.from, to: range.to } });

export const onLaunchPhase = (handler: (event: LaunchPhaseEvent) => void): Promise<UnlistenFn> => listen<LaunchPhaseEvent>(LAUNCH_PHASE_EVENT, handler);

export const onGameExit = (handler: (event: GameExitEvent) => void): Promise<UnlistenFn> => listen<GameExitEvent>(GAME_EXIT_EVENT, handler);

export const onWorldBackup = (handler: (event: WorldBackupEvent) => void): Promise<UnlistenFn> => listen<WorldBackupEvent>(WORLD_BACKUP_EVENT, handler);

export const onGameLog = (handler: (event: GameLogEvent) => void): Promise<UnlistenFn> => listen<GameLogEvent>(GAME_LOG_EVENT, handler);
