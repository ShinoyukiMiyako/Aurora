// 动效参数的唯一出处：弹簧预设、补间、页面与面板的入场变体、提示气泡的时机。
// 页面与组件只引用这里的导出，不写字面的刚度、阻尼、时长与贝塞尔曲线。

import type { Transition, Variants } from "framer-motion";

export type SpringName = "tap" | "settle" | "pop" | "soft" | "morph" | "base";

/**
 * 两参弹簧：duration 为感知时长（约一个无阻尼周期，不是动画总时长），bounce 为弹跳量（0 为临界阻尼）。
 * 质量恒为 1：ω = 2π / duration，刚度 k = ω²，阻尼 c = 2(1 − bounce)ω。
 */
export const SPRING_PARAMS: Readonly<Record<SpringName, { duration: number; bounce: number }>> = {
  tap: { duration: 0.22, bounce: 0 },
  settle: { duration: 0.26, bounce: 0.1 },
  pop: { duration: 0.32, bounce: 0.2 },
  soft: { duration: 0.34, bounce: 0.12 },
  morph: { duration: 0.35, bounce: 0.14 },
  base: { duration: 0.3, bounce: 0.35 },
};

/**
 * 换算成 framer-motion 的物理弹簧。不能直接写 { type: "spring", duration, bounce }：
 * framer-motion 把 duration 当成包络衰减到 0.001 的总时长反解频率，同样的数字得到的弹簧快 1.35 到 1.65 倍；
 * 带 duration / bounce 键的弹簧在中途改目标时还会把继承速度清零，失去惯性。
 * 用 stiffness / damping / mass 写的物理弹簧中断时继承当前速度。
 */
export function twoParam(duration: number, bounce: number): Transition {
  const omega = (2 * Math.PI) / duration;
  return { type: "spring", stiffness: omega * omega, damping: 2 * (1 - bounce) * omega, mass: 1 };
}

export const springs: Readonly<Record<SpringName, Transition>> = {
  tap: twoParam(SPRING_PARAMS.tap.duration, SPRING_PARAMS.tap.bounce),
  settle: twoParam(SPRING_PARAMS.settle.duration, SPRING_PARAMS.settle.bounce),
  pop: twoParam(SPRING_PARAMS.pop.duration, SPRING_PARAMS.pop.bounce),
  soft: twoParam(SPRING_PARAMS.soft.duration, SPRING_PARAMS.soft.bounce),
  morph: twoParam(SPRING_PARAMS.morph.duration, SPRING_PARAMS.morph.bounce),
  base: twoParam(SPRING_PARAMS.base.duration, SPRING_PARAMS.base.bounce),
};

/** 透明度一律用补间：弹簧作用在 opacity 上会过冲到 1 以上被截断，尾巴发闷。退场都用 out，不回弹。 */
export const fade = {
  in: { duration: 0.2, ease: [0.16, 1, 0.3, 1] },
  out: { duration: 0.12, ease: [0.4, 0, 1, 1] },
  /** 提示气泡退场：要比别的浮层更快让路。 */
  quick: { duration: 0.08, ease: [0.4, 0, 1, 1] },
  /** 一次变化太多、不逐项动画时的退场：直接换上。 */
  none: { duration: 0 },
} as const satisfies Record<string, Transition>;

/** 应用根 MotionConfig 的兜底过渡：位移类走 base 弹簧，透明度走淡入补间。 */
export const rootTransition: Transition = { ...springs.base, opacity: fade.in };

/** 页面一级区块的入场：第 i 项延迟 20 + min(i, 5) × 40 ms。按索引算延迟，不用已废弃的 staggerChildren。 */
export const pageItem: Variants = {
  hidden: { opacity: 0, y: 8 },
  show: (i: number) => ({
    opacity: 1,
    y: 0,
    transition: { ...springs.soft, opacity: fade.in, delay: 0.02 + Math.min(i, 5) * 0.04 },
  }),
};

/**
 * 标签页与分区内容切换的面板变体。必须以变体标签（hidden / show）驱动，不能写成
 * initial={{…}} animate={{…}} 的对象字面量：面板内部带 variants 的子元素会等最近的变体祖先来编排，
 * 面板不是变体节点时它们挂到更上层的祖先上，而那一层只在页面挂载时编排过一次，切换一次标签后
 * 子元素就永久停在 hidden（内容还在 DOM 里，只是透明）。标签名与 pageItem 同名，子元素才接得住编排。
 * 旧面板同一帧移除、不等退场，所以没有 exit。
 */
export const tabPanel: Variants = {
  hidden: { opacity: 0, y: 6 },
  show: { opacity: 1, y: 0, transition: { ...springs.settle, opacity: fade.in } },
};

/** 否定抖动：只用于会话崩溃时的状态岛与被拒绝的表单字段，每次只播一次，减少动画时不播。 */
export const shake = {
  x: [0, -4, 4, -3, 3, -1, 0],
  transition: { duration: 0.36, ease: "easeOut" },
} as const;

/**
 * 提示气泡的时机（毫秒）。悬停 delay 后出现；任一气泡消失后 warmWindow 内移到另一个带提示的元素上立即出现；
 * 指针离开触发元素后 linger 内移入气泡则保持显示（可悬停驻留）。侧栏条目用 sidebarDelay。
 */
export const TOOLTIP_TIMING = {
  delay: 280,
  sidebarDelay: 120,
  warmWindow: 400,
  linger: 120,
} as const;

/** 提示气泡入场时起点向锚点一侧的偏移（px）：上下方位 3，左右方位 4。 */
export const TOOLTIP_ENTER_OFFSET = { vertical: 3, horizontal: 4 } as const;
