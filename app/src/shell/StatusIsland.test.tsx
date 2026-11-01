// @vitest-environment jsdom
// @module-tag heavy-page
import { act, Profiler } from "react";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { CONFIRM_COPY, LAUNCH_COPY, LAUNCH_STAGES, PHASE_LABEL, SESSION_COPY, STOPPED_LABEL } from "../copy/flows";
import { stubCanvas } from "../art/illustrations/test-canvas";
import { GAME_LOG_EVENT, LAUNCH_PHASE_EVENT } from "../ipc/launch";
import { LauncherProvider, useLauncher, type LauncherApi } from "../state/launcher";
import { startSession, type SessionState } from "../state/session";
import { render, stubMatchMedia, stubResizeObserver, type Rendered } from "../test/dom";
import type { IpcRecorder } from "../test/fake-bridge";
import { emulateFocusFixup } from "../test/focus-fixup";
import { bootOverrides, callsOf, deferred, emit, instanceDto, resetRecorder, settle } from "../test/launcher";
import { ISLAND_COPY } from "../copy/shell";
import { OverlayRoot } from "./overlay";
import { ShellProvider } from "./shell";
import { downloadStageNote, islandSecond, islandTone, stageNote, stageState, StatusIsland } from "./StatusIsland";

const ipc = vi.hoisted((): IpcRecorder => ({ calls: [], overrides: new Map() }));
vi.mock("../ipc/bridge", async (orig) => (await import("../test/fake-bridge")).fakeBridge(await orig(), ipc));

// 状态岛里不单独导出的部件按它们必定画出的子部件计数：收起的胶囊与详情头各画一个等距方块，详情的动作行全是按钮
const renders = vi.hoisted(() => ({ InstanceBlock: 0, Button: 0 }));
vi.mock("../art/iso/InstanceBlock", async (orig) => {
  const mod = await orig<typeof import("../art/iso/InstanceBlock")>();
  return {
    ...mod,
    InstanceBlock: (props: Parameters<typeof mod.InstanceBlock>[0]) => {
      renders.InstanceBlock += 1;
      return mod.InstanceBlock(props);
    },
  };
});
vi.mock("../ui/Button", async (orig) => {
  const mod = await orig<typeof import("../ui/Button")>();
  return {
    ...mod,
    Button: (props: Parameters<typeof mod.Button>[0]) => {
      renders.Button += 1;
      return mod.Button(props);
    },
  };
});

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

  it("有启动器提醒的阶段写「N 条提醒」，没有的不写；下载阶段先写下载进度", () => {
    const warned = session({ stageIndex: 5, download: null, stageWarnings: [0, 2, 0, 1, 0, 0, 0, 0] });
    expect([0, 1, 2, 3, 4].map((i) => stageNote(warned, i))).toEqual([null, "2 条提醒", null, SESSION_COPY.noDownload, null]);
    const quiet = session({ stageIndex: 4, download: { done: 3, total: 3, bytes: 0, totalBytes: null, speedBps: 0 }, stageWarnings: [0, 0, 0, 4, 0, 0, 0, 0] });
    expect(stageNote(quiet, 3)).toBe("4 条提醒");
    expect(() => stageNote(session({ stageWarnings: [] }), 1)).toThrow("没有提醒计数");
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

describe("状态岛按片订阅", () => {
  let commits = 0;

  function mount() {
    view = render(
      <LauncherProvider>
        <ShellProvider>
          <Probe />
          <Profiler id="island" onRender={() => void (commits += 1)}>
            <StatusIsland />
          </Profiler>
          <OverlayRoot />
        </ShellProvider>
      </LauncherProvider>,
    );
  }

  function islandButton(): HTMLButtonElement {
    const island = document.querySelector<HTMLButtonElement>("[aria-haspopup='dialog']");
    if (island === null) throw new Error("状态岛没有出现");
    return island;
  }

  async function running() {
    ipc.overrides.set("launch_game", () => ({ pid: 4242 }));
    mount();
    await flush();
    await act(async () => {
      await launcher.actions.launch("生存");
      await settle();
    });
    expect(launcher.state.session).toMatchObject({ instanceId: "生存", phase: "running" });
  }

  function logs() {
    for (let i = 1; i <= 20; i++) {
      act(() => {
        emit(GAME_LOG_EVENT, { version_id: "生存", lines: [{ level: "info", source: "game", text: `第 ${i} 行` }] });
      });
    }
    expect(launcher.state.session?.logs).toHaveLength(20);
  }

  beforeEach(() => {
    commits = 0;
    renders.InstanceBlock = 0;
    renders.Button = 0;
  });

  it("收起时：20 批游戏日志，状态岛一次都不提交", async () => {
    await running();
    commits = 0;
    logs();
    expect(commits).toBe(0);
  });

  it("展开后：20 批游戏日志只让最近几行跟着换，胶囊、详情头与动作行都不重渲染", async () => {
    await running();
    act(() => islandButton().click());
    await flush();
    expect(document.querySelector('[role="log"]')).toBeNull();
    const before = { ...renders };
    expect(before.InstanceBlock).toBeGreaterThan(0);
    expect(before.Button).toBeGreaterThan(0);
    logs();
    const lines = [...document.querySelectorAll('[role="log"] p')].map((p) => p.textContent);
    expect(lines).toHaveLength(4);
    expect(lines.map((l) => l?.slice(l.indexOf(" ") + 1))).toEqual(["第 17 行", "第 18 行", "第 19 行", "第 20 行"]);
    expect(renders).toEqual(before);
  });

  it("计时器只在运行中挂：加载阶段停着不动时不按秒重渲染，进入运行后每秒走一次", async () => {
    mount();
    await flush();
    act(() => void launcher.actions.launch("生存"));
    await flush();
    expect(launcher.state.session?.phase).toBe("preparing");
    commits = 0;
    // 每秒单独一次 act：一次 act 里的更新会合并成一次提交，数不出每秒一次的重渲染
    for (let i = 0; i < 5; i++) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1000);
      });
    }
    expect(commits).toBe(0);
    const session = launcher.state.session;
    if (session === null) throw new Error("启动后应有会话");
    act(() => emit(LAUNCH_PHASE_EVENT, { task_id: session.taskId, phase: "running", stage_index: 7 }));
    await flush();
    expect(launcher.state.session?.phase).toBe("running");
    expect(islandButton().getAttribute("aria-label")).toBe(ISLAND_COPY.label("生存", "00:00"));
    commits = 0;
    for (let i = 0; i < 3; i++) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1000);
      });
    }
    expect(commits).toBe(3);
    // jsdom 窗口宽 1024，按 compact 档只留计时
    expect(islandButton().getAttribute("aria-label")).toBe(ISLAND_COPY.label("生存", "00:03"));
  });

  it("只改数字的重渲染不量布局：下载进度一路走、百分比位数不变，布局动画不读胶囊的尺寸", async () => {
    mount();
    await flush();
    act(() => void launcher.actions.launch("生存"));
    await flush();
    const session = launcher.state.session;
    if (session === null) throw new Error("启动后应有会话");
    act(() => emit(LAUNCH_PHASE_EVENT, { task_id: session.taskId, phase: "downloading", stage_index: 3, download: { finished: 0, total: 100, bytes: 0, total_bytes: null, speed: 1024 } }));
    await flush();
    const island = islandButton();
    expect(island.getAttribute("aria-label")).toBe(ISLAND_COPY.label("生存", "30%"));
    const rects = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect");
    commits = 0;
    for (let i = 1; i <= 20; i++) {
      act(() => emit(LAUNCH_PHASE_EVENT, { task_id: session.taskId, phase: "downloading", stage_index: 3, download: { finished: i, total: 100, bytes: 0, total_bytes: null, speed: 1024 } }));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(20);
      });
    }
    expect(island.getAttribute("aria-label")).toBe(ISLAND_COPY.label("生存", "39%"));
    expect(commits).toBeGreaterThanOrEqual(20);
    expect(rects.mock.contexts.filter((el) => el === island)).toHaveLength(0);
    rects.mockRestore();
  });
});

describe("状态岛详情的取消与结束：进行中保持可聚焦", () => {
  /** 打开着的确认框：关闭后在退场动画期间仍挂着，带 data-exiting 的不算。 */
  const openDialogs = () => [...document.querySelectorAll<HTMLElement>('[role="dialog"]')].filter((el) => el.closest("[data-exiting]") === null);

  const buttonIn = (scope: ParentNode, text: string) => {
    const el = [...scope.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === text);
    if (el === undefined) throw new Error(`找不到按钮 ${text}`);
    return el;
  };

  /** 按浏览器对原生按钮的键盘激活：Enter 的 keydown 没被 preventDefault 就派发 click（jsdom 不做这一步）。 */
  const pressEnter = (el: HTMLElement) =>
    act(() => {
      if (el.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }))) el.click();
    });

  async function openIsland() {
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
  }

  async function expand() {
    const island = document.querySelector<HTMLButtonElement>("[aria-haspopup='dialog']");
    if (island === null) throw new Error("状态岛没有出现");
    act(() => island.click());
    await flush();
    const [detail] = openDialogs();
    if (detail === undefined) throw new Error("状态岛详情没有打开");
    return detail;
  }

  it("运行中：确认结束后焦点回到「结束游戏」并留在上面，正在结束期间读出不可用、再按不重复弹确认", async () => {
    onTestFinished(emulateFocusFixup());
    ipc.overrides.set("launch_game", () => ({ pid: 4242 }));
    ipc.overrides.set("stop_game", () => new Promise(() => undefined));
    await openIsland();
    await act(async () => {
      await launcher.actions.launch("生存");
      await settle();
    });
    expect(launcher.state.session?.phase).toBe("running");
    const detail = await expand();
    const stop = buttonIn(detail, LAUNCH_COPY.stopGame);
    act(() => stop.focus());
    act(() => stop.click());
    await flush();
    const confirm = openDialogs().find((d) => d !== detail);
    if (confirm === undefined) throw new Error("确认框没有打开");
    act(() => buttonIn(confirm, CONFIRM_COPY.stopGame("生存").confirmLabel).click());
    await flush();

    expect(callsOf(ipc, "stop_game")).toHaveLength(1);
    expect(openDialogs()).toEqual([detail]);
    expect(stop.isConnected).toBe(true);
    expect(stop.disabled).toBe(false);
    expect(stop.getAttribute("aria-disabled")).toBe("true");
    expect(stop.getAttribute("aria-busy")).toBe("true");
    expect(document.activeElement).toBe(stop);

    pressEnter(stop);
    await flush();
    expect(openDialogs()).toEqual([detail]);
    expect(callsOf(ipc, "stop_game")).toHaveLength(1);
    expect(document.activeElement).toBe(stop);
  });

  it("加载中：按下「取消启动」后焦点留在按钮上，正在结束期间再按不重复取消", async () => {
    onTestFinished(emulateFocusFixup());
    ipc.overrides.set("cancel_task", () => new Promise(() => undefined));
    await openIsland();
    act(() => void launcher.actions.launch("生存"));
    await flush();
    const detail = await expand();
    const cancel = buttonIn(detail, LAUNCH_COPY.cancel);
    act(() => cancel.focus());
    pressEnter(cancel);
    await flush();
    expect(callsOf(ipc, "cancel_task")).toHaveLength(1);
    expect(cancel.disabled).toBe(false);
    expect(cancel.getAttribute("aria-disabled")).toBe("true");
    expect(document.activeElement).toBe(cancel);

    pressEnter(cancel);
    act(() => cancel.click());
    await flush();
    expect(callsOf(ipc, "cancel_task")).toHaveLength(1);
    expect(document.activeElement).toBe(cancel);
  });
});
