// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stubResizeObserver, type ResizeObserverStub } from "../test/dom";
import { springAt } from "./motion";
import { closestScroller, observeReflow, REFLOW_HARD_MAX_ITEMS, REFLOW_MAX_ITEMS, REFLOW_PAUSED_ATTR, REFLOW_SKIP_ATTR } from "./reflow";

// jsdom 不做布局：每个元素的位置、定位祖先与样式由这张表给出
interface Box {
  left: number;
  top: number;
  parent: HTMLElement | null;
  clientWidth: number;
  overflowY: string;
  translate: string;
  display: string;
  height: number;
  /** getBoundingClientRect 的上沿（视口坐标）。 */
  viewTop: number;
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
/** 读了多少次定位祖先与偏移（布局读取）。 */
let layoutReads = 0;
const SAMPLE_S = 1 / 120;

function place(el: HTMLElement, box: Partial<Box>): void {
  const was = boxes.get(el);
  boxes.set(el, { left: 0, top: 0, parent: null, clientWidth: 0, overflowY: "visible", translate: "none", display: "block", height: 0, viewTop: 0, ...was, ...box });
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
  layoutReads = 0;
  sizes = stubResizeObserver();
  vi.spyOn(HTMLElement.prototype, "offsetParent", "get").mockImplementation(function (this: HTMLElement) {
    layoutReads++;
    return box(this).parent;
  });
  vi.spyOn(HTMLElement.prototype, "offsetTop", "get").mockImplementation(function (this: HTMLElement) {
    layoutReads++;
    return box(this).top;
  });
  vi.spyOn(HTMLElement.prototype, "offsetLeft", "get").mockImplementation(function (this: HTMLElement) {
    layoutReads++;
    return box(this).left;
  });
  vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(function (this: HTMLElement) {
    return box(this).height;
  });
  vi.spyOn(Element.prototype, "clientWidth", "get").mockImplementation(function (this: Element) {
    return box(this).clientWidth;
  });
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
    const { viewTop, height, clientWidth } = box(this);
    return { top: viewTop, bottom: viewTop + height, left: 0, right: clientWidth, width: clientWidth, height, x: 0, y: viewTop, toJSON: () => ({}) } as DOMRect;
  });
  vi.spyOn(window, "getComputedStyle").mockImplementation((el) => {
    const found = boxes.get(el);
    if (found === undefined) return { overflowY: "visible", translate: "none", display: "block" } as CSSStyleDeclaration;
    return { overflowY: found.overflowY, translate: found.translate, display: found.display } as CSSStyleDeclaration;
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

  it(`子项超过 ${REFLOW_HARD_MAX_ITEMS} 个：整趟不读位置、不动；回到上限以内的第一趟只记位置，不拿超限之前的旧位置补滑`, async () => {
    const container = document.createElement("div");
    document.body.append(container);
    place(document.body, {});
    place(container, { parent: document.body, clientWidth: 800 });
    // 正好在上限上：照常量
    const items = Array.from({ length: REFLOW_HARD_MAX_ITEMS }, (_, i) => {
      const el = child(container, i * 10);
      place(el, { height: 10 });
      return el;
    });
    stop = observeReflow(container);
    sizes.resize(container, 800);
    const extra = child(container, REFLOW_HARD_MAX_ITEMS * 10);
    await flushMutations();
    layoutReads = 0;
    for (let i = 1; i < items.length; i++) place(items[i], { top: i * 10 + 20 });
    sizes.resize(items[0], 800);
    expect(layoutReads).toBe(0);
    expect(calls).toHaveLength(0);
    extra.remove();
    await flushMutations();
    expect(calls).toHaveLength(0);
    for (let i = 1; i < items.length; i++) place(items[i], { top: i * 10 + 40 });
    sizes.resize(items[0], 800);
    expect(calls).toHaveLength(REFLOW_MAX_ITEMS);
    expect(calls.every((c) => start(c) === "0px -20px")).toBe(true);
  });

  it("没有 ResizeObserver 的环境：不观察也不抛错", () => {
    vi.stubGlobal("ResizeObserver", undefined);
    const container = document.createElement("div");
    document.body.append(container);
    place(container, { parent: document.body, clientWidth: 800 });
    expect(() => observeReflow(container)()).not.toThrow();
  });
});

describe("observeReflow：暂停", () => {
  it("容器带暂停属性：只记位置不起动画；去掉之后的变化从暂停期间记下的位置算起", async () => {
    const { container, a, b, c } = column();
    container.setAttribute(REFLOW_PAUSED_ATTR, "");
    await flushMutations();
    place(b, { top: 220 });
    place(c, { top: 320 });
    sizes.resize(a, 800);
    expect(calls).toHaveLength(0);
    container.removeAttribute(REFLOW_PAUSED_ATTR);
    await flushMutations();
    expect(calls).toHaveLength(0);
    place(c, { top: 360 });
    sizes.resize(b, 800);
    expect(callsOn(a)).toHaveLength(0);
    expect(callsOn(b)).toHaveLength(0);
    expect(start(callsOn(c)[0])).toBe("0px -40px");
  });

  it("暂停时被挪动的项还在飞：取消，直接落到新位置；没被挪动的接着飞；恢复后再被挤从静止出发", async () => {
    const { container, a, b, c } = column();
    place(b, { top: 220 });
    place(c, { top: 320 });
    sizes.resize(a, 800);
    const [flyB] = callsOn(b);
    const [flyC] = callsOn(c);
    flyB.animation.currentTime = 50;
    flyC.animation.currentTime = 50;
    container.setAttribute(REFLOW_PAUSED_ATTR, "");
    await flushMutations();
    place(c, { top: 400 });
    sizes.resize(b, 800);
    expect(flyC.animation.cancel).toHaveBeenCalledTimes(1);
    expect(flyB.animation.cancel).not.toHaveBeenCalled();
    expect(calls).toHaveLength(2);
    container.removeAttribute(REFLOW_PAUSED_ATTR);
    await flushMutations();
    place(c, { top: 440 });
    sizes.resize(b, 800);
    // 已取消的那段不再算进此刻的位置：从静止的 -40px 出发
    expect(start(callsOn(c)[1])).toBe("0px -40px");
    expect(flyC.animation.cancel).toHaveBeenCalledTimes(1);
  });

  it("同一次提交里打开暂停并换掉一批子项：这一趟不起动画", async () => {
    const { container, a, b, c } = column();
    container.setAttribute(REFLOW_PAUSED_ATTR, "");
    a.remove();
    place(b, { top: 0 });
    place(c, { top: 100 });
    await flushMutations();
    expect(calls).toHaveLength(0);
  });

  it("开关的增删本身不起动画：去掉属性时已经排好、尺寸观察还没报上来的变化直接收下", async () => {
    const { container, a, b } = column();
    container.setAttribute(REFLOW_PAUSED_ATTR, "");
    await flushMutations();
    // 暂停期间布局变了，尺寸观察要到这一帧稍后才报；调用方在那之前就去掉了属性
    place(b, { top: 220 });
    container.removeAttribute(REFLOW_PAUSED_ATTR);
    await flushMutations();
    expect(calls).toHaveLength(0);
    sizes.resize(a, 800);
    expect(calls).toHaveLength(0);
  });
});

describe(`observeReflow：子项超过 ${REFLOW_MAX_ITEMS} 个`, () => {
  /** count 项等高的子项竖排，从 0 起每 pitch 一项，定位祖先是容器。 */
  function rows(container: HTMLElement, count: number, pitch: number): HTMLElement[] {
    return Array.from({ length: count }, (_, i) => {
      const el = child(container, i * pitch);
      place(el, { height: pitch });
      return el;
    });
  }

  /** 第 0 项变高 grow：其余各项下移 grow，尺寸观察报在第 0 项上。 */
  function growFirst(items: HTMLElement[], pitch: number, grow: number): void {
    items.forEach((el, i) => {
      if (i > 0) place(el, { top: i * pitch + grow });
    });
    sizes.resize(items[0], 800);
  }

  /** 起了动画的子项序号。 */
  const moving = (items: HTMLElement[]) => items.flatMap((el, i) => (callsOn(el).length > 0 ? [i] : []));
  const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, k) => from + k);

  /** 滚动祖先在视口里占 [0, height]、已滚到 scrollTop；容器在它里面，视口上沿随之在 -scrollTop。 */
  function inScroller(height: number, scrollTop: number): HTMLElement {
    const scroller = document.createElement("div");
    document.body.append(scroller);
    place(scroller, { overflowY: "auto", viewTop: 0, height });
    scroller.scrollTop = scrollTop;
    const container = document.createElement("div");
    scroller.append(container);
    place(container, { parent: scroller, clientWidth: 800, viewTop: -scrollTop });
    return container;
  }

  it("只给起点或终点落在可见范围附近（上下各留 200px）的起动画，远处的直接到位；可见范围取滚动容器与窗口的交集", () => {
    // 滚动容器高 2000，比窗口（jsdom 的 768）还高：可见范围按窗口截
    const container = inScroller(2000, 1000);
    const items = rows(container, 60, 50);
    stop = observeReflow(container);
    sizes.resize(container, 800);
    growFirst(items, 50, 60);
    // 换到容器坐标：可见带 [1000, 1768]，加余量 [800, 1968]；第 i 项起点 [50i, 50i + 50]，终点再往下 60。
    // 14 只有终点够得着，39 只有起点够得着
    expect(moving(items)).toEqual(range(14, 39));
    for (const i of range(14, 39)) expect(start(callsOn(items[i])[0])).toBe("0px -60px");
  });

  it("容器自己就是滚动容器：按它自己的滚动量换算", () => {
    const container = document.createElement("div");
    document.body.append(container);
    place(document.body, {});
    place(container, { parent: document.body, clientWidth: 800, overflowY: "auto", viewTop: 0, height: 600 });
    container.scrollTop = 1000;
    const items = rows(container, 60, 50);
    stop = observeReflow(container);
    sizes.resize(container, 800);
    growFirst(items, 50, 40);
    // 容器坐标里可见带 [1000, 1600]，加余量 [800, 1800]
    expect(moving(items)).toEqual(range(15, 36));
  });

  it("没有滚动容器时按窗口算", () => {
    const container = document.createElement("div");
    document.body.append(container);
    place(document.body, {});
    place(container, { parent: document.body, clientWidth: 800, viewTop: 0 });
    const items = rows(container, 60, 50);
    stop = observeReflow(container);
    sizes.resize(container, 800);
    growFirst(items, 50, 40);
    // 窗口 [0, 768]，加余量 [-200, 968]
    expect(moving(items)).toEqual(range(1, 19));
  });

  it(`附近的仍超过 ${REFLOW_MAX_ITEMS} 个：只动离可见范围中心最近的那些`, () => {
    const container = inScroller(600, 1000);
    const items = rows(container, 150, 20);
    stop = observeReflow(container);
    sizes.resize(container, 800);
    growFirst(items, 20, 40);
    // 附近的是 37 到 90 共 54 项。中心在容器坐标 1300：62、63 的终点与 64、65 的起点压着它，往两边每隔 20px 各添一项
    expect(moving(items)).toEqual(range(44, 83));
    expect(calls).toHaveLength(REFLOW_MAX_ITEMS);
  });

  it(`不超过 ${REFLOW_MAX_ITEMS} 个时不挑：远在可见范围之外的也照常起动画`, () => {
    const container = inScroller(600, 5000);
    const items = rows(container, REFLOW_MAX_ITEMS, 50);
    stop = observeReflow(container);
    sizes.resize(container, 800);
    growFirst(items, 50, 40);
    expect(moving(items)).toEqual(range(1, REFLOW_MAX_ITEMS - 1));
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

  it("指定 morph：轨迹与途中转向都按 morph 弹簧算", () => {
    const container = document.createElement("div");
    document.body.append(container);
    place(document.body, {});
    place(container, { parent: document.body, clientWidth: 800 });
    const a = child(container, 0);
    const b = child(container, 100);
    stop = observeReflow(container, "morph");
    sizes.resize(container, 800);
    place(b, { top: 220 });
    sizes.resize(a, 800);
    const first = callsOn(b)[0];
    const step = (name: "morph" | "settle") => Math.round(springAt(name, -120, 0, SAMPLE_S).x * 100) / 100;
    expect(step("morph")).not.toBe(step("settle"));
    expect(first.frames[1].translate).toBe(`0px ${step("morph")}px`);
    first.animation.currentTime = 50;
    place(b, { top: 260 });
    sizes.resize(a, 800);
    const now = springAt("morph", -120, 0, 0.05);
    expect(start(callsOn(b)[1])).toBe(`0px ${Math.round((now.x - 40) * 100) / 100}px`);
  });
});

describe("observeReflow：退场项先被抽出布局（popLayout）", () => {
  it("抽出的那一帧节点没有增删、尺寸也没变：兄弟照样在这一帧让位；节点稍后真正拿掉时不再动第二次", async () => {
    const { a, b, c } = column();
    // framer 给退场项打上标记并把它改成绝对定位：它留在原处，后面的兄弟顶上来
    a.setAttribute("data-motion-pop-id", ":r1:");
    place(b, { top: 0 });
    place(c, { top: 100 });
    await flushMutations();
    expect(callsOn(a)).toHaveLength(0);
    expect(start(callsOn(b)[0])).toBe("0px 100px");
    expect(start(callsOn(c)[0])).toBe("0px 100px");
    a.remove();
    await flushMutations();
    expect(callsOn(b)).toHaveLength(1);
    expect(callsOn(c)).toHaveLength(1);
  });

  it("之后才加进来的子项退场时同样接得住", async () => {
    const { container, b, c } = column();
    const late = document.createElement("div");
    place(late, { top: 300, parent: container });
    container.append(late);
    await flushMutations();
    expect(calls).toHaveLength(0);
    b.setAttribute("data-motion-pop-id", ":r2:");
    place(c, { top: 100 });
    place(late, { top: 200 });
    await flushMutations();
    expect(start(callsOn(c)[0])).toBe("0px 100px");
    expect(start(callsOn(late)[0])).toBe("0px 100px");
  });

  it("标记打在子项里面更深的元素上：被抽出布局的不是这一层的子项，不量也不动", async () => {
    const { a, b } = column();
    const inner = document.createElement("span");
    a.append(inner);
    await flushMutations();
    inner.setAttribute("data-motion-pop-id", ":r3:");
    place(b, { top: 60 });
    await flushMutations();
    expect(calls).toHaveLength(0);
  });
});

/** display: contents 的包裹层（像按钮外面的提示宿主）：没有盒子，offsetParent 为空。 */
function contents(parent: HTMLElement): HTMLElement {
  const el = document.createElement("span");
  parent.append(el);
  place(el, { display: "contents" });
  return el;
}

/** 包裹层里的按钮：DOM 上挂在包裹层下，定位祖先是让位的容器。 */
function inside(host: HTMLElement, container: HTMLElement, top: number, left = 0): HTMLElement {
  const el = document.createElement("button");
  host.append(el);
  place(el, { top, left, parent: container });
  return el;
}

describe("observeReflow：display: contents 的子项", () => {
  /** a 在 0；一层包裹里装着按钮 b（100）、c（200）；d 在 300。 */
  function wrapped() {
    const container = document.createElement("div");
    document.body.append(container);
    place(document.body, {});
    place(container, { parent: document.body, clientWidth: 800 });
    const a = child(container, 0);
    const host = contents(container);
    const b = inside(host, container, 100);
    const c = inside(host, container, 200);
    const d = child(container, 300);
    stop = observeReflow(container);
    sizes.resize(container, 800);
    return { container, host, a, b, c, d };
  }

  it("上面的兄弟变高：包裹层里的按钮从旧位置滑过去；包裹层自己不起动画，也不观察它的尺寸", () => {
    const { host, a, b, c, d } = wrapped();
    place(b, { top: 220 });
    place(c, { top: 320 });
    place(d, { top: 420 });
    sizes.resize(a, 800);
    expect(callsOn(host)).toHaveLength(0);
    expect(start(callsOn(b)[0])).toBe("0px -120px");
    expect(start(callsOn(c)[0])).toBe("0px -120px");
    expect(start(callsOn(d)[0])).toBe("0px -120px");
    expect(sizes.observed()).toEqual(expect.arrayContaining([b, c]));
    expect(sizes.observed()).not.toContain(host);
  });

  it("包裹层里的按钮变宽：同一层里后面的按钮横着让位", () => {
    const { b, c } = wrapped();
    place(c, { left: 40 });
    sizes.resize(b, 800);
    expect(callsOn(b)).toHaveLength(0);
    expect(start(callsOn(c)[0])).toBe("-40px 0px");
  });

  it("包裹层里增删元素：兄弟让位，新来的纳入观察，移走的不再观察", async () => {
    const { container, host, b, c, d } = wrapped();
    const e = document.createElement("button");
    place(e, { top: 200, parent: container });
    place(c, { top: 260 });
    place(d, { top: 360 });
    host.insertBefore(e, c);
    await flushMutations();
    expect(callsOn(e)).toHaveLength(0);
    expect(start(callsOn(c)[0])).toBe("0px -60px");
    expect(start(callsOn(d)[0])).toBe("0px -60px");
    expect(sizes.observed()).toContain(e);
    b.remove();
    place(e, { top: 100 });
    await flushMutations();
    expect(start(callsOn(e)[0])).toBe("0px 100px");
    expect(sizes.observed()).not.toContain(b);
  });

  it("包裹层里的按钮被 popLayout 抽出布局：后面的兄弟同一帧让位", async () => {
    const { b, c, d } = wrapped();
    b.setAttribute("data-motion-pop-id", ":r4:");
    place(c, { top: 100 });
    place(d, { top: 200 });
    await flushMutations();
    expect(callsOn(b)).toHaveLength(0);
    expect(start(callsOn(c)[0])).toBe("0px 100px");
    expect(start(callsOn(d)[0])).toBe("0px 100px");
  });

  it("整层包裹移走：里面的按钮不再观察，后面的兄弟滑上来", async () => {
    const { host, b, c, d } = wrapped();
    host.remove();
    place(d, { top: 100 });
    await flushMutations();
    expect(start(callsOn(d)[0])).toBe("0px 200px");
    expect(sizes.observed()).not.toContain(b);
    expect(sizes.observed()).not.toContain(c);
  });

  it("包裹层套包裹层：逐层往里，直到有盒子的那一层", () => {
    const container = document.createElement("div");
    document.body.append(container);
    place(document.body, {});
    place(container, { parent: document.body, clientWidth: 800 });
    const a = child(container, 0);
    const outer = contents(container);
    const inner = contents(outer);
    const b = inside(inner, container, 100);
    stop = observeReflow(container);
    sizes.resize(container, 800);
    place(b, { top: 160 });
    sizes.resize(a, 800);
    expect(callsOn(outer)).toHaveLength(0);
    expect(callsOn(inner)).toHaveLength(0);
    expect(start(callsOn(b)[0])).toBe("0px -60px");
  });

  it("包裹层带跳过标记：整层都不参与", () => {
    const container = document.createElement("div");
    document.body.append(container);
    place(document.body, {});
    place(container, { parent: document.body, clientWidth: 800 });
    const a = child(container, 0);
    const host = contents(container);
    host.setAttribute(REFLOW_SKIP_ATTR, "");
    const b = inside(host, container, 100);
    const c = child(container, 200);
    stop = observeReflow(container);
    sizes.resize(container, 800);
    place(b, { top: 160 });
    place(c, { top: 260 });
    sizes.resize(a, 800);
    expect(callsOn(b)).toHaveLength(0);
    expect(start(callsOn(c)[0])).toBe("0px -60px");
  });

  it("之后才加进来的包裹层：同一趟就认出来，里面的按钮纳入观察，之后被挤照样让位", async () => {
    const { container, b, c } = column();
    const host = document.createElement("span");
    place(host, { display: "contents" });
    const d = document.createElement("button");
    host.append(d);
    place(d, { top: 300, parent: container });
    container.append(host);
    await flushMutations();
    expect(calls).toHaveLength(0);
    expect(sizes.observed()).toContain(d);
    place(c, { top: 240 });
    place(d, { top: 340 });
    sizes.resize(b, 800);
    expect(start(callsOn(d)[0])).toBe("0px -40px");
  });

  it("有盒子的子项里面增删节点不惊动这里：只盯包裹层这一层，不盯整棵子树", async () => {
    const { a, b } = column();
    const deep = document.createElement("div");
    place(deep, { parent: a });
    place(b, { top: 160 });
    a.append(deep);
    await flushMutations();
    expect(calls).toHaveLength(0);
    expect(sizes.observed()).not.toContain(deep);
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

describe("observeReflow：容器自己就是滚动容器", () => {
  /** 容器自身纵向可滚动、已滚到 500，外面没有别的滚动祖先。 */
  function selfScrolled() {
    const container = document.createElement("div");
    document.body.append(container);
    place(document.body, {});
    place(container, { parent: document.body, clientWidth: 800, overflowY: "auto" });
    container.scrollTop = 500;
    const a = child(container, 0);
    const b = child(container, 100);
    stop = observeReflow(container);
    sizes.resize(container, 800);
    return { container, a, b };
  }

  it("滚动锚定挪的是容器自己的滚动位置：可见内容没动，不补", () => {
    const { container, a, b } = selfScrolled();
    place(b, { top: 220 });
    container.scrollTop = 620;
    sizes.resize(a, 800);
    expect(calls).toHaveLength(0);
  });

  it("用户滚动容器自己之后再被挤：滚动量不算进位移，哪怕恰好等于位移", () => {
    const { container, a, b } = selfScrolled();
    container.scrollTop = 620;
    container.dispatchEvent(new Event("scroll"));
    place(b, { top: 220 });
    sizes.resize(a, 800);
    expect(start(callsOn(b)[0])).toBe("0px -120px");
  });
});

describe("closestScroller", () => {
  it("自己纵向可滚动时就是自己，否则取最近的纵向滚动祖先，都没有时为 null", () => {
    const outer = document.createElement("div");
    const middle = document.createElement("div");
    const inner = document.createElement("div");
    document.body.append(outer);
    outer.append(middle);
    middle.append(inner);
    place(outer, { overflowY: "scroll" });
    place(middle, {});
    place(inner, { overflowY: "auto" });
    expect(closestScroller(inner)).toBe(inner);
    expect(closestScroller(middle)).toBe(outer);
    place(outer, { overflowY: "hidden" });
    expect(closestScroller(middle)).toBeNull();
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
