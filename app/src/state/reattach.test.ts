// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ACTION_ERROR } from "../copy/flows";
import type { LaunchLogDto } from "../ipc/diagnostics";
import { GAME_EXIT_EVENT, GAME_LOG_EVENT, type GameExitEvent, type GameLogEvent, type LogLineDto, type RunningGameDto } from "../ipc/launch";
import type { IpcRecorder } from "../test/fake-bridge";
import { bootOverrides, callsOf, deferred, emit, resetRecorder, runningGameInfo, settle, startedStore } from "../test/launcher";
import type { LauncherStore } from "./store";

const ipc = vi.hoisted((): IpcRecorder => ({ calls: [], overrides: new Map() }));
vi.mock("../ipc/bridge", async (orig) => (await import("../test/fake-bridge")).fakeBridge(await orig(), ipc));

const T0 = 1_720_000_000_000;
const GAME = runningGameInfo();

const exit = (versionId: string, patch: Partial<GameExitEvent> = {}): GameExitEvent => ({ version_id: versionId, exit_code: 0, crashed: false, killed: false, duration_ms: 60_000, ...patch });
const gameLine = (at: number, text: string): LogLineDto => ({ at, source: "game", level: "info", text });
const launchLog = (lines: LogLineDto[], startedAt = GAME.started_at): LaunchLogDto => ({ path: "D:/Games/.minecraft/versions/生存/logs/latest.log", started_at: startedAt, lines, omitted: 0, ended: null });

let store: LauncherStore | null = null;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
  resetRecorder(ipc);
  ipc.overrides.set("last_launch_log", () => null);
});
afterEach(() => {
  store?.stop();
  store = null;
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

async function boot(runningGame: RunningGameDto): Promise<LauncherStore> {
  bootOverrides(ipc, { runningGame });
  store = await startedStore();
  return store;
}

function toasts(s: LauncherStore): [string, string, string | undefined][] {
  return s.getState().toasts.map((t) => [t.tone, t.title, t.body]);
}

describe("开机找回运行中的游戏", () => {
  it("关闭前启动的一局：建运行态会话，时长从后端记下的进程起来时刻算，发一条接回通知", async () => {
    const s = await boot({ game: GAME, broken_record: null });
    expect(callsOf(ipc, "running_game")).toEqual([{}]);
    expect(s.getState().session).toMatchObject({
      instanceId: "生存",
      phase: "running",
      stageIndex: 8,
      progress: 1,
      startedAt: 1_719_999_000_000,
      runningSince: 1_719_999_009_000,
      phaseSince: T0,
      accountUuid: "00000000-0000-0000-0000-00000000a001",
      accountName: "Steve",
      accountKind: "microsoft",
      quickPlay: null,
      reattached: true,
    });
    expect(toasts(s)).toEqual([["info", "已接回还在运行的「生存」", undefined]]);
  });

  it("接回的一局能结束：走 stop_game 而不是取消，退出事件把会话结算为已结束", async () => {
    const s = await boot({ game: GAME, broken_record: null });
    ipc.overrides.set("stop_game", () => {
      emit(GAME_EXIT_EVENT, exit("生存", { exit_code: 1, crashed: true, killed: true }));
      return null;
    });
    await s.actions.stop();
    expect(callsOf(ipc, "stop_game")).toHaveLength(1);
    expect(callsOf(ipc, "cancel_task")).toEqual([]);
    expect(s.getState().session).toMatchObject({ phase: "stopped", stopReason: "killed", runningSince: 1_719_999_009_000 });
  });

  it("接回的一局崩溃：会话进入 crashed，照常读崩溃报告并发崩溃通知", async () => {
    const s = await boot({ game: GAME, broken_record: null });
    ipc.overrides.set("last_crash", () => null);
    emit(GAME_EXIT_EVENT, exit("生存", { exit_code: 1, crashed: true }));
    await settle();
    expect(s.getState().session).toMatchObject({ phase: "crashed", crash: { status: "unavailable" } });
    expect(callsOf(ipc, "last_crash")).toEqual([{ versionId: "生存" }]);
    expect(toasts(s).map(([tone, title]) => [tone, title])).toEqual([
      ["info", "已接回还在运行的「生存」"],
      ["error", "「生存」崩溃了"],
    ]);
  });

  it("渲染进程重载后找回的一局（不是接回的）：照样建运行态会话，不发接回通知；外置登录账户按账户 DTO 的同一套映射", async () => {
    const account = { uuid: "u-2", name: "Alex", account_type: "authlib_injector" as const };
    const s = await boot({ game: runningGameInfo({ reattached: false, account }), broken_record: null });
    expect(s.getState().session).toMatchObject({ phase: "running", accountUuid: "u-2", accountName: "Alex", accountKind: "authlib", reattached: true });
    expect(s.getState().toasts).toEqual([]);
  });

  it("没有运行中的游戏：不建会话、不发通知", async () => {
    const s = await boot({ game: null, broken_record: null });
    expect(s.getState().session).toBeNull();
    expect(s.getState().toasts).toEqual([]);
  });

  it("账户类型不在契约里：不建会话，按找回失败报错", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const account = { uuid: "u-3", name: "Herobrine", account_type: "littleskin" as never };
    const s = await boot({ game: runningGameInfo({ account }), broken_record: null });
    expect(s.getState().session).toBeNull();
    expect(toasts(s)).toEqual([["error", ACTION_ERROR.recoverGame, "未知的账户类型：littleskin"]]);
  });

  it("查询失败：发 error 通知，首查的切片照常就绪，不建会话", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    bootOverrides(ipc);
    ipc.overrides.set("running_game", () => {
      throw { code: "io", message: "记录目录读不出来" };
    });
    store = await startedStore();
    expect(store.getState().session).toBeNull();
    expect(toasts(store)).toEqual([["error", ACTION_ERROR.recoverGame, "记录目录读不出来"]]);
    expect(Object.values(store.getState().status).map((st) => st.kind)).toEqual(["ready", "ready", "ready", "ready", "ready", "ready"]);
    expect(errors).toHaveBeenCalledWith(ACTION_ERROR.recoverGame, expect.objectContaining({ code: "io" }));
  });
});

describe("找回与玩家操作、退出事件的先后", () => {
  it("查询在路上时玩家点了启动：已有活动会话，查询回来不覆盖", async () => {
    const answer = deferred<RunningGameDto>();
    bootOverrides(ipc);
    ipc.overrides.set("running_game", () => answer.promise);
    ipc.overrides.set("launch_game", () => deferred<never>().promise);
    store = await startedStore();
    void store.actions.launch("创造");
    await settle();
    const launching = store.getState().session;
    expect(launching).toMatchObject({ instanceId: "创造", phase: "preparing", reattached: false });

    answer.resolve({ game: GAME, broken_record: null });
    await settle();
    expect(store.getState().session).toBe(launching);
    expect(store.getState().toasts).toEqual([]);
  });

  it("查询在路上时这一局退出了：查询回来不再建运行态，否则会一直卡在运行中", async () => {
    const answer = deferred<RunningGameDto>();
    bootOverrides(ipc);
    ipc.overrides.set("running_game", () => answer.promise);
    store = await startedStore();
    emit(GAME_EXIT_EVENT, exit("生存"));
    answer.resolve({ game: GAME, broken_record: null });
    await settle();
    expect(store.getState().session).toBeNull();
    expect(store.getState().toasts).toEqual([]);
  });

  it("查询在路上时退出的是别的实例：这一局照样接回", async () => {
    const answer = deferred<RunningGameDto>();
    bootOverrides(ipc);
    ipc.overrides.set("running_game", () => answer.promise);
    store = await startedStore();
    emit(GAME_EXIT_EVENT, exit("创造"));
    answer.resolve({ game: GAME, broken_record: null });
    await settle();
    expect(store.getState().session).toMatchObject({ instanceId: "生存", phase: "running" });
  });
});

describe("读不出的游戏记录", () => {
  it("改名留存了：warning 通知写移到了哪里与补不上的东西，「复制错误信息」带原文与两个路径", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const writeText = vi.fn(() => Promise.resolve());
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    const broken = { path: "D:/Games/data/running-game.json", moved_to: "D:/Games/data/running-game.broken-1720000000.json", message: "expected value at line 1 column 1" };
    const s = await boot({ game: null, broken_record: broken });
    expect(toasts(s)).toEqual([
      ["warning", "上次关闭前那局游戏的记录读不出来", "记录已移到 D:/Games/data/running-game.broken-1720000000.json，这一局的游玩时长与崩溃诊断不会补记"],
    ]);
    const action = s.getState().toasts[0].action;
    if (action === undefined || !("run" in action)) throw new Error("通知没有可执行的操作");
    expect(action.label).toBe("复制错误信息");
    await action.run();
    expect(writeText).toHaveBeenCalledWith("expected value at line 1 column 1\nD:/Games/data/running-game.json\nD:/Games/data/running-game.broken-1720000000.json");
    expect(warn).toHaveBeenCalledWith("expected value at line 1 column 1", broken);
  });

  it("改名也失败了：正文说没能移走、还在原处，复制的只有原文与原路径；同时接回的游戏照常建会话", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const writeText = vi.fn(() => Promise.resolve());
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    const broken = { path: "D:/Games/data/running-game.json", moved_to: null, message: "拒绝访问。 (os error 5)" };
    const s = await boot({ game: runningGameInfo({ version_id: "创造" }), broken_record: broken });
    expect(toasts(s)).toEqual([
      ["warning", "上次关闭前那局游戏的记录读不出来", "记录没能移走，还在 D:/Games/data/running-game.json，这一局的游玩时长与崩溃诊断不会补记"],
      ["info", "已接回还在运行的「创造」", undefined],
    ]);
    const action = s.getState().toasts[0].action;
    if (action === undefined || !("run" in action)) throw new Error("通知没有可执行的操作");
    await action.run();
    expect(writeText).toHaveBeenCalledWith("拒绝访问。 (os error 5)\nD:/Games/data/running-game.json");
    expect(s.getState().session).toMatchObject({ instanceId: "创造", phase: "running" });
  });
});

describe("找回的会话垫上之前的日志", () => {
  it("读到这一局的会话日志：尾部垫在前面，读的期间推来的新行接在后面，重合的只留一份", async () => {
    const log = deferred<LaunchLogDto | null>();
    ipc.overrides.set("last_launch_log", () => log.promise);
    const s = await boot({ game: GAME, broken_record: null });
    expect(callsOf(ipc, "last_launch_log")).toEqual([{ versionId: "生存" }]);
    expect(s.getState().session?.logs).toEqual([]);

    emit(GAME_LOG_EVENT, { version_id: "生存", lines: [gameLine(T0 - 1000, "[Render thread/INFO]: 区块已加载"), gameLine(T0, "[Server thread/INFO]: Saving chunks")] } satisfies GameLogEvent);
    log.resolve(launchLog([gameLine(T0 - 3000, "[main/INFO]: Loading Minecraft"), gameLine(T0 - 2000, "[Render thread/INFO]: 进入世界"), gameLine(T0 - 1000, "[Render thread/INFO]: 区块已加载")]));
    await settle();
    expect(s.getState().session?.logs.map((l) => l.text)).toEqual([
      "[main/INFO]: Loading Minecraft",
      "[Render thread/INFO]: 进入世界",
      "[Render thread/INFO]: 区块已加载",
      "[Server thread/INFO]: Saving chunks",
    ]);
  });

  it("读到的会话日志不是这一局的（开始时刻对不上）：不垫，留一条控制台警告", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    ipc.overrides.set("last_launch_log", () => launchLog([gameLine(T0 - 9_000_000, "上一局的输出")], GAME.started_at - 9_000_000));
    const s = await boot({ game: GAME, broken_record: null });
    expect(s.getState().session?.logs).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("读回来时会话已换成别的一局：不写进新的那一局", async () => {
    const log = deferred<LaunchLogDto | null>();
    ipc.overrides.set("last_launch_log", () => log.promise);
    ipc.overrides.set("launch_game", () => deferred<never>().promise);
    const s = await boot({ game: GAME, broken_record: null });
    emit(GAME_EXIT_EVENT, exit("生存"));
    s.actions.dismissSession();
    void s.actions.launch("生存");
    await settle();
    expect(s.getState().session).toMatchObject({ phase: "preparing", reattached: false, logs: [] });

    log.resolve(launchLog([gameLine(T0 - 3000, "[main/INFO]: Loading Minecraft")]));
    await settle();
    expect(s.getState().session).toMatchObject({ phase: "preparing", logs: [] });
  });

  it("日志读不出来：会话照样在运行，发一条 error 通知", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    ipc.overrides.set("last_launch_log", () => {
      throw { code: "io", message: "日志文件被占用" };
    });
    const s = await boot({ game: GAME, broken_record: null });
    expect(s.getState().session).toMatchObject({ phase: "running", logs: [] });
    expect(toasts(s)).toEqual([
      ["info", "已接回还在运行的「生存」", undefined],
      ["error", ACTION_ERROR.backfillSessionLog, "日志文件被占用"],
    ]);
  });
});
