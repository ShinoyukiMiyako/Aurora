// framer-motion 弹簧预设与页面入场变体——集中一处复用，页面/组件不得各自另写弹簧参数。
// 两参弹簧直接映射 framer-motion 的 { type:"spring", duration, bounce }（对应 spec 第八节动效）。

import type { Transition, Variants } from "framer-motion";

export type SpringPreset = "tap" | "settle" | "pop" | "soft" | "morph" | "base";

export const springs: Record<SpringPreset, Transition> = {
  tap: { type: "spring", duration: 0.22, bounce: 0 },
  settle: { type: "spring", duration: 0.26, bounce: 0.1 },
  pop: { type: "spring", duration: 0.32, bounce: 0.2 },
  soft: { type: "spring", duration: 0.34, bounce: 0.12 },
  morph: { type: "spring", duration: 0.35, bounce: 0.14 },
  // 默认 base 弹簧：过冲最明显，用于强调性入场/切换。原名 aurora，预设名不再带产品名。
  base: { type: "spring", duration: 0.3, bounce: 0.35 },
};

// 页面容器：对直接子级 motion 元素做轻微 stagger（子级用 pageItem 变体即自动排队上滑）。
export const pageContainer: Variants = {
  hidden: {},
  show: {
    transition: { staggerChildren: 0.05, delayChildren: 0.02 },
  },
};

// 页面分区/卡片入场：透明 + 8px 上滑，用 soft 弹簧落位。
export const pageItem: Variants = {
  hidden: { opacity: 0, y: 8 },
  show: { opacity: 1, y: 0, transition: springs.soft },
};
