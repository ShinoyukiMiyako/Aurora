// @vitest-environment jsdom
// @module-tag heavy-page
// 快览里新来的任务行逐帧看入场从哪一帧开始走。整个文件走假时钟、用 stepFrames 一帧一帧地推：
// 每个用例开始前先在真实计时器上把帧循环排空再换假时钟，收尾先卸载、再排空、再换回真实计时器（见 test/dom 的 drainFrames）。
import { MotionConfig } from "framer-motion";
import { act } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { LauncherProvider, useLauncher, type LauncherApi } from "../state/launcher";
import { drainFrames, render, stepFrames, stubResizeObserver, type Rendered } from "../test/dom";
import type { IpcRecorder } from "../test/fake-bridge";
import { bootOverrides, deferred, resetRecorder, settle } from "../test/launcher";
import { DownloadPeek } from "./DownloadPeek";
import { OverlayRoot } from "./overlay";
import { ShellProvider } from "./shell";

const ipc = vi.hoisted((): IpcRecorder => ({ calls: [], overrides: new Map() }));
vi.mock("../ipc/bridge", async (orig) => (await import("../test/fake-bridge")).fakeBridge(await orig(), ipc));

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

beforeEach(async () => {
  await drainFrames();
  vi.useFakeTimers();
  vi.setSystemTime(1_730_000_000_000);
  stubResizeObserver();
  resetRecorder(ipc);
  bootOverrides(ipc);
  // 任务一直在跑：行留在快览里
  ipc.overrides.set("install_java", () => deferred<unknown>().promise);
});

afterEach(async () => {
  view?.unmount();
  view = undefined;
  await drainFrames();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function startJava(major: number): Promise<string> {
  await act(() => launcher.actions.installJava(major));
  await flush();
  const task = launcher.state.tasks.find((t) => t.spec.args.requiredMajor === major);
  if (task === undefined) throw new Error(`没有 Java ${major} 的任务`);
  return task.title;
}

/** 标题含 title 的在场行，恰好一个。 */
function row(title: string): HTMLElement {
  const found = [...document.querySelectorAll<HTMLElement>("li")].filter((li) => li.textContent?.includes(title) && li.closest("[inert]") === null);
  if (found.length !== 1) throw new Error(`「${title}」在场的行应当恰好一个，实为 ${found.length}`);
  return found[0];
}

const shown = (li: HTMLElement) => [li.style.opacity, li.style.transform];

/** 停在终点：不透明、没有缩放（入场的目标里带着缩放时 framer-motion 写的是 none）。 */
function expectSettled(li: HTMLElement) {
  expect(li.style.opacity).toBe("1");
  expect(li.style.transform).toMatch(/^(none)?$/);
}

it.each(["never", "always"] as const)("快览开着时新来的行（减少动画 %s）：第一帧画的仍是起点，画出来之后才开始入场；打开时就在的行自始至终不动", async (reducedMotion) => {
  view = render(
    <MotionConfig reducedMotion={reducedMotion}>
      <LauncherProvider>
        <ShellProvider>
          <Probe />
          <DownloadPeek />
          <OverlayRoot />
        </ShellProvider>
      </LauncherProvider>
    </MotionConfig>,
  );
  await flush();
  const first = await startJava(21);
  const entry = view.container.querySelector<HTMLButtonElement>("button[aria-haspopup='dialog']");
  if (entry === null) throw new Error("找不到下载入口");
  act(() => entry.click());
  await flush();
  // 浮层与打开时就在的行跟着浮层入场走完
  await stepFrames(60);
  const staying = row(first);
  expectSettled(staying);

  const scaled = reducedMotion === "never";
  const from = scaled ? "scale(0.98)" : "";
  const arriving = row(await startJava(17));
  expect(shown(arriving)).toEqual(["0", from]);
  await stepFrames(1);
  expect(shown(arriving)).toEqual(["0", from]);
  // 打开之后快览每次渲染给行的 enter 都为真：打开时就在的那一行不能因此退回起点重新入场
  expectSettled(staying);
  // 放行排在绘制之后的任务里，假时钟要再推进一帧才到点
  await stepFrames(2);
  const opacity = Number(arriving.style.opacity);
  expect(opacity).toBeGreaterThan(0);
  expect(opacity).toBeLessThan(1);
  if (scaled) {
    const scale = /^scale\((.+)\)$/.exec(arriving.style.transform);
    if (scale === null) throw new Error(`新行没有在落到位的半路上：${arriving.style.transform}`);
    expect(Number(scale[1])).toBeGreaterThan(0.98);
    expect(Number(scale[1])).toBeLessThan(1);
  } else {
    // 减少动画时只有透明度在走
    expect(arriving.style.transform).toBe("");
  }
  await stepFrames(60);
  expect(shown(arriving)).toEqual(["1", scaled ? "none" : ""]);
  expectSettled(staying);
});
