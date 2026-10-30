// 环形进度：空间紧凑处的进度（标题栏下载入口、行内安装进度、主页最近游玩的启动中）。
// 从 12 点方向顺时针填充；不支持不定进度（那种场合用加载指示）。实例头像上的进度环属于实例头像，不是它。

import { motion, useTransform } from "framer-motion";
import { percent } from "../domain/format";
import { cx } from "../lib/util";
import type { ProgressTone } from "./ProgressBar";
import { useSmoothProgress } from "./ProgressBar";
import styles from "./ProgressRing.module.css";

export type ProgressRingSize = 16 | 20 | 24 | 36 | 48;

/** 各尺寸的描边粗细；36 与 48 圆心显示百分数，更小的放不下文字。 */
export const RING_STROKE = { 16: 2, 20: 2, 24: 2.5, 36: 3.5, 48: 4 } as const satisfies Readonly<Record<ProgressRingSize, number>>;

export function ringHasLabel(size: ProgressRingSize): boolean {
  return size >= 36;
}

export interface ProgressRingProps {
  /** 0-1。 */
  value: number;
  size?: ProgressRingSize;
  tone?: ProgressTone;
  /** 会话或任务的标识：标识不变时只增不减，换标识直接跳到新值。 */
  track?: string;
  /** 启动进度只有进入运行才算 100%：圆心百分数封顶 99。 */
  capAt99?: boolean;
  label?: string;
  labelledBy?: string;
  className?: string;
}

export function ProgressRing({ value, size = 36, tone = "accent", track, capAt99 = false, label, labelledBy, className }: ProgressRingProps) {
  if (label === undefined && labelledBy === undefined) throw new Error("ProgressRing 需要 label 或 labelledBy 作为可访问名称");
  const { smooth, target } = useSmoothProgress(value, track);
  const stroke = RING_STROKE[size];
  const radius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;
  const dashOffset = useTransform(smooth, (p) => circumference * (1 - p));
  const text = useTransform(smooth, (p) => percent(p, capAt99));
  const center = size / 2;

  return (
    <span
      className={cx(styles.ring, className)}
      data-tone={tone}
      data-size={size}
      role="progressbar"
      aria-label={label}
      aria-labelledby={labelledBy}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(target * 100)}
    >
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true" focusable="false">
        <circle className={styles.track} cx={center} cy={center} r={radius} fill="none" strokeWidth={stroke} />
        {/* 进度为 0 时不画填充：圆头描边在零长度时仍会画出一个点 */}
        {target > 0 && (
          <motion.circle
            className={styles.fill}
            cx={center}
            cy={center}
            r={radius}
            fill="none"
            strokeWidth={stroke}
            strokeLinecap="round"
            strokeDasharray={circumference}
            style={{ strokeDashoffset: dashOffset }}
          />
        )}
      </svg>
      {ringHasLabel(size) && (
        <motion.span className={styles.label} aria-hidden="true">
          {text}
        </motion.span>
      )}
    </span>
  );
}
