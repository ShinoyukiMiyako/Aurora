// @vitest-environment jsdom
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stubCanvas } from "../art/illustrations/test-canvas";
import { ACTION_ERROR, NEXT_LAUNCH_SUFFIX, PAGE_LABEL, TOAST_COPY, accountKindLabel } from "../copy/flows";
import { LauncherProvider, useLauncher, type LauncherApi } from "../state/launcher";
import { render, stubMatchMedia, stubResizeObserver, type Rendered } from "../test/dom";
import type { IpcRecorder } from "../test/fake-bridge";
import { accountDto, bootOverrides, callsOf, deferred, instanceDto, resetRecorder, settle } from "../test/launcher";
import { ACCOUNT_COPY, PEEK_COPY, TITLEBAR_COPY } from "./copy";
import { OverlayRoot } from "./overlay";
import { ShellProvider, useNav, type NavApi } from "./shell";
import { TitleBar } from "./TitleBar";
import { WindowPortProvider, browserWindowPort, type WindowPort } from "./window";

const ipc = vi.hoisted((): IpcRecorder => ({ calls: [], overrides: new Map() }));
vi.mock("../ipc/bridge", async (orig) => (await import("../test/fake-bridge")).fakeBridge(await orig(), ipc));

const ALEX = accountDto({ uuid: "00000000-0000-0000-0000-00000000a002", name: "Alex", account_type: "microsoft" });

let view: Rendered | undefined;
let nav: NavApi;
let launcher: LauncherApi;
let port: WindowPort;
let maximized: boolean;

function Probe() {
  nav = useNav();
  launcher = useLauncher();
  return null;
}

const flush = () =>
  act(async () => {
    await settle();
  });

async function mount() {
  view = render(
    <WindowPortProvider port={port}>
      <LauncherProvider>
        <ShellProvider>
          <Probe />
          <TitleBar />
          <OverlayRoot />
        </ShellProvider>
      </LauncherProvider>
    </WindowPortProvider>,
  );
  await flush();
}

const byLabel = (label: string) => {
  const el = document.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
  if (el === null) throw new Error(`找不到名为「${label}」的按钮`);
  return el;
};

beforeEach(() => {
  vi.useFakeTimers();
  resetRecorder(ipc);
  stubResizeObserver();
  stubMatchMedia(false);
  stubCanvas();
  bootOverrides(ipc, { accounts: [accountDto(), ALEX], instances: [instanceDto("生存")] });
  ipc.overrides.set("art_status", () => ({ source: null, panorama: false }));
  ipc.overrides.set("set_current_account", () => null);
  ipc.overrides.set("skin_info", () => null);
  maximized = true;
  port = { ...browserWindowPort(), isMaximized: async () => maximized, minimize: vi.fn(async () => {}), close: vi.fn(async () => {}) };
});
afterEach(() => {
  view?.unmount();
  view = undefined;
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("窗口三键", () => {
  it("最大化时中间键叫「还原」；最小化与关闭经窗口端口执行", async () => {
    await mount();
    expect(byLabel(TITLEBAR_COPY.restore)).toBeTruthy();
    expect(document.querySelector(`button[aria-label="${TITLEBAR_COPY.maximize}"]`)).toBeNull();
    act(() => byLabel(TITLEBAR_COPY.minimize).click());
    act(() => byLabel(TITLEBAR_COPY.close).click());
    await flush();
    expect(port.minimize).toHaveBeenCalledTimes(1);
    expect(port.close).toHaveBeenCalledTimes(1);
  });
});

describe("后退与前进", () => {
  it("没有历史时禁用；去过别的页面后可以后退", async () => {
    await mount();
    expect(byLabel(TITLEBAR_COPY.back).disabled).toBe(true);
    act(() => nav.go({ page: "library" }));
    expect(byLabel(TITLEBAR_COPY.back).disabled).toBe(false);
    act(() => byLabel(TITLEBAR_COPY.back).click());
    expect(nav.route).toEqual({ page: "home" });
    expect(byLabel(TITLEBAR_COPY.forward).disabled).toBe(false);
  });
});

describe("账户胶囊", () => {
  it("名称写当前账户与类型；切换到另一个账户后通知写它的类型", async () => {
    await mount();
    const capsule = byLabel(ACCOUNT_COPY.current("Steve", accountKindLabel("offline", null)));
    act(() => capsule.click());
    await flush();
    const rows = [...document.querySelectorAll<HTMLElement>("[role='menuitemradio']")];
    expect(rows.map((r) => r.getAttribute("aria-checked"))).toEqual(["true", "false"]);
    expect(document.activeElement).toBe(rows[0]);
    act(() => rows[1].click());
    await flush();
    expect(callsOf(ipc, "set_current_account")).toEqual([{ uuid: ALEX.uuid }]);
    const toast = launcher.state.toasts.find((t) => t.title === TOAST_COPY.accountSwitched("Alex"));
    expect(toast?.body).toBe(accountKindLabel("microsoft", null));
  });

  it("游戏占着进程时换账户：通知说明下次启动生效", async () => {
    ipc.overrides.set("launch_game", () => deferred<never>().promise);
    await mount();
    act(() => void launcher.actions.launch("生存"));
    await flush();
    act(() => byLabel(ACCOUNT_COPY.current("Steve", accountKindLabel("offline", null))).click());
    await flush();
    act(() => [...document.querySelectorAll<HTMLElement>("[role='menuitemradio']")][1].click());
    await flush();
    const toast = launcher.state.toasts.find((t) => t.title === TOAST_COPY.accountSwitched("Alex"));
    expect(toast?.body).toBe(`${accountKindLabel("microsoft", null)}${NEXT_LAUNCH_SUFFIX}`);
  });

  it("切换失败经统一错误处理报错，不发成功通知", async () => {
    ipc.overrides.set("set_current_account", () => {
      throw new Error("凭据读不出来");
    });
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    await mount();
    act(() => byLabel(ACCOUNT_COPY.current("Steve", accountKindLabel("offline", null))).click());
    await flush();
    act(() => [...document.querySelectorAll<HTMLElement>("[role='menuitemradio']")][1].click());
    await flush();
    expect(launcher.state.toasts.map((t) => [t.tone, t.title])).toEqual([["error", ACTION_ERROR.selectAccount]]);
  });

  it("没有账户时是「添加账户」，直接去账户页", async () => {
    bootOverrides(ipc, { accounts: [], instances: [] });
    ipc.overrides.set("art_status", () => ({ source: null, panorama: false }));
    await mount();
    act(() => byLabel(ACCOUNT_COPY.addLabel).click());
    expect(nav.route).toEqual({ page: "accounts" });
  });
});

describe("下载入口", () => {
  it("空闲时名称就是「下载任务」；点开后能去全部任务", async () => {
    await mount();
    act(() => byLabel(PEEK_COPY.button(0, 0)).click());
    await flush();
    const all = [...document.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === PEEK_COPY.allTasks);
    if (all === undefined) throw new Error("快览里没有「全部任务」");
    act(() => all.click());
    expect(nav.route).toEqual({ page: "tasks" });
    expect(document.querySelector("header")?.textContent).toContain(PAGE_LABEL.tasks);
  });
});
