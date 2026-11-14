// @vitest-environment jsdom
// Loadable 逐帧看入场从哪一帧开始走的用例。整个文件走假时钟、用 stepFrames 一帧一帧地推：
// 每个用例开始前先在真实计时器上把帧循环排空再换假时钟，收尾先卸载、再排空、再换回真实计时器（见 test/dom 的 drainFrames）。
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { LoadingView } from "../lib/loading-gate";
import { drainFrames, render, stepFrames, type Rendered } from "../test/dom";
import { Loadable } from "./Loadable";

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

const tree = (state: LoadingView) => (
  <Loadable view={state} skeleton={<span data-skeleton="" />}>
    {() => <p data-content="">内容</p>}
  </Loadable>
);

const contentLayer = (): HTMLElement => {
  const layer = view?.container.querySelector<HTMLElement>("[data-content]")?.parentElement;
  if (layer === null || layer === undefined) throw new Error("内容层没有挂上");
  return layer;
};
const skeletonLayer = (): HTMLElement | null => view?.container.querySelector<HTMLElement>("[data-skeleton]")?.parentElement ?? null;

it.each(["pending", "skeleton"] as const)("从 %s 等到内容：第一帧画的仍是透明，画出来之后才开始淡入，挂载那一帧再长也不吃掉淡入的开头", async (waiting) => {
  view = render(tree(waiting));
  view.rerender(tree("content"));
  expect(contentLayer().style.opacity).toBe("0");
  await stepFrames(1);
  expect(contentLayer().style.opacity).toBe("0");
  // 放行排在绘制之后的任务里，假时钟要再推进一帧才到点
  await stepFrames(2);
  const opacity = Number(contentLayer().style.opacity);
  expect(opacity).toBeGreaterThan(0);
  expect(opacity).toBeLessThan(1);
  await stepFrames(60);
  expect(contentLayer().style.opacity).toBe("1");
});

it("骨架显出来过、内容到达：骨架照常脱离布局，退场也等第一帧画出来才开始，与内容层的淡入同一刻起步", async () => {
  view = render(tree("skeleton"));
  const skeleton = skeletonLayer();
  if (skeleton === null) throw new Error("骨架没有挂上");
  expect(skeleton.style.opacity).toBe("1");
  // jsdom 不做布局：给骨架层一个尺寸，popLayout 量得到它才会把它抽出布局
  skeleton.style.width = "320px";
  skeleton.style.height = "96px";
  view.rerender(tree("content"));
  expect(skeletonLayer()).toBe(skeleton);
  expect(skeleton.dataset.motionPopId).toBeDefined();
  // 第一帧画的是交叉淡化的起点：骨架还不透明，内容还透明
  await stepFrames(1);
  expect(skeleton.style.opacity).toBe("1");
  expect(contentLayer().style.opacity).toBe("0");
  await stepFrames(2);
  const leaving = Number(skeleton.style.opacity);
  expect(leaving).toBeGreaterThan(0);
  expect(leaving).toBeLessThan(1);
  expect(Number(contentLayer().style.opacity)).toBeGreaterThan(0);
  await stepFrames(60);
  expect(skeletonLayer()).toBeNull();
  expect(contentLayer().style.opacity).toBe("1");
});

it.each([
  ["第一次挂载就是骨架", "skeleton"],
  ["内容出现过之后才挂上的骨架", "content"],
] as const)("%s淡出途中又退回骨架：同一层从半透明接着淡回不透明，不先跳回透明", async (_, first) => {
  view = render(tree(first));
  if (first === "content") view.rerender(tree("skeleton"));
  await stepFrames(30);
  const skeleton = skeletonLayer();
  if (skeleton === null) throw new Error("骨架没有挂上");
  expect(skeleton.style.opacity).toBe("1");
  view.rerender(tree("content"));
  await stepFrames(5);
  const leaving = Number(skeleton.style.opacity);
  expect(leaving).toBeGreaterThan(0);
  expect(leaving).toBeLessThan(1);
  view.rerender(tree("skeleton"));
  expect(skeletonLayer()).toBe(skeleton);
  await stepFrames(1);
  expect(Number(skeleton.style.opacity)).toBeGreaterThan(leaving);
  await stepFrames(60);
  expect(skeleton.style.opacity).toBe("1");
});

it("等过加载的内容画出第一帧之前又退回加载：它还停在看不见的透明处，不播退场，随即移除", async () => {
  view = render(tree("skeleton"));
  view.rerender(tree("content"));
  const layer = contentLayer();
  view.rerender(tree("skeleton"));
  await stepFrames(1);
  expect(layer.isConnected).toBe(false);
  expect(view.container.querySelector("[data-content]")).toBeNull();
});

it("一挂上就是内容的那一层退回加载、淡完之前内容又回来：接着往不透明走，不先退回透明再等一帧", async () => {
  view = render(tree("content"));
  const layer = contentLayer();
  view.rerender(tree("pending"));
  await stepFrames(3);
  const fading = Number(layer.style.opacity);
  expect(fading).toBeGreaterThan(0);
  expect(fading).toBeLessThan(1);
  view.rerender(tree("content"));
  expect(contentLayer()).toBe(layer);
  await stepFrames(1);
  expect(Number(layer.style.opacity)).toBeGreaterThan(fading);
  await stepFrames(60);
  expect(layer.style.opacity).toBe("1");
});

it("as 为 span：根与两层都是 span，放得进段落；骨架换内容的交叉淡化与 div 版同一帧起步、逐帧相同", async () => {
  const both = (state: LoadingView) => (
    <>
      <p>
        <Loadable as="span" view={state} skeleton={<i data-skeleton="span" />}>
          {() => <b data-content="span">内容</b>}
        </Loadable>
      </p>
      <Loadable view={state} skeleton={<i data-skeleton="div" />}>
        {() => <b data-content="div">内容</b>}
      </Loadable>
    </>
  );
  const layer = (selector: string): HTMLElement => {
    const el = view?.container.querySelector<HTMLElement>(selector)?.parentElement;
    if (el === null || el === undefined) throw new Error(`${selector} 所在的层不在`);
    return el;
  };
  view = render(both("skeleton"));
  const spanSkeleton = layer('[data-skeleton="span"]');
  const divSkeleton = layer('[data-skeleton="div"]');
  view.rerender(both("content"));
  const spanContent = layer('[data-content="span"]');
  const divContent = layer('[data-content="div"]');
  expect([spanSkeleton.parentElement?.tagName, spanSkeleton.tagName, spanContent.tagName]).toEqual(["SPAN", "SPAN", "SPAN"]);
  expect(spanSkeleton.parentElement?.parentElement?.tagName).toBe("P");
  expect([divSkeleton.parentElement?.tagName, divSkeleton.tagName, divContent.tagName]).toEqual(["DIV", "DIV", "DIV"]);
  const sample = (skeleton: HTMLElement, content: HTMLElement) => [skeleton.isConnected ? skeleton.style.opacity : null, content.style.opacity];
  await stepFrames(1);
  expect(sample(spanSkeleton, spanContent)).toEqual(["1", "0"]);
  const spanSeen: (string | null)[][] = [];
  for (let i = 0; i < 20; i++) {
    await stepFrames(1);
    const span = sample(spanSkeleton, spanContent);
    expect(span).toEqual(sample(divSkeleton, divContent));
    spanSeen.push(span);
  }
  expect(spanSeen.some(([, content]) => Number(content) > 0 && Number(content) < 1)).toBe(true);
  expect(sample(spanSkeleton, spanContent)).toEqual([null, "1"]);
});
