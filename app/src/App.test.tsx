// @vitest-environment jsdom
// 冒烟测试：装配好的整个应用在浏览器假后端（ipc/mock）下启动，只经界面操作依次走到每个页面
// （实例详情走遍五个分页、设置走遍六个分区），再打开各个主要弹窗，首次启动时整窗是向导。
// 三档宽度（compact、regular、wide）乘日樱、夜樱两套外观各走一遍：按档切换的布局与只在某一档挂载的模块
// （例如主页 wide 档的第三列）都要真的渲染过，默认宽度下走不到的崩溃才发现得了。
// 不用 act 包裹、不用假定时器：渲染、懒加载与动画都按真实时间推进，最接近浏览器里 pnpm dev 的样子。
// 任何一处出错都会留下痕迹：页面错误边界的错误页、console.error（外层统一处理与错误边界都会写）、error 通知。

import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import App, { prepareApp } from "./App";
import { stubCanvas } from "./art/illustrations/test-canvas";
import { INSTANCE_TAB_LABEL, PAGE_LABEL, SETTINGS_SECTION_LABEL } from "./copy/flows";
import { DEVICE_DIALOG_COPY, OFFLINE_DIALOG_COPY, AUTHLIB_DIALOG_COPY } from "./copy/login";
import { UPDATE_COPY } from "./copy/updater";
import { FOOTER_COPY, STEP_COPY } from "./flows/onboarding/copy";
import { mockInvoke, resetMocks } from "./ipc/mock";
import { ACCOUNT_COPY, PAGE_ERROR_COPY, PALETTE_COPY, SIDEBAR_COPY } from "./copy/shell";
import { ACCOUNTS_COPY } from "./pages/accounts/copy";
import homeStyles from "./pages/home/home.module.css";
import { DETAIL_COPY, IMPORT_COPY, SEARCH_COPY } from "./pages/discover/copy";
import { SETTINGS_COPY } from "./pages/instance/copy";
import { ABOUT_COPY } from "./pages/settings/copy";
import { tierOf, type Tier } from "./shell/tier";
import { DEFAULT_APPEARANCE } from "./state/appearance";
import type { AppearanceMode } from "./domain/types";
import { INSTANCE_TABS, PAGE_IDS, SETTINGS_SECTIONS, type PageId } from "./state/route";
import { DEFAULT_UI_SHAPE, type UiShape } from "./state/ui-shape";
import { stubMatchMedia, stubResizeObserver } from "./test/dom";
import type { IpcRecorder } from "./test/fake-bridge";
import { resetRecorder } from "./test/launcher";

const ipc = vi.hoisted((): IpcRecorder => ({ calls: [], overrides: new Map() }));
vi.mock("./ipc/bridge", async (orig) => (await import("./test/fake-bridge")).fakeBridge(await orig(), ipc));

/** 页面模块第一次经 vite 转换要几百毫秒，留足余量。 */
const WAIT = { timeout: 15_000, interval: 25 };
/** 假后端里带 Fabric、有 Mod 与存档的实例。 */
const INSTANCE = "樱花生存";

/** 三档各取一个落在档内的窗口宽度。 */
const WIDTHS: readonly (readonly [Tier, number])[] = [
  ["compact", 1024],
  ["regular", 1280],
  ["wide", 1600],
];
const MODES: readonly AppearanceMode[] = ["day", "night"];
const MATRIX = WIDTHS.flatMap(([tier, width]) => MODES.map((mode) => ({ tier, width, mode })));

/** 关于页第三方许可弹窗读的清单（构建时生成，测试里没有产物）。 */
const LICENSES = {
  packages: [
    { ecosystem: "npm", name: "react", version: "19.1.0", license: "MIT" },
    { ecosystem: "cargo", name: "serde", version: "1.0.219", license: "MIT OR Apache-2.0" },
  ],
};

let root: Root | null = null;
let host: HTMLDivElement | null = null;
let layout: HTMLStyleElement | null = null;
let consoleError: MockInstance<typeof console.error>;
/** 已经确认渲染过的页面。 */
let visited: PageId[];
/** 这一轮的窗口宽度与外观。 */
let windowWidth = 1024;
let mode: AppearanceMode = "day";
/** 启动时读到的界面形状；冒烟各轮按没记过启动。 */
let uiShape: UiShape = DEFAULT_UI_SHAPE;

function mount(): void {
  // 测试不处理 CSS 模块。外壳与页面之间有一条靠样式成立的约定：内容区是纵向滚动容器（发现页据此找吸顶与预取的滚动根），
  // 这里按外壳样式表补上这一条
  layout = document.createElement("style");
  layout.textContent = "[data-sk-focus-fallback] { overflow-y: auto; }";
  document.head.append(layout);
  host = document.createElement("div");
  document.body.append(host);
  // jsdom 不排版，元素量出来都是 0 宽：尺寸分档量的是应用根元素（host 的直接子元素），只给它报这一轮的窗口宽度
  const measure = Element.prototype.getBoundingClientRect;
  const frame = host;
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
    if (this.parentElement !== frame) return measure.call(this);
    return { x: 0, y: 0, left: 0, top: 0, width: windowWidth, height: 860, right: windowWidth, bottom: 860, toJSON: () => ({}) } as DOMRect;
  });
  vi.stubGlobal("innerWidth", windowWidth);
  root = createRoot(host);
  // 花瓣画布依赖真实的 2D 上下文与帧循环，冒烟测试只关心页面能否渲染
  root.render(<App appearance={{ ...DEFAULT_APPEARANCE, mode, petals: false }} uiShape={uiShape} />);
}

/** 分档与明暗确实按这一轮的设定生效了，否则整轮测的不是想测的那一档。 */
function expectFrame(tier: Tier): void {
  expect(tierOf(windowWidth)).toBe(tier);
  expect(document.documentElement.getAttribute("data-sk-tier")).toBe(tier);
  expect(document.documentElement.getAttribute("data-sk-mode")).toBe(mode);
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

function press(key: string, init: KeyboardEventInit = {}): void {
  document.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init }));
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

/** 菜单里文字以 label 开头的那一项（菜单项里名称后面可能还跟着一行说明）。 */
async function menuItem(label: string): Promise<HTMLElement> {
  return vi.waitFor(() => {
    const item = [...document.querySelectorAll<HTMLElement>("[role='menu'] [role='menuitem']")].find((el) => el.textContent?.startsWith(label));
    if (item === undefined) throw new Error(`菜单里没有「${label}」`);
    return item;
  }, WAIT);
}

/** 账户胶囊菜单的「管理账户」。 */
async function openAccountsFromCapsule(): Promise<void> {
  const capsule = document.querySelector<HTMLButtonElement>("header button[aria-haspopup='menu']");
  if (capsule === null) throw new Error("标题栏没有账户胶囊");
  click(capsule);
  click(await menuItem(ACCOUNT_COPY.manage));
}

function dialogName(dialog: HTMLElement): string {
  const label = dialog.getAttribute("aria-label");
  if (label !== null) return label;
  const heading = dialog.querySelector("h2");
  return heading === null || heading.textContent === null ? "" : heading.textContent;
}

/** 等名字（无障碍名或标题）为 name 的弹窗出现，并确认它没有落进错误边界。 */
async function openedDialog(name: string): Promise<HTMLElement> {
  const dialog = await vi.waitFor(() => {
    const found = [...document.querySelectorAll<HTMLElement>("[role='dialog']")].find((d) => dialogName(d) === name);
    if (found === undefined) throw new Error(`弹窗「${name}」还没出现，现有：${[...document.querySelectorAll<HTMLElement>("[role='dialog']")].map(dialogName).join("、")}`);
    return found;
  }, WAIT);
  expect(dialog.textContent).not.toContain(PAGE_ERROR_COPY.title);
  return dialog;
}

async function noDialogs(): Promise<void> {
  await vi.waitFor(() => expect(document.querySelectorAll("[role='dialog']")).toHaveLength(0), WAIT);
}

/** 用 Esc 关掉最上层的弹窗，等它退场完。 */
async function escape(): Promise<void> {
  press("Escape");
  await noDialogs();
}

/**
 * 用 Ctrl+K 打开命令面板。由外层 AnimatePresence 条件渲染的流程弹窗（新建实例）关上时，弹窗节点随退场先移除，
 * Esc 栈里那一层要等外层退场收尾、流程组件卸载时才撤；这段间隔里外壳仍按「有浮层」忽略全局快捷键，
 * 而 noDialogs 的哪一次轮询落进这段间隔由真实时间决定。所以按到面板出现为止：面板没开才再按，开着时再按会把它关上。
 */
async function openPaletteByShortcut(): Promise<void> {
  await vi.waitFor(() => {
    if ([...document.querySelectorAll<HTMLElement>("[role='dialog']")].some((d) => dialogName(d) === PALETTE_COPY.label)) return;
    press("k", { ctrlKey: true });
    throw new Error("命令面板还没打开");
  }, WAIT);
  await openedDialog(PALETTE_COPY.label);
}

/** 设置行里的按钮：行标题之后的那个按钮。 */
function rowButton(title: string, label: string): HTMLButtonElement {
  const heading = [...content().querySelectorAll<HTMLElement>("*")].find((el) => el.children.length === 0 && el.textContent === title);
  if (heading === undefined) throw new Error(`找不到设置行「${title}」`);
  let row: HTMLElement | null = heading;
  while (row !== null && row.querySelector("button") === null) row = row.parentElement;
  if (row === null) throw new Error(`设置行「${title}」里没有按钮`);
  return buttonIn(row, label);
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

async function openSettingsSection(label: string): Promise<void> {
  const sections = content().querySelector("nav");
  if (sections === null) throw new Error("设置页没有分区导航");
  const item = [...sections.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent?.startsWith(label));
  if (item === undefined) throw new Error(`设置页没有「${label}」分区`);
  click(item);
  await vi.waitFor(() => expect(item.getAttribute("aria-current")).toBe("page"), WAIT);
  expect(content().textContent).not.toContain(PAGE_ERROR_COPY.title);
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
  // 远程缩略图走 fetch：测试不联网，取图失败按设计回落到代码绘制的图形（只记 warn）；第三方许可清单给一份
  vi.stubGlobal("fetch", (url: string) =>
    url.endsWith("third-party-licenses.json") ? Promise.resolve({ ok: true, status: 200, json: async () => LICENSES }) : Promise.reject(new TypeError("测试环境不联网")),
  );
  // 构建信息由 vite 注入，vitest 里没有；设置的关于分区要读它
  vi.stubGlobal("__PETALFALL_BUILD__", { version: "0.1.0", channel: "preview", builtAt: "2026-10-31T00:00:00.000Z" });
  HTMLElement.prototype.scrollTo = function scrollTo(this: HTMLElement) {
    this.scrollTop = 0;
  };
  Element.prototype.scrollIntoView = function scrollIntoView() {};
  consoleError = vi.spyOn(console, "error");
  visited = [];
  uiShape = DEFAULT_UI_SHAPE;
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
  vi.restoreAllMocks();
  document.documentElement.removeAttribute("data-sk-mode");
  document.documentElement.removeAttribute("data-sk-accent");
  document.documentElement.removeAttribute("data-sk-tier");
});

describe.each(MATRIX)("应用冒烟：$tier 档（$width px）· $mode", ({ tier, width, mode: appearance }) => {
  beforeEach(() => {
    windowWidth = width;
    mode = appearance;
  });

  it("七个页面都被外壳收集，只经界面操作就能逐页走到，每页都正常渲染", async () => {
    ipc.overrides.set("is_first_run", () => false);
    await prepareApp();
    mount();

    await expectPage("home", null);
    expectFrame(tier);

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
    for (const section of SETTINGS_SECTIONS) await openSettingsSection(SETTINGS_SECTION_LABEL[section]);

    // 回到主页：主页模块是启动前预载的，切回来同步渲染
    click(sidebarItem("home"));
    await expectPage("home", null);

    // 路由表里的每个页面都走到过：新增页面而忘了让外壳收集或给出入口，这里会少一项
    expect([...new Set(visited)].sort()).toEqual([...PAGE_IDS].sort());
    expectFrame(tier);
    expectNoFailures();
  }, 60_000);

  it("主要弹窗都能从界面打开、正常渲染并关上", async () => {
    ipc.overrides.set("is_first_run", () => false);
    // 末尾手动检查更新要从「检查更新」按钮起步；启动后 8 秒的自动检查一旦先跑完，更新卡已换成「查看更新」。
    // 走到关于分区要多久取决于机器忙不忙，所以这一轮关掉自动检查，只测手动这条路
    await mockInvoke("update_config", { checkUpdates: false });
    await prepareApp();
    mount();
    await expectPage("home", null);
    expectFrame(tier);

    // 新建实例：没填任何内容时底栏「取消」直接关闭，不弹放弃确认
    click(sidebarItem("create"));
    click(buttonIn(await openedDialog(SIDEBAR_COPY.create), "取消"));
    await noDialogs();

    await openPaletteByShortcut();
    await escape();

    click(sidebarItem("discover"));
    await expectPage("discover", null);
    click(buttonIn(content(), SEARCH_COPY.importButton));
    await openedDialog(IMPORT_COPY.title);
    await escape();
    // 资源详情：结果卡整卡可点，详情弹窗里写着工程名
    const card = await vi.waitFor(() => {
      const found = content().querySelector<HTMLElement>("[aria-label$='，查看详情']");
      if (found === null) throw new Error("发现页还没有结果卡");
      return found;
    }, WAIT);
    const label = card.getAttribute("aria-label");
    if (label === null) throw new Error("结果卡没有名字");
    click(card);
    const detail = await openedDialog(DETAIL_COPY.tabsLabel);
    await vi.waitFor(() => expect(detail.textContent).toContain(label.replace("，查看详情", "")), WAIT);
    await escape();

    await openAccountsFromCapsule();
    await expectPage("accounts", PAGE_LABEL.accounts);
    click(buttonIn(content(), ACCOUNTS_COPY.addOther));
    click(await menuItem(ACCOUNTS_COPY.menuOffline));
    await openedDialog(OFFLINE_DIALOG_COPY.title);
    await escape();
    click(buttonIn(content(), ACCOUNTS_COPY.addOther));
    click(await menuItem(ACCOUNTS_COPY.menuAuthlib));
    await vi.waitFor(() => {
      if (document.querySelector(`[role='dialog'] [aria-label='${AUTHLIB_DIALOG_COPY.stepsLabel}']`) === null) throw new Error("外置登录弹窗还没出现");
    }, WAIT);
    await escape();
    click(buttonIn(content(), ACCOUNTS_COPY.addMicrosoft));
    await openedDialog(DEVICE_DIALOG_COPY.title);
    // 设备码弹窗挂载即向后端要代码
    expect(ipc.calls.filter((c) => c.cmd === "microsoft_login")).toHaveLength(1);
    await escape();

    // 实例设置里的删除确认：取消，不删
    click(sidebarItem("library"));
    await expectPage("library", PAGE_LABEL.library);
    await vi.waitFor(() => buttonIn(content(), INSTANCE), WAIT);
    click(buttonIn(content(), INSTANCE));
    await expectPage("instance", INSTANCE);
    const settingsTab = [...content().querySelectorAll<HTMLButtonElement>("[role='tab']")].find((b) => b.textContent?.startsWith(INSTANCE_TAB_LABEL.settings));
    if (settingsTab === undefined) throw new Error("实例页没有设置分页");
    click(settingsTab);
    await vi.waitFor(() => rowButton(SETTINGS_COPY.deleteTitle, SETTINGS_COPY.deleteTitle), WAIT);
    click(rowButton(SETTINGS_COPY.deleteTitle, SETTINGS_COPY.deleteTitle));
    click(buttonIn(await openedDialog(`删除「${INSTANCE}」？`), "取消"));
    await noDialogs();
    expect(ipc.calls.filter((c) => c.cmd === "delete_instance")).toEqual([]);

    // 关于：第三方许可与启动器更新面板
    click(sidebarItem("settings"));
    await expectPage("settings", PAGE_LABEL.settings);
    await openSettingsSection(SETTINGS_SECTION_LABEL.about);
    click(rowButton(ABOUT_COPY.licenses, ABOUT_COPY.view));
    const licenses = await openedDialog(ABOUT_COPY.licenses);
    await vi.waitFor(() => expect(licenses.textContent).toContain("serde"), WAIT);
    await escape();
    // 更新卡在后端回了当前版本之前是骨架，没有按钮
    await vi.waitFor(() => buttonIn(content(), UPDATE_COPY.check), WAIT);
    click(buttonIn(content(), UPDATE_COPY.check));
    await vi.waitFor(() => buttonIn(content(), UPDATE_COPY.view), WAIT);
    click(buttonIn(content(), UPDATE_COPY.view));
    const panel = await vi.waitFor(() => {
      const found = document.querySelector<HTMLElement>("[role='dialog']");
      if (found === null) throw new Error("更新面板还没出现");
      return found;
    }, WAIT);
    expect(panel.textContent).not.toContain(PAGE_ERROR_COPY.title);
    await escape();

    expectFrame(tier);
    expectNoFailures();
  }, 60_000);

  it("首次启动：整窗是向导、没有侧栏；第二步「直接开始」收尾后，向导退场再换成主界面", async () => {
    // 不改写 is_first_run：假后端初始就是首次启动，complete_first_run 之后才变成 false
    await prepareApp();
    mount();
    await vi.waitFor(() => expect(document.body.textContent).toContain(STEP_COPY.gameDir.title), WAIT);
    expect(document.querySelector("[data-sidebar-item]")).toBeNull();
    expectFrame(tier);

    // 游戏目录预填了默认位置，第一步直接下一步
    await vi.waitFor(() => expect(buttonIn(document, FOOTER_COPY.next).disabled).toBe(false), WAIT);
    click(buttonIn(document, FOOTER_COPY.next));
    await vi.waitFor(() => expect(document.body.textContent).toContain(STEP_COPY.java.title), WAIT);
    click(buttonIn(document, FOOTER_COPY.startNow));

    await expectPage("home", null);
    expect(document.body.textContent).not.toContain(STEP_COPY.gameDir.title);
    expect(document.querySelector("[data-sidebar-item='home']")).not.toBeNull();
    // 只提交一次：离开第一步时写下默认游戏目录，收尾不再提交
    const finished = ipc.calls.filter((c) => c.cmd === "complete_first_run");
    expect(finished).toHaveLength(1);
    const { mockInvoke } = await import("./ipc/mock");
    const config = await mockInvoke<{ game_dir: string }>("get_config");
    expect(finished[0].args.gameDir).toBe(config.game_dir);
    expectFrame(tier);
    expectNoFailures();
  }, 60_000);
});

describe("启动时读到的界面形状", () => {
  it("经 App 交给页面：实例列表还在读时，主页的最近游玩按记下的张数占位", async () => {
    windowWidth = 1600;
    uiShape = { recentCards: 2, repairBanner: false };
    ipc.overrides.set("is_first_run", () => false);
    ipc.overrides.set("list_instances", () => new Promise(() => undefined));
    await prepareApp();
    mount();
    const skeletons = await vi.waitFor(() => {
      const grid = content().querySelector(`section[aria-labelledby="home-recent-title"] [aria-hidden="true"] > .${homeStyles.recentGrid}`);
      if (grid === null) throw new Error("主页的最近游玩还没有骨架");
      return grid.children.length;
    }, WAIT);
    expect(skeletons).toBe(2);
  }, 60_000);
});
