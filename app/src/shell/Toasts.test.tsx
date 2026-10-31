// @vitest-environment jsdom
// 通知容器的暂停计时：指针或焦点在栈内时全部暂停，两者都离开才恢复。
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LauncherProvider, useLauncher, type LauncherApi } from "../state/launcher";
import { render, stubResizeObserver, type Rendered } from "../test/dom";
import type { IpcRecorder } from "../test/fake-bridge";
import { bootOverrides, resetRecorder } from "../test/launcher";
import { TOAST_CLOSE_LABEL } from "../ui/Toast";
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

// 真定时器：通知的退场动画要真的播完、节点真的移除
const flush = () =>
  act(async () => {
    for (let i = 0; i < 10; i++) await new Promise((resolve) => setTimeout(resolve, 0));
  });

const closeButtons = () => [...document.querySelectorAll<HTMLButtonElement>(`button[aria-label="${TOAST_CLOSE_LABEL}"]`)];
const running = () => launcher.state.toasts.map((t) => ({ title: t.title, running: t.deadline !== null && t.pausedRemainingMs === null }));

beforeEach(async () => {
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
  await flush();
});

afterEach(() => {
  view?.unmount();
  view = undefined;
});

describe("通知容器的焦点暂停", () => {
  it("焦点所在的通知被关掉、节点移除后焦点落回 body：其余通知恢复计时，不一直停着", async () => {
    act(() => {
      launcher.actions.toast("info", "甲");
      launcher.actions.toast("success", "乙");
    });
    expect(running()).toEqual([
      { title: "甲", running: true },
      { title: "乙", running: true },
    ]);

    const [first] = closeButtons();
    act(() => first.focus());
    expect(running()).toEqual([
      { title: "甲", running: false },
      { title: "乙", running: false },
    ]);

    // 点关闭：浏览器在聚焦元素被移除时不派发 blur / focusout，容器收不到「焦点离开」
    act(() => first.click());
    await vi.waitFor(() => expect(closeButtons()).toHaveLength(1), { timeout: 3000, interval: 20 });
    expect(document.activeElement).toBe(document.body);
    expect(running()).toEqual([{ title: "乙", running: true }]);
  });

  it("焦点仍在栈内另一条通知上时，关掉一条不恢复计时", async () => {
    act(() => {
      launcher.actions.toast("info", "甲");
      launcher.actions.toast("success", "乙");
    });
    const [first, second] = closeButtons();
    act(() => first.focus());
    act(() => second.focus());
    act(() => first.click());
    await vi.waitFor(() => expect(closeButtons()).toHaveLength(1), { timeout: 3000, interval: 20 });
    expect(document.activeElement).toBe(second);
    expect(running()).toEqual([{ title: "乙", running: false }]);
  });
});
