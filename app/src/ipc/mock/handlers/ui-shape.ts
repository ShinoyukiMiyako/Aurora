import { IpcError } from "../../errors";
import { RECENT_CARDS_MAX, type UiShapeDto } from "../../ui-shape";
import type { MockArgs, MockHandlers, MockPersist } from "../types";

/** 旧配置里没有 ui_shape 键时后端读成这一份。 */
const DEFAULTS: UiShapeDto = { recent_cards: 0, repair_banner: false };

let current: UiShapeDto = { ...DEFAULTS };

// 与后端对齐：缺 patch 参数是 Tauri 自身的参数错误（纯字符串，前端归为 unknown）；patch 不是对象、含未知字段、
// 类型不对或张数超出上限由命令自己报 invalid_argument。任何一项不合法，整次写入都不生效。
function parsePatch(args: MockArgs): Partial<UiShapeDto> {
  const raw = args.patch;
  if (raw === undefined) throw new IpcError("unknown", "invalid args `patch` for command `set_ui_shape`: missing required key patch");
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw invalid("patch 必须是对象");
  const patch: Partial<UiShapeDto> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (key === "recent_cards") {
      if (typeof value !== "number" || !Number.isInteger(value) || value < 0) throw invalid(`invalid value for recent_cards, expected a non-negative integer: ${String(value)}`);
      if (value > RECENT_CARDS_MAX) throw invalid(`recent_cards ${value} 超过上限 ${RECENT_CARDS_MAX}`);
      patch.recent_cards = value;
    } else if (key === "repair_banner") {
      if (typeof value !== "boolean") throw invalid(`invalid type for repair_banner, expected a boolean`);
      patch.repair_banner = value;
    } else {
      throw invalid(`unknown field \`${key}\` in ui shape patch`);
    }
  }
  return patch;
}

function invalid(reason: string): IpcError {
  return new IpcError("invalid_argument", `界面形状不合法：${reason}`);
}

export const handlers: MockHandlers = {
  get_ui_shape: () => current,
  set_ui_shape: (args) => {
    current = { ...current, ...parsePatch(args) };
    return current;
  },
};

export function reset(): void {
  current = { ...DEFAULTS };
}

export const persist: MockPersist = {
  version: 1,
  snapshot: () => current,
  restore: (data) => {
    current = data as UiShapeDto;
  },
};
