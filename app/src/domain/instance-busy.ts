// instance_busy 的 detail 到领域形状。detail 形状不对、取值不认识、inherited 却没说是谁在用，都说明前后端的
// 错误契约被破坏，一律抛错，不回落成笼统的「实例正忙」把缺口藏起来。

import { IpcError } from "../ipc/errors";
import { BUSY_ACTIVITIES, type BusyActivity, type InstanceBusy } from "./types";

/** 实例被占着时后端报的错误码。 */
export const INSTANCE_BUSY_ERROR_CODE = "instance_busy";

function isBusyActivity(value: unknown): value is BusyActivity {
  return typeof value === "string" && (BUSY_ACTIVITIES as readonly string[]).includes(value);
}

/** 是否是 instance_busy 拒绝。 */
export function isInstanceBusy(error: unknown): error is IpcError {
  return error instanceof IpcError && error.code === INSTANCE_BUSY_ERROR_CODE;
}

/** 从 instance_busy 拒绝里读出被占着的实例、它在做的事与（inherited 时）正以它为基底的实例。 */
export function instanceBusyFromError(error: IpcError): InstanceBusy {
  if (error.code !== INSTANCE_BUSY_ERROR_CODE) throw new Error(`不是 ${INSTANCE_BUSY_ERROR_CODE}：${error.code}`);
  const detail = error.detail;
  if (typeof detail !== "object" || detail === null) throw new Error(`instance_busy 没带 detail：${error.message}`);
  const { id, activity, used_by: usedBy } = detail as Record<string, unknown>;
  if (typeof id !== "string") throw new Error(`instance_busy 的 detail.id 不是字符串：${String(id)}`);
  if (!isBusyActivity(activity)) throw new Error(`未知的实例占用：${String(activity)}`);
  if (activity === "inherited") {
    if (typeof usedBy !== "string") throw new Error(`实例 ${id} 被当作基底占着，detail 却没说是哪个实例在用：${error.message}`);
    return { id, activity, usedBy };
  }
  if (usedBy !== undefined) throw new Error(`实例 ${id} 的占用 ${activity} 不该带 used_by：${String(usedBy)}`);
  return { id, activity, usedBy: null };
}
