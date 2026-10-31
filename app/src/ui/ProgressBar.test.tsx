// @vitest-environment jsdom
import { MotionConfig, type MotionValue } from "framer-motion";
import { afterEach, describe, expect, it } from "vitest";
import { render, type Rendered } from "../test/dom";
import { fillOffset, MIN_VISIBLE_PROGRESS, nextProgressTarget, ProgressBar, useSmoothProgress, visibleProgress } from "./ProgressBar";
import { ProgressRing, RING_STROKE, ringHasLabel } from "./ProgressRing";

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
  ] as const)("%i 档描边 %s", (size, stroke) => {
    expect(RING_STROKE[size]).toBe(stroke);
    view = render(<ProgressRing value={0.5} size={size} label="安装中" />);
    const circles = ring().querySelectorAll("circle");
    expect(circles).toHaveLength(2);
    for (const c of circles) expect(c.getAttribute("stroke-width")).toBe(String(stroke));
    const r = (size - stroke) / 2;
    expect(Number(circles[1].getAttribute("stroke-dasharray"))).toBeCloseTo(2 * Math.PI * r, 5);
  });

  it("只有 36 与 48 在圆心写百分数", () => {
    expect(ringHasLabel(16)).toBe(false);
    expect(ringHasLabel(24)).toBe(false);
    expect(ringHasLabel(36)).toBe(true);
    expect(ringHasLabel(48)).toBe(true);
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

  it("没有名称时抛错", () => {
    expect(() => render(<ProgressRing value={0.5} />)).toThrow(/label 或 labelledBy/);
  });
});
