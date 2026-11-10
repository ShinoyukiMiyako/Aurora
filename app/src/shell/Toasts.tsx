// 通知容器：右下角的通知栈，新的在最下面；弹窗或首次启动向导开着时挪到左上角，给它们的按钮让路，换角时整栈在新角淡入。
// 挂在浮层根里，弹窗打开时也看得见（动作此时置灰）。
// 寿命与暂停由状态容器管，这里只负责摆放与交互：
// 指针悬停或焦点在栈内时全部暂停计时，离开后恢复；动作经外壳统一执行（先关这条再导航或执行）。
// 倒计时细线的起点按「截止时刻、暂停剩余」算一次，不随每次重渲染重算：细线自己按剩余时长缩短。

import { AnimatePresence } from "framer-motion";
import { useLayoutEffect, useRef, useState, type Ref } from "react";
import { createPortal } from "react-dom";
import { useLauncherActions, useLauncherSelector } from "../state/launcher";
import { toastCountdown, type Toast as ToastState } from "../state/toasts";
import { Toast, type ToastSide } from "../ui/Toast";
import { TOASTS_COPY } from "../copy/shell";
import { useOverlayRoot } from "./overlay";
import { useShell } from "./shell";
import styles from "./Toasts.module.css";

/**
 * 落点写在样式表里，判据是有没有没在退场的弹窗、首次启动向导在不在文档里，脚本不再判断一遍，只读样式表给的方向。
 * 读的是上一次提交之后的文档，所以通知的增删要晚一拍上屏（见 Toasts 里的 shown）。
 * 容器还没挂上时没有入场动画（AnimatePresence 的 initial 是 false），方向用不上。
 */
function slideSide(region: HTMLElement | null): ToastSide {
  if (region === null) return 1;
  return getComputedStyle(region).getPropertyValue("--toast-enter-side").trim() === "-1" ? -1 : 1;
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
      action={action === undefined ? undefined : { label: action.label, onClick: () => runToastAction(toast) }}
      onClose={onClose}
      countdown={memo.current.value}
    />
  );
}
