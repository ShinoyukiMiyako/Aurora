// 计数或提醒点，附着在导航项、图标按钮、标签页上。角标本身不朗读：数值要并入宿主的名称
// （「下载任务，3 个进行中」），否则读屏会把孤零零的数字念出来。

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
}

export function badgeText(count: number): string {
  if (!Number.isInteger(count) || count < 0) throw new Error(`Badge 计数必须是非负整数，收到 ${count}`);
  return count > BADGE_MAX ? `${BADGE_MAX}+` : String(count);
}

export function Badge({ count, tone = "neutral", ring = false, className }: BadgeProps) {
  const text = count === undefined ? null : badgeText(count);
  return (
    <span className={cx(styles.badge, className)} data-tone={tone} data-kind={text === null ? "dot" : "count"} data-ring={ring || undefined} aria-hidden="true">
      {text}
    </span>
  );
}
