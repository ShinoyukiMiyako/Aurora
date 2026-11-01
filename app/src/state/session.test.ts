// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { percent } from "../domain/format";
import { GAME_EXIT_EVENT, LAUNCH_PHASE_EVENT, type GameExitEvent, type LaunchPhaseEvent } from "../ipc/launch";
import type { IpcRecorder } from "../test/fake-bridge";
import { bootOverrides, callsOf, cancelledError, deferred, emit, resetRecorder, settle, startedStore } from "../test/launcher";
import type { LogLine } from "../domain/types";
import { appendSessionLogs, applyPhase, sessionExited, sessionLaunched, startSession, type SessionState } from "./session";

const ipc = vi.hoisted((): IpcRecorder => ({ calls: [], overrides: new Map() }));
vi.mock("../ipc/bridge", async (orig) => (await import("../test/fake-bridge")).fakeBridge(await orig(), ipc));

const T0 = 1_720_000_000_000;
const ACCOUNT = { uuid: "u-1", name: "Steve" };

function phase(session: SessionState, stageIndex: number, download: SessionState["download"] = null, at = T0): SessionState {
  const name = stageIndex < 3 ? "preparing" : stageIndex === 3 ? "downloading" : stageIndex < 7 ? "launching" : "running";
  return applyPhase(session, { taskId: session.taskId, phase: name, stageIndex, download }, at);
}

const dl = (bytes: number, totalBytes: number | null, done = 0, total: number | null = 10) => ({ done, total, bytes, totalBytes, speedBps: 4_200_000 });

describe("会话进度：八阶段区间", () => {
  const s0 = startSession("生存", "launch-1", ACCOUNT, T0, null);

  it("各阶段起点：0 / 0.1 / 0.2 / 0.3 / 0.75 / 0.83 / 0.91", () => {
    expect(s0).toMatchObject({ phase: "preparing", progress: 0, stageIndex: 0, accountName: "Steve" });
    expect([1, 2, 3, 4, 5, 6].map((i) => phase(s0, i).progress)).toEqual([0.1, 0.2, 0.3, 0.75, 0.83, 0.91]);
    expect(phase(s0, 2).phase).toBe("preparing");
    expect(phase(s0, 3).phase).toBe("downloading");
    expect(phase(s0, 5).phase).toBe("launching");
  });

  it("阶段 3 按字节线性推进：一半字节 = 0.3 + 0.45 × 0.5", () => {
    expect(phase(s0, 3, dl(500, 1000)).progress).toBeCloseTo(0.525, 10);
    // 声明大小未知时退回文件数比例
    expect(phase(s0, 3, dl(999, null, 4, 10)).progress).toBeCloseTo(0.3 + 0.45 * 0.4, 10);
    // 有效字节越过声明大小时封顶，不越过阶段 4 的起点
    expect(phase(s0, 3, dl(1500, 1000)).progress).toBeCloseTo(0.75, 10);
  });

  it("单调不减：更小的阶段下标与回落的字节都不让进度倒退", () => {
    let s = phase(s0, 3, dl(800, 1000));
    const high = s.progress;
    s = phase(s, 3, dl(100, 1000));
    expect(s.progress).toBe(high);
    s = phase(s, 1);
    expect(s).toMatchObject({ stageIndex: 3, phase: "downloading", progress: high });
  });

  it("没有缺失文件时从阶段 2 直接跳到 4：进度从 0.2 跳到 0.75", () => {
    const s = phase(phase(s0, 2), 4);
    expect(s).toMatchObject({ stageIndex: 4, phase: "launching", progress: 0.75 });
  });

  it("加载阶段百分比封顶 99%，只有运行才算 100%", () => {
    expect(percent(0.995, true)).toBe("99%");
    expect(percent(0.999, true)).toBe("99%");
    expect(percent(0.5, true)).toBe("50%");
    const running = sessionLaunched(phase(s0, 6), "launch-1", T0 + 9000);
    expect(running).toMatchObject({ phase: "running", progress: 1, stageIndex: 7, runningSince: T0 + 9000 });
  });

  it("别的启动的阶段事件原样丢弃", () => {
    const stale = applyPhase(s0, { taskId: "launch-0", phase: "launching", stageIndex: 6, download: null }, T0);
    expect(stale).toBe(s0);
  });
});

describe("准备阶段的提醒数", () => {
  const line = (level: LogLine["level"], source: LogLine["source"], text: string): LogLine => ({ at: T0, level, source, text });

  it("加载期间启动器的 warn 行记到当前阶段；游戏输出、info 与 error 行不算；运行之后不再计", () => {
    let s = startSession("生存", "launch-1", ACCOUNT, T0, null);
    expect(s.stageWarnings).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
    s = appendSessionLogs(s, "生存", [line("warn", "launcher", "游戏路径含有非 ASCII 字符"), line("info", "launcher", "检查 Java"), line("warn", "game", "x")]);
    s = phase(s, 2);
    s = appendSessionLogs(s, "生存", [line("warn", "launcher", "内存设置超过物理内存的一半"), line("warn", "launcher", "Mod 加载器版本较旧"), line("error", "launcher", "e")]);
    expect(s.stageWarnings).toEqual([1, 0, 2, 0, 0, 0, 0, 0]);
    s = sessionLaunched(s, "launch-1", T0 + 1000);
    s = appendSessionLogs(s, "生存", [line("warn", "launcher", "运行中的提醒不属于任何加载阶段")]);
    expect(s.stageWarnings).toEqual([1, 0, 2, 0, 0, 0, 0, 0]);
    expect(s.logs).toHaveLength(7);
  });

  it("别的实例的日志不记", () => {
    const s = startSession("生存", "launch-1", ACCOUNT, T0, null);
    expect(appendSessionLogs(s, "创造", [line("warn", "launcher", "x")])).toBe(s);
  });
});

describe("会话退出", () => {
  const running = sessionLaunched(startSession("生存", "launch-1", ACCOUNT, T0, null), "launch-1", T0 + 1000);

  it("玩家结束的永远不判崩溃，即使退出码非 0", () => {
    const s = sessionExited(running, { versionId: "生存", crashed: true, killed: true }, T0 + 5000);
    expect(s).toMatchObject({ phase: "stopped", stopReason: "killed", crash: null });
  });

  it("崩溃进入 crashed，线索待读；正常退出为 exited", () => {
    expect(sessionExited(running, { versionId: "生存", crashed: true, killed: false }, T0 + 5000)).toMatchObject({ phase: "crashed", crash: { status: "pending" } });
    expect(sessionExited(running, { versionId: "生存", crashed: false, killed: false }, T0 + 5000)).toMatchObject({ phase: "stopped", stopReason: "exited" });
  });

  it("别的实例的退出事件不影响会话", () => {
    expect(sessionExited(running, { versionId: "创造", crashed: true, killed: false }, T0)).toBe(running);
  });
});

describe("会话：状态容器里的启动与结束", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    resetRecorder(ipc);
    bootOverrides(ipc);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  async function launching() {
    const launched = deferred<{ pid: number | null }>();
    ipc.overrides.set("launch_game", () => launched.promise);
    const store = await startedStore();
    const pending = store.actions.launch("生存");
    await settle();
    const session = store.getState().session;
    if (session === null) throw new Error("没有建立会话");
    return { store, launched, pending, taskId: session.taskId };
  }

  it("点启动后进入 preparing，阶段事件推进进度，launch_game 返回后进入运行", async () => {
    const { store, launched, pending, taskId } = await launching();
    expect(callsOf(ipc, "launch_game")).toEqual([{ taskId, versionId: "生存", accountUuid: "00000000-0000-0000-0000-00000000a001", offlineFallback: false, offlineName: null, quickPlay: null }]);
    expect(store.getState().session).toMatchObject({ instanceId: "生存", phase: "preparing", progress: 0 });

    emit(LAUNCH_PHASE_EVENT, { task_id: taskId, phase: "downloading", stage_index: 3, download: { total: 480, finished: 120, bytes: 250, total_bytes: 1000, speed: 4_200_000 } } satisfies LaunchPhaseEvent);
    expect(store.getState().session).toMatchObject({ phase: "downloading", download: { done: 120, total: 480 } });
    expect(store.getState().session?.progress).toBeCloseTo(0.3 + 0.45 * 0.25, 10);

    launched.resolve({ pid: 4242 });
    await pending;
    expect(store.getState().session).toMatchObject({ phase: "running", progress: 1 });
    store.stop();
  });

  it("正常退出后停留 1500 ms 再清空会话", async () => {
    const { store, launched, pending } = await launching();
    launched.resolve({ pid: 1 });
    await pending;
    emit(GAME_EXIT_EVENT, { version_id: "生存", exit_code: 0, crashed: false, killed: false, duration_ms: 60_000 } satisfies GameExitEvent);
    expect(store.getState().session).toMatchObject({ phase: "stopped", stopReason: "exited" });
    await vi.advanceTimersByTimeAsync(1499);
    expect(store.getState().session).not.toBeNull();
    await vi.advanceTimersByTimeAsync(1);
    expect(store.getState().session).toBeNull();
    store.stop();
  });

  it("加载中结束 = 用这次启动的 taskId 取消，不调 stop_game", async () => {
    const { store, launched, pending, taskId } = await launching();
    ipc.overrides.set("cancel_task", () => {
      launched.reject(cancelledError());
      return true;
    });
    await store.actions.stop();
    await pending;
    expect(callsOf(ipc, "cancel_task")).toEqual([{ taskId }]);
    expect(callsOf(ipc, "stop_game")).toEqual([]);
    expect(store.getState().session).toMatchObject({ phase: "stopped", stopReason: "cancelled" });
    store.stop();
  });

  it("运行中结束 = stop_game；退出事件带 killed 即为已结束，不弹崩溃", async () => {
    const { store, launched, pending } = await launching();
    launched.resolve({ pid: 1 });
    await pending;
    ipc.overrides.set("stop_game", () => {
      emit(GAME_EXIT_EVENT, { version_id: "生存", exit_code: 1, crashed: true, killed: true, duration_ms: 5000 } satisfies GameExitEvent);
      return null;
    });
    await store.actions.stop();
    expect(callsOf(ipc, "stop_game")).toHaveLength(1);
    expect(callsOf(ipc, "cancel_task")).toEqual([]);
    expect(store.getState().session).toMatchObject({ phase: "stopped", stopReason: "killed" });
    expect(store.getState().toasts.filter((t) => t.tone === "error")).toEqual([]);
    store.stop();
  });

  it("取消到达时启动刚好完成：cancel_task 返回 false 且已在运行，改为 stop_game", async () => {
    const { store, launched, pending } = await launching();
    ipc.overrides.set("cancel_task", async () => {
      launched.resolve({ pid: 1 });
      await pending;
      return false;
    });
    ipc.overrides.set("stop_game", () => {
      emit(GAME_EXIT_EVENT, { version_id: "生存", exit_code: 0, crashed: false, killed: true, duration_ms: 10 } satisfies GameExitEvent);
      return null;
    });
    await store.actions.stop();
    expect(callsOf(ipc, "stop_game")).toHaveLength(1);
    expect(store.getState().session).toMatchObject({ phase: "stopped", stopReason: "killed" });
    store.stop();
  });

  it("10 秒内进程没有结束时以错误结束，会话保持原状", async () => {
    const { store, launched, pending } = await launching();
    launched.resolve({ pid: 1 });
    await pending;
    ipc.overrides.set("stop_game", () => null);
    const stopping = store.actions.stop();
    const outcome = stopping.then(
      () => "resolved",
      (e: Error) => e.message,
    );
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await outcome).toBe("10 秒内游戏进程没有结束");
    expect(store.getState().session).toMatchObject({ phase: "running" });
    store.stop();
  });

  it("启动失败码进入 failed 并发失败通知，操作是修复动作的第一个按钮", async () => {
    const { store, launched, pending } = await launching();
    launched.reject({ code: "java_missing", message: "找不到 Java 21", detail: { major: 21, mc_version: "1.21.1", causes: [] } });
    await pending;
    expect(store.getState().session).toMatchObject({ phase: "failed", failure: { code: "java_missing", params: { major: 21, mc_version: "1.21.1" } } });
    const toast = store.getState().toasts.find((t) => t.tone === "error");
    expect(toast).toMatchObject({ title: "「生存」启动失败", body: "找不到 Java 21", action: { label: "下载 Java 21" } });
    store.stop();
  });
});
