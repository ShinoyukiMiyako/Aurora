// 诊断的假后端：崩溃报告与启动日志取自启动 mock 的会话记录；前端诊断日志记在内存里供测试检查。

import type { DiagnosticLevel } from "../../diagnostics";
import { IpcError } from "../../errors";
import type { MockArgs, MockHandlers } from "../types";
import { mockCrashReport, mockLaunchLog } from "./launch";

const LEVELS: readonly DiagnosticLevel[] = ["debug", "info", "warn", "error"];

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

export const handlers: MockHandlers = {
  last_crash: (args) => mockCrashReport(stringArg("last_crash", args, "versionId")),
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
