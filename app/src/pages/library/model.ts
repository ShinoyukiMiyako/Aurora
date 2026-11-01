// 实例库的筛选、搜索、排序与统计：纯函数，页面与测试共用。

import { gameDirSwitchReason } from "../../copy/flows";
import type { InstanceSummary } from "../../domain/adapt";
import type { LoaderKind } from "../../domain/types";
import { needsReimport } from "../../domain/rules";
import type { GameDirectoryDto } from "../../state/queries/catalog";
import type { SelectOption } from "../../ui/Select";
import { LIBRARY_COPY } from "./copy";

export type LoaderFilter = "all" | LoaderKind;
export type SortKey = "recent" | "name" | "playtime";

export const SORT_KEYS: readonly SortKey[] = ["recent", "name", "playtime"];

/** 分段筛选的顺序：原版在前，其后按加载器的常见程度。 */
export const FILTER_LOADERS: readonly LoaderKind[] = ["vanilla", "fabric", "forge", "neoforge", "quilt"];

export interface LibraryView {
  loader: LoaderFilter;
  query: string;
  sort: SortKey;
}

export const DEFAULT_VIEW: LibraryView = { loader: "all", query: "", sort: "recent" };

export function loaderCounts(list: readonly InstanceSummary[]): Readonly<Record<LoaderKind, number>> {
  const counts: Record<LoaderKind, number> = { vanilla: 0, fabric: 0, quilt: 0, forge: 0, neoforge: 0 };
  for (const inst of list) counts[inst.loader] += 1;
  return counts;
}

/** 搜索词去首尾空白后的小写形式；空串表示没有在搜索。 */
export function normalizedQuery(query: string): string {
  return query.trim().toLowerCase();
}

export function isFiltered(view: LibraryView): boolean {
  return view.loader !== "all" || normalizedQuery(view.query) !== "";
}

/** 搜索同时看实例名与整合包自己的名字：导入后实例可能被改了名，玩家记得的往往是整合包名。 */
export function matchesView(inst: InstanceSummary, view: LibraryView): boolean {
  if (view.loader !== "all" && inst.loader !== view.loader) return false;
  const q = normalizedQuery(view.query);
  if (q === "") return true;
  return inst.name.toLowerCase().includes(q) || (inst.modpack !== null && inst.modpack.name.toLowerCase().includes(q));
}

/**
 * 「最近」按最近一次活动排：没玩过的实例按创建时间算，刚新建、正在安装的实例因此排在最前面，能直接看到进度。
 * 两个时间都不知道的实例（文件系统不记录创建时间）排在最后。
 */
function activityOf(inst: InstanceSummary): number | null {
  if (inst.lastPlayedAt !== null) return inst.lastPlayedAt;
  return inst.createdAt;
}

function byRecent(a: InstanceSummary, b: InstanceSummary): number {
  const x = activityOf(a);
  const y = activityOf(b);
  if (x === null && y === null) return 0;
  if (x === null) return 1;
  if (y === null) return -1;
  return y - x;
}

/** 按累计时长倒序；游玩记录读不出的实例说不上多少，排在最后。 */
function byPlaytime(a: InstanceSummary, b: InstanceSummary): number {
  if (a.playtimeMin === null && b.playtimeMin === null) return 0;
  if (a.playtimeMin === null) return 1;
  if (b.playtimeMin === null) return -1;
  return b.playtimeMin - a.playtimeMin;
}

const nameCollator = new Intl.Collator("zh-CN");

export function sortInstances(list: readonly InstanceSummary[], key: SortKey): InstanceSummary[] {
  const out = [...list];
  if (key === "recent") out.sort(byRecent);
  else if (key === "name") out.sort((a, b) => nameCollator.compare(a.name, b.name));
  else out.sort(byPlaytime);
  return out;
}

export function visibleInstances(list: readonly InstanceSummary[], view: LibraryView): InstanceSummary[] {
  return sortInstances(
    list.filter((inst) => matchesView(inst, view)),
    view.sort,
  );
}

/** 全部实例的累计分钟；有实例的游玩记录读不出时加不出总数，为 null。 */
export function totalPlaytime(list: readonly InstanceSummary[]): number | null {
  let total = 0;
  for (const inst of list) {
    if (inst.playtimeMin === null) return null;
    total += inst.playtimeMin;
  }
  return total;
}

/** 修复横幅列出的实例：补全能修好的损坏实例。整合包没导入完的补全补不回来，各自在卡片上给重新导入。 */
export function brokenInstances(list: readonly InstanceSummary[]): InstanceSummary[] {
  return list.filter((inst) => inst.status === "broken" && !needsReimport(inst));
}

export interface SwitchSuggestion {
  dir: GameDirectoryDto;
  versions: number;
}

/**
 * 当前目录没有实例时值得切过去的目录：其它可达目录里版本最多的，一样多时取记录在前的。
 * 读不到版本数的不算：说不上里面有东西，就不该让人专门切过去。
 */
export function switchSuggestion(dirs: readonly GameDirectoryDto[]): SwitchSuggestion | null {
  let best: SwitchSuggestion | null = null;
  for (const dir of dirs) {
    const versions = dir.version_count;
    if (dir.is_current || !dir.available || versions === null || versions === 0) continue;
    if (best === null || versions > best.versions) best = { dir, versions };
  }
  return best;
}

/**
 * 目录选择的选项：标签只写目录名（触发器上显示的就是它），版本数放第二行；切不过去的禁用，第二行换成原因。
 * 当前目录的数取实例列表（instanceCount，读到之前为 null）：目录列表只在切换和回到本页时重读，新建、删除实例后还是旧数。
 */
export function directoryOptions(dirs: readonly GameDirectoryDto[], busy: boolean, instanceCount: number | null): SelectOption<string>[] {
  return dirs.map((dir) => {
    const option = { value: dir.path, label: dir.name };
    const blocked = dir.is_current ? undefined : gameDirSwitchReason(busy, dir.available);
    if (blocked !== undefined) return { ...option, hint: blocked, disabled: true };
    const versions = dir.is_current && instanceCount !== null ? instanceCount : dir.version_count;
    return { ...option, hint: versions === null ? LIBRARY_COPY.dirVersionsUnknown : LIBRARY_COPY.dirVersions(versions) };
  });
}

/** 网格的顺序签名：只有顺序或成员变化时才触发布局动画，窗口缩放、分档切换不触发。 */
export function orderSignature(list: readonly InstanceSummary[]): string {
  return list.map((inst) => inst.id).join("\n");
}
