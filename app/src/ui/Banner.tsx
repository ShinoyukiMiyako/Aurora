// 横幅：影响整个视图、持续存在的状态（实例损坏需修复、上次崩溃、离线、正在安装）。
// 固定在页头下、主体之前，每个视图至多 1 条。一次性事件用 Toast，不用它。
// 没有强调色色调：大面积表面不上粉色。横幅里不放主按钮（视图的主按钮唯一），操作至多 2 个次按钮。
// 条件型横幅在条件成立期间不能关闭；只有 info 型可以给 onClose。

import type { ReactNode } from "react";
import { Icon, type IconName } from "../art/Icon";
import { cx } from "../lib/util";
import styles from "./Banner.module.css";
import { IconButton } from "./IconButton";
import { EntranceBlock } from "./Page";

export type FeedbackTone = "info" | "ok" | "warn" | "danger";

/** 色调的默认图标，与通知的严重度图标一致。 */
export const FEEDBACK_ICON = {
  info: "info",
  ok: "check-circle",
  warn: "alert",
  danger: "x-circle",
} as const satisfies Readonly<Record<FeedbackTone, IconName>>;

/**
 * 操作后才出现的提示要主动播报：警示与错误打断式（alert），信息与成功礼貌式（status）。
 * 随页面加载就存在的提示不播报，否则每次进页面都被念一遍。
 */
export function announceRole(tone: FeedbackTone, announce: boolean): "alert" | "status" | undefined {
  if (!announce) return undefined;
  return tone === "warn" || tone === "danger" ? "alert" : "status";
}

export interface BannerProps {
  tone: FeedbackTone;
  /** 一句话说明状态。 */
  title: ReactNode;
  /** 原因或影响；可以放进度条等内容。 */
  children?: ReactNode;
  icon?: IconName;
  /** 至多 2 个次按钮（md）。 */
  actions?: ReactNode;
  /** 只给 info 型：关闭后本次运行期间不再出现。 */
  onClose?: () => void;
  /** 操作后动态出现时为真。 */
  announce?: boolean;
  className?: string;
}

export function Banner({ tone, title, children, icon, actions, onClose, announce = false, className }: BannerProps) {
  if (onClose !== undefined && tone !== "info") throw new Error("只有 info 横幅可以关闭：条件型横幅在条件成立期间必须一直显示");
  return (
    <EntranceBlock className={cx(styles.banner, className)} data-tone={tone} role={announceRole(tone, announce)}>
      <span className={styles.icon}>
        <Icon name={icon === undefined ? FEEDBACK_ICON[tone] : icon} size={20} />
      </span>
      <div className={styles.text}>
        <div className={styles.title}>{title}</div>
        {children !== undefined && <div className={styles.body}>{children}</div>}
      </div>
      {(actions !== undefined || onClose !== undefined) && (
        <div className={styles.actions}>
          {actions}
          {onClose !== undefined && <IconButton icon="x" label="关闭提示" size="sm" onClick={onClose} />}
        </div>
      )}
    </EntranceBlock>
  );
}
