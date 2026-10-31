// @vitest-environment jsdom
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LAUNCH_COPY, LAUNCH_STAGES, PHASE_LABEL, SESSION_COPY, STOPPED_LABEL } from "../copy/flows";
import { stubCanvas } from "../art/illustrations/test-canvas";
import { LAUNCH_PHASE_EVENT } from "../ipc/launch";
import { LauncherProvider, useLauncher, type LauncherApi } from "../state/launcher";
import { startSession, type SessionState } from "../state/session";
import { render, stubMatchMedia, stubResizeObserver, type Rendered } from "../test/dom";
import type { IpcRecorder } from "../test/fake-bridge";
import { bootOverrides, callsOf, deferred, emit, instanceDto, resetRecorder, settle } from "../test/launcher";
import { ISLAND_COPY } from "../copy/shell";
import { OverlayRoot } from "./overlay";
import { ShellProvider } from "./shell";
import { downloadStageNote, islandSecond, islandTone, stageState, StatusIsland } from "./StatusIsland";

const ipc = vi.hoisted((): IpcRecorder => ({ calls: [], overrides: new Map() }));
vi.mock("../ipc/bridge", async (orig) => (await import("../test/fake-bridge")).fakeBridge(await orig(), ipc));

const T0 = 1_700_000_000_000;

function session(patch: Partial<SessionState>): SessionState {
  return { ...startSession("生存", "launch-1", { uuid: "u", name: "Steve" }, T0), ...patch };
}

describe("状态岛收起态的第二段", () => {
  it("加载阶段：regular 档写阶段名与百分比，封顶 99%", () => {
    const s = session({ phase: "downloading", stageIndex: 3, progress: 0.995 });
    expect(islandSecond(s, "regular", T0, false)).toEqual({ label: PHASE_LABEL.downloading, value: "99%" });
  });

  it("加载阶段：compact 档只留百分比", () => {
    const s = session({ phase: "preparing", progress: 0.37 });
    expect(islandSecond(s, "compact", T0, false)).toEqual({ label: null, value: "37%" });
  });

  it("运行中：regular 写「已运行」，compact 只留计时", () => {
    const s = session({ phase: "running", runningSince: T0, stageIndex: 7, progress: 1 });
    expect(islandSecond(s, "regular", T0 + 65_000, false)).toEqual({ label: SESSION_COPY.running(65_000), value: null });
    expect(islandSecond(s, "compact", T0 + 65_000, false)).toEqual({ label: null, value: "01:05" });
  });

  it("正在结束盖过加载与运行的显示", () => {
    expect(islandSecond(session({ phase: "launching", progress: 0.9 }), "wide", T0, true)).toEqual({ label: SESSION_COPY.stopping, value: null });
  });

  it("已结束按原因写，compact 用短格式", () => {
    const cancelled = session({ phase: "stopped", stopReason: "cancelled" });
    expect(islandSecond(cancelled, "regular", T0, false).label).toBe(STOPPED_LABEL.cancelled);
    expect(islandSecond(cancelled, "compact", T0, false).label).toBe(ISLAND_COPY.shortCancelled);
    const exited = session({ phase: "stopped", stopReason: "exited", runningSince: T0 });
    expect(islandSecond(exited, "regular", T0, false).label).toBe(STOPPED_LABEL.exited);
    expect(islandSecond(exited, "compact", T0, false).label).toBe(ISLAND_COPY.shortEnded);
  });

  it("运行中缺运行起点是状态坏了，直接抛错", () => {
    expect(() => islandSecond(session({ phase: "running" }), "regular", T0, false)).toThrow("运行起点");
  });

  it("色调：加载、运行、失败与崩溃、已结束", () => {
    expect(islandTone(session({ phase: "launching" }))).toBe("loading");
    expect(islandTone(session({ phase: "running" }))).toBe("running");
    expect(islandTone(session({ phase: "failed" }))).toBe("danger");
    expect(islandTone(session({ phase: "crashed" }))).toBe("danger");
    expect(islandTone(session({ phase: "stopped" }))).toBe("neutral");
  });
});

describe("阶段清单", () => {
  it("当前阶段之前为完成、之后为未开始", () => {
    expect([0, 1, 2, 3, 4].map((i) => stageState(2, i))).toEqual(["done", "done", "now", "todo", "todo"]);
  });

  it("下载阶段进行中写文件数与速度；数量未知时不写", () => {
    expect(downloadStageNote(session({ stageIndex: 3, download: { done: 12, total: 40, bytes: 0, totalBytes: null, speedBps: 2048 } }))).toBe("12/40 · 2.0 KB/s");
    expect(downloadStageNote(session({ stageIndex: 3, download: { done: 0, total: null, bytes: 0, totalBytes: null, speedBps: 0 } }))).toBeNull();
  });

  it("越过下载阶段且没有下载记录：写「无需下载」；还没到下载阶段不写", () => {
    expect(downloadStageNote(session({ stageIndex: 5, download: null }))).toBe(SESSION_COPY.noDownload);
    expect(downloadStageNote(session({ stageIndex: 1, download: null }))).toBeNull();
  });
});

const pendingLaunch = deferred<never>();
let view: Rendered | undefined;
let launcher: LauncherApi;

function Probe() {
  launcher = useLauncher();
  return null;
}

const flush = () =>
  act(async () => {
    await settle();
  });

beforeEach(() => {
  vi.useFakeTimers();
  resetRecorder(ipc);
  stubResizeObserver();
  stubCanvas();
  stubMatchMedia(false);
  bootOverrides(ipc, { instances: [instanceDto("生存")] });
  ipc.overrides.set("art_status", () => ({ source: null, panorama: false }));
  ipc.overrides.set("launch_game", () => pendingLaunch.promise);
  ipc.overrides.set("cancel_task", () => true);
});
afterEach(() => {
  view?.unmount();
  view = undefined;
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("状态岛", () => {
  it("没有会话时不出现；启动后出现，点开列出阶段并能取消启动", async () => {
    view = render(
      <LauncherProvider>
        <ShellProvider>
          <Probe />
          <StatusIsland />
          <OverlayRoot />
        </ShellProvider>
      </LauncherProvider>,
    );
    await flush();
    expect(document.querySelector("[aria-haspopup='dialog']")).toBeNull();

    act(() => void launcher.actions.launch("生存"));
    await flush();
    const session = launcher.state.session;
    if (session === null) throw new Error("启动后应有会话");
    act(() => emit(LAUNCH_PHASE_EVENT, { task_id: session.taskId, phase: "downloading", stage_index: 3, download: { finished: 2, total: 10, bytes: 0, total_bytes: null, speed: 1024 } }));
    await flush();

    const island = document.querySelector<HTMLButtonElement>("[aria-haspopup='dialog']");
    if (island === null) throw new Error("状态岛没有出现");
    // jsdom 窗口宽 1024，按 compact 档只留百分比；阶段 3 起点 0.3，按文件数 2/10 推进到 0.39
    expect(island.getAttribute("aria-label")).toBe(ISLAND_COPY.label("生存", "39%"));

    act(() => island.click());
    await flush();
    const stages = [...document.querySelectorAll("[data-state]")].map((el) => [el.textContent, el.getAttribute("data-state")]);
    expect(stages.slice(0, 4)).toEqual([
      [LAUNCH_STAGES[0], "done"],
      [LAUNCH_STAGES[1], "done"],
      [LAUNCH_STAGES[2], "done"],
      [`${LAUNCH_STAGES[3]}2/10 · 1.0 KB/s`, "now"],
    ]);
    expect(stages).toHaveLength(LAUNCH_STAGES.length - 1);

    const cancel = [...document.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === LAUNCH_COPY.cancel);
    if (cancel === undefined) throw new Error("详情里没有取消启动");
    act(() => cancel.click());
    await flush();
    expect(callsOf(ipc, "cancel_task")).toEqual([{ taskId: session.taskId }]);
  });
});
