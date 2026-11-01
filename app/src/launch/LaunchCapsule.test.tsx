// @vitest-environment jsdom
// @module-tag heavy-page
// 启动胶囊换面时的焦点：键盘按了面上的按钮，换上的新面接住焦点，不随旧面一起丢到 body。
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stubCanvas } from "../art/illustrations/test-canvas";
import { LAUNCH_COPY } from "../copy/flows";
import { LauncherProvider, useLauncher, type LauncherApi } from "../state/launcher";
import { render, stubMatchMedia, stubResizeObserver, type Rendered } from "../test/dom";
import type { IpcRecorder } from "../test/fake-bridge";
import { bootOverrides, instanceDto, resetRecorder, settle } from "../test/launcher";
import { OverlayRoot } from "../shell/overlay";
import { ShellProvider } from "../shell/shell";
import { LaunchCapsule } from "./LaunchCapsule";

const ipc = vi.hoisted((): IpcRecorder => ({ calls: [], overrides: new Map() }));
vi.mock("../ipc/bridge", async (orig) => (await import("../test/fake-bridge")).fakeBridge(await orig(), ipc));

let view: Rendered | undefined;
let launcher: LauncherApi;

function Host() {
  launcher = useLauncher();
  return (
    <>
      <button type="button">别处</button>
      {launcher.state.instances.some((i) => i.id === "生存") && <LaunchCapsule instanceId="生存" />}
    </>
  );
}

const flush = () =>
  act(async () => {
    await settle();
  });

const buttonByText = (text: string) => {
  const el = [...document.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === text);
  if (el === undefined) throw new Error(`找不到按钮 ${text}`);
  return el;
};
const cancelButton = () => {
  const el = document.querySelector<HTMLButtonElement>(`button[aria-label="${LAUNCH_COPY.cancel}"]`);
  if (el === null) throw new Error("找不到取消启动按钮");
  return el;
};

beforeEach(async () => {
  vi.useFakeTimers();
  resetRecorder(ipc);
  stubResizeObserver();
  stubMatchMedia(false);
  stubCanvas();
  bootOverrides(ipc, { instances: [instanceDto("生存")], pins: [] });
  // 启动一直不返回：会话停在加载阶段，胶囊停在加载面
  ipc.overrides.set("launch_game", () => new Promise(() => undefined));
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
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("启动胶囊换面时的焦点", () => {
  it("焦点在「启动」上按下：换成加载面后焦点落到「取消启动」", async () => {
    const go = buttonByText(LAUNCH_COPY.launch);
    act(() => go.focus());
    act(() => go.click());
    await flush();
    expect(launcher.state.session?.instanceId).toBe("生存");
    expect(document.activeElement).toBe(cancelButton());
  });

  it("焦点不在胶囊里时换面不抢焦点", async () => {
    const elsewhere = buttonByText("别处");
    act(() => elsewhere.focus());
    act(() => {
      void launcher.actions.launch("生存");
    });
    await flush();
    expect(cancelButton().isConnected).toBe(true);
    expect(document.activeElement).toBe(elsewhere);
  });
});
