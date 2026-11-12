// @vitest-environment jsdom
// @module-tag heavy-page
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stubCanvas } from "../art/illustrations/test-canvas";
import { ACTION_ERROR, INSTANCE_TAB_LABEL, NEXT_LAUNCH_SUFFIX, PAGE_LABEL, TOAST_COPY, accountKindLabel } from "../copy/flows";
import { LauncherProvider, useLauncher, type LauncherApi } from "../state/launcher";
import { render, stubMatchMedia, stubResizeObserver, type Rendered } from "../test/dom";
import type { IpcRecorder } from "../test/fake-bridge";
import { accountDto, bootOverrides, callsOf, deferred, instanceDto, resetRecorder, settle } from "../test/launcher";
import { ACCOUNT_COPY, PEEK_COPY, TITLEBAR_COPY } from "../copy/shell";
import { OverlayRoot } from "./overlay";
import { ShellProvider, useNav, type NavApi } from "./shell";
import { TitleBar } from "./TitleBar";
import styles from "./TitleBar.module.css";
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

describe("页面标题", () => {
  const spanWithText = (text: string) => {
    const el = [...document.querySelectorAll<HTMLElement>("header span")].find((s) => s.textContent === text);
    if (el === undefined) throw new Error(`标题栏里没有「${text}」`);
    return el;
  };

  it("挂载时就在的标题不单独淡入；换页后新标题从透明淡入", async () => {
    await mount();
    expect(spanWithText(PAGE_LABEL.home).style.opacity).toBe("1");
    act(() => nav.go({ page: "library" }));
    expect(spanWithText(PAGE_LABEL.library).style.opacity).toBe("0");
  });

  it("实例页换分页：面包屑不重挂，只有新出现的分页名淡入", async () => {
    await mount();
    act(() => nav.go({ page: "instance", id: "生存", tab: "overview" }));
    const crumbName = spanWithText("生存");
    act(() => nav.go({ page: "instance", id: "生存", tab: "mods" }));
    expect(spanWithText("生存")).toBe(crumbName);
    expect(spanWithText(INSTANCE_TAB_LABEL.mods).style.opacity).toBe("0");
    act(() => nav.go({ page: "instance", id: "生存", tab: "logs" }));
    expect(spanWithText(INSTANCE_TAB_LABEL.logs).style.opacity).toBe("0");
    expect(spanWithText("生存")).toBe(crumbName);
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

  it("切换账户、胶囊伸缩：左边的搜索与下载入口与它同组取快照，换之前量到旧位置、换之后量到新位置", async () => {
    await mount();
    const steve = ACCOUNT_COPY.current("Steve", accountKindLabel("offline", null));
    const alex = ACCOUNT_COPY.current("Alex", accountKindLabel("microsoft", null));
    const capsule = byLabel(steve);
    const capsuleLabel = () => {
      const label = capsule.getAttribute("aria-label");
      if (label === null) throw new Error("账户胶囊没有名称");
      return label;
    };
    // jsdom 不做布局：入口的矩形随胶囊写的是哪个账户而定，并记下每次被量时胶囊上的账户。
    // 入口自己没有重渲染、布局依赖也没变，被量到只能是因为与胶囊同在一个布局组里
    const track = (el: HTMLElement) => {
      const seen: string[] = [];
      el.getBoundingClientRect = () => {
        const label = capsuleLabel();
        seen.push(label);
        const left = label === steve ? 600 : 560;
        return { left, top: 11, width: 34, height: 34, x: left, y: 11, right: left + 34, bottom: 45, toJSON: () => null } as DOMRect;
      };
      return seen;
    };
    const search = track(byLabel(TITLEBAR_COPY.searchLabel));
    const download = track(byLabel(PEEK_COPY.button(0, 0)));
    act(() => capsule.click());
    await flush();
    ipc.overrides.set("current_account", () => ALEX);
    act(() => [...document.querySelectorAll<HTMLElement>("[role='menuitemradio']")][1].click());
    await flush();
    expect(capsuleLabel()).toBe(alex);
    for (const seen of [search, download]) {
      expect(seen[0]).toBe(steve);
      expect(seen.at(-1)).toBe(alex);
    }
  });

  it("窄窗口里右列超过 1fr 时胶囊伸缩会推动中列：状态岛也与胶囊同组取快照，换之前量到旧位置、换之后量到新位置", async () => {
    ipc.overrides.set("launch_game", () => deferred<never>().promise);
    await mount();
    act(() => void launcher.actions.launch("生存"));
    await flush();
    const island = document.querySelector<HTMLElement>(`.${styles.center} button`);
    if (island === null) throw new Error("标题栏中列没有状态岛");
    const steve = ACCOUNT_COPY.current("Steve", accountKindLabel("offline", null));
    const alex = ACCOUNT_COPY.current("Alex", accountKindLabel("microsoft", null));
    const capsule = byLabel(steve);
    // 状态岛自己的布局依赖（档位、名字、阶段文字、数字位数）在换账户时都没变，被量到只能是因为与胶囊同在一个布局组里。
    // 右列按内容定宽时中列的位置随右列宽度变：胶囊写 Alex 时更宽，状态岛整体左移
    const seen: string[] = [];
    island.getBoundingClientRect = () => {
      const label = capsule.getAttribute("aria-label");
      if (label === null) throw new Error("账户胶囊没有名称");
      seen.push(label);
      const left = label === steve ? 420 : 380;
      return { left, top: 11, width: 160, height: 34, x: left, y: 11, right: left + 160, bottom: 45, toJSON: () => null } as DOMRect;
    };
    act(() => capsule.click());
    await flush();
    ipc.overrides.set("current_account", () => ALEX);
    act(() => [...document.querySelectorAll<HTMLElement>("[role='menuitemradio']")][1].click());
    await flush();
    expect(capsule.getAttribute("aria-label")).toBe(alex);
    expect(seen[0]).toBe(steve);
    expect(seen.at(-1)).toBe(alex);
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
