// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { useState, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useReflow } from "../lib/reflow";
import { OverlayProvider, OverlayRoot } from "../shell/overlay";
import { keydown, render, stubResizeObserver, waitForFrames, type Rendered, type ResizeObserverStub } from "../test/dom";
import { MEMORY_WARN_COPY, MemorySlider, MemorySliderSkeleton, memoryMarks, memoryMaxMb, memoryShare, type MemorySliderProps } from "./MemorySlider";

let view: Rendered | undefined;
let observers: ResizeObserverStub;

beforeEach(() => {
  observers = stubResizeObserver();
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

  it("占用说明按四舍五入的百分比与总量书写，百分比数字单独拆出来放进定宽槽", () => {
    expect(memoryShare(6144, 16384)).toEqual({ lead: "占系统内存 ", percent: "38", tail: "%（共 16 GB）" });
    expect(memoryShare(8192, 32768)).toEqual({ lead: "占系统内存 ", percent: "25", tail: "%（共 32 GB）" });
    expect(memoryShare(1024, 131072).percent).toBe("1");
    expect(memoryShare(16384, 16384).percent).toBe("100");
  });

  it("百分比槽定宽 3 位、右对齐，整行用等宽数字", () => {
    const css = readFileSync(resolve(__dirname, "MemorySlider.module.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    const rule = (selector: string) => {
      const match = new RegExp(`(?:^|\\n)\\${selector}\\s*\\{([^}]*)\\}`).exec(css);
      if (match === null) throw new Error(`没有 ${selector} 规则`);
      return match[1];
    };
    expect(rule(".percent")).toContain("min-width: 3ch;");
    expect(rule(".percent")).toContain("text-align: end;");
    expect(rule(".percent")).toContain("display: inline-block;");
    expect(rule(".usage")).toContain("font-variant-numeric: tabular-nums;");
  });
});

describe("MemorySlider", () => {
  function Host(props: Partial<MemorySliderProps> & { initial: number; totalMb: number }) {
    const [value, setValue] = useState(props.initial);
    return <MemorySlider ariaLabel="最大内存" onCommit={() => undefined} {...props} value={value} onChange={setValue} />;
  }
  const range = () => document.querySelector<HTMLInputElement>('input[type="range"]') as HTMLInputElement;
  const usage = () => document.querySelector("p") as HTMLParagraphElement;

  it("步长 512、读数用 GB；跨过物理内存一半进入警示区，回落后退出", async () => {
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
    const alert = document.querySelector('[role="alert"]') as HTMLElement;
    expect(alert.textContent).toBe(MEMORY_WARN_COPY);
    // 警示条从透明淡入落位，不是一帧出现
    const item = alert.parentElement as HTMLElement;
    expect(item.style.opacity).toBe("0");
    await waitForFrames(() => expect(item.style.opacity).toBe("1"));
    expect(usage().dataset.tone).toBe("warn");
    expect(document.querySelector('[data-tone="warn"][data-has-value]')).not.toBeNull();

    keydown(range(), "ArrowLeft");
    expect(usage().hasAttribute("data-tone")).toBe(false);
    await waitForFrames(() => expect(document.querySelector('[role="alert"]')).toBeNull());
  });

  it("警示条出没改变的是组件根元素自己的高度：根元素是外层让位直接观察的那个盒子", () => {
    // jsdom 没有 Web Animations，让位在那里不启动；补上之后才能看到它观察了哪些元素
    Object.defineProperty(HTMLElement.prototype, "animate", { configurable: true, value: () => undefined });
    try {
      function CardBody() {
        const ref = useReflow<HTMLDivElement>();
        return (
          <div ref={ref} data-testid="card-body">
            <Host initial={12288} totalMb={16384} />
            <span>下一行</span>
          </div>
        );
      }
      mount(<CardBody />);
      const body = document.querySelector('[data-testid="card-body"]') as HTMLElement;
      // 组件只出一个根元素，就是卡片栈里的那一项；警示条的出入场层是它的流内直接子项，出现时撑高的是它
      expect(body.children).toHaveLength(2);
      const root = body.children[0] as HTMLElement;
      const alert = document.querySelector('[role="alert"]') as HTMLElement;
      expect(alert.parentElement?.parentElement).toBe(root);
      // 根元素被观察两次：外层让位把它当子项，组件内部的让位把它当容器
      expect(observers.observed().filter((el) => el === root)).toHaveLength(2);
      // 根元素是有盒子的定位基准：popLayout 退场时警示条以它为基准脱离布局，它同帧缩回，外层的尺寸观察看得到
      const css = readFileSync(resolve(__dirname, "MemorySlider.module.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
      const rootRule = /(?:^|\n)\.root\s*\{([^}]*)\}/.exec(css)?.[1];
      expect(rootRule).toContain("position: relative;");
      expect(rootRule).toContain("display: flex;");
    } finally {
      delete (HTMLElement.prototype as { animate?: unknown }).animate;
    }
  });

  it("挂载时就在警示区：警示条随所在页面入场，不单独淡入", () => {
    mount(<Host initial={12288} totalMb={16384} />);
    const alert = document.querySelector('[role="alert"]') as HTMLElement;
    expect(alert.textContent).toBe(MEMORY_WARN_COPY);
    expect((alert.parentElement as HTMLElement).style.opacity).toBe("1");
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

describe("加载占位", () => {
  const read = (file: string) =>
    readFileSync(resolve(__dirname, file), "utf8")
      .replace(/\r\n/g, "\n")
      .replace(/\/\*[\s\S]*?\*\//g, "");
  const tokensCss = read("../styles/tokens.css");

  function decl(css: string, selector: string, property: string): string {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const block = new RegExp(`(^|\\n)${escaped}\\s*\\{([^}]*)\\}`).exec(css);
    if (block === null) throw new Error(`样式表里没有 ${selector}`);
    const found = new RegExp(`(^|[;\\s])${property}\\s*:\\s*([^;]+);`).exec(block[2]);
    if (found === null) throw new Error(`${selector} 没有写 ${property}`);
    return found[2].trim();
  }

  /** 把 var(--sk-…) 换成令牌在 :root 上的取值。 */
  function resolveTokens(value: string): string {
    return value.replace(/var\((--sk-[a-z0-9-]+)\)/g, (_, name: string) => {
      const found = new RegExp(`${name}\\s*:\\s*([^;]+);`).exec(tokensCss);
      if (found === null) throw new Error(`令牌表里没有 ${name}`);
      return found[1].trim();
    });
  }

  it("命中区加刻度那一行照 Slider 的尺寸画：命中区高、刻度行高、读数列宽与间距逐项对得上", () => {
    const slider = read("Slider.module.css");
    const memory = read("MemorySlider.module.css");
    expect(decl(memory, ".skeletonTrack", "height")).toBe(decl(slider, ".control", "height"));
    expect(resolveTokens(decl(memory, ".skeletonTrack", "margin-bottom"))).toBe(decl(slider, ".marks", "height"));
    expect(decl(memory, ".skeletonTrack", "grid-template-columns")).toBe(`minmax(0, 1fr) ${decl(slider, ".slider", "--slider-value-width")}`);
    expect(decl(memory, ".skeletonTrack", "gap")).toBe(decl(slider, ".slider", "--slider-value-gap"));
  });

  it("外层容器与占用说明行直接用滑杆自己的类；只画图形，没有可聚焦元素", () => {
    mount(
      <>
        <div data-testid="skeleton">
          <MemorySliderSkeleton />
        </div>
        <div data-testid="real">
          <MemorySlider value={6144} onChange={() => undefined} onCommit={() => undefined} totalMb={16384} ariaLabel="最大内存" />
        </div>
      </>,
    );
    const skeleton = document.querySelector('[data-testid="skeleton"]') as HTMLElement;
    const real = document.querySelector('[data-testid="real"]') as HTMLElement;
    expect((skeleton.firstElementChild as HTMLElement).className).toBe((real.firstElementChild as HTMLElement).className);
    expect((skeleton.querySelector("p") as HTMLElement).className).toBe((real.querySelector("p") as HTMLElement).className);
    expect(skeleton.querySelector("button, input, a, select, textarea, [tabindex]")).toBeNull();
  });
});
