// 线性进度：任务、下载、Mod 更新等有进度的过程。启动全程用启动胶囊，不用它。
//
// 定进度：填充整条铺满轨道，靠 translateX((p − 1) × 100%) 移出可见区，轨道裁掉溢出。
// 不用 scaleX：缩放会把填充的圆角与渐变一起压扁。
// 不定进度：只给「正在进行但给不出进度」的单个条目（解析、校验）。排队中的任务传 0，显示静态空轨道：
// 一屏几十行排队任务各带一条循环光带，同屏循环动画数会失控。

import { motion, useReducedMotionConfig, useSpring, useTransform, type MotionValue, type SpringOptions } from "framer-motion";
import { useEffect, useRef, type HTMLAttributes } from "react";
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

/** 填充层的位移（百分比字符串），对应 translateX((p − 1) × 100%)；p 截断到 [0, 1]，不加最少显示长度。 */
function rawFillOffset(p: number): string {
  return `${(clamp(p, 0, 1) - 1) * 100}%`;
}

/**
 * 填充层的位移，大于 0 时不少于 MIN_VISIBLE_PROGRESS。用在逐帧平滑之后时，弹簧离开 0 的第一帧会一下冒出这一截；
 * 下限放在平滑终点上的写法见 DeterminateBar（useSmoothProgress 的 minVisible）。
 */
export function fillOffset(p: number): string {
  return rawFillOffset(visibleProgress(p));
}

export interface ProgressTarget {
  track: string | undefined;
  target: number;
}

/**
 * 进度平滑的目标推演。track 是会话或任务的标识：
 * - 换了标识（新会话、新任务、新批次）而当前目标大于 0 时直接跳到新值，不从旧值倒退着动画过去；
 * - 换了标识而当前目标是 0 时不跳，从空沿弹簧走上去：任务的标识在第一条下载快照带来总字节与文件数时才定下来，
 *   这一换要是跳，进度条一帧到位，一次下完的小批次会从空直接跳满；
 * - 标识不变时只增不减，新值小于当前目标就忽略（后端分批上报，每批从 0 计起）；
 * - 没有标识时不做单调约束，原样跟随。
 * 后端可能报出大于 1 的进度（重传字节超出声明大小），这里统一截断到 [0, 1]。
 */
export function nextProgressTarget(prev: ProgressTarget, track: string | undefined, value: number): ProgressTarget & { jump: boolean } {
  if (Number.isNaN(value)) throw new Error("进度不能是 NaN");
  const v = clamp(value, 0, 1);
  if (track !== prev.track) return { track, target: v, jump: prev.target > 0 };
  if (track !== undefined && v < prev.target) return { track, target: prev.target, jump: false };
  return { track, target: v, jump: false };
}

/** 平滑的终点：目标大于 0 时不低于 minVisible。 */
function springEnd(target: number, minVisible: number): number {
  return target > 0 ? Math.max(target, minVisible) : target;
}

/**
 * 胶囊填充、状态岛进度、侧栏进度环、下载进度条共用的平滑：输出一个 MotionValue，跟随目标值的 settle 弹簧。
 * 减少动画时不平滑，直接跳到目标值。返回的 target 是推演后的目标（读屏与百分比文字用它，不用中间帧）。
 * 挂载时从目标起步。别处要显示同一进度时直接读这里的 smooth（ui/SmoothPercent 的 PercentOf），不另起一条平滑。
 *
 * minVisible 是最少显示长度：目标大于 0 时，弹簧的终点不低于它，smooth 从 0 一路连续地长上去；target 仍是原值。
 * 下限要放在终点上：加在逐帧平滑之后（对 smooth 取 visibleProgress），弹簧离开 0 的第一帧就一下冒出那一截。
 */
export function useSmoothProgress(value: number, track?: string, minVisible = 0): { smooth: MotionValue<number>; target: number } {
  const reduced = useReducedMotionConfig() === true;
  const state = useRef<ProgressTarget | null>(null);
  if (state.current === null) state.current = nextProgressTarget({ track, target: 0 }, track, value);
  const next = nextProgressTarget(state.current, track, value);
  const smooth = useSpring(springEnd(next.target, minVisible), springs.settle as SpringOptions);

  // 提交之后再推目标，不放在布局 effect 里：调用方接着用 useTransform 由它派生位移与文字，多数就在同一组件里
  // （状态岛把它交给子组件 IslandBar 去派生）。useTransform 每次渲染都在布局阶段先退订、再按 hook 顺序重订
  // （framer-motion 的 useCombineMotionValues），同一组件里排在后面的订阅这时还没重订：jump 放在布局 effect 里会落在
  // 退订与重订之间，没人收到，减少动画下显示总慢一次上报，换了标识后停在上一个任务的进度上。
  // 被动 effect 在整次提交的布局阶段之后才跑，订阅不管在同一组件还是子组件里都已重订
  useEffect(() => {
    if (state.current === null) throw new Error("进度平滑状态在挂载前丢失");
    const step = nextProgressTarget(state.current, track, value);
    state.current = { track: step.track, target: step.target };
    const end = springEnd(step.target, minVisible);
    if (step.jump || reduced) smooth.jump(end);
    // jump 只停得住在跑的弹簧，停不住已排进帧循环、还没起步的那一次；页面 hidden 时帧不来，那一次会一直排着，
    // 帧恢复后拿 jump 之前的目标起弹簧。这里把排着的目标换成当前值，起步时已到目标就不动
    smooth.set(end);
  }, [smooth, track, value, reduced, minVisible]);

  return { smooth, target: next.target };
}

export interface ProgressBarProps {
  /** 0-1；null 为不定进度。排队中的任务传 0（静态空轨道），不要传 null。 */
  value: number | null;
  tone?: ProgressTone;
  size?: ProgressBarSize;
  /** 会话或任务的标识：标识不变时只增不减；换标识时直接跳到新值，从空开始的除外（见 nextProgressTarget）。 */
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
  // 最少显示长度落在平滑的终点上，逐帧的位移不再加下限；读屏报 target，是原值
  const { smooth, target } = useSmoothProgress(value, track, MIN_VISIBLE_PROGRESS);
  const x = useTransform(smooth, rawFillOffset);
  return (
    <span {...attrs} aria-valuenow={Math.round(target * 100)}>
      <motion.span className={styles.fill} style={{ x }} />
    </span>
  );
}
