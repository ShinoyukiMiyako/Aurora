// 主页上与实例挑选有关的纯函数：「继续游玩」指向谁、「最近游玩」列哪几个、「换一个」菜单列哪几项。

import type { InstanceSummary } from "../../domain/adapt";
import type { WorldDto } from "../../state/queries/instance";
import type { TierName } from "../../ui/Card";

/** 最近游玩按档位列的张数。 */
export const RECENT_COUNT: Readonly<Record<TierName, number>> = { compact: 4, regular: 5, wide: 6 };
/** 「换一个」菜单最多列几个实例（之后是「全部实例」）。 */
export const SWITCH_MENU_LIMIT = 8;

/** 排序用的新近度：玩过按上次游玩，没玩过按创建时刻；两者都没有为 null，排在最后。 */
export function recencyOf(inst: InstanceSummary): number | null {
  if (inst.lastPlayedAt !== null) return inst.lastPlayedAt;
  return inst.createdAt;
}

function byRecencyDesc(a: InstanceSummary, b: InstanceSummary): number {
  const ra = recencyOf(a);
  const rb = recencyOf(b);
  if (ra === null && rb === null) return 0;
  if (ra === null) return 1;
  if (rb === null) return -1;
  return rb - ra;
}

/** 按新近度倒序（稳定排序，同值保持实例列表顺序）。 */
export function sortByRecency(instances: readonly InstanceSummary[]): InstanceSummary[] {
  return [...instances].sort(byRecencyDesc);
}

/**
 * 「继续游玩」大卡指向的实例：配置里的当前实例；没有设过（或设过的已被删除）时取最近玩过或最新建的一个，
 * 新建的第一个实例在安装期间也就显示在这里。一个实例都没有时为 null。
 */
export function continueTarget(instances: readonly InstanceSummary[], selectedId: string | null): InstanceSummary | null {
  if (selectedId !== null) {
    const selected = instances.find((i) => i.id === selectedId);
    if (selected !== undefined) return selected;
  }
  const sorted = sortByRecency(instances);
  return sorted.length === 0 ? null : sorted[0];
}

/** 最近游玩：排除大卡上的实例与从没玩过的，按上次游玩倒序取前 count 个。 */
export function recentInstances(instances: readonly InstanceSummary[], currentId: string | null, count: number): InstanceSummary[] {
  return instances
    .filter((i): i is InstanceSummary & { lastPlayedAt: number } => i.id !== currentId && i.lastPlayedAt !== null)
    .sort((a, b) => b.lastPlayedAt - a.lastPlayedAt)
    .slice(0, count);
}

export interface SwitchOption {
  id: string;
  name: string;
  current: boolean;
  /** 菜单右侧提示：当前项写「当前」，其余写游戏版本；版本识别不出时没有提示。 */
  mcVersion: string | null;
}

/** 「换一个」菜单的实例项：按新近度倒序最多 8 个；当前实例总在其中（排不进前 8 时替换掉最后一个）。 */
export function switchOptions(instances: readonly InstanceSummary[], currentId: string): SwitchOption[] {
  const sorted = sortByRecency(instances);
  let picked = sorted.slice(0, SWITCH_MENU_LIMIT);
  if (!picked.some((i) => i.id === currentId)) {
    const current = sorted.find((i) => i.id === currentId);
    if (current === undefined) throw new Error(`当前实例 ${currentId} 不在实例列表里`);
    picked = [...picked.slice(0, SWITCH_MENU_LIMIT - 1), current];
  }
  return picked.map((i) => ({ id: i.id, name: i.name, current: i.id === currentId, mcVersion: i.mcVersion }));
}

/**
 * 「继续游玩」信息行里的存档：level.dat 记的最后游玩时刻最新的那个；读不出游玩时刻的存档按目录修改时刻排在后面，
 * 两者都没有的不参与。没有可选的存档时为 null（信息行省略这一段）。
 */
export function latestWorld(worlds: readonly WorldDto[]): WorldDto | null {
  const played = worlds.filter((w): w is WorldDto & { last_played: number } => w.last_played !== null);
  if (played.length > 0) return played.reduce((a, b) => (b.last_played > a.last_played ? b : a));
  const touched = worlds.filter((w): w is WorldDto & { modified_at: number } => w.modified_at !== null);
  if (touched.length > 0) return touched.reduce((a, b) => (b.modified_at > a.modified_at ? b : a));
  return null;
}

/** 存档的显示名：level.dat 读不出名字时用目录名。 */
export function worldName(world: WorldDto): string {
  return world.name === null ? world.dir_name : world.name;
}
