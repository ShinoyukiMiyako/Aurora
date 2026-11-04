// @vitest-environment jsdom
// @module-tag heavy-page
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stubCanvas } from "../art/illustrations/test-canvas";
import { DEFAULT_APPEARANCE, AppearanceProvider } from "../state/appearance";
import { LauncherProvider } from "../state/launcher";
import { keydown, render, stubMatchMedia, stubResizeObserver, type Rendered } from "../test/dom";
import type { IpcRecorder } from "../test/fake-bridge";
import { accountDto, bootOverrides, callsOf, configDto, instanceDto, resetRecorder, settle } from "../test/launcher";
import { ChromeProvider, type ChromeApi } from "./chrome";
import { CommandPalette } from "./CommandPalette";
import { PALETTE_COPY } from "../copy/shell";
import { OverlayRoot } from "./overlay";
import { ShellProvider, useNav, useShell, type NavApi, type ShellApi } from "./shell";

const ipc = vi.hoisted((): IpcRecorder => ({ calls: [], overrides: new Map() }));
vi.mock("../ipc/bridge", async (orig) => (await import("../test/fake-bridge")).fakeBridge(await orig(), ipc));

let view: Rendered | undefined;
let nav: NavApi;
let shell: ShellApi;
const chrome: ChromeApi = { scrollContentToTop: vi.fn(), focusContent: vi.fn() };

function Probe() {
  nav = useNav();
  shell = useShell();
  return null;
}

const flush = () =>
  act(async () => {
    await settle();
  });

async function mount() {
  view = render(
    <AppearanceProvider initial={DEFAULT_APPEARANCE}>
      <LauncherProvider>
        <ShellProvider>
          <ChromeProvider value={chrome}>
            <Probe />
            <button type="button" id="before">
              之前的焦点
            </button>
            <CommandPalette />
            <OverlayRoot />
          </ChromeProvider>
        </ShellProvider>
      </LauncherProvider>
    </AppearanceProvider>,
  );
  await flush();
}

const input = () => {
  const el = document.querySelector<HTMLInputElement>("[role='combobox']");
  if (el === null) throw new Error("命令面板没有打开");
  return el;
};

function type(value: string) {
  const el = input();
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    if (setter === undefined) throw new Error("取不到 value 的 setter");
    setter.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

const options = () => [...document.querySelectorAll<HTMLElement>("[role='option']")];
const activeLabel = () => document.querySelector("[role='option'][aria-selected='true']")?.textContent;

beforeEach(() => {
  vi.useFakeTimers();
  resetRecorder(ipc);
  stubResizeObserver();
  stubMatchMedia(false);
  stubCanvas();
  bootOverrides(ipc, {
    accounts: [accountDto(), accountDto({ uuid: "00000000-0000-0000-0000-00000000a002", name: "Alex" })],
    instances: [instanceDto("生存", { last_played_at: 100 }), instanceDto("创造", { last_played_at: 900 }), instanceDto("空岛")],
  });
  ipc.overrides.set("art_status", () => ({ source: null, panorama: false }));
  ipc.overrides.set("set_current_account", () => null);
  vi.mocked(chrome.focusContent).mockClear();
});
afterEach(() => {
  view?.unmount();
  view = undefined;
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("命令面板", () => {
  it("空查询：实例按最近游玩排在最前，没有资源组", async () => {
    await mount();
    act(() => shell.openPalette());
    await flush();
    expect(document.activeElement).toBe(input());
    const labels = options().map((o) => o.textContent);
    expect(labels.slice(0, 3).map((l) => l?.split(/1\.21\.1|当前实例/)[0])).toEqual(["创造", "生存", "空岛"]);
    expect(labels.some((l) => l?.startsWith("在发现中搜索"))).toBe(false);
  });

  it("输入查询后高亮回到第一项；↑ 从第一项循环到最后一项「在发现中搜索」", async () => {
    await mount();
    act(() => shell.openPalette());
    await flush();
    type("生存");
    expect(activeLabel()?.startsWith("生存")).toBe(true);
    keydown(input(), "ArrowUp");
    expect(activeLabel()).toBe(PALETTE_COPY.searchDiscover("生存"));
  });

  it("Enter 执行导航：面板关闭，路由切过去，焦点交给内容区", async () => {
    await mount();
    act(() => shell.openPalette("空岛"));
    await flush();
    keydown(input(), "Enter");
    await flush();
    expect(shell.palette.open).toBe(false);
    expect(nav.route).toEqual({ page: "instance", id: "空岛", tab: "overview" });
    expect(chrome.focusContent).toHaveBeenCalledTimes(1);
  });

  it("切换账户：调用切换并弹成功通知，不导航", async () => {
    await mount();
    act(() => shell.openPalette("alex"));
    await flush();
    expect(activeLabel()?.startsWith(PALETTE_COPY.switchAccount("Alex"))).toBe(true);
    keydown(input(), "Enter");
    await flush();
    expect(callsOf(ipc, "set_current_account")).toEqual([{ uuid: "00000000-0000-0000-0000-00000000a002" }]);
    expect(nav.route).toEqual({ page: "home" });
    expect(chrome.focusContent).not.toHaveBeenCalled();
  });

  it("构建里没有微软登录 client_id：「添加微软账户」写明原因，执行后去设置的常规分区，不发起登录", async () => {
    ipc.overrides.set("get_config", () => configDto({ has_client_id: false, microsoft_login_available: false }));
    await mount();
    act(() => shell.openPalette("weiruan"));
    await flush();
    expect(activeLabel()).toBe(`${PALETTE_COPY.addMicrosoft}这个版本没有内置微软登录，在设置里填入 client_id 后可用`);
    keydown(input(), "Enter");
    await flush();
    expect(nav.route).toEqual({ page: "settings", section: "general" });
    expect(callsOf(ipc, "microsoft_login")).toEqual([]);
  });

  it("Tab 不把焦点带出输入框；Esc 关闭并把焦点还给打开前的元素", async () => {
    await mount();
    const before = document.getElementById("before");
    if (before === null) throw new Error("缺少起始焦点");
    act(() => before.focus());
    act(() => shell.openPalette());
    await flush();
    const tab = keydown(input(), "Tab");
    expect(tab.defaultPrevented).toBe(true);
    keydown(input(), "Escape");
    await flush();
    expect(shell.palette.open).toBe(false);
    expect(document.activeElement).toBe(before);
  });
});
