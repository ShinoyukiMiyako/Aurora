// 像素画与远程图共用的 Canvas 工具：设备像素比、离屏画布、逐像素读写、按 cover 规则裁切。

import { useSyncExternalStore } from "react";

// ---------------------------------------------------------------- 设备像素比

/**
 * 当前设备像素比。窗口拖到另一块缩放不同的屏幕时 dpr 会变，像素画要按新 dpr 重新生成，
 * 否则在新屏幕上会被浏览器二次缩放而发糊。用「当前 dpr 的分辨率查询不再匹配」作为变化信号。
 */
export function useDevicePixelRatio(): number {
  return useSyncExternalStore(subscribeDpr, readDpr, readDpr);
}

function readDpr(): number {
  return window.devicePixelRatio;
}

function subscribeDpr(onChange: () => void): () => void {
  let query: MediaQueryList | null = null;
  const listen = () => {
    query?.removeEventListener("change", handle);
    query = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
    query.addEventListener("change", handle);
  };
  const handle = () => {
    listen();
    onChange();
  };
  listen();
  return () => query?.removeEventListener("change", handle);
}

// ---------------------------------------------------------------- 画布

export type AnyCanvas = HTMLCanvasElement | OffscreenCanvas;
export type AnyContext = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

/** 离屏画布：生成缓存位图与读取像素用，不进文档。 */
export function offscreen(width: number, height: number): OffscreenCanvas {
  if (typeof OffscreenCanvas === "undefined") throw new Error("当前环境没有 OffscreenCanvas，无法生成像素画");
  return new OffscreenCanvas(width, height);
}

export function context2d(canvas: HTMLCanvasElement): CanvasRenderingContext2D;
export function context2d(canvas: OffscreenCanvas): OffscreenCanvasRenderingContext2D;
export function context2d(canvas: AnyCanvas): AnyContext {
  const ctx = canvas.getContext("2d") as AnyContext | null;
  if (ctx === null) throw new Error("无法取得 Canvas 2D 上下文");
  return ctx;
}

export interface Pixels {
  width: number;
  height: number;
  /** RGBA，行优先，每像素 4 字节。 */
  data: Uint8ClampedArray;
}

export function blankPixels(width: number, height: number): Pixels {
  return { width, height, data: new Uint8ClampedArray(width * height * 4) };
}

/** 读出位图某一区域的原始像素（不缩放、不平滑）。 */
export function readPixels(source: CanvasImageSource, sx: number, sy: number, width: number, height: number): Pixels {
  const canvas = offscreen(width, height);
  const ctx = context2d(canvas);
  ctx.drawImage(source, sx, sy, width, height, 0, 0, width, height);
  return { width, height, data: ctx.getImageData(0, 0, width, height).data };
}

/** 把像素写进一张同尺寸的离屏画布，供 drawImage 使用。 */
export function pixelsToCanvas(pixels: Pixels): OffscreenCanvas {
  const canvas = offscreen(pixels.width, pixels.height);
  const image = new ImageData(pixels.width, pixels.height);
  image.data.set(pixels.data);
  context2d(canvas).putImageData(image, 0, 0);
  return canvas;
}

/**
 * 把显示用的 <canvas> 调到 CSS 尺寸 × dpr 的设备像素，返回关闭了平滑的上下文。
 * CSS 尺寸由样式决定，这里只管位图分辨率。
 */
export function prepareDisplayCanvas(canvas: HTMLCanvasElement, cssWidth: number, cssHeight: number, dpr: number, smooth: boolean): CanvasRenderingContext2D {
  const width = Math.max(1, Math.round(cssWidth * dpr));
  const height = Math.max(1, Math.round(cssHeight * dpr));
  if (canvas.width !== width) canvas.width = width;
  if (canvas.height !== height) canvas.height = height;
  const ctx = context2d(canvas);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, width, height);
  ctx.imageSmoothingEnabled = smooth;
  if (smooth) ctx.imageSmoothingQuality = "high";
  return ctx;
}

// ---------------------------------------------------------------- 裁切

export interface SourceRect {
  sx: number;
  sy: number;
  sw: number;
  sh: number;
}

/**
 * object-fit: cover 的源区域：等比放大到盖满目标框，多出的部分按焦点 (fx, fy) 裁掉。
 * fx、fy 为 0-1，0.5 即居中。
 */
export function coverRect(srcWidth: number, srcHeight: number, dstWidth: number, dstHeight: number, fx = 0.5, fy = 0.5): SourceRect {
  if (srcWidth <= 0 || srcHeight <= 0 || dstWidth <= 0 || dstHeight <= 0) {
    throw new Error(`裁切尺寸必须为正：源 ${srcWidth}x${srcHeight}，目标 ${dstWidth}x${dstHeight}`);
  }
  const scale = Math.max(dstWidth / srcWidth, dstHeight / srcHeight);
  const sw = dstWidth / scale;
  const sh = dstHeight / scale;
  return { sx: (srcWidth - sw) * fx, sy: (srcHeight - sh) * fy, sw, sh };
}
