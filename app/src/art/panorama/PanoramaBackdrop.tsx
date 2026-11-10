import { AnimatePresence, motion, useReducedMotionConfig } from "framer-motion";
import { useEffect, useRef, useState } from "react";
import { ambientFade, fade } from "../../lib/motion";
import { cx } from "../../lib/util";
import { panoramaUrl, useArtStatus } from "../../mc/art";
import { peekArt, useArt } from "../../mc/useArt";
import { coverRect, prepareDisplayCanvas, useDevicePixelRatio } from "../illustrations/canvas";
import styles from "./PanoramaBackdrop.module.css";

/** 焦点落在落日处：水平居中，竖直 46%。 */
export const FOCUS_X = 0.5;
export const FOCUS_Y = 0.46;
/** 窗口尺寸变化时重绘的节流间隔：拖动窗口边框期间不逐帧重采样 1024 的大图。 */
export const PANORAMA_RESIZE_THROTTLE_MS = 300;

/** 樱花林全景在本机是否可用；外观设置据此决定开关是否禁用。 */
export function usePanoramaAvailable(): boolean {
  return useArtStatus().panorama;
}

export interface PanoramaBackdropProps {
  /** 外观设置里的「樱花林全景」开关。 */
  enabled: boolean;
  className?: string;
}

/**
 * 窗口背景层里的樱花林全景（默认关闭）：只用正面一张，等比铺满、焦点在落日，平滑缩放（它是渲染画面，
 * 不是像素材质），上面叠一层底色渐变罩，保证卡片外的文字可读。静态，不旋转、不视差。
 * 开关打开但本机没有全景对象时什么都不画（背景回到无图状态），不弹提示；开着时对象消失记一条 warn。
 * 显隐都是整层淡入淡出：关掉开关或对象消失时淡出后卸载，不是一帧硬切。
 */
export function PanoramaBackdrop({ enabled, className }: PanoramaBackdropProps) {
  const { panorama } = useArtStatus();
  const lastAvailable = useRef(panorama);
  useEffect(() => {
    if (enabled && lastAvailable.current && !panorama) console.warn("[art] 樱花林全景已不可用（游戏目录被删除或更换），背景回到无图状态");
    lastAvailable.current = panorama;
  }, [enabled, panorama]);

  const url = enabled && panorama ? panoramaUrl() : null;
  const art = useArt(url);
  // 装删游戏版本会换材质源、清空取图缓存，同一张全景要重新取图解码。这段时间留着上一张，新图到了直接换上，
  // 整窗背景不先消失再淡回来；重新取图失败（缓存里已落定为取不到）才放下旧图淡出。
  const [held, setHeld] = useState<ImageBitmap | null>(null);
  const bitmap = url === null ? null : art.kind === "ready" ? art.bitmap : peekArt(url) === undefined ? held : null;
  if (bitmap !== held) setHeld(bitmap);
  return <AnimatePresence>{bitmap !== null && <PanoramaImage key="panorama" bitmap={bitmap} className={className} />}</AnimatePresence>;
}

function PanoramaImage({ bitmap, className }: { bitmap: ImageBitmap; className?: string }) {
  const rootRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const dpr = useDevicePixelRatio();
  const reduced = useReducedMotionConfig() === true;

  useEffect(() => {
    const root = rootRef.current;
    const canvas = canvasRef.current;
    if (!root || !canvas) throw new Error("全景背景的节点尚未挂载");
    let timer: ReturnType<typeof setTimeout> | null = null;
    let pending = false;

    // 解码好的原图缩到窗口尺寸 × dpr 画进画布，之后只保留这一张窗口大小的位图在屏上
    const draw = () => {
      const { width, height } = root.getBoundingClientRect();
      if (width === 0 || height === 0) return;
      const ctx = prepareDisplayCanvas(canvas, width, height, dpr, true);
      const r = coverRect(bitmap.width, bitmap.height, canvas.width, canvas.height, FOCUS_X, FOCUS_Y);
      ctx.drawImage(bitmap, r.sx, r.sy, r.sw, r.sh, 0, 0, canvas.width, canvas.height);
    };
    // 首个变化立即重绘，节流窗口内的后续变化合并成窗口结束时的一次
    const schedule = () => {
      if (timer !== null) {
        pending = true;
        return;
      }
      draw();
      timer = setTimeout(() => {
        timer = null;
        if (pending) {
          pending = false;
          schedule();
        }
      }, PANORAMA_RESIZE_THROTTLE_MS);
    };

    const observer = new ResizeObserver(schedule);
    observer.observe(root);
    return () => {
      observer.disconnect();
      if (timer !== null) clearTimeout(timer);
    };
  }, [bitmap, dpr]);

  return (
    <motion.div
      ref={rootRef}
      className={cx(styles.backdrop, className)}
      data-sk-art="panorama"
      aria-hidden="true"
      initial={{ opacity: 0 }}
      // 减少动画只拦位移与缩放，透明度照常播：整窗的慢淡入在这里收回控件那一档
      animate={{ opacity: 1, transition: reduced ? fade.in : ambientFade.in }}
      exit={{ opacity: 0, transition: ambientFade.out }}
    >
      <canvas ref={canvasRef} className={styles.image} />
      <div className={styles.scrim} />
    </motion.div>
  );
}
