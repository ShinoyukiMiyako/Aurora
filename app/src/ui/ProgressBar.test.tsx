// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { MotionConfig, type MotionValue } from "framer-motion";
import { afterEach, describe, expect, it, vi } from "vitest";
import { drainFrames, render, stepFrames, waitForFrames, type Rendered } from "../test/dom";
import { fillOffset, MIN_VISIBLE_PROGRESS, nextProgressTarget, ProgressBar, useSmoothProgress } from "./ProgressBar";
import { ProgressRing, RING_EMPTY_TEXT, RING_PLACEHOLDER, RING_STROKE, ringHasLabel } from "./ProgressRing";

let view: Rendered | undefined;
/** 这个用例的帧跟着假时钟走（startFrameClock）：收尾先卸载、再在假时钟上把帧循环排空，才换回真实计时器。 */
let frameClock = false;
afterEach(async () => {
  view?.unmount();
  view = undefined;
  if (frameClock) await drainFrames();
  frameClock = false;
  vi.useRealTimers();
});

/**
 * 逐帧数填充走过几个中间值的用例让帧跟着假时钟走，用 stepFrames 逐帧推进。按真实时间走的话，机器满载时帧来得稀，
 * 弹簧落定之前录到的中间帧就少；弹簧起步那一帧与下一帧隔得比整段平滑还长时，一个中间值也录不到。
 * 换之前先在真实计时器上把帧循环排空（见 test/dom 的 drainFrames）。
 */
async function startFrameClock() {
  await drainFrames();
  vi.useFakeTimers();
  frameClock = true;
}

/** 进度平滑（settle 弹簧）在这么多帧（约 1 秒）之内落定。 */
const SETTLE_FRAMES = 60;

describe("进度推演", () => {
  it("同一标识内只增不减：小于当前目标的新值被忽略", () => {
    const start = nextProgressTarget({ track: "task#1", target: 0 }, "task#1", 0.6);
    expect(start).toEqual({ track: "task#1", target: 0.6, jump: false });
    expect(nextProgressTarget(start, "task#1", 0.3)).toEqual({ track: "task#1", target: 0.6, jump: false });
    expect(nextProgressTarget(start, "task#1", 0.75)).toEqual({ track: "task#1", target: 0.75, jump: false });
  });

  it("换了标识而当前目标大于 0：直接跳到新值，比旧值小也不从旧值往回滑", () => {
    expect(nextProgressTarget({ track: "task#1", target: 0.9 }, "task#2", 0.1)).toEqual({ track: "task#2", target: 0.1, jump: true });
    expect(nextProgressTarget({ track: "task#1", target: 0.3 }, "task#2", 0.8)).toEqual({ track: "task#2", target: 0.8, jump: true });
  });

  // 第一条下载快照带来总字节与文件数，标识随之从「还没有批次」换成这一批：从空开始的首批要沿弹簧走上去
  it("换了标识而当前目标是 0（首批从空开始）：不跳，新值交给弹簧；一次下完的小批次也一样", () => {
    expect(nextProgressTarget({ track: "t#1:count:0", target: 0 }, "t#1:4096:3", 0.2)).toEqual({ track: "t#1:4096:3", target: 0.2, jump: false });
    expect(nextProgressTarget({ track: "t#1:count:0", target: 0 }, "t#1:512:1", 1)).toEqual({ track: "t#1:512:1", target: 1, jump: false });
  });

  it("没有标识时原样跟随，可以回退", () => {
    expect(nextProgressTarget({ track: undefined, target: 0.9 }, undefined, 0.2)).toEqual({ track: undefined, target: 0.2, jump: false });
  });

  it("超出 [0, 1] 截断（重传字节可能超过声明大小），NaN 抛错", () => {
    expect(nextProgressTarget({ track: "a", target: 0 }, "a", 1.37).target).toBe(1);
    expect(nextProgressTarget({ track: undefined, target: 0.5 }, undefined, -0.2).target).toBe(0);
    expect(() => nextProgressTarget({ track: "a", target: 0 }, "a", Number.NaN)).toThrow(/NaN/);
  });

  // 弹簧补满时会略冲过 1：不截断的话位移变正，填充左缘离开轨道左端、露出一道缝
  it("填充位移为 (p − 1) × 100%，截断到 [0, 1]，不加最少显示长度", () => {
    expect(fillOffset(0.25)).toBe("-75%");
    expect(fillOffset(1)).toBe("0%");
    expect(fillOffset(0)).toBe("-100%");
    expect(fillOffset(1.0015)).toBe("0%");
    expect(fillOffset(-0.2)).toBe("-100%");
    expect(fillOffset(MIN_VISIBLE_PROGRESS / 4)).toBe("-99.5%");
    const p = 0.05 + Math.random() * 0.9;
    expect(Number.parseFloat(fillOffset(p))).toBeCloseTo((p - 1) * 100, 9);
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

  // 调用方在同一组件里接着用 useTransform 派生文字与位移，它每次渲染都在布局阶段退订再重订：跳变不能落在这个空当里
  it("跳到的新值也画到同组件派生的文字与位移上：减少动画下不慢一次上报，换标识后不停在上一个任务的进度", async () => {
    const reducedRing = (value: number) => (
      <MotionConfig reducedMotion="always">
        <ProgressRing value={value} size={36} track="t" label="下载" />
      </MotionConfig>
    );
    view = render(reducedRing(0.6));
    view.rerender(reducedRing(0.8));
    await waitForFrames(() => expect(view?.container.textContent).toBe("80%"));
    view.unmount();

    const bar = (value: number, track: string) => (
      <MotionConfig reducedMotion="never">
        <ProgressBar value={value} track={track} label="安装" />
      </MotionConfig>
    );
    view = render(bar(0.9, "t#1"));
    view.rerender(bar(0.1, "t#2"));
    const fill = view.container.querySelector<HTMLElement>('[role="progressbar"] > span');
    if (fill === null) throw new Error("进度条没有填充");
    await waitForFrames(() => expect(fill.style.transform).toBe("translateX(-90%)"));
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

  it("给了最少显示长度：大于 0 的目标在终点上抬到它，0 仍是 0；返回的 target 照原值", () => {
    let floored: { smooth: MotionValue<number>; target: number } | undefined;
    function FloorProbe({ value }: { value: number }) {
      floored = useSmoothProgress(value, "s", MIN_VISIBLE_PROGRESS);
      return null;
    }
    const read = () => {
      if (floored === undefined) throw new Error("探针未挂载");
      return { smooth: floored.smooth.get(), target: floored.target };
    };
    view = render(<FloorProbe value={0.005} />);
    expect(read()).toEqual({ smooth: MIN_VISIBLE_PROGRESS, target: 0.005 });
    view.unmount();
    view = render(<FloorProbe value={0} />);
    expect(read()).toEqual({ smooth: 0, target: 0 });
    view.unmount();
    view = render(
      <MotionConfig reducedMotion="always">
        <FloorProbe value={0.5} />
      </MotionConfig>,
    );
    view.rerender(
      <MotionConfig reducedMotion="always">
        <FloorProbe value={0.6} />
      </MotionConfig>,
    );
    expect(read()).toEqual({ smooth: 0.6, target: 0.6 });
  });

  it("完整动画下首批从 0 起：换了标识也交给弹簧，同步读取仍是 0", () => {
    view = render(
      <MotionConfig reducedMotion="never">
        <Probe value={0} track="t#1:count:0" />
      </MotionConfig>,
    );
    view.rerender(
      <MotionConfig reducedMotion="never">
        <Probe value={0.6} track="t#1:4096:3" />
      </MotionConfig>,
    );
    expect(latest()).toBe(0);
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

  it("首批快照就到 100%（一次下完的小文件）：填充从空一帧帧走到满格，不从空直接跳满", async () => {
    await startFrameClock();
    const at = (value: number, track: string) => (
      <MotionConfig reducedMotion="never">
        <ProgressBar value={value} track={track} label="安装" />
      </MotionConfig>
    );
    view = render(at(0, "t#1:count:0"));
    const fill = bar().firstElementChild as HTMLElement;
    // 位移归零时 framer-motion 把 transform 写成 none
    const offset = () => (fill.style.transform === "none" ? 0 : Number.parseFloat(fill.style.transform.replace("translateX(", "")));
    expect(offset()).toBe(-100);
    const offsets: number[] = [];
    const observer = new MutationObserver(() => offsets.push(offset()));
    observer.observe(fill, { attributes: true, attributeFilter: ["style"] });
    view.rerender(at(1, "t#1:512:1"));
    expect(bar().getAttribute("aria-valuenow")).toBe("100");
    await stepFrames(SETTLE_FRAMES);
    expect(offset()).toBe(0);
    observer.disconnect();
    // 一帧一个中间值，只往满格走、不回退
    expect(offsets.filter((o) => o > -100 && o < -1).length).toBeGreaterThan(5);
    for (let i = 1; i < offsets.length; i++) expect(offsets[i]).toBeGreaterThanOrEqual(offsets[i - 1]);
  });

  // 最少显示长度要是加在逐帧平滑之后，弹簧离开 0 的第一帧就一下冒出 2% 那一截
  it("起步时填充从空一帧帧长到最少显示的 2%，不一下冒出那一截；读屏仍报原值", async () => {
    await startFrameClock();
    const at = (value: number) => (
      <MotionConfig reducedMotion="never">
        <ProgressBar value={value} track="t#1" label="安装" />
      </MotionConfig>
    );
    view = render(at(0));
    const fill = bar().firstElementChild as HTMLElement;
    const offset = () => Number.parseFloat(fill.style.transform.replace("translateX(", ""));
    expect(offset()).toBe(-100);
    const offsets: number[] = [];
    const observer = new MutationObserver(() => offsets.push(offset()));
    observer.observe(fill, { attributes: true, attributeFilter: ["style"] });
    view.rerender(at(0.005));
    expect(bar().getAttribute("aria-valuenow")).toBe("1");
    await stepFrames(SETTLE_FRAMES);
    expect(offset()).toBeCloseTo(-98, 3);
    observer.disconnect();
    // 动起来的第一帧只长出那一截的零头，之后一帧帧长上去
    expect(offsets[0]).toBeGreaterThan(-100);
    expect(offsets[0]).toBeLessThan(-99);
    expect(offsets.filter((o) => o > -100 && o < -98.01).length).toBeGreaterThan(5);
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

  // 减少动画下平滑值直接跳到目标：不停住的弧在下一帧就会退回起点。同屏另一只环跳到新值，说明那一帧已经渲染过
  it("转为没有进度时填充弧不在那一帧移除，停在原位淡出，不随占位的 0 往回走", async () => {
    const circumference = 2 * Math.PI * ((84 - 7) / 2);
    const pair = (a: number | null, b: number) => (
      <MotionConfig reducedMotion="always">
        <span data-ring="a">
          <ProgressRing value={a} size={84} tone={a === null ? "muted" : "accent"} label="下载总进度" />
        </span>
        <span data-ring="b">
          <ProgressRing value={b} size={84} label="对照" />
        </span>
      </MotionConfig>
    );
    const fillIn = (name: string) => {
      const fill = view?.container.querySelectorAll(`[data-ring="${name}"] circle`)[1];
      if (fill === undefined) throw new Error(`进度环 ${name} 没有填充弧`);
      return fill;
    };
    const offsetOf = (el: Element) => Number(el.getAttribute("stroke-dashoffset"));
    view = render(pair(0.6, 0.6));
    const fill = fillIn("a");
    expect(offsetOf(fill)).toBeCloseTo(circumference * 0.4, 5);
    view.rerender(pair(null, 0.3));
    expect(emptyRing().textContent).toBe("--");
    expect(fillIn("a")).toBe(fill);
    await waitForFrames(() => expect(offsetOf(fillIn("b"))).toBeCloseTo(circumference * 0.7, 3));
    expect(offsetOf(fill)).toBeCloseTo(circumference * 0.4, 5);
  });

  it("挂载时就有进度的填充弧直接显示；挂载之后才出现的从透明淡入", () => {
    // SVG 元素上 framer-motion 把透明度写成属性
    view = render(<ProgressRing value={0.5} size={36} label="下载" />);
    expect(ring().querySelectorAll("circle")[1].getAttribute("opacity")).toBe("1");
    view.unmount();
    view = render(<ProgressRing value={0} size={36} label="下载" />);
    view.rerender(<ProgressRing value={0.5} size={36} label="下载" />);
    expect(ring().querySelectorAll("circle")[1].getAttribute("opacity")).toBe("0");
  });
});

describe("进度填充的样式", () => {
  const strip = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, "");
  const ruleOf = (file: string, selector: string) => {
    const css = strip(readFileSync(new URL(file, import.meta.url), "utf8"));
    const rule = new RegExp(`(?:^|\\n)${selector.replace(".", "\\.")} \\{([^}]*)\\}`).exec(css);
    if (rule === null) throw new Error(`${file} 里没有 ${selector} 规则`);
    return rule[1];
  };

  it("确定进度条的填充不常驻 will-change：任务页几十行会各占一个合成层；循环的光带照常保留", () => {
    expect(ruleOf("./ProgressBar.module.css", ".fill")).not.toContain("will-change");
    expect(ruleOf("./ProgressBar.module.css", ".indeterminate")).toContain("will-change: transform");
  });

  it("进度环换色调时描边色与圆心字色一次性过渡", () => {
    expect(ruleOf("./ProgressRing.module.css", ".fill")).toContain("transition: stroke var(--sk-dur-hover) var(--sk-ease)");
    expect(ruleOf("./ProgressRing.module.css", ".label")).toContain("transition: color var(--sk-dur-hover) var(--sk-ease)");
  });
});
