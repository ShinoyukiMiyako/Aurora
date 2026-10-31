// @vitest-environment jsdom
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { stubCanvas } from "../art/illustrations/test-canvas";
import { INSTANCE_TAB_LABEL, PAGE_LABEL } from "../copy/flows";
import { DEFAULT_APPEARANCE, AppearanceProvider } from "../state/appearance";
import type { FlowProps } from "../state/flows";
import { LauncherProvider, useLauncher, type LauncherApi } from "../state/launcher";
import { PAGE_IDS, type PageId, type Route } from "../state/route";
import { render, stubMatchMedia, stubResizeObserver, type Rendered } from "../test/dom";
import type { IpcRecorder } from "../test/fake-bridge";
import { bootOverrides, instanceDto, resetRecorder, settle } from "../test/launcher";
import { AppShell, PAGE_PRELOAD_DELAY_MS, type AppShellProps, type ShellFlows } from "./AppShell";
import { DROP_COPY, PAGE_ERROR_COPY, SHELL_ACTION_ERROR, SHELL_DEFECT_COPY } from "../copy/shell";
import { ErrorBoundary } from "./ErrorBoundary";
import type { PageTable } from "./nav";
import { createPageRegistry, type PageRegistry } from "./pages";
import { ShellProvider, useNav, useShell, type NavApi, type ShellApi } from "./shell";
import type { StartupNotice } from "./startup-notices";
import { WindowPortProvider, browserWindowPort, type FileDropEvent, type WindowPort } from "./window";

const ipc = vi.hoisted((): IpcRecorder => ({ calls: [], overrides: new Map() }));
vi.mock("../ipc/bridge", async (orig) => (await import("../test/fake-bridge")).fakeBridge(await orig(), ipc));

/** 每个页面渲染一个带页面名的标记；在 broken 里的页面每次渲染都抛错（React 会同步重试一次，只抛一次接不住）。 */
function pageTable(loads: PageId[], broken: Set<PageId>): PageTable {
  const entries = PAGE_IDS.map((page) => {
    function Page({ route }: { route: Route }) {
      if (broken.has(page)) {
        throw new Error(`${page} 页渲染出错`);
      }
      return <p data-page={page}>{`${page}:${JSON.stringify(route)}`}</p>;
    }
    return [page, async () => {
      loads.push(page);
      return { default: Page };
    }] as const;
  });
  return Object.fromEntries(entries) as unknown as PageTable;
}

let view: Rendered | undefined;
let nav: NavApi;
let shell: ShellApi;
let launcher: LauncherApi;
let port: WindowPort & { show: ReturnType<typeof vi.fn> };
let loads: PageId[];
let broken: Set<PageId>;
let registry: PageRegistry;
let warn: MockInstance<typeof console.warn>;

function Probe() {
  nav = useNav();
  shell = useShell();
  launcher = useLauncher();
  return null;
}

function LoginStub({ login }: FlowProps<"login">) {
  return <p data-flow="login">{login.kind}</p>;
}

function OnboardingStub() {
  return <p data-flow="onboarding">向导</p>;
}

const flush = () =>
  act(async () => {
    await settle();
  });

let crashed: unknown;

async function mount(flows: Partial<ShellFlows> = {}, startupNotices?: AppShellProps["startupNotices"]) {
  crashed = undefined;
  view = render(
    <WindowPortProvider port={port}>
      <AppearanceProvider initial={{ ...DEFAULT_APPEARANCE, petals: false }}>
        <LauncherProvider>
          <ShellProvider>
            <Probe />
            <ErrorBoundary
              onError={() => undefined}
              fallback={(error) => {
                crashed = error;
                return <p data-crashed="" />;
              }}
            >
              <AppShell pages={registry} flows={{ login: LoginStub, onboarding: null, createInstance: null, ...flows }} startupNotices={startupNotices} />
            </ErrorBoundary>
          </ShellProvider>
        </LauncherProvider>
      </AppearanceProvider>
    </WindowPortProvider>,
  );
  await flush();
}

const pageShown = () => document.querySelector("[data-page]")?.getAttribute("data-page");

beforeEach(async () => {
  vi.useFakeTimers();
  resetRecorder(ipc);
  stubResizeObserver();
  stubMatchMedia(false);
  stubCanvas();
  HTMLElement.prototype.scrollTo = function scrollTo(this: HTMLElement) {
    this.scrollTop = 0;
  };
  bootOverrides(ipc, { instances: [instanceDto("生存")] });
  ipc.overrides.set("art_status", () => ({ source: null, panorama: false }));
  ipc.overrides.set("updater_info", () => ({ current_version: "0.1.0", supported: false, unsupported_reason: null, available: null, downloaded_version: null, install_on_exit: false }));
  const base = browserWindowPort();
  port = { ...base, show: vi.fn(async () => {}) };
  loads = [];
  broken = new Set();
  registry = createPageRegistry(pageTable(loads, broken));
  await registry.load("home");
  warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
});
afterEach(() => {
  view?.unmount();
  view = undefined;
  warn.mockRestore();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("外壳布局", () => {
  it("首帧就渲染已预载的主页；知道是否首次启动之后的下一帧才显示窗口", async () => {
    await mount();
    expect(pageShown()).toBe("home");
    expect(document.querySelector("nav")).not.toBeNull();
    expect(port.show).not.toHaveBeenCalled();
    act(() => void vi.advanceTimersByTime(20));
    expect(port.show).toHaveBeenCalledTimes(1);
  });

  it("挂载后延时预载其余页面", async () => {
    await mount();
    expect(loads).toEqual(["home"]);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(PAGE_PRELOAD_DELAY_MS);
    });
    expect([...loads].sort()).toEqual([...PAGE_IDS].sort());
  });

  it("没加载过的页面挂起后照常出现，标题栏写页面名", async () => {
    await mount();
    act(() => nav.go({ page: "library" }));
    await flush();
    expect(pageShown()).toBe("library");
    expect(document.querySelector("header")?.textContent).toContain(PAGE_LABEL.library);
  });

  it("实例页的标题是面包屑：点「实例库」回到实例库", async () => {
    await mount();
    act(() => nav.go({ page: "instance", id: "生存", tab: "mods" }));
    await flush();
    const header = document.querySelector("header");
    expect(header?.textContent).toContain(`${PAGE_LABEL.library}/生存/${INSTANCE_TAB_LABEL.mods}`);
    const crumb = [...(header?.querySelectorAll("button") ?? [])].find((b) => b.textContent === PAGE_LABEL.library);
    if (crumb === undefined) throw new Error("面包屑里没有实例库");
    act(() => crumb.click());
    await flush();
    expect(nav.route).toEqual({ page: "library" });
  });

  it("页面渲染出错只换掉内容区：侧栏照常可用，「重新加载」让页面从头挂载", async () => {
    broken.add("tasks");
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await mount();
    act(() => nav.go({ page: "tasks" }));
    await flush();
    expect(pageShown()).toBeUndefined();
    expect(document.querySelector("[role='alert'] h2")?.textContent).toBe(PAGE_ERROR_COPY.title);
    expect(document.querySelector("[data-sidebar-item='home']")).not.toBeNull();
    const reload = [...document.querySelectorAll("button")].find((b) => b.textContent === PAGE_ERROR_COPY.reload);
    if (reload === undefined) throw new Error("错误页没有重新加载");
    broken.delete("tasks");
    act(() => reload.click());
    await flush();
    expect(pageShown()).toBe("tasks");
    error.mockRestore();
  });

  it("换页之后错误边界随页面重建：别的页面不受上一页错误影响", async () => {
    broken.add("discover");
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await mount();
    act(() => nav.go({ page: "discover" }));
    await flush();
    expect(pageShown()).toBeUndefined();
    act(() => nav.go({ page: "settings" }));
    await flush();
    expect(pageShown()).toBe("settings");
    error.mockRestore();
  });

  it("首次启动：整窗换成向导，没有侧栏", async () => {
    bootOverrides(ipc, { instances: [], firstRun: true });
    ipc.overrides.set("art_status", () => ({ source: null, panorama: false }));
    await mount({ onboarding: OnboardingStub });
    expect(document.querySelector("[data-flow='onboarding']")?.textContent).toBe("向导");
    expect(document.querySelector("[data-sidebar-item]")).toBeNull();
  });

  it("首次启动却没有向导模块：构建不完整，外壳抛错交给最外层整屏报错，不进主界面", async () => {
    bootOverrides(ipc, { instances: [], firstRun: true });
    ipc.overrides.set("art_status", () => ({ source: null, panorama: false }));
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await mount();
    expect(crashed).toBeInstanceOf(Error);
    expect((crashed as Error).message).toBe(SHELL_DEFECT_COPY.missingOnboarding);
    expect(pageShown()).toBeUndefined();
    expect(document.querySelector("[data-crashed]")).not.toBeNull();
    error.mockRestore();
  });

  it("不是首次启动时没有向导模块也照常进主界面", async () => {
    await mount();
    expect(crashed).toBeUndefined();
    expect(pageShown()).toBe("home");
  });

  it("应用启动时的那一屏不播入场：侧栏与主列一挂上就不透明，窗口显示时就是成品", async () => {
    await mount();
    const slot = document.querySelector<HTMLElement>('[data-tauri-drag-region=""]');
    expect(slot?.style.opacity).toBe("1");
  });

  it("向导收尾后主界面淡入：侧栏与主列从透明开始", async () => {
    bootOverrides(ipc, { instances: [], firstRun: true });
    ipc.overrides.set("art_status", () => ({ source: null, panorama: false }));
    ipc.overrides.set("complete_first_run", () => null);
    await mount({ onboarding: OnboardingStub });
    expect(document.querySelector("[data-flow='onboarding']")).not.toBeNull();
    await act(async () => {
      await launcher.actions.completeFirstRun("D:\\Games\\.minecraft", []);
    });
    await flush();
    expect(document.querySelector("[data-flow='onboarding']")).toBeNull();
    const slot = document.querySelector<HTMLElement>('[data-tauri-drag-region=""]');
    expect(slot).not.toBeNull();
    expect(slot?.style.opacity).toBe("0");
  });

  it("文件拖过窗口时整窗显示放置提示", async () => {
    let fire: ((event: FileDropEvent) => void) | null = null;
    port = {
      ...port,
      onFileDrop: async (handler) => {
        fire = handler;
        return () => undefined;
      },
    };
    await mount();
    if (fire === null) throw new Error("外壳没有订阅文件拖放");
    const send: (event: FileDropEvent) => void = fire;
    act(() => send({ type: "enter", paths: ["D:\\pack.mrpack"] }));
    expect(document.querySelector('[role="status"][data-hint="modpack"]')?.textContent).toBe(DROP_COPY.modpackHint);
  });

  it("启动提示：启动后读一次，逐条以 warning 通知显示；重渲染不再读", async () => {
    const run = vi.fn();
    const load = vi.fn(async (): Promise<StartupNotice[]> => [
      { title: "配置文件读不出来，已按默认设置启动", body: "原文件已改名", action: { label: "打开目录", run, errorTitle: "没能打开" } },
      { title: "第二条" },
    ]);
    await mount({}, load);
    expect(load).toHaveBeenCalledTimes(1);
    // 测试替身的账户没有皮肤，外壳另会报一条皮肤读取失败；这里只看启动提示
    expect(launcher.state.toasts.filter((t) => t.tone === "warning").map((t) => [t.title, t.body, t.action?.label])).toEqual([
      ["配置文件读不出来，已按默认设置启动", "原文件已改名", "打开目录"],
      ["第二条", undefined, undefined],
    ]);
    act(() => nav.go({ page: "library" }));
    await flush();
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("启动提示读取失败：经外层统一错误处理报告", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await mount({}, async () => Promise.reject(new Error("命令不存在")));
    expect(launcher.state.toasts.filter((t) => t.title === SHELL_ACTION_ERROR.startupNotices).map((t) => [t.tone, t.body])).toEqual([["error", "命令不存在"]]);
    expect(launcher.state.toasts.filter((t) => t.tone === "warning")).toEqual([]);
    error.mockRestore();
  });

  it("没有注入启动提示的读取函数：什么都不读", async () => {
    await mount();
    expect(launcher.state.toasts.filter((t) => t.tone === "warning" || t.title === SHELL_ACTION_ERROR.startupNotices)).toEqual([]);
  });

  it("没有新建实例模块时，打开请求立即收回", async () => {
    await mount();
    act(() => shell.openCreateInstance());
    await flush();
    expect(shell.createInstance.open).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

describe("页面组件表", () => {
  it("加载前取不到组件，加载后同步可用", async () => {
    const reg = createPageRegistry(pageTable([], new Set()));
    expect(reg.resolved("accounts")).toBeNull();
    await reg.load("accounts");
    expect(reg.resolved("accounts")).not.toBeNull();
  });

  it("同一页面并发加载只请求一次模块", async () => {
    const seen: PageId[] = [];
    const reg = createPageRegistry(pageTable(seen, new Set()));
    await Promise.all([reg.load("tasks"), reg.load("tasks")]);
    expect(seen).toEqual(["tasks"]);
  });

  it("加载失败不缓存：下一次重新请求", async () => {
    let attempts = 0;
    const table = { ...pageTable([], new Set()) } as Record<PageId, () => Promise<unknown>>;
    const ok = table.home;
    table.home = async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("模块加载失败");
      return ok();
    };
    const reg = createPageRegistry(table as unknown as PageTable);
    await expect(reg.load("home")).rejects.toThrow("模块加载失败");
    await reg.load("home");
    expect(attempts).toBe(2);
    expect(reg.resolved("home")).not.toBeNull();
  });

  it("模块没有默认导出组件时报错", async () => {
    const table = { ...pageTable([], new Set()), home: async () => ({ default: undefined }) } as unknown as PageTable;
    await expect(createPageRegistry(table).load("home")).rejects.toThrow("没有默认导出页面组件");
  });
});
