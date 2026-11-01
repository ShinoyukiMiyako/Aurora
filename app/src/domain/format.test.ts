import { describe, expect, it } from "vitest";
import {
  clock,
  formatBytes,
  formatCount,
  formatDate,
  formatElapsed,
  formatMemory,
  formatPlaytime,
  formatPlaytimeShort,
  formatRelative,
  formatSpeed,
  percent,
} from "./format";

const KB = 1024;
const MB = 1024 * KB;
const GB = 1024 * MB;
const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const randomInt = (min: number, max: number) => min + Math.floor(Math.random() * (max - min + 1));

describe("formatCount", () => {
  it.each([
    [0, "0"],
    [2341, "2,341"],
    [9999, "9,999"],
    [10_000, "1 万"],
    [98_000, "9.8 万"],
    [1_000_000, "100 万"],
    [12_345_678, "1235 万"],
    [99_999_999, "1 亿"],
    [100_000_000, "1 亿"],
    [120_000_000, "1.2 亿"],
    [12_345_678_900, "123 亿"],
  ])("%d -> %s", (n, text) => {
    expect(formatCount(n)).toBe(text);
  });

  it("随机计数的数字部分不出现末尾 .0，万档不到 1 万", () => {
    for (let i = 0; i < 500; i++) {
      const text = formatCount(randomInt(10_000, 2_000_000_000));
      const [num, unit] = text.split(" ");
      expect(num).not.toMatch(/\.0$/);
      if (unit === "万") expect(Number(num)).toBeLessThan(10_000);
      if (Number(num) >= 100) expect(num).toMatch(/^\d+$/);
    }
  });
});

describe("formatBytes / formatSpeed", () => {
  it.each([
    [0, "0 B"],
    [1023, "1023 B"],
    [KB, "1.0 KB"],
    [Math.round(52.4 * MB), "52.4 MB"],
    [612 * MB, "612 MB"],
    [Math.round(99.96 * KB), "100 KB"],
    [MB - 1, "1.0 MB"],
    [Math.round(1023.96 * MB), "1.0 GB"],
    [5 * 1024 * GB, "5120 GB"],
  ])("%d -> %s", (bytes, text) => {
    expect(formatBytes(bytes)).toBe(text);
  });

  it("速度在字节后加 /s", () => {
    expect(formatSpeed(Math.round(4.2 * MB))).toBe("4.2 MB/s");
    expect(formatSpeed(512)).toBe("512 B/s");
  });

  it("随机字节：KB 与 MB 档数字不到 1024，≥ 100 不带小数", () => {
    for (let i = 0; i < 500; i++) {
      const text = formatBytes(randomInt(KB, 50 * GB));
      const match = text.match(/^(\d+(?:\.\d)?) (KB|MB|GB)$/);
      expect(match).not.toBeNull();
      const [, num, unit] = match as RegExpMatchArray;
      if (unit !== "GB") expect(Number(num)).toBeLessThan(1024);
      expect(num.includes(".")).toBe(Number(num) < 100);
    }
  });
});

describe("formatMemory / percent", () => {
  it.each([
    [512, "512 MB"],
    [1023, "1023 MB"],
    [1024, "1 GB"],
    [4096, "4 GB"],
    [6656, "6.5 GB"],
  ])("%d MB -> %s", (mb, text) => {
    expect(formatMemory(mb)).toBe(text);
  });

  it("百分比取整，加载阶段封顶 99%", () => {
    expect(percent(0.374)).toBe("37%");
    expect(percent(0.995)).toBe("100%");
    expect(percent(1)).toBe("100%");
    expect(percent(0.996, true)).toBe("99%");
    expect(percent(1, true)).toBe("99%");
    expect(percent(0.5, true)).toBe("50%");
  });
});

describe("时长", () => {
  it.each([
    [0, "0 分钟"],
    [45, "45 分钟"],
    [59.6, "1 小时"],
    [60, "1 小时"],
    [119.5, "2 小时"],
    [200, "3 小时 20 分钟"],
  ])("formatPlaytime(%d) -> %s", (minutes, text) => {
    expect(formatPlaytime(minutes)).toBe(text);
  });

  it.each([
    [42, "42m"],
    [59.4, "59m"],
    [59.6, "1h"],
    [8280, "138h"],
  ])("formatPlaytimeShort(%d) -> %s", (minutes, text) => {
    expect(formatPlaytimeShort(minutes)).toBe(text);
  });

  it.each([
    [-5, "00:00"],
    [0, "00:00"],
    [192 * SECOND, "03:12"],
    [HOUR - 1, "59:59"],
    [HOUR, "1:00:00"],
    [HOUR + 3 * MINUTE + 12 * SECOND, "1:03:12"],
  ])("formatElapsed(%d) -> %s", (ms, text) => {
    expect(formatElapsed(ms)).toBe(text);
  });
});

describe("formatRelative", () => {
  const now = Date.UTC(2026, 9, 30, 12, 0, 0);

  it("null 只表示从未游玩", () => {
    expect(formatRelative(null, now)).toBe("从未游玩");
  });

  it.each([
    [0, "1 秒前"],
    [-30 * SECOND, "1 秒前"],
    [59_999, "59 秒前"],
    [MINUTE, "1 分钟前"],
    [2 * MINUTE + 59 * SECOND, "2 分钟前"],
    [HOUR, "1 小时前"],
    [DAY - 1, "23 小时前"],
    [DAY, "昨天"],
    [2 * DAY - 1, "昨天"],
    [2 * DAY, "2 天前"],
    [29 * DAY, "29 天前"],
    [30 * DAY, "1 个月前"],
    [359 * DAY, "11 个月前"],
    [360 * DAY, "1 年前"],
    [364 * DAY, "1 年前"],
    [730 * DAY, "2 年前"],
  ])("早 %d ms -> %s", (ago, text) => {
    expect(formatRelative(now - ago, now)).toBe(text);
  });
});

describe("日期与钟点", () => {
  it("绝对日期不加空格，钟点 24 小时制补零", () => {
    expect(formatDate(new Date(2026, 9, 30, 19, 4, 12).getTime())).toBe("2026年10月30日");
    expect(formatDate(new Date(2027, 0, 5).getTime())).toBe("2027年1月5日");
    expect(clock(new Date(2026, 9, 30, 19, 4, 12).getTime())).toBe("19:04:12");
    expect(clock(new Date(2026, 9, 30, 9, 5, 7).getTime())).toBe("09:05:07");
  });
});
