import { useState } from "react";
import { artUrl, useArtStatus } from "../../mc/art";
import { useBlockCatalog, type BlockCatalog } from "../../mc/catalog";
import { peekArt, useArt } from "../../mc/useArt";
import { coverTexture, type Rgb } from "../../mc/whitelist";
import type { InstanceCover } from "./covers";
import { validTextureSize } from "./pixels";
import type { BlockSource } from "./render";

interface BlockFaces {
  top: string;
  side: string;
  front: string | null;
  topTint: Rgb | null;
  sideTint: Rgb | null;
}

const warnedBlocks = new Set<string>();

/**
 * 方块 id 对应的面与染色。预设按预设表（目录没载入、降级材质源里也能画）；其余查方块目录，
 * 目录须出自当前材质源：换材质源后新目录到达之前，旧目录的面与染色不能记到新版本的缓存键下。
 */
function blockFaces(block: string, versionId: string, catalog: BlockCatalog | null): BlockFaces | null {
  const preset = coverTexture(block);
  if (preset !== undefined) return { top: preset.top, side: preset.side, front: null, topTint: preset.topTint, sideTint: null };
  if (catalog === null || catalog.versionId !== versionId) return null;
  const listed = catalog.byId.get(block);
  if (listed !== undefined) return listed;
  const key = `${versionId}|${block}`;
  if (!warnedBlocks.has(key)) {
    warnedBlocks.add(key);
    console.warn(`[art] 封面方块 ${block} 不在预设里，也不在材质源 ${versionId} 的方块目录里，显示实例徽记`);
  }
  return null;
}

const warnedImages = new Set<string>();

/**
 * 玩家图片的尺寸合不合方块材质。导入时已重采样成 16 × 16，不合规的是手放或损坏的文件：下游按不合规直接画徽记或渐变，
 * 所以在这里就按读不到处理，好退回方块 id 的材质；同一张图只警告一次。
 */
function imageFits(url: string, bitmap: ImageBitmap): boolean {
  if (validTextureSize(bitmap.width, bitmap.height)) return true;
  if (!warnedImages.has(url)) {
    warnedImages.add(url);
    console.warn(`[art] 封面图片 ${url} 的尺寸 ${bitmap.width}x${bitmap.height} 不是宽 16 的方块材质，按读不到处理，改用封面方块的材质`);
  }
  return false;
}

/**
 * 实例封面方块的真材质，读不到时为 null（画实例徽记）。顺序：
 * 1. 有玩家图片时取图片（16 × 16），三面同一张、不染色；图片不依赖本机材质源。
 * 2. 没有图片、图片读不到或尺寸不合规时，按方块 id 取本机材质：顶面、侧面（有正面的连正面）都取到才算。
 * 图片还在取时不取方块材质，免得先闪一下方块再换成图片。cover 为 null（调用方这次不画方块）时恒为 null，不发请求。
 * 换了来源（换封面方块、换图片、材质源变了）而新图还在取的这段时间先给上一份已就绪的，到了再换：
 * 不中途落回徽记，旧材质与新材质之间是一次交叉淡化（来源标识 key 变了），而不是材质、徽记、材质闪两下。新图取不到才回落徽记。
 */
export function useBlockSource(cover: InstanceCover | null): BlockSource | null {
  const { source, waiting } = useLoadedSource(cover);
  const [held, setHeld] = useState<BlockSource | null>(source);
  // 按来源标识比：每次渲染给的都是新对象，按引用比会每次都存、反复重渲染
  if (source !== null && (held === null || held.key !== source.key)) setHeld(source);
  if (source === null && !waiting && held !== null) setHeld(null);
  if (source !== null) return source;
  return waiting ? held : null;
}

/** 此刻已就绪的材质，以及还有没有图在取（取图缓存里既没有成功也没有失败）。 */
function useLoadedSource(cover: InstanceCover | null): { source: BlockSource | null; waiting: boolean } {
  const status = useArtStatus();
  const catalog = useBlockCatalog();
  const imageUrl = cover?.image ?? null;
  const image = useArt(imageUrl);
  const versionId = status.source?.versionId ?? null;
  const imageBitmap = imageUrl !== null && image.kind === "ready" && imageFits(imageUrl, image.bitmap) ? image.bitmap : null;
  // 取图失败的结果会缓存下来：useArt 给 missing 而缓存里已有定论，就是读不到；缓存里没有则还在取
  const wantBlock = imageUrl === null || peekArt(imageUrl)?.kind === "missing" || (image.kind === "ready" && imageBitmap === null);
  const faces = cover !== null && wantBlock && versionId !== null ? blockFaces(cover.block, versionId, catalog) : null;
  const topUrl = faces ? artUrl(faces.top) : null;
  const sideUrl = faces ? artUrl(faces.side) : null;
  const frontUrl = faces?.front ? artUrl(faces.front) : null;
  const top = useArt(topUrl);
  const side = useArt(sideUrl);
  const front = useArt(frontUrl);
  const waiting = [imageUrl, topUrl, sideUrl, frontUrl].some((url) => url !== null && peekArt(url) === undefined);

  if (imageUrl !== null && imageBitmap !== null) {
    return { source: { key: `image|${imageUrl}`, top: imageBitmap, side: imageBitmap, front: null, topTint: null, sideTint: null }, waiting };
  }
  if (cover === null || faces === null || top.kind !== "ready" || side.kind !== "ready") return { source: null, waiting };
  if (faces.front !== null && front.kind !== "ready") return { source: null, waiting };
  return {
    source: {
      key: `block|${versionId}|${cover.block}`,
      top: top.bitmap,
      side: side.bitmap,
      front: front.kind === "ready" ? front.bitmap : null,
      topTint: faces.topTint,
      sideTint: faces.sideTint,
    },
    waiting,
  };
}
