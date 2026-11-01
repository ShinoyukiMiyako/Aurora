// @vitest-environment jsdom
import { useState, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OverlayProvider, OverlayRoot } from "../shell/overlay";
import { keydown, render, stubResizeObserver, type Rendered } from "../test/dom";
import { MEMORY_WARN_COPY, MemorySlider, memoryMarks, memoryMaxMb, memoryShare, type MemorySliderProps } from "./MemorySlider";

let view: Rendered | undefined;

beforeEach(() => {
  stubResizeObserver();
});

afterEach(() => {
  view?.unmount();
  view = undefined;
});

function mount(ui: ReactNode) {
  view = render(
    <OverlayProvider>
      {ui}
      <OverlayRoot />
    </OverlayProvider>,
  );
}

describe("范围、刻度与说明", () => {
  it("上限是物理内存向下取整到 512 MB", () => {
    expect(memoryMaxMb(16384)).toBe(16384);
    expect(memoryMaxMb(16000)).toBe(15872);
    expect(memoryMaxMb(32679)).toBe(32256);
  });

  it("刻度取范围内的 2 / 4 / 8 / 16 / 32 / 64 GB 再加最大值，最大值恰是候选时不重复", () => {
    expect(memoryMarks(15872).map((m) => m.label)).toEqual(["2 GB", "4 GB", "8 GB", "15.5 GB"]);
    expect(memoryMarks(16384).map((m) => m.label)).toEqual(["2 GB", "4 GB", "8 GB", "16 GB"]);
    expect(memoryMarks(131072).map((m) => m.value)).toEqual([2048, 4096, 8192, 16384, 32768, 65536, 131072]);
  });

  it("占用说明按四舍五入的百分比与总量书写", () => {
    expect(memoryShare(6144, 16384)).toBe("占系统内存 38%（共 16 GB）");
    expect(memoryShare(8192, 32768)).toBe("占系统内存 25%（共 32 GB）");
  });
});

describe("MemorySlider", () => {
  function Host(props: Partial<MemorySliderProps> & { initial: number; totalMb: number }) {
    const [value, setValue] = useState(props.initial);
    return <MemorySlider ariaLabel="最大内存" onCommit={() => undefined} {...props} value={value} onChange={setValue} />;
  }
  const range = () => document.querySelector<HTMLInputElement>('input[type="range"]') as HTMLInputElement;
  const usage = () => document.querySelector("p") as HTMLParagraphElement;

  it("步长 512、读数用 GB；跨过物理内存一半进入警示区，回落后退出", () => {
    mount(<Host initial={7680} totalMb={16384} notes={["建议值 6 GB，当前足够"]} />);
    expect(range().min).toBe("1024");
    expect(range().max).toBe("16384");
    expect(range().step).toBe("512");
    expect(range().getAttribute("aria-valuetext")).toBe("7.5 GB");
    expect(usage().textContent).toBe("占系统内存 47%（共 16 GB） · 建议值 6 GB，当前足够");
    expect(document.querySelector('[role="alert"]')).toBeNull();

    // 8192 恰好一半，不算超过
    keydown(range(), "ArrowRight");
    expect(range().getAttribute("aria-valuetext")).toBe("8 GB");
    expect(document.querySelector('[role="alert"]')).toBeNull();

    keydown(range(), "ArrowRight");
    expect(range().getAttribute("aria-valuetext")).toBe("8.5 GB");
    expect(document.querySelector('[role="alert"]')?.textContent).toBe(MEMORY_WARN_COPY);
    expect(usage().dataset.tone).toBe("warn");
    expect(document.querySelector('[data-tone="warn"][data-has-value]')).not.toBeNull();

    keydown(range(), "ArrowLeft");
    expect(document.querySelector('[role="alert"]')).toBeNull();
    expect(usage().hasAttribute("data-tone")).toBe(false);
  });

  it("低于推荐值的补充说明单独着警示色；推荐值画成标记并带悬停说明", () => {
    mount(<Host initial={4096} totalMb={32768} recommended={{ mb: 8192, tip: "按 168 个 Mod 推荐 8 GB" }} notes={["168 个 Mod 建议至少 8 GB"]} notesTone="warn" />);
    expect(usage().hasAttribute("data-tone")).toBe(false);
    expect(usage().querySelector('[data-tone="warn"]')?.textContent).toBe(" · 168 个 Mod 建议至少 8 GB");
    const marker = document.querySelector<HTMLElement>("[style*='--marker-p']") as HTMLElement;
    // (8192 − 1024) / (32768 − 1024)
    expect(Number(marker.style.getPropertyValue("--marker-p"))).toBeCloseTo(7168 / 31744, 10);
  });

  it("跟随全局时整组禁用，读数照常显示", () => {
    mount(<Host initial={6144} totalMb={16384} disabled />);
    expect(range().disabled).toBe(true);
    expect(range().getAttribute("aria-valuetext")).toBe("6 GB");
  });

  it("物理内存放不下最小值以上的一档时抛错", () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(() => mount(<Host initial={1024} totalMb={1500} />)).toThrow("物理内存 1500 MB 不足以分配游戏内存");
  });
});
