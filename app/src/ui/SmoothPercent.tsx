// 进度旁边的百分数：取与进度条同一种平滑（同样的目标推演、同一条 settle 弹簧），字与条一起走，
// 不随每 100 ms 一次的原始进度跳字，也不在条还没走到时先报出数来。只改文字节点，不让所在的行重渲染。
// 旁边的进度条已经有一条平滑、字要与它同数时，用 PercentOf 直接读那条平滑，不另起弹簧。

import { motion, useMotionValue, type MotionValue } from "framer-motion";
import { useLayoutEffect } from "react";
import { percent } from "../domain/format";
import { useSmoothProgress } from "./ProgressBar";

export interface SmoothPercentProps {
  /** 0-1。 */
  value: number;
  /** 与旁边进度条的 track 相同：换任务、换批次直接跳到新值（从空开始的除外），同一批内只进不退。 */
  track: string;
  className?: string;
}

export function SmoothPercent({ value, track, className }: SmoothPercentProps) {
  const { smooth } = useSmoothProgress(value, track);
  return <PercentOf value={smooth} className={className} />;
}

export interface PercentOfProps {
  /** 已经在平滑的进度（0-1），通常是旁边进度条用的那个 useSmoothProgress().smooth。 */
  value: MotionValue<number>;
  className?: string;
}

/**
 * 读一条现成平滑的百分数：只订阅、不建弹簧，字与画同一条平滑的进度条按构造同数。
 * 另起一条弹簧的话，哪怕从条此刻的位置起步，也是从零速起步：条正带着速度走时字一路落后，直到两边都落定。
 */
export function PercentOf({ value, className }: PercentOfProps) {
  const text = useMotionValue(percent(value.get()));
  // 订阅常驻、不随渲染重订：useTransform 每次提交都先退订再重订，平滑在同一次提交的布局阶段里被直接跳到目标
  // （换批次、减少动画）时，那一下变化正好落在退订与重订之间，字停在旧值，直到下一次渲染。
  // 开始订阅（挂载、换了一条平滑）时先对齐一次：渲染时读到的值到这时可能已经走了
  useLayoutEffect(() => {
    text.set(percent(value.get()));
    return value.on("change", (p) => text.set(percent(p)));
  }, [value, text]);
  return <motion.span className={className}>{text}</motion.span>;
}
