// 实例卡面的解析：实例设置里存的是方块 id、玩家图片与背景样式，画卡面要的是方块（面与色相）和背景。

import { coverImageUrl, useBlockCatalog, type BlockCatalog } from "../art/iso/catalog";
import { coverPreset, DEFAULT_COVER, type InstanceCover } from "../art/iso/covers";
import { hueOf } from "../art/illustrations/seed";
import type { InstanceSummary } from "../domain/adapt";
import type { CoverStyle } from "../domain/types";
import { useAppearance } from "../state/appearance";

/** 已警告过的问题：头像每次渲染都会解析封面，同一个问题只报一次。 */
const warned = new Set<string>();

function warnOnce(key: string, message: string): void {
  if (warned.has(key)) return;
  warned.add(key);
  console.warn(message);
}

/**
 * 实例的封面方块。没设过用默认封面；预设方块用预设色相；本机材质源目录里的方块用目录给的色相；
 * 两边都查不到（目录还没载入、换了材质源后没有这个方块、手改设置文件）时仍按它画，色相按实例 id 推出，
 * 方块材质读不到会回落到实例徽记，不让整页因为一张封面挂掉。玩家图片的取图键由实例列表给出。
 */
export function instanceCover(inst: Pick<InstanceSummary, "id" | "cover" | "coverImage">, catalog: BlockCatalog | null): InstanceCover {
  const image = inst.coverImage === null ? null : coverImageUrl(inst.coverImage);
  if (inst.cover === null) return { ...DEFAULT_COVER, image };
  const preset = coverPreset(inst.cover);
  if (preset !== undefined) return { ...preset, image };
  const listed = catalog?.byId.get(inst.cover);
  if (listed !== undefined) return { block: listed.id, hue: listed.hue, image };
  if (catalog !== null) warnOnce(`${inst.id}:${inst.cover}`, `实例 ${inst.id} 的封面 ${inst.cover} 不在本机材质源里，按实例色相回落`);
  return { block: inst.cover, hue: hueOf(inst.id), image };
}

/** 组件里用：订阅方块目录，目录载入或换了材质源时重新解析。 */
export function useInstanceCover(inst: Pick<InstanceSummary, "id" | "cover" | "coverImage">): InstanceCover {
  return instanceCover(inst, useBlockCatalog());
}

/** 解析后的卡面背景：art 渐变花瓣，texture 平铺封面方块，image 玩家图片的取图地址。 */
export type CoverBackdrop = { kind: "art" } | { kind: "texture" } | { kind: "image"; url: string };

/**
 * 实例卡面的背景。跟随时取外观设置里的默认；设成图片但图片不见了（列表给不出取图键）时回落渐变花瓣并警告一次。
 * 材质平铺读不到材质时由卡面自己回落，这里不管。
 */
export function instanceBackdrop(inst: Pick<InstanceSummary, "id" | "background" | "backgroundImage">, fallback: CoverStyle): CoverBackdrop {
  switch (inst.background) {
    case "follow":
      return { kind: fallback };
    case "art":
    case "texture":
      return { kind: inst.background };
    case "image":
      if (inst.backgroundImage !== null) return { kind: "image", url: coverImageUrl(inst.backgroundImage) };
      warnOnce(`${inst.id}:background`, `实例 ${inst.id} 的卡面背景图片不见了，回落渐变花瓣`);
      return { kind: "art" };
  }
}

/** 卡面背景的两个参数，直接展开给 <Cover>。 */
export interface CoverBackdropProps {
  remoteUrl: string | null;
  texture: InstanceCover | null;
}

/**
 * 组件里用：按实例设置与外观里的默认背景解析卡面背景。图片背景不带平铺：图片加载中与读不到时卡面画渐变花瓣，
 * 与列表给不出取图键时的回落一致。
 */
export function useCoverBackdrop(inst: Pick<InstanceSummary, "id" | "cover" | "coverImage" | "background" | "backgroundImage">): CoverBackdropProps {
  const fallback = useAppearance().appearance.coverBackground;
  const cover = useInstanceCover(inst);
  const backdrop = instanceBackdrop(inst, fallback);
  switch (backdrop.kind) {
    case "art":
      return { remoteUrl: null, texture: null };
    case "texture":
      return { remoteUrl: null, texture: cover };
    case "image":
      return { remoteUrl: backdrop.url, texture: null };
  }
}
