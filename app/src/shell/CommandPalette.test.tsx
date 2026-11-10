// @vitest-environment jsdom
// @module-tag heavy-page
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stubCanvas } from "../art/illustrations/test-canvas";
import { DEFAULT_APPEARANCE, AppearanceProvider } from "../state/appearance";
import { LauncherProvider, useLauncher, type LauncherApi } from "../state/launcher";
import { activeAccount } from "../state/selectors";
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
let launcher: LauncherApi;
const chrome: ChromeApi = { scrollContentToTop: vi.fn(), focusContent: vi.fn() };

function Probe() {
  nav = useNav();
  shell = useShell();
  launcher = useLauncher();
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
  vi.mocked(chrome.scrollContentToTop).mockClear();
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

describe("命令面板的开合与后台变化", () => {
  /** 面板层：关闭后退场动画播完前仍挂着，带 data-exiting。假定时器下动画帧不走，退场一直停在半路。 */
  const panels = () => [...document.querySelectorAll<HTMLElement>("[role='dialog']")].map((panel) => ({ panel, exiting: panel.closest("[data-exiting]") !== null }));
  const livePanel = () => {
    const live = panels().filter((p) => !p.exiting);
    if (live.length !== 1) throw new Error(`应当恰好有一个在场的面板，实为 ${live.length} 个`);
    return live[0].panel;
  };
  const optionLabels = (panel: HTMLElement) => [...panel.querySelectorAll<HTMLElement>("[role='option']")].map((o) => o.textContent);
  const liveInput = () => {
    const el = livePanel().querySelector<HTMLInputElement>("[role='combobox']");
    if (el === null) throw new Error("在场的面板里没有输入框");
    return el;
  };

  it("退场途中重新打开：新面板从这次的查询与第一项开始，旧面板照常退场", async () => {
    await mount();
    act(() => shell.openPalette());
    await flush();
    type("生存");
    keydown(input(), "ArrowDown");
    act(() => shell.closePalette());
    act(() => shell.openPalette("空岛"));
    await flush();

    expect(panels().map((p) => p.exiting)).toEqual([true, false]);
    expect(liveInput().value).toBe("空岛");
    expect(livePanel().querySelector("[role='option'][aria-selected='true']")?.textContent?.startsWith("空岛")).toBe(true);
  });

  it("执行后淡出的那一段，条目不跟着状态变：切换账户后退场中的面板仍是执行时的样子", async () => {
    const alex = accountDto({ uuid: "00000000-0000-0000-0000-00000000a002", name: "Alex" });
    ipc.overrides.set("set_current_account", () => {
      ipc.overrides.set("current_account", () => alex);
      return null;
    });
    await mount();
    act(() => shell.openPalette("alex"));
    await flush();
    const before = optionLabels(livePanel());
    expect(before[0]?.startsWith(PALETTE_COPY.switchAccount("Alex"))).toBe(true);

    keydown(input(), "Enter");
    await flush();
    // 状态确实已经换到 Alex：没冻结的话「切换到 Alex」这一条此刻已不在列表里
    expect(activeAccount(launcher.state)?.name).toBe("Alex");
    const [leaving] = panels();
    expect(leaving.exiting).toBe(true);
    expect(optionLabels(leaving.panel)).toEqual(before);
  });

  it("面板开着时后台插进新实例：高亮留在原来那一条上，不按下标落到别的条目", async () => {
    await mount();
    act(() => shell.openPalette());
    await flush();
    keydown(input(), "ArrowDown");
    expect(activeLabel()?.startsWith("生存")).toBe(true);

    ipc.overrides.set("list_instances", () => [instanceDto("生存", { last_played_at: 100 }), instanceDto("创造", { last_played_at: 900 }), instanceDto("空岛"), instanceDto("新装的", { last_played_at: 1000 })]);
    await act(async () => {
      await launcher.actions.reload("instances");
    });
    await flush();
    expect(options()[0].textContent?.startsWith("新装的")).toBe(true);
    expect(activeLabel()?.startsWith("生存")).toBe(true);

    // 高亮的那一条没了：按原来的下标落位
    ipc.overrides.set("list_instances", () => [instanceDto("创造", { last_played_at: 900 }), instanceDto("空岛"), instanceDto("新装的", { last_played_at: 1000 })]);
    await act(async () => {
      await launcher.actions.reload("instances");
    });
    await flush();
    expect(activeLabel()?.startsWith("空岛")).toBe(true);
  });

  it("跳到当前所在的页：不导航，把内容区滚回顶部", async () => {
    await mount();
    expect(nav.route).toEqual({ page: "home" });
    act(() => shell.openPalette("主页"));
    await flush();
    expect(activeLabel()).toBe("主页");
    keydown(input(), "Enter");
    await flush();
    expect(nav.route).toEqual({ page: "home" });
    expect(nav.canBack).toBe(false);
    expect(chrome.scrollContentToTop).toHaveBeenCalledTimes(1);

    // 别的页照常导航，不滚动（上一个面板可能还在退场，按键发给在场的那个）
    act(() => shell.openPalette("实例库"));
    await flush();
    keydown(liveInput(), "Enter");
    await flush();
    expect(nav.route).toEqual({ page: "library" });
    expect(chrome.scrollContentToTop).toHaveBeenCalledTimes(1);
  });
});
