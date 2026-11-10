// 进度旁边的百分数：取与进度条同一种平滑（同样的目标推演、同一条 settle 弹簧），字与条一起走，
// 不随每 100 ms 一次的原始进度跳字，也不在条还没走到时先报出数来。只改文字节点，不让所在的行重渲染。

import { motion, useMotionValue } from "framer-motion";
import { useLayoutEffect } from "react";
import { percent } from "../domain/format";
import { useSmoothProgress } from "./ProgressBar";

export interface SmoothPercentProps {
  /** 0-1。 */
  value: number;
  /** 与旁边进度条的 track 相同：换任务、换批次直接跳到新值，同一批内只进不退。 */
  track: string;
  className?: string;
}

export function SmoothPercent({ value, track, className }: SmoothPercentProps) {
  const { smooth } = useSmoothProgress(value, track);
  const text = useMotionValue(percent(smooth.get()));
  // 订阅常驻、不随渲染重订：useTransform 每次提交都先退订再重订，平滑在同一次提交的布局阶段里被直接跳到目标
  // （换批次、减少动画）时，那一下变化正好落在退订与重订之间，字停在旧值，直到下一次渲染
  useLayoutEffect(() => smooth.on("change", (p) => text.set(percent(p))), [smooth, text]);
  return <motion.span className={className}>{text}</motion.span>;
}
