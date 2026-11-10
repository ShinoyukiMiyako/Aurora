// 卡片头：[图标底座] [标题 / 副标题] [操作区]，单行对齐。
// 操作区放小号图标按钮或小号按钮，最多 3 个，再多收进「更多」菜单。

import { motion } from "framer-motion";
import { useState, type ReactElement, type ReactNode } from "react";
import { Icon, type IconName } from "../art/Icon";
import { fade } from "../lib/motion";
import { cx } from "../lib/util";
import styles from "./CardHeader.module.css";

export interface CardHeaderProps {
  title: ReactNode;
  /**
   * 副标题。undefined 表示没有这一行；null 表示这一行要等数据（加载中）：先占住一行的高度，
   * 文案到了再淡入，头部不因数据晚到而变高、把下面的内容挤下去。
   */
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
  // 挂载时就有的副标题跟着所在页面的入场走；占过位之后，文案每次到达都淡入。
  // reserved 只在占位显示时翻转，那时文案不在，换成 motion 元素不会让已显示的文案重挂
  const [reserved, setReserved] = useState(subtitle === null);
  if (subtitle === null && !reserved) setReserved(true);
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
        {subtitle === null ? (
          <span className={styles.subtitle} data-reserve="" aria-hidden="true" />
        ) : subtitle === undefined ? null : reserved ? (
          <motion.span className={styles.subtitle} initial={{ opacity: 0 }} animate={{ opacity: 1, transition: fade.in }}>
            {subtitle}
          </motion.span>
        ) : (
          <span className={styles.subtitle}>{subtitle}</span>
        )}
      </div>
      {actions !== undefined && <div className={styles.actions}>{actions}</div>}
    </div>
  );
}
