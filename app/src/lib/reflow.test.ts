// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stubResizeObserver, type ResizeObserverStub } from "../test/dom";
import { springAt } from "./motion";
import { observeReflow, REFLOW_MAX_ITEMS, REFLOW_SKIP_ATTR } from "./reflow";

// jsdom 不做布局：每个元素的位置、定位祖先与样式由这张表给出
interface Box {
  left: number;
  top: number;
  parent: HTMLElement | null;
  clientWidth: number;
  overflowY: string;
  translate: string;
}

interface Call {
  el: HTMLElement;
  frames: Keyframe[];
  options: KeyframeAnimationOptions;
  animation: { currentTime: number | null; cancel: ReturnType<typeof vi.fn>; onfinish: (() => void) | null; oncancel: (() => void) | null };
}

const boxes = new Map<Element, Box>();
let calls: Call[] = [];
let sizes: ResizeObserverStub;
let stop: (() => void) | undefined;
const SAMPLE_S = 1 / 120;

function place(el: HTMLElement, box: Partial<Box>): void {
  const was = boxes.get(el);
  boxes.set(el, { left: 0, top: 0, parent: null, clientWidth: 0, overflowY: "visible", translate: "none", ...was, ...box });
}

const box = (el: Element): Box => {
  const found = boxes.get(el);
  if (found === undefined) throw new Error("测试元素没有登记布局");
  return found;
};

function child(container: HTMLElement, top: number, left = 0): HTMLElement {
  const el = document.createElement("div");
  container.append(el);
  place(el, { top, left, parent: container });
  return el;
}

/** 起点位移：第一帧的 translate。 */
const start = (call: Call) => String(call.frames[0].translate);
const callsOn = (el: HTMLElement) => calls.filter((c) => c.el === el);
/** MutationObserver 的回调在微任务里。 */
const flushMutations = () => Promise.resolve();

beforeEach(() => {
  calls = [];
  sizes = stubResizeObserver();
  vi.spyOn(HTMLElement.prototype, "offsetParent", "get").mockImplementation(function (this: HTMLElement) {
    return box(this).parent;
  });
  vi.spyOn(HTMLElement.prototype, "offsetTop", "get").mockImplementation(function (this: HTMLElement) {
    return box(this).top;
  });
  vi.spyOn(HTMLElement.prototype, "offsetLeft", "get").mockImplementation(function (this: HTMLElement) {
    return box(this).left;
  });
  vi.spyOn(Element.prototype, "clientWidth", "get").mockImplementation(function (this: Element) {
    return box(this).clientWidth;
  });
  vi.spyOn(window, "getComputedStyle").mockImplementation((el) => {
    const found = boxes.get(el);
    return { overflowY: found === undefined ? "visible" : found.overflowY, translate: found === undefined ? "none" : found.translate } as CSSStyleDeclaration;
  });
  Object.defineProperty(HTMLElement.prototype, "animate", {
    configurable: true,
    writable: true,
    value(this: HTMLElement, frames: Keyframe[], options: KeyframeAnimationOptions) {
      const animation = { currentTime: 0, cancel: vi.fn(), onfinish: null, oncancel: null };
      calls.push({ el: this, frames, options, animation });
      return animation;
    },
  });
});

afterEach(() => {
  stop?.();
  stop = undefined;
  boxes.clear();
  document.body.replaceChildren();
  document.documentElement.removeAttribute("data-sk-reduced");
  Reflect.deleteProperty(HTMLElement.prototype, "animate");
  vi.unstubAllGlobals();
});

/** 一列三项：0 / 100 / 200，容器宽 800，子项的定位祖先就是容器。 */
function column() {
  const container = document.createElement("div");
  document.body.append(container);
  place(document.body, {});
  place(container, { parent: document.body, clientWidth: 800 });
  const a = child(container, 0);
  const b = child(container, 100);
  const c = child(container, 200);
  stop = observeReflow(container);
  // 第一趟：只记位置
  sizes.resize(container, 800);
  return { container, a, b, c };
}

describe("observeReflow：让位", () => {
  it("第一趟只记位置，不起动画", () => {
    column();
    expect(calls).toHaveLength(0);
  });

  it("上面的子项变高：下面各项从旧位置滑到新位置，变高的那项自己不动", () => {
    const { a, b, c } = column();
    place(b, { top: 220 });
    place(c, { top: 320 });
    sizes.resize(a, 800);
    expect(callsOn(a)).toHaveLength(0);
    expect(start(callsOn(b)[0])).toBe("0px -120px");
    expect(start(callsOn(c)[0])).toBe("0px -120px");
    const { frames, options } = callsOn(b)[0];
    expect(frames[frames.length - 1].translate).toBe("0px 0px");
    expect(options.duration).toBeCloseTo(((frames.length - 1) * 1000) / 120, 6);
    expect(options.easing).toBe("linear");
    expect(options.composite).toBe("replace");
  });

  it("横向被挤：按横向位移补", () => {
    const { a, b } = column();
    place(b, { left: 30 });
    sizes.resize(a, 800);
    expect(start(callsOn(b)[0])).toBe("-30px 0px");
  });

  it("不到 1px 的位置差不算移动", () => {
    const { a, b } = column();
    place(b, { top: 100.6 });
    sizes.resize(a, 800);
    expect(calls).toHaveLength(0);
  });

  it("插入一项：新项自己不动，后面的兄弟让位", async () => {
    const { container, a, b, c } = column();
    const banner = document.createElement("div");
    place(banner, { top: 100, parent: container });
    place(b, { top: 140 });
    place(c, { top: 240 });
    container.insertBefore(banner, b);
    await flushMutations();
    expect(callsOn(banner)).toHaveLength(0);
    expect(callsOn(a)).toHaveLength(0);
    expect(start(callsOn(b)[0])).toBe("0px -40px");
    expect(start(callsOn(c)[0])).toBe("0px -40px");
    // 新项纳入观察：它之后再变高，兄弟照样让位
    expect(sizes.observed()).toContain(banner);
  });

  it("移走一项：后面的兄弟从原处滑上来", async () => {
    const { a, b, c } = column();
    place(b, { top: 0 });
    place(c, { top: 100 });
    a.remove();
    await flushMutations();
    expect(start(callsOn(b)[0])).toBe("0px 100px");
    expect(start(callsOn(c)[0])).toBe("0px 100px");
    expect(sizes.observed()).not.toContain(a);
  });

  it("带跳过标记的子项不参与", () => {
    const { a, b, c } = column();
    b.setAttribute(REFLOW_SKIP_ATTR, "");
    sizes.resize(container_of(b), 800);
    place(b, { top: 220 });
    place(c, { top: 320 });
    sizes.resize(a, 800);
    expect(callsOn(b)).toHaveLength(0);
    expect(start(callsOn(c)[0])).toBe("0px -120px");
  });

  it("没有盒子的子项（offsetParent 为空）不参与", () => {
    const { a, b, c } = column();
    place(b, { parent: null });
    sizes.resize(a, 800);
    place(b, { top: 220 });
    place(c, { top: 320 });
    sizes.resize(a, 800);
    expect(callsOn(b)).toHaveLength(0);
    expect(start(callsOn(c)[0])).toBe("0px -120px");
  });

  it("容器整体被别人挤走：子项相对容器没动，不补位移", () => {
    const container = document.createElement("div");
    document.body.append(container);
    place(document.body, {});
    // 容器不是定位祖先：子项的偏移是相对 body 的
    place(container, { parent: document.body, clientWidth: 800, top: 50 });
    const a = child(container, 50);
    const b = child(container, 150);
    place(a, { parent: document.body });
    place(b, { parent: document.body });
    stop = observeReflow(container);
    sizes.resize(container, 800);
    place(container, { top: 250 });
    place(a, { top: 250 });
    place(b, { top: 350 });
    sizes.resize(container, 800);
    expect(calls).toHaveLength(0);
    // 容器不动、里面的兄弟被挤：照常补
    place(b, { top: 400 });
    sizes.resize(a, 800);
    expect(start(callsOn(b)[0])).toBe("0px -50px");
  });
});

function container_of(el: HTMLElement): HTMLElement {
  if (el.parentElement === null) throw new Error("元素没有父级");
  return el.parentElement;
}

describe("observeReflow：不做动画的情况", () => {
  it("容器宽度变了（窗口缩放、分档切换）：只记新位置；之后的变化从新位置算起", () => {
    const { container, a, b, c } = column();
    place(container, { clientWidth: 790 });
    place(b, { top: 130 });
    place(c, { top: 260 });
    sizes.resize(container, 790);
    expect(calls).toHaveLength(0);
    place(c, { top: 300 });
    sizes.resize(b, 790);
    expect(callsOn(b)).toHaveLength(0);
    expect(start(callsOn(c)[0])).toBe("0px -40px");
    expect(callsOn(a)).toHaveLength(0);
  });

  it("窗口高度变了：不动", () => {
    const { a, b } = column();
    const height = window.innerHeight;
    window.innerHeight = height - 80;
    try {
      place(b, { top: 60 });
      sizes.resize(a, 800);
      expect(calls).toHaveLength(0);
    } finally {
      window.innerHeight = height;
    }
  });

  it("减少动画：不动", () => {
    const { a, b } = column();
    document.documentElement.setAttribute("data-sk-reduced", "");
    place(b, { top: 220 });
    sizes.resize(a, 800);
    expect(calls).toHaveLength(0);
  });

  it(`子项超过 ${REFLOW_MAX_ITEMS} 个：不动`, async () => {
    const { container, a, b } = column();
    for (let i = 3; i <= REFLOW_MAX_ITEMS; i++) child(container, i * 100);
    await flushMutations();
    expect(container.children).toHaveLength(REFLOW_MAX_ITEMS + 1);
    place(b, { top: 220 });
    sizes.resize(a, 800);
    expect(calls).toHaveLength(0);
  });

  it("没有 ResizeObserver 的环境：不观察也不抛错", () => {
    vi.stubGlobal("ResizeObserver", undefined);
    const container = document.createElement("div");
    document.body.append(container);
    place(container, { parent: document.body, clientWidth: 800 });
    expect(() => observeReflow(container)()).not.toThrow();
  });
});

describe("observeReflow：途中再被挤", () => {
  it("取消旧动画，新轨迹从此刻的位置加上新位移出发，速度接着走", () => {
    const { a, b } = column();
    place(b, { top: 220 });
    sizes.resize(a, 800);
    const first = callsOn(b)[0];
    // 旧动画播到 50ms 时又被往下挤 40px
    first.animation.currentTime = 50;
    place(b, { top: 260 });
    sizes.resize(a, 800);
    expect(first.animation.cancel).toHaveBeenCalledTimes(1);
    const second = callsOn(b)[1];
    const now = springAt("settle", -120, 0, 0.05);
    expect(start(second)).toBe(`0px ${Math.round((now.x - 40) * 100) / 100}px`);
    const next = Math.round(springAt("settle", now.x - 40, now.v, SAMPLE_S).x * 100) / 100;
    expect(second.frames[1].translate).toBe(`0px ${next}px`);
  });

  it("动画播完后登记清掉：再被挤时从静止出发", () => {
    const { a, b } = column();
    place(b, { top: 220 });
    sizes.resize(a, 800);
    const first = callsOn(b)[0];
    first.animation.currentTime = 80;
    first.animation.onfinish?.();
    place(b, { top: 260 });
    sizes.resize(a, 800);
    expect(first.animation.cancel).not.toHaveBeenCalled();
    expect(start(callsOn(b)[1])).toBe("0px -40px");
  });
});

describe("observeReflow：滚动", () => {
  function scrolled() {
    const scroller = document.createElement("div");
    document.body.append(scroller);
    place(scroller, { overflowY: "auto" });
    scroller.scrollTop = 500;
    const container = document.createElement("div");
    scroller.append(container);
    place(container, { parent: scroller, clientWidth: 800 });
    const a = child(container, 0);
    const b = child(container, 100);
    stop = observeReflow(container);
    sizes.resize(container, 800);
    return { scroller, a, b };
  }

  it("滚动锚定把位移抵消了：可见内容没动，不补", () => {
    const { scroller, a, b } = scrolled();
    place(b, { top: 220 });
    scroller.scrollTop = 620;
    sizes.resize(a, 800);
    expect(calls).toHaveLength(0);
  });

  it("用户自己滚过之后再被挤：滚动量不算进位移", () => {
    const { scroller, a, b } = scrolled();
    scroller.scrollTop = 700;
    scroller.dispatchEvent(new Event("scroll"));
    place(b, { top: 220 });
    sizes.resize(a, 800);
    expect(start(callsOn(b)[0])).toBe("0px -120px");
  });

  it("滚动位置变了但对不上任何子项的位移：按布局位移补", () => {
    const { scroller, a, b } = scrolled();
    place(b, { top: 220 });
    scroller.scrollTop = 0;
    sizes.resize(a, 800);
    expect(start(callsOn(b)[0])).toBe("0px -120px");
  });
});

describe("observeReflow：与元素自身的 translate 共存", () => {
  it("元素自己带 translate：位移叠加在它上面", () => {
    const { a, b } = column();
    place(b, { top: 220, translate: "0px -2px" });
    sizes.resize(a, 800);
    expect(callsOn(b)[0].options.composite).toBe("add");
  });
});

describe("observeReflow：停止", () => {
  it("停止后不再观察、不再起动画", () => {
    const { container, a, b } = column();
    stop?.();
    stop = undefined;
    expect(sizes.observed()).toHaveLength(0);
    place(b, { top: 220 });
    sizes.resize(a, 800);
    sizes.resize(container, 800);
    expect(calls).toHaveLength(0);
  });
});
