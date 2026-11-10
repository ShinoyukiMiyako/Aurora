// 实例头像：art/iso 的身份图形之上叠加启动状态。状态只取 launchView 的判定，不另造状态机。
//
// - 状态环（40 及以上）：启动中按会话进度、强调色；安装中按任务进度、信息色；排队中只画虚线轨道。
// - 角标（32 及以上）：运行中实心绿点（只在呼吸窗口内呼吸）；启动失败与崩溃为危险色「!」；损坏为警示色「!」。
// - 24 只画身份图形。头像本身 aria-hidden：宿主控件的名称要写出实例名与状态文字。

import { AnimatePresence, motion, useIsPresent, usePresenceData, useTransform } from "framer-motion";
import { useRef } from "react";
import { INSTANCE_AVATAR_SPECS, InstanceAvatarBase, type InstanceAvatarSize } from "../art/iso/InstanceAvatarBase";
import type { InstanceSummary } from "../domain/adapt";
import { fade, springs } from "../lib/motion";
import { useLauncherSelector } from "../state/launcher";
import { progressTrack } from "../state/tasks";
import { useSmoothProgress, visibleProgress } from "../ui/ProgressBar";
import { useBreathPhase } from "./breath";
import { useInstanceCover } from "./cover";
import styles from "./InstanceAvatar.module.css";
import { launchView, type LaunchView } from "./launchView";
import { useMounted } from "../lib/useMounted";

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
      return { type: "ring", tone: "info", progress: task.progress, track: progressTrack(task) };
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

const NO_INDICATOR: AvatarIndicator = { type: "none" };

function sameIndicator(a: AvatarIndicator, b: AvatarIndicator): boolean {
  if (a.type !== b.type) return false;
  if (a.type === "ring" && b.type === "ring") return a.tone === b.tone && a.progress === b.progress && a.track === b.track;
  if (a.type === "badge" && b.type === "badge") return a.tone === b.tone;
  return true;
}

export function InstanceAvatar({ instance, size, base = "hue", selected = false, lift = true, status = true, className }: InstanceAvatarProps) {
  // 只订阅这个头像上的指示：别的实例的下载进度、游戏日志都不让它重渲染
  const indicator = useLauncherSelector((s) => (status ? avatarIndicator(launchView(s, instance), size) : NO_INDICATOR), sameIndicator);
  const cover = useInstanceCover(instance);
  return (
    <InstanceAvatarBase instanceId={instance.id} cover={cover} size={size} base={base} selected={selected} lift={lift} className={className}>
      <AvatarIndicatorLayer indicator={indicator} size={size} />
    </InstanceAvatarBase>
  );
}

/** 环与轨道的出现、消失：只淡入淡出。 */
const ringPresence = {
  initial: { opacity: 0 },
  animate: { opacity: 1, transition: fade.in },
  exit: { opacity: 0, transition: fade.out },
} as const;

/**
 * 头像上的状态层：进度环、排队轨道或角标。三者之间、角标换色调（运行转崩溃）时旧的退场、新的入场，不在一帧里硬切：
 * 环与轨道淡入淡出，角标从 0 弹出（pop）、消失时缩到 0.6 淡出。头像挂载时就在的那一个直接显示，跟着所在页面走。
 */
export function AvatarIndicatorLayer({ indicator, size }: { indicator: AvatarIndicator; size: InstanceAvatarSize }) {
  const mounted = useMounted();
  const appear = mounted.current;
  return (
    // 退场的环读 custom 得知接下来是什么：进入运行时先补满再走
    <AnimatePresence custom={indicator}>
      {indicator.type === "ring" && (
        <ProgressRingOverlay key={`ring:${indicator.tone}`} size={size} tone={indicator.tone} progress={indicator.progress} track={indicator.track} appear={appear} />
      )}
      {indicator.type === "queued" && <QueuedRing key="queued" size={size} appear={appear} />}
      {indicator.type === "badge" && <Badge key={`badge:${indicator.tone}`} tone={indicator.tone} appear={appear} />}
    </AnimatePresence>
  );
}

function ProgressRingOverlay({ size, tone, progress, track, appear }: { size: InstanceAvatarSize; tone: "accent" | "info"; progress: number; track: string; appear: boolean }) {
  const { box, path, length } = ringGeometry(size);
  const present = useIsPresent();
  const next = usePresenceData() as AvatarIndicator | undefined;
  // 启动走完进入运行：环在淡出的同时补满，不带着缺口消失；失败、取消时停在原处淡出
  const completed = !present && next !== undefined && next.type === "badge" && next.tone === "ok";
  const { smooth, target } = useSmoothProgress(completed ? 1 : progress, track);
  const dashOffset = useTransform(smooth, (p) => length * (1 - visibleProgress(p)));
  return (
    <motion.svg
      className={styles.ring}
      data-tone={tone}
      width={box}
      height={box}
      viewBox={`0 0 ${box} ${box}`}
      focusable="false"
      initial={appear ? ringPresence.initial : false}
      animate={ringPresence.animate}
      exit={ringPresence.exit}
    >
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
    </motion.svg>
  );
}

function QueuedRing({ size, appear }: { size: InstanceAvatarSize; appear: boolean }) {
  const { box, path } = ringGeometry(size);
  return (
    <motion.svg
      className={styles.ring}
      data-queued=""
      width={box}
      height={box}
      viewBox={`0 0 ${box} ${box}`}
      focusable="false"
      initial={appear ? ringPresence.initial : false}
      animate={ringPresence.animate}
      exit={ringPresence.exit}
    >
      <path className={styles.track} d={path} fill="none" strokeWidth={RING_STROKE} />
    </motion.svg>
  );
}

/**
 * 角标。外层管弹出与消失（transform），里层是圆点本身、运行时在呼吸窗口内呼吸：呼吸是 CSS 动画，
 * 会盖过外层写在内联上的缩放，所以分在两层上。
 */
function Badge({ tone, appear }: { tone: "ok" | "danger" | "warn"; appear: boolean }) {
  const ref = useRef<HTMLSpanElement>(null);
  useBreathPhase(ref, tone === "ok");
  return (
    <motion.span
      className={styles.badgeSlot}
      data-badge={tone}
      initial={appear ? { scale: 0, opacity: 0 } : false}
      animate={{ scale: 1, opacity: 1, transition: { ...springs.pop, opacity: fade.in } }}
      exit={{ scale: 0.6, opacity: 0, transition: fade.out }}
    >
      <span ref={ref} className={styles.badge} data-tone={tone}>
        {tone !== "ok" && "!"}
      </span>
    </motion.span>
  );
}
