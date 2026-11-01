import { describe, expect, it } from "vitest";
import type { InstanceSummary } from "../domain/adapt";
import type { Task } from "../domain/types";
import { applyPhase, sessionCancelled, sessionCrashClue, sessionExited, sessionFailed, sessionLaunched, startSession, type SessionState } from "../state/session";
import type { LauncherState } from "../state/store";
import { newTask } from "../state/tasks";
import { avatarIndicator, ringGeometry } from "./InstanceAvatar";
import { faceKey, fillOf, holdFor, placedForProgress, placedForStage, FACE_HOLD_MS } from "./LaunchCapsule";
import { brokenAction, launchFailure, launchView, sessionDetail, type LaunchView } from "./launchView";

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
    ...overrides,
  };
}

const loading = (instanceId: string, stage = 0): SessionState => {
  const s = startSession(instanceId, "launch-1", ACCOUNT, T0, null);
  return stage === 0 ? s : applyPhase(s, { taskId: "launch-1", phase: stage < 3 ? "preparing" : stage === 3 ? "downloading" : "launching", stageIndex: stage, download: null }, T0);
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
    expect(launchView(state({ session: loading("A", 3) }), a)).toMatchObject({ kind: "loading", phase: "downloading" });
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
    expect(sessionDetail(loading("A", 1), T0)).toBe("校验游戏文件");
    expect(sessionDetail(loading("A", 5), T0)).toBe("生成启动参数");
    const counting = loading("A", 3);
    expect(sessionDetail(counting, T0)).toBe("正在统计缺失文件…");
    const known = applyPhase(counting, { taskId: "launch-1", phase: "downloading", stageIndex: 3, download: { done: 120, total: 480, bytes: 1, totalBytes: 10, speedBps: 4.2 * 1024 * 1024 } }, T0);
    expect(sessionDetail(known, T0)).toBe("文件 120/480 · 4.2 MB/s");
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
    const loadingView = launchView(state({ session: loading("A", 3) }), inst("A"));
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
    expect([0, 2, 3, 4, 6].map(placedForStage)).toEqual([1, 1, 2, 3, 3]);
    expect([0, 0.33, 1 / 3, 0.66, 2 / 3, 1].map(placedForProgress)).toEqual([1, 1, 2, 2, 3, 3]);
  });

  it("加载换到取消、失败、运行时先留住旧面演完方块动画；其余直接换", () => {
    const a = inst("A");
    const prev = launchView(state({ session: loading("A", 3) }), a);
    const cancelled = launchView(state({ session: sessionCancelled(loading("A", 3), "launch-1", T0) }), a);
    expect(holdFor(prev, cancelled)).toMatchObject({ exit: "disassemble", seat: false, ms: FACE_HOLD_MS.disassemble });
    const failed = launchView(state({ session: sessionFailed(loading("A"), "launch-1", { code: "version_broken", params: {} }, T0) }), a);
    expect(holdFor(prev, failed)).toMatchObject({ exit: "collapse", ms: FACE_HOLD_MS.collapse });
    // 下载阶段已落 2 面：剩 1 面立即落下，120 ms 后坐定，再过 200 ms 换到运行面
    expect(holdFor(prev, launchView(state({ session: running("A") }), a))).toMatchObject({ exit: null, seat: true, ms: 120 + 200 });
    const launchingPrev = launchView(state({ session: loading("A", 6) }), a);
    expect(holdFor(launchingPrev, launchView(state({ session: running("A") }), a))?.ms).toBe(200);
    expect(holdFor({ kind: "ready", busyElsewhere: false }, prev)).toBeNull();
    expect(faceKey(cancelled)).toBe("stopped:cancelled");
    expect(faceKey(prev)).toBe("loading");
  });
});
