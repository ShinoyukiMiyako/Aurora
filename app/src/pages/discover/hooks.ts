// 发现页自用的几个小 hook：联网状态、加载态的出现延迟与最短停留、超时、防抖、滚动容器。

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";

/**
 * 浏览器报告的联网状态。只认 navigator.onLine 与 online / offline 事件：连通性探测需要后端提供探测命令，
 * 本页不自己去 ping 外网。
 */
export function useOnline(): boolean {
  const [online, setOnline] = useState(() => navigator.onLine);
  useEffect(() => {
    const up = () => setOnline(true);
    const down = () => setOnline(false);
    window.addEventListener("online", up);
    window.addEventListener("offline", down);
    return () => {
      window.removeEventListener("online", up);
      window.removeEventListener("offline", down);
    };
  }, []);
  return online;
}

/**
 * 加载态的显示开关：active 持续超过 delayMs 才出现（快的请求不闪一下骨架），
 * 一旦出现至少停留 minMs（避免骨架一闪而过）。
 */
export function useDelayedFlag(active: boolean, delayMs: number, minMs: number): boolean {
  const [shown, setShown] = useState(false);
  const shownAt = useRef(0);
  useEffect(() => {
    if (active && !shown) {
      const timer = setTimeout(() => {
        shownAt.current = Date.now();
        setShown(true);
      }, delayMs);
      return () => clearTimeout(timer);
    }
    if (!active && shown) {
      const remain = minMs - (Date.now() - shownAt.current);
      if (remain <= 0) {
        setShown(false);
        return;
      }
      const timer = setTimeout(() => setShown(false), remain);
      return () => clearTimeout(timer);
    }
  }, [active, shown, delayMs, minMs]);
  return shown;
}

/** active 连续成立超过 ms 后为 true；key 变化时重新计时（同一状态下换了一次请求）。 */
export function useElapsed(active: boolean, ms: number, key: string): boolean {
  const [elapsed, setElapsed] = useState<string | null>(null);
  useEffect(() => {
    if (!active) return;
    const timer = setTimeout(() => setElapsed(key), ms);
    return () => clearTimeout(timer);
  }, [active, ms, key]);
  return active && elapsed === key;
}

/** 输入停止 ms 之后才跟上的值；flush 立即跟上（回车、清空）。 */
export function useDebounced(value: string, ms: number): { value: string; flush: (next: string) => void } {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    if (value === settled) return;
    const timer = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(timer);
  }, [value, settled, ms]);
  const flush = useCallback((next: string) => setSettled(next), []);
  return { value: settled, flush };
}

/** 最近的纵向滚动祖先；都不滚动时为文档滚动元素。 */
export function scrollParent(el: Element): HTMLElement {
  for (let node = el.parentElement; node !== null; node = node.parentElement) {
    const overflow = getComputedStyle(node).overflowY;
    if (overflow === "auto" || overflow === "scroll" || overflow === "overlay") return node;
  }
  const root = document.scrollingElement;
  if (!(root instanceof HTMLElement)) throw new Error("文档没有可滚动的根元素");
  return root;
}

/** 页面挂载后找到外壳的页面滚动容器。 */
export function useScrollContainer(ref: RefObject<HTMLElement | null>): HTMLElement | null {
  const [container, setContainer] = useState<HTMLElement | null>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (el === null) throw new Error("发现页根节点尚未挂载");
    setContainer(scrollParent(el));
  }, [ref]);
  return container;
}

/**
 * 哨兵元素进入（滚动容器底边外扩 margin 的）范围时为 true。用于滚到底部附近时预取下一页。
 */
export function useNearBottom(sentinel: RefObject<Element | null>, container: HTMLElement | null, marginPx: number, enabled: boolean): boolean {
  const [near, setNear] = useState(false);
  useEffect(() => {
    const el = sentinel.current;
    if (!enabled || container === null || el === null) {
      setNear(false);
      return;
    }
    const root = container === document.scrollingElement ? null : container;
    const observer = new IntersectionObserver((entries) => setNear(entries.some((e) => e.isIntersecting)), {
      root,
      rootMargin: `0px 0px ${marginPx}px 0px`,
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [sentinel, container, marginPx, enabled]);
  return near;
}

/** 吸顶判定：放在吸顶元素正上方的哨兵滚出容器顶边时为 true。 */
export function useStuck(sentinel: RefObject<Element | null>, container: HTMLElement | null): boolean {
  const [stuck, setStuck] = useState(false);
  useEffect(() => {
    const el = sentinel.current;
    if (container === null || el === null) return;
    const root = container === document.scrollingElement ? null : container;
    const observer = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          const rootTop = e.rootBounds === null ? 0 : e.rootBounds.top;
          setStuck(!e.isIntersecting && e.boundingClientRect.top < rootTop);
        }
      },
      { root, threshold: 0 },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [sentinel, container]);
  return stuck;
}
