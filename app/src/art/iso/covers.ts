// 实例封面预设：新建实例、换封面、整合包导入时可选的方块，与原版材质白名单同一张表。
// 预设的中文名属于文案，由使用方的文案表按 id 提供。

import { COVER_TEXTURES } from "../../mc/whitelist";
import { fnv1a32 } from "../illustrations/seed";

/** 实例的封面：block 为封面预设 id，hue 为该预设的色相。 */
export interface InstanceCover {
  block: string;
  hue: number;
}

export const COVER_PRESETS: readonly InstanceCover[] = COVER_TEXTURES.map((c) => ({ block: c.id, hue: c.hue }));

/** 新建实例的默认封面：樱花木板。 */
export const DEFAULT_COVER: InstanceCover = COVER_PRESETS[0];

/** 封面预设 id 对应的封面；白名单外返回 undefined。 */
export function coverPreset(block: string): InstanceCover | undefined {
  return COVER_PRESETS.find((c) => c.block === block);
}

/** 导入整合包创建的实例的默认封面：白名单第 fnv1a32(整合包项目 id) mod 16 项。 */
export function defaultModpackCover(projectId: string): InstanceCover {
  return COVER_PRESETS[fnv1a32(projectId) % COVER_PRESETS.length];
}
