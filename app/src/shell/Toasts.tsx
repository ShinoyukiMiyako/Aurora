// 通知容器：右下角的通知栈，新的在最下面；弹窗或首次启动向导开着时挪到右上角，给它们的底栏让路。
// 挂在浮层根里，弹窗打开时也看得见（动作此时置灰）。
// 寿命与暂停由状态容器管，这里只负责摆放与交互：
// 指针悬停或焦点在栈内时全部暂停计时，离开后恢复；动作经外壳统一执行（先关这条再导航或执行）。
// 倒计时细线的起点按「截止时刻、暂停剩余」算一次，不随每次重渲染重算：细线自己按剩余时长缩短。

import { AnimatePresence } from "framer-motion";
import { useLayoutEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { useLauncherActions, useLauncherSelector } from "../state/launcher";
import { toastCountdown, type Toast as ToastState } from "../state/toasts";
import { Toast } from "../ui/Toast";
import { TOASTS_COPY } from "../copy/shell";
import { useOverlayRoot } from "./overlay";
import { useShell } from "./shell";
import styles from "./Toasts.module.css";

export function Toasts() {
  const toasts = useLauncherSelector((s) => s.toasts);
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
      <AnimatePresence initial={false}>
        {toasts.map((toast) => (
          <ToastItem key={toast.id} toast={toast} onClose={() => actions.dismissToast(toast.id)} onUnmount={recheck} />
        ))}
      </AnimatePresence>
    </section>,
    root,
  );
}

function ToastItem({ toast, onClose, onUnmount }: { toast: ToastState; onClose: () => void; onUnmount: () => void }) {
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
      tone={toast.tone}
      title={toast.title}
      body={toast.body}
      action={action === undefined ? undefined : { label: action.label, onClick: () => runToastAction(toast) }}
      onClose={onClose}
      countdown={memo.current.value}
    />
  );
}
