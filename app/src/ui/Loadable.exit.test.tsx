// @vitest-environment jsdom
// Loadable 里要等退场播完的用例（内容退回加载、骨架的退场）。只看播没播完的用例走真实计时器，用 waitForFrames 等帧循环把动画播完；
// 要在退场途中某一刻拉回、断言那一刻取值的用例走假时钟（startFrameClock），用 stepFrames 逐帧推进。
import { act } from "react";
import { afterEach, expect, it, vi } from "vitest";
import type { LoadingView } from "../lib/loading-gate";
import { drainFrames, render, stepFrames, waitForFrames, type Rendered } from "../test/dom";
import { Loadable } from "./Loadable";

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
 * 断言退场途中某一刻取值的用例让帧跟着假时钟走。按真实时间走的话，机器满载时两帧之间隔得比淡出（120 ms）还长，
 * 下一帧就直接把退场播完、骨架已经撤下，轮询等不到半透明的那一刻；拉回之后往 0 走的那一段（200 ms）同理。
 * 换之前先在真实计时器上把帧循环排空（见 test/dom 的 drainFrames）。
 */
async function startFrameClock() {
  await drainFrames();
  vi.useFakeTimers();
  frameClock = true;
}

/** 骨架的淡入（200 ms）与淡出（120 ms）在这么多帧（约 1 秒）之内都落定。 */
const SETTLE_FRAMES = 60;

const tree = (state: LoadingView) => (
  <Loadable view={state} skeleton={<span data-skeleton="" />}>
    {() => <p data-content="">内容</p>}
  </Loadable>
);

const find = (selector: string): HTMLElement | null => {
  if (view === undefined) throw new Error("还没有渲染");
  return view.container.querySelector<HTMLElement>(selector);
};

it("从内容直接退回骨架：内容淡完后移除，骨架淡入到不透明", async () => {
  view = render(tree("content"));
  view.rerender(tree("skeleton"));
  const layer = find("[data-skeleton]")?.parentElement;
  if (layer === null || layer === undefined) throw new Error("骨架没有挂上");
  expect(layer.style.opacity).toBe("0");
  await waitForFrames(() => {
    expect(find("[data-content]")).toBeNull();
    expect(layer.style.opacity).toBe("1");
  });
});

it("从内容退回等待期：内容播完淡出才移除，骨架一直不可见地占位", async () => {
  view = render(tree("content"));
  view.rerender(tree("pending"));
  // 没有退场的话，framer-motion 在微任务里就报退场完成、当场移除；淡出要等帧循环，至少还在这一刻
  await act(async () => {});
  expect(find("[data-content]")?.parentElement?.hasAttribute("inert")).toBe(true);
  await waitForFrames(() => expect(find("[data-content]")).toBeNull());
  const layer = find("[data-skeleton]")?.parentElement;
  expect(layer?.hasAttribute("data-pending")).toBe(true);
  expect(layer?.style.opacity).toBe("0");
});

it("上一段骨架退场播完、这一段一直停在等待期：内容到达时照样同一次提交里直接拿掉", async () => {
  view = render(tree("skeleton"));
  view.rerender(tree("content"));
  await waitForFrames(() => expect(find("[data-skeleton]")).toBeNull());
  view.rerender(tree("pending"));
  expect(find("[data-skeleton]")?.parentElement?.hasAttribute("data-pending")).toBe(true);
  view.rerender(tree("content"));
  expect(find("[data-skeleton]")).toBeNull();
});

it("骨架退场途中被拉回等待期、内容又到：骨架留在原处接着淡出，不在半透明时同一次提交里消失", async () => {
  await startFrameClock();
  view = render(tree("pending"));
  view.rerender(tree("skeleton"));
  const layer = find("[data-skeleton]")?.parentElement;
  if (layer === null || layer === undefined) throw new Error("骨架没有挂上");
  await stepFrames(SETTLE_FRAMES);
  expect(layer.style.opacity).toBe("1");
  view.rerender(tree("content"));
  // 退场等内容画出第一帧才起步，起步之后再走几帧：停在半透明时拉回
  await stepFrames(5);
  const exiting = Number(layer.style.opacity);
  expect(exiting).toBeGreaterThan(0);
  expect(exiting).toBeLessThan(1);
  view.rerender(tree("pending"));
  await act(async () => {});
  expect(find("[data-skeleton]")?.parentElement).toBe(layer);
  expect(layer.hasAttribute("data-pending")).toBe(true);
  // 拉回之后接着往 0 走了几帧，还没走到 0
  await stepFrames(2);
  const pulled = Number(layer.style.opacity);
  expect(pulled).toBeLessThan(exiting);
  expect(pulled).toBeGreaterThan(0);
  view.rerender(tree("content"));
  // 骨架仍半透明：这一刻把它拿掉就是一帧消失
  expect(find("[data-skeleton]")?.parentElement).toBe(layer);
  expect(Number(layer.style.opacity)).toBe(pulled);
  // 之后逐帧接着往 0 走，不回升；走到 0 才撤下，途中哪一帧都没有在半透明时消失
  let last = pulled;
  for (let i = 0; i < SETTLE_FRAMES && find("[data-skeleton]") !== null; i++) {
    await stepFrames(1);
    const now = Number(layer.style.opacity);
    expect(now).toBeLessThanOrEqual(last);
    last = now;
  }
  expect(find("[data-skeleton]")).toBeNull();
  expect(layer.style.opacity).toBe("0");
});

it("骨架退场途中被拉回等待期、已经淡到 0 之后内容才到：同一次提交里直接拿掉，不再播一段看不见的退场", async () => {
  view = render(tree("pending"));
  view.rerender(tree("skeleton"));
  const layer = find("[data-skeleton]")?.parentElement;
  if (layer === null || layer === undefined) throw new Error("骨架没有挂上");
  await waitForFrames(() => expect(layer.style.opacity).toBe("1"));
  view.rerender(tree("content"));
  await waitForFrames(() => expect(Number(layer.style.opacity)).toBeLessThan(1));
  view.rerender(tree("pending"));
  await waitForFrames(() => expect(layer.style.opacity).toBe("0"));
  expect(find("[data-skeleton]")?.parentElement).toBe(layer);
  expect(layer.hasAttribute("data-pending")).toBe(true);
  view.rerender(tree("content"));
  expect(find("[data-skeleton]")).toBeNull();
  expect(find("[data-content]")?.parentElement?.hasAttribute("inert")).toBe(false);
});

it("骨架显出来过、调用方直接把它退回等待期：淡到 0 之后内容到达，同样同一次提交里拿掉", async () => {
  view = render(tree("skeleton"));
  const layer = find("[data-skeleton]")?.parentElement;
  if (layer === null || layer === undefined) throw new Error("骨架没有挂上");
  expect(layer.style.opacity).toBe("1");
  view.rerender(tree("pending"));
  await waitForFrames(() => expect(layer.style.opacity).toBe("0"));
  expect(find("[data-skeleton]")?.parentElement).toBe(layer);
  view.rerender(tree("content"));
  expect(find("[data-skeleton]")).toBeNull();
});

it("骨架显出来过、内容到达：骨架淡出播完撤下的前后，内容函数只求值一次，内容子树不重渲染", async () => {
  let renders = 0;
  function Content() {
    renders++;
    return <p data-content="">内容</p>;
  }
  const children = vi.fn(() => <Content />);
  const at = (state: LoadingView) => (
    <Loadable view={state} skeleton={<span data-skeleton="" />}>
      {children}
    </Loadable>
  );
  view = render(at("skeleton"));
  view.rerender(at("content"));
  expect(children).toHaveBeenCalledTimes(1);
  expect(renders).toBe(1);
  // 骨架撤下与退场播完的回调在同一次更新里提交：DOM 里没有骨架时，回调引起的重渲染也已经提交
  await waitForFrames(() => expect(find("[data-skeleton]")).toBeNull());
  expect(find("[data-content]")?.textContent).toBe("内容");
  expect(children).toHaveBeenCalledTimes(1);
  expect(renders).toBe(1);
});

it("重新加载再回来：旧内容淡完移除之后，新的内容层从透明淡入", async () => {
  view = render(tree("content"));
  const old = find("[data-content]");
  view.rerender(tree("pending"));
  await waitForFrames(() => expect(find("[data-content]")).toBeNull());
  view.rerender(tree("content"));
  const fresh = find("[data-content]");
  expect(fresh).not.toBe(old);
  expect(fresh?.parentElement?.hasAttribute("inert")).toBe(false);
  expect(fresh?.parentElement?.style.opacity).toBe("0");
  expect(find("[data-skeleton]")).toBeNull();
});
