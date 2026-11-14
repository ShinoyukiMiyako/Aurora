// @vitest-environment jsdom
// 向导的退场：换步时旧的一步怎么走、收尾时整个向导怎么走。要等 framer-motion 的帧循环把退场播完，整个文件走真实时间；
// 假定时器下帧循环一旦停住，同一文件后面的用例就推不动它，所以不和 onboarding.test 里只看挂载时刻的用例放在一起。
import { AnimatePresence } from "framer-motion";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stubCanvas } from "../../art/illustrations/test-canvas";
import { resetMocks } from "../../ipc/mock";
import { OverlayRoot } from "../../shell/overlay";
import { ShellProvider } from "../../shell/shell";
import { AppearanceProvider, DEFAULT_APPEARANCE } from "../../state/appearance";
import { LauncherProvider, useLauncher } from "../../state/launcher";
import { render, stubMatchMedia, stubResizeObserver, waitForFrames, type Rendered } from "../../test/dom";
import type { IpcRecorder } from "../../test/fake-bridge";
import { resetRecorder } from "../../test/launcher";
import OnboardingFlow from "./index";

const ipc = vi.hoisted((): IpcRecorder => ({ calls: [], overrides: new Map() }));
vi.mock("../../ipc/bridge", async (orig) => (await import("../../test/fake-bridge")).fakeBridge(await orig(), ipc));

let view: Rendered | undefined;

/** 与外壳一样把向导包一层放在 AnimatePresence 里：收尾后它要演完自己的退场才离开。 */
function Harness() {
  const launcher = useLauncher();
  return (
    <AnimatePresence>
      {launcher.state.firstRun === true && (
        <div key="onboarding">
          <OnboardingFlow />
        </div>
      )}
    </AnimatePresence>
  );
}

/** 真实时间下让挂起的命令与回调跑完。 */
const flush = () =>
  act(async () => {
    for (let i = 0; i < 10; i++) await new Promise<void>((resolve) => setTimeout(resolve, 0));
  });

async function mount(reduceMotion: boolean) {
  view = render(
    <AppearanceProvider initial={{ ...DEFAULT_APPEARANCE, reduceMotion }}>
      <LauncherProvider>
        <ShellProvider>
          <Harness />
          <OverlayRoot />
        </ShellProvider>
      </LauncherProvider>
    </AppearanceProvider>,
  );
  await waitForFrames(() => expect(presentTitle()).toBe("游戏文件放在哪"));
}

const presentPane = () => document.querySelector<HTMLElement>("[data-step-pane]:not([inert])");
const presentTitle = () => presentPane()?.querySelector("h1")?.textContent;

/** 读屏读得到的文字：主按钮的两条文案各放一层叠着，非当前的那层带 aria-hidden，不算。 */
function visibleText(el: Element): string {
  let out = "";
  for (const child of el.childNodes) {
    if (child instanceof Element) {
      if (child.getAttribute("aria-hidden") !== "true") out += visibleText(child);
    } else if (child instanceof Text) out += child.data;
  }
  return out.trim();
}

function button(name: string): HTMLButtonElement {
  const found = [...document.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.closest("[inert]") === null && visibleText(b) === name);
  if (found === undefined) throw new Error(`找不到按钮「${name}」`);
  return found;
}

/** 每次写样式时记下这个元素的透明度与 transform，直到停止观察。 */
function recordStyle(el: HTMLElement): { writes: { opacity: string; transform: string }[]; stop: () => void } {
  const writes: { opacity: string; transform: string }[] = [];
  const watcher = new MutationObserver(() => writes.push({ opacity: el.style.opacity, transform: el.style.transform }));
  watcher.observe(el, { attributes: true, attributeFilter: ["style"] });
  return { writes, stop: () => watcher.disconnect() };
}

interface Stepped {
  /** 新的一步挂上那一刻的 transform。 */
  arriving: string;
  /** 旧的一步从开始退场到移出 DOM 之间写过的每一个 transform。 */
  leaving: string[];
}

/** 从第一步前进到第二步，等旧的一步退场播完。 */
async function stepForward(): Promise<Stepped> {
  const old = presentPane();
  if (old === null) throw new Error("没有在场的步骤");
  const stage = old.parentElement;
  if (stage === null) throw new Error("步骤不在舞台里");
  const record = recordStyle(old);
  // 新的一步插进来那一刻的 transform：等到它在场再读，帧循环已经推着它走了几帧
  const inserted: string[] = [];
  const inserts = new MutationObserver((records) => {
    for (const r of records) for (const node of r.addedNodes) if (node instanceof HTMLElement && node.hasAttribute("data-step-pane")) inserted.push(node.style.transform);
  });
  inserts.observe(stage, { childList: true });
  try {
    act(() => button("下一步").click());
    await waitForFrames(() => expect(presentTitle()).toBe("看看这台电脑上的 Java"));
    await waitForFrames(() => expect(old.isConnected).toBe(false));
    expect(inserted).toHaveLength(1);
    return { arriving: inserted[0], leaving: record.writes.map((w) => w.transform) };
  } finally {
    record.stop();
    inserts.disconnect();
  }
}

/** 第二步点「直接开始」收尾，等向导整体退场播完；返回根元素退场期间写过的样式。 */
async function finishFromStepTwo(): Promise<{ opacity: string; transform: string }[]> {
  act(() => button("下一步").click());
  await waitForFrames(() => expect(presentTitle()).toBe("看看这台电脑上的 Java"));
  const root = document.querySelector<HTMLElement>("[role='group'][aria-label='首次启动设置']")?.parentElement;
  if (root === null || root === undefined) throw new Error("没有向导根");
  const record = recordStyle(root);
  try {
    act(() => button("直接开始").click());
    await flush();
    await waitForFrames(() => expect(root.isConnected).toBe(false));
    return record.writes;
  } finally {
    record.stop();
  }
}

const SCALE = /scale\(([\d.]+)\)/;
const shifted = (transforms: string[]) => transforms.filter((transform) => transform.includes("translate"));

beforeEach(() => {
  resetMocks();
  resetRecorder(ipc);
  stubResizeObserver();
  stubMatchMedia(false);
  stubCanvas();
  ipc.overrides.set("art_status", () => ({ source: null, panorama: false }));
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  vi.spyOn(console, "info").mockImplementation(() => undefined);
});

afterEach(() => {
  view?.unmount();
  view = undefined;
  document.documentElement.removeAttribute("data-sk-mode");
  document.documentElement.removeAttribute("data-sk-accent");
  document.documentElement.removeAttribute("data-sk-reduced");
  vi.unstubAllGlobals();
});

describe("换步的退场", () => {
  it("平时旧的一步朝反方向横移着淡出，新的一步从前进一侧进来", async () => {
    await mount(false);
    const { arriving, leaving } = await stepForward();
    expect(arriving).toBe("translateX(16px)");
    expect(shifted(leaving).some((transform) => transform.startsWith("translateX(-"))).toBe(true);
  });

  it("减少动画时只淡入淡出：旧的一步不先横跳一下再淡，新的一步也不从侧边进来", async () => {
    await mount(true);
    const { arriving, leaving } = await stepForward();
    expect(arriving).not.toContain("translate");
    // 退场确实播了（样式被写过），只是没有一次带位移
    expect(leaving.length).toBeGreaterThan(0);
    expect(shifted(leaving)).toEqual([]);
  });
});

describe("收尾的退场", () => {
  it("整体淡出并放大到 1.02，缩放与透明度走同一段 fade.out：透明度到 0 时缩放也已到位，外壳不必再等弹簧静止", async () => {
    await mount(false);
    const writes = await finishFromStepTwo();
    const frames = writes.flatMap(({ opacity, transform }) => {
      const scale = SCALE.exec(transform);
      return scale === null || opacity === "" ? [] : [{ opacity: Number(opacity), scale: Number(scale[1]) }];
    });
    expect(frames.length).toBeGreaterThan(1);
    expect(Math.max(...frames.map((f) => f.scale))).toBeGreaterThan(1.015);
    expect(Math.max(...frames.map((f) => f.scale))).toBeLessThanOrEqual(1.02);
    expect(Math.min(...frames.map((f) => f.opacity))).toBeLessThan(0.5);
    // 同一条补间：每一帧里放大走过的比例与透明度走过的比例相同
    for (const { opacity, scale } of frames) expect(Math.abs((scale - 1) / 0.02 - (1 - opacity))).toBeLessThan(0.02);
  });

  it("减少动画时只淡出，不放大：缩放在那里是一步到位的，面板会先整体跳大一下", async () => {
    await mount(true);
    const writes = await finishFromStepTwo();
    expect(writes.some(({ opacity }) => opacity !== "" && Number(opacity) < 1)).toBe(true);
    expect(writes.filter(({ transform }) => transform.includes("scale"))).toEqual([]);
  });
});
