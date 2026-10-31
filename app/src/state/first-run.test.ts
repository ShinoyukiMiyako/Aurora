// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { IpcRecorder } from "../test/fake-bridge";
import { bootOverrides, callsOf, configDto, resetRecorder, startedStore } from "../test/launcher";
import type { LauncherStore } from "./store";

const ipc = vi.hoisted((): IpcRecorder => ({ calls: [], overrides: new Map() }));
vi.mock("../ipc/bridge", async (orig) => (await import("../test/fake-bridge")).fakeBridge(await orig(), ipc));

let store: LauncherStore;
let gameDir: string;

beforeEach(async () => {
  vi.useFakeTimers();
  resetRecorder(ipc);
  gameDir = "C:/Users/me/AppData/Local/launcher/.minecraft";
  bootOverrides(ipc, { firstRun: true });
  ipc.overrides.set("get_config", () => configDto({ game_dir: gameDir }));
  ipc.overrides.set("complete_first_run", (args) => {
    gameDir = String(args.gameDir);
    return null;
  });
  store = await startedStore();
});
afterEach(() => {
  store.stop();
  vi.useRealTimers();
});

describe("首次启动向导", () => {
  it("第一步提交后向导仍挂着、设置已换成新目录；收尾时才卸载", async () => {
    expect(store.getState().firstRun).toBe(true);
    await store.actions.commitFirstRun("D:/Games/.minecraft", [{ name: "HMCL", path: "D:/HMCL/.minecraft" }]);
    expect(callsOf(ipc, "complete_first_run")).toEqual([{ gameDir: "D:/Games/.minecraft", extraDirectories: [{ name: "HMCL", path: "D:/HMCL/.minecraft" }] }]);
    expect(store.getState().firstRun).toBe(true);
    expect(store.getState().settings?.gameDir).toBe("D:/Games/.minecraft");

    store.actions.finishFirstRun();
    expect(store.getState().firstRun).toBe(false);
    expect(callsOf(ipc, "complete_first_run")).toHaveLength(1);
  });

  it("第一步还没提交就收尾：抛错，向导不卸载", () => {
    expect(() => store.actions.finishFirstRun()).toThrow("第一步还没有提交");
    expect(store.getState().firstRun).toBe(true);
  });

  it("后端拒绝了目录：错误原样抛出，之后收尾仍被拒绝", async () => {
    ipc.overrides.set("complete_first_run", () => {
      throw { code: "invalid_game_directory", message: "路径里不能有「!」", detail: { problem: "contains_bang" } };
    });
    await expect(store.actions.commitFirstRun("D:/Ga!mes", [])).rejects.toMatchObject({ code: "invalid_game_directory" });
    expect(() => store.actions.finishFirstRun()).toThrow("第一步还没有提交");
  });

  it("completeFirstRun 是提交加收尾", async () => {
    await store.actions.completeFirstRun("D:/Games/.minecraft", []);
    expect(store.getState().firstRun).toBe(false);
  });
});
