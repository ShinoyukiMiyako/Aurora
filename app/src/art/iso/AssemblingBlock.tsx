import { motion, useAnimate, useReducedMotionConfig, type TargetAndTransition, type Transition } from "framer-motion";
import { useEffect, useRef, useState } from "react";
import { assembly, fade, springs } from "../../lib/motion";
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
  /**
   * 随新换上的面一起入场（点了启动、开始安装）：从一面未落起，蓝图淡入，挂载 firstDropMs 后落下第一面。
   * 不传时按重新挂载处理（胶囊在页面之间换了位置）：已落的面与蓝图直接显示，不重播落位。
   */
  enter?: boolean;
  className?: string;
}

/**
 * 启动胶囊左侧组装中的方块：虚线蓝图 + 三个独立的面层，几何与静态方块完全相同（竖棱 √1.5 倍）。
 * 面上是本机材质，读不到时是实例徽记。减少动画时只淡入淡出，没有位移、坐定与等待间隔。纯装饰，aria-hidden。
 */
export function AssemblingBlock({ instanceId, cover, placed, seated = false, exit = null, width = 28, enter = false, className }: AssemblingBlockProps) {
  const layout = isoLayout(width);
  const dpr = useDevicePixelRatio();
  const source = useBlockSource(cover);
  const reduced = useReducedMotionConfig() === true;
  const [scope, animate] = useAnimate<HTMLSpanElement>();

  const [shown, setShown] = useState<number>(enter ? 0 : placed);
  const lastDropAt = useRef(Number.NEGATIVE_INFINITY);
  // 入场时第一面最早的落位时刻：面先淡入、蓝图先出现，左面再落下
  const [firstDropAt] = useState(() => (enter ? performance.now() + assembly.firstDropMs : Number.NEGATIVE_INFINITY));
  const [seatStarted, setSeatStarted] = useState(seated && placed === 3);

  useEffect(() => {
    if (exit !== null) return;
    if (placed < shown) {
      setShown(placed);
      return;
    }
    if (placed === shown) return;
    const now = performance.now();
    const wait = reduced ? 0 : Math.max(0, lastDropAt.current + assembly.stepGapMs - now, firstDropAt - now);
    const timer = setTimeout(() => {
      lastDropAt.current = performance.now();
      setShown((s) => s + 1);
    }, wait);
    return () => clearTimeout(timer);
  }, [placed, shown, exit, reduced, firstDropAt]);

  useEffect(() => {
    if (!seated) {
      setSeatStarted(false);
      return;
    }
    if (exit !== null || shown < 3 || seatStarted) return;
    const wait = reduced ? 0 : Math.max(0, lastDropAt.current + assembly.seatDelayMs - performance.now());
    const timer = setTimeout(() => {
      setSeatStarted(true);
      if (!reduced && scope.current) void animate(scope.current, { scale: 1 }, { ...springs.base, velocity: assembly.seatVelocity });
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
        initial={enter ? { opacity: 0 } : false}
        animate={{ opacity: seatStarted ? 0 : 1 }}
        transition={seatStarted ? assembly.blueprintOut : fade.in}
      >
        <path d={blueprintPath(layout.width)} />
      </motion.svg>
      {FACE_ORDER.map((face, index) => {
        const real = source ? blockBitmap(source, layout, dpr, face) : null;
        const bitmap = real !== null ? real : emblemBitmap(instanceId, cover.hue, layout, dpr, face);
        const motionProps = faceMotion(face, index, shown, exit, reduced, layout.width);
        return (
          <motion.span key={face} className={styles.face} data-face={face} initial={false} animate={motionProps.animate} transition={motionProps.transition}>
            <BitmapCanvas bitmap={bitmap} cssWidth={layout.width} cssHeight={layout.canvasHeight} dpr={dpr} />
          </motion.span>
        );
      })}
    </span>
  );
}

/** 位移量（落位起点、崩落下坠）一律按方块边长 width 算，不按画布高度。 */
function faceMotion(face: IsoFace, index: number, shown: number, exit: AssemblyExit | null, reduced: boolean, width: number): { animate: TargetAndTransition; transition: Transition } {
  const [ox, oy] = assembly.dropOffset[face];
  const away = reduced ? { x: 0, y: 0 } : { x: ox * width, y: oy * width };
  if (index >= shown) return { animate: { ...away, opacity: 0 }, transition: fade.none };
  // 退场逆序：最后落下的顶面最先离开
  const order = shown - 1 - index;
  if (exit === "disassemble") {
    return { animate: { ...away, opacity: 0 }, transition: reduced ? fade.out : { ...assembly.disassemble, delay: order * assembly.disassembleGap } };
  }
  if (exit === "collapse") {
    return {
      animate: { x: 0, y: reduced ? 0 : assembly.collapseFall * width, opacity: 0 },
      transition: reduced ? fade.out : { ...assembly.collapse, delay: order * assembly.collapseGap },
    };
  }
  return {
    animate: { x: 0, y: 0, opacity: 1 },
    transition: reduced ? { opacity: assembly.reducedDropFade } : { ...springs.pop, opacity: assembly.dropFade },
  };
}
