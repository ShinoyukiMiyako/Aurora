// @vitest-environment jsdom
// 换标签、换分区时托住页面的高度。jsdom 不做布局：滚动区与布局的尺寸按真实页面里的关系直接给出，
// 嵌套托底的用例另用一个小模型按最低高度算出各层的实际高度，并像浏览器一样把越界的滚动位置夹回。
import { afterEach, describe, expect, it } from "vitest";
import { holdScroll } from "./scroll-hold";

interface Scene {
  scroller: HTMLElement;
  layout: HTMLElement;
}

/** 滚动区里一个布局块：滚动区可视高 view，内容总高 content，滚在 top；布局块高 height。 */
function scene({ view, content, top, height }: { view: number; content: number; top: number; height: number }): Scene {
  const scroller = document.createElement("div");
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

const floorOf = (el: HTMLElement) => (el.style.minHeight === "" ? 0 : Number.parseFloat(el.style.minHeight));

interface Nested {
  scroller: HTMLElement;
  page: HTMLElement;
  layout: HTMLElement;
  /** 布局里的内容换成 natural 高（换了标签或分区），滚动位置越界时像浏览器一样夹回。 */
  swap(natural: number): void;
}

/**
 * 页面根（页头 chrome 高加布局）包着布局，放在可视高 view 的滚动区里。各层的高度按最低高度取：
 * 布局 = max(内容, 布局的托底)，页面 = max(页头 + 布局, 页面的托底)，滚动区的内容总高就是页面高。
 */
function nested({ view, chrome, natural, top }: { view: number; chrome: number; natural: number; top: number }): Nested {
  const scroller = document.createElement("div");
  const page = document.createElement("div");
  const layout = document.createElement("div");
  page.append(layout);
  scroller.append(page);
  document.body.append(scroller);
  let content = natural;
  let scrolled = top;
  const layoutHeight = () => Math.max(content, floorOf(layout));
  const pageHeight = () => Math.max(chrome + layoutHeight(), floorOf(page));
  const clamp = () => {
    scrolled = Math.max(0, Math.min(scrolled, pageHeight() - view));
  };
  Object.defineProperty(layout, "offsetHeight", { configurable: true, get: layoutHeight });
  Object.defineProperty(page, "offsetHeight", { configurable: true, get: pageHeight });
  Object.defineProperty(scroller, "clientHeight", { configurable: true, value: view });
  Object.defineProperty(scroller, "scrollHeight", { configurable: true, get: pageHeight });
  Object.defineProperty(scroller, "scrollTop", {
    configurable: true,
    get: () => scrolled,
    set: (value: number) => {
      scrolled = value;
      clamp();
    },
  });
  return {
    scroller,
    page,
    layout,
    swap(next) {
      content = next;
      clamp();
    },
  };
}

afterEach(() => {
  document.body.replaceChildren();
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

describe("同一个滚动容器里托两层（外壳托页面根，页面自己再托里面的布局）", () => {
  // 页头 200、布局 1400：页面 1600，可视 600，滚在 900，下面还能滚 100
  const setup = () => nested({ view: 600, chrome: 200, natural: 1400, top: 900 });

  for (const order of ["先外后内", "先内后外"] as const) {
    it(`${order}：换成短内容后滚动位置不被夹回，内容总高与只托一层时相同，不叠加`, () => {
      const { scroller, page, layout, swap } = setup();
      if (order === "先外后内") {
        holdScroll(page, scroller);
        holdScroll(layout, scroller);
      } else {
        holdScroll(layout, scroller);
        holdScroll(page, scroller);
      }
      expect([floorOf(page), floorOf(layout)]).toEqual([1500, 1300]);
      swap(400);
      expect(scroller.scrollTop).toBe(900);
      // 只托一层时：此刻高度 1600 减去还能往下滚的 100
      expect(scroller.scrollHeight).toBe(1500);
    });
  }

  it("同一层连托两次（连着换两次标签）：按含托底的此刻高度重算，不在上一次的托底上再加", () => {
    const { scroller, page, swap } = setup();
    holdScroll(page, scroller);
    swap(400);
    holdScroll(page, scroller);
    expect(floorOf(page)).toBe(1500);
    swap(300);
    expect(scroller.scrollTop).toBe(900);
    expect(scroller.scrollHeight).toBe(1500);
  });

  it("滚回页顶时两层都撤掉，页面回到按内容定高", () => {
    const { scroller, page, layout, swap } = setup();
    holdScroll(page, scroller);
    holdScroll(layout, scroller);
    swap(400);
    scrollTo(scroller, 0);
    expect([page.style.minHeight, layout.style.minHeight]).toEqual(["", ""]);
    expect(scroller.scrollHeight).toBe(600);
  });

  it("不托时：短内容把滚动位置夹回（托底要防的正是这一下）", () => {
    const { scroller, swap } = setup();
    swap(400);
    expect(scroller.scrollTop).toBe(0);
  });
});
