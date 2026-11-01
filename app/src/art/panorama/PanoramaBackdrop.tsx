import { motion } from "framer-motion";
import { useEffect, useRef } from "react";
import { fade } from "../../lib/motion";
import { cx } from "../../lib/util";
import { panoramaUrl, useArtStatus } from "../../mc/art";
import { useArt } from "../../mc/useArt";
import { coverRect, prepareDisplayCanvas, useDevicePixelRatio } from "../illustrations/canvas";
import styles from "./PanoramaBackdrop.module.css";

/** 焦点落在落日处：水平居中，竖直 46%。 */
const FOCUS_X = 0.5;
const FOCUS_Y = 0.46;
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
 */
export function PanoramaBackdrop({ enabled, className }: PanoramaBackdropProps) {
  const { panorama } = useArtStatus();
  const lastAvailable = useRef(panorama);
  useEffect(() => {
    if (enabled && lastAvailable.current && !panorama) console.warn("[art] 樱花林全景已不可用（游戏目录被删除或更换），背景回到无图状态");
    lastAvailable.current = panorama;
  }, [enabled, panorama]);

  const art = useArt(enabled && panorama ? panoramaUrl() : null);
  if (!enabled || !panorama || art.kind !== "ready") return null;
  return <PanoramaImage bitmap={art.bitmap} className={className} />;
}

function PanoramaImage({ bitmap, className }: { bitmap: ImageBitmap; className?: string }) {
  const rootRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const dpr = useDevicePixelRatio();

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
      animate={{ opacity: 1 }}
      transition={fade.in}
    >
      <canvas ref={canvasRef} className={styles.image} />
      <div className={styles.scrim} />
    </motion.div>
  );
}
