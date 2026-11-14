// @vitest-environment jsdom
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { drainFrames, fakeAnimate, render, stubResizeObserver, type ResizeObserverStub, type StubAnimation } from "../test/dom";
import { springAt, type SpringName } from "./motion";
import {
  closestScroller,
  followReflow,
  HOLD_AFTER_MUTATION,
  HOLD_AFTER_RESIZE,
  holdUntilPainted,
  observeReflow,
  REFLOW_HARD_MAX_ITEMS,
  REFLOW_MAX_ITEMS,
  REFLOW_PAUSED_ATTR,
  REFLOW_SKIP_ATTR,
  syncReflow,
  useReflow,
} from "./reflow";

// jsdom 不做布局：每个元素的位置、定位祖先与样式由这张表给出
interface Box {
  left: number;
  top: number;
  parent: HTMLElement | null;
  clientWidth: number;
  /** 上边框的宽度。 */
  clientTop: number;
  overflowY: string;
  translate: string;
  display: string;
  height: number;
  /** getBoundingClientRect 的上沿（视口坐标）。 */
  viewTop: number;
  clientHeight: number;
}

interface FakeAnimation {
  /** 与 Web Animations 一致：建好时为 null，等起步那一帧才定；调用方可以直接写。 */
  startTime: number | null;
  currentTime: number | null;
  playState: AnimationPlayState;
  cancel: ReturnType<typeof vi.fn>;
  pause: ReturnType<typeof vi.fn>;
  play: ReturnType<typeof vi.fn>;
  onfinish: (() => void) | null;
  oncancel: (() => void) | null;
}

interface Call {
  el: HTMLElement;
  frames: Keyframe[];
  options: KeyframeAnimationOptions;
  animation: FakeAnimation;
}

const boxes = new Map<Element, Box>();
let calls: Call[] = [];
/** 排着的动画帧回调：用例用 frame() 一帧一帧地走。 */
let frameQueue: FrameRequestCallback[] = [];
let sizes: ResizeObserverStub;
let stop: (() => void) | undefined;
/** 读了多少次定位祖先与偏移（布局读取）。 */
let layoutReads = 0;
/** 其中读偏移（位置）的次数。 */
let positionReads = 0;
/** 读高度（offsetHeight）的次数。 */
let heightReads = 0;
const SAMPLE_S = 1 / 120;

function place(el: HTMLElement, box: Partial<Box>): void {
  const was = boxes.get(el);
  boxes.set(el, { left: 0, top: 0, parent: null, clientWidth: 0, clientTop: 0, overflowY: "visible", translate: "none", display: "block", height: 0, viewTop: 0, clientHeight: 0, ...was, ...box });
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

/** 页面的 performance.now() 定在一个随机时刻并返回它：走 morph 的起步时刻按它钉。 */
function pinNow(): number {
  const view = document.defaultView;
  if (view === null) throw new Error("测试文档没有窗口");
  const now = 1000 + Math.round(Math.random() * 1e6) / 10;
  vi.spyOn(view.performance, "now").mockReturnValue(now);
  return now;
}

/** 走一帧：跑完此刻排着的动画帧回调，回调里新排的留到下一帧。 */
function frame(): void {
  const due = frameQueue;
  frameQueue = [];
  for (const callback of due) callback(performance.now());
}

beforeEach(() => {
  calls = [];
  frameQueue = [];
  layoutReads = 0;
  positionReads = 0;
  heightReads = 0;
  sizes = stubResizeObserver();
  vi.spyOn(HTMLElement.prototype, "offsetParent", "get").mockImplementation(function (this: HTMLElement) {
    layoutReads++;
    return box(this).parent;
  });
  vi.spyOn(HTMLElement.prototype, "offsetTop", "get").mockImplementation(function (this: HTMLElement) {
    layoutReads++;
    positionReads++;
    return box(this).top;
  });
  vi.spyOn(HTMLElement.prototype, "offsetLeft", "get").mockImplementation(function (this: HTMLElement) {
    layoutReads++;
    positionReads++;
    return box(this).left;
  });
  vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(function (this: HTMLElement) {
    heightReads++;
    return box(this).height;
  });
  vi.spyOn(Element.prototype, "clientWidth", "get").mockImplementation(function (this: Element) {
    return box(this).clientWidth;
  });
  vi.spyOn(Element.prototype, "clientTop", "get").mockImplementation(function (this: Element) {
    return box(this).clientTop;
  });
  vi.spyOn(Element.prototype, "clientHeight", "get").mockImplementation(function (this: Element) {
    return box(this).clientHeight;
  });
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
    frameQueue.push(callback);
    return frameQueue.length;
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
      // 与 Web Animations 一致：建好就在播；暂停不挪时间；取消之后回到 idle、没有当前时间
      const animation: FakeAnimation = {
        startTime: null,
        currentTime: 0,
        playState: "running",
        cancel: vi.fn(() => {
          animation.playState = "idle";
          animation.currentTime = null;
        }),
        pause: vi.fn(() => {
          animation.playState = "paused";
        }),
        play: vi.fn(() => {
          animation.playState = "running";
        }),
        onfinish: null,
        oncancel: null,
      };
      calls.push({ el: this, frames, options, animation });
      return animation;
    },
  });
});

afterEach(() => {
  stop?.();
  stop = undefined;
  // 等待队列是模块级的、按窗口共用一个回调：排着的回调丢掉不跑，下一个用例挂进来的会一直等这个不会来的回调
  for (let i = 0; frameQueue.length > 0; i++) {
    if (i === 10) throw new Error("动画帧回调走了 10 帧仍在排：等待队列没有收尾");
    frame();
  }
  boxes.clear();
  document.body.replaceChildren();
  document.documentElement.removeAttribute("data-sk-reduced");
  Reflect.deleteProperty(HTMLElement.prototype, "animate");
  vi.unstubAllGlobals();
});

/** 一列三项：0 / 100 / 200，容器宽 800，子项的定位祖先就是容器。 */
function column(spring: SpringName = "settle") {
  const container = document.createElement("div");
  document.body.append(container);
  place(document.body, {});
  place(container, { parent: document.body, clientWidth: 800 });
  const a = child(container, 0);
  const b = child(container, 100);
  const c = child(container, 200);
  stop = observeReflow(container, spring);
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

  /** b、c 被挤下去起飞，都播到 50ms。 */
  function inFlight() {
    const col = column();
    place(col.b, { top: 220 });
    place(col.c, { top: 320 });
    sizes.resize(col.a, 800);
    const [flyB] = callsOn(col.b);
    const [flyC] = callsOn(col.c);
    flyB.animation.currentTime = 50;
    flyC.animation.currentTime = 50;
    return { ...col, flyB, flyC };
  }

  it("容器宽度变了时还在飞的项：被新布局挪动的取消、直接落到新位置，没被挪动的接着飞；之后再被挤从静止出发", () => {
    const { container, b, c, flyB, flyC } = inFlight();
    // 容器变窄，c 跟着重排挪到 360，b 原地不动
    place(container, { clientWidth: 790 });
    place(c, { top: 360 });
    sizes.resize(container, 790);
    expect(flyC.animation.cancel).toHaveBeenCalledTimes(1);
    expect(flyB.animation.cancel).not.toHaveBeenCalled();
    expect(calls).toHaveLength(2);
    // 登记当场清掉：再被挤 40 从静止出发，不按已取消的轨迹算此刻的位置
    place(c, { top: 400 });
    sizes.resize(b, 790);
    expect(callsOn(c)).toHaveLength(2);
    expect(start(callsOn(c)[1])).toBe("0px -40px");
  });

  it.each<[string, () => void]>([
    [
      "窗口高度变了",
      () => {
        window.innerHeight -= 80;
      },
    ],
    [
      "减少动画刚打开",
      () => {
        document.documentElement.setAttribute("data-sk-reduced", "");
      },
    ],
  ])("%s时还在飞的项：被新布局挪动的取消，没被挪动的接着飞", (_cause, apply) => {
    const height = window.innerHeight;
    try {
      const { a, c, flyB, flyC } = inFlight();
      apply();
      place(c, { top: 360 });
      sizes.resize(a, 800);
      expect(flyC.animation.cancel).toHaveBeenCalledTimes(1);
      expect(flyB.animation.cancel).not.toHaveBeenCalled();
      expect(calls).toHaveLength(2);
    } finally {
      window.innerHeight = height;
    }
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

  it(`包裹层展开之后才超过 ${REFLOW_HARD_MAX_ITEMS} 个：头一趟认完包裹层就放弃，一个位置也不读；超限期间加进来的包裹层回到上限以内时补认`, async () => {
    const container = document.createElement("div");
    document.body.append(container);
    place(document.body, {});
    place(container, { parent: document.body, clientWidth: 800, viewTop: 0 });
    // 300 层还没认过的包裹，每层两个按钮：没展开时只数到 300
    const hosts = Array.from({ length: 300 }, (_, i) => {
      const host = contents(container);
      inside(host, container, i * 20);
      inside(host, container, i * 20 + 10);
      return host;
    });
    stop = observeReflow(container);
    sizes.resize(container, 800);
    expect(positionReads).toBe(0);
    // 包裹层都认下了：之后各趟头一次数就是 600，连定位祖先也不读
    expect(sizes.observed()).toHaveLength(1 + 600);
    layoutReads = 0;
    sizes.resize(container, 800);
    expect(layoutReads).toBe(0);
    // 超限期间加进来一层：这一趟同样不读
    const late = document.createElement("span");
    place(late, { display: "contents" });
    const z = inside(late, container, 100);
    container.append(late);
    await flushMutations();
    expect(positionReads).toBe(0);
    expect(sizes.observed()).not.toContain(z);
    // 拿掉 101 层回到 399：补认这一层，这一趟只记位置
    for (const host of hosts.slice(0, 101)) host.remove();
    await flushMutations();
    expect(calls).toHaveLength(0);
    expect(sizes.observed()).toContain(z);
    place(z, { top: 140 });
    sizes.resize(z, 800);
    expect(start(callsOn(z)[0])).toBe("0px -40px");
  });

  it(`子项超过 ${REFLOW_HARD_MAX_ITEMS} 个时还在飞的项：当场落定、登记清掉；回到上限以内再被挤从静止出发`, async () => {
    const { container, b, c, flyB, flyC } = inFlight();
    const extra = Array.from({ length: REFLOW_HARD_MAX_ITEMS }, (_, i) => child(container, 400 + i * 10));
    await flushMutations();
    expect(flyB.animation.cancel).toHaveBeenCalledTimes(1);
    expect(flyC.animation.cancel).toHaveBeenCalledTimes(1);
    for (const el of extra) el.remove();
    await flushMutations();
    expect(calls).toHaveLength(2);
    place(c, { top: 360 });
    sizes.resize(b, 800);
    expect(callsOn(c)).toHaveLength(2);
    expect(start(callsOn(c)[1])).toBe("0px -40px");
  });

  it(`包裹层展开之后才超过 ${REFLOW_HARD_MAX_ITEMS} 个时还在飞的项：同样当场落定，一个位置也不读`, async () => {
    const { container, flyB, flyC } = inFlight();
    // 200 层还没认过的包裹，每层两个按钮：没展开时数到 203，展开之后才是 403
    for (let i = 0; i < 200; i++) {
      const host = contents(container);
      inside(host, container, 400 + i * 20);
      inside(host, container, 410 + i * 20);
    }
    positionReads = 0;
    await flushMutations();
    expect(positionReads).toBe(0);
    expect(flyB.animation.cancel).toHaveBeenCalledTimes(1);
    expect(flyC.animation.cancel).toHaveBeenCalledTimes(1);
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

  it("容器带上边框且是子项的定位祖先：偏移从内边距边量起，换成视口坐标要加上这道边框", () => {
    const container = document.createElement("div");
    document.body.append(container);
    place(document.body, {});
    place(container, { parent: document.body, clientWidth: 800, viewTop: 0, clientTop: 300 });
    const items = rows(container, 60, 50);
    stop = observeReflow(container);
    sizes.resize(container, 800);
    growFirst(items, 50, 40);
    // 第 i 项在视口里的起点是 300 + 50i、终点再往下 40；窗口加余量 [-200, 968]。不加边框就成了 1 到 19
    expect(moving(items)).toEqual(range(1, 13));
  });

  it("子项的定位祖先在容器外面：偏移里已经含着容器的上边框，不再加一次", () => {
    const outer = document.createElement("div");
    document.body.append(outer);
    place(document.body, {});
    place(outer, { parent: document.body, viewTop: 0 });
    const container = document.createElement("div");
    outer.append(container);
    // 容器在 outer 里的偏移是 0，带一道 300 的上边框；子项相对 outer 量，越过了这道边框
    place(container, { parent: outer, clientWidth: 800, viewTop: 0, clientTop: 300 });
    const items = Array.from({ length: 60 }, (_, i) => {
      const el = child(container, 300 + i * 50);
      place(el, { parent: outer, height: 50 });
      return el;
    });
    stop = observeReflow(container);
    sizes.resize(container, 800);
    items.forEach((el, i) => {
      if (i > 0) place(el, { top: 300 + i * 50 + 40 });
    });
    sizes.resize(items[0], 800);
    // 与上一例同一个视口位置。再加一次边框就成了 1 到 7
    expect(moving(items)).toEqual(range(1, 13));
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

  it("被挪动而没挑上的项还在飞：取消，直接落到新位置，登记当场清掉；前一趟起飞、这一趟没被挪动的不占配额", () => {
    const container = inScroller(600, 1000);
    const items = rows(container, 150, 20);
    stop = observeReflow(container);
    sizes.resize(container, 800);
    growFirst(items, 20, 40);
    expect(moving(items)).toEqual(range(44, 83));
    for (const c of calls) c.animation.currentTime = 50;
    // 再往下挤 40：离中心最近的 40 项换成 42 到 81，82、83 被挪动却没挑上
    growFirst(items, 20, 80);
    for (const i of [82, 83]) {
      expect(callsOn(items[i])).toHaveLength(1);
      expect(callsOn(items[i])[0].animation.cancel).toHaveBeenCalledTimes(1);
    }
    expect(callsOn(items[81])).toHaveLength(2);
    expect(start(callsOn(items[42])[0])).toBe("0px -40px");
    // 只挪 82：从静止出发，不按已取消的轨迹算此刻的位置。42 到 81 还在飞，这一趟照样有名额
    place(items[82], { top: 82 * 20 + 90 });
    sizes.resize(items[0], 800);
    expect(callsOn(items[82])).toHaveLength(2);
    expect(start(callsOn(items[82])[1])).toBe("0px -10px");
  });

  it("滚动锚定把位移抵消了：在眼前没动的不算被挪动，不占名额，还在飞的接着飞", () => {
    const container = inScroller(600, 1000);
    const scroller = container_of(container);
    const items = rows(container, 150, 20);
    stop = observeReflow(container);
    sizes.resize(container, 800);
    growFirst(items, 20, 40);
    expect(moving(items)).toEqual(range(44, 83));
    for (const c of calls) c.animation.currentTime = 50;
    // 第 0 项再长 40，浏览器同步把滚动位置也挪 40：其余各项在视口里原地不动
    scroller.scrollTop = 1040;
    place(container, { viewTop: -1040 });
    growFirst(items, 20, 80);
    expect(calls).toHaveLength(REFLOW_MAX_ITEMS);
    for (const c of calls) expect(c.animation.cancel).not.toHaveBeenCalled();
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

describe("observeReflow：从静止起步等新排布画出来再计时", () => {
  it("增删引起的（提交后的微任务里）：先暂停在起点，第二帧才开始走", async () => {
    const { container, b, c } = column();
    const banner = document.createElement("div");
    place(banner, { top: 100, parent: container });
    place(b, { top: 140 });
    place(c, { top: 240 });
    container.insertBefore(banner, b);
    await flushMutations();
    const [flyB] = callsOn(b);
    const [flyC] = callsOn(c);
    expect(start(flyB)).toBe("0px -40px");
    expect(flyB.animation.pause).toHaveBeenCalledTimes(1);
    expect(flyB.animation.playState).toBe("paused");
    expect(flyC.animation.playState).toBe("paused");
    // 起步时刻不钉：等播起来的那一帧再定
    expect(flyB.animation.startTime).toBeNull();
    // 这一帧画的就是新排布：还停在起点
    frame();
    expect(flyB.animation.play).not.toHaveBeenCalled();
    frame();
    expect(flyB.animation.play).toHaveBeenCalledTimes(1);
    expect(flyC.animation.play).toHaveBeenCalledTimes(1);
    expect(frameQueue).toHaveLength(0);
  });

  it("尺寸变化引起的（这一帧的渲染步骤里，新排布就在这一帧画出）：下一帧开始走", () => {
    const { a, b } = column();
    place(b, { top: 220 });
    sizes.resize(a, 800);
    const [fly] = callsOn(b);
    expect(fly.animation.playState).toBe("paused");
    frame();
    expect(fly.animation.play).toHaveBeenCalledTimes(1);
  });

  it("同一次提交里内层增删、外层尺寸变化各起的让位：同一帧开始走", async () => {
    const outer = document.createElement("div");
    document.body.append(outer);
    place(document.body, {});
    place(outer, { parent: document.body, clientWidth: 800 });
    const inner = child(outer, 0);
    place(inner, { clientWidth: 800 });
    const below = child(outer, 100);
    const p = child(inner, 0);
    const q = child(inner, 50);
    const stopOuter = observeReflow(outer);
    const stopInner = observeReflow(inner);
    stop = () => {
      stopOuter();
      stopInner();
    };
    sizes.resize(outer, 800);
    sizes.resize(inner, 800);
    // 内层插进一项：增删观察在提交后的微任务里报
    const added = document.createElement("div");
    place(added, { top: 50, parent: inner });
    place(q, { top: 90 });
    inner.insertBefore(added, q);
    await flushMutations();
    const [flyQ] = callsOn(q);
    expect(callsOn(p)).toHaveLength(0);
    frame();
    // 内层随之长高：尺寸观察在这一帧的渲染步骤里报，外层下面的兄弟被挤
    place(below, { top: 140 });
    sizes.resize(inner, 800);
    const [flyBelow] = callsOn(below);
    expect(start(flyBelow)).toBe("0px -40px");
    expect(flyQ.animation.play).not.toHaveBeenCalled();
    // 两个容器的等待挂在同一个队列上：下一帧只排着一个回调，两段在同一个回调里开播
    expect(frameQueue).toHaveLength(1);
    frame();
    expect(flyQ.animation.play).toHaveBeenCalledTimes(1);
    expect(flyBelow.animation.play).toHaveBeenCalledTimes(1);
  });

  it("提交发生在某一帧的动画帧回调里：增删观察报在这一帧的回调之后，新排布就在这一帧画出；这一帧尺寸观察报到时改为下一帧开播，与同一帧尺寸观察起的让位同一个回调", async () => {
    const left = document.createElement("div");
    const right = document.createElement("div");
    document.body.append(left, right);
    place(document.body, {});
    place(left, { parent: document.body, clientWidth: 400 });
    place(right, { parent: document.body, clientWidth: 400 });
    child(left, 0);
    const l2 = child(left, 100);
    const r1 = child(right, 0);
    const r2 = child(right, 100);
    const stopLeft = observeReflow(left);
    const stopRight = observeReflow(right);
    stop = () => {
      stopLeft();
      stopRight();
    };
    sizes.resize(left, 400);
    sizes.resize(right, 400);
    const unobserve = vi.spyOn(ResizeObserver.prototype, "unobserve");
    const observe = vi.spyOn(ResizeObserver.prototype, "observe");
    // 这一帧的回调里插进一项：增删观察在回调之后的微任务里报到，这时这一帧的回调都已跑过
    const added = document.createElement("div");
    const push = 20 + Math.floor(Math.random() * 100);
    place(added, { top: 100, parent: left });
    place(l2, { top: 100 + push });
    left.insertBefore(added, l2);
    await flushMutations();
    const [flyLeft] = callsOn(l2);
    expect(start(flyLeft)).toBe(`0px ${-push}px`);
    expect(flyLeft.animation.playState).toBe("paused");
    // 从静止起步的挂上了：先撤再挂回容器自己的尺寸观察，新排布画出来的那一帧的渲染步骤里一定报一次
    expect(unobserve.mock.calls.filter(([el]) => el === left)).toHaveLength(1);
    const rearm = observe.mock.calls.findIndex(([el]) => el === left);
    expect(observe.mock.calls[rearm]).toEqual([left, { box: "border-box" }]);
    expect(unobserve.mock.invocationCallOrder[0]).toBeLessThan(observe.mock.invocationCallOrder[rearm]);
    // 同一帧的渲染步骤：right 的首项变高，尺寸观察报到；left 挂回的观察也在这里报到
    place(r2, { top: 100 + push });
    sizes.resize(r1, 400);
    sizes.resize(left, 400);
    const [flyRight] = callsOn(r2);
    expect(flyRight.animation.playState).toBe("paused");
    expect(frameQueue).toHaveLength(1);
    frame();
    expect(flyLeft.animation.play).toHaveBeenCalledTimes(1);
    expect(flyRight.animation.play).toHaveBeenCalledTimes(1);
    expect(frameQueue).toHaveLength(0);
  });

  // 先被挤开的距离取多组，含随机：欠阻尼弹簧的解析解在 t=0 算出的速度带舍入误差，±34 这类起点得出 ±1e-13 而不是 0
  const firstPushes = [34, -34, 56, 120, ...Array.from({ length: 6 }, () => 1 + Math.floor(Math.random() * 400))];
  it.each(firstPushes)("等待期间又被挤（先被挤开 %ipx）：从起点加上新位移出发，仍先暂停；被顶替的那段不再播", (d) => {
    const { a, b } = column();
    place(b, { top: 100 + d });
    sizes.resize(a, 800);
    const [first] = callsOn(b);
    expect(first.animation.playState).toBe("paused");
    place(b, { top: 140 + d });
    sizes.resize(a, 800);
    expect(first.animation.cancel).toHaveBeenCalledTimes(1);
    const second = callsOn(b)[1];
    // 暂停中的动画当前时间是 0：此刻就在起点，速度为 0
    expect(start(second)).toBe(`0px ${-d - 40}px`);
    expect(second.frames[1].translate).toBe(`0px ${Math.round(springAt("settle", -d - 40, 0, SAMPLE_S).x * 100) / 100}px`);
    expect(second.animation.pause).toHaveBeenCalledTimes(1);
    expect(second.animation.playState).toBe("paused");
    frame();
    expect(first.animation.play).not.toHaveBeenCalled();
    expect(second.animation.play).toHaveBeenCalledTimes(1);
  });

  it("等待期间被落定（容器宽度变了）：当场取消，之后也不再播", () => {
    const { container, a, b } = column();
    place(b, { top: 220 });
    sizes.resize(a, 800);
    const [fly] = callsOn(b);
    place(container, { clientWidth: 790 });
    place(b, { top: 300 });
    sizes.resize(container, 790);
    expect(fly.animation.cancel).toHaveBeenCalledTimes(1);
    frame();
    frame();
    expect(fly.animation.play).not.toHaveBeenCalled();
    // 登记已清：再被挤从静止的新位移出发
    place(b, { top: 340 });
    sizes.resize(a, 790);
    expect(start(callsOn(b)[1])).toBe("0px -40px");
  });

  it("已经在走的途中再被挤：带着速度当场接着走，不再暂停", () => {
    const { a, b } = column();
    place(b, { top: 220 });
    sizes.resize(a, 800);
    const [first] = callsOn(b);
    frame();
    expect(first.animation.play).toHaveBeenCalledTimes(1);
    first.animation.currentTime = 50;
    place(b, { top: 260 });
    sizes.resize(a, 800);
    const second = callsOn(b)[1];
    const now = springAt("settle", -120, 0, 0.05);
    expect(start(second)).toBe(`0px ${Math.round((now.x - 40) * 100) / 100}px`);
    expect(second.animation.pause).not.toHaveBeenCalled();
    expect(second.animation.playState).toBe("running");
    expect(second.animation.startTime).toBeNull();
  });

  it("走 morph 的（与 framer-motion 的形变同拍）：不暂停，起步时刻钉在建好的此刻，还没走到时停在首帧", () => {
    const container = document.createElement("div");
    document.body.append(container);
    place(document.body, {});
    place(container, { parent: document.body, clientWidth: 800 });
    const a = child(container, 0);
    const b = child(container, 100);
    stop = observeReflow(container, "morph");
    sizes.resize(container, 800);
    const now = pinNow();
    place(b, { top: 220 });
    sizes.resize(a, 800);
    const [fly] = callsOn(b);
    expect(fly.animation.pause).not.toHaveBeenCalled();
    expect(fly.animation.playState).toBe("running");
    // 不等带着它的那一帧画出来才定：形变的时钟从提交那一刻走
    expect(fly.animation.startTime).toBe(now);
    // 长提交之后的第一帧，帧时间早于起步时刻：停在首个关键帧，不先画成终点
    expect(fly.options.fill).toBe("backwards");
    expect(frameQueue).toHaveLength(0);
  });

  // 先被挤开的距离取多组，含随机；还没走到的时长也随机
  const earlyPushes = [34, -34, 56, 120, ...Array.from({ length: 4 }, () => 1 + Math.floor(Math.random() * 400))];
  it.each(earlyPushes)("走 morph、还没走到起步时刻又被挤（先被挤开 %ipx）：从起点加上新位移、零速出发，起步时刻钉在这一次", (d) => {
    const { a, b } = column("morph");
    const first = pinNow();
    place(b, { top: 100 + d });
    sizes.resize(a, 800);
    const [prev] = callsOn(b);
    expect(prev.animation.startTime).toBe(first);
    // 文档时间轴还停在上一帧：当前时间为负
    prev.animation.currentTime = -(0.5 + Math.random() * 80);
    const second = pinNow();
    place(b, { top: 140 + d });
    sizes.resize(a, 800);
    expect(prev.animation.cancel).toHaveBeenCalledTimes(1);
    const next = callsOn(b)[1];
    expect(start(next)).toBe(`0px ${-d - 40}px`);
    expect(next.frames[1].translate).toBe(`0px ${Math.round(springAt("morph", -d - 40, 0, SAMPLE_S).x * 100) / 100}px`);
    expect(next.animation.startTime).toBe(second);
    expect(next.options.fill).toBe("backwards");
    expect(next.animation.pause).not.toHaveBeenCalled();
  });

  it("停止观察时还在等的：照常开始走，不会停在起点", () => {
    const { a, b } = column();
    place(b, { top: 220 });
    sizes.resize(a, 800);
    const [fly] = callsOn(b);
    stop?.();
    stop = undefined;
    frame();
    expect(fly.animation.play).toHaveBeenCalledTimes(1);
  });

  it("减少动画：不起动画，也不排帧回调", () => {
    const { a, b } = column();
    document.documentElement.setAttribute("data-sk-reduced", "");
    place(b, { top: 220 });
    sizes.resize(a, 800);
    expect(calls).toHaveLength(0);
    expect(frameQueue).toHaveLength(0);
  });
});

describe("observeReflow：容器长高、新插入的项开了新的一行", () => {
  /** 右对齐、可折行的一行按钮（宽 300，下内边距 16）：起初只有 logs 一枚，在 (230, 0)，行高 26。 */
  function actionRow(spring: SpringName) {
    const container = document.createElement("div");
    document.body.append(container);
    place(document.body, {});
    place(container, { parent: document.body, clientWidth: 300, clientHeight: 42 });
    const logs = child(container, 0, 230);
    place(logs, { height: 26 });
    stop = observeReflow(container, spring);
    sizes.resize(container, 300);
    return { container, logs };
  }

  /** 加进 dismiss 与 fix 两枚：dismiss 挤进第一行，fix 放不下、折到第二行（行高 26 加间距 8），容器长高 34。 */
  async function wrap(container: HTMLElement, logs: HTMLElement) {
    const dismiss = document.createElement("div");
    const fix = document.createElement("div");
    place(dismiss, { top: 0, left: 160, parent: container, height: 26 });
    place(fix, { top: 34, left: 200, parent: container, height: 26 });
    place(logs, { left: 90 });
    place(container, { clientHeight: 76 });
    container.append(dismiss, fix);
    await flushMutations();
    return { dismiss, fix };
  }

  it("走 morph：折到新一行的项从上一行的下沿起步（不压到上一行）、速度为 0，沿 morph 跟着外框下沿下来；挤进原有行的照常就地出现", async () => {
    const { container, logs } = actionRow("morph");
    // 时钟每读一次走一点：逐个建动画要花时间
    const view = document.defaultView;
    if (view === null) throw new Error("测试文档没有窗口");
    let clock = 2000 + Math.random() * 1000;
    const before = clock;
    vi.spyOn(view.performance, "now").mockImplementation(() => (clock += 0.25));
    heightReads = 0;
    const { dismiss, fix } = await wrap(container, logs);
    const [ride] = callsOn(fix);
    const [slide] = callsOn(logs);
    // 容器长高 34，fix 的顶边在上一行下沿（26）之下 8：只补这 8，不从 -34 起步压到上一行上
    expect(start(ride)).toBe("0px -8px");
    expect(ride.frames[1].translate).toBe(`0px ${Math.round(springAt("morph", -8, 0, SAMPLE_S).x * 100) / 100}px`);
    // 只为上一趟最低的那一项多读一次高度
    expect(heightReads).toBe(1);
    expect(ride.frames[ride.frames.length - 1].translate).toBe("0px 0px");
    // 与外框的形变同一刻起步：起步时刻钉在这一趟里读到的时刻，同一趟的几段钉在同一刻，不随逐个建动画错开
    expect(ride.animation.pause).not.toHaveBeenCalled();
    expect(ride.animation.startTime).toBeGreaterThan(before);
    expect(ride.animation.startTime).toBeLessThanOrEqual(clock);
    expect(slide.animation.startTime).toBe(ride.animation.startTime);
    expect(ride.options.fill).toBe("backwards");
    expect(callsOn(dismiss)).toHaveLength(0);
    expect(start(slide)).toBe("140px 0px");
  });

  it("走 settle（容器下沿一步到位：卡片、页面）：新的一行就地淡入，不滑", async () => {
    const { container, logs } = actionRow("settle");
    const { fix } = await wrap(container, logs);
    expect(callsOn(fix)).toHaveLength(0);
    expect(start(callsOn(logs)[0])).toBe("140px 0px");
  });

  /** 竖排的 morph 列表：a 占 [0, 50]、b 占 [50, 100]，容器高 100。 */
  function stack() {
    const container = document.createElement("div");
    document.body.append(container);
    place(document.body, {});
    place(container, { parent: document.body, clientWidth: 300, clientHeight: 100 });
    const a = child(container, 0);
    const b = child(container, 50);
    place(a, { height: 50 });
    place(b, { height: 50 });
    stop = observeReflow(container, "morph");
    sizes.resize(container, 300);
    return { container, a, b };
  }

  // [新项与上一项下沿的间隔, 容器长高多少, 补位起点（null 为就地出现）]。含边界（紧贴、不到 1px、恰好 1px、间隔比长高的还大）与随机
  const randomGap = 2 + Math.floor(Math.random() * 47);
  it.each<[number, number, string | null]>([
    [0, 50, null],
    [0.5, 50, null],
    [1, 50, "0px -1px"],
    // 下载快览追加一行：行间距 6，外框长高一行加间距
    [6, 86, "0px -6px"],
    [70, 40, "0px -40px"],
    [randomGap, 50, `0px -${randomGap}px`],
  ])("末尾追加一项（离上一项下沿 %spx、容器长高 %ipx）：补位起点不高于上一项的下沿，也不高于 -Δh", async (gap, grown, from) => {
    const { container, a, b } = stack();
    const c = document.createElement("div");
    place(c, { top: 100 + gap, parent: container, height: 50 });
    place(container, { clientHeight: 100 + grown });
    heightReads = 0;
    container.append(c);
    await flushMutations();
    if (from === null) expect(callsOn(c)).toHaveLength(0);
    else expect(start(callsOn(c)[0])).toBe(from);
    expect(callsOn(a)).toHaveLength(0);
    expect(callsOn(b)).toHaveLength(0);
    expect(heightReads).toBe(1);
  });

  // 新项顶边比原有最低一项的顶边低 drop，却仍在它的下沿之内：align-items: center 的折行行里，矮的新项与高的那项落在同一行。
  // 算出的补位是负的，补上去就成了从下面往上滑。含边界（只低 1px、只比下沿高 1px）与随机
  const sameRowDrops = [1, 39, 2 + Math.floor(Math.random() * 37)];
  it.each(sameRowDrops)("新项落在原有最低一项的上下沿之间（顶边低 %ipx）：就地淡入，不从下面往上滑；同一趟开了新一行的照常跟着下沿下来", async (drop) => {
    const container = document.createElement("div");
    document.body.append(container);
    place(document.body, {});
    // 第一行 logs（行高 26），第二行只有高 40 的 big，下内边距 16
    place(container, { parent: document.body, clientWidth: 300, clientHeight: 90 });
    const logs = child(container, 0, 230);
    const big = child(container, 34, 230);
    place(logs, { height: 26 });
    place(big, { height: 40 });
    stop = observeReflow(container, "morph");
    sizes.resize(container, 300);
    // tiny 挤进第二行，next 放不下、折到第三行（第二行下沿 74 加间距 8），容器长高 34
    const tiny = document.createElement("div");
    const next = document.createElement("div");
    place(tiny, { top: 34 + drop, left: 160, parent: container, height: 20 });
    place(next, { top: 82, left: 200, parent: container, height: 26 });
    place(container, { clientHeight: 124 });
    heightReads = 0;
    container.append(tiny, next);
    await flushMutations();
    expect(callsOn(tiny)).toHaveLength(0);
    expect(start(callsOn(next)[0])).toBe("0px -8px");
    expect(callsOn(logs)).toHaveLength(0);
    expect(callsOn(big)).toHaveLength(0);
    expect(heightReads).toBe(1);
  });

  it("插在中间（没有开新的一行）：新项就地出现，后面的兄弟照常让位", async () => {
    const { container, b } = stack();
    const x = document.createElement("div");
    place(x, { top: 50, parent: container });
    place(b, { top: 100 });
    place(container, { clientHeight: 150 });
    container.insertBefore(x, b);
    await flushMutations();
    expect(callsOn(x)).toHaveLength(0);
    expect(start(callsOn(b)[0])).toBe("0px -50px");
  });

  it("容器没长高（定高）：落在原有各项之下的新项也不动，不另读高度", async () => {
    const { container } = stack();
    place(container, { clientHeight: 300 });
    sizes.resize(container, 300);
    const c = document.createElement("div");
    place(c, { top: 120, parent: container });
    heightReads = 0;
    container.append(c);
    await flushMutations();
    expect(calls).toHaveLength(0);
    expect(heightReads).toBe(0);
  });

  it.each<[string, (container: HTMLElement) => void]>([
    [
      "减少动画",
      () => {
        document.documentElement.setAttribute("data-sk-reduced", "");
      },
    ],
    [
      "容器带暂停属性",
      (container) => {
        container.setAttribute(REFLOW_PAUSED_ATTR, "");
      },
    ],
  ])("%s：新的一行不动", async (_cause, apply) => {
    const { container, logs } = actionRow("morph");
    apply(container);
    await flushMutations();
    const { fix } = await wrap(container, logs);
    expect(callsOn(fix)).toHaveLength(0);
    expect(calls).toHaveLength(0);
  });

  it(`超过 ${REFLOW_HARD_MAX_ITEMS} 个之后回到上限以内的第一趟：只记位置，长高了也不当成开了新行`, async () => {
    const container = document.createElement("div");
    document.body.append(container);
    place(document.body, {});
    place(container, { parent: document.body, clientWidth: 800, clientHeight: REFLOW_HARD_MAX_ITEMS * 10, viewTop: 0 });
    for (let i = 0; i < REFLOW_HARD_MAX_ITEMS; i++) place(child(container, i * 10), { height: 10 });
    stop = observeReflow(container, "morph");
    sizes.resize(container, 800);
    const extra = child(container, REFLOW_HARD_MAX_ITEMS * 10);
    await flushMutations();
    extra.remove();
    place(container, { clientHeight: REFLOW_HARD_MAX_ITEMS * 10 + 100 });
    await flushMutations();
    expect(calls).toHaveLength(0);
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

  it("整层包裹被 insertBefore 换序：里面的按钮从旧位置滑过去，仍在尺寸观察里，包裹层这一层的增删照样接得到", async () => {
    const { container, host, a, b, c, d } = wrapped();
    // 包裹层挪到最前：b、c 上移 100，a 下移 200
    place(b, { top: 0 });
    place(c, { top: 100 });
    place(a, { top: 200 });
    container.insertBefore(host, a);
    await flushMutations();
    expect(callsOn(host)).toHaveLength(0);
    expect(start(callsOn(b)[0])).toBe("0px 100px");
    expect(start(callsOn(c)[0])).toBe("0px 100px");
    expect(start(callsOn(a)[0])).toBe("0px -200px");
    expect(callsOn(d)).toHaveLength(0);
    expect(sizes.observed()).toEqual(expect.arrayContaining([b, c]));
    expect(sizes.observed()).not.toContain(host);
    // 换序之后往包裹层里加一个按钮：后面的兄弟照样让位，新来的纳入观察
    const e = document.createElement("button");
    place(e, { top: 200, parent: container });
    place(a, { top: 260 });
    place(d, { top: 360 });
    host.append(e);
    await flushMutations();
    expect(callsOn(e)).toHaveLength(0);
    expect(start(callsOn(d)[0])).toBe("0px -60px");
    expect(sizes.observed()).toContain(e);
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

/** 只有 holdUntilPainted 会碰的几样：暂停、播放与播放状态。 */
function bare() {
  const animation = {
    playState: "running" as AnimationPlayState,
    pause: vi.fn(() => {
      animation.playState = "paused";
    }),
    play: vi.fn(() => {
      animation.playState = "running";
    }),
  };
  return animation;
}

const hold = (animation: ReturnType<typeof bare>, wait: number) => holdUntilPainted(animation as unknown as Animation, window, wait);

describe("holdUntilPainted", () => {
  const waits = [1, 2, 3, ...Array.from({ length: 3 }, () => 1 + Math.floor(Math.random() * 8))];
  it.each(waits)("等 %i 次动画帧回调：当场暂停，第这么多次回调时开播，之后不再排回调", (wait) => {
    const animation = bare();
    hold(animation, wait);
    expect(animation.pause).toHaveBeenCalledTimes(1);
    expect(animation.playState).toBe("paused");
    for (let i = 1; i < wait; i++) {
      frame();
      expect(animation.play).not.toHaveBeenCalled();
    }
    frame();
    expect(animation.play).toHaveBeenCalledTimes(1);
    expect(frameQueue).toHaveLength(0);
  });

  it("同一帧到期的在同一个回调里开播：先挂的等两帧、后挂的等一帧，下一帧只排着一个回调", () => {
    const early = bare();
    const late = bare();
    const later = bare();
    hold(early, HOLD_AFTER_MUTATION);
    frame();
    hold(late, HOLD_AFTER_RESIZE);
    hold(later, HOLD_AFTER_MUTATION);
    expect(frameQueue).toHaveLength(1);
    const [only] = frameQueue;
    frameQueue = [];
    only(performance.now());
    expect(early.play).toHaveBeenCalledTimes(1);
    expect(late.play).toHaveBeenCalledTimes(1);
    expect(later.play).not.toHaveBeenCalled();
    frame();
    expect(later.play).toHaveBeenCalledTimes(1);
    expect(frameQueue).toHaveLength(0);
  });

  it.each<[string, AnimationPlayState]>([
    ["被取消（落定，或被新的轨迹顶替）", "idle"],
    ["播完", "finished"],
    ["已在别处播起来", "running"],
  ])("等待期间%s：不再播，同一队列里别的照常开播", (_cause, state) => {
    const animation = bare();
    const other = bare();
    hold(animation, HOLD_AFTER_MUTATION);
    hold(other, HOLD_AFTER_MUTATION);
    animation.playState = state;
    frame();
    frame();
    expect(animation.play).not.toHaveBeenCalled();
    expect(other.play).toHaveBeenCalledTimes(1);
  });

  it.each([0, -1, 1.5, Number.NaN])("等待帧数 %s 不是正整数：报错，不暂停也不排回调", (wait) => {
    const animation = bare();
    expect(() => hold(animation, wait)).toThrow(RangeError);
    expect(animation.pause).not.toHaveBeenCalled();
    expect(frameQueue).toHaveLength(0);
  });

  it("增删引起的等两帧，尺寸变化引起的等一帧", () => {
    expect(HOLD_AFTER_MUTATION).toBe(2);
    expect(HOLD_AFTER_RESIZE).toBe(1);
  });
});

describe("followReflow", () => {
  const follow = (animation: ReturnType<typeof bare>, leader: HTMLElement, wait: number) => followReflow(animation as unknown as Animation, leader, wait);
  /** 跟随方自己的等待帧数取随机：领头的这一趟在等或当场起步时不看它。 */
  const ownWait = () => 1 + Math.floor(Math.random() * 5);

  it("领头的从静止起步、还在等：跟随的当场暂停，按领头剩下的帧数等，在同一个回调里开播", async () => {
    const { container, b, c } = column();
    const banner = document.createElement("div");
    place(banner, { top: 100, parent: container });
    place(b, { top: 140 });
    place(c, { top: 240 });
    container.insertBefore(banner, b);
    await flushMutations();
    const [lead] = callsOn(b);
    // 增删引起的等两帧：走掉一帧，领头还剩一帧
    frame();
    const follower = bare();
    follow(follower, b, 2 + ownWait());
    expect(follower.pause).toHaveBeenCalledTimes(1);
    expect(follower.playState).toBe("paused");
    expect(frameQueue).toHaveLength(1);
    const [only] = frameQueue;
    frameQueue = [];
    only(performance.now());
    expect(lead.animation.play).toHaveBeenCalledTimes(1);
    expect(follower.play).toHaveBeenCalledTimes(1);
    expect(frameQueue).toHaveLength(0);
  });

  it("领头的那一项等待随后改成少等一帧（提交发生在某一帧的回调里）：跟随的一起少等，仍在同一个回调里开播", async () => {
    const { container, b, c } = column();
    const banner = document.createElement("div");
    place(banner, { top: 100, parent: container });
    place(b, { top: 140 });
    place(c, { top: 240 });
    container.insertBefore(banner, b);
    await flushMutations();
    const [lead] = callsOn(b);
    // 还没经过回调就挂上跟随的；随后这一帧的渲染步骤里容器的尺寸观察报到
    const follower = bare();
    follow(follower, b, ownWait());
    expect(follower.playState).toBe("paused");
    sizes.resize(container, 800);
    frame();
    expect(lead.animation.play).toHaveBeenCalledTimes(1);
    expect(follower.play).toHaveBeenCalledTimes(1);
    expect(frameQueue).toHaveLength(0);
  });

  it("领头的上一段没走完又被挤、带着速度当场接着走：跟随的也不等，建好就播", () => {
    const { a, b } = column();
    place(b, { top: 220 });
    sizes.resize(a, 800);
    frame();
    const [first] = callsOn(b);
    first.animation.currentTime = 20 + Math.random() * 200;
    place(b, { top: 260 });
    sizes.resize(a, 800);
    const second = callsOn(b)[1];
    expect(second.animation.playState).toBe("running");
    const follower = bare();
    follow(follower, b, ownWait());
    expect(follower.pause).not.toHaveBeenCalled();
    expect(follower.playState).toBe("running");
    expect(frameQueue).toHaveLength(0);
  });

  it("领头的刚在这一帧的回调里开播、时钟还没走：跟随的也不等", () => {
    const { a, b } = column();
    place(b, { top: 220 });
    sizes.resize(a, 800);
    const [lead] = callsOn(b);
    frame();
    expect(lead.animation.play).toHaveBeenCalledTimes(1);
    const follower = bare();
    follow(follower, b, ownWait());
    expect(follower.pause).not.toHaveBeenCalled();
    expect(frameQueue).toHaveLength(0);
  });

  it.each<[string, (b: HTMLElement, a: HTMLElement) => void]>([
    ["领头的没有让位", () => undefined],
    [
      "领头的让位早已在走、这一趟没挪动它",
      (b, a) => {
        place(b, { top: 220 });
        sizes.resize(a, 800);
        frame();
        callsOn(b)[0].animation.currentTime = 1 + Math.random() * 200;
      },
    ],
  ])("%s：跟随的按从静止起步处理，当场暂停，等自己的帧数再播", (_cause, arrange) => {
    const { a, b } = column();
    arrange(b, a);
    const wait = ownWait();
    const follower = bare();
    follow(follower, b, wait);
    expect(follower.pause).toHaveBeenCalledTimes(1);
    for (let i = 1; i < wait; i++) {
      frame();
      expect(follower.play).not.toHaveBeenCalled();
    }
    frame();
    expect(follower.play).toHaveBeenCalledTimes(1);
    expect(frameQueue).toHaveLength(0);
  });

  it("领头的让位走 morph：报错，不暂停跟随的", () => {
    const { a, b } = column("morph");
    place(b, { top: 220 });
    sizes.resize(a, 800);
    const follower = bare();
    expect(() => follow(follower, b, HOLD_AFTER_RESIZE)).toThrow("morph");
    expect(follower.pause).not.toHaveBeenCalled();
  });

  it.each([0, -1, 1.5, Number.NaN])("等待帧数 %s 不是正整数：报错，不暂停也不排回调", (wait) => {
    const { b } = column();
    const follower = bare();
    expect(() => follow(follower, b, wait)).toThrow(RangeError);
    expect(follower.pause).not.toHaveBeenCalled();
    expect(frameQueue).toHaveLength(0);
  });
});

describe("syncReflow", () => {
  it("走 morph：当场补跑一趟，起步时刻钉在此刻、fill 为 backwards；尺寸观察随后报到时位置已记过，不重复起动画", () => {
    const { container, a, b, c } = column("morph");
    const now = pinNow();
    place(b, { top: 220 });
    place(c, { top: 320 });
    syncReflow(container);
    const [flyB] = callsOn(b);
    const [flyC] = callsOn(c);
    expect(start(flyB)).toBe("0px -120px");
    expect(start(flyC)).toBe("0px -120px");
    expect(flyB.animation.startTime).toBe(now);
    expect(flyC.animation.startTime).toBe(now);
    expect(flyB.options.fill).toBe("backwards");
    expect(flyB.animation.pause).not.toHaveBeenCalled();
    expect(callsOn(a)).toHaveLength(0);
    sizes.resize(a, 800);
    sizes.resize(container, 800);
    expect(calls).toHaveLength(2);
    expect(flyB.animation.cancel).not.toHaveBeenCalled();
  });

  it("走 settle：补跑在提交之后、新排布画出来之前，先停在起点，隔两帧再播；尺寸观察在中间那帧报到时不重复", () => {
    const { container, a, b } = column();
    place(b, { top: 220 });
    syncReflow(container);
    const [fly] = callsOn(b);
    expect(start(fly)).toBe("0px -120px");
    expect(fly.animation.playState).toBe("paused");
    expect(fly.animation.startTime).toBeNull();
    frame();
    sizes.resize(a, 800);
    expect(calls).toHaveLength(1);
    expect(fly.animation.play).not.toHaveBeenCalled();
    frame();
    expect(fly.animation.play).toHaveBeenCalledTimes(1);
  });

  it("增删观察还没报的变化一并收下：新项当场纳入观察，随后的增删观察回调不再起动画", async () => {
    const { container, b, c } = column("morph");
    const banner = document.createElement("div");
    place(banner, { top: 100, parent: container });
    place(b, { top: 140 });
    place(c, { top: 240 });
    container.insertBefore(banner, b);
    syncReflow(container);
    expect(callsOn(banner)).toHaveLength(0);
    expect(start(callsOn(b)[0])).toBe("0px -40px");
    expect(start(callsOn(c)[0])).toBe("0px -40px");
    expect(sizes.observed()).toContain(banner);
    await flushMutations();
    expect(calls).toHaveLength(2);
  });

  it("暂停开关在同一次提交里刚去掉、增删观察还没报：这一趟按暂停处理，不补滑", async () => {
    const { container, a, b } = column("morph");
    container.setAttribute(REFLOW_PAUSED_ATTR, "");
    await flushMutations();
    place(b, { top: 220 });
    container.removeAttribute(REFLOW_PAUSED_ATTR);
    syncReflow(container);
    expect(calls).toHaveLength(0);
    await flushMutations();
    sizes.resize(a, 800);
    expect(calls).toHaveLength(0);
  });

  it("没在观察中的容器：什么也不做，不读布局", () => {
    const container = document.createElement("div");
    document.body.append(container);
    place(document.body, {});
    place(container, { parent: document.body, clientWidth: 800 });
    child(container, 0);
    syncReflow(container);
    expect(layoutReads).toBe(0);
    expect(calls).toHaveLength(0);
  });

  it("停止观察之后：什么也不做", () => {
    const { container, b } = column("morph");
    stop?.();
    stop = undefined;
    place(b, { top: 220 });
    layoutReads = 0;
    syncReflow(container);
    expect(layoutReads).toBe(0);
    expect(calls).toHaveLength(0);
  });

  it("同一容器先挂上新的一份、再停旧的：补跑的是新的那一份", () => {
    const { container, b } = column("morph");
    const old = stop;
    stop = observeReflow(container, "settle");
    sizes.resize(container, 800);
    old?.();
    place(b, { top: 220 });
    syncReflow(container);
    const [fly] = callsOn(b);
    expect(start(fly)).toBe("0px -120px");
    // settle 的那一份：先停在起点
    expect(fly.animation.playState).toBe("paused");
  });
});

describe("useReflow", () => {
  type Reflow = ReturnType<typeof useReflow<HTMLDivElement>>;

  function Probe({ seen, show }: { seen: Reflow[]; show: boolean }) {
    const reflow = useReflow<HTMLDivElement>("morph");
    seen.push(reflow);
    return show ? createElement("div", { ref: reflow }, createElement("div"), createElement("div")) : null;
  }

  /** 给渲染出来的容器与它的两个子项登记布局（0 与 50），跑完只记位置的第一趟。 */
  function lay(host: HTMLElement): { a: HTMLElement; b: HTMLElement } {
    const list = host.firstElementChild;
    if (!(list instanceof HTMLElement)) throw new Error("没有渲染出容器");
    const [a, b] = Array.from(list.children);
    if (!(a instanceof HTMLElement) || !(b instanceof HTMLElement)) throw new Error("容器里没有两个子项");
    place(document.body, {});
    place(list, { parent: document.body, clientWidth: 300 });
    place(a, { top: 0, parent: list });
    place(b, { top: 50, parent: list });
    sizes.resize(list, 300);
    return { a, b };
  }

  it("ref 与 sync 引用稳定；sync 对此刻挂着的容器当场补跑一趟，卸下后什么也不做，换上新容器后补跑新的", () => {
    const seen: Reflow[] = [];
    const view = render(createElement(Probe, { seen, show: true }));
    try {
      const first = lay(view.container);
      view.rerender(createElement(Probe, { seen, show: true }));
      expect(seen.length).toBeGreaterThan(1);
      expect(seen[seen.length - 1]).toBe(seen[0]);
      expect(seen[seen.length - 1].sync).toBe(seen[0].sync);
      const now = pinNow();
      place(first.b, { top: 80 });
      seen[0].sync();
      const [fly] = callsOn(first.b);
      expect(start(fly)).toBe("0px -30px");
      expect(fly.animation.startTime).toBe(now);

      view.rerender(createElement(Probe, { seen, show: false }));
      place(first.a, { top: 20 });
      layoutReads = 0;
      seen[0].sync();
      expect(layoutReads).toBe(0);
      expect(calls).toHaveLength(1);

      view.rerender(createElement(Probe, { seen, show: true }));
      const second = lay(view.container);
      expect(second.b).not.toBe(first.b);
      place(second.b, { top: 90 });
      seen[0].sync();
      expect(start(callsOn(second.b)[0])).toBe("0px -40px");
      expect(seen[seen.length - 1]).toBe(seen[0]);
    } finally {
      view.unmount();
    }
  });

  it("还没挂上容器时 sync 什么也不做", () => {
    const seen: Reflow[] = [];
    const view = render(createElement(Probe, { seen, show: false }));
    try {
      seen[0].sync();
      expect(calls).toHaveLength(0);
    } finally {
      view.unmount();
    }
  });
});

describe("组件测试的 animate 替身（fakeAnimate）读得到让位的起步时刻与 fill", () => {
  /** 换上组件测试共用的替身，记下每次调用交回的 Animation。 */
  function stubbed(): { el: HTMLElement; animation: StubAnimation }[] {
    const made: { el: HTMLElement; animation: StubAnimation }[] = [];
    Object.defineProperty(HTMLElement.prototype, "animate", {
      configurable: true,
      writable: true,
      value: fakeAnimate<HTMLElement>((el, _frames, _options, animation) => made.push({ el, animation })),
    });
    return made;
  }

  it("走 morph：起步时刻是钉住的此刻，fill 为 backwards，不暂停", () => {
    const made = stubbed();
    const { a, b } = column("morph");
    const now = pinNow();
    place(b, { top: 220 });
    sizes.resize(a, 800);
    const [fly] = made.filter((m) => m.el === b);
    expect(fly.animation.startTime).toBe(now);
    expect(fly.animation.fill).toBe("backwards");
    expect(fly.animation.playState).toBe("running");
  });

  it("走 settle：起步时刻不钉、保持 null，fill 为 auto；先暂停，下一帧开播", () => {
    const made = stubbed();
    const { a, b } = column();
    place(b, { top: 220 });
    sizes.resize(a, 800);
    const [fly] = made.filter((m) => m.el === b);
    expect(fly.animation.startTime).toBeNull();
    expect(fly.animation.fill).toBe("auto");
    expect(fly.animation.playState).toBe("paused");
    frame();
    expect(fly.animation.playState).toBe("running");
    expect(fly.animation.startTime).toBeNull();
  });

  it("没写 fill 时按 Web Animations 的默认记成 auto；startTime 初值 null、可写", () => {
    const el = document.createElement("div");
    const animation = fakeAnimate().call(el, [{ opacity: 0 }, { opacity: 1 }], { duration: 120 });
    expect(animation.fill).toBe("auto");
    expect(animation.startTime).toBeNull();
    const at = 1000 + Math.random() * 1000;
    animation.startTime = at;
    expect(animation.startTime).toBe(at);
    expect(animation.playState).toBe("running");
  });
});

describe("holdUntilPainted 与组件测试的收尾", () => {
  // 组件测试按「先卸载、再 drainFrames、再换回真实计时器」收尾。等待队列是模块级的，排着时恰好有一个动画帧回调：
  // 排空时没走到的那一帧随假时钟丢掉，队列以为还排着，同文件后面挂进来的等待一个也不播。
  // 放在文件最后：没排空时卡住的队列不连累别的用例
  const waits = [HOLD_AFTER_MUTATION, 3 + Math.floor(Math.random() * 4)];
  it.each(waits)("假定时器下排着等 %i 帧的：drainFrames 把它走完开播，换回真实计时器后新挂的照常在真实帧上开播", async (wait) => {
    // 走环境自己的动画帧（假时钟上的那一路），不走本文件桩上的 frameQueue
    vi.mocked(window.requestAnimationFrame).mockRestore();
    vi.useFakeTimers();
    onTestFinished(() => {
      vi.useRealTimers();
    });
    const held = bare();
    hold(held, wait);
    await drainFrames();
    expect(held.play).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
    const next = bare();
    hold(next, HOLD_AFTER_RESIZE);
    await vi.waitFor(() => expect(next.play).toHaveBeenCalledTimes(1), { timeout: 1000, interval: 16 });
  });
});
