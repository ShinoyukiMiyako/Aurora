import { artUrl, skinUrl, useArtStatus } from "../../mc/art";
import { useArt } from "../../mc/useArt";
import { skinFormat, type SkinRef } from "./layout";
import type { LoadedSkin } from "./render";

const warnedSizes = new Set<string>();

/**
 * 取皮肤位图：远程皮肤按缓存键走协议的 /skin/，默认皮肤按白名单路径走 /art/（本机没有材质源时不发请求）。
 * 取不到或尺寸不是 64 × 64 / 64 × 32 时返回 null，调用方显示剪影。
 */
export function useSkin(skin: SkinRef | null): LoadedSkin | null {
  // 订阅材质状态：默认皮肤的地址随材质源变化
  useArtStatus();
  const url = skin === null ? null : skin.kind === "remote" ? skinUrl(skin.sha1) : artUrl(skin.path);
  const art = useArt(url);
  if (skin === null || url === null || art.kind !== "ready") return null;
  const format = skinFormat(art.bitmap.width, art.bitmap.height);
  if (format === null) {
    if (!warnedSizes.has(url)) {
      warnedSizes.add(url);
      console.warn(`[art] 皮肤尺寸 ${art.bitmap.width}x${art.bitmap.height} 不是 64x64 或 64x32，显示剪影：${url}`);
    }
    return null;
  }
  // 默认皮肤的帽子层都是正常的透明外层，直接叠；远程皮肤由后端按像素判定
  return { bitmap: art.bitmap, format, hat: skin.kind === "remote" ? skin.hat : true, model: skin.model };
}
