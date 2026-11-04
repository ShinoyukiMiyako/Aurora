import { useReducedMotionConfig } from "framer-motion";
import { useCallback, useLayoutEffect, useRef, type MouseEvent, type PointerEvent } from "react";
import { prepareDisplayCanvas } from "../illustrations/canvas";
import styles from "./AccountFigure.module.css";
import { REST_POSE, settleYaw } from "./figure3d";
import { FIGURE_FRAME } from "./layout";
import { paintSkinFigure, skinFigureCanvas, type LoadedSkin } from "./render";

/** 拖动一个 CSS px 转一度：手指扫过立绘宽度大约转半圈。 */
const RADIANS_PER_PX = Math.PI / 180;

/** 按下后横向移动到这个距离才算拖动：手抖的点击仍是点击，主页的立绘还要响应点按。 */
const DRAG_SLOP_PX = 4;

/** 松手后第一帧没有上一帧时刻可减，按 60 Hz 的一帧算。 */
const FIRST_FRAME_MS = 16;

interface Drag {
  pointerId: number;
  startX: number;
  startYaw: number;
  moved: boolean;
}

export interface SpinningFigureProps {
  skin: LoadedSkin;
  scale: number;
  dpr: number;
}

/**
 * 可拖动的立绘：拖动改 yaw，松手回到默认姿态。只在姿态变化时申请一帧，静止时没有循环；
 * 回到默认姿态后贴缓存的位图，不重算。立绘只是装饰，不进键盘焦点序列，也不是拖动窗口的把手。
 */
export function SpinningFigure({ skin, scale, dpr }: SpinningFigureProps) {
  const ref = useRef<HTMLCanvasElement>(null);
  const reduced = useReducedMotionConfig() === true;
  const yaw = useRef(REST_POSE.yaw);
  const drag = useRef<Drag | null>(null);
  const settling = useRef(false);
  const frame = useRef<number | null>(null);
  const lastTick = useRef<number | null>(null);
  const swallowClick = useRef(false);
  const cssWidth = FIGURE_FRAME.width * scale;
  const cssHeight = FIGURE_FRAME.height * scale;

  const paint = useCallback(() => {
    const canvas = ref.current;
    if (canvas === null) throw new Error("SpinningFigure 的 <canvas> 尚未挂载");
    const ctx = prepareDisplayCanvas(canvas, cssWidth, cssHeight, dpr, false);
    if (yaw.current === REST_POSE.yaw) ctx.drawImage(skinFigureCanvas(skin, scale, dpr), 0, 0);
    else paintSkinFigure(ctx, skin, { yaw: yaw.current, pitch: REST_POSE.pitch }, scale * dpr);
  }, [cssWidth, cssHeight, dpr, scale, skin]);

  const cancelFrame = () => {
    if (frame.current !== null) cancelAnimationFrame(frame.current);
    frame.current = null;
  };

  useLayoutEffect(() => {
    yaw.current = REST_POSE.yaw;
    drag.current = null;
    settling.current = false;
    paint();
    return cancelFrame;
  }, [paint]);

  const tick = (now: number) => {
    frame.current = null;
    if (settling.current) {
      const elapsed = lastTick.current === null ? FIRST_FRAME_MS : now - lastTick.current;
      lastTick.current = now;
      yaw.current = settleYaw(yaw.current, REST_POSE.yaw, elapsed);
      settling.current = yaw.current !== REST_POSE.yaw;
    }
    paint();
    if (settling.current) requestPaint();
  };

  const requestPaint = () => {
    if (frame.current === null) frame.current = requestAnimationFrame(tick);
  };

  const onPointerDown = (e: PointerEvent<HTMLCanvasElement>) => {
    if (e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    settling.current = false;
    swallowClick.current = false;
    drag.current = { pointerId: e.pointerId, startX: e.clientX, startYaw: yaw.current, moved: false };
  };

  const onPointerMove = (e: PointerEvent<HTMLCanvasElement>) => {
    const active = drag.current;
    if (active === null || e.pointerId !== active.pointerId) return;
    const dx = e.clientX - active.startX;
    if (!active.moved && Math.abs(dx) < DRAG_SLOP_PX) return;
    active.moved = true;
    swallowClick.current = true;
    yaw.current = active.startYaw + dx * RADIANS_PER_PX;
    requestPaint();
  };

  const release = (e: PointerEvent<HTMLCanvasElement>) => {
    const active = drag.current;
    if (active === null || e.pointerId !== active.pointerId) return;
    drag.current = null;
    // 回位途中按住又原地松手时没有移动过，姿态却不在默认位上，同样要回位
    if (yaw.current === REST_POSE.yaw) return;
    if (reduced) {
      yaw.current = REST_POSE.yaw;
      cancelFrame();
      paint();
      return;
    }
    settling.current = true;
    lastTick.current = null;
    requestPaint();
  };

  // 主页的立绘在「管理账户」按钮里：拖完松手产生的 click 不能算点按钮
  const onClickCapture = (e: MouseEvent<HTMLCanvasElement>) => {
    if (!swallowClick.current) return;
    swallowClick.current = false;
    e.preventDefault();
    e.stopPropagation();
  };

  return (
    <canvas
      ref={ref}
      className={styles.spin}
      style={{ width: cssWidth, height: cssHeight }}
      aria-hidden="true"
      data-tauri-drag-region="false"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={release}
      onPointerCancel={release}
      onLostPointerCapture={release}
      onClickCapture={onClickCapture}
    />
  );
}
