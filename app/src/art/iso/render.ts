// 等距方块的离屏绘制与位图缓存。三张面位图按左、右、顶的顺序用投影矩阵（再乘 dpr）画到一张
// W·dpr × ceil(H)·dpr 设备像素的画布上，最近邻采样；结果缓存成 ImageBitmap，LRU 上限 256 张。

import type { Rgb } from "../../mc/whitelist";
import { context2d, offscreen, pixelsToCanvas, readPixels, type Pixels } from "../illustrations/canvas";
import { FACE_SHADE, faceMatrices, type IsoFace, type IsoLayout } from "./geometry";
import { emblemPixels, resampleArea, shadePixels, tintPixels, validTextureSize } from "./pixels";

export type FaceSet = Readonly<Record<IsoFace, Pixels>>;

const DRAW_ORDER: readonly IsoFace[] = ["left", "right", "top"];

/** 真材质：染色 -> 明暗 -> 小尺寸档重采样到 n × n。 */
export function prepareFaces(top: Pixels, side: Pixels, topTint: Rgb | null, n: number): FaceSet {
  const fit = (p: Pixels) => (n === p.width ? p : resampleArea(p, n));
  const topBase = topTint ? tintPixels(top, topTint) : top;
  return {
    top: fit(shadePixels(topBase, FACE_SHADE.top)),
    left: fit(shadePixels(side, FACE_SHADE.left)),
    right: fit(shadePixels(side, FACE_SHADE.right)),
  };
}

/** 实例徽记：直接按 n × n 生成，三面同一张纹理，只差明暗。 */
export function emblemFaces(instanceId: string, hue: number, n: number): FaceSet {
  const base = emblemPixels(instanceId, hue, n);
  return {
    top: shadePixels(base, FACE_SHADE.top),
    left: shadePixels(base, FACE_SHADE.left),
    right: shadePixels(base, FACE_SHADE.right),
  };
}

/**
 * 画到离屏画布。相邻两面在共享棱处重叠 0.5 设备像素，内棱不露底色缝：
 * 右面向中竖棱一侧多画一点盖住左面边缘，顶面最后画并向两条下棱多画一点盖住侧面上缘。
 * only 只画其中一个面（组装动画里三个面是独立的层）。
 */
export function renderIso(faces: FaceSet, layout: IsoLayout, dpr: number, only?: IsoFace): ImageBitmap {
  const { n, k } = layout;
  const canvas = offscreen(Math.round(layout.width * dpr), Math.round(layout.canvasHeight * dpr));
  const ctx = context2d(canvas);
  ctx.imageSmoothingEnabled = false;
  const matrices = faceMatrices(n, k);
  const eps = 0.5 / (k * dpr);
  for (const face of DRAW_ORDER) {
    if (only !== undefined && face !== only) continue;
    const [a, b, c, d, e, f] = matrices[face];
    ctx.setTransform(a * dpr, b * dpr, c * dpr, d * dpr, e * dpr, f * dpr);
    const source = pixelsToCanvas(faces[face]);
    if (face === "left") ctx.drawImage(source, 0, 0, n, n, 0, 0, n, n);
    else if (face === "right") ctx.drawImage(source, 0, 0, n, n, -eps, 0, n + eps, n);
    else ctx.drawImage(source, 0, 0, n, n, 0, 0, n + eps, n + eps);
  }
  return canvas.transferToImageBitmap();
}

// ---------------------------------------------------------------- 缓存

/** 最近最少使用缓存：读取即刷新新旧顺序，超出上限丢最旧的一项。 */
export class LruCache<K, V> {
  private readonly map = new Map<K, V>();
  constructor(readonly limit: number) {
    if (!(limit > 0)) throw new Error(`缓存上限必须为正，实为 ${limit}`);
  }

  get(key: K): V | undefined {
    const value = this.map.get(key);
    if (value === undefined) return undefined;
    this.map.delete(key);
    this.map.set(key, value);
    return value;
  }

  set(key: K, value: V): void {
    this.map.delete(key);
    this.map.set(key, value);
    while (this.map.size > this.limit) {
      const oldest = this.map.keys().next().value as K;
      this.map.delete(oldest);
    }
  }

  get size(): number {
    return this.map.size;
  }

  keys(): K[] {
    return [...this.map.keys()];
  }
}

/** 尺寸不合规的材质（材质源版本 | 方块）：只记一次 warn，之后直接回落。 */
const invalidSources = new Set<string>();

// 被挤出的位图不主动 close：同一次提交里可能还有组件拿着它等待绘制，交给垃圾回收
const bitmaps = new LruCache<string, ImageBitmap>(256);

function cached(key: string, build: () => ImageBitmap): ImageBitmap {
  const hit = bitmaps.get(key);
  if (hit) return hit;
  const bitmap = build();
  bitmaps.set(key, bitmap);
  return bitmap;
}

/** 实例徽记方块，键为 实例 id | 色相 | 宽度 | dpr（| 单面）。 */
export function emblemBitmap(instanceId: string, hue: number, layout: IsoLayout, dpr: number, only?: IsoFace): ImageBitmap {
  return cached(`emblem|${instanceId}|${hue}|${layout.width}|${dpr}|${only ?? "all"}`, () => renderIso(emblemFaces(instanceId, hue, layout.n), layout, dpr, only));
}

export interface BlockSource {
  /** 材质源版本：换版本即换缓存键。 */
  versionId: string;
  coverId: string;
  topTint: Rgb | null;
  top: ImageBitmap;
  side: ImageBitmap;
}

/**
 * 真材质方块，键为 材质源版本 | 方块 | 宽度 | dpr（| 单面）。材质尺寸不合规时返回 null 并记 warn，
 * 调用方显示实例徽记。
 */
export function blockBitmap(source: BlockSource, layout: IsoLayout, dpr: number, only?: IsoFace): ImageBitmap | null {
  const sourceKey = `${source.versionId}|${source.coverId}`;
  if (invalidSources.has(sourceKey)) return null;
  for (const [name, bitmap] of [["顶面", source.top], ["侧面", source.side]] as const) {
    if (!validTextureSize(bitmap.width, bitmap.height)) {
      invalidSources.add(sourceKey);
      console.warn(`[art] ${source.coverId} 的${name}材质尺寸 ${bitmap.width}x${bitmap.height} 不是宽 16 的方块材质，改用实例徽记`);
      return null;
    }
  }
  return cached(`${source.versionId}|${source.coverId}|${layout.width}|${dpr}|${only ?? "all"}`, () =>
    renderIso(prepareFaces(readPixels(source.top, 0, 0, 16, 16), readPixels(source.side, 0, 0, 16, 16), source.topTint, layout.n), layout, dpr, only),
  );
}
