// 通知容器：右下角的通知栈，新的在最下面；弹窗或首次启动向导开着时挪到左上角，给它们的按钮让路。
// 换角时整栈在新角淡入，旧角留下的一份拷贝原地淡出。
// 挂在浮层根里，弹窗打开时也看得见（动作此时置灰）。
// 寿命与暂停由状态容器管，这里只负责摆放与交互：
// 指针悬停或焦点在栈内时全部暂停计时，离开后恢复；动作经外壳统一执行（先关这条再导航或执行）。
// 倒计时细线的起点按「截止时刻、暂停剩余」算一次，不随每次重渲染重算：细线自己按剩余时长缩短。

import { AnimatePresence } from "framer-motion";
import { useLayoutEffect, useRef, useState, type Ref, type RefObject } from "react";
import { createPortal } from "react-dom";
import { fade, tweenAt } from "../lib/motion";
import { useLauncherActions, useLauncherSelector } from "../state/launcher";
import { toastCountdown, type Toast as ToastState } from "../state/toasts";
import { Toast, type ToastSide } from "../ui/Toast";
import { TOASTS_COPY } from "../copy/shell";
import { useOverlayRoot } from "./overlay";
import { useShell } from "./shell";
import styles from "./Toasts.module.css";

/** 样式表给出的落点方向。 */
function sideOf(style: CSSStyleDeclaration): ToastSide {
  return style.getPropertyValue("--toast-enter-side").trim() === "-1" ? -1 : 1;
}

/**
 * 落点写在样式表里，判据是有没有没在退场的弹窗、首次启动向导在不在文档里，脚本不再判断一遍，只读样式表给的方向。
 * 读的是上一次提交之后的文档，所以通知的增删要晚一拍上屏（见 Toasts 里的 shown）。
 * 容器还没挂上时没有入场动画（AnimatePresence 的 initial 是 false），方向用不上。
 */
function slideSide(region: HTMLElement | null): ToastSide {
  if (region === null) return 1;
  return sideOf(getComputedStyle(region));
}

/** framer-motion 的 popLayout 把退场项抽出布局时打在它身上的标记。 */
const POPPED_ATTR = "data-motion-pop-id";

/** 落点方向对应的角：1 是平时的右下角，-1 是弹窗或向导开着时的左上角。 */
function cornerOf(side: ToastSide): "home" | "aside" {
  return side === 1 ? "home" : "aside";
}

/**
 * 拷贝里的 CSS 动画（倒计时细线）会从头播：对到原件此刻的进度，细线不在淡出的那一份里跳回起点。
 * 深拷贝不改结构，两边自身与后代按文档顺序一一对应。
 */
function syncAnimations(original: Element, copy: Element): void {
  const originals = [original, ...original.querySelectorAll("*")];
  const copies = [copy, ...copy.querySelectorAll("*")];
  for (const animation of original.getAnimations({ subtree: true })) {
    if (!(animation instanceof CSSAnimation) || !(animation.effect instanceof KeyframeEffect) || animation.effect.target === null) continue;
    const twin = copies[originals.indexOf(animation.effect.target)];
    const mirror = twin.getAnimations().find((a) => a instanceof CSSAnimation && a.animationName === animation.animationName);
    if (mirror !== undefined) mirror.currentTime = animation.currentTime;
  }
}

/**
 * 换角时旧角那一栈原地淡出。落点由样式表当场切换：容器一步到了新角并在那里淡入（--sk-dur-in 配 --sk-ease-out，即 fade.in，
 * 起点平时是 0，由这里经 --toasts-enter-from 给出），旧角那一份由这里补上。切换之后、浏览器画下一帧之前（MutationObserver 的回调在这次任务的末尾跑），
 * 把容器里此刻看得见的通知拷一份钉在旧角，淡完拿掉。拷贝只是一张会淡出的照片：不可交互、不进读屏。
 * 能引起换角的只有三种变化：浮层根的直接子项（弹窗层）增删、弹窗层开始退场（data-exiting）、外壳根的直接子项（首次启动向导）增删。
 * 运行环境不播动画（组件测试的 jsdom，没有 getAnimations）时不拷：拷贝要等它的淡出播完才拿掉。
 */
function useCornerHandoff(regionRef: RefObject<HTMLElement | null>, root: HTMLElement | null): void {
  useLayoutEffect(() => {
    const region = regionRef.current;
    if (region === null || root === null || typeof region.getAnimations !== "function") return;
    const host = root.parentElement;
    let side = slideSide(region);
    // 上一次换角的时刻，与容器在那个角淡入的起点透明度。弹窗异步接力（关一个、隔几拍再开下一个）会连换两次角：
    // 第二次时容器在新角的淡入还没走完，旧角的拷贝从淡入此刻走到的透明度起淡出，不先闪回全不透明
    let movedAt = Number.NEGATIVE_INFINITY;
    let enteredFrom = 0;
    // 还在淡出的拷贝，连同它淡出的起点透明度与起步时刻
    const ghosts = new Map<HTMLElement, { from: number; at: number }>();

    const handOff = (records: MutationRecord[]) => {
      if (!records.some((r) => r.type === "attributes" || r.target === root || r.target === host)) return;
      const style = getComputedStyle(region);
      const next = sideOf(style);
      if (next === side) return;
      const from = side;
      side = next;
      const now = performance.now();
      const shown = enteredFrom + (1 - enteredFrom) * tweenAt(fade.in, (now - movedAt) / 1000);
      movedAt = now;

      // 这一拍才进来的通知旧角从没画过；正在退场的那条已被抽出布局、自己在淡出：都不拷。先读完再写
      const fresh = new Set(records.flatMap((r) => (r.target === region ? [...r.addedNodes] : [])));
      const pairs: [Element, HTMLElement][] = [];
      let staying = 0;
      for (const child of region.children) {
        if (child.hasAttribute(POPPED_ATTR)) continue;
        staying += 1;
        if (fresh.has(child)) continue;
        const copy = child.cloneNode(true);
        if (!(copy instanceof HTMLElement)) throw new Error("通知的拷贝不是 HTML 元素");
        // 入场还没走完的那条，透明度由 Web Animations 驱动，内联样式还停在入场起点的 0：照它此刻实际的透明度拷
        copy.style.opacity = getComputedStyle(child).opacity;
        pairs.push([child, copy]);
      }

      // 接力换回原角（甲角到乙角，几拍后又回甲角）：甲角上一次留下的拷贝还没淡完。同样的内容叠两层各自半透明，
      // 合起来先暗一下再亮回来：拿掉那份拷贝，容器从它此刻的透明度起淡入。栈里没有留下的通知时拷贝照常淡完，不一下子消失
      let resume = 0;
      if (staying > 0) {
        for (const [ghost, fadeOut] of ghosts) {
          if (ghost.dataset.corner !== cornerOf(next)) continue;
          resume = Math.max(resume, fadeOut.from * (1 - tweenAt(fade.out, (now - fadeOut.at) / 1000)));
          ghost.remove();
          ghosts.delete(ghost);
        }
      }
      enteredFrom = resume;
      region.style.setProperty("--toasts-enter-from", String(resume));
      if (pairs.length === 0) return;

      const ghost = document.createElement("div");
      ghost.className = styles.ghost;
      ghost.dataset.corner = cornerOf(from);
      ghost.setAttribute("aria-hidden", "true");
      ghost.setAttribute("inert", "");
      ghost.style.setProperty("--toasts-width", style.getPropertyValue("--toasts-width"));
      ghost.style.setProperty("--toasts-ghost-from", String(shown));
      ghost.append(...pairs.map(([, copy]) => copy));
      // 拷贝里的 id 与原件重复，引用 id 的属性会对到它身上
      for (const el of ghost.querySelectorAll("[id]")) el.removeAttribute("id");
      region.after(ghost);
      ghosts.set(ghost, { from: shown, at: now });
      for (const [original, copy] of pairs) syncAnimations(original, copy);

      const drop = () => {
        ghost.remove();
        ghosts.delete(ghost);
      };
      const fadeOut = ghost.getAnimations()[0];
      if (fadeOut === undefined) {
        drop();
        throw new Error("通知栈旧角的拷贝没有淡出动画：样式表里的 .ghost 规则缺了");
      }
      fadeOut.finished.then(drop, (error: unknown) => {
        drop();
        // 拷贝被提前拿掉（外壳卸载、接力换回这个角）时淡出随之取消，这是正常收尾；别的错误照常抛出
        if (!(error instanceof DOMException && error.name === "AbortError")) throw error;
      });
    };

    const observer = new MutationObserver(handOff);
    observer.observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: ["data-exiting"] });
    if (host !== null) observer.observe(host, { childList: true });
    return () => {
      observer.disconnect();
      for (const ghost of ghosts.keys()) ghost.remove();
      ghosts.clear();
    };
  }, [regionRef, root]);
}

export function Toasts() {
  const toasts = useLauncherSelector((s) => s.toasts);
  // 增删晚一拍上屏：同一批更新里常有别的变化会改落点（新建实例、登录成功都是关弹窗的同一拍发通知），
  // 先让它们提交进文档，再按提交后的落点定新通知从哪侧进、走的通知往哪侧出。
  // 晚的这一拍是布局阶段里的同步重渲染，浏览器画下一帧之前就完成，不会多画一帧旧样子
  const [shown, setShown] = useState(toasts);
  useLayoutEffect(() => {
    setShown(toasts);
  }, [toasts]);
  const actions = useLauncherActions();
  // 指针在栈内时为它最后的位置（视口坐标），不在栈内为 null
  const pointerAt = useRef<{ x: number; y: number } | null>(null);
  const focusedWithin = useRef(false);
  const regionRef = useRef<HTMLElement>(null);
  const root = useOverlayRoot();
  useCornerHandoff(regionRef, root);

  // 指针与焦点任一在栈内就保持暂停；两者都离开才恢复，免得指针移走时把键盘用户正在读的通知恢复计时
  const sync = () => {
    if (pointerAt.current !== null || focusedWithin.current) actions.pauseToasts("hover");
    else actions.resumeToasts("hover");
  };

  // 通知退场移除时，有两件事浏览器不一定告诉容器：
  // - 焦点所在的那条（点了它的关闭或动作）移除后，焦点落回 body，却不派发 blur / focusout；
  // - 指针下方那条移除、栈缩小而指针没动时，pointerleave 不一定派发。
  // 只靠事件的话暂停永远解除不了，之后的通知全部停着不消失。每条通知卸载时补查一次：
  // 卸载的清理跑在节点移除之前，查询放进微任务，等这次提交把节点移除之后再看。
  // 指针按最后的位置当场做命中测试；不读 :hover，它何时随布局变化更新由浏览器决定，此刻可能还是旧值
  const recheck = () => {
    const region = regionRef.current;
    if (region === null) return;
    let left = false;
    if (focusedWithin.current && !region.contains(document.activeElement)) {
      focusedWithin.current = false;
      left = true;
    }
    const at = pointerAt.current;
    if (at !== null) {
      const hit = document.elementFromPoint(at.x, at.y);
      if (hit === null || !region.contains(hit)) {
        pointerAt.current = null;
        left = true;
      }
    }
    if (left) sync();
  };

  if (root === null) return null;
  const side = slideSide(regionRef.current);
  // 谁会挪动只取决于栈里有哪几条、各自带不带动作（动作行占高度）。只在这变了时让通知量位置：
  // 悬停暂停、倒计时刷新、弹窗开合引起的重渲染都不量，落点换角时也就不会把跨屏的位置差当成让位去播
  const stack = shown.map((toast) => (toast.action === undefined ? toast.id : `${toast.id}+action`)).join(" ");
  return createPortal(
    <section
      ref={regionRef}
      className={styles.region}
      aria-label={TOASTS_COPY.region}
      onPointerEnter={(event) => {
        pointerAt.current = { x: event.clientX, y: event.clientY };
        sync();
      }}
      onPointerMove={(event) => {
        // 通知滑到静止的指针下方时 pointerenter 同样可能缺席：指针在栈内一动就补上
        const missedEnter = pointerAt.current === null;
        pointerAt.current = { x: event.clientX, y: event.clientY };
        if (missedEnter) sync();
      }}
      onPointerLeave={() => {
        pointerAt.current = null;
        sync();
      }}
      onFocus={() => {
        focusedWithin.current = true;
        sync();
      }}
      onBlur={(event) => {
        if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)) return;
        focusedWithin.current = false;
        sync();
      }}
    >
      {/*
        popLayout：关掉的那条立即脱离布局，其余通知与它的退场同时让位，而不是等它淡完再补位。
        退场项贴着栈锚定的那条边：右下角（从右侧进）贴底，左上角贴顶，容器随之伸缩时它留在原处
      */}
      <AnimatePresence initial={false} custom={side} mode="popLayout" anchorY={side === 1 ? "bottom" : "top"}>
        {shown.map((toast) => (
          <ToastItem key={toast.id} toast={toast} side={side} layoutDependency={stack} onClose={() => actions.dismissToast(toast.id)} onUnmount={recheck} />
        ))}
      </AnimatePresence>
    </section>,
    root,
  );
}

interface ToastItemProps {
  toast: ToastState;
  side: ToastSide;
  layoutDependency: string;
  onClose: () => void;
  onUnmount: () => void;
  /** popLayout 往直接子项上塞 ref 量尺寸、把退场项抽出布局：原样交给通知的根元素，否则退场项一直占着位置。 */
  ref?: Ref<HTMLDivElement>;
}

function ToastItem({ ref, toast, side, layoutDependency, onClose, onUnmount }: ToastItemProps) {
  const { runToastAction } = useShell();
  const onUnmountRef = useRef(onUnmount);
  onUnmountRef.current = onUnmount;
  useLayoutEffect(() => () => queueMicrotask(() => onUnmountRef.current()), []);
  const memo = useRef<{ key: string; value: ReturnType<typeof toastCountdown> } | null>(null);
  const key = `${toast.deadline}|${toast.pausedRemainingMs}|${toast.ttlMs}`;
  if (memo.current === null || memo.current.key !== key) memo.current = { key, value: toastCountdown(toast, Date.now()) };
  const action = toast.action;
  return (
    <Toast
      ref={ref}
      tone={toast.tone}
      title={toast.title}
      body={toast.body}
      side={side}
      layoutDependency={layoutDependency}
      repeats={toast.repeats}
      action={action === undefined ? undefined : { label: action.label, onClick: () => runToastAction(toast) }}
      onClose={onClose}
      countdown={memo.current.value}
    />
  );
}
