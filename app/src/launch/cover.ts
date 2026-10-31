// 实例封面的解析：实例设置里存的是封面预设 id，画方块要的是预设（方块 + 色相）。

import { coverPreset, DEFAULT_COVER, type InstanceCover } from "../art/iso/covers";
import { hueOf } from "../art/illustrations/seed";
import type { InstanceSummary } from "../domain/adapt";

/** 已警告过的「实例:封面」：头像每次渲染都会解析封面，同一个问题只报一次。 */
const warned = new Set<string>();

/**
 * 没设过封面用默认封面。设成了白名单外的 id（手改设置文件、旧版本写入）时仍按它画：
 * 材质读不到会回落到实例徽记，色相按实例 id 推出，并在控制台留一条警告，不让整页因为一张封面挂掉。
 */
export function instanceCover(inst: Pick<InstanceSummary, "id" | "cover">): InstanceCover {
  if (inst.cover === null) return DEFAULT_COVER;
  const preset = coverPreset(inst.cover);
  if (preset !== undefined) return preset;
  const key = `${inst.id}:${inst.cover}`;
  if (!warned.has(key)) {
    warned.add(key);
    console.warn(`实例 ${inst.id} 的封面 ${inst.cover} 不在预设里，按实例色相回落`);
  }
  return { block: inst.cover, hue: hueOf(inst.id) };
}
