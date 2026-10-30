// 分区标题：标题 + 基线对齐的提示 + 右侧插槽（「全部实例」一类幽灵小按钮）。

import type { ReactNode } from "react";
import { cx } from "../lib/util";
import styles from "./SectionTitle.module.css";

export interface SectionTitleProps {
  children: ReactNode;
  hint?: ReactNode;
  right?: ReactNode;
  /** 标题的语义层级，按页面大纲选。 */
  level?: 2 | 3;
  /** 标题元素的 id，供分区 aria-labelledby 引用。 */
  id?: string;
  className?: string;
}

export function SectionTitle({ children, hint, right, level = 2, id, className }: SectionTitleProps) {
  const Heading = level === 2 ? "h2" : "h3";
  return (
    <div className={cx(styles.section, className)}>
      <Heading id={id} className={styles.title}>
        {children}
      </Heading>
      {hint !== undefined && <span className={styles.hint}>{hint}</span>}
      {right !== undefined && <div className={styles.right}>{right}</div>}
    </div>
  );
}
