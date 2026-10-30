import { cx } from "../lib/util";
import styles from "./Divider.module.css";

export interface DividerProps {
  /** 只用于布局（外边距）。 */
  className?: string;
}

/** 1px 分隔线。相邻容器共用一条，同一条边只画一次。 */
export function Divider({ className }: DividerProps) {
  return <hr className={cx(styles.divider, className)} />;
}
