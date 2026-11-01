// @vitest-environment jsdom
// @module-tag heavy-page
// 启动胶囊的焦点：键盘按了面上的按钮，换上的新面接住焦点，不随旧面一起丢到 body；
// 按钮在进行中变成不可用时保持可聚焦，焦点留在按钮上。
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { stubCanvas } from "../art/illustrations/test-canvas";
import { CONFIRM_COPY, LAUNCH_COPY } from "../copy/flows";
import { STOPPED_LINGER_MS } from "../domain/limits";
import { LauncherProvider, useLauncher, type LauncherApi } from "../state/launcher";
import { render, stubMatchMedia, stubResizeObserver, type Rendered } from "../test/dom";
import type { IpcRecorder } from "../test/fake-bridge";
import { emulateFocusFixup } from "../test/focus-fixup";
import { bootOverrides, callsOf, cancelledError, deferred, instanceDto, resetRecorder, settle } from "../test/launcher";
import { CONFIRM_CANCEL_LABEL } from "../ui/ConfirmDialog";
import { OverlayRoot } from "../shell/overlay";
import { ShellProvider } from "../shell/shell";
import { FACE_HOLD_MS, LaunchCapsule } from "./LaunchCapsule";

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
/** 按浏览器对原生按钮的键盘激活：Enter 的 keydown 没被 preventDefault 就派发 click（jsdom 不做这一步）。 */
const pressEnter = (el: HTMLElement) =>
  act(() => {
    if (el.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }))) el.click();
  });

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

  it("焦点在「取消启动」上按下：正在结束期间焦点留在按钮上，按钮读出不可用且不再响应", async () => {
    onTestFinished(emulateFocusFixup());
    ipc.overrides.set("cancel_task", () => new Promise(() => undefined));
    act(() => {
      void launcher.actions.launch("生存");
    });
    await flush();
    const cancel = cancelButton();
    act(() => cancel.focus());
    act(() => cancel.click());
    await flush();
    expect(callsOf(ipc, "cancel_task")).toHaveLength(1);
    expect(cancel.isConnected).toBe(true);
    expect(cancel.disabled).toBe(false);
    expect(cancel.getAttribute("aria-disabled")).toBe("true");
    expect(document.activeElement).toBe(cancel);
    pressEnter(cancel);
    await flush();
    expect(callsOf(ipc, "cancel_task")).toHaveLength(1);
  });

  it("焦点在「取消启动」上、加载面坐定换成运行面：坐定期间焦点留在胶囊里，换面后交给「结束游戏」", async () => {
    onTestFinished(emulateFocusFixup());
    const started = deferred<{ pid: number }>();
    ipc.overrides.set("launch_game", () => started.promise);
    const go = buttonByText(LAUNCH_COPY.launch);
    act(() => go.focus());
    act(() => go.click());
    await flush();
    const cancel = cancelButton();
    expect(document.activeElement).toBe(cancel);

    await act(async () => {
      started.resolve({ pid: 4242 });
      await settle();
    });
    expect(launcher.state.session?.phase).toBe("running");
    // 旧面留住演完坐定：取消启动此时不可用，但焦点不丢
    expect(cancel.isConnected).toBe(true);
    expect(cancel.getAttribute("aria-disabled")).toBe("true");
    expect(document.activeElement).toBe(cancel);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(document.activeElement).toBe(buttonByText(LAUNCH_COPY.stopGame));
  });

  it("焦点在「取消启动」上、取消成功换成没有按钮的已结束面：焦点交给胶囊本身，不随旧面丢到 body", async () => {
    const launched = deferred<{ pid: number }>();
    ipc.overrides.set("launch_game", () => launched.promise);
    act(() => {
      void launcher.actions.launch("生存");
    });
    await flush();
    const cancel = cancelButton();
    act(() => cancel.focus());
    act(() => cancel.click());
    await act(async () => {
      launched.reject(cancelledError());
      await settle();
    });
    expect(launcher.state.session?.phase).toBe("stopped");
    // 拆散的动画留住旧面一小会儿，之后换成已结束面；已结束面停留的计时还没到
    await act(async () => {
      await vi.advanceTimersByTimeAsync(FACE_HOLD_MS.disassemble + 20);
    });
    const stopped = document.querySelector<HTMLElement>('[data-face="stopped:cancelled"]');
    if (stopped === null) throw new Error("没有换成已结束面");
    expect(stopped.querySelector("button")).toBeNull();
    // 旧面此刻还在演退场，演完即被移除：焦点留在它的按钮上就会随之落回 body，所以换面这一刻就交给胶囊
    const capsule = document.querySelector<HTMLElement>(`[role="group"][aria-label="${LAUNCH_COPY.group("生存")}"]`);
    if (capsule === null) throw new Error("找不到启动胶囊");
    expect(document.activeElement).toBe(capsule);
    expect(capsule.tabIndex).toBe(-1);

    // 已结束面停留到期、回到可启动的面：焦点仍在胶囊里，交给「启动游戏」
    await act(async () => {
      await vi.advanceTimersByTimeAsync(STOPPED_LINGER_MS);
    });
    expect(launcher.state.session).toBeNull();
    expect(document.activeElement).toBe(buttonByText(LAUNCH_COPY.launch));
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

describe("就绪面的带原因禁用", () => {
  const refreshWith = async (activity: "backing_up" | null) => {
    ipc.overrides.set("list_instances", () => [instanceDto("生存", { activity })]);
    await act(async () => {
      await launcher.actions.refreshInstances();
      await settle();
    });
  };

  it("存档备份开始又结束：聚焦着的「启动」不换节点，焦点留着；备份期间读出不可用，点击不启动", async () => {
    const go = buttonByText(LAUNCH_COPY.launch);
    act(() => go.focus());

    await refreshWith("backing_up");
    expect(buttonByText(LAUNCH_COPY.launch)).toBe(go);
    expect(document.activeElement).toBe(go);
    expect(go.getAttribute("aria-disabled")).toBe("true");
    pressEnter(go);
    await flush();
    expect(callsOf(ipc, "launch_game")).toHaveLength(0);

    await refreshWith(null);
    expect(buttonByText(LAUNCH_COPY.launch)).toBe(go);
    expect(document.activeElement).toBe(go);
    expect(go.getAttribute("aria-disabled")).toBeNull();
    pressEnter(go);
    await flush();
    expect(callsOf(ipc, "launch_game")).toHaveLength(1);
  });
});

describe("运行面「结束游戏」", () => {
  async function runningCapsule() {
    ipc.overrides.set("launch_game", () => ({ pid: 4242 }));
    // 结束一直不返回：入口停在「正在结束」
    ipc.overrides.set("stop_game", () => new Promise(() => undefined));
    await act(async () => {
      await launcher.actions.launch("生存");
      await settle();
    });
    // 加载面坐定后才换成运行面
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(launcher.state.session?.phase).toBe("running");
    return buttonByText(LAUNCH_COPY.stopGame);
  }

  /** 打开着的确认框：关闭后在退场动画期间仍挂着，带 data-exiting 的不算。 */
  const openDialogs = () => [...document.querySelectorAll<HTMLElement>('[role="dialog"]')].filter((el) => el.closest("[data-exiting]") === null);

  const dialogButton = (text: string) => {
    const [dialog] = openDialogs();
    if (dialog === undefined) throw new Error("确认框没有打开");
    const el = [...dialog.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === text);
    if (el === undefined) throw new Error(`确认框里找不到按钮 ${text}`);
    return el;
  };

  it("确认结束后焦点回到按钮并留在按钮上：正在结束期间读出不可用，再按不重复弹确认", async () => {
    onTestFinished(emulateFocusFixup());
    const stop = await runningCapsule();
    act(() => stop.focus());
    act(() => stop.click());
    await flush();
    act(() => dialogButton(CONFIRM_COPY.stopGame("生存").confirmLabel).click());
    await flush();

    expect(callsOf(ipc, "stop_game")).toHaveLength(1);
    expect(stop.isConnected).toBe(true);
    expect(stop.textContent).toBe(LAUNCH_COPY.stopGame);
    expect(stop.disabled).toBe(false);
    expect(stop.getAttribute("aria-disabled")).toBe("true");
    expect(stop.getAttribute("aria-busy")).toBe("true");
    expect(document.activeElement).toBe(stop);
    expect(openDialogs()).toHaveLength(0);

    pressEnter(stop);
    act(() => stop.click());
    await flush();
    expect(openDialogs()).toHaveLength(0);
    expect(callsOf(ipc, "stop_game")).toHaveLength(1);
    expect(document.activeElement).toBe(stop);
  });

  it("确认框取消：焦点回到按钮，按钮照常可用", async () => {
    onTestFinished(emulateFocusFixup());
    const stop = await runningCapsule();
    act(() => stop.focus());
    act(() => stop.click());
    await flush();
    act(() => dialogButton(CONFIRM_CANCEL_LABEL).click());
    await flush();
    expect(callsOf(ipc, "stop_game")).toHaveLength(0);
    expect(document.activeElement).toBe(stop);
    expect(stop.getAttribute("aria-disabled")).toBeNull();
    expect(stop.getAttribute("aria-busy")).toBeNull();
  });
});
