// 页头：页面大标题 + 副标题 + 右侧动作。动作区里至多一个主按钮（每屏一个），放在最右。

import type { ReactNode } from "react";
import { cx } from "../lib/util";
import { EntranceBlock } from "./Page";
import styles from "./PageHeader.module.css";

export interface PageHeaderProps {
  title: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  /** 标题元素的 id，供 Page 的 aria-labelledby 引用。 */
  titleId?: string;
  className?: string;
}

export function PageHeader({ title, subtitle, actions, titleId, className }: PageHeaderProps) {
  return (
    <EntranceBlock as="header" className={cx(styles.header, className)}>
      <div className={styles.text}>
        <h1 id={titleId} className={styles.title}>
          {title}
        </h1>
        {subtitle !== undefined && <p className={styles.subtitle}>{subtitle}</p>}
      </div>
      {actions !== undefined && <div className={styles.actions}>{actions}</div>}
    </EntranceBlock>
  );
}
