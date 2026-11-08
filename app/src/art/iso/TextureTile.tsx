// 卡面背景的方块材质平铺：封面方块的侧面 16 × 16，侧面染色先乘进像素，每个材质像素放大成 8 css px，
// 最近邻平铺满画布。材质位图只能在这里取（原版材质取址限在 art/iso），卡面只拿到画好的一格与画布组件。

import { useLayoutEffect, useRef } from "react";
import { pixelsToCanvas, prepareDisplayCanvas, readPixels, useDevicePixelRatio } from "../illustrations/canvas";
import type { InstanceCover } from "./covers";
import { tintPixels, validTextureSize } from "./pixels";
import { LruCache } from "./render";
import { useBlockSource } from "./useBlockSource";

/** 一格材质的边长（材质像素）。 */
const TILE_TEXELS = 16;
/** 每个材质像素在卡面上的 CSS 尺寸。 */
export const TILE_TEXEL_CSS_PX = 8;

type TileSource = Pick<NonNullable<ReturnType<typeof useBlockSource>>, "key" | "side" | "sideTint">;

// 一格只有 16 × 16，按材质键缓存；卡面重挂、换宽度都不必重新读像素与染色
const faces = new LruCache<string, ImageBitmap>(64);
/** 尺寸不合规的材质：只记一次 warn，之后直接回落。 */
const invalidFaces = new Set<string>();

/**
 * 平铺用的一格：侧面首帧 16 × 16，有侧面染色时乘好（树叶这类四面都染的方块，不染就是一块灰板）。
 * 侧面不是宽 16 的方块材质时返回 null 并只记一次 warn，卡面画 art 形态。
 */
export function tileFace(source: TileSource): ImageBitmap | null {
  const hit = faces.get(source.key);
  if (hit) return hit;
  if (invalidFaces.has(source.key)) return null;
  if (!validTextureSize(source.side.width, source.side.height)) {
    invalidFaces.add(source.key);
    console.warn(`[art] ${source.key} 的侧面材质尺寸 ${source.side.width}x${source.side.height} 不是宽 16 的方块材质，卡面改画渐变花瓣`);
    return null;
  }
  const side = readPixels(source.side, 0, 0, TILE_TEXELS, TILE_TEXELS);
  const face = pixelsToCanvas(source.sideTint ? tintPixels(side, source.sideTint) : side).transferToImageBitmap();
  faces.set(source.key, face);
  return face;
}

/** 封面方块的平铺格；cover 为 null（这张卡面不平铺）或读不到这块方块的材质时为 null。 */
export function useTextureTile(cover: InstanceCover | null): ImageBitmap | null {
  const source = useBlockSource(cover);
  return source === null ? null : tileFace(source);
}

/**
 * 一个材质像素占的设备像素：8 css px × dpr 再取整。dpr 1.1 这类非整数倍时不取整，最近邻放大出来的像素格会宽窄不一；
 * 取整后每格等宽，代价是格子比 8 css px 差不到半个设备像素。
 */
export function tileTexelDevicePx(dpr: number): number {
  return Math.max(1, Math.round(TILE_TEXEL_CSS_PX * dpr));
}

export interface TextureTileProps {
  face: ImageBitmap;
  /** 画布的 CSS 尺寸；平铺从左上角起铺，铺满为止。 */
  width: number;
  height: number;
  className?: string;
}

/** 平铺层：纯装饰，aria-hidden。位置、模糊与位移由调用方的样式负责。 */
export function TextureTile({ face, width, height, className }: TextureTileProps) {
  const ref = useRef<HTMLCanvasElement>(null);
  const dpr = useDevicePixelRatio();

  useLayoutEffect(() => {
    const canvas = ref.current;
    if (!canvas) throw new Error("材质平铺的 <canvas> 尚未挂载");
    const ctx = prepareDisplayCanvas(canvas, width, height, dpr, false);
    const step = TILE_TEXELS * tileTexelDevicePx(dpr);
    for (let y = 0; y < canvas.height; y += step) {
      for (let x = 0; x < canvas.width; x += step) ctx.drawImage(face, 0, 0, TILE_TEXELS, TILE_TEXELS, x, y, step, step);
    }
  }, [face, width, height, dpr]);

  return <canvas ref={ref} className={className} style={{ width, height }} aria-hidden="true" />;
}
