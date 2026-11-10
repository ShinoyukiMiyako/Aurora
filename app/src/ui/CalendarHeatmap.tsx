// 游玩日历：按月展示每日游玩时长，点某天查看当天详情。
// 月份翻页按钮放在所在卡片的 CardHeader 操作区；当日详情由页面用 Inset 放在旁边。
// 周一为首列。没有记录的日子（数据范围外、未来日期）不可选，但键盘仍能停在上面，方向键移动的节奏才可预期。
// 颜色之外，时长同时写进每格的可访问名称。
// 网格固定画 6 周，不足的周用空格补齐：翻月时日历高度不变，图例与所在卡片不跟着跳。
// 翻月与游玩数据到达时，日格整块淡入一次，翻月时还从所去月份的那一侧滑进来；日格本身不做颜色过渡，主题切换仍是一帧换完。

import { useAnimate, useReducedMotionConfig } from "framer-motion";
import { useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { formatPlaytime } from "../domain/format";
import { fade, springs, tabPanel, type PanelFrom } from "../lib/motion";
import { cx } from "../lib/util";
import styles from "./CalendarHeatmap.module.css";

/** 换月时日格的起点横移（px）：取横排标签换面板的来向起点，翻到后一个月为 1，前一个月为 -1。 */
function monthEnterX(dir: PanelFrom["dir"]): number {
  const hidden = tabPanel.hidden;
  const from: PanelFrom = { axis: "x", dir };
  const start = typeof hidden === "function" ? hidden(from, {}, {}) : hidden;
  if (typeof start === "string" || typeof start.x !== "number") throw new Error("横排标签面板的来向起点缺少 x");
  return start.x;
}

/** 一个月最多跨 6 周（首日在周日且有 31 天时恰好 6 周）。 */
export const CALENDAR_WEEKS = 6;

export type HeatLevel = 0 | 1 | 2 | 3 | 4;

/** 热力分档（分钟）：0 / 1-59 / 60-119 / 120-199 / 200 及以上。 */
export function heatLevel(minutes: number): HeatLevel {
  if (!Number.isFinite(minutes) || minutes < 0) throw new Error(`游玩分钟数必须是非负有限数，收到 ${minutes}`);
  if (minutes === 0) return 0;
  if (minutes < 60) return 1;
  if (minutes < 120) return 2;
  if (minutes < 200) return 3;
  return 4;
}

// ---------------------------------------------------------------- 日期键（本地日历日，不涉及时区换算）

const DATE_KEY = /^(\d{4})-(\d{2})-(\d{2})$/;
const MONTH_KEY = /^(\d{4})-(\d{2})$/;
const pad2 = (n: number) => String(n).padStart(2, "0");

interface Ymd {
  y: number;
  m: number;
  d: number;
}

export function daysInMonth(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

function parseMonth(key: string): { y: number; m: number } {
  const match = MONTH_KEY.exec(key);
  if (match === null) throw new Error(`月份必须是 YYYY-MM，收到 ${key}`);
  const y = Number(match[1]);
  const m = Number(match[2]);
  if (m < 1 || m > 12) throw new Error(`不存在的月份 ${key}`);
  return { y, m };
}

function parseDate(key: string): Ymd {
  const match = DATE_KEY.exec(key);
  if (match === null) throw new Error(`日期必须是 YYYY-MM-DD，收到 ${key}`);
  const y = Number(match[1]);
  const m = Number(match[2]);
  const d = Number(match[3]);
  if (m < 1 || m > 12 || d < 1 || d > daysInMonth(y, m)) throw new Error(`不存在的日期 ${key}`);
  return { y, m, d };
}

const dateKey = ({ y, m, d }: Ymd) => `${y}-${pad2(m)}-${pad2(d)}`;
const monthKey = (y: number, m: number) => `${y}-${pad2(m)}`;

function fromUtc(t: number): Ymd {
  const dt = new Date(t);
  return { y: dt.getUTCFullYear(), m: dt.getUTCMonth() + 1, d: dt.getUTCDate() };
}

export function monthOf(date: string): string {
  const { y, m } = parseDate(date);
  return monthKey(y, m);
}

export function addDays(date: string, n: number): string {
  const { y, m, d } = parseDate(date);
  return dateKey(fromUtc(Date.UTC(y, m - 1, d + n)));
}

export function addMonths(month: string, n: number): string {
  const { y, m } = parseMonth(month);
  const t = fromUtc(Date.UTC(y, m - 1 + n, 1));
  return monthKey(t.y, t.m);
}

/** 周一为 0。 */
export function weekdayIndex(date: string): number {
  const { y, m, d } = parseDate(date);
  return (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7;
}

/** 前后翻月保持同一天，目标月没有这一天时落到月末。 */
export function shiftMonthKeepDay(date: string, n: number): string {
  const { d } = parseDate(date);
  const target = parseMonth(addMonths(monthOf(date), n));
  return dateKey({ y: target.y, m: target.m, d: Math.min(d, daysInMonth(target.y, target.m)) });
}

const WEEK_HEAD = ["一", "二", "三", "四", "五", "六", "日"] as const;

/** 单格的可访问名称：「10月30日 周五，游玩 2 小时 15 分钟」。没有记录写「无记录」，今天另加「今天」。 */
export function calendarDayLabel(date: string, minutes: number | undefined, isToday: boolean): string {
  const { m, d } = parseDate(date);
  const play = minutes === undefined ? "无记录" : minutes === 0 ? "没有游玩" : `游玩 ${formatPlaytime(minutes)}`;
  return `${m}月${d}日 周${WEEK_HEAD[weekdayIndex(date)]}，${play}${isToday ? "，今天" : ""}`;
}

// ---------------------------------------------------------------- 组件

export interface CalendarHeatmapProps {
  /** 显示的月份，YYYY-MM。 */
  month: string;
  /** 每日游玩分钟，键为 YYYY-MM-DD；没有键的日子视为无记录。 */
  minutes: ReadonlyMap<string, number>;
  /** 今天，YYYY-MM-DD。 */
  today: string;
  selected: string | null;
  onSelect: (date: string) => void;
  /** 键盘越过月界或 PageUp / PageDown 时请求翻月；翻月按钮在 CardHeader 里，同样回到这里。 */
  onMonthChange: (month: string) => void;
  /** 可翻到的月份范围（含两端），YYYY-MM。 */
  minMonth: string;
  maxMonth: string;
  className?: string;
}

export function CalendarHeatmap({ month, minutes, today, selected, onSelect, onMonthChange, minMonth, maxMonth, className }: CalendarHeatmapProps) {
  const { y, m } = parseMonth(month);
  parseMonth(minMonth);
  parseMonth(maxMonth);
  if (minMonth > maxMonth) throw new Error(`日历范围颠倒：${minMonth} 晚于 ${maxMonth}`);
  if (month < minMonth || month > maxMonth) throw new Error(`日历月份 ${month} 不在 ${minMonth} 到 ${maxMonth} 之内`);
  for (const [key, value] of minutes) {
    parseDate(key);
    heatLevel(value);
  }

  const [focusDate, setFocusDate] = useState<string | null>(null);
  const pendingFocus = useRef<string | null>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const [weeksRef, animateWeeks] = useAnimate<HTMLDivElement>();

  useLayoutEffect(() => {
    const wanted = pendingFocus.current;
    const grid = gridRef.current;
    if (wanted === null || grid === null) return;
    const target = [...grid.querySelectorAll<HTMLButtonElement>("button[data-date]")].find((el) => el.dataset.date === wanted);
    if (target === undefined) return;
    pendingFocus.current = null;
    target.focus();
  });

  const total = daysInMonth(y, m);
  const first = dateKey({ y, m, d: 1 });
  const last = dateKey({ y, m, d: total });
  const lead = weekdayIndex(first);
  const inMonth = (k: string | null): k is string => k !== null && monthOf(k) === month;
  const preferred = [focusDate, selected, today].find(inMonth);
  const tabStop = preferred === undefined ? first : preferred;

  const moveTo = (next: string) => {
    const nextMonth = monthOf(next);
    if (nextMonth < minMonth || nextMonth > maxMonth) return;
    pendingFocus.current = next;
    setFocusDate(next);
    if (nextMonth !== month) onMonthChange(nextMonth);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!(event.target instanceof HTMLButtonElement)) return;
    const date = event.target.dataset.date;
    if (date === undefined) return;
    const weekday = weekdayIndex(date);
    let next: string;
    switch (event.key) {
      case "ArrowLeft":
        next = addDays(date, -1);
        break;
      case "ArrowRight":
        next = addDays(date, 1);
        break;
      case "ArrowUp":
        next = addDays(date, -7);
        break;
      case "ArrowDown":
        next = addDays(date, 7);
        break;
      // 本周首尾，但不越出当月：首周与末周的另一半属于相邻月份，这里没有格子
      case "Home": {
        const monday = addDays(date, -weekday);
        next = monday < first ? first : monday;
        break;
      }
      case "End": {
        const sunday = addDays(date, 6 - weekday);
        next = sunday > last ? last : sunday;
        break;
      }
      case "PageUp":
        next = shiftMonthKeepDay(date, -1);
        break;
      case "PageDown":
        next = shiftMonthKeepDay(date, 1);
        break;
      default:
        return;
    }
    event.preventDefault();
    moveTo(next);
  };

  const cells = Array.from({ length: CALENDAR_WEEKS * 7 }, (_, i) => {
    const day = i - lead + 1;
    return day >= 1 && day <= total ? dateKey({ y, m, d: day }) : null;
  });
  // 换了月份，或游玩数据从无到有（加载完成）：整块日格换一批，淡入一次。
  // 换月时还从所去月份的那一侧滑进来（往后翻从右侧，往前翻从左侧），与横排标签换面板同一组参数；减少动画时只淡入
  const batch = `${month}:${minutes.size > 0 ? "data" : "empty"}`;
  const reduced = useReducedMotionConfig() === true;
  // 挂载时的那一批跟着所在页面的入场走，不另外淡入
  const shownBatch = useRef({ batch, month });
  useLayoutEffect(() => {
    const shown = shownBatch.current;
    if (shown.batch === batch) return;
    shownBatch.current = { batch, month };
    // 同一个网格原地换内容，不靠换 key 重挂：重挂会把停在日格上的键盘焦点丢到 body。起点先在提交时写上，
    // 首帧就看不到新内容在原位一闪
    const weeks = weeksRef.current;
    const x = shown.month === month || reduced ? null : monthEnterX(month > shown.month ? 1 : -1);
    weeks.style.opacity = "0";
    if (x === null) {
      void animateWeeks(weeks, { opacity: [0, 1] }, fade.in);
      return;
    }
    weeks.style.transform = `translateX(${x}px)`;
    void animateWeeks(weeks, { opacity: [0, 1], x: [x, 0] }, { ...springs.settle, opacity: fade.in });
  }, [batch, month, reduced, weeksRef, animateWeeks]);

  return (
    <div className={cx(styles.calendar, className)}>
      <div ref={gridRef} className={styles.grid} role="grid" aria-label={`${y} 年 ${m} 月游玩日历`} onKeyDown={onKeyDown}>
        <div className={styles.row} role="row">
          {WEEK_HEAD.map((w) => (
            <div key={w} className={styles.head} role="columnheader" aria-label={`星期${w}`}>
              {w}
            </div>
          ))}
        </div>
        <div ref={weeksRef} className={styles.weeks} role="rowgroup">
          {Array.from({ length: CALENDAR_WEEKS }, (_, w) => (
            <div key={w} className={styles.row} role="row">
              {cells.slice(w * 7, w * 7 + 7).map((date, c) =>
                date === null ? (
                  <div key={c} className={styles.blank} role="gridcell" />
                ) : (
                  <DayCell
                    key={date}
                    date={date}
                    minutes={minutes.get(date)}
                    isToday={date === today}
                    isSelected={date === selected}
                    tabbable={date === tabStop}
                    onPick={() => {
                      setFocusDate(date);
                      onSelect(date);
                    }}
                  />
                ),
              )}
            </div>
          ))}
        </div>
      </div>
      <div className={styles.legend}>
        <span>少</span>
        {([0, 1, 2, 3, 4] as const).map((level) => (
          <span key={level} className={styles.swatch} data-level={level} aria-hidden="true" />
        ))}
        <span>多</span>
      </div>
    </div>
  );
}

interface DayCellProps {
  date: string;
  minutes: number | undefined;
  isToday: boolean;
  isSelected: boolean;
  tabbable: boolean;
  onPick: () => void;
}

function DayCell({ date, minutes, isToday, isSelected, tabbable, onPick }: DayCellProps) {
  const recorded = minutes !== undefined;
  return (
    <div className={styles.cell} role="gridcell" aria-selected={isSelected}>
      <button
        type="button"
        className={styles.day}
        data-date={date}
        data-level={recorded ? heatLevel(minutes) : "none"}
        data-today={isToday || undefined}
        data-selected={isSelected || undefined}
        aria-label={calendarDayLabel(date, minutes, isToday)}
        aria-disabled={recorded ? undefined : true}
        aria-current={isToday ? "date" : undefined}
        tabIndex={tabbable ? 0 : -1}
        onClick={() => {
          if (recorded) onPick();
        }}
      >
        {parseDate(date).d}
      </button>
    </div>
  );
}
