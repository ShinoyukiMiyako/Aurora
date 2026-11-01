import type { AppearanceDto } from "../../appearance";
import { IpcError } from "../../errors";
import type { MockArgs, MockHandlers, MockPersist } from "../types";

const DEFAULTS: AppearanceDto = { mode: "day", accent: "sakura", petals: true, panorama: false, reduce_motion: false };

let current: AppearanceDto = { ...DEFAULTS };

// ipc/ 只能以类型方式引用领域模型，合法取值在这里按 DTO 类型各列一份。
const MODES: readonly AppearanceDto["mode"][] = ["day", "night"];
const ACCENTS: readonly AppearanceDto["accent"][] = ["sakura", "amethyst", "moss"];
const BOOLEAN_KEYS = ["petals", "panorama", "reduce_motion"] as const;

// 与后端对齐：缺 patch 参数是 Tauri 自身的参数错误（纯字符串，前端归为 unknown）；patch 不是对象、
// 含未知字段或非法取值由命令自己反序列化失败，报 invalid_argument。两种情况整次写入都不生效。
function parsePatch(args: MockArgs): Partial<AppearanceDto> {
  const raw = args.patch;
  if (raw === undefined) throw new IpcError("unknown", "invalid args `patch` for command `set_appearance`: missing required key patch");
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw invalid("patch 必须是对象");
  const patch: Partial<AppearanceDto> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (key === "mode") {
      if (!MODES.includes(value as never)) throw invalid(`unknown variant \`${String(value)}\` for mode`);
      patch.mode = value as AppearanceDto["mode"];
    } else if (key === "accent") {
      if (!ACCENTS.includes(value as never)) throw invalid(`unknown variant \`${String(value)}\` for accent`);
      patch.accent = value as AppearanceDto["accent"];
    } else if ((BOOLEAN_KEYS as readonly string[]).includes(key)) {
      if (typeof value !== "boolean") throw invalid(`invalid type for ${key}, expected a boolean`);
      patch[key as (typeof BOOLEAN_KEYS)[number]] = value;
    } else {
      throw invalid(`unknown field \`${key}\` in appearance patch`);
    }
  }
  return patch;
}

function invalid(reason: string): IpcError {
  return new IpcError("invalid_argument", `外观设置不合法：${reason}`);
}

export const handlers: MockHandlers = {
  get_appearance: () => current,
  set_appearance: (args) => {
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
    current = data as AppearanceDto;
  },
};
