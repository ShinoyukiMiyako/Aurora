// 外观在假后端里的写入校验。非法输入与后端 set_appearance 的测试（app/src-tauri/src/commands/appearance.rs）
// 是同一组：两边都报 invalid_argument，消息带同样的线索，整次写入不生效。
import { beforeEach, describe, expect, it } from "vitest";
import { getAppearance } from "./appearance";
import { invoke } from "./bridge";
import { IpcError } from "./errors";
import { resetMocks } from "./mock";

const DEFAULTS = { mode: "day", accent: "sakura", petals: true, panorama: false, reduce_motion: false, cover_background: "texture" };

const INVALID_PATCHES: [patch: unknown, mentions: string][] = [
  [{ accent: "pink" }, "pink"],
  [{ mode: "Night" }, "Night"],
  [{ reduceMotion: true }, "reduceMotion"],
  [{ reduceMotion: null }, "reduceMotion"],
  [{ petals: "yes" }, "boolean"],
  // 字段给 null 不算「不动」：键不出现才是
  [{ mode: null }, "mode"],
  [{ accent: null }, "accent"],
  [{ petals: null }, "petals"],
  [{ panorama: null }, "panorama"],
  [{ reduce_motion: null }, "reduce_motion"],
  [{ cover_background: null }, "cover_background"],
  [{ mode: "night", petals: null }, "petals"],
  // 后端的结构体收数组形式，必须在命令里先挡住
  [["night", null, null, null, null, null], "必须是对象"],
  [["night"], "必须是对象"],
  [[true], "必须是对象"],
  [null, "必须是对象"],
  ["mode", "必须是对象"],
  [1, "必须是对象"],
];

beforeEach(() => {
  resetMocks();
});

describe("外观的假后端", () => {
  it("非对象、未知字段、字段给 null、取值非法都报 invalid_argument，整次不生效", async () => {
    for (const [patch, mentions] of INVALID_PATCHES) {
      const label = JSON.stringify(patch);
      const error = await invoke("set_appearance", { patch }).catch((e: unknown) => e);
      expect(error, label).toBeInstanceOf(IpcError);
      expect((error as IpcError).code, label).toBe("invalid_argument");
      expect((error as IpcError).message, label).toMatch(/^外观设置不合法：/);
      expect((error as IpcError).message, label).toContain(mentions);
    }
    expect(await getAppearance()).toEqual(DEFAULTS);
  });
});
