// 游玩日历与游玩洞察的推算。全部基于本地日历日（YYYY-MM-DD）：后端按本地日期记录，这里不做时区换算。
// play_stats 只列出有游玩的日子；区间内没列出的日子就是这天没玩（0 分钟），不是缺数据。

import type { InstanceSummary } from "../../domain/adapt";
import type { LoaderKind } from "../../domain/types";
import type { PlayDayDto, PlayRangeArgs, PlayStatsDto } from "../../state/queries/home";
import { addDays, addMonths, monthOf } from "../../ui/CalendarHeatmap";

/** 日历最多回溯 12 个月（本月之外再往前 12 个月），后端的游玩记录保留期覆盖这个范围。 */
export const CALENDAR_LOOKBACK_MONTHS = 12;
/** 常玩加载器的统计窗口。 */
export const LOADER_WINDOW_DAYS = 30;
/** 近 7 天柱的天数，也是环比的窗口。 */
export const WEEK_DAYS = 7;
/** 环比绝对值小于 3% 记为持平。 */
export const FLAT_RATIO = 0.03;
/** 近 7 天柱的最低填充：没玩的日子也留一截，柱槽读起来是「有这一天」。 */
export const BAR_MIN_FILL = 0.04;

const pad2 = (n: number) => String(n).padStart(2, "0");

/** 时刻所在的本地日历日。 */
export function localDateKey(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** 一次取够日历、环比、连续天数与加载器占比要用的全部日子：最早可翻到的月份 1 日到今天。 */
export function statsRange(today: string): PlayRangeArgs {
  return { from: `${addMonths(monthOf(today), -CALENDAR_LOOKBACK_MONTHS)}-01`, to: today };
}

/** 以 today 结尾、按日期升序的 n 天。 */
export function lastDays(today: string, n: number, skip = 0): string[] {
  return Array.from({ length: n }, (_, i) => addDays(today, i - n + 1 - skip));
}

export interface PlayActivity {
  today: string;
  /** 有游玩的日子。 */
  days: ReadonlyMap<string, PlayDayDto>;
  /** 区间内有没有任何一天的游玩。 */
  hasRecords: boolean;
  /**
   * 日历格的分钟数：第一条记录（没有记录时为本月 1 日）到今天的每一天都有键，没玩为 0；
   * 之前的日子与未来日子没有键，日历上不可选。
   */
  calendar: ReadonlyMap<string, number>;
  /** 日历可翻到的月份范围（含两端），YYYY-MM。 */
  minMonth: string;
  maxMonth: string;
}

export function buildActivity(stats: PlayStatsDto, today: string): PlayActivity {
  const days = new Map<string, PlayDayDto>();
  for (const day of stats.days) {
    // 系统时钟回拨时后端可能记下「未来」的日子；日历只到今天，未来的记录不参与任何统计
    if (day.date <= today) days.set(day.date, day);
  }
  const dates = [...days.keys()].sort();
  const hasRecords = dates.length > 0;
  const start = hasRecords ? dates[0] : `${monthOf(today)}-01`;
  const calendar = new Map<string, number>();
  for (let date = start; date <= today; date = addDays(date, 1)) {
    const day = days.get(date);
    calendar.set(date, day === undefined ? 0 : day.minutes);
  }
  return { today, days, hasRecords, calendar, minMonth: monthOf(start), maxMonth: monthOf(today) };
}

/** 某天玩了多少分钟；区间内没列出的日子是 0。 */
export function minutesOn(activity: PlayActivity, date: string): number {
  const day = activity.days.get(date);
  return day === undefined ? 0 : day.minutes;
}

/** 截至今天的连续游玩天数；今天还没玩时从昨天往前数，今天不算断。 */
export function streakDays(activity: PlayActivity): number {
  let date = minutesOn(activity, activity.today) > 0 ? activity.today : addDays(activity.today, -1);
  let n = 0;
  while (minutesOn(activity, date) > 0) {
    n += 1;
    date = addDays(date, -1);
  }
  return n;
}

export interface WeekCompare {
  /** 近 7 天（含今天）的分钟和。 */
  total: number;
  /** 再往前 7 天的分钟和。 */
  previous: number;
  /** 相对前 7 天的变化率；前 7 天为 0 时没有可比基数，为 null。 */
  ratio: number | null;
}

export function weekCompare(activity: PlayActivity): WeekCompare {
  const sum = (dates: string[]) => dates.reduce((t, d) => t + minutesOn(activity, d), 0);
  const total = sum(lastDays(activity.today, WEEK_DAYS));
  const previous = sum(lastDays(activity.today, WEEK_DAYS, WEEK_DAYS));
  return { total, previous, ratio: previous === 0 ? null : (total - previous) / previous };
}

export type DeltaDirection = "up" | "down" | "flat";

/** 环比的方向；持平阈值见 FLAT_RATIO。 */
export function weekDirection(ratio: number | null): DeltaDirection {
  if (ratio === null || Math.abs(ratio) < FLAT_RATIO) return "flat";
  return ratio > 0 ? "up" : "down";
}

/** 环比的百分数（取整）；-0 记为 0。 */
export function ratioPercent(ratio: number): number {
  const value = Math.round(ratio * 100);
  return value === 0 ? 0 : value;
}

export interface MonthSummary {
  playedDays: number;
  minutes: number;
}

/** 一个月（YYYY-MM）里有游玩的天数与分钟合计。 */
export function monthSummary(activity: PlayActivity, month: string): MonthSummary {
  let playedDays = 0;
  let minutes = 0;
  for (const [date, day] of activity.days) {
    if (monthOf(date) !== month) continue;
    minutes += day.minutes;
    if (day.minutes > 0) playedDays += 1;
  }
  return { playedDays, minutes };
}

export interface LoaderShare {
  loader: LoaderKind;
  /** 0-1。 */
  share: number;
}

/**
 * 近 30 天时长最多的加载器。按每天每个实例实际玩的分钟归到它的加载器；已删除的实例（不在列表里）不计，
 * 占比的分母也不含它们。没有可归属的时长时为 null。并列时取先累计到的那个（实例列表顺序）。
 */
export function topLoader(activity: PlayActivity, instances: readonly InstanceSummary[]): LoaderShare | null {
  const loaderOf = new Map(instances.map((i) => [i.id, i.loader]));
  const totals = new Map<LoaderKind, number>();
  let all = 0;
  for (const date of lastDays(activity.today, LOADER_WINDOW_DAYS)) {
    const day = activity.days.get(date);
    if (day === undefined) continue;
    for (const entry of day.instances) {
      const loader = loaderOf.get(entry.version_id);
      if (loader === undefined || entry.minutes <= 0) continue;
      const before = totals.get(loader);
      totals.set(loader, (before === undefined ? 0 : before) + entry.minutes);
      all += entry.minutes;
    }
  }
  if (all === 0) return null;
  let best: { loader: LoaderKind; minutes: number } | null = null;
  for (const [loader, minutes] of totals) {
    if (best === null || minutes > best.minutes) best = { loader, minutes };
  }
  if (best === null) throw new Error("有可归属的游玩时长却没有加载器");
  return { loader: best.loader, share: best.minutes / all };
}

/** 近 7 天柱顶的数值：满 1 小时写「1.5h」（一位小数，整点不写 .0），否则写「42m」。 */
export function barValue(minutes: number): string {
  if (minutes >= 60) return `${(minutes / 60).toFixed(1).replace(/\.0$/, "")}h`;
  return `${Math.round(minutes)}m`;
}

/** 柱的填充比例：相对 7 天里的最大值，最低 4%。 */
export function barFill(minutes: number, max: number): number {
  if (max <= 0) return BAR_MIN_FILL;
  return Math.max(BAR_MIN_FILL, Math.min(1, minutes / max));
}

/** 全部实例的累计时长（整小时）与实例数；新建、导入中的占位项不算。 */
export function totalPlaytime(instances: readonly InstanceSummary[]): { hours: number; count: number } {
  const real = instances.filter((i) => !i.placeholder);
  const minutes = real.reduce((t, i) => t + i.playtimeMin, 0);
  return { hours: Math.round(minutes / 60), count: real.length };
}

/** 游玩记录要不要重取：任一实例的累计时长或上次游玩时刻变了（游戏退出后实例列表刷新）。 */
export function playSignature(instances: readonly InstanceSummary[]): string {
  return instances
    .filter((i) => !i.placeholder)
    .map((i) => `${i.id}:${i.playtimeMin}:${i.lastPlayedAt === null ? "-" : i.lastPlayedAt}`)
    .sort()
    .join("|");
}
