// @vitest-environment jsdom
// @module-tag heavy-page
//
// 逐帧看崩溃抖动。和 StatusIsland.frames.test.tsx 分开放的原因相同：framer-motion 的帧循环挂在假定时器接管的
// requestAnimationFrame 上，同一文件里第二个要逐帧推进的用例帧循环会停住，一个文件只放一个。
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
import styles from "./StatusIsland.module.css";

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

/** 内联 transform 里 translateX 的像素值；没有平移记 0。 */
function shiftX(el: HTMLElement): number {
  const m = /translateX\((-?[\d.]+)px\)/.exec(el.style.transform);
  return m === null ? 0 : Number(m[1]);
}

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

it("崩溃时包住胶囊的那层左右抖一次再回到原位，胶囊与岛内的行自己都不平移", async () => {
  view = render(
    <LauncherProvider>
      <ShellProvider>
        <Probe />
        <StatusIsland />
        <OverlayRoot />
      </ShellProvider>
    </LauncherProvider>,
  );
  await act(async () => {
    await settle();
    await launcher.actions.launch("生存");
    await settle();
  });
  expect(launcher.state.session?.phase).toBe("running");
  const island = document.querySelector<HTMLButtonElement>("[aria-haspopup='dialog']");
  if (island === null) throw new Error("状态岛没有出现");
  const shaker = island.parentElement;
  if (shaker === null || shaker.className !== styles.shaker) throw new Error("胶囊外面应包着抖动层");
  const row = island.querySelector<HTMLElement>(`.${styles.row}`);
  if (row === null) throw new Error("胶囊里没有内容行");
  // 入场播完：运行中不抖
  await advance(1000);
  expect(shiftX(shaker)).toBe(0);

  act(() => emit(GAME_EXIT_EVENT, { version_id: "生存", exit_code: 1, crashed: true, killed: false, duration_ms: 60_000 }));
  const frames: { shaker: number; island: number; row: number }[] = [];
  for (let i = 0; i < 40; i++) {
    await advance(16);
    frames.push({ shaker: shiftX(shaker), island: shiftX(island), row: shiftX(row) });
  }
  expect(launcher.state.session?.phase).toBe("crashed");
  // 来回各晃到过一侧，幅度不超过关键帧的 4px
  const xs = frames.map((f) => f.shaker);
  expect(Math.min(...xs)).toBeLessThan(-1);
  expect(Math.max(...xs)).toBeGreaterThan(1);
  expect(Math.max(...xs.map(Math.abs))).toBeLessThanOrEqual(4);
  expect(frames.at(-1)?.shaker).toBe(0);
  expect(frames.filter((f) => f.island !== 0 || f.row !== 0)).toEqual([]);
});
