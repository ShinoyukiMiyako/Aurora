// @vitest-environment jsdom
// @module-tag heavy-page
import { MotionConfig } from "framer-motion";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stubCanvas } from "../art/illustrations/test-canvas";
import { AVATAR_LINE, LAUNCH_COPY, PAGE_LABEL, STOPPED_LABEL } from "../copy/flows";
import type { InstanceSummary } from "../domain/adapt";
import type { LaunchView } from "../launch/launchView";
import { springs, TOOLTIP_TIMING } from "../lib/motion";
import { startSession } from "../state/session";
import type { Task } from "../domain/types";
import { LauncherProvider, useLauncherActions } from "../state/launcher";
import { keydown, render, stubMatchMedia, stubResizeObserver, type Rendered } from "../test/dom";
import type { IpcRecorder } from "../test/fake-bridge";
import { bootOverrides, callsOf, configDto, instanceDto, resetRecorder, settle } from "../test/launcher";
import { ChromeProvider, type ChromeApi } from "./chrome";
import { SIDEBAR_COPY } from "../copy/shell";
import { OverlayRoot } from "./overlay";
import { ShellProvider, useNav, useShell, type NavApi, type ShellApi } from "./shell";
import { dragShift, dropIndex, moveItem, PIN_STEP, pinLaunchItem, pinLine, pinTarget, Sidebar, sidebarSelection, topWithin } from "./Sidebar";
import styles from "./Sidebar.module.css";

const ipc = vi.hoisted((): IpcRecorder => ({ calls: [], overrides: new Map() }));
vi.mock("../ipc/bridge", async (orig) => (await import("../test/fake-bridge")).fakeBridge(await orig(), ipc));

/** 侧栏经 animate 驱动的固定项位移：起点与所用弹簧。jsdom 里动画不走帧，只看它是怎么被发起的。 */
const motionCalls = vi.hoisted(() => [] as { from: unknown; transition: unknown }[]);
vi.mock("framer-motion", async (importOriginal) => {
  const actual = await importOriginal<typeof import("framer-motion")>();
  const animate = (...args: unknown[]) => {
    const [subject, , transition] = args;
    if (actual.isMotionValue(subject)) motionCalls.push({ from: subject.get(), transition });
    return (actual.animate as (...forwarded: unknown[]) => unknown)(...args);
  };
  return { ...actual, animate };
});

const T0 = 1_700_000_000_000;
const inst = { id: "生存", name: "生存", lastPlayedAt: null, playError: null } as InstanceSummary;
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

  it("游玩记录读不出：就绪时写读不到，不说从未游玩；别的状态照常", () => {
    const unread = { ...inst, playError: "解析 游玩记录 失败" };
    expect(pinLine({ kind: "ready", busyElsewhere: false }, unread, T0)).toBe("上次游玩读不到");
    expect(pinLine({ kind: "broken", reason: "x", reimport: false }, unread, T0)).toBe(AVATAR_LINE.broken);
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

describe("行在胶囊里的纵向位置", () => {
  /** jsdom 不做布局：手工给出每个元素的 offsetTop、定位祖先与已滚过的距离。 */
  function box(offsetTop: number, offsetParent: HTMLElement | null, scrollTop = 0): HTMLElement {
    const el = document.createElement("div");
    Object.defineProperty(el, "offsetTop", { value: offsetTop });
    Object.defineProperty(el, "offsetParent", { value: offsetParent });
    el.scrollTop = scrollTop;
    Object.defineProperty(el, "scrollTop", { value: scrollTop });
    return el;
  }

  it("主导航的行：定位祖先就是胶囊，直接取 offsetTop", () => {
    const capsule = box(0, null);
    expect(topWithin(box(160, capsule), capsule)).toBe(160);
  });

  it("固定实例的行：逐级累加，并扣掉滚动容器已滚过的距离", () => {
    const capsule = box(0, null);
    const scroller = box(221, capsule, 30);
    const list = box(0, scroller);
    const row = box(54, list);
    expect(topWithin(row, capsule)).toBe(54 + 0 + 221 - 30);
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
let launcher: ReturnType<typeof useLauncherActions>;
const chrome: ChromeApi = { scrollContentToTop: vi.fn(), focusContent: vi.fn() };

function Probe() {
  nav = useNav();
  shell = useShell();
  launcher = useLauncherActions();
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

const selection = () => {
  const el = document.querySelector<HTMLElement>("[data-sidebar-selection]");
  if (el === null) throw new Error("侧栏没有选中滑块");
  return el;
};

/** 第 i 个可选中的行（主导航 0-3、固定实例、设置）排在 10 + 50i 处：jsdom 不做布局，滑块的位置靠它算。 */
const rowTop = (index: number) => 10 + index * 50;
/** onRead：每读一次行的布局时调用，读布局的那一刻就是浏览器按当时的属性算样式的时刻。 */
function stubRowLayout(onRead?: (row: HTMLElement) => void): void {
  vi.spyOn(HTMLElement.prototype, "offsetTop", "get").mockImplementation(function (this: HTMLElement) {
    const index = [...document.querySelectorAll("[data-sidebar-row]")].indexOf(this);
    if (index >= 0) onRead?.(this);
    return index < 0 ? 0 : rowTop(index);
  });
}

/** 固定项按钮自己的缩放过渡播完。 */
function transformEnd(pin: HTMLElement, propertyName = "transform"): void {
  act(() => {
    pin.dispatchEvent(new TransitionEvent("transitionend", { bubbles: true, propertyName }));
  });
}

// jsdom 不算层叠，样式表也没挂进文档：把样式表里的选择器换成 DOM 上实际挂的类名，直接拿去匹配真实的节点，
// 规则写得对不上 DOM 树（比如漏算了按钮外面那层名称提示的包裹）时这里会挂
const SHEET = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "Sidebar.module.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

/** 样式表里经由行去找固定项按钮（含按钮的伪元素）的选择器，原样。 */
const PIN_SELECTORS = [...SHEET.matchAll(/([^{}]+)\{[^}]*\}/g)]
  .flatMap((m) => m[1].split(","))
  .map((s) => s.trim())
  .filter((s) => /\.row(?![\w-])/.test(s) && /\.pin(?![\w-])\S*$/.test(s));

/** 换成浏览器认识的选择器：拆掉构建期的 :global()，局部类名换成 CSS 模块给的类名（vitest 按 stable 策略取名）。 */
function domSelector(selector: string): string {
  return selector.replace(/:global\(([^)]*)\)/g, "$1").replace(/\.([A-Za-z][\w-]*)/g, (_m, name: string) => `.${styles[name]}`);
}

/** 只留类名与组合符：去掉根上的条件、状态属性、:not()、伪类与伪元素，只看这条路径在 DOM 树上走不走得通。 */
function skeleton(selector: string): string {
  return domSelector(selector.replace(/:global\([^)]*\)/g, "").replace(/:not\([^)]*\)|\[[^\]]*\]|::?[\w-]+/g, "")).trim();
}

/** 样式表里带 marker 的那条固定项按钮规则（不含伪元素；:not() 里的不算带），换成 DOM 上的类名。 */
function pinRule(marker: string): string {
  const found = PIN_SELECTORS.filter((s) => s.replace(/:not\([^)]*\)/g, "").includes(marker) && !s.includes("::"));
  if (found.length !== 1) throw new Error(`样式表里带 ${marker} 的固定项按钮规则应正好一条，实际 ${found.length} 条`);
  return domSelector(found[0]);
}

/** 固定项的按下缩小（不含减少动画那条）去掉 :active、换成 DOM 上的类名：按住时它会不会落在这个按钮上。 */
function pressShrinkRule(): string {
  const found = PIN_SELECTORS.filter((s) => s.endsWith(".pin:active") && !s.includes("[data-sk-reduced]"));
  if (found.length !== 1) throw new Error(`样式表里固定项的按下缩小应正好一条，实际 ${found.length} 条`);
  return domSelector(found[0].slice(0, -":active".length));
}

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

  // jsdom 里动画不走帧：之后才亮的点停在入场起点上，看得出它从哪里起步
  const entrances: [string, "never" | "always", string][] = [
    ["平常从 0 弹出", "never", "scale(0)"],
    ["减少动画只淡入，不缩放", "always", ""],
  ];
  it.each(entrances)("设置读到之后才亮的点：%s", async (_name, reducedMotion, transform) => {
    let arrive: () => void = () => {
      throw new Error("设置还没被请求");
    };
    ipc.overrides.set("get_config", () => new Promise((resolve) => (arrive = () => resolve(configDto()))));
    ipc.overrides.set("updater_info", () => info({ available: release("1.2.0") }));
    view = render(
      <MotionConfig reducedMotion={reducedMotion}>
        <LauncherProvider>
          <ShellProvider>
            <ChromeProvider value={chrome}>
              <Probe />
              <Sidebar />
              <OverlayRoot />
            </ChromeProvider>
          </ShellProvider>
        </LauncherProvider>
      </MotionConfig>,
    );
    await flush();
    expect(dotted()).toBe(false);
    arrive();
    await flush();
    expect(dotted()).toBe(true);
    const dot = item("settings").querySelector<HTMLElement>(`.${styles.dot}`);
    if (dot === null) throw new Error("设置上没有更新点");
    expect(dot.style.opacity).toBe("0");
    expect(dot.style.transform).toBe(transform);
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
      // 放弃就地放下：不等什么落地，缩回按 pop
      expect(pin.closest("li")?.hasAttribute("data-dragging")).toBe(false);
      expect(pin.closest("li")?.hasAttribute("data-landing")).toBe(true);
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

  it("拖动途中按 Esc 放弃时指针还按着：刚放下的那一项不吃按下缩小，缩回播完也等松开才摘掉放下的记号", async () => {
    Object.defineProperty(HTMLElement.prototype, "setPointerCapture", { configurable: true, value: () => undefined });
    try {
      await mount();
      const pin = item("pin:创造");
      const row = pin.closest("li");
      if (row === null) throw new Error("固定项不在列表项里");
      // jsdom 没有指针捕获：按住期间由这里报指针 7 还被按钮捕获着
      let pressed = false;
      Object.defineProperty(pin, "hasPointerCapture", { configurable: true, value: (pointerId: number) => pressed && pointerId === 7 });
      const pointer = (type: string, clientY: number) =>
        act(() => {
          pin.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, button: 0, pointerId: 7, clientY }));
        });
      const press = pressShrinkRule();
      expect(pin.matches(press)).toBe(true);

      pressed = true;
      pointer("pointerdown", 100);
      pointer("pointermove", 100 + PIN_STEP);
      keydown(window, "Escape");
      expect(row.hasAttribute("data-landing")).toBe(true);
      expect(pin.matches(press)).toBe(false);
      // 缩回播完时还按着：记号留着，按下缩小不在这时补上来
      transformEnd(pin);
      expect(row.hasAttribute("data-landing")).toBe(true);
      expect(pin.matches(press)).toBe(false);

      pressed = false;
      pointer("pointerup", 100 + PIN_STEP);
      expect(row.hasAttribute("data-landing")).toBe(false);
      expect(pin.matches(press)).toBe(true);
    } finally {
      delete (HTMLElement.prototype as { setPointerCapture?: unknown }).setPointerCapture;
    }
  });

  it("拖动中方块保持上浮；松手提交新顺序后，被拖项从松手处用 pop 飞进空位，其余项 settle", async () => {
    Object.defineProperty(HTMLElement.prototype, "setPointerCapture", { configurable: true, value: () => undefined });
    try {
      // 松手之后每次读被拖那一行的布局时，它是不是还保持拿起的样子
      let released: HTMLElement | null = null;
      const liftedAtRead: boolean[] = [];
      stubRowLayout((row) => {
        if (row === released) liftedAtRead.push(row.hasAttribute("data-dragging"));
      });
      // 松手点要落在胶囊里才算提交：jsdom 不做布局，给一个足够大的矩形
      vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({ left: 0, top: 0, right: 1000, bottom: 1000, width: 1000, height: 1000, x: 0, y: 0, toJSON: () => ({}) });
      await mount();
      const pin = item("pin:生存");
      const row = pin.closest("li");
      if (row === null) throw new Error("固定项不在列表项里");
      // jsdom 没有指针捕获：缩回播完时指针早已松开，不再被按钮捕获
      Object.defineProperty(pin, "hasPointerCapture", { configurable: true, value: () => false });
      const pointer = (type: string, clientY: number) =>
        act(() => {
          pin.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, button: 0, pointerId: 7, clientX: 10, clientY }));
        });
      // 越过一格再多 5px：落点是第二格，松手时被拖项比空位低 5px
      const overshoot = 5;
      pointer("pointerdown", 100);
      pointer("pointermove", 100 + PIN_STEP + overshoot);
      expect(row.hasAttribute("data-dragging")).toBe(true);
      expect(pin.querySelector("[data-sk-art='iso']")?.className).toMatch(/lift/);

      motionCalls.length = 0;
      released = row;
      pointer("pointerup", 100 + PIN_STEP + overshoot);
      // 新顺序还没落地：保持拿起
      expect(row.hasAttribute("data-dragging")).toBe(true);
      expect(row.hasAttribute("data-landing")).toBe(false);
      await flush();
      expect(callsOf(ipc, "set_sidebar_pins")).toEqual([{ pins: ["创造", "生存", "空岛"] }]);
      expect(motionCalls.filter((call) => call.transition === springs.pop)).toEqual([{ from: overshoot, transition: springs.pop }]);
      expect(motionCalls.filter((call) => call.transition === springs.settle)).toHaveLength(2);
      // 落地时读布局（节点已按新顺序挪好）那一刻还是拿起的样子，读完才放下：缩回与阴影淡出从挪好的节点上起步
      expect(liftedAtRead.length).toBeGreaterThan(0);
      expect(liftedAtRead.every(Boolean)).toBe(true);
      expect(row.hasAttribute("data-dragging")).toBe(false);
      expect(row.hasAttribute("data-landing")).toBe(true);
      // 样式表里按 pop 缩回的那条规则真的落在这个按钮上
      expect(pin.matches(pinRule("[data-landing]"))).toBe(true);

      // 别的属性（阴影叠层的透明度）播完不算；缩放播完才清掉放下的记号
      transformEnd(pin, "opacity");
      expect(row.hasAttribute("data-landing")).toBe(true);
      transformEnd(pin);
      expect(row.hasAttribute("data-landing")).toBe(false);
      expect(pin.matches(pinRule("[data-landing]"))).toBe(false);
    } finally {
      delete (HTMLElement.prototype as { setPointerCapture?: unknown }).setPointerCapture;
    }
  });

  it("放下之后焦点还在这一项、键盘按住空格时缩回播完：照常摘掉放下的记号，按下缩小显出来，不等一次不会来的指针松开", async () => {
    Object.defineProperty(HTMLElement.prototype, "setPointerCapture", { configurable: true, value: () => undefined });
    try {
      stubRowLayout();
      vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({ left: 0, top: 0, right: 1000, bottom: 1000, width: 1000, height: 1000, x: 0, y: 0, toJSON: () => ({}) });
      await mount();
      const pin = item("pin:生存");
      const row = pin.closest("li");
      if (row === null) throw new Error("固定项不在列表项里");
      // 指针已经松开，不再被按钮捕获；键盘按住空格时按钮处在 :active（jsdom 只在派发 mousedown 的那一刻认 :active，由这里报）
      let keyHeld = false;
      Object.defineProperty(pin, "hasPointerCapture", { configurable: true, value: () => false });
      const matches = pin.matches.bind(pin);
      Object.defineProperty(pin, "matches", { configurable: true, value: (selector: string) => (selector === ":active" ? keyHeld : matches(selector)) });
      const pointer = (type: string, clientY: number) =>
        act(() => {
          pin.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, button: 0, pointerId: 7, clientX: 10, clientY }));
        });
      pointer("pointerdown", 100);
      pointer("pointermove", 100 + PIN_STEP);
      pointer("pointerup", 100 + PIN_STEP);
      await flush();
      expect(callsOf(ipc, "set_sidebar_pins")).toEqual([{ pins: ["创造", "生存", "空岛"] }]);
      expect(row.hasAttribute("data-landing")).toBe(true);

      keyHeld = true;
      transformEnd(pin);
      expect(row.hasAttribute("data-landing")).toBe(false);
      expect(pin.matches(pressShrinkRule())).toBe(true);
    } finally {
      delete (HTMLElement.prototype as { setPointerCapture?: unknown }).setPointerCapture;
    }
  });

  it("拖动安装中自动固定的项：提交了显示顺序也没变，各项按 pop 弹回原位；之后不相干的增删不再给它用 pop", async () => {
    Object.defineProperty(HTMLElement.prototype, "setPointerCapture", { configurable: true, value: () => undefined });
    try {
      stubRowLayout();
      vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({ left: 0, top: 0, right: 1000, bottom: 1000, width: 1000, height: 1000, x: 0, y: 0, toJSON: () => ({}) });
      bootOverrides(ipc, { instances: [instanceDto("生存"), instanceDto("创造")], pins: ["生存"] });
      // 安装一直不结束：新实例停在「安装中、自动固定」，排在固定区末尾
      ipc.overrides.set("install_version", () => new Promise(() => undefined));
      await mount();
      await act(async () => {
        await launcher.createInstance({ name: "新世界", mcVersion: "1.21.1", loader: "vanilla", loaderVersion: null, cover: "grass" });
      });
      await flush();
      const order = () => [...document.querySelectorAll<HTMLElement>("[data-sidebar-item^='pin:']")].map((el) => el.dataset.sidebarItem);
      expect(order()).toEqual(["pin:生存", "pin:新世界"]);

      const pin = item("pin:新世界");
      const pointer = (type: string, clientY: number) =>
        act(() => {
          pin.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, button: 0, pointerId: 7, clientX: 10, clientY }));
        });
      const row = pin.closest("li");
      if (row === null) throw new Error("固定项不在列表项里");
      pointer("pointerdown", 200);
      pointer("pointermove", 200 - PIN_STEP);
      motionCalls.length = 0;
      pointer("pointerup", 200 - PIN_STEP);
      expect(row.hasAttribute("data-dragging")).toBe(true);
      await flush();
      // 占位项不写进固定列表：写入的顺序和原来一样，显示顺序也没变
      expect(callsOf(ipc, "set_sidebar_pins")).toEqual([{ pins: ["生存"] }]);
      expect(order()).toEqual(["pin:生存", "pin:新世界"]);
      // 提交落定时放下；被拖项从松手处、被越过的项从让位处，一起弹回原位
      expect(row.hasAttribute("data-dragging")).toBe(false);
      expect(row.hasAttribute("data-landing")).toBe(true);
      const back = motionCalls.filter((call) => call.transition === springs.pop);
      expect(back).toHaveLength(2);
      expect(back.map((call) => call.from)).toContain(-PIN_STEP);
      expect(motionCalls.filter((call) => call.transition === springs.settle)).toEqual([]);
      // 下一次按下固定项：按下的缩小走平常的 tap，放下的记号清掉
      act(() => {
        item("pin:生存").dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, button: 0, pointerId: 8, clientX: 10, clientY: 100 }));
        item("pin:生存").dispatchEvent(new PointerEvent("pointerup", { bubbles: true, cancelable: true, button: 0, pointerId: 8, clientX: 10, clientY: 100 }));
      });
      expect(row.hasAttribute("data-landing")).toBe(false);

      motionCalls.length = 0;
      await act(async () => {
        await launcher.togglePin("创造");
      });
      await flush();
      expect(order()).toEqual(["pin:生存", "pin:创造", "pin:新世界"]);
      // 新世界被新固定的创造挤到下一格：照常 settle，不再当成刚松手的那一项
      expect(motionCalls.filter((call) => call.transition === springs.pop)).toEqual([]);
      expect(motionCalls.filter((call) => call.transition === springs.settle).length).toBeGreaterThan(0);
    } finally {
      delete (HTMLElement.prototype as { setPointerCapture?: unknown }).setPointerCapture;
    }
  });

  it("松手后等写入落定期间按下另一项、还没拖起来时按 Esc：Esc 照常放行，随后的点击照常进实例页", async () => {
    Object.defineProperty(HTMLElement.prototype, "setPointerCapture", { configurable: true, value: () => undefined });
    try {
      stubRowLayout();
      vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({ left: 0, top: 0, right: 1000, bottom: 1000, width: 1000, height: 1000, x: 0, y: 0, toJSON: () => ({}) });
      bootOverrides(ipc, { instances: [instanceDto("生存"), instanceDto("创造")], pins: ["生存"] });
      ipc.overrides.set("install_version", () => new Promise(() => undefined));
      // 写入停在路上：显示顺序不变的这次松手一直等着它落定
      let landWrite: () => void = () => {
        throw new Error("固定顺序还没写入");
      };
      ipc.overrides.set("set_sidebar_pins", (args) => new Promise((resolve) => (landWrite = () => resolve(args.pins))));
      await mount();
      await act(async () => {
        await launcher.createInstance({ name: "新世界", mcVersion: "1.21.1", loader: "vanilla", loaderVersion: null, cover: "grass" });
      });
      await flush();
      const dragged = item("pin:新世界");
      const pointer = (target: HTMLElement, type: string, pointerId: number, clientY: number) =>
        act(() => {
          target.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, button: 0, pointerId, clientX: 10, clientY }));
        });
      pointer(dragged, "pointerdown", 7, 200);
      pointer(dragged, "pointermove", 7, 200 - PIN_STEP);
      pointer(dragged, "pointerup", 7, 200 - PIN_STEP);
      await flush();
      expect(dragged.closest("li")?.hasAttribute("data-dragging")).toBe(true);

      const other = item("pin:生存");
      pointer(other, "pointerdown", 8, 100);
      expect(keydown(window, "Escape").defaultPrevented).toBe(false);
      pointer(other, "pointerup", 8, 100);
      act(() => other.click());
      expect(nav.route).toEqual({ page: "instance", id: "生存", tab: "overview" });

      landWrite();
      await flush();
      expect(dragged.closest("li")?.hasAttribute("data-dragging")).toBe(false);
    } finally {
      delete (HTMLElement.prototype as { setPointerCapture?: unknown }).setPointerCapture;
    }
  });

  it("样式表里经由行去找固定项按钮的规则都对得上 DOM 树：按钮外面隔着名称提示的包裹层，子选择器走不通", async () => {
    await mount();
    const pin = item("pin:生存");
    // 按下缩小、拿起、放下、减少动画的降级都在里面：筛选本身漏了规则时这里先挂
    expect(PIN_SELECTORS.some((s) => s.includes("[data-landing]"))).toBe(true);
    expect(PIN_SELECTORS.some((s) => s.endsWith(":active"))).toBe(true);
    expect(PIN_SELECTORS.some((s) => s.includes("[data-sk-reduced]"))).toBe(true);
    for (const selector of PIN_SELECTORS) {
      expect(pin.matches(skeleton(selector)), selector).toBe(true);
    }
  });

  it("选中滑块停在选中那一行上；落到固定实例上只留指示条；账户页没有选中项时收起", async () => {
    stubRowLayout();
    await mount();
    expect(selection().hasAttribute("data-on")).toBe(true);
    expect(selection().dataset.kind).toBe("nav");
    expect(selection().style.translate).toBe(`0px ${rowTop(0)}px`);
    // 选中条目自己不铺底：浅底由滑块给
    expect(document.querySelectorAll("[data-sidebar-selection]")).toHaveLength(1);

    act(() => item("discover").click());
    expect(selection().style.translate).toBe(`0px ${rowTop(2)}px`);
    expect(selection().dataset.kind).toBe("nav");

    act(() => item("pin:创造").click());
    expect(selection().style.translate).toBe(`0px ${rowTop(5)}px`);
    expect(selection().dataset.kind).toBe("pin");

    act(() => nav.go({ page: "accounts" }));
    expect(selection().hasAttribute("data-on")).toBe(false);

    act(() => nav.go({ page: "settings" }));
    expect(selection().hasAttribute("data-on")).toBe(true);
    expect(selection().dataset.kind).toBe("nav");
    expect(selection().style.translate).toBe(`0px ${rowTop(7)}px`);
  });

  it("冷启动：滑块在侧栏挂上那一刻关着过渡显出；之后从收起到显出先关着过渡换好种类，再按过渡淡入", async () => {
    // jsdom 不算样式：读行布局的那一刻，就是浏览器按滑块当时的属性算样式、决定起不起过渡的时刻
    const atLayoutRead: { on: boolean; instant: boolean; kind: string | undefined }[] = [];
    vi.spyOn(HTMLElement.prototype, "offsetTop", "get").mockImplementation(function (this: HTMLElement) {
      const index = [...document.querySelectorAll("[data-sidebar-row]")].indexOf(this);
      const slider = document.querySelector<HTMLElement>("[data-sidebar-selection]");
      if (index >= 0 && slider !== null) atLayoutRead.push({ on: slider.hasAttribute("data-on"), instant: slider.hasAttribute("data-instant"), kind: slider.dataset.kind });
      return index < 0 ? 0 : rowTop(index);
    });
    await mount();
    expect(atLayoutRead[0]).toEqual({ on: true, instant: true, kind: "nav" });
    expect(selection().hasAttribute("data-instant")).toBe(false);
    expect(selection().hasAttribute("data-on")).toBe(true);

    act(() => nav.go({ page: "accounts" }));
    expect(selection().hasAttribute("data-on")).toBe(false);
    atLayoutRead.length = 0;
    act(() => item("pin:创造").click());
    // 种类在收起时就换成固定项、关着过渡；显出留到读完布局之后，照常淡入
    expect(atLayoutRead[0]).toEqual({ on: false, instant: true, kind: "pin" });
    expect(selection().hasAttribute("data-instant")).toBe(false);
    expect(selection().hasAttribute("data-on")).toBe(true);
    expect(selection().style.translate).toBe(`0px ${rowTop(5)}px`);

    // 显着的滑块从固定项滑回主导航：浅底照常淡入，不关过渡
    atLayoutRead.length = 0;
    act(() => item("home").click());
    expect(atLayoutRead[0]).toEqual({ on: true, instant: false, kind: "nav" });
  });

  it("收起的淡出还没播完就又要显出：不关过渡，从此刻的透明度反向淡回；只有位移动画在播时照常关着过渡换种类", async () => {
    const atLayoutRead: { on: boolean; instant: boolean; kind: string | undefined }[] = [];
    vi.spyOn(HTMLElement.prototype, "offsetTop", "get").mockImplementation(function (this: HTMLElement) {
      const index = [...document.querySelectorAll("[data-sidebar-row]")].indexOf(this);
      const slider = document.querySelector<HTMLElement>("[data-sidebar-selection]");
      if (index >= 0 && slider !== null) atLayoutRead.push({ on: slider.hasAttribute("data-on"), instant: slider.hasAttribute("data-instant"), kind: slider.dataset.kind });
      return index < 0 ? 0 : rowTop(index);
    });
    // jsdom 没有 Web Animations：给滑块补上 getAnimations，按需报出此刻在播的动画
    class FakeTransition {
      constructor(readonly transitionProperty: string) {}
    }
    vi.stubGlobal("CSSTransition", FakeTransition);
    let running: object[] = [];
    await mount();
    Object.defineProperty(selection(), "getAnimations", { configurable: true, value: () => running });

    act(() => nav.go({ page: "accounts" }));
    expect(selection().hasAttribute("data-on")).toBe(false);
    // 淡出途中（滑块自己的位移动画也还在）点回固定项
    running = [{}, new FakeTransition("opacity")];
    atLayoutRead.length = 0;
    act(() => item("pin:创造").click());
    expect(atLayoutRead[0]).toEqual({ on: false, instant: false, kind: "pin" });
    expect(selection().hasAttribute("data-on")).toBe(true);
    expect(selection().style.translate).toBe(`0px ${rowTop(5)}px`);

    // 淡出已经播完，只剩位移动画：照常关着过渡先换好种类
    act(() => nav.go({ page: "accounts" }));
    running = [{}];
    atLayoutRead.length = 0;
    act(() => item("home").click());
    expect(atLayoutRead[0]).toEqual({ on: false, instant: true, kind: "nav" });
    expect(selection().hasAttribute("data-instant")).toBe(false);
    expect(selection().hasAttribute("data-on")).toBe(true);
  });

  it("淡出没播完就又显出、而且换了一行：按仍显示着处理，从停着的那一行沿弹簧滑过去；淡出播完后再显出则直接出现在新行上", async () => {
    stubRowLayout();
    class FakeTransition {
      constructor(readonly transitionProperty: string) {}
    }
    vi.stubGlobal("CSSTransition", FakeTransition);
    let running: object[] = [];
    await mount();
    const slider = selection();
    Object.defineProperty(slider, "getAnimations", { configurable: true, value: () => running });
    // jsdom 没有 Web Animations：记下滑块交给合成线程的每一条轨迹。滑过去才有轨迹，直接到位没有
    const tracks: Keyframe[][] = [];
    Object.defineProperty(slider, "animate", {
      configurable: true,
      value: (frames: Keyframe[]) => {
        tracks.push(frames);
        return { currentTime: 0, cancel: () => undefined, onfinish: null };
      },
    });

    act(() => nav.go({ page: "accounts" }));
    running = [new FakeTransition("opacity")];
    act(() => item("pin:创造").click());
    expect(tracks).toHaveLength(1);
    expect(tracks[0][0].translate).toBe(`0px ${rowTop(0)}px`);
    expect(tracks[0].at(-1)?.translate).toBe(`0px ${rowTop(5)}px`);
    expect(slider.style.translate).toBe(`0px ${rowTop(5)}px`);
    expect(slider.hasAttribute("data-on")).toBe(true);

    act(() => nav.go({ page: "accounts" }));
    running = [];
    tracks.length = 0;
    act(() => item("home").click());
    expect(tracks).toEqual([]);
    expect(slider.style.translate).toBe(`0px ${rowTop(0)}px`);
  });

  it("在实例页取消固定当前实例：选中项换到实例库与固定顺序变化落在同一次提交里，滑块照样从固定行沿弹簧滑过去，不被直接到位掐断", async () => {
    stubRowLayout();
    await mount();
    act(() => item("pin:创造").click());
    const slider = selection();
    expect(slider.style.translate).toBe(`0px ${rowTop(5)}px`);
    // jsdom 没有 Web Animations：记下滑块交给合成线程的每一条轨迹，以及之后有没有被取消
    const tracks: { frames: Keyframe[]; cancelled: boolean }[] = [];
    Object.defineProperty(slider, "animate", {
      configurable: true,
      value: (frames: Keyframe[]) => {
        const track = { frames, cancelled: false };
        tracks.push(track);
        return {
          currentTime: 0,
          cancel: () => {
            track.cancelled = true;
          },
          onfinish: null,
        };
      },
    });

    await act(async () => {
      await launcher.togglePin("创造");
    });
    await flush();
    expect(callsOf(ipc, "set_sidebar_pins")).toEqual([{ pins: ["生存", "空岛"] }]);
    expect(nav.route).toEqual({ page: "instance", id: "创造", tab: "overview" });
    expect(tracks).toHaveLength(1);
    expect(tracks[0].frames[0].translate).toBe(`0px ${rowTop(5)}px`);
    expect(tracks[0].frames.at(-1)?.translate).toBe(`0px ${rowTop(1)}px`);
    expect(tracks[0].cancelled).toBe(false);
    expect(slider.style.translate).toBe(`0px ${rowTop(1)}px`);
  });

  it("指针按下主导航条目：滑块先行出发；在别处松开没点成，就滑回当前选中项", async () => {
    stubRowLayout();
    await mount();
    act(() => {
      item("tasks").dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, button: 0 }));
    });
    expect(selection().style.translate).toBe(`0px ${rowTop(3)}px`);
    expect(nav.route).toEqual({ page: "home" });
    act(() => {
      window.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }));
      vi.advanceTimersByTime(0);
    });
    expect(selection().style.translate).toBe(`0px ${rowTop(0)}px`);
  });

  it("按下后点成了：滑块留在新选中项上；右键按下不出发", async () => {
    stubRowLayout();
    await mount();
    act(() => {
      item("library").dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, button: 2 }));
    });
    expect(selection().style.translate).toBe(`0px ${rowTop(0)}px`);
    act(() => {
      item("library").dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, button: 0 }));
    });
    act(() => {
      window.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }));
      item("library").click();
      vi.advanceTimersByTime(0);
    });
    expect(nav.route).toEqual({ page: "library" });
    expect(selection().style.translate).toBe(`0px ${rowTop(1)}px`);
  });

  it("取消固定：退场的那一项被抽出布局，其余项不必等它淡完再补位", async () => {
    await mount();
    const row = item("pin:生存").closest("li");
    if (row === null) throw new Error("固定项不在列表项里");
    // popLayout 要量到非零的宽高才抽出布局，jsdom 里没有布局，手工给出
    row.style.width = "64px";
    row.style.height = "44px";
    act(() => item("pin:生存").focus());
    keydown(item("pin:生存"), "ContextMenu");
    await flush();
    const unpin = [...document.querySelectorAll<HTMLElement>("[role='menuitem']")].find((el) => el.textContent === SIDEBAR_COPY.unpin);
    if (unpin === undefined) throw new Error("菜单里没有取消固定");
    act(() => unpin.click());
    await flush();
    expect(callsOf(ipc, "set_sidebar_pins")).toEqual([{ pins: ["创造", "空岛"] }]);
    // 这个标记由 popLayout 写在它拿到的元素上：固定项没把 ref 交出去时它拿不到元素，标记不会出现
    expect(row.dataset.motionPopId).toMatch(/\S/);
  });

  it("随固定区一起出现的项不播入场；之后新固定的项从小处弹入", async () => {
    bootOverrides(ipc, { instances: [instanceDto("生存"), instanceDto("创造"), instanceDto("空岛"), instanceDto("末地")], pins: ["生存", "创造", "空岛"] });
    await mount();
    const rowOf = (key: string) => {
      const row = item(key).closest("li");
      if (row === null) throw new Error(`${key} 不在列表项里`);
      return row;
    };
    // jsdom 里动画不走帧：入场的项停在起点（透明），不播的项直接是终点
    expect(rowOf("pin:生存").style.opacity).toBe("1");
    await act(async () => {
      await launcher.togglePin("末地");
    });
    await flush();
    expect(callsOf(ipc, "set_sidebar_pins")).toEqual([{ pins: ["生存", "创造", "空岛", "末地"] }]);
    expect(rowOf("pin:末地").style.opacity).toBe("0");
    expect(rowOf("pin:生存").style.opacity).toBe("1");
  });

  // jsdom 里动画不走帧：新固定的项停在入场起点上，看得出它从哪里起步。退场见 Sidebar.pin-exit.test.tsx
  const pinEntrances: [string, "never" | "always", string][] = [
    ["平常从 0.6 弹入", "never", "scale(0.6)"],
    ["减少动画只淡入，不缩放", "always", "none"],
  ];
  it.each(pinEntrances)("之后新固定的项：%s", async (_name, reducedMotion, transform) => {
    bootOverrides(ipc, { instances: [instanceDto("生存"), instanceDto("末地")], pins: ["生存"] });
    view = render(
      <MotionConfig reducedMotion={reducedMotion}>
        <LauncherProvider>
          <ShellProvider>
            <ChromeProvider value={chrome}>
              <Probe />
              <Sidebar />
              <OverlayRoot />
            </ChromeProvider>
          </ShellProvider>
        </LauncherProvider>
      </MotionConfig>,
    );
    await flush();
    await act(async () => {
      await launcher.togglePin("末地");
    });
    await flush();
    const row = item("pin:末地").closest("li");
    if (row === null) throw new Error("新固定的项不在列表项里");
    expect(row.style.opacity).toBe("0");
    expect(row.style.transform).toBe(transform);
  });

  it("分隔线常驻：一个固定实例都没有时也在", async () => {
    bootOverrides(ipc, { instances: [instanceDto("生存")], pins: [] });
    await mount();
    expect(document.querySelectorAll("[data-sidebar-item^='pin:']")).toHaveLength(0);
    expect(document.querySelectorAll("nav [role='separator']")).toHaveLength(1);
  });

  it("冷启动：实例还没读到时不画固定区与新建按钮，读到后一起出现并淡入", async () => {
    let arrive: () => void = () => {
      throw new Error("实例列表还没被请求");
    };
    ipc.overrides.set(
      "list_instances",
      () =>
        new Promise((resolve) => {
          arrive = () => resolve([instanceDto("生存"), instanceDto("创造"), instanceDto("空岛")]);
        }),
    );
    await mount();
    expect(document.querySelector("[data-sidebar-item='create']")).toBeNull();
    expect(document.querySelectorAll("[data-sidebar-item^='pin:']")).toHaveLength(0);
    // 主导航、分隔线与设置不等数据
    expect(item("home").tabIndex).toBe(0);
    expect(item("settings")).toBeInstanceOf(HTMLButtonElement);
    expect(document.querySelectorAll("nav [role='separator']")).toHaveLength(1);

    arrive();
    await flush();
    expect([...document.querySelectorAll<HTMLElement>("[data-sidebar-item^='pin:']")].map((el) => el.dataset.sidebarItem)).toEqual(["pin:生存", "pin:创造", "pin:空岛"]);
    expect(item("create").closest("[data-late]")).not.toBeNull();
    expect(item("pin:生存").closest("ul")?.parentElement?.hasAttribute("data-late")).toBe(true);
  });

  it("侧栏挂载前数据就读到了（首次启动向导收尾后才换上主界面）：固定区与新建按钮直接出现，不播淡入", async () => {
    const tree = (withSidebar: boolean) => (
      <LauncherProvider>
        <ShellProvider>
          <ChromeProvider value={chrome}>
            <Probe />
            {withSidebar && <Sidebar />}
            <OverlayRoot />
          </ChromeProvider>
        </ShellProvider>
      </LauncherProvider>
    );
    view = render(tree(false));
    await flush();
    view.rerender(tree(true));
    await flush();
    expect(item("create").closest("[data-late]")).toBeNull();
    expect(item("pin:生存").closest("ul")?.parentElement?.hasAttribute("data-late")).toBe(false);
  });

  it("固定实例名称提示的第二行套在等宽数字的槽里", async () => {
    await mount();
    act(() => {
      item("pin:生存").dispatchEvent(new PointerEvent("pointerover", { bubbles: true }));
    });
    act(() => {
      vi.advanceTimersByTime(TOOLTIP_TIMING.sidebarDelay);
    });
    const tip = document.querySelector("[role='tooltip']");
    if (tip === null) throw new Error("悬停后没有出现名称提示");
    const line = tip.querySelector("[class*='pinLine']");
    expect(line?.textContent).toBe(AVATAR_LINE.ready(null, Date.now()));
  });

  it("主导航条目的名称写页面名，快捷键写在 aria-keyshortcuts 上", async () => {
    await mount();
    expect(item("discover").getAttribute("aria-label")).toBe(PAGE_LABEL.discover);
    expect(item("discover").getAttribute("aria-keyshortcuts")).toBe("Control+3");
  });

  describe("菜单开着时打开另一固定项的菜单：旧菜单留下播完退场，新菜单开着", () => {
    const menuOf = (name: string) => {
      const menu = [...document.querySelectorAll("[role='menu']")].find((el) => el.getAttribute("aria-label") === SIDEBAR_COPY.menuLabel(name));
      if (menu === undefined) throw new Error(`没有 ${name} 的菜单`);
      return menu;
    };
    // 浮层面板退场时带 data-exiting；jsdom 里退场动画不走帧，退场中的面板一直留在 DOM 里
    const exiting = (name: string) => menuOf(name).closest("[data-exiting]") !== null;

    it("键盘：旧菜单开着时用菜单键打开另一项", async () => {
      await mount();
      act(() => item("pin:生存").focus());
      keydown(item("pin:生存"), "ContextMenu");
      await flush();
      expect(exiting("生存")).toBe(false);
      keydown(item("pin:创造"), "ContextMenu");
      await flush();
      expect(exiting("创造")).toBe(false);
      expect(exiting("生存")).toBe(true);
    });

    it("指针：右键按下先把旧菜单当外部点击关掉，随后的 contextmenu 再打开新菜单", async () => {
      await mount();
      act(() => {
        item("pin:生存").dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
      });
      await flush();
      expect(exiting("生存")).toBe(false);
      act(() => {
        item("pin:创造").dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, button: 2 }));
      });
      // 打开新菜单之前，旧菜单已经关上、开始退场
      expect(exiting("生存")).toBe(true);
      act(() => {
        item("pin:创造").dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
      });
      await flush();
      expect(exiting("创造")).toBe(false);
      expect(exiting("生存")).toBe(true);
    });
  });

  it("开着菜单的实例被删掉：菜单记成关上，别的固定项的名称提示照常出现", async () => {
    await mount();
    act(() => item("pin:生存").focus());
    keydown(item("pin:生存"), "ContextMenu");
    await flush();
    expect(document.querySelector("[role='menu']")).not.toBeNull();

    ipc.overrides.set("list_instances", () => [instanceDto("创造"), instanceDto("空岛")]);
    await act(async () => {
      await launcher.refreshInstances();
    });
    await flush();
    // 固定项正在退场（jsdom 里退场不走帧，节点留着）；菜单随实例一起不画了
    expect(document.querySelector("[role='menu']")).toBeNull();

    act(() => {
      item("pin:创造").dispatchEvent(new PointerEvent("pointerover", { bubbles: true }));
    });
    act(() => {
      vi.advanceTimersByTime(TOOLTIP_TIMING.sidebarDelay);
    });
    const tips = [...document.querySelectorAll("[role='tooltip']")].map((tip) => tip.textContent);
    expect(tips.some((text) => text !== null && text.startsWith("创造"))).toBe(true);
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
