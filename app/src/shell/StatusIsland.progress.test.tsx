// @vitest-environment jsdom
// @module-tag heavy-page
//
// 逐帧看状态岛的进度显示：百分数跟底边进度条一起走，加载走完时进度条与详情里的进度环推满、留一拍再退场。
// 假定时器下 framer-motion 的帧跟着假时钟走，用 stepFrames 逐帧推进；用例收尾先卸载、排空帧循环再换回真实计时器，
// 同文件后面的用例才推得动。
import { MotionConfig } from "framer-motion";
import { act, type ReactNode } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { stubCanvas } from "../art/illustrations/test-canvas";
import { LAUNCH_PHASE_EVENT } from "../ipc/launch";
import { COMPLETION_HOLD_S } from "../lib/progress-display";
import { LauncherProvider, useLauncher, type LauncherApi } from "../state/launcher";
import { drainFrames, render, stepFrames, stubMatchMedia, stubResizeObserver, type Rendered } from "../test/dom";
import type { IpcRecorder } from "../test/fake-bridge";
import { bootOverrides, deferred, emit, instanceDto, resetRecorder, settle } from "../test/launcher";
import { OverlayRoot } from "./overlay";
import { ShellProvider } from "./shell";
import { StatusIsland } from "./StatusIsland";
import styles from "./StatusIsland.module.css";

const ipc = vi.hoisted((): IpcRecorder => ({ calls: [], overrides: new Map() }));
vi.mock("../ipc/bridge", async (orig) => (await import("../test/fake-bridge")).fakeBridge(await orig(), ipc));

let view: Rendered | undefined;
let launcher: LauncherApi;

function Probe() {
  launcher = useLauncher();
  return null;
}

/** 一帧的毫秒数，与 stepFrames 每步推进的一致。 */
const FRAME_MS = 16;

beforeEach(() => {
  vi.useFakeTimers();
  resetRecorder(ipc);
  stubResizeObserver();
  stubCanvas();
  stubMatchMedia(false);
  bootOverrides(ipc, { instances: [instanceDto("生存")] });
  ipc.overrides.set("art_status", () => ({ source: null, panorama: false }));
  // 启动一直停在加载：进入运行由阶段事件推进
  ipc.overrides.set("launch_game", () => deferred<never>().promise);
});
afterEach(async () => {
  view?.unmount();
  view = undefined;
  await drainFrames();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function mount(wrap: (node: ReactNode) => ReactNode = (node) => node) {
  view = render(
    wrap(
      <LauncherProvider>
        <ShellProvider>
          <Probe />
          <StatusIsland />
          <OverlayRoot />
        </ShellProvider>
      </LauncherProvider>,
    ),
  );
}

async function launch(): Promise<string> {
  await act(async () => {
    await settle();
    void launcher.actions.launch("生存");
    await settle();
  });
  const session = launcher.state.session;
  if (session === null) throw new Error("启动后应有会话");
  return session.taskId;
}

function islandButton(): HTMLButtonElement {
  const island = document.querySelector<HTMLButtonElement>("[aria-haspopup='dialog']");
  if (island === null) throw new Error("状态岛没有出现");
  return island;
}

/** 底边进度条的填充位移（百分比，0 为满格）；进度条已撤下时为 null。 */
function barOffset(): number | null {
  const fill = islandButton().querySelector<HTMLElement>(`.${styles.barFill}`);
  if (fill === null) return null;
  const m = /translateX\((-?[\d.e-]+)%\)/.exec(fill.style.transform);
  return m === null ? 0 : Number(m[1]);
}

/** 推一条阶段事件；只有下载阶段带进度快照（共 10 个文件，已完成 finished 个）。 */
const emitPhase = (taskId: string, phase: "downloading" | "launching" | "running", stageIndex: number, finished = 0) =>
  act(() =>
    emit(LAUNCH_PHASE_EVENT, {
      task_id: taskId,
      phase,
      stage_index: stageIndex,
      ...(phase === "downloading" ? { download: { finished, total: 10, bytes: 0, total_bytes: null, speed: 0 } } : {}),
    }),
  );

it("加载走完进入运行：底边进度条与详情里的进度环推到满格（环写 100%），留一拍再退场", async () => {
  mount();
  const taskId = await launch();
  emitPhase(taskId, "launching", 7);
  await stepFrames(40);
  // 停在启动阶段的起点 91%
  expect(barOffset()).toBeCloseTo(-9, 1);
  act(() => islandButton().click());
  await stepFrames(30);
  const ring = () => document.querySelector<HTMLElement>(`.${styles.headRing}:not([inert]) [role="progressbar"]`);
  expect(ring()?.textContent).toBe("91%");

  emitPhase(taskId, "running", 8);
  expect(launcher.state.session?.phase).toBe("running");
  // 收尾这一拍里进度条还在原处、向满格走；没有收尾的话它在进入运行的那一刻就开始淡出，120 ms 后已经撤下
  const offsets: number[] = [];
  const holdFrames = Math.floor((COMPLETION_HOLD_S * 1000) / FRAME_MS) - 1;
  for (let i = 0; i < holdFrames; i++) {
    await stepFrames(1);
    const offset = barOffset();
    if (offset === null) throw new Error(`第 ${i + 1} 帧进度条就撤下了，收尾没有留住`);
    offsets.push(offset);
  }
  expect(offsets.some((o) => o > -9 && o < -0.5)).toBe(true);
  expect(offsets.at(-1)).toBeGreaterThan(-0.5);
  // 运行中了：环不再封顶 99%
  expect(ring()?.textContent).toBe("100%");

  // 留够一拍之后照常退场：进度条与进度环都撤下
  await stepFrames(30);
  expect(barOffset()).toBeNull();
  expect(ring()).toBeNull();
});

it("减少动画：进入运行时不留，进度条直接退场", async () => {
  mount((node) => <MotionConfig reducedMotion="always">{node}</MotionConfig>);
  const taskId = await launch();
  emitPhase(taskId, "launching", 7);
  await stepFrames(10);
  expect(barOffset()).not.toBeNull();

  emitPhase(taskId, "running", 8);
  // 淡出 120 ms：留住一拍的话这时还在
  await stepFrames(Math.floor((COMPLETION_HOLD_S * 1000) / FRAME_MS) - 1);
  expect(barOffset()).toBeNull();
});

it("胶囊上的百分数跟底边进度条一起逐帧走过去，不当场跳到新值", async () => {
  mount();
  const taskId = await launch();
  emitPhase(taskId, "downloading", 4, 0);
  await stepFrames(40);
  // jsdom 窗口宽 1024，按 compact 档只写百分比
  const value = () => islandButton().querySelector<HTMLElement>(`.${styles.face} .${styles.value}`);
  expect(value()?.textContent).toBe("30%");
  const node = value();

  emitPhase(taskId, "downloading", 4, 2);
  expect(value()?.textContent).toBe("30%");
  const seen: string[] = [];
  for (let i = 0; i < 40; i++) {
    await stepFrames(1);
    const text = value()?.textContent;
    if (text !== undefined && text !== null && seen.at(-1) !== text) seen.push(text);
  }
  // 同一个节点原地走：中间值一个个出现，最后停在新值，与进度条同一处落定
  expect(value()).toBe(node);
  expect(seen.at(-1)).toBe("39%");
  expect(seen.filter((t) => t !== "30%" && t !== "39%").length).toBeGreaterThan(0);
  expect(barOffset()).toBeCloseTo(-61, 1);
});
