// @vitest-environment jsdom
import { act, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { keydown, render, type Rendered } from "../test/dom";
import { addDays, addMonths, CalendarHeatmap, calendarDayLabel, daysInMonth, heatLevel, shiftMonthKeepDay, weekdayIndex } from "./CalendarHeatmap";

let view: Rendered | undefined;
afterEach(() => {
  view?.unmount();
  view = undefined;
});

describe("热力分档", () => {
  it.each([
    [0, 0],
    [0.5, 1],
    [1, 1],
    [59, 1],
    [59.9, 1],
    [60, 2],
    [119, 2],
    [120, 3],
    [199, 3],
    [199.9, 3],
    [200, 4],
    [100_000, 4],
  ])("%s 分钟为第 %i 档", (minutes, level) => {
    expect(heatLevel(minutes)).toBe(level);
  });

  it.each([-1, Number.NaN, Number.POSITIVE_INFINITY])("%s 分钟抛错", (minutes) => {
    expect(() => heatLevel(minutes)).toThrow(/非负有限数/);
  });
});

describe("日期运算", () => {
  it("周一为 0：2026-10-30 是周五，2026-10-01 是周四", () => {
    expect(weekdayIndex("2026-10-30")).toBe(4);
    expect(weekdayIndex("2026-10-01")).toBe(3);
    expect(weekdayIndex("2026-11-01")).toBe(6);
  });

  it("跨月、跨年、闰年", () => {
    expect(addDays("2026-10-31", 1)).toBe("2026-11-01");
    expect(addDays("2026-01-01", -1)).toBe("2025-12-31");
    expect(addDays("2024-02-28", 1)).toBe("2024-02-29");
    expect(addMonths("2026-12", 1)).toBe("2027-01");
    expect(addMonths("2026-01", -1)).toBe("2025-12");
    expect(daysInMonth(2026, 2)).toBe(28);
    expect(daysInMonth(2024, 2)).toBe(29);
  });

  it("翻月保持同一天，没有这一天落到月末", () => {
    expect(shiftMonthKeepDay("2026-03-31", -1)).toBe("2026-02-28");
    expect(shiftMonthKeepDay("2024-03-31", -1)).toBe("2024-02-29");
    expect(shiftMonthKeepDay("2026-10-15", 1)).toBe("2026-11-15");
  });

  it("非法日期键抛错", () => {
    expect(() => addDays("2026-02-30", 1)).toThrow(/不存在的日期/);
    expect(() => addDays("2026/10/01", 1)).toThrow(/YYYY-MM-DD/);
  });

  it("单格名称写日期、星期、时长；没有记录与今天另说明", () => {
    expect(calendarDayLabel("2026-10-30", 135, true)).toBe("10月30日 周五，游玩 2 小时 15 分钟，今天");
    expect(calendarDayLabel("2026-10-29", 0, false)).toBe("10月29日 周四，没有游玩");
    expect(calendarDayLabel("2026-10-31", undefined, false)).toBe("10月31日 周六，无记录");
  });
});

const DATA = new Map<string, number>([
  ["2026-10-01", 0],
  ["2026-10-02", 30],
  ["2026-10-03", 90],
  ["2026-10-04", 150],
  ["2026-10-05", 240],
  ["2026-10-29", 45],
  ["2026-10-30", 135],
  ["2026-11-02", 10],
]);

function Harness({ onSelect, onMonthChange, max = "2026-11" }: { onSelect?: (d: string) => void; onMonthChange?: (m: string) => void; max?: string }) {
  const [month, setMonth] = useState("2026-10");
  const [selected, setSelected] = useState<string | null>("2026-10-30");
  return (
    <CalendarHeatmap
      month={month}
      minutes={DATA}
      today="2026-10-30"
      selected={selected}
      onSelect={(d) => {
        setSelected(d);
        onSelect?.(d);
      }}
      onMonthChange={(m) => {
        setMonth(m);
        onMonthChange?.(m);
      }}
      minMonth="2026-09"
      maxMonth={max}
    />
  );
}

const day = (date: string) => {
  const el = document.querySelector<HTMLButtonElement>(`button[data-date="${date}"]`);
  if (!el) throw new Error(`没有 ${date} 这一格`);
  return el;
};

describe("CalendarHeatmap", () => {
  it("网格结构：周一开始，2026 年 10 月前空 3 格、共 5 周", () => {
    view = render(<Harness />);
    const grid = document.querySelector('[role="grid"]') as HTMLElement;
    expect(grid.getAttribute("aria-label")).toBe("2026 年 10 月游玩日历");
    const rowsEl = grid.querySelectorAll('[role="row"]');
    expect(rowsEl).toHaveLength(6);
    expect([...rowsEl[0].children].map((c) => c.textContent)).toEqual(["一", "二", "三", "四", "五", "六", "日"]);
    const firstWeek = [...rowsEl[1].children];
    expect(firstWeek.slice(0, 3).every((c) => c.querySelector("button") === null)).toBe(true);
    expect(firstWeek[3].querySelector("button")?.dataset.date).toBe("2026-10-01");
    expect(grid.querySelectorAll("button[data-date]")).toHaveLength(31);
  });

  it("每格按分钟分档，没有记录的格为 none 且禁用", () => {
    view = render(<Harness />);
    expect(["01", "02", "03", "04", "05", "06"].map((d) => day(`2026-10-${d}`).dataset.level)).toEqual(["0", "1", "2", "3", "4", "none"]);
    expect(day("2026-10-06").getAttribute("aria-disabled")).toBe("true");
    expect(day("2026-10-02").hasAttribute("aria-disabled")).toBe(false);
  });

  it("今天与选中：aria-current、aria-selected，Tab 停在选中格", () => {
    view = render(<Harness />);
    expect(day("2026-10-30").getAttribute("aria-current")).toBe("date");
    expect(day("2026-10-30").dataset.today).toBe("true");
    expect(day("2026-10-30").parentElement?.getAttribute("aria-selected")).toBe("true");
    expect(day("2026-10-29").parentElement?.getAttribute("aria-selected")).toBe("false");
    expect([...document.querySelectorAll<HTMLButtonElement>("button[data-date]")].filter((b) => b.tabIndex === 0).map((b) => b.dataset.date)).toEqual(["2026-10-30"]);
  });

  it("点有记录的格选中它；没有记录的格点击无效", () => {
    const onSelect = vi.fn();
    view = render(<Harness onSelect={onSelect} />);
    act(() => day("2026-10-31").click());
    expect(onSelect).not.toHaveBeenCalled();
    act(() => day("2026-10-03").click());
    expect(onSelect).toHaveBeenCalledWith("2026-10-03");
    expect(day("2026-10-03").dataset.selected).toBe("true");
  });

  it("方向键按天与按周移动，Home / End 到本周首尾但不越出当月", () => {
    view = render(<Harness />);
    act(() => day("2026-10-30").focus());
    keydown(day("2026-10-30"), "ArrowLeft");
    expect(document.activeElement).toBe(day("2026-10-29"));
    keydown(day("2026-10-29"), "ArrowUp");
    expect(document.activeElement).toBe(day("2026-10-22"));
    keydown(day("2026-10-22"), "Home");
    expect(document.activeElement).toBe(day("2026-10-19"));
    keydown(day("2026-10-19"), "End");
    expect(document.activeElement).toBe(day("2026-10-25"));
    act(() => day("2026-10-02").focus());
    keydown(day("2026-10-02"), "Home");
    expect(document.activeElement).toBe(day("2026-10-01"));
    expect(day("2026-10-01").tabIndex).toBe(0);
  });

  it("越过月界请求翻月，并在新月份里聚焦目标日", () => {
    const onMonthChange = vi.fn();
    view = render(<Harness onMonthChange={onMonthChange} />);
    act(() => day("2026-10-31").focus());
    const event = keydown(day("2026-10-31"), "ArrowRight");
    expect(event.defaultPrevented).toBe(true);
    expect(onMonthChange).toHaveBeenCalledWith("2026-11");
    expect(document.querySelector('[role="grid"]')?.getAttribute("aria-label")).toBe("2026 年 11 月游玩日历");
    expect(document.activeElement).toBe(day("2026-11-01"));
    keydown(day("2026-11-01"), "PageUp");
    expect(onMonthChange).toHaveBeenLastCalledWith("2026-10");
    expect(document.activeElement).toBe(day("2026-10-01"));
  });

  it("到了可翻范围的边界就不再翻", () => {
    const onMonthChange = vi.fn();
    view = render(<Harness onMonthChange={onMonthChange} max="2026-10" />);
    act(() => day("2026-10-30").focus());
    keydown(day("2026-10-30"), "PageDown");
    keydown(day("2026-10-30"), "ArrowDown");
    expect(onMonthChange).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(day("2026-10-30"));
  });

  it("月份超出范围、范围颠倒、数据里有非法值都抛错", () => {
    const base = { minutes: new Map<string, number>(), today: "2026-10-30", selected: null, onSelect: () => undefined, onMonthChange: () => undefined };
    expect(() => render(<CalendarHeatmap {...base} month="2026-12" minMonth="2026-01" maxMonth="2026-10" />)).toThrow(/不在/);
    expect(() => render(<CalendarHeatmap {...base} month="2026-10" minMonth="2026-11" maxMonth="2026-10" />)).toThrow(/颠倒/);
    expect(() => render(<CalendarHeatmap {...base} minutes={new Map([["2026-10-01", -5]])} month="2026-10" minMonth="2026-01" maxMonth="2026-10" />)).toThrow(/非负/);
  });
});
