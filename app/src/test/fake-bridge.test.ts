import { invoke as tauriInvoke } from "@tauri-apps/api/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { invoke } from "../ipc/bridge";
import type { ConfigDto } from "../ipc/config";
import type { IpcRecorder } from "./fake-bridge";

const ipc = vi.hoisted((): IpcRecorder => ({ calls: [], overrides: new Map() }));
vi.mock("../ipc/bridge", async (orig) => (await import("./fake-bridge")).fakeBridge(await orig(), ipc));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

afterEach(() => {
  ipc.calls.length = 0;
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

/** 只清微任务队列、不让出宏任务：动态 import 这类真实 I/O 在这期间推进不了。 */
async function drainMicrotasks(rounds = 20): Promise<void> {
  for (let i = 0; i < rounds; i++) await Promise.resolve();
}

describe("IPC 桥替身：没改写的命令落到假后端", () => {
  // 必须是本文件第一次落到假后端：退回到真桥那条第一次调用才加载假后端的路时，只有第一次要等加载，之后就测不出差别
  it("开着假定时器、只清微任务就拿到假后端的结果，不等加载模块这类真实 I/O", async () => {
    vi.useFakeTimers();
    const got: { config?: ConfigDto } = {};
    void invoke<ConfigDto>("get_config").then((config) => {
      got.config = config;
    });
    await drainMicrotasks();
    expect(got.config?.game_dir).toBe("D:\\Games\\Launcher\\.minecraft");
    expect(ipc.calls).toEqual([{ cmd: "get_config", args: {} }]);
  });

  it("假后端的错误原样交给调用方", async () => {
    await expect(invoke("no_such_command")).rejects.toThrow("mock 未实现 no_such_command");
  });

  it("桩了 Tauri 窗口时交给真桥走真命令，不落到假后端", async () => {
    vi.stubGlobal("window", { __TAURI_INTERNALS__: {} });
    vi.mocked(tauriInvoke).mockResolvedValueOnce({ game_dir: "E:\\.minecraft" });
    expect(await invoke("get_config")).toEqual({ game_dir: "E:\\.minecraft" });
    expect(vi.mocked(tauriInvoke).mock.calls).toEqual([["get_config", undefined]]);
  });
});
