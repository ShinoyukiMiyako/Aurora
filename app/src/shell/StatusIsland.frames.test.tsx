// @vitest-environment jsdom
// @module-tag heavy-page
//
// 要逐帧看动画的用例单独一个文件：假定时器下 framer-motion 的帧跟着假时钟走（jsdom 的 requestAnimationFrame 每次排帧都用
// 被假掉的 setInterval），推进多少就走多少帧。这里的用例收尾时不排空帧循环就换回真实计时器，还排在旧假时钟上的那一帧永远不来，
// 同文件里之后的用例帧循环就停了。要和别的用例放在一起，收尾改成先卸载、再 drainFrames、再换计时器（见 test/dom.ts）。
import { MotionConfig } from "framer-motion";
import { act } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { stubCanvas } from "../art/illustrations/test-canvas";
import { GAME_EXIT_EVENT } from "../ipc/launch";
import { LauncherProvider, useLauncher, type LauncherApi } from "../state/launcher";
import { render, stubMatchMedia, stubResizeObserver, type Rendered } from "../test/dom";
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

beforeEach(() => {
  vi.useFakeTimers();
  resetRecorder(ipc);
  stubResizeObserver();
  stubCanvas();
  stubMatchMedia(false);
  bootOverrides(ipc, { instances: [instanceDto("生存")] });
  ipc.overrides.set("art_status", () => ({ source: null, panorama: false }));
  ipc.overrides.set("launch_game", () => ({ pid: 4242 }));
});
afterEach(() => {
  view?.unmount();
  view = undefined;
  vi.useRealTimers();
  vi.unstubAllGlobals();
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
  // 推进假时钟让入场播完，再逐帧采样整段退场
  await advance(1000);
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
