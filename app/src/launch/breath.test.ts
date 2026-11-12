// @vitest-environment jsdom
// 呼吸窗口的相位：窗口内新挂载的元素要跳到与已有元素同一时刻。
import { createElement, useRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, type Rendered } from "../test/dom";
import { BREATH_ATTR, BREATH_CYCLES, BREATH_DELAY_VAR, BREATH_PERIOD_MS, breathDelayMs, endBreathWindow, startBreathWindow, useBreathPhase } from "./breath";

let view: Rendered | undefined;
afterEach(() => {
  view?.unmount();
  view = undefined;
  endBreathWindow();
  vi.useRealTimers();
});

function Breather() {
  const ref = useRef<HTMLSpanElement>(null);
  useBreathPhase(ref, true);
  return createElement("span", { ref, "data-testid": "breather" });
}

const delayOf = () => view?.container.querySelector<HTMLElement>('[data-testid="breather"]')?.style.getPropertyValue(BREATH_DELAY_VAR);

describe("呼吸相位", () => {
  it("负延迟是到窗口起点的整段时长，不按周期取模：只播一次的整窗关键帧（运行光晕）要跳到段里同一时刻", () => {
    expect(breathDelayMs(10_000, 10_000 + 2.5 * BREATH_PERIOD_MS)).toBe(-2.5 * BREATH_PERIOD_MS);
  });

  it("窗口内挂载：按起点取负延迟；窗口外挂载为 0；新窗口开始时清零；窗口长度是整周期", () => {
    vi.useFakeTimers();
    vi.setSystemTime(100_000);
    view = render(createElement(Breather));
    expect(delayOf()).toBe("0ms");
    view.unmount();

    startBreathWindow();
    vi.setSystemTime(100_000 + 4_000);
    view = render(createElement(Breather));
    expect(delayOf()).toBe("-4000ms");

    startBreathWindow();
    expect(delayOf()).toBe("0ms");
    expect(document.documentElement.hasAttribute(BREATH_ATTR)).toBe(true);
    vi.advanceTimersByTime(BREATH_PERIOD_MS * BREATH_CYCLES - 1);
    expect(document.documentElement.hasAttribute(BREATH_ATTR)).toBe(true);
    vi.advanceTimersByTime(1);
    expect(document.documentElement.hasAttribute(BREATH_ATTR)).toBe(false);
  });
});
