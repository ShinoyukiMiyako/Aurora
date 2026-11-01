import { cx } from "../lib/util";
import { SakuraMark } from "./Logo";
import styles from "./Spinner.module.css";

/** 16 / 20 / 24 / 32 为独立加载指示的四档；18 只给 md 按钮的加载态用，与按钮图标同尺寸。 */
export type SpinnerSize = 16 | 18 | 20 | 24 | 32;

/**
 * accent：默认的强调色；on-accent：放在强调色实底上，用强调实底上的字色；
 * current：随所在控件的文字色（危险按钮这类状态色实底上用它）。
 */
export type SpinnerTone = "accent" | "on-accent" | "current";

export interface SpinnerProps {
  size?: SpinnerSize;
  tone?: SpinnerTone;
  /** 装饰性：所在控件已用 aria-busy 表达加载状态时，指示本身不再朗读。 */
  decorative?: boolean;
  className?: string;
}

/**
 * 樱花加载指示：单色徽记匀速旋转，全站加载只用它。它是「只在加载期间存在」的动画，
 * 减少动画时改为透明度脉冲（见样式）。
 */
export function Spinner({ size = 20, tone = "accent", decorative = false, className }: SpinnerProps) {
  return (
    <span
      className={cx(styles.spinner, className)}
      data-tone={tone}
      role={decorative ? undefined : "status"}
      aria-label={decorative ? undefined : "加载中"}
      aria-hidden={decorative || undefined}
    >
      <SakuraMark size={size} mono />
    </span>
  );
}
