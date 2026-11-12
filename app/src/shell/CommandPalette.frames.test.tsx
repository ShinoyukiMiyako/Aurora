// @vitest-environment jsdom
// @module-tag heavy-page
//
// 要逐帧看面板进出的用例单独一个文件：整个文件走假时钟，帧跟着它一帧一帧走（test/dom 的 stepFrames）。
// 收尾固定为先卸载、再 drainFrames、再换回真实计时器，同文件后面的用例帧循环才接得上。
// 减少动画经外观偏好打开：AppearanceProvider 自己包着根部 MotionConfig，在它外面再包一层会被它盖掉。
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stubCanvas } from "../art/illustrations/test-canvas";
import { DEFAULT_APPEARANCE, AppearanceProvider } from "../state/appearance";
import { LauncherProvider } from "../state/launcher";
import { drainFrames, render, stepFrames, stubMatchMedia, stubResizeObserver, type Rendered } from "../test/dom";
import type { IpcRecorder } from "../test/fake-bridge";
import { bootOverrides, instanceDto, resetRecorder, settle } from "../test/launcher";
import { ChromeProvider, type ChromeApi } from "./chrome";
import { CommandPalette } from "./CommandPalette";
import { OverlayRoot } from "./overlay";
import { ShellProvider, useShell, type ShellApi } from "./shell";

const ipc = vi.hoisted((): IpcRecorder => ({ calls: [], overrides: new Map() }));
vi.mock("../ipc/bridge", async (orig) => (await import("../test/fake-bridge")).fakeBridge(await orig(), ipc));

let view: Rendered | undefined;
let shell: ShellApi;
const chrome: ChromeApi = { scrollContentToTop: vi.fn(), focusContent: vi.fn() };

function Probe() {
  shell = useShell();
  return null;
}

beforeEach(async () => {
  vi.useFakeTimers();
  resetRecorder(ipc);
  stubResizeObserver();
  stubMatchMedia(false);
  stubCanvas();
  bootOverrides(ipc, { instances: [instanceDto("生存"), instanceDto("创造")] });
  ipc.overrides.set("art_status", () => ({ source: null, panorama: false }));
  view = render(
    <AppearanceProvider initial={{ ...DEFAULT_APPEARANCE, reduceMotion: true }}>
      <LauncherProvider>
        <ShellProvider>
          <ChromeProvider value={chrome}>
            <Probe />
            <CommandPalette />
            <OverlayRoot />
          </ChromeProvider>
        </ShellProvider>
      </LauncherProvider>
    </AppearanceProvider>,
  );
  await act(async () => {
    await settle();
  });
});

afterEach(async () => {
  view?.unmount();
  view = undefined;
  await drainFrames();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const panel = () => {
  const el = document.querySelector<HTMLElement>("[role='dialog']");
  if (el === null) throw new Error("命令面板没有打开");
  return el;
};

describe("减少动画时命令面板的进出", () => {
  it("入场起点只有透明度：挂载那一刻不带位移与缩放", () => {
    act(() => shell.openPalette());
    expect(panel().style.opacity).toBe("0");
    expect(panel().style.transform).not.toMatch(/translate|scale/);
  });

  it("退场只淡出：减少动画下缩放一步到位，整段退场里一帧都不先缩", async () => {
    act(() => shell.openPalette());
    const dialog = panel();
    await stepFrames(30);
    expect(dialog.style.opacity).toBe("1");

    act(() => shell.closePalette());
    const frames: { transform: string; opacity: number }[] = [];
    for (let i = 0; i < 40 && dialog.isConnected; i++) {
      await stepFrames(1);
      frames.push({ transform: dialog.style.transform, opacity: Number(dialog.style.opacity) });
    }
    expect(dialog.isConnected).toBe(false);
    // 确实分几帧淡出（fade.out 约 120 ms），且每一帧都没有位移与缩放
    expect(frames.filter((f) => f.opacity > 0 && f.opacity < 1).length).toBeGreaterThan(2);
    expect(frames.filter((f) => /translate|scale/.test(f.transform))).toEqual([]);
  });
});
