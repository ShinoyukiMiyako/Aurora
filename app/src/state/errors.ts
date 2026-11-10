// 错误进通知正文时的写法：后端原文原样给出，带错误码（XErr、HTTP 状态）时在末尾用全角括号附上。
// 「复制错误信息」要的是完整的一份：错误名与错误码、原文、后端给的原因链与其余结构化细节，贴进反馈里就能定位。

import { dataFormatUnreadableText, gameDirDataTooNewText } from "../copy/data-format";
import { INSTANCE_IN_USE_COPY } from "../copy/flows";
import { instanceBusyFromError, isInstanceBusy } from "../domain/instance-busy";
import { IpcError, isIpcError, UNKNOWN_ERROR_CODE } from "../ipc/errors";
import { DATA_FORMAT_UNREADABLE_ERROR_CODE, GAME_DIR_DATA_TOO_NEW_ERROR_CODE, parseDataFormatUnreadable, parseGameDirDataTooNew, type DataFormatUnreadableDto, type GameDirDataTooNewDto } from "../ipc/instances";
import type { UpdateSourceFailureDto, UpdateSourceFailureKind } from "../ipc/system";

function numericDetail(detail: unknown, key: string): number | null {
  if (typeof detail !== "object" || detail === null) return null;
  const value = (detail as Record<string, unknown>)[key];
  return typeof value === "number" ? value : null;
}

/** 被别的实例当作基底而被拒时，与禁用提示用同一组文案说是谁在用；其余占用的后端原文已说清在做什么，为 null。 */
function inUseReason(error: IpcError): string | null {
  if (!isInstanceBusy(error)) return null;
  const { usedBy } = instanceBusyFromError(error);
  return usedBy === null ? null : INSTANCE_IN_USE_COPY.reason(usedBy);
}

/** 后端因游戏目录的数据格式拒绝读写：目录被更新的版本用过（too_new），或记数据格式的文件读不懂（unreadable）。 */
export type GameDirDataRejection = { kind: "too_new"; detail: GameDirDataTooNewDto } | { kind: "unreadable"; detail: DataFormatUnreadableDto };

/**
 * 游戏目录的数据格式拒绝与它解析好的 detail；别的错误为 null。页面与流程不能引用 ipc，经这里认这两个错误码，
 * detail 的校验只在 ipc 里写一份。detail 不成形是前后端契约破坏，抛出。
 */
export function gameDirDataRejectionOf(error: unknown): GameDirDataRejection | null {
  if (!isIpcError(error)) return null;
  const where = `${error.code} 的 detail`;
  switch (error.code) {
    case GAME_DIR_DATA_TOO_NEW_ERROR_CODE:
      return { kind: "too_new", detail: parseGameDirDataTooNew(error.detail, where) };
    case DATA_FORMAT_UNREADABLE_ERROR_CODE:
      return { kind: "unreadable", detail: parseDataFormatUnreadable(error.detail, where) };
    default:
      return null;
  }
}

/**
 * 游戏目录的数据格式比这一版新、或记号读不懂时，界面不显示格式号，正文按 detail 写出是哪个目录、被哪一版用过，
 * 不用后端原文。其余错误为 null。
 */
function dataFormatReason(error: IpcError): string | null {
  const rejection = gameDirDataRejectionOf(error);
  if (rejection === null) return null;
  switch (rejection.kind) {
    case "too_new":
      return gameDirDataTooNewText(rejection.detail);
    case "unreadable":
      return dataFormatUnreadableText(rejection.detail);
  }
}

/** 网络层失败的种类：connect（DNS 解析失败、连接被拒、TLS 握手失败）或 timeout。 */
export type NetworkFailure = "connect" | "timeout";

/** 后端在原因链里认出网络层失败时标在 detail.network 里的种类；其余错误为 null。 */
export function networkFailureOf(error: unknown): NetworkFailure | null {
  if (!isIpcError(error)) return null;
  const { detail } = error;
  if (typeof detail !== "object" || detail === null) return null;
  const kind = (detail as Record<string, unknown>).network;
  return kind === "connect" || kind === "timeout" ? kind : null;
}

// 写成以种类为键的表：后端加了种类、IPC 类型跟着加时，这里漏写会在编译期报出来
const SOURCE_FAILURE_KINDS: Readonly<Record<UpdateSourceFailureKind, true>> = { connect: true, timeout: true, http: true, signature: true, too_large: true, other: true };

function isSourceFailure(value: unknown): value is UpdateSourceFailureDto {
  if (typeof value !== "object" || value === null) return false;
  const { source, failure, message, causes } = value as Record<string, unknown>;
  const causesOk = causes === undefined || (Array.isArray(causes) && causes.every((cause) => typeof cause === "string"));
  return typeof source === "string" && typeof failure === "string" && Object.hasOwn(SOURCE_FAILURE_KINDS, failure) && typeof message === "string" && causesOk;
}

/**
 * 自更新下载逐个源的失败：后端在 detail.sources 里按尝试顺序给出。不是后端错误或没有这一项时为空数组，
 * 所以返回空数组只表示「没有这一项」。
 * 前后端同包发布，这一项有却不成形是违约，直接抛出，不当作没有；后端只在至少试过一个源后才汇总，列表为空同样算不成形。
 */
export function sourceFailuresOf(error: unknown): UpdateSourceFailureDto[] {
  if (!isIpcError(error)) return [];
  const { detail } = error;
  if (typeof detail !== "object" || detail === null) return [];
  const { sources } = detail as Record<string, unknown>;
  if (sources === undefined) return [];
  if (!Array.isArray(sources) || sources.length === 0 || !sources.every(isSourceFailure)) throw new Error(`后端错误 ${error.code} 的 detail.sources 不成形：${JSON.stringify(sources)}`);
  return sources;
}

export function describeError(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  if (!isIpcError(error)) return error.message;
  const inUse = inUseReason(error);
  if (inUse !== null) return inUse;
  const dataFormat = dataFormatReason(error);
  if (dataFormat !== null) return dataFormat;
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

/** 后端文件读写失败的正文：只写路径，原因在 detail.causes。几个 crate 的 Io 错误都是这一句，错误码却不同。 */
const IO_FAILURE_PREFIX = "文件 IO 失败: ";

function causesOf(detail: unknown): string[] {
  if (typeof detail !== "object" || detail === null) return [];
  const { causes } = detail as Record<string, unknown>;
  return Array.isArray(causes) ? causes.map(String) : [];
}

/**
 * 批量动作里一项失败的原因。文件读写失败的正文只说了是哪个文件，后端借 Io 错误承载的拒绝原因和系统错误都在原因链里，
 * 路径又逐项不同，按正文比较时同一种原因也成了「各不相同」。不按错误码判：启停改名失败报的是 mod_platform_failed，
 * 同一个码下还有 HTTP、JSON 这些正文说得清的失败。其余错误的原因链只是更底层的细节，照写正文。
 */
export function itemFailureReason(record: { code: string; message: string; detail?: unknown }): string {
  if (!record.message.startsWith(IO_FAILURE_PREFIX)) return record.message;
  const causes = causesOf(record.detail);
  return causes.length === 0 ? record.message : causes.join("：");
}

/** 任务失败记录用的 { code, message }：前端自身的 Error 没有错误码，记为 unknown。 */
export function errorRecord(error: unknown): { code: string; message: string } {
  if (isIpcError(error)) {
    const inUse = inUseReason(error);
    return { code: error.code, message: inUse === null ? error.message : inUse };
  }
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
