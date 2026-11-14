// 组件测试的最小渲染与环境替身：jsdom 没有 matchMedia 与 ResizeObserver，也没有布局，
// 这里按测试需要补上可控的版本。只被 *.test.tsx 引用。

import { frameData } from "framer-motion";
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { onTestFinished, vi } from "vitest";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

export interface Rendered {
  container: HTMLDivElement;
  rerender(ui: ReactNode): void;
  unmount(): void;
}

export function render(ui: ReactNode): Rendered {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  act(() => root.render(ui));
  return {
    container,
    rerender: (next) => act(() => root.render(next)),
    unmount: () => {
      act(() => root.unmount());
      container.remove();
    },
  };
}

export interface MediaQueryStub {
  /** 改变匹配结果并派发 change。 */
  set(matches: boolean): void;
  listenerCount(): number;
}

/** 替换 window.matchMedia：所有查询共用一个可控的匹配值。 */
export function stubMatchMedia(initial: boolean): MediaQueryStub {
  let matches = initial;
  const listeners = new Set<() => void>();
  const list = {
    get matches() {
      return matches;
    },
    media: "",
    onchange: null,
    addEventListener: (_type: string, listener: () => void) => listeners.add(listener),
    removeEventListener: (_type: string, listener: () => void) => listeners.delete(listener),
  };
  vi.stubGlobal("matchMedia", (media: string) => Object.assign(list, { media }));
  return {
    set(next) {
      matches = next;
      act(() => {
        for (const listener of [...listeners]) listener();
      });
    },
    listenerCount: () => listeners.size,
  };
}

export interface ResizeObserverStub {
  /** 向观察 target 的全部观察者推送一次宽度变化。 */
  resize(target: Element, width: number): void;
  observed(): Element[];
  disconnects(): number;
}

export function stubResizeObserver(): ResizeObserverStub {
  const observers = new Set<{ callback: ResizeObserverCallback; targets: Set<Element>; self: ResizeObserver }>();
  let disconnects = 0;
  class FakeResizeObserver {
    private entry: { callback: ResizeObserverCallback; targets: Set<Element>; self: ResizeObserver };
    constructor(callback: ResizeObserverCallback) {
      this.entry = { callback, targets: new Set(), self: this as unknown as ResizeObserver };
      observers.add(this.entry);
    }
    observe(target: Element) {
      this.entry.targets.add(target);
    }
    unobserve(target: Element) {
      this.entry.targets.delete(target);
    }
    disconnect() {
      disconnects++;
      this.entry.targets.clear();
      observers.delete(this.entry);
    }
  }
  vi.stubGlobal("ResizeObserver", FakeResizeObserver);
  return {
    resize(target, width) {
      act(() => {
        for (const o of [...observers]) {
          if (!o.targets.has(target)) continue;
          const entry = { target, contentRect: { width, height: 0 } } as unknown as ResizeObserverEntry;
          o.callback([entry], o.self);
        }
      });
    },
    observed: () => [...observers].flatMap((o) => [...o.targets]),
    disconnects: () => disconnects,
  };
}

/** fakeAnimate 交给组件的 Animation：组件与让位会碰的几样都在，时间不自己走。 */
export interface StubAnimation {
  currentTime: number | null;
  /**
   * 与 Web Animations 一致：建好时为 null，替身自己不定。走 morph 的让位把它钉在建好的那一刻，
   * 组件测试据此断言让位与形变同一刻起步；暂停、播放都不碰它。
   */
  startTime: number | null;
  /** animate 时传的 fill；没传时记成 Web Animations 的默认值 auto。 */
  readonly fill: FillMode;
  playState: AnimationPlayState;
  onfinish: (() => void) | null;
  oncancel: (() => void) | null;
  cancel(): void;
  finish(): void;
  pause(): void;
  play(): void;
}

/**
 * 共用的 animate 替身：作为 Object.defineProperty 的 value 装到某个元素原型（或单个元素）的 animate 上，
 * 每次调用建一个停在起点（currentTime 0、running、startTime null）的 Animation，把元素、关键帧、时间参数与它交给 record，再返回它。
 * jsdom 没有 Web Animations，装上它的元素会被让位当成能动的：从静止起步时 pause、隔几帧 play，被顶替时 cancel，
 * 接续时读 currentTime，走 morph 时写 startTime。缺哪一样，让位一起步就抛 TypeError，所以不要再手写只有一两样的返回值。
 * 这几样只改 playState 与 currentTime，不调 onfinish、oncancel（真实的事件也要等下一帧才派发）；
 * 要由用例决定何时播完、断言交接过程的，用 stubSpanAnimations。
 * 要断言让位的起步时刻与 fill 的，从 record 的第四个参数拿到 Animation，读它的 startTime 与 fill。
 * 不要装到 Element.prototype：framer-motion 按它自己有没有 animate 决定走不走 Web Animations。
 * E：装在哪类元素上，record 收到的元素就按它标注。
 */
export function fakeAnimate<E extends Element = Element>(record?: (el: E, frames: Keyframe[], options: KeyframeAnimationOptions, animation: StubAnimation) => void) {
  return function animate(this: E, frames: Keyframe[], options: KeyframeAnimationOptions): StubAnimation {
    const animation: StubAnimation = {
      currentTime: 0,
      startTime: null,
      // KeyframeEffect 的 fill 默认就是 auto，不是在补空值
      fill: options.fill ?? "auto",
      playState: "running",
      onfinish: null,
      oncancel: null,
      cancel() {
        this.playState = "idle";
        this.currentTime = null;
      },
      finish() {
        const duration = options.duration;
        if (typeof duration !== "number") throw new Error(`animate 替身只认数值时长，这次是 ${String(duration)}`);
        this.playState = "finished";
        this.currentTime = duration;
      },
      // 与 Web Animations 一致：暂停不挪时间；已取消的再暂停停在起点，已取消或播完的再播从头开始
      pause() {
        if (this.currentTime === null) this.currentTime = 0;
        this.playState = "paused";
      },
      play() {
        if (this.currentTime === null || this.playState === "finished") this.currentTime = 0;
        this.playState = "running";
      },
    };
    record?.(this, frames, options, animation);
    return animation;
  };
}

/** 假 Web Animations 记下的一次 animate 调用，同时充当返回给组件的 Animation。 */
export interface FakeAnimation {
  readonly el: Element;
  readonly frames: Keyframe[];
  readonly options: KeyframeAnimationOptions;
  /** 用例可以直接改它，模拟动画播到一半：组件被打断时按它算出此刻的值。 */
  currentTime: number | null;
  playState: AnimationPlayState;
  cancelled: boolean;
  finished: boolean;
  onfinish: (() => void) | null;
  cancel(): void;
  /** 暂停不挪时间（让位从静止起步时先停在起点、隔几帧再播）。 */
  pause(): void;
  play(): void;
}

export interface SpanAnimationsStub {
  /** 装上以来每次 animate 的调用，按先后。 */
  readonly played: readonly FakeAnimation[];
  /** el 身上还在播（没取消、没播完）、首帧带 prop 的那一个动画；不是恰好一个就报错。 */
  running(el: Element, prop: string): FakeAnimation;
  /** 动画播完：时间走到头，触发 onfinish，提交它引起的重渲染。 */
  finish(animation: FakeAnimation): void;
  /** 把此刻还在播的动画依次播完；播完引起的新动画不算。 */
  finishAll(): void;
  /** 卸下，还原原来的 animate。用例结束时自动调用。 */
  restore(): void;
}

/**
 * 给 span 装上假的 Web Animations（jsdom 没有），记下每次 animate 的关键帧与时间参数，动画不自己走，由用例决定何时播完。
 * 按钮图标位（GlyphSlot）没有 animate 时直接到位、立即移除换下的层；断言交接过程（退场层还在、新层怎么入场、播完才移除）要先装它。
 * 只装在 HTMLSpanElement 上：framer-motion 按 Element.prototype 自己有没有 animate 决定走不走 WAAPI，装到那里会把它也拖进假动画。
 * 要在用例里调用（用 onTestFinished 卸下）。
 */
export function stubSpanAnimations(): SpanAnimationsStub {
  const proto = HTMLSpanElement.prototype;
  const original = Object.getOwnPropertyDescriptor(proto, "animate");
  const played: FakeAnimation[] = [];
  Object.defineProperty(proto, "animate", {
    configurable: true,
    writable: true,
    value(this: Element, frames: Keyframe[], options: KeyframeAnimationOptions) {
      const animation: FakeAnimation = {
        el: this,
        frames,
        options,
        currentTime: 0,
        playState: "running",
        cancelled: false,
        finished: false,
        onfinish: null,
        cancel() {
          this.cancelled = true;
          this.playState = "idle";
          this.currentTime = null;
        },
        pause() {
          this.playState = "paused";
        },
        play() {
          this.playState = "running";
        },
      };
      played.push(animation);
      return animation;
    },
  });
  let restored = false;
  const restore = () => {
    if (restored) return;
    restored = true;
    if (original === undefined) delete (proto as { animate?: unknown }).animate;
    else Object.defineProperty(proto, "animate", original);
  };
  onTestFinished(restore);
  const finish = (animation: FakeAnimation) =>
    act(() => {
      animation.currentTime = Number(animation.options.duration);
      animation.playState = "finished";
      animation.finished = true;
      animation.onfinish?.();
    });
  return {
    played,
    running(el, prop) {
      const found = played.filter((a) => a.el === el && !a.cancelled && !a.finished && prop in a.frames[0]);
      if (found.length !== 1) {
        const glyph = (el as HTMLElement).dataset.glyph;
        throw new Error(`${el.tagName.toLowerCase()}${glyph === undefined ? "" : `「${glyph}」`}上在播的 ${prop} 动画有 ${found.length} 个`);
      }
      return found[0];
    },
    finish,
    finishAll() {
      // 先取快照：播完引起的重渲染可能起新的动画，不算在这一轮；也可能取消还没轮到的，被取消的不再播
      for (const animation of played.filter((a) => !a.cancelled && !a.finished)) if (!animation.cancelled) finish(animation);
    },
    restore,
  };
}

/**
 * 一帧的时长。jsdom 的 requestAnimationFrame 用 setInterval(…, 1000 / 60) 排下一帧，假时钟按 parseInt 把间隔取成 16，
 * 帧又是一帧一排（回调跑完才排下一个），所以假定时器下每推进 16 ms 恰好走一帧，不会一步走两帧。
 */
const FRAME_MS = 16;
/** waitForFrames 的上限：远长于界面里最长的入场与退场，又短于默认的单例超时，没等到时报出的是哪条断言没过。 */
const FRAME_WAIT_TIMEOUT_MS = 3_000;

/*
 * framer-motion 的帧循环怎么走（motion-dom 12.43 的 frameloop/frame.mjs 与 jsdom 30 的 Window.js）：
 * framer-motion 在模块加载时取走 jsdom 自己的 requestAnimationFrame，之后再替换全局的 requestAnimationFrame 换不到它；
 * jsdom 的 requestAnimationFrame 每次排帧时现取全局的 setInterval。所以：
 * - 真实计时器下，帧按真实时间来，用 waitForFrames 等。
 * - 假定时器（默认会假 setInterval 与 performance）下，帧跟着假时钟走：不推进就一帧都不来，用 stepFrames 逐帧推进。
 * - 换计时器（假换真、真换假，也包括 beforeEach 里每个用例重装一次假时钟）时，要是还有一帧排在旧计时器上：
 *   framer-motion 以为下一帧已经排着，不再排新的；jsdom 也以为计时器还在，不再起新的。旧的是假时钟时那一帧永远不来，
 *   同文件后面的用例连页面根的入场、Page 的首帧闸门都推不动；旧的是真实计时器时，换上假时钟后最初几步推进会扑空。
 *   换之前先卸载、再 drainFrames 把帧循环排空。
 * - 经窗口排的动画帧回调（产品代码里现取的 requestAnimationFrame）不归 framer-motion 管，假定时器下排在假时钟上。
 *   lib/reflow 的等待队列是模块级的，排着时恰好有一个这样的回调，按帧数一帧一排：丢了这一帧，队列以为还排着，
 *   同文件后面挂进来的让位一个也不播。drainFrames 连这一路一起排空。
 */

/**
 * 按真实时间等 framer-motion 把动画播到 assertion 通过为止。睡固定时长不可靠：机器满载时帧会晚到，
 * 固定时长还要整段占掉用例的超时预算。每一轮在 act 里让出一帧，动画结束引起的重渲染（例如退场后卸载）在 act 收尾时提交。
 */
export async function waitForFrames(assertion: () => void): Promise<void> {
  // 假定时器下这里的 setTimeout 不走真实时间，每一轮都要靠 waitFor 顺手推进假时钟，推进多少帧说不准，断言就不可复现
  if (vi.isFakeTimers()) throw new Error("waitForFrames 要在真实计时器下用：假定时器下帧跟着假时钟走，用 stepFrames 逐帧推进");
  await vi.waitFor(
    async () => {
      await act(() => new Promise<void>((resolve) => setTimeout(resolve, FRAME_MS)));
      assertion();
    },
    { timeout: FRAME_WAIT_TIMEOUT_MS, interval: FRAME_MS },
  );
}

/**
 * 假定时器下让 framer-motion 走 count 帧，每帧之后提交动画引起的重渲染。用来逐帧采样一段动画。
 * 限制：假定时器必须假了 setInterval（toFake 只列 setTimeout 的用例里帧仍走真实时间，这里推不动）；
 * 帧之间排着的别的假计时器（通知的自动消失、复制反馈）也会照常到点触发。
 */
export async function stepFrames(count: number): Promise<void> {
  if (!vi.isFakeTimers()) throw new Error("stepFrames 要在假定时器下用：真实计时器下帧按真实时间来，用 waitForFrames 等");
  for (let i = 0; i < count; i++) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(FRAME_MS);
    });
  }
}

/**
 * 把帧循环排空：在当前的计时器上一段一段地走，直到走完一段 framer-motion 没有处理任何一帧（帧时间戳不再变）、
 * 也没有谁经窗口新排动画帧回调（lib/reflow 的等待队列这类一帧一排的，framer-motion 的时间戳看不出来）。
 * 换计时器之前在旧计时器下调用：用例收尾时先卸载，再 drainFrames，再 useRealTimers，同文件后面的用例帧循环才接得上。
 * 假定时器下每段推进一帧；真实计时器下每段等两个帧长，排着的那一帧一定先于这次等待到点，它在回调里再排的下一帧数得到。
 * 限制：还挂着无限循环的动画（转圈、呼吸）或每帧都再排一帧的回调时永远排不空，到上限直接报错，所以要先卸载。
 */
export async function drainFrames(): Promise<void> {
  const fake = vi.isFakeTimers();
  const stepMs = fake ? FRAME_MS : 2 * FRAME_MS;
  const step = fake ? () => stepFrames(1) : () => act(() => new Promise<void>((resolve) => setTimeout(resolve, stepMs)));
  const limit = Math.ceil(FRAME_WAIT_TIMEOUT_MS / stepMs);
  // 排空期间经窗口排的回调照常交给原来的那一个，只多数一下；framer-motion 取走的是 jsdom 自己的，不经这里
  const request = window.requestAnimationFrame;
  let requested = 0;
  window.requestAnimationFrame = (callback) => {
    requested++;
    return request.call(window, callback);
  };
  try {
    for (let i = 0; i < limit; i++) {
      const before = frameData.timestamp;
      requested = 0;
      await step();
      if (frameData.timestamp === before && requested === 0) return;
    }
  } finally {
    // 换回原来的那一个：假时钟卸下时按它身上的标记决定还原还是删掉全局的 requestAnimationFrame
    window.requestAnimationFrame = request;
  }
  throw new Error(`帧循环走了 ${FRAME_WAIT_TIMEOUT_MS} ms 仍没停下：还有动画或每帧再排的动画帧回调，先卸载再排空`);
}

/** 固定元素的布局矩形（jsdom 不做布局，getBoundingClientRect 恒为 0）。 */
export function setRect(el: Element, rect: { left: number; top: number; width: number; height: number }): void {
  el.getBoundingClientRect = () =>
    ({ ...rect, x: rect.left, y: rect.top, right: rect.left + rect.width, bottom: rect.top + rect.height, toJSON: () => rect }) as DOMRect;
}

export function keydown(target: EventTarget, key: string, init: KeyboardEventInit = {}): KeyboardEvent {
  const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init });
  act(() => {
    target.dispatchEvent(event);
  });
  return event;
}

/**
 * 模拟键盘把焦点移到 el。jsdom 按最近一次按键判定 :focus-visible：先在别处按下 Tab 再聚焦，
 * el 才匹配 :focus-visible；直接调用 focus() 相当于指针聚焦，不匹配。
 */
export function focusByKeyboard(el: HTMLElement): void {
  act(() => {
    document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true }));
    el.focus();
  });
}
