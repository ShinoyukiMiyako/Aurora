// 浮层（弹窗、浮层面板）的焦点归还记录点：打开时记下当时的焦点元素，关闭后把焦点还给它；
// 它已不在文档中时落到外壳标记的回落元素（内容区滚动容器）。
//
// 两处时机决定了它的写法：
// - 必须渲染成浮层内容之前的兄弟节点。layout effect 按树的深度优先顺序执行，子节点先于父节点、前面的兄弟先于后面的兄弟，
//   而浮层里带 autoFocus 的元素在提交阶段就会抢到焦点；若在浮层组件自身（内容的父节点）里记录，
//   记下的会是浮层内部刚被聚焦的元素。
// - 关闭时在 layout effect 的执行阶段归还，而不是在清理函数里。更新时的清理函数跑在 DOM 变更阶段，
//   React 在变更阶段结束后会把焦点恢复到提交前的元素（只要它还在文档里）；浮层退场动画期间节点仍在，
//   在清理里归还的焦点会被立刻拉回正在退场的浮层。整个组件卸载时浮层随之移除，才在清理里归还。

import { useLayoutEffect, useRef } from "react";
import { FOCUS_FALLBACK_ATTR } from "../shell/overlay";

export interface FocusReturnHandle {
  /** 本次关闭不归还焦点：浮层因点击外部而关闭时，焦点应留在用户点的地方。 */
  skip(): void;
}

export interface FocusReturnPointProps {
  active: boolean;
  /** 关闭时调用；返回 false 则这次不归还（用户已经把焦点带去了别处）。不传则总是归还。 */
  shouldReturn?: () => boolean;
  /** 父组件拿到归还句柄，在「点外部关闭」这类场合提前调用 skip()。 */
  handle?: { current: FocusReturnHandle | null };
}

export function FocusReturnPoint({ active, shouldReturn, handle }: FocusReturnPointProps) {
  const previous = useRef<Element | null>(null);
  const skipped = useRef(false);
  const shouldReturnRef = useRef(shouldReturn);
  shouldReturnRef.current = shouldReturn;
  if (handle) {
    handle.current = {
      skip: () => {
        skipped.current = true;
      },
    };
  }

  const restore = () => {
    const target = previous.current;
    previous.current = null;
    if (skipped.current) return;
    const check = shouldReturnRef.current;
    if (check !== undefined && !check()) return;
    const destination = target instanceof HTMLElement && target.isConnected && target !== document.body ? target : document.querySelector<HTMLElement>(`[${FOCUS_FALLBACK_ATTR}]`);
    destination?.focus();
  };
  const restoreRef = useRef(restore);
  restoreRef.current = restore;

  useLayoutEffect(() => {
    if (active) {
      previous.current = document.activeElement;
      skipped.current = false;
    } else if (previous.current !== null) {
      restoreRef.current();
    }
  }, [active]);

  useLayoutEffect(
    () => () => {
      if (previous.current !== null) restoreRef.current();
    },
    [],
  );

  return null;
}
