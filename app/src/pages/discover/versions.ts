// 版本相关的纯函数：版本行的游戏版本摘要、「能装进我的实例」的判断、支持版本的排序。

import type { InstanceSummary } from "../../domain/adapt";
import type { ModVersionInfo, ResourceType } from "../../state/queries/discover";
import { DETAIL_COPY } from "./copy";

/** 最多列出的不连续版本数。 */
const LIST_HEAD = 3;

/**
 * 版本行的游戏版本摘要。releases 为版本清单里的正式版（新到旧）：给出的版本在其中连成一段时写「旧 – 新」，
 * 否则列前 3 个再写「等 n 个」。清单还没到（null）或含有清单外的版本（快照）时按不连续处理。
 */
export function gameVersionSummary(gameVersions: readonly string[], releases: readonly string[] | null): string {
  if (gameVersions.length === 0) return "";
  const unique = [...new Set(gameVersions)];
  if (releases !== null) {
    const indices = unique.map((v) => releases.indexOf(v));
    if (indices.every((i) => i >= 0)) {
      const sorted = [...indices].sort((a, b) => a - b);
      const contiguous = sorted.every((idx, k) => k === 0 || idx === sorted[k - 1] + 1);
      const newest = releases[sorted[0]];
      const oldest = releases[sorted[sorted.length - 1]];
      if (contiguous) return sorted.length === 1 ? newest : `${oldest} – ${newest}`;
      const ordered = sorted.map((i) => releases[i]);
      return listHead(ordered);
    }
  }
  return listHead(unique);
}

function listHead(versions: readonly string[]): string {
  const head = versions.slice(0, LIST_HEAD).join("、");
  return versions.length > LIST_HEAD ? DETAIL_COPY.manyGameVersions(head, versions.length) : head;
}

/** 区分加载器的资源类型：资源包、光影、数据包与加载器无关，只看游戏版本。 */
function loaderMatters(type: ResourceType): boolean {
  return type === "mod" || type === "modpack";
}

/**
 * 这个版本能不能装进某个就绪实例：游戏版本对上（平台没标注视为不限），Mod 还要加载器对上（同样没标注视为不限）。
 * 与后端兼容判定「缺元数据的维度不算不匹配」同一口径。
 */
export function fitsInstance(version: ModVersionInfo, instance: InstanceSummary, type: ResourceType): boolean {
  if (instance.status !== "ready" || instance.mcVersion === null) return false;
  const gameOk = version.game_versions.length === 0 || version.game_versions.includes(instance.mcVersion);
  if (!gameOk) return false;
  if (!loaderMatters(type) || version.loaders.length === 0) return true;
  return instance.loader !== "vanilla" && version.loaders.some((l) => l === instance.loader);
}

export function fitsAnyInstance(version: ModVersionInfo, instances: readonly InstanceSummary[], type: ResourceType): boolean {
  return instances.some((inst) => fitsInstance(version, inst, type));
}

/** 支持的游戏版本按版本清单从新到旧；清单里没有的（快照、清单未到）保持平台给的相对顺序放在后面。 */
export function sortGameVersions(gameVersions: readonly string[], order: readonly string[] | null): string[] {
  const unique = [...new Set(gameVersions)];
  if (order === null) return unique;
  const known = unique.filter((v) => order.includes(v)).sort((a, b) => order.indexOf(a) - order.indexOf(b));
  const unknown = unique.filter((v) => !order.includes(v));
  return [...known, ...unknown];
}
