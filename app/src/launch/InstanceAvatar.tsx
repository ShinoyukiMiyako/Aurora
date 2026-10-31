// 实例头像：art/iso 的身份图形之上叠加启动状态。状态只取 launchView 的判定，不另造状态机。
//
// - 状态环（40 及以上）：启动中按会话进度、强调色；安装中按任务进度、信息色；排队中只画虚线轨道。
// - 角标（32 及以上）：运行中实心绿点（只在呼吸窗口内呼吸）；启动失败与崩溃为危险色「!」；损坏为警示色「!」。
// - 24 只画身份图形。头像本身 aria-hidden：宿主控件的名称要写出实例名与状态文字。

import { motion, useTransform } from "framer-motion";
import { useRef } from "react";
import { INSTANCE_AVATAR_SPECS, InstanceAvatarBase, type InstanceAvatarSize } from "../art/iso/InstanceAvatarBase";
import type { InstanceSummary } from "../domain/adapt";
import { useLauncher } from "../state/launcher";
import { useSmoothProgress, visibleProgress } from "../ui/ProgressBar";
import { useBreathPhase } from "./breath";
import { instanceCover } from "./cover";
import styles from "./InstanceAvatar.module.css";
import { launchView, type LaunchView } from "./launchView";

export type { InstanceAvatarSize } from "../art/iso/InstanceAvatarBase";

export interface InstanceAvatarProps {
  instance: InstanceSummary;
  size: InstanceAvatarSize;
  /** hue：色相底座（默认）；neutral：中性底座，只给侧栏固定实例用。 */
  base?: "hue" | "neutral";
  selected?: boolean;
  /** 在可点宿主内悬停时方块上浮。默认 true。 */
  lift?: boolean;
  /** 叠加启动状态。默认 true；只要身份图形（行内引用、日历列表）时传 false。 */
  status?: boolean;
  className?: string;
}

/** 状态环外扩与描边。 */
export const RING_OUTSET = 4;
export const RING_STROKE = 2.5;

export type AvatarIndicator =
  | { type: "none" }
  | { type: "ring"; tone: "accent" | "info"; progress: number; track: string }
  | { type: "queued" }
  | { type: "badge"; tone: "ok" | "danger" | "warn" };

/** 头像上该画哪一种指示；同一时刻只有一种。尺寸放不下环或角标时降级为无。 */
export function avatarIndicator(view: LaunchView, size: InstanceAvatarSize): AvatarIndicator {
  const ringFits = size >= 40;
  const badgeFits = size >= 32;
  switch (view.kind) {
    case "loading":
      return ringFits ? { type: "ring", tone: "accent", progress: view.session.progress, track: view.session.taskId } : { type: "none" };
    case "installing": {
      if (!ringFits) return { type: "none" };
      const task = view.task;
      if (task === null || task.status === "queued") return { type: "queued" };
      return { type: "ring", tone: "info", progress: task.progress, track: `${task.id}#${task.attempt}` };
    }
    case "running":
      return badgeFits ? { type: "badge", tone: "ok" } : { type: "none" };
    case "failed":
    case "crashed":
      return badgeFits ? { type: "badge", tone: "danger" } : { type: "none" };
    case "broken":
      return badgeFits ? { type: "badge", tone: "warn" } : { type: "none" };
    case "ready":
    case "stopped":
      return { type: "none" };
  }
}

/** 从上边中点起顺时针的圆角方框路径与周长：进度从 12 点方向开始填充，与环形进度一致。 */
export function ringGeometry(size: InstanceAvatarSize): { box: number; path: string; length: number } {
  const box = size + RING_OUTSET * 2;
  const inset = RING_STROKE / 2;
  const r = INSTANCE_AVATAR_SPECS[size].radius + RING_STROKE;
  const lo = inset;
  const hi = box - inset;
  const mid = box / 2;
  const path = [
    `M ${mid} ${lo}`,
    `H ${hi - r}`,
    `A ${r} ${r} 0 0 1 ${hi} ${lo + r}`,
    `V ${hi - r}`,
    `A ${r} ${r} 0 0 1 ${hi - r} ${hi}`,
    `H ${lo + r}`,
    `A ${r} ${r} 0 0 1 ${lo} ${hi - r}`,
    `V ${lo + r}`,
    `A ${r} ${r} 0 0 1 ${lo + r} ${lo}`,
    "Z",
  ].join(" ");
  const side = hi - lo - 2 * r;
  return { box, path, length: 4 * side + 2 * Math.PI * r };
}

export function InstanceAvatar({ instance, size, base = "hue", selected = false, lift = true, status = true, className }: InstanceAvatarProps) {
  const { state } = useLauncher();
  const indicator = status ? avatarIndicator(launchView(state, instance), size) : ({ type: "none" } as const);
  return (
    <InstanceAvatarBase instanceId={instance.id} cover={instanceCover(instance)} size={size} base={base} selected={selected} lift={lift} className={className}>
      {indicator.type === "ring" && <ProgressRingOverlay size={size} tone={indicator.tone} progress={indicator.progress} track={indicator.track} />}
      {indicator.type === "queued" && <QueuedRing size={size} />}
      {indicator.type === "badge" && <Badge tone={indicator.tone} />}
    </InstanceAvatarBase>
  );
}

function ProgressRingOverlay({ size, tone, progress, track }: { size: InstanceAvatarSize; tone: "accent" | "info"; progress: number; track: string }) {
  const { box, path, length } = ringGeometry(size);
  const { smooth, target } = useSmoothProgress(progress, track);
  const dashOffset = useTransform(smooth, (p) => length * (1 - visibleProgress(p)));
  return (
    <svg className={styles.ring} data-tone={tone} width={box} height={box} viewBox={`0 0 ${box} ${box}`} focusable="false">
      <path className={styles.track} d={path} fill="none" strokeWidth={RING_STROKE} />
      {/* 进度为 0 时不画填充：圆头描边在零长度时仍会画出一个点 */}
      {target > 0 && (
        <motion.path
          className={styles.fill}
          d={path}
          fill="none"
          strokeWidth={RING_STROKE}
          strokeLinecap="round"
          strokeDasharray={`${length} ${length}`}
          style={{ strokeDashoffset: dashOffset }}
        />
      )}
    </svg>
  );
}

function QueuedRing({ size }: { size: InstanceAvatarSize }) {
  const { box, path } = ringGeometry(size);
  return (
    <svg className={styles.ring} data-queued="" width={box} height={box} viewBox={`0 0 ${box} ${box}`} focusable="false">
      <path className={styles.track} d={path} fill="none" strokeWidth={RING_STROKE} />
    </svg>
  );
}

function Badge({ tone }: { tone: "ok" | "danger" | "warn" }) {
  const ref = useRef<HTMLSpanElement>(null);
  useBreathPhase(ref, tone === "ok");
  return (
    <span ref={ref} className={styles.badge} data-tone={tone}>
      {tone !== "ok" && "!"}
    </span>
  );
}
