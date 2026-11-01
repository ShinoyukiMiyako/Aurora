import { describe, expect, it } from "vitest";
import { HOME_COPY, greeting, mondayIndex } from "./copy";

const at = (h: number, m = 0) => new Date(2026, 9, 30, h, m);

describe("问候与日期行", () => {
  it("问候按钟点分段，边界钟点归后一段", () => {
    expect([at(0), at(4, 59), at(5), at(10, 59), at(11), at(13, 59), at(14), at(17, 59), at(18), at(23, 59)].map(greeting)).toEqual([
      "夜深了",
      "夜深了",
      "早上好",
      "早上好",
      "中午好",
      "中午好",
      "下午好",
      "下午好",
      "晚上好",
      "晚上好",
    ]);
  });

  it("日期行写月日与星期，周一为一周之首", () => {
    expect(HOME_COPY.dateLine(new Date(2026, 9, 30))).toBe("10月30日 · 星期五");
    expect(HOME_COPY.dateLine(new Date(2026, 10, 1))).toBe("11月1日 · 星期日");
    expect(mondayIndex(new Date(2026, 10, 2))).toBe(0);
  });

  it("环比与服务器人数的写法", () => {
    expect(HOME_COPY.weekDelta(12)).toBe("较前 7 天 +12%");
    expect(HOME_COPY.weekDelta(0)).toBe("较前 7 天 +0%");
    expect(HOME_COPY.weekDelta(-8)).toBe("较前 7 天 -8%");
    expect(HOME_COPY.online(25_000, 200_000)).toBe("2.5 万/20 万 在线");
    expect(HOME_COPY.calendarSubtitle(2026, 10, 18, 2480)).toBe("2026年10月 · 18 天 · 共 41 小时 20 分钟");
  });
});
