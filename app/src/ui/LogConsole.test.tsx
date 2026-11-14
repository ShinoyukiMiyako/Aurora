// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { MotionConfig } from "framer-motion";
import { act, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LogLine } from "../domain/types";
import { APP_NAME } from "../lib/app-info";
import { scrollGlide } from "../lib/motion";
import { OverlayProvider, OverlayRoot } from "../shell/overlay";
import { focusByKeyboard, keydown, render, stubResizeObserver, waitForFrames, type Rendered, type ResizeObserverStub } from "../test/dom";
import {
  countLogLevels,
  distanceFromBottom,
  droppedHead,
  ERROR_ANNOUNCE_INTERVAL_MS,
  filterLogLines,
  formatLogLines,
  LOG_ROW_HEIGHT,
  LogConsole,
  longestTextColumns,
  STICK_THRESHOLD,
  textColumns,
  WRAP_RENDER_LIMIT,
  type LogConsoleLine,
  type LogConsoleProps,
} from "./LogConsole";
import styles from "./LogConsole.module.css";

const AT = new Date(2026, 9, 30, 12, 3, 11).getTime();
const line = (i: number, level: LogConsoleLine["level"] = "info", source: LogConsoleLine["source"] = "game"): LogConsoleLine => ({
  at: AT + i * 1000,
  level,
  source,
  text: `第 ${i} 行`,
});
const lines = (n: number, from = 0) => Array.from({ length: n }, (_, i) => line(from + i));

const VIEWPORT = 220;
const PADDING = 8 + 14;
const scrollTops = new WeakMap<Element, number>();

/**
 * 平滑滚动的调用记录。jsdom 没有 scrollTo：替身记下平滑滚动，一步到位，并依次派发途中的 scroll 与结束时的 scrollend。
 * 「跳到最新」由组件自己逐帧写滚动位置，不该发出任何平滑滚动，用例断言这份记录为空。
 * 瞬时调用（虚拟列表写回位置、测量找补）默认不生效，与没有 scrollTo 时一致；要数它的用例自己换掉 instantImpl。
 */
let scrollToCalls: ScrollToOptions[];
let instantImpl: (el: Element, options: ScrollToOptions) => void;
const arrive = (el: Element, options: ScrollToOptions) => {
  if (options.top === undefined) throw new Error("scrollTo 没给 top");
  el.scrollTop = options.top;
  el.dispatchEvent(new Event("scroll"));
  el.dispatchEvent(new Event("scrollend"));
};

let view: Rendered | undefined;
let ro: ResizeObserverStub;
/** 滚动位置被写了几次（含组件的贴底与找补）。 */
let scrollTopWrites: number;
beforeEach(() => {
  scrollToCalls = [];
  instantImpl = () => undefined;
  Object.defineProperty(Element.prototype, "scrollTo", {
    configurable: true,
    writable: true,
    value(this: Element, options: ScrollToOptions) {
      if (options.behavior !== "smooth") {
        instantImpl(this, options);
        return;
      }
      scrollToCalls.push(options);
      arrive(this, options);
    },
  });
  ro = stubResizeObserver();
  scrollTopWrites = 0;
  // jsdom 不做布局：日志区给一个固定视口高，内容高取画布（滚动区里最后一块，前面可能有省略说明条）声明的高度，滚动位置记在表里
  vi.spyOn(Element.prototype, "clientHeight", "get").mockImplementation(function (this: Element) {
    return this.getAttribute("role") === "log" ? VIEWPORT : 0;
  });
  vi.spyOn(Element.prototype, "scrollHeight", "get").mockImplementation(function (this: Element) {
    if (this.getAttribute("role") !== "log") return 0;
    return Number.parseFloat((this.lastElementChild as HTMLElement).style.height);
  });
  vi.spyOn(Element.prototype, "scrollTop", "get").mockImplementation(function (this: Element) {
    const top = scrollTops.get(this);
    return top === undefined ? 0 : top;
  });
  vi.spyOn(Element.prototype, "scrollTop", "set").mockImplementation(function (this: Element, value: number) {
    scrollTopWrites++;
    scrollTops.set(this, value);
  });
  vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(function (this: HTMLElement) {
    return this.dataset.index === undefined ? 0 : LOG_ROW_HEIGHT;
  });
});
afterEach(() => {
  view?.unmount();
  view = undefined;
  vi.useRealTimers();
  delete (Element.prototype as { scrollTo?: unknown }).scrollTo;
});

const base: LogConsoleProps = {
  title: "启动日志",
  lines: [],
  dropped: 0,
  live: false,
  level: "all",
  source: "all",
  onCopy: () => Promise.resolve(),
  copyFeedbackMs: 2000,
};

const ui = (props: Partial<LogConsoleProps>): ReactNode => (
  <OverlayProvider>
    <LogConsole {...base} {...props} />
    <OverlayRoot />
  </OverlayProvider>
);

function mount(props: Partial<LogConsoleProps>) {
  view = render(ui(props));
  return view.container;
}

const scroller = () => document.querySelector<HTMLElement>('[role="log"]') as HTMLElement;
const rendered = () => [...scroller().querySelectorAll<HTMLElement>("[data-index]")];
const jump = () => [...document.querySelectorAll("button")].find((b) => b.textContent === "跳到最新");
const userScroll = (top: number) =>
  act(() => {
    scroller().scrollTop = top;
    scroller().dispatchEvent(new Event("scroll"));
  });
/** n 行时滚到底的位置：「跳到最新」以元素能滚到的最大位置为目标。 */
const maxTop = (n: number) => n * LOG_ROW_HEIGHT + PADDING - VIEWPORT;

describe("纯函数", () => {
  const mixed = [line(0, "info", "launcher"), line(1, "warn", "game"), line(2, "error", "game"), line(3, "error", "launcher"), line(4, "info", "game")];

  it("与领域模型的日志行同形", () => {
    const fromDomain: LogConsoleLine = { at: 1, level: "warn", source: "launcher", text: "x" } satisfies LogLine;
    const back: LogLine = fromDomain;
    expect(back.level).toBe("warn");
  });

  it("级别筛选：警告及以上包含错误；来源筛选独立叠加", () => {
    expect(filterLogLines(mixed, "all", "all")).toHaveLength(5);
    expect(filterLogLines(mixed, "warn", "all").map((l) => l.level)).toEqual(["warn", "error", "error"]);
    expect(filterLogLines(mixed, "error", "game").map((l) => l.text)).toEqual(["第 2 行"]);
    expect(filterLogLines(mixed, "all", "launcher").map((l) => l.text)).toEqual(["第 0 行", "第 3 行"]);
  });

  it("级别计数随来源筛选", () => {
    expect(countLogLevels(mixed, "all")).toEqual({ all: 5, warn: 3, error: 2 });
    expect(countLogLevels(mixed, "game")).toEqual({ all: 3, warn: 2, error: 1 });
    expect(countLogLevels([], "all")).toEqual({ all: 0, warn: 0, error: 0 });
  });

  it("复制格式：[时:分:秒] [来源/级别] 正文，启动器来源写产品名", () => {
    expect(formatLogLines([line(0, "info", "launcher"), line(1, "error", "game")])).toBe(`[12:03:11] [${APP_NAME}/INFO] 第 0 行\n[12:03:12] [Game/ERROR] 第 1 行`);
  });
});

describe("日志行", () => {
  it("四列：时间、级别文字、来源、正文；级别同时写在行上供着色与左边框", () => {
    mount({ lines: [line(0, "info", "launcher"), line(1, "warn"), line(2, "error")] });
    expect(scroller().getAttribute("aria-live")).toBe("off");
    const rows = rendered();
    expect(rows.map((r) => r.dataset.level)).toEqual(["info", "warn", "error"]);
    expect(rows.map((r) => [...r.children].map((c) => c.textContent))).toEqual([
      ["12:03:11", "INFO", APP_NAME, "第 0 行"],
      ["12:03:12", "WARN", "Game", "第 1 行"],
      ["12:03:13", "ERROR", "Game", "第 2 行"],
    ]);
    expect(rows[1].style.transform).toBe(`translateY(${8 + LOG_ROW_HEIGHT}px)`);
  });

  it("按筛选值只显示对应行", () => {
    mount({ lines: [line(0), line(1, "warn"), line(2, "error", "launcher")], level: "warn", source: "game", filters: <span data-filters="" /> });
    expect(rendered().map((r) => r.dataset.level)).toEqual(["warn"]);
    expect(document.querySelector("[data-filters]")).not.toBeNull();
  });

  it("实时输出：光标只在最后一行，头部图标换成运行态", () => {
    mount({ lines: lines(4), live: true });
    const cursors = rendered().map((r) => r.querySelector('[aria-hidden="true"]') !== null);
    expect(cursors).toEqual([false, false, false, true]);
    expect(document.querySelector<HTMLElement>("[data-live]")).not.toBeNull();
  });

  it("不在实时输出时没有光标", () => {
    mount({ lines: lines(3), live: false });
    expect(rendered().some((r) => r.querySelector('[aria-hidden="true"]') !== null)).toBe(false);
    expect(document.querySelector("[data-live]")).toBeNull();
  });

  it("常驻虚拟化：几千行只渲染视口附近", () => {
    mount({ lines: lines(5000) });
    expect(rendered().length).toBeGreaterThan(0);
    expect(rendered().length).toBeLessThan(40);
    expect((scroller().firstElementChild as HTMLElement).style.height).toBe(`${5000 * LOG_ROW_HEIGHT + PADDING}px`);
  });
});

describe("贴底与跳到最新", () => {
  /**
   * 「跳到最新」的补间由组件自己逐帧排：换成手动的帧，按用例给的时间戳推进。
   * framer-motion 用它导入时取走的 requestAnimationFrame，胶囊的进出照常走真实帧。
   */
  const queued = new Map<number, FrameRequestCallback>();
  let nextFrameId = 1;
  let clock = 0;
  beforeEach(() => {
    queued.clear();
    clock = 1000;
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      const id = nextFrameId++;
      queued.set(id, callback);
      return id;
    });
    vi.stubGlobal("cancelAnimationFrame", (id: number) => {
      queued.delete(id);
    });
  });
  afterEach(() => {
    // 先卸载：卸载时取消排着的帧也要经过替身
    view?.unmount();
    view = undefined;
    vi.unstubAllGlobals();
  });

  const FRAME_MS = 16;
  /** 时钟前进 ms，执行排着的帧回调；不替浏览器派发滚动事件（浏览器的那一次要到下一帧才来）。 */
  const runFrame = (ms: number) =>
    act(() => {
      clock += ms;
      const due = [...queued.values()];
      queued.clear();
      for (const callback of due) callback(clock);
    });
  /** 走一帧：执行排着的帧回调；滚动位置变了，再像浏览器那样派发一次 scroll。 */
  const frame = (ms = FRAME_MS) => {
    const before = scroller().scrollTop;
    runFrame(ms);
    if (scroller().scrollTop !== before) act(() => scroller().dispatchEvent(new Event("scroll")));
  };
  /** 逐帧走到补间结束（不再排帧），每帧之前先做 beforeFrame。走了一秒还没结束就报错，不让用例空转。 */
  const glideOut = (beforeFrame: () => void = () => undefined) => {
    for (let spent = 0; queued.size > 0; spent += FRAME_MS) {
      if (spent > 1000) throw new Error("补间走了一秒还没结束");
      beforeFrame();
      frame();
    }
  };
  /** 补间时长取整到毫秒：用例按它逐帧推进时间。 */
  const glideMs = (distance: number) => Math.round(scrollGlide(distance).duration * 1000);
  const clickJump = () => {
    const button = jump();
    if (button === undefined) throw new Error("没有出现跳到最新");
    act(() => button.click());
  };
  const toggleWrap = () => act(() => document.querySelector<HTMLButtonElement>('button[aria-label="自动换行"]')?.click());
  /** 行的上沿：虚拟列表写在 transform 里的位置。 */
  const rowStart = (row: HTMLElement) => {
    const match = /^translateY\((-?[\d.]+)px\)$/.exec(row.style.transform);
    if (match === null) throw new Error(`认不出行的位置：${row.style.transform}`);
    return Number(match[1]);
  };
  const renderedInOrder = () => rendered().sort((a, b) => Number(a.dataset.index) - Number(b.dataset.index));
  /** ResizeObserver 对每个新挂上的行报一次初始尺寸，之后尺寸不变就不再报。 */
  const rowReporter = () => {
    const reported = new WeakSet<Element>();
    return () => {
      for (const row of rendered()) {
        if (reported.has(row)) continue;
        reported.add(row);
        ro.resize(row, 600);
      }
    };
  };

  it("挂载即贴底，新行进来跟着滚到底", () => {
    mount({ lines: lines(10) });
    expect(scroller().scrollTop).toBe(10 * LOG_ROW_HEIGHT + PADDING);
    view?.rerender(ui({ lines: lines(15) }));
    expect(scroller().scrollTop).toBe(15 * LOG_ROW_HEIGHT + PADDING);
    expect(jump()).toBeUndefined();
  });

  /**
   * 浏览器为贴底写入派发的那次滚动事件：位置先夹到能滚到的最大处（jsdom 的替身不夹）。
   * 虚拟列表收到它就进入「滚动中」，150 ms 没有新的滚动事件才复位；实时输出每批只隔 100 ms，贴底跟随时它一直在「滚动中」。
   */
  const reportStickScroll = () =>
    act(() => {
      const el = scroller();
      el.scrollTop = Math.max(0, Math.min(el.scrollTop, el.scrollHeight - VIEWPORT));
      el.dispatchEvent(new Event("scroll"));
    });

  it("换行时贴底跟随实时输出：虚拟列表一直在「滚动中」，新挂上的行仍当场量出高度，这一帧就按真实高度排开、贴到真实的底部", () => {
    // 与环形缓冲一样只在尾部追加，已有的行对象不换
    const all = lines(60);
    mount({ lines: all.slice(0, 40), live: true });
    toggleWrap();
    // 之后来的行都折成三行
    const realHeight = (index: number) => (index >= 40 ? 3 * LOG_ROW_HEIGHT : LOG_ROW_HEIGHT);
    vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(function (this: HTMLElement) {
      return this.dataset.index === undefined ? 0 : realHeight(Number(this.dataset.index));
    });
    for (let count = 43; count <= 58; count += 3) {
      reportStickScroll();
      view?.rerender(ui({ lines: all.slice(0, count), live: true }));
      // 不报 ResizeObserver：此刻的样子就是这一帧画出去的样子
      const rows = renderedInOrder();
      expect(Number(rows.at(-1)?.dataset.index)).toBe(count - 1);
      for (let i = 1; i < rows.length; i++) {
        expect(rowStart(rows[i]), `${count} 行时第 ${rows[i].dataset.index} 行`).toBe(rowStart(rows[i - 1]) + realHeight(Number(rows[i - 1].dataset.index)));
      }
      expect(scroller().scrollTop, "贴到按真实行高算出的底部").toBe(40 * LOG_ROW_HEIGHT + (count - 40) * 3 * LOG_ROW_HEIGHT + PADDING);
    }
    expect(jump()).toBeUndefined();
  });

  it("贴底跟随实时输出时打开自动换行：视口之上的行挂载时量出高度也不写测量找补、不在提交阶段要求同步重渲染，仍贴在底部", () => {
    const error = vi.spyOn(console, "error");
    mount({ lines: lines(60), live: true });
    reportStickScroll();
    // 每行都折成两行：视口之上的行第一次量出高度，虚拟列表默认会为它们各写一次瞬时滚动
    vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(function (this: HTMLElement) {
      return this.dataset.index === undefined ? 0 : 2 * LOG_ROW_HEIGHT;
    });
    let instantWrites = 0;
    instantImpl = () => {
      instantWrites++;
    };
    toggleWrap();
    expect(instantWrites).toBe(0);
    expect(error).not.toHaveBeenCalled();
    expect(scroller().scrollTop).toBe(scroller().scrollHeight);
    expect(jump()).toBeUndefined();
  });

  it(`距底不足 ${STICK_THRESHOLD}px 仍算贴底，再往上就停止跟随并出现「跳到最新」`, () => {
    mount({ lines: lines(20) });
    const height = 20 * LOG_ROW_HEIGHT + PADDING;
    userScroll(height - VIEWPORT - (STICK_THRESHOLD - 1));
    expect(jump()).toBeUndefined();
    userScroll(height - VIEWPORT - STICK_THRESHOLD);
    expect(jump()).toBeDefined();
  });

  it("上翻后新行不再拉动位置；点「跳到最新」由组件逐帧滚回底部、不发平滑滚动命令，到底后恢复贴底，按钮淡出", async () => {
    mount({ lines: lines(20) });
    userScroll(0);
    view?.rerender(ui({ lines: lines(30) }));
    expect(scroller().scrollTop).toBe(0);
    clickJump();
    // 点下那一刻不动；起步那一帧定下时间起点，之后每帧往下走
    expect(scroller().scrollTop).toBe(0);
    frame();
    frame();
    expect(scroller().scrollTop).toBeGreaterThan(0);
    expect(scroller().scrollTop).toBeLessThan(maxTop(30));
    glideOut();
    expect(scroller().scrollTop).toBe(maxTop(30));
    expect(scrollToCalls).toEqual([]);
    await waitForFrames(() => expect(jump()).toBeUndefined());
    view?.rerender(ui({ lines: lines(31) }));
    expect(scroller().scrollTop).toBe(31 * LOG_ROW_HEIGHT + PADDING);
  });

  it("在日志区按 End 等同于跳到最新", async () => {
    mount({ lines: lines(20) });
    userScroll(0);
    const end = keydown(scroller(), "End");
    expect(end.defaultPrevented).toBe(true);
    glideOut();
    expect(scroller().scrollTop).toBe(maxTop(20));
    await waitForFrames(() => expect(jump()).toBeUndefined());
  });

  it("Alt、Meta 组合的 Home、End 交给浏览器：不拦默认行为、不排补间，进行中的补间当场停下", () => {
    mount({ lines: lines(100) });
    userScroll(0);
    for (const init of [{ altKey: true }, { metaKey: true }, { ctrlKey: true, altKey: true }]) {
      for (const key of ["Home", "End"]) {
        expect(keydown(scroller(), key, init).defaultPrevented, `${key} ${JSON.stringify(init)}`).toBe(false);
        expect(queued.size).toBe(0);
      }
    }
    clickJump();
    frame();
    expect(queued.size).toBe(1);
    keydown(scroller(), "End", { altKey: true });
    expect(queued.size).toBe(0);
  });

  it("换行时按 Home：组件自己逐帧滚到顶，往上途经的行第一次量出高度也正好停在 0，不发滚动命令、不写测量找补；离开底部，出现「跳到最新」", () => {
    const all = lines(201);
    mount({ lines: all.slice(0, 200) });
    toggleWrap();
    reportStickScroll();
    // 120 行之前折成两行：往上途中才第一次渲染、第一次量出高度，起点都在滚动位置之上
    const realHeight = (index: number) => (index < 120 ? 2 * LOG_ROW_HEIGHT : LOG_ROW_HEIGHT);
    vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(function (this: HTMLElement) {
      return this.dataset.index === undefined ? 0 : realHeight(Number(this.dataset.index));
    });
    // 浏览器把测量找补的瞬时写入叠加到进行中的键盘平滑滚动的终点上：途中一次都不该有
    let instantWrites = 0;
    instantImpl = () => {
      instantWrites++;
    };
    const home = keydown(scroller(), "Home");
    expect(home.defaultPrevented).toBe(true);
    expect(jump(), "按下就离开了底部").toBeDefined();
    frame();
    frame();
    expect(scroller().scrollTop).toBeGreaterThan(0);
    // 途中挂上的行不报 ResizeObserver 也已按真实高度排开
    const rows = renderedInOrder();
    for (let i = 1; i < rows.length; i++) {
      expect(rowStart(rows[i]), `第 ${rows[i].dataset.index} 行`).toBe(rowStart(rows[i - 1]) + realHeight(Number(rows[i - 1].dataset.index)));
    }
    glideOut(rowReporter());
    expect(scroller().scrollTop).toBe(0);
    expect(Number(renderedInOrder()[0].dataset.index)).toBe(0);
    expect(scrollToCalls).toEqual([]);
    expect(instantWrites).toBe(0);
    // 停在顶上：新行进来不拉回底部
    view?.rerender(ui({ lines: all }));
    expect(scroller().scrollTop).toBe(0);
  });

  it("换行时按 Ctrl+Home、Ctrl+End：与 Home、End 一样由组件逐帧滚到头，途经的行第一次量出高度也正好停在头上，不发滚动命令、不写测量找补", async () => {
    mount({ lines: lines(200) });
    toggleWrap();
    reportStickScroll();
    // 前 120 行折成两行：往上途中才第一次渲染、第一次量出高度
    const realHeight = (index: number) => (index < 120 ? 2 * LOG_ROW_HEIGHT : LOG_ROW_HEIGHT);
    vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(function (this: HTMLElement) {
      return this.dataset.index === undefined ? 0 : realHeight(Number(this.dataset.index));
    });
    // 浏览器把测量找补的瞬时写入叠加到进行中的键盘平滑滚动的终点上：途中一次都不该有
    let instantWrites = 0;
    instantImpl = () => {
      instantWrites++;
    };
    const ctrlHome = keydown(scroller(), "Home", { ctrlKey: true });
    expect(ctrlHome.defaultPrevented).toBe(true);
    expect(queued.size, "排上了组件自己的补间").toBe(1);
    expect(jump(), "按下就离开了底部").toBeDefined();
    glideOut(rowReporter());
    expect(scroller().scrollTop).toBe(0);
    expect(Number(renderedInOrder()[0].dataset.index)).toBe(0);

    const ctrlEnd = keydown(scroller(), "End", { ctrlKey: true });
    expect(ctrlEnd.defaultPrevented).toBe(true);
    expect(queued.size, "排上了组件自己的补间").toBe(1);
    glideOut(rowReporter());
    expect(distanceFromBottom(scroller())).toBe(0);
    expect(scrollToCalls).toEqual([]);
    expect(instantWrites).toBe(0);
    await waitForFrames(() => expect(jump()).toBeUndefined());
    // 回到贴底：新行进来跟着滚到底
    view?.rerender(ui({ lines: lines(201) }));
    expect(scroller().scrollTop).toBe(scroller().scrollHeight);
  });

  it("滚到顶与滚到底的补间途中按反方向的键：从当前位置改道，不跳；同方向再按不重起", () => {
    mount({ lines: lines(100) });
    reportStickScroll();
    keydown(scroller(), "Home");
    frame();
    frame();
    const turnedAt = scroller().scrollTop;
    expect(turnedAt).toBeGreaterThan(0);
    expect(turnedAt).toBeLessThan(maxTop(100));
    keydown(scroller(), "End");
    expect(queued.size).toBe(1);
    // 改道后的起步那一帧停在当前位置，不先跳回哪一头；之后往下走
    frame();
    expect(scroller().scrollTop).toBe(turnedAt);
    frame();
    expect(scroller().scrollTop).toBeGreaterThan(turnedAt);
    keydown(scroller(), "Home");
    frame();
    frame();
    // 往顶部走的途中再按 Home 不重起：重起的话下一帧只定时间起点、停在原地
    const before = scroller().scrollTop;
    keydown(scroller(), "Home");
    frame();
    expect(scroller().scrollTop).toBeLessThan(before);
    glideOut();
    expect(scroller().scrollTop).toBe(0);
  });

  it("内容不满一屏时按 Home：顶部本来就在贴底范围里，仍跟随新行", () => {
    mount({ lines: lines(3) });
    reportStickScroll();
    expect(keydown(scroller(), "Home").defaultPrevented).toBe(true);
    expect(queued.size).toBe(0);
    expect(jump()).toBeUndefined();
    view?.rerender(ui({ lines: lines(4) }));
    expect(scroller().scrollTop).toBe(scroller().scrollHeight);
  });

  it("减少动画时按 Home 直接到顶，不排补间", () => {
    view = render(<MotionConfig reducedMotion="always">{ui({ lines: lines(40) })}</MotionConfig>);
    reportStickScroll();
    keydown(scroller(), "Home");
    expect(queued.size).toBe(0);
    expect(scroller().scrollTop).toBe(0);
    expect(scrollToCalls).toEqual([]);
  });

  it("「跳到最新」出现时从透明处淡入，不是一帧冒出来", () => {
    mount({ lines: lines(20) });
    userScroll(0);
    expect(jump()?.style.opacity).toBe("0");
  });

  it("「跳到最新」平常从下方 8px 处滑上来；减少动画时进出都只动透明度，挂载那一帧不停在下方", async () => {
    mount({ lines: lines(20) });
    userScroll(0);
    expect(jump()?.style.transform).toBe("translateY(8px)");
    view?.unmount();
    view = render(<MotionConfig reducedMotion="always">{ui({ lines: lines(20) })}</MotionConfig>);
    userScroll(0);
    const button = jump();
    if (button === undefined) throw new Error("没有出现跳到最新");
    expect([button.style.opacity, button.style.transform]).toEqual(["0", ""]);
    act(() => button.click());
    // 收起时只淡出：位移与缩放在减少动画下是一步到位的，带上它们的退场会先跳一下
    expect(button.style.transform).toBe("");
    await waitForFrames(() => expect(jump()).toBeUndefined());
  });

  it("补间时长按起步时的距离给、远距离封顶；到时长那一帧正好写到底并结束，途中再按 End 不重起", () => {
    const near = glideMs(100);
    const far = glideMs(maxTop(400));
    expect(far).toBeGreaterThan(near);
    // 再远也不更慢
    expect(glideMs(100 * maxTop(400))).toBe(far);

    mount({ lines: lines(40) });
    userScroll(maxTop(40) - 100);
    clickJump();
    frame();
    frame(Math.floor(near / 2));
    keydown(scroller(), "End");
    frame(near - Math.floor(near / 2) - 1);
    expect(queued.size, "差 1 ms 到时长：补间还在走").toBe(1);
    expect(distanceFromBottom(scroller())).toBeGreaterThan(0);
    frame(1);
    expect(queued.size).toBe(0);
    expect(scroller().scrollTop).toBe(maxTop(40));

    view?.unmount();
    mount({ lines: lines(400) });
    userScroll(0);
    clickJump();
    frame();
    frame(far - 1);
    expect(queued.size, "差 1 ms 到时长：补间还在走").toBe(1);
    frame(1);
    expect(queued.size).toBe(0);
    expect(scroller().scrollTop).toBe(maxTop(400));
    expect(scrollToCalls).toEqual([]);
  });

  it("换行时补间途中连续追加行、途经的行量出新高度：每帧追着当时的底部走，提交与测量都不动滚动位置、不发滚动命令，按时结束并贴底", async () => {
    // 与环形缓冲一样只在尾部追加，已有的行对象不换：行的键随对象走，换了对象量过的高度就丢了
    const all = lines(300);
    mount({ lines: all.slice(0, 200) });
    toggleWrap();
    userScroll(0);
    // 120 行之后折成两行：跳转途中才第一次渲染、第一次量出高度
    vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(function (this: HTMLElement) {
      if (this.dataset.index === undefined) return 0;
      return Number(this.dataset.index) >= 120 ? 2 * LOG_ROW_HEIGHT : LOG_ROW_HEIGHT;
    });
    // 虚拟列表的测量找补走瞬时 scrollTo：途经的行在滚动位置之上第一次量出高度时它默认会写一次，途中一次都不该有
    let instantWrites = 0;
    instantImpl = () => {
      instantWrites++;
    };
    const reportNewRows = rowReporter();
    const total = glideMs(maxTop(200));
    clickJump();
    frame();
    let count = 200;
    let last = scroller().scrollTop;
    for (let spent = FRAME_MS; spent < total; spent += FRAME_MS) {
      // 每帧来一行新日志，新挂上的行把尺寸报上来
      count++;
      const before = scroller().scrollTop;
      view?.rerender(ui({ lines: all.slice(0, count) }));
      reportNewRows();
      expect(scroller().scrollTop, "提交新行、量出行高时不写滚动位置").toBe(before);
      frame();
      expect(queued.size, `第 ${spent} ms 补间还在走`).toBe(1);
      expect(scroller().scrollTop).toBeGreaterThan(last);
      last = scroller().scrollTop;
    }
    expect(distanceFromBottom(scroller())).toBeGreaterThan(0);
    count++;
    view?.rerender(ui({ lines: all.slice(0, count) }));
    reportNewRows();
    frame();
    // 到时长：写到这一刻的底部，补间结束
    expect(queued.size).toBe(0);
    expect(distanceFromBottom(scroller())).toBe(0);
    expect(scrollToCalls).toEqual([]);
    expect(instantWrites).toBe(0);
    await waitForFrames(() => expect(jump()).toBeUndefined());
    // 之后新行照常即时贴底
    view?.rerender(ui({ lines: all.slice(0, count + 1) }));
    expect(scroller().scrollTop).toBe(scroller().scrollHeight);
  });

  it("换行时落点附近有从没量过的折行行：跳到最新之后每一行都按量出的真实高度排开，不叠在下一行上", async () => {
    // 在底部打开换行再上翻：之后新来的行从没挂载过、没量过；其中后段的行折成两行
    mount({ lines: lines(40) });
    toggleWrap();
    userScroll(0);
    view?.rerender(ui({ lines: lines(200) }));
    const realHeight = (index: number) => (index >= 120 ? 2 * LOG_ROW_HEIGHT : LOG_ROW_HEIGHT);
    vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(function (this: HTMLElement) {
      return this.dataset.index === undefined ? 0 : realHeight(Number(this.dataset.index));
    });
    const reportNewRows = rowReporter();
    clickJump();
    // 每帧把新挂上的行报上来：量出新高度、终点跟着推远、又挂上新的行
    glideOut(reportNewRows);
    reportNewRows();
    await waitForFrames(() => expect(jump()).toBeUndefined());
    expect(distanceFromBottom(scroller())).toBe(0);

    const rows = renderedInOrder();
    expect(Number(rows.at(-1)?.dataset.index)).toBe(199);
    expect(rows.length).toBeGreaterThan(12);
    for (let i = 1; i < rows.length; i++) {
      expect(rowStart(rows[i]), `第 ${rows[i].dataset.index} 行`).toBe(rowStart(rows[i - 1]) + realHeight(Number(rows[i - 1].dataset.index)));
    }
  });

  it("换行时补间一帧滚过几屏：新挂上的行当场量出高度，这一帧就按真实高度排开，不等 ResizeObserver 报上来；落点上方的行量出高度也不写测量找补", () => {
    mount({ lines: lines(400) });
    toggleWrap();
    userScroll(0);
    // 每三行有一行折成三行
    const realHeight = (index: number) => (index % 3 === 0 ? 3 * LOG_ROW_HEIGHT : LOG_ROW_HEIGHT);
    vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(function (this: HTMLElement) {
      return this.dataset.index === undefined ? 0 : realHeight(Number(this.dataset.index));
    });
    // 虚拟列表的测量找补走瞬时 scrollTo：落点上方的折行行第一次量出高度时它默认会写一次，补间途中一次都不该有
    let instantWrites = 0;
    instantImpl = () => {
      instantWrites++;
    };
    clickJump();
    runFrame(FRAME_MS);
    // 只走这一帧，不报 ResizeObserver、不等浏览器的滚动事件：此刻的样子就是这一帧画出去的样子
    runFrame(Math.floor(glideMs(maxTop(400)) / 2));
    const top = scroller().scrollTop;
    const rows = renderedInOrder();
    expect(Number(rows[0].dataset.index)).toBeGreaterThan(100);
    expect(rows.some((row) => rowStart(row) <= top && rowStart(row) + realHeight(Number(row.dataset.index)) > top)).toBe(true);
    // 这一帧挂上的行里确实有落点上方、第一次量出高度的折行行：找补的判据在这里被问到过
    expect(rows.some((row) => rowStart(row) < top && Number(row.dataset.index) % 3 === 0)).toBe(true);
    for (let i = 1; i < rows.length; i++) {
      expect(rowStart(rows[i]), `第 ${rows[i].dataset.index} 行`).toBe(rowStart(rows[i - 1]) + realHeight(Number(rows[i - 1].dataset.index)));
    }
    expect(instantWrites).toBe(0);
    expect(scrollToCalls).toEqual([]);
  });

  it("一帧滚过几千像素：这一帧就换上新位置的行，不等浏览器下一帧的滚动事件，可视区不空", () => {
    mount({ lines: lines(400) });
    userScroll(0);
    clickJump();
    runFrame(FRAME_MS);
    runFrame(Math.floor(glideMs(maxTop(400)) / 2));
    const top = scroller().scrollTop;
    expect(top).toBeGreaterThan(10 * VIEWPORT);
    // 可视区从 top 到 top + VIEWPORT，首尾两行都要已经渲染出来
    const firstVisible = Math.floor((top - 8) / LOG_ROW_HEIGHT);
    const lastVisible = Math.floor((top + VIEWPORT - 8) / LOG_ROW_HEIGHT);
    const indices = rendered().map((row) => Number(row.dataset.index));
    expect(indices).toContain(firstVisible);
    expect(indices).toContain(lastVisible);
  });

  it("补间途中用户自己滚了：补间当场停下，之后的位置照常判断，新行不再拉回底部", () => {
    mount({ lines: lines(40) });
    userScroll(0);
    clickJump();
    frame();
    frame();
    act(() => {
      scroller().dispatchEvent(new WheelEvent("wheel", { bubbles: true }));
    });
    expect(queued.size).toBe(0);
    userScroll(100);
    frame();
    view?.rerender(ui({ lines: lines(41) }));
    expect(scroller().scrollTop).toBe(100);
    expect(jump()).toBeDefined();
    expect(scrollToCalls).toEqual([]);
  });

  it("补间途中卸载：排着的帧随之取消", () => {
    mount({ lines: lines(40) });
    userScroll(0);
    clickJump();
    frame();
    expect(queued.size).toBe(1);
    view?.unmount();
    view = undefined;
    expect(queued.size).toBe(0);
  });

  it("减少动画时直接到位，不排补间、不走平滑滚动", () => {
    view = render(<MotionConfig reducedMotion="always">{ui({ lines: lines(20) })}</MotionConfig>);
    userScroll(0);
    clickJump();
    expect(scrollToCalls).toEqual([]);
    expect(queued.size).toBe(0);
    expect(scroller().scrollTop).toBe(20 * LOG_ROW_HEIGHT + PADDING);
  });
});

describe("上翻阅读时的位置找补", () => {
  it("环形缓冲从头部截掉行：正在读的行留在原处", () => {
    const all = lines(40);
    mount({ lines: all.slice(0, 30) });
    userScroll(300);
    view?.rerender(ui({ lines: all.slice(3, 33) }));
    expect(scroller().scrollTop).toBe(300 - 3 * LOG_ROW_HEIGHT);
    view?.rerender(ui({ lines: all.slice(4, 34) }));
    expect(scroller().scrollTop).toBe(300 - 4 * LOG_ROW_HEIGHT);
  });

  it("换了筛选、整体换成新会话都不找补", () => {
    const mixed = [line(0), line(1), ...Array.from({ length: 20 }, (_, i) => line(2 + i, "warn"))];
    mount({ lines: mixed });
    userScroll(120);
    view?.rerender(ui({ lines: mixed, level: "warn" }));
    expect(scroller().scrollTop).toBe(120);
    view?.rerender(ui({ lines: lines(22, 100), level: "warn" }));
    expect(scroller().scrollTop).toBe(120);
  });

  it("顶上出现省略说明：上翻时按说明条的高度找补，正在读的行不被压下去", () => {
    const BAR = 31;
    vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(function (this: HTMLElement) {
      if (this.textContent?.startsWith("较早的") === true) return BAR;
      return this.dataset.index === undefined ? 0 : LOG_ROW_HEIGHT;
    });
    const all = lines(30);
    mount({ lines: all });
    userScroll(100);
    view?.rerender(ui({ lines: all, dropped: 5 }));
    expect(scroller().scrollTop).toBe(100 + BAR);
  });

  describe("用户自己换了内容、省略说明随之出现或消失时不找补", () => {
    const BAR = 31;
    beforeEach(() => {
      vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(function (this: HTMLElement) {
        if (this.textContent?.startsWith("较早的") === true) return BAR;
        return this.dataset.index === undefined ? 0 : LOG_ROW_HEIGHT;
      });
    });
    const omittedNote = () => [...document.querySelectorAll("span")].find((s) => s.textContent?.startsWith("较早的"))?.textContent;
    const toggleWrap = () => act(() => document.querySelector<HTMLButtonElement>('button[aria-label="自动换行"]')?.click());

    it("没贴底、停在最上面时打开自动换行，超过显示上限出现说明条：仍停在顶上；再关掉、说明条收起，也不找补", () => {
      mount({ lines: lines(WRAP_RENDER_LIMIT + 3) });
      userScroll(0);
      toggleWrap();
      expect(omittedNote()).toBe("较早的 3 行已省略，完整日志在 latest.log");
      expect(scroller().style.getPropertyValue("--log-omitted-pad")).toBe(`${BAR}px`);
      expect(scroller().scrollTop).toBe(0);
      userScroll(500);
      toggleWrap();
      expect(scroller().style.getPropertyValue("--log-omitted-pad")).toBe("0px");
      expect(scroller().scrollTop).toBe(500);
    });

    it("换行开着、没贴底停在最上面时从「警告及以上」切到「全部」，筛选后的行数越过显示上限出现说明条：仍停在顶上", () => {
      const mixed = [...Array.from({ length: WRAP_RENDER_LIMIT - 10 }, (_, i) => line(i, "warn")), ...lines(20, WRAP_RENDER_LIMIT)];
      mount({ lines: mixed, level: "warn" });
      toggleWrap();
      expect(omittedNote()).toBeUndefined();
      userScroll(0);
      view?.rerender(ui({ lines: mixed, level: "all" }));
      expect(omittedNote()).toBe("较早的 10 行已省略，完整日志在 latest.log");
      expect(scroller().style.getPropertyValue("--log-omitted-pad")).toBe(`${BAR}px`);
      expect(scroller().scrollTop).toBe(0);
    });
  });

  it("换了筛选之后、说明条没跟着变时，之后上翻阅读中出现的省略说明照常找补", () => {
    const BAR = 31;
    vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(function (this: HTMLElement) {
      if (this.textContent?.startsWith("较早的") === true) return BAR;
      return this.dataset.index === undefined ? 0 : LOG_ROW_HEIGHT;
    });
    const mixed = Array.from({ length: 30 }, (_, i) => line(i, "info", i % 2 === 0 ? "game" : "launcher"));
    mount({ lines: mixed });
    userScroll(100);
    view?.rerender(ui({ lines: mixed, source: "game" }));
    expect(scroller().scrollTop).toBe(100);
    view?.rerender(ui({ lines: mixed, source: "game", dropped: 5 }));
    expect(scroller().scrollTop).toBe(100 + BAR);
  });

  it("换行且超过显示上限时，无关的重渲染不重跑贴底：不在每次渲染里读写滚动区", () => {
    const all = lines(WRAP_RENDER_LIMIT + 3);
    mount({ lines: all });
    act(() => document.querySelector<HTMLButtonElement>('button[aria-label="自动换行"]')?.click());
    const writes = scrollTopWrites;
    view?.rerender(ui({ lines: all }));
    expect(scrollTopWrites).toBe(writes);
    view?.rerender(ui({ lines: [...all, line(WRAP_RENDER_LIMIT + 3)] }));
    expect(scrollTopWrites).toBe(writes + 1);
  });

  it("贴底时出现省略说明：行数没变，内容顶端让出条的高度，贴到新的底部", () => {
    const BAR = 31;
    vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(function (this: HTMLElement) {
      if (this.textContent?.startsWith("较早的") === true) return BAR;
      return this.dataset.index === undefined ? 0 : LOG_ROW_HEIGHT;
    });
    const all = lines(30);
    mount({ lines: all });
    expect(scroller().scrollTop).toBe(30 * LOG_ROW_HEIGHT + PADDING);
    view?.rerender(ui({ lines: all, dropped: 5 }));
    expect(scroller().scrollTop).toBe(30 * LOG_ROW_HEIGHT + PADDING + BAR);
  });

  it("截掉行数：首行在上次的第几位；没截或整体换掉时为 0", () => {
    const all = lines(10);
    expect(droppedHead(all, all)).toBe(0);
    expect(droppedHead(all, all.slice(3))).toBe(3);
    expect(droppedHead(all, [...all.slice(2), line(11)])).toBe(2);
    expect(droppedHead(all, lines(10))).toBe(0);
    expect(droppedHead([], all)).toBe(0);
    expect(droppedHead(all, [])).toBe(0);
  });
});

describe("横向可滚宽度", () => {
  it("正文的字符位：半角一位，全角两位，制表符走到下一个 8 位制表位", () => {
    expect(textColumns("abc")).toBe(3);
    expect(textColumns("第 1 行")).toBe(7);
    expect(textColumns("a，b")).toBe(4);
    expect(textColumns("a\tb")).toBe(9);
    expect(textColumns("abcdefgh\tc")).toBe(17);
    expect(longestTextColumns([line(0), { ...line(1), text: "x".repeat(42) }])).toBe(42);
    expect(longestTextColumns([])).toBe(0);
  });

  it("不换行时画布的最小宽按全部显示行里最长的正文给，与渲染窗口里有哪几行无关；换行时不需要", () => {
    // jsdom 里虚拟列表的渲染窗口停在顶部：把最长的一行放在末尾，它不在渲染窗口里
    const long = { ...line(3000), text: "x".repeat(300) };
    mount({ lines: [...lines(3000), long] });
    const canvas = scroller().firstElementChild as HTMLElement;
    expect(rendered().length).toBeGreaterThan(0);
    expect(rendered().some((r) => r.dataset.index === "3000")).toBe(false);
    expect(canvas.style.getPropertyValue("--log-text-cols")).toBe("300");
    act(() => document.querySelector<HTMLButtonElement>('button[aria-label="自动换行"]')?.click());
    expect(canvas.style.getPropertyValue("--log-text-cols")).toBe("0");
  });
});

describe("实时状态点", () => {
  const dot = () => document.querySelector<HTMLElement>("[data-live] > span");

  it("会话开始时运行点从零弹出；挂载时就在跑则不另外弹", () => {
    mount({ lines: lines(1), live: false });
    expect(dot()).toBeNull();
    view?.rerender(ui({ lines: lines(1), live: true }));
    expect(dot()?.style.opacity).toBe("0");
    expect(dot()?.style.transform).toBe("scale(0)");
    view?.unmount();
    mount({ lines: lines(1), live: true });
    expect(dot()?.style.opacity).toBe("1");
  });

  it("减少动画时运行点只淡入，不从零放大", () => {
    const reducedUi = (live: boolean) => <MotionConfig reducedMotion="always">{ui({ lines: lines(1), live })}</MotionConfig>;
    view = render(reducedUi(false));
    view.rerender(reducedUi(true));
    expect(dot()?.style.opacity).toBe("0");
    expect(dot()?.style.transform).toBe("");
  });
});

describe("LogConsole 样式", () => {
  const strip = (text: string) => text.replace(/\r\n/g, "\n").replace(/\/\*[\s\S]*?\*\//g, "");
  const css = strip(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "LogConsole.module.css"), "utf8"));
  const rule = (selector: string) => {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    // 换行前是逗号的是组合选择器的后半截，不当成独立的规则
    const match = new RegExp(`(?<!,)(?:^|\\n)${escaped} \\{([^}]*)\\}`).exec(css);
    if (match === null) throw new Error(`没有 ${selector} 规则`);
    return match[1];
  };

  it("日志区常驻滚动条槽，关掉浏览器滚动锚定（找补由组件自己做）", () => {
    expect(rule(".scroller")).toMatch(/scrollbar-gutter: stable;/);
    expect(rule(".scroller")).toMatch(/overflow-anchor: none;/);
  });

  it("日志行与筛选后为空的说明右内边距扣掉滚动条槽，左右留白一样宽；画布的最小宽同样扣掉", () => {
    expect(rule(".line")).toMatch(/padding: var\(--sk-space-2\) calc\(var\(--sk-space-16\) - var\(--sk-scrollbar-size\)\) var\(--sk-space-2\) var\(--sk-space-16\);/);
    expect(rule(".filteredEmpty")).toMatch(/padding: var\(--sk-space-8\) calc\(var\(--sk-space-16\) - var\(--sk-scrollbar-size\)\) 0 var\(--sk-space-16\);/);
    expect(rule(".canvas")).toMatch(/2 \* var\(--sk-space-16\) - var\(--sk-scrollbar-size\)/);
  });

  it("实时状态切换时头部图标底座的底色与字色渐变，不一帧跳过去", () => {
    expect(rule(".headIcon")).toMatch(/transition:\s*background-color var\(--sk-dur-hover\) var\(--sk-ease\),\s*color var\(--sk-dur-hover\) var\(--sk-ease\);/);
  });

  it("「跳到最新」按下缩到 0.97，悬停有叠层", () => {
    expect(rule(".jump:active")).toMatch(/scale: 0\.97;/);
    expect(rule(".jump:hover::before")).toMatch(/opacity: 1;/);
  });

  it("省略说明条粘在滚动区顶上、叠在滚过去的行上面，自身不占布局高度，底色不透明，正文不折行；筛选为空的说明让出它的高度", () => {
    expect(rule(".omittedSlot")).toMatch(/position: sticky;/);
    expect(rule(".omittedSlot")).toMatch(/top: 0;/);
    expect(rule(".omittedSlot")).toMatch(/z-index: 1;/);
    expect(rule(".omittedSlot")).toMatch(/height: 0;/);
    expect(rule(".omitted")).toMatch(/background: var\(--sk-surface\);/);
    expect(rule(".omittedText")).toMatch(/white-space: nowrap;/);
    expect(rule(".filteredEmpty")).toMatch(/translate: 0 var\(--log-omitted-pad\);/);
    expect(rule(".filteredEmpty")).not.toMatch(/margin/);
  });

  it("筛选为空的说明让位只动 translate，已在屏上时按落定弹簧过渡；减少动画时不过渡", () => {
    expect(rule(":global(:root:not([data-sk-reduced])) .filteredEmpty[data-glide]")).toMatch(/transition: translate var\(--sk-spring-settle-dur\) var\(--sk-spring-settle\);/);
    expect(css).not.toMatch(/(?<!:root:not\(\[data-sk-reduced\]\)\) )\.filteredEmpty\[data-glide\] \{/);
  });

  it("键盘聚焦日志区的焦点环画在滚动区外面一层、叠在说明条之上：说明条粘在顶上时四边都看得见", () => {
    expect(css).not.toMatch(/\.scroller:focus-visible \{/);
    expect(rule(".area")).toMatch(/isolation: isolate;/);
    const ring = rule(".area:has(> .scroller:focus-visible)::after");
    expect(ring).toMatch(/position: absolute;/);
    expect(ring).toMatch(/inset: 0;/);
    expect(ring).toMatch(/pointer-events: none;/);
    expect(ring).toMatch(/box-shadow: inset 0 0 0 2px var\(--sk-accent\);/);
    const zIndex = (body: string) => {
      const match = /z-index: (\d+);/.exec(body);
      if (match === null) throw new Error("规则里没有 z-index");
      return Number(match[1]);
    };
    expect(zIndex(ring)).toBeGreaterThan(zIndex(rule(".omittedSlot")));
  });

  it("省略说明的计数槽按四位定宽、右对齐，用等宽数字：位数在四位以内变化时后面的文字不右移", () => {
    expect(rule(".omittedCount")).toMatch(/display: inline-block;/);
    expect(rule(".omittedCount")).toMatch(/min-width: 4ch;/);
    expect(rule(".omittedCount")).toMatch(/font-variant-numeric: tabular-nums;/);
    expect(rule(".omittedCount")).toMatch(/text-align: end;/);
  });
});

describe("省略说明与换行", () => {
  it("有被丢弃的行时顶部说明数量，给了入口才出现「打开日志文件」", () => {
    const onOpenLogFile = vi.fn();
    mount({ lines: lines(3), dropped: 120, onOpenLogFile });
    const note = [...document.querySelectorAll("span")].find((s) => s.textContent?.startsWith("较早的"));
    expect(note?.textContent).toBe("较早的 120 行已省略，完整日志在 latest.log");
    const open = [...document.querySelectorAll("button")].find((b) => b.textContent === "打开日志文件");
    act(() => open?.click());
    expect(onOpenLogFile).toHaveBeenCalledTimes(1);
  });

  it("说明里的行数单独放在计数槽里：位数变了只换槽里的数字，前后文字不变", () => {
    const note = () => [...document.querySelectorAll("span")].find((s) => s.textContent?.startsWith("较早的"));
    mount({ lines: lines(3), dropped: 99 });
    const slot = note()?.querySelector(`.${styles.omittedCount}`);
    expect(slot?.textContent).toBe("99");
    view?.rerender(ui({ lines: lines(3), dropped: 100 }));
    expect(note()?.querySelector(`.${styles.omittedCount}`)).toBe(slot);
    expect(slot?.textContent).toBe("100");
    expect(note()?.textContent).toBe("较早的 100 行已省略，完整日志在 latest.log");
  });

  it("没有丢弃时不显示说明", () => {
    mount({ lines: lines(3) });
    expect([...document.querySelectorAll("span")].some((s) => s.textContent?.startsWith("较早的"))).toBe(false);
  });

  it("说明条叠在滚动区里、排在日志行之前，不压缩日志区；行经上内边距让出它的高度，滚到最上面时第一行排在条下面", () => {
    const BAR = 31;
    vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(function (this: HTMLElement) {
      if (this.textContent?.startsWith("较早的") === true) return BAR;
      return this.dataset.index === undefined ? 0 : LOG_ROW_HEIGHT;
    });
    const all = lines(3);
    mount({ lines: all });
    expect(rendered()[0].style.transform).toBe("translateY(8px)");
    expect(scroller().style.getPropertyValue("--log-omitted-pad")).toBe("0px");
    view?.rerender(ui({ lines: all, dropped: 5 }));
    const note = [...document.querySelectorAll("span")].find((s) => s.textContent?.startsWith("较早的"));
    if (note === undefined) throw new Error("没有省略说明");
    expect(scroller().contains(note)).toBe(true);
    const rows = rendered();
    expect(note.compareDocumentPosition(rows[0]) & Node.DOCUMENT_POSITION_FOLLOWING).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    expect(rows.map((r) => r.style.transform)).toEqual([0, 1, 2].map((i) => `translateY(${8 + BAR + i * LOG_ROW_HEIGHT}px)`));
    expect((scroller().lastElementChild as HTMLElement).style.height).toBe(`${3 * LOG_ROW_HEIGHT + PADDING + BAR}px`);
    expect(scroller().style.getPropertyValue("--log-omitted-pad")).toBe(`${BAR}px`);
  });

  it(`自动换行只渲染最近 ${WRAP_RENDER_LIMIT} 行，多出的计入省略数`, () => {
    mount({ lines: lines(WRAP_RENDER_LIMIT + 3), dropped: 7 });
    const toggle = document.querySelector<HTMLButtonElement>('button[aria-label="自动换行"]') as HTMLButtonElement;
    expect(toggle.getAttribute("aria-pressed")).toBe("false");
    act(() => toggle.click());
    expect(toggle.getAttribute("aria-pressed")).toBe("true");
    const note = [...document.querySelectorAll("span")].find((s) => s.textContent?.startsWith("较早的"));
    expect(note?.textContent).toBe("较早的 10 行已省略，完整日志在 latest.log");
    expect(rendered().length).toBeLessThan(60);
  });

  it("负数或小数的丢弃数抛错", () => {
    expect(() => mount({ dropped: -1 })).toThrow(/非负整数/);
  });
});

describe("筛选后为空", () => {
  const NOTE = "当前筛选下没有日志行";
  const note = () => scroller().querySelector(":scope > :not([data-index]):not([style])")?.textContent;

  it("有日志、筛选后一行不剩：日志区里显示插槽内容，不渲染任何行", () => {
    mount({ lines: [line(0, "info"), line(1, "warn")], level: "error", filteredEmpty: NOTE });
    expect(rendered()).toHaveLength(0);
    expect(scroller().textContent).toContain(NOTE);
    expect(note()).toBe(NOTE);
  });

  it("筛选后还剩一行：不显示插槽内容", () => {
    mount({ lines: [line(0, "info"), line(1, "error")], level: "error", filteredEmpty: NOTE });
    expect(rendered()).toHaveLength(1);
    expect(scroller().textContent).not.toContain(NOTE);
  });

  it("一行日志都没有：不算筛选后为空，插槽不出现", () => {
    mount({ lines: [], level: "error", filteredEmpty: NOTE });
    expect(scroller().textContent).not.toContain(NOTE);
  });

  it("切回全部：插槽消失、日志行回来", () => {
    mount({ lines: [line(0, "info"), line(1, "info")], level: "warn", source: "all", filteredEmpty: NOTE });
    expect(scroller().textContent).toContain(NOTE);
    view?.rerender(ui({ lines: [line(0, "info"), line(1, "info")], level: "all", filteredEmpty: NOTE }));
    expect(scroller().textContent).not.toContain(NOTE);
    expect(rendered()).toHaveLength(2);
  });

  describe("省略说明条出没时让出它的高度", () => {
    const BAR = 31;
    beforeEach(() => {
      vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(function (this: HTMLElement) {
        if (this.textContent?.startsWith("较早的") === true) return BAR;
        return this.dataset.index === undefined ? 0 : LOG_ROW_HEIGHT;
      });
    });
    const noteEl = () => scroller().querySelector<HTMLElement>(":scope > :not([data-index]):not([style])");
    const infoOnly = [line(0, "info"), line(1, "info")];

    it("说明已在屏上时说明条出现、收起：说明带着过渡滑开、滑回，不一帧跳过去", () => {
      mount({ lines: infoOnly, level: "error", filteredEmpty: NOTE });
      const el = noteEl();
      expect(el?.textContent).toBe(NOTE);
      expect(scroller().style.getPropertyValue("--log-omitted-pad")).toBe("0px");
      view?.rerender(ui({ lines: infoOnly, level: "error", filteredEmpty: NOTE, dropped: 5 }));
      expect(noteEl()).toBe(el);
      expect(scroller().style.getPropertyValue("--log-omitted-pad")).toBe(`${BAR}px`);
      expect(el?.hasAttribute("data-glide")).toBe(true);
      view?.rerender(ui({ lines: infoOnly, level: "error", filteredEmpty: NOTE, dropped: 0 }));
      expect(scroller().style.getPropertyValue("--log-omitted-pad")).toBe("0px");
      expect(el?.hasAttribute("data-glide")).toBe(true);
    });

    it("说明与说明条一起出现（挂载时就有省略）：量出条高的那次直接排到条下面，不滑；之后条再出没才带过渡", () => {
      mount({ lines: infoOnly, level: "error", filteredEmpty: NOTE, dropped: 5 });
      const el = noteEl();
      expect(scroller().style.getPropertyValue("--log-omitted-pad")).toBe(`${BAR}px`);
      expect(el?.hasAttribute("data-glide")).toBe(false);
      view?.rerender(ui({ lines: infoOnly, level: "error", filteredEmpty: NOTE, dropped: 0 }));
      expect(scroller().style.getPropertyValue("--log-omitted-pad")).toBe("0px");
      expect(el?.hasAttribute("data-glide")).toBe(true);
    });

    it("换到筛选为空的同时说明条收起：说明直接排在顶上，不从条下面滑上来", () => {
      const toggleWrap = () => act(() => document.querySelector<HTMLButtonElement>('button[aria-label="自动换行"]')?.click());
      const all = lines(WRAP_RENDER_LIMIT + 3);
      mount({ lines: all, filteredEmpty: NOTE });
      toggleWrap();
      expect(scroller().style.getPropertyValue("--log-omitted-pad")).toBe(`${BAR}px`);
      view?.rerender(ui({ lines: all, level: "error", filteredEmpty: NOTE }));
      expect(scroller().style.getPropertyValue("--log-omitted-pad")).toBe("0px");
      expect(noteEl()?.textContent).toBe(NOTE);
      expect(noteEl()?.hasAttribute("data-glide")).toBe(false);
    });
  });
});

describe("复制", () => {
  it("复制当前筛选下显示的全部行，成功后原位显示行数", async () => {
    const onCopy = vi.fn(() => Promise.resolve());
    const all = [line(0, "info"), line(1, "error"), line(2, "info"), line(3, "error")];
    mount({ lines: all, level: "error", onCopy });
    const copy = document.querySelector<HTMLButtonElement>('button[aria-label="复制当前显示的日志"]') as HTMLButtonElement;
    act(() => copy.click());
    expect(onCopy).toHaveBeenCalledWith(formatLogLines([all[1], all[3]]));
    await act(async () => {});
    expect(copy.getAttribute("aria-label")).toBe("已复制 2 行");
  });

  it("没有可显示的行时复制按钮禁用", () => {
    mount({ lines: [line(0, "info")], level: "error" });
    expect(document.querySelector<HTMLButtonElement>('button[aria-label="复制当前显示的日志"]')?.disabled).toBe(true);
  });

  it("给了入口才出现「打开日志文件夹」", () => {
    const onOpenFolder = vi.fn();
    mount({ lines: lines(1), onOpenFolder });
    act(() => document.querySelector<HTMLButtonElement>('button[aria-label="打开日志文件夹"]')?.click());
    expect(onOpenFolder).toHaveBeenCalledTimes(1);
  });

  it("给了 openFolderDisabledReason：文件夹按钮置灰但可聚焦，点了不打开，聚焦时写明原因", () => {
    const onOpenFolder = vi.fn();
    mount({ lines: lines(1), onOpenFolder, openFolderDisabledReason: "安装进行中，暂时不能打开" });
    const folder = document.querySelector<HTMLButtonElement>('button[aria-label="打开日志文件夹"]') as HTMLButtonElement;
    expect(folder.disabled).toBe(false);
    expect(folder.getAttribute("aria-disabled")).toBe("true");
    act(() => folder.click());
    expect(onOpenFolder).not.toHaveBeenCalled();
    focusByKeyboard(folder);
    expect(document.querySelector('[role="tooltip"]')?.textContent).toContain("安装进行中，暂时不能打开");
  });

  it("没有文件夹入口却给了原因：直接报装配错误", () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(() => mount({ lines: lines(1), openFolderDisabledReason: "安装进行中，暂时不能打开" })).toThrow("要与 onOpenFolder 一起给");
  });
});

describe("新增错误播报", () => {
  const status = () => document.querySelector('[role="status"][aria-live="polite"]')?.textContent;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"], now: AT });
  });

  it("挂载时已有的错误不播报；追加的错误立即报一次，间隔内的新错误攒到间隔满再一起报", () => {
    const first = [line(0, "error"), line(1)];
    mount({ lines: first });
    expect(status()).toBe("");
    const second = [...first, line(2, "error"), line(3, "error"), line(4)];
    view?.rerender(ui({ lines: second }));
    expect(status()).toBe("新增 2 条错误");
    act(() => vi.advanceTimersByTime(1000));
    const third = [...second, line(5, "error")];
    view?.rerender(ui({ lines: third }));
    const fourth = [...third, line(6, "error"), line(7, "error")];
    view?.rerender(ui({ lines: fourth }));
    act(() => vi.advanceTimersByTime(ERROR_ANNOUNCE_INTERVAL_MS - 1000 - 1));
    expect(status()).toBe("新增 2 条错误");
    act(() => vi.advanceTimersByTime(1));
    expect(status()).toBe("新增 3 条错误");
    const fifth = [...fourth, line(8, "warn")];
    view?.rerender(ui({ lines: fifth }));
    act(() => vi.advanceTimersByTime(ERROR_ANNOUNCE_INTERVAL_MS));
    expect(status()).toBe("新增 3 条错误");
  });

  it("环形缓冲从头部丢行时只数尾部新增的错误", () => {
    const first = [line(0, "error"), line(1), line(2)];
    mount({ lines: first });
    view?.rerender(ui({ lines: [first[1], first[2], line(3, "error")] }));
    expect(status()).toBe("新增 1 条错误");
  });

  it("缓冲被整体换掉（新会话）时重新计起，不把换进来的错误当成新增", () => {
    mount({ lines: [line(0), line(1)] });
    const fresh = [line(10, "error"), line(11, "error")];
    view?.rerender(ui({ lines: fresh }));
    expect(status()).toBe("");
    view?.rerender(ui({ lines: [...fresh, line(12, "error")] }));
    expect(status()).toBe("新增 1 条错误");
  });

  it("播报区只给读屏：走全局的视觉隐藏类，不在模块里另写一份", () => {
    mount({ lines: [line(0, "error")] });
    expect(document.querySelector('[role="status"][aria-live="polite"]')?.className).toBe("sk-sr-only");
  });
});
