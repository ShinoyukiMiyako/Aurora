// 安装目标的判定：后端落位矩阵（matchInstances）给出兼容性与已装情况，界面在它之上叠加本机才知道的事
// （实例正在安装或已损坏、数据包要有存档、光影要有 Iris 或 OptiFine），映射成六种判定与可勾选性。纯函数。

import type { InstanceSummary } from "../../domain/adapt";
import type { InstallableResourceType, InstanceMatch, ModVersionInfo } from "../../state/queries/discover";
import type { WorldDto } from "../../state/queries/instance";
import { INSTALL_COPY } from "./copy";

export type VerdictKind = "compatible" | "updatable" | "maybe" | "installed" | "unavailable" | "incompatible";

/** 排序与分组：可勾选的三种在前，不可勾选的三种在后。 */
export const VERDICT_ORDER: readonly VerdictKind[] = ["compatible", "updatable", "maybe", "installed", "unavailable", "incompatible"];

const SELECTABLE: ReadonlySet<VerdictKind> = new Set(["compatible", "updatable", "maybe"]);

export const VERDICT_TONE: Readonly<Record<VerdictKind, "ok" | "info" | "warn" | "neutral" | "danger">> = {
  compatible: "ok",
  updatable: "info",
  maybe: "warn",
  installed: "neutral",
  unavailable: "neutral",
  incompatible: "danger",
};

export interface TargetVerdict {
  instanceId: string;
  kind: VerdictKind;
  selectable: boolean;
  /** 原因行；可能可行的原因用警示色。 */
  reason: string | null;
  /** 勾选后装的版本；不可勾选时为 null。 */
  version: ModVersionInfo | null;
}

/** 数据包目标的存档读取情况。 */
export type WorldsState = { status: "loading" } | { status: "ready"; worlds: readonly WorldDto[] } | { status: "error"; message: string };

/** 光影目标：实例里是否已有能加载光影的 Iris 或 OptiFine；查询未完成时为 null。 */
export type ShaderLoaderState = boolean | null;

export interface TargetInput {
  instance: InstanceSummary;
  /** 落位矩阵里这个实例的一行；矩阵还没覆盖到它（刚装好的实例、矩阵在重取）时为 null。 */
  match: InstanceMatch | null;
  resourceType: InstallableResourceType;
  worlds?: WorldsState;
  shaderLoader?: ShaderLoaderState;
}

function verdict(instanceId: string, kind: VerdictKind, reason: string | null, version: ModVersionInfo | null): TargetVerdict {
  const selectable = SELECTABLE.has(kind);
  if (selectable && version === null) throw new Error(`实例 ${instanceId} 判为可安装却没有要装的版本`);
  return { instanceId, kind, selectable, reason, version: selectable ? version : null };
}

function fromMatch(id: string, match: InstanceMatch): TargetVerdict {
  const compat = match.compatibility;
  switch (match.state) {
    case "compatible":
      return verdict(id, "compatible", null, match.best_version);
    case "maybe":
      if (compat.kind === "match") throw new Error(`实例 ${id} 判为可能可行却没有原因`);
      return verdict(id, "maybe", compat.reason, match.best_version);
    case "incompatible":
      if (compat.kind === "match") throw new Error(`实例 ${id} 判为不兼容却没有原因`);
      return verdict(id, "incompatible", compat.reason, null);
    case "installed": {
      const installed = match.installed;
      if (installed === null) throw new Error(`实例 ${id} 判为已安装却没有已装文件`);
      const best = match.best_version;
      if (best !== null && compat.kind !== "mismatch" && best.version_id !== installed.version_id) {
        const from = installed.version_number === null ? installed.version_id : installed.version_number;
        return verdict(id, "updatable", INSTALL_COPY.updateReason(from, best.version_number), best);
      }
      return verdict(id, "installed", null, null);
    }
  }
}

/** 单个实例的判定。 */
export function targetVerdict(input: TargetInput): TargetVerdict {
  const { instance, match, resourceType } = input;
  const id = instance.id;
  if (instance.status === "installing") return verdict(id, "unavailable", INSTALL_COPY.instanceInstalling, null);
  if (instance.status === "broken") return verdict(id, "unavailable", INSTALL_COPY.instanceBroken, null);
  if (match === null) return verdict(id, "unavailable", INSTALL_COPY.judging, null);

  if (resourceType === "data_pack") {
    const worlds = input.worlds;
    if (worlds === undefined) throw new Error("数据包的安装目标必须给出存档读取情况");
    if (worlds.status === "loading") return verdict(id, "unavailable", INSTALL_COPY.readingWorlds, null);
    if (worlds.status === "error") return verdict(id, "unavailable", INSTALL_COPY.worldsFailed(worlds.message), null);
    if (worlds.worlds.length === 0) return verdict(id, "unavailable", INSTALL_COPY.noWorlds, null);
    const base = fromMatch(id, match);
    // 任一存档里有就算已装：说明是哪个存档，否则玩家看不出为什么别的存档也勾不了
    const world = match.installed === null ? null : match.installed.world;
    if (base.kind !== "installed" || world === null) return base;
    const known = worlds.worlds.find((w) => w.dir_name === world);
    return verdict(id, "installed", INSTALL_COPY.installedInWorld(known === undefined || known.name === null ? world : known.name), null);
  }

  const base = fromMatch(id, match);
  if (resourceType === "shader") {
    if (input.shaderLoader === undefined) throw new Error("光影的安装目标必须给出 Iris / OptiFine 情况");
    // 没有能加载光影的东西时文件照样能放进去，只是进游戏看不到效果：降为可能可行，原因换成缺什么
    if (input.shaderLoader === false && (base.kind === "compatible" || base.kind === "maybe")) {
      return verdict(id, "maybe", INSTALL_COPY.shaderNeedsLoader, base.version);
    }
  }
  return base;
}

/** 组内按最近游玩降序，没玩过的排后面，同时刻按名称。 */
function byRecent(a: InstanceSummary, b: InstanceSummary): number {
  const ta = a.lastPlayedAt === null ? -Infinity : a.lastPlayedAt;
  const tb = b.lastPlayedAt === null ? -Infinity : b.lastPlayedAt;
  if (ta !== tb) return tb - ta;
  return a.name.localeCompare(b.name, "zh-CN");
}

export interface TargetRow {
  instance: InstanceSummary;
  verdict: TargetVerdict;
}

export function sortTargets(rows: readonly TargetRow[]): TargetRow[] {
  return [...rows].sort((a, b) => VERDICT_ORDER.indexOf(a.verdict.kind) - VERDICT_ORDER.indexOf(b.verdict.kind) || byRecent(a.instance, b.instance));
}

/**
 * 打开详情时默认勾选的实例：有适配实例（路由的 forInstance 或工具条选的）时只看它，否则看当前实例；
 * 只有判定为兼容或可更新时才替用户勾上。
 */
export function defaultPick(rows: readonly TargetRow[], fitInstance: string | null, selectedInstance: string | null): string[] {
  const preferred = fitInstance !== null ? fitInstance : selectedInstance;
  if (preferred === null) return [];
  const row = rows.find((r) => r.instance.id === preferred);
  if (row === undefined) return [];
  return row.verdict.kind === "compatible" || row.verdict.kind === "updatable" ? [preferred] : [];
}

/** 实际生效的勾选：已勾选但变得不可勾选（实例被删、判定变化）的自动去掉，顺序跟随列表。 */
export function effectiveSelection(rows: readonly TargetRow[], picked: ReadonlySet<string>): TargetRow[] {
  return rows.filter((r) => r.verdict.selectable && picked.has(r.instance.id));
}

/** 主按钮文案：只勾了可更新项写「更新」，勾一个写「安装」，多个写「安装到 n 个实例」。 */
export function primaryLabel(selected: readonly TargetRow[]): string {
  if (selected.length === 0) return INSTALL_COPY.install;
  if (selected.every((r) => r.verdict.kind === "updatable")) return INSTALL_COPY.update;
  return selected.length === 1 ? INSTALL_COPY.install : INSTALL_COPY.installMany(selected.length);
}

/**
 * 数据包默认装进哪个存档。已装过的（可更新）默认装回旧版本所在的存档：更新针对的是那个存档里的那一份，
 * 装进别的存档就成了两个存档各有一个版本。没装过、或旧版本所在的存档已不在列表里时，取最近游玩的存档，
 * 都没有游玩时刻时取第一个。
 */
export function defaultWorld(worlds: readonly WorldDto[], installedIn: string | null): string {
  if (worlds.length === 0) throw new Error("没有存档时不该选默认存档");
  if (installedIn !== null && worlds.some((w) => w.dir_name === installedIn)) return installedIn;
  let best = worlds[0];
  for (const w of worlds) {
    const lw = w.last_played === null ? -Infinity : w.last_played;
    const lb = best.last_played === null ? -Infinity : best.last_played;
    if (lw > lb) best = w;
  }
  return best.dir_name;
}

export interface PlanSummary {
  /** 待下载的文件数。 */
  files: number;
  /** 待下载的总字节；有文件不知道大小时为 null。 */
  bytes: number | null;
}

/** 底栏的合计：各实例的待下载行数相加；任一组还没算出来时整体为 null。 */
export function sumPlans(summaries: readonly (PlanSummary | null)[]): PlanSummary | null {
  let files = 0;
  let bytes: number | null = 0;
  for (const s of summaries) {
    if (s === null) return null;
    files += s.files;
    bytes = bytes === null || s.bytes === null ? null : bytes + s.bytes;
  }
  return { files, bytes };
}
