// @vitest-environment jsdom
// @module-tag heavy-page
// 失败视图：五种原因说的都是对的，错误码能拿走，退路一条不少，标准安装程序只给走得通的两种。

import { MotionConfig } from "framer-motion";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stubCanvas, stubPetalTokens } from "../../art/petals/test-canvas";
import { ISSUES_URL } from "../../lib/app-info";
import { OverlayProvider, OverlayRoot } from "../../shell/overlay";
import { keydown, render, stubMatchMedia, stubResizeObserver, type Rendered } from "../../test/dom";
import App from "../App";
import type { Existing, Failure, FailureCode } from "../contract";
import { COPY, type SetupCopy } from "../copy";
import { createFakeBridge, FAKE_PROBE, type FakeBridge } from "../fake-bridge";
import { FrameChromeProvider, type FrameChrome } from "../Frame";
import { replay, type FailureRecovery } from "../model";
import { Failed, type FailedProps } from "./Failed";

const zh = COPY.zh;
const FAILURE: Failure = { code: "payload_exit", detail: "2" };

let view: Rendered | null = null;

function chromeOf(copy: SetupCopy): FrameChrome {
  return { copy: copy.frame, version: "0.2.0", canClose: true, canOpenLegal: true, reduced: false, onMinimize: () => undefined, onClose: () => undefined, onOpenLegal: () => undefined };
}

function failed(overrides: Partial<FailedProps> = {}) {
  const copy = overrides.copy ?? zh;
  const noop = () => undefined;
  return (
    <MotionConfig reducedMotion="always">
      <OverlayProvider>
        <FrameChromeProvider value={chromeOf(copy)}>
          <Failed copy={copy} failure={FAILURE} recovery="retry" standardInstaller={false} onRecover={noop} onOpenLog={noop} onReport={noop} onStandardInstaller={noop} onBack={noop} {...overrides} />
          <OverlayRoot />
        </FrameChromeProvider>
      </OverlayProvider>
    </MotionConfig>
  );
}

const heading = () => document.querySelector("h1")?.textContent;
const buttonNamed = (name: string) => [...document.querySelectorAll("button")].find((b) => b.textContent === name);

function button(name: string): HTMLButtonElement {
  const found = buttonNamed(name);
  if (found === undefined) throw new Error(`没有名为 ${name} 的按钮，页面上有：${[...document.querySelectorAll("button")].map((b) => b.textContent).join("、")}`);
  return found;
}

function errorCode(): HTMLElement {
  const found = document.querySelector<HTMLElement>("main code");
  if (found === null) throw new Error("没有错误码");
  return found;
}

beforeEach(() => {
  stubCanvas();
  stubPetalTokens();
  stubResizeObserver();
  stubMatchMedia(false);
});

afterEach(() => {
  view?.unmount();
  view = null;
  vi.unstubAllGlobals();
});

describe("原因", () => {
  it.each<[FailureCode, FailureRecovery, string, string, string]>([
    ["dir_unwritable", "change_location", "os error 5", "这个位置写不进去", "换一个你有权限的文件夹再试。"],
    ["dir_unwritable", "retry", "os error 5", "这个位置写不进去", "现有的安装位置不能换。确认你能写这个文件夹后再试。"],
    ["disk_full", "change_location", "os error 112", "这块盘空间不够", "腾出空间或换一块盘再试。"],
    ["disk_full", "retry", "os error 112", "这块盘空间不够", "现有的安装位置不能换。腾出空间后再试。"],
    ["extract_failed", "retry", "os error 225", "安装包没能解开", "杀毒软件可能拦下了它。放行后重试，或者重新下载一份。"],
    ["payload_exit", "retry", "2", "安装没有完成", "安装程序提前退出了，返回码 2。"],
    ["verify_failed", "retry", "uninstall.exe missing", "安装没有完成", "安装程序报告成功，但事后检查没有通过，下面是没过的项。"],
  ])("%s，退路 %s", (code, recovery, detail, title, body) => {
    view = render(failed({ failure: { code, detail }, recovery }));
    expect(heading()).toBe(title);
    expect(document.querySelector('[role="alert"]')?.textContent).toBe(body);
    expect(errorCode().textContent).toBe(`${code}: ${detail}`);
  });

  it("英文系统走英文表，返回码进句子", () => {
    view = render(failed({ copy: COPY.en, failure: { code: "payload_exit", detail: "1603" } }));
    expect(heading()).toBe("The install didn't finish");
    expect(document.querySelector('[role="alert"]')?.textContent).toBe("The installer quit early with code 1603.");
  });
});

describe("错误码", () => {
  it("落在内容区里：拖动区一按就拖窗，错误原文选不中", () => {
    view = render(failed());
    expect(errorCode().closest("[data-tauri-drag-region]")?.getAttribute("data-tauri-drag-region")).toBe("false");
  });

  it("键盘能聚焦", () => {
    view = render(failed());
    expect(errorCode().getAttribute("tabindex")).toBe("0");
  });

  it("聚焦时整段选中，直接能复制", () => {
    view = render(failed({ failure: { code: "verify_failed", detail: "DisplayVersion 0.1.0" } }));
    act(() => errorCode().focus());
    expect(window.getSelection()?.toString()).toBe("verify_failed: DisplayVersion 0.1.0");
  });
});

describe("按钮", () => {
  it("可重试时主按钮是重试，一进来就有焦点", () => {
    const onRecover = vi.fn();
    view = render(failed({ recovery: "retry", onRecover }));
    const primary = button(zh.failed.retry);
    expect(primary.dataset.variant).toBe("primary");
    expect(document.activeElement).toBe(primary);
    expect(buttonNamed(zh.failed.changeLocation)).toBeUndefined();
    act(() => primary.click());
    expect(onRecover).toHaveBeenCalledTimes(1);
  });

  it("要换位置时主按钮是换位置", () => {
    const onRecover = vi.fn();
    view = render(failed({ recovery: "change_location", onRecover }));
    expect(buttonNamed(zh.failed.retry)).toBeUndefined();
    const primary = button(zh.failed.changeLocation);
    expect(primary.dataset.variant).toBe("primary");
    act(() => primary.click());
    expect(onRecover).toHaveBeenCalledTimes(1);
  });

  it("打开日志是次按钮", () => {
    const onOpenLog = vi.fn();
    view = render(failed({ onOpenLog }));
    const log = button(zh.failed.openLog);
    expect(log.dataset.variant).toBe("secondary");
    act(() => log.click());
    expect(onOpenLog).toHaveBeenCalledTimes(1);
  });

  it("问题反馈是幽灵按钮", () => {
    const onReport = vi.fn();
    view = render(failed({ onReport }));
    const report = button(zh.failed.report);
    expect(report.dataset.variant).toBe("ghost");
    act(() => report.click());
    expect(onReport).toHaveBeenCalledTimes(1);
  });

  it("返回和 Esc 都回到发起安装的地方", () => {
    const onBack = vi.fn();
    view = render(failed({ onBack }));
    act(() => button(zh.failed.back).click());
    expect(onBack).toHaveBeenCalledTimes(1);
    keydown(document.body, "Escape");
    expect(onBack).toHaveBeenCalledTimes(2);
  });

  it("离开这一页后 Esc 不再触发返回", () => {
    const onBack = vi.fn();
    view = render(failed({ onBack }));
    view.rerender(
      <OverlayProvider>
        <span />
      </OverlayProvider>,
    );
    keydown(document.body, "Escape");
    expect(onBack).not.toHaveBeenCalled();
  });
});

describe("标准安装程序", () => {
  it("没放行时不显示", () => {
    view = render(failed({ standardInstaller: false }));
    expect(buttonNamed(zh.failed.standardInstaller)).toBeUndefined();
  });

  it("放行时是幽灵按钮", () => {
    const onStandardInstaller = vi.fn();
    view = render(failed({ standardInstaller: true, onStandardInstaller }));
    const standard = button(zh.failed.standardInstaller);
    expect(standard.dataset.variant).toBe("ghost");
    act(() => standard.click());
    expect(onStandardInstaller).toHaveBeenCalledTimes(1);
  });

  it("连点两下只起一个向导，点过之后转加载", () => {
    const onStandardInstaller = vi.fn();
    view = render(failed({ standardInstaller: true, onStandardInstaller }));
    const standard = button(zh.failed.standardInstaller);
    act(() => standard.click());
    act(() => standard.click());
    expect(onStandardInstaller).toHaveBeenCalledTimes(1);
    expect(button(zh.failed.standardInstaller).getAttribute("aria-busy")).toBe("true");
  });

  it("点过之后重试、返回和 Esc 都走不通，焦点还在原地", () => {
    const onRecover = vi.fn();
    const onBack = vi.fn();
    view = render(failed({ standardInstaller: true, onRecover, onBack }));
    const standard = button(zh.failed.standardInstaller);
    standard.focus();
    act(() => standard.click());
    act(() => button(zh.failed.retry).click());
    act(() => button(zh.failed.back).click());
    keydown(document.body, "Escape");
    expect(onRecover).not.toHaveBeenCalled();
    expect(onBack).not.toHaveBeenCalled();
    expect(button(zh.failed.retry).getAttribute("aria-disabled")).toBe("true");
    expect(button(zh.failed.back).getAttribute("aria-disabled")).toBe("true");
    expect(document.activeElement).toBe(standard);
  });

  it("点了重试之后标准安装程序、返回和 Esc 都走不通，重试转加载", () => {
    const onRecover = vi.fn();
    const onBack = vi.fn();
    const onStandardInstaller = vi.fn();
    view = render(failed({ standardInstaller: true, onRecover, onBack, onStandardInstaller }));
    act(() => button(zh.failed.retry).click());
    act(() => button(zh.failed.retry).click());
    act(() => button(zh.failed.standardInstaller).click());
    act(() => button(zh.failed.back).click());
    keydown(document.body, "Escape");
    expect(onRecover).toHaveBeenCalledTimes(1);
    expect(onStandardInstaller).not.toHaveBeenCalled();
    expect(onBack).not.toHaveBeenCalled();
    expect(button(zh.failed.retry).getAttribute("aria-busy")).toBe("true");
    expect(button(zh.failed.standardInstaller).getAttribute("aria-disabled")).toBe("true");
  });

  it("点过之后打开日志和问题反馈照常可用：它们不起安装", () => {
    const onOpenLog = vi.fn();
    const onReport = vi.fn();
    view = render(failed({ standardInstaller: true, onOpenLog, onReport }));
    act(() => button(zh.failed.standardInstaller).click());
    act(() => button(zh.failed.openLog).click());
    act(() => button(zh.failed.report).click());
    expect(onOpenLog).toHaveBeenCalledTimes(1);
    expect(onReport).toHaveBeenCalledTimes(1);
  });
});

describe("接上流程", () => {
  async function failedApp(failure: Failure): Promise<FakeBridge> {
    const fake = createFakeBridge({ outcome: "hang", progress: [] });
    const initial = replay([
      { type: "probed", probe: FAKE_PROBE },
      { type: "install_requested", mode: "fresh", running: false, check: fake.scenario.checkDir(FAKE_PROBE.defaultDir) },
      { type: "install_failed", failure },
    ]);
    view = render(<App bridge={fake} copy={zh} initial={initial} />);
    return fake;
  }

  it.each<[FailureCode, boolean]>([
    ["dir_unwritable", false],
    ["disk_full", false],
    ["extract_failed", false],
    ["payload_exit", true],
    ["verify_failed", true],
  ])("%s 给不给标准安装程序：%s", async (code, offered) => {
    await failedApp({ code, detail: "x" });
    expect(buttonNamed(zh.failed.standardInstaller) !== undefined).toBe(offered);
  });

  it("写不进和盘满的主按钮是换位置，其余是重试", async () => {
    await failedApp({ code: "disk_full", detail: "os error 112" });
    expect(buttonNamed(zh.failed.changeLocation)).toBeDefined();
    view?.unmount();
    await failedApp({ code: "extract_failed", detail: "os error 225" });
    expect(buttonNamed(zh.failed.retry)).toBeDefined();
  });

  it.each<[FailureCode, "upgrade" | "repair", string]>([
    ["dir_unwritable", "upgrade", zh.failed.reason.dir_unwritable.body("x", "retry")],
    ["disk_full", "repair", zh.failed.reason.disk_full.body("x", "retry")],
  ])("%s 发生在 %s 时位置是锁定的：只给重试，也不叫人换位置", (code, mode, body) => {
    const existing: Existing = { kind: mode === "upgrade" ? "upgrade" : "same", version: "0.1.0", dir: String.raw`E:\app` };
    const probe = { ...FAKE_PROBE, existing };
    const fake = createFakeBridge({ probe, outcome: "hang", progress: [] });
    const initial = replay([
      { type: "probed", probe },
      { type: "install_requested", mode, running: false },
      { type: "install_failed", failure: { code, detail: "x" } },
    ]);
    view = render(<App bridge={fake} copy={zh} initial={initial} />);
    expect(document.querySelector('[role="alert"]')?.textContent).toBe(body);
    expect(buttonNamed(zh.failed.retry)).toBeDefined();
    expect(buttonNamed(zh.failed.changeLocation)).toBeUndefined();
  });

  it("打开日志和问题反馈走到 bridge，反馈去 Issues", async () => {
    const fake = await failedApp(FAILURE);
    act(() => button(zh.failed.openLog).click());
    act(() => button(zh.failed.report).click());
    expect(fake.callsOf("openLog")).toHaveLength(1);
    expect(fake.callsOf("openExternal")).toEqual([[ISSUES_URL]]);
  });

  it("改用标准安装程序先起载荷，再关窗", async () => {
    const fake = await failedApp(FAILURE);
    await act(async () => {
      button(zh.failed.standardInstaller).click();
    });
    await vi.waitFor(() => expect(fake.callsOf("close")).toEqual([[true]]));
    expect(fake.calls.map((call) => call.name).filter((name) => name === "runStandardInstaller" || name === "close")).toEqual(["runStandardInstaller", "close"]);
  });

  it("标准安装程序还在起的时候点重试，不会再起一遍安装，窗口照常关掉", async () => {
    const fake = await failedApp(FAILURE);
    let started: () => void = () => {
      throw new Error("标准安装程序还没开始起");
    };
    vi.spyOn(fake, "runStandardInstaller").mockImplementation(() => new Promise((resolve) => (started = resolve)));
    act(() => button(zh.failed.standardInstaller).click());
    await act(async () => {
      button(zh.failed.retry).click();
    });
    keydown(document.body, "Escape");
    expect(fake.callsOf("launcherRunning")).toEqual([]);
    expect(fake.callsOf("install")).toEqual([]);
    expect(heading()).toBe(zh.failed.reason.payload_exit.title);
    await act(async () => started());
    await vi.waitFor(() => expect(fake.callsOf("close")).toEqual([[true]]));
  });

  it("重试还在查进程的时候点标准安装程序，不会两边都起", async () => {
    const fake = await failedApp(FAILURE);
    let answer: (running: boolean) => void = () => {
      throw new Error("还没开始查进程");
    };
    vi.spyOn(fake, "launcherRunning").mockImplementation(() => new Promise((resolve) => (answer = resolve)));
    await act(async () => {
      button(zh.failed.retry).click();
    });
    await act(async () => {
      button(zh.failed.standardInstaller).click();
    });
    expect(fake.callsOf("runStandardInstaller")).toEqual([]);
    await act(async () => answer(false));
    expect(fake.callsOf("install")).toHaveLength(1);
  });
});
