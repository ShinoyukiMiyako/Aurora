// 计数或提醒点，附着在导航项、图标按钮、标签页上。角标本身不朗读：数值要并入宿主的名称
// （「下载任务，3 个进行中」），否则读屏会把孤零零的数字念出来。
//
// 出现与消失只在宿主要的时候才动：宿主把条件渲染直接包进 AnimatePresence，角标之后出现时从无到有弹出
// （角标出现本身就是消息，要让人看见它是刚到的），消失时缩小淡出；那层写 initial={false}，宿主挂载时就在的角标不弹。
// 角标是叶子元素，里面没有之后才挂载的动画元素，在它外面写 initial={false} 封不住别人的入场。
// 没有直接包 AnimatePresence 的角标一挂上就是终态：页面入场时满屏角标跟着一起弹是噪音，同一块内容动了两次。
// 计数变化不动。减少动画时进出只动透明度。

import { motion, MotionContext, PresenceContext, useReducedMotionConfig } from "framer-motion";
import { useContext, type Ref } from "react";
import { popMark } from "../lib/motion";
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

/**
 * 角标的出现与消失是不是由一个 AnimatePresence 直接管着。只看有没有 PresenceContext 不够：外壳的主界面、弹窗、
 * 浮层都在 AnimatePresence 里，页面上每个角标都拿得到一个。直接管着时，外面最近的 motion 元素在那个 AnimatePresence
 * 之外，两者分属不同的出场单元；角标放在别的 motion 元素里面（主界面的两列、标签页徽标的外壳、下载入口的计数外壳）时
 * 同属一个，出现与消失归那一层管。
 */
function usePresenceOwned(): boolean {
  const presence = useContext(PresenceContext);
  const host = useContext(MotionContext).visualElement;
  if (presence === null) return false;
  return host?.presenceContext?.id !== presence.id;
}

export function badgeText(count: number): string {
  if (!Number.isInteger(count) || count < 0) throw new Error(`Badge 计数必须是非负整数，收到 ${count}`);
  return count > BADGE_MAX ? `${BADGE_MAX}+` : String(count);
}

export function Badge({ count, tone = "neutral", ring = false, className, ref }: BadgeProps) {
  const text = count === undefined ? null : badgeText(count);
  const owned = usePresenceOwned();
  // 角标是几个像素的点或一枚小计数，走 dot 档：从 0 弹出，从略小处起看不出是「弹出来」的
  const moves = useReducedMotionConfig() === true ? popMark.reduced : popMark.dot;
  return (
    <motion.span
      ref={ref}
      className={cx(styles.badge, className)}
      data-tone={tone}
      data-kind={text === null ? "dot" : "count"}
      data-ring={ring || undefined}
      aria-hidden="true"
      initial={owned ? moves.initial : false}
      animate={moves.animate}
      exit={owned ? moves.exit : undefined}
    >
      {text}
    </motion.span>
  );
}
