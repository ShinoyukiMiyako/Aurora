// 线性进度：任务、下载、Mod 更新等有进度的过程。启动全程用启动胶囊，不用它。
//
// 定进度：填充整条铺满轨道，靠 translateX((p − 1) × 100%) 移出可见区，轨道裁掉溢出。
// 不用 scaleX：缩放会把填充的圆角与渐变一起压扁。
// 不定进度：只给「正在进行但给不出进度」的单个条目（解析、校验）。排队中的任务传 0，显示静态空轨道：
// 一屏几十行排队任务各带一条循环光带，同屏循环动画数会失控。

import { motion, useReducedMotionConfig, useSpring, useTransform, type MotionValue, type SpringOptions } from "framer-motion";
import { useLayoutEffect, useRef, type HTMLAttributes } from "react";
import { springs } from "../lib/motion";
import { clamp, cx } from "../lib/util";
import styles from "./ProgressBar.module.css";

export type ProgressTone = "accent" | "ok" | "info" | "warn" | "danger" | "muted";
export type ProgressBarSize = "sm" | "md" | "lg";

/** 进度大于 0 时最少显示的比例：再短的填充在 4px 高的胶囊里就看不出来了。 */
export const MIN_VISIBLE_PROGRESS = 0.02;

/** 显示用的填充比例：截断到 [0, 1]，大于 0 时不少于 MIN_VISIBLE_PROGRESS。 */
export function visibleProgress(p: number): number {
  const v = clamp(p, 0, 1);
  return v > 0 ? Math.max(v, MIN_VISIBLE_PROGRESS) : 0;
}

/** 填充层的位移（百分比字符串），对应 translateX((p − 1) × 100%)。 */
export function fillOffset(p: number): string {
  return `${(visibleProgress(p) - 1) * 100}%`;
}

export interface ProgressTarget {
  track: string | undefined;
  target: number;
}

/**
 * 进度平滑的目标推演。track 是会话或任务的标识：
 * - 换了标识（新会话、新任务）直接跳到新值，不从旧值倒退着动画过去；
 * - 标识不变时只增不减，新值小于当前目标就忽略（后端分批上报，每批从 0 计起）；
 * - 没有标识时不做单调约束，原样跟随。
 * 后端可能报出大于 1 的进度（重传字节超出声明大小），这里统一截断到 [0, 1]。
 */
export function nextProgressTarget(prev: ProgressTarget, track: string | undefined, value: number): ProgressTarget & { jump: boolean } {
  if (Number.isNaN(value)) throw new Error("进度不能是 NaN");
  const v = clamp(value, 0, 1);
  if (track !== prev.track) return { track, target: v, jump: true };
  if (track !== undefined && v < prev.target) return { track, target: prev.target, jump: false };
  return { track, target: v, jump: false };
}

/**
 * 胶囊填充、状态岛进度、侧栏进度环、下载进度条共用的平滑：输出一个 MotionValue，跟随目标值的 settle 弹簧。
 * 减少动画时不平滑，直接跳到目标值。返回的 target 是推演后的目标（读屏与百分比文字用它，不用中间帧）。
 */
export function useSmoothProgress(value: number, track?: string): { smooth: MotionValue<number>; target: number } {
  const reduced = useReducedMotionConfig() === true;
  const state = useRef<ProgressTarget | null>(null);
  if (state.current === null) state.current = nextProgressTarget({ track, target: 0 }, track, value);
  const next = nextProgressTarget(state.current, track, value);
  const smooth = useSpring(next.target, springs.settle as SpringOptions);

  useLayoutEffect(() => {
    if (state.current === null) throw new Error("进度平滑状态在挂载前丢失");
    const step = nextProgressTarget(state.current, track, value);
    state.current = { track: step.track, target: step.target };
    if (step.jump || reduced) smooth.jump(step.target);
    // jump 只停得住在跑的弹簧，停不住已排进帧循环、还没起步的那一次；页面 hidden 时帧不来，那一次会一直排着，
    // 帧恢复后拿 jump 之前的目标起弹簧。这里把排着的目标换成当前值，起步时已到目标就不动
    smooth.set(step.target);
  }, [smooth, track, value, reduced]);

  return { smooth, target: next.target };
}

export interface ProgressBarProps {
  /** 0-1；null 为不定进度。排队中的任务传 0（静态空轨道），不要传 null。 */
  value: number | null;
  tone?: ProgressTone;
  size?: ProgressBarSize;
  /** 会话或任务的标识：标识不变时只增不减，换标识直接跳到新值。 */
  track?: string;
  /** 没有可见文字说明这条进度时必填。 */
  label?: string;
  /** 已有可见文字说明时，指向它的 id。label 与 labelledBy 至少给一个。 */
  labelledBy?: string;
  className?: string;
}

type BarAttrs = HTMLAttributes<HTMLSpanElement> & { "data-tone": ProgressTone; "data-size": ProgressBarSize };

export function ProgressBar({ value, tone = "accent", size = "md", track, label, labelledBy, className }: ProgressBarProps) {
  if (label === undefined && labelledBy === undefined) throw new Error("ProgressBar 需要 label 或 labelledBy 作为可访问名称");
  const attrs: BarAttrs = {
    className: cx(styles.bar, className),
    "data-tone": tone,
    "data-size": size,
    role: "progressbar",
    "aria-label": label,
    "aria-labelledby": labelledBy,
    "aria-valuemin": 0,
    "aria-valuemax": 100,
  };
  if (value === null) {
    return (
      <span {...attrs} data-indeterminate="">
        <span className={styles.indeterminate} />
      </span>
    );
  }
  return <DeterminateBar attrs={attrs} value={value} track={track} />;
}

function DeterminateBar({ attrs, value, track }: { attrs: BarAttrs; value: number; track: string | undefined }) {
  const { smooth, target } = useSmoothProgress(value, track);
  const x = useTransform(smooth, fillOffset);
  return (
    <span {...attrs} aria-valuenow={Math.round(target * 100)}>
      <motion.span className={styles.fill} style={{ x }} />
    </span>
  );
}
