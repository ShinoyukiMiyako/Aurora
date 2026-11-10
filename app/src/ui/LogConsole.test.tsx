// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { MotionConfig } from "framer-motion";
import { act, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LogLine } from "../domain/types";
import { APP_NAME } from "../lib/app-info";
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
 * 平滑滚动的调用记录。jsdom 没有 scrollTo：替身记下平滑滚动（「跳到最新」经虚拟列表发出的命令），默认一步到位，
 * 并依次派发途中的 scroll 与结束时的 scrollend。瞬时调用（虚拟列表写回位置、测量找补）默认不生效，与没有 scrollTo 时一致；
 * 要模拟它中止平滑滚动的用例自己换掉 instantImpl。
 */
let scrollToCalls: ScrollToOptions[];
let scrollToImpl: (el: Element, options: ScrollToOptions) => void;
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
  scrollToImpl = arrive;
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
      scrollToImpl(this, options);
    },
  });
  ro = stubResizeObserver();
  scrollTopWrites = 0;
  // jsdom 不做布局：日志区给一个固定视口高，内容高取画布声明的高度，滚动位置记在表里
  vi.spyOn(Element.prototype, "clientHeight", "get").mockImplementation(function (this: Element) {
    return this.getAttribute("role") === "log" ? VIEWPORT : 0;
  });
  vi.spyOn(Element.prototype, "scrollHeight", "get").mockImplementation(function (this: Element) {
    if (this.getAttribute("role") !== "log") return 0;
    return Number.parseFloat((this.firstElementChild as HTMLElement).style.height);
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
/** n 行时滚到底的位置：虚拟列表的「滚到最后」以元素能滚到的最大位置为目标。 */
const maxTop = (n: number) => n * LOG_ROW_HEIGHT + PADDING - VIEWPORT;
/** 让出几帧：虚拟列表的滚动命令每帧核对一次目标。 */
const frames = (n: number) =>
  act(async () => {
    for (let i = 0; i < n; i++) await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  });

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
  it("挂载即贴底，新行进来跟着滚到底", () => {
    mount({ lines: lines(10) });
    expect(scroller().scrollTop).toBe(10 * LOG_ROW_HEIGHT + PADDING);
    view?.rerender(ui({ lines: lines(15) }));
    expect(scroller().scrollTop).toBe(15 * LOG_ROW_HEIGHT + PADDING);
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

  it("上翻后新行不再拉动位置；点「跳到最新」平滑滚回底部并恢复贴底，按钮淡出", async () => {
    mount({ lines: lines(20) });
    userScroll(0);
    view?.rerender(ui({ lines: lines(30) }));
    expect(scroller().scrollTop).toBe(0);
    const button = jump();
    if (button === undefined) throw new Error("没有出现跳到最新");
    act(() => button.click());
    expect(scrollToCalls).toEqual([{ top: maxTop(30), behavior: "smooth" }]);
    expect(scroller().scrollTop).toBe(maxTop(30));
    await waitForFrames(() => expect(jump()).toBeUndefined());
    view?.rerender(ui({ lines: lines(31) }));
    expect(scroller().scrollTop).toBe(31 * LOG_ROW_HEIGHT + PADDING);
  });

  it("在日志区按 End 等同于跳到最新", async () => {
    mount({ lines: lines(20) });
    userScroll(0);
    const end = keydown(scroller(), "End");
    expect(end.defaultPrevented).toBe(true);
    expect(scroller().scrollTop).toBe(maxTop(20));
    const ctrlEnd = keydown(scroller(), "End", { ctrlKey: true });
    expect(ctrlEnd.defaultPrevented).toBe(false);
    await waitForFrames(() => expect(jump()).toBeUndefined());
  });

  it("「跳到最新」出现时从透明处淡入，不是一帧冒出来", () => {
    mount({ lines: lines(20) });
    userScroll(0);
    expect(jump()?.style.opacity).toBe("0");
  });

  it("平滑滚动途中：途经的位置不算上翻，新行进来时把目标改到新的底部；到底后才按实际位置判断", async () => {
    mount({ lines: lines(40) });
    userScroll(0);
    let finish = () => undefined as void;
    scrollToImpl = (el, options) => {
      // 只走到半路
      el.scrollTop = 200;
      el.dispatchEvent(new Event("scroll"));
      finish = () => arrive(el, options);
    };
    const button = jump();
    if (button === undefined) throw new Error("没有出现跳到最新");
    act(() => button.click());
    expect(scrollToCalls).toEqual([{ top: maxTop(40), behavior: "smooth" }]);
    view?.rerender(ui({ lines: lines(41) }));
    // 虚拟列表的命令在下一帧发现底部变了，平滑地改去新的底部
    await waitForFrames(() => expect(scrollToCalls.at(-1)).toEqual({ top: maxTop(41), behavior: "smooth" }));
    act(() => finish());
    expect(scroller().scrollTop).toBe(maxTop(41));
    await waitForFrames(() => expect(jump()).toBeUndefined());
  });

  it("平滑滚动被中止在半路（停下时还没到底）：接着滚到底，半路的位置不算上翻", async () => {
    mount({ lines: lines(40) });
    userScroll(0);
    let stop = () => undefined as void;
    scrollToImpl = (el, options) => {
      if (scrollToCalls.length > 1) {
        arrive(el, options);
        return;
      }
      el.scrollTop = 200;
      el.dispatchEvent(new Event("scroll"));
      stop = () => el.dispatchEvent(new Event("scrollend"));
    };
    const button = jump();
    if (button === undefined) throw new Error("没有出现跳到最新");
    act(() => button.click());
    act(() => stop());
    expect(scrollToCalls).toEqual([
      { top: maxTop(40), behavior: "smooth" },
      { top: maxTop(40), behavior: "smooth" },
    ]);
    expect(scroller().scrollTop).toBe(maxTop(40));
    await waitForFrames(() => expect(jump()).toBeUndefined());
  });

  // 测量找补是一次瞬时滚动；按 CSSOM，新的程序滚动会中止正在进行的平滑滚动，平滑滚动停在原处不再走完
  it("换行时平滑滚动途中有行第一次量出高度：不被测量找补中止在半路，最终贴底、按钮不再出现", async () => {
    mount({ lines: lines(200) });
    act(() => document.querySelector<HTMLButtonElement>('button[aria-label="自动换行"]')?.click());
    userScroll(0);
    // 中段的行折成两行：滚到半路时才第一次渲染、第一次量出高度
    vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(function (this: HTMLElement) {
      if (this.dataset.index === undefined) return 0;
      const index = Number(this.dataset.index);
      return index >= 60 && index < 140 ? 2 * LOG_ROW_HEIGHT : LOG_ROW_HEIGHT;
    });
    let finish = () => undefined as void;
    instantImpl = (el, options) => {
      if (options.top === undefined) throw new Error("scrollTo 没给 top");
      finish = () => undefined;
      el.scrollTop = options.top;
      el.dispatchEvent(new Event("scroll"));
      el.dispatchEvent(new Event("scrollend"));
    };
    scrollToImpl = (el, options) => {
      if (scrollToCalls.length > 1) {
        arrive(el, options);
        return;
      }
      el.scrollTop = 2000;
      el.dispatchEvent(new Event("scroll"));
      finish = () => arrive(el, options);
    };
    const button = jump();
    if (button === undefined) throw new Error("没有出现跳到最新");
    act(() => button.click());
    // 半路上新渲染出来的行，尺寸经 ResizeObserver 报上来
    act(() => {
      for (const row of rendered()) ro.resize(row, 600);
    });
    act(() => finish());
    await waitForFrames(() => expect(jump()).toBeUndefined());
    expect(distanceFromBottom(scroller())).toBe(0);
  });

  it("平滑滚动途中用户自己滚了：之后的位置照常判断，新行不再拉回底部", async () => {
    mount({ lines: lines(40) });
    userScroll(0);
    scrollToImpl = () => undefined;
    const button = jump();
    if (button === undefined) throw new Error("没有出现跳到最新");
    act(() => button.click());
    act(() => {
      scroller().dispatchEvent(new WheelEvent("wheel", { bubbles: true }));
    });
    userScroll(100);
    view?.rerender(ui({ lines: lines(41) }));
    // 虚拟列表的命令已经撤掉：底部变了也不会在之后的帧里再发一次滚动
    await frames(3);
    expect(scrollToCalls).toHaveLength(1);
    expect(scroller().scrollTop).toBe(100);
  });

  it("减少动画时直接到位，不走平滑滚动", () => {
    view = render(<MotionConfig reducedMotion="always">{ui({ lines: lines(20) })}</MotionConfig>);
    userScroll(0);
    const button = jump();
    if (button === undefined) throw new Error("没有出现跳到最新");
    act(() => button.click());
    expect(scrollToCalls).toEqual([]);
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

  it("贴底时出现省略说明：行数与总高都没变，也重新贴到底", () => {
    const all = lines(30);
    mount({ lines: all });
    // 模拟说明条压缩日志区后底部的行被裁掉：滚动位置不再在底部，但没有派发滚动事件
    scroller().scrollTop = 5;
    view?.rerender(ui({ lines: all, dropped: 5 }));
    expect(scroller().scrollTop).toBe(30 * LOG_ROW_HEIGHT + PADDING);
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

  it("实时状态切换时头部图标底座的底色与字色渐变，不一帧跳过去", () => {
    expect(rule(".headIcon")).toMatch(/transition:\s*background-color var\(--sk-dur-hover\) var\(--sk-ease\),\s*color var\(--sk-dur-hover\) var\(--sk-ease\);/);
  });

  it("「跳到最新」按下缩到 0.97，悬停有叠层", () => {
    expect(rule(".jump:active")).toMatch(/scale: 0\.97;/);
    expect(rule(".jump:hover::before")).toMatch(/opacity: 1;/);
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

  it("没有丢弃时不显示说明", () => {
    mount({ lines: lines(3) });
    expect([...document.querySelectorAll("span")].some((s) => s.textContent?.startsWith("较早的"))).toBe(false);
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
});
