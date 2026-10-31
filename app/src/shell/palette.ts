// 命令面板的条目匹配与排序（纯函数）。条目由面板组件按当前状态构造，这里只决定哪些留下、按什么顺序。
//
// 匹配等级（越小越靠前）：0 名称完全相同，1 名称以查询开头，2 名称里某个词以查询开头，
// 3 名称包含查询，4 关键词（英文名、拼音、拼音首字母、版本号）以查询开头或包含查询。不区分大小写。
// 分组顺序固定：实例、跳转、操作、账户、资源；组内按等级、等级相同保持构造顺序。
// 空查询：实例只列最近游玩的 5 个（从没玩过的排最后），其余各组全列，没有资源组。

export type PaletteGroup = "instance" | "jump" | "action" | "account" | "resource";

export const PALETTE_GROUPS: readonly PaletteGroup[] = ["instance", "jump", "action", "account", "resource"];

/** 空查询时实例组只列这么多个。 */
export const RECENT_INSTANCE_LIMIT = 5;

export interface PaletteCandidate {
  id: string;
  group: PaletteGroup;
  label: string;
  /** 参与匹配但不显示的词。 */
  keywords: readonly string[];
  /** 实例条目的最近游玩时间（空查询时排序用）；其余条目为 null。 */
  lastPlayedAt: number | null;
}

/** 词边界：空格、连字符、下划线、间隔号、点。 */
const WORD_SPLIT = /[\s\-_·.]+/;

export function normalizeQuery(query: string): string {
  return query.trim().toLowerCase();
}

export function matchLevel(query: string, label: string, keywords: readonly string[]): number | null {
  const q = normalizeQuery(query);
  if (q === "") return 0;
  const name = label.toLowerCase();
  if (name === q) return 0;
  if (name.startsWith(q)) return 1;
  if (name.split(WORD_SPLIT).some((word) => word !== "" && word.startsWith(q))) return 2;
  if (name.includes(q)) return 3;
  if (keywords.some((k) => k.toLowerCase().includes(q))) return 4;
  return null;
}

/** 空查询时的最近游玩排序：时间新的在前，从没玩过的排最后，相同时保持原顺序。 */
function byRecent<T extends PaletteCandidate>(a: T, b: T): number {
  if (a.lastPlayedAt === b.lastPlayedAt) return 0;
  if (a.lastPlayedAt === null) return 1;
  if (b.lastPlayedAt === null) return -1;
  return b.lastPlayedAt - a.lastPlayedAt;
}

export interface PaletteSection<T extends PaletteCandidate> {
  group: PaletteGroup;
  items: T[];
}

/** 过滤、排序并分组。资源组条目由调用方只在查询非空时提供。 */
export function rankPalette<T extends PaletteCandidate>(query: string, candidates: readonly T[]): PaletteSection<T>[] {
  const empty = normalizeQuery(query) === "";
  const sections: PaletteSection<T>[] = [];
  for (const group of PALETTE_GROUPS) {
    const members = candidates.filter((c) => c.group === group);
    let items: T[];
    if (empty) {
      if (group === "resource") continue;
      items = group === "instance" ? [...members].sort(byRecent).slice(0, RECENT_INSTANCE_LIMIT) : members;
    } else {
      items = members
        .map((item, order) => ({ item, order, level: group === "resource" ? 0 : matchLevel(query, item.label, item.keywords) }))
        .filter((m): m is { item: T; order: number; level: number } => m.level !== null)
        .sort((a, b) => a.level - b.level || a.order - b.order)
        .map((m) => m.item);
    }
    if (items.length > 0) sections.push({ group, items });
  }
  return sections;
}

/** 高亮移动：首尾循环；没有条目时为 -1。 */
export function moveHighlight(current: number, delta: 1 | -1, count: number): number {
  if (count === 0) return -1;
  if (current < 0) return delta === 1 ? 0 : count - 1;
  return (current + delta + count) % count;
}
