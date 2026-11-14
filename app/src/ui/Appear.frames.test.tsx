// @vitest-environment jsdom
// Appear 逐帧看入场从哪一帧开始走的用例。整个文件走假时钟、用 stepFrames 一帧一帧地推：
// 每个用例开始前先在真实计时器上把帧循环排空再换假时钟，收尾先卸载、再排空、再换回真实计时器（见 test/dom 的 drainFrames）。
import { MotionConfig, type Transition } from "framer-motion";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { fade } from "../lib/motion";
import { drainFrames, render, stepFrames, type Rendered } from "../test/dom";
import { Appear } from "./Appear";

let view: Rendered | undefined;

beforeEach(async () => {
  await drainFrames();
  vi.useFakeTimers();
});

afterEach(async () => {
  view?.unmount();
  view = undefined;
  await drainFrames();
  vi.useRealTimers();
});

const tree = (show: boolean, reducedMotion: "never" | "always" = "never", initial?: boolean) => (
  <MotionConfig reducedMotion={reducedMotion}>
    <Appear initial={initial}>{show && <p data-note="">提示</p>}</Appear>
  </MotionConfig>
);

const wrap = (): HTMLElement => {
  const el = view?.container.querySelector<HTMLElement>("[data-note]")?.parentElement;
  if (el === null || el === undefined) throw new Error("子项没有挂上");
  return el;
};

it.each([
  ["之后才出现的子项", "never", undefined],
  ["之后才出现的子项", "always", undefined],
  ["initial 为真时挂载时就在的子项", "never", true],
] as const)("%s（减少动画 %s）：第一帧画的仍是起点，画出来之后才开始入场，挂载那一帧再长也不吃掉入场的开头", async (who, reducedMotion, initial) => {
  if (who === "之后才出现的子项") {
    view = render(tree(false, reducedMotion));
    view.rerender(tree(true, reducedMotion));
  } else {
    view = render(tree(true, reducedMotion, initial));
  }
  const scaled = reducedMotion === "never";
  await stepFrames(1);
  expect(wrap().style.opacity).toBe("0");
  expect(wrap().style.transform).toBe(scaled ? "scale(0.98)" : "");
  // 放行排在绘制之后的任务里，假时钟要再推进一帧才到点
  await stepFrames(2);
  const opacity = Number(wrap().style.opacity);
  expect(opacity).toBeGreaterThan(0);
  expect(opacity).toBeLessThan(1);
  if (scaled) {
    const scale = /^scale\((.+)\)$/.exec(wrap().style.transform);
    if (scale === null) throw new Error(`子项没有在落到位的半路上：${wrap().style.transform}`);
    expect(Number(scale[1])).toBeGreaterThan(0.98);
    expect(Number(scale[1])).toBeLessThan(1);
  } else {
    // 减少动画时只有透明度在走
    expect(wrap().style.transform).toBe("");
  }
  await stepFrames(60);
  expect(wrap().style.opacity).toBe("1");
  expect(wrap().style.transform).toBe(scaled ? "none" : "");
});

it("画出第一帧之前就撤掉的子项：还停在看不见的起点，不播退场，随即移除；入场起步之后再撤掉的照常留在原处淡出", async () => {
  view = render(tree(false));
  view.rerender(tree(true));
  const early = wrap();
  view.rerender(tree(false));
  await stepFrames(1);
  expect(early.isConnected).toBe(false);

  view.rerender(tree(true));
  await stepFrames(3);
  const late = wrap();
  expect(Number(late.style.opacity)).toBeGreaterThan(0);
  view.rerender(tree(false));
  await stepFrames(1);
  expect(late.isConnected).toBe(true);
  expect(late.hasAttribute("inert")).toBe(true);
  await stepFrames(60);
  expect(late.isConnected).toBe(false);
});

const tuned = (show: boolean, motion: { exitTransition?: Transition; enterDelay?: number } = {}) => (
  <MotionConfig reducedMotion="never">
    <Appear exitTransition={motion.exitTransition} enterDelay={motion.enterDelay}>
      {show && <p data-note="">提示</p>}
    </Appear>
  </MotionConfig>
);

it("撤掉的那次渲染给了 exitTransition：按它退场，fade.none 时第一帧就不在了，不留在原处淡出", async () => {
  view = render(tuned(true));
  const el = wrap();
  view.rerender(tuned(false, { exitTransition: fade.none }));
  await stepFrames(1);
  expect(el.isConnected).toBe(false);
});

it("exitTransition 只认撤掉那一次渲染给的：之前给过、撤掉时不给的照常原地淡出", async () => {
  view = render(tuned(true, { exitTransition: fade.none }));
  const el = wrap();
  view.rerender(tuned(false));
  await stepFrames(1);
  expect(el.isConnected).toBe(true);
  expect(el.hasAttribute("inert")).toBe(true);
  await stepFrames(3);
  const opacity = Number(el.style.opacity);
  expect(opacity).toBeGreaterThan(0);
  expect(opacity).toBeLessThan(1);
  await stepFrames(60);
  expect(el.isConnected).toBe(false);
});

it("给了 enterDelay 的子项：画出第一帧之后再停这么久才开始入场，透明度与缩放一起晚起步", async () => {
  view = render(tuned(false));
  view.rerender(tuned(true, { enterDelay: 0.1 }));
  // 不带延迟时第 3 帧已在入场半路上（见第一条用例）；放行之后再停 100 ms，约 6 帧
  await stepFrames(3);
  expect(wrap().style.opacity).toBe("0");
  expect(wrap().style.transform).toBe("scale(0.98)");
  await stepFrames(4);
  expect(wrap().style.opacity).toBe("0");
  expect(wrap().style.transform).toBe("scale(0.98)");
  await stepFrames(4);
  const opacity = Number(wrap().style.opacity);
  expect(opacity).toBeGreaterThan(0);
  expect(opacity).toBeLessThan(1);
  expect(wrap().style.transform).not.toBe("scale(0.98)");
  await stepFrames(60);
  expect(wrap().style.opacity).toBe("1");
  expect(wrap().style.transform).toBe("none");
});

it("挂载时就在的子项：Appear 之后再渲染也不退回起点重新入场", async () => {
  view = render(tree(true));
  expect(wrap().style.opacity).toBe("1");
  // 挂载之后 Appear 每次渲染给子项的 own 都为真，挂载时就在的这一项不能因此当成新出现的
  view.rerender(tree(true));
  await stepFrames(3);
  expect(wrap().style.opacity).toBe("1");
  expect(wrap().style.transform).toBe("none");
});
