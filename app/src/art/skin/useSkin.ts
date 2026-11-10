import { useMemo, useState } from "react";
import { artUrl, skinUrl, useArtStatus } from "../../mc/art";
import { peekArt, useArt } from "../../mc/useArt";
import { skinFormat, type SkinRef } from "./layout";
import type { LoadedSkin } from "./render";

const warnedSizes = new Set<string>();

/** 正在显示的皮肤：位图，加上它的来源（远程皮肤的 sha1、默认皮肤的路径）。来源变了就是另一张图，交叉淡化以它为 key。 */
export interface ShownSkin {
  skin: LoadedSkin;
  key: string;
}

/**
 * 取皮肤位图：远程皮肤按缓存键走协议的 /skin/，默认皮肤按白名单路径走 /art/（本机没有材质源时不发请求）。
 * 取不到或尺寸不是 64 × 64 / 64 × 32 时返回 null，调用方显示剪影。
 * 换地址时（刷新账户后换了皮肤、材质源变了）新图还在取的这段时间先给上一张已就绪的，到了再换：
 * 不中途落回剪影，旧图与新图之间是一次交叉淡化，而不是皮肤、剪影、皮肤闪两下。新图取不到才回落剪影。
 */
export function useSkin(skin: SkinRef | null): ShownSkin | null {
  // 订阅材质状态：默认皮肤的地址随材质源变化
  useArtStatus();
  const url = skin === null ? null : skin.kind === "remote" ? skinUrl(skin.sha1) : artUrl(skin.path);
  const art = useArt(url);
  const bitmap = skin !== null && art.kind === "ready" ? art.bitmap : null;
  const format = bitmap === null ? null : skinFormat(bitmap.width, bitmap.height);
  if (bitmap !== null && format === null && url !== null && !warnedSizes.has(url)) {
    warnedSizes.add(url);
    console.warn(`[art] 皮肤尺寸 ${bitmap.width}x${bitmap.height} 不是 64x64 或 64x32，显示剪影：${url}`);
  }
  const model = skin === null ? null : skin.model;
  // 默认皮肤的帽子层都是正常的透明外层，直接叠；远程皮肤由后端按像素判定
  const hat = skin?.kind === "remote" ? skin.hat : true;
  const key = skin === null ? null : skin.kind === "remote" ? skin.sha1 : skin.path;
  // 引用要稳定：SpinningFigure 把皮肤变化当作重置姿态的信号，每次渲染给新对象的话，问候卡随下载进度一刷新，拖动就断了
  const fresh = useMemo(
    () => (bitmap === null || format === null || model === null || key === null ? null : { skin: { bitmap, format, hat, model }, key }),
    [bitmap, format, hat, model, key],
  );
  // 这个地址的结果还没落定：取图缓存里既没有成功也没有失败
  const waiting = url !== null && art.kind === "missing" && peekArt(url) === undefined;
  const [held, setHeld] = useState<ShownSkin | null>(fresh);
  if (fresh !== null && fresh !== held) setHeld(fresh);
  if (fresh === null && !waiting && held !== null) setHeld(null);
  if (fresh !== null) return fresh;
  return waiting ? held : null;
}
