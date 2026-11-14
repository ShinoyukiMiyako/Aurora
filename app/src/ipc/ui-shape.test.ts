// 界面形状在假后端里的读写：校验规则、错误码与「整次不生效」都照后端的 get_ui_shape / set_ui_shape。
import { beforeEach, describe, expect, it } from "vitest";
import { invoke } from "./bridge";
import { IpcError } from "./errors";
import { resetMocks } from "./mock";
import { getUiShape, RECENT_CARDS_MAX, setUiShape } from "./ui-shape";

async function rejection(promise: Promise<unknown>): Promise<IpcError> {
  const error = await promise.catch((e: unknown) => e);
  expect(error).toBeInstanceOf(IpcError);
  return error as IpcError;
}

beforeEach(() => {
  resetMocks();
});

describe("界面形状的假后端", () => {
  it("没记过时读出 0 张、没有修复横幅", async () => {
    expect(await getUiShape()).toEqual({ recent_cards: 0, repair_banner: false });
  });

  it("补丁只改带上的字段，返回写后的完整形状，之后读到的一样", async () => {
    expect(await setUiShape({ recent_cards: 4 })).toEqual({ recent_cards: 4, repair_banner: false });
    expect(await setUiShape({ repair_banner: true })).toEqual({ recent_cards: 4, repair_banner: true });
    expect(await getUiShape()).toEqual({ recent_cards: 4, repair_banner: true });
    expect(await setUiShape({ recent_cards: RECENT_CARDS_MAX, repair_banner: false })).toEqual({ recent_cards: 6, repair_banner: false });
  });

  it("张数超过上限、未知字段、类型不对都报 invalid_argument，整次不生效", async () => {
    await setUiShape({ recent_cards: 2, repair_banner: true });
    const tooMany = await rejection(setUiShape({ recent_cards: RECENT_CARDS_MAX + 1, repair_banner: false }));
    expect(tooMany.code).toBe("invalid_argument");
    expect(tooMany.message).toContain("recent_cards");
    const unknown = await rejection(invoke("set_ui_shape", { patch: { recent_cards: 1, pack_rows: [] } }));
    expect(unknown.code).toBe("invalid_argument");
    expect(unknown.message).toContain("pack_rows");
    // 字段给 null 也不算「不改」：后端同样拒绝
    for (const bad of [-1, 1.5, "3", null]) {
      expect((await rejection(invoke("set_ui_shape", { patch: { recent_cards: bad } }))).code).toBe("invalid_argument");
    }
    for (const bad of ["yes", null]) {
      expect((await rejection(invoke("set_ui_shape", { patch: { repair_banner: bad } }))).code).toBe("invalid_argument");
    }
    expect((await rejection(invoke("set_ui_shape", { patch: [1] }))).code).toBe("invalid_argument");
    expect(await getUiShape()).toEqual({ recent_cards: 2, repair_banner: true });
  });

  it("缺 patch 参数是 Tauri 自己的参数错误，归一后为 unknown", async () => {
    expect((await rejection(invoke("set_ui_shape", {}))).code).toBe("unknown");
  });
});
