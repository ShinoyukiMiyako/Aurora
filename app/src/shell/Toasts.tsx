// 通知容器：右下角的通知栈，新的在最下面。挂在浮层根里，弹窗打开时也看得见（动作此时置灰）。
// 寿命与暂停由状态容器管，这里只负责摆放与交互：
// 指针悬停或焦点在栈内时全部暂停计时，离开后恢复；动作经外壳统一执行（先关这条再导航或执行）。
// 倒计时细线的起点按「截止时刻、暂停剩余」算一次，不随每次重渲染重算：细线自己按剩余时长缩短。

import { AnimatePresence } from "framer-motion";
import { useRef } from "react";
import { createPortal } from "react-dom";
import { useLauncher } from "../state/launcher";
import { toastCountdown, type Toast as ToastState } from "../state/toasts";
import { Toast } from "../ui/Toast";
import { TOASTS_COPY } from "./copy";
import { useOverlayRoot } from "./overlay";
import { useShell } from "./shell";
import styles from "./Toasts.module.css";

export function Toasts() {
  const { state, actions } = useLauncher();
  const hovering = useRef(false);
  const focusedWithin = useRef(false);
  const root = useOverlayRoot();

  // 指针与焦点任一在栈内就保持暂停；两者都离开才恢复，免得指针移走时把键盘用户正在读的通知恢复计时
  const sync = () => {
    if (hovering.current || focusedWithin.current) actions.pauseToasts("hover");
    else actions.resumeToasts("hover");
  };

  if (root === null) return null;
  return createPortal(
    <section
      className={styles.region}
      aria-label={TOASTS_COPY.region}
      onPointerEnter={() => {
        hovering.current = true;
        sync();
      }}
      onPointerLeave={() => {
        hovering.current = false;
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
        {state.toasts.map((toast) => (
          <ToastItem key={toast.id} toast={toast} onClose={() => actions.dismissToast(toast.id)} />
        ))}
      </AnimatePresence>
    </section>,
    root,
  );
}

function ToastItem({ toast, onClose }: { toast: ToastState; onClose: () => void }) {
  const { runToastAction } = useShell();
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
