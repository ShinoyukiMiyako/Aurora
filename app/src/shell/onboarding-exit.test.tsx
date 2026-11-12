// @vitest-environment jsdom
// 向导收尾时的退场与主界面淡入。整个文件走真实时间：退场要等 framer-motion 的帧循环把动画播完，用 waitForFrames 按真实时间等。
// 假定时器下帧跟着假时钟走，不推进就一帧都不来（逐帧推进用 stepFrames，见 test/dom.ts）。AppShell.test 的假定时器用例
// 只推进 0 ms 的计时器，收尾时也不排空帧循环：放在一起的话，换回真实计时器时还排在旧假时钟上的那一帧永远不来，
// 帧循环就此停住，这里的退场推不动，所以单独一个文件。
import { act } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { stubCanvas } from "../art/illustrations/test-canvas";
import { DEFAULT_APPEARANCE, AppearanceProvider } from "../state/appearance";
import { LauncherProvider, useLauncher, type LauncherApi } from "../state/launcher";
import { PAGE_IDS, type Route } from "../state/route";
import { render, stubMatchMedia, stubResizeObserver, waitForFrames, type Rendered } from "../test/dom";
import type { IpcRecorder } from "../test/fake-bridge";
import { bootOverrides, resetRecorder } from "../test/launcher";
import { AppShell } from "./AppShell";
import type { PageTable } from "./nav";
import { createPageRegistry } from "./pages";
import { ShellProvider } from "./shell";
import { browserWindowPort, WindowPortProvider } from "./window";

const ipc = vi.hoisted((): IpcRecorder => ({ calls: [], overrides: new Map() }));
vi.mock("../ipc/bridge", async (orig) => (await import("../test/fake-bridge")).fakeBridge(await orig(), ipc));

let view: Rendered | undefined;
let launcher: LauncherApi;

function Probe() {
  launcher = useLauncher();
  return null;
}

function OnboardingStub() {
  return <p data-flow="onboarding">向导</p>;
}

function StubPage({ route }: { route: Route }) {
  return <p data-page={route.page}>{route.page}</p>;
}

/** 真实时间下让挂起的命令与回调跑完。 */
const flush = () =>
  act(async () => {
    for (let i = 0; i < 10; i++) await new Promise<void>((resolve) => setTimeout(resolve, 0));
  });

beforeEach(() => {
  resetRecorder(ipc);
  stubResizeObserver();
  stubMatchMedia(false);
  stubCanvas();
  bootOverrides(ipc, { instances: [], firstRun: true });
  ipc.overrides.set("art_status", () => ({ source: null, panorama: false }));
  ipc.overrides.set("complete_first_run", () => null);
  ipc.overrides.set("updater_info", () => ({ current_version: "0.1.0", supported: false, unsupported_reason: null, available: null, downloaded_version: null, install_on_exit: false }));
});
afterEach(() => {
  view?.unmount();
  view = undefined;
  vi.unstubAllGlobals();
});

it("向导收尾：顶条随向导主体一起淡出，播完之后主界面再淡入，侧栏与主列从透明开始", async () => {
  const registry = createPageRegistry(Object.fromEntries(PAGE_IDS.map((page) => [page, async () => ({ default: StubPage })])) as unknown as PageTable);
  await registry.load("home");
  view = render(
    <WindowPortProvider port={{ ...browserWindowPort(), show: async () => {} }}>
      <AppearanceProvider initial={{ ...DEFAULT_APPEARANCE, petals: false }}>
        <LauncherProvider>
          <ShellProvider>
            <Probe />
            <AppShell pages={registry} flows={{ login: () => null, onboarding: OnboardingStub, createInstance: null }} />
          </ShellProvider>
        </LauncherProvider>
      </AppearanceProvider>
    </WindowPortProvider>,
  );
  await flush();
  const strip = document.querySelector<HTMLElement>("[data-sk-onboarding] > header");
  if (strip === null) throw new Error("向导没有顶条");

  // 顶条每一次写入的透明度；主界面侧栏槽位挂上那一刻的透明度（帧循环还没来得及推它）
  const stripOpacity: string[] = [];
  new MutationObserver(() => stripOpacity.push(strip.style.opacity)).observe(strip, { attributes: true, attributeFilter: ["style"] });
  let slotAtMount: string | null = null;
  new MutationObserver(() => {
    const slot = document.querySelector<HTMLElement>('[data-tauri-drag-region=""]');
    if (slot !== null && slotAtMount === null) slotAtMount = slot.style.opacity;
  }).observe(document.body, { childList: true, subtree: true });

  await act(async () => {
    await launcher.actions.completeFirstRun("D:\\Games\\.minecraft", []);
  });
  await waitForFrames(() => {
    expect(document.querySelector("[data-flow='onboarding']")).toBeNull();
    expect(document.querySelector("[data-page='home']")).not.toBeNull();
  });
  expect(stripOpacity.some((opacity) => opacity !== "" && Number(opacity) < 1)).toBe(true);
  expect(slotAtMount).toBe("0");
});
