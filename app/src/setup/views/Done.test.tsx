// @vitest-environment jsdom
// @module-tag heavy-page
// 完成视图：三种安装各说各的话，提权时绝不给打开，打开由用户触发。

import { MotionConfig } from "framer-motion";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stubCanvas, stubPetalTokens } from "../../art/petals/test-canvas";
import { OverlayProvider, OverlayRoot } from "../../shell/overlay";
import { render, stubMatchMedia, stubResizeObserver, type Rendered } from "../../test/dom";
import type { InstallMode } from "../contract";
import { COPY, type SetupCopy } from "../copy";
import { FrameChromeProvider, type FrameChrome } from "../Frame";
import { Done, type DoneProps } from "./Done";

const VERSION = "0.2.0";
const zh = COPY.zh;

let view: Rendered | null = null;

function chromeOf(copy: SetupCopy): FrameChrome {
  return { copy: copy.frame, version: VERSION, canClose: true, canOpenLegal: true, reduced: false, onMinimize: () => undefined, onClose: () => undefined, onOpenLegal: () => undefined };
}

function done(overrides: Partial<DoneProps> = {}) {
  const copy = overrides.copy ?? zh;
  return (
    <MotionConfig reducedMotion="always">
      <OverlayProvider>
        <FrameChromeProvider value={chromeOf(copy)}>
          <Done copy={copy} mode="fresh" version={VERSION} keptData={false} elevated={false} opening={false} onOpen={() => undefined} onClose={() => undefined} {...overrides} />
          <OverlayRoot />
        </FrameChromeProvider>
      </OverlayProvider>
    </MotionConfig>
  );
}

const heading = () => document.querySelector("h1")?.textContent;
const lead = () => document.querySelector("h1")?.nextElementSibling?.textContent;
const buttonNamed = (name: string) => [...document.querySelectorAll("button")].find((b) => b.textContent === name);

function button(name: string): HTMLButtonElement {
  const found = buttonNamed(name);
  if (found === undefined) throw new Error(`没有名为 ${name} 的按钮`);
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

describe("文案", () => {
  it.each([
    ["fresh", "装好了"],
    ["upgrade", "已升级到 0.2.0"],
    ["repair", "重新安装完成"],
  ] as const)("%s 的标题是「%s」", (mode: InstallMode, title) => {
    view = render(done({ mode }));
    expect(heading()).toBe(title);
  });

  it("英文系统走英文表", () => {
    view = render(done({ copy: COPY.en, mode: "upgrade", keptData: true }));
    expect(heading()).toBe("Updated to 0.2.0");
    expect(lead()).toBe("Your settings, accounts and game files are untouched.");
  });

  it("全新安装预告首次向导", () => {
    view = render(done({ keptData: false }));
    expect(lead()).toBe(zh.done.firstRun);
  });

  it("保留了数据时说数据还在，不提首次向导", () => {
    view = render(done({ keptData: true }));
    expect(lead()).toBe("设置、账户和游戏文件都还在。");
  });
});

describe("打开", () => {
  it("主按钮是打开，一进来就有焦点，Enter 直接生效", () => {
    view = render(done());
    const open = button(zh.done.open);
    expect(open.dataset.variant).toBe("primary");
    expect(document.activeElement).toBe(open);
  });

  it("不自动打开", () => {
    const onOpen = vi.fn();
    view = render(done({ onOpen }));
    expect(onOpen).not.toHaveBeenCalled();
  });

  it("点了才打开", () => {
    const onOpen = vi.fn();
    view = render(done({ onOpen }));
    act(() => button(zh.done.open).click());
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it("打开途中转加载，再点不会起第二次", () => {
    const onOpen = vi.fn();
    view = render(done({ onOpen, opening: true }));
    const open = button(zh.done.open);
    expect(open.getAttribute("aria-busy")).toBe("true");
    act(() => open.click());
    expect(onOpen).not.toHaveBeenCalled();
  });

  it("关闭只关闭，不打开", () => {
    const onOpen = vi.fn();
    const onClose = vi.fn();
    view = render(done({ onOpen, onClose }));
    act(() => button(zh.done.close).click());
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onOpen).not.toHaveBeenCalled();
  });
});

describe("提权运行", () => {
  it("不给打开，提示从开始菜单打开", () => {
    view = render(done({ elevated: true }));
    expect(buttonNamed(zh.done.open)).toBeUndefined();
    expect(document.querySelector("main")?.textContent).toContain(zh.done.elevated);
  });

  it("平时没有这条提示", () => {
    view = render(done({ elevated: false }));
    expect(document.querySelector("main")?.textContent).not.toContain(zh.done.elevated);
  });

  it("该说的说明照常在", () => {
    view = render(done({ elevated: true, keptData: true }));
    expect(lead()).toBe(zh.done.kept);
  });

  it("焦点落在唯一的关闭上，Enter 能退出", () => {
    const onClose = vi.fn();
    view = render(done({ elevated: true, onClose }));
    const close = button(zh.done.close);
    expect(document.activeElement).toBe(close);
    act(() => close.click());
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
