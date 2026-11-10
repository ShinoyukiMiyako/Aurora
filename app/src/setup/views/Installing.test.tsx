// @vitest-environment jsdom
// @module-tag heavy-page
// 安装中视图：进度和阶段照实显示，关窗的路都堵住且说得出原因，减少动画时进度条不缓动。

import { MotionConfig } from "framer-motion";
import { act, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stubCanvas, stubPetalTokens } from "../../art/petals/test-canvas";
import { OverlayProvider, OverlayRoot } from "../../shell/overlay";
import { focusByKeyboard, render, stubMatchMedia, stubResizeObserver, waitForFrames, type Rendered } from "../../test/dom";
import App from "../App";
import type { Channel, InstallMode, Progress } from "../contract";
import { COPY, type SetupCopy } from "../copy";
import { createFakeBridge, FAKE_PROBE } from "../fake-bridge";
import { FrameChromeProvider, type FrameChrome } from "../Frame";
import { InShell } from "./test-chrome";
import { replay } from "../model";
import { Installing, NO_PHASE_YET } from "./Installing";

const VERSION = "0.2.0";
const zh = COPY.zh;

let view: Rendered | null = null;

function chromeOf(copy: SetupCopy): FrameChrome {
  return { copy: copy.frame, version: VERSION, canClose: false, canOpenLegal: false, reduced: false, onMinimize: () => undefined, onClose: () => undefined, onOpenLegal: () => undefined };
}

function harness(copy: SetupCopy, reduced: "always" | "never", ui: ReactNode) {
  return (
    <MotionConfig reducedMotion={reduced}>
      <OverlayProvider>
        <FrameChromeProvider value={chromeOf(copy)}>
          <InShell>{ui}</InShell>
          <OverlayRoot />
        </FrameChromeProvider>
      </OverlayProvider>
    </MotionConfig>
  );
}

function installing(progress: Progress | null, options: { copy?: SetupCopy; mode?: InstallMode; switching?: Channel | null; run?: number; reduced?: "always" | "never" } = {}) {
  const { copy = zh, mode = "fresh", switching = null, run = 1, reduced = "never" } = options;
  return harness(copy, reduced, <Installing copy={copy} mode={mode} switching={switching} version={VERSION} run={run} progress={progress} />);
}

function bar(): HTMLElement {
  const found = document.querySelector<HTMLElement>('[role="progressbar"]');
  if (found === null) throw new Error("没有进度条");
  return found;
}

const fill = () => bar().firstElementChild as HTMLElement;

const fillOffset = () => Number.parseFloat(fill().style.transform.replace("translateX(", ""));

/** 按帧跟到 target，返回途中经过的位置，起点和终点不算：一步到位时为空。 */
async function pathTo(target: number): Promise<number[]> {
  const start = fillOffset();
  const seen: number[] = [];
  await waitForFrames(() => {
    const offset = fillOffset();
    if (offset !== start) seen.push(offset);
    expect(offset).toBeCloseTo(target, 3);
  });
  return seen.filter((offset) => Math.abs(offset - target) > 0.001);
}

function status(): HTMLElement {
  const found = document.querySelector<HTMLElement>('[role="status"]');
  if (found === null) throw new Error("没有状态区域");
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

describe("标题", () => {
  it.each(["fresh", "upgrade", "repair"] as const)("%s 用自己的文案", (mode) => {
    view = render(installing(null, { mode }));
    expect(document.querySelector("h1")?.textContent).toBe(zh.installing.title[mode](VERSION));
  });

  it("升级的标题带目标版本", () => {
    view = render(installing(null, { mode: "upgrade" }));
    expect(document.querySelector("h1")?.textContent).toBe("正在升级到 0.2.0");
  });

  it("换通道安装说换到哪个通道", () => {
    view = render(installing(null, { mode: "switch", switching: "beta" }));
    expect(document.querySelector("h1")?.textContent).toBe("正在换到测试版 0.2.0");
  });

  // 用户在「换到」页上确认的升级：计划是 upgrade，标题照样说换到
  it("确认换到更快通道的升级也说换到", () => {
    view = render(installing(null, { mode: "upgrade", switching: "dev" }));
    expect(document.querySelector("h1")?.textContent).toBe("正在换到预览版 0.2.0");
  });

  it("英文系统走英文表", () => {
    view = render(installing({ phase: "write", percent: 40, slow: true }, { copy: COPY.en, mode: "upgrade" }));
    expect(document.querySelector("h1")?.textContent).toBe("Updating to 0.2.0");
    expect(status().textContent).toContain("Writing files");
    expect(status().textContent).toContain("Antivirus");
  });
});

describe("进度条", () => {
  it("是定进度，百分比换算到 0 到 1，名称来自文案", () => {
    view = render(installing({ phase: "write", percent: 37, slow: false }));
    expect(bar().hasAttribute("data-indeterminate")).toBe(false);
    expect(bar().getAttribute("aria-valuenow")).toBe("37");
    expect(bar().getAttribute("aria-label")).toBe("安装进度");
    expect(fill().style.transform).toBe("translateX(-63%)");
  });

  it("第一个事件之前是空轨道，不转不定态", () => {
    view = render(installing(null));
    expect(bar().hasAttribute("data-indeterminate")).toBe(false);
    expect(bar().getAttribute("aria-valuenow")).toBe("0");
    expect(fill().style.transform).toBe("translateX(-100%)");
  });

  it("同一轮里不往回走", () => {
    view = render(installing({ phase: "write", percent: 60, slow: false }));
    view.rerender(installing({ phase: "write", percent: 30, slow: false }));
    expect(bar().getAttribute("aria-valuenow")).toBe("60");
  });

  // 跳变在 ProgressBar 的 layout effect 里发生，那时 useTransform 的订阅还没重建，位置要到下一次渲染才写进 DOM。
  // 真实流程里下一次渲染就是下一个进度事件，这里多渲染一遍代替它
  const settle = (ui: () => ReactNode) => {
    view?.rerender(ui());
    view?.rerender(ui());
  };

  it("重试换了一轮，从新值开始且不往回缓动", async () => {
    view = render(installing({ phase: "verify", percent: 90, slow: false }, { run: 1 }));
    // 挂载那一帧排着一次弹簧，先让它过去：真实的重试离上一轮挂载远不止一帧
    await waitForFrames(() => expect(fillOffset()).toBeCloseTo(-10, 3));
    settle(() => installing({ phase: "unpack", percent: 10, slow: false }, { run: 2 }));
    expect(bar().getAttribute("aria-valuenow")).toBe("10");
    expect(await pathTo(-90)).toEqual([]);
  });

  it("平时新进度缓动过去，途中经过中间位置", async () => {
    view = render(installing({ phase: "write", percent: 20, slow: false }));
    view.rerender(installing({ phase: "write", percent: 80, slow: false }));
    expect(bar().getAttribute("aria-valuenow")).toBe("80");
    expect((await pathTo(-20)).length).toBeGreaterThan(0);
  });

  it("减少动画时不缓动，直接到位", async () => {
    view = render(installing({ phase: "write", percent: 20, slow: false }, { reduced: "always" }));
    settle(() => installing({ phase: "write", percent: 80, slow: false }, { reduced: "always" }));
    expect(await pathTo(-20)).toEqual([]);
  });
});

describe("阶段文字", () => {
  it("事件到之前状态区域已经挂着，只是没有字", () => {
    view = render(installing(null));
    expect(status().textContent?.trim()).toBe("");
  });

  it("阶段行从一开始就占着一行：第一个事件到达时只换字，右边的关闭说明按同一条基线对齐，不跳", () => {
    view = render(installing(null));
    const line = status().firstElementChild;
    expect(line?.tagName).toBe("P");
    expect(line?.textContent).toBe(NO_PHASE_YET);
    view.rerender(installing({ phase: "unpack", percent: 1, slow: false }));
    expect(status().firstElementChild).toBe(line);
    expect(line?.textContent).toBe("解开安装包");
  });

  it("慢提示出现时从透明淡入，不是同一帧冒出来", () => {
    view = render(installing({ phase: "write", percent: 50, slow: false }));
    view.rerender(installing({ phase: "write", percent: 50, slow: true }));
    const slow = [...status().querySelectorAll("p")].find((p) => p.textContent === zh.installing.slow);
    expect(slow?.parentElement?.style.opacity).toBe("0");
  });

  it.each([
    ["unpack", "解开安装包"],
    ["write", "写入文件"],
    ["verify", "检查结果"],
  ] as const)("%s 显示「%s」", (phase, label) => {
    view = render(installing({ phase, percent: 50, slow: false }));
    expect(status().textContent).toBe(label);
  });

  it("换阶段时是同一个状态区域在变，读屏才会播报", () => {
    view = render(installing(null));
    const region = status();
    view.rerender(installing({ phase: "write", percent: 30, slow: false }));
    expect(status()).toBe(region);
    expect(region.textContent).toBe("写入文件");
  });

  it("写得慢时在状态区域里追加提示，平时没有", () => {
    view = render(installing({ phase: "write", percent: 50, slow: false }));
    expect(status().textContent).not.toContain(zh.installing.slow);
    view.rerender(installing({ phase: "write", percent: 50, slow: true }));
    expect(status().textContent).toBe(`写入文件${zh.installing.slow}`);
  });
});

describe("不能中途走开", () => {
  it("除了窗口按钮没有别的按钮，也就没有取消", () => {
    view = render(installing({ phase: "write", percent: 50, slow: false }));
    expect([...document.querySelectorAll("main button")].map((b) => b.getAttribute("aria-label"))).toEqual([zh.frame.minimize, zh.frame.close]);
  });

  it("原因常驻在视图里，Alt+F4 被拦时也看得到", () => {
    view = render(installing(null));
    expect(document.querySelector("main")?.textContent).toContain("安装中不能关闭");
  });

  async function installingApp() {
    const fake = createFakeBridge({ outcome: "hang", progress: [] });
    const initial = replay([
      { type: "probed", probe: FAKE_PROBE },
      { type: "install_requested", mode: "fresh", running: false, check: fake.scenario.checkDir(FAKE_PROBE.defaultDir) },
    ]);
    view = render(<App bridge={fake} copy={zh} initial={initial} />);
    await act(async () => {
      await vi.waitFor(() => expect(fake.callsOf("install")).toHaveLength(1));
    });
    return fake;
  }

  const closeButton = () => {
    const found = document.querySelector<HTMLButtonElement>(`button[aria-label="${zh.frame.close}"]`);
    if (found === null) throw new Error("没有关闭键");
    return found;
  };

  it("系统发来的关闭请求（Alt+F4、任务栏）被拦下", async () => {
    const fake = await installingApp();
    expect(fake.requestClose()).toBe(false);
  });

  it("关闭键点了没用，读屏知道它不可用", async () => {
    const fake = await installingApp();
    const close = closeButton();
    expect(close.getAttribute("aria-disabled")).toBe("true");
    act(() => close.click());
    expect(fake.callsOf("close")).toEqual([]);
  });

  it("关闭键聚焦时气泡说明原因", async () => {
    await installingApp();
    focusByKeyboard(closeButton());
    expect(document.querySelector('[role="tooltip"]')?.textContent).toBe("安装中不能关闭");
  });

  it("最小化不受影响", async () => {
    const fake = await installingApp();
    const minimize = document.querySelector<HTMLButtonElement>(`button[aria-label="${zh.frame.minimize}"]`);
    act(() => minimize?.click());
    expect(fake.callsOf("minimize")).toHaveLength(1);
  });
});
