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
import type { Failure, FailureCode } from "../contract";
import { COPY, type SetupCopy } from "../copy";
import { createFakeBridge, FAKE_PROBE, type FakeBridge } from "../fake-bridge";
import { FrameChromeProvider, type FrameChrome } from "../Frame";
import { replay } from "../model";
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
  it.each<[FailureCode, string, string, string]>([
    ["dir_unwritable", "os error 5", "这个位置写不进去", "换一个你有权限的文件夹再试。"],
    ["disk_full", "os error 112", "这块盘空间不够", "腾出空间或换一块盘再试。"],
    ["extract_failed", "os error 225", "安装包没能解开", "杀毒软件可能拦下了它。放行后重试，或者重新下载一份。"],
    ["payload_exit", "2", "安装没有完成", "安装程序提前退出了，返回码 2。"],
    ["verify_failed", "uninstall.exe missing", "安装没有完成", "安装程序报告成功，但没有找到程序文件。"],
  ])("%s", (code, detail, title, body) => {
    view = render(failed({ failure: { code, detail } }));
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
  it("可以聚焦：拖动区里带 tabindex 才不会一按下就拖窗", () => {
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
});
