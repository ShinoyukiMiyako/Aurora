// 命令错误的统一形状。后端在命令边界把错误转成 { code, message, detail? }；
// Tauri 自己产生的错误（参数反序列化失败、命令未授权）仍是纯字符串，这里统一包成 code "unknown"，
// 让界面层只需按 code 分支（取消、失败码、登录错误），message 原样进 Toast 正文。

export class IpcError extends Error {
  readonly code: string;
  /** 后端附带的结构化细节（XErr 码、HTTP 状态等）；没有附带时为 undefined。 */
  readonly detail: unknown;

  constructor(code: string, message: string, detail?: unknown) {
    super(message);
    this.name = "IpcError";
    this.code = code;
    this.detail = detail;
  }
}

/** 错误以纯字符串到达（Tauri 自身的参数或权限错误）时使用的错误码。 */
export const UNKNOWN_ERROR_CODE = "unknown";
/** 长任务被 cancel_task 取消时后端返回的错误码。 */
export const CANCELLED_ERROR_CODE = "cancelled";

function isErrorShape(raw: unknown): raw is { code: string; message: string; detail?: unknown } {
  if (typeof raw !== "object" || raw === null) return false;
  const r = raw as Record<string, unknown>;
  return typeof r.code === "string" && typeof r.message === "string";
}

/**
 * 把 invoke 的 rejection 归一成 IpcError。
 * 前端自身抛出的 Error（编程错误、mock 未实现）原样返回，保留调用栈，不伪装成后端错误。
 */
export function toIpcError(raw: unknown): Error {
  if (raw instanceof Error) return raw;
  if (typeof raw === "string") return new IpcError(UNKNOWN_ERROR_CODE, raw);
  if (isErrorShape(raw)) return new IpcError(raw.code, raw.message, raw.detail);
  // 形状不符说明后端违反了错误契约：照样往上抛，正文给出原始值，便于定位是哪个命令。
  return new IpcError(UNKNOWN_ERROR_CODE, `后端返回了无法识别的错误：${JSON.stringify(raw)}`, raw);
}

export function isIpcError(error: unknown): error is IpcError {
  return error instanceof IpcError;
}

export function isCancelled(error: unknown): boolean {
  return isIpcError(error) && error.code === CANCELLED_ERROR_CODE;
}
