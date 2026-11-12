// @vitest-environment jsdom
// Loadable 里要等退场播完的用例（内容退回加载、骨架的退场）。整个文件走真实计时器：退场要等 framer-motion 的帧循环把动画播完，
// 假定时器下它请求的帧不会到，帧循环停住之后同一文件里后面的用例也推不动它。
import { act } from "react";
import { afterEach, expect, it } from "vitest";
import type { LoadingView } from "../lib/loading-gate";
import { render, waitForFrames, type Rendered } from "../test/dom";
import { Loadable } from "./Loadable";

let view: Rendered | undefined;

afterEach(() => {
  view?.unmount();
  view = undefined;
});

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
  view = render(tree("pending"));
  view.rerender(tree("skeleton"));
  const layer = find("[data-skeleton]")?.parentElement;
  if (layer === null || layer === undefined) throw new Error("骨架没有挂上");
  await waitForFrames(() => expect(layer.style.opacity).toBe("1"));
  view.rerender(tree("content"));
  view.rerender(tree("pending"));
  view.rerender(tree("content"));
  // 一帧都还没走，骨架仍看得见：这一刻把它拿掉就是一帧消失
  expect(find("[data-skeleton]")?.parentElement).toBe(layer);
  expect(Number(layer.style.opacity)).toBeGreaterThan(0);
  await waitForFrames(() => expect(find("[data-skeleton]")).toBeNull());
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
