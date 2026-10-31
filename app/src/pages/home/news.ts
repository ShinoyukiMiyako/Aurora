// 资讯：列表取哪几条、详情弹窗的主按钮做什么。

import type { InstanceSummary } from "../../domain/adapt";
import type { NewsItemDto } from "../../state/queries/home";
import { sortByRecency } from "./instances";

/** 资讯条数：wide 5 条，其余 4 条。 */
export const NEWS_COUNT = { compact: 4, regular: 4, wide: 5 } as const;

/** 按发布时刻倒序取前 count 条。 */
export function latestNews(items: readonly NewsItemDto[], count: number): NewsItemDto[] {
  return [...items].sort((a, b) => b.date - a.date).slice(0, count);
}

export type NewsAction =
  /** 已有这个游戏版本的实例：打开最近玩过（或最新建）的那个。 */
  | { kind: "open"; instance: InstanceSummary }
  /** 还没有：带版本预设打开新建实例。 */
  | { kind: "create"; mcVersion: string };

/**
 * 资讯对应的游戏版本由后端给出（更新日志条目才有）；有版本时决定主按钮，没有版本的资讯只有「关闭」。
 * 新建、导入中的占位项还没装好，不作为「打开」的目标。
 */
export function newsAction(item: NewsItemDto, instances: readonly InstanceSummary[]): NewsAction | null {
  const version = item.game_version;
  if (version === null) return null;
  const matches = sortByRecency(instances.filter((i) => !i.placeholder && i.mcVersion === version));
  return matches.length > 0 ? { kind: "open", instance: matches[0] } : { kind: "create", mcVersion: version };
}
