// @vitest-environment jsdom
// @module-tag heavy-page
// 流程测试：真的 App 接假 bridge，从按钮一路走到 bridge 收到的调用。断言落在会造成实际损失的地方：
// 目录和模式传错、启动器被直接结束、中途关窗、降级。
// 不用 act 包裹：bridge 全是异步回调，按真实时间推进最接近实际，等待都用 vi.waitFor。

import { MotionGlobalConfig } from "framer-motion";
import { StrictMode, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { stubCanvas, stubPetalTokens } from "../art/petals/test-canvas";
import { APP_NAME } from "../lib/app-info";
import { stubMatchMedia, stubResizeObserver } from "../test/dom";
import App, { BLOCKED_POLL_MS, MIN_INSTALLING_MS, UPDATE_EXIT_CHECKS, UPDATE_EXIT_POLL_MS, UPDATE_EXIT_WAIT_MS } from "./App";
import type { DataBlock, Existing, ExistingKind, Failure, InstallPlan, Probe } from "./contract";
import { COPY } from "./copy";
import { FAKE_PROBE, createFakeBridge, judgedProbe, type FakeBridge, type FakeScenario } from "./fake-bridge";
import { replay, type SetupEvent, type SetupState } from "./model";

const copy = COPY.zh;
const WAIT = { timeout: 5000, interval: 10 };

const existingOf = (kind: ExistingKind): Existing => ({ kind, version: "0.1.0", dir: "E:\\app", channel: "stable" });
const probeOf = (kind: ExistingKind | null, extra: Partial<Probe> = {}): Probe => judgedProbe({ ...FAKE_PROBE, existing: kind === null ? null : existingOf(kind), ...extra });
/** 已装预览版，安装包是更慢通道上更早的测试版：交互时是「换到」页，带开关的更新模式无人值守换过去。 */
const switchProbe = (extra: Partial<Probe> = {}): Probe =>
  judgedProbe({ ...FAKE_PROBE, payloadVersion: "1.0.0-beta.5", payloadChannel: "beta", existing: { kind: "switch", version: "1.1.0-dev.61", dir: "E:\\app", channel: "dev" }, ...extra });
/** 已装测试版，安装包是更快通道上更新的预览版：交互时是「换到」页，确认后按升级装。 */
const fasterProbe = (extra: Partial<Probe> = {}): Probe =>
  judgedProbe({ ...FAKE_PROBE, payloadVersion: "1.0.0-dev.60", payloadChannel: "dev", existing: { kind: "upgrade", version: "1.0.0-beta.3", dir: "E:\\app", channel: "beta" }, ...extra });
const FAILURE: Failure = { code: "verify_failed", detail: "uninstall.exe 不存在" };
const TOO_NEW: DataBlock = { problem: "too_new", path: "E:\\app\\data-format.json", recorded: 3, supported: 2, reason: null, writtenBy: "1.1.0-dev.61", writtenByChannel: "dev" };

const freshEvent = (fake: FakeBridge): SetupEvent => ({ type: "install_requested", mode: "fresh", running: false, check: fake.scenario.checkDir(FAKE_PROBE.defaultDir) });

let root: Root | null = null;
let host: HTMLElement | null = null;
let headingLog: MutationObserver | null = null;

function mount(ui: ReactElement): void {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  root.render(ui);
}

function start(overrides: Partial<FakeScenario> = {}, initial?: SetupState): FakeBridge {
  const fake = createFakeBridge(overrides);
  mount(<App bridge={fake} copy={copy} initial={initial} />);
  return fake;
}

const heading = () => document.querySelector("h1")?.textContent ?? null;

const buttonNamed = (name: string) => [...document.querySelectorAll("button")].find((b) => b.textContent === name || b.getAttribute("aria-label") === name);

function button(name: string): HTMLButtonElement {
  const found = buttonNamed(name);
  if (found === undefined) throw new Error(`没有名为 ${name} 的按钮，页面上有：${[...document.querySelectorAll("button")].map((b) => b.textContent).join("、")}`);
  return found;
}

const seeHeading = (text: string) => vi.waitFor(() => expect(heading()).toBe(text), WAIT);

/** 按出现顺序记下每个画出来过的标题：断言没有经过某一页。挂载之前调用。 */
function recordHeadings(): readonly string[] {
  const seen: string[] = [];
  headingLog = new MutationObserver(() => {
    const text = heading();
    if (text !== null && seen.at(-1) !== text) seen.push(text);
  });
  headingLog.observe(document.body, { childList: true, subtree: true, characterData: true });
  return seen;
}

beforeAll(() => {
  MotionGlobalConfig.skipAnimations = true;
});

afterAll(() => {
  MotionGlobalConfig.skipAnimations = false;
});

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
  stubCanvas();
  stubPetalTokens();
  stubResizeObserver();
  stubMatchMedia(false);
});

afterEach(() => {
  headingLog?.disconnect();
  headingLog = null;
  root?.unmount();
  host?.remove();
  root = null;
  host = null;
  vi.unstubAllGlobals();
  document.documentElement.removeAttribute("data-sk-reduced");
});

describe("启动", () => {
  it("没有现有安装时进欢迎页，只探测一次，首帧后通知显示窗口", async () => {
    const fake = start();
    await seeHeading(copy.welcome.title);
    await vi.waitFor(() => expect(fake.callsOf("windowReady")).toHaveLength(1), WAIT);
    expect(fake.callsOf("probe")).toHaveLength(1);
  });

  it("boot 期间什么都不画，也不通知显示窗口", async () => {
    let finish: (probe: Probe) => void = () => undefined;
    const fake = createFakeBridge();
    fake.probe = () => new Promise<Probe>((resolve) => (finish = resolve));
    mount(<App bridge={fake} copy={copy} />);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(heading()).toBeNull();
    expect(fake.callsOf("windowReady")).toHaveLength(0);
    finish(FAKE_PROBE);
    await seeHeading(copy.welcome.title);
  });

  it("现有安装进已安装页", async () => {
    start({ probe: probeOf("same") });
    await seeHeading(copy.installed.kind.same.title("0.1.0"));
  });

  it("探测被拒绝时进致命错误页并照常显示窗口", async () => {
    const fake = createFakeBridge();
    fake.probe = () => Promise.reject(new Error("IPC 断了"));
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    mount(<App bridge={fake} copy={copy} />);
    await seeHeading(copy.fatal.title);
    expect(document.querySelector("pre")?.textContent).toContain("IPC 断了");
    await vi.waitFor(() => expect(fake.callsOf("windowReady")).toHaveLength(1), WAIT);
  });

  it("视图渲染时抛错也进致命错误页并显示窗口，不留一个没有任何按钮的空白窗口", async () => {
    const fake = createFakeBridge();
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const broken: typeof copy = {
      ...copy,
      get welcome(): typeof copy.welcome {
        throw new Error("欢迎页渲染炸了");
      },
    };
    mount(<App bridge={fake} copy={broken} />);
    await seeHeading(copy.fatal.title);
    expect(document.querySelector("pre")?.textContent).toContain("欢迎页渲染炸了");
    expect(buttonNamed(copy.fatal.close)).toBeDefined();
    expect(buttonNamed(copy.frame.close)).toBeDefined();
    await vi.waitFor(() => expect(fake.callsOf("windowReady")).toHaveLength(1), WAIT);
    expect(fake.callsOf("probe")).toHaveLength(1);
    expect(consoleError).toHaveBeenCalledWith("引导程序渲染出错", expect.any(Error));
  });

  it("状态缺值的渲染断言也进致命错误页，并且不会带着残缺状态发起安装", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const fake = createFakeBridge();
    const noPlan = replay([{ type: "probed", probe: FAKE_PROBE }]);
    mount(<App bridge={fake} copy={copy} initial={{ ...noPlan, view: "installing", plan: null, run: 1 }} />);
    await seeHeading(copy.fatal.title);
    expect(document.querySelector("pre")?.textContent).toContain("视图 installing 缺少安装计划");
    expect(fake.callsOf("install")).toHaveLength(0);
  });

  it("StrictMode 下探测和安装也只各调一次", async () => {
    const fake = createFakeBridge({ outcome: "hang", progress: [] });
    mount(
      <StrictMode>
        <App bridge={fake} copy={copy} />
      </StrictMode>,
    );
    await seeHeading(copy.welcome.title);
    button(copy.welcome.install).click();
    await seeHeading(copy.installing.title.fresh("0.2.0"));
    await vi.waitFor(() => expect(fake.callsOf("install")).toHaveLength(1), WAIT);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(fake.callsOf("probe")).toHaveLength(1);
    expect(fake.callsOf("install")).toHaveLength(1);
  });
});

describe("右键菜单", () => {
  const rightClick = (target: Element) => {
    const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
    target.dispatchEvent(event);
    return event.defaultPrevented;
  };

  it("空白处拦下带刷新和打印的默认菜单，路径框留着复制粘贴", async () => {
    start();
    await seeHeading(copy.welcome.title);
    expect(rightClick(document.querySelector("h1")!)).toBe(true);
    const field = document.body.appendChild(document.createElement("input"));
    expect(rightClick(field)).toBe(false);
    field.remove();
  });
});

describe("发起安装", () => {
  it("首装的计划带校验规整后的目录，装完到完成页", async () => {
    const fake = start({ checkDir: (path) => ({ normalized: `${path}-规整`, issue: null, hasConfig: false, notEmpty: false, appended: false, freeBytes: 1, dataBlock: null }) });
    await seeHeading(copy.welcome.title);
    button(copy.welcome.install).click();
    await seeHeading(copy.done.title.fresh(""));
    expect(fake.callsOf("checkDir")).toEqual([[FAKE_PROBE.defaultDir]]);
    expect(fake.callsOf("install")).toEqual([[{ mode: "fresh", dir: `${FAKE_PROBE.defaultDir}-规整`, desktopShortcut: true }]]);
  });

  it("升级不带目录，也不校验目录", async () => {
    const fake = start({ probe: probeOf("upgrade"), outcome: "hang", progress: [] });
    await seeHeading(copy.installed.kind.upgrade.title("0.1.0"));
    button(copy.installed.update).click();
    await seeHeading(copy.installing.title.upgrade("0.2.0"));
    await vi.waitFor(() => expect(fake.callsOf("install")).toEqual([[{ mode: "upgrade", dir: null, desktopShortcut: false }]]), WAIT);
    expect(fake.callsOf("checkDir")).toEqual([]);
  });

  it("同版本的重新安装走修复，不带目录", async () => {
    const fake = start({ probe: probeOf("same"), outcome: "hang", progress: [] });
    await seeHeading(copy.installed.kind.same.title("0.1.0"));
    button(copy.installed.reinstall).click();
    await seeHeading(copy.installing.title.repair(""));
    await vi.waitFor(() => expect(fake.callsOf("install")).toEqual([[{ mode: "repair", dir: null, desktopShortcut: false }]]), WAIT);
  });

  it("目录没过校验时退回选目录页，不调 install", async () => {
    const fake = start({ checkDir: (path) => ({ normalized: path, issue: "unwritable", hasConfig: false, notEmpty: false, appended: false, freeBytes: 0, dataBlock: null }) });
    await seeHeading(copy.welcome.title);
    button(copy.welcome.install).click();
    await seeHeading(copy.location.title);
    expect(fake.callsOf("install")).toEqual([]);
  });

  it("连点两次只发起一次", async () => {
    const fake = start({ outcome: "hang", progress: [] });
    await seeHeading(copy.welcome.title);
    const install = button(copy.welcome.install);
    install.click();
    install.click();
    await seeHeading(copy.installing.title.fresh(""));
    await vi.waitFor(() => expect(fake.callsOf("install")).toHaveLength(1), WAIT);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(fake.callsOf("checkDir")).toHaveLength(1);
    expect(fake.callsOf("install")).toHaveLength(1);
  });

  it("「换到」更慢通道的确认按换通道计划装回登记目录，安装中与完成页都说换到", async () => {
    const fake = start({ probe: switchProbe(), progress: [] });
    await seeHeading(copy.installed.kind.switch.title("测试版"));
    button(copy.installed.switchTo("测试版")).click();
    await seeHeading("正在换到测试版 1.0.0-beta.5");
    await seeHeading("已换到测试版 1.0.0-beta.5");
    expect(fake.callsOf("install")).toEqual([[{ mode: "switch", dir: null, desktopShortcut: false }]]);
    expect(fake.callsOf("checkDir")).toEqual([]);
    // 交互确认的那次停在完成页，由用户自己点打开
    expect(fake.callsOf("openLauncher")).toEqual([]);
  });

  it("「换到」更快通道的确认按升级计划发起，标题照样说换到", async () => {
    const fake = start({ probe: fasterProbe(), outcome: "hang", progress: [] });
    await seeHeading(copy.installed.kind.switch.title("预览版"));
    button(copy.installed.switchTo("预览版")).click();
    await seeHeading("正在换到预览版 1.0.0-dev.60");
    await vi.waitFor(() => expect(fake.callsOf("install")).toEqual([[{ mode: "upgrade", dir: null, desktopShortcut: false }]]), WAIT);
  });

  it("已安装更新版本时没有任何安装按钮", async () => {
    start({ probe: probeOf("newer") });
    await seeHeading(copy.installed.kind.newer.title("0.1.0"));
    expect(buttonNamed(copy.installed.update)).toBeUndefined();
    expect(buttonNamed(copy.installed.reinstall)).toBeUndefined();
    expect(buttonNamed(copy.installed.open)).toBeDefined();
  });
});

describe("启动器还开着", () => {
  it("不调 install，进程消失后自动继续，只调一次", async () => {
    const fake = start({ running: true, outcome: "hang", progress: [] });
    await seeHeading(copy.welcome.title);
    button(copy.welcome.install).click();
    await seeHeading(copy.blocked.title);
    expect(fake.callsOf("install")).toEqual([]);

    fake.scenario.running = false;
    await vi.waitFor(() => expect(heading()).toBe(copy.installing.title.fresh("")), { timeout: BLOCKED_POLL_MS * 3, interval: 10 });
    await vi.waitFor(() => expect(fake.callsOf("install")).toHaveLength(1), WAIT);
  });

  it("进程还在时轮询不放行", async () => {
    const fake = start({ running: true });
    await seeHeading(copy.welcome.title);
    button(copy.welcome.install).click();
    await seeHeading(copy.blocked.title);
    const before = fake.callsOf("launcherRunning").length;
    await vi.waitFor(() => expect(fake.callsOf("launcherRunning").length).toBeGreaterThan(before), { timeout: BLOCKED_POLL_MS * 3, interval: 10 });
    expect(heading()).toBe(copy.blocked.title);
    expect(fake.callsOf("install")).toEqual([]);
  });

  it("重新检查立刻查一次", async () => {
    const fake = start({ running: true, outcome: "hang", progress: [] });
    await seeHeading(copy.welcome.title);
    button(copy.welcome.install).click();
    await seeHeading(copy.blocked.title);
    fake.scenario.running = false;
    button(copy.blocked.checkAgain).click();
    await vi.waitFor(() => expect(heading()).toBe(copy.installing.title.fresh("")), { timeout: BLOCKED_POLL_MS / 2, interval: 5 });
  });

  it("返回后停止轮询", async () => {
    const fake = start({ running: true });
    await seeHeading(copy.welcome.title);
    button(copy.welcome.install).click();
    await seeHeading(copy.blocked.title);
    button(copy.blocked.back).click();
    await seeHeading(copy.welcome.title);
    const before = fake.callsOf("launcherRunning").length;
    await new Promise((resolve) => setTimeout(resolve, BLOCKED_POLL_MS * 1.5));
    expect(fake.callsOf("launcherRunning")).toHaveLength(before);
  });
});

describe("安装中", () => {
  it("系统关闭请求被拦，关闭键点了也没用，协议入口不可用", async () => {
    const fake = start({ outcome: "hang", progress: [] });
    await seeHeading(copy.welcome.title);
    expect(fake.requestClose()).toBe(true);

    button(copy.welcome.install).click();
    await seeHeading(copy.installing.title.fresh(""));
    expect(fake.requestClose()).toBe(false);

    const close = button(copy.frame.close);
    expect(close.getAttribute("aria-disabled")).toBe("true");
    close.click();
    expect(fake.callsOf("close")).toEqual([]);
    expect(button(copy.frame.legalLink).disabled).toBe(true);
  });

  it("最小化照常可用", async () => {
    const fake = start({ outcome: "hang", progress: [] });
    await seeHeading(copy.welcome.title);
    button(copy.welcome.install).click();
    await seeHeading(copy.installing.title.fresh(""));
    button(copy.frame.minimize).click();
    expect(fake.callsOf("minimize")).toHaveLength(1);
  });

  it("进度事件送到视图", async () => {
    start({ outcome: "hang", progress: [{ phase: "verify", percent: 90, slow: false }] });
    await seeHeading(copy.welcome.title);
    button(copy.welcome.install).click();
    await vi.waitFor(() => expect(document.querySelector("main")?.textContent).toContain(copy.installing.phase.verify), WAIT);
  });

  it("再快也至少展示规定时长", async () => {
    const fake = start({ progress: [] });
    await seeHeading(copy.welcome.title);
    button(copy.welcome.install).click();
    await vi.waitFor(() => expect(fake.callsOf("install")).toHaveLength(1), WAIT);
    const startedAt = performance.now();
    await seeHeading(copy.done.title.fresh(""));
    // 定时器精度留 50 ms 余量
    expect(performance.now() - startedAt).toBeGreaterThanOrEqual(MIN_INSTALLING_MS - 50);
    expect(fake.requestClose()).toBe(true);
  });

  it("退出码 0 但核验不过时进失败页", async () => {
    start({ outcome: FAILURE, progress: [] });
    await seeHeading(copy.welcome.title);
    button(copy.welcome.install).click();
    await seeHeading(copy.failed.reason.verify_failed.title);
    expect(buttonNamed(copy.failed.retry)).toBeDefined();
  });

  it("不是 Failure 的拒绝进致命错误页，不当安装失败显示", async () => {
    const fake = createFakeBridge({ progress: [] });
    fake.install = () => Promise.reject(new Error("IPC 断了"));
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    mount(<App bridge={fake} copy={copy} initial={replay([{ type: "probed", probe: FAKE_PROBE }, freshEvent(fake)])} />);
    await seeHeading(copy.fatal.title);
  });
});

describe("失败之后", () => {
  const failedAt = (fake: FakeBridge, failure: Failure) => replay([{ type: "probed", probe: fake.scenario.probe }, freshEvent(fake), { type: "install_failed", failure }]);

  it("重试再调一次 install，计划不变", async () => {
    const fake = createFakeBridge({ outcome: "hang", progress: [] });
    const initial = failedAt(fake, { code: "payload_exit", detail: "2" });
    mount(<App bridge={fake} copy={copy} initial={initial} />);
    await seeHeading(copy.failed.reason.payload_exit.title);
    button(copy.failed.retry).click();
    await seeHeading(copy.installing.title.fresh(""));
    await vi.waitFor(() => expect(fake.callsOf("install")).toEqual([[initial.plan]]), WAIT);
  });

  it("重试前启动器又开了时停在 blocked", async () => {
    const fake = createFakeBridge({ running: true });
    mount(<App bridge={fake} copy={copy} initial={failedAt(fake, { code: "payload_exit", detail: "2" })} />);
    await seeHeading(copy.failed.reason.payload_exit.title);
    button(copy.failed.retry).click();
    await seeHeading(copy.blocked.title);
    expect(fake.callsOf("install")).toEqual([]);
  });

  it("写不进时主按钮换位置，进选目录页", async () => {
    const fake = createFakeBridge();
    mount(<App bridge={fake} copy={copy} initial={failedAt(fake, { code: "dir_unwritable", detail: "os error 5" })} />);
    await seeHeading(copy.failed.reason.dir_unwritable.title);
    button(copy.failed.changeLocation).click();
    await seeHeading(copy.location.title);
  });
});

describe("打开启动器", () => {
  const doneState = (fake: FakeBridge) => replay([{ type: "probed", probe: fake.scenario.probe }, freshEvent(fake), { type: "install_succeeded" }]);

  it("打开的是装好的目录，启动器起来后才关窗", async () => {
    const fake = createFakeBridge();
    let opened: () => void = () => undefined;
    fake.openLauncher = () => new Promise<void>((resolve) => (opened = resolve));
    mount(<App bridge={fake} copy={copy} initial={doneState(fake)} />);
    await seeHeading(copy.done.title.fresh(""));

    const open = button(copy.done.open);
    open.click();
    await vi.waitFor(() => expect(button(copy.done.open).getAttribute("aria-busy")).toBe("true"), WAIT);
    expect(fake.callsOf("close")).toEqual([]);

    opened();
    await vi.waitFor(() => expect(fake.callsOf("close")).toEqual([[true]]), WAIT);
  });

  it("带上首装目录", async () => {
    const fake = createFakeBridge();
    const spy = vi.spyOn(fake, "openLauncher");
    mount(<App bridge={fake} copy={copy} initial={doneState(fake)} />);
    await seeHeading(copy.done.title.fresh(""));
    button(copy.done.open).click();
    expect(spy).toHaveBeenCalledWith(FAKE_PROBE.defaultDir);
  });

  it("已安装页打开的是探测到的目录", async () => {
    const fake = start({ probe: probeOf("same") });
    await seeHeading(copy.installed.kind.same.title("0.1.0"));
    button(copy.installed.open).click();
    await vi.waitFor(() => expect(fake.callsOf("openLauncher")).toEqual([["E:\\app"]]), WAIT);
  });

  it("提权运行时完成页不提供打开", async () => {
    const fake = createFakeBridge({ probe: probeOf(null, { elevated: true }) });
    mount(<App bridge={fake} copy={copy} initial={doneState(fake)} />);
    await seeHeading(copy.done.title.fresh(""));
    expect(buttonNamed(copy.done.open)).toBeUndefined();
    expect(document.querySelector("main")?.textContent).toContain(copy.done.elevated);
  });
});

describe("更新模式", () => {
  const updateProbe = (extra: Partial<Probe> = {}) => probeOf("upgrade", { update: { relaunch: true }, ...extra });
  const UPGRADE_PLAN: InstallPlan = { mode: "upgrade", dir: null, desktopShortcut: false };
  const upgrading = copy.installing.title.upgrade("0.2.0");
  const upgraded = copy.done.title.upgrade("0.2.0");
  /** 晚到的自动动作有没有发生：等过这么久还没有就是没有。 */
  const settle = () => new Promise((resolve) => setTimeout(resolve, 50));

  it("不经欢迎页和已安装页直接升级，装回登记目录，不校验目录", async () => {
    const seen = recordHeadings();
    const fake = start({ probe: updateProbe(), outcome: "hang", progress: [] });
    await seeHeading(upgrading);
    await vi.waitFor(() => expect(fake.callsOf("install")).toEqual([[UPGRADE_PLAN]]), WAIT);
    expect(seen).toEqual([upgrading]);
    expect(fake.callsOf("checkDir")).toEqual([]);
    await vi.waitFor(() => expect(fake.callsOf("windowReady")).toHaveLength(1), WAIT);
  });

  it("启动器几轮之后退出：一退出就开始安装，不经过「请先关闭」页", async () => {
    const seen = recordHeadings();
    const fake = createFakeBridge({ probe: updateProbe(), outcome: "hang", progress: [] });
    let checks = 0;
    fake.launcherRunning = async () => {
      checks += 1;
      return checks < 3;
    };
    mount(<App bridge={fake} copy={copy} />);
    await seeHeading(upgrading);
    await vi.waitFor(() => expect(fake.callsOf("install")).toEqual([[UPGRADE_PLAN]]), WAIT);
    expect(checks).toBe(3);
    expect(seen).toEqual([upgrading]);
  });

  it("启动器一直不退出：等待期间窗口已显示着升级页，等满时长才进「请先关闭」页，关掉后自动继续升级", async () => {
    const fake = start({ probe: updateProbe(), running: true, outcome: "hang", progress: [] });
    const startedAt = performance.now();
    await vi.waitFor(() => expect(fake.callsOf("launcherRunning").length).toBeGreaterThanOrEqual(3), WAIT);
    expect(heading()).toBe(upgrading);
    expect(fake.callsOf("windowReady")).toHaveLength(1);

    await vi.waitFor(() => expect(heading()).toBe(copy.blocked.title), { timeout: UPDATE_EXIT_WAIT_MS * 2, interval: 10 });
    // 定时器精度留 50 ms 余量
    expect(performance.now() - startedAt).toBeGreaterThanOrEqual(UPDATE_EXIT_WAIT_MS - 50);
    // 开头一次，之后每个间隔一次，次数封顶
    expect(UPDATE_EXIT_CHECKS).toBe(UPDATE_EXIT_WAIT_MS / UPDATE_EXIT_POLL_MS + 1);
    expect(fake.callsOf("launcherRunning").length).toBeLessThanOrEqual(UPDATE_EXIT_CHECKS);
    expect(fake.callsOf("install")).toEqual([]);
    await vi.waitFor(() => expect(fake.callsOf("windowReady")).toHaveLength(1), WAIT);

    fake.scenario.running = false;
    await vi.waitFor(() => expect(heading()).toBe(upgrading), { timeout: BLOCKED_POLL_MS * 3, interval: 10 });
    await vi.waitFor(() => expect(fake.callsOf("install")).toEqual([[UPGRADE_PLAN]]), WAIT);
  });

  it("定时器每次都早到时，等启动器退出也只查封顶的次数，不在截止前接连补查", async () => {
    // Linux 上 Node 的定时器按毫秒取整、按缓存的循环时钟起算，常常比 performance.now() 早到。这里放大成每次早到 20 ms：
    // 只看剩余时间的循环会在截止前接连短等、多查好几次
    const EARLY_MS = 20;
    const realSetTimeout = window.setTimeout.bind(window);
    const early = vi
      .spyOn(window, "setTimeout")
      .mockImplementation(((handler: TimerHandler, timeout?: number, ...rest: unknown[]) =>
        realSetTimeout(handler, Math.max(0, (timeout ?? 0) - EARLY_MS), ...rest)) as typeof window.setTimeout);
    try {
      const fake = start({ probe: updateProbe(), running: true, outcome: "hang", progress: [] });
      await vi.waitFor(() => expect(heading()).toBe(copy.blocked.title), { timeout: UPDATE_EXIT_WAIT_MS * 2, interval: 10 });
      expect(fake.callsOf("launcherRunning").length).toBeLessThanOrEqual(UPDATE_EXIT_CHECKS);
      expect(fake.callsOf("install")).toEqual([]);
    } finally {
      early.mockRestore();
    }
  });

  it("「请先关闭」页返回落在已安装页", async () => {
    const fake = createFakeBridge({ probe: updateProbe(), running: true });
    mount(<App bridge={fake} copy={copy} initial={replay([{ type: "probed", probe: fake.scenario.probe }, { type: "update_started", running: true }])} />);
    await seeHeading(copy.blocked.title);
    button(copy.blocked.back).click();
    await seeHeading(copy.installed.kind.upgrade.title("0.1.0"));
    expect(fake.callsOf("install")).toEqual([]);
  });

  it("装完自动打开恰好一次，打开的是登记目录，启动器起来后关掉自己；StrictMode 下也只等一轮、装一次", async () => {
    const fake = createFakeBridge({ probe: updateProbe(), progress: [] });
    mount(
      <StrictMode>
        <App bridge={fake} copy={copy} />
      </StrictMode>,
    );
    await seeHeading(upgraded);
    await vi.waitFor(() => expect(fake.callsOf("close")).toEqual([[true]]), WAIT);
    expect(fake.callsOf("openLauncher")).toEqual([["E:\\app"]]);
    // 假桥的打开与关窗都是立即兑现的微任务，React 的重渲染排在它们后面，忙碌态要等它画出来
    await vi.waitFor(() => expect(button(copy.done.open).getAttribute("aria-busy")).toBe("true"), WAIT);
    await settle();
    expect(fake.callsOf("openLauncher")).toHaveLength(1);
    expect(fake.callsOf("launcherRunning")).toHaveLength(1);
    expect(fake.callsOf("install")).toEqual([[UPGRADE_PLAN]]);
  });

  it("StrictMode 下一挂载就在完成页时也只自动打开一次", async () => {
    const fake = createFakeBridge({ probe: updateProbe() });
    const initial = replay([{ type: "probed", probe: fake.scenario.probe }, { type: "update_started", running: false }, { type: "install_succeeded" }]);
    mount(
      <StrictMode>
        <App bridge={fake} copy={copy} initial={initial} />
      </StrictMode>,
    );
    await seeHeading(upgraded);
    await vi.waitFor(() => expect(fake.callsOf("openLauncher")).toEqual([["E:\\app"]]), WAIT);
    await settle();
    expect(fake.callsOf("openLauncher")).toHaveLength(1);
  });

  it("提权运行时装完不自动打开，停在完成页提示从开始菜单打开", async () => {
    const fake = start({ probe: updateProbe({ elevated: true }), progress: [] });
    await seeHeading(upgraded);
    await settle();
    expect(fake.callsOf("openLauncher")).toEqual([]);
    expect(fake.callsOf("close")).toEqual([]);
    expect(buttonNamed(copy.done.open)).toBeUndefined();
    expect(document.querySelector("main")?.textContent).toContain(copy.done.elevated);
  });

  it("没带 /R 时装完停在完成页，用户点了才打开", async () => {
    const fake = start({ probe: updateProbe({ update: { relaunch: false } }), progress: [] });
    await seeHeading(upgraded);
    await settle();
    expect(fake.callsOf("openLauncher")).toEqual([]);
    expect(fake.callsOf("close")).toEqual([]);
    button(copy.done.open).click();
    await vi.waitFor(() => expect(fake.callsOf("openLauncher")).toEqual([["E:\\app"]]), WAIT);
  });

  it("失败后重试仍按升级再装一遍，成功后照样自动打开", async () => {
    const fake = start({ probe: updateProbe(), outcome: FAILURE, progress: [] });
    await seeHeading(copy.failed.reason.verify_failed.title);
    expect(fake.callsOf("install")).toEqual([[UPGRADE_PLAN]]);
    expect(fake.callsOf("openLauncher")).toEqual([]);

    fake.scenario.outcome = "ok";
    button(copy.failed.retry).click();
    await seeHeading(upgraded);
    expect(fake.callsOf("install")).toEqual([[UPGRADE_PLAN], [UPGRADE_PLAN]]);
    await vi.waitFor(() => expect(fake.callsOf("openLauncher")).toEqual([["E:\\app"]]), WAIT);
  });

  it("失败页返回落在已安装页", async () => {
    start({ probe: updateProbe(), outcome: FAILURE, progress: [] });
    await seeHeading(copy.failed.reason.verify_failed.title);
    button(copy.failed.back).click();
    await seeHeading(copy.installed.kind.upgrade.title("0.1.0"));
  });

  it("现有安装不能升级时按交互流程走：不等启动器退出、不自动安装", async () => {
    const fake = start({ probe: probeOf("same", { update: { relaunch: true } }) });
    await seeHeading(copy.installed.kind.same.title("0.1.0"));
    await settle();
    expect(fake.callsOf("launcherRunning")).toEqual([]);
    expect(fake.callsOf("install")).toEqual([]);
  });

  describe("带换通道开关", () => {
    const SWITCH_PLAN: InstallPlan = { mode: "switch", dir: null, desktopShortcut: false };
    const switching = "正在换到测试版 1.0.0-beta.5";
    const switched = "已换到测试版 1.0.0-beta.5";

    it("不经已安装页直接换过去：准备页起标题就说换到，按换通道计划装回登记目录，装完重开", async () => {
      const seen = recordHeadings();
      const fake = start({ probe: switchProbe({ update: { relaunch: true } }), progress: [] });
      await seeHeading(switched);
      await vi.waitFor(() => expect(fake.callsOf("close")).toEqual([[true]]), WAIT);
      expect(fake.callsOf("openLauncher")).toEqual([["E:\\app"]]);
      expect(fake.callsOf("install")).toEqual([[SWITCH_PLAN]]);
      expect(fake.callsOf("checkDir")).toEqual([]);
      expect(seen).toEqual([switching, switched]);
    });

    it("等启动器退出时窗口已显示着换到的准备页，还没开始装", async () => {
      const fake = start({ probe: switchProbe({ update: { relaunch: true } }), running: true, outcome: "hang", progress: [] });
      await vi.waitFor(() => expect(fake.callsOf("launcherRunning").length).toBeGreaterThanOrEqual(2), WAIT);
      expect(heading()).toBe(switching);
      expect(fake.callsOf("install")).toEqual([]);
    });

    it("装失败时失败页补上怎么回到原来的通道，重试仍按换通道计划，成功后照样重开", async () => {
      const fake = start({ probe: switchProbe({ update: { relaunch: true } }), outcome: FAILURE, progress: [] });
      await seeHeading(copy.failed.reason.verify_failed.title);
      expect(document.querySelector('[role="alert"]')?.textContent).toBe(`${copy.failed.reason.verify_failed.body("", "retry")}想留在原来的通道，到${APP_NAME}的「设置 · 关于」把更新通道改回去。`);
      expect(buttonNamed(copy.failed.standardInstaller)).toBeUndefined();

      fake.scenario.outcome = "ok";
      button(copy.failed.retry).click();
      await seeHeading(switched);
      expect(fake.callsOf("install")).toEqual([[SWITCH_PLAN], [SWITCH_PLAN]]);
      await vi.waitFor(() => expect(fake.callsOf("openLauncher")).toEqual([["E:\\app"]]), WAIT);
    });
  });

  // 数据关拦下时允许的模式为空，带不带开关都不无人值守：停在已安装页说清楚，落樱是为这次更新关掉的，要能从这里重新打开
  it.each<[string, Probe, string]>([
    ["不带开关", probeOf("upgrade", { update: { relaunch: true }, dataBlock: TOO_NEW }), "0.2.0"],
    ["带开关", switchProbe({ update: { relaunch: true }, dataBlock: TOO_NEW }), "1.0.0-beta.5"],
  ])("数据被更新的版本用过时（%s）停在已安装页并带补句，不等启动器退出、不自动安装", async (_, probe, payload) => {
    const fake = start({ probe });
    await seeHeading(copy.installed.dataTooNew.title);
    expect(document.querySelector("header p")?.textContent).toBe(
      `这台电脑上的数据已经被预览版 1.1.0-dev.61 用过，这个安装包（${payload}）读不了，所以没有安装，${APP_NAME}的程序和数据都没有改动。要接着用这些数据，装预览版 1.1.0-dev.61 或更新的版本。${APP_NAME}刚才为更新关掉了，可以从这里重新打开。`,
    );
    expect([...document.querySelectorAll("footer button")].map((b) => b.textContent)).toEqual([copy.installed.open]);
    await settle();
    expect(fake.callsOf("launcherRunning")).toEqual([]);
    expect(fake.callsOf("install")).toEqual([]);

    button(copy.installed.open).click();
    await vi.waitFor(() => expect(fake.callsOf("openLauncher")).toEqual([["E:\\app"]]), WAIT);
  });

  it("查进程被拒绝时进致命错误页并照常显示窗口", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const fake = createFakeBridge({ probe: updateProbe() });
    fake.launcherRunning = () => Promise.reject(new Error("进程列表读不出来"));
    mount(<App bridge={fake} copy={copy} />);
    await seeHeading(copy.fatal.title);
    expect(document.querySelector("pre")?.textContent).toContain("进程列表读不出来");
    await vi.waitFor(() => expect(fake.callsOf("windowReady")).toHaveLength(1), WAIT);
    expect(fake.callsOf("install")).toEqual([]);
  });

});

describe("协议页", () => {
  it("从左栏进去，返回原处", async () => {
    start();
    await seeHeading(copy.welcome.title);
    button(copy.frame.legalLink).click();
    await seeHeading(copy.legal.title);
    button(copy.legal.back).click();
    await seeHeading(copy.welcome.title);
  });

  it("进去时经 bridge 读协议全文、附加条款、素材许可与第三方清单", async () => {
    const fake = start();
    await seeHeading(copy.welcome.title);
    expect(fake.calls.filter((call) => call.name.startsWith("load"))).toEqual([]);
    button(copy.frame.legalLink).click();
    await seeHeading(copy.legal.title);
    const loaded = () => [...new Set(fake.calls.map((call) => call.name).filter((name) => name.startsWith("load")))].sort();
    await vi.waitFor(() => expect(loaded()).toEqual(["loadAdditionalTerms", "loadAssetLicense", "loadLicenseText", "loadThirdParty"]), WAIT);
  });
});

describe("窗口", () => {
  it("关闭键走关闭请求", async () => {
    const fake = start();
    await seeHeading(copy.welcome.title);
    button(copy.frame.close).click();
    expect(fake.callsOf("close")).toEqual([[true]]);
  });

  it("换步时左栏常驻：花瓣画布、协议入口还是原来的元素，不随内容卸掉重建", async () => {
    start();
    await seeHeading(copy.welcome.title);
    const canvas = document.querySelector("aside canvas");
    const legal = button(copy.frame.legalLink);
    expect(canvas).not.toBeNull();

    button(copy.welcome.change).click();
    await seeHeading(copy.location.title);
    button(copy.frame.legalLink).click();
    await seeHeading(copy.legal.title);

    expect(document.querySelectorAll("aside")).toHaveLength(1);
    expect(document.querySelector("aside canvas")).toBe(canvas);
    expect(button(copy.frame.legalLink)).toBe(legal);
  });

  it("系统要求减少动画时写到 html 上", async () => {
    stubMatchMedia(true);
    start();
    await seeHeading(copy.welcome.title);
    expect(document.documentElement.hasAttribute("data-sk-reduced")).toBe(true);
  });

  it("左栏写载荷版本和协议，探测之前崩溃时只写协议", async () => {
    start();
    await seeHeading(copy.welcome.title);
    expect(document.querySelector("aside")?.textContent).toContain(copy.frame.versionLine("0.2.0"));
    root?.unmount();
    host?.remove();

    const crashed = replay([{ type: "crashed", detail: "x" }]);
    start({}, crashed);
    await seeHeading(copy.fatal.title);
    const side = document.querySelector("aside")?.textContent;
    expect(side).toContain(copy.frame.license);
    expect(side).not.toContain("0.2.0");
  });
});
