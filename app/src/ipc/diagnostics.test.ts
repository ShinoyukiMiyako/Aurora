import { invoke as tauriInvoke } from "@tauri-apps/api/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { diagnoseCrash, lastCrash, lastLaunchLog, logDiagnostic } from "./diagnostics";
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

const FABRIC_CRASH = [
  "[19:32:11] [main/INFO]: Loading Minecraft 1.20.1 with Fabric Loader 0.15.7",
  "[19:32:12] [main/ERROR]: Incompatible mod set!",
  "\t - Mod 'Sodium' (sodium) 0.5.3 requires version 0.90.0 or later of fabric-api, which is missing!",
].join("\n");

describe("诊断 mock", () => {
  it("没启动过的实例没有崩溃报告与启动日志", async () => {
    expect(await lastCrash("1.21")).toBeNull();
    expect(await lastLaunchLog("1.21")).toBeNull();
  });

  it("粘贴日志的诊断带行号、前两行上下文与点名的 Mod，不保存", async () => {
    const report = await diagnoseCrash("1.20.1-fabric", FABRIC_CRASH);
    expect(report.at).toBeNull();
    expect(report.log_path).toBeNull();
    expect(report.diagnoses).toEqual([
      {
        category: "missing_dependency",
        summary: "缺少前置 Mod 或依赖版本不满足",
        advice: "根据日志补齐缺失的前置 Mod，或把相关 Mod 调整到彼此兼容的版本。",
        detail: null,
        matched: "[19:32:12] [main/ERROR]: Incompatible mod set!",
        line: 2,
        context: ["[19:32:11] [main/INFO]: Loading Minecraft 1.20.1 with Fabric Loader 0.15.7"],
      },
    ]);
    expect(report.suspects).toEqual([{ mod_id: "sodium", file_name: null }]);
    expect(await lastCrash("1.20.1-fabric")).toBeNull();
  });

  it("没有崩溃迹象的日志不点名 Mod", async () => {
    const report = await diagnoseCrash("1.21", "\t - Mod 'Sodium' (sodium) 0.5.3\n[main/INFO]: Setting user: Steve");
    expect(report.diagnoses).toEqual([]);
    expect(report.suspects).toEqual([]);
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
    for (let i = 0; i < 4; i++) vi.mocked(tauriInvoke).mockResolvedValueOnce(null);
    await lastCrash("1.21");
    await diagnoseCrash("1.21", "boom");
    await lastLaunchLog("1.21");
    await logDiagnostic("info", "m", { k: 1 });
    expect(vi.mocked(tauriInvoke).mock.calls).toEqual([
      ["last_crash", { versionId: "1.21" }],
      ["diagnose_crash", { versionId: "1.21", logText: "boom" }],
      ["last_launch_log", { versionId: "1.21" }],
      ["log_diagnostic", { level: "info", message: "m", fields: { k: 1 } }],
    ]);
  });
});
