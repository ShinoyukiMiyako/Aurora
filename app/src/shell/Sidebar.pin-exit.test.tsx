// @vitest-environment jsdom
// @module-tag heavy-page
// 取消固定的那一项怎么退场。要等 framer-motion 的帧循环把退场播完、把节点拿掉，整个文件走真实时间：
// 假定时器下帧跟着假时钟走，而同文件里别的用例换计时器时会把帧循环卡住（见 test/dom.ts）。
import { MotionConfig } from "framer-motion";
import { act } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { stubCanvas } from "../art/illustrations/test-canvas";
import { LauncherProvider, useLauncherActions } from "../state/launcher";
import { render, stubMatchMedia, stubResizeObserver, waitForFrames, type Rendered } from "../test/dom";
import type { IpcRecorder } from "../test/fake-bridge";
import { bootOverrides, instanceDto, resetRecorder } from "../test/launcher";
import { ChromeProvider, type ChromeApi } from "./chrome";
import { OverlayRoot } from "./overlay";
import { ShellProvider } from "./shell";
import { Sidebar } from "./Sidebar";

const ipc = vi.hoisted((): IpcRecorder => ({ calls: [], overrides: new Map() }));
vi.mock("../ipc/bridge", async (orig) => (await import("../test/fake-bridge")).fakeBridge(await orig(), ipc));

const chrome: ChromeApi = { scrollContentToTop: vi.fn(), focusContent: vi.fn() };
let view: Rendered | undefined;
let launcher: ReturnType<typeof useLauncherActions>;

function Probe() {
  launcher = useLauncherActions();
  return null;
}

/** 真实时间下让挂起的命令与回调跑完。 */
const flush = () =>
  act(async () => {
    for (let i = 0; i < 10; i++) await new Promise<void>((resolve) => setTimeout(resolve, 0));
  });

async function mount(reducedMotion: "never" | "always") {
  view = render(
    <MotionConfig reducedMotion={reducedMotion}>
      <LauncherProvider>
        <ShellProvider>
          <ChromeProvider value={chrome}>
            <Probe />
            <Sidebar />
            <OverlayRoot />
          </ChromeProvider>
        </ShellProvider>
      </LauncherProvider>
    </MotionConfig>,
  );
  await flush();
}

/** 取消固定 id，等那一行退场播完、从 DOM 里拿掉；返回这期间它的内联样式先后写成过的每一份（含最后一份）。 */
async function unpinAndWatch(id: string): Promise<string[]> {
  const row = document.querySelector(`[data-sidebar-item="pin:${id}"]`)?.closest("li");
  if (row === null || row === undefined) throw new Error(`固定项 ${id} 不在列表项里`);
  const written: string[] = [];
  const collect = (records: MutationRecord[]) => {
    for (const record of records) if (record.oldValue !== null) written.push(record.oldValue);
  };
  const observer = new MutationObserver(collect);
  observer.observe(row, { attributes: true, attributeFilter: ["style"], attributeOldValue: true });
  await act(async () => {
    await launcher.togglePin(id);
  });
  await waitForFrames(() => expect(row.isConnected).toBe(false));
  collect(observer.takeRecords());
  observer.disconnect();
  const last = row.getAttribute("style");
  if (last === null) throw new Error(`固定项 ${id} 退场时没有写过内联样式`);
  written.push(last);
  return written;
}

beforeEach(() => {
  resetRecorder(ipc);
  stubResizeObserver();
  stubMatchMedia(false);
  stubCanvas();
  bootOverrides(ipc, { instances: [instanceDto("生存"), instanceDto("创造")], pins: ["生存", "创造"] });
  ipc.overrides.set("art_status", () => ({ source: null, panorama: false }));
  ipc.overrides.set("updater_info", () => ({ current_version: "0.1.0", supported: true, unsupported_reason: null, available: null, downloaded_version: null, install_on_exit: false }));
  ipc.overrides.set("set_sidebar_pins", (args) => args.pins);
});
afterEach(() => {
  view?.unmount();
  view = undefined;
  vi.unstubAllGlobals();
});

it("平常：取消固定的那一项边淡出边缩小", async () => {
  await mount("never");
  const written = await unpinAndWatch("生存");
  expect(written.some((style) => /opacity: 0;/.test(style))).toBe(true);
  expect(written.some((style) => /scale\(0\.\d+\)/.test(style))).toBe(true);
});

it("减少动画：取消固定的那一项只淡出，退场途中不缩放也不位移", async () => {
  await mount("always");
  const written = await unpinAndWatch("生存");
  // 退场确实播到了终点（透明度写到 0 才拿掉），不是没播就被拿掉
  expect(written.some((style) => /opacity: 0;/.test(style))).toBe(true);
  expect(written.filter((style) => /scale|translate/.test(style))).toEqual([]);
});
