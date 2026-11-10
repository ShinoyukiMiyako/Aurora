// @vitest-environment jsdom
// 换分区时托住分区布局的高度。jsdom 不做布局：滚动区与布局的尺寸按真实页面里的关系直接给出。
import { afterEach, describe, expect, it } from "vitest";
import { holdScroll, scrollParent } from "./scroll-hold";

interface Scene {
  scroller: HTMLElement;
  layout: HTMLElement;
}

/** 滚动区里一个布局块：滚动区可视高 view，内容总高 content，滚在 top；布局块高 height。 */
function scene({ view, content, top, height }: { view: number; content: number; top: number; height: number }): Scene {
  const scroller = document.createElement("div");
  scroller.style.overflowY = "auto";
  const page = document.createElement("div");
  const layout = document.createElement("div");
  page.append(layout);
  scroller.append(page);
  document.body.append(scroller);
  Object.defineProperty(scroller, "clientHeight", { configurable: true, value: view });
  Object.defineProperty(scroller, "scrollHeight", { configurable: true, value: content });
  Object.defineProperty(layout, "offsetHeight", { configurable: true, value: height });
  let scrolled = top;
  Object.defineProperty(scroller, "scrollTop", {
    configurable: true,
    get: () => scrolled,
    set: (value: number) => {
      scrolled = value;
    },
  });
  return { scroller, layout };
}

function scrollTo(scroller: HTMLElement, top: number) {
  scroller.scrollTop = top;
  scroller.dispatchEvent(new Event("scroll"));
}

afterEach(() => {
  document.body.replaceChildren();
});

describe("scrollParent", () => {
  it("找最近的纵向滚动祖先，跳过不滚动的中间层", () => {
    const { scroller, layout } = scene({ view: 600, content: 1200, top: 0, height: 900 });
    expect(scrollParent(layout)).toBe(scroller);
  });

  it("没有滚动祖先时为 null", () => {
    const loose = document.createElement("div");
    document.body.append(loose);
    expect(scrollParent(loose)).toBeNull();
  });
});

describe("holdScroll", () => {
  it("滚在中间：布局至少留到「此刻高度减去还能往下滚的距离」，换成短内容后滚动位置依然成立", () => {
    const view = 500 + Math.floor(Math.random() * 300);
    const top = 100 + Math.floor(Math.random() * 200);
    const below = Math.floor(Math.random() * 400);
    const height = 1200;
    const { scroller, layout } = scene({ view, content: top + view + below, top, height });
    holdScroll(layout, scroller);
    expect(layout.style.minHeight).toBe(`${height - below}px`);
  });

  it("恰好滚到底：托住的就是整个布局此刻的高度", () => {
    const { scroller, layout } = scene({ view: 600, content: 1400, top: 800, height: 1300 });
    holdScroll(layout, scroller);
    expect(layout.style.minHeight).toBe("1300px");
  });

  it("页顶：不托，并撤掉之前留下的托底", () => {
    const { scroller, layout } = scene({ view: 600, content: 1400, top: 0, height: 1300 });
    layout.style.minHeight = "900px";
    holdScroll(layout, scroller);
    expect(layout.style.minHeight).toBe("");
  });

  it("下面还能滚的比布局还高：不需要托底", () => {
    const { scroller, layout } = scene({ view: 600, content: 3000, top: 200, height: 1000 });
    holdScroll(layout, scroller);
    expect(layout.style.minHeight).toBe("");
  });

  it("用户自己滚回页顶时撤掉托底；没到页顶不撤", () => {
    const { scroller, layout } = scene({ view: 600, content: 1400, top: 800, height: 1300 });
    holdScroll(layout, scroller);
    scrollTo(scroller, 300);
    expect(layout.style.minHeight).toBe("1300px");
    scrollTo(scroller, 0);
    expect(layout.style.minHeight).toBe("");
  });

  it("返回的函数只摘监听：之后滚回页顶也不再动托底", () => {
    const { scroller, layout } = scene({ view: 600, content: 1400, top: 800, height: 1300 });
    const detach = holdScroll(layout, scroller);
    detach();
    scrollTo(scroller, 0);
    expect(layout.style.minHeight).toBe("1300px");
  });
});
