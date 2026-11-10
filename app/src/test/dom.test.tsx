// @vitest-environment jsdom
import { motion } from "framer-motion";
import { afterEach, describe, expect, it, vi } from "vitest";
import { drainFrames, render, stepFrames, stubSpanAnimations, waitForFrames, type Rendered } from "./dom";

let view: Rendered | undefined;

afterEach(async () => {
  view?.unmount();
  view = undefined;
  await drainFrames();
  vi.useRealTimers();
});

const fadeIn = (id: string, seconds: number) => (
  <motion.div data-testid={id} initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: seconds, ease: "linear" }} />
);

function box(id: string): HTMLElement {
  const el = view?.container.querySelector<HTMLElement>(`[data-testid="${id}"]`);
  if (el === null || el === undefined) throw new Error(`没有渲染出动画元素 ${id}`);
  return el;
}

describe("waitForFrames", () => {
  it("一直等到 framer-motion 在真实帧上把动画播到终值", async () => {
    view = render(fadeIn("box", 0.1));
    expect(box("box").style.opacity).toBe("0");
    await waitForFrames(() => expect(box("box").style.opacity).toBe("1"));
  });

  it("假定时器下直接报错，不拿推进假时钟冒充等帧", async () => {
    vi.useFakeTimers();
    const assertion = vi.fn();
    await expect(waitForFrames(assertion)).rejects.toThrow("waitForFrames 要在真实计时器下用");
    expect(assertion).not.toHaveBeenCalled();
  });
});

describe("stepFrames", () => {
  it("假定时器下每步恰好走一帧：160 ms 的线性淡入相邻两帧差 0.1，十一帧之后到终值", async () => {
    vi.useFakeTimers();
    view = render(fadeIn("box", 0.16));
    expect(box("box").style.opacity).toBe("0");
    await stepFrames(1);
    // 动画的起点是挂载那一刻还是第一帧由 framer-motion 定，这里只比相邻两帧：一步走两帧或一帧不走都会差出来
    const first = Number(box("box").style.opacity);
    await stepFrames(1);
    expect(Number(box("box").style.opacity) - first).toBeCloseTo(0.1, 5);
    await stepFrames(9);
    expect(box("box").style.opacity).toBe("1");
  });

  it("真实计时器下直接报错", async () => {
    await expect(stepFrames(1)).rejects.toThrow("stepFrames 要在假定时器下用");
  });
});

describe("stubSpanAnimations", () => {
  it("只给 span 装上 animate，不碰 Element.prototype；记下调用，播完时触发 onfinish；卸下后还原", () => {
    const waapi = stubSpanAnimations();
    const span = document.createElement("span");
    expect(typeof span.animate).toBe("function");
    expect(typeof document.createElement("div").animate).toBe("undefined");
    expect(Object.hasOwn(Element.prototype, "animate")).toBe(false);

    const animation = span.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 120 });
    const done = vi.fn();
    animation.onfinish = done;
    expect(waapi.played).toHaveLength(1);
    expect(waapi.running(span, "opacity")).toBe(animation);
    waapi.finish(waapi.running(span, "opacity"));
    expect(done).toHaveBeenCalledTimes(1);
    expect(animation.currentTime).toBe(120);
    expect(() => waapi.running(span, "opacity")).toThrow("在播的 opacity 动画有 0 个");

    waapi.restore();
    expect(typeof span.animate).toBe("undefined");
  });
});

describe("drainFrames", () => {
  it("真实时间上还排着帧时卸载并排空，换上假时钟后第一步就推得动", async () => {
    view = render(fadeIn("long", 5));
    await waitForFrames(() => expect(Number(box("long").style.opacity)).toBeGreaterThan(0));
    view.unmount();
    view = undefined;
    await drainFrames();
    vi.useFakeTimers();

    view = render(fadeIn("next", 0.16));
    await stepFrames(2);
    expect(Number(box("next").style.opacity)).toBeGreaterThan(0);
  });

  it("假时钟上还排着帧时卸载并排空，换回真实计时器后帧循环照常走", async () => {
    vi.useFakeTimers();
    view = render(fadeIn("long", 5));
    await stepFrames(2);
    expect(Number(box("long").style.opacity)).toBeLessThan(1);
    view.unmount();
    view = undefined;
    await drainFrames();
    vi.useRealTimers();

    view = render(fadeIn("next", 0.1));
    await waitForFrames(() => expect(box("next").style.opacity).toBe("1"));
  });

  it("还有动画在跑时排不空，到上限报错", async () => {
    vi.useFakeTimers();
    view = render(<motion.div data-testid="spin" animate={{ rotate: 360 }} transition={{ duration: 1, ease: "linear", repeat: Infinity }} />);
    await expect(drainFrames()).rejects.toThrow("仍没停下");
  });
});
