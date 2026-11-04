// 等距方块的离屏绘制与位图缓存。三张面位图按左、右、顶的顺序用投影矩阵（再乘 dpr）画到一张
// W·dpr × ceil(H)·dpr 设备像素的画布上，最近邻采样；结果缓存成 ImageBitmap，LRU 上限 256 张。

import type { Rgb } from "../../mc/whitelist";
import { context2d, offscreen, pixelsToCanvas, readPixels, type Pixels } from "../illustrations/canvas";
import { FACE_SHADE, faceMatrices, type IsoFace, type IsoLayout } from "./geometry";
import { emblemPixels, resampleArea, shadePixels, tintPixels, validTextureSize } from "./pixels";

export type FaceSet = Readonly<Record<IsoFace, Pixels>>;

const DRAW_ORDER: readonly IsoFace[] = ["left", "right", "top"];

/** 一块方块三类面的原始像素（16 × 16）与染色。 */
export interface FacePixels {
  top: Pixels;
  side: Pixels;
  /** 有朝向的方块（熔炉等）的正面；没有时左面也画侧面。 */
  front: Pixels | null;
  topTint: Rgb | null;
  /** 侧面与正面共用的乘色（树叶）。 */
  sideTint: Rgb | null;
}

/** 真材质：染色 -> 明暗 -> 小尺寸档重采样到 n × n。有正面时画在左面，右面仍是侧面。 */
export function prepareFaces(faces: FacePixels, n: number): FaceSet {
  const fit = (p: Pixels) => (n === p.width ? p : resampleArea(p, n));
  const tinted = (p: Pixels, tint: Rgb | null) => (tint ? tintPixels(p, tint) : p);
  const side = tinted(faces.side, faces.sideTint);
  const front = faces.front ? tinted(faces.front, faces.sideTint) : side;
  return {
    top: fit(shadePixels(tinted(faces.top, faces.topTint), FACE_SHADE.top)),
    left: fit(shadePixels(front, FACE_SHADE.left)),
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

/** 尺寸不合规的方块来源（按来源键）：只记一次 warn，之后直接回落。 */
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
  /**
   * 来源键：本机材质为 block|材质源版本|方块 id，玩家图片为 image|协议地址（文件名带内容哈希，换图即换地址）。
   * 同一个键必须对应同样的面与染色，位图缓存靠它命中。
   */
  key: string;
  top: ImageBitmap;
  side: ImageBitmap;
  /** 正面，画在等距方块的左面；没有为 null。 */
  front: ImageBitmap | null;
  topTint: Rgb | null;
  /** 侧面与正面的乘色。 */
  sideTint: Rgb | null;
}

/**
 * 真材质方块，键为 来源键 | 宽度 | dpr（| 单面）。材质尺寸不合规时返回 null 并记 warn，
 * 调用方显示实例徽记。
 */
export function blockBitmap(source: BlockSource, layout: IsoLayout, dpr: number, only?: IsoFace): ImageBitmap | null {
  if (invalidSources.has(source.key)) return null;
  for (const [name, bitmap] of [["顶面", source.top], ["侧面", source.side], ["正面", source.front]] as const) {
    if (bitmap !== null && !validTextureSize(bitmap.width, bitmap.height)) {
      invalidSources.add(source.key);
      console.warn(`[art] ${source.key} 的${name}材质尺寸 ${bitmap.width}x${bitmap.height} 不是宽 16 的方块材质，改用实例徽记`);
      return null;
    }
  }
  const read = (bitmap: ImageBitmap) => readPixels(bitmap, 0, 0, 16, 16);
  return cached(`${source.key}|${layout.width}|${dpr}|${only ?? "all"}`, () =>
    renderIso(
      prepareFaces({ top: read(source.top), side: read(source.side), front: source.front === null ? null : read(source.front), topTint: source.topTint, sideTint: source.sideTint }, layout.n),
      layout,
      dpr,
      only,
    ),
  );
}
