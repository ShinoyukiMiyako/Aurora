import { invoke as tauriInvoke } from "@tauri-apps/api/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "./bridge";
import { lastCrash, lastLaunchLog } from "./diagnostics";
import { IpcError } from "./errors";
import {
  BUSY_ERROR_CODE,
  launchGame,
  onGameExit,
  onGameLog,
  onLaunchPhase,
  playStats,
  stopGame,
  type GameExitEvent,
  type GameLogEvent,
  type LaunchArgs,
  type LaunchPhaseEvent,
} from "./launch";
import { resetMocks } from "./mock";
import { clearMockEventListeners } from "./mock/events";
import { endMockGame, failNextMockLaunch } from "./mock/handlers/launch";
import { cancelTask } from "./tasks";

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

const MINUTE = 60_000;

function today(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function offline(versionId: string, taskId: string): LaunchArgs {
  return { taskId, versionId, accountUuid: null, offlineName: "Steve" };
}

async function recordEvents() {
  const phases: LaunchPhaseEvent[] = [];
  const logs: GameLogEvent[] = [];
  const exits: GameExitEvent[] = [];
  await onLaunchPhase((e) => phases.push(e));
  await onGameLog((e) => logs.push(e));
  await onGameExit((e) => exits.push(e));
  return { phases, logs, exits };
}

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

async function minutesToday(): Promise<number> {
  const stats = await playStats({ from: today(), to: today() });
  return stats.total_minutes;
}

describe("启动 mock", () => {
  // 只冻结 Date：游玩时长按本地日期记，固定在远离种子数据的一天，「今天」的分钟只来自本用例。
  const NOON = new Date(2030, 5, 15, 12, 0, 0);
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"], now: NOON });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("阶段下标 0 到 7 单调推进，阶段 3 带一份下载进度，resolve 时已在运行", async () => {
    const { phases, logs } = await recordEvents();
    expect(await launchGame(offline("1.21", "t-1"))).toEqual({ pid: 4242 });
    const indices = phases.map((p) => p.stage_index);
    expect(indices).toEqual([0, 1, 2, 3, 3, 4, 5, 6, 7]);
    expect(phases.every((p) => p.task_id === "t-1")).toBe(true);
    expect(phases.map((p) => p.phase)).toEqual(["preparing", "preparing", "preparing", "downloading", "downloading", "launching", "launching", "launching", "running"]);
    expect(phases.filter((p) => p.download !== undefined)).toEqual([
      { task_id: "t-1", phase: "downloading", stage_index: 3, download: { total: 0, finished: 0, bytes: 0, total_bytes: 0, speed: 0 } },
    ]);
    const lines = logs.flatMap((batch) => batch.lines);
    expect(lines.filter((l) => l.source === "launcher").map((l) => l.text)).toEqual(["检查 Java", "校验游戏文件", "补全库文件", "下载缺失文件", "解压本地库", "生成启动参数", "启动游戏进程"]);
    expect(lines.at(-1)).toMatchObject({ source: "game", level: "info" });
    expect(logs.every((batch) => batch.version_id === "1.21")).toBe(true);
  });

  it("游戏在加载或运行时再启动返回 busy，detail 指明占用者与阶段", async () => {
    const first = launchGame(offline("1.20.1-fabric", "t-a"));
    const whileLoading = await rejection(launchGame(offline("1.21", "t-b")));
    expect(whileLoading.code).toBe(BUSY_ERROR_CODE);
    expect(whileLoading.detail).toEqual({ version_id: "1.20.1-fabric", phase: "loading" });
    await first;

    const whileRunning = await rejection(launchGame(offline("1.21", "t-c")));
    expect(whileRunning.code).toBe(BUSY_ERROR_CODE);
    expect(whileRunning.detail).toEqual({ version_id: "1.20.1-fabric", phase: "running" });

    await stopGame();
    expect(await launchGame(offline("1.21", "t-d"))).toEqual({ pid: 4242 });
  });

  it("结束游戏推送 killed 退出，不算崩溃也不留崩溃报告，游玩照记", async () => {
    const { exits } = await recordEvents();
    await launchGame(offline("1.21", "t-1"));
    vi.setSystemTime(new Date(2030, 5, 15, 12, 30, 0));
    await stopGame();
    expect(exits).toEqual([{ version_id: "1.21", exit_code: 1, crashed: false, killed: true, duration_ms: 30 * MINUTE }]);
    expect(await lastCrash("1.21")).toBeNull();
    expect((await lastLaunchLog("1.21"))?.ended?.outcome).toBe("killed");
    expect(await minutesToday()).toBe(30);
    // 没有运行中的游戏时结束是空操作。
    await stopGame();
    expect(exits).toHaveLength(1);
  });

  it("非 0 退出码即崩溃：退出事件前报告、日志结局与游玩时长都已写好", async () => {
    const { exits } = await recordEvents();
    await launchGame(offline("1.21", "t-1"));
    expect(await minutesToday()).toBe(0);
    endMockGame(3, 90 * MINUTE + 30_000);
    expect(exits).toEqual([{ version_id: "1.21", exit_code: 3, crashed: true, killed: false, duration_ms: 90 * MINUTE + 30_000 }]);

    const log = await lastLaunchLog("1.21");
    expect(log?.ended?.outcome).toBe("crashed");
    const report = await lastCrash("1.21");
    expect(report).not.toBeNull();
    const clue = report!.diagnoses[0];
    expect(clue.category).toBe("out_of_memory");
    // 行号对得上日志页：命中行与它之前两行都取自同一份会话日志。
    expect(log!.lines[clue.line - 1].text).toBe(clue.matched);
    expect(clue.context).toEqual(log!.lines.slice(clue.line - 3, clue.line - 1).map((l) => l.text));
    expect(report!.exit_code).toBe(3);
    expect(report!.log_path).toBe(log!.path);
    expect(await minutesToday()).toBe(90);
  });

  it("游戏正常退出：不是崩溃，没有报告", async () => {
    const { exits } = await recordEvents();
    await launchGame(offline("1.21", "t-1"));
    endMockGame(0, MINUTE);
    expect(exits[0]).toMatchObject({ exit_code: 0, crashed: false, killed: false });
    expect(await lastCrash("1.21")).toBeNull();
    expect((await lastLaunchLog("1.21"))?.ended?.outcome).toBe("exited");
  });

  it("加载中取消：以 cancelled 拒绝，占用放开，不记游玩", async () => {
    const { phases } = await recordEvents();
    const launching = launchGame(offline("1.21", "t-x"));
    await cancelTask("t-x");
    const error = await rejection(launching);
    expect(error.code).toBe("cancelled");
    expect(phases.every((p) => p.stage_index < 7)).toBe(true);
    expect((await lastLaunchLog("1.21"))?.ended?.outcome).toBe("cancelled");
    expect(await minutesToday()).toBe(0);
    expect(await launchGame(offline("1.21", "t-y"))).toEqual({ pid: 4242 });
  });

  it("失败码在它所属的阶段拒绝，插值参数原样在 detail 里，之后能再次启动", async () => {
    const { phases } = await recordEvents();
    failNextMockLaunch("java_too_old", { current: 17, major: 21, mc_version: "1.21", pinned_by: "instance" });
    const error = await rejection(launchGame(offline("1.21", "t-1")));
    expect(error.code).toBe("java_too_old");
    expect(error.detail).toEqual({ current: 17, major: 21, mc_version: "1.21", pinned_by: "instance" });
    expect(phases.map((p) => p.stage_index)).toEqual([0]);
    expect((await lastLaunchLog("1.21"))?.ended?.outcome).toBe("failed");

    failNextMockLaunch("disk_full", { drive: "D:", needed_bytes: 1024 });
    const disk = await rejection(launchGame(offline("1.21", "t-2")));
    expect(disk.code).toBe("disk_full");
    expect(Math.max(...phases.slice(1).map((p) => p.stage_index))).toBe(3);

    expect(await launchGame(offline("1.21", "t-3"))).toEqual({ pid: 4242 });
    expect(() => failNextMockLaunch("teapot", {})).toThrow("未知的启动失败码 teapot");
  });

  it("账户必须二选一；参数类型不对是 Tauri 自己的参数错误", async () => {
    const neither = await rejection(launchGame({ taskId: "t", versionId: "1.21", accountUuid: null, offlineName: null } as never));
    expect(neither.code).toBe("invalid_argument");
    const both = await rejection(launchGame({ taskId: "t", versionId: "1.21", accountUuid: "u", offlineName: "Steve" } as never));
    expect(both.code).toBe("invalid_argument");
    const wrongType = await rejection(launchGame({ taskId: "t", versionId: 7, accountUuid: null, offlineName: "Steve" } as never));
    expect(wrongType.code).toBe("unknown");
    // 被拒的启动不占槽。
    expect(await launchGame(offline("1.21", "t-ok"))).toEqual({ pid: 4242 });
  });
});

describe("游玩统计 mock", () => {
  it("区间两端都含，按日期升序，实例按分钟降序", async () => {
    const all = await playStats({ from: "2000-01-01", to: today() });
    expect(all.days.map((d) => d.date)).toEqual([...all.days.map((d) => d.date)].sort());
    expect(all.days.length).toBeGreaterThan(0);
    const minutes = all.instances.map((i) => i.minutes);
    expect(minutes).toEqual([...minutes].sort((a, b) => b - a));
    expect(all.total_minutes).toBe(all.instances.reduce((sum, i) => sum + i.minutes, 0));

    const first = all.days[0].date;
    const single = await playStats({ from: first, to: first });
    expect(single.days).toEqual([all.days[0]]);
    expect(single.from).toBe(first);
    expect(single.to).toBe(first);
  });

  it("非法区间报 invalid_argument，缺参数报 Tauri 的参数错误", async () => {
    for (const range of [
      { from: "2026-10-31", to: "2026-10-01" },
      { from: "2026-1-5", to: "2026-10-31" },
      { from: "2025-02-29", to: "2025-03-01" },
    ]) {
      const error = await rejection(playStats(range));
      expect(error.code).toBe("invalid_argument");
      expect(error.detail).toEqual(range);
    }
    const missing = await rejection(invoke("play_stats", {}));
    expect(missing.code).toBe("unknown");
  });
});

describe("Tauri 窗口里", () => {
  beforeEach(() => {
    vi.stubGlobal("window", { __TAURI_INTERNALS__: {} });
  });

  it("launchGame 只传实例、账户与取消句柄；playStats 传 range 对象", async () => {
    vi.mocked(tauriInvoke).mockResolvedValueOnce({ pid: 7 }).mockResolvedValueOnce(null).mockResolvedValueOnce({});
    // 调用方多塞的键（旧接口的内存参数）不会被转发：命令只收这四项。
    const extra = { ...offline("1.21", "t-run"), maxMemoryMb: 4096 } as unknown as LaunchArgs;
    expect(await launchGame(extra)).toEqual({ pid: 7 });
    await stopGame();
    await playStats({ from: "2026-10-01", to: "2026-10-31" });
    expect(vi.mocked(tauriInvoke).mock.calls).toEqual([
      ["launch_game", { taskId: "t-run", versionId: "1.21", accountUuid: null, offlineName: "Steve" }],
      ["stop_game", undefined],
      ["play_stats", { range: { from: "2026-10-01", to: "2026-10-31" } }],
    ]);
  });
});
