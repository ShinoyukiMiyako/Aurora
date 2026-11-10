import { useLayoutEffect, useRef, useState, type AnimationEvent } from "react";
import { coverRect, prepareDisplayCanvas, useDevicePixelRatio } from "../art/illustrations/canvas";
import { Icon, type IconName } from "../art/Icon";
import { cssVars, cx } from "../lib/util";
import { useNearViewport, useRemoteImage } from "./remote-image";
import styles from "./Thumb.module.css";

export type ThumbKind = "mod" | "modpack" | "resourcepack" | "shader" | "datapack" | "news" | "server";
export type ThumbSize = 32 | 40 | 44 | 48 | 64 | 96;

/** 无图与失败时底座上的类型图标。 */
export const THUMB_KIND_ICON: Readonly<Record<ThumbKind, IconName>> = {
  mod: "mod",
  modpack: "modpack",
  resourcepack: "resource-pack",
  shader: "shader",
  datapack: "datapack",
  news: "news",
  server: "server",
};

/** 比例圆角 round(边长 × 0.3)。 */
export const THUMB_RADIUS: Readonly<Record<ThumbSize, number>> = { 32: 10, 40: 12, 44: 13, 48: 14, 64: 19, 96: 29 };

/** 图块内图标档位：边长 ≤ 32 用 16，33-48 用 20，更大用 24。 */
export function thumbIconSize(size: ThumbSize): 16 | 20 | 24 {
  return size <= 32 ? 16 : size <= 48 ? 20 : 24;
}

/**
 * 像素风图标判定：源图为不超过 64 的正方形，且显示边长是源边长的 2 倍及以上整数倍时最近邻放大，
 * 其余一律平滑缩放（非整数倍的最近邻会让像素宽窄不一）。
 */
export function isPixelArtThumb(naturalWidth: number, naturalHeight: number, size: number): boolean {
  if (naturalWidth !== naturalHeight || naturalWidth > 64 || naturalWidth <= 0) return false;
  const ratio = size / naturalWidth;
  return Number.isInteger(ratio) && ratio >= 2;
}

export interface ThumbProps {
  /** 平台给出的原始图片地址；null 表示没有图。 */
  url: string | null;
  /** 决定回落图标。 */
  kind: ThumbKind;
  /** 回落底座的色相：资源自带色相，缺失时由项目 id 推出。 */
  hue: number;
  size: ThumbSize;
  /** 单独出现（旁边没有名称）时的可访问名称，即资源名；不传则 aria-hidden。 */
  alt?: string;
  /** 内容失效（停用的 Mod）：灰度并半透明。 */
  inactive?: boolean;
  className?: string;
}

/**
 * 远程缩略图：资源平台的项目图标、官方资讯缩略图、服务器自带图标。加载中为同形骨架；
 * 无图或失败时为色相底座 + 类型图标，不显示裂图、不用名称首字。进入视口前 200 px 才开始加载，
 * 在那之前只是静止的占位：一页结果里视口外的图可能一直不加载，带上扫光就是几十个看不见的循环动画常驻 CPU。
 */
export function Thumb({ url, kind, hue, size, alt, inactive = false, className }: ThumbProps) {
  const ref = useRef<HTMLSpanElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const dpr = useDevicePixelRatio();
  const near = useNearViewport(ref);
  const image = useRemoteImage(url, near, Math.ceil(size * dpr * 2));
  const view = url === null || image.status === "failed" ? "fallback" : image.status === "ready" ? "image" : near ? "loading" : "pending";
  const pixel = image.status === "ready" && isPixelArtThumb(image.naturalWidth, image.naturalHeight, size);
  // 光带离开加载态（图到了或失败）后停在原处淡出，不同帧消失：见过加载态就一直标着，淡完才摘掉，
  // 循环动画随标记一起移除。没进过加载态的（本来就没有图、视口外）从头到尾没有光带。
  // 淡出用动画而不用过渡：加载态只停了不到一帧时光带还没算过样式，过渡起不来，也就等不到结束事件
  const [shimmered, setShimmered] = useState(false);
  if (view === "loading" && !shimmered) setShimmered(true);
  const shimmer = view === "loading" ? "run" : shimmered ? "fading" : undefined;
  const onAnimationEnd =
    shimmer === "fading"
      ? (event: AnimationEvent<HTMLSpanElement>) => {
          // 光带的循环动画不会结束，::before 上结束的只有淡出；图片与图标的淡入在子元素上，不算
          if (event.target === event.currentTarget && event.pseudoElement === "::before") setShimmered(false);
        }
      : undefined;

  useLayoutEffect(() => {
    if (image.status !== "ready") return;
    const canvas = canvasRef.current;
    if (!canvas) throw new Error("缩略图的 <canvas> 尚未挂载");
    const ctx = prepareDisplayCanvas(canvas, size, size, dpr, !pixel);
    const { bitmap } = image;
    if (pixel) {
      ctx.drawImage(bitmap, 0, 0, bitmap.width, bitmap.height, 0, 0, canvas.width, canvas.height);
    } else {
      const r = coverRect(bitmap.width, bitmap.height, canvas.width, canvas.height);
      ctx.drawImage(bitmap, r.sx, r.sy, r.sw, r.sh, 0, 0, canvas.width, canvas.height);
    }
  }, [image, size, dpr, pixel]);

  return (
    <span
      ref={ref}
      className={cx(styles.thumb, className)}
      style={{ width: size, height: size, borderRadius: THUMB_RADIUS[size], ...cssVars({ "--hue": hue }) }}
      data-view={view}
      data-shimmer={shimmer}
      onAnimationEnd={onAnimationEnd}
      data-inactive={inactive || undefined}
      role={alt === undefined ? undefined : "img"}
      aria-label={alt}
      aria-hidden={alt === undefined ? true : undefined}
    >
      {view === "image" && <canvas ref={canvasRef} className={styles.image} data-pixel={pixel || undefined} />}
      {/* 加载失败才落到回落图形时，图标淡入；本来就没有图的一开始就是回落图形，跟着所在页面的入场走 */}
      {view === "fallback" && <Icon name={THUMB_KIND_ICON[kind]} size={thumbIconSize(size)} className={image.status === "failed" ? styles.late : undefined} />}
    </span>
  );
}
