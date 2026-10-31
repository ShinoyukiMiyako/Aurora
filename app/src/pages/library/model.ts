// 实例库的筛选、搜索、排序与统计：纯函数，页面与测试共用。

import type { InstanceSummary } from "../../domain/adapt";
import type { LoaderKind } from "../../domain/types";
import { needsReimport } from "../instance/model";

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

export function matchesView(inst: InstanceSummary, view: LibraryView): boolean {
  if (view.loader !== "all" && inst.loader !== view.loader) return false;
  const q = normalizedQuery(view.query);
  return q === "" || inst.name.toLowerCase().includes(q);
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

const nameCollator = new Intl.Collator("zh-CN");

export function sortInstances(list: readonly InstanceSummary[], key: SortKey): InstanceSummary[] {
  const out = [...list];
  if (key === "recent") out.sort(byRecent);
  else if (key === "name") out.sort((a, b) => nameCollator.compare(a.name, b.name));
  else out.sort((a, b) => b.playtimeMin - a.playtimeMin);
  return out;
}

export function visibleInstances(list: readonly InstanceSummary[], view: LibraryView): InstanceSummary[] {
  return sortInstances(
    list.filter((inst) => matchesView(inst, view)),
    view.sort,
  );
}

export function totalPlaytime(list: readonly InstanceSummary[]): number {
  return list.reduce((sum, inst) => sum + inst.playtimeMin, 0);
}

/** 修复横幅列出的实例：补全能修好的损坏实例。整合包没导入完的补全补不回来，各自在卡片上给重新导入。 */
export function brokenInstances(list: readonly InstanceSummary[]): InstanceSummary[] {
  return list.filter((inst) => inst.status === "broken" && !needsReimport(inst));
}

/** 网格的顺序签名：只有顺序或成员变化时才触发布局动画，窗口缩放、分档切换不触发。 */
export function orderSignature(list: readonly InstanceSummary[]): string {
  return list.map((inst) => inst.id).join("\n");
}
