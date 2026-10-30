// 诊断的假后端：崩溃报告与启动日志取自启动 mock 的会话记录；粘贴日志的诊断只认几条最常见的规则，
// 足够在浏览器里看出报告的形状；前端诊断日志记在内存里供测试检查。

import type { CrashCategory, CrashClueDto, CrashReportDto, CrashSuspectDto, DiagnosticLevel } from "../../diagnostics";
import { IpcError } from "../../errors";
import type { MockArgs, MockHandlers } from "../types";
import { mockCrashReport, mockLaunchLog } from "./launch";

const LEVELS: readonly DiagnosticLevel[] = ["debug", "info", "warn", "error"];

const RULES: { category: CrashCategory; patterns: string[]; summary: string; advice: string }[] = [
  {
    category: "java_version_mismatch",
    patterns: ["unsupportedclassversionerror", "class file version"],
    summary: "Java 版本与游戏或 Mod 不匹配",
    advice: "改用目标版本要求的 Java。",
  },
  {
    category: "out_of_memory",
    patterns: ["outofmemoryerror", "java heap space"],
    summary: "内存不足",
    advice: "调高最大内存（-Xmx），减少同时加载的 Mod 与高清材质。",
  },
  {
    category: "missing_dependency",
    patterns: ["which is missing", "incompatible mod set"],
    summary: "缺少前置 Mod 或依赖版本不满足",
    advice: "根据日志补齐缺失的前置 Mod，或把相关 Mod 调整到彼此兼容的版本。",
  },
];

const MOD_ID = /\bmod '[^']+' \(([a-z0-9_-]+)\)/gi;

export interface MockDiagnosticEntry {
  level: DiagnosticLevel;
  message: string;
  fields: Record<string, unknown>;
}

let diagnosticLog: MockDiagnosticEntry[] = [];

/** 测试检查用：已写下的前端诊断。 */
export function mockDiagnosticLog(): MockDiagnosticEntry[] {
  return diagnosticLog.map((entry) => ({ ...entry, fields: { ...entry.fields } }));
}

function argError(command: string, key: string): IpcError {
  return new IpcError("unknown", `invalid args \`${key}\` for command \`${command}\``);
}

function stringArg(command: string, args: MockArgs, key: string): string {
  const value = args[key];
  if (typeof value !== "string") throw argError(command, key);
  return value;
}

function diagnose(text: string): CrashReportDto {
  const lines = text.split(/\r?\n/);
  const diagnoses: CrashClueDto[] = [];
  for (const rule of RULES) {
    const index = lines.findIndex((l) => rule.patterns.some((p) => l.toLowerCase().includes(p)));
    if (index < 0) continue;
    diagnoses.push({
      category: rule.category,
      summary: rule.summary,
      advice: rule.advice,
      detail: null,
      matched: lines[index].trim(),
      line: index + 1,
      context: lines.slice(Math.max(0, index - 2), index),
    });
  }
  // 与后端一样：没有任何崩溃迹象时不点名 Mod，正常启动的日志同样会列出 Mod。
  const suspects: CrashSuspectDto[] = [];
  if (diagnoses.length > 0) {
    for (const match of text.matchAll(MOD_ID)) {
      const id = match[1].toLowerCase();
      if (!suspects.some((s) => s.mod_id === id)) suspects.push({ mod_id: id, file_name: null });
    }
  }
  return { at: null, exit_code: null, session_started_at: null, log_path: null, diagnoses, suspects, java: null, max_memory_mb: null, warnings: [] };
}

export const handlers: MockHandlers = {
  last_crash: (args) => mockCrashReport(stringArg("last_crash", args, "versionId")),
  diagnose_crash: (args) => {
    stringArg("diagnose_crash", args, "versionId");
    return diagnose(stringArg("diagnose_crash", args, "logText"));
  },
  last_launch_log: (args) => mockLaunchLog(stringArg("last_launch_log", args, "versionId")),
  log_diagnostic: (args) => {
    const level = stringArg("log_diagnostic", args, "level");
    const message = stringArg("log_diagnostic", args, "message");
    const fields = args.fields;
    if (typeof fields !== "object" || fields === null || Array.isArray(fields)) throw argError("log_diagnostic", "fields");
    if (!LEVELS.includes(level as DiagnosticLevel)) {
      throw new IpcError("invalid_argument", `诊断日志级别 ${level} 无效，只认 debug / info / warn / error`, { level });
    }
    diagnosticLog.push({ level: level as DiagnosticLevel, message, fields: { ...(fields as Record<string, unknown>) } });
  },
};

export function reset(): void {
  diagnosticLog = [];
}
