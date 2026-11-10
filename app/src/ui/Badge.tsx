// 计数或提醒点，附着在导航项、图标按钮、标签页上。角标本身不朗读：数值要并入宿主的名称
// （「下载任务，3 个进行中」），否则读屏会把孤零零的数字念出来。
//
// 出现时从无到有弹出（角标出现本身就是消息，要让人看见它是刚到的），消失时缩小淡出；计数变化不动。
// 退场要宿主用 AnimatePresence 包住；宿主挂载时就在的角标不想弹，就在那层写 initial={false}。
// 角标是叶子元素，里面没有之后才挂载的动画元素，在它外面写 initial={false} 封不住别人的入场。

import { motion } from "framer-motion";
import type { Ref } from "react";
import { fade, springs } from "../lib/motion";
import { cx } from "../lib/util";
import styles from "./Badge.module.css";

export type BadgeTone = "neutral" | "accent" | "danger";

/** 计数封顶：再大的数字在 18px 高的胶囊里也只显示「99+」。 */
export const BADGE_MAX = 99;

export interface BadgeProps {
  /** 计数；不传则为提醒点。必须是非负整数。 */
  count?: number;
  tone?: BadgeTone;
  /**
   * 附着在其他元素角上时加一圈 2px 底色描边，把角标与宿主分开。描边色默认 --sk-surface；
   * 宿主底色不同时，在宿主或其祖先上设置私有变量 --badge-ring。
   */
  ring?: boolean;
  className?: string;
  /** 落到角标根元素上。作为 AnimatePresence mode="popLayout" 的直接子项时，退场要靠它量尺寸、抽出布局。 */
  ref?: Ref<HTMLSpanElement>;
}

/** 出现、消失的动画。缩放从 0 起：角标小，从略小处起看不出是「弹出来」的。 */
const BADGE_MOTION = {
  initial: { scale: 0, opacity: 0 },
  animate: { scale: 1, opacity: 1, transition: { ...springs.pop, opacity: fade.in } },
  exit: { scale: 0.6, opacity: 0, transition: fade.out },
} as const;

export function badgeText(count: number): string {
  if (!Number.isInteger(count) || count < 0) throw new Error(`Badge 计数必须是非负整数，收到 ${count}`);
  return count > BADGE_MAX ? `${BADGE_MAX}+` : String(count);
}

export function Badge({ count, tone = "neutral", ring = false, className, ref }: BadgeProps) {
  const text = count === undefined ? null : badgeText(count);
  return (
    <motion.span
      ref={ref}
      className={cx(styles.badge, className)}
      data-tone={tone}
      data-kind={text === null ? "dot" : "count"}
      data-ring={ring || undefined}
      aria-hidden="true"
      initial={BADGE_MOTION.initial}
      animate={BADGE_MOTION.animate}
      exit={BADGE_MOTION.exit}
    >
      {text}
    </motion.span>
  );
}
