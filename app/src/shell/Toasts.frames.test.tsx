// @vitest-environment jsdom
// @module-tag heavy-page
//
// 要逐帧看动画的通知容器用例。图标底座那一下的峰值只有几十毫秒宽：真实计时器下机器一忙，帧来得晚就会整段错过。
// 整个文件走假时钟，帧跟着它一帧一帧走（test/dom 的 stepFrames），采样可复现。
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LauncherProvider, useLauncher, type LauncherApi } from "../state/launcher";
import { drainFrames, render, stepFrames, stubResizeObserver, type Rendered } from "../test/dom";
import type { IpcRecorder } from "../test/fake-bridge";
import { bootOverrides, resetRecorder, settle } from "../test/launcher";
import toastStyles from "../ui/Toast.module.css";
import { OverlayRoot } from "./overlay";
import { ShellProvider } from "./shell";
import { Toasts } from "./Toasts";

const ipc = vi.hoisted((): IpcRecorder => ({ calls: [], overrides: new Map() }));
vi.mock("../ipc/bridge", async (orig) => (await import("../test/fake-bridge")).fakeBridge(await orig(), ipc));

let view: Rendered | undefined;
let launcher: LauncherApi;

function Host() {
  launcher = useLauncher();
  return <Toasts />;
}

const scaleOf = (el: HTMLElement) => {
  const match = /scale\((-?[\d.]+)\)/.exec(el.style.transform);
  return match === null ? 1 : Number(match[1]);
};

/** 逐帧走 count 帧，返回每一帧之后的缩放。 */
async function scalesOver(el: HTMLElement, count: number): Promise<number[]> {
  const seen: number[] = [];
  for (let i = 0; i < count; i++) {
    await stepFrames(1);
    seen.push(scaleOf(el));
  }
  return seen;
}

beforeEach(async () => {
  vi.useFakeTimers();
  stubResizeObserver();
  resetRecorder(ipc);
  bootOverrides(ipc);
  view = render(
    <LauncherProvider>
      <ShellProvider>
        <Host />
        <OverlayRoot />
      </ShellProvider>
    </LauncherProvider>,
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
});

describe("重复的通知", () => {
  it("同一条又来一次：不新增，并进去的那一条图标底座原位弹一下，再落回 1", async () => {
    const copied = () => [...document.querySelectorAll<HTMLElement>("[data-tone]")].filter((t) => t.textContent?.includes("已复制"));
    act(() => launcher.actions.toast("success", "已复制"));
    const icon = copied()[0].querySelector<HTMLElement>(`.${toastStyles.iconBase}`);
    if (icon === null) throw new Error("没有图标底座");
    // 通知自己的入场不牵动图标底座
    expect(Math.max(...(await scalesOver(icon, 30)))).toBe(1);

    act(() => launcher.actions.toast("success", "已复制"));
    expect(launcher.state.toasts.map((t) => [t.title, t.repeats])).toEqual([["已复制", 1]]);
    expect(copied()).toHaveLength(1);
    const seen = await scalesOver(icon, 30);
    expect(Math.max(...seen)).toBeGreaterThan(1.08);
    expect(Math.max(...seen)).toBeLessThan(1.14);
    expect(seen.at(-1)).toBe(1);
  });
});
