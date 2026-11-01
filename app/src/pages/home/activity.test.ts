import { describe, expect, it } from "vitest";
import type { PlayDayDto, PlayStatsDto } from "../../state/queries/home";
import {
  BAR_MIN_FILL,
  barFill,
  barValue,
  buildActivity,
  lastDays,
  localDateKey,
  minutesOn,
  monthSummary,
  ratioPercent,
  statsRange,
  streakDays,
  topLoader,
  totalPlaytime,
  weekCompare,
  weekDirection,
} from "./activity";
import { summary } from "./test-data";

const TODAY = "2026-10-30";

function day(date: string, minutes: number, instances: [string, number][] = [["生存", minutes]]): PlayDayDto {
  return { date, minutes, instances: instances.map(([version_id, m]) => ({ version_id, minutes: m })) };
}

function stats(days: PlayDayDto[]): PlayStatsDto {
  return { from: "2025-10-01", to: TODAY, days, total_minutes: days.reduce((t, d) => t + d.minutes, 0), instances: [] };
}

const inst = summary;

/** 随机但可复现的分钟数：线性同余，种子固定。 */
function seeded(seed: number): () => number {
  let x = seed;
  return () => {
    x = (x * 1103515245 + 12345) % 2147483648;
    return x / 2147483648;
  };
}

describe("日期与区间", () => {
  it("localDateKey 按本地日历日补零", () => {
    expect(localDateKey(new Date(2026, 0, 5, 23, 59).getTime())).toBe("2026-01-05");
    expect(localDateKey(new Date(2026, 11, 31, 0, 0).getTime())).toBe("2026-12-31");
  });

  it("statsRange 从 12 个月前那个月的 1 日取到今天，跨年也对", () => {
    expect(statsRange(TODAY)).toEqual({ from: "2025-10-01", to: TODAY });
    expect(statsRange("2026-01-15")).toEqual({ from: "2025-01-01", to: "2026-01-15" });
  });

  it("lastDays 以今天结尾升序，skip 往前错开整段", () => {
    expect(lastDays("2026-03-02", 4)).toEqual(["2026-02-27", "2026-02-28", "2026-03-01", "2026-03-02"]);
    expect(lastDays(TODAY, 2, 7)).toEqual(["2026-10-22", "2026-10-23"]);
  });
});

describe("buildActivity：日历格", () => {
  it("第一条记录到今天每天都有键，没玩为 0；之前与未来的日子没有键", () => {
    const a = buildActivity(stats([day("2026-10-27", 45), day("2026-10-29", 130), day("2026-11-02", 30)]), TODAY);
    expect([...a.calendar.entries()]).toEqual([
      ["2026-10-27", 45],
      ["2026-10-28", 0],
      ["2026-10-29", 130],
      ["2026-10-30", 0],
    ]);
    expect(a.calendar.has("2026-10-26")).toBe(false);
    expect(a.days.has("2026-11-02")).toBe(false);
    expect(a.hasRecords).toBe(true);
    expect([a.minMonth, a.maxMonth]).toEqual(["2026-10", "2026-10"]);
  });

  it("记录不按日期排序时仍从最早那天开始，最早月份决定可翻到的下限", () => {
    const a = buildActivity(stats([day("2026-10-01", 10), day("2026-08-31", 20)]), TODAY);
    expect(a.minMonth).toBe("2026-08");
    expect(a.calendar.get("2026-08-31")).toBe(20);
    expect(a.calendar.get("2026-09-15")).toBe(0);
    expect(a.calendar.size).toBe(61);
  });

  it("一条记录都没有：本月 1 日到今天全是 0，只能看本月", () => {
    const a = buildActivity(stats([]), TODAY);
    expect(a.hasRecords).toBe(false);
    expect(a.calendar.size).toBe(30);
    expect([...a.calendar.values()].every((m) => m === 0)).toBe(true);
    expect([a.minMonth, a.maxMonth]).toEqual(["2026-10", "2026-10"]);
  });
});

describe("连续天数与环比", () => {
  it("今天玩了从今天往回数，遇到没玩的一天就断", () => {
    const a = buildActivity(stats([day("2026-10-26", 5), day("2026-10-28", 1), day("2026-10-29", 60), day("2026-10-30", 15)]), TODAY);
    expect(streakDays(a)).toBe(3);
  });

  it("今天还没玩从昨天往前数，今天不算断", () => {
    const a = buildActivity(stats([day("2026-10-28", 30), day("2026-10-29", 30)]), TODAY);
    expect(streakDays(a)).toBe(2);
  });

  it("昨天今天都没玩为 0；不足 1 分钟的记录不算游玩", () => {
    expect(streakDays(buildActivity(stats([day("2026-10-27", 90)]), TODAY))).toBe(0);
    expect(streakDays(buildActivity(stats([day("2026-10-29", 0), day("2026-10-30", 0)]), TODAY))).toBe(0);
  });

  it("近 7 天含今天，前 7 天为再往前一段；两段的边界日各归其段，更早的不计", () => {
    const a = buildActivity(
      stats([day("2026-10-16", 999), day("2026-10-17", 100), day("2026-10-23", 20), day("2026-10-24", 50), day("2026-10-30", 70)]),
      TODAY,
    );
    const w = weekCompare(a);
    expect(w.total).toBe(120);
    expect(w.previous).toBe(120);
    expect(w.ratio).toBe(0);
  });

  it("前 7 天为 0 时没有可比基数", () => {
    const w = weekCompare(buildActivity(stats([day("2026-10-30", 30)]), TODAY));
    expect(w).toEqual({ total: 30, previous: 0, ratio: null });
  });

  it("方向：|变化率| < 3% 持平，否则按正负；百分数取整且不出现 -0", () => {
    expect(weekDirection(null)).toBe("flat");
    expect(weekDirection(0.0299)).toBe("flat");
    expect(weekDirection(-0.0299)).toBe("flat");
    expect(weekDirection(0.03)).toBe("up");
    expect(weekDirection(-0.03)).toBe("down");
    expect(ratioPercent(0.124)).toBe(12);
    expect(ratioPercent(-0.126)).toBe(-13);
    expect(Object.is(ratioPercent(-0.004), 0)).toBe(true);
  });
});

describe("月份汇总", () => {
  it("只数当月有游玩（分钟 > 0）的天，分钟合计含不足 1 分钟的记录", () => {
    const a = buildActivity(stats([day("2026-09-30", 40), day("2026-10-01", 0), day("2026-10-02", 25), day("2026-10-30", 75)]), TODAY);
    expect(monthSummary(a, "2026-10")).toEqual({ playedDays: 2, minutes: 100 });
    expect(monthSummary(a, "2026-09")).toEqual({ playedDays: 1, minutes: 40 });
    expect(monthSummary(a, "2026-08")).toEqual({ playedDays: 0, minutes: 0 });
  });

  it("随机数据：月合计等于逐日相加", () => {
    const random = seeded(20231);
    const days = Array.from({ length: 30 }, (_, i) => day(`2026-10-${String(i + 1).padStart(2, "0")}`, Math.floor(random() * 300)));
    const a = buildActivity(stats(days), TODAY);
    const expected = days.filter((d) => d.date <= TODAY).reduce((t, d) => t + d.minutes, 0);
    expect(monthSummary(a, "2026-10").minutes).toBe(expected);
    expect(minutesOn(a, "2026-10-12")).toBe(days[11].minutes);
  });
});

describe("常玩加载器", () => {
  const instances = [inst("生存", { loader: "fabric" }), inst("机械", { loader: "forge" }), inst("原版")];

  it("按每个实例实际玩的分钟归到加载器，占比分母不含已删除的实例", () => {
    const a = buildActivity(
      stats([
        day("2026-10-29", 80, [
          ["生存", 40],
          ["机械", 20],
          ["已删除", 20],
        ]),
        day("2026-10-30", 40, [["机械", 40]]),
      ]),
      TODAY,
    );
    expect(topLoader(a, instances)).toEqual({ loader: "forge", share: 0.6 });
  });

  it("只统计近 30 天：第 31 天前的记录不计", () => {
    const a = buildActivity(stats([day("2026-09-30", 500, [["生存", 500]]), day("2026-10-01", 10, [["机械", 10]])]), TODAY);
    expect(topLoader(a, instances)).toEqual({ loader: "forge", share: 1 });
  });

  it("没有可归属的时长（都是已删除的实例或 0 分钟）为 null", () => {
    const a = buildActivity(stats([day("2026-10-30", 30, [["已删除", 30]]), day("2026-10-29", 0, [["生存", 0]])]), TODAY);
    expect(topLoader(a, instances)).toBeNull();
  });
});

describe("近 7 天柱与累计", () => {
  it("柱顶数值：满 60 分钟写小时（一位小数，整点不写 .0），否则写分钟", () => {
    expect(barValue(0)).toBe("0m");
    expect(barValue(59)).toBe("59m");
    expect(barValue(60)).toBe("1h");
    expect(barValue(90)).toBe("1.5h");
    expect(barValue(125)).toBe("2.1h");
  });

  it("填充按 7 天最大值，最低 4%，最大值为 0 时全部 4%", () => {
    expect(barFill(0, 120)).toBe(BAR_MIN_FILL);
    expect(barFill(3, 120)).toBe(BAR_MIN_FILL);
    expect(barFill(60, 120)).toBe(0.5);
    expect(barFill(120, 120)).toBe(1);
    expect(barFill(0, 0)).toBe(BAR_MIN_FILL);
  });

  it("累计时长按整小时四舍五入，占位项不计", () => {
    const list = [inst("a", { playtimeMin: 90 }), inst("b", { playtimeMin: 29 }), inst("c", { playtimeMin: 600, placeholder: true })];
    expect(totalPlaytime(list)).toEqual({ hours: 2, count: 2 });
    expect(totalPlaytime([])).toEqual({ hours: 0, count: 0 });
  });

  it("有实例的游玩记录读不出时小时数为 null，实例数照算；占位项不影响", () => {
    const list = [inst("a", { playtimeMin: 90 }), inst("b", { playtimeMin: null }), inst("c", { playtimeMin: 0, placeholder: true })];
    expect(totalPlaytime(list)).toEqual({ hours: null, count: 2 });
  });
});
