import { motion, useAnimate, useIsPresent, useReducedMotionConfig, type TargetAndTransition, type Transition } from "framer-motion";
import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
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

/**
 * 组装此刻走到了哪（时刻都是 performance.now）。启动胶囊换面前要把旧面留到方块的拆解、崩落或坐定演完，
 * 留多久按它估算：落位数由启动阶段给出，但面是隔着落位间隔、入场后还要等首落延迟才一面面落下的，实际已落的面会晚于它。
 */
export interface AssemblyClock {
  /** 已落位的面数。 */
  shown: number;
  /** 最后一面开始落位的时刻；还没有面是落下来的（挂载时就在的面直接显示）为 -Infinity。 */
  lastDropAt: number;
  /** 入场时第一面最早的落位时刻；不是随新换上的面入场的为 -Infinity。 */
  firstDropAt: number;
}

/** 下一面最早在何时落位：不早于 now，与上一面隔一个落位间隔，且不早于入场的首落时刻。 */
function nextDropAt(lastDropAt: number, firstDropAt: number, now: number): number {
  return Math.max(now, lastDropAt + assembly.stepGapMs, firstDropAt);
}

/** 从 now 起把未落的面依次落齐、再等坐定延迟开始坐定，还要多少毫秒；早已能坐定则为 0。 */
export function assemblySeatInMs(clock: AssemblyClock, now: number): number {
  let last = clock.lastDropAt;
  for (let face = clock.shown; face < FACE_ORDER.length; face++) last = nextDropAt(last, clock.firstDropAt, now);
  return Math.max(0, last + assembly.seatDelayMs - now);
}

/** 已落的 faces 个面拆解或崩落演完要多少毫秒：逆序逐面错开一个间隔，最后一面再演一整段。一面未落时为 0。 */
export function assemblyExitMs(exit: AssemblyExit, faces: number): number {
  if (faces === 0) return 0;
  const [tween, gap] = exit === "disassemble" ? [assembly.disassemble, assembly.disassembleGap] : [assembly.collapse, assembly.collapseGap];
  return Math.round(((faces - 1) * gap + tween.duration) * 1000);
}

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
  /** 每次落下一面后写入组装进度（见 AssemblyClock）。所在的面正在退场时不再写：那时换上来的新面才是要估算的。 */
  clock?: RefObject<AssemblyClock | null>;
  className?: string;
}

/**
 * 启动胶囊左侧组装中的方块：虚线蓝图 + 三个独立的面层，几何与静态方块完全相同（竖棱 √1.5 倍）。
 * 面上是本机材质，读不到时是实例徽记。减少动画时只淡入淡出，没有位移、坐定与等待间隔。纯装饰，aria-hidden。
 */
export function AssemblingBlock({ instanceId, cover, placed, seated = false, exit = null, width = 28, enter = false, clock, className }: AssemblingBlockProps) {
  const layout = isoLayout(width);
  const dpr = useDevicePixelRatio();
  const source = useBlockSource(cover);
  const reduced = useReducedMotionConfig() === true;
  const present = useIsPresent();
  const [scope, animate] = useAnimate<HTMLSpanElement>();

  const [shown, setShown] = useState<number>(enter ? 0 : placed);
  const lastDropAt = useRef(Number.NEGATIVE_INFINITY);
  // 入场时第一面最早的落位时刻：面先淡入、蓝图先出现，左面再落下
  const [firstDropAt] = useState(() => (enter ? performance.now() + assembly.firstDropMs : Number.NEGATIVE_INFINITY));
  const [seatStarted, setSeatStarted] = useState(seated && placed === 3);

  useLayoutEffect(() => {
    if (clock === undefined || !present) return;
    clock.current = { shown, lastDropAt: lastDropAt.current, firstDropAt };
  }, [clock, present, shown, firstDropAt]);

  useEffect(() => {
    if (exit !== null) return;
    if (placed < shown) {
      setShown(placed);
      return;
    }
    if (placed === shown) return;
    const now = performance.now();
    const wait = reduced ? 0 : nextDropAt(lastDropAt.current, firstDropAt, now) - now;
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
