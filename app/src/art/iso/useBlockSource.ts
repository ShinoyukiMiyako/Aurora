import { artUrl, useArtStatus } from "../../mc/art";
import { useBlockCatalog, type BlockCatalog } from "../../mc/catalog";
import { peekArt, useArt } from "../../mc/useArt";
import { coverTexture, type Rgb } from "../../mc/whitelist";
import type { InstanceCover } from "./covers";
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

/**
 * 实例封面方块的真材质，读不到时为 null（画实例徽记）。顺序：
 * 1. 有玩家图片时取图片（16 × 16），三面同一张、不染色；图片不依赖本机材质源。
 * 2. 没有图片或图片读不到时，按方块 id 取本机材质：顶面、侧面（有正面的连正面）都取到才算。
 * 图片还在取时不取方块材质，免得先闪一下方块再换成图片。cover 为 null（调用方这次不画方块）时恒为 null，不发请求。
 */
export function useBlockSource(cover: InstanceCover | null): BlockSource | null {
  const status = useArtStatus();
  const catalog = useBlockCatalog();
  const imageUrl = cover?.image ?? null;
  const image = useArt(imageUrl);
  const versionId = status.source?.versionId ?? null;
  // 取图失败的结果会缓存下来：useArt 给 missing 而缓存里已有定论，就是读不到；缓存里没有则还在取
  const wantBlock = imageUrl === null || peekArt(imageUrl)?.kind === "missing";
  const faces = cover !== null && wantBlock && versionId !== null ? blockFaces(cover.block, versionId, catalog) : null;
  const top = useArt(faces ? artUrl(faces.top) : null);
  const side = useArt(faces ? artUrl(faces.side) : null);
  const front = useArt(faces?.front ? artUrl(faces.front) : null);

  if (imageUrl !== null && image.kind === "ready") {
    return { key: `image|${imageUrl}`, top: image.bitmap, side: image.bitmap, front: null, topTint: null, sideTint: null };
  }
  if (cover === null || faces === null || top.kind !== "ready" || side.kind !== "ready") return null;
  if (faces.front !== null && front.kind !== "ready") return null;
  return {
    key: `block|${versionId}|${cover.block}`,
    top: top.bitmap,
    side: side.bitmap,
    front: front.kind === "ready" ? front.bitmap : null,
    topTint: faces.topTint,
    sideTint: faces.sideTint,
  };
}
