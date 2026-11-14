// @vitest-environment jsdom
// @module-tag heavy-page
//
// 要逐帧看动画的用例单独一个文件：假定时器下 framer-motion 的帧跟着假时钟走（jsdom 的 requestAnimationFrame 每次排帧都用
// 被假掉的 setInterval），推进多少就走多少帧。换计时器之前旧计时器上可能还排着一帧，那一帧永远不来，同文件里之后的用例帧循环就停了：
// 每个用例开始前先在真实计时器上排空再换假时钟，收尾先卸载、再 drainFrames、再换回真实计时器（见 test/dom.ts）。
import { MotionConfig } from "framer-motion";
import { act } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { stubCanvas } from "../art/illustrations/test-canvas";
import { GAME_EXIT_EVENT, LAUNCH_PHASE_EVENT } from "../ipc/launch";
import { LauncherProvider, useLauncher, type LauncherApi } from "../state/launcher";
import { drainFrames, render, stepFrames, stubMatchMedia, stubResizeObserver, type Rendered } from "../test/dom";
import type { IpcRecorder } from "../test/fake-bridge";
import { bootOverrides, emit, instanceDto, resetRecorder, settle } from "../test/launcher";
import { OverlayRoot } from "./overlay";
import { ShellProvider } from "./shell";
import { StatusIsland } from "./StatusIsland";

const ipc = vi.hoisted((): IpcRecorder => ({ calls: [], overrides: new Map() }));
vi.mock("../ipc/bridge", async (orig) => (await import("../test/fake-bridge")).fakeBridge(await orig(), ipc));

let view: Rendered | undefined;
let launcher: LauncherApi;

function Probe() {
  launcher = useLauncher();
  return null;
}

const advance = (ms: number) =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });

beforeEach(async () => {
  await drainFrames();
  vi.useFakeTimers();
  resetRecorder(ipc);
  stubResizeObserver();
  stubCanvas();
  stubMatchMedia(false);
  bootOverrides(ipc, { instances: [instanceDto("生存")] });
  ipc.overrides.set("art_status", () => ({ source: null, panorama: false }));
  ipc.overrides.set("launch_game", () => ({ pid: 4242 }));
});
afterEach(async () => {
  view?.unmount();
  view = undefined;
  await drainFrames();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const islandTree = (reducedMotion: "never" | "always") => (
  <MotionConfig reducedMotion={reducedMotion}>
    <LauncherProvider>
      <ShellProvider>
        <Probe />
        <StatusIsland />
        <OverlayRoot />
      </ShellProvider>
    </LauncherProvider>
  </MotionConfig>
);

it.each(["never", "always"] as const)("状态岛的入场（减少动画 %s）：第一帧画的仍是起点，画出来之后才起步，点击启动那一帧再长也不吃掉入场的开头；之后会话怎么变都不再入场", async (reducedMotion) => {
  // 停在加载中：岛的第二段与尾部之后还会随阶段变，岛本身不该再入场一次
  ipc.overrides.set("launch_game", () => new Promise(() => undefined));
  view = render(islandTree(reducedMotion));
  await act(async () => {
    await settle();
  });
  act(() => void launcher.actions.launch("生存"));
  await act(async () => {
    await settle();
  });
  const session = launcher.state.session;
  if (session === null) throw new Error("启动后应有会话");
  const island = document.querySelector<HTMLButtonElement>("[aria-haspopup='dialog']");
  if (island === null) throw new Error("状态岛没有出现");
  const scaled = reducedMotion === "never";
  const shown = () => [island.style.opacity, island.style.transform];
  expect(shown()).toEqual(["0", "scale(0.92)"]);
  await stepFrames(1);
  expect(shown()).toEqual(["0", "scale(0.92)"]);
  // 放行排在绘制之后的任务里，假时钟要再推进一帧才到点
  await stepFrames(2);
  const opacity = Number(island.style.opacity);
  expect(opacity).toBeGreaterThan(0);
  expect(opacity).toBeLessThan(1);
  if (scaled) {
    const scale = /^scale\((.+)\)$/.exec(island.style.transform);
    if (scale === null) throw new Error(`状态岛没有在落到位的半路上：${island.style.transform}`);
    expect(Number(scale[1])).toBeGreaterThan(0.92);
    expect(Number(scale[1])).toBeLessThan(1);
  } else {
    // 减少动画时缩放一步到位，只有透明度在走
    expect(island.style.transform).toBe("none");
  }
  await stepFrames(60);
  expect(shown()).toEqual(["1", "none"]);

  act(() => emit(LAUNCH_PHASE_EVENT, { task_id: session.taskId, phase: "downloading", stage_index: 4, download: { finished: 2, total: 10, bytes: 0, total_bytes: null, speed: 1024 } }));
  await act(async () => {
    await settle();
  });
  expect(launcher.state.session?.phase).toBe("downloading");
  for (let i = 0; i < 4; i++) {
    await stepFrames(1);
    expect(shown()).toEqual(["1", "none"]);
  }
});

it("减少动画下状态岛退场只淡出，整段退场里一帧都不缩", async () => {
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
  await act(async () => {
    await settle();
    await launcher.actions.launch("生存");
    await settle();
  });
  act(() => emit(GAME_EXIT_EVENT, { version_id: "生存", exit_code: 1, crashed: true, killed: false, duration_ms: 60_000 }));
  await act(async () => {
    await settle();
  });
  expect(launcher.state.session?.phase).toBe("crashed");
  const island = document.querySelector<HTMLButtonElement>("[aria-haspopup='dialog']");
  if (island === null) throw new Error("状态岛没有出现");
  // 逐帧推进让入场播完，再逐帧采样整段退场。入场在画出第一帧之后的任务里才放行，放行的那次重渲染要在一次 act 收尾时才提交，
  // 一口气推进一整段的话它落在这段的末尾，入场还没起步
  await stepFrames(60);
  expect(island.style.opacity).toBe("1");

  act(() => launcher.actions.dismissSession());
  const frames: { transform: string; opacity: number }[] = [];
  for (let i = 0; i < 40 && island.isConnected; i++) {
    await advance(16);
    frames.push({ transform: island.style.transform, opacity: Number(island.style.opacity) });
  }
  expect(island.isConnected).toBe(false);
  // 退场确实分几帧淡出，且每一帧都没有缩放
  expect(frames.filter((f) => f.opacity > 0 && f.opacity < 1).length).toBeGreaterThan(2);
  expect(frames.filter((f) => /scale/.test(f.transform))).toEqual([]);
});
