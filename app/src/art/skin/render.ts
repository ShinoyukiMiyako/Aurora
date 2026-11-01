// 皮肤与剪影的离屏绘制。每个皮肤像素放大为整数倍 CSS px 再乘 dpr，最近邻；
// 真皮肤按位图对象缓存（同一张皮肤在多处出现只画一次），剪影按色相缓存。
// 立绘是三维盒子的正交投影：每个面一次 setTransform 加 drawImage，和等距方块同一套办法。

import { blankPixels, context2d, offscreen, pixelsToCanvas, readPixels, type AnyContext, type Pixels } from "../illustrations/canvas";
import { silhouetteFigure, silhouetteHead, type SkinModel } from "../illustrations/silhouette";
import { shadePixels } from "../iso/pixels";
import { LruCache } from "../iso/render";
import { figureQuads, REST_POSE, type FigurePose, type SkinRect } from "./figure3d";
import { FACE_RECT, FIGURE_FRAME, FIGURE_FRAME_PAD, FIGURE_SIZE, HAT_RECT } from "./layout";

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

const skinPixels = new WeakMap<ImageBitmap, Pixels>();

function pixelsOf(bitmap: ImageBitmap): Pixels {
  let pixels = skinPixels.get(bitmap);
  if (!pixels) {
    pixels = readPixels(bitmap, 0, 0, bitmap.width, bitmap.height);
    skinPixels.set(bitmap, pixels);
  }
  return pixels;
}

function cropPixels(source: Pixels, { x, y, w, h }: SkinRect): Pixels {
  const out = blankPixels(w, h);
  for (let row = 0; row < h; row++) {
    const from = ((y + row) * source.width + x) * 4;
    out.data.set(source.data.subarray(from, from + w * 4), row * w * 4);
  }
  return out;
}

/**
 * 乘上亮度的一个面，单独成图。两处都不能图省事：
 * 外层有透明洞，不能画完再用 multiply 或 source-atop 压暗，洞后面已经画好的内容会跟着变暗；
 * 也不能直接从整张皮肤取片，Chromium 的 drawImage 不把采样夹在源矩形内，抗锯齿的边缘像素
 * 会读到贴图上相邻区域的颜色。整图作源时出界夹到自身边缘，和等距方块的每面一张图同理。
 * 亮度是量化过的，单张皮肤的面图数量有上限。
 */
function shadedFace(skin: LoadedSkin, rect: SkinRect, shade: number): OffscreenCanvas {
  return cachedForSkin(skin, `face3d|${rect.x},${rect.y},${rect.w},${rect.h}|${shade}`, () => pixelsToCanvas(shadePixels(cropPixels(pixelsOf(skin.bitmap), rect), shade)));
}

/**
 * 每个面向四周多画的设备像素数，共享棱不露底色缝，做法同等距方块的 eps。等距方块的棱角度固定，
 * 0.5 够用；这里的棱随 yaw 连续变化，棱上的像素两个面各盖一部分、抗锯齿合成后仍不满，
 * 实测 0.5 留下 alpha 约 243 的细缝，0.75 在每皮肤像素 4 到 9 个设备像素时转满一圈都没有。
 */
const SEAM_OVERLAP = 0.75;

/**
 * 按姿态把立绘画到 ctx 上，unit 是每皮肤像素的设备像素数；画布按 FIGURE_FRAME × unit 准备。
 * 各面的透视缩短不同，接缝重叠要按各自方向的放大率换算回贴图像素。
 */
export function paintSkinFigure(ctx: AnyContext, skin: LoadedSkin, pose: FigurePose, unit: number): void {
  for (const quad of figureQuads(skin.format, skin.model, skin.hat, pose)) {
    const [a, b, c, d, e, f] = quad.matrix;
    const { w, h } = quad.uv;
    const epsS = SEAM_OVERLAP / (Math.hypot(a, b) * unit);
    const epsT = SEAM_OVERLAP / (Math.hypot(c, d) * unit);
    ctx.setTransform(a * unit, b * unit, c * unit, d * unit, e * unit, f * unit);
    ctx.drawImage(shadedFace(skin, quad.uv, quad.shade), 0, 0, w, h, -epsS, -epsT, w + 2 * epsS, h + 2 * epsT);
  }
  ctx.setTransform(1, 0, 0, 1, 0, 0);
}

/** 默认姿态的立绘，外框大小。交互中的姿态不走这里，转动时每帧直接 paintSkinFigure。 */
export function skinFigureCanvas(skin: LoadedSkin, scale: number, dpr: number): OffscreenCanvas {
  return cachedForSkin(skin, `figure|${skin.format}|${skin.model}|${skin.hat}|${scale}|${dpr}`, () => {
    const { canvas, ctx } = canvasFor(FIGURE_FRAME.width * scale, FIGURE_FRAME.height * scale, dpr);
    paintSkinFigure(ctx, skin, REST_POSE, scale * dpr);
    return canvas;
  });
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

/** 剪影是 2D 的，放在外框中央的布局方框上，底边正好是脚底基线，和真皮肤交叉淡入时不跳动。 */
export function silhouetteFigureCanvas(hue: number, model: SkinModel, scale: number, dpr: number): OffscreenCanvas {
  return cachedSilhouette(`figure|${hue}|${model}|${scale}|${dpr}`, () => {
    const { canvas, ctx } = canvasFor(FIGURE_FRAME.width * scale, FIGURE_FRAME.height * scale, dpr);
    const pad = Math.round(FIGURE_FRAME_PAD * scale * dpr);
    ctx.drawImage(pixelsToCanvas(silhouetteFigure(hue, model)), 0, 0, FIGURE_SIZE.width, FIGURE_SIZE.height, pad, pad, canvas.width - 2 * pad, canvas.height - 2 * pad);
    return canvas;
  });
}
