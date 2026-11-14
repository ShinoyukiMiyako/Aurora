// 环形进度：空间紧凑处的进度（标题栏下载入口、行内安装进度、主页最近游玩的启动中），以及下载任务页的总进度环（84 档）。
// 从 12 点方向顺时针填充；不支持不定进度（那种场合用加载指示）。实例头像上的进度环属于实例头像，不是它。
// value 为 null 表示眼下没有可显示的进度（例如没有活动任务）：只画轨道，带圆心文字的档位写「--」。
// 这时不再是进度条：没有当前值的 progressbar 会被读屏当成不定进度念「忙」，所以改为图形，名称后接一句可读的说明。

import { AnimatePresence, motion, useIsPresent, useTransform, type MotionValue } from "framer-motion";
import { useId, useRef } from "react";
import { percent } from "../domain/format";
import { fade } from "../lib/motion";
import { useMounted } from "../lib/useMounted";
import { clamp, cx } from "../lib/util";
import type { ProgressTone } from "./ProgressBar";
import { useSmoothProgress } from "./ProgressBar";
import styles from "./ProgressRing.module.css";

export type ProgressRingSize = 16 | 20 | 24 | 36 | 48 | 84;

/** 各尺寸的描边粗细；36 及以上圆心显示百分数，更小的放不下文字。 */
export const RING_STROKE = { 16: 2, 20: 2, 24: 2.5, 36: 3.5, 48: 4, 84: 7 } as const satisfies Readonly<Record<ProgressRingSize, number>>;

/** 没有可显示的进度时圆心的占位。 */
export const RING_PLACEHOLDER = "--";

/** 没有可显示的进度时读屏接在名称后的说明；调用方能说清是哪种「没有」时用 emptyText 换掉它。 */
export const RING_EMPTY_TEXT = "暂无进度";

export function ringHasLabel(size: ProgressRingSize): boolean {
  return size >= 36;
}

export interface ProgressRingProps {
  /** 0-1；null 为眼下没有可显示的进度。 */
  value: number | null;
  size?: ProgressRingSize;
  tone?: ProgressTone;
  /** 会话或任务的标识：标识不变时只增不减；换标识时直接跳到新值，从空开始的除外（见 nextProgressTarget）。 */
  track?: string;
  /** 启动进度只有进入运行才算 100%：圆心百分数封顶 99。 */
  capAt99?: boolean;
  label?: string;
  labelledBy?: string;
  /** value 为 null 时读屏接在名称后的说明，例如「没有进行中的下载」。 */
  emptyText?: string;
  className?: string;
}

export function ProgressRing({ value, size = 36, tone = "accent", track, capAt99 = false, label, labelledBy, emptyText = RING_EMPTY_TEXT, className }: ProgressRingProps) {
  if (label === undefined && labelledBy === undefined) throw new Error("ProgressRing 需要 label 或 labelledBy 作为可访问名称");
  const empty = value === null;
  const emptyTextId = useId();
  // 占位时不画填充、不写百分数；交给平滑的 0 只是占位，推演规则与 track 一致
  const { smooth, target } = useSmoothProgress(empty ? 0 : value, track);
  const stroke = RING_STROKE[size];
  const radius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;
  // 截到 [0, 1]（同 fillOffset）：settle 弹簧补满时会略冲过 1，描边偏移变负，弧的起点让出一道缝
  const dashOffset = useTransform(smooth, (p) => circumference * (1 - clamp(p, 0, 1)));
  const text = useTransform(smooth, (p) => percent(p, capAt99));
  const center = size / 2;
  // 挂载时就有进度的填充直接显示，之后才出现的淡入。不写在 AnimatePresence 的 initial={false} 上：
  // 那会让填充里之后才挂载的动画元素也永远跳过入场
  const mounted = useMounted();

  return (
    <span
      className={cx(styles.ring, className)}
      data-tone={tone}
      data-size={size}
      data-empty={empty || undefined}
      role={empty ? "img" : "progressbar"}
      aria-label={label !== undefined && empty ? `${label}：${emptyText}` : label}
      aria-labelledby={labelledBy !== undefined && empty ? `${labelledBy} ${emptyTextId}` : labelledBy}
      aria-valuemin={empty ? undefined : 0}
      aria-valuemax={empty ? undefined : 100}
      aria-valuenow={empty ? undefined : Math.round(target * 100)}
    >
      {/* 名称经 labelledBy 引用时说明也只能经引用接上；被直接引用的隐藏节点照样计入名称 */}
      {empty && labelledBy !== undefined && (
        <span id={emptyTextId} hidden>
          {emptyText}
        </span>
      )}
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true" focusable="false">
        <circle className={styles.track} cx={center} cy={center} r={radius} fill="none" strokeWidth={stroke} />
        {/* 进度为 0 时不画填充：圆头描边在零长度时仍会画出一个点 */}
        <AnimatePresence>
          {!empty && target > 0 && <RingFill key="fill" center={center} radius={radius} stroke={stroke} circumference={circumference} dashOffset={dashOffset} appear={mounted.current} />}
        </AnimatePresence>
      </svg>
      {ringHasLabel(size) && (
        <motion.span className={styles.label} aria-hidden="true">
          {empty ? RING_PLACEHOLDER : text}
        </motion.span>
      )}
    </span>
  );
}

/**
 * 填充弧：出现时淡入（appear：进度环挂载之后才出现），转为没有进度时淡出。退场期间停在最后显示的位置：
 * 没有 track 时平滑值会随占位的 0 往回走，不停住的话弧会一边淡出一边倒退。
 */
function RingFill({ center, radius, stroke, circumference, dashOffset, appear }: { center: number; radius: number; stroke: number; circumference: number; dashOffset: MotionValue<number>; appear: boolean }) {
  const present = useIsPresent();
  const frozen = useRef<number | null>(null);
  // 退场途中进度又回来时（同一个键重新出现）继续跟随
  if (present) frozen.current = null;
  else if (frozen.current === null) frozen.current = dashOffset.get();
  return (
    <motion.circle
      className={styles.fill}
      cx={center}
      cy={center}
      r={radius}
      fill="none"
      strokeWidth={stroke}
      strokeLinecap="round"
      strokeDasharray={circumference}
      style={{ strokeDashoffset: frozen.current === null ? dashOffset : frozen.current }}
      initial={appear ? { opacity: 0 } : false}
      animate={{ opacity: 1, transition: fade.in }}
      exit={{ opacity: 0, transition: fade.out }}
    />
  );
}
