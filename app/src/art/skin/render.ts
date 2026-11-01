// 皮肤与剪影的离屏绘制。每个皮肤像素放大为整数倍 CSS px 再乘 dpr，最近邻；
// 真皮肤按位图对象缓存（同一张皮肤在多处出现只画一次），剪影按色相缓存。

import { context2d, offscreen, pixelsToCanvas } from "../illustrations/canvas";
import { silhouetteFigure, silhouetteHead, type SkinModel } from "../illustrations/silhouette";
import { LruCache } from "../iso/render";
import { FACE_RECT, figureLayers, FIGURE_SIZE, HAT_RECT, type FigureLayer } from "./layout";

export interface LoadedSkin {
  bitmap: ImageBitmap;
  format: "modern" | "legacy";
  /** 是否叠帽子层（外层全不透明且纯色的旧皮肤不叠，免得一整块色板盖住脸）。 */
  hat: boolean;
  model: SkinModel;
}

function canvasFor(cssWidth: number, cssHeight: number, dpr: number) {
  const canvas = offscreen(Math.round(cssWidth * dpr), Math.round(cssHeight * dpr));
  const ctx = context2d(canvas);
  ctx.imageSmoothingEnabled = false;
  return { canvas, ctx };
}

function paintFace(source: CanvasImageSource, hat: boolean, face: number, dpr: number): OffscreenCanvas {
  const { canvas, ctx } = canvasFor(face, face, dpr);
  ctx.drawImage(source, FACE_RECT.x, FACE_RECT.y, FACE_RECT.w, FACE_RECT.h, 0, 0, canvas.width, canvas.height);
  if (hat) ctx.drawImage(source, HAT_RECT.x, HAT_RECT.y, HAT_RECT.w, HAT_RECT.h, 0, 0, canvas.width, canvas.height);
  return canvas;
}

function paintFigure(source: CanvasImageSource, layers: readonly FigureLayer[], scale: number, dpr: number): OffscreenCanvas {
  const { canvas, ctx } = canvasFor(FIGURE_SIZE.width * scale, FIGURE_SIZE.height * scale, dpr);
  const unit = scale * dpr;
  for (const l of layers) {
    if (l.mirror) {
      ctx.save();
      ctx.translate((l.dx + l.w) * unit, 0);
      ctx.scale(-1, 1);
      ctx.drawImage(source, l.sx, l.sy, l.w, l.h, 0, l.dy * unit, l.w * unit, l.h * unit);
      ctx.restore();
    } else {
      ctx.drawImage(source, l.sx, l.sy, l.w, l.h, l.dx * unit, l.dy * unit, l.w * unit, l.h * unit);
    }
  }
  return canvas;
}

const skinRenders = new WeakMap<ImageBitmap, Map<string, OffscreenCanvas>>();

function cachedForSkin(skin: LoadedSkin, key: string, build: () => OffscreenCanvas): OffscreenCanvas {
  let renders = skinRenders.get(skin.bitmap);
  if (!renders) {
    renders = new Map();
    skinRenders.set(skin.bitmap, renders);
  }
  const hit = renders.get(key);
  if (hit) return hit;
  const canvas = build();
  renders.set(key, canvas);
  return canvas;
}

export function skinFaceCanvas(skin: LoadedSkin, face: number, dpr: number): OffscreenCanvas {
  return cachedForSkin(skin, `face|${face}|${dpr}|${skin.hat}`, () => paintFace(skin.bitmap, skin.hat, face, dpr));
}

export function skinFigureCanvas(skin: LoadedSkin, scale: number, dpr: number): OffscreenCanvas {
  return cachedForSkin(skin, `figure|${scale}|${dpr}|${skin.model}`, () => paintFigure(skin.bitmap, figureLayers(skin.model, skin.format), scale, dpr));
}

const silhouettes = new LruCache<string, OffscreenCanvas>(128);

function cachedSilhouette(key: string, build: () => OffscreenCanvas): OffscreenCanvas {
  const hit = silhouettes.get(key);
  if (hit) return hit;
  const canvas = build();
  silhouettes.set(key, canvas);
  return canvas;
}

export function silhouetteFaceCanvas(hue: number, face: number, dpr: number): OffscreenCanvas {
  return cachedSilhouette(`face|${hue}|${face}|${dpr}`, () => {
    const { canvas, ctx } = canvasFor(face, face, dpr);
    ctx.drawImage(pixelsToCanvas(silhouetteHead(hue)), 0, 0, 8, 8, 0, 0, canvas.width, canvas.height);
    return canvas;
  });
}

export function silhouetteFigureCanvas(hue: number, model: SkinModel, scale: number, dpr: number): OffscreenCanvas {
  return cachedSilhouette(`figure|${hue}|${model}|${scale}|${dpr}`, () => {
    const { canvas, ctx } = canvasFor(FIGURE_SIZE.width * scale, FIGURE_SIZE.height * scale, dpr);
    ctx.drawImage(pixelsToCanvas(silhouetteFigure(hue, model)), 0, 0, FIGURE_SIZE.width, FIGURE_SIZE.height, 0, 0, canvas.width, canvas.height);
    return canvas;
  });
}
