// 组件测试的最小渲染与环境替身：jsdom 没有 matchMedia 与 ResizeObserver，也没有布局，
// 这里按测试需要补上可控的版本。只被 *.test.tsx 引用。

import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { vi } from "vitest";

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
