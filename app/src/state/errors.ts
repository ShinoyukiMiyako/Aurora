// 错误进通知正文时的写法：后端原文原样给出，带错误码（XErr、HTTP 状态）时在末尾用全角括号附上。
// 「复制错误信息」要的是完整的一份：错误名与错误码、原文、后端给的原因链与其余结构化细节，贴进反馈里就能定位。

import { IpcError, isIpcError, UNKNOWN_ERROR_CODE } from "../ipc/errors";

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

/** 命令返回值里内嵌的错误（与命令错误同形状，例如资讯里某一来源的失败），按 describeError 的规则写成一句。 */
export function describeErrorRecord(record: { code: string; message: string; detail?: unknown }): string {
  return describeError(new IpcError(record.code, record.message, record.detail));
}

/** 任务失败记录用的 { code, message }：前端自身的 Error 没有错误码，记为 unknown。 */
export function errorRecord(error: unknown): { code: string; message: string } {
  if (isIpcError(error)) return { code: error.code, message: error.message };
  if (error instanceof Error) return { code: UNKNOWN_ERROR_CODE, message: error.message };
  return { code: UNKNOWN_ERROR_CODE, message: String(error) };
}

/**
 * 后端错误的完整文本：首行「IpcError(<code>): <原文>」，之后每条原因一行，其余结构化细节（路径、地址、XErr 等）
 * 以 JSON 附在最后。登录弹窗这类只存了 code、message、detail 的状态也用它。
 */
export function errorDetailOf(code: string, message: string, detail: unknown): string {
  const lines = [`IpcError(${code}): ${message}`];
  if (typeof detail === "object" && detail !== null && !Array.isArray(detail)) {
    const { causes, ...rest } = detail as Record<string, unknown>;
    if (Array.isArray(causes)) for (const cause of causes) lines.push(`原因：${String(cause)}`);
    if (Object.keys(rest).length > 0) lines.push(`详情：${JSON.stringify(rest)}`);
  } else if (detail !== undefined && detail !== null) {
    lines.push(`详情：${JSON.stringify(detail)}`);
  }
  return lines.join("\n");
}

/** 「复制错误信息」的文本：后端错误见 errorDetailOf；前端自身的错误为「<错误名>: <错误信息>」。 */
export function errorDetail(error: unknown): string {
  if (isIpcError(error)) return errorDetailOf(error.code, error.message, error.detail);
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return String(error);
}
