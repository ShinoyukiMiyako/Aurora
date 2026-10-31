// 诊断：最近一次崩溃报告、对一段日志做崩溃诊断、最近一次启动日志，以及前端自己的诊断日志。

import { invoke } from "./bridge";
import type { LogLineDto } from "./launch";

export type CrashCategory =
  | "java_version_mismatch"
  | "out_of_memory"
  | "missing_dependency"
  | "mixin_failure"
  | "duplicate_mod"
  | "native_library_missing"
  | "graphics_driver"
  | "corrupted_jar";

/** 一条线索。summary / advice 是后端的中文说明，只供复制与排查；界面文案按 category 生成。 */
export interface CrashClueDto {
  category: CrashCategory;
  summary: string;
  advice: string;
  /** 从日志提取的附加信息（缺失的 Mod id、class file version 等）。 */
  detail: string | null;
  /** 命中的那一行，过长已裁剪。 */
  matched: string;
  /** 命中行在日志里的行号，从 1 起。 */
  line: number;
  /** 命中行之前的至多两行，按顺序。 */
  context: string[];
}

/** 日志点名的 Mod；file_name 是 mods 目录里对得上的文件，对不上为 null。 */
export interface CrashSuspectDto {
  mod_id: string;
  file_name: string | null;
}

export interface JavaUsedDto {
  major: number;
  path: string;
  is_64bit: boolean;
}

/** 不阻断启动、但值得在诊断里引用的提醒。game_path：游戏路径含非 ASCII 或 !。 */
export type LaunchWarningCode = "game_path";

export interface CrashReportDto {
  /** 游戏退出的 Unix 毫秒；对粘贴文本的诊断为 null。 */
  at: number | null;
  exit_code: number | null;
  session_started_at: number | null;
  /** 那一次会话日志的路径；日志已被滚动淘汰或这是对粘贴文本的诊断时为 null。 */
  log_path: string | null;
  diagnoses: CrashClueDto[];
  suspects: CrashSuspectDto[];
  java: JavaUsedDto | null;
  max_memory_mb: number | null;
  warnings: LaunchWarningCode[];
}

export type SessionOutcome = "exited" | "crashed" | "killed" | "failed" | "cancelled";

export interface LaunchLogDto {
  path: string;
  /** 会话开始的 Unix 毫秒。 */
  started_at: number;
  /** 最后至多 5000 行，按时间顺序。 */
  lines: LogLineDto[];
  /** 更早被省略的行数。 */
  omitted: number;
  /** 会话还在进行、或启动器在会话中途退出时为 null。 */
  ended: { at: number; outcome: SessionOutcome } | null;
}

export type DiagnosticLevel = "debug" | "info" | "warn" | "error";

/** 该实例最近一次的崩溃报告；从没崩溃过为 null。实例不存在时以 version_not_installed 拒绝。 */
export const lastCrash = (versionId: string): Promise<CrashReportDto | null> => invoke<CrashReportDto | null>("last_crash", { versionId });


/** 该实例最近一次启动的日志；从没启动过为 null。 */
export const lastLaunchLog = (versionId: string): Promise<LaunchLogDto | null> => invoke<LaunchLogDto | null>("last_launch_log", { versionId });

/** 把一条前端诊断写进启动器日志文件，不弹任何界面。没有附加字段时传 {}。 */
export const logDiagnostic = (level: DiagnosticLevel, message: string, fields: Record<string, unknown>): Promise<void> =>
  invoke<void>("log_diagnostic", { level, message, fields });
