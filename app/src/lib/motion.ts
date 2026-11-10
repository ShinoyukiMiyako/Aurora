// 动效参数的唯一出处：弹簧预设、补间、页面与面板的入场变体、提示气泡的时机。
// 页面与组件只引用这里的导出，不写字面的刚度、阻尼、时长与贝塞尔曲线。

import { cubicBezier, type Transition, type Variants } from "framer-motion";

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

/**
 * 两参弹簧从位移 x0、速度 v0（每秒）回到 0 的解析解：t 秒时的位移与速度。
 * 给不经 framer-motion 的动画用（交给合成线程播的关键帧要事先算好整条轨迹）；带初速度，途中改目标时接着走而不是从零速重新起步。
 */
export function springAt(name: SpringName, x0: number, v0: number, t: number): { x: number; v: number } {
  const { duration, bounce } = SPRING_PARAMS[name];
  const omega = (2 * Math.PI) / duration;
  const zeta = 1 - bounce;
  if (zeta >= 1) {
    const c = v0 + omega * x0;
    const decay = Math.exp(-omega * t);
    return { x: decay * (x0 + c * t), v: decay * (c - omega * (x0 + c * t)) };
  }
  const wd = omega * Math.sqrt(1 - zeta * zeta);
  const b = (v0 + zeta * omega * x0) / wd;
  const decay = Math.exp(-zeta * omega * t);
  const cos = Math.cos(wd * t);
  const sin = Math.sin(wd * t);
  const x = decay * (x0 * cos + b * sin);
  return { x, v: -zeta * omega * x + decay * wd * (b * cos - x0 * sin) };
}

/** 透明度一律用补间：弹簧作用在 opacity 上会过冲到 1 以上被截断，尾巴发闷。退场都用 out，不回弹。 */
export const fade = {
  in: { duration: 0.2, ease: [0.16, 1, 0.3, 1] },
  out: { duration: 0.12, ease: [0.4, 0, 1, 1] },
  /** 提示气泡退场：要比别的浮层更快让路。 */
  quick: { duration: 0.08, ease: [0.4, 0, 1, 1] },
  /** 一次变化太多、不逐项动画时的退场：直接换上。 */
  none: { duration: 0 },
} as const satisfies Record<string, Transition>;

/**
 * 环境层（主页花瓣、樱花林全景）的显隐：铺满整片背景的一层从无到有要比控件慢慢浮现，离开也比 out 稍长，
 * 大面积的明暗在 120 ms 里跳完像闪了一下。曲线沿用 in / out。只改透明度，减少动画时照常播放。
 */
export const ambientFade = {
  in: { duration: 0.48, ease: fade.in.ease },
  out: { duration: 0.2, ease: fade.out.ease },
} as const satisfies Record<string, Transition>;

/**
 * 补间在第 t 秒走到的进度（0 到 1，已过缓动曲线）。给不经 framer-motion、自己逐帧画的动画用
 * （花瓣画布里单片花瓣的淡入淡出），与弹簧的 springAt 相对。
 */
export function tweenAt(tween: { duration: number; ease: readonly [number, number, number, number] }, t: number): number {
  if (t <= 0) return 0;
  if (t >= tween.duration) return 1;
  const [x1, y1, x2, y2] = tween.ease;
  return cubicBezier(x1, y1, x2, y2)(t / tween.duration);
}

/** 应用根 MotionConfig 的兜底过渡：位移类走 base 弹簧，透明度走淡入补间。 */
export const rootTransition: Transition = { ...springs.base, opacity: fade.in };

/**
 * 页面一级区块的入场：上移 6px 淡入，第 i 项延迟 20 + min(i, 4) × 25 ms。按索引算延迟，不用已废弃的 staggerChildren。
 * 换页一天要做几十次：错开压到 120 ms 封顶，整页约 350 ms 落定，和侧栏选中滑块同一拍。
 * opacity 的过渡要自己带同一个 delay：motion-dom 把按值指定的过渡单独取出、配上编排延迟后再启动，
 * 根上的 delay 传不进去。漏写时各块同时淡入，后排已经不透明却还停在下方等位移起步。
 */
export const pageItem: Variants = {
  hidden: { opacity: 0, y: 6 },
  show: (i: number) => {
    const delay = 0.02 + Math.min(i, 4) * 0.025;
    return { opacity: 1, y: 0, transition: { ...springs.soft, delay, opacity: { ...fade.in, delay } } };
  },
};

/**
 * 标签页与分区内容切换的面板变体。必须以变体标签（hidden / show）驱动，不能写成
 * initial={{…}} animate={{…}} 的对象字面量：面板内部带 variants 的子元素会等最近的变体祖先来编排，
 * 面板不是变体节点时它们挂到更上层的祖先上，而那一层只在页面挂载时编排过一次，切换一次标签后
 * 子元素就永久停在 hidden（内容还在 DOM 里，只是透明）。标签名与 pageItem 同名，子元素才接得住编排。
 * 旧面板同一帧移除、不等退场，所以没有 exit。
 *
 * 来向（custom 传 PanelFrom）：新面板从它在导航里所在的那一侧进来，和指示块的移动对得上。横排标签选了右边的，
 * 内容从右侧 8px 处滑入；竖排分区选了上面的，内容从上方 6px 处落下。不传时从下方 6px 处上移。
 */
export interface PanelFrom {
  axis: "x" | "y";
  /** 新序号在旧序号之后为 1，之前为 -1。 */
  dir: 1 | -1;
}

export const tabPanel: Variants = {
  hidden: (from: PanelFrom | undefined) => {
    if (from === undefined) return { opacity: 0, y: 6 };
    return from.axis === "x" ? { opacity: 0, x: 8 * from.dir } : { opacity: 0, y: 6 * from.dir };
  },
  show: { opacity: 1, x: 0, y: 0, transition: { ...springs.settle, opacity: fade.in } },
};

/**
 * 流内块的增删（列表行、提示条、校验错误、联动出现的选项）：新增淡入并从略小处落到位，删除淡出。
 * 只管这一块自己；它腾出或占掉的位置由 popLayout 加兄弟让位（lib/reflow）处理，不动 height / margin。
 */
export const insertItem = {
  initial: { opacity: 0, scale: 0.98 },
  animate: { opacity: 1, scale: 1, transition: { ...springs.settle, opacity: fade.in } },
  exit: { opacity: 0, scale: 0.98, transition: fade.out },
} as const;

/** 否定抖动：只用于会话崩溃时的状态岛与被拒绝的表单字段，每次只播一次，减少动画时不播。每段都走淡入同一条令牌曲线。 */
export const shake = {
  x: [0, -4, 4, -3, 3, -1, 0],
  transition: { duration: 0.36, ease: fade.in.ease },
} as const;

/**
 * 启动胶囊左侧方块的组装时间线（秒或毫秒，见名）。面从各自的起点偏移（相对方块边长）落回原位：
 * 左面从左下、右面从右下、顶面从上方。加载面与安装中面换上来后 firstDropMs 落下第一面（面在 40 ms 处入场、
 * 蓝图随之出现，左面再落）；一次落多个面时相邻两面间隔 stepGapMs；最后一个面开始落位 seatDelayMs 后坐定。
 * 拆解与崩落按顶、右、左逆序，相邻两面错开 gap 秒。
 */
export const assembly = {
  dropOffset: { left: [-0.22, 0.12], right: [0.22, 0.12], top: [0, -0.26] },
  dropFade: { duration: 0.16, ease: fade.in.ease },
  reducedDropFade: { duration: 0.12, ease: fade.in.ease },
  firstDropMs: 160,
  stepGapMs: 90,
  seatDelayMs: 120,
  /** 坐定：目标值与当前值相同，靠初速度产生一次回弹（约 55 ms 到 +8% 峰值）。 */
  seatVelocity: 3.5,
  blueprintOut: { duration: 0.16, ease: fade.out.ease },
  /** 拆解（取消启动）：已落的面飞回起点并淡出。 */
  disassemble: { duration: 0.14, ease: fade.out.ease },
  disassembleGap: 0.05,
  /** 崩落（加载中崩溃、启动失败）：已落的面下坠 collapseFall 个边长并淡出。 */
  collapse: { duration: 0.22, ease: fade.out.ease },
  collapseGap: 0.04,
  collapseFall: 0.4,
} as const;

/**
 * 一行文字换内容（启动胶囊的阶段名）：旧行上移淡出，新行从下方落到位。两行叠在同一格里交接，不占额外高度。
 * 只给「换了一件事」的文字用；百分比、文件数、计时这类同一件事的数字更新直接换字，不走它。
 */
export const lineSwap: Variants = {
  enter: { opacity: 0, y: 4 },
  show: { opacity: 1, y: 0, transition: { ...springs.settle, opacity: fade.in } },
  leave: { opacity: 0, y: -4, transition: fade.out },
};

/**
 * 启动胶囊的换面：新面比旧面晚 faceEnterDelay 秒入场，旧面先让出位置；视图变化后旧面留住 holdMs 毫秒，
 * 让方块的拆解、崩落演完，或坐定之后再过 afterSeat 才换到运行面。减少动画时两者都归零。
 */
export const capsuleSwap = {
  faceEnterDelay: 0.04,
  holdMs: { disassemble: 240, collapse: 260, afterSeat: 200 },
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
