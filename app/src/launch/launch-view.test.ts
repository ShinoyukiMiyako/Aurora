import { describe, expect, it } from "vitest";
import type { InstanceSummary } from "../domain/adapt";
import type { Task } from "../domain/types";
import { applyPhase, sessionCancelled, sessionCrashClue, sessionExited, sessionFailed, sessionLaunched, startSession, type SessionState } from "../state/session";
import type { LauncherState } from "../state/store";
import { newTask } from "../state/tasks";
import type { AssemblyClock } from "../art/iso/AssemblingBlock";
import { avatarIndicator, ringGeometry } from "./InstanceAvatar";
import { capsuleSwap } from "../lib/motion";
import { capsuleLayoutKey, faceKey, fillOf, holdFor, placedForProgress, placedForStage, TEXT_SLOTS } from "./LaunchCapsule";
import { brokenAction, launchFailure, launchView, sessionDetail, stageLabel, type LaunchView } from "./launchView";

const T0 = 1_720_000_000_000;
const ACCOUNT = { uuid: "u-1", name: "Steve", kind: "microsoft" as const };

function inst(id: string, overrides: Partial<InstanceSummary> = {}): InstanceSummary {
  return {
    id,
    name: id,
    mcVersion: "1.21.1",
    loader: "vanilla",
    loaderVersion: null,
    extraLoaders: [],
    releaseType: "release",
    javaMajor: 21,
    quickPlay: { singleplayer: true, multiplayer: true },
    description: null,
    cover: null,
    coverImage: null,
    background: "follow",
    backgroundImage: null,
    pinned: false,
    status: "ready",
    brokenReason: null,
    createdAt: null,
    lastPlayedAt: null,
    playtimeMin: 0,
    playError: null,
    dirError: null,
    modCount: 0,
    worldCount: 0,
    isolated: false,
    memoryMb: null,
    modpack: null,
    modpackError: null,
    lastCrashAt: null,
    lastCrashError: null,
    activity: null,
    usedBy: null,
    baseBusy: null,
    settingsError: null,
    incomplete: null,
    placeholder: false,
    ...overrides,
  };
}

function state(overrides: Partial<LauncherState>): LauncherState {
  return {
    status: { settings: { kind: "ready" }, accounts: { kind: "ready" }, instances: { kind: "ready" }, pins: { kind: "ready" }, tasks: { kind: "ready" }, firstRun: { kind: "ready" } },
    settings: null,
    accounts: [],
    currentAccountId: null,
    instances: [],
    selectedInstanceId: null,
    sidebarPins: [],
    firstRun: false,
    session: null,
    tasks: [],
    unseenFailures: 0,
    toasts: [],
    login: null,
    launchPrompt: null,
    lastRename: null,
    lastMove: null,
    ...overrides,
  };
}

const loading = (instanceId: string, stage = 0): SessionState => {
  const s = startSession(instanceId, "launch-1", ACCOUNT, T0, null);
  return stage === 0 ? s : applyPhase(s, { taskId: "launch-1", phase: stage < 4 ? "preparing" : stage === 4 ? "downloading" : "launching", stageIndex: stage, download: null }, T0);
};
const running = (instanceId: string) => sessionLaunched(loading(instanceId), "launch-1", T0 + 1000);

function installTask(instanceId: string, id: string, status: Task["status"], progress = 0): Task {
  return { ...newTask({ id, kind: "game", title: `安装 ${instanceId}`, detail: "", instanceId, spec: { command: "install_version", args: { targetName: instanceId } } }, T0), status, progress };
}

describe("启动视图判定", () => {
  it("会话优先于实例自身状态：损坏的实例在加载时呈现加载", () => {
    const broken = inst("B", { status: "broken", brokenReason: "版本 JSON 缺失" });
    expect(launchView(state({ session: loading("B") }), broken).kind).toBe("loading");
    expect(launchView(state({}), broken)).toEqual({ kind: "broken", reason: "版本 JSON 缺失", reimport: false });
    expect(() => launchView(state({}), inst("X", { status: "broken" }))).toThrow("损坏但没有原因");
  });

  it("整合包没导入完的损坏实例：入口是重新导入整合包，不是修复并启动", () => {
    const marker = (kind: "install" | "modpack") => ({ kind, outcome: "failed" as const, startedAt: null, spec: null, error: null });
    const pack = launchView(state({}), inst("P", { status: "broken", brokenReason: "整合包没有导入完", incomplete: marker("modpack") }));
    expect(pack).toEqual({ kind: "broken", reason: "整合包没有导入完", reimport: true });
    if (pack.kind !== "broken") throw new Error("应为损坏视图");
    expect(brokenAction(pack)).toEqual({ label: "重新导入整合包", icon: "modpack" });

    const install = launchView(state({}), inst("I", { status: "broken", brokenReason: "安装没有完成", incomplete: marker("install") }));
    if (install.kind !== "broken") throw new Error("应为损坏视图");
    expect(install.reimport).toBe(false);
    expect(brokenAction(install)).toEqual({ label: "修复并启动", icon: "wrench" });
  });

  it("另一实例占着游戏进程时就绪带 busyElsewhere；那个会话结束后不再算占用", () => {
    const a = inst("A");
    expect(launchView(state({ session: running("B") }), a)).toEqual({ kind: "ready", busyElsewhere: true });
    const ended = sessionExited(running("B"), { versionId: "B", crashed: false, killed: false }, T0 + 5000);
    expect(launchView(state({ session: ended }), a)).toEqual({ kind: "ready", busyElsewhere: false });
  });

  it("会话各阶段对应各自的视图", () => {
    const a = inst("A");
    expect(launchView(state({ session: loading("A", 4) }), a)).toMatchObject({ kind: "loading", phase: "downloading" });
    expect(launchView(state({ session: running("A") }), a).kind).toBe("running");
    expect(launchView(state({ session: sessionCancelled(loading("A"), "launch-1", T0) }), a)).toMatchObject({ kind: "stopped", reason: "cancelled" });
    const failed = sessionFailed(loading("A"), "launch-1", { code: "disk_full", params: { drive: "C:", needed_bytes: 1_073_741_824 } }, T0);
    expect(launchView(state({ session: failed }), a)).toMatchObject({ kind: "failed", code: "disk_full" });
    const crashed = sessionExited(running("A"), { versionId: "A", crashed: true, killed: false }, T0 + 9000);
    expect(launchView(state({ session: crashed }), a).kind).toBe("crashed");
  });

  it("安装中：排队给出名次，进行中名次为 null，后端标记但前端没有任务时 task 为 null", () => {
    const a = inst("A", { status: "installing" });
    const tasks = [installTask("Z", "t0", "queued"), installTask("A", "t1", "queued")];
    expect(launchView(state({ tasks }), a)).toMatchObject({ kind: "installing", queuePosition: 2, task: { id: "t1" } });
    expect(launchView(state({ tasks: [installTask("A", "t1", "running", 0.4)] }), a)).toMatchObject({ kind: "installing", queuePosition: null });
    expect(launchView(state({}), a)).toEqual({ kind: "installing", task: null, queuePosition: null });
  });
});

describe("会话第二行文案", () => {
  it("准备与启动写阶段名，下载写文件数与速度，总数未知时写正在统计", () => {
    expect(sessionDetail(loading("A"), T0)).toBe("验证账户");
    expect(sessionDetail(loading("A", 2), T0)).toBe("校验游戏文件");
    expect(sessionDetail(loading("A", 6), T0)).toBe("生成启动参数");
    const counting = loading("A", 4);
    expect(sessionDetail(counting, T0)).toBe("正在统计缺失文件…");
    const known = applyPhase(counting, { taskId: "launch-1", phase: "downloading", stageIndex: 4, download: { done: 120, total: 480, bytes: 1, totalBytes: 10, speedBps: 4.2 * 1024 * 1024 } }, T0);
    expect(sessionDetail(known, T0)).toBe("文件 120/480 · 4.2 MB/s");
  });

  it("阶段名按九阶段表取：下标 8 是游戏运行中，下标 9 越界", () => {
    expect(stageLabel(8)).toBe("游戏运行中");
    expect(() => stageLabel(9)).toThrow("阶段下标 9 超出九阶段表");
  });

  it("运行写已运行时长，结束写本次游玩分钟，取消写文件会保留", () => {
    expect(sessionDetail(running("A"), T0 + 1000 + 192_000)).toBe("已运行 03:12");
    const exited = sessionExited(running("A"), { versionId: "A", crashed: false, killed: false }, T0 + 1000 + 23 * 60_000 + 59_000);
    expect(sessionDetail(exited, T0 + 99_999_999)).toBe("本次游玩 23 分钟");
    const short = sessionExited(running("A"), { versionId: "A", crashed: false, killed: true }, T0 + 30_000);
    expect(sessionDetail(short, T0 + 30_000)).toBe("本次游玩不到 1 分钟");
    expect(sessionDetail(sessionCancelled(loading("A"), "launch-1", T0), T0)).toBe("已下载的文件会保留");
  });

  it("失败写失败标题；崩溃读出线索前没有副行，读出后写线索或未匹配", () => {
    const failed = sessionFailed(loading("A"), "launch-1", { code: "java_too_old", params: { current: 17, major: 21, mc_version: "1.21.1", pinned_by: "instance" } }, T0);
    expect(sessionDetail(failed, T0)).toBe("Java 17 无法运行 1.21.1");
    const crashed = sessionExited(running("A"), { versionId: "A", crashed: true, killed: false }, T0 + 5000);
    expect(sessionDetail(crashed, T0)).toBeNull();
    expect(sessionDetail(sessionCrashClue(crashed, "A", { status: "known", category: "out_of_memory" }), T0)).toBe("日志指向内存不足");
    expect(sessionDetail(sessionCrashClue(crashed, "A", { status: "known", category: null }), T0)).toBe("没有匹配到已知原因");
    expect(sessionDetail(sessionCrashClue(crashed, "A", { status: "unavailable" }), T0)).toBe("没有匹配到已知原因");
  });

  it("手动触发的崩溃写彩蛋，不写日志指向", () => {
    const crashed = sessionExited(running("A"), { versionId: "A", crashed: true, killed: false }, T0 + 5000);
    expect(sessionDetail(sessionCrashClue(crashed, "A", { status: "known", category: "manual_debug_crash" }), T0)).toBe("你认真的吗...?");
  });

  it("线索只有退出码兜底：写「退出码指向」，日志里并没有规则命中", () => {
    const crashed = sessionExited(running("A"), { versionId: "A", crashed: true, killed: false }, T0 + 5000);
    expect(sessionDetail(sessionCrashClue(crashed, "A", { status: "known", category: "native_crash" }), T0)).toBe("退出码指向进程异常退出");
  });

  it("spawn_failed 的第二个按钮只在实例固定了 Java 时出现；账户名取自会话", () => {
    const failed = sessionFailed(loading("A"), "launch-1", { code: "spawn_failed", params: { message: "CreateProcess error=2" } }, T0);
    const view = launchView(state({ session: failed }), inst("A")) as Extract<LaunchView, { kind: "failed" }>;
    expect(launchFailure(view, false)).toMatchObject({ title: "游戏进程没能启动", body: "CreateProcess error=2", fix: { kind: "open_logs" }, secondary: null });
    expect(launchFailure(view, true).secondary).toEqual({ kind: "auto_java", label: "改为自动选择 Java" });
    const relogin = sessionFailed(loading("A"), "launch-1", { code: "account_relogin", params: { account: "Steve" } }, T0);
    const reloginView = launchView(state({ session: relogin }), inst("A")) as Extract<LaunchView, { kind: "failed" }>;
    expect(launchFailure(reloginView, false).body).toBe("Steve 的登录已失效。");
  });

  it("固定 Java 的失败按固定在哪一层给出修复：全局固定改默认 Java，实例固定改实例；没说固定在哪一层抛错", () => {
    const failedWith = (code: "java_too_old" | "java_pinned_missing", params: Record<string, string | number>) => {
      const failed = sessionFailed(loading("A"), "launch-1", { code, params }, T0);
      return launchFailure(launchView(state({ session: failed }), inst("A")) as Extract<LaunchView, { kind: "failed" }>, false);
    };
    const old = { current: 8, major: 17, mc_version: "1.18.2" };
    expect(failedWith("java_too_old", { ...old, pinned_by: "global" })).toEqual({
      title: "Java 8 无法运行 1.18.2",
      body: "Minecraft 1.18.2 至少需要 Java 17，设置里把默认 Java 固定成了 Java 8。",
      fix: { kind: "auto_default_java", label: "默认 Java 改回自动" },
      secondary: { kind: "pick_java", label: "选择 Java" },
    });
    expect(failedWith("java_too_old", { ...old, pinned_by: "instance" })).toEqual({
      title: "Java 8 无法运行 1.18.2",
      body: "Minecraft 1.18.2 至少需要 Java 17。",
      fix: { kind: "auto_java", label: "改为自动选择" },
      secondary: null,
    });
    expect(failedWith("java_pinned_missing", { path: "D:/jdk8/bin/java.exe", pinned_by: "global" })).toEqual({
      title: "默认 Java 不存在",
      body: "设置里固定的默认 Java 已经找不到了：D:/jdk8/bin/java.exe。",
      fix: { kind: "auto_default_java", label: "默认 Java 改回自动" },
      secondary: { kind: "pick_java", label: "选择 Java" },
    });
    expect(failedWith("java_pinned_missing", { path: "D:/jdk8/bin/java.exe", pinned_by: "instance" })).toMatchObject({ title: "指定的 Java 不存在", fix: { kind: "auto_java" } });
    expect(() => failedWith("java_pinned_missing", { path: "D:/jdk8/bin/java.exe" })).toThrow("启动失败码 java_pinned_missing 缺少插值参数 pinned_by");
    expect(() => failedWith("java_too_old", { ...old, pinned_by: "both" })).toThrow("启动失败码 java_too_old 的参数 pinned_by 不认识：both");
  });
});

describe("头像指示与胶囊换面", () => {
  it("24 什么都不画，32 只画角标，40 起画环", () => {
    const loadingView = launchView(state({ session: loading("A", 4) }), inst("A"));
    expect(avatarIndicator(loadingView, 24)).toEqual({ type: "none" });
    expect(avatarIndicator(loadingView, 32)).toEqual({ type: "none" });
    expect(avatarIndicator(loadingView, 40)).toEqual({ type: "ring", tone: "accent", progress: 0.3, track: "launch-1" });
    const runningView = launchView(state({ session: running("A") }), inst("A"));
    expect(avatarIndicator(runningView, 24)).toEqual({ type: "none" });
    expect(avatarIndicator(runningView, 32)).toEqual({ type: "badge", tone: "ok" });
    expect(avatarIndicator({ kind: "broken", reason: "x", reimport: false }, 56)).toEqual({ type: "badge", tone: "warn" });
    expect(avatarIndicator({ kind: "installing", task: null, queuePosition: null }, 44)).toEqual({ type: "queued" });
    expect(avatarIndicator({ kind: "ready", busyElsewhere: true }, 56)).toEqual({ type: "none" });
  });

  it("安装连跑两批：换了批次环的标识跟着换，第二批从当批进度重新走；同一批内标识不变", () => {
    const first = { ...installTask("A", "t1", "running", 1), totalBytes: 3_000, bytes: 3_000 };
    const second = { ...first, progress: 0.05, totalBytes: 100_000, bytes: 5_000 };
    const ring = (task: Task) => avatarIndicator({ kind: "installing", task, queuePosition: null }, 40);
    const a = ring(first);
    const b = ring(second);
    if (a.type !== "ring" || b.type !== "ring") throw new Error("运行中的安装应画环");
    expect(b.track).not.toBe(a.track);
    expect(b.progress).toBe(0.05);
    const later = ring({ ...second, progress: 0.4, bytes: 40_000 });
    if (later.type !== "ring") throw new Error("运行中的安装应画环");
    expect(later.track).toBe(b.track);
  });

  it("安装连跑两批：启动胶囊的填充换了批次跟着换标识，第二批从当批进度重新走", () => {
    const first = { ...installTask("A", "t1", "running", 1), totalBytes: 3_000, bytes: 3_000 };
    const second = { ...first, progress: 0.05, totalBytes: 100_000, bytes: 5_000 };
    const fill = (task: Task) => fillOf({ kind: "installing", task, queuePosition: null }, false);
    const a = fill(first);
    const b = fill(second);
    if (a === null || b === null) throw new Error("运行中的安装应有填充");
    expect(b.track).not.toBe(a.track);
    expect(b.value).toBe(0.05);
    expect(fill({ ...second, progress: 0.4, bytes: 40_000 })?.track).toBe(b.track);
  });

  it("状态环是外扩 4 的圆角方框，从上边中点起，周长 = 4 × 直边 + 2πr", () => {
    const g = ringGeometry(40);
    expect(g.box).toBe(48);
    expect(g.path.startsWith("M 24 1.25")).toBe(true);
    // 40 的头像圆角 12，环圆角 14.5；直边 = 48 − 2.5 − 29
    expect(g.length).toBeCloseTo(4 * 16.5 + 2 * Math.PI * 14.5, 10);
  });

  it("方块按阶段落面：准备 1、下载 2、启动 3；安装按进度三分", () => {
    expect([0, 3, 4, 5, 7].map(placedForStage)).toEqual([1, 1, 2, 3, 3]);
    expect([0, 0.33, 1 / 3, 0.66, 2 / 3, 1].map(placedForProgress)).toEqual([1, 1, 2, 2, 3, 3]);
  });

  describe("换面前留住旧面", () => {
    const a = inst("A");
    const prev = launchView(state({ session: loading("A", 4) }), a);
    const cancelled = launchView(state({ session: sessionCancelled(loading("A", 4), "launch-1", T0) }), a);
    const failed = launchView(state({ session: sessionFailed(loading("A"), "launch-1", { code: "version_broken", params: {} }, T0) }), a);
    const runningView = launchView(state({ session: running("A") }), a);
    const now = 50_000;
    /** 面早就落定了（挂载时就在，或落下已久）。 */
    const settledAt = (shown: number): AssemblyClock => ({ shown, lastDropAt: Number.NEGATIVE_INFINITY, firstDropAt: Number.NEGATIVE_INFINITY });

    it("拆解与崩落按实际已落的面数演完：逆序逐面错开一个间隔，最后一面演满一段；一面未落时不留", () => {
      expect(holdFor(prev, cancelled, settledAt(3), now)).toEqual({ face: prev, exit: "disassemble", seat: false, ms: 2 * 50 + 140 });
      expect(holdFor(prev, cancelled, settledAt(2), now)?.ms).toBe(50 + 140);
      // 启动阶段已落 3 面：崩落要 2 × 40 + 220，不在最后一面落到一半时换面
      expect(holdFor(prev, failed, settledAt(3), now)).toEqual({ face: prev, exit: "collapse", seat: false, ms: 2 * 40 + 220 });
      expect(holdFor(prev, failed, settledAt(2), now)?.ms).toBe(40 + 220);
      expect(holdFor(prev, failed, settledAt(1), now)?.ms).toBe(220);
      expect(holdFor(prev, failed, settledAt(0), now)).toBeNull();
      expect(holdFor(prev, launchView(state({ session: sessionExited(running("A"), { versionId: "A", crashed: true, killed: false }, T0 + 5000) }), a), settledAt(3), now)?.exit).toBe("collapse");
    });

    it("坐定：未落的面隔着落位间隔依次落齐，最后一面落下 120 ms 后坐定，再停 200 ms 才换到运行面", () => {
      expect(holdFor(prev, runningView, settledAt(2), now)).toEqual({ face: prev, exit: null, seat: true, ms: 120 + capsuleSwap.holdMs.afterSeat });
      expect(holdFor(prev, runningView, settledAt(1), now)?.ms).toBe(90 + 120 + 200);
      expect(holdFor(prev, runningView, settledAt(3), now)?.ms).toBe(200);
      // 最后一面 50 ms 前才落下：坐定还差 70 ms
      expect(holdFor(prev, runningView, { shown: 3, lastDropAt: now - 50, firstDropAt: Number.NEGATIVE_INFINITY }, now)?.ms).toBe(70 + 200);
    });

    it("坐定时刻按方块实际进度算：加载面刚换上还在等首落延迟、阶段一次跳了几级面还没落齐，都不提前换面", () => {
      // 加载面 50 ms 前才换上：首落还要 110 ms，之后两面各隔 90 ms
      expect(holdFor(prev, runningView, { shown: 0, lastDropAt: Number.NEGATIVE_INFINITY, firstDropAt: now + 110 }, now)?.ms).toBe(110 + 90 + 90 + 120 + 200);
      // 落位数刚从 1 跳到 3：第二面 30 ms 前才落下，第三面要等满间隔
      expect(holdFor(prev, runningView, { shown: 2, lastDropAt: now - 30, firstDropAt: Number.NEGATIVE_INFINITY }, now)?.ms).toBe(60 + 120 + 200);
      // 安装中换到就绪同理
      const installing = launchView(state({ tasks: [installTask("A", "t1", "running", 0.9)] }), inst("A", { status: "installing" }));
      expect(installing.kind).toBe("installing");
      expect(holdFor(installing, { kind: "ready", busyElsewhere: false }, { shown: 1, lastDropAt: now - 10, firstDropAt: now - 10 }, now)).toEqual({
        face: installing,
        exit: null,
        seat: true,
        ms: 80 + 90 + 120 + 200,
      });
    });

    it("其余换面不留；要留时方块却没报过进度是状态不一致，直接抛", () => {
      expect(holdFor({ kind: "ready", busyElsewhere: false }, prev, null, now)).toBeNull();
      expect(holdFor(runningView, failed, null, now)).toBeNull();
      expect(() => holdFor(prev, runningView, null, now)).toThrow(/组装进度/);
      expect(faceKey(cancelled)).toBe("stopped:cancelled");
      expect(faceKey(prev)).toBe("loading");
    });
  });
});

describe("胶囊宽度：文字槽与布局测量的依据", () => {
  const entryOf = (name: string) => ({ instance: inst(name), failure: null });
  const key = (face: LaunchView, name = "A") => capsuleLayoutKey(face, entryOf(name), "lg", false, false);
  const downloading = (done: number, total: number, speedBps: number) =>
    applyPhase(loading("A", 4), { taskId: "launch-1", phase: "downloading", stageIndex: 4, download: { done, total, bytes: done, totalBytes: total, speedBps } }, T0);

  it("加载面里阶段、进度、文件数与速度怎么变都不重新量布局；换面才量", () => {
    const a = inst("A");
    const sessions = [loading("A"), loading("A", 2), downloading(9, 480, 900 * 1024), downloading(120, 480, 10.4 * 1024 * 1024), loading("A", 6)];
    expect(new Set(sessions.map((s) => s.progress)).size).toBeGreaterThan(1);
    const keys = sessions.map((s) => key(launchView(state({ session: s }), a)));
    expect(new Set(keys).size).toBe(1);
    expect(key(launchView(state({ session: running("A") }), a))).not.toBe(keys[0]);
  });

  it("运行面的计时不进依据（标题按两位小时占位），实例名进：改了名才量", () => {
    const early = launchView(state({ session: sessionLaunched(loading("A"), "launch-1", T0 + 1000) }), inst("A"));
    const late = launchView(state({ session: sessionLaunched(loading("A"), "launch-1", T0 - 3 * 3_600_000) }), inst("A"));
    expect(key(early)).toBe(key(late));
    expect(key(early, "A")).not.toBe(key(early, "生存二"));
  });

  it("崩溃线索读出来前后同一个依据：副行按全部线索占位，线索到了只换字", () => {
    const crashed = sessionExited(running("A"), { versionId: "A", crashed: true, killed: false }, T0 + 5000);
    const clue = sessionCrashClue(crashed, "A", { status: "known", category: "out_of_memory" });
    expect(key(launchView(state({ session: crashed }), inst("A")))).toBe(key(launchView(state({ session: clue }), inst("A"))));
    expect(TEXT_SLOTS.crashSub).toContain(sessionDetail(clue, T0));
    expect(TEXT_SLOTS.crashSub).toContain(sessionDetail(sessionCrashClue(crashed, "A", { status: "unavailable" }), T0));
  });

  it("安装中：百分比不进依据，换步骤进", () => {
    const phase = (index: number) => ({ plan: ["metadata", "libraries", "assets"] as const, index, batch: null });
    const task: Task = { ...installTask("A", "t1", "running", 0.2), phase: phase(0) };
    const at = (t: Task) => key({ kind: "installing", task: t, queuePosition: null });
    expect(at({ ...task, progress: 0.7 })).toBe(at(task));
    expect(at({ ...task, phase: phase(1) })).not.toBe(at(task));
  });

  it("加载面的槽覆盖它会显示的每一种文字：全部阶段名、正在结束、阶段说明与最宽的下载进度", () => {
    expect(TEXT_SLOTS.loadingTitle).toEqual(expect.arrayContaining(["验证账户", "下载缺失文件", "启动游戏进程", "正在结束…"]));
    expect(TEXT_SLOTS.loadingSub).toEqual(expect.arrayContaining(["准备中", "下载中", "启动中", "正在统计缺失文件…", "文件 9999/9999 · 1000 KB/s", "文件 9999/9999 · 99.9 MB/s"]));
    expect(TEXT_SLOTS.percent).toEqual(["99%"]);
    expect(TEXT_SLOTS.runningTitle).toEqual(["游戏中 · 99:59:59", "正在结束…"]);
  });
});
