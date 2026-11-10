// @vitest-environment jsdom
// @module-tag heavy-page
import { MotionConfig } from "framer-motion";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { act, Profiler } from "react";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { CONFIRM_COPY, LAUNCH_COPY, PHASE_LABEL, SESSION_COPY, STOPPED_LABEL } from "../copy/flows";
import { stubCanvas } from "../art/illustrations/test-canvas";
import { GAME_EXIT_EVENT, GAME_LOG_EVENT, LAUNCH_PHASE_EVENT } from "../ipc/launch";
import { formatSpeed } from "../domain/format";
import { BREATH_DELAY_VAR } from "../launch/breath";
import { feedSpeed, publishSpeed, startSpeed } from "../lib/progress-display";
import { LauncherProvider, useLauncher, type LauncherApi } from "../state/launcher";
import { startSession, type SessionState } from "../state/session";
import { render, stubMatchMedia, stubResizeObserver, type Rendered } from "../test/dom";
import type { IpcRecorder } from "../test/fake-bridge";
import { emulateFocusFixup } from "../test/focus-fixup";
import { bootOverrides, callsOf, cancelledError, deferred, emit, instanceDto, resetRecorder, settle } from "../test/launcher";
import { ISLAND_COPY } from "../copy/shell";
import { OverlayRoot } from "./overlay";
import { ShellProvider } from "./shell";
import popoverStyles from "../ui/Popover.module.css";
import { detailLayoutKey, downloadStageNote, islandLayoutKey, islandSecond, islandSecondText, islandSlot, islandTone, loadingFinished, LOG_LINES, stageNote, stageState, StatusIsland, type IslandSecond } from "./StatusIsland";
import styles from "./StatusIsland.module.css";
import type { Tier } from "./tier";

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

// 开着的浮层收到的布局键：形变本身在 jsdom 里测不了，只核对状态岛把哪个键交给了 Popover；渲染照常交给真实现
const popoverKeys = vi.hoisted(() => [] as (string | number | undefined)[]);
vi.mock("../ui/Popover", async (orig) => {
  const mod = await orig<typeof import("../ui/Popover")>();
  return {
    ...mod,
    Popover: (props: Parameters<typeof mod.Popover>[0]) => {
      if (props.open) popoverKeys.push(props.layoutKey);
      return mod.Popover(props);
    },
  };
});

// 让位挂到了哪些容器上：jsdom 不做布局，让位本身在这里测不了，只核对它挂对了地方；挂载照常交给真实现
const reflowed = vi.hoisted(() => new Set<Element>());
vi.mock("../lib/reflow", async (orig) => {
  const mod = await orig<typeof import("../lib/reflow")>();
  const { useCallback } = await import("react");
  return {
    ...mod,
    useReflow: <T extends HTMLElement>() => {
      const real = mod.useReflow<T>();
      return useCallback(
        (el: T | null) => {
          if (el !== null) reflowed.add(el);
          return real(el);
        },
        [real],
      );
    },
  };
});

const T0 = 1_700_000_000_000;

function session(patch: Partial<SessionState>): SessionState {
  return { ...startSession("生存", "launch-1", { uuid: "u", name: "Steve", kind: "microsoft" }, T0, null), ...patch };
}

describe("状态岛收起态的第二段", () => {
  it("加载阶段：regular 档写阶段名与百分比，封顶 99%", () => {
    const s = session({ phase: "downloading", stageIndex: 4, progress: 0.995 });
    expect(islandSecond(s, "regular", T0, false)).toEqual({ label: PHASE_LABEL.downloading, value: "99%" });
  });

  it("加载阶段：compact 档只留百分比", () => {
    const s = session({ phase: "preparing", progress: 0.37 });
    expect(islandSecond(s, "compact", T0, false)).toEqual({ label: null, value: "37%" });
  });

  it("运行中：regular 写「已运行」加计时，计时进数字槽；compact 只留计时", () => {
    const s = session({ phase: "running", runningSince: T0, stageIndex: 8, progress: 1 });
    const regular = islandSecond(s, "regular", T0 + 65_000, false);
    expect(regular).toEqual({ label: SESSION_COPY.runningLabel, value: "01:05" });
    // 读屏读到的整句与详情头的「已运行 mm:ss」一字不差
    expect(islandSecondText(regular)).toBe(SESSION_COPY.running(65_000));
    expect(islandSecond(s, "compact", T0 + 65_000, false)).toEqual({ label: null, value: "01:05" });
  });

  it("数字槽用等宽数字：计时的宽度只随位数变", () => {
    const css = readFileSync(resolve(__dirname, "StatusIsland.module.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    expect(css).toMatch(/\.value\s*\{[^}]*font-variant-numeric:\s*tabular-nums/);
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

describe("胶囊的布局依赖", () => {
  const ALL_TIERS: Tier[] = ["compact", "regular", "wide"];
  const runningSession = session({ phase: "running", runningSince: T0, stageIndex: 8, progress: 1 });

  function keyAt(s: SessionState, tier: Tier, elapsedMs: number, stopping = false): string {
    return islandLayoutKey(s, tier, "生存", islandSlot(s, tier, T0 + elapsedMs, stopping));
  }

  it.each(ALL_TIERS)("%s 档运行中：计时位数不变的任意两秒 layoutKey 相同", (tier) => {
    const edges = [0, 1, 9, 10, 59, 60, 61, 599, 600, 3598, 3599];
    const random = Array.from({ length: 40 }, () => Math.floor(Math.random() * 3600));
    const keys = new Set([...edges, ...random].map((s) => keyAt(runningSession, tier, s * 1000)));
    expect(keys.size).toBe(1);
  });

  it.each(ALL_TIERS)("%s 档运行中：计时多出一位才换 layoutKey", (tier) => {
    const minutes = keyAt(runningSession, tier, 3_599_000);
    const hours = keyAt(runningSession, tier, 3_600_000);
    expect(hours).not.toBe(minutes);
    expect(keyAt(runningSession, tier, 35_999_000)).toBe(hours);
    expect(keyAt(runningSession, tier, 36_000_000)).not.toBe(hours);
  });

  it.each(ALL_TIERS)("%s 档：三个加载阶段共用一个槽、layoutKey 相同；加载、运行、已结束、失败、崩溃两两不同", (tier) => {
    const loading: Partial<SessionState>[] = [
      { phase: "preparing", progress: 0.1 },
      { phase: "downloading", stageIndex: 4, progress: 0.4 },
      { phase: "launching", stageIndex: 6, progress: 0.9 },
    ];
    expect(new Set(loading.map((patch) => keyAt(session(patch), tier, 0))).size).toBe(1);
    const kinds: Partial<SessionState>[] = [
      loading[0],
      { phase: "running", runningSince: T0 },
      { phase: "stopped", stopReason: "exited", runningSince: T0 },
      { phase: "failed" },
      { phase: "crashed", runningSince: T0 },
    ];
    expect(new Set(kinds.map((patch) => keyAt(session(patch), tier, 0))).size).toBe(kinds.length);
  });

  it("regular 与 wide 档点了结束不换 layoutKey（「正在结束…」已在槽里）；compact 档才换；换档位时换", () => {
    const loadingSession = session({ phase: "downloading", stageIndex: 4, progress: 0.4 });
    for (const tier of ["regular", "wide"] as const) {
      expect(keyAt(runningSession, tier, 5000, true)).toBe(keyAt(runningSession, tier, 5000));
      expect(keyAt(loadingSession, tier, 0, true)).toBe(keyAt(loadingSession, tier, 0));
    }
    expect(keyAt(runningSession, "compact", 5000, true)).not.toBe(keyAt(runningSession, "compact", 5000));
    expect(keyAt(loadingSession, "compact", 0, true)).not.toBe(keyAt(loadingSession, "compact", 0));
    expect(keyAt(runningSession, "wide", 5000)).not.toBe(keyAt(runningSession, "regular", 5000));
  });

  it.each(ALL_TIERS)("%s 档加载中：百分比怎么走都不换 layoutKey（按 99% 占位）", (tier) => {
    const at = (progress: number) => keyAt(session({ phase: "downloading", stageIndex: 4, progress }), tier, 0);
    const edges = [0, 0.004, 0.09, 0.1, 0.5, 0.99, 0.995, 1];
    const random = Array.from({ length: 30 }, () => Math.random());
    expect(new Set([...edges, ...random].map(at)).size).toBe(1);
  });
});

describe("第二段的槽", () => {
  const ALL_TIERS: Tier[] = ["compact", "regular", "wide"];
  const patches: Partial<SessionState>[] = [
    { phase: "preparing", stageIndex: 1, progress: 0 },
    { phase: "preparing", stageIndex: 3, progress: 0.07 },
    { phase: "downloading", stageIndex: 4, progress: 0.42 },
    { phase: "launching", stageIndex: 7, progress: 0.995 },
    { phase: "running", runningSince: T0 },
    { phase: "stopped", stopReason: "cancelled" },
    { phase: "stopped", stopReason: "exited", runningSince: T0 },
    { phase: "failed" },
    { phase: "crashed", runningSince: T0 },
  ];
  // 运行计时取几处位数边界与随机秒数
  const elapsed = [0, 9_000, 65_000, 3_599_000, 3_600_000, 36_000_000, Math.floor(Math.random() * 40_000) * 1000];

  /** 显示的这一行能放进槽里：同一句文字的候选在，数字不比候选的占位长（数字等宽，位数不多就不宽）。 */
  function fits(shown: IslandSecond, slot: readonly IslandSecond[]): boolean {
    return slot.some((c) => c.label === shown.label && (c.value === null ? shown.value === null : shown.value !== null && shown.value.length <= c.value.length));
  }

  it("每种阶段、档位、计时与「正在结束」的组合：显示的那一行都放得进槽里", () => {
    for (const patch of patches)
      for (const tier of ALL_TIERS)
        for (const ms of elapsed)
          for (const stopping of [false, true]) {
            const s = session(patch);
            const shown = islandSecond(s, tier, T0 + ms, stopping);
            const slot = islandSlot(s, tier, T0 + ms, stopping);
            if (!fits(shown, slot)) throw new Error(`放不进槽：${JSON.stringify({ patch, tier, ms, stopping, shown, slot })}`);
          }
  });

  it("regular 与 wide 档：加载期间槽里是三个加载阶段与「正在结束…」，运行期间是计时与「正在结束…」", () => {
    const loading = session({ phase: "downloading", stageIndex: 4, progress: 0.42 });
    const running = session({ phase: "running", runningSince: T0 });
    for (const tier of ["regular", "wide"] as const) {
      expect(islandSlot(loading, tier, T0, false).map(islandSecondText)).toEqual([
        `${PHASE_LABEL.preparing} 99%`,
        `${PHASE_LABEL.downloading} 99%`,
        `${PHASE_LABEL.launching} 99%`,
        SESSION_COPY.stopping,
      ]);
      expect(islandSlot(running, tier, T0 + 65_000, false).map(islandSecondText)).toEqual([`${SESSION_COPY.runningLabel} 00:00`, SESSION_COPY.stopping]);
      expect(islandSlot(running, tier, T0 + 3_600_000, true).map(islandSecondText)).toEqual([`${SESSION_COPY.runningLabel} 0:00:00`, SESSION_COPY.stopping]);
    }
  });

  it("compact 档只占当前这一行，不为「正在结束…」多占宽；已结束、失败、崩溃各档都只占当前这一行", () => {
    expect(islandSlot(session({ phase: "launching", stageIndex: 6, progress: 0.9 }), "compact", T0, false)).toEqual([{ label: null, value: "99%" }]);
    expect(islandSlot(session({ phase: "running", runningSince: T0 }), "compact", T0 + 65_000, false)).toEqual([{ label: null, value: "00:00" }]);
    expect(islandSlot(session({ phase: "running", runningSince: T0 }), "compact", T0, true)).toEqual([{ label: SESSION_COPY.stopping, value: null }]);
    for (const tier of ALL_TIERS) {
      for (const patch of patches.slice(5)) {
        const s = session(patch);
        expect(islandSlot(s, tier, T0, false)).toEqual([islandSecond(s, tier, T0, false)]);
      }
    }
  });
});

describe("阶段清单", () => {
  it("当前阶段之前为完成、之后为未开始", () => {
    expect([0, 1, 2, 3, 4].map((i) => stageState(2, i, true))).toEqual(["done", "done", "now", "todo", "todo"]);
  });

  it("加载已结束（失败、取消）：停下的那一步是 halted，不再是进行中", () => {
    expect([0, 1, 2, 3, 4].map((i) => stageState(2, i, false))).toEqual(["done", "done", "halted", "todo", "todo"]);
    expect([0, 1, 2].map((i) => stageState(0, i, false))).toEqual(["halted", "todo", "todo"]);
  });

  it("下载阶段进行中写文件数与速度；数量未知时不写", () => {
    expect(downloadStageNote(session({ phase: "downloading", stageIndex: 4, download: { done: 12, total: 40, bytes: 0, totalBytes: null, speedBps: 2048 } }))).toBe("12/40 · 2.0 KB/s");
    expect(downloadStageNote(session({ phase: "downloading", stageIndex: 4, download: { done: 0, total: null, bytes: 0, totalBytes: null, speedBps: 0 } }))).toBeNull();
  });

  it("加载停在下载这一步（取消、失败）：只留文件数，不再写速度", () => {
    const download = { done: 7, total: 40, bytes: 0, totalBytes: null, speedBps: 4096 };
    expect(downloadStageNote(session({ phase: "stopped", stopReason: "cancelled", stageIndex: 4, download }))).toBe("7/40");
    expect(downloadStageNote(session({ phase: "failed", stageIndex: 4, download }))).toBe("7/40");
    expect(downloadStageNote(session({ phase: "downloading", stageIndex: 4, download }))).toBe("7/40 · 4.0 KB/s");
  });

  it("越过下载阶段且没有下载记录：写「无需下载」；还没到下载阶段不写", () => {
    expect(downloadStageNote(session({ stageIndex: 6, download: null }))).toBe(SESSION_COPY.noDownload);
    expect(downloadStageNote(session({ stageIndex: 2, download: null }))).toBeNull();
  });

  it("有启动器提醒的阶段写「N 条提醒」，没有的不写；下载阶段先写下载进度", () => {
    const warned = session({ stageIndex: 6, download: null, stageWarnings: [0, 0, 2, 0, 1, 0, 0, 0, 0] });
    expect([0, 1, 2, 3, 4, 5].map((i) => stageNote(warned, i))).toEqual([null, null, "2 条提醒", null, SESSION_COPY.noDownload, null]);
    const quiet = session({ stageIndex: 5, download: { done: 3, total: 3, bytes: 0, totalBytes: null, speedBps: 0 }, stageWarnings: [0, 0, 0, 0, 4, 0, 0, 0, 0] });
    expect(stageNote(quiet, 4)).toBe("4 条提醒");
    expect(() => stageNote(session({ stageWarnings: [] }), 1)).toThrow("没有提醒计数");
  });
});

describe("详情浮层的布局键", () => {
  const ALL_STAGES = [true, false];

  it("进度、速度、阶段推进、提醒数、日志都不换键：三个加载阶段是同一套动作", () => {
    const loading: Partial<SessionState>[] = [
      { phase: "preparing", stageIndex: 0, progress: 0 },
      { phase: "preparing", stageIndex: 3, progress: 0.2, stageWarnings: [0, 0, 3, 0, 0, 0, 0, 0, 0] },
      { phase: "downloading", stageIndex: 4, progress: 0.42, download: { done: 3, total: 40, bytes: 0, totalBytes: null, speedBps: 9000 } },
      { phase: "launching", stageIndex: 7, progress: 0.91, logs: [{ at: T0, level: "info", source: "launcher", text: "x" }] },
    ];
    for (const stages of ALL_STAGES) expect(new Set(loading.map((patch) => detailLayoutKey(session(patch), stages))).size).toBe(1);
  });

  it("动作行换一套按钮时换键：加载、运行、已结束、崩溃、失败两两不同；失败时修复文案不同也不同", () => {
    const kinds: Partial<SessionState>[] = [
      { phase: "launching", stageIndex: 6 },
      { phase: "running", runningSince: T0 },
      { phase: "stopped", stopReason: "exited", runningSince: T0 },
      { phase: "crashed", runningSince: T0 },
      { phase: "failed", failure: { code: "account_relogin", params: {} } },
      { phase: "failed", failure: { code: "account_refresh_network", params: {} } },
    ];
    expect(new Set(kinds.map((patch) => detailLayoutKey(session(patch), false))).size).toBe(kinds.length);
  });

  it("阶段清单出没、换成另一次启动的清单时换键", () => {
    const s = session({ phase: "downloading", stageIndex: 4 });
    expect(detailLayoutKey(s, true)).not.toBe(detailLayoutKey(s, false));
    expect(detailLayoutKey({ ...s, taskId: "launch-2" }, true)).not.toBe(detailLayoutKey(s, true));
    // 不画清单时与哪一次启动无关
    expect(detailLayoutKey({ ...s, taskId: "launch-2" }, false)).toBe(detailLayoutKey(s, false));
  });

  it("失败会话缺失败码是状态坏了，直接抛错", () => {
    expect(() => detailLayoutKey(session({ phase: "failed" }), false)).toThrow("失败码");
  });
});

describe("加载走完的收尾", () => {
  const since = T0 + 4321;

  it("在这座岛上画过加载的那一局进入运行：完成项是这一局，完成时刻取运行起点", () => {
    const s = session({ phase: "running", runningSince: since, stageIndex: 8, progress: 1 });
    expect(loadingFinished(s, "launch-1")).toEqual([{ id: "launch-1", finishedAt: since }]);
  });

  it("找回的一局（这里没画过它的加载）、别的一局画过加载、还在加载、失败与结束：都没有要推满的", () => {
    const running = session({ phase: "running", runningSince: since, stageIndex: 8, progress: 1 });
    expect(loadingFinished(running, null)).toEqual([]);
    expect(loadingFinished(running, "launch-0")).toEqual([]);
    expect(loadingFinished(session({ phase: "launching", stageIndex: 7, progress: 0.91 }), "launch-1")).toEqual([]);
    expect(loadingFinished(session({ phase: "failed" }), "launch-1")).toEqual([]);
    expect(loadingFinished(session({ phase: "stopped", stopReason: "exited", runningSince: since }), "launch-1")).toEqual([]);
  });

  it("运行中缺运行起点是状态坏了，直接抛错", () => {
    expect(() => loadingFinished(session({ phase: "running" }), "launch-1")).toThrow("运行起点");
  });
});

describe("详情的日志区", () => {
  const css = readFileSync(resolve(__dirname, "StatusIsland.module.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  const block = (selector: string) => {
    const m = new RegExp(String.raw`(?:^|\n)${selector.replace(/[.[\]"=]/g, (c) => `\\${c}`)}\s*\{([^}]*)\}`).exec(css);
    if (m === null) throw new Error(`样式里没有 ${selector}`);
    return m[1];
  };

  it("固定按 LOG_LINES 行的行高加上下内边距取高度，不随行数长高", () => {
    const logs = block(".logs");
    expect(logs).toMatch(/box-sizing:\s*border-box/);
    expect(logs).toContain(`height: calc(${LOG_LINES} * var(--sk-lh-mono-sm) + 2 * var(--sk-space-8))`);
    expect(logs).not.toMatch(/max-height/);
  });

  it("浮层宽度定在面板上；正文右内边距扣掉主体常驻的滚动条槽，下内边距是它与动作行的间距；动作行在底部那一层补齐左右与下沿的留白", () => {
    expect(block(".detailPanel")).toMatch(/width:\s*min\(340px, calc\(100vw - var\(--sk-space-32\)\)\);/);
    const detail = block(".detail");
    expect(detail).toMatch(/padding:\s*var\(--sk-space-16\) calc\(var\(--sk-space-16\) - var\(--sk-scrollbar-size\)\) var\(--sk-space-12\) var\(--sk-space-16\);/);
    expect(detail).not.toMatch(/(^|\s)width:/);
    expect(block(".actions")).toMatch(/padding:\s*0 var\(--sk-space-16\) var\(--sk-space-16\);/);
  });

  it("正文与动作行是退场项的定位基准：形变途中外层带 transform，退场项按它们量位置、也按它们摆", () => {
    expect(block(".detail")).toMatch(/position:\s*relative;/);
    expect(block(".actions")).toMatch(/position:\s*relative;/);
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
    act(() => emit(LAUNCH_PHASE_EVENT, { task_id: session.taskId, phase: "downloading", stage_index: 4, download: { finished: 2, total: 10, bytes: 0, total_bytes: null, speed: 1024 } }));
    await flush();

    const island = document.querySelector<HTMLButtonElement>("[aria-haspopup='dialog']");
    if (island === null) throw new Error("状态岛没有出现");
    // jsdom 窗口宽 1024，按 compact 档只留百分比；阶段 4 起点 0.3，按文件数 2/10 推进到 0.39
    expect(island.getAttribute("aria-label")).toBe(ISLAND_COPY.label("生存", "39%"));

    act(() => island.click());
    await flush();
    const stages = [...document.querySelectorAll("[data-state]")].map((el) => [el.textContent, el.getAttribute("data-state")]);
    expect(stages.slice(0, 5)).toEqual([
      ["验证账户", "done"],
      ["检查 Java", "done"],
      ["校验游戏文件", "done"],
      ["补全库文件", "done"],
      ["下载缺失文件2/10 · 1.0 KB/s", "now"],
    ]);
    // 九个阶段去掉「游戏运行中」
    expect(stages).toHaveLength(8);

    const cancel = [...document.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === LAUNCH_COPY.cancel);
    if (cancel === undefined) throw new Error("详情里没有取消启动");
    act(() => cancel.click());
    await flush();
    expect(callsOf(ipc, "cancel_task")).toEqual([{ taskId: session.taskId }]);
  });

  /** 打开着的详情（退场中的不算）。 */
  const liveDetail = () => {
    const panels = [...document.querySelectorAll<HTMLElement>('[role="dialog"]')].filter((el) => !el.hasAttribute("data-exiting"));
    if (panels.length !== 1) throw new Error(`应有且只有一个打开着的详情，实为 ${panels.length} 个`);
    return panels[0];
  };
  const stageStates = (scope: ParentNode) => [...scope.querySelectorAll("[data-state]")].map((el) => el.getAttribute("data-state"));

  it("详情在加载期打开：进入运行后阶段清单留到关闭、停在全部完成；关掉再打开不再画清单", async () => {
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
    act(() => void launcher.actions.launch("生存"));
    await flush();
    const session = launcher.state.session;
    if (session === null) throw new Error("启动后应有会话");
    act(() => emit(LAUNCH_PHASE_EVENT, { task_id: session.taskId, phase: "downloading", stage_index: 4, download: { finished: 2, total: 10, bytes: 0, total_bytes: null, speed: 1024 } }));
    await flush();
    const island = document.querySelector<HTMLButtonElement>("[aria-haspopup='dialog']");
    if (island === null) throw new Error("状态岛没有出现");
    act(() => island.click());
    await flush();
    expect(stageStates(liveDetail())).toEqual(["done", "done", "done", "done", "now", "todo", "todo", "todo"]);

    act(() => emit(LAUNCH_PHASE_EVENT, { task_id: session.taskId, phase: "running", stage_index: 8 }));
    await flush();
    expect(launcher.state.session?.phase).toBe("running");
    expect(stageStates(liveDetail())).toEqual(Array.from({ length: 8 }, () => "done"));

    act(() => island.click());
    await flush();
    act(() => island.click());
    await flush();
    expect(stageStates(liveDetail())).toEqual([]);
  });

  it("详情在加载期打开、取消启动后：清单留着，停下的那一步是 halted，没有一步还像在进行", async () => {
    const launch = deferred<never>();
    ipc.overrides.set("launch_game", () => launch.promise);
    ipc.overrides.set("cancel_task", () => {
      launch.reject(cancelledError());
      return true;
    });
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
    act(() => void launcher.actions.launch("生存"));
    await flush();
    const session = launcher.state.session;
    if (session === null) throw new Error("启动后应有会话");
    act(() => emit(LAUNCH_PHASE_EVENT, { task_id: session.taskId, phase: "downloading", stage_index: 4, download: { finished: 2, total: 10, bytes: 0, total_bytes: null, speed: 1024 } }));
    await flush();
    const island = document.querySelector<HTMLButtonElement>("[aria-haspopup='dialog']");
    if (island === null) throw new Error("状态岛没有出现");
    act(() => island.click());
    await flush();
    expect(stageStates(liveDetail())).toEqual(["done", "done", "done", "done", "now", "todo", "todo", "todo"]);

    const cancel = [...liveDetail().querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === LAUNCH_COPY.cancel);
    if (cancel === undefined) throw new Error("详情里没有取消启动");
    act(() => cancel.click());
    await flush();
    expect(launcher.state.session).toMatchObject({ phase: "stopped", stopReason: "cancelled" });
    expect(stageStates(liveDetail())).toEqual(["done", "done", "done", "done", "halted", "todo", "todo", "todo"]);
    // 停下的下载那一行只留文件数：速度会让它像还在下载
    expect(liveDetail().querySelectorAll("[data-state]")[4].textContent).toBe("下载缺失文件2/10");
  });

  it("详情头与下载那一行写同一个显示速度：平滑过、离上次换字满 500 ms 才换，不跟着每次上报跳", async () => {
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
    act(() => void launcher.actions.launch("生存"));
    await flush();
    const session = launcher.state.session;
    if (session === null) throw new Error("启动后应有会话");
    const download = (finished: number, speed: number) => ({ finished, total: 10, bytes: 0, total_bytes: null, speed });
    act(() => emit(LAUNCH_PHASE_EVENT, { task_id: session.taskId, phase: "downloading", stage_index: 4, download: download(2, 1024) }));
    await flush();
    const t0 = Date.now();
    const island = document.querySelector<HTMLButtonElement>("[aria-haspopup='dialog']");
    if (island === null) throw new Error("状态岛没有出现");
    act(() => island.click());
    await flush();
    /** 详情头的副行与阶段清单下载那一行末尾写的速度。 */
    const speeds = () => {
      const head = liveDetail().querySelector(`.${styles.headPhase}`)?.textContent;
      const row = liveDetail().querySelectorAll("[data-state]")[4]?.textContent;
      if (head === undefined || head === null || row === undefined || row === null) throw new Error("详情里没有副行或下载那一行");
      return [head.split(" · ").at(-1), row.split(" · ").at(-1)];
    };
    const advance = (ms: number) =>
      act(async () => {
        await vi.advanceTimersByTimeAsync(ms);
      });
    // 从 0 开始传：真实速度一开始就是它，直接写
    expect(speeds()).toEqual([formatSpeed(1024), formatSpeed(1024)]);

    await advance(100);
    act(() => emit(LAUNCH_PHASE_EVENT, { task_id: session.taskId, phase: "downloading", stage_index: 4, download: download(3, 8192) }));
    await flush();
    // 离上次换字不到 500 ms：照旧
    expect(speeds()).toEqual([formatSpeed(1024), formatSpeed(1024)]);
    await advance(399);
    expect(speeds()).toEqual([formatSpeed(1024), formatSpeed(1024)]);

    // 满 500 ms 换上平均值：既不是旧速度，也不是刚报上来的瞬时速度
    await advance(1);
    const average = formatSpeed(publishSpeed(feedSpeed(startSpeed(1024, t0), 8192, t0 + 100), t0 + 500).shown);
    expect([average === formatSpeed(1024), average === formatSpeed(8192)]).toEqual([false, false]);
    expect(speeds()).toEqual([average, average]);
  });

  it("打开详情时已完成阶段的勾号直接画好，之后新完成的那一步才从小、透明弹出", async () => {
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
    act(() => void launcher.actions.launch("生存"));
    await flush();
    const session = launcher.state.session;
    if (session === null) throw new Error("启动后应有会话");
    act(() => emit(LAUNCH_PHASE_EVENT, { task_id: session.taskId, phase: "preparing", stage_index: 3 }));
    await flush();
    const island = document.querySelector<HTMLButtonElement>("[aria-haspopup='dialog']");
    if (island === null) throw new Error("状态岛没有出现");
    act(() => island.click());
    await flush();
    const checks = () => [...liveDetail().querySelectorAll<HTMLElement>(`.${styles.stageCheck}`)].map((el) => [el.style.opacity, el.style.transform]);
    expect(checks()).toEqual([
      ["1", "none"],
      ["1", "none"],
      ["1", "none"],
    ]);

    act(() => emit(LAUNCH_PHASE_EVENT, { task_id: session.taskId, phase: "downloading", stage_index: 4, download: { finished: 0, total: 10, bytes: 0, total_bytes: null, speed: 0 } }));
    await flush();
    expect(checks()).toEqual([
      ["1", "none"],
      ["1", "none"],
      ["1", "none"],
      ["0", "scale(0.6)"],
    ]);
  });

  it("动作行的每个按钮各包一层，随阶段增删时单独淡入淡出；动作行与详情正文都挂着让位", async () => {
    reflowed.clear();
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
    act(() => void launcher.actions.launch("生存"));
    await flush();
    const island = document.querySelector<HTMLButtonElement>("[aria-haspopup='dialog']");
    if (island === null) throw new Error("状态岛没有出现");
    act(() => island.click());
    await flush();
    const actions = liveDetail().querySelector(`.${styles.actions}`);
    if (actions === null) throw new Error("详情里没有动作行");
    const items = [...actions.children];
    expect(items.map((el) => el.className)).toEqual([styles.action, styles.action]);
    expect(items.map((el) => el.querySelector("button")?.textContent)).toEqual([ISLAND_COPY.fullLog, LAUNCH_COPY.cancel]);
    // 有新按钮插入的换组（加载转运行、失败、崩溃）靠动作行的让位；阶段清单插入时日志区靠详情正文的让位，动作行跟着浮层下沿走
    expect(reflowed.has(actions)).toBe(true);
    const detail = liveDetail().querySelector(`.${styles.detail}`);
    if (detail === null) throw new Error("详情里没有正文");
    expect(reflowed.has(detail)).toBe(true);
  });

  it("详情浮层随内容形变：正文在主体（滚动区）里，动作行在底部那一层、不随主体滚动", async () => {
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
    act(() => void launcher.actions.launch("生存"));
    await flush();
    const island = document.querySelector<HTMLButtonElement>("[aria-haspopup='dialog']");
    if (island === null) throw new Error("状态岛没有出现");
    act(() => island.click());
    await flush();
    const panel = liveDetail();
    // 传了布局键：面板换成主体加底部的结构，宽度由面板上的类名给
    expect(panel.hasAttribute("data-structured")).toBe(true);
    expect(panel.classList.contains(styles.detailPanel)).toBe(true);
    const detail = panel.querySelector(`.${styles.detail}`);
    const actions = panel.querySelector(`.${styles.actions}`);
    if (detail === null || actions === null) throw new Error("详情里没有正文或动作行");
    expect(detail.closest(`.${popoverStyles.body}`)?.parentElement).toBe(panel);
    expect(actions.parentElement?.className).toBe(popoverStyles.footer);
    expect(actions.parentElement?.parentElement).toBe(panel);
    expect(detail.contains(actions)).toBe(false);

    // 交给浮层的布局键：加载中开着、清单在画；进入运行时动作行换一套，键跟着换
    const loading = launcher.state.session;
    if (loading === null) throw new Error("启动后应有会话");
    expect(popoverKeys.at(-1)).toBe(detailLayoutKey(loading, true));
    act(() => emit(LAUNCH_PHASE_EVENT, { task_id: loading.taskId, phase: "running", stage_index: 8 }));
    await flush();
    const running = launcher.state.session;
    if (running === null) throw new Error("进入运行后应有会话");
    expect(popoverKeys.at(-1)).toBe(detailLayoutKey(running, true));
    expect(detailLayoutKey(running, true)).not.toBe(detailLayoutKey(loading, true));
  });

  it("运行转崩溃：「结束游戏」那一层退场时不可交互，新插入的「关闭」「查看诊断」各自从小、透明淡入，「完整日志」原地不动", async () => {
    ipc.overrides.set("launch_game", () => ({ pid: 4242 }));
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
    await act(async () => {
      await launcher.actions.launch("生存");
      await settle();
    });
    expect(launcher.state.session?.phase).toBe("running");
    const island = document.querySelector<HTMLButtonElement>("[aria-haspopup='dialog']");
    if (island === null) throw new Error("状态岛没有出现");
    act(() => island.click());
    await flush();
    const actions = liveDetail().querySelector<HTMLElement>(`.${styles.actions}`);
    if (actions === null) throw new Error("详情里没有动作行");
    const [logs, stop] = [...actions.children] as HTMLElement[];
    expect([logs, stop].map((el) => el.textContent)).toEqual([ISLAND_COPY.fullLog, LAUNCH_COPY.stopGame]);

    act(() => emit(GAME_EXIT_EVENT, { version_id: "生存", exit_code: 1, crashed: true, killed: false, duration_ms: 60_000 }));
    await flush();
    expect(launcher.state.session?.phase).toBe("crashed");
    const items = [...actions.children] as HTMLElement[];
    expect(items.map((el) => el.textContent)).toEqual([ISLAND_COPY.fullLog, LAUNCH_COPY.stopGame, LAUNCH_COPY.dismiss, LAUNCH_COPY.viewCrash]);
    // 挂载时就在的「完整日志」还是原来那一层，不重播入场
    expect(items[0]).toBe(logs);
    expect(logs.hasAttribute("inert")).toBe(false);
    // 退场的「结束游戏」点不到、聚焦不到：叠在顶上来的兄弟上面淡出时，点击落到它下面的按钮
    expect(items[1]).toBe(stop);
    expect(stop.hasAttribute("inert")).toBe(true);
    // 新插入的两个按钮各包一层，起点是 insertItem 的 initial
    expect(items.slice(2).map((el) => [el.className, el.hasAttribute("inert"), el.style.opacity, el.style.transform])).toEqual([
      [styles.action, false, "0", "scale(0.98)"],
      [styles.action, false, "0", "scale(0.98)"],
    ]);
  });

  describe("结束这一局后动作行不删按钮：结束按钮留在原位改为不可用，「完整日志」不挪", () => {
    function mount() {
      view = render(
        <LauncherProvider>
          <ShellProvider>
            <Probe />
            <StatusIsland />
            <OverlayRoot />
          </ShellProvider>
        </LauncherProvider>,
      );
    }

    async function openActions() {
      const island = document.querySelector<HTMLButtonElement>("[aria-haspopup='dialog']");
      if (island === null) throw new Error("状态岛没有出现");
      act(() => island.click());
      await flush();
      const actions = liveDetail().querySelector<HTMLElement>(`.${styles.actions}`);
      if (actions === null) throw new Error("详情里没有动作行");
      return actions;
    }

    /** 动作行此刻的包层与各自的按钮。 */
    const snapshot = (actions: HTMLElement) => {
      const items = [...actions.children];
      const buttons = items.map((el) => {
        const button = el.querySelector("button");
        if (button === null) throw new Error("动作行的包层里没有按钮");
        return button;
      });
      return { items, buttons };
    };

    /** 结束之后：还是原来那几层、原来那几个按钮，结束按钮是「留住的不可用」而不是退场中的旧按钮（退场项保留的是上一帧的属性）。 */
    function expectHeld(actions: HTMLElement, before: ReturnType<typeof snapshot>, label: string) {
      const after = snapshot(actions);
      expect(after.items).toHaveLength(2);
      after.items.forEach((el, i) => expect(el).toBe(before.items[i]));
      after.buttons.forEach((el, i) => expect(el).toBe(before.buttons[i]));
      expect(after.buttons.map((b) => b.textContent)).toEqual([ISLAND_COPY.fullLog, label]);
      const end = after.buttons[1];
      expect(end.hasAttribute("data-disabled")).toBe(true);
      expect(end.getAttribute("aria-disabled")).toBe("true");
      expect(end.getAttribute("aria-busy")).toBeNull();
      expect(after.buttons[0].getAttribute("aria-disabled")).toBeNull();
    }

    const exitGame = () => act(() => emit(GAME_EXIT_EVENT, { version_id: "生存", exit_code: 0, crashed: false, killed: false, duration_ms: 60_000 }));

    it("运行中游戏退出：「结束游戏」留着、点了不再弹确认", async () => {
      ipc.overrides.set("launch_game", () => ({ pid: 4242 }));
      mount();
      await flush();
      await act(async () => {
        await launcher.actions.launch("生存");
        await settle();
      });
      expect(launcher.state.session?.phase).toBe("running");
      const actions = await openActions();
      const before = snapshot(actions);
      expect(before.buttons.map((b) => b.textContent)).toEqual([ISLAND_COPY.fullLog, LAUNCH_COPY.stopGame]);
      expect(before.buttons[1].hasAttribute("data-disabled")).toBe(false);

      exitGame();
      await flush();
      expect(launcher.state.session).toMatchObject({ phase: "stopped", stopReason: "exited" });
      expectHeld(actions, before, LAUNCH_COPY.stopGame);

      act(() => before.buttons[1].click());
      await flush();
      expect(document.querySelectorAll('[role="dialog"]:not([data-exiting])')).toHaveLength(1);
      expect(callsOf(ipc, "stop_game")).toEqual([]);
    });

    it("加载中取消启动：「取消启动」留着，转圈停下、改为不可用", async () => {
      const launch = deferred<never>();
      ipc.overrides.set("launch_game", () => launch.promise);
      ipc.overrides.set("cancel_task", () => {
        launch.reject(cancelledError());
        return true;
      });
      mount();
      await flush();
      act(() => void launcher.actions.launch("生存"));
      await flush();
      const actions = await openActions();
      const before = snapshot(actions);
      expect(before.buttons.map((b) => b.textContent)).toEqual([ISLAND_COPY.fullLog, LAUNCH_COPY.cancel]);

      act(() => before.buttons[1].click());
      await flush();
      expect(callsOf(ipc, "cancel_task")).toHaveLength(1);
      expect(launcher.state.session).toMatchObject({ phase: "stopped", stopReason: "cancelled" });
      expectHeld(actions, before, LAUNCH_COPY.cancel);
    });

    it("加载中游戏就退出了：留的是此前显示的「取消启动」，不按结束原因换成「结束游戏」", async () => {
      mount();
      await flush();
      act(() => void launcher.actions.launch("生存"));
      await flush();
      const actions = await openActions();
      const before = snapshot(actions);

      exitGame();
      await flush();
      expect(launcher.state.session).toMatchObject({ phase: "stopped", stopReason: "exited" });
      expectHeld(actions, before, LAUNCH_COPY.cancel);
    });
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
    // 日志区常驻：还没有日志时也占着位置，首批日志到达时下面的动作行不被推开
    const box = document.querySelector('[role="log"]');
    if (box === null) throw new Error("日志区应在详情打开时就在");
    expect(box.children).toHaveLength(0);
    const before = { ...renders };
    expect(before.InstanceBlock).toBeGreaterThan(0);
    expect(before.Button).toBeGreaterThan(0);
    logs();
    expect(document.querySelector('[role="log"]')).toBe(box);
    const lines = [...document.querySelectorAll('[role="log"] p')].map((p) => p.textContent);
    expect(lines).toHaveLength(4);
    expect(lines.map((l) => l?.slice(l.indexOf(" ") + 1))).toEqual(["第 17 行", "第 18 行", "第 19 行", "第 20 行"]);
    expect(renders).toEqual(before);
  });

  it("会话清空、详情随状态岛退场时，日志区照旧画最后几行，不在淡出途中变空", async () => {
    await running();
    act(() => islandButton().click());
    await flush();
    logs();
    act(() => emit(GAME_EXIT_EVENT, { version_id: "生存", exit_code: 0, crashed: false, killed: false, duration_ms: 60_000 }));
    await flush();
    expect(launcher.state.session?.phase).toBe("stopped");
    // 已结束的会话停留 1500 ms 后清空
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1500);
    });
    expect(launcher.state.session).toBeNull();
    const exiting = document.querySelector('[data-exiting] [role="log"]');
    if (exiting === null) throw new Error("退场中的详情里应还有日志区");
    const lines = [...exiting.querySelectorAll("p")].map((p) => p.textContent);
    expect(lines.map((l) => l?.slice(l.indexOf(" ") + 1))).toEqual(["第 17 行", "第 18 行", "第 19 行", "第 20 行"]);
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
    act(() => emit(LAUNCH_PHASE_EVENT, { task_id: session.taskId, phase: "running", stage_index: 8 }));
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
    act(() => emit(LAUNCH_PHASE_EVENT, { task_id: session.taskId, phase: "downloading", stage_index: 4, download: { finished: 0, total: 100, bytes: 0, total_bytes: null, speed: 1024 } }));
    await flush();
    const island = islandButton();
    expect(island.getAttribute("aria-label")).toBe(ISLAND_COPY.label("生存", "30%"));
    const rects = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect");
    commits = 0;
    for (let i = 1; i <= 20; i++) {
      act(() => emit(LAUNCH_PHASE_EVENT, { task_id: session.taskId, phase: "downloading", stage_index: 4, download: { finished: i, total: 100, bytes: 0, total_bytes: null, speed: 1024 } }));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(20);
      });
    }
    expect(island.getAttribute("aria-label")).toBe(ISLAND_COPY.label("生存", "39%"));
    expect(commits).toBeGreaterThanOrEqual(20);
    expect(rects.mock.contexts.filter((el) => el === island)).toHaveLength(0);
    rects.mockRestore();
  });

  it("regular 档运行中：每秒的重渲染不量布局，计时多出一位那一下才量", async () => {
    vi.stubGlobal("innerWidth", 1280);
    await running();
    const since = launcher.state.session?.runningSince;
    if (since === undefined || since === null) throw new Error("运行会话缺少运行起点");
    const island = islandButton();
    const label = (elapsedMs: number) => ISLAND_COPY.label("生存", SESSION_COPY.running(elapsedMs));
    const tick = () =>
      act(async () => {
        await vi.advanceTimersByTimeAsync(1000);
      });
    const rects = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect");
    const measures = () => rects.mock.contexts.filter((el) => el === island).length;

    commits = 0;
    for (let i = 0; i < 5; i++) await tick();
    expect(commits).toBe(5);
    expect(island.getAttribute("aria-label")).toBe(label(5000));
    expect([...island.querySelectorAll("span")].find((el) => el.textContent === "00:05")?.className).toBe(styles.value);
    expect(measures()).toBe(0);

    vi.setSystemTime(since + 3_598_000);
    await tick();
    expect(island.getAttribute("aria-label")).toBe(label(3_599_000));
    expect(measures()).toBe(0);

    await tick();
    expect(island.getAttribute("aria-label")).toBe(label(3_600_000));
    expect(measures()).toBeGreaterThan(0);
    rects.mockRestore();
  });
});

describe("状态岛胶囊的动效", () => {
  function mount() {
    view = render(
      <LauncherProvider>
        <ShellProvider>
          <Probe />
          <StatusIsland />
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
    await flush();
    await act(async () => {
      await launcher.actions.launch("生存");
      await settle();
    });
    expect(launcher.state.session?.phase).toBe("running");
  }

  const exitGame = (crashed: boolean) => act(() => emit(GAME_EXIT_EVENT, { version_id: "生存", exit_code: crashed ? 1 : 0, crashed, killed: false, duration_ms: 60_000 }));

  it("阶段文字一变整行换成新节点（旧行留着退场），只改百分比时同一行原地更新", async () => {
    // regular 档才写阶段文字
    vi.stubGlobal("innerWidth", 1280);
    mount();
    await flush();
    act(() => void launcher.actions.launch("生存"));
    await flush();
    const session = launcher.state.session;
    if (session === null) throw new Error("启动后应有会话");
    const faces = () => [...islandButton().querySelectorAll<HTMLElement>(`.${styles.face}`)];
    const reserves = () => [...islandButton().querySelectorAll<HTMLElement>(`.${styles.reserve}`)];
    const [preparing] = faces();
    expect(preparing.textContent).toBe(`${PHASE_LABEL.preparing}0%`);
    // 占宽的候选与显示的行在同一格：三个加载阶段按 99% 占位，再加「正在结束…」
    const slot = reserves();
    expect(slot.map((el) => el.textContent)).toEqual([`${PHASE_LABEL.preparing}99%`, `${PHASE_LABEL.downloading}99%`, `${PHASE_LABEL.launching}99%`, SESSION_COPY.stopping]);
    expect(slot.every((el) => el.parentElement === preparing.parentElement && el.getAttribute("aria-hidden") === "true")).toBe(true);
    const rects = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect");
    const measures = () => rects.mock.contexts.filter((el) => el === islandButton()).length;

    act(() => emit(LAUNCH_PHASE_EVENT, { task_id: session.taskId, phase: "downloading", stage_index: 4, download: { finished: 0, total: 10, bytes: 0, total_bytes: null, speed: 0 } }));
    await flush();
    const after = faces();
    expect(after.map((el) => el.textContent)).toEqual([`${PHASE_LABEL.preparing}0%`, `${PHASE_LABEL.downloading}30%`]);
    expect(after[0]).toBe(preparing);
    const downloading = after[1];
    // 新行从下方入场，起点是 lineSwap 的 enter
    expect([downloading.style.opacity, downloading.style.transform]).toEqual(["0", "translateY(4px)"]);
    // 换的只是格里的那一行：候选还是那几个节点，胶囊宽度不变，布局动画不量胶囊
    expect(reserves()).toEqual(slot);
    expect(measures()).toBe(0);

    act(() => emit(LAUNCH_PHASE_EVENT, { task_id: session.taskId, phase: "downloading", stage_index: 4, download: { finished: 2, total: 10, bytes: 0, total_bytes: null, speed: 0 } }));
    await flush();
    expect(faces().at(-1)).toBe(downloading);
    // 百分数跟底边进度条同一种平滑，逐帧走过去（StatusIsland.progress.test.tsx 逐帧看）：这一刻还没出帧，字不当场跳到新值，读屏的名称已是新值
    expect(downloading.textContent).toBe(`${PHASE_LABEL.downloading}30%`);
    expect(islandButton().getAttribute("aria-label")).toBe(ISLAND_COPY.label("生存", `${PHASE_LABEL.downloading} 39%`));

    act(() => emit(LAUNCH_PHASE_EVENT, { task_id: session.taskId, phase: "launching", stage_index: 6 }));
    await flush();
    expect(faces().at(-1)?.textContent).toMatch(new RegExp(`^${PHASE_LABEL.launching}\\d+%$`));
    expect(reserves()).toEqual(slot);
    expect(measures()).toBe(0);
    rects.mockRestore();
  });

  it("第二段的槽：单格网格，显示的行宽度记 0 再撑满格子，候选不可见只占宽", () => {
    const css = readFileSync(resolve(__dirname, "StatusIsland.module.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    expect(css).toMatch(/\n\.second\s*\{[^}]*display:\s*grid;[^}]*grid-template-columns:\s*minmax\(0, 1fr\);/);
    expect(css).toMatch(/\n\.face,\s*\.reserve\s*\{[^}]*grid-area:\s*1 \/ 1;/);
    expect(css).toMatch(/\n\.face\s*\{\s*width:\s*0;\s*min-width:\s*100%;\s*\}/);
    expect(css).toMatch(/\n\.reserve\s*\{\s*visibility:\s*hidden;\s*\}/);
  });

  it("运行转崩溃：绿点留着退场，红点同时弹出", async () => {
    mount();
    await running();
    expect(islandButton().querySelectorAll(`.${styles.runningDot}`)).toHaveLength(1);
    exitGame(true);
    await flush();
    expect(launcher.state.session?.phase).toBe("crashed");
    expect(islandButton().querySelectorAll(`.${styles.runningDot}`)).toHaveLength(1);
    const danger = islandButton().querySelectorAll<HTMLElement>(`.${styles.dangerDot}`);
    expect(danger).toHaveLength(1);
    // 小标记的 dot 档：从 0 弹出，同时淡入
    expect([danger[0].style.opacity, danger[0].style.transform]).toEqual(["0", "scale(0)"]);
  });

  it("减少动画：状态点与阶段勾号出现时只淡入，不从小处弹出", async () => {
    view = render(
      <MotionConfig reducedMotion="always">
        <LauncherProvider>
          <ShellProvider>
            <Probe />
            <StatusIsland />
            <OverlayRoot />
          </ShellProvider>
        </LauncherProvider>
      </MotionConfig>,
    );
    await flush();
    act(() => void launcher.actions.launch("生存"));
    await flush();
    const session = launcher.state.session;
    if (session === null) throw new Error("启动后应有会话");
    act(() => islandButton().click());
    await flush();
    act(() => emit(LAUNCH_PHASE_EVENT, { task_id: session.taskId, phase: "preparing", stage_index: 1 }));
    await flush();
    const [check] = [...document.querySelectorAll<HTMLElement>(`[role="dialog"]:not([data-exiting]) .${styles.stageCheck}`)];
    if (check === undefined) throw new Error("完成的阶段没有画勾");
    expect([check.style.opacity, check.style.transform]).toEqual(["0", ""]);

    act(() => emit(LAUNCH_PHASE_EVENT, { task_id: session.taskId, phase: "running", stage_index: 8 }));
    await flush();
    const dot = islandButton().querySelector<HTMLElement>(`.${styles.runningDot}`);
    if (dot === null) throw new Error("运行中应有状态点");
    expect([dot.style.opacity, dot.style.transform]).toEqual(["0", ""]);
  });

  // 抖动层确实在崩溃时晃、胶囊与行自己不平移，要逐帧采样，在 StatusIsland.shake.test.tsx；这里只管它包住了谁。
  // 详情浮层经 portal 挂在浮层根里，DOM 上无论如何都不在抖动层内，断言它在外面什么也测不到，所以不写
  it("抖动层只包胶囊本身：读屏播报在它外面，崩溃时不跟着晃", async () => {
    mount();
    await running();
    const island = islandButton();
    const shaker = island.parentElement;
    if (shaker === null || shaker.className !== styles.shaker) throw new Error("胶囊外面应包着抖动层");
    exitGame(true);
    await flush();
    expect(launcher.state.session?.phase).toBe("crashed");
    const live = document.querySelector<HTMLElement>("[aria-live='polite']");
    expect(live?.textContent).toBe(ISLAND_COPY.announce("生存", PHASE_LABEL.crashed));
    expect([...shaker.children]).toEqual([island]);
    expect(shaker.contains(live)).toBe(false);
  });

  it("抖动层可以收窄：中列放不下时照旧由胶囊收窄、名字走省略号", () => {
    const css = readFileSync(resolve(__dirname, "StatusIsland.module.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    expect(css).toMatch(/\n\.shaker\s*\{[^}]*min-width:\s*0;/);
    expect(css).toMatch(/\n\.island\s*\{[^}]*overflow:\s*hidden;/);
  });

  it("按下缩放走独立 scale 与按压弹簧，减少动画改降内容透明度；字色与底色同时长过渡；进度填充不常驻 will-change", () => {
    const css = readFileSync(resolve(__dirname, "StatusIsland.module.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    expect(css).toMatch(/\n\.island:active\s*\{\s*scale:\s*0\.97;\s*\}/);
    expect(css).toMatch(/\n\.island\s*\{[^}]*transition:\s*scale var\(--sk-spring-tap-dur\) var\(--sk-spring-tap\),\s*background-color var\(--sk-dur-hover\) var\(--sk-ease\)/);
    expect(css).toMatch(/:global\(\[data-sk-reduced\]\) \.island:active\s*\{\s*scale:\s*none;\s*\}/);
    expect(css).toMatch(/:global\(\[data-sk-reduced\]\) \.island:active \.row\s*\{\s*opacity:\s*0\.85;\s*\}/);
    expect(css).toMatch(/\n\.second\s*\{[^}]*transition:\s*color var\(--sk-dur-hover\) var\(--sk-ease\);/);
    expect(css).not.toMatch(/will-change/);
  });

  it("运行点的呼吸与侧栏角标同一套关键帧，缩放走独立属性，挂在点里面那层、不随色调撤掉", () => {
    const css = readFileSync(resolve(__dirname, "StatusIsland.module.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    const breath = /@keyframes breath\s*\{([\s\S]*?)\n\}/.exec(css);
    if (breath === null) throw new Error("样式里没有 breath 关键帧");
    expect(breath[1]).toMatch(/50%\s*\{\s*scale:\s*0\.82;\s*opacity:\s*0\.55;\s*\}/);
    expect(breath[1]).not.toMatch(/transform/);
    expect(css).toMatch(/\n:global\(:root\[data-sk-breath\]:not\(\[data-sk-reduced\]\)\) \.breathing\s*\{[^}]*animation:\s*breath/);
    // 外层归入场与退场（内联的透明度），呼吸不能挂在它上面，否则 CSS 动画盖过退场的透明度
    expect(css).not.toMatch(/\.runningDot\s*\{[^}]*animation/);
  });

  it("运行点分两层：外层是入场、退场的 motion 元素，呼吸与底色在里面那层", async () => {
    mount();
    await running();
    const dot = islandButton().querySelector<HTMLElement>(`.${styles.runningDot}`);
    if (dot === null) throw new Error("运行中应有状态点");
    expect([...dot.children].map((el) => el.className)).toEqual([styles.breathing]);
    // 入场缩放写在外层的内联样式上，里面那层不带内联的透明度与变换
    expect(dot.style.transform).not.toBe("");
    const inner = dot.children[0] as HTMLElement;
    expect(inner.style.opacity).toBe("");
    expect(inner.style.transform).toBe("");
    // 呼吸相位也对齐在里面那层（不在呼吸窗口内时延迟为 0）
    expect(inner.style.getPropertyValue(BREATH_DELAY_VAR)).toBe("0ms");
    expect(dot.style.getPropertyValue(BREATH_DELAY_VAR)).toBe("");
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
