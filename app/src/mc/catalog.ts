// 本机材质源里能当封面的方块目录：后端从方块状态与模型推出哪些是完整立方体、各面用哪张图、要不要染色，
// 连同色相与名称一起给出。选择框按它列方块，卡面与等距方块按 id 查面与染色。
// 材质源为 null 时目录也为 null；材质源换了由绑定整份替换，订阅者随之重绘。

import { useSyncExternalStore } from "react";
import type { Rgb } from "./whitelist";

/** 后端 art_blocks 的返回形状（serde 默认 snake_case）。 */
export interface CatalogBlockDto {
  id: string;
  top: string;
  side: string;
  front: string | null;
  top_tint: [number, number, number] | null;
  side_tint: [number, number, number] | null;
  hue: number;
  name_en: string | null;
  name_zh: string | null;
}

export interface BlockCatalogDto {
  version_id: string;
  blocks: CatalogBlockDto[];
}

export interface CatalogBlock {
  /** 方块 id，即实例设置里的 cover 值，如 oak_log。 */
  readonly id: string;
  /** 顶面材质路径，如 block/oak_log_top。 */
  readonly top: string;
  /** 侧面材质路径。 */
  readonly side: string;
  /** 正面材质路径（熔炉、发射器这类有朝向的方块），画在等距方块的左面；没有为 null。 */
  readonly front: string | null;
  /** 顶面乘色（草方块顶、树叶）；不用染色为 null。 */
  readonly topTint: Rgb | null;
  /** 侧面与正面乘色（树叶四面都染）；不用染色为 null。 */
  readonly sideTint: Rgb | null;
  /** 侧面平均色的 HSL 色相（0-359）。 */
  readonly hue: number;
  /** 英文名来自 jar 里的 en_us，中文名来自资源索引里的 zh_cn；读不到为 null。 */
  readonly nameEn: string | null;
  readonly nameZh: string | null;
}

export interface BlockCatalog {
  /** 目录出自哪个材质源版本：位图缓存键里要带上它。 */
  readonly versionId: string;
  /** 按 id 排好的方块。 */
  readonly blocks: readonly CatalogBlock[];
  readonly byId: ReadonlyMap<string, CatalogBlock>;
}

const BLOCK_ID = /^[a-z0-9_]{1,64}$/;
const BLOCK_PATH = /^block\/[a-z0-9_]{1,64}$/;

function assertPath(id: string, field: string, value: unknown): string {
  if (typeof value !== "string" || !BLOCK_PATH.test(value)) throw new Error(`方块目录里 ${id} 的 ${field} 不是方块材质路径：${JSON.stringify(value)}`);
  return value;
}

function assertTint(id: string, field: string, value: unknown): Rgb | null {
  if (value === null) return null;
  if (!Array.isArray(value) || value.length !== 3 || !value.every((c) => Number.isInteger(c) && c >= 0 && c <= 255)) {
    throw new Error(`方块目录里 ${id} 的 ${field} 不是 [r, g, b]：${JSON.stringify(value)}`);
  }
  return [value[0], value[1], value[2]] as Rgb;
}

function assertName(id: string, field: string, value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== "string" || value === "") throw new Error(`方块目录里 ${id} 的 ${field} 应为非空字符串或 null：${JSON.stringify(value)}`);
  return value;
}

/** 校验并转换；形状不对直接抛错，不把半份目录交给界面。 */
export function catalogFromDto(dto: BlockCatalogDto): BlockCatalog {
  if (typeof dto !== "object" || dto === null || !Array.isArray(dto.blocks)) throw new Error(`art_blocks 返回值形状不对：${JSON.stringify(dto)}`);
  if (typeof dto.version_id !== "string" || dto.version_id === "") throw new Error(`art_blocks 的 version_id 不对：${JSON.stringify(dto.version_id)}`);
  const blocks = dto.blocks.map((b): CatalogBlock => {
    if (typeof b.id !== "string" || !BLOCK_ID.test(b.id)) throw new Error(`方块目录里的 id 不合法：${JSON.stringify(b.id)}`);
    if (!Number.isInteger(b.hue) || b.hue < 0 || b.hue >= 360) throw new Error(`方块目录里 ${b.id} 的色相不在 0-359：${b.hue}`);
    return {
      id: b.id,
      top: assertPath(b.id, "top", b.top),
      side: assertPath(b.id, "side", b.side),
      front: b.front === null ? null : assertPath(b.id, "front", b.front),
      topTint: assertTint(b.id, "top_tint", b.top_tint),
      sideTint: assertTint(b.id, "side_tint", b.side_tint),
      hue: b.hue,
      nameEn: assertName(b.id, "name_en", b.name_en),
      nameZh: assertName(b.id, "name_zh", b.name_zh),
    };
  });
  const byId = new Map(blocks.map((b) => [b.id, b]));
  if (byId.size !== blocks.length) throw new Error("方块目录里有重复的 id");
  return { versionId: dto.version_id, blocks, byId };
}

let catalog: BlockCatalog | null = null;
const listeners = new Set<() => void>();

export function getBlockCatalog(): BlockCatalog | null {
  return catalog;
}

/** 整份替换目录并通知订阅者；与当前是同一份时什么都不做。 */
export function setBlockCatalog(next: BlockCatalog | null): void {
  if (next === catalog) return;
  catalog = next;
  for (const listener of [...listeners]) listener();
}

export function subscribeBlockCatalog(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useBlockCatalog(): BlockCatalog | null {
  return useSyncExternalStore(subscribeBlockCatalog, getBlockCatalog, getBlockCatalog);
}

/** 方块的显示名：有中文名用中文名，其次英文名，都没有时用 id。 */
export function blockDisplayName(block: CatalogBlock): string {
  return block.nameZh ?? block.nameEn ?? block.id;
}
