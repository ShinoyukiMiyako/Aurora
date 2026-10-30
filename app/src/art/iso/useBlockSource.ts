import { artUrl, useArtStatus } from "../../mc/art";
import { coverTexture } from "../../mc/whitelist";
import { useArt } from "../../mc/useArt";
import type { InstanceCover } from "./covers";
import type { BlockSource } from "./render";

const warnedCovers = new Set<string>();

/**
 * 实例封面方块的真材质：本机有材质源、封面在白名单内、顶面与侧面都取到时给出，否则 null（画实例徽记）。
 * 白名单外的封面（旧数据、手改配置）只记一次 warn。
 */
export function useBlockSource(cover: InstanceCover): BlockSource | null {
  const status = useArtStatus();
  const texture = coverTexture(cover.block);
  if (!texture && !warnedCovers.has(cover.block)) {
    warnedCovers.add(cover.block);
    console.warn(`[art] 封面 ${cover.block} 不在封面白名单内，显示实例徽记`);
  }
  const top = useArt(texture ? artUrl(texture.top) : null);
  const side = useArt(texture ? artUrl(texture.side) : null);
  if (!texture || status.source === null || top.kind !== "ready" || side.kind !== "ready") return null;
  return { versionId: status.source.versionId, coverId: texture.id, topTint: texture.topTint, top: top.bitmap, side: side.bitmap };
}
