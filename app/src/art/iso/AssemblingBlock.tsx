import { motion, useAnimate, useReducedMotionConfig, type Transition } from "framer-motion";
import { useEffect, useRef, useState } from "react";
import { fade, springs } from "../../lib/motion";
import { cx } from "../../lib/util";
import { BitmapCanvas } from "../illustrations/BitmapCanvas";
import { useDevicePixelRatio } from "../illustrations/canvas";
import styles from "./AssemblingBlock.module.css";
import type { InstanceCover } from "./covers";
import { blueprintPath, isoLayout, type IsoFace, type IsoWidth } from "./geometry";
import { blockBitmap, emblemBitmap } from "./render";
import { useBlockSource } from "./useBlockSource";

/** 落位顺序永远是左 -> 右 -> 顶。 */
const FACE_ORDER: readonly IsoFace[] = ["left", "right", "top"];

/**
 * 组装时间线（秒或毫秒，见名）。面从各自的起点偏移（相对方块宽度）落回原位：
 * 左面从左下、右面从右下、顶面从上方；一次落多个面时相邻两面间隔 90 ms；最后一个面开始落位 120 ms 后坐定。
 */
export const ASSEMBLY_TIMING = {
  dropOffset: { left: [-0.22, 0.12], right: [0.22, 0.12], top: [0, -0.26] } as Readonly<Record<IsoFace, readonly [number, number]>>,
  dropFade: { duration: 0.16, ease: fade.in.ease } as Transition,
  reducedDropFade: { duration: 0.12, ease: fade.in.ease } as Transition,
  stepGapMs: 90,
  seatDelayMs: 120,
  /** 坐定：目标值与当前值相同，靠初速度产生一次回弹（约 55 ms 到 +8% 峰值）。 */
  seatVelocity: 3.5,
  blueprintOut: { duration: 0.16, ease: fade.out.ease } as Transition,
  /** 拆解（取消启动）：已落的面逆序飞回起点并淡出。 */
  disassemble: { duration: 0.14, gap: 0.05 },
  /** 崩落（加载中崩溃、启动失败）：已落的面逆序下坠 40% 并淡出。 */
  collapse: { duration: 0.22, gap: 0.04, fall: 0.4 },
} as const;

export type AssemblyExit = "disassemble" | "collapse";

export interface AssemblingBlockProps {
  instanceId: string;
  cover: InstanceCover;
  /** 已落位的面数（左、右、顶依次）。由启动阶段决定：准备 1、下载 2、启动 3。 */
  placed: 0 | 1 | 2 | 3;
  /** 进入运行：三面落齐后坐定一次，蓝图消失。 */
  seated?: boolean;
  /** 退场方式：拆解或崩落；为 null 时正常组装。 */
  exit?: AssemblyExit | null;
  /** 方块宽度，启动胶囊里为 28。 */
  width?: IsoWidth;
  className?: string;
}

/**
 * 启动胶囊左侧组装中的方块：虚线蓝图 + 三个独立的面层，几何与静态方块完全相同（竖棱 √1.5 倍）。
 * 面上是本机材质，读不到时是实例徽记。减少动画时只淡入淡出，没有位移、坐定与等待间隔。纯装饰，aria-hidden。
 */
export function AssemblingBlock({ instanceId, cover, placed, seated = false, exit = null, width = 28, className }: AssemblingBlockProps) {
  const layout = isoLayout(width);
  const dpr = useDevicePixelRatio();
  const source = useBlockSource(cover);
  const reduced = useReducedMotionConfig() === true;
  const [scope, animate] = useAnimate<HTMLSpanElement>();

  // 挂载时已落的面直接显示：胶囊在不同页面之间重新挂载时不重播落位
  const [shown, setShown] = useState<number>(placed);
  const lastDropAt = useRef(Number.NEGATIVE_INFINITY);
  const [seatStarted, setSeatStarted] = useState(seated && placed === 3);

  useEffect(() => {
    if (exit !== null) return;
    if (placed < shown) {
      setShown(placed);
      return;
    }
    if (placed === shown) return;
    const wait = reduced ? 0 : Math.max(0, lastDropAt.current + ASSEMBLY_TIMING.stepGapMs - performance.now());
    const timer = setTimeout(() => {
      lastDropAt.current = performance.now();
      setShown((s) => s + 1);
    }, wait);
    return () => clearTimeout(timer);
  }, [placed, shown, exit, reduced]);

  useEffect(() => {
    if (!seated) {
      setSeatStarted(false);
      return;
    }
    if (exit !== null || shown < 3 || seatStarted) return;
    const wait = reduced ? 0 : Math.max(0, lastDropAt.current + ASSEMBLY_TIMING.seatDelayMs - performance.now());
    const timer = setTimeout(() => {
      setSeatStarted(true);
      if (!reduced && scope.current) void animate(scope.current, { scale: 1 }, { ...springs.base, velocity: ASSEMBLY_TIMING.seatVelocity });
    }, wait);
    return () => clearTimeout(timer);
  }, [seated, exit, shown, seatStarted, reduced, animate, scope]);

  return (
    <span
      ref={scope}
      className={cx(styles.block, className)}
      style={{ width: layout.width, height: layout.canvasHeight }}
      data-sk-art="iso"
      data-placed={shown}
      data-art={source ? "texture" : "emblem"}
      aria-hidden="true"
    >
      <motion.svg
        className={styles.blueprint}
        width={layout.width}
        height={layout.canvasHeight}
        viewBox={`0 0 ${layout.width} ${layout.canvasHeight}`}
        initial={{ opacity: 0 }}
        animate={{ opacity: seatStarted ? 0 : 1 }}
        transition={seatStarted ? ASSEMBLY_TIMING.blueprintOut : fade.in}
      >
        <path d={blueprintPath(layout.width)} />
      </motion.svg>
      {FACE_ORDER.map((face, index) => {
        const real = source ? blockBitmap(source, layout, dpr, face) : null;
        const bitmap = real !== null ? real : emblemBitmap(instanceId, cover.hue, layout, dpr, face);
        const motionProps = faceMotion(face, index, shown, exit, reduced, layout.width, layout.canvasHeight);
        return (
          <motion.span key={face} className={styles.face} data-face={face} initial={false} animate={motionProps.animate} transition={motionProps.transition}>
            <BitmapCanvas bitmap={bitmap} cssWidth={layout.width} cssHeight={layout.canvasHeight} dpr={dpr} />
          </motion.span>
        );
      })}
    </span>
  );
}

function faceMotion(face: IsoFace, index: number, shown: number, exit: AssemblyExit | null, reduced: boolean, width: number, height: number) {
  const [ox, oy] = ASSEMBLY_TIMING.dropOffset[face];
  const away = reduced ? { x: 0, y: 0 } : { x: ox * width, y: oy * width };
  if (index >= shown) return { animate: { ...away, opacity: 0 }, transition: { duration: 0 } as Transition };
  // 退场逆序：最后落下的顶面最先离开
  const order = shown - 1 - index;
  if (exit === "disassemble") {
    const { duration, gap } = ASSEMBLY_TIMING.disassemble;
    return { animate: { ...away, opacity: 0 }, transition: reduced ? fade.out : ({ duration, ease: fade.out.ease, delay: order * gap } as Transition) };
  }
  if (exit === "collapse") {
    const { duration, gap, fall } = ASSEMBLY_TIMING.collapse;
    return {
      animate: { x: 0, y: reduced ? 0 : fall * height, opacity: 0 },
      transition: reduced ? fade.out : ({ duration, ease: fade.out.ease, delay: order * gap } as Transition),
    };
  }
  return {
    animate: { x: 0, y: 0, opacity: 1 },
    transition: reduced ? { opacity: ASSEMBLY_TIMING.reducedDropFade } : { ...springs.pop, opacity: ASSEMBLY_TIMING.dropFade },
  };
}
