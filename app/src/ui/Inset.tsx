// 凹陷区：卡片内的分组子区（日历的当日详情、Java 匹配状态、设备码框、Mod 总数说明）。
// 不可整体点击；需要点击用列表行或单选块。

import type { ReactNode } from "react";
import { cx } from "../lib/util";
import styles from "./Inset.module.css";

export interface InsetProps {
  as?: "div" | "section" | "aside";
  /** 只用于布局。 */
  className?: string;
  children: ReactNode;
}

export function Inset({ as: Tag = "div", className, children }: InsetProps) {
  return <Tag className={cx(styles.inset, className)}>{children}</Tag>;
}
