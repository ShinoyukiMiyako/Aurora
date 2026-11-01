// 诊断：最近一次崩溃报告、最近一次启动日志，以及前端自己的诊断日志。

import { invoke } from "./bridge";
import type { LogLineDto } from "./launch";

export type CrashCategory =
  | "java_version_mismatch"
  | "out_of_memory"
  /** Java 不接受自定义的 JVM 参数。 */
  | "jvm_args_invalid"
  /** 前置 Mod 装着，只是版本不满足要求；缺失才算 missing_dependency。 */
  | "dependency_version_mismatch"
  | "missing_dependency"
  | "mixin_failure"
  | "duplicate_mod"
  | "native_library_missing"
  | "graphics_driver"
  | "corrupted_jar"
  /** Java 建不起本机回环连接。 */
  | "loopback_unavailable"
  | "game_version_mismatch"
  | "optifine_incompatible"
  | "intel_graphics_driver"
  | "missing_language_provider"
  /** 规则一条都没命中时的兜底：JVM 错误头写着原生异常，或退出码是访问冲突、紧急中止。 */
  | "native_crash";

/** 线索从哪里读出来：会话日志、原版崩溃报告（crash-reports/ 下）、JVM 错误日志（hs_err_pid*.log），或只有退出码。 */
export type CrashSource = "session_log" | "crash_report" | "hs_err" | "exit_code";

/** 一条线索。summary / advice 是后端的中文说明，只供复制与排查；界面文案按 category 生成。 */
export interface CrashClueDto {
  category: CrashCategory;
  summary: string;
  advice: string;
  /** 从日志提取的附加信息（缺失的 Mod id、class file version 等）。 */
  detail: string | null;
  /** 命中的那一行，过长已裁剪；来源是 exit_code 时为空串。 */
  matched: string;
  /** 命中行在来源文件里的行号，从 1 起；来源是 exit_code 时为 0。 */
  line: number;
  /** 命中行之前的至多两行，按顺序；来源是 exit_code 时为空。 */
  context: string[];
  source: CrashSource;
}

export type ExitCodeKind = "access_violation" | "stack_buffer_overrun" | "generic_failure";

/** 认得的退出码。summary 是后端的中文说明，只供复制与排查；界面文案按 kind 生成。 */
export interface ExitCodeNoteDto {
  code: number;
  /** 按无符号 32 位写的十六进制，如 0xC0000005。 */
  hex: string;
  kind: ExitCodeKind;
  summary: string;
}

/** 参与这次诊断的文件。 */
export interface ScannedFileDto {
  kind: Exclude<CrashSource, "exit_code">;
  path: string;
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

/**
 * 不阻断启动、但值得在诊断里引用的提醒。game_path：游戏路径含非 ASCII 或 !；onedrive_folder / icloud_folder：游戏目录在同步盘里；
 * long_player_name：角色名超过 16 个字符且游戏不低于 1.20.3；jvm_*：自定义 JVM 参数里的内存写法不对、最小大于最大、最大低于 512 MB。
 */
export type LaunchWarningCode =
  | "game_path"
  | "onedrive_folder"
  | "icloud_folder"
  | "long_player_name"
  | "jvm_memory_unit"
  | "jvm_min_over_max"
  | "jvm_max_too_low";

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
  /** 退出码在对照表里时的说明；退出码为空或不认得时为 null。 */
  exit_code_note: ExitCodeNoteDto | null;
  /** 按扫描顺序（会话日志、崩溃报告、JVM 错误日志）；对粘贴文本的诊断为空。 */
  scanned_files: ScannedFileDto[];
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
