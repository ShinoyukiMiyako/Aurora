// 自动分配内存的估算依据：全局设置页与实例设置页共用一份，两处对同一个实例说同一句话。
// 数值一律经 domain/format 的 formatMemory。

import { formatMemory } from "../domain/format";
import type { MemoryLimitReason } from "../ipc/system";

/** 本机上限的来由，写在括号里。 */
const LIMIT_REASON: Readonly<Record<MemoryLimitReason, string>> = {
  half_physical: "物理内存的一半",
  java_32bit: "32 位 Java 的上限",
};

export const MEMORY_BASIS_COPY = {
  separator: " · ",
  /** 加载器名与游戏版本：「Forge 1.20.1」「原版 1.21.1」。 */
  loaderVersion: (loader: string, mcVersion: string) => `${loader} ${mcVersion}`,
  mods: (count: number) => `${count} 个 Mod`,
  modpack: (mb: number) => `整合包推荐 ${formatMemory(mb)}`,
  renderDistance: (distance: number) => `视距 ${distance}`,
  distantHorizons: "Distant Horizons",
  summary: (basis: string, mb: number) => `${basis}，建议 ${formatMemory(mb)}`,
  /** 一个片段都写不出来时（摘要拿不到、又只知道装了加载器）只说建议值。 */
  summaryBare: (mb: number) => `建议 ${formatMemory(mb)}`,
  cap: (need: number, limit: number, reason: MemoryLimitReason) => `需要 ${formatMemory(need)}，本机最多给 ${formatMemory(limit)}（${LIMIT_REASON[reason]}）`,
  withCap: (summary: string, cap: string) => `${summary}。${cap}`,
  capNotice: (cap: string) => `${cap}，内存可能不够用。`,
} as const;
