// 浮层（弹窗、浮层面板）的焦点归还记录点：打开时记下当时的焦点元素，关闭后把焦点还给它。
//
// 它已不在文档中（打开它的按钮被关闭这一步换掉了）或已被禁用时落到它所在的区域：从最近的、还在文档里的祖先找起，取第一个
// 可 Tab 的控件；找到弹窗或内容区滚动容器这一层就停，落到容器本身。叠着的弹窗里不能退回内容区滚动容器：它在底层
// 弹窗的圈定之外，焦点会被圈定拉到底层弹窗的第一个控件，也就是头部的「关闭」，再按一下回车就把整个流程关了。
//
// 两处时机决定了它的写法：
// - 必须渲染成浮层内容之前的兄弟节点。layout effect 按树的深度优先顺序执行，子节点先于父节点、前面的兄弟先于后面的兄弟，
//   而浮层里带 autoFocus 的元素在提交阶段就会抢到焦点；若在浮层组件自身（内容的父节点）里记录，
//   记下的会是浮层内部刚被聚焦的元素。
// - 关闭时在 layout effect 的执行阶段归还，而不是在清理函数里。更新时的清理函数跑在 DOM 变更阶段，
//   React 在变更阶段结束后会把焦点恢复到提交前的元素（只要它还在文档里）；浮层退场动画期间节点仍在，
//   在清理里归还的焦点会被立刻拉回正在退场的浮层。整个组件卸载时浮层随之移除，才在清理里归还。

import { useLayoutEffect, useRef } from "react";
import { FOCUS_FALLBACK_ATTR, tabbableElements } from "../shell/overlay";

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

/** 区域的外沿：弹窗（含面板）与内容区滚动容器自己接得住焦点，再往外就越过了圈定或换了区域。 */
const REGION_EDGE = `[role="dialog"], [${FOCUS_FALLBACK_ATTR}]`;
/** 浮层根里排着彼此无关的浮层（含正在退场的），不算任何一个浮层的区域。 */
const REGION_LIMIT = "[data-sk-overlay-root]";

/** el 所在的区域由内向外的祖先。要在打开时记下：元素被移除后，从它身上走不回文档。 */
function regionChain(el: Element | null): HTMLElement[] {
  const chain: HTMLElement[] = [];
  for (let node = el === null ? null : el.parentElement; node !== null && !node.contains(document.body) && !node.matches(REGION_LIMIT); node = node.parentElement) {
    chain.push(node);
    if (node.matches(REGION_EDGE)) break;
  }
  return chain;
}

function regionDestination(chain: readonly HTMLElement[]): HTMLElement | null {
  for (const area of chain) {
    if (!area.isConnected) continue;
    if (area.matches(REGION_EDGE)) return area;
    const first = tabbableElements(area)[0];
    if (first !== undefined) return first;
  }
  return document.querySelector<HTMLElement>(`[${FOCUS_FALLBACK_ATTR}]`);
}

export function FocusReturnPoint({ active, shouldReturn, handle }: FocusReturnPointProps) {
  const previous = useRef<Element | null>(null);
  const region = useRef<readonly HTMLElement[]>([]);
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
    // 还在文档里但已被原生禁用的目标接不住焦点，焦点会留在正在退场的浮层里，浮层移除后掉回 body。
    // 在 inert 子树里的也一样：打开浮层的按钮所在的块正在退场（Appear、列表行的退场层带 inert）
    const usable =
      target instanceof HTMLElement && target.isConnected && target !== document.body && !target.matches(":disabled") && target.closest("[inert]") === null;
    const destination = usable ? target : regionDestination(region.current);
    destination?.focus();
  };
  const restoreRef = useRef(restore);
  restoreRef.current = restore;

  useLayoutEffect(() => {
    if (active) {
      previous.current = document.activeElement;
      region.current = regionChain(document.activeElement);
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
