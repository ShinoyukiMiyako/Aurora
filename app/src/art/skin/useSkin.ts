import { useMemo, useState } from "react";
import { artUrl, skinUrl, useArtStatus } from "../../mc/art";
import { peekArt, preloadArt, useArt } from "../../mc/useArt";
import { skinFormat, type SkinRef, type SkinSource } from "./layout";
import type { LoadedSkin } from "./render";

const warnedSizes = new Set<string>();

/** 皮肤位图的地址：远程皮肤按缓存键，默认皮肤按白名单路径；本机没有材质源时默认皮肤为 null。 */
function skinAddress(skin: SkinRef): string | null {
  return skin.kind === "remote" ? skinUrl(skin.sha1) : artUrl(skin.path);
}

/**
 * 把一批皮肤位图先取进缓存，之后挂上的头像、立绘第一帧就是皮肤，不先闪剪影再交叉（离线账户弹窗预取 18 套默认皮肤）。
 * 地址规则与 useSkin 相同，本机没有材质源时默认皮肤不发请求：材质源会变，调用方订阅 useArtStatus()、变了再调一次。
 */
export function preloadSkins(skins: readonly SkinRef[]): void {
  const urls: string[] = [];
  for (const skin of skins) {
    const url = skinAddress(skin);
    if (url !== null) urls.push(url);
  }
  preloadArt(urls);
}

/** 正在显示的皮肤：位图，加上它的来源（远程皮肤的 sha1、默认皮肤的路径）。来源变了就是另一张图，交叉淡化以它为 key。 */
export interface ShownSkin {
  skin: LoadedSkin;
  key: string;
}

/**
 * 取皮肤位图：远程皮肤按缓存键走协议的 /skin/，默认皮肤按白名单路径走 /art/（本机没有材质源时不发请求）。
 * 取不到或尺寸不是 64 × 64 / 64 × 32 时返回 null，调用方显示剪影。
 * 还没有结果可换的这段时间先给上一张已就绪的，到了再换：换地址（刷新账户后换了皮肤、材质源变了）时新图还在取，
 * 或皮肤信息还在读（"loading"，换了账户）。不中途落回剪影，旧图与新图之间是一次交叉淡化，而不是皮肤、剪影、皮肤闪两下。
 * 新图取不到、或读到的是「没有皮肤」才回落剪影；读取中又没有上一张可给时先是剪影。
 */
export function useSkin(skin: SkinSource): ShownSkin | null {
  // 订阅材质状态：默认皮肤的地址随材质源变化
  useArtStatus();
  const ref = skin === "loading" ? null : skin;
  const url = ref === null ? null : skinAddress(ref);
  const art = useArt(url);
  const bitmap = ref !== null && art.kind === "ready" ? art.bitmap : null;
  const format = bitmap === null ? null : skinFormat(bitmap.width, bitmap.height);
  if (bitmap !== null && format === null && url !== null && !warnedSizes.has(url)) {
    warnedSizes.add(url);
    console.warn(`[art] 皮肤尺寸 ${bitmap.width}x${bitmap.height} 不是 64x64 或 64x32，显示剪影：${url}`);
  }
  const model = ref === null ? null : ref.model;
  // 默认皮肤的帽子层都是正常的透明外层，直接叠；远程皮肤由后端按像素判定
  const hat = ref?.kind === "remote" ? ref.hat : true;
  const key = ref === null ? null : ref.kind === "remote" ? ref.sha1 : ref.path;
  // 引用要稳定：SpinningFigure 把皮肤变化当作重置姿态的信号，每次渲染给新对象的话，问候卡随下载进度一刷新，拖动就断了
  const fresh = useMemo(
    () => (bitmap === null || format === null || model === null || key === null ? null : { skin: { bitmap, format, hat, model }, key }),
    [bitmap, format, hat, model, key],
  );
  // 还没有结果可换：皮肤信息还在读，或这个地址的位图还没落定（取图缓存里既没有成功也没有失败）
  const waiting = skin === "loading" || (url !== null && art.kind === "missing" && peekArt(url) === undefined);
  const [held, setHeld] = useState<ShownSkin | null>(fresh);
  if (fresh !== null && fresh !== held) setHeld(fresh);
  if (fresh === null && !waiting && held !== null) setHeld(null);
  if (fresh !== null) return fresh;
  return waiting ? held : null;
}
