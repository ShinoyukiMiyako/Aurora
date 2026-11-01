// @vitest-environment jsdom
// 每秒轮询和进程消失后自动继续在 App 里，流程测试断言；这里钉住这一页本身。

import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stubCanvas, stubPetalTokens } from "../../art/petals/test-canvas";
import { render, stubMatchMedia, stubResizeObserver, type Rendered } from "../../test/dom";
import { COPY } from "../copy";
import { Blocked } from "./Blocked";
import { TestChrome } from "./test-chrome";

const copy = COPY.zh;

let view: Rendered | undefined;

function mount() {
  const onCheckAgain = vi.fn();
  const onBack = vi.fn();
  view = render(
    <TestChrome copy={copy}>
      <Blocked copy={copy} onCheckAgain={onCheckAgain} onBack={onBack} />
    </TestChrome>,
  );
  return { onCheckAgain, onBack };
}

function button(name: string): HTMLButtonElement {
  const found = [...document.querySelectorAll("button")].find((b) => b.textContent === name);
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
  view = undefined;
  vi.unstubAllGlobals();
});

describe("Blocked", () => {
  it("说清楚为什么停在这里，以及关掉之后会自动继续", () => {
    mount();
    expect(document.querySelector("h1")?.textContent).toBe(copy.blocked.title);
    expect(document.querySelector("p")?.textContent).toBe(copy.blocked.lead);
  });

  it("主按钮是重新检查，只查不走", () => {
    const { onCheckAgain, onBack } = mount();
    const check = button(copy.blocked.checkAgain);
    expect(check.dataset.variant).toBe("primary");
    act(() => check.click());
    expect(onCheckAgain).toHaveBeenCalledTimes(1);
    expect(onBack).not.toHaveBeenCalled();
  });

  it("返回只走不查，也不是主按钮", () => {
    const { onCheckAgain, onBack } = mount();
    const back = button(copy.blocked.back);
    expect(back.dataset.variant).toBe("secondary");
    act(() => back.click());
    expect(onBack).toHaveBeenCalledTimes(1);
    expect(onCheckAgain).not.toHaveBeenCalled();
  });

  it("页面上有转动的等待指示，读屏不重复念", () => {
    mount();
    const spinner = document.querySelector("main [aria-hidden='true'] svg");
    expect(spinner).not.toBeNull();
    expect(document.querySelector("main [role='status']")).toBeNull();
  });
});
