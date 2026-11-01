import { invoke as tauriInvoke } from "@tauri-apps/api/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { lastCrash, lastLaunchLog, logDiagnostic } from "./diagnostics";
import { IpcError } from "./errors";
import { resetMocks } from "./mock";
import { clearMockEventListeners } from "./mock/events";
import { mockDiagnosticLog } from "./mock/handlers/diagnostics";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));

beforeEach(() => {
  vi.clearAllMocks();
  resetMocks();
  clearMockEventListeners();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function rejection(promise: Promise<unknown>): Promise<IpcError> {
  const error = await promise.then(
    () => {
      throw new Error("应被拒绝");
    },
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(IpcError);
  return error as IpcError;
}

describe("诊断 mock", () => {
  it("没启动过的实例没有崩溃报告与启动日志", async () => {
    expect(await lastCrash("1.21")).toBeNull();
    expect(await lastLaunchLog("1.21")).toBeNull();
  });

  it("诊断日志：四个级别照记，其余级别 invalid_argument，fields 不是对象是参数错误", async () => {
    await logDiagnostic("warn", "花瓣降级到静态层", { fps: 24, reason: "frame_budget" });
    await logDiagnostic("debug", "材质回落", {});
    expect(mockDiagnosticLog()).toEqual([
      { level: "warn", message: "花瓣降级到静态层", fields: { fps: 24, reason: "frame_budget" } },
      { level: "debug", message: "材质回落", fields: {} },
    ]);
    const bad = await rejection(logDiagnostic("loud" as never, "x", {}));
    expect(bad.code).toBe("invalid_argument");
    expect(bad.detail).toEqual({ level: "loud" });
    const notObject = await rejection(logDiagnostic("info", "x", [] as never));
    expect(notObject.code).toBe("unknown");
    expect(mockDiagnosticLog()).toHaveLength(2);
  });
});

describe("Tauri 窗口里", () => {
  beforeEach(() => {
    vi.stubGlobal("window", { __TAURI_INTERNALS__: {} });
  });

  it("参数键与 Rust 形参的 camelCase 一致", async () => {
    for (let i = 0; i < 3; i++) vi.mocked(tauriInvoke).mockResolvedValueOnce(null);
    await lastCrash("1.21");
    await lastLaunchLog("1.21");
    await logDiagnostic("info", "m", { k: 1 });
    expect(vi.mocked(tauriInvoke).mock.calls).toEqual([
      ["last_crash", { versionId: "1.21" }],
      ["last_launch_log", { versionId: "1.21" }],
      ["log_diagnostic", { level: "info", message: "m", fields: { k: 1 } }],
    ]);
  });
});
