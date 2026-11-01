// warn 注记：一步里至多一条说明块（Callout），其余的 warn 提醒写成这样的行。不限两行，后端原文不会被截断，也比说明块省地方。

import type { ReactNode } from "react";
import { Icon } from "../art/Icon";
import { cx } from "../lib/util";
import styles from "./WarnNote.module.css";

export interface WarnNoteProps {
  children: ReactNode;
  /** 可选一个幽灵小按钮，放在文字之后。写成行的提醒不能丢掉说明块上的入口。 */
  action?: ReactNode;
  className?: string;
}

export function WarnNote({ children, action, className }: WarnNoteProps) {
  return (
    <div className={cx(styles.warnNote, className)}>
      <Icon name="alert" size={16} className={styles.icon} />
      <div className={styles.text}>{children}</div>
      {action !== undefined && <div className={styles.action}>{action}</div>}
    </div>
  );
}
