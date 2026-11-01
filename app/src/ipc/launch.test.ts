import { invoke as tauriInvoke } from "@tauri-apps/api/core";
import { listen as tauriListen } from "@tauri-apps/api/event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "./bridge";
import { lastCrash, lastLaunchLog } from "./diagnostics";
import { IpcError } from "./errors";
import {
  BUSY_ERROR_CODE,
  OFFLINE_FALLBACK_FIELD,
  launchGame,
  offlineFallbackRefusal,
  onGameExit,
  onGameLog,
  onLaunchPhase,
  onWorldBackup,
  playStats,
  QUICK_PLAY_UNSUPPORTED_CODE,
  stopGame,
  WORLD_BACKUP_EVENT,
  type GameExitEvent,
  type GameLogEvent,
  type LaunchArgs,
  type LaunchPhaseEvent,
  type WorldBackupEvent,
} from "./launch";
import { resetMocks } from "./mock";
import { clearMockEventListeners, emitMockWorldBackup } from "./mock/events";
import { endMockGame, failNextMockLaunch, lastMockQuickPlay } from "./mock/handlers/launch";
import { acquireMockInstance } from "./mock/handlers/instances";
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
  return { taskId, versionId, accountUuid: null, offlineName: "Steve", offlineFallback: false, quickPlay: null };
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
    expect(await launchGame(offline("1.21", "t-1"))).toEqual({ pid: 4242, offline: false });
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
    expect(await launchGame(offline("1.21", "t-d"))).toEqual({ pid: 4242, offline: false });
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
    expect(await launchGame(offline("1.21", "t-y"))).toEqual({ pid: 4242, offline: false });
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

    expect(await launchGame(offline("1.21", "t-3"))).toEqual({ pid: 4242, offline: false });
    expect(() => failNextMockLaunch("teapot", {})).toThrow("未知的启动失败码 teapot");
  });

  it("账户必须二选一；参数类型不对是 Tauri 自己的参数错误", async () => {
    const neither = await rejection(launchGame({ taskId: "t", versionId: "1.21", accountUuid: null, offlineName: null, offlineFallback: false, quickPlay: null } as never));
    expect(neither.code).toBe("invalid_argument");
    const both = await rejection(launchGame({ taskId: "t", versionId: "1.21", accountUuid: "u", offlineName: "Steve", offlineFallback: false, quickPlay: null } as never));
    expect(both.code).toBe("invalid_argument");
    const wrongType = await rejection(launchGame({ taskId: "t", versionId: 7, accountUuid: null, offlineName: "Steve", offlineFallback: false, quickPlay: null } as never));
    expect(wrongType.code).toBe("unknown");
    // 被拒的启动不占槽。
    expect(await launchGame(offline("1.21", "t-ok"))).toEqual({ pid: 4242, offline: false });
  });
});

describe("以离线方式进单人 mock", () => {
  // 账户 mock 的种子：一个验证正常的微软账户，一个已被判定需要重新登录的外置账户
  const HANAMI = "6a1f0c0e4b5d4c3e9f2a7b8c9d0e1f20";
  const YOZAKURA = "b7c2d3e4f5a64b7c8d9e0f1a2b3c4d5e";
  const WARN_LINE = "以离线方式进单人：Hanami_Walker 这一局不经账户验证，只能玩单人游戏";

  const stored = (uuid: string, taskId: string, offlineFallback: boolean): LaunchArgs => ({ taskId, versionId: "1.21", accountUuid: uuid, offlineName: null, offlineFallback, quickPlay: null });

  /** 用这个账户普通启动一次，在阶段 0 以账户类失败码失败。 */
  async function failWith(code: string, uuid = HANAMI): Promise<void> {
    failNextMockLaunch(code, { account: "Hanami_Walker", status: 503 });
    const error = await rejection(launchGame(stored(uuid, `t-fail-${code}`, false)));
    expect(error.code).toBe(code);
  }

  async function refusal(args: LaunchArgs): Promise<IpcError> {
    const error = await rejection(launchGame(args));
    expect(error.code).toBe("invalid_argument");
    return error;
  }

  it.each(["account_service_down", "account_refresh_network"])("上次以 %s 失败：放行一次，返回 offline: true，阶段 0 多一行 warn", async (code) => {
    await failWith(code);
    const { phases, logs } = await recordEvents();
    expect(await launchGame(stored(HANAMI, "t-off", true))).toEqual({ pid: 4242, offline: true });
    expect(phases.map((p) => p.stage_index)).toEqual([0, 1, 2, 3, 3, 4, 5, 6, 7]);
    const launcher = logs.flatMap((batch) => batch.lines).filter((l) => l.source === "launcher");
    expect(launcher.slice(0, 3).map((l) => [l.level, l.text])).toEqual([
      ["info", "检查 Java"],
      ["warn", WARN_LINE],
      ["info", "校验游戏文件"],
    ]);
    expect(launcher.filter((l) => l.level === "warn")).toHaveLength(1);

    // 一次性：那条失败记录已经用掉
    await stopGame();
    const again = await refusal(stored(HANAMI, "t-again", true));
    expect(again.detail).toEqual({ field: "offlineFallback", reason: "no_recent_failure", account: "Hanami_Walker" });
  });

  it("没有失败记录：no_recent_failure，正文给出原因；被拒的启动不推阶段、不占槽", async () => {
    const { phases } = await recordEvents();
    const error = await refusal(stored(HANAMI, "t-1", true));
    expect(error.detail).toEqual({ field: "offlineFallback", reason: "no_recent_failure", account: "Hanami_Walker" });
    expect(error.message).toBe("Hanami_Walker 不能以离线方式进单人：没有这个账户最近一次验证失败的记录，先重试一次启动");
    expect(phases).toEqual([]);
    expect(await launchGame(stored(HANAMI, "t-2", false))).toEqual({ pid: 4242, offline: false });
  });

  it("离线角色名与账户库里的离线账户：offline_account", async () => {
    const byName = await refusal({ taskId: "t-1", versionId: "1.21", accountUuid: null, offlineName: "Steve", offlineFallback: true, quickPlay: null });
    expect(byName.detail).toEqual({ field: "offlineFallback", reason: "offline_account", account: "Steve" });
    expect(byName.message).toBe("Steve 不能以离线方式进单人：离线账户本来就不经验证");

    const alex = await invoke<{ uuid: string }>("create_offline_account", { name: "Alex" });
    const byUuid = await refusal(stored(alex.uuid, "t-2", true));
    expect(byUuid.detail).toEqual({ field: "offlineFallback", reason: "offline_account", account: "Alex" });
  });

  it("账户已被判定需要重新登录：即使上次是服务故障也报 relogin_required", async () => {
    await failWith("account_service_down", YOZAKURA);
    const error = await refusal(stored(YOZAKURA, "t-1", true));
    expect(error.detail).toEqual({ field: "offlineFallback", reason: "relogin_required", account: "Yozakura" });
    expect(error.message).toBe("Yozakura 不能以离线方式进单人：登录已失效，需要重新登录");
  });

  it("上次失败是 account_relogin：relogin_required，记录照样消耗", async () => {
    await failWith("account_relogin");
    const first = await refusal(stored(HANAMI, "t-1", true));
    expect(first.detail).toEqual({ field: "offlineFallback", reason: "relogin_required", account: "Hanami_Walker" });
    const second = await refusal(stored(HANAMI, "t-2", true));
    expect(second.detail).toEqual({ field: "offlineFallback", reason: "no_recent_failure", account: "Hanami_Walker" });
  });

  it("普通启动成功清掉记录", async () => {
    await failWith("account_refresh_network");
    expect(await launchGame(stored(HANAMI, "t-ok", false))).toEqual({ pid: 4242, offline: false });
    await stopGame();
    const error = await refusal(stored(HANAMI, "t-off", true));
    expect(error.detail).toEqual({ field: "offlineFallback", reason: "no_recent_failure", account: "Hanami_Walker" });
  });

  it("后一次账户类失败覆盖前一次：先网络故障、再登录失效，降级报 relogin_required", async () => {
    await failWith("account_refresh_network");
    await failWith("account_relogin");
    const error = await refusal(stored(HANAMI, "t-off", true));
    expect(error.detail).toEqual({ field: "offlineFallback", reason: "relogin_required", account: "Hanami_Walker" });
  });

  it("降级启动跳过账户类的失败；别的阶段的失败照常，且那条记录已在判定时用掉", async () => {
    await failWith("account_service_down");
    failNextMockLaunch("account_relogin", { account: "Hanami_Walker" });
    expect(await launchGame(stored(HANAMI, "t-off", true))).toEqual({ pid: 4242, offline: true });
    await stopGame();

    await failWith("account_service_down");
    failNextMockLaunch("disk_full", { drive: "D:", needed_bytes: 1024 });
    const disk = await rejection(launchGame(stored(HANAMI, "t-disk", true)));
    expect(disk.code).toBe("disk_full");
    const after = await refusal(stored(HANAMI, "t-after", true));
    expect(after.detail).toEqual({ field: "offlineFallback", reason: "no_recent_failure", account: "Hanami_Walker" });
  });

  it("实例正被占用而没能开局的降级不消耗那条记录：后端在占住实例之后才取账户身份，放开后照常放行", async () => {
    await failWith("account_service_down");
    const install = acquireMockInstance("1.21", "installing");
    const busy = await rejection(launchGame(stored(HANAMI, "t-busy", true)));
    expect(busy.code).toBe("instance_busy");
    install.release();
    expect(await launchGame(stored(HANAMI, "t-off", true))).toEqual({ pid: 4242, offline: true });
  });

  it("不是账户类的失败不记：java_missing 之后降级报 no_recent_failure", async () => {
    failNextMockLaunch("java_missing", { major: 21, mc_version: "1.21" });
    await rejection(launchGame(stored(HANAMI, "t-java", false)));
    const error = await refusal(stored(HANAMI, "t-off", true));
    expect(error.detail).toEqual({ field: "offlineFallback", reason: "no_recent_failure", account: "Hanami_Walker" });
  });

  it("记录只在内存里：复位后为空", async () => {
    await failWith("account_service_down");
    resetMocks();
    const error = await refusal(stored(HANAMI, "t-off", true));
    expect(error.detail).toEqual({ field: "offlineFallback", reason: "no_recent_failure", account: "Hanami_Walker" });
  });

  it("offlineFallback 缺失或不是布尔值是 Tauri 自己的参数错误", async () => {
    const missing = await rejection(invoke("launch_game", { taskId: "t-1", versionId: "1.21", accountUuid: HANAMI, offlineName: null }));
    expect(missing.code).toBe("unknown");
    const wrongType = await rejection(invoke("launch_game", { taskId: "t-2", versionId: "1.21", accountUuid: HANAMI, offlineName: null, offlineFallback: "true" }));
    expect(wrongType.code).toBe("unknown");
    expect(wrongType.message).toBe("invalid args `offlineFallback` for command `launch_game`");
  });

  it("直达：单人按世界文件夹名、多人按地址原文通过检查后照常走完八个阶段，mock 记下这次的 quickPlay", async () => {
    const { phases } = await recordEvents();
    const world = { kind: "singleplayer", world_dir_name: "New World" } as const;
    expect(await launchGame({ ...offline("樱花生存", "t-sp"), quickPlay: world })).toEqual({ pid: 4242, offline: false });
    expect(lastMockQuickPlay()).toEqual(world);
    expect(phases.map((p) => p.stage_index).at(-1)).toBe(7);
    await stopGame();
    // 1.20 之前的版本只是不能直达存档，加入服务器照常
    const server = { kind: "multiplayer", address: " play.example:25570 " } as const;
    expect(await launchGame({ ...offline("RLCraft", "t-mp"), quickPlay: server })).toEqual({ pid: 4242, offline: false });
    expect(lastMockQuickPlay()).toEqual(server);
    await stopGame();
    await launchGame(offline("1.21", "t-plain"));
    expect(lastMockQuickPlay()).toBeNull();
  });

  it("直达的三项检查：版本不支持、世界不在、地址不合法各报各的码，之后照常能启动", async () => {
    const unsupported = await rejection(launchGame({ ...offline("RLCraft", "t-1"), quickPlay: { kind: "singleplayer", world_dir_name: "x" } }));
    expect(unsupported.code).toBe(QUICK_PLAY_UNSUPPORTED_CODE);
    expect(unsupported.detail).toEqual({ version_id: "RLCraft", mode: "singleplayer" });
    expect(unsupported.message).toBe("版本 RLCraft 不支持直接进入存档（1.20 之前的版本没有 Quick Play）");
    // 世界名与文件夹名不同：只认文件夹名
    const byLevelName = await rejection(launchGame({ ...offline("樱花生存", "t-2"), quickPlay: { kind: "singleplayer", world_dir_name: "樱花谷" } }));
    expect(byLevelName.code).toBe("world_not_found");
    expect(byLevelName.detail).toEqual({ version_id: "樱花生存", world: "樱花谷" });
    const badAddress = await rejection(launchGame({ ...offline("1.21", "t-3"), quickPlay: { kind: "multiplayer", address: "host:0" } }));
    expect(badAddress.code).toBe("invalid_argument");
    expect(badAddress.detail).toMatchObject({ address: "host:0" });
    const broken = await rejection(launchGame({ ...offline("没装完", "t-4"), quickPlay: { kind: "multiplayer", address: "play.example" } }));
    expect(broken.detail).toEqual({ version_id: "没装完", mode: "multiplayer" });
    expect(lastMockQuickPlay()).toBeNull();
    expect(await launchGame(offline("1.21", "t-ok"))).toEqual({ pid: 4242, offline: false });
  });

  it("直达检查与后端同序，在占住游戏槽、实例并登记任务之后：槽被占报 busy、实例在忙报 instance_busy；检查没过时全部放开", async () => {
    const unsupportedWorld = { kind: "singleplayer", world_dir_name: "x" } as const;
    await launchGame(offline("1.21", "t-run"));
    const slotTaken = await rejection(launchGame({ ...offline("RLCraft", "t-1"), quickPlay: unsupportedWorld }));
    expect(slotTaken.code).toBe(BUSY_ERROR_CODE);
    await stopGame();

    const installing = acquireMockInstance("RLCraft", "installing");
    const held = await rejection(launchGame({ ...offline("RLCraft", "t-2"), quickPlay: unsupportedWorld }));
    expect(held).toMatchObject({ code: "instance_busy", detail: { id: "RLCraft", activity: "installing" } });
    installing.release();
    expect(lastMockQuickPlay()).toBeNull();

    const unsupported = await rejection(launchGame({ ...offline("RLCraft", "t-3"), quickPlay: unsupportedWorld }));
    expect(unsupported.code).toBe(QUICK_PLAY_UNSUPPORTED_CODE);
    expect(lastMockQuickPlay()).toBeNull();
    // 任务已结束、实例与游戏槽都已放开
    expect(await cancelTask("t-3")).toBe(false);
    expect(() => acquireMockInstance("RLCraft", "renaming").release()).not.toThrow();
    expect(await launchGame(offline("RLCraft", "t-ok"))).toEqual({ pid: 4242, offline: false });
  });

  it("quickPlay 形状不对是 Tauri 自己的参数错误；缺键等于普通启动", async () => {
    for (const quickPlay of ["New World", { kind: "realms", id: "1" }, { kind: "singleplayer" }, { kind: "multiplayer", address: "a", extra: 1 }]) {
      const error = await rejection(invoke("launch_game", { taskId: "t", versionId: "1.21", accountUuid: null, offlineName: "Steve", offlineFallback: false, quickPlay }));
      expect(error.code).toBe("unknown");
      expect(error.message).toContain("quickPlay");
    }
    expect(await invoke("launch_game", { taskId: "t-ok", versionId: "1.21", accountUuid: null, offlineName: "Steve", offlineFallback: false })).toEqual({ pid: 4242, offline: false });
    expect(lastMockQuickPlay()).toBeNull();
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

describe("降级启动的拒绝细节", () => {
  const refused = (detail: unknown) => new IpcError("invalid_argument", "Steve 不能以离线方式进单人", detail);

  it("invalid_argument 且 field 为 offlineFallback 时取出 reason 与账户名", () => {
    for (const reason of ["offline_account", "relogin_required", "no_recent_failure"] as const) {
      expect(offlineFallbackRefusal(refused({ field: OFFLINE_FALLBACK_FIELD, reason, account: "Steve" }))).toEqual({ field: "offlineFallback", reason, account: "Steve" });
    }
  });

  it("别的错误不是降级拒绝：别的码、别的 field、没有 detail、前端自己的 Error", () => {
    expect(offlineFallbackRefusal(new IpcError("account_service_down", "x", { field: OFFLINE_FALLBACK_FIELD, reason: "relogin_required", account: "Steve" }))).toBeNull();
    expect(offlineFallbackRefusal(refused({ field: "accountUuid", reason: "relogin_required", account: "Steve" }))).toBeNull();
    expect(offlineFallbackRefusal(refused(undefined))).toBeNull();
    expect(offlineFallbackRefusal(new Error("invalid_argument"))).toBeNull();
  });

  it("field 对上了而 reason 或账户名不合契约时直接抛出", () => {
    expect(() => offlineFallbackRefusal(refused({ field: OFFLINE_FALLBACK_FIELD, reason: "expired", account: "Steve" }))).toThrow("降级启动的拒绝细节不合契约");
    expect(() => offlineFallbackRefusal(refused({ field: OFFLINE_FALLBACK_FIELD, reason: "relogin_required" }))).toThrow("降级启动的拒绝细节不合契约");
  });
});

describe("自动备份事件", () => {
  const payload: WorldBackupEvent = {
    instance_id: "樱花生存",
    backed_up: ["New World"],
    failed: [{ world: "坏档", error: { code: "world_in_use", message: "这个存档正被游戏打开，退出游戏后再试", detail: { path: "D:/saves/坏档" } } }],
  };

  it("mock 推的自动备份结果原样送到 onWorldBackup，退订后不再收到", async () => {
    const got: WorldBackupEvent[] = [];
    const off = await onWorldBackup((e) => got.push(e));
    emitMockWorldBackup(payload);
    expect(got).toEqual([payload]);
    off();
    emitMockWorldBackup({ ...payload, backed_up: [] });
    expect(got).toHaveLength(1);
  });
});

describe("Tauri 窗口里", () => {
  beforeEach(() => {
    vi.stubGlobal("window", { __TAURI_INTERNALS__: {} });
  });

  it("onWorldBackup 订阅 aurora://world-backup，只把负载交给处理函数", async () => {
    vi.mocked(tauriListen).mockImplementationOnce(async (_event, handler) => {
      handler({ event: WORLD_BACKUP_EVENT, id: 1, payload: { instance_id: "a", backed_up: ["w"], failed: [] } });
      return () => undefined;
    });
    const got: WorldBackupEvent[] = [];
    await onWorldBackup((e) => got.push(e));
    expect(vi.mocked(tauriListen).mock.calls[0][0]).toBe("aurora://world-backup");
    expect(got).toEqual([{ instance_id: "a", backed_up: ["w"], failed: [] }]);
  });

  it("launchGame 只传实例、账户、降级标记、直达目标与取消句柄；playStats 传 range 对象", async () => {
    vi.mocked(tauriInvoke).mockResolvedValueOnce({ pid: 7, offline: false }).mockResolvedValueOnce({ pid: 8, offline: false }).mockResolvedValueOnce(null).mockResolvedValueOnce({});
    // 调用方多塞的键（旧接口的内存参数）不会被转发：命令只收这六项。
    const extra = { ...offline("1.21", "t-run"), maxMemoryMb: 4096 } as unknown as LaunchArgs;
    expect(await launchGame(extra)).toEqual({ pid: 7, offline: false });
    expect(await launchGame({ ...offline("1.21", "t-qp"), quickPlay: { kind: "multiplayer", address: "play.example" } })).toEqual({ pid: 8, offline: false });
    await stopGame();
    await playStats({ from: "2026-10-01", to: "2026-10-31" });
    expect(vi.mocked(tauriInvoke).mock.calls).toEqual([
      ["launch_game", { taskId: "t-run", versionId: "1.21", accountUuid: null, offlineFallback: false, offlineName: "Steve", quickPlay: null }],
      ["launch_game", { taskId: "t-qp", versionId: "1.21", accountUuid: null, offlineFallback: false, offlineName: "Steve", quickPlay: { kind: "multiplayer", address: "play.example" } }],
      ["stop_game", undefined],
      ["play_stats", { range: { from: "2026-10-01", to: "2026-10-31" } }],
    ]);
  });
});
