// 发现页自用的几个小 hook：防抖、滚动容器。加载态的出现、停留、慢提示与超时的计时都走全站统一的 lib/loading-gate。

import { useCallback, useEffect, useLayoutEffect, useState, type RefObject } from "react";

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
 * 哨兵按元素传（回调 ref 存进 state）：列表尾随结果整块换上来时是新的节点，观察要跟着换过去，不能盯着已经摘下的旧节点。
 */
export function useNearBottom(sentinel: Element | null, container: HTMLElement | null, marginPx: number, enabled: boolean): boolean {
  const [near, setNear] = useState(false);
  useEffect(() => {
    if (!enabled || container === null || sentinel === null) {
      setNear(false);
      return;
    }
    const root = container === document.scrollingElement ? null : container;
    const observer = new IntersectionObserver((entries) => setNear(entries.some((e) => e.isIntersecting)), {
      root,
      rootMargin: `0px 0px ${marginPx}px 0px`,
    });
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [sentinel, container, marginPx, enabled]);
  return near;
}

/**
 * 换了一组搜索条件：结果区顶边（贴在那里的哨兵）已滚出容器顶边时，瞬时滚回它，新结果从头看起。
 * 吸顶工具条吸住时与滚回后都贴在容器顶上，看起来停在原处。不平滑滚动：下面的内容整块换了，滑过去只是多看一段要被换掉的旧内容。
 * 滚到哨兵整个刚好出了顶边、再多 1px，而不是哨兵上沿正贴顶边：贴边的哨兵会被吸顶判定（useStuck）当成相交（贴边也算相交），
 * 工具条每换一次条件就掉一次吸顶外观（底色、阴影、上沿圆角），往下一滚又吸回去。多滚的这一两像素藏在吸住的工具条底下。
 */
export function revealTop(sentinel: Element, container: HTMLElement): void {
  const rootTop = container === document.scrollingElement ? 0 : container.getBoundingClientRect().top;
  const rect = sentinel.getBoundingClientRect();
  if (rect.top >= rootTop) return;
  // 已经停在这个位置（换类型时先滚过一次，提交后布局阶段再来一次）就不再写滚动位置
  const delta = rect.bottom + 1 - rootTop;
  if (delta !== 0) container.scrollTop += delta;
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
