// 错误进通知正文时的写法：后端原文原样给出，带错误码（XErr、HTTP 状态）时在末尾用全角括号附上。

import { isIpcError, UNKNOWN_ERROR_CODE } from "../ipc/errors";

function numericDetail(detail: unknown, key: string): number | null {
  if (typeof detail !== "object" || detail === null) return null;
  const value = (detail as Record<string, unknown>)[key];
  return typeof value === "number" ? value : null;
}

export function describeError(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  if (!isIpcError(error)) return error.message;
  const xerr = numericDetail(error.detail, "xerr");
  if (xerr !== null) return `${error.message}（XErr ${xerr}）`;
  const status = numericDetail(error.detail, "status");
  if (status !== null) return `${error.message}（${status}）`;
  return error.message;
}

/** 任务失败记录用的 { code, message }：前端自身的 Error 没有错误码，记为 unknown。 */
export function errorRecord(error: unknown): { code: string; message: string } {
  if (isIpcError(error)) return { code: error.code, message: error.message };
  if (error instanceof Error) return { code: UNKNOWN_ERROR_CODE, message: error.message };
  return { code: UNKNOWN_ERROR_CODE, message: String(error) };
}
