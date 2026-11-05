// 局部提示：卡片内或表单内的说明（「游戏正在运行，改动下次启动生效」、内存超过一半的警示、Java 不匹配）。
// 每张卡片至多 1 条；文字最多两行，后端原文除外（fullText）。影响整个视图的状态用 Banner。没有强调色色调。

import type { ReactNode } from "react";
import { Icon, type IconName } from "../art/Icon";
import { cx } from "../lib/util";
import { announceRole, FEEDBACK_ICON, type FeedbackTone } from "./Banner";
import styles from "./Callout.module.css";

export interface CalloutProps {
  tone: FeedbackTone;
  icon?: IconName;
  children: ReactNode;
  /** 可选一个幽灵小按钮，放在文字之后。 */
  action?: ReactNode;
  /** 操作后动态出现时为真。 */
  announce?: boolean;
  /** 内容是后端原文（失败原因、跳过的前置这类逐条说明）时为真：按实际行数显示，不截成两行。 */
  fullText?: boolean;
  className?: string;
}

export function Callout({ tone, icon, children, action, announce = false, fullText = false, className }: CalloutProps) {
  return (
    <div className={cx(styles.callout, className)} data-tone={tone} role={announceRole(tone, announce)}>
      <Icon name={icon === undefined ? FEEDBACK_ICON[tone] : icon} size={16} className={styles.icon} />
      <div className={styles.text} data-full={fullText || undefined}>
        {children}
      </div>
      {action !== undefined && <div className={styles.action}>{action}</div>}
    </div>
  );
}
