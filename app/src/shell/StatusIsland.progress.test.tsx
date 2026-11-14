// @vitest-environment jsdom
// @module-tag heavy-page
//
// 逐帧看状态岛的进度显示：百分数跟底边进度条一起走，加载走完时进度条与详情里的进度环推满、留一拍再退场。
// 假定时器下 framer-motion 的帧跟着假时钟走，用 stepFrames 逐帧推进；用例收尾先卸载、排空帧循环再换回真实计时器，
// 同文件后面的用例才推得动。
import { MotionConfig, type MotionValue } from "framer-motion";
import { act, type ReactNode } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { stubCanvas } from "../art/illustrations/test-canvas";
import { PHASE_LABEL } from "../copy/flows";
import { LAUNCH_PHASE_EVENT } from "../ipc/launch";
import { COMPLETION_HOLD_S } from "../lib/progress-display";
import { LauncherProvider, useLauncher, type LauncherApi } from "../state/launcher";
import { drainFrames, render, stepFrames, stubMatchMedia, stubResizeObserver, type Rendered } from "../test/dom";
import type { IpcRecorder } from "../test/fake-bridge";
import { bootOverrides, cancelledError, deferred, emit, instanceDto, resetRecorder, settle } from "../test/launcher";
import { MIN_VISIBLE_PROGRESS } from "../ui/ProgressBar";
import { OverlayRoot } from "./overlay";
import { ShellProvider } from "./shell";
import { StatusIsland, useIslandProgress } from "./StatusIsland";
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

/** 填充位移（translateX 的百分比字符串）换成条露出的比例（百分数，不取整）。 */
function exposedOf(offset: string): number {
  const m = /^(-?[\d.e-]+)%$/.exec(offset);
  if (m === null) throw new Error(`不是百分比位移：${offset}`);
  return 100 + Number(m[1]);
}

/** 底边进度条此刻露出的比例（百分数，不取整）。 */
function barExposed(): number {
  const offset = barOffset();
  if (offset === null) throw new Error("进度条已经撤下");
  return 100 + offset;
}

/** 底边进度条此刻的进度（整数百分数），与胶囊上的百分数同一种取整。 */
function barPercent(): number {
  const offset = barOffset();
  if (offset === null) throw new Error("进度条已经撤下");
  return Math.round(100 + offset);
}

/** 胶囊第二段里显示的那一行（不含占宽的候选），按 DOM 顺序：退场中的旧行在前，新行在后。 */
function faces(): HTMLElement[] {
  return [...islandButton().querySelectorAll<HTMLElement>(`.${styles.face}`)];
}

/** 一行里的百分数。 */
function facePercent(face: HTMLElement): number {
  const text = face.textContent;
  const m = text === null ? null : /(\d+)%$/.exec(text);
  if (m === null) throw new Error(`这一行没有百分数：${text}`);
  return Number(m[1]);
}

/** 推一条阶段事件；只有下载阶段带进度快照（共 10 个文件，已完成 finished 个）。 */
const emitPhase = (taskId: string, phase: "preparing" | "downloading" | "launching" | "running", stageIndex: number, finished = 0) =>
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

it("阶段文字一变，新行从底边进度条此刻的位置起步，逐帧与条同数；退场中的旧行读同一个值，只有标签不同", async () => {
  // regular 档才写阶段文字，阶段一变整行换掉
  vi.stubGlobal("innerWidth", 1280);
  mount();
  const taskId = await launch();
  // 不需要下载的启动：准备阶段走到 20% 停稳，接着直接进启动阶段的起点 75%
  emitPhase(taskId, "preparing", 3);
  await stepFrames(40);
  const [preparing] = faces();
  expect(preparing.textContent).toBe(`${PHASE_LABEL.preparing}20%`);
  expect(barPercent()).toBe(20);

  emitPhase(taskId, "launching", 5);
  const launching = faces().at(-1);
  if (launching === undefined || launching === preparing) throw new Error("阶段文字变了应换上新行");
  // 这一刻还没出帧：条还在 20%，新行也写 20%，不先报出 75%
  expect(launching.textContent).toBe(`${PHASE_LABEL.launching}20%`);

  const frames: { text: number; bar: number }[] = [];
  const leaving: { text: string | null; bar: number }[] = [];
  for (let i = 0; i < 40; i++) {
    await stepFrames(1);
    frames.push({ text: facePercent(launching), bar: barPercent() });
    if (preparing.isConnected) leaving.push({ text: preparing.textContent, bar: barPercent() });
  }
  // 字与条从同一处、以同一条弹簧走向同一个目标：每一帧都是同一个数，中间值一个个出现，最后一起停在 75%
  expect(frames.filter((f) => f.text !== f.bar)).toEqual([]);
  expect(new Set(frames.map((f) => f.text)).size).toBeGreaterThan(2);
  expect(frames.at(-1)).toEqual({ text: 75, bar: 75 });
  // 旧行淡出的那几帧还在 DOM 里，标签仍是「准备中」，数跟着条走：同屏两行写的是同一个数
  expect(leaving.length).toBeGreaterThan(0);
  expect(leaving.filter((f) => f.text !== `${PHASE_LABEL.preparing}${f.bar}%`)).toEqual([]);
  expect(new Set(leaving.map((f) => f.bar)).size).toBeGreaterThan(1);
});

it("条正在走的时候换阶段：退场中的旧行、新行与底边条读同一个值，换行那一帧及之后逐帧同数", async () => {
  vi.stubGlobal("innerWidth", 1280);
  mount();
  const taskId = await launch();
  // 准备阶段推到 20%，只走几帧：条还带着速度往上走
  emitPhase(taskId, "preparing", 3);
  await stepFrames(3);
  const [preparing] = faces();
  const before = facePercent(preparing);
  expect(before).toBe(barPercent());
  expect(before).toBeGreaterThan(0);
  expect(before).toBeLessThan(20);

  emitPhase(taskId, "launching", 5);
  const launching = faces().at(-1);
  if (launching === undefined || launching === preparing) throw new Error("阶段文字变了应换上新行");
  // 换行那一帧：旧行、新行与条是同一个数
  expect({ leaving: facePercent(preparing), text: facePercent(launching) }).toEqual({ leaving: barPercent(), text: barPercent() });

  const frames: { leaving: number | null; text: number; bar: number }[] = [];
  for (let i = 0; i < 40; i++) {
    await stepFrames(1);
    if (preparing.isConnected && !preparing.textContent?.startsWith(PHASE_LABEL.preparing)) throw new Error(`退场中的旧行换了标签：${preparing.textContent}`);
    frames.push({ leaving: preparing.isConnected ? facePercent(preparing) : null, text: facePercent(launching), bar: barPercent() });
  }
  // 之后逐帧：旧行在场的每一帧与新行、条同数，交叉淡化中两行只有标签不同
  expect(frames.filter((f) => f.text !== f.bar || (f.leaving !== null && f.leaving !== f.bar))).toEqual([]);
  // 旧行在场的这几帧里条走过了不止一个数：旧行停在换行时的数的话，这里就会与条分开
  const overlap = frames.filter((f) => f.leaving !== null);
  expect(overlap.length).toBeGreaterThan(0);
  expect(new Set(overlap.map((f) => f.bar)).size).toBeGreaterThan(1);
  expect(frames.at(-1)).toEqual({ leaving: null, text: 75, bar: 75 });
});

it("停下的一局还留在岛上时再启动：新的一局从 0% 起步，字与条都不从上一局停下的位置往回走", async () => {
  vi.stubGlobal("innerWidth", 1280);
  const first = deferred<never>();
  ipc.overrides.set("launch_game", () => first.promise);
  ipc.overrides.set("cancel_task", () => {
    first.reject(cancelledError());
    return true;
  });
  mount();
  const a = await launch();
  emitPhase(a, "downloading", 4, 0);
  await stepFrames(40);
  expect(barPercent()).toBe(30);
  await act(async () => {
    await launcher.actions.stop();
    await settle();
  });
  expect(launcher.state.session).toMatchObject({ phase: "stopped", stopReason: "cancelled" });
  // 进度条淡出撤下；停下的这一局还要在岛上留一会儿，岛不退场
  await stepFrames(20);
  expect(barOffset()).toBeNull();

  ipc.overrides.set("launch_game", () => deferred<never>().promise);
  const b = await launch();
  expect(b).not.toBe(a);
  const face = faces().at(-1);
  if (face === undefined) throw new Error("新的一局应有显示的行");
  expect(face.textContent).toBe(`${PHASE_LABEL.preparing}0%`);
  const frames: { text: number; bar: number }[] = [];
  for (let i = 0; i < 20; i++) {
    await stepFrames(1);
    frames.push({ text: facePercent(face), bar: barPercent() });
  }
  expect(frames.filter((f) => f.text !== 0 || f.bar !== 0)).toEqual([]);
});

it("减少动画：阶段文字一变，新行直接写目标值，与直接到位的进度条同数", async () => {
  vi.stubGlobal("innerWidth", 1280);
  mount((node) => <MotionConfig reducedMotion="always">{node}</MotionConfig>);
  const taskId = await launch();
  emitPhase(taskId, "preparing", 3);
  await stepFrames(5);
  expect(barPercent()).toBe(20);

  emitPhase(taskId, "launching", 5);
  expect(faces().at(-1)?.textContent).toBe(`${PHASE_LABEL.launching}75%`);
  await stepFrames(1);
  expect(barPercent()).toBe(75);
});

it("加载从 0 起步：底边条从 0 沿弹簧长上去，不一帧冒出最少显示长度；字从 0% 起，逐帧与条同数", async () => {
  vi.stubGlobal("innerWidth", 1280);
  mount();
  const taskId = await launch();
  const face = faces().at(-1);
  if (face === undefined) throw new Error("启动后应有显示的行");
  expect(face.textContent).toBe(`${PHASE_LABEL.preparing}0%`);
  expect(barExposed()).toBe(0);

  // 准备阶段的第二步，起点 5%：目标比最少显示长度大，条与字走同一段弹簧
  emitPhase(taskId, "preparing", 1);
  const frames: { text: number; bar: number }[] = [];
  for (let i = 0; i < 40; i++) {
    await stepFrames(1);
    frames.push({ text: facePercent(face), bar: barExposed() });
  }
  const moved = frames.filter((f) => f.bar > 0);
  expect(moved.length).toBeGreaterThan(2);
  // 条离开 0 的那一帧还不到最少显示长度：下限加在逐帧平滑之后的话，这一帧会一下露出那一截
  expect(moved[0].bar).toBeLessThan(MIN_VISIBLE_PROGRESS * 100);
  expect(frames.filter((f) => f.text !== Math.round(f.bar))).toEqual([]);
  expect(new Set(frames.map((f) => f.text)).size).toBeGreaterThan(2);
  expect(frames.at(-1)?.text).toBe(5);
  expect(frames.at(-1)?.bar).toBeCloseTo(5, 6);
});

it("底边条的最少显示长度：目标比它还小时条从 0 沿弹簧长到它、字照真实进度写；进度过了它之后条与字是同一个值", async () => {
  let probe: { smooth: MotionValue<number>; fill: MotionValue<string> } | null = null;
  function BarProbe({ value }: { value: number }) {
    probe = useIslandProgress(value, "task");
    return null;
  }
  const sample = () => {
    if (probe === null) throw new Error("探针还没挂上");
    return { text: probe.smooth.get() * 100, bar: exposedOf(probe.fill.get()) };
  };
  const floor = MIN_VISIBLE_PROGRESS * 100;
  view = render(<BarProbe value={0} />);
  expect(sample()).toEqual({ text: 0, bar: 0 });

  const tiny = MIN_VISIBLE_PROGRESS * (0.2 + Math.random() * 0.6);
  view.rerender(<BarProbe value={tiny} />);
  const rise: { text: number; bar: number }[] = [];
  for (let i = 0; i < 40; i++) {
    await stepFrames(1);
    rise.push(sample());
  }
  // 条从 0 连续长上去：走了好几帧，没有哪一帧一步跨过最少显示长度的一半
  expect(rise.filter((f) => f.bar > 0 && f.bar < floor / 2).length).toBeGreaterThan(0);
  const steps = rise.map((f, i) => f.bar - (i === 0 ? 0 : rise[i - 1].bar));
  expect(Math.max(...steps)).toBeLessThan(floor / 2);
  // 落定时字写真实进度，条停在最少显示长度
  expect(rise.at(-1)?.text).toBeCloseTo(tiny * 100, 6);
  expect(rise.at(-1)?.bar).toBeCloseTo(floor, 6);

  const target = 0.3 + Math.random() * 0.6;
  view.rerender(<BarProbe value={target} />);
  const climb: { text: number; bar: number }[] = [];
  for (let i = 0; i < 40; i++) {
    await stepFrames(1);
    climb.push(sample());
  }
  const above = climb.filter((f) => f.text >= floor);
  expect(above.length).toBeGreaterThan(2);
  expect(above.filter((f) => Math.abs(f.bar - f.text) > 1e-6)).toEqual([]);
  expect(climb.at(-1)?.text).toBeCloseTo(target * 100, 6);
});
