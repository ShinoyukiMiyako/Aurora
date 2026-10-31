// 新建实例流程的纯逻辑：步骤表、版本清单的整理与筛选、推荐加载器版本、回落规则、存放位置与「填过几项」。
// 状态由流程组件持有，这里只做推算，便于逐条测试。

import { releaseTypeFromDto, type ReleaseType } from "../../domain/adapt";
import type { LoaderKind } from "../../domain/types";
import type { LoaderChoice, LoaderVersionDto, ManifestDto } from "../../state/queries/catalog";

// ---------------------------------------------------------------- 步骤

export type StepId = "name" | "version" | "loader" | "loaderVersion" | "cover" | "confirm";

export const STEP_ORDER: readonly StepId[] = ["name", "version", "loader", "loaderVersion", "cover", "confirm"];

/** 原版没有加载器版本可选，这一步跳过。 */
export function visibleSteps(loader: LoaderKind): StepId[] {
  return STEP_ORDER.filter((id) => id !== "loaderVersion" || loader !== "vanilla");
}

// ---------------------------------------------------------------- 版本清单

export interface GameVersion {
  id: string;
  type: ReleaseType;
  /** 发布时刻（毫秒时间戳）。 */
  releasedAt: number;
  /** 可装的加载器，按 Fabric、Quilt、Forge、NeoForge 的顺序；原版不在其中、恒可选。 */
  loaders: readonly LoaderChoice[];
}

export function gameVersionsFromManifest(manifest: ManifestDto): GameVersion[] {
  return manifest.versions.map((v) => {
    const releasedAt = Date.parse(v.release_time);
    if (Number.isNaN(releasedAt)) throw new Error(`版本 ${v.id} 的发布时间读不出来：${v.release_time}`);
    return { id: v.id, type: releaseTypeFromDto(v.release_type), releasedAt, loaders: v.loaders };
  });
}

/**
 * 版本清单整份不可用的原因：没有任何版本时（拉不到又没有缓存）给出后端的原因；可用时为 null。
 * 没有版本却也没有原因属于契约被破坏，直接抛出。
 */
export function manifestProblem(manifest: ManifestDto): string | null {
  if (manifest.versions.length > 0) return null;
  if (manifest.fetch_error === null) throw new Error("版本清单是空的，后端也没有给出原因");
  return manifest.fetch_error;
}

/** 最新正式版：清单标出的那个；它不在列表里时取列表里第一个正式版。 */
export function latestRelease(manifest: ManifestDto, versions: readonly GameVersion[]): GameVersion {
  const marked = versions.find((v) => v.id === manifest.latest.release);
  if (marked !== undefined) return marked;
  const first = versions.find((v) => v.type === "release");
  if (first === undefined) throw new Error("版本清单里没有正式版");
  return first;
}

export interface VersionFilter {
  snapshots: boolean;
  old: boolean;
  /** 版本号子串；去首尾空白、不分大小写。 */
  query: string;
}

export function isTypeShown(type: ReleaseType, filter: Pick<VersionFilter, "snapshots" | "old">): boolean {
  if (type === "snapshot") return filter.snapshots;
  if (type === "old") return filter.old;
  return true;
}

export function filterVersions(versions: readonly GameVersion[], filter: VersionFilter): GameVersion[] {
  const q = filter.query.trim().toLowerCase();
  return versions.filter((v) => isTypeShown(v.type, filter) && (q === "" || v.id.toLowerCase().includes(q)));
}

export function supportsLoader(version: GameVersion, loader: LoaderKind): boolean {
  return loader === "vanilla" || version.loaders.includes(loader);
}

/** 加载器的可选项：原版在前，其后是这个版本支持的加载器。 */
export function loaderOptions(version: GameVersion): LoaderKind[] {
  return ["vanilla", ...version.loaders];
}

// ---------------------------------------------------------------- 加载器版本

/** 推荐版本：最新的稳定版；没有稳定版时取最新的；列表为空（没有适配这个游戏版本的）为 null。 */
export function recommendedLoaderVersion(list: readonly LoaderVersionDto[]): string | null {
  const stable = list.find((v) => v.stable);
  if (stable !== undefined) return stable.version;
  return list.length > 0 ? list[0].version : null;
}

/** 用户在加载器版本步明确选过的版本；只对选它时的加载器与游戏版本有效，换了任一个就回到推荐版。 */
export interface LoaderVersionPick {
  loader: LoaderChoice;
  mcVersion: string;
  version: string;
}

export function effectiveLoaderVersion(
  loader: LoaderKind,
  mcVersion: string | null,
  pick: LoaderVersionPick | null,
  available: readonly LoaderVersionDto[] | undefined,
): string | null {
  if (loader === "vanilla" || mcVersion === null) return null;
  if (pick !== null && pick.loader === loader && pick.mcVersion === mcVersion) return pick.version;
  return available === undefined ? null : recommendedLoaderVersion(available);
}

// ---------------------------------------------------------------- 确认

/** 实例目录：<游戏目录>/versions/<名称>，分隔符跟随游戏目录本身的写法。 */
export function instancePath(gameDir: string, name: string): string {
  const sep = gameDir.includes("\\") ? "\\" : "/";
  const base = gameDir.endsWith(sep) ? gameDir.slice(0, -1) : gameDir;
  return `${base}${sep}versions${sep}${name}`;
}

export interface DraftFacts {
  /** 去首尾空白后的名称。 */
  name: string;
  /** 用户明确选过版本（而不是停在默认版本上）。 */
  versionChanged: boolean;
  loader: LoaderKind;
  /** 用户明确选过一个与推荐版不同的加载器版本。 */
  loaderVersionChanged: boolean;
  coverChanged: boolean;
}

/** 已经填写或选择过几项：两项及以上时中途关闭要先确认。 */
export function filledCount(draft: DraftFacts): number {
  return [draft.name !== "", draft.versionChanged, draft.loader !== "vanilla", draft.loaderVersionChanged, draft.coverChanged].filter(Boolean).length;
}

export const DISCARD_CONFIRM_THRESHOLD = 2;
