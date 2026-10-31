// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LogLine } from "../domain/types";
import { APP_NAME } from "../lib/app-info";
import { OverlayProvider, OverlayRoot } from "../shell/overlay";
import { keydown, render, stubResizeObserver, type Rendered } from "../test/dom";
import {
  countLogLevels,
  ERROR_ANNOUNCE_INTERVAL_MS,
  filterLogLines,
  formatLogLines,
  LOG_ROW_HEIGHT,
  LogConsole,
  STICK_THRESHOLD,
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

let view: Rendered | undefined;
beforeEach(() => {
  stubResizeObserver();
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

  it("上翻后新行不再拉动位置；点「跳到最新」恢复贴底", () => {
    mount({ lines: lines(20) });
    userScroll(0);
    view?.rerender(ui({ lines: lines(30) }));
    expect(scroller().scrollTop).toBe(0);
    const button = jump();
    if (button === undefined) throw new Error("没有出现跳到最新");
    act(() => button.click());
    expect(scroller().scrollTop).toBe(30 * LOG_ROW_HEIGHT + PADDING);
    expect(jump()).toBeUndefined();
    view?.rerender(ui({ lines: lines(31) }));
    expect(scroller().scrollTop).toBe(31 * LOG_ROW_HEIGHT + PADDING);
  });

  it("在日志区按 End 等同于跳到最新", () => {
    mount({ lines: lines(20) });
    userScroll(0);
    const end = keydown(scroller(), "End");
    expect(end.defaultPrevented).toBe(true);
    expect(scroller().scrollTop).toBe(20 * LOG_ROW_HEIGHT + PADDING);
    expect(jump()).toBeUndefined();
    const ctrlEnd = keydown(scroller(), "End", { ctrlKey: true });
    expect(ctrlEnd.defaultPrevented).toBe(false);
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
