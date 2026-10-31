// @vitest-environment jsdom
// 冒烟测试：装配好的整个应用在浏览器假后端（ipc/mock）下启动，只经界面操作依次走到每个页面
// （实例详情走遍五个分页、设置走遍六个分区），再打开新建实例与登录流程，首次启动时整窗是向导。
// 不用 act 包裹、不用假定时器：渲染、懒加载与动画都按真实时间推进，最接近浏览器里 pnpm dev 的样子。
// 任何一处出错都会留下痕迹：页面错误边界的错误页、console.error（外层统一处理与错误边界都会写）、error 通知。

import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import App, { prepareApp } from "./App";
import { stubCanvas } from "./art/illustrations/test-canvas";
import { INSTANCE_TAB_LABEL, PAGE_LABEL, SETTINGS_SECTION_LABEL } from "./copy/flows";
import { DEVICE_DIALOG_COPY } from "./copy/login";
import { FOOTER_COPY, STEP_COPY } from "./flows/onboarding/copy";
import { resetMocks } from "./ipc/mock";
import { ACCOUNT_COPY, PAGE_ERROR_COPY, SIDEBAR_COPY } from "./copy/shell";
import { DEFAULT_APPEARANCE } from "./state/appearance";
import { INSTANCE_TABS, PAGE_IDS, SETTINGS_SECTIONS, type PageId } from "./state/route";
import { stubMatchMedia, stubResizeObserver } from "./test/dom";
import type { IpcRecorder } from "./test/fake-bridge";
import { resetRecorder } from "./test/launcher";

const ipc = vi.hoisted((): IpcRecorder => ({ calls: [], overrides: new Map() }));
vi.mock("./ipc/bridge", async (orig) => (await import("./test/fake-bridge")).fakeBridge(await orig(), ipc));

/** 页面模块第一次经 vite 转换要几百毫秒，留足余量。 */
const WAIT = { timeout: 15_000, interval: 25 };
/** 假后端里带 Fabric、有 Mod 与存档的实例。 */
const INSTANCE = "樱花生存";

let root: Root | null = null;
let host: HTMLDivElement | null = null;
let layout: HTMLStyleElement | null = null;
let consoleError: MockInstance<typeof console.error>;
/** 已经确认渲染过的页面。 */
let visited: PageId[];

function mount(): void {
  // 测试不处理 CSS 模块。外壳与页面之间有一条靠样式成立的约定：内容区是纵向滚动容器（发现页据此找吸顶与预取的滚动根），
  // 这里按外壳样式表补上这一条
  layout = document.createElement("style");
  layout.textContent = "[data-sk-focus-fallback] { overflow-y: auto; }";
  document.head.append(layout);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  // 花瓣画布依赖真实的 2D 上下文与帧循环，冒烟测试只关心页面能否渲染
  root.render(<App appearance={{ ...DEFAULT_APPEARANCE, petals: false }} />);
}

const content = (): HTMLElement => {
  const el = document.querySelector<HTMLElement>("[data-sk-focus-fallback]");
  if (el === null) throw new Error("内容区还没挂载");
  return el;
};

const titleBar = (): string => document.querySelector("header")?.textContent ?? "";

function click(el: Element): void {
  el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, detail: 1 }));
}

function sidebarItem(key: string): HTMLElement {
  const el = document.querySelector<HTMLElement>(`[data-sidebar-item="${key}"]`);
  if (el === null) throw new Error(`侧栏没有 ${key}`);
  return el;
}

function buttonIn(scope: ParentNode, label: string): HTMLButtonElement {
  const el = [...scope.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent?.trim() === label);
  if (el === undefined) throw new Error(`找不到按钮「${label}」`);
  return el;
}

/** 账户胶囊菜单的「管理账户」：菜单项里名称后面还跟着一行说明。 */
async function openAccountsFromCapsule(): Promise<void> {
  const capsule = document.querySelector<HTMLButtonElement>("header button[aria-haspopup='menu']");
  if (capsule === null) throw new Error("标题栏没有账户胶囊");
  click(capsule);
  const manage = await vi.waitFor(() => {
    const item = [...document.querySelectorAll<HTMLElement>("[role='menu'] [role='menuitem']")].find((el) => el.textContent?.startsWith(ACCOUNT_COPY.manage));
    if (item === undefined) throw new Error("账户菜单里没有「管理账户」");
    return item;
  }, WAIT);
  click(manage);
}

/** 页面已渲染（懒加载完成、Suspense 放开）且没有落进页面错误边界；expected 为页面一级标题的写法。 */
async function expectPage(page: PageId, expected: string | null): Promise<void> {
  await vi.waitFor(() => {
    expect(titleBar()).toContain(page === "instance" ? INSTANCE : PAGE_LABEL[page]);
    const h1 = content().querySelector("h1");
    if (h1 === null) throw new Error(`${page} 页还没有渲染出标题`);
    if (expected !== null) expect(h1.textContent).toBe(expected);
  }, WAIT);
  expect(content().textContent).not.toContain(PAGE_ERROR_COPY.title);
  visited.push(page);
}

function expectNoFailures(): void {
  expect(consoleError.mock.calls).toEqual([]);
  expect([...document.querySelectorAll("[data-tone='error']")].map((el) => el.textContent)).toEqual([]);
}

beforeEach(() => {
  // test/dom 在加载时打开了 act 环境；这里让 React 照浏览器的方式自行调度，不要求更新包在 act 里
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
  resetMocks();
  resetRecorder(ipc);
  stubResizeObserver();
  stubMatchMedia(false);
  stubCanvas();
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  // 远程缩略图走 fetch：测试不联网，取图失败按设计回落到代码绘制的图形（只记 warn）
  vi.stubGlobal("fetch", () => Promise.reject(new TypeError("测试环境不联网")));
  HTMLElement.prototype.scrollTo = function scrollTo(this: HTMLElement) {
    this.scrollTop = 0;
  };
  Element.prototype.scrollIntoView = function scrollIntoView() {};
  consoleError = vi.spyOn(console, "error");
  visited = [];
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.spyOn(console, "info").mockImplementation(() => undefined);
});

afterEach(() => {
  root?.unmount();
  root = null;
  host?.remove();
  host = null;
  layout?.remove();
  layout = null;
  vi.unstubAllGlobals();
  document.documentElement.removeAttribute("data-sk-mode");
  document.documentElement.removeAttribute("data-sk-accent");
});

describe("应用冒烟：浏览器假后端", () => {
  it("七个页面都被外壳收集，只经界面操作就能逐页走到，每页都正常渲染", async () => {
    ipc.overrides.set("is_first_run", () => false);
    await prepareApp();
    mount();

    await expectPage("home", null);

    click(sidebarItem("library"));
    await expectPage("library", PAGE_LABEL.library);

    await vi.waitFor(() => buttonIn(content(), INSTANCE), WAIT);
    click(buttonIn(content(), INSTANCE));
    await expectPage("instance", INSTANCE);
    for (const tab of INSTANCE_TABS) {
      const tabButton = [...content().querySelectorAll<HTMLButtonElement>("[role='tab']")].find((b) => b.textContent?.startsWith(INSTANCE_TAB_LABEL[tab]));
      if (tabButton === undefined) throw new Error(`实例页没有「${INSTANCE_TAB_LABEL[tab]}」分页`);
      click(tabButton);
      await vi.waitFor(() => expect(tabButton.getAttribute("aria-selected")).toBe("true"), WAIT);
      // 概览是实例页的默认分页，面包屑不写它
      expect(titleBar()).toContain(tab === "overview" ? `${PAGE_LABEL.library}/${INSTANCE}` : `${PAGE_LABEL.library}/${INSTANCE}/${INSTANCE_TAB_LABEL[tab]}`);
      expect(content().textContent).not.toContain(PAGE_ERROR_COPY.title);
    }

    click(sidebarItem("discover"));
    await expectPage("discover", null);

    click(sidebarItem("tasks"));
    await expectPage("tasks", PAGE_LABEL.tasks);

    await openAccountsFromCapsule();
    await expectPage("accounts", PAGE_LABEL.accounts);

    click(sidebarItem("settings"));
    await expectPage("settings", PAGE_LABEL.settings);
    const sections = content().querySelector("nav");
    if (sections === null) throw new Error("设置页没有分区导航");
    for (const section of SETTINGS_SECTIONS) {
      const item = [...sections.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent?.startsWith(SETTINGS_SECTION_LABEL[section]));
      if (item === undefined) throw new Error(`设置页没有「${SETTINGS_SECTION_LABEL[section]}」分区`);
      click(item);
      await vi.waitFor(() => expect(item.getAttribute("aria-current")).toBe("page"), WAIT);
      expect(content().textContent).not.toContain(PAGE_ERROR_COPY.title);
    }

    // 回到主页：主页模块是启动前预载的，切回来同步渲染
    click(sidebarItem("home"));
    await expectPage("home", null);

    // 路由表里的每个页面都走到过：新增页面而忘了让外壳收集或给出入口，这里会少一项
    expect([...new Set(visited)].sort()).toEqual([...PAGE_IDS].sort());
    expectNoFailures();
  }, 60_000);

  it("新建实例与登录流程由外壳挂载，从界面打开即出现", async () => {
    ipc.overrides.set("is_first_run", () => false);
    await prepareApp();
    mount();
    await expectPage("home", null);

    click(sidebarItem("create"));
    await vi.waitFor(() => {
      const dialog = document.querySelector("[role='dialog']");
      if (dialog === null) throw new Error("新建实例弹窗还没出现");
      expect(dialog.textContent).toContain(SIDEBAR_COPY.create);
    }, WAIT);

    // 新建流程没填任何内容：底栏「取消」直接关闭，不弹放弃确认
    const dialog = document.querySelector("[role='dialog']");
    if (dialog === null) throw new Error("新建实例弹窗不见了");
    click(buttonIn(dialog, "取消"));
    await vi.waitFor(() => expect(document.querySelector("[role='dialog']")).toBeNull(), WAIT);

    click(sidebarItem("settings"));
    await expectPage("settings", PAGE_LABEL.settings);
    await openAccountsFromCapsule();
    await expectPage("accounts", PAGE_LABEL.accounts);

    click(buttonIn(content(), "添加微软账户"));
    await vi.waitFor(() => {
      const dialog = document.querySelector("[role='dialog']");
      if (dialog === null) throw new Error("登录弹窗还没出现");
      expect(dialog.querySelector("h2")?.textContent).toBe(DEVICE_DIALOG_COPY.title);
    }, WAIT);
    // 设备码弹窗挂载即向后端要代码
    expect(ipc.calls.filter((c) => c.cmd === "microsoft_login")).toHaveLength(1);
    expectNoFailures();
  }, 60_000);

  it("首次启动：整窗是向导、没有侧栏；第二步「直接开始」收尾后，向导退场再换成主界面", async () => {
    // 不改写 is_first_run：假后端初始就是首次启动，complete_first_run 之后才变成 false
    await prepareApp();
    mount();
    await vi.waitFor(() => expect(document.body.textContent).toContain(STEP_COPY.gameDir.title), WAIT);
    expect(document.querySelector("[data-sidebar-item]")).toBeNull();

    // 游戏目录预填了默认位置，第一步直接下一步
    await vi.waitFor(() => expect(buttonIn(document, FOOTER_COPY.next).disabled).toBe(false), WAIT);
    click(buttonIn(document, FOOTER_COPY.next));
    await vi.waitFor(() => expect(document.body.textContent).toContain(STEP_COPY.java.title), WAIT);
    click(buttonIn(document, FOOTER_COPY.startNow));

    await expectPage("home", null);
    expect(document.body.textContent).not.toContain(STEP_COPY.gameDir.title);
    expect(document.querySelector("[data-sidebar-item='home']")).not.toBeNull();
    // 只提交一次：默认游戏目录，加上探测到的其他启动器文件夹（向导默认全收）
    const finished = ipc.calls.filter((c) => c.cmd === "complete_first_run");
    expect(finished).toHaveLength(1);
    const { mockInvoke } = await import("./ipc/mock");
    const config = await mockInvoke<{ game_dir: string }>("get_config");
    expect(finished[0].args.gameDir).toBe(config.game_dir);
    expectNoFailures();
  }, 60_000);
});
