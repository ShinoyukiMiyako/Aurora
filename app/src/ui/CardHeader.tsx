// 卡片头：[图标底座] [标题 / 副标题] [操作区]，单行对齐。
// 操作区放小号图标按钮或小号按钮，最多 3 个，再多收进「更多」菜单。

import type { ReactElement, ReactNode } from "react";
import { Icon, type IconName } from "../art/Icon";
import { cx } from "../lib/util";
import styles from "./CardHeader.module.css";

export interface CardHeaderProps {
  title: ReactNode;
  subtitle?: ReactNode;
  /** 图标名放进 30px 的强调色底座；也可以传 30px 的任意节点（实例头像、缩略图）。 */
  icon?: IconName | ReactElement;
  actions?: ReactNode;
  /** 标题的语义层级，按页面大纲选。 */
  level?: 2 | 3;
  /** 只用于布局（外边距）。 */
  className?: string;
}

export function CardHeader({ title, subtitle, icon, actions, level = 3, className }: CardHeaderProps) {
  const Heading = level === 2 ? "h2" : "h3";
  return (
    <div className={cx(styles.header, className)}>
      {icon !== undefined &&
        (typeof icon === "string" ? (
          <span className={styles.icon}>
            <Icon name={icon} size={18} />
          </span>
        ) : (
          <span className={styles.slot}>{icon}</span>
        ))}
      <div className={styles.text}>
        <Heading className={styles.title}>{title}</Heading>
        {subtitle !== undefined && <span className={styles.subtitle}>{subtitle}</span>}
      </div>
      {actions !== undefined && <div className={styles.actions}>{actions}</div>}
    </div>
  );
}
