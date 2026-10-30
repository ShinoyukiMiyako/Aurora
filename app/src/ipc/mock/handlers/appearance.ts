import type { AppearanceDto } from "../../appearance";
import { IpcError } from "../../errors";
import type { MockArgs, MockHandlers } from "../types";

const DEFAULTS: AppearanceDto = { mode: "day", accent: "sakura", petals: true, panorama: false, reduce_motion: false };

let current: AppearanceDto = { ...DEFAULTS };

// ipc/ 只能以类型方式引用领域模型，合法取值在这里按 DTO 类型各列一份。
const MODES: readonly AppearanceDto["mode"][] = ["day", "night"];
const ACCENTS: readonly AppearanceDto["accent"][] = ["sakura", "amethyst", "moss"];
const BOOLEAN_KEYS = ["petals", "panorama", "reduce_motion"] as const;

// 与后端 serde 的行为对齐：未知字段与非法枚举都在反序列化阶段失败，整次写入不生效。
function parsePatch(args: MockArgs): Partial<AppearanceDto> {
  const raw = args.patch;
  if (typeof raw !== "object" || raw === null) throw new IpcError("unknown", "invalid args `patch` for command `set_appearance`");
  const patch: Partial<AppearanceDto> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (key === "mode") {
      if (!MODES.includes(value as never)) throw new IpcError("unknown", `unknown variant \`${String(value)}\` for mode`);
      patch.mode = value as AppearanceDto["mode"];
    } else if (key === "accent") {
      if (!ACCENTS.includes(value as never)) throw new IpcError("unknown", `unknown variant \`${String(value)}\` for accent`);
      patch.accent = value as AppearanceDto["accent"];
    } else if ((BOOLEAN_KEYS as readonly string[]).includes(key)) {
      if (typeof value !== "boolean") throw new IpcError("unknown", `invalid type for ${key}, expected a boolean`);
      patch[key as (typeof BOOLEAN_KEYS)[number]] = value;
    } else {
      throw new IpcError("unknown", `unknown field \`${key}\` in appearance patch`);
    }
  }
  return patch;
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
