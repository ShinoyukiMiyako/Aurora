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
import { stubMatchMedia, stubResizeObserver } from "../test/dom";
import App, { BLOCKED_POLL_MS, MIN_INSTALLING_MS } from "./App";
import type { Existing, ExistingKind, Failure, Probe } from "./contract";
import { COPY } from "./copy";
import { FAKE_PROBE, createFakeBridge, type FakeBridge, type FakeScenario } from "./fake-bridge";
import { replay, type SetupEvent, type SetupState } from "./model";

const copy = COPY.zh;
const WAIT = { timeout: 5000, interval: 10 };

const existingOf = (kind: ExistingKind): Existing => ({ kind, version: "0.1.0", dir: "E:\\app" });
const probeOf = (kind: ExistingKind | null, extra: Partial<Probe> = {}): Probe => ({ ...FAKE_PROBE, existing: kind === null ? null : existingOf(kind), ...extra });
const FAILURE: Failure = { code: "verify_failed", detail: "uninstall.exe 不存在" };

const freshEvent = (fake: FakeBridge): SetupEvent => ({ type: "install_requested", mode: "fresh", running: false, check: fake.scenario.checkDir(FAKE_PROBE.defaultDir) });

let root: Root | null = null;
let host: HTMLElement | null = null;

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

describe("发起安装", () => {
  it("首装的计划带校验规整后的目录，装完到完成页", async () => {
    const fake = start({ checkDir: (path) => ({ normalized: `${path}-规整`, issue: null, hasConfig: false, notEmpty: false, freeBytes: 1 }) });
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
    await vi.waitFor(() => expect(fake.callsOf("install")).toEqual([[{ mode: "upgrade", dir: null, desktopShortcut: true }]]), WAIT);
    expect(fake.callsOf("checkDir")).toEqual([]);
  });

  it("同版本的重新安装走修复，不带目录", async () => {
    const fake = start({ probe: probeOf("same"), outcome: "hang", progress: [] });
    await seeHeading(copy.installed.kind.same.title("0.1.0"));
    button(copy.installed.reinstall).click();
    await seeHeading(copy.installing.title.repair(""));
    await vi.waitFor(() => expect(fake.callsOf("install")).toEqual([[{ mode: "repair", dir: null, desktopShortcut: true }]]), WAIT);
  });

  it("目录没过校验时退回选目录页，不调 install", async () => {
    const fake = start({ checkDir: (path) => ({ normalized: path, issue: "unwritable", hasConfig: false, notEmpty: false, freeBytes: 0 }) });
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

describe("协议页", () => {
  it("从左栏进去，返回原处", async () => {
    start();
    await seeHeading(copy.welcome.title);
    button(copy.frame.legalLink).click();
    await seeHeading(copy.legal.title);
    button(copy.legal.back).click();
    await seeHeading(copy.welcome.title);
  });
});

describe("窗口", () => {
  it("关闭键走关闭请求", async () => {
    const fake = start();
    await seeHeading(copy.welcome.title);
    button(copy.frame.close).click();
    expect(fake.callsOf("close")).toEqual([[true]]);
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
