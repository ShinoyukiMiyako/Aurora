// 单条通知的外观。位置、堆叠、自动消失时长、悬停暂停由外壳的通知容器负责，文案由产生方按文案表给出。
//
// - 三列：色调图标底座 / 标题、正文、动作 / 关闭按钮。至多一个动作（幽灵小按钮），点击后先关闭这条再执行动作；
//   有弹窗打开时动作置灰并说明原因（动作多半要导航或开新弹窗，叠在弹窗背后执行会让用户找不到结果）。
// - 底部倒计时细线按剩余寿命线性缩短，暂停计时期间停住；不自动消失（countdown 为 null）的没有细线；
//   减少动画时照常显示（它是剩余时间的信息）。剩余比例或剩余时长变化时细线从新的位置重新开始。
// - 入场从落点靠窗口边的一侧滑入并轻微回弹，退场淡出；哪一侧由容器给，单独摆放时从右侧进。其余通知让位走布局动画。
// - error 为 alert（打断播报），其余为 status；通知不抢焦点、不入 Esc 栈。

import { motion, type Variants } from "framer-motion";
import type { Ref } from "react";
import { Icon, type IconName } from "../art/Icon";
import { fade, springs } from "../lib/motion";
import { cssVars, cx } from "../lib/util";
import { useOverlayState } from "../shell/overlay";
import { Button } from "./Button";
import { IconButton } from "./IconButton";
import styles from "./Toast.module.css";

export type ToastTone = "info" | "success" | "warning" | "error";

export const TOAST_CLOSE_LABEL = "关闭通知";
export const TOAST_ACTION_BLOCKED_REASON = "先完成或关闭当前弹窗";

const TONE_ICON: Readonly<Record<ToastTone, IconName>> = { info: "info", success: "check-circle", warning: "alert", error: "x-circle" };

/** 入场时滑入的距离（px）与起始缩放。 */
const ENTER_SHIFT = 40;
const ENTER_SCALE = 0.96;

/** 滑入滑出的一侧：1 右，-1 左。 */
export type ToastSide = 1 | -1;

/**
 * 入场起点与退场终点是同一个位置。x 必须是数字：写成 var() 时布局动画量位置扣不掉这段位移，入场途中关闭会飞出去。
 * 退场时节点已摘出列表、收不到新属性，一侧由 AnimatePresence 的 custom 给。
 */
const SLIDE: Variants = {
  away: (side: ToastSide) => ({ opacity: 0, x: side * ENTER_SHIFT, scale: ENTER_SCALE, transition: fade.out }),
};

export interface ToastCountdown {
  /** 剩余寿命占满额的比例（0 到 1），细线从这个长度开始缩短。 */
  fraction: number;
  /** 剩余寿命（毫秒），细线用这么久缩到 0。 */
  remainingMs: number;
  paused: boolean;
}

export interface ToastProps {
  tone: ToastTone;
  title: string;
  body?: string;
  action?: { label: string; onClick: () => void };
  onClose: () => void;
  /** null：不自动消失（error），没有倒计时细线。 */
  countdown: ToastCountdown | null;
  /** 跟着容器的落点走，默认 1。 */
  side?: ToastSide;
  /**
   * 让位布局动画的依赖：变了才量位置。容器传整个栈的签名（有哪几条、各自带不带动作），重渲染与落点换角都不误量；
   * 单独摆放时不传，每次重渲染都量。
   */
  layoutDependency?: string;
  /** 根元素。容器用 popLayout 增删时经它量尺寸、把退场的那条抽出布局。 */
  ref?: Ref<HTMLDivElement>;
  className?: string;
}

export function Toast({ tone, title, body, action, onClose, countdown, side = 1, layoutDependency, ref, className }: ToastProps) {
  const { scrimOpen } = useOverlayState();
  if (countdown !== null && (countdown.fraction < 0 || countdown.fraction > 1 || countdown.remainingMs < 0))
    throw new Error(`倒计时取值越界：fraction ${countdown.fraction}，remainingMs ${countdown.remainingMs}`);

  return (
    <motion.div
      ref={ref}
      layout="position"
      layoutDependency={layoutDependency}
      role={tone === "error" ? "alert" : "status"}
      className={cx(styles.toast, className)}
      data-tone={tone}
      custom={side}
      variants={SLIDE}
      initial="away"
      animate={{ opacity: 1, x: 0, scale: 1, transition: { ...springs.base, opacity: fade.in } }}
      exit="away"
      transition={{ layout: springs.settle }}
    >
      <span className={styles.iconBase}>
        <Icon name={TONE_ICON[tone]} size={18} />
      </span>
      <p className={styles.title}>{title}</p>
      {body !== undefined && <p className={styles.body}>{body}</p>}
      {action !== undefined && (
        <div className={styles.action}>
          <Button
            variant="ghost"
            size="sm"
            disabledReason={scrimOpen ? TOAST_ACTION_BLOCKED_REASON : undefined}
            onClick={() => {
              onClose();
              action.onClick();
            }}
          >
            {action.label}
          </Button>
        </div>
      )}
      <IconButton icon="x" label={TOAST_CLOSE_LABEL} size="sm" tooltip={false} className={styles.close} onClick={onClose} />
      {countdown !== null && (
        <span
          key={`${countdown.fraction}:${countdown.remainingMs}`}
          className={styles.countdown}
          data-paused={countdown.paused || undefined}
          style={cssVars({ "--toast-from": countdown.fraction, "--toast-remaining": `${countdown.remainingMs}ms` })}
          aria-hidden="true"
        />
      )}
    </motion.div>
  );
}
