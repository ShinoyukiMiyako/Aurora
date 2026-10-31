// @vitest-environment jsdom
import { MotionConfig, type MotionValue } from "framer-motion";
import { afterEach, describe, expect, it } from "vitest";
import { render, type Rendered } from "../test/dom";
import { fillOffset, MIN_VISIBLE_PROGRESS, nextProgressTarget, ProgressBar, useSmoothProgress, visibleProgress } from "./ProgressBar";
import { ProgressRing, RING_EMPTY_TEXT, RING_PLACEHOLDER, RING_STROKE, ringHasLabel } from "./ProgressRing";

let view: Rendered | undefined;
afterEach(() => {
  view?.unmount();
  view = undefined;
});

describe("进度推演", () => {
  it("同一标识内只增不减：小于当前目标的新值被忽略", () => {
    const start = nextProgressTarget({ track: "task#1", target: 0 }, "task#1", 0.6);
    expect(start).toEqual({ track: "task#1", target: 0.6, jump: false });
    expect(nextProgressTarget(start, "task#1", 0.3)).toEqual({ track: "task#1", target: 0.6, jump: false });
    expect(nextProgressTarget(start, "task#1", 0.75)).toEqual({ track: "task#1", target: 0.75, jump: false });
  });

  it("换了标识直接跳到新值，即使比旧值小", () => {
    expect(nextProgressTarget({ track: "task#1", target: 0.9 }, "task#2", 0.1)).toEqual({ track: "task#2", target: 0.1, jump: true });
  });

  it("没有标识时原样跟随，可以回退", () => {
    expect(nextProgressTarget({ track: undefined, target: 0.9 }, undefined, 0.2)).toEqual({ track: undefined, target: 0.2, jump: false });
  });

  it("超出 [0, 1] 截断（重传字节可能超过声明大小），NaN 抛错", () => {
    expect(nextProgressTarget({ track: "a", target: 0 }, "a", 1.37).target).toBe(1);
    expect(nextProgressTarget({ track: undefined, target: 0.5 }, undefined, -0.2).target).toBe(0);
    expect(() => nextProgressTarget({ track: "a", target: 0 }, "a", Number.NaN)).toThrow(/NaN/);
  });

  it("大于 0 时最少显示 2%，0 仍是空轨道", () => {
    expect(MIN_VISIBLE_PROGRESS).toBe(0.02);
    expect(visibleProgress(0)).toBe(0);
    expect(visibleProgress(0.001)).toBe(0.02);
    expect(visibleProgress(0.02)).toBe(0.02);
    expect(visibleProgress(0.5)).toBe(0.5);
    expect(visibleProgress(1.4)).toBe(1);
  });

  it("填充位移为 (p − 1) × 100%", () => {
    expect(fillOffset(0.25)).toBe("-75%");
    expect(fillOffset(1)).toBe("0%");
    expect(fillOffset(0)).toBe("-100%");
  });
});

describe("useSmoothProgress", () => {
  let smooth: MotionValue<number> | undefined;
  function Probe({ value, track }: { value: number; track?: string }) {
    smooth = useSmoothProgress(value, track).smooth;
    return null;
  }
  const latest = () => {
    if (smooth === undefined) throw new Error("探针未挂载");
    return smooth.get();
  };

  it("挂载时直接从目标值开始，不从 0 动画上来", () => {
    view = render(<Probe value={0.42} track="s" />);
    expect(latest()).toBe(0.42);
  });

  it("完整动画：新目标交给弹簧，同步读取仍是旧值", () => {
    view = render(
      <MotionConfig reducedMotion="never">
        <Probe value={0.2} track="s" />
      </MotionConfig>,
    );
    view.rerender(
      <MotionConfig reducedMotion="never">
        <Probe value={0.8} track="s" />
      </MotionConfig>,
    );
    expect(latest()).toBe(0.2);
  });

  it("减少动画：不平滑，立即等于目标值", () => {
    view = render(
      <MotionConfig reducedMotion="always">
        <Probe value={0.2} track="s" />
      </MotionConfig>,
    );
    view.rerender(
      <MotionConfig reducedMotion="always">
        <Probe value={0.8} track="s" />
      </MotionConfig>,
    );
    expect(latest()).toBe(0.8);
  });

  it("完整动画下换标识也立即跳到新值", () => {
    view = render(
      <MotionConfig reducedMotion="never">
        <Probe value={0.9} track="a" />
      </MotionConfig>,
    );
    view.rerender(
      <MotionConfig reducedMotion="never">
        <Probe value={0.1} track="b" />
      </MotionConfig>,
    );
    expect(latest()).toBe(0.1);
  });
});

describe("ProgressBar", () => {
  const bar = () => {
    const el = view?.container.querySelector<HTMLElement>('[role="progressbar"]');
    if (!el) throw new Error("没有渲染进度条");
    return el;
  };

  it("定进度：aria-valuenow 为整数百分比，填充按进度移出", () => {
    view = render(<ProgressBar value={0.37} label="下载 Sodium" size="sm" tone="ok" />);
    const el = bar();
    expect(el.getAttribute("aria-valuenow")).toBe("37");
    expect(el.getAttribute("aria-valuemin")).toBe("0");
    expect(el.getAttribute("aria-valuemax")).toBe("100");
    expect(el.getAttribute("aria-label")).toBe("下载 Sodium");
    expect(el.dataset.tone).toBe("ok");
    expect(el.dataset.size).toBe("sm");
    expect((el.firstElementChild as HTMLElement).style.transform).toBe("translateX(-63%)");
  });

  it("同一任务里进度回落时显示不倒退，换任务后照实显示", () => {
    view = render(<ProgressBar value={0.6} track="t#1" label="安装" />);
    view.rerender(<ProgressBar value={0.3} track="t#1" label="安装" />);
    expect(bar().getAttribute("aria-valuenow")).toBe("60");
    view.rerender(<ProgressBar value={0.3} track="t#2" label="安装" />);
    expect(bar().getAttribute("aria-valuenow")).toBe("30");
  });

  it("不定进度：没有 aria-valuenow，只有一条光带", () => {
    view = render(<ProgressBar value={null} labelledBy="task-title" />);
    const el = bar();
    expect(el.hasAttribute("aria-valuenow")).toBe(false);
    expect(el.dataset.indeterminate).toBe("");
    expect(el.getAttribute("aria-labelledby")).toBe("task-title");
    expect(el.children).toHaveLength(1);
  });

  it("排队中传 0：静态空轨道", () => {
    view = render(<ProgressBar value={0} label="排队中" />);
    expect(bar().getAttribute("aria-valuenow")).toBe("0");
    expect(bar().hasAttribute("data-indeterminate")).toBe(false);
    expect((bar().firstElementChild as HTMLElement).style.transform).toBe("translateX(-100%)");
  });

  it("没有名称时抛错", () => {
    expect(() => render(<ProgressBar value={0.5} />)).toThrow(/label 或 labelledBy/);
  });
});

describe("ProgressRing", () => {
  const ring = () => {
    const el = view?.container.querySelector<HTMLElement>('[role="progressbar"]');
    if (!el) throw new Error("没有渲染进度环");
    return el;
  };

  it.each([
    [16, 2],
    [20, 2],
    [24, 2.5],
    [36, 3.5],
    [48, 4],
    [84, 7],
  ] as const)("%i 档描边 %s", (size, stroke) => {
    expect(RING_STROKE[size]).toBe(stroke);
    view = render(<ProgressRing value={0.5} size={size} label="安装中" />);
    const circles = ring().querySelectorAll("circle");
    expect(circles).toHaveLength(2);
    for (const c of circles) expect(c.getAttribute("stroke-width")).toBe(String(stroke));
    const r = (size - stroke) / 2;
    expect(Number(circles[1].getAttribute("stroke-dasharray"))).toBeCloseTo(2 * Math.PI * r, 5);
  });

  it("36 及以上在圆心写百分数，更小的不写", () => {
    expect(ringHasLabel(16)).toBe(false);
    expect(ringHasLabel(24)).toBe(false);
    expect(ringHasLabel(36)).toBe(true);
    expect(ringHasLabel(48)).toBe(true);
    expect(ringHasLabel(84)).toBe(true);
    view = render(<ProgressRing value={0.37} size={36} label="下载" />);
    expect(ring().textContent).toBe("37%");
    expect(ring().getAttribute("aria-valuenow")).toBe("37");
    view.unmount();
    view = render(<ProgressRing value={0.37} size={24} label="下载" />);
    expect(ring().textContent).toBe("");
  });

  it("启动进度封顶 99%：只有进入运行才算 100", () => {
    view = render(<ProgressRing value={0.999} size={48} capAt99 label="启动中" />);
    expect(ring().textContent).toBe("99%");
    view.unmount();
    view = render(<ProgressRing value={0.999} size={48} label="下载" />);
    expect(ring().textContent).toBe("100%");
  });

  it("进度为 0 时不画填充（圆头描边在零长度时会留下一个点）", () => {
    view = render(<ProgressRing value={0} size={20} label="排队中" />);
    expect(ring().querySelectorAll("circle")).toHaveLength(1);
  });

  it("84 档写百分数：总进度 62.5% 四舍五入为 63%", () => {
    view = render(<ProgressRing value={0.625} size={84} label="下载总进度" />);
    expect(ring().textContent).toBe("63%");
    expect(ring().getAttribute("aria-valuenow")).toBe("63");
    expect(ring().getAttribute("data-size")).toBe("84");
  });

  const emptyRing = () => {
    const el = view?.container.querySelector<HTMLElement>('[data-empty]');
    if (!el) throw new Error("没有渲染占位的进度环");
    return el;
  };

  // 没有 aria-valuenow 的 progressbar 会被读屏当成不定进度（「忙」），念不出「眼下没有进度」
  it("没有可显示的进度（null）：只画轨道，圆心写占位；读屏念名称加一句可读的说明，不当作进度条", () => {
    view = render(<ProgressRing value={null} size={84} tone="muted" label="下载总进度" />);
    expect(view.container.querySelector('[role="progressbar"]')).toBeNull();
    const el = emptyRing();
    expect(el.querySelectorAll("circle")).toHaveLength(1);
    expect(RING_PLACEHOLDER).toBe("--");
    expect(el.textContent).toBe("--");
    expect(el.getAttribute("role")).toBe("img");
    expect(RING_EMPTY_TEXT).toBe("暂无进度");
    expect(el.getAttribute("aria-label")).toBe("下载总进度：暂无进度");
    for (const attr of ["aria-valuenow", "aria-valuetext", "aria-valuemin", "aria-valuemax"]) expect(el.hasAttribute(attr)).toBe(false);
  });

  it("占位说明可由调用方按场合给出；名称经 labelledBy 引用时，说明接在被引用的名称之后", () => {
    view = render(<ProgressRing value={null} size={84} label="下载总进度" emptyText="没有进行中的下载" />);
    expect(emptyRing().getAttribute("aria-label")).toBe("下载总进度：没有进行中的下载");
    view.unmount();
    view = render(
      <>
        <span id="ring-name">吞吐</span>
        <ProgressRing value={null} size={48} labelledBy="ring-name" emptyText="没有进行中的下载" />
      </>,
    );
    const el = emptyRing();
    const ids = (el.getAttribute("aria-labelledby") ?? "").split(" ");
    expect(ids).toHaveLength(2);
    expect(ids[0]).toBe("ring-name");
    expect(document.getElementById(ids[1])?.textContent).toBe("没有进行中的下载");
    expect(el.hasAttribute("aria-label")).toBe(false);
  });

  it("有进度时不带占位说明：名称原样，读屏报数值", () => {
    view = render(<ProgressRing value={0.25} size={84} label="下载总进度" emptyText="没有进行中的下载" />);
    expect(ring().getAttribute("aria-label")).toBe("下载总进度");
    expect(ring().getAttribute("aria-valuenow")).toBe("25");
    expect(ring().getAttribute("aria-valuemin")).toBe("0");
    expect(ring().getAttribute("aria-valuemax")).toBe("100");
    expect(ring().textContent).not.toContain("没有进行中的下载");
  });

  it("从占位换成真实进度：画出填充、读屏报出目标值，圆心改为（平滑中的）百分数；小档位占位时圆心仍为空", () => {
    view = render(<ProgressRing value={null} size={84} label="下载总进度" />);
    view.rerender(<ProgressRing value={0.4} size={84} label="下载总进度" />);
    expect(ring().getAttribute("role")).toBe("progressbar");
    expect(ring().getAttribute("aria-label")).toBe("下载总进度");
    expect(ring().querySelectorAll("circle")).toHaveLength(2);
    expect(ring().getAttribute("aria-valuenow")).toBe("40");
    expect(ring().hasAttribute("aria-valuetext")).toBe(false);
    expect(ring().textContent).toMatch(/^\d+%$/);
    expect(ring().hasAttribute("data-empty")).toBe(false);
    view.unmount();
    view = render(<ProgressRing value={null} size={24} label="下载" />);
    expect(emptyRing().textContent).toBe("");
    expect(emptyRing().querySelectorAll("circle")).toHaveLength(1);
  });

  it("没有名称时抛错", () => {
    expect(() => render(<ProgressRing value={0.5} />)).toThrow(/label 或 labelledBy/);
  });
});
