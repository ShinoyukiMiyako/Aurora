// 自动分配内存的估算依据：把内存建议里的需求组成项与实例摘要写成展示用的片段与整句。
// 纯函数，全局设置页与实例设置页共用；需求怎么算归后端，这里只负责说清楚按什么算的。

import { EXTRA_LOADER_NAME, LOADER_NAME } from "../copy/flows";
import { MEMORY_BASIS_COPY as C } from "../copy/memory";
import type { MemoryAdviceDto, MemoryNeedFactor } from "../ipc/system";
import type { InstanceSummary } from "./adapt";

type BasisInstance = Pick<InstanceSummary, "loader" | "extraLoaders" | "mcVersion">;

export interface MemoryBasis {
  /** 估算依据的片段，按展示顺序：加载器与版本，其后按组成项的顺序（Mod 数、整合包推荐、视距、Distant Horizons）。 */
  parts: string[];
  /** 「<片段>，建议 5.5 GB」；一个片段都没有时为「建议 5.5 GB」。 */
  summary: string;
  /** 被封顶时说明需要多少、本机最多给多少与上限的来由；没被封顶为 null。 */
  cap: string | null;
  /** 整句：summary，被封顶时补上 cap。 */
  sentence: string;
}

/** 实例摘要里的加载器名：主加载器优先；只有外部安装器写进来的，LiteLoader 本身就是 Mod 加载器，排在 OptiFine 前。 */
function instanceLoaderName(inst: BasisInstance): string {
  if (inst.loader !== "vanilla") return LOADER_NAME[inst.loader];
  const extras = inst.extraLoaders.map((l) => l.kind);
  if (extras.includes("liteloader")) return EXTRA_LOADER_NAME.liteloader;
  if (extras.includes("optifine")) return EXTRA_LOADER_NAME.optifine;
  return LOADER_NAME.vanilla;
}

/** 摘要拿不到时只能从基数项看出大类：装的是哪个 Mod 加载器看不出来就不写，整合包推荐值替代了基数项时同样不写。 */
function factorLoaderName(factors: readonly MemoryNeedFactor[]): string | null {
  const base = factors.find((f) => f.kind === "base");
  if (base === undefined || base.loader === "modded") return null;
  return base.loader === "optifine" ? EXTRA_LOADER_NAME.optifine : LOADER_NAME.vanilla;
}

function loaderPart(factors: readonly MemoryNeedFactor[], inst: BasisInstance | null): string | null {
  if (inst === null) return factorLoaderName(factors);
  const name = instanceLoaderName(inst);
  return inst.mcVersion === null ? name : C.loaderVersion(name, inst.mcVersion);
}

function factorPart(factor: MemoryNeedFactor): string | null {
  switch (factor.kind) {
    // 基数由加载器那一片代表
    case "base":
      return null;
    case "mods":
      return factor.count === 0 ? null : C.mods(factor.count);
    case "modpack":
      return C.modpack(factor.mb);
    case "render_distance":
      return C.renderDistance(factor.distance);
    case "distant_horizons":
      return C.distantHorizons;
  }
}

/** inst 是 advice.version_id 对应的实例摘要；version_id 为 null 或实例列表里找不到时传 null。 */
export function memoryBasis(advice: MemoryAdviceDto, inst: BasisInstance | null): MemoryBasis {
  const parts: string[] = [];
  const loader = loaderPart(advice.factors, inst);
  if (loader !== null) parts.push(loader);
  for (const factor of advice.factors) {
    const part = factorPart(factor);
    if (part !== null) parts.push(part);
  }
  const summary = parts.length === 0 ? C.summaryBare(advice.recommended_mb) : C.summary(parts.join(C.separator), advice.recommended_mb);
  const cap = advice.need_mb > advice.recommended_mb ? C.cap(advice.need_mb, advice.limit.mb, advice.limit.reason) : null;
  return { parts, summary, cap, sentence: cap === null ? summary : C.withCap(summary, cap) };
}
