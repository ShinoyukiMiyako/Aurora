// @vitest-environment jsdom
// @module-tag heavy-page
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stubCanvas } from "../art/illustrations/test-canvas";
import { AVATAR_LINE, LAUNCH_COPY, PAGE_LABEL, STOPPED_LABEL } from "../copy/flows";
import type { InstanceSummary } from "../domain/adapt";
import type { LaunchView } from "../launch/launchView";
import { startSession } from "../state/session";
import type { Task } from "../domain/types";
import { LauncherProvider } from "../state/launcher";
import { keydown, render, stubMatchMedia, stubResizeObserver, type Rendered } from "../test/dom";
import type { IpcRecorder } from "../test/fake-bridge";
import { bootOverrides, callsOf, configDto, instanceDto, resetRecorder, settle } from "../test/launcher";
import { ChromeProvider, type ChromeApi } from "./chrome";
import { SIDEBAR_COPY } from "../copy/shell";
import { OverlayRoot } from "./overlay";
import { ShellProvider, useNav, useShell, type NavApi, type ShellApi } from "./shell";
import { dragShift, dropIndex, moveItem, PIN_STEP, pinLaunchItem, pinLine, pinTarget, Sidebar, sidebarSelection } from "./Sidebar";

const ipc = vi.hoisted((): IpcRecorder => ({ calls: [], overrides: new Map() }));
vi.mock("../ipc/bridge", async (orig) => (await import("../test/fake-bridge")).fakeBridge(await orig(), ipc));

const T0 = 1_700_000_000_000;
const inst = { id: "生存", name: "生存", lastPlayedAt: null } as InstanceSummary;
const session = startSession("生存", "launch-1", { uuid: "u", name: "Steve", kind: "microsoft" }, T0, null);

describe("侧栏选中项", () => {
  it("主导航页各自对应；账户页没有选中项", () => {
    expect(sidebarSelection({ page: "discover" }, [])).toBe("discover");
    expect(sidebarSelection({ page: "settings", section: "java" }, [])).toBe("settings");
    expect(sidebarSelection({ page: "accounts" }, [])).toBeNull();
  });

  it("实例页：固定了就选中固定项，没固定选中实例库", () => {
    expect(sidebarSelection({ page: "instance", id: "生存", tab: "mods" }, ["生存"])).toBe("pin:生存");
    expect(sidebarSelection({ page: "instance", id: "创造", tab: "overview" }, ["生存"])).toBe("library");
  });

  it("点固定实例：崩溃了进崩溃诊断，其余进概览", () => {
    expect(pinTarget({ kind: "crashed", session }, "生存")).toEqual({ page: "instance", id: "生存", tab: "crash" });
    expect(pinTarget({ kind: "ready", busyElsewhere: false }, "生存")).toEqual({ page: "instance", id: "生存", tab: "overview" });
  });
});

describe("固定实例名称提示的第二行", () => {
  const queuedTask = { id: "t", status: "queued", progress: 0 } as Task;
  const cases: [string, LaunchView, string][] = [
    ["就绪且从没玩过", { kind: "ready", busyElsewhere: false }, AVATAR_LINE.ready(null, T0)],
    ["加载中封顶 99%", { kind: "loading", session: { ...session, progress: 0.999 }, phase: "launching" }, AVATAR_LINE.loading("launching", "99%")],
    ["运行中写计时", { kind: "running", session: { ...session, phase: "running", runningSince: T0 - 125_000 } }, AVATAR_LINE.running(125_000)],
    ["已结束写原因", { kind: "stopped", session, reason: "killed" }, STOPPED_LABEL.killed],
    ["排队安装写名次", { kind: "installing", task: queuedTask, queuePosition: 2 }, AVATAR_LINE.queued(2)],
    ["安装中写百分比", { kind: "installing", task: { ...queuedTask, status: "running", progress: 0.5 }, queuePosition: null }, AVATAR_LINE.installing("50%")],
    ["后端在装、前端没有任务", { kind: "installing", task: null, queuePosition: null }, SIDEBAR_COPY.waitingInstall],
    ["损坏", { kind: "broken", reason: "x", reimport: false }, AVATAR_LINE.broken],
  ];
  it.each(cases)("%s", (_name, view, expected) => {
    expect(pinLine(view, inst, T0)).toBe(expected);
  });

  it("排队中却没有名次是状态坏了，直接抛错", () => {
    expect(() => pinLine({ kind: "installing", task: queuedTask, queuePosition: null }, inst, T0)).toThrow("没有名次");
  });
});

describe("拖动排序的几何", () => {
  it("移动一项保持其余相对顺序；越界抛错", () => {
    expect(moveItem(["a", "b", "c", "d"], 0, 2)).toEqual(["b", "c", "a", "d"]);
    expect(moveItem(["a", "b", "c", "d"], 3, 1)).toEqual(["a", "d", "b", "c"]);
    expect(() => moveItem(["a"], 0, 1)).toThrow("越界");
  });

  it("越过半格才换位，并夹在首尾之内", () => {
    expect(dropIndex(1, PIN_STEP / 2 - 1, 4)).toBe(1);
    expect(dropIndex(1, PIN_STEP / 2 + 1, 4)).toBe(2);
    expect(dropIndex(1, -PIN_STEP * 5, 4)).toBe(0);
    expect(dropIndex(1, PIN_STEP * 9, 4)).toBe(3);
  });

  it("被越过的项朝反方向让一格，其余不动", () => {
    expect([0, 1, 2, 3].map((i) => dragShift(i, 0, 2))).toEqual([0, -PIN_STEP, -PIN_STEP, 0]);
    expect([0, 1, 2, 3].map((i) => dragShift(i, 3, 1))).toEqual([0, PIN_STEP, PIN_STEP, 0]);
  });
});

describe("固定实例菜单的第一项", () => {
  const entry = (view: LaunchView, blocked: string | null = null, repairBlocked: string | null = null) => ({ view, blocked, repairBlocked, launch: vi.fn(), cancel: vi.fn(), stop: vi.fn(), openCrash: vi.fn() });

  it("按启动视图给出启动、取消、结束、诊断或修复", () => {
    expect(pinLaunchItem(entry({ kind: "ready", busyElsewhere: false })).label).toBe(LAUNCH_COPY.launch);
    expect(pinLaunchItem(entry({ kind: "loading", session, phase: "preparing" })).label).toBe(LAUNCH_COPY.cancel);
    expect(pinLaunchItem(entry({ kind: "running", session })).label).toBe(LAUNCH_COPY.stopGame);
    expect(pinLaunchItem(entry({ kind: "crashed", session })).label).toBe(LAUNCH_COPY.viewCrash);
    expect(pinLaunchItem(entry({ kind: "broken", reason: "x", reimport: false })).label).toBe(LAUNCH_COPY.repairAndLaunch);
    expect(pinLaunchItem(entry({ kind: "broken", reason: "x", reimport: true }))).toMatchObject({ label: "重新导入整合包", icon: "modpack" });
  });

  it("损坏实例被占着：修复是带原因的禁用项；重新导入不受影响", () => {
    const blocked = pinLaunchItem(entry({ kind: "broken", reason: "x", reimport: false }, null, "实例「Fabric」正在使用它，结束后才能补全"));
    expect(blocked).toMatchObject({ label: LAUNCH_COPY.repairAndLaunch, disabled: true, disabledReason: "实例「Fabric」正在使用它，结束后才能补全" });
    expect(pinLaunchItem(entry({ kind: "broken", reason: "x", reimport: true }))).not.toHaveProperty("disabled");
  });

  it("结束游戏走入口自己的确认，不直接调用", () => {
    const e = entry({ kind: "running", session });
    pinLaunchItem(e).onSelect();
    expect(e.stop).toHaveBeenCalledTimes(1);
    expect(e.launch).not.toHaveBeenCalled();
  });

  it("存档备份或恢复进行中：启动与重新启动是带原因的禁用项，点了不启动；取消、结束、诊断照常", () => {
    const reason = "正在备份或恢复存档，完成后再启动";
    const launchable: LaunchView[] = [
      { kind: "ready", busyElsewhere: false },
      { kind: "stopped", session, reason: "exited" },
      { kind: "failed", session, code: "spawn_failed", params: {} },
    ];
    for (const view of launchable) {
      const e = entry(view, reason);
      const item = pinLaunchItem(e);
      expect(item).toMatchObject({ disabled: true, disabledReason: reason });
    }
    for (const view of [{ kind: "running", session }, { kind: "crashed", session }] as LaunchView[]) {
      expect(pinLaunchItem(entry(view, reason)).disabled).toBeUndefined();
    }
  });

  it("安装中是禁用项", () => {
    const item = pinLaunchItem(entry({ kind: "installing", task: null, queuePosition: null }));
    expect(item.disabled).toBe(true);
    expect(item.label).toBe(SIDEBAR_COPY.installing);
  });
});

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
    <LauncherProvider>
      <ShellProvider>
        <ChromeProvider value={chrome}>
          <Probe />
          <Sidebar />
          <OverlayRoot />
        </ChromeProvider>
      </ShellProvider>
    </LauncherProvider>,
  );
  await flush();
}

const item = (key: string) => {
  const el = document.querySelector<HTMLButtonElement>(`[data-sidebar-item="${key}"]`);
  if (el === null) throw new Error(`侧栏没有条目 ${key}`);
  return el;
};

beforeEach(() => {
  vi.useFakeTimers();
  resetRecorder(ipc);
  stubResizeObserver();
  stubMatchMedia(false);
  stubCanvas();
  bootOverrides(ipc, { instances: [instanceDto("生存"), instanceDto("创造"), instanceDto("空岛")], pins: ["生存", "创造", "空岛"] });
  ipc.overrides.set("art_status", () => ({ source: null, panorama: false }));
  ipc.overrides.set("updater_info", () => ({ current_version: "0.1.0", supported: true, unsupported_reason: null, available: null, downloaded_version: null, install_on_exit: false }));
  ipc.overrides.set("set_sidebar_pins", (args) => args.pins);
  vi.mocked(chrome.scrollContentToTop).mockClear();
});
afterEach(() => {
  view?.unmount();
  view = undefined;
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("设置上的更新点", () => {
  const info = (patch: Record<string, unknown>) => ({
    current_version: "0.1.0",
    supported: true,
    unsupported_reason: null,
    available: null,
    downloaded_version: null,
    install_on_exit: false,
    ...patch,
  });
  const release = (version: string) => ({ version, current_version: "0.1.0", notes: null, date: null });
  const dotted = () => item("settings").getAttribute("aria-label") === SIDEBAR_COPY.settingsWithUpdate;

  it("检查到新版本时亮；打开更新面板看过之后熄灭", async () => {
    ipc.overrides.set("updater_info", () => info({ available: release("1.2.0") }));
    await mount();
    expect(dotted()).toBe(true);
    act(() => shell.openUpdatePanel());
    await flush();
    expect(dotted()).toBe(false);
    expect(item("settings").getAttribute("aria-label")).toBe(PAGE_LABEL.settings);
  });

  const skipped = () => bootOverrides(ipc, { config: configDto({ skipped_update_version: "1.2.0" }), instances: [], pins: [] });
  const cases: [string, () => void, Record<string, unknown>, boolean][] = [
    ["跳过的版本不亮", skipped, { available: release("1.2.0") }, false],
    ["跳过了但已下载待安装：照样亮", skipped, { available: release("1.2.0"), downloaded_version: "1.2.0" }, true],
    ["不支持自动更新时不亮", () => undefined, { supported: false, unsupported_reason: "debug_build", available: release("1.2.0") }, false],
    ["没有新版本时不亮", () => undefined, {}, false],
  ];
  it.each(cases)("%s", async (_name, boot, patch, expected) => {
    boot();
    ipc.overrides.set("updater_info", () => info(patch));
    await mount();
    expect(dotted()).toBe(expected);
  });
});

describe("侧栏", () => {
  it("只有选中项在 Tab 顺序里；↑↓ 逐项移动不循环，End 到最后", async () => {
    await mount();
    const keys = [...document.querySelectorAll<HTMLElement>("[data-sidebar-item]")].map((el) => [el.dataset.sidebarItem, el.tabIndex]);
    expect(keys).toEqual([
      ["home", 0],
      ["library", -1],
      ["discover", -1],
      ["tasks", -1],
      ["pin:生存", -1],
      ["pin:创造", -1],
      ["pin:空岛", -1],
      ["create", -1],
      ["settings", -1],
    ]);
    act(() => item("home").focus());
    keydown(item("home"), "ArrowUp");
    expect(document.activeElement).toBe(item("home"));
    keydown(item("home"), "ArrowDown");
    expect(document.activeElement).toBe(item("library"));
    keydown(item("library"), "End");
    expect(document.activeElement).toBe(item("settings"));
    keydown(item("settings"), "ArrowDown");
    expect(document.activeElement).toBe(item("settings"));
  });

  it("点固定实例进它的概览并选中；再点一次只滚回顶部", async () => {
    await mount();
    act(() => item("pin:创造").click());
    expect(nav.route).toEqual({ page: "instance", id: "创造", tab: "overview" });
    expect(item("pin:创造").getAttribute("aria-current")).toBe("page");
    expect(item("pin:创造").tabIndex).toBe(0);
    act(() => item("pin:创造").click());
    expect(chrome.scrollContentToTop).toHaveBeenCalledTimes(1);
    expect(nav.canForward).toBe(false);
  });

  it("拖动固定实例途中按 Esc 放弃：松手后补发的那次点击不进实例页，也不写入顺序", async () => {
    Object.defineProperty(HTMLElement.prototype, "setPointerCapture", { configurable: true, value: () => undefined });
    try {
      await mount();
      const pin = item("pin:创造");
      const pointer = (type: string, clientY: number) =>
        act(() => {
          pin.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, button: 0, pointerId: 7, clientY }));
        });
      pointer("pointerdown", 100);
      pointer("pointermove", 100 + PIN_STEP);
      keydown(window, "Escape");
      pointer("pointerup", 100 + PIN_STEP);
      act(() => pin.click());
      await flush();
      expect(nav.route).toEqual({ page: "home" });
      expect(callsOf(ipc, "set_sidebar_pins")).toEqual([]);
      // 放弃之后的下一次正常点击照常进实例页
      act(() => pin.click());
      expect(nav.route).toEqual({ page: "instance", id: "创造", tab: "overview" });
    } finally {
      delete (HTMLElement.prototype as { setPointerCapture?: unknown }).setPointerCapture;
    }
  });

  it("主导航条目的名称写页面名，快捷键写在 aria-keyshortcuts 上", async () => {
    await mount();
    expect(item("discover").getAttribute("aria-label")).toBe(PAGE_LABEL.discover);
    expect(item("discover").getAttribute("aria-keyshortcuts")).toBe("Control+3");
  });

  it("菜单键打开固定实例的菜单，「下移」把它和下一项对调并写入", async () => {
    await mount();
    act(() => item("pin:生存").focus());
    keydown(item("pin:生存"), "ContextMenu");
    await flush();
    const moveDown = [...document.querySelectorAll<HTMLElement>("[role='menuitem']")].find((el) => el.textContent === SIDEBAR_COPY.moveDown);
    if (moveDown === undefined) throw new Error("菜单里没有下移");
    const moveUp = [...document.querySelectorAll<HTMLElement>("[role='menuitem']")].find((el) => el.textContent === SIDEBAR_COPY.moveUp);
    expect(moveUp?.getAttribute("aria-disabled")).toBe("true");
    act(() => moveDown.click());
    await flush();
    expect(callsOf(ipc, "set_sidebar_pins")).toEqual([{ pins: ["创造", "生存", "空岛"] }]);
    const pins = [...document.querySelectorAll<HTMLElement>("[data-sidebar-item^='pin:']")].map((el) => el.dataset.sidebarItem);
    expect(pins).toEqual(["pin:创造", "pin:生存", "pin:空岛"]);
  });
});
